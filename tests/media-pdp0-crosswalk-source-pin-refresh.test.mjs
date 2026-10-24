import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createPdp0CrosswalkSourcePinSuccessor} from '../scripts/refresh-media-pdp0-crosswalk-source-pins.mjs';
import {currentPdp0PhaseScopedSourceFingerprints} from '../scripts/check-media-pdp0-501-audit-dispositions.mjs';

const original = fs.readFileSync('docs/implementation/observations/media-pdp0-crosswalk-source-pin-refresh-2026-10-23-r1-predecessor.json');

test('PDP-0 crosswalk source-pin successor refreshes only the current PXD-225 projection', () => {
  const sourcePins = currentPdp0PhaseScopedSourceFingerprints('PXD-225');
  const result = createPdp0CrosswalkSourcePinSuccessor({crosswalkBytes: original, sourcePins});
  const before = JSON.parse(original.toString('utf8'));
  const after = JSON.parse(result.nextBytes.toString('utf8'));
  assert.deepEqual(after.rows, before.rows);
  assert.deepEqual(after.coordinatorReview.reviewHistory, before.coordinatorReview.reviewHistory);
  assert.deepEqual(after.sourceBaseline.phaseScopedSourceFingerprintsSha256, sourcePins);
  assert.deepEqual(after.coordinatorReview.sourceFingerprints, sourcePins);
  assert.deepEqual(after.coordinatorReview.phaseScopedSourceFingerprintsSha256, sourcePins);
  const impact = JSON.parse(result.impactBytes.toString('utf8'));
  assert.deepEqual(impact.semanticRowDelta, []);
  assert.deepEqual(impact.sourceDelta.map(row => row.path), ['.product-experience/source-manifest.yaml#PDP-0-projection']);
  assert.equal(impact.boundaries.ownerApproval, 'NOT_CLAIMED');
  assert.equal(impact.boundaries.independentAcceptance, 'NOT_CLAIMED');
});

test('PDP-0 crosswalk source-pin successor rejects unexpected source or semantic drift', () => {
  const pins = currentPdp0PhaseScopedSourceFingerprints('PXD-225');
  assert.throws(() => createPdp0CrosswalkSourcePinSuccessor({crosswalkBytes: original, sourcePins: {...pins, 'unknown-source': 'a'.repeat(64)}}), /expected PXD-225/u);
  const changed = JSON.parse(original.toString('utf8'));
  changed.coordinatorReview.ownerApproval = 'APPROVED';
  assert.throws(() => createPdp0CrosswalkSourcePinSuccessor({crosswalkBytes: Buffer.from(JSON.stringify(changed)), sourcePins: pins}), /PXD-225 currentness predecessor/u);
});
