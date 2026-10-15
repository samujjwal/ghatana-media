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
  readFile(`${p3}/journey-contracts/deliver-export-with-destination-acknowledgement.yaml`, "utf8"),
]);
const actionRegistry = parse(actionText);
const purposeRegistry = parse(purposeText);
const operations = parse(operationsText);
const journey = parse(journeyText);

test("J-22 step 03 links destination acknowledgment reconciliation to its exact typed observation", () => {
  const action = actionRegistry.actions.find((item) => item.id === "media.action.reconcile-delivery-acknowledgment");
  const purpose = purposeRegistry.records.find((item) => item.id === "media.pdp3.step-purpose-binding.j22-step-03.v1");
  const secondary = purpose?.relatedActionBindings?.find((item) => item.id === "media.pdp3.action-binding.j22-destination-ack-reconciliation.v1");
  const deliveryPurpose = purposeRegistry.records.find((item) => item.id === "media.pdp3.step-purpose-binding.j22-step-02.v1");
  const operation = operations.ownerDefinedOperationContracts.records.find((item) => item.id === "media.operation.action.reconcile-delivery-acknowledgment");
  const observation = operations.ownerTypedObservationContracts.records.find((item) => item.id === "media.observation-contract.destination-delivery-acknowledgment.v1");

  assert.ok(action);
  assert.ok(purpose);
  assert.ok(deliveryPurpose);
  assert.ok(secondary);
  assert.ok(operation);
  assert.ok(observation);
  assert.equal(purpose.journeyRef, "J-22");
  assert.equal(purpose.ordinal, 3);
  assert.equal(purpose.stepRef, `${p3}/journey-contracts/deliver-export-with-destination-acknowledgement.yaml#/steps/2`);
  assert.equal(action.journeyRefs.includes("J-22"), true);
  assert.equal(action.viewRefs.includes("media.view.job-status"), true);
  assert.equal(action.actionDefinitionSemantics.typedDefinition.exactOperationRefs.includes(operation.id), true);
  assert.deepEqual(purpose.actionExactOperationRefs, ["media.operation.action.view-job-status"]);
  assert.equal(secondary.actionRef, action.id);
  assert.equal(secondary.operationRef, operation.id);
  assert.deepEqual(secondary.actionExactOperationRefs, [operation.id]);
  assert.equal(secondary.observationContractRef, `${".product-experience/pdp-1-domain-data/operations.yaml"}#ownerTypedObservationContracts/records/@id=${observation.id}`);
  assert.equal(observation.operationRefs.includes(operation.id), true);
  assert.equal(deliveryPurpose.observationContractRefs.includes(secondary.observationContractRef), true);
  assert.equal(deliveryPurpose.transitionDisposition.status, "NO_EXACT_ACTION_TRANSITION");
  assert.match(deliveryPurpose.destinationAcknowledgmentObservationDisposition, /LATER_EXTERNAL_EVIDENCE_ONLY/);
  assert.match(deliveryPurpose.finality, /destination acknowledgment required for delivery/);
  assert.match(secondary.observationBinding, /request ID and fingerprint, artifact version, and destination/);
  assert.match(secondary.unknownDisposition, /never retry blindly/);
  assert.equal(secondary.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(secondary.transport, "UNBOUND");
  assert.equal(secondary.externalAcceptance, "PENDING");
  assert.equal(purposeRegistry.recordCount, 130);
  assert.equal(purposeRegistry.records.length, 130);
  assert.equal(journey.journeyId, "J-22");
  assert.equal(journey.steps.length, 3);
  assert.equal(journey.pdp1ResultEvidence.channelAndRuntimeBoundary.transport, "UNBOUND");
  assert.equal(journey.pdp1ResultEvidence.channelAndRuntimeBoundary.runtimeAdmission, "NOT_ADMITTED");
});
