import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const readYaml = (path) => parse(readFileSync(resolve(process.cwd(), path), "utf8"));
const parity = readYaml(".product-experience/interface-parity/operation-parity.yaml");
const actionRegistry = readYaml(".product-experience/pdp-3-product-experience/action-registry.yaml");
const fixtureRegistry = readYaml(".product-experience/pdp-3-product-experience/cli/command-registry.yaml");
const operationParity = parity.surfaces.find(({ surface }) => surface === "CLI fixture commands");
const source = readFileSync(resolve(process.cwd(), "libs/media-experience-simulation/src/cli.ts"), "utf8");

function validate(records) {
  const errors = [];
  const expectedIds = new Set(["media.fixture-cli.caption-save-version", "media.fixture-cli.caption-compare-versions"]);
  const recordIds = records.map(({ commandId }) => commandId);
  if (records.length !== 2 || new Set(recordIds).size !== 2 || recordIds.some((id) => !expectedIds.has(id))) errors.push("exactly the two currently unresolved fixture caption commands must be covered");
  for (const record of records) {
    const command = fixtureRegistry.commands.find(({ id }) => id === record.commandId);
    if (!command || command.execution !== "synthetic-fixture-only") errors.push(`${record.commandId}: command must resolve to the fixture registry`);
    if (JSON.stringify(command?.canonicalCommand.split(" ").slice(1)) !== JSON.stringify(record.argv)) errors.push(`${record.commandId}: argv identity does not match fixture registry`);
    const action = [...actionRegistry.actions, ...actionRegistry.ownerDefinedActions].find(({ id }) => id === record.emittedActionRef);
    if (!action) errors.push(`${record.commandId}: emitted action does not resolve`);
    const actionOps = action?.actionDefinitionSemantics?.typedDefinition?.exactOperationRefs ?? [];
    if (!actionOps.includes(record.currentOwnerOperationRef)) errors.push(`${record.commandId}: operation is not an exact operation ref of its emitted action`);
    if (!record.inputConstraints || !record.outcome || record.admission !== "NOT_ADMITTED") errors.push(`${record.commandId}: bounded parser outcome or non-admission is missing`);
  }
  return errors;
}

test("the two caption fixture commands have exact parser, emitted-action, and owner-operation definitions", () => {
  const records = operationParity.currentFixtureCommandDefinitions.records;
  assert.deepEqual(validate(records), []);
  assert.match(source, /caption save-version/u);
  assert.match(source, /caption compare-versions/u);
  assert.match(source, /The requested caption draft is not the current draft version/u);
  assert.match(source, /purpose must be 240 characters or fewer/u);
  assert.equal(operationParity.currentFixtureCommandDefinitions.execution, "deterministic-synthetic-fixture-only; no-production-runtime-or-provider-call");
});

test("fixture command definitions reject omissions, operation substitutions, and production promotion", () => {
  const rows = structuredClone(operationParity.currentFixtureCommandDefinitions.records);
  assert.ok(validate(rows.slice(0, 1)).some((error) => error.includes("exactly the two")));
  const substituted = structuredClone(rows);
  substituted[0].currentOwnerOperationRef = "media.operation.caption-draft-write";
  assert.ok(validate(substituted).some((error) => error.includes("not an exact operation ref")));
  const promoted = structuredClone(rows);
  promoted[1].admission = "ADMITTED";
  assert.ok(validate(promoted).some((error) => error.includes("non-admission")));
});
