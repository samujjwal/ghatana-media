import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const p3 = ".product-experience/pdp-3-product-experience";
const p1 = ".product-experience/pdp-1-domain-data/operations.yaml";
const [purposesText, operationsText, c16Text, c22Text] = await Promise.all([
  readFile(`${p3}/journey-purpose-bindings.yaml`, "utf8"),
  readFile(p1, "utf8"),
  readFile(`${p3}/journey-contracts/translate-and-dub-existing-video.yaml`, "utf8"),
  readFile(`${p3}/journey-contracts/deliver-export-with-destination-acknowledgement.yaml`, "utf8"),
]);
const purposes = parse(purposesText);
const operations = parse(operationsText);
const c16 = parse(c16Text);
const c22 = parse(c22Text);
const purposeById = new Map(purposes.records.map((record) => [record.id, record]));
const ownerContracts = new Map(operations.ownerDefinedOperationContracts.records.map((record) => [record.id, record]));
const typedObservations = new Map(operations.ownerTypedObservationContracts.records.map((record) => [record.id, record]));
const purposePath = (id) => `${p3}/journey-purpose-bindings.yaml#records/@id=${id}`;

function assertResultBindings(journey, expected) {
  const bindings = journey.pdp1ResultEvidence.operationResultBindings;
  assert.ok(Array.isArray(bindings));
  for (const item of expected) {
    const binding = bindings.find((candidate) => candidate.operationRef === item.operationRef && candidate.journeyStepRef.endsWith(item.stepSuffix));
    assert.ok(binding, `${journey.journeyId} missing ${item.operationRef} at ${item.stepSuffix}`);
    const purposeId = binding.purposeBindingRef.split("@id=")[1];
    const purpose = purposeById.get(purposeId);
    assert.ok(purpose, `${purposeId} resolves`);
    assert.equal(binding.purposeBindingRef, purposePath(purposeId));
    assert.equal(purpose.stepRef, binding.journeyStepRef);
    assert.equal(purpose.operationRefs.includes(item.operationRef) || purpose.relatedActionBindings?.some((related) => related.operationRef === item.operationRef), true);
    assert.equal(typeof binding.resultSchemaRef, "string");
    assert.equal(binding.resultSchemaRef.startsWith(`${p1}#`), true);
    assert.equal(typeof binding.exactResult, "string");
    assert.equal(typeof binding.unknownDisposition, "string");
  }
}

test("J-16 binds only its explicit query and session-local draft results, preserving candidate no-dispatch", () => {
  assertResultBindings(c16, [
    { stepSuffix: "/steps/0", operationRef: "media.operation.action.review-translated-segment" },
    { stepSuffix: "/steps/2", operationRef: "media.operation.caption-draft-write" },
    { stepSuffix: "/steps/4", operationRef: "media.operation.action.compare-candidate-on-metric" },
  ]);
  const candidates = c16.pdp1ResultEvidence.conditionalCandidateOperations;
  assert.equal(candidates.status, "NOT_BOUND_TO_AN_OPERATION_BEARING_JOURNEY_STEP");
  assert.match(candidates.disposition, /no default, dispatch, or operation result/);
  assert.equal(purposeById.get("media.pdp3.step-purpose-binding.j16-step-02.v1").bindingKind, "EXPLICIT_NO_DOMAIN_DISPATCH");
  assert.equal(purposeById.get("media.pdp3.step-purpose-binding.j16-step-02.v1").operationRefs.length, 0);
  assert.equal(c16.pdp1ResultEvidence.channelAndRuntimeBoundary.transport, "UNBOUND");
  assert.equal(c16.pdp1ResultEvidence.channelAndRuntimeBoundary.runtimeAdmission, "NOT_ADMITTED");
  assert.ok(ownerContracts.has("media.operation.action.review-translated-segment"));
  assert.ok(ownerContracts.has("media.operation.action.compare-candidate-on-metric"));
});

test("J-22 separates delivery receipt, reconciliation query, and exact destination acknowledgment", () => {
  assertResultBindings(c22, [
    { stepSuffix: "/steps/0", operationRef: "media.operation.action.inspect-output-preview-and-version" },
    { stepSuffix: "/steps/1", operationRef: "media.operation.action.deliver-exact-version" },
    { stepSuffix: "/steps/2", operationRef: "media.operation.action.view-job-status" },
    { stepSuffix: "/steps/2", operationRef: "media.operation.action.reconcile-delivery-acknowledgment" },
  ]);
  const ack = c22.pdp1ResultEvidence.typedObservationBindings[0];
  assert.equal(ack.operationRef, "media.operation.action.reconcile-delivery-acknowledgment");
  assert.equal(ack.observationContractRef, `${p1}#ownerTypedObservationContracts/records/@id=media.observation-contract.destination-delivery-acknowledgment.v1`);
  assert.ok(typedObservations.has("media.observation-contract.destination-delivery-acknowledgment.v1"));
  assert.deepEqual(ack.requiredExactIdentity, ["deliveryRequestResultRef", "deliveryRequestId", "deliveryRequestFingerprint", "artifactVersionRef", "destinationRef"]);
  assert.match(ack.unknownDisposition, /never retry blindly/);
  assert.equal(c22.pdp1ResultEvidence.channelAndRuntimeBoundary.transport, "UNBOUND");
  assert.equal(c22.pdp1ResultEvidence.channelAndRuntimeBoundary.runtimeAdmission, "NOT_ADMITTED");
});
