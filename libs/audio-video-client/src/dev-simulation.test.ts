import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MediaDevOnlySimulationClient } from "./dev-simulation.js";

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngSha = createHash("sha256").update(pngBytes).digest("hex");
const scenarioSha = "a".repeat(64);

function simulationResponse(overrides: Record<string, unknown> = {}) {
  return {
    schema: "media.dev.simulation.v1",
    scope: "DEV_ONLY",
    simulationId: "simulation-1",
    outcome: "COMPLETED",
    result: {
      schema: "media.dev.simulation-result.v1",
      scope: "DEV_ONLY",
      outcome: "COMPLETED",
      requestId: "request-1",
      scenarioSha256: scenarioSha,
      productionEligible: false,
    },
    resultArtifact: {
      artifactId: "simulation-1",
      artifactVersionId: `sha256:${"b".repeat(64)}`,
      contentType: "application/json",
      sizeBytes: 100,
      sha256: "b".repeat(64),
      artifactPath: "/api/v1/artifacts/simulation-1",
    },
    plotArtifact: {
      artifactId: "plot-1",
      artifactVersionId: `sha256:${pngSha}`,
      contentType: "image/png",
      sizeBytes: pngBytes.length,
      sha256: pngSha,
      artifactPath: "/api/v1/artifacts/plot-1",
    },
    lineage: {
      simulationSchema: "media.dev.simulation.v1",
      scope: "DEV_ONLY",
      kind: "SIMULATION_RESULT",
      requestId: "request-1",
      scenarioSha256: scenarioSha,
      outcome: "COMPLETED",
      inputs: [{ model: "spring" }],
      siblings: { plot: { artifactId: "plot-1", artifactVersionId: `sha256:${pngSha}`, sha256: pngSha } },
      evidenceClass: "SIMULATED_MODEL_OUTPUT_NOT_MEASUREMENT_EVIDENCE",
      productionEligible: false,
    },
    replayed: false,
    note: "DEV_ONLY simulated model output; never a measurement or production claim",
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

describe("MediaDevOnlySimulationClient", () => {
  it("reads the source-bound simulation and exact-version PNG plot bytes", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new MediaDevOnlySimulationClient(config(async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      if (String(input).endsWith("/simulations/simulation-1")) return json(simulationResponse());
      return new Response(pngBytes, { status: 200, headers: { "Content-Type": "image/png", "Content-Length": String(pngBytes.length) } });
    }));

    const simulation = await client.getSimulation("simulation-1");
    expect(simulation.lineage).toMatchObject({
      scenarioSha256: scenarioSha,
      evidenceClass: "SIMULATED_MODEL_OUTPUT_NOT_MEASUREMENT_EVIDENCE",
      productionEligible: false,
      siblings: { plot: { artifactId: "plot-1", artifactVersionId: `sha256:${pngSha}` } },
    });
    await expect(client.readPlotContent(simulation)).resolves.toEqual(pngBytes);
    expect(calls.map(({ url }) => url)).toEqual([
      "http://127.0.0.1:8080/dev/v1/simulations/simulation-1",
      "http://127.0.0.1:8080/dev/v1/artifacts/plot-1/content",
    ]);
    const headers = new Headers(calls[1]?.init.headers);
    expect(headers.get("If-Match")).toBe(`sha256:${pngSha}`);
    expect(headers.get("Accept")).toBe("image/png");
    expect(headers.get("Authorization")).toBe("Bearer dev-token");
    expect(headers.get("X-Principal-Id")).toBe("principal-1");
  });

  it("preserves a registered MP4 sibling only when its immutable lineage matches", async () => {
    const videoSha = "c".repeat(64);
    const body = simulationResponse({
      videoArtifact: {
        artifactId: "video-1",
        artifactVersionId: `sha256:${videoSha}`,
        contentType: "video/mp4",
        sizeBytes: 128,
        sha256: videoSha,
        artifactPath: "/api/v1/artifacts/video-1",
      },
      lineage: {
        ...simulationResponse().lineage,
        siblings: {
          plot: { artifactId: "plot-1", artifactVersionId: `sha256:${pngSha}`, sha256: pngSha },
          video: { artifactId: "video-1", artifactVersionId: `sha256:${videoSha}`, sha256: videoSha },
        },
      },
    });
    const client = new MediaDevOnlySimulationClient(config(async () => json(body)));
    await expect(client.getSimulation("simulation-1")).resolves.toMatchObject({
      videoArtifact: { artifactId: "video-1", artifactVersionId: `sha256:${videoSha}`, contentType: "video/mp4" },
    });

    const mismatched = {
      ...body,
      lineage: {
        ...body.lineage as Record<string, unknown>,
        siblings: {
          ...(body.lineage as Record<string, unknown>).siblings as Record<string, unknown>,
          video: { artifactId: "video-1", artifactVersionId: `sha256:${"d".repeat(64)}`, sha256: "d".repeat(64) },
        },
      },
    };
    await expect(new MediaDevOnlySimulationClient(config(async () => json(mismatched)))
      .getSimulation("simulation-1")).rejects.toThrow(/exact result sibling versions/u);
  });

  it("preserves the server's typed stale-version conflict", async () => {
    const client = new MediaDevOnlySimulationClient(config(async (input) => {
      if (String(input).endsWith("/simulations/simulation-1")) return json(simulationResponse());
      return json({
        code: "ARTIFACT_VERSION_MISMATCH",
        message: "The artifact's immutable version does not match the expected version",
        correlationId: "correlation-1",
        retryable: false,
        category: "CONFLICT",
      }, 412);
    }));
    const simulation = await client.getSimulation("simulation-1");
    await expect(client.readPlotContent(simulation)).rejects.toMatchObject({
      statusCode: 412,
      detail: { code: "ARTIFACT_VERSION_MISMATCH" },
    });
  });

  it("rejects a plot sibling whose persisted version differs from the returned PNG", async () => {
    const client = new MediaDevOnlySimulationClient(config(async () => json(simulationResponse({
      lineage: {
        ...simulationResponse().lineage,
        siblings: { plot: { artifactId: "plot-1", artifactVersionId: `sha256:${"c".repeat(64)}`, sha256: "c".repeat(64) } },
      },
    }))));
    await expect(client.getSimulation("simulation-1")).rejects.toThrow(/exact result sibling versions/u);
  });

  it("rejects PNG bytes whose digest differs from the immutable version", async () => {
    const wrongBytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const client = new MediaDevOnlySimulationClient(config(async (input) => {
      if (String(input).endsWith("/simulations/simulation-1")) return json(simulationResponse());
      return new Response(wrongBytes, { status: 200, headers: { "Content-Type": "image/png", "Content-Length": String(wrongBytes.length) } });
    }));
    const simulation = await client.getSimulation("simulation-1");
    await expect(client.readPlotContent(simulation)).rejects.toThrow(/digest does not match/u);
  });

  it("denies plots above the caller's size limit before requesting bytes", async () => {
    let contentReads = 0;
    const client = new MediaDevOnlySimulationClient(config(async (input) => {
      if (String(input).endsWith("/simulations/simulation-1")) return json(simulationResponse());
      contentReads++;
      return new Response(pngBytes, { status: 200, headers: { "Content-Type": "image/png" } });
    }));
    const simulation = await client.getSimulation("simulation-1");
    await expect(client.readPlotContent(simulation, pngBytes.length - 1)).rejects.toThrow(/over the .* client limit/u);
    expect(contentReads).toBe(0);
  });

  it("rejects projectless or production-eligible lineage and requires loopback principal scope", async () => {
    const badSource = new MediaDevOnlySimulationClient(config(async () => json(simulationResponse({
      lineage: { ...simulationResponse().lineage, productionEligible: true },
    }))));
    await expect(badSource.getSimulation("simulation-1")).rejects.toThrow(/identity, lineage, or evidence scope/u);
    expect(() => new MediaDevOnlySimulationClient(config(async () => new Response(), "https://media.example.test")))
      .toThrow(/loopback/u);
    expect(() => new MediaDevOnlySimulationClient({
      baseUrl: "http://localhost:8080", tenantId: "tenant-1", getAccessToken: () => "dev-token",
    })).toThrow(/X-Principal-Id/u);
  });
});
