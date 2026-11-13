// Runs the adapter's output through the real Shared strict admission (evaluateScanAdmission) when a
// built @ghatana/documents is resolvable. Set GHATANA_DOCUMENTS_DIST to a compiled dist directory
// (e.g. `tsc -p ghatana-shared/platform/typescript/documents --outDir <dir> --composite false ...`).
// The package is not published yet, so without it these tests are skipped (never faked).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { ClamdEngine, SecurityScannerProvider, hmacSha256Signer, verifyCleanAttestation, type SignedScanAttestation } from '../src/index.ts';
import { startFakeClamd } from './fake-clamd.ts';

const dist = process.env.GHATANA_DOCUMENTS_DIST;
const shared = dist
  ? {
      ingest: await import(pathToFileURL(path.join(dist, 'ingest/index.js')).href),
      fixtures: await import(pathToFileURL(path.join(dist, 'testing/fixtures/index.js')).href).catch(() => undefined),
    }
  : undefined;

describe('Shared scan admission (@ghatana/documents)', { skip: shared ? false : 'GHATANA_DOCUMENTS_DIST not set' }, () => {
  const signer = hmacSha256Signer('k1', Buffer.alloc(32, 5));
  const now = new Date('2025-11-12T12:00:00Z');
  const content = Buffer.from('shared-admission');
  const checksum = { algorithm: 'SHA-256' as const, value: createHash('sha256').update(content).digest('hex') };

  async function scan(behavior: 'normal' | 'garbage') {
    const clamd = await startFakeClamd();
    clamd.behavior = behavior;
    try {
      const p = new SecurityScannerProvider({
        engine: new ClamdEngine({ endpoint: clamd.endpoint, maxBytes: 4096 }),
        source: { read: async () => ({ tenantId: 'tenant:a', content }) }, signer, scannerRef: 'scanner',
        pinnedEngineVersions: ['ClamAV 1.4.2'], maxBytes: 4096, maxDefinitionsAgeMs: 3 * 86_400_000,
        attestationTtlMs: 60_000, now: () => now,
      });
      return (await p.scan({ documentId: 'd', version: 1, checksum, sizeBytes: content.length, mimeType: 'text/plain',
        tenantRef: 'tenant:a', scopeRef: 'scope:documents.scan', sourceRef: 'quarantine://src-1' })) as SignedScanAttestation;
    } finally { await clamd.close(); }
  }
  const trusted = (a: unknown) => verifyCleanAttestation(a as SignedScanAttestation, [signer], { tenantId: 'tenant:a', checksum, now }).ok;
  const expectations = (extra = {}) => ({ checksum, now, expectedTenantRef: 'tenant:a', expectedScopeRef: 'scope:documents.scan',
    expectedSourceRef: 'quarantine://src-1', isAttestationTrusted: trusted, ...extra });

  it('signed unexpired exact CLEAN is admitted', async () => {
    const att = await scan('normal');
    assert.equal(att.finality?.verdict, 'CLEAN');
    const d = shared!.ingest.evaluateScanAdmission(att, expectations());
    assert.deepEqual([d.admitted, [...d.reasons]], [true, []]);
  });
  it('UNKNOWN (ambiguous engine) is refused as VERDICT_UNKNOWN', async () => {
    const att = await scan('garbage');
    assert.equal(att.finality?.verdict, 'UNKNOWN');
    const d = shared!.ingest.evaluateScanAdmission(att, expectations());
    assert.equal(d.admitted, false);
    assert.ok(d.reasons.includes('VERDICT_UNKNOWN'));
  });
  it('wrong tenant, wrong digest and expiry are refused', async () => {
    const att = await scan('normal');
    assert.ok(shared!.ingest.evaluateScanAdmission(att, expectations({ expectedTenantRef: 'tenant:b' })).reasons.includes('TENANT_MISMATCH'));
    assert.ok(shared!.ingest.evaluateScanAdmission(att, expectations({ checksum: { algorithm: 'SHA-256', value: 'b'.repeat(64) } })).reasons.includes('DIGEST_MISMATCH'));
    assert.ok(shared!.ingest.evaluateScanAdmission(att, expectations({ now: new Date(now.getTime() + 61_000) })).reasons.includes('EXPIRED'));
  });
  it('Shared conformance fixtures pass against the resolved evaluator', { skip: shared?.fixtures ? false : 'test-fixtures entry not found in dist' }, () => {
    assert.deepEqual([...shared!.fixtures.verifyScanAdmissionFixtures()], []);
  });
});
