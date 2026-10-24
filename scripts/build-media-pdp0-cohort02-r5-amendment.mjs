import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import YAML from 'yaml';
import {buildCohort02R4} from './build-media-pdp0-cohort02-r4-amendment.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const CAP = '.product-experience/pdp-0-product-truth/capabilities.yaml';
const REQ = '.product-experience/pdp-0-product-truth/requirements.yaml';
const LEAF = '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml';
const R4 = `${DIR}/cohort-02.r4.json`;
const R4_CANDIDATE = `${DIR}/cohort-02.source-amendment-candidate.r4.json`;
const R4_POSTIMAGES = `${DIR}/cohort-02.source-amendment-postimages.r4.json`;
const R4_PEER = `${DIR}/cohort-02.r4.independent-peer.v1.json`;

const bytes = (ref) => fs.readFileSync(path.join(ROOT, ref));
const json = (ref) => JSON.parse(bytes(ref).toString('utf8'));
const sha = (value) => createHash('sha256').update(value).digest('hex');
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const shaFile = (ref) => sha(bytes(ref));
const capSelector = (id) => `${CAP}#capabilities/@id=${id}`;
const caseSelector = (id, index) => `${capSelector(id)}/acceptanceCases/${index}`;
const exactJson = (value) => JSON.stringify(value);

function need(condition, message) {
  if (!condition) throw new Error(`Cohort-02 R5 refused: ${message}`);
}

function currentCapability(nodeById, capabilityId, auditId) {
  const node = nodeById.get(capabilityId);
  need(node, `R4 mapped ${auditId} to missing current capability ${capabilityId}`);
  const capability = node.toJSON();
  const definition = capability.ownerDefinition;
  need(typeof capability.operation === 'string' && capability.operation.trim().length > 0 && capability.operation !== 'undefined', `current capability ${capabilityId} lacks a named operation`);
  need(Array.isArray(definition?.typedInputSlots) && definition.typedInputSlots.length > 0, `current capability ${capabilityId} lacks exact ownerDefinition.typedInputSlots`);
  need(Array.isArray(definition?.successOutputs) && definition.successOutputs.length > 0, `current capability ${capabilityId} lacks exact ownerDefinition.successOutputs`);
  need(definition?.nonSuccessOutputs && typeof definition.nonSuccessOutputs === 'object', `current capability ${capabilityId} lacks ownerDefinition.nonSuccessOutputs`);
  need(Array.isArray(definition.errors) && definition.errors.length > 0, `current capability ${capabilityId} lacks ownerDefinition.errors`);
  need(Array.isArray(capability.requiredAuthority) && capability.requiredAuthority.length > 0, `current capability ${capabilityId} lacks requiredAuthority`);
  need(Array.isArray(capability.explicitUnsupportedCases) && capability.explicitUnsupportedCases.length > 0, `current capability ${capabilityId} lacks explicitUnsupportedCases`);
  need(typeof definition.semanticOutcomeContract?.result === 'string' && definition.semanticOutcomeContract.result.trim().length > 0, `current capability ${capabilityId} lacks its owner semantic outcome`);
  return capability;
}

function renderFeatureCases({row, capability}) {
  const definition = capability.ownerDefinition;
  const inputSlots = definition.typedInputSlots;
  const successOutputs = definition.successOutputs;
  const sourceFeature = row.featureText;
  const sourceCriterion = row.sourceAcceptanceCriterion;
  const exactOperation = `${capability.id}.${capability.operation}`;
  const positive = {
    given: `The source feature “${sourceFeature}” is requested with the exact current input-slot contract ${exactJson(inputSlots)} and all required authority ${exactJson(capability.requiredAuthority)} is eligible.`,
    when: `The caller invokes ${exactOperation} for this feature and applies the source acceptance criterion “${sourceCriterion}”.`,
    then: `On success, return only the current declared output shape ${exactJson(successOutputs)} and preserve the owner outcome contract: ${definition.semanticOutcomeContract.result} Source criterion: “${sourceCriterion}”.`
  };
  const deniedAuthority = capability.requiredAuthority[0];
  const negative = {
    given: `The source feature “${sourceFeature}” is requested with the exact current input-slot contract ${exactJson(inputSlots)}, but required authority ${exactJson(deniedAuthority)} is denied or an explicitly unsupported condition ${exactJson(capability.explicitUnsupportedCases)} applies.`,
    when: `The caller invokes ${exactOperation} and admission evaluates the capability's current declared guards.`,
    then: `Do not return a success output. Preserve the exact declared non-success boundary ${exactJson(definition.nonSuccessOutputs)}, error values ${exactJson(definition.errors)}, and authority requirements ${exactJson(capability.requiredAuthority)}; an uncertain consequential outcome remains UNKNOWN_OUTCOME.`
  };
  return [positive, negative];
}

function validateR4History(r4, r4Candidate, r4Postimages, peer, regeneratedR4) {
  need(peer.reviewStatus === 'INDEPENDENT_REVIEW_COMPLETE; 13 SUPPORTED; 64 REQUEST_CHANGES; CANONICAL OWNER DISPOSITION UNKNOWN', 'R4 peer artifact is not the expected completed review');
  need(peer.sourceBaseline.r4Sha256 === sha(jsonBytes(r4)), 'R4 peer is stale against the retained R4 proposal');
  need(peer.sourceBaseline.candidateSha256 === sha(jsonBytes(r4Candidate)), 'R4 peer is stale against the retained R4 candidate');
  need(peer.sourceBaseline.postimagesSha256 === sha(jsonBytes(r4Postimages)), 'R4 peer is stale against the retained R4 postimages');
  need(peer.decisionCounts?.REQUEST_CHANGES === 64 && peer.decisionCounts?.SUPPORTED === 13, 'R4 peer counts differ from 64 REQUEST_CHANGES / 13 SUPPORTED');
  need(peer.rows.reduce((sum, row) => sum + (row.caseRenderingDefectCount ?? 0), 0) === 120, 'R4 peer does not record all 120 malformed generated cases');
  need(JSON.stringify(regeneratedR4.artifact) === JSON.stringify(r4), 'R4 builder inputs have drifted from the retained R4 history; regenerate and review the lineage before R5');
  need(JSON.stringify(regeneratedR4.candidate) === JSON.stringify(r4Candidate), 'R4 candidate no longer matches its source builder');
  need(JSON.stringify(regeneratedR4.sourceAmendment) === JSON.stringify(r4Postimages), 'R4 postimages no longer match their source builder');
}

function buildCohort02R5() {
  const r4 = json(R4);
  const r4Candidate = json(R4_CANDIDATE);
  const r4Postimages = json(R4_POSTIMAGES);
  const r4Peer = json(R4_PEER);
  const regeneratedR4 = buildCohort02R4();
  validateR4History(r4, r4Candidate, r4Postimages, r4Peer, regeneratedR4);

  const capabilityBytes = bytes(CAP);
  const requirementsBytes = bytes(REQ);
  const leafBytes = bytes(LEAF);
  need(sha(capabilityBytes) === r4Candidate.sourceBindings.capabilitiesPreimageSha256, 'live capabilities.yaml no longer matches the R4 candidate preimage');
  need(sha(requirementsBytes) === r4Candidate.sourceBindings.requirementsPreimageSha256, 'live requirements.yaml no longer matches the R4 candidate preimage');
  need(sha(leafBytes) === r4Candidate.sourceBindings.capabilityLeafReviewSha256, 'live capability-leaf-review.yaml no longer matches the R4 candidate baseline');

  const capDoc = YAML.parseDocument(capabilityBytes.toString('utf8'), {uniqueKeys: true});
  need(capDoc.errors.length === 0, `live capabilities.yaml is invalid: ${capDoc.errors.map((error) => error.message).join('; ')}`);
  const capNodes = capDoc.get('capabilities', true).items;
  const capById = new Map(capNodes.map((node) => [node.get('id', true)?.toJSON(), node]));
  const exactFeatureCasePostimages = [];
  const byCapability = new Map();

  for (const priorRow of regeneratedR4.artifact.exactFeatureCasePostimages) {
    const capability = currentCapability(capById, priorRow.capabilityId, priorRow.auditId);
    const node = capById.get(priorRow.capabilityId);
    const cases = node.get('acceptanceCases', true);
    need(cases && Array.isArray(cases.items), `current capability ${priorRow.capabilityId} lacks an acceptanceCases sequence`);
    const currentCaseCount = cases.items.length;
    const offset = byCapability.get(priorRow.capabilityId) ?? 0;
    const pair = renderFeatureCases({row: priorRow, capability});
    for (const record of pair) cases.add(capDoc.createNode(record));
    byCapability.set(priorRow.capabilityId, offset + pair.length);
    exactFeatureCasePostimages.push({
      ...priorRow,
      operation: capability.operation,
      typedInputSelector: `${capSelector(capability.id)}/ownerDefinition/typedInputSlots`,
      outputSelector: `${capSelector(capability.id)}/ownerDefinition/successOutputs`,
      failureAuthoritySelectors: [`${capSelector(capability.id)}/ownerDefinition/nonSuccessOutputs`, `${capSelector(capability.id)}/ownerDefinition/errors`, `${capSelector(capability.id)}/requiredAuthority`, `${capSelector(capability.id)}/explicitUnsupportedCases`],
      currentTypedInputSlots: capability.ownerDefinition.typedInputSlots,
      currentSuccessOutputs: capability.ownerDefinition.successOutputs,
      currentNonSuccessOutputs: capability.ownerDefinition.nonSuccessOutputs,
      currentAuthority: capability.requiredAuthority,
      currentErrors: capability.ownerDefinition.errors,
      currentExplicitUnsupportedCases: capability.explicitUnsupportedCases,
      currentOwnerOutcome: capability.ownerDefinition.semanticOutcomeContract.result,
      preimageCaseCount: currentCaseCount,
      postimageCaseRefs: [caseSelector(capability.id, currentCaseCount + offset), caseSelector(capability.id, currentCaseCount + offset + 1)],
      cases: pair,
      peerRationale: {sourceGap: priorRow.sourceGap, priorR4PeerFindingId: r4Peer.rows.find((item) => item.auditId === priorRow.auditId)?.peerFindingId ?? null},
      caseSemanticBasis: 'CURRENT_CAPABILITY_OWNER_DEFINITION_AND_SOURCE_FEATURE_CRITERION',
      noCanonicalOwnerDecisionClaimed: true
    });
  }

  need(exactFeatureCasePostimages.length === 60, `expected all 60 R4 case-pair declarations; found ${exactFeatureCasePostimages.length}`);
  need(exactFeatureCasePostimages.reduce((sum, row) => sum + row.cases.length, 0) === 120, 'expected 120 corrected positive/negative cases');
  const capabilityPostimage = Buffer.from(capDoc.toString());
  const capabilityPostimageSha256 = sha(capabilityPostimage);
  const requirementPostimageSha256 = sha(requirementsBytes);
  const sourceBindings = {
    r4ProposalSha256: sha(bytes(R4)),
    r4CandidateSha256: sha(bytes(R4_CANDIDATE)),
    r4PostimagesSha256: sha(bytes(R4_POSTIMAGES)),
    r4PeerSha256: sha(bytes(R4_PEER)),
    capabilitiesPreimageSha256: sha(capabilityBytes),
    requirementsPreimageSha256: sha(requirementsBytes),
    capabilityLeafReviewSha256: sha(leafBytes),
    capabilitiesPostimageSha256: capabilityPostimageSha256,
    requirementsPostimageSha256: requirementPostimageSha256,
    authorityMapSha256: shaFile('.product-experience/authority-map.yaml'),
    phaseStatusSha256: shaFile('docs/implementation/pdp-0-phase-dev-status.json')
  };

  const targets = [
    {targetRef: CAP, preimageSha256: sourceBindings.capabilitiesPreimageSha256, postimageSha256: capabilityPostimageSha256, postimageRef: `${DIR}/cohort-02.source-amendment-capabilities.postimage.r5.yaml`, semanticMutationCount: 60, acceptanceCaseRecordCount: 120},
    {targetRef: REQ, preimageSha256: sourceBindings.requirementsPreimageSha256, postimageSha256: requirementPostimageSha256, postimageRef: `${DIR}/cohort-02.source-amendment-requirements.postimage.r5.yaml`, semanticMutationCount: 0}
  ];
  const historicalLeafAdjudications = {targetRef: LEAF, preimageSha256: sourceBindings.capabilityLeafReviewSha256, historicalAdjudicationCount: 462, mutation: 'NONE; all historical adjudications and trust records remain byte-source preserved.'};

  const artifact = {
    schemaVersion: 'ghatana.media.pdp0.parent-case-resolution-candidates.v5',
    artifactId: 'media-pdp0-parent-case-resolution-cohort-02-r5',
    status: 'SOURCE_GROUNDED_CASE_REPAIR_READY_FOR_DISTINCT_PEER_REVIEW_AND_ROOT_DECISIONS',
    predecessorRef: R4,
    predecessorSha256: sourceBindings.r4ProposalSha256,
    supersededCandidateDisposition: 'R4_RETAINED_AS_FAILED_REVIEW_HISTORY; NEVER_APPLIED; R5 IS A NEW CANDIDATE',
    r4PeerReviewRef: R4_PEER,
    r4PeerReviewSha256: sourceBindings.r4PeerSha256,
    r4PeerDisposition: r4Peer.reviewStatus,
    sourceBindings,
    scope: {...regeneratedR4.artifact.scope, amendmentOrdinal: 5, caseRepairCounts: {featureRows: 44, distinctRebindRows: 9, rebindTargetOperations: 16, totalCasePairs: 60, totalPositiveNegativeCaseRecords: 120}},
    rows: regeneratedR4.artifact.rows,
    exactFeatureCasePostimages,
    missingMeaningRootDecisionOptions: regeneratedR4.artifact.missingMeaningRootDecisionOptions,
    overlapRootDecisionOptions: regeneratedR4.artifact.overlapRootDecisionOptions,
    reusedPeerSupportedRows: regeneratedR4.artifact.reusedPeerSupportedRows,
    exactTargetPostimages: targets,
    historicalLeafAdjudications,
    rootOwnerDecision: 'PENDING; R5 selects no root option',
    distinctSourceContentPeerReview: 'REQUIRED; R4 REQUEST_CHANGES IS NOT A PASS FOR R5',
    canonicalSourceWrite: 'NOT_PERFORMED',
    independentAcceptance: 'NOT_CLAIMED',
    nativeClosure: 'NOT_CLAIMED',
    runtimeAdmission: 'NOT_ADMITTED'
  };
  const sourceAmendment = {
    schemaVersion: 'ghatana.media.pdp0.cohort02.source-amendment-batch.v5',
    artifactKind: 'NON_CANONICAL_EXACT_SOURCE_AMENDMENT_CANDIDATE',
    candidateRef: `${DIR}/cohort-02.source-amendment-candidate.r5.json`,
    proposalRef: `${DIR}/cohort-02.r5.json`,
    predecessorFailedR4: {proposalRef: R4, proposalSha256: sourceBindings.r4ProposalSha256, candidateRef: R4_CANDIDATE, candidateSha256: sourceBindings.r4CandidateSha256, peerRef: R4_PEER, peerSha256: sourceBindings.r4PeerSha256, retainedUnmodified: true, canonicalApply: 'NOT_PERFORMED'},
    sourceBindings,
    exactTargetPostimages: targets,
    capabilityCasePostimages: exactFeatureCasePostimages,
    requirementChanges: [],
    rootChoiceRecords: [...regeneratedR4.artifact.missingMeaningRootDecisionOptions, ...regeneratedR4.artifact.overlapRootDecisionOptions],
    historicalLeafAdjudications,
    blockers: ['Root owner must resolve the 9 new-meaning proposals and 2 shared-versus-split scope choices.', 'A distinct source-content peer must review the exact R5 candidate and both source postimages.', 'The R4 peer REQUEST_CHANGES findings remain preserved as history and do not count as an R5 PASS.'],
    canonicalApply: 'NOT_PERFORMED',
    authorityBoundary: {ownerApproval: 'NOT_CLAIMED', independentAcceptance: 'NOT_CLAIMED', phaseStatusEffect: 'NONE', runtimeAdmission: 'NOT_ADMITTED'}
  };
  const sourcePostimageBytes = jsonBytes(sourceAmendment);
  const targetBinding = targets.map(({targetRef, preimageSha256, postimageSha256}) => ({targetRef, preimageSha256, postimageSha256}));
  const candidatePostimageSha256 = sha(Buffer.from(JSON.stringify({targets: targetBinding, semanticPostimageSha256: sha(sourcePostimageBytes)})));
  const candidate = {
    schemaVersion: 'ghatana.media.pdp0.cohort02.source-amendment-candidate.v5',
    artifactKind: 'NON_CANONICAL_EXACT_SOURCE_AMENDMENT_CANDIDATE',
    artifactId: 'media-pdp0-cohort02-source-amendment-candidate-r5',
    predecessorCandidateRef: R4_CANDIDATE,
    predecessorCandidateSha256: sourceBindings.r4CandidateSha256,
    predecessorWasApplied: false,
    proposalRef: `${DIR}/cohort-02.r5.json`,
    proposalSha256: sha(jsonBytes(artifact)),
    sourceBindings,
    candidatePostimageSha256,
    exactTargetPostimages: targets,
    exactSemanticPostimageRef: `${DIR}/cohort-02.source-amendment-postimages.r5.json`,
    exactSemanticPostimageSha256: sha(sourcePostimageBytes),
    counts: {cohortRows: 77, peerSupportedPreserved: 13, peerRequestChangesAddressed: 64, featureRowsRepaired: 44, distinctRebindRows: 9, rebindTargetOperations: 16, featureCasePairs: 60, capabilityCaseRecordAdditions: 120, newMeaningChoices: 9, overlapChoices: 2, historicalLeafAdjudicationsPreserved: 462},
    rootOwnerDecisionRequirement: {required: true, selectedOptions: 0, binds: ['candidateSha256', 'candidatePostimageSha256', 'sourceBindings', 'exactTargetPostimages', 'allRootChoiceRecords'], role: 'PDP0_SOURCE_OWNER'},
    distinctPeerReviewRequirement: {required: true, verdictRequiredPerChangedAuditRow: 'PASS', binds: ['candidateSha256', 'candidatePostimageSha256', 'sourceBindings', 'exactTargetPostimages', 'allRootChoiceRecords'], role: 'DISTINCT_SOURCE_CONTENT_PEER'},
    r4PeerReview: {ref: R4_PEER, sha256: sourceBindings.r4PeerSha256, verdictDisposition: 'REQUEST_CHANGES_RETAINED; NOT_R5_APPROVAL'},
    canonicalApply: 'NOT_PERFORMED',
    effects: {canonicalSourceWrite: 'NOT_PERFORMED', historical462: 'PRESERVED_SEPARATELY', independentAcceptance: 'NOT_CLAIMED', nativeClosure: 'NOT_CLAIMED'}
  };
  return {artifact, sourceAmendment, candidate, capabilityPostimage, requirementsPostimage: requirementsBytes};
}

export {buildCohort02R5};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = buildCohort02R5();
  const outputs = [
    [`${DIR}/cohort-02.r5.json`, jsonBytes(result.artifact)],
    [`${DIR}/cohort-02.source-amendment-postimages.r5.json`, jsonBytes(result.sourceAmendment)],
    [`${DIR}/cohort-02.source-amendment-candidate.r5.json`, jsonBytes(result.candidate)],
    [`${DIR}/cohort-02.source-amendment-capabilities.postimage.r5.yaml`, result.capabilityPostimage],
    [`${DIR}/cohort-02.source-amendment-requirements.postimage.r5.yaml`, result.requirementsPostimage]
  ];
  for (const [ref, output] of outputs) fs.writeFileSync(path.join(ROOT, ref), output);
  console.log(JSON.stringify({written: outputs.map(([ref, output]) => ({ref, sha256: sha(output)})), counts: result.candidate.counts, canonicalApply: 'NOT_PERFORMED'}, null, 2));
}
