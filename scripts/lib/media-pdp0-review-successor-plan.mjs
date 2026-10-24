import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  PDP0_DIRECT_REVIEW_REF, PDP0_MATRIX_REF, PDP0_READINESS_REF, PDP0_REVIEW_INPUT_DIRECTORY, PDP0_STATUS_REF,
  buildPdp0CurrentSourceReviewCandidate, resolveReviewRecordFiles,
} from './media-pdp0-current-source-review-assembler.mjs';
import {commitValidatedPdp0ReviewPostimage} from './media-pdp0-review-successor-cas.mjs';
import {buildMediaPdp0CurrentnessObservation} from '../record-media-discovery-pdp0-currentness.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const canonical = value => JSON.stringify(value);
const REVIEW_PATH = 'docs/implementation/verification/pdp-38/direct-definition-criteria-review.json';
const DECISION_LOG = '.product-experience/decision-log.md';
const CANDIDATE_REF = 'docs/implementation/observations/media-pdp0-current-source-reviews-2026-10-23/candidate.v4.json';

function decisionSectionExists(text, ref) {
  const id = ref?.match(/^\.product-experience\/decision-log\.md#(PXD-\d{3})$/u)?.[1];
  if (!id) return false;
  return new RegExp(`^### ${id}(?:\\s|—)`, 'mu').test(text);
}

export function decisionSectionSha256(text, ref) {
  const id = ref?.match(/^\.product-experience\/decision-log\.md#(PXD-\d{3})$/u)?.[1];
  if (!id) return null;
  const marker = new RegExp(`^### ${id}(?:\\s|—).*?$`, 'gmu');
  const matches = [...text.matchAll(marker)];
  if (matches.length !== 1) return null;
  const start = matches[0].index;
  const rest = text.slice(start + matches[0][0].length);
  const next = rest.search(/^### PXD-\d{3}(?:\s|—)/mu);
  const end = next < 0 ? text.length : start + matches[0][0].length + next;
  return sha256(text.slice(start, end).trim());
}

export function planPdp0ReviewSuccessor({candidate, candidateText, directReview, directReviewText, decisionLogText, reviewRecords = {}}) {
  ensure(typeof directReviewText === 'string' && typeof candidateText === 'string', 'exact source text is required for compare-and-swap planning');
  const expectedDirectReviewSha256 = sha256(directReviewText);
  ensure(canonical(JSON.parse(directReviewText)) === canonical(directReview), 'supplied direct-review object differs from its exact source bytes');
  ensure(canonical(JSON.parse(candidateText)) === canonical(candidate), 'supplied candidate object differs from its exact source bytes');
  const missingCriterionIds = ['P0-01', 'P0-02', 'P0-03', 'P0-04', 'P0-05', 'P0-06', 'P0-07', 'P0-08'].filter(id => !reviewRecords[id]);
  const candidateSha256 = sha256(candidateText);
  const blockers = [];
  if (candidate.schemaVersion !== 'media.pdp0.current-source-review-candidate.v4'
      || candidate.artifactKind !== 'COORDINATOR_ASSEMBLED_TECHNICAL_SOURCE_REVIEW_INPUTS') blockers.push('CANDIDATE_KIND_INVALID');
  if (missingCriterionIds.length) blockers.push('EIGHT_CRITERION_REVIEW_INVENTORY_INCOMPLETE');
  const meaningFindings = (candidate.findings ?? []).filter(row => row.classification !== 'BLOCKED_EXTERNAL_INDEPENDENT');
  if (candidate.statusBoundary?.phaseStatusEffect !== 'NONE'
      || candidate.statusBoundary?.pdp010Acceptance !== 'NOT_PERFORMED'
      || candidate.statusBoundary?.independentAcceptance !== 'NOT_CLAIMED') blockers.push('CANDIDATE_AUTHORITY_BOUNDARY_INVALID');
  if (!decisionLogText || typeof decisionLogText !== 'string') blockers.push('SOURCE_OWNER_DECISION_CONTEXT_MISSING');
  return {
    schemaVersion: 'media.pdp0.current-source-review-successor-plan.v2',
    planKind: 'NON_MUTATING_COMPARE_AND_SWAP_REVIEW_SUCCESSOR_PLAN',
    canonicalTarget: REVIEW_PATH,
    expectedDirectReviewSha256,
    candidateRef: CANDIDATE_REF,
    candidateSha256,
    sourceCut: candidate.sourceCut,
    requiredCriterionIds: ['P0-01', 'P0-02', 'P0-03', 'P0-04', 'P0-05', 'P0-06', 'P0-07', 'P0-08'],
    missingCriterionIds,
    openMeaningFindingIds: meaningFindings.map(row => row.id),
    independentAcceptanceFindingIds: (candidate.findings ?? []).filter(row => row.classification === 'BLOCKED_EXTERNAL_INDEPENDENT').map(row => row.id),
    ownerDecisionRequirement: {
      schemaRef: 'docs/implementation/observations/media-pdp0-current-source-reviews-2026-10-23/revision-decision.v3.schema.json',
      decisionContextFile: DECISION_LOG,
      decisionRefMustExistAsExactPxdSection: true,
      technicalSourceOwnerRole: 'PDP0_SOURCE_OWNER',
      distinctTechnicalPeerRequired: true,
      requiredCandidateFingerprint: candidateSha256,
      requiredExpectedTargetFingerprint: expectedDirectReviewSha256,
    },
    predecessorPreservation: {
      mode: 'APPEND_ONLY_HISTORY; NEVER_REWRITE_PREDECESSOR_APPROVALS',
      retainedHistoricalReviewRefs: candidate.preservedHistoricalReviewRefs ?? [],
      currentCanonicalWritePermitted: false,
      reason: 'This plan cannot apply a canonical successor. A source-owner decision and current consumer-compatible revision schema are required; P0-010 acceptance and phase status are separate authorities.',
    },
    blockers,
    planDisposition: blockers.length ? 'BLOCKED' : meaningFindings.length ? 'AWAITING_TYPED_SOURCE_OWNER_FINDING_DISPOSITION' : 'AWAITING_TYPED_SOURCE_OWNER_DECISION',
    effects: {canonicalWrite: 'NOT_PERFORMED', phaseStatusEffect: 'NONE', independentAcceptance: 'NOT_CLAIMED', pdp010Acceptance: 'NOT_PERFORMED', nativeClosure: 'NOT_CLAIMED'},
  };
}

export function validatePdp0ReviewSuccessorDecision({decision, decisionLogText, plan, currentDirectReviewText}) {
  ensure(decision && typeof decision === 'object' && !Array.isArray(decision), 'typed source-owner decision is required');
  ensure(plan?.schemaVersion === 'media.pdp0.current-source-review-successor-plan.v2', 'current source-review successor plan is required');
  ensure(plan.blockers?.length === 0, `successor plan is blocked: ${(plan.blockers ?? []).join(', ')}`);
  const expectedKeys = ['schemaVersion', 'decisionKind', 'candidateRef', 'candidateSha256', 'expectedDirectReviewSha256', 'decisionRef', 'technicalSourceOwner', 'distinctTechnicalPeer', 'semanticDisposition', 'openMeaningFindingDisposition', 'authorityBoundary'];
  ensure(canonical(Object.keys(decision).sort()) === canonical([...expectedKeys].sort()), 'source-owner decision has missing or unknown fields');
  ensure(decision.schemaVersion === 'media.pdp0.current-source-review-successor-decision.v3' && decision.decisionKind === 'SOURCE_OWNER_TECHNICAL_REVIEW_SUCCESSOR', 'decision schema or kind is invalid');
  ensure(decision.candidateRef === plan.candidateRef && decision.candidateSha256 === plan.candidateSha256, 'decision is not bound to this exact assembled candidate');
  ensure(decision.expectedDirectReviewSha256 === plan.expectedDirectReviewSha256
    && sha256(currentDirectReviewText) === plan.expectedDirectReviewSha256, 'direct-review target changed since plan creation');
  ensure(decision.technicalSourceOwner?.role === 'PDP0_SOURCE_OWNER' && decision.technicalSourceOwner.identity === 'agent:/root', 'the typed decision must identify the delegated root PDP-0 technical source owner');
  ensure(decision.distinctTechnicalPeer?.role === 'DISTINCT_TECHNICAL_PEER'
    && typeof decision.distinctTechnicalPeer.identity === 'string'
    && decision.distinctTechnicalPeer.identity !== decision.technicalSourceOwner.identity
    && decision.distinctTechnicalPeer.reviewedCandidateSha256 === plan.candidateSha256, 'distinct peer must review the exact candidate');
  ensure(['SOURCE_REVIEW_SUCCESSOR_APPROVED', 'SOURCE_REVIEW_SUCCESSOR_REJECTED', 'SOURCE_REVIEW_SUCCESSOR_DEFERRED'].includes(decision.semanticDisposition), 'source-owner disposition is invalid');
  ensure(decision.openMeaningFindingDisposition?.unresolvedFindingIds?.length === 0, 'unresolved PDP-0 meaning findings prevent successor approval');
  const expectedMeaningFindingIds = [...plan.openMeaningFindingIds].sort();
  ensure(canonical(decision.openMeaningFindingDisposition?.resolvedFindingIds?.slice().sort()) === canonical(expectedMeaningFindingIds),
    'source-owner decision must disposition all and only current PDP-0 meaning findings');
  ensure(decision.openMeaningFindingDisposition?.decisionRef === decision.decisionRef, 'finding disposition must bind the source-owner decision ref');
  ensure(decision.authorityBoundary?.independentAcceptance === 'NOT_CLAIMED'
    && decision.authorityBoundary?.pdp010Acceptance === 'NOT_PERFORMED'
    && decision.authorityBoundary?.phaseStatusEffect === 'NONE'
    && decision.authorityBoundary?.nativeClosure === 'NOT_CLAIMED', 'decision cannot claim acceptance, phase status, or closure');
  ensure(decisionSectionExists(decisionLogText, decision.decisionRef), 'decisionRef must resolve to an exact existing PXD section in the owner decision log');
  return {valid: true, canonicalWritePermitted: false, reason: 'Validated decision input is still not a canonical postimage; source-owner workflow must define and review the consumer-compatible record successor before apply.', decisionRef: decision.decisionRef};
}

export function buildPdp0ReviewSuccessorPostimage({decision, decisionLogText, plan, candidate, directReview, currentDirectReviewText}) {
  const validated = validatePdp0ReviewSuccessorDecision({decision, decisionLogText, plan, currentDirectReviewText});
  ensure(validated.valid && decision.semanticDisposition === 'SOURCE_REVIEW_SUCCESSOR_APPROVED', 'only an explicitly approved source-owner disposition can produce a postimage candidate');
  const meaningFindingIds = (candidate.findings ?? []).filter(row => row.classification !== 'BLOCKED_EXTERNAL_INDEPENDENT').map(row => row.id).sort();
  ensure(canonical(decision.openMeaningFindingDisposition.resolvedFindingIds.slice().sort()) === canonical(meaningFindingIds), 'source-owner decision must classify every and only current PDP-0 meaning finding');
  ensure(directReview?.schemaVersion === 'media.pdp38-direct-definition-criteria-review.v1' && Array.isArray(directReview.records), 'existing direct-review authority artifact is required');
  ensure(candidate.criteria?.length === 8 && candidate.criteria.every((row, index) => row.criterionId === `P0-${String(index + 1).padStart(2, '0')}`), 'all eight ordered criterion reviews are required');
  const records = directReview.records.map(record => {
    if (!candidate.criteria.some(row => row.criterionId === record.taskId)) return record;
    const review = candidate.criteria.find(row => row.criterionId === record.taskId);
    ensure(review.authorityBoundary.ownerApproval === 'NOT_CLAIMED'
      && review.authorityBoundary.independentAcceptance === 'NOT_CLAIMED'
      && review.authorityBoundary.pdp010Acceptance === 'NOT_PERFORMED'
      && review.authorityBoundary.phaseStatusEffect === 'NONE', `${record.taskId} review authority boundary cannot be widened`);
    const priorCurrent = record.currentSourceReview;
    ensure(!priorCurrent || priorCurrent.decisionRef !== decision.decisionRef, `${record.taskId} already references this source-owner decision`);
    const history = [...(record.historicalCorrectiveReviews ?? [])];
    if (priorCurrent && !history.some(item => item.decisionRef === priorCurrent.decisionRef)) history.push(structuredClone(priorCurrent));
    const successorSourceFingerprints = Object.fromEntries(Object.entries(candidate.sourceCut.reviewedCurrentSourceFingerprints)
      .filter(([sourceRef]) => sourceRef !== PDP0_DIRECT_REVIEW_REF));
    const candidateReview = {
      status: 'APPROVED_CURRENT_SOURCE_REVIEW',
      decisionRef: decision.decisionRef,
      reviewKind: 'SOURCE_OWNER_TECHNICAL_CURRENT_SOURCE_REVIEW_SUCCESSOR',
      phaseScope: 'PDP-0',
      scope: `Structured current-source technical review for ${record.taskId}; exact findings and unknowns are in ${CANDIDATE_REF} (${plan.candidateSha256}).`,
      sourceFingerprints: successorSourceFingerprints,
      verification: {
        status: 'PASS',
        tests: review.criterionVerification.testCount,
        passed: review.criterionVerification.passedTestCount,
        failed: 0,
        evidenceRefs: [CANDIDATE_REF, review.criterionVerification.testReceiptRef],
      },
      acceptanceBoundary: 'PDP-0 source-owner technical review only; independent acceptance, P0-010, phase-status mutation, native closure, qualification, and Delivery remain separate.',
      acceptanceEffect: 'none',
      ownerApproval: 'NOT_CLAIMED',
      currentSourceCutNote: `Exact source cut and typed findings are recorded in ${CANDIDATE_REF}; prior review records are preserved in historicalCorrectiveReviews.`,
      reviewArtifactRef: CANDIDATE_REF,
    };
    return {...record, historicalCorrectiveReviews: history, currentSourceReview: candidateReview};
  });
  const postimage = {...directReview, records};
  return {
    schemaVersion: 'media.pdp0.current-source-review-postimage-candidate.v2',
    artifactKind: 'NON_CANONICAL_SOURCE_OWNER_REVIEW_SUCCESSOR_POSTIMAGE',
    targetRef: REVIEW_PATH,
    expectedTargetSha256: plan.expectedDirectReviewSha256,
    decisionRef: decision.decisionRef,
    candidateRef: CANDIDATE_REF,
    candidateSha256: plan.candidateSha256,
    postimage,
    postimageSha256: sha256(`${JSON.stringify(postimage, null, 2)}\n`),
    effects: {canonicalWrite: 'NOT_PERFORMED', phaseStatusEffect: 'NONE', independentAcceptance: 'NOT_CLAIMED', pdp010Acceptance: 'NOT_PERFORMED', nativeClosure: 'NOT_CLAIMED'},
    claimBoundary: 'Review successor postimage proposal only. It does not mutate the canonical direct-review artifact or PDP status and is not independent acceptance or closure.',
  };
}

export function applyPdp0ReviewSuccessorPostimage({root, authorization, fsOps = fs}) {
  ensure(typeof root === 'string' && root.length > 0, 'repository root is required');
  const canonicalTarget = PDP0_REVIEW_SUCCESSOR_TARGET;
  const targetPath = path.resolve(root, canonicalTarget);
  ensure(targetPath.startsWith(`${path.resolve(root)}${path.sep}`), 'canonical review target escapes repository root');
  const journalPath = path.resolve(root, `${PDP0_REVIEW_INPUT_DIRECTORY}/apply-journal.json`);
  const sourceOwnerDecisionRef = `${PDP0_REVIEW_INPUT_DIRECTORY}/source-owner-decision.v3.json`;
  const read = ref => fsOps.readFileSync(path.resolve(root, ref), 'utf8');
  const status = JSON.parse(read(PDP0_STATUS_REF));
  const readiness = JSON.parse(read(PDP0_READINESS_REF));
  const directReviewText = read(canonicalTarget);
  const directReview = JSON.parse(directReviewText);
  const matrix = JSON.parse(read(PDP0_MATRIX_REF));
  const reviewRecords = resolveReviewRecordFiles({read});
  const currentness = buildMediaPdp0CurrentnessObservation({
    preserveExistingObservedAt: true,
    observationOutputPath: 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r16.json',
  });
  ensure(currentness.summary.sourceCurrent === true
    && currentness.summary.consistencyStable === true
    && currentness.summary.sourceCellCurrentCount === 54
    && currentness.summary.sourceCellUnknownCount === 0
    && currentness.observation.materialPathDenominator?.uniquePaths === 207,
  'the exact current PDP-0 54-cell/207-path source cut is not current; canonical apply is blocked');
  const sourceInputs = {status, readiness, directReview, matrix, reviewRecords, read};
  const candidate = buildPdp0CurrentSourceReviewCandidate(sourceInputs);
  const candidateText = `${JSON.stringify(candidate, null, 2)}\n`;
  ensure(read(CANDIDATE_REF) === candidateText, 'persisted assembled candidate differs from a fresh source-bound rebuild');
  const plan = planPdp0ReviewSuccessor({candidate, candidateText, directReview, directReviewText, decisionLogText: read(DECISION_LOG), reviewRecords});
  const decisionText = read(sourceOwnerDecisionRef);
  const decision = JSON.parse(decisionText);
  const decisionSha256 = sha256(decisionText);
  const decisionLogText = read(DECISION_LOG);
  const postimageCandidate = buildPdp0ReviewSuccessorPostimage({decision, decisionLogText, plan, candidate, directReview, currentDirectReviewText: directReviewText});
  const postimageArtifactRef = `${PDP0_REVIEW_INPUT_DIRECTORY}/postimage.v3.json`;
  ensure(read(postimageArtifactRef) === `${JSON.stringify(postimageCandidate, null, 2)}\n`, 'persisted postimage artifact differs from a fresh rebuild; exact peer/root review is required');
  const postimageText = `${JSON.stringify(postimageCandidate.postimage, null, 2)}\n`;
  const postimageSha256 = sha256(postimageText);
  const candidateSha256 = sha256(candidateText);
  ensure(candidateSha256 === plan.candidateSha256 && postimageSha256 === postimageCandidate.postimageSha256, 'recomputed candidate or postimage fingerprint is inconsistent');
  const snapshotPath = path.resolve(root, `${PDP0_REVIEW_INPUT_DIRECTORY}/preimages/direct-review-${postimageCandidate.expectedTargetSha256}.json`);
  ensure(authorization && typeof authorization === 'object' && !Array.isArray(authorization), 'explicit typed apply authorization is required');
  const authKeys = ['schemaVersion', 'effect', 'canonicalTarget', 'expectedTargetSha256', 'candidateSha256', 'postimageSha256', 'sourceOwnerDecisionRef', 'sourceOwnerDecisionSha256', 'decisionRef', 'decisionSectionSha256', 'technicalSourceOwner', 'distinctTechnicalPeer', 'authorityBoundary'];
  ensure(canonical(Object.keys(authorization).sort()) === canonical(authKeys.slice().sort()), 'apply authorization has missing or unknown fields');
  ensure(authorization.schemaVersion === 'media.pdp0.current-source-review-apply-authorization.v3'
    && authorization.effect === 'APPLY_EXACT_SOURCE_REVIEW_SUCCESSOR_POSTIMAGE'
    && authorization.canonicalTarget === canonicalTarget
    && authorization.expectedTargetSha256 === postimageCandidate.expectedTargetSha256
    && authorization.postimageSha256 === postimageSha256
    && authorization.candidateSha256 === candidateSha256
    && authorization.sourceOwnerDecisionRef === sourceOwnerDecisionRef
    && authorization.sourceOwnerDecisionSha256 === decisionSha256
    && authorization.decisionRef === postimageCandidate.decisionRef,
  'apply authorization is not bound to this exact target, candidate, decision, and postimage');
  ensure(authorization.technicalSourceOwner?.identity === 'agent:/root' && authorization.technicalSourceOwner.role === 'PDP0_SOURCE_OWNER', 'apply authorization lacks the delegated technical source owner');
  ensure(authorization.distinctTechnicalPeer?.role === 'DISTINCT_TECHNICAL_PEER'
    && typeof authorization.distinctTechnicalPeer.identity === 'string'
    && authorization.distinctTechnicalPeer.identity !== authorization.technicalSourceOwner.identity
    && authorization.distinctTechnicalPeer.reviewedCandidateSha256 === authorization.candidateSha256
    && authorization.distinctTechnicalPeer.reviewedPostimageSha256 === postimageSha256
    && authorization.distinctTechnicalPeer.identity === decision.distinctTechnicalPeer.identity,
  'apply authorization peer did not review the exact candidate and postimage');
  ensure(authorization.authorityBoundary?.independentAcceptance === 'NOT_CLAIMED'
    && authorization.authorityBoundary?.pdp010Acceptance === 'NOT_PERFORMED'
    && authorization.authorityBoundary?.phaseStatusEffect === 'NONE'
    && authorization.authorityBoundary?.nativeClosure === 'NOT_CLAIMED', 'apply authorization cannot assert acceptance, phase status, or closure');
  const actualDecisionSectionSha256 = decisionSectionSha256(decisionLogText, authorization.decisionRef);
  ensure(actualDecisionSectionSha256 && actualDecisionSectionSha256 === authorization.decisionSectionSha256,
    'apply authorization is not bound to the exact existing source-owner PXD decision section');
  return commitValidatedPdp0ReviewPostimage({
    root,
    expectedTargetSha256: authorization.expectedTargetSha256,
    candidateSha256,
    postimageText,
    postimageSha256,
    decisionRef: authorization.decisionRef,
    decisionSectionSha256: actualDecisionSectionSha256,
    applyAuthorizationSha256: sha256(`${JSON.stringify(authorization, null, 2)}\n`),
    fsOps,
  });
}

export const PDP0_REVIEW_SUCCESSOR_TARGET = REVIEW_PATH;
