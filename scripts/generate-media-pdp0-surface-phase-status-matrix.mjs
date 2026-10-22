#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { projectPdp0DefinitionExtensionApplicability, readSources } from './check-media-pdp0-surface-denominator.mjs';
import { pdp0PhaseScopedSourcePins } from './report-media-pdp-readiness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const matrixPath = 'docs/implementation/verification/pdp-38/pdp0-surface-phase-status-matrix.json';
const statusPath = 'docs/implementation/pdp-0-phase-dev-status.json';
const sourcePaths = [
  '.product-experience/surface-registry.yaml',
  '.product-experience/surfaces/media-physical-topology.v1.json',
  '.product-experience/pdp-0-product-truth/applications-channels.yaml',
  '.product-experience/pdp-0-product-truth/capabilities.yaml',
  '.product-experience/pdp-0-product-truth/campaign-extensions.yaml',
  statusPath,
];
const digest = (value) => createHash('sha256').update(value).digest('hex');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath));
const sha256 = (relativePath) => digest(read(relativePath));
const matrix = JSON.parse(read(matrixPath).toString('utf8'));
const status = JSON.parse(read(statusPath).toString('utf8'));
const { registry, topology, authority } = readSources(root);
const projection = projectPdp0DefinitionExtensionApplicability(registry, topology, authority);
if (!projection.ok || projection.records.length !== 4158 || projection.surfaceCellCount !== 378 || matrix.surfaces.length !== 54) {
  throw new Error('PDP-0 surface matrix requires a valid 7 × 11 × 54 definition-extension projection over the exact denominator.');
}
const extensionById = new Map((authority.campaignExtensions.currentDefinitionPopulation.records ?? []).map((row) => [row.capabilityId, row]));
const cellBySurface = new Map();
for (const cell of projection.records) {
  if (!cellBySurface.has(cell.surfaceId)) cellBySurface.set(cell.surfaceId, []);
  cellBySurface.get(cell.surfaceId).push(cell);
}
const projectedPins = pdp0PhaseScopedSourcePins();
const decisionRef = authority.applications.coordinatorDefinitionExtensionApplicability.decisionRef;
const decisionId = decisionRef.match(/#(PXD-\d{3})$/)?.[1];
if (!decisionId) throw new Error('PDP-0 extension applicability must bind one exact PXD decision section.');
const decisionSectionPin = `.product-experience/decision-log.md#${decisionId}-section`;
if (!projectedPins[decisionSectionPin]) throw new Error(`Missing current PDP-0 section pin for ${decisionRef}.`);
const versionDecisionRefs = authority.campaignExtensions.currentDefinitionPopulation.versionDisposition.decisionRefs;
const versionDecisionSectionPins = versionDecisionRefs.map((ref) => {
  const id = ref.match(/#(PXD-\d{3})$/)?.[1];
  if (!id) throw new Error(`Malformed version disposition decision reference: ${ref}`);
  const pin = `.product-experience/decision-log.md#${id}-section`;
  if (!projectedPins[pin]) throw new Error(`Missing current PDP-0 section pin for ${ref}.`);
  return pin;
});
const sourceFingerprints = Object.fromEntries(sourcePaths.map((sourcePath) => [sourcePath, sha256(sourcePath)]));
sourceFingerprints[decisionSectionPin] = projectedPins[decisionSectionPin];
for (const pin of versionDecisionSectionPins) sourceFingerprints[pin] = projectedPins[pin];
const sourceFingerprintSetSha256 = digest(JSON.stringify(Object.entries(sourceFingerprints).sort(([a], [b]) => a.localeCompare(b))));
const staleSourcePins = Object.entries(status.sourceShaSet ?? {}).flatMap(([sourceRef, expectedSha256]) => {
  const projectionPin = sourceRef.includes('#');
  const currentSha256 = projectionPin
    ? projectedPins[sourceRef]
    : fs.existsSync(path.join(root, sourceRef)) ? sha256(sourceRef) : undefined;
  return currentSha256 === expectedSha256 ? [] : [{ sourceRef, expectedSha256, currentSha256: currentSha256 ?? null }];
});
const phaseSourceCurrentness = {
  status: staleSourcePins.length === 0 ? 'CURRENT' : 'STALE',
  sourcePinCount: Object.keys(status.sourceShaSet ?? {}).length,
  staleSourcePinCount: staleSourcePins.length,
  staleSourcePins,
  note: 'Live byte pins are checked by file path; #fragment pins are compared with pdp0PhaseScopedSourcePins() projections.',
};
const extensionSourcePrefix = '.product-experience/pdp-0-product-truth/applications-channels.yaml#coordinatorDefinitionExtensionApplicability';
const failedCriteria = Object.entries(status.directDevelopmentCriteria ?? {})
  .filter(([, criterion]) => criterion.testStatus === 'FAIL')
  .map(([criterionId, criterion]) => ({
    taskId: `${criterionId}:failed-development-criteria`,
    criterionId,
    testStatus: criterion.testStatus,
    failedTestCount: criterion.testCount - criterion.passedTestCount - criterion.skippedTestCount,
    surfaceIds: [],
    owner: null,
    assignment: 'UNASSIGNED_PHASE_LEVEL',
    blocker: 'Source-pinned direct development criterion is failing; the status record does not assign it to an exact surface.',
  }));
const outstandingMeaningTasks = (status.outstandingMeaningIds ?? []).map((taskId) => ({
  taskId,
  kind: 'OUTSTANDING_MEANING',
  surfaceIds: [],
  owner: null,
  assignment: 'UNASSIGNED_PHASE_LEVEL',
}));

matrix.generatedAt = process.argv.includes('--check') ? matrix.generatedAt : new Date().toISOString();
matrix.statusRecordRef = statusPath;
matrix.statusRecordSha256 = sourceFingerprints[statusPath];
matrix.campaign.sourceBaselineCommit = status.mainSha;
matrix.sourceFingerprints = sourceFingerprints;
matrix.sourceFingerprintSetSha256 = sourceFingerprintSetSha256;
matrix.phaseSourceCurrentness = phaseSourceCurrentness;
matrix.definitionExtensionApplicability = {
  status: projection.status,
  extensionCount: 7,
  currentVersionExtensionCount: projection.versionDisposition.currentVersionExtensionCount,
  currentVersionExtensionCapabilityIds: projection.versionDisposition.currentVersionExtensionCapabilityIds,
  futureVersionProposalCount: projection.versionDisposition.futureVersionProposalCount,
  futureVersionProposalCapabilityIds: projection.versionDisposition.futureVersionProposalCapabilityIds,
  versionDispositionDecisionRefs: projection.versionDisposition.decisionRefs,
  surfaceIdentityCount: 54,
  channelCount: projection.channelCount,
  surfaceCellCount: projection.surfaceCellCount,
  cellCount: projection.records.length,
  surfaceCellCounts: projection.surfaceCounts,
  cellCounts: projection.counts,
  outstandingTaskId: null,
  ownerApproval: 'NOT_CLAIMED',
  independentAcceptance: 'NOT_CLAIMED',
};
matrix.summary = {
  ...matrix.summary,
  explicitNotApplicableCells: 8,
  archivedLogicalConsumers: 1,
  remainingPhaseLocalTaskCount: failedCriteria.length + outstandingMeaningTasks.length,
  remainingPhaseLocalSurfaceCount: 0,
  unknownExtensionApplicabilityCells: projection.counts.UNKNOWN_PENDING_OWNER_DECISION ?? 0,
  proposedDirectChannelSurfaceCells: projection.counts.OWNER_DECIDED_APPLICABLE,
  derivedAggregateProposalCells: projection.counts.DERIVED_AGGREGATE_OWNER_DECISION,
};
matrix.unassignedPhaseLevelWork = {
  sourceRecordRef: statusPath,
  failedCriteria,
  outstandingMeaningTasks,
  note: 'These phase-level items have no exact surface ownership in the source status record and are not fanned out to surface rows.',
};
matrix.claimsBoundary.coordinatorDefinitionReview = 'SOURCE_CURRENT_PDP0_DEFINITION_EXTENSION_APPLICABILITY_REVIEW';
const priorStatusReview = matrix.sourcePinImpactReview;
matrix.sourcePinImpactReview = {
  phase: 'PDP-0',
  reviewedPath: statusPath,
  predecessorSha256: priorStatusReview?.currentSha256 === sourceFingerprints[statusPath]
    ? priorStatusReview.predecessorSha256
    : priorStatusReview?.currentSha256 ?? matrix.statusRecordSha256,
  currentSha256: matrix.statusRecordSha256,
  disposition: 'PDP0_DEFINITION_EXTENSION_APPLICABILITY_MATRIX_REFRESH; PXD207_EXPLICIT_PARTITION_SOURCE_CURRENT',
  impact: `The 54-surface matrix now carries all ${projection.records.length.toLocaleString('en-US')} channel-by-surface cells and ${projection.surfaceCellCount} extension-by-surface summaries. Counts: ${projection.counts.OWNER_DECIDED_APPLICABLE} direct proposal cells, ${projection.counts.DERIVED_AGGREGATE_OWNER_DECISION} derived aggregate proposal cells, ${projection.counts.NOT_APPLICABLE_OWNER_DECISION} explicit owner-decided N/A cells, ${projection.counts.NOT_APPLICABLE_SUPPORT} source-backed support-only N/A cells, and ${projection.counts.NOT_APPLICABLE_ARCHIVED} source-backed archived N/A cells. PXD-207 source decisions preserve owner approval and independent acceptance as unclaimed.`,
  pdp0Retest: status.status === 'DEV_COMPLETE' ? 'P0_TESTS_PASS; DISCOVERY_BARRIER_RECALCULATED' : 'P0_TESTS_RECORDED; PDP0_EXTENSION_APPLICABILITY_SOURCE_CURRENT',
  ownerApproval: 'NOT_CLAIMED',
  nativeClosure: 'NOT_PERFORMED',
  decisionRef: '.product-experience/decision-log.md#PXD-207',
};

const extensionIds = [...extensionById.keys()].sort();
for (const row of matrix.surfaces) {
  const featureRows = (cellBySurface.get(row.surfaceId) ?? []).map((cell) => {
    const extension = extensionById.get(cell.capabilityRef);
    if (!extension) throw new Error(`Missing campaign definition extension: ${cell.capabilityRef}`);
    const sourceRef = `${extensionSourcePrefix}/records/@capabilityRef=${cell.capabilityRef}`;
    return {
      featureId: extension.sourceAuditIds[0],
      definitionExtensionId: cell.capabilityRef,
      capabilityRef: cell.capabilityRef,
      versionScopeStatus: cell.versionScopeStatus,
      versionDispositionRef: cell.versionDispositionRef,
      decisionRef: authority.applications.coordinatorDefinitionExtensionApplicability.decisionRef,
      sourceRef,
      sourceAuditIds: extension.sourceAuditIds,
      applicabilityState: cell.disposition === 'OWNER_DECIDED_APPLICABLE'
        ? 'OWNER-DECIDED APPLICABLE; delegated PXD-207 source definition only'
        : cell.disposition === 'DERIVED_AGGREGATE_OWNER_DECISION'
          ? 'DERIVED AGGREGATE OWNER DECISION; source topology and own obligations resolved'
        : cell.disposition === 'UNKNOWN_PENDING_OWNER_DECISION'
          ? 'UNKNOWN; exact owner applicability decision required'
          : cell.disposition === 'NOT_APPLICABLE_OWNER_DECISION'
            ? 'OWNER-DECIDED NOT APPLICABLE; explicit PXD-207 scope decision'
            : 'SOURCE-BACKED N/A; existing support or archived authority applies',
      disposition: cell.disposition,
      channelRef: cell.channelRef,
      channelRefs: cell.channelRefs,
      ownerApproval: cell.ownerApproval,
      independentAcceptance: cell.independentAcceptance,
      executionAdmission: cell.executionAdmission,
      rationale: cell.rationale,
    };
  }).sort((a, b) => a.capabilityRef.localeCompare(b.capabilityRef) || a.channelRef.localeCompare(b.channelRef));
  if (featureRows.length !== 77 || JSON.stringify([...new Set(featureRows.map((item) => item.definitionExtensionId))].sort()) !== JSON.stringify(extensionIds)
      || new Set(featureRows.map((item) => `${item.definitionExtensionId}\u0000${item.channelRef}`)).size !== 77) {
    throw new Error(`Surface ${row.surfaceId} does not have exactly 7 × 11 current extension channel cells.`);
  }
  row.campaignExtensionApplicability = [
    ...(row.campaignExtensionApplicability ?? []).filter((item) => item.featureId === 'AUD-SPEC-020'),
    ...featureRows,
  ];
  row.sourceRefs = [...new Set([
    ...(row.sourceRefs ?? []).filter((sourceRef) => sourceRef !== '.product-experience/decision-log.md'),
    '.product-experience/pdp-0-product-truth/applications-channels.yaml',
    '.product-experience/pdp-0-product-truth/campaign-extensions.yaml',
    '.product-experience/pdp-0-product-truth/capabilities.yaml',
    authority.applications.coordinatorDefinitionExtensionApplicability.decisionRef,
    ...versionDecisionRefs,
    ...featureRows.map((item) => item.sourceRef),
  ])].sort();
  const priorRowSourceFingerprints = {...(row.sourceFingerprints ?? {})};
  delete priorRowSourceFingerprints['.product-experience/decision-log.md'];
  row.sourceFingerprints = {
    ...priorRowSourceFingerprints,
    '.product-experience/pdp-0-product-truth/applications-channels.yaml': sourceFingerprints['.product-experience/pdp-0-product-truth/applications-channels.yaml'],
    '.product-experience/pdp-0-product-truth/campaign-extensions.yaml': sourceFingerprints['.product-experience/pdp-0-product-truth/campaign-extensions.yaml'],
    '.product-experience/pdp-0-product-truth/capabilities.yaml': sourceFingerprints['.product-experience/pdp-0-product-truth/capabilities.yaml'],
    [decisionSectionPin]: sourceFingerprints[decisionSectionPin],
    ...Object.fromEntries(versionDecisionSectionPins.map((pin) => [pin, sourceFingerprints[pin]])),
  };
  row.sourceCurrent = phaseSourceCurrentness.status === 'CURRENT';
  row.sourceCurrentBasis = phaseSourceCurrentness.status === 'CURRENT'
    ? 'All current PDP-0 phase sourceShaSet byte and projection pins match; source currentness is separate from definition completeness.'
    : `PDP-0 phase source currentness is STALE: ${staleSourcePins.length} of ${phaseSourceCurrentness.sourcePinCount} required phase pins do not match; per-surface sourceCurrent is gated false. Definition completion remains a separate status.`;
}

const phaseReady = status.status === 'DEV_COMPLETE'
  && failedCriteria.length === 0
  && outstandingMeaningTasks.length === 0
  && phaseSourceCurrentness.status === 'CURRENT'
  && (projection.counts.UNKNOWN_PENDING_OWNER_DECISION ?? 0) === 0;
for (const row of matrix.surfaces) {
  const applicability = row.applicability?.disposition;
  if (applicability === 'ARCHIVED') {
    row.developmentStatus = 'NOT_ACTIVE_ARCHIVED';
    continue;
  }
  if (applicability === 'NOT_APPLICABLE_SUPPORT' || applicability === 'NOT_APPLICABLE_OWNER_DECISION') {
    row.developmentStatus = 'NOT_APPLICABLE';
    continue;
  }
  row.developmentStatus = phaseReady && row.sourceCurrent && row.remainingPhaseLocalTaskIds.length === 0
    ? 'DEV_COMPLETE'
    : 'IN_PROGRESS';
}
const statusCounts = matrix.surfaces.reduce((counts, row) => {
  counts[row.developmentStatus] = (counts[row.developmentStatus] ?? 0) + 1;
  return counts;
}, {});
const allApplicableSurfacesComplete = (statusCounts.DEV_COMPLETE ?? 0) === 45;
matrix.campaign.status = phaseReady && allApplicableSurfacesComplete ? 'DEV_COMPLETE' : 'IN_PROGRESS';
matrix.summary.nativeDevCompleteCells = statusCounts.DEV_COMPLETE ?? 0;
matrix.summary.inProgressCells = statusCounts.IN_PROGRESS ?? 0;
matrix.summary.explicitNotApplicableCells = statusCounts.NOT_APPLICABLE ?? 0;
matrix.summary.archivedLogicalConsumers = statusCounts.NOT_ACTIVE_ARCHIVED ?? 0;
matrix.summary.remainingPhaseLocalTaskCount = new Set([
  ...failedCriteria.map((task) => task.taskId),
  ...outstandingMeaningTasks.map((task) => task.taskId),
  ...matrix.surfaces.flatMap((row) => row.remainingPhaseLocalTaskIds),
]).size;
matrix.summary.remainingPhaseLocalSurfaceCount = statusCounts.IN_PROGRESS ?? 0;
for (const row of matrix.surfaces) {
  row.nextLegalAction = matrix.campaign.status === 'DEV_COMPLETE'
    ? 'PDP-1 may begin only on the source-current PDP-0 barrier; preserve each surface’s source-declared PDP-1 applicability. No closure or acceptance claim is implied.'
    : 'Resolve the earliest remaining PDP-0 source-current definition or validation task before advancing to PDP-1.';
}

const output = `${JSON.stringify(matrix, null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (read(matrixPath).toString('utf8') !== output) throw new Error(`${matrixPath} is stale; regenerate it after the PDP-0 status record.`);
} else if (process.argv.includes('--write')) {
  fs.writeFileSync(path.join(root, matrixPath), output);
} else {
  console.log(JSON.stringify({ matrixPath, status: status.status, counts: projection.counts }, null, 2));
}
