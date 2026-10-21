import type {
  ArtifactVerificationExperienceState,
  ArtifactVerificationState,
  ArtifactIntakeExperienceState,
  FirstUseExperienceState,
  FixtureId,
  OperationDefinitionFixture,
  MediaExperienceState,
  ScenarioId,
  StepBranchDefinitionFixture,
  StaleDraftRevisionDefinitionFixture,
  TimedTextSegment,
  TranscriptionExperienceState,
  VersionMismatchGuardDefinitionFixture,
} from "./model.js";

export interface OperationDefinitionFixtureInput {
  readonly fixtureId: string;
  readonly journeyRef: string;
  readonly stepRef: string;
  readonly actionRef: string;
  readonly capabilityRef: string | null;
  readonly operationRef: string;
  readonly requestSchemaRef: string;
  readonly resultSchemaRef: string;
  readonly requestSchema: Readonly<Record<string, unknown>>;
  readonly resultSchema: Readonly<Record<string, unknown>>;
}

export interface StepBranchDefinitionFixtureInput {
  readonly fixtureId: string;
  readonly sourceRef: string;
  readonly journeyRef: string;
  readonly stepRef: string;
  readonly branch: StepBranchDefinitionFixture["branch"];
  readonly case: string;
  readonly guardVerdict: StepBranchDefinitionFixture["guardVerdict"];
  readonly expectedDecision: string;
  readonly selectedCapabilityRef?: string;
  readonly selectedOperationRef?: string;
}

export interface VersionMismatchGuardDefinitionFixtureInput {
  readonly fixtureId: string;
  readonly sourceRef: string;
  readonly journeyRef: string;
  readonly stepRef: string;
  readonly versionDisposition: string;
  readonly versionBindingRule: string;
  readonly exactVersionTupleFields: readonly string[];
  readonly missingOrStaleDisposition: string;
}

export interface StaleDraftRevisionDefinitionFixtureInput {
  readonly fixtureId: string;
  readonly sourceRefs: readonly string[];
  readonly journeyRef: string;
  readonly stepRef: string;
  readonly operationRef: "media.operation.caption-draft-write";
  readonly requestSchemaRef: string;
  readonly requestSchema: DefinitionSchema;
}

type DefinitionSchema = Readonly<Record<string, unknown>>;

function syntheticString(schema: DefinitionSchema, path: string): string {
  if (typeof schema.const === "string") return schema.const;
  if (Array.isArray(schema.enum)) return String(schema.enum[0]);
  if (schema.format === "date-time") return "2026-01-01T00:00:00Z";
  if (schema.format === "uri") return "https://synthetic.invalid/definition-fixture";
  const pattern = typeof schema.pattern === "string" ? schema.pattern : "";
  if (pattern === "^sha256:[a-f0-9]{64}$") return `sha256:${"0".repeat(64)}`;
  const length = typeof schema.minLength === "number" ? schema.minLength : 1;
  const candidate = `synthetic-${path.replace(/[^A-Za-z0-9._:-]/gu, "-")}`;
  if (!pattern || new RegExp(pattern, "u").test(candidate)) return candidate.slice(0, Math.max(length, 1));
  for (const value of ["synthetic-1", "synthetic_id", "synthetic-reference", "2026-01-01T00:00:00Z", "0"]) {
    if (new RegExp(pattern, "u").test(value) && value.length >= length) return value;
  }
  return candidate;
}

function mergeObjectSchemas(schemas: readonly DefinitionSchema[]): DefinitionSchema {
  const properties: Record<string, unknown> = {};
  const required = new Set<string>();
  const mergeProperties = (next: unknown) => {
    if (!next || typeof next !== "object" || Array.isArray(next)) return;
    for (const [name, value] of Object.entries(next)) {
      const prior = properties[name];
      properties[name] = prior && value && typeof prior === "object" && typeof value === "object" && !Array.isArray(prior) && !Array.isArray(value)
        ? { ...prior, ...value }
        : value;
    }
  };
  for (const schema of schemas) {
    if (Array.isArray(schema.required)) for (const field of schema.required) if (typeof field === "string") required.add(field);
    mergeProperties(schema.properties);
    if (Array.isArray(schema.allOf)) {
      const nested = mergeObjectSchemas(schema.allOf.filter((item): item is DefinitionSchema => item !== null && typeof item === "object"));
      mergeProperties(nested.properties);
      if (Array.isArray(nested.required)) for (const field of nested.required) if (typeof field === "string") required.add(field);
    }
  }
  return { ...schemas[0], properties, required: [...required] };
}

function conditionMatches(condition: DefinitionSchema | undefined, value: Record<string, unknown>): boolean {
  const properties = condition?.properties as Record<string, DefinitionSchema> | undefined;
  if (!properties) return false;
  return Object.entries(properties).every(([key, expected]) => {
    if (expected.const !== undefined) return value[key] === expected.const;
    if (expected.properties && value[key] && typeof value[key] === "object" && !Array.isArray(value[key])) {
      return conditionMatches(expected, value[key] as Record<string, unknown>);
    }
    return true;
  });
}

function applySelectedSchemaRequirements(
  schema: DefinitionSchema,
  rootProperties: Record<string, DefinitionSchema>,
  value: Record<string, unknown>,
  path: string,
): void {
  const localProperties = (schema.properties as Record<string, DefinitionSchema> | undefined) ?? {};
  for (const name of (schema.required as string[] | undefined) ?? []) {
    if (value[name] !== undefined) continue;
    const property = rootProperties[name] ?? localProperties[name];
    if (!property) continue;
    value[name] = definitionSample(
      localProperties[name] ? { ...property, ...localProperties[name] } : property,
      `${path}-${name}`,
    );
  }

  for (const alternatives of [schema.anyOf, schema.oneOf]) {
    if (Array.isArray(alternatives) && alternatives.length > 0) {
      const selected = alternatives[0] as DefinitionSchema;
      applySelectedSchemaRequirements(selected, rootProperties, value, `${path}-choice`);
      break;
    }
  }

  for (const entry of (schema.allOf as DefinitionSchema[] | undefined) ?? []) {
    const condition = entry.if as DefinitionSchema | undefined;
    if (!conditionMatches(condition, value)) continue;
    const thenSchema = entry.then as DefinitionSchema | undefined;
    if (thenSchema) applySelectedSchemaRequirements(thenSchema, rootProperties, value, `${path}-then`);
  }
}

function definitionSample(schema: DefinitionSchema, path: string): unknown {
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  const alternatives = (schema.oneOf ?? schema.anyOf) as DefinitionSchema[] | undefined;
  if (alternatives?.length) return definitionSample(alternatives[0], `${path}-choice`);
  const type = schema.type;
  if (type === "object" || schema.properties) {
    const merged = mergeObjectSchemas([schema]);
    const properties = merged.properties as Record<string, DefinitionSchema>;
    const result: Record<string, unknown> = {};
    const required = new Set(merged.required as string[]);
    for (const name of required) {
      const property = properties[name];
      if (!property) continue;
      const conditionalSchemas = ((schema.allOf as DefinitionSchema[] | undefined) ?? [])
        .filter((entry) => conditionMatches(entry.if as DefinitionSchema | undefined, result))
        .map((entry) => entry.then as DefinitionSchema | undefined)
        .filter((entry): entry is DefinitionSchema => Boolean(entry?.properties));
      const conditionalProperty = conditionalSchemas.map((entry) => (entry.properties as Record<string, DefinitionSchema>)[name]).filter(Boolean);
      const effective = conditionalProperty.length
        ? Object.assign({}, property, ...conditionalProperty)
        : property;
      result[name] = definitionSample(effective, `${path}-${name}`);
    }
    for (const entry of (schema.allOf as DefinitionSchema[] | undefined) ?? []) {
      if (!conditionMatches(entry.if as DefinitionSchema | undefined, result)) continue;
      const thenSchema = entry.then as DefinitionSchema | undefined;
      if (thenSchema) applySelectedSchemaRequirements(thenSchema, properties, result, `${path}-then`);
    }
    return result;
  }
  if (type === "array") {
    const count = typeof schema.minItems === "number" ? schema.minItems : 0;
    const itemSchema = (schema.items ?? {}) as DefinitionSchema;
    return Array.from({ length: Math.max(count, 1) }, (_, index) => definitionSample(itemSchema, `${path}-${index}`));
  }
  if (type === "integer" || type === "number") return typeof schema.minimum === "number" ? schema.minimum : 0;
  if (type === "boolean") return false;
  if (type === "null") return null;
  return syntheticString(schema, path);
}

/** Build closed, deterministic request/result samples from exact PDP-1 schemas only. */
export function createOperationDefinitionFixture(input: OperationDefinitionFixtureInput): OperationDefinitionFixture {
  const request = definitionSample(input.requestSchema, `${input.fixtureId}-request`) as Record<string, unknown>;
  const resultShape = definitionSample(input.resultSchema, `${input.fixtureId}-result`) as Record<string, unknown>;
  return {
    fixtureId: input.fixtureId,
    journeyRef: input.journeyRef,
    stepRef: input.stepRef,
    actionRef: input.actionRef,
    capabilityRef: input.capabilityRef,
    operationRef: input.operationRef,
    requestSchemaRef: input.requestSchemaRef,
    resultSchemaRef: input.resultSchemaRef,
    request,
    resultShape,
    synthetic: true,
    resultIsOwnerEvidence: false,
    dispatch: "NEVER",
    runtimeAdmission: "NOT_ADMITTED",
  };
}

/** Project one exact step-oracle case as a guard-verdict input, never as evidence. */
export function createStepBranchDefinitionFixture(input: StepBranchDefinitionFixtureInput): StepBranchDefinitionFixture {
  if (!input.fixtureId.trim() || !input.sourceRef.trim() || !input.journeyRef.trim() || !input.stepRef.trim() || !input.case.trim()) {
    throw new Error("step branch definition fixture requires exact source and case identities");
  }
  if (!["positive", "denied", "unknown"].includes(input.branch)) {
    throw new Error("step branch fixture does not infer an unlisted branch category");
  }
  const expectedVerdict = input.branch === "positive" ? "PASS" : input.branch === "denied" ? "DENIED" : "UNKNOWN";
  if (input.guardVerdict !== expectedVerdict) {
    throw new Error(`${input.branch} branch requires ${expectedVerdict} guard verdict`);
  }
  if (input.branch === "denied" && input.expectedDecision !== "DENY_WITHOUT_EFFECT") {
    throw new Error("denied branch must preserve the source deny-without-effect decision");
  }
  if (input.branch === "unknown" && input.expectedDecision !== "HOLD_WITHOUT_EFFECT_OR_REPLAY") {
    throw new Error("unknown branch must preserve the source hold-without-replay decision");
  }
  if (input.branch === "positive" && ["DENY_WITHOUT_EFFECT", "HOLD_WITHOUT_EFFECT_OR_REPLAY"].includes(input.expectedDecision)) {
    throw new Error("positive branch cannot project a denied or unknown decision");
  }
  return {
    fixtureKind: "STEP_GUARD_BRANCH_INPUT",
    fixtureId: input.fixtureId,
    sourceRef: input.sourceRef,
    journeyRef: input.journeyRef,
    stepRef: input.stepRef,
    branch: input.branch,
    case: input.case,
    guardVerdict: input.guardVerdict,
    expectedDecision: input.expectedDecision,
    ...(input.selectedCapabilityRef ? { selectedCapabilityRef: input.selectedCapabilityRef } : {}),
    ...(input.selectedOperationRef ? { selectedOperationRef: input.selectedOperationRef } : {}),
    synthetic: true,
    dispatch: "NEVER",
    ownerAcceptedOutcomeOracle: false,
    runtimeAdmission: "NOT_ADMITTED",
  };
}

/** Project the P1 exact-version mismatch rule without inventing any identity values. */
export function createVersionMismatchGuardDefinitionFixture(
  input: VersionMismatchGuardDefinitionFixtureInput,
): VersionMismatchGuardDefinitionFixture {
  if (!input.fixtureId.trim() || !input.sourceRef.trim() || !input.journeyRef.trim() || !input.stepRef.trim()) {
    throw new Error("version mismatch fixture requires exact source and step identities");
  }
  if (input.versionDisposition !== "EXACT_CANONICAL_VERSION_TUPLE_REQUIRED" ||
      !/missing, stale, foreign-tenant, mismatched, or substituted-latest identity is UNKNOWN/iu.test(input.versionBindingRule) ||
      input.missingOrStaleDisposition !== "UNKNOWN" || input.exactVersionTupleFields.length === 0) {
    throw new Error("source does not define an exact version mismatch as UNKNOWN");
  }
  const exactIdentityTupleFields = [...input.exactVersionTupleFields];
  const syntheticExpectedTuple = Object.fromEntries(exactIdentityTupleFields.map((field) => [field, `synthetic-expected-${field}`]));
  const syntheticPresentedTuple = Object.fromEntries(exactIdentityTupleFields.map((field) => [field,
    field === "versionId" || /revision/iu.test(field) ? `synthetic-stale-${field}` : `synthetic-expected-${field}`]));
  if (exactIdentityTupleFields.every((field) => syntheticExpectedTuple[field] === syntheticPresentedTuple[field])) {
    const versionField = exactIdentityTupleFields.find((field) => /version|revision/iu.test(field));
    if (versionField) syntheticPresentedTuple[versionField] = `synthetic-stale-${versionField}`;
    else throw new Error("exact identity tuple has no version component to mismatch");
  }
  return {
    fixtureKind: "VERSION_MISMATCH_GUARD_RULE",
    fixtureId: input.fixtureId,
    sourceRef: input.sourceRef,
    journeyRef: input.journeyRef,
    stepRef: input.stepRef,
    exactIdentityTupleFields,
    syntheticExpectedTuple,
    syntheticPresentedTuple,
    conditionEvaluated: false,
    mismatchCondition: "MISSING_STALE_FOREIGN_OR_MISMATCHED_EXACT_VERSION_TUPLE",
    expectedGuardVerdict: "UNKNOWN",
    expectedEffect: "NONE",
    expectedDecision: "HOLD_WITHOUT_EFFECT_OR_REPLAY",
    synthetic: true,
    dispatch: "NEVER",
    runtimeAdmission: "NOT_ADMITTED",
  };
}

/** Build a schema-shaped caption-draft request with a source-defined stale-revision disposition. */
export function createStaleDraftRevisionDefinitionFixture(
  input: StaleDraftRevisionDefinitionFixtureInput,
): StaleDraftRevisionDefinitionFixture {
  if (!input.fixtureId.trim() || !input.journeyRef.trim() || !input.stepRef.trim() ||
      input.sourceRefs.length === 0 || input.sourceRefs.some((ref) => !ref.trim()) || !input.requestSchemaRef.trim()) {
    throw new Error("stale draft fixture requires exact journey, operation, schema, and fail-closed source refs");
  }
  const properties = input.requestSchema.properties as Record<string, DefinitionSchema> | undefined;
  if (!Array.isArray(input.requestSchema.required) || !input.requestSchema.required.includes("expectedDraftRevision") ||
      properties?.expectedDraftRevision?.type !== "integer") {
    throw new Error("caption-draft request schema does not bind expectedDraftRevision as an integer");
  }
  const request = definitionSample(input.requestSchema, `${input.fixtureId}-request`) as Record<string, unknown>;
  return {
    fixtureKind: "STALE_DRAFT_REVISION_REQUEST",
    fixtureId: input.fixtureId,
    sourceRefs: [...input.sourceRefs],
    journeyRef: input.journeyRef,
    stepRef: input.stepRef,
    operationRef: input.operationRef,
    requestSchemaRef: input.requestSchemaRef,
    request,
    requestIsSyntheticSchemaSample: true,
    mismatchCondition: "EXPECTED_DRAFT_REVISION_DOES_NOT_MATCH_CURRENT_SESSION_LOCAL_DRAFT",
    expectedDecision: "REJECT_WITHOUT_ADVANCE_IF_CONDITION_HOLDS",
    conditionEvaluated: false,
    dispatch: "NEVER",
    runtimeAdmission: "NOT_ADMITTED",
  };
}

export const syntheticTranscriptSegments: readonly TimedTextSegment[] = [
  {
    segmentId: "segment-001",
    text: "When the signal returns, record the time.",
    startTick: 0,
    endTick: 3100,
    speakerLabel: "Speaker A",
    origin: "RECOGNIZED",
  },
  {
    segmentId: "segment-002",
    text: "Leave the original recording untouched.",
    startTick: 3400,
    endTick: 6500,
    speakerLabel: "Speaker B",
    origin: "RECOGNIZED",
  },
];

const baseState = (scenarioId: ScenarioId): TranscriptionExperienceState => ({
  scenarioId,
  workflow: "transcription",
  actor: "creator",
  artifactIntake: null,
  artifactVerification: null,
  source: {
    artifactId: "fixture-podcast-interview-source",
    artifactVersion: "source-v1",
    displayName: "Synthetic interview recording",
    mediaKind: "AUDIO",
    lifecycle: "AVAILABLE",
    selected: true,
    durationTicks: 14000,
    ticksPerSecond: 1000,
    clockId: "source-presentation-time",
    synthetic: true,
  },
  consentState: "ACTIVE",
  access: {
    readSource: "ALLOWED",
    processSource: "ALLOWED",
    editDerivedContent: "ALLOWED",
    registerDerivedVersion: "ALLOWED",
    viewJobStatus: "ALLOWED",
    cancelJob: "ALLOWED",
    checkJobOutcome: "ALLOWED",
  },
  job: {
    jobId: null,
    state: "NOT_SUBMITTED",
    attemptState: null,
    finality: "NOT_DISPATCHED",
  },
  retryEligibility: null,
  transcript: {
    versionId: null,
    languageTag: null,
    languageDisposition: "NOT_SELECTED",
    timingDisposition: "NOT_AVAILABLE",
    segments: [],
  },
  captionDraft: {
    versionId: null,
    parentVersionId: null,
    timingDisposition: "NOT_AVAILABLE",
    hasConflict: false,
    segments: [],
  },
  registeredCaptionVersions: [],
  captionHistory: [],
  playbackPositionTick: 0,
  selectedSegmentId: null,
  sequence: 0,
  eventLog: [`fixture:${scenarioId}:reset`],
});

function artifactIntakeFixture(
  scenarioId: ScenarioId,
  intake: NonNullable<MediaExperienceState["artifactIntake"]>,
): ArtifactIntakeExperienceState {
  return {
    ...baseState(scenarioId),
    workflow: "artifact-intake",
    artifactIntake: intake,
    artifactVerification: null,
    source: null,
  };
}

function artifactVerificationFixture(
  scenarioId: ScenarioId,
  artifactVerification: ArtifactVerificationState,
): ArtifactVerificationExperienceState {
  return {
    ...baseState(scenarioId),
    workflow: "artifact-verification",
    artifactIntake: null,
    artifactVerification,
    source: null,
  };
}

function firstUseFixture(
  scenarioId: ScenarioId,
  firstUse: FirstUseExperienceState["firstUse"],
): FirstUseExperienceState {
  return {
    ...baseState(scenarioId),
    workflow: "first-use",
    artifactIntake: null,
    artifactVerification: null,
    firstUse,
    source: null,
  };
}

const firstUseState = (
  overrides: Partial<FirstUseExperienceState["firstUse"]> = {},
): FirstUseExperienceState["firstUse"] => ({
  identityResolved: true,
  workspaceId: "fixture-workspace-001",
  workspaceAccess: "ALLOWED",
  projectCreateAuthority: "ALLOWED",
  createRequestId: null,
  creationStatus: "NOT_REQUESTED",
  projectId: null,
  projectVersion: null,
  intentDisposition: "NOT_SELECTED",
  returnDestination: "workspace-projects",
  synthetic: true,
  ...overrides,
});

const uploadFixture = (
  status: NonNullable<MediaExperienceState["artifactIntake"]>["status"],
  integrity: NonNullable<MediaExperienceState["artifactIntake"]>["integrity"],
  options: Partial<NonNullable<MediaExperienceState["artifactIntake"]>> = {},
) => ({
  uploadId: `fixture-${status.toLowerCase().replaceAll("_", "-")}-upload-001`,
  sourceName: "synthetic source file metadata",
  declaredByteSize: 4096,
  acknowledgedPartCount: 0,
  expectedPartCount: 4,
  status,
  integrity,
  artifactVersion: null,
  artifactReadAuthority: "ALLOWED" as const,
  uploadResumeAuthority: "DENIED" as const,
  sourceMetadataMatches: true,
  workspaceMatches: true,
  synthetic: true as const,
  ...options,
});

const readyState = (scenarioId: ScenarioId): MediaExperienceState => {
  const segments = syntheticTranscriptSegments.map((segment) => ({ ...segment }));
  return {
    ...baseState(scenarioId),
    job: {
      jobId: "fixture-transcription-job-completed",
      state: "COMPLETED",
      attemptState: "SUCCEEDED",
      finality: "CONFIRMED",
    },
    transcript: {
      versionId: "transcript-v1",
      languageTag: "en",
      languageDisposition: "DECLARED_BY_USER",
      timingDisposition: "ALIGNED",
      segments,
    },
    captionDraft: {
      versionId: "caption-draft-v1",
      parentVersionId: "caption-v0",
      timingDisposition: "ALIGNED",
      hasConflict: false,
      segments: segments.map((segment) => ({ ...segment })),
    },
    registeredCaptionVersions: ["caption-v0"],
    captionHistory: [{
      versionId: "caption-v0",
      sourceArtifactVersion: "source-v1",
      parentVersionId: "transcript-v1",
      segments: segments.map((segment) => ({ ...segment })),
    }],
  };
};

const seeds: Record<FixtureId, MediaExperienceState> = {
  "first-use-empty": firstUseFixture(
    "media.scenario.first-use-empty",
    firstUseState(),
  ),
  "identity-required": firstUseFixture(
    "media.scenario.identity-required",
    firstUseState({
      identityResolved: false,
      workspaceId: null,
      workspaceAccess: "UNKNOWN",
      projectCreateAuthority: "UNKNOWN",
    }),
  ),
  "workspace-access-denied": firstUseFixture(
    "media.scenario.workspace-access-denied",
    firstUseState({
      workspaceId: null,
      workspaceAccess: "DENIED",
      projectCreateAuthority: "DENIED",
    }),
  ),
  "project-create-outcome-unknown": firstUseFixture(
    "media.scenario.project-create-outcome-unknown",
    firstUseState({
      createRequestId: "fixture-project-create-request-unknown-001",
      creationStatus: "OUTCOME_UNKNOWN",
    }),
  ),
  "project-created-empty": firstUseFixture(
    "media.scenario.project-created-empty",
    firstUseState({
      createRequestId: "fixture-project-create-request-001",
      creationStatus: "CREATED",
      projectId: "fixture-project-001",
      projectVersion: "project-v1",
    }),
  ),
  "intent-unavailable": firstUseFixture(
    "media.scenario.intent-unavailable",
    firstUseState({
      createRequestId: "fixture-project-create-request-001",
      creationStatus: "CREATED",
      projectId: "fixture-project-001",
      projectVersion: "project-v1",
      intentDisposition: "UNAVAILABLE",
    }),
  ),
  "upload-interrupted": artifactIntakeFixture(
    "media.scenario.upload-interrupted",
    uploadFixture("INTERRUPTED", "NOT_CHECKED", {
      uploadId: "fixture-upload-interrupted-001",
      acknowledgedPartCount: 2,
      uploadResumeAuthority: "ALLOWED",
    }),
  ),
  "upload-checksum-mismatch": artifactIntakeFixture(
    "media.scenario.upload-checksum-mismatch",
    uploadFixture("REJECTED", "MISMATCH", {
      uploadId: "fixture-upload-checksum-mismatch-001",
      acknowledgedPartCount: 4,
    }),
  ),
  "upload-format-unsupported": artifactIntakeFixture(
    "media.scenario.upload-format-unsupported",
    uploadFixture("REJECTED", "UNSUPPORTED", {
      uploadId: "fixture-upload-format-unsupported-001",
      acknowledgedPartCount: 4,
    }),
  ),
  "upload-quarantined": artifactIntakeFixture(
    "media.scenario.upload-quarantined",
    uploadFixture("QUARANTINED", "QUARANTINED", {
      uploadId: "fixture-upload-quarantined-001",
      acknowledgedPartCount: 4,
    }),
  ),
  "upload-verified-available": artifactIntakeFixture(
    "media.scenario.upload-verified-available",
    uploadFixture("AVAILABLE", "MATCHED", {
      uploadId: "fixture-upload-verified-available-001",
      acknowledgedPartCount: 4,
      artifactVersion: "fixture-artifact-version-001",
    }),
  ),
  "upload-outcome-unknown": artifactIntakeFixture(
    "media.scenario.upload-outcome-unknown",
    uploadFixture("OUTCOME_UNKNOWN", "UNKNOWN", {
      uploadId: "fixture-upload-outcome-unknown-001",
      acknowledgedPartCount: 4,
    }),
  ),
  "upload-permission-revoked": artifactIntakeFixture(
    "media.scenario.upload-permission-revoked",
    uploadFixture("ACCESS_REVOKED", "UNKNOWN", {
      uploadId: "fixture-upload-permission-revoked-001",
      acknowledgedPartCount: 2,
      artifactReadAuthority: "DENIED",
      uploadResumeAuthority: "DENIED",
    }),
  ),
  "artifact-verification-running": artifactVerificationFixture(
    "media.scenario.artifact-verification-running",
    {
      jobId: "fixture-artifact-verification-job-running-001",
      uploadId: "fixture-upload-verified-available-001",
      status: "RUNNING",
      stage: "FORMAT_CHECK",
      progressPercent: 60,
      finality: "PENDING",
      evidence: ["fixture-transfer-receipt-recorded"],
      synthetic: true,
    },
  ),
  "artifact-verification-outcome-unknown": artifactVerificationFixture(
    "media.scenario.artifact-verification-outcome-unknown",
    {
      jobId: "fixture-artifact-verification-job-unknown-001",
      uploadId: "fixture-upload-outcome-unknown-001",
      status: "OUTCOME_UNKNOWN",
      stage: "INTEGRITY_CHECK",
      progressPercent: null,
      finality: "UNKNOWN",
      evidence: [],
      synthetic: true,
    },
  ),
  "artifact-verification-completed": artifactVerificationFixture(
    "media.scenario.artifact-verification-completed",
    {
      jobId: "fixture-artifact-verification-job-completed-001",
      uploadId: "fixture-upload-verified-available-001",
      status: "COMPLETED",
      stage: "COMPLETE",
      progressPercent: 100,
      finality: "CONFIRMED",
      evidence: ["fixture-size-and-digest-matched", "fixture-format-admitted", "fixture-policy-check-recorded"],
      synthetic: true,
    },
  ),
  "source-available": {
    ...baseState("media.scenario.source-available"),
    source: { ...baseState("media.scenario.source-available").source, selected: false },
  },
  "source-quarantined": {
    ...baseState("media.scenario.source-quarantined"),
    source: {
      ...baseState("media.scenario.source-quarantined").source,
      lifecycle: "QUARANTINED",
      selected: false,
    },
  },
  "transcript-ready": readyState("media.scenario.transcript-ready"),
  "language-uncertain": {
    ...readyState("media.scenario.language-uncertain"),
    transcript: {
      ...readyState("media.scenario.language-uncertain").transcript,
      languageDisposition: "UNCERTAIN",
    },
  },
  "alignment-required": {
    ...readyState("media.scenario.alignment-required"),
    transcript: {
      ...readyState("media.scenario.alignment-required").transcript,
      timingDisposition: "REQUIRES_REVIEW",
      segments: syntheticTranscriptSegments.map((segment, index) =>
        index === 1 ? { ...segment, endTick: null } : { ...segment },
      ),
    },
    captionDraft: {
      ...readyState("media.scenario.alignment-required").captionDraft,
      versionId: "caption-draft-v1",
      parentVersionId: "caption-v0",
      timingDisposition: "REQUIRES_REVIEW",
      hasConflict: false,
      segments: syntheticTranscriptSegments.map((segment, index) =>
        index === 1 ? { ...segment, endTick: null } : { ...segment },
      ),
    },
  },
  "consent-revoked": {
    ...baseState("media.scenario.consent-revoked"),
    consentState: "REVOKED",
    access: {
      readSource: "ALLOWED",
      processSource: "DENIED",
      editDerivedContent: "ALLOWED",
      registerDerivedVersion: "DENIED",
      viewJobStatus: "ALLOWED",
      cancelJob: "ALLOWED",
      checkJobOutcome: "ALLOWED",
    },
  },
  "job-outcome-unknown": {
    ...baseState("media.scenario.job-outcome-unknown"),
    job: {
      jobId: "fixture-transcription-job-unknown",
      state: "OUTCOME_UNKNOWN",
      attemptState: "OUTCOME_UNKNOWN",
      finality: "UNKNOWN",
    },
  },
  "job-retry-ineligible": {
    ...baseState("media.scenario.job-retry-ineligible"),
    job: {
      jobId: "fixture-transcription-job-unknown",
      state: "OUTCOME_UNKNOWN",
      attemptState: "OUTCOME_UNKNOWN",
      finality: "UNKNOWN",
    },
  },
  "job-retry-eligible": {
    ...readyState("media.scenario.job-retry-eligible"),
    job: {
      jobId: "fixture-job-retryable-001",
      state: "RETRY_PENDING",
      attemptState: "FAILED",
      finality: "CONFIRMED",
    },
    // The scenario remains conditional, but no source-backed prior-attempt or
    // current eligibility evidence exists to evaluate. Never seed it as eligible.
    retryEligibility: null,
  },
  "caption-conflict": {
    ...readyState("media.scenario.caption-conflict"),
    registeredCaptionVersions: ["caption-v0", "caption-v1"],
    captionHistory: [
      {
        versionId: "caption-v0",
        sourceArtifactVersion: "source-v1",
        parentVersionId: "transcript-v1",
        segments: syntheticTranscriptSegments.map((segment) => ({ ...segment })),
      },
      {
        versionId: "caption-v1",
        sourceArtifactVersion: "source-v1",
        parentVersionId: "caption-v0",
        segments: syntheticTranscriptSegments.map((segment, index) => index === 0
          ? { ...segment, text: "When the signal returns, mark the time.", origin: "USER_EDITED" as const }
          : { ...segment }),
      },
    ],
    captionDraft: {
      ...readyState("media.scenario.caption-conflict").captionDraft,
      parentVersionId: "caption-v0",
      hasConflict: true,
      segments: syntheticTranscriptSegments.map((segment, index) => index === 0
        ? { ...segment, text: "When the signal returns, write down the time.", origin: "USER_EDITED" as const }
        : { ...segment }),
    },
  },
  "caption-corrected": {
    ...readyState("media.scenario.caption-corrected"),
    captionDraft: {
      ...readyState("media.scenario.caption-corrected").captionDraft,
      versionId: "caption-draft-v2",
      segments: syntheticTranscriptSegments.map((segment, index) => index === 0
        ? { ...segment, text: "When the signal returns, note the time.", origin: "USER_EDITED" as const }
        : { ...segment }),
    },
  },
  "job-running": {
    ...baseState("media.scenario.job-running"),
    job: {
      jobId: "fixture-transcription-job-running",
      state: "RUNNING",
      attemptState: "RUNNING",
      finality: "PENDING",
    },
    transcript: {
      versionId: null,
      languageTag: "en",
      languageDisposition: "DECLARED_BY_USER",
      timingDisposition: "NOT_AVAILABLE",
      segments: [],
    },
  },
  "job-outcome-confirmed": {
    ...readyState("media.scenario.job-outcome-confirmed"),
    job: {
      jobId: "fixture-transcription-job-outcome-confirmed",
      state: "COMPLETED",
      attemptState: "SUCCEEDED",
      finality: "CONFIRMED",
    },
    eventLog: [
      "fixture:media.scenario.job-outcome-confirmed:reset",
      "1:job.outcome-unknown",
      "2:media.action.check-job-outcome",
      "3:job.outcome-check-completed:COMPLETED",
    ],
  },
  "caption-version-comparison": {
    ...readyState("media.scenario.caption-version-comparison"),
    registeredCaptionVersions: ["caption-v0", "caption-v1"],
    captionHistory: [
      {
        versionId: "caption-v0",
        sourceArtifactVersion: "source-v1",
        parentVersionId: "transcript-v1",
        segments: syntheticTranscriptSegments.map((segment) => ({ ...segment })),
      },
      {
        versionId: "caption-v1",
        sourceArtifactVersion: "source-v1",
        parentVersionId: "caption-v0",
        segments: syntheticTranscriptSegments.map((segment, index) => index === 0
          ? { ...segment, text: "When the signal returns, note the time.", origin: "USER_EDITED" as const }
          : { ...segment }),
      },
    ],
  },
  "caption-source-mismatch": {
    ...readyState("media.scenario.caption-source-mismatch"),
    registeredCaptionVersions: ["caption-v0", "caption-v1"],
    captionHistory: [
      {
        versionId: "caption-v0",
        sourceArtifactVersion: "source-v1",
        parentVersionId: "transcript-v1",
        segments: syntheticTranscriptSegments.map((segment) => ({ ...segment })),
      },
      {
        versionId: "caption-v1",
        sourceArtifactVersion: "source-v2",
        parentVersionId: "transcript-v2",
        segments: syntheticTranscriptSegments.map((segment) => ({ ...segment })),
      },
    ],
  },
};

export const mediaExperienceScenarioIds: readonly ScenarioId[] = Object.freeze(
  Object.keys(seeds).map((fixtureId) => `media.scenario.${fixtureId}` as ScenarioId),
);

export function createFixtureState(scenarioId: ScenarioId): MediaExperienceState {
  const fixtureId = scenarioId.slice("media.scenario.".length) as FixtureId;
  const seed = seeds[fixtureId];
  if (!seed) throw new Error(`Unknown Media experience fixture '${String(scenarioId)}'.`);
  const common = {
    ...seed,
    access: { ...seed.access },
    job: { ...seed.job },
    transcript: {
      ...seed.transcript,
      segments: seed.transcript.segments.map((segment) => ({ ...segment })),
    },
    captionDraft: {
      ...seed.captionDraft,
      segments: seed.captionDraft.segments.map((segment) => ({ ...segment })),
    },
    registeredCaptionVersions: [...seed.registeredCaptionVersions],
    captionHistory: seed.captionHistory.map((version) => ({
      ...version,
      segments: version.segments.map((segment) => ({ ...segment })),
    })),
    playbackPositionTick: seed.playbackPositionTick,
    eventLog: [...seed.eventLog],
  };
  if (seed.workflow === "artifact-intake") {
    return {
      ...common,
      workflow: "artifact-intake",
      artifactIntake: { ...seed.artifactIntake },
      artifactVerification: null,
      source: null,
    };
  }
  if (seed.workflow === "artifact-verification") {
    return {
      ...common,
      workflow: "artifact-verification",
      artifactIntake: null,
      artifactVerification: {
        ...seed.artifactVerification,
        evidence: [...seed.artifactVerification.evidence],
      },
      source: null,
    };
  }
  if (seed.workflow === "first-use") {
    return {
      ...common,
      workflow: "first-use",
      artifactIntake: null,
      artifactVerification: null,
      firstUse: { ...seed.firstUse },
      source: null,
    };
  }
  return {
    ...common,
    workflow: "transcription",
    artifactIntake: null,
    artifactVerification: null,
    source: { ...seed.source },
  };
}
