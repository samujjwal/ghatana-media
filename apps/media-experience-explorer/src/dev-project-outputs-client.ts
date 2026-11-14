import { DevOutputsHostError } from "@audio-video/ui/screens";
import { createDevArtifactContentClient } from "./dev-artifact-content-client";
import type { DevHostResponse, DevProjectOutputsPort } from "@audio-video/ui/screens";

/**
 * Loopback fetch adapter for the DEV_ONLY render, review, rights and export routes. The token is read from page
 * memory per call and never stored. Success responses (2xx, including a not-yet-confirmed 202 export) resolve with the exact status and
 * body; every other outcome rejects with a typed {@link DevOutputsHostError}. A failed mutation
 * whose outcome cannot be observed is status 0 / OUTCOME_UNKNOWN so the UI retries the same requestId.
 */
export function createDevProjectOutputsClient(options: {
  readonly origin: string;
  readonly bearerToken: () => string;
  /** Verified principal id from /dev/v1/context; lets the review UI derive reviewer eligibility. */
  readonly principalId?: string;
  readonly fetch?: typeof fetch;
}): DevProjectOutputsPort {
  const fetcher = options.fetch ?? fetch;
  const seg = (value: string): string => encodeURIComponent(value);
  // Exact artifact versions are "sha256:<hex>"; a colon is a legal, unambiguous path character and the proxy
  // allow-list rejects percent-escapes, so it is kept literal for the rights routes.
  const idSeg = (value: string): string => encodeURIComponent(value).replace(/%3A/gu, ":");
  async function call(method: "GET" | "POST", path: string, body: unknown, mutating: boolean): Promise<DevHostResponse> {
    const token = options.bearerToken();
    if (!token || token.startsWith("Bearer ")) throw new DevOutputsHostError("INVALID_CONFIGURATION", 0, "A raw DEV_ONLY bearer token is required.");
    let response: Response;
    try {
      response = await fetcher.call(globalThis, `${options.origin}${path}`, {
        method, credentials: "omit", redirect: "error", cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new DevOutputsHostError(mutating ? "OUTCOME_UNKNOWN" : "TRANSPORT_ERROR", 0, "The local Media host did not return a response.");
    }
    let parsed: unknown;
    try { parsed = await response.json(); } catch {
      throw new DevOutputsHostError(mutating ? "OUTCOME_UNKNOWN" : "INVALID_RESPONSE", response.status, "The host returned an unreadable response.");
    }
    if (response.ok) return { status: response.status, body: parsed };
    const error = (parsed as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)?.error;
    const code = typeof error?.code === "string" && error.code ? error.code : "HTTP_ERROR";
    const message = typeof error?.message === "string" && error.message ? error.message : "The local Media request failed.";
    const details = error?.details && typeof error.details === "object" ? error.details as Record<string, unknown> : undefined;
    throw new DevOutputsHostError(code, response.status, message, details);
  }
  return {
    ...(options.principalId ? { principalId: options.principalId } : {}),
    requestRender: (projectId, request) => call("POST", `/dev/v1/projects/${seg(projectId)}/renders`, request, true),
    getRender: (projectId, renderId) => call("GET", `/dev/v1/projects/${seg(projectId)}/renders/${seg(renderId)}`, undefined, false),
    openReview: (subject) => call("POST", "/dev/v1/reviews", { subject }, true),
    getReview: (caseId) => call("GET", `/dev/v1/reviews/${seg(caseId)}`, undefined, false),
    addReviewComment: (caseId, request) => call("POST", `/dev/v1/reviews/${seg(caseId)}/comments`, request, true),
    recordReviewDecision: (caseId, request) => call("POST", `/dev/v1/reviews/${seg(caseId)}/decisions`, request, true),
    assignReviewer: (caseId, request) => call("POST", `/dev/v1/reviews/${seg(caseId)}/assignments`, request, true),
    revokeReviewAssignment: (caseId, assignmentId, request) => call("POST", `/dev/v1/reviews/${seg(caseId)}/assignments/${seg(assignmentId)}/revoke`, request, true),
    createRightsAttestation: (request) => call("POST", "/dev/v1/rights/attestations", request, true),
    getRightsAttestation: (attestationId) => call("GET", `/dev/v1/rights/attestations/${idSeg(attestationId)}`, undefined, false),
    confirmRightsAttestation: (attestationId, request) => call("POST", `/dev/v1/rights/attestations/${idSeg(attestationId)}/confirm`, request, true),
    revokeRightsAttestation: (attestationId, request) => call("POST", `/dev/v1/rights/attestations/${idSeg(attestationId)}/revoke`, request, true),
    listRightsAttestations: (artifactId, artifactVersionId) =>
      call("GET", `/dev/v1/rights/artifacts/${idSeg(artifactId)}/versions/${idSeg(artifactVersionId)}/attestations`, undefined, false),
    requestExport: (request) => call("POST", "/dev/v1/exports", request, true),
    getExport: (requestId) => call("GET", `/dev/v1/exports/${seg(requestId)}`, undefined, false),
    readArtifactContent: createDevArtifactContentClient(options),
  };
}
