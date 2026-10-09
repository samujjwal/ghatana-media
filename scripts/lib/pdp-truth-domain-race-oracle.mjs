export class RaceResolutionError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const time = (value) => {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d+))?Z$/.exec(value);
  if (!match) return false;
  const [, y, mo, d, h, mi, s] = match;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
  return date.getUTCFullYear() === Number(y) && date.getUTCMonth() === Number(mo) - 1 && date.getUTCDate() === Number(d) && Number(h) <= 23 && Number(mi) <= 59 && Number(s) <= 59;
};
const requireValue = (value, code) => { if (!nonempty(value)) throw new RaceResolutionError(code); return value; };
const requireSafeInt = (value, code) => { if (!Number.isSafeInteger(value) || value < 0) throw new RaceResolutionError(code); return value; };
const requestFingerprint = (value) => typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
const requireCurrentObservation = (row, now, code) => {
  if (!time(now) || !row || row.verificationStatus !== "VERIFIED" || row.currentness !== "CURRENT" || !nonempty(row.authorityRef) || !nonempty(row.evidenceRef) || !time(row.observedAt) || !time(row.validUntil) || Date.parse(now) >= Date.parse(row.validUntil) || Date.parse(row.observedAt) > Date.parse(now)) throw new RaceResolutionError(code);
};

/** Pure owner-definition oracle. Input records represent host-verified facts; this does not verify runtime/store behavior. */
export function resolveAttemptRace(scenario, facts) {
  switch (scenario) {
    case "stale-fence":
      if (!Number.isSafeInteger(facts.observedFence) || facts.observedFence < 1 || !Number.isSafeInteger(facts.currentFence) || facts.currentFence < 1) throw new RaceResolutionError("UNKNOWN_FENCE");
      return facts.observedFence === facts.currentFence ? "ALLOW_CURRENT_FENCE" : "DENY_STALE_WRITE";
    case "death-after-dispatch-intent":
      {
        const intent = facts.dispatchIntent;
        if (intent?.durability !== "DURABLE" || !nonempty(intent.tenantId) || !nonempty(intent.jobId) || !nonempty(intent.attemptId)
          || !Number.isSafeInteger(intent.fencingToken) || intent.fencingToken <= 0 || !requestFingerprint(intent.requestFingerprint)
          || !nonempty(intent.evidenceRef) || facts.processStatus !== "TERMINATED") throw new RaceResolutionError("INVALID_SCENARIO_FACTS");
        const current = facts.expectedCurrentAttempt;
        if (!current || ![current.tenantId, current.jobId, current.attemptId].every(nonempty)
          || !Number.isSafeInteger(current.fencingToken) || current.fencingToken <= 0 || !requestFingerprint(current.requestFingerprint)) return "RETAIN_OUTCOME_UNKNOWN";
        if (intent.tenantId !== current.tenantId || intent.jobId !== current.jobId || intent.attemptId !== current.attemptId
          || intent.fencingToken !== current.fencingToken || intent.requestFingerprint !== current.requestFingerprint) return "RETAIN_OUTCOME_UNKNOWN";
        const outcome = facts.authoritativeOutcome;
        if (!outcome || !nonempty(facts.expectedOutcomeAuthorityRef) || !nonempty(facts.expectedOutcomeEvidenceRef)) return "RETAIN_OUTCOME_UNKNOWN";
        try { requireCurrentObservation(outcome, facts.now, "OUTCOME_EVIDENCE_UNKNOWN_OR_STALE"); }
        catch { return "RETAIN_OUTCOME_UNKNOWN"; }
        if (outcome.tenantId !== current.tenantId || outcome.jobId !== current.jobId || outcome.attemptId !== current.attemptId
          || outcome.fencingToken !== current.fencingToken || outcome.requestFingerprint !== current.requestFingerprint
          || outcome.authorityRef !== facts.expectedOutcomeAuthorityRef || outcome.evidenceRef !== facts.expectedOutcomeEvidenceRef
          || !["SUCCEEDED", "FAILED"].includes(outcome.disposition)) return "RETAIN_OUTCOME_UNKNOWN";
        return "RECONCILE_AUTHORITATIVE_RESULT";
      }
    case "missing-intent":
      if (facts.dispatchIntent?.durability === "DURABLE" || facts.effectBoundaryStatus !== "NOT_CROSSED") throw new RaceResolutionError("INVALID_SCENARIO_FACTS");
      return "DENY_DISPATCH";
    case "unknown-not-completed":
      if (facts.effectState === "NO_EFFECT_POSSIBLE") return "NO_EFFECT_RETRY_MAY_BE_CONSIDERED";
      if (facts.effectState !== "POSSIBLE_OR_UNKNOWN") throw new RaceResolutionError("UNKNOWN_EFFECT_STATE");
      if (facts.authoritativeOutcome) {
        const expected = facts.expectedOutcome;
        try {
          requireCurrentObservation(facts.authoritativeOutcome, facts.now, "OUTCOME_EVIDENCE_UNKNOWN_OR_STALE");
          if (expected && nonempty(expected.tenantId) && nonempty(expected.jobId) && nonempty(expected.attemptId) && Number.isSafeInteger(expected.fencingToken) && expected.fencingToken > 0 && requestFingerprint(expected.requestFingerprint) && requestFingerprint(facts.authoritativeOutcome.requestFingerprint) && nonempty(facts.expectedOutcomeAuthorityRef) && facts.authoritativeOutcome.tenantId === expected.tenantId && facts.authoritativeOutcome.jobId === expected.jobId && facts.authoritativeOutcome.attemptId === expected.attemptId && facts.authoritativeOutcome.fencingToken === expected.fencingToken && facts.authoritativeOutcome.requestFingerprint === expected.requestFingerprint && facts.authoritativeOutcome.authorityRef === facts.expectedOutcomeAuthorityRef && ["SUCCEEDED", "FAILED"].includes(facts.authoritativeOutcome.disposition)) return "RECONCILE_AUTHORITATIVE_RESULT";
        } catch { /* stale or malformed evidence remains unknown */ }
      }
      return "RETAIN_OUTCOME_UNKNOWN";
    case "cancel-ack-with-effect-live": {
      const cancel = facts.cancelRequestReceipt;
      if (!cancel || cancel.status !== "ACCEPTED" || !nonempty(cancel.requestId)) return "CANCEL_NOT_ACKNOWLEDGED";
      if (![cancel.tenantId, cancel.jobId, cancel.attemptId].every(nonempty) || !Number.isSafeInteger(cancel.fencingToken) || cancel.fencingToken < 1 || !nonempty(cancel.authorityRef) || !nonempty(cancel.evidenceRef)) throw new RaceResolutionError("CANCEL_RECEIPT_TUPLE_INVALID");
      const terminal = facts.terminationEvidence;
      if (!terminal || terminal.effectState !== "NO_FURTHER_EFFECT_POSSIBLE") return "CANCEL_REQUESTED_NOT_FINAL";
      requireCurrentObservation(terminal, facts.now, "TERMINATION_EVIDENCE_UNKNOWN_OR_STALE");
      if (![terminal.tenantId, terminal.jobId, terminal.attemptId, terminal.requestId, facts.expectedTerminationAuthorityRef].every(nonempty) || !Number.isSafeInteger(terminal.fencingToken) || terminal.fencingToken < 1 || terminal.tenantId !== cancel.tenantId || terminal.jobId !== cancel.jobId || terminal.attemptId !== cancel.attemptId || terminal.fencingToken !== cancel.fencingToken || terminal.requestId !== cancel.requestId || terminal.authorityRef !== facts.expectedTerminationAuthorityRef) throw new RaceResolutionError("TERMINATION_EVIDENCE_SCOPE_MISMATCH");
      return "CANCEL_CONFIRMED";
    }
    case "retry-same-attempt":
    case "retry-with-unknown-effect": {
      if (facts.priorState !== "RETRY_PENDING") throw new RaceResolutionError("RETRY_NOT_AUTHORIZED");
      const job = facts.job;
      const prior = facts.priorAttemptResolution;
      const policy = facts.retryPolicyDecision;
      const next = facts.newAttempt;
      if (!job || !prior || !policy || !next) throw new RaceResolutionError("RETRY_EVIDENCE_REQUIRED");
      if (!nonempty(job.tenantId) || !nonempty(job.jobId) || !nonempty(job.currentAttemptId) || !Number.isSafeInteger(job.currentFence) || job.currentFence < 1 || !time(job.deadlineAt) || !time(facts.now)) throw new RaceResolutionError("RETRY_CURRENT_TUPLE_INVALID");
      if (Date.parse(facts.now) >= Date.parse(job.deadlineAt)) throw new RaceResolutionError("RETRY_JOB_DEADLINE_EXPIRED");
      if (prior.tenantId !== job.tenantId || prior.jobId !== job.jobId || prior.attemptId !== job.currentAttemptId || prior.fencingToken !== job.currentFence || prior.authorityRef !== facts.expectedAttemptAuthorityRef) throw new RaceResolutionError("RETRY_PRIOR_ATTEMPT_SCOPE_MISMATCH");
      requireCurrentObservation(prior, facts.now, "RETRY_PRIOR_RESOLUTION_UNKNOWN_OR_STALE");
      if (!["NO_EFFECT", "AUTHORITATIVE_FAILURE_NO_EFFECT"].includes(prior.effectDisposition)) return "DENY_RETRY_UNRESOLVED_EFFECT";
      if (policy.tenantId !== job.tenantId || policy.jobId !== job.jobId || policy.currentAttemptId !== job.currentAttemptId || policy.fencingToken !== job.currentFence || policy.disposition !== "RETRY_ALLOWED" || !nonempty(policy.policyRef) || policy.authorityRef !== facts.expectedRetryPolicyAuthorityRef) throw new RaceResolutionError("RETRY_POLICY_SCOPE_OR_DECISION_INVALID");
      requireCurrentObservation(policy, facts.now, "RETRY_POLICY_UNKNOWN_OR_EXPIRED");
      if (!Number.isSafeInteger(policy.attemptOrdinal) || !Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.attemptOrdinal < 1 || policy.attemptOrdinal >= policy.maxAttempts) throw new RaceResolutionError("RETRY_BUDGET_EXHAUSTED");
      if (!nonempty(next.attemptId) || next.attemptId === job.currentAttemptId || !Number.isSafeInteger(next.fencingToken) || next.fencingToken <= job.currentFence) throw new RaceResolutionError("RETRY_IDENTITY_OR_FENCE_INVALID");
      if (scenario === "retry-with-unknown-effect") return "DENY_RETRY_UNRESOLVED_EFFECT";
      return "ALLOW_NEW_FENCED_ATTEMPT";
    }
    case "delivery-response-lost": {
      if (facts.effectState === "NO_EFFECT_POSSIBLE") return "NOT_DELIVERED_NO_EFFECT";
      if (facts.effectState !== "POSSIBLE_OR_UNKNOWN") throw new RaceResolutionError("UNKNOWN_EFFECT_STATE");
      if (!facts.expectedDelivery || ![facts.expectedDelivery.tenantId, facts.expectedDelivery.jobId, facts.expectedDelivery.outputVersionRef, facts.expectedDelivery.destinationRef, facts.expectedDelivery.requestId, facts.expectedDestinationAuthorityRef].every(nonempty) || !time(facts.now)) throw new RaceResolutionError("DELIVERY_EXPECTED_TUPLE_INVALID");
      const receipt = facts.destinationReceipt;
      if (!receipt) return "RETAIN_DELIVERY_OUTCOME_UNKNOWN";
      requireCurrentObservation(receipt, facts.now, "DESTINATION_RECEIPT_UNKNOWN_OR_STALE");
      const expected = facts.expectedDelivery;
      if (![receipt.tenantId, receipt.jobId, receipt.outputVersionRef, receipt.destinationRef, receipt.requestId].every(nonempty) || receipt.disposition !== "ACKNOWLEDGED" || receipt.authorityRef !== facts.expectedDestinationAuthorityRef || receipt.tenantId !== expected.tenantId || receipt.jobId !== expected.jobId || receipt.outputVersionRef !== expected.outputVersionRef || receipt.destinationRef !== expected.destinationRef || receipt.requestId !== expected.requestId) throw new RaceResolutionError("DESTINATION_RECEIPT_SCOPE_MISMATCH");
      return "DELIVERY_ACKNOWLEDGED";
    }
    default: throw new RaceResolutionError("UNKNOWN_SCENARIO");
  }
}
