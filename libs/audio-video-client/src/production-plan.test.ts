import { describe, expect, it } from "vitest";
import {
  ProductionPlanError,
  compileProductionPlan,
  type CaptureSourceResolver,
  type ResolvedSource,
} from "./production-plan";

function spec(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: "tenant-1",
    projectId: "project-1",
    revisionId: "rev-7",
    schemaVersion: "media.declarative.value.production-spec.v1",
    originClass: "REAL_CAPTURE",
    purposeRef: "purpose/v1",
    sceneRefs: ["scene/1@v3", "scene/2@v1"],
    timelineRef: "timeline/main@v2",
    rightsRef: "rights/standard@v1",
    outputProfileRefs: ["profile/1080p@v4"],
    ...overrides,
  };
}

function resolver(
  table: Record<string, ResolvedSource["eligibility"]>,
): CaptureSourceResolver & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    resolve: (sourceRef: string) => {
      seen.push(sourceRef);
      const eligibility = table[sourceRef];
      if (eligibility === undefined || eligibility === "UNRESOLVED") return null;
      return {
        sourceRef,
        immutableRevision: `${sourceRef}#sealed`,
        eligibility,
      };
    },
  };
}

const admitted = (refs: string[]): Record<string, ResolvedSource["eligibility"]> =>
  Object.fromEntries(refs.map((ref) => [ref, "LOCAL_ADMITTED"]));

const allRefs = ["purpose/v1", "scene/1@v3", "scene/2@v1",
  "timeline/main@v2", "rights/standard@v1", "profile/1080p@v4"];

describe("compileProductionPlan", () => {
  it("compiles a deterministic ordered plan bound to one project revision", async () => {
    const plan = await compileProductionPlan(spec(), resolver(admitted(allRefs)));
    expect(plan.schemaVersion).toBe("media.production-plan.v1");
    expect(plan.projectRevision).toBe("rev-7");
    expect(plan.dryRunOnly).toBe(true);
    expect(plan.steps.map((s) => s.stepId)).toEqual([
      "validate-spec", "capture-source-0", "capture-source-1",
      "compose-timeline", "render-outputs",
    ]);
    expect(plan.steps.every((s) => s.effect === "none")).toBe(true);
    expect(plan.steps[3]!.dependsOn).toEqual(["capture-source-0", "capture-source-1"]);
    expect(plan.planFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("produces an identical plan hash on identical inputs — no effect per input", async () => {
    const a = await compileProductionPlan(spec(), resolver(admitted(allRefs)));
    const b = await compileProductionPlan(spec(), resolver(admitted(allRefs)));
    expect(b.planFingerprint).toBe(a.planFingerprint);
    // Key order in the submitted object cannot change the plan.
    const shuffled = { outputProfileRefs: spec().outputProfileRefs,
      rightsRef: spec().rightsRef, timelineRef: spec().timelineRef,
      sceneRefs: spec().sceneRefs, purposeRef: spec().purposeRef,
      originClass: spec().originClass,
      schemaVersion: spec().schemaVersion,
      revisionId: spec().revisionId, projectId: spec().projectId,
      tenantId: spec().tenantId };
    const c = await compileProductionPlan(shuffled, resolver(admitted(allRefs)));
    expect(c.planFingerprint).toBe(a.planFingerprint);
    // A different revision produces a different fingerprint.
    const d = await compileProductionPlan(
      spec({ revisionId: "rev-8" }), resolver(admitted(allRefs)));
    expect(d.planFingerprint).not.toBe(a.planFingerprint);
  });

  it("rejects a protected capture source — no headless plan from live-admission sources", async () => {
    const table = admitted(allRefs);
    table["scene/1@v3"] = "PROTECTED";
    const failure = await compileProductionPlan(spec(), resolver(table)).then(
      () => { throw new Error("unreachable"); },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ProductionPlanError);
    expect((failure as ProductionPlanError).code).toBe("CAPTURE_SOURCE_PROTECTED");
  });

  it("rejects an unresolved source ref — one existing immutable revision is required", async () => {
    const table = admitted(allRefs);
    delete table["timeline/main@v2"];
    const failure = await compileProductionPlan(spec(), resolver(table)).then(
      () => { throw new Error("unreachable"); },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ProductionPlanError);
    expect((failure as ProductionPlanError).code).toBe("CAPTURE_SOURCE_UNRESOLVED");
  });

  it("rejects a spec that fails the TY-04 parser — invalid wire is not planned", async () => {
    const failure = await compileProductionPlan(
      spec({ schemaVersion: "media.declarative.value.production-spec.v2" }),
      resolver(admitted(allRefs)),
    ).then(
      () => { throw new Error("unreachable"); },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ProductionPlanError);
    expect((failure as ProductionPlanError).code).toBe("INVALID_PRODUCTION_SPEC");
  });
});
