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
const operations = parse(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/operations.yaml"), "utf8"));

function resolveRef(ref) {
  const [source, pointer = ""] = ref.split("#", 2);
  let value = source.endsWith("operations.yaml") ? operations : channels;
  for (const raw of pointer.split("/").filter(Boolean)) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (segment.startsWith("@id=")) {
      assert.ok(Array.isArray(value), `${ref}: @id selector requires an array`);
      value = value.find((item) => item?.id === segment.slice(4));
    } else value = value?.[/^\d+$/u.test(segment) ? Number(segment) : segment];
    assert.notEqual(value, undefined, `${ref}: unresolved ${segment}`);
  }
  return value;
}

function validateRemoteCancellation(cli, operation) {
  const rule = cli.remoteCancellationRule;
  return rule?.id === "media.cli.remote-cancellation.v1"
    && rule.command?.id === "media.cli.job.cancel"
    && rule.command.invocation === "explicit-user-command"
    && rule.command.canonicalOperationRef === ".product-experience/pdp-1-domain-data/operations.yaml#individualOperationContracts/records/@id=media.operation-slice.cancel-job"
    && rule.command.requiredCurrentChecks?.includes("current-job-version-and-attempt-fence")
    && rule.command.resultSemantics?.accepted?.includes("job remains nonterminal")
    && rule.command.resultSemantics?.unknown?.includes("OUTCOME_UNKNOWN")
    && rule.command.resultSemantics?.providerTermination?.includes("never implied")
    && rule.scopeStatus.includes("no CLI executable")
    && rule.executionAdmission === "NOT_ADMITTED"
    && cli.interruptHandling?.ctrlC?.serverCancellation === false
    && cli.interruptHandling?.ctrlC?.jobStateChange === false
    && operation.id === "media.operation-slice.cancel-job";
}

test("remote job cancellation is a separate exact command and never follows Ctrl-C implicitly", () => {
  const cli = channels.channels.find(({ id }) => id === "media.channel.cli").ownerCliDefinitionContract;
  const rule = cli.remoteCancellationRule;
  const operation = resolveRef(rule.command.canonicalOperationRef);
  assert.equal(operation.id, "media.operation-slice.cancel-job");
  assert.equal(rule.command.invocation, "explicit-user-command");
  assert.equal(rule.command.resultSemantics.accepted, "cancellation-request-receipt-only; job remains nonterminal until authoritative terminal state is observed.");
  assert.equal(rule.command.resultSemantics.unknown.includes("OUTCOME_UNKNOWN"), true);
  assert.equal(cli.interruptHandling.ctrlC.serverCancellation, false);
  assert.equal(cli.interruptHandling.ctrlC.jobStateChange, false);
  assert.equal(validateRemoteCancellation(cli, operation), true);

  for (const mutate of [
    (candidate) => { candidate.remoteCancellationRule.command.invocation = "automatic-on-ctrl-c"; },
    (candidate) => { candidate.interruptHandling.ctrlC.serverCancellation = true; },
    (candidate) => { candidate.remoteCancellationRule.command.resultSemantics.accepted = "job is cancelled"; },
    (candidate) => { candidate.remoteCancellationRule.command.requiredCurrentChecks = []; },
    (candidate) => { candidate.remoteCancellationRule.command.canonicalOperationRef = ".product-experience/pdp-1-domain-data/operations.yaml#individualOperationContracts/records/@id=media.operation-slice.inspect-job"; },
    (candidate) => { candidate.remoteCancellationRule.executionAdmission = "ADMITTED"; },
  ]) {
    const changed = structuredClone(cli);
    mutate(changed);
    assert.equal(validateRemoteCancellation(changed, operation), false, "unsafe cancellation implication or substituted operation is rejected");
  }
});

test("the new command rule is registered as one exact normative obligation", () => {
  const records = channels.ownerNormativeRuleRecords;
  assert.equal(records.filter(({ id }) => id === "media.cli.remote-cancellation.v1").length, 1);
  assert.equal(records.find(({ id }) => id === "media.cli.remote-cancellation.v1").ruleRef,
    ".product-experience/pdp-0-product-truth/applications-channels.yaml#/channels/@id=media.channel.cli/ownerCliDefinitionContract/remoteCancellationRule");
  const registered = resolveRef(records.find(({ id }) => id === "media.cli.remote-cancellation.v1").ruleRef);
  assert.equal(registered.id, "media.cli.remote-cancellation.v1");
});
