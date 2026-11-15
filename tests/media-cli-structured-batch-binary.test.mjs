// Source-free binary test: runs the BUILT DEV_ONLY CLI (libs/audio-video-client/dist/cli-dev.js) as a separate
// node process against a loopback HTTP host owned by this test. This is a UNIT-level check of the CLI's batch
// contract (exit codes, finality, typed errors, schema paths, restart convergence by request identity). It is not
// evidence about the launcher; MediaDevStructuredCliBatchIT drives the same binary against the real launcher.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../libs/audio-video-client/dist/cli-dev.js', import.meta.url));
const iat = Math.floor(Date.now() / 1000);
const claims = (permissions) => ({ sub: 'p1', tenant_id: 't1', iss: 'urn:ghatana:media:dev-only', aud: 'ghatana-media-dev',
  dev_only: true, iat, exp: iat + 200, permissions });
const tokenFor = (permissions) => `h.${Buffer.from(JSON.stringify(claims(permissions))).toString('base64url')}.s`;
const FULL = tokenFor(['media:job:create', 'media:job:read', 'media:artifact:read']);
const jobDto = (requestId, status) => ({ jobId: `job-${requestId}`, requestId, tenantId: 't1', principalId: 'p1', artifactId: 'a1',
  jobType: 'TRANSCODE', providerId: 'local-diagnostic', status, createdAt: '2026-01-01T00:00:00Z', startedAt: null,
  completedAt: null, result: {}, failureCode: status === 'FAILED' ? 'PROVIDER_FAILED' : null, version: 1,
  expectedArtifactVersion: '', requestFingerprint: '' });

/** A host that counts durable effects per request identity, like the launcher's unique request constraint. */
function startHost(port, behaviour, dropLost = true) {
  const jobs = new Map();
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (req.method === 'POST' && req.url === '/api/v1/jobs') {
        const first = !jobs.has(body.requestId);
        if (first) jobs.set(body.requestId, { reads: 0 });
        if (body.requestId.startsWith('deny-')) return send(403, { error: { code: 'MEDIA_POLICY_DENIED', message: 'x', retryable: false }, meta: { correlationId: 'c-1' } });
        if (dropLost && body.requestId.startsWith('lost-')) return; // effect recorded, response never sent
        return send(202, jobDto(body.requestId, 'ACCEPTED'));
      }
      const read = /^\/api\/v1\/jobs\/job-(.+)$/u.exec(req.url.split('?')[0]);
      if (req.method === 'GET' && read) {
        const entry = jobs.get(read[1]);
        if (!entry) return send(404, { error: { code: 'JOB_NOT_FOUND', message: 'x', retryable: false }, meta: { correlationId: 'c-1' } });
        entry.reads += 1;
        return send(200, jobDto(read[1], behaviour(read[1], entry.reads)));
      }
      send(404, { error: { code: 'NOT_FOUND', message: 'x', retryable: false }, meta: { correlationId: 'c-1' } });
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    jobs, close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }) })));
}

const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

function run(dir, port, items, { token = FULL, timeoutMs = 20000, extra = [] } = {}) {
  return new Promise(async (resolve) => {
    const file = join(dir, `b-${Math.random().toString(36).slice(2)}.json`);
    await writeFile(file, typeof items === 'string' ? items : JSON.stringify({ schemaVersion: 'media.dev.batch.v1', items }));
    const child = spawn(process.execPath, [cli, 'batch', 'run', '--endpoint', `http://127.0.0.1:${port}`, '--tenant', 't1',
      '--principal', 'p1', '--file', file, ...extra], { cwd: dir, env: { PATH: process.env.PATH, GHATANA_MEDIA_BEARER_TOKEN: token,
        GHATANA_MEDIA_REQUEST_TIMEOUT_MS: String(timeoutMs) } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; }); child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (exit) => resolve({ exit, stdout, stderr, out: stdout ? JSON.parse(stdout) : undefined, err: stderr ? JSON.parse(stderr) : undefined }));
  });
}
const submit = (id, requestId, awaitMs) => ({ id, command: 'job submit', options: { artifact: 'a1', 'request-id': requestId,
  ...(awaitMs === undefined ? {} : { 'await-finality-ms': awaitMs }) } });

test('built CLI batch: finality, typed refusals, schema paths and restart convergence', { timeout: 120000 }, async (t) => {
  await access(cli).catch(() => assert.fail('build @audio-video/client first (pnpm --filter @audio-video/client build)'));
  const dir = await mkdtemp(join(tmpdir(), 'media-cli-binary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const port = await freePort();
  let host = await startHost(port, (id, reads) => id.startsWith('fail-') ? 'FAILED' : id.startsWith('cancel-') ? 'CANCELLED'
    : id.startsWith('slow-') ? 'RUNNING' : reads >= 3 ? 'COMPLETED' : 'RUNNING');
  t.after(() => host.close());

  await t.test('202 is never success; awaiting reaches COMPLETED', async () => {
    const accepted = await run(dir, port, [submit('s', 'ok-1')]);
    assert.equal(accepted.exit, 6);
    assert.equal(accepted.out.items[0].finality, 'UNKNOWN');
    assert.equal(accepted.out.summary.success, false);
    const done = await run(dir, port, [submit('s', 'ok-2', 5000)]);
    assert.equal(done.exit, 0);
    assert.deepEqual(done.out.items.map((i) => [i.status, i.finality]), [['SUCCESS', 'COMPLETED']]);
  });

  await t.test('FAILED and CANCELLED are final, exit 5; bounded await that elapses is UNKNOWN exit 6', async () => {
    assert.equal((await run(dir, port, [submit('s', 'fail-1', 5000)])).exit, 5);
    const cancelled = await run(dir, port, [submit('s', 'cancel-1', 5000)]);
    assert.equal(cancelled.out.items[0].finality, 'CANCELLED');
    const slow = await run(dir, port, [submit('s', 'slow-1', 600)]);
    assert.equal(slow.exit, 6);
    assert.equal(slow.out.items[0].error.code, 'JOB_NOT_FINAL');
  });

  await t.test('403 is typed FORBIDDEN; a token without the scope is refused locally (exit 3) before any request', async () => {
    const denied = await run(dir, port, [submit('s', 'deny-1', 1000), submit('n', 'ok-3', 1000)]);
    assert.equal(denied.exit, 1);
    assert.deepEqual(denied.out.items.map((i) => i.status), ['ERROR', 'NOT_RUN']);
    assert.equal(denied.out.items[0].error.code, 'FORBIDDEN');
    assert.equal(denied.out.items[0].error.serverCode, 'MEDIA_POLICY_DENIED');
    const before = host.jobs.size;
    const noScope = await run(dir, port, [submit('s', 'ok-4', 1000)], { token: tokenFor(['media:job:read']) });
    assert.equal(noScope.exit, 3);
    assert.equal(noScope.out.items[0].error.code, 'LOCAL_DEV_IDENTITY_REJECTED');
    assert.equal(host.jobs.size, before);
  });

  await t.test('schema error: exit 2 with a JSON path and no request', async () => {
    const before = host.jobs.size;
    const bad = await run(dir, port, [submit('s', 'ok-5'), { id: 'x', command: 'artifact inspect', options: { artifact: 'a', nope: 1 } }]);
    assert.equal(bad.exit, 2);
    assert.equal(bad.stdout, '');
    assert.equal(bad.err.jsonPath, 'items[1].options');
    assert.equal((await run(dir, port, '{broken')).err.jsonPath, '$');
    assert.equal(host.jobs.size, before);
  });

  await t.test('timeout is UNKNOWN with a resume handle; after a host restart the same batch converges without a second effect', async () => {
    const batch = [submit('s', 'lost-1', 5000)];
    const unknown = await run(dir, port, batch, { timeoutMs: 800 });
    assert.equal(unknown.out.items[0].status, 'OUTCOME_UNKNOWN');
    assert.equal(unknown.out.items[0].finality, 'UNKNOWN');
    assert.equal(unknown.out.items[0].resume.identity.value, 'lost-1');
    assert.equal(host.jobs.has('lost-1'), true);
    // Host restart: the durable effect (a job per request identity) survives; the new host answers the replay.
    const kept = host.jobs;
    await host.close();
    host = await startHost(port, () => 'COMPLETED', false);
    for (const [key, value] of kept) host.jobs.set(key, value);
    // The replay uses the same request identity; a host that knows it must not create a second job.
    const replay = await run(dir, port, batch);
    assert.equal(replay.exit, 0);
    assert.equal(replay.out.items[0].finality, 'COMPLETED');
    assert.equal(replay.out.items[0].result.job.jobId, 'job-lost-1');
    assert.equal(host.jobs.size, kept.size);
  });
});
