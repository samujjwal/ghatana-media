import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMediaOperationClient } from './operations.js';

const bin = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const devBin = fileURLToPath(new URL('../dist/cli-dev.js', import.meta.url));
const localDevEndpoint = 'http://127.0.0.1:43127';
const token = 'test-secret-do-not-print';
const timestamp = '2026-10-08T12:00:00.000Z';
const artifact = {
  tenantId: 'tenant-a', principalId: 'principal-a', artifactId: 'artifact-a', fileName: 'clip.wav',
  contentType: 'audio/wav', sizeBytes: 42, sha256: 'a'.repeat(64), objectReference: 'opaque://stored/object',
  classification: 'INTERNAL', createdAt: timestamp, expiresAt: '2026-11-08T12:00:00.000Z', metadata: { purpose: 'inspect' },
};
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
const invokeDev = (args: string[], tokenValue = devOnlyToken, envOverrides: NodeJS.ProcessEnv = {}, preload?: string) => invokeEntry(devBin, args, tokenValue, true, envOverrides, preload);
const fetchFixture = fileURLToPath(new URL('./__fixtures__/cli-fetch.mjs', import.meta.url));
const fixtureEnvironment = (mode: string, requestLogPath: string, overrides: NodeJS.ProcessEnv = {}) => ({
  GHATANA_MEDIA_CLI_TEST_FETCH_MODE: mode,
  GHATANA_MEDIA_CLI_TEST_EXPECT_BEARER: token,
  GHATANA_MEDIA_CLI_TEST_ARTIFACT: JSON.stringify(artifact),
  GHATANA_MEDIA_CLI_TEST_LOG: requestLogPath,
  ...overrides,
});

const devOnlyPermissions = [
  'media:artifact:create', 'media:artifact:read', 'media:artifact:write',
  'media:job:read', 'media:job:cancel',
];
const createDevOnlyToken = (overrides: Record<string, unknown> = {}) => {
  const issuedAt = Math.floor(Date.now() / 1_000);
  const claims = {
    sub: 'principal-a', tenant_id: 'tenant-a', iss: 'urn:ghatana:media:dev-only',
    aud: 'ghatana-media-dev', dev_only: true, iat: issuedAt, exp: issuedAt + 120,
    permissions: devOnlyPermissions,
    ...overrides,
  };
  return `test.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`;
};
const devOnlyToken = createDevOnlyToken();

async function writeRouteFetchPreload(directory: string): Promise<string> {
  const preload = join(directory, 'cli-route-fetch.mjs');
  await writeFile(preload, `
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const timestamp = '2026-10-08T12:00:00.000Z';
const mode = process.env.CLI_ROUTE_FIXTURE_MODE;
let session;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const headers = new Headers(init.headers);
  const authorization = headers.get('authorization') ?? '';
  let claims = {};
  try { claims = JSON.parse(Buffer.from(authorization.slice('Bearer '.length).split('.')[1], 'base64url').toString('utf8')); } catch {}
  const isUploadPolicy = url.pathname === '/dev/v1/artifact-upload-policy';
  const permission = isUploadPolicy || url.pathname === '/api/v1/artifacts/uploads' ? 'media:artifact:create'
    : url.pathname.includes('/chunks/') || url.pathname.endsWith('/complete') ? 'media:artifact:write'
      : url.pathname.startsWith('/api/v1/artifacts/') ? 'media:artifact:read'
        : url.pathname.endsWith('/cancel') ? 'media:job:cancel' : 'media:job:read';
  const devOnlyIdentityValid = claims.dev_only === true
    && claims.iss === 'urn:ghatana:media:dev-only' && claims.aud === 'ghatana-media-dev'
    && (isUploadPolicy || (claims.tenant_id === headers.get('x-tenant-id') && claims.sub === headers.get('x-principal-id')))
    && Array.isArray(claims.permissions) && claims.permissions.includes(permission);
  const request = {
    method: init.method ?? 'GET', path: url.pathname, search: url.search,
    tenant: headers.get('x-tenant-id'), principal: headers.get('x-principal-id'),
    idempotencyKey: headers.get('idempotency-key'), authenticated: authorization.startsWith('Bearer '),
    devOnlyIdentityValid,
  };
  const logPath = process.env.CLI_ROUTE_FIXTURE_LOG;
  const record = (extra = {}) => { if (logPath) appendFileSync(logPath, JSON.stringify({ ...request, ...extra }) + '\\n'); };
  if (!devOnlyIdentityValid) { record({ rejected: true }); return json({ error: { code: 'UNAUTHENTICATED', message: 'dev identity rejected', retryable: false } }, 401); }

  if (isUploadPolicy && request.method === 'GET') {
    record();
    if (mode === 'upload-policy-timeout') {
      return new Promise((resolve, reject) => {
        if (init.signal?.aborted) { reject(new DOMException('aborted', 'AbortError')); return; }
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    }
    if (mode === 'upload-policy-failure') return json({ error: { code: 'UNAVAILABLE', message: 'policy unavailable', retryable: false } }, 503);
    if (mode === 'upload-policy-invalid') return json({ schemaVersion: 'media.dev.artifact-upload-policy.v1', scope: 'PRODUCTION', maxChunkBytes: 3 });
    return json({ schemaVersion: 'media.dev.artifact-upload-policy.v1', scope: 'DEV_ONLY',
      maxChunkBytes: Number(process.env.CLI_ROUTE_FIXTURE_MAX_CHUNK_BYTES ?? 8388608) });
  }

  if (url.pathname === '/api/v1/artifacts/uploads' && request.method === 'POST') {
    const body = JSON.parse(String(init.body));
    record({ body });
    if (mode === 'upload-begin-unknown') return json({ error: { code: 'UNAVAILABLE', message: 'unavailable', retryable: true }, meta: { correlationId: 'corr-upload' } }, 503);
    session = { uploadId: mode === 'upload-token-id' ? authorization.slice('Bearer '.length) : 'upload-a', tenantId: body.tenantId, principalId: body.principalId,
      fileName: body.fileName, contentType: body.contentType, expectedSizeBytes: body.expectedSizeBytes,
      expectedSha256: body.expectedSha256, classification: body.classification,
      retention: 'PT720H', createdAt: timestamp, expiresAt: '2026-11-08T12:00:00.000Z', bytesReceived: 0, nextChunkIndex: 0,
      status: 'OPEN', metadata: body.metadata };
    if (mode === 'upload-resume-success') session = { ...session, bytesReceived: 2, nextChunkIndex: 1 };
    if (mode === 'upload-resume-invalid-position') session = { ...session, bytesReceived: 2, nextChunkIndex: 0 };
    return json(session, 201);
  }
  if (url.pathname.startsWith('/api/v1/artifacts/uploads/upload-a/chunks/') && request.method === 'PUT') {
    const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
    record({ bodyHex: Buffer.from(bytes).toString('hex'), bodySha256: createHash('sha256').update(bytes).digest('hex') });
    if (mode === 'upload-chunk-unknown') return json({ error: { code: 'UNAVAILABLE', message: 'unavailable', retryable: true }, meta: { correlationId: 'corr-upload' } }, 503);
    session = { ...session, bytesReceived: session.bytesReceived + bytes.byteLength, nextChunkIndex: session.nextChunkIndex + 1 };
    if (mode === 'upload-chunk-token-id') session = { ...session, uploadId: authorization.slice('Bearer '.length) };
    return json(session);
  }
  if (url.pathname === '/api/v1/artifacts/uploads/upload-a' && request.method === 'GET') {
    record();
    if (mode === 'upload-readback-token-id') session = { ...session, uploadId: authorization.slice('Bearer '.length) };
    return json(mode === 'upload-readback-mismatch' ? { ...session, bytesReceived: Math.max(0, session.bytesReceived - 1) } : session);
  }
  if (url.pathname === '/api/v1/artifacts/uploads/upload-a/complete' && request.method === 'POST') {
    record();
    return json(JSON.parse(process.env.CLI_ROUTE_FIXTURE_ARTIFACT), 201);
  }
  if (url.pathname === '/api/v1/artifacts/artifact-a' && request.method === 'GET') {
    record();
    if (mode === 'upload-artifact-readback-missing') return json({ error: { code: 'ARTIFACT_NOT_FOUND', message: 'not found', retryable: false } }, 404);
    const durable = JSON.parse(process.env.CLI_ROUTE_FIXTURE_ARTIFACT);
    return json(mode === 'upload-artifact-readback-mismatch' ? { ...durable, sha256: 'f'.repeat(64) } : durable);
  }
  if (url.pathname === '/api/v1/jobs/job-a' && request.method === 'GET') {
    record();
    return json(JSON.parse(process.env.CLI_ROUTE_FIXTURE_JOB));
  }
  if (url.pathname === '/dev/v1/jobs/job-a/cancel' && request.method === 'POST') {
    const body = JSON.parse(String(init.body));
    record({ body });
    const job = JSON.parse(process.env.CLI_ROUTE_FIXTURE_JOB);
    return json({ schemaVersion: 'media.dev.job-cancellation-result.v1', scope: 'DEV_ONLY',
      requestId: body.requestId, outcome: 'ALREADY_TERMINAL', replayed: false, job });
  }
  record({ unexpected: true });
  return json({ error: { code: 'UNEXPECTED_ROUTE', message: 'unexpected', retryable: false } }, 500);
};
`);
  return preload;
}

function command(endpoint: string, extra: string[] = []) {
  return ['artifact', 'inspect', '--endpoint', endpoint, '--tenant', 'tenant-a', '--principal', 'principal-a', '--artifact', 'artifact-a', ...extra];
}

function uploadCommand(endpoint: string, filePath: string) {
  return ['artifact', 'upload', '--endpoint', endpoint, '--tenant', 'tenant-a', '--principal', 'principal-a',
    '--file', filePath, '--content-type', 'application/octet-stream', '--classification', 'INTERNAL',
    '--retention', 'P30D', '--idempotency-key', 'upload-request-a'];
}

function jobCommand(endpoint: string, action: 'get' | 'cancel' = 'get') {
  return ['job', action, '--endpoint', endpoint, '--tenant', 'tenant-a', '--principal', 'principal-a', '--job', 'job-a'];
}

function routeFixtureEnvironment(mode: string, logPath: string, values: { artifact?: unknown; job?: unknown; maxChunkBytes?: number } = {}) {
  return {
    CLI_ROUTE_FIXTURE_MODE: mode,
    CLI_ROUTE_FIXTURE_LOG: logPath,
    CLI_ROUTE_FIXTURE_ARTIFACT: JSON.stringify(values.artifact ?? artifact),
    CLI_ROUTE_FIXTURE_JOB: JSON.stringify(values.job ?? {}),
    ...(values.maxChunkBytes === undefined ? {} : { CLI_ROUTE_FIXTURE_MAX_CHUNK_BYTES: String(values.maxChunkBytes) }),
  };
}

describe('ghatanamedia-api production executable', () => {
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
    const linkRoot = await mkdtemp(join(tmpdir(), 'media-cli-bin-'));
    const requestLogPath = join(linkRoot, 'requests.jsonl');
    const linkedBin = join(linkRoot, 'node_modules', '.bin', 'ghatanamedia-api');
    await mkdir(dirname(linkedBin), { recursive: true });
    await symlink(bin, linkedBin);
    try {
      const result = await invokeEntry(linkedBin, command('https://media.example.test'), token, false, {
        ...fixtureEnvironment('artifact-success', requestLogPath),
        NODE_OPTIONS: `--import="${fetchFixture}"`,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      const expected = {
        schemaVersion: 'media.cli-result.v1', commandId: 'media.cli.artifact.inspect', artifact,
      };
      expect(result.stdout).toBe(`${JSON.stringify(expected)}\n`);
      expect(JSON.parse(result.stdout)).toEqual(expected);
      expect(result.stdout).not.toContain(token);
      const requests = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        method: 'GET', path: '/api/v1/artifacts/artifact-a', tenant: 'tenant-a', principal: 'principal-a',
        authenticated: true, bearerMatches: true, accept: 'application/json', contentLength: null,
      });
      expect(JSON.stringify(requests)).not.toContain(token);
    } finally {
      await rm(linkRoot, { recursive: true, force: true });
    }
  });

  it('serializes semantically equal nested metadata with identical canonical JSON bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-canonical-json-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    try {
      const firstArtifact = { ...artifact, metadata: { z: 1, a: { y: 2, b: 3 }, list: [{ z: 4, a: 5 }] } };
      const secondArtifact = { ...artifact, metadata: { list: [{ a: 5, z: 4 }], a: { b: 3, y: 2 }, z: 1 } };
      const first = await invoke(command('https://media.example.test'), token, fixtureEnvironment('artifact-success', requestLogPath, { GHATANA_MEDIA_CLI_TEST_ARTIFACT: JSON.stringify(firstArtifact) }), fetchFixture);
      const second = await invoke(command('https://media.example.test'), token, fixtureEnvironment('artifact-success', requestLogPath, { GHATANA_MEDIA_CLI_TEST_ARTIFACT: JSON.stringify(secondArtifact) }), fetchFixture);
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
      const requests = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(requests).toHaveLength(2);
      expect(requests.every(request => request.path === '/api/v1/artifacts/artifact-a' && request.authenticated && request.bearerMatches)).toBe(true);
      expect(JSON.stringify(requests)).not.toContain(token);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['tenant', { tenantId: 'tenant-b' }],
    ['principal', { principalId: 'principal-b' }],
    ['artifact identity', { artifactId: 'artifact-b' }],
  ])('fails closed when the returned %s differs from the requested identity', async (_label, override) => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-scope-mismatch-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    try {
      const result = await invoke(command('https://media.example.test'), token, fixtureEnvironment('artifact-success', requestLogPath, { GHATANA_MEDIA_CLI_TEST_ARTIFACT: JSON.stringify({ ...artifact, ...override }) }), fetchFixture);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.artifact.inspect', code: 'INVALID_MEDIA_RESPONSE',
      });
      expect(result.stderr).not.toContain(token);
      const requests = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ method: 'GET', path: '/api/v1/artifacts/artifact-a', tenant: 'tenant-a', principal: 'principal-a', bearerMatches: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['malformed DTO', { ...artifact, sizeBytes: '42' }],
    ['unknown DTO field', { ...artifact, rightsCleared: true }],
  ])('rejects a %s without printing response data', async (_label, body) => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-malformed-dto-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    try {
      const result = await invoke(command('https://media.example.test'), token, fixtureEnvironment('artifact-success', requestLogPath, { GHATANA_MEDIA_CLI_TEST_ARTIFACT: JSON.stringify(body) }), fetchFixture);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stderr).code).toBe('INVALID_MEDIA_RESPONSE');
      expect(result.stderr).not.toContain('rightsCleared');
      expect(result.stdout).toBe('');
      const requests = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(requests).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps the CLI and SDK fail-closed on the same malformed artifact response', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-sdk-dto-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    const malformedArtifact = { ...artifact, sizeBytes: '42' };
    let sdkRequests = 0;
    try {
      const sdk = createMediaOperationClient({
        baseUrl: 'https://media.example.test',
        tenantId: 'tenant-a',
        defaultHeaders: { 'X-Principal-Id': 'principal-a' },
        getAccessToken: () => token,
        fetchImpl: async (input, init) => {
          sdkRequests++;
          expect(new URL(String(input)).pathname).toBe('/api/v1/artifacts/artifact-a');
          const headers = new Headers(init?.headers);
          expect(headers.get('x-tenant-id')).toBe('tenant-a');
          expect(headers.get('x-principal-id')).toBe('principal-a');
          expect(headers.get('authorization')).toBe(`Bearer ${token}`);
          return new Response(JSON.stringify(malformedArtifact), { status: 200, headers: { 'content-type': 'application/json' } });
        },
      });
      const sdkFailure = await sdk.getArtifact('artifact-a').then(
        () => { throw new Error('unreachable'); },
        (error: unknown) => error,
      );
      expect(sdkFailure).toBeInstanceOf(TypeError);
      expect((sdkFailure as Error).message)
        .toBe('Canonical Media artifact sizeBytes must be a positive safe integer.');
      expect((sdkFailure as Error).message).not.toContain(token);

      const cliResult = await invoke(command('https://media.example.test'), token, fixtureEnvironment('artifact-success', requestLogPath, { GHATANA_MEDIA_CLI_TEST_ARTIFACT: JSON.stringify(malformedArtifact) }), fetchFixture);
      expect(cliResult.status).toBe(1);
      expect(cliResult.stdout).toBe('');
      expect(JSON.parse(cliResult.stderr)).toMatchObject({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.artifact.inspect',
        code: 'INVALID_MEDIA_RESPONSE',
      });
      expect(cliResult.stderr).not.toContain(token);
      expect(sdkRequests).toBe(1);
      const requests = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ method: 'GET', path: '/api/v1/artifacts/artifact-a', tenant: 'tenant-a', principal: 'principal-a', bearerMatches: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects credential material echoed in an otherwise valid artifact without printing it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-response-credential-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    try {
      const result = await invoke(command('https://media.example.test'), token, fixtureEnvironment('artifact-success', requestLogPath, {
        GHATANA_MEDIA_CLI_TEST_ARTIFACT: JSON.stringify({ ...artifact, metadata: { purpose: `provider echoed ${token}` } }),
      }), fetchFixture);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toEqual({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.artifact.inspect',
        code: 'INVALID_MEDIA_RESPONSE', message: 'Media returned an artifact response containing credential material.',
      });
      expect(result.stderr).not.toContain(token);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-safe-404-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    try {
      const result = await invoke(command('https://media.example.test'), token, fixtureEnvironment('artifact-not-found', requestLogPath, {
        GHATANA_MEDIA_CLI_TEST_ERROR_MESSAGE: token,
        GHATANA_MEDIA_CLI_TEST_CORRELATION_ID: 'corr-not-found',
      }), fetchFixture);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toEqual({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.artifact.inspect',
        code: 'ARTIFACT_NOT_FOUND', message: 'Artifact was not visible in the requested tenant and principal scope.',
        statusCode: 404, correlationId: 'corr-not-found',
      });
      expect(result.stderr).not.toContain(token);
      const requests = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ method: 'GET', path: '/api/v1/artifacts/artifact-a', tenant: 'tenant-a', principal: 'principal-a', bearerMatches: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('returns an exact nonzero typed result for a forbidden authenticated operation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-forbidden-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    try {
      const result = await invoke(command('https://media.example.test'), token, fixtureEnvironment('artifact-forbidden', requestLogPath), fetchFixture);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.artifact.inspect',
        code: 'MEDIA_REQUEST_FAILED', statusCode: 403,
      });
      expect(result.stderr).not.toContain(token);
      const requests = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ method: 'GET', path: '/api/v1/artifacts/artifact-a', authenticated: true, bearerMatches: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('omits a correlation identifier that contains the bearer credential', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-correlation-secret-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    try {
      const result = await invoke(command('https://media.example.test'), token, fixtureEnvironment('artifact-not-found', requestLogPath, {
        GHATANA_MEDIA_CLI_TEST_CORRELATION_ID: `corr-${token}-echo`,
      }), fetchFixture);
      expect(result.status).toBe(1);
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
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-invalid-invocation-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    try {
      const endpoint = 'https://media.example.test';
      const missing = await invoke(['artifact', 'inspect', '--endpoint', endpoint], token, fixtureEnvironment('artifact-success', requestLogPath), fetchFixture);
      expect(missing.status).toBe(2);
      expect(JSON.parse(missing.stderr).code).toBe('INVALID_INVOCATION');
      const unknown = await invoke(command(endpoint, ['--token', token]), token, fixtureEnvironment('artifact-success', requestLogPath), fetchFixture);
      expect(unknown.status).toBe(2);
      expect(JSON.parse(unknown.stderr).code).toBe('INVALID_INVOCATION');
      const noToken = await invoke(command(endpoint), '', fixtureEnvironment('artifact-success', requestLogPath), fetchFixture);
      expect(noToken.status).toBe(2);
      expect(JSON.parse(noToken.stderr).code).toBe('MISSING_AUTH_TOKEN');
      const remoteHttp = await invoke(command('http://media.example.test'), token, fixtureEnvironment('artifact-success', requestLogPath), fetchFixture);
      expect(remoteHttp.status).toBe(2);
      expect(JSON.parse(remoteHttp.stderr).code).toBe('INVALID_ENDPOINT');
      for (const result of [missing, unknown, noToken, remoteHttp]) expect(result.stderr).not.toContain(token);
      await expect(readFile(requestLogPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
    { command: 'job status', args: ['job', 'status', '--job', 'j1'] },
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
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-redirect-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    try {
      const result = await invoke(command('https://media.example.test'), token, fixtureEnvironment('artifact-redirect', requestLogPath), fetchFixture);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stderr).code).toBe('OBSERVATION_UNAVAILABLE');
      expect(result.stdout + result.stderr).not.toContain(token);
      const requests = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        method: 'GET', path: '/api/v1/artifacts/artifact-a', authenticated: true, bearerMatches: true, redirect: 'error',
      });
      expect(requests.some(request => request.path === '/steal')).toBe(false);
      expect(JSON.stringify(requests)).not.toContain(token);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('ghatanamedia-api production command boundary', () => {
  it.each([
    ['embedded whitespace', 'invalid token'],
    ['non-bearer punctuation', 'invalid,token'],
    ['interior padding', 'invalid=token'],
  ])('rejects bearer credentials with %s before dispatch', async (_label, invalidToken) => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-invalid-bearer-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    try {
      const result = await invoke(command('https://media.example.test'), invalidToken, {
        GHATANA_MEDIA_CLI_TEST_FETCH_MODE: 'artifact-success',
        GHATANA_MEDIA_CLI_TEST_EXPECT_BEARER: invalidToken,
        GHATANA_MEDIA_CLI_TEST_LOG: requestLogPath,
      }, fetchFixture);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toEqual({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.artifact.inspect',
        code: 'INVALID_CONFIGURATION', message: 'GHATANA_MEDIA_BEARER_TOKEN is not a valid bearer credential.',
      });
      expect(result.stdout + result.stderr).not.toContain(invalidToken);
      await expect(readFile(requestLogPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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
        message: 'No observation was received. Check endpoint availability before requesting another read.',
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

      const invalidSchema = await invoke(command('https://media.example.test'), token,
        environment('artifact-invalid-schema'), fetchFixture);
      expect(invalidSchema.status).toBe(1);
      expect(invalidSchema.stdout).toBe('');
      expect(JSON.parse(invalidSchema.stderr)).toEqual({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.artifact.inspect',
        code: 'INVALID_MEDIA_RESPONSE',
        message: 'Media returned a response that did not match the canonical runtime DTO.',
      });
      expect(invalidSchema.stderr).not.toContain(token);

      const unauthenticated = await invoke(command('https://media.example.test'), '',
        environment('artifact-success'), fetchFixture);
      expect(unauthenticated.status).toBe(2);
      expect(unauthenticated.stdout).toBe('');
      expect(JSON.parse(unauthenticated.stderr)).toMatchObject({
        schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.artifact.inspect', code: 'MISSING_AUTH_TOKEN',
      });
      expect(unauthenticated.stderr).not.toContain(token);
      const requestsAfterUnauthenticated = (await readFile(requestLogPath, 'utf8')).trim().split('\n');
      expect(requestsAfterUnauthenticated).toHaveLength(4);
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

});

describe('ghatanamedia-api-dev local-development executable', () => {
  it.each([
    ['missing media type separator', 'audio'],
    ['embedded whitespace', 'audio /wav'],
    ['owner maximum length', `audio/${'x'.repeat(122)}`],
  ])('rejects malformed upload content type before file access or request dispatch (%s)', async (_case, contentType) => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-invalid-content-type-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    const missingSourcePath = join(directory, 'source-that-must-not-be-opened.wav');
    const preload = await writeRouteFetchPreload(directory);
    try {
      const result = await invokeDev([
        'artifact', 'upload', '--endpoint', localDevEndpoint, '--tenant', 'tenant-a', '--principal', 'principal-a',
        '--file', missingSourcePath, '--content-type', contentType, '--classification', 'INTERNAL',
        '--retention', 'P30D', '--idempotency-key', 'upload-request-a',
      ], devOnlyToken, routeFixtureEnvironment('upload-success', requestLogPath), preload);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({
        schemaVersion: 'media.cli-error.v1',
        commandId: 'media.cli.local-development.artifact.upload',
        code: 'INVALID_INVOCATION',
      });
      expect(result.stderr).toContain('content type must match the PDP-1 media type grammar');
      expect(result.stdout + result.stderr).not.toContain(devOnlyToken);
      await expect(readFile(requestLogPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('supports a DEV_ONLY scoped artifact inspection on loopback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-dev-inspect-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    const preload = await writeRouteFetchPreload(directory);
    try {
      const result = await invokeDev(command(localDevEndpoint), devOnlyToken,
        routeFixtureEnvironment('artifact-success', requestLogPath, { artifact }), preload);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({
        schemaVersion: 'media.cli-result.v1',
        commandId: 'media.cli.local-development.artifact.inspect', artifact,
      });
      const requests = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(requests).toMatchObject([{ method: 'GET', path: '/api/v1/artifacts/artifact-a',
        tenant: 'tenant-a', principal: 'principal-a', devOnlyIdentityValid: true }]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uploads one open file through authenticated canonical routes and binds completion to readback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-upload-source-free-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    const sourcePath = join(directory, 'source.bin');
    const preload = await writeRouteFetchPreload(directory);
    const bytes = Buffer.from('abc');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const uploadedArtifact = {
      ...artifact, fileName: 'source.bin', contentType: 'application/octet-stream',
      sizeBytes: bytes.length, sha256, metadata: {},
    };
    try {
      await writeFile(sourcePath, bytes);
      const result = await invokeDev(uploadCommand(`${localDevEndpoint}/`, sourcePath), devOnlyToken,
        routeFixtureEnvironment('upload-success', requestLogPath, { artifact: uploadedArtifact }), preload);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({
        schemaVersion: 'media.cli-result.v1', commandId: 'media.cli.local-development.artifact.upload', artifact: uploadedArtifact,
      });
      expect(result.stdout + result.stderr).not.toContain(sourcePath);
      expect(result.stdout + result.stderr).not.toContain(devOnlyToken);

      const requests = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(requests).toMatchObject([
        { method: 'GET', path: '/dev/v1/artifact-upload-policy', authenticated: true, devOnlyIdentityValid: true },
        { method: 'POST', path: '/api/v1/artifacts/uploads', tenant: 'tenant-a', principal: 'principal-a', idempotencyKey: 'upload-request-a', devOnlyIdentityValid: true },
        { method: 'PUT', path: '/api/v1/artifacts/uploads/upload-a/chunks/0', tenant: 'tenant-a', principal: 'principal-a', bodyHex: '616263', bodySha256: sha256, devOnlyIdentityValid: true },
        { method: 'GET', path: '/api/v1/artifacts/uploads/upload-a', tenant: 'tenant-a', principal: 'principal-a', devOnlyIdentityValid: true },
        { method: 'POST', path: '/api/v1/artifacts/uploads/upload-a/complete', tenant: 'tenant-a', principal: 'principal-a', devOnlyIdentityValid: true },
        { method: 'GET', path: '/api/v1/artifacts/artifact-a', tenant: 'tenant-a', principal: 'principal-a', devOnlyIdentityValid: true },
      ]);
      expect(requests[1].body).toMatchObject({
        tenantId: 'tenant-a', principalId: 'principal-a', fileName: 'source.bin',
        contentType: 'application/octet-stream', expectedSizeBytes: 3, expectedSha256: sha256,
        classification: 'INTERNAL', retention: 'P30D', metadata: {},
      });
      expect(JSON.stringify(requests)).not.toContain(devOnlyToken);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not report upload success when durable artifact metadata differs from completion', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-upload-artifact-readback-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    const sourcePath = join(directory, 'source.bin');
    const preload = await writeRouteFetchPreload(directory);
    try {
      const bytes = Buffer.from('abc');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const uploadedArtifact = {
        ...artifact, fileName: 'source.bin', contentType: 'application/octet-stream',
        sizeBytes: bytes.length, sha256, metadata: {},
      };
      await writeFile(sourcePath, bytes);
      const result = await invokeDev(uploadCommand(`${localDevEndpoint}/`, sourcePath), devOnlyToken,
        routeFixtureEnvironment('upload-artifact-readback-mismatch', requestLogPath, { artifact: uploadedArtifact }), preload);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({
        schemaVersion: 'media.cli-error.v1',
        commandId: 'media.cli.local-development.artifact.upload',
        code: 'OUTCOME_UNKNOWN',
        artifactId: 'artifact-a',
        uploadId: 'upload-a',
      });
      expect(result.stdout + result.stderr).not.toContain(devOnlyToken);
      const requests = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(requests.at(-1)).toMatchObject({ method: 'GET', path: '/api/v1/artifacts/artifact-a' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves the completed artifact identity when durable readback is not yet available', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-upload-artifact-readback-missing-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    const sourcePath = join(directory, 'source.bin');
    const preload = await writeRouteFetchPreload(directory);
    const bytes = Buffer.from('abc');
    const uploadedArtifact = {
      ...artifact, fileName: 'source.bin', contentType: 'application/octet-stream',
      sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), metadata: {},
    };
    try {
      await writeFile(sourcePath, bytes);
      const result = await invokeDev(uploadCommand(`${localDevEndpoint}/`, sourcePath), devOnlyToken,
        routeFixtureEnvironment('upload-artifact-readback-missing', requestLogPath, { artifact: uploadedArtifact }), preload);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({
        schemaVersion: 'media.cli-error.v1',
        commandId: 'media.cli.local-development.artifact.upload',
        code: 'OUTCOME_UNKNOWN',
        artifactId: 'artifact-a',
        uploadId: 'upload-a',
        statusCode: 404,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses the DEV_ONLY policy chunk limit for preflight and streamed upload bodies', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-upload-policy-chunks-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    const sourcePath = join(directory, 'source.bin');
    const preload = await writeRouteFetchPreload(directory);
    const bytes = Buffer.from('abcdefgh');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const uploadedArtifact = {
      ...artifact, fileName: 'source.bin', contentType: 'application/octet-stream',
      sizeBytes: bytes.length, sha256, metadata: {},
    };
    try {
      await writeFile(sourcePath, bytes);
      const result = await invokeDev(uploadCommand(localDevEndpoint, sourcePath), devOnlyToken,
        routeFixtureEnvironment('upload-success', requestLogPath, { artifact: uploadedArtifact, maxChunkBytes: 3 }), preload);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout).artifact).toEqual(uploadedArtifact);
      expect(result.stdout + result.stderr).not.toContain(devOnlyToken);

      const requests = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(requests.map((request: { method: string; path: string }) => `${request.method} ${request.path}`)).toEqual([
        'GET /dev/v1/artifact-upload-policy',
        'POST /api/v1/artifacts/uploads',
        'PUT /api/v1/artifacts/uploads/upload-a/chunks/0',
        'PUT /api/v1/artifacts/uploads/upload-a/chunks/1',
        'PUT /api/v1/artifacts/uploads/upload-a/chunks/2',
        'GET /api/v1/artifacts/uploads/upload-a',
        'POST /api/v1/artifacts/uploads/upload-a/complete',
        'GET /api/v1/artifacts/artifact-a',
      ]);
      expect(requests[0]).toMatchObject({ authenticated: true, devOnlyIdentityValid: true });
      expect(requests.slice(2, 5).map((request: { bodyHex: string }) => request.bodyHex)).toEqual([
        Buffer.from('abc').toString('hex'), Buffer.from('def').toString('hex'), Buffer.from('gh').toString('hex'),
      ]);
      expect(requests[1].body).toMatchObject({ expectedSizeBytes: bytes.length, expectedSha256: sha256 });
      expect(JSON.stringify(requests)).not.toContain(devOnlyToken);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('resumes a durable OPEN upload from its acknowledged byte and chunk position after CLI restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-upload-resume-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    const sourcePath = join(directory, 'source.bin');
    const preload = await writeRouteFetchPreload(directory);
    const bytes = Buffer.from('abcdef');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const uploadedArtifact = {
      ...artifact, fileName: 'source.bin', contentType: 'application/octet-stream',
      sizeBytes: bytes.length, sha256, metadata: {},
    };
    try {
      await writeFile(sourcePath, bytes);
      const result = await invokeDev(uploadCommand(localDevEndpoint, sourcePath), devOnlyToken,
        routeFixtureEnvironment('upload-resume-success', requestLogPath, {
          artifact: uploadedArtifact, maxChunkBytes: 2,
        }), preload);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout).artifact).toEqual(uploadedArtifact);

      const requests = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(requests.map((request: { method: string; path: string }) => `${request.method} ${request.path}`)).toEqual([
        'GET /dev/v1/artifact-upload-policy',
        'POST /api/v1/artifacts/uploads',
        'PUT /api/v1/artifacts/uploads/upload-a/chunks/1',
        'PUT /api/v1/artifacts/uploads/upload-a/chunks/2',
        'GET /api/v1/artifacts/uploads/upload-a',
        'POST /api/v1/artifacts/uploads/upload-a/complete',
        'GET /api/v1/artifacts/artifact-a',
      ]);
      expect(requests.slice(2, 4).map((request: { bodyHex: string }) => Buffer.from(request.bodyHex, 'hex').toString())).toEqual(['cd', 'ef']);
      expect(requests[1].body.expectedSha256).toBe(sha256);
      expect(result.stdout + result.stderr).not.toContain(devOnlyToken);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not dispatch chunks when a replayed upload reports an inconsistent resume position', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-upload-resume-invalid-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    const sourcePath = join(directory, 'source.bin');
    const preload = await writeRouteFetchPreload(directory);
    try {
      await writeFile(sourcePath, Buffer.from('abcdef'));
      const result = await invokeDev(uploadCommand(localDevEndpoint, sourcePath), devOnlyToken,
        routeFixtureEnvironment('upload-resume-invalid-position', requestLogPath), preload);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stderr)).toMatchObject({
        code: 'OUTCOME_UNKNOWN', commandId: 'media.cli.local-development.artifact.upload', uploadId: 'upload-a',
      });
      const requests = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(requests.map((request: { method: string; path: string }) => `${request.method} ${request.path}`)).toEqual([
        'GET /dev/v1/artifact-upload-policy', 'POST /api/v1/artifacts/uploads',
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(['upload-policy-failure', 'upload-policy-invalid', 'upload-policy-timeout'])('does not begin an upload when policy read is %s', async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-upload-policy-fail-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    const sourcePath = join(directory, 'source.bin');
    const preload = await writeRouteFetchPreload(directory);
    try {
      await writeFile(sourcePath, Buffer.from('abc'));
      const env = routeFixtureEnvironment(mode, requestLogPath);
      const result = await invokeDev(uploadCommand(localDevEndpoint, sourcePath), devOnlyToken,
        mode === 'upload-policy-timeout' ? { ...env, GHATANA_MEDIA_REQUEST_TIMEOUT_MS: '20' } : env, preload);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toContain(devOnlyToken);
      const requests = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ method: 'GET', path: '/dev/v1/artifact-upload-policy', authenticated: true });
      expect(requests.some((request: { method: string }) => request.method !== 'GET')).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails closed on local-file errors, upload uncertainty, and mismatched persisted progress', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-upload-fail-closed-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    const sourcePath = join(directory, 'source.bin');
    const preload = await writeRouteFetchPreload(directory);
    const bytes = Buffer.from('abc');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const uploadedArtifact = { ...artifact, fileName: 'source.bin', sizeBytes: 3, sha256, metadata: {} };
    const config = (mode: string) => routeFixtureEnvironment(mode, requestLogPath, { artifact: uploadedArtifact });
    try {
      const missing = await invokeDev(uploadCommand(localDevEndpoint, join(directory, 'missing.bin')),
        devOnlyToken, config('upload-success'), preload);
      expect(missing.status).toBe(1);
      expect(missing.stdout).toBe('');
      expect(JSON.parse(missing.stderr)).toMatchObject({ code: 'LOCAL_FILE_ERROR', commandId: 'media.cli.local-development.artifact.upload' });
      await expect(readFile(requestLogPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      await writeFile(sourcePath, bytes);
      const beginUnknown = await invokeDev(uploadCommand(localDevEndpoint, sourcePath), devOnlyToken,
        config('upload-begin-unknown'), preload);
      expect(beginUnknown.status).toBe(1);
      expect(beginUnknown.stdout).toBe('');
      expect(JSON.parse(beginUnknown.stderr)).toMatchObject({
        code: 'OUTCOME_UNKNOWN', commandId: 'media.cli.local-development.artifact.upload',
      });
      const beginRequests = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(beginRequests.map((request: { method: string; path: string }) => `${request.method} ${request.path}`)).toEqual([
        'GET /dev/v1/artifact-upload-policy', 'POST /api/v1/artifacts/uploads',
      ]);
      await rm(requestLogPath, { force: true });

      // The subprocess exits after one ambiguous begin and never retries the mutation automatically.
      expect(beginRequests).toHaveLength(2);

      const chunkUnknown = await invokeDev(uploadCommand(localDevEndpoint, sourcePath), devOnlyToken,
        config('upload-chunk-unknown'), preload);
      expect(chunkUnknown.status).toBe(1);
      expect(chunkUnknown.stdout).toBe('');
      expect(JSON.parse(chunkUnknown.stderr)).toMatchObject({
        code: 'OUTCOME_UNKNOWN', commandId: 'media.cli.local-development.artifact.upload', uploadId: 'upload-a',
      });
      const chunkRequests = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(chunkRequests.map((request: { method: string; path: string }) => `${request.method} ${request.path}`)).toEqual([
        'GET /dev/v1/artifact-upload-policy', 'POST /api/v1/artifacts/uploads',
        'PUT /api/v1/artifacts/uploads/upload-a/chunks/0',
      ]);
      expect(chunkUnknown.stderr).not.toContain(devOnlyToken);
      await rm(requestLogPath, { force: true });

      const mismatch = await invokeDev(uploadCommand(localDevEndpoint, sourcePath), devOnlyToken,
        config('upload-readback-mismatch'), preload);
      expect(mismatch.status).toBe(1);
      expect(mismatch.stdout).toBe('');
      expect(JSON.parse(mismatch.stderr)).toMatchObject({
        code: 'OUTCOME_UNKNOWN', commandId: 'media.cli.local-development.artifact.upload', uploadId: 'upload-a',
      });
      expect(JSON.parse(mismatch.stderr).message).toContain('Completion was not attempted');
      const mismatchRequests = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(mismatchRequests.map((request: { method: string; path: string }) => `${request.method} ${request.path}`)).toEqual([
        'GET /dev/v1/artifact-upload-policy', 'POST /api/v1/artifacts/uploads',
        'PUT /api/v1/artifacts/uploads/upload-a/chunks/0',
        'GET /api/v1/artifacts/uploads/upload-a',
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not expose or dispatch an upload session whose ID contains the DEV_ONLY bearer token', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-upload-token-id-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    const sourcePath = join(directory, 'source.bin');
    const preload = await writeRouteFetchPreload(directory);
    try {
      await writeFile(sourcePath, Buffer.from('abc'));
      const result = await invokeDev(uploadCommand(localDevEndpoint, sourcePath), devOnlyToken,
        routeFixtureEnvironment('upload-token-id', requestLogPath), preload);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      const error = JSON.parse(result.stderr);
      expect(error).toMatchObject({
        schemaVersion: 'media.cli-error.v1',
        commandId: 'media.cli.local-development.artifact.upload',
        code: 'OUTCOME_UNKNOWN',
      });
      expect(error).not.toHaveProperty('uploadId');
      expect(result.stderr).not.toContain(devOnlyToken);
      const requests = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(requests.map((request: { method: string; path: string }) => `${request.method} ${request.path}`)).toEqual([
        'GET /dev/v1/artifact-upload-policy', 'POST /api/v1/artifacts/uploads',
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      mode: 'upload-chunk-token-id',
      expectedRequests: ['GET /dev/v1/artifact-upload-policy', 'POST /api/v1/artifacts/uploads', 'PUT /api/v1/artifacts/uploads/upload-a/chunks/0'],
    },
    {
      mode: 'upload-readback-token-id',
      expectedRequests: ['GET /dev/v1/artifact-upload-policy', 'POST /api/v1/artifacts/uploads', 'PUT /api/v1/artifacts/uploads/upload-a/chunks/0', 'GET /api/v1/artifacts/uploads/upload-a'],
    },
  ])('stops upload after unsafe session identity in $mode', async ({ mode, expectedRequests }) => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-upload-session-token-id-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    const sourcePath = join(directory, 'source.bin');
    const preload = await writeRouteFetchPreload(directory);
    try {
      await writeFile(sourcePath, Buffer.from('abc'));
      const result = await invokeDev(uploadCommand(localDevEndpoint, sourcePath), devOnlyToken,
        routeFixtureEnvironment(mode, requestLogPath), preload);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stdout + result.stderr).not.toContain(devOnlyToken);
      const error = JSON.parse(result.stderr);
      expect(error).toMatchObject({
        schemaVersion: 'media.cli-error.v1',
        commandId: 'media.cli.local-development.artifact.upload',
        code: 'OUTCOME_UNKNOWN',
      });
      expect(error).not.toHaveProperty('uploadId', devOnlyToken);
      const requests = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(requests.map((request: { method: string; path: string }) => `${request.method} ${request.path}`)).toEqual(expectedRequests);
      expect(requests.some((request: { method: string; path: string }) => request.path.endsWith('/complete'))).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reads request-bound jobs and executes scoped DEV_ONLY cancellation with truthful outcome', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-job-routes-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    const preload = await writeRouteFetchPreload(directory);
    const job = {
      jobId: 'job-a', requestId: 'request-a', tenantId: 'tenant-a', principalId: 'principal-a',
      artifactId: 'artifact-a', jobType: 'TRANSCODE', providerId: 'local-diagnostic', status: 'OUTCOME_UNKNOWN',
      createdAt: timestamp, startedAt: timestamp, completedAt: null, result: {}, failureCode: null,
      version: 2, expectedArtifactVersion: '', requestFingerprint: `sha256:${'b'.repeat(64)}`,
    };
    try {
      const observed = await invokeDev([...jobCommand(localDevEndpoint), '--request-id', 'request-a'], devOnlyToken,
        routeFixtureEnvironment('job-get', requestLogPath, { job }), preload);
      expect(observed.status).toBe(0);
      expect(JSON.parse(observed.stdout)).toEqual({
        schemaVersion: 'media.cli-result.v1', commandId: 'media.cli.local-development.job.get', job,
      });
      expect(JSON.parse(observed.stdout).job.status).toBe('OUTCOME_UNKNOWN');

      const cancellation = await invokeDev([...jobCommand(localDevEndpoint, 'cancel'), '--request-id', 'request-a', '--expected-version', '2'], devOnlyToken,
        routeFixtureEnvironment('job-get', requestLogPath, { job }), preload);
      expect(cancellation.status).toBe(0);
      expect(cancellation.stderr).toBe('');
      expect(JSON.parse(cancellation.stdout)).toMatchObject({
        schemaVersion: 'media.cli-result.v1', commandId: 'media.cli.local-development.job.cancel',
        cancellation: { schemaVersion: 'media.dev.job-cancellation-result.v1', scope: 'DEV_ONLY',
          requestId: 'request-a', outcome: 'ALREADY_TERMINAL', replayed: false, job },
      });

      const requests = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(requests.map((request: { method: string; path: string; search: string }) => `${request.method} ${request.path}${request.search}`)).toEqual([
        'GET /api/v1/jobs/job-a?requestId=request-a',
        'POST /dev/v1/jobs/job-a/cancel',
      ]);
      expect(requests.every((request: { devOnlyIdentityValid: boolean; tenant: string; principal: string }) =>
        request.devOnlyIdentityValid && request.tenant === 'tenant-a' && request.principal === 'principal-a')).toBe(true);
      expect(requests).toHaveLength(2);
      expect(requests[1]!.body).toEqual({ requestId: 'request-a', expectedVersion: 2 });
      expect(JSON.stringify(requests)).not.toContain(devOnlyToken);

      const beforeMissingAuth = requests.length;
      const unauthenticated = await invokeDev(jobCommand(localDevEndpoint), '',
        routeFixtureEnvironment('job-get', requestLogPath, { job }), preload);
      expect(unauthenticated.status).toBe(2);
      expect(unauthenticated.stdout).toBe('');
      expect(JSON.parse(unauthenticated.stderr)).toMatchObject({
        code: 'MISSING_AUTH_TOKEN', commandId: 'media.cli.local-development.job.get',
      });
      const afterMissingAuth = (await readFile(requestLogPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(afterMissingAuth).toHaveLength(beforeMissingAuth);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects cancel without request binding and fails closed on endpoint or DEV_ONLY identity mismatch before fetch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-dev-identity-scope-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    const sourcePath = join(directory, 'source.bin');
    const preload = await writeRouteFetchPreload(directory);
    const job = {
      jobId: 'job-a', requestId: 'request-a', tenantId: 'tenant-a', principalId: 'principal-a',
      artifactId: 'artifact-a', jobType: 'TRANSCODE', providerId: 'local-diagnostic', status: 'OUTCOME_UNKNOWN',
      createdAt: timestamp, startedAt: timestamp, completedAt: null, result: {}, failureCode: null,
      version: 2, expectedArtifactVersion: '', requestFingerprint: `sha256:${'b'.repeat(64)}`,
    };
    try {
      await writeFile(sourcePath, Buffer.from('abc'));
      const invalidClaims = [
        createDevOnlyToken({ tenant_id: 'tenant-b' }),
        createDevOnlyToken({ sub: 'principal-b' }),
        createDevOnlyToken({ iss: 'https://issuer.example.test' }),
        createDevOnlyToken({ aud: 'media-production' }),
        createDevOnlyToken({ dev_only: false }),
        createDevOnlyToken({ permissions: ['media:artifact:read'] }),
      ];
      for (const badToken of invalidClaims) {
        const result = await invokeDev(jobCommand(localDevEndpoint), badToken,
          routeFixtureEnvironment('job-get', requestLogPath, { job }), preload);
        expect(result.status).toBe(3);
        expect(result.stdout).toBe('');
        expect(JSON.parse(result.stderr)).toMatchObject({
          code: 'LOCAL_DEV_IDENTITY_REJECTED', commandId: 'media.cli.local-development.job.get',
        });
        expect(result.stderr).not.toContain(badToken);
      }
      const base64UrlSignatureToken = devOnlyToken.replace('.fixture', '.sig_with_underscore');
      const validBase64Url = await invokeDev(jobCommand(localDevEndpoint), base64UrlSignatureToken,
        routeFixtureEnvironment('job-get', requestLogPath, { job }), preload);
      expect(validBase64Url.status).toBe(0);
      expect(JSON.parse(validBase64Url.stdout)).toMatchObject({
        schemaVersion: 'media.cli-result.v1', commandId: 'media.cli.local-development.job.get',
      });
      expect(validBase64Url.stderr).toBe('');
      await rm(requestLogPath, { force: true });

      const wrongScope = await invokeDev(['job', 'get', '--endpoint', localDevEndpoint, '--tenant', 'tenant-b',
        '--principal', 'principal-a', '--job', 'job-a'], devOnlyToken,
      routeFixtureEnvironment('job-get', requestLogPath, { job }), preload);
      expect(wrongScope.status).toBe(3);
      expect(wrongScope.stdout).toBe('');
      expect(JSON.parse(wrongScope.stderr)).toMatchObject({
        code: 'LOCAL_DEV_IDENTITY_REJECTED', commandId: 'media.cli.local-development.job.get',
      });
      const remote = await invokeDev(jobCommand('https://media.example.test'), devOnlyToken,
        routeFixtureEnvironment('job-get', requestLogPath, { job }), preload);
      expect(remote.status).toBe(3);
      expect(remote.stdout).toBe('');
      expect(JSON.parse(remote.stderr)).toMatchObject({
        code: 'LOCAL_DEV_ENDPOINT_REQUIRED', commandId: 'media.cli.local-development.job.get',
      });
      const pathPrefixedUpload = await invokeDev(uploadCommand(`${localDevEndpoint}/media`, sourcePath), devOnlyToken,
        routeFixtureEnvironment('upload-success', requestLogPath), preload);
      expect(pathPrefixedUpload.status).toBe(3);
      expect(pathPrefixedUpload.stdout).toBe('');
      expect(JSON.parse(pathPrefixedUpload.stderr)).toMatchObject({
        code: 'LOCAL_DEV_ENDPOINT_REQUIRED', commandId: 'media.cli.local-development.artifact.upload',
      });
      expect(pathPrefixedUpload.stderr).not.toContain(devOnlyToken);
      await expect(readFile(requestLogPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      const missingRequestId = await invokeDev(jobCommand(localDevEndpoint, 'cancel'), devOnlyToken,
        routeFixtureEnvironment('job-get', requestLogPath, { job }), preload);
      expect(missingRequestId.status).toBe(2);
      expect(missingRequestId.stdout).toBe('');
      expect(JSON.parse(missingRequestId.stderr).code).toBe('INVALID_INVOCATION');
      await expect(readFile(requestLogPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      for (const version of ['0', '-1', '1.0', '1e3', '9007199254740992']) {
        const invalidVersion = await invokeDev([
          ...jobCommand(localDevEndpoint, 'cancel'), '--request-id', 'cancel-request', '--expected-version', version,
        ], devOnlyToken, routeFixtureEnvironment('job-get', requestLogPath, { job }), preload);
        expect(invalidVersion.status).toBe(2);
        expect(invalidVersion.stdout).toBe('');
        expect(JSON.parse(invalidVersion.stderr)).toMatchObject({
          code: 'INVALID_INVOCATION', commandId: 'media.cli.local-development.job.cancel',
        });
        await expect(readFile(requestLogPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      }

      const missingAuth = await invokeDev([
        ...jobCommand(localDevEndpoint, 'cancel'), '--request-id', 'cancel-request',
      ], '', routeFixtureEnvironment('job-get', requestLogPath, { job }), preload);
      expect(missingAuth.status).toBe(2);
      expect(missingAuth.stdout).toBe('');
      expect(JSON.parse(missingAuth.stderr)).toMatchObject({
        code: 'MISSING_AUTH_TOKEN', commandId: 'media.cli.local-development.job.cancel',
      });
      await expect(readFile(requestLogPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

});

describe('ghatanamedia-api production command boundary', () => {
  it.each([
    { command: 'artifact upload', args: ['artifact', 'upload', '--file', 'source.bin', '--content-type', 'application/octet-stream', '--classification', 'INTERNAL', '--retention', 'P30D', '--idempotency-key', 'request-a'] },
    { command: 'job get', args: ['job', 'get', '--job', 'job-a'] },
    { command: 'job cancel', args: ['job', 'cancel', '--job', 'job-a', '--request-id', 'request-a'] },
    { command: 'artifact upload-inspect', args: ['artifact', 'upload-inspect', '--upload', 'upload-1'] },
    { command: 'job submit', args: ['job', 'submit', '--artifact', 'artifact-1', '--job-type', 'TRANSCODE', '--request-id', 'request-1', '--correlation-id', 'correlation-1', '--idempotency-key', 'request-1'] },
    { command: 'job status', args: ['job', 'status', '--job', 'job-1'] },
    { command: 'artifact delete', args: ['artifact', 'delete', '--artifact', 'artifact-1'] },
    { command: 'capture start', args: ['capture', 'start'] },
    { command: 'recorder start', args: ['recorder', 'start'] },
  ])('rejects unsupported production command $command before auth and transport dispatch', async ({ args }) => {
    const directory = await mkdtemp(join(tmpdir(), 'media-cli-unregistered-command-'));
    const requestLogPath = join(directory, 'requests.jsonl');
    try {
      for (const tokenValue of [token, '']) {
        const result = await invoke([...args, '--endpoint', 'https://media.example.test', '--tenant', 'tenant-a', '--principal', 'principal-a'], tokenValue, {
          GHATANA_MEDIA_CLI_TEST_FETCH_MODE: 'artifact-success',
          GHATANA_MEDIA_CLI_TEST_EXPECT_BEARER: token,
          GHATANA_MEDIA_CLI_TEST_LOG: requestLogPath,
        }, fetchFixture);
        expect(result.status).toBe(2);
        expect(result.stdout).toBe('');
        expect(JSON.parse(result.stderr)).toMatchObject({
          schemaVersion: 'media.cli-error.v1', commandId: 'media.cli.invocation', code: 'INVALID_INVOCATION',
        });
        expect(JSON.parse(result.stderr).message).toContain('Usage: ghatanamedia-api artifact inspect');
        expect(JSON.parse(result.stderr).message).not.toContain('job submit');
        expect(JSON.parse(result.stderr).message).not.toContain('artifact upload-inspect');
        expect(result.stderr).not.toContain(token);
      }
      await expect(readFile(requestLogPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
