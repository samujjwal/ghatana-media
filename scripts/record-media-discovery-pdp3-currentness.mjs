#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { observeMediaDiscoveryCurrentness } from './media-discovery-currentness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireTools = createRequire(path.resolve(root, '../ghatana-tools/package.json'));
const parseYaml = requireTools('yaml').parse;
const R5_PATH = 'docs/implementation/observations/media-discovery-pdp3-mdc30-implementation-progress-2026-10-14-r5.json';
const STATUS_PATH = 'docs/implementation/pdp-3-phase-dev-status.json';
const MATRIX_PATH = 'docs/implementation/media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json';
const TOPOLOGY_PATH = '.product-experience/surfaces/media-physical-topology.v1.json';
const REGISTRY_PATH = '.product-experience/surface-registry.yaml';
const SOURCE_MANIFEST_PATH = '.product-experience/source-manifest.yaml';
const CHANNEL_PATH = '.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml';
const OWNER_PACKET_PATH = 'docs/implementation/observations/media-discovery-pdp3-owner-binding-directions-2026-10-13.json';
const PURPOSE_PATH = '.product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml';
const ORACLE_PATH = '.product-experience/pdp-3-product-experience/step-definition-oracles.yaml';
const COMMON_PATHS = [R5_PATH, STATUS_PATH, MATRIX_PATH, TOPOLOGY_PATH, REGISTRY_PATH, SOURCE_MANIFEST_PATH,
  CHANNEL_PATH, OWNER_PACKET_PATH, PURPOSE_PATH, ORACLE_PATH];
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

const hashBytes = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const hashValue = (value) => hashBytes(Buffer.from(JSON.stringify(value)));
const readJson = (repositoryRoot, sourcePath) => JSON.parse(fs.readFileSync(path.join(repositoryRoot, sourcePath), 'utf8'));
const readYaml = (repositoryRoot, sourcePath) => parseYaml(fs.readFileSync(path.join(repositoryRoot, sourcePath), 'utf8'));

function requireUnique(rows, identity, label) {
  if (!Array.isArray(rows) || rows.some((row) => typeof identity(row) !== 'string' || !identity(row).trim())) {
    throw new Error(`${label} contains a missing identity`);
  }
  const ids = rows.map(identity);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate identities`);
  return ids;
}

/** Pure denominator check used by the recorder and fixture tests. */
export function validatePdp3CurrentnessDenominators({ cells, edges, consequentialSteps }) {
  const cellIds = requireUnique(cells, (row) => row.cellId, 'PDP-3 cells');
  const surfaceIds = requireUnique(cells, (row) => row.surfaceId, 'PDP-3 cell surfaces');
  const edgeIds = requireUnique(edges, (row) => row.id, 'PDP-3 channel edges');
  if (!Array.isArray(edges) || edges.some((row) => typeof row.taskId !== 'string' || !row.taskId.trim())) {
    throw new Error('PDP-3 channel edges contain a missing task identity');
  }
  if (new Set(edges.map((row) => row.taskId)).size !== 30) throw new Error('PDP-3 channel edge task set must contain exactly 30 journey tasks');
  const edgePairs = edges.map((row) => `${row.journeyRef}\u0000${row.channelRef}`);
  if (new Set(edgePairs).size !== edgePairs.length) throw new Error('PDP-3 channel edges contain duplicate journey/channel pairs');
  const stepIds = requireUnique(consequentialSteps, (row) => row.taskId, 'PDP-3 consequential steps');
  const stepRefs = requireUnique(consequentialSteps, (row) => row.stepRef, 'PDP-3 consequential step refs');
  requireUnique(consequentialSteps, (row) => row.exactPurposeBindingRef, 'PDP-3 consequential purpose bindings');
  requireUnique(consequentialSteps, (row) => row.exactSourceStepRef, 'PDP-3 consequential source steps');
  requireUnique(consequentialSteps, (row) => `${row.journeyId}\u0000${row.ordinal}`, 'PDP-3 consequential journey/ordinal selectors');
  assertConsequentialStepCohort(consequentialSteps);
  if (cellIds.length !== 50 || surfaceIds.length !== 50) throw new Error(`Expected 50 PDP-3 cells/surfaces; got ${cellIds.length}/${surfaceIds.length}`);
  if (edgeIds.length !== 61) throw new Error(`Expected 61 PDP-3 channel edges; got ${edgeIds.length}`);
  if (stepIds.length !== 14 || stepRefs.length !== 14) throw new Error(`Expected 14 PDP-3 consequential steps; got ${stepIds.length}`);
  return {
    cells: cellIds.length,
    edges: edgeIds.length,
    uniqueJourneyTasks: new Set(edges.map((row) => row.taskId)).size,
    consequentialSteps: stepIds.length,
  };
}

const SOURCE_PATH_PREFIX = /^(?:\.product-experience\/|docs\/|contracts\/|apps\/|libs\/|modules\/|scripts\/|tests\/)/u;

function sourcePathsIn(value) {
  const found = new Set();
  const visit = (node) => {
    if (typeof node === 'string') {
      const candidate = node.split('#')[0];
      if (SOURCE_PATH_PREFIX.test(candidate)) found.add(candidate);
    } else if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === 'object') Object.values(node).forEach(visit);
  };
  visit(value);
  return [...found];
}

function expandSourcePath(repositoryRoot, sourcePath) {
  if (/[*?]/u.test(sourcePath)) {
    const segments = sourcePath.split('/');
    const wildcardIndex = segments.findIndex((segment) => /[*?]/u.test(segment));
    const prefix = segments.slice(0, wildcardIndex).join('/');
    const base = path.resolve(repositoryRoot, prefix || '.');
    const relativeBase = path.relative(repositoryRoot, base);
    if (relativeBase.startsWith('..') || path.isAbsolute(relativeBase) || !fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
      throw new Error(`Referenced source pattern has no valid directory: ${sourcePath}`);
    }
    const pattern = segments.map((segment, index) => {
      if (segment === '*' || segment === '**') return '(?:[^/]+/)*';
      const escaped = segment.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '[^/]*').replaceAll('?', '[^/]');
      return index < segments.length - 1 ? `${escaped}/` : escaped;
    }).join('');
    const matcher = new RegExp(`^${pattern}$`, 'u');
    const matches = [];
    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(target);
        else if (entry.isFile()) {
          const relative = path.relative(repositoryRoot, target).split(path.sep).join('/');
          if (matcher.test(relative)) matches.push(relative);
        }
      }
    };
    walk(base);
    if (matches.length === 0) throw new Error(`Referenced source pattern matched no files: ${sourcePath}`);
    return matches.sort();
  }
  const absolute = path.resolve(repositoryRoot, sourcePath);
  const relative = path.relative(repositoryRoot, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Source reference escapes repository: ${sourcePath}`);
  if (!fs.existsSync(absolute)) throw new Error(`Referenced source path is missing: ${sourcePath}`);
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return [sourcePath];
  if (!stat.isDirectory()) throw new Error(`Referenced source path is not a file or directory: ${sourcePath}`);
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile()) files.push(path.relative(repositoryRoot, target).split(path.sep).join('/'));
    }
  };
  walk(absolute);
  if (files.length === 0) throw new Error(`Referenced source directory is empty: ${sourcePath}`);
  return files;
}

export function validatePdp3ChannelEdges(edges, channelGrammar, journeys, ownerTasks, {
  readContract = (sourcePath) => readYaml(root, sourcePath),
} = {}) {
  if (!Array.isArray(edges) || edges.length !== 61) throw new Error(`Current channel registry must contain 61 edges; got ${edges?.length ?? 0}`);
  if (!channelGrammar || typeof channelGrammar !== 'object') throw new Error('Current channel grammar is missing');
  if (!Array.isArray(ownerTasks) || ownerTasks.length !== 30) throw new Error(`Current owner packet must contain 30 journey channel tasks; got ${ownerTasks?.length ?? 0}`);
  const ownerTaskIds = requireUnique(ownerTasks, (row) => row.taskId, 'PDP-3 owner packet journey tasks');
  const ownerTaskById = new Map(ownerTasks.map((row) => [row.taskId, row]));
  const journeyById = new Map((journeys ?? []).map((row) => [row.journeyId, row]));
  if (journeyById.size !== (journeys ?? []).length) throw new Error('Current step oracle contains duplicate journey identities');
  const contractByPath = new Map();
  const rows = edges.map((edge) => {
    if (edge.transportRefOrUnbound !== 'UNBOUND' || edge.channelTransportEquivalence !== 'UNBOUND'
        || edge.runtimeAdmission !== 'NOT_ADMITTED') {
      throw new Error(`Unsafe channel promotion in current source edge ${edge.id}`);
    }
    const journey = journeyById.get(edge.journeyRef);
    if (!journey) throw new Error(`Channel edge journey does not resolve in current oracle: ${edge.journeyRef}`);
    if (!Object.hasOwn(channelGrammar, edge.channelRef)) throw new Error(`Channel edge channel is not declared in current grammar: ${edge.channelRef}`);
    if (edge.journeyContractRef !== journey.contractRef) {
      throw new Error(`Channel edge contract does not match current journey contract: ${edge.id}`);
    }
    const ownerTask = ownerTaskById.get(edge.taskId);
    const expectedOwnerPacketRef = `${OWNER_PACKET_PATH}#/journeyChannelTasks/@taskId=${edge.taskId}`;
    if (!ownerTask || edge.ownerPacketRef !== expectedOwnerPacketRef
        || ownerTask.journeyId !== edge.journeyRef
        || ownerTask.contractSource !== edge.journeyContractRef) {
      throw new Error(`Channel edge does not exactly join its owner packet task, journey, and contract: ${edge.id}`);
    }
    const contractPath = edge.journeyContractRef.split('#')[0];
    if (!contractByPath.has(contractPath)) contractByPath.set(contractPath, readContract(contractPath));
    const contract = contractByPath.get(contractPath);
    if (contract?.journeyId !== edge.journeyRef || !Array.isArray(contract.channels)
        || !contract.channels.includes(edge.channelRef)) {
      throw new Error(`Channel edge journey contract content does not declare its journey and channel: ${edge.id}`);
    }
    const materialSourcePaths = [...new Set([
      ...sourcePathsIn(edge),
      ...sourcePathsIn(channelGrammar[edge.channelRef]),
      ...sourcePathsIn(journey),
    ])].sort();
    return {
      id: edge.id,
      taskId: edge.taskId,
      journeyRef: edge.journeyRef,
      channelRef: edge.channelRef,
      journeyContractRef: edge.journeyContractRef,
      logicalDefinitionDisposition: edge.logicalDefinitionDisposition ?? 'NOT_STATED',
      semanticCompleteness: edge.semanticCompleteness ?? 'NOT_STATED',
      transportDisposition: edge.transportDisposition ?? 'NOT_STATED',
      transportRefOrUnbound: edge.transportRefOrUnbound,
      channelTransportEquivalence: edge.channelTransportEquivalence,
      runtimeAdmission: edge.runtimeAdmission,
      stateOrObservationDisposition: edge.stateOrObservationDisposition ?? 'NOT_STATED',
      blockerInputs: {
        logicalDefinitionBlockers: edge.logicalDefinitionBlockers ?? [],
        unresolvedOperationRefs: edge.unresolvedOperationRefs ?? [],
        stateOrObservationDisposition: edge.stateOrObservationDisposition ?? 'NOT_STATED',
        transportDisposition: edge.transportDisposition ?? 'NOT_STATED',
        transportRefOrUnbound: edge.transportRefOrUnbound,
      },
      materialSourcePaths,
    };
  });
  requireUnique(rows, (row) => row.id, 'PDP-3 channel edges');
  if (rows.some((row) => typeof row.taskId !== 'string' || !row.taskId.trim())) throw new Error('PDP-3 channel edges contain a missing task identity');
  if (new Set(rows.map((row) => row.taskId)).size !== 30) throw new Error('PDP-3 channel edge task set must contain exactly 30 journey tasks');
  if (new Set(rows.map((row) => row.taskId)).size !== ownerTaskIds.length
      || ownerTaskIds.some((taskId) => !rows.some((row) => row.taskId === taskId))) {
    throw new Error('PDP-3 channel edge task set does not exactly cover the owner packet task set');
  }
  const pairs = rows.map((row) => `${row.journeyRef}\u0000${row.channelRef}`);
  if (new Set(pairs).size !== pairs.length) throw new Error('PDP-3 channel edges contain duplicate journey/channel pairs');
  return rows;
}

export function assessPdp3SourceBaseline({ sourceDigests, contextDigests = [], lifecycleCurrentness, digestAgreement = [] }) {
  const historicalPinChanges = sourceDigests.filter((row) => row.role === 'MATERIAL'
    && (!row.pinnedSha256 || row.currentSha256 !== row.pinnedSha256));
  const lifecycleCells = lifecycleCurrentness?.cells ?? [];
  const lifecycleCellCurrent = lifecycleCells.length === 1
    && lifecycleCells[0]?.sourceCurrentness === 'CURRENT'
    && (lifecycleCells[0]?.blockers?.length ?? 0) === 0;
  const lifecycleStable = lifecycleCurrentness?.continuity === 'CONTINUOUS'
    && (lifecycleCurrentness.blockers?.length ?? 0) === 0
    && lifecycleCellCurrent;
  const digestsAgree = digestAgreement.length === 0 || digestAgreement.every((row) => row.status === 'MATCH');
  const baselineCovered = historicalPinChanges.length === 0;
  const sourceCurrentness = lifecycleStable && baselineCovered && digestsAgree ? 'CURRENT' : 'UNKNOWN';
  const blockers = [];
  if (!lifecycleStable) blockers.push('LIFECYCLE_STABILITY_NOT_ESTABLISHED');
  if (!lifecycleCellCurrent) blockers.push('LIFECYCLE_CELL_CURRENTNESS_NOT_ESTABLISHED');
  if (!baselineCovered) blockers.push('AUTHORITATIVE_SOURCE_BASELINE_INCOMPLETE_OR_CHANGED');
  if (!digestsAgree) blockers.push('LIFECYCLE_CAPTURE_DIGEST_DISAGREEMENT_OR_MISSING');
  return {
    sourceCurrentness,
    lifecycleStability: lifecycleStable ? 'STABLE_CAPTURE_OBSERVED' : 'UNKNOWN',
    authoritativeBaselineCoverage: baselineCovered ? 'COMPLETE_MATCH' : 'INCOMPLETE_OR_CHANGED',
    contextDigestCount: contextDigests.length,
    lifecycleDigestAgreement: digestsAgree ? 'MATCH' : 'MISMATCH_OR_MISSING',
    blockers,
  };
}

export function comparePdp3CaptureDigests({ sourceDigests, contextDigests, lifecycleCurrentness }) {
  const captured = lifecycleCurrentness?.cells?.[0]?.fileContentDigests ?? {};
  return [...sourceDigests, ...contextDigests].map(({ path: sourcePath, currentSha256 }) => {
    const capturedSha256 = captured[sourcePath];
    return {
      path: sourcePath,
      observedSha256: currentSha256,
      capturedSha256: capturedSha256 ?? null,
      status: !currentSha256 || !DIGEST.test(capturedSha256 ?? '')
        ? 'MISSING_DIGEST'
        : currentSha256 === capturedSha256 ? 'MATCH' : 'MISMATCH',
    };
  });
}

export function assertConsequentialStepCohort(rows) {
  if (!Array.isArray(rows) || rows.some((row) => typeof row?.journeyId !== 'string' || !row.journeyId.trim())) {
    throw new Error('PDP-3 consequential step cohort contains a missing journey identity');
  }
  if (rows.some((row) => row.journeyId === 'J-21')) {
    throw new Error('J-21 is excluded from the consequential-step cohort and remains blocked');
  }
}

function canonicalCellRows(repositoryRoot, matrix, topology) {
  const expectedSurfaceIds = [
    ...(topology.manifestCandidates ?? []).map((row) => row.surfaceId),
    ...(topology.compositions ?? []).map((row) => row.surfaceId),
    ...(topology.consumerCrosswalk ?? []).map((row) => row.surfaceId),
  ];
  requireUnique(expectedSurfaceIds.map((surfaceId) => ({ surfaceId })), (row) => row.surfaceId, 'physical/composite/consumer topology');
  if (topology.manifestCandidates?.length !== 26 || topology.compositions?.length !== 7
      || topology.consumerCrosswalk?.length !== 17 || expectedSurfaceIds.length !== 50) {
    throw new Error('Canonical topology denominator is not 26 physical + 7 composite/root + 17 consumer surfaces');
  }
  const rows = (matrix.cells ?? []).filter((row) => row.phase === 'PDP-3');
  if (rows.length !== 50) throw new Error(`PDP-3 execution matrix must contain 50 cells; got ${rows.length}`);
  requireUnique(rows, (row) => row.cellId, 'PDP-3 matrix cells');
  const rowSurfaces = rows.map((row) => row.surfaceId).sort();
  if (JSON.stringify(rowSurfaces) !== JSON.stringify([...expectedSurfaceIds].sort())) {
    throw new Error('PDP-3 matrix cell surfaces do not exactly match current physical/composite/consumer topology');
  }
  return rows.map((row) => ({
    cellId: row.cellId,
    surfaceId: row.surfaceId,
    surfaceKind: row.surfaceKind,
    applicability: row.phaseApplicabilityDisposition,
    identitySource: TOPOLOGY_PATH,
    pathRefs: [...new Set([...(row.inspectWhere ?? []), ...(row.parentSourceAuthorityRefs ?? [])]
      .map((ref) => String(ref).split('#')[0])
      .filter((ref) => ref && SOURCE_PATH_PREFIX.test(ref))
      .flatMap((ref) => expandSourcePath(repositoryRoot, ref)))].sort(),
  }));
}

export function selectCurrentConsequentialSteps(repositoryRoot, r5, purpose, oracles, ownerTasks) {
  const priorRows = r5.consequentialStepProgress?.steps;
  if (!Array.isArray(priorRows) || priorRows.length !== 14) throw new Error('R5 consequential-step cohort selector is missing or not 14 rows');
  assertConsequentialStepCohort(priorRows);
  if (!Array.isArray(ownerTasks) || ownerTasks.length !== 14) throw new Error('Current owner packet consequential-step selectors are missing or not 14 rows');
  const ownerTaskIds = requireUnique(ownerTasks, (row) => row.taskId, 'PDP-3 owner packet consequential steps');
  const selectedTaskIds = requireUnique(priorRows, (row) => row.taskId, 'R5 consequential-step selectors');
  if (ownerTaskIds.length !== selectedTaskIds.length || ownerTaskIds.some((taskId) => !selectedTaskIds.includes(taskId))) {
    throw new Error('R5 consequential-step selector set does not exactly cover the current owner packet task set');
  }
  const ownerByTaskId = new Map(ownerTasks.map((row) => [row.taskId, row]));
  const purposeById = new Map((purpose.records ?? []).map((row) => [row.id, row]));
  if (purposeById.size !== (purpose.records ?? []).length) throw new Error('Current purpose bindings contain duplicate identities');
  const oracleJourneys = new Map((oracles.journeys ?? []).map((row) => [row.journeyId, row]));
  if (oracleJourneys.size !== (oracles.journeys ?? []).length) throw new Error('Current step oracle contains duplicate journey identities');
  return priorRows.map((selected) => {
    const ownerTask = ownerByTaskId.get(selected.taskId);
    const selectorId = selected.exactPurposeBindingRef?.match(/@id=([^#]+)$/u)?.[1];
    const binding = purposeById.get(selectorId);
    const oracleJourney = oracleJourneys.get(selected.journeyId);
    const step = oracleJourney?.steps?.[selected.ordinal - 1];
    if (!ownerTask) throw new Error(`Consequential step selector is unresolved: ${selected.taskId}`);
    if (ownerTask.journeyId !== selected.journeyId || ownerTask.ordinal !== selected.ordinal
        || ownerTask.sourceStepRef !== selected.exactSourceStepRef) {
      throw new Error(`Consequential step selector does not exactly join its owner packet task: ${selected.taskId}`);
    }
    if (!binding || !oracleJourney || !step) throw new Error(`Consequential step selector is unresolved: ${selected.taskId}`);
    if (binding.journeyRef !== selected.journeyId || binding.ordinal !== selected.ordinal
        || binding.stepRef !== selected.exactSourceStepRef || step.sourceRef !== selected.exactSourceStepRef
        || step.ordinal !== selected.ordinal) {
      throw new Error(`Consequential step identity/source mismatch: ${selected.taskId}`);
    }
    if (binding.runtimeAdmission !== 'NOT_ADMITTED') throw new Error(`Consequential step runtime was promoted in current source: ${selected.taskId}`);
    const sourceContractPath = selected.exactSourceStepRef.split('#')[0];
    const contract = readYaml(repositoryRoot, sourceContractPath);
    const stepIndex = Number(selected.exactSourceStepRef.match(/#\/steps\/(\d+)$/u)?.[1]);
    const contractStep = contract.steps?.[stepIndex];
    if (!contractStep || (step.viewRef && contractStep.view !== step.viewRef)) {
      throw new Error(`Consequential journey-contract step selector is stale: ${selected.taskId}`);
    }
    const materialSourcePaths = [...new Set([
      PURPOSE_PATH,
      ORACLE_PATH,
      sourceContractPath,
      ...sourcePathsIn(binding),
      ...sourcePathsIn(step),
      ...sourcePathsIn(contractStep),
    ].flatMap((sourcePath) => expandSourcePath(repositoryRoot, sourcePath)))].sort();
    return {
      taskId: selected.taskId,
      stepRef: selected.stepRef,
      journeyId: selected.journeyId,
      ordinal: selected.ordinal,
      currentStepId: step.id,
      exactPurposeBindingRef: `${PURPOSE_PATH}#records/@id=${binding.id}`,
      exactSourceStepRef: selected.exactSourceStepRef,
      materialSourcePaths,
      currentDispositionInputs: {
        bindingKind: binding.bindingKind ?? null,
        semanticRole: binding.semanticRole ?? null,
        transitionDisposition: binding.transitionDisposition ?? null,
        transitionRefs: binding.transitionRefs ?? [],
        actionRef: binding.actionRef ?? null,
        actionExactOperationRefs: binding.actionExactOperationRefs ?? [],
        operationRefs: binding.operationRefs ?? [],
        sourceOracleOperationDisposition: step.operationDisposition ?? null,
        runtimeAdmission: binding.runtimeAdmission ?? 'NOT_STATED',
        acceptanceEffect: binding.acceptanceEffect ?? 'NOT_STATED',
        sourceReferences: binding.sourceRefs ?? [],
      },
      blockerInputs: {
        transitionDisposition: binding.transitionDisposition ?? null,
        transitionRefs: binding.transitionRefs ?? [],
        sourceOracleOperationDisposition: step.operationDisposition ?? null,
        sourceOracleBlockers: step.blockers ?? step.definitionBlockers ?? [],
        runtimeAdmission: binding.runtimeAdmission,
        acceptanceEffect: binding.acceptanceEffect,
      },
      historicalR5Disposition: selected.sourceStatus,
    };
  });
}

/** Build a source-only observation. Lifecycle currentness is actually invoked; its result is never promoted to PDP completion. */
export function buildPdp3CurrentnessObservation(repositoryRoot = root, { observedAt = new Date().toISOString(), capture } = {}) {
  const status = readJson(repositoryRoot, STATUS_PATH);
  const matrix = readJson(repositoryRoot, MATRIX_PATH);
  const topology = readJson(repositoryRoot, TOPOLOGY_PATH);
  const r5 = readJson(repositoryRoot, R5_PATH);
  const channel = readYaml(repositoryRoot, CHANNEL_PATH);
  const ownerPacket = readJson(repositoryRoot, OWNER_PACKET_PATH);
  const purpose = readYaml(repositoryRoot, PURPOSE_PATH);
  const oracles = readYaml(repositoryRoot, ORACLE_PATH);
  if (status.phase !== 'PDP-3' || !status.sourceShaSet || typeof status.sourceShaSet !== 'object') {
    throw new Error('Current PDP-3 phase status sourceShaSet is missing or invalid');
  }
  const journeys = (oracles.journeys ?? []).map((journey) => {
    const contractRef = journey.contractRef ?? journey.sourceRef;
    return { ...journey, contractRef };
  });
  const cells = canonicalCellRows(repositoryRoot, matrix, topology);
  const edges = validatePdp3ChannelEdges(channel.edges ?? [], channel.channelGrammar, journeys, ownerPacket.journeyChannelTasks, {
    readContract: (sourcePath) => readYaml(repositoryRoot, sourcePath),
  });
  const consequentialSteps = selectCurrentConsequentialSteps(repositoryRoot, r5, purpose, oracles, ownerPacket.consequentialStepTasks);
  const denominator = validatePdp3CurrentnessDenominators({ cells, edges, consequentialSteps });
  const referencedPaths = [
    ...cells.flatMap((cell) => cell.pathRefs),
    ...edges.flatMap((edge) => edge.materialSourcePaths),
    ...consequentialSteps.flatMap((step) => step.materialSourcePaths),
  ];
  const sourcePaths = [...new Set([
    ...Object.keys(status.sourceShaSet),
    ...COMMON_PATHS,
    ...referencedPaths.flatMap((sourcePath) => expandSourcePath(repositoryRoot, sourcePath)),
  ])].filter((sourcePath) => sourcePath !== R5_PATH && sourcePath !== STATUS_PATH).sort();
  const contextPaths = [R5_PATH, STATUS_PATH];
  const sourceDigests = sourcePaths.map((sourcePath) => {
    const absolute = path.join(repositoryRoot, sourcePath);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      return { path: sourcePath, role: 'MATERIAL', status: 'MISSING', currentSha256: null, pinnedSha256: status.sourceShaSet[sourcePath] ?? null };
    }
    const currentSha256 = hashBytes(fs.readFileSync(absolute));
    const pinned = status.sourceShaSet[sourcePath];
    const pinnedSha256 = typeof pinned === 'string' ? (pinned.startsWith('sha256:') ? pinned : `sha256:${pinned}`) : null;
    return {
      path: sourcePath,
      role: 'MATERIAL',
      status: !pinnedSha256 ? 'NO_AUTHORITATIVE_BASELINE' : currentSha256 === pinnedSha256 ? 'MATCH' : 'CHANGED',
      currentSha256,
      pinnedSha256,
    };
  });
  const contextDigests = contextPaths.map((sourcePath) => ({
    path: sourcePath,
      role: sourcePath === R5_PATH ? 'HISTORICAL_SELECTOR_ONLY' : 'STATUS_CONTEXT_NOT_SELF_PINNED',
    currentSha256: hashBytes(fs.readFileSync(path.join(repositoryRoot, sourcePath))),
  }));
  const ownerGraphFingerprint = hashValue(cells.map(({ cellId, surfaceId, surfaceKind, applicability }) => ({ cellId, surfaceId, surfaceKind, applicability })));
  const physicalCatalogFingerprint = hashBytes(fs.readFileSync(path.join(repositoryRoot, TOPOLOGY_PATH)));
  const providerRegistryFingerprint = hashBytes(fs.readFileSync(path.join(repositoryRoot, SOURCE_MANIFEST_PATH)));
  const lifecycleCurrentness = observeMediaDiscoveryCurrentness(repositoryRoot, [{
    cellId: 'media.discovery.pdp3.currentness-r6',
    surfaceId: 'media.surface.repository-root',
    phase: 'PDP-3',
    cellType: 'PDP3_SOURCE_DENOMINATOR',
    applicability: 'SOURCE_ONLY_OBSERVATION',
    paths: [...sourcePaths, ...contextPaths],
    ownerGraphFingerprint,
    physicalCatalogFingerprint,
    providerRegistryFingerprint,
  }], { capture });
  const lifecycleDigestAgreement = comparePdp3CaptureDigests({ sourceDigests, contextDigests, lifecycleCurrentness });
  const baselineAssessment = assessPdp3SourceBaseline({ sourceDigests, contextDigests, lifecycleCurrentness, digestAgreement: lifecycleDigestAgreement });
  const j21Edges = edges.filter((edge) => edge.journeyRef === 'J-21');
  if (j21Edges.length === 0 || j21Edges.some((edge) => edge.blockerInputs.logicalDefinitionBlockers.length === 0)) {
    throw new Error('J21 must remain explicitly represented by current blocked channel-edge source rows');
  }
  return {
    schemaVersion: 'media.discovery.pdp3-currentness-source-observation.v1',
    recordKind: 'PDP3_SOURCE_CURRENTNESS_OBSERVATION_ONLY_NOT_PHASE_EXIT_OR_ACCEPTANCE',
    observationId: 'MEDIA-DISCOVERY-PDP3-CURRENTNESS-2026-10-15-R6',
    observedAt,
    authority: 'SOURCE_DIGESTS_AND_LIFECYCLE_CURRENTNESS_ONLY; NOT_DEV_COMPLETE_ACCEPTANCE_INDEPENDENT_REVIEW_CLOSURE_OR_RELEASE',
    campaign: {
      repository: 'samujjwal/ghatana-media',
      macroStage: 'DISCOVERY',
      exactPhase: 'PDP-3',
      exactTask: 'MDC-30',
      denominators: { pdp3PhaseCells: denominator.cells, channelEdges: denominator.edges, uniqueJourneyTasks: denominator.uniqueJourneyTasks, consequentialSteps: denominator.consequentialSteps },
      sourcePaths: sourceDigests,
      contextDigests,
      materialSourceFingerprint: hashValue([
        ...sourceDigests.map(({ path: sourcePath, currentSha256 }) => ({ path: sourcePath, sha256: currentSha256, role: 'MATERIAL' })),
        ...contextDigests.map(({ path: sourcePath, currentSha256, role }) => ({ path: sourcePath, sha256: currentSha256, role })),
      ].sort((left, right) => left.path.localeCompare(right.path))),
      sourceCurrentness: baselineAssessment.sourceCurrentness,
      lifecycleStability: baselineAssessment.lifecycleStability,
      authoritativeBaselineCoverage: baselineAssessment.authoritativeBaselineCoverage,
      authoritativeBaselineSource: 'PDP3_STATUS_SOURCE_SHA_SET; NO_EXTERNAL_BASELINE_APPLIED',
      historicalPdp3PinComparison: sourceDigests.map(({ path: sourcePath, status: pinStatus, pinnedSha256, currentSha256 }) => ({ path: sourcePath, status: pinStatus, pinnedSha256, currentSha256 })),
      lifecycleDigestAgreement,
      sourceCurrentnessBlockers: [...new Set([...baselineAssessment.blockers, ...(lifecycleCurrentness.blockers ?? []), ...(lifecycleCurrentness.cells[0]?.blockers ?? [])])],
      lifecycleCurrentness,
    },
    phaseCells: cells,
    channelEdges: edges,
    consequentialSteps,
    explicitExclusions: {
      J21: {
        disposition: 'EXCLUDED_FROM_CONSEQUENTIAL_STEP_COHORT; CURRENT_CHANNEL_ROWS_RETAINED_AS_BLOCKED_SOURCE_INPUTS',
        currentChannelEdgeIds: j21Edges.map((edge) => edge.id),
        blockerInputs: j21Edges.map((edge) => ({ edgeId: edge.id, ...edge.blockerInputs })),
      },
    },
    claimsBoundary: {
      pdp3DevComplete: 'NOT_ASSERTED',
      phaseCurrentnessAcceptance: 'NOT_ASSERTED',
      independentReview: 'NOT_ASSERTED',
      lifecycleClosure: 'NOT_ENTERED',
      transportEquivalence: 'UNBOUND_FOR_ALL_61_EDGES',
      runtimeAdmission: 'NOT_ADMITTED_FOR_ALL_61_EDGES_AND_14_CONSEQUENTIAL_STEPS',
      j21: 'EXCLUDED_AND_BLOCKED',
      build: 'NOT_ENTERED',
      delivery: 'BLOCKED',
    },
  };
}

export function writeAppendOnlyObservation(outputPath, observation, { writeFile = fs.writeFileSync } = {}) {
  if (typeof outputPath !== 'string' || !outputPath.trim()) throw new TypeError('An explicit output path is required');
  const serialized = `${JSON.stringify(observation, null, 2)}\n`;
  writeFile(outputPath, serialized, { flag: 'wx' });
  return outputPath;
}

async function main(args) {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('Usage: node scripts/record-media-discovery-pdp3-currentness.mjs --output <new-observation-path>\n'
      + 'Warning: building/running this observation invokes the persistent repository-wide Lifecycle currentness adapter twice and may update its normal capture state. Recorder execution is not read-only.\n');
    return;
  }
  const outputArgIndex = args.indexOf('--output');
  if (outputArgIndex < 0 || !args[outputArgIndex + 1]) {
    throw new Error('Usage: node scripts/record-media-discovery-pdp3-currentness.mjs --output <new-observation-path>. '
      + 'Warning: building/running this observation invokes the persistent repository-wide Lifecycle currentness adapter twice and may update its normal capture state; execution is not read-only.');
  }
  const output = path.resolve(args[outputArgIndex + 1]);
  const observation = buildPdp3CurrentnessObservation();
  writeAppendOnlyObservation(output, observation);
  process.stdout.write(`${output}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
