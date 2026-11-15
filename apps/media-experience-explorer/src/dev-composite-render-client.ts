import { DevCompositeHostError } from "@audio-video/ui/screens";
import type { DevCompositeHostResponse, DevCompositePort } from "@audio-video/ui/screens";
import { createDevArtifactContentClient } from "./dev-artifact-content-client";

/**
 * Loopback fetch adapter for the DEV_ONLY composite render routes and the existing project routes used to place clips. The token is
 * read from page memory per call and never stored. A mutation whose outcome cannot be observed is status 0 / OUTCOME_UNKNOWN so the
 * UI retries the same requestId. Typed host errors keep their `details` (the offending path of a typed 422).
 */
export function createDevCompositeRenderClient(options: {
  readonly origin: string;
  readonly bearerToken: () => string;
  readonly fetch?: typeof fetch;
}): DevCompositePort {
  const fetcher = options.fetch ?? fetch;
  const segment = (value: string): string => encodeURIComponent(value);

  async function call(method: "GET" | "POST", path: string, body: unknown, mutating: boolean): Promise<DevCompositeHostResponse> {
    const token = options.bearerToken();
    if (!token || token.startsWith("Bearer ")) throw new DevCompositeHostError("INVALID_CONFIGURATION", 0, "A raw DEV_ONLY bearer token is required.");
    let response: Response;
    try {
      response = await fetcher.call(globalThis, `${options.origin}${path}`, {
        method, credentials: "omit", redirect: "error", cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new DevCompositeHostError(mutating ? "OUTCOME_UNKNOWN" : "TRANSPORT_ERROR", 0, "The local Media host did not return a response.");
    }
    let parsed: unknown;
    try { parsed = await response.json(); } catch {
      throw new DevCompositeHostError(mutating ? "OUTCOME_UNKNOWN" : "INVALID_RESPONSE", response.status, "The host returned an unreadable response.");
    }
    if (response.ok) return { status: response.status, body: parsed };
    const error = (parsed as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)?.error;
    const code = typeof error?.code === "string" && error.code ? error.code : "HTTP_ERROR";
    const message = typeof error?.message === "string" && error.message ? error.message : "The local Media request failed.";
    const details = error?.details && typeof error.details === "object" ? error.details as Record<string, unknown> : undefined;
    throw new DevCompositeHostError(code, response.status, message, details);
  }

  return {
    getCapabilities: () => call("GET", "/dev/v1/composite-renders/capabilities", undefined, false),
    readHead: (projectId) => call("GET", `/dev/v1/projects/${segment(projectId)}`, undefined, false),
    applyEdits: (projectId, timelineId, expectedHeadRevisionId, edits) =>
      call("POST", `/dev/v1/projects/${segment(projectId)}/timelines/${segment(timelineId)}/edits`, { expectedHeadRevisionId, edits }, true),
    render: (request) => call("POST", "/dev/v1/composite-renders", request, true),
    cancel: (requestId) => call("POST", `/dev/v1/composite-renders/${segment(requestId)}/cancel`, {}, true),
    readArtifactContent: createDevArtifactContentClient(options),
  };
}
