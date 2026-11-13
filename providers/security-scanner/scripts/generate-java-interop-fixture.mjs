// Generates the committed cross-language fixture consumed by the Java
// Ed25519ScanAttestationVerifierTest. TEST-ONLY key: deterministic seed, never a production key.
// Usage: node --experimental-strip-types scripts/generate-java-interop-fixture.mjs <out.json>
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { attestationBinding } from '../src/service.ts';
import { ed25519Signer, signAttestation } from '../src/attestation.ts';

const out = process.argv[2];
if (!out) throw new Error('output path required');
const seed = createHash('sha256').update('ghatana-media/scan-attestation/java-interop/test-only-seed/v1').digest();
const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
const privateKey = createPrivateKey({ key: Buffer.concat([pkcs8Prefix, seed]), format: 'der', type: 'pkcs8' });
const publicKey = createPublicKey(privateKey);

const sha = 'ab'.repeat(32);
const unsigned = {
  scannerRef: 'clamd-interop-fixture',
  status: 'CLEAN',
  scannedAt: '2026-11-12T12:00:00.000Z',
  checksum: { algorithm: 'SHA-256', value: sha },
  scannerVersion: 'ClamAV 1.4.0',
  verdict: 'CLEAN',
  reasonCode: 'OK',
  tenantId: 'tenant-a',
  documentId: 'upload-a',
  documentVersion: 1,
  scannedDigest: { algorithm: 'SHA-256', value: sha },
  scannedSizeBytes: 4096,
  engine: { name: 'ClamAV', version: '1.4.0', definitionsVersion: '27000', definitionsDate: '2026-11-12T00:00:00.000Z' },
  verifiedAt: '2026-11-12T12:00:00.000Z',
  expiresAt: '2026-11-12T12:10:00.000Z',
  attestationRef: 'att-interop-0001',
};
const signed = signAttestation(unsigned, ed25519Signer('interop-key-1', privateKey));
const binding = attestationBinding(signed);
const { attestation: _a, ...rest } = signed;
const { canonicalPayload } = await import('../src/attestation.ts');
writeFileSync(out, JSON.stringify({
  note: 'TEST-ONLY cross-language vector produced by providers/security-scanner (ed25519Signer). Not a production key.',
  publicKeySpkiBase64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  canonicalPayload: Buffer.from(canonicalPayload(rest)).toString('utf8'),
  binding,
  facts: { tenantId: 'tenant-a', uploadId: 'upload-a', sha256: sha, sizeBytes: 4096, verifiedAt: unsigned.verifiedAt, expiresAt: unsigned.expiresAt },
}, null, 2) + '\n');
