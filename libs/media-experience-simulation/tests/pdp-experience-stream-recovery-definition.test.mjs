import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateStreamRecoveryDefinition } from '../dist/index.js';

const base = {
  sessionState: 'DEGRADED', tenantId: 'tenant-a', sessionId: 'session-1', ownerId: 'owner-1',
  consentId: 'consent-7', consentRevision: 'rev-3', consentPurpose: 'live-analysis',
  lease: { tenantId: 'tenant-a', sessionId: 'session-1', ownerId: 'owner-1', fencingToken: 'fence-9', disposition: 'CURRENT' },
  consent: { tenantId: 'tenant-a', sessionId: 'session-1', consentId: 'consent-7', revision: 'rev-3', purpose: 'live-analysis', disposition: 'ACTIVE' },
  recoveryBudget: { tenantId: 'tenant-a', sessionId: 'session-1', policyRef: 'media.policy.stream.reconnect-budget.v1', disposition: 'CURRENT', remainingReconnectRequests: 2, deadlineEpochMilliseconds: 5000, observedAtEpochMilliseconds: 1000 },
  lastAcknowledgedFrameSequence: 17, reconnectSequence: 18,
  unresolvedFrameEffects: [
    { tenantId: 'tenant-a', sessionId: 'session-1', sequence: 16, evidence: 'ACKNOWLEDGED' },
    { tenantId: 'tenant-a', sessionId: 'session-1', sequence: 17, evidence: 'REJECTED' },
  ],
};

test('J-29 recovery definition requires exact current consent, lease, identity, sequence fence, and resolved frame effects', () => {
  assert.deepEqual(evaluateStreamRecoveryDefinition(base), {
    disposition: 'RECONNECT_REQUEST_ELIGIBLE', reason: 'CURRENT_CONSENT_LEASE_AND_SEQUENCE_FENCE',
    frameEffects: ['ACKNOWLEDGED', 'REJECTED'], dispatchAllowed: false,
  });
});

test('J-29 revoked/expired consent, stale lease, unknown frame outcome, mismatched identity, and sequence gaps never dispatch', () => {
  for (const [patch, reason] of [
    [{ consent: { ...base.consent, disposition: 'REVOKED' } }, 'CONSENT_NOT_CURRENT'],
    [{ consent: { ...base.consent, disposition: 'EXPIRED' } }, 'CONSENT_NOT_CURRENT'],
    [{ lease: { ...base.lease, disposition: 'EXPIRED' } }, 'LEASE_NOT_CURRENT'],
    [{ unresolvedFrameEffects: [{ ...base.unresolvedFrameEffects[0], evidence: 'UNKNOWN' }] }, 'UNRESOLVED_FRAME_EFFECT'],
    [{ unresolvedFrameEffects: [{ ...base.unresolvedFrameEffects[0], tenantId: 'tenant-b' }] }, 'FRAME_IDENTITY_MISMATCHED'],
    [{ reconnectSequence: 19 }, 'SEQUENCE_NOT_FENCED'],
    [{ sessionState: 'CONNECTED' }, 'SESSION_NOT_RECONNECTABLE'],
    [{ consent: { ...base.consent, sessionId: 'session-other' } }, 'CONSENT_BINDING_MISSING_OR_MISMATCHED'],
    [{ lease: { ...base.lease, sessionId: 'session-other' } }, 'LEASE_BINDING_MISSING_OR_MISMATCHED'],
  ]) {
    const result = evaluateStreamRecoveryDefinition({ ...base, ...patch });
    assert.equal(result.disposition, 'FENCE_AND_HOLD');
    assert.equal(result.reason, reason);
    assert.equal(result.dispatchAllowed, false);
  }
});

test('J-29 contradictory evidence or acknowledgement beyond the supplied fence holds recovery', () => {
  const conflictingEvidence = evaluateStreamRecoveryDefinition({
    ...base,
    unresolvedFrameEffects: [
      { tenantId: 'tenant-a', sessionId: 'session-1', sequence: 17, evidence: 'ACKNOWLEDGED' },
      { tenantId: 'tenant-a', sessionId: 'session-1', sequence: 17, evidence: 'REJECTED' },
    ],
  });
  assert.equal(conflictingEvidence.disposition, 'FENCE_AND_HOLD');
  assert.equal(conflictingEvidence.reason, 'CONFLICTING_FRAME_EVIDENCE');
  assert.equal(conflictingEvidence.dispatchAllowed, false);

  const acknowledgementAheadOfFence = evaluateStreamRecoveryDefinition({
    ...base,
    unresolvedFrameEffects: [
      { tenantId: 'tenant-a', sessionId: 'session-1', sequence: 18, evidence: 'ACKNOWLEDGED' },
    ],
  });
  assert.equal(acknowledgementAheadOfFence.disposition, 'FENCE_AND_HOLD');
  assert.equal(acknowledgementAheadOfFence.reason, 'ACKNOWLEDGEMENT_AHEAD_OF_FENCE');
  assert.equal(acknowledgementAheadOfFence.dispatchAllowed, false);
});

test('J-29 reconnect requires exact current scoped budget with safe positive allowance and live deadline', () => {
  for (const [patch, reason] of [
    [{ recoveryBudget: null }, 'RECOVERY_BUDGET_MISSING_OR_MISMATCHED'],
    [{ recoveryBudget: { ...base.recoveryBudget, tenantId: 'tenant-b' } }, 'RECOVERY_BUDGET_MISSING_OR_MISMATCHED'],
    [{ recoveryBudget: { ...base.recoveryBudget, policyRef: 'other-policy' } }, 'RECOVERY_BUDGET_MISSING_OR_MISMATCHED'],
    [{ recoveryBudget: { ...base.recoveryBudget, disposition: 'UNKNOWN' } }, 'RECOVERY_BUDGET_NOT_CURRENT'],
    [{ recoveryBudget: { ...base.recoveryBudget, disposition: 'EXHAUSTED', remainingReconnectRequests: 0 } }, 'RECOVERY_BUDGET_EXHAUSTED'],
    [{ recoveryBudget: { ...base.recoveryBudget, remainingReconnectRequests: 0 } }, 'RECOVERY_BUDGET_EXHAUSTED'],
    [{ recoveryBudget: { ...base.recoveryBudget, disposition: 'EXPIRED' } }, 'RECOVERY_BUDGET_EXPIRED'],
    [{ recoveryBudget: { ...base.recoveryBudget, deadlineEpochMilliseconds: 1000 } }, 'RECOVERY_BUDGET_EXPIRED'],
    [{ recoveryBudget: { ...base.recoveryBudget, remainingReconnectRequests: Number.MAX_SAFE_INTEGER + 1 } }, 'RECOVERY_BUDGET_INVALID'],
    [{ recoveryBudget: { ...base.recoveryBudget, remainingReconnectRequests: 1.5 } }, 'RECOVERY_BUDGET_INVALID'],
    [{ recoveryBudget: { ...base.recoveryBudget, deadlineEpochMilliseconds: Number.POSITIVE_INFINITY } }, 'RECOVERY_BUDGET_INVALID'],
  ]) {
    const result = evaluateStreamRecoveryDefinition({ ...base, ...patch });
    assert.equal(result.disposition, 'FENCE_AND_HOLD');
    assert.equal(result.reason, reason);
    assert.equal(result.dispatchAllowed, false);
  }
});

test('J-29 a rejected next frame does not advance the acknowledged sequence', () => {
  const result = evaluateStreamRecoveryDefinition({
    ...base,
    lastAcknowledgedFrameSequence: 17,
    reconnectSequence: 18,
    unresolvedFrameEffects: [
      { tenantId: 'tenant-a', sessionId: 'session-1', sequence: 18, evidence: 'REJECTED' },
    ],
  });
  assert.equal(result.disposition, 'RECONNECT_REQUEST_ELIGIBLE');
  assert.equal(result.dispatchAllowed, false);
});

test('J-29 missing identities, malformed enums/sequences, and terminal states never claim recovery', () => {
  assert.equal(evaluateStreamRecoveryDefinition({ ...base, sessionId: null }).reason, 'IDENTITY_BINDING_MISSING_OR_MISMATCHED');
  assert.equal(evaluateStreamRecoveryDefinition({ ...base, lastAcknowledgedFrameSequence: Number.MAX_SAFE_INTEGER }).reason, 'SEQUENCE_NOT_FENCED');
  assert.equal(evaluateStreamRecoveryDefinition({ ...base, lastAcknowledgedFrameSequence: Number.MAX_SAFE_INTEGER + 1 }).reason, 'INVALID_NUMERIC_SEQUENCE_OR_ENUM');
  assert.equal(evaluateStreamRecoveryDefinition({ ...base, reconnectSequence: Number.POSITIVE_INFINITY }).reason, 'INVALID_NUMERIC_SEQUENCE_OR_ENUM');
  assert.equal(evaluateStreamRecoveryDefinition({ ...base, sessionState: 'SUSPENDED' }).reason, 'INVALID_NUMERIC_SEQUENCE_OR_ENUM');
  assert.equal(evaluateStreamRecoveryDefinition({ ...base, unresolvedFrameEffects: [{ ...base.unresolvedFrameEffects[0], evidence: 'ACK_LIKE' }] }).reason, 'INVALID_NUMERIC_SEQUENCE_OR_ENUM');
  assert.equal(evaluateStreamRecoveryDefinition({ ...base, sessionState: 'CLOSED' }).reason, 'SESSION_TERMINAL');
});
