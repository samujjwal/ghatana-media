import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { invokeDocumentParserWithCapabilityAdmission, invokeFieldExtractionWithCapabilityAdmission, type DocumentParseRequest, type DocumentParserPort } from '@ghatana/document-extraction';
import { DocumentIntelligenceClient } from '../src/client.js';
import { DocxDocumentParserAdapter } from '../src/adapters/docx-document-parser.js';
import { PptxDocumentParserAdapter } from '../src/adapters/pptx-document-parser.js';
import { XlsxDocumentParserAdapter } from '../src/adapters/xlsx-document-parser.js';
import { HybridPdfParserAdapter } from '../src/adapters/hybrid-pdf-parser.js';
import { PaddleDocumentParserAdapter } from '../src/adapters/paddle-document-parser.js';
import { ResilientParserAdapter } from '../src/adapters/resilient-parser.js';
import { GlinerFieldExtractionAdapter } from '../src/adapters/gliner-field-extractor.js';

const ROOT = resolve(import.meta.dirname, '../../..');
const LIVE_URL = process.env.DOCUMENT_INTELLIGENCE_LIVE_WORKER_URL;

const request = (mediaType: string, bytes: Uint8Array, languageHint?: string): DocumentParseRequest => ({
  executionId: `increment4a-live-${mediaType.replace(/[^A-Za-z0-9_.:-]/gu, '_')}`,
  source: { ownerRef: 'increment4a-live', documentId: 'fixture', version: 1 },
  sourceMetadata: { mediaType, sizeBytes: bytes.byteLength },
  content: { open: async function* () { yield bytes; } },
  limits: { maxSourceBytes: 50 * 1024 * 1024, maxExternalCallMs: 120_000 },
  ...(languageHint === undefined ? {} : { languageHint }),
}) as unknown as DocumentParseRequest;

describe.skipIf(LIVE_URL === undefined)('Increment-4A live worker composition', () => {
  const client = LIVE_URL === undefined ? undefined : new DocumentIntelligenceClient({ baseUrl: LIVE_URL });
  const cases: readonly [string, string, string, (client: DocumentIntelligenceClient) => DocumentParserPort, string | undefined][] = [
    ['digital PDF → hybrid → engine', 'application/pdf', 'evaluation/corpus/pdf-en-simple.pdf', (c) => new HybridPdfParserAdapter(c), 'en'],
    ['scanned PDF → hybrid → engine', 'application/pdf', 'evaluation/corpus/pdf-en-no-text.pdf', (c) => new HybridPdfParserAdapter(c), 'en'],
    ['mixed PDF → hybrid → engine', 'application/pdf', 'evaluation/corpus/pdf-en-dense.pdf', (c) => new HybridPdfParserAdapter(c), 'en'],
    ['DOCX → Office provider → engine', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'evaluation/increment4a/corpus/qualification/docx/mr-merged-table.docx', (c) => new DocxDocumentParserAdapter(c), 'mr'],
    ['PPTX → Office provider → engine', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'evaluation/increment4a/corpus/qualification/pptx/ne-table-with-notes.pptx', (c) => new PptxDocumentParserAdapter(c), 'ne'],
    ['XLSX → Office provider → engine', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'evaluation/increment4a/corpus/qualification/xlsx/hi-sparse-merged.xlsx', (c) => new XlsxDocumentParserAdapter(c), 'hi'],
    ['Hindi image → Paddle → engine', 'image/png', 'evaluation/increment4a/corpus/qualification/ocr/hi/hi-clean.png', (c) => new PaddleDocumentParserAdapter(c), 'hi'],
    ['Marathi image → Paddle → engine', 'image/png', 'evaluation/increment4a/corpus/qualification/ocr/mr/mr-clean.png', (c) => new PaddleDocumentParserAdapter(c), 'mr'],
    ['Paddle→Tesseract route inside worker → Shared admission → engine', 'image/png', 'evaluation/increment4a/corpus/qualification/ocr/hi/hi-clean.png', (c) => new ResilientParserAdapter(c), 'hi'],
  ];

  it.each(cases)('admits %s through the frozen Shared parser API', async (_name, mediaType, fixture, make, language) => {
    const bytes = new Uint8Array(await readFile(resolve(ROOT, fixture)));
    const result = await invokeDocumentParserWithCapabilityAdmission(make(client!), request(mediaType, bytes, language));
    expect(result.pages.length).toBeGreaterThan(0);
    expect(result.providerProvenance.providerRef).toBeTruthy();
    if (language === 'hi' || language === 'mr') {
      // GLiNER hi/mr is measured below its acceptance threshold and is
      // truthfully NOT_QUALIFIED in the canonical capability artifact — the
      // capability-admission wrapper therefore refuses it.  Invoke the live
      // extractor directly to prove the worker's extraction path executes
      // without claiming a qualified capability.
      const extractor = new GlinerFieldExtractionAdapter(client!);
      const extraction = await extractor.extract({
        executionId: `increment4a-live-extraction-${language}`,
        schema: {
          ref: 'increment4a-live-schema',
          additionalFields: [],
          fields: [{ fieldId: 'document_number', aliases: ['document number'], valueType: 'IDENTIFIER', cardinality: 'SINGLE' }],
        },
        parsedDocument: result,
        requestedFieldIds: ['document_number'],
      } as unknown as Parameters<typeof extractor.extract>[0]);
      expect(extraction.provider.providerRef).toBe('ghatana.gliner');
    }
  }, 180_000);
});
