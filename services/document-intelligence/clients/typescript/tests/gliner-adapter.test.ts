import { describe, expect, it } from 'vitest';
import { DocumentIntelligenceClient } from '../src/client.js';
import { GlinerFieldExtractionAdapter } from '../src/adapters/gliner-field-extractor.js';
import { PROTOCOL_VERSION, type WireProviderCatalog } from '../src/protocol.js';

const clientFor = (catalog: WireProviderCatalog): DocumentIntelligenceClient =>
  new DocumentIntelligenceClient({
    baseUrl: 'http://127.0.0.1:8765',
    fetchImpl: (async () => new Response(JSON.stringify(catalog), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch,
  });

const catalogWith = (promotionStatus: 'ACCEPTED' | 'UNPROMOTED', extra: Record<string, unknown> = {}): WireProviderCatalog => ({
  protocolVersion: PROTOCOL_VERSION,
  providers: [{ providerRef: 'ghatana.gliner', providerVersion: '0.1.0', promotionStatus, loaded: true, ready: true, ...extra }],
});

describe('GLiNER adapter', () => {
  it('is present as the model-only field extractor', () => {
    expect(GlinerFieldExtractionAdapter).toBeDefined();
  });

  it('advertises no capabilities — and no hi/mr language coverage — while the catalog entry is unpromoted', async () => {
    // `capabilities/increment4a.accepted.json` contains no ghatana.gliner
    // records: GLiNER hi/mr extraction is measured below its acceptance
    // threshold (NOT_QUALIFIED / DEFERRED_TO_FUTURE_RELEASE) and must not be
    // advertised even though the model is multilingual.
    const adapter = new GlinerFieldExtractionAdapter(clientFor(catalogWith('UNPROMOTED')));
    const capabilities = await adapter.capabilities();
    expect(capabilities).toEqual({});
    expect(capabilities).not.toHaveProperty('supportedLanguages');
  });

  it('advertises nothing when GLiNER is absent from the catalog entirely', async () => {
    const adapter = new GlinerFieldExtractionAdapter(clientFor({ protocolVersion: PROTOCOL_VERSION, providers: [] }));
    expect(await adapter.capabilities()).toEqual({});
  });

  it('advertises extraction capabilities only when the catalog entry is ACCEPTED', async () => {
    const adapter = new GlinerFieldExtractionAdapter(clientFor(catalogWith('ACCEPTED', {
      languages: ['en'],
      features: ['extraction'],
      capabilityIds: ['extraction.gliner.en'],
    })));
    const capabilities = await adapter.capabilities();
    expect(capabilities.supportedValueTypes).toEqual(['TEXT', 'IDENTIFIER']);
    expect(capabilities.supportsConfidenceScores).toBe(true);
    expect(capabilities.supportsMultipleCardinality).toBe(true);
  });
});
