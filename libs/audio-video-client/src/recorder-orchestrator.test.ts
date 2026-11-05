import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ScenarioError,
  changedSceneLineages,
  orchestrateScenario,
  recaptureScenario,
  type Scenario,
} from "./recorder-orchestrator";
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
