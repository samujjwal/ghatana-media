import { createDevArtifactContentClient } from "./dev-artifact-content-client";

export interface DevRigHostResponse { readonly status: number; readonly body: unknown }

/** Typed host failure. `status` 0 means no response was observed (outcome unknown). `details` names the JSON path of a refusal. */
export class DevRigHostError extends Error {
  constructor(readonly code: string, readonly status: number, message: string, readonly details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "DevRigHostError";
  }
}

export interface DevRigPort {
  getStatus(): Promise<DevRigHostResponse>;
  render(request: { readonly requestId: string; readonly spec: unknown; readonly encoder?: { readonly crf: number } }): Promise<DevRigHostResponse>;
  readArtifactContent: ReturnType<typeof createDevArtifactContentClient>;
}

/**
 * Loopback fetch adapter for the DEV_ONLY deterministic 3D rig render routes. The token is read from page memory per call and
 * never stored. A mutation whose outcome cannot be observed is status 0 / OUTCOME_UNKNOWN so the page retries the same requestId.
 */
export function createDevRigClient(options: {
  readonly origin: string;
  readonly bearerToken: () => string;
  readonly fetch?: typeof fetch;
}): DevRigPort {
  const fetcher = options.fetch ?? fetch;

  async function call(method: "GET" | "POST", path: string, body: unknown, mutating: boolean): Promise<DevRigHostResponse> {
    const token = options.bearerToken();
    if (!token || token.startsWith("Bearer ")) throw new DevRigHostError("INVALID_CONFIGURATION", 0, "A raw DEV_ONLY bearer token is required.");
    let response: Response;
    try {
      response = await fetcher.call(globalThis, `${options.origin}${path}`, {
        method, credentials: "omit", redirect: "error", cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new DevRigHostError(mutating ? "OUTCOME_UNKNOWN" : "TRANSPORT_ERROR", 0, "The local Media host did not return a response.");
    }
    let parsed: unknown;
    try { parsed = await response.json(); } catch {
      throw new DevRigHostError(mutating ? "OUTCOME_UNKNOWN" : "INVALID_RESPONSE", response.status, "The host returned an unreadable response.");
    }
    if (response.ok) return { status: response.status, body: parsed };
    const error = (parsed as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)?.error;
    const code = typeof error?.code === "string" && error.code ? error.code : "HTTP_ERROR";
    const message = typeof error?.message === "string" && error.message ? error.message : "The local Media request failed.";
    const details = error?.details && typeof error.details === "object" ? error.details as Record<string, unknown> : undefined;
    throw new DevRigHostError(code, response.status, message, details);
  }

  return {
    getStatus: () => call("GET", "/dev/v1/rigs/status", undefined, false),
    render: (request) => call("POST", "/dev/v1/rigs/renders", request, true),
    readArtifactContent: createDevArtifactContentClient(options),
  };
}
