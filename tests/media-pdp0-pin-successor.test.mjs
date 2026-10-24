import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPdp0PinSuccessor, assertPdp0PinSuccessor} from '../scripts/lib/media-pdp0-pin-successor.mjs';

const sha = char => char.repeat(64);
const materialRefs = Array.from({length: 9}, (_, i) => `material-${i}.yaml`);
const selectorRef = '.product-experience/decision-log.md#PXD-225-section';
const targetRefs = [...materialRefs, selectorRef];

function fixture() {
  const sourceShaSet = Object.fromEntries(Array.from({length: 178}, (_, i) => [`pin-${String(i).padStart(3, '0')}`, sha('a')]));
  for (const [i, ref] of materialRefs.entries()) sourceShaSet[ref] = sha('b');
  sourceShaSet[selectorRef] = sha('c');
  const preimage = {
    schemaVersion: 'media.phase-dev-status.v1', phase: 'PDP-0', status: 'IN_PROGRESS',
    sourceShaSet, sourceRecordCount: {capabilityLeafAdjudications: 462},
    semanticallyResolvedCount: {capabilityLeafAdjudications: 462},
    outstandingMeaningIds: [], ownerHistory: {rows: 462, digest: sha('d')},
  };
  const targetSet = new Set(targetRefs);
  const observedPins = Object.entries(sourceShaSet).map(([sourceRef, pin]) => ({
    sourceRef,
    sourceKind: targetSet.has(sourceRef) ? (sourceRef === selectorRef ? 'PHASE_SCOPED_SELECTOR' : 'MATERIAL_FILE') : 'MATERIAL_FILE',
    statusPinnedSha256: pin,
    observedSha256: targetSet.has(sourceRef) ? sha('e') : pin,
  }));
  const targetUpdates = targetRefs.map(sourceRef => ({
    sourceRef,
    sourceKind: sourceRef === selectorRef ? 'PHASE_SCOPED_SELECTOR' : 'MATERIAL_FILE',
    previousSha256: sourceShaSet[sourceRef],
    currentSha256: sha('e'),
  }));
  return {preimage, observedPins, targetUpdates};
}

test('builds an exact ten-pin PDP-0 successor and preserves every non-pin field', () => {
  const input = fixture();
  const result = buildPdp0PinSuccessor({...input, expectedMaterialRefs: materialRefs, selectorRef});
  assert.equal(result.candidate.status, 'IN_PROGRESS');
  assert.equal(Object.keys(result.candidate.sourceShaSet).length, 188);
  assert.deepEqual(result.changedSourceRefs, [...targetRefs].sort());
  assert.equal(result.candidate.sourceRecordCount.capabilityLeafAdjudications, 462);
  assert.deepEqual(result.candidate.outstandingMeaningIds, []);
  assertPdp0PinSuccessor({preimage: input.preimage, candidate: result.candidate, targetRefs});
});

test('rejects a stale source outside the exact ten-pin target set', () => {
  const input = fixture();
  const unrelated = input.observedPins.find(row => !targetRefs.includes(row.sourceRef));
  unrelated.observedSha256 = sha('f');
  assert.throws(() => buildPdp0PinSuccessor({...input, expectedMaterialRefs: materialRefs, selectorRef}),
    /stale outside the authorized ten-pin target set/u);
});

test('rejects status mutation, completion promotion, or owner-history mutation', () => {
  const input = fixture();
  const result = buildPdp0PinSuccessor({...input, expectedMaterialRefs: materialRefs, selectorRef});
  const changed = structuredClone(result.candidate);
  changed.status = 'DEV_COMPLETE';
  assert.throws(() => assertPdp0PinSuccessor({preimage: input.preimage, candidate: changed, targetRefs}),
    /preserve IN_PROGRESS/u);
  const mutated = structuredClone(result.candidate);
  mutated.ownerHistory.rows = 461;
  assert.throws(() => assertPdp0PinSuccessor({preimage: input.preimage, candidate: mutated, targetRefs}),
    /mutated status data outside sourceShaSet/u);
});
