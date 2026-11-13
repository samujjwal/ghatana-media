import { createHash, createHmac, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, timingSafeEqual } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { SignedScanAttestation } from './contract.ts';

/** Keys are injected by the host (secret manager / KMS wrapper); nothing is hardcoded here. */
export interface AttestationSigner {
  readonly algorithm: 'HMAC-SHA256' | 'Ed25519';
  readonly keyId: string;
  /** May be asynchronous so an external KMS/HSM can sign remotely; private key material never enters this package. */
  sign(payload: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

/** Picks the signer valid at `now` (key rotation). The KMS stays external: implementations wrap its sign API. */
export interface SigningKeyResolver {
  resolve(now: Date): AttestationSigner | Promise<AttestationSigner>;
}
export type SignerSource = AttestationSigner | SigningKeyResolver;

export class SignerUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'SignerUnavailableError'; }
}

export async function resolveSigner(source: SignerSource, now: Date): Promise<AttestationSigner> {
  return 'resolve' in source ? source.resolve(now) : source;
}

/**
 * Key-rotation-capable resolver over externally held signers. A key signs only inside [notBefore, notAfter);
 * when several are valid the latest notBefore wins (so a new key takes over at its notBefore while the old one stays
 * valid for verification elsewhere). No valid key => SignerUnavailableError (never a fallback to an expired/unknown key).
 */
export function rotatingSigner(keys: ReadonlyArray<{ signer: AttestationSigner; notBefore: Date; notAfter?: Date }>): SigningKeyResolver {
  if (keys.length === 0) throw new RangeError('at least one signing key is required');
  const ids = new Set(keys.map((k) => k.signer.keyId));
  if (ids.size !== keys.length) throw new RangeError('signing keyIds must be unique');
  return {
    resolve(now) {
      const active = keys
        .filter((k) => k.notBefore.getTime() <= now.getTime() && (!k.notAfter || now.getTime() < k.notAfter.getTime()))
        .sort((a, b) => b.notBefore.getTime() - a.notBefore.getTime())[0];
      if (!active) throw new SignerUnavailableError('no signing key is valid at this time');
      return active.signer;
    },
  };
}

/**
 * DEVELOPMENT/TEST ONLY Ed25519 signer from a public label: anyone can derive this key, so its keyId carries the
 * `TEST-ONLY-` prefix (trust roots must never include it) and it refuses to exist when NODE_ENV=production.
 */
export function testOnlyEd25519Signer(label = 'default'): AttestationSigner & { readonly publicKey: KeyObject } {
  if (process.env.NODE_ENV === 'production') throw new Error('test-only signer is forbidden in production');
  const seed = createHash('sha256').update(`ghatana-media/scanner/TEST-ONLY/${label}`).digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  return { ...ed25519Signer(`TEST-ONLY-${label}`, privateKey), publicKey: createPublicKey(privateKey) };
}

export interface AttestationVerifier {
  readonly algorithm: 'HMAC-SHA256' | 'Ed25519';
  readonly keyId: string;
  verify(payload: Uint8Array, signature: Uint8Array): boolean;
}

const MIN_HMAC_KEY_BYTES = 32;

export function hmacSha256Signer(keyId: string, secret: Uint8Array): AttestationSigner & AttestationVerifier {
  if (!keyId) throw new TypeError('keyId required');
  if (secret.byteLength < MIN_HMAC_KEY_BYTES) {
    throw new RangeError(`HMAC key must be at least ${MIN_HMAC_KEY_BYTES} bytes`);
  }
  const key = Uint8Array.from(secret);
  const mac = (payload: Uint8Array) => createHmac('sha256', key).update(payload).digest();
  return {
    algorithm: 'HMAC-SHA256',
    keyId,
    sign: (payload) => mac(payload),
    verify: (payload, signature) => {
      const expected = mac(payload);
      return expected.length === signature.length && timingSafeEqual(expected, signature);
    },
  };
}

export function ed25519Signer(keyId: string, privateKey: KeyObject): AttestationSigner {
  if (!keyId) throw new TypeError('keyId required');
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
    throw new TypeError('an Ed25519 private KeyObject is required');
  }
  return {
    algorithm: 'Ed25519',
    keyId,
    sign: (payload) => edSign(null, payload, privateKey),
  };
}

export function ed25519Verifier(keyId: string, publicKey: KeyObject): AttestationVerifier {
  const pub = publicKey.type === 'private' ? createPublicKey(publicKey) : publicKey;
  if (pub.asymmetricKeyType !== 'ed25519') throw new TypeError('an Ed25519 public KeyObject is required');
  return {
    algorithm: 'Ed25519',
    keyId,
    verify: (payload, signature) => edVerify(null, payload, pub, signature),
  };
}

export type UnsignedAttestation = Omit<SignedScanAttestation, 'attestation'>;

/** Deterministic canonical JSON (sorted keys, no whitespace) of the signed payload. */
export function canonicalPayload(att: UnsignedAttestation): Uint8Array {
  return Buffer.from(canonicalJson(att), 'utf8');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function signAttestation(att: UnsignedAttestation, signer: AttestationSigner): SignedScanAttestation {
  const raw = signer.sign(canonicalPayload(att));
  if (raw instanceof Promise) throw new TypeError('asynchronous signer: use signAttestationAsync');
  return { ...att, attestation: { algorithm: signer.algorithm, keyId: signer.keyId, signature: Buffer.from(raw).toString('base64url') } };
}

export async function signAttestationAsync(att: UnsignedAttestation, signer: AttestationSigner): Promise<SignedScanAttestation> {
  const raw = await signer.sign(canonicalPayload(att));
  return { ...att, attestation: { algorithm: signer.algorithm, keyId: signer.keyId, signature: Buffer.from(raw).toString('base64url') } };
}

export interface AttestationExpectation {
  readonly tenantId: string;
  readonly documentId?: string;
  readonly documentVersion?: number;
  readonly checksum: { readonly algorithm: 'SHA-256'; readonly value: string };
  readonly sizeBytes?: number;
  readonly scannerRef?: string;
  readonly now: Date;
  /** Reject results whose engine definitions are older than this at verification time. */
  readonly maxDefinitionsAgeMs?: number;
}

export type AttestationRejection =
  | 'UNSIGNED'
  | 'UNKNOWN_KEY'
  | 'ALGORITHM_MISMATCH'
  | 'BAD_SIGNATURE'
  | 'EXPIRED'
  | 'NOT_YET_VALID'
  | 'TENANT_MISMATCH'
  | 'DOCUMENT_MISMATCH'
  | 'DIGEST_MISMATCH'
  | 'SIZE_MISMATCH'
  | 'SCANNER_MISMATCH'
  | 'DEFINITIONS_STALE'
  | 'NOT_CLEAN';

export type AttestationVerification =
  | { readonly ok: true; readonly attestation: SignedScanAttestation }
  | { readonly ok: false; readonly reason: AttestationRejection };

/**
 * Verifier for consumers (Kernel adapter, Media release gate). Only an unexpired, correctly
 * signed, exact-digest, same-tenant, fresh-definitions CLEAN attestation returns ok:true.
 */
export function verifyCleanAttestation(
  candidate: SignedScanAttestation | undefined,
  verifiers: readonly AttestationVerifier[],
  expected: AttestationExpectation,
): AttestationVerification {
  const reject = (reason: AttestationRejection): AttestationVerification => ({ ok: false, reason });
  const sig = candidate?.attestation;
  if (!candidate || !sig || !sig.signature || !sig.keyId) return reject('UNSIGNED');
  const verifier = verifiers.find((v) => v.keyId === sig.keyId);
  if (!verifier) return reject('UNKNOWN_KEY');
  if (verifier.algorithm !== sig.algorithm) return reject('ALGORITHM_MISMATCH');
  const { attestation: _drop, ...unsigned } = candidate;
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = Buffer.from(sig.signature, 'base64url');
    if (!verifier.verify(canonicalPayload(unsigned), signatureBytes)) return reject('BAD_SIGNATURE');
  } catch {
    return reject('BAD_SIGNATURE');
  }
  const now = expected.now.getTime();
  const verifiedAt = Date.parse(candidate.verifiedAt);
  const expiresAt = Date.parse(candidate.expiresAt);
  if (!Number.isFinite(verifiedAt) || !Number.isFinite(expiresAt) || expiresAt <= verifiedAt) {
    return reject('EXPIRED');
  }
  if (expiresAt <= now) return reject('EXPIRED');
  if (verifiedAt > now + 5_000) return reject('NOT_YET_VALID');
  if (candidate.tenantId !== expected.tenantId) return reject('TENANT_MISMATCH');
  if (
    (expected.documentId !== undefined && candidate.documentId !== expected.documentId) ||
    (expected.documentVersion !== undefined && candidate.documentVersion !== expected.documentVersion)
  ) {
    return reject('DOCUMENT_MISMATCH');
  }
  if (
    candidate.scannedDigest.algorithm !== expected.checksum.algorithm ||
    candidate.scannedDigest.value !== expected.checksum.value ||
    candidate.checksum.value !== expected.checksum.value
  ) {
    return reject('DIGEST_MISMATCH');
  }
  if (expected.sizeBytes !== undefined && candidate.scannedSizeBytes !== expected.sizeBytes) {
    return reject('SIZE_MISMATCH');
  }
  if (expected.scannerRef !== undefined && candidate.scannerRef !== expected.scannerRef) {
    return reject('SCANNER_MISMATCH');
  }
  if (candidate.verdict !== 'CLEAN' || candidate.status !== 'CLEAN') return reject('NOT_CLEAN');
  if (expected.maxDefinitionsAgeMs !== undefined) {
    const defs = candidate.engine?.definitionsDate ? Date.parse(candidate.engine.definitionsDate) : NaN;
    if (!Number.isFinite(defs) || now - defs > expected.maxDefinitionsAgeMs) return reject('DEFINITIONS_STALE');
  }
  return { ok: true, attestation: candidate };
}
