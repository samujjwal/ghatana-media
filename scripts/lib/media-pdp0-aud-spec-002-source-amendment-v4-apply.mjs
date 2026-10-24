import {createHash} from 'node:crypto';
import {fingerprintPxdDecisionSection} from './pdp0-phase-scoped-source-fingerprints.mjs';
import {commitValidatedPdp0SourceAmendmentV4} from './media-pdp0-review-successor-cas.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value);
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const FOLDER = 'docs/implementation/observations/pdp0-semantic-audit-slices';
export const AUD_SPEC_002_V4_TARGETS = Object.freeze([
  '.product-experience/pdp-0-product-truth/capabilities.yaml',
  '.product-experience/pdp-0-product-truth/requirements.yaml',
  `${FOLDER}/pdp0-501-disposition-crosswalk.json`,
  '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml',
]);
const CANDIDATE_REF = `${FOLDER}/AUD-SPEC-002-source-amendment-candidate.v4.json`;
const OWNER_DECISION_REF = `${FOLDER}/AUD-SPEC-002-source-owner-decision.v4.json`;
const PEER_REVIEW_REF = `${FOLDER}/AUD-SPEC-002-source-amendment-independent-peer.v4.json`;
const APPLY_AUTHORIZATION_REF = `${FOLDER}/AUD-SPEC-002-source-amendment-apply-authorization.v4.json`;
const SOURCE_OWNER = Object.freeze({identity: 'agent:/root', role: 'PDP0_SOURCE_OWNER'});

function exactKeys(value, keys, label) {
  ensure(value && typeof value === 'object' && !Array.isArray(value)
    && canonical(Object.keys(value).sort()) === canonical([...keys].sort()), `${label} has missing or unrecognized fields`);
}
function same(a, b) { return canonical(a) === canonical(b); }
function hashJson(value) { return sha(Buffer.from(`${JSON.stringify(value, null, 2)}\n`)); }

function validateOwnerDecision({decision, candidate, candidateSha256, targetPostimages, decisionLogText, sourceBindings}) {
  exactKeys(decision, ['schemaVersion','decisionKind','candidateRef','candidateSha256','candidatePostimageSha256','sourceBindings','targetPostimages','decisionRef','sourceOwner','disposition','authorityBoundary'], 'v4 source-owner decision');
  exactKeys(decision.sourceOwner, ['identity','role'], 'v4 source-owner principal');
  exactKeys(decision.authorityBoundary, ['ownerApproval','independentAcceptance','phaseStatusEffect','runtimeAdmission','nativeClosure'], 'v4 source-owner boundary');
  const pxd = typeof decision.decisionRef === 'string' ? decision.decisionRef.match(/^\.product-experience\/decision-log\.md#(PXD-\d{3})$/u) : null;
  ensure(pxd, 'source-owner decision must cite one exact PXD decision section');
  const decisionSectionSha256 = fingerprintPxdDecisionSection(decisionLogText, pxd[1]).sha256;
  ensure(decision.schemaVersion === 'media.pdp0.source-amendment-owner-decision.v4'
    && decision.decisionKind === 'EXACT_PDP0_SOURCE_AMENDMENT'
    && decision.candidateRef === CANDIDATE_REF
    && decision.candidateSha256 === candidateSha256
    && decision.candidatePostimageSha256 === candidate.candidatePostimageSha256
    && same(decision.sourceBindings, sourceBindings)
    && same(decision.targetPostimages, targetPostimages)
    && same(decision.sourceOwner, SOURCE_OWNER)
    && decision.disposition === 'APPROVE_EXACT_CANDIDATE_FOR_SOURCE_APPLY'
    && same(decision.authorityBoundary, {ownerApproval: 'NOT_CLAIMED', independentAcceptance: 'NOT_CLAIMED', phaseStatusEffect: 'NONE', runtimeAdmission: 'NOT_ADMITTED', nativeClosure: 'NOT_CLAIMED'}),
  'v4 source-owner decision is not current, exact, role-bound, or authority-safe');
  return {decisionSectionSha256, decisionRef: decision.decisionRef};
}

function validatePeerReview({peerReview, candidate, candidateSha256, targetPostimages, sourceBindings, sourceOwnerIdentity}) {
  exactKeys(peerReview, ['schemaVersion','auditId','candidateRef','candidateSha256','candidatePostimageSha256','targetPostimages','reviewer','disposition','authorityBoundary'], 'v4 peer review');
  exactKeys(peerReview.reviewer, ['identity','role','reviewedSourceBindings'], 'v4 peer reviewer');
  exactKeys(peerReview.authorityBoundary, ['ownerApproval','independentAcceptance','phaseStatusEffect','runtimeAdmission','nativeClosure'], 'v4 peer boundary');
  ensure(peerReview.schemaVersion === 'media.pdp0.source-amendment-peer-review.v4'
    && peerReview.auditId === 'AUD-SPEC-002'
    && peerReview.candidateRef === CANDIDATE_REF
    && peerReview.candidateSha256 === candidateSha256
    && peerReview.candidatePostimageSha256 === candidate.candidatePostimageSha256
    && same(peerReview.targetPostimages, targetPostimages)
    && same(peerReview.reviewer.reviewedSourceBindings, sourceBindings)
    && typeof peerReview.reviewer.identity === 'string'
    && peerReview.reviewer.identity !== sourceOwnerIdentity
    && peerReview.reviewer.role === 'DISTINCT_TECHNICAL_PEER'
    && peerReview.disposition === 'TECHNICALLY_REVIEWED_EXACT_POSTIMAGE'
    && same(peerReview.authorityBoundary, {ownerApproval: 'NOT_CLAIMED', independentAcceptance: 'NOT_CLAIMED', phaseStatusEffect: 'NONE', runtimeAdmission: 'NOT_ADMITTED', nativeClosure: 'NOT_CLAIMED'}),
  'v4 peer review is missing, self-authored, stale, or not bound to all four exact postimages');
  return peerReview.reviewer.identity;
}

function validateAuthorization({authorization, candidate, candidateSha256, ownerDecisionSha256, peerReviewSha256, decisionRef, decisionSectionSha256, targetPostimages, peerIdentity}) {
  exactKeys(authorization, ['schemaVersion','effect','candidateRef','candidateSha256','candidatePostimageSha256','sourceOwnerDecisionRef','sourceOwnerDecisionSha256','technicalPeerReviewRef','technicalPeerReviewSha256','decisionRef','decisionSectionSha256','targetPostimages','technicalSourceOwner','distinctTechnicalPeer','authorityBoundary'], 'v4 exact apply authorization');
  exactKeys(authorization.technicalSourceOwner, ['identity','role'], 'v4 apply source owner');
  exactKeys(authorization.distinctTechnicalPeer, ['identity','role','reviewedCandidateSha256','reviewedPostimageSha256'], 'v4 apply peer');
  exactKeys(authorization.authorityBoundary, ['ownerApproval','independentAcceptance','phaseStatusEffect','runtimeAdmission','nativeClosure'], 'v4 apply boundary');
  ensure(authorization.schemaVersion === 'media.pdp0.source-amendment-apply-authorization.v4'
    && authorization.effect === 'APPLY_EXACT_AUD_SPEC_002_SOURCE_AMENDMENT'
    && authorization.candidateRef === CANDIDATE_REF
    && authorization.candidateSha256 === candidateSha256
    && authorization.candidatePostimageSha256 === candidate.candidatePostimageSha256
    && authorization.sourceOwnerDecisionRef === OWNER_DECISION_REF
    && authorization.sourceOwnerDecisionSha256 === ownerDecisionSha256
    && authorization.technicalPeerReviewRef === PEER_REVIEW_REF
    && authorization.technicalPeerReviewSha256 === peerReviewSha256
    && authorization.decisionRef === decisionRef
    && authorization.decisionSectionSha256 === decisionSectionSha256
    && same(authorization.targetPostimages, targetPostimages)
    && same(authorization.technicalSourceOwner, SOURCE_OWNER)
    && authorization.distinctTechnicalPeer.identity === peerIdentity
    && authorization.distinctTechnicalPeer.identity !== SOURCE_OWNER.identity
    && authorization.distinctTechnicalPeer.role === 'DISTINCT_TECHNICAL_PEER'
    && authorization.distinctTechnicalPeer.reviewedCandidateSha256 === candidateSha256
    && authorization.distinctTechnicalPeer.reviewedPostimageSha256 === candidate.candidatePostimageSha256
    && same(authorization.authorityBoundary, {ownerApproval: 'NOT_CLAIMED', independentAcceptance: 'NOT_CLAIMED', phaseStatusEffect: 'NONE', runtimeAdmission: 'NOT_ADMITTED', nativeClosure: 'NOT_CLAIMED'}),
  'v4 apply authorization does not bind exact candidate, source-owner decision, peer, and every postimage');
}

/** Build a root-CAS-compatible plan. Missing real review/decision/auth records fail closed. */
export function planAudSpec002V4SourceApply({candidate, candidateText, rebuiltCandidate, sourceBindings, sourceBytes, postimageBytes, sourceOwnerDecision, sourceOwnerDecisionText, peerReview, peerReviewText, applyAuthorization, decisionLogText}) {
  ensure(typeof candidateText === 'string' && same(JSON.parse(candidateText), candidate), 'candidate object differs from exact frozen candidate bytes');
  const candidateSha256 = sha(Buffer.from(candidateText));
  ensure(candidate.schemaVersion === 'media.pdp0.aud-spec-002-source-amendment-candidate.v4'
    && candidate.auditId === 'AUD-SPEC-002' && candidate.canonicalApply === 'NOT_PERFORMED', 'exact non-applied v4 candidate is required');
  ensure(rebuiltCandidate && same(rebuiltCandidate, candidate), 'candidate differs from current source-bound reconstruction');
  ensure(same(candidate.sourceBindings, sourceBindings), 'current source bindings differ from frozen candidate');
  const targets = AUD_SPEC_002_V4_TARGETS.map(targetRef => {
    const preimageBytes = sourceBytes?.[targetRef];
    const postimageBytesForTarget = postimageBytes?.[targetRef];
    ensure(Buffer.isBuffer(preimageBytes) && Buffer.isBuffer(postimageBytesForTarget), `exact preimage and postimage bytes required for ${targetRef}`);
    const candidateTarget = candidate.exactFileTargets.find(row => row.targetRef === targetRef);
    ensure(candidateTarget && sha(preimageBytes) === candidateTarget.preimageSha256 && sha(postimageBytesForTarget) === candidateTarget.postimageSha256,
      `source bytes differ from frozen v4 target hashes for ${targetRef}`);
    return {targetRef, expectedPreimageSha256: candidateTarget.preimageSha256, expectedPostimageSha256: candidateTarget.postimageSha256, preimageBytes, postimageBytes: postimageBytesForTarget};
  });
  ensure(candidate.exactFileTargets.map(row => row.targetRef).join('\n') === AUD_SPEC_002_V4_TARGETS.join('\n'), 'candidate target order differs from the required four-file order');
  const targetPostimages = Object.fromEntries(targets.map(row => [row.targetRef, row.expectedPostimageSha256]));
  const candidateSha = candidateSha256;
  const {decisionSectionSha256, decisionRef} = validateOwnerDecision({decision: sourceOwnerDecision, candidate, candidateSha256: candidateSha, targetPostimages, decisionLogText, sourceBindings});
  const peerIdentity = validatePeerReview({peerReview, candidate, candidateSha256: candidateSha, targetPostimages, sourceBindings, sourceOwnerIdentity: SOURCE_OWNER.identity});
  const ownerDecisionSha256 = sha(Buffer.from(sourceOwnerDecisionText));
  const peerReviewSha256 = sha(Buffer.from(peerReviewText));
  validateAuthorization({authorization: applyAuthorization, candidate, candidateSha256: candidateSha, ownerDecisionSha256, peerReviewSha256, decisionRef, decisionSectionSha256, targetPostimages, peerIdentity});
  ensure(same(JSON.parse(sourceOwnerDecisionText), sourceOwnerDecision) && same(JSON.parse(peerReviewText), peerReview), 'review record objects differ from their exact source bytes');
  const plan = {
    schemaVersion: 'media.pdp0.source-amendment-cas-plan.v2',
    planKind: 'NON_MUTATING_EXACT_SOURCE_OWNER_MULTI_FILE_CAS_PLAN',
    planDisposition: 'REVIEWED_AWAITING_EXPLICIT_APPLY_AUTHORIZATION',
    candidateRef: CANDIDATE_REF,
    candidateSchemaVersion: candidate.schemaVersion,
    candidateSha256: candidateSha,
    candidatePostimageSha256: candidate.candidatePostimageSha256,
    sourceOwnerDecisionRef: OWNER_DECISION_REF,
    sourceOwnerDecisionSha256: ownerDecisionSha256,
    technicalPeerReviewRef: PEER_REVIEW_REF,
    technicalPeerReviewSha256: peerReviewSha256,
    decisionRef,
    decisionSectionSha256,
    applyAuthorizationSha256: hashJson(applyAuthorization),
    sourceOwnerIdentity: SOURCE_OWNER.identity,
    sourceOwnerRole: SOURCE_OWNER.role,
    peerIdentity,
    blockers: [],
    targets: targets.map(({targetRef, expectedPreimageSha256, expectedPostimageSha256}) => ({targetRef, expectedPreimageSha256, expectedPostimageSha256})),
    authorityBoundary: {ownerApproval: 'NOT_CLAIMED', independentAcceptance: 'NOT_CLAIMED', phaseStatusEffect: 'NONE', runtimeAdmission: 'NOT_ADMITTED', nativeClosure: 'NOT_CLAIMED'},
  };
  return {plan, targets};
}

/** Explicit effect entrypoint; caller must have current typed review and apply authorization. */
export function applyAudSpec002V4SourceAmendment({root, plan, targets, fsOps}) {
  ensure(plan?.schemaVersion === 'media.pdp0.source-amendment-cas-plan.v2' && plan.blockers?.length === 0,
    'v4 source amendment is not fully reviewed and authorized');
  return commitValidatedPdp0SourceAmendmentV4({root, plan, targets, ...(fsOps ? {fsOps} : {})});
}
