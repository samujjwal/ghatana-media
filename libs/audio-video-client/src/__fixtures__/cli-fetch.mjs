import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const originalFetch = globalThis.fetch;

globalThis.fetch = async (input, init = {}) => {
  const mode = process.env.GHATANA_MEDIA_CLI_TEST_FETCH_MODE;
  if (!mode) return originalFetch(input, init);

  const url = new URL(String(input));
  const headers = new Headers(init.headers);
  const logPath = process.env.GHATANA_MEDIA_CLI_TEST_LOG;
  if (logPath) {
    appendFileSync(logPath, `${JSON.stringify({
      path: url.pathname,
      method: init.method ?? 'GET',
      tenant: headers.get('x-tenant-id'),
      principal: headers.get('x-principal-id'),
      requestId: headers.get('x-request-id'),
      idempotencyKey: headers.get('idempotency-key'),
      authenticated: /^Bearer .+$/u.test(headers.get('authorization') ?? ''),
      bearerMatches: headers.get('authorization') === `Bearer ${process.env.GHATANA_MEDIA_CLI_TEST_EXPECT_BEARER ?? ''}`,
    })}\n`);
  }

  const json = (body, status) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

  if (mode === 'artifact-malformed-json') {
    return new Response('{"artifactId":', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (mode === 'artifact-not-found') {
    return json({
      error: { code: 'ARTIFACT_NOT_FOUND', message: 'not visible', retryable: false },
      meta: { correlationId: process.env.GHATANA_MEDIA_CLI_TEST_CORRELATION_ID },
    }, 404);
  }

  const configuredJob = process.env.GHATANA_MEDIA_CLI_TEST_JOB;
  if (!configuredJob) throw new Error('CLI test fixture job is missing.');
  const job = JSON.parse(configuredJob);

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
