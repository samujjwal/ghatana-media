import { describe, expect, it } from 'vitest';
import { validateExtractionResponse, validateParsedResponse } from '../src/validators.js';

describe('adversarial worker responses', () => {
  it('rejects malformed parsed geometry and unknown nested keys', () => {
    expect(() => validateParsedResponse({
      protocolVersion: 'document-intelligence.v1', operationId: 'op', providerRef: 'ghatana.docling',
      providerProvenance: { providerRef: 'ghatana.docling', providerVersion: '0.1.0' }, quality: {},
      pages: [{ pageNumber: 1, blocks: [{ blockId: 'b', kind: 'TEXT', boundingRegion: { x: 0, y: 0, width: 1, height: 1 }, lines: [], secret: true }], tables: [] }],
    })).toThrow();
  });
  it('rejects non-model candidates and invalid evidence spans', () => {
    expect(() => validateExtractionResponse({
      protocolVersion: 'document-intelligence.v1', operationId: 'op', providerRef: 'ghatana.gliner',
      provider: { providerRef: 'ghatana.gliner', providerVersion: '0.1.0', modelRef: 'm', modelVersion: 'v' },
      candidates: [{ fieldId: 'name', value: { kind: 'TEXT', value: 'x' }, source: 'RULE', confidence: 0.5, evidence: [{ pageNumber: 1, textSpan: { start: 2, end: 1 } }], provider: { providerRef: 'ghatana.gliner', providerVersion: '0.1.0', modelRef: 'm', modelVersion: 'v' } }],
    })).toThrow();
  });
});
