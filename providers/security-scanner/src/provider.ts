import { createHash, randomUUID } from 'node:crypto';
import { signAttestation, type AttestationSigner, type UnsignedAttestation } from './attestation.ts';
import type {
  ContentChecksum,
  ContentScanAttestation,
  DocumentContentScanInput,
  DocumentContentScanPort,
  ScanReasonCode,
  ScanVerdict,
  SignedScanAttestation,
} from './contract.ts';
import type { EngineIdentity, ScanEngine } from './engine.ts';
import { ScanEngineError } from './errors.ts';

/**
 * Bounded read access to quarantined bytes. The host maps (tenant, document, version) to an
 * isolated quarantine object; this provider never receives bucket names, paths or credentials.
 * The source must return the owning tenant of the bytes so a cross-tenant mix-up is detected.
 */
export interface QuarantineSource {
  read(
    request: { tenantId: string; documentId: string; version: number; maxBytes: number },
    signal: AbortSignal,
  ): Promise<{ tenantId: string; content: Uint8Array } | undefined>;
}

export interface SecurityScannerProviderOptions {
  readonly engine: ScanEngine;
  readonly source: QuarantineSource;
  readonly signer: AttestationSigner;
  /** Stable provider identity reported as `scannerRef`. */
  readonly scannerRef: string;
  /**
   * Exact engine version strings admitted for CLEAN results (for example "ClamAV 1.4.2").
   * Pinning is mandatory: an empty list can never produce CLEAN.
   */
  readonly pinnedEngineVersions: readonly string[];
  readonly maxBytes: number;
  /** Signature database older than this cannot produce CLEAN (stale-definition policy). */
  readonly maxDefinitionsAgeMs: number;
  readonly attestationTtlMs: number;
  readonly scanTimeoutMs?: number;
  readonly maxConcurrentScans?: number;
  readonly maxQueuedScans?: number;
  readonly now?: () => Date;
  readonly newAttestationRef?: () => string;
}

const SHA256 = /^[a-f0-9]{64}$/u;

/**
 * Implements the Shared `DocumentContentScanPort`. Policy: CLEAN is issued only when the engine
 * affirmatively reports clean for bytes whose SHA-256 and size exactly match the request, the
 * engine version is pinned, definitions are known and fresh, and the quarantine source belongs
 * to the requesting tenant. Every other outcome is INFECTED or UNKNOWN (projected to the base
 * status FAILED). This adapter never throws for scan-level problems: callers get a signed
 * non-CLEAN attestation they can persist.
 */
export class SecurityScannerProvider implements DocumentContentScanPort {
  readonly #o: SecurityScannerProviderOptions;
  #active = 0;
  readonly #waiters: Array<() => void> = [];

  constructor(options: SecurityScannerProviderOptions) {
    if (!options.scannerRef) throw new TypeError('scannerRef required');
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) throw new RangeError('maxBytes');
    if (!(options.attestationTtlMs > 0) || !(options.maxDefinitionsAgeMs > 0)) {
      throw new RangeError('attestationTtlMs and maxDefinitionsAgeMs must be positive');
    }
    this.#o = options;
  }

  get scannerRef(): string {
    return this.#o.scannerRef;
  }

  async scan(input: DocumentContentScanInput): Promise<ContentScanAttestation> {
    return this.scanSigned(input);
  }

  /** Same as {@link scan} but typed with the extended attestation fields. */
  async scanSigned(input: DocumentContentScanInput): Promise<SignedScanAttestation> {
    const o = this.#o;
    const now = o.now ?? (() => new Date());
    const tenantId = input.tenantId ?? '';
    const validShape =
      tenantId !== '' &&
      input.documentId !== '' &&
      Number.isSafeInteger(input.version) &&
      input.checksum?.algorithm === 'SHA-256' &&
      SHA256.test(input.checksum.value) &&
      Number.isSafeInteger(input.sizeBytes) &&
      input.sizeBytes > 0 &&
      input.mimeType !== '';
    const requested: ContentChecksum = validShape ? input.checksum : { algorithm: 'SHA-256', value: '0'.repeat(64) };
    const finish = (
      verdict: ScanVerdict,
      reasonCode: ScanReasonCode,
      scanned: { digest: ContentChecksum; size: number },
      engine?: EngineIdentity,
      signatureName?: string,
    ): SignedScanAttestation => {
      const at = now();
      const unsigned: UnsignedAttestation = {
        scannerRef: o.scannerRef,
        scannerVersion: engine ? `${engine.version}` : 'unavailable',
        status: verdict === 'CLEAN' ? 'CLEAN' : verdict === 'INFECTED' ? 'INFECTED' : 'FAILED',
        verdict,
        reasonCode,
        scannedAt: at.toISOString(),
        checksum: requested,
        tenantId,
        documentId: input.documentId ?? '',
        documentVersion: input.version,
        scannedDigest: scanned.digest,
        scannedSizeBytes: scanned.size,
        ...(engine
          ? {
              engine: {
                name: engine.name,
                version: engine.version,
                ...(engine.definitionsVersion ? { definitionsVersion: engine.definitionsVersion } : {}),
                ...(engine.definitionsDate ? { definitionsDate: engine.definitionsDate.toISOString() } : {}),
              },
            }
          : {}),
        ...(signatureName ? { signatureName } : {}),
        verifiedAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + o.attestationTtlMs).toISOString(),
        attestationRef: (o.newAttestationRef ?? randomUUID)(),
      };
      return signAttestation(unsigned, o.signer);
    };
    const nothing = { digest: requested, size: 0 };

    if (!validShape) return finish('UNKNOWN', 'INVALID_REQUEST', nothing);
    if (input.sizeBytes > o.maxBytes) return finish('UNKNOWN', 'OVERSIZED', nothing);

    let release: (() => void) | undefined;
    try {
      release = await this.#acquire();
    } catch {
      return finish('UNKNOWN', 'SCANNER_BUSY', nothing);
    }
    const signal = AbortSignal.timeout(o.scanTimeoutMs ?? 60_000);
    try {
      let fetched: { tenantId: string; content: Uint8Array } | undefined;
      try {
        fetched = await o.source.read(
          { tenantId, documentId: input.documentId, version: input.version, maxBytes: o.maxBytes },
          signal,
        );
      } catch {
        return finish('UNKNOWN', 'SOURCE_UNAVAILABLE', nothing);
      }
      if (!fetched) return finish('UNKNOWN', 'SOURCE_UNAVAILABLE', nothing);
      if (fetched.tenantId !== tenantId) return finish('UNKNOWN', 'TENANT_MISMATCH', nothing);
      const content = fetched.content;
      if (content.byteLength > o.maxBytes) return finish('UNKNOWN', 'OVERSIZED', nothing);
      const actual: ContentChecksum = {
        algorithm: 'SHA-256',
        value: createHash('sha256').update(content).digest('hex'),
      };
      const scanned = { digest: actual, size: content.byteLength };
      if (actual.value !== requested.value) return finish('UNKNOWN', 'DIGEST_MISMATCH', scanned);
      if (content.byteLength !== input.sizeBytes) return finish('UNKNOWN', 'SIZE_MISMATCH', scanned);

      let identity: EngineIdentity | undefined;
      let identityFailure: ScanReasonCode | undefined;
      try {
        identity = await o.engine.identity(signal);
      } catch (error) {
        identityFailure = reasonOf(error);
      }

      let outcome;
      try {
        outcome = await o.engine.scan(content, signal);
      } catch (error) {
        return finish('UNKNOWN', reasonOf(error), scanned, identity);
      }
      // A malware hit is always reported, even if identity or freshness checks would block CLEAN.
      if (outcome.kind === 'INFECTED') {
        return finish('INFECTED', 'SIGNATURE_MATCH', scanned, identity, outcome.signatureName);
      }
      if (!identity) return finish('UNKNOWN', identityFailure ?? 'ENGINE_UNAVAILABLE', scanned);
      if (!o.pinnedEngineVersions.includes(identity.version)) {
        return finish('UNKNOWN', 'ENGINE_VERSION_NOT_PINNED', scanned, identity);
      }
      if (!identity.definitionsDate) return finish('UNKNOWN', 'DEFINITIONS_UNKNOWN', scanned, identity);
      const age = now().getTime() - identity.definitionsDate.getTime();
      if (age > o.maxDefinitionsAgeMs || age < -5 * 60_000) {
        return finish('UNKNOWN', 'DEFINITIONS_STALE', scanned, identity);
      }
      return finish('CLEAN', 'OK', scanned, identity);
    } finally {
      release();
    }
  }

  async #acquire(): Promise<() => void> {
    const max = this.#o.maxConcurrentScans ?? 4;
    if (this.#active < max) {
      this.#active++;
      return () => this.#release();
    }
    if (this.#waiters.length >= (this.#o.maxQueuedScans ?? 16)) throw new Error('busy');
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
    return () => this.#release();
  }

  #release(): void {
    const next = this.#waiters.shift();
    if (next) next();
    else this.#active--;
  }
}

function reasonOf(error: unknown): ScanReasonCode {
  if (error instanceof ScanEngineError) {
    switch (error.code) {
      case 'TIMEOUT':
        return 'ENGINE_TIMEOUT';
      case 'CONNECTION_DROPPED':
        return 'ENGINE_CONNECTION_DROPPED';
      case 'OVERSIZED':
        return 'OVERSIZED';
      case 'PROTOCOL_AMBIGUOUS':
        return 'ENGINE_PROTOCOL_AMBIGUOUS';
      default:
        return 'ENGINE_UNAVAILABLE';
    }
  }
  return 'ENGINE_UNAVAILABLE';
}
