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
const PDP3_STATUS_GUARD_SUPPLEMENT_PATH = 'docs/implementation/observations/media-discovery-predecessor-impact-pdp3-status-guard-2026-10-14-r1.json';
const PDP2_SUPPLEMENT_CUT_PATH = 'docs/implementation/observations/media-discovery-pdp2-exit-2026-10-14-current-cut-r3.json';
const PDP2_CURRENT_CUT_IMPACT_PATH = 'docs/implementation/observations/media-discovery-pdp2-current-cut-source-impact-2026-10-14-r1.json';
const PDP2_CURRENT_CUT_PREDECESSOR_PATH = 'docs/implementation/observations/media-discovery-pdp2-exit-2026-10-14-current-cut-r4.json';
const PDP1_CURRENT_CUT_EXIT_PATH = 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r13.json';
const PDP1_STATUS_PATH = 'docs/implementation/pdp-1-phase-dev-status.json';
const PDP1_SEMANTIC_REVIEW_PATH = 'docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json';
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

export function aggregateCurrentCellDigests(cells) {
  const aggregate = {};
  for (const cell of cells ?? []) {
    for (const [sourcePath, digest] of Object.entries(cell.fileContentDigests ?? {})) {
      if (aggregate[sourcePath] && aggregate[sourcePath] !== digest) {
        throw new Error(`Conflicting current cell digests for ${sourcePath}`);
      }
      aggregate[sourcePath] = digest;
    }
  }
  return aggregate;
}

function pdp3StatusGuardSupplement(historicalExit, currentDigests) {
  const supplement = readJson(PDP3_STATUS_GUARD_SUPPLEMENT_PATH);
  const impactP2Cut = readJson(PDP2_SUPPLEMENT_CUT_PATH);
  const currentP2Baseline = readJson(PDP2_CURRENT_CUT_PREDECESSOR_PATH);
  const delta = supplement.sourceDelta;
  const pathDigest = currentP2Baseline.sourceCurrentness?.sourceSetDigests?.sourceContentDigests?.[delta?.path] ?? null;
  const valid = supplement.schemaVersion === 'media.discovery-predecessor-source-impact.v1'
    && supplement.recordId === 'MEDIA-DISCOVERY-PREDECESSOR-IMPACT-PDP3-STATUS-GUARD-2026-10-14-R1'
    && delta?.path === 'scripts/report-media-pdp-readiness.mjs'
    && delta.predecessorSha256 === 'sha256:6655e0344b7f4b03f6ca0b7e594a5448eed72ae5aeac198cef4bb1b28252028c'
    && delta.observedSha256 === 'sha256:f3482cf689e0be2d8dc9faf9ccc72a1b63a1dcaecd056efaa1759e6f3696a5e1'
    && pathDigest === delta.observedSha256
    && supplement.campaign?.activePhase === 'PDP-0'
    && supplement.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION'
    && supplement.authority?.humanIndependentSignatureProvided === false
    && supplement.authority?.qualifiedExternalSpecialistSignoffProvided === false
    && supplement.authority?.externalContractOwnerAcceptanceProvided === false
    && supplement.authority?.nativeLifecycleReceiptProvided === false
    && delta.predecessorPhaseMeaningDisposition?.['PDP-2'] === 'NO_MEANING_CHANGE'
    && delta.freshCurrentnessRequired === true
    && supplement.decision?.status === 'APPROVED_INTERNAL_NON_IMPACT_FOR_EXACT_SOURCE_DELTA'
    && supplement.decision?.requiresOrderedTechnicalCurrentnessRecapture?.length === 3
    && JSON.stringify(supplement.decision.requiresOrderedTechnicalCurrentnessRecapture) === JSON.stringify(['PDP-0', 'PDP-1', 'PDP-2'])
    && supplement.decision?.preserveHistoricalReceipts === true
    && supplement.decision?.independentApproval === 'NOT_CLAIMED_AND_NOT_WAIVED'
    && supplement.decision?.nativeLifecycleClosure === 'NOT_ENTERED'
    && supplement.predecessorCuts?.filter((cut) => cut.phase === 'PDP-2').length === 1
    && supplement.predecessorCuts?.some((cut) => cut.phase === 'PDP-2'
      && cut.receiptRef === PDP2_SUPPLEMENT_CUT_PATH
      && cut.receiptSha256 === digestFile(PDP2_SUPPLEMENT_CUT_PATH)
      && cut.materialSourceSetFingerprint === 'sha256:725bd6097f4ba654569a76f9f5e248d3362c4c5123194796130e8890bf06921b'
      && cut.materialPathCount === 405
      && cut.recordedPathDigest === delta.predecessorSha256)
    && impactP2Cut.sourceCurrentness?.materialSourceSetFingerprint === 'sha256:725bd6097f4ba654569a76f9f5e248d3362c4c5123194796130e8890bf06921b'
    && impactP2Cut.sourceCurrentness?.sourceSetDigests?.sourceContentDigests?.[delta.path] === delta.predecessorSha256
    && historicalExit.sourceCurrentness?.sourceSetDigests?.sourceContentDigests?.[delta.path] === delta.predecessorSha256;
  return {
    valid,
    ref: PDP3_STATUS_GUARD_SUPPLEMENT_PATH,
    path: delta?.path ?? null,
    predecessorSha256: delta?.predecessorSha256 ?? null,
    currentSha256: pathDigest,
    materialSourceSetFingerprint: supplement.predecessorCuts?.find((cut) => cut.phase === 'PDP-2')?.materialSourceSetFingerprint ?? null,
    materialPathCount: supplement.predecessorCuts?.find((cut) => cut.phase === 'PDP-2')?.materialPathCount ?? null,
    delegatedAuthority: supplement.authority?.delegate ?? null,
    predecessorMeaningDisposition: delta?.predecessorPhaseMeaningDisposition?.['PDP-2'] ?? null,
    freshCurrentnessRequired: delta?.freshCurrentnessRequired === true,
    independentOrExternalOrLifecycleClaims: false,
  };
}

export function validatePdp2CurrentCutImpact({ impact, predecessor, currentDigests, actualCurrentDigests, predecessorDigest, impactDigest }) {
  const expectedTransitions = [
    {
      path: '.product-experience/interface-parity/current-source-review.json',
      predecessorSha256: 'sha256:14cf6c3d9ea948e39e41ffa2de3453c08b7b6a23267f407f3504c5462b7428fc',
      observedSha256: 'sha256:62765cbb335572f28570fe650b3955aaa028f314322490e17e466d3ca9234abf',
      classification: 'PDP2_INTERFACE_REVIEW_ARTIFACT_REFRESH',
    },
    {
      path: 'scripts/report-media-pdp-readiness.mjs',
      predecessorSha256: 'sha256:f3482cf689e0be2d8dc9faf9ccc72a1b63a1dcaecd056efaa1759e6f3696a5e1',
      observedSha256: 'sha256:ca59f6c4e1313bd58387f91b41eb51fc1a10ac04b2db01faed30b9edcc9b2573',
      classification: 'PDP_STATUS_TEST_REPORTER_SELECTION_ONLY',
    },
  ];
  const p2Exit = predecessor?.sourceCurrentness;
  const predecessorDigests = p2Exit?.sourceSetDigests?.sourceContentDigests ?? {};
  const currentPaths = Object.keys(currentDigests ?? {}).sort();
  const predecessorPaths = Object.keys(predecessorDigests).sort();
  const predecessorSet = new Set(predecessorPaths);
  const currentSet = new Set(currentPaths);
  const missingPaths = predecessorPaths.filter((sourcePath) => !currentSet.has(sourcePath));
  const additionalPaths = currentPaths.filter((sourcePath) => !predecessorSet.has(sourcePath));
  const pathChanges = predecessorPaths.filter((sourcePath) => currentDigests?.[sourcePath] !== predecessorDigests[sourcePath]);
  const deltas = impact?.sourceDeltas;
  const transitionsValid = Array.isArray(deltas) && deltas.length === expectedTransitions.length
    && expectedTransitions.every((expected, index) => {
      const delta = deltas[index];
      return delta?.path === expected.path
        && delta.phase === 'PDP-2'
        && delta.predecessorSha256 === expected.predecessorSha256
        && delta.observedSha256 === expected.observedSha256
        && delta.classification === expected.classification
        && delta.meaningChange === (index === 0 ? 'NO_ADDITIONAL_PDP2_MEANING' : 'NO_PDP2_PRODUCT_DEFINITION_MEANING_CHANGE')
        && delta.requiresFreshCurrentness === true
        && predecessorDigests[delta.path] === delta.predecessorSha256
        && currentDigests?.[delta.path] === delta.observedSha256
        && actualCurrentDigests?.[delta.path] === delta.observedSha256;
    });
  const valid = impact?.schemaVersion === 'media.discovery-pdp2-current-cut-source-impact.v1'
    && impact.recordId === 'MEDIA-DISCOVERY-PDP2-CURRENT-CUT-SOURCE-IMPACT-2026-10-14-R1'
    && impact.campaign?.repository === 'samujjwal/ghatana-media'
    && impact.campaign?.stage === 'DISCOVERY'
    && impact.campaign?.activePhase === 'PDP-2'
    && impact.campaign?.materialSourceSetFingerprint === 'sha256:dcd8eb3ac4e8717ed279fc41e859d87f7fd1a938c5660399b8e086639d2b0a70'
    && impact.campaign?.materialPathCount === 405
    && impact.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION'
    && impact.authority?.decisionRole === 'SCOPED_INTERNAL_MEDIA_PDP2_SOURCE_IMPACT_REVIEW'
    && impact.authority?.userAuthorization === 'Authorize scoped PDP-2 disposition (Recommended)'
    && impact.authority?.authorizationContext === 'The user explicitly authorized this exact bounded disposition: the readiness-script and interface-review paths add no PDP-2 meaning, and PDP-2 is to be recaptured after PDP-1.'
    && impact.authority?.humanIndependentSignatureProvided === false
    && impact.authority?.qualifiedExternalSpecialistSignoffProvided === false
    && impact.authority?.externalContractOwnerAcceptanceProvided === false
    && impact.authority?.nativeLifecycleReceiptProvided === false
    && impact.predecessorCut?.phase === 'PDP-2'
    && impact.predecessorCut?.receiptRef === PDP2_CURRENT_CUT_PREDECESSOR_PATH
    && impact.predecessorCut?.receiptSha256 === predecessorDigest
    && impact.predecessorCut?.materialSourceSetFingerprint === 'sha256:dcd8eb3ac4e8717ed279fc41e859d87f7fd1a938c5660399b8e086639d2b0a70'
    && impact.predecessorCut?.materialPathCount === 405
    && impact.predecessorCut?.receiptStatus === 'HISTORICAL_BASELINE_FOR_SCOPED_IMPACT_DISPOSITION'
    && predecessor?.phase === 'PDP-2'
    && p2Exit?.status === 'PASS'
    && p2Exit?.sourceCurrent === true
    && p2Exit?.materialSourceSetFingerprint === impact.predecessorCut.materialSourceSetFingerprint
    && predecessorPaths.length === 405
    && currentPaths.length === 405
    && missingPaths.length === 0
    && additionalPaths.length === 0
    && pathChanges.filter((sourcePath) => expectedTransitions.some((transition) => transition.path === sourcePath)).length === 2
    && expectedTransitions.every(({ path }) => pathChanges.includes(path))
    && transitionsValid
    && impact.scopeLimits?.onlyTheseExactTwoPathTransitionsAreAuthorized === true
    && impact.scopeLimits?.noOtherPathAuthorizedByThisRecord === true
    && impact.scopeLimits?.pdp2Currentness === 'NOT_ESTABLISHED_REQUIRES_FRESH_RECAPTURE_AFTER_PDP1'
    && impact.scopeLimits?.preserveEarlierReceipts === true
    && impact.scopeLimits?.externalAcceptance === 'NOT_CLAIMED'
    && impact.scopeLimits?.independentSignoff === 'NOT_CLAIMED'
    && impact.scopeLimits?.lifecycleClosure === 'NOT_ENTERED'
    && impact.scopeLimits?.runtimeAdmission === 'NOT_ADMITTED'
    && impact.scopeLimits?.delivery === 'NOT_AUTHORIZED'
    && impact.decision?.status === 'APPROVED_INTERNAL_IMPACT_DISPOSITION_FOR_EXACT_SOURCE_DELTAS'
    && impact.decision?.pdp2MeaningDisposition === 'NO_ADDITIONAL_PDP2_MEANING_IN_THESE_TWO_EXACT_PATH_CHANGES'
    && impact.decision?.requiresFreshCurrentness === true
    && impact.decision?.orderedRecapturePrerequisite === 'PDP-1 currentness must be established before PDP-2 recapture'
    && impact.decision?.preserveHistoricalReceipts === true
    && impact.limitation === 'This is an internal, user-delegated source-impact disposition bound only to the exact two paths and hash transitions above and the identified PDP-2 R4 baseline. It does not establish PDP-2 currentness or phase completion, external acceptance, independent signoff, Lifecycle closure, runtime admission, or Delivery.'
    && impactDigest === 'sha256:a25480d813689b00d3ecd56b55e197cab1a78bbb667aff3d517150c0516b5c94';
  return {
    valid,
    ref: PDP2_CURRENT_CUT_IMPACT_PATH,
    digest: impactDigest ?? null,
    predecessorRef: PDP2_CURRENT_CUT_PREDECESSOR_PATH,
    predecessorDigest: predecessorDigest ?? null,
    predecessorMaterialSourceSetFingerprint: p2Exit?.materialSourceSetFingerprint ?? null,
    materialPathCount: predecessorPaths.length,
    changedPathCount: pathChanges.length,
    changedPaths: pathChanges,
    scopedChangedPaths: expectedTransitions.map(({ path }) => path),
    scopedTransitions: expectedTransitions,
    missingPathCount: missingPaths.length,
    additionalPathCount: additionalPaths.length,
    transitionCount: Array.isArray(deltas) ? deltas.length : 0,
    transitionsValid,
    meaningChangeCount: Array.isArray(deltas) ? deltas.filter((delta) => delta.meaningChange !== 'NO_ADDITIONAL_PDP2_MEANING' && delta.meaningChange !== 'NO_PDP2_PRODUCT_DEFINITION_MEANING_CHANGE').length : null,
    independentOrExternalOrLifecycleClaims: false,
  };
}

export function validatePdp1EvidenceRefresh({ predecessor, currentDigests, actualCurrentDigests, pdp1Exit, pdp1ExitDigest, statusSource, semanticReviewSource, operationsSourceText, operationsReviewText, operationsReviewSource }) {
  const paths = [PDP1_STATUS_PATH, PDP1_SEMANTIC_REVIEW_PATH];
  const expected = {
    [PDP1_STATUS_PATH]: 'sha256:ee7b68839a6fba3745f27183ce13ec45d9b90e32f0f5df376952f4bde40ae23b',
    [PDP1_SEMANTIC_REVIEW_PATH]: 'sha256:ab5ebe42f834ec604f4bd0cd525f0b779d58fdd73ff0851d731669ef132eb680',
  };
  const predecessorDigests = predecessor?.sourceCurrentness?.sourceSetDigests?.sourceContentDigests ?? {};
  const pdp1ExitCurrentPins = pdp1Exit?.sourceCurrentness?.sourceContentDigests ?? {};
  const statusSourcePins = statusSource?.sourceShaSet ?? {};
  const historicalPinReview = pdp1Exit?.authority?.historicalPinReview;
  const testEvidence = pdp1Exit?.ownerStatusJoin?.testEvidence;
  const definitionReview = pdp1Exit?.ownerStatusJoin?.supplementalPdp1DefinitionReview;
  const expectedDefinitionIds = [
    'media.observation-contract.rights-decision.v1',
    'media.observation-contract.destination-delivery-acknowledgment.v1',
    'media.observation-contract.delegated-integration-result-context.v1',
    'media.observation-contract.processing-parameter-read.v1',
    'media.observation-contract.effective-processing-constraints.v1',
  ];
  const semanticDefinitionReview = (semanticReviewSource?.supplementaryReviews ?? [])
    .find((review) => review.id === 'P1-current-owner-typed-observation-definition-delta-2026-10-14');
  const operationDelta = operationsReviewSource?.currentSourceCutDeltaReview?.supplementalPdp1DefinitionDelta;
  const operationDeltaIds = operationDelta?.reviewedRecords?.map((record) => record.id) ?? [];
  const semanticDefinitionIdsMatch = Array.isArray(definitionReview?.reviewedDefinitionIds)
    && definitionReview.reviewedDefinitionIds.length === expectedDefinitionIds.length
    && expectedDefinitionIds.every((id, index) => definitionReview.reviewedDefinitionIds[index] === id)
    && operationDeltaIds.length === expectedDefinitionIds.length
    && expectedDefinitionIds.every((id, index) => operationDeltaIds[index] === id);
  const operationSourceSha256 = definitionReview?.observedSha256?.replace(/^sha256:/u, '');
  const operationReviewSha256 = definitionReview?.reviewArtifactObservedSha256?.replace(/^sha256:/u, '');
  const liveOperationsSha256 = typeof operationsSourceText === 'string'
    ? crypto.createHash('sha256').update(operationsSourceText).digest('hex') : null;
  const liveOperationsReviewSha256 = typeof operationsReviewText === 'string'
    ? crypto.createHash('sha256').update(operationsReviewText).digest('hex') : null;
  let operationsSource;
  try { operationsSource = parseYaml(operationsSourceText ?? ''); } catch { operationsSource = null; }
  const definitionReviewSourceBindingsMatch = definitionReview?.sourcePath === '.product-experience/pdp-1-domain-data/operations.yaml'
    && definitionReview?.sourceReviewPath === '.product-experience/pdp-1-domain-data/operations-current-source-review.json'
    && definitionReview?.observedSha256 === `sha256:${operationSourceSha256}`
    && definitionReview?.reviewArtifactObservedSha256 === `sha256:${operationReviewSha256}`
    && liveOperationsSha256 === operationSourceSha256
    && liveOperationsReviewSha256 === operationReviewSha256
    && pdp1ExitCurrentPins[definitionReview.sourcePath] === `sha256:${operationSourceSha256}`
    && pdp1ExitCurrentPins[definitionReview.sourceReviewPath] === `sha256:${operationReviewSha256}`
    && statusSourcePins[definitionReview.sourcePath] === operationSourceSha256
    && statusSourcePins[definitionReview.sourceReviewPath] === operationReviewSha256
    && operationsSource?.ownerTypedObservationContracts?.records?.length === 12
    && expectedDefinitionIds.every((id, index) => operationsSource.ownerTypedObservationContracts.records.some((record) => record.id === id))
    && semanticReviewSource?.sourceFingerprints?.[definitionReview.sourcePath] === operationSourceSha256
    && semanticReviewSource?.sourceFingerprints?.[definitionReview.sourceReviewPath] === operationReviewSha256
    && operationsReviewSource?.currentSourceCutDeltaReview?.currentSourceSha256 === operationSourceSha256
    && operationDelta?.sourceReviewArtifactPath === definitionReview.sourceReviewPath
    && operationDelta?.predecessorReviewArtifactSha256 === definitionReview.reviewArtifactPredecessorSha256
    && operationDelta?.reviewArtifactDisposition === 'SOURCE_REVIEW_EVIDENCE_REFRESH_FOR_THE_EXACT_PDP1_SEMANTIC_DELTA'
    && operationsReviewSource?.currentSourceCutDeltaReview?.supplementalPdp1DefinitionDelta?.predecessorSourceSha256 === definitionReview.predecessorSha256?.replace(/^sha256:/u, '')
    && operationDelta?.schemaVersion === 'media.pdp1-operation-definition-delta-review.v1'
    && operationDelta?.status === 'REVIEWED_CURRENT_SOURCE_SEMANTIC_DELTA'
    && operationDelta?.predecessorSourceSha256 === definitionReview.predecessorSha256?.replace(/^sha256:/u, '')
    && operationDelta?.currentSourceSha256 === operationSourceSha256
    && operationDelta?.materiality === 'PDP1_NORMATIVE_DEFINITION_CHANGE_REQUIRING_OWNING_PHASE_REVIEW_AND_FRESH_CURRENTNESS'
    && operationDelta?.reviewedRecords?.every((record, index) => record.id === expectedDefinitionIds[index]
      && record.selector === `.product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=${expectedDefinitionIds[index]}`
      && typeof record.meaning === 'string' && record.meaning.length > 0)
    && semanticDefinitionReview?.disposition === 'CURRENT_SOURCE_SEMANTIC_DELTA_REVIEWED_UNDER_USER_DELEGATION'
    && semanticDefinitionReview?.sourceSha256 === operationSourceSha256
    && semanticDefinitionReview?.reviewRef === '.product-experience/pdp-1-domain-data/operations-current-source-review.json#currentSourceCutDeltaReview/supplementalPdp1DefinitionDelta'
    && semanticDefinitionReview?.meaning?.includes('These are definition changes in PDP-1, not a no-meaning disposition.')
    && semanticDefinitionReview?.reviewedPopulationIdsPreserved === 2023;
  const cells = pdp1Exit?.sourceCurrentness?.cells;
  const currentCriteria = Object.values(statusSource?.directDevelopmentCriteria ?? {});
  const currentExecutedCriteria = Object.values(statusSource?.testsActuallyRun ?? {});
  const currentStatusTestCount = currentExecutedCriteria.reduce((sum, item) => sum + (item.testCount ?? 0), 0);
  const currentStatusPassedCount = currentExecutedCriteria.reduce((sum, item) => sum + (item.passedTestCount ?? 0), 0);
  const currentStatusSkippedCount = currentExecutedCriteria.reduce((sum, item) => sum + (item.skippedTestCount ?? 0), 0);
  const currentIdentityIds = statusSource?.sourceIdentityIds ?? [];
  const reviewedIdentityIds = semanticReviewSource?.reviewedIdentityIds ?? [];
  const currentIdentitySet = new Set(currentIdentityIds);
  const reviewedIdentitySet = new Set(reviewedIdentityIds);
  const identitySetsMatch = currentIdentityIds.length === reviewedIdentityIds.length
    && currentIdentitySet.size === currentIdentityIds.length
    && reviewedIdentitySet.size === reviewedIdentityIds.length
    && currentIdentityIds.every((identity) => reviewedIdentitySet.has(identity))
    && reviewedIdentityIds.every((identity) => currentIdentitySet.has(identity));
  const supersededPhaseReviewMarker = semanticReviewSource?.currentCutReview?.verificationStatus;
  const supersededParityMarker = semanticReviewSource?.currentCutReview?.parityTestPinDispositionReview?.verificationStatus;
  const historicalFullGate = semanticReviewSource?.currentCutReview?.definitionContractRefresh?.verificationEvidence?.fullPhaseGate;
  const currentHashesMatch = paths.every((sourcePath) => predecessorDigests[sourcePath] === expected[sourcePath]
    && currentDigests?.[sourcePath] === actualCurrentDigests?.[sourcePath]
    && DIGEST.test(actualCurrentDigests?.[sourcePath] ?? ''));
  const valid = predecessor?.phase === 'PDP-2'
    && predecessor?.sourceCurrentness?.status === 'PASS'
    && predecessor?.sourceCurrentness?.sourceCurrent === true
    && predecessor?.sourceCurrentness?.materialSourceSetFingerprint === 'sha256:dcd8eb3ac4e8717ed279fc41e859d87f7fd1a938c5660399b8e086639d2b0a70'
    && predecessorDigests[PDP1_STATUS_PATH] === expected[PDP1_STATUS_PATH]
    && predecessorDigests[PDP1_SEMANTIC_REVIEW_PATH] === expected[PDP1_SEMANTIC_REVIEW_PATH]
    && currentDigests?.[PDP1_STATUS_PATH] === actualCurrentDigests?.[PDP1_STATUS_PATH]
    && currentDigests?.[PDP1_SEMANTIC_REVIEW_PATH] === actualCurrentDigests?.[PDP1_SEMANTIC_REVIEW_PATH]
    && pdp1Exit?.phase === 'PDP-1'
    && pdp1Exit?.testRun?.startedHead === pdp1Exit?.campaign?.observedHead
    && pdp1Exit?.testRun?.completedHead === pdp1Exit?.campaign?.observedHead
    && pdp1Exit?.phaseExit?.status === 'PASS'
    && pdp1Exit?.phaseExit?.sourceCurrentness === 'PASS'
    && pdp1Exit?.developmentStatus?.status === 'DEV_COMPLETE'
    && pdp1Exit?.developmentStatus?.outstandingMeaningIds?.length === 0
    && pdp1Exit?.sourceCurrentness?.status === 'PASS'
    && pdp1Exit?.sourceCurrentness?.materialPathDenominator?.uniquePaths === 329
    && Array.isArray(cells) && cells.length === 50
    && pdp1Exit?.ownerStatusJoin?.predecessorPathCount === 329
    && pdp1Exit?.ownerStatusJoin?.observedPathCount === 329
    && pdp1Exit?.ownerStatusJoin?.missingPathCount === 0
    && pdp1Exit?.ownerStatusJoin?.additionalPathCount === 0
    && testEvidence?.status === 'PASS'
    && testEvidence?.testCount === 75
    && testEvidence?.passedCount === 75
    && testEvidence?.failedCount === 0
    && testEvidence?.skippedCount === 0
    && historicalPinReview?.historicalStatusPinCount === 113
    && historicalPinReview?.historicalStatusCurrentPinCount === 113
    && historicalPinReview?.historicalStatusChangedPinCount === 0
    && historicalPinReview?.historicalStatusMissingPinCount === 0
    && historicalPinReview?.historicalSemanticReviewPinCount === 104
    && historicalPinReview?.historicalSemanticReviewCurrentPinCount === 104
    && historicalPinReview?.historicalSemanticReviewChangedPinCount === 0
    && historicalPinReview?.statusPinChanges?.length === 0
    && historicalPinReview?.semanticReviewPinChanges?.length === 0
    && historicalPinReview?.unclassifiedStatusPins?.length === 0
    && historicalPinReview?.unclassifiedSemanticPins?.length === 0
    && pdp1Exit?.authority?.historicalSemanticReviewRef === PDP1_SEMANTIC_REVIEW_PATH
    && statusSource?.status === 'DEV_COMPLETE'
    && statusSource?.mainSha === pdp1Exit?.campaign?.observedHead
    && statusSource?.outstandingMeaningIds?.length === 0
    && Object.keys(statusSource?.sourceShaSet ?? {}).length === 113
    && statusSource?.sourceIdentityIds?.length === 2023
    && currentCriteria.length === 11
    && currentCriteria.every((criterion) => criterion.testStatus === 'PASS')
    && currentStatusTestCount === 343
    && currentStatusPassedCount === 343
    && currentStatusSkippedCount === 0
    && currentExecutedCriteria.length === 11
    && currentExecutedCriteria.every((item) => item.status === 'PASS' && item.testCount === item.passedTestCount && item.skippedTestCount === 0)
    && semanticReviewSource?.schemaVersion === 'media.pdp1-development-semantic-review.v1'
    && semanticReviewSource?.status === 'APPROVED_PDP1_DEVELOPMENT_SEMANTIC_REVIEW'
    && Object.keys(semanticReviewSource?.sourceFingerprints ?? {}).length === 104
    && semanticReviewSource?.reviewedIdentityIds?.length === 2023
    && semanticReviewSource?.outstandingMeaningIds?.length === 0
    && semanticReviewSource?.sourceCutStable === true
    && currentIdentityIds.length === 2023
    && reviewedIdentityIds.length === 2023
    && identitySetsMatch
    && supersededPhaseReviewMarker === 'Internal current-source semantic review completed for the exact 2026-10-14 operations delta. Full denominator identity and population counts are preserved; current tests and phase-exit capture remain pending. No external acceptance, independent certification, runtime admission, Lifecycle closure, or release readiness is claimed.'
    && supersededParityMarker === 'CURRENT_SOURCE_BOUND_REQUIRED_PDP1_SUITE_PENDING'
    && semanticReviewSource?.currentCutReview?.parityTestPinDispositionReview?.disposition === 'REGRESSION_COVERAGE_ONLY_IF_EXACT_REQUIRED_SUITE_PASSES_WITH_ZERO_SKIPS'
    && historicalFullGate?.status === 'DEV_COMPLETE'
    && historicalFullGate?.testCount === 342
    && historicalFullGate?.passedTestCount === 342
    && historicalFullGate?.skippedTestCount === 0
    && definitionReview?.valid === true
    && semanticDefinitionIdsMatch
    && definitionReviewSourceBindingsMatch
    && definitionReview?.classification === 'PDP1_DEFINITION_SEMANTIC_DELTA_REVIEWED_UNDER_USER_DELEGATION'
    && currentHashesMatch
    && typeof pdp1ExitDigest === 'string' && DIGEST.test(pdp1ExitDigest);
  return {
    valid,
    classification: 'PDP1_STATUS_AND_SEMANTIC_REVIEW_EVIDENCE_REFRESH_NO_PDP2_MEANING_DISPOSITION',
    predecessorRef: PDP2_CURRENT_CUT_PREDECESSOR_PATH,
    successorRef: PDP1_CURRENT_CUT_EXIT_PATH,
    successorDigest: pdp1ExitDigest ?? null,
    paths: paths.map((sourcePath) => ({
      path: sourcePath,
      predecessorSha256: predecessorDigests[sourcePath] ?? null,
      currentSha256: currentDigests?.[sourcePath] ?? null,
      liveSha256: actualCurrentDigests?.[sourcePath] ?? null,
      matches: predecessorDigests[sourcePath] === expected[sourcePath]
        && currentDigests?.[sourcePath] === actualCurrentDigests?.[sourcePath],
    })),
    currentPathCount: Object.keys(currentDigests ?? {}).length,
    predecessorPathCount: Object.keys(predecessorDigests).length,
    pdp1Proof: {
      phaseStatus: pdp1Exit?.phaseExit?.status ?? null,
      developmentStatus: pdp1Exit?.developmentStatus?.status ?? null,
      outstandingMeaningIdCount: pdp1Exit?.developmentStatus?.outstandingMeaningIds?.length ?? null,
      cellCount: cells?.length ?? null,
      materialPathCount: pdp1Exit?.sourceCurrentness?.materialPathDenominator?.uniquePaths ?? null,
      testCount: testEvidence?.testCount ?? null,
      passedCount: testEvidence?.passedCount ?? null,
      historicalStatusPins: [historicalPinReview?.historicalStatusCurrentPinCount, historicalPinReview?.historicalStatusPinCount],
      historicalSemanticReviewPins: [historicalPinReview?.historicalSemanticReviewCurrentPinCount, historicalPinReview?.historicalSemanticReviewPinCount],
      changedOrMissingPinCount: (historicalPinReview?.historicalStatusChangedPinCount ?? -1)
        + (historicalPinReview?.historicalStatusMissingPinCount ?? -1)
        + (historicalPinReview?.historicalSemanticReviewChangedPinCount ?? -1)
        + (historicalPinReview?.statusPinChanges?.length ?? -1)
        + (historicalPinReview?.semanticReviewPinChanges?.length ?? -1),
      currentStatusPhaseTestCount: currentStatusTestCount,
      currentStatusPhasePassedCount: currentStatusPassedCount,
      currentStatusPhaseSkippedCount: currentStatusSkippedCount,
      historicalDefinitionGateTestCount: historicalFullGate?.testCount ?? null,
      historicalDefinitionGatePassedCount: historicalFullGate?.passedTestCount ?? null,
      supersededPhaseReviewMarker,
      supersededParityMarker,
      p1SemanticMeaningIds: definitionReview?.reviewedDefinitionIds ?? [],
      p1SemanticReviewDisposition: definitionReview?.classification ?? null,
      p1DefinitionSourceHashesMatch: definitionReviewSourceBindingsMatch,
      p1DefinitionReviewIdsMatch: semanticDefinitionIdsMatch,
      p1ObservedHead: pdp1Exit?.campaign?.observedHead ?? null,
      currentAndReviewedIdentitySetMatches: identitySetsMatch,
    },
    historicalPendingReconciliation: {
      priorPhaseReviewVerificationStatus: supersededPhaseReviewMarker ?? null,
      priorParityPinVerificationStatus: supersededParityMarker ?? null,
      priorDefinitionGate: {
        status: historicalFullGate?.status ?? null,
        testCount: historicalFullGate?.testCount ?? null,
        passedTestCount: historicalFullGate?.passedTestCount ?? null,
        skippedTestCount: historicalFullGate?.skippedTestCount ?? null,
      },
      currentStatusGate: {
        status: statusSource?.status ?? null,
        testCount: currentStatusTestCount,
        passedTestCount: currentStatusPassedCount,
        skippedTestCount: currentStatusSkippedCount,
      },
      successorPdp1Receipt: {
        ref: PDP1_CURRENT_CUT_EXIT_PATH,
        digest: pdp1ExitDigest ?? null,
        phaseStatus: pdp1Exit?.phaseExit?.status ?? null,
        sourceCurrentness: pdp1Exit?.phaseExit?.sourceCurrentness ?? null,
        developmentStatus: pdp1Exit?.developmentStatus?.status ?? null,
      },
      disposition: 'HISTORICAL_PENDING_MARKERS_SUPERSEDED_BY_PDP1_R13_AND_CURRENT_343_OF_343_STATUS; P1_SEMANTIC_DELTA_REMAINS_SEPARATELY_RECORDED',
    },
  };
}

export function validatePdp2CombinedSourceRefresh({ predecessor, currentDigests, p2Impact, p1EvidenceRefresh }) {
  const predecessorDigests = predecessor?.sourceCurrentness?.sourceSetDigests?.sourceContentDigests ?? {};
  const predecessorPaths = Object.keys(predecessorDigests).sort();
  const currentPaths = Object.keys(currentDigests ?? {}).sort();
  const predecessorSet = new Set(predecessorPaths);
  const currentSet = new Set(currentPaths);
  const missingPaths = predecessorPaths.filter((sourcePath) => !currentSet.has(sourcePath));
  const additionalPaths = currentPaths.filter((sourcePath) => !predecessorSet.has(sourcePath));
  const changedPaths = predecessorPaths.filter((sourcePath) => predecessorDigests[sourcePath] !== currentDigests?.[sourcePath]);
  const expectedChangedPaths = [...(p2Impact?.scopedChangedPaths ?? []), ...(p1EvidenceRefresh?.paths ?? []).map(({ path: sourcePath }) => sourcePath)].sort();
  return {
    valid: p2Impact?.valid === true
      && p1EvidenceRefresh?.valid === true
      && predecessorPaths.length === 405
      && currentPaths.length === 405
      && missingPaths.length === 0
      && additionalPaths.length === 0
      && changedPaths.length === 4
      && changedPaths.sort().every((sourcePath, index) => sourcePath === expectedChangedPaths[index])
      && expectedChangedPaths.length === 4,
    predecessorPathCount: predecessorPaths.length,
    currentPathCount: currentPaths.length,
    changedPathCount: changedPaths.length,
    changedPaths,
    expectedChangedPaths,
    missingPaths,
    additionalPaths,
    pdp1EvidenceRefreshClassification: p1EvidenceRefresh?.classification ?? null,
    pdp2MeaningDispositionAppliedOnlyTo: p2Impact?.scopedChangedPaths ?? [],
  };
}

function pdp2CurrentCutImpact(predecessor, currentDigests) {
  const impact = readJson(PDP2_CURRENT_CUT_IMPACT_PATH);
  const baseline = readJson(PDP2_CURRENT_CUT_PREDECESSOR_PATH);
  const p1Exit = readJson(PDP1_CURRENT_CUT_EXIT_PATH);
  const actualCurrentDigests = Object.fromEntries(Object.keys(currentDigests).map((sourcePath) => [sourcePath, digestFile(sourcePath)]));
  const p2Disposition = validatePdp2CurrentCutImpact({
    impact,
    predecessor: baseline,
    currentDigests,
    actualCurrentDigests,
    predecessorDigest: digestFile(PDP2_CURRENT_CUT_PREDECESSOR_PATH),
    impactDigest: digestFile(PDP2_CURRENT_CUT_IMPACT_PATH),
  });
  const p1EvidenceRefresh = validatePdp1EvidenceRefresh({
    predecessor: baseline,
    currentDigests,
    actualCurrentDigests,
    pdp1Exit: p1Exit,
    pdp1ExitDigest: digestFile(PDP1_CURRENT_CUT_EXIT_PATH),
    statusSource: readJson(PDP1_STATUS_PATH),
    semanticReviewSource: readJson(PDP1_SEMANTIC_REVIEW_PATH),
    operationsSourceText: fs.readFileSync(path.resolve(root, '.product-experience/pdp-1-domain-data/operations.yaml'), 'utf8'),
    operationsReviewText: fs.readFileSync(path.resolve(root, '.product-experience/pdp-1-domain-data/operations-current-source-review.json'), 'utf8'),
    operationsReviewSource: readJson('.product-experience/pdp-1-domain-data/operations-current-source-review.json'),
  });
  const combined = validatePdp2CombinedSourceRefresh({ predecessor: baseline, currentDigests, p2Impact: p2Disposition, p1EvidenceRefresh });
  return {
    ...p2Disposition,
    valid: combined.valid,
    scopedImpactValid: p2Disposition.valid,
    changedPaths: combined.changedPaths,
    scopedChangedPaths: p2Disposition.scopedChangedPaths,
    predecessorEvidenceRefresh: p1EvidenceRefresh,
    combinedSourceRefresh: combined,
  };
}

function sourcePinReview(status, currentDigests, mdc20, ownerChanges, supplement, p2Impact) {
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
    if (supplement.valid && entry.path === supplement.path
        && entry.historicalSha256 === supplement.predecessorSha256
        && entry.currentSha256 === supplement.currentSha256) return false;
    if (p2Impact.valid && p2Impact.changedPaths.includes(entry.path)
        && p2Impact.transitionsValid && currentDigests[entry.path] === entry.currentSha256) return false;
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
  if (supplement.valid) expected.add(supplement.path);
  if (p2Impact.valid) for (const sourcePath of p2Impact.changedPaths) expected.add(sourcePath);
  const supplementChanged = changed.filter((entry) => entry.path === supplement.path);
  const chainedReporterDelta = p2Impact.scopedTransitions?.find((entry) => entry.path === supplement.path);
  const validDeltaCount = supplement.valid && supplementChanged.length === 1
    && supplementChanged[0].historicalSha256 === supplement.predecessorSha256
    && supplement.currentSha256 === chainedReporterDelta?.predecessorSha256
    && supplementChanged[0].currentSha256 === chainedReporterDelta?.observedSha256 ? 1 : 0;
  return {
    historicalPinCount: changes.length,
    currentPinCount: changes.length - changed.length,
    changedPinCount: changed.length,
    missingPinCount: changed.filter((entry) => entry.currentSha256 === null).length,
    changedPins: changed.map((entry) => {
      const p1Evidence = p2Impact.predecessorEvidenceRefresh?.paths?.find(({ path: sourcePath }) => sourcePath === entry.path);
      const scopedDelta = p2Impact.scopedTransitions?.find(({ path: sourcePath }) => sourcePath === entry.path);
      return {
        ...entry,
        disposition: dispositionByPath.get(entry.path)
          ?? (p1Evidence ? { classification: p2Impact.predecessorEvidenceRefresh.classification, sourceBoundToPdp1R13: true } : null)
          ?? (scopedDelta ? { classification: scopedDelta.classification, meaningChange: scopedDelta.meaningChange } : null),
      };
    }),
    unclassifiedChangedPins: unclassified,
    explorerUsedOwnerDirectionBecauseMdc20HashWasStale: changed.some((entry) => entry.path === 'apps/media-experience-explorer/specification-artifacts.json'
      && dispositionByPath.get(entry.path)?.currentSha256 !== entry.currentSha256
      && ownerByPath.has(entry.path)),
    supplementalDelta: supplement,
    pdp2ScopedImpact: p2Impact,
    expectedChangedPathsMatch: changed.length === expected.size && changed.every((entry) => expected.has(entry.path))
      && [...expected].every((sourcePath) => changed.some((entry) => entry.path === sourcePath)),
    supplementalDeltaCount: validDeltaCount + (p2Impact.valid ? p2Impact.changedPaths.length : 0),
  };
}

export function ownerStatusJoin(historicalExit, currentDigests, ownerReview, materialSourceSetFingerprint) {
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
  const supplement = pdp3StatusGuardSupplement(historicalExit, currentDigests);
  const p2Impact = pdp2CurrentCutImpact(historicalExit, currentDigests);
  const allChanges = [...ownerChanges, ...(supplement.valid ? [{
    path: supplement.path, recordedSha256: supplement.predecessorSha256,
    observedSha256: supplement.currentSha256,
    ownerMaterialityClassification: 'PDP3_STATUS_GUARD_ONLY_NO_PDP2_MEANING_CHANGE',
    meaningIdsChangedAtReviewedCut: [], requiresFreshCurrentness: true, transitionOnly: true,
  }] : []), ...(p2Impact.scopedImpactValid ? p2Impact.scopedChangedPaths.map((sourcePath) => {
    const delta = readJson(PDP2_CURRENT_CUT_IMPACT_PATH).sourceDeltas.find((entry) => entry.path === sourcePath);
    return {
      path: delta.path,
      recordedSha256: delta.predecessorSha256,
      observedSha256: delta.observedSha256,
      ownerMaterialityClassification: delta.classification,
      meaningIdsChangedAtReviewedCut: [],
      meaningChange: delta.meaningChange,
      requiresFreshCurrentness: true,
      transitionOnly: true,
    };
  }) : []), ...(p2Impact.predecessorEvidenceRefresh?.valid ? p2Impact.predecessorEvidenceRefresh.paths.map((entry) => ({
    path: entry.path,
    recordedSha256: entry.predecessorSha256,
    observedSha256: entry.currentSha256,
    ownerMaterialityClassification: 'PDP1_PREDECESSOR_EVIDENCE_REFRESH_ONLY_NO_PDP2_MEANING_DISPOSITION',
    meaningIdsChangedAtReviewedCut: [],
    meaningPhaseReviewed: 'PDP-2',
    upstreamPhaseEvidence: 'PDP-1',
    requiresFreshCurrentness: true,
    transitionOnly: true,
  })) : [])];
  const changesByPath = new Map(allChanges.map((entry) => [entry.path, entry]));
  const duplicateChangePaths = ownerChanges.filter((entry, index) => ownerChanges.findIndex((candidate) => candidate.path === entry.path) !== index).map((entry) => entry.path);
  const changedPathChecks = allChanges.map((entry) => ({
    path: entry.path,
    historicalSha256: entry.transitionOnly ? entry.recordedSha256 : historicalDigests[entry.path] ?? null,
    currentSha256: entry.transitionOnly ? entry.observedSha256 : currentDigests[entry.path] ?? null,
    terminalCurrentSha256: currentDigests[entry.path] ?? null,
    recordedSha256: entry.recordedSha256,
    observedSha256: entry.observedSha256,
    digestsMatch: (entry.transitionOnly || historicalDigests[entry.path] === entry.recordedSha256)
      && (entry.transitionOnly ? true : currentDigests[entry.path] === entry.observedSha256),
    requiresFreshCurrentness: entry.requiresFreshCurrentness === true,
    meaningIdsChangedAtReviewedCut: entry.meaningIdsChangedAtReviewedCut ?? null,
    meaningPhaseReviewed: entry.meaningPhaseReviewed ?? null,
    upstreamPhaseEvidence: entry.upstreamPhaseEvidence ?? null,
    classification: entry.ownerMaterialityClassification ?? null,
  }));
  const unapprovedChangedPaths = digestChanges.filter((sourcePath) => !changesByPath.has(sourcePath));
  const changeRecordsValid = ownerChanges.length === 4 && supplement.valid && p2Impact.valid
    && !ownerChanges.some((entry) => entry.path === supplement.path)
    && duplicateChangePaths.length === 0
    && allChanges.filter((entry) => entry.ownerMaterialityClassification === 'PDP1_PREDECESSOR_EVIDENCE_REFRESH_ONLY_NO_PDP2_MEANING_DISPOSITION')
      .every((entry) => entry.meaningPhaseReviewed === 'PDP-2' && entry.upstreamPhaseEvidence === 'PDP-1')
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
    && digestChanges.length === 8
    && allChanges.length === 9
    && digestChanges.length === new Set(allChanges.map((entry) => entry.path)).size
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
    uniqueChangedPathCount: new Set(allChanges.map((entry) => entry.path)).size,
    expectedChangedPathCount: digestChanges.length,
    changeTransitionCount: allChanges.length,
    duplicateTransitionPaths: [...new Set(allChanges.map((entry) => entry.path))]
      .filter((sourcePath) => allChanges.filter((entry) => entry.path === sourcePath).length > 1),
    supplementalDelta: supplement,
    pdp2ScopedImpact: p2Impact,
    predecessorEvidenceRefresh: p2Impact.predecessorEvidenceRefresh,
    missingPathCount: missingPaths.length,
    additionalPathCount: additionalPaths.length,
    unapprovedChangedPathCount: unapprovedChangedPaths.length,
    missingPaths,
    additionalPaths,
    unapprovedChangedPaths,
    duplicateChangePaths,
    meaningIdCount: allChanges.reduce((count, entry) => count + (entry.meaningIdsChangedAtReviewedCut?.length ?? 0), 0),
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
  const currentDigests = aggregateCurrentCellDigests(technical.cells);
  const phaseOwnerReview = pdp2OwnerReview(ownerDirections);
  const phaseOwnerChanges = phaseOwnerReview?.sourceChanges ?? [];
  const supplement = pdp3StatusGuardSupplement(historicalP2Exit, currentDigests);
  const p2Impact = pdp2CurrentCutImpact(historicalP2Exit, currentDigests);
  const pins = sourcePinReview(status, currentDigests, mdc20, phaseOwnerChanges, supplement, p2Impact);
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
  const sourceSetByPath = currentDigests;
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
    ...(pins.changedPinCount === 8 && pins.supplementalDeltaCount === 5 && pins.expectedChangedPathsMatch && pins.unclassifiedChangedPins.length === 0 && pins.missingPinCount === 0 ? [] : ['PDP2_HISTORICAL_PIN_DRIFT_UNCLASSIFIED_OR_UNEXPECTED']),
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
      pdp2ScopedImpact: { ref: PDP2_CURRENT_CUT_IMPACT_PATH, sha256: digestFile(PDP2_CURRENT_CUT_IMPACT_PATH), includedIn405PathMaterialDenominator: false },
      pdp2ImpactPredecessor: { ref: PDP2_CURRENT_CUT_PREDECESSOR_PATH, sha256: digestFile(PDP2_CURRENT_CUT_PREDECESSOR_PATH), includedIn405PathMaterialDenominator: false },
      pdp1EvidenceRefresh: { ref: PDP1_CURRENT_CUT_EXIT_PATH, sha256: digestFile(PDP1_CURRENT_CUT_EXIT_PATH), includedIn405PathMaterialDenominator: false },
      pdp1StatusEvidence: { ref: PDP1_STATUS_PATH, sha256: digestFile(PDP1_STATUS_PATH), includedIn405PathMaterialDenominator: true },
      pdp1SemanticReviewEvidence: { ref: PDP1_SEMANTIC_REVIEW_PATH, sha256: digestFile(PDP1_SEMANTIC_REVIEW_PATH), includedIn405PathMaterialDenominator: true },
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
