import { describe, it, expect } from 'vitest';
import {
  ProductionSpecSchema, SceneBindingSchema, AnimationSpecSchema,
  ModelExecutionSpecSchema, SimulationStateSchema, SignedInt64DecimalSchema,
  PositiveInt64DecimalSchema, ResourceBoundsSchema, StoryTimeSchema,
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
  it('requires every declared production-spec field and preserves ordered immutable references', () => {
    const requiredFields = [
      'tenantId', 'projectId', 'revisionId', 'schemaVersion', 'originClass',
      'purposeRef', 'sceneRefs', 'timelineRef', 'rightsRef', 'outputProfileRefs',
    ] as const;
    for (const field of requiredFields) {
      const missing = { ...spec } as Record<string, unknown>;
      delete missing[field];
      expect(ProductionSpecSchema.safeParse(missing).success, `missing ${field}`).toBe(false);
    }

    const ordered = ProductionSpecSchema.parse({
      ...spec,
      sceneRefs: ['scene/z', 'scene/a'],
      outputProfileRefs: ['profile/z', 'profile/a'],
    });
    expect(ordered.sceneRefs).toEqual(['scene/z', 'scene/a']);
    expect(ordered.outputProfileRefs).toEqual(['profile/z', 'profile/a']);
  });
  it('rejects unknown fields, wrong schemaVersion and empty ref lists', () => {
    expect(ProductionSpecSchema.safeParse({ ...spec, extra: 1 }).success).toBe(false);
    expect(ProductionSpecSchema.safeParse({ ...spec, schemaVersion: 'v2' }).success).toBe(false);
    expect(ProductionSpecSchema.safeParse({ ...spec, sceneRefs: [] }).success).toBe(false);
    expect(ProductionSpecSchema.safeParse({ ...spec, outputProfileRefs: [] }).success).toBe(false);
    expect(ProductionSpecSchema.safeParse({ ...spec, outputProfileRefs: [''] }).success).toBe(false);
    expect(ProductionSpecSchema.safeParse({ ...spec, outputProfileRefs: [ref, ref] }).success).toBe(false);
    expect(ProductionSpecSchema.safeParse({ ...spec, originClass: 'BOGUS' }).success).toBe(false);
    expect(ProductionSpecSchema.safeParse({ ...spec, tenantId: 'bad id!' }).success).toBe(false);
  });
  it('accepts only the closed, versioned PDP-1 scene-binding shape', () => {
    const scene = {
      schemaVersion: 'media.declarative.value.scene-binding.v1',
      sceneId: 'scene-1', sceneGraphRef: ref, animationGraphRef: ref,
      modelStateRefOrNull: null, sourceRefs: [ref], temporalMappingRef: ref,
      semanticAnchorRefs: ['anchor-1'], accessibilityRef: ref,
    };
    expect(SceneBindingSchema.safeParse(scene).success).toBe(true);
    const requiredFields = [
      'schemaVersion', 'sceneId', 'sceneGraphRef', 'animationGraphRef',
      'modelStateRefOrNull', 'sourceRefs', 'temporalMappingRef',
      'semanticAnchorRefs', 'accessibilityRef',
    ] as const;
    for (const field of requiredFields) {
      const missing = { ...scene } as Record<string, unknown>;
      delete missing[field];
      expect(SceneBindingSchema.safeParse(missing).success, `missing ${field}`).toBe(false);
    }
    expect(SceneBindingSchema.safeParse({ ...scene, extra: true }).success).toBe(false);
    expect(SceneBindingSchema.safeParse({ ...scene, sourceRefs: [] }).success).toBe(false);
    expect(SceneBindingSchema.safeParse({ ...scene, sourceRefs: [ref, ref] }).success).toBe(false);
    expect(SceneBindingSchema.safeParse({ ...scene, modelStateRefOrNull: ' ' }).success).toBe(false);
    expect(SceneBindingSchema.safeParse({ ...scene, semanticAnchorRefs: ['anchor-1', 'anchor-1'] }).success).toBe(false);
  });
  it('refuses cyclic and over-deep caller values before schema descent', () => {
    const cyclic = { ...spec } as Record<string, unknown>;
    cyclic.self = cyclic;
    expect(ProductionSpecSchema.safeParse(cyclic).success).toBe(false);

    let deeplyNested: unknown = null;
    for (let index = 0; index < 66; index++) deeplyNested = [deeplyNested];
    expect(ProductionSpecSchema.safeParse(deeplyNested).success).toBe(false);
  });
  it('rejects sparse or decorated arrays before Zod can iterate or ignore array properties', () => {
    expect(ProductionSpecSchema.safeParse({ ...spec, sceneRefs: new Array(100_001) }).success).toBe(false);
    expect(ProductionSpecSchema.safeParse({ ...spec, sceneRefs: new Array(1) }).success).toBe(false);

    const decoratedRefs = [ref] as string[] & { label?: string };
    decoratedRefs.label = 'metadata-not-in-json';
    expect(ProductionSpecSchema.safeParse({ ...spec, sceneRefs: decoratedRefs }).success).toBe(false);
  });
  it('turns throwing Proxy inspection traps into an ordinary parse failure', () => {
    const hostile = new Proxy(spec, {
      getPrototypeOf() { throw new Error('inspection trap'); },
    });
    expect(() => ProductionSpecSchema.safeParse(hostile).success).not.toThrow();
    expect(ProductionSpecSchema.safeParse(hostile).success).toBe(false);
  });
  it('rejects malformed UTF-16 references and accepts valid supplementary Unicode', () => {
    expect(ProductionSpecSchema.safeParse({ ...spec, purposeRef: 'purpose/\uD800' }).success).toBe(false);
    expect(ProductionSpecSchema.safeParse({ ...spec, sceneRefs: ['scene/\uDC00'] }).success).toBe(false);
    expect(ProductionSpecSchema.safeParse({ ...spec, purposeRef: 'purpose/🚀' }).success).toBe(true);
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
    expect(AnimationSpecSchema.safeParse({ ...anim, code: 'return fetch(...)' }).success).toBe(false);
    expect(AnimationSpecSchema.safeParse({ ...anim, shader: 'void main() {}' }).success).toBe(false);
  });
  it('requires exact positive integer seconds-per-tick and rejects numeric approximations', () => {
    const anim = {
      schemaVersion: 'media.declarative.value.animation-spec.v1',
      sceneGraphRef: ref, animationGraphRef: ref, operatorTreeRef: ref,
      assetsRef: ref, propertyCurveRefs: [], tStoryRef: storyClock, renderingRef: ref,
    };
    expect(AnimationSpecSchema.safeParse(anim).success).toBe(true);
    expect(AnimationSpecSchema.safeParse({
      ...anim,
      tStoryRef: { ...storyClock, timeBase: { numerator: 1, denominator: '90000' } },
    }).success).toBe(false);
    expect(AnimationSpecSchema.safeParse({
      ...anim,
      tStoryRef: { ...storyClock, timeBase: { numerator: '0', denominator: '90000' } },
    }).success).toBe(false);
    expect(AnimationSpecSchema.safeParse({
      ...anim,
      tStoryRef: { ...storyClock, timeBase: { numerator: '1', denominator: '0' } },
    }).success).toBe(false);
    expect(AnimationSpecSchema.safeParse({
      ...anim,
      tStoryRef: { ...storyClock, timeBase: { numerator: '9223372036854775808', denominator: '90000' } },
    }).success).toBe(false);
  });
  it('preserves exact int64 as canonical decimal strings — never a number', () => {
    expect(SignedInt64DecimalSchema.safeParse('-9223372036854775808').success).toBe(true);
    expect(SignedInt64DecimalSchema.safeParse('9223372036854775807').success).toBe(true);
    expect(SignedInt64DecimalSchema.safeParse('-9007199254740993').success).toBe(true);
    expect(SignedInt64DecimalSchema.safeParse('-9223372036854775809').success).toBe(false);
    expect(SignedInt64DecimalSchema.safeParse('9223372036854775808').success).toBe(false);
    expect(SignedInt64DecimalSchema.safeParse('9'.repeat(100_000)).success).toBe(false);
    expect(SignedInt64DecimalSchema.safeParse(9223372036854775807).success).toBe(false);
    expect(SignedInt64DecimalSchema.safeParse('1.5e10').success).toBe(false);
    expect(SignedInt64DecimalSchema.safeParse('00').success).toBe(false);
    expect(PositiveInt64DecimalSchema.safeParse('9223372036854775807').success).toBe(true);
    expect(PositiveInt64DecimalSchema.safeParse('9223372036854775808').success).toBe(false);
    expect(PositiveInt64DecimalSchema.safeParse('9'.repeat(100_000)).success).toBe(false);
    expect(PositiveInt64DecimalSchema.safeParse('0').success).toBe(false);
  });
  it('accepts exact positive resource bounds through MAX_SAFE_INTEGER and rejects precision loss', () => {
    const bounds = {
      stepLimit: Number.MAX_SAFE_INTEGER,
      wallClockBudgetMs: 1,
      memoryBudgetBytes: 1,
      workloadLimit: 1,
      recursionLimit: 1,
    };
    expect(ResourceBoundsSchema.parse(bounds).stepLimit).toBe(Number.MAX_SAFE_INTEGER);
    expect(ResourceBoundsSchema.safeParse({ ...bounds, stepLimit: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    expect(ResourceBoundsSchema.safeParse({ ...bounds, stepLimit: 1.5 }).success).toBe(false);
  });
  const execSpec = {
    schemaVersion: 'media.declarative.value.model-execution-spec.v1',
    modelFamilyRef: 'media.simulation.agent', modelVersionRef: ref,
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
  it('rejects a model family that is not an exact PDP-1 simulation capability leaf', () => {
    expect(ModelExecutionSpecSchema.safeParse({
      ...execSpec, modelFamilyRef: 'media.simulation',
    }).success).toBe(false);
    expect(ModelExecutionSpecSchema.safeParse({
      ...execSpec, modelFamilyRef: 'media.simulation.unregistered',
    }).success).toBe(false);
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
    const { modelDigest: _modelDigest, ...withoutModelDigest } = execSpec;
    expect(ModelExecutionSpecSchema.safeParse(withoutModelDigest).success).toBe(false);
  });
  it('simulation state rejects unbounded or wrong-version checkpoints', () => {
    const state = {
      schemaVersion: 'media.declarative.value.simulation-state.v1',
      runId: 'run-1', attemptId: 'att-1', modelFamilyRef: 'media.simulation.agent', modelVersionRef: ref,
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
