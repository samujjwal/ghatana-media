import { describe, expect, it, vi } from "vitest";
import {
  OidcLoginError,
  beginLogin,
  completeLogin,
  createPkcePair,
  discover,
  isCallback,
  readOidcConfig,
  requireSecureEndpoint,
  type OidcLoginConfig,
  type OidcLoginDeps,
} from "../src/oidc-login.js";

const ISSUER = "http://127.0.0.1:8180/realms/ghatana-media";
const config: OidcLoginConfig = {
  issuer: ISSUER,
  clientId: "ghatana-media-explorer",
  redirectUri: "http://127.0.0.1:4178/dev-project-timeline.html",
  scope: "openid",
};
const discoveryDocument = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
  token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
};

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  };
}

function deps(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, overrides: Partial<OidcLoginDeps> = {}) {
  let counter = 0;
  const storage = memoryStorage();
  const value: OidcLoginDeps = {
    fetch: vi.fn(fetchImpl) as unknown as typeof fetch,
    storage,
    // Deterministic, distinct bytes per call; never a secret.
    randomBytes: (length) => new Uint8Array(length).fill(++counter),
    sha256: async (input) => new TextEncoder().encode(`sha256(${input})`),
    now: () => 1_000_000,
    ...overrides,
  };
  return { value, storage };
}

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

describe("OIDC login configuration", () => {
  it("is absent unless both an issuer and a client id are configured", () => {
    const location = { origin: "http://127.0.0.1:4178", pathname: "/dev-project-timeline.html" };
    expect(readOidcConfig({}, location)).toBeNull();
    expect(readOidcConfig({ VITE_MEDIA_OIDC_ISSUER: ISSUER }, location)).toBeNull();
    expect(readOidcConfig({ VITE_MEDIA_OIDC_CLIENT_ID: "c" }, location)).toBeNull();
    expect(readOidcConfig({ VITE_MEDIA_OIDC_ISSUER: ISSUER, VITE_MEDIA_OIDC_CLIENT_ID: "c" }, location)).toEqual({
      issuer: ISSUER, clientId: "c", redirectUri: "http://127.0.0.1:4178/dev-project-timeline.html", scope: "openid",
    });
  });

  it("refuses non-loopback http and credentials in the issuer URL", () => {
    expect(() => requireSecureEndpoint("http://idp.example.test/realms/x", "issuer")).toThrow(OidcLoginError);
    expect(() => requireSecureEndpoint("https://user:pw@idp.example.test/realms/x", "issuer")).toThrow(OidcLoginError);
    expect(requireSecureEndpoint("https://idp.example.test/realms/x", "issuer").protocol).toBe("https:");
    expect(requireSecureEndpoint("http://localhost:8180/realms/x", "issuer").hostname).toBe("localhost");
  });
});

describe("PKCE", () => {
  it("derives an S256 challenge from a 43 character URL-safe verifier", async () => {
    const { value } = deps(async () => json({}));
    const pair = await createPkcePair(value);
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(pair.challenge).not.toBe(pair.verifier);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]+$/u);
  });
});

describe("discovery", () => {
  it("rejects a discovery document for another issuer or with an insecure endpoint", async () => {
    await expect(discover(config, deps(async () => json({ ...discoveryDocument, issuer: "https://evil.example.test" })).value))
      .rejects.toMatchObject({ code: "OIDC_ISSUER_MISMATCH" });
    await expect(discover(config, deps(async () => json({ ...discoveryDocument, token_endpoint: "http://evil.example.test/token" })).value))
      .rejects.toMatchObject({ code: "OIDC_ENDPOINT_INSECURE" });
    await expect(discover(config, deps(async () => json({}, 500)).value)).rejects.toMatchObject({ code: "OIDC_DISCOVERY_FAILED" });
  });
});

describe("authorization code flow", () => {
  it("builds a PKCE S256 authorization URL, remembers verifier and state, and exchanges the code with the verifier", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const { value, storage } = deps(async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/.well-known/openid-configuration")) return json(discoveryDocument);
      return json({ access_token: "opaque-test-access-token", token_type: "Bearer", expires_in: 300 });
    });

    const authorizationUrl = new URL(await beginLogin(config, value));
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(discoveryDocument.authorization_endpoint);
    const query = authorizationUrl.searchParams;
    expect(query.get("response_type")).toBe("code");
    expect(query.get("client_id")).toBe(config.clientId);
    expect(query.get("redirect_uri")).toBe(config.redirectUri);
    expect(query.get("code_challenge_method")).toBe("S256");
    expect(query.get("code_challenge")).toBeTruthy();
    expect(query.get("scope")).toBe("openid");
    const state = query.get("state")!;
    expect(state.length).toBeGreaterThanOrEqual(24);
    const pending = JSON.parse(storage.map.values().next().value as string);
    expect(pending.state).toBe(state);
    expect(authorizationUrl.search).not.toContain(pending.verifier);

    const session = await completeLogin(config, `?code=abc&state=${state}`, value);
    expect(session.accessToken).toBe("opaque-test-access-token");
    expect(session.expiresAtMs).toBe(1_000_000 + 300_000);
    expect(storage.map.size).toBe(0);
    const exchange = calls.find((call) => call.url === discoveryDocument.token_endpoint)!;
    expect(exchange.init?.method).toBe("POST");
    expect(exchange.init?.credentials).toBe("omit");
    const form = new URLSearchParams(exchange.init?.body as string);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("abc");
    expect(form.get("code_verifier")).toBe(pending.verifier);
    expect(form.get("client_id")).toBe(config.clientId);
    expect(form.has("client_secret")).toBe(false);
  });

  it("refuses a mismatched state, a missing pending login and an expired one, and clears the pending record", async () => {
    const happy = async (url: string) => url.endsWith("/.well-known/openid-configuration")
      ? json(discoveryDocument) : json({ access_token: "t", token_type: "Bearer", expires_in: 60 });
    const a = deps(happy);
    await beginLogin(config, a.value);
    await expect(completeLogin(config, "?code=abc&state=attacker-state", a.value)).rejects.toMatchObject({ code: "OIDC_STATE_MISMATCH" });
    expect(a.storage.map.size).toBe(0);

    await expect(completeLogin(config, "?code=abc&state=x", deps(happy).value)).rejects.toMatchObject({ code: "OIDC_NO_PENDING_LOGIN" });

    let now = 1_000_000;
    const b = deps(happy, { now: () => now });
    const stateOf = new URL(await beginLogin(config, b.value)).searchParams.get("state");
    now += 11 * 60 * 1000;
    await expect(completeLogin(config, `?code=abc&state=${stateOf}`, b.value)).rejects.toMatchObject({ code: "OIDC_LOGIN_EXPIRED" });
  });

  it("surfaces a provider refusal and a failed or unusable token exchange without leaking provider text", async () => {
    const refuse = deps(async () => json(discoveryDocument));
    const state = new URL(await beginLogin(config, refuse.value)).searchParams.get("state");
    await expect(completeLogin(config, `?error=access_denied&state=${state}`, refuse.value)).rejects.toMatchObject({ code: "OIDC_LOGIN_REFUSED" });

    for (const [status, body, code] of [[400, { error: "invalid_grant", error_description: "secret detail" }, "OIDC_TOKEN_EXCHANGE_FAILED"], [200, { token_type: "Bearer" }, "OIDC_TOKEN_INVALID"], [200, { access_token: "t", token_type: "mac" }, "OIDC_TOKEN_INVALID"]] as const) {
      const harness = deps(async (url) => url.endsWith("/.well-known/openid-configuration") ? json(discoveryDocument) : json(body, status));
      const s = new URL(await beginLogin(config, harness.value)).searchParams.get("state");
      const failure = await completeLogin(config, `?code=c&state=${s}`, harness.value).catch((error) => error);
      expect(failure).toBeInstanceOf(OidcLoginError);
      expect(failure.code).toBe(code);
      expect(failure.message).not.toContain("secret detail");
    }
  });

  it("recognises an authorization response only when it carries state and a code or error", () => {
    expect(isCallback("?code=a&state=b")).toBe(true);
    expect(isCallback("?error=access_denied&state=b")).toBe(true);
    expect(isCallback("?code=a")).toBe(false);
    expect(isCallback("")).toBe(false);
  });
});
