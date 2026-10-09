import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const states = parse(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/states.yaml"), "utf8"));

test("owner meanings close the previously pending state semantics without rewriting historical extraction", () => {
  assert.equal(states.currentOwnerMeaningDecision.authority, "user-delegated-Media-product-semantic-owner-under-EXECUTE-MEDIA-PDP-0-3-38-TASKS");
  assert.match(states.currentOwnerMeaningDecision.decisionBoundary, /Historical source meanings, spellings, counts, and transition projections remain preserved/u);
  assert.match(states.currentOwnerMeaningDecision.decisionBoundary, /External rights\/licensor\/consent authority.*not claimed/u);
  assert.equal(states.inventory.sourceStateRecords, 75);
  assert.equal(states.inventory.extractedStateRecords, 75);
  assert.equal(states.stateMachines.length, 11);

  const byMachine = new Map(states.stateMachines.map((machine) => [machine.machineId, machine]));
  const ownerDefined = [
    ["media-job", "QUEUED"], ["media-attempt", "CLAIMED"],
    ["media-upload-and-artifact", "RECEIVING"], ["media-stream-session", "OPEN"],
    ["media-review", "DRAFT"], ["media-delivery", "NOT_STARTED"],
    ["media-quality-disposition", "NOT_ASSESSED"], ["media-project", "ACTIVE"],
    ["media-project-version", "DRAFT"], ["media-project-membership", "INVITED"],
  ];
  for (const [machineId, stateId] of ownerDefined) {
    const record = byMachine.get(machineId).stateDefinitions.find(({ id }) => id === stateId);
    assert.ok(record.ownerCurrentMeaning.length > 40, `${machineId}/${stateId} has a precise current owner meaning`);
    assert.match(record.ownerCurrentMeaningStatus, /OWNER_DEFINED_DEFINITION_ONLY/u);
    assert.match(record.ownerCurrentMeaningStatus, /runtime-observation-UNKNOWN/u);
    assert.match(record.ownerMeaningDisposition, /pending-owner-review|bounded-/u,
      "historical extraction disposition remains distinguishable from the additive current owner meaning");
  }

  const rights = byMachine.get("media-rights-and-consent");
  assert.deepEqual(rights.stateIds, [], "the source's historical unenumerated-state count remains unchanged");
  assert.equal(rights.stateDefinitionsByDimension.rightsAssertion.length, 7);
  assert.equal(rights.stateDefinitionsByDimension.consent.length, 5);
  for (const state of [...rights.stateDefinitionsByDimension.rightsAssertion, ...rights.stateDefinitionsByDimension.consent]) {
    assert.ok(state.ownerCurrentMeaning.length > 40, `${state.id} has an explicit scoped owner meaning`);
    assert.match(state.ownerCurrentMeaningStatus, /legal\/contract authority remains external/u);
    assert.match(state.ownerCurrentMeaningStatus, /runtime-observation-UNKNOWN/u);
  }
});
