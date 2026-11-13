#!/usr/bin/env node
// MED-09(c): small reproducible SYNTHETIC benchmark of the optional providers' client-side bounds and latency.
//   node scripts/optional-providers/synthetic-benchmark.mjs [--out file.json] [--iterations N] [--seed S]
// Measures the scanner provider against a FAKE clamd and the DI TypeScript client parse round trip against a FAKE
// worker, both in-process on loopback. The numbers characterise protocol/bounds overhead of this code only. They are
// NOT real ClamAV / OCR engine performance, NOT a corpus run, and NOT qualification or admission evidence.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FAKE_DI, buildPackage, deadPort, diClientDir, repoRoot, scannerDir, startFakeClamd, startFakeDiWorker } from './support.mjs';

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };
const iterations = Number(arg('iterations', '100'));
const seed = Number(arg('seed', '1'));
const outFile = arg('out');

// Deterministic payload bytes (xorshift32) so repeated runs scan identical content.
function payload(size) {
  let x = (seed * 2654435761) >>> 0 || 1;
  const b = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; b[i] = 97 + (x % 26); }
  return b;
}
const sha = (b) => createHash('sha256').update(b).digest('hex');
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const stats = (ms) => {
  const s = [...ms].sort((a, b) => a - b);
  const r = (n) => Math.round(n * 1000) / 1000;
  return { n: s.length, minMs: r(s[0]), p50Ms: r(pct(s, 50)), p95Ms: r(pct(s, 95)), p99Ms: r(pct(s, 99)), maxMs: r(s[s.length - 1]), meanMs: r(s.reduce((a, b) => a + b, 0) / s.length) };
};
const timeIt = async (fn) => { const t = process.hrtime.bigint(); const v = await fn(); return [Number(process.hrtime.bigint() - t) / 1e6, v]; };

function fingerprint() {
  const git = (...a) => { try { return execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8' }).trim(); } catch { return null; } };
  return {
    node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch, osRelease: os.release(),
    cpuModel: os.cpus()[0]?.model ?? null, cpuCount: os.cpus().length, totalMemBytes: os.totalmem(), loadAvg1m: os.loadavg()[0],
    gitCommit: git('rev-parse', 'HEAD'), gitDirty: git('status', '--porcelain', '--', 'providers/security-scanner', 'services/document-intelligence/clients/typescript')?.length > 0,
    capturedAt: new Date().toISOString(), iterations, seed,
  };
}

buildPackage(scannerDir);
buildPackage(diClientDir);
const scanner = await import(pathToFileURL(path.join(scannerDir, 'dist/index.js')).href);
const di = await import(pathToFileURL(path.join(diClientDir, 'dist/index.js')).href);
const clamd = await startFakeClamd();
const worker = await startFakeDiWorker();
const clock = () => new Date('2025-11-12T12:00:00Z');
const MAX = 2 * 1024 * 1024;

const result = {
  label: 'SYNTHETIC_NOT_QUALIFICATION',
  disclaimer: 'Fake clamd and fake DI worker over loopback, in-process. Not real engine performance, not a rights-cleared corpus, not qualification or admission evidence.',
  environment: fingerprint(),
  scanner: { fake: 'in-process clamd protocol double', maxBytes: MAX, sizes: {}, bounds: {} },
  documentIntelligenceClient: { fake: 'in-process document-intelligence.v1 worker double', sizes: {}, bounds: {} },
};

try {
  let current;
  const makeScanner = (port, over = {}) => new scanner.SecurityScannerProvider({
    engine: new scanner.ClamdEngine({ endpoint: { kind: 'tcp', host: '127.0.0.1', port }, maxBytes: MAX, connectTimeoutMs: 300, commandTimeoutMs: 600, maxAttempts: 1 }),
    source: { read: async () => ({ tenantId: 't1', content: current }) }, signer: scanner.hmacSha256Signer('bench-key', Buffer.alloc(32, 2)), scannerRef: 'synthetic-bench',
    pinnedEngineVersions: ['ClamAV 1.4.2'], maxBytes: MAX, maxDefinitionsAgeMs: 3 * 86_400_000, attestationTtlMs: 60_000, now: clock, ...over,
  });
  const reqFor = (b) => ({ documentId: 'd', version: 1, tenantId: 't1', checksum: { algorithm: 'SHA-256', value: sha(b) }, sizeBytes: b.length, mimeType: 'application/pdf' });

  for (const size of [1024, 64 * 1024, 1024 * 1024]) {
    current = payload(size);
    const provider = makeScanner(clamd.port);
    const req = reqFor(current);
    await provider.scan(req); // warm-up, excluded
    const lat = []; let clean = 0;
    for (let i = 0; i < iterations; i++) { const [ms, att] = await timeIt(() => provider.scan(req)); lat.push(ms); if (att.status === 'CLEAN') clean++; }
    result.scanner.sizes[`${size}B`] = { ...stats(lat), cleanVerdicts: clean };
  }

  current = payload(1024);
  const base = reqFor(current);
  const oversized = makeScanner(clamd.port, { maxBytes: 512 });
  const [oversizedMs, over] = await timeIt(() => oversized.scan(base));
  result.scanner.bounds.oversizedRejection = { reasonCode: over.reasonCode, ms: Math.round(oversizedMs * 1000) / 1000 };

  clamd.mode = 'hang';
  const hung = makeScanner(clamd.port, { scanTimeoutMs: 300 });
  const [hangMs, hungAtt] = await timeIt(() => hung.scan(base));
  result.scanner.bounds.hungEngine = { commandTimeoutMs: 600, scanTimeoutMs: 300, verdict: hungAtt.verdict, reasonCode: hungAtt.reasonCode, elapsedMs: Math.round(hangMs) };
  clamd.mode = 'normal';

  const busy = makeScanner(clamd.port, { maxConcurrentScans: 1, maxQueuedScans: 1 });
  clamd.mode = 'hang';
  const burst = await Promise.all(Array.from({ length: 6 }, () => busy.scan(base)));
  clamd.mode = 'normal';
  result.scanner.bounds.backpressure = { submitted: 6, maxConcurrentScans: 1, maxQueuedScans: 1, busyRejections: burst.filter((a) => a.reasonCode === 'SCANNER_BUSY').length };

  const deadEngine = makeScanner(await deadPort());
  const [downMs, downAtt] = await timeIt(() => deadEngine.scan(base));
  result.scanner.bounds.engineDown = { verdict: downAtt.verdict, reasonCode: downAtt.reasonCode, ms: Math.round(downMs * 1000) / 1000 };

  // DI client parse round trip.
  const client = new di.DocumentIntelligenceClient({ baseUrl: `http://127.0.0.1:${worker.port}`, defaultTimeoutMs: 2000 });
  await client.providers();
  for (const size of [1024, 256 * 1024]) {
    const bytes = new Uint8Array(payload(size));
    const parse = () => client.parse({ operationId: 'bench', providerRef: FAKE_DI.providerRef, mediaType: 'image/png', timeoutMs: 2000, limits: { maxPages: 1 }, bytes });
    await parse();
    const lat = [];
    for (let i = 0; i < iterations; i++) lat.push((await timeIt(parse))[0]);
    result.documentIntelligenceClient.sizes[`${size}B`] = stats(lat);
  }
  const [catMs] = await timeIt(() => client.providers());
  result.documentIntelligenceClient.bounds.providersMs = Math.round(catMs * 1000) / 1000;

  worker.mode = 'hang';
  const tight = new di.DocumentIntelligenceClient({ baseUrl: `http://127.0.0.1:${worker.port}`, defaultTimeoutMs: 300 });
  const [dhMs, dhErr] = await timeIt(() => tight.providers().catch((e) => e));
  result.documentIntelligenceClient.bounds.hungWorker = { defaultTimeoutMs: 300, errorCode: dhErr.code, elapsedMs: Math.round(dhMs) };
  worker.mode = 'normal';

  const capped = new di.DocumentIntelligenceClient({ baseUrl: `http://127.0.0.1:${worker.port}`, defaultTimeoutMs: 1000, maxResponseBytes: 256 });
  const [capMs, capErr] = await timeIt(() => capped.providers().catch((e) => e));
  result.documentIntelligenceClient.bounds.oversizedResponse = { maxResponseBytes: 256, errorCode: capErr.code, ms: Math.round(capMs * 1000) / 1000 };

  const tooBig = new di.DocumentIntelligenceClient({ baseUrl: `http://127.0.0.1:${worker.port}`, maxUploadBytes: 1024 });
  const [ubMs, ubErr] = await timeIt(() => tooBig.parse({ operationId: 'b', providerRef: FAKE_DI.providerRef, mediaType: 'image/png', timeoutMs: 1000, limits: {}, bytes: new Uint8Array(2048) }).catch((e) => e));
  result.documentIntelligenceClient.bounds.oversizedUpload = { maxUploadBytes: 1024, errorCode: ubErr.code, ms: Math.round(ubMs * 1000) / 1000 };
} finally {
  await clamd.close();
  await worker.close();
}

const json = `${JSON.stringify(result, null, 2)}\n`;
if (outFile) writeFileSync(outFile, json);
else process.stdout.write(json);
