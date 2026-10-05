import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const cliPath = `${packageDirectory}/bin/media-experience-fixture.mjs`;

function runCli(...args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    cwd: packageDirectory,
  });
}

test("JSON CLI output reports a blocked action and its intent-level reason", () => {
  const result = runCli(
    "--scenario",
    "media.scenario.alignment-required",
    "--action",
    JSON.stringify({ type: "media.action.save-caption-version" }),
    "--format",
    "json",
  );

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.simulation, true);
  assert.equal(report.steps[0].applied, false);
  assert.equal(report.steps[0].reasonCode, "CAPTION_ALIGNMENT_REQUIRED");
  assert.equal(report.finalProjection.scenarioId, "media.scenario.alignment-required");
});

test("JSONL output contains one record per input and a final projection summary", () => {
  const result = runCli(
    "--scenario",
    "media.scenario.job-outcome-unknown",
    "--action",
    JSON.stringify({ type: "media.action.reconcile-job" }),
    "--format",
    "jsonl",
  );

  assert.equal(result.status, 0, result.stderr);
  const records = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.recordType), ["step", "summary"]);
  assert.equal(records[0].kind, "action");
  assert.equal(records[1].scenarioId, "media.scenario.job-outcome-unknown");
});

test("unknown fixture identifiers fail closed with actionable usage", () => {
  const result = runCli("--scenario", "media.scenario.not-a-fixture");

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown scenario/);
  assert.match(result.stderr, /--help/);
});

test("malformed action and event payloads fail with usage errors instead of runtime traces", () => {
  const malformedAction = runCli(
    "--scenario",
    "media.scenario.transcript-ready",
    "--action",
    JSON.stringify({ type: "media.action.request-transcription" }),
  );
  const malformedEvent = runCli(
    "--scenario",
    "media.scenario.job-running",
    "--event",
    JSON.stringify({ type: "job.reconciliation-completed" }),
  );

  assert.equal(malformedAction.status, 2);
  assert.match(malformedAction.stderr, /supported Media action shape/);
  assert.doesNotMatch(malformedAction.stderr, /TypeError|at file:/);
  assert.equal(malformedEvent.status, 2);
  assert.match(malformedEvent.stderr, /supported Media event shape/);
  assert.doesNotMatch(malformedEvent.stderr, /TypeError|at file:/);
});

test("help lists the registered fixture identifiers without creating state", () => {
  const result = execFileSync(process.execPath, [cliPath, "--help"], {
    encoding: "utf8",
    cwd: packageDirectory,
  });

  assert.match(result, /run deterministic Media workflow fixtures/);
  assert.match(result, /media-experience-fixture --scenario/);
  assert.match(result, /job-outcome-unknown/);
  assert.match(result, /does not call the Media runtime or a provider/);
});

test("fixture runner reports upload status without relabeling it as a job", () => {
  const result = runCli(
    "--scenario",
    "media.scenario.upload-interrupted",
    "--action",
    JSON.stringify({ type: "media.action.resume-artifact-upload" }),
    "--format",
    "human",
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Upload: RECEIVING · fixture-upload-interrupted-001/);
  assert.match(result.stdout, /Integrity: NOT_CHECKED/);
  assert.doesNotMatch(result.stdout, /Job:/);
  assert.match(result.stdout, /Safe next actions: media\.action\.inspect-artifact/);
});
