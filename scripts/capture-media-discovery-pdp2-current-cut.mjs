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
let cachedPdp1OperationsSourceText;
let cachedPdp1OperationsSource;

function parsePdp1OperationsSource(sourceText) {
  if (sourceText !== cachedPdp1OperationsSourceText) {
    cachedPdp1OperationsSourceText = sourceText;
    try { cachedPdp1OperationsSource = parseYaml(sourceText); } catch { cachedPdp1OperationsSource = null; }
  }
  return cachedPdp1OperationsSource;
}

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
  'tests/pdp-design-interface-component-contracts.test.mjs',
];
const PDP2_TEST_COMMAND = `node --test ${PDP2_TEST_FILES.join(' ')}`;
const PDP2_IMPACT_VALIDATOR_TEST_FILE = 'tests/media-discovery-pdp2-current-cut-impact.test.mjs';
const PDP2_IMPACT_VALIDATOR_TEST_COMMAND = `node --test ${PDP2_IMPACT_VALIDATOR_TEST_FILE}`;
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
const PDP2_CURRENT_CUT_IMPACT_R2_PATH = 'docs/implementation/observations/media-discovery-pdp2-current-cut-source-impact-2026-10-14-r2.json';
const PDP2_CURRENT_CUT_IMPACT_R3_PATH = 'docs/implementation/observations/media-discovery-pdp2-current-cut-source-impact-2026-10-14-r3.json';
const PDP2_CURRENT_CUT_IMPACT_R4_PATH = 'docs/implementation/observations/media-discovery-pdp2-current-cut-source-impact-2026-10-14-r4.json';
const PDP2_CURRENT_CUT_IMPACT_R5_PATH = 'docs/implementation/observations/media-discovery-pdp2-current-cut-source-impact-2026-10-14-r5.json';
const PDP1_CURRENT_CUT_EXIT_R16_PATH = 'docs/implementation/observations/media-discovery-pdp1-exit-current-cut-r16.json';
const PDP2_CURRENT_CUT_PREDECESSOR_R9_PATH = 'docs/implementation/observations/media-discovery-pdp2-exit-current-cut-r9.json';
const PDP2_CURRENT_CUT_PREDECESSOR_R13_PATH = 'docs/implementation/observations/media-discovery-pdp2-exit-2026-10-14-current-cut-r13.json';
const PDP1_CURRENT_CUT_EXIT_R19_PATH = 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r19.json';
const PDP1_CURRENT_CUT_EXIT_R22_PATH = 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r22.json';
const PDP1_CURRENT_CUT_EXIT_R25_PATH = 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r25.json';
const PDP1_CURRENT_CUT_EXIT_R27_PATH = 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r27.json';
const PDP1_CURRENT_CUT_EXIT_R30_PATH = 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-15-current-cut-r30.json';
const PDP1_CURRENT_CUT_EXIT_R30_DIGEST = 'sha256:18ac1cb3631ef545c6790f1ea55038ecdd609264a61276ae10dae8d6304d967e';
const PDP1_CURRENT_CUT_EXIT_R30_FINGERPRINT = 'sha256:34f90853f894e4e244e5e0c76643ebd94f6f2455c6a012c4dd4073bb5d62a4f4';
const PDP1_CURRENT_CUT_EXIT_R25_DIGEST = 'sha256:914390414ee87982efa786e1edf2a8adb0bc3e5d8b5c609776a7f0c65f679e1e';
const PDP1_CURRENT_CUT_EXIT_R27_DIGEST = 'sha256:2f57ace69d389dde7cbe7c5032c5b88d6a6b068c07177d33694fd968aa6c451e';
const PDP1_CURRENT_CUT_EXIT_R27_FINGERPRINT = 'sha256:2c982c15803a00a22a873d9874e1d00de89b1e80addc97ae984bffc578bef3aa';
const PDP0_CURRENT_CUT_EXIT_R12_PATH = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r12.json';
const PDP0_CURRENT_CUT_EXIT_R12_DIGEST = 'sha256:91aeae0aad488bc8eb29d40bf955e527ef072ada762948064bc8e50422c5a5c5';
const PDP0_CURRENT_CUT_EXIT_R12_FINGERPRINT = 'sha256:1a121cf988ba4a34f6b603b1f230fd0494160a3c6142c064d8d5cc2a6aa45f94';
const PDP0_CURRENT_CUT_EXIT_R15_PATH = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r15.json';
const PDP0_CURRENT_CUT_EXIT_R15_DIGEST = 'sha256:d36a318fc159b5060bdca65d4b1e6527b7616bf31c3609854aaa07947e80fa4a';
const PDP0_CURRENT_CUT_EXIT_R15_FINGERPRINT = 'sha256:eff717cf2537a285cd7a1c1a72b44a75766a0a7e6eef6ea97edbc2befa2e1a95';
const PDP2_R17_PATH = 'docs/implementation/observations/media-discovery-pdp2-exit-2026-10-14-current-cut-r17.json';
const PDP2_R17_DIGEST = 'sha256:e08981102312364aad0ebe4282680e20b6d5fcf2db4e70e41a43880b2712d64d';
const PDP2_R17_FINGERPRINT = 'sha256:a4c43f03c44a5f1844fba5039f146473f7390c02b3a06ce582c095fc5d9e74bd';
const PDP2_R17_TO_R30_IMPACT_PATH = 'docs/implementation/observations/media-discovery-pdp2-r17-to-r30-source-impact-2026-10-15-r1.json';
const PDP2_ADDITIONAL_SOURCE_IMPACT_R1_PATH = 'docs/implementation/observations/media-discovery-pdp2-additional-source-impact-2026-10-14-r1.json';
const PDP2_R16_PROJECTION_IMPACT_RECORD_PATH = 'docs/implementation/observations/media-discovery-pdp2-r16-projection-impact-2026-10-14-r1.json';
const PDP2_R16_PROJECTION_IMPACT_DIGEST = 'sha256:230a0a04d46a6000b915c67bca4354418408c41a1bbda63ea62fa1eb9c1b86e5';
const PDP2_R16_RECEIPT_PATH = 'docs/implementation/observations/media-discovery-pdp2-exit-r16.json';
const PDP2_R16_RECEIPT_DIGEST = 'sha256:b4f02281caad96c2de36c66138d500a7d4ab3d0faebeb5b07f6600e414e42f84';
const PDP2_R16_PROJECTION_PATH = '.product-experience/pdp-2-design-interface-system/generated/experience-language.candidate.json';
const PDP2_R16_PROJECTION_PREDECESSOR_DIGEST = 'sha256:612760df546543582d5b6a867e3086bc6f1b21c5ba745367fbe3dd88b27f0979';
const PDP2_R16_PROJECTION_OBSERVED_DIGEST = 'sha256:e7c3f762eb95d3ea6e5111fe24266406010de05abb20f05b6e310f2b9a80bd4c';
const PDP2_R16_DESIGN_LANGUAGE_DIGEST = 'sha256:76287b8d49b3aff679b1d5cf4b26352544bfdc9eee5a7dee86d75f14f7d59753';
const PDP2_CURRENT_CUT_PREDECESSOR_R9_DIGEST = 'sha256:3720413ea63e00a9f1d57740e49d0f36d3e9ba1890584e2bdf66364595041bf0';
let PDP2_CURRENT_CUT_IMPACT_PATH = PDP2_CURRENT_CUT_IMPACT_R5_PATH;
let PDP2_CURRENT_CUT_PREDECESSOR_PATH = PDP2_CURRENT_CUT_PREDECESSOR_R9_PATH;
let PDP1_CURRENT_CUT_EXIT_PATH = PDP1_CURRENT_CUT_EXIT_R27_PATH;
let PDP2_R16_PROJECTION_IMPACT_PATH = null;
let PDP2_ADDITIONAL_SOURCE_IMPACT_PATH = null;
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
  const impactValidatorTestResult = runCommand(process.execPath, ['--test', PDP2_IMPACT_VALIDATOR_TEST_FILE]);
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
  const outcomes = [parseLocalOutcome(localResult), parseTestOutcome(PDP2_TEST_COMMAND, testResult), parseTestOutcome(PDP2_IMPACT_VALIDATOR_TEST_COMMAND, impactValidatorTestResult)];
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
      testInputContentDigests: Object.fromEntries([...PDP2_TEST_FILES, PDP2_IMPACT_VALIDATOR_TEST_FILE].map((sourcePath) => [sourcePath, sha256(fs.readFileSync(path.join(root, sourcePath)))])),
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

export function pdp2OwnerReview(directions) {
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

export function pdp3StatusGuardSupplement(historicalExit, currentDigests) {
  const supplement = readJson(PDP3_STATUS_GUARD_SUPPLEMENT_PATH);
  const impactP2Cut = readJson(PDP2_SUPPLEMENT_CUT_PATH);
  const currentP2Baseline = readJson(PDP2_CURRENT_CUT_PREDECESSOR_R13_PATH);
  const immutableR9Checkpoint = readJson(PDP2_CURRENT_CUT_PREDECESSOR_R9_PATH);
  const r2Impact = readJson(PDP2_CURRENT_CUT_IMPACT_R2_PATH);
  const r4Impact = readJson(PDP2_CURRENT_CUT_IMPACT_R4_PATH);
  const activeImpact = readJson(PDP2_CURRENT_CUT_IMPACT_PATH);
  const delta = supplement.sourceDelta;
  const historicalPathDigest = historicalExit.sourceCurrentness?.sourceSetDigests?.sourceContentDigests?.[delta?.path] ?? null;
  const r3PathDigest = impactP2Cut.sourceCurrentness?.sourceSetDigests?.sourceContentDigests?.[delta?.path] ?? null;
  const r9PathDigest = immutableR9Checkpoint.sourceCurrentness?.sourceSetDigests?.sourceContentDigests?.[delta?.path] ?? null;
  const currentP2PathDigest = currentP2Baseline.sourceCurrentness?.sourceSetDigests?.sourceContentDigests?.[delta?.path] ?? null;
  const terminalPathDigest = currentDigests?.[delta?.path] ?? null;
  const r2ReporterDelta = r2Impact.sourceDeltas?.find((entry) => entry.path === delta?.path);
  const r4ReporterDelta = r4Impact.sourceDeltas?.find((entry) => entry.path === delta?.path);
  const activeReporterDelta = activeImpact.sourceDeltas?.find((entry) => entry.path === delta?.path);
  const r3Digest = digestFile(PDP2_SUPPLEMENT_CUT_PATH);
  const r2ImpactDigest = digestFile(PDP2_CURRENT_CUT_IMPACT_R2_PATH);
  const r4ImpactDigest = digestFile(PDP2_CURRENT_CUT_IMPACT_R4_PATH);
  const chainValid = digestFile(PDP3_STATUS_GUARD_SUPPLEMENT_PATH) === 'sha256:67ac10b13b933ee84dc4a3bf9cdbd00cd020a0c8427f7b83e5963e36467a58e7'
    && r3Digest === 'sha256:589d9648f69c141a11fb357f0aed9a50dfc983dcbc22df5f078c29d60ada4d61'
    && r2ImpactDigest === 'sha256:c5f732f18aede780ecb1f1a30efbbc34b8676b10c94b763685e8519cefd3ecd4'
    && r4ImpactDigest === 'sha256:7b9230c45c65e53638d3addb0e8ccb5844376e18f4aa6d035001ada4b6d4a08d'
    && r3PathDigest === 'sha256:6655e0344b7f4b03f6ca0b7e594a5448eed72ae5aeac198cef4bb1b28252028c'
    && currentP2Baseline.observationId === 'MEDIA-PDP2-CURRENTNESS-2026-10-14-CURRENT-CUT-R13'
    && digestFile(PDP2_CURRENT_CUT_PREDECESSOR_R13_PATH) === 'sha256:e594080519407b78027389e4b9e09669663de6451cedeb2e17dd9db8c5cfcaae'
    && delta?.predecessorSha256 === r3PathDigest
    && delta?.observedSha256 === 'sha256:f3482cf689e0be2d8dc9faf9ccc72a1b63a1dcaecd056efaa1759e6f3696a5e1'
    && r2ReporterDelta?.predecessorSha256 === delta?.observedSha256
    && r2ReporterDelta?.observedSha256 === 'sha256:ca59f6c4e1313bd58387f91b41eb51fc1a10ac04b2db01faed30b9edcc9b2573'
    && r9PathDigest === r2ReporterDelta?.observedSha256
    && digestFile(PDP2_CURRENT_CUT_PREDECESSOR_R9_PATH) === PDP2_CURRENT_CUT_PREDECESSOR_R9_DIGEST
    && r4ReporterDelta?.predecessorSha256 === r9PathDigest
    && r4ReporterDelta?.observedSha256 === 'sha256:4f0400c142d2f3df39c4497839925dad80f1ac90584573b390af386e491faa0f'
    && currentP2PathDigest === r4ReporterDelta?.observedSha256
    && activeReporterDelta?.predecessorSha256 === r4ReporterDelta?.predecessorSha256
    && activeReporterDelta?.observedSha256 === r4ReporterDelta?.observedSha256
    && currentP2PathDigest === r4ReporterDelta?.observedSha256
    && terminalPathDigest === r4ReporterDelta?.observedSha256
    && historicalPathDigest === delta?.predecessorSha256;
  const pathDigest = r9PathDigest;
  const valid = supplement.schemaVersion === 'media.discovery-predecessor-source-impact.v1'
    && supplement.recordId === 'MEDIA-DISCOVERY-PREDECESSOR-IMPACT-PDP3-STATUS-GUARD-2026-10-14-R1'
    && delta?.path === 'scripts/report-media-pdp-readiness.mjs'
    && delta.predecessorSha256 === 'sha256:6655e0344b7f4b03f6ca0b7e594a5448eed72ae5aeac198cef4bb1b28252028c'
    && delta.observedSha256 === 'sha256:f3482cf689e0be2d8dc9faf9ccc72a1b63a1dcaecd056efaa1759e6f3696a5e1'
    && pathDigest === 'sha256:ca59f6c4e1313bd58387f91b41eb51fc1a10ac04b2db01faed30b9edcc9b2573'
    && chainValid
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
    r9IntermediateSha256: r9PathDigest,
    r13PredecessorSha256: currentP2PathDigest,
    currentSha256: terminalPathDigest,
    guardedObservedSha256: delta?.observedSha256 ?? null,
    terminalCurrentSha256: terminalPathDigest,
    chainValid,
    materialSourceSetFingerprint: supplement.predecessorCuts?.find((cut) => cut.phase === 'PDP-2')?.materialSourceSetFingerprint ?? null,
    materialPathCount: supplement.predecessorCuts?.find((cut) => cut.phase === 'PDP-2')?.materialPathCount ?? null,
    delegatedAuthority: supplement.authority?.delegate ?? null,
    predecessorMeaningDisposition: delta?.predecessorPhaseMeaningDisposition?.['PDP-2'] ?? null,
    freshCurrentnessRequired: delta?.freshCurrentnessRequired === true,
    independentOrExternalOrLifecycleClaims: false,
  };
}

function validatePdp2CurrentCutImpactR3({ impact, predecessor, currentDigests, actualCurrentDigests, predecessorDigest, impactDigest, predecessorPath, impactPath, pdp1Exit, pdp1ExitDigest, pdp1ExitPath }) {
  const r2Impact = readJson(PDP2_CURRENT_CUT_IMPACT_R2_PATH);
  const r2Digest = digestFile(PDP2_CURRENT_CUT_IMPACT_R2_PATH);
  const predecessorDigests = predecessor?.sourceCurrentness?.sourceSetDigests?.sourceContentDigests ?? {};
  const currentPaths = Object.keys(currentDigests ?? {}).sort();
  const predecessorPaths = Object.keys(predecessorDigests).sort();
  const currentSet = new Set(currentPaths);
  const missingPaths = predecessorPaths.filter((sourcePath) => !currentSet.has(sourcePath));
  const additionalPaths = currentPaths.filter((sourcePath) => !Object.hasOwn(predecessorDigests, sourcePath));
  const pathChanges = predecessorPaths.filter((sourcePath) => currentDigests?.[sourcePath] !== predecessorDigests[sourcePath]);
  const authorizedPaths = r2Impact.sourceDeltas.map(({ path: sourcePath }) => sourcePath).sort();
  const deltasMatchR2 = Array.isArray(impact?.sourceDeltas)
    && JSON.stringify(impact.sourceDeltas) === JSON.stringify(r2Impact.sourceDeltas);
  const predecessorPdp1MatchesR16 = impact?.pdp1Predecessor?.phase === 'PDP-1'
    && impact.pdp1Predecessor.receiptRef === pdp1ExitPath
    && impact.pdp1Predecessor.receiptSha256 === pdp1ExitDigest
    && pdp1Exit?.phase === 'PDP-1'
    && pdp1Exit?.phaseExit?.status === 'PASS'
    && pdp1Exit?.phaseExit?.sourceCurrentness === 'PASS'
    && pdp1Exit?.phaseExit?.developmentStatus === 'DEV_COMPLETE'
    && pdp1Exit?.developmentStatus?.status === 'DEV_COMPLETE'
    && pdp1Exit?.sourceCurrentness?.status === 'PASS'
    && pdp1Exit?.sourceCurrentness?.sourceCurrent === true
    && pdp1Exit?.sourceCurrentness?.materialPathDenominator?.uniquePaths === 329
    && pdp1Exit?.sourceCurrentness?.cells?.length === 50
    && pdp1Exit?.developmentStatus?.outstandingMeaningIds?.length === 0
    && pdp1ExitDigest === digestFile(pdp1ExitPath);
  const supersedesR2Valid = impact?.supersedes?.ref === PDP2_CURRENT_CUT_IMPACT_R2_PATH
    && impact.supersedes?.recordId === r2Impact.recordId
    && impact.supersedes?.sha256 === r2Digest;
  const inheritedAuthorizationValid = JSON.stringify(impact?.authority?.authorizationEvidence) === JSON.stringify(r2Impact.authority.authorizationEvidence)
    && impact?.authority?.userAuthorization === r2Impact.authority.userAuthorization;
  const reviewedPdp2SourcesValid = JSON.stringify(impact?.reviewedPdp2Sources) === JSON.stringify(r2Impact.reviewedPdp2Sources)
    && (impact?.reviewedPdp2Sources ?? []).every(({ path: sourcePath, sha256: expected }) => currentDigests?.[sourcePath] === expected
      && actualCurrentDigests?.[sourcePath] === expected
      && predecessorDigests[sourcePath] === expected);
  const transitionsValid = deltasMatchR2
    && impact.sourceDeltas.every((delta) => delta.phase === 'PDP-2'
      && delta.meaningChange === 'NO_ADDITIONAL_PDP2_MEANING'
      && Array.isArray(delta.meaningIdsChanged) && delta.meaningIdsChanged.length === 0
      && delta.requiresFreshCurrentness === true
      && predecessorDigests[delta.path] === delta.predecessorSha256
      && currentDigests?.[delta.path] === delta.observedSha256
      && actualCurrentDigests?.[delta.path] === delta.observedSha256);
  const pdp1ReferenceUpdated = impact?.pdp1Predecessor?.receiptRef === PDP1_CURRENT_CUT_EXIT_R16_PATH
    && impact?.pdp1Predecessor?.status === 'PASS'
    && impact?.pdp1Predecessor?.sourceCurrentness === 'PASS'
    && impact?.pdp1Predecessor?.developmentStatus === 'DEV_COMPLETE'
    && impact?.pdp1Predecessor?.materialPathCount === 329
    && impact?.pdp1Predecessor?.cellCount === 50
    && impact?.pdp1Predecessor?.outstandingMeaningIds === 0
    && predecessorPdp1MatchesR16;
  const pdp2MeaningScopeValid = impact?.scopeLimits?.onlyTheseSixExactR4ToCurrentPathTransitionsAreAuthorized === true
    && impact.scopeLimits?.noOtherPathAuthorizedByThisRecord === true
    && impact.scopeLimits?.pdp2Currentness === 'NOT_ESTABLISHED_REQUIRES_FRESH_RECAPTURE_AFTER_PDP1_R16'
    && impact.scopeLimits?.preserveEarlierReceipts === true
    && impact.scopeLimits?.externalAcceptance === 'NOT_CLAIMED'
    && impact.scopeLimits?.independentSignoff === 'NOT_CLAIMED'
    && impact.scopeLimits?.lifecycleClosure === 'NOT_ENTERED'
    && impact.scopeLimits?.runtimeAdmission === 'NOT_ADMITTED'
    && impact.scopeLimits?.delivery === 'NOT_AUTHORIZED'
    && impact.decision?.status === r2Impact.decision.status
    && impact.decision?.pdp2MeaningDisposition === r2Impact.decision.pdp2MeaningDisposition
    && impact.decision?.requiresFreshCurrentness === true
    && impact.decision?.orderedRecapturePrerequisite === 'PDP-1 R16 currentness must be established before PDP-2 recapture'
    && impact.decision?.preserveHistoricalReceipts === true
    && typeof impact.limitation === 'string'
    && impact.limitation.includes('only the six exact PDP-2 R4-to-current path transitions')
    && impact.limitation.includes('does not establish PDP-2 currentness');
  const valid = impact?.schemaVersion === r2Impact.schemaVersion
    && impact.recordId === 'MEDIA-DISCOVERY-PDP2-CURRENT-CUT-SOURCE-IMPACT-2026-10-14-R3'
    && impactPath === PDP2_CURRENT_CUT_IMPACT_R3_PATH
    && impactDigest === digestFile(PDP2_CURRENT_CUT_IMPACT_R3_PATH)
    && impact.campaign?.repository === r2Impact.campaign.repository
    && impact.campaign?.stage === r2Impact.campaign.stage
    && impact.campaign?.activePhase === 'PDP-2'
    && impact.campaign?.materialSourceSetFingerprint === predecessor?.sourceCurrentness?.materialSourceSetFingerprint
    && impact.campaign?.materialPathCount === 405
    && impact.authority?.delegate === r2Impact.authority.delegate
    && impact.authority?.decisionRole === r2Impact.authority.decisionRole
    && impact.authority?.humanIndependentSignatureProvided === false
    && impact.authority?.qualifiedExternalSpecialistSignoffProvided === false
    && impact.authority?.externalContractOwnerAcceptanceProvided === false
    && impact.authority?.nativeLifecycleReceiptProvided === false
    && inheritedAuthorizationValid
    && supersedesR2Valid
    && impact.predecessorCut?.phase === 'PDP-2'
    && impact.predecessorCut?.receiptRef === predecessorPath
    && impact.predecessorCut?.receiptSha256 === predecessorDigest
    && impact.predecessorCut?.materialSourceSetFingerprint === predecessor?.sourceCurrentness?.materialSourceSetFingerprint
    && impact.predecessorCut?.materialPathCount === 405
    && impact.predecessorCut?.receiptStatus === 'HISTORICAL_BASELINE_FOR_SCOPED_IMPACT_DISPOSITION'
    && impact.pdp1Predecessor?.receiptSha256 === pdp1ExitDigest
    && pdp1ReferenceUpdated
    && predecessor?.phase === 'PDP-2'
    && predecessor?.sourceCurrentness?.status === 'PASS'
    && predecessor?.sourceCurrentness?.sourceCurrent === true
    && predecessor?.sourceCurrentness?.materialSourceSetFingerprint === impact.predecessorCut.materialSourceSetFingerprint
    && predecessorPaths.length === 405
    && currentPaths.length === 405
    && missingPaths.length === 0
    && additionalPaths.length === 0
    && pathChanges.length === authorizedPaths.length
    && JSON.stringify(pathChanges) === JSON.stringify(authorizedPaths)
    && transitionsValid
    && reviewedPdp2SourcesValid
    && pdp2MeaningScopeValid
    && /^sha256:[a-f0-9]{64}$/u.test(impactDigest ?? '');
  return {
    valid,
    ref: impactPath,
    digest: impactDigest ?? null,
    predecessorRef: predecessorPath,
    predecessorDigest: predecessorDigest ?? null,
    predecessorMaterialSourceSetFingerprint: predecessor?.sourceCurrentness?.materialSourceSetFingerprint ?? null,
    materialPathCount: predecessorPaths.length,
    changedPathCount: pathChanges.length,
    changedPaths: pathChanges,
    scopedChangedPaths: impact?.sourceDeltas?.map(({ path: sourcePath }) => sourcePath) ?? [],
    scopedTransitions: impact?.sourceDeltas ?? [],
    missingPathCount: missingPaths.length,
    additionalPathCount: additionalPaths.length,
    transitionCount: impact?.sourceDeltas?.length ?? 0,
    supersedesR2Valid,
    inheritedAuthorizationValid,
    pdp2MeaningScopeValid,
    reviewedPdp2SourcesValid,
    pdp1PredecessorValid: predecessorPdp1MatchesR16,
    transitionsValid,
    meaningChangeCount: impact?.sourceDeltas?.filter((delta) => delta.meaningChange !== 'NO_ADDITIONAL_PDP2_MEANING').length ?? null,
    independentOrExternalOrLifecycleClaims: false,
  };
}

function validatePdp2CurrentCutImpactR4({ impact, predecessor, currentDigests, actualCurrentDigests, predecessorDigest, impactDigest, predecessorPath, impactPath, pdp1Exit, pdp1ExitDigest, pdp1ExitPath }) {
  const r3Path = PDP2_CURRENT_CUT_IMPACT_R3_PATH;
  const r3 = readJson(r3Path);
  const predecessorDigests = predecessor?.sourceCurrentness?.sourceSetDigests?.sourceContentDigests ?? {};
  const predecessorPaths = Object.keys(predecessorDigests).sort();
  const currentPaths = Object.keys(currentDigests ?? {}).sort();
  const missingPaths = predecessorPaths.filter((sourcePath) => !Object.hasOwn(currentDigests ?? {}, sourcePath));
  const additionalPaths = currentPaths.filter((sourcePath) => !Object.hasOwn(predecessorDigests, sourcePath));
  const pathChanges = predecessorPaths.filter((sourcePath) => currentDigests?.[sourcePath] !== predecessorDigests[sourcePath]);
  const expected = {
    '.product-experience/interface-parity/current-source-review.json': ['sha256:0ce764d11912596ee39057db9bd0f2dfbf3c85f6269d55632bda3b3e6e4ad0dd', 'sha256:90fc6830f99e26abd4c27222a6193f98b1756dfa48a9ac533b86c7de6ad2fa76'],
    '.product-experience/pdp-1-domain-data/handoff-contracts.yaml': ['sha256:3605ff3a216e8187acad158666be6e0a13801ee947099a7e657e3e29c59e9338', 'sha256:0055cb68ee08825d8936763353e011ffa5e3979562c42685566d525a6a074024'],
    '.product-experience/pdp-3-product-experience/action-registry.yaml': ['sha256:da420ef9636484039f64963219e8f361e1e4c35ed05fee61a6fbccc92a9ea4c2', 'sha256:832beaf50f03f9e3c4d8bf0f7e5f47ffe38b570c3e4864bef04c7362352180fe'],
    'docs/implementation/pdp-1-phase-dev-status.json': ['sha256:73a491d5ab0ba0c5ad97bde97d2f3592c13bf9282bb8cae197d34b25bff23e18', 'sha256:5e78da9588c880c497eb5e3e2a632910501ea722af05c1938c02bc5f64431e65'],
    'docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json': ['sha256:e0a67706f34270e8dd8a873a0193fc3ef50342acf417db2767d4b98f94217020', 'sha256:610a7eb85ab8be0c127f4e66361803496a784c01b53e8b0534d402cb75548b76'],
    'scripts/report-media-pdp-readiness.mjs': ['sha256:ca59f6c4e1313bd58387f91b41eb51fc1a10ac04b2db01faed30b9edcc9b2573', 'sha256:4f0400c142d2f3df39c4497839925dad80f1ac90584573b390af386e491faa0f'],
    '.product-experience/pdp-2-design-interface-system/component-value-types.yaml': ['sha256:e47dc82ee2b2bcb5b1908976b4be5f452c843854d578893ecf3f3d42287b35ba', 'sha256:aed62bda69a5d44bccee0873eb03bada142994d2256f515fbe1ea89af50d0313'],
    'tests/pdp-design-interface-component-contracts.test.mjs': ['sha256:338e06f661d423cc2cfc8ca5f2a71dce3957e947be45aad95a59273e1918ac4a', 'sha256:0242344bcc4c4880ee7242466acd00333f8d5402658987f4bd98fbab15331062'],
  };
  const expectedPaths = Object.keys(expected).sort();
  const authorizedPaths = expectedPaths.filter((sourcePath) => sourcePath !== '.product-experience/pdp-2-design-interface-system/component-value-types.yaml'
    && sourcePath !== 'tests/pdp-design-interface-component-contracts.test.mjs').sort();
  const supplementalPaths = [
    '.product-experience/pdp-2-design-interface-system/component-value-types.yaml',
    'tests/pdp-design-interface-component-contracts.test.mjs',
  ];
  const deltaPaths = (impact?.sourceDeltas ?? []).map(({ path: sourcePath }) => sourcePath).sort();
  const transitionsValid = Array.isArray(impact?.sourceDeltas) && impact.sourceDeltas.length === authorizedPaths.length
    && JSON.stringify(deltaPaths) === JSON.stringify(authorizedPaths)
    && impact.sourceDeltas.every((delta) => {
      const hashes = expected[delta.path];
      return hashes && delta.phase === 'PDP-2'
        && delta.predecessorSha256 === hashes[0] && delta.observedSha256 === hashes[1]
        && predecessorDigests[delta.path] === hashes[0]
        && currentDigests?.[delta.path] === hashes[1] && actualCurrentDigests?.[delta.path] === hashes[1]
        && delta.meaningChange === 'NO_ADDITIONAL_PDP2_MEANING'
        && Array.isArray(delta.meaningIdsChanged) && delta.meaningIdsChanged.length === 0
        && delta.requiresFreshCurrentness === true;
    });
  const supplementalSourceWorkValid = Array.isArray(impact?.supplementalSourceWork)
    && impact.supplementalSourceWork.length === supplementalPaths.length
    && JSON.stringify(impact.supplementalSourceWork.map(({ path: sourcePath }) => sourcePath).sort()) === JSON.stringify(supplementalPaths.sort())
    && impact.supplementalSourceWork.every((work) => {
      const hashes = expected[work.path];
      return hashes && work.predecessorSha256 === hashes[0] && work.observedSha256 === hashes[1]
        && predecessorDigests[work.path] === hashes[0]
        && currentDigests?.[work.path] === hashes[1] && actualCurrentDigests?.[work.path] === hashes[1]
        && work.requiresFreshCurrentness === true && Array.isArray(work.meaningIdsChanged) && work.meaningIdsChanged.length === 0
        && (work.path === '.product-experience/pdp-2-design-interface-system/component-value-types.yaml'
          ? work.workKind === 'CANONICAL_ACTION_IDENTITY_PROJECTION_REFRESH'
            && work.disposition === 'PRESERVES_EXISTING_PDP2_ENUM_IDENTITY_INVARIANT'
            && work.derivedFrom?.sourceRef === '.product-experience/pdp-2-design-interface-system/component-contracts.yaml'
            && work.derivedFrom?.selector === 'component value-type records MediaActionIntentRef and ActionIntentRef; both resolve to the exact current canonical action identity population'
            && work.addsGeneralRule === false
            && work.addsMeaningId === false
          : work.workKind === 'REGRESSION_TEST_FOR_CANONICAL_ACTION_IDENTITY_PROJECTION'
            && work.disposition === 'TEST_EVIDENCE_ONLY'
            && work.acceptanceCriterion === 'Both action-intent enums exactly equal sorted actions plus ownerDefinedActions from the canonical action registry');
    });
  const authorityValid = impact?.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION'
    && impact.authority?.decisionRole === 'SCOPED_INTERNAL_MEDIA_PDP2_SOURCE_IMPACT_REVIEW'
    && impact.authority?.userAuthorization === 'Authorize all six exact transitions (Recommended)'
    && impact.authority?.authorizationEvidence?.length === 1
    && impact.authority.authorizationEvidence[0]?.channel === 'USER_AUTHORIZATION_RELAYED_IN_PARENT_TASK'
    && impact.authority.authorizationEvidence[0]?.exactResponse === 'Authorize all six exact transitions (Recommended)'
    && JSON.stringify([...(impact.authority.authorizationEvidence[0]?.authorizedPaths ?? [])].sort()) === JSON.stringify(authorizedPaths)
    && JSON.stringify([...(impact.authority.authorizationEvidence[0]?.authorizedTransitions ?? [])].sort((a, b) => a.path.localeCompare(b.path)))
      === JSON.stringify(impact.sourceDeltas.map(({ path: sourcePath, predecessorSha256, observedSha256 }) => ({ path: sourcePath, predecessorSha256, observedSha256 })).sort((a, b) => a.path.localeCompare(b.path)))
    && impact.authority.pdp2DesignDirection?.sourceRef === `${OWNER_DECISION_PATH}#MEDIA-OWN-P2`
    && impact.authority.pdp2DesignDirection?.sourceSha256 === sha256(readText(OWNER_DECISION_PATH))
    && impact.authority.pdp2DesignDirection?.decisionId === 'MEDIA-DISCOVERY-OWNER-AUTHORIZATION-2026-10-13'
    && impact.authority.pdp2DesignDirection?.status === 'APPROVED_DESIGN_DIRECTION'
    && impact.authority.humanIndependentSignatureProvided === false
    && impact.authority.qualifiedExternalSpecialistSignoffProvided === false
    && impact.authority.externalContractOwnerAcceptanceProvided === false
    && impact.authority.nativeLifecycleReceiptProvided === false;
  const r9Digest = digestFile(PDP2_CURRENT_CUT_PREDECESSOR_R9_PATH);
  const predecessorValid = predecessorPath === PDP2_CURRENT_CUT_PREDECESSOR_R9_PATH
    && predecessorDigest === r9Digest && predecessorDigest === 'sha256:3720413ea63e00a9f1d57740e49d0f36d3e9ba1890584e2bdf66364595041bf0'
    && predecessor?.phase === 'PDP-2'
    && predecessor?.observationId === 'MEDIA-PDP2-CURRENTNESS-CURRENT-CUT-R9'
    && predecessor?.sourceCurrentness?.status === 'PASS'
    && predecessor?.sourceCurrentness?.sourceCurrent === true
    && predecessor?.sourceCurrentness?.materialSourceSetFingerprint === 'sha256:318b301bfb6ee4a4d27f141f8137930c2aa1353dc6b6e8d519ac015bc1ec1eda'
    && predecessorPaths.length === 405 && currentPaths.length === 405 && missingPaths.length === 0 && additionalPaths.length === 0
    && JSON.stringify(pathChanges) === JSON.stringify(expectedPaths);
  const p1PathValid = pdp1ExitPath === PDP1_CURRENT_CUT_EXIT_R19_PATH
    && pdp1ExitDigest === digestFile(PDP1_CURRENT_CUT_EXIT_R19_PATH)
    && pdp1Exit?.observationId === 'MEDIA-PDP1-CURRENTNESS-2026-10-14-CURRENT-CUT-R19'
    && pdp1Exit?.phase === 'PDP-1' && pdp1Exit?.phaseExit?.status === 'PASS'
    && pdp1Exit?.phaseExit?.sourceCurrentness === 'PASS'
    && pdp1Exit?.developmentStatus?.status === 'DEV_COMPLETE'
    && pdp1Exit?.sourceCurrentness?.sourceCurrent === true
    && pdp1Exit?.sourceCurrentness?.materialSourceSetFingerprint === 'sha256:b8351b8e78818d4c9805fe38223a848ba8f954960bc1f102dec38dbbba58526a'
    && pdp1Exit?.sourceCurrentness?.materialPathDenominator?.uniquePaths === 329
    && pdp1Exit?.sourceCurrentness?.cells?.length === 50
    && pdp1Exit?.developmentStatus?.outstandingMeaningIds?.length === 0;
  const reviewedSourcesValid = Array.isArray(impact?.reviewedPdp2Sources)
    && impact.reviewedPdp2Sources.every(({ path: sourcePath, sha256: expectedSha }) => {
      if (sourcePath === '.product-experience/pdp-2-design-interface-system/component-value-types.yaml') {
        return expectedSha === expected[sourcePath]?.[1] && currentDigests?.[sourcePath] === expectedSha && actualCurrentDigests?.[sourcePath] === expectedSha;
      }
      return predecessorDigests[sourcePath] === expectedSha && currentDigests?.[sourcePath] === expectedSha && actualCurrentDigests?.[sourcePath] === expectedSha;
    })
    && impact.reviewedPdp2Sources.some(({ path: sourcePath }) => sourcePath === '.product-experience/pdp-2-design-interface-system/semantic-state-grammar.yaml')
    && impact.reviewedPdp2Sources.some(({ path: sourcePath }) => sourcePath === '.product-experience/pdp-2-design-interface-system/component-contracts.yaml')
    && impact.reviewedPdp2Sources.some(({ path: sourcePath }) => sourcePath === '.product-experience/pdp-2-design-interface-system/component-value-types.yaml');
  const supersedesValid = impact?.supersedes?.ref === r3Path
    && impact.supersedes?.recordId === r3.recordId && impact.supersedes?.sha256 === digestFile(r3Path);
  const scopeValid = impact?.scopeLimits?.onlyTheseSixExactR9ToCurrentTransitionsAuthorized === true
    && impact.scopeLimits?.enumProjectionSourceDerivedFromExistingPdp2Direction === true
    && impact.scopeLimits?.regressionTestsAreEvidenceOnly === true
    && impact.scopeLimits?.noOtherPathAuthorizedByThisRecord === true
    && impact.scopeLimits?.pdp2Currentness === 'NOT_ESTABLISHED_REQUIRES_FRESH_RECAPTURE_AFTER_PDP1_R19'
    && impact.scopeLimits?.externalAcceptance === 'NOT_CLAIMED'
    && impact.scopeLimits?.independentSignoff === 'NOT_CLAIMED'
    && impact.scopeLimits?.lifecycleClosure === 'NOT_ENTERED'
    && impact.scopeLimits?.runtimeAdmission === 'NOT_ADMITTED'
    && impact.scopeLimits?.delivery === 'NOT_AUTHORIZED'
    && impact.decision?.requiresFreshCurrentness === true
    && impact.decision?.orderedRecapturePrerequisite === 'PDP-1 R19 currentness must be established before PDP-2 recapture'
    && impact.sourceDeltas?.every((delta) => delta.meaningIdsChanged.length === 0)
    && supplementalSourceWorkValid;
  const valid = impact?.recordId === 'MEDIA-DISCOVERY-PDP2-CURRENT-CUT-SOURCE-IMPACT-2026-10-14-R4'
    && impactPath === PDP2_CURRENT_CUT_IMPACT_R4_PATH && impactDigest === digestFile(PDP2_CURRENT_CUT_IMPACT_R4_PATH)
    && impact?.campaign?.repository === 'samujjwal/ghatana-media' && impact.campaign?.stage === 'DISCOVERY'
    && impact.campaign?.activePhase === 'PDP-2' && impact.campaign?.materialSourceSetFingerprint === predecessor?.sourceCurrentness?.materialSourceSetFingerprint
    && impact.campaign?.materialPathCount === 405
    && impact.predecessorCut?.phase === 'PDP-2' && impact.predecessorCut?.receiptRef === predecessorPath
    && impact.predecessorCut?.receiptSha256 === predecessorDigest && impact.predecessorCut?.materialPathCount === 405
    && impact.predecessorCut?.receiptStatus === 'HISTORICAL_BASELINE_FOR_SCOPED_IMPACT_DISPOSITION'
    && impact.pdp1Predecessor?.phase === 'PDP-1' && impact.pdp1Predecessor?.receiptRef === pdp1ExitPath
    && impact.pdp1Predecessor?.receiptSha256 === pdp1ExitDigest
    && impact.pdp1Predecessor?.sourceFingerprint === pdp1Exit?.sourceCurrentness?.materialSourceSetFingerprint
    && impact.pdp1Predecessor?.cellCount === 50 && impact.pdp1Predecessor?.outstandingMeaningIds === 0
    && predecessorValid && p1PathValid && transitionsValid && supplementalSourceWorkValid && authorityValid && reviewedSourcesValid && supersedesValid && scopeValid
    && /^sha256:[a-f0-9]{64}$/u.test(impactDigest ?? '');
  return {
    valid,
    ref: impactPath,
    digest: impactDigest ?? null,
    predecessorRef: predecessorPath,
    predecessorDigest: predecessorDigest ?? null,
    predecessorMaterialSourceSetFingerprint: predecessor?.sourceCurrentness?.materialSourceSetFingerprint ?? null,
    materialPathCount: predecessorPaths.length,
    changedPathCount: pathChanges.length,
    changedPaths: pathChanges,
    scopedChangedPaths: impact?.sourceDeltas?.map(({ path: sourcePath }) => sourcePath) ?? [],
    scopedTransitions: impact?.sourceDeltas ?? [],
    supplementalSourceWork: impact?.supplementalSourceWork ?? [],
    missingPathCount: missingPaths.length,
    additionalPathCount: additionalPaths.length,
    transitionCount: impact?.sourceDeltas?.length ?? 0,
    authorityValid,
    predecessorValid,
    pdp1PredecessorValid: p1PathValid,
    transitionsValid,
    supplementalSourceWorkValid,
    reviewedPdp2SourcesValid: reviewedSourcesValid,
    supersedesValid,
    pdp2MeaningScopeValid: scopeValid,
    meaningChangeCount: impact?.sourceDeltas?.filter((delta) => delta.meaningChange !== 'NO_ADDITIONAL_PDP2_MEANING').length ?? null,
    independentOrExternalOrLifecycleClaims: false,
  };
}

function validatePdp2CurrentCutImpactR5({ impact, predecessor, currentDigests, actualCurrentDigests, predecessorDigest, impactDigest, predecessorPath, impactPath, pdp1Exit, pdp1ExitDigest, pdp1ExitPath }) {
  const r4Path = PDP2_CURRENT_CUT_IMPACT_R4_PATH;
  const r4 = readJson(r4Path);
  const predecessorDigests = predecessor?.sourceCurrentness?.sourceSetDigests?.sourceContentDigests ?? {};
  const predecessorPaths = Object.keys(predecessorDigests).sort();
  const currentPaths = Object.keys(currentDigests ?? {}).sort();
  const changedPaths = predecessorPaths.filter((sourcePath) => predecessorDigests[sourcePath] !== currentDigests?.[sourcePath]);
  const expected = {
    '.product-experience/interface-parity/current-source-review.json': ['sha256:0ce764d11912596ee39057db9bd0f2dfbf3c85f6269d55632bda3b3e6e4ad0dd', 'sha256:90fc6830f99e26abd4c27222a6193f98b1756dfa48a9ac533b86c7de6ad2fa76'],
    '.product-experience/pdp-1-domain-data/handoff-contracts.yaml': ['sha256:3605ff3a216e8187acad158666be6e0a13801ee947099a7e657e3e29c59e9338', 'sha256:0055cb68ee08825d8936763353e011ffa5e3979562c42685566d525a6a074024'],
    '.product-experience/pdp-3-product-experience/action-registry.yaml': ['sha256:da420ef9636484039f64963219e8f361e1e4c35ed05fee61a6fbccc92a9ea4c2', 'sha256:832beaf50f03f9e3c4d8bf0f7e5f47ffe38b570c3e4864bef04c7362352180fe'],
    'docs/implementation/pdp-1-phase-dev-status.json': ['sha256:73a491d5ab0ba0c5ad97bde97d2f3592c13bf9282bb8cae197d34b25bff23e18', 'sha256:5e78da9588c880c497eb5e3e2a632910501ea722af05c1938c02bc5f64431e65'],
    'docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json': ['sha256:e0a67706f34270e8dd8a873a0193fc3ef50342acf417db2767d4b98f94217020', 'sha256:610a7eb85ab8be0c127f4e66361803496a784c01b53e8b0534d402cb75548b76'],
    'scripts/report-media-pdp-readiness.mjs': ['sha256:ca59f6c4e1313bd58387f91b41eb51fc1a10ac04b2db01faed30b9edcc9b2573', 'sha256:4f0400c142d2f3df39c4497839925dad80f1ac90584573b390af386e491faa0f'],
    '.product-experience/interface-parity/operation-parity.yaml': ['sha256:8b95782fe47cb7e44ec159c168399f78a674dbc1c6f72065881c278f7e3c13d6', 'sha256:24e4699d42dd1a2a0363628387fdf2a12c539f8ac697a0b8771277bbd4aa8555'],
    '.product-experience/interface-parity/current-source-review.json#R5': ['sha256:90fc6830f99e26abd4c27222a6193f98b1756dfa48a9ac533b86c7de6ad2fa76', 'sha256:866729bdb41448d7e1d08ca288e5e71300f999d26e85cd53d2e5377ecdf299bd'],
    'docs/implementation/pdp-1-phase-dev-status.json#R5': ['sha256:5e78da9588c880c497eb5e3e2a632910501ea722af05c1938c02bc5f64431e65', 'sha256:eb9e7e8ce14c73469daf29406642793c58669351a0035d7bd937e9fe79b8dd2d'],
    'docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json#R5': ['sha256:610a7eb85ab8be0c127f4e66361803496a784c01b53e8b0534d402cb75548b76', 'sha256:e9350fb4424fceeca2f13b93f756231e5b648904bb002de11d3d9659a0b994b6'],
    'tests/pdp-design-interface-parity.test.mjs': ['sha256:0a62ff64736fa6f8a4965a9ba10dffb4213b22c22a6c23e02b681da225a16d6b', 'sha256:bf459ddf4af32ba7a960c8b2909e65f873453c276dafc7bff9660842f7e21acd'],
  };
  const transitions = impact?.sourceDeltas ?? [];
  const expectedTransitions = [
    { path: '.product-experience/interface-parity/current-source-review.json', predecessorSha256: expected['.product-experience/interface-parity/current-source-review.json'][0], observedSha256: expected['.product-experience/interface-parity/current-source-review.json'][1], classification: 'PDP1_INTERFACE_SOURCE_REVIEW_REFRESH', meaningChange: 'NO_ADDITIONAL_PDP2_MEANING', meaningIdsChanged: [] },
    { path: '.product-experience/pdp-1-domain-data/handoff-contracts.yaml', predecessorSha256: expected['.product-experience/pdp-1-domain-data/handoff-contracts.yaml'][0], observedSha256: expected['.product-experience/pdp-1-domain-data/handoff-contracts.yaml'][1], classification: 'PDP1_OWNER_OPERATION_HANDOFF_POPULATION_REFRESH', meaningChange: 'NO_ADDITIONAL_PDP2_MEANING', meaningIdsChanged: [] },
    { path: '.product-experience/pdp-3-product-experience/action-registry.yaml', predecessorSha256: expected['.product-experience/pdp-3-product-experience/action-registry.yaml'][0], observedSha256: expected['.product-experience/pdp-3-product-experience/action-registry.yaml'][1], classification: 'PDP3_ACTION_REGISTRY_MEANING_WITHOUT_PDP2_MEANING', meaningChange: 'NO_ADDITIONAL_PDP2_MEANING', meaningIdsChanged: [] },
    { path: 'docs/implementation/pdp-1-phase-dev-status.json', predecessorSha256: expected['docs/implementation/pdp-1-phase-dev-status.json'][0], observedSha256: expected['docs/implementation/pdp-1-phase-dev-status.json'][1], classification: 'PDP1_PHASE_STATUS_AND_CURRENTNESS_REFRESH', meaningChange: 'NO_ADDITIONAL_PDP2_MEANING', meaningIdsChanged: [] },
    { path: 'docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json', predecessorSha256: expected['docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json'][0], observedSha256: expected['docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json'][1], classification: 'PDP1_SEMANTIC_REVIEW_EVIDENCE_REFRESH', meaningChange: 'NO_ADDITIONAL_PDP2_MEANING', meaningIdsChanged: [] },
    { path: 'scripts/report-media-pdp-readiness.mjs', predecessorSha256: expected['scripts/report-media-pdp-readiness.mjs'][0], observedSha256: expected['scripts/report-media-pdp-readiness.mjs'][1], classification: 'PDP_STATUS_TEST_REPORTER_SELECTION_ONLY', meaningChange: 'NO_ADDITIONAL_PDP2_MEANING', meaningIdsChanged: [] },
    { path: '.product-experience/interface-parity/operation-parity.yaml', predecessorSha256: expected['.product-experience/interface-parity/operation-parity.yaml'][0], observedSha256: expected['.product-experience/interface-parity/operation-parity.yaml'][1], classification: 'PDP2_DELIVERY_ACK_EVIDENCE_BINDING_WITH_PDP3_PROJECTION', meaningChange: 'PDP2_DEFINITION_CHANGE_LIMITED_TO_MDC30_C22_DELIVERY_ACK_EVIDENCE_BINDING', meaningIdsChanged: ['MDC30-C-22'] },
    { path: '.product-experience/interface-parity/current-source-review.json', predecessorSha256: expected['.product-experience/interface-parity/current-source-review.json#R5'][0], observedSha256: expected['.product-experience/interface-parity/current-source-review.json#R5'][1], classification: 'PDP2_INTERFACE_CURRENT_SOURCE_REVIEW_REFRESH', meaningChange: 'NO_ADDITIONAL_PDP2_MEANING', meaningIdsChanged: [] },
    { path: 'docs/implementation/pdp-1-phase-dev-status.json', predecessorSha256: expected['docs/implementation/pdp-1-phase-dev-status.json#R5'][0], observedSha256: expected['docs/implementation/pdp-1-phase-dev-status.json#R5'][1], classification: 'PDP1_PHASE_STATUS_AND_CURRENTNESS_REFRESH', meaningChange: 'NO_ADDITIONAL_PDP2_MEANING', meaningIdsChanged: [] },
    { path: 'docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json', predecessorSha256: expected['docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json#R5'][0], observedSha256: expected['docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json#R5'][1], classification: 'PDP1_SEMANTIC_REVIEW_EVIDENCE_REFRESH', meaningChange: 'NO_ADDITIONAL_PDP2_MEANING', meaningIdsChanged: [] },
    { path: 'tests/pdp-design-interface-parity.test.mjs', predecessorSha256: expected['tests/pdp-design-interface-parity.test.mjs'][0], observedSha256: expected['tests/pdp-design-interface-parity.test.mjs'][1], classification: 'PDP2_CURRENT_SOURCE_IMPACT_TEST_EVIDENCE_ONLY', meaningChange: 'TEST_ONLY', meaningIdsChanged: [] },
  ].map((delta) => ({ ...delta, phase: 'PDP-2', requiresFreshCurrentness: true }));
  const tuple = ({ path: sourcePath, phase, predecessorSha256, observedSha256, classification, meaningChange, meaningIdsChanged, requiresFreshCurrentness }) => ({ path: sourcePath, phase, predecessorSha256, observedSha256, classification, meaningChange, meaningIdsChanged, requiresFreshCurrentness });
  const transitionValid = transitions.length === expectedTransitions.length
    && JSON.stringify(transitions.map(tuple)) === JSON.stringify(expectedTransitions.map(tuple));
  const terminalDigests = Object.fromEntries([...new Set(expectedTransitions.map(({ path: sourcePath }) => sourcePath))].map((sourcePath) => {
    const terminal = [...expectedTransitions].reverse().find((delta) => delta.path === sourcePath);
    return [sourcePath, terminal.observedSha256];
  }));
  const sourceBindingsValid = Object.entries(terminalDigests).every(([sourcePath, terminalDigest]) => currentDigests?.[sourcePath] === terminalDigest
    && actualCurrentDigests?.[sourcePath] === terminalDigest
    && predecessorDigests[sourcePath] === expectedTransitions.find((delta) => delta.path === sourcePath).predecessorSha256);
  const r4PrefixValid = transitionValid && transitions.slice(0, 6).every((delta) => delta.meaningChange === 'NO_ADDITIONAL_PDP2_MEANING' && delta.meaningIdsChanged.length === 0);
  const operationDelta = transitions.find((delta) => delta.path === '.product-experience/interface-parity/operation-parity.yaml');
  const operationMeaningValid = operationDelta?.meaningChange === 'PDP2_DEFINITION_CHANGE_LIMITED_TO_MDC30_C22_DELIVERY_ACK_EVIDENCE_BINDING'
    && JSON.stringify(operationDelta.meaningIdsChanged) === JSON.stringify(['MDC30-C-22'])
    && impact?.scopeLimits?.operationParityFallbackInventory === 'PDP3_PROJECTION'
    && impact?.scopeLimits?.operationParityDeliveryAcknowledgment === 'PDP2_DEFINITION_CHANGE_ALIGNED_MDC30-C-22';
  const r9Digest = digestFile(PDP2_CURRENT_CUT_PREDECESSOR_R9_PATH);
  const predecessorValid = predecessorPath === PDP2_CURRENT_CUT_PREDECESSOR_R9_PATH && predecessorDigest === r9Digest
    && predecessorDigest === 'sha256:3720413ea63e00a9f1d57740e49d0f36d3e9ba1890584e2bdf66364595041bf0'
    && predecessor?.observationId === 'MEDIA-PDP2-CURRENTNESS-CURRENT-CUT-R9'
    && predecessor?.sourceCurrentness?.materialSourceSetFingerprint === 'sha256:318b301bfb6ee4a4d27f141f8137930c2aa1353dc6b6e8d519ac015bc1ec1eda'
    && predecessorPaths.length === 405 && currentPaths.length === 405;
  const p1Valid = pdp1ExitPath === PDP1_CURRENT_CUT_EXIT_R22_PATH
    && pdp1ExitDigest === 'sha256:bb448dc45d3db788ef16802f8a92dc8054a6fc6aaa27f047c42b4f6c91feb303'
    && pdp1ExitDigest === digestFile(PDP1_CURRENT_CUT_EXIT_R22_PATH)
    && pdp1Exit?.observationId === 'MEDIA-PDP1-CURRENTNESS-2026-10-14-CURRENT-CUT-R22'
    && pdp1Exit?.phase === 'PDP-1' && pdp1Exit?.phaseExit?.status === 'PASS' && pdp1Exit?.phaseExit?.sourceCurrentness === 'PASS'
    && pdp1Exit?.developmentStatus?.status === 'DEV_COMPLETE' && pdp1Exit?.developmentStatus?.outstandingMeaningIds?.length === 0
    && pdp1Exit?.sourceCurrentness?.sourceCurrent === true
    && pdp1Exit?.sourceCurrentness?.materialSourceSetFingerprint === 'sha256:66bbc971734f92ae8f51446582f4a1118704168acac3c0e33783efbb208a5a0b'
    && pdp1Exit?.sourceCurrentness?.materialPathDenominator?.uniquePaths === 329 && pdp1Exit?.sourceCurrentness?.cells?.length === 50;
  const supplementalPaths = ['.product-experience/pdp-2-design-interface-system/component-value-types.yaml', 'tests/pdp-design-interface-component-contracts.test.mjs'];
  const supplementalPairs = {
    '.product-experience/pdp-2-design-interface-system/component-value-types.yaml': ['sha256:e47dc82ee2b2bcb5b1908976b4be5f452c843854d578893ecf3f3d42287b35ba', 'sha256:aed62bda69a5d44bccee0873eb03bada142994d2256f515fbe1ea89af50d0313'],
    'tests/pdp-design-interface-component-contracts.test.mjs': ['sha256:338e06f661d423cc2cfc8ca5f2a71dce3957e947be45aad95a59273e1918ac4a', 'sha256:0242344bcc4c4880ee7242466acd00333f8d5402658987f4bd98fbab15331062'],
  };
  const supplementalValid = Array.isArray(impact?.supplementalSourceWork) && impact.supplementalSourceWork.length === 2
    && impact.supplementalSourceWork.every((work) => work.requiresFreshCurrentness === true && Array.isArray(work.meaningIdsChanged) && work.meaningIdsChanged.length === 0
      && work.predecessorSha256 === supplementalPairs[work.path]?.[0] && work.observedSha256 === supplementalPairs[work.path]?.[1]
      && predecessorDigests[work.path] === work.predecessorSha256 && currentDigests?.[work.path] === work.observedSha256 && actualCurrentDigests?.[work.path] === work.observedSha256)
    && JSON.stringify(impact.supplementalSourceWork.map(({ path: sourcePath }) => sourcePath).sort()) === JSON.stringify(supplementalPaths.sort())
    && impact.supplementalSourceWork.some((work) => work.path === supplementalPaths[0]
      && work.workKind === 'CANONICAL_ACTION_IDENTITY_PROJECTION_REFRESH'
      && work.disposition === 'PRESERVES_EXISTING_PDP2_ENUM_IDENTITY_INVARIANT'
      && work.derivedFrom?.sourceRef === '.product-experience/pdp-2-design-interface-system/component-contracts.yaml'
      && work.derivedFrom?.sha256 === 'sha256:6bcd90f59bee7df018bcbff57776fa53290e22eac1cf18519c4759551d71bb63'
      && work.addsGeneralRule === false && work.addsMeaningId === false)
    && impact.supplementalSourceWork.some((work) => work.path === supplementalPaths[1]
      && work.workKind === 'REGRESSION_TEST_FOR_CANONICAL_ACTION_IDENTITY_PROJECTION'
      && work.disposition === 'TEST_EVIDENCE_ONLY'
      && work.acceptanceCriterion === 'Both action-intent enums exactly equal sorted actions plus ownerDefinedActions from the canonical action registry');
  const reviewedSourcesValid = Array.isArray(impact?.reviewedPdp2Sources)
    && impact.reviewedPdp2Sources.every(({ path: sourcePath, sha256: sourceDigest }) => currentDigests?.[sourcePath] === sourceDigest && actualCurrentDigests?.[sourcePath] === sourceDigest)
    && impact.reviewedPdp2Sources.some(({ path: sourcePath }) => sourcePath === '.product-experience/pdp-2-design-interface-system/semantic-state-grammar.yaml')
    && impact.reviewedPdp2Sources.some(({ path: sourcePath }) => sourcePath === '.product-experience/pdp-2-design-interface-system/component-contracts.yaml')
    && impact.reviewedPdp2Sources.some(({ path: sourcePath }) => sourcePath === '.product-experience/pdp-2-design-interface-system/component-value-types.yaml');
  const statusGuard = pdp3StatusGuardSupplement(readJson(HISTORICAL_P2_EXIT_PATH), currentDigests);
  const authorityValid = impact?.authority?.humanIndependentSignatureProvided === false
    && impact?.authority?.qualifiedExternalSpecialistSignoffProvided === false
    && impact?.authority?.externalContractOwnerAcceptanceProvided === false
    && impact?.authority?.nativeLifecycleReceiptProvided === false
    && impact.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION'
    && impact.authority?.decisionRole === 'SCOPED_INTERNAL_MEDIA_PDP2_SOURCE_IMPACT_REVIEW'
    && impact.authority?.userAuthorization === 'Authorize these exact dispositions (Recommended)'
    && impact.authority?.pdp2DesignDirection?.sourceRef === `${OWNER_DECISION_PATH}#MEDIA-OWN-P2`
    && impact.authority.pdp2DesignDirection?.sourceSha256 === sha256(readText(OWNER_DECISION_PATH))
    && impact.authority.pdp2DesignDirection?.decisionId === 'MEDIA-DISCOVERY-OWNER-AUTHORIZATION-2026-10-13'
    && impact.authority.pdp2DesignDirection?.status === 'APPROVED_DESIGN_DIRECTION';
  const evidence = impact?.authority?.authorizationEvidence ?? [];
  const expectedEvidence = [
    {
      channel: 'USER_AUTHORIZATION_RELAYED_IN_PARENT_TASK',
      exactResponse: 'Authorize all six exact transitions (Recommended)',
      authorizedPaths: ['.product-experience/interface-parity/current-source-review.json', '.product-experience/pdp-1-domain-data/handoff-contracts.yaml', '.product-experience/pdp-3-product-experience/action-registry.yaml', 'docs/implementation/pdp-1-phase-dev-status.json', 'docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json', 'scripts/report-media-pdp-readiness.mjs'],
      authorizedTransitions: expectedTransitions.slice(0, 6).map(({ path: sourcePath, predecessorSha256, observedSha256 }) => ({ path: sourcePath, predecessorSha256, observedSha256 })),
      scope: 'No additional PDP-2 meaning for these six exact R9-to-live transitions.',
    },
    {
      channel: 'USER_AUTHORIZATION_RELAYED_IN_PARENT_TASK',
      exactResponse: 'Authorize these exact dispositions (Recommended)',
      authorizedPaths: ['.product-experience/interface-parity/operation-parity.yaml', '.product-experience/interface-parity/current-source-review.json', 'docs/implementation/pdp-1-phase-dev-status.json', 'docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json', 'tests/pdp-design-interface-parity.test.mjs'],
      authorizedTransitions: expectedTransitions.slice(6).map(({ path: sourcePath, predecessorSha256, observedSha256 }) => ({ path: sourcePath, predecessorSha256, observedSha256 })),
      scope: 'Only these exact five R9-to-live transitions; operation-parity carries PDP-2 delivery-ack evidence binding aligned to MDC30-C-22, while fallback inventory is a PDP-3 projection.',
    },
  ];
  const authorizationEvidenceValid = evidence.length === expectedEvidence.length && evidence.every((item, index) => {
    const expectedItem = expectedEvidence[index];
    return item.channel === expectedItem.channel && item.exactResponse === expectedItem.exactResponse
      && JSON.stringify(item.authorizedPaths) === JSON.stringify(expectedItem.authorizedPaths)
      && JSON.stringify(item.authorizedTransitions) === JSON.stringify(expectedItem.authorizedTransitions)
      && item.scope === expectedItem.scope;
  });
  const supersedesValid = impact?.supersedes?.ref === r4Path && impact.supersedes?.recordId === r4.recordId && impact.supersedes?.sha256 === digestFile(r4Path);
  const valid = impact?.recordId === 'MEDIA-DISCOVERY-PDP2-CURRENT-CUT-SOURCE-IMPACT-2026-10-14-R5'
    && impactPath === PDP2_CURRENT_CUT_IMPACT_R5_PATH && impactDigest === digestFile(PDP2_CURRENT_CUT_IMPACT_R5_PATH)
    && impact?.campaign?.repository === 'samujjwal/ghatana-media' && impact.campaign?.stage === 'DISCOVERY' && impact.campaign?.activePhase === 'PDP-2'
    && impact.campaign?.materialPathCount === 405 && impact.predecessorCut?.receiptRef === predecessorPath && impact.predecessorCut?.receiptSha256 === predecessorDigest
    && impact.pdp1Predecessor?.receiptRef === pdp1ExitPath && impact.pdp1Predecessor?.receiptSha256 === pdp1ExitDigest
    && impact.pdp1Predecessor?.sourceFingerprint === pdp1Exit?.sourceCurrentness?.materialSourceSetFingerprint
    && impact.scopeLimits?.onlyTheseSixInheritedR4TransitionsAuthorized === true
    && impact.scopeLimits?.onlyTheseFiveAdditionalExactR9ToLiveTransitionsAuthorized === true
    && impact.scopeLimits?.noOtherPathAuthorizedByThisRecord === true
    && impact.scopeLimits?.preserveEarlierReceipts === true
    && impact.scopeLimits?.externalAcceptance === 'NOT_CLAIMED' && impact.scopeLimits?.independentSignoff === 'NOT_CLAIMED'
    && impact.scopeLimits?.lifecycleClosure === 'NOT_ENTERED' && impact.scopeLimits?.runtimeAdmission === 'NOT_ADMITTED'
    && impact.scopeLimits?.delivery === 'NOT_AUTHORIZED'
    && transitionValid && sourceBindingsValid && r4PrefixValid && operationMeaningValid && predecessorValid && p1Valid
    && supplementalValid && reviewedSourcesValid && statusGuard.valid && authorizationEvidenceValid && authorityValid && supersedesValid;
  const uniqueChangedPaths = [...new Set(transitions.map(({ path: sourcePath }) => sourcePath))];
  return { valid, ref: impactPath, digest: impactDigest ?? null, predecessorRef: predecessorPath, predecessorDigest: predecessorDigest ?? null,
    predecessorMaterialSourceSetFingerprint: predecessor?.sourceCurrentness?.materialSourceSetFingerprint ?? null, materialPathCount: predecessorPaths.length,
    changedPathCount: changedPaths.length, changedPaths, scopedChangedPaths: uniqueChangedPaths, scopedTransitions: transitions,
    supplementalSourceWork: impact?.supplementalSourceWork ?? [], missingPathCount: predecessorPaths.filter((p) => !Object.hasOwn(currentDigests ?? {}, p)).length,
    additionalPathCount: currentPaths.filter((p) => !Object.hasOwn(predecessorDigests, p)).length, transitionCount: transitions.length,
    authorityValid, predecessorValid, pdp1PredecessorValid: p1Valid, transitionsValid: transitionValid && sourceBindingsValid && r4PrefixValid && operationMeaningValid,
    authorizationEvidenceValid, statusGuardChainValid: statusGuard.chainValid,
    supplementalSourceWorkValid: supplementalValid, reviewedPdp2SourcesValid: reviewedSourcesValid, supersedesValid, pdp2MeaningScopeValid: operationMeaningValid,
    meaningChangeCount: transitions.filter((d) => d.meaningChange !== 'NO_ADDITIONAL_PDP2_MEANING' && d.meaningChange !== 'TEST_ONLY').length,
    independentOrExternalOrLifecycleClaims: false };
}
export function validatePdp2CurrentCutImpact({ impact, predecessor, currentDigests, actualCurrentDigests, predecessorDigest, impactDigest, predecessorPath = PDP2_CURRENT_CUT_PREDECESSOR_PATH, impactPath = PDP2_CURRENT_CUT_IMPACT_PATH, pdp1Exit, pdp1ExitDigest, pdp1ExitPath = PDP1_CURRENT_CUT_EXIT_PATH }) {
  if (impact?.recordId === 'MEDIA-DISCOVERY-PDP2-CURRENT-CUT-SOURCE-IMPACT-2026-10-14-R5') {
    return validatePdp2CurrentCutImpactR5({ impact, predecessor, currentDigests, actualCurrentDigests, predecessorDigest, impactDigest, predecessorPath, impactPath, pdp1Exit, pdp1ExitDigest, pdp1ExitPath });
  }
  if (impact?.recordId === 'MEDIA-DISCOVERY-PDP2-CURRENT-CUT-SOURCE-IMPACT-2026-10-14-R4') {
    return validatePdp2CurrentCutImpactR4({ impact, predecessor, currentDigests, actualCurrentDigests, predecessorDigest, impactDigest, predecessorPath, impactPath, pdp1Exit, pdp1ExitDigest, pdp1ExitPath });
  }
  if (impact?.recordId === 'MEDIA-DISCOVERY-PDP2-CURRENT-CUT-SOURCE-IMPACT-2026-10-14-R3') {
    return validatePdp2CurrentCutImpactR3({
      impact,
      predecessor,
      currentDigests,
      actualCurrentDigests,
      predecessorDigest,
      impactDigest,
      predecessorPath,
      impactPath,
      pdp1Exit,
      pdp1ExitDigest,
      pdp1ExitPath,
    });
  }
  const authorizedPaths = [
    '.product-experience/decision-log.md',
    '.product-experience/interface-parity/current-source-review.json',
    '.product-experience/pdp-1-domain-data/handoff-contracts.yaml',
    'docs/implementation/pdp-1-phase-dev-status.json',
    'docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json',
    'scripts/report-media-pdp-readiness.mjs',
  ];
  const authorizedClassifications = {
    '.product-experience/decision-log.md': 'PDP1_DELEGATED_DEFINITION_DECISION_LOG_PREDECESSOR_REFRESH',
    '.product-experience/interface-parity/current-source-review.json': 'PDP1_INTERFACE_SOURCE_REVIEW_REFRESH',
    '.product-experience/pdp-1-domain-data/handoff-contracts.yaml': 'PDP1_OWNER_OPERATION_HANDOFF_POPULATION_REFRESH',
    'docs/implementation/pdp-1-phase-dev-status.json': 'PDP1_PHASE_STATUS_AND_CURRENTNESS_REFRESH',
    'docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json': 'PDP1_SEMANTIC_REVIEW_EVIDENCE_REFRESH',
    'scripts/report-media-pdp-readiness.mjs': 'PDP_STATUS_TEST_REPORTER_SELECTION_ONLY',
  };
  const authorizationHashTransitions = {
    '.product-experience/decision-log.md': ['sha256:cdea20d6fa57cc4d7bbea866d911c03685eeb74e0bfdb4e0a5df0c90ded56db4', 'sha256:9831b03ecd3f30d2cbfd7a1db62d934035ba20cf1482bb5e621d166eacdb9b4c'],
    '.product-experience/interface-parity/current-source-review.json': ['sha256:14cf6c3d9ea948e39e41ffa2de3453c08b7b6a23267f407f3504c5462b7428fc', 'sha256:0ce764d11912596ee39057db9bd0f2dfbf3c85f6269d55632bda3b3e6e4ad0dd'],
    '.product-experience/pdp-1-domain-data/handoff-contracts.yaml': ['sha256:4e1553875033beb543aabdae013385057a3651a83a1db7949ce7c5704c2acf55', 'sha256:3605ff3a216e8187acad158666be6e0a13801ee947099a7e657e3e29c59e9338'],
    'docs/implementation/pdp-1-phase-dev-status.json': ['sha256:ee7b68839a6fba3745f27183ce13ec45d9b90e32f0f5df376952f4bde40ae23b', 'sha256:73a491d5ab0ba0c5ad97bde97d2f3592c13bf9282bb8cae197d34b25bff23e18'],
    'docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json': ['sha256:ab5ebe42f834ec604f4bd0cd525f0b779d58fdd73ff0851d731669ef132eb680', 'sha256:e0a67706f34270e8dd8a873a0193fc3ef50342acf417db2767d4b98f94217020'],
    'scripts/report-media-pdp-readiness.mjs': ['sha256:f3482cf689e0be2d8dc9faf9ccc72a1b63a1dcaecd056efaa1759e6f3696a5e1', 'sha256:ca59f6c4e1313bd58387f91b41eb51fc1a10ac04b2db01faed30b9edcc9b2573'],
  };
  const reviewedPdp2SourcePaths = [
    '.product-experience/pdp-2-design-interface-system/DESIGN-LANGUAGE.md',
    '.product-experience/pdp-2-design-interface-system/cli-language.yaml',
    '.product-experience/pdp-2-design-interface-system/semantic-state-grammar.yaml',
    '.product-experience/pdp-2-design-interface-system/component-contracts.yaml',
    '.product-experience/pdp-2-design-interface-system/action-finality-grammar.yaml',
    '.product-experience/pdp-2-design-interface-system/media-editing-grammar.yaml',
    '.product-experience/pdp-2-design-interface-system/api/async-operations.yaml',
    '.product-experience/pdp-2-design-interface-system/gui/templates/catalog.yaml',
    '.product-experience/pdp-2-design-interface-system/interface-grammar.yaml',
  ];
  const expectedTransitions = impact?.sourceDeltas;
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
  const previousR1Path = 'docs/implementation/observations/media-discovery-pdp2-current-cut-source-impact-2026-10-14-r1.json';
  const previousImpact = readJson(previousR1Path);
  const inheritedReporterAuthorization = previousImpact?.sourceDeltas?.find((delta) => delta.path === 'scripts/report-media-pdp-readiness.mjs');
  const firstAuthorization = impact?.authority?.authorizationEvidence?.[0];
  const secondAuthorization = impact?.authority?.authorizationEvidence?.[1];
  const fiveNewlyAuthorizedPaths = authorizedPaths.filter((sourcePath) => sourcePath !== 'scripts/report-media-pdp-readiness.mjs');
  const fiveNewlyAuthorized = secondAuthorization?.authorizedTransitions;
  const fiveNewlyAuthorizedByPath = new Map((fiveNewlyAuthorized ?? []).map((entry) => [entry.path, entry]));
  const transitionsValid = Array.isArray(deltas) && deltas.length === authorizedPaths.length
    && deltas.map((delta) => delta?.path).sort().every((sourcePath, index) => sourcePath === [...authorizedPaths].sort()[index])
    && expectedTransitions.every((delta) => {
      return delta?.phase === 'PDP-2'
        && /^sha256:[a-f0-9]{64}$/u.test(delta.predecessorSha256 ?? '')
        && /^sha256:[a-f0-9]{64}$/u.test(delta.observedSha256 ?? '')
        && delta.classification === authorizedClassifications[delta.path]
        && delta.meaningChange === 'NO_ADDITIONAL_PDP2_MEANING'
        && Array.isArray(delta.meaningIdsChanged) && delta.meaningIdsChanged.length === 0
        && delta.requiresFreshCurrentness === true
        && (delta.path === 'scripts/report-media-pdp-readiness.mjs'
          ? (delta.predecessorSha256 === inheritedReporterAuthorization?.predecessorSha256
            && delta.observedSha256 === inheritedReporterAuthorization?.observedSha256)
          : (delta.predecessorSha256 === fiveNewlyAuthorizedByPath.get(delta.path)?.predecessorSha256
            && delta.observedSha256 === fiveNewlyAuthorizedByPath.get(delta.path)?.observedSha256))
        && predecessorDigests[delta.path] === delta.predecessorSha256
        && currentDigests?.[delta.path] === delta.observedSha256
        && actualCurrentDigests?.[delta.path] === delta.observedSha256;
    });
  const authorizationEvidenceValid = impact?.authority?.authorizationEvidence?.length === 2
    && firstAuthorization?.channel === 'DIRECT_USER_REPLY_IN_CURRENT_TASK'
    && firstAuthorization?.exactResponse === 'Authorize scoped PDP-2 disposition (Recommended)'
    && firstAuthorization?.previousImpactRef === previousR1Path
    && previousImpact?.recordId === 'MEDIA-DISCOVERY-PDP2-CURRENT-CUT-SOURCE-IMPACT-2026-10-14-R1'
    && previousImpact?.predecessorCut?.receiptRef === predecessorPath
    && previousImpact?.predecessorCut?.receiptSha256 === predecessorDigest
    && JSON.stringify(firstAuthorization?.authorizedPaths) === JSON.stringify([
      '.product-experience/interface-parity/current-source-review.json',
      'scripts/report-media-pdp-readiness.mjs',
    ])
    && secondAuthorization?.channel === 'DIRECT_USER_REPLY_IN_CURRENT_TASK'
    && secondAuthorization?.exactResponse === 'Authorize five exact transitions (Recommended)'
    && Array.isArray(fiveNewlyAuthorized) && fiveNewlyAuthorized.length === fiveNewlyAuthorizedPaths.length
    && fiveNewlyAuthorized.map((entry) => entry.path).sort().every((sourcePath, index) => sourcePath === [...fiveNewlyAuthorizedPaths].sort()[index])
    && fiveNewlyAuthorized.every((entry) => {
      const [predecessorSha256, observedSha256] = authorizationHashTransitions[entry.path] ?? [];
      return entry.predecessorSha256 === predecessorSha256 && entry.observedSha256 === observedSha256;
    })
    && impact.supersedes?.ref === previousR1Path
    && impact.supersedes?.recordId === 'MEDIA-DISCOVERY-PDP2-CURRENT-CUT-SOURCE-IMPACT-2026-10-14-R1'
    && impact.supersedes?.sha256 === digestFile(previousR1Path);
  const reviewedPdp2Sources = impact?.reviewedPdp2Sources;
  const reviewedPdp2SourcesValid = Array.isArray(reviewedPdp2Sources)
    && reviewedPdp2Sources.length === reviewedPdp2SourcePaths.length
    && reviewedPdp2Sources.map((entry) => entry.path).sort().every((sourcePath, index) => sourcePath === [...reviewedPdp2SourcePaths].sort()[index])
    && reviewedPdp2Sources.every((entry) => typeof entry.selector === 'string' && entry.selector.length > 0
      && /^sha256:[a-f0-9]{64}$/u.test(entry.sha256 ?? '')
      && predecessorDigests[entry.path] === entry.sha256
      && currentDigests?.[entry.path] === entry.sha256
      && actualCurrentDigests?.[entry.path] === entry.sha256);
  const pdp1PredecessorValid = impact?.pdp1Predecessor?.phase === 'PDP-1'
    && impact.pdp1Predecessor.receiptRef === pdp1ExitPath
    && impact.pdp1Predecessor.receiptSha256 === pdp1ExitDigest
    && pdp1Exit?.phase === 'PDP-1'
    && pdp1Exit?.phaseExit?.status === 'PASS'
    && pdp1Exit?.phaseExit?.sourceCurrentness === 'PASS'
    && pdp1Exit?.developmentStatus?.status === 'DEV_COMPLETE'
    && pdp1Exit?.sourceCurrentness?.materialPathDenominator?.uniquePaths === 329
    && pdp1Exit?.sourceCurrentness?.cells?.length === 50
    && pdp1Exit?.developmentStatus?.outstandingMeaningIds?.length === 0;
  const valid = impact?.schemaVersion === 'media.discovery-pdp2-current-cut-source-impact.v1'
    && impact.recordId === 'MEDIA-DISCOVERY-PDP2-CURRENT-CUT-SOURCE-IMPACT-2026-10-14-R2'
    && impact.campaign?.repository === 'samujjwal/ghatana-media'
    && impact.campaign?.stage === 'DISCOVERY'
    && impact.campaign?.activePhase === 'PDP-2'
    && impact.campaign?.materialSourceSetFingerprint === p2Exit?.materialSourceSetFingerprint
    && impact.campaign?.materialPathCount === 405
    && impact.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION'
    && impact.authority?.decisionRole === 'SCOPED_INTERNAL_MEDIA_PDP2_SOURCE_IMPACT_REVIEW'
    && impact.authority?.userAuthorization === 'Authorize scoped PDP-2 disposition (Recommended); Authorize five exact transitions (Recommended)'
    && authorizationEvidenceValid
    && impact.authority?.humanIndependentSignatureProvided === false
    && impact.authority?.qualifiedExternalSpecialistSignoffProvided === false
    && impact.authority?.externalContractOwnerAcceptanceProvided === false
    && impact.authority?.nativeLifecycleReceiptProvided === false
    && impact.predecessorCut?.phase === 'PDP-2'
    && impact.predecessorCut?.receiptRef === predecessorPath
    && impact.predecessorCut?.receiptSha256 === predecessorDigest
    && impact.predecessorCut?.materialSourceSetFingerprint === p2Exit?.materialSourceSetFingerprint
    && impact.predecessorCut?.materialPathCount === 405
    && impact.predecessorCut?.receiptStatus === 'HISTORICAL_BASELINE_FOR_SCOPED_IMPACT_DISPOSITION'
    && impact.pdp1Predecessor?.status === 'PASS'
    && impact.pdp1Predecessor?.sourceCurrentness === 'PASS'
    && impact.pdp1Predecessor?.developmentStatus === 'DEV_COMPLETE'
    && impact.pdp1Predecessor?.materialPathCount === 329
    && impact.pdp1Predecessor?.cellCount === 50
    && impact.pdp1Predecessor?.outstandingMeaningIds === 0
    && pdp1PredecessorValid
    && predecessor?.phase === 'PDP-2'
    && p2Exit?.status === 'PASS'
    && p2Exit?.sourceCurrent === true
    && p2Exit?.materialSourceSetFingerprint === impact.predecessorCut.materialSourceSetFingerprint
    && predecessorPaths.length === 405
    && currentPaths.length === 405
    && missingPaths.length === 0
    && additionalPaths.length === 0
    && pathChanges.length === authorizedPaths.length
    && pathChanges.map((sourcePath) => sourcePath).sort().every((sourcePath, index) => sourcePath === [...authorizedPaths].sort()[index])
    && expectedTransitions.every(({ path }) => pathChanges.includes(path))
    && transitionsValid
    && reviewedPdp2SourcesValid
    && impact.scopeLimits?.onlyTheseSixExactR4ToCurrentPathTransitionsAreAuthorized === true
    && impact.scopeLimits?.noOtherPathAuthorizedByThisRecord === true
    && impact.scopeLimits?.pdp2Currentness === 'NOT_ESTABLISHED_REQUIRES_FRESH_RECAPTURE_AFTER_PDP1_R15'
    && impact.scopeLimits?.preserveEarlierReceipts === true
    && impact.scopeLimits?.externalAcceptance === 'NOT_CLAIMED'
    && impact.scopeLimits?.independentSignoff === 'NOT_CLAIMED'
    && impact.scopeLimits?.lifecycleClosure === 'NOT_ENTERED'
    && impact.scopeLimits?.runtimeAdmission === 'NOT_ADMITTED'
    && impact.scopeLimits?.delivery === 'NOT_AUTHORIZED'
    && impact.decision?.status === 'APPROVED_INTERNAL_IMPACT_DISPOSITION_FOR_EXACT_SOURCE_DELTAS'
    && impact.decision?.pdp2MeaningDisposition === 'NO_ADDITIONAL_PDP2_MEANING_IN_THE_SIX_EXACT_R4_TO_CURRENT_PATH_CHANGES'
    && impact.decision?.requiresFreshCurrentness === true
    && impact.decision?.orderedRecapturePrerequisite === 'PDP-1 R15 currentness must be established before PDP-2 recapture'
    && impact.decision?.preserveHistoricalReceipts === true
    && typeof impact.limitation === 'string'
    && impact.limitation.includes('does not establish PDP-2 currentness')
    && /^sha256:[a-f0-9]{64}$/u.test(impactDigest ?? '');
  return {
    valid,
    ref: impactPath,
    digest: impactDigest ?? null,
    predecessorRef: predecessorPath,
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
    authorizationEvidenceValid,
    reviewedPdp2SourcesValid,
    reviewedPdp2SourceCount: Array.isArray(reviewedPdp2Sources) ? reviewedPdp2Sources.length : 0,
    pdp1PredecessorValid,
    transitionsValid,
    meaningChangeCount: Array.isArray(deltas) ? deltas.filter((delta) => delta.meaningChange !== 'NO_ADDITIONAL_PDP2_MEANING' && delta.meaningChange !== 'NO_PDP2_PRODUCT_DEFINITION_MEANING_CHANGE').length : null,
    independentOrExternalOrLifecycleClaims: false,
  };
}

export function validatePdp2AdditionalSourceImpact({ record, recordPath, predecessor, predecessorPath = PDP2_CURRENT_CUT_PREDECESSOR_PATH, predecessorDigest = digestFile(predecessorPath), currentDigests, actualCurrentDigests }) {
  if (record?.schemaVersion === 'media.discovery-pdp2-additional-source-impact.v3') {
    const predecessorDigests = predecessor?.sourceCurrentness?.sourceSetDigests?.sourceContentDigests ?? {};
    const expected = [
      {
        path: '.product-experience/decision-log.md',
        predecessorSha256: 'sha256:9831b03ecd3f30d2cbfd7a1db62d934035ba20cf1482bb5e621d166eacdb9b4c',
        observedSha256: 'sha256:97ad3104abec9ba6670804394c68a11c663f37171e90ea2a1f2e629aa5619bbc',
        classification: 'PDP1_PXD164_SEMANTIC_REPAIR_NO_ADDITIONAL_PDP2_MEANING',
        sourceSelector: '.product-experience/decision-log.md#PXD-164',
      },
      {
        path: '.product-experience/interface-parity/current-source-review.json',
        predecessorSha256: 'sha256:866729bdb41448d7e1d08ca288e5e71300f999d26e85cd53d2e5377ecdf299bd',
        observedSha256: 'sha256:64796cfb0db909a36e030041b2d51d02fd19fc115d703cc16bca37116f92ed06',
        classification: 'PDP1_INTERFACE_SOURCE_REVIEW_REFRESH',
        sourceSelector: '.product-experience/interface-parity/current-source-review.json',
      },
      {
        path: PDP1_SEMANTIC_REVIEW_PATH,
        predecessorSha256: 'sha256:e9350fb4424fceeca2f13b93f756231e5b648904bb002de11d3d9659a0b994b6',
        observedSha256: 'sha256:15ec0101ba8d7c178bed46b116284b0de1150ac38caacedd65904225ab4b51c9',
        classification: 'PDP1_SEMANTIC_REVIEW_EVIDENCE_REFRESH',
        sourceSelector: PDP1_SEMANTIC_REVIEW_PATH,
      },
    ].map((delta) => ({ ...delta, phase: 'PDP-2', meaningChange: 'NO_ADDITIONAL_PDP2_MEANING', meaningIdsChanged: [], requiresFreshCurrentness: true }));
    const deltas = record.sourceDeltas ?? [];
    const paths = expected.map(({ path: sourcePath }) => sourcePath);
    const tuples = (items) => items.map(({ path: sourcePath, predecessorSha256, observedSha256, classification, sourceSelector, phase, meaningChange, meaningIdsChanged, requiresFreshCurrentness }) => ({
      path: sourcePath, predecessorSha256, observedSha256, classification, sourceSelector, phase, meaningChange, meaningIdsChanged, requiresFreshCurrentness,
    }));
    const transitionValid = deltas.length === expected.length
      && JSON.stringify(tuples(deltas)) === JSON.stringify(tuples(expected))
      && deltas.every((delta) => predecessorDigests[delta.path] === delta.predecessorSha256
        && currentDigests?.[delta.path] === delta.observedSha256
        && actualCurrentDigests?.[delta.path] === delta.observedSha256);
    const authorization = record.authority?.userAuthorization;
    const authorizedTransitions = authorization?.authorizedTransitions ?? [];
    const authorizedExactResponses = [
      'Authorize these three exact transitions (Recommended)',
      'Authorize this scoped PDP-2 impact disposition (Recommended)',
    ];
    const authorizationValid = authorization?.status === 'AUTHORIZED'
      && authorization?.authorizedBy === 'USER'
      && authorization?.exactResponse === authorizedExactResponses[0]
      && authorization?.additionalScopedAuthorizationResponse === authorizedExactResponses[1]
      && JSON.stringify(authorization?.exactResponses) === JSON.stringify(authorizedExactResponses)
      && authorizedTransitions.length === expected.length
      && JSON.stringify(authorizedTransitions) === JSON.stringify(expected.map(({ path: sourcePath, predecessorSha256, observedSha256 }) => ({ path: sourcePath, predecessorSha256, observedSha256 })));
    const safeRecordPath = typeof recordPath === 'string' && recordPath.length > 0 && !path.isAbsolute(recordPath)
      && !path.relative(root, path.resolve(root, recordPath)).startsWith('..') && path.normalize(recordPath) === recordPath;
    const r25Path = record.pdp1Predecessor?.receiptRef;
    const r25 = r25Path === PDP1_CURRENT_CUT_EXIT_R25_PATH ? readJson(r25Path) : null;
    const noDownstreamClaims = record.ownerAcceptance === 'NOT_CLAIMED'
      && record.independentReview === 'NOT_CLAIMED'
      && record.lifecycleClosure === 'NOT_ENTERED'
      && record.runtimeAdmission === 'NOT_ADMITTED'
      && record.delivery === 'NOT_AUTHORIZED'
      && record.release === 'NOT_AUTHORIZED'
      && record.authority?.humanSignatureProvided === false
      && record.authority?.independentReviewerProvided === false
      && record.authority?.lifecycleReceiptProvided === false;
    const valid = safeRecordPath
      && /^MEDIA-DISCOVERY-PDP2-ADDITIONAL-SOURCE-IMPACT-2026-10-14-R[1-9][0-9]*$/u.test(record.recordId ?? '')
      && record.campaign?.repository === 'samujjwal/ghatana-media'
      && record.campaign?.stage === 'DISCOVERY' && record.campaign?.activePhase === 'PDP-2'
      && record.predecessorCut?.phase === 'PDP-2'
      && record.predecessorCut?.receiptRef === PDP2_CURRENT_CUT_PREDECESSOR_R13_PATH
      && record.predecessorCut?.receiptSha256 === digestFile(PDP2_CURRENT_CUT_PREDECESSOR_R13_PATH)
      && predecessorPath === PDP2_CURRENT_CUT_PREDECESSOR_R13_PATH
      && predecessorDigest === digestFile(PDP2_CURRENT_CUT_PREDECESSOR_R13_PATH)
      && predecessor?.observationId === 'MEDIA-PDP2-CURRENTNESS-2026-10-14-CURRENT-CUT-R13'
      && Object.keys(predecessorDigests).length === 405
      && record.pdp1Predecessor?.phase === 'PDP-1'
      && record.pdp1Predecessor?.receiptRef === PDP1_CURRENT_CUT_EXIT_R25_PATH
      && record.pdp1Predecessor?.receiptSha256 === digestFile(PDP1_CURRENT_CUT_EXIT_R25_PATH)
      && record.pdp1Predecessor?.sourceFingerprint === r25?.sourceCurrentness?.materialSourceSetFingerprint
      && record.pdp1Predecessor?.sourceFingerprint === 'sha256:249b4d300e4103406335b4c395da888e487fa898d08bae91f09d7fa07a1e9d0e'
      && record.pdp1Predecessor?.status === 'PASS'
      && record.pdp1Predecessor?.sourceCurrentness === 'PASS'
      && record.pdp1Predecessor?.sourceCurrent === true
      && record.pdp1Predecessor?.cellCount === 50
      && record.pdp1Predecessor?.developmentStatus === 'DEV_COMPLETE'
      && record.pdp1Predecessor?.outstandingMeaningIds === 0
      && r25?.phaseExit?.status === 'PASS' && r25?.phaseExit?.sourceCurrentness === 'PASS'
      && r25?.developmentStatus?.status === 'DEV_COMPLETE' && r25?.developmentStatus?.outstandingMeaningIds?.length === 0
      && r25?.sourceCurrentness?.status === 'PASS' && r25?.sourceCurrentness?.sourceCurrent === true
      && r25?.sourceCurrentness?.cells?.length === 50
      && transitionValid && authorizationValid && noDownstreamClaims;
    if (!valid) return { valid: false, ref: recordPath ?? null, paths: deltas.map((delta) => delta?.path ?? null), meaningIdsChanged: [], checks: {
      safeRecordPath, predecessorPath: predecessorPath === PDP2_CURRENT_CUT_PREDECESSOR_R13_PATH,
      predecessorReceipt: record.predecessorCut?.receiptSha256 === digestFile(PDP2_CURRENT_CUT_PREDECESSOR_R13_PATH),
      predecessorId: predecessor?.observationId === 'MEDIA-PDP2-CURRENTNESS-2026-10-14-CURRENT-CUT-R13',
      predecessorCount: Object.keys(predecessorDigests).length,
      pdp1Receipt: record.pdp1Predecessor?.receiptSha256 === digestFile(PDP1_CURRENT_CUT_EXIT_R25_PATH),
      pdp1Fingerprint: record.pdp1Predecessor?.sourceFingerprint === 'sha256:249b4d300e4103406335b4c395da888e487fa898d08bae91f09d7fa07a1e9d0e',
      transitionValid, authorizationValid, noDownstreamClaims,
    } };
    return {
      valid: true, ref: recordPath, sha256: digestFile(recordPath), paths,
      transitions: deltas.map(({ path: sourcePath, predecessorSha256, observedSha256, classification, sourceSelector, meaningIdsChanged }) => ({ path: sourcePath, predecessorSha256, observedSha256, classification, sourceSelector, meaningIdsChanged })),
      ownerAcceptance: record.ownerAcceptance, independentReview: record.independentReview,
    };
  }
  if (record?.schemaVersion === 'media.discovery-pdp2-additional-source-impact.v2') {
    const predecessorDigests = predecessor?.sourceCurrentness?.sourceSetDigests?.sourceContentDigests ?? {};
    const deltas = record.sourceDeltas;
    const pxdPath = '.product-experience/decision-log.md';
    const pxdSelector = `${pxdPath}#PXD-163`;
    const pxdDigest = actualCurrentDigests?.[pxdPath];
    const delegatedSourcePaths = new Set([
      '.product-experience/pdp-3-product-experience/action-registry.yaml',
      'libs/audio-video-client/src/operations.ts',
    ]);
    const p1Receipt = readJson(PDP1_CURRENT_CUT_EXIT_R16_PATH);
    const p1ReceiptDigest = digestFile(PDP1_CURRENT_CUT_EXIT_R16_PATH);
    const safePath = (value) => typeof value === 'string' && value.length > 0 && !path.isAbsolute(value)
      && !path.relative(root, path.resolve(root, value)).startsWith('..') && path.normalize(value) === value;
    const uniqueDeltas = Array.isArray(deltas) && deltas.length > 0
      && deltas.every((delta) => delta && safePath(delta.path))
      && new Set(deltas.map((delta) => delta.path)).size === deltas.length;
    const validDeltas = uniqueDeltas && deltas.every((delta) => {
      const selectorPath = typeof delta.sourceSelector === 'string' ? delta.sourceSelector.split('#', 1)[0] : '';
      return delegatedSourcePaths.has(delta.path)
        && Object.hasOwn(predecessorDigests, delta.path)
        && delta.predecessorSha256 === predecessorDigests[delta.path]
        && /^sha256:[a-f0-9]{64}$/u.test(delta.predecessorSha256 ?? '')
        && /^sha256:[a-f0-9]{64}$/u.test(delta.observedSha256 ?? '')
        && currentDigests?.[delta.path] === delta.observedSha256
        && actualCurrentDigests?.[delta.path] === delta.observedSha256
        && delta.classification === 'PDP2_DELEGATED_SOURCE_IMPACT_NO_ADDITIONAL_MEANING'
        && safePath(selectorPath) && selectorPath === delta.path
        && typeof delta.sourceSelector === 'string' && delta.sourceSelector.length <= 512
        && typeof delta.summary === 'string' && delta.summary.trim().length > 0 && delta.summary.length <= 240
        && delta.meaningChange === 'NO_ADDITIONAL_PDP2_MEANING'
        && Array.isArray(delta.meaningIdsChanged) && delta.meaningIdsChanged.length === 0
        && delta.requiresFreshCurrentness === true;
    });
    const noDownstreamClaims = record.ownerAcceptance === 'NOT_CLAIMED'
      && record.independentReview === 'NOT_CLAIMED'
      && record.lifecycleClosure === 'NOT_ENTERED'
      && record.runtimeAdmission === 'NOT_ADMITTED'
      && record.delivery === 'NOT_AUTHORIZED'
      && record.release === 'NOT_AUTHORIZED'
      && record.authority?.humanSignatureProvided === false
      && record.authority?.independentReviewerProvided === false
      && record.authority?.lifecycleReceiptProvided === false;
    const valid = typeof recordPath === 'string' && safePath(recordPath)
      && /^MEDIA-DISCOVERY-PDP2-ADDITIONAL-SOURCE-IMPACT-2026-10-14-R[1-9][0-9]*$/u.test(record.recordId ?? '')
      && record.campaign?.repository === 'samujjwal/ghatana-media'
      && record.campaign?.stage === 'DISCOVERY' && record.campaign?.activePhase === 'PDP-2'
      && record.predecessorCut?.phase === 'PDP-2'
      && record.predecessorCut?.receiptRef === predecessorPath
      && record.predecessorCut?.receiptSha256 === predecessorDigest
      && record.predecessorCut?.receiptRef === PDP2_CURRENT_CUT_PREDECESSOR_PATH
      && record.pdp1Predecessor?.phase === 'PDP-1'
      && record.pdp1Predecessor?.receiptRef === PDP1_CURRENT_CUT_EXIT_R16_PATH
      && record.pdp1Predecessor?.receiptSha256 === p1ReceiptDigest
      && record.pdp1Predecessor?.status === 'PASS'
      && record.pdp1Predecessor?.sourceCurrentness === 'PASS'
      && record.pdp1Predecessor?.sourceCurrent === true
      && record.pdp1Predecessor?.cellCount === 50
      && record.pdp1Predecessor?.developmentStatus === 'DEV_COMPLETE'
      && record.pdp1Predecessor?.outstandingMeaningIds === 0
      && p1Receipt.phaseExit?.status === 'PASS'
      && p1Receipt.phaseExit?.sourceCurrentness === 'PASS'
      && p1Receipt.phaseExit?.developmentStatus === 'DEV_COMPLETE'
      && p1Receipt.sourceCurrentness?.status === 'PASS'
      && p1Receipt.sourceCurrentness?.sourceCurrent === true
      && p1Receipt.sourceCurrentness?.cells?.length === 50
      && p1Receipt.developmentStatus?.status === 'DEV_COMPLETE'
      && p1Receipt.developmentStatus?.outstandingMeaningIds?.length === 0
      && record.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION'
      && record.authority?.decisionRole === 'SCOPED_INTERNAL_MEDIA_PDP2_SOURCE_IMPACT_REVIEW'
      && record.authority?.delegationEvidence?.sourceRef === pxdSelector
      && record.authority?.delegationEvidence?.sha256 === pxdDigest
      && /^sha256:[a-f0-9]{64}$/u.test(pxdDigest ?? '')
      && currentDigests?.[pxdPath] === pxdDigest
      && record.reviewedPdp2Grammar?.path === '.product-experience/pdp-2-design-interface-system/semantic-state-grammar.yaml'
      && record.reviewedPdp2Grammar?.sha256 === predecessorDigests[record.reviewedPdp2Grammar.path]
      && record.reviewedPdp2Grammar?.sha256 === currentDigests?.[record.reviewedPdp2Grammar.path]
      && record.reviewedPdp2Grammar?.sha256 === actualCurrentDigests?.[record.reviewedPdp2Grammar.path]
      && validDeltas && noDownstreamClaims;
    if (!valid) return { valid: false, ref: recordPath ?? null, paths: Array.isArray(deltas) ? deltas.map((delta) => delta?.path ?? null) : [], meaningIdsChanged: [] };
    return {
      valid: true, ref: recordPath, sha256: digestFile(recordPath),
      paths: deltas.map((delta) => delta.path), transitions: deltas.map((delta) => ({
        path: delta.path, predecessorSha256: delta.predecessorSha256, observedSha256: delta.observedSha256,
        classification: delta.classification, sourceSelector: delta.sourceSelector,
        meaningIdsChanged: delta.meaningIdsChanged,
      })),
      ownerAcceptance: record.ownerAcceptance, independentReview: record.independentReview,
    };
  }
  const sourcePath = '.product-experience/pdp-2-design-interface-system/semantic-state-grammar.yaml';
  const sourceSelector = `${sourcePath}#states/@stateRef=media-job.COMPLETED`;
  const predecessorDigests = predecessor?.sourceCurrentness?.sourceSetDigests?.sourceContentDigests ?? {};
  const validPath = typeof recordPath === 'string' && !path.isAbsolute(recordPath)
    && !path.relative(root, path.resolve(root, recordPath)).startsWith('..');
  const meaningIdsChanged = record?.meaningIdsChanged;
  const valid = validPath
    && record?.schemaVersion === 'media.discovery-pdp2-additional-source-impact.v1'
    && /^MEDIA-DISCOVERY-PDP2-ADDITIONAL-SOURCE-IMPACT-2026-10-14-R[1-9][0-9]*$/u.test(record.recordId ?? '')
    && record.phase === 'PDP-2'
    && record.sourcePath === sourcePath
    && record.sourceSelector === sourceSelector
    && record.predecessorRef === predecessorPath
    && record.predecessorReceiptSha256 === predecessorDigest
    && record.classification === 'INTERNAL_SCOPED_SOURCE_SEMANTIC_REVIEW'
    && record.semanticDisposition === 'COMPLETED_JOB_DOES_NOT_ESTABLISH_TRANSCRIPT_READY'
    && record.sourceReview === 'REVIEWED_EXACT_COMPLETED_JOB_PRESENTATION_RULE'
    && Array.isArray(meaningIdsChanged) && meaningIdsChanged.length === 1
    && meaningIdsChanged[0] === 'media.ui.completed-does-not-imply-transcript-ready'
    && /^sha256:[a-f0-9]{64}$/u.test(record.predecessorSha256 ?? '')
    && /^sha256:[a-f0-9]{64}$/u.test(record.observedSha256 ?? '')
    && predecessorDigests[sourcePath] === record.predecessorSha256
    && currentDigests?.[sourcePath] === record.observedSha256
    && actualCurrentDigests?.[sourcePath] === record.observedSha256
    && record.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION'
    && record.authority?.decisionRole === 'SCOPED_INTERNAL_MEDIA_PDP2_SOURCE_SEMANTIC_REVIEW'
    && record.ownerAcceptance === 'NOT_CLAIMED'
    && record.independentReview === 'NOT_CLAIMED'
    && record.externalContractOwnerAcceptance === 'NOT_CLAIMED'
    && record.lifecycleClosure === 'NOT_ENTERED'
    && record.runtimeAdmission === 'NOT_ADMITTED'
    && record.delivery === 'NOT_AUTHORIZED';
  if (!valid) return { valid: false, ref: recordPath ?? null, path: sourcePath, meaningIdsChanged: meaningIdsChanged ?? [] };
  return {
    valid: true,
    ref: recordPath,
    sha256: digestFile(recordPath),
    path: sourcePath,
    paths: [sourcePath],
    transitions: [{ path: sourcePath, predecessorSha256: record.predecessorSha256, observedSha256: record.observedSha256, classification: record.classification, sourceSelector, meaningIdsChanged }],
    predecessorSha256: record.predecessorSha256,
    observedSha256: record.observedSha256,
    classification: record.classification,
    sourceSelector,
    meaningIdsChanged,
    ownerAcceptance: record.ownerAcceptance,
    independentReview: record.independentReview,
  };
}

export function validatePdp2R16ProjectionImpact({ record, recordPath, r16Checkpoint = readJson(PDP2_R16_RECEIPT_PATH), currentDigests, actualCurrentDigests }) {
  const safeRecordPath = typeof recordPath === 'string' && recordPath === PDP2_R16_PROJECTION_IMPACT_RECORD_PATH;
  const r16Digests = r16Checkpoint?.sourceCurrentness?.sourceSetDigests?.sourceContentDigests ?? {};
  const projectionDelta = record?.sourceDeltas?.[0];
  const reviewedInput = record?.reviewedInputs?.[0];
  const projectionLive = actualCurrentDigests?.[PDP2_R16_PROJECTION_PATH] ?? digestFile(PDP2_R16_PROJECTION_PATH);
  const designLanguagePath = '.product-experience/pdp-2-design-interface-system/DESIGN-LANGUAGE.md';
  const designLanguageLive = actualCurrentDigests?.[designLanguagePath] ?? digestFile(designLanguagePath);
  const valid = safeRecordPath
    && digestFile(PDP2_R16_PROJECTION_IMPACT_RECORD_PATH) === PDP2_R16_PROJECTION_IMPACT_DIGEST
    && record?.schemaVersion === 'media.discovery-pdp2-projection-impact.v1'
    && record?.recordId === 'MEDIA-DISCOVERY-PDP2-R16-PROJECTION-IMPACT-2026-10-14-R1'
    && record?.campaign?.repository === 'samujjwal/ghatana-media'
    && record?.campaign?.stage === 'DISCOVERY' && record?.campaign?.phase === 'PDP-2'
    && record?.authority?.authorizationScope === 'Only the exact candidate projection transition, its unchanged DESIGN-LANGUAGE.md input, and this focused regression test.'
    && record?.authority?.ownerAcceptance === 'NOT_CLAIMED'
    && record?.authority?.independentReview === 'NOT_CLAIMED'
    && record?.authority?.humanIndependentSignatureProvided === false
    && record?.authority?.externalContractOwnerAcceptanceProvided === false
    && record?.authority?.nativeLifecycleReceiptProvided === false
    && record?.predecessor?.phase === 'PDP-2'
    && record?.predecessor?.observationRef === PDP2_R16_RECEIPT_PATH
    && record?.predecessor?.observationId === 'MEDIA-PDP2-CURRENTNESS-R16'
    && record?.predecessor?.receiptSha256 === PDP2_R16_RECEIPT_DIGEST
    && digestFile(PDP2_R16_RECEIPT_PATH) === PDP2_R16_RECEIPT_DIGEST
    && r16Checkpoint?.schemaVersion === 'media.discovery-pdp2-currentness-observation.v1'
    && r16Checkpoint?.observationId === 'MEDIA-PDP2-CURRENTNESS-R16'
    && r16Checkpoint?.phase === 'PDP-2'
    && r16Checkpoint?.currentPhaseExit?.status === 'PASS'
    && r16Checkpoint?.currentPhaseExit?.sourceCurrentness === 'PASS'
    && r16Checkpoint?.currentPhaseExit?.developmentStatus === 'DEV_COMPLETE'
    && r16Checkpoint?.sourceCurrentness?.status === 'PASS'
    && r16Checkpoint?.sourceCurrentness?.sourceCurrent === true
    && Object.keys(r16Digests).length === 405
    && r16Checkpoint?.sourceCurrentness?.denominators?.totalCells === 50
    && r16Digests[PDP2_R16_PROJECTION_PATH] === PDP2_R16_PROJECTION_PREDECESSOR_DIGEST
    && Array.isArray(record?.sourceDeltas) && record.sourceDeltas.length === 1
    && projectionDelta?.path === PDP2_R16_PROJECTION_PATH
    && projectionDelta?.phase === 'PDP-2 generated projection'
    && projectionDelta?.selector === 'Generated experience-language candidate projection'
    && projectionDelta?.predecessorSha256 === PDP2_R16_PROJECTION_PREDECESSOR_DIGEST
    && projectionDelta?.observedSha256 === PDP2_R16_PROJECTION_OBSERVED_DIGEST
    && projectionDelta?.classification === 'PDP2_GENERATED_PROJECTION_REFRESH_NO_MEANING_CHANGE'
    && projectionDelta?.meaningChange === 'NO_PDP2_MEANING_CHANGE'
    && Array.isArray(projectionDelta?.meaningIdsChanged) && projectionDelta.meaningIdsChanged.length === 0
    && projectionDelta?.requiresFreshCurrentness === true
    && currentDigests?.[PDP2_R16_PROJECTION_PATH] === PDP2_R16_PROJECTION_OBSERVED_DIGEST
    && projectionLive === PDP2_R16_PROJECTION_OBSERVED_DIGEST
    && Array.isArray(record?.reviewedInputs) && record.reviewedInputs.length === 1
    && reviewedInput?.path === designLanguagePath
    && reviewedInput?.sha256 === PDP2_R16_DESIGN_LANGUAGE_DIGEST
    && reviewedInput?.status === 'UNCHANGED'
    && reviewedInput?.selector === 'PDP-2 design-language input to the generated experience-language candidate'
    && designLanguageLive === PDP2_R16_DESIGN_LANGUAGE_DIGEST
    && record?.decision?.status === 'SCOPED_INTERNAL_SUCCESSOR_IMPACT_DISPOSITION'
    && record?.decision?.pdp2MeaningDisposition === 'NO_PDP2_MEANING_CHANGE'
    && record?.decision?.requiresFreshCurrentness === true
    && record?.decision?.preserveHistoricalReceipts === true
    && record?.decision?.ownerAcceptance === 'NOT_CLAIMED'
    && record?.decision?.independentAcceptance === 'NOT_CLAIMED'
    && record?.decision?.nativeLifecycleClosure === 'NOT_ENTERED'
    && record?.decision?.runtimeAdmission === 'NOT_ADMITTED'
    && record?.decision?.delivery === 'BLOCKED'
    && record?.decision?.release === 'NOT_AUTHORIZED';
  return {
    valid,
    ref: recordPath ?? null,
    digest: safeRecordPath ? digestFile(PDP2_R16_PROJECTION_IMPACT_RECORD_PATH) : null,
    predecessorRef: PDP2_R16_RECEIPT_PATH,
    predecessorDigest: record?.predecessor?.receiptSha256 ?? null,
    paths: valid ? [PDP2_R16_PROJECTION_PATH] : [],
    transitions: valid ? [{
      path: PDP2_R16_PROJECTION_PATH,
      predecessorSha256: PDP2_R16_PROJECTION_PREDECESSOR_DIGEST,
      observedSha256: PDP2_R16_PROJECTION_OBSERVED_DIGEST,
      classification: projectionDelta.classification,
      meaningChange: projectionDelta.meaningChange,
      meaningIdsChanged: [],
    }] : [],
    ownerAcceptance: record?.authority?.ownerAcceptance ?? null,
    independentReview: record?.authority?.independentReview ?? null,
  };
}

export function validatePdp1EvidenceRefresh({ predecessor, currentDigests, actualCurrentDigests, pdp1Exit, pdp1ExitDigest, pdp1ExitPath = PDP1_CURRENT_CUT_EXIT_PATH, statusSource, semanticReviewSource, operationsSourceText, operationsReviewText, operationsReviewSource }) {
  if (pdp1Exit?.observationId === 'MEDIA-PDP1-CURRENTNESS-2026-10-15-CURRENT-CUT-R30') {
    const sourceImpact = validatePdp2R17SuccessorImpact({ predecessor, currentDigests, actualCurrentDigests,
      r30Exit: pdp1Exit, matrix: readJson(MATRIX_PATH), impactRecord: readJson(PDP2_R17_TO_R30_IMPACT_PATH) });
    const predecessorDigests = predecessor?.sourceCurrentness?.sourceSetDigests?.sourceContentDigests ?? {};
    const valid = predecessor?.observationId === 'MEDIA-PDP2-CURRENTNESS-2026-10-14-CURRENT-CUT-R17'
      && predecessor?.sourceCurrentness?.materialSourceSetFingerprint === PDP2_R17_FINGERPRINT
      && Object.keys(predecessorDigests).length === 405
      && sourceImpact.valid;
    return {
      valid,
      classification: 'PDP1_R30_CURRENT_SOURCE_SUCCESSOR_WITH_EXACT_PDP2_SOURCE_IMPACT_BRIDGE',
      predecessorRef: PDP2_R17_PATH,
      successorRef: pdp1ExitPath,
      successorDigest: pdp1ExitDigest ?? null,
      paths: [],
      currentPathCount: Object.keys(currentDigests ?? {}).length,
      predecessorPathCount: Object.keys(predecessorDigests).length,
      pdp1Proof: {
        phaseStatus: pdp1Exit?.phaseExit?.status ?? null,
        developmentStatus: pdp1Exit?.developmentStatus?.status ?? null,
        outstandingMeaningIdCount: pdp1Exit?.developmentStatus?.outstandingMeaningIds?.length ?? null,
        cellCount: pdp1Exit?.sourceCurrentness?.cells?.length ?? null,
        materialPathCount: pdp1Exit?.sourceCurrentness?.materialPathDenominator?.uniquePaths ?? null,
        exactCutOwnerAcceptance: pdp1Exit?.phaseExit?.exactCutOwnerAcceptance ?? null,
      },
      r17ToR30SourceImpact: sourceImpact,
    };
  }
  if (pdp1Exit?.observationId === 'MEDIA-PDP1-CURRENTNESS-2026-10-14-CURRENT-CUT-R27') {
    const bridge = validatePdp1R27SourceMapBridge({
      r27Exit: pdp1Exit,
      matrix: readJson(MATRIX_PATH),
      pdp1ExitPath,
      pdp1ExitDigest,
      actualCurrentDigests,
      currentDigests,
    });
    const predecessorDigests = predecessor?.sourceCurrentness?.sourceSetDigests?.sourceContentDigests ?? {};
    const paths = Object.keys(pdp1Exit?.sourceCurrentness?.sourceContentDigests ?? {}).sort();
    const valid = predecessor?.observationId === 'MEDIA-PDP2-CURRENTNESS-2026-10-14-CURRENT-CUT-R13'
      && predecessor?.sourceCurrentness?.materialSourceSetFingerprint === 'sha256:abc297017aa3d332e0bca990cc9f5756dc2a68e66b2e6510f9087f6461063938'
      && bridge.valid
      && Object.keys(predecessorDigests).length === 405;
    return {
      valid,
      classification: 'PDP1_R27_SOURCE_CURRENTNESS_REJOIN_WITH_ZERO_DELTA_FROM_R25',
      predecessorRef: PDP2_CURRENT_CUT_PREDECESSOR_R13_PATH,
      successorRef: pdp1ExitPath,
      successorDigest: pdp1ExitDigest ?? null,
      paths: [],
      pathAudit: paths.map((sourcePath) => {
        const liveDigest = actualCurrentDigests?.[sourcePath] ?? digestFile(sourcePath);
        return {
          path: sourcePath,
          predecessorSha256: predecessorDigests[sourcePath] ?? null,
          currentSha256: pdp1Exit.sourceCurrentness.sourceContentDigests[sourcePath],
          liveSha256: liveDigest,
          matches: pdp1Exit.sourceCurrentness.sourceContentDigests[sourcePath] === liveDigest
            && (currentDigests?.[sourcePath] === undefined || currentDigests[sourcePath] === liveDigest),
        };
      }),
      currentPathCount: Object.keys(currentDigests ?? {}).length,
      predecessorPathCount: Object.keys(predecessorDigests).length,
      pdp1Proof: {
        phaseStatus: pdp1Exit?.phaseExit?.status ?? null,
        developmentStatus: pdp1Exit?.developmentStatus?.status ?? null,
        outstandingMeaningIdCount: pdp1Exit?.developmentStatus?.outstandingMeaningIds?.length ?? null,
        cellCount: pdp1Exit?.sourceCurrentness?.cells?.length ?? null,
        materialPathCount: pdp1Exit?.sourceCurrentness?.materialPathDenominator?.uniquePaths ?? null,
      },
      r25ToR27Bridge: bridge,
    };
  }
  if (pdp1Exit?.observationId === 'MEDIA-PDP1-CURRENTNESS-2026-10-14-CURRENT-CUT-R25') {
    const predecessorDigests = predecessor?.sourceCurrentness?.sourceSetDigests?.sourceContentDigests ?? {};
    const successorDigests = pdp1Exit?.sourceCurrentness?.sourceContentDigests ?? {};
    const paths = Object.keys(successorDigests).sort();
    const allSuccessorPinsMatch = paths.length === 329 && paths.every((sourcePath) => (actualCurrentDigests?.[sourcePath] ?? digestFile(sourcePath)) === successorDigests[sourcePath]
      && (currentDigests?.[sourcePath] === undefined || currentDigests[sourcePath] === successorDigests[sourcePath]));
    const cells = pdp1Exit?.sourceCurrentness?.cells ?? [];
    const valid = predecessor?.observationId === 'MEDIA-PDP2-CURRENTNESS-2026-10-14-CURRENT-CUT-R13'
      && predecessor?.sourceCurrentness?.materialSourceSetFingerprint === 'sha256:abc297017aa3d332e0bca990cc9f5756dc2a68e66b2e6510f9087f6461063938'
      && pdp1ExitPath === PDP1_CURRENT_CUT_EXIT_R25_PATH
      && pdp1ExitDigest === 'sha256:914390414ee87982efa786e1edf2a8adb0bc3e5d8b5c609776a7f0c65f679e1e'
      && pdp1ExitDigest === digestFile(PDP1_CURRENT_CUT_EXIT_R25_PATH)
      && pdp1Exit?.phaseExit?.status === 'PASS' && pdp1Exit?.phaseExit?.sourceCurrentness === 'PASS'
      && pdp1Exit?.developmentStatus?.status === 'DEV_COMPLETE'
      && pdp1Exit?.developmentStatus?.outstandingMeaningIds?.length === 0
      && pdp1Exit?.sourceCurrentness?.status === 'PASS' && pdp1Exit?.sourceCurrentness?.sourceCurrent === true
      && pdp1Exit?.sourceCurrentness?.materialSourceSetFingerprint === 'sha256:249b4d300e4103406335b4c395da888e487fa898d08bae91f09d7fa07a1e9d0e'
      && pdp1Exit?.sourceCurrentness?.materialPathDenominator?.uniquePaths === 329
      && cells.length === 50 && cells.every((cell) => cell.sourceCurrentness === 'CURRENT' && (cell.blockers?.length ?? 0) === 0)
      && Object.keys(predecessorDigests).length === 405 && allSuccessorPinsMatch;
    return {
      valid,
      classification: 'PDP1_R25_SOURCE_CURRENTNESS_REJOIN',
      predecessorRef: PDP2_CURRENT_CUT_PREDECESSOR_R13_PATH,
      successorRef: pdp1ExitPath,
      successorDigest: pdp1ExitDigest ?? null,
      paths: [],
      pathAudit: paths.map((sourcePath) => { const liveDigest = actualCurrentDigests?.[sourcePath] ?? digestFile(sourcePath); return { path: sourcePath, predecessorSha256: predecessorDigests[sourcePath] ?? null, currentSha256: successorDigests[sourcePath], liveSha256: liveDigest, matches: (currentDigests?.[sourcePath] === undefined || currentDigests[sourcePath] === liveDigest) && successorDigests[sourcePath] === liveDigest }; }),
      currentPathCount: Object.keys(currentDigests ?? {}).length,
      predecessorPathCount: Object.keys(predecessorDigests).length,
      pdp1Proof: { phaseStatus: pdp1Exit?.phaseExit?.status ?? null, developmentStatus: pdp1Exit?.developmentStatus?.status ?? null, outstandingMeaningIdCount: pdp1Exit?.developmentStatus?.outstandingMeaningIds?.length ?? null, cellCount: cells.length, materialPathCount: pdp1Exit?.sourceCurrentness?.materialPathDenominator?.uniquePaths ?? null },
    };
  }
  if (pdp1Exit?.observationId === 'MEDIA-PDP1-CURRENTNESS-2026-10-14-CURRENT-CUT-R22') {
    const paths = [PDP1_STATUS_PATH, PDP1_SEMANTIC_REVIEW_PATH];
    const expected = {
      [PDP1_STATUS_PATH]: ['sha256:73a491d5ab0ba0c5ad97bde97d2f3592c13bf9282bb8cae197d34b25bff23e18', 'sha256:eb9e7e8ce14c73469daf29406642793c58669351a0035d7bd937e9fe79b8dd2d'],
      [PDP1_SEMANTIC_REVIEW_PATH]: ['sha256:e0a67706f34270e8dd8a873a0193fc3ef50342acf417db2767d4b98f94217020', 'sha256:e9350fb4424fceeca2f13b93f756231e5b648904bb002de11d3d9659a0b994b6'],
    };
    const predecessorDigests = predecessor?.sourceCurrentness?.sourceSetDigests?.sourceContentDigests ?? {};
    const currentHashesMatch = paths.every((sourcePath) => predecessorDigests[sourcePath] === expected[sourcePath][0]
      && currentDigests?.[sourcePath] === expected[sourcePath][1]
      && actualCurrentDigests?.[sourcePath] === expected[sourcePath][1]);
    const cells = pdp1Exit?.sourceCurrentness?.cells ?? [];
    const valid = predecessor?.phase === 'PDP-2'
      && predecessor?.sourceCurrentness?.materialSourceSetFingerprint === 'sha256:318b301bfb6ee4a4d27f141f8137930c2aa1353dc6b6e8d519ac015bc1ec1eda'
      && pdp1ExitPath === PDP1_CURRENT_CUT_EXIT_R22_PATH
      && pdp1ExitDigest === 'sha256:bb448dc45d3db788ef16802f8a92dc8054a6fc6aaa27f047c42b4f6c91feb303'
      && pdp1ExitDigest === digestFile(PDP1_CURRENT_CUT_EXIT_R22_PATH)
      && pdp1Exit?.phaseExit?.status === 'PASS' && pdp1Exit?.phaseExit?.sourceCurrentness === 'PASS'
      && pdp1Exit?.developmentStatus?.status === 'DEV_COMPLETE'
      && pdp1Exit?.developmentStatus?.outstandingMeaningIds?.length === 0
      && pdp1Exit?.sourceCurrentness?.status === 'PASS' && pdp1Exit?.sourceCurrentness?.sourceCurrent === true
      && pdp1Exit?.sourceCurrentness?.materialSourceSetFingerprint === 'sha256:66bbc971734f92ae8f51446582f4a1118704168acac3c0e33783efbb208a5a0b'
      && pdp1Exit?.sourceCurrentness?.materialPathDenominator?.uniquePaths === 329
      && cells.length === 50 && cells.every((cell) => cell.sourceCurrentness === 'CURRENT' && (cell.blockers?.length ?? 0) === 0)
      && currentHashesMatch;
    return {
      valid,
      classification: 'PDP1_STATUS_AND_SEMANTIC_REVIEW_EVIDENCE_REFRESH_NO_PDP2_MEANING_DISPOSITION',
      predecessorRef: PDP2_CURRENT_CUT_PREDECESSOR_PATH,
      successorRef: pdp1ExitPath,
      successorDigest: pdp1ExitDigest ?? null,
      paths: paths.map((sourcePath) => ({ path: sourcePath, predecessorSha256: expected[sourcePath][0], currentSha256: expected[sourcePath][1], liveSha256: actualCurrentDigests?.[sourcePath] ?? null, matches: predecessorDigests[sourcePath] === expected[sourcePath][0] && currentDigests?.[sourcePath] === actualCurrentDigests?.[sourcePath] })),
      currentPathCount: Object.keys(currentDigests ?? {}).length,
      predecessorPathCount: Object.keys(predecessorDigests).length,
      pdp1Proof: { phaseStatus: pdp1Exit?.phaseExit?.status ?? null, developmentStatus: pdp1Exit?.developmentStatus?.status ?? null, outstandingMeaningIdCount: pdp1Exit?.developmentStatus?.outstandingMeaningIds?.length ?? null, cellCount: cells.length, materialPathCount: pdp1Exit?.sourceCurrentness?.materialPathDenominator?.uniquePaths ?? null },
    };
  }
  if (pdp1Exit?.observationId === 'MEDIA-PDP1-CURRENTNESS-2026-10-14-CURRENT-CUT-R19') {
    const paths = [PDP1_STATUS_PATH, PDP1_SEMANTIC_REVIEW_PATH];
    const expected = {
      [PDP1_STATUS_PATH]: ['sha256:73a491d5ab0ba0c5ad97bde97d2f3592c13bf9282bb8cae197d34b25bff23e18', 'sha256:5e78da9588c880c497eb5e3e2a632910501ea722af05c1938c02bc5f64431e65'],
      [PDP1_SEMANTIC_REVIEW_PATH]: ['sha256:e0a67706f34270e8dd8a873a0193fc3ef50342acf417db2767d4b98f94217020', 'sha256:610a7eb85ab8be0c127f4e66361803496a784c01b53e8b0534d402cb75548b76'],
    };
    const predecessorDigests = predecessor?.sourceCurrentness?.sourceSetDigests?.sourceContentDigests ?? {};
    const currentHashesMatch = paths.every((sourcePath) => predecessorDigests[sourcePath] === expected[sourcePath][0]
      && currentDigests?.[sourcePath] === expected[sourcePath][1]
      && actualCurrentDigests?.[sourcePath] === expected[sourcePath][1]);
    const cells = pdp1Exit?.sourceCurrentness?.cells ?? [];
    const testEvidence = pdp1Exit?.ownerStatusJoin?.testEvidence;
    const valid = predecessor?.phase === 'PDP-2'
      && predecessor?.sourceCurrentness?.materialSourceSetFingerprint === 'sha256:318b301bfb6ee4a4d27f141f8137930c2aa1353dc6b6e8d519ac015bc1ec1eda'
      && pdp1ExitPath === PDP1_CURRENT_CUT_EXIT_R19_PATH
      && pdp1ExitDigest === digestFile(PDP1_CURRENT_CUT_EXIT_R19_PATH)
      && pdp1Exit?.phaseExit?.status === 'PASS' && pdp1Exit?.phaseExit?.sourceCurrentness === 'PASS'
      && pdp1Exit?.developmentStatus?.status === 'DEV_COMPLETE'
      && pdp1Exit?.developmentStatus?.outstandingMeaningIds?.length === 0
      && pdp1Exit?.sourceCurrentness?.status === 'PASS' && pdp1Exit?.sourceCurrentness?.sourceCurrent === true
      && pdp1Exit?.sourceCurrentness?.materialPathDenominator?.uniquePaths === 329
      && cells.length === 50 && cells.every((cell) => cell.sourceCurrentness === 'CURRENT' && (cell.blockers?.length ?? 0) === 0)
      && testEvidence?.status === 'PASS' && testEvidence?.testCount === 84
      && testEvidence?.passedCount === 84 && testEvidence?.failedCount === 0 && testEvidence?.skippedCount === 0
      && currentHashesMatch;
    return {
      valid,
      classification: 'PDP1_STATUS_AND_SEMANTIC_REVIEW_EVIDENCE_REFRESH_NO_PDP2_MEANING_DISPOSITION',
      predecessorRef: PDP2_CURRENT_CUT_PREDECESSOR_PATH,
      successorRef: pdp1ExitPath,
      successorDigest: pdp1ExitDigest ?? null,
      paths: paths.map((sourcePath) => ({ path: sourcePath, predecessorSha256: expected[sourcePath][0], currentSha256: expected[sourcePath][1], liveSha256: actualCurrentDigests?.[sourcePath] ?? null, matches: predecessorDigests[sourcePath] === expected[sourcePath][0] && currentDigests?.[sourcePath] === actualCurrentDigests?.[sourcePath] })),
      currentPathCount: Object.keys(currentDigests ?? {}).length,
      predecessorPathCount: Object.keys(predecessorDigests).length,
      pdp1Proof: { phaseStatus: pdp1Exit?.phaseExit?.status ?? null, developmentStatus: pdp1Exit?.developmentStatus?.status ?? null, outstandingMeaningIdCount: pdp1Exit?.developmentStatus?.outstandingMeaningIds?.length ?? null, cellCount: cells.length, materialPathCount: pdp1Exit?.sourceCurrentness?.materialPathDenominator?.uniquePaths ?? null, testCount: testEvidence?.testCount ?? null, passedCount: testEvidence?.passedCount ?? null },
    };
  }
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
    'media.observation-contract.transcript-submission-lineage.v1',
    'media.observation-contract.job-status-seven-dimension.v1',
    'media.observation-contract.output-preview-version-lineage.v1',
  ];
  const expectedOperationIds = [
    'media.operation.capability.media-speech-synthesis-dub',
    'media.operation.fallback-selection.confirm.v1',
  ];
  const semanticDefinitionReview = (semanticReviewSource?.supplementaryReviews ?? [])
    .find((review) => review.id === 'P1-current-owner-typed-observation-definition-delta-2026-10-14');
  const operationDelta = operationsReviewSource?.currentSourceCutDeltaReview?.supplementalPdp1DefinitionDelta;
  const operationDeltaIds = operationDelta?.reviewedRecords?.map((record) => record.id) ?? [];
  const reviewedOperationRecords = operationDelta?.reviewedOperationRecords ?? [];
  const operationsSource = parsePdp1OperationsSource(operationsSourceText ?? '');
  const capabilityContract = operationsSource?.capabilityOperationContracts?.records?.find((record) => record.id === expectedOperationIds[0]);
  const fallbackContract = operationsSource?.ownerDefinedOperationContracts?.records?.find((record) => record.id === expectedOperationIds[1]);
  const capabilityBindingRules = capabilityContract?.resultSchema?.bindingRules ?? [];
  const capabilityInputPayload = capabilityContract?.requestSchema?.properties?.input2?.properties?.payload;
  const expectedDubbingInputFields = ['artifactId', 'versionId', 'sourceContentDigest', 'sourceClockId', 'ticksPerSecond', 'sourceDurationTicks'];
  const expectedDubbingParameterFields = ['outputProfileRef', 'sourceLocale', 'targetLocale', 'translatedSegmentVersionRef', 'voiceProfileVersionRef'];
  const expectedFallbackCoverage = {
    bindingRuleIds: (fallbackContract?.bindingRules ?? []).map((record) => record.id),
    evidenceJoinRuleIds: (fallbackContract?.evidenceJoinRules ?? []).map((record) => record.id),
    resultBindingIds: (fallbackContract?.resultBindings ?? []).flatMap((record) => (record.bindings ?? []).map((binding) => binding.id)),
  };
  const operationReviewMatches = reviewedOperationRecords.length === expectedOperationIds.length
    && reviewedOperationRecords.map((record) => record.id).every((id, index) => id === expectedOperationIds[index])
    && reviewedOperationRecords[0]?.selector === `.product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/records/@id=${expectedOperationIds[0]}`
    && reviewedOperationRecords[0]?.bindingCollection === 'resultSchema.bindingRules[].id'
    && capabilityBindingRules.length === 13
    && JSON.stringify(reviewedOperationRecords[0]?.bindingIds) === JSON.stringify(capabilityBindingRules.map((binding) => binding.id))
    && capabilityBindingRules.every((binding) => binding.operator === 'EXACT_EQUAL')
    && capabilityBindingRules[0]?.leftRef === '$.request.requestId'
    && capabilityBindingRules[0]?.rightRef === '$.result.requestId'
    && capabilityBindingRules.slice(1, 7).every((binding) => binding.leftRef.startsWith('$.request.input2.payload.')
      && binding.rightRef.startsWith('$.result.acceptedRequest.'))
    && capabilityBindingRules.slice(7, 12).every((binding) => binding.leftRef.startsWith('$.request.parameters.')
      && binding.rightRef.startsWith('$.result.acceptedRequest.'))
    && capabilityBindingRules[12]?.leftRef === '$.result.acceptedRequest.candidateOutputRef'
    && capabilityBindingRules[12]?.rightRef === '$.result.outputs[0].payload.reference'
    && JSON.stringify(capabilityInputPayload?.required) === JSON.stringify(expectedDubbingInputFields)
    && JSON.stringify(reviewedOperationRecords[0]?.requiredInputPayloadFields) === JSON.stringify(expectedDubbingInputFields)
    && JSON.stringify([...(capabilityContract?.parameterSchema?.required ?? [])].sort()) === JSON.stringify([...expectedDubbingParameterFields].sort())
    && JSON.stringify([...(reviewedOperationRecords[0]?.requiredParameters ?? [])].sort()) === JSON.stringify([...expectedDubbingParameterFields].sort())
    && reviewedOperationRecords[1]?.selector === `.product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=${expectedOperationIds[1]}`
    && Object.keys(expectedFallbackCoverage).every((key) => expectedFallbackCoverage[key].length > 0
      && JSON.stringify(reviewedOperationRecords[1]?.[key]) === JSON.stringify(expectedFallbackCoverage[key]))
    && fallbackContract?.operationKind === 'COMMAND'
    && typeof fallbackContract?.sourceEffect === 'string'
    && fallbackContract.sourceEffect.includes('does not dispatch or retry processing')
    && typeof fallbackContract?.scopeStatus === 'string'
    && fallbackContract.scopeStatus.includes('no fallback execution, provider, endpoint, transport, or runtime is admitted');
  const semanticDefinitionIdsMatch = Array.isArray(definitionReview?.reviewedDefinitionIds)
    && definitionReview.reviewedDefinitionIds.length === expectedDefinitionIds.length
    && expectedDefinitionIds.every((id, index) => definitionReview.reviewedDefinitionIds[index] === id)
    && operationDeltaIds.length === expectedDefinitionIds.length
    && expectedDefinitionIds.every((id, index) => operationDeltaIds[index] === id)
    && operationReviewMatches
    && JSON.stringify(semanticDefinitionReview?.reviewedObservationContractIds) === JSON.stringify(expectedDefinitionIds)
    && JSON.stringify(semanticDefinitionReview?.reviewedOperationIds) === JSON.stringify(expectedOperationIds)
    && semanticDefinitionReview?.reviewedRecordCount === expectedDefinitionIds.length + expectedOperationIds.length
    && semanticDefinitionReview?.identitySetChanged === true
    && JSON.stringify(semanticDefinitionReview?.newIdentityIds) === JSON.stringify([
      'capabilityInputPayloadSchemas:media.typed-input.source-media-with-speech-dub',
      'operations:media.operation.fallback-selection.confirm.v1',
    ])
    && semanticDefinitionReview?.resultingIdentityCount === 2025
    && semanticDefinitionReview?.reviewedPopulationIdCountResult === 2025;
  const operationSourceSha256 = definitionReview?.observedSha256?.replace(/^sha256:/u, '');
  const operationReviewSha256 = definitionReview?.reviewArtifactObservedSha256?.replace(/^sha256:/u, '');
  const liveOperationsSha256 = typeof operationsSourceText === 'string'
    ? crypto.createHash('sha256').update(operationsSourceText).digest('hex') : null;
  const liveOperationsReviewSha256 = typeof operationsReviewText === 'string'
    ? crypto.createHash('sha256').update(operationsReviewText).digest('hex') : null;
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
    && operationsSource?.ownerTypedObservationContracts?.records?.length === 15
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
    && semanticDefinitionReview?.meaning?.includes('eight owner typed observation contracts')
    && semanticDefinitionReview?.meaning?.includes('the C16 dubbing operation')
    && semanticDefinitionReview?.meaning?.includes('the fallback-selection confirmation operation')
    && semanticDefinitionReview?.meaning?.includes('Current verification remains pending.')
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
    && DIGEST.test(predecessor?.sourceCurrentness?.materialSourceSetFingerprint ?? '')
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
    && testEvidence?.testCount === 83
    && testEvidence?.passedCount === 83
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
    && statusSource?.sourceIdentityIds?.length === 2025
    && currentCriteria.length === 11
    && currentCriteria.every((criterion) => criterion.testStatus === 'PASS')
    && currentStatusTestCount === 344
    && currentStatusPassedCount === 344
    && currentStatusSkippedCount === 0
    && currentExecutedCriteria.length === 11
    && currentExecutedCriteria.every((item) => item.status === 'PASS' && item.testCount === item.passedTestCount && item.skippedTestCount === 0)
    && semanticReviewSource?.schemaVersion === 'media.pdp1-development-semantic-review.v1'
    && semanticReviewSource?.status === 'APPROVED_PDP1_DEVELOPMENT_SEMANTIC_REVIEW'
    && Object.keys(semanticReviewSource?.sourceFingerprints ?? {}).length === 104
    && semanticReviewSource?.reviewedIdentityIds?.length === 2025
    && semanticReviewSource?.outstandingMeaningIds?.length === 0
    && semanticReviewSource?.sourceCutStable === true
    && currentIdentityIds.length === 2025
    && reviewedIdentityIds.length === 2025
    && identitySetsMatch
    && supersededPhaseReviewMarker === 'PENDING_FINAL_PDP1_STATUS_AND_PHASE_CURRENTNESS_RECUT: all 104 semantic source fingerprints are current after the exact authorized pin refresh; rerun the complete PDP-1 criterion set and capture a new source-current phase exit before claiming currentness.'
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
      disposition: 'HISTORICAL_PENDING_MARKERS_SUPERSEDED_BY_EXPLICIT_CURRENT_PDP1_SUCCESSOR_AND_CURRENT_STATUS; P1_SEMANTIC_DELTA_REMAINS_SEPARATELY_RECORDED',
    },
  };
}

export function validatePdp2CombinedSourceRefresh({ predecessor, currentDigests, p2Impact, p1EvidenceRefresh, additionalP2Impact = null, additionalProjectionImpact = null }) {
  const predecessorDigests = predecessor?.sourceCurrentness?.sourceSetDigests?.sourceContentDigests ?? {};
  const predecessorPaths = Object.keys(predecessorDigests).sort();
  const currentPaths = Object.keys(currentDigests ?? {}).sort();
  const predecessorSet = new Set(predecessorPaths);
  const currentSet = new Set(currentPaths);
  const missingPaths = predecessorPaths.filter((sourcePath) => !currentSet.has(sourcePath));
  const additionalPaths = currentPaths.filter((sourcePath) => !predecessorSet.has(sourcePath));
  const changedPaths = predecessorPaths.filter((sourcePath) => predecessorDigests[sourcePath] !== currentDigests?.[sourcePath]);
  const currentScopedChangedPaths = p2Impact?.currentCutScopedChangedPaths ?? p2Impact?.scopedChangedPaths ?? [];
  const currentSupplementalSourceWork = p2Impact?.currentCutSupplementalSourceWork ?? p2Impact?.supplementalSourceWork ?? [];
  const evidencePathsCoveredByImpact = (p1EvidenceRefresh?.paths ?? []).every(({ path: sourcePath }) => currentScopedChangedPaths.includes(sourcePath));
  const expectedChangedPaths = [...new Set([...currentScopedChangedPaths, ...currentSupplementalSourceWork.map(({ path: sourcePath }) => sourcePath), ...(p1EvidenceRefresh?.paths ?? []).map(({ path: sourcePath }) => sourcePath), ...(additionalP2Impact?.valid ? (additionalP2Impact.paths ?? [additionalP2Impact.path]) : []), ...(additionalProjectionImpact?.valid ? additionalProjectionImpact.paths : [])])].sort();
  const baseImpactPaths = [...currentScopedChangedPaths, ...currentSupplementalSourceWork.map(({ path: sourcePath }) => sourcePath)];
  const predecessorEvidencePaths = (p1EvidenceRefresh?.paths ?? []).map(({ path: sourcePath }) => sourcePath);
  const additionalImpactPaths = additionalP2Impact?.valid ? (additionalP2Impact.paths ?? [additionalP2Impact.path]) : [];
  const additionalProjectionPaths = additionalProjectionImpact?.valid ? additionalProjectionImpact.paths : [];
  const additionalImpactIsDisjoint = [...additionalImpactPaths, ...additionalProjectionPaths].every((sourcePath) => !baseImpactPaths.includes(sourcePath) && !predecessorEvidencePaths.includes(sourcePath));
  const noOverlappingImpactPaths = additionalImpactIsDisjoint && new Set([...additionalImpactPaths, ...additionalProjectionPaths]).size === additionalImpactPaths.length + additionalProjectionPaths.length && evidencePathsCoveredByImpact;
  return {
    valid: p2Impact?.valid === true
      && p1EvidenceRefresh?.valid === true
      && (additionalP2Impact === null || additionalP2Impact?.valid === true)
      && (additionalProjectionImpact === null || additionalProjectionImpact?.valid === true)
      && (p2Impact?.currentnessSourceChains === undefined || p2Impact.currentnessSourceChains.valid === true)
      && predecessorPaths.length === 405
      && currentPaths.length === 405
      && missingPaths.length === 0
      && additionalPaths.length === 0
      && noOverlappingImpactPaths
      && evidencePathsCoveredByImpact
      && changedPaths.length === expectedChangedPaths.length
      && changedPaths.sort().every((sourcePath, index) => sourcePath === expectedChangedPaths[index])
      && expectedChangedPaths.length === currentScopedChangedPaths.length + currentSupplementalSourceWork.length + (additionalP2Impact?.valid ? (additionalP2Impact.paths?.length ?? 1) : 0) + (additionalProjectionImpact?.valid ? additionalProjectionPaths.length : 0),
    predecessorPathCount: predecessorPaths.length,
    currentPathCount: currentPaths.length,
    changedPathCount: changedPaths.length,
    changedPaths,
    expectedChangedPaths,
    missingPaths,
    additionalPaths,
    evidencePathsCoveredByImpact,
    pdp1EvidenceRefreshClassification: p1EvidenceRefresh?.classification ?? null,
    pdp2MeaningDispositionAppliedOnlyTo: currentScopedChangedPaths,
    noOverlappingImpactPaths,
  };
}

export function pdp2CurrentCutImpact(predecessor, currentDigests, {
  pdp1ExitPath = PDP1_CURRENT_CUT_EXIT_PATH,
  additionalSourceImpactPath = PDP2_ADDITIONAL_SOURCE_IMPACT_PATH,
  additionalProjectionImpactPath = PDP2_R16_PROJECTION_IMPACT_PATH,
} = {}) {
  const impact = readJson(PDP2_CURRENT_CUT_IMPACT_PATH);
  const baseline = readJson(PDP2_CURRENT_CUT_PREDECESSOR_PATH);
  const p1Exit = readJson(pdp1ExitPath);
  const actualCurrentDigests = Object.fromEntries(Object.keys(currentDigests).map((sourcePath) => [sourcePath, digestFile(sourcePath)]));
  const additionalRecord = additionalSourceImpactPath ? readJson(additionalSourceImpactPath) : null;
  const projectionRecord = additionalProjectionImpactPath ? readJson(additionalProjectionImpactPath) : null;
  if (p1Exit?.observationId === 'MEDIA-PDP1-CURRENTNESS-2026-10-15-CURRENT-CUT-R30') {
    const sourceImpact = validatePdp2R17SuccessorImpact({
      predecessor, currentDigests, actualCurrentDigests, r30Exit: p1Exit,
      matrix: readJson(MATRIX_PATH), impactRecord: readJson(PDP2_R17_TO_R30_IMPACT_PATH),
    });
    const currentCutScopedChangedPaths = sourceImpact.changedPaths;
    const currentCutScopedTransitions = sourceImpact.transitions;
    const currentnessSourceChains = {
      valid: sourceImpact.valid,
      materialPathCount: sourceImpact.materialPathCount,
      changedPathCount: sourceImpact.changedPathCount,
      uniqueTransitionPathCount: currentCutScopedTransitions.length,
      chains: currentCutScopedTransitions.map((transition) => ({
        path: transition.path,
        r17Sha256: transition.predecessorSha256,
        currentSha256: transition.observedSha256,
        terminalSha256: transition.observedSha256,
        hopCount: 1,
        chainMatchesCurrent: transition.observedSha256 === currentDigests[transition.path],
        terminalMatchesCurrent: transition.observedSha256 === currentDigests[transition.path],
      })),
    };
    const p1EvidenceRefresh = validatePdp1EvidenceRefresh({
      predecessor, currentDigests, actualCurrentDigests, pdp1Exit: p1Exit,
      pdp1ExitDigest: digestFile(pdp1ExitPath), pdp1ExitPath,
    });
    const combined = validatePdp2CombinedSourceRefresh({
      predecessor, currentDigests,
      p2Impact: { valid: sourceImpact.valid, currentCutScopedChangedPaths,
        currentCutSupplementalSourceWork: [], scopedChangedPaths: currentCutScopedChangedPaths,
        supplementalSourceWork: [], currentnessSourceChains },
      p1EvidenceRefresh,
    });
    return {
      valid: sourceImpact.valid && p1EvidenceRefresh.valid && combined.valid,
      scopedImpactValid: sourceImpact.valid,
      scopedChangedPaths: currentCutScopedChangedPaths,
      currentCutScopedChangedPaths,
      scopedTransitions: currentCutScopedTransitions,
      currentCutSupplementalSourceWork: [],
      supplementalSourceWork: [],
      supplementalSourceWorkValid: true,
      transitionsValid: sourceImpact.valid,
      transitionCount: currentCutScopedTransitions.length,
      currentnessSourceChains,
      r17ToR30SourceImpact: sourceImpact,
      r17HistoricalPinReview: predecessor?.historicalPinReview ?? null,
      predecessorEvidenceRefresh: p1EvidenceRefresh,
      combinedSourceRefresh: combined,
      additionalSourceImpact: null,
      r16ProjectionImpact: null,
      changedPaths: combined.changedPaths,
      ownerAcceptance: 'NOT_CLAIMED',
      independentReview: 'NOT_CLAIMED',
      lifecycleClosure: 'NOT_ENTERED',
      runtimeAdmission: 'NOT_ADMITTED',
      delivery: 'NOT_AUTHORIZED',
      release: 'NOT_AUTHORIZED',
    };
  }
  const isR27 = p1Exit?.observationId === 'MEDIA-PDP1-CURRENTNESS-2026-10-14-CURRENT-CUT-R27';
  if (isR27 || p1Exit?.observationId === 'MEDIA-PDP1-CURRENTNESS-2026-10-14-CURRENT-CUT-R25') {
    const r27Bridge = isR27 ? validatePdp1R27SourceMapBridge({
      r27Exit: p1Exit,
      matrix: readJson(MATRIX_PATH),
      pdp1ExitPath,
      pdp1ExitDigest: digestFile(pdp1ExitPath),
      actualCurrentDigests,
      currentDigests,
    }) : null;
    if (isR27 && additionalSourceImpactPath !== PDP2_ADDITIONAL_SOURCE_IMPACT_R1_PATH) {
      return { valid: false, scopedImpactValid: false, additionalSourceImpact: null, r25ToR27Bridge: r27Bridge,
        blocker: 'PDP2_R27_REQUIRES_EXACT_R13_TO_R25_R1_IMPACT_RECORD' };
    }
    if (isR27 && additionalProjectionImpactPath !== PDP2_R16_PROJECTION_IMPACT_RECORD_PATH) {
      return { valid: false, scopedImpactValid: false, additionalSourceImpact: null, r25ToR27Bridge: r27Bridge,
        blocker: 'PDP2_R27_REQUIRES_EXACT_R16_GENERATED_PROJECTION_IMPACT_RECORD' };
    }
    const r13 = readJson(PDP2_CURRENT_CUT_PREDECESSOR_R13_PATH);
    const r13Digests = r13.sourceCurrentness?.sourceSetDigests?.sourceContentDigests ?? {};
    const historicalR5 = readJson(PDP2_CURRENT_CUT_IMPACT_R5_PATH);
    const historicalR9 = readJson(PDP2_CURRENT_CUT_PREDECESSOR_R9_PATH);
    const historicalP1R22 = readJson(PDP1_CURRENT_CUT_EXIT_R22_PATH);
    const historicalP1R22Digests = { ...r13Digests };
    const historicalP2Impact = validatePdp2CurrentCutImpact({
      impact: historicalR5,
      predecessor: historicalR9,
      currentDigests: r13Digests,
      actualCurrentDigests: historicalP1R22Digests,
      predecessorDigest: digestFile(PDP2_CURRENT_CUT_PREDECESSOR_R9_PATH),
      impactDigest: digestFile(PDP2_CURRENT_CUT_IMPACT_R5_PATH),
      predecessorPath: PDP2_CURRENT_CUT_PREDECESSOR_R9_PATH,
      impactPath: PDP2_CURRENT_CUT_IMPACT_R5_PATH,
      pdp1Exit: historicalP1R22,
      pdp1ExitDigest: digestFile(PDP1_CURRENT_CUT_EXIT_R22_PATH),
      pdp1ExitPath: PDP1_CURRENT_CUT_EXIT_R22_PATH,
    });
    const additionalP2Impact = additionalRecord ? validatePdp2AdditionalSourceImpact({
      record: additionalRecord,
      recordPath: additionalSourceImpactPath,
      predecessor: r13,
      predecessorPath: PDP2_CURRENT_CUT_PREDECESSOR_R13_PATH,
      predecessorDigest: digestFile(PDP2_CURRENT_CUT_PREDECESSOR_R13_PATH),
      currentDigests,
      actualCurrentDigests,
    }) : null;
    const r16ProjectionImpact = isR27 ? validatePdp2R16ProjectionImpact({
      record: projectionRecord,
      recordPath: additionalProjectionImpactPath,
      currentDigests,
      actualCurrentDigests,
    }) : null;
    const currentnessSourceChains = composePdp2CurrentnessSourceChains({
      r9Checkpoint: historicalR9,
      r9ReceiptPath: PDP2_CURRENT_CUT_PREDECESSOR_R9_PATH,
      r9ReceiptDigest: digestFile(PDP2_CURRENT_CUT_PREDECESSOR_R9_PATH),
      r13Checkpoint: r13,
      r13ReceiptPath: PDP2_CURRENT_CUT_PREDECESSOR_R13_PATH,
      r13ReceiptDigest: digestFile(PDP2_CURRENT_CUT_PREDECESSOR_R13_PATH),
      historicalR5Impact: historicalP2Impact,
      additionalSourceImpact: additionalP2Impact,
      r16ProjectionImpact,
      r16Checkpoint: readJson(PDP2_R16_RECEIPT_PATH),
      currentDigests,
    });
    const composedScopedTransitions = [...(historicalP2Impact.scopedTransitions ?? []), ...(additionalP2Impact?.transitions ?? [])];
    const composedScopedChangedPaths = [...new Set(composedScopedTransitions.map(({ path: sourcePath }) => sourcePath))].sort();
    const p2Disposition = {
      ...historicalP2Impact,
      valid: historicalP2Impact.valid && currentnessSourceChains.valid,
      historicalR5Impact: { ...historicalP2Impact, predecessorRef: PDP2_CURRENT_CUT_PREDECESSOR_R9_PATH, currentCheckpointRef: PDP2_CURRENT_CUT_PREDECESSOR_R13_PATH },
      historicalR9Checkpoint: historicalR9,
      historicalR9CheckpointJoin: validatePdp2R9HistoricalCheckpoint(historicalR9),
      scopedChangedPaths: composedScopedChangedPaths,
      scopedTransitions: composedScopedTransitions,
      supplementalSourceWork: historicalP2Impact.supplementalSourceWork ?? [],
      supplementalSourceWorkValid: historicalP2Impact.supplementalSourceWorkValid === true,
      transitionsValid: currentnessSourceChains.valid,
      changedPaths: currentnessSourceChains.chains.map(({ path: sourcePath }) => sourcePath),
      transitionCount: composedScopedTransitions.length,
      currentCutScopedChangedPaths: [],
      currentCutSupplementalSourceWork: [],
      currentnessSourceChains,
    };
    const p1EvidenceRefresh = validatePdp1EvidenceRefresh({
      predecessor: r13,
      currentDigests,
      actualCurrentDigests,
      pdp1Exit: p1Exit,
      pdp1ExitDigest: digestFile(pdp1ExitPath),
      pdp1ExitPath,
    });
    const combined = validatePdp2CombinedSourceRefresh({ predecessor: r13, currentDigests, p2Impact: p2Disposition, p1EvidenceRefresh, additionalP2Impact, additionalProjectionImpact: r16ProjectionImpact });
    return {
      ...p2Disposition,
      valid: combined.valid && currentnessSourceChains.valid && (!isR27 || (r27Bridge?.valid === true && r16ProjectionImpact?.valid === true)),
      scopedImpactValid: historicalP2Impact.valid,
      additionalSourceImpact: additionalP2Impact,
      r16ProjectionImpact,
      r25ToR27Bridge: r27Bridge,
      changedPaths: combined.changedPaths,
      predecessorEvidenceRefresh: p1EvidenceRefresh,
      combinedSourceRefresh: combined,
    };
  }
  const additionalP2Impact = additionalRecord ? validatePdp2AdditionalSourceImpact({
    record: additionalRecord,
    recordPath: PDP2_ADDITIONAL_SOURCE_IMPACT_PATH,
    predecessor: baseline,
    predecessorPath: PDP2_CURRENT_CUT_PREDECESSOR_PATH,
    predecessorDigest: digestFile(PDP2_CURRENT_CUT_PREDECESSOR_PATH),
    currentDigests,
    actualCurrentDigests,
  }) : null;
  const p2Disposition = validatePdp2CurrentCutImpact({
    impact,
    predecessor: baseline,
    currentDigests,
    actualCurrentDigests,
    predecessorDigest: digestFile(PDP2_CURRENT_CUT_PREDECESSOR_PATH),
    impactDigest: digestFile(PDP2_CURRENT_CUT_IMPACT_PATH),
    pdp1Exit: p1Exit,
    pdp1ExitDigest: digestFile(pdp1ExitPath),
    pdp1ExitPath,
  });
  const p1EvidenceRefresh = validatePdp1EvidenceRefresh({
    predecessor: baseline,
    currentDigests,
    actualCurrentDigests,
    pdp1Exit: p1Exit,
    pdp1ExitDigest: digestFile(pdp1ExitPath),
    pdp1ExitPath,
    statusSource: readJson(PDP1_STATUS_PATH),
    semanticReviewSource: readJson(PDP1_SEMANTIC_REVIEW_PATH),
    operationsSourceText: fs.readFileSync(path.resolve(root, '.product-experience/pdp-1-domain-data/operations.yaml'), 'utf8'),
    operationsReviewText: fs.readFileSync(path.resolve(root, '.product-experience/pdp-1-domain-data/operations-current-source-review.json'), 'utf8'),
    operationsReviewSource: readJson('.product-experience/pdp-1-domain-data/operations-current-source-review.json'),
  });
  if (additionalP2Impact?.valid) {
    const claimed = new Set([...(p2Disposition.scopedChangedPaths ?? []), ...(p1EvidenceRefresh?.paths ?? []).map(({ path: sourcePath }) => sourcePath)]);
    if (additionalP2Impact.paths?.some((sourcePath) => claimed.has(sourcePath))) additionalP2Impact.valid = false;
  }
  const combined = validatePdp2CombinedSourceRefresh({ predecessor: baseline, currentDigests, p2Impact: p2Disposition, p1EvidenceRefresh, additionalP2Impact });
  return {
    ...p2Disposition,
    valid: combined.valid,
    scopedImpactValid: p2Disposition.valid,
    additionalSourceImpact: additionalP2Impact,
    changedPaths: combined.changedPaths,
    scopedChangedPaths: p2Disposition.scopedChangedPaths,
    predecessorEvidenceRefresh: p1EvidenceRefresh,
    combinedSourceRefresh: combined,
  };
}

function historicalR5PinChain(entry, p2Impact) {
  const historicalR5Impact = p2Impact?.historicalR5Impact;
  const sourceChains = p2Impact?.currentnessSourceChains;
  if (historicalR5Impact?.valid !== true || historicalR5Impact?.transitionsValid !== true
      || historicalR5Impact?.supplementalSourceWorkValid !== true || sourceChains?.valid !== true) return null;
  const chain = sourceChains.chains?.find(({ path: sourcePath }) => sourcePath === entry.path);
  if (!chain || chain.r5HopCount < 1 || chain.r5ChainMatchesR13 !== true
      || chain.r1ChainMatchesCurrent !== true || chain.terminalMatchesCurrent !== true
      || chain.currentSha256 !== entry.currentSha256
      || p2Impact.historicalR9CheckpointJoin?.valid !== true) return null;
  const r9Join = p2Impact.historicalR9Checkpoint?.ownerStatusJoin;
  const r9ScopedTransitions = (r9Join?.pdp2ScopedImpact?.scopedTransitions ?? [])
    .filter(({ path: sourcePath }) => sourcePath === entry.path);
  const r9Supplement = r9Join?.supplementalDelta?.path === entry.path ? r9Join.supplementalDelta : null;
  if (r9Supplement && (r9Supplement.valid !== true || typeof r9Supplement.currentSha256 !== 'string')) return null;
  const r9Transitions = [
    ...(r9Supplement ? [{
      path: r9Supplement.path,
      predecessorSha256: r9Supplement.predecessorSha256,
      observedSha256: r9Supplement.currentSha256,
      classification: 'PDP3_STATUS_GUARD_SUPPLEMENT',
    }] : []),
    ...r9ScopedTransitions,
  ];
  let priorCursor = entry.historicalSha256;
  for (const transition of r9Transitions) {
    if (transition.predecessorSha256 !== priorCursor) return null;
    priorCursor = transition.observedSha256;
  }
  if (priorCursor !== chain.r9Sha256) return null;
  const sourceHops = (historicalR5Impact.scopedTransitions ?? []).filter(({ path: sourcePath }) => sourcePath === entry.path);
  const sourceWork = (historicalR5Impact.supplementalSourceWork ?? []).filter(({ path: sourcePath }) => sourcePath === entry.path);
  const expectedHops = [...sourceHops, ...sourceWork];
  if (expectedHops.length !== chain.r5Hops?.length || expectedHops.length !== chain.r5HopCount) return null;
  let cursor = chain.r9Sha256;
  for (const [index, hop] of expectedHops.entries()) {
    const chainedHop = chain.r5Hops[index];
    if (hop.predecessorSha256 !== cursor || chainedHop?.path !== hop.path
        || chainedHop?.predecessorSha256 !== hop.predecessorSha256
        || chainedHop?.observedSha256 !== hop.observedSha256
        || chainedHop?.classification !== hop.classification
        || (hop.meaningChange ?? null) !== (chainedHop.meaningChange ?? null)) return null;
    cursor = hop.observedSha256;
  }
  if (cursor !== chain.r13Sha256) return null;
  const r1Transitions = (p2Impact.additionalSourceImpact?.transitions ?? [])
    .filter(({ path: sourcePath }) => sourcePath === entry.path);
  if (r1Transitions.length !== chain.r1Hops?.length) return null;
  let r1Cursor = chain.r13Sha256;
  for (const [index, transition] of r1Transitions.entries()) {
    const chainedHop = chain.r1Hops[index];
    if (transition.predecessorSha256 !== r1Cursor || chainedHop?.predecessorSha256 !== transition.predecessorSha256
        || chainedHop?.observedSha256 !== transition.observedSha256
        || chainedHop?.classification !== transition.classification) return null;
    r1Cursor = transition.observedSha256;
  }
  if (r1Cursor !== chain.currentSha256) return null;
  return { chain, transitions: sourceHops, sourceWork };
}

export function sourcePinReview(status, currentDigests, mdc20, ownerChanges, supplement, p2Impact) {
  const changes = Object.entries(status.sourceShaSet ?? [])
    .map(([sourcePath, recorded]) => {
      const expected = `sha256:${recorded.replace(/^sha256:/u, '')}`;
      const current = currentDigests[sourcePath] ?? null;
      return { path: sourcePath, historicalSha256: expected, currentSha256: current, matches: expected === current };
    });
  const changed = changes.filter((entry) => !entry.matches);
  const r17HistoricalReview = p2Impact.r17HistoricalPinReview;
  const r17HistoricalPins = r17HistoricalReview?.changedPins ?? [];
  const r17HistoricalPinByPath = new Map(r17HistoricalPins.map((entry) => [entry.path, entry]));
  const r17SuccessorTransitions = new Map((p2Impact.scopedTransitions ?? []).map((entry) => [entry.path, entry]));
  const r17HistoricalExpectedPaths = [...(r17HistoricalReview?.expectedChangedPaths ?? [])].sort();
  const changedPaths = changed.map((entry) => entry.path).sort();
  const r17HistoricalPinPaths = r17HistoricalPins.map((entry) => entry.path).sort();
  const r17PinPathsMatch = r17HistoricalExpectedPaths.length === r17HistoricalPins.length
    && new Set(r17HistoricalPinPaths).size === r17HistoricalPinPaths.length
    && JSON.stringify(r17HistoricalExpectedPaths) === JSON.stringify(r17HistoricalPins.map((entry) => entry.path).sort())
    && JSON.stringify(changedPaths) === JSON.stringify(r17HistoricalExpectedPaths);
  const r17PinDispositionInventoryValid = r17HistoricalReview?.historicalPinCount === changes.length
    && r17HistoricalReview?.currentPinCount + r17HistoricalReview?.changedPinCount === r17HistoricalReview?.historicalPinCount
    && r17HistoricalReview?.missingPinCount === 0
    && r17HistoricalPins.every((entry) => typeof entry.path === 'string'
      && /^sha256:[a-f0-9]{64}$/u.test(entry.historicalSha256 ?? '')
      && /^sha256:[a-f0-9]{64}$/u.test(entry.currentSha256 ?? '')
      && (typeof entry.disposition?.classification === 'string' && entry.disposition.classification.length > 0
        || entry.historicalR5Chain?.valid === true && entry.historicalR5Chain.currentSha256 === entry.currentSha256));
  const r17HistoricalPinCarryForwardValid = p2Impact.r17ToR30SourceImpact?.valid === true
    && r17PinDispositionInventoryValid
    && r17HistoricalReview?.changedPinCount === r17HistoricalReview?.expectedChangedPathCount
    && r17HistoricalReview?.unclassifiedChangedPins?.length === 0
    && r17HistoricalReview?.expectedChangedPathsMatch === true
    && r17PinPathsMatch
    && changed.every((entry) => {
      const prior = r17HistoricalPinByPath.get(entry.path);
      const transition = r17SuccessorTransitions.get(entry.path);
      return prior?.historicalSha256 === entry.historicalSha256
        && (transition
          ? prior.currentSha256 === transition.predecessorSha256
            && entry.currentSha256 === transition.observedSha256
          : entry.currentSha256 === prior.currentSha256);
    });
  const dispositionByPath = new Map((mdc20.pinReview?.changedPins ?? []).map((entry) => [entry.path, entry]));
  const ownerByPath = new Map(ownerChanges.map((entry) => [entry.path, entry]));
  const historicalR5ByPath = new Map(changed.flatMap((entry) => {
    const chain = historicalR5PinChain(entry, p2Impact);
    return chain ? [[entry.path, chain]] : [];
  }));
  const unclassified = changed.filter((entry) => {
    if (supplement.valid && supplement.chainValid && entry.path === supplement.path
        && entry.historicalSha256 === supplement.predecessorSha256
        && entry.currentSha256 === supplement.currentSha256) return false;
    if (p2Impact.valid && p2Impact.changedPaths.includes(entry.path)
        && p2Impact.transitionsValid && currentDigests[entry.path] === entry.currentSha256) return false;
    if (p2Impact.additionalSourceImpact?.valid === true
        && (p2Impact.additionalSourceImpact.transitions ?? [p2Impact.additionalSourceImpact]).some((delta) => delta.path === entry.path
          && entry.historicalSha256 === delta.predecessorSha256
          && entry.currentSha256 === delta.observedSha256)) return false;
    if (p2Impact.r16ProjectionImpact?.valid === true
        && (p2Impact.r16ProjectionImpact.transitions ?? []).some((delta) => delta.path === entry.path
          && entry.historicalSha256 === delta.predecessorSha256
          && entry.currentSha256 === delta.observedSha256)) return false;
    if (p2Impact.supplementalSourceWorkValid === true
        && (p2Impact.supplementalSourceWork ?? []).some((work) => work.path === entry.path
          && entry.historicalSha256 === work.predecessorSha256
          && entry.currentSha256 === work.observedSha256
          && currentDigests[entry.path] === work.observedSha256)) return false;
    if (r17HistoricalPinCarryForwardValid && r17HistoricalPinByPath.has(entry.path)) return false;
    if (historicalR5ByPath.get(entry.path)) return false;
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
  const expected = new Set(r17HistoricalPinCarryForwardValid ? r17HistoricalExpectedPaths : [
    '.product-experience/pdp-2-design-interface-system/DESIGN-LANGUAGE.md',
    'apps/media-experience-explorer/specification-artifacts.json',
    'libs/audio-video-ui/src/screens/TranscriptCaptionScreen.tsx',
    'modules/intelligence/ai-voice/libs/ai-voice-ui-react/src/index.ts',
  ]);
  const historicalPinPaths = new Set(changes.map((entry) => entry.path));
  if (supplement.valid) expected.add(supplement.path);
  if (p2Impact.valid) for (const sourcePath of p2Impact.changedPaths) {
    if (historicalPinPaths.has(sourcePath)) expected.add(sourcePath);
  }
  if (p2Impact.additionalSourceImpact?.valid) for (const sourcePath of p2Impact.additionalSourceImpact.paths ?? [p2Impact.additionalSourceImpact.path]) {
    if (historicalPinPaths.has(sourcePath)) expected.add(sourcePath);
  }
  if (p2Impact.r16ProjectionImpact?.valid) for (const sourcePath of p2Impact.r16ProjectionImpact.paths ?? []) {
    if (historicalPinPaths.has(sourcePath)) expected.add(sourcePath);
  }
  if (p2Impact.supplementalSourceWorkValid === true) for (const work of p2Impact.supplementalSourceWork ?? []) {
    if (historicalPinPaths.has(work.path)) expected.add(work.path);
  }
  for (const sourcePath of historicalR5ByPath.keys()) expected.add(sourcePath);
  const supplementChanged = changed.filter((entry) => entry.path === supplement.path);
  const chainedReporterDelta = p2Impact.scopedTransitions?.find((entry) => entry.path === supplement.path);
  const validDeltaCount = supplement.valid && supplement.chainValid && supplementChanged.length === 1
    && supplementChanged[0].historicalSha256 === supplement.predecessorSha256
    && chainedReporterDelta?.predecessorSha256 === 'sha256:ca59f6c4e1313bd58387f91b41eb51fc1a10ac04b2db01faed30b9edcc9b2573'
    && supplementChanged[0].currentSha256 === chainedReporterDelta?.observedSha256
    && supplement.currentSha256 === chainedReporterDelta?.observedSha256 ? 1 : 0;
  return {
    historicalPinCount: changes.length,
    currentPinCount: changes.length - changed.length,
    changedPinCount: changed.length,
    missingPinCount: changed.filter((entry) => entry.currentSha256 === null).length,
    changedPins: changed.map((entry) => {
      const p1Evidence = p2Impact.predecessorEvidenceRefresh?.paths?.find(({ path: sourcePath }) => sourcePath === entry.path);
      const scopedDelta = p2Impact.scopedTransitions?.find(({ path: sourcePath }) => sourcePath === entry.path);
      const sourceWork = p2Impact.supplementalSourceWork?.find(({ path: sourcePath }) => sourcePath === entry.path);
      const projectionDelta = p2Impact.r16ProjectionImpact?.transitions?.find(({ path: sourcePath }) => sourcePath === entry.path);
      const historicalR5 = historicalR5ByPath.get(entry.path);
      const r17HistoricalPin = r17HistoricalPinByPath.get(entry.path);
      return {
        ...entry,
        historicalR5Chain: r17HistoricalPin?.historicalR5Chain ?? (historicalR5 ? {
          r9Sha256: historicalR5.chain.r9Sha256,
          r13Sha256: historicalR5.chain.r13Sha256,
          currentSha256: historicalR5.chain.currentSha256,
          transitions: historicalR5.transitions,
          sourceWork: historicalR5.sourceWork,
          valid: true,
        } : null),
        disposition: r17HistoricalPin?.disposition ?? dispositionByPath.get(entry.path)
          ?? (p2Impact.additionalSourceImpact?.valid && (p2Impact.additionalSourceImpact.transitions ?? [p2Impact.additionalSourceImpact]).some((delta) => delta.path === entry.path)
            ? { classification: (p2Impact.additionalSourceImpact.transitions ?? [p2Impact.additionalSourceImpact]).find((delta) => delta.path === entry.path).classification, meaningIdsChanged: (p2Impact.additionalSourceImpact.transitions ?? [p2Impact.additionalSourceImpact]).find((delta) => delta.path === entry.path).meaningIdsChanged, sourceBoundToAdditionalImpact: true } : null)
          ?? (projectionDelta ? { classification: projectionDelta.classification, meaningChange: projectionDelta.meaningChange, sourceBoundToR16ProjectionImpact: true } : null)
          ?? (p1Evidence ? { classification: p2Impact.predecessorEvidenceRefresh.classification, sourceBoundToExplicitPdp1Successor: true } : null)
          ?? (scopedDelta ? { classification: scopedDelta.classification, meaningChange: scopedDelta.meaningChange } : null)
          ?? (r17HistoricalPinByPath.has(entry.path) ? {
            classification: r17HistoricalPinByPath.get(entry.path).disposition?.classification ?? 'R17_HISTORICAL_PIN_DISPOSITION_CARRIED_FORWARD',
            meaningChange: r17HistoricalPinByPath.get(entry.path).disposition?.meaningChange ?? null,
            sourceBoundToR17HistoricalPinReview: r17HistoricalPinCarryForwardValid,
          } : null)
          ?? (sourceWork ? { classification: sourceWork.classification, workKind: sourceWork.workKind, disposition: sourceWork.disposition, sourceDerivedFrom: sourceWork.derivedFrom?.sourceRef ?? null } : null),
      };
    }),
    unclassifiedChangedPins: unclassified,
    expectedChangedPaths: [...expected].sort(),
    expectedChangedPathCount: expected.size,
    r17HistoricalPinCarryForward: {
      valid: r17HistoricalPinCarryForwardValid,
      predecessorRef: p2Impact.r17ToR30SourceImpact?.predecessorRef ?? null,
      expectedChangedPaths: r17HistoricalExpectedPaths,
      expectedChangedPathCount: r17HistoricalExpectedPaths.length,
      matchedChangedPathCount: changed.filter((entry) => r17HistoricalPinByPath.has(entry.path)).length,
      sourceImpactTransitionCount: r17SuccessorTransitions.size,
    },
    explorerUsedOwnerDirectionBecauseMdc20HashWasStale: changed.some((entry) => entry.path === 'apps/media-experience-explorer/specification-artifacts.json'
      && dispositionByPath.get(entry.path)?.currentSha256 !== entry.currentSha256
      && ownerByPath.has(entry.path)),
    supplementalDelta: supplement,
    pdp2ScopedImpact: p2Impact,
    expectedChangedPathsMatch: changed.length === expected.size && changed.every((entry) => expected.has(entry.path))
      && [...expected].every((sourcePath) => changed.some((entry) => entry.path === sourcePath)),
    supplementalDeltaCount: validDeltaCount + (p2Impact.valid ? p2Impact.changedPaths.length : 0)
      + (p2Impact.additionalSourceImpact?.valid ? (p2Impact.additionalSourceImpact.paths?.length ?? 1) : 0)
      + (p2Impact.r16ProjectionImpact?.valid ? p2Impact.r16ProjectionImpact.paths.length : 0),
  };
}

function legacyScopedTransitionSummary(p2Impact, sourcePath) {
  const transitions = (p2Impact.scopedTransitions ?? []).filter(({ path: transitionPath }) => transitionPath === sourcePath);
  if (transitions.length === 0) return null;
  let cursor = transitions[0].predecessorSha256;
  let connected = typeof cursor === 'string';
  for (const transition of transitions) {
    connected &&= transition.predecessorSha256 === cursor;
    cursor = transition.observedSha256;
  }
  const sourceChain = p2Impact.currentnessSourceChains?.chains?.find(({ path: transitionPath }) => transitionPath === sourcePath);
  if (p2Impact.currentnessSourceChains !== undefined) {
    connected &&= p2Impact.currentnessSourceChains.valid === true
      && sourceChain?.r5ChainMatchesR13 === true
      && sourceChain?.r1ChainMatchesCurrent === true
      && sourceChain?.terminalMatchesCurrent === true
      && cursor === sourceChain.currentSha256;
  }
  const meaningChange = transitions.find((entry) => entry.meaningChange === 'PDP2_DEFINITION_CHANGE_LIMITED_TO_MDC30_C22_DELIVERY_ACK_EVIDENCE_BINDING')
    ?? transitions.at(-1);
  const latest = transitions.at(-1);
  return {
    path: sourcePath,
    predecessorSha256: transitions[0].predecessorSha256,
    observedSha256: latest.observedSha256,
    classification: meaningChange?.classification ?? latest.classification,
    meaningIdsChanged: meaningChange?.meaningIdsChanged ?? latest.meaningIdsChanged ?? [],
    meaningChange: meaningChange?.meaningChange ?? latest.meaningChange,
    transitionChainValid: connected,
    transitionHops: transitions,
  };
}

export function ownerStatusJoin(historicalExit, currentDigests, ownerReview, materialSourceSetFingerprint, { pdp2CurrentCutOptions = {} } = {}) {
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
  const p2Impact = pdp2CurrentCutImpact(historicalExit, currentDigests, pdp2CurrentCutOptions);
  const allChanges = [...ownerChanges, ...(supplement.valid ? [{
    path: supplement.path, recordedSha256: supplement.predecessorSha256,
    observedSha256: supplement.currentSha256,
    ownerMaterialityClassification: 'PDP3_STATUS_GUARD_ONLY_NO_PDP2_MEANING_CHANGE',
    meaningIdsChangedAtReviewedCut: [], requiresFreshCurrentness: true, transitionOnly: true,
  }] : []), ...(p2Impact.scopedImpactValid ? p2Impact.scopedChangedPaths.map((sourcePath) => {
    const delta = legacyScopedTransitionSummary(p2Impact, sourcePath);
    return {
      path: sourcePath,
      recordedSha256: delta?.predecessorSha256 ?? null,
      observedSha256: delta?.observedSha256 ?? null,
      ownerMaterialityClassification: delta?.classification ?? null,
      meaningIdsChangedAtReviewedCut: delta?.meaningIdsChanged ?? [],
      meaningPhaseReviewed: 'PDP-2',
      meaningChange: delta?.meaningChange,
      requiresFreshCurrentness: true,
      transitionOnly: true,
      transitionChainValid: delta?.transitionChainValid === true,
      transitionHops: delta?.transitionHops ?? [],
    };
  }) : []), ...(p2Impact.scopedImpactValid ? (p2Impact.supplementalSourceWork ?? []).map((work) => ({
    path: work.path,
    recordedSha256: work.predecessorSha256,
    observedSha256: work.observedSha256,
    ownerMaterialityClassification: work.classification,
    meaningIdsChangedAtReviewedCut: work.meaningIdsChanged,
    meaningPhaseReviewed: 'PDP-2',
    sourceDerivedWorkKind: work.workKind,
    requiresFreshCurrentness: true,
    transitionOnly: true,
  })) : []), ...(p2Impact.predecessorEvidenceRefresh?.valid ? p2Impact.predecessorEvidenceRefresh.paths.map((entry) => ({
    path: entry.path,
    recordedSha256: entry.predecessorSha256,
    observedSha256: entry.currentSha256,
    ownerMaterialityClassification: 'PDP1_PREDECESSOR_EVIDENCE_REFRESH_ONLY_NO_PDP2_MEANING_DISPOSITION',
    meaningIdsChangedAtReviewedCut: [],
    meaningPhaseReviewed: 'PDP-2',
    upstreamPhaseEvidence: 'PDP-1',
    requiresFreshCurrentness: true,
    transitionOnly: true,
  })) : []), ...(p2Impact.additionalSourceImpact?.valid ? (p2Impact.additionalSourceImpact.transitions ?? [p2Impact.additionalSourceImpact]).map((delta) => ({
    path: delta.path,
    recordedSha256: delta.predecessorSha256,
    observedSha256: delta.observedSha256,
    ownerMaterialityClassification: delta.classification,
    meaningIdsChangedAtReviewedCut: delta.meaningIdsChanged,
    meaningPhaseReviewed: 'PDP-2',
    sourceSelector: delta.sourceSelector,
    requiresFreshCurrentness: true,
    transitionOnly: true,
  })) : []), ...(p2Impact.r16ProjectionImpact?.valid ? p2Impact.r16ProjectionImpact.transitions.map((delta) => ({
    path: delta.path,
    recordedSha256: delta.predecessorSha256,
    observedSha256: delta.observedSha256,
    ownerMaterialityClassification: delta.classification,
    meaningIdsChangedAtReviewedCut: delta.meaningIdsChanged,
    meaningPhaseReviewed: 'PDP-2',
    requiresFreshCurrentness: true,
    transitionOnly: true,
    transitionChainValid: p2Impact.currentnessSourceChains?.valid === true
      && p2Impact.currentnessSourceChains.chains?.some((chain) => chain.path === delta.path
        && chain.r16ChainMatchesCurrent === true && chain.r16BaseMatchesR13 === true),
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
    transitionChainValid: entry.transitionOnly ? entry.transitionChainValid !== false : true,
    transitionHops: entry.transitionHops ?? [],
  }));
  const unapprovedChangedPaths = digestChanges.filter((sourcePath) => !changesByPath.has(sourcePath));
  const changeRecordsValid = ownerChanges.length === 4 && supplement.valid && p2Impact.valid
    && !ownerChanges.some((entry) => entry.path === supplement.path)
    && duplicateChangePaths.length === 0
    && allChanges.filter((entry) => entry.ownerMaterialityClassification === 'PDP1_PREDECESSOR_EVIDENCE_REFRESH_ONLY_NO_PDP2_MEANING_DISPOSITION')
      .every((entry) => entry.meaningPhaseReviewed === 'PDP-2' && entry.upstreamPhaseEvidence === 'PDP-1')
    && changedPathChecks.every((entry) => {
      const semanticReviewMatches = entry.classification === 'INTERNAL_SCOPED_SOURCE_SEMANTIC_REVIEW'
        && (p2Impact.additionalSourceImpact?.transitions ?? [p2Impact.additionalSourceImpact]).some((delta) => entry.path === delta.path
          && JSON.stringify(entry.meaningIdsChangedAtReviewedCut) === JSON.stringify(delta.meaningIdsChanged)
          && entry.sourceSelector === delta.sourceSelector)
        && entry.meaningIdsChangedAtReviewedCut.length > 0;
      const pdp2MeaningMatches = entry.meaningPhaseReviewed === 'PDP-2'
        && (p2Impact.scopedTransitions ?? []).some((delta) => entry.path === delta.path
          && entry.classification === delta.classification
          && JSON.stringify(entry.meaningIdsChangedAtReviewedCut) === JSON.stringify(delta.meaningIdsChanged)
          && entry.meaningIdsChangedAtReviewedCut.length > 0
          && delta.meaningChange === 'PDP2_DEFINITION_CHANGE_LIMITED_TO_MDC30_C22_DELIVERY_ACK_EVIDENCE_BINDING'
          && JSON.stringify(delta.meaningIdsChanged) === JSON.stringify(['MDC30-C-22']));
      const noMeaningChange = Array.isArray(entry.meaningIdsChangedAtReviewedCut) && entry.meaningIdsChangedAtReviewedCut.length === 0;
      const testOnlyValid = entry.classification !== 'PDP2_CURRENT_SOURCE_IMPACT_TEST_EVIDENCE_ONLY'
        || (entry.meaningIdsChangedAtReviewedCut.length === 0 && entry.meaningPhaseReviewed === 'PDP-2');
      return entry.digestsMatch && entry.transitionChainValid && entry.requiresFreshCurrentness && (semanticReviewMatches || pdp2MeaningMatches || noMeaningChange)
        && testOnlyValid
        && typeof entry.classification === 'string' && entry.classification.length > 0;
    });
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
    && digestChanges.length === 10 + (p2Impact.additionalSourceImpact?.valid ? (p2Impact.additionalSourceImpact.paths?.length ?? 1) : 0)
      + (p2Impact.r16ProjectionImpact?.valid ? p2Impact.r16ProjectionImpact.paths.length : 0)
    && allChanges.length === 13 + (p2Impact.additionalSourceImpact?.valid ? (p2Impact.additionalSourceImpact.paths?.length ?? 1) : 0)
      + (p2Impact.r16ProjectionImpact?.valid ? p2Impact.r16ProjectionImpact.paths.length : 0)
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

export function validatePdp1R27SourceMapBridge({
  r27Exit,
  r25Exit = readJson(PDP1_CURRENT_CUT_EXIT_R25_PATH),
  matrix = readJson(MATRIX_PATH),
  pdp1ExitPath = PDP1_CURRENT_CUT_EXIT_R27_PATH,
  pdp1ExitDigest = digestFile(PDP1_CURRENT_CUT_EXIT_R27_PATH),
  actualCurrentDigests = {},
  currentDigests = {},
} = {}) {
  const r25Digests = r25Exit?.sourceCurrentness?.sourceContentDigests ?? {};
  const r27Digests = r27Exit?.sourceCurrentness?.sourceContentDigests ?? {};
  const r25Paths = Object.keys(r25Digests).sort();
  const r27Paths = Object.keys(r27Digests).sort();
  const samePathSet = JSON.stringify(r25Paths) === JSON.stringify(r27Paths);
  const changedPaths = samePathSet
    ? r25Paths.filter((sourcePath) => r25Digests[sourcePath] !== r27Digests[sourcePath])
    : [...new Set([...r25Paths, ...r27Paths])].filter((sourcePath) => r25Digests[sourcePath] !== r27Digests[sourcePath]).sort();
  const currentPathsMatch = r27Paths.length === 329 && r27Paths.every((sourcePath) => {
    const liveDigest = actualCurrentDigests[sourcePath] ?? digestFile(sourcePath);
    return liveDigest === r27Digests[sourcePath]
      && (currentDigests[sourcePath] === undefined || currentDigests[sourcePath] === liveDigest);
  });
  const p0 = readJson(PDP0_CURRENT_CUT_EXIT_R12_PATH);
  const p0PredecessorValid = r27Exit?.predecessor?.phase === 'PDP-0'
    && r27Exit.predecessor.exitRef === PDP0_CURRENT_CUT_EXIT_R12_PATH
    && r27Exit.predecessor.exitDigest === PDP0_CURRENT_CUT_EXIT_R12_DIGEST
    && r27Exit.predecessor.materialSourceSetFingerprint === PDP0_CURRENT_CUT_EXIT_R12_FINGERPRINT
    && r27Exit.predecessor.cellCount === 50
    && r27Exit.predecessor.status === 'PASS'
    && r27Exit.predecessor.currentnessValid === true
    && r27Exit.predecessor.matrixCutMatches === true
    && p0.phase === 'PDP-0'
    && p0.phaseExit?.status === 'PASS'
    && p0.sourceCurrentness?.status === 'PASS'
    && p0.sourceCurrentness?.sourceCurrent === true
    && p0.developmentStatus?.status === 'DEV_COMPLETE'
    && p0.developmentStatus?.outstandingMeaningIds?.length === 0
    && p0.developmentStatus?.currentMaterialSourceSetFingerprint === PDP0_CURRENT_CUT_EXIT_R12_FINGERPRINT
    && digestFile(PDP0_CURRENT_CUT_EXIT_R12_PATH) === PDP0_CURRENT_CUT_EXIT_R12_DIGEST;
  const matrixMatches = matrix.currentCut?.pdp1PhaseExit === PDP1_CURRENT_CUT_EXIT_R27_PATH
    && matrix.currentCut?.pdp1CurrentnessObservation === `${PDP1_CURRENT_CUT_EXIT_R27_PATH}#sourceCurrentness`
    && matrix.currentCut?.pdp1PhaseExitRecordId === 'MEDIA-PDP1-CURRENTNESS-2026-10-14-CURRENT-CUT-R27'
    && matrix.currentCut?.pdp1MaterialSourceSetFingerprint === PDP1_CURRENT_CUT_EXIT_R27_FINGERPRINT;
  const r25Valid = r25Exit?.observationId === 'MEDIA-PDP1-CURRENTNESS-2026-10-14-CURRENT-CUT-R25'
    && digestFile(PDP1_CURRENT_CUT_EXIT_R25_PATH) === PDP1_CURRENT_CUT_EXIT_R25_DIGEST
    && r25Exit.sourceCurrentness?.status === 'PASS'
    && r25Exit.sourceCurrentness?.sourceCurrent === true
    && r25Exit.sourceCurrentness?.materialPathDenominator?.uniquePaths === 329
    && r25Exit.sourceCurrentness?.cells?.length === 50
    && r25Exit.developmentStatus?.status === 'DEV_COMPLETE'
    && r25Exit.developmentStatus?.outstandingMeaningIds?.length === 0;
  const r27Valid = pdp1ExitPath === PDP1_CURRENT_CUT_EXIT_R27_PATH
    && pdp1ExitDigest === PDP1_CURRENT_CUT_EXIT_R27_DIGEST
    && pdp1ExitDigest === digestFile(PDP1_CURRENT_CUT_EXIT_R27_PATH)
    && r27Exit?.schemaVersion === 'media.discovery-pdp1-currentness-observation.v1'
    && r27Exit?.observationId === 'MEDIA-PDP1-CURRENTNESS-2026-10-14-CURRENT-CUT-R27'
    && r27Exit?.phase === 'PDP-1'
    && r27Exit?.phaseExit?.status === 'PASS'
    && r27Exit?.phaseExit?.sourceCurrentness === 'PASS'
    && r27Exit?.phaseExit?.blockers?.length === 0
    && r27Exit?.sourceCurrentness?.status === 'PASS'
    && r27Exit?.sourceCurrentness?.sourceCurrent === true
    && r27Exit?.sourceCurrentness?.blockers?.length === 0
    && r27Exit?.sourceCurrentness?.materialSourceSetFingerprint === PDP1_CURRENT_CUT_EXIT_R27_FINGERPRINT
    && r27Exit?.sourceCurrentness?.materialPathDenominator?.uniquePaths === 329
    && r27Exit?.developmentStatus?.currentMaterialSourceSetFingerprint === PDP1_CURRENT_CUT_EXIT_R27_FINGERPRINT
    && r27Exit?.developmentStatus?.status === 'DEV_COMPLETE'
    && r27Exit?.developmentStatus?.outstandingMeaningIds?.length === 0
    && r27Exit?.sourceCurrentness?.cells?.length === 50
    && r27Exit.sourceCurrentness.cells.every((cell) => cell.sourceCurrentness === 'CURRENT' && (cell.blockers?.length ?? 0) === 0);
  const valid = r25Valid && r27Valid && p0PredecessorValid && matrixMatches
    && samePathSet && changedPaths.length === 0 && currentPathsMatch;
  return {
    valid,
    r25ReceiptValid: r25Valid,
    r27ReceiptValid: r27Valid,
    p0PredecessorValid,
    matrixMatches,
    samePathSet,
    changedPaths,
    currentPathsMatch,
    r25PathCount: r25Paths.length,
    r27PathCount: r27Paths.length,
    r25Fingerprint: r25Exit?.sourceCurrentness?.materialSourceSetFingerprint ?? null,
    r27Fingerprint: r27Exit?.sourceCurrentness?.materialSourceSetFingerprint ?? null,
  };
}

const PDP2_R17_TO_R30_AUTHORIZED_DELTAS = [
  {
    path: '.product-experience/source-manifest.yaml',
    predecessorSha256: 'sha256:76cdcbff690e6a3439580e0df6fc68dbf67e7105b38d8ad1c9c3e9cb8b36145a',
    observedSha256: 'sha256:3a5c7e92e7470ee11c8bd1779db31a27aba75461c16fef37785901544c0c29fd',
    classification: 'PDP1_SOURCE_INVENTORY_REFRESH_NO_ADDITIONAL_PDP2_MEANING',
  },
  {
    path: 'apps/media-experience-explorer/specification-artifacts.json',
    predecessorSha256: 'sha256:2aadeeffe41ea354f43a0824a069b1e21bfef5a31052e4dca8ceb68da9bcfc75',
    observedSha256: 'sha256:6cb5006b07b113dfa5cc1b41a78648be56e76910c60b60bd82f286c1593b8593',
    classification: 'PDP1_EXPLORER_SOURCE_INVENTORY_PROJECTION_REFRESH_NO_ADDITIONAL_PDP2_MEANING',
  },
  {
    path: 'scripts/record-media-discovery-pdp2-phase-exit.mjs',
    predecessorSha256: 'sha256:a137486babfa57a5ebbb8f1ebbd1b477915dfcf94da97aaf7211041b996daeae',
    observedSha256: 'sha256:86fb027d5edd49a1274f4c701add04db0121f01733f97feea620c989d91d68c5',
    classification: 'PDP2_CAPTURE_HARNESS_EXACT_PREDECESSOR_GUARD_NO_PRODUCT_MEANING',
  },
];

export function validatePdp1R30SourceMapBridge({
  r30Exit,
  r17Exit = readJson(PDP2_R17_PATH),
  p0Exit = readJson(PDP0_CURRENT_CUT_EXIT_R15_PATH),
  matrix = readJson(MATRIX_PATH),
  impactRecord = readJson(PDP2_R17_TO_R30_IMPACT_PATH),
  pdp1ExitPath = PDP1_CURRENT_CUT_EXIT_R30_PATH,
  pdp1ExitDigest = digestFile(PDP1_CURRENT_CUT_EXIT_R30_PATH),
  actualCurrentDigests = {},
  currentDigests = {},
} = {}) {
  const r17Digests = r17Exit?.sourceCurrentness?.sourceSetDigests?.sourceContentDigests ?? {};
  const r30Digests = r30Exit?.sourceCurrentness?.sourceContentDigests ?? {};
  const r17Paths = Object.keys(r17Digests).sort();
  const r30Paths = Object.keys(r30Digests).sort();
  const overlap = r30Paths.filter((sourcePath) => Object.hasOwn(r17Digests, sourcePath));
  const p1ChangedPaths = overlap.filter((sourcePath) => r17Digests[sourcePath] !== r30Digests[sourcePath]).sort();
  const changedPaths = r17Paths.filter((sourcePath) => {
    const liveDigest = actualCurrentDigests[sourcePath] ?? digestFile(sourcePath);
    return r17Digests[sourcePath] !== liveDigest;
  }).sort();
  const sourceDeltas = impactRecord?.sourceDeltas ?? [];
  const exactDeltaSet = sourceDeltas.length === PDP2_R17_TO_R30_AUTHORIZED_DELTAS.length
    && sourceDeltas.every((delta, index) => {
      const expected = PDP2_R17_TO_R30_AUTHORIZED_DELTAS[index];
      return delta?.path === expected.path
        && delta?.predecessorSha256 === expected.predecessorSha256
        && delta?.observedSha256 === expected.observedSha256
        && delta?.classification === expected.classification
        && delta?.phase === 'PDP-2'
        && delta?.meaningChange === 'NO_ADDITIONAL_PDP2_MEANING'
        && Array.isArray(delta?.meaningIdsChanged) && delta.meaningIdsChanged.length === 0
        && delta?.requiresFreshCurrentness === true;
    });
  const expectedP1ChangedPaths = PDP2_R17_TO_R30_AUTHORIZED_DELTAS
    .filter(({ path: sourcePath }) => Object.hasOwn(r30Digests, sourcePath))
    .map(({ path: sourcePath }) => sourcePath).sort();
  const exactChangedPaths = JSON.stringify(changedPaths)
    === JSON.stringify(PDP2_R17_TO_R30_AUTHORIZED_DELTAS.map(({ path: sourcePath }) => sourcePath).sort());
  const exactP1ChangedPaths = JSON.stringify(p1ChangedPaths) === JSON.stringify(expectedP1ChangedPaths);
  const r17LivePinsMatch = r17Paths.length === 405 && r17Paths.every((sourcePath) => {
    const liveDigest = actualCurrentDigests[sourcePath] ?? digestFile(sourcePath);
    return (currentDigests[sourcePath] === undefined || currentDigests[sourcePath] === liveDigest);
  });
  const livePinsMatch = r30Paths.length === 329 && r30Paths.every((sourcePath) => {
    const liveDigest = actualCurrentDigests[sourcePath] ?? digestFile(sourcePath);
    return liveDigest === r30Digests[sourcePath]
      && (currentDigests[sourcePath] === undefined || currentDigests[sourcePath] === liveDigest);
  });
  const transitionsMatchSources = exactDeltaSet && sourceDeltas.every((delta) => {
    const liveDigest = actualCurrentDigests[delta.path] ?? digestFile(delta.path);
    return r17Digests[delta.path] === delta.predecessorSha256
      && (!Object.hasOwn(r30Digests, delta.path) || r30Digests[delta.path] === delta.observedSha256)
      && liveDigest === delta.observedSha256
      && (currentDigests[delta.path] === undefined || currentDigests[delta.path] === liveDigest);
  });
  const r17Valid = r17Exit?.observationId === 'MEDIA-PDP2-CURRENTNESS-2026-10-14-CURRENT-CUT-R17'
    && digestFile(PDP2_R17_PATH) === PDP2_R17_DIGEST
    && r17Exit?.sourceCurrentness?.status === 'PASS'
    && r17Exit?.sourceCurrentness?.sourceCurrent === true
    && r17Exit?.sourceCurrentness?.materialSourceSetFingerprint === PDP2_R17_FINGERPRINT
    && r17Exit?.sourceCurrentness?.sourceSetDigests?.sourcePathCount === 405
    && r17Exit?.sourceCurrentness?.cells?.length === 50
    && r17Paths.length === 405;
  const p0Valid = p0Exit?.phase === 'PDP-0'
    && p0Exit?.phaseExit?.status === 'PASS'
    && p0Exit?.sourceCurrentness?.status === 'PASS'
    && p0Exit?.sourceCurrentness?.sourceCurrent === true
    && p0Exit?.sourceCurrentness?.materialSourceSetFingerprint === PDP0_CURRENT_CUT_EXIT_R15_FINGERPRINT
    && digestFile(PDP0_CURRENT_CUT_EXIT_R15_PATH) === PDP0_CURRENT_CUT_EXIT_R15_DIGEST;
  const p1Valid = pdp1ExitPath === PDP1_CURRENT_CUT_EXIT_R30_PATH
    && pdp1ExitDigest === PDP1_CURRENT_CUT_EXIT_R30_DIGEST
    && pdp1ExitDigest === digestFile(PDP1_CURRENT_CUT_EXIT_R30_PATH)
    && r30Exit?.schemaVersion === 'media.discovery-pdp1-currentness-observation.v1'
    && r30Exit?.observationId === 'MEDIA-PDP1-CURRENTNESS-2026-10-15-CURRENT-CUT-R30'
    && r30Exit?.phase === 'PDP-1'
    && r30Exit?.phaseExit?.status === 'PASS'
    && r30Exit?.phaseExit?.sourceCurrentness === 'PASS'
    && r30Exit?.sourceCurrentness?.status === 'PASS'
    && r30Exit?.sourceCurrentness?.sourceCurrent === true
    && r30Exit?.sourceCurrentness?.materialSourceSetFingerprint === PDP1_CURRENT_CUT_EXIT_R30_FINGERPRINT
    && r30Exit?.sourceCurrentness?.materialPathDenominator?.uniquePaths === 329
    && r30Exit?.sourceCurrentness?.cells?.length === 50
    && r30Exit?.sourceCurrentness?.cells?.every((cell) => cell.sourceCurrentness === 'CURRENT' && (cell.blockers?.length ?? 0) === 0)
    && r30Exit?.developmentStatus?.status === 'DEV_COMPLETE'
    && r30Exit?.developmentStatus?.currentMaterialSourceSetFingerprint === PDP1_CURRENT_CUT_EXIT_R30_FINGERPRINT
    && r30Exit?.developmentStatus?.outstandingMeaningIds?.length === 0
    && r30Exit?.predecessor?.phase === 'PDP-0'
    && r30Exit?.predecessor?.exitRef === PDP0_CURRENT_CUT_EXIT_R15_PATH
    && r30Exit?.predecessor?.exitDigest === PDP0_CURRENT_CUT_EXIT_R15_DIGEST
    && r30Exit?.predecessor?.materialSourceSetFingerprint === PDP0_CURRENT_CUT_EXIT_R15_FINGERPRINT
    && r30Exit?.predecessor?.cellCount === 50
    && r30Exit?.predecessor?.status === 'PASS';
  const matrixMatches = matrix.currentCut?.phaseExit === PDP0_CURRENT_CUT_EXIT_R15_PATH
    && matrix.currentCut?.materialSourceSetFingerprint === PDP0_CURRENT_CUT_EXIT_R15_FINGERPRINT
    && matrix.currentCut?.pdp1PhaseExit === PDP1_CURRENT_CUT_EXIT_R30_PATH
    && matrix.currentCut?.pdp1CurrentnessObservation === `${PDP1_CURRENT_CUT_EXIT_R30_PATH}#sourceCurrentness`
    && matrix.currentCut?.pdp1PhaseExitRecordId === 'MEDIA-PDP1-CURRENTNESS-2026-10-15-CURRENT-CUT-R30'
    && matrix.currentCut?.pdp1MaterialSourceSetFingerprint === PDP1_CURRENT_CUT_EXIT_R30_FINGERPRINT;
  const impactRecordValid = impactRecord?.schemaVersion === 'media.discovery-pdp2-successor-source-impact.v1'
    && impactRecord?.recordId === 'MEDIA-DISCOVERY-PDP2-R17-TO-R30-SOURCE-IMPACT-2026-10-15-R1'
    && impactRecord?.campaign?.repository === 'samujjwal/ghatana-media'
    && impactRecord?.campaign?.stage === 'DISCOVERY'
    && impactRecord?.campaign?.phase === 'PDP-2'
    && impactRecord?.campaign?.scope === 'Only the two PDP-1 inventory/projection transitions and the one PDP-2 capture-harness transition listed below, within the existing 405-path, 50-cell source set.'
    && impactRecord?.predecessorCut?.phase === 'PDP-2'
    && impactRecord?.predecessorCut?.receiptRef === PDP2_R17_PATH
    && impactRecord?.predecessorCut?.receiptSha256 === PDP2_R17_DIGEST
    && impactRecord?.predecessorCut?.sourceFingerprint === PDP2_R17_FINGERPRINT
    && impactRecord?.predecessorCut?.materialPathCount === 405
    && impactRecord?.predecessorCut?.cellCount === 50
    && impactRecord?.successorPredecessors?.pdp1?.receiptRef === PDP1_CURRENT_CUT_EXIT_R30_PATH
    && impactRecord?.successorPredecessors?.pdp1?.phase === 'PDP-1'
    && impactRecord?.successorPredecessors?.pdp1?.receiptSha256 === PDP1_CURRENT_CUT_EXIT_R30_DIGEST
    && impactRecord?.successorPredecessors?.pdp1?.sourceFingerprint === PDP1_CURRENT_CUT_EXIT_R30_FINGERPRINT
    && impactRecord?.successorPredecessors?.pdp1?.status === 'PASS'
    && impactRecord?.successorPredecessors?.pdp1?.sourceCurrent === true
    && impactRecord?.successorPredecessors?.pdp1?.cellCount === 50
    && impactRecord?.successorPredecessors?.pdp1?.materialPathCount === 329
    && impactRecord?.successorPredecessors?.pdp1?.developmentStatus === 'DEV_COMPLETE'
    && impactRecord?.successorPredecessors?.pdp1?.outstandingMeaningIds === 0
    && impactRecord?.successorPredecessors?.pdp1?.exactCutOwnerAcceptance === 'NOT_RECORDED'
    && impactRecord?.successorPredecessors?.pdp0?.receiptRef === PDP0_CURRENT_CUT_EXIT_R15_PATH
    && impactRecord?.successorPredecessors?.pdp0?.phase === 'PDP-0'
    && impactRecord?.successorPredecessors?.pdp0?.receiptSha256 === PDP0_CURRENT_CUT_EXIT_R15_DIGEST
    && impactRecord?.successorPredecessors?.pdp0?.sourceFingerprint === PDP0_CURRENT_CUT_EXIT_R15_FINGERPRINT
    && impactRecord?.successorPredecessors?.pdp0?.status === 'PASS'
    && impactRecord?.successorPredecessors?.pdp0?.sourceCurrent === true
    && impactRecord?.successorPredecessors?.pdp0?.cellCount === 50
    && impactRecord?.successorPredecessors?.pdp0?.materialPathCount === 146
    && exactDeltaSet
    && impactRecord?.authority?.userAuthorization?.status === 'AUTHORIZED'
    && impactRecord?.authority?.userAuthorization?.authorizedBy === 'USER'
    && impactRecord?.authority?.userAuthorization?.exactResponse === 'I authorize all appropriate recommended task you have - not need to ask for my permission'
    && impactRecord?.authority?.sourceTransitionAuthorization?.authorizedBy === 'USER'
    && JSON.stringify(impactRecord?.authority?.sourceTransitionAuthorization?.authorizedTransitions) === JSON.stringify(PDP2_R17_TO_R30_AUTHORIZED_DELTAS.map(({ path: sourcePath, predecessorSha256, observedSha256 }) => ({ path: sourcePath, predecessorSha256, observedSha256 })))
    && impactRecord?.decision?.pdp2MeaningDisposition === 'NO_ADDITIONAL_PDP2_MEANING'
    && impactRecord?.decision?.ownerAcceptance === 'NOT_CLAIMED'
    && impactRecord?.decision?.independentAcceptance === 'NOT_CLAIMED'
    && impactRecord?.decision?.lifecycleClosure === 'NOT_ENTERED'
    && impactRecord?.decision?.runtimeAdmission === 'NOT_ADMITTED'
    && impactRecord?.decision?.delivery === 'NOT_AUTHORIZED'
    && impactRecord?.decision?.release === 'NOT_AUTHORIZED'
    && impactRecord?.authority?.humanIndependentSignatureProvided === false
    && impactRecord?.authority?.externalContractOwnerAcceptanceProvided === false
    && impactRecord?.authority?.nativeLifecycleReceiptProvided === false;
  const valid = r17Valid && p0Valid && p1Valid && matrixMatches && impactRecordValid
    && exactChangedPaths && exactP1ChangedPaths && transitionsMatchSources && r17LivePinsMatch && livePinsMatch;
  return {
    valid, r17ReceiptValid: r17Valid, p0PredecessorValid: p0Valid, r30ReceiptValid: p1Valid,
    matrixMatches, impactRecordValid, exactDeltaSet, exactChangedPaths, exactP1ChangedPaths,
    transitionsMatchSources, r17LivePinsMatch, livePinsMatch,
    r17PathCount: r17Paths.length, r30PathCount: r30Paths.length, overlapPathCount: overlap.length,
    changedPaths, changedPathCount: changedPaths.length, p1ChangedPaths, p1ChangedPathCount: p1ChangedPaths.length,
  };
}

export function validatePdp2R17SuccessorImpact({
  predecessor,
  currentDigests = {},
  actualCurrentDigests = {},
  r30Exit = readJson(PDP1_CURRENT_CUT_EXIT_R30_PATH),
  matrix = readJson(MATRIX_PATH),
  impactRecord = readJson(PDP2_R17_TO_R30_IMPACT_PATH),
} = {}) {
  const predecessorDigests = predecessor?.sourceCurrentness?.sourceSetDigests?.sourceContentDigests ?? {};
  const paths = Object.keys(predecessorDigests).sort();
  const currentPaths = Object.keys(currentDigests).sort();
  const changedPaths = paths.filter((sourcePath) => {
    const liveDigest = actualCurrentDigests[sourcePath] ?? digestFile(sourcePath);
    return predecessorDigests[sourcePath] !== liveDigest;
  });
  const bridge = validatePdp1R30SourceMapBridge({
    r30Exit, r17Exit: predecessor, matrix, impactRecord,
    actualCurrentDigests, currentDigests,
  });
  const transitions = (impactRecord?.sourceDeltas ?? []).map((delta) => ({
    path: delta.path,
    predecessorSha256: delta.predecessorSha256,
    observedSha256: delta.observedSha256,
    classification: delta.classification,
    phase: delta.phase,
    meaningChange: delta.meaningChange,
    meaningIdsChanged: delta.meaningIdsChanged,
  }));
  const uniqueTransitionPaths = new Set(transitions.map(({ path: sourcePath }) => sourcePath));
  const valid = bridge.valid
    && predecessor?.observationId === 'MEDIA-PDP2-CURRENTNESS-2026-10-14-CURRENT-CUT-R17'
    && digestFile(PDP2_R17_PATH) === PDP2_R17_DIGEST
    && paths.length === 405
    && currentPaths.length === 405
    && JSON.stringify(paths) === JSON.stringify(currentPaths)
    && changedPaths.length === 3
    && uniqueTransitionPaths.size === 3
    && JSON.stringify(changedPaths) === JSON.stringify(transitions.map(({ path: sourcePath }) => sourcePath).sort())
    && transitions.every((transition) => predecessorDigests[transition.path] === transition.predecessorSha256
      && currentDigests[transition.path] === transition.observedSha256
      && (actualCurrentDigests[transition.path] ?? digestFile(transition.path)) === transition.observedSha256);
  return {
    valid,
    classification: 'PDP2_R17_TO_R30_EXACT_SOURCE_SUCCESSOR_IMPACT_NO_ADDITIONAL_MEANING',
    predecessorRef: PDP2_R17_PATH,
    predecessorDigest: PDP2_R17_DIGEST,
    materialPathCount: paths.length,
    changedPathCount: changedPaths.length,
    changedPaths,
    transitions,
    r30SourceMapBridge: bridge,
    ownerAcceptance: 'NOT_CLAIMED',
    independentReview: 'NOT_CLAIMED',
    lifecycleClosure: 'NOT_ENTERED',
    runtimeAdmission: 'NOT_ADMITTED',
    delivery: 'NOT_AUTHORIZED',
    release: 'NOT_AUTHORIZED',
  };
}

export function validatePdp1Predecessor(exit, matrix, p1ExitPath, pairedP0, {
  r17Exit = readJson(PDP2_R17_PATH),
  r30SourceImpact = readJson(PDP2_R17_TO_R30_IMPACT_PATH),
  actualCurrentDigests = {},
  currentDigests = {},
} = {}) {
  const cells = exit.sourceCurrentness?.cells ?? [];
  const r27Bridge = p1ExitPath === PDP1_CURRENT_CUT_EXIT_R27_PATH
    ? validatePdp1R27SourceMapBridge({ r27Exit: exit, matrix, pdp1ExitPath: p1ExitPath })
    : null;
  const r27Bound = r27Bridge?.valid === true;
  const r30Bridge = p1ExitPath === PDP1_CURRENT_CUT_EXIT_R30_PATH
    ? validatePdp1R30SourceMapBridge({ r30Exit: exit, r17Exit, matrix, impactRecord: r30SourceImpact,
      pdp1ExitPath: p1ExitPath, actualCurrentDigests, currentDigests })
    : null;
  const r30Bound = r30Bridge?.valid === true;
  const r25Bound = p1ExitPath === PDP1_CURRENT_CUT_EXIT_R25_PATH
    && exit.observationId === 'MEDIA-PDP1-CURRENTNESS-2026-10-14-CURRENT-CUT-R25'
    && digestFile(PDP1_CURRENT_CUT_EXIT_R25_PATH) === 'sha256:914390414ee87982efa786e1edf2a8adb0bc3e5d8b5c609776a7f0c65f679e1e'
    && exit.sourceCurrentness?.materialSourceSetFingerprint === 'sha256:249b4d300e4103406335b4c395da888e487fa898d08bae91f09d7fa07a1e9d0e'
    && matrix.currentCut?.pdp1PhaseExit === p1ExitPath
    && matrix.currentCut?.pdp1CurrentnessObservation === `${p1ExitPath}#sourceCurrentness`
    && matrix.currentCut?.pdp1MaterialSourceSetFingerprint === exit.developmentStatus?.currentMaterialSourceSetFingerprint;
  const r22Bound = p1ExitPath === PDP1_CURRENT_CUT_EXIT_R22_PATH
    && exit.observationId === 'MEDIA-PDP1-CURRENTNESS-2026-10-14-CURRENT-CUT-R22'
    && digestFile(PDP1_CURRENT_CUT_EXIT_R22_PATH) === 'sha256:bb448dc45d3db788ef16802f8a92dc8054a6fc6aaa27f047c42b4f6c91feb303'
    && exit.sourceCurrentness?.materialSourceSetFingerprint === 'sha256:66bbc971734f92ae8f51446582f4a1118704168acac3c0e33783efbb208a5a0b';
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
    && (r22Bound || r25Bound || r27Bound || r30Bound || (matrix.currentCut?.pdp1PhaseExit === p1ExitPath
      && matrix.currentCut?.pdp1CurrentnessObservation === `${p1ExitPath}#sourceCurrentness`
      && matrix.currentCut?.pdp1MaterialSourceSetFingerprint === exit.developmentStatus.currentMaterialSourceSetFingerprint));
  return {
    valid,
    phase: 'PDP-1',
    exitRef: p1ExitPath,
    exitDigest: digestFile(p1ExitPath),
    materialSourceSetFingerprint: exit.developmentStatus?.currentMaterialSourceSetFingerprint ?? null,
    observationId: exit.observationId,
    cellCount: cells.length,
    r27SourceMapBridge: r27Bridge,
    r30SourceMapBridge: r30Bridge,
    status: valid ? 'PASS' : 'FAIL',
  };
}

export function validatePdp2R9HistoricalCheckpoint(r9Checkpoint) {
  const historicalR2 = readJson(HISTORICAL_P2_EXIT_PATH);
  const r2Digests = historicalR2.sourceCurrentness?.sourceSetDigests?.sourceContentDigests ?? {};
  const r9Digests = r9Checkpoint?.sourceCurrentness?.sourceSetDigests?.sourceContentDigests ?? {};
  const r2Paths = Object.keys(r2Digests).sort();
  const r9Paths = Object.keys(r9Digests).sort();
  const r2Set = new Set(r2Paths);
  const r9Set = new Set(r9Paths);
  const missingPaths = r2Paths.filter((sourcePath) => !r9Set.has(sourcePath));
  const additionalPaths = r9Paths.filter((sourcePath) => !r2Set.has(sourcePath));
  const changedPaths = r2Paths.filter((sourcePath) => r9Set.has(sourcePath) && r2Digests[sourcePath] !== r9Digests[sourcePath]);
  const r9Join = r9Checkpoint?.ownerStatusJoin;
  const historicalTransitions = r9Join?.pdp2ScopedImpact?.scopedTransitions ?? [];
  const decisionLogPath = '.product-experience/decision-log.md';
  const decisionLogTransition = historicalTransitions.find((entry) => entry.path === decisionLogPath);
  const decisionLogTupleValid = decisionLogTransition?.predecessorSha256 === 'sha256:cdea20d6fa57cc4d7bbea866d911c03685eeb74e0bfdb4e0a5df0c90ded56db4'
    && decisionLogTransition?.observedSha256 === 'sha256:9831b03ecd3f30d2cbfd7a1db62d934035ba20cf1482bb5e621d166eacdb9b4c'
    && decisionLogTransition?.classification === 'PDP1_DELEGATED_DEFINITION_DECISION_LOG_PREDECESSOR_REFRESH'
    && r2Digests[decisionLogPath] === decisionLogTransition.predecessorSha256
    && r9Digests[decisionLogPath] === decisionLogTransition.observedSha256;
  const reviewedPathChecks = r9Join?.changedPathChecks ?? [];
  const reviewedChangedPathSet = new Set(reviewedPathChecks.map((entry) => entry.path));
  const valid = r9Checkpoint?.observationId === 'MEDIA-PDP2-CURRENTNESS-CURRENT-CUT-R9'
    && r9Checkpoint?.phase === 'PDP-2'
    && r9Checkpoint?.sourceCurrentness?.status === 'PASS'
    && r9Checkpoint?.sourceCurrentness?.sourceCurrent === true
    && r9Checkpoint?.sourceCurrentness?.materialSourceSetFingerprint === 'sha256:318b301bfb6ee4a4d27f141f8137930c2aa1353dc6b6e8d519ac015bc1ec1eda'
    && r9Checkpoint?.sourceCurrentness?.sourceSetDigests?.sourcePathCount === 405
    && r9Paths.length === 405 && r2Paths.length === 405
    && JSON.stringify(r2Paths) === JSON.stringify(r9Paths)
    && missingPaths.length === 0 && additionalPaths.length === 0
    && changedPaths.length === 10
    && digestFile(PDP2_CURRENT_CUT_PREDECESSOR_R9_PATH) === PDP2_CURRENT_CUT_PREDECESSOR_R9_DIGEST
    && r9Join?.status === 'PASS'
    && r9Join?.historicalExitRef === HISTORICAL_P2_EXIT_PATH
    && r9Join?.historicalExitDigest === digestFile(HISTORICAL_P2_EXIT_PATH)
    && r9Join?.historicalMaterialSourceSetFingerprint === historicalR2.sourceCurrentness?.materialSourceSetFingerprint
    && r9Join?.historicalPathCount === 405 && r9Join?.currentPathCount === 405
    && r9Join?.missingPathCount === 0 && r9Join?.additionalPathCount === 0
    && r9Join?.changedPathCount === 10 && r9Join?.uniqueChangedPathCount === 10
    && r9Join?.expectedChangedPathCount === 10 && r9Join?.unapprovedChangedPathCount === 0
    && changedPaths.every((sourcePath) => reviewedChangedPathSet.has(sourcePath))
    && decisionLogTupleValid;
  return {
    valid,
    ref: PDP2_CURRENT_CUT_PREDECESSOR_R9_PATH,
    digest: digestFile(PDP2_CURRENT_CUT_PREDECESSOR_R9_PATH),
    historicalExitRef: HISTORICAL_P2_EXIT_PATH,
    historicalExitDigest: digestFile(HISTORICAL_P2_EXIT_PATH),
    historicalJoinStatus: r9Join?.status ?? 'UNKNOWN',
    historicalPathCount: r2Paths.length,
    checkpointPathCount: r9Paths.length,
    historicalChangedPathCount: changedPaths.length,
    missingPathCount: missingPaths.length,
    additionalPathCount: additionalPaths.length,
    decisionLogCheckpoint: {
      path: decisionLogPath,
      predecessorSha256: decisionLogTransition?.predecessorSha256 ?? null,
      observedSha256: decisionLogTransition?.observedSha256 ?? null,
      classification: decisionLogTransition?.classification ?? null,
      valid: decisionLogTupleValid,
    },
  };
}

export function composePdp2CurrentnessSourceChains({
  r9Checkpoint, r9ReceiptPath, r9ReceiptDigest,
  r13Checkpoint, r13ReceiptPath, r13ReceiptDigest,
  historicalR5Impact, additionalSourceImpact, r16ProjectionImpact,
  r16Checkpoint = readJson(PDP2_R16_RECEIPT_PATH), currentDigests,
}) {
  const r9Digests = r9Checkpoint?.sourceCurrentness?.sourceSetDigests?.sourceContentDigests ?? {};
  const r13Digests = r13Checkpoint?.sourceCurrentness?.sourceSetDigests?.sourceContentDigests ?? {};
  const r16Digests = r16Checkpoint?.sourceCurrentness?.sourceSetDigests?.sourceContentDigests ?? {};
  const r9Paths = Object.keys(r9Digests).sort();
  const r13Paths = Object.keys(r13Digests).sort();
  const currentPaths = Object.keys(currentDigests ?? {}).sort();
  const samePathSets = JSON.stringify(r9Paths) === JSON.stringify(r13Paths) && JSON.stringify(r13Paths) === JSON.stringify(currentPaths);
  const r9ReceiptValid = r9ReceiptPath === PDP2_CURRENT_CUT_PREDECESSOR_R9_PATH
    && r9ReceiptDigest === PDP2_CURRENT_CUT_PREDECESSOR_R9_DIGEST
    && r9ReceiptDigest === digestFile(PDP2_CURRENT_CUT_PREDECESSOR_R9_PATH)
    && r9Checkpoint?.observationId === 'MEDIA-PDP2-CURRENTNESS-CURRENT-CUT-R9';
  const r13ReceiptValid = r13ReceiptPath === PDP2_CURRENT_CUT_PREDECESSOR_R13_PATH
    && r13ReceiptDigest === 'sha256:e594080519407b78027389e4b9e09669663de6451cedeb2e17dd9db8c5cfcaae'
    && r13ReceiptDigest === digestFile(PDP2_CURRENT_CUT_PREDECESSOR_R13_PATH)
    && r13Checkpoint?.observationId === 'MEDIA-PDP2-CURRENTNESS-2026-10-14-CURRENT-CUT-R13';
  const r5ImpactValid = historicalR5Impact?.valid === true
    && historicalR5Impact?.transitionsValid === true
    && historicalR5Impact?.supplementalSourceWorkValid === true;
  const r1ImpactValid = additionalSourceImpact?.valid === true
    && additionalSourceImpact?.paths?.length === 3;
  const r16ImpactRequired = r16ProjectionImpact !== undefined && r16ProjectionImpact !== null;
  const r16ImpactValid = !r16ImpactRequired || (r16ProjectionImpact?.valid === true
    && r16ProjectionImpact?.paths?.length === 1
    && r16Checkpoint?.observationId === 'MEDIA-PDP2-CURRENTNESS-R16'
    && digestFile(PDP2_R16_RECEIPT_PATH) === PDP2_R16_RECEIPT_DIGEST
    && Object.keys(r16Digests).length === 405);
  const r5Hops = historicalR5Impact?.scopedTransitions ?? [];
  const sourceWorkHops = (historicalR5Impact?.supplementalSourceWork ?? []).map((work) => ({
    ...work, transitionKind: 'R5_SUPPLEMENTAL_SOURCE_WORK',
  }));
  const r1Hops = additionalSourceImpact?.transitions ?? [];
  const r16Hops = r16ProjectionImpact?.transitions ?? [];
  const grouped = new Map();
  for (const hop of [...r5Hops, ...sourceWorkHops, ...r1Hops, ...r16Hops]) {
    if (!grouped.has(hop.path)) grouped.set(hop.path, { r5: [], r1: [], r16: [] });
    const group = grouped.get(hop.path);
    if (hop.transitionKind === 'R5_SUPPLEMENTAL_SOURCE_WORK' || r5Hops.includes(hop)) group.r5.push(hop);
    else if (r16Hops.includes(hop)) group.r16.push(hop);
    else group.r1.push(hop);
  }
  const changedPaths = r9Paths.filter((sourcePath) => r9Digests[sourcePath] !== currentDigests?.[sourcePath]);
  const chainResults = [];
  let allTransitionsConsumed = true;
  for (const sourcePath of [...grouped.keys()].sort()) {
    const group = grouped.get(sourcePath);
    const followChain = (startDigest, endDigest, candidates) => {
      let cursor = startDigest;
      const ordered = [];
      for (const hop of candidates) {
        if (hop.predecessorSha256 !== cursor) return { valid: false, ordered, unused: candidates.slice(ordered.length) };
        ordered.push(hop);
        cursor = hop.observedSha256;
      }
      return { valid: cursor === endDigest, ordered, unused: [] };
    };
    const r9ToR13 = followChain(r9Digests[sourcePath], r13Digests[sourcePath], group.r5);
    const r13ToLive = followChain(r13Digests[sourcePath], currentDigests?.[sourcePath], group.r1);
    const r16BaseMatchesR13 = group.r16.length === 0
      || (r16Digests[sourcePath] === r9Digests[sourcePath] && r16Digests[sourcePath] === r13Digests[sourcePath]);
    const r16ToLive = followChain(r16Digests[sourcePath], currentDigests?.[sourcePath], group.r16);
    const terminalChainValid = group.r16.length > 0 ? r16BaseMatchesR13 && r16ToLive.valid : r13ToLive.valid;
    const terminal = group.r16.length > 0
      ? (r16ToLive.ordered.at(-1)?.observedSha256 ?? r16Digests[sourcePath])
      : (r13ToLive.ordered.at(-1)?.observedSha256 ?? r13Digests[sourcePath]);
    const matchesCurrent = terminal === currentDigests?.[sourcePath];
    allTransitionsConsumed &&= r9ToR13.valid && terminalChainValid;
    chainResults.push({
      path: sourcePath,
      r9Sha256: r9Digests[sourcePath] ?? null,
      r13Sha256: r13Digests[sourcePath] ?? null,
      currentSha256: currentDigests?.[sourcePath] ?? null,
      r5HopCount: r9ToR13.ordered.length,
      r1HopCount: r13ToLive.ordered.length,
      r16HopCount: r16ToLive.ordered.length,
      r5ChainMatchesR13: r9ToR13.valid,
      r1ChainMatchesCurrent: group.r16.length > 0 ? r16BaseMatchesR13 && r16ToLive.valid : r13ToLive.valid,
      r16ChainMatchesCurrent: group.r16.length === 0 || (r16BaseMatchesR13 && r16ToLive.valid),
      r16BaseMatchesR13,
      terminalSha256: terminal,
      terminalMatchesCurrent: matchesCurrent,
      r5Hops: r9ToR13.ordered,
      r1Hops: r13ToLive.ordered,
      r16Hops: r16ToLive.ordered,
    });
  }
  const unaccountedChangedPaths = changedPaths.filter((sourcePath) => !grouped.has(sourcePath));
  const staleAuthorizationPaths = [...grouped.keys()].filter((sourcePath) => !changedPaths.includes(sourcePath));
  const valid = r9ReceiptValid && r13ReceiptValid && r5ImpactValid && r1ImpactValid && r16ImpactValid
    && samePathSets && r9Paths.length === 405 && r13Paths.length === 405 && currentPaths.length === 405
    && changedPaths.length === (r16ImpactRequired ? 12 : 11) && grouped.size === changedPaths.length
    && allTransitionsConsumed && unaccountedChangedPaths.length === 0 && staleAuthorizationPaths.length === 0
    && chainResults.every((chain) => chain.r5ChainMatchesR13 && chain.r1ChainMatchesCurrent && chain.r16ChainMatchesCurrent && chain.terminalMatchesCurrent);
  return {
    valid, r9ReceiptValid, r13ReceiptValid, r5ImpactValid, r1ImpactValid, r16ImpactValid,
    materialPathCount: r9Paths.length, changedPathCount: changedPaths.length,
    uniqueTransitionPathCount: grouped.size, allTransitionsConsumed,
    r16PathCount: Object.keys(r16Digests).length,
    unaccountedChangedPaths, staleAuthorizationPaths,
    chains: chainResults,
  };
}

export function currentnessOwnerStatusJoin(historicalExit, currentDigests, ownerReview, materialSourceSetFingerprint, {
  r9Checkpoint = readJson(PDP2_CURRENT_CUT_PREDECESSOR_R9_PATH),
  pdp2CurrentCutOptions = {},
  pdp1ExitPath = PDP1_CURRENT_CUT_EXIT_PATH,
  p2PredecessorPath = PDP2_CURRENT_CUT_PREDECESSOR_PATH,
} = {}) {
  if (pdp1ExitPath === PDP1_CURRENT_CUT_EXIT_R30_PATH) {
    const selectedPredecessor = readJson(p2PredecessorPath);
    const predecessorDigests = selectedPredecessor?.sourceCurrentness?.sourceSetDigests?.sourceContentDigests ?? {};
    const predecessorPaths = Object.keys(predecessorDigests).sort();
    const currentPaths = Object.keys(currentDigests ?? {}).sort();
    const predecessorPathSet = new Set(predecessorPaths);
    const currentPathSet = new Set(currentPaths);
    const missingPaths = predecessorPaths.filter((sourcePath) => !currentPathSet.has(sourcePath));
    const additionalPaths = currentPaths.filter((sourcePath) => !predecessorPathSet.has(sourcePath));
    const changedPaths = predecessorPaths.filter((sourcePath) => currentPathSet.has(sourcePath)
      && predecessorDigests[sourcePath] !== currentDigests[sourcePath]);
    const p2Impact = pdp2CurrentCutImpact(selectedPredecessor, currentDigests, {
      ...pdp2CurrentCutOptions,
      pdp1ExitPath,
    });
    const r17Impact = p2Impact.r17ToR30SourceImpact ?? {};
    const expectedChangedPaths = [...(r17Impact.changedPaths ?? [])].sort();
    const transitions = p2Impact.scopedTransitions ?? [];
    const transitionPaths = transitions.map((transition) => transition.path).sort();
    const transitionChecks = transitions.map((transition) => ({
      path: transition.path,
      r17Sha256: predecessorDigests[transition.path] ?? null,
      currentSha256: currentDigests[transition.path] ?? null,
      predecessorSha256: transition.predecessorSha256 ?? null,
      observedSha256: transition.observedSha256 ?? null,
      chainMatches: transition.predecessorSha256 === predecessorDigests[transition.path]
        && transition.observedSha256 === currentDigests[transition.path]
        && digestFile(transition.path) === currentDigests[transition.path],
    }));
    const exactChangedPaths = JSON.stringify(changedPaths) === JSON.stringify(expectedChangedPaths)
      && JSON.stringify(transitionPaths) === JSON.stringify(expectedChangedPaths)
      && new Set(transitionPaths).size === transitionPaths.length;
    const selectedPredecessorValid = p2PredecessorPath === PDP2_R17_PATH
      && selectedPredecessor?.observationId === 'MEDIA-PDP2-CURRENTNESS-2026-10-14-CURRENT-CUT-R17'
      && digestFile(PDP2_R17_PATH) === PDP2_R17_DIGEST;
    const valid = selectedPredecessorValid
      && p2Impact.valid === true
      && r17Impact.valid === true
      && predecessorPaths.length === 405
      && currentPaths.length === 405
      && missingPaths.length === 0
      && additionalPaths.length === 0
      && changedPaths.length === 3
      && expectedChangedPaths.length === 3
      && exactChangedPaths
      && transitionChecks.length === 3
      && transitionChecks.every((entry) => entry.chainMatches);
    return {
      status: valid ? 'PASS' : 'FAIL',
      checkpointRef: p2PredecessorPath,
      checkpointDigest: selectedPredecessorValid ? digestFile(p2PredecessorPath) : null,
      checkpointStatus: selectedPredecessorValid ? 'PASS' : 'FAIL',
      selectedPredecessor: {
        ref: p2PredecessorPath,
        expectedRef: PDP2_R17_PATH,
        observationId: selectedPredecessor?.observationId ?? null,
        valid: selectedPredecessorValid,
      },
      ownerReviewValid: null,
      ownerAcceptance: 'NOT_CLAIMED',
      independentReview: 'NOT_CLAIMED',
      materialSourceSetFingerprint,
      denominator: 405,
      historicalPathCount: predecessorPaths.length,
      currentPathCount: currentPaths.length,
      unchangedPathCount: predecessorPaths.length - changedPaths.length - missingPaths.length,
      changedPathCount: changedPaths.length,
      uniqueChangedPathCount: new Set(expectedChangedPaths).size,
      expectedChangedPathCount: expectedChangedPaths.length,
      changeTransitionCount: transitions.length,
      missingPathCount: missingPaths.length,
      additionalPathCount: additionalPaths.length,
      unapprovedChangedPathCount: changedPaths.filter((sourcePath) => !expectedChangedPaths.includes(sourcePath)).length,
      missingAuthorizedPathCount: expectedChangedPaths.filter((sourcePath) => !changedPaths.includes(sourcePath)).length,
      missingPaths,
      additionalPaths,
      changedPaths,
      expectedChangedPaths,
      transitionChecks,
      exactChangedPaths,
      r17ToR30SourceImpact: r17Impact,
      pdp2ScopedImpact: p2Impact,
      lifecycleClosure: 'NOT_ENTERED',
      runtimeAdmission: 'NOT_ADMITTED',
      delivery: 'NOT_AUTHORIZED',
      release: 'NOT_AUTHORIZED',
    };
  }
  const r9SourceDigests = r9Checkpoint?.sourceCurrentness?.sourceSetDigests?.sourceContentDigests ?? {};
  const r9Paths = Object.keys(r9SourceDigests).sort();
  const currentPaths = Object.keys(currentDigests ?? {}).sort();
  const currentSet = new Set(currentPaths);
  const r9Set = new Set(r9Paths);
  const missingPaths = r9Paths.filter((sourcePath) => !currentSet.has(sourcePath));
  const additionalPaths = currentPaths.filter((sourcePath) => !r9Set.has(sourcePath));
  const changedPaths = r9Paths.filter((sourcePath) => currentSet.has(sourcePath) && r9SourceDigests[sourcePath] !== currentDigests[sourcePath]);
  const checkpoint = validatePdp2R9HistoricalCheckpoint(r9Checkpoint);
  const p2Impact = pdp2CurrentCutImpact(r9Checkpoint, currentDigests, pdp2CurrentCutOptions);
  const composedCurrentnessSourceChains = p2Impact.currentnessSourceChains ?? null;
  const scopedTransitions = p2Impact.scopedTransitions ?? [];
  const supplementalSourceWork = p2Impact.supplementalSourceWork ?? [];
  const authorizedPaths = [...(p2Impact.scopedChangedPaths ?? []), ...supplementalSourceWork.map((entry) => entry.path), ...(p2Impact.r16ProjectionImpact?.valid ? p2Impact.r16ProjectionImpact.paths : [])].sort();
  const authorizedPathSet = new Set(authorizedPaths);
  const unapprovedChangedPaths = changedPaths.filter((sourcePath) => !authorizedPathSet.has(sourcePath));
  const missingAuthorizedPaths = authorizedPaths.filter((sourcePath) => !changedPaths.includes(sourcePath));
  const transitionsByPath = new Map();
  for (const transition of scopedTransitions) {
    if (!transitionsByPath.has(transition.path)) transitionsByPath.set(transition.path, []);
    transitionsByPath.get(transition.path).push(transition);
  }
  const transitionChecks = [];
  for (const sourcePath of p2Impact.scopedChangedPaths ?? []) {
    const hops = transitionsByPath.get(sourcePath) ?? [];
    let expectedPredecessor = r9SourceDigests[sourcePath];
    const chainMatches = hops.length > 0 && hops.every((hop) => {
      const matches = hop.predecessorSha256 === expectedPredecessor;
      expectedPredecessor = hop.observedSha256;
      return matches;
    });
    transitionChecks.push({
      path: sourcePath,
      r9Sha256: r9SourceDigests[sourcePath] ?? null,
      currentSha256: currentDigests[sourcePath] ?? null,
      terminalTransitionSha256: hops.at(-1)?.observedSha256 ?? null,
      hopCount: hops.length,
      chainMatches: chainMatches && expectedPredecessor === currentDigests[sourcePath],
    });
  }
  for (const work of supplementalSourceWork) {
    const chainMatches = work.predecessorSha256 === r9SourceDigests[work.path]
      && work.observedSha256 === currentDigests[work.path];
    transitionChecks.push({ path: work.path, r9Sha256: r9SourceDigests[work.path] ?? null,
      currentSha256: currentDigests[work.path] ?? null, terminalTransitionSha256: work.observedSha256 ?? null,
      hopCount: 1, chainMatches });
  }
  for (const transition of p2Impact.r16ProjectionImpact?.transitions ?? []) {
    const chain = composedCurrentnessSourceChains?.chains?.find(({ path: sourcePath }) => sourcePath === transition.path);
    const chainMatches = transition.predecessorSha256 === r9SourceDigests[transition.path]
      && transition.observedSha256 === currentDigests[transition.path]
      && chain?.r16BaseMatchesR13 === true
      && chain?.r16ChainMatchesCurrent === true;
    transitionChecks.push({ path: transition.path, r9Sha256: r9SourceDigests[transition.path] ?? null,
      currentSha256: currentDigests[transition.path] ?? null, terminalTransitionSha256: transition.observedSha256,
      hopCount: 1, chainMatches, sourceImpact: 'PDP2_R16_GENERATED_PROJECTION' });
  }
  const transitionPathsUnique = authorizedPaths.length === authorizedPathSet.size;
  const exactR9ToLiveTransitions = p2Impact.valid && p2Impact.scopedImpactValid
    && p2Impact.additionalSourceImpact?.valid === true
    && (p2Impact.r25ToR27Bridge?.valid !== true || p2Impact.r16ProjectionImpact?.valid === true)
    && composedCurrentnessSourceChains?.valid === true
    && transitionPathsUnique
    && transitionChecks.length === authorizedPaths.length
    && transitionChecks.every((entry) => entry.chainMatches)
    && changedPaths.length === authorizedPaths.length
    && unapprovedChangedPaths.length === 0 && missingAuthorizedPaths.length === 0;
  const pathChecks = changedPaths.map((sourcePath) => ({
    path: sourcePath,
    r9Sha256: r9SourceDigests[sourcePath] ?? null,
    currentSha256: currentDigests[sourcePath] ?? null,
    authorized: authorizedPathSet.has(sourcePath),
  }));
  const valid = checkpoint.valid
    && r9Paths.length === 405 && currentPaths.length === 405
    && missingPaths.length === 0 && additionalPaths.length === 0
    && exactR9ToLiveTransitions;
  const legacyR2Diagnostic = ownerStatusJoin(historicalExit, currentDigests, ownerReview, materialSourceSetFingerprint);
  return {
    status: valid ? 'PASS' : 'FAIL',
    checkpointRef: checkpoint.ref,
    checkpointDigest: checkpoint.digest,
    checkpointStatus: checkpoint.valid ? 'PASS' : 'FAIL',
    checkpointHistoricalR2Join: checkpoint,
    composedR9ToR13ToLiveSourceChains: composedCurrentnessSourceChains,
    legacyR2HistoricalDiagnostic: {
      status: legacyR2Diagnostic.status,
      changedPathCount: legacyR2Diagnostic.changedPathCount,
      unapprovedChangedPaths: legacyR2Diagnostic.unapprovedChangedPaths,
      ref: legacyR2Diagnostic.historicalExitRef,
    },
    ownerReviewValid: checkpoint.valid,
    materialSourceSetFingerprint,
    denominator: 405,
    historicalPathCount: r9Paths.length,
    currentPathCount: currentPaths.length,
    unchangedPathCount: r9Paths.length - changedPaths.length - missingPaths.length,
    changedPathCount: changedPaths.length,
    uniqueChangedPathCount: authorizedPathSet.size,
    expectedChangedPathCount: authorizedPaths.length,
    changeTransitionCount: scopedTransitions.length + supplementalSourceWork.length,
    duplicateTransitionPaths: [...new Set(scopedTransitions.map((entry) => entry.path))]
      .filter((sourcePath) => scopedTransitions.filter((entry) => entry.path === sourcePath).length > 1),
    missingPathCount: missingPaths.length,
    additionalPathCount: additionalPaths.length,
    unapprovedChangedPathCount: unapprovedChangedPaths.length,
    missingAuthorizedPathCount: missingAuthorizedPaths.length,
    unapprovedChangedPaths,
    missingAuthorizedPaths,
    pathChecks,
    transitionChecks,
    pdp2ScopedImpact: p2Impact,
    predecessorEvidenceRefresh: p2Impact.predecessorEvidenceRefresh,
    meaningIdCount: scopedTransitions.reduce((count, entry) => count + (entry.meaningIdsChanged?.length ?? 0), 0),
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
  const p2ImpactPredecessor = pdp2ObservationImpactPredecessor(p1Exit, historicalP2Exit,
    readJson(PDP2_CURRENT_CUT_PREDECESSOR_PATH));
  const p2Impact = pdp2CurrentCutImpact(p2ImpactPredecessor, currentDigests);
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
  const impactValidatorTestOutcome = testRun.outcomes.find((outcome) => outcome.command === PDP2_IMPACT_VALIDATOR_TEST_COMMAND);
  const localOutcome = testRun.outcomes.find((outcome) => outcome.command === LOCAL_CHECK_COMMAND);
  const testInputsCurrent = PDP2_TEST_FILES.every((sourcePath) => {
    const observed = currentDigests[sourcePath];
    const bound = testRun.sourceBinding?.testInputContentDigests?.[sourcePath];
    return observed === bound;
  });
  const impactValidatorTestCurrent = testRun.sourceBinding?.testInputContentDigests?.[PDP2_IMPACT_VALIDATOR_TEST_FILE]
    === sha256(fs.readFileSync(path.join(root, PDP2_IMPACT_VALIDATOR_TEST_FILE)));
  const testsPass = localOutcome?.status === 'PASS' && localOutcome.exitCode === 0
    && testOutcome?.status === 'PASS' && testOutcome.exitCode === 0
    && Number.isInteger(testOutcome.testCount) && testOutcome.testCount > 0
    && testOutcome.passedCount === testOutcome.testCount
    && testOutcome.failedCount === 0 && testOutcome.skippedCount === 0
    && impactValidatorTestOutcome?.status === 'PASS' && impactValidatorTestOutcome.exitCode === 0
    && Number.isInteger(impactValidatorTestOutcome.testCount) && impactValidatorTestOutcome.testCount > 0
    && impactValidatorTestOutcome.passedCount === impactValidatorTestOutcome.testCount
    && impactValidatorTestOutcome.failedCount === 0 && impactValidatorTestOutcome.skippedCount === 0
    && impactValidatorTestCurrent && testInputsCurrent && lifecycleConsistent;
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
  const ownershipJoin = currentnessOwnerStatusJoin(historicalP2Exit, sourceSetByPath, phaseOwnerReview,
    materialSourceSetFingerprint, {
      pdp1ExitPath: p1ExitPath,
      p2PredecessorPath: PDP2_CURRENT_CUT_PREDECESSOR_PATH,
    });
  const sourceBlockers = [
    ...topologyReview.errors,
    ...(predecessor.valid ? [] : ['PDP1_PREDECESSOR_EXIT_NOT_PASS_OR_MATRIX_MISMATCH']),
    ...(p0Predecessor.valid ? [] : ['PDP0_PAIRED_PREDECESSOR_EXIT_NOT_PASS_OR_MATRIX_MISMATCH']),
    ...(ownerDirectionPass ? [] : ['DELEGATED_PDP2_DESIGN_DIRECTION_MISSING_OR_CONTRADICTORY']),
    ...(historicalStatusValid ? [] : ['HISTORICAL_PDP2_STATUS_INCONSISTENT_OR_OUTSTANDING_TASKS']),
    ...(populations.matchesHistoricalStatus && populations.componentFamilyIds.exactSetMatches ? [] : ['PDP2_CATALOG_POPULATIONS_OR_FAMILY_IDENTITIES_MISMATCH']),
    ...(mdc20.result?.status === 'PASS' && mdc20.pinReview?.unclassifiedChangedPins?.length === 0 ? [] : ['MDC20_DRIFT_DISPOSITION_NOT_PASS']),
    ...(pins.changedPinCount === pins.expectedChangedPathCount
      && pins.expectedChangedPathsMatch && pins.unclassifiedChangedPins.length === 0 && pins.missingPinCount === 0
      ? [] : ['PDP2_HISTORICAL_PIN_DRIFT_UNCLASSIFIED_OR_UNEXPECTED']),
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
  const scopedImpactBinding = pdp2ScopedImpactBinding(p1Exit);
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
      pdp2ScopedImpact: scopedImpactBinding,
      pdp2ImpactPredecessor: { ref: PDP2_CURRENT_CUT_PREDECESSOR_PATH, sha256: digestFile(PDP2_CURRENT_CUT_PREDECESSOR_PATH), includedIn405PathMaterialDenominator: false },
      pdp2AdditionalSourceImpact: p2Impact.additionalSourceImpact ?? null,
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

export function pdp2ScopedImpactBinding(p1Exit, fallbackImpactPath = PDP2_CURRENT_CUT_IMPACT_PATH) {
  const isR30Recapture = p1Exit?.observationId === 'MEDIA-PDP1-CURRENTNESS-2026-10-15-CURRENT-CUT-R30';
  const ref = isR30Recapture ? PDP2_R17_TO_R30_IMPACT_PATH : fallbackImpactPath;
  return {
    ref,
    sha256: digestFile(ref),
    includedIn405PathMaterialDenominator: false,
  };
}

export function pdp2ObservationImpactPredecessor(p1Exit, historicalP2Exit, selectedP2Predecessor) {
  return p1Exit?.observationId === 'MEDIA-PDP1-CURRENTNESS-2026-10-15-CURRENT-CUT-R30'
    ? selectedP2Predecessor
    : historicalP2Exit;
}

function main() {
  const suffix = process.argv[2];
  const requestedP1ExitPath = process.argv[3];
  const requestedImpactPath = process.argv[4];
  const requestedP2PredecessorPath = process.argv[5];
  const requestedAdditionalImpactPath = process.argv[6];
  const requestedProjectionImpactPath = process.argv[7];
  if (!/^[a-z0-9-]+$/u.test(suffix ?? '')) {
    process.stderr.write('Usage: node scripts/capture-media-discovery-pdp2-current-cut.mjs <fresh-cut-suffix> [pdp1-exit-path [approved-pdp2-impact-path [historical-pdp2-predecessor-path [additional-pdp2-source-impact-path [pdp2-projection-impact-path]]]]]\n');
    process.exitCode = 2;
    return;
  }
  const outputPath = `docs/implementation/observations/media-discovery-pdp2-exit-${suffix}.json`;
  if (fs.existsSync(path.join(root, outputPath))) throw new Error(`Refusing to overwrite immutable observation: ${outputPath}`);
  const matrix = readJson(MATRIX_PATH);
  const p1ExitPath = path.normalize(requestedP1ExitPath ?? PDP1_CURRENT_CUT_EXIT_R30_PATH);
  if (!p1ExitPath) throw new Error('Matrix currentCut does not declare the current PDP-1 exit path');
  if (path.isAbsolute(p1ExitPath) || path.relative(root, path.resolve(root, p1ExitPath)).startsWith('..')) {
    throw new Error(`PDP-1 exit path must be repository-relative: ${requestedP1ExitPath}`);
  }
  const resolveRepositoryPath = (requestedPath, fallback, label) => {
    const selected = path.normalize(requestedPath ?? fallback);
    if (!selected || path.isAbsolute(selected) || path.relative(root, path.resolve(root, selected)).startsWith('..')) {
      throw new Error(`${label} path must resolve inside the repository: ${requestedPath}`);
    }
    return selected;
  };
  PDP1_CURRENT_CUT_EXIT_PATH = p1ExitPath;
  PDP2_CURRENT_CUT_IMPACT_PATH = resolveRepositoryPath(requestedImpactPath, PDP2_CURRENT_CUT_IMPACT_PATH, 'PDP-2 impact');
  PDP2_CURRENT_CUT_PREDECESSOR_PATH = resolveRepositoryPath(requestedP2PredecessorPath, PDP2_CURRENT_CUT_PREDECESSOR_PATH, 'PDP-2 predecessor');
  PDP2_ADDITIONAL_SOURCE_IMPACT_PATH = requestedAdditionalImpactPath
    ? resolveRepositoryPath(requestedAdditionalImpactPath, null, 'PDP-2 additional source impact') : null;
  PDP2_R16_PROJECTION_IMPACT_PATH = requestedProjectionImpactPath
    ? resolveRepositoryPath(requestedProjectionImpactPath, null, 'PDP-2 R16 projection impact') : null;
  const p1 = readJson(p1ExitPath);
  const r30Recapture = p1.observationId === 'MEDIA-PDP1-CURRENTNESS-2026-10-15-CURRENT-CUT-R30';
  const r27Recapture = p1.observationId === 'MEDIA-PDP1-CURRENTNESS-2026-10-14-CURRENT-CUT-R27';
  const r25Recapture = p1.observationId === 'MEDIA-PDP1-CURRENTNESS-2026-10-14-CURRENT-CUT-R25';
  if (r30Recapture) {
    if (!requestedP2PredecessorPath) PDP2_CURRENT_CUT_PREDECESSOR_PATH = PDP2_R17_PATH;
    if (PDP2_CURRENT_CUT_PREDECESSOR_PATH !== PDP2_R17_PATH) {
      throw new Error(`PDP-1 R30 recapture must compare PDP-2 from exact predecessor ${PDP2_R17_PATH}`);
    }
    if (requestedAdditionalImpactPath || requestedProjectionImpactPath) {
      throw new Error(`PDP-1 R30 recapture consumes the exact combined R17-to-R30 source-impact record ${PDP2_R17_TO_R30_IMPACT_PATH}; no overlapping supplemental impact paths are accepted`);
    }
  }
  if (r27Recapture || r25Recapture) {
    if (!requestedP2PredecessorPath) PDP2_CURRENT_CUT_PREDECESSOR_PATH = PDP2_CURRENT_CUT_PREDECESSOR_R13_PATH;
    if (PDP2_CURRENT_CUT_PREDECESSOR_PATH !== PDP2_CURRENT_CUT_PREDECESSOR_R13_PATH) {
      throw new Error(`PDP-1 ${r27Recapture ? 'R27' : 'R25'} recapture must compare PDP-2 from exact predecessor ${PDP2_CURRENT_CUT_PREDECESSOR_R13_PATH}`);
    }
    if (r27Recapture && !requestedAdditionalImpactPath) PDP2_ADDITIONAL_SOURCE_IMPACT_PATH = PDP2_ADDITIONAL_SOURCE_IMPACT_R1_PATH;
    if (r27Recapture && !requestedProjectionImpactPath) PDP2_R16_PROJECTION_IMPACT_PATH = PDP2_R16_PROJECTION_IMPACT_RECORD_PATH;
    if (!PDP2_ADDITIONAL_SOURCE_IMPACT_PATH) {
      throw new Error(`PDP-1 ${r27Recapture ? 'R27' : 'R25'} recapture requires the exact separately authorized PDP-2 supplemental v3 impact record`);
    }
    if (PDP2_CURRENT_CUT_IMPACT_PATH !== PDP2_CURRENT_CUT_IMPACT_R5_PATH) {
      throw new Error(`PDP-1 ${r27Recapture ? 'R27' : 'R25'} recapture must preserve the historical R5 R9-to-R22 impact chain from ${PDP2_CURRENT_CUT_IMPACT_R5_PATH}`);
    }
    if (r27Recapture && PDP2_R16_PROJECTION_IMPACT_PATH !== PDP2_R16_PROJECTION_IMPACT_RECORD_PATH) {
      throw new Error('PDP-1 R27 recapture requires the exact separately authorized PDP-2 R16 generated-projection impact record');
    }
  }
  const p0Predecessor = validatePairedPdp0(p1, matrix);
  const predecessor = validatePdp1Predecessor(p1, matrix, p1ExitPath, p0Predecessor);
  if (!p0Predecessor.valid || !predecessor.valid) {
    throw new Error(`Refusing to run PDP-2 checks without exact current predecessors: PDP-0=${p0Predecessor.status}, PDP-1=${predecessor.status}`);
  }
  const p2Predecessor = readJson(PDP2_CURRENT_CUT_PREDECESSOR_PATH);
  const p2PredecessorDigests = p2Predecessor.sourceCurrentness?.sourceSetDigests?.sourceContentDigests ?? {};
  const currentP2Digests = Object.fromEntries(Object.keys(p2PredecessorDigests).map((sourcePath) => [sourcePath, digestFile(sourcePath)]));
  const p2ImpactPreflight = pdp2CurrentCutImpact(p2Predecessor, currentP2Digests, {
    pdp1ExitPath: p1ExitPath,
    additionalSourceImpactPath: PDP2_ADDITIONAL_SOURCE_IMPACT_PATH,
    additionalProjectionImpactPath: PDP2_R16_PROJECTION_IMPACT_PATH,
  });
  if (Object.keys(p2PredecessorDigests).length !== 405 || !p2ImpactPreflight.valid) {
    throw new Error(`Refusing to run PDP-2 checks without the exact authorized 405-path impact chain: ${JSON.stringify({ pathCount: Object.keys(p2PredecessorDigests).length, impactValid: p2ImpactPreflight.valid, bridge: p2ImpactPreflight.r25ToR27Bridge, r16ProjectionImpact: p2ImpactPreflight.r16ProjectionImpact })}`);
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
