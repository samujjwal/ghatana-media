import type { DocumentParserCapabilities } from '@ghatana/document-extraction';
import type { WireProviderCatalog, WireProviderCatalogEntry } from './protocol.js';

export type Increment4ACapabilityState = 'QUALIFIED' | 'NOT_QUALIFIED' | 'NOT_EVALUATED' | 'UNSUPPORTED_BY_DESIGN';

export interface PromotedCapability {
  readonly capabilityId: string;
  readonly state: Increment4ACapabilityState;
  readonly providerRef?: string;
  readonly language?: string;
  readonly feature?: string;
}

export interface Increment4ACapabilityArtifact {
  readonly qualificationStatus: 'PASS' | 'FAIL' | 'NOT_RUN' | 'NOT_QUALIFIED' | 'NOT_EVALUATED';
  readonly promotable?: boolean;
  readonly capabilities?: readonly PromotedCapability[];
  readonly accepted?: readonly ({ readonly capabilityId?: string; readonly capability?: string; readonly providerRef: string; readonly language?: string; readonly feature?: string })[];
}

const preciseId = (item: { readonly capabilityId?: string; readonly capability?: string }): string | undefined => {
  const id = item.capabilityId ?? item.capability;
  return typeof id === 'string' && id.length > 0 && !id.startsWith('language.') ? id : undefined;
};

/**
 * Return the exact accepted capability IDs for a provider.
 * `capabilities[].state === 'QUALIFIED'` is a dimensional measurement, not an
 * admission: a PRE_FROZEN campaign may produce QUALIFIED leaves while
 * `promotable` is false. The only consumer-facing promotion authority is
 * `accepted[]`, consumed solely from a promotable PASS artifact.
 */
export function promotedCapabilityIds(artifact: Increment4ACapabilityArtifact, providerRef: string): readonly string[] {
  if (artifact.qualificationStatus !== 'PASS' || artifact.promotable !== true || !Array.isArray(artifact.accepted)) return [];
  const ids = new Set<string>();
  for (const item of artifact.accepted) if (item.providerRef === providerRef) {
    const id = preciseId(item);
    if (id !== undefined) ids.add(id);
  }
  return [...ids].sort();
}

export function isCapabilityPromoted(artifact: Increment4ACapabilityArtifact, providerRef: string, capabilityId: string): boolean {
  return promotedCapabilityIds(artifact, providerRef).includes(capabilityId);
}

/**
 * Project the canonical evidence artifact onto the wire catalog. Provider
 * implementations with no accepted capability remain visible for diagnostics
 * but cannot advertise candidate media/language support.
 */
export function reconcileProviderCatalog(catalog: WireProviderCatalog, artifact: Increment4ACapabilityArtifact): WireProviderCatalog {
  const providers = catalog.providers.map((entry): WireProviderCatalogEntry => {
    const capabilityIds = promotedCapabilityIds(artifact, entry.providerRef);
    if (capabilityIds.length === 0) return { ...entry, promotionStatus: 'UNPROMOTED' };
    return { ...entry, promotionStatus: 'ACCEPTED', capabilityIds } as WireProviderCatalogEntry & { readonly capabilityIds: readonly string[] };
  });
  return { ...catalog, providers };
}

/** Minimal catalog-source surface: anything able to serve `GET /v1/providers`. */
export interface ProviderCatalogSource { providers(signal?: AbortSignal): Promise<WireProviderCatalog>; }

/**
 * Returns the catalog entry for `providerRef` only when the worker has
 * promoted it (`promotionStatus === 'ACCEPTED'`). Unpromoted or absent
 * providers yield `undefined` so callers advertise nothing for them.
 */
export function acceptedCatalogEntry(
  catalog: { readonly providers: readonly WireProviderCatalogEntry[] },
  providerRef: string,
): WireProviderCatalogEntry | undefined {
  const entry = catalog.providers.find((provider) => provider.providerRef === providerRef);
  return entry !== undefined && entry.promotionStatus === 'ACCEPTED' ? entry : undefined;
}

/**
 * Derive advertised parser capabilities from a single `/v1/providers` entry.
 * Media types, languages, and feature flags come only from the entry's
 * accepted `capabilityIds`/`languages`/`features`/`mediaTypes` projection —
 * candidate constants are never advertised. Returns `undefined` when the
 * entry is absent or not `ACCEPTED`.
 */
export function advertisedParserCapabilities(entry: WireProviderCatalogEntry | undefined): DocumentParserCapabilities | undefined {
  if (entry === undefined || entry.promotionStatus !== 'ACCEPTED') return undefined;
  const languages = entry.languages ?? entry.supportedLanguages ?? [];
  const features = entry.features ?? [];
  return {
    mediaTypes: [...(entry.mediaTypes ?? [])],
    supportedLanguages: [...languages],
    supportsLanguages: languages.length > 0,
    supportsTables: features.includes('tables') || entry.supportsTables === true,
    supportsCoordinates: features.includes('coordinates') || entry.supportsCoordinates === true,
  };
}

/**
 * Fetches `GET /v1/providers` and derives the advertised parser capabilities
 * for `providerRef`. Providers without an `ACCEPTED` catalog record advertise
 * empty capability sets — never candidate constants.
 */
export async function advertisedParserCapabilitiesFor(source: ProviderCatalogSource, providerRef: string): Promise<DocumentParserCapabilities> {
  const catalog = await source.providers();
  return advertisedParserCapabilities(acceptedCatalogEntry(catalog, providerRef)) ?? { mediaTypes: [], supportedLanguages: [] };
}
