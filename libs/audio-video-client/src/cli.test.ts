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

function jobCommand(endpoint: string, subcommand: string, extra: string[] = []) {
  return ['job', subcommand, '--endpoint', endpoint, '--tenant', 'tenant-a', '--principal', 'principal-a', ...extra];
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

describe('ghatanamedia-api canonical job commands', () => {
  const job = {
    jobId: 'job-1', requestId: 'request-1', tenantId: 'tenant-a', principalId: 'principal-a',
    artifactId: 'artifact-a', jobType: 'SPEECH_TO_TEXT', providerId: null, status: 'ACCEPTED',
    createdAt: timestamp, startedAt: null, completedAt: null, result: {}, failureCode: null,
    version: 2, expectedArtifactVersion: `sha256:${'e'.repeat(64)}`, requestFingerprint: `sha256:${'f'.repeat(64)}`,
  };

  it('exercises the packaged CLI over a socket-free child-process transport', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-fetch-'));
    const statePath = join(directory, 'idempotency-state.json');
    const requestLogPath = join(directory, 'requests.jsonl');
    const env = (mode: string): NodeJS.ProcessEnv => ({
      GHATANA_MEDIA_CLI_TEST_FETCH_MODE: mode,
      GHATANA_MEDIA_CLI_TEST_JOB: JSON.stringify(job),
      GHATANA_MEDIA_CLI_TEST_STATE: statePath,
      GHATANA_MEDIA_CLI_TEST_LOG: requestLogPath,
    });
    const submitArgs = jobCommand('https://media.example.test', 'submit', [
      '--request-id', 'request-1', '--correlation-id', 'corr-source-free', '--artifact', 'artifact-a',
      '--job-type', 'SPEECH_TO_TEXT', '--idempotency-key', 'key-source-free', '--parameters', '{}',
    ]);

    try {
      const accepted = await invoke(submitArgs, token, env('success'), fetchFixture);
      expect(accepted.status).toBe(0);
      expect(accepted.stderr).toBe('');
      expect(JSON.parse(accepted.stdout)).toEqual({
        schemaVersion: 'media.cli-result.v1', commandId: 'media.cli.job.submit', job,
      });

      const forbidden = await invoke(
        jobCommand('https://media.example.test', 'status', ['--job', 'job-1']), token, env('forbidden'), fetchFixture,
      );
      expect(forbidden.status).toBe(1);
      expect(forbidden.stdout).toBe('');
      expect(JSON.parse(forbidden.stderr)).toMatchObject({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.job.status', code: 'MEDIA_REQUEST_FAILED', statusCode: 403,
      });

      const unknown = await invoke(submitArgs, token, env('unknown'), fetchFixture);
      expect(unknown.status).toBe(3);
      expect(unknown.stdout).toBe('');
      expect(JSON.parse(unknown.stderr)).toMatchObject({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.job.submit', code: 'OUTCOME_UNKNOWN',
        jobId: 'job-1', requestId: 'request-1',
      });

      const timeout = await invoke(submitArgs, token, {
        ...env('timeout'), GHATANA_MEDIA_REQUEST_TIMEOUT_MS: '50',
      }, fetchFixture);
      expect(timeout.status).toBe(3);
      expect(timeout.stdout).toBe('');
      expect(JSON.parse(timeout.stderr)).toMatchObject({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.job.submit', code: 'OUTCOME_UNKNOWN',
        requestKey: 'key-source-free',
      });

      const malformed = await invoke(
        jobCommand('https://media.example.test', 'status', ['--job', 'job-1']), token, env('malformed'), fetchFixture,
      );
      expect(malformed.status).toBe(1);
      expect(malformed.stdout).toBe('');
      expect(JSON.parse(malformed.stderr)).toMatchObject({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.job.status', code: 'INVALID_MEDIA_RESPONSE',
      });

      const first = await invoke(submitArgs, token, env('restart'), fetchFixture);
      const secondProcess = await invoke(submitArgs, token, env('restart'), fetchFixture);
      expect(first.status).toBe(0);
      expect(secondProcess.status).toBe(0);
      expect(JSON.parse(first.stdout).job).toEqual(JSON.parse(secondProcess.stdout).job);
      const state = JSON.parse(await readFile(statePath, 'utf8')) as { effectCount: number };
      expect(state.effectCount).toBe(1);

      const requests = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as {
        path: string; method: string; tenant: string | null; principal: string | null; authenticated: boolean;
      });
      expect(requests.length).toBe(7);
      expect(requests.every(request => request.tenant === 'tenant-a'
        && request.principal === 'principal-a' && request.authenticated)).toBe(true);
      expect(requests.every(request => request.path.startsWith('/api/v1/jobs'))).toBe(true);
      expect(accepted.stdout + accepted.stderr + forbidden.stdout + forbidden.stderr + unknown.stdout + unknown.stderr
        + timeout.stdout + timeout.stderr + malformed.stdout + malformed.stderr + first.stdout + first.stderr
        + secondProcess.stdout + secondProcess.stderr).not.toContain(token);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('submits with canonical request identity and preserves ACCEPTED without claiming completion', async () => {
    let requests = 0;
    await withServer((request, response) => {
      requests++;
      expect(request.method).toBe('POST');
      expect(request.url).toBe('/api/v1/jobs');
      expect(request.headers['x-tenant-id']).toBe('tenant-a');
      expect(request.headers['x-principal-id']).toBe('principal-a');
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      expect(request.headers['idempotency-key']).toBe('key-1');
      let body = '';
      request.setEncoding('utf8').on('data', chunk => { body += chunk; });
      request.on('end', () => {
        expect(JSON.parse(body)).toEqual({
          requestId: 'request-1', tenantId: 'tenant-a', principalId: 'principal-a', correlationId: 'corr-1',
          artifactId: 'artifact-a', jobType: 'SPEECH_TO_TEXT', parameters: {},
        });
        response.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify(job));
      });
    }, async endpoint => {
      const result = await invoke(jobCommand(endpoint, 'submit', [
        '--request-id', 'request-1', '--correlation-id', 'corr-1', '--artifact', 'artifact-a',
        '--job-type', 'SPEECH_TO_TEXT', '--idempotency-key', 'key-1', '--parameters', '{}',
      ]));
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({
        schemaVersion: 'media.cli-result.v1', commandId: 'media.cli.job.submit', job,
      });
      expect(JSON.parse(result.stdout).job.status).toBe('ACCEPTED');
      expect(requests).toBe(1);
    });
  });

  it('never exits successfully when the canonical submit acknowledgement is OUTCOME_UNKNOWN', async () => {
    await withServer((_request, response) => {
      response.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ ...job, status: 'OUTCOME_UNKNOWN' }));
    }, async endpoint => {
      const result = await invoke(jobCommand(endpoint, 'submit', [
        '--request-id', 'request-1', '--correlation-id', 'corr-1', '--artifact', 'artifact-a',
        '--job-type', 'SPEECH_TO_TEXT', '--idempotency-key', 'key-1', '--parameters', '{}',
      ]));
      expect(result.status).toBe(3);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.job.submit', code: 'OUTCOME_UNKNOWN',
        jobId: 'job-1', requestId: 'request-1',
      });
    });
  });

  it('reports an observed OUTCOME_UNKNOWN job through the typed nonzero boundary', async () => {
    await withServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...job, status: 'OUTCOME_UNKNOWN' }));
    }, async endpoint => {
      const result = await invoke(jobCommand(endpoint, 'status', ['--job', 'job-1']));
      expect(result.status).toBe(3);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.job.status', code: 'OUTCOME_UNKNOWN',
        jobId: 'job-1', requestId: 'request-1',
      });
    });
  });

  it('cancels through the authenticated canonical SDK route and preserves the returned state', async () => {
    let requests = 0;
    await withServer((request, response) => {
      requests++;
      expect(request.method).toBe('POST');
      expect(request.url).toBe('/api/v1/jobs/job-1/cancel');
      expect(request.headers['x-tenant-id']).toBe('tenant-a');
      expect(request.headers['x-principal-id']).toBe('principal-a');
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      let body = '';
      request.setEncoding('utf8').on('data', chunk => { body += chunk; });
      request.on('end', () => {
        expect(JSON.parse(body)).toEqual({});
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...job, status: 'CANCELLED' }));
      });
    }, async endpoint => {
      const result = await invoke(jobCommand(endpoint, 'cancel', ['--job', 'job-1']));
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 'media.cli-result.v1', commandId: 'media.cli.job.cancel',
        job: { jobId: 'job-1', status: 'CANCELLED' },
      });
      expect(requests).toBe(1);
    });
  });

  it('maps a CLI request deadline after submit dispatch to OUTCOME_UNKNOWN', async () => {
    let requests = 0;
    await withServer((request, response) => {
      requests++;
      expect(request.method).toBe('POST');
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      request.resume();
    }, async endpoint => {
      const result = await invoke(jobCommand(endpoint, 'submit', [
        '--request-id', 'request-deadline', '--correlation-id', 'corr-deadline', '--artifact', 'artifact-a',
        '--job-type', 'SPEECH_TO_TEXT', '--idempotency-key', 'key-deadline', '--parameters', '{}',
      ]), token, { GHATANA_MEDIA_REQUEST_TIMEOUT_MS: '50' });
      expect(result.status).toBe(3);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.job.submit', code: 'OUTCOME_UNKNOWN',
        requestKey: 'key-deadline',
      });
      expect(JSON.parse(result.stderr).requestId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(requests).toBe(1);
      expect(result.stderr).not.toContain(token);
    });
  });

  it('preserves idempotent reconciliation across separate CLI process restarts', async () => {
    const effects = new Map<string, typeof job>();
    let requests = 0;
    await withServer((request, response) => {
      requests++;
      const key = request.headers['idempotency-key'];
      expect(typeof key).toBe('string');
      let body = '';
      request.setEncoding('utf8').on('data', chunk => { body += chunk; });
      request.on('end', () => {
      const submitted = { ...job };
        if (!effects.has(key as string)) effects.set(key as string, submitted);
        response.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify(effects.get(key as string)));
      });
    }, async endpoint => {
      const args = jobCommand(endpoint, 'submit', [
        '--request-id', 'request-restart', '--correlation-id', 'corr-restart', '--artifact', 'artifact-a',
        '--job-type', 'SPEECH_TO_TEXT', '--idempotency-key', 'key-restart', '--parameters', '{"lang":"en"}',
      ]);
      const first = await invoke(args);
      const restarted = await invoke(args);
      expect(first.status).toBe(0);
      expect(restarted.status).toBe(0);
      expect(JSON.parse(first.stdout).job.status).toBe('ACCEPTED');
      expect(JSON.parse(restarted.stdout).job.jobId).toBe('job-1');
      expect(effects.size).toBe(1);
      expect(requests).toBe(2);
    });
  });

  it('returns an authenticated exact NOT_ADMITTED error for capture/recorder without transport dispatch', async () => {
    for (const [name, subcommand] of [['capture', 'start'], ['recorder', 'start']]) {
      const result = await invoke([name, subcommand, '--endpoint', 'http://127.0.0.1:1', '--tenant', 'tenant-a', '--principal', 'principal-a']);
      expect(result.status).toBe(3);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(`${JSON.stringify({
        schemaVersion: 'media.cli-error.v1',
        commandId: `media.cli.${name}.${subcommand}`,
        code: 'NOT_ADMITTED',
        message: 'Capture and recorder execution require contracts not exposed by the canonical SDK.',
      })}\n`);
      expect(result.stdout + result.stderr).not.toContain(token);
    }
  });

  it('keeps the J-24 CLI scenario truthful across the currently supported command boundary', async () => {
    const endpoint = 'http://127.0.0.1:1';
    const identity = ['--endpoint', endpoint, '--tenant', 'tenant-a', '--principal', 'principal-a'];
    const malformedParameters = await invoke([
      'job', 'submit', ...identity,
      '--request-id', 'request-j24', '--correlation-id', 'corr-j24', '--artifact', 'artifact-a', '--job-type', 'SPEECH_TO_TEXT',
      '--idempotency-key', 'key-j24', '--parameters', '{"duplicate":1,"duplicate":2}',
    ]);
    expect(malformedParameters).toEqual({
      status: 2,
      stdout: '',
      stderr: `${JSON.stringify({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.job.submit', code: 'INVALID_INVOCATION',
        message: '--parameters must be a strict JSON object.',
      })}\n`,
    });

    const missingAuthentication = await invoke([
      'job', 'submit', ...identity,
      '--request-id', 'request-j24', '--correlation-id', 'corr-j24', '--artifact', 'artifact-a', '--job-type', 'SPEECH_TO_TEXT',
      '--idempotency-key', 'key-j24', '--parameters', '{"language":"en"}',
    ], '');
    expect(missingAuthentication).toEqual({
      status: 2,
      stdout: '',
      stderr: `${JSON.stringify({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.job.submit', code: 'MISSING_AUTH_TOKEN',
        message: 'Set GHATANA_MEDIA_BEARER_TOKEN in the environment; credentials are never accepted as command arguments.',
      })}\n`,
    });

    const notAdmitted = await invoke(['capture', 'start', ...identity]);
    expect(notAdmitted).toEqual({
      status: 3,
      stdout: '',
      stderr: `${JSON.stringify({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.capture.start', code: 'NOT_ADMITTED',
        message: 'Capture and recorder execution require contracts not exposed by the canonical SDK.',
      })}\n`,
    });

    // J-24 describes a batch, but no batch route is admitted by the canonical SDK.
    // Keep that proposed spelling an invocation error instead of reporting simulated success.
    const unsupportedBatch = await invoke(['job', 'batch', ...identity, '--parameters', '{"language":"en"}']);
    expect(unsupportedBatch.status).toBe(2);
    expect(unsupportedBatch.stdout).toBe('');
    expect(JSON.parse(unsupportedBatch.stderr)).toMatchObject({
      schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.invocation', code: 'INVALID_INVOCATION',
    });

    for (const result of [malformedParameters, missingAuthentication, notAdmitted, unsupportedBatch]) {
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain('media.cli-result.v1');
      expect(result.stdout + result.stderr).not.toContain(token);
    }
  });

  it('rejects the unadmitted J-24 batch spelling before the configured fetch boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-j24-batch-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    const result = await invoke([
      'job', 'batch', '--endpoint', 'https://media.example.test', '--tenant', 'tenant-a', '--principal', 'principal-a',
      '--parameters', '{"language":"en"}',
    ], token, {
      GHATANA_MEDIA_CLI_TEST_FETCH_MODE: 'success',
      GHATANA_MEDIA_CLI_TEST_JOB: JSON.stringify({ jobId: 'fixture-job' }),
      GHATANA_MEDIA_CLI_TEST_LOG: requestLogPath,
    }, fetchFixture);

    try {
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.invocation', code: 'INVALID_INVOCATION',
      });
      expect(result.stdout + result.stderr).not.toContain(token);
      await expect(readFile(requestLogPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects bearer credential material inside job parameters before authenticated dispatch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-j24-credential-parameter-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    const result = await invoke(jobCommand('https://media.example.test', 'submit', [
      '--request-id', 'request-j24-credential', '--correlation-id', 'corr-j24-credential', '--artifact', 'artifact-a',
      '--job-type', 'SPEECH_TO_TEXT', '--idempotency-key', 'key-j24-credential',
      '--parameters', JSON.stringify({ nested: { diagnostic: `provider setting ${token}` } }),
    ]), token, {
      GHATANA_MEDIA_CLI_TEST_FETCH_MODE: 'success',
      GHATANA_MEDIA_CLI_TEST_JOB: JSON.stringify({
        jobId: 'job-1', requestId: 'request-j24-credential', tenantId: 'tenant-a', principalId: 'principal-a',
        artifactId: 'artifact-a', jobType: 'SPEECH_TO_TEXT', providerId: null, status: 'ACCEPTED',
        createdAt: timestamp, startedAt: null, completedAt: null, result: {}, failureCode: null,
        version: 1, expectedArtifactVersion: '', requestFingerprint: `sha256:${'f'.repeat(64)}`,
      }),
      GHATANA_MEDIA_CLI_TEST_LOG: requestLogPath,
    }, fetchFixture);

    try {
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(`${JSON.stringify({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.job.submit', code: 'INVALID_INVOCATION',
        message: '--parameters must not contain bearer credential material.',
      })}\n`);
      expect(result.stdout + result.stderr).not.toContain(token);
      await expect(readFile(requestLogPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['[]', 'null', '{"duplicate":1,"duplicate":2}', '{"overflow":1e400}', '{"broken":', `${'{"a":'.repeat(34)}0${'}'.repeat(34)}`])(
    'rejects invalid, duplicate-key, non-finite, or over-deep JSON parameters before dispatch (%s)', async parameters => {
      const result = await invoke(jobCommand('http://127.0.0.1:1', 'submit', [
        '--request-id', 'request-1', '--correlation-id', 'corr-1', '--artifact', 'artifact-a',
        '--job-type', 'SPEECH_TO_TEXT', '--idempotency-key', 'key-1', '--parameters', parameters,
      ]));
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stderr).code).toBe('INVALID_INVOCATION');
      expect(result.stdout).toBe('');
    },
  );

  it('rejects parameters above the UTF-8 byte limit in a fresh CLI process before dispatch', async () => {
    // U+00E9 is two UTF-8 bytes. This remains small enough for a portable argv
    // entry while proving the limit is measured in bytes rather than JS chars.
    const parameters = JSON.stringify({ payload: 'é'.repeat(32_768) });
    const result = await invoke(jobCommand('http://127.0.0.1:1', 'submit', [
      '--request-id', 'request-size-limit', '--correlation-id', 'corr-size-limit', '--artifact', 'artifact-a',
      '--job-type', 'SPEECH_TO_TEXT', '--idempotency-key', 'key-size-limit', '--parameters', parameters,
    ]));

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(`${JSON.stringify({
      schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.job.submit', code: 'INVALID_INVOCATION',
      message: '--parameters must not exceed 65536 UTF-8 bytes.',
    })}\n`);
  });

  it('rejects unknown job types and path-segment injection before dispatch', async () => {
    const invalidType = await invoke(jobCommand('http://127.0.0.1:1', 'submit', [
      '--request-id', 'request-1', '--correlation-id', 'corr-1', '--artifact', 'artifact-a',
      '--job-type', 'NOT_A_JOB', '--idempotency-key', 'key-1',
    ]));
    const invalidArtifact = await invoke(jobCommand('http://127.0.0.1:1', 'status', ['--job', '../other']));
    for (const result of [invalidType, invalidArtifact]) {
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stderr).code).toBe('INVALID_INVOCATION');
      expect(result.stdout).toBe('');
    }
  });

  it('rejects invalid request-timeout configuration before any request', async () => {
    let requests = 0;
    await withServer((_request, response) => {
      requests++;
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(job));
    }, async endpoint => {
      const result = await invoke(jobCommand(endpoint, 'status', ['--job', 'job-1']), token, {
        GHATANA_MEDIA_REQUEST_TIMEOUT_MS: '0',
      });
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.job.status', code: 'INVALID_CONFIGURATION',
      });
      expect(requests).toBe(0);
    });
  });
});
