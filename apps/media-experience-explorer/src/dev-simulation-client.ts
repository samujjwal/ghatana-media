import type { DevArtifactContentRequest, DevArtifactContentResponse } from "@audio-video/ui/screens";
import { createDevArtifactContentClient } from "./dev-artifact-content-client";

/** Typed host failure. `status` 0 means no response was observed (the outcome of a mutation is then unknown). */
export class DevSimulationHostError extends Error {
  constructor(readonly code: string, readonly status: number, message: string, readonly details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "DevSimulationHostError";
  }
}

export interface DevSimulationHostResponse { readonly status: number; readonly body: unknown }

export interface DevSimulationPort {
  getStatus(): Promise<DevSimulationHostResponse>;
  run(request: { readonly requestId: string; readonly scenario: unknown }): Promise<DevSimulationHostResponse>;
  reopen(simulationId: string): Promise<DevSimulationHostResponse>;
  readArtifactContent(request: DevArtifactContentRequest): Promise<DevArtifactContentResponse>;
}

/**
 * Loopback fetch adapter for the DEV_ONLY scientific simulation routes. The token is read from page memory per call and never
 * stored. A mutation whose outcome cannot be observed is status 0 / OUTCOME_UNKNOWN so the UI retries the same requestId. Typed
 * host errors keep their `details` (a refusal names the JSON path of the offending value).
 */
export function createDevSimulationClient(options: {
  readonly origin: string;
  readonly bearerToken: () => string;
  readonly fetch?: typeof fetch;
}): DevSimulationPort {
  const fetcher = options.fetch ?? fetch;

  async function call(method: "GET" | "POST", path: string, body: unknown, mutating: boolean): Promise<DevSimulationHostResponse> {
    const token = options.bearerToken();
    if (!token || token.startsWith("Bearer ")) throw new DevSimulationHostError("INVALID_CONFIGURATION", 0, "A raw DEV_ONLY bearer token is required.");
    let response: Response;
    try {
      response = await fetcher.call(globalThis, `${options.origin}${path}`, {
        method, credentials: "omit", redirect: "error", cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new DevSimulationHostError(mutating ? "OUTCOME_UNKNOWN" : "TRANSPORT_ERROR", 0, "The local Media host did not return a response.");
    }
    let parsed: unknown;
    try { parsed = await response.json(); } catch {
      throw new DevSimulationHostError(mutating ? "OUTCOME_UNKNOWN" : "INVALID_RESPONSE", response.status, "The host returned an unreadable response.");
    }
    if (response.ok) return { status: response.status, body: parsed };
    const error = (parsed as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)?.error;
    const code = typeof error?.code === "string" && error.code ? error.code : "HTTP_ERROR";
    const message = typeof error?.message === "string" && error.message ? error.message : "The local Media request failed.";
    const details = error?.details && typeof error.details === "object" ? error.details as Record<string, unknown> : undefined;
    throw new DevSimulationHostError(code, response.status, message, details);
  }

  return {
    getStatus: () => call("GET", "/dev/v1/simulations/status", undefined, false),
    run: (request) => call("POST", "/dev/v1/simulations", request, true),
    reopen: (simulationId) => call("GET", `/dev/v1/simulations/${encodeURIComponent(simulationId)}`, undefined, false),
    readArtifactContent: createDevArtifactContentClient(options),
  };
}
