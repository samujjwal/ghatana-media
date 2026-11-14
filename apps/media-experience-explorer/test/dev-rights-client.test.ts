import { describe, expect, it, vi } from "vitest";
import { DevOutputsHostError } from "@audio-video/ui/screens";
import { isAllowedDevProjectProxyRequest } from "../artifact-proxy-guard.mjs";
import { createDevProjectOutputsClient } from "../src/dev-project-outputs-client.js";

const VERSION = `sha256:${"a".repeat(64)}`;
const TOKEN = "dev-only-fixture-token";
function client(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetcher = vi.fn(async (url: string, init: RequestInit) => respond(url, init));
  return { fetcher, port: createDevProjectOutputsClient({ origin: "http://127.0.0.1:1", bearerToken: () => TOKEN, principalId: "test-principal-uploader", fetch: fetcher as never }) };
}
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("DEV_ONLY rights client", () => {
  it("calls only allow-listed routes, keeps the version colon literal, and never sends a principal or the token in the URL", async () => {
    const { fetcher, port } = client(() => json(200, { ok: true }));
    await port.createRightsAttestation!({ artifactId: "art-1", artifactVersionId: VERSION, statementKind: "MEDIA_RIGHTS", scopes: ["EXTERNAL_DELIVERY"], basis: "TEST basis" });
    await port.getRightsAttestation!("att-1");
    await port.confirmRightsAttestation!("att-1", { note: "TEST note" });
    await port.revokeRightsAttestation!("att-1", { reason: "TEST reason" });
    await port.listRightsAttestations!("art-1", VERSION);
    const calls = fetcher.mock.calls.map(([url, init]) => ({ url: String(url).replace("http://127.0.0.1:1", ""), init }));
    expect(calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([
      "POST /dev/v1/rights/attestations",
      "GET /dev/v1/rights/attestations/att-1",
      "POST /dev/v1/rights/attestations/att-1/confirm",
      "POST /dev/v1/rights/attestations/att-1/revoke",
      `GET /dev/v1/rights/artifacts/art-1/versions/${VERSION}/attestations`,
    ]);
    for (const call of calls) {
      expect(isAllowedDevProjectProxyRequest(call.init.method as string, call.url), call.url).toBe(true);
      expect(call.url).not.toContain(TOKEN);
      expect(call.url).not.toContain("%");
      expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    }
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ artifactId: "art-1", artifactVersionId: VERSION, statementKind: "MEDIA_RIGHTS", scopes: ["EXTERNAL_DELIVERY"], basis: "TEST basis" });
    expect(calls[0]!.init).toMatchObject({ credentials: "omit", redirect: "error", cache: "no-store" });
  });

  it("maps a refused self-confirmation to a typed host error and an unreadable mutation to OUTCOME_UNKNOWN", async () => {
    const refused = client(() => json(403, { error: { code: "SELF_CONFIRMATION_REFUSED", message: "no" } }));
    await expect(refused.port.confirmRightsAttestation!("att-1", {})).rejects.toMatchObject({ code: "SELF_CONFIRMATION_REFUSED", status: 403 });
    const broken = client(() => new Response("not json", { status: 200 }));
    const error = await broken.port.createRightsAttestation!({ artifactId: "a", artifactVersionId: VERSION, statementKind: "MEDIA_RIGHTS", scopes: ["PROCESSING"], basis: "x" }).catch((e) => e);
    expect(error).toBeInstanceOf(DevOutputsHostError);
    expect(error.code).toBe("OUTCOME_UNKNOWN");
  });
});
