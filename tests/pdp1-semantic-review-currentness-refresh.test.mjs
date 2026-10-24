import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { createPdp1SemanticReviewPinSuccessor } from '../scripts/refresh-pdp1-semantic-review-predecessor-pins.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const bytes = (path) => readFileSync(resolve(root, path));
const input = {
  reviewBytes: bytes('docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json'),
  sourceReviewBytes: bytes('.product-experience/interface-parity/current-source-review.json'),
  statusBytes: bytes('docs/implementation/pdp-0-phase-dev-status.json'),
  matrixBytes: bytes('docs/implementation/verification/pdp-38/pdp0-surface-phase-status-matrix.json'),
};

test('PDP-1 semantic review successor rebinds only the exact PDP-0 and interface review source pins', () => {
  const result = createPdp1SemanticReviewPinSuccessor(input);
  const before = JSON.parse(input.reviewBytes);
  const after = JSON.parse(result.reviewBytes);
  const targets = [
    '.product-experience/interface-parity/current-source-review.json',
    'docs/implementation/pdp-0-phase-dev-status.json',
    'docs/implementation/verification/pdp-38/pdp0-surface-phase-status-matrix.json',
  ];
  for (const target of targets) {
    assert.equal(after.sourceFingerprints[target], target === targets[0]
      ? requireDigest(input.sourceReviewBytes) : target === targets[1] ? requireDigest(input.statusBytes) : requireDigest(input.matrixBytes));
    before.sourceFingerprints[target] = after.sourceFingerprints[target];
  }
  before.currentSourceCutDeltaReview.currentnessRefreshHistory = after.currentSourceCutDeltaReview.currentnessRefreshHistory;
  before.currentSourceCutDeltaReview.currentnessRefreshSuccessor = after.currentSourceCutDeltaReview.currentnessRefreshSuccessor;
  assert.deepEqual(after, before);
  const impact = JSON.parse(result.impactBytes);
  assert.equal(impact.semanticFindingsChanged.length, 0);
  assert.equal(impact.fullDenominator.sourceIdentities, 2040);
});

test('PDP-1 semantic review successor rejects changed meaning or a source cut outside the R8 predecessor', () => {
  const changedMeaning = JSON.parse(input.reviewBytes);
  changedMeaning.outstandingMeaningIds = ['invented'];
  assert.throws(() => createPdp1SemanticReviewPinSuccessor({ ...input, reviewBytes: Buffer.from(JSON.stringify(changedMeaning)) }), /full-denominator/u);
  const wrongSourceReview = Buffer.from(input.sourceReviewBytes.toString().replace('media.pdp1-interface-current-source-review.v1', 'unknown'));
  assert.throws(() => createPdp1SemanticReviewPinSuccessor({ ...input, sourceReviewBytes: wrongSourceReview }), /interface review/u);
});

function requireDigest(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}
