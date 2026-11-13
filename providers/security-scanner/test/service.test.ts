import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  ClamdEngine, FilesystemQuarantineSource, ScannerHttpService, SecurityScannerProvider,
  bearerTokenAuthenticator, hmacSha256Signer, verifyCleanAttestation,
  type SignedScanAttestation,
} from '../src/index.ts';
import { EICAR, startFakeClamd, type FakeClamd } from './fake-clamd.ts';
const pdf = (label: string) => Buffer.from(`%PDF-1.7 ${label}\n%%EOF\n`); // structurally valid PDF for CLEAN-path tests

const TOKEN_A = 'a'.repeat(40);
const TOKEN_B = 'b'.repeat(40);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const clock = new Date('2025-11-12T12:00:00Z');
const signer = hmacSha256Signer('svc-key', Buffer.alloc(32, 9));

describe('scanner HTTP service (fake clamd)', () => {
  let clamd: FakeClamd;
  let root: string;
  let service: ScannerHttpService;
  let base: string;

  const put = (tenant: string, ref: string, content: Uint8Array) => {
    mkdirSync(path.join(root, tenant), { recursive: true });
    writeFileSync(path.join(root, tenant, ref), content);
  };
  const call = async (method: string, p: string, opts: { token?: string | null; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) => {
    const token = opts.token === undefined ? TOKEN_A : opts.token;
    const res = await fetch(base + p, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opts.body !== undefined || opts.raw !== undefined ? { 'content-type': 'application/json' } : {}), ...opts.headers },
      ...(opts.raw !== undefined ? { body: opts.raw } : opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const submitBody = (content: Uint8Array, over: Record<string, unknown> = {}) => ({
    tenantId: 'tenant-a', documentId: 'doc-1', version: 1, objectRef: 'obj-1',
    checksum: { algorithm: 'SHA-256', value: sha(content) }, sizeBytes: content.byteLength, mimeType: 'application/pdf', ...over,
  });
  const poll = async (id: string, token = TOKEN_A) => {
    for (let i = 0; i < 100; i++) {
      const r = await call('GET', `/v1/scans/${id}`, { token });
      if (r.body.state === 'COMPLETED' || r.body.state === 'CANCELLED') return r;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('scan did not finish');
  };

  beforeEach(async () => {
    clamd = await startFakeClamd();
    root = mkdtempSync(path.join(tmpdir(), 'scanner-svc-'));
    const engine = new ClamdEngine({ endpoint: clamd.endpoint, maxBytes: 1 << 20, commandTimeoutMs: 400, connectTimeoutMs: 400, maxAttempts: 1 });
    const provider = new SecurityScannerProvider({
      engine, source: new FilesystemQuarantineSource(root), signer, scannerRef: 'svc-scanner',
      pinnedEngineVersions: ['ClamAV 1.4.2'], maxBytes: 1 << 20, maxDefinitionsAgeMs: 3 * 86_400_000,
      attestationTtlMs: 60_000, now: () => clock, scanTimeoutMs: 2_000,
    });
    service = new ScannerHttpService({
      provider, engine, pinnedEngineVersions: ['ClamAV 1.4.2'], maxDefinitionsAgeMs: 3 * 86_400_000, now: () => clock,
      maxRequestBodyBytes: 2048, maxActiveScans: 2, healthTimeoutMs: 400,
      authenticate: bearerTokenAuthenticator([
        { token: TOKEN_A, principalId: 'kernel-a', tenantIds: ['tenant-a'] },
        { token: TOKEN_B, principalId: 'kernel-b', tenantIds: ['tenant-b'] },
      ]),
    });
    const { host, port } = await service.listen(0);
    base = `http://${host}:${port}`;
  });
  afterEach(async () => {
    await service.close();
    await clamd.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses to be constructed without an authentication hook', () => {
    assert.throws(() => new ScannerHttpService({ authenticate: undefined as never } as never), /authenticate hook is required/);
    assert.throws(() => bearerTokenAuthenticator([]), RangeError);
    assert.throws(() => bearerTokenAuthenticator([{ token: 'short', principalId: 'p', tenantIds: ['t'] }]), RangeError);
  });

  it('rejects missing, wrong and cross-scheme credentials on every /v1 route; /healthz is liveness only', async () => {
    for (const [m, p] of [['POST', '/v1/scans'], ['GET', '/v1/scans/x'], ['DELETE', '/v1/scans/x'], ['GET', '/v1/health']] as const) {
      assert.equal((await call(m, p, { token: null, raw: m === 'POST' ? '{}' : undefined })).status, 401, `${m} ${p} no token`);
      assert.equal((await call(m, p, { token: 'x'.repeat(40), raw: m === 'POST' ? '{}' : undefined })).status, 401, `${m} ${p} wrong token`);
    }
    assert.equal((await call('GET', '/v1/health', { token: null, headers: { authorization: `Basic ${TOKEN_A}` } })).status, 401);
    const live = await call('GET', '/healthz', { token: null });
    assert.deepEqual(live.body, { status: 'UP' });
  });

  it('submit -> status -> signed CLEAN attestation verifiable with the public-binding fields', async () => {
    const content = pdf('harmless');
    put('tenant-a', 'obj-1', content);
    const sub = await call('POST', '/v1/scans', { body: submitBody(content) });
    assert.equal(sub.status, 202);
    const done = await poll(sub.body.scanId);
    assert.equal(done.body.state, 'COMPLETED');
    const att = done.body.attestation as SignedScanAttestation;
    assert.equal(att.verdict, 'CLEAN');
    assert.equal(att.scannedDigest.value, sha(content));
    const v = verifyCleanAttestation(att, [signer], { tenantId: 'tenant-a', checksum: att.checksum, sizeBytes: content.length, now: clock });
    assert.equal(v.ok, true);
    const b = done.body.attestationBinding;
    assert.equal(b.keyId, 'svc-key');
    assert.equal(b.attestationRef, att.attestationRef);
    assert.match(b.payloadSha256, /^[a-f0-9]{64}$/);
  });

  it('reports INFECTED for EICAR and UNKNOWN (not CLEAN) on digest mismatch or missing object', async () => {
    const bad = Buffer.from(`x ${EICAR} y`);
    put('tenant-a', 'obj-1', bad);
    const inf = await poll((await call('POST', '/v1/scans', { body: submitBody(bad) })).body.scanId);
    assert.equal(inf.body.attestation.verdict, 'INFECTED');

    const ok = pdf('plain');
    put('tenant-a', 'obj-2', ok);
    const mism = await poll((await call('POST', '/v1/scans', { body: submitBody(ok, { objectRef: 'obj-2', checksum: { algorithm: 'SHA-256', value: 'f'.repeat(64) } }) })).body.scanId);
    assert.equal(mism.body.attestation.verdict, 'UNKNOWN');
    assert.equal(mism.body.attestation.reasonCode, 'DIGEST_MISMATCH');

    const missing = await poll((await call('POST', '/v1/scans', { body: submitBody(ok, { objectRef: 'nope' }) })).body.scanId);
    assert.equal(missing.body.attestation.reasonCode, 'SOURCE_UNAVAILABLE');
  });

  it('engine outage yields a signed UNKNOWN, never CLEAN, and health reports DEGRADED + NOT_ADMITTED', async () => {
    const content = pdf('some bytes');
    put('tenant-a', 'obj-1', content);
    await clamd.close();
    const r = await poll((await call('POST', '/v1/scans', { body: submitBody(content) })).body.scanId);
    assert.equal(r.body.attestation.verdict, 'UNKNOWN');
    const h = await call('GET', '/v1/health');
    assert.equal(h.status, 503);
    assert.equal(h.body.status, 'DEGRADED');
    assert.equal(h.body.admissionState, 'NOT_ADMITTED');
    assert.equal(h.body.engine, null);
    clamd = await startFakeClamd(); // so afterEach close() has something to close
  });

  it('health reports engine/definitions version and NOT_ADMITTED while the (fake) engine is ready', async () => {
    const h = await call('GET', '/v1/health');
    assert.equal(h.status, 200);
    assert.equal(h.body.engine.version, 'ClamAV 1.4.2');
    assert.equal(h.body.engine.definitionsVersion, '27500');
    assert.equal(h.body.enginePinned, true);
    assert.equal(h.body.definitionsFresh, true);
    assert.equal(h.body.admissionState, 'NOT_ADMITTED');
    assert.equal(h.body.productionEligible, false);
  });

  it('is bounded: oversized body 413, bad JSON/unknown field/bad shape 400, wrong content type 415, busy 429', async () => {
    assert.equal((await call('POST', '/v1/scans', { raw: JSON.stringify({ pad: 'x'.repeat(4000) }) })).status, 413);
    assert.equal((await call('POST', '/v1/scans', { raw: '{nope' })).status, 400);
    const content = Buffer.from('b');
    assert.equal((await call('POST', '/v1/scans', { body: { ...submitBody(content), extra: 1 } })).status, 400);
    assert.equal((await call('POST', '/v1/scans', { body: submitBody(content, { objectRef: '../etc/passwd' }) })).status, 400);
    assert.equal((await call('POST', '/v1/scans', { body: submitBody(content, { checksum: { algorithm: 'MD5', value: 'a' } }) })).status, 400);
    const ct = await fetch(`${base}/v1/scans`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'text/plain' }, body: 'x' });
    assert.equal(ct.status, 415);
    clamd.behavior = 'hang';
    put('tenant-a', 'obj-1', content);
    const s1 = await call('POST', '/v1/scans', { body: submitBody(content) });
    const s2 = await call('POST', '/v1/scans', { body: submitBody(content) });
    assert.equal(s1.status, 202);
    assert.equal(s2.status, 202);
    assert.equal((await call('POST', '/v1/scans', { body: submitBody(content) })).status, 429);
    await call('DELETE', `/v1/scans/${s1.body.scanId}`);
    await call('DELETE', `/v1/scans/${s2.body.scanId}`);
  });

  it('cancel stops a hung scan, is idempotent, and a cancelled scan never exposes an attestation', async () => {
    const content = Buffer.from('slow');
    put('tenant-a', 'obj-1', content);
    clamd.behavior = 'hang';
    const sub = await call('POST', '/v1/scans', { body: submitBody(content) });
    const del = await call('DELETE', `/v1/scans/${sub.body.scanId}`);
    assert.equal(del.status, 200);
    assert.equal(del.body.state, 'CANCELLED');
    assert.equal((await call('DELETE', `/v1/scans/${sub.body.scanId}`)).body.state, 'CANCELLED');
    await new Promise((r) => setTimeout(r, 100));
    const st = await call('GET', `/v1/scans/${sub.body.scanId}`);
    assert.equal(st.body.state, 'CANCELLED');
    assert.equal(st.body.attestation, undefined);
  });

  it('cancelling a completed scan is a 409 that keeps the result', async () => {
    const content = Buffer.from('fast');
    put('tenant-a', 'obj-1', content);
    const id = (await call('POST', '/v1/scans', { body: submitBody(content) })).body.scanId;
    await poll(id);
    const del = await call('DELETE', `/v1/scans/${id}`);
    assert.equal(del.status, 409);
    assert.equal(del.body.state, 'COMPLETED');
  });

  it('enforces tenant authorization: forbidden tenant 403; other principals see 404 for status and cancel', async () => {
    const content = Buffer.from('tenant bound');
    put('tenant-a', 'obj-1', content);
    assert.equal((await call('POST', '/v1/scans', { token: TOKEN_B, body: submitBody(content) })).status, 403);
    const id = (await call('POST', '/v1/scans', { body: submitBody(content) })).body.scanId;
    assert.equal((await call('GET', `/v1/scans/${id}`, { token: TOKEN_B })).status, 404);
    assert.equal((await call('DELETE', `/v1/scans/${id}`, { token: TOKEN_B })).status, 404);
    assert.equal((await call('GET', `/v1/scans/${id}`)).status, 200);
  });

  it('a request cannot read another tenant\'s object: path traversal, symlink and cross-tenant refs yield UNKNOWN', async () => {
    const content = Buffer.from('secret-of-b');
    put('tenant-b', 'obj-b', content);
    mkdirSync(path.join(root, 'tenant-a'), { recursive: true });
    symlinkSync(path.join(root, 'tenant-b', 'obj-b'), path.join(root, 'tenant-a', 'link'));
    for (const ref of ['obj-b', 'link']) {
      const r = await poll((await call('POST', '/v1/scans', { body: submitBody(content, { objectRef: ref }) })).body.scanId);
      assert.equal(r.body.attestation.verdict, 'UNKNOWN', ref);
      assert.equal(r.body.attestation.reasonCode, 'SOURCE_UNAVAILABLE', ref);
    }
  });

  it('unknown routes and wrong methods are typed errors', async () => {
    assert.equal((await call('GET', '/nope')).status, 404);
    assert.equal((await call('GET', '/v1/scans')).status, 405);
    assert.equal((await call('GET', '/v1/scans/not-a-job')).status, 404);
  });
});
