import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMediaOperationClient } from './operations.js';

const bin = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const token = 'test-secret-do-not-print';
const timestamp = '2026-10-08T12:00:00.000Z';
const artifact = {
  tenantId: 'tenant-a', principalId: 'principal-a', artifactId: 'artifact-a', fileName: 'clip.wav',
  contentType: 'audio/wav', sizeBytes: 42, sha256: 'a'.repeat(64), objectReference: 'opaque://stored/object',
  classification: 'INTERNAL', createdAt: timestamp, expiresAt: '2026-11-08T12:00:00.000Z', metadata: { purpose: 'inspect' },
};
const job = {
  jobId: 'job-a', requestId: 'request-a', tenantId: 'tenant-a', principalId: 'principal-a', artifactId: 'artifact-a',
  jobType: 'SPEECH_TO_TEXT', providerId: 'whisper-local', status: 'RUNNING', createdAt: timestamp,
  startedAt: timestamp, completedAt: null, result: { z: 1, nested: { y: 2, a: 3 } }, failureCode: null,
  version: 2, expectedArtifactVersion: '', requestFingerprint: `sha256:${'b'.repeat(64)}`,
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

function jobStatusCommand(endpoint: string, extra: string[] = []) {
  return ['job', 'status', '--endpoint', endpoint, '--tenant', 'tenant-a', '--principal', 'principal-a', '--job', 'job-a', ...extra];
}

function jobCancelCommand(endpoint: string, extra: string[] = []) {
  return ['job', 'cancel', '--endpoint', endpoint, '--tenant', 'tenant-a', '--principal', 'principal-a', '--job', 'job-a', ...extra];
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

  it('rejects a case-varied credential echoed as a response field name', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-case-varied-credential-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    const responseArtifact = {
      ...artifact, metadata: { [token.toUpperCase()]: 'provider echoed a credential in a field name' },
    };
    try {
      const result = await invoke(command('https://media.example.test'), token, {
        GHATANA_MEDIA_CLI_TEST_FETCH_MODE: 'artifact-success',
        GHATANA_MEDIA_CLI_TEST_ARTIFACT: JSON.stringify(responseArtifact),
        GHATANA_MEDIA_CLI_TEST_EXPECT_BEARER: token,
        GHATANA_MEDIA_CLI_TEST_LOG: requestLogPath,
      }, fetchFixture);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.artifact.inspect', code: 'INVALID_MEDIA_RESPONSE',
      });
      expect(result.stdout + result.stderr).not.toContain(token);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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

  it('rejects artifact IDs outside the PDP-1 opaque-ID grammar before SDK or fetch dispatch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-artifact-id-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    const base = ['artifact', 'inspect', '--endpoint', 'https://media.example.test',
      '--tenant', 'tenant-a', '--principal', 'principal-a'];
    try {
      for (const artifactId of ['artifact?query', '-artifact', `a${'x'.repeat(128)}`]) {
        const result = await invoke([
          ...base, '--artifact', artifactId,
        ], token, {
          GHATANA_MEDIA_CLI_TEST_FETCH_MODE: 'artifact-not-found',
          GHATANA_MEDIA_CLI_TEST_LOG: requestLogPath,
        }, fetchFixture);
        expect(result.status).toBe(2);
        expect(result.stdout).toBe('');
        expect(JSON.parse(result.stderr)).toMatchObject({
          schemaVersion: 'media.cli-error.v1',
          commandId: 'media.cli.artifact.inspect',
          code: 'INVALID_INVOCATION',
        });
        expect(result.stderr).not.toContain(token);
      }
      await expect(readFile(requestLogPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects tenant and principal values outside the PDP-1 opaque-ID grammar before fetch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-scope-id-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    try {
      const invalidScopes = [
        ['-tenant', 'principal-a'],
        ['tenant with spaces', 'principal-a'],
        ['t'.repeat(129), 'principal-a'],
        ['tenant-a', '_principal'],
        ['tenant-a', 'principal/slash'],
        ['tenant-a', 'p'.repeat(129)],
      ];
      for (const [tenant, principal] of invalidScopes) {
        const result = await invoke([
          'artifact', 'inspect', '--endpoint', 'https://media.example.test',
          '--tenant', tenant, '--principal', principal, '--artifact', 'artifact-a',
        ], token, {
          GHATANA_MEDIA_CLI_TEST_FETCH_MODE: 'artifact-success',
          GHATANA_MEDIA_CLI_TEST_LOG: requestLogPath,
        }, fetchFixture);
        expect(result.status).toBe(2);
        expect(result.stdout).toBe('');
        expect(JSON.parse(result.stderr)).toMatchObject({
          schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.artifact.inspect',
          code: 'INVALID_INVOCATION',
        });
        expect(result.stderr).not.toContain(token);
      }
      await expect(readFile(requestLogPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects an endpoint over the shared 8,192-character normalized URL ceiling before fetch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-endpoint-size-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    const oversizedEndpoint = `https://media.example.test/${'a'.repeat(8_200)}`;
    try {
      const result = await invoke(command(oversizedEndpoint), token, {
        GHATANA_MEDIA_CLI_TEST_FETCH_MODE: 'artifact-success',
        GHATANA_MEDIA_CLI_TEST_LOG: requestLogPath,
      }, fetchFixture);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.artifact.inspect',
        code: 'INVALID_ENDPOINT',
      });
      expect(result.stderr).not.toContain(token);
      await expect(readFile(requestLogPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects original literal and encoded endpoint path traversal before URL normalization and fetch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-endpoint-traversal-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    try {
      for (const endpoint of [
        'https://media.example.test/safe/../admin',
        'https://media.example.test/safe/%2e%2e/admin',
        'https://media.example.test/safe/%2e%2e%2fadmin',
      ]) {
        const result = await invoke(command(endpoint), token, {
          GHATANA_MEDIA_CLI_TEST_FETCH_MODE: 'artifact-success',
          GHATANA_MEDIA_CLI_TEST_ARTIFACT: JSON.stringify(artifact),
          GHATANA_MEDIA_CLI_TEST_EXPECT_BEARER: token,
          GHATANA_MEDIA_CLI_TEST_LOG: requestLogPath,
        }, fetchFixture);
        expect(result.status).toBe(2);
        expect(result.stdout).toBe('');
        expect(JSON.parse(result.stderr)).toMatchObject({
          schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.artifact.inspect', code: 'INVALID_ENDPOINT',
        });
        expect(result.stdout + result.stderr).not.toContain(token);
      }
      await expect(readFile(requestLogPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { command: 'upload inspect', args: ['upload', 'inspect', '--upload', 'u1'] },
    { command: 'upload resume', args: ['upload', 'resume', '--upload', 'u1'] },
    { command: 'transcribe', args: ['transcribe', '--source-version', 'v1', '--language', 'en'] },
    { command: 'transcript review', args: ['transcript', 'review', '--transcript-version', 'v1'] },
    { command: 'job check-outcome', args: ['job', 'check-outcome', '--job', 'j1'] },
    { command: 'job batch', args: ['job', 'batch'] },
    { command: 'caption correct-text', args: ['caption', 'correct-text', '--artifact-version', 'v1', '--segment', 's1', '--text', 'text'] },
    { command: 'caption align-timing', args: ['caption', 'align-timing', '--artifact-version', 'v1', '--segment', 's1', '--start-tick', '0', '--end-tick', '1'] },
    { command: 'caption save-version', args: ['caption', 'save-version', '--draft-version', 'v1', '--purpose', 'review'] },
    { command: 'caption compare-versions', args: ['caption', 'compare-versions', '--left-version', 'v1', '--right-version', 'v2'] },
    { command: 'demo run', args: ['demo', 'run'] },
  ])('never exposes the unregistered fixture command $command as real', async ({ args }) => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-unregistered-command-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    try {
      const result = await invoke(args, token, {
        GHATANA_MEDIA_CLI_TEST_FETCH_MODE: 'artifact-success',
        GHATANA_MEDIA_CLI_TEST_ARTIFACT: JSON.stringify(artifact),
        GHATANA_MEDIA_CLI_TEST_EXPECT_BEARER: token,
        GHATANA_MEDIA_CLI_TEST_LOG: requestLogPath,
      }, fetchFixture);
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stderr).code).toBe('INVALID_INVOCATION');
      expect(result.stderr).not.toContain(token);
      expect(result.stdout).toBe('');
      await expect(readFile(requestLogPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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

describe('ghatanamedia-api job status executable', () => {
  it('reads an exact authenticated job observation through the canonical scoped route', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-job-status-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    try {
      const result = await invoke(jobStatusCommand('https://media.example.test'), token, {
        GHATANA_MEDIA_CLI_TEST_FETCH_MODE: 'success',
        GHATANA_MEDIA_CLI_TEST_JOB: JSON.stringify(job),
        GHATANA_MEDIA_CLI_TEST_EXPECT_BEARER: token,
        GHATANA_MEDIA_CLI_TEST_LOG: requestLogPath,
      }, fetchFixture);
      const expected = {
        schemaVersion: 'media.cli-result.v1', commandId: 'media.cli.job.status',
        job: { ...job, result: { nested: { a: 3, y: 2 }, z: 1 } },
      };
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toBe(`${JSON.stringify(expected)}\n`);
      expect(result.stdout).not.toContain(token);
      expect(JSON.parse(await readFile(requestLogPath, 'utf8'))).toMatchObject({
        path: '/api/v1/jobs/job-a', method: 'GET', tenant: 'tenant-a', principal: 'principal-a',
        authenticated: true, bearerMatches: true,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps job status scoped and rejects malformed or mismatched responses without printing them', async () => {
    for (const body of [
      { ...job, tenantId: 'tenant-b' },
      { ...job, principalId: 'principal-b' },
      { ...job, jobId: 'job-b' },
      { ...job, status: 'DONE' },
    ]) {
      const result = await invoke(jobStatusCommand('https://media.example.test'), token, {
        GHATANA_MEDIA_CLI_TEST_FETCH_MODE: 'success',
        GHATANA_MEDIA_CLI_TEST_JOB: JSON.stringify(body),
        GHATANA_MEDIA_CLI_TEST_EXPECT_BEARER: token,
      }, fetchFixture);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.job.status', code: 'INVALID_MEDIA_RESPONSE',
      });
      expect(result.stderr).not.toContain(token);
      expect(result.stderr).not.toContain('tenant-b');
    }
  });

  it('requires environment bearer auth and rejects invalid job IDs before dispatch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-job-id-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    try {
      const noToken = await invoke(jobStatusCommand('https://media.example.test'), '');
      const invalidId = await invoke([
        'job', 'status', '--endpoint', 'https://media.example.test', '--tenant', 'tenant-a',
        '--principal', 'principal-a', '--job', '-job',
      ], token, {
        GHATANA_MEDIA_CLI_TEST_FETCH_MODE: 'artifact-success',
        GHATANA_MEDIA_CLI_TEST_LOG: requestLogPath,
      }, fetchFixture);
      expect(noToken.status).toBe(2);
      expect(JSON.parse(noToken.stderr)).toMatchObject({ commandId: 'media.cli.job.status', code: 'MISSING_AUTH_TOKEN' });
      expect(invalidId.status).toBe(2);
      expect(JSON.parse(invalidId.stderr)).toMatchObject({ commandId: 'media.cli.job.status', code: 'INVALID_INVOCATION' });
      expect(noToken.stdout + noToken.stderr + invalidId.stdout + invalidId.stderr).not.toContain(token);
      await expect(readFile(requestLogPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('maps the exact scoped missing-job error without exposing server detail', async () => {
    const result = await invoke(jobStatusCommand('https://media.example.test'), token, {
      GHATANA_MEDIA_CLI_TEST_FETCH_MODE: 'job-not-found',
      GHATANA_MEDIA_CLI_TEST_EXPECT_BEARER: token,
    }, fetchFixture);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.job.status',
      code: 'JOB_NOT_FOUND', statusCode: 404, correlationId: 'corr-job-404',
    });
    expect(result.stderr).not.toContain('private backend detail');
    expect(result.stderr).not.toContain(token);
  });
});

describe('ghatanamedia-api job cancel executable', () => {
  it.each(['RUNNING', 'CANCELLED'] as const)('returns the canonical %s observation without inferring cancellation', async status => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-job-cancel-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    try {
      const responseJob = { ...job, status };
      const result = await invoke(jobCancelCommand('https://media.example.test'), token, {
        GHATANA_MEDIA_CLI_TEST_FETCH_MODE: 'success',
        GHATANA_MEDIA_CLI_TEST_JOB: JSON.stringify(responseJob),
        GHATANA_MEDIA_CLI_TEST_EXPECT_BEARER: token,
        GHATANA_MEDIA_CLI_TEST_LOG: requestLogPath,
      }, fetchFixture);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 'media.cli-result.v1', commandId: 'media.cli.job.cancel', job: { ...job, status },
      });
      expect(JSON.parse(result.stdout).job.status).toBe(status);
      expect(result.stdout).not.toContain(token);
      expect(JSON.parse(await readFile(requestLogPath, 'utf8'))).toMatchObject({
        path: '/api/v1/jobs/job-a/cancel', method: 'POST', tenant: 'tenant-a', principal: 'principal-a',
        authenticated: true, bearerMatches: true, idempotencyKey: null,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects malformed job IDs before cancellation dispatch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-job-cancel-id-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    try {
      const result = await invoke([
        'job', 'cancel', '--endpoint', 'https://media.example.test', '--tenant', 'tenant-a',
        '--principal', 'principal-a', '--job', '../job-a',
      ], token, {
        GHATANA_MEDIA_CLI_TEST_FETCH_MODE: 'timeout',
        GHATANA_MEDIA_CLI_TEST_LOG: requestLogPath,
      }, fetchFixture);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.job.cancel', code: 'INVALID_INVOCATION',
      });
      expect(result.stderr).not.toContain(token);
      await expect(readFile(requestLogPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reports a lost post-dispatch acknowledgement as OUTCOME_UNKNOWN and never retries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-job-cancel-unknown-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    try {
      const result = await invoke(jobCancelCommand('https://media.example.test'), token, {
        GHATANA_MEDIA_REQUEST_TIMEOUT_MS: '1',
        GHATANA_MEDIA_CLI_TEST_FETCH_MODE: 'timeout',
        GHATANA_MEDIA_CLI_TEST_EXPECT_BEARER: token,
        GHATANA_MEDIA_CLI_TEST_LOG: requestLogPath,
      }, fetchFixture);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.job.cancel',
        code: 'OUTCOME_UNKNOWN', path: '/api/v1/jobs/job-a/cancel',
      });
      expect(JSON.parse(result.stderr).requestId).toMatch(/^[A-Za-z0-9._:-]{1,128}$/u);
      expect(result.stderr).toContain('Do not retry');
      expect(result.stderr).not.toContain(token);
      const requests = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        path: '/api/v1/jobs/job-a/cancel', method: 'POST', tenant: 'tenant-a', principal: 'principal-a',
        authenticated: true, bearerMatches: true,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('ghatanamedia-api production command boundary', () => {
  it('rejects bearer-token-shaped artifact metadata before serializing the response', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-bearer-field-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    const responseArtifact = {
      ...artifact,
      metadata: { nested: { Bearer_Token: 'provider-credential-do-not-print' } },
    };
    try {
      const result = await invoke(command('https://media.example.test'), token, {
        GHATANA_MEDIA_CLI_TEST_FETCH_MODE: 'artifact-success',
        GHATANA_MEDIA_CLI_TEST_ARTIFACT: JSON.stringify(responseArtifact),
        GHATANA_MEDIA_CLI_TEST_EXPECT_BEARER: token,
        GHATANA_MEDIA_CLI_TEST_LOG: requestLogPath,
      }, fetchFixture);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toEqual({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.artifact.inspect',
        code: 'INVALID_MEDIA_RESPONSE', message: 'Media returned an artifact response containing credential material.',
      });
      expect(result.stderr).not.toContain('provider-credential-do-not-print');
      const requests = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ method: 'GET', path: '/api/v1/artifacts/artifact-a', authenticated: true, bearerMatches: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps the registered artifact read truthful across source-free process boundaries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-source-free-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    const testArtifact = { ...artifact, metadata: { purpose: 'source-free' } };
    const environment = (mode: string) => ({
      GHATANA_MEDIA_CLI_TEST_FETCH_MODE: mode,
      GHATANA_MEDIA_CLI_TEST_EXPECT_BEARER: token,
      GHATANA_MEDIA_CLI_TEST_ARTIFACT: JSON.stringify(testArtifact),
      GHATANA_MEDIA_CLI_TEST_LOG: requestLogPath,
    });
    try {
      const success = await invoke(command('https://media.example.test'), token, environment('artifact-success'), fetchFixture);
      expect(success.status).toBe(0);
      expect(success.stderr).toBe('');
      expect(JSON.parse(success.stdout)).toEqual({
        schemaVersion: 'media.cli-result.v1', commandId: 'media.cli.artifact.inspect', artifact: testArtifact,
      });
      expect(success.stdout).not.toContain(token);

      const forbidden = await invoke(command('https://media.example.test'), token, environment('artifact-forbidden'), fetchFixture);
      expect(forbidden.status).toBe(1);
      expect(forbidden.stdout).toBe('');
      expect(JSON.parse(forbidden.stderr)).toMatchObject({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.artifact.inspect',
        code: 'MEDIA_REQUEST_FAILED', statusCode: 403,
      });
      expect(forbidden.stderr).not.toContain(token);

      const timeout = await invoke(command('https://media.example.test'), token, environment('artifact-timeout'), fetchFixture);
      expect(timeout.status).toBe(1);
      expect(timeout.stdout).toBe('');
      expect(JSON.parse(timeout.stderr)).toEqual({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.artifact.inspect',
        code: 'OBSERVATION_UNAVAILABLE',
        message: 'No observation was received. Check the configured endpoint and retry this read.',
      });
      expect(timeout.stderr).not.toContain(token);

      const requests = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(requests).toHaveLength(3);
      expect(requests).toMatchObject([
        { method: 'GET', path: '/api/v1/artifacts/artifact-a', tenant: 'tenant-a', principal: 'principal-a', authenticated: true, bearerMatches: true },
        { method: 'GET', path: '/api/v1/artifacts/artifact-a', tenant: 'tenant-a', principal: 'principal-a', authenticated: true, bearerMatches: true },
        { method: 'GET', path: '/api/v1/artifacts/artifact-a', tenant: 'tenant-a', principal: 'principal-a', authenticated: true, bearerMatches: true },
      ]);
      expect(JSON.stringify(requests)).not.toContain(token);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('classifies malformed successful JSON as an invalid Media response without exposing its body', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-malformed-json-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    try {
      const result = await invoke(command('https://media.example.test'), token, {
        GHATANA_MEDIA_CLI_TEST_FETCH_MODE: 'artifact-malformed-json',
        GHATANA_MEDIA_CLI_TEST_LOG: requestLogPath,
      }, fetchFixture);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toEqual({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.artifact.inspect',
        code: 'INVALID_MEDIA_RESPONSE', message: 'Media returned a response that was not valid JSON.',
      });
      expect(result.stderr).not.toContain(token);
      expect(result.stderr).not.toContain('artifactId');
      const requests = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ method: 'GET', path: '/api/v1/artifacts/artifact-a' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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
