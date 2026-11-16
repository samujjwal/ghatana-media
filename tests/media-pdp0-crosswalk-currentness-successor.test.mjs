import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  buildPdp0CrosswalkCurrentnessSuccessor,
} from '../scripts/prepare-media-pdp0-crosswalk-currentness-successor.mjs';
import {PDP0_AUDIT_DISPOSITION_CROSSWALK_PATH} from '../scripts/check-media-pdp0-501-audit-dispositions.mjs';

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('PDP-0 crosswalk currentness candidate rebinds current source pins only', () => {
  const beforeBytes = fs.readFileSync(PDP0_AUDIT_DISPOSITION_CROSSWALK_PATH);
  const before = JSON.parse(beforeBytes.toString('utf8'));
  const result = buildPdp0CrosswalkCurrentnessSuccessor();
  const candidate = result.candidate;

  assert.equal(result.preimageSha256, sha256(beforeBytes));
  assert.deepEqual(candidate.rows, before.rows);
  assert.deepEqual(candidate.dispositionCounts, before.dispositionCounts);
  assert.deepEqual(candidate.coordinatorReview.reviewHistory, before.coordinatorReview.reviewHistory);
  assert.equal(candidate.coordinatorReview.decisionRef, 'PXD-225');
  assert.ok(candidate.rows.some(row => row.auditId === 'AUD-SPEC-002' && row.decisionRef?.id === 'PXD-226'));
  assert.equal(result.validation.total, 501);
  assert.equal(result.validation.original, 428);
  assert.equal(result.validation.focused, 73);
  assert.equal(result.validation.dispositionCounts.BOUND_EXISTING, 499);
  assert.equal(result.validation.dispositionCounts.POST_PDP_IMPLEMENTATION_ONLY, 2);
  assert.deepEqual(result.sourceDelta.map(row => row.sourceRef).filter(ref => ref.startsWith('tests/')).sort(), [
    'tests/pdp-migration-semantic-reconciliation.test.mjs',
    'tests/pdp-truth-domain-migration-199-owner-candidate.test.mjs',
  ]);
  assert.deepEqual(fs.readFileSync(PDP0_AUDIT_DISPOSITION_CROSSWALK_PATH), beforeBytes);
});
