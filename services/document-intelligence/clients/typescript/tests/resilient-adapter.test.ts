import { describe, expect, it } from 'vitest';
import { DocumentExtractionError, type DocumentParseRequest, type ParsedDocument } from '@ghatana/document-extraction';
import { ResilientParserAdapter } from '../src/adapters/resilient-parser.js';
import type { DocumentIntelligenceClient } from '../src/client.js';
import type { WireParsedDocument } from '../src/protocol.js';
import { MEDIA_JPEG, MEDIA_PDF, MEDIA_PNG, PROVIDER_RESILIENT_PARSER } from '../src/media-types.js';

const request = (limits: Record<string, number> = {}, mediaType: string = MEDIA_PNG): DocumentParseRequest => ({
  executionId: 'op-resilient',
  source: { ownerRef: 'o', documentId: 'd', version: 1 },
  sourceMetadata: { mediaType, sizeBytes: 1 },
  content: { open: async function* () { yield new Uint8Array([1]); } },
  limits,
}) as unknown as DocumentParseRequest;

const wire = (providerRef: string = PROVIDER_RESILIENT_PARSER): WireParsedDocument => ({
  protocolVersion: 'document-intelligence.v1',
  operationId: 'op-resilient',
  providerRef,
  pages: [{ pageNumber: 1, blocks: [{ blockId: 'p1-b1', kind: 'TEXT', boundingRegion: { x: 0, y: 0, width: 1, height: 1 }, lines: [{ lineId: 'p1-b1-l1', text: 'ok', boundingRegion: { x: 0, y: 0, width: 1, height: 1 } }] }], tables: [] }],
  providerProvenance: { providerRef, providerVersion: '0.1.0', modelRef: 'route', modelVersion: 'route' },
  quality: { warnings: ['selectedProviderRef:ghatana.paddleocr'] },
} as WireParsedDocument);

// The accepted catalog surface under the increment4a profile admits the
// resilient route for image/png only — the media types the PNG image
// fallback was qualified on. JPEG stays with direct PaddleOCR.
const admittedCatalog = (mediaTypes: readonly string[] = [MEDIA_PNG]): unknown => ({
  protocolVersion: 'document-intelligence.v1',
  providers: [{
    providerRef: PROVIDER_RESILIENT_PARSER,
    providerVersion: '0.1.0',
    mediaTypes,
    languages: ['en', 'ne', 'hi', 'mr'],
    features: ['fallback'],
    capabilityIds: mediaTypes.flatMap(() => ['fallback.image.paddle-to-tesseract.en', 'fallback.image.paddle-to-tesseract.ne', 'fallback.image.paddle-to-tesseract.hi', 'fallback.image.paddle-to-tesseract.mr']),
    promotionStatus: 'ACCEPTED',
    loaded: true,
    ready: true,
  }],
});

interface Call { request: Record<string, unknown> }
const client = (impl: (request: Record<string, unknown>) => Promise<WireParsedDocument>, calls: Call[], catalog: unknown = admittedCatalog()): DocumentIntelligenceClient => ({
  parse: async (parseRequest: Record<string, unknown>) => { calls.push({ request: parseRequest }); return impl(parseRequest); },
  providers: async () => catalog,
}) as unknown as DocumentIntelligenceClient;

describe('resilient parser adapter (thin worker adapter)', () => {
  it('invokes the worker exactly once with the resilient provider ref', async () => {
    const calls: Call[] = [];
    const adapter = new ResilientParserAdapter(client(async () => wire(), calls));
    const result = await adapter.parse(request());
    expect(calls).toHaveLength(1);
    expect(calls[0].request.providerRef).toBe(PROVIDER_RESILIENT_PARSER);
    expect(result.providerProvenance.providerRef).toBe(PROVIDER_RESILIENT_PARSER);
  });

  it('never re-executes routing or retries locally on worker failure', async () => {
    const calls: Call[] = [];
    const adapter = new ResilientParserAdapter(client(async () => { throw new DocumentExtractionError('PARSER_UNAVAILABLE', { retryable: true }); }, calls));
    await expect(adapter.parse(request())).rejects.toMatchObject({ code: 'PARSER_UNAVAILABLE' });
    expect(calls).toHaveLength(1);
  });

  it('rejects a response whose provenance does not match the resilient route', async () => {
    const calls: Call[] = [];
    const adapter = new ResilientParserAdapter(client(async () => wire('ghatana.docling'), calls));
    await expect(adapter.parse(request())).rejects.toMatchObject({ code: 'PARSE_OUTPUT_INVALID' });
  });

  it('rejects media types absent from the accepted catalog without calling the worker', async () => {
    const calls: Call[] = [];
    const adapter = new ResilientParserAdapter(client(async () => wire(), calls));
    await expect(adapter.parse(request({}, 'image/tiff'))).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
    // JPEG fallback was never qualified: the resilient route is not admitted
    // for image/jpeg, so the adapter must not claim it even though a worker
    // route exists.
    await expect(adapter.parse(request({}, MEDIA_JPEG))).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
    await expect(adapter.parse(request({}, MEDIA_PDF))).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
    expect(calls).toHaveLength(0);
  });

  it('enforces the source byte ceiling before calling the worker', async () => {
    const calls: Call[] = [];
    const adapter = new ResilientParserAdapter(client(async () => wire(), calls));
    const input = request({ maxSourceBytes: 0 });
    await expect(adapter.parse(input)).rejects.toMatchObject({ code: 'SOURCE_TOO_LARGE' });
    expect(calls).toHaveLength(0);
  });

  it('bounds the worker call by the request external-call limit', async () => {
    const calls: Call[] = [];
    const adapter = new ResilientParserAdapter(client(async () => wire(), calls), 30_000);
    await adapter.parse(request({ maxExternalCallMs: 5_000 }));
    expect(calls[0].request.timeoutMs).toBe(5_000);
  });

  it('advertises only media types/languages/features from ACCEPTED catalog records', async () => {
    const catalog = {
      protocolVersion: 'document-intelligence.v1',
      providers: [{
        providerRef: PROVIDER_RESILIENT_PARSER,
        providerVersion: '0.1.0',
        mediaTypes: ['image/png'],
        languages: ['en', 'ne', 'hi', 'mr'],
        features: ['fallback'],
        capabilityIds: ['fallback.image.paddle-to-tesseract.en', 'fallback.image.paddle-to-tesseract.ne', 'fallback.image.paddle-to-tesseract.hi', 'fallback.image.paddle-to-tesseract.mr'],
        promotionStatus: 'ACCEPTED',
        loaded: true,
        ready: true,
      }],
    };
    const adapter = new ResilientParserAdapter(client(async () => wire(), [], catalog));
    const capabilities = await adapter.capabilities();
    expect(capabilities.mediaTypes).toEqual(['image/png']);
    expect(capabilities.mediaTypes).not.toContain(MEDIA_PDF);
    expect(capabilities.mediaTypes).not.toContain('image/tiff');
    expect(capabilities.supportedLanguages).toEqual(['en', 'ne', 'hi', 'mr']);
    expect(capabilities.supportsTables).toBe(false);
  });

  it('advertises nothing when the resilient route is not promoted', async () => {
    const adapter = new ResilientParserAdapter(client(async () => wire(), [], { protocolVersion: 'document-intelligence.v1', providers: [] }));
    const capabilities = await adapter.capabilities();
    expect(capabilities.mediaTypes).toEqual([]);
    expect(capabilities.supportedLanguages).toEqual([]);
  });
});
