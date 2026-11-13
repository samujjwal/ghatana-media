import { describe, expect, it } from 'vitest';
import { validateEmbeddingResponse, validateError, validateProviderCatalog } from '../src/validators.js';

describe('wire protocol validation', () => {
  it('rejects unknown/malformed embedding output', () => {
    expect(() => validateEmbeddingResponse({ protocolVersion: 'document-intelligence.v1', operationId: 'op', providerRef: 'ghatana.minilm', model: { providerRef: 'ghatana.minilm', providerVersion: '0.1.0', modelRef: 'm', modelVersion: 'v' }, dimensions: 2, values: [1], unknown: true })).toThrow();
  });
  it('accepts only sanitized error shape', () => {
    expect(validateError({ protocolVersion: 'document-intelligence.v1', operationId: 'op', code: 'TIMEOUT', retryable: true }).code).toBe('TIMEOUT');
    expect(() => validateError({ protocolVersion: 'document-intelligence.v1', operationId: 'op', code: 'TIMEOUT', retryable: true, message: 'secret' })).toThrow();
  });
  it('rejects an untyped provider catalog', () => {
    expect(() => validateProviderCatalog({ protocolVersion: 'document-intelligence.v1', providers: [{ providerRef: 'ghatana.docling', providerVersion: '0.1.0', loaded: true, ready: true, secret: 'leak' }] })).toThrow();
  });
});
