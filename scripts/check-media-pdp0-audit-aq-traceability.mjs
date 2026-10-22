#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {PDP0_AUDIT_DISPOSITION_CROSSWALK_PATH, PDP0_AUDIT_SOURCE_PATH, validatePdp0AuditDispositions} from './check-media-pdp0-501-audit-dispositions.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PDP0_AUDIT_AQ_TRACEABILITY_PATH = 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-audit-aq-traceability.json';
export const BLUEPRINT_PATH = 'docs/implementation/references/MEDIA-UNIFIED-DATA-DRIVEN-PRODUCTION-BLUEPRINT-V3-2026-10-17.md';
export const REQUIREMENTS_PATH = '.product-experience/pdp-0-product-truth/requirements.yaml';
export const CAPABILITIES_PATH = '.product-experience/pdp-0-product-truth/capabilities.yaml';
export const CAPABILITY_LEAF_REVIEW_PATH = '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml';
export const CAMPAIGN_EXTENSIONS_PATH = '.product-experience/pdp-0-product-truth/campaign-extensions.yaml';
export const AQ_REVIEW_PATHS = [
  'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-aq-cluster-review-original-001-214.json',
  'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-aq-cluster-review-original-215-428.json',
];
export const CAPABILITY_REVIEW_PATHS = [
  'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-aq-capability-review-001-154.json',
  'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-aq-capability-review-155-308.json',
  'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-aq-capability-review-309-462.json',
];
export const CAPABILITY_CURRENT_SOURCE_REVIEW_PATHS = [
  'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-aq-capability-current-source-review-001-154.json',
  'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-aq-capability-current-source-review-155-308.json',
  'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-aq-capability-current-source-review-309-462.json',
];
const PDP0_DECISION_LOG_PATH = '.product-experience/decision-log.md';
const INPUTS = [PDP0_AUDIT_SOURCE_PATH, PDP0_AUDIT_DISPOSITION_CROSSWALK_PATH, BLUEPRINT_PATH, REQUIREMENTS_PATH, CAPABILITIES_PATH, CAPABILITY_LEAF_REVIEW_PATH, CAMPAIGN_EXTENSIONS_PATH, ...AQ_REVIEW_PATHS, ...CAPABILITY_REVIEW_PATHS, ...CAPABILITY_CURRENT_SOURCE_REVIEW_PATHS];
const parseYaml = createRequire(path.resolve(root, '../ghatana-tools/package.json'))('yaml').parse;
const CLUSTER_IDS = 'ABCDEFGHIJKLMNOPQ'.split('');
const DEFERRED_AQ_CAPABILITIES = new Map([
  [59, 'media.profile.discover'],
  [60, 'media.profile.validate'],
  [61, 'media.capability.discover'],
  [62, 'media.capability.check-declared-options'],
  [63, 'media.capability.execution.compatibility'],
  [64, 'media.health.readiness.inspect'],
]);
const CAPABILITY_AQ_CORRECTIONS = new Map([
  [371, {capabilityId: 'media.compose.safe-area', removedRelatedClusterId: 'P', decisionRef: `${PDP0_DECISION_LOG_PATH}#PXD-221`}],
]);
const TAXONOMY_DECISION_REF = `${PDP0_DECISION_LOG_PATH}#PXD-220`;
const ORIGINAL_AUDIT_TAXONOMY_DECISION_REF = `${PDP0_DECISION_LOG_PATH}#PXD-219`;

const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const sha256 = (file, repositoryRoot = root) => crypto.createHash('sha256').update(fs.readFileSync(path.join(repositoryRoot, file))).digest('hex');
const decisionSectionSha256 = (decisionId, repositoryRoot = root) => {
  const text = fs.readFileSync(path.join(repositoryRoot, PDP0_DECISION_LOG_PATH), 'utf8');
  const heading = new RegExp(`^### ${decisionId}\\b[^\\n]*(?:\\n|$)`, 'm');
  const match = heading.exec(text);
  if (!match) throw new Error(`decision log is missing ${decisionId}`);
  const next = /^### PXD-\d{3}\b[^\n]*(?:\n|$)/gm;
  next.lastIndex = match.index + match[0].length;
  const end = next.exec(text)?.index ?? text.length;
  return crypto.createHash('sha256').update(text.slice(match.index, end)).digest('hex');
};
const identity = ref => ref.match(/#capabilities\/@id=([^/]+)/)?.[1] ?? null;
const acceptanceRef = ref => /(?:\/acceptanceCases\/@id=|\/acceptanceClauses\/@id=|#acceptanceCases\/@id=)/.test(ref);
const requirementId = ref => ref.match(/#requirements\/@id=([^/]+)/)?.[1] ?? null;

function normalizeRow(row, requirementDocument, campaignExtensions) {
  const postPdpImplementationOnly = row.disposition === 'POST_PDP_IMPLEMENTATION_ONLY';
  const familyScopeOnly = row.pdp0CapabilityScopeDisposition === 'PARENT_REQUIREMENT_FAMILY_SCOPE_ONLY';
  const refs = row.pdp0EvidenceRefs ?? [];
  const contextRefs = row.pdp0ContextRefs ?? [];
  if (familyScopeOnly) {
    const expectedCapability = `${CAPABILITIES_PATH}#capabilities/@id=media.quality.inspect`;
    const expectedCase = `${REQUIREMENTS_PATH}#requirements/@id=MEDIA-REQ-CAP-QUALITY/acceptanceCases/@id=MEDIA-REQ-CAP-QUALITY-AC-06`;
    if (row.auditId !== 'AUD-CLONE-012' || !contextRefs.includes(expectedCapability)
        || !refs.includes(expectedCase) || !/parent-requirement family scope/i.test(row.phaseLocalRationale ?? '')
        || !/no watermark-specific capability claim/i.test(row.phaseLocalRationale ?? '')
        || !/stripping or removal/i.test(row.phaseLocalRationale ?? '')) {
      throw new Error(`${row.auditId} has an unsupported family-scope capability qualifier`);
    }
  }
  if (postPdpImplementationOnly && ((row.pdp0EvidenceRefs ?? []).length
      || !Array.isArray(row.laterPhaseHandoffs)
      || !row.laterPhaseHandoffs.some(handoff => handoff.phase === 'BUILD'))) {
    throw new Error(`${row.auditId} post-PDP implementation-only disposition must retain empty PDP-0 evidence and a BUILD handoff`);
  }
  const evidenceCapabilityRefs = [...new Set(refs.filter(ref => identity(ref)))].sort();
  const contextCapabilityRefs = [...new Set(contextRefs.filter(ref => identity(ref)))].sort();
  const evidenceAcceptanceCaseRefs = [...new Set(refs.filter(acceptanceRef))].sort();
  const proposalRecord = (campaignExtensions.records ?? []).find(record => record.id === row.auditId);
  const proposalCapabilityDefinitionRef = `${CAMPAIGN_EXTENSIONS_PATH}#records/@id=${row.auditId}/capabilityDefinition`;
  const proposalRequirementDefinitionRef = `${CAMPAIGN_EXTENSIONS_PATH}#records/@id=${row.auditId}/requirementDefinition`;
  const proposalCapability = proposalRecord?.capabilityDefinition;
  const proposalRequirement = proposalRecord?.requirementDefinition;
  const proposalAcceptanceCaseRefs = evidenceAcceptanceCaseRefs.filter(ref =>
    ref.startsWith(`${proposalRequirementDefinitionRef}/acceptanceCases/@id=`));
  const proposalHasExactJoin = proposalRecord
    && refs.includes(proposalCapabilityDefinitionRef)
    && refs.includes(proposalRequirementDefinitionRef)
    && proposalCapability?.id === proposalRecord.stableFeatureId
    && proposalCapability?.requirementIds?.includes(proposalRequirement?.id)
    && proposalRequirement?.capabilityIds?.includes(proposalCapability.id)
    && proposalAcceptanceCaseRefs.length > 0
    && proposalAcceptanceCaseRefs.every(ref => proposalRequirement.acceptanceCases?.some(item =>
      ref.endsWith(`/@id=${item.id}`)))
    && row.ownerApproval === 'NOT_CLAIMED'
    && /owner acceptance pending/i.test(proposalCapability.definitionState ?? '')
    && /owner acceptance pending/i.test(proposalRequirement.scopeStatus ?? '');
  const requirementRefs = new Set(refs.filter(ref => requirementId(ref) && !acceptanceRef(ref)));
  for (const ref of evidenceAcceptanceCaseRefs) {
    const id = requirementId(ref);
    if (id) requirementRefs.add(`.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=${id}`);
  }
  const recorderClauses = requirementDocument.recorderStudioProfile?.acceptanceClauses ?? [];
  const declarativeClauses = requirementDocument.declarativeProductionProfile?.acceptanceClauses ?? [];
  const clauseRefMap = new Map([
    ...recorderClauses.map(clause => [`${REQUIREMENTS_PATH}#recorderStudioProfile/acceptanceClauses/@id=${clause.id}`, clause]),
    ...declarativeClauses.map(clause => [`${REQUIREMENTS_PATH}#declarativeProductionProfile/acceptanceClauses/@id=${clause.id}`, clause]),
  ]);
  const caseDerivedCapabilityRefs = [...new Set(evidenceAcceptanceCaseRefs
    .map(ref => clauseRefMap.get(ref)?.capabilityLeafId)
    .filter(Boolean)
    .map(capabilityId => `${CAPABILITIES_PATH}#capabilities/@id=${capabilityId}`))].sort();
  const capabilityRefs = [...new Set([...evidenceCapabilityRefs, ...contextCapabilityRefs, ...caseDerivedCapabilityRefs])].sort();
  const capabilityRefRelations = capabilityRefs.map(ref => ({
    capabilityId: identity(ref),
    sourceRef: ref,
    relation: evidenceCapabilityRefs.includes(ref) ? 'DIRECT_PDP0_EVIDENCE'
      : contextCapabilityRefs.includes(ref) && familyScopeOnly ? 'PARENT_REQUIREMENT_FAMILY_SCOPE_ONLY'
        : contextCapabilityRefs.includes(ref) ? 'EXACT_PDP0_CONTEXT_REFERENCE'
        : 'EXACT_CAPABILITY_LEAF_ID_ON_PDP0_CASE',
  }));
  const capabilities = new Set(capabilityRefs.map(identity).filter(Boolean));
  const capabilityRequirementRelations = [];
  for (const capabilityId of capabilities) {
    for (const requirement of requirementDocument.requirements.filter(candidate => candidate.capabilityIds?.includes(capabilityId))) {
      const sourceRef = `${REQUIREMENTS_PATH}#requirements/@id=${requirement.id}`;
      requirementRefs.add(sourceRef);
      capabilityRequirementRelations.push({
        capabilityId,
        requirementId: requirement.id,
        sourceRef,
        relation: 'REQUIREMENT_CAPABILITY_IDS_CONTAINS_EXACT_CAPABILITY_ID',
      });
    }
  }
  const capabilityScopedClauses = [...recorderClauses, ...declarativeClauses]
    .filter(clause => capabilities.has(clause.capabilityLeafId))
    .map(clause => {
      const profile = recorderClauses.includes(clause) ? 'recorderStudioProfile' : 'declarativeProductionProfile';
      const req = requirementDocument.requirements.find(requirement => requirement.id === clause.parentRequirementId);
      return {
        ref: `${REQUIREMENTS_PATH}#${profile}/acceptanceClauses/@id=${clause.id}`,
        relation: 'EXACT_CAPABILITY_LEAF_ID',
        capabilityId: clause.capabilityLeafId,
        parentRequirementId: clause.parentRequirementId,
        parentRequirementListsCapability: req?.capabilityIds?.includes(clause.capabilityLeafId) === true,
      };
    });
  const capabilityScopedAcceptanceRefs = capabilityScopedClauses
    .filter(clause => clause.parentRequirementListsCapability).map(clause => clause.ref).sort();
  const requirementScopedCases = capabilityRequirementRelations.flatMap(relation => {
    const requirement = requirementDocument.requirements.find(candidate => candidate.id === relation.requirementId);
    return (requirement?.acceptanceCases ?? []).map(clause => ({
      ref: `${REQUIREMENTS_PATH}#requirements/@id=${requirement.id}/acceptanceCases/@id=${clause.id}`,
      capabilityId: relation.capabilityId,
      requirementId: requirement.id,
      relation: 'PARENT_REQUIREMENT_SCOPE_ONLY',
    }));
  });
  const requirementScopedAcceptanceRefs = requirementScopedCases.map(clause => clause.ref).sort();
  const acceptanceCaseRefs = [...new Set([
    ...evidenceAcceptanceCaseRefs,
    ...capabilityScopedAcceptanceRefs,
    ...requirementScopedAcceptanceRefs,
  ])].sort();
  for (const clause of capabilityScopedClauses) {
    if (clause.parentRequirementListsCapability) requirementRefs.add(`${REQUIREMENTS_PATH}#requirements/@id=${clause.parentRequirementId}`);
  }
  const sortedRequirementRefs = [...requirementRefs].sort();
  const missingJoins = [];
  if (!postPdpImplementationOnly && !proposalHasExactJoin) {
    if (!capabilityRefs.length) missingJoins.push('canonicalCapability');
    if (!sortedRequirementRefs.length) missingJoins.push('canonicalRequirement');
    if (!acceptanceCaseRefs.length) missingJoins.push('acceptanceCase');
  }
  let status = 'SOURCE_BOUND_COMPLETE';
  if (row.disposition === 'EXPLICIT_NOT_APPLICABLE') status = 'EXPLICIT_NOT_APPLICABLE';
  else if (postPdpImplementationOnly) status = 'POST_PDP_IMPLEMENTATION_ONLY_OUTSIDE_PDP0_SEMANTIC_JOIN';
  else if (missingJoins.length) status = 'BLOCKED_MISSING_EXACT_JOIN';
  else if (proposalHasExactJoin) status = 'SOURCE_BOUND_COORDINATOR_PDP0_PROPOSAL_PENDING_OWNER_REVIEW';
  else if (familyScopeOnly) status = 'SOURCE_BOUND_FAMILY_SCOPE_ONLY_EXACT_CASE';
  else if (!evidenceAcceptanceCaseRefs.length && !capabilityScopedAcceptanceRefs.length) status = 'SOURCE_BOUND_FAMILY_CASE_JOIN_SEMANTIC_FIT_REVIEW_REQUIRED';
  return {
    auditId: row.auditId,
    sourcePartition: row.sourcePartition,
    sourceTextRef: row.sourceTextRef,
    sourceFeatureText: row.sourceText,
    sourceAcceptanceText: row.sourceAcceptanceText,
    disposition: row.disposition,
    phaseLocalRationale: row.phaseLocalRationale,
    laterPhaseHandoffs: row.laterPhaseHandoffs ?? null,
    ownerApproval: row.ownerApproval,
    externalOwnerDecision: row.externalOwnerDecision ?? null,
    capabilityScopeDisposition: row.pdp0CapabilityScopeDisposition ?? 'NO_SPECIAL_FAMILY_SCOPE_QUALIFIER',
    pdp0JoinScopeDisposition: postPdpImplementationOnly ? 'NO_PDP0_JOIN_REQUIRED_POST_PDP_IMPLEMENTATION_ONLY' : 'PDP0_DEFINITION_JOIN_REQUIRED',
    excludedPdp0JoinTypes: postPdpImplementationOnly ? ['canonicalCapability', 'canonicalRequirement', 'acceptanceCase'] : [],
    ownerSurfaceProposal: row.ownerSurfaceProposal ?? null,
    definitionScopeBinding: row.definitionScopeBinding ?? null,
    proposalDefinition: proposalHasExactJoin ? {
      status: 'COORDINATOR_AUTHORED_PDP0_PROPOSAL_PENDING_OWNER_REVIEW',
      stableFeatureId: proposalRecord.stableFeatureId,
      capabilityDefinitionRef: proposalCapabilityDefinitionRef,
      capabilityId: proposalCapability.id,
      requirementDefinitionRef: proposalRequirementDefinitionRef,
      requirementId: proposalRequirement.id,
      acceptanceCaseRefs: proposalAcceptanceCaseRefs,
      ownerApproval: row.ownerApproval,
      independentAcceptance: 'NOT_CLAIMED',
    } : null,
    canonicalCapabilityRefs: capabilityRefs,
    capabilityRefRelations,
    canonicalRequirementRefs: sortedRequirementRefs,
    capabilityRequirementRelations,
    acceptanceCaseRefs,
    acceptanceCaseRelation: proposalHasExactJoin ? 'EXACT_COORDINATOR_PDP0_PROPOSAL_CASES_PENDING_OWNER_REVIEW'
      : evidenceAcceptanceCaseRefs.length
      ? 'EXACT_AUDIT_ROW_EVIDENCE'
      : capabilityScopedAcceptanceRefs.length ? 'EXACT_CAPABILITY_LEAF_SCOPE'
        : requirementScopedAcceptanceRefs.length ? 'PARENT_REQUIREMENT_SCOPE_ONLY' : 'MISSING_EXACT_CASE_RELATION',
    acceptanceCaseCandidateRefs: capabilityScopedAcceptanceRefs,
    acceptanceCaseCandidateRelation: capabilityScopedAcceptanceRefs.length
      ? 'CAPABILITY_LEAF_ID_ON_CANONICAL_CASE'
      : requirementScopedAcceptanceRefs.length ? 'PARENT_REQUIREMENT_SCOPE_ONLY' : null,
    requirementScopedAcceptanceCaseRefs: requirementScopedAcceptanceRefs,
    featureSpecificCaseApplicability: proposalHasExactJoin ? 'SOURCE_BOUND_PROPOSAL_CASES; CANONICAL_OWNER_ACCEPTANCE_NOT_CLAIMED'
      : evidenceAcceptanceCaseRefs.length || capabilityScopedAcceptanceRefs.length
      ? 'SOURCE_BOUND_CASE_LINK_EXISTS_BUT_FEATURE_SEMANTIC_FIT_IS_NOT_CLAIMED'
      : requirementScopedAcceptanceRefs.length ? 'REVIEW_REQUIRED_PARENT_CASES_ARE_NOT_FEATURE_SPECIFIC' : 'NO_CASE_REFERENCE',
    traceabilityStatus: status,
    missingExactJoins: missingJoins,
    explicitNotApplicableRef: row.disposition === 'EXPLICIT_NOT_APPLICABLE' ? row.externalOwnerDecision : null,
  };
}

function currentSourceReviewScope(document) {
  if (document.reviewScope) return {
    start: document.reviewScope.sourceOrderFirst1Based,
    end: document.reviewScope.sourceOrderLast1Based,
    count: document.reviewScope.expectedRowCount,
  };
  const sourceOrderRange = document.review?.sourceOrderRange;
  return sourceOrderRange ? {start: sourceOrderRange.startIndex, end: sourceOrderRange.endIndex, count: sourceOrderRange.count} : null;
}

function currentSourceReviewSummary(document) {
  const semantic = document.semanticAssessment ?? document.semanticDisposition ?? {};
  const supported = semantic.supportedRecommendationCount ?? semantic.supported ?? semantic.primaryClusterRecommendationsSupported;
  const mismatched = semantic.mismatchedRecommendationCount ?? semantic.mismatched
    ?? semantic.mismatchedPrimaryRecommendations?.length ?? 0;
  const scope = currentSourceReviewScope(document);
  return {
    supported,
    ambiguous: semantic.ambiguousRecommendationCount ?? semantic.ambiguous
      ?? (Number.isInteger(scope?.count) && Number.isInteger(supported) ? scope.count - supported - mismatched : undefined),
    mismatched,
    corrected: semantic.correctedRecommendationCount ?? semantic.corrected ?? semantic.correctedRelatedClusterLabels?.length ?? 0,
  };
}

function validateCurrentSourceReview(repositoryRoot, file, expected, recommendationFile) {
  const document = JSON.parse(fs.readFileSync(path.join(repositoryRoot, file), 'utf8'));
  const scope = currentSourceReviewScope(document);
  const expectedScope = {start: expected.start, end: expected.end, count: 154};
  if (JSON.stringify(scope) !== JSON.stringify(expectedScope)) throw new Error(`${file} scope must cover exact rows ${expected.start}-${expected.end}`);
  const currentSources = document.sourceFingerprints?.currentSources ?? Object.fromEntries(
    Object.entries(document.materialInputs ?? {}).filter(([ref]) => ref === CAPABILITIES_PATH || ref === REQUIREMENTS_PATH || ref === BLUEPRINT_PATH)
      .map(([ref, value]) => [ref, value.sha256]),
  );
  for (const sourceRef of [CAPABILITIES_PATH, REQUIREMENTS_PATH, BLUEPRINT_PATH]) {
    if (currentSources?.[sourceRef] !== sha256(sourceRef, repositoryRoot)) throw new Error(`${file} has a stale or missing current-source pin for ${sourceRef}`);
  }
  const recommendationHash = document.sourceFingerprints?.recommendationFile?.sha256
    ?? document.materialInputs?.[recommendationFile]?.sha256;
  if (recommendationHash !== sha256(recommendationFile, repositoryRoot)) throw new Error(`${file} has a stale or missing recommendation pin for ${recommendationFile}`);
  const summary = currentSourceReviewSummary(document);
  if (summary.supported !== expected.supported || summary.ambiguous !== expected.ambiguous
      || summary.mismatched !== 0 || summary.corrected !== expected.corrected) {
    throw new Error(`${file} semantic disposition must match supported=${expected.supported}, ambiguous=${expected.ambiguous}, corrected=${expected.corrected}, mismatched=0`);
  }
  const structural = document.structuralResults ?? document.identityAndLinkResults ?? {};
  const structuralPass = structural.result === 'PASS'
    || (structural.allRecommendationCapabilityIdsMatchCurrentSourceOrder === true
      && structural.recommendationCapabilityIdsMismatched === 0
      && structural.parentRequirementLinksMismatched === 0)
    || (structural.allRecommendationOrdersMatchCurrentCapabilitySlice === true
      && structural.recommendationCapabilityIdsMatchCurrentSourceOrder === expectedScope.count
      && structural.parentRequirementLinksMismatched === 0);
  if (!structuralPass) throw new Error(`${file} does not prove exact recommendation order, capability identity, and parent-requirement joins`);
  return document;
}

function normalizeCapabilityReviewRows(repositoryRoot, capabilityDocument, requirementDocument, leafReviewDocument) {
  const sourceRows = CAPABILITY_REVIEW_PATHS.flatMap(file => {
    const document = JSON.parse(fs.readFileSync(path.join(repositoryRoot, file), 'utf8'));
    const rows = document.rows ?? document.mappings;
    if (!Array.isArray(rows)) throw new Error(`${file} must contain rows or mappings`);
    return rows.map(row => ({row, file}));
  });
  const capabilities = capabilityDocument.capabilities ?? [];
  const canonicalRows = leafReviewDocument.ownerCapabilityLeafAdjudication?.records ?? [];
  const canonicalIds = canonicalRows.map(row => row.capabilityRef);
  if (canonicalIds.length !== 462 || new Set(canonicalIds).size !== 462) throw new Error(`owner adjudication must contain exactly 462 unique canonical capability IDs; found ${canonicalIds.length}`);
  if (sourceRows.length !== canonicalIds.length) throw new Error(`capability A–Q slices must contain the ${canonicalIds.length} historically owner-adjudicated rows; found ${sourceRows.length}`);
  CAPABILITY_CURRENT_SOURCE_REVIEW_PATHS.forEach((file, index) => validateCurrentSourceReview(
    repositoryRoot,
    file,
    [
      {start: 1, end: 154, supported: 148, ambiguous: 6, corrected: 0},
      {start: 155, end: 308, supported: 154, ambiguous: 0, corrected: 0},
      // The one correction removes an unsupported related-cluster label. It
      // does not invalidate the still-supported primary cluster recommendation.
      {start: 309, end: 462, supported: 154, ambiguous: 0, corrected: 1},
    ][index],
    CAPABILITY_REVIEW_PATHS[index],
  ));
  const capabilityIndexById = new Map(capabilities.map((capability, index) => [capability.id, index]));
  const capabilityById = new Map(capabilities.map(capability => [capability.id, capability]));
  const requirementById = new Map((requirementDocument.requirements ?? []).map(requirement => [requirement.id, requirement]));
  const seen = new Set();
  return sourceRows.map(({row, file}, index) => {
    const capabilityId = row.capabilityId;
    const current = capabilityById.get(capabilityId);
    if (!current) throw new Error(`${file} row ${index + 1} references unknown capability ${capabilityId}`);
    if (capabilityId !== canonicalIds[index]) throw new Error(`capability A–Q recommendation order mismatch at row ${index + 1}: expected owner-adjudicated ${canonicalIds[index]}, found ${capabilityId}`);
    if (seen.has(capabilityId)) throw new Error(`duplicate capability A–Q recommendation for ${capabilityId}`);
    seen.add(capabilityId);
    if (!canonicalIds.includes(capabilityId)) throw new Error(`${capabilityId} is outside the historical owner-adjudicated A–Q denominator`);
    const expectedCapabilityRef = `${CAPABILITIES_PATH}#capabilities/@id=${capabilityId}`;
    const normalizedSourceRef = typeof row.capabilitySourceRef === 'string'
      ? row.capabilitySourceRef.replace('#/capabilities/@id=', '#capabilities/@id=')
      : null;
    if (normalizedSourceRef !== expectedCapabilityRef) throw new Error(`${capabilityId} capability source ref is not the exact canonical leaf reference`);
    const parentRequirementId = row.parentRequirementId;
    const requirement = requirementById.get(parentRequirementId);
    if (!requirement) throw new Error(`${capabilityId} maps to unknown parent requirement ${parentRequirementId}`);
    if (!(requirement.capabilityIds ?? []).includes(capabilityId)) throw new Error(`${capabilityId} is not listed in ${parentRequirementId}.capabilityIds`);
    if (!(current.requirementIds ?? []).includes(parentRequirementId)) throw new Error(`${parentRequirementId} is not an exact capability requirementIds edge for ${capabilityId}`);
    const expectedRequirementRef = `${REQUIREMENTS_PATH}#requirements/@id=${parentRequirementId}`;
    if (row.parentRequirementSourceRef && row.parentRequirementSourceRef !== expectedRequirementRef) {
      throw new Error(`${capabilityId} parent requirement ref is not canonical`);
    }
    const primaryCluster = row.primaryCluster ?? row.primaryClusterId;
    const relatedClusters = row.relatedClusters ?? row.relatedClusterIds ?? [];
    if (!CLUSTER_IDS.includes(primaryCluster) || !Array.isArray(relatedClusters)
        || relatedClusters.some(clusterId => !CLUSTER_IDS.includes(clusterId))
        || relatedClusters.includes(primaryCluster) || new Set(relatedClusters).size !== relatedClusters.length) {
      throw new Error(`${capabilityId} has malformed A–Q recommendation`);
    }
    const rationale = row.rationale ?? row.semanticRationale;
    if (row.status !== 'COORDINATOR_MAPPING_RECOMMENDATION' || row.ownerAcceptance !== 'NOT_CLAIMED') {
      throw new Error(`${capabilityId} must remain a coordinator recommendation with owner acceptance NOT_CLAIMED`);
    }
    if (row.scopeDisposition !== undefined && row.scopeDisposition !== 'TARGET') throw new Error(`${capabilityId} is not an explicit TARGET capability mapping`);
    if (!rationale?.trim()) throw new Error(`${capabilityId} is missing mapping rationale`);
    const rowOrder = row.sourceOrderIndex ?? row.sourceOrder1Based;
    if (rowOrder !== index + 1) throw new Error(`${capabilityId} source order marker ${rowOrder} does not match YAML order ${index + 1}`);
    const deferredId = DEFERRED_AQ_CAPABILITIES.get(index + 1);
    if (deferredId && deferredId !== capabilityId) throw new Error(`PXD-220 deferred row ${index + 1} must be ${deferredId}, found ${capabilityId}`);
    const correction = CAPABILITY_AQ_CORRECTIONS.get(index + 1);
    if (correction && correction.capabilityId !== capabilityId) throw new Error(`PXD-221 correction row ${index + 1} must be ${correction.capabilityId}, found ${capabilityId}`);
    if (correction && (primaryCluster !== 'D' || !relatedClusters.includes(correction.removedRelatedClusterId))) {
      throw new Error(`${capabilityId} must retain primary D and source recommendation P for the PXD-221 correction evidence`);
    }
    const deferred = deferredId !== undefined;
    const acceptedRelatedClusters = correction
      ? relatedClusters.filter(clusterId => clusterId !== correction.removedRelatedClusterId)
      : relatedClusters;
    return {
      sourceOrder1Based: index + 1,
      capabilityId,
      capabilitySourceRef: expectedCapabilityRef,
      capabilityReviewSourceRef: file,
      parentRequirementId,
      parentRequirementSourceRef: expectedRequirementRef,
      primaryCluster: deferred ? null : primaryCluster,
      relatedClusters: deferred ? [] : [...acceptedRelatedClusters],
      sourceRecommendedPrimaryCluster: primaryCluster,
      sourceRecommendedRelatedClusters: [...relatedClusters],
      classificationDisposition: deferred ? 'DEFERRED_TO_LATER_GOVERNED_PDP0_CYCLE'
        : correction ? 'ACCEPTED_AS_INDEXING_ONLY_WITH_SOURCE_CORRECTION' : 'ACCEPTED_AS_INDEXING_ONLY',
      classificationDecisionRef: deferred || !correction ? TAXONOMY_DECISION_REF : correction.decisionRef,
      currentSourceReviewRef: CAPABILITY_CURRENT_SOURCE_REVIEW_PATHS[Math.floor(index / 154)],
      removedRelatedClusterIds: correction ? [correction.removedRelatedClusterId] : [],
      capabilityMeaningOwnerApproval: 'NOT_CLAIMED',
      rationale,
      mappingUncertainty: row.mappingUncertainty ?? null,
      status: deferred ? 'TAXONOMY_CLASSIFICATION_DEFERRED'
        : 'TAXONOMY_CLASSIFICATION_ACCEPTED_AS_INDEXING_ONLY',
      ownerAcceptance: 'NOT_CLAIMED',
    };
  });
}

function normalizeDefinitionExtensions(campaignDocument, capabilityDocument, requirementDocument, auditRows) {
  const records = campaignDocument.currentDefinitionPopulation?.records ?? [];
  const versionDisposition = campaignDocument.currentDefinitionPopulation?.versionDisposition;
  const deferredById = new Map((versionDisposition?.futureVersionProposals ?? []).map(proposal => [proposal.capabilityId, proposal]));
  const capabilities = new Map((capabilityDocument.capabilities ?? []).map(capability => [capability.id, capability]));
  const requirements = new Map((requirementDocument.requirements ?? []).map(requirement => [requirement.id, requirement]));
  if (records.length !== 7 || new Set(records.map(row => row.capabilityId)).size !== 7) throw new Error(`campaign extensions must contain exactly seven unique definition-extension proposals; found ${records.length}`);
  if (versionDisposition?.historicalCanonicalCapabilityLeaves !== 462
      || versionDisposition?.currentVersionCapabilityLeaves !== 462
      || versionDisposition?.futureVersionProposalCapabilityLeaves !== 7
      || versionDisposition?.totalSourceCapabilityDefinitions !== 469
      || deferredById.size !== 7 || (versionDisposition?.currentVersionExtensionCapabilityIds ?? []).length !== 0) {
    throw new Error('PDP-0 version disposition must preserve 462 current leaves, 7 deferred extensions, and 469 source definitions');
  }
  return records.map(record => {
    const capability = capabilities.get(record.capabilityId);
    if (!capability) throw new Error(`extension proposal references missing capability ${record.capabilityId}`);
    const versionProposal = deferredById.get(record.capabilityId);
    if (!versionProposal || versionProposal.scopeStatus !== 'DEFERRED' || capability.scopeStatus !== 'DEFERRED') {
      throw new Error(`${record.capabilityId} must be retained as a source proposal and explicitly deferred from the current version`);
    }
    const expectedVersionDecision = record.capabilityId === 'media.master.audio.creative-effect.apply'
      ? `${PDP0_DECISION_LOG_PATH}#PXD-221` : TAXONOMY_DECISION_REF;
    if (versionProposal.decisionRef !== expectedVersionDecision) throw new Error(`${record.capabilityId} must bind its exact current-version deferral decision`);
    const requirementId = record.requirementRef?.match(/#requirements\/@id=([^/]+)/)?.[1];
    const requirement = requirements.get(requirementId);
    if (!requirement || !(requirement.capabilityIds ?? []).includes(record.capabilityId)) throw new Error(`${record.capabilityId} lacks its exact parent requirement edge`);
    if (typeof record.familyRef !== 'string' || !record.familyRef.includes('#families/@id=')) throw new Error(`${record.capabilityId} lacks an exact proposal family ref`);
    const acceptanceCaseIds = new Set((requirement.acceptanceCases ?? []).map(item => `${REQUIREMENTS_PATH}#requirements/@id=${requirement.id}/acceptanceCases/@id=${item.id}`));
    if (!Array.isArray(record.acceptanceCaseRefs) || !record.acceptanceCaseRefs.length
        || record.acceptanceCaseRefs.some(ref => !acceptanceCaseIds.has(ref))) throw new Error(`${record.capabilityId} has an unresolved or non-family acceptance case ref`);
    if (!Array.isArray(record.sourceAuditIds) || !record.sourceAuditIds.length) throw new Error(`${record.capabilityId} has no source audit IDs`);
    const matchingAuditRows = auditRows.filter(row => record.sourceAuditIds?.includes(row.auditId));
    if (matchingAuditRows.length !== (record.sourceAuditIds ?? []).length) throw new Error(`${record.capabilityId} references an unknown source audit ID`);
    return {
      capabilityId: record.capabilityId,
      capabilitySourceRef: `${CAPABILITIES_PATH}#capabilities/@id=${record.capabilityId}`,
      familyRef: record.familyRef,
      requirementRef: record.requirementRef,
      acceptanceCaseRefs: [...(record.acceptanceCaseRefs ?? [])],
      sourceAuditIds: [...(record.sourceAuditIds ?? [])],
      sourceAuditRefs: matchingAuditRows.map(row => row.sourceTextRef),
      campaignExtensionSourceRef: `${CAMPAIGN_EXTENSIONS_PATH}#currentDefinitionPopulation/records/@capabilityId=${record.capabilityId}`,
      versionScopeDisposition: 'DEFERRED_TO_LATER_GOVERNED_PDP0_VERSION',
      versionDispositionRef: `${CAMPAIGN_EXTENSIONS_PATH}#currentDefinitionPopulation/versionDisposition/futureVersionProposals/@capabilityId=${record.capabilityId}`,
      versionDecisionRef: versionProposal.decisionRef,
      disposition: 'COORDINATOR_AUTHORED_PROPOSAL_PENDING_OWNER_REVIEW',
      ownerApproval: record.ownerApproval ?? 'NOT_CLAIMED',
      independentAcceptance: record.independentAcceptance ?? 'NOT_CLAIMED',
      admittedToHistoricalOwnerAdjudication: false,
      executionAdmission: 'NOT_ADMITTED',
    };
  });
}

function clusterRows(blueprint, mappedRows, capabilityMappings) {
  const rows = blueprint.split(/\r?\n/).filter(line => /^\| [A-Q] — /.test(line));
  return CLUSTER_IDS.map(clusterId => {
    const sourceText = rows.find(line => line.startsWith(`| ${clusterId} — `));
    if (!sourceText) throw new Error(`Blueprint has no exact A–Q cluster row for ${clusterId}`);
    const primaryRows = mappedRows.filter(row => row.clusterMembership?.primaryCluster === clusterId);
    const relatedRows = mappedRows.filter(row => row.clusterMembership?.relatedClusters.includes(clusterId));
    const recommendedCapabilities = capabilityMappings.filter(row => row.primaryCluster === clusterId || row.relatedClusters.includes(clusterId));
    const capabilityRefs = [...new Set([...primaryRows, ...relatedRows].flatMap(row => row.canonicalCapabilityRefs)
      .concat(recommendedCapabilities.map(row => row.capabilitySourceRef)))].sort();
    const recorderAcceptanceRefs = [...new Set([...primaryRows, ...relatedRows].flatMap(row => [
      ...row.acceptanceCaseRefs.filter(ref => ref.includes('recorderStudioProfile/acceptanceClauses/')),
      ...row.acceptanceCaseCandidateRefs.filter(ref => ref.includes('recorderStudioProfile/acceptanceClauses/')),
    ]))].sort();
    return {
      clusterId,
      sourceText,
      sourceRef: `${BLUEPRINT_PATH}#cluster-${clusterId}`,
      primaryAuditIds: primaryRows.map(row => row.auditId).sort(),
      relatedAuditIds: relatedRows.map(row => row.auditId).sort(),
      auditIds: [...new Set([...primaryRows, ...relatedRows].map(row => row.auditId))].sort(),
      canonicalCapabilityRefs: capabilityRefs,
      recommendedCapabilityRefs: [...new Set(recommendedCapabilities.map(row => row.capabilitySourceRef))].sort(),
      recommendedCapabilityIds: recommendedCapabilities.map(row => row.capabilityId).sort(),
      auditReferencedCapabilityRefs: [...new Set([...primaryRows, ...relatedRows].flatMap(row => row.canonicalCapabilityRefs))].sort(),
      recorderAcceptanceRefs,
      mappingStatus: 'ACCEPTED_AS_INDEXING_ONLY',
      decisionRef: ORIGINAL_AUDIT_TAXONOMY_DECISION_REF,
      authorityNote: 'PXD-219 accepts this original-audit cluster assignment as a traceability/index classification only. It does not change PDP-0 meaning, audit disposition, implementation, or independent acceptance.',
    };
  });
}

function aqReviewRows(repositoryRoot) {
  return AQ_REVIEW_PATHS.flatMap(file => JSON.parse(fs.readFileSync(path.join(repositoryRoot, file), 'utf8')).rows);
}

export function buildPdp0AuditAqTraceability(repositoryRoot = root) {
  const crosswalk = JSON.parse(fs.readFileSync(path.join(repositoryRoot, PDP0_AUDIT_DISPOSITION_CROSSWALK_PATH), 'utf8'));
  const blueprint = fs.readFileSync(path.join(repositoryRoot, BLUEPRINT_PATH), 'utf8');
  const requirementDocument = parseYaml(fs.readFileSync(path.join(repositoryRoot, REQUIREMENTS_PATH), 'utf8'));
  const capabilityDocument = parseYaml(fs.readFileSync(path.join(repositoryRoot, CAPABILITIES_PATH), 'utf8'));
  const leafReviewDocument = parseYaml(fs.readFileSync(path.join(repositoryRoot, CAPABILITY_LEAF_REVIEW_PATH), 'utf8'));
  const campaignExtensions = parseYaml(fs.readFileSync(path.join(repositoryRoot, CAMPAIGN_EXTENSIONS_PATH), 'utf8'));
  const reviews = aqReviewRows(repositoryRoot);
  const capabilityRecommendations = normalizeCapabilityReviewRows(repositoryRoot, capabilityDocument, requirementDocument, leafReviewDocument);
  const reviewById = new Map(reviews.map(row => [row.auditId, row]));
  if (reviewById.size !== 428) throw new Error(`A–Q review slices must contain 428 unique original audit IDs; found ${reviewById.size}`);
  const rows = crosswalk.rows.map(sourceRow => {
    const row = normalizeRow(sourceRow, requirementDocument, campaignExtensions);
    if (sourceRow.sourcePartition === 'originalAudit') {
      const mapping = reviewById.get(row.auditId);
      if (!mapping) throw new Error(`A–Q review slices omit original audit ID ${row.auditId}`);
      if (!CLUSTER_IDS.includes(mapping.primaryCluster) || !Array.isArray(mapping.relatedClusters)
          || mapping.relatedClusters.some(clusterId => !CLUSTER_IDS.includes(clusterId))
          || mapping.relatedClusters.includes(mapping.primaryCluster) || !mapping.rationale?.trim()) {
        throw new Error(`${row.auditId} has malformed A–Q recommendation`);
      }
      row.clusterMembership = {
        status: 'ACCEPTED_AS_INDEXING_ONLY',
        decisionRef: ORIGINAL_AUDIT_TAXONOMY_DECISION_REF,
        primaryCluster: mapping.primaryCluster,
        relatedClusters: [...mapping.relatedClusters],
        rationale: mapping.rationale,
        ownerAcceptance: 'NOT_CLAIMED',
      };
    } else {
      row.clusterMembership = {
        status: 'EXPLICIT_OUTSIDE_ORIGINAL_AQ_AUDIT_SCOPE',
        primaryCluster: null,
        relatedClusters: [],
        rationale: 'This source row belongs to the separate 73-item third-pass audit partition, not the original 428-row inventory that the blueprint §2 A–Q clusters classify. It remains in the 501-row source denominator. This excludes it only from that original cluster taxonomy; PDP-0 product applicability and joins follow its own source-bound disposition, including rows explicitly routed to post-PDP implementation with no PDP-0 joins.',
        ownerAcceptance: 'NOT_CLAIMED',
      };
    }
    return row;
  });
  for (const mapping of reviews) if (!rows.some(row => row.auditId === mapping.auditId && row.sourcePartition === 'originalAudit')) {
    throw new Error(`A–Q review contains unexpected or non-original audit ID ${mapping.auditId}`);
  }
  const missing = rows.filter(row => row.traceabilityStatus === 'BLOCKED_MISSING_EXACT_JOIN');
  const postPdpImplementationRows = rows.filter(row => row.traceabilityStatus === 'POST_PDP_IMPLEMENTATION_ONLY_OUTSIDE_PDP0_SEMANTIC_JOIN');
  const familyScopeRows = rows.filter(row => row.traceabilityStatus === 'SOURCE_BOUND_FAMILY_SCOPE_ONLY_EXACT_CASE');
  const mappedCaseRefs = new Set(rows.flatMap(row => row.acceptanceCaseCandidateRefs));
  const capabilityMappings = capabilityRecommendations.map(recommendation => {
    const capability = capabilityDocument.capabilities.find(item => item.id === recommendation.capabilityId);
    const matchingRows = rows.filter(row => row.canonicalCapabilityRefs.includes(`${CAPABILITIES_PATH}#capabilities/@id=${capability.id}`));
    const auditRows = matchingRows.filter(row => !row.capabilityRefRelations.some(relation =>
      relation.capabilityId === capability.id && relation.relation === 'PARENT_REQUIREMENT_FAMILY_SCOPE_ONLY'));
    const familyScopeAuditRows = matchingRows.filter(row => row.capabilityRefRelations.some(relation =>
      relation.capabilityId === capability.id && relation.relation === 'PARENT_REQUIREMENT_FAMILY_SCOPE_ONLY'));
    return {
      ...recommendation,
      requirementIds: [...(capability.requirementIds ?? [])],
      auditIds: auditRows.map(row => row.auditId).sort(),
      familyScopeAuditIds: familyScopeAuditRows.map(row => row.auditId).sort(),
      auditPrimaryClusters: [...new Set(auditRows.map(row => row.clusterMembership?.primaryCluster).filter(Boolean))].sort(),
      auditRelatedClusters: [...new Set(auditRows.flatMap(row => row.clusterMembership?.relatedClusters ?? []))].sort(),
      auditTraceStatus: auditRows.length ? 'EXACT_AUDIT_CAPABILITY_REFERENCE_PRESENT' : 'NO_EXACT_AUDIT_CAPABILITY_REFERENCE',
    };
  });
  const definitionExtensions = normalizeDefinitionExtensions(campaignExtensions, capabilityDocument, requirementDocument, rows);
  const sourceProfileClauses = [
    ...(requirementDocument.recorderStudioProfile?.acceptanceClauses ?? []).map(clause => ({clause, profile: 'recorderStudioProfile'})),
    ...(requirementDocument.declarativeProductionProfile?.acceptanceClauses ?? []).map(clause => ({clause, profile: 'declarativeProductionProfile'})),
  ];
  const unboundAcceptanceClauses = sourceProfileClauses
    .filter(({clause, profile}) => !mappedCaseRefs.has(`${REQUIREMENTS_PATH}#${profile}/acceptanceClauses/@id=${clause.id}`))
    .map(({clause, profile}) => ({
      caseId: clause.id,
      capabilityId: clause.capabilityLeafId,
      parentRequirementId: clause.parentRequirementId,
      sourceRef: `${REQUIREMENTS_PATH}#${profile}/acceptanceClauses/@id=${clause.id}`,
      reason: 'No audit row has an exact canonical capability reference matching this clause capabilityLeafId.',
    }));
  return {
    schemaVersion: 'ghatana.media.pdp0-audit-aq-traceability.v1',
    recordKind: 'PDP0_SOURCE_BOUND_TRACEABILITY_PROJECTION_NOT_CANONICAL_REQUIREMENTS_OR_OWNER_ACCEPTANCE',
    campaignScope: 'Media Discovery / PDP-0; exact original 428 plus exact third-pass 73 audit IDs; A–Q cluster traceability and audit-to-canonical joins.',
    macroStage: 'DISCOVERY',
    phase: 'PDP-0 Product Truth',
    sourceBaseline: {
      fingerprintAlgorithm: 'SHA-256 of exact file bytes',
      inputs: Object.fromEntries(INPUTS.map(file => [file, sha256(file, repositoryRoot)])),
      decisionSections: Object.fromEntries(['PXD-219', 'PXD-220', 'PXD-221'].map(decisionId => [
        `${PDP0_DECISION_LOG_PATH}#${decisionId}-section`, decisionSectionSha256(decisionId, repositoryRoot),
      ])),
    },
    denominators: {
      sourceAuditRows: 501,
      originalAuditRows: 428,
      thirdPassAuditRows: 73,
      blueprintClusters: 17,
      originalRowsWithClusterRecommendation: rows.filter(row => row.clusterMembership.status === 'ACCEPTED_AS_INDEXING_ONLY').length,
      focusedRowsOutsideClusterTaxonomy: rows.filter(row => row.clusterMembership.status === 'EXPLICIT_OUTSIDE_ORIGINAL_AQ_AUDIT_SCOPE').length,
      distinctCanonicalCapabilityRefs: new Set(rows.flatMap(row => row.canonicalCapabilityRefs)).size,
      canonicalCapabilityLeaves: capabilityMappings.length,
      currentCapabilityDefinitions: capabilityDocument.capabilities.length,
      proposalExtensionLeaves: definitionExtensions.length,
      capabilityLeavesWithClusterRecommendation: capabilityMappings.filter(row => row.primaryCluster).length,
      capabilityLeavesWithoutClusterRecommendation: capabilityMappings.filter(row => !row.primaryCluster).length,
      capabilityLeavesAcceptedAsIndexClassification: capabilityMappings.filter(row => row.classificationDisposition.startsWith('ACCEPTED_')).length,
      capabilityLeavesDeferredFromIndexClassification: capabilityMappings.filter(row => row.classificationDisposition === 'DEFERRED_TO_LATER_GOVERNED_PDP0_CYCLE').length,
      capabilityLeavesWithExactAuditClusterTrace: capabilityMappings.filter(row => row.auditIds.length).length,
      capabilityLeavesWithoutExactAuditClusterTrace: capabilityMappings.filter(row => !row.auditIds.length).length,
      recorderAcceptanceClauses: sourceProfileClauses.filter(({profile}) => profile === 'recorderStudioProfile').length,
      declarativeAcceptanceClauses: sourceProfileClauses.filter(({profile}) => profile === 'declarativeProductionProfile').length,
      profileClausesLinkedByExactCapability: mappedCaseRefs.size,
      rowsWithStructuralCapabilityRequirementCaseJoin: rows.filter(row => row.traceabilityStatus !== 'POST_PDP_IMPLEMENTATION_ONLY_OUTSIDE_PDP0_SEMANTIC_JOIN' && row.missingExactJoins.length === 0).length,
      rowsWithCanonicalCapabilityRequirementCaseJoin: rows.filter(row => row.canonicalCapabilityRefs.length > 0 && row.canonicalRequirementRefs.length > 0 && row.acceptanceCaseRefs.length > 0).length,
      rowsWithCoordinatorProposalDefinitionJoin: rows.filter(row => row.proposalDefinition !== null).length,
      rowsRequiringFamilyCaseSemanticFitReview: rows.filter(row => row.traceabilityStatus === 'SOURCE_BOUND_FAMILY_CASE_JOIN_SEMANTIC_FIT_REVIEW_REQUIRED').length,
      rowsOutsidePdp0DefinitionJoinAsImplementationOnly: postPdpImplementationRows.length,
      rowsWithExplicitFamilyScopeOnlyCapability: familyScopeRows.length,
      rowsBlockedMissingExactJoin: missing.length,
    },
    joinPolicy: 'Audit-row capability refs are projected only from exact PDP-0 evidence/context references or exact capabilityLeafId relations on named canonical profile clauses. A separately labeled parent-requirement family-scope link does not claim feature-specific capability semantics. Parent requirements require exact capabilityIds membership; acceptance cases retain their relation class: direct audit-row evidence; canonical Recorder/declarative clause with exact capabilityLeafId and matching parent requirement; or cases listed under the capability parent requirement. The latter proves only family scope, not feature-specific case applicability. Rows explicitly classified POST_PDP_IMPLEMENTATION_ONLY have no required PDP-0 capability/requirement/case join and remain visible with exact downstream handoffs. PXD-219 accepts the original 428-row A–Q assignments as indexing classifications only. PXD-220 accepts 456 of 462 capability classifications for indexing only and defers six ambiguous rows; PXD-221 removes unsupported related cluster P from row 371 while retaining primary D. These decisions change no capability meaning, requirement, or independent acceptance state. The 73 third-pass rows remain outside the original A–Q taxonomy. Other missing audit-row capability/requirement/case joins stay blocked; no product inapplicability is inferred.',
    clusters: clusterRows(blueprint, rows, capabilityMappings),
    capabilityMappings,
    definitionExtensions,
    rows,
    blockerSummary: {
      clusterMembership: 'All 428 original audit rows are accepted as indexing classifications under PXD-219. Of 462 capability taxonomy rows, 456 classifications are accepted as indexing-only, six ambiguous rows are deferred under PXD-220, and row 371 drops unsupported related cluster P under PXD-221. The 73 third-pass rows remain outside the original A–Q inventory taxonomy. Capability-meaning owner approval and independent acceptance are not claimed.',
      auditCaseJoins: missing.map(row => ({auditId: row.auditId, missingExactJoins: row.missingExactJoins})),
      familyCaseSemanticFitReviewRows: rows.filter(row => row.traceabilityStatus === 'SOURCE_BOUND_FAMILY_CASE_JOIN_SEMANTIC_FIT_REVIEW_REQUIRED').map(row => ({auditId: row.auditId, capabilityRefs: row.canonicalCapabilityRefs, acceptanceCaseRefs: row.acceptanceCaseRefs, candidateCaseRefs: row.acceptanceCaseCandidateRefs, featureSpecificCaseApplicability: row.featureSpecificCaseApplicability})),
      postPdpImplementationOnlyRows: postPdpImplementationRows.map(row => ({auditId: row.auditId, exactBuildAndLaterPhaseHandoffs: row.laterPhaseHandoffs})),
      familyScopeOnlyRows: familyScopeRows.map(row => ({auditId: row.auditId, capabilityRefs: row.canonicalCapabilityRefs, acceptanceCaseRefs: row.acceptanceCaseRefs, capabilityScopeDisposition: row.capabilityScopeDisposition})),
      unboundAcceptanceClauses,
    },
    nonClaims: ['capability meaning owner approval', 'independent acceptance', 'PDP-0 source-current DEV_COMPLETE', 'native closure', 'implementation', 'qualification', 'Delivery readiness'],
  };
}

export function validatePdp0AuditAqTraceability({repositoryRoot = root, artifact = null} = {}) {
  const errors = [];
  let actual;
  try { actual = artifact ?? JSON.parse(fs.readFileSync(path.join(repositoryRoot, PDP0_AUDIT_AQ_TRACEABILITY_PATH), 'utf8')); }
  catch (error) { return {errors: [`cannot load traceability artifact: ${error.message}`], stats: null}; }
  const expected = buildPdp0AuditAqTraceability(repositoryRoot);
  if (actual.schemaVersion !== expected.schemaVersion) errors.push('unsupported traceability schemaVersion');
  for (const [file, hash] of Object.entries(expected.sourceBaseline.inputs)) {
    if (actual.sourceBaseline?.inputs?.[file] !== hash) errors.push(`stale or missing source fingerprint: ${file}`);
  }
  for (const [ref, hash] of Object.entries(expected.sourceBaseline.decisionSections)) {
    if (actual.sourceBaseline?.decisionSections?.[ref] !== hash) errors.push(`stale or missing decision section fingerprint: ${ref}`);
  }
  if (JSON.stringify(actual.clusters) !== JSON.stringify(expected.clusters)) errors.push('A–Q cluster source text and accepted original-audit index classifications must match PXD-219');
  if (JSON.stringify(actual.capabilityMappings) !== JSON.stringify(expected.capabilityMappings)) errors.push('all 462 capability mappings must match source order, current-source rechecks, 456 accepted index classifications, six deferred rows, and the PXD-221 row-371 correction');
  if (JSON.stringify(actual.definitionExtensions) !== JSON.stringify(expected.definitionExtensions)) errors.push('seven proposal extensions must remain source-linked and deferred from the current version');
  if (JSON.stringify(actual.rows) !== JSON.stringify(expected.rows)) errors.push('audit row joins must exactly project the current source-bound PDP-0 evidence refs');
  if (actual.denominators?.sourceAuditRows !== 501 || actual.rows?.length !== 501
      || actual.denominators?.canonicalCapabilityLeaves !== 462
      || actual.denominators?.currentCapabilityDefinitions !== 469
      || actual.denominators?.proposalExtensionLeaves !== 7
      || actual.denominators?.capabilityLeavesWithClusterRecommendation !== 456
      || actual.denominators?.capabilityLeavesAcceptedAsIndexClassification !== 456
      || actual.denominators?.capabilityLeavesDeferredFromIndexClassification !== 6
      || actual.denominators?.rowsWithStructuralCapabilityRequirementCaseJoin !== 499
      || actual.denominators?.rowsOutsidePdp0DefinitionJoinAsImplementationOnly !== 2
      || actual.denominators?.rowsWithExplicitFamilyScopeOnlyCapability !== 1
      || actual.denominators?.rowsBlockedMissingExactJoin !== 0) {
    errors.push('traceability must preserve 501 audit rows, all 462 historical canonical leaves, 456 accepted and 6 deferred classifications, 7 deferred extension definitions, and the 499/2/1 PDP-0 join/handoff/family-scope denominator');
  }
  const dispositionResult = validatePdp0AuditDispositions({repositoryRoot});
  if (dispositionResult.errors.length) errors.push(`source disposition crosswalk invalid: ${dispositionResult.errors[0]}`);
  const blockedRows = expected.rows.filter(row => row.traceabilityStatus === 'BLOCKED_MISSING_EXACT_JOIN');
  const stats = {
    totalRows: expected.rows.length,
    rowsWithPdp0DefinitionJoin: expected.denominators.rowsWithStructuralCapabilityRequirementCaseJoin,
    unresolvedExactJoinRows: expected.denominators.rowsBlockedMissingExactJoin,
    blockedRows: blockedRows.length,
    postPdpImplementationOnlyRows: expected.denominators.rowsOutsidePdp0DefinitionJoinAsImplementationOnly,
    familyScopeOnlyRows: expected.denominators.rowsWithExplicitFamilyScopeOnlyCapability,
    clusterMappingsAcceptedIndexingOnly: expected.clusters.length,
    capabilityLeaves: expected.denominators.canonicalCapabilityLeaves,
    proposalExtensionLeaves: expected.denominators.proposalExtensionLeaves,
    capabilityLeavesWithClusterRecommendation: expected.denominators.capabilityLeavesWithClusterRecommendation,
    capabilityLeavesWithoutClusterRecommendation: expected.denominators.capabilityLeavesWithoutClusterRecommendation,
    capabilityLeavesAcceptedAsIndexClassification: expected.denominators.capabilityLeavesAcceptedAsIndexClassification,
    capabilityLeavesDeferredFromIndexClassification: expected.denominators.capabilityLeavesDeferredFromIndexClassification,
    capabilityLeavesWithExactAuditClusterTrace: expected.denominators.capabilityLeavesWithExactAuditClusterTrace,
    capabilityLeavesWithoutExactAuditClusterTrace: expected.denominators.capabilityLeavesWithoutExactAuditClusterTrace,
    profileClausesLinkedByExactCapability: expected.denominators.profileClausesLinkedByExactCapability,
    unboundAcceptanceClauses: expected.blockerSummary.unboundAcceptanceClauses.map(item => item.caseId),
    dispositionCrosswalkValid: dispositionResult.errors.length === 0,
  };
  return {errors, stats};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputPath = path.join(root, PDP0_AUDIT_AQ_TRACEABILITY_PATH);
  if (process.argv.includes('--write')) {
    fs.writeFileSync(outputPath, `${JSON.stringify(buildPdp0AuditAqTraceability(), null, 2)}\n`);
    console.log(`Wrote ${PDP0_AUDIT_AQ_TRACEABILITY_PATH}`);
  }
  const result = validatePdp0AuditAqTraceability();
  console.log(JSON.stringify(result, null, 2));
  if (result.errors.length) process.exitCode = 1;
}
