import { describe, expect, it } from 'vitest';
import { DocumentExtractionError } from '@ghatana/document-extraction';
import { DocumentIntelligenceClient } from '../src/client.js';
import { LEGACY_WORKER_CAPABILITY_VERSION, PROTOCOL_VERSION, WORKER_CAPABILITY_VERSIONS, type WireProviderCatalog } from '../src/protocol.js';
import { parserCapabilitiesFromCatalog, requireCatalogEntry } from '../src/selection.js';

const catalog = (): WireProviderCatalog => ({
  protocolVersion: PROTOCOL_VERSION,
  providers: [
    { providerRef: 'ghatana.docling', providerVersion: '0.1.0', modelRef: 'docling-standard-pdf-pipeline', modelVersion: 'pinned-docling-runtime', mediaTypes: ['application/pdf'], supportedLanguages: ['en', 'ne'], supportsTables: true, supportsCoordinates: true, supportsLanguages: true, promotionStatus: 'ACCEPTED', loaded: true, ready: true },
    { providerRef: 'ghatana.docling-docx', providerVersion: '0.1.0', mediaTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], languages: ['en', 'ne', 'hi', 'mr'], features: ['text'], capabilityIds: ['parser.docx.text.en', 'parser.docx.text.ne', 'parser.docx.text.hi', 'parser.docx.text.mr'], promotionStatus: 'ACCEPTED', loaded: true, ready: true },
    { providerRef: 'ghatana.tesseractocr', providerVersion: '0.1.0', mediaTypes: ['application/pdf'], promotionStatus: 'UNPROMOTED', loaded: true, ready: false },
  ],
});

const clientFor = (body: unknown, status = 200): DocumentIntelligenceClient =>
  new DocumentIntelligenceClient({ baseUrl: 'http://127.0.0.1:8765', fetchImpl: (async () => new Response(JSON.stringify(body), { status })) as typeof fetch });

describe('GET /v1/providers catalog', () => {
  it('returns a validated catalog', async () => {
    const result = await clientFor(catalog()).providers();
    expect(result.providers).toHaveLength(3);
    expect(result.providers[1]?.providerRef).toBe('ghatana.docling-docx');
  });

  it('issues a GET to /v1/providers', async () => {
    let observed: { url: string; method?: string } | undefined;
    const client = new DocumentIntelligenceClient({
      baseUrl: 'http://127.0.0.1:8765',
      fetchImpl: (async (url: string, init?: RequestInit) => { observed = { url, method: init?.method }; return new Response(JSON.stringify(catalog())); }) as typeof fetch,
    });
    await client.providers();
    expect(observed?.url).toBe('http://127.0.0.1:8765/v1/providers');
    expect(observed?.method).toBe('GET');
  });

  it.each([
    ['unknown keys', { protocolVersion: PROTOCOL_VERSION, providers: [], leak: true }],
    ['wrong protocol version', { protocolVersion: 'v0', providers: [] }],
    ['oversized catalog', { protocolVersion: PROTOCOL_VERSION, providers: Array.from({ length: 257 }, (_, i) => ({ providerRef: `p${i}`, providerVersion: '1', promotionStatus: 'UNPROMOTED', loaded: true, ready: true })) }],
    ['entry missing ready flag', { protocolVersion: PROTOCOL_VERSION, providers: [{ providerRef: 'p', providerVersion: '1', promotionStatus: 'UNPROMOTED', loaded: true }] }],
    ['invalid promotion status', { protocolVersion: PROTOCOL_VERSION, providers: [{ providerRef: 'p', providerVersion: '1', promotionStatus: 'ACTIVE', loaded: true, ready: true }] }],
    ['non-string media type', { protocolVersion: PROTOCOL_VERSION, providers: [{ providerRef: 'p', providerVersion: '1', mediaTypes: [7], promotionStatus: 'UNPROMOTED', loaded: true, ready: true }] }],
    ['malformed provider ref', { protocolVersion: PROTOCOL_VERSION, providers: [{ providerRef: 'bad ref!', providerVersion: '1', promotionStatus: 'UNPROMOTED', loaded: true, ready: true }] }],
  ])('rejects malformed catalog: %s', async (_name, body) => {
    await expect(clientFor(body).providers()).rejects.toThrow();
  });

  it('accepts accepted-record capabilityIds/languages/features fields', async () => {
    const result = await clientFor(catalog()).providers();
    const docx = result.providers.find((provider) => provider.providerRef === 'ghatana.docling-docx');
    expect(docx?.capabilityIds).toContain('parser.docx.text.mr');
    expect(docx?.languages).toEqual(['en', 'ne', 'hi', 'mr']);
    expect(docx?.features).toEqual(['text']);
  });

  it('validates exact language-specific Paddle model identities', async () => {
    const paddle = {
      protocolVersion: PROTOCOL_VERSION,
      providers: [{
        providerRef: 'ghatana.paddleocr',
        providerVersion: '0.1.0',
        modelRef: 'PP-OCRv5-en',
        modelVersion: 'PP-OCRv5-local-en',
        languageModelIdentities: [
          { language: 'en', modelRef: 'PP-OCRv5-en', modelVersion: 'PP-OCRv5-local-en' },
          { language: 'ne', modelRef: 'PP-OCRv5-devanagari-shared', modelVersion: 'PP-OCRv5-local-devanagari-shared' },
        ],
        languages: ['en', 'ne'],
        mediaTypes: ['image/png', 'image/jpeg'],
        promotionStatus: 'ACCEPTED',
        loaded: true,
        ready: true,
      }],
    };
    const result = await clientFor(paddle).providers();
    expect(result.providers[0]?.languageModelIdentities).toEqual(paddle.providers[0].languageModelIdentities);
    await expect(clientFor({
      ...paddle,
      providers: [{ ...paddle.providers[0], languageModelIdentities: [{ language: 'english', modelRef: 'PP-OCRv5-en', modelVersion: 'PP-OCRv5-local-en' }] }],
    }).providers()).rejects.toThrow();
  });

  it('records the legacy capability version when the catalog declares none', async () => {
    const client = clientFor(catalog());
    expect(client.lastWorkerCapabilityVersion).toBeUndefined();
    const result = await client.providers();
    expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(client.lastProtocolVersion).toBe(PROTOCOL_VERSION);
    expect(client.lastWorkerCapabilityVersion).toBe(LEGACY_WORKER_CAPABILITY_VERSION);
  });

  it('records a declared workerCapabilityVersion inside the supported set', async () => {
    const client = clientFor({ ...catalog(), workerCapabilityVersion: 'document-intelligence-worker.v1' });
    const result = await client.providers();
    expect(result.workerCapabilityVersion).toBe('document-intelligence-worker.v1');
    expect(client.lastWorkerCapabilityVersion).toBe('document-intelligence-worker.v1');
    expect(WORKER_CAPABILITY_VERSIONS).toContain(client.lastWorkerCapabilityVersion);
  });

  it('rejects a workerCapabilityVersion outside the supported set', async () => {
    const client = clientFor({ ...catalog(), workerCapabilityVersion: 'document-intelligence-worker.v99' });
    await expect(client.providers()).rejects.toMatchObject({ code: 'INTERNAL_INVARIANT' });
    expect(client.lastWorkerCapabilityVersion).toBeUndefined();
  });

  it('rejects a non-string workerCapabilityVersion', async () => {
    await expect(clientFor({ ...catalog(), workerCapabilityVersion: 7 }).providers()).rejects.toThrow();
  });

  it('maps ACCEPTED catalog entries to Shared parser capabilities from accepted records', () => {
    const entry = requireCatalogEntry(catalog(), 'ghatana.docling-docx');
    expect(parserCapabilitiesFromCatalog(entry)).toEqual({
      mediaTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      supportedLanguages: ['en', 'ne', 'hi', 'mr'],
      supportsLanguages: true,
      supportsTables: false,
      supportsCoordinates: false,
    });
  });

  it('derives no advertised capabilities from UNPROMOTED catalog entries', () => {
    const entry = requireCatalogEntry(catalog(), 'ghatana.docling');
    const unpromoted = { ...entry, promotionStatus: 'UNPROMOTED' as const, supportedLanguages: ['en', 'ne', 'hi', 'mr'] };
    expect(parserCapabilitiesFromCatalog(unpromoted)).toEqual({ mediaTypes: [], supportedLanguages: [] });
  });

  it('requireCatalogEntry fails closed for absent or not-ready providers', () => {
    expect(() => requireCatalogEntry(catalog(), 'ghatana.missing')).toThrow(DocumentExtractionError);
    try {
      requireCatalogEntry(catalog(), 'ghatana.tesseractocr');
      expect.unreachable('not-ready providers must be rejected');
    } catch (error) {
      expect(error).toMatchObject({ code: 'PARSER_UNAVAILABLE' });
    }
  });
});
