#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalizeVerificationValue,
  captureRepositorySourceCurrentness,
  isRepositorySourceCurrentness,
} from '@ghatana/verification-planner';
import { observeMediaDiscoveryCurrentness, resolveMediaPdp0Cells } from './media-discovery-currentness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-13.json';
const externalRoots = {
  ghatana: '../ghatana',
  'ghatana-products': '../ghatana-products',
  gharbatai: '../gharbatai',
  'ghatana-tools': '../ghatana-tools',
  'ghatana-lifecycle': '../ghatana-lifecycle',
  'ghatana-shared': '../ghatana-shared',
};

function hashBytes(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function hashValue(value) {
  return hashBytes(canonicalizeVerificationValue(value));
}

function runGit(args, cwd = root) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function parseScalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) return JSON.parse(trimmed);
  return trimmed;
}

function parseExternalObservations(source) {
  const start = source.indexOf('\n  repositories:\n');
  const end = source.indexOf('\nsupplementalDecisionReference:', start);
  if (start < 0 || end < 0) throw new Error('source-manifest externalOwnerObservations section is incomplete');
  const repositories = [];
  let repository = null;
  let file = null;
  const flushFile = () => {
    if (repository && file) repository.files.push(file);
    file = null;
  };
  for (const line of source.slice(start, end).split(/\r?\n/u)) {
    const repoMatch = line.match(/^  - repositoryId: (.+)$/u);
    if (repoMatch) {
      flushFile();
      repository = { repositoryId: parseScalar(repoMatch[1]), files: [] };
      repositories.push(repository);
      continue;
    }
    const fileMatch = line.match(/^      - path: (.+)$/u);
    if (fileMatch) {
      flushFile();
      if (!repository) throw new Error('External source file appears before a repository identity');
      file = { path: parseScalar(fileMatch[1]) };
      continue;
    }
    if (!repository || !line.trim()) continue;
    const repositoryField = line.match(/^    (available|revision|workingTree): (.+)$/u);
    if (repositoryField) {
      repository[repositoryField[1]] = parseScalar(repositoryField[2]);
      continue;
    }
    const fileField = line.match(/^        (package|version|sha256|state): (.+)$/u);
    if (file && fileField) file[fileField[1]] = parseScalar(fileField[2]);
  }
  flushFile();
  const count = repositories.reduce((total, entry) => total + entry.files.length, 0);
  if (repositories.length !== 6 || count !== 30 || repositories.some((entry) => !externalRoots[entry.repositoryId])) {
    throw new Error(`Unexpected external contract denominator: ${repositories.length} repositories, ${count} files`);
  }
  return repositories;
}

function observeExternalContracts(source) {
  const repositories = parseExternalObservations(source).map((entry) => {
    const externalRoot = path.resolve(root, externalRoots[entry.repositoryId]);
    const currentFiles = entry.files.map((file) => {
      const absolute = path.join(externalRoot, ...file.path.split('/'));
      const currentContentSha256 = fs.existsSync(absolute) && fs.statSync(absolute).isFile()
        ? hashBytes(fs.readFileSync(absolute))
        : null;
      const declaredContentSha256 = file.sha256 ? `sha256:${file.sha256}` : null;
      return {
        path: file.path,
        package: file.package ?? null,
        version: file.version ?? null,
        declaredContentSha256,
        observedContentSha256: currentContentSha256,
        digestMatches: declaredContentSha256 !== null && currentContentSha256 === declaredContentSha256,
      };
    });
    const workingTree = runGit(['status', '--porcelain=v1', '--untracked-files=all'], externalRoot);
    return {
      repositoryId: entry.repositoryId,
      recordedRevision: entry.revision ?? null,
      observedRevision: runGit(['rev-parse', 'HEAD'], externalRoot),
      recordedWorkingTree: entry.workingTree ?? null,
      observedWorkingTree: workingTree === null ? 'UNKNOWN' : workingTree ? 'MODIFIED' : 'CLEAN',
      files: currentFiles,
    };
  });
  const contractMaterial = repositories.flatMap((repository) => repository.files.map((file) => ({
    repositoryId: repository.repositoryId,
    path: file.path,
    package: file.package,
    version: file.version,
    observedContentSha256: file.observedContentSha256,
  }))).sort((left, right) => `${left.repositoryId}/${left.path}`.localeCompare(`${right.repositoryId}/${right.path}`));
  return {
    repositories,
    totalFiles: repositories.reduce((total, entry) => total + entry.files.length, 0),
    digestMatches: repositories.flatMap((entry) => entry.files).filter((file) => file.digestMatches).length,
    digestMismatches: repositories.flatMap((entry) => entry.files).filter((file) => !file.digestMatches),
    providerRegistryFingerprint: hashValue({ schemaVersion: 'media.external-provider-contracts.v1', files: contractMaterial }),
  };
}

function phasePinComparison(currentFiles) {
  return ['pdp-0', 'pdp-1', 'pdp-2', 'pdp-3'].map((phaseName) => {
    const statusPath = `docs/implementation/${phaseName}-phase-dev-status.json`;
    const status = JSON.parse(fs.readFileSync(path.join(root, statusPath), 'utf8'));
    const comparisons = Object.entries(status.sourceShaSet ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(([sourcePath, recorded]) => {
      const current = currentFiles[sourcePath]?.digest ?? null;
      const recordedDigest = recorded.startsWith('sha256:') ? recorded : `sha256:${recorded}`;
      return {
        path: sourcePath,
        recordedDigest,
        currentDigest: current,
        disposition: current === null ? 'MISSING' : current === recordedDigest ? 'MATCH' : 'CHANGED',
      };
    });
    return {
      phase: status.phase,
      historicalStatus: status.status,
      historicalSourceCut: status.mainSha,
      historicalSourceShaSetCount: Object.keys(status.sourceShaSet ?? {}).length,
      historicalSourceShaSetFingerprint: hashValue(Object.entries(status.sourceShaSet ?? {}).sort(([left], [right]) => left.localeCompare(right))),
      sourceRecordCount: status.sourceRecordCount,
      historicalOutstandingMeaningIds: status.outstandingMeaningIds ?? [],
      currentPinCounts: {
        matched: comparisons.filter((entry) => entry.disposition === 'MATCH').length,
        changed: comparisons.filter((entry) => entry.disposition === 'CHANGED').length,
        missing: comparisons.filter((entry) => entry.disposition === 'MISSING').length,
      },
      pinComparisons: comparisons,
    };
  });
}

function buildFingerprints(topology, registryBytes, external) {
  const registryDigest = hashBytes(registryBytes);
  const ownerGraph = {
    schemaVersion: 'media.owner-graph.v1',
    surfaceRegistryDigest: registryDigest,
    physicalOwners: topology.manifestCandidates.map((entry) => ({
      surfaceId: entry.surfaceId,
      owner: entry.owner,
      disposition: entry.disposition,
      consumerSurfaceRefs: [...(entry.consumerSurfaceRefs ?? [])].sort(),
    })).sort((left, right) => left.surfaceId.localeCompare(right.surfaceId)),
    compositions: topology.compositions.map((entry) => ({
      surfaceId: entry.surfaceId,
      kind: entry.kind,
      children: [...(entry.children ?? [])].sort(),
    })).sort((left, right) => left.surfaceId.localeCompare(right.surfaceId)),
    consumers: topology.consumerCrosswalk.map((entry) => ({
      surfaceId: entry.surfaceId,
      registryAuthority: entry.registryAuthority ?? '.product-experience/surface-registry.yaml',
      physicalRefs: [...(entry.physicalRefs ?? [])].sort(),
    })).sort((left, right) => left.surfaceId.localeCompare(right.surfaceId)),
  };
  const physicalCatalog = {
    schemaVersion: 'media.physical-catalog.v1',
    surfaceRegistryDigest: registryDigest,
    manifestCandidates: topology.manifestCandidates,
    compositions: topology.compositions,
    consumerCrosswalk: topology.consumerCrosswalk,
  };
  return {
    ownerGraphFingerprint: hashValue(ownerGraph),
    physicalCatalogFingerprint: hashValue(physicalCatalog),
    providerRegistryFingerprint: external.providerRegistryFingerprint,
    fingerprintInputs: {
      ownerGraph,
      physicalCatalog,
      providerRegistryFingerprintBasis: 'Exact observed bytes for the 30 external contract files listed by source-manifest.yaml; repository revisions and dirty state remain diagnostics.',
    },
  };
}

function cellMaterialFingerprint(cell) {
  return hashValue({
    schemaVersion: 'media.pdp0-phase-cell-material.v1',
    cellId: cell.cellId,
    phase: cell.phase,
    applicability: cell.applicability,
    meaningRefs: cell.meaningRefs,
    ownerGraphFingerprint: cell.ownerGraphFingerprint,
    physicalCatalogFingerprint: cell.physicalCatalogFingerprint,
    providerRegistryFingerprint: cell.providerRegistryFingerprint,
    expectedPaths: cell.expectedPaths,
    fileContentDigests: cell.fileContentDigests,
  });
}

function compactCellEvidence(cell, sharedPaths) {
  const { fileContentDigests, expectedPaths, mappings, ...details } = cell;
  const summarizedMappings = { ...mappings };
  delete summarizedMappings.topologyRecord;
  return {
    ...details,
    expectedPathCount: expectedPaths.length,
    additionalExpectedPaths: expectedPaths.filter((sourcePath) => !sharedPaths.has(sourcePath)),
    expectedPathSetFingerprint: hashValue(expectedPaths),
    mappings: summarizedMappings,
  };
}

function main() {
  const topologyPath = '.product-experience/surfaces/media-physical-topology.v1.json';
  const registryPath = '.product-experience/surface-registry.yaml';
  const sourceManifestPath = '.product-experience/source-manifest.yaml';
  const topology = JSON.parse(fs.readFileSync(path.join(root, topologyPath), 'utf8'));
  const registryBytes = fs.readFileSync(path.join(root, registryPath));
  const sourceManifest = fs.readFileSync(path.join(root, sourceManifestPath), 'utf8');
  const external = observeExternalContracts(sourceManifest);
  const fingerprints = buildFingerprints(topology, registryBytes, external);
  const resolved = resolveMediaPdp0Cells(root, fingerprints);
  const currentness = observeMediaDiscoveryCurrentness(root, resolved.cells);
  const consistencyCaptures = [
    captureRepositorySourceCurrentness(root, fingerprints),
    captureRepositorySourceCurrentness(root, fingerprints),
  ];
  const consistencyStable = consistencyCaptures.every(isRepositorySourceCurrentness)
    && consistencyCaptures.every((capture) => capture.sourceToken === currentness.sourceToken
      && capture.journal?.continuity === 'CONTINUOUS'
      && capture.journal?.changedPaths?.length === 0
      && capture.journal?.membershipChangeState === 'KNOWN'
      && capture.journal?.membershipAdditions?.length === 0
      && capture.journal?.membershipRemovals?.length === 0
      && capture.journal?.externalChanges?.length === 0);
  const fullCurrentFiles = consistencyCaptures.every(isRepositorySourceCurrentness)
    ? consistencyCaptures[1].fileContentDigests
    : {};
  const historicalPinComparisons = phasePinComparison(fullCurrentFiles);
  const p0Comparison = historicalPinComparisons.find((entry) => entry.phase === 'PDP-0');
  const allCellsCurrent = currentness.cells.length === resolved.denominator.totalCells
    && currentness.cells.every((cell) => cell.sourceCurrentness === 'CURRENT');
  const externalContractsCurrent = external.digestMismatches.length === 0;
  const currentCellRecords = currentness.cells.map((cell) => ({
    ...cell,
    sourceSetFingerprint: cellMaterialFingerprint(cell),
  }));
  const sharedPathSet = new Set(currentCellRecords[0]?.expectedPaths ?? []);
  for (const cell of currentCellRecords.slice(1)) {
    for (const sourcePath of [...sharedPathSet]) {
      if (!cell.expectedPaths.includes(sourcePath)) sharedPathSet.delete(sourcePath);
    }
  }
  const sharedMaterialPaths = [...sharedPathSet].sort();
  const sourceContentDigests = {};
  for (const cell of currentCellRecords) {
    for (const [sourcePath, record] of Object.entries(cell.fileContentDigests)) {
      if (sourceContentDigests[sourcePath] && sourceContentDigests[sourcePath] !== record) {
        throw new Error(`Conflicting Lifecycle digest observations for ${sourcePath}`);
      }
      sourceContentDigests[sourcePath] = record;
    }
  }
  const materialSourceSetFingerprint = hashValue({
    schemaVersion: 'media.pdp0-material-source-set.v1',
    cells: currentCellRecords.map((cell) => ({ cellId: cell.cellId, sourceSetFingerprint: cell.sourceSetFingerprint }))
      .sort((left, right) => left.cellId.localeCompare(right.cellId)),
  });
  const initialGitStatus = runGit(['status', '--porcelain=v1', '--untracked-files=all']) ?? 'UNKNOWN';
  const existing = fs.existsSync(path.join(root, outputPath))
    ? JSON.parse(fs.readFileSync(path.join(root, outputPath), 'utf8'))
    : null;
  const historicalDriftClassifications = [
    { path: '.product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md', classification: 'STATUS TEXT AND DOC LINK ONLY OBSERVED', authorityRef: 'MDO-02' },
    { path: 'docs/PRODUCT-DEFINITION-COVERAGE.md', classification: 'STATUS AND COVERAGE PROJECTION ONLY OBSERVED', authorityRef: 'MDO-03' },
    { path: '.product-experience/artifact-identities.yaml', classification: 'SOURCE INVENTORY ADDITIONS OBSERVED', authorityRef: 'MDO-03' },
    { path: '.product-experience/gaps.yaml', classification: 'DATED DISPOSITION AND HISTORICAL GAP WORDING OBSERVED', authorityRef: 'MDO-03' },
    { path: 'apps/media-experience-explorer/specification-artifacts.json', classification: 'GENERATED EXPLORER ARTIFACT INDEX OBSERVED', authorityRef: 'MDO-03' },
    { path: '.product-experience/source-manifest.yaml', classification: 'GENERATED SOURCE INDEX AND EXTERNAL OBSERVATIONS OBSERVED', authorityRef: 'MDO-03' },
  ];
  const classifiedPdp0Paths = new Set(historicalDriftClassifications.map((entry) => entry.path));
  const unclassifiedHistoricalPdp0PinChanges = p0Comparison.pinComparisons
    .filter((entry) => entry.disposition !== 'MATCH' && !classifiedPdp0Paths.has(entry.path));
  const requiredPdp0Sources = [registryPath, topologyPath].map((sourcePath) => ({
    path: sourcePath,
    currentDigest: fullCurrentFiles[sourcePath]?.digest ?? null,
    historicalPin: Object.hasOwn(JSON.parse(fs.readFileSync(path.join(root, 'docs/implementation/pdp-0-phase-dev-status.json'), 'utf8')).sourceShaSet, sourcePath),
  }));
  const sourceCurrent = consistencyStable && allCellsCurrent && externalContractsCurrent
    && unclassifiedHistoricalPdp0PinChanges.length === 0
    && requiredPdp0Sources.every((entry) => entry.currentDigest !== null);
  const observation = {
    schemaVersion: 'media.discovery-pdp0-currentness-observation.v1',
    observationId: 'MEDIA-PDP0-CURRENTNESS-2026-10-13',
    observedAt: existing?.observedAt ?? new Date().toISOString(),
    campaign: {
      repository: 'samujjwal/ghatana-media',
      branch: runGit(['branch', '--show-current']),
      observedHead: runGit(['rev-parse', 'HEAD']),
      observedOriginMain: runGit(['rev-parse', 'origin/main']),
      observedRemoteMain: runGit(['ls-remote', 'origin', 'refs/heads/main'])?.split(/\s+/u)[0] ?? null,
      worktreeStatusAtCapture: initialGitStatus,
      scope: 'Repository-wide Discovery; active phase PDP-0 only.',
      reviewedPlanBaseline: '90065c229debe88ca2143e58cad708d5ebc83cf5',
    },
    authority: {
      ownerDecisionId: 'MEDIA-DISCOVERY-CURRENTNESS-OWNER-2026-10-13',
      ownerDecisionRef: '.product-experience/reviews/2026-10-13-pdp0-discovery-delegated-review.md',
      semanticReviewRef: '.product-experience/reviews/2026-10-13-pdp0-discovery-delegated-review.md#MDO-01',
      changedMeaningIds: [],
      historicalDefinitionStatusesRemainReadOnly: true,
    },
    denominators: resolved.denominator,
    historicalPhaseStatusComparison: historicalPinComparisons,
    historicalPdp0PinDriftClassifications: historicalDriftClassifications.map((classification) => ({
      ...classification,
      ...p0Comparison.pinComparisons.find((entry) => entry.path === classification.path),
    })),
    unclassifiedHistoricalPdp0PinChanges,
    requiredPdp0SourceMembership: requiredPdp0Sources,
    externalOwnerContracts: {
      ...external,
      interpretation: 'Exact contract-file digests are material inputs; repository revisions and dirty state are diagnostics only when declared contract bytes match.',
    },
    lifecycleSourceCurrentness: {
      authoritySchema: currentness.authoritySchema,
      captureModel: currentness.captureModel,
      continuity: currentness.continuity,
      pathMembershipDigest: currentness.pathMembershipDigest,
      consistencyStable,
      zeroWorkEligibleAtCapture: currentness.zeroWorkEligible,
      blockers: [...new Set([...currentness.blockers, ...(consistencyStable ? [] : ['POST_CAPTURE_SOURCE_OR_LIFECYCLE_STATE_CHANGED'])])],
      note: 'The Lifecycle full-repository content fingerprint and token are intentionally omitted from this generated record to avoid recursively pinning the observation file; each phase cell retains the exact Lifecycle file digests and its material-set fingerprint.',
    },
    materialPathDenominator: {
      uniquePaths: Object.keys(sourceContentDigests).length,
      sharedPaths: sharedMaterialPaths.length,
      cellSpecificPaths: Object.keys(sourceContentDigests).length - sharedMaterialPaths.length,
    },
    sharedMaterialPaths,
    sourceContentDigests,
    physicalCompositeConsumerCells: currentCellRecords.map((cell) => compactCellEvidence(cell, sharedPathSet)),
    materialSourceSetFingerprint,
    phaseDisposition: {
      historicalDefinitionStatus: 'DEV_COMPLETE',
      historicalOutstandingMeaningIds: [],
      currentSourceCurrentness: sourceCurrent ? 'PASS' : 'FAIL',
      sourceCurrent,
      ownerAcceptance: 'NOT_OBTAINED',
      pdp0Exit: sourceCurrent ? 'BLOCKED_PENDING_OWNER_ACCEPTANCE' : 'FAIL_SOURCE_CURRENTNESS',
      discoveryBarrier: 'FAIL_PDP0_OWNER_ACCEPTANCE_PENDING_AND_PDP1_PDP3_NOT_VALIDATED',
      build: 'NOT_ENTERED',
      pdpClosure: 'NOT_ENTERED',
      delivery: 'BLOCKED',
    },
    limitations: [
      'The historical PDP-0 DEV_COMPLETE record remains anchored at its recorded source cut and is not rewritten.',
      'This observation does not assert independent semantic acceptance, Lifecycle closure, Build entry, or Delivery readiness.',
      'Later PDP phases remain unvalidated until the PDP-0 exit gate is formally accepted.',
    ],
  };
  const destination = path.join(root, outputPath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(observation, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    outputPath,
    sourceCurrent,
    sourceCellCurrentCount: currentness.cells.filter((cell) => cell.sourceCurrentness === 'CURRENT').length,
    sourceCellUnknownCount: currentness.cells.filter((cell) => cell.sourceCurrentness === 'UNKNOWN').length,
    historicalPdp0PinCounts: p0Comparison.currentPinCounts,
    externalContractCounts: { total: external.totalFiles, matched: external.digestMatches, mismatched: external.digestMismatches.length },
    consistencyStable,
    blockers: observation.lifecycleSourceCurrentness.blockers,
    pdp0Exit: observation.phaseDisposition.pdp0Exit,
  }, null, 2)}\n`);
}

main();
