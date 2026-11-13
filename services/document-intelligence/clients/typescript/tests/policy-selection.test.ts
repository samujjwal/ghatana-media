import { describe, expect, it } from 'vitest';
import { DocumentExtractionError, type DocumentParserPort, type ParsedDocument } from '@ghatana/document-extraction';
import { parserRoute, selectParserByPolicy, type ParserRoutingPolicy } from '../src/selection.js';
import type { WireProviderCatalogEntry } from '../src/protocol.js';
import { MEDIA_DOCX, MEDIA_JPEG, MEDIA_PDF, MEDIA_PNG, PROVIDER_RESILIENT_PARSER } from '../src/media-types.js';

const stub = (marker: string): DocumentParserPort => ({
  capabilities: async () => ({ mediaTypes: [MEDIA_PDF] }),
  parse: async () => ({ providerProvenance: { providerRef: marker, providerVersion: '0.1.0' } }) as unknown as ParsedDocument,
});

const entry = (providerRef: string, mediaTypes: readonly string[], promotionStatus: 'ACCEPTED' | 'UNPROMOTED' = 'ACCEPTED'): WireProviderCatalogEntry => ({
  providerRef,
  providerVersion: '0.1.0',
  mediaTypes,
  promotionStatus,
  loaded: true,
  ready: true,
});

const resilient = stub(PROVIDER_RESILIENT_PARSER);
const hybrid = stub('ghatana.hybrid-pdf');
const docling = stub('ghatana.docling');
const paddle = stub('ghatana.paddleocr');
const docxParser = stub('ghatana.docling-docx');

// Mirrors routing/parser-routing.v1.yaml — the client-side admittance view.
const policy: ParserRoutingPolicy = {
  routes: {
    [MEDIA_PDF]: ['ghatana.hybrid-pdf', 'ghatana.docling'],
    [MEDIA_PNG]: ['ghatana.paddleocr', 'ghatana.tesseractocr'],
    [MEDIA_JPEG]: ['ghatana.paddleocr', 'ghatana.tesseractocr'],
    [MEDIA_DOCX]: ['ghatana.docling-docx'],
  },
};

// Mirrors the accepted /v1/providers surface under the increment4a profile:
// the resilient route is admitted for image/png only — JPEG fallback was
// never qualified, so JPEG resolves to direct PaddleOCR.
const catalog = {
  providers: [
    entry('ghatana.hybrid-pdf', [MEDIA_PDF]),
    entry('ghatana.docling', [MEDIA_PDF]),
    entry('ghatana.paddleocr', [MEDIA_PNG, MEDIA_JPEG]),
    entry('ghatana.docling-docx', [MEDIA_DOCX]),
    entry(PROVIDER_RESILIENT_PARSER, [MEDIA_PNG]),
  ],
};

const registry = {
  'ghatana.hybrid-pdf': hybrid,
  'ghatana.docling': docling,
  'ghatana.paddleocr': paddle,
  'ghatana.docling-docx': docxParser,
  [PROVIDER_RESILIENT_PARSER]: resilient,
};

describe('policy-based parser selection', () => {
  it('selects the worker resilient parser only where the authority admits it', () => {
    expect(selectParserByPolicy(MEDIA_PNG, registry, policy, catalog)).toBe(resilient);
  });

  it('selects the first accepted route provider when the resilient route is not admitted for the media type', () => {
    expect(selectParserByPolicy(MEDIA_PDF, registry, policy, catalog)).toBe(hybrid);
    expect(selectParserByPolicy(MEDIA_DOCX, registry, policy, catalog)).toBe(docxParser);
  });

  it('selects direct PaddleOCR for JPEG — JPEG fallback is NOT_EVALUATED and never claimed', () => {
    expect(selectParserByPolicy(MEDIA_JPEG, registry, policy, catalog)).toBe(paddle);
  });

  it('never constructs client-side fallback chains for multi-candidate routes', () => {
    // The worker owns route/fallback authority. Even when the resilient
    // adapter is registered, a route the authority does not admit it for
    // resolves to the route's accepted leaf provider instead.
    const adapter = selectParserByPolicy(MEDIA_PDF, registry, policy, catalog);
    expect(adapter).toBe(hybrid);
    expect(adapter).not.toBe(resilient);
  });

  it('walks the route order to the next accepted provider', () => {
    const partial = { providers: [entry('ghatana.docling', [MEDIA_PDF]), entry('ghatana.hybrid-pdf', [MEDIA_PDF], 'UNPROMOTED')] };
    expect(selectParserByPolicy(MEDIA_PDF, registry, policy, partial)).toBe(docling);
  });

  it('rejects media types without a declared route', () => {
    expect(() => parserRoute('image/tiff', { routes: {} })).toThrow(DocumentExtractionError);
    expect(() => selectParserByPolicy('text/plain', registry, { routes: {} }, catalog)).toThrow(DocumentExtractionError);
  });

  it('fails when no route provider is admitted for the media type', () => {
    const empty = { providers: [] as readonly WireProviderCatalogEntry[] };
    expect(() => selectParserByPolicy(MEDIA_PDF, registry, policy, empty)).toThrow(DocumentExtractionError);
  });

  it('fails when the selected provider adapter is not registered', () => {
    try {
      selectParserByPolicy(MEDIA_PDF, { [PROVIDER_RESILIENT_PARSER]: resilient }, policy, catalog);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'PARSER_UNAVAILABLE', providerRef: 'ghatana.hybrid-pdf' });
    }
  });

  it('fails when the resilient parser is admitted but not registered', () => {
    const onlyResilient = { providers: [entry(PROVIDER_RESILIENT_PARSER, [MEDIA_PNG])] };
    try {
      selectParserByPolicy(MEDIA_PNG, {}, policy, onlyResilient);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'PARSER_UNAVAILABLE', providerRef: PROVIDER_RESILIENT_PARSER });
    }
  });

  it('rejects empty route declarations', () => {
    expect(() => parserRoute(MEDIA_PDF, { routes: { [MEDIA_PDF]: [] } })).toThrow(DocumentExtractionError);
  });
});
