import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orchestrateScenario, type Scenario } from "./recorder-orchestrator.js";
import {
  FileRecorderCheckpointStore,
  RecorderCheckpointError,
  resumeScenarioFromCheckpoint,
} from "./recorder-checkpoint-store.js";

function threeSceneScenario(): Scenario {
  return {
    scenarioId: "checkpoint-demo",
    revision: "v1",
    actors: [],
    scenes: ["opening", "middle", "closing"].map((sceneId) => ({
      sceneId,
      sourceRef: {
        kind: "MEDIA_FILE",
        sourceIdentity: `fixture/${sceneId}`,
        purposeRef: "purpose/local-demo",
        exactRightsScope: "rights/local-fixture/v1",
        sourceVersionRef: `${sceneId}@v1`,
        secretsRef: "secrets/local-fixture",
        frameClockRef: "clock/local-fixture",
      },
      actorRefs: [], narration: [], captionRefs: [], durationMillis: 1000,
    })),
  };
}

describe("FileRecorderCheckpointStore", () => {
  it("persists three-scene source outcomes and reuses captured scenes after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "media-recorder-checkpoint-"));
    try {
      const store = new FileRecorderCheckpointStore(join(directory, "checkpoint.json"));
      const plan = orchestrateScenario(threeSceneScenario());
      let calls = 0;
      const result = await resumeScenarioFromCheckpoint(plan, store,
        { check: () => "ADMITTED" },
        { capture: async (request) => {
          calls += 1;
          if (request.sourceIdentity === "fixture/middle") throw new Error("capture acknowledgment lost");
          return {
            sourceIdentity: request.sourceIdentity,
            purposeRef: request.purposeRef,
            exactRightsScope: request.exactRightsScope,
            sourceVersionRef: request.sourceVersionRef,
            frameClockRef: request.frameClockRef,
            bytes: new Uint8Array([calls]),
            capturedAtEpochMillis: Date.now(),
          };
        }});
      const latest = new Map(result.checkpoint.attempts.map(({ sceneId, outcome }) => [sceneId, outcome]));
      expect([...latest]).toEqual([
        ["opening", "CAPTURED"], ["middle", "OUTCOME_UNKNOWN"], ["closing", "CAPTURED"],
      ]);
      expect(result.reusedSceneIds).toEqual([]);
      expect(result.reconciliationRequiredSceneIds).toEqual(["middle"]);
      const restarted = await resumeScenarioFromCheckpoint(plan, store,
        { check: () => "ADMITTED" },
        { capture: async () => { calls += 1; throw new Error("must not replay unknown"); } });
      expect(calls).toBe(3);
      expect(restarted.reusedSceneIds).toEqual(["opening", "closing"]);
      expect(restarted.reconciliationRequiredSceneIds).toEqual(["middle"]);
      expect((await store.read())?.attempts).toHaveLength(6);
      const opening = [...restarted.checkpoint.attempts].reverse().find((attempt) => attempt.sceneId === "opening")!;
      expect(opening.sourceDigest).toMatch(/^[0-9a-f]{64}$/u);
      expect([...await store.readSourceBytes(opening.sourceDigest!)]).toEqual([1]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reuses captured source bytes across caption-only plan revisions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "media-recorder-checkpoint-"));
    try {
      const store = new FileRecorderCheckpointStore(join(directory, "checkpoint.json"));
      const original = orchestrateScenario(threeSceneScenario());
      let calls = 0;
      await resumeScenarioFromCheckpoint(original, store, { check: () => "ADMITTED" }, {
        capture: async (request) => {
          calls += 1;
          return { sourceIdentity: request.sourceIdentity, purposeRef: request.purposeRef,
            exactRightsScope: request.exactRightsScope, sourceVersionRef: request.sourceVersionRef,
            frameClockRef: request.frameClockRef, bytes: new Uint8Array([calls]),
            capturedAtEpochMillis: Date.now() };
        },
      });
      const source = threeSceneScenario();
      const edited = orchestrateScenario({ ...source, revision: "v2", scenes: [
        { ...source.scenes[0]!, captionRefs: ["captions/new@v1"] }, source.scenes[1]!, source.scenes[2]!,
      ] });
      const result = await resumeScenarioFromCheckpoint(edited, store, { check: () => "ADMITTED" }, {
        capture: async () => { calls += 1; throw new Error("source should be reused"); },
      });
      expect(calls).toBe(3);
      expect(result.reusedSceneIds).toEqual(["opening", "middle", "closing"]);
      expect(result.checkpoint.planIdentity).toBe(edited.planIdentity);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not replay a crash-window UNKNOWN intent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "media-recorder-checkpoint-"));
    try {
      const store = new FileRecorderCheckpointStore(join(directory, "checkpoint.json"));
      const source = threeSceneScenario();
      const oneScene = orchestrateScenario({ ...source, scenes: [source.scenes[0]!] });
      const run = oneScene.sceneRuns[0]!;
      await store.write({ schemaVersion: 1, scenarioId: oneScene.scenarioId,
        revision: oneScene.revision, planIdentity: oneScene.planIdentity, sceneRuns: oneScene.sceneRuns,
        attempts: [{ sceneId: run.sceneId, lineageId: run.lineageId, sourceRevision: run.sourceRevision,
          outcome: "OUTCOME_UNKNOWN", sourceDigest: null, capturedBytes: 0,
          attemptedAtEpochMillis: Date.now() }], updatedAtEpochMillis: Date.now() });
      let calls = 0;
      const result = await resumeScenarioFromCheckpoint(oneScene, store, { check: () => "ADMITTED" }, {
        capture: async () => { calls += 1; throw new Error("unknown intent must never replay"); },
      });
      expect(calls).toBe(0);
      expect(result.reconciliationRequiredSceneIds).toEqual([run.sceneId]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("preserves an unresolved scene fence through successive source revisions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "media-recorder-checkpoint-"));
    try {
      const store = new FileRecorderCheckpointStore(join(directory, "checkpoint.json"));
      const source = threeSceneScenario();
      const original = orchestrateScenario({ ...source, scenes: [source.scenes[0]!] });
      const oldRun = original.sceneRuns[0]!;
      await store.write({ schemaVersion: 1, scenarioId: original.scenarioId,
        revision: original.revision, planIdentity: original.planIdentity, sceneRuns: original.sceneRuns,
        attempts: [{ sceneId: oldRun.sceneId, lineageId: oldRun.lineageId,
          sourceRevision: oldRun.sourceRevision, outcome: "OUTCOME_UNKNOWN", sourceDigest: null,
          capturedBytes: 0, attemptedAtEpochMillis: Date.now() }], updatedAtEpochMillis: Date.now() });
      const v2 = orchestrateScenario({ ...source, revision: "v2", scenes: [{
        ...source.scenes[0]!, sourceRef: { ...source.scenes[0]!.sourceRef, sourceVersionRef: "opening@v2" },
      }] });
      const v3 = orchestrateScenario({ ...source, revision: "v3", scenes: [{
        ...source.scenes[0]!, sourceRef: { ...source.scenes[0]!.sourceRef, sourceVersionRef: "opening@v3" },
      }] });
      let calls = 0;
      const adapter = { capture: async () => { calls += 1; throw new Error("unresolved fence must persist"); } };
      expect((await resumeScenarioFromCheckpoint(v2, store, { check: () => "ADMITTED" }, adapter))
        .reconciliationRequiredSceneIds).toEqual(["opening"]);
      expect((await resumeScenarioFromCheckpoint(v3, store, { check: () => "ADMITTED" }, adapter))
        .reconciliationRequiredSceneIds).toEqual(["opening"]);
      expect(calls).toBe(0);
      expect((await store.read())?.attempts).toHaveLength(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("allows only one concurrent resume writer to dispatch capture", async () => {
    const directory = await mkdtemp(join(tmpdir(), "media-recorder-checkpoint-"));
    try {
      const store = new FileRecorderCheckpointStore(join(directory, "checkpoint.json"));
      const source = threeSceneScenario();
      const plan = orchestrateScenario({ ...source, scenes: [source.scenes[0]!] });
      let calls = 0;
      const adapter = { capture: async (request: import("./capture-adapters.js").CaptureRequest) => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { sourceIdentity: request.sourceIdentity, purposeRef: request.purposeRef,
          exactRightsScope: request.exactRightsScope, sourceVersionRef: request.sourceVersionRef,
          frameClockRef: request.frameClockRef, bytes: new Uint8Array([1]), capturedAtEpochMillis: Date.now() };
      }};
      const results = await Promise.allSettled([
        resumeScenarioFromCheckpoint(plan, store, { check: () => "ADMITTED" }, adapter),
        resumeScenarioFromCheckpoint(plan, store, { check: () => "ADMITTED" }, adapter),
      ]);
      expect(calls).toBe(1);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("rejects resuming a checkpoint against another scenario", async () => {
    const directory = await mkdtemp(join(tmpdir(), "media-recorder-checkpoint-"));
    try {
      const store = new FileRecorderCheckpointStore(join(directory, "checkpoint.json"));
      const plan = orchestrateScenario(threeSceneScenario());
      await store.write({ schemaVersion: 1, scenarioId: "another-scenario",
        revision: plan.revision, planIdentity: "different-plan", attempts: [],
        sceneRuns: plan.sceneRuns, updatedAtEpochMillis: Date.now() });
      await expect(resumeScenarioFromCheckpoint(plan, store, { check: () => "ADMITTED" },
        { capture: async () => { throw new Error("not called"); } }))
        .rejects.toBeInstanceOf(RecorderCheckpointError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed scene runs and inconsistent attempt outcomes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "media-recorder-checkpoint-"));
    try {
      const store = new FileRecorderCheckpointStore(join(directory, "checkpoint.json"));
      const plan = orchestrateScenario({ ...threeSceneScenario(), scenes: [threeSceneScenario().scenes[0]!] });
      const good = { schemaVersion: 1 as const, scenarioId: plan.scenarioId, revision: plan.revision,
        planIdentity: plan.planIdentity, attempts: [], sceneRuns: plan.sceneRuns,
        updatedAtEpochMillis: Date.now() };
      await expect(store.write({ ...good, sceneRuns: [{ ...plan.sceneRuns[0]!, capturePlan: null }] as never }))
        .rejects.toBeInstanceOf(RecorderCheckpointError);
      await expect(store.write({ ...good, attempts: [{ sceneId: "opening", lineageId: "lineage",
        sourceRevision: "opening@v1", outcome: "CAPTURED", sourceDigest: null, capturedBytes: 0,
        attemptedAtEpochMillis: Date.now() }] as never })).rejects.toBeInstanceOf(RecorderCheckpointError);
      await writeFile(join(directory, "checkpoint.json"), JSON.stringify({ ...good,
        sceneRuns: [{ sceneId: "broken" }] }));
      await expect(store.read()).rejects.toBeInstanceOf(RecorderCheckpointError);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each(["missing", "corrupt"] as const)(
    "requires reconciliation without recapture when checkpoint source bytes are %s after restart",
    async (condition) => {
      const directory = await mkdtemp(join(tmpdir(), "media-recorder-checkpoint-"));
      try {
        const store = new FileRecorderCheckpointStore(join(directory, "checkpoint.json"));
        const source = threeSceneScenario();
        const plan = orchestrateScenario({ ...source, scenes: [source.scenes[0]!] });
        await resumeScenarioFromCheckpoint(plan, store, { check: () => "ADMITTED" }, {
          capture: async (request) => ({ sourceIdentity: request.sourceIdentity,
            purposeRef: request.purposeRef, exactRightsScope: request.exactRightsScope,
            sourceVersionRef: request.sourceVersionRef, frameClockRef: request.frameClockRef,
            bytes: new Uint8Array([1, 2, 3]), capturedAtEpochMillis: Date.now() }),
        });
        const beforeRestart = await store.read();
        const captured = beforeRestart!.attempts.find((attempt) => attempt.outcome === "CAPTURED")!;
        const sourcePath = join(`${join(directory, "checkpoint.json")}.sources`, `${captured.sourceDigest}.bin`);
        if (condition === "missing") await rm(sourcePath);
        else await writeFile(sourcePath, new Uint8Array([9, 9, 9]));
        let calls = 0;
        const restarted = await resumeScenarioFromCheckpoint(plan, store, { check: () => "ADMITTED" }, {
          capture: async () => { calls += 1; throw new Error("must not recapture an unverifiable source"); },
        });
        expect(calls).toBe(0);
        expect(restarted.reusedSceneIds).toEqual([]);
        expect(restarted.reconciliationRequiredSceneIds).toEqual(["opening"]);
        expect(restarted.checkpoint.attempts).toHaveLength(beforeRestart!.attempts.length);
        expect(restarted.checkpoint.attempts.filter((attempt) => attempt.outcome === "OUTCOME_UNKNOWN"))
          .toHaveLength(beforeRestart!.attempts.filter((attempt) => attempt.outcome === "OUTCOME_UNKNOWN").length);
        expect([...restarted.checkpoint.attempts].reverse().find((attempt) => attempt.outcome === "CAPTURED")
          ?.sourceDigest).toBe(captured.sourceDigest);
      } finally { await rm(directory, { recursive: true, force: true }); }
    });
});
