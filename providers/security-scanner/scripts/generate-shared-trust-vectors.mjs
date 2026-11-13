// Cross-language TRUSTED signed-scan vectors for Shared's DocumentContentScanPort admission contract (data only; Shared takes no
// code dependency on this package). Cases are produced by the real provider with a deterministic TEST-ONLY Ed25519 seed.
// Usage: node --experimental-strip-types scripts/generate-shared-trust-vectors.mjs <out.json> [mediaCommit]
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { SecurityScannerProvider, signAttestation, testOnlyEd25519Signer } from '../src/index.ts';
import { canonicalPayload } from '../src/attestation.ts';

const out = process.argv[2];
if (!out) throw new Error('output path required');
const signer = testOnlyEd25519Signer('shared-trust-vectors-v1');
const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
const cleanPdf = Buffer.from('%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const polyglot = Buffer.concat([cleanPdf, eicar]);
const T0 = new Date('2026-11-12T12:00:00.000Z');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const engine = { identity: async () => ({ name: 'ClamAV', version: 'ClamAV 1.4.0', definitionsVersion: '27000', definitionsDate: new Date('2026-11-12T00:00:00.000Z') }), scan: async () => ({ kind: 'CLEAN' }) };
const scan = (content, ref) => new SecurityScannerProvider({
  engine, source: { read: async () => ({ tenantId: 'tenant-a', content }) }, signer, scannerRef: 'clamd-shared-vector', pinnedEngineVersions: ['ClamAV 1.4.0'],
  maxBytes: 1 << 20, maxDefinitionsAgeMs: 86_400_000, attestationTtlMs: 600_000, now: () => T0, newAttestationRef: () => ref,
}).scanSigned({ documentId: 'upload-a', version: 1, tenantId: 'tenant-a', sourceRef: 'quarantine:tenant-a/upload-a/1', checksum: { algorithm: 'SHA-256', value: sha(content) }, sizeBytes: content.length, mimeType: 'application/pdf' });

const pack = async (signed) => {
  const { attestation: sig, ...rest } = signed;
  return { attestation: signed, canonicalPayload: Buffer.from(canonicalPayload(rest)).toString('utf8'), signature: sig };
};
const resign = (signed, mutate) => { const { attestation: _a, ...rest } = signed; return signAttestation(mutate(structuredClone(rest)), signer); };

const clean = await scan(cleanPdf, 'att-clean-0001');
const rejected = await scan(polyglot, 'att-rejected-0001');
const cases = {
  clean: { ...(await pack(clean)), contentSha256: sha(cleanPdf), expectedAdmission: { admittedAtIssue: true } },
  rejectedStructure: { ...(await pack(rejected)), contentSha256: sha(polyglot), expectedAdmission: { admitted: false, mustInclude: ['VERDICT_QUARANTINED'] } },
  rejectedStructureWithStatusClean: { ...(await pack(resign(rejected, (u) => ({ ...u, status: 'CLEAN' })))), contentSha256: sha(polyglot), expectedAdmission: { admitted: false, mustInclude: ['STATUS_VERDICT_MISMATCH'] } },
  rejectedStructureWithFinalityClean: { ...(await pack(resign(rejected, (u) => ({ ...u, finality: { ...u.finality, verdict: 'CLEAN' } })))), contentSha256: sha(polyglot), expectedAdmission: { admitted: false, mustInclude: ['STATUS_VERDICT_MISMATCH'] } },
};
writeFileSync(out, JSON.stringify({
  schemaVersion: 'ghatana.shared.scan-trust-vectors.v1',
  note: 'TEST-ONLY vectors (deterministic public seed, keyId TEST-ONLY-*). Data only; signature checking is the consumer test\'s job (node:crypto Ed25519), admission semantics are Shared evaluateScanAdmission.',
  provenance: { producer: '@ghatana-media/security-scanner-provider', generator: 'providers/security-scanner/scripts/generate-shared-trust-vectors.mjs', mediaCommit: process.argv[3] ?? 'unknown' },
  key: { keyId: signer.keyId, algorithm: 'Ed25519', publicKeySpkiBase64: signer.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') },
  issuedAt: T0.toISOString(), ttlMs: 600_000, tenantRef: 'tenant-a',
  cases,
}, null, 2) + '\n');
