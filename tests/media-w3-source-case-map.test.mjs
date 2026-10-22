import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  buildMediaW3SourceCaseMap,
  validateMediaW3SourceCaseMap,
} from '../scripts/lib/media-w3-source-case-map.mjs';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const parseYaml = createRequire(path.resolve(root, '../ghatana-tools/package.json'))('yaml').parse;
const expected = buildMediaW3SourceCaseMap({ root, parseYaml });
const persisted = JSON.parse(fs.readFileSync(path.join(root,
  'config/closure/media-product-definition/w3-pdp0-source-case-map.json'), 'utf8'));
const verify = (record) => validateMediaW3SourceCaseMap(record, { root, parseYaml, expected });

test('W3 source case map preserves current campaign identities and PDP phase denominators', () => {
  assert.equal(expected.campaign.sourceIdentityCount, 54);
  assert.deepEqual(expected.campaign.sourceIdentityKinds, { physical: 26, compositions: 7, logical: 21 });
  assert.deepEqual(expected.campaign.sourceIdentitySubtypes, {
    physical: 26, intermediateCompositions: 6, rootAggregates: 1, logical: 21,
  });
  assert.equal(expected.campaign.obligationCount, 8664);
  assert.deepEqual(expected.incumbentL02, {
    status: 'SOURCE_LINK_PROPOSAL_PARTIAL_NOT_EXECUTION_ADMITTED',
    candidateLinkCount: 65,
    linkedObligationCount: 44,
    unmappedObligationCount: 8620,
  });
  assert.deepEqual(expected.phaseDenominators.map(({ phase, obligationCount }) => [phase, obligationCount]), [
    ['PDP-0', 4028], ['PDP-1', 2336], ['PDP-2', 436], ['PDP-3', 1864],
  ]);
  assert.deepEqual(expected.sourceIdentityRows.map(({ surfaceId }) => surfaceId).sort(),
    [...new Set(expected.sourceIdentityRows.map(({ surfaceId }) => surfaceId))].sort());
  for (const row of expected.sourceIdentityRows) {
    assert.deepEqual(Object.keys(row.phaseCells).sort(), ['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3']);
    for (const phase of ['PDP-1', 'PDP-2', 'PDP-3']) {
      assert.equal(row.phaseCells[phase].sourceCaseMapStatus, 'DEFERRED_PHASE_LOCAL_MAPPING_UNCHANGED');
    }
  }
  assert.equal(expected.pdp0CaseMap.obligationCount, 4028);
  assert.equal(expected.pdp0CaseMap.candidateLinkCount, 0);
  assert.equal(expected.pdp0CaseMap.candidateLinkedObligationCount, 0);
  assert.equal(expected.pdp0CaseMap.openSlotCount, 4028);
  assert.equal(expected.pdp0CaseMap.openSlots.filter(({ sourceCaseIds }) => sourceCaseIds.length > 0).length, 38);
  assert.ok(expected.pdp0CaseMap.openSlots.every(({ closureSurfaceId, closureSurfaceDisposition, l02CandidateLinks }) =>
    closureSurfaceId === null && closureSurfaceDisposition === 'NOT_ADJUDICATED' && l02CandidateLinks.length === 0));
  assert.equal(expected.nativeAdmission, 'NOT_ISSUED');
  assert.equal(expected.nativeReceipts, 0);
  assert.deepEqual(persisted, expected);
  assert.deepEqual(verify(persisted), []);
});

test('W3 map rejects duplicate and missing obligation joins', () => {
  const duplicate = structuredClone(expected);
  duplicate.pdp0CaseMap.openSlots.push(structuredClone(duplicate.pdp0CaseMap.openSlots[0]));
  assert.throws(() => verify(duplicate), /duplicate PDP-0 obligation join/u);

  const missing = structuredClone(expected);
  missing.pdp0CaseMap.openSlots.pop();
  assert.throws(() => verify(missing), /missing PDP-0 obligation joins/u);
});

test('W3 map rejects stale source pins and invalid phase or surface applicability', () => {
  const stale = structuredClone(expected);
  stale.pdp0CaseMap.openSlots[0].sourceDigest = 'sha256:stale';
  assert.throws(() => verify(stale), /stale\/invalid source pin/u);

  const wrongPhase = structuredClone(expected);
  wrongPhase.pdp0CaseMap.openSlots[0].phase = 'PDP-1';
  assert.throws(() => verify(wrongPhase), /stale\/invalid source pin or phase applicability/u);

  const wrongSurface = structuredClone(expected);
  wrongSurface.pdp0CaseMap.openSlots.find(({ sourceSurfaceCandidates }) => sourceSurfaceCandidates.length)
    .sourceSurfaceCandidates[0].surfaceId = 'media.physical.invented';
  assert.throws(() => verify(wrongSurface), /invalid source-surface applicability join/u);
});

test('W3 map keeps source case IDs open until an exact L02 candidate join exists', () => {
  const missingCaseJoin = structuredClone(expected);
  missingCaseJoin.pdp0CaseMap.openSlots.find(({ sourceCaseIds }) => sourceCaseIds.length).sourceCaseIds = [];
  assert.throws(() => verify(missingCaseJoin), /invalid\/missing case join/u);

  const inventedCandidateJoin = structuredClone(expected);
  inventedCandidateJoin.pdp0CaseMap.openSlots[0].l02CandidateLinks = [{
    caseId: 'invented-case', testIdentity: { sourcePath: 'tests/invented.test.mjs', testName: 'invented' },
  }];
  assert.throws(() => verify(inventedCandidateJoin), /invalid\/missing case join/u);
});
