// Deterministic TEST-ONLY vector of a REJECTED_STRUCTURE attestation produced by the real provider (EICAR appended after %%EOF
// and declared application/pdf; engine stub answers CLEAN like real clamd did). For cross-language (Kernel Java) trust tests.
// Usage: node --experimental-strip-types scripts/generate-rejected-structure-vector.mjs <out.json>
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { SecurityScannerProvider, ed25519Signer } from '../src/index.ts';
import { attestationBinding } from '../src/service.ts';
import { canonicalPayload, signAttestation } from '../src/attestation.ts';

const out = process.argv[2];
if (!out) throw new Error('output path required');
const seed = createHash('sha256').update('ghatana-media/scan-attestation/rejected-structure/test-only-seed/v1').digest();
const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
const publicKey = createPublicKey(privateKey);
const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
const content = Buffer.concat([Buffer.from('%PDF-1.7\ntrailer<<>>\n%%EOF\n'), eicar]);
const now = new Date('2026-11-12T12:00:00.000Z');
const provider = new SecurityScannerProvider({
  engine: { identity: async () => ({ name: 'ClamAV', version: 'ClamAV 1.4.0', definitionsVersion: '27000', definitionsDate: new Date('2026-11-12T00:00:00.000Z') }), scan: async () => ({ kind: 'CLEAN' }) },
  source: { read: async () => ({ tenantId: 'tenant-a', content }) }, signer: ed25519Signer('interop-key-1', privateKey), scannerRef: 'clamd-interop-fixture',
  pinnedEngineVersions: ['ClamAV 1.4.0'], maxBytes: 1 << 20, maxDefinitionsAgeMs: 86_400_000, attestationTtlMs: 600_000, now: () => now, newAttestationRef: () => 'att-rejected-0001',
});
const signed = await provider.scanSigned({ documentId: 'upload-a', version: 1, tenantId: 'tenant-a', checksum: { algorithm: 'SHA-256', value: createHash('sha256').update(content).digest('hex') }, sizeBytes: content.length, mimeType: 'application/pdf' });
const { attestation: _a, ...rest } = signed;
// Properly SIGNED but internally inconsistent negatives (only this signer could emit them); a trust mapper must refuse both.
const signer = ed25519Signer('interop-key-1', privateKey);
const negative = (mutate) => {
  const s2 = signAttestation(mutate(structuredClone(rest)), signer);
  const { attestation: _b, ...r2 } = s2;
  return { attestation: s2, canonicalPayload: Buffer.from(canonicalPayload(r2)).toString('utf8'), binding: attestationBinding(s2) };
};
const negatives = {
  rejectedStructureWithStatusClean: negative((u) => ({ ...u, status: 'CLEAN' })),
  rejectedStructureWithFinalityClean: negative((u) => ({ ...u, finality: { ...u.finality, verdict: 'CLEAN' } })),
};
writeFileSync(out, JSON.stringify({
  note: 'TEST-ONLY vector produced by providers/security-scanner (real provider, deterministic seed). Not a production key.',
  expectedTriple: { verdict: signed.verdict, status: signed.status, finalityVerdict: signed.finality?.verdict, reasonCode: signed.reasonCode },
  publicKeySpkiBase64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  keyId: 'interop-key-1',
  attestation: signed,
  canonicalPayload: Buffer.from(canonicalPayload(rest)).toString('utf8'),
  binding: attestationBinding(signed),
  signedInconsistentNegatives: negatives,
}, null, 2) + '\n');
