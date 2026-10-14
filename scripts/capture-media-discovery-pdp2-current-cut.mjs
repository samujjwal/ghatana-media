#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  canonicalizeVerificationValue,
  captureRepositorySourceCurrentness,
  isRepositorySourceCurrentness,
} from '@ghatana/verification-planner';
import { observeMediaDiscoveryCurrentness } from './media-discovery-currentness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireTools = createRequire(path.resolve(root, '../ghatana-tools/package.json'));
const parseYaml = requireTools('yaml').parse;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const SOURCE_ROOTS = {
  ghatana: '../ghatana',
  'ghatana-products': '../ghatana-products',
  gharbatai: '../gharbatai',
  'ghatana-tools': '../ghatana-tools',
  'ghatana-lifecycle': '../ghatana-lifecycle',
  'ghatana-shared': '../ghatana-shared',
};
const PDP2_TEST_FILES = [
  'tests/media-pdp-p2-dev-status.test.mjs',
  'tests/pdp-design-interface-parity.test.mjs',
  'tests/pdp-design-current-public-consumer-bindings.test.mjs',
];
const PDP2_TEST_COMMAND = `node --test ${PDP2_TEST_FILES.join(' ')}`;
const LOCAL_CHECK_COMMAND = 'pnpm check:product-experience-local';
const PDP2_STATUS_PATH = 'docs/implementation/pdp-2-phase-dev-status.json';
const MATRIX_PATH = 'docs/implementation/media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json';
const TOPOLOGY_PATH = '.product-experience/surfaces/media-physical-topology.v1.json';
const REGISTRY_PATH = '.product-experience/surface-registry.yaml';
const OWNER_DECISION_PATH = '.product-experience/reviews/2026-10-13-discovery-delegated-owner-decision-and-authorizations.md';
const MDC20_PATH = 'docs/implementation/observations/media-discovery-pdp2-mdc20-design-drift-2026-10-13-r1.json';
const HISTORICAL_P1_EXIT_PATH = 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-13-r3.json';
const HISTORICAL_P0_EXIT_PATH = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-13-r2.json';
const HISTORICAL_P2_EXIT_PATH = 'docs/implementation/observations/media-discovery-pdp2-exit-2026-10-13-r2.json';
const OWNER_DIRECTIONS_PATH = 'docs/implementation/observations/media-discovery-current-cut-owner-directions-2026-10-13-r2.json';
const RUNNER_PATH = 'scripts/capture-media-discovery-pdp2-current-cut.mjs';
const COMMON_PDP2_REFS = [
  '.product-experience/source-manifest.yaml',
  '.product-experience/surface-registry.yaml',
  TOPOLOGY_PATH,
  '.product-experience/decision-log.md',
  OWNER_DECISION_PATH,
  '.product-experience/pdp-2-design-interface-system/',
  '.product-experience/pdp-1-domain-data/handoff-contracts.yaml',
  '.product-experience/interface-parity/',
  'apps/media-experience-explorer/specification-artifacts.json',
  'libs/audio-video-ui/src/screens/TranscriptCaptionScreen.tsx',
  'modules/intelligence/ai-voice/libs/ai-voice-ui-react/src/index.ts',
  PDP2_STATUS_PATH,
  'docs/implementation/pdp-1-phase-dev-status.json',
  HISTORICAL_P1_EXIT_PATH,
  HISTORICAL_P0_EXIT_PATH,
  MDC20_PATH,
  'scripts/check-product-experience-local.mjs',
  'scripts/check-media-design-conformance.mjs',
  'scripts/record-media-discovery-pdp2-phase-exit.mjs',
  ...PDP2_TEST_FILES,
  'package.json',
  'pnpm-lock.yaml',
];

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function hashValue(value) {
  return sha256(canonicalizeVerificationValue(value));
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function runCommand(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 24 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { exitCode: result.status ?? 127, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function parseTestOutcome(command, result) {
  const output = `${result.stdout}\n${result.stderr}`;
  const testCount = output.match(/(?:ℹ|#)\s+tests\s+(\d+)/u);
  const passedCount = output.match(/(?:ℹ|#)\s+pass\s+(\d+)/u);
  const failedCount = output.match(/(?:ℹ|#)\s+fail\s+(\d+)/u);
  const skippedCount = output.match(/(?:ℹ|#)\s+skipped\s+(\d+)/u);
  return {
    command,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutSha256: sha256(result.stdout),
    stderrSha256: sha256(result.stderr),
    status: result.exitCode === 0 ? 'PASS' : 'FAIL',
    testCount: testCount ? Number(testCount[1]) : null,
    passedCount: passedCount ? Number(passedCount[1]) : null,
    failedCount: failedCount ? Number(failedCount[1]) : null,
    skippedCount: skippedCount ? Number(skippedCount[1]) : null,
  };
}

function parseLocalOutcome(result) {
  const output = `${result.stdout}\n${result.stderr}`;
  return {
    command: LOCAL_CHECK_COMMAND,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutSha256: sha256(result.stdout),
    stderrSha256: sha256(result.stderr),
    status: result.exitCode === 0 && output.includes('Media Product Definition local check passed') ? 'PASS' : 'FAIL',
  };
}

function trackedPathSet() {
  const tracked = git(['ls-files', '-z']).split('\0');
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0');
  return new Set([...tracked, ...untracked].filter(Boolean));
}

function expandRef(ref, availablePaths) {
  const repoPath = ref.split('#', 1)[0].replace(/\/+$/u, '');
  if (availablePaths.has(repoPath)) return [repoPath];
  const prefix = `${repoPath}/`;
  return [...availablePaths].filter((candidate) => candidate.startsWith(prefix)).sort();
}

function uniqueById(rows, label) {
  const byId = new Map();
  for (const row of rows) {
    if (!row || typeof row.surfaceId !== 'string' || byId.has(row.surfaceId)) {
      throw new TypeError(`Missing or duplicate ${label} identity`);
    }
    byId.set(row.surfaceId, row);
  }
  return byId;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function applicabilityAuthorityRef(source, index, kind) {
  if (kind === 'PHYSICAL_CANDIDATE') {
    return `${TOPOLOGY_PATH}#/manifestCandidates/${index}`;
  }
  return `${TOPOLOGY_PATH}#/compositions/${index}`;
}

function validateMatrixAndTopology(matrix, topology, registry) {
  const cells = matrix.cells.filter((cell) => cell.phase === 'PDP-2');
  const physical = uniqueById(topology.manifestCandidates, 'physical candidate');
  const compositions = uniqueById(topology.compositions, 'composition');
  const consumers = uniqueById(topology.consumerCrosswalk, 'consumer');
  const registryById = uniqueById(registry.surfaces, 'registered surface');
  const matrixById = uniqueById(cells, 'PDP-2 cell');
  const errors = [];

  if (cells.length !== 50 || matrixById.size !== 50 || matrix.denominators?.phaseReviewCells !== 200) {
    errors.push('PDP2_MATRIX_DENOMINATOR_MISMATCH');
  }
  if (physical.size !== 26 || compositions.size !== 7 || consumers.size !== 17
      || [...compositions.values()].filter((row) => row.kind === 'SEMANTIC_COMPOSITION').length !== 6
      || [...compositions.values()].filter((row) => row.kind === 'REPOSITORY_ROOT').length !== 1) {
    errors.push('LIVE_TOPOLOGY_DENOMINATOR_MISMATCH');
  }

  for (const [surfaceId, source] of physical) {
    const cell = matrixById.get(surfaceId);
    const applicability = source.phaseApplicability?.['PDP-2'];
    const expectedConsumers = [...(source.consumerSurfaceRefs ?? [])].sort();
    const actualConsumers = [...(cell?.consumerCrosswalkRefs ?? [])].sort();
    const linked = cell?.linkedConsumerApplicability ?? [];
    if (!cell || cell.surfaceKind !== 'PHYSICAL_CANDIDATE'
        || cell.owner !== source.owner || cell.physicalDisposition !== source.disposition
        || cell.phaseApplicabilityDisposition !== applicability?.disposition
        || cell.phaseApplicabilityRationale !== applicability?.rationale
        || cell.surfaceDispositionRationale !== source.dispositionRationale
        || JSON.stringify(actualConsumers) !== JSON.stringify(expectedConsumers)) {
      errors.push(`PHYSICAL_CELL_TOPOLOGY_OR_OWNER_MISMATCH:${surfaceId}`);
      continue;
    }
    const sourceIndex = topology.manifestCandidates.findIndex((row) => row.surfaceId === surfaceId);
    if (cell.ownerAuthorityRef !== applicabilityAuthorityRef(source, sourceIndex, 'PHYSICAL_CANDIDATE')) {
      errors.push(`PHYSICAL_OWNER_AUTHORITY_REF_MISMATCH:${surfaceId}`);
    }
    for (const ref of applicability.authorityRefs ?? []) {
      if (!cell.parentSourceAuthorityRefs?.includes(ref)) errors.push(`PHYSICAL_PDP2_AUTHORITY_MISSING:${surfaceId}:${ref}`);
    }
    if (!Array.isArray(linked) || JSON.stringify(linked.map((entry) => entry.surfaceId).sort()) !== JSON.stringify(expectedConsumers)) {
      errors.push(`PHYSICAL_CONSUMER_TRACE_MISMATCH:${surfaceId}`);
    }
    for (const crosswalkId of source.consumerSurfaceRefs ?? []) {
      const crosswalk = consumers.get(crosswalkId);
      const registered = registryById.get(crosswalkId);
      const trace = linked.find((entry) => entry.surfaceId === crosswalkId);
      const expectedDisposition = crosswalk?.bindingState === 'ARCHIVED'
        ? 'NOT_APPLICABLE_ARCHIVED'
        : registered?.applicablePdpArtifacts?.includes('PDP-2') === true
          ? 'APPLICABLE_CONSUMER_BINDING' : 'NOT_APPLICABLE';
      if (!crosswalk || !registered || !trace
          || JSON.stringify(trace.owner) !== JSON.stringify(registered.owners)
          || trace.disposition !== expectedDisposition
          || typeof trace.rationale !== 'string' || !trace.rationale.trim()) {
        errors.push(`PHYSICAL_CONSUMER_AUTHORITY_TRACE_INVALID:${surfaceId}:${crosswalkId}`);
      }
    }
    if (applicability.disposition === 'NOT_APPLICABLE') {
      if (!applicability.rationale?.trim() || !Array.isArray(applicability.authorityRefs) || !applicability.authorityRefs.length) {
        errors.push(`PHYSICAL_NA_WITHOUT_AUTHORITY_AND_RATIONALE:${surfaceId}`);
      }
      if (source.disposition === 'PHYSICAL'
          && (!source.dispositionRationale?.trim() || !(source.consumerSurfaceRefs ?? []).length
            || linked.some((entry) => entry.disposition !== 'APPLICABLE_CONSUMER_BINDING'))) {
        errors.push(`PHYSICAL_NA_SCOPE_NOT_EXPLAINED_BY_CONSUMER_BINDING:${surfaceId}`);
      }
      if (['SUPPORT_ONLY', 'SUBSUMED'].includes(source.disposition)
          && !(source.consumerSurfaceRefs ?? []).length && !source.dispositionRationale?.trim()) {
        errors.push(`SUPPORT_NA_WITHOUT_SURFACE_DISPOSITION_RATIONALE:${surfaceId}`);
      }
    }
  }

  for (const [surfaceId, source] of compositions) {
    const cell = matrixById.get(surfaceId);
    const applicability = source.phaseApplicability?.['PDP-2'];
    const expectedKind = source.kind === 'REPOSITORY_ROOT' ? 'REPOSITORY_ROOT' : 'SEMANTIC_COMPOSITION';
    if (!cell || cell.surfaceKind !== expectedKind || cell.owner !== source.canonicalOwner
        || cell.phaseApplicabilityDisposition !== applicability?.disposition
        || cell.phaseApplicabilityRationale !== applicability?.rationale) {
      errors.push(`COMPOSITION_CELL_TOPOLOGY_OR_OWNER_MISMATCH:${surfaceId}`);
      continue;
    }
    const sourceIndex = topology.compositions.findIndex((row) => row.surfaceId === surfaceId);
    if (cell.ownerAuthorityRef !== applicabilityAuthorityRef(source, sourceIndex, expectedKind)) {
      errors.push(`COMPOSITION_OWNER_AUTHORITY_REF_MISMATCH:${surfaceId}`);
    }
    for (const ref of applicability.authorityRefs ?? []) {
      if (!cell.parentSourceAuthorityRefs?.includes(ref)) errors.push(`COMPOSITION_PDP2_AUTHORITY_MISSING:${surfaceId}:${ref}`);
    }
    if (source.kind === 'SEMANTIC_COMPOSITION') {
      for (const childId of source.children ?? []) {
        if (!matrixById.has(childId)) errors.push(`COMPOSITION_CHILD_CELL_MISSING:${surfaceId}:${childId}`);
      }
    }
  }

  for (const [surfaceId, source] of consumers) {
    const cell = matrixById.get(surfaceId);
    const registered = registryById.get(surfaceId);
    const linkedPhysical = cell?.linkedPhysicalSurfaces ?? [];
    const archived = source.bindingState === 'ARCHIVED';
    const expectedDisposition = archived ? 'NOT_APPLICABLE_ARCHIVED' : 'APPLICABLE_CONSUMER_BINDING';
    const expectedOwnerRef = `.product-experience/surface-registry.yaml#/surfaces/${registry.surfaces.findIndex((row) => row.surfaceId === surfaceId)}`;
    const expectedTopologyRef = `${TOPOLOGY_PATH}#/consumerCrosswalk/${topology.consumerCrosswalk.findIndex((row) => row.surfaceId === surfaceId)}`;
    if (!cell || !registered || cell.surfaceKind !== 'CONSUMER_BINDING'
        || JSON.stringify(cell.owner) !== JSON.stringify(registered.owners)
        || cell.ownerAuthorityRef !== expectedOwnerRef
        || cell.phaseApplicabilityDisposition !== expectedDisposition
        || JSON.stringify(cell.consumerCrosswalkRefs?.slice().sort()) !== JSON.stringify([...(source.physicalRefs ?? [])].sort())
        || JSON.stringify(linkedPhysical.map((entry) => entry.surfaceId).sort()) !== JSON.stringify([...(source.physicalRefs ?? [])].sort())
        || !cell.phaseApplicabilityRationale?.trim()
        || !cell.phaseApplicabilityAuthorityRefs?.includes(expectedOwnerRef)
        || !cell.phaseApplicabilityAuthorityRefs?.includes(expectedTopologyRef)) {
      errors.push(`CONSUMER_BINDING_OR_OWNER_MISMATCH:${surfaceId}`);
    }
    for (const link of linkedPhysical) {
      const physicalSource = physical.get(link.surfaceId);
      if (!physicalSource || link.owner !== physicalSource.owner
          || link.disposition !== physicalSource.disposition
          || link.phaseApplicabilityDisposition !== physicalSource.phaseApplicability?.['PDP-2']?.disposition) {
        errors.push(`CONSUMER_PHYSICAL_OWNER_TRACE_INVALID:${surfaceId}:${link.surfaceId}`);
      }
    }
    if (registered && (registered.applicablePdpArtifacts?.includes('PDP-2') === !archived) === false) {
      errors.push(`CONSUMER_PDP2_APPLICABILITY_CONTRADICTION:${surfaceId}`);
    }
  }

  const expectedIds = new Set([...physical.keys(), ...compositions.keys(), ...consumers.keys()]);
  if (expectedIds.size !== matrixById.size || [...expectedIds].some((surfaceId) => !matrixById.has(surfaceId))) {
    errors.push('PDP2_MATRIX_TOPOLOGY_ID_SET_MISMATCH');
  }
  return { cells, errors };
}

function buildCellPaths(matrixCells, topology, status, availablePaths, predecessorPaths) {
  const physical = new Map(topology.manifestCandidates.map((row) => [row.surfaceId, row]));
  const compositions = new Map(topology.compositions.map((row) => [row.surfaceId, row]));
  const consumers = new Map(topology.consumerCrosswalk.map((row) => [row.surfaceId, row]));
  const cellsBySurface = new Map(matrixCells.map((cell) => [cell.surfaceId, cell]));
  const sharedRefs = [...COMMON_PDP2_REFS, ...predecessorPaths.filter(Boolean), ...Object.keys(status.sourceShaSet ?? {})];
  const memo = new Map();

  const refsFor = (cell, seen = new Set()) => {
    if (memo.has(cell.surfaceId)) return memo.get(cell.surfaceId);
    if (seen.has(cell.surfaceId)) throw new TypeError(`Cycle in PDP-2 source membership at ${cell.surfaceId}`);
    seen.add(cell.surfaceId);
    const refs = [...sharedRefs, ...(cell.inspectWhere ?? []), ...(cell.parentSourceAuthorityRefs ?? [])];
    if (cell.ownerAuthorityRef) refs.push(cell.ownerAuthorityRef);
    if (cell.phaseApplicabilityAuthorityRefs) refs.push(...cell.phaseApplicabilityAuthorityRefs);
    if (consumers.has(cell.surfaceId)) {
      for (const physicalId of consumers.get(cell.surfaceId).physicalRefs ?? []) {
        const child = cellsBySurface.get(physicalId);
        if (child) refs.push(...refsFor(child, seen));
      }
    }
    const composition = compositions.get(cell.surfaceId);
    if (composition) {
      for (const childId of composition.children ?? []) {
        const child = cellsBySurface.get(childId);
        if (child) refs.push(...refsFor(child, seen));
      }
    }
    if (cell.surfaceKind === 'REPOSITORY_ROOT') {
      for (const consumerCell of matrixCells.filter((candidate) => candidate.surfaceKind === 'CONSUMER_BINDING')) {
        refs.push(...refsFor(consumerCell, seen));
      }
    }
    seen.delete(cell.surfaceId);
    const paths = [...new Set(refs.flatMap((reference) => expandRef(reference, availablePaths)))].sort();
    memo.set(cell.surfaceId, paths);
    return paths;
  };

  return matrixCells.map((cell) => ({
    cellId: `${cell.surfaceId}:PDP-2`,
    surfaceId: cell.surfaceId,
    phase: 'PDP-2',
    cellType: cell.surfaceKind,
    owner: cell.owner,
    paths: refsFor(cell),
    applicability: {
      disposition: cell.phaseApplicabilityDisposition,
      rationale: cell.phaseApplicabilityRationale,
      authorityRefs: cell.phaseApplicabilityAuthorityRefs ?? cell.parentSourceAuthorityRefs ?? [],
      consumerCrosswalkRefs: cell.consumerCrosswalkRefs ?? [],
      linkedConsumerApplicability: cell.linkedConsumerApplicability ?? [],
    },
    meaningRefs: { parentSourceAuthorityRefs: cell.parentSourceAuthorityRefs ?? [] },
    mappings: {
      ownerAuthorityRef: cell.ownerAuthorityRef ?? null,
      surfaceDispositionRationale: cell.surfaceDispositionRationale ?? null,
      physicalPublicBoundaryRef: cell.physicalPublicBoundaryRef ?? null,
    },
    predecessorPhase: 'PDP-1',
  }));
}

function snapshotP2Logs() {
  const directory = path.join(root, 'docs/implementation/verification');
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolutePath);
      else if (/^P2-.*\.log$/u.test(entry.name)) files.push(absolutePath);
    }
  };
  walk(directory);
  return new Map(files.map((absolutePath) => [absolutePath, fs.readFileSync(absolutePath)]));
}

function summarizeCapture(capture) {
  return {
    status: capture?.status ?? 'UNKNOWN',
    continuity: capture?.journal?.continuity ?? 'UNKNOWN',
    membershipChangeState: capture?.journal?.membershipChangeState ?? 'UNKNOWN',
    additions: capture?.journal?.membershipAdditions?.length ?? null,
    removals: capture?.journal?.membershipRemovals?.length ?? null,
    changedPaths: capture?.journal?.changedPaths?.length ?? null,
    externalChanges: capture?.journal?.externalChanges?.length ?? null,
    snapshotScope: capture?.metrics?.snapshotScope ?? 'UNKNOWN',
  };
}

function captureIsStable(capture) {
  return isRepositorySourceCurrentness(capture)
    && capture.journal?.continuity === 'CONTINUOUS'
    && capture.journal?.membershipChangeState === 'KNOWN'
    && capture.journal?.membershipAdditions?.length === 0
    && capture.journal?.membershipRemovals?.length === 0
    && capture.journal?.changedPaths?.length === 0
    && capture.journal?.externalChanges?.length === 0
    && capture.metrics?.snapshotScope === 'REPOSITORY_SCOPE';
}

function runRequiredChecks(dimensions) {
  const startedHead = git(['rev-parse', 'HEAD']);
  const priming = [captureRepositorySourceCurrentness(root, dimensions), captureRepositorySourceCurrentness(root, dimensions)];
  const before = captureRepositorySourceCurrentness(root, dimensions);
  const logsBefore = snapshotP2Logs();
  const localResult = runCommand('pnpm', ['check:product-experience-local']);
  const testResult = runCommand(process.execPath, ['--test', ...PDP2_TEST_FILES]);
  const generatedLogChanges = [];
  for (const [absolutePath, priorContents] of logsBefore) {
    if (!fs.existsSync(absolutePath)) continue;
    const afterContents = fs.readFileSync(absolutePath);
    if (!afterContents.equals(priorContents)) {
      fs.writeFileSync(absolutePath, priorContents);
      generatedLogChanges.push({
        path: path.relative(root, absolutePath),
        generatedSha256: sha256(afterContents),
        restoredSha256: sha256(priorContents),
        restoredToPreRunBytes: true,
      });
    }
  }
  const afterCaptures = [captureRepositorySourceCurrentness(root, dimensions), captureRepositorySourceCurrentness(root, dimensions)];
  const after = afterCaptures[1];
  const stable = captureIsStable(before) && afterCaptures.every(captureIsStable)
    && before.sourceToken === after.sourceToken
    && before.contentFingerprint === after.contentFingerprint
    && before.pathMembershipDigest === after.pathMembershipDigest;
  const outcomes = [parseLocalOutcome(localResult), parseTestOutcome(PDP2_TEST_COMMAND, testResult)];
  return {
    runner: RUNNER_PATH,
    startedHead,
    completedHead: git(['rev-parse', 'HEAD']),
    sourceBinding: {
      stable,
      sourceTokenBefore: before.sourceToken ?? null,
      contentFingerprintBefore: before.contentFingerprint ?? null,
      pathMembershipDigestBefore: before.pathMembershipDigest ?? null,
      sourceToken: after.sourceToken ?? null,
      contentFingerprint: after.contentFingerprint ?? null,
      pathMembershipDigest: after.pathMembershipDigest ?? null,
      before: summarizeCapture(before),
      after: afterCaptures.map(summarizeCapture),
      lifecyclePriming: priming.map(summarizeCapture),
      generatedLogsRestored: generatedLogChanges,
      testInputContentDigests: Object.fromEntries(PDP2_TEST_FILES.map((sourcePath) => [sourcePath, sha256(fs.readFileSync(path.join(root, sourcePath)))])),
    },
    outcomes,
  };
}

function ownerDirectionObservation() {
  const decision = readText(OWNER_DECISION_PATH);
  const line = decision.split('\n').find((entry) => entry.includes('`MEDIA-OWN-P2`')) ?? '';
  const approved = decision.includes('**Decision ID:** `MEDIA-DISCOVERY-OWNER-AUTHORIZATION-2026-10-13`')
    && line.includes('**APPROVE DESIGN DIRECTION**')
    && line.includes('Shared-referenced tokens/components')
    && line.includes('GUI_LIBRARY_HOST_DEPENDENT')
    && line.includes('No currentness')
    && line.includes('independent accessibility certification');
  return {
    decisionId: 'MEDIA-DISCOVERY-OWNER-AUTHORIZATION-2026-10-13',
    decisionRef: `${OWNER_DECISION_PATH}#MEDIA-OWN-P2`,
    sourceSha256: sha256(decision),
    status: approved ? 'APPROVED_DESIGN_DIRECTION' : 'MISSING_OR_CONTRADICTORY_DECISION',
    sourceRow: line,
    explicitLimits: ['NO_NEW_PDP2_CURRENTNESS', 'NO_EXTERNAL_SHARED_ACCEPTANCE', 'NO_INDEPENDENT_ACCESSIBILITY_CERTIFICATION', 'NO_FUNCTIONAL_PRODUCT_UI_ACCEPTANCE'],
  };
}

function pdp2OwnerReview(directions) {
  return directions.predecessorImpactReviews?.find((review) => review.phase === 'PDP-2') ?? null;
}

function sourcePinReview(status, currentDigests, mdc20, ownerChanges) {
  const changes = Object.entries(status.sourceShaSet ?? [])
    .map(([sourcePath, recorded]) => {
      const expected = `sha256:${recorded.replace(/^sha256:/u, '')}`;
      const current = currentDigests[sourcePath] ?? null;
      return { path: sourcePath, historicalSha256: expected, currentSha256: current, matches: expected === current };
    });
  const changed = changes.filter((entry) => !entry.matches);
  const dispositionByPath = new Map((mdc20.pinReview?.changedPins ?? []).map((entry) => [entry.path, entry]));
  const ownerByPath = new Map(ownerChanges.map((entry) => [entry.path, entry]));
  const unclassified = changed.filter((entry) => {
    const disposition = dispositionByPath.get(entry.path);
    if (disposition?.historicalSha256 === entry.historicalSha256
        && disposition.currentSha256 === entry.currentSha256
        && disposition.meaningChange === 'NONE_IDENTIFIED') return false;
    const reviewed = ownerByPath.get(entry.path);
    const staleMdc20ExplorerHash = entry.path === 'apps/media-experience-explorer/specification-artifacts.json'
      && disposition?.currentSha256 !== entry.currentSha256;
    return !(staleMdc20ExplorerHash
      && reviewed?.recordedSha256 === disposition?.currentSha256
      && reviewed?.observedSha256 === entry.currentSha256
      && reviewed?.requiresFreshCurrentness === true
      && Array.isArray(reviewed?.meaningIdsChangedAtReviewedCut)
      && reviewed.meaningIdsChangedAtReviewedCut.length === 0);
  });
  const expected = new Set([
    '.product-experience/pdp-2-design-interface-system/DESIGN-LANGUAGE.md',
    'apps/media-experience-explorer/specification-artifacts.json',
    'libs/audio-video-ui/src/screens/TranscriptCaptionScreen.tsx',
    'modules/intelligence/ai-voice/libs/ai-voice-ui-react/src/index.ts',
  ]);
  return {
    historicalPinCount: changes.length,
    currentPinCount: changes.length - changed.length,
    changedPinCount: changed.length,
    missingPinCount: changed.filter((entry) => entry.currentSha256 === null).length,
    changedPins: changed.map((entry) => ({ ...entry, disposition: dispositionByPath.get(entry.path) ?? null })),
    unclassifiedChangedPins: unclassified,
    explorerUsedOwnerDirectionBecauseMdc20HashWasStale: changed.some((entry) => entry.path === 'apps/media-experience-explorer/specification-artifacts.json'
      && dispositionByPath.get(entry.path)?.currentSha256 !== entry.currentSha256
      && ownerByPath.has(entry.path)),
    expectedChangedPathsMatch: changed.length === expected.size && changed.every((entry) => expected.has(entry.path))
      && [...expected].every((sourcePath) => changed.some((entry) => entry.path === sourcePath)),
  };
}

function ownerStatusJoin(historicalExit, currentDigests, ownerReview, materialSourceSetFingerprint) {
  const historicalPhaseExit = historicalExit.currentPhaseExit ?? historicalExit.phaseExit;
  const ownerChanges = ownerReview?.sourceChanges ?? [];
  const historicalDigests = historicalExit.sourceCurrentness?.sourceSetDigests?.sourceContentDigests ?? {};
  const historicalPaths = Object.keys(historicalDigests).sort();
  const currentPaths = Object.keys(currentDigests).sort();
  const historicalSet = new Set(historicalPaths);
  const currentSet = new Set(currentPaths);
  const missingPaths = historicalPaths.filter((sourcePath) => !currentSet.has(sourcePath));
  const additionalPaths = currentPaths.filter((sourcePath) => !historicalSet.has(sourcePath));
  const digestChanges = historicalPaths.filter((sourcePath) => currentSet.has(sourcePath)
    && historicalDigests[sourcePath] !== currentDigests[sourcePath]);
  const changesByPath = new Map(ownerChanges.map((entry) => [entry.path, entry]));
  const duplicateChangePaths = ownerChanges.filter((entry, index) => ownerChanges.findIndex((candidate) => candidate.path === entry.path) !== index).map((entry) => entry.path);
  const changedPathChecks = ownerChanges.map((entry) => ({
    path: entry.path,
    historicalSha256: historicalDigests[entry.path] ?? null,
    currentSha256: currentDigests[entry.path] ?? null,
    recordedSha256: entry.recordedSha256,
    observedSha256: entry.observedSha256,
    digestsMatch: historicalDigests[entry.path] === entry.recordedSha256
      && currentDigests[entry.path] === entry.observedSha256,
    requiresFreshCurrentness: entry.requiresFreshCurrentness === true,
    meaningIdsChangedAtReviewedCut: entry.meaningIdsChangedAtReviewedCut ?? null,
    classification: entry.ownerMaterialityClassification ?? null,
  }));
  const unapprovedChangedPaths = digestChanges.filter((sourcePath) => !changesByPath.has(sourcePath));
  const changeRecordsValid = ownerChanges.length === 4
    && duplicateChangePaths.length === 0
    && changedPathChecks.every((entry) => entry.digestsMatch && entry.requiresFreshCurrentness
      && Array.isArray(entry.meaningIdsChangedAtReviewedCut) && entry.meaningIdsChangedAtReviewedCut.length === 0
      && typeof entry.classification === 'string' && entry.classification.length > 0);
  const ownerReviewValid = ownerReview?.sourceCut === HISTORICAL_P2_EXIT_PATH
    && ownerReview?.previousMaterialFingerprint === historicalExit.sourceCurrentness?.materialSourceSetFingerprint
    && ownerReview?.historicalRequiredPathCount === 405
    && ownerReview?.pinComparison?.matching === 401
    && ownerReview?.pinComparison?.changed === 4
    && ownerReview?.pinComparison?.missing === 0;
  const valid = historicalExit.phase === 'PDP-2'
    && historicalPhaseExit?.status === 'PASS'
    && historicalPhaseExit?.sourceCurrentness === 'PASS'
    && historicalPhaseExit?.developmentStatus === 'DEV_COMPLETE'
    && historicalExit.sourceCurrentness?.status === 'PASS'
    && historicalExit.sourceCurrentness?.sourceCurrent === true
    && historicalPaths.length === 405
    && currentPaths.length === 405
    && missingPaths.length === 0
    && additionalPaths.length === 0
    && digestChanges.length === 4
    && digestChanges.length === ownerChanges.length
    && unapprovedChangedPaths.length === 0
    && changeRecordsValid
    && ownerReviewValid
    && historicalExit.sourceCurrentness?.sourceSetDigests?.sourcePathCount === 405;
  return {
    status: valid ? 'PASS' : 'FAIL',
    historicalExitRef: HISTORICAL_P2_EXIT_PATH,
    historicalExitDigest: digestFile(HISTORICAL_P2_EXIT_PATH),
    historicalPhaseExitStatus: historicalPhaseExit?.status ?? 'UNKNOWN',
    historicalPhaseExitDevelopmentStatus: historicalPhaseExit?.developmentStatus ?? 'UNKNOWN',
    historicalMaterialSourceSetFingerprint: historicalExit.sourceCurrentness?.materialSourceSetFingerprint ?? null,
    ownerReviewValid,
    materialSourceSetFingerprint,
    denominator: 405,
    historicalPathCount: historicalPaths.length,
    currentPathCount: currentPaths.length,
    unchangedPathCount: digestChanges.length <= historicalPaths.length ? historicalPaths.length - digestChanges.length - missingPaths.length : null,
    changedPathCount: digestChanges.length,
    expectedChangedPathCount: ownerChanges.length,
    missingPathCount: missingPaths.length,
    additionalPathCount: additionalPaths.length,
    unapprovedChangedPathCount: unapprovedChangedPaths.length,
    missingPaths,
    additionalPaths,
    unapprovedChangedPaths,
    duplicateChangePaths,
    meaningIdCount: ownerChanges.reduce((count, entry) => count + (entry.meaningIdsChangedAtReviewedCut?.length ?? 0), 0),
    changedPathChecks,
  };
}

function catalogPopulationObservation(status) {
  const components = parseYaml(readText('.product-experience/pdp-2-design-interface-system/component-contracts.yaml'));
  const templates = parseYaml(readText('.product-experience/pdp-2-design-interface-system/gui/templates/catalog.yaml'));
  const layouts = parseYaml(readText('.product-experience/pdp-2-design-interface-system/gui/layout.yaml'));
  const recipes = parseYaml(readText('.product-experience/pdp-2-design-interface-system/gui/recipes/catalog.yaml'));
  const composition = parseYaml(readText('.product-experience/pdp-2-design-interface-system/gui/composition-validation-grammar.yaml'));
  const patterns = parseYaml(readText('.product-experience/pdp-2-design-interface-system/gui/patterns/catalog.yaml'));
  const observed = {
    componentFamilies: components.components?.length ?? 0,
    templates: templates.templates?.length ?? 0,
    layouts: layouts.layouts?.length ?? 0,
    recipes: recipes.recipes?.length ?? 0,
    compositionRules: composition.normativeRuleRecords?.length ?? 0,
    interactionPatterns: patterns.patterns?.length ?? 0,
  };
  const expected = {
    componentFamilies: 31,
    templates: 13,
    layouts: 11,
    recipes: 13,
    compositionRules: 42,
    interactionPatterns: 19,
  };
  const matchesHistoricalStatus = Object.entries(expected).every(([key, count]) =>
    observed[key] === count && status.sourcePopulations?.[key] === count);
  const expectedFamilyIds = [...(components.components ?? [])].map((row) => row.id).sort();
  const recordedFamilyIds = [...(status.sourceFamilyIds ?? [])].sort();
  return {
    expected,
    observed,
    historicalStatusPopulations: Object.fromEntries(Object.keys(expected).map((key) => [key, status.sourcePopulations?.[key] ?? null])),
    componentFamilyIds: {
      sourceCount: expectedFamilyIds.length,
      historicalCount: recordedFamilyIds.length,
      exactSetMatches: JSON.stringify(expectedFamilyIds) === JSON.stringify(recordedFamilyIds),
    },
    matchesHistoricalStatus,
  };
}

function externalContractObservation(predecessor) {
  const old = predecessor.sourceCurrentness?.externalOwnerContracts;
  const sourceManifestPath = '.product-experience/source-manifest.yaml';
  const currentManifest = sha256(fs.readFileSync(path.join(root, sourceManifestPath)));
  const priorManifest = predecessor.sourceCurrentness?.sourceContentDigests?.[sourceManifestPath] ?? null;
  const repositories = (old?.repositories ?? []).map((repository) => {
    const externalRoot = path.resolve(root, SOURCE_ROOTS[repository.repositoryId] ?? '');
    return {
      repositoryId: repository.repositoryId,
      recordedRevision: repository.recordedRevision,
      files: repository.files.map((file) => {
        let observedContentSha256 = null;
        try {
          const absolutePath = path.join(externalRoot, ...file.path.split('/'));
          if (fs.statSync(absolutePath).isFile()) observedContentSha256 = sha256(fs.readFileSync(absolutePath));
        } catch {}
        return {
          path: file.path,
          declaredContentSha256: file.declaredContentSha256,
          observedContentSha256,
          digestMatches: observedContentSha256 === file.declaredContentSha256,
        };
      }),
    };
  });
  const files = repositories.flatMap((repository) => repository.files);
  const mismatches = files.filter((file) => !file.digestMatches);
  return {
    totalFiles: files.length,
    digestMatches: files.length - mismatches.length,
    digestMismatches: mismatches,
    repositories,
    sourceManifestMatchesPdp1Predecessor: currentManifest === priorManifest,
    blockers: [...(files.length === 30 && mismatches.length === 0 ? [] : ['EXTERNAL_PUBLIC_CONTRACTS_NOT_CURRENT']), ...(currentManifest === priorManifest ? [] : ['SOURCE_MANIFEST_CHANGED_AFTER_PDP1_EXIT'])],
  };
}

function digestFile(relativePath) {
  return sha256(fs.readFileSync(path.join(root, relativePath)));
}

function validatePairedPdp0(exit, matrix) {
  const p0ExitPath = exit.predecessor?.exitRef;
  if (typeof p0ExitPath !== 'string' || path.isAbsolute(p0ExitPath)
      || path.relative(root, path.resolve(root, p0ExitPath)).startsWith('..')) {
    return { valid: false, phase: 'PDP-0', exitRef: p0ExitPath ?? null, exitDigest: null, materialSourceSetFingerprint: null, status: 'FAIL' };
  }
  const p0 = readJson(p0ExitPath);
  const fingerprint = p0.developmentStatus?.currentMaterialSourceSetFingerprint ?? null;
  const valid = exit.predecessor?.phase === 'PDP-0'
    && exit.predecessor?.status === 'PASS'
    && exit.predecessor?.currentnessValid === true
    && exit.predecessor?.matrixCutMatches === true
    && p0.phase === 'PDP-0'
    && p0.phaseExit?.status === 'PASS'
    && p0.sourceCurrentness?.status === 'PASS'
    && p0.sourceCurrentness?.sourceCurrent === true
    && p0.developmentStatus?.status === 'DEV_COMPLETE'
    && (p0.developmentStatus?.outstandingMeaningIds?.length ?? -1) === 0
    && exit.predecessor?.exitDigest === digestFile(p0ExitPath)
    && fingerprint === exit.predecessor?.materialSourceSetFingerprint
    && matrix.currentCut?.phaseExit === p0ExitPath
    && matrix.currentCut?.currentnessObservation === exit.predecessor?.currentnessRef
    && matrix.currentCut?.materialSourceSetFingerprint === fingerprint;
  return {
    valid,
    phase: 'PDP-0',
    exitRef: p0ExitPath,
    exitDigest: digestFile(p0ExitPath),
    materialSourceSetFingerprint: fingerprint,
    status: valid ? 'PASS' : 'FAIL',
  };
}

function validatePdp1Predecessor(exit, matrix, p1ExitPath, pairedP0) {
  const cells = exit.sourceCurrentness?.cells ?? [];
  const valid = exit.schemaVersion === 'media.discovery-pdp1-currentness-observation.v1'
    && exit.phase === 'PDP-1'
    && exit.phaseExit?.status === 'PASS'
    && exit.sourceCurrentness?.status === 'PASS'
    && exit.sourceCurrentness?.sourceCurrent === true
    && (exit.sourceCurrentness?.blockers?.length ?? -1) === 0
    && exit.developmentStatus?.status === 'DEV_COMPLETE'
    && exit.developmentStatus?.outstandingMeaningIds?.length === 0
    && exit.developmentStatus?.currentMaterialSourceSetFingerprint === exit.sourceCurrentness?.materialSourceSetFingerprint
    && (exit.phaseExit?.blockers?.length ?? -1) === 0
    && cells.length === 50
    && new Set(cells.map((cell) => cell.surfaceId)).size === 50
    && cells.every((cell) => cell.sourceCurrentness === 'CURRENT' && (cell.blockers?.length ?? 0) === 0)
    && exit.predecessor?.phase === 'PDP-0'
    && pairedP0.valid
    && matrix.currentCut?.pdp1PhaseExit === p1ExitPath
    && matrix.currentCut?.pdp1CurrentnessObservation === `${p1ExitPath}#sourceCurrentness`
    && matrix.currentCut?.pdp1MaterialSourceSetFingerprint === exit.developmentStatus.currentMaterialSourceSetFingerprint;
  return {
    valid,
    phase: 'PDP-1',
    exitRef: p1ExitPath,
    exitDigest: digestFile(p1ExitPath),
    materialSourceSetFingerprint: exit.developmentStatus?.currentMaterialSourceSetFingerprint ?? null,
    observationId: exit.observationId,
    cellCount: cells.length,
    status: valid ? 'PASS' : 'FAIL',
  };
}

function makeObservation({ suffix, testRun, p1ExitPath }) {
  const matrix = readJson(MATRIX_PATH);
  const topology = readJson(TOPOLOGY_PATH);
  const registry = parseYaml(readText(REGISTRY_PATH));
  const status = readJson(PDP2_STATUS_PATH);
  const mdc20 = readJson(MDC20_PATH);
  const ownerDirections = readJson(OWNER_DIRECTIONS_PATH);
  const historicalP2Exit = readJson(HISTORICAL_P2_EXIT_PATH);
  const p1Exit = readJson(p1ExitPath);
  const p0Predecessor = validatePairedPdp0(p1Exit, matrix);
  const topologyReview = validateMatrixAndTopology(matrix, topology, registry);
  const predecessor = validatePdp1Predecessor(p1Exit, matrix, p1ExitPath, p0Predecessor);
  const ownerDirection = ownerDirectionObservation();
  const populations = catalogPopulationObservation(status);
  const historicalStatusValid = status.phase === 'PDP-2' && status.status === 'DEV_COMPLETE'
    && Array.isArray(status.outstandingMeaningIds) && status.outstandingMeaningIds.length === 0;
  const dimensions = {
    ownerGraphFingerprint: p1Exit.sourceCurrentness.ownerGraphFingerprint,
    physicalCatalogFingerprint: p1Exit.sourceCurrentness.physicalCatalogFingerprint,
    providerRegistryFingerprint: p1Exit.sourceCurrentness.providerRegistryFingerprint,
  };
  const availablePaths = trackedPathSet();
  const currentnessCells = buildCellPaths(topologyReview.cells, topology, status, availablePaths, []);
  const technical = observeMediaDiscoveryCurrentness(root, currentnessCells.map((cell) => ({
    ...cell,
    ...dimensions,
  })));
  const lifecycleCaptures = testRun.sourceBinding?.after ?? [];
  const lifecycleConsistent = testRun.sourceBinding?.stable === true
    && testRun.startedHead === testRun.completedHead
    && testRun.completedHead === git(['rev-parse', 'HEAD'])
    && lifecycleCaptures.every((capture) => capture.status === 'CURRENT'
      && capture.continuity === 'CONTINUOUS'
      && capture.membershipChangeState === 'KNOWN'
      && capture.additions === 0 && capture.removals === 0 && capture.changedPaths === 0 && capture.externalChanges === 0)
    && technical.sourceToken === testRun.sourceBinding.sourceToken
    && technical.contentFingerprint === testRun.sourceBinding.contentFingerprint
    && technical.pathMembershipDigest === testRun.sourceBinding.pathMembershipDigest;
  const currentDigests = Object.fromEntries(Object.entries(technical.cells[0]?.fileContentDigests ?? {}));
  const phaseOwnerReview = pdp2OwnerReview(ownerDirections);
  const phaseOwnerChanges = phaseOwnerReview?.sourceChanges ?? [];
  const pins = sourcePinReview(status, currentDigests, mdc20, phaseOwnerChanges);
  const externalContracts = externalContractObservation(p1Exit);
  const observedCells = technical.cells.map((cell) => {
    const sourceSetFingerprint = hashValue({
      schemaVersion: 'media.pdp2-phase-cell-material.v1',
      cellId: cell.cellId,
      owner: cell.owner,
      applicability: cell.applicability,
      expectedPaths: cell.expectedPaths,
      fileContentDigests: cell.fileContentDigests,
    });
    const matrixCell = topologyReview.cells.find((candidate) => candidate.surfaceId === cell.surfaceId);
    return {
      cellId: cell.cellId,
      surfaceId: cell.surfaceId,
      cellType: cell.cellType,
      owner: matrixCell?.owner ?? null,
      ownerAuthorityRef: matrixCell?.ownerAuthorityRef ?? null,
      applicability: cell.applicability,
      sourceCurrentness: cell.sourceCurrentness,
      expectedPathCount: cell.expectedPaths?.length ?? 0,
      expectedPathSetFingerprint: hashValue(cell.expectedPaths ?? []),
      sourceSetFingerprint,
      expectedPaths: cell.expectedPaths ?? [],
      fileContentDigests: cell.fileContentDigests ?? {},
      blockers: [...new Set([...(cell.blockers ?? []), ...topologyReview.errors.filter((error) => error.includes(cell.surfaceId))])],
    };
  });
  const currentCellsPass = observedCells.length === 50
    && new Set(observedCells.map((cell) => cell.cellId)).size === 50
    && observedCells.every((cell) => cell.sourceCurrentness === 'CURRENT' && cell.blockers.length === 0);
  const ownerDirectionPass = ownerDirection.status === 'APPROVED_DESIGN_DIRECTION';
  const testOutcome = testRun.outcomes.find((outcome) => outcome.command === PDP2_TEST_COMMAND);
  const localOutcome = testRun.outcomes.find((outcome) => outcome.command === LOCAL_CHECK_COMMAND);
  const testInputsCurrent = PDP2_TEST_FILES.every((sourcePath) => {
    const observed = currentDigests[sourcePath];
    const bound = testRun.sourceBinding?.testInputContentDigests?.[sourcePath];
    return observed === bound;
  });
  const testsPass = localOutcome?.status === 'PASS' && localOutcome.exitCode === 0
    && testOutcome?.status === 'PASS' && testOutcome.exitCode === 0
    && Number.isInteger(testOutcome.testCount) && testOutcome.testCount > 0
    && testOutcome.passedCount === testOutcome.testCount
    && testOutcome.failedCount === 0 && testOutcome.skippedCount === 0
    && testInputsCurrent && lifecycleConsistent;
  const predecessorDigest = digestFile(p1ExitPath);
  const matrixDigest = digestFile(MATRIX_PATH);
  const sourceSetByPath = {};
  for (const cell of observedCells) {
    for (const [sourcePath, digest] of Object.entries(cell.fileContentDigests)) {
      if (sourceSetByPath[sourcePath] && sourceSetByPath[sourcePath] !== digest) throw new Error(`Inconsistent Lifecycle digest for ${sourcePath}`);
      sourceSetByPath[sourcePath] = digest;
    }
  }
  const materialSourceSetFingerprint = hashValue({
    schemaVersion: 'media.pdp2-material-source-set.v1',
    phase: 'PDP-2',
    predecessor: predecessor.materialSourceSetFingerprint,
    pairedPdp0Predecessor: p0Predecessor.materialSourceSetFingerprint,
    mdc20DispositionDigest: sha256(fs.readFileSync(path.join(root, MDC20_PATH))),
    cells: observedCells.map((cell) => ({ cellId: cell.cellId, sourceSetFingerprint: cell.sourceSetFingerprint })).sort((a, b) => a.cellId.localeCompare(b.cellId)),
  });
  const ownershipJoin = ownerStatusJoin(historicalP2Exit, sourceSetByPath, phaseOwnerReview, materialSourceSetFingerprint);
  const sourceBlockers = [
    ...topologyReview.errors,
    ...(predecessor.valid ? [] : ['PDP1_PREDECESSOR_EXIT_NOT_PASS_OR_MATRIX_MISMATCH']),
    ...(p0Predecessor.valid ? [] : ['PDP0_PAIRED_PREDECESSOR_EXIT_NOT_PASS_OR_MATRIX_MISMATCH']),
    ...(ownerDirectionPass ? [] : ['DELEGATED_PDP2_DESIGN_DIRECTION_MISSING_OR_CONTRADICTORY']),
    ...(historicalStatusValid ? [] : ['HISTORICAL_PDP2_STATUS_INCONSISTENT_OR_OUTSTANDING_TASKS']),
    ...(populations.matchesHistoricalStatus && populations.componentFamilyIds.exactSetMatches ? [] : ['PDP2_CATALOG_POPULATIONS_OR_FAMILY_IDENTITIES_MISMATCH']),
    ...(mdc20.result?.status === 'PASS' && mdc20.pinReview?.unclassifiedChangedPins?.length === 0 ? [] : ['MDC20_DRIFT_DISPOSITION_NOT_PASS']),
    ...(pins.changedPinCount === 4 && pins.expectedChangedPathsMatch && pins.unclassifiedChangedPins.length === 0 && pins.missingPinCount === 0 ? [] : ['PDP2_HISTORICAL_PIN_DRIFT_UNCLASSIFIED_OR_UNEXPECTED']),
    ...(ownershipJoin.status === 'PASS' ? [] : ['PDP2_OWNER_STATUS_JOIN_NOT_PASS']),
    ...externalContracts.blockers,
    ...(currentCellsPass ? [] : ['ONE_OR_MORE_PDP2_CELLS_NOT_CURRENT']),
    ...(testsPass ? [] : ['REQUIRED_PDP2_CHECKS_OR_SOURCE_BINDING_INVALID']),
    ...(Object.keys(sourceSetByPath).length === 405 ? [] : ['PDP2_MATERIAL_PATH_DENOMINATOR_MISMATCH']),
  ];
  const currentnessPass = sourceBlockers.length === 0;
  const requiredChecks = testRun.outcomes;
  const sourceSetDigests = {
    sourcePathCount: Object.keys(sourceSetByPath).length,
    commonPathCount: observedCells.length ? Object.keys(observedCells[0].fileContentDigests).length : 0,
    sharedPathCount: Object.keys(sourceSetByPath).filter((sourcePath) => observedCells.every((cell) => Object.hasOwn(cell.fileContentDigests, sourcePath))).length,
    sourceContentDigests: sourceSetByPath,
  };
  return {
    schemaVersion: 'media.discovery-pdp2-currentness-observation.v1',
    observationId: `MEDIA-PDP2-CURRENTNESS-${suffix.toUpperCase()}`,
    observedAt: new Date().toISOString(),
    campaign: {
      repository: 'samujjwal/ghatana-media',
      branch: git(['branch', '--show-current']),
      observedHead: git(['rev-parse', 'HEAD']),
      observedOriginMain: git(['rev-parse', 'origin/main']),
      scope: 'Repository-wide Media Discovery; PDP-2 only.',
      historicalBaselineSha: status.mainSha,
    },
    phase: 'PDP-2',
    predecessor: {
      ...predecessor,
      exitDigest: predecessorDigest,
      status: predecessor.valid ? 'PASS' : 'FAIL',
    },
    decisionInputs: {
      p1Exit: { ref: p1ExitPath, sha256: predecessorDigest, materialSourceSetFingerprint: predecessor.materialSourceSetFingerprint },
      p0Exit: { ref: p0Predecessor.exitRef, sha256: p0Predecessor.exitDigest, materialSourceSetFingerprint: p0Predecessor.materialSourceSetFingerprint },
      matrix: { ref: MATRIX_PATH, sha256: matrixDigest, includedIn405PathMaterialDenominator: false },
      ownerDirections: { ref: OWNER_DIRECTIONS_PATH, sha256: digestFile(OWNER_DIRECTIONS_PATH), includedIn405PathMaterialDenominator: false },
      runner: { ref: RUNNER_PATH, sha256: digestFile(RUNNER_PATH), includedIn405PathMaterialDenominator: false },
      historicalP2Exit: { ref: HISTORICAL_P2_EXIT_PATH, sha256: digestFile(HISTORICAL_P2_EXIT_PATH), includedIn405PathMaterialDenominator: false },
    },
    authority: {
      delegatedOwnerDirection: ownerDirection,
      exactPdp2SourceCutOwnerAcceptance: 'NOT_RECORDED',
      independentHumanOrQualifiedSignoff: 'NOT_CLAIMED',
      sharedPublicArtifactAcceptance: 'NOT_CLAIMED',
      productionHostAdmission: 'NOT_CLAIMED',
    },
    historicalDefinitionStatus: {
      status: status.status,
      outstandingMeaningIds: status.outstandingMeaningIds,
      historicalMainSha: status.mainSha,
      sourcePinCount: Object.keys(status.sourceShaSet ?? {}).length,
      sourcePopulations: status.sourcePopulations,
    },
    catalogPopulations: populations,
    mdc20Disposition: {
      observationRef: MDC20_PATH,
      observationDigest: sha256(fs.readFileSync(path.join(root, MDC20_PATH))),
      taskId: 'MDC-20',
      status: mdc20.result?.status ?? 'UNKNOWN',
      changedPinCount: mdc20.pinReview?.changedCount ?? null,
      unclassifiedChangedPins: mdc20.pinReview?.unclassifiedChangedPins ?? [],
      newMeaningTaskIds: mdc20.phaseLocalMeaningTasks?.taskIds ?? [],
    },
    historicalPinReview: pins,
    ownerStatusJoin: ownershipJoin,
    sourceCurrentness: {
      status: currentnessPass ? 'PASS' : 'FAIL',
      sourceCurrent: currentnessPass,
      lifecycle: {
        authoritySchema: technical.authoritySchema,
        captureModel: technical.captureModel,
        continuity: technical.continuity,
        sourceToken: technical.sourceToken,
        contentFingerprint: technical.contentFingerprint,
        pathMembershipDigest: technical.pathMembershipDigest,
        consistencyStable: lifecycleConsistent,
        zeroWorkEligibleAtCapture: technical.zeroWorkEligible,
        priming: testRun.sourceBinding?.lifecyclePriming ?? [],
        testBoundCaptures: testRun.sourceBinding?.after ?? [],
        blockers: technical.blockers,
      },
      denominators: { physicalCandidates: 26, semanticCompositions: 6, repositoryRoots: 1, consumerBindings: 17, totalCells: observedCells.length, materialPaths: 405, observedMaterialPaths: Object.keys(sourceSetByPath).length },
      sourceSetDigests,
      ownerGraphFingerprint: dimensions.ownerGraphFingerprint,
      physicalCatalogFingerprint: dimensions.physicalCatalogFingerprint,
      providerRegistryFingerprint: dimensions.providerRegistryFingerprint,
      materialSourceSetFingerprint,
      externalOwnerContracts: externalContracts,
      cells: observedCells,
      blockers: sourceBlockers,
    },
    requiredChecks: {
      status: testsPass ? 'PASS' : 'FAIL',
      sourceBoundToCurrentCut: testsPass,
      outcomes: requiredChecks,
      sourceBinding: testRun.sourceBinding,
    },
    accessibilityEvidenceBoundary: {
      authorityRef: '.product-experience/pdp-2-design-interface-system/accessibility.yaml',
      definitionStatus: 'SOURCE_CURRENT_DEFINITION_ONLY',
      prescribedSuiteMeasuresRenderedOrAssistiveTechnologyBehavior: false,
      renderedAndAssistiveTechnologyAcceptance: 'NOT_RUN_NOT_CLAIMED',
      independentCertification: 'NOT_CLAIMED',
      separateEvidenceRequiredForSuchAcceptance: true,
    },
    currentPhaseExit: {
      status: currentnessPass ? 'PASS' : 'FAIL',
      sourceCurrentness: currentnessPass ? 'PASS' : 'FAIL',
      developmentStatus: currentnessPass ? 'DEV_COMPLETE' : 'IN_PROGRESS',
      delegatedOwnerDirection: ownerDirection.status,
      exactCutOwnerAcceptance: 'NOT_RECORDED',
      requiredChecks: testsPass ? 'PASS' : 'FAIL',
      blockers: sourceBlockers,
      nextLegalAction: currentnessPass ? 'ADVANCE_TO_PDP3_MDC30' : 'REPAIR_MDC20_OR_MDC21_BLOCKERS_AND_RECAPTURE_PDP2',
    },
    independentApproval: 'NOT_CLAIMED_AND_NOT_WAIVED',
    lifecycleClosure: 'NOT_ENTERED',
    build: 'NOT_ENTERED',
    delivery: 'BLOCKED',
  };
}

function main() {
  const suffix = process.argv[2];
  const requestedP1ExitPath = process.argv[3];
  if (!/^[a-z0-9-]+$/u.test(suffix ?? '')) {
    process.stderr.write('Usage: node scripts/capture-media-discovery-pdp2-current-cut.mjs <fresh-cut-suffix> [pdp1-exit-path]\n');
    process.exitCode = 2;
    return;
  }
  const outputPath = `docs/implementation/observations/media-discovery-pdp2-exit-${suffix}.json`;
  if (fs.existsSync(path.join(root, outputPath))) throw new Error(`Refusing to overwrite immutable observation: ${outputPath}`);
  const matrix = readJson(MATRIX_PATH);
  const p1ExitPath = path.normalize(requestedP1ExitPath ?? matrix.currentCut?.pdp1PhaseExit ?? '');
  if (!p1ExitPath) throw new Error('Matrix currentCut does not declare the current PDP-1 exit path');
  if (path.isAbsolute(p1ExitPath) || path.relative(root, path.resolve(root, p1ExitPath)).startsWith('..')) {
    throw new Error(`PDP-1 exit path must be repository-relative: ${requestedP1ExitPath}`);
  }
  const p1 = readJson(p1ExitPath);
  const p0Predecessor = validatePairedPdp0(p1, matrix);
  const predecessor = validatePdp1Predecessor(p1, matrix, p1ExitPath, p0Predecessor);
  if (!p0Predecessor.valid || !predecessor.valid) {
    throw new Error(`Refusing to run PDP-2 checks without exact current predecessors: PDP-0=${p0Predecessor.status}, PDP-1=${predecessor.status}`);
  }
  const dimensions = {
    ownerGraphFingerprint: p1.sourceCurrentness.ownerGraphFingerprint,
    physicalCatalogFingerprint: p1.sourceCurrentness.physicalCatalogFingerprint,
    providerRegistryFingerprint: p1.sourceCurrentness.providerRegistryFingerprint,
  };
  const testRun = runRequiredChecks(dimensions);
  const observation = makeObservation({ suffix, testRun, p1ExitPath });
  const absolutePath = path.join(root, outputPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const descriptor = fs.openSync(absolutePath, 'wx');
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(observation, null, 2)}\n`);
  } finally {
    fs.closeSync(descriptor);
  }
  process.stdout.write(`${JSON.stringify({ outputPath, phaseExit: observation.currentPhaseExit, materialSourceSetFingerprint: observation.sourceCurrentness.materialSourceSetFingerprint, cellCount: observation.sourceCurrentness.cells.length }, null, 2)}\n`);
  if (observation.currentPhaseExit.status !== 'PASS') process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
