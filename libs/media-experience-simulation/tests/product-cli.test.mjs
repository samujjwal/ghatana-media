import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import {
  applySimulationEvent,
  createFixtureState,
  formatMediaCliError,
  parseMediaCommand,
  reduceMediaExperience,
  requestedMediaCliFormat,
} from "../dist/index.js";

const execFileAsync = promisify(execFile);

test("parses a canonical transcription command and normalizes a valid language tag", () => {
  const state = createFixtureState("media.scenario.source-available");
  const parsed = parseMediaCommand(state, "ghatana-media transcribe --source-version source-v1 --language en-us --format json");
  assert.equal(parsed.kind, "action");
  assert.equal(parsed.commandId, "media.cli.transcribe");
  assert.deepEqual(parsed.action, { type: "media.action.request-transcription", languageTag: "en-US" });
  assert.equal(parsed.format, "json");
});

test("rejects stale source versions, duplicate flags, and unknown options", () => {
  const state = createFixtureState("media.scenario.source-available");
  assert.match(parseMediaCommand(state, "ghatana-media transcribe --source-version old --language en").message, /not the current source version/);
  assert.match(parseMediaCommand(state, "ghatana-media transcribe --source-version source-v1 --source-version source-v1 --language en").message, /only be supplied once/);
  assert.match(parseMediaCommand(state, "ghatana-media transcribe --source-version source-v1 --language en --force").message, /Unknown option/);
});

test("checks an uncertain job outcome using the existing job identity", () => {
  const state = createFixtureState("media.scenario.job-outcome-unknown");
  const parsed = parseMediaCommand(state, ["ghatana-media", "job", "check-outcome", "--job", "fixture-transcription-job-unknown"]);
  assert.equal(parsed.kind, "action");
  assert.equal(parsed.commandId, "media.cli.job.check-outcome");
  assert.equal(parseMediaCommand(state, ["ghatana-media", "job", "reconcile", "--job", "fixture-transcription-job-unknown"]).kind, "error");
  assert.equal(parseMediaCommand(state, ["ghatana-media", "job", "inspect", "--job", "fixture-transcription-job-unknown"]).kind, "error");
  const transition = reduceMediaExperience(state, parsed.action);
  assert.equal(transition.applied, true);
  assert.equal(transition.state.job.state, "RECONCILING");
  assert.equal(transition.state.job.jobId, state.job.jobId);
});

test("job cancellation uses the existing job identity and stays pending until confirmation", async () => {
  const state = createFixtureState("media.scenario.job-running");
  const jobId = state.job.jobId;
  const parsed = parseMediaCommand(state, ["ghatana-media", "job", "cancel", "--job", jobId]);
  assert.equal(parsed.kind, "action");
  assert.equal(parsed.commandId, "media.cli.job.cancel");
  assert.deepEqual(parsed.action, { type: "media.action.request-cancellation" });

  const transition = reduceMediaExperience(state, parsed.action);
  assert.equal(transition.applied, true);
  assert.equal(transition.state.job.jobId, jobId);
  assert.equal(transition.state.job.state, "RUNNING");
  assert.equal(transition.state.job.attemptState, "CANCEL_REQUESTED");
  assert.equal(transition.state.job.finality, "PENDING");
  const repeat = reduceMediaExperience(transition.state, parsed.action);
  assert.equal(repeat.applied, false);
  assert.equal(repeat.reasonCode, "CANCELLATION_ALREADY_PENDING");
  assert.equal(repeat.state.job.finality, "PENDING");
  const confirmation = applySimulationEvent(transition.state, { type: "job.cancellation-confirmed" });
  assert.equal(confirmation.applied, true);
  assert.equal(confirmation.state.job.state, "CANCELLED");
  assert.equal(confirmation.state.job.finality, "CONFIRMED");
  assert.equal(parseMediaCommand(state, ["ghatana-media", "job", "cancel", "--job", "another-job"]).kind, "error");

  const { stdout } = await execFileAsync(process.execPath, [
    new URL("../bin/ghatana-media.mjs", import.meta.url).pathname,
    "--scenario",
    "media.scenario.job-running",
    "ghatana-media",
    "job",
    "cancel",
    "--job",
    jobId,
    "--format",
    "json",
  ]);
  const report = JSON.parse(stdout);
  assert.equal(report.actionId, "media.action.request-cancellation");
  assert.equal(report.schemaVersion, "media.cli-result.v1");
  assert.equal(report.jobId, jobId);
  assert.equal(report.state, "RUNNING");
  assert.equal(report.finality, "PENDING");
  assert.equal(report.nextAction, "media.action.view-job-status");
  assert.equal(report.projection.job.attemptState, "CANCEL_REQUESTED");
  assert.equal(report.projection.safeActionIds.includes("media.action.request-cancellation"), false);
});

test("job status and outcome checking preserve artifact-verification job and related upload identities", async () => {
  const state = createFixtureState("media.scenario.artifact-verification-outcome-unknown");
  const jobId = "fixture-artifact-verification-job-unknown-001";
  const uploadId = "fixture-upload-outcome-unknown-001";
  const parsed = parseMediaCommand(state, ["ghatana-media", "job", "check-outcome", "--job", jobId]);
  assert.equal(parsed.kind, "action");
  assert.equal(parsed.commandId, "media.cli.job.check-outcome");
  const transition = reduceMediaExperience(state, parsed.action);
  assert.equal(transition.applied, true);
  assert.equal(transition.state.artifactVerification.jobId, jobId);
  assert.equal(transition.state.artifactVerification.uploadId, uploadId);
  assert.equal(transition.state.artifactVerification.status, "OUTCOME_UNKNOWN");
  assert.equal(parseMediaCommand(state, ["ghatana-media", "job", "status", "--job", "another-job"]).kind, "error");

  const { stdout } = await execFileAsync(process.execPath, [
    new URL("../bin/ghatana-media.mjs", import.meta.url).pathname,
    "--scenario",
    "media.scenario.artifact-verification-outcome-unknown",
    "ghatana-media",
    "job",
    "check-outcome",
    "--job",
    jobId,
    "--format",
    "json",
  ]);
  const report = JSON.parse(stdout);
  assert.equal(report.workflow, "artifact-verification");
  assert.equal(report.workflowState, "OUTCOME_UNKNOWN");
  assert.equal(report.state, "OUTCOME_UNKNOWN");
  assert.equal(report.finality, "UNKNOWN");
  assert.equal(report.verificationStage, "INTEGRITY_CHECK");
  assert.equal(report.jobId, jobId);
  assert.equal(report.uploadId, uploadId);
  assert.equal(report.projection.artifactIntake, null);
  assert.equal(report.projection.artifactVerification.jobId, jobId);

  const { stdout: humanOutput } = await execFileAsync(process.execPath, [
    new URL("../bin/ghatana-media.mjs", import.meta.url).pathname,
    "--scenario",
    "media.scenario.artifact-verification-outcome-unknown",
    "ghatana-media",
    "job",
    "status",
    "--job",
    jobId,
  ]);
  assert.match(humanOutput, /Verification job: Outcome not confirmed \(Unknown\)/);
  assert.match(humanOutput, new RegExp(`Related upload: ${uploadId}`));
  assert.match(humanOutput, /Next safe action: View job status/);
  assert.doesNotMatch(humanOutput, /media\.(?:action|effect)\./);

  const { stdout: outcomeOutput } = await execFileAsync(process.execPath, [
    new URL("../bin/ghatana-media.mjs", import.meta.url).pathname,
    "--scenario",
    "media.scenario.job-outcome-unknown",
    "ghatana-media",
    "job",
    "check-outcome",
    "--job",
    "fixture-transcription-job-unknown",
  ]);
  assert.match(outcomeOutput, /Job: Checking outcome \(Unknown\) · fixture-transcription-job-unknown/);
  assert.match(outcomeOutput, /Next safe action: View job status/);
  assert.match(outcomeOutput, /Effects: Existing job outcome check started/);
  assert.doesNotMatch(outcomeOutput, /media\.(?:action|effect)\./);
});

test("parses quoted caption text and exact source-clock tick ranges", () => {
  const state = createFixtureState("media.scenario.alignment-required");
  const correction = parseMediaCommand(state, "ghatana-media caption correct-text --artifact-version caption-draft-v1 --segment segment-001 --text \"A corrected caption line\"");
  assert.deepEqual(correction.action, {
    type: "media.action.correct-caption",
    segmentId: "segment-001",
    text: "A corrected caption line",
  });
  const timing = parseMediaCommand(state, "ghatana-media caption align-timing --artifact-version caption-draft-v1 --segment segment-002 --start-tick 3400 --end-tick 6500");
  assert.deepEqual(timing.action, {
    type: "media.action.align-caption-timing",
    segmentId: "segment-002",
    startTick: 3400,
    endTick: 6500,
  });
});

test("accepts flag-shaped caption text through inline option values", () => {
  const state = createFixtureState("media.scenario.alignment-required");
  const parsed = parseMediaCommand(state, [
    "ghatana-media", "caption", "correct-text",
    "--artifact-version=caption-draft-v1",
    "--segment=segment-001",
    "--text=--speaker",
  ]);
  assert.equal(parsed.kind, "action");
  assert.deepEqual(parsed.action, {
    type: "media.action.correct-caption",
    segmentId: "segment-001",
    text: "--speaker",
  });
  assert.match(
    parseMediaCommand(state, "ghatana-media caption correct-text --artifact-version caption-draft-v1 --segment segment-001 --text --speaker").message,
    /requires a value/,
  );
});

test("the fixture-only transcribe command does not treat a report path as generated media", async () => {
  const state = createFixtureState("media.scenario.transcript-ready");
  const parsed = parseMediaCommand(state, "ghatana-media transcribe --source-version source-v1 --language en --output result.wav");
  assert.equal(parsed.kind, "error");
  assert.match(parsed.message, /Unknown option '--output'/);

  const result = await execFileAsync(process.execPath, [
    new URL("../bin/ghatana-media.mjs", import.meta.url).pathname,
    "--scenario",
    "media.scenario.transcript-ready",
    "transcribe",
    "--source-version",
    "source-v1",
    "--language",
    "en",
    "--output",
    "result.wav",
  ]).then(() => null, (error) => error);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown option '--output'/);
});

test("JSON and JSONL parsing errors stay machine-readable on stdout", async () => {
  assert.equal(requestedMediaCliFormat("ghatana-media job status --job fixture-job --format=json"), "json");
  assert.equal(JSON.parse(formatMediaCliError("invalid command", "jsonl")).recordType, "error");
  const cliPath = new URL("../bin/ghatana-media.mjs", import.meta.url).pathname;
  for (const format of ["json", "jsonl"]) {
    const result = await execFileAsync(process.execPath, [
      cliPath,
      "--scenario",
      "media.scenario.transcript-ready",
      "transcribe",
      "--source-version",
      "source-v1",
      "--language",
      "en",
      "--unknown-option",
      "value",
      "--format",
      format,
    ]).then(() => null, (error) => error);
    assert.equal(result.code, 2);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.schemaVersion, "media.cli-error.v1");
    assert.equal(parsed.code, "INVALID_ARGUMENT");
    assert.match(parsed.message, /Unknown option/);
    if (format === "jsonl") assert.equal(parsed.recordType, "error");
  }
});

test("requires the current draft and a purpose before registering a caption version", () => {
  const state = createFixtureState("media.scenario.transcript-ready");
  const missingPurpose = parseMediaCommand(state, "ghatana-media caption save-version --draft-version caption-draft-v1");
  assert.equal(missingPurpose.kind, "error");
  const parsed = parseMediaCommand(state, "ghatana-media caption save-version --draft-version caption-draft-v1 --purpose \"Accessibility review\"");
  assert.equal(parsed.kind, "action");
  assert.deepEqual(parsed.action, { type: "media.action.save-caption-version", purpose: "Accessibility review" });
});

test("parses upload inspection and resume against the same stable upload identity", () => {
  const state = createFixtureState("media.scenario.upload-interrupted");
  const transcriptionCommand = parseMediaCommand(state, "ghatana-media transcribe --source-version source-v1 --language en");
  assert.equal(transcriptionCommand.kind, "error");
  assert.match(transcriptionCommand.message, /require a transcription workflow fixture/);
  const inspected = parseMediaCommand(state, "ghatana-media upload inspect --upload fixture-upload-interrupted-001 --format json");
  assert.equal(inspected.kind, "action");
  assert.equal(inspected.commandId, "media.cli.upload.inspect");
  assert.deepEqual(inspected.action, { type: "media.action.inspect-artifact" });

  const resumed = parseMediaCommand(state, "ghatana-media upload resume --upload fixture-upload-interrupted-001");
  assert.equal(resumed.kind, "action");
  assert.equal(resumed.commandId, "media.cli.upload.resume");
  assert.deepEqual(resumed.action, { type: "media.action.resume-artifact-upload" });
  assert.match(parseMediaCommand(state, "ghatana-media upload resume --upload another-upload").message, /not the current upload/);
});

test("upload CLI output exposes transfer status without inventing a processing job", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    new URL("../bin/ghatana-media.mjs", import.meta.url).pathname,
    "--scenario",
    "media.scenario.upload-interrupted",
    "ghatana-media",
    "upload",
    "resume",
    "--upload",
    "fixture-upload-interrupted-001",
    "--format",
    "json",
  ]);
  const report = JSON.parse(stdout);
  assert.equal(report.simulation, true);
  assert.equal(report.commandId, "media.cli.upload.resume");
  assert.equal(report.actionId, "media.action.resume-artifact-upload");
  assert.equal(report.uploadId, "fixture-upload-interrupted-001");
  assert.equal(report.workflowState, "RECEIVING");
  assert.equal(report.jobId, null);
  assert.equal(report.projection.job, null);
  assert.equal(report.projection.artifactIntake.uploadId, report.uploadId);

  const { stdout: availableStdout } = await execFileAsync(process.execPath, [
    new URL("../bin/ghatana-media.mjs", import.meta.url).pathname,
    "--scenario",
    "media.scenario.upload-verified-available",
    "ghatana-media",
    "upload",
    "inspect",
    "--upload",
    "fixture-upload-verified-available-001",
    "--format",
    "json",
  ]);
  const availableReport = JSON.parse(availableStdout);
  assert.equal(availableReport.resultVersion, "fixture-artifact-version-001");
});

test("exposes ghatana-media as an executable with stable JSON output", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    new URL("../bin/ghatana-media.mjs", import.meta.url).pathname,
    "--scenario",
    "media.scenario.job-outcome-unknown",
    "ghatana-media",
    "job",
    "check-outcome",
    "--job",
    "fixture-transcription-job-unknown",
    "--format",
    "json",
  ]);
  const report = JSON.parse(stdout);
  assert.equal(report.simulation, true);
  assert.equal(report.commandId, "media.cli.job.check-outcome");
  assert.equal(report.actionId, "media.action.check-job-outcome");
  assert.equal(report.state, "RECONCILING");
  assert.equal(report.projection.job.state, "RECONCILING");
  assert.equal(report.jobId, "fixture-transcription-job-unknown");
});

test("the executable accepts normal command arguments without repeating its binary name", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    new URL("../bin/ghatana-media.mjs", import.meta.url).pathname,
    "--scenario",
    "media.scenario.job-running",
    "job",
    "status",
    "--job",
    "fixture-transcription-job-running",
    "--format",
    "json",
  ]);
  const report = JSON.parse(stdout);
  assert.equal(report.commandId, "media.cli.job.status");
  assert.equal(report.actionId, "media.action.view-job-status");
  assert.equal(report.jobId, "fixture-transcription-job-running");
  assert.equal(report.state, "RUNNING");
});

test("the command executable returns nonzero for an unsafe or stale command", async () => {
  await assert.rejects(execFileAsync(process.execPath, [
    new URL("../bin/ghatana-media.mjs", import.meta.url).pathname,
    "--scenario",
    "media.scenario.job-outcome-unknown",
    "ghatana-media",
    "transcribe",
    "--source-version",
    "source-v1",
    "--language",
    "en",
  ]), (error) => String(error.code) === "2");
});
