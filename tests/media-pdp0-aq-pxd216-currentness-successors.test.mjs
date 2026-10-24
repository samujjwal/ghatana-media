import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildMediaPdp0AqPxd216CurrentnessSuccessors} from '../scripts/prepare-media-pdp0-aq-pxd216-currentness-successors.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidateRef = 'docs/implementation/observations/media-pdp0-currentness-refresh-2026-10-24/pdp0-aq-capability-current-source-review-001-154.successor.candidate.v5.json';
const pxd216Ref = 'docs/implementation/observations/media-pdp0-currentness-refresh-2026-10-24/p0-capability-meaning-20-leaf-current-source-review-pxd216.successor.candidate.v5.json';
const ownerInputRef = 'docs/implementation/observations/media-pdp0-currentness-refresh-2026-10-24/source-owner-decision-input.candidate.v5.json';
const rootInputRef = 'docs/implementation/observations/media-pdp0-currentness-refresh-2026-10-24/root-application-input.candidate.v5.json';

test('AQ 1-154 and PXD-216 currentness successors prove exact out-of-slice deltas without acceptance', () => {
  const prepared = buildMediaPdp0AqPxd216CurrentnessSuccessors({repositoryRoot: root});
  const aggregate = prepared.outputFiles[candidateRef];
  const pxd216 = prepared.outputFiles[pxd216Ref];
  const ownerInput = prepared.outputFiles[ownerInputRef];
  const rootInput = prepared.outputFiles[rootInputRef];

  assert.equal(aggregate.candidateState, 'SOURCE_BOUND_CURRENTNESS_ONLY_CANDIDATE; OWNER_DECISION_NOT_RECORDED');
  assert.equal(aggregate.sourceDelta.aq1To154.classification, 'NO_MEANING_CHANGE_IN_AQ_ROWS_1_TO_154');
  assert.deepEqual(aggregate.sourceDelta.aq1To154.capabilityRowsChanged, []);
  assert.deepEqual(aggregate.sourceDelta.aq1To154.changedRequirementIdsUsedBySlice, []);
  assert.equal(aggregate.sourceDelta.aq1To154.appendedRecipeAcceptanceCaseIds.length, 5);

  assert.equal(aggregate.sourceDelta.pxd216.reviewedCapabilityCount, 20);
  assert.equal(aggregate.sourceDelta.pxd216.classification,
    'NO_MEANING_CHANGE_TO_THE_20_PXD216_REVIEWED_ROWS; SOURCE_EXTENSIONS_OUTSIDE_SLICE_REMAIN_SEPARATELY_GOVERNED');
  assert.deepEqual(aggregate.sourceDelta.pxd216.changedReviewedCapabilityIds, []);
  assert.equal(aggregate.sourceDelta.pxd216.historicalOwnerAdjudicationRowsUnchanged, true);
  assert.equal(aggregate.sourceDelta.pxd216.reviewedOwnerTrustRowsUnchanged, true);
  const channelDelta = aggregate.sourceDelta.pxd216.changedSourceRecordsOutsideSlice
    .find(row => row.sourceRef.endsWith('/applications-channels.yaml'));
  assert.equal(channelDelta.classification,
    'PXD225_CHANNEL_SOURCE_CURRENTNESS_CHANGE_FROM_PXD223_SOURCE_CUT; PXD216_REVIEWED_MEANING_UNCHANGED');
  assert.notEqual(channelDelta.pxd223SourceCutSha256, channelDelta.currentSha256);
  assert.ok(aggregate.sourceDelta.pxd216.historicalCapabilityDeltaOutsideReviewedSlice.changedRows
    .some(row => row.classification === 'PXD-226_CURRENT_VERSION_EXTENSION_MEANING_CHANGE_OUTSIDE_PXD216_SLICE'));
  assert.deepEqual(pxd216.pxd225Selector.changedFields, ['decisionSectionSha256']);
  assert.equal(pxd216.ownerApproval, 'NOT_CLAIMED');
  assert.equal(pxd216.independentAcceptance, 'NOT_CLAIMED');

  assert.equal(ownerInput.state, 'DECISION_NOT_RECORDED; CANDIDATE_FOR_AUTHENTIC_SOURCE_OWNER');
  assert.equal(rootInput.state, 'PREPARED_INPUT_ONLY; OWNER_AND_ROOT_DECISION_NOT_RECORDED');
  assert.equal(rootInput.canonicalApply, 'NONE');
  assert.equal(rootInput.protectedInputs.pdp0Status.sha256,
    '6e92932ba4173c6dea7e3dcee0c1d44a44ae90245804d363c0d22c2f28028b7c');
  assert.equal(rootInput.protectedInputs.crosswalk.sha256,
    '02c61f7b0193ccd1900ffcae84f7a4c95fb00e800d9d86a9ce1ea65cae79b5b4');

  for (const ref of [candidateRef, pxd216Ref, ownerInputRef, rootInputRef]) {
    assert.ok(fs.existsSync(path.join(root, ref)), `${ref} is the append-only prepared postimage`);
    assert.equal(fs.readFileSync(path.join(root, ref), 'utf8'), `${JSON.stringify(prepared.outputFiles[ref], null, 2)}\n`);
  }
});
