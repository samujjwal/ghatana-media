import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const token = 'test-secret-do-not-print';
const timestamp = '2026-10-08T12:00:00.000Z';
const artifact = {
  tenantId: 'tenant-a', principalId: 'principal-a', artifactId: 'artifact-a', fileName: 'clip.wav',
  contentType: 'audio/wav', sizeBytes: 42, sha256: 'a'.repeat(64), objectReference: 'opaque://stored/object',
  classification: 'INTERNAL', createdAt: timestamp, expiresAt: '2026-11-08T12:00:00.000Z', metadata: { purpose: 'inspect' },
};
const servers: Server[] = [];

async function withServer(
  respond: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void,
  run: (endpoint: string) => Promise<void>,
): Promise<void> {
  const server = createServer(respond);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind');
  await run(`http://127.0.0.1:${address.port}`);
}

function invokeEntry(entry: string, args: string[], tokenValue = token, node = true): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(node ? process.execPath : entry, node ? [entry, ...args] : args, {
      env: { ...process.env, GHATANA_MEDIA_BEARER_TOKEN: tokenValue },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => {
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
  });
}

const invoke = (args: string[], tokenValue = token) => invokeEntry(bin, args, tokenValue);

function command(endpoint: string, extra: string[] = []) {
  return ['artifact', 'inspect', '--endpoint', endpoint, '--tenant', 'tenant-a', '--principal', 'principal-a', '--artifact', 'artifact-a', ...extra];
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe('ghatanamedia-api artifact inspect executable', () => {
  it('executes an installed-style linked bin target through the SDK as a scoped read', async () => {
    let requests = 0;
    await withServer((request, response) => {
      requests++;
      expect(request.method).toBe('GET');
      expect(request.url).toBe('/api/v1/artifacts/artifact-a');
      expect(request.headers['x-tenant-id']).toBe('tenant-a');
      expect(request.headers['x-principal-id']).toBe('principal-a');
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      expect(request.headers.accept).toBe('application/json');
      expect(request.headers['content-length']).toBeUndefined();
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(artifact));
    }, async endpoint => {
      const linkRoot = await mkdtemp(join(tmpdir(), 'media-cli-bin-'));
      const linkedBin = join(linkRoot, 'node_modules', '.bin', 'ghatanamedia-api');
      await mkdir(dirname(linkedBin), { recursive: true });
      await symlink(bin, linkedBin);
      try {
      const result = await invokeEntry(linkedBin, command(endpoint), token, false);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({
        schemaVersion: 'media.cli-result.v1', commandId: 'media.cli.artifact.inspect', artifact,
      });
      expect(result.stdout).not.toContain(token);
      expect(requests).toBe(1);
      } finally {
        await rm(linkRoot, { recursive: true, force: true });
      }
    });
  });

  it.each([
    ['tenant', { tenantId: 'tenant-b' }],
    ['principal', { principalId: 'principal-b' }],
    ['artifact identity', { artifactId: 'artifact-b' }],
  ])('fails closed when the returned %s differs from the requested identity', async (_label, override) => {
    let requests = 0;
    await withServer((_request, response) => {
      requests++;
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...artifact, ...override }));
    }, async endpoint => {
      const result = await invoke(command(endpoint));
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.artifact.inspect', code: 'INVALID_MEDIA_RESPONSE',
      });
      expect(result.stderr).not.toContain(token);
      expect(requests).toBe(1);
    });
  });

  it.each([
    ['malformed DTO', { ...artifact, sizeBytes: '42' }],
    ['unknown DTO field', { ...artifact, rightsCleared: true }],
  ])('rejects a %s without printing response data', async (_label, body) => {
    await withServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    }, async endpoint => {
      const result = await invoke(command(endpoint));
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stderr).code).toBe('INVALID_MEDIA_RESPONSE');
      expect(result.stderr).not.toContain('rightsCleared');
      expect(result.stdout).toBe('');
    });
  });

  it('preserves a scope-safe 404 and safe correlation without claiming global absence', async () => {
    await withServer((_request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({
        error: { code: 'ARTIFACT_NOT_FOUND', message: token, retryable: false },
        meta: { correlationId: 'corr-not-found' },
      }));
    }, async endpoint => {
      const result = await invoke(command(endpoint));
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toEqual({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.artifact.inspect',
        code: 'ARTIFACT_NOT_FOUND', message: 'Artifact was not visible in the requested tenant and principal scope.',
        statusCode: 404, correlationId: 'corr-not-found',
      });
      expect(result.stderr).not.toContain(token);
    });
  });

  it('omits a correlation identifier that contains the bearer credential', async () => {
    await withServer((_request, response) => {
      response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({
        error: { code: 'ARTIFACT_NOT_FOUND', message: 'not visible', retryable: false },
        meta: { correlationId: `corr-${token}-echo` },
      }));
    }, async endpoint => {
      const result = await invoke(command(endpoint));
      expect(result.status).toBe(1);
      const output = JSON.parse(result.stderr);
      expect(output.code).toBe('ARTIFACT_NOT_FOUND');
      expect(output).not.toHaveProperty('correlationId');
      expect(result.stdout + result.stderr).not.toContain(token);
    });
  });

  it('rejects missing/unknown arguments, missing token, and untrusted HTTP endpoints before dispatch', async () => {
    let requests = 0;
    await withServer((_request, response) => {
      requests++;
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(artifact));
    }, async endpoint => {
      const missing = await invoke(['artifact', 'inspect', '--endpoint', endpoint]);
      expect(missing.status).toBe(2);
      expect(JSON.parse(missing.stderr).code).toBe('INVALID_INVOCATION');
      const unknown = await invoke(command(endpoint, ['--token', token]));
      expect(unknown.status).toBe(2);
      expect(JSON.parse(unknown.stderr).code).toBe('INVALID_INVOCATION');
      const noToken = await invoke(command(endpoint), '');
      expect(noToken.status).toBe(2);
      expect(JSON.parse(noToken.stderr).code).toBe('MISSING_AUTH_TOKEN');
      const remoteHttp = await invoke(command(endpoint.replace('http://127.0.0.1', 'http://media.example.test')));
      expect(remoteHttp.status).toBe(2);
      expect(JSON.parse(remoteHttp.stderr).code).toBe('INVALID_ENDPOINT');
      expect(requests).toBe(0);
      for (const result of [missing, unknown, noToken, remoteHttp]) expect(result.stderr).not.toContain(token);
    });
  });

  it('does not follow a redirect with the bearer credential attached', async () => {
    let redirectedRequests = 0;
    const destination = createServer((_request, response) => {
      redirectedRequests++;
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(artifact));
    });
    servers.push(destination);
    await new Promise<void>(resolve => destination.listen(0, '127.0.0.1', resolve));
    const address = destination.address();
    if (!address || typeof address === 'string') throw new Error('Fixture destination did not bind');
    await withServer((_request, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${address.port}/steal` }).end();
    }, async endpoint => {
      const result = await invoke(command(endpoint));
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stderr).code).toBe('OBSERVATION_UNAVAILABLE');
      expect(redirectedRequests).toBe(0);
      expect(result.stdout + result.stderr).not.toContain(token);
    });
  });
});
