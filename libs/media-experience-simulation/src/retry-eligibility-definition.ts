import type { RetryEligibilityEvidence } from "./model.js";

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
  "profileDisposition", "retryBudgetRemaining", "retryBudgetRef", "observedAt", "evidenceRefs",
] as const;

/**
 * Evaluates the retry pre-dispatch guard from a synthetic fixture. It never sends a
 * retry request, allocates a fencing token, or treats the fixture as runtime proof.
 */
export function evaluateRetryEligibilityDefinition(
  evidence: RetryEligibilityEvidence | unknown,
  trusted: RetryEligibilityTrustedContext | unknown,
): RetryEligibilityResult {
  if (!isPlainRecord(evidence) || !isPlainRecord(trusted) ||
    Object.keys(evidence).length !== keys.length || keys.some((key) => !Object.hasOwn(evidence, key)) ||
    Object.keys(trusted).some((key) => ![
      "tenantId", "principalId", "jobId", "jobVersion", "retryBudgetRef", "now", "maxAgeMs",
    ].includes(key)) ||
    ![
      "tenantId", "principalId", "jobId", "jobVersion", "retryBudgetRef", "now", "maxAgeMs",
    ].every((key) => Object.hasOwn(trusted, key))) {
    return { decision: "INVALID_FIXTURE", reasons: ["CLOSED_INPUT_SHAPE_REQUIRED"], effect: "NONE", runtimeAdmission: "NOT_ADMITTED" };
  }
  if (![evidence.tenantId, evidence.principalId, evidence.jobId, evidence.priorAttemptId, evidence.retryBudgetRef]
    .every(opaqueId) || ![trusted.tenantId, trusted.principalId, trusted.jobId, trusted.retryBudgetRef].every(opaqueId) ||
    !Number.isSafeInteger(evidence.jobVersion) || !Number.isSafeInteger(evidence.priorAttemptFencingToken) ||
    !Number.isSafeInteger(evidence.retryBudgetRemaining) || !Number.isSafeInteger(trusted.jobVersion) ||
    !Number.isSafeInteger(trusted.maxAgeMs) || (trusted.maxAgeMs as number) < 0 ||
    !isCanonicalUtc(evidence.observedAt) || !isCanonicalUtc(trusted.now) ||
    !Array.isArray(evidence.evidenceRefs) || evidence.evidenceRefs.length < 5 ||
    !evidence.evidenceRefs.every(opaqueId) || (evidence.priorAttemptFencingToken as number) < 0 ||
    (evidence.retryBudgetRemaining as number) < 0 || (evidence.jobVersion as number) < 0 || (trusted.jobVersion as number) < 0) {
    return { decision: "INVALID_FIXTURE", reasons: ["TYPED_FACTS_INVALID"], effect: "NONE", runtimeAdmission: "NOT_ADMITTED" };
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
    evidence.consentDisposition, evidence.profileDisposition];
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
  if (evidence.profileDisposition !== "CURRENT_QUALIFIED") denied.push("PROFILE_NOT_CURRENTLY_QUALIFIED");
  if ((evidence.retryBudgetRemaining as number) === 0) denied.push("RETRY_BUDGET_EXHAUSTED");
  return denied.length
    ? { decision: "DENIED", reasons: denied, effect: "NONE", runtimeAdmission: "NOT_ADMITTED" }
    : { decision: "ELIGIBLE_FOR_EXPLICIT_REQUEST", reasons: [], effect: "NONE", runtimeAdmission: "NOT_ADMITTED" };
}
