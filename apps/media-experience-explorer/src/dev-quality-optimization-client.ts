/**
 * Loopback fetch adapter for the DEV_ONLY quality optimization routes (J-19): status, bounded search, cancel, report
 * reopen, lineage read and undo. The token is read from page memory per call and never stored. 200/201 resolve with the
 * exact status and body; every other outcome rejects with a typed {@link DevQualityHostError}. A POST whose outcome cannot
 * be observed is status 0 / OUTCOME_UNKNOWN so the page retries the same requestId.
 */
export class DevQualityHostError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DevQualityHostError";
  }
}

export interface DevQualityHostResponse { readonly status: number; readonly body: unknown; }

export interface DevQualityPort {
  status(): Promise<DevQualityHostResponse>;
  optimize(request: unknown): Promise<DevQualityHostResponse>;
  cancel(requestId: string): Promise<DevQualityHostResponse>;
  getReport(reportArtifactId: string): Promise<DevQualityHostResponse>;
  getLineage(lineageId: string): Promise<DevQualityHostResponse>;
  undo(lineageId: string, request: unknown): Promise<DevQualityHostResponse>;
}

export function createDevQualityClient(options: {
  readonly origin: string;
  readonly bearerToken: () => string;
  readonly fetch?: typeof fetch;
}): DevQualityPort {
  const fetcher = options.fetch ?? fetch;
  async function call(method: "GET" | "POST", path: string, body: unknown): Promise<DevQualityHostResponse> {
    const token = options.bearerToken();
    if (!token || token.startsWith("Bearer ")) throw new DevQualityHostError("INVALID_CONFIGURATION", 0, "A raw DEV_ONLY bearer token is required.");
    let response: Response;
    try {
      response = await fetcher.call(globalThis, `${options.origin}${path}`, {
        method, credentials: "omit", redirect: "error", cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new DevQualityHostError(method === "POST" ? "OUTCOME_UNKNOWN" : "TRANSPORT_ERROR", 0, "The local Media host did not return a response.");
    }
    let parsed: unknown;
    try { parsed = await response.json(); } catch {
      throw new DevQualityHostError(method === "POST" ? "OUTCOME_UNKNOWN" : "INVALID_RESPONSE", response.status, "The host returned an unreadable response.");
    }
    if (response.ok) return { status: response.status, body: parsed };
    const error = (parsed as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)?.error;
    const code = typeof error?.code === "string" && error.code ? error.code : "HTTP_ERROR";
    const message = typeof error?.message === "string" && error.message ? error.message : "The local Media request failed.";
    const details = error?.details && typeof error.details === "object" ? error.details as Record<string, unknown> : undefined;
    throw new DevQualityHostError(code, response.status, message, details);
  }
  const id = encodeURIComponent;
  return {
    status: () => call("GET", "/dev/v1/quality/status", undefined),
    optimize: (request) => call("POST", "/dev/v1/quality/optimizations", request),
    cancel: (requestId) => call("POST", `/dev/v1/quality/optimizations/${id(requestId)}/cancel`, {}),
    getReport: (reportArtifactId) => call("GET", `/dev/v1/quality/optimizations/${id(reportArtifactId)}`, undefined),
    getLineage: (lineageId) => call("GET", `/dev/v1/quality/lineages/${id(lineageId)}`, undefined),
    undo: (lineageId, request) => call("POST", `/dev/v1/quality/lineages/${id(lineageId)}/undo`, request),
  };
}
