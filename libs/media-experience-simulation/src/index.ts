import { createFixtureState, mediaExperienceScenarioIds, syntheticTranscriptSegments } from "./fixtures.js";
import type {
  AccessDisposition,
  ArtifactVerificationExperienceState,
  ArtifactVerificationState,
  CaptionVersionRecord,
  FirstUseState,
  MediaAction,
  MediaExperienceState,
  ScenarioId,
  SimulationEvent,
  TimedTextSegment,
  TranscriptionExperienceState,
  TransitionResult,
} from "./model.js";

export type {
  ArtifactIntegrityDisposition,
  ArtifactIntakeState,
  ArtifactIntakeStatus,
  AccessDisposition,
  ArtifactVerificationExperienceState,
  ArtifactVerificationState,
  ArtifactIntakeExperienceState,
  CaptionVersionRecord,
  FirstUseExperienceState,
  FirstUseState,
  AttemptState,
  ConsentState,
  ExperienceWorkflow,
  JobState,
  MediaAction,
  MediaExperienceState,
  ScenarioId,
  SimulationEvent,
  TimedTextSegment,
  TranscriptionExperienceState,
  TransitionResult,
} from "./model.js";
export { createFixtureState, mediaExperienceScenarioIds, syntheticTranscriptSegments };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function isMediaAction(value: unknown): value is MediaAction {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "media.action.create-project":
    case "media.action.inspect-project-creation":
    case "media.action.inspect-artifact":
    case "media.action.resume-artifact-upload":
    case "media.action.choose-source":
    case "media.action.inspect-source":
    case "media.action.review-transcript":
    case "media.action.view-job-status":
    case "media.action.inspect-provenance":
    case "media.action.request-cancellation":
    case "media.action.check-job-outcome":
      return hasExactKeys(value, ["type"]);
    case "media.action.save-caption-version":
      return hasExactKeys(value, ["type"]) ||
        (hasExactKeys(value, ["type", "purpose"]) && typeof value.purpose === "string");
    case "media.action.request-transcription":
      return hasExactKeys(value, ["type", "languageTag"]) && typeof value.languageTag === "string";
    case "media.action.seek-source":
      return hasExactKeys(value, ["type", "timeTick"]) && typeof value.timeTick === "number" &&
        Number.isSafeInteger(value.timeTick);
    case "media.action.correct-caption":
      return hasExactKeys(value, ["type", "segmentId", "text"]) &&
        typeof value.segmentId === "string" && typeof value.text === "string";
    case "media.action.compare-caption-versions":
      return hasExactKeys(value, ["type", "leftVersionId", "rightVersionId"]) &&
        typeof value.leftVersionId === "string" && typeof value.rightVersionId === "string";
    case "media.action.resolve-caption-conflict":
      return hasExactKeys(value, ["type", "resolution"]) &&
        (value.resolution === "keep-local" || value.resolution === "use-latest");
    case "media.action.align-caption-timing":
      return hasExactKeys(value, ["type", "segmentId", "startTick", "endTick"]) &&
        typeof value.segmentId === "string" && typeof value.startTick === "number" &&
        typeof value.endTick === "number" && Number.isSafeInteger(value.startTick) &&
        Number.isSafeInteger(value.endTick);
    default:
      return false;
  }
}

export function isSimulationEvent(value: unknown): value is SimulationEvent {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "job.started":
    case "job.completed":
    case "job.outcome-unknown":
    case "job.cancellation-confirmed":
    case "consent.revoked":
      return hasExactKeys(value, ["type"]);
    case "job.outcome-check-completed":
      return hasExactKeys(value, ["type", "outcome"]) &&
        ["COMPLETED", "FAILED", "CANCELLED", "UNKNOWN"].includes(String(value.outcome));
    default:
      return false;
  }
}

const allowed = (disposition: AccessDisposition): boolean => disposition === "ALLOWED";
const fixtureKey = (scenarioId: ScenarioId): string => scenarioId.slice("media.scenario.".length);
const appendEvent = (state: MediaExperienceState, event: string): readonly string[] => [
  ...state.eventLog,
  `${state.sequence + 1}:${event}`,
];
const result = (
  state: MediaExperienceState,
  effectIds: readonly string[],
  message: string,
): TransitionResult => ({ state, applied: true, effectIds, message });
const blocked = (state: MediaExperienceState, reasonCode: string, message: string): TransitionResult => ({
  state,
  applied: false,
  reasonCode,
  effectIds: [],
  message,
});

function canSelectSource(state: TranscriptionExperienceState): boolean {
  return state.source.lifecycle === "AVAILABLE" && allowed(state.access.readSource);
}

function canRequestTranscription(state: TranscriptionExperienceState, languageTag: string): string | undefined {
  if (!canSelectSource(state) || !state.source.selected) return "SOURCE_NOT_READY";
  if (state.consentState !== "ACTIVE") return "CONSENT_NOT_ACTIVE";
  if (!allowed(state.access.processSource)) return "PROCESSING_AUTHORITY_NOT_ALLOWED";
  if (!languageTag.trim()) return "LANGUAGE_INTENT_REQUIRED";
  if (state.job.state !== "NOT_SUBMITTED") return "EXISTING_JOB_REQUIRES_REVIEW";
  return undefined;
}

function replaceSegment(
  segments: readonly TimedTextSegment[],
  segmentId: string,
  update: (segment: TimedTextSegment) => TimedTextSegment,
): readonly TimedTextSegment[] | undefined {
  if (!segments.some((segment) => segment.segmentId === segmentId)) return undefined;
  return segments.map((segment) => segment.segmentId === segmentId ? update(segment) : segment);
}

function withDraftSegments(
  state: TranscriptionExperienceState,
  segments: readonly TimedTextSegment[],
  effectId: string,
): MediaExperienceState {
  const timingDisposition = segments.every((segment) =>
    Number.isSafeInteger(segment.startTick) && Number.isSafeInteger(segment.endTick) &&
    segment.startTick !== null && segment.endTick !== null && segment.endTick > segment.startTick,
  ) ? "ALIGNED" : "REQUIRES_REVIEW";
  return {
    ...state,
    captionDraft: {
      ...state.captionDraft,
      versionId: `caption-draft-${state.sequence + 1}`,
      parentVersionId: state.captionDraft.parentVersionId ?? state.transcript.versionId ?? state.source.artifactVersion,
      timingDisposition,
      segments,
    },
    sequence: state.sequence + 1,
    eventLog: appendEvent(state, effectId),
  };
}

function completedJobState(state: TranscriptionExperienceState): TranscriptionExperienceState {
  const segments = syntheticTranscriptSegments.map((segment) => ({ ...segment }));
  const transcriptVersionId = `simulation-${fixtureKey(state.scenarioId)}-transcript-v1`;
  return {
    ...state,
    transcript: {
      versionId: transcriptVersionId,
      languageTag: state.transcript.languageTag,
      languageDisposition: state.transcript.languageTag ? "DECLARED_BY_USER" : "NOT_SELECTED",
      timingDisposition: "ALIGNED",
      segments,
    },
    captionDraft: {
      versionId: `simulation-${fixtureKey(state.scenarioId)}-caption-draft-v1`,
      parentVersionId: transcriptVersionId,
      timingDisposition: "ALIGNED",
      hasConflict: false,
      segments: segments.map((segment) => ({ ...segment })),
    },
  };
}

function getTimingDisposition(segments: readonly TimedTextSegment[]): "ALIGNED" | "REQUIRES_REVIEW" {
  return segments.every((segment) => Number.isSafeInteger(segment.startTick) &&
    Number.isSafeInteger(segment.endTick) && segment.startTick !== null &&
    segment.endTick !== null && segment.endTick > segment.startTick) ? "ALIGNED" : "REQUIRES_REVIEW";
}

export function reduceMediaExperience(state: MediaExperienceState, action: MediaAction): TransitionResult {
  if (!isMediaAction(action)) return blocked(state, "ACTION_NOT_SUPPORTED", "This action has an unknown or invalid shape.");
  if (state.workflow === "first-use") {
    const firstUse = state.firstUse;
    if (action.type === "media.action.create-project") {
      if (!firstUse.identityResolved) return blocked(state, "IDENTITY_NOT_ESTABLISHED", "Establish the identity handoff before reading protected project data or creating a project.");
      if (firstUse.workspaceAccess !== "ALLOWED") return blocked(state, "WORKSPACE_ACCESS_NOT_ALLOWED", "Project data and creation remain unavailable under the current workspace access.");
      if (firstUse.projectCreateAuthority !== "ALLOWED") return blocked(state, "PROJECT_CREATE_NOT_AUTHORIZED", "Current project-scoped authority does not permit creation.");
      if (firstUse.creationStatus !== "NOT_REQUESTED") return blocked(state, "PROJECT_CREATE_ALREADY_REQUESTED", "Inspect the existing project creation request before taking another action.");
      const nextState: MediaExperienceState = {
        ...state,
        firstUse: {
          ...firstUse,
          createRequestId: "fixture-project-create-request-001",
          creationStatus: "CREATED",
          projectId: "fixture-project-001",
          projectVersion: "project-v1",
        },
        sequence: state.sequence + 1,
        eventLog: appendEvent(state, action.type),
      };
      return result(nextState, ["media.effect.empty-project-created-in-fixture"], "An empty project was created in the synthetic fixture; no source, processing intent, provider, or runtime was used.");
    }
    if (action.type === "media.action.inspect-project-creation") {
      if (firstUse.creationStatus !== "OUTCOME_UNKNOWN" || !firstUse.createRequestId) {
        return blocked(state, "PROJECT_CREATE_OUTCOME_NOT_UNKNOWN", "There is no uncertain project creation request to inspect.");
      }
      return result(state, [], `Request ${firstUse.createRequestId} remains unknown because no authoritative project lookup is connected; do not submit a second create request.`);
    }
    return blocked(state, "ACTION_NOT_SUPPORTED_IN_FIRST_USE", "This action belongs to a different Media workflow.");
  }
  if (state.workflow === "artifact-intake") {
    const intake = state.artifactIntake;
    if (action.type === "media.action.inspect-artifact") {
      if (intake.artifactReadAuthority !== "ALLOWED") {
        return blocked(state, "ARTIFACT_READ_NOT_ALLOWED", "Artifact or transfer details are unavailable under the current read authority.");
      }
      const identity = intake.artifactVersion ?? intake.uploadId;
      return result(state, [], `Inspected ${identity}; transfer ${intake.status.toLowerCase().replaceAll("_", " ")}, integrity ${intake.integrity.toLowerCase().replaceAll("_", " ")}.`);
    }
    if (action.type === "media.action.resume-artifact-upload") {
      if (intake.status !== "INTERRUPTED") {
        return blocked(state, "UPLOAD_NOT_RESUMABLE", "Only an interrupted upload can be resumed; inspect its existing identity first.");
      }
      if (intake.uploadResumeAuthority !== "ALLOWED" || !intake.sourceMetadataMatches || !intake.workspaceMatches) {
        return blocked(state, "UPLOAD_RESUME_AUTHORITY_OR_SOURCE_MISMATCH", "Resume is unavailable because current authority, workspace, or source metadata does not match.");
      }
      const nextState: MediaExperienceState = {
        ...state,
        artifactIntake: { ...intake, status: "RECEIVING" },
        sequence: state.sequence + 1,
        eventLog: appendEvent(state, `${action.type}:${intake.uploadId}`),
      };
      return result(nextState, ["media.effect.upload-resume-simulated"], "The same fixture upload identity resumed; no file bytes were transferred.");
    }
    return blocked(state, "ACTION_NOT_SUPPORTED_IN_ARTIFACT_INTAKE", "This action belongs to a different Media workflow.");
  }
  if (state.workflow === "artifact-verification") {
    const verification = state.artifactVerification;
    if (action.type === "media.action.view-job-status") {
      if (!allowed(state.access.viewJobStatus)) return blocked(state, "JOB_STATUS_VIEW_NOT_ALLOWED", "Verification job status is unavailable under the current authority.");
      return result(state, [], `Artifact verification job ${verification.jobId} is ${verification.status.toLowerCase().replaceAll("_", " ")} with ${verification.finality.toLowerCase()} finality for upload ${verification.uploadId}.`);
    }
    if (action.type === "media.action.check-job-outcome") {
      if (verification.status !== "OUTCOME_UNKNOWN") return blocked(state, "JOB_OUTCOME_NOT_UNKNOWN", "Only a verification job with an uncertain outcome can be checked.");
      if (!allowed(state.access.checkJobOutcome)) return blocked(state, "JOB_OUTCOME_CHECK_NOT_ALLOWED", "Checking this verification job outcome is unavailable under the current authority.");
      return result(state, [], `Verification job ${verification.jobId} remains unknown because no owner-issued evidence is connected; do not create a new job or upload.`);
    }
    return blocked(state, "ACTION_NOT_SUPPORTED_IN_ARTIFACT_VERIFICATION", "This action belongs to a different Media workflow.");
  }
  switch (action.type) {
    case "media.action.create-project":
    case "media.action.inspect-project-creation":
      return blocked(state, "ACTION_NOT_SUPPORTED_IN_TRANSCRIPTION", "First-use project actions belong to a different Media workflow.");
    case "media.action.inspect-artifact":
    case "media.action.resume-artifact-upload":
      return blocked(state, "ACTION_NOT_SUPPORTED_IN_TRANSCRIPTION", "Artifact intake actions belong to a different Media workflow.");
    case "media.action.choose-source": {
      if (!canSelectSource(state)) return blocked(state, "SOURCE_NOT_AVAILABLE", "This recording is not available for this action.");
      return result({
        ...state,
        source: { ...state.source, selected: true },
        sequence: state.sequence + 1,
        eventLog: appendEvent(state, action.type),
      }, ["media.effect.source-selected"], "Recording selected.");
    }
    case "media.action.inspect-source": {
      if (!allowed(state.access.readSource)) return blocked(state, "SOURCE_READ_NOT_ALLOWED", "Source details are not available under the current read authority.");
      return result(state, [], `Source version ${state.source.artifactVersion} is ${state.source.lifecycle.toLowerCase()}.`);
    }
    case "media.action.request-transcription": {
      const reasonCode = canRequestTranscription(state, action.languageTag);
      if (reasonCode) return blocked(state, reasonCode, "Transcription cannot start until its source, language, consent, and authority checks pass.");
      const jobId = `simulation-${fixtureKey(state.scenarioId)}-job-001`;
      return result({
        ...state,
        job: { jobId, state: "QUEUED", attemptState: null, finality: "PENDING" },
        transcript: {
          versionId: null,
          languageTag: action.languageTag,
          languageDisposition: "DECLARED_BY_USER",
          timingDisposition: "NOT_AVAILABLE",
          segments: [],
        },
        sequence: state.sequence + 1,
        eventLog: appendEvent(state, action.type),
      }, ["media.effect.transcription-request-recorded"], "The request is recorded and waiting to start.");
    }
    case "media.action.seek-source": {
      if (!canSelectSource(state) || !state.source.selected) return blocked(state, "SOURCE_NOT_READY", "Select a readable recording before moving its play position.");
      if (!Number.isSafeInteger(action.timeTick) || action.timeTick < 0 || action.timeTick > state.source.durationTicks) {
        return blocked(state, "SOURCE_TIME_INVALID", "Choose a whole source-clock tick within the recording duration.");
      }
      const segments = state.captionDraft.segments.length ? state.captionDraft.segments : state.transcript.segments;
      const selectedSegmentId = segments.find((segment) => segment.startTick !== null && segment.endTick !== null &&
        action.timeTick >= segment.startTick && action.timeTick < segment.endTick)?.segmentId ?? null;
      const nextState = {
        ...state,
        playbackPositionTick: action.timeTick,
        selectedSegmentId,
        sequence: state.sequence + 1,
        eventLog: appendEvent(state, `${action.type}:${action.timeTick}`),
      };
      return result(nextState, ["media.effect.source-position-changed"], "The selected source time changed; source media is unchanged.");
    }
    case "media.action.review-transcript": {
      if (!allowed(state.access.readSource)) return blocked(state, "SOURCE_READ_NOT_ALLOWED", "The transcript is not available under the current read authority.");
      if (!state.transcript.versionId) return blocked(state, "TRANSCRIPT_NOT_READY", "There is no source-linked transcript to review yet.");
      return result(state, [], "The source-linked transcript and its uncertainty are ready to review.");
    }
    case "media.action.view-job-status": {
      if (!allowed(state.access.viewJobStatus)) return blocked(state, "JOB_STATUS_VIEW_NOT_ALLOWED", "Job details are not available under the current authority.");
      if (!state.job.jobId) return blocked(state, "JOB_NOT_FOUND", "There is no transcription job to view.");
      return result(state, [], `Job ${state.job.jobId} is ${state.job.state.toLowerCase()} with ${state.job.finality.toLowerCase()} finality.`);
    }
    case "media.action.inspect-provenance": {
      if (!allowed(state.access.readSource)) return blocked(state, "PROVENANCE_READ_NOT_ALLOWED", "Version history is not available under the current read authority.");
      if (!state.transcript.versionId && state.captionHistory.length === 0) return blocked(state, "PROVENANCE_NOT_READY", "No transcript or caption version history is available yet.");
      return result(state, [], "Source, transcript, and caption-version lineage is available for inspection.");
    }
    case "media.action.correct-caption": {
      if (!canSelectSource(state) || !state.source.selected) return blocked(state, "SOURCE_NOT_READY", "Select an available source version before editing captions.");
      if (state.captionDraft.hasConflict) return blocked(state, "CAPTION_VERSION_CONFLICT", "Compare the competing versions and resolve the conflict before editing.");
      if (!allowed(state.access.editDerivedContent)) return blocked(state, "EDIT_AUTHORITY_NOT_ALLOWED", "Caption editing is not allowed in this scenario.");
      if (!action.text.trim()) return blocked(state, "CAPTION_TEXT_REQUIRED", "Enter caption text before saving the draft.");
      const segments = replaceSegment(state.captionDraft.segments, action.segmentId, (segment) => ({
        ...segment,
        text: action.text,
        origin: "USER_EDITED",
      }));
      if (!segments) return blocked(state, "CAPTION_SEGMENT_NOT_FOUND", "The selected caption segment is no longer available.");
      return result(withDraftSegments(state, segments, action.type), ["media.effect.caption-draft-updated"], "Caption draft updated; the source recording and earlier versions are unchanged.");
    }
    case "media.action.compare-caption-versions": {
      if (!allowed(state.access.readSource)) return blocked(state, "SOURCE_READ_NOT_ALLOWED", "Caption versions are not available under the current read authority.");
      const left = state.captionHistory.find((version) => version.versionId === action.leftVersionId);
      const right = state.captionHistory.find((version) => version.versionId === action.rightVersionId);
      if (!left || !right || left.versionId === right.versionId) {
        return blocked(state, "CAPTION_VERSIONS_NOT_COMPARABLE", "Choose two distinct readable caption versions.");
      }
      const sameSource = left.sourceArtifactVersion === right.sourceArtifactVersion;
      return result(state, [], sameSource
        ? "The selected caption versions share the same source recording version."
        : "The selected caption versions use different source recording versions; differences may not be comparable.");
    }
    case "media.action.resolve-caption-conflict": {
      if (!state.captionDraft.hasConflict) return blocked(state, "CAPTION_CONFLICT_NOT_PRESENT", "There is no unresolved caption conflict to resolve.");
      if (!canSelectSource(state) || !state.source.selected) return blocked(state, "SOURCE_NOT_READY", "Select an available source version before resolving this conflict.");
      if (!allowed(state.access.editDerivedContent)) return blocked(state, "EDIT_AUTHORITY_NOT_ALLOWED", "Caption conflict resolution is not allowed in this scenario.");
      const latest = state.captionHistory.at(-1);
      if (!latest) return blocked(state, "CURRENT_CAPTION_VERSION_NOT_FOUND", "The latest caption version is not available; preserve the local draft and request review.");
      const segments = action.resolution === "keep-local"
        ? state.captionDraft.segments.map((segment) => ({ ...segment }))
        : latest.segments.map((segment) => ({ ...segment }));
      const nextDraft = {
        ...state.captionDraft,
        versionId: `simulation-${fixtureKey(state.scenarioId)}-caption-draft-resolved-${state.sequence + 1}`,
        parentVersionId: latest.versionId,
        timingDisposition: getTimingDisposition(segments),
        hasConflict: false,
        segments,
      };
      return result({
        ...state,
        captionDraft: nextDraft,
        sequence: state.sequence + 1,
        eventLog: appendEvent(state, `${action.type}:${action.resolution}`),
      }, ["media.effect.caption-conflict-resolved"], action.resolution === "keep-local"
        ? "Local edits are preserved as a draft based on the latest caption version."
        : "The local draft now follows the latest caption version; both prior versions remain unchanged.");
    }
    case "media.action.align-caption-timing": {
      if (!canSelectSource(state) || !state.source.selected) return blocked(state, "SOURCE_NOT_READY", "Select an available source version before aligning captions.");
      if (state.captionDraft.hasConflict) return blocked(state, "CAPTION_VERSION_CONFLICT", "Compare the competing versions and resolve the conflict before editing.");
      if (!allowed(state.access.editDerivedContent)) return blocked(state, "EDIT_AUTHORITY_NOT_ALLOWED", "Caption timing cannot be changed in this scenario.");
      const validTicks = Number.isSafeInteger(action.startTick) && Number.isSafeInteger(action.endTick) &&
        action.startTick >= 0 && action.endTick > action.startTick && action.endTick <= state.source.durationTicks;
      if (!validTicks) return blocked(state, "CAPTION_TIMING_INVALID", "Enter a valid half-open time range on the source recording clock.");
      const segments = replaceSegment(state.captionDraft.segments, action.segmentId, (segment) => ({
        ...segment,
        startTick: action.startTick,
        endTick: action.endTick,
        origin: "USER_EDITED",
      }));
      if (!segments) return blocked(state, "CAPTION_SEGMENT_NOT_FOUND", "The selected caption segment is no longer available.");
      return result(withDraftSegments(state, segments, action.type), ["media.effect.caption-timing-updated"], "Caption timing updated on the source media clock.");
    }
    case "media.action.save-caption-version": {
      if (!allowed(state.access.registerDerivedVersion)) return blocked(state, "VERSION_REGISTRATION_NOT_ALLOWED", "This caption version cannot be registered under the current fixture authority.");
      if (!state.source.selected || state.source.lifecycle !== "AVAILABLE") return blocked(state, "SOURCE_NOT_READY", "Select an available source version before saving captions.");
      if (!state.captionDraft.segments.length) return blocked(state, "CAPTION_DRAFT_EMPTY", "Add caption content before saving a version.");
      if (state.captionDraft.hasConflict) return blocked(state, "CAPTION_VERSION_CONFLICT", "Compare the competing versions before saving a new caption version.");
      const aligned = state.captionDraft.segments.every((segment) =>
        Number.isSafeInteger(segment.startTick) && Number.isSafeInteger(segment.endTick) &&
        segment.startTick !== null && segment.endTick !== null && segment.endTick > segment.startTick,
      );
      if (!aligned) return blocked(state, "CAPTION_ALIGNMENT_REQUIRED", "Correct every caption time range before saving this version.");
      const versionId = `simulation-${fixtureKey(state.scenarioId)}-caption-v${state.registeredCaptionVersions.length + 1}`;
      const parentVersionId = state.captionDraft.parentVersionId ?? state.transcript.versionId ?? state.source.artifactVersion;
      const registeredVersion: CaptionVersionRecord = {
        versionId,
        sourceArtifactVersion: state.source.artifactVersion,
        parentVersionId,
        ...(action.purpose?.trim() ? { purpose: action.purpose.trim() } : {}),
        segments: state.captionDraft.segments.map((segment) => ({ ...segment })),
      };
      return result({
        ...state,
        captionDraft: { ...state.captionDraft, versionId, parentVersionId: versionId },
        registeredCaptionVersions: [...state.registeredCaptionVersions, versionId],
        captionHistory: [...state.captionHistory, registeredVersion],
        sequence: state.sequence + 1,
        eventLog: appendEvent(state, `${action.type}:${versionId}`),
      }, ["media.effect.caption-version-registered"], "A new caption version is saved; it has not been delivered or published.");
    }
    case "media.action.request-cancellation": {
      if (!state.job.jobId) return blocked(state, "JOB_NOT_FOUND", "There is no transcription job to stop.");
      if (!allowed(state.access.cancelJob)) return blocked(state, "CANCELLATION_NOT_ALLOWED", "Cancellation is not allowed under the current job authority.");
      if (state.job.state === "QUEUED") {
        return result({
          ...state,
          job: { ...state.job, state: "CANCELLED", attemptState: "CANCEL_CONFIRMED", finality: "CONFIRMED" },
          sequence: state.sequence + 1,
          eventLog: appendEvent(state, action.type),
        }, ["media.effect.job-cancelled-before-dispatch"], "The queued request was stopped before dispatch.");
      }
      if (state.job.state === "RUNNING") {
        if (state.job.attemptState === "CANCEL_REQUESTED") {
          return blocked(state, "CANCELLATION_ALREADY_PENDING", "Cancellation is already requested; wait for the owning job to confirm its final state.");
        }
        return result({
          ...state,
          job: { ...state.job, attemptState: "CANCEL_REQUESTED", finality: "PENDING" },
          sequence: state.sequence + 1,
          eventLog: appendEvent(state, action.type),
        }, ["media.effect.cancellation-requested"], "Cancellation is requested; the stop is not confirmed yet.");
      }
      if (state.job.state === "OUTCOME_UNKNOWN" || state.job.state === "RECONCILING") {
        return blocked(state, "JOB_OUTCOME_CHECK_REQUIRED", "Check the existing job outcome before taking another action.");
      }
      return blocked(state, "JOB_NOT_CANCELLABLE", "This job is not in a cancellable state.");
    }
    case "media.action.check-job-outcome": {
      if (!state.job.jobId) return blocked(state, "JOB_NOT_FOUND", "There is no transcription job to check.");
      if (!allowed(state.access.checkJobOutcome)) return blocked(state, "JOB_OUTCOME_CHECK_NOT_ALLOWED", "This job outcome cannot be checked under the current authority.");
      if (state.job.state !== "OUTCOME_UNKNOWN") return blocked(state, "JOB_NOT_UNCERTAIN", "Only an uncertain job outcome can be checked.");
      return result({
        ...state,
        job: { ...state.job, state: "RECONCILING", finality: "UNKNOWN" },
        sequence: state.sequence + 1,
        eventLog: appendEvent(state, action.type),
      }, ["media.effect.existing-job-outcome-check-started"], "The existing request is being checked; no new transcription was submitted.");
    }
    default: {
      const unreachable: never = action;
      return blocked(state, "ACTION_NOT_SUPPORTED", `Unsupported action: ${String(unreachable)}`);
    }
  }
}

export function applySimulationEvent(state: MediaExperienceState, event: SimulationEvent): TransitionResult {
  if (!isSimulationEvent(event)) return blocked(state, "SIMULATION_EVENT_NOT_SUPPORTED", "This fixture event has an unknown or invalid shape.");
  if (state.workflow === "first-use") {
    return blocked(state, "EVENT_NOT_SUPPORTED_IN_FIRST_USE", "Processing-job and consent events belong to a different Media workflow.");
  }
  if (state.workflow === "artifact-intake") {
    return blocked(state, "EVENT_NOT_SUPPORTED_IN_ARTIFACT_INTAKE", "This fixture event belongs to a processing-job workflow.");
  }
  if (state.workflow === "artifact-verification") {
    return blocked(state, "EVENT_NOT_SUPPORTED_IN_ARTIFACT_VERIFICATION", "Artifact verification outcomes are fixed by this synthetic scenario; no owner service is connected.");
  }
  if (event.type === "consent.revoked") {
    const queued = state.job.state === "QUEUED";
    const running = state.job.state === "RUNNING";
    const nextState: MediaExperienceState = {
      ...state,
      consentState: "REVOKED",
      access: { ...state.access, processSource: "DENIED", registerDerivedVersion: "DENIED" },
      job: queued
        ? { ...state.job, state: "CANCELLED", attemptState: "CANCEL_CONFIRMED", finality: "CONFIRMED" }
        : running
          ? { ...state.job, attemptState: "CANCEL_REQUESTED", finality: "PENDING" }
          : state.job,
      sequence: state.sequence + 1,
      eventLog: appendEvent(state, event.type),
    };
    return result(nextState, ["media.effect.consent-revoked", ...(queued || running ? ["media.effect.in-flight-work-requires-outcome-check"] : [])], "Consent changed; new processing is blocked and any active effect remains visible.");
  }
  if (event.type === "job.started") {
    if (state.job.state !== "QUEUED") return blocked(state, "JOB_CANNOT_START_FROM_CURRENT_STATE", "The fixture job is not queued.");
    return result({ ...state, job: { ...state.job, state: "RUNNING", attemptState: "RUNNING", finality: "PENDING" }, sequence: state.sequence + 1, eventLog: appendEvent(state, event.type) }, ["media.effect.simulated-job-started"], "The simulated transcription job started.");
  }
  if (event.type === "job.completed") {
    if (state.job.state !== "RUNNING") return blocked(state, "JOB_CANNOT_COMPLETE_FROM_CURRENT_STATE", "The fixture job is not running.");
    const completedState: MediaExperienceState = {
      ...state,
      job: { ...state.job, state: "COMPLETED", attemptState: "SUCCEEDED", finality: "CONFIRMED" },
      sequence: state.sequence + 1,
      eventLog: appendEvent(state, event.type),
    };
    const nextState: MediaExperienceState = state.consentState === "REVOKED"
      ? completedState
      : completedJobState(completedState);
    if (state.consentState === "REVOKED") {
      return result(nextState, ["media.effect.simulated-job-completed-result-lifecycle-pending"], "The simulated job completed; result handling remains subject to the pending rights and consent lifecycle decision.");
    }
    return result(nextState, ["media.effect.simulated-transcript-available"], "The simulated transcript is ready to review.");
  }
  if (event.type === "job.outcome-unknown") {
    if (state.job.state !== "RUNNING") return blocked(state, "JOB_CANNOT_BECOME_UNKNOWN_FROM_CURRENT_STATE", "The fixture job is not running.");
    return result({ ...state, job: { ...state.job, state: "OUTCOME_UNKNOWN", attemptState: "OUTCOME_UNKNOWN", finality: "UNKNOWN" }, sequence: state.sequence + 1, eventLog: appendEvent(state, event.type) }, ["media.effect.simulated-outcome-unknown"], "The simulated remote outcome is unknown; check this job outcome before submitting another request.");
  }
  if (event.type === "job.cancellation-confirmed") {
    if (state.job.state !== "RUNNING" || state.job.attemptState !== "CANCEL_REQUESTED") return blocked(state, "CANCELLATION_NOT_PENDING", "No simulated cancellation is awaiting confirmation.");
    return result({ ...state, job: { ...state.job, state: "CANCELLED", attemptState: "CANCEL_CONFIRMED", finality: "CONFIRMED" }, sequence: state.sequence + 1, eventLog: appendEvent(state, event.type) }, ["media.effect.simulated-cancellation-confirmed"], "The fixture confirms that processing stopped.");
  }
  if (event.type === "job.outcome-check-completed") {
    if (state.job.state !== "RECONCILING") return blocked(state, "OUTCOME_CHECK_NOT_ACTIVE", "A job outcome check is not in progress.");
    const jobState: MediaExperienceState["job"]["state"] = event.outcome === "UNKNOWN" ? "OUTCOME_UNKNOWN" : event.outcome;
    const finality: MediaExperienceState["job"]["finality"] = event.outcome === "UNKNOWN" ? "UNKNOWN" : "CONFIRMED";
    const attemptState: MediaExperienceState["job"]["attemptState"] = event.outcome === "COMPLETED" ? "SUCCEEDED" : event.outcome === "CANCELLED" ? "CANCEL_CONFIRMED" : event.outcome === "FAILED" ? "FAILED" : "OUTCOME_UNKNOWN";
    const outcomeCheckedState: MediaExperienceState = { ...state, job: { ...state.job, state: jobState, attemptState, finality }, sequence: state.sequence + 1, eventLog: appendEvent(state, `${event.type}:${event.outcome}`) };
    const resultState = event.outcome === "COMPLETED" && state.consentState !== "REVOKED"
      ? completedJobState(outcomeCheckedState)
      : outcomeCheckedState;
    return result(resultState, ["media.effect.simulated-outcome-check-recorded"], event.outcome === "UNKNOWN" ? "No confirming evidence was available; the outcome remains unknown." : `The existing job outcome is recorded as ${event.outcome.toLowerCase()}.`);
  }
  return blocked(state, "SIMULATION_EVENT_NOT_SUPPORTED", "This fixture event is not supported.");
}

export function availableActionIds(state: MediaExperienceState): readonly string[] {
  if (state.workflow === "first-use") {
    const firstUse = state.firstUse;
    const actions: string[] = [];
    if (firstUse.identityResolved && firstUse.workspaceAccess === "ALLOWED" &&
      firstUse.projectCreateAuthority === "ALLOWED" && firstUse.creationStatus === "NOT_REQUESTED") {
      actions.push("media.action.create-project");
    }
    if (firstUse.identityResolved && firstUse.workspaceAccess === "ALLOWED" && firstUse.creationStatus === "OUTCOME_UNKNOWN") {
      actions.push("media.action.inspect-project-creation");
    }
    return actions;
  }
  if (state.workflow === "artifact-intake") {
    const actions: string[] = [];
    if (state.artifactIntake.artifactReadAuthority === "ALLOWED") actions.push("media.action.inspect-artifact");
    if (state.artifactIntake.status === "INTERRUPTED" &&
      state.artifactIntake.uploadResumeAuthority === "ALLOWED" &&
      state.artifactIntake.sourceMetadataMatches && state.artifactIntake.workspaceMatches) {
      actions.push("media.action.resume-artifact-upload");
    }
    return actions;
  }
  if (state.workflow === "artifact-verification") {
    const actions: string[] = [];
    if (allowed(state.access.viewJobStatus)) actions.push("media.action.view-job-status");
    if (state.artifactVerification.status === "OUTCOME_UNKNOWN" && allowed(state.access.checkJobOutcome)) {
      actions.push("media.action.check-job-outcome");
    }
    return actions;
  }
  const actions: string[] = [];
  if (state.job.jobId && allowed(state.access.viewJobStatus)) actions.push("media.action.view-job-status");
  if (state.job.state === "OUTCOME_UNKNOWN" && allowed(state.access.checkJobOutcome)) actions.push("media.action.check-job-outcome");
  if ((state.job.state === "QUEUED" || (state.job.state === "RUNNING" && state.job.attemptState !== "CANCEL_REQUESTED")) && allowed(state.access.cancelJob)) {
    actions.push("media.action.request-cancellation");
  }
  if (allowed(state.access.readSource)) actions.push("media.action.inspect-source");
  if (canSelectSource(state) && !state.source.selected) actions.push("media.action.choose-source");
  if (canSelectSource(state) && state.source.selected) actions.push("media.action.seek-source");
  if (state.job.state === "NOT_SUBMITTED" && state.source.selected && state.consentState === "ACTIVE" && allowed(state.access.processSource)) {
    actions.push("media.action.request-transcription");
  }
  if (state.transcript.versionId && allowed(state.access.readSource)) actions.push("media.action.review-transcript");
  if (state.captionHistory.length > 0 && allowed(state.access.readSource)) actions.push("media.action.inspect-provenance");
  if (state.source.selected && state.source.lifecycle === "AVAILABLE" && state.captionDraft.segments.length) {
    if (state.captionDraft.hasConflict) {
      if (allowed(state.access.editDerivedContent)) actions.push("media.action.resolve-caption-conflict");
    } else if (allowed(state.access.editDerivedContent)) {
      actions.push("media.action.correct-caption", "media.action.align-caption-timing");
    }
    const readyToSave = !state.captionDraft.hasConflict && getTimingDisposition(state.captionDraft.segments) === "ALIGNED";
    if (readyToSave && allowed(state.access.registerDerivedVersion)) actions.push("media.action.save-caption-version");
  }
  if (state.captionHistory.length > 1 && allowed(state.access.readSource)) actions.push("media.action.compare-caption-versions");
  return actions;
}

export interface ExperienceProjection {
  readonly isSimulation: true;
  readonly scenarioId: ScenarioId;
  readonly workflow: MediaExperienceState["workflow"];
  readonly firstUse: FirstUseState | null;
  readonly artifactIntake: MediaExperienceState["artifactIntake"];
  readonly artifactVerification: ArtifactVerificationState | null;
  readonly source: MediaExperienceState["source"] | null;
  readonly consentState: MediaExperienceState["consentState"] | null;
  readonly job: MediaExperienceState["job"] | null;
  readonly transcript: MediaExperienceState["transcript"] | null;
  readonly captionDraft: MediaExperienceState["captionDraft"] | null;
  readonly registeredCaptionVersions: readonly string[];
  readonly captionHistory: MediaExperienceState["captionHistory"];
  readonly safeActionIds: readonly string[];
  readonly eventLog: readonly string[];
}

export function projectExperience(state: MediaExperienceState): ExperienceProjection {
  return {
    isSimulation: true,
    scenarioId: state.scenarioId,
    workflow: state.workflow,
    firstUse: state.workflow === "first-use" ? state.firstUse : null,
    artifactIntake: state.artifactIntake,
    artifactVerification: state.workflow === "artifact-verification" ? state.artifactVerification : null,
    source: state.workflow === "transcription" ? state.source : null,
    consentState: state.workflow === "transcription" ? state.consentState : null,
    job: state.workflow === "transcription" ? state.job : null,
    transcript: state.workflow === "transcription" ? state.transcript : null,
    captionDraft: state.workflow === "transcription" ? state.captionDraft : null,
    registeredCaptionVersions: state.registeredCaptionVersions,
    captionHistory: state.captionHistory,
    safeActionIds: availableActionIds(state),
    eventLog: state.eventLog,
  };
}

/** Terminal JSON serializes the shared projection; it does not establish an API endpoint. */
export function projectJson(state: MediaExperienceState): string {
  return JSON.stringify(projectExperience(state));
}

export { createMediaProductExperiencePackage, MEDIA_EXPERIENCE_SOURCE_REFS } from "./product-experience-package.js";

export { formatMediaCliError, formatMediaCliHumanResult, mediaCliHelp, parseMediaCommand, requestedMediaCliFormat } from "./cli.js";
export type { MediaCliFormat, MediaCliHumanReport, MediaCliParseResult } from "./cli.js";
