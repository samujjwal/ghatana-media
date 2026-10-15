import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const p3 = ".product-experience/pdp-3-product-experience";
const [actionText, purposeText, operationsText, journeyText] = await Promise.all([
  readFile(`${p3}/action-registry.yaml`, "utf8"),
  readFile(`${p3}/journey-purpose-bindings.yaml`, "utf8"),
  readFile(".product-experience/pdp-1-domain-data/operations.yaml", "utf8"),
  readFile(`${p3}/journey-contracts/continue-safely-when-processing-is-unavailable.yaml`, "utf8"),
]);
const actionRegistry = parse(actionText);
const purposeRegistry = parse(purposeText);
const operations = parse(operationsText);
const journey = parse(journeyText);

test("J-27 fallback confirmation follows quality evidence on the existing step-04 purpose", () => {
  const action = actionRegistry.actions.find((item) => item.id === "media.action.confirm-selected-fallback");
  const purpose = purposeRegistry.records.find((item) => item.id === "media.pdp3.step-purpose-binding.j27-step-04.v1");
  const secondary = purpose?.relatedActionBindings?.find((item) => item.id === "media.pdp3.action-binding.j27-fallback-confirmation.v1");
  const operation = operations.ownerDefinedOperationContracts.records.find((item) => item.id === "media.operation.fallback-selection.confirm.v1");

  assert.ok(action);
  assert.ok(purpose);
  assert.ok(secondary);
  assert.ok(operation);
  assert.equal(purpose.journeyRef, "J-27");
  assert.equal(purpose.ordinal, 4);
  assert.equal(purpose.viewRef, "media.view.review-quality");
  assert.equal(purpose.stepRef, `${p3}/journey-contracts/continue-safely-when-processing-is-unavailable.yaml#/steps/3`);
  assert.equal(action.viewRefs.includes("media.view.review-quality"), true);
  assert.equal(action.actionDefinitionSemantics.typedDefinition.exactOperationRefs.includes(operation.id), true);
  assert.deepEqual(purpose.actionExactOperationRefs, ["media.operation.action.inspect-quality-evidence"]);
  assert.equal(secondary.actionRef, action.id);
  assert.equal(secondary.operationRef, operation.id);
  assert.deepEqual(secondary.actionExactOperationRefs, [operation.id]);
  assert.equal(secondary.operationKind, "COMMAND");
  assert.match(action.preconditions.join(" "), /candidate-specific-current-rights-license-quality-resource-and-cost-evidence-is-positive/);
  assert.match(action.effect, /do not dispatch or retry processing/);
  assert.match(secondary.recovery, /authorize-resubmission/);
  assert.equal(secondary.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(journey.pdp1ResultEvidence.channelAndRuntimeBoundary.transport, "UNBOUND");
  assert.equal(secondary.externalAcceptance, "PENDING");
  assert.equal(purposeRegistry.recordCount, 130);
  assert.equal(purposeRegistry.records.length, 130);
  assert.equal(journey.steps.length, 4);
  assert.match(journey.pdp1ResultEvidence.fallbackConfirmation.journeyPurposeBindingRef, /j27-step-04\.v1/);
});
