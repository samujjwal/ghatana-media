import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Each case spawns a Node child process; a 5 s default is below cold-start time on loaded hosts.
vi.setConfig({ testTimeout: 30_000 });
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exercises the DEV_ONLY render/export commands through the real executables (`pnpm build` first),
// with a preloaded fetch fixture standing in for the loopback launcher host.
const devBin = fileURLToPath(new URL('../dist/cli-dev.js', import.meta.url));
const prodBin = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const endpoint = 'http://127.0.0.1:43127';
const sha = 'b'.repeat(64);

const createToken = (overrides: Record<string, unknown> = {}) => {
  const iat = Math.floor(Date.now() / 1_000);
  const claims = {
    sub: 'principal-a', tenant_id: 'tenant-a', iss: 'urn:ghatana:media:dev-only', aud: 'ghatana-media-dev',
    dev_only: true, iat, exp: iat + 120,
    permissions: ['media:project:dev:read', 'media:project:dev:write', 'media:artifact:read', 'media:artifact:create',
      'media:delivery:dev:export', 'media:delivery:dev:read'],
    ...overrides,
  };
  return `test.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`;
};
const token = createToken();

let directory: string;
let preload: string;
let logPath: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'media-cli-render-export-'));
  logPath = join(directory, 'requests.jsonl');
  preload = join(directory, 'fetch.mjs');
  await writeFile(preload, `
import { appendFileSync } from 'node:fs';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sha = ${JSON.stringify(sha)};
const mode = process.env.FIXTURE_MODE;
const err = (status, code) => json({ error: { code, message: 'host message', retryable: status >= 500 }, meta: { correlationId: 'corr-1' } }, status);
const lineage = (format, extra = {}) => ({ scope: 'DEV_ONLY', renderSchema: 'media.dev.render.v1', engine: 'fixture-engine', projectId: 'project-a',
  revisionId: 'rev-1', timelineId: 'timeline-main', timelineSemanticVersionId: 'sem-1', requestId: 'req-1', width: 32, height: 24,
  framesPerSecond: 10, frameCount: 20, format, sources: [{ clipId: 'c1' }, { clipId: 'c2' }], ...extra });
const render = (replayed, format = 'gif', extra = {}, lin = {}) => ({ renderId: 'render-1', artifact: { artifactId: 'render-1',
  artifactVersionId: 'sha256:' + sha, contentType: format === 'mp4' ? 'video/mp4' : 'image/gif', sizeBytes: 900, sha256: sha,
  artifactPath: '/api/v1/artifacts/render-1' }, lineage: lineage(format, lin), replayed, scope: 'DEV_ONLY', ...extra });
const exp = (confirmed, replayed, extra = {}) => ({ requestId: 'exp-1', artifactId: 'artifact-a', artifactVersionId: 'sha256:' + sha,
  artifactDigest: sha, destinationId: 'dev-local-directory', status: confirmed ? 'DESTINATION_CONFIRMED' : 'OUTCOME_UNKNOWN',
  acknowledgedBytes: 900, destinationConfirmed: confirmed, destinationReceiptRef: confirmed ? 'receipt-1' : null, replayed, scope: 'DEV_ONLY', ...extra });
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ method: init.method ?? 'GET', path: url.pathname, body,
    authorization: new Headers(init.headers).get('authorization') ? 'present' : 'absent' }) + '\\n');
  if (mode === 'transport-loss') throw new TypeError('fetch failed');
  if (mode?.startsWith('error:')) { const [, status, code] = mode.split(':'); return err(Number(status), code); }
  if (mode === 'http-error-bare') return json({ nope: true }, 502);
  if (mode === 'malformed') return json({ renderId: 'render-1' }, 201);
  if (mode === 'not-json') return new Response('<html>', { status: 201 });
  if (mode === 'lineage-mismatch') return json(render(false, 'gif', {}, { revisionId: 'other-rev' }), 201);
  if (mode === 'format-mismatch') return json(render(false, 'gif'), 201);
  if (mode === 'leak') return json(render(false, 'gif', {}, { engine: process.env.FIXTURE_LEAK }), 201);
  if (mode === 'extra-key') return json(render(false, 'gif', { extra: 1 }), 201);
  if (url.pathname.endsWith('/renders') && init.method === 'POST') {
    if (mode === 'render-replay') return json(render(true, body.format ?? 'gif'), 200);
    return json(render(false, body.format ?? 'gif'), 201);
  }
  if (url.pathname.includes('/renders/')) return json(render(false), 200);
  if (url.pathname === '/dev/v1/exports' && init.method === 'POST') {
    if (mode === 'export-202') return json(exp(false, false), 202);
    if (mode === 'export-202-lying') return json(exp(true, false), 202);
    if (mode === 'export-201-no-receipt') return json(exp(false, false), 201);
    if (mode === 'export-replay') return json(exp(true, true), 200);
    return json(exp(true, false), 201);
  }
  if (url.pathname.startsWith('/dev/v1/exports/')) return json(mode === 'export-get-unconfirmed' ? exp(false, true) : exp(true, true), 200);
  return err(404, 'NOT_FOUND');
};
`);
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

function invoke(entry: string, args: string[], mode: string, tokenValue = token, env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', preload, entry, ...args], {
      env: { ...process.env, GHATANA_MEDIA_BEARER_TOKEN: tokenValue, FIXTURE_MODE: mode, FIXTURE_LOG: logPath, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdout.setEncoding('utf8').on('data', (c) => { stdout += c; });
    child.stderr.setEncoding('utf8').on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}
const base = ['--endpoint', endpoint, '--tenant', 'tenant-a', '--principal', 'principal-a'];
const renderArgs = ['project', 'render', ...base, '--project-id', 'project-a', '--revision-id', 'rev-1', '--timeline-id', 'timeline-main',
  '--request-id', 'req-1', '--width', '32', '--height', '24', '--fps', '10'];
const renderGetArgs = ['project', 'render-get', ...base, '--project-id', 'project-a', '--render-id', 'render-1'];
const exportArgs = ['export', 'create', ...base, '--request-id', 'exp-1', '--artifact-id', 'artifact-a',
  '--artifact-version-id', 'sha256:' + sha, '--destination-id', 'dev-local-directory'];
const exportGetArgs = ['export', 'get', ...base, '--request-id', 'exp-1'];
const dev = (args: string[], mode = 'ok', t = token, env: NodeJS.ProcessEnv = {}) => invoke(devBin, args, mode, t, env);
const errorOf = (stderr: string) => JSON.parse(stderr) as Record<string, unknown>;

describe('ghatanamedia-api-dev project render', () => {
  it('renders, sends the exact body, and reports artifact and lineage summary', async () => {
    await rm(logPath, { force: true });
    const result = await dev([...renderArgs, '--format', 'mp4']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const out = JSON.parse(result.stdout);
    expect(out).toMatchObject({ schemaVersion: 'media.cli-result.v1', commandId: 'media.cli.local-development.project.render',
      render: { renderId: 'render-1', replayed: false,
        artifact: { artifactId: 'render-1', artifactVersionId: 'sha256:' + sha, sha256: sha, contentType: 'video/mp4', sizeBytes: 900 },
        lineage: { projectId: 'project-a', revisionId: 'rev-1', timelineId: 'timeline-main', format: 'mp4', frameCount: 20, sourceCount: 2 } } });
    const logged = JSON.parse((await readFile(logPath, 'utf8')).trim());
    expect(logged).toMatchObject({ method: 'POST', path: '/dev/v1/projects/project-a/renders', authorization: 'present',
      body: { requestId: 'req-1', revisionId: 'rev-1', timelineId: 'timeline-main', width: 32, height: 24, framesPerSecond: 10, format: 'mp4' } });
    expect(result.stdout).not.toContain(token);
  });

  it('defaults to the host GIF format and reports replay', async () => {
    const result = await dev(renderArgs, 'render-replay');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).render).toMatchObject({ replayed: true, artifact: { contentType: 'image/gif' } });
    const logged = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).at(-1);
    expect(logged.body).not.toHaveProperty('format');
  });

  it.each([
    [404, 'PROJECT_NOT_FOUND'], [404, 'SOURCE_VERSION_NOT_FOUND'], [409, 'IDEMPOTENCY_CONFLICT'], [409, 'REVISION_CONFLICT'],
    [422, 'RENDER_EMPTY_TIMELINE'], [422, 'RENDER_LIMIT_EXCEEDED'], [422, 'TIMELINE_NOT_FOUND'], [422, 'TRACK_KIND_NOT_SUPPORTED'],
    [422, 'SOURCE_FORMAT_NOT_SUPPORTED'], [422, 'RENDER_UNSUPPORTED_FRAME_GEOMETRY'], [503, 'RENDER_CODEC_UNAVAILABLE'],
  ])('maps definitive host failure %i %s to a typed error echoing the request ID', async (status, code) => {
    const result = await dev(renderArgs, `error:${status}:${code}`);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(errorOf(result.stderr)).toMatchObject({ schemaVersion: 'media.cli-error.v1',
      commandId: 'media.cli.local-development.project.render', code, statusCode: status, requestId: 'req-1', correlationId: 'corr-1' });
    expect(result.stderr).not.toContain(token);
  });

  it.each([
    ['502 RENDER_REGISTRATION_FAILED', 'error:502:RENDER_REGISTRATION_FAILED'],
    ['502 RENDER_EXECUTION_FAILED', 'error:502:RENDER_EXECUTION_FAILED'],
    ['bare 502', 'http-error-bare'],
    ['transport loss', 'transport-loss'],
  ])('reports OUTCOME_UNKNOWN carrying the request ID on %s', async (_label, mode) => {
    const result = await dev(renderArgs, mode);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(errorOf(result.stderr)).toMatchObject({ code: 'OUTCOME_UNKNOWN', requestId: 'req-1' });
    expect(errorOf(result.stderr).message).toContain('same request ID');
  });

  it.each(['malformed', 'not-json', 'lineage-mismatch', 'extra-key'])('rejects a %s host response without inferring success', async (mode) => {
    const result = await dev(renderArgs, mode);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(errorOf(result.stderr)).toMatchObject({ code: 'INVALID_MEDIA_RESPONSE', requestId: 'req-1' });
  });

  it('rejects a response whose format contradicts the request, and one that echoes the token', async () => {
    const mismatch = await dev(renderArgs, 'format-mismatch');
    expect(mismatch.status).toBe(0); // gif request, gif response: consistent
    const wrongFormat = await dev([...renderArgs, '--format', 'mp4'], 'format-mismatch');
    expect(wrongFormat.status).toBe(1);
    expect(errorOf(wrongFormat.stderr).code).toBe('INVALID_MEDIA_RESPONSE');
    const leak = await dev(renderArgs, 'leak', token, { FIXTURE_LEAK: token });
    expect(leak.status).toBe(1);
    expect(leak.stdout).toBe('');
    expect(leak.stderr).not.toContain(token);
    expect(errorOf(leak.stderr).code).toBe('INVALID_MEDIA_RESPONSE');
  });

  it('reads a render back with render-get and types RENDER_NOT_FOUND', async () => {
    const result = await dev(renderGetArgs);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ commandId: 'media.cli.local-development.project.render-get', render: { renderId: 'render-1' } });
    const missing = await dev(renderGetArgs, 'error:404:RENDER_NOT_FOUND');
    expect(missing.status).toBe(1);
    expect(errorOf(missing.stderr)).toMatchObject({ code: 'RENDER_NOT_FOUND', statusCode: 404 });
    expect(errorOf(missing.stderr)).not.toHaveProperty('requestId');
    const lost = await dev(renderGetArgs, 'transport-loss');
    expect(errorOf(lost.stderr).code).toBe('OBSERVATION_UNAVAILABLE');
  });
});

describe('ghatanamedia-api-dev export', () => {
  it('reports a confirmed first export with its receipt', async () => {
    const result = await dev(exportArgs);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ commandId: 'media.cli.local-development.export.create',
      export: { requestId: 'exp-1', status: 'DESTINATION_CONFIRMED', destinationConfirmed: true, destinationReceiptRef: 'receipt-1', replayed: false, httpStatus: 201 } });
    expect(result.stdout).not.toContain(token);
  });

  it('reports a replayed export as confirmed', async () => {
    const result = await dev(exportArgs, 'export-replay');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).export).toMatchObject({ replayed: true, destinationConfirmed: true, httpStatus: 200 });
  });

  it('never reports confirmation for 202: distinct exit code, no stdout, no receipt', async () => {
    const result = await dev(exportArgs, 'export-202');
    expect(result.status).toBe(4);
    expect(result.stdout).toBe('');
    expect(errorOf(result.stderr)).toMatchObject({ code: 'EXPORT_NOT_CONFIRMED', requestId: 'exp-1',
      export: { destinationConfirmed: false, destinationReceiptRef: null, status: 'OUTCOME_UNKNOWN', httpStatus: 202 } });
  });

  it.each(['export-202-lying', 'export-201-no-receipt', 'malformed'])('rejects the contradictory host response %s', async (mode) => {
    const result = await dev(exportArgs, mode);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(errorOf(result.stderr)).toMatchObject({ code: 'INVALID_MEDIA_RESPONSE', requestId: 'exp-1' });
  });

  it.each([
    [404, 'DESTINATION_NOT_FOUND'], [404, 'ARTIFACT_VERSION_NOT_FOUND'], [409, 'EXPORT_REQUEST_CONFLICT'], [422, 'EXPORT_LIMIT_EXCEEDED'],
    [503, 'DELIVERY_DESTINATION_UNAVAILABLE'], [503, 'EXPORT_AUTHORIZATION_UNAVAILABLE'],
  ])('maps definitive host failure %i %s to a typed error', async (status, code) => {
    const result = await dev(exportArgs, `error:${status}:${code}`);
    expect(result.status).toBe(1);
    expect(errorOf(result.stderr)).toMatchObject({ code, statusCode: status, requestId: 'exp-1' });
  });

  it.each(['error:502:DESTINATION_EVIDENCE_INVALID', 'transport-loss'])('reports OUTCOME_UNKNOWN with the request ID on %s', async (mode) => {
    const result = await dev(exportArgs, mode);
    expect(result.status).toBe(1);
    expect(errorOf(result.stderr)).toMatchObject({ code: 'OUTCOME_UNKNOWN', requestId: 'exp-1' });
  });

  it('reads an export and surfaces an unconfirmed observation as EXPORT_NOT_CONFIRMED', async () => {
    const confirmed = await dev(exportGetArgs);
    expect(confirmed.status).toBe(0);
    expect(JSON.parse(confirmed.stdout)).toMatchObject({ commandId: 'media.cli.local-development.export.get', export: { destinationConfirmed: true } });
    const unconfirmed = await dev(exportGetArgs, 'export-get-unconfirmed');
    expect(unconfirmed.status).toBe(4);
    expect(unconfirmed.stdout).toBe('');
    expect(errorOf(unconfirmed.stderr).code).toBe('EXPORT_NOT_CONFIRMED');
    const missing = await dev(exportGetArgs, 'error:404:EXPORT_NOT_FOUND');
    expect(errorOf(missing.stderr)).toMatchObject({ code: 'EXPORT_NOT_FOUND', statusCode: 404 });
  });
});

describe('DEV_ONLY render/export invocation and channel boundaries', () => {
  it('rejects a non-loopback endpoint before any request', async () => {
    await rm(logPath, { force: true });
    const args = renderArgs.map((value) => (value === endpoint ? 'https://media.example.test' : value));
    const result = await dev(args);
    expect(result.status).toBe(3);
    expect(errorOf(result.stderr).code).toBe('LOCAL_DEV_ENDPOINT_REQUIRED');
    await expect(readFile(logPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['unknown flag', [...renderArgs, '--bogus', 'x']],
    ['missing --fps', renderArgs.slice(0, -2)],
    ['bad format', [...renderArgs, '--format', 'webm']],
    ['non-numeric width', renderArgs.map((v) => (v === '32' ? '3x' : v))],
    ['zero height', renderArgs.map((v) => (v === '24' ? '0' : v))],
    ['unsafe request id', renderArgs.map((v) => (v === 'req-1' ? 'bad id' : v))],
    ['export unknown flag', [...exportArgs, '--batch', 'x']],
    ['export get extra flag', [...exportGetArgs, '--destination-id', 'd']],
    ['render-get missing render id', renderGetArgs.slice(0, -2)],
    ['job batch', ['job', 'batch', ...base, '--job', 'job-a']],
    ['export batch', ['export', 'batch', ...base]],
    ['project unknown', ['project', 'delete', ...base]],
  ])('rejects %s as INVALID_INVOCATION without dispatch', async (_label, args) => {
    await rm(logPath, { force: true });
    const result = await dev(args);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(errorOf(result.stderr).code).toBe('INVALID_INVOCATION');
    await expect(readFile(logPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires command-specific DEV_ONLY permissions in the identity', async () => {
    const noWrite = createToken({ permissions: ['media:project:dev:read', 'media:artifact:read', 'media:artifact:create'] });
    expect((await dev(renderArgs, 'ok', noWrite)).status).toBe(3);
    const noExport = createToken({ permissions: ['media:artifact:read', 'media:delivery:dev:read'] });
    const denied = await dev(exportArgs, 'ok', noExport);
    expect(denied.status).toBe(3);
    expect(errorOf(denied.stderr).code).toBe('LOCAL_DEV_IDENTITY_REJECTED');
    expect(denied.stderr).not.toContain(noExport);
  });

  it.each([renderArgs, renderGetArgs, exportArgs, exportGetArgs])('the production executable rejects %s', async (...[args]) => {
    await rm(logPath, { force: true });
    for (const tokenValue of [token, '']) {
      const result = await invoke(prodBin, [...args.slice(0, 2), '--endpoint', 'https://media.example.test', ...args.slice(4)], 'ok', tokenValue);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(errorOf(result.stderr)).toMatchObject({ commandId: 'media.cli.invocation', code: 'INVALID_INVOCATION' });
      expect(result.stderr).not.toContain('project render');
    }
    await expect(readFile(logPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
