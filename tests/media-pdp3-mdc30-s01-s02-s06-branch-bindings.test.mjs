import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const p1Path = ".product-experience/pdp-1-domain-data/operations.yaml";
const p3 = ".product-experience/pdp-3-product-experience";
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const operations = readYaml(p1Path);
const j09 = readYaml(`${p3}/journey-contracts/create-review-and-deliver-from-a-brief.yaml`);
const j22 = readYaml(`${p3}/journey-contracts/deliver-export-with-destination-acknowledgement.yaml`);
const j06 = readYaml(`${p3}/journey-contracts/return-grounded-typed-consumer-results.yaml`);

function resolveP1(ref) {
  assert.ok(ref.startsWith(`${p1Path}#`), `expected a P1 source ref: ${ref}`);
  let value = operations;
  for (const part of ref.slice(ref.indexOf("#") + 1).split("/")) {
    if (part.startsWith("@id=")) {
      assert.ok(Array.isArray(value), `@id requires an array in ${ref}`);
      value = value.find((entry) => entry.id === part.slice(4));
    } else {
      value = value?.[part];
    }
    assert.notEqual(value, undefined, `unresolved P1 ref: ${ref}`);
  }
  return value;
}

test("MDC30-S-01 binds J09 exact delivery and acknowledgment identity", () => {
  const binding = j09.pdp1ResultEvidence.typedObservationBindings[0];
  const fields = ["deliveryRequestResultRef", "deliveryRequestId", "deliveryRequestFingerprint", "artifactVersionRef", "destinationRef"];
  const ack = resolveP1(binding.observationContractRef);
  const schema = resolveP1(binding.resultSchemaRef);
  const delivery = operations.ownerDefinedOperationContracts.records.find((item) => item.id === binding.operationRef);
  const step = j09.steps[8];
  const evidence = step.stepDefinitionSemantics.stepOutcomeSemantics.positive.acknowledgmentCorrelation;
  const ackBranches = new Map(evidence.nonhappyBranches.map((branch) => [branch.id, branch]));
  const validation = operations.ownerTypedObservationValidationRules.records.find((item) => item.id === "media.observation-validation.destination-delivery-acknowledgment.v1");

  assert.equal(step.actionRef, "media.action.deliver-exact-version");
  assert.equal(binding.journeyStepRef.endsWith("#/steps/8"), true);
  assert.deepEqual(binding.requiredExactIdentity, fields);
  assert.deepEqual(evidence.requiredExactIdentity, fields);
  assert.deepEqual(ack.requestSchema.required.filter((field) => fields.includes(field)), fields);
  assert.deepEqual(schema.properties.observation.required.filter((field) => ["artifactVersionRef", "destinationRef"].includes(field)), ["artifactVersionRef", "destinationRef"]);
  assert.ok(schema.properties.observation.required.includes("originalRequestResultRef"));
  assert.ok(schema.properties.observation.required.includes("originalRequestId"));
  assert.ok(schema.properties.observation.required.includes("originalRequestFingerprint"));
  assert.deepEqual(schema.properties.observation.properties.acknowledgmentStatus.enum, ["ACKNOWLEDGED", "NOT_ACKNOWLEDGED", "UNKNOWN"]);
  assert.ok(delivery.resultSchema.fields.includes("deliveryRequestFingerprint"));
  assert.match(evidence.acknowledgedOnlyWhen, /owner-issued acknowledgment authority and nonempty evidence/u);
  assert.match(evidence.unknownDisposition, /mismatched evidence remains UNKNOWN/u);
  assert.equal(ackBranches.get("denied-delivery-request").sourceOutcome, "ACCESS_DENIED_OR_OWNER_PROFILE_ERROR");
  assert.equal(ackBranches.get("owner-confirmed-destination-rejection").sourceOutcome, "NOT_ACKNOWLEDGED");
  assert.equal(ackBranches.get("late-or-ambiguous-destination-acknowledgment").sourceOutcome, "UNKNOWN");
  assert.equal(ackBranches.get("wrong-destination-or-identity-mismatch").sourceOutcome, "UNKNOWN");
  assert.match(ackBranches.get("late-or-ambiguous-destination-acknowledgment").disposition, /no separate late status/u);
  assert.match(validation.predicates.map((predicate) => predicate.require ?? predicate.result ?? "").join(" "), /absence, timeout, denial, stale or mismatched evidence is UNKNOWN/u);
  assert.match(step.stepDefinitionSemantics.versionedObjectObservation.status, /EXACT_DELIVERY_REQUEST_AND_ACKNOWLEDGMENT/u);
  assert.equal(j09.pdp1ResultEvidence.channelAndRuntimeBoundary.transport, "UNBOUND");
  assert.equal(j09.pdp1ResultEvidence.channelAndRuntimeBoundary.runtimeAdmission, "NOT_ADMITTED");
});

test("MDC30-S-02 allocates J22 denial, explicit non-ack, uncertainty and mismatch safely", () => {
  const step = j22.steps[1];
  const branches = new Map(step.failure.branches.map((branch) => [branch.id, branch]));
  const acknowledgment = resolveP1(".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.destination-delivery-acknowledgment.v1");

  assert.equal(step.success.operationRef, "media.operation.action.deliver-exact-version");
  assert.deepEqual([...branches.keys()], ["denied-request", "owner-confirmed-destination-non-acknowledgment", "delayed-or-ambiguous-acknowledgment", "wrong-destination-or-identity-mismatch"]);
  assert.equal(branches.get("owner-confirmed-destination-non-acknowledgment").sourceOutcome, "NOT_ACKNOWLEDGED");
  assert.deepEqual(acknowledgment.resultSchema.properties.observation.properties.acknowledgmentStatus.enum, ["ACKNOWLEDGED", "NOT_ACKNOWLEDGED", "UNKNOWN"]);
  assert.equal(branches.get("delayed-or-ambiguous-acknowledgment").sourceOutcome, "UNKNOWN");
  assert.equal(branches.get("wrong-destination-or-identity-mismatch").sourceOutcome, "UNKNOWN");
  assert.match(branches.get("wrong-destination-or-identity-mismatch").disposition, /never map mismatched evidence to ACKNOWLEDGED/u);
  assert.match(step.failure.sourceLimitations.join(" "), /no separate late-ack status or rejection reason/u);
  assert.equal(step.recovery.status, "SOURCE_BOUND_SAME_REQUEST_RECONCILIATION");
  assert.equal(j22.pdp1ResultEvidence.channelAndRuntimeBoundary.transport, "UNBOUND");
  assert.equal(j22.pdp1ResultEvidence.channelAndRuntimeBoundary.runtimeAdmission, "NOT_ADMITTED");
});

test("MDC30-S-06 allocates five J06 conditions without asserting a job state or output", () => {
  const step = j06.steps[0];
  const branches = new Map(step.failure.branches.map((branch) => [branch.id, branch]));
  const target = operations.capabilityOperationContracts.records.find((item) => item.id === "media.operation.capability.media-multimodal-observe-source-grounded");
  const wrapper = operations.ownerDefinedOperationContracts.records.find((item) => item.id === "media.operation.job.submit.v1");
  const expected = ["privacy-denial", "unqualified-fallback", "cancellation-boundary", "missing-public-api", "generic-document-request"];

  assert.deepEqual([...branches.keys()], expected);
  for (const branch of branches.values()) {
    assert.ok(branch.condition);
    for (const ref of branch.sourceRefs ?? [branch.sourceRef]) if (ref?.startsWith(`${p1Path}#`)) resolveP1(ref);
    assert.ok(branch.disposition);
  }
  assert.ok(target.errors.includes("RIGHTS_OR_CONSENT_DENIED"));
  assert.ok(target.errors.includes("UNSUPPORTED_PROFILE"));
  assert.ok(target.errors.includes("UNKNOWN_OUTCOME"));
  assert.ok(wrapper.errors.includes("RIGHTS_NOT_VERIFIED"));
  assert.ok(wrapper.errors.includes("CONSENT_NOT_CURRENT"));
  assert.ok(wrapper.errors.includes("PROFILE_NOT_QUALIFIED"));
  assert.ok(wrapper.errors.includes("UNKNOWN_OUTCOME"));
  assert.equal(branches.get("missing-public-api").sourceOutcome, "NOT_ADMITTED_NO_DISPATCH");
  assert.match(branches.get("missing-public-api").sourceGap, /no distinct MISSING_PUBLIC_API operation error/u);
  assert.match(step.success.disposition, /does not assert QUEUED, execution, capability completion or output availability/u);
  assert.deepEqual(step.stateRefs, []);
  assert.equal(step.transitionDisposition.status, "NO_P1_MACHINE_TRANSITION");
  assert.equal(j06.pdp1ResultEvidence.channelAndRuntimeBoundary.transport, "UNBOUND");
  assert.equal(j06.pdp1ResultEvidence.channelAndRuntimeBoundary.runtimeAdmission, "NOT_ADMITTED");
});
