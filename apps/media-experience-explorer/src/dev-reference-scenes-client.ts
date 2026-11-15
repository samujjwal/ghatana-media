/**
 * Loopback fetch adapter for the DEV_ONLY reference-conditioned scene routes (J-10). The bearer token is read from page
 * memory per call and never stored. A mutation whose outcome cannot be observed is OUTCOME_UNKNOWN so the page retries the
 * same requestId. Typed host errors keep their `details` (the JSON path of an invalid value, the failing continuity
 * metrics, the verdict of a rights refusal).
 */
export class ReferenceScenesHostError extends Error {
  constructor(readonly code: string, readonly status: number, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "ReferenceScenesHostError";
  }
}

export interface ReferenceScenesPort {
  status(): Promise<unknown>;
  registerSet(body: Record<string, unknown>): Promise<unknown>;
  generate(body: Record<string, unknown>): Promise<unknown>;
  regenerate(runId: string): Promise<unknown>;
}

export function createReferenceScenesClient(options: {
  readonly origin: string;
  readonly bearerToken: () => string;
  readonly fetch?: typeof fetch;
}): ReferenceScenesPort {
  const fetcher = options.fetch ?? fetch;

  async function call(method: "GET" | "POST", path: string, body: unknown, mutating: boolean): Promise<unknown> {
    const token = options.bearerToken();
    if (!token || token.startsWith("Bearer ")) throw new ReferenceScenesHostError("INVALID_CONFIGURATION", 0, "A raw DEV_ONLY bearer token is required.");
    let response: Response;
    try {
      response = await fetcher.call(globalThis, `${options.origin}${path}`, {
        method, credentials: "omit", redirect: "error", cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ReferenceScenesHostError(mutating ? "OUTCOME_UNKNOWN" : "TRANSPORT_ERROR", 0, "The local Media host did not return a response.");
    }
    let parsed: unknown;
    try { parsed = await response.json(); } catch {
      throw new ReferenceScenesHostError(mutating ? "OUTCOME_UNKNOWN" : "INVALID_RESPONSE", response.status, "The host returned an unreadable response.");
    }
    if (response.ok) return parsed;
    const error = (parsed as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)?.error;
    const code = typeof error?.code === "string" && error.code ? error.code : "HTTP_ERROR";
    const message = typeof error?.message === "string" && error.message ? error.message : "The local Media request failed.";
    const details = error?.details && typeof error.details === "object" ? error.details as Record<string, unknown> : undefined;
    throw new ReferenceScenesHostError(code, response.status, message, details);
  }

  return {
    status: () => call("GET", "/dev/v1/reference-scenes/status", undefined, false),
    registerSet: (body) => call("POST", "/dev/v1/reference-scenes/reference-sets", body, true),
    generate: (body) => call("POST", "/dev/v1/reference-scenes/runs", body, true),
    regenerate: (runId) => call("POST", `/dev/v1/reference-scenes/runs/${encodeURIComponent(runId)}/regenerations`, {}, true),
  };
}
