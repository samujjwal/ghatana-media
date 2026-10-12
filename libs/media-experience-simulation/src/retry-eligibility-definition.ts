import type { RetryEligibilityEvidence, RetryEligibilityEvidenceFact } from "./model.js";

export type RetryEligibilityDecision =
  | "ELIGIBLE_FOR_EXPLICIT_REQUEST"
  | "DENIED"
  | "UNKNOWN"
  | "INVALID_FIXTURE";

export interface RetryEligibilityTrustedContext {
  readonly tenantId: string;
  readonly principalId: string;
  readonly jobId: string;
  readonly jobVersion: number;
  readonly retryBudgetRef: string;
  readonly now: string;
  readonly maxAgeMs: number;
}

export interface RetryEligibilityEvidenceScope {
  readonly tenantId: string;
  readonly principalId: string;
  readonly jobId: string;
  readonly jobVersion: number;
}

/** A source-owned fact returned for the exact reference, independent of caller claims. */
export interface RetryEligibilitySourceFact {
  readonly fact: RetryEligibilityEvidenceFact;
  readonly evidenceRef: string;
  readonly scope: RetryEligibilityEvidenceScope;
  readonly observedAt: string;
  readonly value: unknown;
}

/** Resolves a reference to the source-owned fact envelope; never a boolean existence check. */
export type RetryEligibilityEvidenceResolver = (
  fact: RetryEligibilityEvidenceFact,
  evidenceRef: string,
) => RetryEligibilitySourceFact | null | undefined;

export interface RetryEligibilityResult {
  readonly decision: RetryEligibilityDecision;
  readonly reasons: readonly string[];
  readonly effect: "NONE";
  readonly runtimeAdmission: "NOT_ADMITTED";
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const isCanonicalUtc = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};

const opaqueId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);

const keys = [
  "tenantId", "principalId", "jobId", "jobVersion", "priorAttemptId",
  "priorAttemptFencingToken", "priorAttemptDisposition", "priorEffectDisposition",
  "authorityDisposition", "policyDisposition", "rightsDisposition", "consentDisposition",
  "licenseDisposition", "resourceDisposition", "deploymentDisposition", "profileDisposition",
  "retryBudgetRemaining", "retryBudgetRef", "observedAt", "evidenceRefs",
] as const;
const evidenceFacts: readonly RetryEligibilityEvidenceFact[] = [
  "priorAttempt", "priorEffect", "authority", "policy", "rights", "consent",
  "license", "resource", "deployment", "profile", "retryBudget",
];
const evidenceReferenceKeys = evidenceFacts;
const contextKeys = ["tenantId", "principalId", "jobId", "jobVersion", "retryBudgetRef", "now", "maxAgeMs"] as const;
const evidenceValueKeys: Readonly<Record<RetryEligibilityEvidenceFact, readonly string[]>> = {
  priorAttempt: ["priorAttemptId", "priorAttemptFencingToken", "priorAttemptDisposition"],
  priorEffect: ["priorEffectDisposition"],
  authority: ["authorityDisposition"],
  policy: ["policyDisposition"],
  rights: ["rightsDisposition"],
  consent: ["consentDisposition"],
  license: ["licenseDisposition"],
  resource: ["resourceDisposition"],
  deployment: ["deploymentDisposition"],
  profile: ["profileDisposition"],
  retryBudget: ["retryBudgetRemaining", "retryBudgetRef"],
};

const unknown = (reason: string): RetryEligibilityResult => ({
  decision: "UNKNOWN", reasons: [reason], effect: "NONE", runtimeAdmission: "NOT_ADMITTED",
});

const sameFactValue = (fact: RetryEligibilityEvidenceFact, sourceValue: unknown, claimed: Record<string, unknown>): boolean => {
  const fields = evidenceValueKeys[fact];
  if (fields.length === 1) return sourceValue === claimed[fields[0]!];
  if (!isPlainRecord(sourceValue) || Object.keys(sourceValue).length !== fields.length ||
    Object.keys(sourceValue).some((key) => !fields.includes(key))) return false;
  return fields.every((key) => sourceValue[key] === claimed[key]);
};

const isSourceFact = (value: unknown): value is RetryEligibilitySourceFact => {
  if (!isPlainRecord(value) || Object.keys(value).length !== 5 ||
    !["fact", "evidenceRef", "scope", "observedAt", "value"].every((key) => Object.hasOwn(value, key)) ||
    !evidenceFacts.includes(value.fact as RetryEligibilityEvidenceFact) || !opaqueId(value.evidenceRef) ||
    !isCanonicalUtc(value.observedAt) || !isPlainRecord(value.scope)) return false;
  const scope = value.scope;
  return Object.keys(scope).length === 4 &&
    ["tenantId", "principalId", "jobId", "jobVersion"].every((key) => Object.hasOwn(scope, key)) &&
    [scope.tenantId, scope.principalId, scope.jobId].every(opaqueId) && Number.isSafeInteger(scope.jobVersion);
};

/**
 * Evaluates retry pre-dispatch conditions only when every exact reference resolves
 * to a source-owned fact envelope matching the caller's claimed value and trusted scope.
 * Missing, mismatched, or unresolved source evidence stays UNKNOWN. This never sends a
 * retry request, allocates a fence, or admits runtime.
 */
export function evaluateRetryEligibilityDefinition(
  evidence: RetryEligibilityEvidence | unknown,
  trusted: RetryEligibilityTrustedContext | unknown,
  resolveEvidenceRef?: RetryEligibilityEvidenceResolver,
): RetryEligibilityResult {
  if (evidence === null || evidence === undefined) return unknown("RETRY_ELIGIBILITY_EVIDENCE_MISSING");
  if (!isPlainRecord(evidence) || !isPlainRecord(trusted) ||
    Object.keys(trusted).some((key) => !contextKeys.includes(key as typeof contextKeys[number])) ||
    !contextKeys.every((key) => Object.hasOwn(trusted, key))) {
    return { decision: "INVALID_FIXTURE", reasons: ["CLOSED_INPUT_SHAPE_REQUIRED"], effect: "NONE", runtimeAdmission: "NOT_ADMITTED" };
  }
  if (Object.keys(evidence).some((key) => !keys.includes(key as typeof keys[number]))) {
    return { decision: "INVALID_FIXTURE", reasons: ["CLOSED_INPUT_SHAPE_REQUIRED"], effect: "NONE", runtimeAdmission: "NOT_ADMITTED" };
  }
  if (keys.some((key) => !Object.hasOwn(evidence, key))) return unknown("REQUIRED_RETRY_FACT_MISSING");
  if (![evidence.tenantId, evidence.principalId, evidence.jobId, evidence.priorAttemptId, evidence.retryBudgetRef]
    .every(opaqueId) || ![trusted.tenantId, trusted.principalId, trusted.jobId, trusted.retryBudgetRef].every(opaqueId) ||
    !Number.isSafeInteger(evidence.jobVersion) || !Number.isSafeInteger(evidence.priorAttemptFencingToken) ||
    !Number.isSafeInteger(evidence.retryBudgetRemaining) || !Number.isSafeInteger(trusted.jobVersion) ||
    !Number.isSafeInteger(trusted.maxAgeMs) || (trusted.maxAgeMs as number) < 0 ||
    !isCanonicalUtc(evidence.observedAt) || !isCanonicalUtc(trusted.now) ||
    (evidence.priorAttemptFencingToken as number) < 0 ||
    (evidence.retryBudgetRemaining as number) < 0 || (evidence.jobVersion as number) < 0 || (trusted.jobVersion as number) < 0) {
    return { decision: "INVALID_FIXTURE", reasons: ["TYPED_FACTS_INVALID"], effect: "NONE", runtimeAdmission: "NOT_ADMITTED" };
  }
  const evidenceRefs = evidence.evidenceRefs;
  if (!isPlainRecord(evidenceRefs) || Object.keys(evidenceRefs).some((key) => !evidenceReferenceKeys.includes(key as RetryEligibilityEvidenceFact)) ||
    !evidenceReferenceKeys.every((key) => Object.hasOwn(evidenceRefs, key)) ||
    !evidenceReferenceKeys.every((key) => opaqueId(evidenceRefs[key]))) {
    return unknown("REQUIRED_SOURCE_EVIDENCE_REFERENCE_MISSING_OR_INVALID");
  }
  if (!resolveEvidenceRef) return unknown("REQUIRED_SOURCE_EVIDENCE_REFERENCE_UNRESOLVED");
  try {
    for (const fact of evidenceFacts) {
      const ref = evidenceRefs[fact] as string;
      const source = resolveEvidenceRef(fact, ref);
      if (!isSourceFact(source) || source.fact !== fact || source.evidenceRef !== ref ||
        !sameFactValue(fact, source.value, evidence) || source.observedAt !== evidence.observedAt ||
        source.scope.tenantId !== trusted.tenantId || source.scope.principalId !== trusted.principalId ||
        source.scope.jobId !== trusted.jobId || source.scope.jobVersion !== trusted.jobVersion ||
        source.scope.tenantId !== evidence.tenantId || source.scope.principalId !== evidence.principalId ||
        source.scope.jobId !== evidence.jobId || source.scope.jobVersion !== evidence.jobVersion) {
        return unknown("SOURCE_EVIDENCE_FACT_MISSING_OR_MISMATCHED");
      }
    }
  } catch {
    return unknown("REQUIRED_SOURCE_EVIDENCE_REFERENCE_UNRESOLVED");
  }
  if (evidence.tenantId !== trusted.tenantId || evidence.principalId !== trusted.principalId ||
    evidence.jobId !== trusted.jobId || evidence.jobVersion !== trusted.jobVersion ||
    evidence.retryBudgetRef !== trusted.retryBudgetRef) {
    return { decision: "DENIED", reasons: ["TRUSTED_SCOPE_OR_VERSION_MISMATCH"], effect: "NONE", runtimeAdmission: "NOT_ADMITTED" };
  }
  const age = Date.parse(trusted.now as string) - Date.parse(evidence.observedAt);
  if (age < 0 || age > (trusted.maxAgeMs as number)) {
    return { decision: "UNKNOWN", reasons: ["ELIGIBILITY_EVIDENCE_STALE_OR_FUTURE"], effect: "NONE", runtimeAdmission: "NOT_ADMITTED" };
  }
  const dispositions = [evidence.priorAttemptDisposition, evidence.priorEffectDisposition,
    evidence.authorityDisposition, evidence.policyDisposition, evidence.rightsDisposition,
    evidence.consentDisposition, evidence.licenseDisposition, evidence.resourceDisposition,
    evidence.deploymentDisposition, evidence.profileDisposition];
  if (dispositions.some((value) => value === "UNKNOWN")) {
    return { decision: "UNKNOWN", reasons: ["REQUIRED_RETRY_FACT_UNKNOWN"], effect: "NONE", runtimeAdmission: "NOT_ADMITTED" };
  }
  const knownEnums = [
    ["RETRYABLE", "NON_RETRYABLE", "UNKNOWN"],
    ["NO_EFFECT_CONFIRMED", "EFFECT_CONFIRMED", "UNKNOWN"],
    ["CURRENT_ALLOWED", "DENIED", "UNKNOWN"],
    ["CURRENT_ALLOWED", "DENIED", "UNKNOWN"],
    ["CURRENT_ALLOWED", "DENIED", "UNKNOWN"],
    ["CURRENT_ACTIVE", "REVOKED", "UNKNOWN"],
    ["CURRENT_ALLOWED", "DENIED", "UNKNOWN"],
    ["CURRENT_ALLOWED", "DENIED", "UNKNOWN"],
    ["CURRENT_ALLOWED", "DENIED", "UNKNOWN"],
    ["CURRENT_QUALIFIED", "UNQUALIFIED", "UNKNOWN"],
  ];
  if (dispositions.some((value, index) => !knownEnums[index]?.includes(String(value)))) {
    return { decision: "INVALID_FIXTURE", reasons: ["ENUM_VALUE_INVALID"], effect: "NONE", runtimeAdmission: "NOT_ADMITTED" };
  }
  const denied: string[] = [];
  if (evidence.priorAttemptDisposition !== "RETRYABLE") denied.push("PRIOR_ATTEMPT_NOT_CLASSIFIED_RETRYABLE");
  if (evidence.priorEffectDisposition !== "NO_EFFECT_CONFIRMED") denied.push("PRIOR_EFFECT_NOT_RECONCILED_TO_NO_EFFECT");
  if (evidence.authorityDisposition !== "CURRENT_ALLOWED") denied.push("RETRY_AUTHORITY_NOT_CURRENTLY_ALLOWED");
  if (evidence.policyDisposition !== "CURRENT_ALLOWED") denied.push("CURRENT_POLICY_NOT_ALLOWED");
  if (evidence.rightsDisposition !== "CURRENT_ALLOWED") denied.push("RIGHTS_NOT_CURRENTLY_ALLOWED");
  if (evidence.consentDisposition !== "CURRENT_ACTIVE") denied.push("CONSENT_NOT_CURRENTLY_ACTIVE");
  if (evidence.licenseDisposition !== "CURRENT_ALLOWED") denied.push("LICENSE_NOT_CURRENTLY_ALLOWED");
  if (evidence.resourceDisposition !== "CURRENT_ALLOWED") denied.push("RESOURCE_NOT_CURRENTLY_ALLOWED");
  if (evidence.deploymentDisposition !== "CURRENT_ALLOWED") denied.push("DEPLOYMENT_NOT_CURRENTLY_ALLOWED");
  if (evidence.profileDisposition !== "CURRENT_QUALIFIED") denied.push("PROFILE_NOT_CURRENTLY_QUALIFIED");
  if ((evidence.retryBudgetRemaining as number) === 0) denied.push("RETRY_BUDGET_EXHAUSTED");
  return denied.length
    ? { decision: "DENIED", reasons: denied, effect: "NONE", runtimeAdmission: "NOT_ADMITTED" }
    : { decision: "ELIGIBLE_FOR_EXPLICIT_REQUEST", reasons: [], effect: "NONE", runtimeAdmission: "NOT_ADMITTED" };
}
