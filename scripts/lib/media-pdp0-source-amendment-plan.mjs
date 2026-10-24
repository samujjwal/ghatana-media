import {createHash} from 'node:crypto';
import {fingerprintPxdDecisionSection} from './pdp0-phase-scoped-source-fingerprints.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value);
const EXPECTED_TARGETS = Object.freeze([
  '.product-experience/pdp-0-product-truth/capabilities.yaml',
  '.product-experience/pdp-0-product-truth/requirements.yaml',
  'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json',
]);
const SOURCE_OWNER_IDENTITY = 'agent:/root';

function requireValue(ok, message) { if (!ok) throw new Error(message); }

function sameObject(a, b) {
  const normalize = value => Array.isArray(value) ? value.map(normalize)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]))
      : value;
  return canonical(normalize(a)) === canonical(normalize(b));
}

function exactKeys(object, keys, label) {
  requireValue(object && typeof object === 'object' && !Array.isArray(object)
    && canonical(Object.keys(object).sort()) === canonical(keys.slice().sort()), `${label} has missing or unrecognized fields`);
}

export function planPdp0SourceAmendmentCas({
  root, candidate, candidateText, rebuiltCandidate, sourceBytes, postimageBytes,
  decision = null, decisionText = null, peerReview = null, peerReviewText = null, decisionLogText = '',
}) {
  requireValue(typeof root === 'string' && root.length > 0, 'repository root is required');
  requireValue(typeof candidateText === 'string' && canonical(JSON.parse(candidateText)) === canonical(candidate),
    'candidate object differs from exact candidate source bytes');
  const candidateSha256 = sha(candidateText);
  requireValue(candidate.schemaVersion === 'media.pdp0.aud-spec-002-source-amendment-candidate.v2'
    && candidate.auditId === 'AUD-SPEC-002' && candidate.canonicalApply === 'NOT_PERFORMED',
  'exact AUD-SPEC-002 source amendment candidate v2 is required');
  requireValue(rebuiltCandidate && canonical(rebuiltCandidate) === canonical(candidate),
    'candidate differs from the current source-bound reconstruction');
  requireValue(Array.isArray(candidate.blockers) && candidate.blockers.includes('EXACT_ROOT_TECHNICAL_SOURCE_OWNER_DECISION_REQUIRED')
    && candidate.blockers.includes('DISTINCT_TECHNICAL_PEER_REVIEW_OF_EXACT_POSTIMAGE_REQUIRED'),
  'candidate must preserve both review requirements');
  const targets = EXPECTED_TARGETS.map((targetRef, index) => {
    const preimage = sourceBytes[targetRef];
    const postimage = postimageBytes[targetRef];
    requireValue(Buffer.isBuffer(preimage) && Buffer.isBuffer(postimage), `exact preimage and postimage bytes are required for ${targetRef}`);
    const expectedPreimageSha256 = sha(preimage);
    const expectedPostimageSha256 = sha(postimage);
    const candidateExpected = targetRef.endsWith('capabilities.yaml') ? candidate.exactTargetFilePostimageSha256.capabilitiesYaml
      : targetRef.endsWith('requirements.yaml') ? candidate.exactTargetFilePostimageSha256.requirementsYaml
        : candidate.crosswalkPostimageSha256;
    requireValue(expectedPostimageSha256 === candidateExpected, `rebuilt postimage hash differs from the exact candidate for ${targetRef}`);
    return {
      targetRef, expectedPreimageSha256, expectedPostimageSha256,
      immutablePreimageRef: `docs/implementation/observations/pdp0-semantic-audit-slices/source-amendment-preimages/${candidateSha256}/${index}-${targetRef.split('/').at(-1)}`,
    };
  });
  requireValue(canonical(targets.map(row => row.targetRef)) === canonical(EXPECTED_TARGETS), 'target set differs from the exact three approved PDP-0 sources');
  const sourceBindings = candidate.sourceBindings;
  const reviewBlockers = [];
  let decisionSectionSha256 = null;
  if (!decision) reviewBlockers.push('EXACT_ROOT_SOURCE_OWNER_DECISION_REQUIRED');
  else {
    exactKeys(decision, ['schemaVersion', 'decisionKind', 'candidateRef', 'candidateSha256', 'candidatePostimageSha256', 'sourceBindings', 'targetPostimages', 'decisionRef', 'sourceOwner', 'disposition', 'authorityBoundary'], 'source-owner decision');
    exactKeys(decision.sourceOwner, ['identity', 'role'], 'source-owner decision principal');
    exactKeys(decision.authorityBoundary, ['ownerApproval', 'independentAcceptance', 'phaseStatusEffect', 'runtimeAdmission'], 'source-owner decision authority boundary');
    const refMatch = typeof decision.decisionRef === 'string' && decision.decisionRef.match(/^\.product-experience\/decision-log\.md#(PXD-\d{3})$/u);
    const pxdDigest = refMatch ? fingerprintPxdDecisionSection(decisionLogText, refMatch[1]).sha256 : null;
    const targetPostimages = Object.fromEntries(targets.map(target => [target.targetRef, target.expectedPostimageSha256]));
    const valid = decision.schemaVersion === 'media.pdp0.source-amendment-owner-decision.v1'
      && decision.decisionKind === 'EXACT_PDP0_SOURCE_AMENDMENT'
      && decision.candidateSha256 === candidateSha256
      && decision.candidatePostimageSha256 === candidate.candidatePostimageSha256
      && sameObject(decision.sourceBindings, sourceBindings)
      && sameObject(decision.targetPostimages, targetPostimages)
      && decision.candidateRef === 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-amendment-candidate.v2.json'
      && decision.sourceOwner?.identity === SOURCE_OWNER_IDENTITY
      && decision.sourceOwner?.role === 'PDP0_SOURCE_OWNER'
      && decision.disposition === 'APPROVE_EXACT_CANDIDATE_FOR_SOURCE_APPLY'
      && decision.authorityBoundary?.ownerApproval === 'NOT_CLAIMED'
      && decision.authorityBoundary?.independentAcceptance === 'NOT_CLAIMED'
      && decision.authorityBoundary?.phaseStatusEffect === 'NONE'
      && decision.authorityBoundary?.runtimeAdmission === 'NOT_ADMITTED'
      && decisionText && canonical(JSON.parse(decisionText)) === canonical(decision)
      && pxdDigest;
    if (!valid) reviewBlockers.push('SOURCE_OWNER_DECISION_INVALID_OR_NOT_BOUND_TO_ALL_POSTIMAGES');
    else decisionSectionSha256 = pxdDigest;
  }
  if (!peerReview) reviewBlockers.push('DISTINCT_TECHNICAL_PEER_REVIEW_REQUIRED');
  else {
    exactKeys(peerReview, ['schemaVersion', 'candidateRef', 'candidateSha256', 'candidatePostimageSha256', 'targetPostimages', 'reviewer', 'disposition', 'authorityBoundary'], 'technical peer review');
    exactKeys(peerReview.reviewer, ['identity', 'role', 'reviewedSourceBindings'], 'technical peer principal');
    exactKeys(peerReview.authorityBoundary, ['ownerApproval', 'independentAcceptance', 'phaseStatusEffect', 'runtimeAdmission'], 'technical peer authority boundary');
    const targetPostimages = Object.fromEntries(targets.map(target => [target.targetRef, target.expectedPostimageSha256]));
    const valid = peerReview.schemaVersion === 'media.pdp0.source-amendment-peer-review.v1'
      && peerReview.candidateRef === 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-amendment-candidate.v2.json'
      && peerReview.candidateSha256 === candidateSha256
      && peerReview.candidatePostimageSha256 === candidate.candidatePostimageSha256
      && sameObject(peerReview.targetPostimages, targetPostimages)
      && typeof peerReview.reviewer?.identity === 'string'
      && peerReview.reviewer.identity !== decision?.sourceOwner?.identity
      && peerReview.reviewer.role === 'DISTINCT_TECHNICAL_PEER'
      && peerReview.disposition === 'TECHNICALLY_REVIEWED_EXACT_POSTIMAGE'
      && peerReviewText && canonical(JSON.parse(peerReviewText)) === canonical(peerReview)
      && peerReview.reviewer?.reviewedSourceBindings && sameObject(peerReview.reviewer.reviewedSourceBindings, sourceBindings)
      && peerReview.authorityBoundary?.ownerApproval === 'NOT_CLAIMED'
      && peerReview.authorityBoundary?.independentAcceptance === 'NOT_CLAIMED'
      && peerReview.authorityBoundary?.phaseStatusEffect === 'NONE'
      && peerReview.authorityBoundary?.runtimeAdmission === 'NOT_ADMITTED';
    if (!valid) reviewBlockers.push('PEER_REVIEW_INVALID_SELF_REVIEW_OR_POSTIMAGE_MISMATCH');
  }
  const plan = {
    schemaVersion: 'media.pdp0.source-amendment-cas-plan.v1',
    planKind: 'NON_MUTATING_EXACT_SOURCE_OWNER_MULTI_FILE_CAS_PLAN',
    candidateRef: 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-amendment-candidate.v2.json',
    candidateSha256,
    candidatePostimageSha256: candidate.candidatePostimageSha256,
    sourceBindings: candidate.sourceBindings,
    targets,
    sourceOwnerDecisionRef: 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-owner-decision.v1.json',
    technicalPeerReviewRef: 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-amendment-peer-review.v1.json',
    decisionRef: decision?.decisionRef ?? null,
    decisionSectionSha256,
    sourceOwnerDecisionSha256: decisionText ? sha(Buffer.from(decisionText)) : null,
    technicalPeerReviewSha256: peerReviewText ? sha(Buffer.from(peerReviewText)) : null,
    peerIdentity: peerReview?.reviewer?.identity ?? null,
    blockers: reviewBlockers,
    planDisposition: reviewBlockers.length ? 'BLOCKED_AWAITING_EXACT_OWNER_AND_PEER_RECORDS' : 'REVIEWED_AWAITING_EXPLICIT_APPLY_AUTHORIZATION',
    applyAuthorization: {
      ref: 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-amendment-apply-authorization.v1.json',
      requiredFields: ['schemaVersion', 'effect', 'candidateSha256', 'candidatePostimageSha256', 'sourceOwnerDecisionSha256', 'technicalPeerReviewSha256', 'targetPostimages', 'decisionRef', 'authorityBoundary'],
      currentStatus: 'NOT_PROVIDED',
    },
    journalRef: `docs/implementation/observations/pdp0-semantic-audit-slices/source-amendment-journals/${candidateSha256}.json`,
    effects: {canonicalWrite: 'NOT_PERFORMED', sourceStatus: 'UNCHANGED', applicability: 'UNCHANGED', independentAcceptance: 'NOT_CLAIMED', nativeClosure: 'NOT_CLAIMED'},
  };
  return plan;
}
