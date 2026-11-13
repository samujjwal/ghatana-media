import { describe, expect, it } from 'vitest';
import {
  invokeDocumentParserWithCapabilityAdmission,
  invokeEmbeddingWithCapabilityAdmission,
  invokeFieldExtractionWithCapabilityAdmission,
  type DocumentParseRequest,
  type FieldExtractionRequest,
  type StructureEmbeddingRequest,
} from '@ghatana/document-extraction';
import { DoclingDocumentParserAdapter } from '../src/adapters/docling-document-parser.js';
import { GlinerFieldExtractionAdapter } from '../src/adapters/gliner-field-extractor.js';
import { MiniLmStructureEmbeddingAdapter } from '../src/adapters/minilm-structure-embedding.js';
import { DocumentIntelligenceClient } from '../src/client.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';

const identity = { providerRef: 'ghatana.gliner', providerVersion: '0.1.0', modelRef: 'urchade/gliner_multi-v2.1', modelVersion: '443d26d' };
const json = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
/** Catalog fixture: capabilities are only advertised from ACCEPTED records. */
const catalog = {
  protocolVersion: PROTOCOL_VERSION,
  providers: [
    { providerRef: 'ghatana.docling', providerVersion: '0.1.0', mediaTypes: ['application/pdf'], languages: ['en', 'ne'], features: ['text'], capabilityIds: ['parser.pdf.docling.text.en', 'parser.pdf.docling.text.ne'], promotionStatus: 'ACCEPTED', loaded: true, ready: true },
    { providerRef: 'ghatana.gliner', providerVersion: '0.1.0', languages: ['en'], features: ['extraction'], capabilityIds: ['extraction.gliner.en'], promotionStatus: 'ACCEPTED', loaded: true, ready: true },
    { providerRef: 'ghatana.minilm', providerVersion: '0.1.0', capabilityIds: ['embedding.minilm.384'], promotionStatus: 'ACCEPTED', loaded: true, ready: true },
  ],
};
const client = (response: unknown): DocumentIntelligenceClient => new DocumentIntelligenceClient({
  baseUrl: 'http://127.0.0.1:8765',
  fetchImpl: (async (_url: string, init?: RequestInit) => json(init?.method === 'GET' ? catalog : response)) as typeof fetch,
});

const parseRequest = (): DocumentParseRequest => ({
  executionId: 'parse-1',
  source: { ownerRef: 'owner-1', documentId: 'document-1', version: 1 },
  sourceMetadata: { mediaType: 'application/pdf', sizeBytes: 4 },
  content: { open: async function* () { yield new Uint8Array([37, 80, 68, 70]); } },
  limits: { maxSourceBytes: 1024, maxExternalCallMs: 1000 },
}) as unknown as DocumentParseRequest;

const embeddingRequest = (): StructureEmbeddingRequest => ({
  executionId: 'embed-1',
  descriptor: { pageCount: 1, blockKindCounts: { TEXT: 1 }, tableShapes: [], normalizedBlockGeometry: [{ pageNumber: 1, blockId: 'p1-b1', x: 0, y: 0, width: 1, height: 1 }], semanticTextBasis: 'Name Alice', structuralFingerprint: 'fixture-1' },
});

describe('frozen Shared provider conformance seam', () => {
  it('admits a real Docling adapter result through public parser admission', async () => {
    const adapter = new DoclingDocumentParserAdapter(client({ protocolVersion: PROTOCOL_VERSION, operationId: 'parse-1', providerRef: 'ghatana.docling', pages: [{ pageNumber: 1, blocks: [{ blockId: 'p1-b1', kind: 'TEXT', boundingRegion: { x: 0, y: 0, width: 1, height: 1 }, lines: [{ lineId: 'p1-b1-l1', text: 'Name Alice', boundingRegion: { x: 0, y: 0, width: 1, height: 1 } }] }], tables: [] }], providerProvenance: { providerRef: 'ghatana.docling', providerVersion: '0.1.0', modelRef: 'docling-standard-pdf-pipeline', modelVersion: 'pinned-docling-runtime' }, quality: {} }));
    const result = await invokeDocumentParserWithCapabilityAdmission(adapter, parseRequest());
    expect(result.pages[0]?.blocks[0]?.lines[0]?.text).toBe('Name Alice');
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('admits GLiNER evidence through public field-extraction admission', async () => {
    const parsedDocument = { source: { ownerRef: 'owner-1', documentId: 'document-1', version: 1 }, pages: [{ pageNumber: 1, blocks: [{ blockId: 'p1-b1', kind: 'TEXT', boundingRegion: { x: 0, y: 0, width: 1, height: 1 }, lines: [{ lineId: 'p1-b1-l1', text: 'Name Alice', boundingRegion: { x: 0, y: 0, width: 1, height: 1 } }] }], tables: [] }], providerProvenance: { providerRef: 'ghatana.docling', providerVersion: '0.1.0' }, quality: {} };
    const schema = { ref: { schemaId: 'schema-1', version: 1 }, additionalFields: 'REJECT', fields: [{ fieldId: 'name', aliases: ['Name'], valueType: 'TEXT', cardinality: 'SINGLE', required: true, normalizers: [], validators: [], confidencePolicy: { minimum: 0.8 } }] };
    const request = { executionId: 'extract-1', schema, parsedDocument, requestedFieldIds: ['name'] } as unknown as FieldExtractionRequest;
    const adapter = new GlinerFieldExtractionAdapter(client({ protocolVersion: PROTOCOL_VERSION, operationId: 'extract-1', providerRef: 'ghatana.gliner', candidates: [{ fieldId: 'name', value: { kind: 'TEXT', value: 'Alice' }, source: 'MODEL', confidence: 0.9, evidence: [{ pageNumber: 1, blockId: 'p1-b1', lineId: 'p1-b1-l1', textSpan: { start: 5, end: 10 } }], provider: identity }], provider: identity }));
    const result = await invokeFieldExtractionWithCapabilityAdmission(adapter, request);
    expect(result.candidates[0]?.value).toMatchObject({ kind: 'TEXT', value: 'Alice' });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('admits exactly 384 finite MiniLM dimensions through public embedding admission', async () => {
    const adapter = new MiniLmStructureEmbeddingAdapter(client({ protocolVersion: PROTOCOL_VERSION, operationId: 'embed-1', providerRef: 'ghatana.minilm', model: { providerRef: 'ghatana.minilm', providerVersion: '0.1.0', modelRef: 'sentence-transformers/all-MiniLM-L6-v2', modelVersion: '1110a24' }, dimensions: 384, values: Array.from({ length: 384 }, () => 0.01) }));
    const result = await invokeEmbeddingWithCapabilityAdmission(adapter, embeddingRequest());
    expect(result.dimensions).toBe(384);
    expect(result.values).toHaveLength(384);
  });
});
