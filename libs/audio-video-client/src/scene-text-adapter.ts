/**
 * Thin, source-version-aware Media scene-text adapter over the public
 * Document Intelligence v1 client surface. It does not implement OCR.
 *
 * Admission is still owned by release/provider authorities: a caller must
 * supply the exact expected public protocol, worker, provider and model
 * identities. Temporal frame identity stays Media-owned and is carried beside
 * the parse result because Document Intelligence v1 has no time fields.
 */
export const DOCUMENT_INTELLIGENCE_PROTOCOL_V1 = "document-intelligence.v1" as const;
export const DOCUMENT_INTELLIGENCE_WORKER_V1 = "document-intelligence-worker.v1" as const;

export interface SceneTextWireIdentity {
  readonly providerRef: string;
  readonly providerVersion: string;
  readonly modelRef?: string;
  readonly modelVersion?: string;
}

export interface SceneTextWirePage {
  readonly pageNumber: number;
  readonly tables: readonly unknown[];
  readonly blocks: readonly {
    readonly blockId: string;
    readonly lines: readonly {
      readonly lineId: string;
      readonly text: string;
      readonly boundingRegion: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
      readonly confidence?: number;
      readonly languageTag?: string;
    }[];
  }[];
}

export interface SceneTextWireDocument {
  readonly protocolVersion: string;
  readonly operationId: string;
  readonly providerRef: string;
  readonly pages: readonly SceneTextWirePage[];
  readonly providerProvenance: SceneTextWireIdentity;
  readonly languageTag?: string;
}

export interface SceneTextProviderCatalog {
  readonly protocolVersion: string;
  readonly workerCapabilityVersion?: string;
  readonly providers: readonly (SceneTextWireIdentity & {
    readonly mediaTypes?: readonly string[];
    readonly supportedLanguages?: readonly string[];
    readonly promotionStatus: "ACCEPTED" | "UNPROMOTED";
    readonly loaded: boolean;
    readonly ready: boolean;
  })[];
}

export interface SceneTextParseInput {
  readonly operationId: string;
  readonly operationGeneration?: string;
  readonly providerRef: string;
  readonly mediaType: string;
  readonly languageHint?: string;
  readonly timeoutMs: number;
  readonly limits: Readonly<Record<string, number>>;
  readonly bytes: Uint8Array;
  readonly signal?: AbortSignal;
}

/** Structural surface implemented by @ghatana/document-intelligence-client. */
export interface DocumentIntelligenceV1Client {
  readonly lastProtocolVersion?: string;
  readonly lastWorkerCapabilityVersion?: string;
  providers(signal?: AbortSignal): Promise<SceneTextProviderCatalog>;
  parse(input: SceneTextParseInput): Promise<SceneTextWireDocument>;
}

export interface SceneTextSourceFrame {
  readonly sourceArtifactId: string;
  readonly sourceVersion: string;
  readonly frameId: string;
  readonly timestampUs: number;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly languageHint?: string;
}

export interface SceneTextAdapterPolicy {
  readonly providerRef: string;
  readonly providerVersion: string;
  readonly modelRef: string;
  readonly modelVersion: string;
  readonly acceptedMediaTypes: readonly string[];
  readonly acceptedLanguages: readonly string[];
  readonly timeoutMs: number;
  /** Explicit wire limit names and units must come from the admitted provider contract. */
  readonly workerLimits: Readonly<Record<string, number>>;
}

export interface SceneTextObservation {
  readonly sourceArtifactId: string;
  readonly sourceVersion: string;
  readonly frameId: string;
  readonly timestampUs: number;
  readonly protocolVersion: typeof DOCUMENT_INTELLIGENCE_PROTOCOL_V1;
  readonly workerCapabilityVersion: typeof DOCUMENT_INTELLIGENCE_WORKER_V1;
  readonly provider: SceneTextWireIdentity & { readonly modelRef: string; readonly modelVersion: string };
  readonly pageNumber: number;
  /** Ordinal in the wire response only; not an assertion of semantic reading order. */
  readonly wireOrdinal: number;
  readonly blockId: string;
  readonly lineId: string;
  readonly text: string;
  readonly confidence: number;
  readonly languageTag?: string;
  readonly boundingRegion: SceneTextWirePage["blocks"][number]["lines"][number]["boundingRegion"];
}

export type SceneTextAdapterErrorCode =
  | "SOURCE_IDENTITY_INVALID"
  | "SOURCE_PAYLOAD_INVALID"
  | "SOURCE_MEDIA_TYPE_NOT_ADMITTED"
  | "SOURCE_LANGUAGE_NOT_ADMITTED"
  | "CLIENT_PROTOCOL_MISMATCH"
  | "WORKER_VERSION_NOT_ADMITTED"
  | "PROVIDER_NOT_ADMITTED"
  | "PROVIDER_VERSION_MISMATCH"
  | "RESPONSE_IDENTITY_MISMATCH"
  | "PAGE_SCOPE_UNSUPPORTED"
  | "MODEL_IDENTITY_MISSING"
  | "MODEL_VERSION_MISMATCH"
  | "RESULT_GEOMETRY_INVALID"
  | "RESULT_CONFIDENCE_MISSING"
  | "RESULT_SHAPE_UNSUPPORTED"
  | "REQUEST_ABORTED";

export class SceneTextAdapterError extends Error {
  public constructor(public readonly code: SceneTextAdapterErrorCode) {
    super(`Scene-text adapter rejected the operation: ${code}`);
    this.name = "SceneTextAdapterError";
  }
}

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value && value.length <= 512;
}

function validWireId(value: unknown): value is string {
  return validIdentity(value) && value.length <= 256;
}

function isValidRegion(region: SceneTextWirePage["blocks"][number]["lines"][number]["boundingRegion"]): boolean {
  return region !== null && typeof region === "object"
    && [region.x, region.y, region.width, region.height].every(Number.isFinite)
    && region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0
    && region.x + region.width <= 1 && region.y + region.height <= 1;
}

function snapshotPolicy(policy: SceneTextAdapterPolicy): SceneTextAdapterPolicy {
  if (policy === null || typeof policy !== "object"
    || !validIdentity(policy.providerRef) || !validIdentity(policy.providerVersion)
    || !validIdentity(policy.modelRef) || !validIdentity(policy.modelVersion)
    || !Number.isSafeInteger(policy.timeoutMs) || policy.timeoutMs <= 0
    || !Array.isArray(policy.acceptedMediaTypes) || policy.acceptedMediaTypes.length === 0
    || !Array.isArray(policy.acceptedLanguages) || policy.acceptedLanguages.length === 0
    || !policy.acceptedMediaTypes.every(validIdentity)
    || !policy.acceptedLanguages.every(validIdentity)
    || new Set(policy.acceptedMediaTypes).size !== policy.acceptedMediaTypes.length
    || new Set(policy.acceptedLanguages).size !== policy.acceptedLanguages.length
    || policy.workerLimits === null || typeof policy.workerLimits !== "object") {
    throw new SceneTextAdapterError("SOURCE_IDENTITY_INVALID");
  }
  const limits = Object.entries(policy.workerLimits);
  if (limits.length === 0 || limits.some(([name, value]) => !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(name)
    || !Number.isSafeInteger(value) || value <= 0)) {
    throw new SceneTextAdapterError("SOURCE_IDENTITY_INVALID");
  }
  return Object.freeze({
    ...policy,
    acceptedMediaTypes: Object.freeze([...policy.acceptedMediaTypes]),
    acceptedLanguages: Object.freeze([...policy.acceptedLanguages]),
    workerLimits: Object.freeze(Object.fromEntries(limits)),
  });
}

function abortIfRequested(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new SceneTextAdapterError("REQUEST_ABORTED");
}

function validPage(page: SceneTextWirePage): boolean {
  return page !== null && typeof page === "object" && Number.isSafeInteger(page.pageNumber)
    && page.pageNumber > 0 && Array.isArray(page.tables) && Array.isArray(page.blocks)
    && page.blocks.every((block: SceneTextWirePage["blocks"][number]) => block !== null && typeof block === "object"
      && validWireId(block.blockId) && Array.isArray(block.lines)
      && block.lines.every((line: SceneTextWirePage["blocks"][number]["lines"][number]) => line !== null && typeof line === "object"
        && validWireId(line.lineId) && typeof line.text === "string" && line.text.length > 0
        && line.text.length <= 1_000_000
        && (line.languageTag === undefined || validWireId(line.languageTag))));
}

export class DocumentIntelligenceSceneTextAdapter {
  private readonly policy: SceneTextAdapterPolicy;

  public constructor(
    private readonly client: DocumentIntelligenceV1Client,
    policy: SceneTextAdapterPolicy,
  ) {
    this.policy = snapshotPolicy(policy);
  }

  public async recognizeFrame(
    operationId: string,
    frame: SceneTextSourceFrame,
    signal?: AbortSignal,
  ): Promise<readonly SceneTextObservation[]> {
    if (!validIdentity(operationId) || frame === null || typeof frame !== "object"
      || !validIdentity(frame.sourceArtifactId) || !validIdentity(frame.sourceVersion)
      || !validIdentity(frame.frameId) || !validIdentity(frame.mediaType)
      || !Number.isSafeInteger(frame.timestampUs) || frame.timestampUs < 0
      || !(frame.bytes instanceof Uint8Array)) {
      throw new SceneTextAdapterError("SOURCE_IDENTITY_INVALID");
    }
    if (frame.bytes.byteLength === 0) throw new SceneTextAdapterError("SOURCE_PAYLOAD_INVALID");
    if (frame.languageHint !== undefined && !validIdentity(frame.languageHint)) {
      throw new SceneTextAdapterError("SOURCE_LANGUAGE_NOT_ADMITTED");
    }
    if (!this.policy.acceptedMediaTypes.includes(frame.mediaType)) {
      throw new SceneTextAdapterError("SOURCE_MEDIA_TYPE_NOT_ADMITTED");
    }
    if (frame.languageHint !== undefined && !this.policy.acceptedLanguages.includes(frame.languageHint)) {
      throw new SceneTextAdapterError("SOURCE_LANGUAGE_NOT_ADMITTED");
    }

    // Snapshot caller-owned values before the first asynchronous boundary so a
    // mutable frame cannot redirect identity or bytes while catalog lookup runs.
    const source = Object.freeze({
      sourceArtifactId: frame.sourceArtifactId,
      sourceVersion: frame.sourceVersion,
      frameId: frame.frameId,
      timestampUs: frame.timestampUs,
      mediaType: frame.mediaType,
      bytes: new Uint8Array(frame.bytes),
      languageHint: frame.languageHint,
    });
    abortIfRequested(signal);
    const catalog = await this.client.providers(signal);
    abortIfRequested(signal);
    if (catalog === null || typeof catalog !== "object") {
      throw new SceneTextAdapterError("PROVIDER_NOT_ADMITTED");
    }
    if (catalog.protocolVersion !== DOCUMENT_INTELLIGENCE_PROTOCOL_V1
      || this.client.lastProtocolVersion !== DOCUMENT_INTELLIGENCE_PROTOCOL_V1) {
      throw new SceneTextAdapterError("CLIENT_PROTOCOL_MISMATCH");
    }
    if (catalog.workerCapabilityVersion !== DOCUMENT_INTELLIGENCE_WORKER_V1
      || this.client.lastWorkerCapabilityVersion !== DOCUMENT_INTELLIGENCE_WORKER_V1) {
      throw new SceneTextAdapterError("WORKER_VERSION_NOT_ADMITTED");
    }
    if (!Array.isArray(catalog.providers)) throw new SceneTextAdapterError("PROVIDER_NOT_ADMITTED");
    const provider = catalog.providers.find((candidate) => candidate !== null
      && typeof candidate === "object" && candidate.providerRef === this.policy.providerRef);
    if (!provider || provider.promotionStatus !== "ACCEPTED" || !provider.loaded || !provider.ready) {
      throw new SceneTextAdapterError("PROVIDER_NOT_ADMITTED");
    }
    if (provider.providerVersion !== this.policy.providerVersion) {
      throw new SceneTextAdapterError("PROVIDER_VERSION_MISMATCH");
    }
    if (!validIdentity(provider.providerRef) || !validIdentity(provider.providerVersion)) {
      throw new SceneTextAdapterError("PROVIDER_NOT_ADMITTED");
    }
    if (!validIdentity(provider.modelRef) || !validIdentity(provider.modelVersion)) {
      throw new SceneTextAdapterError("MODEL_IDENTITY_MISSING");
    }
    if (provider.modelRef !== this.policy.modelRef || provider.modelVersion !== this.policy.modelVersion) {
      throw new SceneTextAdapterError("MODEL_VERSION_MISMATCH");
    }
    if (!Array.isArray(provider.mediaTypes) || !provider.mediaTypes.every(validIdentity)
      || !provider.mediaTypes.includes(source.mediaType)) {
      throw new SceneTextAdapterError("SOURCE_MEDIA_TYPE_NOT_ADMITTED");
    }
    if (source.languageHint !== undefined && (!Array.isArray(provider.supportedLanguages)
      || !provider.supportedLanguages.every(validIdentity)
      || !provider.supportedLanguages.includes(source.languageHint))) {
      throw new SceneTextAdapterError("SOURCE_LANGUAGE_NOT_ADMITTED");
    }
    abortIfRequested(signal);

    const parsed = await this.client.parse({
      operationId,
      providerRef: this.policy.providerRef,
      mediaType: source.mediaType,
      ...(source.languageHint === undefined ? {} : { languageHint: source.languageHint }),
      timeoutMs: this.policy.timeoutMs,
      limits: this.policy.workerLimits,
      bytes: new Uint8Array(source.bytes),
      signal,
    });
    if (parsed === null || typeof parsed !== "object" || parsed.providerProvenance === null
      || typeof parsed.providerProvenance !== "object") {
      throw new SceneTextAdapterError("RESPONSE_IDENTITY_MISMATCH");
    }
    if (parsed.protocolVersion !== DOCUMENT_INTELLIGENCE_PROTOCOL_V1
      || parsed.operationId !== operationId || parsed.providerRef !== this.policy.providerRef
      || parsed.providerProvenance?.providerRef !== this.policy.providerRef
      || parsed.providerProvenance?.providerVersion !== this.policy.providerVersion) {
      throw new SceneTextAdapterError("RESPONSE_IDENTITY_MISMATCH");
    }
    if (!Array.isArray(parsed.pages) || parsed.pages.length !== 1
      || !validPage(parsed.pages[0]) || parsed.pages[0].pageNumber !== 1) {
      throw new SceneTextAdapterError("PAGE_SCOPE_UNSUPPORTED");
    }
    if (parsed.pages[0].tables.length > 0) {
      throw new SceneTextAdapterError("RESULT_SHAPE_UNSUPPORTED");
    }
    const provenance = parsed.providerProvenance;
    if (!provenance.modelRef || !provenance.modelVersion) {
      throw new SceneTextAdapterError("MODEL_IDENTITY_MISSING");
    }
    if (provenance.modelRef !== this.policy.modelRef || provenance.modelVersion !== this.policy.modelVersion) {
      throw new SceneTextAdapterError("MODEL_VERSION_MISMATCH");
    }

    const observations: SceneTextObservation[] = [];
    let wireOrdinal = 0;
    for (const block of parsed.pages[0].blocks) {
      for (const line of block.lines) {
        if (!isValidRegion(line.boundingRegion)) throw new SceneTextAdapterError("RESULT_GEOMETRY_INVALID");
        if (line.confidence === undefined || !Number.isFinite(line.confidence)
          || line.confidence < 0 || line.confidence > 1) {
          throw new SceneTextAdapterError("RESULT_CONFIDENCE_MISSING");
        }
        observations.push({
          sourceArtifactId: source.sourceArtifactId,
          sourceVersion: source.sourceVersion,
          frameId: source.frameId,
          timestampUs: source.timestampUs,
          protocolVersion: DOCUMENT_INTELLIGENCE_PROTOCOL_V1,
          workerCapabilityVersion: DOCUMENT_INTELLIGENCE_WORKER_V1,
          provider: { ...provenance, modelRef: provenance.modelRef, modelVersion: provenance.modelVersion },
          pageNumber: parsed.pages[0].pageNumber,
          wireOrdinal: wireOrdinal++,
          blockId: block.blockId,
          lineId: line.lineId,
          text: line.text,
          confidence: line.confidence,
          ...(line.languageTag === undefined ? {} : { languageTag: line.languageTag }),
          boundingRegion: line.boundingRegion,
        });
      }
    }
    return observations;
  }
}
