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
const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;

// The PDP-1 contract requires recursion and workload bounds, but this typed
// value context does not define per-value limits. Use a conservative parser
// ceiling before Zod descends into caller-owned objects so hostile or
// accidentally cyclic in-memory values cannot exhaust the parser stack.
const MAX_TYPED_VALUE_DEPTH = 64;
const MAX_TYPED_VALUE_NODES = 100_000;

function isBoundedJsonValue(root: unknown): boolean {
  const active = new WeakSet<object>();
  const complete = new WeakSet<object>();
  const stack: Array<{ value: unknown; depth: number; leaving?: object }> = [
    { value: root, depth: 0 },
  ];
  let visited = 0;

  while (stack.length > 0) {
    const item = stack.pop()!;
    if (item.leaving) {
      active.delete(item.leaving);
      complete.add(item.leaving);
      continue;
    }
    if (++visited > MAX_TYPED_VALUE_NODES || item.depth > MAX_TYPED_VALUE_DEPTH) return false;

    const value = item.value;
    if (value === null || typeof value === "string" || typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return false;
      continue;
    }
    if (typeof value !== "object") return false;
    if (active.has(value)) return false;
    if (complete.has(value)) continue;

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length > 0) return false;
    if (Array.isArray(value)) {
      const lengthDescriptor = descriptors.length;
      if (!lengthDescriptor || !("value" in lengthDescriptor)
          || !Number.isSafeInteger(lengthDescriptor.value)
          || lengthDescriptor.value < 0
          || lengthDescriptor.value > MAX_TYPED_VALUE_NODES - visited) return false;
      const indexKeys = Object.keys(descriptors).filter((key) => key !== "length");
      // JSON arrays are dense and have no custom own properties. Besides
      // rejecting holes and metadata Zod would ignore, the length check keeps
      // a huge sparse array from making Zod iterate an attacker-sized range.
      if (indexKeys.length !== lengthDescriptor.value) return false;
      for (const key of indexKeys) {
        if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= lengthDescriptor.value) return false;
      }
    }
    const children: unknown[] = [];
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(value) && key === "length") continue;
      if (!("value" in descriptor) || !descriptor.enumerable) return false;
      children.push(descriptor.value);
    }

    active.add(value);
    stack.push({ value: undefined, depth: item.depth, leaving: value });
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push({ value: children[index], depth: item.depth + 1 });
    }
  }
  return true;
}

function boundedTypedValue<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => {
    try {
      return isBoundedJsonValue(value) ? value : undefined;
    } catch {
      // Proxy traps and exotic caller objects are not JSON values. Keep their
      // inspection failures inside Zod's normal invalid-input result path.
      return undefined;
    }
  }, schema);
}

export const OpaqueIdSchema = z.string().min(1).max(128).regex(OPAQUE_ID_RE);
/** Opaque versioned reference — never a raw URI to fetch; it names a stored revision. */
function hasWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return false;
      index++;
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      return false;
    }
  }
  return true;
}
export const VersionRefSchema = z.string().min(1).max(384).regex(/^\S+$/)
  .refine(hasWellFormedUtf16, "must contain well-formed Unicode");
export const NullableVersionRefSchema = VersionRefSchema.nullable();
export const VersionRefListSchema = z.array(VersionRefSchema).refine(
  (list) => new Set(list).size === list.length,
  { message: "duplicate versioned references" },
);
export const NonEmptyVersionRefListSchema = VersionRefListSchema.min(1);

/** Canonical int64 text preserves exact 64-bit values — never a JS number. */
export const SignedInt64DecimalSchema = z.string().refine((value) => {
  if (value.length > 20 || !SIGNED_INT64_DECIMAL_RE.test(value)) return false;
  const integer = BigInt(value);
  return integer >= INT64_MIN && integer <= INT64_MAX;
}, "must be a canonical signed int64 decimal");
export const PositiveInt64DecimalSchema = z.string().refine((value) => {
  if (value.length > 19 || !POSITIVE_INT64_DECIMAL_RE.test(value)) return false;
  return BigInt(value) <= INT64_MAX;
}, "must be a canonical positive int64 decimal");

export const DigestSchema = z.object({
  algorithmRef: VersionRefSchema,
  value: z.string().min(1).max(384).regex(/^\S+$/),
  subjectVersionRef: VersionRefSchema,
}).strict();

// PDP-1 declares positive integer resource bounds but leaves their maximum
// unspecified. Preserve the JSON number wire shape and cap values at the
// largest integer JavaScript can represent exactly instead of accepting rounding.
const PositiveSafeIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const ResourceBoundsSchema = z.object({
  stepLimit: PositiveSafeIntegerSchema,
  wallClockBudgetMs: PositiveSafeIntegerSchema,
  memoryBudgetBytes: PositiveSafeIntegerSchema,
  workloadLimit: PositiveSafeIntegerSchema,
  recursionLimit: PositiveSafeIntegerSchema,
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
export const SimulationCapabilityLeafSchema = z.enum([
  "media.simulation.rigid-body", "media.simulation.soft-body", "media.simulation.cloth",
  "media.simulation.rope", "media.simulation.particle", "media.simulation.fluid",
  "media.simulation.smoke", "media.simulation.fire", "media.simulation.collision",
  "media.simulation.constraint", "media.simulation.vehicle", "media.simulation.crowd",
  "media.simulation.agent", "media.simulation.human-motion", "media.simulation.procedural-world",
  "media.simulation.camera-experiment", "media.simulation.lighting-experiment",
  "media.simulation.educational-demo", "media.simulation.scientific-demo", "media.simulation.robotics",
  "media.simulation.kinematics", "media.simulation.synthetic-data",
]);
export const FamilyQualificationStateSchema = z.enum(["QUALIFIED", "UNQUALIFIED", "UNKNOWN"]);
export const ReplayabilitySchema = z.enum(["REPLAYABLE", "NON_REPLAYABLE", "UNKNOWN"]);

export const ProductionSpecSchema = boundedTypedValue(z.object({
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
}).strict());
export type ProductionSpec = z.infer<typeof ProductionSpecSchema>;

export const SceneBindingSchema = boundedTypedValue(z.object({
  sceneId: OpaqueIdSchema,
  sceneGraphRef: VersionRefSchema,
  animationGraphRef: VersionRefSchema,
  modelStateRefOrNull: NullableVersionRefSchema,
  sourceRefs: NonEmptyVersionRefListSchema,
  temporalMappingRef: VersionRefSchema,
  semanticAnchorRefs: VersionRefListSchema,
  accessibilityRef: VersionRefSchema,
}).strict());
export type SceneBinding = z.infer<typeof SceneBindingSchema>;

export const AnimationSpecSchema = boundedTypedValue(z.object({
  schemaVersion: z.literal("media.declarative.value.animation-spec.v1"),
  sceneGraphRef: VersionRefSchema,
  animationGraphRef: VersionRefSchema,
  operatorTreeRef: VersionRefSchema,
  assetsRef: VersionRefSchema,
  propertyCurveRefs: VersionRefListSchema,
  tStoryRef: StoryTimeSchema,
  renderingRef: VersionRefSchema,
}).strict());
export type AnimationSpec = z.infer<typeof AnimationSpecSchema>;

export const ModelExecutionSpecSchema = boundedTypedValue(z.object({
  schemaVersion: z.literal("media.declarative.value.model-execution-spec.v1"),
  modelFamilyRef: SimulationCapabilityLeafSchema,
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
}));
export type ModelExecutionSpec = z.infer<typeof ModelExecutionSpecSchema>;

export const SimulationStateSchema = boundedTypedValue(z.object({
  runId: OpaqueIdSchema,
  attemptId: OpaqueIdSchema,
  modelFamilyRef: SimulationCapabilityLeafSchema,
  modelVersionRef: VersionRefSchema,
  familyApplicability: FamilyApplicabilitySchema,
  familyQualificationRef: VersionRefSchema,
  replayability: ReplayabilitySchema,
  solverVersionRef: VersionRefSchema,
  tSimTicks: SignedInt64DecimalSchema,
  // The owning schema declares a JSON integer with minimum 0, not an int64
  // decimal string. Cap at JS's exact integer range to avoid accepting a value
  // that has already been rounded by JSON/number parsing.
  stepIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  stateVersion: VersionRefSchema,
  stateDigest: DigestSchema,
  parameterDigest: DigestSchema,
  rngStateOrNull: NullableVersionRefSchema,
  randomnessSemantics: RandomnessSemanticsSchema,
  checkpointParentRefOrNull: NullableVersionRefSchema,
}).strict());
export type SimulationState = z.infer<typeof SimulationStateSchema>;
