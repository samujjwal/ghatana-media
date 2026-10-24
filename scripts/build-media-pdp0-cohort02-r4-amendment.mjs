import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const CAP = '.product-experience/pdp-0-product-truth/capabilities.yaml';
const REQ = '.product-experience/pdp-0-product-truth/requirements.yaml';
const LEAF = '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml';
const R2 = `${DIR}/cohort-02.r2.json`;
const R3 = `${DIR}/cohort-02.r3.json`;
const PEER = `${DIR}/cohort-02.r3.independent-peer.v1.json`;
const R3_BATCH = `${DIR}/cohort-02.source-amendment-record-postimages.json`;
const R3_SELF = `${DIR}/cohort-02-supported-self-check.json`;
const ASSIGNMENT = '../ghatana-lifecycle/docs/engineering/reviews/gtool-critical-2026-10-23/media-pdp0-resolution-cohort-assignments.json';

const bytes = (ref) => fs.readFileSync(path.join(ROOT, ref));
const json = (ref) => JSON.parse(bytes(ref).toString('utf8'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const hashFile = (ref) => sha(bytes(ref));
const reqSelector = (id) => `${REQ}#requirements/@id=${id}`;
const capSelector = (id) => `${CAP}#capabilities/@id=${id}`;
const capCaseSelector = (id, index) => `${capSelector(id)}/acceptanceCases/${index}`;
const nodeValue = (node) => node?.toJSON() ?? null;
const get = (node, key) => node.get(key, true);

function exactlyOne(items, predicate, label) {
  const found = items.filter(predicate);
  if (found.length !== 1) throw new Error(`expected one ${label}, found ${found.length}`);
  return found[0];
}

function featurePair({auditId, featureText, featureAcceptance, gap, correction, capability}) {
  const inputSlots = capability.typedInputSlots ?? [];
  const inputs = inputSlots.map((slot) => `${slot.slotId}:${slot.sourceType}${slot.required ? ' [required]' : ' [optional]'}`).join('; ');
  const outputs = capability.successOutputs ?? [];
  const outputText = outputs.map((output) => `${output.artifactType}${output.requiredOnSuccess ? ' [required on success]' : ' [conditional/optional]'}`).join('; ');
  const authority = capability.requiredAuthority ?? [];
  const outputDistinctions = capability.outputDistinctions ?? [];
  const rejection = capability.explicitUnsupportedCases ?? [];
  const operation = `${capability.capabilityId} (${capability.operation})`;
  const specificIntent = correction || `Exercise the named feature ${featureText} and the source criterion ${featureAcceptance}.`;
  const positive = {
    given: `Feature ${auditId} is requested against exact mapped capability ${capability.capabilityId} with current typed inputs [${inputs}] and required authority [${authority.join('; ')}]; the source feature is “${featureText}”.`,
    when: `The caller invokes ${operation} under the exact admitted feature/profile request, with no provider, license, implementation, qualification, or runtime state inferred from definition.`,
    then: `Return only the current declared output [${outputText}] with owner outcome “${capability.outcome}”. Preserve the declared distinctions [${outputDistinctions.join('; ')}]. For this feature, assert the source criterion “${featureAcceptance}” and feature-specific requirement “${gap}”. ${specificIntent}`
  };
  const negative = {
    given: `Feature ${auditId} is requested against exact mapped capability ${capability.capabilityId}, but the specific gap or a required typed slot, authority, profile, right, or capability dimension is unsupported, denied, stale, or unknown: ${gap}`,
    when: `Admission or execution evaluates ${operation} for “${featureText}”.`,
    then: `Return only its defined non-success/UNKNOWN state; do not fabricate an output, substitute an unsupported dimension, or claim implementation, qualification, availability, or finality. Current explicit unsupported conditions: [${rejection.join('; ')}]. Unknown/non-success output boundary: ${JSON.stringify(capability.nonSuccessOutputs)}.`
  };
  return [positive, negative];
}

function extractCapId(ref) {
  const match = ref.match(/capabilities\.yaml#capabilities\/@id=([^/]+)\/acceptanceCases/u);
  if (!match) throw new Error(`peer selector is not a capability acceptance-case selector: ${ref}`);
  return match[1];
}

function buildCohort02R4() {
  const r2 = json(R2);
  const r3 = json(R3);
  const peer = json(PEER);
  const batchR3 = json(R3_BATCH);
  const selfCheck = json(R3_SELF);
  const assignmentBytes = bytes(ASSIGNMENT);
  const assignment = JSON.parse(assignmentBytes.toString('utf8'));
  const ids = assignment.cohorts[1].expectedAuditIds;
  const r2Rows = new Map(r2.rows.map((row) => [row.existingAuditId, row]));
  const r3Rows = new Map(r3.rows.map((row) => [row.existingAuditId, row]));
  const peerRows = new Map(peer.rows.map((row) => [row.auditId, row]));
  const r3MeaningRows = new Map(batchR3.missingMeaningDefinitionProposals.map((row) => [row.auditId, row]));
  const reviewRows = new Map(selfCheck.supportedRowReviews.map((row) => [row.auditId, row]));
  if (ids.length !== 77 || new Set(ids).size !== 77 || peer.rows.length !== 77) throw new Error('exact cohort assignment or peer row denominator is invalid');
  if (peer.sourceBaseline.sourcePins.r3.sha256 !== hashFile(R3)) throw new Error('R3 peer review is not bound to the current R3 bytes');
  if (peer.decisionCounts.REQUEST_CHANGES !== 64 || peer.decisionCounts.SUPPORTED !== 13) throw new Error('R3 peer decision counts differ from the recorded 64/13 split');

  const capBytes = bytes(CAP);
  const reqBytes = bytes(REQ);
  const leafBytes = bytes(LEAF);
  const capDoc = YAML.parseDocument(capBytes.toString('utf8'), {uniqueKeys: true});
  const capRows = capDoc.get('capabilities', true).items;
  const capById = new Map(capRows.map((node) => [nodeValue(get(node, 'id')), node]));
  const capabilityCases = [];
  const ownerDecisionOptions = [];
  const overlapOptions = [];
  const resolutions = [];
  const targetOffsets = new Map();

  const appendPair = ({auditId, featureText, featureAcceptance, sourceFeatureRef, gap, correction, capId, mappingKind, requirementRefs}) => {
    const capNode = capById.get(capId);
    if (!capNode) throw new Error(`candidate mapping points to missing live capability ${capId} for ${auditId}`);
    const cap = nodeValue(capNode);
    const acceptance = get(capNode, 'acceptanceCases');
    if (!acceptance || !Array.isArray(cap.acceptanceCases)) throw new Error(`capability ${capId} has no current acceptanceCases list`);
    const beforeCount = cap.acceptanceCases.length;
    const offset = targetOffsets.get(capId) ?? 0;
    const pair = featurePair({auditId, featureText, featureAcceptance, gap, correction, capability: cap});
    for (const record of pair) acceptance.add(capDoc.createNode(record));
    targetOffsets.set(capId, offset + pair.length);
    capabilityCases.push({
      auditId, mappingKind, capabilityId: capId, capabilityRef: capSelector(capId), operation: cap.operation,
      typedInputSelector: `${capSelector(capId)}/ownerDefinition/typedInputSlots`,
      outputSelector: `${capSelector(capId)}/ownerDefinition/successOutputs`,
      failureAuthoritySelectors: [`${capSelector(capId)}/ownerDefinition/nonSuccessOutputs`, `${capSelector(capId)}/requiredAuthority`, `${capSelector(capId)}/explicitUnsupportedCases`],
      parentRequirementRefs: requirementRefs,
      preimageCaseCount: beforeCount,
      postimageCaseRefs: [capCaseSelector(capId, beforeCount + offset), capCaseSelector(capId, beforeCount + offset + 1)],
      featureText, sourceFeatureRef, sourceAcceptanceCriterion: featureAcceptance, sourceGap: gap,
      cases: pair,
      noCanonicalOwnerDecisionClaimed: true
    });
  };

  for (const auditId of ids) {
    const r3row = r3Rows.get(auditId);
    const review = peerRows.get(auditId);
    const original = r2Rows.get(auditId);
    if (!r3row || !review || !original) throw new Error(`missing row across assignment/R2/R3/peer for ${auditId}`);
    const r3Status = r3row.r3Resolution.status;
    const finding = review.technicalAssessment;
    const liveCaps = finding.liveEvidence.capabilities ?? [];
    const featureText = review.sourceFeature.text;
    const featureAcceptance = review.sourceFeature.acceptanceCriterion;
    const correction = finding.proposedPdp0SemanticCorrection ?? '';
    const gap = r3row.r3Resolution.gap ?? finding.reason;

    if (review.technicalVerdict === 'SUPPORTED') {
      resolutions.push({auditId, disposition: 'PRESERVE_EXACT_R3_ROW_AS_PEER_SUPPORTED', ownerDisposition: review.canonicalOwnerDisposition.classification, peerDisposition: 'SUPPORTED', mutation: 'NONE'});
      continue;
    }
    if (review.r3Status === 'PROPOSED_FEATURE_CASE_AMENDMENT') {
      const sourceReview = reviewRows.get(auditId);
      const mappedId = r3row.r3Resolution.existingCapabilityId;
      const cap = exactlyOne(liveCaps, (candidate) => candidate.capabilityId === mappedId, `live capability ${mappedId} for ${auditId}`);
      const requirementRefs = finding.liveEvidence.requirementRefs ?? [];
      appendPair({auditId, featureText, featureAcceptance, sourceFeatureRef: review.sourceFeature.sourceRef, gap, correction, capId: cap.capabilityId, mappingKind: 'FEATURE_CASE_REPAIR_EXACT_EXISTING_MAPPING', requirementRefs});
      resolutions.push({auditId, disposition: 'REPAIR_FEATURE_CASE_WITH_LIVE_TYPED_INPUT_OUTPUT_FAILURE_AND_AUTHORITY', peerFindingId: finding.findingId, exactAffectedSourceSelectors: finding.exactAffectedSourceSelectors, caseTargets: [capSelector(cap.capabilityId)], priorR3Category: r3row.r3Resolution.priorFindingCategory, selfCheckRef: `${R3_SELF}#/supportedRowReviews/@auditId=${auditId}`, sourceRefs: sourceReview ? sourceReview.sourceHashesForThisRow : []});
      continue;
    }
    if (review.r2Disposition === 'REBIND_EXISTING_CAPABILITY') {
      const option = exactlyOne(finding.rootChoiceOptions ?? [], (candidate) => candidate.optionId === 'A_REUSE_EXACT_EXISTING_CAPABILITIES', `exact reusable mapping option for ${auditId}`);
      const targets = option.selectors.capabilities.map(extractCapId);
      const requirementRefs = option.selectors.requirements ?? [];
      for (const capId of targets) {
        const cap = exactlyOne(liveCaps, (candidate) => candidate.capabilityId === capId, `live rebind capability ${capId} for ${auditId}`);
        appendPair({auditId, featureText, featureAcceptance, sourceFeatureRef: review.sourceFeature.sourceRef, gap: finding.liveEvidence.proposedPdp0SemanticCorrection ?? finding.reason, correction: finding.liveEvidence.proposedPdp0SemanticCorrection ?? correction, capId, mappingKind: 'R2_REBIND_TARGET_FEATURE_CASE', requirementRefs});
      }
      resolutions.push({auditId, disposition: 'RETAIN_PEER_EXACT_REBIND_WITH_CASE_PER_MAPPED_OPERATION', peerFindingId: finding.findingId, exactAffectedSourceSelectors: finding.exactAffectedSourceSelectors, optionId: option.optionId, mappedCapabilityIds: targets, rootChoiceOptions: finding.rootChoiceOptions, sourceRefs: [review.sourceFeature.sourceRef, ...liveCaps.map((cap) => cap.ref), ...requirementRefs]});
      continue;
    }
    if (r3Status === 'PROPOSED_OWNER_DEFINITION_REQUIRED') {
      const option = r3MeaningRows.get(auditId);
      if (!option) throw new Error(`missing concrete feature owner proposal for ${auditId}`);
      ownerDecisionOptions.push({
        auditId, sourceFeature: review.sourceFeature, peerFindingId: finding.findingId,
        currentMapping: r3row.r3Resolution.existingCapabilityId,
        peerRootChoiceOptions: finding.rootChoiceOptions,
        concreteFeatureProposal: option,
        proposedPdp0OwnerResolution: 'NO OPTION SELECTED; root decision required',
        exactSourceSelectors: finding.exactAffectedSourceSelectors,
        parentRequirementRefs: finding.liveEvidence.requirementRefs,
        sourceFailureAuthority: finding.liveEvidence.capabilities.map((cap) => ({capabilityId: cap.capabilityId, requiredAuthority: cap.requiredAuthority, nonSuccessOutputs: cap.nonSuccessOutputs, explicitUnsupportedCases: cap.explicitUnsupportedCases})),
        canonicalMutation: 'NONE'
      });
      resolutions.push({auditId, disposition: 'NEW_MEANING_ROOT_CHOICE_REQUIRED', peerFindingId: finding.findingId, rootChoiceOptions: finding.rootChoiceOptions});
      continue;
    }
    if (review.r2Disposition === 'MISSING_PDP0_DEFINITION' && finding.rootChoiceOptions?.length) {
      overlapOptions.push({
        auditId, sourceFeature: review.sourceFeature, peerFindingId: finding.findingId,
        peerRootChoiceOptions: finding.rootChoiceOptions,
        relatedAuditIds: finding.rootChoiceOptions.flatMap((option) => option.selectors?.crosswalkRows ?? []).map((ref) => ref.split('@auditId=')[1]).filter(Boolean),
        currentCapabilityRefs: finding.liveEvidence.capabilityRefs,
        currentRequirementRefs: finding.liveEvidence.requirementRefs,
        exactSourceSelectors: finding.exactAffectedSourceSelectors,
        decision: 'ROOT_CHOICE_REQUIRED_SHARED_VS_SPLIT; NO DEFINITION APPLIED'
      });
      resolutions.push({auditId, disposition: 'OVERLAPPING_MISSING_MEANING_ROOT_CHOICE_REQUIRED', peerFindingId: finding.findingId, rootChoiceOptions: finding.rootChoiceOptions});
      continue;
    }
    throw new Error(`no R4 handling lane for ${auditId}: ${review.r3Status}/${review.r2Disposition}/${review.technicalVerdict}`);
  }

  const capabilityPostimage = Buffer.from(capDoc.toString());
  const requirementsPostimage = Buffer.from(reqBytes);
  const assigned = new Set(ids);
  const resolutionIds = resolutions.map((row) => row.auditId);
  if (resolutionIds.length !== 77 || new Set(resolutionIds).size !== 77 || resolutionIds.some((id) => !assigned.has(id))) throw new Error('R4 resolution does not cover the exact 77-row cohort exactly once');
  const supported = resolutions.filter((row) => row.peerDisposition === 'SUPPORTED');
  const changes = resolutions.filter((row) => !row.peerDisposition);
  if (supported.length !== 13 || changes.length !== 64 || capabilityCases.length !== 60 || ownerDecisionOptions.length !== 9 || overlapOptions.length !== 2) throw new Error('R4 repair lane counts differ from peer findings');

  const sourcePins = {
    r2Sha256: hashFile(R2), r3Sha256: hashFile(R3), r3PeerSha256: hashFile(PEER),
    priorR3BatchSha256: hashFile(`${DIR}/cohort-02.source-amendment-candidate.json`),
    r3PostimagesSha256: hashFile(`${DIR}/cohort-02.source-amendment-postimages.json`),
    assignmentSha256: sha(assignmentBytes), capabilitiesPreimageSha256: sha(capBytes), requirementsPreimageSha256: sha(reqBytes),
    capabilityLeafReviewSha256: sha(leafBytes), authorityMapSha256: hashFile('.product-experience/authority-map.yaml'),
    phaseStatusSha256: hashFile('docs/implementation/pdp-0-phase-dev-status.json'),
    originalAuditSha256: hashFile('docs/implementation/references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json')
  };
  const targets = [
    {targetRef: CAP, preimageSha256: sha(capBytes), postimageSha256: sha(capabilityPostimage), postimageRef: `${DIR}/cohort-02.source-amendment-capabilities.postimage.r4.yaml`, semanticMutationCount: capabilityCases.length, acceptanceCaseRecordCount: capabilityCases.length * 2},
    {targetRef: REQ, preimageSha256: sha(reqBytes), postimageSha256: sha(requirementsPostimage), postimageRef: `${DIR}/cohort-02.source-amendment-requirements.postimage.r4.yaml`, semanticMutationCount: 0, note: 'Parent requirements remain general invariants; feature-specific meaning options are recorded separately for root choice.'}
  ];
  const history = {targetRef: LEAF, preimageSha256: sha(leafBytes), historicalAdjudicationCount: 462, mutation: 'NONE; kept as a separate historical population.'};
  const artifact = {
    schemaVersion: 'ghatana.media.pdp0.parent-case-resolution-candidates.v4',
    artifactId: 'media-pdp0-parent-case-resolution-cohort-02-r4',
    status: 'SOURCE_GROUNDED_R4_REPAIR_PENDING_ROOT_DECISIONS_AND_DISTINCT_SOURCE_CONTENT_PEER_REVIEW',
    predecessorRef: `${DIR}/cohort-02.r3.json`,
    independentR3PeerRef: PEER,
    sourcePins,
    scope: {macroStage: 'DISCOVERY', phase: 'PDP-0 Product Truth', criterionId: 'P0-07', cohortOrdinal: 2, exactOrderedAssignedAuditIds: ids, cohortCount: 77, fullCampaignAuditIdDenominator: 231, registeredIdentityDenominator: 54, sourcePathDenominator: 207, r3PeerVerdicts: peer.decisionCounts, r4DispositionCounts: {PEER_SUPPORTED_REUSE: supported.length, FEATURE_CASE_REPAIR_EXISTING_MAPPINGS: 44, FEATURE_CASE_REPAIR_R2_REBINDS: 9, NEW_MEANING_ROOT_CHOICES: ownerDecisionOptions.length, OVERLAP_SCOPE_ROOT_CHOICES: overlapOptions.length}},
    rows: resolutions,
    exactFeatureCasePostimages: capabilityCases,
    missingMeaningRootDecisionOptions: ownerDecisionOptions,
    overlapRootDecisionOptions: overlapOptions,
    reusedPeerSupportedRows: supported.map((row) => ({auditId: row.auditId, disposition: row.disposition, ownerDisposition: peerRows.get(row.auditId).canonicalOwnerDisposition.classification})),
    exactTargetPostimages: targets,
    historicalLeafAdjudications: history,
    effects: {canonicalSourceWrite: 'NOT_PERFORMED', rootOwnerDecision: 'PENDING', distinctSourceContentPeerReview: 'PENDING', independentAcceptance: 'NOT_CLAIMED', nativeClosure: 'NOT_CLAIMED', runtimeAdmission: 'NOT_ADMITTED'}
  };
  const sourceAmendment = {
    schemaVersion: 'ghatana.media.pdp0.cohort02.source-amendment-batch.v4',
    artifactKind: 'NON_CANONICAL_SOURCE_AMENDMENT_CANDIDATE',
    candidateRef: `${DIR}/cohort-02.source-amendment-candidate.r4.json`,
    r4ProposalRef: `${DIR}/cohort-02.r4.json`,
    sourceBindings: sourcePins,
    exactTargetPostimages: targets,
    capabilityCasePostimages: capabilityCases,
    requirementChanges: [],
    rootChoiceRecords: [...ownerDecisionOptions, ...overlapOptions],
    historicalLeafAdjudications: history,
    blockers: ['Root must choose or revise all 9 proposed new-meaning contracts and both overlapping semantic scopes.', 'A distinct source-content peer must review the frozen R4 candidate and byte-exact postimages.', 'Do not claim the 462 historical leaf adjudications as part of this cohort or alter them.'],
    canonicalApply: 'NOT_PERFORMED',
    authorityBoundary: {ownerApproval: 'NOT_CLAIMED', independentAcceptance: 'NOT_CLAIMED', phaseStatusEffect: 'NONE', runtimeAdmission: 'NOT_ADMITTED'}
  };
  const postBytes = Buffer.from(`${JSON.stringify(sourceAmendment, null, 2)}\n`);
  const candidatePostimageSha256 = sha(Buffer.from(JSON.stringify({
    targets: targets.map(({targetRef, preimageSha256, postimageSha256}) => ({targetRef, preimageSha256, postimageSha256})),
    semanticPostimageSha256: sha(postBytes)
  })));
  const candidate = {
    schemaVersion: 'ghatana.media.pdp0.cohort02.source-amendment-candidate.v4',
    artifactKind: 'NON_CANONICAL_EXACT_SOURCE_AMENDMENT_CANDIDATE',
    artifactId: 'media-pdp0-cohort02-source-amendment-candidate-r4',
    predecessorCandidateRef: `${DIR}/cohort-02.source-amendment-candidate.json`,
    predecessorCandidateSha256: hashFile(`${DIR}/cohort-02.source-amendment-candidate.json`),
    proposalRef: `${DIR}/cohort-02.r4.json`,
    proposalSha256: sha(Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`)),
    sourceBindings: sourcePins,
    candidatePostimageSha256,
    exactTargetPostimages: targets,
    exactSemanticPostimageRef: `${DIR}/cohort-02.source-amendment-postimages.r4.json`,
    exactSemanticPostimageSha256: sha(postBytes),
    counts: {cohortRows: 77, peerSupportedPreserved: supported.length, peerRequestChangesAddressed: changes.length, featureCasePairs: capabilityCases.length, newMeaningChoices: ownerDecisionOptions.length, overlapChoices: overlapOptions.length, capabilityCaseRecordAdditions: capabilityCases.length * 2},
    rootOwnerDecisionRequirement: {required: true, binds: ['candidateSha256', 'candidatePostimageSha256', 'sourceBindings', 'exactTargetPostimages', 'allRootChoiceRecords'], sourceOwner: {identity: 'ROOT_TO_RESOLVE_FROM_AUTHORITY_MAP', role: 'PDP0_SOURCE_OWNER'}},
    distinctPeerReviewRequirement: {required: true, binds: ['candidateSha256', 'candidatePostimageSha256', 'sourceBindings', 'exactTargetPostimages', 'allRootChoiceRecords'], role: 'DISTINCT_SOURCE_CONTENT_PEER'},
    rootChoiceRecords: [...ownerDecisionOptions, ...overlapOptions],
    blockers: sourceAmendment.blockers,
    canonicalApply: 'NOT_PERFORMED',
    effects: {canonicalSourceWrite: 'NOT_PERFORMED', historical462: 'PRESERVED_SEPARATELY', independentAcceptance: 'NOT_CLAIMED', nativeClosure: 'NOT_CLAIMED'}
  };
  return {artifact, sourceAmendment, candidate, capabilityPostimage, requirementsPostimage};
}

export { buildCohort02R4 };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = buildCohort02R4();
  const outputs = [
    [`${DIR}/cohort-02.r4.json`, Buffer.from(`${JSON.stringify(result.artifact, null, 2)}\n`)],
    [`${DIR}/cohort-02.source-amendment-postimages.r4.json`, Buffer.from(`${JSON.stringify(result.sourceAmendment, null, 2)}\n`)],
    [`${DIR}/cohort-02.source-amendment-candidate.r4.json`, Buffer.from(`${JSON.stringify(result.candidate, null, 2)}\n`)],
    [`${DIR}/cohort-02.source-amendment-capabilities.postimage.r4.yaml`, result.capabilityPostimage],
    [`${DIR}/cohort-02.source-amendment-requirements.postimage.r4.yaml`, result.requirementsPostimage]
  ];
  for (const [ref, output] of outputs) fs.writeFileSync(path.join(ROOT, ref), output);
  console.log(JSON.stringify({written: outputs.map(([ref, output]) => ({ref, sha256: sha(output)})), counts: result.candidate.counts, targets: result.candidate.exactTargetPostimages}, null, 2));
}
