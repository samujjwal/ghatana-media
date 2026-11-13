import { describe, expect, it } from 'vitest';
import { selectParser, selectedProviderRef } from '../src/selection.js';
import { DocumentExtractionError } from '@ghatana/document-extraction';

const parsers = { docling: {} as never, paddle: {} as never };
describe('deterministic provider selection', () => {
  it('selects exactly one parser by declared MIME', () => { expect(selectParser('application/pdf', parsers)).toBe(parsers.docling); expect(selectParser('image/png', parsers)).toBe(parsers.paddle); expect(selectedProviderRef('image/jpeg')).toBe('ghatana.paddleocr'); });
  it('rejects extension-like or unsupported media types', () => { expect(() => selectParser('application/octet-stream', parsers)).toThrow(DocumentExtractionError); expect(() => selectedProviderRef('pdf')).toThrow('UNSUPPORTED_MEDIA_TYPE'); });
});
