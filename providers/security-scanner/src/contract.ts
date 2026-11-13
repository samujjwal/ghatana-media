/**
 * Structural mirror of the Shared `DocumentContentScanPort` contract
 * (`@ghatana/documents` lifecycle/ports.ts). It is mirrored, not imported, so this provider
 * has no build-time dependency on Shared or on Media core. A Kernel adapter binds by structural
 * typing: `const port: DocumentContentScanPort = provider`.
 *
 * The extended attestation fields are all optional additions. Consumers that only know the
 * base Shared shape keep working; consumers that know the newer generic scan-result fields
 * (digest, scannerRef/version, verdict, verifiedAt, expiresAt, attestation ref) read them from
 * the same object. Mapping to the Shared extension is therefore a field-for-field projection.
 */
export interface ContentChecksum {
  readonly algorithm: 'SHA-256';
  readonly value: string;
}

export type BaseScanStatus = 'CLEAN' | 'INFECTED' | 'FAILED';
/** Provider-level verdict vocabulary. UNKNOWN projects onto the base status FAILED. */
export type ScanVerdict = 'CLEAN' | 'INFECTED' | 'UNKNOWN' | 'REJECTED_STRUCTURE';

export type ScanReasonCode =
  | 'OK'
  | 'SIGNATURE_MATCH'
  | 'INVALID_REQUEST'
  | 'OVERSIZED'
  | 'DIGEST_MISMATCH'
  | 'SIZE_MISMATCH'
  | 'TENANT_MISMATCH'
  | 'SOURCE_UNAVAILABLE'
  | 'ENGINE_UNAVAILABLE'
  | 'ENGINE_TIMEOUT'
  | 'ENGINE_CONNECTION_DROPPED'
  | 'ENGINE_PROTOCOL_AMBIGUOUS'
  | 'ENGINE_VERSION_NOT_PINNED'
  | 'DEFINITIONS_STALE'
  | 'DEFINITIONS_UNKNOWN'
  | 'SCANNER_BUSY'
  | 'STRUCTURE_MAGIC_MISMATCH'
  | 'STRUCTURE_TRAILING_BYTES'
  | 'STRUCTURE_TERMINATOR_MISSING'
  | 'STRUCTURE_NESTED_ARCHIVE_DEPTH'
  | 'STRUCTURE_DECOMPRESSION_LIMIT'
  | 'STRUCTURE_UNDETERMINED'
  | 'STRUCTURE_UNSUPPORTED_TYPE';

export interface ContentScanAttestation {
  readonly scannerRef: string;
  readonly status: BaseScanStatus;
  /** ISO-8601 instant. */
  readonly scannedAt: string;
  readonly checksum: ContentChecksum;
  readonly scannerVersion?: string;
  readonly finality?: DocumentScanResultFinality;
}

export interface DocumentContentScanInput {
  readonly documentId: string;
  readonly version: number;
  readonly checksum: ContentChecksum;
  readonly sizeBytes: number;
  readonly mimeType: string;
  /** Shared optional binding facts (echoed into `finality`). `tenantRef` is required by this provider. */
  readonly tenantRef?: string;
  readonly scopeRef?: string;
  readonly sourceRef?: string;
  /** Deprecated alias of `tenantRef` kept for early adopters. */
  readonly tenantId?: string;
}

/** Mirror of Shared `DocumentScanResultFinality` (@ghatana/documents >= 0.2.0). */
export interface DocumentScanResultFinality {
  readonly verdict: 'CLEAN' | 'QUARANTINED' | 'ERROR' | 'UNKNOWN';
  readonly tenantRef: string;
  readonly scopeRef?: string;
  readonly sourceRef: string;
  readonly verifiedAt: string;
  readonly expiresAt: string;
  readonly statusRef?: string;
  readonly attestationRef?: string;
  readonly signatureRef?: string;
  readonly errorCode?: string;
}

export interface DocumentContentScanPort {
  scan(input: DocumentContentScanInput): Promise<ContentScanAttestation>;
}

export interface SignedScanAttestation extends ContentScanAttestation {
  /** Same value as `status` but with UNKNOWN preserved. */
  readonly verdict: ScanVerdict;
  readonly reasonCode: ScanReasonCode;
  readonly tenantId: string;
  readonly documentId: string;
  readonly documentVersion: number;
  /** Exact SHA-256 of the bytes the engine actually scanned (hex). */
  readonly scannedDigest: ContentChecksum;
  readonly scannedSizeBytes: number;
  readonly engine?: {
    readonly name: string;
    readonly version: string;
    readonly definitionsVersion?: string;
    /** ISO-8601 build time of the signature database. */
    readonly definitionsDate?: string;
  };
  readonly signatureName?: string;
  readonly verifiedAt: string;
  readonly expiresAt: string;
  /** Opaque unique reference of this attestation. */
  readonly attestationRef: string;
  readonly attestation: {
    readonly algorithm: 'HMAC-SHA256' | 'Ed25519';
    readonly keyId: string;
    /** base64url signature over the canonical payload. */
    readonly signature: string;
  };
}
