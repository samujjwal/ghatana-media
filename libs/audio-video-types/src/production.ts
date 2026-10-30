/**
 * Typed headless declarative-production parsers (TY-04).
 *
 * Parsers for the PDP-1 `declarative-production-contracts.yaml` closed,
 * versioned value objects — production-spec, scene-binding, animation-spec,
 * model-execution-spec and simulation-state. Field shapes mirror the
 * declared `$defs` exactly: bounded identifiers, opaque versioned references,
 * canonical int64 decimal *strings* (no binary float rounding), strict
 * objects and closed enums. Every value declares
 * `runtimeAdmission: NOT_ADMITTED` upstream — these schemas validate the
 * wire shape only and admit nothing.
 */
import { z } from "zod";

const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SIGNED_INT64_DECIMAL_RE = /^(0|-[1-9][0-9]*|[1-9][0-9]*)$/;
const POSITIVE_INT64_DECIMAL_RE = /^[1-9][0-9]*$/;

export const OpaqueIdSchema = z.string().min(1).max(128).regex(OPAQUE_ID_RE);
/** Opaque versioned reference — never a raw URI to fetch; it names a stored revision. */
export const VersionRefSchema = z.string().min(1).max(384).regex(/^\S+$/);
export const NullableVersionRefSchema = VersionRefSchema.nullable();
export const VersionRefListSchema = z.array(VersionRefSchema).refine(
  (list) => new Set(list).size === list.length,
  { message: "duplicate versioned references" },
);
export const NonEmptyVersionRefListSchema = VersionRefListSchema.min(1);

/** Canonical int64 text preserves exact 64-bit values — never a JS number. */
export const SignedInt64DecimalSchema = z.string().regex(SIGNED_INT64_DECIMAL_RE);
export const PositiveInt64DecimalSchema = z.string().regex(POSITIVE_INT64_DECIMAL_RE);

export const DigestSchema = z.object({
  algorithmRef: VersionRefSchema,
  value: z.string().min(1).max(384).regex(/^\S+$/),
  subjectVersionRef: VersionRefSchema,
}).strict();

export const ResourceBoundsSchema = z.object({
  stepLimit: z.number().int().min(1),
  wallClockBudgetMs: z.number().int().min(1),
  memoryBudgetBytes: z.number().int().min(1),
  workloadLimit: z.number().int().min(1),
  recursionLimit: z.number().int().min(1),
}).strict();

export const PositiveRationalSchema = z.object({
  numerator: PositiveInt64DecimalSchema,
  denominator: PositiveInt64DecimalSchema,
}).strict();

const LogicalClockSchema = z.object({
  clockId: OpaqueIdSchema,
  streamId: OpaqueIdSchema,
  originRef: VersionRefSchema,
  ticks: SignedInt64DecimalSchema,
  timeBase: PositiveRationalSchema,
}).strict();

/** Story clock — clockKind is fixed; the wrong clock is a parse error, not a variant. */
export const StoryTimeSchema = LogicalClockSchema.extend({ clockKind: z.literal("story") }).strict();
/** Simulation clock — exact ticks + rational time base, never wall-clock or floats. */
export const SimulationTimeSchema = LogicalClockSchema.extend({ clockKind: z.literal("simulation") }).strict();

export const FamilyApplicabilitySchema = z.discriminatedUnion("applicability", [
  z.object({ applicability: z.literal("ADMITTED"), evidenceRefs: NonEmptyVersionRefListSchema }).strict(),
  z.object({ applicability: z.literal("NOT_ADMITTED"), evidenceRefs: VersionRefListSchema }).strict(),
  z.object({ applicability: z.literal("UNKNOWN"), evidenceRefs: VersionRefListSchema }).strict(),
]);

export const RandomnessSemanticsSchema = z.discriminatedUnion("disposition", [
  z.object({
    disposition: z.literal("SPECIFIED"),
    prngAlgorithmVersionRef: VersionRefSchema,
    prngImplementationVersionRef: VersionRefSchema,
    randomStreamVersionRef: VersionRefSchema,
    seedPolicyVersionRef: VersionRefSchema,
    seedMaterialVersionRef: VersionRefSchema,
    checkpointStateFormatVersionRef: VersionRefSchema,
    checkpointStateVersionRefs: VersionRefListSchema,
  }).strict(),
  z.object({
    disposition: z.literal("NOT_APPLICABLE"),
    nonStochasticDeclarationVersionRef: VersionRefSchema,
    reason: z.string().min(1).max(512).regex(/^\S+$/),
  }).strict(),
  z.object({
    disposition: z.literal("UNKNOWN"),
    reason: z.string().min(1).max(512).regex(/^\S+$/),
  }).strict(),
]);

export const OriginClassSchema = z.enum([
  "REAL_CAPTURE", "DECLARATIVE_ANIMATION", "MODEL_SIMULATION",
  "GENERATIVE_MEDIA", "PDP_SYNTHETIC_FIXTURE",
]);
export const FamilyQualificationStateSchema = z.enum(["QUALIFIED", "UNQUALIFIED", "UNKNOWN"]);
export const ReplayabilitySchema = z.enum(["REPLAYABLE", "NON_REPLAYABLE", "UNKNOWN"]);

export const ProductionSpecSchema = z.object({
  tenantId: OpaqueIdSchema,
  projectId: OpaqueIdSchema,
  revisionId: OpaqueIdSchema,
  schemaVersion: z.literal("media.declarative.value.production-spec.v1"),
  originClass: OriginClassSchema,
  purposeRef: VersionRefSchema,
  sceneRefs: NonEmptyVersionRefListSchema,
  timelineRef: VersionRefSchema,
  rightsRef: VersionRefSchema,
  outputProfileRefs: NonEmptyVersionRefListSchema,
}).strict();
export type ProductionSpec = z.infer<typeof ProductionSpecSchema>;

export const SceneBindingSchema = z.object({
  schemaVersion: z.literal("media.declarative.value.scene-binding.v1"),
  sceneId: OpaqueIdSchema,
  sceneGraphRef: VersionRefSchema,
  animationGraphRef: VersionRefSchema,
  modelStateRefOrNull: NullableVersionRefSchema,
  sourceRefs: NonEmptyVersionRefListSchema,
  temporalMappingRef: VersionRefSchema,
  semanticAnchorRefs: VersionRefListSchema,
  accessibilityRef: VersionRefSchema,
}).strict();
export type SceneBinding = z.infer<typeof SceneBindingSchema>;

export const AnimationSpecSchema = z.object({
  schemaVersion: z.literal("media.declarative.value.animation-spec.v1"),
  sceneGraphRef: VersionRefSchema,
  animationGraphRef: VersionRefSchema,
  operatorTreeRef: VersionRefSchema,
  assetsRef: VersionRefSchema,
  propertyCurveRefs: VersionRefListSchema,
  tStoryRef: StoryTimeSchema,
  renderingRef: VersionRefSchema,
}).strict();
export type AnimationSpec = z.infer<typeof AnimationSpecSchema>;

export const ModelExecutionSpecSchema = z.object({
  schemaVersion: z.literal("media.declarative.value.model-execution-spec.v1"),
  modelFamilyRef: VersionRefSchema,
  modelVersionRef: VersionRefSchema,
  familyApplicability: FamilyApplicabilitySchema,
  familyQualificationRef: VersionRefSchema,
  familyQualificationState: FamilyQualificationStateSchema,
  replayability: ReplayabilitySchema,
  modelDigest: DigestSchema,
  declaredAssumptionsRef: VersionRefSchema,
  solverId: OpaqueIdSchema,
  solverVersion: z.string().min(1).max(128).regex(/^\S+$/),
  solverBuildDigest: DigestSchema,
  numericPrecision: z.string().min(1).max(128).regex(/^\S+$/),
  initialConditionsRef: VersionRefSchema,
  boundaryConditionsRef: VersionRefSchema,
  unitsRegistryRef: VersionRefSchema,
  parameterRevisionRef: VersionRefSchema,
  tSimClockRef: SimulationTimeSchema,
  stepPolicy: VersionRefSchema,
  toleranceContractRef: VersionRefSchema,
  fidelityProfileRef: VersionRefSchema,
  resourceBounds: ResourceBoundsSchema,
  seedPolicy: VersionRefSchema,
  randomnessSemantics: RandomnessSemanticsSchema,
  distributionRef: VersionRefSchema,
  samplingConditionsRef: VersionRefSchema,
  samplingPlanRef: VersionRefSchema,
}).strict().superRefine((spec, ctx) => {
  // Declared invariant: UNKNOWN randomness semantics can never claim REPLAYABLE.
  if (spec.randomnessSemantics.disposition === "UNKNOWN"
      && spec.replayability === "REPLAYABLE") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "randomnessSemantics UNKNOWN cannot claim REPLAYABLE",
      path: ["replayability"],
    });
  }
});
export type ModelExecutionSpec = z.infer<typeof ModelExecutionSpecSchema>;

export const SimulationStateSchema = z.object({
  schemaVersion: z.literal("media.declarative.value.simulation-state.v1"),
  runId: OpaqueIdSchema,
  attemptId: OpaqueIdSchema,
  modelFamilyRef: VersionRefSchema,
  modelVersionRef: VersionRefSchema,
  familyApplicability: FamilyApplicabilitySchema,
  familyQualificationRef: VersionRefSchema,
  replayability: ReplayabilitySchema,
  solverVersionRef: VersionRefSchema,
  tSimTicks: SignedInt64DecimalSchema,
  stepIndex: SignedInt64DecimalSchema,
  stateVersion: OpaqueIdSchema,
  stateDigest: DigestSchema,
  parameterDigest: DigestSchema,
  rngStateOrNull: NullableVersionRefSchema,
  randomnessSemantics: RandomnessSemanticsSchema,
  checkpointParentRefOrNull: NullableVersionRefSchema,
}).strict();
export type SimulationState = z.infer<typeof SimulationStateSchema>;
