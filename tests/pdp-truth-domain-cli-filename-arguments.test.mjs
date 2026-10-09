import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const channels = parse(readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/applications-channels.yaml"), "utf8"));

function validateFilenameArguments(rule) {
  return rule?.id === "media.cli.filename-argument.v1"
    && rule.inputArguments?.representation?.includes("one argv argument")
    && rule.inputArguments?.encoding?.includes("Unicode sequence")
    && rule.inputArguments?.execution?.includes("Never construct a shell command string")
    && rule.inputArguments?.boundaries?.includes("canonical artifact/version references")
    && rule.outputPaths?.representation?.includes("one literal client-side path argument")
    && rule.outputPaths?.overwrite?.includes("explicit overwrite option")
    && rule.outputPaths?.errors?.includes("never silently substitute a different path")
    && rule.scopeStatus === "OWNER_DEFINED_CLI_PATH_ARGUMENT_SEMANTICS; filesystem behavior and CLI execution remain NOT_EVALUATED."
    && rule.executionAdmission === "NOT_ADMITTED";
}

test("CLI path arguments preserve spaces and Unicode as one literal argument without shell interpolation", () => {
  const cli = channels.channels.find(({ id }) => id === "media.channel.cli").ownerCliDefinitionContract;
  const rule = cli.filenameArgumentRule;
  assert.equal(validateFilenameArguments(rule), true);

  const argv = ["render", "--input", "素材/scene take 1; $(touch nope).mp4", "--output", "résultats/final cut.mov"];
  assert.equal(argv[2], "素材/scene take 1; $(touch nope).mp4");
  assert.equal(argv[4], "résultats/final cut.mov");
  assert.equal(argv.filter((arg) => arg.includes("scene take")).length, 1);
  assert.equal(argv.filter((arg) => arg.includes("final cut")).length, 1);

  for (const mutate of [
    (candidate) => { candidate.inputArguments.representation = "Split paths on whitespace"; },
    (candidate) => { candidate.inputArguments.encoding = "Normalize all filenames to ASCII"; },
    (candidate) => { candidate.inputArguments.execution = "Interpolate paths into a shell command"; },
    (candidate) => { candidate.outputPaths.overwrite = "Always replace existing destinations"; },
    (candidate) => { candidate.outputPaths.errors = "Use a fallback path on write failure"; },
    (candidate) => { candidate.executionAdmission = "ADMITTED"; },
  ]) {
    const changed = structuredClone(rule);
    mutate(changed);
    assert.equal(validateFilenameArguments(changed), false, "unsafe path handling or accidental admission must fail");
  }
});

test("the filename argument rule is registered as one exact normative record", () => {
  const records = channels.ownerNormativeRuleRecords;
  assert.equal(records.filter(({ id }) => id === "media.cli.filename-argument.v1").length, 1);
  const record = records.find(({ id }) => id === "media.cli.filename-argument.v1");
  assert.equal(record.ruleRef,
    ".product-experience/pdp-0-product-truth/applications-channels.yaml#/channels/@id=media.channel.cli/ownerCliDefinitionContract/filenameArgumentRule");
});

test("the CLI keeps query, command, submission, stream, batch, simulation, and inference contracts distinct", () => {
  const cli = channels.channels.find(({ id }) => id === "media.channel.cli").ownerCliDefinitionContract;
  const rule = cli.commandSurfaceSeparationRule;
  const valid = (candidate) => candidate?.id === "media.cli.typed-command-surface-separation.v1"
    && candidate.invocationModes.includes("READ_QUERY")
    && candidate.invocationModes.includes("ASYNC_SUBMISSION")
    && candidate.invocationModes.includes("STREAM_OBSERVATION")
    && candidate.requiredBindings.includes("canonical-operation-or-action-ref")
    && candidate.requiredBindings.includes("command-specific-closed-request-and-result-schema")
    && /one exact canonical operation\/action and one invocation mode/u.test(candidate.rule)
    && /Do not create a universal provider SPI/u.test(candidate.rule)
    && /Capability absence is explicit/u.test(candidate.rule)
    && candidate.scopeStatus.includes("no executable or channel behavior is admitted")
    && candidate.executionAdmission === "NOT_ADMITTED";
  assert.equal(valid(rule), true);
  assert.equal(channels.ownerNormativeRuleRecords.filter(({ id }) => id === rule.id).length, 1);
  for (const mutate of [
    (candidate) => { candidate.invocationModes = candidate.invocationModes.filter((mode) => mode !== "STREAM_OBSERVATION"); },
    (candidate) => { candidate.requiredBindings = candidate.requiredBindings.filter((field) => field !== "canonical-operation-or-action-ref"); },
    (candidate) => { candidate.rule = candidate.rule.replace("Capability absence is explicit", "Capability absence is ignored"); },
    (candidate) => { candidate.executionAdmission = "ADMITTED"; },
  ]) {
    const changed = structuredClone(rule);
    mutate(changed);
    assert.equal(valid(changed), false);
  }
});
