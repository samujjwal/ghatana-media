import {
  MediaCanonicalErrorSchema,
  type MediaCanonicalError,
} from "@audio-video/types/contracts";

export interface RuntimeParser<T> {
  parse(input: unknown): T;
}

export interface MediaTransportConfig {
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

/**
 * A submit effect aborted after the request may have been dispatched — the
 * server-side outcome is OUTCOME_UNKNOWN, never a clean failure. Callers must
 * not retry blindly or report the job as failed; reconciliation reads the
 * durable job state instead.
 */
export class MediaOperationAmbiguousError extends Error {
  public readonly path: string;
  public constructor(path: string, cause: unknown) {
    super(`Media operation outcome is unknown after dispatch abort on ${path}`);
    this.name = "MediaOperationAmbiguousError";
    this.path = path;
    this.cause = cause;
  }
}

export class MediaOperationNotAdmittedError extends Error {
  public constructor(public readonly operation: string) {
    super(`Media operation is not admitted by the current server contract: ${operation}`);
    this.name = "MediaOperationNotAdmittedError";
  }
}

export function safeIdentityHeader(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || value.length > 255 || !/^[\x21-\x7e]+$/u.test(value)) {
    throw new Error(`Invalid media client request identity field: ${name}.`);
  }
  return value;
}

export function boundedPositive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? Math.round(value as number) : fallback;
}

export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Media client baseUrl is required.");
  return trimmed.replace(/\/+$/u, "");
}

export function linkAbortSignal(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => undefined;
  if (source.aborted) {
    target.abort(source.reason);
    return () => undefined;
  }
  const onAbort = (): void => target.abort(source.reason);
  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}

export function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
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

/**
 * Shared HTTP transport for all Media clients — one authority for header
 * construction, request timeout/abort linkage and canonical error mapping.
 * The bearer token comes only from the configured credential provider and is
 * never accepted as a per-call argument.
 */
export class MediaHttpTransport {
  public readonly baseUrl: string;
  public readonly tenantId: string;
  public readonly requestTimeoutMs: number;
  public readonly pollIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly getAccessToken?: MediaTransportConfig["getAccessToken"];
  private readonly defaultHeaders: Readonly<Record<string, string>>;
  private readonly requestContext: NonNullable<MediaTransportConfig["requestContext"]>;

  public constructor(config: MediaTransportConfig) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.tenantId = safeIdentityHeader("tenantId", config.tenantId.trim()) ?? "";
    if (!this.tenantId) throw new Error("Media client tenantId is required.");
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.getAccessToken = config.getAccessToken;
    // The configured caller identity must not change through an external mutable alias.
    this.defaultHeaders = Object.freeze({ ...config.defaultHeaders });
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

  /** The caller's immutable default headers — the principal scope never mutates per call. */
  public callerDefaultHeaders(): Readonly<Record<string, string>> {
    return this.defaultHeaders;
  }

  public async headers(
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

  /** Raw fetch through the shared timeout/abort plumbing, for binary bodies. */
  public async fetchRaw(
    input: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const unlink = linkAbortSignal(signal, controller);
    const timeout = setTimeout(
      () => controller.abort(new DOMException("Request timed out", "TimeoutError")),
      this.requestTimeoutMs,
    );
    try {
      return await this.fetchImpl(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
      unlink();
    }
  }

  public async request<T>(
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

  public async errorFromResponse(response: Response): Promise<MediaClientError> {
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
