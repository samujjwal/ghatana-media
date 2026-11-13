export type ScanEngineErrorCode =
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'CONNECTION_DROPPED'
  | 'OVERSIZED'
  | 'PROTOCOL_AMBIGUOUS';

export class ScanEngineError extends Error {
  readonly code: ScanEngineErrorCode;
  readonly retryable: boolean;
  constructor(code: ScanEngineErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ScanEngineError';
    this.code = code;
    // OVERSIZED and PROTOCOL_AMBIGUOUS are deterministic for the same bytes: never retried.
    this.retryable = code === 'UNAVAILABLE' || code === 'CONNECTION_DROPPED' || code === 'TIMEOUT';
  }
}
