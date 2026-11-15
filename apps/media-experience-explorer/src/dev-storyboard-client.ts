/**
 * Loopback fetch adapter for the DEV_ONLY storyboard routes (J-09) and the existing rights attestation route. The bearer
 * token is read from page memory per call and never stored. A mutation whose outcome cannot be observed is
 * OUTCOME_UNKNOWN so the page retries the same requestId. Typed host errors keep their `details` (the offending path of a
 * typed 422, the per-shot blockers of a refused render, the head version of a stale edit).
 */
export class StoryboardHostError extends Error {
  constructor(readonly code: string, readonly status: number, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "StoryboardHostError";
  }
}

export interface StoryboardPort {
  capabilities(): Promise<unknown>;
  create(body: Record<string, unknown>): Promise<unknown>;
  head(storyboardId: string): Promise<unknown>;
  version(storyboardId: string, versionNumber: number): Promise<unknown>;
  edit(storyboardId: string, body: Record<string, unknown>): Promise<unknown>;
  readiness(storyboardId: string): Promise<unknown>;
  render(storyboardId: string, requestId: string, storyboardVersion: number): Promise<unknown>;
  renderOf(storyboardId: string, versionNumber: number): Promise<unknown>;
  openReview(storyboardId: string, versionNumber: number): Promise<unknown>;
  reviewStatus(storyboardId: string, versionNumber: number): Promise<unknown>;
  attest(body: Record<string, unknown>): Promise<unknown>;
}

export function createStoryboardClient(options: {
  readonly origin: string;
  readonly bearerToken: () => string;
  readonly fetch?: typeof fetch;
}): StoryboardPort {
  const fetcher = options.fetch ?? fetch;
  const segment = (value: string): string => encodeURIComponent(value);

  async function call(method: "GET" | "POST", path: string, body: unknown, mutating: boolean): Promise<unknown> {
    const token = options.bearerToken();
    if (!token || token.startsWith("Bearer ")) throw new StoryboardHostError("INVALID_CONFIGURATION", 0, "A raw DEV_ONLY bearer token is required.");
    let response: Response;
    try {
      response = await fetcher.call(globalThis, `${options.origin}${path}`, {
        method, credentials: "omit", redirect: "error", cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new StoryboardHostError(mutating ? "OUTCOME_UNKNOWN" : "TRANSPORT_ERROR", 0, "The local Media host did not return a response.");
    }
    let parsed: unknown;
    try { parsed = await response.json(); } catch {
      throw new StoryboardHostError(mutating ? "OUTCOME_UNKNOWN" : "INVALID_RESPONSE", response.status, "The host returned an unreadable response.");
    }
    if (response.ok) return parsed;
    const error = (parsed as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)?.error;
    const code = typeof error?.code === "string" && error.code ? error.code : "HTTP_ERROR";
    const message = typeof error?.message === "string" && error.message ? error.message : "The local Media request failed.";
    const details = error?.details && typeof error.details === "object" ? error.details as Record<string, unknown> : undefined;
    throw new StoryboardHostError(code, response.status, message, details);
  }

  const base = "/dev/v1/storyboards";
  return {
    capabilities: () => call("GET", `${base}/capabilities`, undefined, false),
    create: (body) => call("POST", base, body, true),
    head: (id) => call("GET", `${base}/${segment(id)}`, undefined, false),
    version: (id, n) => call("GET", `${base}/${segment(id)}/versions/${n}`, undefined, false),
    edit: (id, body) => call("POST", `${base}/${segment(id)}/versions`, body, true),
    readiness: (id) => call("GET", `${base}/${segment(id)}/readiness`, undefined, false),
    render: (id, requestId, storyboardVersion) => call("POST", `${base}/${segment(id)}/renders`, { requestId, storyboardVersion }, true),
    renderOf: (id, n) => call("GET", `${base}/${segment(id)}/versions/${n}/render`, undefined, false),
    openReview: (id, n) => call("POST", `${base}/${segment(id)}/versions/${n}/review`, {}, true),
    reviewStatus: (id, n) => call("GET", `${base}/${segment(id)}/versions/${n}/review`, undefined, false),
    attest: (body) => call("POST", "/dev/v1/rights/attestations", body, true),
  };
}
