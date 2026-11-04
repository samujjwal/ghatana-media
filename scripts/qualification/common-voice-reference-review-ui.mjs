import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const DECISIONS = Object.freeze(['match', 'mismatch', 'unintelligible', 'skip']);
const HOST = '127.0.0.1';
const SOURCE_REVISION = 'cv-corpus-27.0-2026-09-11';
const DATASET_IDS = Object.freeze({ en: 'cmu5jplf300nwmh07iqvk9leo', 'ne-NP': 'cmu61478v00j9o107alzuue1z' });
const PILOT_SIZE = 24;

function assert(condition, message) {
  if (!condition) throw new TypeError(message);
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function aggregate(counts, total, complete) {
  return Object.freeze({ counts: Object.freeze({ total, ...counts }), complete });
}

function page(record, index, total, locale, token) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reference review</title></head><body>
<h1>Common Voice reference review</h1><p>Locale: ${escapeHtml(locale)} · Clip ${index + 1} of ${total}</p>
<p>Reviewer must be fluent in the target language. This tool does not prove reviewer competence. Responses are a human assessment.</p>
<audio controls preload="none" aria-label="Selected speech clip" src="/${token}/audio/${index}"></audio><p id="sentence" lang="${escapeHtml(locale)}">${escapeHtml(record.sentence)}</p>
<div>${DECISIONS.map((d) => `<button type="button" data-decision="${d}">${d}</button>`).join(' ')}</div><p id="status" role="status"></p>
<script>
for (const button of document.querySelectorAll('button[data-decision]')) button.addEventListener('click', async () => {
  for (const b of document.querySelectorAll('button')) b.disabled = true;
  const response = await fetch('/${token}/decision/${index}', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision:button.dataset.decision})});
  const result = await response.json();
  if (result.complete) { document.body.textContent = 'Review complete. Aggregate counts: ' + JSON.stringify(result.counts); }
  else location.href = '/${token}/' + (${index} + 1);
});
</script></body></html>`;
}

/** Start a volatile, loopback-only human reference review server. */
export async function startCommonVoiceReferenceReview(records, { locale = 'unknown' } = {}) {
  assert(Array.isArray(records) && records.length > 0, 'records must be a non-empty array');
  assert(typeof locale === 'string' && locale.length <= 64 && !/[\u0000-\u001f]/u.test(locale), 'locale is invalid');
  const token = randomBytes(24).toString('hex');
  const counts = Object.fromEntries(DECISIONS.map((d) => [d, 0]));
  let index = 0;
  let settled = false;
  let closed = false;
  let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });

  const server = createServer((req, res) => {
    const expectedHost = `127.0.0.1:${server.address()?.port}`;
    const url = new URL(req.url ?? '/', `http://${expectedHost}`);
    const safe = req.socket.remoteAddress === HOST && req.headers.host === expectedHost;
    const headers = {
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; media-src 'self'; style-src 'none'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    };
    const send = (status, type, body) => { res.writeHead(status, { ...headers, 'Content-Type': type }); res.end(body); };
    if (!safe) return send(403, 'text/plain; charset=utf-8', 'Forbidden');
    const route = new RegExp(`^/${token}(?:/(\\d+)|/(audio|decision)/(\\d+))?$`, 'u').exec(url.pathname);
    if (!route) {
      return send(404, 'text/plain; charset=utf-8', 'Not found');
    }
    if (closed) return send(410, 'text/plain; charset=utf-8', 'Review closed');
    if (req.method === 'GET' && !route[2]) {
      if (route[1] !== undefined && Number(route[1]) !== index) return send(409, 'text/plain; charset=utf-8', 'Stale clip page');
      if (index >= records.length) return send(200, 'text/html; charset=utf-8', `<p>Complete. ${JSON.stringify(counts)}</p>`);
      return send(200, 'text/html; charset=utf-8', page(records[index], index, records.length, locale, token));
    }
    if (req.method === 'GET' && route[2] === 'audio') {
      if (Number(route[3]) !== index) return send(409, 'text/plain; charset=utf-8', 'Stale clip audio request');
      if (index >= records.length) return send(404, 'text/plain; charset=utf-8', 'No current clip');
      res.writeHead(200, { ...headers, 'Content-Type': 'audio/mpeg', 'Content-Length': records[index].audioBytes.length });
      return res.end(records[index].audioBytes);
    }
    if (req.method === 'POST' && route[2] === 'decision') {
      const submittedForIndex = Number(route[3]);
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; if (body.length > 128) req.destroy(); });
      req.on('end', () => {
        if (closed) return send(410, 'application/json; charset=utf-8', '{}');
        let decision;
        try { decision = JSON.parse(body).decision; } catch { return send(400, 'application/json', '{}'); }
        if (!DECISIONS.includes(decision)) return send(400, 'application/json; charset=utf-8', '{}');
        if (submittedForIndex !== index || index >= records.length) return send(409, 'application/json; charset=utf-8', '{}');
        counts[decision] += 1;
        index += 1;
        const complete = index === records.length;
        const summary = aggregate(counts, records.length, complete);
        if (complete && !settled) { settled = true; resolveResult(summary); }
        send(200, 'application/json; charset=utf-8', JSON.stringify(summary));
        if (complete) setImmediate(() => { void close(); });
        return;
      });
      return;
    }
    return send(405, 'text/plain; charset=utf-8', 'Method not allowed');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  assert(address && address.address === HOST, 'server did not bind exclusively to IPv4 loopback');
  const close = async () => {
    if (closed) return;
    closed = true;
    if (!settled) { settled = true; resolveResult(aggregate(counts, records.length, false)); }
    for (const record of records) {
      if (Buffer.isBuffer(record.audioBytes)) record.audioBytes.fill(0);
      record.audioBytes = Buffer.alloc(0);
      record.sentence = '';
      record.clipId = '';
      record.audioSha256 = '';
    }
    await new Promise((resolve) => server.close(() => resolve()));
  };
  return Object.freeze({ url: `http://${HOST}:${address.port}/${token}/0`, token, result, close, address: address.address });
}

/** Coordinator entry point; caller may provide a server factory for controlled orchestration/tests. */
export async function runCommonVoiceHumanReferenceReview(input, { serverFactory = startCommonVoiceReferenceReview } = {}) {
  assert(input && Array.isArray(input.records), 'review input must contain records');
  assert(typeof input.locale === 'string' && typeof input.sourceRevision === 'string'
    && typeof input.sourceSplit === 'string', 'review source scope is incomplete');
  assert(Object.hasOwn(DATASET_IDS, input.locale), 'locale must be en or ne-NP');
  assert(input.sourceRevision === SOURCE_REVISION && input.sourceSplit === 'test'
    && input.sourceDatasetId === DATASET_IDS[input.locale], 'review source must be the pinned Common Voice v27 test split');
  assert(input.records.length === PILOT_SIZE, 'review requires exactly 24 clips');
  const ids = new Set();
  const hashes = new Set();
  const clipPattern = input.locale === 'en' ? /^common_voice_en_\d+\.mp3$/u : /^common_voice_ne-NP_\d+\.mp3$/u;
  for (const record of input.records) {
    assert(record && typeof record.clipId === 'string' && clipPattern.test(record.clipId), 'clip ID is invalid for the selected locale');
    assert(typeof record.sentence === 'string' && Buffer.isBuffer(record.audioBytes), 'each clip needs sentence and in-memory audio bytes');
    assert(typeof record.audioSha256 === 'string' && /^[0-9a-f]{64}$/u.test(record.audioSha256), 'audio hash must be lowercase SHA-256');
    assert(!ids.has(record.clipId) && !hashes.has(record.audioSha256), 'clip IDs and audio hashes must be unique');
    assert(createHash('sha256').update(record.audioBytes).digest('hex') === record.audioSha256, 'audio hash does not match in-memory bytes');
    ids.add(record.clipId);
    hashes.add(record.audioSha256);
  }
  const session = await serverFactory(input.records, { locale: input.locale });
  try {
    const value = await session.result;
    return Object.freeze({ completed: value.complete, counts: Object.freeze({ ...value.counts }) });
  } finally {
    await session.close();
  }
}

export { DECISIONS };
