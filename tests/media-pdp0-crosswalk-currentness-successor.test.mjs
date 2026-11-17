import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  buildPdp0CrosswalkCurrentnessSuccessor,
} from '../scripts/prepare-media-pdp0-crosswalk-currentness-successor.mjs';
import {PDP0_AUDIT_DISPOSITION_CROSSWALK_PATH} from '../scripts/check-media-pdp0-501-audit-dispositions.mjs';

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('PDP-0 crosswalk currentness successor is adopted and remains idempotent', () => {
  const currentBytes = fs.readFileSync(PDP0_AUDIT_DISPOSITION_CROSSWALK_PATH);
  const current = JSON.parse(currentBytes.toString('utf8'));
  const result = buildPdp0CrosswalkCurrentnessSuccessor();
  const candidate = result.candidate;

  assert.equal(result.preimageSha256, sha256(currentBytes));
  assert.deepEqual(candidate, current);
  assert.deepEqual(candidate.rows, current.rows);
  assert.deepEqual(candidate.dispositionCounts, current.dispositionCounts);
  assert.deepEqual(candidate.coordinatorReview.reviewHistory, current.coordinatorReview.reviewHistory);
  assert.equal(candidate.coordinatorReview.decisionRef, 'PXD-225');
  assert.ok(candidate.rows.some(row => row.auditId === 'AUD-SPEC-002' && row.decisionRef?.id === 'PXD-226'));
  assert.equal(result.validation.total, 501);
  assert.equal(result.validation.original, 428);
  assert.equal(result.validation.focused, 73);
  assert.equal(result.validation.dispositionCounts.BOUND_EXISTING, 499);
  assert.equal(result.validation.dispositionCounts.POST_PDP_IMPLEMENTATION_ONLY, 2);
  assert.deepEqual(result.sourceDelta, []);
  assert.deepEqual(fs.readFileSync(PDP0_AUDIT_DISPOSITION_CROSSWALK_PATH), currentBytes);
});
