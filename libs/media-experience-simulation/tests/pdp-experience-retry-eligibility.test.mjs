import assert from "node:assert/strict";
import test from "node:test";
import { createFixtureState, evaluateRetryEligibilityDefinition } from "../dist/index.js";

const fixture = createFixtureState("media.scenario.job-retry-eligible");
const evidence = fixture.retryEligibility;
const trusted = {
  tenantId: "fixture-tenant-001",
  principalId: "fixture-principal-creator-001",
  jobId: "fixture-job-retryable-001",
  jobVersion: 12,
  retryBudgetRef: "fixture:policy:retry-budget:v4",
  now: "2026-10-09T12:01:00.000Z",
  maxAgeMs: 120_000,
};

test("retry eligibility is a current, exact, no-effect pre-dispatch definition oracle", () => {
  assert.ok(evidence);
  const result = evaluateRetryEligibilityDefinition(evidence, trusted);
  assert.deepEqual(result, {
    decision: "ELIGIBLE_FOR_EXPLICIT_REQUEST",
    reasons: [],
    effect: "NONE",
    runtimeAdmission: "NOT_ADMITTED",
  });
  assert.equal(fixture.job.state, "RETRY_PENDING");
  assert.equal(fixture.job.finality, "CONFIRMED");
  assert.equal(evidence.priorAttemptId, "fixture-job-retryable-attempt-3");
  assert.equal(evidence.priorAttemptFencingToken, 3);
  assert.equal(evidence.retryBudgetRemaining, 1);
  assert.equal("nextAttemptId" in evidence, false, "eligibility does not fabricate a new attempt or fence");
});

test("retry is denied or held when any exact identity, outcome, authority, policy, or budget guard fails", () => {
  assert.equal(evaluateRetryEligibilityDefinition({ ...evidence, tenantId: "fixture-tenant-other" }, trusted).decision, "DENIED");
  assert.equal(evaluateRetryEligibilityDefinition({ ...evidence, principalId: "fixture-principal-other" }, trusted).decision, "DENIED");
  assert.equal(evaluateRetryEligibilityDefinition({ ...evidence, jobVersion: 11 }, trusted).decision, "DENIED");
  assert.equal(evaluateRetryEligibilityDefinition({ ...evidence, retryBudgetRef: "fixture:policy:other" }, trusted).decision, "DENIED");
  assert.equal(evaluateRetryEligibilityDefinition({ ...evidence, priorAttemptDisposition: "NON_RETRYABLE" }, trusted).decision, "DENIED");
  assert.equal(evaluateRetryEligibilityDefinition({ ...evidence, priorEffectDisposition: "EFFECT_CONFIRMED" }, trusted).decision, "DENIED");
  assert.equal(evaluateRetryEligibilityDefinition({ ...evidence, authorityDisposition: "DENIED" }, trusted).decision, "DENIED");
  assert.equal(evaluateRetryEligibilityDefinition({ ...evidence, policyDisposition: "DENIED" }, trusted).decision, "DENIED");
  assert.equal(evaluateRetryEligibilityDefinition({ ...evidence, rightsDisposition: "DENIED" }, trusted).decision, "DENIED");
  assert.equal(evaluateRetryEligibilityDefinition({ ...evidence, consentDisposition: "REVOKED" }, trusted).decision, "DENIED");
  assert.equal(evaluateRetryEligibilityDefinition({ ...evidence, profileDisposition: "UNQUALIFIED" }, trusted).decision, "DENIED");
  assert.equal(evaluateRetryEligibilityDefinition({ ...evidence, retryBudgetRemaining: 0 }, trusted).decision, "DENIED");
  assert.equal(evaluateRetryEligibilityDefinition({ ...evidence, priorEffectDisposition: "UNKNOWN" }, trusted).decision, "UNKNOWN");
  assert.equal(evaluateRetryEligibilityDefinition({ ...evidence, authorityDisposition: "UNKNOWN" }, trusted).decision, "UNKNOWN");
});

test("retry evidence rejects malformed, stale, future, and overposted fixtures", () => {
  assert.equal(evaluateRetryEligibilityDefinition({ ...evidence, observedAt: "2026-02-31T00:00:00.000Z" }, trusted).decision, "INVALID_FIXTURE");
  assert.equal(evaluateRetryEligibilityDefinition({ ...evidence, observedAt: "2026-10-09" }, trusted).decision, "INVALID_FIXTURE");
  assert.equal(evaluateRetryEligibilityDefinition({ ...evidence, observedAt: "2026-10-09T11:00:00.000Z" }, trusted).decision, "UNKNOWN");
  assert.equal(evaluateRetryEligibilityDefinition({ ...evidence, observedAt: "2026-10-09T12:02:00.000Z" }, trusted).decision, "UNKNOWN");
  assert.equal(evaluateRetryEligibilityDefinition({ ...evidence, retryBudgetRemaining: Number.MAX_SAFE_INTEGER + 1 }, trusted).decision, "INVALID_FIXTURE");
  assert.equal(evaluateRetryEligibilityDefinition({ ...evidence, untrusted: true }, trusted).decision, "INVALID_FIXTURE");
  assert.equal(evaluateRetryEligibilityDefinition(evidence, null).decision, "INVALID_FIXTURE");
  assert.equal(evaluateRetryEligibilityDefinition(Object.create({ ...evidence }), trusted).decision, "INVALID_FIXTURE");
});
