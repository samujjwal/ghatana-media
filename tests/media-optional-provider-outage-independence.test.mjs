// MED-09(b): DI outage and scanner outage must not disable unrelated Media services.
// Synthetic fakes only (fake clamd, fake DI worker); runs the real DI TS client, scanner provider and Media's
// scene-text adapter. Not qualification evidence.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { FAKE_DI, buildPackage, deadPort, diClientDir, repoRoot, scannerDir, startFakeClamd, startFakeDiWorker } from '../scripts/optional-providers/support.mjs';

const mediaClientDist = path.join(repoRoot, 'libs/audio-video-client/dist/index.js');
const importDist = (dir) => import(pathToFileURL(path.join(dir, 'dist/index.js')).href);

let scanner; let di; let media;
let clamd; let worker;
const policy = {
  providerRef: FAKE_DI.providerRef, providerVersion: FAKE_DI.providerVersion, modelRef: FAKE_DI.modelRef, modelVersion: FAKE_DI.modelVersion,
  acceptedMediaTypes: ['image/png'], acceptedLanguages: ['en-US'], timeoutMs: 1500, workerLimits: { maxPages: 1 },
};
const frame = { sourceArtifactId: 'artifact-1', sourceVersion: 'v1', frameId: 'f-1', timestampUs: 1, mediaType: 'image/png', bytes: new Uint8Array([1, 2, 3]), languageHint: 'en-US' };
const content = Buffer.from('unrelated upload bytes');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const clock = () => new Date('2025-11-12T12:00:00Z');

const makeScanner = (port) => new scanner.SecurityScannerProvider({
  engine: new scanner.ClamdEngine({ endpoint: { kind: 'tcp', host: '127.0.0.1', port }, maxBytes: 1 << 20, connectTimeoutMs: 300, commandTimeoutMs: 400, maxAttempts: 1 }),
  source: { read: async () => ({ tenantId: 't1', content }) }, signer: scanner.hmacSha256Signer('k', Buffer.alloc(32, 1)), scannerRef: 'outage-test',
  pinnedEngineVersions: ['ClamAV 1.4.2'], maxBytes: 1 << 20, maxDefinitionsAgeMs: 3 * 86_400_000, attestationTtlMs: 60_000, now: clock,
});
const scanReq = { documentId: 'd', version: 1, tenantId: 't1', checksum: { algorithm: 'SHA-256', value: sha(content) }, sizeBytes: content.length, mimeType: 'application/pdf' };
const sceneText = (port) => new media.DocumentIntelligenceSceneTextAdapter(
  new di.DocumentIntelligenceClient({ baseUrl: `http://127.0.0.1:${port}`, defaultTimeoutMs: 400 }), policy);

// The unrelated services: Media upload content-type admission, and the scanner / DI independently.
let upload;
const uploadAdmission = () => upload.isCanonicalMediaContentType('video/mp4');

before(async () => {
  buildPackage(scannerDir);
  buildPackage(diClientDir);
  scanner = await importDist(scannerDir);
  di = await importDist(diClientDir);
  if (existsSync(mediaClientDist)) {
    media = await import(pathToFileURL(mediaClientDist).href);
    upload = await import(pathToFileURL(path.join(repoRoot, 'libs/audio-video-client/dist/upload-validation.js')).href);
  }
  clamd = await startFakeClamd();
  worker = await startFakeDiWorker();
});
after(async () => { await clamd.close(); await worker.close(); });
afterEach(() => { worker.mode = 'normal'; clamd.mode = 'normal'; });

describe('DI outage is OCR-only', { skip: !existsSync(mediaClientDist) && '@audio-video/client dist not built' }, () => {
  it('control: healthy fake DI yields scene-text observations', async () => {
    const out = await sceneText(worker.port).recognizeFrame('op-ok', frame);
    assert.equal(out.length, 1);
    assert.equal(out[0].text, 'Exit 42');
  });

  it('DI down / hung / garbage: scene-text degrades to typed PROVIDER_CATALOG_UNAVAILABLE (never a result, never a hang)', async () => {
    const dead = await deadPort();
    await assert.rejects(sceneText(dead).recognizeFrame('op-down', frame), { name: 'SceneTextAdapterError', code: 'PROVIDER_CATALOG_UNAVAILABLE' });
    worker.mode = 'hang';
    const started = Date.now();
    await assert.rejects(sceneText(worker.port).recognizeFrame('op-hang', frame), { code: 'PROVIDER_CATALOG_UNAVAILABLE' });
    assert.ok(Date.now() - started < 3000, 'bounded by the client timeout');
    worker.mode = 'garbage';
    await assert.rejects(sceneText(worker.port).recognizeFrame('op-garbage', frame), { code: 'PROVIDER_CATALOG_UNAVAILABLE' });
    worker.mode = 'normal';
  });

  it('DI vanishing after discovery is OUTCOME_UNKNOWN (not unavailable, not success)', async () => {
    const adapter = new media.DocumentIntelligenceSceneTextAdapter({
      lastProtocolVersion: 'document-intelligence.v1', lastWorkerCapabilityVersion: 'document-intelligence-worker.v1',
      providers: async () => ({ protocolVersion: 'document-intelligence.v1', workerCapabilityVersion: 'document-intelligence-worker.v1',
        providers: [{ ...FAKE_DI, mediaTypes: ['image/png'], supportedLanguages: ['en-US'], promotionStatus: 'ACCEPTED', loaded: true, ready: true }] }),
      parse: async () => { throw new Error('connection reset'); },
    }, policy);
    await assert.rejects(adapter.recognizeFrame('op-lost', frame), { code: 'OUTCOME_UNKNOWN' });
  });

  it('with DI down, unrelated Media services keep working: upload admission and the scanner', async () => {
    worker.mode = 'hang';
    assert.equal(uploadAdmission(), true);
    assert.equal(upload.isCanonicalMediaContentType('not a type'), false);
    const att = await makeScanner(clamd.port).scan(scanReq);
    assert.equal(att.status, 'CLEAN');
    worker.mode = 'normal';
  });
});

describe('scanner outage is scan-only', () => {
  it('scanner down / hung: UNKNOWN (FAILED), never CLEAN, never throws', async () => {
    const dead = await deadPort();
    const down = await makeScanner(dead).scan(scanReq);
    assert.equal(down.status, 'FAILED');
    assert.equal(down.verdict, 'UNKNOWN');
    clamd.mode = 'hang';
    const hung = await makeScanner(clamd.port).scan(scanReq);
    assert.equal(hung.verdict, 'UNKNOWN');
    assert.equal(hung.reasonCode, 'ENGINE_TIMEOUT');
    clamd.mode = 'normal';
  });

  it('with the scanner down, DI parse and upload admission are unaffected', async () => {
    const dead = await deadPort();
    assert.equal((await makeScanner(dead).scan(scanReq)).verdict, 'UNKNOWN');
    const client = new di.DocumentIntelligenceClient({ baseUrl: `http://127.0.0.1:${worker.port}`, defaultTimeoutMs: 1000 });
    const parsed = await client.parse({ operationId: 'op-ind', providerRef: FAKE_DI.providerRef, mediaType: 'image/png', timeoutMs: 1000, limits: { maxPages: 1 }, bytes: new Uint8Array([1]) });
    assert.equal(parsed.operationId, 'op-ind');
    if (media) assert.equal(uploadAdmission(), true);
  });

  it('both providers down at once: each fails independently and typed; no cross-coupling', async () => {
    const [d1, d2] = [await deadPort(), await deadPort()];
    const results = await Promise.allSettled([
      makeScanner(d1).scan(scanReq),
      new di.DocumentIntelligenceClient({ baseUrl: `http://127.0.0.1:${d2}`, defaultTimeoutMs: 300 }).providers(),
    ]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[0].value.verdict, 'UNKNOWN');
    assert.equal(results[1].status, 'rejected');
    assert.equal(results[1].reason.name, 'DocumentExtractionError');
    if (media) assert.equal(uploadAdmission(), true);
  });
});

describe('STT/upload independence is structural (no DI or scanner dependency)', () => {
  it('speech and runtime-contracts sources never import the DI client or the scanner provider', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const bad = [];
    const walk = (dir) => {
      if (!existsSync(dir)) return;
      for (const e of readdirSync(dir)) {
        if (['node_modules', 'build', 'dist', '.gradle'].includes(e)) continue;
        const p = path.join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(java|ts|kts)$/u.test(e) && /^\s*(import|implementation|api)\b.*(documentintelligence|document-intelligence|security-scanner)/imu.test(readFileSync(p, 'utf8'))) bad.push(p.slice(repoRoot.length + 1));
      }
    };
    for (const d of ['modules/speech', 'runtime-contracts/src/main']) walk(path.join(repoRoot, d));
    assert.deepEqual(bad, []);
  });
});
