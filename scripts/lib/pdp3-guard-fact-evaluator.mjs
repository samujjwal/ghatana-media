import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { validateTypedObservationCurrentRead, validateRetryPolicyCurrentRead } from "./pdp-truth-domain-observation-currentness.mjs";
import { createHash } from "node:crypto";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const yaml = require("yaml");
const Ajv2020 = require("ajv/dist/2020").default ?? require("ajv/dist/2020");
const addFormats = require("ajv-formats").default ?? require("ajv-formats");
const guardSource = yaml.parse(readFileSync(resolve(process.cwd(), ".product-experience/pdp-3-product-experience/step-guard-fact-contracts.yaml"), "utf8"));
const stepSource = yaml.parse(readFileSync(resolve(process.cwd(), ".product-experience/pdp-3-product-experience/step-definition-oracles.yaml"), "utf8"));
const specializedFactSource = yaml.parse(readFileSync(resolve(process.cwd(), ".product-experience/pdp-3-product-experience/step-guard-specialized-fact-contracts.yaml"), "utf8"));
const specializedFactByGuard = new Map(specializedFactSource.records.map((row) => [row.guardRef, row]));
let rightsContractCache;
let operationsSourceCache;
const getOperationsSource = () => {
  if (operationsSourceCache === undefined) operationsSourceCache = yaml.parse(readFileSync(resolve(process.cwd(), ".product-experience/pdp-1-domain-data/operations.yaml"), "utf8"));
  return operationsSourceCache;
};
const getRightsContract = () => {
  if (rightsContractCache === undefined) {
    const operations = getOperationsSource();
    rightsContractCache = operations.ownerTypedObservationContracts.records.find((row) => row.id === "media.observation-contract.rights-decision.v1") ?? null;
  }
  return rightsContractCache;
};
const getRetryPolicyReadContract = () => getOperationsSource().ownerTypedObservationContracts.records
  .find((row) => row.id === "media.observation-contract.retry-policy-current-read.v1") ?? null;
const createProjectRequestSchema = () => getOperationsSource().individualOperationContracts.records
  .find((row) => row.id === "media.operation-slice.create-project")?.ownerWireSchema?.requestSchema ?? null;
const rightsGuardRefs = new Set([
  "media.guard.stream.reconnect.current-consent",
  "current-rights-and-consent",
  "rights-and-retention-rechecked",
]);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
  Reflect.ownKeys(value).every((key) => typeof key === "string" && Object.getOwnPropertyDescriptor(value, key)?.enumerable);
const exact = (value, keys) => record(value) && Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const fail = (truth, reason) => ({ truth, reason, effect: "NONE", retryAuthorized: false, runtimeAdmission: "NOT_ADMITTED" });

// Guard facts are typed observations, never fixture-provided TRUE/FALSE values.
// The three broad rules below cover scope, authority/admission, and continuity.
// They intentionally require an out-of-band host context and an exact current
// source receipt; absent runtime adapters mean callers normally receive UNKNOWN.
const scopeGuardRefs = new Set([
  "resolve-the-current-workspace-and-exact-target-before-access-or-change",
  "resolve-the-exact-source-region-or-record-before-read-or-change",
  "exact-artifact-or-upload-identity", "authenticated-principal", "authorized-workspace",
  "project-is-visible-in-current-workspace", "stable-job-reference",
  "stable-job-identity-and-current-tenant-context", "current-principal-and-workspace",
  "current-tenant-and-owning-principal-scope",
]);
const authorityGuardRefs = new Set([
  "confirm-current-actor-authority-and-owner-approved-capability-before-governed-effects",
  "confirm-owner-approved-actor-and-capability-authority-before-governed-effects",
  "current-scoped-source-read-and-derived-edit-authority", "current-read-authority",
  "current-project-create-authority", "current-project-read-authority", "current-cancellation-authority",
  "current-actor-has-retry-authority-for-this-job",
  "rights-policy-license-resource-and-deployment-eligibility-are-rechecked-before-dispatch",
  "admitted-capability-and-policy", "current-scoped-read-authority",
  "current-scoped-derived-edit-authority", "current-commit-authority",
  "current-upload-and-import-authority", "rights-consent-retention-and-format-admission",
  "current-authority-and-retention-policy",
]);
const continuityGuardRefs = new Set([
  "preserve-the-requested-context-and-exact-version-across-recovery", "expected-session-draft-revision",
  "preserve-current-draft-and-prior-versions", "matching-source-metadata-and-immutable-request-binding",
  "observed-state-permits-continuation",
]);
const observationGuardRefs = new Set([
  "exact-source-and-typed-parent-readable", "source-available", "exact-canonical-transcript-version-readable",
  "exact-source-version-readable", "authoritative-exact-source-clock-rate-and-duration", "caption-draft-valid",
  "parent-source-current", "two-caption-versions-readable", "exact-source-selected",
  "existing-stable-upload-identity", "owner-approved-project-request-shape", "explicit-language-intent",
]);
const streamGuardRefs = new Set([
  "media.guard.stream.reconnect.same-session-scope", "media.guard.stream.reconnect.degraded-session",
  "media.guard.stream.reconnect.current-fence", "media.guard.stream.reconnect.prior-effects-resolved",
  "media.guard.stream.reconnect.budget-available", "media.guard.stream.reconnect.next-sequence-contiguous",
]);
const jobGuardRefs = new Set([
  "prior-attempt-is-classified-as-retryable-by-the-job-owner",
  "prior-outcome-is-not-unknown; check-the-existing-job-outcome-first",
  "existing-job-is-outcome-unknown",
]);
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const iso = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const expectedGuardExtras = (guardRef) => {
  if (guardRef === "retry-budget-remains-under-current-policy") return ["jobVersionRef", "expectedAttemptRef", "expectedAttemptFencingToken", "expectedRetryBudgetRef", "expectedRetryBudgetVersionRef", "expectedRetryBudgetUnitRef", "expectedRequestedRetryUnits", "expectedRetryPolicyRef", "expectedRetryPolicyVersionRef", "expectedRetryPolicyAuthorityRef", "expectedRetryPolicyAuthorityVersionRef"];
  if (guardRef === "owner-approved-project-request-shape") return ["requestSchemaRef", "requestSchemaVersionRef"];
  if (guardRef === "caption-draft-valid") return ["captionValidatorRef", "captionValidatorVersionRef", "expectedDraftRevision", "expectedSourceClockRef", "expectedTicksPerSecond", "expectedSourceDurationTicks"];
  if (continuityGuardRefs.has(guardRef)) return ["expectedDraftRevision"];
  if (guardRef === "exact-source-selected" || guardRef === "two-caption-versions-readable") return ["catalogSnapshotRef"];
  if (guardRef === "explicit-user-tick-values") return ["sourceClockRef", "expectedClockRate", "expectedDurationTicks"];
  if (guardRef === "authoritative-exact-source-clock-rate-and-duration") return ["sourceClockRef", "clockAuthorityRef", "expectedTimeUnitRef"];
  if (authorityGuardRefs.has(guardRef)) return ["capabilityRef", "delegationRef", "policyVersionRef", "authorityRef", "authorityVersionRef"];
  if (guardRef === "media.guard.stream.reconnect.current-fence") return ["leaseFencingToken"];
  if (guardRef === "media.guard.stream.reconnect.budget-available") return ["streamBudgetPolicyRef"];
  if (guardRef === "explicit-user-tick-values") return ["sourceClockRef", "expectedClockRate", "expectedDurationTicks"];
  if (guardRef === "authoritative-exact-source-clock-rate-and-duration") return ["sourceClockRef", "clockAuthorityRef", "expectedTimeUnitRef"];
  if (guardRef === "caption-draft-valid") return ["captionValidatorRef", "captionValidatorVersionRef", "expectedSourceDurationTicks", "expectedLanguageTag"];
  if (guardRef === "owner-approved-project-request-shape") return ["requestSchemaRef", "requestSchemaVersionRef"];
  if (guardRef === "explicit-language-intent") return ["expectedLanguageTag"];
  if (jobGuardRefs.has(guardRef)) return ["jobVersionRef", "expectedAttemptRef", "expectedAttemptFencingToken", "expectedRetryBudgetRef"];
  return [];
};
const schemaAjv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
addFormats(schemaAjv);
schemaAjv.addFormat("opaque-id", /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
schemaAjv.addFormat("opaque-idempotency-key", /^[A-Za-z0-9][A-Za-z0-9._~:-]*$/u);
const specializedReceiptSchema = (schema, factSchema, contract) => {
  if (!factSchema) return schema;
  const cloned = structuredClone(schema);
  cloned.properties.value = factSchema;
  for (const field of contract?.omitReceiptFields ?? []) delete cloned.properties[field];
  cloned.required = (cloned.required ?? []).filter((field) => !(contract?.omitReceiptFields ?? []).includes(field));
  return cloned;
};
const predicateSchemaValidators = new Map(guardSource.predicateDefinitions.map((predicate) => [predicate.guardRef, {
  fact: schemaAjv.compile(specializedFactByGuard.get(predicate.guardRef)?.factSchema ?? predicate.factSchema),
  receipt: schemaAjv.compile(specializedReceiptSchema(predicate.receiptSchema, specializedFactByGuard.get(predicate.guardRef)?.factSchema, specializedFactByGuard.get(predicate.guardRef))),
}]));
const guardDefinitionByRef = new Map(guardSource.guardContracts.records.map((row) => [row.guardRef, row]));
const predicateDefinitionByRef = new Map(guardSource.predicateDefinitions.map((row) => [row.guardRef, row]));
const stepBySourceRef = new Map(stepSource.journeys.flatMap((journey) => journey.steps.map((step) => [step.sourceRef, step])));

function validateGuardReadReceipt({ guardRef, stepRef, expected, receipt, now, maxAgeMs }) {
  const predicateDefinition = guardSource.predicateDefinitions.find((row) => row.guardRef === guardRef);
  const special = specializedFactByGuard.get(guardRef);
  const schema = predicateDefinition && specializedReceiptSchema(predicateDefinition.receiptSchema, special?.factSchema, special);
  const expectedKeys = Object.keys(schema?.properties ?? {}).filter((key) => !["stepRef", "guardRef", "queryId", "requestFingerprint", "currentness", "observedAt", "value"].includes(key));
  const expectedOnlyKeys = [...new Set([...expectedKeys, ...expectedGuardExtras(guardRef)])];
  const receiptKeys = Object.keys(schema?.properties ?? {});
  if (!exact(expected, [...expectedOnlyKeys, "now", "maxAgeMs"]) || !exact(receipt, receiptKeys) || !nonempty(stepRef) ||
      !["tenantScopeRef", "principalRef", "workspaceRef", "actionRef", "sourceRef", "readAuthorityRef", "readVersion", "requestId", "actionRequestFingerprint"].every((key) => nonempty(expected[key])) ||
      !["purposeRef", "capabilityRef", "delegationRef", "policyVersionRef", "authorityRef", "authorityVersionRef", "leaseFencingToken", "expectedAttemptRef", "expectedRetryBudgetRef", "expectedRetryBudgetVersionRef", "expectedRetryBudgetUnitRef", "expectedRetryPolicyRef", "expectedRetryPolicyVersionRef", "expectedRetryPolicyAuthorityRef", "expectedRetryPolicyAuthorityVersionRef", "sourceClockRef", "clockAuthorityRef", "jobVersionRef", "captionValidatorRef", "captionValidatorVersionRef", "expectedSourceClockRef", "requestSchemaRef", "requestSchemaVersionRef", "expectedLanguageTag", "catalogSnapshotRef", "streamBudgetPolicyRef", "expectedTimeUnitRef"].every((key) => expected[key] == null || nonempty(expected[key])) ||
      (expected.expectedRequestedRetryUnits !== undefined && (!Number.isSafeInteger(expected.expectedRequestedRetryUnits) || expected.expectedRequestedRetryUnits < 1)) ||
      (expected.expectedDraftRevision !== undefined && (!Number.isSafeInteger(expected.expectedDraftRevision) || expected.expectedDraftRevision < 0)) ||
      (expected.expectedClockRate !== undefined && (!Number.isSafeInteger(expected.expectedClockRate) || expected.expectedClockRate <= 0)) ||
      (expected.expectedDurationTicks !== undefined && (!Number.isSafeInteger(expected.expectedDurationTicks) || expected.expectedDurationTicks < 0)) ||
      (expected.expectedSourceDurationTicks !== undefined && (!Number.isSafeInteger(expected.expectedSourceDurationTicks) || expected.expectedSourceDurationTicks < 0)) ||
      (expected.expectedTicksPerSecond !== undefined && (!Number.isSafeInteger(expected.expectedTicksPerSecond) || expected.expectedTicksPerSecond <= 0)) ||
      !/^[a-f0-9]{64}$/u.test(expected.actionRequestFingerprint) || (expected.expectedAttemptFencingToken !== undefined && (!Number.isSafeInteger(expected.expectedAttemptFencingToken) || expected.expectedAttemptFencingToken < 0)) ||
      !Array.isArray(expected.operationRefs) || expected.operationRefs.some((v) => !nonempty(v)) ||
      !Array.isArray(expected.targetRefs) || expected.targetRefs.some((v) => !nonempty(v)) ||
      !Array.isArray(expected.targetVersionRefs) || expected.targetVersionRefs.some((v) => !nonempty(v)) ||
      !iso(expected.now) || !Number.isSafeInteger(expected.maxAgeMs) || expected.maxAgeMs < 0) return fail("UNKNOWN", "TRUSTED_GUARD_CONTEXT_INVALID");
  if (receipt.stepRef !== stepRef || receipt.guardRef !== guardRef || !nonempty(receipt.queryId) || !/^[a-f0-9]{64}$/u.test(receipt.requestFingerprint) ||
      !iso(receipt.observedAt) || !record(receipt.value)) return fail("UNKNOWN", "TYPED_GUARD_READ_RECEIPT_MALFORMED");
  const tuple = (x) => expectedKeys.map((key) => x[key]);
  if (!same(tuple(expected), tuple(receipt))) return fail("UNKNOWN", "GUARD_READ_CONTEXT_OR_VERSION_MISMATCH");
  if (receipt.currentness !== "CURRENT" || Date.parse(receipt.observedAt) > Date.parse(expected.now) || Date.parse(expected.now) - Date.parse(receipt.observedAt) > expected.maxAgeMs) return fail("UNKNOWN", "GUARD_READ_NOT_CURRENT");
  const fingerprintInput = { stepRef, guardRef, ...Object.fromEntries([...expectedKeys, ...expectedGuardExtras(guardRef)].map((key) => [key, expected[key]])), queryId: receipt.queryId };
  if (receipt.requestFingerprint !== hash(fingerprintInput)) return fail("UNKNOWN", "GUARD_READ_FINGERPRINT_MISMATCH");
  return { truth: "TRUE", reason: "EXACT_SCOPED_GUARD_RECEIPT_CURRENT" };
}

function evaluateScopePredicate(guardRef, value, expected) {
  if (!scopeGuardRefs.has(guardRef)) return null;
  if (!exact(value, ["resolution", "tenantScopeRef", "principalRef", "workspaceRef", "targetRefs", "objectVersionRefs"]) ||
      !["EXACT_TARGET_RESOLVED", "EXACT_TARGET_ABSENT"].includes(value.resolution) ||
      ![value.tenantScopeRef, value.principalRef, value.workspaceRef].every(nonempty) || !Array.isArray(value.targetRefs) || !Array.isArray(value.objectVersionRefs)) return fail("UNKNOWN", "SCOPE_FACT_SHAPE_INVALID");
  if (value.tenantScopeRef !== expected.tenantScopeRef || value.principalRef !== expected.principalRef || value.workspaceRef !== expected.workspaceRef) return fail("UNKNOWN", "SCOPE_FACT_FOREIGN_CONTEXT");
  if (value.resolution === "EXACT_TARGET_ABSENT") return value.targetRefs.length === 0 && value.objectVersionRefs.length === 0 ? fail("FALSE", "CURRENT_SCOPED_QUERY_CONFIRMS_EXACT_TARGET_ABSENT") : fail("UNKNOWN", "ABSENCE_RESULT_CONTAINS_TARGET_IDENTITIES");
  if (!same(value.targetRefs, expected.targetRefs) || !same(value.objectVersionRefs, expected.targetVersionRefs)) return fail("UNKNOWN", "SCOPE_FACT_TARGET_TUPLE_MISMATCH");
  return fail("TRUE", "EXACT_TARGET_RESOLVED_IN_TRUSTED_SCOPE");
}

function evaluateAuthorityPredicate(guardRef, value, expected) {
  if (!authorityGuardRefs.has(guardRef)) return null;
  if (!exact(value, ["actorRef", "operationRefs", "targetRefs", "purposeRef", "capabilityRef", "delegationRef", "policyVersionRef", "authorityRef", "authorityVersionRef", "decision", "validFrom", "validUntil", "admissionStatus"]) ||
      !["GRANTED", "DENIED", "EXPIRED", "NOT_ADMITTED", "UNKNOWN"].includes(value.decision) || !["ADMITTED", "NOT_ADMITTED", "NOT_EVALUATED"].includes(value.admissionStatus) ||
      ![value.actorRef, value.capabilityRef, value.delegationRef, value.policyVersionRef, value.authorityRef, value.authorityVersionRef].every(nonempty) ||
      !Array.isArray(value.operationRefs) || !Array.isArray(value.targetRefs) || !iso(value.validFrom) || !iso(value.validUntil)) return fail("UNKNOWN", "AUTHORITY_FACT_SHAPE_INVALID");
  if (value.actorRef !== expected.principalRef || !same(value.operationRefs, expected.operationRefs) || !same(value.targetRefs, expected.targetRefs) || value.purposeRef !== expected.purposeRef ||
      value.capabilityRef !== expected.capabilityRef || value.delegationRef !== expected.delegationRef || value.authorityRef !== expected.authorityRef || value.authorityVersionRef !== expected.authorityVersionRef || value.policyVersionRef !== expected.policyVersionRef) return fail("UNKNOWN", "AUTHORITY_FACT_SCOPE_MISMATCH");
  if (Date.parse(value.validFrom) > Date.parse(expected.now) || Date.parse(expected.now) >= Date.parse(value.validUntil)) return fail("UNKNOWN", "AUTHORITY_FACT_OUTSIDE_VALIDITY");
  if (value.decision === "UNKNOWN" || value.admissionStatus === "NOT_EVALUATED") return fail("UNKNOWN", "AUTHORITY_OR_ADMISSION_NOT_EVALUATED");
  if (value.decision !== "GRANTED" || value.admissionStatus !== "ADMITTED") return fail("FALSE", "CURRENT_AUTHORITY_OR_ADMISSION_DENIED");
  return fail("TRUE", "CURRENT_EXACT_ACTOR_OPERATION_TARGET_AUTHORITY_AND_ADMISSION_MATCH");
}

function evaluateRetryBudgetPredicate(guardRef, value, expected) {
  if (guardRef !== "retry-budget-remains-under-current-policy") return null;
  if (!exact(value, ["tenantScopeRef", "principalRef", "jobRef", "jobVersionRef", "attemptRef", "attemptFencingToken", "budgetRef", "budgetVersionRef", "unitRef", "policyRef", "policyVersionRef", "policyAuthorityRef", "policyAuthorityVersionRef", "policyCurrentness", "policyDisposition", "limitUnits", "spentUnits", "heldUnits", "requestedUnits", "observedAt", "validFrom", "validUntil", "evidenceRef"]) ||
      !["tenantScopeRef", "principalRef", "jobRef", "jobVersionRef", "attemptRef", "budgetRef", "budgetVersionRef", "policyRef", "policyVersionRef", "policyAuthorityRef", "policyAuthorityVersionRef", "evidenceRef"].every((key) => nonempty(value[key])) ||
      ![value.limitUnits, value.spentUnits, value.heldUnits, value.requestedUnits, value.attemptFencingToken].every(Number.isSafeInteger) ||
      [value.limitUnits, value.spentUnits, value.heldUnits, value.attemptFencingToken].some((n) => n < 0) || value.requestedUnits < 1 ||
      !["RETRY_ALLOWED", "RETRY_DENIED", "UNKNOWN"].includes(value.policyDisposition) || !["CURRENT", "STALE", "UNKNOWN"].includes(value.policyCurrentness) || !iso(value.observedAt) || !iso(value.validUntil)) return fail("UNKNOWN", "RETRY_BUDGET_FACT_INVALID");
  if (value.tenantScopeRef !== expected.tenantScopeRef || value.principalRef !== expected.principalRef || value.jobRef !== expected.targetRefs[0] ||
      value.jobVersionRef !== expected.jobVersionRef || value.attemptRef !== expected.expectedAttemptRef || value.attemptFencingToken !== expected.expectedAttemptFencingToken ||
      value.budgetRef !== expected.expectedRetryBudgetRef || value.budgetVersionRef !== expected.expectedRetryBudgetVersionRef || value.unitRef !== expected.expectedRetryBudgetUnitRef ||
      value.requestedUnits !== expected.expectedRequestedRetryUnits || value.policyRef !== expected.expectedRetryPolicyRef || value.policyVersionRef !== expected.expectedRetryPolicyVersionRef ||
      value.policyAuthorityRef !== expected.expectedRetryPolicyAuthorityRef || value.policyAuthorityVersionRef !== expected.expectedRetryPolicyAuthorityVersionRef) return fail("UNKNOWN", "RETRY_BUDGET_POLICY_OR_JOB_TUPLE_MISMATCH");
  const now = Date.parse(expected.now);
  if (value.policyCurrentness !== "CURRENT" || Date.parse(value.validFrom) > now || now >= Date.parse(value.validUntil) ||
      Date.parse(value.observedAt) > now || now - Date.parse(value.observedAt) > expected.maxAgeMs) return fail("UNKNOWN", "RETRY_BUDGET_NOT_CURRENT");
  // This legacy generic receipt is not the P1 retry-policy query. Keep the
  // arithmetic fact shape checked for migration compatibility, but never treat
  // it as an authoritative current budget read.
  return fail("UNKNOWN", "EXACT_P1_RETRY_POLICY_QUERY_REQUIRED");
}

/** Pure arithmetic oracle; it does not establish that the budget facts are current or authoritative. */
export function evaluatePdp3RetryBudgetCapacity({ limitUnits, spentUnits, heldUnits, requestedUnits, unitRef, expectedUnitRef }) {
  if (![limitUnits, spentUnits, heldUnits, requestedUnits].every(Number.isSafeInteger) ||
      limitUnits < 0 || spentUnits < 0 || heldUnits < 0 || requestedUnits < 1 ||
      !nonempty(unitRef) || unitRef !== expectedUnitRef) {
    return { disposition: "UNKNOWN", reason: "RETRY_BUDGET_ARITHMETIC_INPUT_INVALID_OR_UNIT_MISMATCH", remainingUnits: null };
  }
  const committedAndHeld = spentUnits + heldUnits;
  if (!Number.isSafeInteger(committedAndHeld)) {
    return { disposition: "UNKNOWN", reason: "RETRY_BUDGET_ARITHMETIC_OVERFLOW", remainingUnits: null };
  }
  const remainingUnits = limitUnits - committedAndHeld;
  if (remainingUnits < 0) return { disposition: "UNKNOWN", reason: "RETRY_BUDGET_ACCOUNTING_INCONSISTENT", remainingUnits };
  return {
    disposition: requestedUnits <= remainingUnits ? "CAPACITY_AVAILABLE" : "CAPACITY_EXHAUSTED",
    reason: requestedUnits <= remainingUnits ? "REQUEST_FITS_CURRENT_FIXTURE_CAPACITY" : "REQUEST_EXCEEDS_FIXTURE_CAPACITY",
    remainingUnits,
  };
}

/** Validate the exact owner-defined P1 retry-policy observation for one retry step. */
export function evaluatePdp3RetryPolicyRead({ stepRef, expected, request, result, trusted, now, maxAgeMs }) {
  const guardRef = "retry-budget-remains-under-current-policy";
  const step = stepBySourceRef.get(stepRef);
  const binding = step?.canonicalBindings;
  if (!step || !guardDefinitionByRef.get(guardRef)?.stepRefs.includes(stepRef) ||
      binding?.actionRef !== expected?.actionRef || !binding?.operationRefs?.includes("media.operation-slice.retry-job")) {
    return fail("UNKNOWN", "RETRY_POLICY_QUERY_NOT_BOUND_TO_EXACT_RETRY_STEP");
  }
  const stringFields = ["actionRef", "tenantScopeRef", "principalRef", "jobRef", "jobVersionRef", "priorAttemptRef", "priorAttemptVersionRef", "capabilityRef", "profileRef", "boundsRef", "policyVersionRef"];
  const fields = [...stringFields, "expectedRequestedAttempts"];
  if (!exact(expected, fields) || stringFields.some((key) => !nonempty(expected[key])) ||
      expected.capabilityRef !== "media.job.retry" || expected.expectedRequestedAttempts !== 1 ||
      !iso(now) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0 ||
      !exact(request, ["queryId", "jobId", "priorAttemptId"]) ||
      request.jobId !== expected.jobRef || request.priorAttemptId !== expected.priorAttemptRef) {
    return fail("UNKNOWN", "RETRY_POLICY_QUERY_EXPECTED_TUPLE_INVALID");
  }
  const contract = getRetryPolicyReadContract();
  if (!contract) return fail("UNKNOWN", "P1_RETRY_POLICY_QUERY_CONTRACT_NOT_RESOLVED");
  const current = validateRetryPolicyCurrentRead({ contract, request, result, trusted, now, maxAgeMs });
  if (current.truth !== "TRUE") return fail("UNKNOWN", current.reason);
  const observation = result.observation;
  if (observation.kind !== "OBSERVED_RETRY_POLICY_AND_ATTEMPT") return fail("UNKNOWN", "RETRY_POLICY_OBSERVATION_UNKNOWN");
  if (observation.jobId !== expected.jobRef || observation.priorAttemptId !== expected.priorAttemptRef ||
      observation.jobVersionRef !== expected.jobVersionRef || observation.attemptVersionRef !== expected.priorAttemptVersionRef ||
      observation.capabilityRef !== expected.capabilityRef || observation.profileRef !== expected.profileRef ||
      observation.boundsRef !== expected.boundsRef || observation.policyVersionRef !== expected.policyVersionRef ||
      observation.retryOperationRef !== "media.operation-slice.retry-job") {
    return fail("UNKNOWN", "RETRY_POLICY_OBSERVATION_FOREIGN_OR_WRONG_VERSION");
  }
  if (observation.retryability === "UNKNOWN" || ["EFFECT_UNKNOWN", "UNKNOWN"].includes(observation.outcomeClass)) {
    return fail("UNKNOWN", "PRIOR_ATTEMPT_OUTCOME_OR_RETRYABILITY_UNRESOLVED");
  }
  if (observation.retryability !== "RETRYABLE" || observation.retriesRemaining < expected.expectedRequestedAttempts) {
    return fail("FALSE", "CURRENT_OWNER_READ_DOES_NOT_ALLOW_AN_ADDITIONAL_RETRY");
  }
  if (!["DEFINITIVE_NO_EFFECT", "DEFINITIVE_RETRYABLE_FAILURE"].includes(observation.outcomeClass)) {
    return fail("UNKNOWN", "PRIOR_EFFECT_IS_NOT_DEFINITIVELY_RETRYABLE");
  }
  return fail("TRUE", "CURRENT_OWNER_RETRY_POLICY_READ_ALLOWS_ONE_REQUEST_ONLY");
}

function evaluateContinuityPredicate(guardRef, value, expected) {
  if (!continuityGuardRefs.has(guardRef)) return null;
  if (!exact(value, ["requestId", "requestFingerprint", "priorObjectVersionRefs", "observedObjectVersionRefs", "draftRevision", "expectedDraftRevision", "continuationState"]) ||
      !nonempty(value.requestId) || !/^[a-f0-9]{64}$/u.test(value.requestFingerprint) || !Array.isArray(value.priorObjectVersionRefs) || !Array.isArray(value.observedObjectVersionRefs) ||
      !Number.isSafeInteger(value.draftRevision) || value.draftRevision < 0 || !Number.isSafeInteger(value.expectedDraftRevision) || value.expectedDraftRevision < 0 ||
      !["PERMITTED", "CONFLICT", "UNKNOWN"].includes(value.continuationState)) return fail("UNKNOWN", "CONTINUITY_FACT_SHAPE_INVALID");
  if (!same(value.priorObjectVersionRefs, expected.targetVersionRefs)) return fail("UNKNOWN", "CONTINUITY_REQUEST_TARGET_MISMATCH");
  if (value.continuationState === "UNKNOWN") return fail("UNKNOWN", "CONTINUATION_STATE_UNKNOWN");
  if (value.requestId !== expected.requestId || value.requestFingerprint !== expected.actionRequestFingerprint) return fail("UNKNOWN", "CONTINUITY_REQUEST_ID_OR_FINGERPRINT_MISMATCH");
  if (value.expectedDraftRevision !== expected.expectedDraftRevision) return fail("UNKNOWN", "TRUSTED_EXPECTED_DRAFT_REVISION_NOT_BOUND");
  if (value.continuationState === "CONFLICT" || !same(value.priorObjectVersionRefs, value.observedObjectVersionRefs) || value.draftRevision !== value.expectedDraftRevision) return fail("FALSE", "CURRENT_REVISION_OR_VERSION_CONFLICT");
  return fail("TRUE", "EXACT_REQUEST_AND_VERSION_CONTINUITY_MATCH");
}

function evaluateObservationPredicate(guardRef, value, expected) {
  if (!observationGuardRefs.has(guardRef)) return null;
  if (!exact(value, ["observationKind", "subjectRefs", "versionRefs", "purposeRef", "observationStatus", "evidenceRefs", "details"]) ||
      !nonempty(value.observationKind) || !Array.isArray(value.subjectRefs) || !Array.isArray(value.versionRefs) ||
      !["OBSERVED", "ABSENT", "UNKNOWN", "INVALID"].includes(value.observationStatus) || !Array.isArray(value.evidenceRefs) || !record(value.details)) return fail("UNKNOWN", "OBSERVATION_FACT_SHAPE_INVALID");
  if (!same(value.subjectRefs, expected.targetRefs) || !same(value.versionRefs, expected.targetVersionRefs) || value.purposeRef !== expected.purposeRef || value.versionRefs.length === 0) return fail("UNKNOWN", "OBSERVATION_SUBJECT_PURPOSE_VERSION_OR_EVIDENCE_MISMATCH");
  if (value.observationStatus === "UNKNOWN" || value.observationStatus === "INVALID") return fail("UNKNOWN", "OBSERVATION_UNSUPPORTED_OR_INVALID");
  if (value.observationStatus === "ABSENT") return fail("FALSE", "CURRENT_TYPED_OBSERVATION_CONFIRMS_REQUIRED_FACT_ABSENT");
  if (value.evidenceRefs.length === 0) return fail("UNKNOWN", "OBSERVATION_EVIDENCE_MISSING");
  const d = value.details;
  if (guardRef === "existing-stable-upload-identity") {
    if (!exact(d, ["uploadSessionRef", "artifactRef", "artifactVersionRef", "requestId", "requestFingerprint", "identityDisposition"]) ||
        ![d.uploadSessionRef, d.artifactRef, d.artifactVersionRef, d.requestId].every(nonempty) || !/^[a-f0-9]{64}$/u.test(d.requestFingerprint) ||
        !["STABLE", "CONFLICT", "UNKNOWN"].includes(d.identityDisposition)) return fail("UNKNOWN", "UPLOAD_IDENTITY_FACT_INVALID");
    if (!value.subjectRefs.includes(d.uploadSessionRef) || !value.subjectRefs.includes(d.artifactRef) || !value.versionRefs.includes(d.artifactVersionRef) ||
        d.requestId !== expected.requestId || d.requestFingerprint !== expected.actionRequestFingerprint) return fail("UNKNOWN", "UPLOAD_IDENTITY_REQUEST_OR_OBJECT_TUPLE_MISMATCH");
    return d.identityDisposition === "STABLE" ? fail("TRUE", "EXACT_UPLOAD_SESSION_ARTIFACT_VERSION_AND_REQUEST_IDENTITY_MATCH") :
      d.identityDisposition === "CONFLICT" ? fail("FALSE", "UPLOAD_IDENTITY_CONFLICT_CONFIRMED") : fail("UNKNOWN", "UPLOAD_IDENTITY_CURRENTNESS_UNKNOWN");
  }
  if (guardRef === "exact-source-and-typed-parent-readable") {
    if (!exact(d, ["sourceVersionRef", "parentObjectRefs", "parentVersionRefs", "readability", "mediaType"]) || !Array.isArray(d.parentObjectRefs) || !Array.isArray(d.parentVersionRefs) || d.parentObjectRefs.length !== d.parentVersionRefs.length || !["READABLE", "NOT_READABLE", "UNKNOWN"].includes(d.readability) || !nonempty(d.mediaType)) return fail("UNKNOWN", "SOURCE_OR_PARENT_READ_FACT_INVALID");
    if (d.readability === "UNKNOWN") return fail("UNKNOWN", "SOURCE_OR_PARENT_READABILITY_UNKNOWN");
    if (d.readability === "NOT_READABLE") return fail("FALSE", "SOURCE_OR_PARENT_NOT_READABLE");
    return same([d.sourceVersionRef, ...d.parentVersionRefs], value.versionRefs) && same(d.parentObjectRefs, value.subjectRefs.slice(1)) ? fail("TRUE", "EXACT_SOURCE_AND_TYPED_PARENTS_READABLE") : fail("UNKNOWN", "SOURCE_PARENT_VERSION_BINDING_MISMATCH");
  }
  if (guardRef === "source-available" || guardRef === "exact-source-version-readable" || guardRef === "exact-canonical-transcript-version-readable") {
    if (!exact(d, ["availability", "readDisposition", "artifactVersionRef", "canonicalObjectRef"]) || !["AVAILABLE", "UNAVAILABLE", "UNKNOWN"].includes(d.availability) || !["READABLE", "NOT_READABLE", "UNKNOWN"].includes(d.readDisposition) || !nonempty(d.artifactVersionRef) || !nonempty(d.canonicalObjectRef)) return fail("UNKNOWN", "SOURCE_AVAILABILITY_FACT_INVALID");
    if (!value.versionRefs.includes(d.artifactVersionRef) || d.canonicalObjectRef !== expected.targetRefs[0]) return fail("UNKNOWN", "SOURCE_VERSION_OR_OBJECT_NOT_IN_OBSERVATION_TUPLE");
    if (d.availability === "UNAVAILABLE" || d.readDisposition === "NOT_READABLE") return fail("FALSE", "EXACT_SOURCE_VERSION_NOT_AVAILABLE_OR_READABLE");
    return d.availability === "AVAILABLE" && d.readDisposition === "READABLE" ? fail("TRUE", "EXACT_SOURCE_VERSION_AVAILABLE_AND_READABLE") : fail("UNKNOWN", "SOURCE_AVAILABILITY_UNKNOWN");
  }
  if (guardRef === "authoritative-exact-source-clock-rate-and-duration") {
    if (!exact(d, ["clockRef", "sourceVersionRef", "clockAuthorityRef", "rateNumerator", "rateDenominator", "durationTicks", "timeUnitRef"]) || !["clockRef", "sourceVersionRef", "clockAuthorityRef", "timeUnitRef"].every((k) => nonempty(d[k])) || !Number.isSafeInteger(d.rateNumerator) || d.rateNumerator <= 0 || !Number.isSafeInteger(d.rateDenominator) || d.rateDenominator <= 0 || !Number.isSafeInteger(d.durationTicks) || d.durationTicks < 0) return fail("UNKNOWN", "SOURCE_CLOCK_FACT_INVALID");
    return expected.targetVersionRefs.includes(d.sourceVersionRef) && value.versionRefs.includes(d.sourceVersionRef) && d.clockRef === expected.sourceClockRef && d.clockAuthorityRef === expected.clockAuthorityRef && d.timeUnitRef === expected.expectedTimeUnitRef ? fail("TRUE", "EXACT_SOURCE_CLOCK_RATE_DURATION_AND_UNIT_BOUND") : fail("UNKNOWN", "SOURCE_CLOCK_VERSION_AUTHORITY_OR_UNIT_MISMATCH");
  }
  if (guardRef === "caption-draft-valid") {
    if (!exact(d, ["validatorRef", "validatorVersionRef", "draftRef", "draftRevision", "sourceVersionRef", "parentVersionRef", "timingAvailability", "segments"]) ||
        !nonempty(d.draftRef) || !Number.isSafeInteger(d.draftRevision) || d.draftRevision < 0 || !Array.isArray(d.segments) || d.segments.length === 0 ||
        !["NOT_SUPPLIED", "PROVIDER_TIME_UNQUALIFIED", "SOURCE_CLOCK_BOUND", "MIXED"].includes(d.timingAvailability)) return fail("UNKNOWN", "CAPTION_DRAFT_VALIDATION_INPUT_INVALID");
    const contract = specializedFactByGuard.get(guardRef);
    if (d.validatorRef !== expected.captionValidatorRef || d.validatorVersionRef !== expected.captionValidatorVersionRef ||
        d.validatorRef !== "media.caption.timeline-validator" || d.validatorVersionRef !== "media.caption.timeline-validator.v1") return fail("UNKNOWN", "CAPTION_VALIDATOR_IDENTITY_NOT_PINNED");
    if (d.draftRevision !== expected.expectedDraftRevision || d.sourceVersionRef !== value.versionRefs[0] || d.parentVersionRef !== value.versionRefs[1] ||
        !value.versionRefs.includes(d.sourceVersionRef) || !value.versionRefs.includes(d.parentVersionRef)) return fail("UNKNOWN", "CAPTION_DRAFT_REVISION_OR_PARENT_BINDING_MISMATCH");
    const segmentIds = new Set();
    let priorOrder = -1;
    const timingKinds = [];
    let commonSourceClock = null;
    for (const segment of d.segments) {
      if (!record(segment)) return fail("FALSE", "CAPTION_SEGMENT_ID_ORDER_OR_PRESERVED_FIELDS_INVALID");
      const requiredSegmentKeys = ["segmentId", "segmentOrder", "text", "origin", "languageDisposition", "timing"];
      const allowedSegmentKeys = new Set([...requiredSegmentKeys, "languageTag", "uncertaintyObservations", "evidenceRefs"]);
      const optionalFieldsValid = (!Object.hasOwn(segment, "languageTag") || segment.languageTag === null || typeof segment.languageTag === "string") &&
        (!Object.hasOwn(segment, "uncertaintyObservations") || (Array.isArray(segment.uncertaintyObservations) && segment.uncertaintyObservations.every(nonempty))) &&
        (!Object.hasOwn(segment, "evidenceRefs") || (Array.isArray(segment.evidenceRefs) && segment.evidenceRefs.every(nonempty)));
      if (requiredSegmentKeys.some((key) => !Object.hasOwn(segment, key)) || Object.keys(segment).some((key) => !allowedSegmentKeys.has(key)) ||
          !nonempty(segment.segmentId) || segmentIds.has(segment.segmentId) || !Number.isSafeInteger(segment.segmentOrder) || segment.segmentOrder <= priorOrder ||
          typeof segment.text !== "string" || !segment.text.trim() || !["RECOGNIZED", "USER_EDITED"].includes(segment.origin) ||
          !["NOT_SELECTED", "DECLARED_BY_USER", "UNCERTAIN"].includes(segment.languageDisposition) ||
          !optionalFieldsValid || !record(segment.timing)) return fail("FALSE", "CAPTION_SEGMENT_ID_ORDER_OR_PRESERVED_FIELDS_INVALID");
      if (segment.languageDisposition === "DECLARED_BY_USER") {
        try { if (!segment.languageTag || Intl.getCanonicalLocales(segment.languageTag)[0] !== segment.languageTag) return fail("FALSE", "CAPTION_DECLARED_LANGUAGE_TAG_INVALID"); }
        catch { return fail("FALSE", "CAPTION_DECLARED_LANGUAGE_TAG_INVALID"); }
      }
      if (segment.languageDisposition === "NOT_SELECTED" && segment.languageTag != null) return fail("FALSE", "CAPTION_UNSELECTED_LANGUAGE_HAS_TAG");
      segmentIds.add(segment.segmentId); priorOrder = segment.segmentOrder;
      if (segment.timing.kind === "NOT_SUPPLIED") {
        if (!exact(segment.timing, ["kind"])) return fail("FALSE", "CAPTION_NOT_SUPPLIED_TIMING_HAS_INVENTED_VALUES");
        timingKinds.push("NOT_SUPPLIED");
      } else if (segment.timing.kind === "PROVIDER_TIME_UNQUALIFIED") {
        if (!exact(segment.timing, ["kind", "providerTime", "unitRef"]) || !nonempty(segment.timing.unitRef) ||
            !(typeof segment.timing.providerTime === "string" || Number.isFinite(segment.timing.providerTime))) return fail("FALSE", "CAPTION_PROVIDER_TIME_SHAPE_INVALID");
        timingKinds.push("PROVIDER_TIME_UNQUALIFIED");
      } else if (segment.timing.kind === "SOURCE_TICKS") {
        const t = segment.timing;
        if (!exact(t, ["kind", "sourceClockRef", "sourceVersionRef", "ticksPerSecond", "sourceDurationTicks", "startTick", "endTick"]) ||
            t.sourceClockRef !== expected.expectedSourceClockRef || t.sourceVersionRef !== d.sourceVersionRef ||
            t.ticksPerSecond !== expected.expectedTicksPerSecond || t.sourceDurationTicks !== expected.expectedSourceDurationTicks ||
            ![t.ticksPerSecond, t.sourceDurationTicks, t.startTick, t.endTick].every(Number.isSafeInteger) ||
            t.ticksPerSecond <= 0 || t.sourceDurationTicks < 0 || t.startTick < 0 || t.startTick >= t.endTick || t.endTick > t.sourceDurationTicks) return fail("FALSE", "CAPTION_SOURCE_TICK_RANGE_OR_CLOCK_INVALID");
        const clockTuple = [t.sourceClockRef, t.sourceVersionRef, t.ticksPerSecond, t.sourceDurationTicks];
        if (commonSourceClock && !same(commonSourceClock, clockTuple)) return fail("FALSE", "CAPTION_SOURCE_CLOCK_TUPLE_MIXED_WITHIN_SOURCE_TICKS");
        commonSourceClock = clockTuple; timingKinds.push("SOURCE_CLOCK_BOUND");
      } else return fail("FALSE", "CAPTION_TIMING_KIND_INVALID");
    }
    const aggregate = timingKinds.every((kind) => kind === "SOURCE_CLOCK_BOUND") ? "SOURCE_CLOCK_BOUND" :
      timingKinds.every((kind) => kind === "NOT_SUPPLIED") ? "NOT_SUPPLIED" :
      timingKinds.every((kind) => kind === "PROVIDER_TIME_UNQUALIFIED") ? "PROVIDER_TIME_UNQUALIFIED" : "MIXED";
    if (d.timingAvailability !== aggregate) return fail("FALSE", "CAPTION_TIMING_AVAILABILITY_AGGREGATE_MISMATCH");
    if (!contract?.semantics?.cueRule) return fail("UNKNOWN", "CAPTION_VALIDATOR_DEFINITION_MISSING");
    return fail("TRUE", "MEDIA_CAPTION_TIMELINE_DEFINITION_VALIDATED_EXACT_DRAFT_AND_SOURCE");
  }
  if (guardRef === "parent-source-current") {
    if (!exact(d, ["requestedParentVersionRef", "observedCurrentParentVersionRef", "parentRevisionRef", "currentness"]) || ![d.requestedParentVersionRef, d.observedCurrentParentVersionRef, d.parentRevisionRef].every(nonempty) || !["CURRENT", "STALE", "UNKNOWN"].includes(d.currentness)) return fail("UNKNOWN", "PARENT_SOURCE_CURRENTNESS_FACT_INVALID");
    if (d.currentness !== "CURRENT") return fail("UNKNOWN", "PARENT_SOURCE_CURRENTNESS_NOT_CONFIRMED");
    return d.requestedParentVersionRef === d.observedCurrentParentVersionRef && value.versionRefs.includes(d.requestedParentVersionRef) ? fail("TRUE", "EXACT_PARENT_SOURCE_VERSION_IS_CURRENT") : fail("FALSE", "PARENT_SOURCE_VERSION_CHANGED");
  }
  if (guardRef === "two-caption-versions-readable") {
    if (!exact(d, ["captionVersionRefs", "readableVersionRefs", "readabilityAuthorityRef", "catalogSnapshotRef"]) || !Array.isArray(d.captionVersionRefs) || !Array.isArray(d.readableVersionRefs) || !nonempty(d.readabilityAuthorityRef) || !nonempty(d.catalogSnapshotRef) || new Set(d.captionVersionRefs).size !== d.captionVersionRefs.length) return fail("UNKNOWN", "CAPTION_VERSION_READ_FACT_INVALID");
    if (d.captionVersionRefs.length !== 2 || !same(d.captionVersionRefs, value.versionRefs)) return fail("UNKNOWN", "EXACTLY_TWO_REQUESTED_CAPTION_VERSIONS_REQUIRED");
    if (d.captionVersionRefs.length !== 2) return fail("UNKNOWN", "EXACTLY_TWO_CAPTION_VERSIONS_REQUIRED");
    if (d.readabilityAuthorityRef !== expected.readAuthorityRef || d.catalogSnapshotRef !== expected.catalogSnapshotRef) return fail("UNKNOWN", "CAPTION_READ_AUTHORITY_OR_CATALOG_SNAPSHOT_MISMATCH");
    return same(d.captionVersionRefs, d.readableVersionRefs) && d.captionVersionRefs.every((ref) => value.versionRefs.includes(ref)) ? fail("TRUE", "BOTH_EXACT_CAPTION_VERSIONS_READABLE") : fail("FALSE", "ONE_OR_MORE_CAPTION_VERSIONS_NOT_READABLE");
  }
  if (guardRef === "exact-source-selected") {
    if (!exact(d, ["selectedSourceRef", "selectedVersionRef", "selectionEventRef", "catalogSnapshotRef"]) || !["selectedSourceRef", "selectedVersionRef", "selectionEventRef", "catalogSnapshotRef"].every((k) => nonempty(d[k]))) return fail("UNKNOWN", "SOURCE_SELECTION_FACT_INVALID");
    return expected.targetVersionRefs.includes(d.selectedVersionRef) && value.subjectRefs.includes(d.selectedSourceRef) && d.catalogSnapshotRef === expected.catalogSnapshotRef ? fail("TRUE", "EXPLICIT_SOURCE_SELECTION_BINDS_EXACT_CATALOG_VERSION") : fail("UNKNOWN", "SOURCE_SELECTION_SUBJECT_OR_VERSION_MISMATCH");
  }
  if (guardRef === "owner-approved-project-request-shape") {
    if (!exact(d, ["schemaRef", "schemaVersionRef", "requestFingerprint", "requestPayload"]) || !/^[a-f0-9]{64}$/u.test(d.requestFingerprint) || !record(d.requestPayload)) return fail("UNKNOWN", "PROJECT_REQUEST_VALIDATION_FACT_INVALID");
    const contract = specializedFactByGuard.get(guardRef)?.validator;
    const schema = createProjectRequestSchema();
    if (!contract || contract.schemaRef !== expected.requestSchemaRef || contract.schemaVersionRef !== expected.requestSchemaVersionRef ||
        d.schemaRef !== contract.schemaRef || d.schemaVersionRef !== contract.schemaVersionRef || !schema) return fail("UNKNOWN", "OWNER_PROJECT_REQUEST_SCHEMA_NOT_RESOLVED_OR_PINNED");
    const expectedFingerprint = hash({ operationRef: "media.operation-slice.create-project", trusted: { tenantScopeRef: expected.tenantScopeRef, principalRef: expected.principalRef }, requestPayload: d.requestPayload });
    if (d.requestFingerprint !== expectedFingerprint || d.requestFingerprint !== expected.actionRequestFingerprint) return fail("UNKNOWN", "PROJECT_REQUEST_FINGERPRINT_MISMATCH");
    if (d.requestPayload.selectedAuthorizedWorkspaceId !== expected.workspaceRef) return fail("UNKNOWN", "PROJECT_REQUEST_WORKSPACE_NOT_CURRENT_SELECTION");
    const validateRequest = schemaAjv.compile(schema);
    return validateRequest(d.requestPayload) ? fail("TRUE", "CANONICAL_CREATE_PROJECT_REQUEST_SCHEMA_VALIDATED") : fail("FALSE", "CANONICAL_CREATE_PROJECT_REQUEST_SCHEMA_REJECTS_PAYLOAD");
  }
  if (guardRef === "explicit-language-intent") {
    if (!exact(d, ["languageTag", "intentMode", "userInputEventRef", "sourceVersionRef", "detectorConfidenceDisposition"]) || !["languageTag", "userInputEventRef", "sourceVersionRef"].every((k) => nonempty(d[k])) || !["EXPLICIT_USER_SELECTION", "AUTO_DETECTED", "UNKNOWN"].includes(d.intentMode) || !["NOT_APPLICABLE", "UNAVAILABLE", "OBSERVED"].includes(d.detectorConfidenceDisposition)) return fail("UNKNOWN", "LANGUAGE_INTENT_FACT_INVALID");
    try { if (Intl.getCanonicalLocales(d.languageTag)[0] !== d.languageTag) return fail("UNKNOWN", "LANGUAGE_TAG_NOT_CANONICAL"); } catch { return fail("UNKNOWN", "LANGUAGE_TAG_INVALID"); }
    if (d.intentMode === "AUTO_DETECTED") return fail("FALSE", "LANGUAGE_WAS_NOT_EXPLICITLY_SELECTED");
    if (d.intentMode !== "EXPLICIT_USER_SELECTION" || d.languageTag !== expected.expectedLanguageTag || !value.versionRefs.includes(d.sourceVersionRef)) return fail("UNKNOWN", "EXPLICIT_LANGUAGE_SOURCE_VERSION_MISMATCH");
    return fail("TRUE", "EXPLICIT_USER_LANGUAGE_INTENT_BOUND_TO_SOURCE_VERSION");
  }
  return fail("UNKNOWN", "NO_GUARD_SPECIFIC_OBSERVATION_PREDICATE");
}

function evaluateStreamPredicate(guardRef, value, expected) {
  if (!streamGuardRefs.has(guardRef)) return null;
  const stream = value.stream;
  if (!exact(value, ["stream"]) || !record(stream)) return fail("UNKNOWN", "STREAM_FACT_ENVELOPE_INVALID");
  const identityMatches = stream.tenantScopeRef === expected.tenantScopeRef && stream.sessionRef === expected.targetRefs[0] && stream.ownerPrincipalRef === expected.principalRef;
  if (!identityMatches) return fail("UNKNOWN", "STREAM_SESSION_SCOPE_MISMATCH");
  if (guardRef === "media.guard.stream.reconnect.same-session-scope") return fail("TRUE", "STREAM_TENANT_SESSION_OWNER_TUPLE_MATCHES");
  if (guardRef === "media.guard.stream.reconnect.degraded-session") {
    if (!exact(stream, ["tenantScopeRef", "sessionRef", "ownerPrincipalRef", "sessionState"]) || !["OPEN", "CONNECTED", "DEGRADED", "DRAINING", "CLOSED", "FAILED", "UNKNOWN"].includes(stream.sessionState)) return fail("UNKNOWN", "STREAM_SESSION_STATE_INVALID");
    return stream.sessionState === "DEGRADED" ? fail("TRUE", "SESSION_IS_DEGRADED") : ["OPEN", "CONNECTED"].includes(stream.sessionState) ? fail("FALSE", "SESSION_NOT_DEGRADED") : fail("UNKNOWN", "SESSION_NOT_RECONNECTABLE_OR_UNKNOWN");
  }
  if (guardRef === "media.guard.stream.reconnect.current-fence") {
    if (!exact(stream, ["tenantScopeRef", "sessionRef", "ownerPrincipalRef", "lease"]) || !exact(stream.lease, ["tenantScopeRef", "sessionRef", "ownerPrincipalRef", "fencingToken", "disposition", "leaseVersionRef"])) return fail("UNKNOWN", "STREAM_LEASE_FACT_INVALID");
    if (stream.lease.tenantScopeRef !== stream.tenantScopeRef || stream.lease.sessionRef !== stream.sessionRef || stream.lease.ownerPrincipalRef !== stream.ownerPrincipalRef || !nonempty(stream.lease.fencingToken) || !nonempty(stream.lease.leaseVersionRef)) return fail("UNKNOWN", "STREAM_LEASE_SCOPE_MISMATCH");
    if (stream.lease.fencingToken !== expected.leaseFencingToken) return fail("UNKNOWN", "STREAM_FENCING_TOKEN_DOES_NOT_MATCH_TRUSTED_REQUEST");
    return stream.lease.disposition === "CURRENT" ? fail("TRUE", "EXACT_STREAM_LEASE_FENCE_CURRENT") : ["EXPIRED", "FENCED"].includes(stream.lease.disposition) ? fail("FALSE", "STREAM_LEASE_NOT_CURRENT") : fail("UNKNOWN", "STREAM_LEASE_CURRENTNESS_UNKNOWN");
  }
  if (guardRef === "media.guard.stream.reconnect.prior-effects-resolved") {
    if (!exact(stream, ["tenantScopeRef", "sessionRef", "ownerPrincipalRef", "unresolvedFrameEffects"]) || !Array.isArray(stream.unresolvedFrameEffects)) return fail("UNKNOWN", "STREAM_FRAME_EFFECT_FACTS_INVALID");
    const seen = new Map();
    for (const frame of stream.unresolvedFrameEffects) {
      if (!exact(frame, ["tenantScopeRef", "sessionRef", "sequence", "effectDisposition"]) || frame.tenantScopeRef !== stream.tenantScopeRef || frame.sessionRef !== stream.sessionRef || !Number.isSafeInteger(frame.sequence) || frame.sequence < 0 || !["ACKNOWLEDGED", "REJECTED", "UNKNOWN"].includes(frame.effectDisposition)) return fail("UNKNOWN", "STREAM_FRAME_EFFECT_FACTS_INVALID");
      if (seen.has(frame.sequence) && seen.get(frame.sequence) !== frame.effectDisposition) return fail("UNKNOWN", "CONTRADICTORY_STREAM_FRAME_EFFECTS");
      seen.set(frame.sequence, frame.effectDisposition);
    }
    return stream.unresolvedFrameEffects.some((frame) => frame.effectDisposition === "UNKNOWN") ? fail("UNKNOWN", "STREAM_FRAME_EFFECT_UNRESOLVED") : fail("TRUE", "ALL_PRIOR_STREAM_FRAME_EFFECTS_CLASSIFIED");
  }
  if (guardRef === "media.guard.stream.reconnect.budget-available") {
    if (!exact(stream, ["tenantScopeRef", "sessionRef", "ownerPrincipalRef", "recoveryBudget"]) || !exact(stream.recoveryBudget, ["tenantScopeRef", "sessionRef", "policyRef", "disposition", "remainingReconnectRequests", "deadlineEpochMilliseconds", "observedAtEpochMilliseconds"])) return fail("UNKNOWN", "STREAM_RECOVERY_BUDGET_INVALID");
    const b = stream.recoveryBudget;
    if (b.tenantScopeRef !== stream.tenantScopeRef || b.sessionRef !== stream.sessionRef || b.policyRef !== expected.streamBudgetPolicyRef || b.policyRef !== "media.policy.stream.reconnect-budget.v1" || !Number.isSafeInteger(b.remainingReconnectRequests) || b.remainingReconnectRequests < 0 || !Number.isSafeInteger(b.deadlineEpochMilliseconds) || !Number.isSafeInteger(b.observedAtEpochMilliseconds)) return fail("UNKNOWN", "STREAM_RECOVERY_BUDGET_SCOPE_OR_VALUE_INVALID");
    const now = Date.parse(expected.now);
    if (b.observedAtEpochMilliseconds > now) return fail("UNKNOWN", "STREAM_RECOVERY_BUDGET_OBSERVATION_FROM_FUTURE");
    return b.disposition === "CURRENT" && b.remainingReconnectRequests > 0 && b.deadlineEpochMilliseconds > now ? fail("TRUE", "CURRENT_BUDGET_HAS_REQUEST_AND_TIME_REMAINING") : ["EXHAUSTED", "EXPIRED"].includes(b.disposition) || b.remainingReconnectRequests === 0 || b.deadlineEpochMilliseconds <= now ? fail("FALSE", "STREAM_RECOVERY_BUDGET_EXHAUSTED_OR_EXPIRED") : fail("UNKNOWN", "STREAM_RECOVERY_BUDGET_NOT_CURRENT");
  }
  if (!exact(stream, ["tenantScopeRef", "sessionRef", "ownerPrincipalRef", "lastAcknowledgedFrameSequence", "reconnectSequence"])) return fail("UNKNOWN", "STREAM_SEQUENCE_FACT_INVALID");
  const { lastAcknowledgedFrameSequence: lastAck, reconnectSequence } = stream;
  if (!Number.isSafeInteger(lastAck) || lastAck < 0 || !Number.isSafeInteger(reconnectSequence) || reconnectSequence < 0) return fail("UNKNOWN", "STREAM_SEQUENCE_FACT_INVALID");
  if (lastAck === Number.MAX_SAFE_INTEGER) return fail("UNKNOWN", "STREAM_ACK_SEQUENCE_OVERFLOW");
  return reconnectSequence === lastAck + 1 ? fail("TRUE", "NEXT_STREAM_SEQUENCE_IS_CONTIGUOUS") : fail("FALSE", "NEXT_STREAM_SEQUENCE_NOT_CONTIGUOUS");
}

function evaluateJobPredicate(guardRef, value, expected) {
  if (!jobGuardRefs.has(guardRef)) return null;
  if (!exact(value, ["jobRef", "jobVersionRef", "tenantScopeRef", "ownerPrincipalRef", "jobCanonicalStateRef", "jobState", "attemptRef", "attemptVersionRef", "attemptFencingToken", "attemptDisposition", "effectDisposition", "retryBudgetRef", "retryBudgetRemaining", "stateAuthorityRef"]) ||
      value.jobRef !== expected.targetRefs[0] || value.tenantScopeRef !== expected.tenantScopeRef || value.ownerPrincipalRef !== expected.principalRef ||
      value.jobVersionRef !== expected.jobVersionRef || !nonempty(value.stateAuthorityRef)) return fail("UNKNOWN", "JOB_STATE_OBSERVATION_SCOPE_INVALID");
  if (guardRef === "existing-job-is-outcome-unknown" || guardRef === "prior-outcome-is-not-unknown; check-the-existing-job-outcome-first") {
    const mappedUnknown = value.jobState === "OUTCOME_UNKNOWN" && value.jobCanonicalStateRef === ".product-experience/pdp-1-domain-data/states.yaml#stateMachines/media-job/stateDefinitions/OUTCOME_UNKNOWN";
    if (guardRef === "existing-job-is-outcome-unknown") return mappedUnknown ? fail("TRUE", "CANONICAL_JOB_OUTCOME_UNKNOWN_OBSERVED") : fail("UNKNOWN", "OTHER_JOB_STATE_HAS_NO_CANONICAL_MAPPING");
    return mappedUnknown ? fail("FALSE", "PRIOR_JOB_OUTCOME_REMAINS_UNKNOWN") : fail("UNKNOWN", "OTHER_JOB_STATE_HAS_NO_CANONICAL_MAPPING");
  }
  if (!nonempty(value.attemptRef) || value.attemptRef !== expected.expectedAttemptRef || !nonempty(value.attemptVersionRef) || !Number.isSafeInteger(value.attemptFencingToken) || value.attemptFencingToken !== expected.expectedAttemptFencingToken || !nonempty(value.retryBudgetRef) || value.retryBudgetRef !== expected.expectedRetryBudgetRef || !Number.isSafeInteger(value.retryBudgetRemaining) || value.retryBudgetRemaining < 0 || value.stateAuthorityRef !== ".product-experience/pdp-1-domain-data/transitions.yaml#ownerRaceResolutionContract" || value.jobVersionRef !== expected.jobVersionRef) return fail("UNKNOWN", "RETRY_ATTEMPT_OR_BUDGET_FACT_MISSING_OR_UNPINNED");
  if (value.attemptDisposition === "UNKNOWN" || value.effectDisposition === "UNKNOWN") return fail("UNKNOWN", "PRIOR_ATTEMPT_CLASSIFICATION_OR_EFFECT_UNKNOWN");
  if (value.attemptDisposition === "NON_RETRYABLE" || value.effectDisposition !== "NO_EFFECT_CONFIRMED" || value.retryBudgetRemaining === 0) return fail("FALSE", "PRIOR_ATTEMPT_NOT_SAFELY_RETRYABLE");
  if (value.attemptDisposition !== "RETRYABLE" || value.effectDisposition !== "NO_EFFECT_CONFIRMED") return fail("UNKNOWN", "PRIOR_ATTEMPT_FACTS_UNCLASSIFIED");
  return fail("TRUE", "EXACT_PRIOR_ATTEMPT_RETRYABLE_WITH_NO_EFFECT_AND_BUDGET");
}

function evaluateExplicitTicks(guardRef, value, expected) {
  if (guardRef !== "explicit-user-tick-values") return null;
  if (!exact(value, ["timebaseRef", "sourceVersionRef", "userInputEventRef", "ticks", "clockRate", "durationTicks"]) ||
      !nonempty(value.timebaseRef) || !nonempty(value.sourceVersionRef) || !nonempty(value.userInputEventRef) || !Array.isArray(value.ticks) ||
      !Number.isSafeInteger(value.clockRate) || value.clockRate <= 0 || !Number.isSafeInteger(value.durationTicks) || value.durationTicks < 0) return fail("UNKNOWN", "EXPLICIT_TICK_INPUT_INVALID");
  if (value.timebaseRef !== expected.sourceClockRef || !expected.targetVersionRefs.includes(value.sourceVersionRef)) return fail("UNKNOWN", "EXPLICIT_TICKS_SOURCE_OR_TIMEBASE_MISMATCH");
  if (value.clockRate !== expected.expectedClockRate || value.durationTicks !== expected.expectedDurationTicks) return fail("UNKNOWN", "EXPLICIT_TICKS_CLOCK_RATE_OR_DURATION_NOT_CURRENT");
  if (value.ticks.length === 0) return fail("FALSE", "NO_EXPLICIT_USER_TICKS_PROVIDED");
  if (value.ticks.some((tick) => !Number.isSafeInteger(tick) || tick < 0 || tick > value.durationTicks)) return fail("FALSE", "EXPLICIT_TICKS_OUTSIDE_SOURCE_DURATION");
  if (value.ticks.some((tick, index) => index > 0 && tick <= value.ticks[index - 1])) return fail("UNKNOWN", "EXPLICIT_TICKS_NOT_STRICTLY_ORDERED");
  return fail("TRUE", "EXPLICIT_ORDERED_TICKS_MATCH_SOURCE_TIMEBASE");
}

/**
 * Evaluate scope, authority/admission, continuity, and typed-read guards from a
 * source receipt bound to exact host context. A correctly-shaped receipt is a
 * definition fixture until a trusted adapter is separately qualified.
 */
export function evaluatePdp3TypedGuardFact({ guardRef, stepRef, expected, receipt, retryPolicyRead }) {
  const definition = guardDefinitionByRef.get(guardRef);
  if (!definition || !nonempty(stepRef) || !definition.stepRefs.includes(stepRef)) return fail("UNKNOWN", "GUARD_STEP_BINDING_NOT_FOUND");
  const predicate = predicateDefinitionByRef.get(guardRef);
  if (!predicate) return fail("UNKNOWN", "GUARD_PREDICATE_SOURCE_NOT_FOUND");
  const step = stepBySourceRef.get(stepRef);
  if (!step || expected?.actionRef !== step.canonicalBindings?.actionRef || !same(expected?.operationRefs, step.canonicalBindings?.operationRefs)) return fail("UNKNOWN", "GUARD_ACTION_OR_OPERATION_DOES_NOT_MATCH_CANONICAL_STEP_BINDING");
  const actionId = step.canonicalBindings?.actionRef;
  const actionDefinitionRef = `.product-experience/pdp-3-product-experience/action-registry.yaml#actions/@id=${actionId}`;
  const actionGuardRef = `${actionDefinitionRef}/actionDefinitionSemantics/typedDefinition/applicabilityGuards`;
  if (expected?.sourceRef !== actionDefinitionRef || expected?.readAuthorityRef !== actionGuardRef) return fail("UNKNOWN", "GUARD_SOURCE_OR_READ_AUTHORITY_NOT_PINNED_TO_THIS_STEP");
  if (guardRef === "retry-budget-remains-under-current-policy") {
    if (!retryPolicyRead || !exact(retryPolicyRead, ["expected", "request", "result", "trusted", "now", "maxAgeMs"])) {
      return fail("UNKNOWN", "EXACT_P1_RETRY_POLICY_QUERY_REQUIRED");
    }
    return evaluatePdp3RetryPolicyRead({ stepRef, ...retryPolicyRead });
  }
  const read = validateGuardReadReceipt({ guardRef, stepRef, expected, receipt, now: expected?.now, maxAgeMs: expected?.maxAgeMs });
  if (read.truth !== "TRUE") return read;
  const validators = predicateSchemaValidators.get(guardRef);
  if (!validators?.fact(receipt.value)) return fail("UNKNOWN", `DECLARED_GUARD_FACT_SCHEMA_INVALID:${schemaAjv.errorsText(validators?.fact.errors)}`);
  if (!validators.receipt(receipt)) return fail("UNKNOWN", `DECLARED_GUARD_RECEIPT_SCHEMA_INVALID:${schemaAjv.errorsText(validators.receipt.errors)}`);
  const result = evaluateRetryBudgetPredicate(guardRef, receipt.value, expected) ??
    evaluateScopePredicate(guardRef, receipt.value, expected) ??
    evaluateAuthorityPredicate(guardRef, receipt.value, expected) ??
    evaluateContinuityPredicate(guardRef, receipt.value, expected) ??
    evaluateObservationPredicate(guardRef, receipt.value, expected) ??
    evaluateStreamPredicate(guardRef, receipt.value, expected) ??
    evaluateJobPredicate(guardRef, receipt.value, expected) ??
    evaluateExplicitTicks(guardRef, receipt.value, expected);
  if (result?.truth === "TRUE" && authorityGuardRefs.has(guardRef) && step.canonicalBindings.runtimeAdmission === "NOT_ADMITTED") {
    return fail("UNKNOWN", "STEP_OPERATION_RUNTIME_ADMISSION_NOT_ESTABLISHED");
  }
  return result ?? fail("UNKNOWN", "NO_TYPED_PREDICATE_IMPLEMENTED_FOR_GUARD");
}

/**
 * Evaluate the limited PDP-3 rights/consent guard slice from typed current-read
 * receipts. Inputs are source-test fixtures until a qualified adapter supplies
 * the same validated evidence; this function does not grant execution authority.
 */
export function evaluatePdp3RightsGuardFact({ guardRef, evidence, expected }) {
  const rightsContract = getRightsContract();
  const definition = guardSource.guardContracts.records.find((row) => row.guardRef === guardRef);
  if (!definition || !rightsGuardRefs.has(guardRef) || !rightsContract ||
      definition.requiredObservationContractRef !== ".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.rights-decision.v1") {
    return fail("UNKNOWN", "NO_EXACT_TYPED_RIGHTS_GUARD_CONTRACT");
  }
  if (!record(expected) || !exact(expected, ["tenantScopeRef", "principalRef", "subjectArtifactVersionRef", "purposeRef", "useRef", "regionRef", "retentionPolicyRef", "now", "maxAgeMs"]) ||
      ![expected.tenantScopeRef, expected.principalRef, expected.subjectArtifactVersionRef, expected.purposeRef, expected.useRef, expected.regionRef, expected.retentionPolicyRef].every(nonempty) ||
      !Number.isSafeInteger(expected.maxAgeMs) || expected.maxAgeMs < 0) return fail("UNKNOWN", "TRUSTED_EXPECTED_SCOPE_INVALID");
  const requiredKinds = guardRef === "media.guard.stream.reconnect.current-consent" ? ["CONSENT"] : ["RIGHTS", "CONSENT"];
  if (!Array.isArray(evidence) || evidence.length !== requiredKinds.length) return fail("UNKNOWN", "REQUIRED_RIGHTS_AND_CONSENT_READS_MISSING");
  const byKind = new Map();
  for (const item of evidence) {
    if (!exact(item, ["request", "result", "trusted"]) || !record(item.request) || !record(item.result) || !record(item.trusted)) return fail("UNKNOWN", "CURRENT_READ_ENVELOPE_INVALID");
    const kind = item.request.decisionKind;
    if (!requiredKinds.includes(kind) || byKind.has(kind)) return fail("UNKNOWN", "DECISION_KIND_SET_MISMATCH");
    const current = validateTypedObservationCurrentRead({
      contract: rightsContract,
      request: item.request,
      result: item.result,
      trusted: item.trusted,
      now: expected.now,
      maxAgeMs: expected.maxAgeMs,
    });
    if (current.truth !== "TRUE") return fail("UNKNOWN", current.reason);
    const requestTuple = [item.request.subjectArtifactVersionRef, item.request.purposeRef, item.request.useRef, item.request.regionRef, item.request.retentionPolicyRef];
    const expectedTuple = [expected.subjectArtifactVersionRef, expected.purposeRef, expected.useRef, expected.regionRef, expected.retentionPolicyRef];
    const decision = item.result.decision;
    if (JSON.stringify(requestTuple) !== JSON.stringify(expectedTuple) || !record(decision) ||
        decision.decisionKind !== kind || decision.subjectArtifactVersionRef !== expected.subjectArtifactVersionRef ||
        decision.purposeRef !== expected.purposeRef || decision.useRef !== expected.useRef ||
        decision.regionRef !== expected.regionRef || decision.retentionPolicyRef !== expected.retentionPolicyRef ||
        decision.tenantScopeRef !== expected.tenantScopeRef || decision.principalRef !== expected.principalRef) {
      return fail("UNKNOWN", "RIGHTS_OR_CONSENT_SUBJECT_PURPOSE_SCOPE_MISMATCH");
    }
    if (Date.parse(decision.validFrom) > Date.parse(expected.now) ||
        !decision.validUntil || Date.parse(expected.now) >= Date.parse(decision.validUntil)) return fail("UNKNOWN", "RIGHTS_OR_CONSENT_DECISION_EXPIRED_OR_NOT_YET_VALID");
    byKind.set(kind, item.result);
  }
  if (requiredKinds.some((kind) => !byKind.has(kind))) return fail("UNKNOWN", "REQUIRED_DECISION_KIND_ABSENT");
  const denied = [...byKind.values()].some((result) => result.decision.effectDisposition !== "PERMITTED");
  if (denied) return fail("FALSE", "CURRENT_RIGHTS_OR_CONSENT_NOT_PERMITTED");
  return fail("TRUE", "EXACT_CURRENT_RIGHTS_AND_CONSENT_TUPLE_MATCH");
}
