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
  'tests/pdp-design-accessibility-text-spacing-target-size.test.mjs',
  'tests/pdp-design-responsive-rendered-references.test.mjs',
];
const PDP2_TEST_COMMAND = `node --test ${PDP2_TEST_FILES.join(' ')}`;
const LOCAL_CHECK_COMMAND = 'pnpm check:product-experience-local';
const PDP2_STATUS_PATH = 'docs/implementation/pdp-2-phase-dev-status.json';
const MATRIX_PATH = 'docs/implementation/media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json';
const TOPOLOGY_PATH = '.product-experience/surfaces/media-physical-topology.v1.json';
const REGISTRY_PATH = '.product-experience/surface-registry.yaml';
const OWNER_DECISION_PATH = '.product-experience/reviews/2026-10-13-discovery-delegated-owner-decision-and-authorizations.md';
const MDC20_PATH = 'docs/implementation/observations/media-discovery-pdp2-mdc20-design-drift-2026-10-13-r1.json';
const P1_EXIT_PATH = 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-15-current-cut-r30.json';
const P0_EXIT_PATH = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r15.json';
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
  P1_EXIT_PATH,
  P0_EXIT_PATH,
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

function buildCellPaths(matrixCells, topology, status, availablePaths) {
  const physical = new Map(topology.manifestCandidates.map((row) => [row.surfaceId, row]));
  const compositions = new Map(topology.compositions.map((row) => [row.surfaceId, row]));
  const consumers = new Map(topology.consumerCrosswalk.map((row) => [row.surfaceId, row]));
  const cellsBySurface = new Map(matrixCells.map((cell) => [cell.surfaceId, cell]));
  const sharedRefs = [...COMMON_PDP2_REFS, ...Object.keys(status.sourceShaSet ?? {})];
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
    runner: 'scripts/record-media-discovery-pdp2-phase-exit.mjs',
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

function sourcePinReview(status, currentDigests, mdc20) {
  const changes = Object.entries(status.sourceShaSet ?? [])
    .map(([sourcePath, recorded]) => {
      const expected = `sha256:${recorded.replace(/^sha256:/u, '')}`;
      const current = currentDigests[sourcePath] ?? null;
      return { path: sourcePath, historicalSha256: expected, currentSha256: current, matches: expected === current };
    });
  const changed = changes.filter((entry) => !entry.matches);
  const dispositionByPath = new Map((mdc20.pinReview?.changedPins ?? []).map((entry) => [entry.path, entry]));
  const unclassified = changed.filter((entry) => {
    const disposition = dispositionByPath.get(entry.path);
    return !disposition || disposition.historicalSha256 !== entry.historicalSha256
      || disposition.currentSha256 !== entry.currentSha256 || disposition.meaningChange !== 'NONE_IDENTIFIED';
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
    expectedChangedPathsMatch: changed.length === expected.size && changed.every((entry) => expected.has(entry.path))
      && [...expected].every((sourcePath) => changed.some((entry) => entry.path === sourcePath)),
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

function validatePdp0Predecessor(exit, matrix, exitPath = P0_EXIT_PATH) {
  const cells = exit.sourceCurrentness?.cells ?? [];
  const valid = exit.schemaVersion === 'media.discovery-phase-exit.v1'
    && exit.phase === 'PDP-0'
    && exit.phaseExit?.status === 'PASS'
    && exit.phaseExit?.sourceCurrentness === 'PASS'
    && exit.sourceCurrentness?.status === 'PASS'
    && exit.sourceCurrentness?.sourceCurrent === true
    && exit.developmentStatus?.status === 'DEV_COMPLETE'
    && exit.developmentStatus?.outstandingMeaningIds?.length === 0
    && cells.length === 50
    && new Set(cells.map((cell) => cell.surfaceId)).size === 50
    && cells.every((cell) => cell.sourceCurrentness === 'CURRENT' && (cell.blockers?.length ?? 0) === 0)
    && matrix.currentCut?.phaseExit === P0_EXIT_PATH
    && exit.recordId === matrix.currentCut?.phaseExitRecordId
    && exitPath === matrix.currentCut?.phaseExit
    && matrix.currentCut?.materialSourceSetFingerprint === exit.developmentStatus.currentMaterialSourceSetFingerprint
    && exit.sourceCurrentness?.materialSourceSetFingerprint === exit.developmentStatus.currentMaterialSourceSetFingerprint;
  return {
    valid,
    phase: 'PDP-0',
    exitRef: exitPath,
    exitDigest: sha256(fs.readFileSync(path.join(root, exitPath))),
    materialSourceSetFingerprint: exit.developmentStatus?.currentMaterialSourceSetFingerprint ?? null,
    cellCount: cells.length,
    status: valid ? 'PASS' : 'FAIL',
  };
}

function validatePdp1Predecessor(exit, matrix, exitPath = P1_EXIT_PATH, pdp0 = null) {
  const cells = exit.sourceCurrentness?.cells ?? [];
  const valid = exit.schemaVersion === 'media.discovery-pdp1-currentness-observation.v1'
    && exit.phase === 'PDP-1'
    && exit.phaseExit?.status === 'PASS'
    && exit.sourceCurrentness?.status === 'PASS'
    && exit.sourceCurrentness?.sourceCurrent === true
    && exit.developmentStatus?.status === 'DEV_COMPLETE'
    && exit.developmentStatus?.outstandingMeaningIds?.length === 0
    && cells.length === 50
    && new Set(cells.map((cell) => cell.surfaceId)).size === 50
    && cells.every((cell) => cell.sourceCurrentness === 'CURRENT' && (cell.blockers?.length ?? 0) === 0)
    && exitPath === P1_EXIT_PATH
    && matrix.currentCut?.pdp1PhaseExit === exitPath
    && matrix.currentCut?.pdp1PhaseExitRecordId === exit.observationId
    && matrix.currentCut?.pdp1MaterialSourceSetFingerprint === exit.developmentStatus.currentMaterialSourceSetFingerprint;
  const exactPdp0 = pdp0?.valid === true
    && exit.predecessor?.phase === 'PDP-0'
    && exit.predecessor?.exitRef === pdp0.exitRef
    && exit.predecessor?.exitDigest === pdp0.exitDigest
    && exit.predecessor?.materialSourceSetFingerprint === pdp0.materialSourceSetFingerprint
    && exit.predecessor?.status === 'PASS'
    && exit.predecessor?.currentnessValid === true
    && exit.predecessor?.currentnessRef === matrix.currentCut?.currentnessObservation
    && exit.predecessor?.currentnessDigest === sha256(fs.readFileSync(path.join(root, matrix.currentCut.currentnessObservation)))
    && exit.sourceCurrentness?.materialSourceSetFingerprint === exit.developmentStatus?.currentMaterialSourceSetFingerprint
    && matrix.currentCut?.pdp1CurrentnessObservation === `${exitPath}#sourceCurrentness`;
  return {
    valid: valid && exactPdp0,
    phase: 'PDP-1',
    exitRef: exitPath,
    materialSourceSetFingerprint: exit.developmentStatus?.currentMaterialSourceSetFingerprint ?? null,
    observationId: exit.observationId,
    cellCount: cells.length,
    pdp0Predecessor: pdp0,
    status: valid && exactPdp0 ? 'PASS' : 'FAIL',
  };
}

function makeObservation({ suffix, testRun }) {
  const matrix = readJson(MATRIX_PATH);
  const topology = readJson(TOPOLOGY_PATH);
  const registry = parseYaml(readText(REGISTRY_PATH));
  const status = readJson(PDP2_STATUS_PATH);
  const mdc20 = readJson(MDC20_PATH);
  const p1Exit = readJson(P1_EXIT_PATH);
  const p0Exit = readJson(P0_EXIT_PATH);
  const topologyReview = validateMatrixAndTopology(matrix, topology, registry);
  const pdp0Predecessor = validatePdp0Predecessor(p0Exit, matrix);
  const predecessor = validatePdp1Predecessor(p1Exit, matrix, P1_EXIT_PATH, pdp0Predecessor);
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
  const currentnessCells = buildCellPaths(topologyReview.cells, topology, status, availablePaths);
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
  const pins = sourcePinReview(status, currentDigests, mdc20);
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
  const predecessorDigest = sha256(fs.readFileSync(path.join(root, P1_EXIT_PATH)));
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
    mdc20DispositionDigest: sha256(fs.readFileSync(path.join(root, MDC20_PATH))),
    cells: observedCells.map((cell) => ({ cellId: cell.cellId, sourceSetFingerprint: cell.sourceSetFingerprint })).sort((a, b) => a.cellId.localeCompare(b.cellId)),
  });
  const sourceBlockers = [
    ...topologyReview.errors,
    ...(predecessor.valid ? [] : ['PDP1_PREDECESSOR_EXIT_NOT_PASS_OR_MATRIX_MISMATCH']),
    ...(ownerDirectionPass ? [] : ['DELEGATED_PDP2_DESIGN_DIRECTION_MISSING_OR_CONTRADICTORY']),
    ...(historicalStatusValid ? [] : ['HISTORICAL_PDP2_STATUS_INCONSISTENT_OR_OUTSTANDING_TASKS']),
    ...(populations.matchesHistoricalStatus && populations.componentFamilyIds.exactSetMatches ? [] : ['PDP2_CATALOG_POPULATIONS_OR_FAMILY_IDENTITIES_MISMATCH']),
    ...(mdc20.result?.status === 'PASS' && mdc20.pinReview?.unclassifiedChangedPins?.length === 0 ? [] : ['MDC20_DRIFT_DISPOSITION_NOT_PASS']),
    ...(pins.changedPinCount === 4 && pins.expectedChangedPathsMatch && pins.unclassifiedChangedPins.length === 0 && pins.missingPinCount === 0 ? [] : ['PDP2_HISTORICAL_PIN_DRIFT_UNCLASSIFIED_OR_UNEXPECTED']),
    ...externalContracts.blockers,
    ...(currentCellsPass ? [] : ['ONE_OR_MORE_PDP2_CELLS_NOT_CURRENT']),
    ...(testsPass ? [] : ['REQUIRED_PDP2_CHECKS_OR_SOURCE_BINDING_INVALID']),
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
      denominators: { physicalCandidates: 26, semanticCompositions: 6, repositoryRoots: 1, consumerBindings: 17, totalCells: observedCells.length },
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
  if (!/^[a-z0-9-]+$/u.test(suffix ?? '')) {
    process.stderr.write('Usage: node scripts/record-media-discovery-pdp2-phase-exit.mjs <fresh-cut-suffix>\n');
    process.exitCode = 2;
    return;
  }
  const outputPath = `docs/implementation/observations/media-discovery-pdp2-exit-${suffix}.json`;
  if (fs.existsSync(path.join(root, outputPath))) throw new Error(`Refusing to overwrite immutable observation: ${outputPath}`);
  const p1 = readJson(P1_EXIT_PATH);
  const dimensions = {
    ownerGraphFingerprint: p1.sourceCurrentness.ownerGraphFingerprint,
    physicalCatalogFingerprint: p1.sourceCurrentness.physicalCatalogFingerprint,
    providerRegistryFingerprint: p1.sourceCurrentness.providerRegistryFingerprint,
  };
  const testRun = runRequiredChecks(dimensions);
  const observation = makeObservation({ suffix, testRun });
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

export { validatePdp0Predecessor, validatePdp1Predecessor };

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
