import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const originalFetch = globalThis.fetch;

globalThis.fetch = async (input, init = {}) => {
  const mode = process.env.GHATANA_MEDIA_CLI_TEST_FETCH_MODE;
  if (!mode) return originalFetch(input, init);

  const url = new URL(String(input));
  const headers = new Headers(init.headers);
  const logPath = process.env.GHATANA_MEDIA_CLI_TEST_LOG;
  const recordRequest = (extra = {}) => {
    if (!logPath) return;
    appendFileSync(logPath, `${JSON.stringify({
      path: url.pathname,
      search: url.search,
      method: init.method ?? 'GET',
      tenant: headers.get('x-tenant-id'),
      principal: headers.get('x-principal-id'),
      requestId: headers.get('x-request-id'),
      idempotencyKey: headers.get('idempotency-key'),
      accept: headers.get('accept'),
      contentLength: headers.get('content-length'),
      redirect: init.redirect ?? null,
      authenticated: /^Bearer .+$/u.test(headers.get('authorization') ?? ''),
      bearerMatches: headers.get('authorization') === `Bearer ${process.env.GHATANA_MEDIA_CLI_TEST_EXPECT_BEARER ?? ''}`,
      ...extra,
    })}\n`);
  };
  const isUploadFixture = mode === 'upload-success' || mode === 'upload-readback-mismatch';
  if (!isUploadFixture) recordRequest();

  const json = (body, status) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

  if (mode === 'upload-success' || mode === 'upload-readback-mismatch') {
    const sha256 = process.env.GHATANA_MEDIA_CLI_TEST_UPLOAD_SHA256;
    const artifactText = process.env.GHATANA_MEDIA_CLI_TEST_ARTIFACT;
    if (!sha256 || !artifactText) throw new Error('CLI upload fixture data is missing.');
    const artifact = JSON.parse(artifactText);
    const session = (bytesReceived = 0, nextChunkIndex = 0) => ({
      uploadId: 'upload-a', tenantId: 'tenant-a', principalId: 'principal-a', fileName: 'source.bin',
      contentType: 'application/octet-stream', expectedSizeBytes: 3, expectedSha256: sha256,
      classification: 'INTERNAL', createdAt: '2026-10-08T12:00:00.000Z',
      retention: 'PT720H', expiresAt: '2026-11-08T12:00:00.000Z', bytesReceived, nextChunkIndex, status: 'OPEN', metadata: {},
    });
    if (url.pathname === '/dev/v1/artifact-upload-policy' && init.method === 'GET') {
      recordRequest();
      return json({ schemaVersion: 'media.dev.artifact-upload-policy.v1', scope: 'DEV_ONLY', maxChunkBytes: 8 * 1024 * 1024 }, 200);
    }
    if (url.pathname === '/api/v1/artifacts/uploads' && init.method === 'POST') {
      const body = JSON.parse(String(init.body));
      recordRequest({ request: body });
      return json(session(), 201);
    }
    if (url.pathname === '/api/v1/artifacts/uploads/upload-a/chunks/0' && init.method === 'PUT') {
      const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
      recordRequest({ bodyHex: Buffer.from(bytes).toString('hex'), bodySha256: createHash('sha256').update(bytes).digest('hex') });
      return json(session(bytes.byteLength, 1), 200);
    }
    if (url.pathname === '/api/v1/artifacts/uploads/upload-a' && init.method === 'GET') {
      recordRequest();
      return json(session(3, 1), 200);
    }
    if (url.pathname === '/api/v1/artifacts/uploads/upload-a/complete' && init.method === 'POST') {
      recordRequest();
      return json(artifact, 201);
    }
    if (url.pathname === `/api/v1/artifacts/${encodeURIComponent(artifact.artifactId)}` && init.method === 'GET') {
      recordRequest();
      return json(mode === 'upload-readback-mismatch' ? { ...artifact, sha256: 'f'.repeat(64) } : artifact, 200);
    }
    recordRequest({ unexpected: true });
    return json({ error: { code: 'UNEXPECTED_ROUTE', message: 'unexpected', retryable: false } }, 500);
  }

  if (mode === 'artifact-malformed-json') {
    return new Response('{"artifactId":', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (mode === 'artifact-not-found') {
    return json({
      error: { code: 'ARTIFACT_NOT_FOUND', message: process.env.GHATANA_MEDIA_CLI_TEST_ERROR_MESSAGE ?? 'not visible', retryable: false },
      meta: { correlationId: process.env.GHATANA_MEDIA_CLI_TEST_CORRELATION_ID },
    }, 404);
  }

  if (mode === 'artifact-redirect') {
    if (init.redirect !== 'error') throw new Error('CLI artifact requests must reject redirects.');
    throw new TypeError('redirect mode error');
  }

  if (mode === 'artifact-success') {
    const configuredArtifact = process.env.GHATANA_MEDIA_CLI_TEST_ARTIFACT;
    if (!configuredArtifact) throw new Error('CLI test fixture artifact is missing.');
    return json(JSON.parse(configuredArtifact), 200);
  }
  if (mode === 'artifact-invalid-schema') {
    const configuredArtifact = process.env.GHATANA_MEDIA_CLI_TEST_ARTIFACT;
    if (!configuredArtifact) throw new Error('CLI test fixture artifact is missing.');
    return json({ ...JSON.parse(configuredArtifact), unsupportedField: true }, 200);
  }
  if (mode === 'artifact-forbidden') {
    return json({ error: { code: 'FORBIDDEN', message: tokenFromEnvironment() } }, 403);
  }
  if (mode === 'artifact-timeout') {
    throw new Error('socket-free fixture transport timeout');
  }

  const configuredJob = process.env.GHATANA_MEDIA_CLI_TEST_JOB;
  if (!configuredJob) throw new Error('CLI test fixture job is missing.');
  const job = JSON.parse(configuredJob);

  if (url.pathname === `/dev/v1/jobs/${encodeURIComponent(job.jobId)}/cancel` && init.method === 'POST') {
    const body = JSON.parse(String(init.body));
    return json({ schemaVersion: 'media.dev.job-cancellation-result.v1', scope: 'DEV_ONLY',
      requestId: body.requestId, outcome: 'UNSUPPORTED', replayed: false, job }, 200);
  }

  if (mode === 'job-submit-success') return json(job, 202);
  if (mode === 'job-get-success') return json(job, 200);

  if (mode === 'timeout') {
    return await new Promise((_, reject) => {
      const signal = init.signal;
      const abort = () => reject(signal?.reason ?? new DOMException('Request aborted', 'AbortError'));
      if (signal?.aborted) abort();
      else if (signal) signal.addEventListener('abort', abort, { once: true });
      else reject(new Error('Expected an abort signal for the CLI timeout fixture.'));
    });
  }
  if (mode === 'forbidden') {
    return json({ error: { code: 'FORBIDDEN', message: 'denied', retryable: false } }, 403);
  }
  if (mode === 'malformed') return json({ jobId: job.jobId }, 200);
  if (mode === 'unknown') return json({ ...job, status: 'OUTCOME_UNKNOWN' }, init.method === 'POST' ? 202 : 200);
  if (mode === 'success') return json(job, init.method === 'POST' ? 202 : 200);
  if (mode === 'restart') {
    const statePath = process.env.GHATANA_MEDIA_CLI_TEST_STATE;
    if (!statePath) throw new Error('CLI test fixture state path is missing.');
    let state;
    try { state = JSON.parse(readFileSync(statePath, 'utf8')); }
    catch { state = { effectCount: 0, jobs: {} }; }
    const key = headers.get('idempotency-key');
    if (!key) throw new Error('CLI submit did not send its idempotency key.');
    if (!state.jobs[key]) {
      state.jobs[key] = job;
      state.effectCount += 1;
      writeFileSync(statePath, JSON.stringify(state));
    }
    return json(state.jobs[key], 202);
  }
  throw new Error('Unknown CLI test fetch mode.');
};

function tokenFromEnvironment() {
  return process.env.GHATANA_MEDIA_CLI_TEST_EXPECT_BEARER ?? 'fixture-secret';
}
