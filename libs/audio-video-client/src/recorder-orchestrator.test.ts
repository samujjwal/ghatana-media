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
});
