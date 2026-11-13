import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { acceptedCatalogEntry, advertisedParserCapabilities, advertisedParserCapabilitiesFor, isCapabilityPromoted, promotedCapabilityIds, reconcileProviderCatalog } from '../src/provider-catalog.js';
import { PROTOCOL_VERSION, type WireProviderCatalog } from '../src/protocol.js';

const catalog: WireProviderCatalog = {
  protocolVersion: PROTOCOL_VERSION,
  providers: [
    { providerRef: 'ghatana.paddleocr', providerVersion: '0.1.0', promotionStatus: 'UNPROMOTED', loaded: true, ready: true },
    { providerRef: 'ghatana.gliner', providerVersion: '0.1.0', promotionStatus: 'UNPROMOTED', loaded: true, ready: true },
  ],
};

describe('Increment-4A capability catalog reconciliation', () => {
  it('promotes only precise accepted capabilities from a promotable PASS artifact', () => {
    const artifact = {
      qualificationStatus: 'PASS' as const,
      promotable: true,
      accepted: [{ capabilityId: 'ocr.paddle.hi', providerRef: 'ghatana.paddleocr', language: 'hi' }],
      capabilities: [{ capabilityId: 'ocr.paddle.hi', state: 'QUALIFIED' as const, providerRef: 'ghatana.paddleocr' }],
    };
    const result = reconcileProviderCatalog(catalog, artifact);
    expect(result.providers[0]?.promotionStatus).toBe('ACCEPTED');
    expect(result.providers[1]?.promotionStatus).toBe('UNPROMOTED');
    expect(isCapabilityPromoted(artifact, 'ghatana.paddleocr', 'ocr.paddle.hi')).toBe(true);
    expect(isCapabilityPromoted(artifact, 'ghatana.paddleocr', 'extraction.gliner.hi')).toBe(false);
  });

  it('never promotes from QUALIFIED projection leaves without accepted records', () => {
    for (const artifact of [
      { qualificationStatus: 'PASS' as const, promotable: false, accepted: [], capabilities: [{ capabilityId: 'ocr.paddle.hi', state: 'QUALIFIED' as const, providerRef: 'ghatana.paddleocr' }] },
      { qualificationStatus: 'NOT_RUN' as const, capabilities: [{ capabilityId: 'ocr.paddle.hi', state: 'QUALIFIED' as const, providerRef: 'ghatana.paddleocr' }] },
      { qualificationStatus: 'PASS' as const, capabilities: [{ capabilityId: 'ocr.paddle.hi', state: 'QUALIFIED' as const, providerRef: 'ghatana.paddleocr' }] },
    ]) {
      const result = reconcileProviderCatalog(catalog, artifact);
      expect(result.providers[0]?.promotionStatus).toBe('UNPROMOTED');
      expect(isCapabilityPromoted(artifact, 'ghatana.paddleocr', 'ocr.paddle.hi')).toBe(false);
    }
  });

  it('rejects broad language claims from promotion', () => {
    const artifact = { qualificationStatus: 'PASS' as const, accepted: [{ providerRef: 'ghatana.paddleocr', capability: 'language.hi' }] };
    const result = reconcileProviderCatalog(catalog, artifact);
    expect(result.providers[0]?.promotionStatus).toBe('UNPROMOTED');
  });

  it('the canonical accepted artifact keeps deferred GLiNER hi/mr extraction unpromoted', async () => {
    const artifact = JSON.parse(
      await readFile(resolve(import.meta.dirname, '../../../capabilities/increment4a.accepted.json'), 'utf8'),
    );
    expect(artifact.qualificationStatus).toBe('PASS');
    expect(artifact.promotable).toBe(true);
    const ids = (artifact.accepted as readonly { capabilityId: string }[]).map((item) => item.capabilityId);
    expect(ids).toContain('ocr.paddle.hi');
    expect(ids).toContain('ocr.paddle.mr');
    expect(ids).toContain('parser.pdf.hybrid.text.hi');
    expect(ids).toContain('parser.pdf.hybrid.text.mr');
    expect(ids).toContain('fallback.pdf-ocr-region.paddle-to-tesseract.mr');
    expect(ids).not.toContain('extraction.schema-guided.hi');
    expect(ids).not.toContain('extraction.schema-guided.mr');
    expect(ids).not.toContain('parser.pdf.hybrid.tables.scanned.en');
    // GLiNER hi/mr are NOT_QUALIFIED / DEFERRED_TO_FUTURE_RELEASE: the delta
    // artifact carries no GLiNER records at all, so nothing can be promoted
    // for it from this artifact — even though the multilingual model could
    // physically emit candidates.
    expect(promotedCapabilityIds(artifact, 'ghatana.gliner')).toEqual([]);
  });
});

describe('catalog-derived advertised capabilities', () => {
  const acceptedEntry = {
    providerRef: 'ghatana.docling-xlsx',
    providerVersion: '0.1.0',
    mediaTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    languages: ['en', 'ne', 'hi', 'mr'],
    features: ['tables'],
    capabilityIds: ['parser.xlsx.tables.en', 'parser.xlsx.tables.ne', 'parser.xlsx.tables.hi', 'parser.xlsx.tables.mr'],
    promotionStatus: 'ACCEPTED' as const,
    loaded: true,
    ready: true,
  };

  it('derives media types, languages, and features only from ACCEPTED records', () => {
    expect(advertisedParserCapabilities(acceptedEntry)).toEqual({
      mediaTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      supportedLanguages: ['en', 'ne', 'hi', 'mr'],
      supportsLanguages: true,
      supportsTables: true,
      supportsCoordinates: false,
    });
  });

  it('advertises nothing for UNPROMOTED, absent, or unpromoted-looking entries', () => {
    expect(advertisedParserCapabilities({ ...acceptedEntry, promotionStatus: 'UNPROMOTED' as const })).toBeUndefined();
    expect(advertisedParserCapabilities(undefined)).toBeUndefined();
    expect(acceptedCatalogEntry({ providers: [{ ...acceptedEntry, promotionStatus: 'UNPROMOTED' as const }] }, 'ghatana.docling-xlsx')).toBeUndefined();
    expect(acceptedCatalogEntry({ providers: [acceptedEntry] }, 'ghatana.gliner')).toBeUndefined();
  });

  it('advertisedParserCapabilitiesFor fetches the catalog and derives empty sets for unpromoted providers', async () => {
    const source = {
      providers: async () => ({
        protocolVersion: PROTOCOL_VERSION,
        providers: [acceptedEntry, { providerRef: 'ghatana.gliner', providerVersion: '0.1.0', promotionStatus: 'UNPROMOTED' as const, loaded: true, ready: true }],
      }),
    };
    expect((await advertisedParserCapabilitiesFor(source, 'ghatana.docling-xlsx')).supportedLanguages).toEqual(['en', 'ne', 'hi', 'mr']);
    expect(await advertisedParserCapabilitiesFor(source, 'ghatana.gliner')).toEqual({ mediaTypes: [], supportedLanguages: [] });
    expect(await advertisedParserCapabilitiesFor(source, 'ghatana.missing')).toEqual({ mediaTypes: [], supportedLanguages: [] });
  });
});
