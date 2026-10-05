import type {
  ArtifactVerificationExperienceState,
  ArtifactVerificationState,
  ArtifactIntakeExperienceState,
  FirstUseExperienceState,
  FixtureId,
  MediaExperienceState,
  ScenarioId,
  TimedTextSegment,
  TranscriptionExperienceState,
} from "./model.js";

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
