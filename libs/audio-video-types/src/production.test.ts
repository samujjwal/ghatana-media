import { describe, it, expect } from 'vitest';
import {
  ProductionSpecSchema, SceneBindingSchema, AnimationSpecSchema,
  ModelExecutionSpecSchema, SimulationStateSchema, MeasurementSchema, CaptureSourceKindSchema, SignedInt64DecimalSchema,
  PositiveInt64DecimalSchema, ResourceBoundsSchema, StoryTimeSchema, VersionRefSchema, DigestSchema,
  ActiveSpeakerCutProposalSchema, ValidationReportSchema, ClockAlignmentSchema,
  PublicAefBridgeSchema, SourceClassificationSchema,
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
  it('exposes only the explicitly declared recorder capture source kinds', () => {
    const sourceKinds = ['browser', 'desktop', 'mobile', 'terminal', 'http-api', 'grpc-api', 'camera', 'media-file'];
    expect(CaptureSourceKindSchema.options).toEqual(sourceKinds);
    for (const sourceKind of sourceKinds) {
      expect(CaptureSourceKindSchema.safeParse(sourceKind).success).toBe(true);
    }
    expect(CaptureSourceKindSchema.safeParse('unknown-source').success).toBe(false);
    expect(CaptureSourceKindSchema.safeParse('Browser').success).toBe(false);
  });

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
  it('accepts only the closed PDP-1 scene-binding shape', () => {
    const scene = {
      sceneId: 'scene-1', sceneGraphRef: ref, animationGraphRef: ref,
      modelStateRefOrNull: null, sourceRefs: [ref], temporalMappingRef: ref,
      semanticAnchorRefs: ['anchor-1'], accessibilityRef: ref,
    };
    expect(SceneBindingSchema.safeParse(scene).success).toBe(true);
    const requiredFields = [
      'sceneId', 'sceneGraphRef', 'animationGraphRef',
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
    // PDP-1 defines semanticAnchorRefs as opaqueIdList, not versionRefList.
    expect(SceneBindingSchema.safeParse({ ...scene, semanticAnchorRefs: ['anchor/1'] }).success).toBe(false);
    expect(SceneBindingSchema.safeParse({ ...scene, semanticAnchorRefs: ['anchor 1'] }).success).toBe(false);
    expect(SceneBindingSchema.safeParse({ ...scene, semanticAnchorRefs: ['🚀'] }).success).toBe(false);
    expect(SceneBindingSchema.safeParse({ ...scene, schemaVersion: 'media.declarative.value.scene-binding.v1' }).success).toBe(false);
  });
  it('refuses cyclic and over-deep caller values before schema descent', () => {
    const cyclic = { ...spec } as Record<string, unknown>;
    cyclic.self = cyclic;
    expect(ProductionSpecSchema.safeParse(cyclic).success).toBe(false);

    let deeplyNested: unknown = null;
    for (let index = 0; index < 66; index++) deeplyNested = [deeplyNested];
    expect(ProductionSpecSchema.safeParse(deeplyNested).success).toBe(false);
  });
  it('bounds nested caller values for scene bindings as well', () => {
    let deeplyNested: unknown = null;
    for (let index = 0; index < 66; index++) deeplyNested = [deeplyNested];
    expect(SceneBindingSchema.safeParse(deeplyNested).success).toBe(false);
  });
  it('bounds recursive JSON values for animation and model execution specs', () => {
    let deeplyNested: unknown = null;
    for (let index = 0; index < 66; index++) deeplyNested = [deeplyNested];
    expect(AnimationSpecSchema.safeParse(deeplyNested).success).toBe(false);
    expect(ModelExecutionSpecSchema.safeParse(deeplyNested).success).toBe(false);
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
  it('counts version reference maximum length by Unicode code point', () => {
    expect(VersionRefSchema.safeParse('🚀'.repeat(384)).success).toBe(true);
    expect(VersionRefSchema.safeParse('🚀'.repeat(385)).success).toBe(false);
    for (const whitespace of [' ', '\t', '\n', '\u00A0', '\u3000', '\uFEFF']) {
      expect(VersionRefSchema.safeParse(`reference/${whitespace}v1`).success).toBe(false);
    }
    expect(VersionRefSchema.safeParse('reference/\u0085\u001Cv1').success).toBe(true);
  });
  it('counts digest values by Unicode code point and rejects malformed UTF-16', () => {
    const digest = { algorithmRef: ref, value: '🚀'.repeat(384), subjectVersionRef: ref };
    expect(DigestSchema.safeParse(digest).success).toBe(true);
    expect(DigestSchema.safeParse({ ...digest, value: `${digest.value}🚀` }).success).toBe(false);
    expect(DigestSchema.safeParse({ ...digest, value: 'digest/\uD800' }).success).toBe(false);
    for (const whitespace of [' ', '\t', '\n', '\u00A0', '\u3000', '\uFEFF']) {
      expect(DigestSchema.safeParse({ ...digest, value: `digest/${whitespace}v1` }).success).toBe(false);
    }
    expect(DigestSchema.safeParse({ ...digest, value: 'digest/\u0085\u001Cv1' }).success).toBe(true);
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
  it('requires every declared animation-spec field and rejects unknown fields', () => {
    const animation = {
      schemaVersion: 'media.declarative.value.animation-spec.v1',
      sceneGraphRef: ref, animationGraphRef: ref, operatorTreeRef: ref,
      assetsRef: ref, propertyCurveRefs: [], tStoryRef: storyClock, renderingRef: ref,
    };
    for (const field of Object.keys(animation)) {
      const missing = { ...animation } as Record<string, unknown>;
      delete missing[field];
      expect(AnimationSpecSchema.safeParse(missing).success, `missing ${field}`).toBe(false);
    }
    expect(AnimationSpecSchema.safeParse({ ...animation, extra: true }).success).toBe(false);
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
  it('requires every declared model-execution-spec field', () => {
    for (const field of Object.keys(execSpec)) {
      const missing = { ...execSpec } as Record<string, unknown>;
      delete missing[field];
      expect(ModelExecutionSpecSchema.safeParse(missing).success, `missing ${field}`).toBe(false);
    }
    expect(ModelExecutionSpecSchema.safeParse({ ...execSpec, schemaVersion: 'media.declarative.value.model-execution-spec.v1' }).success).toBe(false);
  });
  it('matches PDP-1 numeric precision pattern without inventing token semantics', () => {
    expect(ModelExecutionSpecSchema.safeParse({ ...execSpec, numericPrecision: 'decimal 128' }).success).toBe(true);
    expect(ModelExecutionSpecSchema.safeParse({ ...execSpec, numericPrecision: '   ' }).success).toBe(false);
    expect(ModelExecutionSpecSchema.safeParse({ ...execSpec, numericPrecision: 'p'.repeat(129) }).success).toBe(false);
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
  it('requires the source-declared unit registry and both model and solver digests', () => {
    const { unitsRegistryRef: _unitsRegistryRef, ...withoutUnitsRegistry } = execSpec;
    expect(ModelExecutionSpecSchema.safeParse(withoutUnitsRegistry).success).toBe(false);
    expect(ModelExecutionSpecSchema.safeParse({ ...execSpec, unitsRegistryRef: '' }).success).toBe(false);
    // PDP-1 requires a typed unit registry; malformed references must not
    // satisfy this required reference field.
    expect(ModelExecutionSpecSchema.safeParse({ ...execSpec, unitsRegistryRef: '   ' }).success).toBe(false);
    expect(ModelExecutionSpecSchema.safeParse({ ...execSpec, unitsRegistryRef: 'unit registry/v1' }).success).toBe(false);

    const { solverBuildDigest: _solverBuildDigest, ...withoutSolverDigest } = execSpec;
    expect(ModelExecutionSpecSchema.safeParse(withoutSolverDigest).success).toBe(false);
    expect(ModelExecutionSpecSchema.safeParse({
      ...execSpec,
      modelDigest: { ...execSpec.modelDigest, value: '' },
    }).success).toBe(false);
    expect(ModelExecutionSpecSchema.safeParse({
      ...execSpec,
      solverBuildDigest: { ...execSpec.solverBuildDigest, value: '' },
    }).success).toBe(false);
  });
  it('validates solverVersion with the source-declared versionRef format', () => {
    expect(ModelExecutionSpecSchema.safeParse({ ...execSpec, solverVersion: 'solver/\uD800' }).success).toBe(false);
    expect(ModelExecutionSpecSchema.safeParse({ ...execSpec, solverVersion: 'solver/version 2' }).success).toBe(false);
    expect(ModelExecutionSpecSchema.safeParse({ ...execSpec, solverVersion: '🚀'.repeat(385) }).success).toBe(false);
    expect(ModelExecutionSpecSchema.safeParse({ ...execSpec, solverVersion: 'solver/🚀-v2' }).success).toBe(true);
  });
  it('requires finite positive recursion bounds', () => {
    expect(ModelExecutionSpecSchema.safeParse({
      ...execSpec,
      resourceBounds: { ...execSpec.resourceBounds, recursionLimit: 1 },
    }).success).toBe(true);
    for (const recursionLimit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(ModelExecutionSpecSchema.safeParse({
        ...execSpec,
        resourceBounds: { ...execSpec.resourceBounds, recursionLimit },
      }).success, `recursionLimit ${recursionLimit}`).toBe(false);
    }
  });
  it('keeps executable code, shaders, and untyped parameter bags outside closed specs', () => {
    const animation = {
      schemaVersion: 'media.declarative.value.animation-spec.v1',
      sceneGraphRef: ref, animationGraphRef: ref, operatorTreeRef: ref,
      assetsRef: ref, propertyCurveRefs: [], tStoryRef: storyClock, renderingRef: ref,
    };
    for (const unsafeField of [
      { code: 'return fetch(...)' },
      { shader: 'void main() {}' },
      { parameters: { expression: 'process.exit(1)' } },
    ]) {
      expect(AnimationSpecSchema.safeParse({ ...animation, ...unsafeField }).success).toBe(false);
      expect(ModelExecutionSpecSchema.safeParse({ ...execSpec, ...unsafeField }).success).toBe(false);
    }
  });
  it('simulation state rejects unbounded or wrong-version checkpoints', () => {
    const state = {
      runId: 'run-1', attemptId: 'att-1', modelFamilyRef: 'media.simulation.agent', modelVersionRef: ref,
      familyApplicability: { applicability: 'UNKNOWN', evidenceRefs: [] },
      familyQualificationRef: ref, replayability: 'UNKNOWN', solverVersionRef: ref,
      tSimTicks: '42', stepIndex: 7, stateVersion: 'state/v1',
      stateDigest: { algorithmRef: ref, value: 'sha256:s', subjectVersionRef: ref },
      parameterDigest: { algorithmRef: ref, value: 'sha256:p', subjectVersionRef: ref },
      rngStateOrNull: null,
      randomnessSemantics: { disposition: 'NOT_APPLICABLE', nonStochasticDeclarationVersionRef: ref, reason: 'deterministic' },
      checkpointParentRefOrNull: null,
    };
    expect(SimulationStateSchema.safeParse(state).success).toBe(true);
    expect(SimulationStateSchema.safeParse({ ...state, tSimTicks: 'abc' }).success).toBe(false);
    expect(SimulationStateSchema.safeParse({ ...state, stepIndex: -1 }).success).toBe(false);
    expect(SimulationStateSchema.safeParse({ ...state, stepIndex: 1.5 }).success).toBe(false);
    expect(SimulationStateSchema.safeParse({ ...state, stepIndex: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    expect(SimulationStateSchema.safeParse({ ...state, stateVersion: ' ' }).success).toBe(false);
    expect(SimulationStateSchema.safeParse({ ...state, stateVersion: 'state/\uD800' }).success).toBe(false);
    expect(SimulationStateSchema.safeParse({ ...state, unknown: 1 }).success).toBe(false);
    expect(SimulationStateSchema.safeParse({ ...state, schemaVersion: 'media.declarative.value.simulation-state.v1' }).success).toBe(false);
    for (const field of Object.keys(state)) {
      const missing = { ...state } as Record<string, unknown>;
      delete missing[field];
      expect(SimulationStateSchema.safeParse(missing).success, `missing ${field}`).toBe(false);
    }
  });
  it('enforces PDP-1 checkpoint RNG-state consistency', () => {
    const state = {
      runId: 'run-1', attemptId: 'att-1', modelFamilyRef: 'media.simulation.agent', modelVersionRef: ref,
      familyApplicability: { applicability: 'UNKNOWN', evidenceRefs: [] },
      familyQualificationRef: ref, replayability: 'UNKNOWN', solverVersionRef: ref,
      tSimTicks: '42', stepIndex: 7, stateVersion: 'state/v1',
      stateDigest: { algorithmRef: ref, value: 'sha256:s', subjectVersionRef: ref },
      parameterDigest: { algorithmRef: ref, value: 'sha256:p', subjectVersionRef: ref },
      rngStateOrNull: ref,
      randomnessSemantics: { disposition: 'NOT_APPLICABLE', nonStochasticDeclarationVersionRef: ref, reason: 'deterministic' },
      checkpointParentRefOrNull: null,
    };
    expect(SimulationStateSchema.safeParse(state).success).toBe(false);
    expect(SimulationStateSchema.safeParse({ ...state, rngStateOrNull: null }).success).toBe(true);

    const specified = {
      ...state,
      randomnessSemantics: {
        disposition: 'SPECIFIED', prngAlgorithmVersionRef: ref,
        prngImplementationVersionRef: ref, randomStreamVersionRef: ref,
        seedPolicyVersionRef: ref, seedMaterialVersionRef: ref,
        checkpointStateFormatVersionRef: ref, checkpointStateVersionRefs: [ref],
      },
    };
    expect(SimulationStateSchema.safeParse({ ...specified, rngStateOrNull: null }).success).toBe(false);
    expect(SimulationStateSchema.safeParse(specified).success).toBe(true);

    const unknownRandomness = {
      ...state,
      rngStateOrNull: null,
      randomnessSemantics: { disposition: 'UNKNOWN', reason: 'checkpoint-rng-unknown' },
    };
    expect(SimulationStateSchema.safeParse({
      ...unknownRandomness, replayability: 'REPLAYABLE',
    }).success).toBe(false);
    // The parser preserves an unknown observation without treating it as a
    // replayability claim or making runtime admission decisions.
    expect(SimulationStateSchema.safeParse({
      ...unknownRandomness, replayability: 'UNKNOWN',
    }).success).toBe(true);
  });
  it('parses the closed PDP-1 measurement value and preserves exact reference formats', () => {
    const measurement = {
      observableId: 'observable-1',
      modelFamilyRef: 'media.simulation.agent',
      modelVersionRef: ref,
      familyApplicability: { applicability: 'ADMITTED', evidenceRefs: [ref] },
      familyQualificationRef: ref,
      familyQualificationState: 'QUALIFIED',
      modelRunRef: 'run/revision-7',
      stateVersion: 'checkpoint/revision-9',
      tSimSamplePoint: {
        clockKind: 'simulation', clockId: 'sim-clock', streamId: 'sim-stream',
        originRef: ref, ticks: '-9007199254740993',
        timeBase: { numerator: '1', denominator: '90000' },
      },
      numericValue: -12.5,
      unitId: 'unit-meter-per-second',
      coordinateFrameRefOrNull: null,
      instrumentRef: 'instrument/revision-2',
      calibrationRef: 'calibration/revision-3',
      uncertaintyRef: 'uncertainty/revision-1',
      confidenceBoundsRefOrNull: null,
      validityDomainRef: 'validity/revision-4',
      provenanceRef: 'provenance/revision-5',
    };
    expect(MeasurementSchema.safeParse(measurement).success).toBe(true);
    for (const field of Object.keys(measurement)) {
      const missing = { ...measurement } as Record<string, unknown>;
      delete missing[field];
      expect(MeasurementSchema.safeParse(missing).success, `missing ${field}`).toBe(false);
    }
    expect(MeasurementSchema.safeParse({ ...measurement, unknown: true }).success).toBe(false);
    expect(MeasurementSchema.safeParse({ ...measurement, numericValue: '12.5' }).success).toBe(false);
    expect(MeasurementSchema.safeParse({ ...measurement, numericValue: Number.NaN }).success).toBe(false);
    expect(MeasurementSchema.safeParse({ ...measurement, numericValue: Number.POSITIVE_INFINITY }).success).toBe(false);
    const missingUnit = { ...measurement } as Record<string, unknown>;
    delete missingUnit.unitId;
    expect(MeasurementSchema.safeParse(missingUnit).success).toBe(false);
    expect(MeasurementSchema.safeParse({ ...measurement, unitId: 'unit/meter' }).success).toBe(false);
    expect(MeasurementSchema.safeParse({ ...measurement, modelRunRef: 'run revision-7' }).success).toBe(false);
    expect(MeasurementSchema.safeParse({
      ...measurement,
      tSimSamplePoint: { ...measurement.tSimSamplePoint, clockKind: 'story' },
    }).success).toBe(false);
    expect(MeasurementSchema.safeParse({
      ...measurement,
      tSimSamplePoint: { ...measurement.tSimSamplePoint, ticks: -9007199254740993 },
    }).success).toBe(false);
  });
  it('parses active-speaker proposals as bounded reviewable candidates only', () => {
    const proposal = {
      schemaVersion: 'media.declarative.value.active-speaker-cut-proposal.v1',
      proposalRef: ref, timelineRef: ref, sourceRevisionRef: ref,
      proposedCuts: [{
        cutRef: ref, storyTime: storyClock,
        speakerTurnEvidence: { evidenceClass: 'SPEAKER_TURN_OBSERVATION', evidenceRef: ref },
        cameraSourceEvidence: { evidenceClass: 'CAMERA_SOURCE_OBSERVATION', evidenceRef: ref },
        uncertaintyRef: ref,
      }],
      uncertaintyRef: ref,
      proposalDisposition: 'REVIEWABLE_LOCAL_CANDIDATE_NO_PROJECT_COMMIT',
    };
    expect(ActiveSpeakerCutProposalSchema.safeParse(proposal).success).toBe(true);
    for (const field of Object.keys(proposal)) {
      const missing = { ...proposal } as Record<string, unknown>;
      delete missing[field];
      expect(ActiveSpeakerCutProposalSchema.safeParse(missing).success, `missing ${field}`).toBe(false);
    }
    expect(ActiveSpeakerCutProposalSchema.safeParse({ ...proposal, proposedCuts: [] }).success).toBe(false);
    expect(ActiveSpeakerCutProposalSchema.safeParse({ ...proposal, projectRevisionRef: ref }).success).toBe(false);
    expect(ActiveSpeakerCutProposalSchema.safeParse({
      ...proposal,
      proposedCuts: [{ ...proposal.proposedCuts[0], speakerTurnEvidence: { evidenceClass: 'CAMERA_SOURCE_OBSERVATION', evidenceRef: ref } }],
    }).success).toBe(false);
    expect(ActiveSpeakerCutProposalSchema.safeParse({
      ...proposal,
      proposedCuts: [{ ...proposal.proposedCuts[0], speakerTurnEvidence: { evidenceClass: 'SPEAKER_TURN_OBSERVATION' } }],
    }).success).toBe(false);
    expect(ActiveSpeakerCutProposalSchema.safeParse({
      ...proposal,
      proposedCuts: [{ ...proposal.proposedCuts[0], cameraSourceEvidence: { evidenceClass: 'CAMERA_SOURCE_OBSERVATION' } }],
    }).success).toBe(false);
    expect(ActiveSpeakerCutProposalSchema.safeParse({
      ...proposal,
      proposedCuts: [{ ...proposal.proposedCuts[0], nestedUnknown: true }],
    }).success).toBe(false);
    expect(ActiveSpeakerCutProposalSchema.safeParse({
      ...proposal, proposedCuts: [{ ...proposal.proposedCuts[0], storyTime: { ...storyClock, clockKind: 'simulation' } }],
    }).success).toBe(false);
  });
  it('parses validation reports with source-defined verdict and applicability constraints', () => {
    const report = {
      modelFamilyRef: 'media.simulation.agent', modelVersionRef: ref,
      familyApplicability: { applicability: 'UNKNOWN', evidenceRefs: [] },
      familyQualificationRef: ref, familyQualificationState: 'UNKNOWN',
      solverBuildDigest: { algorithmRef: ref, value: 'sha256:solver', subjectVersionRef: ref },
      oracleRef: ref, expectedSamples: [ref], actualSamples: [ref],
      toleranceSpecRef: ref, residualStatisticsRef: ref,
      verdict: 'INCONCLUSIVE', applicability: 'NOT_EVALUATED',
      limitations: ['not evaluated'], environmentRef: ref,
    };
    expect(ValidationReportSchema.safeParse(report).success).toBe(true);
    for (const field of Object.keys(report)) {
      const missing = { ...report } as Record<string, unknown>;
      delete missing[field];
      expect(ValidationReportSchema.safeParse(missing).success, `missing ${field}`).toBe(false);
    }
    expect(ValidationReportSchema.safeParse({ ...report, verdict: 'PASS', applicability: 'BLOCKED' }).success).toBe(false);
    expect(ValidationReportSchema.safeParse({ ...report, verdict: 'PASS', applicability: 'NOT_APPLICABLE' }).success).toBe(false);
    expect(ValidationReportSchema.safeParse({ ...report, verdict: 'PASS', applicability: 'APPLICABLE' }).success).toBe(true);
    expect(ValidationReportSchema.safeParse({ ...report, limitations: [] }).success).toBe(false);
    expect(ValidationReportSchema.safeParse({ ...report, expectedSamples: [] }).success).toBe(false);
    expect(ValidationReportSchema.safeParse({
      ...report, solverBuildDigest: { algorithmRef: ref, value: 'sha256:solver', extra: true },
    }).success).toBe(false);
    expect(ValidationReportSchema.safeParse({ ...report, verdict: 'UNKNOWN' }).success).toBe(false);
    expect(ValidationReportSchema.safeParse({ ...report, extra: true }).success).toBe(false);
  });
  it('parses explicit clock mappings with exact signed offset and positive scale', () => {
    const alignment = {
      sourceClockId: 'clock-source', destClockId: 'clock-dest',
      sourceOriginRef: ref, destOriginRef: ref, mappingVersionRef: ref,
      rationalScale: { numerator: '2', denominator: '3' },
      rationalOffset: { numerator: '-1', denominator: '3' },
      lossAndRoundingRef: ref, uncertaintyRef: ref,
    };
    expect(ClockAlignmentSchema.safeParse(alignment).success).toBe(true);
    for (const field of Object.keys(alignment)) {
      const missing = { ...alignment } as Record<string, unknown>;
      delete missing[field];
      expect(ClockAlignmentSchema.safeParse(missing).success, `missing ${field}`).toBe(false);
    }
    expect(ClockAlignmentSchema.safeParse({ ...alignment, rationalScale: { numerator: '0', denominator: '3' } }).success).toBe(false);
    expect(ClockAlignmentSchema.safeParse({ ...alignment, rationalScale: { numerator: '2', denominator: '0' } }).success).toBe(false);
    expect(ClockAlignmentSchema.safeParse({ ...alignment, rationalOffset: { numerator: '9223372036854775808', denominator: '3' } }).success).toBe(false);
    expect(ClockAlignmentSchema.safeParse({ ...alignment, rationalOffset: { numerator: '-1', denominator: '-3' } }).success).toBe(false);
    expect(ClockAlignmentSchema.safeParse({ ...alignment, rationalScale: { numerator: '2' } }).success).toBe(false);
    expect(ClockAlignmentSchema.safeParse({ ...alignment, extra: true }).success).toBe(false);
  });
  it('parses the versioned public AEF bridge shape without asserting external authority', () => {
    const bridge = {
      contractVersion: ref, tutorPutorModelIrRef: ref,
      tutorPutorSceneIrRef: ref, tutorPutorExperienceIrRef: ref,
      supportedCapabilityRefs: ['media.animation.vector'], adapterVersion: ref,
      mediaProjectRevisionRef: ref,
    };
    expect(PublicAefBridgeSchema.safeParse(bridge).success).toBe(true);
    for (const field of Object.keys(bridge)) {
      const missing = { ...bridge } as Record<string, unknown>;
      delete missing[field];
      expect(PublicAefBridgeSchema.safeParse(missing).success, `missing ${field}`).toBe(false);
    }
    expect(PublicAefBridgeSchema.safeParse({ ...bridge, supportedCapabilityRefs: [] }).success).toBe(false);
    expect(PublicAefBridgeSchema.safeParse({ ...bridge, supportedCapabilityRefs: ['media.animation.vector', 'media.animation.vector'] }).success).toBe(false);
    expect(PublicAefBridgeSchema.safeParse({ ...bridge, supportedCapabilityRefs: ['media/animation'] }).success).toBe(false);
    expect(PublicAefBridgeSchema.safeParse({ ...bridge, extra: true }).success).toBe(false);
  });
  it('parses source classification as versioned provenance references only', () => {
    const classification = {
      originClass: 'REAL_CAPTURE', sourceVersionRef: ref,
      producingToolVersionRef: ref, consentRightsRef: ref, sourceClockRef: ref,
      runOrCaptureReceiptRef: ref,
      digest: { algorithmRef: ref, value: 'sha256:source', subjectVersionRef: ref },
      traceRefOrNull: null,
    };
    expect(SourceClassificationSchema.safeParse(classification).success).toBe(true);
    for (const field of Object.keys(classification)) {
      const missing = { ...classification } as Record<string, unknown>;
      delete missing[field];
      expect(SourceClassificationSchema.safeParse(missing).success, `missing ${field}`).toBe(false);
    }
    expect(SourceClassificationSchema.safeParse({ ...classification, originClass: 'UNKNOWN' }).success).toBe(false);
    expect(SourceClassificationSchema.safeParse({ ...classification, runOrCaptureReceiptRef: ' ' }).success).toBe(false);
    expect(SourceClassificationSchema.safeParse({ ...classification, digest: { ...classification.digest, extra: true } }).success).toBe(false);
    expect(SourceClassificationSchema.safeParse({
      ...classification, digest: { value: 'sha256:source', subjectVersionRef: ref },
    }).success).toBe(false);
    expect(SourceClassificationSchema.safeParse({ ...classification, extra: true }).success).toBe(false);
  });
});
