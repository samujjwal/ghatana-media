import {createHash} from 'node:crypto';
import YAML from 'yaml';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const PROPOSAL = 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates/cohort-03-source-amendment-proposals.r1.json';
const COHORT = 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates/cohort-03.r2.json';
const COHORT_PEER = 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates/cohort-03.r2.independent-peer.json';
const COHORT01 = 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates/cohort-01.r2.json';
const COHORT01_PEER = 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates/cohort-01.independent-peer.json';
const RESIDUAL = 'docs/implementation/observations/media-pdp0-p0-07-parent-case-residual-classification-2026-10-23.json';
const AUDIT = 'docs/implementation/references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json';
const CAP = '.product-experience/pdp-0-product-truth/capabilities.yaml';
const REQ = '.product-experience/pdp-0-product-truth/requirements.yaml';
const AUTH = '.product-experience/authority-map.yaml';
const STATUS = 'docs/implementation/pdp-0-phase-dev-status.json';
const REVIEWER = 'agent:/root/phase_io';
const PROPOSAL_IDS = Object.freeze([
  'AUD-OPS-001','AUD-OPS-002','AUD-OPS-003','AUD-OPS-006','AUD-OPS-017','AUD-OPS-019','AUD-QA-006','AUD-QA-011','AUD-QA-012',
  'AUD-SOCIAL-011','AUD-SPEC-005','AUD-TRUST-005','AUD-TRUST-006','AUD-TRUST-010','AUD-TRUST-014','AUD-TRUST-015','AUD-TRUST-018',
  'AUD-TTS-001','AUD-TTS-002','AUD-TTS-010',
]);

const technicalFindings = Object.freeze({
  'AUD-OPS-001': {status: 'TECHNICAL_PASS', rationale: 'The candidate separates declared provider/capability choices from effective job choices and requires exact authoritative lineage for the latter; it preserves UNKNOWN and forbids silent provider/cloud fallback.', conditions: ['Owner adoption must keep model/checkpoint, machine, license, purpose and policy evidence as separate exact bindings; discovery never implies qualification or admission.']},
  'AUD-OPS-002': {status: 'TECHNICAL_PASS', rationale: 'Exact engine/model/checkpoint/tokenizer/license declarations are distinguished from actual effective job selection, and missing or stale pins remain UNKNOWN/UNAVAILABLE.', conditions: ['The owner must not treat package/provider names as version or license evidence, or this definition as runtime qualification.']},
  'AUD-OPS-003': {status: 'TECHNICAL_PASS', rationale: 'The proposal limits the result to scoped observed or source-declared resource facts and explicitly denies inferring physical hardware or performance from a compatibility declaration.', conditions: ['Keep observed machine facts and declared support separate; unsupported resource dimensions remain UNKNOWN.']},
  'AUD-OPS-006': {status: 'TECHNICAL_PASS', rationale: 'Enrollment is an owner-issued, versioned disposition bound to worker identity, tenant/trust scope and authority; connectivity does not enroll a worker or permit dispatch.', conditions: ['No trusted enrollment issuer, isolation enforcement or remote execution is established by this source definition.']},
  'AUD-OPS-017': {status: 'TECHNICAL_PASS', rationale: 'Reuse is limited to identical source/profile/output/tenant/purpose/rights bindings and hash equality is explicitly insufficient; the proposal does not claim cache implementation.', conditions: ['Owner must retain rights revalidation and stale/cross-tenant miss or UNKNOWN behavior; caching mechanics remain later-phase work.']},
  'AUD-OPS-019': {status: 'TECHNICAL_PASS', rationale: 'The matrix is per declared OS/browser/hardware cell with exact evidence and explicit UNKNOWN/unsupported values, without extrapolation across platforms or qualification claims.', conditions: ['Each platform cell needs its own evidence; no capture/codec/release support follows from this definition.']},
  'AUD-QA-006': {status: 'TECHNICAL_PASS', rationale: 'DER is conditioned on reference labels, method and denominator; similarity remains a separate bounded observation and is not identity or human review.', conditions: ['The owner must define metric/method identities and keep absent labels/methods as UNKNOWN or abstention.']},
  'AUD-QA-011': {status: 'TECHNICAL_PASS', rationale: 'Placement is separated from measured readability/contrast and the proposal refuses pass/fail without an owner-defined threshold or evidence.', conditions: ['No face-safe or readability acceptance may be inferred from placement alone; thresholds require owner definition.']},
  'AUD-QA-012': {status: 'TECHNICAL_PASS', rationale: 'OCR observations are kept separate from permitted-use decisions, which require a separately authorized rights/legal owner; no legality conclusion is claimed.', conditions: ['Only an actual owner disposition can establish permitted use; OCR alone remains evidence, not clearance.']},
  'AUD-SOCIAL-011': {status: 'TECHNICAL_PASS', rationale: 'Displayed values remain linked to exact source fields and transformation; missing values are UNKNOWN and the candidate does not claim rendering or publication.', conditions: ['Owner must bind source units/time/context and preserve original values; chart animation/rendering remains implementation work.']},
  'AUD-SPEC-005': {status: 'TECHNICAL_PASS', rationale: 'The proposal binds versioned asset/model/provider/license and rights evidence into a reviewable snapshot while explicitly withholding admission, qualification and asset-consumption claims.', conditions: ['Snapshot presence must not be reused as current rights approval or an admitted compile result.']},
  'AUD-TRUST-005': {status: 'TECHNICAL_PASS', rationale: 'Revocation, retention, legal hold and erasure are distinct source-bound dispositions; request, authorization, observed effect and external readback are separated, with external completion UNKNOWN absent evidence.', conditions: ['Do not infer legal status or external erasure; effects and legal authority must come from their actual owners.']},
  'AUD-TRUST-006': {status: 'TECHNICAL_PASS', rationale: 'Credential creation and verification are distinct and exact-byte/trust-evidence bound; manifest presence is not signature validity or authenticity.', conditions: ['No signer, key, trust issuer, signature, delivery or credential verification is granted by this proposal.']},
  'AUD-TRUST-010': {status: 'TECHNICAL_PASS', rationale: 'Hash integrity, signature/trust, license and lineage are separate evidence outcomes; hash or manifest alone cannot yield verified provenance.', conditions: ['Every assurance must cite exact evidence; absent/invalid evidence remains UNKNOWN and no security proof is issued.']},
  'AUD-TRUST-014': {status: 'REQUEST_CHANGES', rationale: 'The proposal identifies exact source, subject, purpose, consent and requested transformations, but it still does not define which transformation dimensions are permitted after authorization. A request-preserving candidate is not a bounded recast outcome and leaves scope for arbitrary identity/likeness changes.', conditions: ['Add a source-owned bounded set of permitted recast transformation dimensions and an explicit unsupported/UNKNOWN/blocked result for every unlisted, ambiguous or out-of-scope transformation; preserve exact consent scope and prohibit identity/ownership inference. If the owner cannot define that boundary, keep the feature unresolved rather than treating this proposal as complete.']},
  'AUD-TRUST-015': {status: 'TECHNICAL_PASS', rationale: 'Cross-tenant reuse is constrained by exact tenant, purpose, source and rights bindings; attachment is not cache authorization and hash-only equivalence is rejected.', conditions: ['A mismatched or unknown tenant/rights scope must remain denied, miss or UNKNOWN; no cross-tenant disclosure follows.']},
  'AUD-TRUST-018': {status: 'TECHNICAL_PASS', rationale: 'Access restriction, deletion request, recorded effect and external readback are distinguished; confirmation requires exact authoritative effect/readback.', conditions: ['Do not interpret blocked access, request receipt or internal record as deletion completion.']},
  'AUD-TTS-001': {status: 'TECHNICAL_PASS', rationale: 'Voice-catalog search returns versioned declared choices and metadata while separating catalog presence from availability, license admission, effective choice and synthesis.', conditions: ['Missing or unindexed catalog coverage stays UNKNOWN; no default voice or engine availability is inferred.']},
  'AUD-TTS-002': {status: 'TECHNICAL_PASS', rationale: 'The candidate now binds requested choice separately and conditions effective engine/model/voice on exact authoritative job lineage; this resolves the R2 lineage issue without permitting silent substitution.', conditions: ['Keep effective values UNKNOWN without exact authoritative lineage/readback; requested values alone are not proof of execution.']},
  'AUD-TTS-010': {status: 'TECHNICAL_PASS', rationale: 'The revised proposal uses ordered exact input-text spans and states output-time/alignment/crossfade disposition separately, addressing the R2 source-span ambiguity; partial or unaligned chunks remain explicit.', conditions: ['Keep text boundaries distinct from media-time boundaries and make missing timing evidence UNKNOWN; no hidden truncation or render claim.']},
});

function parseRef(ref, files) {
  const [file, selector] = ref.split('#');
  ensure(file && selector && files[file], `unsupported or unresolved source selector: ${ref}`);
  const match = selector.match(/^(capabilities|requirements)\/@id=([^/]+)(?:\/acceptanceCases\/@id=([^/]+))?$/u);
  ensure(match, `unsupported source selector form: ${ref}`);
  const [collection, id, caseId] = [match[1], match[2], match[3]];
  const entry = files[file][collection]?.find(row => row.id === id);
  ensure(entry, `source selector does not resolve: ${ref}`);
  if (caseId) ensure(entry.acceptanceCases?.some(row => row.id === caseId), `acceptance-case selector does not resolve: ${ref}`);
}

export function buildCohort03SourceAmendmentPeer({proposalBytes, cohortBytes, cohortPeerBytes, cohort01Bytes, cohort01PeerBytes, residualBytes, auditBytes, capabilityBytes, requirementBytes, authorityMapBytes, phaseStatusBytes, assignmentBytes}) {
  const proposal = JSON.parse(proposalBytes.toString('utf8'));
  const cohort = JSON.parse(cohortBytes.toString('utf8'));
  const cohortPeer = JSON.parse(cohortPeerBytes.toString('utf8'));
  const audit = JSON.parse(auditBytes.toString('utf8'));
  const capabilities = YAML.parse(capabilityBytes.toString('utf8'));
  const requirements = YAML.parse(requirementBytes.toString('utf8'));
  const files = {[CAP]: capabilities, [REQ]: requirements};
  ensure(proposal.schemaVersion === 'ghatana.media.pdp0.source-amendment-proposals.v1'
    && proposal.scope?.criterionId === 'P0-07' && proposal.scope.cohortOrdinal === 3
    && proposal.scope.rowCount === 20 && proposal.rows?.length === 20, 'exact cohort-03 20-row source-amendment proposal is required');
  const proposalIdSet = new Set(proposal.rows.map(row => row.auditId));
  ensure(proposalIdSet.size === 20, 'proposal rows contain duplicate audit IDs');
  const r2MissingIds = cohort.rows.filter(row => row.proposedDecision === 'MISSING_PDP0_DEFINITION').map(row => row.auditId);
  ensure(canonicalList(r2MissingIds) === canonicalList(proposal.rows.map(row => row.auditId)), 'proposal membership differs from exact R2 missing-definition cohort');
  const r2PeerById = new Map(cohortPeer.rows.map(row => [row.auditId, row]));
  ensure(r2PeerById.size === cohortPeer.rows.length, 'R2 peer has duplicate audit IDs');
  const auditById = new Map(audit.originalAudit.inventory.map(row => [row.audit_id, row]));
  const baselineInputs = {
    [PROPOSAL]: proposalBytes, [COHORT]: cohortBytes, [COHORT_PEER]: cohortPeerBytes, [AUDIT]: auditBytes,
    [COHORT01]: cohort01Bytes, [COHORT01_PEER]: cohort01PeerBytes, [RESIDUAL]: residualBytes,
    [CAP]: capabilityBytes, [REQ]: requirementBytes, [AUTH]: authorityMapBytes, [STATUS]: phaseStatusBytes,
  };
  for (const [ref, expected] of Object.entries(proposal.sourceBaseline.fingerprints)) {
    if (ref.startsWith('/')) continue;
    const bytes = baselineInputs[ref];
    ensure(bytes && sha(bytes) === expected, `source baseline mismatch for ${ref}`);
  }
  const assignment = JSON.parse(assignmentBytes.toString('utf8'));
  const assigned = assignment.cohorts?.[2]?.expectedAuditIds;
  ensure(Array.isArray(assigned) && assigned.length === 77, 'authoritative cohort-03 assignment is missing');
  ensure(proposal.sourceBaseline.fingerprints[proposal.scope.membershipSource] === sha(assignmentBytes), 'proposal assignment fingerprint is stale');

  const rows = proposal.rows.map((row, index) => {
    const r2 = cohort.rows.find(item => item.auditId === row.auditId);
    const r2Peer = r2PeerById.get(row.auditId);
    const auditRecord = auditById.get(row.auditId);
    ensure(r2 && r2.proposedDecision === 'MISSING_PDP0_DEFINITION', `${row.auditId} is not an R2 missing-definition row`);
    ensure(r2Peer && auditRecord && auditRecord.capability === row.originalFeature.text, `row identity/source feature mismatch for ${row.auditId}`);
    ensure(row.proposedOwnerRole?.sourceRef === '.product-experience/authority-map.yaml#/phaseAuthorities/@phase=PDP-0'
      && row.proposedOwnerRole.status === 'SOURCE_DECLARED_SEMANTIC_OWNER; NO DECISION/ACCEPTANCE ASSERTED', `row has invalid owner declaration ${row.auditId}`);
    ensure(row.proposalStatus === 'SOURCE_AMENDMENT_CANDIDATE_PENDING_OWNER_REVIEW'
      && row.authorityDisposition === 'NO_OWNER_DECISION; OWNER_REVIEW_REQUIRED'
      && row.implementationEffect === 'NONE; PROPOSAL_ONLY', `row claims an owner disposition or effect ${row.auditId}`);
    const refs = [...row.exactCurrentCapabilityRefs, ...row.candidateCapabilityRefs, ...row.candidateRequirementRefs, ...row.candidateAcceptanceCaseRefs];
    refs.forEach(ref => parseRef(ref, files));
    const authored = technicalFindings[row.auditId];
    ensure(authored, `no independent technical finding for ${row.auditId}`);
    return {
      findingId: `MEDIA-PDP0-P0-07-C03-SOURCE-PEER-${String(index + 1).padStart(2, '0')}`,
      ordinal: index + 1,
      auditId: row.auditId,
      criterionId: row.criterionId,
      technicalDisposition: authored.status,
      canonicalOwnerDisposition: 'UNKNOWN_PENDING_AUTHENTIC_SOURCE_OWNER_DECISION',
      originalFeature: row.originalFeature,
      proposedMeaning: row.proposedPdp0Meaning,
      proposedAcceptanceCriterion: row.proposedAcceptanceCriterion,
      exactCurrentCapabilityRefs: row.exactCurrentCapabilityRefs,
      candidateCapabilityRefs: row.candidateCapabilityRefs,
      candidateRequirementRefs: row.candidateRequirementRefs,
      candidateAcceptanceCaseRefs: row.candidateAcceptanceCaseRefs,
      sourceEvidenceRefs: [...new Set([row.originalFeature.sourceRef, ...refs, '.product-experience/authority-map.yaml#/phaseAuthorities/@phase=PDP-0'])],
      priorR2PeerDisposition: r2Peer.independentStatus,
      priorR2PeerFindingId: r2Peer.findingId,
      rationale: authored.rationale,
      ownerReviewConditions: authored.conditions,
      nonClaims: ['No canonical source edit or PDP-0 owner decision is made.', 'No implementation, runtime, qualification, legal/security signoff, acceptance, or closure is claimed.'],
    };
  });
  const counts = Object.fromEntries(['TECHNICAL_PASS','REQUEST_CHANGES','UNKNOWN'].map(status => [status, rows.filter(row => row.technicalDisposition === status).length]));
  return {
    schemaVersion: 'ghatana.media.pdp0.parent-case-resolution-source-amendment-peer.v1',
    artifactId: 'MEDIA-PDP0-P0-07-COHORT-03-SOURCE-AMENDMENT-INDEPENDENT-PEER-2026-10-23',
    reviewStatus: 'TECHNICAL_PEER_REVIEW_ONLY_REQUEST_CHANGES',
    reviewKind: 'INDEPENDENT_TECHNICAL_REVIEW_OF_COHORT_03_SOURCE_AMENDMENT_PROPOSALS',
    reviewer: {identity: REVIEWER, role: 'DISTINCT_TECHNICAL_PEER', independentHumanReviewer: false, credentialedAttestation: false},
    campaign: {macroStage: 'DISCOVERY', exactPhase: 'PDP-0 Product Truth / P0-07', campaignDenominator: proposal.scope.campaignDenominator, cohortOrdinal: 3, cohortDenominator: 77, selectedProposalRows: 20},
    sourceBaseline: {
      proposalRef: PROPOSAL, proposalSha256: sha(proposalBytes),
      cohortR2Ref: COHORT, cohortR2Sha256: sha(cohortBytes), cohortR2PeerRef: COHORT_PEER, cohortR2PeerSha256: sha(cohortPeerBytes),
      sourceFingerprints: Object.fromEntries(Object.entries(baselineInputs).map(([ref, bytes]) => [ref, sha(bytes)])),
      assignmentManifestRef: proposal.scope.membershipSource, assignmentManifestSha256: sha(assignmentBytes),
      actualR2MissingDefinitionIds: r2MissingIds,
      exactProposalMembership: proposal.rows.map(row => row.auditId),
      liveSourceMismatches: [],
    },
    auditFindings: {rowCount: rows.length, technicalDispositionCounts: counts},
    rows,
    sourceAmendmentBoundary: {
      acceptedForTechnicalUse: rows.filter(row => row.technicalDisposition === 'TECHNICAL_PASS').map(row => row.auditId),
      requiresChanges: rows.filter(row => row.technicalDisposition === 'REQUEST_CHANGES').map(row => row.auditId),
      canonicalOwnerDisposition: 'UNKNOWN_PENDING_AUTHENTIC_SOURCE_OWNER_DECISION',
      phaseStatusEffect: 'NONE',
      noSourceApply: true,
    },
    excludedFromThisVerdict: {
      auditIds: ['AUD-SPEC-002'],
      reason: 'AUD-SPEC-002 is separately reviewed under the frozen v4 source-amendment candidate; this peer record does not assess that proposal.',
      relatedV4PeerRef: 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-amendment-independent-peer.v4.json',
    },
    nonClaims: ['Technical peer review is not source-owner adoption.', 'No independent human review, credentialed attestation, canonical source write, DEV_COMPLETE, PDP acceptance, runtime, qualification, or closure is claimed.'],
  };
}

function canonicalList(value) { return JSON.stringify(value); }

export function validateCohort03SourceAmendmentPeer(peer) {
  ensure(peer?.schemaVersion === 'ghatana.media.pdp0.parent-case-resolution-source-amendment-peer.v1'
    && peer.reviewStatus === 'TECHNICAL_PEER_REVIEW_ONLY_REQUEST_CHANGES'
    && peer.reviewer?.identity === REVIEWER && peer.reviewer.role === 'DISTINCT_TECHNICAL_PEER'
    && peer.reviewer.independentHumanReviewer === false && peer.reviewer.credentialedAttestation === false,
  'peer record identity, role, or non-claim boundary is invalid');
  ensure(peer.campaign?.campaignDenominator?.total === 54 && peer.campaign.cohortDenominator === 77
    && peer.campaign.selectedProposalRows === 20 && peer.rows?.length === 20,
  'peer record campaign or cohort denominator is invalid');
  const ids = peer.rows.map(row => row.auditId);
  ensure(new Set(ids).size === 20 && canonicalList(ids) === canonicalList(peer.sourceBaseline.exactProposalMembership), 'peer finding membership is duplicate or differs from exact proposal');
  ensure(peer.rows.every(row => row.canonicalOwnerDisposition === 'UNKNOWN_PENDING_AUTHENTIC_SOURCE_OWNER_DECISION'
    && row.nonClaims?.length >= 2 && Array.isArray(row.sourceEvidenceRefs) && row.sourceEvidenceRefs.length > 0),
  'peer findings cannot promote owner state or omit their source/non-claim boundary');
  const counts = Object.fromEntries(['TECHNICAL_PASS','REQUEST_CHANGES','UNKNOWN'].map(status => [status, peer.rows.filter(row => row.technicalDisposition === status).length]));
  ensure(canonicalList(counts) === canonicalList(peer.auditFindings.technicalDispositionCounts), 'peer disposition counts differ from row findings');
  ensure(peer.sourceAmendmentBoundary.phaseStatusEffect === 'NONE' && peer.sourceAmendmentBoundary.noSourceApply === true
    && peer.excludedFromThisVerdict.auditIds.includes('AUD-SPEC-002'), 'peer scope or effect boundary is invalid');
  return true;
}

export function cohort03SourceAmendmentPeerSchema() {
  const stringList = {type: 'array', items: {type: 'string', minLength: 1}};
  const hash = {type: 'string', pattern: '^[a-f0-9]{64}$'};
  const fingerprintProperties = {};
  for (const ref of [PROPOSAL, COHORT, COHORT_PEER, COHORT01, COHORT01_PEER, RESIDUAL, AUDIT, CAP, REQ, AUTH, STATUS]) fingerprintProperties[ref] = hash;
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'ghatana.media.pdp0.parent-case-resolution-source-amendment-peer.v1',
    type: 'object', additionalProperties: false,
    required: ['schemaVersion','artifactId','reviewStatus','reviewKind','reviewer','campaign','sourceBaseline','auditFindings','rows','sourceAmendmentBoundary','excludedFromThisVerdict','nonClaims'],
    properties: {
      schemaVersion: {const: 'ghatana.media.pdp0.parent-case-resolution-source-amendment-peer.v1'},
      artifactId: {const: 'MEDIA-PDP0-P0-07-COHORT-03-SOURCE-AMENDMENT-INDEPENDENT-PEER-2026-10-23'},
      reviewStatus: {const: 'TECHNICAL_PEER_REVIEW_ONLY_REQUEST_CHANGES'},
      reviewKind: {const: 'INDEPENDENT_TECHNICAL_REVIEW_OF_COHORT_03_SOURCE_AMENDMENT_PROPOSALS'},
      reviewer: {type: 'object', additionalProperties: false, required: ['identity','role','independentHumanReviewer','credentialedAttestation'], properties: {identity: {const: REVIEWER}, role: {const: 'DISTINCT_TECHNICAL_PEER'}, independentHumanReviewer: {const: false}, credentialedAttestation: {const: false}}},
      campaign: {type: 'object', additionalProperties: false, required: ['macroStage','exactPhase','campaignDenominator','cohortOrdinal','cohortDenominator','selectedProposalRows'], properties: {macroStage: {const: 'DISCOVERY'}, exactPhase: {const: 'PDP-0 Product Truth / P0-07'}, campaignDenominator: {type: 'object', required: ['physical','compositionsIncludingRoot','logical','total'], properties: {physical: {const: 26}, compositionsIncludingRoot: {const: 7}, logical: {const: 21}, total: {const: 54}}}, cohortOrdinal: {const: 3}, cohortDenominator: {const: 77}, selectedProposalRows: {const: 20}}},
      sourceBaseline: {type: 'object', additionalProperties: false, required: ['proposalRef','proposalSha256','cohortR2Ref','cohortR2Sha256','cohortR2PeerRef','cohortR2PeerSha256','sourceFingerprints','assignmentManifestRef','assignmentManifestSha256','actualR2MissingDefinitionIds','exactProposalMembership','liveSourceMismatches'], properties: {proposalRef: {const: PROPOSAL}, proposalSha256: hash, cohortR2Ref: {const: COHORT}, cohortR2Sha256: hash, cohortR2PeerRef: {const: COHORT_PEER}, cohortR2PeerSha256: hash, sourceFingerprints: {type: 'object', additionalProperties: false, required: Object.keys(fingerprintProperties), properties: fingerprintProperties}, assignmentManifestRef: {type: 'string', minLength: 1}, assignmentManifestSha256: hash, actualR2MissingDefinitionIds: {type: 'array', minItems: 20, maxItems: 20, items: {enum: PROPOSAL_IDS}}, exactProposalMembership: {type: 'array', minItems: 20, maxItems: 20, items: {enum: PROPOSAL_IDS}}, liveSourceMismatches: {type: 'array', maxItems: 0}}},
      auditFindings: {type: 'object', additionalProperties: false, required: ['rowCount','technicalDispositionCounts'], properties: {rowCount: {const: 20}, technicalDispositionCounts: {type: 'object', additionalProperties: false, required: ['TECHNICAL_PASS','REQUEST_CHANGES','UNKNOWN'], properties: {TECHNICAL_PASS: {type: 'integer', minimum: 0}, REQUEST_CHANGES: {type: 'integer', minimum: 1}, UNKNOWN: {const: 0}}}}},
      rows: {type: 'array', minItems: 20, maxItems: 20, items: {
        type: 'object', additionalProperties: false,
        required: ['findingId','ordinal','auditId','criterionId','technicalDisposition','canonicalOwnerDisposition','originalFeature','proposedMeaning','proposedAcceptanceCriterion','exactCurrentCapabilityRefs','candidateCapabilityRefs','candidateRequirementRefs','candidateAcceptanceCaseRefs','sourceEvidenceRefs','priorR2PeerDisposition','priorR2PeerFindingId','rationale','ownerReviewConditions','nonClaims'],
        properties: {
          findingId: {type: 'string', pattern: '^MEDIA-PDP0-P0-07-C03-SOURCE-PEER-[0-9]{2}$'}, ordinal: {type: 'integer', minimum: 1, maximum: 20}, auditId: {enum: PROPOSAL_IDS}, criterionId: {const: 'P0-07'},
          technicalDisposition: {enum: ['TECHNICAL_PASS','REQUEST_CHANGES']}, canonicalOwnerDisposition: {const: 'UNKNOWN_PENDING_AUTHENTIC_SOURCE_OWNER_DECISION'},
          originalFeature: {type: 'object', additionalProperties: false, required: ['text','acceptanceText','sourceRef'], properties: {text: {type: 'string', minLength: 1}, acceptanceText: {type: 'string', minLength: 1}, sourceRef: {type: 'string', minLength: 1}}},
          proposedMeaning: {type: 'object', additionalProperties: false, required: ['input','trigger','positiveOutcome','failureAndNegativeBehavior','authorityBoundary'], properties: {input: {type: 'string', minLength: 1}, trigger: {type: 'string', minLength: 1}, positiveOutcome: {type: 'string', minLength: 1}, failureAndNegativeBehavior: {type: 'string', minLength: 1}, authorityBoundary: {type: 'string', minLength: 1}}},
          proposedAcceptanceCriterion: {type: 'string', minLength: 1}, exactCurrentCapabilityRefs: stringList, candidateCapabilityRefs: stringList, candidateRequirementRefs: stringList, candidateAcceptanceCaseRefs: stringList, sourceEvidenceRefs: {type: 'array', minItems: 2, items: {type: 'string', minLength: 1}},
          priorR2PeerDisposition: {enum: ['PASS','REQUEST_CHANGES','UNKNOWN']}, priorR2PeerFindingId: {type: 'string', minLength: 1}, rationale: {type: 'string', minLength: 1}, ownerReviewConditions: {type: 'array', minItems: 1, items: {type: 'string', minLength: 1}}, nonClaims: {type: 'array', minItems: 2, items: {type: 'string', minLength: 1}},
        },
      }},
      sourceAmendmentBoundary: {type: 'object', additionalProperties: false, required: ['acceptedForTechnicalUse','requiresChanges','canonicalOwnerDisposition','phaseStatusEffect','noSourceApply'], properties: {acceptedForTechnicalUse: {type: 'array', items: {enum: PROPOSAL_IDS}}, requiresChanges: {type: 'array', minItems: 1, items: {enum: PROPOSAL_IDS}}, canonicalOwnerDisposition: {const: 'UNKNOWN_PENDING_AUTHENTIC_SOURCE_OWNER_DECISION'}, phaseStatusEffect: {const: 'NONE'}, noSourceApply: {const: true}}},
      excludedFromThisVerdict: {type: 'object', additionalProperties: false, required: ['auditIds','reason','relatedV4PeerRef'], properties: {auditIds: {const: ['AUD-SPEC-002']}, reason: {type: 'string', minLength: 1}, relatedV4PeerRef: {const: 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-amendment-independent-peer.v4.json'}}},
      nonClaims: {type: 'array', minItems: 2, items: {type: 'string', minLength: 1}},
    },
  };
}
