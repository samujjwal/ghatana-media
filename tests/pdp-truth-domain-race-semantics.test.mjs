import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { resolveAttemptRace, RaceResolutionError } from "../scripts/lib/pdp-truth-domain-race-oracle.mjs";
import { validateOwnerMachineRaceApplicability } from "../scripts/lib/pdp1-machine-race-applicability.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const parse = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml").parse;
const transitions = parse(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/transitions.yaml"), "utf8"));
const states = parse(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/states.yaml"), "utf8"));
const guardContracts = parse(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/transition-guard-contracts.yaml"), "utf8"));
const contract = transitions.ownerRaceResolutionContract;
const now = "2026-10-09T12:00:00Z";
const validEvidence = { verificationStatus: "VERIFIED", currentness: "CURRENT", authorityRef: "media.authority.test", evidenceRef: "media.evidence.test.v1", observedAt: "2026-10-09T11:59:00Z", validUntil: "2026-10-09T12:10:00Z" };

test("owner race contract has stable IDs, exact machine refs and explicit non-runtime status", () => {
  assert.equal(contract.id, "media.pdp1.job-attempt-race-resolution.v1");
  assert.match(contract.status, /runtime-observation-UNKNOWN/);
  assert.equal(contract.invariants.length, 7);
  assert.equal(contract.resolutionCases.length, 8);
  const transitionRefs = new Map([
    ...transitions.transitionRecords.map((row) => [row.id, `.product-experience/pdp-1-domain-data/transitions.yaml#transitionRecords/@id=${row.id}`]),
    ...transitions.ownerDefinedTransitionRecords.map((row) => [row.id, `.product-experience/pdp-1-domain-data/transitions.yaml#ownerDefinedTransitionRecords/@id=${row.id}`]),
  ]);
  for (const row of contract.resolutionCases) {
    assert.ok(row.sourceTransitionRefs.length, `${row.id} has source transition refs`);
    for (const ref of row.sourceTransitionRefs) assert.ok([...transitionRefs.values()].includes(ref), `resolves exact transition ref ${ref}`);
    assert.ok(contract.invariants.some((invariant) => invariant.id === row.reasonInvariantRef));
  }
  const scenarioById = new Map([
    ["media.pdp1.race.stale-fence", "stale-fence"],
    ["media.pdp1.race.death-after-dispatch-intent", "death-after-dispatch-intent"],
    ["media.pdp1.race.missing-intent", "missing-intent"],
    ["media.pdp1.race.unknown-not-completed", "unknown-not-completed"],
    ["media.pdp1.race.cancel-ack-with-effect-live", "cancel-ack-with-effect-live"],
    ["media.pdp1.race.retry-same-attempt", "retry-same-attempt"],
    ["media.pdp1.race.retry-with-unknown-effect", "retry-with-unknown-effect"],
    ["media.pdp1.race.delivery-response-lost", "delivery-response-lost"],
  ]);
  for (const row of contract.resolutionCases) {
    const scenario = scenarioById.get(row.id);
    if (scenario === "retry-same-attempt") assert.throws(() => resolveAttemptRace(scenario, row.facts), /RETRY_IDENTITY_OR_FENCE_INVALID/);
    else assert.equal(resolveAttemptRace(scenario, row.facts), row.disposition, row.id);
  }
});

test("race applicability covers every exact state machine, edge, guard and race axis", () => {
  assert.deepEqual(validateOwnerMachineRaceApplicability({ states, transitions, guardContracts }), {
    machineCount: 11, stateCount: 87, transitionCount: 55, axisCount: 6,
  });
  const axes = transitions.ownerMachineRaceApplicability.records.flatMap((row) => Object.entries(row.raceApplicability));
  assert.ok(axes.every(([, decision]) => ["APPLICABLE", "NOT_APPLICABLE"].includes(decision.disposition)));
  for (const machineId of ["media-job", "media-attempt", "media-stream-session", "media-delivery"]) {
    const row = transitions.ownerMachineRaceApplicability.records.find((item) => item.machineId === machineId);
    assert.ok(row, `${machineId} has an explicit race applicability row`);
    assert.ok(Object.values(row.raceApplicability).some((decision) => decision.disposition === "APPLICABLE"));
  }

  const foreignState = structuredClone(transitions);
  foreignState.ownerMachineRaceApplicability.records[0].stateRefs[0] = transitions.ownerMachineRaceApplicability.records[1].stateRefs[0];
  assert.throws(() => validateOwnerMachineRaceApplicability({ states, transitions: foreignState, guardContracts }), /RACE_STATE_POPULATION_MISMATCH/);
  const omittedAxis = structuredClone(transitions);
  delete omittedAxis.ownerMachineRaceApplicability.records[0].raceApplicability.deliveryAck;
  assert.throws(() => validateOwnerMachineRaceApplicability({ states, transitions: omittedAxis, guardContracts }), /RACE_AXIS_POPULATION_MISMATCH/);
  const alteredGuard = structuredClone(transitions);
  alteredGuard.ownerMachineRaceApplicability.records[0].transitionGuardContractRefs[0] = guardContracts.records.at(-1).id;
  assert.throws(() => validateOwnerMachineRaceApplicability({ states, transitions: alteredGuard, guardContracts }), /RACE_GUARD_POPULATION_MISMATCH/);
  const duplicateMachine = structuredClone(transitions);
  duplicateMachine.ownerMachineRaceApplicability.records[1].machineId = duplicateMachine.ownerMachineRaceApplicability.records[0].machineId;
  assert.throws(() => validateOwnerMachineRaceApplicability({ states, transitions: duplicateMachine, guardContracts }), /RACE_MACHINE_DUPLICATE/);
});

test("fence, process death, unknown result and cancel race fail closed", () => {
  assert.equal(resolveAttemptRace("stale-fence", { observedFence: 8, currentFence: 9 }), "DENY_STALE_WRITE");
  assert.equal(resolveAttemptRace("stale-fence", { observedFence: 9, currentFence: 9 }), "ALLOW_CURRENT_FENCE");
  assert.equal(resolveAttemptRace("death-after-dispatch-intent", { dispatchIntent: { durability: "DURABLE", tenantId: "tenant-1", jobId: "job-1", attemptId: "attempt-1", fencingToken: 7, requestFingerprint: "sha256:"+"a".repeat(64), evidenceRef: "media.evidence.dispatch.v1" }, processStatus: "TERMINATED", providerOutcome: "UNKNOWN" }), "RETAIN_OUTCOME_UNKNOWN");
  assert.equal(resolveAttemptRace("missing-intent", { dispatchIntent: { durability: "ABSENT" }, effectBoundaryStatus: "NOT_CROSSED" }), "DENY_DISPATCH");
  assert.equal(resolveAttemptRace("unknown-not-completed", { effectState: "POSSIBLE_OR_UNKNOWN", authoritativeOutcome: null }), "RETAIN_OUTCOME_UNKNOWN");
  assert.throws(() => resolveAttemptRace("unknown-not-completed", {}), (error) => error instanceof RaceResolutionError && error.code === "UNKNOWN_EFFECT_STATE");
  const cancel = { status: "ACCEPTED", requestId: "cancel-1", tenantId: "tenant-1", jobId: "job-1", attemptId: "attempt-1", fencingToken: 7, authorityRef: "media.authority.cancel.v1", evidenceRef: "media.evidence.cancel.v1" };
  assert.equal(resolveAttemptRace("cancel-ack-with-effect-live", { cancelRequestReceipt: cancel, now, terminationEvidence: { effectState: "POSSIBLE_OR_UNKNOWN" } }), "CANCEL_REQUESTED_NOT_FINAL");
  const termination = { ...validEvidence, effectState: "NO_FURTHER_EFFECT_POSSIBLE", tenantId: "tenant-1", jobId: "job-1", attemptId: "attempt-1", fencingToken: 7, requestId: "cancel-1" };
  assert.equal(resolveAttemptRace("cancel-ack-with-effect-live", { cancelRequestReceipt: cancel, terminationEvidence: termination, expectedTerminationAuthorityRef: termination.authorityRef, now }), "CANCEL_CONFIRMED");
  assert.throws(() => resolveAttemptRace("cancel-ack-with-effect-live", { cancelRequestReceipt: cancel, terminationEvidence: { ...termination, attemptId: "forged-attempt" }, expectedTerminationAuthorityRef: termination.authorityRef, now }), /TERMINATION_EVIDENCE_SCOPE_MISMATCH/);
  assert.throws(() => resolveAttemptRace("cancel-ack-with-effect-live", { cancelRequestReceipt: cancel, terminationEvidence: { ...termination, verificationStatus: "UNVERIFIED" }, expectedTerminationAuthorityRef: termination.authorityRef, now }), /TERMINATION_EVIDENCE_UNKNOWN_OR_STALE/);
  assert.throws(() => resolveAttemptRace("cancel-ack-with-effect-live", { cancelRequestReceipt: { status: "ACCEPTED", requestId: "cancel-1" }, terminationEvidence: { ...termination }, expectedTerminationAuthorityRef: termination.authorityRef, now }), /CANCEL_RECEIPT_TUPLE_INVALID/);
  assert.throws(() => resolveAttemptRace("cancel-ack-with-effect-live", { cancelRequestReceipt: cancel, terminationEvidence: { ...termination, validUntil: now }, expectedTerminationAuthorityRef: termination.authorityRef, now }), /TERMINATION_EVIDENCE_UNKNOWN_OR_STALE/);
  assert.throws(() => resolveAttemptRace("cancel-ack-with-effect-live", { cancelRequestReceipt: cancel, terminationEvidence: termination, expectedTerminationAuthorityRef: termination.authorityRef, now: "2026-02-30T12:00:00Z" }), /TERMINATION_EVIDENCE_UNKNOWN_OR_STALE/);
});

test("process death reconciles only a current verified receipt bound to the durable dispatch tuple", () => {
  const fingerprint = `sha256:${"a".repeat(64)}`;
  const dispatchIntent = { durability: "DURABLE", tenantId: "tenant-1", jobId: "job-1", attemptId: "attempt-1", fencingToken: 7, requestFingerprint: fingerprint, evidenceRef: "media.evidence.dispatch.v1" };
  const expectedCurrentAttempt = { tenantId: "tenant-1", jobId: "job-1", attemptId: "attempt-1", fencingToken: 7, requestFingerprint: fingerprint };
  const outcome = { ...validEvidence, ...expectedCurrentAttempt, authorityRef: "media.authority.attempt.v1", evidenceRef: "media.evidence.attempt-outcome.v1", disposition: "SUCCEEDED" };
  const facts = { dispatchIntent, expectedCurrentAttempt, expectedOutcomeAuthorityRef: outcome.authorityRef, expectedOutcomeEvidenceRef: outcome.evidenceRef, authoritativeOutcome: outcome, processStatus: "TERMINATED", now };
  assert.equal(resolveAttemptRace("death-after-dispatch-intent", facts), "RECONCILE_AUTHORITATIVE_RESULT");
  assert.equal(resolveAttemptRace("death-after-dispatch-intent", { ...facts, authoritativeOutcome: null, providerOutcome: "SUCCEEDED" }), "RETAIN_OUTCOME_UNKNOWN", "a provider status string is not authoritative evidence");
  assert.equal(resolveAttemptRace("death-after-dispatch-intent", { ...facts, expectedCurrentAttempt: { ...expectedCurrentAttempt, fencingToken: 8 } }), "RETAIN_OUTCOME_UNKNOWN", "a stale dispatch fence cannot be promoted");
  assert.equal(resolveAttemptRace("death-after-dispatch-intent", { ...facts, authoritativeOutcome: { ...outcome, tenantId: "tenant-other" } }), "RETAIN_OUTCOME_UNKNOWN", "cross-tenant outcome evidence cannot be reconciled");
  assert.equal(resolveAttemptRace("death-after-dispatch-intent", { ...facts, authoritativeOutcome: { ...outcome, evidenceRef: "media.evidence.other" } }), "RETAIN_OUTCOME_UNKNOWN", "unmatched evidence identity remains unknown");
  assert.equal(resolveAttemptRace("death-after-dispatch-intent", { ...facts, authoritativeOutcome: { ...outcome, observedAt: "2026-10-09T12:00:01Z" } }), "RETAIN_OUTCOME_UNKNOWN", "future-dated outcomes remain unknown");
  assert.equal(resolveAttemptRace("death-after-dispatch-intent", { ...facts, authoritativeOutcome: { ...outcome, validUntil: now } }), "RETAIN_OUTCOME_UNKNOWN", "expired receipts are not current");
  assert.throws(() => resolveAttemptRace("death-after-dispatch-intent", { ...facts, dispatchIntent: { ...dispatchIntent, fencingToken: 0 } }), /INVALID_SCENARIO_FACTS/);
  assert.throws(() => resolveAttemptRace("death-after-dispatch-intent", { ...facts, dispatchIntent: { ...dispatchIntent, requestFingerprint: "provider-says-success" } }), /INVALID_SCENARIO_FACTS/);
});

function validRetryFacts() {
  const job = { tenantId: "tenant-1", jobId: "job-1", currentAttemptId: "attempt-1", currentFence: 7, deadlineAt:"2026-10-09T12:05:00Z" };
  return {
    now,
    priorState: "RETRY_PENDING",
    expectedAttemptAuthorityRef: validEvidence.authorityRef,
    expectedRetryPolicyAuthorityRef: "media.authority.retry-policy.v1",
    job,
    priorAttemptResolution: { ...validEvidence, tenantId: job.tenantId, jobId: job.jobId, attemptId: job.currentAttemptId, fencingToken: job.currentFence, effectDisposition: "NO_EFFECT" },
    retryPolicyDecision: { ...validEvidence, authorityRef: "media.authority.retry-policy.v1", tenantId: job.tenantId, jobId: job.jobId, currentAttemptId: job.currentAttemptId, fencingToken: job.currentFence, disposition: "RETRY_ALLOWED", policyRef: "media.retry-policy.v1", attemptOrdinal: 1, maxAttempts: 3 },
    newAttempt: { attemptId: "attempt-2", fencingToken: 8 },
  };
}

test("retry requires current typed outcome and policy evidence, remaining budget, a new attempt and a greater fence", () => {
  assert.equal(resolveAttemptRace("retry-same-attempt", validRetryFacts()), "ALLOW_NEW_FENCED_ATTEMPT");
  assert.throws(() => resolveAttemptRace("retry-same-attempt", { ...validRetryFacts(), newAttempt: { attemptId: "attempt-1", fencingToken: 8 } }), /RETRY_IDENTITY_OR_FENCE_INVALID/);
  assert.throws(() => resolveAttemptRace("retry-same-attempt", { ...validRetryFacts(), newAttempt: { attemptId: "attempt-2", fencingToken: 7 } }), /RETRY_IDENTITY_OR_FENCE_INVALID/);
  assert.throws(() => resolveAttemptRace("retry-same-attempt", { ...validRetryFacts(), retryPolicyDecision: { ...validRetryFacts().retryPolicyDecision, attemptOrdinal: 3 } }), /RETRY_BUDGET_EXHAUSTED/);
  assert.throws(() => resolveAttemptRace("retry-same-attempt", { ...validRetryFacts(), retryPolicyDecision: { ...validRetryFacts().retryPolicyDecision, validUntil: "2026-10-09T11:59:59Z" } }), /RETRY_POLICY_UNKNOWN_OR_EXPIRED/);
  assert.throws(() => resolveAttemptRace("retry-same-attempt", { ...validRetryFacts(), now:"2026-10-09T12:05:00Z" }), /RETRY_JOB_DEADLINE_EXPIRED/);
  assert.throws(() => resolveAttemptRace("retry-same-attempt", { ...validRetryFacts(), expectedAttemptAuthorityRef:"media.authority.wrong.v1" }), /RETRY_PRIOR_ATTEMPT_SCOPE_MISMATCH/);
  assert.throws(() => resolveAttemptRace("retry-same-attempt", { ...validRetryFacts(), expectedRetryPolicyAuthorityRef:"media.authority.wrong.v1" }), /RETRY_POLICY_SCOPE_OR_DECISION_INVALID/);
  assert.throws(() => resolveAttemptRace("retry-same-attempt", { ...validRetryFacts(), now: undefined }), /RETRY_CURRENT_TUPLE_INVALID/);
  assert.equal(resolveAttemptRace("retry-same-attempt", { ...validRetryFacts(), priorAttemptResolution: { ...validRetryFacts().priorAttemptResolution, effectDisposition: "POSSIBLE_OR_UNKNOWN" } }), "DENY_RETRY_UNRESOLVED_EFFECT");
  assert.equal(resolveAttemptRace("retry-with-unknown-effect", validRetryFacts()), "DENY_RETRY_UNRESOLVED_EFFECT");
  assert.throws(() => resolveAttemptRace("retry-same-attempt", { ...validRetryFacts(), retryPolicyDecision: { ...validRetryFacts().retryPolicyDecision, fencingToken: 6 } }), /RETRY_POLICY_SCOPE_OR_DECISION_INVALID/);
});

test("authoritative job outcome reconciliation requires current exact subject and authority",()=>{
  const expectedOutcome={tenantId:"tenant-1",jobId:"job-1",attemptId:"attempt-1",fencingToken:7,requestFingerprint:"sha256:"+"a".repeat(64)};
  const outcome={...validEvidence,...expectedOutcome,authorityRef:"media.authority.attempt.v1",disposition:"SUCCEEDED"};
  const facts={effectState:"POSSIBLE_OR_UNKNOWN",expectedOutcome,expectedOutcomeAuthorityRef:outcome.authorityRef,authoritativeOutcome:outcome,now};
  assert.equal(resolveAttemptRace("unknown-not-completed",facts),"RECONCILE_AUTHORITATIVE_RESULT");
  assert.equal(resolveAttemptRace("unknown-not-completed",{...facts,authoritativeOutcome:{...outcome,jobId:"job-other"}}),"RETAIN_OUTCOME_UNKNOWN");
  assert.equal(resolveAttemptRace("unknown-not-completed",{...facts,expectedOutcome:{...expectedOutcome,requestFingerprint:"not-a-sha256"}}),"RETAIN_OUTCOME_UNKNOWN","the expected fingerprint must be the canonical sha256 form");
  assert.equal(resolveAttemptRace("unknown-not-completed",{...facts,authoritativeOutcome:{...outcome,requestFingerprint:"not-a-sha256"}}),"RETAIN_OUTCOME_UNKNOWN","malformed authoritative fingerprints cannot reconcile an outcome");
  assert.equal(resolveAttemptRace("unknown-not-completed",{...facts,authoritativeOutcome:{...outcome,validUntil:now}}),"RETAIN_OUTCOME_UNKNOWN");
  assert.equal(resolveAttemptRace("unknown-not-completed",{...facts,now:"2026-02-30T12:00:00Z"}),"RETAIN_OUTCOME_UNKNOWN");
});

test("delivery acknowledgment requires a current verified destination receipt bound to the exact output and request", () => {
  const expectedDelivery = { tenantId: "tenant-1", jobId: "job-1", outputVersionRef: "artifact-version:v3", destinationRef: "destination:1", requestId: "delivery-1" };
  assert.equal(resolveAttemptRace("delivery-response-lost", { effectState: "POSSIBLE_OR_UNKNOWN", expectedDelivery, expectedDestinationAuthorityRef: "media.authority.destination.v1", destinationReceipt: null, now }), "RETAIN_DELIVERY_OUTCOME_UNKNOWN");
  const receipt = { ...validEvidence, ...expectedDelivery, disposition: "ACKNOWLEDGED", authorityRef: "media.authority.destination.v1" };
  assert.equal(resolveAttemptRace("delivery-response-lost", { effectState: "POSSIBLE_OR_UNKNOWN", expectedDelivery, expectedDestinationAuthorityRef: receipt.authorityRef, destinationReceipt: receipt, now }), "DELIVERY_ACKNOWLEDGED");
  assert.throws(() => resolveAttemptRace("delivery-response-lost", { effectState: "POSSIBLE_OR_UNKNOWN", expectedDelivery, expectedDestinationAuthorityRef: receipt.authorityRef, destinationReceipt: "forged", now }), /DESTINATION_RECEIPT_UNKNOWN_OR_STALE/);
  assert.throws(() => resolveAttemptRace("delivery-response-lost", { effectState: "POSSIBLE_OR_UNKNOWN", expectedDelivery, expectedDestinationAuthorityRef: receipt.authorityRef, destinationReceipt: { ...receipt, outputVersionRef: "artifact-version:other" }, now }), /DESTINATION_RECEIPT_SCOPE_MISMATCH/);
  assert.throws(() => resolveAttemptRace("delivery-response-lost", { effectState: "POSSIBLE_OR_UNKNOWN", expectedDelivery, expectedDestinationAuthorityRef: receipt.authorityRef, destinationReceipt: { ...receipt, authorityRef: "media.authority.forged" }, now }), /DESTINATION_RECEIPT_SCOPE_MISMATCH/);
  assert.throws(() => resolveAttemptRace("delivery-response-lost", { effectState: "POSSIBLE_OR_UNKNOWN", expectedDelivery: {}, expectedDestinationAuthorityRef: undefined, destinationReceipt: receipt, now }), /DELIVERY_EXPECTED_TUPLE_INVALID/);
  assert.equal(resolveAttemptRace("delivery-response-lost", { effectState: "NO_EFFECT_POSSIBLE", now }), "NOT_DELIVERED_NO_EFFECT");
});
