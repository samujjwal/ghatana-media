import { DevVideoHostError } from "@audio-video/ui/screens";
import { createDevArtifactContentClient } from "./dev-artifact-content-client";
import type { DevVideoHostResponse, DevVideoPort } from "@audio-video/ui/screens";

/**
 * Loopback fetch adapter for the DEV_ONLY video routes (measured comparison and reopen by output id). The token is read from page
 * memory per call and never stored. 200/201 resolve with the exact status and body; every other outcome rejects with a
 * typed {@link DevVideoHostError}. A POST whose outcome cannot be observed is status 0 / OUTCOME_UNKNOWN so the UI
 * retries the same requestId. Exact-version content is read through the verified content route.
 */
export function createDevVideoClient(options: {
  readonly origin: string;
  readonly bearerToken: () => string;
  readonly fetch?: typeof fetch;
}): DevVideoPort {
  const fetcher = options.fetch ?? fetch;
  async function call(method: "GET" | "POST", path: string, body: unknown): Promise<DevVideoHostResponse> {
    const token = options.bearerToken();
    if (!token || token.startsWith("Bearer ")) throw new DevVideoHostError("INVALID_CONFIGURATION", 0, "A raw DEV_ONLY bearer token is required.");
    let response: Response;
    try {
      response = await fetcher.call(globalThis, `${options.origin}${path}`, {
        method, credentials: "omit", redirect: "error", cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new DevVideoHostError(method === "POST" ? "OUTCOME_UNKNOWN" : "TRANSPORT_ERROR", 0, "The local Media host did not return a response.");
    }
    let parsed: unknown;
    try { parsed = await response.json(); } catch {
      throw new DevVideoHostError(method === "POST" ? "OUTCOME_UNKNOWN" : "INVALID_RESPONSE", response.status, "The host returned an unreadable response.");
    }
    if (response.ok) return { status: response.status, body: parsed };
    const error = (parsed as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)?.error;
    const code = typeof error?.code === "string" && error.code ? error.code : "HTTP_ERROR";
    const message = typeof error?.message === "string" && error.message ? error.message : "The local Media request failed.";
    const details = error?.details && typeof error.details === "object" ? error.details as Record<string, unknown> : undefined;
    throw new DevVideoHostError(code, response.status, message, details);
  }
  return {
    compare: (request) => call("POST", "/dev/v1/video/comparisons", request),
    getComparison: (outputId) => call("GET", `/dev/v1/video/comparisons/${encodeURIComponent(outputId)}`, undefined),
    readArtifactContent: createDevArtifactContentClient(options),
  };
}
