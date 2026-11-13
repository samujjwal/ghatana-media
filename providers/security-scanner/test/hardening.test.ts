// MED-06 hardening: key-rotation-capable async signer (KMS external), test-only key labelling, decompression limits,
// per-principal rate limit, and "no release on outage" through the HTTP service.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  ClamdEngine, FilesystemQuarantineSource, ScannerHttpService, SecurityScannerProvider, SignerUnavailableError,
  bearerTokenAuthenticator, inspectStructure, rotatingSigner, signAttestation, signAttestationAsync, testOnlyEd25519Signer,
  hmacSha256Signer, type AttestationSigner, type ScanEngine,
} from '../src/index.ts';
import { startFakeClamd, type FakeClamd } from './fake-clamd.ts';

const pdf = (l: string) => Buffer.from(`%PDF-1.7 ${l}\n%%EOF\n`);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const t = (s: string) => new Date(s);

describe('signer: rotation, async KMS-style signing, test-only key', () => {
  const k1 = hmacSha256Signer('key-1', Buffer.alloc(32, 1)), k2 = hmacSha256Signer('key-2', Buffer.alloc(32, 2));
  const ring = rotatingSigner([
    { signer: k1, notBefore: t('2026-01-01T00:00:00Z'), notAfter: t('2026-07-01T00:00:00Z') },
    { signer: k2, notBefore: t('2026-06-01T00:00:00Z') },
  ]);
  it('picks the latest-notBefore key valid at the time; none valid => SignerUnavailableError (no fallback)', async () => {
    assert.equal((await ring.resolve(t('2026-03-01T00:00:00Z'))).keyId, 'key-1');
    assert.equal((await ring.resolve(t('2026-06-15T00:00:00Z'))).keyId, 'key-2'); // overlap: newest signs
    assert.equal((await ring.resolve(t('2026-09-01T00:00:00Z'))).keyId, 'key-2'); // key-1 expired
    assert.throws(() => ring.resolve(t('2025-12-31T00:00:00Z')), SignerUnavailableError);
    assert.throws(() => rotatingSigner([]), RangeError);
    assert.throws(() => rotatingSigner([{ signer: k1, notBefore: t('2026-01-01T00:00:00Z') }, { signer: k1, notBefore: t('2026-02-01T00:00:00Z') }]), RangeError);
  });
  it('async (remote KMS-like) signers work through signAttestationAsync; the sync API refuses them', async () => {
    const remote: AttestationSigner = { algorithm: 'HMAC-SHA256', keyId: 'kms-1', sign: async (p) => k1.sign(p) as Uint8Array };
    const unsigned = { scannerRef: 's' } as never;
    assert.throws(() => signAttestation(unsigned, remote), /signAttestationAsync/);
    assert.equal((await signAttestationAsync(unsigned, remote)).attestation.keyId, 'kms-1');
  });
  it('provider signs with the rotated key; a key outage throws instead of emitting an unsigned/CLEAN result', async () => {
    const content = pdf('rot');
    const engine: ScanEngine = { identity: async () => ({ name: 'ClamAV', version: 'ClamAV 1.5.4', definitionsDate: t('2026-06-20T00:00:00Z') }), scan: async () => ({ kind: 'CLEAN' }) };
    const mk = (at: string) => new SecurityScannerProvider({ engine, source: { read: async () => ({ tenantId: 't', content }) }, signer: ring, scannerRef: 's',
      pinnedEngineVersions: ['ClamAV 1.5.4'], maxBytes: 1 << 20, maxDefinitionsAgeMs: 30 * 86_400_000, attestationTtlMs: 60_000, now: () => t(at) });
    const req = { documentId: 'd', version: 1, tenantId: 't', checksum: { algorithm: 'SHA-256' as const, value: sha(content) }, sizeBytes: content.length, mimeType: 'application/pdf' };
    const a = await mk('2026-06-21T00:00:00Z').scanSigned(req);
    assert.equal(a.verdict, 'CLEAN'); assert.equal(a.attestation.keyId, 'key-2'); assert.match(a.finality!.signatureRef!, /key-2/);
    await assert.rejects(mk('2025-01-01T00:00:00Z').scanSigned(req), SignerUnavailableError);
  });
  it('test-only signer is labelled, deterministic and forbidden in production', () => {
    const a = testOnlyEd25519Signer('x'), b = testOnlyEd25519Signer('x');
    assert.match(a.keyId, /^TEST-ONLY-/u); assert.deepEqual(Buffer.from(a.sign(Buffer.from('m')) as Uint8Array), Buffer.from(b.sign(Buffer.from('m')) as Uint8Array));
    const prev = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
    try { assert.throws(() => testOnlyEd25519Signer('x'), /forbidden in production/); } finally { if (prev === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev; }
  });
});

function zipDeflated(name: string, data: Buffer) {
  const n = Buffer.from(name), c = crc32(data) >>> 0, z = deflateRawSync(data);
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(c, 14); lh.writeUInt32LE(z.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
  const ce = Buffer.alloc(46); ce.writeUInt32LE(0x02014b50, 0); ce.writeUInt16LE(20, 4); ce.writeUInt16LE(20, 6); ce.writeUInt16LE(8, 10); ce.writeUInt32LE(c, 16); ce.writeUInt32LE(z.length, 20); ce.writeUInt32LE(data.length, 24); ce.writeUInt16LE(n.length, 28);
  const body = Buffer.concat([lh, n, z]); const cd = Buffer.concat([ce, n]);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, cd, end]);
}
const TEXT = Buffer.from(Array.from({ length: 400 }, (_, i) => `word${(i * 7919) % 1009} `).join('')); // ordinary text, ratio far below 100
describe('decompression limits', () => {
  it('high-ratio and over-budget archives are REJECTED, ordinary compressible text is not', () => {
    const r = (b: Buffer, o = {}) => { const x = inspectStructure(b, 'application/zip', o); return x.kind === 'OK' ? 'OK' : `${x.kind}:${x.reason}`; };
    assert.equal(r(zipDeflated('bomb.bin', Buffer.alloc(8 * 1024 * 1024))), 'REJECTED:STRUCTURE_DECOMPRESSION_LIMIT'); // ratio ~1000
    assert.equal(r(zipDeflated('ok.txt', TEXT)), 'OK'); // ratio < 100
    assert.equal(r(zipDeflated('ok.txt', TEXT), { maxTotalInflatedBytes: 1000 }), 'REJECTED:STRUCTURE_DECOMPRESSION_LIMIT');
    assert.equal(r(zipDeflated('ok.txt', TEXT), { maxCompressionRatio: 2 }), 'REJECTED:STRUCTURE_DECOMPRESSION_LIMIT');
  });
});

describe('service: rate limit and no release on outage', () => {
  const TOKEN = 'a'.repeat(40);
  let clamd: FakeClamd, root: string, service: ScannerHttpService, base: string;
  const content = pdf('svc');
  const body = { tenantId: 'tenant-a', documentId: 'doc', version: 1, objectRef: 'obj-1', checksum: { algorithm: 'SHA-256', value: sha(content) }, sizeBytes: content.length, mimeType: 'application/pdf' };
  const post = async () => { const r = await fetch(`${base}/v1/scans`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: (await r.json()) as any }; };
  const done = async (id: string) => { for (let i = 0; i < 100; i++) { const r = await (await fetch(`${base}/v1/scans/${id}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as any; if (r.state === 'COMPLETED' || r.state === 'CANCELLED') return r; await new Promise((x) => setTimeout(x, 20)); } throw new Error('timeout'); };
  beforeEach(async () => {
    clamd = await startFakeClamd(); root = mkdtempSync(path.join(tmpdir(), 'scanner-hard-'));
    mkdirSync(path.join(root, 'tenant-a'), { recursive: true }); writeFileSync(path.join(root, 'tenant-a', 'obj-1'), content);
    const engine = new ClamdEngine({ endpoint: clamd.endpoint, maxBytes: 1 << 20, commandTimeoutMs: 300, connectTimeoutMs: 300, maxAttempts: 1 });
    const provider = new SecurityScannerProvider({ engine, source: new FilesystemQuarantineSource(root), signer: hmacSha256Signer('k', Buffer.alloc(32, 3)), scannerRef: 's',
      pinnedEngineVersions: ['ClamAV 1.4.2'], maxBytes: 1 << 20, maxDefinitionsAgeMs: 86_400_000 * 3, attestationTtlMs: 60_000, now: () => t('2025-11-12T12:00:00Z') });
    service = new ScannerHttpService({ provider, engine, pinnedEngineVersions: ['ClamAV 1.4.2'], maxDefinitionsAgeMs: 86_400_000 * 3, now: () => t('2025-11-12T12:00:00Z'),
      maxSubmitsPerWindow: 3, rateWindowMs: 60_000, authenticate: bearerTokenAuthenticator([{ token: TOKEN, principalId: 'p', tenantIds: ['tenant-a'] }]) });
    const { host, port } = await service.listen(0); base = `http://${host}:${port}`;
  });
  afterEach(async () => { await service.close(); await clamd.close(); rmSync(root, { recursive: true, force: true }); });
  it('per-principal submit rate limit => 429 RATE_LIMITED', async () => {
    for (let i = 0; i < 3; i++) assert.equal((await post()).status, 202);
    const r = await post(); assert.equal(r.status, 429); assert.equal(r.body.code ?? r.body.error?.code, 'RATE_LIMITED');
  });
  it('engine outage and quarantine-object outage both finish non-CLEAN (never released)', async () => {
    await clamd.close(); // engine down
    const a = await post(); const ra = await done(a.body.scanId ?? a.body.id);
    assert.notEqual(ra.attestation?.verdict, 'CLEAN'); assert.equal(ra.attestation?.verdict, 'UNKNOWN');
    rmSync(path.join(root, 'tenant-a', 'obj-1')); // quarantine object gone
    const b = await post(); const rb = await done(b.body.scanId ?? b.body.id);
    assert.equal(rb.attestation?.verdict, 'UNKNOWN'); assert.equal(rb.attestation?.reasonCode, 'SOURCE_UNAVAILABLE');
  });
});
