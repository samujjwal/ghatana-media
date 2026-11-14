import { describe, expect, it, vi } from "vitest";
import { DevContentError, readVerifiedContent, sha256Hex } from "@audio-video/ui/screens";
import { createDevArtifactContentClient } from "../src/dev-artifact-content-client.js";

const VERSION = `sha256:${"a".repeat(64)}`;
const TOKEN = "dev-only-fixture-token";
const bytesOf = (n: number): Uint8Array => new Uint8Array(n).map((_, i) => i % 251);
function client(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetcher = vi.fn(async (url: string, init: RequestInit) => respond(url, init));
  return { fetcher, read: createDevArtifactContentClient({ origin: "http://127.0.0.1:1", bearerToken: () => TOKEN, fetch: fetcher as never }) };
}
const reqOf = { artifactId: "art-1", artifactVersionId: VERSION, maxBytes: 1024 };

describe("createDevArtifactContentClient", () => {
  it("sends the exact version in If-Match and the token only in Authorization, never in the URL", async () => {
    const { fetcher, read } = client(() => new Response(bytesOf(10), { status: 200, headers: { "Content-Type": "image/gif" } }));
    const result = await read(reqOf);
    expect(result.status).toBe(200);
    expect(result.contentType).toBe("image/gif");
    expect(result.bytes).toEqual(bytesOf(10));
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:1/dev/v1/artifacts/art-1/content");
    expect(url).not.toContain(TOKEN);
    expect(url).not.toContain("?");
    expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error", cache: "no-store" });
    const headers = init.headers as Record<string, string>;
    expect(headers["If-Match"]).toBe(VERSION);
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers.Range).toBeUndefined();
  });
  it("feeds readVerifiedContent so a tampered body fails the digest check", async () => {
    const data = bytesOf(32);
    const sha = await sha256Hex(data);
    const registered = { artifactId: "art-1", artifactVersionId: `sha256:${sha}`, contentType: "audio/wav", sizeBytes: 32, sha256: sha };
    const good = client(() => new Response(data, { status: 200, headers: { "Content-Type": "audio/wav" } }));
    await expect(readVerifiedContent({ readArtifactContent: good.read }, registered)).resolves.toMatchObject({ sha256: sha });
    const tampered = bytesOf(32); tampered[0] = 255;
    const bad = client(() => new Response(tampered, { status: 200, headers: { "Content-Type": "audio/wav" } }));
    await expect(readVerifiedContent({ readArtifactContent: bad.read }, registered)).rejects.toMatchObject({ code: "CONTENT_DIGEST_MISMATCH" });
  });
  it.each([[404, "ARTIFACT_NOT_FOUND"], [412, "ARTIFACT_VERSION_MISMATCH"], [403, "ARTIFACT_PERMISSION_REQUIRED"], [416, "RANGE_NOT_SATISFIABLE"], [400, "ARTIFACT_VERSION_REQUIRED"]] as const)(
    "types a %i refusal from the host error envelope", async (status, code) => {
      const { read } = client(() => new Response(JSON.stringify({ error: { code, message: "m", details: {} } }), { status, headers: { "Content-Type": "application/json" } }));
      await expect(read(reqOf)).rejects.toMatchObject({ name: "DevContentError", status, code });
    });
  it("still fails closed on an unreadable error body and on transport failure", async () => {
    await expect(client(() => new Response("<html>", { status: 502 })).read(reqOf)).rejects.toMatchObject({ code: "HTTP_ERROR", status: 502 });
    await expect(client(() => { throw new TypeError("net"); }).read(reqOf)).rejects.toMatchObject({ code: "TRANSPORT_ERROR", status: 0 });
  });
  it("refuses a 206 partial response because only whole files are read", async () => {
    const { read } = client(() => new Response(bytesOf(4), { status: 206, headers: { "Content-Range": "bytes 0-3/10" } }));
    await expect(read(reqOf)).rejects.toMatchObject({ code: "INVALID_RESPONSE", status: 206 });
  });
  it("refuses an oversize Content-Length before reading and an oversize stream while reading", async () => {
    const declared = client(() => new Response(bytesOf(10), { status: 200, headers: { "Content-Length": "5000" } }));
    await expect(declared.read(reqOf)).rejects.toMatchObject({ code: "CONTENT_TOO_LARGE" });
    const stream = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < 5; i += 1) controller.enqueue(bytesOf(400)); controller.close(); } });
    const streamed = client(() => new Response(stream, { status: 200 }));
    await expect(streamed.read(reqOf)).rejects.toMatchObject({ code: "CONTENT_TOO_LARGE" });
  });
  it("rejects malformed ids, a malformed version and a missing or prefixed token without calling the host", async () => {
    const { fetcher, read } = client(() => new Response(bytesOf(1)));
    await expect(read({ ...reqOf, artifactId: "a/b" })).rejects.toBeInstanceOf(DevContentError);
    await expect(read({ ...reqOf, artifactVersionId: "sha256:short" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const noToken = createDevArtifactContentClient({ origin: "http://127.0.0.1:1", bearerToken: () => "", fetch: fetcher as never });
    await expect(noToken(reqOf)).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    const prefixed = createDevArtifactContentClient({ origin: "http://127.0.0.1:1", bearerToken: () => "Bearer x", fetch: fetcher as never });
    await expect(prefixed(reqOf)).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
