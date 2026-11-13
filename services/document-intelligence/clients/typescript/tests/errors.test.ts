import { describe, expect, it } from 'vitest';
import { mapWorkerError } from '../src/errors.js';

describe('worker error mapping', () => {
  it('maps provider-specific failures to frozen Shared categories', () => {
    expect(mapWorkerError({ protocolVersion: 'document-intelligence.v1', operationId: 'op', code: 'PROVIDER_FAILED', retryable: false }, 'ghatana.gliner').code).toBe('EXTRACTION_PROVIDER_FAILED');
    expect(mapWorkerError({ protocolVersion: 'document-intelligence.v1', operationId: 'op', code: 'TIMEOUT', retryable: true }, 'ghatana.minilm').code).toBe('EXTERNAL_CALL_TIMEOUT');
  });
});
