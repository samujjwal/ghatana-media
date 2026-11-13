import test from 'node:test';
import assert from 'node:assert/strict';
import { STATUS, evaluateQualification, guardSuccessfulOutcome, loadRequirements } from '../scripts/optional-providers/qualification-gate.mjs';

const requirements = loadRequirements();
const ID = 'clamav-1.4.2';
const future = new Date(Date.now() + 86_400_000).toISOString();
const full = (p, identity = ID) => requirements[p].required.map((r) => ({ kind: r.kind, subjectIdentity: identity, expiresAt: future }));
const live = { reachable: true, identity: ID, devOnly: false };
const verify = () => true;

test('every required provider is covered by recorded blockers', () => {
  assert.deepEqual(Object.keys(requirements).sort(), ['document-intelligence', 'security-scanner', 'stt:en', 'stt:ne']);
  for (const r of Object.values(requirements)) for (const q of r.required) assert.ok(q.blockerOwner && q.detail);
});
test('unreachable provider is UNKNOWN, never admitted', () => {
  const r = evaluateQualification({ provider: 'security-scanner', requirements, probe: { reachable: false }, evidence: full('security-scanner'), verifyEvidence: verify });
  assert.equal(r.status, STATUS.UNKNOWN); assert.equal(r.clinicalOutcomeAllowed, false);
});
test('dev-only deterministic adapter is NOT_ADMITTED even with "complete" evidence', () => {
  const r = evaluateQualification({ provider: 'security-scanner', requirements, probe: { ...live, devOnly: true }, evidence: full('security-scanner'), verifyEvidence: verify });
  assert.equal(r.status, STATUS.NOT_ADMITTED); assert.equal(r.reasonCode, 'DEV_ONLY_ADAPTER');
});
test('no independent verifier means NOT_ADMITTED (cannot self-admit)', () => {
  const r = evaluateQualification({ provider: 'stt:ne', requirements, probe: live, evidence: full('stt:ne') });
  assert.equal(r.status, STATUS.NOT_ADMITTED); assert.equal(r.reasonCode, 'NO_INDEPENDENT_VERIFIER');
});
test('English evidence does not admit Nepali; each language is separate', () => {
  const r = evaluateQualification({ provider: 'stt:ne', requirements, probe: live, evidence: [], verifyEvidence: verify });
  assert.equal(r.status, STATUS.NOT_ADMITTED); assert.deepEqual(r.missing, ['model-rights', 'corpus-result', 'language-qualification']);
});
test('missing one evidence kind, expired, or bound to another identity => NOT_ADMITTED', () => {
  const ev = full('document-intelligence');
  assert.equal(evaluateQualification({ provider: 'document-intelligence', requirements, probe: live, evidence: ev.slice(1), verifyEvidence: verify }).status, STATUS.NOT_ADMITTED);
  assert.equal(evaluateQualification({ provider: 'document-intelligence', requirements, probe: live, evidence: ev.map((e) => ({ ...e, expiresAt: '2000-01-01T00:00:00Z' })), verifyEvidence: verify }).status, STATUS.NOT_ADMITTED);
  assert.equal(evaluateQualification({ provider: 'document-intelligence', requirements, probe: live, evidence: full('document-intelligence', 'other-engine'), verifyEvidence: verify }).status, STATUS.NOT_ADMITTED);
});
test('rejecting or throwing verifier => never admitted', () => {
  const ev = full('security-scanner');
  assert.equal(evaluateQualification({ provider: 'security-scanner', requirements, probe: live, evidence: ev, verifyEvidence: () => false }).status, STATUS.NOT_ADMITTED);
  assert.equal(evaluateQualification({ provider: 'security-scanner', requirements, probe: live, evidence: ev, verifyEvidence: () => { throw new Error('x'); } }).status, STATUS.UNKNOWN);
});
test('only fully verified, unexpired, identity-bound evidence admits', () => {
  const r = evaluateQualification({ provider: 'security-scanner', requirements, probe: live, evidence: full('security-scanner'), verifyEvidence: verify });
  assert.equal(r.status, STATUS.ADMITTED); assert.equal(r.clinicalOutcomeAllowed, true);
});
test('successful outcomes are withheld unless admitted', () => {
  const na = evaluateQualification({ provider: 'security-scanner', requirements, probe: live, evidence: [], verifyEvidence: verify });
  const unk = evaluateQualification({ provider: 'security-scanner', requirements, probe: { reachable: false } });
  assert.deepEqual(guardSuccessfulOutcome(na, { verdict: 'CLEAN' }), { status: 'NOT_ADMITTED', reasonCode: 'EVIDENCE_MISSING_OR_STALE', outcomeWithheld: true });
  assert.equal(guardSuccessfulOutcome(unk, { verdict: 'CLEAN' }).status, 'UNKNOWN');
  assert.equal(guardSuccessfulOutcome(undefined, 'x').outcomeWithheld, true);
  assert.deepEqual(guardSuccessfulOutcome({ status: 'ADMITTED', clinicalOutcomeAllowed: true }, { verdict: 'CLEAN' }), { verdict: 'CLEAN' });
});
