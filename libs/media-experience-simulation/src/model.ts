export type FixtureId =
  | "first-use-empty"
  | "identity-required"
  | "workspace-access-denied"
  | "project-create-outcome-unknown"
  | "project-created-empty"
  | "intent-unavailable"
  | "upload-interrupted"
  | "upload-checksum-mismatch"
  | "upload-format-unsupported"
  | "upload-quarantined"
  | "upload-verified-available"
  | "upload-outcome-unknown"
  | "upload-permission-revoked"
  | "artifact-verification-running"
  | "artifact-verification-outcome-unknown"
  | "artifact-verification-completed"
  | "source-available"
  | "source-quarantined"
  | "transcript-ready"
  | "language-uncertain"
  | "alignment-required"
  | "consent-revoked"
  | "job-outcome-unknown"
  | "job-retry-eligible"
  | "job-retry-ineligible"
  | "caption-conflict"
  | "caption-corrected"
  | "job-running"
  | "job-outcome-confirmed"
  | "caption-version-comparison"
  | "caption-source-mismatch";

export type ScenarioId = `media.scenario.${FixtureId}`;

/** Test-only, schema-shaped operation sample; never sent to a runtime. */
export interface OperationDefinitionFixture {
  readonly fixtureId: string;
  readonly journeyRef: string;
  readonly stepRef: string;
  readonly actionRef: string;
  readonly capabilityRef: string | null;
  readonly operationRef: string;
  readonly requestSchemaRef: string;
  readonly resultSchemaRef: string;
  readonly request: Readonly<Record<string, unknown>>;
  readonly resultShape: Readonly<Record<string, unknown>>;
  readonly synthetic: true;
  readonly resultIsOwnerEvidence: false;
  readonly dispatch: "NEVER";
  readonly runtimeAdmission: "NOT_ADMITTED";
}

/** Source-authored guard verdict input; contains no state, authority, or runtime evidence. */
export interface StepBranchDefinitionFixture {
  readonly fixtureKind: "STEP_GUARD_BRANCH_INPUT";
  readonly fixtureId: string;
  readonly sourceRef: string;
  readonly journeyRef: string;
  readonly stepRef: string;
  readonly branch: "positive" | "denied" | "unknown";
  readonly case: string;
  readonly guardVerdict: "PASS" | "DENIED" | "UNKNOWN";
  readonly expectedDecision: string;
  readonly selectedCapabilityRef?: string;
  readonly selectedOperationRef?: string;
  readonly synthetic: true;
  readonly dispatch: "NEVER";
  readonly ownerAcceptedOutcomeOracle: false;
  readonly runtimeAdmission: "NOT_ADMITTED";
}

/** Exact source rule for a stale/mismatched version tuple, without invented tuple values. */
export interface VersionMismatchGuardDefinitionFixture {
  readonly fixtureKind: "VERSION_MISMATCH_GUARD_RULE";
  readonly fixtureId: string;
  readonly sourceRef: string;
  readonly journeyRef: string;
  readonly stepRef: string;
  readonly exactIdentityTupleFields: readonly string[];
  readonly syntheticExpectedTuple: Readonly<Record<string, string>>;
  readonly syntheticPresentedTuple: Readonly<Record<string, string>>;
  readonly conditionEvaluated: false;
  readonly mismatchCondition: "MISSING_STALE_FOREIGN_OR_MISMATCHED_EXACT_VERSION_TUPLE";
  readonly expectedGuardVerdict: "UNKNOWN";
  readonly expectedEffect: "NONE";
  readonly expectedDecision: "HOLD_WITHOUT_EFFECT_OR_REPLAY";
  readonly synthetic: true;
  readonly dispatch: "NEVER";
  readonly runtimeAdmission: "NOT_ADMITTED";
}

/** Synthetic request shape for a source-defined draft-revision denial; not an evaluated outcome. */
export interface StaleDraftRevisionDefinitionFixture {
  readonly fixtureKind: "STALE_DRAFT_REVISION_REQUEST";
  readonly fixtureId: string;
  readonly sourceRefs: readonly string[];
  readonly journeyRef: string;
  readonly stepRef: string;
  readonly operationRef: "media.operation.caption-draft-write";
  readonly requestSchemaRef: string;
  readonly request: Readonly<Record<string, unknown>>;
  readonly requestIsSyntheticSchemaSample: true;
  readonly mismatchCondition: "EXPECTED_DRAFT_REVISION_DOES_NOT_MATCH_CURRENT_SESSION_LOCAL_DRAFT";
  readonly expectedDecision: "REJECT_WITHOUT_ADVANCE_IF_CONDITION_HOLDS";
  readonly conditionEvaluated: false;
  readonly dispatch: "NEVER";
  readonly runtimeAdmission: "NOT_ADMITTED";
}

export type JobState =
  | "NOT_SUBMITTED"
  | "QUEUED"
  | "RUNNING"
  | "OUTCOME_UNKNOWN"
  | "RECONCILING"
  | "RETRY_PENDING"
  | "COMPLETED"
  | "PARTIALLY_SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

export type AttemptState =
  | "DISPATCH_INTENT_RECORDED"
  | "DISPATCHED"
  | "RUNNING"
  | "CANCEL_REQUESTED"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCEL_CONFIRMED"
  | "OUTCOME_UNKNOWN"
  | "SUPERSEDED";

export type ConsentState = "PENDING_VERIFICATION" | "ACTIVE" | "REVOKED" | "EXPIRED";
export type AccessDisposition = "ALLOWED" | "DENIED" | "UNKNOWN";
export type ArtifactState = "AVAILABLE" | "QUARANTINED" | "ACCESS_REVOKED";
export type LanguageDisposition = "NOT_SELECTED" | "DECLARED_BY_USER" | "UNCERTAIN";
export type TimingDisposition = "NOT_AVAILABLE" | "ALIGNED" | "REQUIRES_REVIEW";
export type SegmentOrigin = "RECOGNIZED" | "USER_EDITED";
export type ExperienceWorkflow = "first-use" | "artifact-intake" | "artifact-verification" | "transcription";
export type ArtifactIntakeStatus =
  | "INTERRUPTED"
  | "RECEIVING"
  | "VERIFYING"
  | "OUTCOME_UNKNOWN"
  | "AVAILABLE"
  | "QUARANTINED"
  | "REJECTED"
  | "ACCESS_REVOKED";
export type ArtifactIntegrityDisposition =
  | "NOT_CHECKED"
  | "UNKNOWN"
  | "MATCHED"
  | "MISMATCH"
  | "UNSUPPORTED"
  | "QUARANTINED";

export interface ArtifactIntakeState {
  readonly uploadId: string;
  readonly sourceName: string;
  readonly declaredByteSize: number | null;
  readonly acknowledgedPartCount: number;
  readonly expectedPartCount: number | null;
  readonly status: ArtifactIntakeStatus;
  readonly integrity: ArtifactIntegrityDisposition;
  readonly artifactVersion: string | null;
  readonly artifactReadAuthority: AccessDisposition;
  readonly uploadResumeAuthority: AccessDisposition;
  readonly sourceMetadataMatches: boolean;
  readonly workspaceMatches: boolean;
  readonly synthetic: true;
}

export type ProjectCreationStatus = "NOT_REQUESTED" | "OUTCOME_UNKNOWN" | "CREATED";
export type IntentDisposition = "NOT_SELECTED" | "UNAVAILABLE";

export interface FirstUseState {
  readonly identityResolved: boolean;
  readonly workspaceId: string | null;
  readonly workspaceAccess: AccessDisposition;
  readonly projectCreateAuthority: AccessDisposition;
  readonly createRequestId: string | null;
  readonly creationStatus: ProjectCreationStatus;
  readonly projectId: string | null;
  readonly projectVersion: string | null;
  readonly intentDisposition: IntentDisposition;
  readonly returnDestination: "workspace-projects";
  readonly synthetic: true;
}

export type ArtifactVerificationStatus = "RUNNING" | "OUTCOME_UNKNOWN" | "COMPLETED";
export type ArtifactVerificationStage = "INTEGRITY_CHECK" | "FORMAT_CHECK" | "POLICY_CHECK" | "COMPLETE";

export interface ArtifactVerificationState {
  readonly jobId: string;
  readonly uploadId: string;
  readonly status: ArtifactVerificationStatus;
  readonly stage: ArtifactVerificationStage;
  readonly progressPercent: number | null;
  readonly finality: "PENDING" | "UNKNOWN" | "CONFIRMED";
  readonly evidence: readonly string[];
  readonly synthetic: true;
}

export interface TimedTextSegment {
  readonly segmentId: string;
  readonly text: string;
  readonly startTick: number | null;
  readonly endTick: number | null;
  readonly speakerLabel?: string;
  readonly origin: SegmentOrigin;
}

export interface MediaSource {
  readonly artifactId: string;
  readonly artifactVersion: string;
  readonly displayName: string;
  readonly mediaKind: "AUDIO";
  readonly lifecycle: ArtifactState;
  readonly selected: boolean;
  readonly durationTicks: number;
  readonly ticksPerSecond: number;
  readonly clockId: string;
  readonly synthetic: true;
}

export interface CaptionVersionRecord {
  readonly versionId: string;
  readonly sourceArtifactVersion: string;
  readonly parentVersionId: string;
  readonly purpose?: string;
  readonly segments: readonly TimedTextSegment[];
}

/** Conditional pre-dispatch facts; eligibility requires every fact to resolve to owner evidence. */
export type RetryEligibilityEvidenceFact =
  | "priorAttempt" | "priorEffect" | "authority" | "policy" | "rights"
  | "consent" | "license" | "resource" | "deployment" | "profile" | "retryBudget";

export interface RetryEligibilityEvidence {
  readonly tenantId: string;
  readonly principalId: string;
  readonly jobId: string;
  readonly jobVersion: number;
  readonly priorAttemptId: string;
  readonly priorAttemptFencingToken: number;
  readonly priorAttemptDisposition: "RETRYABLE" | "NON_RETRYABLE" | "UNKNOWN";
  readonly priorEffectDisposition: "NO_EFFECT_CONFIRMED" | "EFFECT_CONFIRMED" | "UNKNOWN";
  readonly authorityDisposition: "CURRENT_ALLOWED" | "DENIED" | "UNKNOWN";
  readonly policyDisposition: "CURRENT_ALLOWED" | "DENIED" | "UNKNOWN";
  readonly rightsDisposition: "CURRENT_ALLOWED" | "DENIED" | "UNKNOWN";
  readonly consentDisposition: "CURRENT_ACTIVE" | "REVOKED" | "UNKNOWN";
  readonly licenseDisposition: "CURRENT_ALLOWED" | "DENIED" | "UNKNOWN";
  readonly resourceDisposition: "CURRENT_ALLOWED" | "DENIED" | "UNKNOWN";
  readonly deploymentDisposition: "CURRENT_ALLOWED" | "DENIED" | "UNKNOWN";
  readonly profileDisposition: "CURRENT_QUALIFIED" | "UNQUALIFIED" | "UNKNOWN";
  readonly retryBudgetRemaining: number;
  readonly retryBudgetRef: string;
  readonly observedAt: string;
  readonly evidenceRefs: Readonly<Record<RetryEligibilityEvidenceFact, string>>;
}

interface MediaExperienceCommonState {
  readonly scenarioId: ScenarioId;
  readonly actor: "creator" | "editor" | "reviewer" | "operator";
  readonly consentState: ConsentState;
  readonly access: {
    readonly readSource: AccessDisposition;
    readonly processSource: AccessDisposition;
    readonly editDerivedContent: AccessDisposition;
    readonly registerDerivedVersion: AccessDisposition;
    readonly viewJobStatus: AccessDisposition;
    readonly cancelJob: AccessDisposition;
    readonly checkJobOutcome: AccessDisposition;
  };
  readonly job: {
    readonly jobId: string | null;
    readonly state: JobState;
    readonly attemptState: AttemptState | null;
    readonly finality: "NOT_DISPATCHED" | "PENDING" | "CONFIRMED" | "UNKNOWN";
  };
  readonly retryEligibility: RetryEligibilityEvidence | null;
  readonly transcript: {
    readonly versionId: string | null;
    readonly languageTag: string | null;
    readonly languageDisposition: LanguageDisposition;
    readonly timingDisposition: TimingDisposition;
    readonly segments: readonly TimedTextSegment[];
  };
  readonly captionDraft: {
    readonly versionId: string | null;
    readonly parentVersionId: string | null;
    readonly timingDisposition: TimingDisposition;
    readonly hasConflict: boolean;
    readonly segments: readonly TimedTextSegment[];
  };
  readonly registeredCaptionVersions: readonly string[];
  readonly captionHistory: readonly CaptionVersionRecord[];
  readonly playbackPositionTick: number;
  readonly selectedSegmentId: string | null;
  readonly sequence: number;
  readonly eventLog: readonly string[];
}

export interface TranscriptionExperienceState extends MediaExperienceCommonState {
  readonly workflow: "transcription";
  readonly artifactIntake: null;
  readonly artifactVerification: null;
  readonly source: MediaSource;
}

export interface ArtifactIntakeExperienceState extends MediaExperienceCommonState {
  readonly workflow: "artifact-intake";
  readonly artifactIntake: ArtifactIntakeState;
  readonly artifactVerification: null;
  readonly source: null;
}

export interface FirstUseExperienceState extends MediaExperienceCommonState {
  readonly workflow: "first-use";
  readonly artifactIntake: null;
  readonly artifactVerification: null;
  readonly firstUse: FirstUseState;
  readonly source: null;
}

export interface ArtifactVerificationExperienceState extends MediaExperienceCommonState {
  readonly workflow: "artifact-verification";
  readonly artifactIntake: null;
  readonly artifactVerification: ArtifactVerificationState;
  readonly source: null;
}

export type MediaExperienceState = TranscriptionExperienceState | ArtifactIntakeExperienceState | FirstUseExperienceState | ArtifactVerificationExperienceState;

export type MediaAction =
  | { readonly type: "media.action.create-project" }
  | { readonly type: "media.action.inspect-project-creation" }
  | { readonly type: "media.action.inspect-artifact" }
  | { readonly type: "media.action.resume-artifact-upload" }
  | { readonly type: "media.action.choose-source" }
  | { readonly type: "media.action.request-transcription"; readonly languageTag: string }
  | { readonly type: "media.action.inspect-source" }
  | { readonly type: "media.action.seek-source"; readonly timeTick: number }
  | { readonly type: "media.action.review-transcript" }
  | { readonly type: "media.action.view-job-status" }
  | { readonly type: "media.action.inspect-provenance" }
  | { readonly type: "media.action.correct-caption"; readonly segmentId: string; readonly text: string }
  | { readonly type: "media.action.compare-caption-versions"; readonly leftVersionId: string; readonly rightVersionId: string }
  | { readonly type: "media.action.resolve-caption-conflict"; readonly resolution: "keep-local" | "use-latest" }
  | {
      readonly type: "media.action.align-caption-timing";
      readonly segmentId: string;
      readonly startTick: number;
      readonly endTick: number;
    }
  | { readonly type: "media.action.save-caption-version"; readonly purpose?: string }
  | { readonly type: "media.action.request-cancellation" }
  | { readonly type: "media.action.check-job-outcome" };

export type SimulationEvent =
  | { readonly type: "job.started" }
  | { readonly type: "job.completed" }
  | { readonly type: "job.outcome-unknown" }
  | { readonly type: "job.cancellation-confirmed" }
  | { readonly type: "consent.revoked" }
  | {
      readonly type: "job.outcome-check-completed";
      readonly outcome: "COMPLETED" | "FAILED" | "CANCELLED" | "UNKNOWN";
    };

export interface TransitionResult {
  readonly state: MediaExperienceState;
  readonly applied: boolean;
  readonly reasonCode?: string;
  readonly effectIds: readonly string[];
  readonly message: string;
}
