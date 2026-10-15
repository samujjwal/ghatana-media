import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const { parse } = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"))("yaml");
const readYaml = (path) => parse(readFileSync(path, "utf8"));
const journeyPath = ".product-experience/pdp-3-product-experience/journey-contracts/deliver-export-with-destination-acknowledgement.yaml";
const operationsPath = ".product-experience/pdp-1-domain-data/operations.yaml";
const statesPath = ".product-experience/pdp-1-domain-data/states.yaml";
const journey = readYaml(journeyPath);
const operations = readYaml(operationsPath);
const states = readYaml(statesPath);
const delivery = operations.ownerDefinedOperationContracts.records.find(({ id }) => id === "media.operation.action.deliver-exact-version");
const acknowledgment = operations.ownerTypedObservationContracts.records.find(({ id }) => id === "media.observation-contract.destination-delivery-acknowledgment.v1");
const stateRefs = ["SUBMITTED", "ACKNOWLEDGED", "OUTCOME_UNKNOWN"].map((state) => `${statesPath}#stateMachines/media-delivery/stateDefinitions/${state}`);

test("J-22 binds delivery submission and destination finality to exact P1 definitions", () => {
  const stepRef = `${journeyPath}#/steps/1`;
  const step = journey.steps[1];
  const resultBinding = journey.pdp1ResultEvidence.operationResultBindings.find(({ operationRef }) => operationRef === delivery.id);
  const observationBinding = journey.pdp1ResultEvidence.typedObservationBindings.find(({ observationContractRef }) => observationContractRef.endsWith(acknowledgment.id));
  const reconcileBinding = journey.pdp1ResultEvidence.operationResultBindings.find(({ operationRef }) => operationRef === "media.operation.action.reconcile-delivery-acknowledgment");

  assert.ok(delivery);
  assert.ok(acknowledgment);
  assert.equal(resultBinding.journeyStepRef, stepRef);
  assert.equal(resultBinding.resultSchemaRef, `${operationsPath}#ownerDefinedOperationContracts/records/@id=${delivery.id}/resultSchema`);
  assert.deepEqual(resultBinding.stateRefs, stateRefs);
  assert.deepEqual(step.stateRefs, stateRefs);
  assert.deepEqual(step.stepDefinitionSemantics.transitionApplicability.stateRefs, stateRefs);
  assert.equal(observationBinding.resultSchemaRef, `${operationsPath}#ownerTypedObservationContracts/records/@id=${acknowledgment.id}/resultSchema`);
  assert.equal(reconcileBinding.resultSchemaRef, observationBinding.resultSchemaRef);
  assert.deepEqual(observationBinding.requiredExactIdentity, ["deliveryRequestResultRef", "deliveryRequestId", "deliveryRequestFingerprint", "artifactVersionRef", "destinationRef"]);

  const deliveryResultFields = delivery.resultSchema.fields;
  for (const identity of ["deliveryRequestId", "deliveryRequestResultRef", "deliveryRequestFingerprint", "artifactVersionId", "destinationRef"]) {
    assert.ok(deliveryResultFields.includes(identity), `delivery result preserves ${identity}`);
    assert.match(resultBinding.exactResult, new RegExp(identity, "u"));
  }
  assert.equal(step.canonicalOperationRef, delivery.id);
  assert.equal(step.stepDefinitionSemantics.action.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(journey.pdp1ResultEvidence.channelAndRuntimeBoundary.transport, "UNBOUND");
  assert.equal(journey.pdp1ResultEvidence.channelAndRuntimeBoundary.runtimeAdmission, "NOT_ADMITTED");
  assert.match(resultBinding.finality, /SUBMITTED.*ACKNOWLEDGED.*OUTCOME_UNKNOWN/u);
  assert.match(step.stepDefinitionSemantics.stepOutcomeSemantics.positive.intendedResult.proposal, /QUEUED or job status never establishes delivery/u);
  assert.match(step.stepDefinitionSemantics.stepOutcomeSemantics.recovery.recovery, /never-claim-success-from-local-state/u);

  // Negative assertions: submission or queue state alone cannot claim destination success.
  assert.match(resultBinding.exactResult, /submission does not establish destination receipt or acknowledgment/u);
  assert.doesNotMatch(step.stepDefinitionSemantics.stepOutcomeSemantics.positive.intendedResult.status, /^ACKNOWLEDGED$/u);
  assert.match(resultBinding.unknownDisposition, /never blindly resubmit/u);
  assert.equal(states.stateMachines.find(({ machineId }) => machineId === "media-delivery").stateDefinitions.find(({ id }) => id === "SUBMITTED").meaning.includes("recipient acceptance are not established"), true);
});
