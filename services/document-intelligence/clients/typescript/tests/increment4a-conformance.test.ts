import { describe, expect, it } from 'vitest';
import { invokeDocumentParserWithCapabilityAdmission, type DocumentParseRequest } from '@ghatana/document-extraction';
import { DocumentIntelligenceClient } from '../src/client.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';
import { HybridPdfParserAdapter } from '../src/adapters/hybrid-pdf-parser.js';
import { DocxDocumentParserAdapter } from '../src/adapters/docx-document-parser.js';
import { PptxDocumentParserAdapter } from '../src/adapters/pptx-document-parser.js';
import { XlsxDocumentParserAdapter } from '../src/adapters/xlsx-document-parser.js';
import { ResilientParserAdapter } from '../src/adapters/resilient-parser.js';
import {
  MEDIA_DOCX,
  MEDIA_PDF,
  MEDIA_PNG,
  MEDIA_PPTX,
  MEDIA_XLSX,
  PROVIDER_DOCLING_DOCX,
  PROVIDER_DOCLING_PPTX,
  PROVIDER_DOCLING_XLSX,
  PROVIDER_HYBRID_PDF,
  PROVIDER_RESILIENT_PARSER,
} from '../src/media-types.js';

const respond = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const operationIdOf = (init?: RequestInit): string => {
  const body = init?.body;
  if (body instanceof FormData) {
    const metadata = body.get('metadata');
    if (typeof metadata === 'string') return (JSON.parse(metadata) as { operationId: string }).operationId;
  }
  return 'unknown';
};
/** Accepted catalog records mirroring `capabilities/increment4a.accepted.json`. */
const catalog = {
  protocolVersion: PROTOCOL_VERSION,
  providers: [
    { providerRef: PROVIDER_HYBRID_PDF, providerVersion: '0.1.0', mediaTypes: [MEDIA_PDF], languages: ['en'], features: ['text'], capabilityIds: ['parser.pdf.hybrid.text.en'], promotionStatus: 'ACCEPTED', loaded: true, ready: true },
    { providerRef: PROVIDER_DOCLING_DOCX, providerVersion: '0.1.0', mediaTypes: [MEDIA_DOCX], languages: ['en', 'ne', 'hi', 'mr'], features: ['text'], capabilityIds: ['parser.docx.text.en', 'parser.docx.text.ne', 'parser.docx.text.hi', 'parser.docx.text.mr'], promotionStatus: 'ACCEPTED', loaded: true, ready: true },
    { providerRef: PROVIDER_DOCLING_PPTX, providerVersion: '0.1.0', mediaTypes: [MEDIA_PPTX], languages: ['en', 'ne', 'hi', 'mr'], features: ['text'], capabilityIds: ['parser.pptx.text.en', 'parser.pptx.text.ne', 'parser.pptx.text.hi', 'parser.pptx.text.mr'], promotionStatus: 'ACCEPTED', loaded: true, ready: true },
    { providerRef: PROVIDER_DOCLING_XLSX, providerVersion: '0.1.0', mediaTypes: [MEDIA_XLSX], languages: ['en', 'ne', 'hi', 'mr'], features: ['tables'], capabilityIds: ['parser.xlsx.tables.en', 'parser.xlsx.tables.ne', 'parser.xlsx.tables.hi', 'parser.xlsx.tables.mr'], promotionStatus: 'ACCEPTED', loaded: true, ready: true },
    { providerRef: PROVIDER_RESILIENT_PARSER, providerVersion: '0.1.0', mediaTypes: [MEDIA_PNG], languages: ['en', 'ne', 'hi', 'mr'], features: ['fallback'], capabilityIds: ['fallback.image.paddle-to-tesseract.en', 'fallback.image.paddle-to-tesseract.ne', 'fallback.image.paddle-to-tesseract.hi', 'fallback.image.paddle-to-tesseract.mr'], promotionStatus: 'ACCEPTED', loaded: true, ready: true },
  ],
};

const clientFor = (wire: (operationId: string) => unknown | Promise<unknown>): DocumentIntelligenceClient =>
  new DocumentIntelligenceClient({ baseUrl: 'http://127.0.0.1:8765', fetchImpl: (async (url: string, init?: RequestInit) => respond(init?.method === 'GET' && String(url).endsWith('/v1/providers') ? catalog : await wire(operationIdOf(init)))) as typeof fetch });

const parseRequest = (mediaType: string, extra: Record<string, unknown> = {}): DocumentParseRequest => ({
  executionId: 'i4a-parse',
  source: { ownerRef: 'i4a-owner', documentId: 'i4a-doc', version: 1 },
  sourceMetadata: { mediaType, sizeBytes: 4 },
  content: { open: async function* () { yield new Uint8Array([80, 75, 3, 4]); } },
  limits: { maxSourceBytes: 1024, maxExternalCallMs: 10_000 },
  ...extra,
}) as unknown as DocumentParseRequest;

const wireFor = (operationId: string, providerRef: string, text = 'Name Alice') => ({
  protocolVersion: PROTOCOL_VERSION,
  operationId,
  providerRef,
  pages: [{
    pageNumber: 1,
    blocks: [{ blockId: 'b1', kind: 'TEXT', boundingRegion: { x: 0, y: 0, width: 1, height: 1 }, lines: [{ lineId: 'l1', text, boundingRegion: { x: 0, y: 0, width: 1, height: 1 } }] }],
    tables: [],
  }],
  providerProvenance: { providerRef, providerVersion: '0.1.0', modelRef: 'increment4a-pipeline', modelVersion: 'pinned-runtime' },
  quality: {},
});

describe('increment 4A Shared admission conformance', () => {
  it.each([
    ['hybrid scanned/mixed PDF', MEDIA_PDF, PROVIDER_HYBRID_PDF, (client: DocumentIntelligenceClient) => new HybridPdfParserAdapter(client), 'en'],
    ['DOCX', MEDIA_DOCX, PROVIDER_DOCLING_DOCX, (client: DocumentIntelligenceClient) => new DocxDocumentParserAdapter(client), 'en'],
    ['PPTX', MEDIA_PPTX, PROVIDER_DOCLING_PPTX, (client: DocumentIntelligenceClient) => new PptxDocumentParserAdapter(client), 'ne'],
    ['XLSX', MEDIA_XLSX, PROVIDER_DOCLING_XLSX, (client: DocumentIntelligenceClient) => new XlsxDocumentParserAdapter(client), 'hi'],
  ] as const)('admits %s output through public parser admission', async (_name, mediaType, providerRef, make, language) => {
    const adapter = make(clientFor((op) => wireFor(op, providerRef)));
    const result = await invokeDocumentParserWithCapabilityAdmission(adapter, parseRequest(mediaType, { languageHint: language }));
    expect(result.pages[0]?.blocks[0]?.lines[0]?.text).toBe('Name Alice');
    expect(result.providerProvenance.providerRef).toBe(providerRef);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('admits a resilient route result through public parser admission', async () => {
    const resilient = new ResilientParserAdapter(clientFor((op) => wireFor(op, PROVIDER_RESILIENT_PARSER)));
    const result = await invokeDocumentParserWithCapabilityAdmission(resilient, parseRequest(MEDIA_PNG));
    expect(result.providerProvenance.providerRef).toBe(PROVIDER_RESILIENT_PARSER);
  });

  it('refuses admission for language/media combinations absent from accepted catalog records', async () => {
    // The accepted artifact qualifies hybrid-pdf for `en` only and the
    // resilient route for `image/png` only; catalog-derived capabilities must
    // not let candidate constants widen admission.
    const hybrid = new HybridPdfParserAdapter(clientFor((op) => wireFor(op, PROVIDER_HYBRID_PDF)));
    await expect(invokeDocumentParserWithCapabilityAdmission(hybrid, parseRequest(MEDIA_PDF, { languageHint: 'ne' }))).rejects.toThrow();
    const resilient = new ResilientParserAdapter(clientFor((op) => wireFor(op, PROVIDER_RESILIENT_PARSER)));
    await expect(invokeDocumentParserWithCapabilityAdmission(resilient, parseRequest(MEDIA_DOCX))).rejects.toThrow();
  });

  it('malformed increment-4A provider output fails closed at admission', async () => {
    const adapter = new HybridPdfParserAdapter(clientFor((op) => ({ ...wireFor(op, PROVIDER_HYBRID_PDF), providerRef: 'ghatana.unexpected' })));
    await expect(invokeDocumentParserWithCapabilityAdmission(adapter, parseRequest(MEDIA_PDF))).rejects.toThrow();
  });
});
