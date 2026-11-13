import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  ClamdEngine,
  SecurityScannerProvider,
  ScanEngineError,
  ed25519Signer,
  ed25519Verifier,
  hmacSha256Signer,
  parseVersion,
  verifyCleanAttestation,
  type AttestationSigner,
  type DocumentContentScanPort,
  type QuarantineSource,
  type SignedScanAttestation,
} from '../src/index.ts';
import { EICAR, startFakeClamd, type FakeClamd } from './fake-clamd.ts';
const pdf = (label: string) => Buffer.from(`%PDF-1.7 ${label}\n%%EOF\n`); // structurally valid PDF for CLEAN-path tests

const KEY = Buffer.alloc(32, 7); // test-only key material, generated here, never a product key
const T0 = new Date('2026-11-12T12:00:00Z');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function sourceOf(content: Uint8Array, tenantId = 'tenant-a'): QuarantineSource {
  return { read: async () => ({ tenantId, content }) };
}

describe('SecurityScannerProvider over a fake clamd', () => {
  let clamd: FakeClamd;
  let clock = T0;
  const signer = hmacSha256Signer('k1', KEY);

  beforeEach(async () => {
    clamd = await startFakeClamd();
    clock = T0;
  });
  afterEach(async () => clamd.close());

  function make(content: Uint8Array, over: Partial<ConstructorParameters<typeof SecurityScannerProvider>[0]> = {}, engineOpts = {}) {
    return new SecurityScannerProvider({
      engine: new ClamdEngine({ endpoint: clamd.endpoint, maxBytes: 1024 * 1024, commandTimeoutMs: 400, connectTimeoutMs: 400, retryBackoffMs: 1, ...engineOpts }),
      source: sourceOf(content),
      signer,
      scannerRef: 'media-security-scanner/clamav',
      pinnedEngineVersions: ['ClamAV 1.4.2'],
      maxBytes: 1024 * 1024,
      maxDefinitionsAgeMs: 3 * 24 * 3600_000,
      attestationTtlMs: 5 * 60_000,
      now: () => clock,
      ...over,
    });
  }
  const req = (content: Uint8Array, extra: Record<string, unknown> = {}) => ({
    documentId: 'doc-1', version: 1, tenantId: 'tenant-a',
    checksum: { algorithm: 'SHA-256' as const, value: sha(content) }, sizeBytes: content.byteLength, mimeType: 'application/pdf', ...extra,
  });
  // 2025-11-11 definitions; pin "now" within the freshness window
  beforeEach(() => { clock = new Date('2025-11-12T12:00:00Z'); });

  it('implements the Shared port shape and issues a signed CLEAN with exact digest + engine identity', async () => {
    const content = pdf('harmless');
    const port: DocumentContentScanPort = make(content);
    const att = (await port.scan(req(content))) as SignedScanAttestation;
    assert.equal(att.status, 'CLEAN');
    assert.equal(att.verdict, 'CLEAN');
    assert.equal(att.scannerRef, 'media-security-scanner/clamav');
    assert.equal(att.scannerVersion, 'ClamAV 1.4.2');
    assert.equal(att.checksum.value, sha(content));
    assert.equal(att.scannedDigest.value, sha(content));
    assert.equal(att.engine?.definitionsVersion, '27500');
    assert.equal(att.engine?.definitionsDate, '2025-11-11T08:30:12.000Z');
    const v = verifyCleanAttestation(att, [signer], { tenantId: 'tenant-a', checksum: att.checksum, sizeBytes: content.byteLength, now: clock, maxDefinitionsAgeMs: 3 * 24 * 3600_000 });
    assert.deepEqual(v.ok, true);
  });

  it('reports INFECTED for the EICAR test string (fake engine reply) and never CLEAN', async () => {
    const content = Buffer.from(`prefix ${EICAR} suffix`);
    const att = (await make(content).scan(req(content))) as SignedScanAttestation;
    assert.equal(att.status, 'INFECTED');
    assert.equal(att.signatureName, 'Eicar-Test-Signature');
    assert.equal(verifyCleanAttestation(att, [signer], { tenantId: 'tenant-a', checksum: att.checksum, now: clock }).ok, false);
  });

  it('timeout -> UNKNOWN (FAILED), bounded retry attempts', async () => {
    clamd.behavior = 'hang';
    const content = Buffer.from('x');
    const att = (await make(content, {}, { maxAttempts: 2, commandTimeoutMs: 100 }).scan(req(content))) as SignedScanAttestation;
    assert.equal(att.verdict, 'UNKNOWN');
    assert.equal(att.status, 'FAILED');
    assert.equal(att.reasonCode, 'ENGINE_UNAVAILABLE' === att.reasonCode ? att.reasonCode : 'ENGINE_TIMEOUT');
    assert.equal(att.reasonCode, 'ENGINE_TIMEOUT');
    assert.ok(clamd.connections <= 2 * 2 + 1, 'identity+scan, each at most maxAttempts');
  });

  it('connection drop mid-stream and before reply -> UNKNOWN, retried then given up', async () => {
    const content = Buffer.alloc(300_000, 1);
    for (const behavior of ['drop-mid-stream', 'drop-before-reply'] as const) {
      clamd.behavior = behavior;
      clamd.connections = 0;
      const att = (await make(content, {}, { maxAttempts: 3 }).scanSigned(req(content)));
      assert.equal(att.verdict, 'UNKNOWN', behavior);
      assert.match(att.reasonCode, /ENGINE_CONNECTION_DROPPED|ENGINE_UNAVAILABLE/u, behavior);
    }
  });

  it('crash then recovery: a retry after a dropped first connection can still return CLEAN', async () => {
    const content = pdf('hello');
    const engine = new ClamdEngine({ endpoint: clamd.endpoint, maxBytes: 1024, retryBackoffMs: 1, maxAttempts: 3 });
    clamd.dropNext = 2;
    const outcome = await engine.scan(content);
    assert.equal(outcome.kind, 'CLEAN');
  });

  it('oversized: request, source bytes and engine limits all yield UNKNOWN/OVERSIZED without CLEAN', async () => {
    const big = Buffer.alloc(2048, 2);
    const a = await make(big, { maxBytes: 1024 }).scanSigned(req(big));
    assert.equal(a.reasonCode, 'OVERSIZED');
    // Source returns more than declared bound even though request claimed small.
    const b = await make(big, { maxBytes: 1024 }).scanSigned(req(big, { sizeBytes: 10 }));
    assert.equal(b.reasonCode, 'OVERSIZED');
    // Engine-level client bound.
    await assert.rejects(new ClamdEngine({ endpoint: clamd.endpoint, maxBytes: 1024 }).scan(big), (e: ScanEngineError) => e.code === 'OVERSIZED');
    // clamd StreamMaxLength reply.
    clamd.behavior = 'size-limit';
    const c = await make(Buffer.from('abc')).scanSigned(req(Buffer.from('abc')));
    assert.equal(c.reasonCode, 'OVERSIZED');
    assert.equal(c.verdict, 'UNKNOWN');
  });

  it('digest mismatch (bytes changed after quarantine request) -> UNKNOWN/DIGEST_MISMATCH, never CLEAN', async () => {
    const original = Buffer.from('original');
    const swapped = Buffer.from('swapped!');
    const att = await make(swapped).scanSigned(req(original, { sizeBytes: swapped.byteLength }));
    assert.equal(att.reasonCode, 'DIGEST_MISMATCH');
    assert.equal(att.verdict, 'UNKNOWN');
    assert.equal(att.scannedDigest.value, sha(swapped));
    assert.equal(att.checksum.value, sha(original));
    assert.equal(clamd.streams, 0, 'engine is not consulted for bytes that do not match the digest');
  });

  it('size mismatch is UNKNOWN', async () => {
    const content = Buffer.from('abcdef');
    const att = await make(content).scanSigned(req(content, { sizeBytes: 3 }));
    assert.equal(att.reasonCode, 'SIZE_MISMATCH');
  });

  it('wrong tenant: source belongs to another tenant, or tenant missing -> UNKNOWN', async () => {
    const content = Buffer.from('tenant-bytes');
    const p = make(content, { source: sourceOf(content, 'tenant-b') });
    assert.equal((await p.scanSigned(req(content))).reasonCode, 'TENANT_MISMATCH');
    assert.equal((await make(content).scanSigned(req(content, { tenantId: undefined }))).reasonCode, 'INVALID_REQUEST');
  });

  it('source unavailable or absent -> UNKNOWN', async () => {
    const content = Buffer.from('x');
    assert.equal((await make(content, { source: { read: async () => { throw new Error('boom'); } } }).scanSigned(req(content))).reasonCode, 'SOURCE_UNAVAILABLE');
    assert.equal((await make(content, { source: { read: async () => undefined } }).scanSigned(req(content))).reasonCode, 'SOURCE_UNAVAILABLE');
  });

  it('ambiguous engine replies -> UNKNOWN', async () => {
    clamd.behavior = 'garbage';
    const content = Buffer.from('x');
    const att = await make(content).scanSigned(req(content));
    assert.equal(att.verdict, 'UNKNOWN');
    assert.equal(att.reasonCode, 'ENGINE_PROTOCOL_AMBIGUOUS');
  });

  it('unpinned engine version and stale or unknown definitions cannot produce CLEAN', async () => {
    const content = pdf('x');
    clamd.version = 'ClamAV 1.9.9/27500/Tue Nov 11 08:30:12 2025';
    assert.equal((await make(content).scanSigned(req(content))).reasonCode, 'ENGINE_VERSION_NOT_PINNED');
    clamd.version = 'ClamAV 1.4.2/27500/Tue Nov 11 08:30:12 2025';
    clock = new Date('2025-11-20T00:00:00Z'); // 9 days later
    assert.equal((await make(content).scanSigned(req(content))).reasonCode, 'DEFINITIONS_STALE');
    clamd.version = 'ClamAV 1.4.2';
    clock = new Date('2025-11-12T12:00:00Z');
    assert.equal((await make(content).scanSigned(req(content))).reasonCode, 'DEFINITIONS_UNKNOWN');
    assert.equal((await make(content, { pinnedEngineVersions: [] }).scanSigned(req(content))).verdict, 'UNKNOWN');
  });

  it('infected is reported even when the engine is unpinned or stale', async () => {
    clamd.version = 'ClamAV 1.9.9/1/Mon Jan 01 00:00:00 2024';
    const content = Buffer.from(EICAR);
    assert.equal((await make(content).scanSigned(req(content))).verdict, 'INFECTED');
  });

  it('engine unavailable (nothing listening) -> UNKNOWN', async () => {
    const content = Buffer.from('x');
    await clamd.close();
    const att = await make(content, {}, { maxAttempts: 2 }).scanSigned(req(content));
    assert.equal(att.verdict, 'UNKNOWN');
    assert.equal(att.reasonCode, 'ENGINE_UNAVAILABLE');
    clamd = await startFakeClamd(); // for afterEach
  });

  it('bounded concurrency: excess queued scans fail closed with SCANNER_BUSY', async () => {
    clamd.behavior = 'hang';
    const content = Buffer.from('x');
    const p = make(content, { maxConcurrentScans: 1, maxQueuedScans: 0 }, { commandTimeoutMs: 150, maxAttempts: 1 });
    const [first, second] = await Promise.all([p.scanSigned(req(content)), p.scanSigned(req(content))]);
    const reasons = [first.reasonCode, second.reasonCode].sort();
    assert.ok(reasons.includes('SCANNER_BUSY'), reasons.join());
    assert.ok(reasons.includes('ENGINE_TIMEOUT'), reasons.join());
  });

  it('works over a unix socket', async () => {
    await clamd.close();
    clamd = await startFakeClamd({ unix: true });
    const content = pdf('unix');
    assert.equal((await make(content).scanSigned(req(content))).verdict, 'CLEAN');
  });
});

describe('attestation verification', () => {
  let clamd: FakeClamd;
  const signer = hmacSha256Signer('k1', KEY);
  const now = new Date('2025-11-12T12:00:00Z');
  beforeEach(async () => { clamd = await startFakeClamd(); });
  afterEach(async () => clamd.close());

  async function clean(content = pdf('doc'), ttl = 60_000, s: AttestationSigner = signer) {
    const p = new SecurityScannerProvider({
      engine: new ClamdEngine({ endpoint: clamd.endpoint, maxBytes: 4096 }),
      source: sourceOf(content), signer: s, scannerRef: 'scanner', pinnedEngineVersions: ['ClamAV 1.4.2'],
      maxBytes: 4096, maxDefinitionsAgeMs: 86_400_000 * 3, attestationTtlMs: ttl, now: () => now,
    });
    return p.scanSigned({ documentId: 'd', version: 1, tenantId: 'tenant-a', checksum: { algorithm: 'SHA-256', value: sha(content) }, sizeBytes: content.byteLength, mimeType: 'application/pdf' });
  }
  const exp = (att: SignedScanAttestation, over = {}) => ({ tenantId: 'tenant-a', checksum: att.checksum, now, ...over });

  it('accepts only exact, unexpired, signed CLEAN', async () => {
    const att = await clean();
    assert.equal(verifyCleanAttestation(att, [signer], exp(att)).ok, true);
  });
  it('rejects unsigned and tampered attestations', async () => {
    const att = await clean();
    const { attestation: _a, ...unsigned } = att;
    assert.deepEqual(verifyCleanAttestation(unsigned as unknown as SignedScanAttestation, [signer], exp(att)), { ok: false, reason: 'UNSIGNED' });
    assert.deepEqual(verifyCleanAttestation(undefined, [signer], exp(att)), { ok: false, reason: 'UNSIGNED' });
    const flipped = { ...att, verdict: 'CLEAN' as const, scannedSizeBytes: att.scannedSizeBytes + 1 };
    assert.deepEqual(verifyCleanAttestation(flipped, [signer], exp(att)), { ok: false, reason: 'BAD_SIGNATURE' });
    const otherKey = hmacSha256Signer('k1', Buffer.alloc(32, 9));
    assert.deepEqual(verifyCleanAttestation(att, [otherKey], exp(att)), { ok: false, reason: 'BAD_SIGNATURE' });
    assert.deepEqual(verifyCleanAttestation(att, [hmacSha256Signer('other', KEY)], exp(att)), { ok: false, reason: 'UNKNOWN_KEY' });
  });
  it('rejects expired results and results from the future', async () => {
    const att = await clean(undefined, 1_000);
    assert.deepEqual(verifyCleanAttestation(att, [signer], exp(att, { now: new Date(now.getTime() + 1_000) })), { ok: false, reason: 'EXPIRED' });
    assert.deepEqual(verifyCleanAttestation(att, [signer], exp(att, { now: new Date(now.getTime() - 60_000) })), { ok: false, reason: 'NOT_YET_VALID' });
  });
  it('rejects wrong tenant, digest, size, scanner, and stale definitions at verification time', async () => {
    const att = await clean();
    assert.equal((verifyCleanAttestation(att, [signer], exp(att, { tenantId: 'tenant-b' })) as { reason: string }).reason, 'TENANT_MISMATCH');
    assert.equal((verifyCleanAttestation(att, [signer], exp(att, { checksum: { algorithm: 'SHA-256', value: 'b'.repeat(64) } })) as { reason: string }).reason, 'DIGEST_MISMATCH');
    assert.equal((verifyCleanAttestation(att, [signer], exp(att, { sizeBytes: 999 })) as { reason: string }).reason, 'SIZE_MISMATCH');
    assert.equal((verifyCleanAttestation(att, [signer], exp(att, { scannerRef: 'other' })) as { reason: string }).reason, 'SCANNER_MISMATCH');
    assert.equal((verifyCleanAttestation(att, [signer], exp(att, { documentVersion: 2 })) as { reason: string }).reason, 'DOCUMENT_MISMATCH');
    assert.equal((verifyCleanAttestation(att, [signer], exp(att, { maxDefinitionsAgeMs: 1000 })) as { reason: string }).reason, 'DEFINITIONS_STALE');
  });
  it('INFECTED/UNKNOWN attestations never verify as CLEAN', async () => {
    clamd.behavior = 'garbage';
    const att = await clean();
    assert.equal((verifyCleanAttestation(att, [signer], exp(att)) as { reason: string }).reason, 'NOT_CLEAN');
  });
  it('supports Ed25519 injected keys', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const att = await clean(pdf('doc'), 60_000, ed25519Signer('ed1', privateKey));
    assert.equal(att.attestation.algorithm, 'Ed25519');
    assert.equal(verifyCleanAttestation(att, [ed25519Verifier('ed1', publicKey)], exp(att)).ok, true);
    const { publicKey: other } = generateKeyPairSync('ed25519');
    assert.equal(verifyCleanAttestation(att, [ed25519Verifier('ed1', other)], exp(att)).ok, false);
  });
  it('refuses weak HMAC keys (no hardcoded or short keys)', () => {
    assert.throws(() => hmacSha256Signer('k', Buffer.alloc(8)), RangeError);
  });
});

describe('clamd reply parsing', () => {
  it('parses version/definitions and rejects anything else', () => {
    const v = parseVersion('ClamAV 1.4.2/27500/Tue Nov 11 08:30:12 2025');
    assert.equal(v.version, 'ClamAV 1.4.2');
    assert.equal(v.definitionsDate?.toISOString(), '2025-11-11T08:30:12.000Z');
    assert.throws(() => parseVersion('SomethingElse 1'), ScanEngineError);
  });
});
