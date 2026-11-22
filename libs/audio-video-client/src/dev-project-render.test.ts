import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MediaDevOnlyProjectRenderClient } from "./dev-project-render.js";

const bytes = new Uint8Array([0x47, 0x49, 0x46, 0x38]);
const digest = createHash("sha256").update(bytes).digest("hex");
const sourceDigest = "a".repeat(64);
const renderResponse = {
  renderId: "render-1",
  artifact: {
    artifactId: "render-1", artifactVersionId: `sha256:${digest}`, contentType: "image/gif",
    sizeBytes: bytes.length, sha256: digest, artifactPath: "/api/v1/artifacts/render-1",
  },
  lineage: {
    scope: "DEV_ONLY", projectId: "project-1", revisionId: "revision-7", timelineId: "timeline-main",
    timelineSemanticVersionId: "timeline-semantic-4", requestId: "request-1", engine: "AnimationRenderer/3",
    format: "gif", width: 32, height: 24, framesPerSecond: 10, frameCount: 20,
    sources: [{ clipId: "clip-1", trackId: "track-1", artifactId: "source-1",
      artifactVersionId: `sha256:${sourceDigest}`, startFrame: 0, endFrameExclusive: 20 }],
  },
  replayed: false,
  scope: "DEV_ONLY",
};

function config(fetchImpl: typeof fetch, baseUrl = "http://127.0.0.1:8080") {
  return {
    baseUrl,
    tenantId: "tenant-1",
    defaultHeaders: { "X-Principal-Id": "principal-1" },
    getAccessToken: () => "dev-token",
    fetchImpl,
  };
}

describe("MediaDevOnlyProjectRenderClient", () => {
  it("keeps exact project and source versions and reads the registered bytes by If-Match", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new MediaDevOnlyProjectRenderClient(config(async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      if (String(input).endsWith("/renders")) {
        return new Response(JSON.stringify(renderResponse), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      return new Response(bytes, { status: 200, headers: { "Content-Type": "image/gif", "Content-Length": String(bytes.length) } });
    }));

    const render = await client.renderProject("project-1", {
      requestId: "request-1", revisionId: "revision-7", timelineId: "timeline-main",
      width: 32, height: 24, framesPerSecond: 10, format: "gif",
    });
    expect(render).toMatchObject({ scope: "DEV_ONLY", artifact: { artifactPath: "/api/v1/artifacts/render-1" } });
    expect(render.lineage).toMatchObject({ projectId: "project-1", revisionId: "revision-7", sourceCount: 1 });
    expect(render.lineage.sources).toEqual([{
      clipId: "clip-1", trackId: "track-1", artifactId: "source-1",
      artifactVersionId: `sha256:${sourceDigest}`, startFrame: 0, endFrameExclusive: 20,
    }]);

    const retrieved = await client.readRenderContent(render);
    expect(retrieved).toEqual(bytes);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8080/dev/v1/projects/project-1/renders");
    expect(calls[1]?.url).toBe("http://127.0.0.1:8080/dev/v1/artifacts/render-1/content");
    const readHeaders = new Headers(calls[1]?.init.headers);
    expect(readHeaders.get("If-Match")).toBe(`sha256:${digest}`);
    expect(readHeaders.get("Authorization")).toBe("Bearer dev-token");
    expect(readHeaders.get("X-Principal-Id")).toBe("principal-1");
  });

  it("reopens the exact render id and rejects responses without source-version lineage", async () => {
    let body: unknown = renderResponse;
    const client = new MediaDevOnlyProjectRenderClient(config(async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })));
    const reopened = await client.getRender("project-1", "render-1");
    expect(reopened.scope).toBe("DEV_ONLY");
    expect(reopened.lineage.revisionId).toBe("revision-7");
    expect(reopened.lineage.sources[0]?.artifactVersionId).toBe(`sha256:${sourceDigest}`);

    body = { ...renderResponse, lineage: { ...renderResponse.lineage, sources: [{ clipId: "clip-1", trackId: "track-1", artifactId: "source-1" }] } };
    await expect(client.getRender("project-1", "render-1")).rejects.toThrow(/render source artifact version/u);

    body = { ...renderResponse, artifact: { ...renderResponse.artifact, artifactPath: "/api/v1/artifacts/other" } };
    await expect(client.getRender("project-1", "render-1")).rejects.toThrow(/render artifact identity is invalid/u);
  });

  it("verifies content digest and stops before fetching when the registered output exceeds the read limit", async () => {
    let calls = 0;
    const client = new MediaDevOnlyProjectRenderClient(config(async () => {
      calls++;
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200, headers: { "Content-Type": "image/gif", "Content-Length": "4" },
      });
    }));
    const mismatched = { ...renderResponse, artifact: { ...renderResponse.artifact, sha256: "f".repeat(64), artifactVersionId: `sha256:${"f".repeat(64)}` } };
    const parsed = await new MediaDevOnlyProjectRenderClient(config(async () =>
      new Response(JSON.stringify(mismatched), { status: 200, headers: { "Content-Type": "application/json" } })))
      .getRender("project-1", "render-1");
    await expect(client.readRenderContent(parsed)).rejects.toThrow(/digest does not match/u);

    const oversized = { ...parsed, artifact: { ...parsed.artifact, sizeBytes: 5 } };
    await expect(client.readRenderContent(oversized, 4)).rejects.toThrow(/client limit/u);
    expect(calls).toBe(1);
  });

  it("only accepts loopback endpoints and an authenticated principal", () => {
    expect(() => new MediaDevOnlyProjectRenderClient(config(async () => new Response(), "https://media.example.test")))
      .toThrow(/loopback/u);
    expect(() => new MediaDevOnlyProjectRenderClient({
      baseUrl: "http://localhost:8080", tenantId: "tenant-1", getAccessToken: () => "dev-token",
    })).toThrow(/X-Principal-Id/u);
  });
});
