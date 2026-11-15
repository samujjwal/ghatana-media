/** The DEV_ONLY export view returned by the host. Only fields the page renders are typed. */
export interface DevExportView {
  readonly requestId: string;
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly destinationId: string;
  readonly status: string;
  readonly ackState: "DELIVERED" | "UNKNOWN" | "NOT_DELIVERED";
  readonly failure: string | null;
  readonly acknowledgedBytes: number;
  readonly destinationReceivedBytes: number | null;
  readonly destinationConfirmed: boolean;
  readonly destinationReceiptRef: string | null;
  readonly replayed: boolean;
  readonly observedAt: string | null;
}

export class DevDeliveryHostError extends Error {
  constructor(readonly code: string, readonly httpStatus: number, message: string) {
    super(message);
    this.name = "DevDeliveryHostError";
  }
}

export interface DevDeliveryClient {
  exportArtifact(request: { requestId: string; artifactId: string; artifactVersionId: string; destinationId: string }): Promise<{ status: number; view: DevExportView }>;
  read(requestId: string): Promise<{ status: number; view: DevExportView }>;
  reconcile(requestId: string, resume: boolean): Promise<{ status: number; view: DevExportView }>;
}

/**
 * Loopback fetch adapter for the DEV_ONLY export routes. The token is read from page memory per call and never stored.
 * A mutation whose outcome cannot be observed rejects as OUTCOME_UNKNOWN so the page tells the owner to reconcile the
 * same request id rather than to export again.
 */
export function createDevDeliveryClient(options: { readonly origin: string; readonly bearerToken: () => string }): DevDeliveryClient {
  async function call(method: "GET" | "POST", path: string, body: unknown, mutating: boolean): Promise<{ status: number; view: DevExportView }> {
    const token = options.bearerToken();
    if (!token || token.startsWith("Bearer ")) throw new DevDeliveryHostError("INVALID_CONFIGURATION", 0, "A raw DEV_ONLY bearer token is required.");
    let response: Response;
    try {
      response = await fetch(`${options.origin}${path}`, {
        method, credentials: "omit", redirect: "error", cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new DevDeliveryHostError(mutating ? "OUTCOME_UNKNOWN" : "TRANSPORT_ERROR", 0, "The local Media host did not return a response.");
    }
    let parsed: unknown;
    try { parsed = await response.json(); } catch {
      throw new DevDeliveryHostError(mutating ? "OUTCOME_UNKNOWN" : "INVALID_RESPONSE", response.status, "The host returned an unreadable response.");
    }
    if (response.ok) return { status: response.status, view: parsed as DevExportView };
    const error = (parsed as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    throw new DevDeliveryHostError(
      typeof error?.code === "string" && error.code ? error.code : "HTTP_ERROR", response.status,
      typeof error?.message === "string" && error.message ? error.message : "The local Media request failed.");
  }
  return {
    exportArtifact: (request) => call("POST", "/dev/v1/exports", request, true),
    read: (requestId) => call("GET", `/dev/v1/exports/${encodeURIComponent(requestId)}`, undefined, false),
    reconcile: (requestId, resume) => call("POST", `/dev/v1/exports/${encodeURIComponent(requestId)}/reconcile`, { resume }, true),
  };
}
