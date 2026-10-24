import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { createPdp1InterfaceP0PinSuccessor } from '../scripts/refresh-pdp1-interface-p0-source-pin.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const reviewBytes = readFileSync(resolve(root, '.product-experience/interface-parity/current-source-review.json'));
const statusBytes = readFileSync(resolve(root, 'docs/implementation/pdp-0-phase-dev-status.json'));
const matrixBytes = readFileSync(resolve(root, 'docs/implementation/verification/pdp-38/pdp0-surface-phase-status-matrix.json'));
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

test('PDP-1 interface pin successor changes only the exact current PDP-0 status digest', () => {
  const result = createPdp1InterfaceP0PinSuccessor({ reviewBytes, statusBytes, matrixBytes, observedAt: '2026-10-23T12:00:00Z' });
  const before = JSON.parse(reviewBytes);
  const after = JSON.parse(result.nextReviewBytes);
  const sourcePath = 'docs/implementation/pdp-0-phase-dev-status.json';
  const beforePin = before.sources.find((item) => item.path === sourcePath);
  const afterPin = after.sources.find((item) => item.path === sourcePath);
  const matrixPath = 'docs/implementation/verification/pdp-38/pdp0-surface-phase-status-matrix.json';
  const beforeMatrixPin = before.sources.find((item) => item.path === matrixPath);
  const afterMatrixPin = after.sources.find((item) => item.path === matrixPath);
  beforePin.sha256 = afterPin.sha256;
  beforeMatrixPin.sha256 = afterMatrixPin.sha256;
  assert.equal(afterPin.sha256, sha(statusBytes));
  assert.equal(afterMatrixPin.sha256, sha(matrixBytes));
  assert.deepEqual(after, before);
  assert.equal(JSON.parse(result.impactBytes).classification, 'INTERNAL_SOURCE_PIN_REVIEW_REFRESH_NO_ADDITIONAL_PDP1_MEANING');
  assert.equal(sha(result.priorReviewBytes), sha(reviewBytes));
});

test('PDP-1 interface pin successor rejects stale or incomplete PDP-0 predecessor inputs', () => {
  const incomplete = structuredClone(JSON.parse(statusBytes));
  incomplete.outstandingMeaningIds = ['P0-unknown'];
  assert.throws(() => createPdp1InterfaceP0PinSuccessor({ reviewBytes, statusBytes: Buffer.from(JSON.stringify(incomplete)), matrixBytes }), /unresolved meaning/u);
  const notComplete = structuredClone(JSON.parse(statusBytes));
  notComplete.status = 'IN_PROGRESS';
  assert.throws(() => createPdp1InterfaceP0PinSuccessor({ reviewBytes, statusBytes: Buffer.from(JSON.stringify(notComplete)), matrixBytes }), /DEV_COMPLETE/u);
  const freshReview = structuredClone(JSON.parse(reviewBytes));
  freshReview.sources.find((item) => item.path === 'docs/implementation/pdp-0-phase-dev-status.json').sha256 = sha(statusBytes);
  assert.throws(() => createPdp1InterfaceP0PinSuccessor({ reviewBytes: Buffer.from(JSON.stringify(freshReview)), statusBytes, matrixBytes }), /stale PDP-0 predecessor pin/u);
});
