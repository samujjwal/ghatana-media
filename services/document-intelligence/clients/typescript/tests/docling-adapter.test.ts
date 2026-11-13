import { describe, expect, it } from 'vitest';
import { DoclingDocumentParserAdapter } from '../src/adapters/docling-document-parser.js';

describe('Docling adapter source authority', () => {
  it('is exported as a Shared parser port adapter', () => { expect(DoclingDocumentParserAdapter).toBeDefined(); });
});
