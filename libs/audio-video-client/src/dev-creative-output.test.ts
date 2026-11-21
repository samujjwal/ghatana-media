import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MediaDevOnlyCreativeOutputClient } from "./dev-creative-output.js";

const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x57, 0x41, 0x56, 0x45]);
const sha256 = createHash("sha256").update(bytes).digest("hex");

function outputResponse(overrides: Record<string, unknown> = {}) {
  return {
    schema: "media.dev.creative-output.v1",
    outputId: "output-1",
    artifact: {
      artifactId: "output-1",
      artifactVersionId: `sha256:${sha256}`,
      contentType: "audio/wav",
      sizeBytes: bytes.length,
      sha256,
      artifactPath: "/api/v1/artifacts/output-1",
    },
    lineage: { kind: "AUDIO_REPAIR_CANDIDATE", engine: "production.audio.BoundedPcmDeclipper/1",
      requestId: "repair-1", source: { artifactId: "source-1", artifactVersionId: `sha256:${"a".repeat(64)}`,
        sha256: "a".repeat(64), contentType: "audio/wav" } },
    replayed: false,
    scope: "DEV_ONLY",
    note: "DEV_ONLY engine output; not a production, quality, measurement or approval claim",
    ...overrides,
  };
}

function config(fetchImpl: typeof fetch, baseUrl = "http://127.0.0.1:8080") {
  return {
    baseUrl,
    tenantId: "tenant-1",
    defaultHeaders: { "X-Principal-Id": "principal-1" },
    getAccessToken: () => "dev-token",
    fetchImpl,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("MediaDevOnlyCreativeOutputClient", () => {
  it("reads an owner-scoped output and exact-version WAV bytes with digest verification", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new MediaDevOnlyCreativeOutputClient(config(async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      if (String(input).endsWith("/creative-outputs/output-1")) return json(outputResponse());
      return new Response(bytes, { status: 200, headers: { "Content-Type": "audio/wav", "Content-Length": String(bytes.length) } });
    }));

    const output = await client.getCreativeOutput("output-1");
    expect(output.lineage).toMatchObject({ kind: "AUDIO_REPAIR_CANDIDATE", source: { artifactId: "source-1" } });
    expect(output.lineage.source?.artifactVersionId).toBe(`sha256:${"a".repeat(64)}`);
    await expect(client.readContent(output)).resolves.toEqual(bytes);
    expect(calls.map(({ url }) => url)).toEqual([
      "http://127.0.0.1:8080/dev/v1/creative-outputs/output-1",
      "http://127.0.0.1:8080/dev/v1/artifacts/output-1/content",
    ]);
    const readHeaders = new Headers(calls[1]?.init.headers);
    expect(readHeaders.get("If-Match")).toBe(`sha256:${sha256}`);
    expect(readHeaders.get("Authorization")).toBe("Bearer dev-token");
    expect(readHeaders.get("X-Principal-Id")).toBe("principal-1");
  });

  it("exposes exact source versions for a registered spatial GLB", async () => {
    const sourceSha = "b".repeat(64);
    const body = outputResponse({
      artifact: { ...outputResponse().artifact, contentType: "model/gltf-binary" },
      lineage: {
        kind: "SPATIAL_GLB_EXPORT", engine: "production.spatial.SpatialRigEngine/glb-export", requestId: "request-1",
        sourceProjectRevisionRef: "project-revision-3",
        sources: [{ tenantId: "tenant-1", artifactId: "source-2", artifactVersionId: `sha256:${sourceSha}`,
          sha256: sourceSha, contentType: "image/png" }],
      },
    });
    const client = new MediaDevOnlyCreativeOutputClient(config(async () => json(body)));
    const output = await client.getCreativeOutput("output-1");
    expect(output.lineage.sources).toEqual([{
      tenantId: "tenant-1", artifactId: "source-2", artifactVersionId: `sha256:${sourceSha}`,
      sha256: sourceSha, contentType: "image/png",
    }]);
    expect(output.lineage.sourceProjectRevisionRef).toBe("project-revision-3");
  });

  it("rejects output lineage when a source version does not match its digest", async () => {
    const body = outputResponse({
      lineage: {
        ...outputResponse().lineage,
        source: { artifactId: "source-1", artifactVersionId: `sha256:${"c".repeat(64)}`, sha256: "a".repeat(64) },
      },
    });
    const client = new MediaDevOnlyCreativeOutputClient(config(async () => json(body)));
    await expect(client.getCreativeOutput("output-1")).rejects.toThrow(/exact artifact version and digest/u);
  });

  it("preserves the server's typed stale-version conflict", async () => {
    const client = new MediaDevOnlyCreativeOutputClient(config(async (input) => {
      if (String(input).endsWith("/creative-outputs/output-1")) return json(outputResponse());
      return json({
        code: "ARTIFACT_VERSION_MISMATCH",
        message: "The artifact's immutable version does not match the expected version",
        correlationId: "correlation-1",
        retryable: false,
        category: "CONFLICT",
      }, 412);
    }));
    const output = await client.getCreativeOutput("output-1");
    await expect(client.readContent(output)).rejects.toMatchObject({ statusCode: 412, detail: { code: "ARTIFACT_VERSION_MISMATCH" } });
  });

  it("rejects content whose SHA-256 differs from the registered version", async () => {
    const wrongBytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const client = new MediaDevOnlyCreativeOutputClient(config(async (input) => {
      if (String(input).endsWith("/creative-outputs/output-1")) return json(outputResponse());
      return new Response(wrongBytes, { status: 200, headers: { "Content-Type": "audio/wav", "Content-Length": String(wrongBytes.length) } });
    }));
    const output = await client.getCreativeOutput("output-1");
    await expect(client.readContent(output)).rejects.toThrow(/digest does not match/u);
  });

  it("denies reads above the caller's size limit before requesting content", async () => {
    let contentReads = 0;
    const client = new MediaDevOnlyCreativeOutputClient(config(async (input) => {
      if (String(input).endsWith("/creative-outputs/output-1")) return json(outputResponse());
      contentReads++;
      return new Response(bytes, { status: 200, headers: { "Content-Type": "audio/wav", "Content-Length": String(bytes.length) } });
    }));
    const output = await client.getCreativeOutput("output-1");
    await expect(client.readContent(output, bytes.length - 1)).rejects.toThrow(/over the .* client limit/u);
    expect(contentReads).toBe(0);
  });

  it("does not accept formats outside the creative-output route contract", async () => {
    const client = new MediaDevOnlyCreativeOutputClient(config(async () => json(outputResponse({
      artifact: { ...outputResponse().artifact, contentType: "image/gif" },
    }))));
    await expect(client.getCreativeOutput("output-1")).rejects.toThrow(/kind, content type/u);
  });

  it("is loopback-only and requires caller principal scope", () => {
    expect(() => new MediaDevOnlyCreativeOutputClient(config(async () => new Response(), "https://media.example.test")))
      .toThrow(/loopback/u);
    expect(() => new MediaDevOnlyCreativeOutputClient({
      baseUrl: "http://localhost:8080", tenantId: "tenant-1", getAccessToken: () => "dev-token",
    })).toThrow(/X-Principal-Id/u);
  });
});
