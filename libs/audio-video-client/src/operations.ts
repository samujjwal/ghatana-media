import {
  MediaArtifactSchema,
  MediaCanonicalErrorSchema,
  MediaProcessingJobSchema,
  MultimodalAnalysisRequestSchema,
  OperationAcceptedSchema,
  ProviderCapabilitySchema,
  SynthesisRequestSchema,
  SynthesisResultSchema,
  TranscriptionRequestSchema,
  TranscriptionResultSchema,
  VoiceConversionRequestSchema,
  VoiceTrainingRequestSchema,
  type MediaArtifact,
  type MediaCanonicalError,
  type MediaProcessingJob,
  type MultimodalAnalysisRequest,
  type OperationAccepted,
  type ProviderCapability,
  type SynthesisRequest,
  type SynthesisResult,
  type TranscriptionRequest,
  type TranscriptionResult,
  type VoiceConversionRequest,
  type VoiceTrainingRequest,
} from "@audio-video/types/contracts";

interface RuntimeParser<T> {
  parse(input: unknown): T;
}

export interface MediaOperationClientConfig {
  readonly baseUrl: string;
  readonly tenantId: string;
  readonly fetchImpl?: typeof fetch;
  readonly getAccessToken?: () => string | undefined | Promise<string | undefined>;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly requestTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  /** Causal context propagated across service boundaries; a fresh request ID is always generated. */
  readonly requestContext?: Readonly<{
    correlationId?: string;
    causationId?: string;
    parentRunId?: string;
    principalDelegation?: string;
  }>;
}

/** Runtime UploadRequest fields accepted by POST /api/v1/artifacts/uploads. */
export interface CreateUploadSessionRequest {
  readonly fileName: string;
  readonly contentType: string;
  readonly expectedSizeBytes: number;
  readonly expectedSha256: string;
  readonly classification: string;
  /** ISO-8601 duration parsed by the runtime, for example PT24H. */
  readonly retention: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Sent as Idempotency-Key per the OpenAPI contract; runtime replay semantics remain unqualified. */
  readonly idempotencyKey: string;
}

/** Exact runtime UploadSession response DTO. */
export interface CanonicalMediaUploadSessionObservation {
  readonly uploadId: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly expectedSizeBytes: number;
  readonly expectedSha256: string;
  readonly classification: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly bytesReceived: number;
  readonly nextChunkIndex: number;
  readonly status: "OPEN" | "FINALIZING" | "COMPLETED" | "ABORTED" | "EXPIRED";
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface OperationWaitOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly onProgress?: (job: MediaProcessingJob) => void;
}

export interface UploadProgress {
  readonly uploadedBytes: number;
  readonly totalBytes: number;
  readonly percentage: number;
}

export class MediaClientError extends Error {
  public readonly detail: MediaCanonicalError;
  public readonly statusCode?: number;

  public constructor(detail: MediaCanonicalError, statusCode?: number) {
    super(detail.message);
    this.name = "MediaClientError";
    this.detail = detail;
    this.statusCode = statusCode;
  }
}

/** Exact current runtime DTO from MediaRuntimeContracts.MediaArtifact. */
export interface CanonicalMediaArtifactObservation {
  readonly tenantId: string;
  readonly principalId: string;
  readonly artifactId: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly objectReference: string;
  readonly classification: "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED";
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

function canonicalJson(value: unknown): string {
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, nested]) => [key, visit(nested)]));
    }
    return item;
  };
  return JSON.stringify(visit(value));
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function uploadImmutableFieldsMatch(
  actual: CanonicalMediaUploadSessionObservation,
  expected: Pick<CanonicalMediaUploadSessionObservation,
    "uploadId" | "tenantId" | "principalId" | "fileName" | "contentType" | "expectedSizeBytes"
    | "expectedSha256" | "classification" | "createdAt" | "expiresAt" | "metadata">,
): boolean {
  return actual.uploadId === expected.uploadId
    && actual.tenantId === expected.tenantId
    && actual.principalId === expected.principalId
    && actual.fileName === expected.fileName
    && actual.contentType === expected.contentType
    && actual.expectedSizeBytes === expected.expectedSizeBytes
    && actual.expectedSha256 === expected.expectedSha256
    && actual.classification === expected.classification
    && actual.createdAt === expected.createdAt
    && actual.expiresAt === expected.expiresAt
    && sameJson(actual.metadata, expected.metadata);
}

const UPLOAD_SESSION_FIELDS = new Set([
  "uploadId", "tenantId", "principalId", "fileName", "contentType", "expectedSizeBytes",
  "expectedSha256", "classification", "createdAt", "expiresAt", "bytesReceived",
  "nextChunkIndex", "status", "metadata",
]);

function parseCanonicalMediaUploadSession(input: unknown): CanonicalMediaUploadSessionObservation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Canonical Media upload response must be an object.");
  }
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !UPLOAD_SESSION_FIELDS.has(key))
    || [...UPLOAD_SESSION_FIELDS].some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError("Canonical Media upload response fields do not match the runtime DTO.");
  }
  const requiredText = (key: string): string => {
    const field = value[key];
    if (typeof field !== "string" || field.trim().length === 0) {
      throw new TypeError(`Canonical Media upload ${key} must be a non-empty string.`);
    }
    return field;
  };
  const expectedSizeBytes = value.expectedSizeBytes;
  const bytesReceived = value.bytesReceived;
  const nextChunkIndex = value.nextChunkIndex;
  if (typeof expectedSizeBytes !== "number" || !Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes < 1
    || typeof bytesReceived !== "number" || !Number.isSafeInteger(bytesReceived) || bytesReceived < 0
    || typeof nextChunkIndex !== "number" || !Number.isSafeInteger(nextChunkIndex) || nextChunkIndex < 0) {
    throw new TypeError("Canonical Media upload size and progress fields are invalid.");
  }
  const expectedSha256 = requiredText("expectedSha256");
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) throw new TypeError("Canonical Media upload digest must be lowercase SHA-256 hex.");
  if (bytesReceived > expectedSizeBytes) throw new TypeError("Canonical Media upload bytesReceived exceeds expectedSizeBytes.");
  const status = value.status;
  if (status !== "OPEN" && status !== "FINALIZING" && status !== "COMPLETED"
    && status !== "ABORTED" && status !== "EXPIRED") {
    throw new TypeError("Canonical Media upload status is outside the runtime enum.");
  }
  const timestamp = (key: string): string => {
    const field = requiredText(key);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(field)
      || !Number.isFinite(Date.parse(field))) throw new TypeError(`Canonical Media upload ${key} must be an ISO-8601 UTC timestamp.`);
    return field;
  };
  const metadata = value.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TypeError("Canonical Media upload metadata must be an object.");
  }
  const createdAt = timestamp("createdAt");
  const expiresAt = timestamp("expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) throw new TypeError("Canonical Media upload expiry must follow creation.");
  return {
    uploadId: requiredText("uploadId"), tenantId: requiredText("tenantId"), principalId: requiredText("principalId"),
    fileName: requiredText("fileName"), contentType: requiredText("contentType"), expectedSizeBytes,
    expectedSha256, classification: requiredText("classification"), createdAt, expiresAt, bytesReceived, nextChunkIndex, status,
    metadata: metadata as Readonly<Record<string, unknown>>,
  };
}

const ARTIFACT_OBSERVATION_FIELDS = new Set([
  "tenantId", "principalId", "artifactId", "fileName", "contentType", "sizeBytes", "sha256",
  "objectReference", "classification", "createdAt", "expiresAt", "metadata",
]);

function parseCanonicalMediaArtifactObservation(input: unknown): CanonicalMediaArtifactObservation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Canonical Media artifact response must be an object.");
  }
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !ARTIFACT_OBSERVATION_FIELDS.has(key))
    || [...ARTIFACT_OBSERVATION_FIELDS].some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError("Canonical Media artifact response fields do not match the runtime DTO.");
  }
  const requiredText = (key: string): string => {
    const field = value[key];
    if (typeof field !== "string" || field.trim().length === 0) {
      throw new TypeError(`Canonical Media artifact ${key} must be a non-empty string.`);
    }
    return field;
  };
  const tenantId = requiredText("tenantId");
  const principalId = requiredText("principalId");
  const artifactId = requiredText("artifactId");
  const fileName = requiredText("fileName");
  const contentType = requiredText("contentType");
  const objectReference = requiredText("objectReference");
  const sha256 = requiredText("sha256");
  if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new TypeError("Canonical Media artifact sha256 must be lowercase SHA-256 hex.");
  const sizeBytes = value.sizeBytes;
  if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
    throw new TypeError("Canonical Media artifact sizeBytes must be a positive safe integer.");
  }
  const classification = value.classification;
  if (classification !== "PUBLIC" && classification !== "INTERNAL"
    && classification !== "CONFIDENTIAL" && classification !== "RESTRICTED") {
    throw new TypeError("Canonical Media artifact classification is outside the runtime enum.");
  }
  const dateTime = (key: string): string => {
    const field = requiredText(key);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(field)
      || !Number.isFinite(Date.parse(field))) {
      throw new TypeError(`Canonical Media artifact ${key} must be an ISO-8601 UTC timestamp.`);
    }
    return field;
  };
  const metadata = value.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TypeError("Canonical Media artifact metadata must be an object.");
  }
  return {
    tenantId, principalId, artifactId, fileName, contentType, sizeBytes, sha256, objectReference,
    classification, createdAt: dateTime("createdAt"), expiresAt: dateTime("expiresAt"),
    metadata: metadata as Readonly<Record<string, unknown>>,
  };
}

/** A source-compatible SDK method whose server route has not been admitted. */
export class MediaOperationNotAdmittedError extends Error {
  public constructor(public readonly operation: string) {
    super(`Media operation is not admitted by the current server contract: ${operation}`);
    this.name = "MediaOperationNotAdmittedError";
  }
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Media client baseUrl is required.");
  return trimmed.replace(/\/+$/u, "");
}

function safeIdentityHeader(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || value.length > 255 || !/^[\x21-\x7e]+$/u.test(value)) {
    throw new Error(`Invalid media client request identity field: ${name}.`);
  }
  return value;
}

function boundedPositive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.round(value as number) : fallback;
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Operation cancelled", "AbortError"));
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new DOMException("Operation cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function linkAbortSignal(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => undefined;
  if (source.aborted) {
    target.abort(source.reason);
    return () => undefined;
  }
  const onAbort = (): void => target.abort(source.reason);
  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}

function terminal(job: MediaProcessingJob): boolean {
  return [
    "COMPLETED",
    "FAILED",
    "PARTIALLY_SUCCEEDED",
    "CANCELLED",
  ].includes(job.state);
}

export class MediaOperationHandle<T> {
  public readonly operationId: string;
  public readonly initialJob: MediaProcessingJob;

  public constructor(
    private readonly client: MediaOperationClient,
    accepted: OperationAccepted,
    private readonly resultParser: RuntimeParser<T>,
  ) {
    this.operationId = accepted.operationId;
    this.initialJob = accepted.job;
  }

  public getStatus(signal?: AbortSignal): Promise<MediaProcessingJob> {
    return this.client.getOperation(this.operationId, signal);
  }

  public cancel(signal?: AbortSignal): Promise<MediaProcessingJob> {
    return this.client.cancelOperation(this.operationId, signal);
  }

  public retry(signal?: AbortSignal): Promise<MediaOperationHandle<T>> {
    return this.client.retryOperation(this.operationId, this.resultParser, signal);
  }

  public getResult(signal?: AbortSignal): Promise<T> {
    return this.client.getOperationResult(
      this.operationId,
      this.resultParser,
      signal,
    );
  }

  public async wait(options: OperationWaitOptions = {}): Promise<T> {
    const timeoutMs = boundedPositive(options.timeoutMs, 10 * 60_000);
    const intervalMs = boundedPositive(
      options.pollIntervalMs,
      this.client.pollIntervalMs,
    );
    const controller = new AbortController();
    const unlink = linkAbortSignal(options.signal, controller);
    const timeout = setTimeout(
      () => controller.abort(new DOMException("Operation timed out", "TimeoutError")),
      timeoutMs,
    );

    try {
      let current = this.initialJob;
      options.onProgress?.(current);
      while (!terminal(current)) {
        await wait(intervalMs, controller.signal);
        current = await this.getStatus(controller.signal);
        options.onProgress?.(current);
      }

      if (current.state === "COMPLETED") {
        return await this.getResult(controller.signal);
      }
      if (current.state === "CANCELLED") {
        throw new DOMException("Media operation was cancelled", "AbortError");
      }
      if (current.state === "FAILED" || current.state === "PARTIALLY_SUCCEEDED") {
        throw new Error(current.error.message);
      }
      throw new Error(`Unexpected terminal operation state: ${current.state}`);
    } finally {
      clearTimeout(timeout);
      unlink();
    }
  }
}

/**
 * LEGACY_COMPATIBILITY: preserves the existing `/api/v1/media/*` client
 * contract. Semantic mapping, wire parity, and consumer migration are pending;
 * this annotation does not change routes or runtime behavior.
 */
export class MediaOperationClient {
  private readonly baseUrl: string;
  private readonly tenantId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly getAccessToken?: MediaOperationClientConfig["getAccessToken"];
  private readonly defaultHeaders: Readonly<Record<string, string>>;
  private readonly requestTimeoutMs: number;
  private readonly requestContext: NonNullable<MediaOperationClientConfig["requestContext"]>;
  public readonly pollIntervalMs: number;

  public constructor(config: MediaOperationClientConfig) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.tenantId = safeIdentityHeader("tenantId", config.tenantId.trim()) ?? "";
    if (!this.tenantId) throw new Error("Media client tenantId is required.");
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.getAccessToken = config.getAccessToken;
    this.defaultHeaders = config.defaultHeaders ?? {};
    this.requestTimeoutMs = boundedPositive(config.requestTimeoutMs, 30_000);
    this.pollIntervalMs = boundedPositive(config.pollIntervalMs, 1_000);
    const requestContext = config.requestContext ?? {};
    this.requestContext = {
      ...(safeIdentityHeader("correlationId", requestContext.correlationId) === undefined
        ? {}
        : { correlationId: requestContext.correlationId }),
      ...(safeIdentityHeader("causationId", requestContext.causationId) === undefined
        ? {}
        : { causationId: requestContext.causationId }),
      ...(safeIdentityHeader("parentRunId", requestContext.parentRunId) === undefined
        ? {}
        : { parentRunId: requestContext.parentRunId }),
      ...(safeIdentityHeader("principalDelegation", requestContext.principalDelegation) === undefined
        ? {}
        : { principalDelegation: requestContext.principalDelegation }),
    };
  }

  public async createUploadSession(
    request: CreateUploadSessionRequest,
    signal?: AbortSignal,
  ): Promise<CanonicalMediaUploadSessionObservation> {
    const principalId = this.requirePrincipalId("upload operations");
    const allowedRequestFields = new Set(["fileName", "contentType", "expectedSizeBytes", "expectedSha256", "classification", "retention", "metadata", "idempotencyKey"]);
    if (!request || Object.keys(request).some((key) => !allowedRequestFields.has(key))) {
      throw new Error("Upload request contains fields outside the canonical SDK request.");
    }
    const idempotencyKey = safeIdentityHeader("idempotencyKey", request.idempotencyKey);
    if (!idempotencyKey) throw new Error("idempotencyKey is required by the declared HTTP contract.");
    if (!request.fileName.trim()) throw new Error("fileName is required.");
    if (!request.contentType.trim()) throw new Error("contentType is required.");
    if (!Number.isSafeInteger(request.expectedSizeBytes) || request.expectedSizeBytes < 1
      || request.expectedSizeBytes > 1_073_741_824) {
      throw new Error("expectedSizeBytes must be between 1 byte and the 1 GiB contract limit.");
    }
    if (!/^[a-fA-F0-9]{64}$/u.test(request.expectedSha256)) {
      throw new Error("expectedSha256 must be a SHA-256 hex digest.");
    }
    if (!request.classification.trim()) throw new Error("classification is required.");
    if (!request.retention.trim()) throw new Error("retention ISO-8601 duration is required.");
    if (request.metadata !== undefined && (!request.metadata || typeof request.metadata !== "object"
      || Array.isArray(request.metadata) || Object.keys(request.metadata).length > 64)) {
      throw new Error("metadata must be an object with at most 64 top-level entries.");
    }
    const uploadRequest = {
      tenantId: this.tenantId,
      principalId,
      fileName: request.fileName,
      contentType: request.contentType,
      expectedSizeBytes: request.expectedSizeBytes,
      expectedSha256: request.expectedSha256.toLowerCase(),
      classification: request.classification,
      retention: request.retention,
      metadata: request.metadata ?? {},
    };
    // Detach caller-owned metadata before headers() can await token acquisition.
    // The same immutable JSON snapshot is sent and then used for response binding.
    const requestSnapshot = JSON.parse(JSON.stringify(uploadRequest)) as typeof uploadRequest;
    const created = await this.request(
      "POST", "/api/v1/artifacts/uploads", requestSnapshot,
      { parse: parseCanonicalMediaUploadSession }, signal,
      { "Idempotency-Key": idempotencyKey },
    );
    this.assertUploadScope(created, principalId);
    if (created.fileName !== requestSnapshot.fileName || created.contentType !== requestSnapshot.contentType
      || created.expectedSizeBytes !== requestSnapshot.expectedSizeBytes
      || created.expectedSha256 !== requestSnapshot.expectedSha256
      || created.classification !== requestSnapshot.classification
      || !sameJson(created.metadata, requestSnapshot.metadata)) {
      throw new TypeError("Canonical Media upload response does not bind the submitted immutable request fields.");
    }
    return created;
  }

  public async uploadPart(
    session: CanonicalMediaUploadSessionObservation,
    chunkIndex: number,
    data: Blob,
    options: {
      readonly signal?: AbortSignal;
      readonly onProgress?: (progress: UploadProgress) => void;
    } = {},
  ): Promise<CanonicalMediaUploadSessionObservation> {
    const principalId = this.requirePrincipalId("upload operations");
    const current = parseCanonicalMediaUploadSession(JSON.parse(JSON.stringify(session)));
    this.assertUploadScope(current, principalId);
    if (current.status !== "OPEN") throw new Error("Only OPEN upload sessions accept chunks.");
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex !== current.nextChunkIndex) {
      throw new Error("chunkIndex must equal the session's next zero-based chunk index.");
    }
    if (!(data instanceof Blob) || data.size < 1) throw new Error("Upload chunks must contain at least one byte.");
    if (current.bytesReceived + data.size > current.expectedSizeBytes) {
      throw new Error("Upload chunk would exceed the session's expected size.");
    }
    const controller = new AbortController();
    const unlink = linkAbortSignal(options.signal, controller);
    const timeout = setTimeout(
      () => controller.abort(new DOMException("Upload timed out", "TimeoutError")),
      this.requestTimeoutMs,
    );
    options.onProgress?.({ uploadedBytes: 0, totalBytes: data.size, percentage: 0 });
    try {
      const headers = await this.headers({ "Content-Type": "application/octet-stream" });
      const response = await this.fetchImpl(
        `${this.baseUrl}/api/v1/artifacts/uploads/${encodeURIComponent(current.uploadId)}/chunks/${chunkIndex}`,
        { method: "PUT", headers, body: data, signal: controller.signal },
      );
      if (!response.ok) throw await this.errorFromResponse(response);
      const updated = parseCanonicalMediaUploadSession(await response.json());
      this.assertUploadScope(updated, principalId);
      if (!uploadImmutableFieldsMatch(updated, current) || updated.status !== "OPEN"
        || updated.nextChunkIndex !== chunkIndex + 1
        || updated.bytesReceived !== current.bytesReceived + data.size) {
        throw new TypeError("Canonical Media upload response does not confirm the submitted chunk against the unchanged session.");
      }
      options.onProgress?.({ uploadedBytes: data.size, totalBytes: data.size, percentage: 100 });
      return updated;
    } finally {
      clearTimeout(timeout);
      unlink();
    }
  }

  /** Complete from an exact upload session and bind artifact size/hash to it. */
  public async completeUploadSession(
    session: CanonicalMediaUploadSessionObservation,
    signal?: AbortSignal,
  ): Promise<CanonicalMediaArtifactObservation>;
  /** Legacy ID-only call retained for compatibility; it cannot bind the artifact to expected upload content. */
  public async completeUploadSession(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<CanonicalMediaArtifactObservation>;
  public async completeUploadSession(
    sessionOrId: CanonicalMediaUploadSessionObservation | string,
    signal?: AbortSignal,
  ): Promise<CanonicalMediaArtifactObservation> {
    const session = typeof sessionOrId === "string" ? undefined
      : parseCanonicalMediaUploadSession(JSON.parse(JSON.stringify(sessionOrId)));
    const requestedId = safeIdentityHeader("uploadId", session?.uploadId ?? sessionOrId as string);
    if (!requestedId || requestedId === "." || requestedId === ".." || /[\\/]/u.test(requestedId)) {
      throw new Error("Upload completion requires a safe upload ID path segment.");
    }
    const principalId = this.requirePrincipalId("upload operations");
    if (session) {
      this.assertUploadScope(session, principalId);
      if (session.status !== "OPEN" || session.bytesReceived !== session.expectedSizeBytes) {
        throw new Error("Session-based completion requires an OPEN, complete upload session.");
      }
    }
    const artifact = await this.request(
      "POST", `/api/v1/artifacts/uploads/${encodeURIComponent(requestedId)}/complete`, undefined,
      { parse: parseCanonicalMediaArtifactObservation }, signal,
    );
    if (artifact.tenantId !== this.tenantId || artifact.principalId !== principalId) {
      throw new TypeError("Canonical Media artifact response scope does not match the caller.");
    }
    if (session && (artifact.sizeBytes !== session.expectedSizeBytes
      || artifact.sha256 !== session.expectedSha256 || artifact.fileName !== session.fileName
      || artifact.contentType !== session.contentType || artifact.classification !== session.classification
      || !sameJson(artifact.metadata, session.metadata))) {
      throw new TypeError("Canonical Media artifact response does not bind to the completed upload session.");
    }
    return artifact;
  }

  private requirePrincipalId(operation: string): string {
    const value = Object.entries(this.defaultHeaders)
      .find(([name]) => name.toLowerCase() === "x-principal-id")?.[1];
    const principalId = safeIdentityHeader("principalId", value);
    if (!principalId) throw new Error(`Canonical ${operation} require the caller's X-Principal-Id scope header.`);
    return principalId;
  }

  private assertUploadScope(session: CanonicalMediaUploadSessionObservation, principalId: string): void {
    if (session.tenantId !== this.tenantId || session.principalId !== principalId) {
      throw new TypeError("Canonical Media upload response or request is outside the caller's tenant and principal scope.");
    }
  }

  public async getArtifact(
    artifactId: string,
    signal?: AbortSignal,
  ): Promise<CanonicalMediaArtifactObservation> {
    const requestedArtifactId = safeIdentityHeader("artifactId", artifactId);
    if (!requestedArtifactId) throw new Error("Canonical artifact reads require a non-empty artifact ID.");
    if (requestedArtifactId === "." || requestedArtifactId === ".." || /[\\/]/u.test(requestedArtifactId)) {
      throw new Error("Canonical artifact reads require a safe single path-segment artifact ID.");
    }
    const principalValue = Object.entries(this.defaultHeaders)
      .find(([name]) => name.toLowerCase() === "x-principal-id")?.[1];
    if (!principalValue) {
      throw new Error("Canonical artifact reads require the caller's X-Principal-Id scope header.");
    }
    const principalId = safeIdentityHeader("principalId", principalValue);
    if (!principalId) throw new Error("Canonical artifact reads require the caller's X-Principal-Id scope header.");
    return this.request(
      "GET",
      `/api/v1/artifacts/${encodeURIComponent(requestedArtifactId)}`,
      undefined,
      {
        parse: (input: unknown) => {
          const observation = parseCanonicalMediaArtifactObservation(input);
          if (observation.tenantId !== this.tenantId || observation.principalId !== principalId) {
            throw new TypeError("Canonical Media artifact response scope does not match the caller.");
          }
          if (observation.artifactId !== requestedArtifactId) {
            throw new TypeError("Canonical Media artifact response identity does not match the requested artifact.");
          }
          return observation;
        },
      },
      signal,
    );
  }

  public async listProviderCapabilities(
    signal?: AbortSignal,
  ): Promise<readonly ProviderCapability[]> {
    const parser: RuntimeParser<readonly ProviderCapability[]> = {
      parse: (input: unknown) => {
        if (!Array.isArray(input)) {
          throw new Error("Provider capability response must be an array.");
        }
        return input.map((item) => ProviderCapabilitySchema.parse(item));
      },
    };
    return this.request(
      "GET",
      "/api/v1/media/providers/capabilities",
      undefined,
      parser,
      signal,
    );
  }

  public transcribe(
    request: TranscriptionRequest,
    signal?: AbortSignal,
  ): Promise<MediaOperationHandle<TranscriptionResult>> {
    return this.submit(
      "/api/v1/media/transcriptions",
      TranscriptionRequestSchema.parse(request),
      TranscriptionResultSchema,
      request.idempotencyKey,
      signal,
    );
  }

  public synthesize(
    request: SynthesisRequest,
    signal?: AbortSignal,
  ): Promise<MediaOperationHandle<SynthesisResult>> {
    return this.submit(
      "/api/v1/media/syntheses",
      SynthesisRequestSchema.parse(request),
      SynthesisResultSchema,
      request.idempotencyKey,
      signal,
    );
  }

  public trainVoiceModel(
    request: VoiceTrainingRequest,
    signal?: AbortSignal,
  ): Promise<MediaOperationHandle<MediaArtifact>> {
    return this.submit(
      "/api/v1/media/voice-models:train",
      VoiceTrainingRequestSchema.parse(request),
      MediaArtifactSchema,
      request.idempotencyKey,
      signal,
    );
  }

  public convertVoice(
    request: VoiceConversionRequest,
    signal?: AbortSignal,
  ): Promise<MediaOperationHandle<MediaArtifact>> {
    return this.submit(
      "/api/v1/media/voice-conversions",
      VoiceConversionRequestSchema.parse(request),
      MediaArtifactSchema,
      request.idempotencyKey,
      signal,
    );
  }

  public analyzeMultimodal(
    request: MultimodalAnalysisRequest,
    signal?: AbortSignal,
  ): Promise<MediaOperationHandle<MediaArtifact>> {
    return this.submit(
      "/api/v1/media/multimodal-analyses",
      MultimodalAnalysisRequestSchema.parse(request),
      MediaArtifactSchema,
      request.idempotencyKey,
      signal,
    );
  }

  public getOperation(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<MediaProcessingJob> {
    return this.request(
      "GET",
      `/api/v1/media/operations/${encodeURIComponent(operationId)}`,
      undefined,
      MediaProcessingJobSchema,
      signal,
    );
  }

  public cancelOperation(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<MediaProcessingJob> {
    return this.request(
      "POST",
      `/api/v1/media/operations/${encodeURIComponent(operationId)}:cancel`,
      {},
      MediaProcessingJobSchema,
      signal,
    );
  }

  public async retryOperation<T>(
    _operationId: string,
    _resultParser: RuntimeParser<T>,
    _signal?: AbortSignal,
  ): Promise<MediaOperationHandle<T>> {
    // Keep the legacy method for source compatibility, but fail closed. The
    // observed route is absent from OpenAPI and the runtime route manifest;
    // without server-owned eligibility, attempt fencing and idempotency
    // semantics, issuing this POST could duplicate consequential work.
    throw new MediaOperationNotAdmittedError("media.operation.retry");
  }

  public getOperationResult<T>(
    operationId: string,
    parser: RuntimeParser<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.request(
      "GET",
      `/api/v1/media/operations/${encodeURIComponent(operationId)}/result`,
      undefined,
      parser,
      signal,
    );
  }

  private async submit<T>(
    path: string,
    body: unknown,
    resultParser: RuntimeParser<T>,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<MediaOperationHandle<T>> {
    const accepted = await this.request(
      "POST",
      path,
      body,
      OperationAcceptedSchema,
      signal,
      { "Idempotency-Key": idempotencyKey },
    );
    return new MediaOperationHandle(this, accepted, resultParser);
  }

  private async headers(
    additions: Readonly<Record<string, string>> = {},
  ): Promise<Headers> {
    const headers = new Headers(this.defaultHeaders);
    headers.set("Accept", "application/json");
    const requestId = crypto.randomUUID();
    headers.set("X-Request-ID", requestId);
    headers.set("X-Correlation-ID", this.requestContext.correlationId ?? requestId);
    headers.set("X-Tenant-ID", this.tenantId);
    if (this.requestContext.causationId) {
      headers.set("X-Causation-ID", this.requestContext.causationId);
    } else {
      headers.delete("X-Causation-ID");
    }
    if (this.requestContext.parentRunId) {
      headers.set("X-Parent-Run-ID", this.requestContext.parentRunId);
    } else {
      headers.delete("X-Parent-Run-ID");
    }
    if (this.requestContext.principalDelegation) {
      headers.set("X-Ghatana-Delegation", this.requestContext.principalDelegation);
    } else {
      headers.delete("X-Ghatana-Delegation");
    }
    for (const [name, value] of Object.entries(additions)) {
      headers.set(name, value);
    }
    const token = await this.getAccessToken?.();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return headers;
  }

  private async request<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body: unknown,
    parser: RuntimeParser<T>,
    signal?: AbortSignal,
    additionalHeaders: Readonly<Record<string, string>> = {},
  ): Promise<T> {
    const controller = new AbortController();
    const unlink = linkAbortSignal(signal, controller);
    const timeout = setTimeout(
      () => controller.abort(new DOMException("Request timed out", "TimeoutError")),
      this.requestTimeoutMs,
    );
    try {
      const headers = await this.headers(additionalHeaders);
      if (body !== undefined) headers.set("Content-Type", "application/json");
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      if (!response.ok) throw await this.errorFromResponse(response);
      if (response.status === 204) return parser.parse(undefined);
      return parser.parse(await response.json());
    } finally {
      clearTimeout(timeout);
      unlink();
    }
  }

  private async errorFromResponse(response: Response): Promise<MediaClientError> {
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      value = undefined;
    }
    const parsed = MediaCanonicalErrorSchema.safeParse(value);
    if (parsed.success) return new MediaClientError(parsed.data, response.status);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const envelope = value as Record<string, unknown>;
      const detail = envelope.error;
      const meta = envelope.meta;
      if (detail && typeof detail === "object" && !Array.isArray(detail)
        && meta && typeof meta === "object" && !Array.isArray(meta)) {
        const error = detail as Record<string, unknown>;
        const metadata = meta as Record<string, unknown>;
        if (typeof error.code === "string" && typeof error.message === "string"
          && typeof error.retryable === "boolean" && typeof metadata.correlationId === "string") {
          return new MediaClientError({
            code: error.code,
            message: error.message,
            correlationId: metadata.correlationId,
            retryable: error.retryable,
            category: response.status === 401 ? "AUTHENTICATION"
              : response.status === 403 ? "AUTHORIZATION"
                : response.status === 409 ? "CONFLICT"
                  : response.status === 429 ? "RATE_LIMIT"
                    : response.status >= 500 ? "INTERNAL" : "VALIDATION",
          }, response.status);
        }
      }
    }
    return new MediaClientError({
      code: `HTTP_${response.status}`,
      message: response.statusText || "Media request failed.",
      correlationId: response.headers.get("x-correlation-id") ?? "not-reported",
      retryable: response.status === 429 || response.status >= 500,
      category:
        response.status === 401
          ? "AUTHENTICATION"
          : response.status === 403
            ? "AUTHORIZATION"
            : response.status === 409
              ? "CONFLICT"
              : response.status === 429
                ? "RATE_LIMIT"
                : response.status >= 500
                  ? "INTERNAL"
                  : "VALIDATION",
      ...(response.headers.get("retry-after")
        ? {
            retryAfterMs:
              Number.parseFloat(response.headers.get("retry-after") ?? "0") *
              1_000,
          }
        : {}),
    }, response.status);
  }
}

export function createMediaOperationClient(
  config: MediaOperationClientConfig,
): MediaOperationClient {
  return new MediaOperationClient(config);
}
