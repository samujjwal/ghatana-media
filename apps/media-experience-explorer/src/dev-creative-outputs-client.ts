import { DevCreativeHostError } from "@audio-video/ui/screens";
import { createDevArtifactContentClient } from "./dev-artifact-content-client";
import type { DevCreativeHostResponse, DevCreativeOutputsPort } from "@audio-video/ui/screens";

/**
 * Loopback fetch adapter for the DEV_ONLY creative-output routes. The token is read from page memory per call
 * and never stored. Success responses (200/201) resolve with the exact status and body; every other outcome
 * rejects with a typed {@link DevCreativeHostError}. A mutation whose outcome cannot be observed is status 0 /
 * OUTCOME_UNKNOWN so the UI retries the same requestId. The exact-version content route is exposed as
 * readArtifactContent; the panel reads the simulation document through it with SHA-256 verification, so the
 * adapter does not implement the unverified readSimulationDocument port.
 */
export function createDevCreativeOutputsClient(options: {
  readonly origin: string;
  readonly bearerToken: () => string;
  readonly fetch?: typeof fetch;
}): DevCreativeOutputsPort {
  const fetcher = options.fetch ?? fetch;
  async function call(method: "GET" | "POST", path: string, body: unknown, mutating: boolean): Promise<DevCreativeHostResponse> {
    const token = options.bearerToken();
    if (!token || token.startsWith("Bearer ")) throw new DevCreativeHostError("INVALID_CONFIGURATION", 0, "A raw DEV_ONLY bearer token is required.");
    let response: Response;
    try {
      response = await fetcher.call(globalThis, `${options.origin}${path}`, {
        method, credentials: "omit", redirect: "error", cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new DevCreativeHostError(mutating ? "OUTCOME_UNKNOWN" : "TRANSPORT_ERROR", 0, "The local Media host did not return a response.");
    }
    let parsed: unknown;
    try { parsed = await response.json(); } catch {
      throw new DevCreativeHostError(mutating ? "OUTCOME_UNKNOWN" : "INVALID_RESPONSE", response.status, "The host returned an unreadable response.");
    }
    if (response.ok) return { status: response.status, body: parsed };
    const error = (parsed as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)?.error;
    const code = typeof error?.code === "string" && error.code ? error.code : "HTTP_ERROR";
    const message = typeof error?.message === "string" && error.message ? error.message : "The local Media request failed.";
    const details = error?.details && typeof error.details === "object" ? error.details as Record<string, unknown> : undefined;
    throw new DevCreativeHostError(code, response.status, message, details);
  }
  return {
    repairAudio: (request) => call("POST", "/dev/v1/creative-outputs/audio-repairs", request, true),
    simulate: (request) => call("POST", "/dev/v1/creative-outputs/simulations", request, true),
    exportSpatialGlb: (request) => call("POST", "/dev/v1/creative-outputs/spatial-glb", request, true),
    getOutput: (outputId) => call("GET", `/dev/v1/creative-outputs/${encodeURIComponent(outputId)}`, undefined, false),
    readArtifactContent: createDevArtifactContentClient(options),
  };
}
