import assert from "node:assert/strict";
import test from "node:test";
import {
  applySimulationEvent,
  createFixtureState,
  projectExperience,
  projectJson,
  reduceMediaExperience,
} from "../dist/index.js";

test("caption edits replay deterministically without changing the source", () => {
  const initial = createFixtureState("media.scenario.transcript-ready");
  const action = {
    type: "media.action.correct-caption",
    segmentId: "segment-001",
    text: "When the signal returns, mark the time.",
  };

  const first = reduceMediaExperience(initial, action);
  const replay = reduceMediaExperience(createFixtureState("media.scenario.transcript-ready"), action);

  assert.deepEqual(first, replay);
  assert.equal(first.applied, true);
  assert.deepEqual(first.state.source, initial.source);
  assert.equal(first.state.captionDraft.segments[0].text, action.text);
  assert.equal(first.state.captionHistory[0].segments[0].text, "When the signal returns, record the time.");
});

test("source-clock timing must be complete before registering a caption version", () => {
  const initial = createFixtureState("media.scenario.alignment-required");
  const blockedSave = reduceMediaExperience(initial, { type: "media.action.save-caption-version" });

  assert.equal(blockedSave.applied, false);
  assert.equal(blockedSave.reasonCode, "CAPTION_ALIGNMENT_REQUIRED");
  assert.deepEqual(blockedSave.state.registeredCaptionVersions, initial.registeredCaptionVersions);

  const aligned = reduceMediaExperience(initial, {
    type: "media.action.align-caption-timing",
    segmentId: "segment-002",
    startTick: 3400,
    endTick: 6500,
  });
  assert.equal(aligned.applied, true);

  const saved = reduceMediaExperience(aligned.state, { type: "media.action.save-caption-version" });
  assert.equal(saved.applied, true);
  assert.equal(saved.state.source.artifactVersion, initial.source.artifactVersion);
  assert.equal(saved.state.registeredCaptionVersions.length, 2);
  assert.equal(saved.state.captionHistory.at(-1).sourceArtifactVersion, initial.source.artifactVersion);
});

test("synthetic source seek uses segment start-inclusive and end-exclusive tick boundaries", () => {
  const initial = createFixtureState("media.scenario.transcript-ready");

  const atStart = reduceMediaExperience(initial, { type: "media.action.seek-source", timeTick: 0 });
  assert.equal(atStart.applied, true);
  assert.equal(atStart.state.selectedSegmentId, "segment-001");

  const atEnd = reduceMediaExperience(initial, { type: "media.action.seek-source", timeTick: 3100 });
  assert.equal(atEnd.applied, true);
  assert.equal(atEnd.state.selectedSegmentId, null);

  const atSourceDuration = reduceMediaExperience(initial, {
    type: "media.action.seek-source",
    timeTick: initial.source.durationTicks,
  });
  assert.equal(atSourceDuration.applied, true);
  assert.equal(atSourceDuration.state.playbackPositionTick, initial.source.durationTicks);
});

test("an unknown job remains bound to the same identity through outcome checking", () => {
  const initial = createFixtureState("media.scenario.job-outcome-unknown");
  const duplicate = reduceMediaExperience(initial, {
    type: "media.action.request-transcription",
    languageTag: "en",
  });

  assert.equal(duplicate.applied, false);
  assert.equal(duplicate.reasonCode, "EXISTING_JOB_REQUIRES_REVIEW");
  assert.equal(duplicate.state.job.jobId, initial.job.jobId);

  const outcomeCheck = reduceMediaExperience(initial, { type: "media.action.check-job-outcome" });
  assert.equal(outcomeCheck.applied, true);
  assert.equal(outcomeCheck.state.job.jobId, initial.job.jobId);
  assert.equal(outcomeCheck.state.job.state, "RECONCILING");

  const result = applySimulationEvent(outcomeCheck.state, {
    type: "job.outcome-check-completed",
    outcome: "UNKNOWN",
  });
  assert.equal(result.state.job.jobId, initial.job.jobId);
  assert.equal(result.state.job.state, "OUTCOME_UNKNOWN");
  assert.equal(result.state.job.finality, "UNKNOWN");
});

test("retry-ineligible fixture covers only the source-declared unknown-outcome no-dispatch branch", () => {
  const state = createFixtureState("media.scenario.job-retry-ineligible");
  const projection = projectExperience(state);
  assert.equal(state.job.jobId, "fixture-transcription-job-unknown");
  assert.equal(state.job.state, "OUTCOME_UNKNOWN");
  assert.equal(state.job.attemptState, "OUTCOME_UNKNOWN");
  assert.equal(state.job.finality, "UNKNOWN");
  assert.ok(projection.safeActionIds.includes("media.action.check-job-outcome"));
  assert.ok(!projection.safeActionIds.includes("media.action.retry-job"));

  const attemptedRetry = reduceMediaExperience(state, { type: "media.action.retry-job" });
  assert.equal(attemptedRetry.applied, false);
  assert.equal(attemptedRetry.state.job.jobId, state.job.jobId);
  assert.equal(attemptedRetry.state.job.state, "OUTCOME_UNKNOWN");
  assert.equal(attemptedRetry.state.eventLog.length, state.eventLog.length);
});

test("a result is not materialized after consent is revoked during processing", () => {
  const running = createFixtureState("media.scenario.job-running");
  const revoked = applySimulationEvent(running, { type: "consent.revoked" });
  const completed = applySimulationEvent(revoked.state, { type: "job.completed" });

  assert.equal(revoked.state.consentState, "REVOKED");
  assert.equal(revoked.state.job.attemptState, "CANCEL_REQUESTED");
  assert.equal(completed.state.job.state, "COMPLETED");
  assert.equal(completed.state.transcript.versionId, null);
  assert.ok(completed.effectIds.includes("media.effect.simulated-job-completed-result-lifecycle-pending"));
});

test("terminal output is a serialization of the same deterministic product projection", () => {
  const state = createFixtureState("media.scenario.caption-corrected");
  const objectProjection = projectExperience(state);
  const terminalProjection = JSON.parse(projectJson(state));

  assert.deepEqual(terminalProjection, objectProjection);
  assert.equal(terminalProjection.isSimulation, true);
  assert.equal(terminalProjection.scenarioId, "media.scenario.caption-corrected");
});

test("malformed action and event payloads fail closed without changing fixture state", () => {
  const state = createFixtureState("media.scenario.transcript-ready");
  const missingLanguage = reduceMediaExperience(state, { type: "media.action.request-transcription" });
  const invalidResolution = reduceMediaExperience(state, {
    type: "media.action.resolve-caption-conflict",
    resolution: "use-newest",
  });
  const missingOutcome = applySimulationEvent(state, { type: "job.outcome-check-completed" });

  assert.equal(missingLanguage.applied, false);
  assert.equal(missingLanguage.reasonCode, "ACTION_NOT_SUPPORTED");
  assert.equal(invalidResolution.applied, false);
  assert.equal(invalidResolution.reasonCode, "ACTION_NOT_SUPPORTED");
  assert.equal(missingOutcome.applied, false);
  assert.equal(missingOutcome.reasonCode, "SIMULATION_EVENT_NOT_SUPPORTED");
  assert.deepEqual(state, createFixtureState("media.scenario.transcript-ready"));
});

test("artifact intake fixtures keep transfer identity and integrity separate from processing jobs", () => {
  const interrupted = createFixtureState("media.scenario.upload-interrupted");
  const projection = projectExperience(interrupted);

  assert.equal(interrupted.workflow, "artifact-intake");
  assert.equal(projection.source, null);
  assert.equal(projection.job, null);
  assert.equal(projection.transcript, null);
  assert.equal(projection.consentState, null);
  assert.equal(interrupted.job.jobId, null);
  assert.equal(interrupted.artifactIntake.uploadId, "fixture-upload-interrupted-001");
  assert.equal(interrupted.artifactIntake.status, "INTERRUPTED");
  assert.equal(interrupted.artifactIntake.acknowledgedPartCount, 2);
  assert.ok(projection.safeActionIds.includes("media.action.inspect-artifact"));
  assert.ok(projection.safeActionIds.includes("media.action.resume-artifact-upload"));

  const wrongWorkflowAction = reduceMediaExperience(interrupted, {
    type: "media.action.request-transcription",
    languageTag: "en",
  });
  const wrongWorkflowEvent = applySimulationEvent(interrupted, { type: "job.started" });
  assert.equal(wrongWorkflowAction.applied, false);
  assert.equal(wrongWorkflowAction.reasonCode, "ACTION_NOT_SUPPORTED_IN_ARTIFACT_INTAKE");
  assert.equal(wrongWorkflowEvent.applied, false);
  assert.equal(wrongWorkflowEvent.reasonCode, "EVENT_NOT_SUPPORTED_IN_ARTIFACT_INTAKE");

  const resumed = reduceMediaExperience(interrupted, { type: "media.action.resume-artifact-upload" });
  assert.equal(resumed.applied, true);
  assert.equal(resumed.state.artifactIntake.uploadId, interrupted.artifactIntake.uploadId);
  assert.equal(resumed.state.artifactIntake.acknowledgedPartCount, interrupted.artifactIntake.acknowledgedPartCount);
  assert.equal(resumed.state.artifactIntake.status, "RECEIVING");
  assert.equal(resumed.state.job.jobId, null);
  assert.match(resumed.message, /no file bytes were transferred/);
});

test("unknown, rejected, quarantined, and access-revoked artifact fixtures fail closed", () => {
  const unknown = createFixtureState("media.scenario.upload-outcome-unknown");
  const blindResume = reduceMediaExperience(unknown, { type: "media.action.resume-artifact-upload" });
  assert.equal(blindResume.applied, false);
  assert.equal(blindResume.reasonCode, "UPLOAD_NOT_RESUMABLE");
  assert.equal(blindResume.state.artifactIntake.uploadId, unknown.artifactIntake.uploadId);
  assert.equal(unknown.artifactIntake.status, "OUTCOME_UNKNOWN");

  const mismatch = createFixtureState("media.scenario.upload-checksum-mismatch");
  assert.equal(mismatch.artifactIntake.status, "REJECTED");
  assert.equal(mismatch.artifactIntake.integrity, "MISMATCH");
  assert.equal(mismatch.artifactIntake.artifactVersion, null);

  const quarantined = createFixtureState("media.scenario.upload-quarantined");
  assert.equal(quarantined.artifactIntake.status, "QUARANTINED");
  assert.equal(quarantined.artifactIntake.integrity, "QUARANTINED");

  const revoked = createFixtureState("media.scenario.upload-permission-revoked");
  assert.deepEqual(projectExperience(revoked).safeActionIds, []);
  const inspect = reduceMediaExperience(revoked, { type: "media.action.inspect-artifact" });
  assert.equal(inspect.applied, false);
  assert.equal(inspect.reasonCode, "ARTIFACT_READ_NOT_ALLOWED");
});

test("first-use fixtures hide protected context and preserve uncertain project creation identity", () => {
  const empty = createFixtureState("media.scenario.first-use-empty");
  assert.equal(empty.workflow, "first-use");
  assert.equal(projectExperience(empty).source, null);
  assert.equal(projectExperience(empty).job, null);
  assert.equal(projectExperience(empty).transcript, null);
  assert.equal(projectExperience(empty).consentState, null);
  assert.equal(empty.job.jobId, null);
  assert.ok(projectExperience(empty).safeActionIds.includes("media.action.create-project"));

  const created = reduceMediaExperience(empty, { type: "media.action.create-project" });
  assert.equal(created.applied, true);
  assert.equal(created.state.firstUse.projectId, "fixture-project-001");
  assert.equal(created.state.firstUse.projectVersion, "project-v1");
  assert.equal(created.state.job.jobId, null);
  const duplicate = reduceMediaExperience(created.state, { type: "media.action.create-project" });
  assert.equal(duplicate.applied, false);
  assert.equal(duplicate.reasonCode, "PROJECT_CREATE_ALREADY_REQUESTED");

  const identityRequired = createFixtureState("media.scenario.identity-required");
  assert.equal(identityRequired.firstUse.workspaceId, null);
  assert.deepEqual(projectExperience(identityRequired).safeActionIds, []);
  const unauthorizedCreate = reduceMediaExperience(identityRequired, { type: "media.action.create-project" });
  assert.equal(unauthorizedCreate.applied, false);
  assert.equal(unauthorizedCreate.reasonCode, "IDENTITY_NOT_ESTABLISHED");

  const deniedWorkspace = createFixtureState("media.scenario.workspace-access-denied");
  assert.deepEqual(projectExperience(deniedWorkspace).safeActionIds, []);
  assert.equal(deniedWorkspace.firstUse.workspaceId, null);
  assert.equal(deniedWorkspace.firstUse.projectId, null);

  const unknown = createFixtureState("media.scenario.project-create-outcome-unknown");
  const requestId = unknown.firstUse.createRequestId;
  const inspect = reduceMediaExperience(unknown, { type: "media.action.inspect-project-creation" });
  assert.equal(inspect.applied, true);
  assert.equal(inspect.state.firstUse.createRequestId, requestId);
  assert.equal(inspect.state.firstUse.creationStatus, "OUTCOME_UNKNOWN");
  const blindRetry = reduceMediaExperience(unknown, { type: "media.action.create-project" });
  assert.equal(blindRetry.applied, false);
  assert.equal(blindRetry.reasonCode, "PROJECT_CREATE_ALREADY_REQUESTED");
  assert.match(inspect.message, /no authoritative project lookup is connected/);

  const intentUnavailable = createFixtureState("media.scenario.intent-unavailable");
  assert.equal(intentUnavailable.firstUse.creationStatus, "CREATED");
  assert.equal(intentUnavailable.firstUse.intentDisposition, "UNAVAILABLE");
  const jobEvent = applySimulationEvent(intentUnavailable, { type: "job.started" });
  assert.equal(jobEvent.applied, false);
  assert.equal(jobEvent.reasonCode, "EVENT_NOT_SUPPORTED_IN_FIRST_USE");
});

test("artifact verification keeps the owner job separate from its upload and retains unknown finality", () => {
  const running = createFixtureState("media.scenario.artifact-verification-running");
  const runningProjection = projectExperience(running);
  assert.equal(running.workflow, "artifact-verification");
  assert.equal(runningProjection.artifactIntake, null);
  assert.equal(runningProjection.job, null);
  assert.equal(runningProjection.source, null);
  assert.equal(runningProjection.artifactVerification.jobId, "fixture-artifact-verification-job-running-001");
  assert.equal(runningProjection.artifactVerification.uploadId, "fixture-upload-verified-available-001");
  assert.notEqual(runningProjection.artifactVerification.jobId, runningProjection.artifactVerification.uploadId);
  const statusView = reduceMediaExperience(running, { type: "media.action.view-job-status" });
  assert.equal(statusView.applied, true);
  assert.equal(statusView.state.artifactVerification.jobId, runningProjection.artifactVerification.jobId);

  const unknown = createFixtureState("media.scenario.artifact-verification-outcome-unknown");
  const unknownProjection = projectExperience(unknown);
  assert.deepEqual(unknownProjection.safeActionIds, ["media.action.view-job-status", "media.action.check-job-outcome"]);
  const outcomeCheck = reduceMediaExperience(unknown, { type: "media.action.check-job-outcome" });
  assert.equal(outcomeCheck.applied, true);
  assert.equal(outcomeCheck.state.artifactVerification.status, "OUTCOME_UNKNOWN");
  assert.equal(outcomeCheck.state.artifactVerification.finality, "UNKNOWN");
  assert.equal(outcomeCheck.state.artifactVerification.jobId, unknownProjection.artifactVerification.jobId);
  assert.equal(outcomeCheck.state.artifactVerification.uploadId, unknownProjection.artifactVerification.uploadId);
  assert.match(outcomeCheck.message, /no owner-issued evidence is connected/);
  assert.equal(applySimulationEvent(unknown, { type: "job.completed" }).reasonCode, "EVENT_NOT_SUPPORTED_IN_ARTIFACT_VERIFICATION");

  const completed = createFixtureState("media.scenario.artifact-verification-completed");
  const completedProjection = projectExperience(completed);
  assert.equal(completedProjection.artifactVerification.finality, "CONFIRMED");
  assert.equal(completedProjection.artifactVerification.status, "COMPLETED");
  assert.equal(completedProjection.artifactIntake, null);
  assert.deepEqual(completedProjection.artifactVerification.evidence, [
    "fixture-size-and-digest-matched",
    "fixture-format-admitted",
    "fixture-policy-check-recorded",
  ]);
});
