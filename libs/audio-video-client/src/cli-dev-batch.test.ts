import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Each case spawns a Node child process; a 5 s default is below cold-start time on loaded hosts.
vi.setConfig({ testTimeout: 30_000 });
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exercises `batch run --file` through the real executables (`pnpm build` first) against a fake loopback host.
const devBin = fileURLToPath(new URL('../dist/cli-dev.js', import.meta.url));
const prodBin = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const endpoint = 'http://127.0.0.1:43127';
const sha = 'b'.repeat(64);

const createToken = () => {
  const iat = Math.floor(Date.now() / 1_000);
  const claims = {
    sub: 'principal-a', tenant_id: 'tenant-a', iss: 'urn:ghatana:media:dev-only', aud: 'ghatana-media-dev',
    dev_only: true, iat, exp: iat + 120,
    permissions: ['media:job:create', 'media:job:read', 'media:project:dev:read', 'media:project:dev:write', 'media:artifact:read', 'media:artifact:create', 'media:artifact:write',
      'media:delivery:dev:export', 'media:delivery:dev:read'],
  };
  return `test.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`;
};
const token = createToken();

let directory: string;
let preload: string;
let logPath: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'media-cli-batch-'));
  logPath = join(directory, 'requests.jsonl');
  preload = join(directory, 'fetch.mjs');
  // requestId prefixes steer the fake host: `bad-*` -> typed 404, `lost-*` -> 502 (outcome unknown), otherwise success.
  await writeFile(preload, `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sha = ${JSON.stringify(sha)};
const err = (status, code) => json({ error: { code, message: 'host message', retryable: status >= 500 }, meta: { correlationId: 'corr-1' } }, status);
const render = (b = {}, replayed = false) => ({ renderId: 'render-1', artifact: { artifactId: 'render-1', artifactVersionId: 'sha256:' + sha,
  contentType: 'image/gif', sizeBytes: 900, sha256: sha, artifactPath: '/api/v1/artifacts/render-1' },
  lineage: { scope: 'DEV_ONLY', renderSchema: 'media.dev.render.v1', engine: 'fixture-engine', projectId: 'project-a',
    revisionId: b.revisionId ?? 'rev-1', timelineId: b.timelineId ?? 'timeline-main', timelineSemanticVersionId: 'sem-1',
    requestId: b.requestId ?? 'req-1', width: b.width ?? 32, height: b.height ?? 24,
    framesPerSecond: b.framesPerSecond ?? 10, frameCount: 20, format: 'gif',
    sources: [{ clipId: 'c1', trackId: 'track-c1', artifactId: 'source-c1', artifactVersionId: 'sha256:' + sha }] }, replayed, scope: 'DEV_ONLY' });
const exp = (id, replayed, b) => ({ requestId: id, artifactId: b?.artifactId ?? 'artifact-a', artifactVersionId: b?.artifactVersionId ?? 'sha256:' + sha, artifactDigest: sha,
  destinationId: 'dev-local-directory', status: 'DESTINATION_CONFIRMED', acknowledgedBytes: 900, destinationConfirmed: true,
  destinationReceiptRef: 'receipt-1', replayed, scope: 'DEV_ONLY',
  ...(id.startsWith('ack-') ? { ackState: 'DELIVERED', failure: null, destinationReceivedBytes: 900, observedAt: '2026-01-01T00:00:00Z' } : {}) });
const jobReads = new Map();
const job = (id, requestId, status) => ({ jobId: id, requestId, tenantId: 'tenant-a', principalId: 'principal-a', artifactId: 'artifact-a',
  jobType: 'TRANSCODE', providerId: 'local-diagnostic', status, createdAt: '2026-01-01T00:00:00Z', startedAt: null,
  completedAt: ['COMPLETED', 'FAILED', 'CANCELLED'].includes(status) ? '2026-01-01T00:00:01Z' : null, result: {}, failureCode: status === 'FAILED' ? 'PROVIDER_FAILED' : null,
  version: 1, expectedArtifactVersion: '', requestFingerprint: '' });
const seen = new Set();
const readReplayState = () => {
  try { return JSON.parse(readFileSync(process.env.FIXTURE_REPLAY_STATE, 'utf8')); }
  catch { return {}; }
};
const writeReplayState = state => {
  if (process.env.FIXTURE_REPLAY_STATE) writeFileSync(process.env.FIXTURE_REPLAY_STATE, JSON.stringify(state));
};
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ method: init.method ?? 'GET', path: url.pathname, requestId: body?.requestId, fileName: body?.fileName, artifactId: body?.artifactId, artifactVersionId: body?.artifactVersionId }) + '\\n');
  if (url.pathname === '/dev/v1/artifact-upload-policy') return json({ schemaVersion: 'media.dev.artifact-upload-policy.v1', scope: 'DEV_ONLY', maxChunkBytes: 1024 });
  if (url.pathname === '/api/v1/jobs' && init.method === 'POST') {
    if (body.requestId.startsWith('deny-')) return err(403, 'MEDIA_POLICY_DENIED');
    return json(job('job-' + body.requestId, body.requestId, 'ACCEPTED'), 202);
  }
  if (url.pathname.startsWith('/api/v1/jobs/')) {
    const jobId = url.pathname.split('/').at(-1);
    const reads = (jobReads.get(jobId) ?? 0) + 1; jobReads.set(jobId, reads);
    const rid = jobId.slice(4);
    const status = rid.startsWith('fail-') ? 'FAILED' : rid.startsWith('cancel-') ? 'CANCELLED' : rid.startsWith('slow-') ? 'RUNNING'
      : reads >= 3 ? 'COMPLETED' : 'RUNNING';
    return json(job(jobId, rid, status));
  }
  if (url.pathname === '/dev/v1/exports' && init.method === 'POST' && process.env.FIXTURE_REPLAY_STATE) {
    const replayState = readReplayState();
    const prior = replayState[body.requestId];
    if (prior) return json({ ...prior.response, replayed: true }, 200);
    const response = exp(body.requestId, false, body);
    replayState[body.requestId] = { response, effectCount: 1 };
    writeReplayState(replayState);
    if (body.requestId.startsWith('lost-after-effect-')) return json({ nope: true }, 502);
    return json(response, 201);
  }
  const id = body?.requestId ?? url.pathname.split('/').at(-1);
  if (id?.startsWith('lost-')) return json({ nope: true }, 502);
  if (id?.startsWith('bad-')) return err(404, 'PROJECT_NOT_FOUND');
  if (url.pathname.endsWith('/renders') && init.method === 'POST') { const r = seen.has(id); seen.add(id); return json(render(body, r), r ? 200 : 201); }
  if (url.pathname.includes('/renders/')) return json(render(undefined, true), 200);
  if (url.pathname === '/dev/v1/exports' && init.method === 'POST') return json(exp(id, false, body), 201);
  if (url.pathname.startsWith('/dev/v1/exports/')) return json(exp(id, true), 200);
  return err(404, 'NOT_FOUND');
};
`);
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

function invoke(entry: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', preload, entry, ...args], {
      env: { ...process.env, GHATANA_MEDIA_BEARER_TOKEN: token, FIXTURE_LOG: logPath, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.stdout.setEncoding('utf8').on('data', (c) => { stdout += c; });
    child.stderr.setEncoding('utf8').on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}
const base = ['--endpoint', endpoint, '--tenant', 'tenant-a', '--principal', 'principal-a'];

const renderItem = (id: string, requestId: string) => ({ id, command: 'project render', options: {
  'project-id': 'project-a', 'revision-id': 'rev-1', 'timeline-id': 'timeline-main', 'request-id': requestId, width: 32, height: 24, fps: 10 } });
const exportItem = (id: string, requestId: string) => ({ id, command: 'export create', options: {
  'request-id': requestId, 'artifact-id': 'artifact-a', 'artifact-version-id': 'sha256:' + sha, 'destination-id': 'dev-local-directory' } });
const getItem = (id: string, requestId: string) => ({ id, command: 'export get', options: { 'request-id': requestId } });
const uploadItem = (id: string, file: string) => ({ id, command: 'artifact upload', options: {
  file, 'content-type': 'audio/wav', classification: 'PUBLIC', retention: 'P1D', 'idempotency-key': `upload-${id}` } });

let counter = 0;
async function batch(items: unknown[] | Record<string, unknown>, extra: string[] = [], raw?: string | Buffer) {
  await rm(logPath, { force: true });
  const file = join(directory, `batch-${counter++}.json`);
  await writeFile(file, raw ?? JSON.stringify(Array.isArray(items) ? { schemaVersion: 'media.dev.batch.v1', items } : items));
  const result = await invoke(devBin, ['batch', 'run', ...base, '--file', file, ...extra]);
  const log = await readFile(logPath, 'utf8').catch(() => '');
  return { ...result, requests: log.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) };
}
const statuses = (stdout: string) => (JSON.parse(stdout).items as { status: string }[]).map((i) => i.status);

describe('ghatanamedia-api-dev batch run', () => {
  it('runs all items in order and reports success only when every item succeeded', async () => {
    const result = await batch([renderItem('r1', 'req-1'), exportItem('e1', 'exp-1'), getItem('g1', 'exp-1')]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const out = JSON.parse(result.stdout);
    expect(out).toMatchObject({ schemaVersion: 'media.cli-batch-result.v1', nonAtomic: true,
      summary: { total: 3, succeeded: 3, failed: 0, outcomeUnknown: 0, notRun: 0, success: true, atomic: false } });
    expect(out.items.map((i: { id: string }) => i.id)).toEqual(['r1', 'e1', 'g1']);
    expect(out.items[0].result.render.renderId).toBe('render-1');
    expect(result.requests.map((r) => r.method)).toEqual(['POST', 'POST', 'GET']);
    expect(result.stdout).not.toContain(token);
  });

  it('stops at the first failure and marks the rest NOT_RUN', async () => {
    const result = await batch([renderItem('r1', 'req-1'), renderItem('r2', 'bad-1'), exportItem('e1', 'exp-1')]);
    expect(result.status).toBe(1);
    expect(statuses(result.stdout)).toEqual(['SUCCESS', 'ERROR', 'NOT_RUN']);
    const out = JSON.parse(result.stdout);
    expect(out.items[1].error.code).toBe('PROJECT_NOT_FOUND');
    expect(out.summary).toMatchObject({ success: false, failed: 1, notRun: 1, stoppedAt: 'r2' });
    expect(result.requests).toHaveLength(2);
  });

  it('--continue-on-error runs the remaining items but the batch is still not successful', async () => {
    const result = await batch([renderItem('r1', 'bad-1'), exportItem('e1', 'exp-1')], ['--continue-on-error']);
    expect(result.status).toBe(1);
    expect(statuses(result.stdout)).toEqual(['ERROR', 'SUCCESS']);
    expect(JSON.parse(result.stdout).summary).toMatchObject({ success: false, succeeded: 1, notRun: 0 });
    expect(result.requests).toHaveLength(2);
  });

  it('reports OUTCOME_UNKNOWN for a lost mutating item and never reports success', async () => {
    const result = await batch([exportItem('e1', 'lost-1'), exportItem('e2', 'exp-2')]);
    expect(result.status).toBe(1);
    expect(statuses(result.stdout)).toEqual(['OUTCOME_UNKNOWN', 'NOT_RUN']);
    const out = JSON.parse(result.stdout);
    expect(out.items[0].error.requestId).toBe('lost-1');
    expect(out.summary).toMatchObject({ success: false, outcomeUnknown: 1, notRun: 1 });
  });

  it('resumes a lost batch item after the CLI process restarts using the same request identity', async () => {
    const statePath = join(directory, 'export-replay-state.json');
    const file = join(directory, 'batch-after-lost-ack.json');
    const requestId = 'lost-after-effect-cli-restart';
    await rm(logPath, { force: true });
    await rm(statePath, { force: true });
    await writeFile(file, JSON.stringify({ schemaVersion: 'media.dev.batch.v1', items: [exportItem('e1', requestId)] }));

    const firstProcess = await invoke(devBin, ['batch', 'run', ...base, '--file', file], {
      FIXTURE_REPLAY_STATE: statePath,
    });
    expect(firstProcess.status).toBe(1);
    expect(statuses(firstProcess.stdout)).toEqual(['OUTCOME_UNKNOWN']);
    expect(JSON.parse(firstProcess.stdout).items[0].error.requestId).toBe(requestId);

    const restartedProcess = await invoke(devBin, ['batch', 'run', ...base, '--file', file], {
      FIXTURE_REPLAY_STATE: statePath,
    });
    expect(restartedProcess.status).toBe(0);
    expect(statuses(restartedProcess.stdout)).toEqual(['SUCCESS']);
    expect(JSON.parse(restartedProcess.stdout).items[0].result.export)
      .toMatchObject({ requestId, destinationConfirmed: true, replayed: true });

    const persisted = JSON.parse(await readFile(statePath, 'utf8'));
    expect(persisted[requestId].effectCount).toBe(1);
    const requests = (await readFile(logPath, 'utf8')).split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>);
    expect(requests.filter(request => request.method === 'POST' && request.path === '/dev/v1/exports'))
      .toHaveLength(2);
  });

  it('exits with the worst item exit code', async () => {
    const iat = Math.floor(Date.now() / 1_000);
    const limited = `test.${Buffer.from(JSON.stringify({ sub: 'principal-a', tenant_id: 'tenant-a', iss: 'urn:ghatana:media:dev-only',
      aud: 'ghatana-media-dev', dev_only: true, iat, exp: iat + 120, permissions: ['media:delivery:dev:read'] })).toString('base64url')}.fixture`;
    const file = join(directory, 'worst.json');
    await writeFile(file, JSON.stringify({ schemaVersion: 'media.dev.batch.v1', items: [getItem('g1', 'lost-1'), exportItem('e1', 'exp-1'), getItem('g2', 'exp-2')] }));
    const result = await invoke(devBin, ['batch', 'run', ...base, '--file', file, '--continue-on-error'], { GHATANA_MEDIA_BEARER_TOKEN: limited });
    expect(result.status).toBe(3);
    expect(statuses(result.stdout)).toEqual(['ERROR', 'ERROR', 'SUCCESS']);
    expect(JSON.parse(result.stdout).items[1]).toMatchObject({ exitCode: 3, error: { code: 'LOCAL_DEV_IDENTITY_REJECTED' } });
  });

  it('rejects a mutating item without a requestId before any request is sent', async () => {
    const noId = { id: 'e1', command: 'export create', options: { 'artifact-id': 'artifact-a', 'artifact-version-id': 'sha256:' + sha, 'destination-id': 'd' } };
    const noKey = { id: 'u1', command: 'artifact upload', options: { file: '/dev/null', 'content-type': 'video/mp4', classification: 'PUBLIC', retention: 'P1D' } };
    for (const bad of [noId, noKey]) {
      const result = await batch([getItem('g1', 'exp-1'), bad]);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr).code).toBe('BATCH_REQUEST_ID_REQUIRED');
      expect(result.requests).toEqual([]);
    }
  });

  it.each([
    ['unknown command', [{ id: 'x', command: 'job batch', options: {} }], 'BATCH_UNKNOWN_COMMAND'],
    ['nested batch', [{ id: 'x', command: 'batch run', options: { file: 'a' } }], 'BATCH_UNKNOWN_COMMAND'],
    ['unknown option', [{ ...getItem('x', 'exp-1'), options: { 'request-id': 'exp-1', extra: 'y' } }], 'BATCH_SCHEMA_INVALID'],
    ['endpoint override', [{ ...getItem('x', 'exp-1'), options: { 'request-id': 'exp-1', endpoint: 'http://evil' } }], 'BATCH_SCHEMA_INVALID'],
    ['extra item key', [{ ...getItem('x', 'exp-1'), note: 1 }], 'BATCH_SCHEMA_INVALID'],
    ['duplicate item id', [getItem('x', 'exp-1'), getItem('x', 'exp-2')], 'BATCH_SCHEMA_INVALID'],
    ['duplicate request identity', [exportItem('a', 'exp-1'), exportItem('b', 'exp-1')], 'BATCH_SCHEMA_INVALID'],
    ['empty items', [], 'BATCH_SCHEMA_INVALID'],
    ['too many items', Array.from({ length: 26 }, (_, i) => getItem(`g${i}`, `exp-${i}`)), 'BATCH_SCHEMA_INVALID'],
    ['non-string option', [{ ...getItem('x', 'exp-1'), options: { 'request-id': { a: 1 } } }], 'BATCH_SCHEMA_INVALID'],
  ])('rejects %s before dispatch', async (_name, items, code) => {
    const result = await batch(items as unknown[]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr).code).toBe(code);
    expect(result.requests).toEqual([]);
  });

  it('rejects invalid item values, malformed JSON, and extra top-level keys before dispatch', async () => {
    const badValue = await batch([getItem('g1', 'exp-1'), renderItem('r1', 'req-1')].map((i) => i.command === 'project render'
      ? { ...i, options: { ...i.options, width: 0 } } : i));
    expect(badValue.status).toBe(2);
    expect(badValue.requests).toEqual([]);
    const notJson = await batch([], [], '{nope');
    expect(JSON.parse(notJson.stderr).code).toBe('BATCH_SCHEMA_INVALID');
    const topLevel = await batch({ schemaVersion: 'media.dev.batch.v1', items: [getItem('g', 'e')], extra: 1 });
    expect(topLevel.status).toBe(2);
    expect(topLevel.requests).toEqual([]);
  });

  it('preserves valid UTF-8 in command values and rejects malformed UTF-8 before dispatch', async () => {
    const validPath = join(directory, 'source-é.wav');
    await writeFile(validPath, Buffer.from([0, 0]));
    const valid = await batch([uploadItem('valid', validPath)]);
    expect(valid.requests).toHaveLength(2);
    expect(valid.requests[1]).toMatchObject({ method: 'POST', path: '/api/v1/artifacts/uploads', fileName: 'source-é.wav' });

    // This is the path replacement-decoding would produce from the malformed
    // bytes below, ensuring the former behavior would proceed to host dispatch.
    const replacementPath = join(directory, 'source-\uFFFD\uFFFD.wav');
    await writeFile(replacementPath, Buffer.from([0, 0]));
    const sourceBytes = Buffer.from(JSON.stringify({
      schemaVersion: 'media.dev.batch.v1',
      items: [uploadItem('invalid', validPath)],
    }), 'utf8');
    const malformed = Buffer.from(sourceBytes);
    const marker = malformed.indexOf(Buffer.from('é', 'utf8'));
    expect(marker).toBeGreaterThanOrEqual(0);
    malformed[marker] = 0xff;
    malformed[marker + 1] = 0xfe;
    const rejected = await batch([], [], malformed);
    expect(rejected.status).toBe(2);
    expect(rejected.stdout).toBe('');
    expect(JSON.parse(rejected.stderr).code).toBe('BATCH_SCHEMA_INVALID');
    expect(rejected.requests).toEqual([]);

    const oversizedMalformed = await batch([], [], Buffer.alloc(262_145, 0xff));
    expect(oversizedMalformed.status).toBe(2);
    expect(JSON.parse(oversizedMalformed.stderr).code).toBe('BATCH_FILE_TOO_LARGE');
    expect(oversizedMalformed.requests).toEqual([]);
  });

  it('rejects an oversize batch file and a non-local or missing file', async () => {
    const big = await batch([], [], JSON.stringify({ schemaVersion: 'media.dev.batch.v1', items: [], pad: 'x'.repeat(300_000) }));
    expect(big.status).toBe(2);
    expect(JSON.parse(big.stderr).code).toBe('BATCH_FILE_TOO_LARGE');
    const remote = await invoke(devBin, ['batch', 'run', ...base, '--file', 'http://example.test/batch.json']);
    expect(remote.status).toBe(2);
    expect(JSON.parse(remote.stderr).code).toBe('BATCH_FILE_INVALID');
    const missing = await invoke(devBin, ['batch', 'run', ...base, '--file', join(directory, 'nope.json')]);
    expect(JSON.parse(missing.stderr).code).toBe('BATCH_FILE_INVALID');
    expect(missing.stderr).not.toContain(directory);
  });

  it('replaying the same batch reuses the same request identities, so the host sees per-item replays', async () => {
    const items = [renderItem('r1', 'req-replay'), exportItem('e1', 'exp-replay')];
    const first = await batch(items);
    expect(first.status).toBe(0);
    const second = await batch(items);
    expect(second.status).toBe(0);
    expect(second.requests.map((r) => r.requestId)).toEqual(first.requests.map((r) => r.requestId));
    expect(second.requests.map((r) => r.requestId)).toEqual(['req-replay', 'exp-replay']);
  });

  it('requires a token and a loopback endpoint', async () => {
    const file = join(directory, 'tok.json');
    await writeFile(file, JSON.stringify({ schemaVersion: 'media.dev.batch.v1', items: [getItem('g', 'e')] }));
    const noToken = await invoke(devBin, ['batch', 'run', ...base, '--file', file], { GHATANA_MEDIA_BEARER_TOKEN: '' });
    expect(JSON.parse(noToken.stderr).code).toBe('MISSING_AUTH_TOKEN');
    const remote = await invoke(devBin, ['batch', 'run', '--endpoint', 'https://example.com', '--tenant', 'tenant-a', '--principal', 'principal-a', '--file', file]);
    expect(remote.status).toBe(3);
  });

  it('the production channel rejects batch and job batch', async () => {
    const file = join(directory, 'prod.json');
    await writeFile(file, JSON.stringify({ schemaVersion: 'media.dev.batch.v1', items: [getItem('g', 'e')] }));
    for (const args of [['batch', 'run', ...base, '--file', file], ['job', 'batch', ...base]]) {
      await rm(logPath, { force: true });
      const result = await invoke(prodBin, args);
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stderr).code).toBe('INVALID_INVOCATION');
      expect(await readFile(logPath, 'utf8').catch(() => '')).toBe('');
    }
  });
});

describe('batch finality, typed refusals and schema paths', () => {
  const submit = (id: string, requestId: string, awaitMs?: number) => ({ id, command: 'job submit', options: {
    artifact: 'artifact-a', 'request-id': requestId, 'provider-hint': 'local-diagnostic', ...(awaitMs === undefined ? {} : { 'await-finality-ms': awaitMs }) } });

  it('a 202 ACCEPTED submit is never success: it is UNKNOWN with a resumable handle', async () => {
    const result = await batch([submit('s1', 'req-a'), exportItem('e1', 'exp-1')]);
    expect(result.status).toBe(6);
    const out = JSON.parse(result.stdout);
    expect(statuses(result.stdout)).toEqual(['OUTCOME_UNKNOWN', 'NOT_RUN']);
    expect(out.items[0]).toMatchObject({ finality: 'UNKNOWN', exitCode: 6, error: { code: 'JOB_NOT_FINAL', observedStatus: 'ACCEPTED' },
      resume: { itemId: 's1', command: 'job submit', identity: { option: 'request-id', value: 'req-a' } } });
    expect(out.items[1].finality).toBeNull();
    expect(out.summary).toMatchObject({ success: false, finality: { completed: 0, unknown: 1 } });
  });

  it('awaits true finality by polling the job until COMPLETED', async () => {
    const result = await batch([submit('s1', 'req-ok', 5000), exportItem('e1', 'exp-1')]);
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.items[0]).toMatchObject({ status: 'SUCCESS', finality: 'COMPLETED', result: { job: { status: 'COMPLETED' } } });
    expect(out.summary.finality).toMatchObject({ completed: 2, unknown: 0 });
    expect(result.requests.filter((r) => String(r.path).startsWith('/api/v1/jobs')).length).toBeGreaterThanOrEqual(3);
  });

  it('reports a final FAILED or CANCELLED job as ERROR with its own finality and exit code 5', async () => {
    const failed = await batch([submit('s1', 'fail-1', 5000)]);
    expect(failed.status).toBe(5);
    expect(JSON.parse(failed.stdout).items[0]).toMatchObject({ status: 'ERROR', finality: 'FAILED', exitCode: 5, error: { code: 'JOB_FAILED', failureCode: 'PROVIDER_FAILED' } });
    const cancelled = await batch([submit('s1', 'cancel-1', 5000)]);
    expect(cancelled.status).toBe(5);
    expect(JSON.parse(cancelled.stdout).items[0]).toMatchObject({ finality: 'CANCELLED', error: { code: 'JOB_CANCELLED' } });
  });

  it('a bounded await that elapses is JOB_NOT_FINAL / UNKNOWN, not failure and not success', async () => {
    const result = await batch([submit('s1', 'slow-1', 600)]);
    expect(result.status).toBe(6);
    expect(JSON.parse(result.stdout).items[0]).toMatchObject({ status: 'OUTCOME_UNKNOWN', finality: 'UNKNOWN', error: { code: 'JOB_NOT_FINAL', observedStatus: 'RUNNING' } });
  });

  it('types a server 403 as FORBIDDEN (no effect inferred), honours the continue policy', async () => {
    const stop = await batch([submit('s1', 'deny-1', 1000), exportItem('e1', 'exp-1')]);
    expect(stop.status).toBe(1);
    const out = JSON.parse(stop.stdout);
    expect(out.items[0]).toMatchObject({ status: 'ERROR', finality: 'FAILED', error: { code: 'FORBIDDEN', statusCode: 403, serverCode: 'MEDIA_POLICY_DENIED', requestId: 'deny-1' } });
    expect(statuses(stop.stdout)).toEqual(['ERROR', 'NOT_RUN']);
    const carry = await batch([submit('s1', 'deny-1', 1000), exportItem('e1', 'exp-1')], ['--continue-on-error']);
    expect(statuses(carry.stdout)).toEqual(['ERROR', 'SUCCESS']);
  });

  it('reports a JSON path for schema errors, before any request', async () => {
    const nested = await batch([getItem('g1', 'exp-1'), { ...getItem('g2', 'exp-2'), options: { 'request-id': 'exp-2', extra: 'y' } }]);
    expect(nested.status).toBe(2);
    expect(JSON.parse(nested.stderr)).toMatchObject({ code: 'BATCH_SCHEMA_INVALID', jsonPath: 'items[1].options' });
    const semantic = await batch([getItem('g1', 'exp-1'), { id: 'j', command: 'job submit', options: { artifact: 'a', 'request-id': 'r', 'await-finality-ms': 99999999 } }]);
    expect(semantic.status).toBe(2);
    expect(JSON.parse(semantic.stderr).jsonPath).toBe('items[1].options');
    const document = await batch([], [], '{nope');
    expect(JSON.parse(document.stderr).jsonPath).toBe('$');
    expect(nested.requests).toEqual([]);
  });

  it('late-binds an option from an earlier item result and rejects bad or forward references before dispatch', async () => {
    const e = { id: 'e1', command: 'export create', options: { 'request-id': 'exp-ref', 'destination-id': 'dev-local-directory',
      'artifact-id': { $ref: { item: 'r1', path: 'render.artifact.artifactId' } },
      'artifact-version-id': { $ref: { item: 'r1', path: 'render.artifact.sha256', prefix: 'sha256:' } } } };
    const ok = await batch([renderItem('r1', 'req-1'), e]);
    expect(ok.status).toBe(0);
    expect(ok.requests[1]).toMatchObject({ path: '/dev/v1/exports', artifactId: 'render-1', artifactVersionId: 'sha256:' + sha });
    const forward = await batch([e, renderItem('r1', 'req-1')]);
    expect(forward.status).toBe(2);
    expect(JSON.parse(forward.stderr)).toMatchObject({ code: 'BATCH_SCHEMA_INVALID', jsonPath: 'items[0].options.artifact-id' });
    expect(forward.requests).toEqual([]);
    const missing = await batch([renderItem('r1', 'req-1'), { ...e, options: { ...e.options, 'artifact-id': { $ref: { item: 'r1', path: 'render.nope' } } } }]);
    expect(missing.status).toBe(1);
    expect(JSON.parse(missing.stdout).items[1]).toMatchObject({ status: 'ERROR', finality: 'FAILED', error: { code: 'BATCH_REFERENCE_UNRESOLVED' } });
    const identity = await batch([renderItem('r1', 'req-1'), { ...e, options: { ...e.options, 'request-id': { $ref: { item: 'r1', path: 'render.renderId' } } } }]);
    expect(identity.status).toBe(2);
  });

  it('accepts the host\'s destination acknowledgement observation on export results', async () => {
    const result = await batch([exportItem('e1', 'ack-1'), getItem('g1', 'ack-1')]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).items[0].result.export).toMatchObject({ ackState: 'DELIVERED', destinationReceivedBytes: 900, destinationConfirmed: true });
  });
});
