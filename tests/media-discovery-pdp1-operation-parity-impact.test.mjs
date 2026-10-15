import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  pdp1OwnerStatusJoinObservation,
  validatePdp1OperationParityProjectionImpact,
} from '../scripts/record-media-discovery-pdp1-phase-exit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const impactPath = 'docs/implementation/observations/media-discovery-pdp1-operation-parity-projection-impact-2026-10-14-r1.json';
const impactTestPath = 'tests/media-discovery-pdp1-operation-parity-impact.test.mjs';
const readImpact = () => JSON.parse(fs.readFileSync(path.join(root, impactPath), 'utf8'));
const fileDigest = (sourcePath) => `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, sourcePath))).digest('hex')}`;

test('PDP-1 owner-status join carries the validated source-bound operation-parity successor', () => {
  const r16 = JSON.parse(fs.readFileSync(path.join(root,
    'docs/implementation/observations/media-discovery-pdp1-exit-current-cut-r16.json'), 'utf8'));
  const observedDigests = Object.fromEntries(Object.keys(r16.sourceCurrentness.sourceContentDigests)
    .map((sourcePath) => [sourcePath, fileDigest(sourcePath)]));
  const interfaceReviewTest = 'tests/pdp1-interface-current-source-review.test.mjs';
  const testRun = {
    startedHead: 'fixture-head',
    completedHead: 'fixture-head',
    sourceBinding: {
      stable: true,
      testInputContentDigests: {
        [interfaceReviewTest]: fileDigest(interfaceReviewTest),
        [impactTestPath]: fileDigest(impactTestPath),
      },
    },
    testOutcomes: [
      { command: 'node --test tests/media-pdp-p1-dev-status.test.mjs tests/media-contract-parity.test.mjs tests/media-contract-parity-definition-only-cli.test.mjs tests/pdp1-owner-action-wire-contracts.test.mjs tests/pdp1-transition-guard-definition-evaluator.test.mjs tests/pdp-truth-domain-typed-observations.test.mjs tests/media-pdp1-mdc30-owner-result-bindings.test.mjs tests/pdp1-operation-current-source-review.test.mjs tests/pdp1-interface-current-source-review.test.mjs tests/media-discovery-pdp1-c22-impact.test.mjs tests/media-discovery-pdp1-capture-source-chains.test.mjs tests/media-discovery-pdp1-three-review-source-transition.test.mjs tests/media-discovery-pdp1-supplemental-owner-status-join.test.mjs', status: 'PASS', exitCode: 0, testCount: 1, passedCount: 1, failedCount: 0, skippedCount: 0 },
      { command: `node --test ${impactTestPath}`, status: 'PASS', exitCode: 0, testCount: 3, passedCount: 3, failedCount: 0, skippedCount: 0 },
    ],
  };
  const join = pdp1OwnerStatusJoinObservation(observedDigests, `sha256:${'c'.repeat(64)}`, testRun);
  assert.equal(join.operationParityProjectionImpact.valid, true, JSON.stringify(join.operationParityProjectionImpact));
  assert.equal(join.operationParityProjectionImpact.testEvidenceValid, true);
  assert.equal(join.interfaceReviewSuccessorChain.operationParityProjectionImpact.valid, true);
});

test('PDP-1 operation-parity successor is bound to the exact R19 projection and review refreshes', () => {
  const result = validatePdp1OperationParityProjectionImpact();
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.rowChecks.length, 4);
  assert.ok(result.rowChecks.every((row) => row.valid));
  assert.equal(result.ownerAcceptance, 'NOT_CLAIMED');
  assert.equal(result.independentAcceptance, 'NOT_CLAIMED');
  assert.equal(result.lifecycleClosure, 'NOT_ENTERED');
  assert.equal(result.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(result.delivery, 'BLOCKED');
  assert.equal(result.release, 'NOT_AUTHORIZED');
});

test('PDP-1 operation-parity successor rejects an unrelated path, predecessor, observed digest, or meaning change', () => {
  const base = readImpact();
  for (const mutate of [
    (record) => { record.sourceDeltas[0].path = '.product-experience/pdp-1-domain-data/operations.yaml'; },
    (record) => { record.sourceDeltas[0].predecessorSha256 = `sha256:${'0'.repeat(64)}`; },
    (record) => { record.sourceDeltas[1].observedSha256 = `sha256:${'1'.repeat(64)}`; },
    (record) => { record.sourceDeltas[2].meaningIdsChanged = ['invented-meaning']; },
    (record) => { delete record.sourceDeltas[0].path; },
    (record) => { delete record.sourceDeltas[1].predecessorSha256; },
    (record) => { delete record.sourceDeltas[2].observedSha256; },
    (record) => { delete record.sourceDeltas[3].pdp1MeaningDisposition; },
    (record) => { delete record.sourceDeltas[3].meaningIdsChanged; },
    (record) => { record.sourceDeltas.push({ ...record.sourceDeltas[0] }); },
    (record) => { record.decision.ownerAcceptance = 'ACCEPTED'; },
  ]) {
    const candidate = structuredClone(base);
    mutate(candidate);
    assert.equal(validatePdp1OperationParityProjectionImpact(candidate).valid, false);
  }
  const wrongObserved = validatePdp1OperationParityProjectionImpact(base, {
    observedDigests: { '.product-experience/interface-parity/operation-parity.yaml': `sha256:${'2'.repeat(64)}` },
  });
  assert.equal(wrongObserved.valid, false);

  const wrongPxd164Review = validatePdp1OperationParityProjectionImpact(base, {
    observedDigests: { '.product-experience/pdp-1-domain-data/operations-current-source-review.json': `sha256:${'3'.repeat(64)}` },
  });
  assert.equal(wrongPxd164Review.valid, false, 'caller-supplied review hash must not be replaced by the exact live-byte fallback');
});
