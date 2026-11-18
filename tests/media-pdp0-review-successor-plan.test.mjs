import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {planPdp0ReviewSuccessor, validatePdp0ReviewSuccessorDecision, buildPdp0ReviewSuccessorPostimage} from '../scripts/lib/media-pdp0-review-successor-plan.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
function base() {
  const directReview = {schemaVersion: 'media.pdp38-direct-definition-criteria-review.v1', records: [{taskId: 'P0-01', status: 'APPROVED_DIRECT_DEFINITION_CRITERION', historicalCorrectiveReviews: [{decisionRef: 'PXD-OLD'}]}]};
  const directReviewText = `${JSON.stringify(directReview)}\n`;
  const candidate = {
    schemaVersion: 'media.pdp0.current-source-review-candidate.v1', artifactKind: 'COORDINATOR_ASSEMBLED_TECHNICAL_SOURCE_REVIEW_INPUTS',
    sourceCut: {sourceRecordSha256: 'a'.repeat(64)}, preservedHistoricalReviewRefs: ['PXD-OLD'],
    findings: [
      {id: 'P0-07-FAMILY-CASE-SEMANTIC-FIT-UNKNOWN-231', classification: 'UNKNOWN_REVIEW_REQUIRED'},
      {id: 'P0-08-P0-010-INDEPENDENT-OUTCOME-ABSENT', classification: 'BLOCKED_EXTERNAL_INDEPENDENT'},
    ],
    statusBoundary: {phaseStatusEffect: 'NONE', pdp010Acceptance: 'NOT_PERFORMED', independentAcceptance: 'NOT_CLAIMED'},
  };
  const candidateText = `${JSON.stringify(candidate)}\n`;
  const decisionLogText = '### PXD-900 Source review successor\nsource-owner:authorized-fixture is the PDP0_SOURCE_OWNER and records a SOURCE_REVIEW_SUCCESSOR disposition. This decision authorizes peer:media-pdp0-test as an ACTIVE DISTINCT_TECHNICAL_REVIEWER for PDP-0 current-source review.\n';
  const plan = planPdp0ReviewSuccessor({candidate, candidateText, directReview, directReviewText, decisionLogText, reviewRecords: {}});
  return {directReviewText, candidateText, decisionLogText, plan};
}

test('successor planning is compare-and-swap only and retains independent acceptance as a separate finding', () => {
  const {plan} = base();
  assert.equal(plan.planDisposition, 'BLOCKED');
  assert.deepEqual(plan.missingCriterionIds, ['P0-01', 'P0-02', 'P0-03', 'P0-04', 'P0-05', 'P0-06', 'P0-07', 'P0-08']);
  assert.deepEqual(plan.openMeaningFindingIds, ['P0-07-FAMILY-CASE-SEMANTIC-FIT-UNKNOWN-231']);
  assert.deepEqual(plan.independentAcceptanceFindingIds, ['P0-08-P0-010-INDEPENDENT-OUTCOME-ABSENT']);
  assert.equal(plan.expectedDirectReviewSha256, digest(base().directReviewText));
  assert.equal(plan.predecessorPreservation.currentCanonicalWritePermitted, false);
  assert.equal(plan.ownerDecisionRequirement.peerIdentityAloneIsSufficient, false);
  assert.equal(plan.effects.phaseStatusEffect, 'NONE');
});

test('rejects stale target and identity-only peer claims before any canonical effect', () => {
  const {plan, directReviewText, decisionLogText} = base();
  const decision = {
    schemaVersion: 'media.pdp0.current-source-review-successor-decision.v3', decisionKind: 'SOURCE_OWNER_TECHNICAL_REVIEW_SUCCESSOR',
    candidateRef: plan.candidateRef, candidateSha256: plan.candidateSha256, expectedDirectReviewSha256: plan.expectedDirectReviewSha256,
    decisionRef: '.product-experience/decision-log.md#PXD-900',
    technicalSourceOwner: {identity: 'source-owner:recorded', role: 'PDP0_SOURCE_OWNER'},
    distinctTechnicalPeer: {identity: 'peer:unverified', role: 'DISTINCT_TECHNICAL_PEER', reviewedCandidateSha256: plan.candidateSha256},
    semanticDisposition: 'SOURCE_REVIEW_SUCCESSOR_APPROVED',
    openMeaningFindingDisposition: {resolvedFindingIds: [], unresolvedFindingIds: ['P0-07-FAMILY-CASE-SEMANTIC-FIT-UNKNOWN-231'], decisionRef: '.product-experience/decision-log.md#PXD-900'},
    authorityBoundary: {independentAcceptance: 'NOT_CLAIMED', pdp010Acceptance: 'NOT_PERFORMED', phaseStatusEffect: 'NONE', nativeClosure: 'NOT_CLAIMED'},
  };
  assert.throws(() => validatePdp0ReviewSuccessorDecision({decision, decisionLogText, plan, currentDirectReviewText: directReviewText}), /plan is blocked/u);
  const unblocked = {...plan, blockers: []};
  decision.openMeaningFindingDisposition.resolvedFindingIds = ['P0-07-FAMILY-CASE-SEMANTIC-FIT-UNKNOWN-231'];
  decision.openMeaningFindingDisposition.unresolvedFindingIds = [];
  assert.throws(() => validatePdp0ReviewSuccessorDecision({decision, decisionLogText, plan: unblocked, currentDirectReviewText: `${directReviewText} `}), /target changed/u);
  decision.openMeaningFindingDisposition.unresolvedFindingIds = [];
  assert.throws(() => validatePdp0ReviewSuccessorDecision({decision, decisionLogText, plan: unblocked, currentDirectReviewText: directReviewText}), /source-bound review artifact/u);
  assert.equal(plan.effects.canonicalWrite, 'NOT_PERFORMED');
});

test('builds exact append-history postimage from a complete candidate without writing canonical authority', () => {
  const {directReviewText, decisionLogText} = base();
  const directReview = JSON.parse(directReviewText);
  directReview.records = Array.from({length: 8}, (_, index) => ({
    taskId: `P0-${String(index + 1).padStart(2, '0')}`,
    status: 'APPROVED_DIRECT_DEFINITION_CRITERION',
    historicalCorrectiveReviews: [{decisionRef: `.product-experience/decision-log.md#PXD-${300 + index}`}],
    ...(index % 2 === 0 ? {currentSourceReview: {status: 'APPROVED_CURRENT_SOURCE_REVIEW', decisionRef: `.product-experience/decision-log.md#PXD-${220 + index}`, phaseScope: 'PDP-0'}} : {}),
  }));
  const currentText = `${JSON.stringify(directReview)}\n`;
  const criteria = Array.from({length: 8}, (_, index) => ({
    criterionId: `P0-${String(index + 1).padStart(2, '0')}`,
    findings: [], knownUnknowns: [],
    reviewedSourceFingerprints: {'.product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md': 'a'.repeat(64)},
    criterionVerification: {testCount: 2, passedTestCount: 2, testReceiptRef: `docs/implementation/verification/pdp-38/P0-${String(index + 1).padStart(2, '0')}.log`},
    authorityBoundary: {ownerApproval: 'NOT_CLAIMED', independentAcceptance: 'NOT_CLAIMED', pdp010Acceptance: 'NOT_PERFORMED', phaseStatusEffect: 'NONE'},
  }));
  const candidate = {schemaVersion: 'media.pdp0.current-source-review-candidate.v4', artifactKind: 'COORDINATOR_ASSEMBLED_TECHNICAL_SOURCE_REVIEW_INPUTS', sourceCut: {reviewedCurrentSourceFingerprints: {'.product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md': 'a'.repeat(64)}}, criteria, findings: [], preservedHistoricalReviewRefs: [], statusBoundary: {phaseStatusEffect: 'NONE', pdp010Acceptance: 'NOT_PERFORMED', independentAcceptance: 'NOT_CLAIMED'}};
  const candidateText = `${JSON.stringify(candidate)}\n`;
  const reviewRecords = Object.fromEntries(criteria.map(row => [row.criterionId, {}]));
  const plan = planPdp0ReviewSuccessor({candidate, candidateText, directReview, directReviewText: currentText, decisionLogText, reviewRecords});
  const ownerAuthorityRef = 'docs/implementation/observations/media-pdp0-current-source-reviews-2026-10-23/test-reviewer-authority.json';
  const peerReviewRef = 'docs/implementation/observations/media-pdp0-current-source-reviews-2026-10-23/test-peer-review.json';
  const authorityRecordText = `${JSON.stringify({schemaVersion: 'media.pdp0.technical-reviewer-authority.v1', status: 'ACTIVE', reviewerIdentity: 'peer:media-pdp0-test', role: 'DISTINCT_TECHNICAL_REVIEWER', authorizedScopes: ['PDP-0 current-source review'], authorityRef: '.product-experience/decision-log.md#PXD-900'}, null, 2)}\n`;
  const peerRecord = {
    schemaVersion: 'media.pdp0.current-source-review-peer-record.v1',
    recordKind: 'DISTINCT_TECHNICAL_SOURCE_REVIEW',
    reviewer: {identity: 'peer:media-pdp0-test', role: 'DISTINCT_TECHNICAL_PEER'},
    reviewerAuthority: {recordRef: ownerAuthorityRef, recordSha256: digest(authorityRecordText)},
    candidateRef: plan.candidateRef,
    candidateSha256: plan.candidateSha256,
    expectedDirectReviewSha256: plan.expectedDirectReviewSha256,
    assessment: 'PASS',
    findings: [],
    authorityBoundary: {ownerApproval: 'NOT_CLAIMED', independentAcceptance: 'NOT_CLAIMED', pdp010Acceptance: 'NOT_PERFORMED', phaseStatusEffect: 'NONE', nativeClosure: 'NOT_CLAIMED'},
  };
  const peerRecordText = `${JSON.stringify(peerRecord, null, 2)}\n`;
  const read = ref => {
    if (ref === ownerAuthorityRef) return authorityRecordText;
    if (ref === peerReviewRef) return peerRecordText;
    throw new Error(`missing fixture source: ${ref}`);
  };
  const decision = {
    schemaVersion: 'media.pdp0.current-source-review-successor-decision.v3', decisionKind: 'SOURCE_OWNER_TECHNICAL_REVIEW_SUCCESSOR',
    candidateRef: plan.candidateRef, candidateSha256: plan.candidateSha256, expectedDirectReviewSha256: plan.expectedDirectReviewSha256,
    decisionRef: '.product-experience/decision-log.md#PXD-900',
    technicalSourceOwner: {identity: 'source-owner:authorized-fixture', role: 'PDP0_SOURCE_OWNER'},
    distinctTechnicalPeer: {identity: 'peer:media-pdp0-test', role: 'DISTINCT_TECHNICAL_PEER', reviewedCandidateSha256: plan.candidateSha256, reviewRecordRef: peerReviewRef, reviewRecordSha256: digest(peerRecordText)},
    semanticDisposition: 'SOURCE_REVIEW_SUCCESSOR_APPROVED',
    openMeaningFindingDisposition: {resolvedFindingIds: [], unresolvedFindingIds: [], decisionRef: '.product-experience/decision-log.md#PXD-900'},
    authorityBoundary: {independentAcceptance: 'NOT_CLAIMED', pdp010Acceptance: 'NOT_PERFORMED', phaseStatusEffect: 'NONE', nativeClosure: 'NOT_CLAIMED'},
  };
  const postimage = buildPdp0ReviewSuccessorPostimage({decision, decisionLogText, plan, candidate, directReview, currentDirectReviewText: currentText, read});
  assert.equal(postimage.effects.canonicalWrite, 'NOT_PERFORMED');
  assert.equal(postimage.postimage.records.length, 8);
  assert.equal(postimage.postimage.records[0].currentSourceReview.decisionRef, decision.decisionRef);
  assert.equal(postimage.postimage.records[0].historicalCorrectiveReviews.length, 2);
  assert.equal(postimage.postimage.records[1].currentSourceReview.decisionRef, decision.decisionRef);
  assert.equal(postimage.postimage.records[1].historicalCorrectiveReviews.length, 1);
  assert.equal(postimage.postimage.records[0].currentSourceReview.ownerApproval, 'NOT_CLAIMED');
});
