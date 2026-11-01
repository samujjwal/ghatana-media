import { describe, expect, it } from "vitest";
import {
  ScenarioError,
  changedSceneLineages,
  orchestrateScenario,
  recaptureScenario,
  type Scenario,
} from "./recorder-orchestrator";
import { CaptureNotAdmittedError, type CapturedFrame } from "./capture-adapters";

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    scenarioId: "demo-1",
    revision: "rev-3",
    actors: [{ actorId: "actor-1", role: "presenter" }],
    scenes: [
      {
        sceneId: "intro",
        sourceRef: "media-file:intro-clip",
        sourceRevision: "intro@v2",
        actorRefs: ["actor-1"],
        narration: [{ atMillis: 500, trackRef: "narration/intro@v1" }],
        captionRefs: ["captions/intro@v1"],
        durationMillis: 5_000,
      },
      {
        sceneId: "main",
        sourceRef: "media-file:main-clip",
        sourceRevision: "main@v4",
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
    expect(a.dryRunOnly).toBe(true);
    expect(a.sceneRuns[0]!.capturePlan.sourceVersionRef).toBe("intro@v2");
    expect(a.sceneRuns[0]!.narration[0]!.atMillis).toBe(500);
  });

  it("a changed scene revision re-plans only that scene's lineage", () => {
    const prior = orchestrateScenario(scenario());
    const next = orchestrateScenario(scenario({
      scenes: [
        { ...scenario().scenes[0]!, sourceRevision: "intro@v3" },
        scenario().scenes[1]!,
      ],
    }));
    const diff = changedSceneLineages(prior, next);
    expect(diff.carried).toEqual(["main"]);
    expect(diff.replanned).toEqual(["intro"]);
    expect(next.sceneRuns[0]!.lineageId).not.toBe(prior.sceneRuns[0]!.lineageId);
    expect(next.sceneRuns[1]!.lineageId).toBe(prior.sceneRuns[1]!.lineageId);
  });

  it.each([
    ["source identity", { sourceRef: "media-file:replacement-clip" }],
    ["narration", { narration: [{ atMillis: 750, trackRef: "narration/intro@v2" }] }],
    ["caption refs", { captionRefs: ["captions/intro@v2"] }],
    ["duration", { durationMillis: 6_000 }],
  ])("replans a scene when its %s changes without changing the declared lineage ID", (_label, change) => {
    const base = scenario();
    const prior = orchestrateScenario(base);
    const next = orchestrateScenario({
      ...base,
      scenes: [{ ...base.scenes[0]!, ...change }, base.scenes[1]!],
    });

    expect(next.sceneRuns[0]!.lineageId).toBe(prior.sceneRuns[0]!.lineageId);
    expect(changedSceneLineages(prior, next)).toEqual({ carried: ["main"], replanned: ["intro"] });
  });

  it("replans when the role bound to a scene actor changes", () => {
    const base = scenario();
    const prior = orchestrateScenario(base);
    const next = orchestrateScenario({
      ...base,
      actors: [{ actorId: "actor-1", role: "narrator" }],
    });
    expect(next.sceneRuns[0]!.actorBindings).toEqual([{ actorId: "actor-1", role: "narrator" }]);
    expect(changedSceneLineages(prior, next)).toEqual({ carried: [], replanned: ["intro", "main"] });
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
});

describe("recaptureScenario", () => {
  const frame: CapturedFrame = {
    sourceIdentity: "media-file:intro-clip",
    frameClockRef: "clock/scenario/demo-1",
    bytes: new Uint8Array([7]),
    capturedAtEpochMillis: 1,
  };

  it("captures admitted scenes only; unadmitted fails closed with no frames", async () => {
    const plan = orchestrateScenario(scenario());
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
        return { ...frame, sourceIdentity: request.sourceIdentity, frameClockRef: request.frameClockRef };
      },
    }, { sceneIds: ["main", "intro"], maxScenes: 2 });
    expect(sourceOrder).toEqual(["media-file:intro-clip", "media-file:main-clip"]);
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
