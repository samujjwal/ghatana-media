import type { DocumentParserCapabilities, DocumentParserPort } from '@ghatana/document-extraction';
import { DocumentExtractionError } from '@ghatana/document-extraction';
import type { WireProviderCatalogEntry } from './protocol.js';
import { acceptedCatalogEntry, advertisedParserCapabilities } from './provider-catalog.js';
import { PROVIDER_RESILIENT_PARSER } from './media-types.js';

export type ParserProvider = 'DOCLING'|'PADDLEOCR';
export function selectParser(mediaType: string, parsers: { readonly docling: DocumentParserPort; readonly paddle: DocumentParserPort }): DocumentParserPort {
  if (mediaType === 'application/pdf') return parsers.docling;
  if (mediaType === 'image/png' || mediaType === 'image/jpeg') return parsers.paddle;
  throw new DocumentExtractionError('UNSUPPORTED_MEDIA_TYPE');
}
export function selectedProviderRef(mediaType: string): 'ghatana.docling'|'ghatana.paddleocr' {
  if (mediaType === 'application/pdf') return 'ghatana.docling';
  if (mediaType === 'image/png' || mediaType === 'image/jpeg') return 'ghatana.paddleocr';
  throw new DocumentExtractionError('UNSUPPORTED_MEDIA_TYPE');
}

/**
 * Client-side admittance view of `routing/parser-routing.v1.yaml`. The client
 * may check which media types are admitted, but route chains and fallback
 * policy are executed only inside the worker; this type intentionally carries
 * no fallback policy.
 */
export interface ParserRoutingPolicy {
  readonly routes: Readonly<Record<string, readonly string[]>>;
}

export function parserRoute(mediaType: string, policy: ParserRoutingPolicy): readonly string[] {
  const route = policy.routes[mediaType];
  if (route === undefined || route.length === 0) throw new DocumentExtractionError('UNSUPPORTED_MEDIA_TYPE');
  return route;
}

/**
 * Resolves the adapter for an admitted media type from the worker's accepted
 * `/v1/providers` catalog. Fallback qualification is per media type, so the
 * resilient route is selected only where the public authority admits it —
 * JPEG, for example, resolves to direct PaddleOCR because the image fallback
 * was qualified on `image/png` only. Otherwise the first ACCEPTED provider in
 * the worker's route order wins. The worker remains the single routing and
 * fallback authority; the client never reconstructs route chains or wraps
 * adapters in a local fallback executor.
 */
export function selectParserByPolicy(
  mediaType: string,
  registry: Readonly<Record<string, DocumentParserPort>>,
  policy: ParserRoutingPolicy,
  catalog: { readonly providers: readonly WireProviderCatalogEntry[] },
): DocumentParserPort {
  const route = parserRoute(mediaType, policy);
  const resilient = acceptedCatalogEntry(catalog, PROVIDER_RESILIENT_PARSER);
  if (resilient !== undefined && (resilient.mediaTypes ?? []).includes(mediaType)) {
    const adapter = registry[PROVIDER_RESILIENT_PARSER];
    if (adapter === undefined) throw new DocumentExtractionError('PARSER_UNAVAILABLE', { providerRef: PROVIDER_RESILIENT_PARSER });
    return adapter;
  }
  for (const providerRef of route) {
    const entry = acceptedCatalogEntry(catalog, providerRef);
    if (entry === undefined || !(entry.mediaTypes ?? []).includes(mediaType)) continue;
    const adapter = registry[providerRef];
    if (adapter === undefined) throw new DocumentExtractionError('PARSER_UNAVAILABLE', { providerRef });
    return adapter;
  }
  throw new DocumentExtractionError('PARSER_UNAVAILABLE', { providerRef: route[0] });
}

/**
 * Converts a validated `/v1/providers` catalog entry into Shared parser
 * capability shape so selection and preflight can consume the worker's
 * declared catalog instead of hard-coded adapter claims. Only `ACCEPTED`
 * entries contribute media types, languages, or features; unpromoted entries
 * advertise nothing.
 */
export function parserCapabilitiesFromCatalog(entry: WireProviderCatalogEntry): DocumentParserCapabilities {
  return advertisedParserCapabilities(entry) ?? { mediaTypes: [], supportedLanguages: [] };
}

/** Finds the catalog entry for a provider ref, or throws when absent/not ready. */
export function requireCatalogEntry(catalog: { readonly providers: readonly WireProviderCatalogEntry[] }, providerRef: string): WireProviderCatalogEntry {
  const entry = catalog.providers.find((provider) => provider.providerRef === providerRef);
  if (entry === undefined || !entry.ready) throw new DocumentExtractionError('PARSER_UNAVAILABLE', { providerRef });
  return entry;
}
