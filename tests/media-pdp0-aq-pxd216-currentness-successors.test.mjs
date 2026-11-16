import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildMediaPdp0AqPxd216CurrentnessSuccessors} from '../scripts/prepare-media-pdp0-aq-pxd216-currentness-successors.mjs';
import {fingerprintPxdDecisionSection} from '../scripts/lib/pdp0-phase-scoped-source-fingerprints.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidateRef = 'docs/implementation/observations/media-pdp0-currentness-refresh-2026-10-24/pdp0-aq-capability-current-source-review-001-154.successor.candidate.v6.json';
const pxd216Ref = 'docs/implementation/observations/media-pdp0-currentness-refresh-2026-10-24/p0-capability-meaning-20-leaf-current-source-review-pxd216.successor.candidate.v6.json';
const ownerInputRef = 'docs/implementation/observations/media-pdp0-currentness-refresh-2026-10-24/source-owner-decision-input.candidate.v6.json';
const rootInputRef = 'docs/implementation/observations/media-pdp0-currentness-refresh-2026-10-24/root-application-input.candidate.v6.json';
const v5Ref = 'docs/implementation/observations/media-pdp0-currentness-refresh-2026-10-24/pdp0-aq-capability-current-source-review-001-154.successor.candidate.v5.json';
const sha256File = ref => createHash('sha256').update(fs.readFileSync(path.join(root, ref))).digest('hex');

test('AQ 1-154 and PXD-216 currentness successors prove exact out-of-slice deltas without acceptance', () => {
  const prepared = buildMediaPdp0AqPxd216CurrentnessSuccessors({repositoryRoot: root});
  const aggregate = prepared.outputFiles[candidateRef];
  const pxd216 = prepared.outputFiles[pxd216Ref];
  const ownerInput = prepared.outputFiles[ownerInputRef];
  const rootInput = prepared.outputFiles[rootInputRef];
  const v5 = JSON.parse(fs.readFileSync(path.join(root, v5Ref), 'utf8'));
  const currentPxd225 = JSON.parse(fs.readFileSync(path.join(root, 'docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd225.json'), 'utf8'));

  assert.deepEqual(aggregate.campaign, {
    phase: 'PDP-0', macroStage: 'DISCOVERY', identityDenominator: 56, phaseCells: 224, auditRows: 501, historicalOwnerRows: 462,
  });
  const decisionLog = fs.readFileSync(path.join(root, '.product-experience/decision-log.md'), 'utf8');
  assert.equal(aggregate.currentDecisionSectionPins['.product-experience/decision-log.md#PXD-229-section'],
    fingerprintPxdDecisionSection(decisionLog, 'PXD-229').sha256);
  assert.equal(aggregate.currentDecisionSectionPins['.product-experience/decision-log.md#PXD-230-section'],
    fingerprintPxdDecisionSection(decisionLog, 'PXD-230').sha256);
  assert.equal(aggregate.predecessors.pxd216CurrentnessV5.ref, v5Ref);
  assert.equal(aggregate.predecessors.pxd216CurrentnessV5.sha256, sha256File(v5Ref));
  assert.equal(pxd216.pxd225Selector.historicalV5SuccessorSha256, sha256File(v5Ref));
  assert.equal(pxd216.pxd225Selector.currentRef, 'docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd225.json');
  assert.equal(pxd216.pxd225Selector.currentSha256, sha256File(pxd216.pxd225Selector.currentRef));
  assert.equal(pxd216.pxd225Selector.currentDecisionSectionSha256, currentPxd225.decisionSectionSha256);
  assert.deepEqual(pxd216.pxd225Selector.changedFields, v5.pxd216Successor.pxd225Selector.changedFields);
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
    sha256File('docs/implementation/pdp-0-phase-dev-status.json'));
  assert.equal(rootInput.protectedInputs.crosswalk.sha256,
    sha256File('docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json'));

  for (const ref of [candidateRef, pxd216Ref, ownerInputRef, rootInputRef]) {
    assert.ok(fs.existsSync(path.join(root, ref)), `${ref} is the append-only prepared postimage`);
    assert.equal(fs.readFileSync(path.join(root, ref), 'utf8'), `${JSON.stringify(prepared.outputFiles[ref], null, 2)}\n`);
  }
});
