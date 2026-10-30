import { describe, it, expect } from 'vitest';
import {
  ProductionSpecSchema, SceneBindingSchema, AnimationSpecSchema,
  ModelExecutionSpecSchema, SimulationStateSchema, SignedInt64DecimalSchema,
  StoryTimeSchema,
} from './production';

const ref = 'media://revision/abc123';
const storyClock = {
  clockKind: 'story', clockId: 'clk-1', streamId: 'st-1',
  originRef: ref, ticks: '0', timeBase: { numerator: '1', denominator: '90000' },
};
const spec = {
  tenantId: 'tenant-1', projectId: 'proj-1', revisionId: 'rev-1',
  schemaVersion: 'media.declarative.value.production-spec.v1',
  originClass: 'DECLARATIVE_ANIMATION', purposeRef: ref,
  sceneRefs: [ref], timelineRef: ref, rightsRef: ref, outputProfileRefs: [ref],
};

describe('TY-04 headless declarative parsers', () => {
  it('accepts a well-formed production spec', () => {
    expect(ProductionSpecSchema.safeParse(spec).success).toBe(true);
  });
  it('rejects unknown fields, wrong schemaVersion and empty ref lists', () => {
    expect(ProductionSpecSchema.safeParse({ ...spec, extra: 1 }).success).toBe(false);
    expect(ProductionSpecSchema.safeParse({ ...spec, schemaVersion: 'v2' }).success).toBe(false);
    expect(ProductionSpecSchema.safeParse({ ...spec, sceneRefs: [] }).success).toBe(false);
    expect(ProductionSpecSchema.safeParse({ ...spec, originClass: 'BOGUS' }).success).toBe(false);
    expect(ProductionSpecSchema.safeParse({ ...spec, tenantId: 'bad id!' }).success).toBe(false);
  });
  it('rejects the wrong clock kind — a story clock is not a simulation clock', () => {
    const anim = {
      schemaVersion: 'media.declarative.value.animation-spec.v1',
      sceneGraphRef: ref, animationGraphRef: ref, operatorTreeRef: ref,
      assetsRef: ref, propertyCurveRefs: [], tStoryRef: storyClock, renderingRef: ref,
    };
    expect(AnimationSpecSchema.safeParse(anim).success).toBe(true);
    expect(AnimationSpecSchema.safeParse({
      ...anim, tStoryRef: { ...storyClock, clockKind: 'simulation' },
    }).success).toBe(false);
    expect(AnimationSpecSchema.safeParse({
      ...anim, tStoryRef: { ...storyClock, ticks: '1.5' },
    }).success).toBe(false); // floats never accepted
  });
  it('preserves exact int64 as canonical decimal strings — never a number', () => {
    expect(SignedInt64DecimalSchema.safeParse('9223372036854775807').success).toBe(true);
    expect(SignedInt64DecimalSchema.safeParse('-9007199254740993').success).toBe(true);
    expect(SignedInt64DecimalSchema.safeParse(9223372036854775807).success).toBe(false);
    expect(SignedInt64DecimalSchema.safeParse('1.5e10').success).toBe(false);
    expect(SignedInt64DecimalSchema.safeParse('00').success).toBe(false);
  });
  const execSpec = {
    schemaVersion: 'media.declarative.value.model-execution-spec.v1',
    modelFamilyRef: ref, modelVersionRef: ref,
    familyApplicability: { applicability: 'NOT_ADMITTED', evidenceRefs: [] },
    familyQualificationRef: ref, familyQualificationState: 'UNQUALIFIED',
    replayability: 'NON_REPLAYABLE',
    modelDigest: { algorithmRef: ref, value: 'sha256:abc', subjectVersionRef: ref },
    declaredAssumptionsRef: ref, solverId: 'solver-1', solverVersion: '1.0.0',
    solverBuildDigest: { algorithmRef: ref, value: 'sha256:def', subjectVersionRef: ref },
    numericPrecision: 'decimal128', initialConditionsRef: ref, boundaryConditionsRef: ref,
    unitsRegistryRef: ref, parameterRevisionRef: ref,
    tSimClockRef: { ...storyClock, clockKind: 'simulation' },
    stepPolicy: ref, toleranceContractRef: ref, fidelityProfileRef: ref,
    resourceBounds: { stepLimit: 1, wallClockBudgetMs: 1, memoryBudgetBytes: 1, workloadLimit: 1, recursionLimit: 1 },
    seedPolicy: ref,
    randomnessSemantics: { disposition: 'UNKNOWN', reason: 'rng-not-declared' },
    distributionRef: ref, samplingConditionsRef: ref, samplingPlanRef: ref,
  };
  it('accepts a well-formed model execution spec', () => {
    expect(ModelExecutionSpecSchema.safeParse(execSpec).success).toBe(true);
  });
  it('enforces the invariant: UNKNOWN randomness can never claim REPLAYABLE', () => {
    expect(ModelExecutionSpecSchema.safeParse({
      ...execSpec, replayability: 'REPLAYABLE',
    }).success).toBe(false);
    expect(ModelExecutionSpecSchema.safeParse({
      ...execSpec, replayability: 'UNKNOWN',
    }).success).toBe(true);
  });
  it('rejects zero resource bounds and malformed digests', () => {
    expect(ModelExecutionSpecSchema.safeParse({
      ...execSpec, resourceBounds: { ...execSpec.resourceBounds, stepLimit: 0 },
    }).success).toBe(false);
    expect(ModelExecutionSpecSchema.safeParse({
      ...execSpec, modelDigest: { ...execSpec.modelDigest, extra: 'x' },
    }).success).toBe(false);
  });
  it('simulation state rejects unbounded or wrong-version checkpoints', () => {
    const state = {
      schemaVersion: 'media.declarative.value.simulation-state.v1',
      runId: 'run-1', attemptId: 'att-1', modelFamilyRef: ref, modelVersionRef: ref,
      familyApplicability: { applicability: 'UNKNOWN', evidenceRefs: [] },
      familyQualificationRef: ref, replayability: 'UNKNOWN', solverVersionRef: ref,
      tSimTicks: '42', stepIndex: '7', stateVersion: 'sv-1',
      stateDigest: { algorithmRef: ref, value: 'sha256:s', subjectVersionRef: ref },
      parameterDigest: { algorithmRef: ref, value: 'sha256:p', subjectVersionRef: ref },
      rngStateOrNull: null,
      randomnessSemantics: { disposition: 'NOT_APPLICABLE', nonStochasticDeclarationVersionRef: ref, reason: 'deterministic' },
      checkpointParentRefOrNull: null,
    };
    expect(SimulationStateSchema.safeParse(state).success).toBe(true);
    expect(SimulationStateSchema.safeParse({ ...state, tSimTicks: 'abc' }).success).toBe(false);
    expect(SimulationStateSchema.safeParse({ ...state, unknown: 1 }).success).toBe(false);
  });
});
