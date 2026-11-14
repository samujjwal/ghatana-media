/**
 * Provider-neutral OIDC sign-in for the Explorer: authorization code flow with PKCE (S256), no client secret.
 *
 * The access token is returned to the caller to be held in page memory only. Only the short-lived PKCE verifier,
 * state and redirect URI survive the redirect, in sessionStorage (cleared as soon as the callback is handled).
 * Nothing here is provider specific: endpoints come from the issuer's discovery document, which must name the
 * configured issuer. The login option is hidden unless an issuer and client id are configured.
 */

export interface OidcLoginConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string;
}

export interface OidcDiscovery {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
}

export interface OidcLoginDeps {
  readonly fetch: typeof fetch;
  readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  readonly randomBytes: (length: number) => Uint8Array;
  readonly sha256: (value: string) => Promise<Uint8Array>;
  readonly now: () => number;
}

export interface OidcSession {
  readonly accessToken: string;
  /** Epoch milliseconds, from the provider's expires_in; the host re-verifies the token on every request. */
  readonly expiresAtMs: number;
}

export class OidcLoginError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "OidcLoginError";
  }
}

const STORAGE_KEY = "media.oidc.pkce.pending";
const MAX_PENDING_AGE_MS = 10 * 60 * 1000;

/** Returns null when OIDC login is not configured (the option then stays hidden and DEV tokens remain). */
export function readOidcConfig(
  env: { readonly VITE_MEDIA_OIDC_ISSUER?: string; readonly VITE_MEDIA_OIDC_CLIENT_ID?: string; readonly VITE_MEDIA_OIDC_SCOPE?: string },
  location: { readonly origin: string; readonly pathname: string },
): OidcLoginConfig | null {
  const issuer = env.VITE_MEDIA_OIDC_ISSUER?.trim();
  const clientId = env.VITE_MEDIA_OIDC_CLIENT_ID?.trim();
  if (!issuer || !clientId) return null;
  requireSecureEndpoint(issuer, "issuer");
  return { issuer, clientId, redirectUri: `${location.origin}${location.pathname}`, scope: env.VITE_MEDIA_OIDC_SCOPE?.trim() || "openid" };
}

/** https is required except for loopback hosts, which exist only for local development. */
export function requireSecureEndpoint(value: string, label: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new OidcLoginError("OIDC_ENDPOINT_INVALID", `The ${label} is not an absolute URL.`); }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname.endsWith(".localhost");
  if (url.username || url.password || !(url.protocol === "https:" || (url.protocol === "http:" && loopback))) {
    throw new OidcLoginError("OIDC_ENDPOINT_INSECURE", `The ${label} must use https (http is allowed only on loopback).`);
  }
  return url;
}

export async function discover(config: OidcLoginConfig, deps: Pick<OidcLoginDeps, "fetch">): Promise<OidcDiscovery> {
  const base = config.issuer.endsWith("/") ? config.issuer.slice(0, -1) : config.issuer;
  const response = await deps.fetch(`${base}/.well-known/openid-configuration`, { headers: { Accept: "application/json" }, credentials: "omit" });
  if (!response.ok) throw new OidcLoginError("OIDC_DISCOVERY_FAILED", "The identity provider's discovery document is unavailable.");
  const document = await response.json() as Record<string, unknown>;
  if (document.issuer !== config.issuer) throw new OidcLoginError("OIDC_ISSUER_MISMATCH", "The discovery document names a different issuer.");
  const authorizationEndpoint = typeof document.authorization_endpoint === "string" ? document.authorization_endpoint : "";
  const tokenEndpoint = typeof document.token_endpoint === "string" ? document.token_endpoint : "";
  requireSecureEndpoint(authorizationEndpoint, "authorization endpoint");
  requireSecureEndpoint(tokenEndpoint, "token endpoint");
  return { authorizationEndpoint, tokenEndpoint };
}

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
};

/** RFC 7636: a 43+ character verifier from 32 random bytes and its S256 challenge. */
export async function createPkcePair(deps: Pick<OidcLoginDeps, "randomBytes" | "sha256">): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(deps.randomBytes(32));
  return { verifier, challenge: base64Url(await deps.sha256(verifier)) };
}

/** Builds the authorization URL and remembers the PKCE verifier and state for the callback. */
export async function beginLogin(config: OidcLoginConfig, deps: OidcLoginDeps): Promise<string> {
  const discovery = await discover(config, deps);
  const { verifier, challenge } = await createPkcePair(deps);
  const state = base64Url(deps.randomBytes(24));
  deps.storage.setItem(STORAGE_KEY, JSON.stringify({ state, verifier, redirectUri: config.redirectUri, createdAtMs: deps.now() }));
  const url = new URL(discovery.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** True when the current URL looks like an authorization response for this page. */
export function isCallback(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has("state") && (params.has("code") || params.has("error"));
}

interface PendingLogin { state?: string; verifier?: string; redirectUri?: string; createdAtMs?: number }

function parsePending(raw: string | null): PendingLogin | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as PendingLogin; } catch { return null; }
}

/** Validates state, exchanges the code with the stored verifier and returns the in-memory session. */
export async function completeLogin(config: OidcLoginConfig, search: string, deps: OidcLoginDeps): Promise<OidcSession> {
  const params = new URLSearchParams(search);
  const raw = deps.storage.getItem(STORAGE_KEY);
  deps.storage.removeItem(STORAGE_KEY);
  const pending = parsePending(raw);
  if (!pending || !pending.state || !pending.verifier || !pending.redirectUri || typeof pending.createdAtMs !== "number") {
    throw new OidcLoginError("OIDC_NO_PENDING_LOGIN", "No sign-in is in progress. Start again.");
  }
  if (deps.now() - pending.createdAtMs > MAX_PENDING_AGE_MS) throw new OidcLoginError("OIDC_LOGIN_EXPIRED", "The sign-in took too long. Start again.");
  if (params.get("state") !== pending.state) throw new OidcLoginError("OIDC_STATE_MISMATCH", "The sign-in response did not match this browser's request.");
  if (params.has("error")) throw new OidcLoginError("OIDC_LOGIN_REFUSED", "The identity provider refused the sign-in.");
  const code = params.get("code");
  if (!code) throw new OidcLoginError("OIDC_CODE_MISSING", "The sign-in response carried no authorization code.");
  if (pending.redirectUri !== config.redirectUri) throw new OidcLoginError("OIDC_REDIRECT_MISMATCH", "The sign-in began on a different page.");

  const discovery = await discover(config, deps);
  const response = await deps.fetch(discovery.tokenEndpoint, {
    method: "POST",
    credentials: "omit",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      code,
      redirect_uri: config.redirectUri,
      code_verifier: pending.verifier,
    }).toString(),
  });
  if (!response.ok) throw new OidcLoginError("OIDC_TOKEN_EXCHANGE_FAILED", "The identity provider did not issue a token.");
  const body = await response.json() as Record<string, unknown>;
  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  if (!accessToken || (typeof body.token_type === "string" && body.token_type.toLowerCase() !== "bearer")) {
    throw new OidcLoginError("OIDC_TOKEN_INVALID", "The identity provider returned an unusable token.");
  }
  const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 60;
  return { accessToken, expiresAtMs: deps.now() + expiresIn * 1000 };
}

/** Browser dependencies backed by Web Crypto and sessionStorage. */
export function browserDeps(): OidcLoginDeps {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    storage: window.sessionStorage,
    randomBytes: (length) => globalThis.crypto.getRandomValues(new Uint8Array(length)),
    sha256: async (value) => new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    now: () => Date.now(),
  };
}
