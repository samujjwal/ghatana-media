import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  buildPxd225Reconciliation,
  selectPxd225PredecessorFromHistory,
  selectCommittedPxd225Predecessor,
} from '../scripts/generate-pdp0-current-source-reconciliation-pxd225.mjs';
import {fingerprintPxdDecisionSection} from '../scripts/lib/pdp0-phase-scoped-source-fingerprints.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {parse: parseYaml, stringify: stringifyYaml} = createRequire(path.resolve(root, '../ghatana-tools/package.json'))('yaml');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const topologySuccessorPath = 'docs/implementation/observations/media-discovery-topology-56-surface-successor-2026-10-31.json';
const topologySuccessorCommit = '86dbc4b1efaabb1f8a7c63d7ee5839d0a9176f8c';
const topologySuccessorParent = '8e470c5dbd837c4c44429bc9d6aba6b6de51d313';
const pxd225LocatorCommit = '0f85319fcc28ed163341ba5027bfbc5b64137ddb';

function buildWithTopologySourceMutation(mutate) {
  const channelsPath = '.product-experience/pdp-0-product-truth/applications-channels.yaml';
  const parentText = execFileSync('git', ['show', `${topologySuccessorParent}:${channelsPath}`], {
    cwd: root, encoding: 'utf8', maxBuffer: 12 * 1024 * 1024,
  });
  const postimageText = execFileSync('git', ['show', `${topologySuccessorCommit}:${channelsPath}`], {
    cwd: root, encoding: 'utf8', maxBuffer: 12 * 1024 * 1024,
  });
  const parent = parseYaml(parentText);
  const postimage = parseYaml(postimageText);
  mutate(parent, postimage);
  const mutatedParent = stringifyYaml(parent);
  const mutatedPostimage = stringifyYaml(postimage);
  return buildPxd225Reconciliation({
    read: file => file === channelsPath ? mutatedPostimage : read(file),
    committedRead: (commit, file) => commit === topologySuccessorParent && file === channelsPath
      ? mutatedParent
      : commit === topologySuccessorCommit && file === channelsPath
        ? mutatedPostimage
        : execFileSync('git', ['show', `${commit}:${file}`], {cwd: root, encoding: 'utf8', maxBuffer: 12 * 1024 * 1024}),
  });
}

function dataCloudExclusion(document, index = 0) {
  return document.coordinatorDefinitionExtensionApplicability.records[index].decision.excludedSurfaceRefs
    .find(row => row.surfaceRef === 'media.physical.adapters-data-cloud-media');
}

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
  assert.equal(result.sourceCut.authorizedCurrentnessSuccessorCount, 1);
  assert.deepEqual(result.currentSource.sourceProvenance.locatorRemoval, {
    commit: pxd225LocatorCommit,
    parentCommit: 'f8816aede965d55c27005d5bab13bcb6ae376389',
    predecessorChannelsSha256: result.currentSource.sourceProvenance.locatorRemoval.predecessorChannelsSha256,
    postimageChannelsSha256: result.currentSource.sourceProvenance.locatorRemoval.postimageChannelsSha256,
    effect: 'REMOVED_ABSENT_ARCHIVED_CHANNEL_EVIDENCE_LOCATOR_ONLY',
  });
  assert.equal(result.currentSource.sourceProvenance.authorizedTopologySuccessor.commit, topologySuccessorCommit);
  assert.equal(result.currentSource.sourceProvenance.authorizedTopologySuccessor.recordRef, topologySuccessorPath);
  assert.equal(result.currentSource.sourceProvenance.authorizedTopologySuccessor.recordSha256,
    '36fd5d406516013d167f939c00820ee3554242185c723c500fb0345ccb87ef0e');
  assert.equal(result.currentSource.sourceProvenance.authorizedTopologySuccessor.decisionRef,
    '.product-experience/decision-log.md#PXD-207');
  assert.equal(result.currentSource.sourceProvenance.authorizedTopologySuccessor.decisionSectionSha256,
    'eedde5bd30fabed060af9a1b8b16bf55f4a5648331950daaf3ca860d99d7ec3a');
  assert.equal(result.currentSource.sourceProvenance.authorizedTopologySuccessor.excludedPxd207ExtensionCount, 7);
  assert.equal(result.currentSource.sourceProvenance.authorizedTopologySuccessor.meaningChange,
    'NO_PDP0_MEANING_CHANGE');
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
  assert.equal(result.currentSource.supportStatePreserved.definitionState, 'historical-archive');
  assert.equal(result.currentSource.supportStatePreserved.implementationState, 'archived-source-only');
  assert.equal(result.currentSource.supportStatePreserved.qualificationState, 'NOT_EVALUATED');
  assert.equal(result.currentSource.supportStatePreserved.licenseAdmissionState, 'NOT_EVALUATED');
  assert.equal(result.currentSource.supportStatePreserved.phase0Admission, 'not-admitted');
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

test('PXD-225 rejects any additional live applications-channels source change', () => {
  const channelsPath = '.product-experience/pdp-0-product-truth/applications-channels.yaml';
  const original = read(channelsPath);
  const altered = original.replace(
    'runtimeAvailability: NOT_ADMITTED\n    phase0Admission: not-admitted',
    'runtimeAvailability: AVAILABLE\n    phase0Admission: not-admitted',
  );
  assert.notEqual(altered, original);
  assert.throws(() => buildPxd225Reconciliation({
    read: file => file === channelsPath ? altered : read(file),
  }), /current applications-channels bytes do not equal the exact authorized 86dbc4b1 postimage/u);
});

test('PXD-225 rejects tampered or missing R1 provenance and a changed successor commit postimage', () => {
  const tamperedR1 = JSON.parse(read(topologySuccessorPath));
  tamperedR1.successor.totalSurfaceIdentities += 1;
  assert.throws(() => buildPxd225Reconciliation({
    read: file => file === topologySuccessorPath ? JSON.stringify(tamperedR1) : read(file),
  }), /exact authorized R1 denominator disposition/u);

  assert.throws(() => buildPxd225Reconciliation({
    read: file => {
      if (file === topologySuccessorPath) throw new Error('R1 record unavailable');
      return read(file);
    },
  }), /R1 record unavailable/u);

  const authorizedPostimage = execFileSync('git', ['show', `${topologySuccessorCommit}:.product-experience/pdp-0-product-truth/applications-channels.yaml`], {
    cwd: root, encoding: 'utf8', maxBuffer: 12 * 1024 * 1024,
  });
  const alteredPostimage = authorizedPostimage.replace('totalSurfaceIdentities: 56', 'totalSurfaceIdentities: 57');
  assert.notEqual(alteredPostimage, authorizedPostimage);
  assert.throws(() => buildPxd225Reconciliation({
    committedRead: (commit, file) => commit === topologySuccessorCommit && file === '.product-experience/pdp-0-product-truth/applications-channels.yaml'
      ? alteredPostimage
      : execFileSync('git', ['show', `${commit}:${file}`], {cwd: root, encoding: 'utf8', maxBuffer: 12 * 1024 * 1024}),
  }), /current applications-channels bytes do not equal the exact authorized 86dbc4b1 postimage/u);
});

test('PXD-225 rejects changed commit parent, ancestry, and PXD decision bytes', () => {
  assert.throws(() => buildPxd225Reconciliation({
    gitExec: (command, args, options) => command === 'git' && args[0] === 'rev-parse' && args[1] === `${pxd225LocatorCommit}^`
      ? '0'.repeat(40)
      : execFileSync(command, args, options),
  }), /commit parent differs from its pinned source cut/u);

  assert.throws(() => buildPxd225Reconciliation({
    gitExec: (command, args, options) => command === 'git' && args[0] === 'merge-base'
      ? (() => { throw new Error('pinned commits are not ancestors'); })()
      : execFileSync(command, args, options),
  }), /pinned commits are not ancestors/u);

  const decisionPath = '.product-experience/decision-log.md';
  const originalDecision = read(decisionPath);
  const changedPxd207 = originalDecision.replace('### PXD-207 —', '### PXD-207 changed —');
  assert.notEqual(changedPxd207, originalDecision);
  assert.throws(() => buildPxd225Reconciliation({
    read: file => file === decisionPath ? changedPxd207 : read(file),
  }), /not bound to the pinned PXD-207 decision section/u);

  const changedPxd225 = originalDecision.replace('bounded PDP-0 source-currentness decision', 'changed PDP-0 source-currentness decision');
  assert.notEqual(changedPxd225, originalDecision);
  assert.throws(() => buildPxd225Reconciliation({
    read: file => file === decisionPath ? changedPxd225 : read(file),
  }), /PXD-225 decision section differs from its authorized currentness selector/u);
});

test('PXD-225 rejects missing, reordered, or altered R1 Data Cloud applicability evidence', () => {
  assert.throws(() => buildWithTopologySourceMutation((parent, postimage) => {
    for (const document of [parent, postimage]) {
      document.coordinatorDefinitionExtensionApplicability.records[0].decision.excludedSurfaceRefs =
        document.coordinatorDefinitionExtensionApplicability.records[0].decision.excludedSurfaceRefs
          .filter(row => row.surfaceRef !== 'media.physical.adapters-data-cloud-media');
    }
  }), /exactly seven PXD-207 extension rows/u);

  assert.throws(() => buildWithTopologySourceMutation((parent, postimage) => {
    for (const document of [parent, postimage]) {
      const excluded = document.coordinatorDefinitionExtensionApplicability.records[0].decision.excludedSurfaceRefs;
      const index = excluded.findIndex(row => row.surfaceRef === 'media.physical.adapters-data-cloud-media');
      const [entry] = excluded.splice(index, 1);
      excluded.push(entry);
    }
  }), /not the recorded Data Cloud exclusion/u);

  assert.throws(() => buildWithTopologySourceMutation((parent, postimage) => {
    for (const document of [parent, postimage]) dataCloudExclusion(document).rationale = 'Unreviewed applicability claim.';
  }), /not the recorded Data Cloud exclusion/u);
});
