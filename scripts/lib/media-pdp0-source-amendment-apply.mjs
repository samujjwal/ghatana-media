import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {commitValidatedPdp0SourceAmendment} from './media-pdp0-review-successor-cas.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value);
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const TARGETS = [
  '.product-experience/pdp-0-product-truth/capabilities.yaml',
  '.product-experience/pdp-0-product-truth/requirements.yaml',
  'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json',
];
const OWNER_DECISION_REF = 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-owner-decision.v1.json';
const PEER_REVIEW_REF = 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-amendment-peer-review.v1.json';

function exactKeys(object, keys, label) {
  ensure(object && typeof object === 'object' && !Array.isArray(object)
    && canonical(Object.keys(object).sort()) === canonical(keys.slice().sort()), `${label} has missing or unrecognized fields`);
}

export function validatePdp0SourceAmendmentApplyAuthorization({authorization, plan, candidateText, decisionText, peerReviewText, postimageBytes}) {
  ensure(plan?.schemaVersion === 'media.pdp0.source-amendment-cas-plan.v1' && plan.planDisposition === 'REVIEWED_AWAITING_EXPLICIT_APPLY_AUTHORIZATION'
    && plan.blockers.length === 0, 'exact source amendment plan must have valid distinct owner and peer reviews');
  ensure(plan.targets.length === 3 && canonical(plan.targets.map(row => row.targetRef)) === canonical(TARGETS), 'plan target set is not the exact three approved sources');
  ensure(typeof candidateText === 'string' && sha(candidateText) === plan.candidateSha256, 'candidate bytes changed after review');
  ensure(typeof decisionText === 'string' && sha(Buffer.from(decisionText)) === plan.sourceOwnerDecisionSha256, 'source-owner decision bytes changed after review');
  ensure(typeof peerReviewText === 'string' && sha(Buffer.from(peerReviewText)) === plan.technicalPeerReviewSha256, 'technical peer review bytes changed after review');
  ensure(authorization && typeof authorization === 'object' && !Array.isArray(authorization), 'typed exact-postimage apply authorization is required');
  const keys = ['schemaVersion', 'effect', 'candidateRef', 'candidateSha256', 'candidatePostimageSha256', 'sourceOwnerDecisionRef', 'sourceOwnerDecisionSha256', 'technicalPeerReviewRef', 'technicalPeerReviewSha256', 'decisionRef', 'decisionSectionSha256', 'targetPostimages', 'technicalSourceOwner', 'distinctTechnicalPeer', 'authorityBoundary'];
  exactKeys(authorization, keys, 'apply authorization');
  exactKeys(authorization.technicalSourceOwner, ['identity', 'role'], 'apply technical source owner');
  exactKeys(authorization.distinctTechnicalPeer, ['identity', 'role', 'reviewedCandidateSha256', 'reviewedPostimageSha256'], 'apply distinct technical peer');
  exactKeys(authorization.authorityBoundary, ['ownerApproval', 'independentAcceptance', 'phaseStatusEffect', 'runtimeAdmission', 'nativeClosure'], 'apply authority boundary');
  const targets = Object.fromEntries(TARGETS.map(ref => [ref, plan.targets[TARGETS.indexOf(ref)].expectedPostimageSha256]));
  ensure(authorization.schemaVersion === 'media.pdp0.source-amendment-apply-authorization.v1'
    && authorization.effect === 'APPLY_EXACT_AUD_SPEC_002_SOURCE_AMENDMENT'
    && authorization.candidateRef === plan.candidateRef
    && authorization.candidateSha256 === plan.candidateSha256
    && authorization.candidatePostimageSha256 === plan.candidatePostimageSha256
    && authorization.sourceOwnerDecisionRef === plan.sourceOwnerDecisionRef
    && authorization.sourceOwnerDecisionSha256 === plan.sourceOwnerDecisionSha256
    && authorization.technicalPeerReviewRef === plan.technicalPeerReviewRef
    && authorization.technicalPeerReviewSha256 === plan.technicalPeerReviewSha256
    && authorization.decisionRef === plan.decisionRef
    && authorization.decisionSectionSha256 === plan.decisionSectionSha256
    && canonical(authorization.targetPostimages) === canonical(targets), 'apply authorization is not bound to this exact reviewed candidate, source cut, decision, peer, and all three postimages');
  ensure(authorization.technicalSourceOwner?.identity === 'agent:/root'
    && authorization.technicalSourceOwner.role === 'PDP0_SOURCE_OWNER', 'apply authorization must identify the delegated technical source owner');
  ensure(authorization.distinctTechnicalPeer?.role === 'DISTINCT_TECHNICAL_PEER'
    && authorization.distinctTechnicalPeer.identity === plan.peerIdentity
    && authorization.distinctTechnicalPeer.identity !== authorization.technicalSourceOwner.identity
    && authorization.distinctTechnicalPeer.reviewedCandidateSha256 === plan.candidateSha256
    && authorization.distinctTechnicalPeer.reviewedPostimageSha256 === plan.candidatePostimageSha256,
  'apply authorization does not bind the distinct peer to the exact candidate and three-file postimage');
  ensure(authorization.authorityBoundary?.ownerApproval === 'NOT_CLAIMED'
    && authorization.authorityBoundary.independentAcceptance === 'NOT_CLAIMED'
    && authorization.authorityBoundary.phaseStatusEffect === 'NONE'
    && authorization.authorityBoundary.runtimeAdmission === 'NOT_ADMITTED'
    && authorization.authorityBoundary.nativeClosure === 'NOT_CLAIMED', 'apply authorization cannot claim owner approval, acceptance, phase status, admission, or closure');
  ensure(postimageBytes && TARGETS.every((ref, index) => sha(postimageBytes[ref]) === plan.targets[index].expectedPostimageSha256), 'exact candidate postimage bytes changed after review');
  return {targetPostimages: targets};
}

export function applyPdp0SourceAmendment({root, authorization, plan, candidateText, decisionText, peerReviewText, sourceBytes, postimageBytes, fsOps = fs}) {
  validatePdp0SourceAmendmentApplyAuthorization({authorization, plan, candidateText, decisionText, peerReviewText, postimageBytes});
  ensure(sourceBytes && TARGETS.every(ref => Buffer.isBuffer(sourceBytes[ref])), 'exact reviewed source preimage bytes are required for CAS');
  return commitValidatedPdp0SourceAmendment({
    root,
    candidateSha256: plan.candidateSha256,
    decisionRef: plan.decisionRef,
    decisionSectionSha256: plan.decisionSectionSha256,
    applyAuthorizationSha256: sha(`${JSON.stringify(authorization, null, 2)}\n`),
    targets: plan.targets.map(row => ({...row, preimageBytes: sourceBytes[row.targetRef], postimageBytes: postimageBytes[row.targetRef]})),
    fsOps,
  });
}
