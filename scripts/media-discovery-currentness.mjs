import fs from 'node:fs';
import { projectHistoricalMediaTopology } from './lib/media-historical-topology-projection.mjs';
import path from 'node:path';
import {
  captureRepositorySourceCurrentness,
  isRepositorySourceCurrentness,
} from '@ghatana/verification-planner';

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const SCHEMA = 'ghatana.repository-source-currentness.v1';

/**
 * Capture Lifecycle's persistent repository-wide source snapshot, then project
 * its authoritative digests and changed paths onto exact Media phase cells.
 * This is root-wide Lifecycle continuity plus exact per-cell projection; it
 * does not issue Media DEV_COMPLETE, acceptance, closure, Build, or Delivery.
 */
export function observeMediaDiscoveryCurrentness(repositoryRoot, cells, {
  capture = captureRepositorySourceCurrentness,
} = {}) {
  const root = path.resolve(repositoryRoot);
  const normalized = normalizeCells(cells);
  const dimensions = requiredDimensions(normalized);
  const first = capture(root, dimensions);
  const second = capture(root, dimensions);
  const blockers = [];

  if (!isUsableCapture(first) || !isUsableCapture(second)) blockers.push('LIFECYCLE_CAPTURE_UNKNOWN');
  if (first?.journal?.continuity !== 'CONTINUOUS' || second?.journal?.continuity !== 'CONTINUOUS') {
    blockers.push('LIFECYCLE_CONTINUITY_RESET_OR_UNKNOWN');
  }
  if (first?.metrics?.snapshotScope !== 'REPOSITORY_SCOPE' || second?.metrics?.snapshotScope !== 'REPOSITORY_SCOPE') {
    blockers.push('LIFECYCLE_ROOT_WIDE_PERSISTENT_CAPTURE_REQUIRED');
  }
  if (first?.sourceToken !== second?.sourceToken
      || first?.contentFingerprint !== second?.contentFingerprint
      || first?.pathMembershipDigest !== second?.pathMembershipDigest) {
    blockers.push('SOURCE_RACE_DURING_CAPTURE');
  }
  if (first?.journal?.membershipChangeState !== 'KNOWN' || second?.journal?.membershipChangeState !== 'KNOWN') {
    blockers.push('SOURCE_MEMBERSHIP_UNKNOWN');
  }
  if ([first, second].some((captureResult) =>
    (captureResult?.journal?.membershipAdditions?.length ?? 0) > 0
      || (captureResult?.journal?.membershipRemovals?.length ?? 0) > 0)) {
    blockers.push('UNEXPECTED_REPOSITORY_MEMBERSHIP_CHANGE');
  }
  if ([first, second].some((captureResult) => (captureResult?.journal?.externalChanges?.length ?? 0) > 0)) {
    blockers.push('EXTERNAL_FINGERPRINT_CHANGE_SINCE_PRIOR_CAPTURE');
  }
  for (const dimension of ['ownerGraphFingerprint', 'physicalCatalogFingerprint', 'providerRegistryFingerprint']) {
    if (!DIGEST.test(first?.[dimension] ?? '') || !DIGEST.test(second?.[dimension] ?? '')) {
      blockers.push(`MISSING_OR_INVALID_${dimension.replace(/[A-Z]/gu, (letter) => `_${letter}`).toUpperCase()}`);
    }
  }

  const digestMap = second?.fileContentDigests ?? {};
  const changed = new Set([
    ...(first?.journal?.changedPaths ?? []),
    ...(second?.journal?.changedPaths ?? []),
  ]);
  const projectedCells = normalized.map((cell) => {
    const missingPaths = cell.paths.filter((sourcePath) => !Object.hasOwn(digestMap, sourcePath));
    const invalidPaths = cell.paths.filter((sourcePath) => !DIGEST.test(digestMap[sourcePath]?.digest ?? ''));
    const projected = Object.fromEntries(cell.paths
      .filter((sourcePath) => Object.hasOwn(digestMap, sourcePath))
      .sort()
      .map((sourcePath) => [sourcePath, digestMap[sourcePath].digest]));
    const projectedChanges = [...changed].filter((sourcePath) => cell.pathSet.has(sourcePath)).sort();
    const unexpectedPaths = Object.keys(projected).filter((sourcePath) => !cell.pathSet.has(sourcePath));
    const cellBlockers = [];
    if (missingPaths.length) cellBlockers.push('EXPECTED_SOURCE_PATH_MISSING');
    if (invalidPaths.length) cellBlockers.push('INVALID_SOURCE_DIGEST');
    if (unexpectedPaths.length) cellBlockers.push('UNEXPECTED_SOURCE_MEMBERSHIP');
    // A stable content edit is evidence that the current cut changed, not
    // proof that the edit is harmless. Owner classifications are recorded in
    // the separate reconciliation observation; this adapter never accepts
    // caller-supplied strings as authority to call changed material current.
    if (projectedChanges.length) cellBlockers.push('SOURCE_PATH_CHANGED_SINCE_PRIOR_CAPTURE');
    if (blockers.length) cellBlockers.push(...blockers);
    return {
      cellId: cell.cellId,
      surfaceId: cell.surfaceId,
      cellType: cell.cellType,
      phase: cell.phase,
      ownerGraphFingerprint: cell.ownerGraphFingerprint,
      physicalCatalogFingerprint: cell.physicalCatalogFingerprint,
      providerRegistryFingerprint: cell.providerRegistryFingerprint,
      applicability: cell.applicability,
      meaningRefs: cell.meaningRefs,
      mappings: cell.mappings,
      expectedPaths: [...cell.paths],
      fileContentDigests: projected,
      changedPaths: projectedChanges,
      sourceCurrentness: cellBlockers.length ? 'UNKNOWN' : 'CURRENT',
      zeroWorkEligible: projectedChanges.length === 0
        && cellBlockers.length === 0
        && second?.zeroWorkEligible === true,
      blockers: [...new Set(cellBlockers)],
    };
  });
  const currentnessUnknown = blockers.length > 0 || projectedCells.some((cell) => cell.sourceCurrentness === 'UNKNOWN');

  return {
    schemaVersion: 'ghatana.media-discovery-currentness-observation.v1',
    authoritySchema: SCHEMA,
    captureModel: 'ROOT_WIDE_LIFECYCLE_CONTINUITY_WITH_EXACT_PER_CELL_PROJECTION',
    sourceToken: isUsableCapture(second) ? second.sourceToken : null,
    contentFingerprint: isUsableCapture(second) ? second.contentFingerprint : null,
    pathMembershipDigest: isUsableCapture(second) ? second.pathMembershipDigest : null,
    continuity: blockers.length ? 'UNKNOWN' : second.journal.continuity,
    zeroWorkEligible: !currentnessUnknown
      && projectedCells.every((cell) => cell.zeroWorkEligible)
      && second.zeroWorkEligible === true,
    blockers: [...new Set(blockers)],
    lanes: {
      DEFINITION_DEV_STATUS: 'NOT_EVALUATED',
      SOURCE_CURRENTNESS: currentnessUnknown ? 'UNKNOWN' : 'OBSERVED',
      INDEPENDENT_ACCEPTANCE: 'NOT_EVALUATED',
      LIFECYCLE_CLOSURE: 'NOT_EVALUATED',
      BUILD: 'NOT_EVALUATED',
      DELIVERY: 'NOT_EVALUATED',
    },
    cells: projectedCells,
  };
}

/**
 * Build the finite PDP-0 inventory from Media's historical source cut and
 * current Media-owned physical/composite/consumer topology. This resolves
 * bindings only; it does not validate or publish a phase status.
 */
export function resolveMediaPdp0Cells(repositoryRoot, {
  ownerGraphFingerprint,
  physicalCatalogFingerprint,
  providerRegistryFingerprint,
  campaignScope = 'recorder-studio-successor',
} = {}) {
  const root = path.resolve(repositoryRoot);
  const statusPath = 'docs/implementation/pdp-0-phase-dev-status.json';
  const topologyPath = '.product-experience/surfaces/media-physical-topology.v1.json';
  const registryPath = '.product-experience/surface-registry.yaml';
  const ownerDecisionPath = '.product-experience/reviews/2026-10-13-pdp0-discovery-delegated-review.md';
  const status = readJson(root, statusPath);
 
  // New Recorder/Studio successor defaults to 55 exact cells.
  // Historical R15/R30/R19 are immutable 50-cell observations and cannot issue
  // current phase acceptance for the new population by selecting that subset.
  const currentTopology = readJson(root, topologyPath);
  if (!['historical', 'recorder-studio-successor'].includes(campaignScope)) {
    throw new TypeError('Unknown Media Discovery campaign scope');
  }
  const topology = campaignScope === 'historical'
    ? projectHistoricalMediaTopology(currentTopology)
    : currentTopology;
  const registry = readText(root, registryPath);
  const ownerDecision = readText(root, ownerDecisionPath);
  if (status.phase !== 'PDP-0' || !status.sourceShaSet || typeof status.sourceShaSet !== 'object') {
    throw new TypeError('Historical PDP-0 sourceShaSet is unavailable or invalid');
  }
  if (!ownerDecision.includes('MDO-07') || !ownerDecision.includes('APPROVE generic currentness approach')) {
    throw new TypeError('The approved PDP-0 currentness owner decision is missing');
  }
  const physical = topology.manifestCandidates;
  const compositions = topology.compositions;
  const consumers = topology.consumerCrosswalk;
  if (!Array.isArray(physical) || !Array.isArray(compositions) || !Array.isArray(consumers)) {
    throw new TypeError('Media physical topology is missing candidate, composition, or consumer inventory');
  }
  if (physical.length !== 26 || compositions.length !== (campaignScope === 'historical' ? 7 : 8) || consumers.length !== (campaignScope === 'historical' ? 17 : 21)) {
    throw new TypeError(`Unexpected Media PDP-0 denominator: physical=${physical.length}, composition+root=${compositions.length}, consumers=${consumers.length}`);
  }

  const physicalById = uniqueById(physical, 'physical candidate');
  const compositionsById = uniqueById(compositions, 'composition');
  uniqueById(consumers, 'consumer');
  if ([...compositionsById.values()].filter((entry) => entry.kind === 'SEMANTIC_COMPOSITION').length !== (campaignScope === 'historical' ? 6 : 7)
      || [...compositionsById.values()].filter((entry) => entry.kind === 'REPOSITORY_ROOT').length !== 1) {
    throw new TypeError('Media PDP-0 requires the campaign-scoped semantic compositions and one repository root');
  }
  const consumersById = new Map(consumers.map((entry) => [entry.surfaceId, entry]));
  for (const consumer of consumers) {
    for (const physicalId of consumer.physicalRefs ?? []) {
      const candidate = physicalById.get(physicalId);
      if (!candidate || !candidate.consumerSurfaceRefs?.includes(consumer.surfaceId)) {
        throw new TypeError(`Consumer/physical inverse mapping mismatch: ${consumer.surfaceId} <-> ${physicalId}`);
      }
    }
    if (!registry.includes(`surfaceId: ${consumer.surfaceId}`)) {
      throw new TypeError(`Consumer is absent from surface registry: ${consumer.surfaceId}`);
    }
  }
  for (const candidate of physical) {
    for (const consumerId of candidate.consumerSurfaceRefs ?? []) {
      if (!consumersById.get(consumerId)?.physicalRefs?.includes(candidate.surfaceId)) {
        throw new TypeError(`Physical/consumer inverse mapping mismatch: ${candidate.surfaceId} <-> ${consumerId}`);
      }
    }
  }

  const sharedPaths = [...new Set([
    ...Object.keys(status.sourceShaSet),
    registryPath,
    topologyPath,
    statusPath,
    ownerDecisionPath,
  ])].sort();
  const dimensions = { ownerGraphFingerprint, physicalCatalogFingerprint, providerRegistryFingerprint };
  const cells = [];
  const addCell = ({ surfaceId, cellType, phaseApplicability, paths, meaningRefs = {}, mappings = {} }) => {
    const applicability = phaseApplicability?.['PDP-0'];
    if (!applicability || typeof applicability.disposition !== 'string' || !applicability.disposition
        || typeof applicability.rationale !== 'string' || !applicability.rationale.trim()) {
      throw new TypeError(`PDP-0 applicability disposition/rationale is missing for ${surfaceId}`);
    }
    cells.push({
      cellId: `${surfaceId}:PDP-0`,
      surfaceId,
      cellType,
      phase: 'PDP-0',
      paths: [...new Set([...sharedPaths, ...paths])].sort(),
      applicability: structuredClone(applicability),
      meaningRefs: structuredClone(meaningRefs),
      mappings,
      ...dimensions,
    });
  };
  const consumerPathsById = new Map();
  const physicalMeaningRefsById = new Map();
  for (const candidate of physical) {
    const paths = [candidate.manifestPath].filter(Boolean);
    const meaningRefs = meaningRefsForApplicability(candidate.phaseApplicability?.['PDP-0']);
    physicalMeaningRefsById.set(candidate.surfaceId, meaningRefs);
    addCell({
      surfaceId: candidate.surfaceId,
      cellType: 'PHYSICAL_CANDIDATE',
      phaseApplicability: candidate.phaseApplicability,
      paths,
      meaningRefs,
      mappings: {
        topologyRecord: structuredClone(candidate),
        disposition: candidate.disposition,
        dispositionRationale: candidate.dispositionRationale,
        owner: candidate.owner,
        publicBoundaryRef: candidate.publicBoundaryRef,
        consumerSurfaceRefs: [...(candidate.consumerSurfaceRefs ?? [])],
      },
    });
  }
  for (const consumer of consumers) {
    const registryAuthority = consumer.registryAuthority ?? registryPath;
    const registryRecord = registryRecordFor(registry, consumer.surfaceId);
    const applicablePdpArtifacts = parseInlineList(registryRecord, 'applicablePdpArtifacts');
    const sourceContracts = [...(consumer.sourceContracts ?? [])];
    const handlerSourcePath = consumer.handlerSourceObservation?.sourcePath;
    const handlerPaths = handlerSourcePath ? filesAtRef(root, handlerSourcePath) : [];
    const paths = [registryAuthority, ...sourceContracts.flatMap((sourceRef) => filesAtRef(root, sourceRef)), ...handlerPaths];
    consumerPathsById.set(consumer.surfaceId, paths);
    const meaningRefs = mergeMeaningRefs((consumer.physicalRefs ?? []).map((physicalId) => physicalMeaningRefsById.get(physicalId) ?? {}));
    addCell({
      surfaceId: consumer.surfaceId,
      cellType: 'CONSUMER',
      phaseApplicability: { 'PDP-0': {
        disposition: applicablePdpArtifacts.includes('PDP-0') ? 'APPLICABLE_CONSUMER' : 'NOT_APPLICABLE',
        authorityRef: registryAuthority,
        rationale: applicablePdpArtifacts.includes('PDP-0')
          ? `PDP-0 consumer applicability is explicitly listed in ${registryAuthority}.`
          : `PDP-0 is absent from applicablePdpArtifacts in ${registryAuthority}.`,
        applicablePdpArtifacts,
        physicalRefs: [...(consumer.physicalRefs ?? [])],
      } },
      paths,
      meaningRefs,
      mappings: {
        topologyRecord: structuredClone(consumer),
        consumerType: consumer.consumerType,
        bindingState: consumer.bindingState,
        statusReason: consumer.statusReason,
        registryAuthority,
        registryRecord,
        physicalRefs: [...(consumer.physicalRefs ?? [])],
        sourceContracts,
        handlerSourceObservation: consumer.handlerSourceObservation ?? null,
      },
    });
  }

  const compositionPathsById = new Map();
  const compositionMeaningRefsById = new Map();
  const resolving = new Set();
  const resolveComposition = (surfaceId) => {
    if (compositionPathsById.has(surfaceId)) return compositionPathsById.get(surfaceId);
    const composition = compositionsById.get(surfaceId);
    if (!composition) throw new TypeError(`Unknown physical/composition child in Media topology: ${surfaceId}`);
    if (resolving.has(surfaceId)) throw new TypeError(`Cycle in Media composition topology at ${surfaceId}`);
    resolving.add(surfaceId);
    const paths = [];
    const meaningRefs = [];
    for (const childId of composition.children ?? []) {
      const candidate = physicalById.get(childId);
      if (candidate) {
        if (candidate.manifestPath) paths.push(candidate.manifestPath);
        meaningRefs.push(physicalMeaningRefsById.get(childId) ?? {});
        for (const consumerId of candidate.consumerSurfaceRefs ?? []) paths.push(...(consumerPathsById.get(consumerId) ?? []));
        continue;
      }
      const childComposition = compositionsById.get(childId);
      if (!childComposition) throw new TypeError(`Unknown physical/composition child in Media topology: ${childId}`);
      paths.push(...resolveComposition(childId));
      meaningRefs.push(compositionMeaningRefsById.get(childId) ?? {});
    }
    resolving.delete(surfaceId);
    const uniquePaths = [...new Set(paths)].sort();
    const mergedMeaningRefs = mergeMeaningRefs(meaningRefs);
    compositionPathsById.set(surfaceId, uniquePaths);
    compositionMeaningRefsById.set(surfaceId, mergedMeaningRefs);
    return uniquePaths;
  };
  for (const composition of compositions) resolveComposition(composition.surfaceId);

  const allPdp0MaterialPaths = [...new Set([
    ...physical.flatMap((candidate) => candidate.manifestPath ? [candidate.manifestPath] : []),
    ...[...consumerPathsById.values()].flat(),
    ...sharedPaths,
  ])].sort();
  const allMeaningRefs = mergeMeaningRefs([...physicalMeaningRefsById.values()]);
  for (const composition of compositions) {
    const isRoot = composition.kind === 'REPOSITORY_ROOT';
    addCell({
      surfaceId: composition.surfaceId,
      cellType: isRoot ? 'REPOSITORY_ROOT' : 'SEMANTIC_COMPOSITION',
      phaseApplicability: composition.phaseApplicability,
      paths: isRoot ? allPdp0MaterialPaths : compositionPathsById.get(composition.surfaceId),
      meaningRefs: isRoot ? allMeaningRefs : compositionMeaningRefsById.get(composition.surfaceId),
      mappings: { topologyRecord: structuredClone(composition), kind: composition.kind, children: [...(composition.children ?? [])] },
    });
  }

  return {
    schemaVersion: 'ghatana.media-pdp0-cell-resolution.v1',
    basis: {
      campaignScope,
      historicalPhaseStatus: statusPath,
      historicalSourceShaSetCount: Object.keys(status.sourceShaSet).length,
      surfaceRegistry: registryPath,
      physicalTopology: topologyPath,
      ownerDecision: ownerDecisionPath,
    },
    denominator: { physicalCandidates: physical.length, semanticCompositions: campaignScope === 'historical' ? 6 : 7, repositoryRoots: 1, consumers: consumers.length, totalCells: cells.length },
    cells,
  };
}

function normalizeCells(cells) {
  if (!Array.isArray(cells) || cells.length === 0) throw new TypeError('At least one Media phase cell is required');
  const ids = new Set();
  return cells.map((cell) => {
    if (!cell || typeof cell !== 'object') throw new TypeError('Each Media phase cell must be an object');
    const cellId = requiredText(cell.cellId, 'cellId');
    const surfaceId = requiredText(cell.surfaceId, 'surfaceId');
    const phase = requiredText(cell.phase, 'phase');
    if (ids.has(cellId)) throw new TypeError(`Duplicate Media phase cell: ${cellId}`);
    ids.add(cellId);
    if (!Array.isArray(cell.paths) || cell.paths.length === 0) throw new TypeError(`${cellId} requires exact material paths`);
    const paths = cell.paths.map((value) => {
      const sourcePath = requiredText(value, `${cellId}.path`).replaceAll('\\', '/');
      if (path.posix.isAbsolute(sourcePath) || sourcePath.split('/').some((part) => part === '..' || part === '.' || part === '')) {
        throw new TypeError(`${cellId} has a non-canonical repository-relative path: ${sourcePath}`);
      }
      return sourcePath;
    });
    if (new Set(paths).size !== paths.length) throw new TypeError(`${cellId} has duplicate expected paths`);
    return {
      cellId, surfaceId, phase, paths, pathSet: new Set(paths),
      cellType: cell.cellType ?? null,
      applicability: cell.applicability ?? null,
      meaningRefs: cell.meaningRefs ?? {},
      mappings: cell.mappings ?? {},
      ownerGraphFingerprint: cell.ownerGraphFingerprint,
      physicalCatalogFingerprint: cell.physicalCatalogFingerprint,
      providerRegistryFingerprint: cell.providerRegistryFingerprint,
    };
  });
}

function requiredDimensions(cells) {
  const values = {};
  for (const key of ['ownerGraphFingerprint', 'physicalCatalogFingerprint', 'providerRegistryFingerprint']) {
    const fingerprints = new Set(cells.map((cell) => cell[key]));
    if (fingerprints.size !== 1 || !DIGEST.test([...fingerprints][0] ?? '')) {
      throw new TypeError(`Every cell must provide the same valid ${key} SHA-256 fingerprint`);
    }
    values[key] = [...fingerprints][0];
  }
  return values;
}

function isUsableCapture(value) {
  return value?.schemaVersion === SCHEMA
    && value.status !== 'UNKNOWN'
    && value.journal?.continuity !== 'UNKNOWN'
    && value.journal?.resetReason !== 'SOURCE_CURRENTNESS_PERSIST_FAILED'
    && value.metrics?.snapshotScope === 'REPOSITORY_SCOPE'
    && isRepositorySourceCurrentness(value)
    && value.fileContentDigests && typeof value.fileContentDigests === 'object';
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} is required`);
  return value.trim();
}

function readJson(root, sourcePath) {
  return JSON.parse(readText(root, sourcePath));
}

function readText(root, sourcePath) {
  return fs.readFileSync(path.join(root, sourcePath), 'utf8');
}

function uniqueById(entries, label) {
  const result = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.surfaceId !== 'string' || result.has(entry.surfaceId)) {
      throw new TypeError(`Missing or duplicate ${label} surfaceId`);
    }
    result.set(entry.surfaceId, entry);
  }
  return result;
}

function registryRecordFor(registry, surfaceId) {
  const marker = `  - surfaceId: ${surfaceId}`;
  const start = registry.indexOf(marker);
  if (start < 0) throw new TypeError(`Consumer is absent from surface registry: ${surfaceId}`);
  const next = registry.indexOf('\n  - surfaceId:', start + marker.length);
  return registry.slice(start, next < 0 ? undefined : next).trimEnd();
}

function parseInlineList(record, field) {
  const match = record.match(new RegExp(`^\\s+${field}: \\[([^\\]]*)\\]\\s*$`, 'mu'));
  if (!match) return [];
  return match[1].split(',').map((value) => value.trim()).filter(Boolean);
}

function meaningRefsForApplicability(applicability = {}) {
  return {
    capabilityFamilyIds: [...(applicability.capabilityFamilyIds ?? [])],
    capabilityIntentIds: [...(applicability.capabilityIntentIds ?? [])],
    requirementIds: [...(applicability.requirementIds ?? [])],
    intentIds: [...(applicability.intentIds ?? [])],
  };
}

function mergeMeaningRefs(entries) {
  const keys = ['capabilityFamilyIds', 'capabilityIntentIds', 'requirementIds', 'intentIds'];
  return Object.fromEntries(keys.map((key) => [key, [...new Set(entries.flatMap((entry) => entry?.[key] ?? []))].sort()]));
}

function filesAtRef(root, sourceRef) {
  const repositoryPath = sourceRef.split('#', 1)[0];
  const absolute = path.join(root, repositoryPath);
  try {
    const stat = fs.statSync(absolute);
    if (stat.isFile()) return [repositoryPath];
    if (!stat.isDirectory()) return [repositoryPath];
    const files = [];
    const visit = (directory, relative) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const nextRelative = `${relative}/${entry.name}`;
        const nextAbsolute = path.join(directory, entry.name);
        if (entry.isFile()) files.push(nextRelative);
        else if (entry.isDirectory()) visit(nextAbsolute, nextRelative);
      }
    };
    visit(absolute, repositoryPath);
    return files.length ? files : [repositoryPath];
  } catch {
    return [repositoryPath];
  }
}
