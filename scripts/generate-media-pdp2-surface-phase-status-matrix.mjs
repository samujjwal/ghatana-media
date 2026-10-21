#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PDP2_MATRIX_PATH = 'docs/implementation/verification/pdp-38/pdp2-surface-phase-status-matrix.json';
export const PDP0_STATUS_PATH = 'docs/implementation/pdp-0-phase-dev-status.json';
export const PDP1_STATUS_PATH = 'docs/implementation/pdp-1-phase-dev-status.json';
export const PDP2_STATUS_PATH = 'docs/implementation/pdp-2-phase-dev-status.json';
export const PDP0_MATRIX_PATH = 'docs/implementation/verification/pdp-38/pdp0-surface-phase-status-matrix.json';
export const PDP1_MATRIX_PATH = 'docs/implementation/verification/pdp-38/pdp1-surface-phase-status-matrix.json';
export const REGISTRY_PATH = '.product-experience/surface-registry.yaml';
export const TOPOLOGY_PATH = '.product-experience/surfaces/media-physical-topology.v1.json';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const readBytes = (root, relativePath) => fs.readFileSync(path.join(root, relativePath));
const readJson = (root, relativePath) => JSON.parse(readBytes(root, relativePath).toString('utf8'));
const readYaml = (root, relativePath) => parse(readBytes(root, relativePath).toString('utf8'));
const nonblank = (value) => typeof value === 'string' && value.trim().length > 0;
const unique = (values) => new Set(values).size === values.length;
const baseRef = (ref) => ref.split('#', 1)[0].replace(/\/$/u, '');
const isEphemeralCachePath = (ref) => /(?:^|\/)node_modules\/\.vite(?:\/|$)/u.test(baseRef(ref));

function exactTopology(topology, registry) {
  const physical = topology?.manifestCandidates;
  const compositions = topology?.compositions;
  const consumers = topology?.consumerCrosswalk;
  const registryRows = registry?.surfaces;
  if (![physical, compositions, consumers, registryRows].every(Array.isArray)) {
    throw new Error('PDP-2 matrix requires physical, composite, and logical topology plus surface registry rows.');
  }
  if (topology.activeManifestCandidateCount !== physical.length || registryRows.length !== consumers.length) {
    throw new Error('PDP-2 topology counts do not match the physical and logical source populations.');
  }
  const rows = [...physical, ...compositions, ...consumers];
  const ids = rows.map(({ surfaceId }) => surfaceId);
  if (ids.some((id) => !nonblank(id)) || !unique(ids)) throw new Error('PDP-2 topology must contain unique, stable surface identities.');
  const registryById = new Map(registryRows.map((row) => [row.surfaceId, row]));
  if (registryById.size !== registryRows.length || consumers.some(({ surfaceId }) => !registryById.has(surfaceId))
      || [...registryById.keys()].some((id) => !consumers.some((row) => row.surfaceId === id))) {
    throw new Error('PDP-2 logical topology and registry identities do not match exactly.');
  }
  return { physical, compositions, consumers, registryById, all: rows };
}

function currentFingerprints(root, refs) {
  const entries = [...new Set(refs.map(baseRef).filter(Boolean))].sort();
  const fingerprints = {};
  for (const ref of entries) {
    const fullPath = path.join(root, ref);
    fingerprints[ref] = fs.existsSync(fullPath) && fs.statSync(fullPath).isFile() ? sha256(readBytes(root, ref)) : null;
  }
  return fingerprints;
}

function filesUnder(root, directory) {
  const result = [];
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = path.posix.join(directory, entry.name);
    if (isEphemeralCachePath(relative)) continue;
    if (entry.isDirectory()) result.push(...filesUnder(root, relative));
    else if (entry.isFile()) result.push(relative);
  }
  return result;
}

function authorityFiles(root, authorityRefs, knownFiles) {
  const result = new Set();
  for (const originalRef of authorityRefs) {
    const ref = baseRef(originalRef);
    if (isEphemeralCachePath(ref)) continue;
    const fullPath = path.join(root, ref);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      result.add(ref);
    } else if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
      for (const file of filesUnder(root, ref)) result.add(file);
    } else if (ref.includes('*')) {
      const pattern = new RegExp(`^${ref.split('*').map((part) => part.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&')).join('.*')}$`, 'u');
      for (const file of knownFiles) if (pattern.test(file) && !isEphemeralCachePath(file)) result.add(file);
    }
    if (![...result].some((file) => file === ref || file.startsWith(`${ref.replace(/\/$/u, '')}/`)) && !ref.includes('*')) {
      throw new Error(`PDP-2 applicability authority does not resolve to a source file: ${originalRef}`);
    }
  }
  return [...result].sort();
}

function nativeCurrentness(root, status) {
  const pins = status?.sourceShaSet;
  if (!pins || typeof pins !== 'object' || Object.keys(pins).length === 0) {
    return { status: 'UNKNOWN', sourcePinCount: 0, staleSourcePinCount: 0, staleSourcePins: [], note: 'Native PDP-2 sourceShaSet is absent.' };
  }
  const staleSourcePins = [];
  for (const [sourceRef, expectedSha256] of Object.entries(pins)) {
    if (sourceRef.includes('#')) {
      staleSourcePins.push({ sourceRef, expectedSha256, currentSha256: null, reason: 'unsupported-selector-without-native-projection' });
      continue;
    }
    const fullPath = path.join(root, sourceRef);
    const currentSha256 = fs.existsSync(fullPath) && fs.statSync(fullPath).isFile() ? sha256(readBytes(root, sourceRef)) : null;
    if (!currentSha256 || currentSha256 !== expectedSha256) staleSourcePins.push({ sourceRef, expectedSha256, currentSha256 });
  }
  return {
    status: staleSourcePins.length === 0 ? 'CURRENT' : 'STALE',
    sourcePinCount: Object.keys(pins).length,
    staleSourcePinCount: staleSourcePins.length,
    staleSourcePins,
    note: 'PDP-2 sourceShaSet raw file pins are compared with current repository bytes; no selector pins are accepted without native projection support.',
  };
}

function predecessorState(pdp0Status, pdp1Status, pdp0Matrix, pdp1Matrix) {
  const p0Ready = pdp0Status?.phase === 'PDP-0' && pdp0Status.status === 'DEV_COMPLETE'
    && pdp0Matrix?.campaign?.phase === 'PDP-0' && pdp0Matrix.campaign.status === 'DEV_COMPLETE'
    && pdp0Matrix.phaseSourceCurrentness?.status === 'CURRENT';
  const p1Ready = pdp1Status?.phase === 'PDP-1' && pdp1Status.status === 'DEV_COMPLETE'
    && pdp1Matrix?.campaign?.phase === 'PDP-1' && pdp1Matrix.campaign.status === 'DEV_COMPLETE'
    && pdp1Matrix.phaseSourceCurrentness?.status === 'CURRENT';
  return {
    status: p0Ready && p1Ready ? 'READY' : 'BLOCKED_OR_UNKNOWN',
    pdp0: { status: pdp0Status?.status ?? 'UNKNOWN', matrixStatus: pdp0Matrix?.campaign?.status ?? 'UNKNOWN', sourceCurrentness: pdp0Matrix?.phaseSourceCurrentness?.status ?? 'UNKNOWN' },
    pdp1: { status: pdp1Status?.status ?? 'UNKNOWN', matrixStatus: pdp1Matrix?.campaign?.status ?? 'UNKNOWN', sourceCurrentness: pdp1Matrix?.phaseSourceCurrentness?.status ?? 'UNKNOWN' },
  };
}

function allCriteria(status) {
  const criteria = status?.directDevelopmentCriteria;
  if (!criteria || typeof criteria !== 'object' || Object.keys(criteria).length === 0) return { pass: false, failed: [], rows: [] };
  const rows = Object.entries(criteria).sort(([a], [b]) => a.localeCompare(b)).map(([criterionId, criterion]) => ({
    criterionId,
    testStatus: criterion?.testStatus ?? 'UNKNOWN',
    testCount: Number.isFinite(criterion?.testCount) ? criterion.testCount : null,
    passedTestCount: Number.isFinite(criterion?.passedTestCount) ? criterion.passedTestCount : null,
    skippedTestCount: Number.isFinite(criterion?.skippedTestCount) ? criterion.skippedTestCount : 0,
  }));
  return { pass: rows.every(({ testStatus, testCount, passedTestCount }) => testStatus === 'PASS' && testCount !== null && passedTestCount === testCount), failed: rows.filter((row) => row.testStatus !== 'PASS' || row.testCount === null || row.passedTestCount !== row.testCount), rows };
}

function authorityCell(node, surfaceId) {
  const cell = node?.phaseApplicability?.['PDP-2'];
  if (!cell || !nonblank(cell.disposition) || !nonblank(cell.rationale)) {
    throw new Error(`${surfaceId}: PDP-2 topology applicability requires explicit disposition and rationale.`);
  }
  const refs = [...new Set([...(cell.authorityRefs ?? []), cell.authorityRef].filter(nonblank))];
  if (refs.length === 0) throw new Error(`${surfaceId}: PDP-2 topology applicability has no authority reference.`);
  return { cell, refs };
}

function makeSurfaceRows({ root, sourceFingerprints, topologyRows, nativeStatus, nativePdp2Ready, predecessorReady, phaseSourceCurrentness, failedCriteria, outstandingMeaningIds }) {
  const { physical, compositions, consumers, registryById } = topologyRows;
  const parents = new Map(topologyRows.all.map(({ surfaceId }) => [surfaceId, new Set()]));
  for (const composition of compositions) {
    for (const child of composition.children ?? []) {
      if (!parents.has(child)) throw new Error(`${composition.surfaceId}: unknown direct child ${child}.`);
      parents.get(child).add(composition.surfaceId);
    }
  }
  for (const consumer of consumers) {
    const parentSurfaceId = registryById.get(consumer.surfaceId)?.parentSurfaceId;
    if (parentSurfaceId) {
      if (!parents.has(parentSurfaceId) || parentSurfaceId === consumer.surfaceId) throw new Error(`${consumer.surfaceId}: unknown or self-referential parent ${parentSurfaceId}.`);
      parents.get(consumer.surfaceId).add(parentSurfaceId);
    }
  }
  const taskIds = [...new Set([...failedCriteria.map(({ taskId }) => taskId), ...outstandingMeaningIds])].sort();
  const sourceRefsFor = (refs) => [...new Set([
    REGISTRY_PATH, TOPOLOGY_PATH, PDP0_STATUS_PATH, PDP1_STATUS_PATH, PDP2_STATUS_PATH, PDP0_MATRIX_PATH, PDP1_MATRIX_PATH,
    ...authorityFiles(root, refs, Object.keys(sourceFingerprints)),
  ])].sort();
  const makeRow = ({ node, surfaceType, disposition, rationale, authorityRefs, owner, repositoryPath, manifestPath, topologyFields = {}, logicalRegistry }) => {
    const notActiveArchived = logicalRegistry?.applicabilityDisposition === 'NOT_ACTIVE_ARCHIVED';
    const notApplicable = disposition === 'NOT_APPLICABLE' || disposition === 'NOT_APPLICABLE_SUPPORT' || notActiveArchived;
    const rowRefs = sourceRefsFor(authorityRefs);
    const rowFingerprints = Object.fromEntries(rowRefs.map((ref) => [ref, sourceFingerprints[ref] ?? null]));
    const isCurrent = phaseSourceCurrentness.status === 'CURRENT';
    const nextStatus = notActiveArchived ? 'NOT_ACTIVE_ARCHIVED' : notApplicable ? 'NOT_APPLICABLE' : nativePdp2Ready && predecessorReady && isCurrent ? 'DEV_COMPLETE' : 'PENDING';
    const blockers = notApplicable ? [] : [
      ...(phaseSourceCurrentness.status !== 'CURRENT' ? ['PDP2_SOURCE_PINS_STALE_OR_UNKNOWN'] : []),
      ...(failedCriteria.length ? ['PDP2_DIRECT_CRITERIA_FAIL'] : []),
      ...failedCriteria.map(({ taskId }) => taskId),
      ...outstandingMeaningIds,
      ...(nativeStatus === 'DEV_COMPLETE' ? [] : ['PDP2_NATIVE_STATUS_NOT_DEV_COMPLETE']),
      ...(predecessorReady ? [] : ['PDP0_PDP1_PREDECESSOR_BARRIER_NOT_READY']),
    ];
    const taskMapping = notApplicable ? 'NOT_APPLICABLE_SOURCE_DECISION' : taskIds.length ? 'UNKNOWN_PHASE_LOCAL_OWNERSHIP' : 'KNOWN_ZERO_PHASE_LOCAL_TASKS';
    return {
      surfaceId: node.surfaceId,
      surfaceType,
      owner: owner ?? 'media',
      repositoryPath: repositoryPath ?? null,
      manifestPath: manifestPath ?? null,
      pathRefs: surfaceType === 'LOGICAL_CONSUMER' ? [...(node.physicalRefs ?? [])] : [],
      parentSurfaceIds: [...parents.get(node.surfaceId)].sort(),
      phase: 'PDP-2',
      applicability: { disposition: notActiveArchived ? 'NOT_ACTIVE_ARCHIVED' : disposition, rationale, authorityRef: authorityRefs[0] ?? REGISTRY_PATH, authorityRefs },
      sourceRefs: rowRefs,
      sourceFingerprints: rowFingerprints,
      sourceCurrent: isCurrent,
      sourceCurrentBasis: isCurrent ? 'Every native PDP-2 sourceShaSet byte pin matches the current repository; predecessor records and matrices are included as explicit matrix inputs.' : `PDP-2 source currentness is ${phaseSourceCurrentness.status}; ${phaseSourceCurrentness.staleSourcePinCount} of ${phaseSourceCurrentness.sourcePinCount} native source pins are stale or unsupported.`,
      developmentStatus: nextStatus,
      remainingPhaseLocalTaskIds: notApplicable ? [] : taskIds.length ? null : [],
      remainingPhaseLocalTaskMapping: taskMapping,
      blockerIds: blockers,
      blockerOwner: notApplicable || blockers.length === 0 ? null : taskIds.length ? 'UNKNOWN_PHASE_LOCAL_OWNER' : !predecessorReady && nativePdp2Ready ? 'PDP0_PDP1_PREDECESSOR_BARRIER' : 'PDP-2_STATUS_AUTHORITY',
      acceptanceCriterion: notApplicable
        ? 'Current topology or registry authority explicitly excludes this identity from PDP-2 with a source-bound rationale.'
        : 'Native PDP-2 status is DEV_COMPLETE, every direct development criterion passes, all PDP-2 source pins are current, and this surface has an explicit PDP-2 applicability decision; no owner acceptance or phase closure is implied.',
      nextLegalAction: !predecessorReady && nativePdp2Ready
        ? 'PDP-2 native development status is source-current and complete; retain it while the PDP-0/PDP-1 predecessor barrier is resolved. PDP-3 may proceed only after the full predecessor and PDP-2 barriers are current.'
        : nextStatus === 'DEV_COMPLETE' || nextStatus === 'NOT_APPLICABLE' || nextStatus === 'NOT_ACTIVE_ARCHIVED'
        ? 'PDP-3 may proceed only after the source-current PDP-2 barrier is retained across the full 54-identity denominator; this row makes no acceptance, closure, implementation, qualification, or Delivery claim.'
        : 'Resolve the source-current PDP-2 status and any unassigned direct-development blockers before advancing to PDP-3.',
      ...topologyFields,
    };
  };

  const physicalRows = physical.map((node) => {
    const { cell, refs } = authorityCell(node, node.surfaceId);
    return makeRow({ node, surfaceType: 'PHYSICAL', disposition: cell.disposition, rationale: cell.rationale, authorityRefs: refs, owner: node.owner, repositoryPath: node.sourcePath, manifestPath: node.manifestPath, topologyFields: { topologyDisposition: node.disposition, topologyDispositionRationale: node.dispositionRationale, consumerSurfaceRefs: node.consumerSurfaceRefs ?? [], consumerMappingState: node.consumerMappingState ?? null, pdp0ApplicabilityDisposition: node.phaseApplicability?.['PDP-0']?.disposition ?? null } });
  });
  const compositionRows = compositions.map((node) => {
    const { cell, refs } = authorityCell(node, node.surfaceId);
    return makeRow({ node, surfaceType: node.kind ?? 'COMPOSITION', disposition: cell.disposition, rationale: cell.rationale, authorityRefs: refs, owner: node.canonicalOwner, topologyFields: { directMeaning: node.directMeaning, children: node.children ?? [], membershipSemantics: node.membershipSemantics ?? null } });
  });
  const logicalRows = consumers.map((node) => {
    const registry = registryById.get(node.surfaceId);
    const artifacts = registry?.applicablePdpArtifacts;
    if (!Array.isArray(artifacts) || !nonblank(registry?.applicabilityDisposition) || !nonblank(registry?.applicabilityRationale)) {
      throw new Error(`${node.surfaceId}: registry requires explicit PDP applicability disposition and rationale.`);
    }
    const applicable = artifacts.includes('PDP-2');
    const archived = registry.applicabilityDisposition === 'NOT_ACTIVE_ARCHIVED';
    if (!applicable && !archived && !nonblank(registry.applicabilityRationale)) throw new Error(`${node.surfaceId}: logical N/A has no explicit rationale.`);
    const authorityRefs = [...new Set([registry.interactionModel, registry.contractAuthority, registry.securityAuthorityModel].filter(nonblank))];
    if (applicable && authorityRefs.length === 0) throw new Error(`${node.surfaceId}: applicable logical consumer has no interface authority reference.`);
    return makeRow({ node, surfaceType: 'LOGICAL_CONSUMER', disposition: applicable ? 'APPLICABLE' : archived ? 'NOT_ACTIVE_ARCHIVED' : 'NOT_APPLICABLE', rationale: registry.applicabilityRationale, authorityRefs: authorityRefs.length ? authorityRefs : [REGISTRY_PATH], owner: (registry.owners ?? []).join(', '), logicalRegistry: registry, topologyFields: { consumers: registry.consumers ?? [], interactionModel: registry.interactionModel ?? null, contractAuthority: registry.contractAuthority ?? null, physicalOwnerSurfaceRefs: node.physicalRefs ?? [], bindingState: node.bindingState, registryApplicabilityDisposition: registry.applicabilityDisposition, registryApplicabilityRationale: registry.applicabilityRationale } });
  });
  return [...physicalRows, ...compositionRows, ...logicalRows];
}

export function buildPdp2SurfaceMatrix({ root = ROOT, status, previousMatrix, predecessorInputs, generatedAt = previousMatrix?.generatedAt ?? '1970-01-01T00:00:00.000Z' } = {}) {
  if (status?.phase !== 'PDP-2' || !['DEV_COMPLETE', 'IN_PROGRESS'].includes(status.status)) throw new Error('PDP-2 native phase status is missing or has an invalid phase/status.');
  const topology = readJson(root, TOPOLOGY_PATH);
  const registry = readYaml(root, REGISTRY_PATH);
  const topologyRows = exactTopology(topology, registry);
  const pdp0Status = predecessorInputs?.pdp0Status ?? readJson(root, PDP0_STATUS_PATH);
  const pdp1Status = predecessorInputs?.pdp1Status ?? readJson(root, PDP1_STATUS_PATH);
  const pdp0Matrix = predecessorInputs?.pdp0Matrix ?? readJson(root, PDP0_MATRIX_PATH);
  const pdp1Matrix = predecessorInputs?.pdp1Matrix ?? readJson(root, PDP1_MATRIX_PATH);
  const predecessors = predecessorState(pdp0Status, pdp1Status, pdp0Matrix, pdp1Matrix);
  const phaseSourceCurrentness = nativeCurrentness(root, status);
  const criteria = allCriteria(status);
  const outstandingMeaningIds = [...new Set(status.outstandingMeaningIds ?? [])].sort();
  const failedCriteria = criteria.failed.map((criterion) => ({
    taskId: `${criterion.criterionId}:failed-development-criteria`,
    ...criterion,
    surfaceIds: [],
    owner: null,
    assignment: 'UNASSIGNED_PHASE_LEVEL',
    blocker: 'Native direct-development criterion is not passing; source status does not assign it to an exact surface.',
  }));
  const authorityRefs = [
    ...topologyRows.physical.flatMap((node) => node.phaseApplicability?.['PDP-2']?.authorityRefs ?? [node.phaseApplicability?.['PDP-2']?.authorityRef].filter(Boolean)),
    ...topologyRows.compositions.flatMap((node) => node.phaseApplicability?.['PDP-2']?.authorityRefs ?? [node.phaseApplicability?.['PDP-2']?.authorityRef].filter(Boolean)),
    ...topologyRows.consumers.flatMap((node) => {
      const row = topologyRows.registryById.get(node.surfaceId);
      return [row?.interactionModel, row?.contractAuthority, row?.securityAuthorityModel].filter(nonblank);
    }),
  ];
  const sourceRefs = [...new Set([
    ...Object.keys(status.sourceShaSet ?? {}), REGISTRY_PATH, TOPOLOGY_PATH,
    PDP0_STATUS_PATH, PDP1_STATUS_PATH, PDP2_STATUS_PATH, PDP0_MATRIX_PATH, PDP1_MATRIX_PATH,
    ...authorityFiles(root, authorityRefs, Object.keys(status.sourceShaSet ?? {})),
  ])].filter((sourceRef) => !isEphemeralCachePath(sourceRef)).sort();
  const sourceFingerprints = currentFingerprints(root, sourceRefs);
  const sourceFingerprintSetSha256 = sha256(JSON.stringify(Object.entries(sourceFingerprints).sort(([a], [b]) => a.localeCompare(b))));
  const nativePdp2Ready = status.status === 'DEV_COMPLETE' && criteria.pass && failedCriteria.length === 0
    && outstandingMeaningIds.length === 0 && phaseSourceCurrentness.status === 'CURRENT';
  const phaseReady = nativePdp2Ready && predecessors.status === 'READY';
  const surfaces = makeSurfaceRows({ root, sourceFingerprints, topologyRows, nativeStatus: status.status, nativePdp2Ready, predecessorReady: predecessors.status === 'READY', phaseSourceCurrentness, failedCriteria, outstandingMeaningIds });
  const counts = surfaces.reduce((result, row) => { result[row.developmentStatus] = (result[row.developmentStatus] ?? 0) + 1; return result; }, {});
  const applicabilityCounts = surfaces.reduce((result, row) => { result[row.applicability.disposition] = (result[row.applicability.disposition] ?? 0) + 1; return result; }, {});
  const applicableCount = surfaces.filter((row) => !['NOT_APPLICABLE', 'NOT_ACTIVE_ARCHIVED'].includes(row.developmentStatus)).length;
  const devCompleteCount = counts.DEV_COMPLETE ?? 0;
  const campaignStatus = phaseReady && devCompleteCount === applicableCount ? 'DEV_COMPLETE' : 'IN_PROGRESS';
  const matrix = {
    schemaVersion: 'media.pdp2-surface-phase-status-matrix.v1',
    recordKind: 'SOURCE_BOUND_PDP2_DISCOVERY_DEVELOPMENT_STATUS_PROJECTION_NOT_CLOSURE_OR_ACCEPTANCE',
    campaign: { macroStage: 'DISCOVERY', phase: 'PDP-2', sourceBaselineCommit: status.mainSha ?? null, status: campaignStatus },
    generatedAt,
    statusRecordRef: PDP2_STATUS_PATH,
    statusRecordSha256: sourceFingerprints[PDP2_STATUS_PATH],
    predecessorStatusRefs: [PDP0_STATUS_PATH, PDP1_STATUS_PATH],
    predecessorStatusSha256: { [PDP0_STATUS_PATH]: sourceFingerprints[PDP0_STATUS_PATH], [PDP1_STATUS_PATH]: sourceFingerprints[PDP1_STATUS_PATH] },
    predecessorMatrixRefs: [PDP0_MATRIX_PATH, PDP1_MATRIX_PATH],
    predecessorMatrixSha256: { [PDP0_MATRIX_PATH]: sourceFingerprints[PDP0_MATRIX_PATH], [PDP1_MATRIX_PATH]: sourceFingerprints[PDP1_MATRIX_PATH] },
    sourceFingerprintSetSha256,
    sourceFingerprintSetAlgorithm: 'SHA-256 of compact JSON.stringify over sorted [repository-relative path, file SHA-256] tuples',
    sourceFingerprints,
    phaseSourceCurrentness,
    prerequisiteState: predecessors,
    nativePdp2Readiness: {
      status: nativePdp2Ready ? 'READY' : 'BLOCKED_OR_UNKNOWN',
      recordedStatus: status.status,
      directCriteriaStatus: criteria.pass ? 'PASS' : 'FAIL_OR_UNKNOWN',
      outstandingMeaningCount: outstandingMeaningIds.length,
      sourceCurrentness: phaseSourceCurrentness.status,
    },
    denominatorValidation: {
      status: surfaces.length === 54 && unique(surfaces.map(({ surfaceId }) => surfaceId)) && surfaces.every((row) => row.applicability?.disposition && nonblank(row.applicability?.rationale)) ? 'PASS' : 'FAIL',
      stats: { physical: topologyRows.physical.length, compositions: topologyRows.compositions.length, logicalConsumers: topologyRows.consumers.length, denominator: surfaces.length, applicablePdp2: applicableCount, explicitNotApplicablePdp2: (counts.NOT_APPLICABLE ?? 0) + (counts.NOT_ACTIVE_ARCHIVED ?? 0) },
    },
    summary: {
      totalSurfaceIdentities: surfaces.length,
      physical: topologyRows.physical.length,
      compositions: topologyRows.compositions.length,
      logicalConsumers: topologyRows.consumers.length,
      sourceCurrentDevCompleteCells: devCompleteCount,
      explicitNotApplicableCells: (counts.NOT_APPLICABLE ?? 0) + (counts.NOT_ACTIVE_ARCHIVED ?? 0),
      archivedLogicalConsumers: counts.NOT_ACTIVE_ARCHIVED ?? 0,
      remainingPhaseLocalTaskCount: failedCriteria.length + outstandingMeaningIds.length,
      remainingPhaseLocalTaskCountKnown: failedCriteria.length + outstandingMeaningIds.length === 0,
      remainingPhaseLocalSurfaceCount: counts.PENDING ?? 0,
      physicalApplicablePdp2: surfaces.filter((row) => row.surfaceType === 'PHYSICAL' && row.applicability.disposition !== 'NOT_APPLICABLE').length,
      compositionApplicablePdp2: surfaces.filter((row) => row.surfaceType !== 'PHYSICAL' && row.surfaceType !== 'LOGICAL_CONSUMER' && row.applicability.disposition !== 'NOT_APPLICABLE').length,
      logicalApplicablePdp2: surfaces.filter((row) => row.surfaceType === 'LOGICAL_CONSUMER' && row.applicability.disposition === 'APPLICABLE').length,
    },
    nativeDevelopmentCriteria: criteria.rows,
    unassignedPhaseLevelWork: {
      sourceRecordRef: PDP2_STATUS_PATH,
      failedCriteria,
      outstandingMeaningIds: outstandingMeaningIds.map((taskId) => ({ taskId, surfaceIds: [], owner: null, assignment: 'UNASSIGNED_PHASE_LEVEL' })),
      surfaceAssignmentState: failedCriteria.length + outstandingMeaningIds.length ? 'UNKNOWN_PHASE_LOCAL_OWNERSHIP' : 'KNOWN_ZERO_PHASE_LOCAL_TASKS',
      note: 'Phase-level criteria failures and outstanding meaning IDs without exact source assignments remain unassigned and are not copied to surface rows.',
    },
    claimsBoundary: { ownerApproval: 'NOT_CLAIMED', independentAcceptance: 'NOT_CLAIMED', nativeClosure: 'NOT_PERFORMED', implementationQualification: 'NOT_EVALUATED', delivery: 'NOT_ENTERED', runtimeAdmission: 'NOT_ADMITTED', transportAdmission: 'NOT_ADMITTED' },
    surfaceAuthority: 'PDP-2 applicability: topology.phaseApplicability.PDP-2 for physical and composite surfaces; surface-registry.yaml applicablePdpArtifacts and explicit disposition/rationale for logical consumers. Identity denominator: topology physical candidates + compositions + consumer crosswalk joined exactly to surface-registry.yaml.',
    surfaces,
  };
  if (matrix.denominatorValidation.status !== 'PASS') throw new Error('PDP-2 matrix denominator validation failed.');
  return matrix;
}

export function generatePdp2SurfaceMatrix({ root = ROOT, mode = 'write' } = {}) {
  if (!['write', 'check'].includes(mode)) throw new Error(`Unsupported mode: ${mode}`);
  const previousMatrix = readJson(root, PDP2_MATRIX_PATH);
  const status = readJson(root, PDP2_STATUS_PATH);
  let matrix = buildPdp2SurfaceMatrix({ root, status, previousMatrix, generatedAt: previousMatrix.generatedAt });
  const sourceInputsChanged = matrix.sourceFingerprintSetSha256 !== previousMatrix.sourceFingerprintSetSha256
    || matrix.statusRecordSha256 !== previousMatrix.statusRecordSha256;
  if (mode === 'write' && sourceInputsChanged) {
    matrix = buildPdp2SurfaceMatrix({ root, status, previousMatrix, generatedAt: new Date().toISOString() });
  }
  const output = `${JSON.stringify(matrix, null, 2)}\n`;
  if (mode === 'write') fs.writeFileSync(path.join(root, PDP2_MATRIX_PATH), output);
  else if (readBytes(root, PDP2_MATRIX_PATH).toString('utf8') !== output) throw new Error(`${PDP2_MATRIX_PATH} is stale; regenerate after PDP-2 source status settles.`);
  return { matrix, output };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv.includes('--check') ? 'check' : 'write';
  const { matrix } = generatePdp2SurfaceMatrix({ mode });
  console.log(JSON.stringify({ matrixPath: PDP2_MATRIX_PATH, phaseStatus: matrix.campaign.status, rows: matrix.surfaces.length, sourceCurrentness: matrix.phaseSourceCurrentness.status }, null, 2));
}
