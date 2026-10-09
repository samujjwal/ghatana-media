import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { evaluatePdp3TypedGuardFact } from "../scripts/lib/pdp3-guard-fact-evaluator.mjs";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const guards = parse(await readFile(".product-experience/pdp-3-product-experience/step-guard-fact-contracts.yaml", "utf8"));
const oracle = parse(await readFile(".product-experience/pdp-3-product-experience/step-definition-oracles.yaml", "utf8"));
const sampleStep = (guardRef) => {
  const ref = guards.guardContracts.records.find((row) => row.guardRef === guardRef).stepRefs[0];
  return oracle.journeys.flatMap((journey) => journey.steps).find((step) => step.sourceRef === ref);
};
const sha = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const expectedExtras = (guardRef) => {
  if (guards.guardContracts.records.find((row) => row.guardRef === guardRef)?.factFamily === "AUTHORITY_OR_ADMISSION") return ["capabilityRef", "delegationRef", "policyVersionRef", "authorityRef", "authorityVersionRef"];
  if (guardRef === "media.guard.stream.reconnect.current-fence") return ["leaseFencingToken"];
  if (guardRef === "media.guard.stream.reconnect.budget-available") return ["streamBudgetPolicyRef"];
  if (guardRef === "explicit-user-tick-values") return ["sourceClockRef", "expectedClockRate", "expectedDurationTicks"];
  if (guardRef === "authoritative-exact-source-clock-rate-and-duration") return ["sourceClockRef", "clockAuthorityRef", "expectedTimeUnitRef"];
  if (guardRef === "caption-draft-valid") return ["captionValidatorRef", "captionValidatorVersionRef", "expectedDraftRevision", "expectedSourceClockRef", "expectedTicksPerSecond", "expectedSourceDurationTicks"];
  if (guardRef === "owner-approved-project-request-shape") return ["requestSchemaRef"];
  if (guardRef === "explicit-language-intent") return ["expectedLanguageTag"];
  if (guardRef === "two-caption-versions-readable") return ["catalogSnapshotRef"];
  if (guardRef === "preserve-the-requested-context-and-exact-version-across-recovery" || guardRef === "expected-session-draft-revision") return ["expectedDraftRevision"];
  if (guardRef.startsWith("prior-") || guardRef === "existing-job-is-outcome-unknown") return ["jobVersionRef", "expectedAttemptRef", "expectedAttemptFencingToken", "expectedRetryBudgetRef"];
  return [];
};
const expected = {
  tenantScopeRef: "tenant:fixture-1", principalRef: "principal:fixture-1", workspaceRef: "workspace:fixture-1",
  actionRef: sampleStep("resolve-the-current-workspace-and-exact-target-before-access-or-change").canonicalBindings.actionRef,
  operationRefs: sampleStep("resolve-the-current-workspace-and-exact-target-before-access-or-change").canonicalBindings.operationRefs,
  targetRefs: ["media.domain.fixture"], targetVersionRefs: ["media.domain.fixture@v1"],
  purposeRef: "media.purpose.fixture", capabilityRef: "media.capability.fixture", delegationRef: "media.delegation.fixture",
  policyVersionRef: "media.policy.fixture@v1", authorityRef: "media.authority.fixture", authorityVersionRef: "authority-v1", sourceRef: "fixture-source-contract", readAuthorityRef: "media.authority.fixture",
  readVersion: "read-version-1", requestId: "request:fixture-1", actionRequestFingerprint: "a".repeat(64), leaseFencingToken: "fence-1",
  expectedAttemptRef: "media.domain.job-attempt@attempt-1", expectedAttemptFencingToken: 7, expectedRetryBudgetRef: "media.policy.retry-budget@v1",
  sourceClockRef: "media.timebase.source-clock@v1", clockAuthorityRef: "media.clock.authority.fixture", jobVersionRef: "job-version-1",
  captionValidatorRef: "media.caption.timeline-validator", captionValidatorVersionRef: "media.caption.timeline-validator.v1",
  expectedDraftRevision: 5, expectedSourceClockRef: "media.timebase.source-clock@v1", expectedTicksPerSecond: 24,
  expectedSourceDurationTicks: 96, expectedClockRate: 24, expectedDurationTicks: 96, expectedTimeUnitRef: "media.time-unit.frame",
  requestSchemaRef: "media.request-schema.fixture", requestSchemaVersionRef: "media.request-schema.fixture.v1", expectedLanguageTag: "en-US",
  catalogSnapshotRef: "media.catalog.snapshot.fixture", streamBudgetPolicyRef: "media.policy.stream.reconnect-budget.v1",
  now: "2026-10-09T12:00:00.000Z", maxAgeMs: 60_000,
};
const makeReceipt = (guardRef, value, context = expected, overrides = {}) => {
  const stepRef = guards.guardContracts.records.find((row) => row.guardRef === guardRef).stepRefs[0];
  const props = Object.keys(guards.predicateDefinitions.find((row) => row.guardRef === guardRef).receiptSchema.properties);
  const echoed = Object.fromEntries(props.filter((key) => Object.hasOwn(context, key)).map((key) => [key, context[key]]));
  const input = { stepRef, guardRef, ...echoed, ...Object.fromEntries(expectedExtras(guardRef).map((key) => [key, context[key]])), queryId: "query:fixture-1" };
  return { stepRef, guardRef, queryId: input.queryId, requestFingerprint: sha(input), ...echoed, currentness: "CURRENT", observedAt: "2026-10-09T11:59:30.000Z", value, ...overrides };
};
const run = (guardRef, value, overrides, contextOverrides = {}) => {
  const stepRef = guards.guardContracts.records.find((row) => row.guardRef === guardRef).stepRefs[0];
  const step = sampleStep(guardRef);
  const predicate = guards.predicateDefinitions.find((row) => row.guardRef === guardRef);
  const actionDefinitionRef = `.product-experience/pdp-3-product-experience/action-registry.yaml#actions/@id=${step.canonicalBindings.actionRef}`;
  const allowedExpected = new Set([...Object.keys(predicate.receiptSchema.properties).filter((key) => !["stepRef", "guardRef", "queryId", "requestFingerprint", "currentness", "observedAt", "value"].includes(key)), ...expectedExtras(guardRef), "now", "maxAgeMs"]);
  const context = { ...Object.fromEntries(Object.entries(expected).filter(([key]) => allowedExpected.has(key))), ...contextOverrides, actionRef: step.canonicalBindings.actionRef, operationRefs: step.canonicalBindings.operationRefs,
    sourceRef: actionDefinitionRef,
    readAuthorityRef: `${actionDefinitionRef}/actionDefinitionSemantics/typedDefinition/applicabilityGuards` };
  return evaluatePdp3TypedGuardFact({ guardRef, stepRef, expected: context, receipt: makeReceipt(guardRef, value, context, overrides) });
};

test("scope guards derive truth from exact scoped identities and verified query result shape", () => {
  const guard = "resolve-the-current-workspace-and-exact-target-before-access-or-change";
  const value = { resolution: "EXACT_TARGET_RESOLVED", tenantScopeRef: expected.tenantScopeRef, principalRef: expected.principalRef, workspaceRef: expected.workspaceRef, targetRefs: expected.targetRefs, objectVersionRefs: expected.targetVersionRefs };
  assert.equal(run(guard, value).truth, "TRUE");
  assert.equal(run(guard, { ...value, resolution: "EXACT_TARGET_ABSENT", targetRefs: [], objectVersionRefs: [] }).truth, "FALSE");
  assert.equal(run(guard, { ...value, workspaceRef: "workspace:foreign" }).truth, "UNKNOWN");
  assert.equal(run(guard, { ...value, targetRefs: ["media.domain.other@v1"] }).truth, "UNKNOWN");
});

test("authority guards require exact actor, operation, target, scope, validity and admitted capability", () => {
  const guard = "current-project-create-authority";
  const value = { actorRef: expected.principalRef, operationRefs: sampleStep(guard).canonicalBindings.operationRefs, targetRefs: expected.targetRefs, purposeRef: expected.purposeRef,
    capabilityRef: expected.capabilityRef, delegationRef: expected.delegationRef, policyVersionRef: expected.policyVersionRef,
    authorityRef: expected.authorityRef, authorityVersionRef: expected.authorityVersionRef, decision: "GRANTED",
    validFrom: "2026-10-09T10:00:00.000Z", validUntil: "2026-10-09T13:00:00.000Z", admissionStatus: "ADMITTED" };
  assert.equal(run(guard, value).truth, "UNKNOWN", "a synthetic admitted flag cannot override the canonical operation's NOT_ADMITTED status");
  assert.equal(run(guard, { ...value, decision: "DENIED" }).truth, "FALSE");
  assert.equal(run(guard, { ...value, admissionStatus: "NOT_ADMITTED" }).truth, "FALSE");
  assert.equal(run(guard, { ...value, actorRef: "principal:other" }).truth, "UNKNOWN");
  assert.equal(run(guard, { ...value, validUntil: "2026-10-09T11:00:00.000Z" }).truth, "UNKNOWN");
});

test("continuity guards distinguish an exact continuation from a current revision conflict", () => {
  const guard = "preserve-the-requested-context-and-exact-version-across-recovery";
  const value = { requestId: expected.requestId, requestFingerprint: expected.actionRequestFingerprint, priorObjectVersionRefs: expected.targetVersionRefs,
    observedObjectVersionRefs: expected.targetVersionRefs, draftRevision: 5, expectedDraftRevision: 5, continuationState: "PERMITTED" };
  assert.equal(run(guard, value).truth, "TRUE");
  assert.equal(run(guard, { ...value, continuationState: "CONFLICT", draftRevision: 6 }).truth, "FALSE");
  assert.equal(run(guard, { ...value, observedObjectVersionRefs: ["media.domain.foreign@v1"] }).truth, "FALSE");
  assert.equal(run(guard, { ...value, continuationState: "UNKNOWN" }).truth, "UNKNOWN");
  assert.equal(run(guard, { ...value, draftRevision: Number.MAX_SAFE_INTEGER + 1 }).truth, "UNKNOWN");
});

test("typed observation guards require exact subject, purpose, version and evidence", () => {
  const guard = "exact-source-version-readable";
  const value = { observationKind: "SOURCE_VERSION_READ", subjectRefs: expected.targetRefs, versionRefs: expected.targetVersionRefs, purposeRef: expected.purposeRef,
    observationStatus: "OBSERVED", evidenceRefs: ["evidence:fixture-1"], details: { availability: "AVAILABLE", readDisposition: "READABLE", artifactVersionRef: expected.targetVersionRefs[0], canonicalObjectRef: expected.targetRefs[0] } };
  assert.equal(run(guard, value).truth, "TRUE");
  assert.equal(run(guard, { ...value, observationStatus: "ABSENT", evidenceRefs: [] }).truth, "FALSE");
  assert.equal(run(guard, { ...value, subjectRefs: ["media.domain.other@v1"] }).truth, "UNKNOWN");
  assert.equal(run(guard, { ...value, versionRefs: [], evidenceRefs: [] }).truth, "UNKNOWN");
  assert.equal(run(guard, { ...value, observationStatus: "UNKNOWN" }).truth, "UNKNOWN");
});

test("caption validity, source clocks, two-version comparison, and language intent are guard-specific", () => {
  const caption = "caption-draft-valid";
  const captionVersions = [expected.targetVersionRefs[0], "media.domain.caption-draft@v1"];
  const captionTargets = [expected.targetRefs[0], "media.domain.caption-draft"];
  const draft = { observationKind: "CAPTION_DRAFT_VALUE_VALIDATION", subjectRefs: captionTargets, versionRefs: captionVersions, purposeRef: expected.purposeRef, observationStatus: "OBSERVED", evidenceRefs: ["evidence:caption-validation"], details: { validatorRef: expected.captionValidatorRef, validatorVersionRef: expected.captionValidatorVersionRef, draftRef: "media.domain.caption-draft@v1", draftRevision: expected.expectedDraftRevision, sourceVersionRef: captionVersions[0], parentVersionRef: captionVersions[1], timingAvailability: "NOT_SUPPLIED", segments: [{ segmentId: "segment-1", segmentOrder: 0, text: "Reviewed caption", origin: "USER_EDITED", languageDisposition: "NOT_SELECTED", timing: { kind: "NOT_SUPPLIED" } }] } };
  assert.equal(run(caption, draft, undefined, { targetRefs: captionTargets, targetVersionRefs: captionVersions }).truth, "TRUE");
  assert.equal(run(caption, { ...draft, details: { ...draft.details, validatorRef: "unrelated-validator" } }).truth, "UNKNOWN");
  assert.equal(run(caption, { ...draft, observationStatus: "INVALID", details: { ...draft.details, segments: [] } }, undefined, { targetRefs: captionTargets, targetVersionRefs: captionVersions }).truth, "UNKNOWN", "an INVALID wrapper does not substitute for a source-validated negative result");

  const clock = "authoritative-exact-source-clock-rate-and-duration";
  const clockFact = { observationKind: "SOURCE_CLOCK", subjectRefs: expected.targetRefs, versionRefs: expected.targetVersionRefs, purposeRef: expected.purposeRef, observationStatus: "OBSERVED", evidenceRefs: ["evidence:clock"], details: { clockRef: expected.sourceClockRef, sourceVersionRef: expected.targetVersionRefs[0], clockAuthorityRef: expected.clockAuthorityRef, rateNumerator: 24000, rateDenominator: 1001, durationTicks: 240000, timeUnitRef: "media.time-unit.frame" } };
  assert.equal(run(clock, clockFact).truth, "TRUE");
  assert.equal(run(clock, { ...clockFact, details: { ...clockFact.details, rateDenominator: 0 } }).truth, "UNKNOWN");
  assert.equal(run(clock, { ...clockFact, details: { ...clockFact.details, clockAuthorityRef: "foreign-clock-authority" } }).truth, "UNKNOWN");

  const compare = "two-caption-versions-readable";
  const versions = ["media.domain.caption-version@v1", "media.domain.caption-version@v2"];
  const comparison = { observationKind: "CAPTION_VERSION_READ", subjectRefs: expected.targetRefs, versionRefs: versions, purposeRef: expected.purposeRef, observationStatus: "OBSERVED", evidenceRefs: ["evidence:caption-v1", "evidence:caption-v2"], details: { captionVersionRefs: versions, readableVersionRefs: versions, readabilityAuthorityRef: `${`.product-experience/pdp-3-product-experience/action-registry.yaml#actions/@id=${sampleStep(compare).canonicalBindings.actionRef}`}/actionDefinitionSemantics/typedDefinition/applicabilityGuards`, catalogSnapshotRef: expected.catalogSnapshotRef } };
  assert.equal(run(compare, comparison, undefined, { targetVersionRefs: versions }).truth, "TRUE");
  assert.equal(run(compare, { ...comparison, versionRefs: versions.slice(0, 1), details: { ...comparison.details, captionVersionRefs: versions.slice(0, 1), readableVersionRefs: versions.slice(0, 1) } }, undefined, { targetVersionRefs: versions.slice(0, 1) }).truth, "UNKNOWN");

  const language = "explicit-language-intent";
  const intent = { observationKind: "USER_LANGUAGE_INTENT", subjectRefs: expected.targetRefs, versionRefs: expected.targetVersionRefs, purposeRef: expected.purposeRef, observationStatus: "OBSERVED", evidenceRefs: ["ui-event:language-selection"], details: { languageTag: expected.expectedLanguageTag, intentMode: "EXPLICIT_USER_SELECTION", userInputEventRef: "ui-event:language-selection", sourceVersionRef: expected.targetVersionRefs[0], detectorConfidenceDisposition: "NOT_APPLICABLE" } };
  assert.equal(run(language, intent).truth, "TRUE");
  assert.equal(run(language, { ...intent, details: { ...intent.details, intentMode: "AUTO_DETECTED" } }).truth, "FALSE");
  assert.equal(run(language, { ...intent, details: { ...intent.details, languageTag: "fr-FR" } }).truth, "UNKNOWN");
});

test("receipt currentness, expected version, step binding and fingerprint fail closed", () => {
  const guard = "resolve-the-current-workspace-and-exact-target-before-access-or-change";
  const value = { resolution: "EXACT_TARGET_RESOLVED", tenantScopeRef: expected.tenantScopeRef, principalRef: expected.principalRef, workspaceRef: expected.workspaceRef, targetRefs: expected.targetRefs, objectVersionRefs: ["media.domain.fixture@v1"] };
  assert.equal(run(guard, value, { currentness: "STALE" }).truth, "UNKNOWN");
  assert.equal(run(guard, value, { readVersion: "foreign-version" }).truth, "UNKNOWN");
  assert.equal(run(guard, value, { requestFingerprint: "0".repeat(64) }).truth, "UNKNOWN");
  const predicate = guards.predicateDefinitions.find((row) => row.guardRef === guard);
  assert.equal(run(guard, value, { sourceRef: "media.operation.unrelated" }).truth, "UNKNOWN");
  assert.equal(run(guard, value, { readAuthorityRef: predicate.sourceActionDefinitionRef }).truth, "UNKNOWN");
  assert.equal(evaluatePdp3TypedGuardFact({ guardRef: "unbound-guard", stepRef: "step:unbound", expected, receipt: {} }).truth, "UNKNOWN");
});

test("stream guards derive session, lease, frame, budget and sequence facts structurally", () => {
  const base = { tenantScopeRef: expected.tenantScopeRef, sessionRef: expected.targetRefs[0], ownerPrincipalRef: expected.principalRef };
  const guard = (guardRef, stream) => run(guardRef, { stream });
  assert.equal(guard("media.guard.stream.reconnect.same-session-scope", base).truth, "TRUE");
  assert.equal(guard("media.guard.stream.reconnect.same-session-scope", { ...base, sessionRef: "media.domain.foreign-session" }).truth, "UNKNOWN");
  assert.equal(guard("media.guard.stream.reconnect.degraded-session", { ...base, sessionState: "DEGRADED" }).truth, "TRUE");
  assert.equal(guard("media.guard.stream.reconnect.degraded-session", { ...base, sessionState: "CONNECTED" }).truth, "FALSE");
  const lease = { ...base, lease: { ...base, fencingToken: expected.leaseFencingToken, disposition: "CURRENT", leaseVersionRef: "lease-v1" } };
  assert.equal(guard("media.guard.stream.reconnect.current-fence", lease).truth, "TRUE");
  assert.equal(guard("media.guard.stream.reconnect.current-fence", { ...lease, lease: { ...lease.lease, fencingToken: "other-fence" } }).truth, "UNKNOWN");
  assert.equal(guard("media.guard.stream.reconnect.current-fence", { ...lease, lease: { ...lease.lease, disposition: "FENCED" } }).truth, "FALSE");
  const frameEffects = { ...base, unresolvedFrameEffects: [{ tenantScopeRef: base.tenantScopeRef, sessionRef: base.sessionRef, sequence: 3, effectDisposition: "ACKNOWLEDGED" }] };
  assert.equal(guard("media.guard.stream.reconnect.prior-effects-resolved", frameEffects).truth, "TRUE");
  assert.equal(guard("media.guard.stream.reconnect.prior-effects-resolved", { ...frameEffects, unresolvedFrameEffects: [...frameEffects.unresolvedFrameEffects, { ...frameEffects.unresolvedFrameEffects[0], effectDisposition: "REJECTED" }] }).truth, "UNKNOWN");
  const nowMs = Date.parse(expected.now);
  const budget = { ...base, recoveryBudget: { tenantScopeRef: base.tenantScopeRef, sessionRef: base.sessionRef, policyRef: "media.policy.stream.reconnect-budget.v1", disposition: "CURRENT", remainingReconnectRequests: 1, deadlineEpochMilliseconds: nowMs + 5000, observedAtEpochMilliseconds: nowMs - 1000 } };
  assert.equal(guard("media.guard.stream.reconnect.budget-available", budget).truth, "TRUE");
  assert.equal(guard("media.guard.stream.reconnect.budget-available", { ...budget, recoveryBudget: { ...budget.recoveryBudget, remainingReconnectRequests: 0 } }).truth, "FALSE");
  assert.equal(guard("media.guard.stream.reconnect.budget-available", { ...budget, recoveryBudget: { ...budget.recoveryBudget, deadlineEpochMilliseconds: nowMs - 1 } }).truth, "FALSE");
  assert.equal(guard("media.guard.stream.reconnect.next-sequence-contiguous", { ...base, lastAcknowledgedFrameSequence: 4, reconnectSequence: 5 }).truth, "TRUE");
  assert.equal(guard("media.guard.stream.reconnect.next-sequence-contiguous", { ...base, lastAcknowledgedFrameSequence: Number.MAX_SAFE_INTEGER, reconnectSequence: 0 }).truth, "UNKNOWN");
});

test("job guards require exact canonical job and attempt state evidence", () => {
  const job = { jobRef: expected.targetRefs[0], jobVersionRef: expected.jobVersionRef, tenantScopeRef: expected.tenantScopeRef, ownerPrincipalRef: expected.principalRef,
    jobCanonicalStateRef: ".product-experience/pdp-1-domain-data/states.yaml#stateMachines/media-job/stateDefinitions/OUTCOME_UNKNOWN", jobState: "OUTCOME_UNKNOWN",
    attemptRef: expected.expectedAttemptRef, attemptVersionRef: "attempt-version-1", attemptFencingToken: expected.expectedAttemptFencingToken, attemptDisposition: "RETRYABLE", effectDisposition: "NO_EFFECT_CONFIRMED",
    retryBudgetRef: expected.expectedRetryBudgetRef, retryBudgetRemaining: 1, stateAuthorityRef: ".product-experience/pdp-1-domain-data/transitions.yaml#ownerRaceResolutionContract" };
  const jobContext = { targetRefs: [job.jobRef], targetVersionRefs: [job.jobVersionRef], jobVersionRef: job.jobVersionRef };
  assert.equal(run("existing-job-is-outcome-unknown", job, undefined, jobContext).truth, "TRUE");
  assert.equal(run("prior-outcome-is-not-unknown; check-the-existing-job-outcome-first", job, undefined, jobContext).truth, "FALSE");
  assert.equal(run("prior-attempt-is-classified-as-retryable-by-the-job-owner", job, undefined, jobContext).truth, "TRUE");
  assert.equal(run("prior-attempt-is-classified-as-retryable-by-the-job-owner", { ...job, effectDisposition: "EFFECT_CONFIRMED" }, undefined, jobContext).truth, "FALSE");
  assert.equal(run("existing-job-is-outcome-unknown", { ...job, jobCanonicalStateRef: "runtime-status-label" }, undefined, jobContext).truth, "UNKNOWN");
  assert.equal(run("prior-attempt-is-classified-as-retryable-by-the-job-owner", { ...job, tenantScopeRef: "tenant:other" }, undefined, jobContext).truth, "UNKNOWN");
});

test("explicit time ticks must be user supplied and fit the exact source clock", () => {
  const fact = { timebaseRef: expected.sourceClockRef, sourceVersionRef: expected.targetVersionRefs[0], userInputEventRef: "ui-event:fixture-1", ticks: [0, 24, 48], clockRate: 24, durationTicks: 96 };
  assert.equal(run("explicit-user-tick-values", fact, undefined, { expectedClockRate: 24, expectedDurationTicks: 96 }).truth, "TRUE");
  assert.equal(run("explicit-user-tick-values", { ...fact, ticks: [] }).truth, "FALSE");
  assert.equal(run("explicit-user-tick-values", { ...fact, ticks: [24, 24] }).truth, "UNKNOWN");
  assert.equal(run("explicit-user-tick-values", { ...fact, sourceVersionRef: "media.domain.other@v1" }).truth, "UNKNOWN");
});

test("every indexed step-guard instance fails closed without a receipt", () => {
  const instances = guards.guardContracts.records.flatMap((row) => row.stepRefs.map((stepRef) => ({ guardRef: row.guardRef, stepRef })));
  assert.equal(instances.length, 254);
  for (const instance of instances) {
    const result = evaluatePdp3TypedGuardFact({ ...instance, expected: null, receipt: null });
    assert.equal(result.truth, "UNKNOWN", `${instance.guardRef} at ${instance.stepRef}`);
    assert.equal(result.retryAuthorized, false);
    assert.equal(result.effect, "NONE");
  }
});
