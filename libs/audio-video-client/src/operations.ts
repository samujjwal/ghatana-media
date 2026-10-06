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
  UploadSessionSchema,
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
  type UploadSession,
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

export interface CreateUploadSessionRequest {
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly classification:
    | "PUBLIC"
    | "INTERNAL"
    | "CONFIDENTIAL"
    | "RESTRICTED"
    | "BIOMETRIC";
  readonly kind:
    | "AUDIO"
    | "VIDEO"
    | "IMAGE"
    | "TRANSCRIPT"
    | "VOICE_MODEL"
    | "DERIVED";
  readonly idempotencyKey: string;
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

  public constructor(detail: MediaCanonicalError) {
    super(detail.message);
    this.name = "MediaClientError";
    this.detail = detail;
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
  ): Promise<UploadSession> {
    if (!request.fileName.trim()) throw new Error("fileName is required.");
    if (!request.mimeType.trim()) throw new Error("mimeType is required.");
    if (!Number.isInteger(request.sizeBytes) || request.sizeBytes < 0) {
      throw new Error("sizeBytes must be a non-negative integer.");
    }
    if (!/^[a-f0-9]{64}$/u.test(request.checksumSha256)) {
      throw new Error("checksumSha256 must be a lowercase SHA-256 digest.");
    }
    return this.request(
      "POST",
      "/api/v1/media/uploads",
      request,
      UploadSessionSchema,
      signal,
      { "Idempotency-Key": request.idempotencyKey },
    );
  }

  public async uploadPart(
    session: UploadSession,
    partNumber: number,
    data: Blob,
    options: {
      readonly signal?: AbortSignal;
      readonly onProgress?: (progress: UploadProgress) => void;
    } = {},
  ): Promise<void> {
    if (!Number.isInteger(partNumber) || partNumber < 1) {
      throw new Error("partNumber must be a positive integer.");
    }
    const controller = new AbortController();
    const unlink = linkAbortSignal(options.signal, controller);
    const timeout = setTimeout(
      () => controller.abort(new DOMException("Upload timed out", "TimeoutError")),
      this.requestTimeoutMs,
    );
    options.onProgress?.({ uploadedBytes: 0, totalBytes: data.size, percentage: 0 });
    try {
      const headers = await this.headers({
        "Content-Type": data.type || "application/octet-stream",
      });
      const response = await this.fetchImpl(
        `${this.baseUrl}/api/v1/media/uploads/${encodeURIComponent(session.id)}/parts/${partNumber}`,
        { method: "PUT", headers, body: data, signal: controller.signal },
      );
      if (!response.ok) throw await this.errorFromResponse(response);
      options.onProgress?.({
        uploadedBytes: data.size,
        totalBytes: data.size,
        percentage: 100,
      });
    } finally {
      clearTimeout(timeout);
      unlink();
    }
  }

  public completeUploadSession(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<MediaArtifact> {
    return this.request(
      "POST",
      `/api/v1/media/uploads/${encodeURIComponent(sessionId)}:complete`,
      {},
      MediaArtifactSchema,
      signal,
    );
  }

  public getArtifact(
    artifactId: string,
    signal?: AbortSignal,
  ): Promise<MediaArtifact> {
    return this.request(
      "GET",
      `/api/v1/media/artifacts/${encodeURIComponent(artifactId)}`,
      undefined,
      MediaArtifactSchema,
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
    operationId: string,
    resultParser: RuntimeParser<T>,
    signal?: AbortSignal,
  ): Promise<MediaOperationHandle<T>> {
    const accepted = await this.request(
      "POST",
      `/api/v1/media/operations/${encodeURIComponent(operationId)}:retry`,
      {},
      OperationAcceptedSchema,
      signal,
    );
    return new MediaOperationHandle(this, accepted, resultParser);
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
    if (parsed.success) return new MediaClientError(parsed.data);
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
    });
  }
}

export function createMediaOperationClient(
  config: MediaOperationClientConfig,
): MediaOperationClient {
  return new MediaOperationClient(config);
}
