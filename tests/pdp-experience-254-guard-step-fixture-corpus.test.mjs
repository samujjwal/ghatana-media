import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { evaluatePdp3TypedGuardFact, evaluatePdp3RightsGuardFact, evaluatePdp3RetryBudgetCapacity } from "../scripts/lib/pdp3-guard-fact-evaluator.mjs";
import { typedObservationRequestFingerprint } from "../scripts/lib/pdp-truth-domain-observation-currentness.mjs";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const parse = require("yaml").parse;
const guards = parse(readFileSync(".product-experience/pdp-3-product-experience/step-guard-fact-contracts.yaml", "utf8"));
const oracles = parse(readFileSync(".product-experience/pdp-3-product-experience/step-definition-oracles.yaml", "utf8"));
const operations = parse(readFileSync(".product-experience/pdp-1-domain-data/operations.yaml", "utf8"));
const rightsContract = operations.ownerTypedObservationContracts.records.find((row) => row.id === "media.observation-contract.rights-decision.v1");
const steps = new Map(oracles.journeys.flatMap((journey) => journey.steps.map((step) => [step.sourceRef, step])));
const NOW = "2026-10-09T12:00:00.000Z";
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const predicateByGuard = new Map(guards.predicateDefinitions.map((row) => [row.guardRef, row]));
const authorityGuardRefs = new Set(["confirm-current-actor-authority-and-owner-approved-capability-before-governed-effects", "confirm-owner-approved-actor-and-capability-authority-before-governed-effects", "current-scoped-source-read-and-derived-edit-authority", "current-read-authority", "current-project-create-authority", "current-project-read-authority", "current-cancellation-authority", "current-actor-has-retry-authority-for-this-job", "rights-policy-license-resource-and-deployment-eligibility-are-rechecked-before-dispatch", "admitted-capability-and-policy", "current-scoped-read-authority", "current-scoped-derived-edit-authority", "current-commit-authority", "current-upload-and-import-authority", "rights-consent-retention-and-format-admission", "current-authority-and-retention-policy"]);
const extras = (guardRef, family) => {
  if (guardRef === "retry-budget-remains-under-current-policy") return ["jobVersionRef", "expectedAttemptRef", "expectedAttemptFencingToken", "expectedRetryBudgetRef", "expectedRetryBudgetVersionRef", "expectedRetryBudgetUnitRef", "expectedRequestedRetryUnits", "expectedRetryPolicyRef", "expectedRetryPolicyVersionRef", "expectedRetryPolicyAuthorityRef", "expectedRetryPolicyAuthorityVersionRef"];
  if (guardRef === "owner-approved-project-request-shape") return ["requestSchemaRef", "requestSchemaVersionRef"];
  if (guardRef === "caption-draft-valid") return ["captionValidatorRef", "captionValidatorVersionRef", "expectedDraftRevision", "expectedSourceClockRef", "expectedTicksPerSecond", "expectedSourceDurationTicks"];
  if (["confirm-current-actor-authority-and-owner-approved-capability-before-governed-effects", "confirm-owner-approved-actor-and-capability-authority-before-governed-effects", "current-scoped-source-read-and-derived-edit-authority", "current-read-authority", "current-project-create-authority", "current-project-read-authority", "current-cancellation-authority", "current-actor-has-retry-authority-for-this-job", "retry-budget-remains-under-current-policy", "rights-policy-license-resource-and-deployment-eligibility-are-rechecked-before-dispatch", "admitted-capability-and-policy", "current-scoped-read-authority", "current-scoped-derived-edit-authority", "current-commit-authority", "current-upload-and-import-authority", "rights-consent-retention-and-format-admission", "current-authority-and-retention-policy"].includes(guardRef)) return ["capabilityRef", "delegationRef", "policyVersionRef", "authorityRef", "authorityVersionRef"];
  if (guardRef === "media.guard.stream.reconnect.current-fence") return ["leaseFencingToken"];
  if (guardRef === "media.guard.stream.reconnect.budget-available") return ["streamBudgetPolicyRef"];
  if (guardRef === "explicit-user-tick-values") return ["sourceClockRef", "expectedClockRate", "expectedDurationTicks"];
  if (guardRef === "authoritative-exact-source-clock-rate-and-duration") return ["sourceClockRef", "clockAuthorityRef", "expectedTimeUnitRef"];
  if (guardRef === "caption-draft-valid") return ["captionValidatorRef"];
  if (guardRef === "owner-approved-project-request-shape") return ["requestSchemaRef"];
  if (guardRef === "explicit-language-intent") return ["expectedLanguageTag"];
  if (guardRef === "two-caption-versions-readable") return ["catalogSnapshotRef"];
  if (guardRef === "exact-source-selected") return ["catalogSnapshotRef"];
  if (["expected-session-draft-revision", "preserve-the-requested-context-and-exact-version-across-recovery", "preserve-current-draft-and-prior-versions", "matching-source-metadata-and-immutable-request-binding", "observed-state-permits-continuation"].includes(guardRef)) return ["expectedDraftRevision"];
  if (["existing-job-is-outcome-unknown", "prior-outcome-is-not-unknown; check-the-existing-job-outcome-first", "prior-attempt-is-classified-as-retryable-by-the-job-owner"].includes(guardRef)) return ["jobVersionRef", "expectedAttemptRef", "expectedAttemptFencingToken", "expectedRetryBudgetRef"];
  return [];
};
const reservedReceiptKeys = new Set(["stepRef", "guardRef", "queryId", "requestFingerprint", "currentness", "observedAt", "value"]);
function makeContext(guardRef, step, mode = "positive") {
  const predicate = predicateByGuard.get(guardRef);
  const family = guards.guardContracts.records.find((row) => row.guardRef === guardRef)?.factFamily;
  const receiptProps = Object.keys(predicate.receiptSchema.properties);
  const allowed = new Set([...receiptProps.filter((key) => !reservedReceiptKeys.has(key)), ...extras(guardRef, family), "now", "maxAgeMs"]);
  const binding = step.canonicalBindings ?? {};
  const targetRefs = binding.ownerDomainObjectRefs?.length ? [...binding.ownerDomainObjectRefs] : binding.domainObjectRefs?.length ? [...binding.domainObjectRefs] : [`media.fixture.target.${binding.bindingId ?? "step"}`];
  if (guardRef === "exact-source-and-typed-parent-readable" && targetRefs.length < 2) targetRefs.push("media.domain.project.fixture-parent");
  if (guardRef === "two-caption-versions-readable") targetRefs.splice(0, targetRefs.length, "media.domain.caption-version", "media.domain.caption-version");
  if (guardRef === "caption-draft-valid") targetRefs.splice(0, targetRefs.length, "media.domain.caption-version", "media.domain.artifact-version");
  const targetVersionRefs = guardRef === "two-caption-versions-readable"
    ? ["media.domain.caption-version@definition-fixture-v1", "media.domain.caption-version@definition-fixture-v2"]
    : targetRefs.map((ref, index) => `${ref}@definition-fixture-v${index + 1}`);
  const actionRef = binding.actionRef ?? step.actionRef;
  const actionDefinitionRef = `.product-experience/pdp-3-product-experience/action-registry.yaml#actions/@id=${actionRef}`;
  const defaultValues = {
    tenantScopeRef: "media.fixture.tenant.alpha", principalRef: "media.fixture.principal.editor",
    workspaceRef: "media.fixture.workspace.alpha", actionRef,
    operationRefs: binding.operationRefs ?? [], targetRefs, targetVersionRefs,
    purposeRef: "media.purpose.definition-fixture", capabilityRef: binding.capabilityOptions?.[0]?.capabilityRef ?? `media.capability.for.${actionRef}`,
    delegationRef: "media.fixture.delegation.alpha", policyVersionRef: "media.policy.fixture.v1",
    authorityRef: "media.fixture.authority.alpha", authorityVersionRef: "media.fixture.authority.alpha.v1",
    sourceRef: actionDefinitionRef,
    readAuthorityRef: `${actionDefinitionRef}/actionDefinitionSemantics/typedDefinition/applicabilityGuards`,
    readVersion: "media.fixture.read-version.v1", requestId: `media.fixture.request.${binding.bindingId ?? "step"}`,
    actionRequestFingerprint: "a".repeat(64), leaseFencingToken: "media.fixture.lease-fence.v1",
    expectedAttemptRef: "media.fixture.attempt.prior", expectedAttemptFencingToken: 4,
    expectedRetryBudgetRef: "media.policy.retry-budget.fixture.v1", sourceClockRef: "media.timebase.fixture.v1",
    expectedRetryBudgetVersionRef: "media.policy.retry-budget.fixture.v1.version.7", expectedRetryBudgetUnitRef: "media.retry-budget-unit.attempt", expectedRequestedRetryUnits: 1,
    clockAuthorityRef: "media.fixture.clock-authority.v1", jobVersionRef: "media.fixture.job.v1",
    captionValidatorRef: "media.fixture.caption-validator.v1", requestSchemaRef: "media.fixture.project-request-schema.v1",
    expectedLanguageTag: "en-US", catalogSnapshotRef: "media.fixture.catalog-snapshot.v1",
    expectedDraftRevision: 3, expectedTimeUnitRef: "media.timeunit.frame",
    expectedClockRate: 24, expectedDurationTicks: 240,
    requestSchemaRef: ".product-experience/pdp-1-domain-data/operations.yaml#individualOperationContracts/records/@id=media.operation-slice.create-project/ownerWireSchema/requestSchema",
    requestSchemaVersionRef: ".product-experience/pdp-1-domain-data/operations.yaml#individualOperationContracts/records/@id=media.operation-slice.create-project/ownerWireSchema",
    captionValidatorRef: "media.caption.timeline-validator", captionValidatorVersionRef: "media.caption.timeline-validator.v1",
    expectedSourceClockRef: "media.timebase.fixture.v1", expectedTicksPerSecond: 24, expectedSourceDurationTicks: 240,
    expectedRetryPolicyRef: "media.retry-policy", expectedRetryPolicyVersionRef: "media.retry-policy.v1",
    expectedRetryPolicyAuthorityRef: "media.authority.retry-policy.v1", expectedRetryPolicyAuthorityVersionRef: "media.authority.retry-policy.v1",
    streamBudgetPolicyRef: "media.policy.stream.reconnect-budget.v1", now: NOW, maxAgeMs: 60_000,
  };
  if (guardRef === "owner-approved-project-request-shape") {
    const requestPayload = { selectedAuthorizedWorkspaceId: "media.fixture.workspace.alpha", title: mode === "denial" ? "   " : "Fixture project", requestId: defaultValues.requestId };
    defaultValues.actionRequestFingerprint = digest({ operationRef: "media.operation-slice.create-project", trusted: { tenantScopeRef: defaultValues.tenantScopeRef, principalRef: defaultValues.principalRef }, requestPayload });
  }
  return Object.fromEntries(Object.entries(defaultValues).filter(([key]) => allowed.has(key)));
}
function makeReceipt(guardRef, stepRef, expected, value) {
  const predicate = predicateByGuard.get(guardRef);
  const props = Object.keys(predicate.receiptSchema.properties);
  const echoKeys = props.filter((key) => !reservedReceiptKeys.has(key));
  const echoed = Object.fromEntries(echoKeys.map((key) => [key, expected[key]]));
  const queryId = `media.fixture.query.${digest({ guardRef, stepRef }).slice(0, 16)}`;
  const extraFingerprintKeys = extras(guardRef, guards.guardContracts.records.find((row) => row.guardRef === guardRef)?.factFamily);
  const fingerprintInput = { stepRef, guardRef, ...Object.fromEntries([...echoKeys, ...extraFingerprintKeys].map((key) => [key, expected[key]])), queryId };
  return { stepRef, guardRef, queryId, requestFingerprint: digest(fingerprintInput), ...echoed,
    currentness: "CURRENT", observedAt: "2026-10-09T11:59:30.000Z", value };
}
function observationValue(guardRef, expected, mode) {
  const targetRefs = expected.targetRefs;
  const versionRefs = expected.targetVersionRefs;
  const status = mode === "unknown" ? "UNKNOWN" : ["caption-draft-valid", "owner-approved-project-request-shape"].includes(guardRef) ? "OBSERVED" : mode === "denial" ? "ABSENT" : "OBSERVED";
  let details = {};
  if (guardRef === "exact-source-and-typed-parent-readable") {
    const subjects = targetRefs;
    const versions = versionRefs;
    return { observationKind: "SOURCE_AND_PARENT_READ", subjectRefs: subjects, versionRefs: versions, purposeRef: expected.purposeRef, observationStatus: status,
      evidenceRefs: mode === "positive" ? ["media.fixture.evidence.read"] : [],
      details: { sourceVersionRef: versions[0], parentObjectRefs: subjects.slice(1), parentVersionRefs: versions.slice(1), readability: mode === "positive" ? "READABLE" : mode === "denial" ? "NOT_READABLE" : "UNKNOWN", mediaType: "video/mp4" } };
  }
  if (["source-available", "exact-source-version-readable", "exact-canonical-transcript-version-readable"].includes(guardRef)) {
    details = { availability: mode === "positive" ? "AVAILABLE" : mode === "denial" ? "UNAVAILABLE" : "UNKNOWN",
      readDisposition: mode === "positive" ? "READABLE" : mode === "denial" ? "NOT_READABLE" : "UNKNOWN",
      artifactVersionRef: versionRefs[0], canonicalObjectRef: targetRefs[0] };
  } else if (guardRef === "authoritative-exact-source-clock-rate-and-duration") {
    details = { clockRef: expected.sourceClockRef, sourceVersionRef: versionRefs[0], clockAuthorityRef: expected.clockAuthorityRef,
      rateNumerator: 24, rateDenominator: 1, durationTicks: 240, timeUnitRef: "media.timeunit.frame" };
  } else if (guardRef === "caption-draft-valid") {
    details = { validatorRef: expected.captionValidatorRef, validatorVersionRef: expected.captionValidatorVersionRef,
      draftRef: "media.fixture.caption-draft.v1", draftRevision: mode === "foreign" ? expected.expectedDraftRevision + 1 : expected.expectedDraftRevision,
      sourceVersionRef: versionRefs[0], parentVersionRef: versionRefs[1], timingAvailability: "SOURCE_CLOCK_BOUND",
      segments: [{ segmentId: "media.fixture.caption-segment-1", segmentOrder: 0, text: "Fixture caption", origin: "RECOGNIZED",
        languageDisposition: "UNCERTAIN", languageTag: null, uncertaintyObservations: ["media.fixture.language-uncertain"], evidenceRefs: ["media.fixture.caption-evidence"],
        timing: { kind: "SOURCE_TICKS", sourceClockRef: expected.expectedSourceClockRef, sourceVersionRef: versionRefs[0], ticksPerSecond: expected.expectedTicksPerSecond,
          sourceDurationTicks: expected.expectedSourceDurationTicks, startTick: 0, endTick: mode === "denial" ? expected.expectedSourceDurationTicks + 1 : 100 } }] };
  } else if (guardRef === "parent-source-current") {
    details = { requestedParentVersionRef: versionRefs[0], observedCurrentParentVersionRef: mode === "denial" ? "media.domain.artifact-version.changed-fixture-v2" : versionRefs[0],
      parentRevisionRef: "media.domain.project-revision.fixture-v3", currentness: mode === "unknown" ? "UNKNOWN" : "CURRENT" };
  } else if (guardRef === "two-caption-versions-readable") {
    const versions = versionRefs.length === 2 ? versionRefs : ["media.domain.caption-version.fixture-v1", "media.domain.caption-version.fixture-v2"];
    return { observationKind: "CAPTION_VERSION_COMPARISON", subjectRefs: targetRefs, versionRefs: versions, purposeRef: expected.purposeRef, observationStatus: status,
      evidenceRefs: mode === "positive" ? ["media.fixture.evidence.caption-read"] : [],
      details: { captionVersionRefs: versions, readableVersionRefs: mode === "positive" ? versions : mode === "denial" ? versions.slice(0, 1) : [], readabilityAuthorityRef: expected.readAuthorityRef, catalogSnapshotRef: expected.catalogSnapshotRef } };
  } else if (guardRef === "exact-source-selected") {
    details = { selectedSourceRef: targetRefs[0], selectedVersionRef: versionRefs[0], selectionEventRef: "media.fixture.user-selection.event-v1", catalogSnapshotRef: expected.catalogSnapshotRef };
  } else if (guardRef === "owner-approved-project-request-shape") {
    const requestPayload = { selectedAuthorizedWorkspaceId: mode === "foreign" ? "media.fixture.workspace.foreign" : expected.workspaceRef,
      title: mode === "denial" ? "   " : "Fixture project", requestId: expected.requestId };
    details = { schemaRef: expected.requestSchemaRef, schemaVersionRef: expected.requestSchemaVersionRef,
      requestFingerprint: digest({ operationRef: "media.operation-slice.create-project", trusted: { tenantScopeRef: expected.tenantScopeRef, principalRef: expected.principalRef }, requestPayload }), requestPayload };
  } else if (guardRef === "explicit-language-intent") {
    details = { languageTag: expected.expectedLanguageTag, intentMode: mode === "positive" ? "EXPLICIT_USER_SELECTION" : mode === "denial" ? "AUTO_DETECTED" : "UNKNOWN",
      userInputEventRef: "media.fixture.user-input.language-choice", sourceVersionRef: versionRefs[0], detectorConfidenceDisposition: "NOT_APPLICABLE" };
  }
  if (guardRef === "existing-stable-upload-identity") {
    return { observationKind: "UPLOAD_IDENTITY_OBSERVATION", subjectRefs: targetRefs, versionRefs, purposeRef: expected.purposeRef,
      observationStatus: mode === "unknown" ? "UNKNOWN" : "OBSERVED", evidenceRefs: mode === "unknown" ? [] : ["media.fixture.evidence.upload-read"],
      details: { uploadSessionRef: targetRefs.find((ref) => ref.includes("upload-session")) ?? targetRefs[0],
        artifactRef: targetRefs.find((ref) => ref === "media.domain.artifact") ?? targetRefs[1] ?? targetRefs[0],
        artifactVersionRef: versionRefs.find((ref) => ref.includes("artifact-version")) ?? versionRefs[0], requestId: expected.requestId,
        requestFingerprint: expected.actionRequestFingerprint, identityDisposition: mode === "positive" ? "STABLE" : mode === "denial" ? "CONFLICT" : "UNKNOWN" } };
  }
  const observationKind = guardRef === "caption-draft-valid" ? "CAPTION_DRAFT_VALUE_VALIDATION" :
    guardRef === "owner-approved-project-request-shape" ? "CANONICAL_REQUEST_SCHEMA_VALIDATION" : `MEDIA_TYPED_OBSERVATION:${guardRef}`;
  return { observationKind, subjectRefs: targetRefs, versionRefs, purposeRef: expected.purposeRef,
    observationStatus: status, evidenceRefs: mode === "unknown" ? [] : ["media.fixture.evidence.observation"], details };
}
function valueFor(guardRef, expected, mode) {
  const guard = guards.guardContracts.records.find((row) => row.guardRef === guardRef);
  const predicateKind = predicateByGuard.get(guardRef)?.predicateKind;
  if (guardRef === "retry-budget-remains-under-current-policy") return {
    tenantScopeRef: mode === "foreign" ? "media.fixture.tenant.foreign" : expected.tenantScopeRef,
    principalRef: expected.principalRef, jobRef: expected.targetRefs[0], jobVersionRef: expected.jobVersionRef,
    attemptRef: expected.expectedAttemptRef, attemptFencingToken: expected.expectedAttemptFencingToken,
    budgetRef: expected.expectedRetryBudgetRef, budgetVersionRef: expected.expectedRetryBudgetVersionRef, unitRef: expected.expectedRetryBudgetUnitRef,
    policyRef: expected.expectedRetryPolicyRef, policyVersionRef: expected.expectedRetryPolicyVersionRef,
    policyAuthorityRef: expected.expectedRetryPolicyAuthorityRef, policyAuthorityVersionRef: expected.expectedRetryPolicyAuthorityVersionRef,
    policyCurrentness: mode === "unknown" ? "UNKNOWN" : "CURRENT",
    policyDisposition: mode === "denial" ? "RETRY_DENIED" : mode === "unknown" ? "UNKNOWN" : "RETRY_ALLOWED",
    limitUnits: mode === "denial" ? 1 : 4, spentUnits: 1, heldUnits: 1, requestedUnits: expected.expectedRequestedRetryUnits,
    observedAt: "2026-10-09T11:59:30.000Z", validFrom: "2026-10-09T10:00:00.000Z", validUntil: "2026-10-09T13:00:00.000Z", evidenceRef: "media.fixture.retry-budget-evidence.v1",
  };
  if (predicateKind === "EXACT_SCOPED_TARGET") return { resolution: mode === "denial" ? "EXACT_TARGET_ABSENT" : "EXACT_TARGET_RESOLVED",
    tenantScopeRef: mode === "unknown" ? "media.fixture.tenant.foreign" : expected.tenantScopeRef, principalRef: expected.principalRef, workspaceRef: expected.workspaceRef,
    targetRefs: mode === "denial" ? [] : expected.targetRefs, objectVersionRefs: mode === "denial" ? [] : expected.targetVersionRefs };
  if (predicateKind === "EXACT_TYPED_OBSERVATION") return observationValue(guardRef, expected, mode);
  if (predicateKind === "EXACT_VERSION_CONTINUITY") return { requestId: expected.requestId, requestFingerprint: expected.actionRequestFingerprint, priorObjectVersionRefs: expected.targetVersionRefs,
    observedObjectVersionRefs: mode === "denial" ? ["media.domain.artifact-version.conflicting-fixture-v2"] : expected.targetVersionRefs,
    draftRevision: mode === "denial" ? 4 : 3, expectedDraftRevision: expected.expectedDraftRevision ?? 3, continuationState: mode === "positive" ? "PERMITTED" : mode === "denial" ? "CONFLICT" : "UNKNOWN" };
  if (predicateKind === "EXPLICIT_CLOCK_INPUT") return { timebaseRef: expected.sourceClockRef, sourceVersionRef: expected.targetVersionRefs[0], userInputEventRef: "media.fixture.user-input.time-tick",
    ticks: mode === "positive" ? [0, 24, 48] : mode === "denial" ? [] : [24, 24], clockRate: 24, durationTicks: 240 };
  if (["stable-job-reference", "stable-job-identity-and-current-tenant-context", "resolve-the-exact-source-region-or-record-before-read-or-change", "exact-artifact-or-upload-identity"].includes(guardRef)) {
    return { resolution: mode === "denial" ? "EXACT_TARGET_ABSENT" : "EXACT_TARGET_RESOLVED",
      tenantScopeRef: mode === "unknown" ? "media.fixture.tenant.foreign" : expected.tenantScopeRef, principalRef: expected.principalRef, workspaceRef: expected.workspaceRef,
      targetRefs: mode === "denial" ? [] : expected.targetRefs, objectVersionRefs: mode === "denial" ? [] : expected.targetVersionRefs };
  }
  switch (guard.factFamily) {
    case "EXACT_ACTION_SPECIFIC_FACT":
      return { resolution: mode === "denial" ? "EXACT_TARGET_ABSENT" : "EXACT_TARGET_RESOLVED",
        tenantScopeRef: mode === "unknown" ? "media.fixture.tenant.foreign" : expected.tenantScopeRef, principalRef: expected.principalRef, workspaceRef: expected.workspaceRef,
        targetRefs: mode === "denial" ? [] : expected.targetRefs, objectVersionRefs: mode === "denial" ? [] : expected.targetVersionRefs };
    case "EXACT_SCOPED_TARGET": return { resolution: mode === "denial" ? "EXACT_TARGET_ABSENT" : "EXACT_TARGET_RESOLVED",
      tenantScopeRef: mode === "unknown" ? "media.fixture.tenant.foreign" : expected.tenantScopeRef, principalRef: expected.principalRef, workspaceRef: expected.workspaceRef,
      targetRefs: mode === "denial" ? [] : expected.targetRefs, objectVersionRefs: mode === "denial" ? [] : expected.targetVersionRefs };
    case "AUTHORITY_OR_ADMISSION": return { actorRef: expected.principalRef, operationRefs: expected.operationRefs, targetRefs: expected.targetRefs, purposeRef: expected.purposeRef,
      capabilityRef: expected.capabilityRef, delegationRef: expected.delegationRef, policyVersionRef: expected.policyVersionRef, authorityRef: expected.authorityRef,
      authorityVersionRef: expected.authorityVersionRef, decision: mode === "denial" ? "DENIED" : mode === "unknown" ? "UNKNOWN" : "GRANTED",
      validFrom: "2026-10-09T10:00:00.000Z", validUntil: "2026-10-09T13:00:00.000Z", admissionStatus: mode === "denial" ? "NOT_ADMITTED" : mode === "unknown" ? "NOT_EVALUATED" : "ADMITTED" };
    case "EXACT_REQUEST_VERSION_OR_CONTINUITY": return { requestId: expected.requestId, requestFingerprint: expected.actionRequestFingerprint, priorObjectVersionRefs: expected.targetVersionRefs,
      observedObjectVersionRefs: mode === "denial" ? ["media.domain.artifact-version.conflicting-fixture-v2"] : expected.targetVersionRefs,
      draftRevision: mode === "denial" ? 4 : 3, expectedDraftRevision: 3, continuationState: mode === "positive" ? "PERMITTED" : mode === "denial" ? "CONFLICT" : "UNKNOWN" };
    case "EXACT_SCOPED_READ_OR_SOURCE": return observationValue(guardRef, expected, mode);
    case "STREAM_RECOVERY_FENCE": {
      const base = { tenantScopeRef: expected.tenantScopeRef, sessionRef: expected.targetRefs[0], ownerPrincipalRef: expected.principalRef };
      if (guardRef === "media.guard.stream.reconnect.same-session-scope") return { stream: { ...base, ...(mode === "unknown" ? { tenantScopeRef: "media.fixture.tenant.foreign" } : {}) } };
      if (guardRef === "media.guard.stream.reconnect.degraded-session") return { stream: { ...base, sessionState: mode === "positive" ? "DEGRADED" : mode === "denial" ? "CONNECTED" : "UNKNOWN" } };
      if (guardRef === "media.guard.stream.reconnect.current-fence") return { stream: { ...base, lease: { ...base, fencingToken: expected.leaseFencingToken, disposition: mode === "positive" ? "CURRENT" : mode === "denial" ? "FENCED" : "UNKNOWN", leaseVersionRef: "media.fixture.lease.version-v1" } } };
      if (guardRef === "media.guard.stream.reconnect.prior-effects-resolved") return { stream: { ...base, unresolvedFrameEffects: mode === "unknown" ? [{ tenantScopeRef: base.tenantScopeRef, sessionRef: base.sessionRef, sequence: 2, effectDisposition: "UNKNOWN" }] : [{ tenantScopeRef: base.tenantScopeRef, sessionRef: base.sessionRef, sequence: 2, effectDisposition: "ACKNOWLEDGED" }] } };
      if (guardRef === "media.guard.stream.reconnect.budget-available") {
        const now = Date.parse(expected.now);
        return { stream: { ...base, recoveryBudget: { tenantScopeRef: expected.tenantScopeRef, sessionRef: expected.targetRefs[0], policyRef: expected.streamBudgetPolicyRef,
          disposition: mode === "unknown" ? "UNKNOWN" : mode === "denial" ? "EXHAUSTED" : "CURRENT", remainingReconnectRequests: mode === "denial" ? 0 : 1,
          deadlineEpochMilliseconds: mode === "denial" ? now - 1 : now + 5000, observedAtEpochMilliseconds: now - 1000 } } };
      }
      const last = 10;
      return { stream: { ...base, lastAcknowledgedFrameSequence: last, reconnectSequence: mode === "positive" ? last + 1 : mode === "denial" ? last + 2 : Number.MAX_SAFE_INTEGER + 1 } };
    }
    case "STREAM_LEASE_FENCE": return { stream: { tenantScopeRef: expected.tenantScopeRef, sessionRef: expected.targetRefs[0], ownerPrincipalRef: expected.principalRef,
      lease: { tenantScopeRef: expected.tenantScopeRef, sessionRef: expected.targetRefs[0], ownerPrincipalRef: expected.principalRef, fencingToken: expected.leaseFencingToken,
        disposition: mode === "positive" ? "CURRENT" : mode === "denial" ? "FENCED" : "UNKNOWN", leaseVersionRef: "media.fixture.lease.version-v1" } } };
    case "STREAM_PRIOR_EFFECTS": return { stream: { tenantScopeRef: expected.tenantScopeRef, sessionRef: expected.targetRefs[0], ownerPrincipalRef: expected.principalRef,
      unresolvedFrameEffects: mode === "unknown" ? [{ tenantScopeRef: expected.tenantScopeRef, sessionRef: expected.targetRefs[0], sequence: 2, effectDisposition: "UNKNOWN" }] : [{ tenantScopeRef: expected.tenantScopeRef, sessionRef: expected.targetRefs[0], sequence: 2, effectDisposition: "ACKNOWLEDGED" }] } };
    case "STREAM_RECOVERY_BUDGET": {
      const now = Date.parse(expected.now);
      return { stream: { tenantScopeRef: expected.tenantScopeRef, sessionRef: expected.targetRefs[0], ownerPrincipalRef: expected.principalRef,
        recoveryBudget: { tenantScopeRef: expected.tenantScopeRef, sessionRef: expected.targetRefs[0], policyRef: expected.streamBudgetPolicyRef, disposition: mode === "unknown" ? "UNKNOWN" : mode === "denial" ? "EXHAUSTED" : "CURRENT",
          remainingReconnectRequests: mode === "denial" ? 0 : 1, deadlineEpochMilliseconds: mode === "denial" ? now - 1 : now + 5000, observedAtEpochMilliseconds: now - 1000 } } };
    }
    case "STREAM_SEQUENCE": {
      const last = 10;
      return { stream: { tenantScopeRef: expected.tenantScopeRef, sessionRef: expected.targetRefs[0], ownerPrincipalRef: expected.principalRef,
        lastAcknowledgedFrameSequence: last, reconnectSequence: mode === "positive" ? last + 1 : mode === "denial" ? last + 2 : Number.MAX_SAFE_INTEGER + 1 } };
    }
    case "JOB_EFFECT_AND_RECOVERY": {
      const isUnknownGuard = guardRef === "existing-job-is-outcome-unknown";
      const isNotUnknownGuard = guardRef === "prior-outcome-is-not-unknown; check-the-existing-job-outcome-first";
      const canonicalUnknown = isUnknownGuard ? mode === "positive" : isNotUnknownGuard ? mode === "denial" : true;
      const jobState = canonicalUnknown ? "OUTCOME_UNKNOWN" : mode === "positive" ? "COMPLETED" : "FAILED";
      return { jobRef: expected.targetRefs[0], jobVersionRef: expected.jobVersionRef, tenantScopeRef: expected.tenantScopeRef, ownerPrincipalRef: expected.principalRef,
      jobCanonicalStateRef: canonicalUnknown ? ".product-experience/pdp-1-domain-data/states.yaml#stateMachines/media-job/stateDefinitions/OUTCOME_UNKNOWN" : "media.runtime-only.job-status.unmapped", jobState,
      attemptRef: expected.expectedAttemptRef, attemptVersionRef: "media.fixture.attempt-version.v1", attemptFencingToken: expected.expectedAttemptFencingToken,
      attemptDisposition: mode === "denial" ? "NON_RETRYABLE" : mode === "unknown" ? "UNKNOWN" : "RETRYABLE",
      effectDisposition: mode === "denial" ? "EFFECT_CONFIRMED" : mode === "unknown" ? "UNKNOWN" : "NO_EFFECT_CONFIRMED",
      retryBudgetRef: expected.expectedRetryBudgetRef, retryBudgetRemaining: mode === "denial" ? 0 : 1,
      stateAuthorityRef: ".product-experience/pdp-1-domain-data/transitions.yaml#ownerRaceResolutionContract" };
    }
    case "EXPLICIT_CLOCK_INPUT": return { timebaseRef: expected.sourceClockRef, sourceVersionRef: expected.targetVersionRefs[0], userInputEventRef: "media.fixture.user-input.time-tick",
      ticks: mode === "positive" ? [0, 24, 48] : mode === "denial" ? [] : [24, 24], clockRate: 24, durationTicks: 240 };
    default: return null;
  }
}
function expectedTruth(guardRef, mode) {
  if (mode === "foreign") return "UNKNOWN";
  if (guardRef === "retry-budget-remains-under-current-policy") return "UNKNOWN";
  if (authorityGuardRefs.has(guardRef) && mode === "positive") return "UNKNOWN";
  if (guardRef === "existing-stable-upload-identity") return mode === "positive" ? "TRUE" : mode === "denial" ? "FALSE" : "UNKNOWN";
  if (guardRef === "media.guard.stream.reconnect.same-session-scope" || guardRef === "media.guard.stream.reconnect.prior-effects-resolved") return mode === "unknown" ? "UNKNOWN" : "TRUE";
  if (guardRef === "prior-outcome-is-not-unknown; check-the-existing-job-outcome-first") return mode === "denial" ? "FALSE" : "UNKNOWN";
  if (guardRef === "existing-job-is-outcome-unknown") return mode === "positive" ? "TRUE" : "UNKNOWN";
  if (["media.guard.stream.reconnect.current-consent", "current-rights-and-consent", "rights-and-retention-rechecked"].includes(guardRef)) return mode === "positive" ? "TRUE" : mode === "denial" ? "FALSE" : "UNKNOWN";
  return mode === "positive" ? "TRUE" : mode === "denial" ? "FALSE" : "UNKNOWN";
}

function schemaExample(schema) {
  if (Object.hasOwn(schema, "const")) return structuredClone(schema.const);
  if (schema.enum) return schema.enum[0];
  if (schema.type === "object") return Object.fromEntries((schema.required ?? []).map((key) => [key, schemaExample(schema.properties[key])]));
  if (schema.type === "array") return Array.from({ length: schema.minItems ?? 0 }, () => schemaExample(schema.items));
  if (schema.type === "string") return schema.format === "date-time" ? NOW : "media.fixture.reference.v1";
  if (schema.type === "integer" || schema.type === "number") return schema.minimum ?? 1;
  return {};
}

function rightsEvidence(expected, mode, decisionKind) {
  const request = schemaExample(rightsContract.requestSchema);
  const version = expected.subjectArtifactVersionRef ?? expected.targetVersionRefs?.[0];
  assert.ok(typeof version === "string" && version.length > 0);
  Object.assign(request, { queryId: `media.fixture.rights-query.${decisionKind}`, subjectArtifactVersionRef: version,
    decisionKind, purposeRef: expected.purposeRef, useRef: "media.use.definition-fixture", regionRef: "media.region.definition-fixture",
    retentionPolicyRef: "media.retention.definition-fixture" });
  const readVersion = `media.fixture.rights-read.${decisionKind}.v1`;
  const trusted = { tenantScopeRef: expected.tenantScopeRef, principalRef: expected.principalRef,
    expectedOperationRef: rightsContract.operationRefs[0], expectedReadAuthorityRef: rightsContract.readAuthorityRefs[0], expectedReadVersion: readVersion };
  const result = schemaExample(rightsContract.resultSchema);
  const effectDisposition = mode === "positive" || mode === "foreign" ? "PERMITTED" : mode === "denial" ? (decisionKind === "CONSENT" ? "CONSENT_REQUIRED" : "DENIED") : "UNKNOWN";
  Object.assign(result, { tenantScopeRef: mode === "foreign" ? "media.fixture.tenant.foreign" : expected.tenantScopeRef, principalRef: expected.principalRef, queryId: request.queryId,
    operationRef: rightsContract.operationRefs[0], readAuthorityRef: rightsContract.readAuthorityRefs[0], currentness: "CURRENT",
    observedAt: "2026-10-09T11:59:30.000Z", readVersion, requestFingerprint: typedObservationRequestFingerprint(request, trusted),
    decisionKind, observationStatus: effectDisposition === "PERMITTED" ? "ALLOWED_FOR_DECLARED_SCOPE" : effectDisposition,
    decision: { tenantScopeRef: expected.tenantScopeRef, principalRef: expected.principalRef, subjectArtifactVersionRef: version,
      decisionKind, purposeRef: expected.purposeRef, useRef: request.useRef, regionRef: request.regionRef, retentionPolicyRef: request.retentionPolicyRef,
      authorityRef: "media.fixture.rights-authority.v1", authorityVersionRef: "media.fixture.rights-authority-version.v1", effectDisposition,
      validFrom: "2026-10-09T10:00:00.000Z", validUntil: "2026-10-09T13:00:00.000Z", evidenceRefs: ["media.fixture.rights-evidence.v1"] } });
  return { request, result, trusted };
}

function foreignValueFor(guardRef, expected) {
  const value = structuredClone(valueFor(guardRef, expected, "positive"));
  if (value?.stream) value.stream.tenantScopeRef = "media.fixture.tenant.foreign";
  else if (value?.resolution) value.tenantScopeRef = "media.fixture.tenant.foreign";
  else if (value?.actorRef) value.actorRef = "media.fixture.principal.foreign";
  else if (value?.priorObjectVersionRefs) value.priorObjectVersionRefs = ["media.domain.artifact-version@foreign-tenant-v1"];
  else if (value?.observationKind) value.subjectRefs[0] = "media.domain.artifact-version.foreign-tenant";
  else if (value?.jobRef) value.jobRef = "media.domain.processing-job.foreign-tenant";
  else if (value?.timebaseRef) value.sourceVersionRef = "media.domain.artifact-version@foreign-tenant-v1";
  return value;
}

const allInstances = guards.guardContracts.records.flatMap((guard) => guard.stepRefs.map((stepRef) => ({ guardRef: guard.guardRef, stepRef })));

test("254 step-guard instances have typed positive, denial, unknown and valid-foreign fixtures", () => {
  assert.equal(allInstances.length, 254);
  const outcomes = { TRUE: 0, FALSE: 0, UNKNOWN: 0 };
  const mismatches = [];
  const guardsWithCorpus = new Set();
  for (const { guardRef, stepRef } of allInstances) {
    const step = steps.get(stepRef);
    assert.ok(step, `step source resolves: ${stepRef}`);
    const family = guards.guardContracts.records.find((row) => row.guardRef === guardRef)?.factFamily;
    guardsWithCorpus.add(guardRef);
    for (const mode of ["positive", "denial", "unknown", "foreign"]) {
      const expected = makeContext(guardRef, step, mode);
      const value = mode === "foreign" ? foreignValueFor(guardRef, expected) : valueFor(guardRef, expected, mode);
      let actual;
      if (["media.guard.stream.reconnect.current-consent", "current-rights-and-consent", "rights-and-retention-rechecked"].includes(guardRef)) {
        const expectedRights = { tenantScopeRef: expected.tenantScopeRef, principalRef: expected.principalRef,
          subjectArtifactVersionRef: expected.targetVersionRefs[0], purposeRef: expected.purposeRef,
          useRef: "media.use.definition-fixture", regionRef: "media.region.definition-fixture", retentionPolicyRef: "media.retention.definition-fixture",
          now: NOW, maxAgeMs: 60_000 };
        const kinds = guardRef === "media.guard.stream.reconnect.current-consent" ? ["CONSENT"] : ["RIGHTS", "CONSENT"];
        const evidence = kinds.map((kind) => rightsEvidence(expectedRights, mode, kind));
        actual = evaluatePdp3RightsGuardFact({ guardRef, evidence, expected: expectedRights }).truth;
      } else if (value === null) actual = "UNKNOWN";
      else {
        const receipt = makeReceipt(guardRef, stepRef, expected, value);
        const evaluation = evaluatePdp3TypedGuardFact({ guardRef, stepRef, expected, receipt });
        actual = evaluation.truth;
        if (actual !== expectedTruth(guardRef, mode)) mismatches.push(`${JSON.stringify(evaluation)} ${guardRef} ${mode} at ${stepRef}`);
      }
      if (actual !== expectedTruth(guardRef, mode) && value === null) mismatches.push(`${actual} != ${expectedTruth(guardRef, mode)} ${guardRef} ${mode} at ${stepRef} (no executable typed evaluator)`);
      outcomes[actual] += 1;
    }
  }
  assert.equal(guardsWithCorpus.size, 57);
  assert.equal(mismatches.length, 0, JSON.stringify(mismatches.reduce((counts, entry) => {
    const key = entry.slice(0, entry.indexOf(" at .product-experience"));
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {}), null, 2));
  assert.equal(outcomes.TRUE + outcomes.FALSE + outcomes.UNKNOWN, 254 * 4);
});

test("retry budget and authoring validators reject exhausted, foreign, and malformed evidence", () => {
  const retryGuard = "retry-budget-remains-under-current-policy";
  const retryStepRef = [...steps.values()].find((step) => step.guardRefs?.includes(retryGuard))?.sourceRef ??
    [...steps.values()].find((step) => guards.guardContracts.records.find((row) => row.guardRef === retryGuard)?.stepRefs.includes(step.sourceRef))?.sourceRef;
  assert.ok(retryStepRef, "retry guard step resolves");
  const retryStep = steps.get(retryStepRef);
  const retryExpected = makeContext(retryGuard, retryStep);
  const evaluate = (guardRef, step, expected, value) => evaluatePdp3TypedGuardFact({
    guardRef, stepRef: step.sourceRef, expected, receipt: makeReceipt(guardRef, step.sourceRef, expected, value),
  });
  const retryValue = valueFor(retryGuard, retryExpected, "positive");
  const retryPositiveResult = evaluate(retryGuard, retryStep, retryExpected, retryValue);
  assert.equal(retryPositiveResult.truth, "UNKNOWN", retryPositiveResult.reason);
  assert.equal(evaluate(retryGuard, retryStep, retryExpected, { ...retryValue, heldUnits: 3 }).truth, "UNKNOWN");
  assert.equal(evaluate(retryGuard, retryStep, retryExpected, { ...retryValue, budgetRef: "media.fixture.retry-budget.foreign" }).truth, "UNKNOWN");
  assert.equal(evaluate(retryGuard, retryStep, retryExpected, { ...retryValue, requestedUnits: 2 }).truth, "UNKNOWN");
  assert.equal(evaluate(retryGuard, retryStep, retryExpected, { ...retryValue, unitRef: "media.retry-budget-unit.credits" }).truth, "UNKNOWN");
  assert.equal(evaluate(retryGuard, retryStep, retryExpected, { ...retryValue, policyCurrentness: "STALE" }).truth, "UNKNOWN");
  assert.equal(evaluate(retryGuard, retryStep, retryExpected, { ...retryValue, validUntil: "2026-10-09T11:59:59.000Z" }).truth, "UNKNOWN");
  assert.deepEqual(evaluatePdp3RetryBudgetCapacity({ limitUnits: 4, spentUnits: 1, heldUnits: 1, requestedUnits: 2, unitRef: "media.retry-budget-unit.attempt", expectedUnitRef: "media.retry-budget-unit.attempt" }), {
    disposition: "CAPACITY_AVAILABLE", reason: "REQUEST_FITS_CURRENT_FIXTURE_CAPACITY", remainingUnits: 2,
  });
  assert.equal(evaluatePdp3RetryBudgetCapacity({ limitUnits: 4, spentUnits: 1, heldUnits: 1, requestedUnits: 3, unitRef: "media.retry-budget-unit.attempt", expectedUnitRef: "media.retry-budget-unit.attempt" }).disposition, "CAPACITY_EXHAUSTED");
  assert.equal(evaluatePdp3RetryBudgetCapacity({ limitUnits: 4, spentUnits: 1, heldUnits: 1, requestedUnits: 1, unitRef: "media.retry-budget-unit.credits", expectedUnitRef: "media.retry-budget-unit.attempt" }).disposition, "UNKNOWN");

  const retryReadContract = operations.ownerTypedObservationContracts.records.find((row) => row.id === "media.observation-contract.retry-policy-current-read.v1");
  const retryBound = operations.capabilityOperationContracts.bounds.find((row) => row.capabilityRef === "media.job.retry");
  const retryProfile = operations.capabilityOperationContracts.families.find((row) => row.id === retryBound.profileRef);
  const retryRequest = { queryId: "media.fixture.retry-policy-query.v1", jobId: "media.fixture.job.retry.v1", priorAttemptId: "media.fixture.attempt.retry.v1" };
  const retryTrusted = {
    tenantScopeRef: "media.fixture.tenant.alpha", principalRef: "media.fixture.principal.editor",
    expectedOperationRef: "media.operation.action.inspect-job-retry-policy",
    expectedReadAuthorityRef: retryReadContract.readAuthorityRefs[0], expectedReadVersion: "media.fixture.retry-policy-read.v1",
  };
  const retryReadExpected = {
    actionRef: retryStep.canonicalBindings.actionRef,
    tenantScopeRef: retryTrusted.tenantScopeRef, principalRef: retryTrusted.principalRef,
    jobRef: retryRequest.jobId, jobVersionRef: "media.fixture.job-version.v1",
    priorAttemptRef: retryRequest.priorAttemptId, priorAttemptVersionRef: "media.fixture.attempt-version.v1",
    capabilityRef: "media.job.retry", profileRef: retryBound.profileRef, boundsRef: retryBound.id,
    policyVersionRef: "media.fixture.retry-policy.v1", expectedRequestedAttempts: 1,
  };
  const retryObservation = {
    kind: "OBSERVED_RETRY_POLICY_AND_ATTEMPT", jobId: retryRequest.jobId, priorAttemptId: retryRequest.priorAttemptId,
    jobVersionRef: retryReadExpected.jobVersionRef, attemptVersionRef: retryReadExpected.priorAttemptVersionRef,
    capabilityRef: retryReadExpected.capabilityRef, retryOperationRef: "media.operation-slice.retry-job",
    profileRef: retryReadExpected.profileRef, boundsRef: retryReadExpected.boundsRef, policyVersionRef: retryReadExpected.policyVersionRef,
    retryability: "NOT_RETRYABLE", outcomeClass: "TERMINAL", budgetUnit: "ADDITIONAL_ATTEMPTS_PER_LOGICAL_JOB",
    maximumExplicitRetries: retryBound.maximumExplicitRetries, retriesUsed: 0, retriesRemaining: 0,
  };
  const retryReadResult = {
    tenantScopeRef: retryTrusted.tenantScopeRef, principalRef: retryTrusted.principalRef, queryId: retryRequest.queryId,
    operationRef: retryTrusted.expectedOperationRef,
    requestFingerprint: typedObservationRequestFingerprint(retryRequest, retryTrusted),
    readAuthorityRef: retryTrusted.expectedReadAuthorityRef, currentness: "CURRENT", readVersion: retryTrusted.expectedReadVersion,
    observedAt: NOW, observation: retryObservation,
  };
  const retryActionExpected = makeContext(retryGuard, retryStep);
  const retryReadResultTruth = evaluatePdp3TypedGuardFact({
    guardRef: retryGuard, stepRef: retryStep.sourceRef, expected: retryActionExpected,
    receipt: makeReceipt(retryGuard, retryStep.sourceRef, retryActionExpected, retryValue),
    retryPolicyRead: { expected: retryReadExpected, request: retryRequest, result: retryReadResult, trusted: retryTrusted, now: NOW, maxAgeMs: 60_000 },
  });
  assert.equal(retryReadResultTruth.truth, "FALSE", retryReadResultTruth.reason);
  const staleRetryRead = structuredClone(retryReadResult);
  staleRetryRead.currentness = "STALE";
  assert.equal(evaluatePdp3TypedGuardFact({
    guardRef: retryGuard, stepRef: retryStep.sourceRef, expected: retryActionExpected,
    receipt: makeReceipt(retryGuard, retryStep.sourceRef, retryActionExpected, retryValue),
    retryPolicyRead: { expected: retryReadExpected, request: retryRequest, result: staleRetryRead, trusted: retryTrusted, now: NOW, maxAgeMs: 60_000 },
  }).truth, "UNKNOWN");
  const foreignRetryRead = structuredClone(retryReadResult);
  foreignRetryRead.observation.jobVersionRef = "media.fixture.job-version.foreign";
  assert.equal(evaluatePdp3TypedGuardFact({
    guardRef: retryGuard, stepRef: retryStep.sourceRef, expected: retryActionExpected,
    receipt: makeReceipt(retryGuard, retryStep.sourceRef, retryActionExpected, retryValue),
    retryPolicyRead: { expected: retryReadExpected, request: retryRequest, result: foreignRetryRead, trusted: retryTrusted, now: NOW, maxAgeMs: 60_000 },
  }).truth, "UNKNOWN");

  const projectGuard = "owner-approved-project-request-shape";
  const projectStep = [...steps.values()].find((step) => guards.guardContracts.records.find((row) => row.guardRef === projectGuard)?.stepRefs.includes(step.sourceRef));
  assert.ok(projectStep, "project request guard step resolves");
  const projectExpected = makeContext(projectGuard, projectStep);
  const projectPositive = observationValue(projectGuard, projectExpected, "positive");
  assert.equal(evaluate(projectGuard, projectStep, projectExpected, projectPositive).truth, "TRUE");
  const extraField = structuredClone(projectPositive);
  extraField.details.requestPayload.unreviewed = true;
  extraField.details.requestFingerprint = digest({ operationRef: "media.operation-slice.create-project", trusted: { tenantScopeRef: projectExpected.tenantScopeRef, principalRef: projectExpected.principalRef }, requestPayload: extraField.details.requestPayload });
  const extraExpected = { ...projectExpected, actionRequestFingerprint: extraField.details.requestFingerprint };
  const extraResult = evaluate(projectGuard, projectStep, extraExpected, extraField);
  assert.equal(extraResult.truth, "UNKNOWN", extraResult.reason);

  const captionGuard = "caption-draft-valid";
  const captionStep = [...steps.values()].find((step) => guards.guardContracts.records.find((row) => row.guardRef === captionGuard)?.stepRefs.includes(step.sourceRef));
  assert.ok(captionStep, "caption validity guard step resolves");
  const captionExpected = makeContext(captionGuard, captionStep);
  const captionPositive = observationValue(captionGuard, captionExpected, "positive");
  assert.equal(evaluate(captionGuard, captionStep, captionExpected, captionPositive).truth, "TRUE");
  const staleDraft = structuredClone(captionPositive);
  staleDraft.details.draftRevision += 1;
  assert.equal(evaluate(captionGuard, captionStep, captionExpected, staleDraft).truth, "UNKNOWN");
  const malformedCaption = structuredClone(captionPositive);
  malformedCaption.details.segments[0].timing.endTick = malformedCaption.details.segments[0].timing.sourceDurationTicks + 1;
  assert.equal(evaluate(captionGuard, captionStep, captionExpected, malformedCaption).truth, "FALSE");
  const wrongClock = structuredClone(captionPositive);
  wrongClock.details.segments[0].timing.sourceClockRef = "media.timebase.foreign.v1";
  assert.equal(evaluate(captionGuard, captionStep, captionExpected, wrongClock).truth, "FALSE");
  const foreignSource = structuredClone(captionPositive);
  foreignSource.details.parentSourceVersionRef = "media.domain.artifact-version.foreign-source@v1";
  assert.equal(evaluate(captionGuard, captionStep, captionExpected, foreignSource).truth, "UNKNOWN");
});

// Positive and denied rights/consent fixtures are exercised through the actual
// typed current-read evaluator in its focused suite. This corpus's empty rights
// evidence remains UNKNOWN and never substitutes a status label.
