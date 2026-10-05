#!/usr/bin/env node

import {
  createFixtureState,
  mediaExperienceScenarioIds,
  mediaCliHelp,
  formatMediaCliError,
  parseMediaCommand,
  projectExperience,
  requestedMediaCliFormat,
  reduceMediaExperience,
} from "../dist/index.js";

function fail(message, format = requestedMediaCliFormat(process.argv.slice(2))) {
  if (format === "json" || format === "jsonl") {
    process.stdout.write(formatMediaCliError(message, format));
  } else {
    process.stderr.write(formatMediaCliError(message, format));
  }
  process.exitCode = 2;
}

function parseScenario(argv) {
  const args = [...argv];
  let scenarioId = "media.scenario.transcript-ready";
  const scenarioIndex = args.indexOf("--scenario");
  if (scenarioIndex >= 0) {
    scenarioId = args[scenarioIndex + 1] ?? "";
    if (!scenarioId) return { error: "--scenario requires a fixture ID." };
    args.splice(scenarioIndex, 2);
    if (!mediaExperienceScenarioIds.includes(scenarioId)) return { error: `Unknown scenario '${scenarioId}'. Use --help to list fixture IDs.` };
  }
  return { scenarioId, args };
}

function formatHuman(report) {
  const nextAction = report.nextAction ?? "none";
  const displayStatus = (value) => String(value ?? "not available").toLowerCase().replaceAll("_", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
  const workflowStatus = report.workflow === "artifact-verification"
    ? `Verification job: ${displayStatus(report.state)} (${displayStatus(report.finality)}) · ${report.jobId}\nRelated upload: ${report.uploadId}\nVerification stage: ${displayStatus(report.verificationStage)}`
    : report.workflow === "artifact-intake"
      ? `Upload: ${displayStatus(report.workflowState)} (${displayStatus(report.finality)}) · ${report.uploadId}`
      : report.jobId
        ? `Job: ${displayStatus(report.state)} (${displayStatus(report.finality)}) · ${report.jobId}`
        : `Workflow: ${report.workflow} · ${displayStatus(report.state)}`;
  return [
    `${report.applied ? "Applied" : `Blocked (${report.reasonCode})`}: ${report.message}`,
    workflowStatus,
    ...(report.sourceVersion ? [`Source version: ${report.sourceVersion}`] : []),
    `Result version: ${report.resultVersion ?? "not available"}`,
    `Next safe action: ${nextAction}`,
  ].join("\n") + "\n";
}

async function main() {
  const scenario = parseScenario(process.argv.slice(2));
  if (scenario.error) return fail(scenario.error);
  if (scenario.args.length === 1 && ["--help", "-h"].includes(scenario.args[0])) {
    process.stdout.write(`${mediaCliHelp}\nScenarios:\n  ${mediaExperienceScenarioIds.join("\n  ")}\n`);
    return;
  }

  const state = createFixtureState(scenario.scenarioId);
  const commandInput = scenario.args[0] === "ghatana-media"
    ? scenario.args
    : ["ghatana-media", ...scenario.args];
  const parsed = parseMediaCommand(state, commandInput);
  if (parsed.kind === "help") {
    process.stdout.write(`${parsed.text}\nScenarios:\n  ${mediaExperienceScenarioIds.join("\n  ")}\n`);
    return;
  }
  if (parsed.kind === "error") return fail(parsed.message);

  const transition = reduceMediaExperience(state, parsed.action);
  const projection = projectExperience(transition.state);
  const verification = projection.artifactVerification;
  const uploadStatus = projection.artifactIntake?.status ?? null;
  const uploadFinality = uploadStatus === "OUTCOME_UNKNOWN"
    ? "UNKNOWN"
    : uploadStatus === "INTERRUPTED" || uploadStatus === "RECEIVING" || uploadStatus === "VERIFYING"
      ? "PENDING"
      : uploadStatus ? "CONFIRMED" : projection.job?.finality ?? (projection.firstUse?.creationStatus === "OUTCOME_UNKNOWN" ? "UNKNOWN" : projection.firstUse?.creationStatus === "CREATED" ? "CONFIRMED" : "NOT_APPLICABLE");
  const workflowStateValue = verification?.status
    ?? uploadStatus
    ?? projection.job?.state
    ?? projection.firstUse?.creationStatus
    ?? "NOT_APPLICABLE";
  const report = {
    schemaVersion: "media.cli-result.v1",
    simulation: true,
    scenarioId: scenario.scenarioId,
    workflow: projection.workflow,
    commandId: parsed.commandId,
    actionId: parsed.action.type,
    applied: transition.applied,
    reasonCode: transition.reasonCode ?? null,
    effectIds: transition.effectIds,
    message: transition.message,
    jobId: verification?.jobId ?? projection.job?.jobId ?? null,
    uploadId: projection.artifactIntake?.uploadId ?? verification?.uploadId ?? null,
    workflowState: verification?.status ?? uploadStatus,
    state: workflowStateValue,
    finality: verification?.finality ?? uploadFinality,
    verificationStage: verification?.stage ?? null,
    sourceVersion: projection.source?.artifactVersion ?? null,
    resultVersion: projection.artifactIntake?.artifactVersion ?? projection.transcript?.versionId ?? projection.captionDraft?.versionId ?? null,
    nextAction: projection.safeActionIds[0] ?? null,
    projection,
  };

  let output;
  if (parsed.format === "json") output = `${JSON.stringify(report, null, 2)}\n`;
  else if (parsed.format === "jsonl") output = `${JSON.stringify({ recordType: "result", ...report })}\n`;
  else output = formatHuman(report);

  process.stdout.write(output);
  if (!transition.applied) process.exitCode = 2;
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
