#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { pdp0PhaseScopedSourcePins } from './report-media-pdp-readiness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PDP1_MATRIX_PATH = 'docs/implementation/verification/pdp-38/pdp1-surface-phase-status-matrix.json';
export const PDP1_STATUS_PATH = 'docs/implementation/pdp-1-phase-dev-status.json';
export const PDP1_REVIEW_PATH = 'docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json';
export const PDP0_STATUS_PATH = 'docs/implementation/pdp-0-phase-dev-status.json';
export const REGISTRY_PATH = '.product-experience/surface-registry.yaml';
export const TOPOLOGY_PATH = '.product-experience/surfaces/media-physical-topology.v1.json';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const readFile = (root, relativePath) => fs.readFileSync(path.join(root, relativePath));
const parseJson = (root, relativePath) => JSON.parse(readFile(root, relativePath).toString('utf8'));
const parseYaml = (root, relativePath) => parse(readFile(root, relativePath).toString('utf8'));
const nonblank = (value) => typeof value === 'string' && value.trim().length > 0;
const unique = (values) => new Set(values).size === values.length;
const baseRef = (ref) => ref.split('#', 1)[0].replace(/\/$/u, '');

function assertSourceReference(root, ref, owner) {
  if (!nonblank(ref)) throw new Error(`${owner}: missing authority reference.`);
  const source = baseRef(ref);
  const wildcardPrefix = source.includes('*') ? source.slice(0, source.indexOf('*')).replace(/[^/]*$/u, '') : null;
  const exists = source.includes('*')
    ? Boolean(wildcardPrefix) && fs.existsSync(path.join(root, wildcardPrefix))
    : fs.existsSync(path.join(root, source));
  if (!source || !exists) throw new Error(`${owner}: source authority does not exist: ${ref}`);
}

function exactIdentityRows(topology, registry) {
  const physical = topology?.manifestCandidates;
  const compositions = topology?.compositions;
  const consumers = topology?.consumerCrosswalk;
  const registryRows = registry?.surfaces;
  if (![physical, compositions, consumers, registryRows].every(Array.isArray)) {
    throw new Error('PDP-1 matrix requires physical topology, composite topology, consumer topology, and registry rows.');
  }
  if (topology.activeManifestCandidateCount !== physical.length || registryRows.length !== consumers.length) {
    throw new Error('PDP-1 matrix topology declared counts do not match the physical and logical source populations.');
  }
  const all = [...physical, ...compositions, ...consumers];
  const ids = all.map((row) => row?.surfaceId);
  if (ids.some((id) => !nonblank(id)) || !unique(ids)) {
    throw new Error('PDP-1 matrix source topology must contain unique, stable surface IDs.');
  }
  const registryById = new Map(registryRows.map((row) => [row?.surfaceId, row]));
  if (registryById.size !== registryRows.length || consumers.some(({ surfaceId }) => !registryById.has(surfaceId))
      || [...registryById.keys()].some((id) => !consumers.some((row) => row.surfaceId === id))) {
    throw new Error('PDP-1 matrix logical topology and registry identities do not match exactly.');
  }
  return { physical, compositions, consumers, registryById, all };
}

function phaseCell(row, surfaceId) {
  const cell = row?.phaseApplicability?.['PDP-1'];
  if (!cell || !nonblank(cell.disposition) || !nonblank(cell.rationale) || !nonblank(cell.authorityRef)) {
    throw new Error(`${surfaceId}: PDP-1 applicability needs an explicit disposition, rationale, and authorityRef.`);
  }
  return cell;
}

function parentMap(physical, compositions, consumers, registryById) {
  const parents = new Map([...physical, ...compositions, ...consumers].map(({ surfaceId }) => [surfaceId, new Set()]));
  for (const composition of compositions) {
    for (const child of composition.children ?? []) {
      if (!parents.has(child)) throw new Error(`${composition.surfaceId}: unknown direct child ${child}.`);
      parents.get(child).add(composition.surfaceId);
    }
  }
  for (const consumer of consumers) {
    const registry = registryById.get(consumer.surfaceId);
    if (registry.parentSurfaceId) {
      if (!parents.has(registry.parentSurfaceId) || registry.parentSurfaceId === consumer.surfaceId) throw new Error(`${consumer.surfaceId}: unknown or self-referential parent ${registry.parentSurfaceId}.`);
      parents.get(consumer.surfaceId).add(registry.parentSurfaceId);
    }
  }
  return parents;
}

function validateNativeStatusPins(root, status, projectionPins = {}) {
  const pins = status?.sourceShaSet;
  if (!pins || typeof pins !== 'object' || Object.keys(pins).length === 0) return ['native-status-source-pins-missing'];
  const stale = [];
  for (const [sourceRef, expectedSha256] of Object.entries(pins)) {
    const currentSha256 = sourceRef.includes('#')
      ? projectionPins[sourceRef]
      : fs.existsSync(path.join(root, sourceRef)) ? sha256(readFile(root, sourceRef)) : null;
    if (!currentSha256 || currentSha256 !== expectedSha256) stale.push(sourceRef);
  }
  return stale;
}

function resolvePdp0Context(root, pdp0ProjectionPins) {
  const pdp0Status = parseJson(root, PDP0_STATUS_PATH);
  if (pdp0Status.phase !== 'PDP-0' || pdp0Status.status !== 'DEV_COMPLETE'
      || validateNativeStatusPins(root, pdp0Status, pdp0ProjectionPins).length > 0) {
    throw new Error('PDP-1 matrix requires PDP-0 native status DEV_COMPLETE with all byte and native projection pins current.');
  }
  return { pdp0Status };
}

function liveSourceCurrentness(root, status, review) {
  const statusPins = status?.sourceShaSet;
  if (!statusPins || typeof statusPins !== 'object' || Object.keys(statusPins).length === 0) {
    throw new Error('PDP-1 status sourceShaSet is required.');
  }
  const staleSourcePins = [];
  for (const [sourceRef, expectedSha256] of Object.entries(statusPins)) {
    if (sourceRef.includes('#')) throw new Error(`Unsupported PDP-1 source pin selector; native selector projection support is required: ${sourceRef}`);
    if (!fs.existsSync(path.join(root, sourceRef))) {
      staleSourcePins.push({ sourceRef, expectedSha256, currentSha256: null });
      continue;
    }
    const currentSha256 = sha256(readFile(root, sourceRef));
    if (currentSha256 !== expectedSha256) staleSourcePins.push({ sourceRef, expectedSha256, currentSha256 });
  }
  const reviewPins = review?.sourceFingerprints ?? {};
  const requiredPins = [REGISTRY_PATH, TOPOLOGY_PATH];
  const reviewPinIssues = [
    ...requiredPins.filter((sourceRef) => !statusPins[sourceRef] || !reviewPins[sourceRef]).map((sourceRef) => ({ sourceRef, statusSha256: statusPins[sourceRef] ?? null, reviewSha256: reviewPins[sourceRef] ?? null, currentSha256: fs.existsSync(path.join(root, sourceRef)) ? sha256(readFile(root, sourceRef)) : null })),
    ...Object.entries(reviewPins).flatMap(([sourceRef, expectedSha256]) => {
    if (sourceRef.includes('#')) throw new Error(`Unsupported PDP-1 semantic-review selector pin: ${sourceRef}`);
    const statusSha = statusPins[sourceRef];
    const currentSha = fs.existsSync(path.join(root, sourceRef)) ? sha256(readFile(root, sourceRef)) : null;
    return statusSha === expectedSha256 && currentSha === expectedSha256 ? [] : [{ sourceRef, statusSha256: statusSha ?? null, reviewSha256: expectedSha256, currentSha256: currentSha }];
    }),
  ];
  return {
    status: staleSourcePins.length === 0 && reviewPinIssues.length === 0 ? 'CURRENT' : 'STALE',
    sourcePinCount: Object.keys(statusPins).length,
    staleSourcePinCount: staleSourcePins.length,
    staleSourcePins,
    semanticReviewPinIssueCount: reviewPinIssues.length,
    semanticReviewPinIssues: reviewPinIssues,
    note: 'PDP-1 sourceShaSet byte pins and semantic-review source pins are checked against live files; stale inputs block DEV_COMPLETE projection.',
  };
}

function assertReviewApplicability(review, topologyRows) {
  const applicability = review?.currentCutReview?.currentSurfaceApplicability;
  const { physical, compositions, consumers, registryById } = topologyRows;
  const denominator = physical.length + compositions.length + consumers.length;
  const archived = consumers.filter(({ surfaceId }) => {
    const row = registryById.get(surfaceId);
    return row.applicabilityDisposition === 'NOT_ACTIVE_ARCHIVED' && !row.applicablePdpArtifacts?.includes('PDP-1');
  }).length;
  if (!applicability || applicability.denominator !== denominator || applicability.physical !== physical.length
      || applicability.compositions !== compositions.length || applicability.logicalConsumers !== consumers.length
      || applicability.pdp1ApplicableOrReferenceBound !== denominator - archived || applicability.explicitArchivedNotApplicable !== archived
      || !Array.isArray(applicability.sourceRefs)
      || !applicability.sourceRefs.includes(REGISTRY_PATH) || !applicability.sourceRefs.includes(TOPOLOGY_PATH)) {
    throw new Error('PDP-1 semantic review does not record the full denominator derived from current topology and registry sources.');
  }
  for (const sourceRef of [REGISTRY_PATH, TOPOLOGY_PATH]) {
    if (!review.sourceFingerprints?.[sourceRef]) throw new Error(`PDP-1 semantic review does not source-pin applicability authority ${sourceRef}.`);
  }
}

function assertCurrentFullDenominatorReview(root, status, review) {
  if (review?.status !== 'APPROVED_PDP1_DEVELOPMENT_SEMANTIC_REVIEW' || review.phase !== 'PDP-1'
      || review.sourceCutStable !== true || !Array.isArray(review.outstandingMeaningIds) || review.outstandingMeaningIds.length !== 0
      || !Array.isArray(review.reviewedIdentityIds) || !Array.isArray(status.sourceIdentityIds)
      || review.reviewedIdentityIds.length !== status.sourceIdentityIds.length || !unique(review.reviewedIdentityIds)
      || status.sourceIdentityIds.some((id) => !review.reviewedIdentityIds.includes(id))) {
    throw new Error('PDP-1 full-denominator semantic review is missing, incomplete, or not source-cut stable.');
  }
  const reviewPins = review.sourceFingerprints ?? {};
  if (!Object.keys(reviewPins).length) throw new Error('PDP-1 semantic review has no source fingerprints.');
  for (const [sourceRef, expectedSha256] of Object.entries(reviewPins)) {
    if (sourceRef.includes('#')) throw new Error(`Unsupported PDP-1 semantic-review selector pin: ${sourceRef}`);
    const currentSha256 = fs.existsSync(path.join(root, sourceRef)) ? sha256(readFile(root, sourceRef)) : null;
    if (!currentSha256 || currentSha256 !== expectedSha256 || status.sourceShaSet?.[sourceRef] !== expectedSha256) {
      throw new Error(`PDP-1 semantic-review source pin is stale or absent from native phase status: ${sourceRef}`);
    }
  }
}

function resolveTaskOwnership(status, surfaceIds, knownComplete) {
  const taskIds = [...new Set(status.outstandingMeaningIds ?? [])];
  const assignments = status.surfaceTaskAssignments;
  if (!taskIds.length && knownComplete) return { taskIds, bySurface: new Map(surfaceIds.map((id) => [id, []])), ownerBySurface: new Map(), mappingState: 'KNOWN_COMPLETE' };
  if (!taskIds.length && !knownComplete) return { taskIds, bySurface: null, ownerBySurface: null, mappingState: 'UNKNOWN_PHASE_LOCAL_OWNERSHIP' };
  if (!Array.isArray(assignments)) return { taskIds, bySurface: null, ownerBySurface: null, mappingState: 'UNKNOWN_PHASE_LOCAL_OWNERSHIP' };
  const bySurface = new Map(surfaceIds.map((id) => [id, []]));
  const ownerBySurface = new Map();
  const mapped = new Set();
  for (const assignment of assignments) {
    if (!taskIds.includes(assignment.taskId) || !bySurface.has(assignment.surfaceId) || !nonblank(assignment.owner)) {
      return { taskIds, bySurface: null, ownerBySurface: null, mappingState: 'UNKNOWN_PHASE_LOCAL_OWNERSHIP' };
    }
    bySurface.get(assignment.surfaceId).push(assignment.taskId);
    ownerBySurface.set(assignment.surfaceId, assignment.owner);
    mapped.add(assignment.taskId);
  }
  if (mapped.size !== taskIds.length || assignments.length !== taskIds.length) return { taskIds, bySurface: null, ownerBySurface: null, mappingState: 'UNKNOWN_PHASE_LOCAL_OWNERSHIP' };
  return { taskIds, bySurface, ownerBySurface, mappingState: 'SOURCE_MAPPED' };
}

function makeRows(root, topologyRows, sourceFingerprints, phaseReady, phaseSourceCurrentness, taskOwnership) {
  const { physical, compositions, consumers, registryById } = topologyRows;
  const parents = parentMap(physical, compositions, consumers, registryById);
  const logicalRows = consumers.map((consumer) => {
    const registry = registryById.get(consumer.surfaceId);
    const applicable = registry.applicablePdpArtifacts?.includes('PDP-1') === true;
    const archived = registry.applicabilityDisposition === 'NOT_ACTIVE_ARCHIVED';
    const notApplicable = !applicable && !archived;
    if (!Array.isArray(registry.applicablePdpArtifacts) || !nonblank(registry.applicabilityDisposition)
        || !nonblank(registry.applicabilityRationale) || notApplicable
        || (archived && applicable)) {
      throw new Error(`${consumer.surfaceId}: registry must explicitly establish PDP-1 applicability or archived N/A with rationale.`);
    }
    const refs = [registry.interactionModel, registry.contractAuthority, ...(registry.upstreamProductTruth ?? []), registry.securityAuthorityModel].filter(Boolean);
    if (applicable && refs.length === 0) throw new Error(`${consumer.surfaceId}: applicable logical consumer has no PDP authority reference.`);
    for (const ref of refs) assertSourceReference(root, ref, consumer.surfaceId);
    const authority = refs[0] ?? REGISTRY_PATH;
    return {
      surfaceId: consumer.surfaceId,
      surfaceType: consumer.consumerType,
      owner: (registry.owners ?? []).join(', '),
      repositoryPath: consumer.physicalRefs?.[0] ?? null,
      manifestPath: null,
      pathRefs: [...(consumer.physicalRefs ?? [])],
      parentSurfaceIds: [...parents.get(consumer.surfaceId)].sort(),
      phase: 'PDP-1',
      applicability: { disposition: archived ? 'NOT_ACTIVE_ARCHIVED' : 'APPLICABLE', rationale: registry.applicabilityRationale, authorityRef: REGISTRY_PATH },
      sourceRefs: [...new Set([REGISTRY_PATH, TOPOLOGY_PATH, ...refs])].sort(),
      sourceFingerprints: Object.fromEntries([...new Set([REGISTRY_PATH, TOPOLOGY_PATH, ...refs])].filter((ref) => sourceFingerprints[baseRef(ref)]).map((ref) => [baseRef(ref), sourceFingerprints[baseRef(ref)]])),
      sourceCurrent: phaseSourceCurrentness.status === 'CURRENT',
      sourceCurrentBasis: phaseSourceCurrentness.status === 'CURRENT' ? 'PDP-1 status and semantic-review source pins match live source bytes.' : `PDP-1 source pins are stale (${phaseSourceCurrentness.staleSourcePinCount} status pins; ${phaseSourceCurrentness.semanticReviewPinIssueCount} review pins).`,
      developmentStatus: archived ? 'NOT_ACTIVE_ARCHIVED' : phaseReady ? 'DEV_COMPLETE' : 'IN_PROGRESS',
      remainingPhaseLocalTaskIds: archived ? [] : taskOwnership.bySurface ? [...taskOwnership.bySurface.get(consumer.surfaceId)] : null,
      remainingPhaseLocalTaskMapping: archived ? 'NOT_APPLICABLE_ARCHIVED' : taskOwnership.mappingState,
      blockerOwner: archived ? null : taskOwnership.mappingState === 'UNKNOWN_PHASE_LOCAL_OWNERSHIP' ? 'UNKNOWN_PHASE_LOCAL_OWNER' : taskOwnership.ownerBySurface?.get(consumer.surfaceId) ?? null,
      acceptanceCriterion: archived ? 'Registry explicitly excludes this archived consumer from PDP-1.' : 'PDP-1 definition status, current full-denominator review, and all source pins are current; no phase-local task remains.',
      nextLegalAction: phaseReady ? 'PDP-2 may proceed after the PDP-1 source-current barrier is retained; no closure, acceptance, implementation, or Delivery is implied.' : 'Resolve PDP-1 status and current-source blockers before advancing to PDP-2.',
      consumers: registry.consumers ?? [],
      canonicalDomainConcepts: registry.canonicalDomainConcepts ?? [],
      interactionModel: registry.interactionModel ?? null,
      contractAuthority: registry.contractAuthority ?? null,
      physicalOwnerSurfaceRefs: [...(consumer.physicalRefs ?? [])],
      bindingState: consumer.bindingState,
    };
  });

  const makeNode = (node, kind) => {
    const cell = phaseCell(node, node.surfaceId);
    assertSourceReference(root, cell.authorityRef, node.surfaceId);
    if (cell.operationAuthorityRef) assertSourceReference(root, cell.operationAuthorityRef, node.surfaceId);
    const applicability = {
      disposition: cell.disposition,
      rationale: cell.rationale,
      authorityRef: cell.authorityRef,
      ...(cell.operationAuthorityRef ? { operationAuthorityRef: cell.operationAuthorityRef } : {}),
    };
    const nodeRefs = [TOPOLOGY_PATH, cell.authorityRef, cell.operationAuthorityRef].filter(Boolean);
    const isNotApplicable = cell.disposition === 'NOT_APPLICABLE';
    const row = {
      surfaceId: node.surfaceId,
      surfaceType: kind === 'physical' ? 'PHYSICAL' : node.kind,
      owner: node.owner ?? node.canonicalOwner ?? 'media',
      repositoryPath: node.sourcePath ?? null,
      manifestPath: node.manifestPath ?? null,
      parentSurfaceIds: [...parents.get(node.surfaceId)].sort(),
      phase: 'PDP-1',
      applicability,
      sourceRefs: [...new Set(nodeRefs)].sort(),
      sourceFingerprints: Object.fromEntries([...new Set(nodeRefs.map(baseRef))].filter((ref) => sourceFingerprints[ref]).map((ref) => [ref, sourceFingerprints[ref]])),
      sourceCurrent: phaseSourceCurrentness.status === 'CURRENT',
      sourceCurrentBasis: phaseSourceCurrentness.status === 'CURRENT' ? 'PDP-1 status and semantic-review source pins match live source bytes.' : `PDP-1 source pins are stale (${phaseSourceCurrentness.staleSourcePinCount} status pins; ${phaseSourceCurrentness.semanticReviewPinIssueCount} review pins).`,
      developmentStatus: isNotApplicable ? 'NOT_APPLICABLE' : phaseReady ? 'DEV_COMPLETE' : 'IN_PROGRESS',
      remainingPhaseLocalTaskIds: cell.disposition === 'NOT_APPLICABLE' ? [] : taskOwnership.bySurface ? [...taskOwnership.bySurface.get(node.surfaceId)] : null,
      remainingPhaseLocalTaskMapping: cell.disposition === 'NOT_APPLICABLE' ? 'NOT_APPLICABLE_SOURCE_DECISION' : taskOwnership.mappingState,
      blockerOwner: cell.disposition === 'NOT_APPLICABLE' ? null : taskOwnership.mappingState === 'UNKNOWN_PHASE_LOCAL_OWNERSHIP' ? 'UNKNOWN_PHASE_LOCAL_OWNER' : taskOwnership.ownerBySurface?.get(node.surfaceId) ?? null,
      acceptanceCriterion: `Explicit PDP-1 ${cell.disposition} applicability and authority are source-bound; current phase status has zero outstanding tasks and all required source pins are current.`,
      nextLegalAction: phaseReady ? 'PDP-2 may proceed after the PDP-1 source-current barrier is retained; no closure, acceptance, implementation, or Delivery is implied.' : 'Resolve PDP-1 status and current-source blockers before advancing to PDP-2.',
    };
    if (kind === 'physical') {
      row.topologyDisposition = node.disposition;
      row.topologyDispositionRationale = node.dispositionRationale;
      row.consumerSurfaceRefs = node.consumerSurfaceRefs ?? [];
      row.consumerMappingState = node.consumerMappingState ?? null;
    } else {
      row.directMeaning = node.directMeaning;
      row.children = node.children ?? [];
      row.membershipSemantics = node.membershipSemantics ?? null;
    }
    return row;
  };
  return [
    ...physical.map((node) => makeNode(node, 'physical')),
    ...compositions.map((node) => makeNode(node, 'composition')),
    ...logicalRows,
  ];
}

export function buildPdp1SurfaceMatrix({ root = ROOT, status, semanticReview, previousMatrix, pdp0ProjectionPins = pdp0PhaseScopedSourcePins(), generatedAt = previousMatrix?.generatedAt ?? '1970-01-01T00:00:00.000Z' }) {
  if (status?.phase !== 'PDP-1' || !['DEV_COMPLETE', 'IN_PROGRESS'].includes(status.status)) throw new Error('PDP-1 phase-dev status is missing or has an invalid phase/status.');
  if (semanticReview?.phase !== 'PDP-1') throw new Error('PDP-1 semantic-review record is missing or has the wrong phase.');
  const registry = parseYaml(root, REGISTRY_PATH);
  const topology = parseJson(root, TOPOLOGY_PATH);
  const topologyRows = exactIdentityRows(topology, registry);
  const surfaceIds = topologyRows.all.map(({ surfaceId }) => surfaceId);
  const { pdp0Status } = resolvePdp0Context(root, pdp0ProjectionPins);
  assertReviewApplicability(semanticReview, topologyRows);
  assertCurrentFullDenominatorReview(root, status, semanticReview);
  const phaseSourceCurrentness = liveSourceCurrentness(root, status, semanticReview);
  const directCriteriaPass = Object.keys(status.directDevelopmentCriteria ?? {}).length > 0
    && Object.values(status.directDevelopmentCriteria).every((criterion) => criterion.testStatus === 'PASS');
  const nativeStatusPins = validateNativeStatusPins(root, status);
  const currentnessWithoutTaskMapping = liveSourceCurrentness(root, status, semanticReview);
  const statusBaselineComplete = status.status === 'DEV_COMPLETE'
    && (status.outstandingMeaningIds ?? []).length === 0
    && directCriteriaPass
    && nativeStatusPins.length === 0
    && currentnessWithoutTaskMapping.status === 'CURRENT';
  const taskOwnership = resolveTaskOwnership(status, surfaceIds, statusBaselineComplete);
  const phaseReady = status.status === 'DEV_COMPLETE'
    && (status.outstandingMeaningIds ?? []).length === 0
    && directCriteriaPass
    && phaseSourceCurrentness.status === 'CURRENT'
    && taskOwnership.mappingState !== 'UNKNOWN_PHASE_LOCAL_OWNERSHIP'
    && semanticReview.status === 'APPROVED_PDP1_DEVELOPMENT_SEMANTIC_REVIEW'
    && semanticReview.sourceCutStable === true
    && (semanticReview.outstandingMeaningIds ?? []).length === 0
    && Array.isArray(semanticReview.reviewedIdentityIds)
    && semanticReview.reviewedIdentityIds.length === (status.sourceIdentityIds ?? []).length
    && unique(semanticReview.reviewedIdentityIds)
    && (status.sourceIdentityIds ?? []).every((id) => semanticReview.reviewedIdentityIds.includes(id));
  const inputPaths = [...new Set([
    ...Object.keys(status.sourceShaSet ?? {}), REGISTRY_PATH, TOPOLOGY_PATH, PDP1_STATUS_PATH, PDP1_REVIEW_PATH,
    PDP0_STATUS_PATH,
  ])].sort();
  const sourceFingerprints = Object.fromEntries(inputPaths.map((sourcePath) => {
    const filePath = baseRef(sourcePath);
    if (!fs.existsSync(path.join(root, filePath))) return [sourcePath, null];
    return [sourcePath, sha256(readFile(root, filePath))];
  }));
  const sourceFingerprintSetSha256 = sha256(JSON.stringify(Object.entries(sourceFingerprints).sort(([a], [b]) => a.localeCompare(b))));
  const surfaces = makeRows(root, topologyRows, sourceFingerprints, phaseReady, phaseSourceCurrentness, taskOwnership);
  const statusCounts = surfaces.reduce((result, row) => {
    result[row.developmentStatus] = (result[row.developmentStatus] ?? 0) + 1;
    return result;
  }, {});
  const applicabilityCounts = surfaces.reduce((result, row) => {
    result[row.applicability.disposition] = (result[row.applicability.disposition] ?? 0) + 1;
    return result;
  }, {});
  const applicableCount = surfaces.filter((row) => !['NOT_ACTIVE_ARCHIVED', 'NOT_APPLICABLE'].includes(row.developmentStatus)).length;
  const completeCount = statusCounts.DEV_COMPLETE ?? 0;
  const matrix = {
    schemaVersion: 'media.pdp1-surface-phase-status-matrix.v1',
    recordKind: 'SOURCE_BOUND_PDP1_DEVELOPMENT_STATUS_PROJECTION_NOT_CLOSURE_OR_ACCEPTANCE',
    campaign: { macroStage: 'DISCOVERY', phase: 'PDP-1', sourceBaselineCommit: status.mainSha, status: phaseReady && completeCount === applicableCount ? 'DEV_COMPLETE' : 'IN_PROGRESS' },
    generatedAt,
    statusRecordRef: PDP1_STATUS_PATH,
    statusRecordSha256: sourceFingerprints[PDP1_STATUS_PATH],
    semanticReviewRef: PDP1_REVIEW_PATH,
    semanticReviewSha256: sourceFingerprints[PDP1_REVIEW_PATH],
    pdp0PredecessorStatusRef: PDP0_STATUS_PATH,
    pdp0PredecessorStatusSha256: sourceFingerprints[PDP0_STATUS_PATH],
    sourceFingerprintSetSha256,
    sourceFingerprints,
    sourceFingerprintSetAlgorithm: 'SHA-256 of compact JSON.stringify over sorted [repository-relative path, file SHA-256] tuples',
    phaseSourceCurrentness,
    denominatorValidation: {
      status: surfaces.length === surfaceIds.length && unique(surfaces.map(({ surfaceId }) => surfaceId))
        && surfaces.every((row) => row.applicability?.disposition && row.applicability?.rationale) ? 'PASS' : 'FAIL',
      stats: { physical: topologyRows.physical.length, compositions: topologyRows.compositions.length, logicalConsumers: topologyRows.consumers.length, denominator: surfaces.length, pdp1DevComplete: completeCount, explicitArchivedNotApplicable: applicabilityCounts.NOT_ACTIVE_ARCHIVED ?? 0, physicalReferencedOnly: surfaces.filter((row) => row.surfaceType === 'PHYSICAL' && row.applicability.disposition === 'REFERENCED_ONLY').length, physicalApplicable: surfaces.filter((row) => row.surfaceType === 'PHYSICAL' && row.applicability.disposition !== 'REFERENCED_ONLY').length },
    },
    summary: {
      totalSurfaceIdentities: surfaces.length,
      physical: topologyRows.physical.length,
      compositions: topologyRows.compositions.length,
      logicalConsumers: topologyRows.consumers.length,
      sourceCurrentDevCompleteCells: completeCount,
      explicitNotApplicableCells: (statusCounts.NOT_APPLICABLE ?? 0) + (statusCounts.NOT_ACTIVE_ARCHIVED ?? 0),
      remainingPhaseLocalTaskCount: taskOwnership.mappingState === 'UNKNOWN_PHASE_LOCAL_OWNERSHIP' ? null : taskOwnership.taskIds.length,
      remainingPhaseLocalTaskCountKnown: taskOwnership.mappingState !== 'UNKNOWN_PHASE_LOCAL_OWNERSHIP',
      pdp1ReferencedOnlyPhysicalRows: surfaces.filter((row) => row.surfaceType === 'PHYSICAL' && row.applicability.disposition === 'REFERENCED_ONLY').length,
      archivedLogicalConsumers: applicabilityCounts.NOT_ACTIVE_ARCHIVED ?? 0,
    },
    unassignedPhaseLevelWork: {
      sourceRecordRef: PDP1_STATUS_PATH,
      outstandingMeaningIds: [...(status.outstandingMeaningIds ?? [])],
      surfaceAssignmentState: taskOwnership.mappingState,
      failedCriteria: Object.entries(status.directDevelopmentCriteria ?? {})
        .filter(([, criterion]) => criterion.testStatus !== 'PASS')
        .map(([criterionId, criterion]) => ({ criterionId, testStatus: criterion.testStatus, testCount: criterion.testCount, passedTestCount: criterion.passedTestCount, surfaceIds: [], owner: null, assignment: 'UNASSIGNED_PHASE_LEVEL' })),
      note: 'Phase-level failures without exact source assignment remain unassigned and are not copied into surface rows.',
    },
    claimsBoundary: {
      ownerApproval: 'NOT_CLAIMED', independentAcceptance: 'NOT_CLAIMED', nativeClosure: 'NOT_PERFORMED',
      implementationQualification: 'NOT_PERFORMED', delivery: 'NOT_PERFORMED', runtimeAdmission: 'NOT_ADMITTED', transportAdmission: 'NOT_ADMITTED',
    },
    surfaceAuthority: 'PDP-1 source applicability: topology.phaseApplicability.PDP-1 for physical/composite surfaces; surface-registry.yaml applicablePdpArtifacts and explicit archived disposition for logical consumers. Identity denominator: physical topology + compositions + consumer crosswalk joined exactly to surface-registry.yaml.',
    surfaces,
  };
  if (matrix.denominatorValidation.status !== 'PASS') throw new Error('PDP-1 matrix denominator validation failed.');
  return matrix;
}

export function generatePdp1SurfaceMatrix({ root = ROOT, mode = 'check' } = {}) {
  const previousMatrix = parseJson(root, PDP1_MATRIX_PATH);
  const status = parseJson(root, PDP1_STATUS_PATH);
  const semanticReview = parseJson(root, PDP1_REVIEW_PATH);
  const matrix = buildPdp1SurfaceMatrix({ root, status, semanticReview, previousMatrix, generatedAt: previousMatrix.generatedAt });
  const output = `${JSON.stringify(matrix, null, 2)}\n`;
  const target = path.join(root, PDP1_MATRIX_PATH);
  if (mode === 'write') fs.writeFileSync(target, output);
  else if (mode === 'check' && readFile(root, PDP1_MATRIX_PATH).toString('utf8') !== output) throw new Error(`${PDP1_MATRIX_PATH} is stale; regenerate after the PDP-1 status and semantic review settle.`);
  return { matrix, output };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv.includes('--write') ? 'write' : 'check';
  const { matrix } = generatePdp1SurfaceMatrix({ mode });
  console.log(JSON.stringify({ matrixPath: PDP1_MATRIX_PATH, phaseStatus: matrix.campaign.status, rows: matrix.surfaces.length, sourceCurrentness: matrix.phaseSourceCurrentness.status }, null, 2));
}
