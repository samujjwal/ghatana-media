import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import YAML from 'yaml';
import {buildCohort02R5} from './build-media-pdp0-cohort02-r5-amendment.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const CAP = '.product-experience/pdp-0-product-truth/capabilities.yaml';
const REQ = '.product-experience/pdp-0-product-truth/requirements.yaml';
const LEAF = '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml';
const AUTHORITY = '.product-experience/authority-map.yaml';
const R5 = `${DIR}/cohort-02.r5.json`;
const R5_CANDIDATE = `${DIR}/cohort-02.source-amendment-candidate.r5.json`;
const R5_POSTIMAGES = `${DIR}/cohort-02.source-amendment-postimages.r5.json`;
const R5_PEER = `${DIR}/cohort-02.r5.independent-typed-source-peer.v1.json`;
const OWNER_AUTHORITY_REF = `${AUTHORITY}#/canonicalPdpPhases/@id=PDP-0/semanticOwner`;

const readBytes = (ref) => fs.readFileSync(path.join(ROOT, ref));
const readJson = (ref) => JSON.parse(readBytes(ref).toString('utf8'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const capSelector = (id) => `${CAP}#capabilities/@id=${id}`;
const caseSelector = (id, index) => `${capSelector(id)}/acceptanceCases/${index}`;
const reqSelector = (id) => `${REQ}#requirements/@id=${id}`;
const jsonText = (value) => JSON.stringify(value);

function need(condition, message) {
  if (!condition) throw new Error(`Cohort-02 R6 refused: ${message}`);
}

function validateR5Lineage(r5, r5Candidate, r5Postimages, peer, rebuiltR5) {
  need(peer.reviewStatus === 'REQUEST_CHANGES', 'the source-bound R5 peer review must remain a REQUEST_CHANGES predecessor');
  need(peer.sourceBaseline.proposalSha256 === sha(jsonBytes(r5)), 'R5 peer is stale against the retained R5 proposal');
  need(peer.sourceBaseline.candidateSha256 === sha(jsonBytes(r5Candidate)), 'R5 peer is stale against the retained R5 candidate');
  need(peer.sourceBaseline.postimageSha256 === sha(jsonBytes(r5Postimages)), 'R5 peer is stale against the retained R5 semantic postimage');
  need(peer.findings.length === 25 && peer.reviewSummary?.requestChangesRows === 21, 'R5 peer findings no longer match the frozen 25-finding/21-row report');
  need(JSON.stringify(rebuiltR5.artifact) === JSON.stringify(r5), 'R5 builder inputs changed from frozen history');
  need(JSON.stringify(rebuiltR5.candidate) === JSON.stringify(r5Candidate), 'R5 candidate no longer matches its builder');
  need(JSON.stringify(rebuiltR5.sourceAmendment) === JSON.stringify(r5Postimages), 'R5 postimages no longer match their builder');
}

function featureCriterionForOperation(row, capability) {
  const criterion = row.sourceAcceptanceCriterion;
  if (/\bimport\b/iu.test(capability.operation) && /\bexport\b/iu.test(criterion)) {
    return {text: null, disposition: 'SOURCE_ROW_EXPORT_CRITERION_RETAINED_AS_PROVENANCE; NOT_BOUND_TO_IMPORT_OPERATION'};
  }
  return {text: criterion, disposition: 'SOURCE_ROW_CRITERION_APPLIES_TO_MAPPED_OPERATION'};
}

function renderFeatureCases({row, capability, criterion}) {
  const definition = capability.ownerDefinition;
  const operationSelector = `${capability.id}.${capability.operation}`;
  const sourceFeature = row.featureText;
  const criterionText = criterion.text
    ? ` Apply source criterion: “${criterion.text}”.`
    : ' The source row criterion is retained separately because it describes an export operation, not this import operation.';
  return [
    {
      given: `The source feature “${sourceFeature}” requests the mapped ${capability.operation} operation with current typed input slots ${jsonText(definition.typedInputSlots)} and eligible authority ${jsonText(capability.requiredAuthority)}.`,
      when: `Invoke ${operationSelector} for the mapped feature operation.${criterionText}`,
      then: `Return the current declared success output shape ${jsonText(definition.successOutputs)} and preserve the owner outcome ${definition.semanticOutcomeContract.result}${criterion.text ? ` Source criterion: “${criterion.text}”.` : ''}`
    },
    {
      given: `The source feature “${sourceFeature}” requests ${operationSelector} with current typed input slots ${jsonText(definition.typedInputSlots)}, but authority ${jsonText(capability.requiredAuthority[0])} is denied or one of the exact unsupported conditions ${jsonText(capability.explicitUnsupportedCases)} applies.`,
      when: `Admission evaluates ${operationSelector} against its current declared guards.`,
      then: `Do not return a success output. Preserve the exact non-success boundary ${jsonText(definition.nonSuccessOutputs)}, error values ${jsonText(definition.errors)}, and authority requirements ${jsonText(capability.requiredAuthority)}; uncertain consequential outcomes remain UNKNOWN_OUTCOME.`
    }
  ];
}

function buildCohort02R6() {
  const r5 = readJson(R5);
  const r5Candidate = readJson(R5_CANDIDATE);
  const r5Postimages = readJson(R5_POSTIMAGES);
  const r5Peer = readJson(R5_PEER);
  const rebuiltR5 = buildCohort02R5();
  validateR5Lineage(r5, r5Candidate, r5Postimages, r5Peer, rebuiltR5);

  const capabilityBytes = readBytes(CAP);
  const requirementBytes = readBytes(REQ);
  const leafBytes = readBytes(LEAF);
  need(sha(capabilityBytes) === r5Candidate.sourceBindings.capabilitiesPreimageSha256, 'live capability preimage is stale against R5');
  need(sha(requirementBytes) === r5Candidate.sourceBindings.requirementsPreimageSha256, 'live requirement preimage is stale against R5');
  need(sha(leafBytes) === r5Candidate.sourceBindings.capabilityLeafReviewSha256, 'live leaf-review baseline is stale against R5');

  const capabilityDoc = YAML.parseDocument(capabilityBytes.toString('utf8'), {uniqueKeys: true});
  const requirementDoc = YAML.parseDocument(requirementBytes.toString('utf8'), {uniqueKeys: true});
  need(capabilityDoc.errors.length === 0 && requirementDoc.errors.length === 0, 'current PDP-0 capability or requirement YAML is invalid');
  const capabilityNodes = capabilityDoc.get('capabilities', true).items;
  const capabilityById = new Map(capabilityNodes.map((node) => [node.get('id', true)?.toJSON(), node]));
  const requirementIds = new Set(requirementDoc.get('requirements', true).items.map((node) => node.get('id', true)?.toJSON()));
  const baseCaseCountByCapability = new Map(capabilityNodes.map((node) => [node.get('id', true)?.toJSON(), node.get('acceptanceCases', true)?.items?.length ?? 0]));
  const nextCaseOffsetByCapability = new Map();
  const featureCases = [];

  for (const priorRow of rebuiltR5.artifact.exactFeatureCasePostimages) {
    const node = capabilityById.get(priorRow.capabilityId);
    need(node, `mapped capability ${priorRow.capabilityId} for ${priorRow.auditId} is missing`);
    const capability = node.toJSON();
    const ownerDefinition = capability.ownerDefinition;
    need(typeof capability.operation === 'string' && capability.operation && ownerDefinition?.typedInputSlots?.length > 0 && ownerDefinition?.successOutputs?.length > 0, `live operation/inputs/outputs are incomplete for ${priorRow.capabilityId}`);
    const cases = node.get('acceptanceCases', true);
    need(cases && Array.isArray(cases.items), `live capability ${priorRow.capabilityId} has no acceptanceCases sequence`);
    const baseCount = baseCaseCountByCapability.get(priorRow.capabilityId);
    const offset = nextCaseOffsetByCapability.get(priorRow.capabilityId) ?? 0;
    const pairStartIndex = baseCount + offset;
    const criterion = featureCriterionForOperation(priorRow, capability);
    const renderedCases = renderFeatureCases({row: priorRow, capability, criterion});
    for (const record of renderedCases) cases.add(capabilityDoc.createNode(record));
    nextCaseOffsetByCapability.set(priorRow.capabilityId, offset + renderedCases.length);

    const directRequirementIds = capability.requirementIds;
    need(Array.isArray(directRequirementIds) && directRequirementIds.length > 0, `live capability ${capability.id} has no direct requirementIds binding`);
    for (const requirementId of directRequirementIds) need(requirementIds.has(requirementId), `capability ${capability.id} is bound to missing requirement ${requirementId}`);
    const sourceParentRequirementRefs = priorRow.parentRequirementRefs ?? [];
    featureCases.push({
      ...priorRow,
      operation: capability.operation,
      parentRequirementIds: directRequirementIds,
      parentRequirementRefs: directRequirementIds.map(reqSelector),
      sourceFeatureParentRequirementRefs: sourceParentRequirementRefs,
      sourceFeatureParentRequirementDisposition: 'PRESERVED_AS_AUDIT_PROVENANCE; DIRECT_CASE_BINDING_USES_LIVE_CAPABILITY_REQUIREMENT_IDS',
      sourceAcceptanceCriterionApplication: criterion.disposition,
      cases: renderedCases,
      preimageCaseCount: baseCount,
      postimageCaseRefs: [caseSelector(capability.id, pairStartIndex), caseSelector(capability.id, pairStartIndex + 1)],
      caseIndexesUsePreimageBasePlusPriorBatchOffset: true,
      peerRationale: {...priorRow.peerRationale, sourceGap: priorRow.peerRationale?.sourceGap ?? priorRow.sourceGap},
      caseSemanticBasis: 'CURRENT_CAPABILITY_OWNER_DEFINITION_AND_OPERATION_COMPATIBLE_SOURCE_FEATURE',
      noCanonicalOwnerDecisionClaimed: true
    });
  }

  const capabilityPostimage = Buffer.from(capabilityDoc.toString());
  const requirementPostimage = Buffer.from(requirementBytes);
  const sourceBindings = {
    r5ProposalSha256: sha(readBytes(R5)),
    r5CandidateSha256: sha(readBytes(R5_CANDIDATE)),
    r5PostimagesSha256: sha(readBytes(R5_POSTIMAGES)),
    r5PeerSha256: sha(readBytes(R5_PEER)),
    capabilitiesPreimageSha256: sha(capabilityBytes),
    requirementsPreimageSha256: sha(requirementBytes),
    capabilityLeafReviewSha256: sha(leafBytes),
    authorityMapSha256: sha(readBytes(AUTHORITY)),
    phaseStatusSha256: sha(readBytes('docs/implementation/pdp-0-phase-dev-status.json')),
    capabilitiesPostimageSha256: sha(capabilityPostimage),
    requirementsPostimageSha256: sha(requirementPostimage)
  };

  const meaningOptions = rebuiltR5.artifact.missingMeaningRootDecisionOptions.map((option) => ({
    ...option,
    concreteFeatureProposal: {
      ...option.concreteFeatureProposal,
      accountableSourceOwner: 'media-product',
      accountableSourceOwnerAuthorityRef: OWNER_AUTHORITY_REF,
      ownerAdoptionStatus: 'UNKNOWN'
    },
    sourceOwnerRole: 'media-product',
    sourceOwnerAuthorityRef: OWNER_AUTHORITY_REF,
    ownerAdoptionStatus: 'UNKNOWN'
  }));
  need(meaningOptions.length === 9, `expected 9 owner role fields to resolve, found ${meaningOptions.length}`);
  const overlaps = rebuiltR5.artifact.overlapRootDecisionOptions;
  const targets = [
    {targetRef: CAP, preimageSha256: sourceBindings.capabilitiesPreimageSha256, postimageSha256: sourceBindings.capabilitiesPostimageSha256, postimageRef: `${DIR}/cohort-02.source-amendment-capabilities.postimage.r6.yaml`, semanticMutationCount: 60, acceptanceCaseRecordCount: 120},
    {targetRef: REQ, preimageSha256: sourceBindings.requirementsPreimageSha256, postimageSha256: sourceBindings.requirementsPostimageSha256, postimageRef: `${DIR}/cohort-02.source-amendment-requirements.postimage.r6.yaml`, semanticMutationCount: 0}
  ];
  const historicalLeafAdjudications = {targetRef: LEAF, preimageSha256: sourceBindings.capabilityLeafReviewSha256, historicalAdjudicationCount: 462, mutation: 'NONE; all 462 base owner adjudications and unrelated review fields are preserved.'};
  const r5FindingCounts = Object.groupBy(r5Peer.findings, (finding) => finding.code);
  const fixedFindings = {
    POSTIMAGE_CASE_REFERENCE_INDEX_MISMATCH: 8,
    PARENT_REQUIREMENT_NOT_DIRECTLY_BOUND_TO_TARGET_CAPABILITY: 7,
    SOURCE_CRITERION_MISMATCH_FOR_IMPORT_OPERATION: 1,
    SOURCE_OWNER_FIELD_MISMATCH: 9
  };
  for (const [code, count] of Object.entries(fixedFindings)) need((r5FindingCounts[code]?.length ?? 0) === count, `R5 finding count drift for ${code}`);

  const artifact = {
    schemaVersion: 'ghatana.media.pdp0.parent-case-resolution-candidates.v6',
    artifactId: 'media-pdp0-parent-case-resolution-cohort-02-r6',
    status: 'SOURCE_GROUNDED_R6_REPAIRS_READY_FOR_DISTINCT_SOURCE_CONTENT_PEER_REVIEW_AND_ROOT_DECISIONS',
    predecessorRef: R5,
    predecessorSha256: sourceBindings.r5ProposalSha256,
    predecessorCandidateRef: R5_CANDIDATE,
    predecessorCandidateSha256: sourceBindings.r5CandidateSha256,
    predecessorWasApplied: false,
    r5PeerReviewRef: R5_PEER,
    r5PeerReviewSha256: sourceBindings.r5PeerSha256,
    r5PeerReviewDisposition: 'REQUEST_CHANGES',
    r5FindingsAddressed: fixedFindings,
    sourceBindings,
    scope: {...rebuiltR5.artifact.scope, amendmentOrdinal: 6, featureRows: 44, distinctRebindRows: 9, rebindTargetOperations: 16, casePairs: 60, caseRecords: 120},
    rows: rebuiltR5.artifact.rows,
    exactFeatureCasePostimages: featureCases,
    missingMeaningRootDecisionOptions: meaningOptions,
    overlapRootDecisionOptions: overlaps,
    reusedPeerSupportedRows: rebuiltR5.artifact.reusedPeerSupportedRows,
    exactTargetPostimages: targets,
    historicalLeafAdjudications,
    sourceOwnerRole: {role: 'media-product', authorityRef: OWNER_AUTHORITY_REF, ownerAdoption: 'UNKNOWN'},
    rootOwnerDecision: 'PENDING; R6 selects no root option',
    distinctSourceContentPeerReview: 'REQUIRED; R5 REQUEST_CHANGES IS NOT AN R6 PASS',
    canonicalSourceWrite: 'NOT_PERFORMED',
    independentAcceptance: 'NOT_CLAIMED',
    nativeClosure: 'NOT_CLAIMED',
    runtimeAdmission: 'NOT_ADMITTED'
  };
  const sourceAmendment = {
    schemaVersion: 'ghatana.media.pdp0.cohort02.source-amendment-batch.v6',
    artifactKind: 'NON_CANONICAL_EXACT_SOURCE_AMENDMENT_CANDIDATE',
    candidateRef: `${DIR}/cohort-02.source-amendment-candidate.r6.json`,
    proposalRef: `${DIR}/cohort-02.r6.json`,
    failedHistory: {
      r4: {proposalRef: `${DIR}/cohort-02.r4.json`, peerRef: `${DIR}/cohort-02.r4.independent-peer.v1.json`, disposition: 'PRESERVED_FAILED_REVIEW; NEVER_APPLIED'},
      r5: {proposalRef: R5, peerRef: R5_PEER, peerSha256: sourceBindings.r5PeerSha256, disposition: 'PRESERVED_REQUEST_CHANGES; NEVER_APPLIED'}
    },
    sourceBindings,
    exactTargetPostimages: targets,
    capabilityCasePostimages: featureCases,
    requirementChanges: [],
    rootChoiceRecords: [...meaningOptions, ...overlaps],
    historicalLeafAdjudications,
    blockers: ['Root owner must select or revise all 9 new-meaning proposals and 2 overlap scope choices.', 'A distinct peer must review the exact R6 candidate and all postimage content.', 'R5 peer REQUEST_CHANGES remains history and does not count as R6 approval.'],
    canonicalApply: 'NOT_PERFORMED',
    authorityBoundary: {ownerApproval: 'NOT_CLAIMED', ownerAdoption: 'UNKNOWN', independentAcceptance: 'NOT_CLAIMED', phaseStatusEffect: 'NONE', runtimeAdmission: 'NOT_ADMITTED'}
  };
  const postimageBytes = jsonBytes(sourceAmendment);
  const targetBinding = targets.map(({targetRef, preimageSha256, postimageSha256}) => ({targetRef, preimageSha256, postimageSha256}));
  const candidatePostimageSha256 = sha(Buffer.from(JSON.stringify({targets: targetBinding, semanticPostimageSha256: sha(postimageBytes)})));
  const candidate = {
    schemaVersion: 'ghatana.media.pdp0.cohort02.source-amendment-candidate.v6',
    artifactKind: 'NON_CANONICAL_EXACT_SOURCE_AMENDMENT_CANDIDATE',
    artifactId: 'media-pdp0-cohort02-source-amendment-candidate-r6',
    predecessorCandidateRef: R5_CANDIDATE,
    predecessorCandidateSha256: sourceBindings.r5CandidateSha256,
    predecessorWasApplied: false,
    proposalRef: `${DIR}/cohort-02.r6.json`,
    proposalSha256: sha(jsonBytes(artifact)),
    sourceBindings,
    candidatePostimageSha256,
    exactTargetPostimages: targets,
    exactSemanticPostimageRef: `${DIR}/cohort-02.source-amendment-postimages.r6.json`,
    exactSemanticPostimageSha256: sha(postimageBytes),
    counts: {cohortRows: 77, peerSupportedPreserved: 13, peerRequestChangesAddressed: 64, r5PeerFindings: 25, r5PeerRequestChangesRows: 21, correctedCaseIndexes: 8, correctedDirectRequirementBindings: 7, importCriterionMismatchResolved: 1, ownerRoleFieldsResolved: 9, featureRows: 44, distinctRebindRows: 9, rebindTargetOperations: 16, featureCasePairs: 60, capabilityCaseRecordAdditions: 120, rootChoicesPending: 11, historicalLeafAdjudicationsPreserved: 462},
    sourceOwnerRole: {role: 'media-product', authorityRef: OWNER_AUTHORITY_REF, ownerAdoption: 'UNKNOWN'},
    rootOwnerDecisionRequirement: {required: true, selectedOptions: 0, binds: ['candidateSha256', 'candidatePostimageSha256', 'sourceBindings', 'exactTargetPostimages', 'allRootChoiceRecords'], role: 'media-product'},
    distinctPeerReviewRequirement: {required: true, verdictRequiredPerChangedAuditRow: 'PASS', binds: ['candidateSha256', 'candidatePostimageSha256', 'sourceBindings', 'exactTargetPostimages', 'allRootChoiceRecords'], role: 'DISTINCT_SOURCE_CONTENT_PEER'},
    r5PeerReview: {ref: R5_PEER, sha256: sourceBindings.r5PeerSha256, verdictDisposition: 'REQUEST_CHANGES_RETAINED; NOT_R6_APPROVAL'},
    canonicalApply: 'NOT_PERFORMED',
    effects: {canonicalSourceWrite: 'NOT_PERFORMED', historical462: 'PRESERVED_SEPARATELY', independentAcceptance: 'NOT_CLAIMED', nativeClosure: 'NOT_CLAIMED'}
  };
  return {artifact, sourceAmendment, candidate, capabilityPostimage, requirementsPostimage: requirementPostimage};
}

export {buildCohort02R6};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = buildCohort02R6();
  const outputs = [
    [`${DIR}/cohort-02.r6.json`, jsonBytes(result.artifact)],
    [`${DIR}/cohort-02.source-amendment-postimages.r6.json`, jsonBytes(result.sourceAmendment)],
    [`${DIR}/cohort-02.source-amendment-candidate.r6.json`, jsonBytes(result.candidate)],
    [`${DIR}/cohort-02.source-amendment-capabilities.postimage.r6.yaml`, result.capabilityPostimage],
    [`${DIR}/cohort-02.source-amendment-requirements.postimage.r6.yaml`, result.requirementsPostimage]
  ];
  for (const [ref, output] of outputs) fs.writeFileSync(path.join(ROOT, ref), output);
  console.log(JSON.stringify({written: outputs.map(([ref, output]) => ({ref, sha256: sha(output)})), counts: result.candidate.counts, canonicalApply: 'NOT_PERFORMED'}, null, 2));
}
