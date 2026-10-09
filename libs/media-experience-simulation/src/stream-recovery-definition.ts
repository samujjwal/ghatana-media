export type StreamConsentState = "ACTIVE" | "REVOKED" | "EXPIRED" | "SUPERSEDED" | "PENDING_VERIFICATION" | "UNKNOWN";
export type StreamLeaseState = "CURRENT" | "EXPIRED" | "FENCED" | "UNKNOWN";
export type StreamSessionState = "OPEN" | "CONNECTED" | "DEGRADED" | "DRAINING" | "CLOSED" | "FAILED" | "UNKNOWN";
export type FrameEffectEvidence = "ACKNOWLEDGED" | "REJECTED" | "UNKNOWN";

export interface StreamRecoveryDefinitionInput {
  readonly sessionState: StreamSessionState;
  readonly tenantId: string | null;
  readonly sessionId: string | null;
  readonly ownerId: string | null;
  readonly consentId: string | null;
  readonly consentRevision: string | null;
  readonly consentPurpose: string | null;
  readonly lease: {
    readonly tenantId: string;
    readonly sessionId: string;
    readonly ownerId: string;
    readonly fencingToken: string;
    readonly disposition: StreamLeaseState;
  } | null;
  readonly consent: {
    readonly tenantId: string;
    readonly sessionId: string;
    readonly consentId: string;
    readonly revision: string;
    readonly purpose: string;
    readonly disposition: StreamConsentState;
  } | null;
  readonly recoveryBudget: {
    readonly tenantId: string;
    readonly sessionId: string;
    readonly policyRef: string;
    readonly disposition: "CURRENT" | "EXHAUSTED" | "EXPIRED" | "UNKNOWN";
    readonly remainingReconnectRequests: number;
    readonly deadlineEpochMilliseconds: number;
    readonly observedAtEpochMilliseconds: number;
  } | null;
  readonly lastAcknowledgedFrameSequence: number | null;
  readonly reconnectSequence: number | null;
  readonly unresolvedFrameEffects: readonly {
    readonly tenantId: string;
    readonly sessionId: string;
    readonly sequence: number;
    readonly evidence: FrameEffectEvidence;
  }[];
}

export type StreamRecoveryDefinitionResult =
  | { readonly disposition: "OBSERVE_ONLY"; readonly reason: "CURRENT_SESSION_FACTS_REQUIRED" | "SESSION_TERMINAL" | "IDENTITY_BINDING_MISSING_OR_MISMATCHED" | "INVALID_NUMERIC_SEQUENCE_OR_ENUM"; readonly frameEffects: readonly FrameEffectEvidence[]; readonly dispatchAllowed: false }
  | { readonly disposition: "FENCE_AND_HOLD"; readonly reason: "CONSENT_NOT_CURRENT" | "CONSENT_BINDING_MISSING_OR_MISMATCHED" | "LEASE_NOT_CURRENT" | "LEASE_BINDING_MISSING_OR_MISMATCHED" | "SESSION_NOT_RECONNECTABLE" | "UNRESOLVED_FRAME_EFFECT" | "FRAME_IDENTITY_MISMATCHED" | "SEQUENCE_NOT_FENCED" | "CONFLICTING_FRAME_EVIDENCE" | "ACKNOWLEDGEMENT_AHEAD_OF_FENCE" | "RECOVERY_BUDGET_MISSING_OR_MISMATCHED" | "RECOVERY_BUDGET_NOT_CURRENT" | "RECOVERY_BUDGET_EXHAUSTED" | "RECOVERY_BUDGET_EXPIRED" | "RECOVERY_BUDGET_INVALID"; readonly frameEffects: readonly FrameEffectEvidence[]; readonly dispatchAllowed: false }
  | { readonly disposition: "RECONNECT_REQUEST_ELIGIBLE"; readonly reason: "CURRENT_CONSENT_LEASE_AND_SEQUENCE_FENCE"; readonly frameEffects: readonly FrameEffectEvidence[]; readonly dispatchAllowed: false };

const sessionStates = new Set<StreamSessionState>(["OPEN", "CONNECTED", "DEGRADED", "DRAINING", "CLOSED", "FAILED", "UNKNOWN"]);
const leaseStates = new Set<StreamLeaseState>(["CURRENT", "EXPIRED", "FENCED", "UNKNOWN"]);
const consentStates = new Set<StreamConsentState>(["ACTIVE", "REVOKED", "EXPIRED", "SUPERSEDED", "PENDING_VERIFICATION", "UNKNOWN"]);
const frameStates = new Set<FrameEffectEvidence>(["ACKNOWLEDGED", "REJECTED", "UNKNOWN"]);
const budgetStates = new Set(["CURRENT", "EXHAUSTED", "EXPIRED", "UNKNOWN"]);
const validSequence = (value: number | null): value is number => value !== null && Number.isSafeInteger(value) && value >= 0;
const validSafeNonnegativeInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const validEpochMilliseconds = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const nonEmpty = (value: string | null): value is string => typeof value === "string" && value.trim().length > 0;

/**
 * Definition-only live-stream recovery oracle. It classifies supplied facts and
 * never opens/reconnects a stream, dispatches a frame, infers consent currentness,
 * or turns an unknown provider outcome into success/failure.
 */
export function evaluateStreamRecoveryDefinition(input: StreamRecoveryDefinitionInput): StreamRecoveryDefinitionResult {
  const frameEffects = Array.isArray(input.unresolvedFrameEffects)
    ? input.unresolvedFrameEffects.map((frame) => frame && frameStates.has(frame.evidence) ? frame.evidence : "UNKNOWN")
    : [];
  const observe = (reason: Extract<StreamRecoveryDefinitionResult, { disposition: "OBSERVE_ONLY" }>["reason"]): StreamRecoveryDefinitionResult => ({ disposition: "OBSERVE_ONLY", reason, frameEffects, dispatchAllowed: false });
  const hold = (reason: Extract<StreamRecoveryDefinitionResult, { disposition: "FENCE_AND_HOLD" }>["reason"]): StreamRecoveryDefinitionResult => ({ disposition: "FENCE_AND_HOLD", reason, frameEffects, dispatchAllowed: false });

  if (!sessionStates.has(input.sessionState) || !Array.isArray(input.unresolvedFrameEffects) || input.unresolvedFrameEffects.some((frame) => !frame || !frameStates.has(frame.evidence))) {
    return observe("INVALID_NUMERIC_SEQUENCE_OR_ENUM");
  }
  if ((input.lastAcknowledgedFrameSequence !== null && !validSequence(input.lastAcknowledgedFrameSequence)) ||
      (input.reconnectSequence !== null && !validSequence(input.reconnectSequence)) ||
      input.unresolvedFrameEffects.some((frame) => !validSequence(frame.sequence))) {
    return observe("INVALID_NUMERIC_SEQUENCE_OR_ENUM");
  }
  if (input.sessionState === "CLOSED" || input.sessionState === "FAILED") return observe("SESSION_TERMINAL");
  if (!nonEmpty(input.tenantId) || !nonEmpty(input.sessionId) || !nonEmpty(input.ownerId)) return observe("IDENTITY_BINDING_MISSING_OR_MISMATCHED");
  if (input.sessionState === "UNKNOWN" || input.lastAcknowledgedFrameSequence === null) return observe("CURRENT_SESSION_FACTS_REQUIRED");

  if (!input.lease) return hold("LEASE_BINDING_MISSING_OR_MISMATCHED");
  if (input.lease.tenantId !== input.tenantId || input.lease.sessionId !== input.sessionId || input.lease.ownerId !== input.ownerId || !nonEmpty(input.lease.fencingToken)) return hold("LEASE_BINDING_MISSING_OR_MISMATCHED");
  if (!leaseStates.has(input.lease.disposition) || input.lease.disposition !== "CURRENT") return hold("LEASE_NOT_CURRENT");

  if (!input.consent) return hold("CONSENT_BINDING_MISSING_OR_MISMATCHED");
  if (input.consent.tenantId !== input.tenantId || input.consent.sessionId !== input.sessionId || input.consent.consentId !== input.consentId || input.consent.revision !== input.consentRevision || input.consent.purpose !== input.consentPurpose || !nonEmpty(input.consentId) || !nonEmpty(input.consentRevision) || !nonEmpty(input.consentPurpose)) return hold("CONSENT_BINDING_MISSING_OR_MISMATCHED");
  if (!consentStates.has(input.consent.disposition) || input.consent.disposition !== "ACTIVE") return hold("CONSENT_NOT_CURRENT");

  if (!input.recoveryBudget) return hold("RECOVERY_BUDGET_MISSING_OR_MISMATCHED");
  if (input.recoveryBudget.tenantId !== input.tenantId || input.recoveryBudget.sessionId !== input.sessionId || input.recoveryBudget.policyRef !== "media.policy.stream.reconnect-budget.v1") return hold("RECOVERY_BUDGET_MISSING_OR_MISMATCHED");
  if (!budgetStates.has(input.recoveryBudget.disposition)) return hold("RECOVERY_BUDGET_INVALID");
  if (!validSafeNonnegativeInteger(input.recoveryBudget.remainingReconnectRequests) ||
      !validEpochMilliseconds(input.recoveryBudget.deadlineEpochMilliseconds) ||
      !validEpochMilliseconds(input.recoveryBudget.observedAtEpochMilliseconds)) return hold("RECOVERY_BUDGET_INVALID");
  if (input.recoveryBudget.disposition === "UNKNOWN") return hold("RECOVERY_BUDGET_NOT_CURRENT");
  if (input.recoveryBudget.disposition === "EXHAUSTED" || input.recoveryBudget.remainingReconnectRequests === 0) return hold("RECOVERY_BUDGET_EXHAUSTED");
  if (input.recoveryBudget.disposition === "EXPIRED" || input.recoveryBudget.deadlineEpochMilliseconds <= input.recoveryBudget.observedAtEpochMilliseconds) return hold("RECOVERY_BUDGET_EXPIRED");
  if (input.recoveryBudget.disposition !== "CURRENT") return hold("RECOVERY_BUDGET_NOT_CURRENT");

  if (input.sessionState !== "DEGRADED") return hold("SESSION_NOT_RECONNECTABLE");
  if (input.unresolvedFrameEffects.some((frame) => frame.tenantId !== input.tenantId || frame.sessionId !== input.sessionId)) return hold("FRAME_IDENTITY_MISMATCHED");
  if (input.unresolvedFrameEffects.some((frame) => frame.evidence === "UNKNOWN")) return hold("UNRESOLVED_FRAME_EFFECT");
  const evidenceBySequence = new Map<number, FrameEffectEvidence>();
  for (const frame of input.unresolvedFrameEffects) {
    const previousEvidence = evidenceBySequence.get(frame.sequence);
    if (previousEvidence !== undefined && previousEvidence !== frame.evidence) return hold("CONFLICTING_FRAME_EVIDENCE");
    evidenceBySequence.set(frame.sequence, frame.evidence);
  }
  if (input.unresolvedFrameEffects.some((frame) => frame.evidence === "ACKNOWLEDGED" && frame.sequence > input.lastAcknowledgedFrameSequence!)) return hold("ACKNOWLEDGEMENT_AHEAD_OF_FENCE");
  if (input.reconnectSequence === null || input.lastAcknowledgedFrameSequence === Number.MAX_SAFE_INTEGER || input.reconnectSequence !== input.lastAcknowledgedFrameSequence + 1) return hold("SEQUENCE_NOT_FENCED");
  return { disposition: "RECONNECT_REQUEST_ELIGIBLE", reason: "CURRENT_CONSENT_LEASE_AND_SEQUENCE_FENCE", frameEffects, dispatchAllowed: false };
}
