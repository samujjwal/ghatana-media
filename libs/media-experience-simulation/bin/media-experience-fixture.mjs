#!/usr/bin/env node

import {
  applySimulationEvent,
  createFixtureState,
  isMediaAction,
  isSimulationEvent,
  mediaExperienceScenarioIds,
  projectExperience,
  reduceMediaExperience,
} from "../dist/index.js";

const usage = `media-experience-fixture — run deterministic Media workflow fixtures

Usage:
  media-experience-fixture --scenario <id> [--action <json>]... [--event <json>]... [--format human|json|jsonl]

Examples:
  media-experience-fixture --scenario media.scenario.job-outcome-unknown --action '{"type":"media.action.check-job-outcome"}' --format json
  media-experience-fixture --scenario media.scenario.alignment-required --action '{"type":"media.action.align-caption-timing","segmentId":"segment-002","startTick":3400,"endTick":6500}' --format jsonl

Scenarios:
  ${mediaExperienceScenarioIds.join("\n  ")}

This runs synthetic fixture state only. It does not call the Media runtime or a provider.
`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

function parseArguments(argv) {
  const options = { scenario: null, inputs: [], format: process.stdout.isTTY ? "human" : "json" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag === "--scenario") {
      options.scenario = argv[++index];
      if (!options.scenario) throw new Error("--scenario requires a fixture ID.");
      continue;
    }
    if (flag === "--action" || flag === "--event") {
      const source = argv[++index];
      if (!source) throw new Error(`${flag} requires a JSON object.`);
      let value;
      try {
        value = JSON.parse(source);
      } catch {
        throw new Error(`${flag} must contain valid JSON.`);
      }
      if (value === null || typeof value !== "object" || Array.isArray(value) || typeof value.type !== "string") {
        throw new Error(`${flag} must be a JSON object with a string 'type' field.`);
      }
      const valid = flag === "--action" ? isMediaAction(value) : isSimulationEvent(value);
      if (!valid) throw new Error(`${flag} must match a supported Media ${flag === "--action" ? "action" : "event"} shape.`);
      options.inputs.push({ kind: flag === "--action" ? "action" : "event", value });
      continue;
    }
    if (flag === "--format") {
      options.format = argv[++index];
      if (!options.format) throw new Error("--format requires human, json, or jsonl.");
      continue;
    }
    throw new Error(`Unknown argument '${flag}'. Use --help for usage.`);
  }
  if (!options.scenario) throw new Error("--scenario is required.");
  if (!mediaExperienceScenarioIds.includes(options.scenario)) {
    throw new Error(`Unknown scenario '${options.scenario}'. Use --help to list fixture IDs.`);
  }
  if (!["human", "json", "jsonl"].includes(options.format)) {
    throw new Error(`Unsupported format '${options.format}'. Choose human, json, or jsonl.`);
  }
  return options;
}

function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }
  if (options.help) {
    process.stdout.write(usage);
    return;
  }

  let state;
  try {
    state = createFixtureState(options.scenario);
  } catch {
    fail(`Could not create fixture '${options.scenario}'.`);
    return;
  }

  const steps = [];
  for (const [index, input] of options.inputs.entries()) {
    const result = input.kind === "action"
      ? reduceMediaExperience(state, input.value)
      : applySimulationEvent(state, input.value);
    state = result.state;
    steps.push({
      step: index + 1,
      kind: input.kind,
      actionId: input.kind === "action" ? input.value.type : undefined,
      eventId: input.kind === "event" ? input.value.type : undefined,
      applied: result.applied,
      ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
      effectIds: result.effectIds,
      message: result.message,
      projection: projectExperience(state),
    });
  }

  const report = {
    simulation: true,
    scenarioId: options.scenario,
    stepCount: steps.length,
    steps,
    finalProjection: projectExperience(state),
  };
  if (options.format === "json") {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (options.format === "jsonl") {
    for (const step of steps) process.stdout.write(`${JSON.stringify({ recordType: "step", ...step })}\n`);
    process.stdout.write(`${JSON.stringify({ recordType: "summary", simulation: true, scenarioId: report.scenarioId, stepCount: report.stepCount, finalProjection: report.finalProjection })}\n`);
    return;
  }

  process.stdout.write(`Media Experience Simulation — ${report.scenarioId}\n`);
  process.stdout.write("Synthetic fixture only; no Media runtime or provider is called.\n");
  for (const step of steps) {
    const status = step.applied ? "applied" : `blocked${step.reasonCode ? ` (${step.reasonCode})` : ""}`;
    process.stdout.write(`${step.step}. ${status}: ${step.message}\n`);
  }
  const projection = report.finalProjection;
  if (projection.firstUse) {
    process.stdout.write(`Project creation: ${projection.firstUse.creationStatus} · ${projection.firstUse.createRequestId ?? "no request"}\n`);
    if (projection.firstUse.projectId) process.stdout.write(`Project: ${projection.firstUse.projectId} · ${projection.firstUse.projectVersion}\n`);
    process.stdout.write("Identity, workspace, and project data are synthetic fixture state only.\n");
  } else if (projection.artifactIntake) {
    process.stdout.write(`Upload: ${projection.artifactIntake.status} · ${projection.artifactIntake.uploadId}\n`);
    process.stdout.write(`Integrity: ${projection.artifactIntake.integrity}\n`);
  } else {
    process.stdout.write(`Job: ${projection.job.state} (${projection.job.finality})\n`);
    process.stdout.write(`Caption versions: ${projection.registeredCaptionVersions.length}\n`);
  }
  process.stdout.write(`Safe next actions: ${projection.safeActionIds.join(", ") || "none"}\n`);
}

main();
