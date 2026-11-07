import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
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

function invokeEntry(entry: string, args: string[], tokenValue = token, node = true, envOverrides: NodeJS.ProcessEnv = {}, preload?: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(node ? process.execPath : entry, node ? [...(preload ? ['--import', preload] : []), entry, ...args] : args, {
      env: { ...process.env, ...envOverrides, GHATANA_MEDIA_BEARER_TOKEN: tokenValue },
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

const invoke = (args: string[], tokenValue = token, envOverrides: NodeJS.ProcessEnv = {}, preload?: string) => invokeEntry(bin, args, tokenValue, true, envOverrides, preload);
const fetchFixture = fileURLToPath(new URL('./__fixtures__/cli-fetch.mjs', import.meta.url));

function command(endpoint: string, extra: string[] = []) {
  return ['artifact', 'inspect', '--endpoint', endpoint, '--tenant', 'tenant-a', '--principal', 'principal-a', '--artifact', 'artifact-a', ...extra];
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

describe('ghatanamedia-api artifact inspect executable', () => {
  it('denies artifact inspection without bearer authentication before endpoint dispatch', async () => {
    const result = await invoke(command('https://media.example.test'), '');

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(`${JSON.stringify({
      schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.artifact.inspect',
      code: 'MISSING_AUTH_TOKEN',
      message: 'Set GHATANA_MEDIA_BEARER_TOKEN in the environment; credentials are never accepted as command arguments.',
    })}\n`);
    expect(result.stdout + result.stderr).not.toContain(token);
  });

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
      const expected = {
        schemaVersion: 'media.cli-result.v1', commandId: 'media.cli.artifact.inspect', artifact,
      };
      expect(result.stdout).toBe(`${JSON.stringify(expected)}\n`);
      expect(JSON.parse(result.stdout)).toEqual(expected);
      expect(result.stdout).not.toContain(token);
      expect(requests).toBe(1);
      } finally {
        await rm(linkRoot, { recursive: true, force: true });
      }
    });
  });

  it('serializes semantically equal nested metadata with identical canonical JSON bytes', async () => {
    let requests = 0;
    await withServer((_request, response) => {
      requests++;
      const metadata = requests === 1
        ? { z: 1, a: { y: 2, b: 3 }, list: [{ z: 4, a: 5 }] }
        : { list: [{ a: 5, z: 4 }], a: { b: 3, y: 2 }, z: 1 };
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...artifact, metadata }));
    }, async endpoint => {
      const first = await invoke(command(endpoint));
      const second = await invoke(command(endpoint));
      expect(first.status).toBe(0);
      expect(second.status).toBe(0);
      expect(first.stderr).toBe('');
      expect(second.stderr).toBe('');
      expect(first.stdout).toBe(second.stdout);
      const expected = {
        schemaVersion: 'media.cli-result.v1', commandId: 'media.cli.artifact.inspect',
        artifact: {
          ...artifact,
          metadata: { a: { b: 3, y: 2 }, list: [{ a: 5, z: 4 }], z: 1 },
        },
      };
      expect(first.stdout).toBe(`${JSON.stringify(expected)}\n`);
      expect(JSON.parse(first.stdout)).toEqual(expected);
      expect(first.stdout).not.toContain(token);
      expect(requests).toBe(2);
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

  it('keeps the CLI and SDK fail-closed on the same malformed artifact response', async () => {
    let requests = 0;
    await withServer((request, response) => {
      requests++;
      expect(request.method).toBe('GET');
      expect(request.url).toBe('/api/v1/artifacts/artifact-a');
      expect(request.headers['x-tenant-id']).toBe('tenant-a');
      expect(request.headers['x-principal-id']).toBe('principal-a');
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      response.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ...artifact, sizeBytes: '42' }));
    }, async endpoint => {
      const sdk = createMediaOperationClient({
        baseUrl: endpoint,
        tenantId: 'tenant-a',
        defaultHeaders: { 'X-Principal-Id': 'principal-a' },
        getAccessToken: () => token,
      });
      const sdkFailure = await sdk.getArtifact('artifact-a').then(
        () => { throw new Error('unreachable'); },
        (error: unknown) => error,
      );
      expect(sdkFailure).toBeInstanceOf(TypeError);
      expect((sdkFailure as Error).message)
        .toBe('Canonical Media artifact sizeBytes must be a positive safe integer.');
      expect((sdkFailure as Error).message).not.toContain(token);

      const cliResult = await invoke(command(endpoint));
      expect(cliResult.status).toBe(1);
      expect(cliResult.stdout).toBe('');
      expect(JSON.parse(cliResult.stderr)).toMatchObject({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.artifact.inspect',
        code: 'INVALID_MEDIA_RESPONSE',
      });
      expect(cliResult.stderr).not.toContain(token);
      expect(requests).toBe(2);
    });
  });

  it('rejects credential material echoed in an otherwise valid artifact without printing it', async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        ...artifact, metadata: { purpose: `provider echoed ${token}` },
      }));
    }, async endpoint => {
      const result = await invoke(command(endpoint));
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toEqual({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.artifact.inspect',
        code: 'INVALID_MEDIA_RESPONSE', message: 'Media returned an artifact response containing credential material.',
      });
      expect(result.stderr).not.toContain(token);
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

  it('returns an exact nonzero typed result for a forbidden authenticated operation', async () => {
    let requests = 0;
    await withServer((request, response) => {
      requests++;
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'denied' } }));
    }, async endpoint => {
      const result = await invoke(command(endpoint));
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.artifact.inspect',
        code: 'MEDIA_REQUEST_FAILED', statusCode: 403,
      });
      expect(result.stderr).not.toContain(token);
      expect(requests).toBe(1);
    });
  });

  it('describes a forbidden job status read as a missing job observation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-job-error-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    try {
      const result = await invoke(
        jobCommand('https://media.example.test', 'status', ['--job', 'job-1']), token,
        {
          GHATANA_MEDIA_CLI_TEST_FETCH_MODE: 'forbidden',
          GHATANA_MEDIA_CLI_TEST_JOB: JSON.stringify(job),
          GHATANA_MEDIA_CLI_TEST_LOG: requestLogPath,
          GHATANA_MEDIA_CLI_TEST_EXPECT_BEARER: token,
        }, fetchFixture,
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toEqual({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.job.status',
        code: 'MEDIA_REQUEST_FAILED',
        message: 'Media did not return the requested job observation; success is not inferred.',
        statusCode: 403,
      });
      expect(result.stderr).not.toContain(token);
      const requests = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(requests).toEqual([{
        path: '/api/v1/jobs/job-1', method: 'GET', tenant: 'tenant-a', principal: 'principal-a',
        requestId: expect.any(String), idempotencyKey: null, authenticated: true, bearerMatches: true,
      }]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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

  it('omits a whitespace-padded correlation identifier instead of changing its identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-correlation-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    try {
      const result = await invoke(command('https://media.example.test'), token, {
        GHATANA_MEDIA_CLI_TEST_FETCH_MODE: 'artifact-not-found',
        GHATANA_MEDIA_CLI_TEST_CORRELATION_ID: ' corr-not-found ',
        GHATANA_MEDIA_CLI_TEST_LOG: requestLogPath,
      }, fetchFixture);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      const output = JSON.parse(result.stderr);
      expect(output.code).toBe('ARTIFACT_NOT_FOUND');
      expect(output).not.toHaveProperty('correlationId');
      expect(result.stdout + result.stderr).not.toContain(token);
      const requests = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(requests).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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

  it.each([
    ['upload', 'inspect', '--upload', 'u1'],
    ['upload', 'resume', '--upload', 'u1'],
    ['transcribe', '--source-version', 'v1', '--language', 'en'],
    ['transcript', 'review', '--transcript-version', 'v1'],
    ['job', 'status', '--job', 'j1'],
    ['job', 'cancel', '--job', 'j1'],
    ['job', 'check-outcome', '--job', 'j1'],
    ['caption', 'correct-text', '--artifact-version', 'v1', '--segment', 's1', '--text', 'text'],
    ['caption', 'align-timing', '--artifact-version', 'v1', '--segment', 's1', '--start-tick', '0', '--end-tick', '1'],
    ['caption', 'save-version', '--draft-version', 'v1', '--purpose', 'review'],
    ['caption', 'compare-versions', '--left-version', 'v1', '--right-version', 'v2'],
    ['demo', 'run'],
  ])('never exposes the unregistered fixture command %s as real', async (...commandArgs) => {
    const result = await invoke(commandArgs);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr).code).toBe('INVALID_INVOCATION');
    expect(result.stderr).not.toContain(token);
    expect(result.stdout).toBe('');
  });

  it('rejects human and scenario output modes instead of changing the registered JSON contract', async () => {
    const human = await invoke(command('http://127.0.0.1:1', ['--format', 'human']));
    const scenario = await invoke(command('http://127.0.0.1:1', ['--scenario', 'fixture-a']));
    for (const result of [human, scenario]) {
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stderr).code).toBe('INVALID_INVOCATION');
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toContain(token);
    }
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

describe('ghatanamedia-api production command boundary', () => {
  it.each([
    ['job', 'status', '--job', 'job-1'],
    ['job', 'cancel', '--job', 'job-1'],
    ['job', 'submit', '--request-id', 'r1'],
    ['capture', 'start'],
    ['recorder', 'start'],
  ])('rejects unregistered command %s before transport dispatch', async (...commandArgs) => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-unregistered-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    try {
      const result = await invoke([...commandArgs, '--endpoint', 'https://media.example.test', '--tenant', 'tenant-a', '--principal', 'principal-a'], token, {
        GHATANA_MEDIA_CLI_TEST_FETCH_MODE: 'success',
        GHATANA_MEDIA_CLI_TEST_LOG: requestLogPath,
      }, fetchFixture);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.invocation', code: 'INVALID_INVOCATION',
      });
      expect(result.stderr).not.toContain(token);
      await expect(readFile(requestLogPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
