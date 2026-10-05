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
  | "caption-conflict"
  | "caption-corrected"
  | "job-running"
  | "job-reconciled"
  | "caption-version-comparison"
  | "caption-source-mismatch";

export type ScenarioId = `media.scenario.${FixtureId}`;

export type JobState =
  | "NOT_SUBMITTED"
  | "QUEUED"
  | "RUNNING"
  | "OUTCOME_UNKNOWN"
  | "RECONCILING"
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

interface MediaExperienceCommonState {
  readonly scenarioId: ScenarioId;
  readonly actor: "creator" | "editor" | "reviewer" | "operator";
  readonly consentState: ConsentState;
  readonly access: {
    readonly readSource: AccessDisposition;
    readonly processSource: AccessDisposition;
    readonly editDerivedContent: AccessDisposition;
    readonly registerDerivedVersion: AccessDisposition;
    readonly inspectJob: AccessDisposition;
    readonly cancelJob: AccessDisposition;
    readonly reconcileJob: AccessDisposition;
  };
  readonly job: {
    readonly jobId: string | null;
    readonly state: JobState;
    readonly attemptState: AttemptState | null;
    readonly finality: "NOT_DISPATCHED" | "PENDING" | "CONFIRMED" | "UNKNOWN";
  };
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
  | { readonly type: "media.action.inspect-job" }
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
  | { readonly type: "media.action.reconcile-job" };

export type SimulationEvent =
  | { readonly type: "job.started" }
  | { readonly type: "job.completed" }
  | { readonly type: "job.outcome-unknown" }
  | { readonly type: "job.cancellation-confirmed" }
  | { readonly type: "consent.revoked" }
  | {
      readonly type: "job.reconciliation-completed";
      readonly outcome: "COMPLETED" | "FAILED" | "CANCELLED" | "UNKNOWN";
    };

export interface TransitionResult {
  readonly state: MediaExperienceState;
  readonly applied: boolean;
  readonly reasonCode?: string;
  readonly effectIds: readonly string[];
  readonly message: string;
}
