#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  canonicalizeVerificationValue,
  captureRepositorySourceCurrentness,
  isRepositorySourceCurrentness,
} from '@ghatana/verification-planner';
import { observeMediaDiscoveryCurrentness, resolveMediaPdp0Cells } from './media-discovery-currentness.mjs';
import { pdp0PhaseScopedSourcePins } from './report-media-pdp-readiness.mjs';
import { validateMediaPdp0SourceDevelopmentCurrentCut } from './lib/media-pdp0-source-development-current-cut.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-13.json';
const successorOutputPath = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r10.json';
const r11SuccessorOutputPath = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r12.json';
const supplementalImpactPath = 'docs/implementation/observations/media-discovery-predecessor-impact-pdp3-status-guard-2026-10-14-r1.json';
const currentCutImpactPath = 'docs/implementation/observations/media-discovery-current-cut-source-impact-2026-10-14-r1.json';
const currentCutPdp0PredecessorPath = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r2.json';
const pdp0R6ExitPath = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r6.json';
const pdp0R6CurrentnessPath = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r6.json';
const pdp0SuccessorImpactPath = 'docs/implementation/observations/media-discovery-pdp0-r6-successor-impact-2026-10-14-r1.json';
const pdp0R8ExitPath = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r8.json';
const pdp0R8CurrentnessPath = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r8.json';
const pdp0R8SuccessorImpactPath = 'docs/implementation/observations/media-discovery-pdp0-r8-successor-impact-2026-10-14-r2.json';
const pdp0Pxd163ImpactPath = 'docs/implementation/observations/media-discovery-pdp0-pxd163-source-impact-2026-10-14-r1.json';
const pdp0R10ExitPath = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r10.json';
const pdp0R10CurrentnessPath = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r10.json';
const pdp0Pxd164SuccessorImpactPath = 'docs/implementation/observations/media-discovery-pdp0-pxd164-successor-impact-2026-10-14-r1.json';
const pdp1Pxd164ImpactPath = 'docs/implementation/observations/media-discovery-pdp1-pxd164-semantic-repair-impact-2026-10-14-r1.json';
const pdp0R11ExitPath = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r11.json';
const pdp0R11CurrentnessPath = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r11.json';
const pdp0R11SuccessorImpactPath = 'docs/implementation/observations/media-discovery-pdp0-r11-successor-impact-2026-10-14-r1.json';
const pdp0R12ExitPath = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r12.json';
const pdp0R12CurrentnessPath = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r12.json';
const pdp0R12SuccessorImpactPath = 'docs/implementation/observations/media-discovery-pdp0-r12-successor-impact-2026-10-14-r1.json';
const pdp0R12SuccessorImpactR2Path = 'docs/implementation/observations/media-discovery-pdp0-r12-successor-impact-2026-10-14-r2.json';
const pdp0R12SuccessorImpactR3Path = 'docs/implementation/observations/media-discovery-pdp0-r12-successor-impact-2026-10-14-r3.json';
const pdp0R12SuccessorImpactR1Sha256 = 'sha256:e5f837db065f2b6c99e721ee9f748b319266e911de3b21a1e30c055437e18ebe';
const pdp0R12SuccessorImpactR2Sha256 = 'sha256:7b14877d3103ba63933521c95766114d068d3d450f803ae66e2bc9af422b9d22';
const lifecycleR12Revision = '7cd80b8a03508f5feb116ee8f6f86b28ac4c8f28';
const lifecycleR12ObservedRevision = 'bb118bf0c67cd114d9f63d5648e97c38a83ade3f';
const pdp0CurrentnessTestPredecessorSnapshot = 'docs/implementation/observations/media-discovery-currentness-test-predecessor-snapshot-2026-10-23.mjs';
const pdp0CurrentnessTestPredecessorSha256 = 'sha256:c9a8dbf034fababa21cacf5d38319c03a1cf7ac242f3140b6982899706288143';
const pdp0CurrentnessRecorderPredecessorSnapshot = 'docs/implementation/observations/record-media-discovery-pdp0-currentness-predecessor-snapshot-2026-10-23.mjs';
const pdp0CurrentnessRecorderPredecessorSha256 = 'sha256:652e8d774e2f89478f52be114df6ab969ced82c60b70ccfb330891a084ad4780';
const lifecycleExplorerCampaignCheck = 'node scripts/generate-lifecycle-explorer-pack.mjs && node scripts/checks/check-explorer-campaign-conformance.mjs';
const pdp0R11SuccessorSupportPaths = [
  'scripts/record-media-discovery-pdp0-currentness.mjs',
  'scripts/record-media-discovery-pdp0-phase-exit.mjs',
  'scripts/lib/media-discovery-pdp0-phase-exit.mjs',
  'tests/media-discovery-currentness.test.mjs',
  'tests/media-discovery-pdp0-phase-exit.test.mjs',
].sort();

export function mediaPdp0R11SuccessorSupportFileHashes() {
  return Object.fromEntries(pdp0R11SuccessorSupportPaths.map((relativePath) => [
    relativePath,
    hashBytes(fs.readFileSync(path.join(root, relativePath))),
  ]));
}

const pdp0R12SuccessorSupportPaths = [...pdp0R11SuccessorSupportPaths];

export function mediaPdp0R12SuccessorSupportFileHashes() {
  return Object.fromEntries(pdp0R12SuccessorSupportPaths.map((relativePath) => {
    const historicalSnapshots = {
      'tests/media-discovery-currentness.test.mjs': [pdp0CurrentnessTestPredecessorSnapshot, pdp0CurrentnessTestPredecessorSha256],
      'scripts/record-media-discovery-pdp0-currentness.mjs': [pdp0CurrentnessRecorderPredecessorSnapshot, pdp0CurrentnessRecorderPredecessorSha256],
    };
    if (historicalSnapshots[relativePath]) {
      const [snapshotPath, expectedSha256] = historicalSnapshots[relativePath];
      const snapshotBytes = fs.readFileSync(path.join(root, snapshotPath));
      if (hashBytes(snapshotBytes) !== expectedSha256) throw new Error(`Historical PDP-0 support snapshot is corrupt: ${snapshotPath}`);
      return [relativePath, expectedSha256];
    }
    return [relativePath, hashBytes(fs.readFileSync(path.join(root, relativePath)))];
  }));
}

export const mediaPdp0R12SuccessorR2SupportFileHashes = mediaPdp0R12SuccessorSupportFileHashes;
export const mediaPdp0R12SuccessorR3SupportFileHashes = mediaPdp0R12SuccessorSupportFileHashes;

export function resolveMediaPdp0CurrentnessOutputPath(successorImpactMode = false, successorSuffix = null) {
  if (!successorImpactMode) return outputPath;
  if (successorSuffix === null || successorSuffix === undefined) return successorOutputPath;
  if (!/^[a-z0-9-]+$/u.test(successorSuffix)) throw new TypeError('Successor suffix must contain lowercase letters, digits, or hyphens');
  return `docs/implementation/observations/media-discovery-pdp0-currentness-${successorSuffix}.json`;
}

export function resolveMediaPdp0SourceDevelopmentCurrentnessSuffix(recordId, requestedSuffix = null) {
  const canonicalSuffix = recordId === 'MEDIA-DISCOVERY-PDP0-SOURCE-DEVELOPMENT-CURRENT-CUT-2026-10-23-R1'
    ? '2026-10-14-current-cut-r16' : null;
  if (canonicalSuffix && requestedSuffix && requestedSuffix !== canonicalSuffix) {
    throw new Error(`Source-development record ${recordId} requires canonical output suffix ${canonicalSuffix}`);
  }
  return canonicalSuffix ?? requestedSuffix ?? null;
}

export function resolveMediaPdp0SuccessorCurrentnessSuffix(recordId, requestedSuffix = null) {
  const suffixes = {
    'MEDIA-DISCOVERY-PDP0-R11-SUCCESSOR-IMPACT-2026-10-14-R1': '2026-10-14-current-cut-r12',
    'MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R1': '2026-10-14-current-cut-r13',
    'MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R2': '2026-10-14-current-cut-r14',
    'MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R3': '2026-10-14-current-cut-r15',
  };
  const canonicalSuffix = suffixes[recordId] ?? null;
  if (canonicalSuffix && requestedSuffix && requestedSuffix !== canonicalSuffix) {
    throw new Error(`Successor record ${recordId} requires canonical output suffix ${canonicalSuffix}`);
  }
  return canonicalSuffix ?? requestedSuffix ?? null;
}

export function resolveMediaPdp0SuccessorPredecessorExitPath(record) {
  if (record?.recordId === 'MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R1'
    || record?.recordId === 'MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R2'
    || record?.recordId === 'MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R3') return pdp0R12ExitPath;
  if (record?.recordId === 'MEDIA-DISCOVERY-PDP0-R11-SUCCESSOR-IMPACT-2026-10-14-R1') return pdp0R11ExitPath;
  if (record?.recordId === 'MEDIA-DISCOVERY-PDP0-PXD164-SUCCESSOR-IMPACT-2026-10-14-R1') return pdp0R10ExitPath;
  if (record?.recordId === 'MEDIA-DISCOVERY-PDP0-R8-SUCCESSOR-IMPACT-2026-10-14-R2') return pdp0R8ExitPath;
  return pdp0R6ExitPath;
}

export function assertMediaPdp0CurrentnessOutputAvailable(relativePath, exists = fs.existsSync) {
  const destination = path.join(root, relativePath);
  if (exists(destination)) throw new Error(`Refusing to overwrite immutable observation: ${relativePath}`);
  return destination;
}
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

export function classifySupplementalPdp0PinChange(pinComparisons, decision) {
  const delta = decision?.sourceDelta;
  const exact = decision?.schemaVersion === 'media.discovery-predecessor-source-impact.v1'
    && decision?.recordId === 'MEDIA-DISCOVERY-PREDECESSOR-IMPACT-PDP3-STATUS-GUARD-2026-10-14-R1'
    && decision?.campaign?.repository === 'samujjwal/ghatana-media'
    && decision?.campaign?.activePhase === 'PDP-0'
    && decision?.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION'
    && decision?.authority?.humanIndependentSignatureProvided === false
    && decision?.authority?.qualifiedExternalSpecialistSignoffProvided === false
    && decision?.authority?.externalContractOwnerAcceptanceProvided === false
    && decision?.authority?.nativeLifecycleReceiptProvided === false
    && decision?.decision?.status === 'APPROVED_INTERNAL_NON_IMPACT_FOR_EXACT_SOURCE_DELTA'
    && decision?.decision?.requiresOrderedTechnicalCurrentnessRecapture?.includes('PDP-0')
    && delta?.path === 'scripts/report-media-pdp-readiness.mjs'
    && delta?.predecessorSha256 === 'sha256:6655e0344b7f4b03f6ca0b7e594a5448eed72ae5aeac198cef4bb1b28252028c'
    && delta?.observedSha256 === 'sha256:f3482cf689e0be2d8dc9faf9ccc72a1b63a1dcaecd056efaa1759e6f3696a5e1'
    && delta?.freshCurrentnessRequired === true
    && Array.isArray(delta?.changedMeaningIds) && delta.changedMeaningIds.length === 0
    && Array.isArray(delta?.outstandingPredecessorMeaningIds) && delta.outstandingPredecessorMeaningIds.length === 0
    && decision?.predecessorCuts?.some((cut) => cut.phase === 'PDP-0'
      && cut.receiptRef === 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r1.json'
      && cut.receiptSha256 === 'sha256:48f8e6fa4cb7373a66f5a33524ba89a471a1e19ab719aa2800fccec08e82ea49'
      && cut.materialSourceSetFingerprint === 'sha256:8a60cf8a09e671b09729563039d31aed69b21934a59cade1af9833ca9af86cb9'
      && cut.materialPathCount === 146 && cut.recordedPathDigest === delta.predecessorSha256);
  if (!exact) return null;
  const pin = pinComparisons?.find((entry) => entry.path === delta.path);
  if (pin?.recordedDigest !== delta.predecessorSha256 || pin?.currentDigest !== delta.observedSha256 || pin?.disposition !== 'CHANGED') return null;
  return {
    path: delta.path,
    classification: 'PDP-3 STATUS GUARD DOWNSTREAM SOURCE IMPACT REVIEWED; EXACT PDP-0 SEMANTIC NON-IMPACT; FRESH CURRENTNESS REQUIRED',
    authorityRef: supplementalImpactPath,
  };
}

export function classifyCurrentCutPdp0PinChange(pinComparisons, decision) {
  const reporter = decision?.sourceDeltas?.find((entry) => entry.path === 'scripts/report-media-pdp-readiness.mjs');
  const interfaceReview = decision?.sourceDeltas?.find((entry) => entry.path === '.product-experience/interface-parity/current-source-review.json');
  const regressionTest = decision?.sourceDeltas?.find((entry) => entry.path === 'tests/media-pdp-p1-dev-status.test.mjs');
  const exact = decision?.schemaVersion === 'media.discovery-current-cut-source-impact.v1'
    && decision?.recordId === 'MEDIA-DISCOVERY-CURRENT-CUT-SOURCE-IMPACT-2026-10-14-R1'
    && decision?.campaign?.repository === 'samujjwal/ghatana-media'
    && decision?.campaign?.stage === 'DISCOVERY'
    && decision?.campaign?.activePhase === 'PDP-0'
    && decision?.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION'
    && decision?.authority?.userAuthorization === 'Authorize scoped impact disposition (Recommended)'
    && decision?.authority?.decisionRole === 'SCOPED_INTERNAL_MEDIA_SOURCE_IMPACT_REVIEW'
    && decision?.authority?.humanIndependentSignatureProvided === false
    && decision?.authority?.qualifiedExternalSpecialistSignoffProvided === false
    && decision?.authority?.externalContractOwnerAcceptanceProvided === false
    && decision?.authority?.nativeLifecycleReceiptProvided === false
    && decision?.decision?.status === 'APPROVED_INTERNAL_IMPACT_DISPOSITION_FOR_EXACT_SOURCE_DELTAS'
    && decision?.decision?.pdp0MeaningDisposition === 'NO_MEANING_CHANGE_FOR_EXACT_REVIEWED_SOURCE_DELTAS'
    && decision?.decision?.independentApproval === 'NOT_CLAIMED_AND_NOT_WAIVED'
    && decision?.decision?.externalContractOwnerAcceptance === 'NOT_CLAIMED'
    && decision?.decision?.nativeLifecycleClosure === 'NOT_ENTERED'
    && decision?.decision?.runtimeAdmission === 'NOT_ADMITTED'
    && decision?.decision?.delivery === 'BLOCKED'
    && JSON.stringify(decision?.decision?.requiresOrderedTechnicalCurrentnessRecapture) === JSON.stringify(['PDP-0', 'PDP-1'])
    && decision?.sourceDeltas?.length === 3
    && interfaceReview?.predecessorSha256 === 'sha256:14cf6c3d9ea948e39e41ffa2de3453c08b7b6a23267f407f3504c5462b7428fc'
    && interfaceReview?.observedSha256 === 'sha256:62765cbb335572f28570fe650b3955aaa028f314322490e17e466d3ca9234abf'
    && interfaceReview?.classification === 'PDP1_REVIEW_ARTIFACT_REFRESH_FOR_SEPARATELY_REVIEWED_OPERATION_DELTA'
    && interfaceReview?.additionalMeaningIds?.length === 0
    && regressionTest?.predecessorSha256 === 'sha256:5a007a561cc96659d7da63d2470727237d1496c3a50c80682253a9d542846599'
    && regressionTest?.observedSha256 === 'sha256:3ff1576a4a3987f5b1e05d15ae77e35a62745260e127ebcb28c1bb49ef7ef82e'
    && regressionTest?.classification === 'REGRESSION_COVERAGE'
    && regressionTest?.meaningIdsChanged?.length === 0
    && reporter?.phases?.includes('PDP-0')
    && reporter?.classification === 'PDP_STATUS_TEST_REPORTER_SELECTION_ONLY'
    && reporter?.historicalPdp0MaterialSha256 === 'sha256:6655e0344b7f4b03f6ca0b7e594a5448eed72ae5aeac198cef4bb1b28252028c'
    && reporter?.predecessorSha256 === 'sha256:f3482cf689e0be2d8dc9faf9ccc72a1b63a1dcaecd056efaa1759e6f3696a5e1'
    && reporter?.observedSha256 === 'sha256:ca59f6c4e1313bd58387f91b41eb51fc1a10ac04b2db01faed30b9edcc9b2573'
    && reporter?.meaningIdsChanged?.length === 0
    && reporter?.requiresFreshCurrentness === true
    && reporter?.predecessorChain?.length === 1
    && reporter.predecessorChain[0].receiptRef === supplementalImpactPath
    && reporter.predecessorChain[0].receiptSha256 === hashBytes(fs.readFileSync(path.join(root, supplementalImpactPath)))
    && reporter.predecessorChain[0].fromSha256 === 'sha256:6655e0344b7f4b03f6ca0b7e594a5448eed72ae5aeac198cef4bb1b28252028c'
    && reporter.predecessorChain[0].toSha256 === reporter.predecessorSha256
    && decision?.predecessorCuts?.some((cut) => cut.phase === 'PDP-0'
      && cut.receiptRef === currentCutPdp0PredecessorPath
      && cut.receiptSha256 === 'sha256:3f9b401f36ed23a50cf40a70670414e92327a71cffe80274d96d4006b55a39a3'
      && cut.receiptSha256 === hashBytes(fs.readFileSync(path.join(root, currentCutPdp0PredecessorPath)))
      && cut.materialSourceSetFingerprint === 'sha256:20e8a999b36e7fb61662183200f1e8c83eebb39523c5ab8835bea311af1f31e8'
      && cut.materialPathCount === 146 && cut.reporterSha256 === reporter.predecessorSha256);
  if (!exact) return null;
  const pin = pinComparisons?.find((entry) => entry.path === reporter.path);
  if (pin?.recordedDigest !== reporter.historicalPdp0MaterialSha256
      || pin?.currentDigest !== reporter.observedSha256 || pin?.disposition !== 'CHANGED') return null;
  return {
    path: reporter.path,
    classification: 'PDP STATUS REPORTER SELECTION CHANGE; EXACT PDP-0 SEMANTIC NON-IMPACT; FRESH CURRENTNESS REQUIRED',
    authorityRef: currentCutImpactPath,
  };
}

export function classifyAdditionalPdp0SourceImpact(pinComparisons, record, recordPath) {
  const sourcePath = '.product-experience/decision-log.md';
  const expectedRecordPath = 'docs/implementation/observations/media-discovery-pdp0-pxd163-source-impact-2026-10-14-r1.json';
  const expectedRecordId = 'MEDIA-DISCOVERY-PDP0-ADDITIONAL-SOURCE-IMPACT-2026-10-14-R1';
  const pin = pinComparisons?.find((entry) => entry.path === sourcePath);
  const validPath = typeof recordPath === 'string' && !path.isAbsolute(recordPath)
    && !path.relative(root, path.resolve(root, recordPath)).startsWith('..');
  const valid = validPath
    && record?.schemaVersion === 'media.discovery-pdp0-additional-source-impact.v1'
    && record.recordId === expectedRecordId
    && recordPath === expectedRecordPath
    && record.phase === 'PDP-0'
    && record.sourcePath === sourcePath
    && /^sha256:[a-f0-9]{64}$/u.test(record.predecessorSha256 ?? '')
    && /^sha256:[a-f0-9]{64}$/u.test(record.observedSha256 ?? '')
    && record.classification === 'INTERNAL_SCOPED_IMPACT_DISPOSITION'
    && record.pdp0MeaningDisposition === 'NO_PDP0_MEANING_CHANGE'
    && record.pdp0ImpactAssessment?.sourceSelector === '.product-experience/decision-log.md#PXD-163'
    && record.pdp0ImpactAssessment?.meaningIdsChanged?.length === 0
    && record.ownerAcceptance === 'NOT_CLAIMED'
    && record.independentReview === 'NOT_CLAIMED'
    && record.lifecycleClosure === 'NOT_ENTERED'
    && record.runtimeAdmission === 'NOT_ADMITTED'
    && record.delivery === 'BLOCKED'
    && pin?.recordedDigest === record.predecessorSha256
    && pin?.currentDigest === record.observedSha256
    && pin?.disposition === 'CHANGED';
  if (!valid) return null;
  return {
    path: sourcePath,
    classification: record.classification,
    authorityRef: recordPath,
    authoritySha256: hashBytes(fs.readFileSync(path.resolve(root, recordPath))),
    predecessorSha256: record.predecessorSha256,
    observedSha256: record.observedSha256,
    ownerAcceptance: record.ownerAcceptance,
    independentReview: record.independentReview,
  };
}

export function classifyPdp0SuccessorImpact(pinComparisons, record, recordPath, technicalCurrentness) {
  if (record?.recordId === 'MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R1') {
    return classifyMediaPdp0R12SuccessorImpact(pinComparisons, record, recordPath, technicalCurrentness);
  }
  if (record?.recordId === 'MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R2') {
    return classifyMediaPdp0R12SuccessorImpactR2(pinComparisons, record, recordPath, technicalCurrentness);
  }
  if (record?.recordId === 'MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R3') {
    return classifyMediaPdp0R12SuccessorImpactR3(pinComparisons, record, recordPath, technicalCurrentness);
  }
  if (record?.recordId === 'MEDIA-DISCOVERY-PDP0-R11-SUCCESSOR-IMPACT-2026-10-14-R1') {
    return classifyMediaPdp0R11SuccessorImpact(pinComparisons, record, recordPath, technicalCurrentness);
  }
  if (record?.recordId === 'MEDIA-DISCOVERY-PDP0-PXD164-SUCCESSOR-IMPACT-2026-10-14-R1') {
    return classifyPdp0Pxd164SuccessorImpact(pinComparisons, record, recordPath, technicalCurrentness);
  }
  if (record?.recordId === 'MEDIA-DISCOVERY-PDP0-R8-SUCCESSOR-IMPACT-2026-10-14-R2') {
    return classifyPdp0R8SuccessorImpact(pinComparisons, record, recordPath, technicalCurrentness);
  }
  const reporterPath = 'scripts/report-media-pdp-readiness.mjs';
  const priorExit = JSON.parse(fs.readFileSync(path.join(root, pdp0R6ExitPath), 'utf8'));
  const priorCurrentness = JSON.parse(fs.readFileSync(path.join(root, pdp0R6CurrentnessPath), 'utf8'));
  const hashFile = (relativePath) => hashBytes(fs.readFileSync(path.join(root, relativePath)));
  const expectedTopology = {
    physicalCandidates: 26, semanticCompositions: 6, repositoryRoots: 1, consumers: 17, totalCells: 50,
  };
  const topologySignature = (cells) => hashValue((cells ?? []).map((cell) => ({
    cellId: cell.cellId,
    surfaceId: cell.surfaceId,
    cellType: cell.cellType,
    applicability: cell.applicability,
  })).sort((left, right) => left.cellId.localeCompare(right.cellId)));
  const fingerprintSignature = (cells) => hashValue((cells ?? []).map((cell) => ({
    cellId: cell.cellId,
    ownerGraphFingerprint: cell.ownerGraphFingerprint,
    physicalCatalogFingerprint: cell.physicalCatalogFingerprint,
    providerRegistryFingerprint: cell.providerRegistryFingerprint,
  })).sort((left, right) => left.cellId.localeCompare(right.cellId)));
  const expectedCellIds = priorExit.sourceCurrentness?.cells?.map((cell) => cell.cellId).sort() ?? [];
  const currentCellIds = technicalCurrentness?.physicalCompositeConsumerCells?.map((cell) => cell.cellId).sort() ?? [];
  const deltas = record?.sourceDeltas ?? [];
  const delta = deltas[0];
  const predecessorCut = record?.predecessorCuts?.[0];
  const pin = pinComparisons?.find((entry) => entry.path === reporterPath);
  const validPath = typeof recordPath === 'string' && !path.isAbsolute(recordPath)
    && !path.relative(root, path.resolve(root, recordPath)).startsWith('..');
  if (!validPath || recordPath !== pdp0SuccessorImpactPath) return null;
  let recordBytes;
  let parsedRecord;
  try {
    recordBytes = fs.readFileSync(path.resolve(root, recordPath));
    parsedRecord = JSON.parse(recordBytes.toString('utf8'));
  } catch {
    return null;
  }
  if (!isDeepStrictEqual(parsedRecord, record)) return null;
  const authoritySha256 = hashBytes(recordBytes);
  const valid = validPath
    && recordPath === pdp0SuccessorImpactPath
    && record?.schemaVersion === 'media.discovery.pdp0-successor-source-impact.v1'
    && record?.recordId === 'MEDIA-DISCOVERY-PDP0-R6-SUCCESSOR-IMPACT-2026-10-14-R1'
    && record?.campaign?.repository === 'samujjwal/ghatana-media'
    && record?.campaign?.stage === 'DISCOVERY'
    && record?.campaign?.activePhase === 'PDP-0'
    && record?.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION'
    && record?.authority?.userAuthorization === 'Authorize this exact transition (Recommended)'
    && record?.authority?.authorizationEvidence?.channel === 'DIRECT_USER_REPLY_IN_CURRENT_TASK'
    && record?.authority?.authorizationEvidence?.exactResponse === 'Authorize this exact transition (Recommended)'
    && record?.authority?.authorizationEvidence?.authorizedPath === reporterPath
    && record?.authority?.authorizationEvidence?.predecessorSha256 === 'sha256:ca59f6c4e1313bd58387f91b41eb51fc1a10ac04b2db01faed30b9edcc9b2573'
    && record?.authority?.authorizationEvidence?.observedSha256 === 'sha256:4f0400c142d2f3df39c4497839925dad80f1ac90584573b390af386e491faa0f'
    && record?.authority?.decisionRole === 'SCOPED_INTERNAL_PDP0_SUCCESSOR_SOURCE_IMPACT_REVIEW'
    && record?.authority?.humanIndependentSignatureProvided === false
    && record?.authority?.qualifiedExternalSpecialistSignoffProvided === false
    && record?.authority?.externalContractOwnerAcceptanceProvided === false
    && record?.authority?.nativeLifecycleReceiptProvided === false
    && record?.decision?.status === 'APPROVED_INTERNAL_NO_MEANING_CHANGE_FOR_EXACT_SUCCESSOR_DELTA'
    && record?.decision?.pdp0MeaningDisposition === 'NO_PDP0_MEANING_CHANGE_FOR_EXACT_SOURCE_DELTA'
    && record?.decision?.ownerAcceptance === 'NOT_CLAIMED'
    && record?.decision?.independentSignoff === 'NOT_CLAIMED'
    && record?.decision?.lifecycleClosure === 'NOT_ENTERED'
    && record?.decision?.runtime === 'NOT_ADMITTED'
    && record?.decision?.delivery === 'BLOCKED'
    && record?.decision?.release === 'NOT_AUTHORIZED'
    && record?.decision?.freshTechnicalCurrentness === 'REQUIRED'
    && JSON.stringify(record?.decision?.orderedTechnicalCurrentness) === JSON.stringify(['PDP-0', 'PDP-1'])
    && typeof record?.limitations === 'string'
    && record.limitations.includes('does not claim external owner acceptance')
    && record.limitations.includes('independent signoff')
    && record.limitations.includes('native Lifecycle receipt or closure')
    && record.limitations.includes('runtime admission')
    && record.limitations.includes('Delivery readiness')
    && record.limitations.includes('release')
    && deltas.length === 1
    && delta?.path === reporterPath
    && delta?.classification === 'PDP_STATUS_REPORTER_SELECTION_CHANGE'
    && JSON.stringify(delta?.phases) === JSON.stringify(['PDP-0', 'PDP-1'])
    && delta?.predecessorSha256 === 'sha256:ca59f6c4e1313bd58387f91b41eb51fc1a10ac04b2db01faed30b9edcc9b2573'
    && delta?.observedSha256 === 'sha256:4f0400c142d2f3df39c4497839925dad80f1ac90584573b390af386e491faa0f'
    && Array.isArray(delta?.changedMeaningIds) && delta.changedMeaningIds.length === 0
    && delta?.freshCurrentnessRequired === true
    && record?.predecessorCuts?.some((cut) => cut.phase === 'PDP-0'
      && cut.exitRef === pdp0R6ExitPath
      && cut.exitSha256 === 'sha256:dac98419a6a2314741d584e120f7a9e7a3190559cbde7b6ca7e5d5b1a785aabb'
      && cut.currentnessRef === pdp0R6CurrentnessPath
      && cut.currentnessSha256 === 'sha256:826b0a69673818e9e97046fc4288af4cdf59d724f78bc2e6db5709f8d3b7bf65'
      && cut.materialSourceSetFingerprint === 'sha256:d44b0268aaec280bbd1a661d4ce2449e5e26daba41bba9f496005010bfa6f7bb'
      && cut.materialPathCount === 146
      && JSON.stringify(cut.topology) === JSON.stringify(expectedTopology))
    && record?.predecessorCuts?.length === 1
    && priorExit?.phase === 'PDP-0'
    && priorExit?.phaseExit?.status === 'PASS'
    && priorExit?.sourceCurrentness?.materialSourceSetFingerprint === 'sha256:d44b0268aaec280bbd1a661d4ce2449e5e26daba41bba9f496005010bfa6f7bb'
    && Object.keys(priorExit?.sourceCurrentness?.sourceContentDigests ?? {}).length === 146
    && priorExit?.sourceCurrentness?.cells?.length === 50
    && priorCurrentness?.materialSourceSetFingerprint === 'sha256:d44b0268aaec280bbd1a661d4ce2449e5e26daba41bba9f496005010bfa6f7bb'
    && priorCurrentness?.physicalCompositeConsumerCells?.length === 50
    && topologySignature(priorExit?.sourceCurrentness?.cells) === topologySignature(technicalCurrentness?.physicalCompositeConsumerCells)
    && fingerprintSignature(priorCurrentness?.physicalCompositeConsumerCells) === fingerprintSignature(technicalCurrentness?.physicalCompositeConsumerCells)
    && JSON.stringify(priorCurrentness?.denominators) === JSON.stringify(expectedTopology)
    && JSON.stringify(technicalCurrentness?.denominators) === JSON.stringify(expectedTopology)
    && JSON.stringify(currentCellIds) === JSON.stringify(expectedCellIds)
    && technicalCurrentness?.physicalCompositeConsumerCells?.every((cell) => cell.sourceCurrentness === 'CURRENT')
    && hashFile(pdp0R6ExitPath) === predecessorCut?.exitSha256
    && hashFile(pdp0R6CurrentnessPath) === predecessorCut?.currentnessSha256
    && pin?.recordedDigest === delta.predecessorSha256
    && pin?.currentDigest === delta.observedSha256
    && pin?.disposition === 'CHANGED';
  if (!valid) return null;
  return {
    path: reporterPath,
    classification: 'INTERNAL_PDP0_SUCCESSOR_IMPACT_DISPOSITION',
    authorityRef: recordPath,
    authoritySha256,
    predecessorSha256: delta.predecessorSha256,
    observedSha256: delta.observedSha256,
    meaningIdsChanged: [],
    ownerAcceptance: 'NOT_CLAIMED',
    independentSignoff: 'NOT_CLAIMED',
    lifecycleClosure: 'NOT_ENTERED',
    runtime: 'NOT_ADMITTED',
    delivery: 'BLOCKED',
  };
}

export function classifyMediaPdp0R12SuccessorImpact(pinComparisons, record, recordPath, technicalCurrentness, inputs = {}) {
  const predecessorExitSha256 = 'sha256:91aeae0aad488bc8eb29d40bf955e527ef072ada762948064bc8e50422c5a5c5';
  const predecessorCurrentnessSha256 = 'sha256:14882e245fa1676138cfc5bd51ef0403cb96cf2f77542caa2c57dc683ca8b159';
  const materialFingerprint = 'sha256:1a121cf988ba4a34f6b603b1f230fd0494160a3c6142c064d8d5cc2a6aa45f94';
  const expectedTopology = { physicalCandidates: 26, semanticCompositions: 6, repositoryRoots: 1, consumers: 17, totalCells: 50 };
  const expectedDeltas = [
    {
      path: '.product-experience/artifact-identities.yaml',
      predecessorSha256: 'sha256:cd6709b2e3bfff3c0b824f6e7e3c2c12777f688259beabbdbfeb1a261bd568f6',
      observedSha256: 'sha256:ad898f0143460d256f8da39466fcc344016097b8740f47b3b28a18b260e12f3a',
      classification: 'ARTIFACT_IDENTITY_CENSUS_ONLY',
    },
    {
      path: '.product-experience/gaps.yaml',
      predecessorSha256: 'sha256:3f58ca80e96f999960a4e4e0e91491a5f9a99bc9348223bbeb18426ba1cf4afd',
      observedSha256: 'sha256:4df3bad69c330b3649fe88a1797025f0a82de06f05d2ed3b5691608e5a5a6698',
      classification: 'GAP_CENSUS_ONLY_CORRECTION',
    },
    {
      path: '.product-experience/source-manifest.yaml',
      predecessorSha256: 'sha256:76cdcbff690e6a3439580e0df6fc68dbf67e7105b38d8ad1c9c3e9cb8b36145a',
      observedSha256: 'sha256:3a5c7e92e7470ee11c8bd1779db31a27aba75461c16fef37785901544c0c29fd',
      classification: 'GENERATED_SOURCE_MANIFEST_PROJECTION',
    },
    {
      path: 'apps/media-experience-explorer/specification-artifacts.json',
      predecessorSha256: 'sha256:2aadeeffe41ea354f43a0824a069b1e21bfef5a31052e4dca8ceb68da9bcfc75',
      observedSha256: 'sha256:6cb5006b07b113dfa5cc1b41a78648be56e76910c60b60bd82f286c1593b8593',
      classification: 'EXPLORER_ARTIFACT_INDEX_PROJECTION',
    },
  ];
  if (recordPath !== pdp0R12SuccessorImpactPath || path.isAbsolute(recordPath)
      || path.relative(root, path.resolve(root, recordPath)).startsWith('..')) return null;
  let recordBytes;
  let priorExit;
  let priorCurrentness;
  try {
    recordBytes = inputs.recordBytes ?? fs.readFileSync(path.resolve(root, recordPath));
    priorExit = inputs.priorExit ?? JSON.parse(fs.readFileSync(path.join(root, pdp0R12ExitPath), 'utf8'));
    priorCurrentness = inputs.priorCurrentness ?? JSON.parse(fs.readFileSync(path.join(root, pdp0R12CurrentnessPath), 'utf8'));
  } catch {
    return null;
  }
  const priorPins = priorExit?.sourceCurrentness?.sourceContentDigests ?? {};
  const sortedComparisons = [...(pinComparisons ?? [])].sort((left, right) => left.path.localeCompare(right.path));
  const changed = sortedComparisons.filter((pin) => pin.disposition !== 'MATCH');
  const samePaths = sortedComparisons.length === 146
    && Object.keys(priorPins).length === 146
    && sortedComparisons.every((pin) => Object.hasOwn(priorPins, pin.path) && pin.recordedDigest === priorPins[pin.path]);
  const predecessorCells = priorCurrentness?.physicalCompositeConsumerCells ?? [];
  const currentCells = technicalCurrentness?.physicalCompositeConsumerCells ?? [];
  const cellIds = (cells) => cells.map((cell) => cell.cellId).sort();
  const topologyUnchanged = JSON.stringify(cellIds(predecessorCells)) === JSON.stringify(cellIds(currentCells))
    && predecessorCells.length === 50 && currentCells.length === 50
    && predecessorCells.every((cell) => {
      const current = currentCells.find((candidate) => candidate.cellId === cell.cellId);
      return current
        && current.surfaceId === cell.surfaceId
        && current.cellType === cell.cellType
        && isDeepStrictEqual(current.applicability, cell.applicability)
        && current.ownerGraphFingerprint === cell.ownerGraphFingerprint
        && current.physicalCatalogFingerprint === cell.physicalCatalogFingerprint
        && current.providerRegistryFingerprint === cell.providerRegistryFingerprint;
    });
  const exactDeltas = isDeepStrictEqual(record?.sourceDeltas, expectedDeltas.map((delta) => ({
    ...delta,
    phase: 'PDP-0',
    pdp0MeaningChange: 'NONE',
    pdp0MeaningIdsChanged: [],
    freshCurrentnessRequired: true,
  })));
  let parsedRecord;
  try {
    parsedRecord = JSON.parse(recordBytes.toString('utf8'));
  } catch {
    return null;
  }
  const valid = isDeepStrictEqual(parsedRecord, record)
    && record?.schemaVersion === 'media.discovery.pdp0-successor-source-impact.v1'
    && record?.recordId === 'MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R1'
    && record?.campaign?.repository === 'samujjwal/ghatana-media'
    && record?.campaign?.stage === 'DISCOVERY'
    && record?.campaign?.activePhase === 'PDP-0'
    && record?.campaign?.scope === 'Exact R12-to-successor four-path census/projection correction; no PDP-0 meaning change.'
    && record?.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_AUTHORIZATION'
    && record?.authority?.decisionRole === 'SCOPED_INTERNAL_PDP0_SOURCE_IMPACT_REVIEW'
    && record?.authority?.userAuthorization === 'Register and recapture (Recommended)'
    && record?.authority?.authorizationEvidence?.source === 'DIRECT_USER_REPLY_IN_CURRENT_TASK'
    && record?.authority?.authorizationEvidence?.userReply === 'Register and recapture (Recommended)'
    && record?.authority?.authorizationEvidence?.authorizedScope === 'Register the existing delegated owner review as CROSS_PHASE_GOVERNANCE, regenerate its source projections, and recapture impacted currentness.'
    && record?.authority?.authorizationEvidence?.noMeaningChange === true
    && record?.authority?.authorizationEvidence?.externalAcceptance === false
    && record?.authority?.humanIndependentSignatureProvided === false
    && record?.authority?.qualifiedExternalSpecialistSignoffProvided === false
    && record?.authority?.externalContractOwnerAcceptanceProvided === false
    && record?.authority?.nativeLifecycleReceiptProvided === false
    && record?.predecessorCut?.phase === 'PDP-0'
    && record?.predecessorCut?.exitRef === pdp0R12ExitPath
    && record?.predecessorCut?.exitSha256 === predecessorExitSha256
    && record?.predecessorCut?.currentnessRef === pdp0R12CurrentnessPath
    && record?.predecessorCut?.currentnessSha256 === predecessorCurrentnessSha256
    && record?.predecessorCut?.materialSourceSetFingerprint === materialFingerprint
    && record?.predecessorCut?.materialPathCount === 146
    && isDeepStrictEqual(record?.predecessorCut?.topology, expectedTopology)
    && exactDeltas
    && record?.decision?.status === 'INTERNAL_SCOPED_NO_PDP0_MEANING_CHANGE_FOR_EXACT_R12_DELTAS'
    && record?.decision?.pdp0MeaningDisposition === 'NO_PDP0_MEANING_CHANGE'
    && record?.decision?.ownerAcceptance === 'NOT_CLAIMED'
    && record?.decision?.independentSignoff === 'NOT_CLAIMED'
    && record?.decision?.lifecycleClosure === 'NOT_ENTERED'
    && record?.decision?.runtime === 'NOT_ADMITTED'
    && record?.decision?.delivery === 'BLOCKED'
    && record?.decision?.release === 'NOT_AUTHORIZED'
    && record?.decision?.freshTechnicalCurrentness === 'REQUIRED'
    && isDeepStrictEqual(record?.supportFileSha256s, mediaPdp0R12SuccessorSupportFileHashes())
    && record?.limitations === 'This scoped internal disposition covers only the exact R12 four-path census/projection correction and asserts no additional PDP-0 meaning. It does not claim owner acceptance, independent signoff, native Lifecycle receipt or closure, runtime admission, Delivery readiness, or release authorization.'
    && priorExit?.phase === 'PDP-0'
    && priorExit?.phaseExit?.status === 'PASS'
    && priorExit?.sourceCurrentness?.status === 'PASS'
    && priorExit?.sourceCurrentness?.sourceCurrent === true
    && priorExit?.developmentStatus?.status === 'DEV_COMPLETE'
    && priorExit?.developmentStatus?.outstandingMeaningIds?.length === 0
    && priorExit?.sourceCurrentness?.materialSourceSetFingerprint === materialFingerprint
    && priorCurrentness?.observationId === 'MEDIA-PDP0-CURRENTNESS-2026-10-14-CURRENT-CUT-R12'
    && priorCurrentness?.phaseDisposition?.currentSourceCurrentness === 'PASS'
    && priorCurrentness?.phaseDisposition?.sourceCurrent === true
    && priorCurrentness?.materialSourceSetFingerprint === materialFingerprint
    && priorCurrentness?.denominators?.totalCells === 50
    && priorExit?.sourceCurrentness?.denominators?.totalCells === 50
    && samePaths && topologyUnchanged
    && changed.length === expectedDeltas.length
    && expectedDeltas.every((delta) => {
      const pin = sortedComparisons.find((entry) => entry.path === delta.path);
      return pin?.recordedDigest === delta.predecessorSha256
        && pin?.currentDigest === delta.observedSha256
        && pin?.disposition === 'CHANGED';
    })
    && currentCells.every((cell) => cell.sourceCurrentness === 'CURRENT' && (cell.blockers?.length ?? 0) === 0)
    && technicalCurrentness?.denominators?.totalCells === 50
    && technicalCurrentness?.materialPathDenominator?.uniquePaths === 146
    && technicalCurrentness?.lifecycleSourceCurrentness?.continuity === 'CONTINUOUS'
    && technicalCurrentness?.lifecycleSourceCurrentness?.consistencyStable === true
    && technicalCurrentness?.lifecycleSourceCurrentness?.zeroWorkEligibleAtCapture === true
    && hashBytes(fs.readFileSync(path.join(root, pdp0R12ExitPath))) === predecessorExitSha256
    && hashBytes(fs.readFileSync(path.join(root, pdp0R12CurrentnessPath))) === predecessorCurrentnessSha256;
  if (!valid) return null;
  const authoritySha256 = hashBytes(recordBytes);
  return expectedDeltas.map((delta) => ({
    path: delta.path,
    classification: 'INTERNAL_PDP0_SUCCESSOR_IMPACT_DISPOSITION',
    authorityRef: recordPath,
    authoritySha256,
    predecessorSha256: delta.predecessorSha256,
    observedSha256: delta.observedSha256,
    meaningIdsChanged: [],
    ownerAcceptance: 'NOT_CLAIMED',
    independentSignoff: 'NOT_CLAIMED',
    lifecycleClosure: 'NOT_ENTERED',
    runtime: 'NOT_ADMITTED',
    delivery: 'BLOCKED',
  }));
}

export function classifyMediaPdp0R12SuccessorImpactR2(pinComparisons, record, recordPath, technicalCurrentness, inputs = {}) {
  const predecessorExitSha256 = 'sha256:91aeae0aad488bc8eb29d40bf955e527ef072ada762948064bc8e50422c5a5c5';
  const predecessorCurrentnessSha256 = 'sha256:14882e245fa1676138cfc5bd51ef0403cb96cf2f77542caa2c57dc683ca8b159';
  const materialFingerprint = 'sha256:1a121cf988ba4a34f6b603b1f230fd0494160a3c6142c064d8d5cc2a6aa45f94';
  const expectedTopology = { physicalCandidates: 26, semanticCompositions: 6, repositoryRoots: 1, consumers: 17, totalCells: 50 };
  const expectedDeltas = [
    { path: '.product-experience/artifact-identities.yaml', predecessorSha256: 'sha256:cd6709b2e3bfff3c0b824f6e7e3c2c12777f688259beabbdbfeb1a261bd568f6', observedSha256: 'sha256:ad898f0143460d256f8da39466fcc344016097b8740f47b3b28a18b260e12f3a', classification: 'ARTIFACT_IDENTITY_CENSUS_ONLY' },
    { path: '.product-experience/gaps.yaml', predecessorSha256: 'sha256:3f58ca80e96f999960a4e4e0e91491a5f9a99bc9348223bbeb18426ba1cf4afd', observedSha256: 'sha256:7635137e6eb0e22659a3effde4f2076f94ce6429c58cefca2ae41469c952e8a0', classification: 'GAP_CENSUS_ONLY_CORRECTION' },
    { path: '.product-experience/source-manifest.yaml', predecessorSha256: 'sha256:76cdcbff690e6a3439580e0df6fc68dbf67e7105b38d8ad1c9c3e9cb8b36145a', observedSha256: 'sha256:3a5c7e92e7470ee11c8bd1779db31a27aba75461c16fef37785901544c0c29fd', classification: 'GENERATED_SOURCE_MANIFEST_PROJECTION' },
    { path: 'apps/media-experience-explorer/specification-artifacts.json', predecessorSha256: 'sha256:2aadeeffe41ea354f43a0824a069b1e21bfef5a31052e4dca8ceb68da9bcfc75', observedSha256: 'sha256:6cb5006b07b113dfa5cc1b41a78648be56e76910c60b60bd82f286c1593b8593', classification: 'EXPLORER_ARTIFACT_INDEX_PROJECTION' },
  ];
  if (recordPath !== pdp0R12SuccessorImpactR2Path || path.isAbsolute(recordPath)
      || path.relative(root, path.resolve(root, recordPath)).startsWith('..')) return null;
  let recordBytes;
  let priorExit;
  let priorCurrentness;
  let priorImpactBytes;
  let priorImpact;
  try {
    recordBytes = inputs.recordBytes ?? fs.readFileSync(path.resolve(root, recordPath));
    priorExit = inputs.priorExit ?? JSON.parse(fs.readFileSync(path.join(root, pdp0R12ExitPath), 'utf8'));
    priorCurrentness = inputs.priorCurrentness ?? JSON.parse(fs.readFileSync(path.join(root, pdp0R12CurrentnessPath), 'utf8'));
    priorImpactBytes = inputs.priorImpactBytes ?? fs.readFileSync(path.join(root, pdp0R12SuccessorImpactPath));
    priorImpact = inputs.priorImpact ?? JSON.parse(priorImpactBytes.toString('utf8'));
  } catch {
    return null;
  }
  let parsedRecord;
  try { parsedRecord = JSON.parse(recordBytes.toString('utf8')); } catch { return null; }
  const expectedRecord = structuredClone(priorImpact);
  expectedRecord.recordId = 'MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R2';
  expectedRecord.supersedes = { recordId: priorImpact.recordId, sha256: pdp0R12SuccessorImpactR1Sha256 };
  expectedRecord.campaign.scope = 'Exact R12-to-successor four-path census/projection correction; R2 supersedes R1 by exact digest, with R12 retained as the predecessor cut; 356 generated source records plus one manifest projection (357 total); no PDP-0 meaning change.';
  expectedRecord.projectionDenominator = { generatedSourceRecords: 356, manifestProjectionRecords: 1, total: 357 };
  expectedRecord.sourceDeltas = expectedDeltas.map((delta) => ({ ...delta, phase: 'PDP-0', pdp0MeaningChange: 'NONE', pdp0MeaningIdsChanged: [], freshCurrentnessRequired: true }));
  expectedRecord.limitations = 'This scoped internal disposition covers only the exact R12 four-path census/projection correction. R2 supersedes the R1 impact record by exact digest while retaining R12 as the source predecessor. It records 356 generated source records plus one manifest projection (357 total) and asserts no PDP-0 meaning change. It does not claim owner acceptance, independent signoff, native Lifecycle receipt or closure, runtime admission, Delivery readiness, or release authorization.';
  expectedRecord.supportFileSha256s = mediaPdp0R12SuccessorR2SupportFileHashes();
  const validRecord = isDeepStrictEqual(parsedRecord, record)
    && isDeepStrictEqual(record, expectedRecord)
    && priorImpact?.recordId === 'MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R1'
    && hashBytes(priorImpactBytes) === pdp0R12SuccessorImpactR1Sha256
    && priorImpact?.predecessorCut?.exitRef === pdp0R12ExitPath
    && priorImpact?.predecessorCut?.currentnessRef === pdp0R12CurrentnessPath
    && priorImpact?.sourceDeltas?.length === 4
    && priorImpact.sourceDeltas.every((delta, index) => delta.path === expectedDeltas[index].path
      && delta.predecessorSha256 === expectedDeltas[index].predecessorSha256
      && delta.classification === expectedDeltas[index].classification
      && (delta.path === '.product-experience/gaps.yaml' || delta.observedSha256 === expectedDeltas[index].observedSha256));
  const priorPins = priorExit?.sourceCurrentness?.sourceContentDigests ?? {};
  const comparisons = [...(pinComparisons ?? [])].sort((a, b) => a.path.localeCompare(b.path));
  const changed = comparisons.filter((entry) => entry.disposition !== 'MATCH');
  const exactPins = comparisons.length === 146 && Object.keys(priorPins).length === 146
    && comparisons.every((entry) => Object.hasOwn(priorPins, entry.path) && entry.recordedDigest === priorPins[entry.path]);
  const exactChanges = changed.length === 4 && expectedDeltas.every((delta) => comparisons.some((entry) => entry.path === delta.path
    && entry.recordedDigest === delta.predecessorSha256 && entry.currentDigest === delta.observedSha256 && entry.disposition === 'CHANGED'));
  const priorCells = priorCurrentness?.physicalCompositeConsumerCells ?? [];
  const cells = technicalCurrentness?.physicalCompositeConsumerCells ?? [];
  const topologyCurrent = priorCells.length === 50 && cells.length === 50 && priorCells.every((cell) => {
    const current = cells.find((candidate) => candidate.cellId === cell.cellId);
    return current && current.surfaceId === cell.surfaceId && current.cellType === cell.cellType
      && isDeepStrictEqual(current.applicability, cell.applicability)
      && current.ownerGraphFingerprint === cell.ownerGraphFingerprint
      && current.physicalCatalogFingerprint === cell.physicalCatalogFingerprint
      && current.providerRegistryFingerprint === cell.providerRegistryFingerprint;
  });
  const valid = validRecord && exactPins && exactChanges && topologyCurrent
    && priorExit?.phase === 'PDP-0' && priorExit?.phaseExit?.status === 'PASS'
    && priorExit?.sourceCurrentness?.status === 'PASS' && priorExit?.sourceCurrentness?.sourceCurrent === true
    && priorExit?.developmentStatus?.status === 'DEV_COMPLETE' && priorExit?.developmentStatus?.outstandingMeaningIds?.length === 0
    && priorExit?.sourceCurrentness?.materialSourceSetFingerprint === materialFingerprint
    && priorCurrentness?.observationId === 'MEDIA-PDP0-CURRENTNESS-2026-10-14-CURRENT-CUT-R12'
    && priorCurrentness?.materialSourceSetFingerprint === materialFingerprint
    && isDeepStrictEqual(record?.predecessorCut?.topology, expectedTopology)
    && record?.predecessorCut?.exitSha256 === predecessorExitSha256
    && record?.predecessorCut?.currentnessSha256 === predecessorCurrentnessSha256
    && cells.every((cell) => cell.sourceCurrentness === 'CURRENT' && (cell.blockers?.length ?? 0) === 0)
    && technicalCurrentness?.denominators?.totalCells === 50
    && technicalCurrentness?.materialPathDenominator?.uniquePaths === 146
    && technicalCurrentness?.lifecycleSourceCurrentness?.continuity === 'CONTINUOUS'
    && technicalCurrentness?.lifecycleSourceCurrentness?.consistencyStable === true
    && technicalCurrentness?.lifecycleSourceCurrentness?.zeroWorkEligibleAtCapture === true;
  if (!valid) return null;
  const authoritySha256 = hashBytes(recordBytes);
  return expectedDeltas.map((delta) => ({ path: delta.path, classification: 'INTERNAL_PDP0_SUCCESSOR_IMPACT_DISPOSITION',
    authorityRef: recordPath, authoritySha256, predecessorSha256: delta.predecessorSha256, observedSha256: delta.observedSha256,
    meaningIdsChanged: [], ownerAcceptance: 'NOT_CLAIMED', independentSignoff: 'NOT_CLAIMED', lifecycleClosure: 'NOT_ENTERED',
    runtime: 'NOT_ADMITTED', delivery: 'BLOCKED' }));
}

export function classifyMediaPdp0R12SuccessorImpactR3(pinComparisons, record, recordPath, technicalCurrentness, inputs = {}) {
  const expectedLocalPaths = [
    '.product-experience/artifact-identities.yaml',
    '.product-experience/gaps.yaml',
    '.product-experience/source-manifest.yaml',
    'apps/media-experience-explorer/specification-artifacts.json',
  ];
  const expectedLifecycleDelta = {
    repositoryId: 'ghatana-lifecycle',
    path: 'package.json',
    classification: 'LIFECYCLE_TOOLING_CHECK_REGISTRATION_NO_PDP0_MEANING',
    predecessorSha256: 'sha256:41c42b77f2fa20e1831f32ae116ae49d07ed8150b0b00265cda64e27f55f47bd',
    observedSha256: 'sha256:6e24f0d78a3ce1521c1e7f3246ae09df4d93f42e75dc9525017b0549ac88ae4f',
    exactChange: 'Adds check:lifecycle:explorer-campaign-conformance only.',
    pdp0MeaningChange: 'NONE',
    pdp0MeaningIdsChanged: [],
    externalOwnerAcceptance: 'NOT_CLAIMED',
    freshCurrentnessRequired: true,
  };
  if (recordPath !== pdp0R12SuccessorImpactR3Path || path.isAbsolute(recordPath)
      || path.relative(root, path.resolve(root, recordPath)).startsWith('..')) return null;
  let recordBytes;
  let priorR2Bytes;
  let priorR2;
  let priorExit;
  let priorCurrentness;
  try {
    recordBytes = inputs.recordBytes ?? fs.readFileSync(path.resolve(root, recordPath));
    priorR2Bytes = inputs.priorR2Bytes ?? fs.readFileSync(path.join(root, pdp0R12SuccessorImpactR2Path));
    priorR2 = inputs.priorR2 ?? JSON.parse(priorR2Bytes.toString('utf8'));
    priorExit = inputs.priorExit ?? JSON.parse(fs.readFileSync(path.join(root, pdp0R12ExitPath), 'utf8'));
    priorCurrentness = inputs.priorCurrentness ?? JSON.parse(fs.readFileSync(path.join(root, pdp0R12CurrentnessPath), 'utf8'));
  } catch {
    return null;
  }
  let parsedRecord;
  try { parsedRecord = JSON.parse(recordBytes.toString('utf8')); } catch { return null; }

  const expectedRecord = structuredClone(priorR2);
  expectedRecord.recordId = 'MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R3';
  expectedRecord.supersedes = { recordId: priorR2.recordId, sha256: pdp0R12SuccessorImpactR2Sha256 };
  expectedRecord.campaign.scope = 'R3 preserves R2 exact four-path GAP-12 census/projection dispositions and adds only the authorized ghatana-lifecycle/package.json check:lifecycle:explorer-campaign-conformance registration; R12 remains the predecessor cut; no PDP-0 meaning change.';
  expectedRecord.authority.userAuthorization = 'Exact Lifecycle package transition authorized by the user for internal PDP-0 no-meaning impact disposition.';
  expectedRecord.authority.authorizationEvidence = {
    source: 'DIRECT_USER_AUTHORIZATION_REPORTED_IN_CURRENT_TASK',
    userReply: 'The direct user instruction authorizes the exact Lifecycle package transition for internal PDP-0 no-meaning disposition.',
    authorizedScope: 'Register only the exact Lifecycle package script addition, preserve the four R2 local GAP-12 classifications, and record no PDP-0 meaning change. Do not claim external acceptance or Lifecycle closure.',
    noMeaningChange: true,
    externalAcceptance: false,
  };
  expectedRecord.sourceDeltas = structuredClone(priorR2.sourceDeltas);
  expectedRecord.externalSourceDeltas = [expectedLifecycleDelta];
  expectedRecord.decision.status = 'INTERNAL_SCOPED_NO_PDP0_MEANING_CHANGE_FOR_R2_DELTAS_AND_EXACT_LIFECYCLE_TRANSITION';
  expectedRecord.decision.externalLifecycleTransition = 'INTERNAL_NO_PDP0_MEANING_CHANGE';
  expectedRecord.limitations = 'This internal disposition preserves R2 exact four-path local GAP-12 census/projection classifications and covers only the exact Lifecycle package.json addition of check:lifecycle:explorer-campaign-conformance. R12 remains the source predecessor; R3 supersedes the R2 impact record by exact digest. No PDP-0 meaning change, external owner acceptance, independent signoff, native Lifecycle receipt or closure, runtime admission, Delivery readiness, or release authorization is claimed.';
  expectedRecord.supportFileSha256s = mediaPdp0R12SuccessorR3SupportFileHashes();

  const priorPins = priorExit?.sourceCurrentness?.sourceContentDigests ?? {};
  const comparisons = [...(pinComparisons ?? [])].sort((a, b) => a.path.localeCompare(b.path));
  const changed = comparisons.filter((entry) => entry.disposition !== 'MATCH');
  const exactLocalSet = comparisons.length === 146 && Object.keys(priorPins).length === 146
    && comparisons.every((entry) => Object.hasOwn(priorPins, entry.path) && entry.recordedDigest === priorPins[entry.path])
    && changed.length === 4 && changed.map((entry) => entry.path).sort().join('\n') === [...expectedLocalPaths].sort().join('\n')
    && priorR2.sourceDeltas?.length === 4
    && priorR2.sourceDeltas.every((delta, index) => delta.path === expectedLocalPaths[index]);
  const localImpactExact = changed.every((pin) => {
    const delta = priorR2.sourceDeltas.find((entry) => entry.path === pin.path);
    return delta && pin.recordedDigest === delta.predecessorSha256 && pin.currentDigest === delta.observedSha256;
  });

  const oldLifecycle = priorCurrentness?.externalOwnerContracts?.repositories?.find((entry) => entry.repositoryId === 'ghatana-lifecycle');
  const currentExternal = technicalCurrentness?.externalOwnerContracts;
  const currentLifecycle = currentExternal?.repositories?.find((entry) => entry.repositoryId === 'ghatana-lifecycle');
  const priorLifecyclePackage = oldLifecycle?.files?.find((entry) => entry.path === 'package.json');
  const currentLifecyclePackage = currentLifecycle?.files?.find((entry) => entry.path === 'package.json');
  let exactPackageTransition = false;
  try {
    const lifecycleRoot = path.resolve(root, externalRoots['ghatana-lifecycle']);
    const oldPackageBytes = execFileSync('git', ['show', `${lifecycleR12Revision}:package.json`], { cwd: lifecycleRoot });
    // The R3 record is historical. Verify its exact observed package bytes at
    // the recorded source revision instead of comparing against today's
    // Lifecycle checkout, which is allowed to advance independently.
    const currentPackageBytes = execFileSync('git', ['show', `${lifecycleR12ObservedRevision}:package.json`], { cwd: lifecycleRoot });
    const oldPackage = JSON.parse(oldPackageBytes.toString('utf8'));
    const currentPackage = JSON.parse(currentPackageBytes.toString('utf8'));
    const expectedPackage = structuredClone(oldPackage);
    expectedPackage.scripts = { ...expectedPackage.scripts, 'check:lifecycle:explorer-campaign-conformance': lifecycleExplorerCampaignCheck };
    exactPackageTransition = hashBytes(oldPackageBytes) === expectedLifecycleDelta.predecessorSha256
      && hashBytes(currentPackageBytes) === expectedLifecycleDelta.observedSha256
      && isDeepStrictEqual(currentPackage, expectedPackage)
      && priorLifecyclePackage?.declaredContentSha256 === expectedLifecycleDelta.predecessorSha256
      && priorLifecyclePackage?.observedContentSha256 === expectedLifecycleDelta.predecessorSha256
      && currentLifecyclePackage?.declaredContentSha256 === expectedLifecycleDelta.observedSha256
      && currentLifecyclePackage?.observedContentSha256 === expectedLifecycleDelta.observedSha256
      && currentLifecyclePackage?.digestMatches === true;
  } catch {
    exactPackageTransition = false;
  }
  const priorExternal = priorCurrentness?.externalOwnerContracts;
  const unchangedExternalFiles = currentExternal?.totalFiles === priorExternal?.totalFiles
    && currentExternal?.repositories?.length === priorExternal?.repositories?.length
    && currentExternal?.digestMatches === currentExternal?.totalFiles
    && currentExternal?.digestMismatches?.length === 0
    && (priorExternal?.repositories ?? []).every((priorRepository) => {
    const currentRepository = currentExternal?.repositories?.find((entry) => entry.repositoryId === priorRepository.repositoryId);
    if (!currentRepository || currentRepository.files?.length !== priorRepository.files?.length) return false;
    return priorRepository.files.every((priorFile) => {
      const currentFile = currentRepository.files.find((entry) => entry.path === priorFile.path);
      if (!currentFile || currentFile.package !== priorFile.package || currentFile.version !== priorFile.version) return false;
      return priorRepository.repositoryId === 'ghatana-lifecycle' && priorFile.path === 'package.json'
        ? currentFile.declaredContentSha256 === expectedLifecycleDelta.observedSha256
          && currentFile.observedContentSha256 === expectedLifecycleDelta.observedSha256
          && currentFile.digestMatches === true
        : currentFile.declaredContentSha256 === priorFile.declaredContentSha256
          && currentFile.observedContentSha256 === priorFile.observedContentSha256
          && currentFile.digestMatches === priorFile.digestMatches;
    });
    });
  const expectedTopology = { physicalCandidates: 26, semanticCompositions: 6, repositoryRoots: 1, consumers: 17, totalCells: 50 };
  const validRecord = isDeepStrictEqual(parsedRecord, record) && isDeepStrictEqual(record, expectedRecord)
    && priorR2?.recordId === 'MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R2'
    && hashBytes(priorR2Bytes) === pdp0R12SuccessorImpactR2Sha256
    && priorR2?.supersedes?.recordId === 'MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R1'
    && priorR2?.supersedes?.sha256 === pdp0R12SuccessorImpactR1Sha256
    && priorR2?.predecessorCut?.exitRef === pdp0R12ExitPath
    && priorR2?.predecessorCut?.currentnessRef === pdp0R12CurrentnessPath
    && isDeepStrictEqual(record?.sourceDeltas, priorR2.sourceDeltas)
    && record?.externalSourceDeltas?.length === 1
    && isDeepStrictEqual(record.externalSourceDeltas[0], expectedLifecycleDelta)
    && record?.predecessorCut?.exitRef === pdp0R12ExitPath
    && record?.predecessorCut?.currentnessRef === pdp0R12CurrentnessPath
    && record?.predecessorCut?.materialPathCount === 146
    && record?.predecessorCut?.topology?.totalCells === expectedTopology.totalCells;
  const priorCells = priorCurrentness?.physicalCompositeConsumerCells ?? [];
  const currentCells = technicalCurrentness?.physicalCompositeConsumerCells ?? [];
  const priorProviderFingerprint = 'sha256:eb509c518832b1978190d1803440256b0da62f8dd93fd1002a91b39ad0c885f4';
  const currentProviderFingerprint = 'sha256:c4a7fc74dce077154a83ebdb17b494d96ddf6e6d7a3eb0162422d804424d8030';
  const topologyCurrent = priorCells.length === 50 && currentCells.length === 50 && priorCells.every((cell) => {
    const current = currentCells.find((candidate) => candidate.cellId === cell.cellId);
    return current && current.surfaceId === cell.surfaceId && current.cellType === cell.cellType
      && isDeepStrictEqual(current.applicability, cell.applicability)
      && current.ownerGraphFingerprint === cell.ownerGraphFingerprint
      && current.physicalCatalogFingerprint === cell.physicalCatalogFingerprint
      && cell.providerRegistryFingerprint === priorProviderFingerprint
      && current.providerRegistryFingerprint === currentProviderFingerprint;
  }) && technicalCurrentness?.externalOwnerContracts?.providerRegistryFingerprint === currentProviderFingerprint;
  const valid = validRecord && exactLocalSet && localImpactExact && exactPackageTransition && unchangedExternalFiles && topologyCurrent
    && priorCurrentness?.materialSourceSetFingerprint === record.predecessorCut.materialSourceSetFingerprint
    && technicalCurrentness?.denominators?.totalCells === expectedTopology.totalCells
    && technicalCurrentness?.materialPathDenominator?.uniquePaths === 146;
  if (!valid) return null;
  const authoritySha256 = hashBytes(recordBytes);
  const classifications = priorR2.sourceDeltas.map((delta) => ({
    path: delta.path,
    classification: 'INTERNAL_PDP0_SUCCESSOR_IMPACT_DISPOSITION',
    authorityRef: recordPath,
    authoritySha256,
    predecessorSha256: delta.predecessorSha256,
    observedSha256: delta.observedSha256,
    meaningIdsChanged: [],
    ownerAcceptance: 'NOT_CLAIMED',
    independentSignoff: 'NOT_CLAIMED',
    lifecycleClosure: 'NOT_ENTERED',
    runtime: 'NOT_ADMITTED',
    delivery: 'BLOCKED',
  }));
  return {
    sourceClassifications: classifications,
    externalContractDisposition: {
    repositoryId: 'ghatana-lifecycle',
    path: 'package.json',
    classification: expectedLifecycleDelta.classification,
    authorityRef: recordPath,
    authoritySha256,
    predecessorSha256: expectedLifecycleDelta.predecessorSha256,
    observedSha256: expectedLifecycleDelta.observedSha256,
    externalOwnerAcceptance: 'NOT_CLAIMED',
    independentSignoff: 'NOT_CLAIMED',
    lifecycleClosure: 'NOT_ENTERED',
    runtime: 'NOT_ADMITTED',
    delivery: 'BLOCKED',
    release: 'NOT_AUTHORIZED',
    },
  };
}

function classifyPdp0Pxd164SuccessorImpact(pinComparisons, record, recordPath, technicalCurrentness) {
  const sourcePath = '.product-experience/decision-log.md';
  const predecessorSha256 = 'sha256:9831b03ecd3f30d2cbfd7a1db62d934035ba20cf1482bb5e621d166eacdb9b4c';
  const observedSha256 = 'sha256:97ad3104abec9ba6670804394c68a11c663f37171e90ea2a1f2e629aa5619bbc';
  const predecessorExitSha256 = 'sha256:f6c0e6a693ce74b0997743bbd2317f9f7ae0ab25e6f562aabf77f1ad2a9375a9';
  const predecessorCurrentnessSha256 = 'sha256:1f2ee24f5913b8d9d9fc6d306a2d1356347f16e437e49de59e3f502643c83d0e';
  const materialFingerprint = 'sha256:af292ca4f4d3d932fa081c42bb09273a286ec8aae83975a827f63cbc633b4687';
  const expectedTopology = { physicalCandidates: 26, semanticCompositions: 6, repositoryRoots: 1, consumers: 17, totalCells: 50 };
  const validPath = recordPath === pdp0Pxd164SuccessorImpactPath
    && !path.isAbsolute(recordPath)
    && !path.relative(root, path.resolve(root, recordPath)).startsWith('..');
  if (!validPath) return null;
  let recordBytes;
  let parsedRecord;
  let priorExit;
  let priorCurrentness;
  let p1ImpactBytes;
  let p1Impact;
  try {
    recordBytes = fs.readFileSync(path.resolve(root, recordPath));
    parsedRecord = JSON.parse(recordBytes.toString('utf8'));
    priorExit = JSON.parse(fs.readFileSync(path.join(root, pdp0R10ExitPath), 'utf8'));
    priorCurrentness = JSON.parse(fs.readFileSync(path.join(root, pdp0R10CurrentnessPath), 'utf8'));
    p1ImpactBytes = fs.readFileSync(path.join(root, pdp1Pxd164ImpactPath));
    p1Impact = JSON.parse(p1ImpactBytes.toString('utf8'));
  } catch {
    return null;
  }
  const priorPins = priorExit?.sourceCurrentness?.sourceContentDigests ?? {};
  const comparisons = [...(pinComparisons ?? [])].sort((a, b) => a.path.localeCompare(b.path));
  const changed = comparisons.filter((pin) => pin.disposition !== 'MATCH');
  const sourcePin = comparisons.find((pin) => pin.path === sourcePath);
  const currentCells = technicalCurrentness?.physicalCompositeConsumerCells ?? [];
  const priorCells = priorCurrentness?.physicalCompositeConsumerCells ?? [];
  const cellIds = (cells) => cells.map((cell) => cell.cellId).sort();
  const topologyUnchanged = priorCells.length === 50 && currentCells.length === 50
    && JSON.stringify(cellIds(priorCells)) === JSON.stringify(cellIds(currentCells))
    && priorCells.every((cell) => {
      const current = currentCells.find((candidate) => candidate.cellId === cell.cellId);
      return current
        && current.surfaceId === cell.surfaceId
        && current.cellType === cell.cellType
        && isDeepStrictEqual(current.applicability, cell.applicability)
        && current.ownerGraphFingerprint === cell.ownerGraphFingerprint
        && current.physicalCatalogFingerprint === cell.physicalCatalogFingerprint
        && current.providerRegistryFingerprint === cell.providerRegistryFingerprint;
    });
  const p1ImpactDigest = hashBytes(p1ImpactBytes);
  const delta = record?.sourceDeltas?.[0];
  const predecessorCut = record?.predecessorCut;
  const valid = isDeepStrictEqual(parsedRecord, record)
    && record?.schemaVersion === 'media.discovery.pdp0-successor-source-impact.v1'
    && record?.recordId === 'MEDIA-DISCOVERY-PDP0-PXD164-SUCCESSOR-IMPACT-2026-10-14-R1'
    && record?.campaign?.repository === 'samujjwal/ghatana-media'
    && record?.campaign?.stage === 'DISCOVERY'
    && record?.campaign?.activePhase === 'PDP-0'
    && record?.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION'
    && record?.authority?.decisionRole === 'SCOPED_INTERNAL_PDP0_SOURCE_IMPACT_REVIEW'
    && record?.authority?.humanIndependentSignatureProvided === false
    && record?.authority?.qualifiedExternalSpecialistSignoffProvided === false
    && record?.authority?.externalContractOwnerAcceptanceProvided === false
    && record?.authority?.nativeLifecycleReceiptProvided === false
    && record?.decision?.status === 'INTERNAL_SCOPED_NO_PDP0_MEANING_CHANGE_FOR_EXACT_PXD164_DELTA'
    && record?.decision?.pdp0MeaningDisposition === 'NO_PDP0_MEANING_CHANGE'
    && record?.decision?.ownerAcceptance === 'NOT_CLAIMED'
    && record?.decision?.independentSignoff === 'NOT_CLAIMED'
    && record?.decision?.lifecycleClosure === 'NOT_ENTERED'
    && record?.decision?.runtime === 'NOT_ADMITTED'
    && record?.decision?.delivery === 'BLOCKED'
    && record?.decision?.release === 'NOT_AUTHORIZED'
    && record?.decision?.freshTechnicalCurrentness === 'REQUIRED'
    && JSON.stringify(record?.decision?.orderedTechnicalCurrentness) === JSON.stringify(['PDP-0', 'PDP-1'])
    && typeof record?.limitations === 'string'
    && record.limitations.includes('does not claim owner acceptance')
    && record.limitations.includes('independent signoff')
    && record.limitations.includes('native Lifecycle receipt or closure')
    && record.limitations.includes('runtime admission')
    && record.limitations.includes('Delivery readiness')
    && record.limitations.includes('release authorization')
    && delta?.path === sourcePath
    && delta?.selector === `${sourcePath}#PXD-164`
    && delta?.phase === 'PDP-1'
    && delta?.classification === 'PXD164_PDP1_SEMANTIC_REPAIR_NO_PDP0_MEANING'
    && delta?.predecessorSha256 === predecessorSha256
    && delta?.observedSha256 === observedSha256
    && delta?.pdp0MeaningChange === 'NONE'
    && Array.isArray(delta?.pdp0MeaningIdsChanged) && delta.pdp0MeaningIdsChanged.length === 0
    && delta?.freshCurrentnessRequired === true
    && record?.sourceDeltas?.length === 1
    && record?.pdp1ImpactBasis?.ref === pdp1Pxd164ImpactPath
    && record?.pdp1ImpactBasis?.sha256 === p1ImpactDigest
    && p1Impact?.recordId === 'MEDIA-DISCOVERY-PDP1-PXD164-SEMANTIC-REPAIR-IMPACT-2026-10-14-R1'
    && p1Impact?.sourceDeltas?.some((entry) => entry.path === sourcePath
      && entry.predecessorSha256 === predecessorSha256
      && entry.observedSha256 === observedSha256
      && entry.meaningIdsChanged?.includes('media.operation.action.request-admitted-speech-operation'))
    && p1Impact?.pdp0ImpactAssessment?.disposition === 'NO_PDP0_MEANING_CHANGE'
    && p1Impact?.pdp0ImpactAssessment?.meaningIdsChanged?.length === 0
    && predecessorCut?.phase === 'PDP-0'
    && predecessorCut?.exitRef === pdp0R10ExitPath
    && predecessorCut?.exitSha256 === predecessorExitSha256
    && predecessorCut?.currentnessRef === pdp0R10CurrentnessPath
    && predecessorCut?.currentnessSha256 === predecessorCurrentnessSha256
    && predecessorCut?.materialSourceSetFingerprint === materialFingerprint
    && predecessorCut?.materialPathCount === 146
    && JSON.stringify(predecessorCut?.topology) === JSON.stringify(expectedTopology)
    && priorExit?.phase === 'PDP-0'
    && priorExit?.phaseExit?.status === 'PASS'
    && priorExit?.sourceCurrentness?.status === 'PASS'
    && priorExit?.sourceCurrentness?.sourceCurrent === true
    && priorExit?.developmentStatus?.status === 'DEV_COMPLETE'
    && priorExit?.developmentStatus?.outstandingMeaningIds?.length === 0
    && priorExit?.sourceCurrentness?.materialSourceSetFingerprint === materialFingerprint
    && Object.keys(priorPins).length === 146
    && priorCurrentness?.observationId === 'MEDIA-PDP0-CURRENTNESS-2026-10-14-CURRENT-CUT-R10'
    && priorCurrentness?.phaseDisposition?.currentSourceCurrentness === 'PASS'
    && priorCurrentness?.phaseDisposition?.sourceCurrent === true
    && priorCurrentness?.materialSourceSetFingerprint === materialFingerprint
    && priorCurrentness?.denominators?.totalCells === 50
    && priorExit?.sourceCurrentness?.cells?.length === 50
    && JSON.stringify(technicalCurrentness?.denominators) === JSON.stringify(expectedTopology)
    && technicalCurrentness?.materialSourceSetFingerprint
    && technicalCurrentness?.materialPathDenominator?.uniquePaths === 146
    && technicalCurrentness?.lifecycleSourceCurrentness?.continuity === 'CONTINUOUS'
    && technicalCurrentness?.lifecycleSourceCurrentness?.consistencyStable === true
    && technicalCurrentness?.lifecycleSourceCurrentness?.zeroWorkEligibleAtCapture === true
    && currentCells.every((cell) => cell.sourceCurrentness === 'CURRENT' && (cell.blockers?.length ?? 0) === 0)
    && topologyUnchanged
    && comparisons.length === 146
    && comparisons.every((pin) => Object.hasOwn(priorPins, pin.path) && pin.recordedDigest === priorPins[pin.path])
    && changed.length === 1
    && sourcePin?.recordedDigest === predecessorSha256
    && sourcePin?.currentDigest === observedSha256
    && sourcePin?.disposition === 'CHANGED'
    && hashBytes(fs.readFileSync(path.join(root, pdp0R10ExitPath))) === predecessorExitSha256
    && hashBytes(fs.readFileSync(path.join(root, pdp0R10CurrentnessPath))) === predecessorCurrentnessSha256;
  if (!valid) return null;
  return {
    path: sourcePath,
    classification: 'INTERNAL_PDP0_SUCCESSOR_IMPACT_DISPOSITION',
    authorityRef: recordPath,
    authoritySha256: hashBytes(recordBytes),
    predecessorSha256,
    observedSha256,
    meaningIdsChanged: [],
    ownerAcceptance: 'NOT_CLAIMED',
    independentSignoff: 'NOT_CLAIMED',
    lifecycleClosure: 'NOT_ENTERED',
    runtime: 'NOT_ADMITTED',
    delivery: 'BLOCKED',
  };
}

export function classifyPdp0R8SuccessorImpact(pinComparisons, record, recordPath, technicalCurrentness) {
  const sourcePath = 'tests/pdp-truth-domain.test.mjs';
  const predecessorSha256 = 'sha256:0d94c83f6c081f2e67a4ba20752c0cdfff03f26ae1d9d87860d9ba97047964e0';
  const observedSha256 = 'sha256:8ef1a6d5e11dc2e10ca32c3e6813fc8671c22a6c7f7038d48300d52f8feae578';
  const predecessorExitSha256 = 'sha256:4984d80baff808caf1792dddb5e52e20fe81d5d764e90948934d6e013e1e4e77';
  const predecessorCurrentnessSha256 = 'sha256:96841df11e13c1a394968d68ea3154724bd6168b5bc6dc0c5376ec09a40ea871';
  const materialFingerprint = 'sha256:26fdd485663c5ddd3426d50e0ca5d7c51606fd1a5854861c4c614e1786201c04';
  const expectedTopology = { physicalCandidates: 26, semanticCompositions: 6, repositoryRoots: 1, consumers: 17, totalCells: 50 };
  const validPath = recordPath === pdp0R8SuccessorImpactPath
    && !path.isAbsolute(recordPath)
    && !path.relative(root, path.resolve(root, recordPath)).startsWith('..');
  if (!validPath) return null;
  let parsedRecord;
  let recordBytes;
  let priorExit;
  let priorCurrentness;
  try {
    recordBytes = fs.readFileSync(path.resolve(root, recordPath));
    parsedRecord = JSON.parse(recordBytes.toString('utf8'));
    priorExit = JSON.parse(fs.readFileSync(path.join(root, pdp0R8ExitPath), 'utf8'));
    priorCurrentness = JSON.parse(fs.readFileSync(path.join(root, pdp0R8CurrentnessPath), 'utf8'));
  } catch {
    return null;
  }
  const priorPins = priorExit?.sourceCurrentness?.sourceContentDigests ?? {};
  const sortedComparisons = [...(pinComparisons ?? [])].sort((a, b) => a.path.localeCompare(b.path));
  const changed = sortedComparisons.filter((pin) => pin.disposition !== 'MATCH');
  const sourcePin = sortedComparisons.find((pin) => pin.path === sourcePath);
  const samePaths = sortedComparisons.length === 146
    && Object.keys(priorPins).length === 146
    && sortedComparisons.every((pin) => Object.hasOwn(priorPins, pin.path) && pin.recordedDigest === priorPins[pin.path]);
  const predecessorCells = priorCurrentness?.physicalCompositeConsumerCells ?? [];
  const currentCells = technicalCurrentness?.physicalCompositeConsumerCells ?? [];
  const cellIds = (cells) => cells.map((cell) => cell.cellId).sort();
  const topologyUnchanged = JSON.stringify(cellIds(predecessorCells)) === JSON.stringify(cellIds(currentCells))
    && predecessorCells.length === 50 && currentCells.length === 50
    && predecessorCells.every((cell) => {
      const current = currentCells.find((candidate) => candidate.cellId === cell.cellId);
      return current
        && current.surfaceId === cell.surfaceId
        && current.cellType === cell.cellType
        && isDeepStrictEqual(current.applicability, cell.applicability)
        && current.ownerGraphFingerprint === cell.ownerGraphFingerprint
        && current.physicalCatalogFingerprint === cell.physicalCatalogFingerprint
        && current.providerRegistryFingerprint === cell.providerRegistryFingerprint;
    });
  const valid = isDeepStrictEqual(parsedRecord, record)
    && record?.schemaVersion === 'media.discovery.pdp0-successor-source-impact.v1'
    && record?.recordId === 'MEDIA-DISCOVERY-PDP0-R8-SUCCESSOR-IMPACT-2026-10-14-R2'
    && record?.campaign?.repository === 'samujjwal/ghatana-media'
    && record?.campaign?.stage === 'DISCOVERY'
    && record?.campaign?.activePhase === 'PDP-0'
    && record?.campaign?.scope === 'Exact R8-to-R10 PDP-0 source transition for one authorized test file.'
    && record?.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_AUTHORIZATION'
    && record?.authority?.decisionRole === 'SCOPED_INTERNAL_PDP0_SOURCE_IMPACT_REVIEW'
    && record?.authority?.authorizationBasis === 'EXPLICIT_USER_AUTHORIZATION_RELAYED_BY_ORCHESTRATOR; NO_DIRECT_QUOTE_OR_SIGNATURE_RECORDED'
    && record?.authority?.humanIndependentSignatureProvided === false
    && record?.authority?.externalContractOwnerAcceptanceProvided === false
    && record?.authority?.nativeLifecycleReceiptProvided === false
    && record?.decision?.status === 'APPROVED_INTERNAL_NO_ADDITIONAL_PDP0_MEANING_FOR_EXACT_TEST_DELTA'
    && record?.decision?.pdp0MeaningDisposition === 'NO_ADDITIONAL_PDP0_MEANING'
    && record?.decision?.ownerAcceptance === 'NOT_CLAIMED'
    && record?.decision?.independentSignoff === 'NOT_CLAIMED'
    && record?.decision?.lifecycleClosure === 'NOT_ENTERED'
    && record?.decision?.runtime === 'NOT_ADMITTED'
    && record?.decision?.delivery === 'BLOCKED'
    && record?.decision?.release === 'NOT_AUTHORIZED'
    && record?.decision?.freshTechnicalCurrentness === 'REQUIRED'
    && record?.sourceDeltas?.length === 1
    && record.sourceDeltas[0]?.path === sourcePath
    && record.sourceDeltas[0]?.classification === 'PDP0_REGRESSION_TEST_ONLY_CHANGE'
    && record.sourceDeltas[0]?.predecessorSha256 === predecessorSha256
    && record.sourceDeltas[0]?.observedSha256 === observedSha256
    && record.sourceDeltas[0]?.meaningChange === 'NONE'
    && record.sourceDeltas[0]?.meaningIdsChanged?.length === 0
    && record.sourceDeltas[0]?.freshCurrentnessRequired === true
    && record?.predecessorCut?.exitRef === pdp0R8ExitPath
    && record.predecessorCut.exitSha256 === predecessorExitSha256
    && record.predecessorCut.currentnessRef === pdp0R8CurrentnessPath
    && record.predecessorCut.currentnessSha256 === predecessorCurrentnessSha256
    && record.predecessorCut.materialSourceSetFingerprint === materialFingerprint
    && record.predecessorCut.materialPathCount === 146
    && record?.limitations === 'This scoped internal disposition covers only the exact R8-to-R10 tests/pdp-truth-domain.test.mjs transition and asserts no additional PDP-0 meaning. It does not claim owner acceptance, independent signoff, native Lifecycle receipt or closure, runtime admission, Delivery readiness, or release authorization.'
    && JSON.stringify(record.predecessorCut.topology) === JSON.stringify(expectedTopology)
    && priorExit?.phase === 'PDP-0'
    && priorExit?.phaseExit?.status === 'PASS'
    && priorExit?.sourceCurrentness?.status === 'PASS'
    && priorExit?.sourceCurrentness?.sourceCurrent === true
    && priorExit?.developmentStatus?.status === 'DEV_COMPLETE'
    && priorExit?.developmentStatus?.outstandingMeaningIds?.length === 0
    && priorExit?.sourceCurrentness?.materialSourceSetFingerprint === materialFingerprint
    && priorCurrentness?.observationId === 'MEDIA-PDP0-CURRENTNESS-2026-10-14-CURRENT-CUT-R8'
    && priorCurrentness?.phaseDisposition?.currentSourceCurrentness === 'PASS'
    && priorCurrentness?.phaseDisposition?.sourceCurrent === true
    && priorCurrentness?.materialSourceSetFingerprint === materialFingerprint
    && priorCurrentness?.denominators?.totalCells === 50
    && priorExit?.sourceCurrentness?.denominators?.totalCells === 50
    && samePaths && topologyUnchanged
    && changed.length === 1
    && sourcePin?.recordedDigest === predecessorSha256
    && sourcePin?.currentDigest === observedSha256
    && sourcePin?.disposition === 'CHANGED'
    && (technicalCurrentness?.physicalCompositeConsumerCells ?? []).every((cell) => cell.sourceCurrentness === 'CURRENT' && (cell.blockers?.length ?? 0) === 0)
    && technicalCurrentness?.denominators?.totalCells === 50
    && (technicalCurrentness?.materialPathDenominator?.uniquePaths ?? 0) === 146
    && technicalCurrentness?.lifecycleSourceCurrentness?.continuity === 'CONTINUOUS'
    && technicalCurrentness?.lifecycleSourceCurrentness?.consistencyStable === true
    && technicalCurrentness?.lifecycleSourceCurrentness?.zeroWorkEligibleAtCapture === true
    && hashBytes(fs.readFileSync(path.join(root, pdp0R8ExitPath))) === predecessorExitSha256
    && hashBytes(fs.readFileSync(path.join(root, pdp0R8CurrentnessPath))) === predecessorCurrentnessSha256;
  if (!valid) return null;
  return {
    path: sourcePath,
    classification: 'INTERNAL_PDP0_SUCCESSOR_IMPACT_DISPOSITION',
    authorityRef: recordPath,
    authoritySha256: hashBytes(recordBytes),
    predecessorSha256,
    observedSha256,
    meaningIdsChanged: [],
    ownerAcceptance: 'NOT_CLAIMED',
    independentSignoff: 'NOT_CLAIMED',
    lifecycleClosure: 'NOT_ENTERED',
    runtime: 'NOT_ADMITTED',
    delivery: 'BLOCKED',
  };
}

export function classifyMediaPdp0R11SuccessorImpact(pinComparisons, record, recordPath, technicalCurrentness, inputs = {}) {
  const sourcePath = '.product-experience/pdp-0-product-truth/generated/product-definition.candidate.json';
  const predecessorSha256 = 'sha256:13c0789a6fa94c51abfbc60da8465e340406947a3f5a1dff4ec5a37bcef7e341';
  const observedSha256 = 'sha256:6cfb42b2fbf2e24ca904ab93ca98c905a6b892069f811f2f73166d7dc7e8de49';
  const predecessorExitSha256 = 'sha256:fe8e73184cf385328a4974a9a3b2aad84ff9033fb999c80c10f49c3db066c4ea';
  const predecessorCurrentnessSha256 = 'sha256:b6986cd2e93241c9962d1215977c99f899949f87da15a72d8087e6ad130d7026';
  const materialFingerprint = 'sha256:d9fc2839dc341cb05250e31093a2250678a9004febffaf290d4852e29f7282f1';
  const expectedTopology = { physicalCandidates: 26, semanticCompositions: 6, repositoryRoots: 1, consumers: 17, totalCells: 50 };
  if (recordPath !== pdp0R11SuccessorImpactPath || path.isAbsolute(recordPath)
      || path.relative(root, path.resolve(root, recordPath)).startsWith('..')) return null;
  let recordBytes;
  let priorExit;
  let priorCurrentness;
  try {
    recordBytes = inputs.recordBytes ?? fs.readFileSync(path.resolve(root, recordPath));
    priorExit = inputs.priorExit ?? JSON.parse(fs.readFileSync(path.join(root, pdp0R11ExitPath), 'utf8'));
    priorCurrentness = inputs.priorCurrentness ?? JSON.parse(fs.readFileSync(path.join(root, pdp0R11CurrentnessPath), 'utf8'));
  } catch {
    return null;
  }
  const priorPins = priorExit?.sourceCurrentness?.sourceContentDigests ?? {};
  const sortedComparisons = [...(pinComparisons ?? [])].sort((a, b) => a.path.localeCompare(b.path));
  const changed = sortedComparisons.filter((pin) => pin.disposition !== 'MATCH');
  const sourcePin = sortedComparisons.find((pin) => pin.path === sourcePath);
  const samePaths = sortedComparisons.length === 146
    && Object.keys(priorPins).length === 146
    && sortedComparisons.every((pin) => Object.hasOwn(priorPins, pin.path) && pin.recordedDigest === priorPins[pin.path]);
  const expectedSupportFileHashes = mediaPdp0R11SuccessorSupportFileHashes();
  const predecessorCells = priorCurrentness?.physicalCompositeConsumerCells ?? [];
  const currentCells = technicalCurrentness?.physicalCompositeConsumerCells ?? [];
  const cellIds = (cells) => cells.map((cell) => cell.cellId).sort();
  const topologyUnchanged = JSON.stringify(cellIds(predecessorCells)) === JSON.stringify(cellIds(currentCells))
    && predecessorCells.length === 50 && currentCells.length === 50
    && predecessorCells.every((cell) => {
      const current = currentCells.find((candidate) => candidate.cellId === cell.cellId);
      return current
        && current.surfaceId === cell.surfaceId
        && current.cellType === cell.cellType
        && isDeepStrictEqual(current.applicability, cell.applicability)
        && current.ownerGraphFingerprint === cell.ownerGraphFingerprint
        && current.physicalCatalogFingerprint === cell.physicalCatalogFingerprint
        && current.providerRegistryFingerprint === cell.providerRegistryFingerprint;
    });
  const valid = isDeepStrictEqual(JSON.parse(recordBytes.toString('utf8')), record)
    && record?.schemaVersion === 'media.discovery.pdp0-successor-source-impact.v1'
    && record?.recordId === 'MEDIA-DISCOVERY-PDP0-R11-SUCCESSOR-IMPACT-2026-10-14-R1'
    && record?.campaign?.repository === 'samujjwal/ghatana-media'
    && record?.campaign?.stage === 'DISCOVERY'
    && record?.campaign?.activePhase === 'PDP-0'
    && record?.campaign?.scope === 'Exact R11-to-successor PDP-1 generated decision-source inventory projection; no PDP-0 meaning change.'
    && record?.authority?.decisionRole === 'SCOPED_INTERNAL_PDP0_SOURCE_IMPACT_REVIEW'
    && record?.authority?.humanIndependentSignatureProvided === false
    && record?.authority?.externalContractOwnerAcceptanceProvided === false
    && record?.authority?.nativeLifecycleReceiptProvided === false
    && record?.predecessorCut?.phase === 'PDP-0'
    && record?.predecessorCut?.exitRef === pdp0R11ExitPath
    && record.predecessorCut.exitSha256 === predecessorExitSha256
    && record.predecessorCut.currentnessRef === pdp0R11CurrentnessPath
    && record.predecessorCut.currentnessSha256 === predecessorCurrentnessSha256
    && record.predecessorCut.materialSourceSetFingerprint === materialFingerprint
    && record.predecessorCut.materialPathCount === 146
    && isDeepStrictEqual(record.predecessorCut.topology, expectedTopology)
    && record?.sourceDeltas?.length === 1
    && record.sourceDeltas[0]?.path === sourcePath
    && record.sourceDeltas[0]?.phase === 'PDP-1'
    && record.sourceDeltas[0]?.classification === 'PDP1_DECISION_SOURCE_INVENTORY_PROJECTION_NO_PDP0_MEANING'
    && record.sourceDeltas[0]?.predecessorSha256 === predecessorSha256
    && record.sourceDeltas[0]?.observedSha256 === observedSha256
    && record.sourceDeltas[0]?.pdp0MeaningChange === 'NONE'
    && record.sourceDeltas[0]?.pdp0MeaningIdsChanged?.length === 0
    && record.sourceDeltas[0]?.freshCurrentnessRequired === true
    && record?.decision?.pdp0MeaningDisposition === 'NO_PDP0_MEANING_CHANGE'
    && record?.decision?.status === 'INTERNAL_SCOPED_NO_PDP0_MEANING_CHANGE_FOR_EXACT_R11_DELTA'
    && record?.decision?.ownerAcceptance === 'NOT_CLAIMED'
    && record?.decision?.independentSignoff === 'NOT_CLAIMED'
    && record?.decision?.lifecycleClosure === 'NOT_ENTERED'
    && record?.decision?.runtime === 'NOT_ADMITTED'
    && record?.decision?.delivery === 'BLOCKED'
    && record?.decision?.release === 'NOT_AUTHORIZED'
    && record?.decision?.freshTechnicalCurrentness === 'REQUIRED'
    && isDeepStrictEqual(record?.supportFileSha256s, expectedSupportFileHashes)
    && record?.limitations === 'This scoped internal disposition covers only the exact R11 generated candidate transition as a PDP-1 decision-source inventory projection with no PDP-0 meaning change. It does not claim owner acceptance, independent signoff, native Lifecycle receipt or closure, runtime admission, Delivery readiness, or release authorization.'
    && priorExit?.phase === 'PDP-0'
    && priorExit?.phaseExit?.status === 'PASS'
    && priorExit?.sourceCurrentness?.status === 'PASS'
    && priorExit?.sourceCurrentness?.sourceCurrent === true
    && priorExit?.developmentStatus?.status === 'DEV_COMPLETE'
    && priorExit?.developmentStatus?.outstandingMeaningIds?.length === 0
    && priorExit?.sourceCurrentness?.materialSourceSetFingerprint === materialFingerprint
    && priorCurrentness?.observationId === 'MEDIA-PDP0-CURRENTNESS-2026-10-14-CURRENT-CUT-R11'
    && priorCurrentness?.phaseDisposition?.currentSourceCurrentness === 'PASS'
    && priorCurrentness?.phaseDisposition?.sourceCurrent === true
    && priorCurrentness?.materialSourceSetFingerprint === materialFingerprint
    && priorCurrentness?.denominators?.totalCells === 50
    && priorExit?.sourceCurrentness?.denominators?.totalCells === 50
    && samePaths && topologyUnchanged
    && changed.length === 1
    && sourcePin?.recordedDigest === predecessorSha256
    && sourcePin?.currentDigest === observedSha256
    && sourcePin?.disposition === 'CHANGED'
    && currentCells.every((cell) => cell.sourceCurrentness === 'CURRENT' && (cell.blockers?.length ?? 0) === 0)
    && technicalCurrentness?.denominators?.totalCells === 50
    && technicalCurrentness?.materialPathDenominator?.uniquePaths === 146
    && technicalCurrentness?.lifecycleSourceCurrentness?.continuity === 'CONTINUOUS'
    && technicalCurrentness?.lifecycleSourceCurrentness?.consistencyStable === true
    && technicalCurrentness?.lifecycleSourceCurrentness?.zeroWorkEligibleAtCapture === true
    && hashBytes(fs.readFileSync(path.join(root, pdp0R11ExitPath))) === predecessorExitSha256
    && hashBytes(fs.readFileSync(path.join(root, pdp0R11CurrentnessPath))) === predecessorCurrentnessSha256;
  if (!valid) return null;
  return {
    path: sourcePath,
    classification: 'INTERNAL_PDP0_SUCCESSOR_IMPACT_DISPOSITION',
    authorityRef: recordPath,
    authoritySha256: hashBytes(recordBytes),
    predecessorSha256,
    observedSha256,
    meaningIdsChanged: [],
    ownerAcceptance: 'NOT_CLAIMED',
    independentSignoff: 'NOT_CLAIMED',
    lifecycleClosure: 'NOT_ENTERED',
    runtime: 'NOT_ADMITTED',
    delivery: 'BLOCKED',
  };
}

export function projectMediaPdp0PinDriftClassifications(classifications, pinComparisons) {
  return classifications.map((classification) => {
    const pin = pinComparisons.find((entry) => entry.path === classification.path);
    const hasImpactDelta = typeof classification.predecessorSha256 === 'string'
      && typeof classification.observedSha256 === 'string'
      && classification.predecessorSha256.startsWith('sha256:')
      && classification.observedSha256.startsWith('sha256:');
    return {
      ...classification,
      ...(hasImpactDelta ? { impactDelta: classification.impactDelta ?? {
        predecessorSha256: classification.predecessorSha256,
        observedSha256: classification.observedSha256,
      } } : {}),
      ...pin,
    };
  });
}

export function buildMediaPdp0CurrentnessPhaseDisposition(sourceCurrent, exactImpactDispositionCurrent, sourceDevelopmentCutCurrent = false) {
  const pdp0Exit = sourceCurrent
    ? sourceDevelopmentCutCurrent ? 'PASS_CURRENT_SOURCE_DEVELOPMENT_CUT_ONLY'
      : exactImpactDispositionCurrent ? 'PASS_INTERNAL_IMPACT_DISPOSITION_ONLY' : 'BLOCKED_PENDING_OWNER_ACCEPTANCE'
    : 'FAIL_SOURCE_CURRENTNESS';
  const discoveryBarrier = !sourceCurrent
    ? 'FAIL_PDP0_SOURCE_CURRENTNESS_AND_PDP1_PDP3_NOT_VALIDATED'
    : exactImpactDispositionCurrent || sourceDevelopmentCutCurrent
      ? 'FAIL_PDP1_PDP3_NOT_VALIDATED'
      : 'FAIL_PDP0_OWNER_ACCEPTANCE_PENDING_AND_PDP1_PDP3_NOT_VALIDATED';
  return {
    historicalDefinitionStatus: 'DEV_COMPLETE',
    historicalOutstandingMeaningIds: [],
    currentSourceCurrentness: sourceCurrent ? 'PASS' : 'FAIL',
    sourceCurrent,
    ownerAcceptance: 'NOT_OBTAINED',
    ownerAcceptanceClaim: 'NOT_CLAIMED',
    pdp0Exit,
    discoveryBarrier,
    build: 'NOT_ENTERED',
    pdpClosure: 'NOT_ENTERED',
    delivery: 'BLOCKED',
  };
}

export function buildMediaPdp0SuccessorImpactDisposition(record, recordPath, classified) {
  const pinClassifications = Array.isArray(classified)
    ? classified
    : Array.isArray(classified?.sourceClassifications) ? classified.sourceClassifications : [classified];
  return {
    recordId: record?.recordId ?? null,
    authorityRef: recordPath,
    authoritySha256: pinClassifications[0]?.authoritySha256 ?? null,
    localSourceClassifications: pinClassifications.map(({ path: sourcePath, classification, predecessorSha256, observedSha256 }) => ({
      path: sourcePath, classification, predecessorSha256, observedSha256,
    })),
    externalContractDisposition: classified?.externalContractDisposition ?? null,
    ownerAcceptance: 'NOT_CLAIMED',
    independentSignoff: 'NOT_CLAIMED',
    lifecycleClosure: 'NOT_ENTERED',
    runtime: 'NOT_ADMITTED',
    delivery: 'BLOCKED',
    release: 'NOT_AUTHORIZED',
  };
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

export function buildMediaPdp0CurrentnessObservation({ preserveExistingObservedAt = true, additionalImpactPath = null, successorImpactPath = null, sourceDevelopmentCutPath = null, observationOutputPath = outputPath } = {}) {
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
  // The Lifecycle capture intentionally emits repository file digests only.
  // PDP-0 status also pins exact decision-log sections and source projections;
  // project those selectors through the same owner source projector used by
  // readiness instead of misclassifying them as missing files.
  const phaseScopedPins = Object.fromEntries(Object.entries(pdp0PhaseScopedSourcePins()).map(([sourcePath, digest]) => [
    sourcePath,
    { digest: `sha256:${digest}` },
  ]));
  const historicalPinComparisons = phasePinComparison({ ...fullCurrentFiles, ...phaseScopedPins });
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
  const existing = fs.existsSync(path.join(root, observationOutputPath))
    ? JSON.parse(fs.readFileSync(path.join(root, observationOutputPath), 'utf8'))
    : null;
  const supplementalDecision = JSON.parse(fs.readFileSync(path.join(root, supplementalImpactPath), 'utf8'));
  const historicalDriftClassifications = [
    { path: '.product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md', classification: 'STATUS TEXT AND DOC LINK ONLY OBSERVED', authorityRef: 'MDO-02' },
    { path: '.product-experience/pdp-0-product-truth/generated/product-definition.candidate.json', classification: 'GENERATED PRODUCT DEFINITION CANDIDATE SOURCE DIGEST AND BYTE COUNT PROJECTION ONLY', authorityRef: 'MDO-03' },
    { path: 'docs/PRODUCT-DEFINITION-COVERAGE.md', classification: 'STATUS AND COVERAGE PROJECTION ONLY OBSERVED', authorityRef: 'MDO-03' },
    { path: '.product-experience/artifact-identities.yaml', classification: 'SOURCE INVENTORY ADDITIONS OBSERVED', authorityRef: 'MDO-03' },
    { path: '.product-experience/gaps.yaml', classification: 'DATED DISPOSITION AND HISTORICAL GAP WORDING OBSERVED', authorityRef: 'MDO-03' },
    { path: 'apps/media-experience-explorer/specification-artifacts.json', classification: 'GENERATED EXPLORER ARTIFACT INDEX OBSERVED', authorityRef: 'MDO-03' },
    { path: '.product-experience/source-manifest.yaml', classification: 'GENERATED SOURCE INDEX AND EXTERNAL OBSERVATIONS OBSERVED', authorityRef: 'MDO-03' },
  ];
  let isPxd164Successor = false;
  let isR11Successor = false;
  let isR12Successor = false;
  let isR12R2Successor = false;
  let isR12R3Successor = false;
  if (successorImpactPath) {
    const successorImpact = JSON.parse(fs.readFileSync(path.resolve(root, successorImpactPath), 'utf8'));
    isPxd164Successor = successorImpact?.recordId === 'MEDIA-DISCOVERY-PDP0-PXD164-SUCCESSOR-IMPACT-2026-10-14-R1';
    isR11Successor = successorImpact?.recordId === 'MEDIA-DISCOVERY-PDP0-R11-SUCCESSOR-IMPACT-2026-10-14-R1';
    isR12Successor = successorImpact?.recordId === 'MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R1';
    isR12R2Successor = successorImpact?.recordId === 'MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R2';
    isR12R3Successor = successorImpact?.recordId === 'MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R3';
    const predecessorObservationPath = isR12Successor || isR12R2Successor || isR12R3Successor ? pdp0R12CurrentnessPath
      : isPxd164Successor ? pdp0R10CurrentnessPath
        : isR11Successor ? pdp0R11CurrentnessPath : pdp0R8CurrentnessPath;
    const predecessorObservation = JSON.parse(fs.readFileSync(path.join(root, predecessorObservationPath), 'utf8'));
    if (isPxd164Successor) {
      const predecessorBytes = fs.readFileSync(path.join(root, predecessorObservationPath));
      if (hashBytes(predecessorBytes) !== 'sha256:1f2ee24f5913b8d9d9fc6d306a2d1356347f16e437e49de59e3f502643c83d0e') {
        throw new Error('PDP-0 PXD-164 successor requires the exact immutable R10 currentness predecessor');
      }
      historicalDriftClassifications.splice(0, historicalDriftClassifications.length,
        ...(predecessorObservation.historicalPdp0PinDriftClassifications ?? []));
    }
    if (isR11Successor) {
      if (hashBytes(fs.readFileSync(path.join(root, predecessorObservationPath))) !== 'sha256:b6986cd2e93241c9962d1215977c99f899949f87da15a72d8087e6ad130d7026') {
        throw new Error('PDP-0 R11 successor requires the exact immutable R11 currentness predecessor');
      }
      historicalDriftClassifications.splice(0, historicalDriftClassifications.length,
        ...(predecessorObservation.historicalPdp0PinDriftClassifications ?? []));
    }
    if (isR12Successor || isR12R2Successor || isR12R3Successor) {
      if (hashBytes(fs.readFileSync(path.join(root, predecessorObservationPath))) !== 'sha256:14882e245fa1676138cfc5bd51ef0403cb96cf2f77542caa2c57dc683ca8b159') {
        throw new Error('PDP-0 R12 successor requires the exact immutable R12 currentness predecessor');
      }
      historicalDriftClassifications.splice(0, historicalDriftClassifications.length,
        ...(predecessorObservation.historicalPdp0PinDriftClassifications ?? []));
    }
    const reporterCarryForward = predecessorObservation.historicalPdp0PinDriftClassifications?.find((entry) =>
      entry.path === 'scripts/report-media-pdp-readiness.mjs'
      && entry.classification === 'INTERNAL_PDP0_SUCCESSOR_IMPACT_DISPOSITION'
      && entry.currentDigest === sourceContentDigests[entry.path]
      && entry.authorityRef === 'docs/implementation/observations/media-discovery-pdp0-r6-successor-impact-2026-10-14-r1.json'
      && fs.existsSync(path.join(root, entry.authorityRef))
      && hashBytes(fs.readFileSync(path.join(root, entry.authorityRef))) === entry.authoritySha256);
    if (reporterCarryForward && !historicalDriftClassifications.some((entry) => entry.path === reporterCarryForward.path)) {
      historicalDriftClassifications.push(reporterCarryForward);
    }
  }
  const supplementalClassification = classifySupplementalPdp0PinChange(p0Comparison.pinComparisons, supplementalDecision);
  if (supplementalClassification) historicalDriftClassifications.push(supplementalClassification);
  const currentCutImpact = JSON.parse(fs.readFileSync(path.join(root, currentCutImpactPath), 'utf8'));
  const currentCutClassification = classifyCurrentCutPdp0PinChange(p0Comparison.pinComparisons, currentCutImpact);
  if (currentCutClassification) historicalDriftClassifications.push(currentCutClassification);
  let successorImpactDispositionCurrent = false;
  let successorImpactDisposition = null;
  let sourceDevelopmentSuccessorDisposition = null;
  if (sourceDevelopmentCutPath) {
    const normalizedCutPath = path.relative(root, path.resolve(root, sourceDevelopmentCutPath)).split(path.sep).join('/');
    if (path.isAbsolute(sourceDevelopmentCutPath) || normalizedCutPath === '..' || normalizedCutPath.startsWith('../')) {
      throw new Error('PDP-0 source-development cut path must resolve inside the repository');
    }
    const sourceDevelopmentCut = JSON.parse(fs.readFileSync(path.resolve(root, normalizedCutPath), 'utf8'));
    const sourceDevelopmentCurrentness = {
      phaseDisposition: { sourceCurrent, currentSourceCurrentness: sourceCurrent ? 'PASS' : 'FAIL' },
      denominators: resolved.denominator,
      physicalCompositeConsumerCells: currentCellRecords,
      sourceContentDigests,
      materialPathDenominator: {
        uniquePaths: Object.keys(sourceContentDigests).length,
        sharedPaths: sharedMaterialPaths.length,
        cellSpecificPaths: Object.keys(sourceContentDigests).length - sharedMaterialPaths.length,
      },
      materialSourceSetFingerprint,
    };
    if (!validateMediaPdp0SourceDevelopmentCurrentCut(sourceDevelopmentCut, {
      repositoryRoot: root,
      currentness: sourceDevelopmentCurrentness,
      technicalPeerReview: sourceDevelopmentCut.technicalPeerReview,
    })) {
      throw new Error('PDP-0 source-development successor does not bind the exact current 54/207 source cut');
    }
    sourceDevelopmentSuccessorDisposition = {
      recordId: sourceDevelopmentCut.recordId,
      authorityRef: normalizedCutPath,
      authoritySha256: hashBytes(fs.readFileSync(path.resolve(root, normalizedCutPath))),
      classification: sourceDevelopmentCut.sourceDevelopment.classification,
      sourceSetFingerprint: sourceDevelopmentCut.currentCut.materialSourceSetFingerprint,
      currentStatusSha256: sourceDevelopmentCut.currentCut.sourceStatusSha256,
      technicalSourceAuthor: sourceDevelopmentCut.authority.technicalSourceAuthor,
      technicalPeerReviewer: sourceDevelopmentCut.technicalPeerReview.reviewer,
      ownerAcceptance: sourceDevelopmentCut.authority.ownerAcceptance,
      independentAcceptance: sourceDevelopmentCut.authority.independentAcceptance,
      nativeLifecycleReceipt: sourceDevelopmentCut.authority.nativeLifecycleReceipt,
    };
  }
  if (additionalImpactPath) {
    const normalizedImpactPath = path.relative(root, path.resolve(root, additionalImpactPath)).split(path.sep).join('/');
    if (path.isAbsolute(additionalImpactPath) || normalizedImpactPath === '..' || normalizedImpactPath.startsWith('../')) {
      throw new Error('Additional PDP-0 source-impact path must resolve inside the repository');
    }
    const additionalImpact = JSON.parse(fs.readFileSync(path.resolve(root, normalizedImpactPath), 'utf8'));
    const additionalClassification = classifyAdditionalPdp0SourceImpact(p0Comparison.pinComparisons, additionalImpact, normalizedImpactPath);
    if (additionalClassification) historicalDriftClassifications.push(additionalClassification);
  }
  if (successorImpactPath) {
    const normalizedImpactPath = path.relative(root, path.resolve(root, successorImpactPath)).split(path.sep).join('/');
    if (path.isAbsolute(successorImpactPath) || normalizedImpactPath === '..' || normalizedImpactPath.startsWith('../')) {
      throw new Error('PDP-0 successor impact path must resolve inside the repository');
    }
    const successorImpact = JSON.parse(fs.readFileSync(path.resolve(root, normalizedImpactPath), 'utf8'));
    const predecessorExitPath = resolveMediaPdp0SuccessorPredecessorExitPath(successorImpact);
    const predecessorExit = JSON.parse(fs.readFileSync(path.join(root, predecessorExitPath), 'utf8'));
    const predecessorDigests = predecessorExit.sourceCurrentness?.sourceContentDigests ?? {};
    const predecessorPinComparisons = Object.keys(predecessorDigests).sort().map((sourcePath) => ({
      path: sourcePath,
      recordedDigest: predecessorDigests[sourcePath],
      currentDigest: sourceContentDigests[sourcePath] ?? null,
      disposition: (sourceContentDigests[sourcePath] ?? null) === predecessorDigests[sourcePath] ? 'MATCH' : 'CHANGED',
    }));
    const successorClassification = classifyPdp0SuccessorImpact(predecessorPinComparisons, successorImpact, normalizedImpactPath, {
      denominators: resolved.denominator,
      physicalCompositeConsumerCells: currentCellRecords,
      materialPathDenominator: {
        uniquePaths: Object.keys(sourceContentDigests).length,
        sharedPaths: sharedMaterialPaths.length,
        cellSpecificPaths: Object.keys(sourceContentDigests).length - sharedMaterialPaths.length,
      },
      lifecycleSourceCurrentness: {
        continuity: currentness.continuity,
        consistencyStable,
        zeroWorkEligibleAtCapture: currentness.zeroWorkEligible,
        blockers: [...new Set([...currentness.blockers, ...(consistencyStable ? [] : ['POST_CAPTURE_SOURCE_OR_LIFECYCLE_STATE_CHANGED'])])],
      },
    });
    if (successorClassification) {
      const pinClassifications = Array.isArray(successorClassification)
        ? [...successorClassification]
        : Array.isArray(successorClassification.sourceClassifications)
          ? successorClassification.sourceClassifications : [successorClassification];
      historicalDriftClassifications.push(...pinClassifications);
      successorImpactDispositionCurrent = true;
      successorImpactDisposition = buildMediaPdp0SuccessorImpactDisposition(successorImpact, normalizedImpactPath, successorClassification);
    }
    if (!isPxd164Successor && !isR11Successor && !isR12Successor && !isR12R2Successor && !isR12R3Successor) {
      const pxd163Impact = JSON.parse(fs.readFileSync(path.join(root, pdp0Pxd163ImpactPath), 'utf8'));
      const pxd163Classification = classifyAdditionalPdp0SourceImpact(p0Comparison.pinComparisons, pxd163Impact, pdp0Pxd163ImpactPath);
      if (pxd163Classification) historicalDriftClassifications.push(pxd163Classification);
    }
  }
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
    observationId: observationOutputPath === successorOutputPath
      ? 'MEDIA-PDP0-CURRENTNESS-2026-10-14-CURRENT-CUT-R10'
      : /media-discovery-pdp0-currentness-2026-10-14-current-cut-(r\d+)\.json$/u.exec(observationOutputPath)
        ? `MEDIA-PDP0-CURRENTNESS-2026-10-14-CURRENT-CUT-${/media-discovery-pdp0-currentness-2026-10-14-current-cut-(r\d+)\.json$/u.exec(observationOutputPath)[1].toUpperCase()}`
        : 'MEDIA-PDP0-CURRENTNESS-2026-10-13',
    observedAt: preserveExistingObservedAt ? (existing?.observedAt ?? new Date().toISOString()) : new Date().toISOString(),
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
    historicalPdp0PinDriftClassifications: projectMediaPdp0PinDriftClassifications(historicalDriftClassifications, p0Comparison.pinComparisons),
    successorImpactDisposition,
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
    sourceDevelopmentSuccessorDisposition,
    phaseDisposition: buildMediaPdp0CurrentnessPhaseDisposition(sourceCurrent, currentCutClassification !== null || successorImpactDispositionCurrent, sourceDevelopmentSuccessorDisposition !== null),
    limitations: [
      'The historical PDP-0 DEV_COMPLETE record remains anchored at its recorded source cut and is not rewritten.',
      'This observation does not assert independent semantic acceptance, Lifecycle closure, Build entry, or Delivery readiness.',
      'Later PDP phases remain unvalidated until the PDP-0 exit gate is formally accepted.',
    ],
  };
  return {
    observation,
    summary: {
      outputPath: observationOutputPath,
      sourceCurrent,
      sourceCellCurrentCount: currentness.cells.filter((cell) => cell.sourceCurrentness === 'CURRENT').length,
      sourceCellUnknownCount: currentness.cells.filter((cell) => cell.sourceCurrentness === 'UNKNOWN').length,
      historicalPdp0PinCounts: p0Comparison.currentPinCounts,
      externalContractCounts: { total: external.totalFiles, matched: external.digestMatches, mismatched: external.digestMismatches.length },
      consistencyStable,
      blockers: observation.lifecycleSourceCurrentness.blockers,
      pdp0Exit: observation.phaseDisposition.pdp0Exit,
    },
  };
}

function main() {
  const successorImpactMode = process.argv[2] === '--successor-impact';
  const sourceDevelopmentCutMode = process.argv[2] === '--source-development-cut';
  const impactPath = successorImpactMode || sourceDevelopmentCutMode ? process.argv[3] ?? null : process.argv[2] ?? null;
  const requestedSuffix = successorImpactMode || sourceDevelopmentCutMode ? process.argv[4] ?? null : null;
  if (successorImpactMode && (!impactPath || process.argv[5])) {
    throw new Error('Usage: node scripts/record-media-discovery-pdp0-currentness.mjs --successor-impact <impact-json> [output-suffix]');
  }
  if (sourceDevelopmentCutMode && (!impactPath || process.argv[5])) {
    throw new Error('Usage: node scripts/record-media-discovery-pdp0-currentness.mjs --source-development-cut <current-cut-json> [output-suffix]');
  }
  const impactRecord = successorImpactMode ? JSON.parse(fs.readFileSync(path.resolve(root, impactPath), 'utf8')) : null;
  const successorSuffix = successorImpactMode
    ? resolveMediaPdp0SuccessorCurrentnessSuffix(impactRecord?.recordId, requestedSuffix)
    : sourceDevelopmentCutMode
      ? resolveMediaPdp0SourceDevelopmentCurrentnessSuffix(JSON.parse(fs.readFileSync(path.resolve(root, impactPath), 'utf8'))?.recordId, requestedSuffix)
      : requestedSuffix;
  const destinationPath = resolveMediaPdp0CurrentnessOutputPath(successorImpactMode || sourceDevelopmentCutMode, successorSuffix);
  const immutableOutput = successorImpactMode || sourceDevelopmentCutMode;
  const destination = immutableOutput
    ? assertMediaPdp0CurrentnessOutputAvailable(destinationPath)
    : path.join(root, destinationPath);
  const { observation, summary } = buildMediaPdp0CurrentnessObservation({
    preserveExistingObservedAt: !immutableOutput,
    additionalImpactPath: successorImpactMode || sourceDevelopmentCutMode ? null : impactPath,
    successorImpactPath: successorImpactMode ? impactPath : null,
    sourceDevelopmentCutPath: sourceDevelopmentCutMode ? impactPath : null,
    observationOutputPath: destinationPath,
  });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(observation, null, 2)}\n`, { flag: immutableOutput ? 'wx' : 'w' });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
