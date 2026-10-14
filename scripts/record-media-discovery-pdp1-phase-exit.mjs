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
import { buildPdp1SourceCensus } from './report-media-pdp-readiness.mjs';
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
const COMMON_PDP1_REFS = [
  '.product-experience/source-manifest.yaml',
  '.product-experience/surface-registry.yaml',
  '.product-experience/surfaces/media-physical-topology.v1.json',
  '.product-experience/decision-log.md',
  '.product-experience/reviews/2026-10-13-discovery-delegated-owner-decision-and-authorizations.md',
  '.product-experience/pdp-1-domain-data/',
  '.product-experience/interface-parity/',
  'package.json',
  'pnpm-lock.yaml',
  'scripts/check-media-contract-parity.mjs',
  'scripts/report-media-pdp-readiness.mjs',
  'tests/media-pdp-p1-dev-status.test.mjs',
  'tests/media-contract-parity.test.mjs',
  'tests/media-contract-parity-definition-only-cli.test.mjs',
  'tests/pdp1-owner-action-wire-contracts.test.mjs',
  'tests/pdp1-transition-guard-definition-evaluator.test.mjs',
];
const REQUIRED_TEST_COMMAND = 'node --test tests/media-pdp-p1-dev-status.test.mjs tests/media-contract-parity.test.mjs tests/media-contract-parity-definition-only-cli.test.mjs tests/pdp1-owner-action-wire-contracts.test.mjs tests/pdp1-transition-guard-definition-evaluator.test.mjs tests/pdp-truth-domain-typed-observations.test.mjs';
const REQUIRED_DEFINITION_ONLY_COMMAND = 'node scripts/check-media-contract-parity.mjs --definition-only';
const REQUIRED_STRICT_COMMAND = 'pnpm check:contract-parity';
const REQUIRED_LOCAL_EXPERIENCE_COMMAND = 'pnpm check:product-experience-local';
const HISTORICAL_PDP1_EXIT_PATH = 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-13-r3.json';
const CURRENT_CUT_OWNER_DIRECTIONS_PATH = 'docs/implementation/observations/media-discovery-current-cut-owner-directions-2026-10-13-r2.json';
const PDP3_STATUS_GUARD_IMPACT_PATH = 'docs/implementation/observations/media-discovery-predecessor-impact-pdp3-status-guard-2026-10-14-r1.json';
const PDP1_ADAPTER_TEST_IMPACT_PATH = 'docs/implementation/observations/media-discovery-pdp1-adapter-test-pin-impact-2026-10-14-r1.json';
const PDP1_GUARD_PATH = 'scripts/report-media-pdp-readiness.mjs';
const PDP1_GUARD_PREDECESSOR_DIGEST = 'sha256:6655e0344b7f4b03f6ca0b7e594a5448eed72ae5aeac198cef4bb1b28252028c';
const PDP1_GUARD_OBSERVED_DIGEST = 'sha256:f3482cf689e0be2d8dc9faf9ccc72a1b63a1dcaecd056efaa1759e6f3696a5e1';
const PDP1_ADAPTER_TEST_PATH = 'tests/pdp-experience-capability-invocation-adapters.test.mjs';
const PDP1_ADAPTER_TEST_PREDECESSOR_DIGEST = 'sha256:b3fed6206114180160768270461e0c0175adfd0938e3029238a265ae6ef843b5';
const PDP1_ADAPTER_TEST_OBSERVED_DIGEST = 'sha256:a062b06080d9aeb0b3bd0695aaa2affca0aca8583fe020bdcadcaa2a5b98e5ed';
const PDP1_ADAPTER_TEST_COMMAND = 'node --test tests/pdp-experience-capability-invocation-adapters.test.mjs';
const PDP1_OPERATIONS_PATH = '.product-experience/pdp-1-domain-data/operations.yaml';
const PDP1_OPERATIONS_REVIEW_PATH = '.product-experience/pdp-1-domain-data/operations-current-source-review.json';
const PDP1_OPERATIONS_PREDECESSOR_DIGEST = 'sha256:11d51ef9cdc69e2dde09b3a72241a19a321be40372b19850e4d29c3ec2fb3e04';
const PDP1_OPERATIONS_REVIEW_PREDECESSOR_DIGEST = 'sha256:c73e44c375c9b20a120e63200065484775ded0d4749057b45a2aa7d773f54c69';
const PDP1_OPERATIONS_OBSERVED_DIGEST = 'sha256:317878be9ebe9c978f356a4e81060620fcb69af02ea25c2ff1d47bd20180c069';
const PDP1_OPERATIONS_REVIEW_OBSERVED_DIGEST = 'sha256:71a27400d00faccba8643393259c1322861593783015426b6eeddbcf068afaf2';
const CURRENT_CUT_OWNER_DIRECTIONS_DIGEST = 'sha256:4dc505154364b4ef98836e327cc556f1d24adf937d964913caba09c49c4176a4';
const CURRENT_CUT_PDP1_OWNER_CHANGE_PATHS = [
  '.product-experience/reviews/2026-10-13-discovery-delegated-owner-decision-and-authorizations.md',
  '.product-experience/source-manifest.yaml',
  '.product-experience/surface-registry.yaml',
  'apps/media-experience-explorer/specification-artifacts.json',
];
const PDP1_OPERATION_DELTA_IDS = [
  'media.observation-contract.rights-decision.v1',
  'media.observation-contract.destination-delivery-acknowledgment.v1',
  'media.observation-contract.delegated-integration-result-context.v1',
  'media.observation-contract.processing-parameter-read.v1',
  'media.observation-contract.effective-processing-constraints.v1',
];
const PDP1_PARITY_TEST_IMPACT_PATH = 'docs/implementation/observations/media-discovery-pdp1-parity-test-pin-impact-2026-10-14-r1.json';
const CURRENT_CUT_SOURCE_IMPACT_PATH = 'docs/implementation/observations/media-discovery-current-cut-source-impact-2026-10-14-r1.json';
const CURRENT_CUT_PDP0_SUCCESSOR_PATH = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r5.json';
const CURRENT_CUT_SOURCE_PATHS = [
  'scripts/report-media-pdp-readiness.mjs',
  '.product-experience/interface-parity/current-source-review.json',
  'tests/media-pdp-p1-dev-status.test.mjs',
];
const CURRENT_CUT_SOURCE_PREDECESSOR_DIGESTS = {
  'scripts/report-media-pdp-readiness.mjs': 'sha256:f3482cf689e0be2d8dc9faf9ccc72a1b63a1dcaecd056efaa1759e6f3696a5e1',
  '.product-experience/interface-parity/current-source-review.json': 'sha256:14cf6c3d9ea948e39e41ffa2de3453c08b7b6a23267f407f3504c5462b7428fc',
  'tests/media-pdp-p1-dev-status.test.mjs': 'sha256:5a007a561cc96659d7da63d2470727237d1496c3a50c80682253a9d542846599',
};
const CURRENT_CUT_SOURCE_OBSERVED_DIGESTS = {
  'scripts/report-media-pdp-readiness.mjs': 'sha256:ca59f6c4e1313bd58387f91b41eb51fc1a10ac04b2db01faed30b9edcc9b2573',
  '.product-experience/interface-parity/current-source-review.json': 'sha256:62765cbb335572f28570fe650b3955aaa028f314322490e17e466d3ca9234abf',
  'tests/media-pdp-p1-dev-status.test.mjs': 'sha256:3ff1576a4a3987f5b1e05d15ae77e35a62745260e127ebcb28c1bb49ef7ef82e',
};
const CURRENT_CUT_PDP1_TEST_COMMAND = REQUIRED_TEST_COMMAND;
const PDP1_PARITY_TEST_PATHS = [
  'tests/media-contract-parity.test.mjs',
  'tests/media-contract-parity-definition-only-cli.test.mjs',
];
const REQUIRED_TEST_FILES = [
  'tests/media-pdp-p1-dev-status.test.mjs',
  'tests/media-contract-parity.test.mjs',
  'tests/media-contract-parity-definition-only-cli.test.mjs',
  'tests/pdp1-owner-action-wire-contracts.test.mjs',
  'tests/pdp1-transition-guard-definition-evaluator.test.mjs',
  'tests/pdp-truth-domain-typed-observations.test.mjs',
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
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  return {
    exitCode: result.status ?? 127,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function parseTestOutcome(command, result) {
  const output = `${result.stdout}\n${result.stderr}`;
  const outcome = {
    command,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutSha256: sha256(result.stdout),
    stderrSha256: sha256(result.stderr),
  };
  if (command === REQUIRED_TEST_COMMAND) {
    const tests = output.match(/(?:ℹ|#)\s+tests\s+(\d+)/u);
    const passed = output.match(/(?:ℹ|#)\s+pass\s+(\d+)/u);
    const failed = output.match(/(?:ℹ|#)\s+fail\s+(\d+)/u);
    const skipped = output.match(/(?:ℹ|#)\s+skipped\s+(\d+)/u);
    Object.assign(outcome, {
      status: result.exitCode === 0 ? 'PASS' : 'FAIL',
      testCount: tests ? Number(tests[1]) : null,
      passedCount: passed ? Number(passed[1]) : null,
      failedCount: failed ? Number(failed[1]) : null,
      skippedCount: skipped ? Number(skipped[1]) : null,
    });
  } else {
    const sourceFindings = output.match(/source findings audited:\s*(\d+)\s*\((\d+) dispositioned;\s*(\d+) unresolved\)/u);
    const historicalFindings = output.match(/historical source findings:\s*(\d+)\s*\((\d+) dispositioned;\s*(\d+) unresolved;\s*(\d+) retired routes\)/u);
    Object.assign(outcome, {
      status: command === REQUIRED_STRICT_COMMAND
        ? (result.exitCode === 1 ? 'NON_GREEN_EXPECTED_OWNER_ADMISSION_FINDING' : 'UNEXPECTED_RESULT')
        : (result.exitCode === 0 ? 'PASS' : 'FAIL'),
      sourceFindings: sourceFindings ? {
        audited: Number(sourceFindings[1]), dispositioned: Number(sourceFindings[2]), unresolved: Number(sourceFindings[3]),
      } : null,
      historicalFindings: historicalFindings ? {
        audited: Number(historicalFindings[1]), dispositioned: Number(historicalFindings[2]), unresolved: Number(historicalFindings[3]), retiredRoutes: Number(historicalFindings[4]),
      } : null,
      unresolvedFinding: output.match(/^\s*- semantic binding unresolved:\s*(.+)$/mu)?.[1]?.trim().replace(/;{2,}/gu, ';') ?? null,
    });
  }
  return outcome;
}

function snapshotPdp1Logs() {
  const directory = path.join(root, 'docs/implementation/verification/pdp-38');
  return new Map(fs.readdirSync(directory)
    .filter((entry) => /^P1-.*\.log$/u.test(entry))
    .map((entry) => [path.join(directory, entry), fs.readFileSync(path.join(directory, entry))]));
}

function runRequiredChecks(dimensions) {
  const startedHead = git(['rev-parse', 'HEAD']);
  const localCheckInputBefore = sha256(fs.readFileSync(path.join(root, 'scripts/check-product-experience-local.mjs')));
  const priming = [captureRepositorySourceCurrentness(root, dimensions), captureRepositorySourceCurrentness(root, dimensions)];
  const before = captureRepositorySourceCurrentness(root, dimensions);
  const pdp1LogsBefore = snapshotPdp1Logs();
  const testResult = runCommand(process.execPath, ['--test', ...REQUIRED_TEST_FILES]);
  const localExperienceResult = runCommand('pnpm', ['check:product-experience-local']);
  const strictResult = runCommand('pnpm', ['check:contract-parity']);
  const definitionResult = runCommand(process.execPath, ['scripts/check-media-contract-parity.mjs', '--definition-only']);
  const generatedLogChanges = [];
  for (const [absolutePath, priorContents] of pdp1LogsBefore) {
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
  const testOutcomes = [
    parseTestOutcome(REQUIRED_TEST_COMMAND, testResult),
    parseTestOutcome(REQUIRED_LOCAL_EXPERIENCE_COMMAND, localExperienceResult),
    parseTestOutcome(REQUIRED_STRICT_COMMAND, strictResult),
    parseTestOutcome(REQUIRED_DEFINITION_ONLY_COMMAND, definitionResult),
  ];
  const localCheckInputAfter = sha256(fs.readFileSync(path.join(root, 'scripts/check-product-experience-local.mjs')));
  return {
    runner: 'scripts/record-media-discovery-pdp1-phase-exit.mjs',
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
      testInputContentDigests: Object.fromEntries(REQUIRED_TEST_FILES.map((sourcePath) => [sourcePath, sha256(fs.readFileSync(path.join(root, sourcePath)))])),
      localExperienceCheckInput: {
        path: 'scripts/check-product-experience-local.mjs',
        sha256Before: localCheckInputBefore,
        sha256After: localCheckInputAfter,
        stable: localCheckInputBefore === localCheckInputAfter,
      },
    },
    testOutcomes,
  };
}

function validateReporterImpactRecord(impact, observedDigests, historicalDigests, statusPins, semanticPins) {
  const receiptPath = 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r4.json';
  const receipt = readJson(receiptPath);
  const receiptDigest = sha256(fs.readFileSync(path.join(root, receiptPath)));
  const cut = impact.predecessorCuts?.find((entry) => entry.phase === 'PDP-1');
  const delta = impact.sourceDelta;
  const valid = impact.schemaVersion === 'media.discovery-predecessor-source-impact.v1'
    && impact.recordId === 'MEDIA-DISCOVERY-PREDECESSOR-IMPACT-PDP3-STATUS-GUARD-2026-10-14-R1'
    && impact.campaign?.repository === 'samujjwal/ghatana-media'
    && impact.campaign?.stage === 'DISCOVERY'
    && impact.campaign?.activePhase === 'PDP-0'
    && impact.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION'
    && impact.authority?.authorityRef === '.product-experience/reviews/2026-10-13-discovery-current-cut-delegated-owner-review.md#Authority-and-attribution'
    && impact.authority?.decisionRole === 'SCOPED_INTERNAL_MEDIA_PRODUCT_AND_ENGINEERING_SOURCE_IMPACT_REVIEW'
    && impact.authority?.humanIndependentSignatureProvided === false
    && impact.authority?.qualifiedExternalSpecialistSignoffProvided === false
    && impact.authority?.externalContractOwnerAcceptanceProvided === false
    && impact.authority?.nativeLifecycleReceiptProvided === false
    && delta?.path === PDP1_GUARD_PATH
    && delta?.predecessorSha256 === PDP1_GUARD_PREDECESSOR_DIGEST
    && delta?.observedSha256 === PDP1_GUARD_OBSERVED_DIGEST
    && Array.isArray(delta?.changedFunctions)
    && delta.changedFunctions.length === 2
    && delta.changedFunctions[0] === 'buildPdp3SourceCensus'
    && delta.changedFunctions[1] === 'buildPdp3DevStatus'
    && delta?.predecessorPhaseMeaningDisposition?.['PDP-1'] === 'NO_MEANING_CHANGE'
    && Array.isArray(delta?.changedMeaningIds) && delta.changedMeaningIds.length === 0
    && Array.isArray(delta?.outstandingPredecessorMeaningIds) && delta.outstandingPredecessorMeaningIds.length === 0
    && delta?.freshCurrentnessRequired === true
    && cut?.receiptRef === receiptPath
    && cut?.receiptSha256 === receiptDigest
    && cut?.materialSourceSetFingerprint === 'sha256:1da1c83eda4ad1f4bed0ad35c27564887ca06b05ea2251a7f1f8b49e1c9176d5'
    && cut?.materialPathCount === 329
    && cut?.recordedPathDigest === PDP1_GUARD_PREDECESSOR_DIGEST
    && receipt.phase === 'PDP-1'
    && receipt.sourceCurrentness?.materialSourceSetFingerprint === cut.materialSourceSetFingerprint
    && Object.keys(receipt.sourceCurrentness?.sourceContentDigests ?? {}).length === 329
    && receipt.sourceCurrentness.sourceContentDigests[PDP1_GUARD_PATH] === PDP1_GUARD_PREDECESSOR_DIGEST
    && `sha256:${String(statusPins[PDP1_GUARD_PATH] ?? '').replace(/^sha256:/u, '')}` === PDP1_GUARD_PREDECESSOR_DIGEST
    && `sha256:${String(semanticPins[PDP1_GUARD_PATH] ?? '').replace(/^sha256:/u, '')}` === PDP1_GUARD_PREDECESSOR_DIGEST
    && impact.decision?.status === 'APPROVED_INTERNAL_NON_IMPACT_FOR_EXACT_SOURCE_DELTA'
    && impact.decision?.reusePriorPdp0Pdp1Pdp2Meaning === true
    && impact.decision?.preserveHistoricalReceipts === true
    && impact.decision?.independentApproval === 'NOT_CLAIMED_AND_NOT_WAIVED'
    && impact.decision?.nativeLifecycleClosure === 'NOT_ENTERED'
    && impact.decision?.build === 'NOT_ENTERED'
    && impact.decision?.delivery === 'BLOCKED'
    && JSON.stringify(impact.decision?.requiresOrderedTechnicalCurrentnessRecapture) === JSON.stringify(['PDP-0', 'PDP-1', 'PDP-2'])
    && (observedDigests[PDP1_GUARD_PATH]?.digest ?? observedDigests[PDP1_GUARD_PATH]) === PDP1_GUARD_OBSERVED_DIGEST
    && historicalDigests[PDP1_GUARD_PATH] === PDP1_GUARD_PREDECESSOR_DIGEST;
  return { valid, impact, path: PDP1_GUARD_PATH, predecessorSha256: PDP1_GUARD_PREDECESSOR_DIGEST, observedSha256: PDP1_GUARD_OBSERVED_DIGEST };
}

export function validateCurrentCutSourceImpactRecord(impact, observedDigests, historicalDigests, statusPins, semanticPins, testRun) {
  const impactDigest = sha256(fs.readFileSync(path.join(root, CURRENT_CUT_SOURCE_IMPACT_PATH)));
  const deltas = impact.sourceDeltas ?? [];
  const byPath = new Map(deltas.map((delta) => [delta.path, delta]));
  const oldGuardImpact = readJson(PDP3_STATUS_GUARD_IMPACT_PATH);
  const oldGuardImpactDigest = sha256(fs.readFileSync(path.join(root, PDP3_STATUS_GUARD_IMPACT_PATH)));
  const chainedReporter = deltas.find((delta) => delta.path === PDP1_GUARD_PATH);
  const oldGuardStep = chainedReporter?.predecessorChain?.[0];
  const oldReporterStatusPins = { ...statusPins, [PDP1_GUARD_PATH]: PDP1_GUARD_PREDECESSOR_DIGEST.slice('sha256:'.length) };
  const oldReporterSemanticPins = { ...semanticPins, [PDP1_GUARD_PATH]: PDP1_GUARD_PREDECESSOR_DIGEST.slice('sha256:'.length) };
  const oldReporterCheck = validateReporterImpactRecord(
    oldGuardImpact,
    { ...observedDigests, [PDP1_GUARD_PATH]: PDP1_GUARD_OBSERVED_DIGEST },
    historicalDigests,
    oldReporterStatusPins,
    oldReporterSemanticPins,
  );
  const requiredOutcome = (testRun?.outcomes ?? testRun?.testOutcomes)?.find((entry) => entry.command === CURRENT_CUT_PDP1_TEST_COMMAND);
  const requiredInputDigests = testRun?.testInputContentDigests ?? testRun?.sourceBinding?.testInputContentDigests ?? {};
  const testEvidenceValid = testRun?.sourceBinding?.stable === true
    && testRun?.startedHead === testRun?.completedHead
    && requiredOutcome?.status === 'PASS'
    && requiredOutcome?.exitCode === 0
    && Number.isInteger(requiredOutcome?.testCount)
    && requiredOutcome.testCount > 0
    && requiredOutcome.passedCount === requiredOutcome.testCount
    && requiredOutcome.failedCount === 0
    && requiredOutcome.skippedCount === 0
    && REQUIRED_TEST_FILES.every((sourcePath) => requiredInputDigests[sourcePath]
      === sha256(fs.readFileSync(path.join(root, sourcePath))));
  const interfacePath = '.product-experience/interface-parity/current-source-review.json';
  const statusTestPath = 'tests/media-pdp-p1-dev-status.test.mjs';
  const reporter = byPath.get(PDP1_GUARD_PATH);
  const interfaceReview = byPath.get(interfacePath);
  const statusTest = byPath.get(statusTestPath);
  const exactPaths = deltas.length === CURRENT_CUT_SOURCE_PATHS.length
    && deltas.every((delta, index) => delta.path === CURRENT_CUT_SOURCE_PATHS[index])
    && new Set(deltas.map((delta) => delta.path)).size === CURRENT_CUT_SOURCE_PATHS.length;
  const exactHashes = CURRENT_CUT_SOURCE_PATHS.every((sourcePath) => {
    const delta = byPath.get(sourcePath);
    return delta
      && delta.predecessorSha256 === CURRENT_CUT_SOURCE_PREDECESSOR_DIGESTS[sourcePath]
      && delta.observedSha256 === CURRENT_CUT_SOURCE_OBSERVED_DIGESTS[sourcePath]
      && delta.observedSha256 === (observedDigests[sourcePath]?.digest ?? observedDigests[sourcePath])
      && historicalDigests[sourcePath] === (sourcePath === PDP1_GUARD_PATH
        ? PDP1_GUARD_PREDECESSOR_DIGEST : CURRENT_CUT_SOURCE_PREDECESSOR_DIGESTS[sourcePath])
      && `sha256:${String(statusPins[sourcePath] ?? '').replace(/^sha256:/u, '')}` === delta.observedSha256
      && `sha256:${String(semanticPins[sourcePath] ?? '').replace(/^sha256:/u, '')}` === delta.observedSha256;
  });
  const valid = impact.schemaVersion === 'media.discovery-current-cut-source-impact.v1'
    && impact.recordId === 'MEDIA-DISCOVERY-CURRENT-CUT-SOURCE-IMPACT-2026-10-14-R1'
    && impact.campaign?.repository === 'samujjwal/ghatana-media'
    && impact.campaign?.stage === 'DISCOVERY'
    && impact.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION'
    && impact.authority?.authorityRef === '.product-experience/reviews/2026-10-13-discovery-current-cut-delegated-owner-review.md#Authority-and-attribution'
    && impact.authority?.decisionRole === 'SCOPED_INTERNAL_MEDIA_SOURCE_IMPACT_REVIEW'
    && impact.authority?.humanIndependentSignatureProvided === false
    && impact.authority?.qualifiedExternalSpecialistSignoffProvided === false
    && impact.authority?.externalContractOwnerAcceptanceProvided === false
    && impact.authority?.nativeLifecycleReceiptProvided === false
    && exactPaths && exactHashes
    && reporter?.classification === 'PDP_STATUS_TEST_REPORTER_SELECTION_ONLY'
    && Array.isArray(reporter.changedFunctions)
    && JSON.stringify(reporter.changedFunctions) === JSON.stringify(['buildP103TestArgs', 'runRequiredChecks'])
    && Array.isArray(reporter.meaningIdsChanged) && reporter.meaningIdsChanged.length === 0
    && reporter.predecessorChain?.length === 1
    && oldGuardStep?.receiptRef === PDP3_STATUS_GUARD_IMPACT_PATH
    && oldGuardStep?.receiptSha256 === oldGuardImpactDigest
    && oldGuardStep?.fromSha256 === PDP1_GUARD_PREDECESSOR_DIGEST
    && oldGuardStep?.toSha256 === PDP1_GUARD_OBSERVED_DIGEST
    && oldReporterCheck.valid
    && interfaceReview?.classification === 'PDP1_REVIEW_ARTIFACT_REFRESH_FOR_SEPARATELY_REVIEWED_OPERATION_DELTA'
    && interfaceReview.relatedDefinitionSource === PDP1_OPERATIONS_PATH
    && interfaceReview.relatedDefinitionSha256 === PDP1_OPERATIONS_OBSERVED_DIGEST
    && interfaceReview.relatedDefinitionReviewSource === PDP1_OPERATIONS_REVIEW_PATH
    && interfaceReview.relatedDefinitionReviewSha256 === PDP1_OPERATIONS_REVIEW_OBSERVED_DIGEST
    && JSON.stringify(interfaceReview.relatedReviewedDefinitionIds) === JSON.stringify(PDP1_OPERATION_DELTA_IDS)
    && Array.isArray(interfaceReview.additionalMeaningIds) && interfaceReview.additionalMeaningIds.length === 0
    && interfaceReview.meaningChange === 'NO_ADDITIONAL_MEANING_BEYOND_SEPARATELY_REVIEWED_PDP1_OPERATION_DELTA'
    && interfaceReview.requiresFreshCurrentness === true
    && statusTest?.classification === 'REGRESSION_COVERAGE'
    && statusTest?.meaningChange === 'NONE'
    && Array.isArray(statusTest.meaningIdsChanged) && statusTest.meaningIdsChanged.length === 0
    && statusTest.requiresFreshCurrentness === true
    && testEvidenceValid
    && impact.requiredEvidence?.command === CURRENT_CUT_PDP1_TEST_COMMAND
    && impact.requiredEvidence?.status === 'PASS_AT_R10_AND_RERUN_DURING_SUCCESSOR_CURRENTNESS_CAPTURE'
    && impact.requiredEvidence?.referenceStatus === 'PASS'
    && impact.requiredEvidence?.referenceTestCount === 75
    && impact.requiredEvidence?.referencePassedCount === 75
    && impact.requiredEvidence?.referenceFailedCount === 0
    && impact.requiredEvidence?.referenceSkippedCount === 0
    && impact.decision?.status === 'APPROVED_INTERNAL_IMPACT_DISPOSITION_FOR_EXACT_SOURCE_DELTAS'
    && impact.decision?.pdp0MeaningDisposition === 'NO_MEANING_CHANGE_FOR_EXACT_REVIEWED_SOURCE_DELTAS'
    && impact.decision?.pdp1MeaningDisposition === 'NO_ADDITIONAL_MEANING_IDS_IN_THESE_THREE_PATH_CHANGES; OPERATIONS_YAML_DELTA_REMAINS_SEPARATELY_REVIEWED'
    && JSON.stringify(impact.decision?.requiresOrderedTechnicalCurrentnessRecapture) === JSON.stringify(['PDP-0', 'PDP-1'])
    && impact.decision?.preserveHistoricalReceipts === true
    && impact.decision?.independentApproval === 'NOT_CLAIMED_AND_NOT_WAIVED'
    && impact.decision?.externalContractOwnerAcceptance === 'NOT_CLAIMED'
    && impact.decision?.nativeLifecycleClosure === 'NOT_ENTERED'
    && impact.decision?.runtimeAdmission === 'NOT_ADMITTED'
    && impact.decision?.delivery === 'BLOCKED';
  return { valid, impactRef: CURRENT_CUT_SOURCE_IMPACT_PATH, impactDigest, impactRecordId: impact.recordId, testEvidenceValid,
    validationDetails: { exactPaths, exactHashes, oldReporterImpactValid: oldReporterCheck.valid, testEvidenceValid,
      hashMatches: CURRENT_CUT_SOURCE_PATHS.map((sourcePath) => ({
        path: sourcePath,
        predecessor: historicalDigests[sourcePath] === (sourcePath === PDP1_GUARD_PATH
          ? PDP1_GUARD_PREDECESSOR_DIGEST : CURRENT_CUT_SOURCE_PREDECESSOR_DIGESTS[sourcePath]),
        observed: (observedDigests[sourcePath]?.digest ?? observedDigests[sourcePath]) === CURRENT_CUT_SOURCE_OBSERVED_DIGESTS[sourcePath],
        statusPin: `sha256:${String(statusPins[sourcePath] ?? '').replace(/^sha256:/u, '')}` === CURRENT_CUT_SOURCE_OBSERVED_DIGESTS[sourcePath],
        semanticPin: `sha256:${String(semanticPins[sourcePath] ?? '').replace(/^sha256:/u, '')}` === CURRENT_CUT_SOURCE_OBSERVED_DIGESTS[sourcePath],
      })),
      testInputsMatch: REQUIRED_TEST_FILES.map((sourcePath) => ({ path: sourcePath,
        expected: sha256(fs.readFileSync(path.join(root, sourcePath))), actual: requiredInputDigests[sourcePath],
        matches: requiredInputDigests[sourcePath] === sha256(fs.readFileSync(path.join(root, sourcePath))) })),
      outcome: requiredOutcome ?? null,
      testSourceStable: testRun?.sourceBinding?.stable === true,
      headStable: testRun?.startedHead === testRun?.completedHead,
      exactAuthority: impact.authority?.decisionRole === 'SCOPED_INTERNAL_MEDIA_SOURCE_IMPACT_REVIEW',
      exactDecision: impact.decision?.pdp1MeaningDisposition === 'NO_ADDITIONAL_MEANING_IDS_IN_THESE_THREE_PATH_CHANGES; OPERATIONS_YAML_DELTA_REMAINS_SEPARATELY_REVIEWED' } };
}

function validateAdapterTestImpactRecord(impact, statusPins, semanticPins, fileDigests) {
  const delta = impact.sourceDelta;
  const evidence = impact.testEvidence;
  const valid = impact.schemaVersion === 'media.discovery-pdp1-status-pin-impact.v1'
    && impact.recordId === 'MEDIA-DISCOVERY-PDP1-ADAPTER-TEST-PIN-IMPACT-2026-10-14-R1'
    && impact.campaign?.repository === 'samujjwal/ghatana-media'
    && impact.campaign?.stage === 'DISCOVERY'
    && impact.campaign?.phase === 'PDP-1'
    && impact.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION'
    && impact.authority?.authorityRef === '.product-experience/reviews/2026-10-13-discovery-current-cut-delegated-owner-review.md#Authority-and-attribution'
    && impact.authority?.decisionRole === 'SCOPED_INTERNAL_MEDIA_PRODUCT_AND_ENGINEERING_SOURCE_IMPACT_REVIEW'
    && impact.authority?.humanIndependentSignatureProvided === false
    && impact.authority?.qualifiedExternalSpecialistSignoffProvided === false
    && impact.authority?.externalContractOwnerAcceptanceProvided === false
    && impact.authority?.nativeLifecycleReceiptProvided === false
    && delta?.path === PDP1_ADAPTER_TEST_PATH
    && delta?.predecessorSha256 === PDP1_ADAPTER_TEST_PREDECESSOR_DIGEST
    && delta?.observedSha256 === PDP1_ADAPTER_TEST_OBSERVED_DIGEST
    && Array.isArray(delta?.historicalPinSets)
    && delta.historicalPinSets.length === 2
    && delta.historicalPinSets.includes('PDP1_DEVELOPMENT_STATUS_SOURCE_SHA_SET')
    && delta.historicalPinSets.includes('PDP1_SEMANTIC_REVIEW_SOURCE_FINGERPRINTS')
    && delta?.historicalPdp1MaterialSourceContainsPath === false
    && delta?.classification === 'PDP3_CONSUMER_TEST_ONLY; PDP1_DEFERRED_EVIDENCE_STATUS_PIN_REFRESH_REQUIRED; NO_PDP1_DEFINITION_MEANING_CHANGE'
    && delta?.meaningChange === 'NONE'
    && Array.isArray(delta?.meaningIdsChanged) && delta.meaningIdsChanged.length === 0
    && delta?.requiresFreshCurrentness === true
    && evidence?.command === PDP1_ADAPTER_TEST_COMMAND
    && evidence?.sourceSha256 === PDP1_ADAPTER_TEST_OBSERVED_DIGEST
    && evidence?.status === 'PASS'
    && evidence?.testCount === 6
    && evidence?.passCount === 6
    && evidence?.failCount === 0
    && evidence?.skippedCount === 0
    && evidence?.stdoutSha256 === 'sha256:8983d0917ae2ec1abff3fd15c24f0eabdc99b1ca767caa40a332d6e080fac19d'
    && impact.decision?.status === 'APPROVED_INTERNAL_NON_IMPACT_FOR_EXACT_PDP1_PIN_DELTA'
    && impact.decision?.pdp1DefinitionMeaningDisposition === 'NO_MEANING_CHANGE'
    && impact.decision?.requiresFreshPdp1Currentness === true
    && impact.decision?.preserveHistoricalReceipts === true
    && impact.decision?.independentApproval === 'NOT_CLAIMED_AND_NOT_WAIVED'
    && impact.decision?.nativeLifecycleClosure === 'NOT_ENTERED'
    && impact.decision?.build === 'NOT_ENTERED'
    && impact.decision?.delivery === 'BLOCKED'
    && `sha256:${String(statusPins[PDP1_ADAPTER_TEST_PATH] ?? '').replace(/^sha256:/u, '')}` === PDP1_ADAPTER_TEST_PREDECESSOR_DIGEST
    && `sha256:${String(semanticPins[PDP1_ADAPTER_TEST_PATH] ?? '').replace(/^sha256:/u, '')}` === PDP1_ADAPTER_TEST_PREDECESSOR_DIGEST
    && fileDigests[PDP1_ADAPTER_TEST_PATH]?.digest === PDP1_ADAPTER_TEST_OBSERVED_DIGEST;
  return { valid, impact, path: PDP1_ADAPTER_TEST_PATH, predecessorSha256: PDP1_ADAPTER_TEST_PREDECESSOR_DIGEST, observedSha256: PDP1_ADAPTER_TEST_OBSERVED_DIGEST };
}

export function validatePdp1OperationDefinitionDelta(
  fileDigests,
  historicalDigests,
  semanticReview = readJson('docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json'),
  { sourceText = readText(PDP1_OPERATIONS_PATH), reviewText = readText(PDP1_OPERATIONS_REVIEW_PATH) } = {},
) {
  const review = JSON.parse(reviewText);
  const delta = review.currentSourceCutDeltaReview?.supplementalPdp1DefinitionDelta;
  const sourceDigest = fileDigests[PDP1_OPERATIONS_PATH]?.digest ?? null;
  const reviewDigest = fileDigests[PDP1_OPERATIONS_REVIEW_PATH]?.digest ?? null;
  const source = parseYaml(sourceText);
  const contracts = new Map((source.ownerTypedObservationContracts?.records ?? []).map((record) => [record.id, record]));
  const validations = new Map((source.ownerTypedObservationValidationRules?.records ?? [])
    .map((record) => [record.observationContractRef?.split('@id=').at(-1), record]));
  const reviewedRecords = delta?.reviewedRecords ?? [];
  const recordsResolveExactly = reviewedRecords.length === PDP1_OPERATION_DELTA_IDS.length
    && reviewedRecords.map((record) => record.id).every((id, index) => id === PDP1_OPERATION_DELTA_IDS[index])
    && reviewedRecords.every((record) => {
      const contract = contracts.get(record.id);
      const validation = validations.get(record.id);
      const expectedSelector = `${PDP1_OPERATIONS_PATH}#ownerTypedObservationContracts/records/@id=${record.id}`;
      const expectedValidationSelector = validation
        ? `${PDP1_OPERATIONS_PATH}#ownerTypedObservationValidationRules/records/@id=${validation.id}` : null;
      return contract && validation
        && record.selector === expectedSelector
        && record.validationRuleId === validation.id
        && record.validationSelector === expectedValidationSelector
        && record.operationKind === 'QUERY'
        && record.bindingStatus === contract.bindingStatus
        && JSON.stringify(record.operationRefs) === JSON.stringify(contract.operationRefs)
        && typeof record.meaning === 'string' && record.meaning.length > 40;
    });
  const semanticSupplement = (semanticReview.supplementaryReviews ?? [])
    .find((record) => record.id === 'P1-current-owner-typed-observation-definition-delta-2026-10-14');
  const currentReview = semanticReview.currentCutReview?.supplementalDefinitionDeltaReview;
  const checks = {
    reviewSchema: review.schemaVersion === 'media.pdp1-operation-current-source-review.v1'
      && review.sourcePath === PDP1_OPERATIONS_PATH,
    sourcePins: sourceDigest === PDP1_OPERATIONS_OBSERVED_DIGEST
      && sourceDigest === sha256(sourceText)
      && review.currentSourceSha256 === sourceDigest?.replace(/^sha256:/u, '')
      && review.currentSourceCutDeltaReview?.currentSourceSha256 === review.currentSourceSha256
      && delta?.currentSourceSha256 === sourceDigest?.replace(/^sha256:/u, '')
      && sourceDigest === `sha256:${review.currentSourceSha256}`,
    semanticDeltaDeclaration: delta?.schemaVersion === 'media.pdp1-operation-definition-delta-review.v1'
      && delta.status === 'REVIEWED_CURRENT_SOURCE_SEMANTIC_DELTA'
      && delta.predecessorSourceSha256 === PDP1_OPERATIONS_PREDECESSOR_DIGEST.replace(/^sha256:/u, '')
      && delta.reviewAuthority === 'AI assistant acting under explicit user delegation for internal Media source-definition review; this is not a human owner signature, external contract-owner acceptance, independent specialist attestation, or phase-exit receipt.'
      && delta.materiality === 'PDP1_NORMATIVE_DEFINITION_CHANGE_REQUIRING_OWNING_PHASE_REVIEW_AND_FRESH_CURRENTNESS',
    exactCurrentContracts: recordsResolveExactly,
    reviewArtifactLineage: delta.sourceReviewArtifactPath === PDP1_OPERATIONS_REVIEW_PATH
      && delta.predecessorReviewArtifactSha256 === PDP1_OPERATIONS_REVIEW_PREDECESSOR_DIGEST
      && delta.reviewArtifactDisposition === 'SOURCE_REVIEW_EVIDENCE_REFRESH_FOR_THE_EXACT_PDP1_SEMANTIC_DELTA'
      && delta.reviewArtifactRequiresFreshCurrentness === true
      && reviewDigest === PDP1_OPERATIONS_REVIEW_OBSERVED_DIGEST
      && reviewDigest === sha256(reviewText)
      && historicalDigests[PDP1_OPERATIONS_REVIEW_PATH] === PDP1_OPERATIONS_REVIEW_PREDECESSOR_DIGEST
      && reviewDigest !== null,
    currentnessAndHistory: delta.freshCurrentnessRequired === true
      && delta.historicalReceiptsPreserved === true
      && historicalDigests[PDP1_OPERATIONS_PATH] === PDP1_OPERATIONS_PREDECESSOR_DIGEST,
    boundaries: delta.preservedBoundaries?.ownerTypedObservationsRemainQueries === true
      && delta.preservedBoundaries?.runtimeAdmission === 'NOT_ADMITTED'
      && delta.preservedBoundaries?.transportAdmission === 'NOT_ADMITTED'
      && delta.preservedBoundaries?.externalContractOwnerAcceptance === 'NOT_CLAIMED'
      && delta.preservedBoundaries?.independentSpecialistAttestation === 'NOT_CLAIMED'
      && delta.preservedBoundaries?.unknownEvidenceRemainsUnknown === true
      && delta.preservedBoundaries?.noEndpointOrProductionBehaviorAdded === true
      && delta.preservedBoundaries?.proposalOperationInventoryRemainsUnaccepted === true
      && delta.preservedBoundaries?.proposalOperationRecordCount === 14,
    fullIdentityReview: semanticReview.sourceCutStable === true
      && semanticReview.outstandingMeaningIds?.length === 0
      && semanticReview.reviewedIdentityIds?.length === 2023
      && semanticReview.sourceFingerprints?.[PDP1_OPERATIONS_PATH] === review.currentSourceSha256
      && semanticReview.sourceFingerprints?.[PDP1_OPERATIONS_REVIEW_PATH] === reviewDigest.replace(/^sha256:/u, ''),
    supplementarySemanticReview: currentReview?.sourceSha256 === review.currentSourceSha256
      && currentReview?.sourceReviewArtifactSha256 === reviewDigest
      && currentReview?.identitySetChanged === false
      && currentReview?.existingIdentityCountPreserved === 2023
      && JSON.stringify(currentReview?.reviewedRecordIds) === JSON.stringify(PDP1_OPERATION_DELTA_IDS)
      && currentReview?.independentApproval === 'NOT_CLAIMED_AND_NOT_WAIVED'
      && currentReview?.externalContractOwnerAcceptance === 'NOT_CLAIMED'
      && currentReview?.runtimeAdmission === 'NOT_ADMITTED'
      && currentReview?.transportAdmission === 'NOT_ADMITTED'
      && semanticSupplement?.sourceSha256 === review.currentSourceSha256
      && semanticSupplement?.reviewedPopulationIdsPreserved === 2023
      && semanticSupplement?.externalOwnerAcceptance === 'NOT_CLAIMED'
      && semanticSupplement?.independentSpecialistAttestation === 'NOT_CLAIMED'
      && semanticSupplement?.runtimeAdmission === 'NOT_ADMITTED'
      && semanticSupplement?.transportAdmission === 'NOT_ADMITTED'
      && semanticSupplement?.lifecycleClosure === 'NOT_ENTERED',
  };
  const valid = Object.values(checks).every(Boolean);
  return {
    valid,
    sourcePath: PDP1_OPERATIONS_PATH,
    sourceReviewPath: PDP1_OPERATIONS_REVIEW_PATH,
    predecessorSha256: PDP1_OPERATIONS_PREDECESSOR_DIGEST,
    observedSha256: sourceDigest,
    reviewArtifactPredecessorSha256: PDP1_OPERATIONS_REVIEW_PREDECESSOR_DIGEST,
    reviewArtifactObservedSha256: reviewDigest,
    reviewedDefinitionIds: reviewedRecords.map((record) => record.id),
    validationChecks: checks,
    classification: 'PDP1_DEFINITION_SEMANTIC_DELTA_REVIEWED_UNDER_USER_DELEGATION',
    requiresFreshCurrentness: true,
    limitation: 'Internal definition review only; no human owner signature, external acceptance, independent attestation, runtime admission, or phase receipt is asserted.',
  };
}

export function pdp1SemanticDefinitionPinDisposition(sourcePath, semanticDelta) {
  if (semanticDelta?.valid !== true) return null;
  if (sourcePath === PDP1_OPERATIONS_PATH) {
    return {
      classification: 'PDP1_DEFINITION_SEMANTIC_DELTA_REVIEWED_UNDER_USER_DELEGATION',
      meaningChange: 'PDP1_MEANING_CHANGED_AND_REVIEWED',
      note: `Reviewed exact PDP-1 definition delta ${semanticDelta.reviewedDefinitionIds.join(', ')} under explicit user-delegated internal source-definition authority.`,
      sourceReviewPath: semanticDelta.sourceReviewPath,
      requiresFreshCurrentness: semanticDelta.requiresFreshCurrentness,
      externalContractOwnerAcceptance: 'NOT_CLAIMED',
      independentApproval: 'NOT_CLAIMED_AND_NOT_WAIVED',
    };
  }
  if (sourcePath === PDP1_OPERATIONS_REVIEW_PATH) {
    return {
      classification: 'PDP1_SEMANTIC_REVIEW_ARTIFACT_REFRESH',
      meaningChange: 'REVIEW_ARTIFACT_FOR_REVIEWED_PDP1_SEMANTIC_DELTA',
      note: `This exact current-source review artifact records the reviewed PDP-1 definition delta ${semanticDelta.reviewedDefinitionIds.join(', ')}; it is evidence for the source change, not a separate product-definition change.`,
      sourceReviewPath: semanticDelta.sourceReviewPath,
      requiresFreshCurrentness: semanticDelta.requiresFreshCurrentness,
      externalContractOwnerAcceptance: 'NOT_CLAIMED',
      independentApproval: 'NOT_CLAIMED_AND_NOT_WAIVED',
    };
  }
  return null;
}

function validateParityTestPinImpactRecord(impact, statusPins, semanticPins, fileDigests, historicalDigests, testRun) {
  const expected = [
    {
      path: PDP1_PARITY_TEST_PATHS[0],
      predecessorSha256: 'sha256:582b43c7ef832f14a3c8db30b004ecb4e50c13640d12b7df51245240453dc03e',
      historicalMaterialSha256: 'sha256:3b2ebd2a9dcbe68f1afb86438fa55953851596a5d5c359a888bc94bb95eb4cc4',
    },
    {
      path: PDP1_PARITY_TEST_PATHS[1],
      predecessorSha256: 'sha256:61e516a75c72196c697f7480af8a9ab0805796af1ec4fd3b7f6606c51fb7c3c1',
      historicalMaterialSha256: 'sha256:fb5844bcafe7e5d6dfbc6ce19dfbbd68c84476855089ce17b0a353d31ae663e4',
    },
  ];
  const rows = impact.sourceDeltas ?? [];
  const outcome = testRun?.testOutcomes?.find((entry) => entry.command === REQUIRED_TEST_COMMAND);
  const sourceInputsMatch = expected.every(({ path: sourcePath }) =>
    testRun?.sourceBinding?.testInputContentDigests?.[sourcePath] === fileDigests[sourcePath]?.digest);
  const evidencePasses = impact.requiredEvidence?.command === REQUIRED_TEST_COMMAND
    && impact.requiredEvidence?.status === 'REQUIRED_FOR_DISPOSITION'
    && outcome?.status === 'PASS' && outcome.exitCode === 0
    && Number.isInteger(outcome.testCount) && outcome.testCount > 0
    && outcome.passedCount === outcome.testCount && outcome.failedCount === 0 && outcome.skippedCount === 0
    && testRun?.sourceBinding?.stable === true
    && testRun.startedHead === testRun.completedHead
    && sourceInputsMatch;
  const authorized = impact.schemaVersion === 'media.discovery-pdp1-parity-test-pin-impact.v1'
    && impact.recordId === 'MEDIA-DISCOVERY-PDP1-PARITY-TEST-PIN-IMPACT-2026-10-14-R1'
    && impact.campaign?.repository === 'samujjwal/ghatana-media'
    && impact.campaign?.stage === 'DISCOVERY'
    && impact.campaign?.phase === 'PDP-1'
    && impact.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION'
    && impact.authority?.decisionRole === 'SCOPED_INTERNAL_MEDIA_SOURCE_IMPACT_REVIEW'
    && impact.authority?.humanIndependentSignatureProvided === false
    && impact.authority?.qualifiedExternalSpecialistSignoffProvided === false
    && impact.authority?.externalContractOwnerAcceptanceProvided === false
    && impact.authority?.nativeLifecycleReceiptProvided === false
    && rows.length === expected.length
    && expected.every((expectedRow, index) => {
      const row = rows[index];
      const observed = fileDigests[expectedRow.path]?.digest;
      const statusPin = `sha256:${String(statusPins[expectedRow.path] ?? '').replace(/^sha256:/u, '')}`;
      const semanticPin = String(semanticPins[expectedRow.path] ?? '').replace(/^sha256:/u, '');
      return row?.path === expectedRow.path
        && row.predecessorSha256 === expectedRow.predecessorSha256
        && row.observedSha256 === observed
        && row.historicalPinSets?.length === 2
        && row.historicalPinSets.includes('PDP1_DEVELOPMENT_STATUS_SOURCE_SHA_SET')
        && row.historicalPinSets.includes('PDP1_SEMANTIC_REVIEW_SOURCE_FINGERPRINTS')
        && row.historicalPdp1MaterialSourceContainsPath === true
        && row.historicalPdp1MaterialSourceSha256 === expectedRow.historicalMaterialSha256
        && row.classification === 'REGRESSION_COVERAGE'
        && row.meaningChange === 'NONE'
        && Array.isArray(row.meaningIdsChanged) && row.meaningIdsChanged.length === 0
        && row.expectedAssertions?.length > 0
        && row.requiresFreshCurrentness === true
        && statusPin === expectedRow.predecessorSha256
        && historicalDigests[expectedRow.path] === expectedRow.historicalMaterialSha256
        && semanticPin === observed?.replace(/^sha256:/u, '')
        && observed !== null && observed !== undefined;
    })
    && impact.decision?.status === 'SCOPED_INTERNAL_TEST_PIN_RECONCILIATION'
    && impact.decision?.meaningDisposition === 'TEST_COVERAGE_ONLY'
    && impact.decision?.requiresFreshPdp1Currentness === true
    && impact.decision?.preserveHistoricalReceipts === true
    && impact.decision?.independentApproval === 'NOT_CLAIMED_AND_NOT_WAIVED'
    && impact.decision?.nativeLifecycleClosure === 'NOT_ENTERED'
    && impact.decision?.runtimeAdmission === 'NOT_ADMITTED'
    && impact.decision?.delivery === 'BLOCKED';
  const valid = authorized && evidencePasses;
  return expected.map((expectedRow, index) => {
    const row = rows[index] ?? {};
    return {
      valid,
      impact,
      path: expectedRow.path,
      predecessorSha256: expectedRow.predecessorSha256,
      observedSha256: fileDigests[expectedRow.path]?.digest ?? null,
      classification: 'REGRESSION_COVERAGE',
      meaningChange: 'NONE',
      freshCurrentnessRequired: true,
      testEvidence: outcome ?? null,
      impactRef: PDP1_PARITY_TEST_IMPACT_PATH,
      impactRecordId: impact.recordId ?? null,
      sourceDelta: row,
    };
  });
}

export function validatePdp1SupplementalPinDispositions({
  reporterImpact = readJson(PDP3_STATUS_GUARD_IMPACT_PATH),
  adapterTestImpact = readJson(PDP1_ADAPTER_TEST_IMPACT_PATH),
  parityTestImpact = readJson(PDP1_PARITY_TEST_IMPACT_PATH),
  statusPins = readJson('docs/implementation/pdp-1-phase-dev-status.json').sourceShaSet,
  semanticPins = readJson('docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json').sourceFingerprints,
  fileDigests = {},
  historicalDigests = readJson(HISTORICAL_PDP1_EXIT_PATH).sourceCurrentness?.sourceContentDigests ?? {},
  testRun = null,
} = {}) {
  const reporter = validateReporterImpactRecord(reporterImpact, fileDigests, historicalDigests, statusPins, semanticPins);
  const adapterTest = validateAdapterTestImpactRecord(adapterTestImpact, statusPins, semanticPins, fileDigests);
  const parityTests = validateParityTestPinImpactRecord(parityTestImpact, statusPins, semanticPins, fileDigests, historicalDigests, testRun);
  return [
    { ...reporter, impactRef: PDP3_STATUS_GUARD_IMPACT_PATH, impactDigest: sha256(fs.readFileSync(path.join(root, PDP3_STATUS_GUARD_IMPACT_PATH))),
      classification: 'PDP3_STATUS_GUARD_ONLY; PDP1_NO_MEANING_CHANGE', meaningChange: 'NONE', freshCurrentnessRequired: true },
    { ...adapterTest, impactRef: PDP1_ADAPTER_TEST_IMPACT_PATH, impactDigest: sha256(fs.readFileSync(path.join(root, PDP1_ADAPTER_TEST_IMPACT_PATH))),
      classification: 'PDP3_CONSUMER_TEST_ONLY; PDP1_DEFERRED_EVIDENCE_STATUS_PIN_REFRESH_REQUIRED; NO_PDP1_DEFINITION_MEANING_CHANGE', meaningChange: 'NONE', freshCurrentnessRequired: true,
      testEvidence: adapterTestImpact.testEvidence },
    ...parityTests,
  ];
}

export function validateCurrentCutOwnerDirections(ownerDirections, observedDigest) {
  const impactReview = ownerDirections?.predecessorImpactReviews?.find((review) => review.phase === 'PDP-1');
  const sourceChanges = impactReview?.sourceChanges ?? [];
  return observedDigest === CURRENT_CUT_OWNER_DIRECTIONS_DIGEST
    && ownerDirections.schemaVersion === 'media.discovery-current-cut-owner-directions.v2'
    && ownerDirections.decisionId === 'MEDIA-DISCOVERY-CURRENT-CUT-OWNER-2026-10-13-R2'
    && impactReview?.sourceCut === HISTORICAL_PDP1_EXIT_PATH
    && sourceChanges.length === CURRENT_CUT_PDP1_OWNER_CHANGE_PATHS.length
    && sourceChanges.every((change, index) => change.path === CURRENT_CUT_PDP1_OWNER_CHANGE_PATHS[index]);
}

export function pdp1OwnerStatusJoinObservation(observedDigests, freshMaterialSourceSetFingerprint, testRun = null) {
  const historical = readJson(HISTORICAL_PDP1_EXIT_PATH);
  const ownerDirections = readJson(CURRENT_CUT_OWNER_DIRECTIONS_PATH);
  const ownerDirectionsDigest = sha256(fs.readFileSync(path.join(root, CURRENT_CUT_OWNER_DIRECTIONS_PATH)));
  const impactSupplement = readJson(PDP3_STATUS_GUARD_IMPACT_PATH);
  const semanticReview = readJson('docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json');
  const impactReview = ownerDirections.predecessorImpactReviews?.find((review) => review.phase === 'PDP-1');
  const historicalDigests = historical.sourceCurrentness?.sourceContentDigests ?? {};
  const sourceChanges = impactReview?.sourceChanges ?? [];
  const observedPaths = Object.keys(observedDigests).sort();
  const predecessorPaths = Object.keys(historicalDigests).sort();
  const missingPaths = predecessorPaths.filter((sourcePath) => !Object.hasOwn(observedDigests, sourcePath));
  const additionalPaths = observedPaths.filter((sourcePath) => !Object.hasOwn(historicalDigests, sourcePath));
  const pathComparisons = predecessorPaths.map((sourcePath) => ({
    path: sourcePath,
    predecessorSha256: historicalDigests[sourcePath],
    observedSha256: observedDigests[sourcePath] ?? null,
    matches: observedDigests[sourcePath] === historicalDigests[sourcePath],
  }));
  const changedPaths = pathComparisons.filter((entry) => !entry.matches);
  const reviewedChanges = new Map(sourceChanges.map((change) => [change.path, change]));
  const currentImpact = readJson(CURRENT_CUT_SOURCE_IMPACT_PATH);
  const byCurrentImpactPath = new Map((currentImpact.sourceDeltas ?? []).map((delta) => [delta.path, delta]));
  const reporterImpact = validateReporterImpactRecord(
    impactSupplement,
    { ...observedDigests, [PDP1_GUARD_PATH]: PDP1_GUARD_OBSERVED_DIGEST },
    historicalDigests,
    { ...readJson('docs/implementation/pdp-1-phase-dev-status.json').sourceShaSet,
      [PDP1_GUARD_PATH]: PDP1_GUARD_PREDECESSOR_DIGEST.slice('sha256:'.length) },
    { ...readJson('docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json').sourceFingerprints,
      [PDP1_GUARD_PATH]: PDP1_GUARD_PREDECESSOR_DIGEST.slice('sha256:'.length) },
  );
  const currentImpactReview = validateCurrentCutSourceImpactRecord(
    currentImpact,
    observedDigests,
    historicalDigests,
    readJson('docs/implementation/pdp-1-phase-dev-status.json').sourceShaSet,
    semanticReview.sourceFingerprints,
    testRun,
  );
  const supplementValid = reporterImpact.valid && currentImpactReview.valid;
  const operationDeltaReview = validatePdp1OperationDefinitionDelta(
    Object.fromEntries(Object.entries(observedDigests).map(([sourcePath, digest]) => [sourcePath, { digest }])),
    historicalDigests,
    semanticReview,
  );
  const operationDeltaValid = operationDeltaReview.valid;
  const reviewedChangesValid = supplementValid && sourceChanges.length === 4
    && new Set(sourceChanges.map((change) => change.path)).size === 4
    && sourceChanges.every((change) => observedDigests[change.path] === change.observedSha256
      && historicalDigests[change.path] === change.recordedSha256
      && Array.isArray(change.meaningIdsChangedAtReviewedCut)
      && change.meaningIdsChangedAtReviewedCut.length === 0
      && change.requiresFreshCurrentness === true)
    && changedPaths.length === 9
    && changedPaths.every((entry) => reviewedChanges.has(entry.path)
      || CURRENT_CUT_SOURCE_PATHS.includes(entry.path)
      || entry.path === PDP1_OPERATIONS_PATH && operationDeltaValid
      || entry.path === PDP1_OPERATIONS_REVIEW_PATH && operationDeltaValid);
  const approvedChangedPaths = new Set([
    ...reviewedChanges.keys(),
    ...(currentImpactReview.valid ? CURRENT_CUT_SOURCE_PATHS : []),
    ...(operationDeltaValid ? [PDP1_OPERATIONS_PATH, PDP1_OPERATIONS_REVIEW_PATH] : []),
  ]);
  const exactChangedPathSet = changedPaths.length === approvedChangedPaths.size
    && changedPaths.every((entry) => approvedChangedPaths.has(entry.path));
  const valid = historical.phase === 'PDP-1'
    && historical.phaseExit?.status === 'PASS'
    && validateCurrentCutOwnerDirections(ownerDirections, ownerDirectionsDigest)
    && impactReview?.sourceCut === HISTORICAL_PDP1_EXIT_PATH
    && impactReview?.previousMaterialFingerprint === historical.sourceCurrentness?.materialSourceSetFingerprint
    && DIGEST.test(freshMaterialSourceSetFingerprint ?? '')
    && predecessorPaths.length === 329
    && observedPaths.length === 329
    && pathComparisons.filter((entry) => entry.matches).length === 320
    && changedPaths.length === 9
    && missingPaths.length === 0
    && additionalPaths.length === 0
    && reviewedChangesValid
    && operationDeltaValid
    && exactChangedPathSet
    && impactReview?.historicalRequiredPathCount === 329
    && impactReview.pinComparison?.matching === 325
    && impactReview.pinComparison?.changed === 4
    && impactReview.pinComparison?.missing === 0
    && impactReview.ownerDesignDisposition === 'APPROVE_REUSE_OF_PRIOR_PHASE_MEANING_FOR_EXACT_REVIEWED_DELTA_WITH_NO_NEW_MEANING_IDS';
  return {
    status: valid ? 'ACCEPTED_FOR_EXACT_CURRENT_FINGERPRINT_WITH_REVIEWED_DELTA' : 'BLOCKED_OWNER_STATUS_JOIN_MISMATCH',
    valid,
    historicalExitRef: HISTORICAL_PDP1_EXIT_PATH,
    historicalExitDigest: sha256(fs.readFileSync(path.join(root, HISTORICAL_PDP1_EXIT_PATH))),
    ownerDirectionsRef: CURRENT_CUT_OWNER_DIRECTIONS_PATH,
    ownerDirectionsDigest,
    ownerDecisionId: ownerDirections.decisionId ?? null,
    supplementalPdp1DefinitionReview: operationDeltaReview,
    predecessorMaterialSourceSetFingerprint: historical.sourceCurrentness?.materialSourceSetFingerprint ?? null,
    freshMaterialSourceSetFingerprint,
    predecessorPathCount: predecessorPaths.length,
    observedPathCount: observedPaths.length,
    unchangedPathCount: pathComparisons.filter((entry) => entry.matches).length,
    ownerApprovedChangedPathCount: changedPaths.filter((entry) => approvedChangedPaths.has(entry.path)).length,
    unapprovedChangedPathCount: changedPaths.filter((entry) => !approvedChangedPaths.has(entry.path)).length,
    unapprovedChangedPaths: changedPaths.filter((entry) => !approvedChangedPaths.has(entry.path)).map((entry) => entry.path),
    missingPathCount: missingPaths.length,
    additionalPathCount: additionalPaths.length,
    meaningIdsChangedCount: sourceChanges.reduce((total, change) => total + (change.meaningIdsChangedAtReviewedCut?.length ?? 0), 0)
      + operationDeltaReview.reviewedDefinitionIds.length,
    allChangesRequireFreshCurrentness: sourceChanges.length === 4 && sourceChanges.every((change) => change.requiresFreshCurrentness === true)
      && CURRENT_CUT_SOURCE_PATHS.every((sourcePath) => byCurrentImpactPath.get(sourcePath)?.requiresFreshCurrentness === true)
      && operationDeltaReview.requiresFreshCurrentness === true,
    sourceChanges: sourceChanges.map((change) => ({
      path: change.path,
      predecessorSha256: historicalDigests[change.path] ?? null,
      ownerReviewedSha256: change.observedSha256,
      observedSha256: observedDigests[change.path] ?? null,
      meaningIdsChangedAtReviewedCut: change.meaningIdsChangedAtReviewedCut ?? [],
      requiresFreshCurrentness: change.requiresFreshCurrentness === true,
      matches: historicalDigests[change.path] === change.recordedSha256
        && observedDigests[change.path] === change.observedSha256,
    })).concat(
      ...CURRENT_CUT_SOURCE_PATHS.map((sourcePath) => {
        const delta = byCurrentImpactPath.get(sourcePath);
        return {
          path: sourcePath,
          predecessorSha256: historicalDigests[sourcePath] ?? null,
          ownerReviewedSha256: delta?.observedSha256 ?? null,
          observedSha256: observedDigests[sourcePath] ?? null,
          meaningIdsChangedAtReviewedCut: delta?.meaningIdsChanged ?? delta?.additionalMeaningIds ?? [],
          classification: delta?.classification ?? null,
          requiresFreshCurrentness: delta?.requiresFreshCurrentness === true,
          matches: historicalDigests[sourcePath] === delta?.predecessorSha256
            && observedDigests[sourcePath] === delta?.observedSha256,
          impactRef: CURRENT_CUT_SOURCE_IMPACT_PATH,
          authorityRef: currentImpact.authority?.authorityRef ?? null,
          independentApproval: currentImpact.decision?.independentApproval ?? null,
        };
      }),
      {
        path: PDP1_OPERATIONS_PATH,
        predecessorSha256: historicalDigests[PDP1_OPERATIONS_PATH] ?? null,
        ownerReviewedSha256: operationDeltaReview.observedSha256,
        observedSha256: observedDigests[PDP1_OPERATIONS_PATH] ?? null,
          meaningIdsChangedAtReviewedCut: operationDeltaReview.reviewedDefinitionIds,
        reviewedDefinitionIds: operationDeltaReview.reviewedDefinitionIds,
        classification: operationDeltaReview.classification,
        requiresFreshCurrentness: operationDeltaReview.requiresFreshCurrentness,
        matches: operationDeltaValid && historicalDigests[PDP1_OPERATIONS_PATH] === operationDeltaReview.predecessorSha256
          && observedDigests[PDP1_OPERATIONS_PATH] === operationDeltaReview.observedSha256,
        authority: 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION_FOR_INTERNAL_DEFINITION_REVIEW',
        independentApproval: 'NOT_CLAIMED_AND_NOT_WAIVED',
        externalContractOwnerAcceptance: 'NOT_CLAIMED',
      },
      {
        path: PDP1_OPERATIONS_REVIEW_PATH,
        predecessorSha256: historicalDigests[PDP1_OPERATIONS_REVIEW_PATH] ?? null,
        ownerReviewedSha256: operationDeltaReview.reviewArtifactObservedSha256,
        observedSha256: observedDigests[PDP1_OPERATIONS_REVIEW_PATH] ?? null,
        meaningIdsChangedAtReviewedCut: [],
        classification: 'PDP1_SEMANTIC_REVIEW_ARTIFACT_REFRESH',
        requiresFreshCurrentness: true,
        matches: operationDeltaValid && historicalDigests[PDP1_OPERATIONS_REVIEW_PATH] === operationDeltaReview.reviewArtifactPredecessorSha256
          && observedDigests[PDP1_OPERATIONS_REVIEW_PATH] === operationDeltaReview.reviewArtifactObservedSha256,
        authority: 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION_FOR_INTERNAL_DEFINITION_REVIEW',
        independentApproval: 'NOT_CLAIMED_AND_NOT_WAIVED',
        externalContractOwnerAcceptance: 'NOT_CLAIMED',
      },
    ),
    supplementalImpactReviewRef: CURRENT_CUT_SOURCE_IMPACT_PATH,
    supplementalImpactReviewDigest: currentImpactReview.impactDigest,
    predecessorReporterImpactRef: PDP3_STATUS_GUARD_IMPACT_PATH,
    predecessorReporterImpactDigest: sha256(fs.readFileSync(path.join(root, PDP3_STATUS_GUARD_IMPACT_PATH))),
    currentCutSourceImpactReview: currentImpactReview,
    testEvidence: currentImpactReview.testEvidenceValid ? {
      command: CURRENT_CUT_PDP1_TEST_COMMAND,
      status: 'PASS',
      testCount: (testRun?.outcomes ?? testRun?.testOutcomes)?.find((entry) => entry.command === CURRENT_CUT_PDP1_TEST_COMMAND)?.testCount ?? null,
      passedCount: (testRun?.outcomes ?? testRun?.testOutcomes)?.find((entry) => entry.command === CURRENT_CUT_PDP1_TEST_COMMAND)?.passedCount ?? null,
      failedCount: (testRun?.outcomes ?? testRun?.testOutcomes)?.find((entry) => entry.command === CURRENT_CUT_PDP1_TEST_COMMAND)?.failedCount ?? null,
      skippedCount: (testRun?.outcomes ?? testRun?.testOutcomes)?.find((entry) => entry.command === CURRENT_CUT_PDP1_TEST_COMMAND)?.skippedCount ?? null,
    } : { status: 'MISSING_OR_INVALID' },
    limitation: 'Scoped internal owner materiality join for the exact reviewed delta; it is not exact-cut owner acceptance, independent approval, lifecycle closure, or release qualification.',
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

function indexUnique(rows, name) {
  const result = new Map();
  for (const row of rows) {
    if (!row || typeof row.surfaceId !== 'string' || result.has(row.surfaceId)) {
      throw new TypeError(`Missing or duplicate ${name} identity`);
    }
    result.set(row.surfaceId, row);
  }
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateMatrixAndTopology(matrix, topology, registry, census, domainObjects, operationDefinitions) {
  const p1 = matrix.cells.filter((cell) => cell.phase === 'PDP-1');
  const physical = indexUnique(topology.manifestCandidates, 'physical candidate');
  const compositions = indexUnique(topology.compositions, 'composition');
  const consumers = indexUnique(topology.consumerCrosswalk, 'consumer');
  const registrySurfaces = indexUnique(registry.surfaces, 'surface registry');
  const canonicalDomainObjectIds = new Set((domainObjects.objects ?? []).map((object) => object.id));
  const canonicalOperationIds = new Set([
    ...(operationDefinitions.operations ?? []).flatMap((operation) => [operation.id, operation.operationId]),
    ...((operationDefinitions.ownerDefinedOperationContracts?.records ?? []).flatMap((operation) => [operation.id, operation.operationId])),
    operationDefinitions.ownerDefinedTtsRequestOriginContract?.id,
  ].filter(Boolean));
  const rows = indexUnique(p1, 'PDP-1 cell');
  const errors = [];

  if (p1.length !== 50 || rows.size !== 50 || matrix.denominators?.phaseReviewCells !== 200) {
    errors.push('PDP1_MATRIX_DENOMINATOR_MISMATCH');
  }
  if (physical.size !== 26 || compositions.size !== 7 || consumers.size !== 17
      || [...compositions.values()].filter((row) => row.kind === 'SEMANTIC_COMPOSITION').length !== 6
      || [...compositions.values()].filter((row) => row.kind === 'REPOSITORY_ROOT').length !== 1) {
    errors.push('LIVE_TOPOLOGY_DENOMINATOR_MISMATCH');
  }

  for (const [surfaceId, source] of physical) {
    const cell = rows.get(surfaceId);
    const applicability = source.phaseApplicability?.['PDP-1'];
    if (!cell || cell.surfaceKind !== 'PHYSICAL_CANDIDATE'
        || cell.owner !== source.owner || cell.physicalDisposition !== source.disposition
        || cell.phaseApplicabilityDisposition !== applicability?.disposition
        || cell.phaseApplicabilityRationale !== applicability?.rationale) {
      errors.push(`PHYSICAL_CELL_TOPOLOGY_MISMATCH:${surfaceId}`);
      continue;
    }
    for (const reference of [applicability.authorityRef, applicability.operationAuthorityRef].filter(Boolean)) {
      if (!cell.inspectWhere.some((entry) => entry.includes(reference))
          || !cell.parentSourceAuthorityRefs.includes(reference)) {
        errors.push(`PHYSICAL_CANONICAL_AUTHORITY_REFERENCE_MISSING:${surfaceId}:${reference}`);
      }
    }
    for (const id of applicability.domainObjectIds ?? []) {
      if (!canonicalDomainObjectIds.has(id)) {
        errors.push(`PHYSICAL_DOMAIN_IDENTITY_MISSING:${surfaceId}:${id}`);
      }
    }
    for (const id of applicability.operationIds ?? []) {
      if (!canonicalOperationIds.has(id)) errors.push(`PHYSICAL_OPERATION_IDENTITY_MISSING:${surfaceId}:${id}`);
    }
  }

  for (const [surfaceId, source] of compositions) {
    const cell = rows.get(surfaceId);
    const applicability = source.phaseApplicability?.['PDP-1'];
    const expectedKind = source.kind === 'REPOSITORY_ROOT' ? 'REPOSITORY_ROOT' : 'SEMANTIC_COMPOSITION';
    if (!cell || cell.surfaceKind !== expectedKind || cell.owner !== source.canonicalOwner
        || cell.phaseApplicabilityDisposition !== applicability?.disposition
        || cell.phaseApplicabilityRationale !== applicability?.rationale) {
      errors.push(`COMPOSITION_CELL_TOPOLOGY_MISMATCH:${surfaceId}`);
      continue;
    }
    if (!cell.parentSourceAuthorityRefs.includes('.product-experience/pdp-1-domain-data/domain-objects.yaml')) {
      errors.push(`COMPOSITION_DOMAIN_AUTHORITY_MISSING:${surfaceId}`);
    }
    if (source.kind === 'SEMANTIC_COMPOSITION'
        && !cell.parentSourceAuthorityRefs.includes('.product-experience/pdp-1-domain-data/operations.yaml')) {
      errors.push(`COMPOSITION_OPERATION_AUTHORITY_MISSING:${surfaceId}`);
    }
    for (const id of applicability.domainObjectIds ?? []) {
      if (!canonicalDomainObjectIds.has(id)) {
        errors.push(`COMPOSITION_DOMAIN_IDENTITY_MISSING:${surfaceId}:${id}`);
      }
    }
    for (const id of applicability.operationIds ?? []) {
      if (!canonicalOperationIds.has(id)) errors.push(`COMPOSITION_OPERATION_IDENTITY_MISSING:${surfaceId}:${id}`);
    }
  }

  for (const [surfaceId, source] of consumers) {
    const cell = rows.get(surfaceId);
    const registered = registrySurfaces.get(surfaceId);
    const p1Applicable = registered?.applicablePdpArtifacts?.includes('PDP-1') === true;
    const expectedDisposition = p1Applicable ? 'APPLICABLE_CONSUMER_BINDING' : 'NOT_APPLICABLE_ARCHIVED';
    const expectedReason = source.statusReason ?? registered?.applicabilityRationale;
    if (!cell || cell.surfaceKind !== 'CONSUMER_BINDING' || !registered
        || JSON.stringify(cell.consumerCrosswalkRefs?.slice().sort()) !== JSON.stringify([...(source.physicalRefs ?? [])].sort())
        || JSON.stringify(cell.owner) !== JSON.stringify(registered.owners)
        || cell.phaseApplicabilityDisposition !== expectedDisposition
        || cell.phaseApplicabilityRationale !== expectedReason
        || !cell.inspectWhere.includes(source.registryAuthority ?? '.product-experience/surface-registry.yaml')
        || !cell.inspectWhere.includes('.product-experience/surfaces/media-physical-topology.v1.json')) {
      errors.push(`CONSUMER_BINDING_MISMATCH:${surfaceId}`);
    }
    if (!p1Applicable && surfaceId !== 'media.surface.desktop-archive') {
      errors.push(`UNJUSTIFIED_PDP1_CONSUMER_NA:${surfaceId}`);
    }
  }

  const expectedIds = new Set([...physical.keys(), ...compositions.keys(), ...consumers.keys()]);
  if (expectedIds.size !== rows.size || [...expectedIds].some((surfaceId) => !rows.has(surfaceId))) {
    errors.push('PDP1_MATRIX_TOPOLOGY_ID_SET_MISMATCH');
  }
  return { cells: p1, errors };
}

function buildCellPaths(matrixCells, topology, availablePaths) {
  const physical = new Map(topology.manifestCandidates.map((row) => [row.surfaceId, row]));
  const compositions = new Map(topology.compositions.map((row) => [row.surfaceId, row]));
  const consumers = new Map(topology.consumerCrosswalk.map((row) => [row.surfaceId, row]));
  const cellsBySurface = new Map(matrixCells.map((cell) => [cell.surfaceId, cell]));
  const memo = new Map();

  const refsFor = (cell, seen = new Set()) => {
    if (memo.has(cell.surfaceId)) return memo.get(cell.surfaceId);
    if (seen.has(cell.surfaceId)) throw new TypeError(`Cycle in PDP-1 source membership at ${cell.surfaceId}`);
    seen.add(cell.surfaceId);
    const refs = [...COMMON_PDP1_REFS, ...cell.inspectWhere];
    if (consumers.has(cell.surfaceId)) {
      for (const physicalId of consumers.get(cell.surfaceId).physicalRefs ?? []) {
        const physicalCell = cellsBySurface.get(physicalId);
        if (physicalCell) refs.push(...refsFor(physicalCell, seen));
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
      for (const child of matrixCells.filter((candidate) => candidate.surfaceKind === 'CONSUMER_BINDING')) {
        refs.push(...refsFor(child, seen));
      }
    }
    seen.delete(cell.surfaceId);
    const paths = [...new Set(refs.flatMap((reference) => expandRef(reference, availablePaths)))].sort();
    memo.set(cell.surfaceId, paths);
    return paths;
  };

  return matrixCells.map((cell) => ({
    cellId: `${cell.surfaceId}:PDP-1`,
    surfaceId: cell.surfaceId,
    phase: 'PDP-1',
    cellType: cell.surfaceKind,
    owner: cell.owner,
    applicability: {
      disposition: cell.phaseApplicabilityDisposition,
      rationale: cell.phaseApplicabilityRationale,
      authorityRefs: cell.parentSourceAuthorityRefs ?? [],
      consumerCrosswalkRefs: cell.consumerCrosswalkRefs ?? [],
    },
    paths: refsFor(cell),
    predecessorPhase: 'PDP-0',
  }));
}

function externalContractObservation(sourceManifestSha, predecessorCurrentness) {
  const currentness = predecessorCurrentness;
  const blockers = [];
  const sourceManifestPath = '.product-experience/source-manifest.yaml';
  const sourceManifestWasCurrentAtP0 = currentness?.sourceContentDigests?.[sourceManifestPath] === sourceManifestSha;
  if (!sourceManifestWasCurrentAtP0) blockers.push('SOURCE_MANIFEST_CHANGED_AFTER_PDP0_EXIT');
  const current = (currentness?.externalOwnerContracts?.repositories ?? []).map((repository) => {
    const externalRoot = path.resolve(root, SOURCE_ROOTS[repository.repositoryId] ?? '');
    return {
      repositoryId: repository.repositoryId,
      recordedRevision: repository.recordedRevision,
      files: repository.files.map((file) => {
        const absolutePath = path.join(externalRoot, ...file.path.split('/'));
        let observedContentSha256 = null;
        try {
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
  const files = current.flatMap((repository) => repository.files);
  const digestMismatches = files.filter((file) => !file.digestMatches);
  if (files.length !== 30 || digestMismatches.length) blockers.push('EXTERNAL_OWNER_CONTRACT_DIGESTS_NOT_CURRENT');
  return {
    totalFiles: files.length,
    digestMatches: files.length - digestMismatches.length,
    digestMismatches,
    repositories: current,
    providerRegistryFingerprint: currentness?.externalOwnerContracts?.providerRegistryFingerprint ?? null,
    sourceManifestCurrentAtPdp0Predecessor: sourceManifestWasCurrentAtP0,
    blockers,
  };
}

function phasePinReview(status, semanticReview, mdc10, fileDigests, testRun) {
  const staleStatusPins = Object.entries(status.sourceShaSet ?? {})
    .filter(([sourcePath, recorded]) => fileDigests[sourcePath]?.digest !== `sha256:${recorded.replace(/^sha256:/u, '')}`)
    .map(([sourcePath, recorded]) => ({
      path: sourcePath,
      historicalSha256: `sha256:${recorded.replace(/^sha256:/u, '')}`,
      currentSha256: fileDigests[sourcePath]?.digest ?? null,
    }));
  const staleSemanticPins = Object.entries(semanticReview.sourceFingerprints ?? {})
    .filter(([sourcePath, recorded]) => fileDigests[sourcePath]?.digest !== `sha256:${recorded.replace(/^sha256:/u, '')}`)
    .map(([sourcePath, recorded]) => ({
      path: sourcePath,
      historicalSha256: `sha256:${recorded.replace(/^sha256:/u, '')}`,
      currentSha256: fileDigests[sourcePath]?.digest ?? null,
    }));
  const allowedClassifications = new Set([
    'DOCUMENTATION_STATUS_ONLY',
    'VALIDATION_LOGIC_CLASSIFICATION',
    'REGRESSION_COVERAGE',
  ]);
  const rawDispositions = new Map((mdc10.historicalPdp1PinChanges?.changes ?? []).map((entry) => [entry.path, entry]));
  const p1TestEvidence = (testRun?.testOutcomes ?? []).find((outcome) => outcome.command === REQUIRED_TEST_COMMAND);
  const historicalDigests = readJson(HISTORICAL_PDP1_EXIT_PATH).sourceCurrentness?.sourceContentDigests ?? {};
  const supplementalPinDispositions = validatePdp1SupplementalPinDispositions({
    reporterImpact: readJson(PDP3_STATUS_GUARD_IMPACT_PATH),
    adapterTestImpact: readJson(PDP1_ADAPTER_TEST_IMPACT_PATH),
    parityTestImpact: readJson(PDP1_PARITY_TEST_IMPACT_PATH),
    statusPins: status.sourceShaSet ?? {},
    semanticPins: semanticReview.sourceFingerprints ?? {},
    fileDigests,
    historicalDigests,
    testRun,
  });
  const validSupplementalDispositions = new Map(supplementalPinDispositions
    .filter((entry) => entry.valid)
    .map((entry) => [entry.path, entry]));
  const semanticDefinitionDelta = validatePdp1OperationDefinitionDelta(fileDigests, historicalDigests, semanticReview);
  const semanticDefinitionDispositions = new Map([PDP1_OPERATIONS_PATH, PDP1_OPERATIONS_REVIEW_PATH]
    .map((sourcePath) => [sourcePath, pdp1SemanticDefinitionPinDisposition(sourcePath, semanticDefinitionDelta)])
    .filter(([, disposition]) => disposition !== null));
  const isNonMeaningDisposition = (entry) => entry
    && allowedClassifications.has(entry.classification)
    && ['NONE', 'NONE_IDENTIFIED'].includes(entry.meaningChange)
    && (typeof entry.note === 'string' && entry.note.trim().length > 0
      || entry.classification === 'REGRESSION_COVERAGE'
        && p1TestEvidence?.status === 'PASS' && p1TestEvidence.exitCode === 0
        && p1TestEvidence.testCount > 0 && p1TestEvidence.skippedCount === 0);
  const dispositions = new Map([...rawDispositions].filter(([, entry]) => isNonMeaningDisposition(entry)));
  const hasDisposition = (sourcePath) => dispositions.has(sourcePath)
    || validSupplementalDispositions.has(sourcePath)
    || semanticDefinitionDispositions.has(sourcePath);
  const unclassifiedStatusPins = staleStatusPins.filter((entry) => !hasDisposition(entry.path));
  const unclassifiedSemanticPins = staleSemanticPins.filter((entry) => !hasDisposition(entry.path));
  const pinChangeDisposition = (entry) => {
    const supplemental = validSupplementalDispositions.get(entry.path);
    const semanticDefinition = semanticDefinitionDispositions.get(entry.path);
    const ordinary = dispositions.get(entry.path);
    return semanticDefinition ? {
      classification: semanticDefinition.classification,
      meaningChange: semanticDefinition.meaningChange,
      note: semanticDefinition.note,
      sourceReviewPath: semanticDefinition.sourceReviewPath,
      requiresFreshCurrentness: semanticDefinition.requiresFreshCurrentness,
      externalContractOwnerAcceptance: 'NOT_CLAIMED',
      independentApproval: 'NOT_CLAIMED_AND_NOT_WAIVED',
    } : supplemental ? {
      classification: supplemental.classification,
      meaningChange: supplemental.meaningChange,
      note: supplemental.impact.sourceDelta?.changeSummary ?? supplemental.impact.sourceDelta?.classification ?? null,
      supplementalImpactRef: supplemental.impactRef,
      supplementalImpactRecordId: supplemental.impact.recordId,
      requiresFreshCurrentness: supplemental.freshCurrentnessRequired,
    } : {
      classification: ordinary?.classification ?? 'UNCLASSIFIED',
      meaningChange: ordinary?.meaningChange ?? 'UNCLASSIFIED',
      note: ordinary?.note ?? (ordinary?.classification === 'REGRESSION_COVERAGE' ? `Test-only source; verified by the source-bound ${p1TestEvidence?.testCount ?? 0}-case PDP-1 suite with zero skips.` : null),
    };
  };
  return {
    historicalStatusPinCount: Object.keys(status.sourceShaSet ?? {}).length,
    historicalStatusCurrentPinCount: Object.keys(status.sourceShaSet ?? {}).length - staleStatusPins.length,
    historicalStatusChangedPinCount: staleStatusPins.length,
    historicalStatusMissingPinCount: staleStatusPins.filter((entry) => entry.currentSha256 === null).length,
    historicalSemanticReviewPinCount: Object.keys(semanticReview.sourceFingerprints ?? {}).length,
    historicalSemanticReviewCurrentPinCount: Object.keys(semanticReview.sourceFingerprints ?? {}).length - staleSemanticPins.length,
    historicalSemanticReviewChangedPinCount: staleSemanticPins.length,
    statusPinChanges: staleStatusPins.map((entry) => ({ ...entry, ...pinChangeDisposition(entry) })),
    semanticReviewPinChanges: staleSemanticPins.map((entry) => ({ ...entry, ...pinChangeDisposition(entry) })),
    invalidDispositionPaths: [
      ...[...rawDispositions].filter(([, entry]) => !isNonMeaningDisposition(entry)).map(([sourcePath]) => sourcePath),
      ...supplementalPinDispositions.filter((entry) => !entry.valid).map((entry) => entry.path),
      ...(!semanticDefinitionDelta.valid ? [PDP1_OPERATIONS_PATH] : []),
    ],
    dispositionObservationDigest: sha256(readText('docs/implementation/observations/media-discovery-pdp1-mdc10-contract-parity-2026-10-13-r1.json')),
    supplementalPinDispositions,
    semanticDefinitionDeltaReview: semanticDefinitionDelta,
    unclassifiedStatusPins,
    unclassifiedSemanticPins,
    continuityDecision: unclassifiedStatusPins.length === 0 && unclassifiedSemanticPins.length === 0
      ? 'CARRY_FORWARD_PRIOR_IDENTITY_REVIEW_WITH_EXACT_PDP1_SEMANTIC_DELTA_AND_TEST_DISPOSITIONS'
      : 'BLOCKED_UNCLASSIFIED_HISTORICAL_PIN_CHANGES',
  };
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

function delegatedOwnerDirectionObservation() {
  const decisionPath = '.product-experience/reviews/2026-10-13-discovery-delegated-owner-decision-and-authorizations.md';
  const decision = readText(decisionPath);
  const p1Line = decision.split('\n').find((line) => line.includes('`MEDIA-OWN-P1`')) ?? '';
  const approved = decision.includes('**Decision ID:** `MEDIA-DISCOVERY-OWNER-AUTHORIZATION-2026-10-13`')
    && p1Line.includes('**APPROVE DESIGN DIRECTION**')
    && p1Line.includes('No new PDP-1 currentness')
    && p1Line.includes('passed tests');
  return {
    decisionId: 'MEDIA-DISCOVERY-OWNER-AUTHORIZATION-2026-10-13',
    decisionRef: `${decisionPath}#MEDIA-OWN-P1`,
    sourceSha256: sha256(decision),
    status: approved ? 'APPROVED_DESIGN_DIRECTION' : 'MISSING_OR_CONTRADICTORY_DECISION',
    sourceRow: p1Line,
    explicitLimits: ['NO_NEW_PDP1_CURRENTNESS', 'NO_RUNTIME_PARITY', 'NO_DEPLOYED_HOST', 'NO_TRANSPORT_OWNER_ACCEPTANCE', 'NO_PASSED_TESTS'],
  };
}

export function validatePdp0Predecessor(p0Exit, p0ExitPath, p0Digest, p0Currentness, p0CurrentnessPath, p0CurrentnessDigest, matrixCutMatches) {
  const cells = p0Exit.sourceCurrentness?.cells ?? [];
  const uniqueCellIds = new Set(cells.map((cell) => cell.cellId));
  const fingerprint = p0Exit.developmentStatus?.currentMaterialSourceSetFingerprint;
  const ownerStatusJoin = p0Exit.ownerStatusJoin;
  const valid = p0ExitPath === CURRENT_CUT_PDP0_SUCCESSOR_PATH
    && p0Exit.schemaVersion === 'media.discovery-phase-exit.v1'
    && p0Exit.phase === 'PDP-0'
    && p0Exit.recordId === `MEDIA-PDP0-EXIT-${fingerprint?.slice(-12)}`
    && p0Exit.sourceCurrentness?.status === 'PASS'
    && p0Exit.sourceCurrentness?.sourceCurrent === true
    && p0Exit.phaseExit?.status === 'PASS'
    && p0Exit.phaseExit?.sourceCurrentness === 'PASS'
    && ownerStatusJoin?.status === 'ACCEPTED_FOR_EXACT_CURRENT_FINGERPRINT_WITH_REVIEWED_DELTA'
    && ownerStatusJoin?.freshMaterialSourceSetFingerprint === fingerprint
    && ownerStatusJoin?.predecessorPathCount === 146
    && ownerStatusJoin?.observedPathCount === 146
    && ownerStatusJoin?.predecessorExitRef === 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r2.json'
    && ownerStatusJoin?.predecessorMaterialSourceSetFingerprint === 'sha256:20e8a999b36e7fb61662183200f1e8c83eebb39523c5ab8835bea311af1f31e8'
    && ownerStatusJoin?.supplementalImpactRef === CURRENT_CUT_SOURCE_IMPACT_PATH
    && ownerStatusJoin?.supplementalDecisionId === 'MEDIA-DISCOVERY-CURRENT-CUT-SOURCE-IMPACT-2026-10-14-R1'
    && ownerStatusJoin?.supplementalImpactSha256 === sha256(fs.readFileSync(path.join(root, CURRENT_CUT_SOURCE_IMPACT_PATH)))
    && ownerStatusJoin?.unchangedPathCount + ownerStatusJoin?.ownerApprovedChangedPathCount === ownerStatusJoin?.predecessorPathCount
    && ownerStatusJoin?.predecessorPathCount === ownerStatusJoin?.observedPathCount
    && ownerStatusJoin?.unchangedPathCount === 145
    && ownerStatusJoin?.ownerApprovedChangedPathCount === 1
    && ownerStatusJoin?.unapprovedChangedPathCount === 0
    && ownerStatusJoin?.missingPathCount === 0
    && ownerStatusJoin?.additionalPathCount === 0
    && p0Exit.developmentStatus?.status === 'DEV_COMPLETE'
    && Array.isArray(p0Exit.developmentStatus?.outstandingMeaningIds)
    && p0Exit.developmentStatus.outstandingMeaningIds.length === 0
    && cells.length === 50 && uniqueCellIds.size === 50
    && cells.every((cell) => cell.sourceCurrentness === 'CURRENT' && (cell.blockers?.length ?? 0) === 0)
    && DIGEST.test(fingerprint ?? '')
    && p0Exit.sourceCurrentness.materialSourceSetFingerprint === fingerprint
    && p0Exit.sourceCurrentness.denominators?.totalCells === 50
    && p0Exit.sourceCurrentness.materialPathDenominator?.uniquePaths === 146
    && matrixCutMatches;
  const currentnessValid = p0Currentness?.schemaVersion === 'media.discovery-pdp0-currentness-observation.v1'
    && p0Currentness.phaseDisposition?.currentSourceCurrentness === 'PASS'
    && p0Currentness.phaseDisposition?.sourceCurrent === true
    && p0Currentness.materialSourceSetFingerprint === fingerprint
    && p0Exit.sourceCurrentness.materialSourceSetFingerprint === p0Currentness.materialSourceSetFingerprint
    && p0Currentness.denominators?.totalCells === 50
    && p0Currentness.physicalCompositeConsumerCells?.length === 50
    && new Set(p0Currentness.physicalCompositeConsumerCells.map((cell) => cell.cellId)).size === 50
    && p0Currentness.physicalCompositeConsumerCells.every((cell) => cell.sourceCurrentness === 'CURRENT' && (cell.blockers?.length ?? 0) === 0)
    && p0Exit.campaign?.observedHead === p0Currentness.campaign?.observedHead;
  return {
    valid: valid && currentnessValid,
    exitRef: p0ExitPath,
    exitDigest: p0Digest,
    currentnessRef: p0CurrentnessPath,
    currentnessDigest: p0CurrentnessDigest,
    currentnessValid,
    matrixCutMatches,
    exitRecordId: p0Exit.recordId,
    materialSourceSetFingerprint: fingerprint ?? null,
    observedHead: p0Exit.campaign?.observedHead ?? null,
    cellCount: cells.length,
    uniqueCellCount: uniqueCellIds.size,
  };
}

function priorPdp1Attempts(currentSuffix) {
  const directory = path.join(root, 'docs/implementation/observations');
  return fs.readdirSync(directory)
    .filter((name) => name.startsWith('media-discovery-pdp1-exit-') && name.endsWith('.json')
      && name !== `media-discovery-pdp1-exit-${currentSuffix}.json`)
    .sort()
    .map((name) => {
      const absolutePath = path.join(directory, name);
      const record = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
      return {
        ref: path.relative(root, absolutePath),
        digest: sha256(fs.readFileSync(absolutePath)),
        phaseExitStatus: record.phaseExit?.status ?? 'UNKNOWN',
        observedAt: record.observedAt ?? null,
        blockers: record.phaseExit?.blockers ?? [],
        supersessionRule: 'A later current source capture governs the present phase decision; earlier records remain immutable history.',
      };
    });
}

function makeObservation({ suffix, testRun, p0ExitPath }) {
  const matrixPath = 'docs/implementation/media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json';
  const statusPath = 'docs/implementation/pdp-1-phase-dev-status.json';
  const reviewPath = 'docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json';
  const mdc10Path = 'docs/implementation/observations/media-discovery-pdp1-mdc10-contract-parity-2026-10-13-r1.json';
  const matrixDigest = sha256(fs.readFileSync(path.join(root, matrixPath)));
  const matrix = readJson(matrixPath);
  const status = readJson(statusPath);
  const semanticReview = readJson(reviewPath);
  const mdc10 = readJson(mdc10Path);
  const p0Exit = readJson(p0ExitPath);
  const p0CurrentnessPath = p0ExitPath.replace('-exit-', '-currentness-');
  const p0Currentness = readJson(p0CurrentnessPath);
  const topology = readJson('.product-experience/surfaces/media-physical-topology.v1.json');
  const registry = parseYaml(readText('.product-experience/surface-registry.yaml'));
  const census = buildPdp1SourceCensus(root);
  const domainObjects = parseYaml(readText('.product-experience/pdp-1-domain-data/domain-objects.yaml'));
  const operationDefinitions = parseYaml(readText('.product-experience/pdp-1-domain-data/operations.yaml'));
  const topologyReview = validateMatrixAndTopology(matrix, topology, registry, census, domainObjects, operationDefinitions);
  const previousFingerprints = p0Exit.sourceCurrentness;
  const dimensions = {
    ownerGraphFingerprint: previousFingerprints.ownerGraphFingerprint,
    physicalCatalogFingerprint: previousFingerprints.physicalCatalogFingerprint,
    providerRegistryFingerprint: previousFingerprints.providerRegistryFingerprint,
  };
  const availablePaths = trackedPathSet();
  const sourceCells = buildCellPaths(topologyReview.cells, topology, availablePaths);
  const lifecyclePriming = [
    captureRepositorySourceCurrentness(root, dimensions),
    captureRepositorySourceCurrentness(root, dimensions),
  ];
  const technical = observeMediaDiscoveryCurrentness(root, sourceCells.map((cell) => ({
    ...cell,
    ownerGraphFingerprint: dimensions.ownerGraphFingerprint,
    physicalCatalogFingerprint: dimensions.physicalCatalogFingerprint,
    providerRegistryFingerprint: dimensions.providerRegistryFingerprint,
  })));
  const consistencyCaptures = [
    captureRepositorySourceCurrentness(root, dimensions),
    captureRepositorySourceCurrentness(root, dimensions),
  ];
  const currentCapture = consistencyCaptures[1];
  const fileDigests = currentCapture?.fileContentDigests ?? {};
  const primingSummary = lifecyclePriming.map(summarizeCapture);
  const consistencySummary = consistencyCaptures.map(summarizeCapture);
  const consistencyStable = consistencyCaptures.every(captureIsStable)
    && consistencyCaptures.every((capture) => capture.sourceToken === technical.sourceToken
      && capture.contentFingerprint === technical.contentFingerprint
      && capture.pathMembershipDigest === technical.pathMembershipDigest);
  const pinReview = phasePinReview(status, semanticReview, mdc10, fileDigests, testRun);
  const p0Digest = sha256(fs.readFileSync(path.join(root, p0ExitPath)));
  const p0CurrentnessDigest = sha256(fs.readFileSync(path.join(root, p0CurrentnessPath)));
  const matrixCutMatches = matrix.currentCut?.phaseExit === p0ExitPath
    && matrix.currentCut?.currentnessObservation === p0CurrentnessPath
    && matrix.currentCut?.phaseExitRecordId === p0Exit.recordId
    && matrix.currentCut?.materialSourceSetFingerprint === p0Exit.developmentStatus?.currentMaterialSourceSetFingerprint;
  const p0Predecessor = validatePdp0Predecessor(p0Exit, p0ExitPath, p0Digest, p0Currentness, p0CurrentnessPath, p0CurrentnessDigest, matrixCutMatches);
  const p0ExitValid = p0Predecessor.valid;
  const p0SourceSetFingerprint = p0Predecessor.materialSourceSetFingerprint;
  const currentSourceManifestDigest = fileDigests['.product-experience/source-manifest.yaml']?.digest ?? null;
  const externalContracts = externalContractObservation(currentSourceManifestDigest, p0Currentness);
  const censusIdentitySetMatches = census.identityIds?.length === semanticReview.reviewedIdentityIds?.length
    && new Set(census.identityIds).size === census.identityIds.length
    && census.identityIds.every((identity) => semanticReview.reviewedIdentityIds.includes(identity));
  const semanticReviewCarryForward = semanticReview.status === 'APPROVED_PDP1_DEVELOPMENT_SEMANTIC_REVIEW'
    && semanticReview.phase === 'PDP-1'
    && semanticReview.sourceCutStable === true
    && semanticReview.outstandingMeaningIds?.length === 0
    && censusIdentitySetMatches
    && pinReview.semanticDefinitionDeltaReview?.valid === true
    && pinReview.unclassifiedStatusPins.length === 0
    && pinReview.unclassifiedSemanticPins.length === 0;
  const ownerDirection = delegatedOwnerDirectionObservation();
  const historicalStatusValid = status.phase === 'PDP-1'
    && status.status === 'DEV_COMPLETE'
    && Array.isArray(status.outstandingMeaningIds)
    && status.outstandingMeaningIds.length === 0;
  const testOutcomes = testRun.testOutcomes;
  const requiredTest = testOutcomes.find((outcome) => outcome.command === REQUIRED_TEST_COMMAND);
  const localExperienceCheck = testOutcomes.find((outcome) => outcome.command === REQUIRED_LOCAL_EXPERIENCE_COMMAND);
  const strictParity = testOutcomes.find((outcome) => outcome.command === REQUIRED_STRICT_COMMAND);
  const definitionOnly = testOutcomes.find((outcome) => outcome.command === REQUIRED_DEFINITION_ONLY_COMMAND);
  const testInputDigestsMatchCapture = REQUIRED_TEST_FILES.every((sourcePath) =>
    testRun.sourceBinding?.testInputContentDigests?.[sourcePath] === fileDigests[sourcePath]?.digest);
  const localExperienceCheckInputMatchesCurrent = testRun.sourceBinding?.localExperienceCheckInput?.stable === true
    && testRun.sourceBinding.localExperienceCheckInput.sha256After
      === sha256(fs.readFileSync(path.join(root, testRun.sourceBinding.localExperienceCheckInput.path)));
  const testsBoundToCurrentCut = testRun.sourceBinding?.stable === true
    && testRun.startedHead === testRun.completedHead
    && testRun.completedHead === git(['rev-parse', 'HEAD'])
    && testRun.sourceBinding?.sourceToken === technical.sourceToken
    && testRun.sourceBinding?.contentFingerprint === technical.contentFingerprint
    && testRun.sourceBinding?.pathMembershipDigest === technical.pathMembershipDigest
    && testInputDigestsMatchCapture
    && localExperienceCheckInputMatchesCurrent;
  const testOutcomesValid = requiredTest?.status === 'PASS' && requiredTest.exitCode === 0
    && Number.isInteger(requiredTest.testCount) && requiredTest.testCount > 0
    && requiredTest.passedCount === requiredTest.testCount && requiredTest.failedCount === 0 && requiredTest.skippedCount === 0
    && definitionOnly?.status === 'PASS' && definitionOnly.exitCode === 0
    && strictParity?.status === 'NON_GREEN_EXPECTED_OWNER_ADMISSION_FINDING' && strictParity.exitCode === 1
    && strictParity.sourceFindings?.unresolved === 1
    && strictParity.sourceFindings.audited === 47
    && strictParity.sourceFindings.dispositioned === 46
    && strictParity.unresolvedFinding === 'PDP-1 operations remain proposal-only; structural identities are not accepted mappings'
    && definitionOnly?.sourceFindings?.audited === 47
    && definitionOnly.sourceFindings.dispositioned === 45
    && definitionOnly.sourceFindings.unresolved === 0
    && localExperienceCheck?.status === 'PASS' && localExperienceCheck.exitCode === 0
    && testsBoundToCurrentCut;
  const currentCells = technical.cells.map((cell) => {
    const expectedPaths = cell.expectedPaths ?? [];
    const fileContentDigests = cell.fileContentDigests ?? {};
    const cellMatrix = topologyReview.cells.find((row) => row.surfaceId === cell.surfaceId);
    const sourceSetFingerprint = hashValue({
      schemaVersion: 'media.pdp1-phase-cell-material.v1',
      cellId: cell.cellId,
      owner: cellMatrix?.owner,
      applicability: cell.applicability,
      expectedPaths,
      fileContentDigests,
    });
    return {
      cellId: cell.cellId,
      surfaceId: cell.surfaceId,
      cellType: cell.cellType,
      owner: cellMatrix?.owner ?? null,
      applicability: cell.applicability,
      sourceCurrentness: cell.sourceCurrentness,
      expectedPathCount: expectedPaths.length,
      expectedPathSetFingerprint: hashValue(expectedPaths),
      sourceSetFingerprint,
      expectedPaths,
      fileContentDigests,
      blockers: [...new Set([...(cell.blockers ?? []), ...(topologyReview.errors.filter((error) => error.includes(cell.surfaceId)))])],
    };
  });
  const allCellsCurrent = currentCells.length === 50
    && new Set(currentCells.map((cell) => cell.cellId)).size === 50
    && currentCells.every((cell) => cell.sourceCurrentness === 'CURRENT' && cell.blockers.length === 0);
  const sourceSetByPath = {};
  for (const cell of currentCells) {
    for (const [sourcePath, digest] of Object.entries(cell.fileContentDigests)) {
      if (sourceSetByPath[sourcePath] && sourceSetByPath[sourcePath] !== digest) {
        throw new Error(`Inconsistent Lifecycle digest for ${sourcePath}`);
      }
      sourceSetByPath[sourcePath] = digest;
    }
  }
  const p0SourceDigests = p0Exit.sourceCurrentness?.sourceContentDigests ?? {};
  const predecessorSharedPathChecks = Object.entries(sourceSetByPath)
    .filter(([sourcePath]) => Object.hasOwn(p0SourceDigests, sourcePath))
    .map(([sourcePath, current]) => ({
      path: sourcePath,
      predecessorSha256: p0SourceDigests[sourcePath] ?? null,
      currentSha256: current ?? null,
      matches: p0SourceDigests[sourcePath] === current,
    }));
  const predecessorSharedPathMismatches = predecessorSharedPathChecks.filter((entry) => !entry.matches);
  const firstCellPaths = new Set(currentCells[0]?.expectedPaths ?? []);
  for (const cell of currentCells.slice(1)) {
    for (const sourcePath of [...firstCellPaths]) if (!cell.expectedPaths.includes(sourcePath)) firstCellPaths.delete(sourcePath);
  }
  const sharedMaterialPaths = [...firstCellPaths].sort();
  const materialSourceSetFingerprint = hashValue({
    schemaVersion: 'media.pdp1-material-source-set.v1',
    phase: 'PDP-1',
    priorPhaseExitAttempts: priorPdp1Attempts(suffix),
    cells: currentCells.map((cell) => ({ cellId: cell.cellId, sourceSetFingerprint: cell.sourceSetFingerprint }))
      .sort((left, right) => left.cellId.localeCompare(right.cellId)),
  });
  const ownerStatusJoin = pdp1OwnerStatusJoinObservation(sourceSetByPath, materialSourceSetFingerprint, testRun);
  const lifecycleBlockers = [...new Set([
    ...technical.blockers,
    ...consistencySummary.flatMap((capture, index) => capture.status === 'UNKNOWN' ? [`CONSISTENCY_CAPTURE_${index + 1}_UNKNOWN`] : []),
    ...(!consistencyStable ? ['POST_CAPTURE_SOURCE_OR_LIFECYCLE_STATE_CHANGED'] : []),
  ])];
  const sourceBlockers = [
    ...topologyReview.errors,
    ...(!p0ExitValid ? ['PDP0_PREDECESSOR_EXIT_NOT_PASS'] : []),
    ...(!ownerStatusJoin.valid ? ['PDP1_CURRENT_CUT_OWNER_STATUS_JOIN_NOT_EXACT'] : []),
    ...(!DIGEST.test(p0SourceSetFingerprint ?? '') ? ['PDP0_PREDECESSOR_MATERIAL_FINGERPRINT_MISSING'] : []),
    ...(predecessorSharedPathMismatches.length ? ['PDP0_PREDECESSOR_SHARED_SOURCE_CHANGED'] : []),
    ...(!consistencyStable ? ['LIFECYCLE_CAPTURE_NOT_STABLE'] : []),
    ...(!allCellsCurrent ? ['ONE_OR_MORE_PDP1_CELLS_NOT_CURRENT'] : []),
    ...externalContracts.blockers,
    ...(!semanticReviewCarryForward ? ['CURRENT_FULL_DENOMINATOR_SEMANTIC_REVIEW_NOT_ESTABLISHED'] : []),
    ...(!historicalStatusValid ? ['HISTORICAL_PDP1_STATUS_INCONSISTENT_OR_OUTSTANDING_TASKS'] : []),
    ...(ownerDirection.status !== 'APPROVED_DESIGN_DIRECTION' ? ['DELEGATED_PDP1_DESIGN_DIRECTION_MISSING_OR_CONTRADICTORY'] : []),
    ...(pinReview.unclassifiedStatusPins.length ? ['UNCLASSIFIED_HISTORICAL_STATUS_PINS'] : []),
    ...(pinReview.unclassifiedSemanticPins.length ? ['UNCLASSIFIED_HISTORICAL_SEMANTIC_REVIEW_PINS'] : []),
    ...((census.integrityIssues ?? []).map((issue) => `P1_CENSUS:${issue}`)),
    ...((!Array.isArray(testOutcomes) || !testOutcomesValid) ? ['REQUIRED_PDP1_TEST_OR_PARITY_OUTCOME_INVALID'] : []),
  ];
  const sourceCurrentnessPass = sourceBlockers.length === 0;
  const currentStatus = sourceCurrentnessPass ? 'DEV_COMPLETE' : 'IN_PROGRESS';
  const requiredTestOutcomes = [requiredTest, localExperienceCheck, strictParity, definitionOnly].filter(Boolean);
  const observation = {
    schemaVersion: 'media.discovery-pdp1-currentness-observation.v1',
    observationId: `MEDIA-PDP1-CURRENTNESS-${suffix.toUpperCase()}`,
    observedAt: new Date().toISOString(),
    campaign: {
      repository: 'samujjwal/ghatana-media',
      branch: git(['branch', '--show-current']),
      observedHead: git(['rev-parse', 'HEAD']),
      observedOriginMain: git(['rev-parse', 'origin/main']),
      scope: 'Repository-wide Media Discovery; PDP-1 only.',
      baselineSha: status.mainSha,
    },
    phase: 'PDP-1',
    decisionInputs: {
      matrix: {
        path: matrixPath,
        sha256: matrixDigest,
        excludedFromPdp1MaterialPathDenominator: true,
        currentPdp0Cut: {
          phaseExit: matrix.currentCut?.phaseExit ?? null,
          currentnessObservation: matrix.currentCut?.currentnessObservation ?? null,
          phaseExitRecordId: matrix.currentCut?.phaseExitRecordId ?? null,
          materialSourceSetFingerprint: matrix.currentCut?.materialSourceSetFingerprint ?? null,
          matchesValidatedPredecessor: matrixCutMatches,
        },
      },
    },
    predecessor: {
      phase: 'PDP-0',
      ...p0Predecessor,
      status: p0ExitValid ? 'PASS' : 'FAIL',
      sharedSourcePathChecks: predecessorSharedPathChecks,
      sharedSourcePathMismatchCount: predecessorSharedPathMismatches.length,
    },
    ownerStatusJoin,
    developmentStatus: {
      status: currentStatus,
      historicalStatus: status.status,
      historicalMainSha: status.mainSha,
      historicalOutstandingMeaningIds: status.outstandingMeaningIds ?? [],
      outstandingMeaningIds: sourceCurrentnessPass ? [] : sourceBlockers,
      currentMaterialSourceSetFingerprint: materialSourceSetFingerprint,
      sourceIdentityCount: census.identityIds?.length ?? 0,
      sourceRecordCount: census.sourceRecordCount ?? {},
    },
    authority: {
      delegatedOwnerDirection: ownerDirection,
      exactPdp1SourceCutOwnerAcceptance: 'NOT_RECORDED',
      independentHumanOrQualifiedSignoff: 'NOT_CLAIMED',
      historicalSemanticReviewRef: reviewPath,
      currentSemanticReviewContinuity: semanticReviewCarryForward ? pinReview.continuityDecision : 'BLOCKED',
      semanticReviewPopulation: {
        currentIdentityCount: census.identityIds?.length ?? 0,
        historicalReviewedIdentityCount: semanticReview.reviewedIdentityIds?.length ?? 0,
        exactIdentitySetMatches: censusIdentitySetMatches,
        outstandingMeaningIds: semanticReview.outstandingMeaningIds ?? [],
      },
      historicalPinReview: pinReview,
      runtimeAdmission: 'NOT_CLAIMED',
      fourAgentTools: 'NOT_ADMITTED',
    },
    sourceCurrentness: {
      status: sourceCurrentnessPass ? 'PASS' : 'FAIL',
      sourceCurrent: sourceCurrentnessPass,
      lifecycle: {
        authoritySchema: technical.authoritySchema,
        captureModel: technical.captureModel,
        continuity: technical.continuity,
        sourceToken: technical.sourceToken,
        contentFingerprint: technical.contentFingerprint,
        pathMembershipDigest: technical.pathMembershipDigest,
        consistencyStable,
        zeroWorkEligibleAtCapture: technical.zeroWorkEligible,
        lifecyclePriming: primingSummary,
        consistencyCaptures: consistencySummary,
        blockers: lifecycleBlockers,
      },
      denominators: { physicalCandidates: 26, semanticCompositions: 6, repositoryRoots: 1, consumers: 17, totalCells: currentCells.length },
      materialPathDenominator: {
        uniquePaths: Object.keys(sourceSetByPath).length,
        sharedPaths: sharedMaterialPaths.length,
        cellSpecificPaths: Object.keys(sourceSetByPath).length - sharedMaterialPaths.length,
      },
      sharedMaterialPaths,
      sourceContentDigests: sourceSetByPath,
      ownerGraphFingerprint: dimensions.ownerGraphFingerprint,
      physicalCatalogFingerprint: dimensions.physicalCatalogFingerprint,
      providerRegistryFingerprint: dimensions.providerRegistryFingerprint,
      materialSourceSetFingerprint,
      externalOwnerContracts: externalContracts,
      cells: currentCells,
      blockers: sourceBlockers,
    },
    testRun: {
      runner: testRun.runner,
      startedHead: testRun.startedHead,
      completedHead: testRun.completedHead,
      sourceBinding: testRun.sourceBinding,
      outcomes: requiredTestOutcomes,
    },
    strictAdmission: {
      status: strictParity?.status ?? 'NOT_RECORDED',
      blockingFinding: strictParity?.unresolvedFinding ?? 'NOT_RECORDED',
      disposition: 'OWNER_ACCEPTANCE_AND_RUNTIME_ADMISSION; NOT_A_PDP1_MEANING_DEFECT',
      fourAgentTools: ['av.speech-to-text', 'av.text-to-speech', 'av.vision-analysis', 'av.multimodal-inference'].map((toolId) => ({ toolId, status: 'NOT_ADMITTED' })),
    },
    phaseExit: {
      status: sourceCurrentnessPass ? 'PASS' : 'FAIL',
      sourceCurrentness: sourceCurrentnessPass ? 'PASS' : 'FAIL',
      developmentStatus: currentStatus,
      delegatedOwnerDirection: ownerDirection.status,
      exactCutOwnerAcceptance: 'NOT_RECORDED',
      requiredChecks: testOutcomesValid ? 'PASS_WITH_EXPECTED_STRICT_ADMISSION_FINDING' : 'FAIL',
      blockers: sourceBlockers,
      nextLegalAction: sourceCurrentnessPass ? 'ADVANCE_TO_PDP2_MDC20' : 'REPAIR_MDC11_OR_MDC12_BLOCKERS_AND_RECAPTURE_PDP1',
    },
    independentApproval: 'NOT_CLAIMED_AND_NOT_WAIVED',
    lifecycleClosure: 'NOT_ENTERED',
    build: 'NOT_ENTERED',
    delivery: 'BLOCKED',
  };
  return observation;
}

function main() {
  const suffix = process.argv[2];
  const defaultP0ExitPath = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r1.json';
  const p0ExitArgument = process.argv[3];
  const p0ExitAbsolutePath = p0ExitArgument ? path.resolve(root, p0ExitArgument) : path.join(root, defaultP0ExitPath);
  const p0ExitPath = path.relative(root, p0ExitAbsolutePath).split(path.sep).join('/');
  if (!p0ExitPath || p0ExitPath.startsWith('../') || path.isAbsolute(p0ExitPath)) {
    process.stderr.write('PDP-0 predecessor path must resolve inside the repository.\n');
    process.exitCode = 2;
    return;
  }
  if (!/^[a-z0-9-]+$/u.test(suffix ?? '')) {
    process.stderr.write('Usage: node scripts/record-media-discovery-pdp1-phase-exit.mjs <fresh-cut-suffix> [pdp0-exit-path]\n');
    process.exitCode = 2;
    return;
  }
  const outputPath = `docs/implementation/observations/media-discovery-pdp1-exit-${suffix}.json`;
  if (fs.existsSync(path.join(root, outputPath))) throw new Error(`Refusing to overwrite immutable observation: ${outputPath}`);
  const p0Exit = readJson(p0ExitPath);
  const dimensions = {
    ownerGraphFingerprint: p0Exit.sourceCurrentness.ownerGraphFingerprint,
    physicalCatalogFingerprint: p0Exit.sourceCurrentness.physicalCatalogFingerprint,
    providerRegistryFingerprint: p0Exit.sourceCurrentness.providerRegistryFingerprint,
  };
  const testRun = runRequiredChecks(dimensions);
  const observation = makeObservation({ suffix, testRun, p0ExitPath });
  const absolutePath = path.join(root, outputPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const descriptor = fs.openSync(absolutePath, 'wx');
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(observation, null, 2)}\n`);
  } finally {
    fs.closeSync(descriptor);
  }
  process.stdout.write(`${JSON.stringify({ outputPath, phaseExit: observation.phaseExit, materialSourceSetFingerprint: observation.sourceCurrentness.materialSourceSetFingerprint, cellCount: observation.sourceCurrentness.cells.length }, null, 2)}\n`);
  if (observation.phaseExit.status !== 'PASS') process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
