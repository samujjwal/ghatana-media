import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ScenarioError,
  changedSceneLineages,
  executeScenario,
  orchestrateScenario,
  recaptureScenario,
  scenesRequiringRecapture,
  publishFinalRender,
  type Scenario,
} from "./recorder-orchestrator";
import type { MediaOperationClient } from "./operations";
import {
  CaptureNotAdmittedError,
  CaptureOutcomeUnknownError,
  routedCaptureAdapter,
  type CaptureRequest,
  type CapturedFrame,
} from "./capture-adapters";
import { HttpApiCaptureAdapter } from "./http-capture-adapter";
import { MediaFileCaptureAdapter } from "./file-capture-adapter";

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  const source = (identity: string, sourceVersionRef: string) => ({
    kind: "BROWSER" as const,
    sourceIdentity: identity,
    purposeRef: "purpose/demo-recording",
    exactRightsScope: "rights/demo-recording/v1",
    sourceVersionRef,
    secretsRef: "secrets/demo-host",
    frameClockRef: "clock/demo-host",
  });
  return {
    scenarioId: "demo-1",
    revision: "rev-3",
    actors: [{ actorId: "actor-1", role: "presenter" }],
    scenes: [
      {
        sceneId: "intro",
        sourceRef: source("browser/demo/intro", "intro@v2"),
        actorRefs: ["actor-1"],
        narration: [{ atMillis: 500, trackRef: "narration/intro@v1" }],
        captionRefs: ["captions/intro@v1"],
        durationMillis: 5_000,
      },
      {
        sceneId: "main",
        sourceRef: source("browser/demo/main", "main@v4"),
        actorRefs: ["actor-1"],
        narration: [],
        captionRefs: [],
        durationMillis: 10_000,
      },
    ],
    ...overrides,
  };
}

describe("orchestrateScenario", () => {
  it("two identical runs produce identical scene lineage", () => {
    const a = orchestrateScenario(scenario());
    const b = orchestrateScenario(scenario());
    expect(a.sceneRuns.map((r) => r.lineageId))
      .toEqual(b.sceneRuns.map((r) => r.lineageId));
    expect(b).toEqual(a);
    expect(a.dryRunOnly).toBe(true);
    expect(a.planIdentity).toMatch(/^media\.scenario-plan\.v1:/u);
    expect(a.planIdentity).toBe(b.planIdentity);
    expect(a.sceneRuns[0]!.capturePlan).toEqual({
      kind: "BROWSER",
      sourceIdentity: "browser/demo/intro",
      purposeRef: "purpose/demo-recording",
      exactRightsScope: "rights/demo-recording/v1",
      sourceVersionRef: "intro@v2",
      secretsRef: "secrets/demo-host",
      frameClockRef: "clock/demo-host",
    });
    expect(a.sceneRuns[0]!.narration[0]!.atMillis).toBe(500);
  });

  it("a changed scene revision re-plans only that scene's lineage", () => {
    const prior = orchestrateScenario(scenario());
    const next = orchestrateScenario(scenario({
      scenes: [
        { ...scenario().scenes[0]!, sourceRef: { ...scenario().scenes[0]!.sourceRef, sourceVersionRef: "intro@v3" } },
        scenario().scenes[1]!,
      ],
    }));
    const diff = changedSceneLineages(prior, next);
    expect(diff).toEqual({ carried: ["main"], replanned: ["intro"], removed: [] });
    expect(next.sceneRuns[0]!.lineageId).not.toBe(prior.sceneRuns[0]!.lineageId);
    expect(next.sceneRuns[1]!.lineageId).toBe(prior.sceneRuns[1]!.lineageId);
  });

  it.each([
    ["source identity", { sourceRef: { ...scenario().scenes[0]!.sourceRef, sourceIdentity: "browser/demo/replacement" } }],
    ["rights scope", { sourceRef: { ...scenario().scenes[0]!.sourceRef, exactRightsScope: "rights/demo-recording/v2" } }],
    ["narration", { narration: [{ atMillis: 750, trackRef: "narration/intro@v2" }] }],
    ["caption refs", { captionRefs: ["captions/intro@v2"] }],
    ["duration", { durationMillis: 6_000 }],
  ])("replans a scene when its %s changes", (label, change) => {
    const base = scenario();
    const prior = orchestrateScenario(base);
    const next = orchestrateScenario({
      ...base,
      scenes: [{ ...base.scenes[0]!, ...change }, base.scenes[1]!],
    });

    if (label === "source identity") {
      expect(next.sceneRuns[0]!.lineageId).not.toBe(prior.sceneRuns[0]!.lineageId);
    } else {
      expect(next.sceneRuns[0]!.lineageId).toBe(prior.sceneRuns[0]!.lineageId);
    }
    expect(changedSceneLineages(prior, next)).toEqual({ carried: ["main"], replanned: ["intro"], removed: [] });
  });

  it("binds lineage to source kind and identity even when the version label is unchanged", () => {
    const base = scenario();
    const prior = orchestrateScenario(base);
    const changedSource = orchestrateScenario({
      ...base,
      scenes: [{
        ...base.scenes[0]!,
        sourceRef: { ...base.scenes[0]!.sourceRef, kind: "TERMINAL", sourceIdentity: "terminal/demo/intro" },
      }, base.scenes[1]!],
    });

    expect(changedSource.sceneRuns[0]!.sourceRevision).toBe(prior.sceneRuns[0]!.sourceRevision);
    expect(changedSource.sceneRuns[0]!.lineageId).not.toBe(prior.sceneRuns[0]!.lineageId);
    expect(changedSceneLineages(prior, changedSource))
      .toEqual({ carried: ["main"], replanned: ["intro"], removed: [] });
  });

  it("replans when the role bound to a scene actor changes", () => {
    const base = scenario();
    const prior = orchestrateScenario(base);
    const next = orchestrateScenario({
      ...base,
      actors: [{ actorId: "actor-1", role: "narrator" }],
    });
    expect(next.sceneRuns[0]!.actorBindings).toEqual([{ actorId: "actor-1", role: "narrator" }]);
    expect(changedSceneLineages(prior, next)).toEqual({ carried: [], replanned: ["intro", "main"], removed: [] });
  });

  it("changes whole-plan identity when narration changes while keeping per-scene lineage stable", () => {
    const base = scenario();
    const prior = orchestrateScenario(base);
    const next = orchestrateScenario({
      ...base,
      scenes: [{ ...base.scenes[0]!, narration: [{ atMillis: 750, trackRef: "narration/intro@v2" }] }, base.scenes[1]!],
    });
    expect(next.planIdentity).not.toBe(prior.planIdentity);
    expect(next.sceneRuns[0]!.lineageId).toBe(prior.sceneRuns[0]!.lineageId);
    expect(changedSceneLineages(prior, next)).toEqual({
      carried: ["main"], replanned: ["intro"], removed: [],
    });
  });

  it("reports removed scenes so stale scene outputs can be invalidated", () => {
    const prior = orchestrateScenario(scenario());
    const next = orchestrateScenario({ ...scenario(), scenes: [scenario().scenes[0]!] });
    expect(changedSceneLineages(prior, next)).toEqual({
      carried: ["intro"], replanned: [], removed: ["main"],
    });
  });

  it("bounds and validates prior and next plans before computing lineage diffs", () => {
    const plan = orchestrateScenario(scenario());
    const oversized = {
      ...plan,
      sceneRuns: Array.from({ length: 257 }, (_, index) => ({
        ...plan.sceneRuns[0]!, sceneId: `scene-${index}`,
      })),
    } as typeof plan;
    expect(() => changedSceneLineages(oversized, plan))
      .toThrowError(/prior plan exceeds 256 scenes/u);
    expect(() => changedSceneLineages(plan, oversized))
      .toThrowError(/next plan exceeds 256 scenes/u);

    const duplicateScene = {
      ...plan,
      sceneRuns: [plan.sceneRuns[0]!, { ...plan.sceneRuns[1]!, sceneId: "intro" }],
    };
    expect(() => changedSceneLineages(duplicateScene, plan))
      .toThrowError(/prior plan has duplicate sceneId/u);
  });

  it("rejects unresolved actor refs and out-of-bounds narration", () => {
    expect(() => orchestrateScenario(scenario({
      scenes: [{ ...scenario().scenes[0]!, actorRefs: ["ghost"] }],
    }))).toThrowError(ScenarioError);
    expect(() => orchestrateScenario(scenario({
      scenes: [{
        ...scenario().scenes[0]!,
        narration: [{ atMillis: 9_999, trackRef: "t" }],
      }],
    }))).toThrowError(ScenarioError);
  });

  it("requires source admission references before producing a plan", () => {
    const base = scenario();
    const scene = base.scenes[0]!;
    expect(() => orchestrateScenario({
      ...base,
      scenes: [{ ...scene, sourceRef: { ...scene.sourceRef, purposeRef: " " } }, base.scenes[1]!],
    })).toThrowError(/sourceRef\.purposeRef/u);
    expect(() => orchestrateScenario({
      ...base,
      scenes: [{ ...scene, sourceRef: { ...scene.sourceRef, exactRightsScope: " " } }, base.scenes[1]!],
    })).toThrowError(/sourceRef\.exactRightsScope/u);
    expect(() => orchestrateScenario({
      ...base,
      scenes: [{ ...scene, sourceRef: { ...scene.sourceRef, secretsRef: " " } }, base.scenes[1]!],
    })).toThrowError(/sourceRef\.secretsRef/u);
  });

  it("rejects unsupported capture source kinds during planning", () => {
    const base = scenario();
    const scene = base.scenes[0]!;
    expect(() => orchestrateScenario({
      ...base,
      scenes: [{
        ...scene,
        sourceRef: { ...scene.sourceRef, kind: "FIXTURE" },
      }, base.scenes[1]!],
    } as unknown as Scenario)).toThrowError(/supported capture source enum/u);
  });

  it("rejects duplicate scene, actor, and per-scene actor identities", () => {
    const base = scenario();
    expect(() => orchestrateScenario({
      ...base,
      scenes: [base.scenes[0]!, { ...base.scenes[1]!, sceneId: "intro" }],
    })).toThrowError(/duplicate sceneId/u);
    expect(() => orchestrateScenario({
      ...base,
      actors: [{ actorId: "actor-1", role: "presenter" }, { actorId: "actor-1", role: "editor" }],
    })).toThrowError(/duplicate actorId/u);
    expect(() => orchestrateScenario({
      ...base,
      scenes: [{ ...base.scenes[0]!, actorRefs: ["actor-1", "actor-1"] }, base.scenes[1]!],
    })).toThrowError(/duplicate actorRef/u);
  });

  it("rejects malformed actor, narration, and caption collections as scenario errors", () => {
    const base = scenario();
    expect(() => orchestrateScenario({
      ...base,
      actors: [null],
    } as unknown as Scenario)).toThrowError(ScenarioError);
    expect(() => orchestrateScenario({
      ...base,
      scenes: [{ ...base.scenes[0]!, actorRefs: "actor-1" }],
    } as unknown as Scenario)).toThrowError(/actorRefs must be an array/u);
    expect(() => orchestrateScenario({
      ...base,
      scenes: [{ ...base.scenes[0]!, narration: [null] }],
    } as unknown as Scenario)).toThrowError(/narration\[0\] must be an object/u);
    expect(() => orchestrateScenario({
      ...base,
      scenes: [{ ...base.scenes[0]!, captionRefs: ["captions/intro@v1", " "] }],
    })).toThrowError(/captionRefs\[1\]/u);
    expect(() => orchestrateScenario({
      ...base,
      scenes: [{ ...base.scenes[0]!, captionRefs: "captions/intro@v1" }],
    } as unknown as Scenario)).toThrowError(/captionRefs must be an array/u);
  });

  it("bounds scene collections and total serialized plan identity", () => {
    const base = scenario();
    expect(() => orchestrateScenario({
      ...base,
      scenes: [{ ...base.scenes[0]!, narration: Array.from({ length: 257 }, () => ({ atMillis: 1, trackRef: "track" })) }],
    })).toThrowError(/narration must contain at most 256/u);
    expect(() => orchestrateScenario({
      ...base,
      scenes: [{ ...base.scenes[0]!, captionRefs: Array.from({ length: 257 }, (_, i) => `caption/${i}`) }],
    })).toThrowError(/captionRefs must contain at most 256/u);
    let laterSceneRead = false;
    const unreadScene = Object.defineProperty({ ...base.scenes[0]! }, "sceneId", {
      get: () => {
        laterSceneRead = true;
        return "unread";
      },
    });
    const oversized = {
      ...base,
      scenes: [
        ...Array.from({ length: 11 }, (_, index) => ({
          ...base.scenes[0]!,
          sceneId: `large-${index}`,
          narration: Array.from({ length: 256 }, () => ({ atMillis: 1, trackRef: "z".repeat(384) })),
        })),
        unreadScene,
      ],
    };
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      expect(() => orchestrateScenario(oversized)).toThrowError(/serialized scenario plan exceeds/u);
      const serializedWholePlan = stringify.mock.calls.some(([value]) =>
        Array.isArray(value) && value.length === 3
        && Array.isArray(value[2]) && value[2].length > 0);
      expect(serializedWholePlan).toBe(false);
      expect(laterSceneRead).toBe(false);
    } finally {
      stringify.mockRestore();
    }
  });
});

describe("recaptureScenario", () => {
  // Deterministic test fixture only; it is not a real host/source capture receipt.
  const frame: CapturedFrame = {
    sourceIdentity: "browser/demo/intro",
    purposeRef: "purpose/demo-recording",
    exactRightsScope: "rights/demo-recording/v1",
    sourceVersionRef: "intro@v2",
    frameClockRef: "clock/demo-host",
    bytes: new Uint8Array([7]),
    capturedAtEpochMillis: 1,
  };

  it("captures admitted scenes only; unadmitted fails closed with no frames", async () => {
    const plan = orchestrateScenario(scenario());
    // This in-memory adapter is a fixture and does not enable a production provider.
    const adapter = { capture: async () => frame };
    // No adapter admitted → zero effects.
    await expect(recaptureScenario(
      plan, { check: () => "NOT_ADMITTED" }, adapter))
      .rejects.toBeInstanceOf(CaptureNotAdmittedError);
    // Selective recapture of a single scene when admitted.
    const single = await recaptureScenario(
      plan, { check: () => "ADMITTED" }, adapter,
      { sceneIds: ["intro"] });
    expect(single).toHaveLength(1);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5, 257])(
    "rejects invalid maxScenes bound %s before eligibility or capture", async (maxScenes) => {
      const plan = orchestrateScenario(scenario());
      let eligibilityCalls = 0;
      let captureCalls = 0;
      const eligibility = { check: () => { eligibilityCalls++; return "ADMITTED" as const; } };
      const adapter = { capture: async () => { captureCalls++; return frame; } };
      await expect(recaptureScenario(plan, eligibility, adapter, { maxScenes }))
        .rejects.toThrow(/maxScenes/u);
      expect(eligibilityCalls).toBe(0);
      expect(captureCalls).toBe(0);
    });

  it.each([
    ["unknown", ["missing-scene"]],
    ["duplicate", ["intro", "intro"]],
  ])("rejects %s scene selectors before any capture", async (_label, sceneIds) => {
    const plan = orchestrateScenario(scenario());
    let eligibilityCalls = 0;
    let captureCalls = 0;
    await expect(recaptureScenario(plan, {
      check: () => { eligibilityCalls++; return "ADMITTED"; },
    }, {
      capture: async () => { captureCalls++; return frame; },
    }, { sceneIds }))
      .rejects.toThrow(ScenarioError);
    expect(eligibilityCalls).toBe(0);
    expect(captureCalls).toBe(0);
  });

  it("preserves selective valid capture in plan order", async () => {
    const plan = orchestrateScenario(scenario());
    const sourceOrder: string[] = [];
    await recaptureScenario(plan, { check: () => "ADMITTED" }, {
      capture: async (request) => {
        sourceOrder.push(request.sourceIdentity);
        return {
          ...frame,
          sourceIdentity: request.sourceIdentity,
          purposeRef: request.purposeRef,
          exactRightsScope: request.exactRightsScope,
          sourceVersionRef: request.sourceVersionRef,
          frameClockRef: request.frameClockRef,
        };
      },
    }, { sceneIds: ["main", "intro"], maxScenes: 2 });
    expect(sourceOrder).toEqual(["browser/demo/intro", "browser/demo/main"]);
  });

  it("recaptures only the changed source scene and retains carried scene lineage", async () => {
    const prior = orchestrateScenario(scenario());
    const next = orchestrateScenario(scenario({
      scenes: [
        { ...scenario().scenes[0]!, sourceRef: { ...scenario().scenes[0]!.sourceRef, sourceVersionRef: "intro@v3" } },
        scenario().scenes[1]!,
      ],
    }));
    const changes = changedSceneLineages(prior, next);
    expect(changes).toEqual({ carried: ["main"], replanned: ["intro"], removed: [] });
    expect(next.sceneRuns.find((run) => run.sceneId === "main")!.lineageId)
      .toBe(prior.sceneRuns.find((run) => run.sceneId === "main")!.lineageId);
    expect(next.sceneRuns.find((run) => run.sceneId === "intro")!.lineageId)
      .not.toBe(prior.sceneRuns.find((run) => run.sceneId === "intro")!.lineageId);

    const admittedRequests: string[] = [];
    const capturedSources: string[] = [];
    const frames = await recaptureScenario(next, {
      check: (request) => {
        admittedRequests.push(request.sourceVersionRef);
        return "ADMITTED";
      },
    }, {
      capture: async (request) => {
        capturedSources.push(request.sourceVersionRef);
        return {
          ...frame,
          sourceIdentity: request.sourceIdentity,
          purposeRef: request.purposeRef,
          exactRightsScope: request.exactRightsScope,
          sourceVersionRef: request.sourceVersionRef,
          frameClockRef: request.frameClockRef,
        };
      },
    }, { sceneIds: changes.replanned, maxScenes: 1 });

    expect(admittedRequests).toEqual(["intro@v3"]);
    expect(capturedSources).toEqual(["intro@v3"]);
    expect(frames).toHaveLength(1);
  });

  it("rejects oversized plans/selectors and malformed plan runs before callbacks", async () => {
    const plan = orchestrateScenario(scenario());
    let eligibilityCalls = 0;
    let captureCalls = 0;
    const eligibility = { check: () => { eligibilityCalls++; return "ADMITTED" as const; } };
    const adapter = { capture: async () => { captureCalls++; return frame; } };
    const oversizedPlan = {
      ...plan,
      sceneRuns: Array.from({ length: 257 }, () => plan.sceneRuns[0]!),
    } as typeof plan;
    await expect(recaptureScenario(oversizedPlan, eligibility, adapter))
      .rejects.toThrow(/exceeds 256 scenes/u);

    const malformedRunPlan = {
      ...plan,
      sceneRuns: [null],
    } as unknown as typeof plan;
    await expect(recaptureScenario(malformedRunPlan, eligibility, adapter))
      .rejects.toThrow(/sceneRuns\[0\] must be an object/u);

    const blankIdentityPlan = {
      ...plan,
      sceneRuns: [{ ...plan.sceneRuns[0]!, sceneId: " " }],
    } as typeof plan;
    await expect(recaptureScenario(blankIdentityPlan, eligibility, adapter))
      .rejects.toThrow(/sceneRuns\[0\]\.sceneId/u);

    await expect(recaptureScenario(plan, eligibility, adapter, {
      sceneIds: Array.from({ length: 257 }, () => "missing"),
    })).rejects.toThrow(/exceeds 256 selectors/u);
    expect(eligibilityCalls).toBe(0);
    expect(captureCalls).toBe(0);
  });
});

describe("recaptureScenario with real routed capture adapters", () => {
  const dirs: string[] = [];
  const servers: Server[] = [];

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "media-recapture-"));
    dirs.push(dir);
    return dir;
  }

  async function withHttpServer(
    handler: (req: import("node:http").IncomingMessage,
      res: import("node:http").ServerResponse) => void,
    run: (origin: string) => Promise<void>,
  ): Promise<void> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  }

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) =>
      new Promise<void>((resolve) => server.close(() => resolve()))));
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  function captureRequest(kind: CaptureRequest["kind"], sourceIdentity: string): CaptureRequest {
    return {
      kind,
      sourceIdentity,
      purposeRef: "purpose/recapture-demo",
      exactRightsScope: "rights/recapture-demo/v1",
      sourceVersionRef: `${sourceIdentity}@v1`,
      secretsRef: "secrets/recapture-host",
      frameClockRef: "clock/recapture-host",
    };
  }

  function realScene(sceneId: string, sourceRef: CaptureRequest): Scenario["scenes"][number] {
    return {
      sceneId,
      sourceRef,
      actorRefs: [],
      narration: [],
      captionRefs: [],
      durationMillis: 1_000,
    };
  }

  it("captures real file and HTTP bytes through the routed adapters", async () => {
    const dir = await tempDir();
    const filePayload = new Uint8Array([9, 8, 7, 6, 5]);
    const filePath = join(dir, "scene.bin");
    await writeFile(filePath, filePayload);
    const httpPayload = "http-scene-real-bytes";
    let httpRequests = 0;

    await withHttpServer((_req, res) => {
      httpRequests += 1;
      res.writeHead(200, { "content-type": "application/octet-stream" }).end(httpPayload);
    }, async (origin) => {
      const fileRequest = captureRequest("MEDIA_FILE", "media-file:scene-a");
      const httpRequest = captureRequest("HTTP_API", "api:scene-b");
      const plan = orchestrateScenario({
        scenarioId: "real-capture",
        revision: "rev-1",
        actors: [],
        scenes: [realScene("file-scene", fileRequest), realScene("http-scene", httpRequest)],
      });
      expect(plan.dryRunOnly).toBe(true);

      const routed = routedCaptureAdapter({
        MEDIA_FILE: new MediaFileCaptureAdapter({
          resolveSource: (request) => (request.sourceIdentity === "media-file:scene-a"
            ? filePath
            : Promise.reject(new Error("unmapped source"))),
          allowedRoot: dir,
        }),
        HTTP_API: new HttpApiCaptureAdapter({
          resolveEndpoint: () => `${origin}/capture`,
          allowedOrigins: [origin],
        }),
      });

      const frames = await recaptureScenario(plan, { check: () => "ADMITTED" }, routed);

      expect(frames).toHaveLength(2);
      expect(frames[0]!.bytes).toEqual(filePayload);
      expect(frames[0]!.sourceIdentity).toBe("media-file:scene-a");
      expect(frames[0]!.sourceVersionRef).toBe("media-file:scene-a@v1");
      expect(frames[0]!.frameClockRef).toBe("clock/recapture-host");
      expect(new TextDecoder().decode(frames[1]!.bytes)).toBe(httpPayload);
      expect(frames[1]!.sourceIdentity).toBe("api:scene-b");
      expect(httpRequests).toBe(1);
    });
  });

  it("denied eligibility performs zero resolver, fetch or file effects", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "scene.bin");
    await writeFile(filePath, "payload");
    let resolveCalls = 0;
    let endpointCalls = 0;
    let fetchCalls = 0;

    const plan = orchestrateScenario({
      scenarioId: "denied-capture",
      revision: "rev-1",
      actors: [],
      scenes: [realScene("file-scene", captureRequest("MEDIA_FILE", "media-file:scene-a"))],
    });
    const routed = routedCaptureAdapter({
      MEDIA_FILE: new MediaFileCaptureAdapter({
        resolveSource: () => {
          resolveCalls += 1;
          return filePath;
        },
      }),
      HTTP_API: new HttpApiCaptureAdapter({
        resolveEndpoint: () => {
          endpointCalls += 1;
          return "https://api.example.com/capture";
        },
        fetchImpl: (async () => {
          fetchCalls += 1;
          throw new Error("must not be called");
        }) as typeof fetch,
      }),
    });

    await expect(recaptureScenario(plan, { check: () => "NOT_ADMITTED" }, routed))
      .rejects.toBeInstanceOf(CaptureNotAdmittedError);
    expect(resolveCalls).toBe(0);
    expect(endpointCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  it("an admitted but unwired kind fails UNKNOWN before any provider dispatch", async () => {
    let resolveCalls = 0;
    const plan = orchestrateScenario({
      scenarioId: "unwired-capture",
      revision: "rev-1",
      actors: [],
      scenes: [
        realScene("camera-scene", captureRequest("CAMERA", "camera:scene-a")),
        realScene("file-scene", captureRequest("MEDIA_FILE", "media-file:scene-b")),
      ],
    });
    const routed = routedCaptureAdapter({
      MEDIA_FILE: new MediaFileCaptureAdapter({
        resolveSource: () => {
          resolveCalls += 1;
          return join(tmpdir(), "never-read.bin");
        },
      }),
    });

    await expect(recaptureScenario(plan, { check: () => "ADMITTED" }, routed))
      .rejects.toMatchObject({
        name: "CaptureOutcomeUnknownError",
        kind: "CAMERA",
        reason: "ADAPTER_REJECTED",
      });
    // The file scene was never reached: routing rejected the unwired kind
    // before its adapter ran, and the wrapper reports post-admission UNKNOWN.
    expect(resolveCalls).toBe(0);
  });
});
describe("executeScenario", () => {
  const frame: CapturedFrame = {
    sourceIdentity: "browser/demo/intro",
    purposeRef: "purpose/demo-recording",
    exactRightsScope: "rights/demo-recording/v1",
    sourceVersionRef: "intro@v2",
    frameClockRef: "clock/demo-host",
    bytes: new Uint8Array([7]),
    capturedAtEpochMillis: 1,
  };

  it("records a real SHA-256 source digest and per-scene CAPTURED outcomes", async () => {
    const plan = orchestrateScenario(scenario());
    const record = await executeScenario(plan, { check: () => "ADMITTED" }, {
      capture: async (request) => ({
        ...frame,
        sourceIdentity: request.sourceIdentity,
        purposeRef: request.purposeRef,
        exactRightsScope: request.exactRightsScope,
        sourceVersionRef: request.sourceVersionRef,
        frameClockRef: request.frameClockRef,
      }),
    });
    expect(record.attempts).toHaveLength(2);
    for (const attempt of record.attempts) {
      expect(attempt.outcome).toBe("CAPTURED");
      expect(attempt.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(attempt.capturedBytes).toBe(1);
    }
    const expected = Array.from(
      new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array([7]).buffer)),
    ).map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(record.attempts[0]!.sourceDigest).toBe(expected);
  });

  it("records NOT_ADMITTED for denied scenes and OUTCOME_UNKNOWN for lost ack — never coerced", async () => {
    const plan = orchestrateScenario(scenario());
    let calls = 0;
    const record = await executeScenario(plan,
      { check: (r) => (r.sourceVersionRef === "intro@v2" ? "NOT_ADMITTED" : "ADMITTED") },
      { capture: async () => { calls += 1; throw new Error("transport lost after dispatch"); } });
    expect(calls).toBe(1);
    expect(record.attempts[0]!.outcome).toBe("NOT_ADMITTED");
    expect(record.attempts[0]!.sourceDigest).toBeNull();
    expect(record.attempts[1]!.outcome).toBe("OUTCOME_UNKNOWN");
    expect(record.attempts[1]!.sourceDigest).toBeNull();
  });

  it("two identical runs recapture nothing; changed scene alone is selected", async () => {
    const prior = orchestrateScenario(scenario());
    const first = await executeScenario(prior, { check: () => "ADMITTED" }, {
      capture: async (request) => ({
        ...frame,
        sourceIdentity: request.sourceIdentity,
        purposeRef: request.purposeRef,
        exactRightsScope: request.exactRightsScope,
        sourceVersionRef: request.sourceVersionRef,
        frameClockRef: request.frameClockRef,
      }),
    });
    const unchanged = orchestrateScenario(scenario());
    expect(scenesRequiringRecapture(prior, unchanged, first.attempts)).toEqual([]);

    const next = orchestrateScenario(scenario({
      scenes: [
        { ...scenario().scenes[0]!, sourceRef: { ...scenario().scenes[0]!.sourceRef, sourceVersionRef: "intro@v3" } },
        scenario().scenes[1]!,
      ],
    }));
    expect(scenesRequiringRecapture(prior, next, first.attempts)).toEqual(["intro"]);
  });

  it("reruns scenes whose prior attempt was not CAPTURED", async () => {
    const prior = orchestrateScenario(scenario());
    const denied = await executeScenario(prior, { check: () => "NOT_ADMITTED" }, {
      capture: async () => frame,
    });
    const next = orchestrateScenario(scenario());
    expect(scenesRequiringRecapture(prior, next, denied.attempts)).toEqual(["intro", "main"]);
  });

  it("rejects oversized selectors and unknown sceneIds before any capture", async () => {
    const plan = orchestrateScenario(scenario());
    let calls = 0;
    const adapter = { capture: async () => { calls += 1; return frame; } };
    await expect(executeScenario(plan, { check: () => "ADMITTED" }, adapter,
      { sceneIds: ["nope"] })).rejects.toBeInstanceOf(ScenarioError);
    await expect(executeScenario(plan, { check: () => "ADMITTED" }, adapter,
      { maxScenes: 1 })).rejects.toBeInstanceOf(ScenarioError);
    expect(calls).toBe(0);
  });
});

describe("publishFinalRender", () => {
  const request = () => ({
    renderId: "render/demo/v1",
    plan: orchestrateScenario(scenario()),
    frameRate: { numerator: 30, denominator: 1 },
    variableFrameRate: false,
    timeBase: { numerator: 1, denominator: 90_000 },
    durationTicks: 1_350_000,
    captions: [{ captionRef: "captions/intro@v1", startTicks: 90_000, endTicks: 180_000 }],
    creditRefs: ["credits/demo@v1"],
    fileName: "demo.mp4",
    retention: "P30D",
    classification: "INTERNAL" as const,
  });
  const verifiedContainer = (bytes = new Uint8Array([1, 2, 3])) => ({
    bytes,
    contentType: "video/mp4",
    probe: {
      container: "mov,mp4,m4a,3gp,3g2,mj2",
      frameRate: { numerator: 30, denominator: 1 },
      variableFrameRate: false,
      timeBase: { numerator: 1, denominator: 90_000 },
      durationTicks: 1_350_000,
      decodedFrameCount: 450,
      audioTrackCount: 1,
      narrationTrackRefs: ["narration/intro@v1"],
      captionTrackCount: 1,
      captionTimings: [{ captionRef: "captions/intro@v1", startTicks: 90_000, endTicks: 180_000 }],
      creditRefsIncluded: ["credits/demo@v1"],
    },
  });
  const admitted = { admit: async () => ({ status: "ADMITTED" as const, decisionRefs: ["rights-decision/demo"] }) };
  const muxer = { muxAndVerify: async () => verifiedContainer() };
  const uploadSession = (overrides: Record<string, unknown> = {}) => ({
    uploadId: "upload-1", tenantId: "tenant-1", principalId: "principal-1", fileName: "demo.mp4",
    contentType: "video/mp4", expectedSizeBytes: 3, expectedSha256: "a".repeat(64), classification: "INTERNAL",
    createdAt: "2026-11-05T00:00:00Z", expiresAt: "2026-11-06T00:00:00Z", bytesReceived: 0,
    nextChunkIndex: 0, status: "OPEN", metadata: {}, ...overrides,
  });
  const fakeClient = (overrides: Record<string, unknown> = {}) => {
    let submittedSha256 = "";
    return ({
    createUploadSession: vi.fn(async (input: { readonly expectedSha256: string }) => {
      submittedSha256 = input.expectedSha256;
      return uploadSession({ expectedSha256: submittedSha256 });
    }),
    uploadPart: vi.fn(async (session: ReturnType<typeof uploadSession>, _index: number, blob: Blob) =>
      uploadSession({ bytesReceived: session.bytesReceived + blob.size, nextChunkIndex: session.nextChunkIndex + 1 })),
    completeUploadSession: vi.fn(async () => ({
      tenantId: "tenant-1", principalId: "principal-1", artifactId: "artifact-1", fileName: "demo.mp4",
      contentType: "video/mp4", sizeBytes: 3, sha256: submittedSha256, objectReference: "objects/demo",
      classification: "INTERNAL", createdAt: "2026-11-05T00:00:00Z", expiresAt: "2026-12-05T00:00:00Z", metadata: {},
    })),
    ...overrides,
  }) as unknown as MediaOperationClient;
  };

  it("fails closed when trusted codec/probe or canonical artifact client is absent", async () => {
    const client = fakeClient();
    await expect(publishFinalRender(request(), undefined, muxer, client)).resolves.toMatchObject({ outcome: "NOT_ADMITTED" });
    expect((client as unknown as { createUploadSession: ReturnType<typeof vi.fn> }).createUploadSession).not.toHaveBeenCalled();
  });

  it("rejects probe timing drift before the canonical upload effect", async () => {
    const client = fakeClient();
    const badMuxer = { muxAndVerify: async () => ({
      ...verifiedContainer(),
      probe: { ...verifiedContainer().probe, durationTicks: 1_350_001 },
    }) };
    await expect(publishFinalRender(request(), admitted, badMuxer, client)).resolves.toMatchObject({ outcome: "NOT_ADMITTED" });
    expect((client as unknown as { createUploadSession: ReturnType<typeof vi.fn> }).createUploadSession).not.toHaveBeenCalled();
  });

  it("rejects a forged scenario identity or lineage before authority or upload calls", async () => {
    const client = fakeClient();
    const admission = { admit: vi.fn(async () => ({ status: "ADMITTED" as const, decisionRefs: ["rights-decision/demo"] })) };
    const input = request();
    const forged = {
      ...input,
      plan: { ...input.plan, planIdentity: `${input.plan.planIdentity}tampered` },
    };

    await expect(publishFinalRender(forged, admission, muxer, client))
      .rejects.toMatchObject({ code: "INVALID_SCENARIO" });
    expect(admission.admit).not.toHaveBeenCalled();
    expect((client as unknown as { createUploadSession: ReturnType<typeof vi.fn> }).createUploadSession)
      .not.toHaveBeenCalled();
  });

  it("rejects missing narration, caption-track, or credit inclusion observations", async () => {
    for (const missing of [
      { narrationTrackRefs: [] },
      { captionTrackCount: 0 },
      { creditRefsIncluded: [] },
    ]) {
      const client = fakeClient();
      const noEvidenceMuxer = { muxAndVerify: async () => ({
        ...verifiedContainer(), probe: { ...verifiedContainer().probe, ...missing },
      }) };
      await expect(publishFinalRender(request(), admitted, noEvidenceMuxer, client))
        .resolves.toMatchObject({ outcome: "NOT_ADMITTED" });
      expect((client as unknown as { createUploadSession: ReturnType<typeof vi.fn> }).createUploadSession)
        .not.toHaveBeenCalled();
    }
  });

  it("rechecks rights after mux and before creating the canonical artifact", async () => {
    let checks = 0;
    const revokesAfterMux = { admit: async () => ({
      status: ++checks === 1 ? "ADMITTED" as const : "NOT_ADMITTED" as const,
      decisionRefs: checks === 1 ? ["rights-decision/demo"] : [],
    }) };
    const client = fakeClient();
    await expect(publishFinalRender(request(), revokesAfterMux, muxer, client))
      .resolves.toMatchObject({ outcome: "NOT_ADMITTED" });
    expect(checks).toBe(2);
    expect((client as unknown as { createUploadSession: ReturnType<typeof vi.fn> }).createUploadSession)
      .not.toHaveBeenCalled();
  });

  it("rechecks rights between chunks and leaves a revoked partial upload unfinalized", async () => {
    const bigBytes = new Uint8Array(4 * 1024 * 1024 + 1);
    let checks = 0;
    const revokeOnSecondChunk = { admit: async () => ({
      status: ++checks === 4 ? "NOT_ADMITTED" as const : "ADMITTED" as const,
      decisionRefs: ["rights-decision/demo"],
    }) };
    const uploadPart = vi.fn(async (session: { readonly bytesReceived: number; readonly nextChunkIndex: number }, _index: number, blob: Blob) =>
      uploadSession({ bytesReceived: session.bytesReceived + blob.size, nextChunkIndex: session.nextChunkIndex + 1 }));
    const client = fakeClient({ uploadPart });
    await expect(publishFinalRender(request(), revokeOnSecondChunk,
      { muxAndVerify: async () => verifiedContainer(bigBytes) }, client)).resolves.toMatchObject({
      outcome: "PARTIAL_UPLOAD_NOT_FINALIZED", uploadId: "upload-1",
    });
    expect(checks).toBe(4);
    expect(uploadPart).toHaveBeenCalledTimes(1);
    expect((client as unknown as { completeUploadSession: ReturnType<typeof vi.fn> }).completeUploadSession)
      .not.toHaveBeenCalled();
  });

  it("rechecks rights immediately before completion", async () => {
    let checks = 0;
    const revokeBeforeComplete = { admit: async () => ({
      status: ++checks === 4 ? "NOT_ADMITTED" as const : "ADMITTED" as const,
      decisionRefs: ["rights-decision/demo"],
    }) };
    const client = fakeClient();
    await expect(publishFinalRender(request(), revokeBeforeComplete, muxer, client)).resolves.toMatchObject({
      outcome: "PARTIAL_UPLOAD_NOT_FINALIZED", uploadId: "upload-1",
    });
    expect(checks).toBe(4);
    expect((client as unknown as { completeUploadSession: ReturnType<typeof vi.fn> }).completeUploadSession)
      .not.toHaveBeenCalled();
  });

  it("clones mux output before an asynchronous authority recheck can mutate it", async () => {
    const muxBytes = new Uint8Array([1, 2, 3]);
    let checks = 0;
    const mutateDuringRecheck = { admit: async () => {
      checks += 1;
      if (checks === 2) muxBytes.fill(9);
      return { status: "ADMITTED" as const, decisionRefs: [`rights-decision/${checks}`] };
    } };
    let uploadedBytes: number[] = [];
    const client = fakeClient({
      uploadPart: vi.fn(async (_session: unknown, _index: number, blob: Blob) => {
        uploadedBytes = [...new Uint8Array(await blob.arrayBuffer())];
        return uploadSession({ bytesReceived: 3, nextChunkIndex: 1 });
      }),
    });
    await expect(publishFinalRender(request(), mutateDuringRecheck,
      { muxAndVerify: async () => verifiedContainer(muxBytes) }, client))
      .resolves.toMatchObject({ outcome: "PUBLISHED" });
    expect(uploadedBytes).toEqual([1, 2, 3]);
  });

  it("uploads verified bytes through the canonical API with lineage and stable request binding", async () => {
    const client = fakeClient();
    const firstRequest = request();
    const secondRequest = {
      ...request(),
      frameRate: { denominator: 1, numerator: 30 },
      timeBase: { denominator: 90_000, numerator: 1 },
    };
    const first = await publishFinalRender(firstRequest, admitted, muxer, client);
    const second = await publishFinalRender(secondRequest, admitted, muxer, client);
    expect(first).toMatchObject({ outcome: "PUBLISHED", artifact: { artifactId: "artifact-1" } });
    expect(second).toMatchObject({ outcome: "PUBLISHED" });
    const create = (client as unknown as { createUploadSession: ReturnType<typeof vi.fn> }).createUploadSession;
    expect(create.mock.calls[0]![0].idempotencyKey).toBe(create.mock.calls[1]![0].idempotencyKey);
    expect(create.mock.calls[0]![0].metadata.sourceLineage).toEqual(
      firstRequest.plan.sceneRuns.map(({ sceneId, lineageId, sourceRevision }) => ({ sceneId, lineageId, sourceRevision })));
    expect((client as unknown as { uploadPart: ReturnType<typeof vi.fn> }).uploadPart).toHaveBeenCalledTimes(2);
  });

  it("does not finalize or claim success when a partial canonical upload fails", async () => {
    const client = fakeClient({
      uploadPart: vi.fn(async () => { throw new Error("transport interruption"); }),
    });
    await expect(publishFinalRender(request(), admitted, muxer, client)).resolves.toMatchObject({
      outcome: "PARTIAL_UPLOAD_NOT_FINALIZED", uploadId: "upload-1",
    });
    expect((client as unknown as { completeUploadSession: ReturnType<typeof vi.fn> }).completeUploadSession).not.toHaveBeenCalled();
  });
});
