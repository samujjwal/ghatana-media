import { DevProviderCatalogHostError } from "@audio-video/ui/screens";
import type { DevProviderCatalogPort, DevProviderCatalogHostResponse } from "@audio-video/ui/screens";

/**
 * Loopback fetch adapter for the DEV_ONLY provider catalog. The token is read from page memory per call and never
 * stored. A 200 resolves with the exact status and body; every other outcome rejects with a typed
 * {@link DevProviderCatalogHostError}. The read is safe to repeat, so a missing response is TRANSPORT_ERROR.
 */
export function createDevProviderCatalogClient(options: {
  readonly origin: string;
  readonly bearerToken: () => string;
  readonly fetch?: typeof fetch;
}): DevProviderCatalogPort {
  const fetcher = options.fetch ?? fetch;
  return {
    async get(): Promise<DevProviderCatalogHostResponse> {
      const token = options.bearerToken();
      if (!token || token.startsWith("Bearer ")) throw new DevProviderCatalogHostError("INVALID_CONFIGURATION", 0, "A raw DEV_ONLY bearer token is required.");
      let response: Response;
      try {
        response = await fetcher.call(globalThis, `${options.origin}/dev/v1/providers/catalog`, {
          method: "GET", credentials: "omit", redirect: "error", cache: "no-store",
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        });
      } catch {
        throw new DevProviderCatalogHostError("TRANSPORT_ERROR", 0, "The local Media host did not return a response.");
      }
      let parsed: unknown;
      try { parsed = await response.json(); } catch {
        throw new DevProviderCatalogHostError("INVALID_RESPONSE", response.status, "The host returned an unreadable response.");
      }
      if (response.ok) return { status: response.status, body: parsed };
      const error = (parsed as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      const code = typeof error?.code === "string" && error.code ? error.code : "HTTP_ERROR";
      const message = typeof error?.message === "string" && error.message ? error.message : "The local Media request failed.";
      throw new DevProviderCatalogHostError(code, response.status, message);
    },
  };
}
