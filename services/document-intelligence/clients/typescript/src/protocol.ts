export const PROTOCOL_VERSION = 'document-intelligence.v1' as const;

/** Worker capability revisions this client negotiates with (PROTO-04). */
export const WORKER_CAPABILITY_VERSIONS = ['document-intelligence-worker.v1'] as const;
export type WorkerCapabilityVersion = (typeof WORKER_CAPABILITY_VERSIONS)[number];
/** Recorded when a /v1/providers response carries no workerCapabilityVersion (pre-capability baseline worker). */
export const LEGACY_WORKER_CAPABILITY_VERSION = 'document-intelligence.v1-legacy' as const;

export interface WireIdentity { readonly providerRef: string; readonly providerVersion: string; readonly modelRef?: string; readonly modelVersion?: string; }
export interface WireBox { readonly x: number; readonly y: number; readonly width: number; readonly height: number; }
export interface WireLine { readonly lineId: string; readonly text: string; readonly boundingRegion: WireBox; readonly confidence?: number; readonly languageTag?: string; }
export interface WireBlock { readonly blockId: string; readonly kind: string; readonly boundingRegion: WireBox; readonly lines: readonly WireLine[]; readonly confidence?: number; readonly languageTag?: string; }
export interface WireCell { readonly cellId: string; readonly rowIndex: number; readonly columnIndex: number; readonly rowSpan?: number; readonly columnSpan?: number; readonly text: string; readonly boundingRegion: WireBox; readonly confidence?: number; }
export interface WireTable { readonly tableId: string; readonly boundingRegion: WireBox; readonly rowCount: number; readonly columnCount: number; readonly headers?: readonly string[]; readonly cells: readonly WireCell[]; readonly confidence?: number; }
export interface WirePage { readonly pageNumber: number; readonly blocks: readonly WireBlock[]; readonly tables: readonly WireTable[]; readonly languageTag?: string; }
export interface WireParsedDocument { readonly protocolVersion: typeof PROTOCOL_VERSION; readonly operationId: string; readonly providerRef: string; readonly pages: readonly WirePage[]; readonly providerProvenance: WireIdentity; readonly quality: { readonly parseConfidence?: number; readonly completeness?: number; readonly warnings?: readonly string[] }; readonly languageTag?: string; }
export interface WireField { readonly fieldId: string; readonly aliases: readonly string[]; readonly valueType: string; readonly cardinality: string; }
export interface WireEvidence { readonly pageNumber: number; readonly blockId?: string; readonly lineId?: string; readonly boundingRegion?: WireBox; readonly textSpan?: { readonly start: number; readonly end: number }; }
export interface WireCandidate { readonly fieldId: string; readonly value: { readonly kind: 'TEXT'|'IDENTIFIER'; readonly value: string }; readonly source: 'MODEL'; readonly confidence: number; readonly evidence: readonly WireEvidence[]; readonly provider: WireIdentity; }
export interface WireExtractionResponse { readonly protocolVersion: typeof PROTOCOL_VERSION; readonly operationId: string; readonly providerRef: string; readonly candidates: readonly WireCandidate[]; readonly provider: WireIdentity; }
export interface WireEmbeddingResponse { readonly protocolVersion: typeof PROTOCOL_VERSION; readonly operationId: string; readonly providerRef: string; readonly model: WireIdentity; readonly dimensions: number; readonly values: readonly number[]; }
export interface WireError { readonly protocolVersion: typeof PROTOCOL_VERSION; readonly operationId: string; readonly code: string; readonly retryable: boolean; readonly providerRef?: string; }
export interface WireProviderCatalogEntry extends WireIdentity { readonly mediaTypes?: readonly string[]; readonly supportedLanguages?: readonly string[]; readonly supportedValueTypes?: readonly string[]; readonly capabilityIds?: readonly string[]; readonly languages?: readonly string[]; readonly features?: readonly string[]; readonly maxDimensions?: number; readonly modelRef?: string; readonly languageModelIdentities?: readonly { readonly language: string; readonly modelRef: string; readonly modelVersion: string }[]; readonly supportsTables?: boolean; readonly supportsCoordinates?: boolean; readonly supportsLanguages?: boolean; readonly supportsConfidenceScores?: boolean; readonly supportsMultipleCardinality?: boolean; readonly promotionStatus: 'ACCEPTED'|'UNPROMOTED'; readonly loaded: boolean; readonly ready: boolean; }
export interface WireProviderCatalog { readonly protocolVersion: typeof PROTOCOL_VERSION; readonly workerCapabilityVersion?: string; readonly providers: readonly WireProviderCatalogEntry[]; }
