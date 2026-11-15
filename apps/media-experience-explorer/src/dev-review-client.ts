/** Typed refusal from the DEV_ONLY review host; `status` 0 means no response could be observed. */
export class DevReviewHostError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
    this.name = "DevReviewHostError";
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface DevReviewResponse { readonly status: number; readonly body: any }

/**
 * Loopback fetch adapter for the DEV_ONLY versioned review routes. The token is read from page memory per call and never
 * stored; a response that cannot be read is an unknown outcome and the page does not retry on its own.
 */
export interface DevReviewClient {
  getContext(): Promise<DevReviewResponse>;
  listAssigned(): Promise<DevReviewResponse>;
  getCase(caseId: string): Promise<DevReviewResponse>;
  getVersions(caseId: string): Promise<DevReviewResponse>;
  getLineage(lineageId: string): Promise<DevReviewResponse>;
  openReview(artifactId: string, artifactVersionId: string): Promise<DevReviewResponse>;
  comment(caseId: string, body: unknown): Promise<DevReviewResponse>;
  decide(caseId: string, body: unknown): Promise<DevReviewResponse>;
  assign(caseId: string, body: unknown): Promise<DevReviewResponse>;
  readContent(caseId: string): Promise<{ readonly bytes: ArrayBuffer; readonly contentType: string }>;
}

export function createDevReviewClient(options: { readonly origin: string; readonly bearerToken: () => string; readonly fetch?: typeof fetch }): DevReviewClient {
  const fetcher = options.fetch ?? fetch;

  async function raw(method: "GET" | "POST", path: string, body: unknown): Promise<Response> {
    const token = options.bearerToken();
    if (!token || token.startsWith("Bearer ")) throw new DevReviewHostError("INVALID_CONFIGURATION", 0, "A raw DEV_ONLY bearer token is required.");
    try {
      return await fetcher.call(globalThis, `${options.origin}${path}`, {
        method, credentials: "omit", redirect: "error", cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new DevReviewHostError(method === "POST" ? "OUTCOME_UNKNOWN" : "TRANSPORT_ERROR", 0, "The local Media host did not return a response.");
    }
  }

  async function refusal(response: Response): Promise<DevReviewHostError> {
    let parsed: { error?: { code?: unknown; message?: unknown } } | null = null;
    try { parsed = await response.json(); } catch { /* unreadable body */ }
    const code = typeof parsed?.error?.code === "string" && parsed.error.code ? parsed.error.code : "HTTP_ERROR";
    const message = typeof parsed?.error?.message === "string" && parsed.error.message ? parsed.error.message : "The local Media request failed.";
    return new DevReviewHostError(code, response.status, message);
  }

  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<DevReviewResponse> {
    const response = await raw(method, path, body);
    if (!response.ok) throw await refusal(response);
    try { return { status: response.status, body: await response.json() }; } catch {
      throw new DevReviewHostError(method === "POST" ? "OUTCOME_UNKNOWN" : "INVALID_RESPONSE", response.status, "The host returned an unreadable response.");
    }
  }

  const id = encodeURIComponent;
  return {
    getContext: () => call("GET", "/dev/v1/context"),
    listAssigned: () => call("GET", "/dev/v1/reviews"),
    getCase: (caseId) => call("GET", `/dev/v1/reviews/${id(caseId)}`),
    getVersions: (caseId) => call("GET", `/dev/v1/reviews/${id(caseId)}/versions`),
    getLineage: (lineageId) => call("GET", `/dev/v1/review-lineages/${id(lineageId)}`),
    openReview: (artifactId, artifactVersionId) => call("POST", "/dev/v1/reviews", { subject: { kind: "ARTIFACT_VERSION", artifactId, artifactVersionId } }),
    comment: (caseId, body) => call("POST", `/dev/v1/reviews/${id(caseId)}/comments`, body),
    decide: (caseId, body) => call("POST", `/dev/v1/reviews/${id(caseId)}/decisions`, body),
    assign: (caseId, body) => call("POST", `/dev/v1/reviews/${id(caseId)}/assignments`, body),
    readContent: async (caseId) => {
      const response = await raw("GET", `/dev/v1/reviews/${id(caseId)}/content`, undefined);
      if (!response.ok) throw await refusal(response);
      return { bytes: await response.arrayBuffer(), contentType: response.headers.get("Content-Type") ?? "application/octet-stream" };
    },
  };
}
