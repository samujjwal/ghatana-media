import { describe, expect, it } from 'vitest';
import { DocumentExtractionError, type DocumentParseRequest } from '@ghatana/document-extraction';
import { DocumentIntelligenceClient } from '../src/client.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';
import { HybridPdfParserAdapter } from '../src/adapters/hybrid-pdf-parser.js';
import { DocxDocumentParserAdapter } from '../src/adapters/docx-document-parser.js';
import { PptxDocumentParserAdapter } from '../src/adapters/pptx-document-parser.js';
import { XlsxDocumentParserAdapter } from '../src/adapters/xlsx-document-parser.js';
import { WorkerDocumentParserAdapter } from '../src/adapters/ooxml-document-parser.js';
import {
  MEDIA_DOCX,
  MEDIA_PDF,
  MEDIA_PPTX,
  MEDIA_XLSX,
  PROVIDER_DOCLING_DOCX,
  PROVIDER_DOCLING_PPTX,
  PROVIDER_DOCLING_XLSX,
  PROVIDER_HYBRID_PDF,
} from '../src/media-types.js';

const respond = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Accepted catalog records mirroring `capabilities/increment4a.accepted.json`. */
const catalogEntry = (providerRef: string, mediaTypes: readonly string[], languages: readonly string[], features: readonly string[], capabilityIds: readonly string[], promotionStatus: 'ACCEPTED' | 'UNPROMOTED' = 'ACCEPTED') => ({
  providerRef,
  providerVersion: '0.1.0',
  mediaTypes: [...mediaTypes],
  languages: [...languages],
  features: [...features],
  capabilityIds: [...capabilityIds],
  promotionStatus,
  loaded: true,
  ready: true,
});

const acceptedCatalog = (entries: readonly ReturnType<typeof catalogEntry>[]) => ({
  protocolVersion: PROTOCOL_VERSION,
  providers: [...entries],
});

const defaultCatalog = () => acceptedCatalog([
  catalogEntry(PROVIDER_HYBRID_PDF, [MEDIA_PDF], ['en'], ['text'], ['parser.pdf.hybrid.text.en']),
  catalogEntry(PROVIDER_DOCLING_DOCX, [MEDIA_DOCX], ['en', 'ne', 'hi', 'mr'], ['text'], ['parser.docx.text.en', 'parser.docx.text.ne', 'parser.docx.text.hi', 'parser.docx.text.mr']),
  catalogEntry(PROVIDER_DOCLING_PPTX, [MEDIA_PPTX], ['en', 'ne', 'hi', 'mr'], ['text'], ['parser.pptx.text.en', 'parser.pptx.text.ne', 'parser.pptx.text.hi', 'parser.pptx.text.mr']),
  catalogEntry(PROVIDER_DOCLING_XLSX, [MEDIA_XLSX], ['en', 'ne', 'hi', 'mr'], ['tables'], ['parser.xlsx.tables.en', 'parser.xlsx.tables.ne', 'parser.xlsx.tables.hi', 'parser.xlsx.tables.mr']),
]);

const clientFor = (
  wire: (operationId: string, init?: RequestInit) => unknown | Promise<unknown>,
  catalog: unknown = defaultCatalog(),
): DocumentIntelligenceClient =>
  new DocumentIntelligenceClient({
    baseUrl: 'http://127.0.0.1:8765',
    fetchImpl: (async (url: string, init?: RequestInit) => {
      if (init?.method === 'GET' && String(url).endsWith('/v1/providers')) return respond(catalog);
      const body = init?.body;
      const metadata = body instanceof FormData ? body.get('metadata') : undefined;
      const operationId = typeof metadata === 'string' ? (JSON.parse(metadata) as { operationId: string }).operationId : 'unknown';
      return respond(await wire(operationId, init));
    }) as typeof fetch,
  });

const parseRequest = (mediaType: string, extra: Record<string, unknown> = {}): DocumentParseRequest => ({
  executionId: 'op-4a',
  source: { ownerRef: 'owner-1', documentId: 'doc-1', version: 1 },
  sourceMetadata: { mediaType, sizeBytes: 4 },
  content: { open: async function* () { yield new Uint8Array([80, 75, 3, 4]); } },
  limits: { maxSourceBytes: 1024, maxExternalCallMs: 5_000 },
  ...extra,
}) as unknown as DocumentParseRequest;

const wireFor = (operationId: string, providerRef: string, modelRef = 'docling-ooxml-pipeline', modelVersion = 'pinned-ooxml-runtime') => ({
  protocolVersion: PROTOCOL_VERSION,
  operationId,
  providerRef,
  pages: [{
    pageNumber: 1,
    blocks: [{ blockId: 'b1', kind: 'TEXT', boundingRegion: { x: 0, y: 0, width: 1, height: 1 }, lines: [{ lineId: 'l1', text: 'Hello', boundingRegion: { x: 0, y: 0, width: 1, height: 1 } }] }],
    tables: [],
  }],
  providerProvenance: { providerRef, providerVersion: '0.1.0', modelRef, modelVersion },
  quality: {},
});

describe('increment 4A parser adapters', () => {
  it.each([
    ['hybrid', new HybridPdfParserAdapter(clientFor((op) => wireFor(op, PROVIDER_HYBRID_PDF))), MEDIA_PDF, PROVIDER_HYBRID_PDF],
    ['docx', new DocxDocumentParserAdapter(clientFor((op) => wireFor(op, PROVIDER_DOCLING_DOCX))), MEDIA_DOCX, PROVIDER_DOCLING_DOCX],
    ['pptx', new PptxDocumentParserAdapter(clientFor((op) => wireFor(op, PROVIDER_DOCLING_PPTX))), MEDIA_PPTX, PROVIDER_DOCLING_PPTX],
    ['xlsx', new XlsxDocumentParserAdapter(clientFor((op) => wireFor(op, PROVIDER_DOCLING_XLSX))), MEDIA_XLSX, PROVIDER_DOCLING_XLSX],
  ] as const)('%s adapter parses its declared media type and maps output', async (_name, adapter, mediaType, providerRef) => {
    const result = await adapter.parse(parseRequest(mediaType, { languageHint: 'en' }));
    expect(result.pages[0]?.blocks[0]?.lines[0]?.text).toBe('Hello');
    expect(result.providerProvenance.providerRef).toBe(providerRef);
    expect(Object.isFrozen(result)).toBe(true);
    const capabilities = await adapter.capabilities();
    expect(capabilities.mediaTypes).toEqual([mediaType]);
  });

  it.each([
    ['hybrid', new HybridPdfParserAdapter(clientFor(() => { throw new Error('unused'); })), ['en'], false],
    ['docx', new DocxDocumentParserAdapter(clientFor(() => { throw new Error('unused'); })), ['en', 'ne', 'hi', 'mr'], false],
    ['pptx', new PptxDocumentParserAdapter(clientFor(() => { throw new Error('unused'); })), ['en', 'ne', 'hi', 'mr'], false],
    ['xlsx', new XlsxDocumentParserAdapter(clientFor(() => { throw new Error('unused'); })), ['en', 'ne', 'hi', 'mr'], true],
  ] as const)('%s adapter advertises only ACCEPTED catalog languages/features', async (_name, adapter, languages, supportsTables) => {
    const capabilities = await adapter.capabilities();
    expect(capabilities.supportedLanguages).toEqual(languages);
    expect(capabilities.supportsLanguages).toBe(true);
    expect(capabilities.supportsTables).toBe(supportsTables);
  });

  it('advertises nothing when the provider record is not ACCEPTED', async () => {
    const unpromoted = acceptedCatalog([catalogEntry(PROVIDER_DOCLING_DOCX, [], [], [], [], 'UNPROMOTED')]);
    const adapter = new DocxDocumentParserAdapter(clientFor(() => { throw new Error('unused'); }, unpromoted));
    const capabilities = await adapter.capabilities();
    expect(capabilities.mediaTypes).toEqual([]);
    expect(capabilities.supportedLanguages).toEqual([]);
  });

  it('advertises nothing when the provider is absent from the catalog', async () => {
    const adapter = new DocxDocumentParserAdapter(clientFor(() => { throw new Error('unused'); }, acceptedCatalog([])));
    const capabilities = await adapter.capabilities();
    expect(capabilities.mediaTypes).toEqual([]);
    expect(capabilities.supportedLanguages).toEqual([]);
  });

  it.each([
    ['hybrid', () => new HybridPdfParserAdapter(clientFor((op) => wireFor(op, PROVIDER_HYBRID_PDF))), MEDIA_DOCX],
    ['docx', () => new DocxDocumentParserAdapter(clientFor((op) => wireFor(op, PROVIDER_DOCLING_DOCX))), MEDIA_PDF],
    ['pptx', () => new PptxDocumentParserAdapter(clientFor((op) => wireFor(op, PROVIDER_DOCLING_PPTX))), MEDIA_XLSX],
    ['xlsx', () => new XlsxDocumentParserAdapter(clientFor((op) => wireFor(op, PROVIDER_DOCLING_XLSX))), MEDIA_PPTX],
  ] as const)('%s adapter rejects non-declared media types before transport', async (_name, make, mediaType) => {
    let calls = 0;
    const counting = new DocumentIntelligenceClient({ baseUrl: 'http://127.0.0.1:8765', fetchImpl: (async () => { calls += 1; return respond({}); }) as typeof fetch });
    void make;
    const adapter = _name === 'hybrid' ? new HybridPdfParserAdapter(counting) : _name === 'docx' ? new DocxDocumentParserAdapter(counting) : _name === 'pptx' ? new PptxDocumentParserAdapter(counting) : new XlsxDocumentParserAdapter(counting);
    await expect(adapter.parse(parseRequest(mediaType))).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
    expect(calls).toBe(0);
  });

  it.each([
    ['hybrid', () => new HybridPdfParserAdapter(clientFor((op) => wireFor(op, 'ghatana.docling'))), MEDIA_PDF],
    ['docx', () => new DocxDocumentParserAdapter(clientFor((op) => wireFor(op, 'ghatana.docling-pptx'))), MEDIA_DOCX],
  ] as const)('%s adapter fails closed when the wire providerRef does not match the requested provider', async (_name, make, mediaType) => {
    // Correlation + identity checks run before adapter provenance checks, so a
    // swapped provider fails closed as an invariant violation.
    await expect(make().parse(parseRequest(mediaType))).rejects.toMatchObject({ code: 'INTERNAL_INVARIANT' });
  });

  it('fails closed with PARSE_OUTPUT_INVALID when provenance modelRef violates adapter expectations', async () => {
    const adapter = new WorkerDocumentParserAdapter(
      clientFor((op) => wireFor(op, PROVIDER_DOCLING_DOCX, 'unexpected-model')),
      { providerRef: PROVIDER_DOCLING_DOCX, mediaTypes: [MEDIA_DOCX], expectedModelRef: 'docling-ooxml-pipeline' },
    );
    await expect(adapter.parse(parseRequest(MEDIA_DOCX))).rejects.toMatchObject({ code: 'PARSE_OUTPUT_INVALID' });
  });

  it('enforces maxSourceBytes before calling the worker', async () => {
    let calls = 0;
    const counting = new DocumentIntelligenceClient({ baseUrl: 'http://127.0.0.1:8765', fetchImpl: (async () => { calls += 1; return respond({}); }) as typeof fetch });
    const adapter = new DocxDocumentParserAdapter(counting);
    const oversized = parseRequest(MEDIA_DOCX);
    (oversized as { limits: Record<string, number> }).limits = { maxSourceBytes: 2 };
    await expect(adapter.parse(oversized)).rejects.toMatchObject({ code: 'SOURCE_TOO_LARGE' });
    expect(calls).toBe(0);
  });

  it('sends the declared providerRef and mediaType in parse metadata', async () => {
    let observed: Record<string, unknown> | undefined;
    const client = new DocumentIntelligenceClient({
      baseUrl: 'http://127.0.0.1:8765',
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        const body = init?.body;
        if (body instanceof FormData) observed = JSON.parse(String(body.get('metadata'))) as Record<string, unknown>;
        return respond(wireFor('op-4a', PROVIDER_DOCLING_XLSX));
      }) as typeof fetch,
    });
    const adapter = new XlsxDocumentParserAdapter(client);
    await adapter.parse(parseRequest(MEDIA_XLSX, { languageHint: 'hi' }));
    expect(observed?.providerRef).toBe(PROVIDER_DOCLING_XLSX);
    expect(observed?.mediaType).toBe(MEDIA_XLSX);
    expect(observed?.languageHint).toBe('hi');
    expect(observed?.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it('propagates worker errors through the shared error mapping', async () => {
    const failing = new DocumentIntelligenceClient({
      baseUrl: 'http://127.0.0.1:8765',
      fetchImpl: (async () => respond({ protocolVersion: PROTOCOL_VERSION, operationId: 'op-4a', code: 'UNSUPPORTED_LANGUAGE', retryable: false }, 400)) as typeof fetch,
    });
    await expect(new HybridPdfParserAdapter(failing).parse(parseRequest(MEDIA_PDF, { languageHint: 'fr' }))).rejects.toBeInstanceOf(DocumentExtractionError);
  });
});
