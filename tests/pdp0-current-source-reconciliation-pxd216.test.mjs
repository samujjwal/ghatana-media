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
const successorArtifactPath = 'docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd225.json';
const crosswalkPath = 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json';
const traceabilityPath = 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-audit-aq-traceability.json';
const reviewPath = 'docs/implementation/verification/pdp-38/p0-capability-meaning-20-leaf-current-source-review-pxd216.json';
const currentnessCandidatePath = 'docs/implementation/observations/media-pdp0-currentness-refresh-2026-10-24/p0-capability-meaning-20-leaf-current-source-review-pxd216.successor.candidate.v6.json';
const aq155CurrentnessSuccessorPath = 'docs/implementation/observations/media-pdp0-currentness-refresh-2026-10-24/pdp0-aq-capability-current-source-review-155-308.successor.candidate.v1.json';
const aq309CurrentnessSuccessorPath = 'docs/implementation/observations/media-pdp0-currentness-refresh-2026-10-24/pdp0-aq-capability-current-source-review-309-462.successor.candidate.v1.json';
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');

test('PXD-216 remains historical semantic evidence while its successor carries current source pins', () => {
  const artifact = JSON.parse(fs.readFileSync(path.join(root, artifactPath), 'utf8'));
  const currentArtifact = JSON.parse(fs.readFileSync(path.join(root, currentArtifactPath), 'utf8'));
  const crosswalk = JSON.parse(fs.readFileSync(path.join(root, crosswalkPath), 'utf8'));
  const traceability = JSON.parse(fs.readFileSync(path.join(root, traceabilityPath), 'utf8'));
  const capabilityReview = JSON.parse(fs.readFileSync(path.join(root, reviewPath), 'utf8'));
  const currentnessCandidate = JSON.parse(fs.readFileSync(path.join(root, currentnessCandidatePath), 'utf8'));
  const aq155CurrentnessSuccessor = JSON.parse(fs.readFileSync(path.join(root, aq155CurrentnessSuccessorPath), 'utf8'));
  const aq309CurrentnessSuccessor = JSON.parse(fs.readFileSync(path.join(root, aq309CurrentnessSuccessorPath), 'utf8'));

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

  const pxd223PhasePins = currentPdp0PhaseScopedSourceFingerprints('PXD-223');
  assert.equal(artifact.sourceFingerprints['.product-experience/pdp-0-product-truth/capabilities.yaml'], '1c0daf9ee0cd600ec097baca0dded1d58d1803f6c147716a076705c37ad8cc26');
  assert.equal(currentArtifact.decisionRef, '.product-experience/decision-log.md#PXD-223');
  assert.equal(currentArtifact.currentSource.capabilitiesPath, '.product-experience/pdp-0-product-truth/capabilities.yaml');
  assert.equal(currentArtifact.currentSource.capabilitiesSha256, 'b688138bbdb6687a6f72b8faebbcd3fd24b4b0fcaef45131be431ab09ea3eeac',
    'PXD-223 preserves its historical currentness source cut');
  assert.notEqual(currentArtifact.currentSource.capabilitiesSha256, sha256('.product-experience/pdp-0-product-truth/capabilities.yaml'),
    'PXD-223 does not claim currentness for later live capabilities bytes');
  assert.equal(currentArtifact.decisionSectionSha256, pxd223PhasePins['.product-experience/decision-log.md#PXD-223-section']);
  assert.equal(currentArtifact.sourceCut.sourceCount, 2, 'PXD-223 binds its historical capabilities bytes and exact decision section');
  assert.equal(currentArtifact.preservedSemanticReview.reviewedCapabilityCount, 20);
  assert.deepEqual(currentArtifact.preservedSemanticReview.changedReviewedCapabilityIds, []);
  assert.equal(currentArtifact.preservedSemanticReview.currentReviewedRowsSha256,
    currentArtifact.preservedSemanticReview.historicalReviewedRowsSha256,
    'PXD-223 preserves the exact 20-row semantic projection');
  assert.equal(currentArtifact.currentSource.currentCapabilityRecordCount, 469);
  assert.equal(currentnessCandidate.semanticReviewRef, reviewPath);
  assert.equal(currentnessCandidate.currentSources['.product-experience/pdp-0-product-truth/capabilities.yaml'],
    sha256('.product-experience/pdp-0-product-truth/capabilities.yaml'),
    'the PXD-216 currentness-only successor binds current live bytes');
  assert.equal(currentnessCandidate.reviewedRowsSha256, currentArtifact.preservedSemanticReview.currentReviewedRowsSha256);
  assert.deepEqual(currentnessCandidate.changedReviewedCapabilityIds, []);
  assert.equal(currentnessCandidate.ownerApproval, 'NOT_CLAIMED');
  assert.equal(currentnessCandidate.independentAcceptance, 'NOT_CLAIMED');
  assert.equal(aq155CurrentnessSuccessor.predecessorRef,
    'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-aq-capability-current-source-review-155-308.json');
  assert.equal(aq155CurrentnessSuccessor.predecessorSha256,
    sha256(aq155CurrentnessSuccessor.predecessorRef), 'the historical 155-308 review remains immutable');
  assert.equal(aq155CurrentnessSuccessor.sourceSliceComparison.rowCount, 154);
  assert.equal(aq155CurrentnessSuccessor.sourceSliceComparison.semanticRowsIdentical, true);
  assert.deepEqual(aq155CurrentnessSuccessor.sourceSliceComparison.changedCapabilityIds, []);
  assert.equal(aq155CurrentnessSuccessor.sourceSliceComparison.historicalSemanticRowsSha256,
    aq155CurrentnessSuccessor.sourceSliceComparison.currentSemanticRowsSha256);
  assert.equal(aq155CurrentnessSuccessor.authority.ownerAcceptance, 'NOT_CLAIMED');
  assert.equal(aq155CurrentnessSuccessor.authority.independentReview, 'NOT_CLAIMED');
  assert.equal(aq155CurrentnessSuccessor.authority.semanticChange, 'NOT_CLAIMED');
  assert.equal(aq309CurrentnessSuccessor.predecessorRef,
    'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-aq-capability-current-source-review-309-462.json');
  assert.equal(aq309CurrentnessSuccessor.predecessorSha256,
    sha256(aq309CurrentnessSuccessor.predecessorRef), 'the historical 309-462 semantic findings remain immutable');
  assert.equal(aq309CurrentnessSuccessor.sourceSliceComparison.rowCount, 154);
  assert.equal(aq309CurrentnessSuccessor.sourceSliceComparison.semanticRowsIdentical, true);
  assert.deepEqual(aq309CurrentnessSuccessor.sourceSliceComparison.changedCapabilityIds, []);
  assert.equal(aq309CurrentnessSuccessor.sourceSliceComparison.historicalSemanticRowsSha256,
    aq309CurrentnessSuccessor.sourceSliceComparison.currentSemanticRowsSha256);
  assert.equal(aq309CurrentnessSuccessor.referencedRequirementComparison.referencedRequirementCount, 12);
  assert.deepEqual(aq309CurrentnessSuccessor.referencedRequirementComparison.changedReferencedRequirementIds, []);
  assert.equal(aq309CurrentnessSuccessor.authority.ownerAcceptance, 'NOT_CLAIMED');
  assert.equal(aq309CurrentnessSuccessor.authority.independentReview, 'NOT_CLAIMED');
  assert.equal(aq309CurrentnessSuccessor.authority.semanticChange, 'NOT_CLAIMED');
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
  const activePhasePins = currentPdp0PhaseScopedSourceFingerprints('PXD-225');
  assert.deepEqual(crosswalk.sourceBaseline.phaseScopedSourceFingerprintsSha256, activePhasePins);
  assert.deepEqual(crosswalk.coordinatorReview.phaseScopedSourceFingerprintsSha256, activePhasePins);
  assert.equal(crosswalk.coordinatorReview.decisionRef, 'PXD-225');
  assert.equal(crosswalk.coordinatorReview.priorDecisionRef, 'PXD-223');
  const priorCurrentness = crosswalk.coordinatorReview.reviewHistory.find(row => row.decisionRef === 'PXD-223');
  assert.ok(priorCurrentness, 'PXD-223 remains immutable capability-slice currentness history');
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
  const computedTraceability = buildPdp0AuditAqTraceability();
  const selectedRecipeExtension = computedTraceability.definitionExtensions.find(row => row.capabilityId === 'media.recipe.specification.compile');
  assert.equal(selectedRecipeExtension.versionScopeDisposition, 'SELECTED_FOR_CURRENT_VERSION_BY_PXD-226');
  assert.equal(selectedRecipeExtension.versionDecisionRef, '.product-experience/decision-log.md#PXD-226');
  assert.equal(selectedRecipeExtension.ownerApproval, 'NOT_CLAIMED');
  assert.equal(selectedRecipeExtension.independentAcceptance, 'NOT_CLAIMED');
  assert.equal(selectedRecipeExtension.executionAdmission, 'NOT_ADMITTED');
  assert.equal(computedTraceability.definitionExtensions.filter(row => row.versionScopeDisposition === 'DEFERRED_TO_LATER_GOVERNED_PDP0_VERSION').length, 6);
  const spec002Traceability = computedTraceability.rows.find(row => row.auditId === 'AUD-SPEC-002');
  assert.ok(spec002Traceability.canonicalCapabilityRefs.includes(
    '.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.recipe.specification.compile'));
  assert.ok(spec002Traceability.acceptanceCaseRefs.some(ref => ref.endsWith('MEDIA-REQ-CAP-RECIPE-TEMPLATE-AC-17')));
  assert.equal(spec002Traceability.traceabilityStatus, 'SOURCE_BOUND_COMPLETE', 'this status records exact link completeness only');
  assert.equal(spec002Traceability.featureSpecificCaseApplicability,
    'SOURCE_BOUND_CASE_LINK_EXISTS_BUT_FEATURE_SEMANTIC_FIT_IS_NOT_CLAIMED');
  assert.equal(spec002Traceability.priorFamilyCaseSemanticFitFinding.priorTraceabilityStatus,
    'SOURCE_BOUND_FAMILY_CASE_JOIN_SEMANTIC_FIT_REVIEW_REQUIRED');
  assert.match(spec002Traceability.priorFamilyCaseSemanticFitFinding.predecessorTraceabilityArtifactRef, /^HEAD:/u);
  assert.equal(computedTraceability.blockerSummary.priorFamilyCaseSemanticFitReviewRows.length, 1);
  assert.equal(computedTraceability.blockerSummary.priorFamilyCaseSemanticFitReviewRows[0].auditId, 'AUD-SPEC-002');
  assert.deepEqual(traceability, computedTraceability);
  assert.deepEqual(validatePdp0AuditAqTraceability().errors, []);
  assert.deepEqual(artifact.capabilityMeaningReview, {
    artifactRef: reviewPath,
    reviewedCapabilityCount: capabilityReview.reviewedCapabilityIds.length,
    reviewedCapabilityIds: capabilityReview.reviewedCapabilityIds,
    acceptanceEffect: 'none',
  });
});

test('PXD-225 advances archived-channel currentness and preserves PXD-216/PXD-223 evidence', () => {
  const successor = JSON.parse(fs.readFileSync(path.join(root, successorArtifactPath), 'utf8'));
  const pxd223 = JSON.parse(fs.readFileSync(path.join(root, currentArtifactPath), 'utf8'));
  const channelsPath = '.product-experience/pdp-0-product-truth/applications-channels.yaml';
  const decisionLog = '.product-experience/decision-log.md';
  const sectionPinKey = `${decisionLog}#PXD-225-section`;
  const phasePins = currentPdp0PhaseScopedSourceFingerprints('PXD-225');

  assert.equal(successor.decisionRef, `${decisionLog}#PXD-225`);
  assert.equal(successor.phaseScope, 'PDP-0');
  assert.equal(successor.preservedSemanticReview.decisionRef, `${decisionLog}#PXD-216`);
  assert.deepEqual(successor.preservedSemanticReview.reviewedCapabilityIds,
    JSON.parse(fs.readFileSync(path.join(root, reviewPath), 'utf8')).reviewedCapabilityIds);
  assert.deepEqual(successor.preservedSemanticReview.changedReviewedCapabilityIds, []);
  assert.equal(successor.preservedSemanticReview.currentReviewedRowsSha256,
    successor.preservedSemanticReview.historicalReviewedRowsSha256);
  assert.equal(successor.currentSource.channelsPath, channelsPath);
  assert.equal(successor.currentSource.channelsSha256, sha256(channelsPath));
  assert.equal(successor.decisionSectionSha256, phasePins[sectionPinKey]);
  assert.equal(successor.sourceCut.sourceCount, 2);
  assert.deepEqual(successor.predecessorRefs?.filter(ref => ref.includes('pxd223')), [currentArtifactPath]);
  assert.equal(successor.preservedCurrentnessPredecessor.decisionRef, pxd223.decisionRef);
  assert.equal(successor.preservedCurrentnessPredecessor.artifactRef, currentArtifactPath);
  assert.equal(successor.preservedCurrentnessPredecessor.capabilitiesSha256, pxd223.currentSource.capabilitiesSha256);
  assert.equal(successor.currentSource.evidenceLocatorVerification.removedPathCurrentTree, 'ABSENT');
  assert.equal(successor.currentSource.evidenceLocatorVerification.removedPathGitHistory, 'NO_COMMIT_PATH_FOUND');
  assert.equal(successor.currentSource.evidenceLocatorVerification.gitHistoryScope, 'COMPLETE_LOCAL_REPOSITORY_HISTORY');
  assert.equal(successor.currentSource.evidenceLocatorVerification.retainedPathCurrentTree, 'PRESENT');
  assert.equal(successor.currentSource.retainedEvidenceLocator,
    'archive/media-desktop-apps/desktop/README.md');
  assert.equal(pxd223.decisionRef, `${decisionLog}#PXD-223`, 'PXD-223 remains the historical capability-slice reconciliation');
  assert.equal(successor.authority.ownerApproval, 'NOT_CLAIMED');
  assert.equal(successor.authority.independentAcceptance, 'NOT_CLAIMED');
  assert.equal(successor.authority.acceptanceEffect, 'none');
});
