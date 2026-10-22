import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {currentPdp0PhaseScopedSourceFingerprints} from '../scripts/check-media-pdp0-501-audit-dispositions.mjs';
import {buildPdp0AuditAqTraceability, validatePdp0AuditAqTraceability} from '../scripts/check-media-pdp0-audit-aq-traceability.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactPath = 'docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd216.json';
const currentArtifactPath = 'docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd223.json';
const crosswalkPath = 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json';
const traceabilityPath = 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-audit-aq-traceability.json';
const reviewPath = 'docs/implementation/verification/pdp-38/p0-capability-meaning-20-leaf-current-source-review-pxd216.json';
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');

test('PXD-216 remains historical semantic evidence while PXD-223 binds current source pins', () => {
  const artifact = JSON.parse(fs.readFileSync(path.join(root, artifactPath), 'utf8'));
  const currentArtifact = JSON.parse(fs.readFileSync(path.join(root, currentArtifactPath), 'utf8'));
  const crosswalk = JSON.parse(fs.readFileSync(path.join(root, crosswalkPath), 'utf8'));
  const traceability = JSON.parse(fs.readFileSync(path.join(root, traceabilityPath), 'utf8'));
  const capabilityReview = JSON.parse(fs.readFileSync(path.join(root, reviewPath), 'utf8'));

  assert.equal(artifact.decisionRef, '.product-experience/decision-log.md#PXD-216');
  assert.equal(artifact.phaseScope, 'PDP-0');
  assert.equal(artifact.currentSourcePinsStatus, 'CURRENT_SOURCE_PINS_VERIFIED_NO_ACCEPTANCE_EFFECT');
  assert.equal(artifact.authority.ownerApproval, 'NOT_CLAIMED');
  assert.equal(artifact.authority.independentAcceptance, 'NOT_CLAIMED');
  assert.equal(artifact.authority.acceptanceEffect, 'none');
  assert.equal(artifact.authority.implementation, 'NOT_CLAIMED');
  assert.equal(artifact.authority.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(artifact.authority.qualification, 'NOT_EVALUATED');
  assert.equal(artifact.authority.closure, 'NOT_CLAIMED');
  assert.equal(artifact.authority.delivery, 'NOT_CLAIMED');
  assert.equal(Object.hasOwn(artifact.sourceFingerprints, '.product-experience/decision-log.md'), false,
    'PDP-0 binds the exact PXD section and must not depend on downstream decision-log additions');
  assert.equal(Object.hasOwn(artifact.sourceFingerprints, 'scripts/report-media-pdp-readiness.mjs'), false,
    'shared reporting code is verification tooling, not a material PDP-0 source');
  assert.equal(Object.hasOwn(crosswalk.sourceBaseline.workingTreeSourceFingerprintsSha256, 'scripts/report-media-pdp-readiness.mjs'), false,
    'shared reporting code cannot invalidate the current 501-row PDP-0 crosswalk');

  const expectedPhasePins = currentPdp0PhaseScopedSourceFingerprints('PXD-223');
  assert.equal(artifact.sourceFingerprints['.product-experience/pdp-0-product-truth/capabilities.yaml'], '1c0daf9ee0cd600ec097baca0dded1d58d1803f6c147716a076705c37ad8cc26');
  assert.equal(currentArtifact.decisionRef, '.product-experience/decision-log.md#PXD-223');
  assert.equal(currentArtifact.currentSource.capabilitiesPath, '.product-experience/pdp-0-product-truth/capabilities.yaml');
  assert.equal(currentArtifact.currentSource.capabilitiesSha256, sha256('.product-experience/pdp-0-product-truth/capabilities.yaml'));
  assert.equal(currentArtifact.decisionSectionSha256, expectedPhasePins['.product-experience/decision-log.md#PXD-223-section']);
  assert.equal(currentArtifact.sourceCut.sourceCount, 2, 'PXD-223 binds the current capabilities bytes and exact decision section');
  assert.equal(currentArtifact.preservedSemanticReview.reviewedCapabilityCount, 20);
  assert.deepEqual(currentArtifact.preservedSemanticReview.changedReviewedCapabilityIds, []);
  assert.equal(currentArtifact.preservedSemanticReview.currentReviewedRowsSha256,
    currentArtifact.preservedSemanticReview.historicalReviewedRowsSha256,
    'PXD-223 preserves the exact 20-row semantic projection');
  assert.equal(currentArtifact.currentSource.currentCapabilityRecordCount, 469);
  const deferredRows = currentArtifact.currentSource.populationDelta.changedRows;
  assert.deepEqual(deferredRows.map(row => row.capabilityId).sort(), [
    'media.generate.video.preset.manage',
    'media.generate.video.shot-condition',
    'media.job.schedule.manage',
    'media.master.audio.creative-effect.apply',
    'media.project.scene.patch-merge',
    'media.quality.audio.content-similarity.assess',
    'media.recipe.specification.compile',
  ]);
  assert.ok(deferredRows.every(row => row.field === 'scopeStatus' && row.from === 'TARGET' && row.to === 'DEFERRED'));
  assert.equal(currentArtifact.currentSource.populationDelta.changedRecordCount, 7);
  assert.equal(currentArtifact.currentSource.populationDelta.otherCapabilityFieldsChanged, false);
  assert.deepEqual(crosswalk.sourceBaseline.phaseScopedSourceFingerprintsSha256, expectedPhasePins);
  assert.deepEqual(crosswalk.coordinatorReview.sourceFingerprints, expectedPhasePins);
  assert.equal(crosswalk.coordinatorReview.decisionRef, 'PXD-223');
  assert.equal(crosswalk.coordinatorReview.priorDecisionRef, 'PXD-216');
  const predecessor = crosswalk.coordinatorReview.reviewHistory.find(row => row.decisionRef === 'PXD-216');
  assert.ok(predecessor, 'PXD-216 remains available as historical semantic evidence');
  assert.equal(predecessor.ownerApproval, 'NOT_CLAIMED');
  assert.equal(predecessor.acceptanceEffect, 'none');

  assert.deepEqual(artifact.traceability, {
    sourceRows: 501,
    originalRows: 428,
    thirdPassRows: 73,
    canonicalDefinitionJoins: 497,
    coordinatorProposalDefinitionJoins: 2,
    postPdpImplementationOnlyRows: 2,
    missingDefinitionJoins: 0,
    canonicalCapabilityLeaves: 462,
    currentCapabilityDefinitions: 469,
    currentDefinitionExtensions: 7,
  });
  assert.deepEqual(traceability, buildPdp0AuditAqTraceability());
  assert.deepEqual(validatePdp0AuditAqTraceability().errors, []);
  assert.deepEqual(artifact.capabilityMeaningReview, {
    artifactRef: reviewPath,
    reviewedCapabilityCount: capabilityReview.reviewedCapabilityIds.length,
    reviewedCapabilityIds: capabilityReview.reviewedCapabilityIds,
    acceptanceEffect: 'none',
  });
});
