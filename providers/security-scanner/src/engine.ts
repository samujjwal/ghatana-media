export interface EngineIdentity {
  readonly name: string;
  /** Exact engine version string, e.g. "ClamAV 1.4.2". */
  readonly version: string;
  readonly definitionsVersion?: string;
  readonly definitionsDate?: Date;
}

export type EngineScanOutcome =
  | { readonly kind: 'CLEAN' }
  | { readonly kind: 'INFECTED'; readonly signatureName: string };

/** Malware engine boundary. Implementations must throw {@link ScanEngineError} on failure. */
export interface ScanEngine {
  identity(signal?: AbortSignal): Promise<EngineIdentity>;
  scan(content: Uint8Array, signal?: AbortSignal): Promise<EngineScanOutcome>;
}
