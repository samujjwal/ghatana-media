import { DevContentError } from "@audio-video/ui/screens";
import type { DevArtifactContentRequest, DevArtifactContentResponse } from "@audio-video/ui/screens";

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const EXACT_VERSION = /^sha256:[0-9a-f]{64}$/u;

/**
 * Loopback adapter for the DEV_ONLY exact-version content route (GET /dev/v1/artifacts/{id}/content).
 *
 * The exact version travels in the If-Match header and the bearer token in the Authorization header: neither is ever
 * placed in a URL. The whole body is read with a hard byte cap (refused before buffering when Content-Length is over
 * it, and again while streaming). No Range request is made: a larger artifact is refused with CONTENT_TOO_LARGE.
 * The caller verifies the bytes' SHA-256, size and type; this adapter only moves bytes and types failures.
 */
export function createDevArtifactContentClient(options: {
  readonly origin: string;
  readonly bearerToken: () => string;
  readonly fetch?: typeof fetch;
}): (request: DevArtifactContentRequest) => Promise<DevArtifactContentResponse> {
  const fetcher = options.fetch ?? fetch;
  return async ({ artifactId, artifactVersionId, maxBytes }) => {
    const token = options.bearerToken();
    if (!token || token.startsWith("Bearer ")) throw new DevContentError("INVALID_CONFIGURATION", 0, "A raw DEV_ONLY bearer token is required.");
    if (!OPAQUE_ID.test(artifactId) || !EXACT_VERSION.test(artifactVersionId)) {
      throw new DevContentError("INVALID_REQUEST", 0, "The artifact id or exact version is malformed. Nothing was requested.");
    }
    let response: Response;
    try {
      response = await fetcher.call(globalThis, `${options.origin}/dev/v1/artifacts/${encodeURIComponent(artifactId)}/content`, {
        method: "GET", credentials: "omit", redirect: "error", cache: "no-store",
        headers: { Authorization: `Bearer ${token}`, Accept: "*/*", "If-Match": artifactVersionId },
      });
    } catch {
      throw new DevContentError("TRANSPORT_ERROR", 0, "The local Media host did not return a response.");
    }
    if (!response.ok) {
      let code = "HTTP_ERROR";
      try {
        const error = ((await response.json()) as { error?: { code?: unknown } } | null)?.error;
        if (typeof error?.code === "string" && error.code) code = error.code;
      } catch { /* an unreadable error body still fails closed with its status */ }
      throw new DevContentError(code, response.status, `The host refused the content request (${response.status} ${code}).`);
    }
    if (response.status !== 200) throw new DevContentError("INVALID_RESPONSE", response.status, `Unexpected content status ${response.status}; this page reads whole files only.`);
    const declared = Number(response.headers.get("Content-Length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new DevContentError("CONTENT_TOO_LARGE", 200, `The host reports ${declared} bytes, over the ${maxBytes}-byte limit for this page. Nothing was read.`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new DevContentError("INVALID_RESPONSE", 200, "The host returned no readable body.");
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new DevContentError("CONTENT_TOO_LARGE", 200, `The body is over the ${maxBytes}-byte limit for this page. Reading stopped; nothing is shown.`);
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof DevContentError) throw error;
      throw new DevContentError("TRANSPORT_ERROR", 0, "The content stream ended unexpectedly.");
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { status: 200, contentType: response.headers.get("Content-Type"), bytes };
  };
}
