/**
 * Concrete HTTP_API capture adapter: performs a real, bounded GET against a
 * host-resolved endpoint and returns the response bytes as the captured
 * frame. The admitted `sourceIdentity` is an opaque reference; only the
 * host-supplied resolver maps it to a concrete URL, so callers cannot aim
 * capture at arbitrary endpoints through request fields.
 *
 * Endpoint policy: HTTPS is required unless the host is loopback or the
 * origin is explicitly listed in `allowedOrigins`. Plain-HTTP non-loopback
 * origins therefore fail closed. Redirects are followed manually (bounded)
 * with the same policy re-applied to every hop, so a redirect cannot move
 * capture to an origin the policy would have rejected. URLs carrying
 * userinfo are rejected; endpoint URLs and provider error text never enter
 * thrown messages because signed URLs can embed credentials.
 */

import {
  MAX_CAPTURED_FRAME_BYTES,
  type CaptureRequest,
  type CapturedFrame,
  type CaptureSourceKind,
} from "./capture-adapters.js";

export interface HttpApiCaptureAdapterOptions {
  /** Host-trusted mapping from the admitted capture request to one endpoint. */
  resolveEndpoint: (request: CaptureRequest) => string | URL | Promise<string | URL>;
  /** Exact origins permitted for capture, e.g. "https://api.example.com". */
  readonly allowedOrigins?: readonly string[];
  /** Overall deadline covering endpoint resolution, redirects and body read. */
  readonly timeoutMillis?: number;
  /** Maximum captured payload bytes; defaults to MAX_CAPTURED_FRAME_BYTES. */
  readonly maxBytes?: number;
  /** Maximum redirect hops; defaults to 3, capped at 5. */
  readonly maxRedirects?: number;
  /** Fetch implementation; defaults to the platform global. */
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MILLIS = 30_000;
const MAX_TIMEOUT_MILLIS = 300_000;
const DEFAULT_MAX_REDIRECTS = 3;
const MAX_MAX_REDIRECTS = 5;
const MAX_ENDPOINT_URL_CHARS = 8_192;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Adapter-internal failure; messages never carry endpoint URLs or payloads. */
class HttpCaptureError extends Error {
  public constructor(message: string) {
    super(`http capture failed: ${message}`);
    this.name = "HttpCaptureError";
  }
}

function captureFailure(message: string): HttpCaptureError {
  return new HttpCaptureError(message);
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host.endsWith(".localhost")
    || host === "::1" || host === "[::1]"
    || host.startsWith("127.");
}

function parseAllowedOrigin(entry: string): string {
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    throw new TypeError("allowedOrigins entries must be valid origin URLs");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("allowedOrigins entries must use http or https");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("allowedOrigins entries must be bare origins");
  }
  return url.origin;
}

export class HttpApiCaptureAdapter {
  public readonly kind: CaptureSourceKind = "HTTP_API";

  private readonly resolveEndpoint: HttpApiCaptureAdapterOptions["resolveEndpoint"];
  private readonly allowedOrigins: ReadonlySet<string> | null;
  private readonly timeoutMillis: number;
  private readonly maxBytes: number;
  private readonly maxRedirects: number;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: HttpApiCaptureAdapterOptions) {
    if (!options || typeof options.resolveEndpoint !== "function") {
      throw new TypeError("resolveEndpoint is required");
    }
    this.resolveEndpoint = options.resolveEndpoint;
    this.allowedOrigins = options.allowedOrigins === undefined
      ? null
      : new Set(options.allowedOrigins.map(parseAllowedOrigin));
    const timeout = options.timeoutMillis ?? DEFAULT_TIMEOUT_MILLIS;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MILLIS) {
      throw new TypeError(`timeoutMillis must be 1..${MAX_TIMEOUT_MILLIS}`);
    }
    this.timeoutMillis = timeout;
    const maxBytes = options.maxBytes ?? MAX_CAPTURED_FRAME_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_CAPTURED_FRAME_BYTES) {
      throw new TypeError(`maxBytes must be 1..${MAX_CAPTURED_FRAME_BYTES}`);
    }
    this.maxBytes = maxBytes;
    const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > MAX_MAX_REDIRECTS) {
      throw new TypeError(`maxRedirects must be 0..${MAX_MAX_REDIRECTS}`);
    }
    this.maxRedirects = maxRedirects;
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new TypeError("a fetch implementation is required");
    }
    this.fetchImpl = fetchImpl;
  }

  private validateEndpoint(raw: string | URL): URL {
    let url: URL;
    try {
      url = raw instanceof URL ? new URL(raw.href) : new URL(String(raw));
    } catch {
      throw captureFailure("endpoint is not a valid URL");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw captureFailure("endpoint scheme is not permitted");
    }
    if (url.username || url.password) {
      throw captureFailure("endpoint must not carry userinfo credentials");
    }
    if (url.href.length > MAX_ENDPOINT_URL_CHARS) {
      throw captureFailure("endpoint URL exceeds the bounded length");
    }
    if (this.allowedOrigins !== null) {
      if (!this.allowedOrigins.has(url.origin)) {
        throw captureFailure("endpoint origin is not admitted");
      }
    } else if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
      throw captureFailure("plain HTTP is permitted only for loopback endpoints");
    }
    return url;
  }

  private async readBoundedBody(response: Response): Promise<Uint8Array> {
    const body = response.body;
    if (body === null) {
      return new Uint8Array(0);
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        total += value.byteLength;
        if (total > this.maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw captureFailure("response body exceeds the capture byte bound");
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof HttpCaptureError) throw error;
      throw captureFailure("response body could not be read");
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  public async capture(request: CaptureRequest): Promise<CapturedFrame> {
    if (request === null || typeof request !== "object" || request.kind !== this.kind) {
      throw new TypeError("capture request kind does not match this adapter");
    }
    const resolved = await this.resolveEndpoint(request);
    let current = this.validateEndpoint(resolved);
    const signal = AbortSignal.timeout(this.timeoutMillis);

    for (let hop = 0; ; hop += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(current, {
          method: "GET",
          redirect: "manual",
          cache: "no-store",
          signal,
        });
      } catch {
        throw captureFailure("endpoint request did not complete");
      }
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (location === null || location.length > MAX_ENDPOINT_URL_CHARS || hop >= this.maxRedirects) {
          throw captureFailure("endpoint redirect could not be followed within policy");
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw captureFailure("endpoint redirect target is not a valid URL");
        }
        current = this.validateEndpoint(next);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw captureFailure("endpoint did not return a successful response");
      }
      const bytes = await this.readBoundedBody(response);
      return {
        sourceIdentity: request.sourceIdentity,
        purposeRef: request.purposeRef,
        exactRightsScope: request.exactRightsScope,
        sourceVersionRef: request.sourceVersionRef,
        frameClockRef: request.frameClockRef,
        bytes,
        capturedAtEpochMillis: Date.now(),
      };
    }
  }
}
