import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { pdp0PhaseScopedSourcePins } from '../report-media-pdp-readiness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');
const predecessorRefs = {
  exitRef: 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r12.json',
  exitSha256: 'sha256:91aeae0aad488bc8eb29d40bf955e527ef072ada762948064bc8e50422c5a5c5',
  currentnessRef: 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r12.json',
  currentnessSha256: 'sha256:14882e245fa1676138cfc5bd51ef0403cb96cf2f77542caa2c57dc683ca8b159',
};

const addedConsumerIds = [
  'media.surface.capture-adapters',
  'media.surface.interactive-demo-player',
  'media.surface.production-studio',
  'media.surface.recorder-orchestrator',
];

const sourceBoundPaths = [
  '.product-experience/surfaces/media-physical-topology.v1.json',
  '.product-experience/surface-registry.yaml',
  '.product-experience/artifact-identities.yaml',
  '.product-experience/decision-log.md',
  '.product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md',
  '.product-experience/pdp-0-product-truth/applications-channels.yaml',
  '.product-experience/pdp-0-product-truth/capabilities.yaml',
  '.product-experience/pdp-0-product-truth/requirements.yaml',
  '.product-experience/pdp-0-product-truth/recorder-studio-extension.yaml',
  '.product-experience/pdp-0-product-truth/generated/product-definition.candidate.json',
];

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function digestValue(value) {
  return sha256(Buffer.from(JSON.stringify(value)));
}

function fileDigest(repoRoot, relativePath) {
  return sha256(fs.readFileSync(path.join(repoRoot, relativePath)));
}

function normalizeTechnicalPeerReview(repoRoot, review, currentSourcePins) {
  if (!review || typeof review !== 'object'
      || typeof review.recordRef !== 'string' || path.isAbsolute(review.recordRef)
      || path.relative(repoRoot, path.resolve(repoRoot, review.recordRef)).startsWith('..')
      || typeof review.reviewer !== 'string' || !review.reviewer.startsWith('agent:')
      || review.reviewer === 'agent:/root/phase_io'
      || !['PASS', 'PASS_WITH_LIMITATIONS'].includes(review.assessment)
      || !Array.isArray(review.reviewedSurfaceIds)
      || review.reviewedSurfaceIds.slice().sort().join('\n') !== addedConsumerIds.slice().sort().join('\n')
      || !isDeepStrictEqual(review.sourceFingerprints, currentSourcePins)
      || review.ownerAcceptance !== 'NOT_CLAIMED'
      || review.independentAcceptance !== 'NOT_CLAIMED'
      || review.nativeClosure !== 'NOT_CLAIMED'
      || !Array.isArray(review.findings)) {
    throw new Error('Distinct PDP-0 technical peer review is missing or does not bind the exact current source cut');
  }
  const reviewDigest = fileDigest(repoRoot, review.recordRef);
  if (review.recordSha256 !== reviewDigest) throw new Error('PDP-0 technical peer review digest does not match its source bytes');
  return {
    recordRef: review.recordRef,
    recordSha256: reviewDigest,
    reviewer: review.reviewer,
    assessment: review.assessment,
    reviewedSurfaceIds: review.reviewedSurfaceIds.slice().sort(),
    sourceFingerprints: structuredClone(review.sourceFingerprints),
    findings: structuredClone(review.findings),
    ownerAcceptance: review.ownerAcceptance,
    independentAcceptance: review.independentAcceptance,
    nativeClosure: review.nativeClosure,
  };
}

function cellId(cell) {
  return cell.cellId;
}

export function deriveMediaPdp0SourceDevelopmentDelta(historical, currentness) {
  const previousCells = historical?.physicalCompositeConsumerCells ?? [];
  const previousFiles = historical?.sourceContentDigests ?? {};
  const cells = currentness?.physicalCompositeConsumerCells ?? [];
  const currentFiles = currentness?.sourceContentDigests ?? {};
  const previousIds = previousCells.map(cellId).sort();
  const currentIds = cells.map(cellId).sort();
  const addedCells = currentIds.filter((id) => !previousIds.includes(id));
  const removedCells = previousIds.filter((id) => !currentIds.includes(id));
  const priorPaths = Object.keys(previousFiles).sort();
  const currentPaths = Object.keys(currentFiles).sort();
  const priorPathSet = new Set(priorPaths);
  const currentPathSet = new Set(currentPaths);
  const changedPaths = priorPaths.filter((sourcePath) => currentPathSet.has(sourcePath)
    && previousFiles[sourcePath] !== currentFiles[sourcePath]).map((sourcePath) => ({
    path: sourcePath,
    predecessorSha256: previousFiles[sourcePath],
    currentSha256: currentFiles[sourcePath],
  }));
  const addedPaths = currentPaths.filter((sourcePath) => !priorPathSet.has(sourcePath));
  const removedPaths = priorPaths.filter((sourcePath) => !currentPathSet.has(sourcePath));
  if (previousCells.length !== 50 || priorPaths.length !== 146
      || cells.length !== 54 || currentPaths.length !== 207
      || addedCells.join('\n') !== addedConsumerIds.map((id) => `${id}:PDP-0`).sort().join('\n')
      || removedCells.length !== 0 || new Set(currentIds).size !== 54
      || new Set(currentPaths).size !== 207) {
    throw new Error('PDP-0 source-development delta is not the exact immutable 50/146 to current 54/207 cut');
  }
  return {
    addedCellIds: addedCells,
    removedCellIds: removedCells,
    addedMaterialPaths: addedPaths,
    removedMaterialPaths: removedPaths,
    changedMaterialPaths: changedPaths,
    currentCellIds: currentIds,
    currentMaterialPaths: currentPaths,
  };
}

function assertCurrentPdp0Sources(repoRoot, currentness) {
  const statusPath = 'docs/implementation/pdp-0-phase-dev-status.json';
  const status = JSON.parse(fs.readFileSync(path.join(repoRoot, statusPath), 'utf8'));
  const candidatePath = '.product-experience/pdp-0-product-truth/generated/product-definition.candidate.json';
  const candidateDigest = fileDigest(repoRoot, candidatePath);
  const projectionDigest = pdp0PhaseScopedSourcePins()['.product-experience/source-manifest.yaml#PDP-0-projection'];
  const currentFiles = currentness?.sourceContentDigests ?? {};
  const cells = currentness?.physicalCompositeConsumerCells ?? [];
  const directCriteria = status.directDevelopmentCriteria ?? {};
  const criteriaPass = Object.keys(directCriteria).sort().join(',') === 'P0-01,P0-02,P0-03,P0-04,P0-05,P0-06,P0-07,P0-08'
    && Object.values(directCriteria).every((criterion) => criterion.testStatus === 'PASS');

  if (status.phase !== 'PDP-0' || status.status !== 'DEV_COMPLETE'
      || (status.outstandingMeaningIds ?? []).length !== 0 || !criteriaPass
      || status.sourceShaSet?.[candidatePath] !== candidateDigest.slice('sha256:'.length)
      || status.sourceShaSet?.['.product-experience/decision-log.md#PXD-207-section'] !== pdp0PhaseScopedSourcePins()['.product-experience/decision-log.md#PXD-207-section']
      || status.sourceShaSet?.['.product-experience/source-manifest.yaml#PDP-0-projection'] !== projectionDigest
      || currentness?.phaseDisposition?.sourceCurrent !== true
      || currentness?.phaseDisposition?.currentSourceCurrentness !== 'PASS'
      || cells.length !== 54 || cells.some((cell) => cell.sourceCurrentness !== 'CURRENT' || (cell.blockers?.length ?? 0) > 0)
      || Object.keys(currentFiles).length !== 207
      || currentness?.denominators?.totalCells !== 54
      || currentness?.materialPathDenominator?.uniquePaths !== 207) {
    throw new Error('Current PDP-0 source-development cut is not complete and source-current for the 54-cell, 207-path cut');
  }
  return { status, candidatePath, candidateDigest, projectionDigest, cells, currentFiles };
}

/**
 * Build an internal source-development successor record. R12 remains an
 * immutable historical cut; this record deliberately makes no byte- or
 * meaning-equivalence claim to R12, whose candidate was captured from a dirty
 * worktree and is not available as an exact source blob.
 */
export function buildMediaPdp0SourceDevelopmentCurrentCut({
  repositoryRoot = root,
  currentness,
  technicalPeerReview = null,
  actor = 'agent:/root/phase_io',
} = {}) {
  const repoRoot = path.resolve(repositoryRoot);
  const historicalPath = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r12.json';
  const historicalExitPath = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r12.json';
  const historical = JSON.parse(fs.readFileSync(path.join(repoRoot, historicalPath), 'utf8'));
  const historicalExit = JSON.parse(fs.readFileSync(path.join(repoRoot, historicalExitPath), 'utf8'));
  const { status, candidatePath, candidateDigest, projectionDigest, cells, currentFiles } = assertCurrentPdp0Sources(repoRoot, currentness);
  const delta = deriveMediaPdp0SourceDevelopmentDelta(historical, currentness);
  const currentSourcePins = Object.fromEntries(sourceBoundPaths.map((sourcePath) => [sourcePath, fileDigest(repoRoot, sourcePath)]));
  const peerReview = normalizeTechnicalPeerReview(repoRoot, technicalPeerReview, currentSourcePins);
  const pxd207Digest = pdp0PhaseScopedSourcePins()['.product-experience/decision-log.md#PXD-207-section'];
  const matrix = JSON.parse(fs.readFileSync(path.join(repoRoot, 'docs/implementation/verification/pdp-38/pdp0-surface-phase-status-matrix.json'), 'utf8'));
  const pxd207BackedCellIds = cells.filter((cell) => cell.surfaceId && matrix.surfaces?.some((row) =>
    row.surfaceId === cell.surfaceId && (row.sourceRefs ?? []).some((sourceRef) => sourceRef === '.product-experience/decision-log.md#PXD-207')))
    .map(cellId).sort();
  const sourceSetFingerprint = currentness.materialSourceSetFingerprint;
  const pathSetFingerprint = digestValue(delta.currentMaterialPaths);
  const p0MeaningEvidence = {
    candidateSha256: candidateDigest,
    productTruthDecision: '.product-experience/decision-log.md#PXD-207',
    productTruthDecisionSectionSha256: `sha256:${pxd207Digest}`,
    statusProjectionPins: {
      sourceStatusSha256: fileDigest(repoRoot, 'docs/implementation/pdp-0-phase-dev-status.json'),
      surfaceMatrixSha256: fileDigest(repoRoot, 'docs/implementation/verification/pdp-38/pdp0-surface-phase-status-matrix.json'),
    },
    currentDirectCriteria: Object.fromEntries(Object.entries(status.directDevelopmentCriteria).sort(([a], [b]) => a.localeCompare(b))
      .map(([id, criterion]) => [id, { testStatus: criterion.testStatus, testCount: criterion.testCount, passedTestCount: criterion.passedTestCount, skippedTestCount: criterion.skippedTestCount }])),
    testReceipts: Object.fromEntries(Object.entries(status.testsActuallyRun ?? {}).sort(([a], [b]) => a.localeCompare(b))
      .map(([id, receipt]) => [id, {
        command: receipt.command,
        status: receipt.status,
        outputSha256: receipt.outputSha256,
        testSourceFingerprints: receipt.testSourceFingerprints ?? {},
      }])),
    outstandingMeaningIds: status.outstandingMeaningIds,
  };
  const payload = {
    schemaVersion: 'media.discovery.pdp0-source-development-current-cut.v1',
    recordId: 'MEDIA-DISCOVERY-PDP0-SOURCE-DEVELOPMENT-CURRENT-CUT-2026-10-23-R1',
    campaign: {
      repository: 'samujjwal/ghatana-media',
      macroStage: 'DISCOVERY',
      phase: 'PDP-0',
      scope: 'Current source-development cut for the complete 54-identity Media campaign; includes the four source-owned Recorder/Studio logical consumers and their current PDP-0 applicability/meaning records.',
    },
    authority: {
      technicalSourceAuthor: actor,
      basis: 'Explicit root-delegated technical-owner authority within the user-authorized Media Discovery source lane.',
      independentTechnicalReview: 'RECORDED_SEPARATELY',
      ownerAcceptance: 'NOT_CLAIMED',
      independentAcceptance: 'NOT_CLAIMED',
      nativeLifecycleReceipt: 'NOT_CLAIMED',
    },
    predecessorCut: {
      ...predecessorRefs,
      relation: 'HISTORICAL_REFERENCE_ONLY_NO_BYTE_OR_MEANING_EQUIVALENCE_CLAIM',
      topology: historical.denominators,
      materialPathCount: Object.keys(previousFiles).length,
      predecessorCandidateSha256: previousFiles[candidatePath] ?? null,
      predecessorWorktreeWasDirty: Boolean(historical.campaign?.worktreeStatusAtCapture),
      exactPredecessorCandidateAvailable: false,
    },
    currentCut: {
      sourceStatusRef: 'docs/implementation/pdp-0-phase-dev-status.json',
      sourceStatusSha256: fileDigest(repoRoot, 'docs/implementation/pdp-0-phase-dev-status.json'),
      candidateRef: candidatePath,
      sourceManifestRef: '.product-experience/source-manifest.yaml',
      sourceManifestSha256: fileDigest(repoRoot, '.product-experience/source-manifest.yaml'),
      sourceManifestPdp0ProjectionSha256: `sha256:${projectionDigest}`,
      denominator: currentness.denominators,
      materialPathCount: delta.currentMaterialPaths.length,
      materialPathSetFingerprint: pathSetFingerprint,
      materialSourceSetFingerprint: sourceSetFingerprint,
      currentCellIds: delta.currentCellIds,
      addedCellIds: delta.addedCellIds,
      removedCellIds: delta.removedCellIds,
      addedMaterialPaths: delta.addedMaterialPaths,
      removedMaterialPaths: delta.removedMaterialPaths,
      changedMaterialPaths: delta.changedMaterialPaths,
      sourcePins: currentSourcePins,
    },
    sourceDevelopment: {
      classification: 'CURRENT_SOURCE_DEVELOPMENT_SCOPE_EXTENSION',
      surfaceIds: addedConsumerIds,
      pxd207BackedCellIds,
      semanticEquivalenceToPredecessor: 'NOT_CLAIMED',
      currentPdp0MeaningEvidence: p0MeaningEvidence,
      directCriteriaStatus: 'PASS',
      outstandingPdp0MeaningIds: [],
    },
    technicalPeerReview: peerReview,
    gates: {
      sourceCurrentness: 'OBSERVED_FOR_CURRENT_CUT_ONLY',
      discoveryAcceptance: 'NOT_CLAIMED',
      lifecycleClosure: 'NOT_ENTERED',
      build: 'NOT_ENTERED',
      delivery: 'NOT_AUTHORIZED',
      release: 'NOT_AUTHORIZED',
    },
    limitations: 'This record establishes the observed current PDP-0 source-development cut and its exact inventory delta. It does not assert byte or meaning equivalence with R12, whose captured candidate came from a dirty worktree and is unavailable as an exact source blob. It does not claim owner acceptance, independent acceptance, native closure, Build, Delivery, or release.',
  };
  return payload;
}

export function validateMediaPdp0SourceDevelopmentCurrentCut(record, {
  repositoryRoot = root,
  currentness,
  technicalPeerReview = null,
} = {}) {
  try {
    const expected = buildMediaPdp0SourceDevelopmentCurrentCut({ repositoryRoot, currentness, technicalPeerReview });
    return isDeepStrictEqual(record, expected);
  } catch {
    return false;
  }
}

export function mediaPdp0SourceDevelopmentCutSha256(record) {
  return sha256(Buffer.from(JSON.stringify(record, null, 2) + '\n'));
}
