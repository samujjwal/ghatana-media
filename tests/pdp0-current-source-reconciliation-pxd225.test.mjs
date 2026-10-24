import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  buildPxd225Reconciliation,
  selectPxd225PredecessorFromHistory,
  selectCommittedPxd225Predecessor,
} from '../scripts/generate-pdp0-current-source-reconciliation-pxd225.mjs';
import {fingerprintPxdDecisionSection} from '../scripts/lib/pdp0-phase-scoped-source-fingerprints.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('PXD-225 uses the parent source only when HEAD committed the exact locator removal', () => {
  const parent = {channels: [{
    id: 'media.channel.legacy-desktop',
    evidence: 'archive/media-desktop-apps/desktop/README.md and archive/media-desktop-apps/ai-voice-desktop/README.md',
    runtimeAvailability: 'NOT_ADMITTED',
  }]};
  const head = structuredClone(parent);
  head.channels[0].evidence = 'archive/media-desktop-apps/desktop/README.md';
  assert.equal(selectCommittedPxd225Predecessor(head, parent), parent);

  const changedHead = structuredClone(head);
  changedHead.channels[0].runtimeAvailability = 'AVAILABLE';
  assert.equal(selectCommittedPxd225Predecessor(changedHead, parent), changedHead);
});

test('PXD-225 finds the exact locator-removal commit after HEAD has advanced, and rejects a changed postimage', () => {
  const parent = {channels: [{
    id: 'media.channel.legacy-desktop',
    evidence: 'archive/media-desktop-apps/desktop/README.md and archive/media-desktop-apps/ai-voice-desktop/README.md',
    runtimeAvailability: 'NOT_ADMITTED',
  }]};
  const postimage = structuredClone(parent);
  postimage.channels[0].evidence = 'archive/media-desktop-apps/desktop/README.md';
  const current = structuredClone(postimage);
  assert.equal(selectPxd225PredecessorFromHistory(current, [{postimage, parentImage: parent}]), parent);

  current.channels[0].runtimeAvailability = 'AVAILABLE';
  assert.equal(selectPxd225PredecessorFromHistory(current, [{postimage, parentImage: parent}]), current);
});

test('PXD-225 pins current applications-channels and exact decision section while preserving PXD-216 20-leaf semantics', () => {
  const result = buildPxd225Reconciliation();
  assert.equal(result.decisionRef, '.product-experience/decision-log.md#PXD-225');
  assert.equal(result.sourceCut.sourceCount, 2);
  assert.equal(result.currentSource.channelsPath,
    '.product-experience/pdp-0-product-truth/applications-channels.yaml');
  assert.equal(result.currentSource.channelsSha256,
    sha256(read(result.currentSource.channelsPath)));
  assert.deepEqual(result.predecessorRefs,
    ['docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd223.json']);
  assert.equal(result.decisionSectionSha256,
    fingerprintPxdDecisionSection(read('.product-experience/decision-log.md'), 'PXD-225').sha256);
  assert.equal(result.preservedSemanticReview.decisionRef, '.product-experience/decision-log.md#PXD-216');
  assert.equal(result.preservedSemanticReview.reviewedCapabilityCount, 20);
  assert.equal(result.preservedSemanticReview.changedReviewedCapabilityIds.length, 0);
  assert.equal(result.preservedSemanticReview.currentReviewedRowsSha256,
    result.preservedSemanticReview.historicalReviewedRowsSha256);
  assert.equal(result.preservedCurrentnessPredecessor.decisionRef,
    '.product-experience/decision-log.md#PXD-223');
  assert.equal(result.preservedCurrentnessPredecessor.artifactRef,
    'docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd223.json');
  assert.equal(result.preservedCurrentnessPredecessor.capabilitiesSha256,
    JSON.parse(read(result.preservedCurrentnessPredecessor.artifactRef)).currentSource.capabilitiesSha256);
  assert.equal(result.currentSource.semanticChange,
    'REMOVED_ABSENT_ARCHIVED_CHANNEL_EVIDENCE_LOCATOR_ONLY');
  assert.equal(result.currentSource.removedEvidenceLocator,
    'archive/media-desktop-apps/ai-voice-desktop/README.md');
  assert.equal(result.currentSource.channelRef, 'media.channel.legacy-desktop');
  assert.equal(result.currentSource.supportStatePreserved.runtimeAvailability, 'NOT_ADMITTED');
  assert.equal(result.currentSource.supportStatePreserved.qualificationState, 'NOT_EVALUATED');
  assert.equal(result.preservedSemanticReview.semanticReviewStatus,
    'PXD-216_SEMANTIC_REVIEW_PRESERVED; NO_NEW_SEMANTIC_REVIEW');
  assert.equal(result.authority.ownerApproval, 'NOT_CLAIMED');
  assert.equal(result.authority.independentAcceptance, 'NOT_CLAIMED');
  assert.equal(result.authority.acceptanceEffect, 'none');
  assert.equal(result.authority.closure, 'NOT_CLAIMED');
  assert.match(result.decisionEffect, /No new semantic review/u);
});

test('PXD-225 fails closed when a reviewed capability row changes', () => {
  const capabilityPath = '.product-experience/pdp-0-product-truth/capabilities.yaml';
  const original = read(capabilityPath);
  const altered = original.replace('id: media.project.organize', 'id: media.project.organize.changed');
  assert.notEqual(altered, original);
  assert.throws(() => buildPxd225Reconciliation({
    read: file => file === capabilityPath ? altered : read(file),
  }), /expected exactly one capability row/u);
});
