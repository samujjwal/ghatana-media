import assert from "node:assert/strict";
import test from "node:test";
import { createFixtureState, evaluateRetryEligibilityDefinition } from "../dist/index.js";

const fixture = createFixtureState("media.scenario.job-retry-eligible");
const trusted = {
  tenantId: "fixture-tenant-001",
  principalId: "fixture-principal-creator-001",
  jobId: "fixture-job-retryable-001",
  jobVersion: 12,
  retryBudgetRef: "fixture:policy:retry-budget:v4",
  now: "2026-10-09T12:01:00.000Z",
  maxAgeMs: 120_000,
};
const facts = [
  "priorAttempt", "priorEffect", "authority", "policy", "rights", "consent",
  "license", "resource", "deployment", "profile", "retryBudget",
];
const sourceScope = {
  tenantId: trusted.tenantId,
  principalId: trusted.principalId,
  jobId: trusted.jobId,
  jobVersion: trusted.jobVersion,
};
const sourceObservedAt = "2026-10-09T12:00:00.000Z";
const refs = Object.fromEntries(facts.map((fact) => [fact, `fixture:evidence:${fact}`]));
const baseSourceValues = {
  priorAttempt: { priorAttemptId: "fixture:attempt:3", priorAttemptFencingToken: 3, priorAttemptDisposition: "RETRYABLE" },
  priorEffect: "NO_EFFECT_CONFIRMED",
  authority: "CURRENT_ALLOWED",
  policy: "CURRENT_ALLOWED",
  rights: "CURRENT_ALLOWED",
  consent: "CURRENT_ACTIVE",
  license: "CURRENT_ALLOWED",
  resource: "CURRENT_ALLOWED",
  deployment: "CURRENT_ALLOWED",
  profile: "CURRENT_QUALIFIED",
  retryBudget: { retryBudgetRemaining: 1, retryBudgetRef: trusted.retryBudgetRef },
};
const sourceFactMap = (values = {}) => new Map(facts.map((fact) => [fact, {
  fact,
  evidenceRef: refs[fact],
  scope: { ...sourceScope },
  observedAt: sourceObservedAt,
  value: structuredClone(values[fact] ?? baseSourceValues[fact]),
}]));
const resolverFor = (sourceFacts = sourceFactMap()) => (fact, evidenceRef) => {
  const source = sourceFacts.get(fact);
  return source?.evidenceRef === evidenceRef ? source : undefined;
};
const evidenceWith = (overrides = {}) => ({
  tenantId: trusted.tenantId,
  principalId: trusted.principalId,
  jobId: trusted.jobId,
  jobVersion: trusted.jobVersion,
  priorAttemptId: "fixture:attempt:3",
  priorAttemptFencingToken: 3,
  priorAttemptDisposition: "RETRYABLE",
  priorEffectDisposition: "NO_EFFECT_CONFIRMED",
  authorityDisposition: "CURRENT_ALLOWED",
  policyDisposition: "CURRENT_ALLOWED",
  rightsDisposition: "CURRENT_ALLOWED",
  consentDisposition: "CURRENT_ACTIVE",
  licenseDisposition: "CURRENT_ALLOWED",
  resourceDisposition: "CURRENT_ALLOWED",
  deploymentDisposition: "CURRENT_ALLOWED",
  profileDisposition: "CURRENT_QUALIFIED",
  retryBudgetRemaining: 1,
  retryBudgetRef: trusted.retryBudgetRef,
  observedAt: sourceObservedAt,
  evidenceRefs: { ...refs },
  ...overrides,
});

const assertNotAdmitted = (result) => {
  assert.equal(result.effect, "NONE");
  assert.equal(result.runtimeAdmission, "NOT_ADMITTED");
};

test("retry scenario stays conditional and cannot claim eligibility without source evidence", () => {
  assert.equal(fixture.retryEligibility, null);
  assert.equal(fixture.job.state, "RETRY_PENDING", "state label alone does not establish resolved retry evidence");
  const missing = evaluateRetryEligibilityDefinition(fixture.retryEligibility, trusted);
  assert.equal(missing.decision, "UNKNOWN");
  assert.deepEqual(missing.reasons, ["RETRY_ELIGIBILITY_EVIDENCE_MISSING"]);
  assertNotAdmitted(missing);
});

test("typed source fact envelopes are required for eligibility", () => {
  const evidence = evidenceWith();
  const actual = evaluateRetryEligibilityDefinition(evidence, trusted, resolverFor());
  assert.equal(actual.decision, "ELIGIBLE_FOR_EXPLICIT_REQUEST");
  assertNotAdmitted(actual);

  assert.equal(evaluateRetryEligibilityDefinition(evidence, trusted).decision, "UNKNOWN", "a source resolver is required");
  assert.equal(evaluateRetryEligibilityDefinition(evidence, trusted, () => true).decision, "UNKNOWN", "existence-only resolvers cannot bless caller claims");
  assert.equal(evaluateRetryEligibilityDefinition(evidence, trusted, () => ({ resolved: true })).decision, "UNKNOWN", "untyped resolver responses fail closed");
  assert.equal(evaluateRetryEligibilityDefinition(evidence, trusted, () => { throw new Error("unavailable"); }).decision, "UNKNOWN", "resolver failure is held unknown");
});

test("wrong source fact, reference, scope, or value cannot produce eligibility", () => {
  const evidence = evidenceWith();
  const mismatches = [
    (source) => ({ ...source, fact: "authority" }),
    (source) => ({ ...source, evidenceRef: "fixture:evidence:other" }),
    (source) => ({ ...source, scope: { ...source.scope, tenantId: "fixture-tenant-other" } }),
    (source) => ({ ...source, value: "DENIED" }),
  ];
  for (const mutate of mismatches) {
    const map = sourceFactMap();
    map.set("priorAttempt", mutate(map.get("priorAttempt")));
    const result = evaluateRetryEligibilityDefinition(evidence, trusted, resolverFor(map));
    assert.equal(result.decision, "UNKNOWN");
    assertNotAdmitted(result);
  }

  const wrongClaim = evidenceWith({ priorAttemptDisposition: "NON_RETRYABLE" });
  const mismatch = evaluateRetryEligibilityDefinition(wrongClaim, trusted, resolverFor());
  assert.equal(mismatch.decision, "UNKNOWN", "a caller cannot replace the source-owned prior-attempt value");
  assertNotAdmitted(mismatch);
});

test("missing, omitted, bogus, or unresolved evidence references fail closed", () => {
  const evidence = evidenceWith();
  assert.equal(evaluateRetryEligibilityDefinition(evidence, trusted, () => undefined).decision, "UNKNOWN");

  const omittedEvidenceRefs = evidenceWith({ evidenceRefs: { ...refs } });
  delete omittedEvidenceRefs.evidenceRefs.priorAttempt;
  const missingRef = evaluateRetryEligibilityDefinition(omittedEvidenceRefs, trusted, resolverFor());
  assert.equal(missingRef.decision, "UNKNOWN");
  assert.equal(missingRef.reasons[0], "REQUIRED_SOURCE_EVIDENCE_REFERENCE_MISSING_OR_INVALID");

  const noDeploymentEvidence = evidenceWith({ evidenceRefs: { ...refs, deployment: "" } });
  assert.equal(evaluateRetryEligibilityDefinition(noDeploymentEvidence, trusted, resolverFor()).decision, "UNKNOWN");
});

test("license, resource, and deployment are required retry guards", () => {
  const missingDeployment = evidenceWith();
  delete missingDeployment.deploymentDisposition;
  assert.equal(evaluateRetryEligibilityDefinition(missingDeployment, trusted, resolverFor()).decision, "UNKNOWN");

  for (const [fact, field] of [
    ["license", "licenseDisposition"],
    ["resource", "resourceDisposition"],
    ["deployment", "deploymentDisposition"],
  ]) {
    const result = evaluateRetryEligibilityDefinition(
      evidenceWith({ [field]: "UNKNOWN" }), trusted, resolverFor(sourceFactMap({ [fact]: "UNKNOWN" })),
    );
    assert.equal(result.decision, "UNKNOWN", `${field} cannot be skipped`);
    assertNotAdmitted(result);
  }

  for (const [fact, field, reason] of [
    ["license", "licenseDisposition", "LICENSE_NOT_CURRENTLY_ALLOWED"],
    ["resource", "resourceDisposition", "RESOURCE_NOT_CURRENTLY_ALLOWED"],
    ["deployment", "deploymentDisposition", "DEPLOYMENT_NOT_CURRENTLY_ALLOWED"],
  ]) {
    const result = evaluateRetryEligibilityDefinition(
      evidenceWith({ [field]: "DENIED" }), trusted, resolverFor(sourceFactMap({ [fact]: "DENIED" })),
    );
    assert.equal(result.decision, "DENIED");
    assert.ok(result.reasons.includes(reason));
    assertNotAdmitted(result);
  }
});

test("known source denials and unknown prior effects remain no-effect decisions", () => {
  for (const [fact, field, value] of [
    ["priorAttempt", "priorAttemptDisposition", "NON_RETRYABLE"],
    ["priorEffect", "priorEffectDisposition", "EFFECT_CONFIRMED"],
    ["authority", "authorityDisposition", "DENIED"],
  ]) {
    const sourceValues = { [fact]: structuredClone(baseSourceValues[fact]) };
    if (fact === "priorAttempt") sourceValues[fact].priorAttemptDisposition = value;
    else sourceValues[fact] = value;
    const result = evaluateRetryEligibilityDefinition(
      evidenceWith({ [field]: value }), trusted, resolverFor(sourceFactMap(sourceValues)),
    );
    assert.equal(result.decision, "DENIED");
    assertNotAdmitted(result);
  }
  const unknownPriorEffect = evaluateRetryEligibilityDefinition(
    evidenceWith({ priorEffectDisposition: "UNKNOWN" }), trusted,
    resolverFor(sourceFactMap({ priorEffect: "UNKNOWN" })),
  );
  assert.equal(unknownPriorEffect.decision, "UNKNOWN");
  assertNotAdmitted(unknownPriorEffect);
});

test("malformed, stale, future, and overposted evidence stays non-eligible", () => {
  const sourceMap = sourceFactMap();
  const resolver = resolverFor(sourceMap);
  assert.equal(evaluateRetryEligibilityDefinition(evidenceWith({ observedAt: "2026-02-31T00:00:00.000Z" }), trusted, resolver).decision, "INVALID_FIXTURE");
  assert.equal(evaluateRetryEligibilityDefinition(evidenceWith({ observedAt: "2026-10-09" }), trusted, resolver).decision, "INVALID_FIXTURE");
  assert.equal(evaluateRetryEligibilityDefinition(evidenceWith({ observedAt: "2026-10-09T11:00:00.000Z" }), trusted, resolver).decision, "UNKNOWN");
  assert.equal(evaluateRetryEligibilityDefinition(evidenceWith({ observedAt: "2026-10-09T12:02:00.000Z" }), trusted, resolver).decision, "UNKNOWN");
  assert.equal(evaluateRetryEligibilityDefinition(evidenceWith({ retryBudgetRemaining: Number.MAX_SAFE_INTEGER + 1 }), trusted, resolver).decision, "INVALID_FIXTURE");
  assert.equal(evaluateRetryEligibilityDefinition(evidenceWith({ untrusted: true }), trusted, resolver).decision, "INVALID_FIXTURE");
  assert.equal(evaluateRetryEligibilityDefinition(evidenceWith(), null, resolver).decision, "INVALID_FIXTURE");
  assert.equal(evaluateRetryEligibilityDefinition(Object.create(evidenceWith()), trusted, resolver).decision, "INVALID_FIXTURE");
});
