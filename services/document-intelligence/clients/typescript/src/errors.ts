import { DocumentExtractionError, type DocumentExtractionErrorCode } from '@ghatana/document-extraction';
import type { WireError } from './protocol.js';

const mapCode: Record<string, DocumentExtractionErrorCode> = {
  INVALID_REQUEST: 'INVALID_REQUEST', LIMIT_EXCEEDED: 'SOURCE_TOO_LARGE', UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE', UNSUPPORTED_LANGUAGE: 'PARSE_FAILED', PROVIDER_BUSY: 'PARSER_UNAVAILABLE', PROVIDER_UNAVAILABLE: 'PARSER_UNAVAILABLE', PROVIDER_FAILED: 'PARSE_FAILED', TIMEOUT: 'EXTERNAL_CALL_TIMEOUT', CANCELLED: 'CANCELLED', INVALID_PROVIDER_OUTPUT: 'PARSE_OUTPUT_INVALID',
};
export function mapWorkerError(error: WireError, providerRef?: string): DocumentExtractionError {
  const code = mapCode[error.code] ?? 'INTERNAL_INVARIANT';
  const adjusted = error.code === 'PROVIDER_FAILED' && providerRef === 'ghatana.gliner' ? 'EXTRACTION_PROVIDER_FAILED' : error.code === 'PROVIDER_UNAVAILABLE' && providerRef === 'ghatana.gliner' ? 'EXTRACTION_PROVIDER_UNAVAILABLE' : error.code === 'PROVIDER_FAILED' && providerRef === 'ghatana.minilm' ? 'EMBEDDING_FAILED' : code;
  return new DocumentExtractionError(adjusted as DocumentExtractionErrorCode, { retryable: error.retryable, providerRef });
}
export function cancelledError(providerRef?: string): DocumentExtractionError { return new DocumentExtractionError('CANCELLED', { providerRef }); }
