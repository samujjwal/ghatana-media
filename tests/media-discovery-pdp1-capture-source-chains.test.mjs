import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  resolvePdp1PredecessorPaths,
  validatePdp0Predecessor,
  validatePdp0ReporterSuccessorImpact,
  validatePdp1C22SemanticRepairImpact,
  validatePdp1Pxd164SemanticRepairImpact,
  validatePdp1Pxd164SupplementalPinDispositions,
  pdp1SupplementalPinChangeDisposition,
  validatePdp1AdditionalSourceImpactRecord,
  validatePdp1InterfaceReviewImpactRecord,
  validatePdp1InterfaceReviewSuccessorChain,
  validatePdp1OwnerWireC22SuccessorChain,
  validatePdp1ThreeReviewSourceTransition,
  validatePdp1R27SuccessorSourceImpact,
  validatePdp1InterfaceReviewPinRefreshAuthorization,
  validatePdp1OwnerStatusJoinTestTransition,
} from '../scripts/record-media-discovery-pdp1-phase-exit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const interfacePath = '.product-experience/interface-parity/current-source-review.json';
const operationsPath = '.product-experience/pdp-1-domain-data/operations.yaml';
const ownerWirePath = '.product-experience/pdp-1-domain-data/owner-action-wire-contracts.yaml';
const operationsReviewPath = '.product-experience/pdp-1-domain-data/operations-current-source-review.json';
const statusTestPath = 'tests/media-pdp-p1-dev-status.test.mjs';
const ownerStatusJoinTestPath = 'tests/media-discovery-pdp1-supplemental-owner-status-join.test.mjs';
const ownerWireTestPath = 'tests/pdp1-owner-action-wire-contracts.test.mjs';
const pxd164Paths = [
  '.product-experience/decision-log.md',
  '.product-experience/pdp-1-domain-data/operations-current-source-review.json',
  operationsPath,
  ownerWirePath,
];
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const digest = (file) => `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')}`;

test('PDP-1 interface review pin refresh requires the exact user-authorized R2 transition', () => {
  const authorizationPath = 'docs/implementation/observations/media-discovery-pdp1-interface-review-source-pin-refresh-2026-10-15-r2.json';
  const record = readJson(authorizationPath);
  assert.equal(validatePdp1InterfaceReviewPinRefreshAuthorization().valid, true);
  assert.equal(validatePdp1InterfaceReviewPinRefreshAuthorization(record, { recordPath: `${authorizationPath}.wrong` }).valid, false);

  const wrongPath = structuredClone(record);
  wrongPath.sourceTransition.path = '.product-experience/pdp-1-domain-data/operations.yaml';
  assert.equal(validatePdp1InterfaceReviewPinRefreshAuthorization(wrongPath).valid, false);

  const wrongHash = structuredClone(record);
  wrongHash.sourceTransition.observedSha256 = `sha256:${'0'.repeat(64)}`;
  assert.equal(validatePdp1InterfaceReviewPinRefreshAuthorization(wrongHash).valid, false);

  assert.equal(validatePdp1InterfaceReviewPinRefreshAuthorization(null).valid, false);
});

test('PDP-1 CLI predecessor defaults to the live matrix cut and derives its paired currentness receipt', () => {
  const matrix = readJson('docs/implementation/media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json');
  const resolved = resolvePdp1PredecessorPaths();
  assert.equal(resolved.exitPath, matrix.currentCut.phaseExit);
  assert.equal(resolved.currentnessPath, matrix.currentCut.currentnessObservation);
  assert.equal(resolved.currentnessPath, resolved.exitPath.replace('-exit-', '-currentness-'));
});

test('PDP-1 CLI rejects an explicit predecessor that differs from the live matrix before capture', () => {
  const matrix = readJson('docs/implementation/media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json');
  const wrongPath = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r10.json';
  assert.notEqual(wrongPath, matrix.currentCut.phaseExit);
  assert.throws(() => resolvePdp1PredecessorPaths({ explicitExitPath: wrongPath }), /must match the live matrix current cut/u);
});

function chainInputs() {
  const statusPins = readJson('docs/implementation/pdp-1-phase-dev-status.json').sourceShaSet;
  const semanticPins = readJson('docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json').sourceFingerprints;
  const observedDigests = Object.fromEntries([...new Set([interfacePath, operationsPath, ownerWirePath, operationsReviewPath, statusTestPath, ownerWireTestPath,
    'tests/pdp-truth-domain-typed-observations.test.mjs', ...pxd164Paths])]
    .map((sourcePath) => [sourcePath, digest(sourcePath)]));
  const historicalDigests = {
    [interfacePath]: 'sha256:14cf6c3d9ea948e39e41ffa2de3453c08b7b6a23267f407f3504c5462b7428fc',
    [ownerWirePath]: 'sha256:f6155c1bf0a1851b0fa45f631ce09eb459d2b8d5d8df6cd03a3dd6d634be19cf',
  };
  const c22Record = readJson('docs/implementation/observations/media-discovery-pdp1-c22-semantic-repair-impact-2026-10-14.json');
  const c22 = validatePdp1C22SemanticRepairImpact(c22Record, {
    observedDigests,
    historicalDigests: {
      [operationsPath]: c22Record.sourcePredecessor.sourceDigests[operationsPath],
      [ownerWirePath]: c22Record.sourcePredecessor.sourceDigests[ownerWirePath],
    },
    statusPins,
    semanticPins,
  });
  const transition = validatePdp1ThreeReviewSourceTransition(
    readJson('docs/implementation/observations/media-discovery-pdp1-three-review-source-transition-2026-10-14.json'),
    { observedDigests, statusPins, semanticPins },
  );
  return { observedDigests, historicalDigests, statusPins, semanticPins, c22, transition };
}

test('PDP-1 immediate predecessor validation binds the matrix-selected PDP-0 receipt and currentness pair', () => {
  const matrix = readJson('docs/implementation/media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json');
  const exitPath = matrix.currentCut.phaseExit;
  const currentnessPath = matrix.currentCut.currentnessObservation;
  const exit = readJson(exitPath);
  const currentness = readJson(currentnessPath);
  const args = [exit, exitPath, digest(exitPath), currentness, currentnessPath, digest(currentnessPath), true, exitPath];
  assert.equal(validatePdp0Predecessor(...args).valid, true);
  assert.equal(validatePdp0Predecessor(...args.slice(0, 6), false, exitPath).valid, true);
  assert.equal(validatePdp0Predecessor(...args.slice(0, 2), `sha256:${'0'.repeat(64)}`, ...args.slice(3)).valid, false);
  assert.equal(validatePdp0Predecessor(exit, 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r10.json',
    ...args.slice(2, 7), exitPath).valid, false);
});

test('PDP-1 predecessor receipt validation rejects caller-asserted wrong phase, status, fingerprint, and source map', () => {
  const matrix = readJson('docs/implementation/media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json');
  const exitPath = matrix.currentCut.phaseExit;
  const currentnessPath = matrix.currentCut.currentnessObservation;
  const exit = readJson(exitPath);
  const currentness = readJson(currentnessPath);
  const args = [exit, exitPath, digest(exitPath), currentness, currentnessPath, digest(currentnessPath), true, exitPath];

  const wrongPhase = structuredClone(exit);
  wrongPhase.phase = 'PDP-1';
  assert.equal(validatePdp0Predecessor(wrongPhase, ...args.slice(1)).valid, false);

  const nonPass = structuredClone(exit);
  nonPass.phaseExit.status = 'FAIL';
  assert.equal(validatePdp0Predecessor(nonPass, ...args.slice(1)).valid, false);

  const mismatchedFingerprint = structuredClone(currentness);
  mismatchedFingerprint.materialSourceSetFingerprint = `sha256:${'0'.repeat(64)}`;
  assert.equal(validatePdp0Predecessor(exit, exitPath, digest(exitPath), mismatchedFingerprint,
    currentnessPath, digest(currentnessPath), true, exitPath).valid, false);

  const extraSourceChange = structuredClone(exit);
  const extraCurrentnessChange = structuredClone(currentness);
  const extraPath = '.product-experience/pdp-0-product-truth/unbound-extra.yaml';
  extraSourceChange.sourceCurrentness.sourceContentDigests[extraPath] = `sha256:${'1'.repeat(64)}`;
  extraCurrentnessChange.sourceContentDigests[extraPath] = `sha256:${'1'.repeat(64)}`;
  assert.equal(validatePdp0Predecessor(extraSourceChange, exitPath, digest(exitPath), extraCurrentnessChange,
    currentnessPath, digest(currentnessPath), true, exitPath).valid, false);
});

test('PDP-1 predecessor receipt validation rejects unbound currentness path and receipt-byte digest mismatches', () => {
  const matrix = readJson('docs/implementation/media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json');
  const exitPath = matrix.currentCut.phaseExit;
  const currentnessPath = matrix.currentCut.currentnessObservation;
  const exit = readJson(exitPath);
  const currentness = readJson(currentnessPath);
  const args = [exit, exitPath, digest(exitPath), currentness, currentnessPath, digest(currentnessPath), true, exitPath];
  assert.equal(validatePdp0Predecessor(exit, exitPath, digest(exitPath), currentness,
    'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r10.json',
    digest(currentnessPath), true, exitPath).valid, false);
  assert.equal(validatePdp0Predecessor(exit, exitPath, `sha256:${'2'.repeat(64)}`,
    currentness, currentnessPath, digest(currentnessPath), true, exitPath).valid, false);
  assert.equal(validatePdp0Predecessor(exit, exitPath, digest(exitPath), currentness,
    currentnessPath, `sha256:${'3'.repeat(64)}`, true, exitPath).valid, false);
  assert.equal(validatePdp0Predecessor(...args.slice(0, 7), exitPath).valid, true);
});

test('PDP-1 no longer accepts historical R12 after the active matrix selects R15', () => {
  const exitPath = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r12.json';
  const currentnessPath = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r12.json';
  const exit = readJson(exitPath);
  const currentness = readJson(currentnessPath);
  assert.equal(digest(exitPath), 'sha256:91aeae0aad488bc8eb29d40bf955e527ef072ada762948064bc8e50422c5a5c5');
  assert.equal(digest(currentnessPath), 'sha256:14882e245fa1676138cfc5bd51ef0403cb96cf2f77542caa2c57dc683ca8b159');
  assert.equal(validatePdp0Predecessor(exit, exitPath, digest(exitPath), currentness,
    currentnessPath, digest(currentnessPath), true, exitPath).valid, false);
});

test('PDP-1 accepts only the matrix-selected R15 technical currentness pair with exact R3 impact attachment', () => {
  const matrix = readJson('docs/implementation/media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json');
  const exitPath = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r15.json';
  const currentnessPath = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r15.json';
  assert.equal(matrix.currentCut.phaseExit, exitPath);
  assert.equal(matrix.currentCut.currentnessObservation, currentnessPath);
  const exit = readJson(exitPath);
  const currentness = readJson(currentnessPath);
  const args = [exit, exitPath, digest(exitPath), currentness, currentnessPath, digest(currentnessPath), true, exitPath];
  assert.equal(exit.phaseExit.status, 'PASS');
  assert.equal(exit.sourceCurrentness.status, 'PASS');
  assert.equal(currentness.phaseDisposition.currentSourceCurrentness, 'PASS');
  assert.equal(currentness.phaseDisposition.pdp0Exit, 'BLOCKED_PENDING_OWNER_ACCEPTANCE');
  assert.equal(exit.delegatedOwnerAcceptance.status, 'INTERNAL_SUCCESSOR_IMPACT_DISPOSITION_ONLY_NOT_OWNER_ACCEPTANCE');
  assert.equal(validatePdp0Predecessor(...args).valid, true);

  assert.equal(validatePdp0Predecessor(exit, exitPath, `sha256:${'0'.repeat(64)}`,
    currentness, currentnessPath, digest(currentnessPath), true, exitPath).valid, false);
  assert.equal(validatePdp0Predecessor(exit, exitPath, digest(exitPath), currentness,
    currentnessPath.replace('r15', 'r14'), digest(currentnessPath), true, exitPath).valid, false);

  const failedExit = structuredClone(exit);
  failedExit.phaseExit.status = 'FAIL';
  assert.equal(validatePdp0Predecessor(failedExit, exitPath, digest(exitPath), currentness,
    currentnessPath, digest(currentnessPath), true, exitPath).valid, false);

  const wrongImpact = structuredClone(exit);
  wrongImpact.successorSourceImpactDisposition.externalContractDisposition.authoritySha256 = `sha256:${'1'.repeat(64)}`;
  assert.equal(validatePdp0Predecessor(wrongImpact, exitPath, digest(exitPath), currentness,
    currentnessPath, digest(currentnessPath), true, exitPath).valid, false);

  const unjoinedPass = structuredClone(exit);
  unjoinedPass.ownerStatusJoin.status = 'CURRENT_SOURCE_NO_IMPACT_DISPOSITION';
  assert.equal(validatePdp0Predecessor(unjoinedPass, exitPath, digest(exitPath), currentness,
    currentnessPath, digest(currentnessPath), true, exitPath).valid, false);

  const wrongCount = structuredClone(exit);
  wrongCount.sourceCurrentness.materialPathDenominator.uniquePaths += 1;
  assert.equal(validatePdp0Predecessor(wrongCount, exitPath, digest(exitPath), currentness,
    currentnessPath, digest(currentnessPath), true, exitPath).valid, false);
});

test('PDP-1 R27 successor impact binds exact local and Lifecycle transitions to P0 R15 without acceptance claims', () => {
  const recordPath = 'docs/implementation/observations/media-discovery-pdp1-r27-successor-source-impact-2026-10-15-r1.json';
  const record = readJson(recordPath);
  const p0Currentness = readJson('docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r15.json');
  const lifecycle = p0Currentness.externalOwnerContracts.repositories
    .find((repository) => repository.repositoryId === 'ghatana-lifecycle');
  const lifecyclePackage = lifecycle.files.find((file) => file.path === 'package.json');
  const lifecyclePackageObservedDigest = digest('../ghatana-lifecycle/package.json');
  const externalContracts = { repositories: [{
    repositoryId: lifecycle.repositoryId,
    files: [{
      path: lifecyclePackage.path,
      declaredContentSha256: lifecyclePackage.declaredContentSha256,
      observedContentSha256: lifecyclePackageObservedDigest,
      digestMatches: lifecyclePackageObservedDigest === lifecyclePackage.declaredContentSha256,
    }],
  }] };
  const observedDigests = Object.fromEntries(record.sourceDeltas.filter((row) => !row.repository)
    .map((row) => [row.path, digest(row.path)]));
  const args = { observedDigests, externalContracts, recordPath };
  const valid = validatePdp1R27SuccessorSourceImpact(record, args);
  assert.equal(valid.valid, true, JSON.stringify(valid));
  assert.deepEqual(valid.rowChecks.map(({ path: sourcePath, valid: rowValid }) => [sourcePath, rowValid]), [
    ['.product-experience/source-manifest.yaml', true],
    ['apps/media-experience-explorer/specification-artifacts.json', true],
    ['package.json', true],
  ]);
  assert.equal(valid.recordDigest, 'sha256:6fa4b507373e6303a05424dfae4f8eee29a2e7de217bc7d6540c95a3d28ca6bf');

  assert.equal(validatePdp1R27SuccessorSourceImpact(record, { ...args, recordPath: 'docs/implementation/observations/missing.json' }).valid, false);
  assert.equal(validatePdp1R27SuccessorSourceImpact(null, args).valid, false);
  const wrongLocalHash = structuredClone(record);
  wrongLocalHash.sourceDeltas[0].observedSha256 = `sha256:${'1'.repeat(64)}`;
  assert.equal(validatePdp1R27SuccessorSourceImpact(wrongLocalHash, args).valid, false);
  assert.equal(validatePdp1R27SuccessorSourceImpact(record, {
    ...args,
    externalContracts: { repositories: [{ repositoryId: 'ghatana-lifecycle', files: [{ path: 'package.json',
      declaredContentSha256: `sha256:${'2'.repeat(64)}`, observedContentSha256: `sha256:${'2'.repeat(64)}`, digestMatches: true }] }] },
  }).valid, false);
  const addedPath = structuredClone(record);
  addedPath.sourceDeltas.push({ ...addedPath.sourceDeltas[0], path: '.product-experience/unapproved.yaml' });
  assert.equal(validatePdp1R27SuccessorSourceImpact(addedPath, args).valid, false);
  const reclassified = structuredClone(record);
  reclassified.sourceDeltas[0].classification = 'PDP1_MEANING_CHANGE';
  assert.equal(validatePdp1R27SuccessorSourceImpact(reclassified, args).valid, false);
});

test('PDP-1 reporter successor chain proves R6 impact through exact R10 reporter currentness', () => {
  assert.equal(validatePdp0ReporterSuccessorImpact().valid, true);
  const invalidExit = readJson('docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r10.json');
  invalidExit.sourceCurrentness.sourceContentDigests['scripts/report-media-pdp-readiness.mjs'] = `sha256:${'0'.repeat(64)}`;
  assert.equal(validatePdp0ReporterSuccessorImpact({ p0Exit: invalidExit }).valid, false);
  const invalidDisposition = readJson('docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r10.json');
  invalidDisposition.successorSourceImpactDisposition.authoritySha256 = `sha256:${'1'.repeat(64)}`;
  assert.equal(validatePdp0ReporterSuccessorImpact({ p0Exit: invalidDisposition }).valid, false);
});

test('PDP-1 PXD-164 impact is bound to exact R22 source paths, meaning ID, and limited downstream disposition', () => {
  const recordPath = 'docs/implementation/observations/media-discovery-pdp1-pxd164-semantic-repair-impact-2026-10-14-r1.json';
  const record = readJson(recordPath);
  const predecessor = readJson('docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r22.json');
  const observedDigests = Object.fromEntries(pxd164Paths.map((sourcePath) => [sourcePath, digest(sourcePath)]));
  const expectedHistorical = Object.fromEntries(pxd164Paths.map((sourcePath) => [sourcePath, predecessor.sourceCurrentness.sourceContentDigests[sourcePath]]));
  assert.deepEqual(record.sourcePredecessor.sourceDigests, expectedHistorical);
  const valid = validatePdp1Pxd164SemanticRepairImpact(record, { observedDigests });
  assert.equal(valid.valid, true, JSON.stringify(valid));

  const wrongPredecessor = structuredClone(record);
  wrongPredecessor.sourcePredecessor.sha256 = `sha256:${'0'.repeat(64)}`;
  assert.equal(validatePdp1Pxd164SemanticRepairImpact(wrongPredecessor, { observedDigests }).valid, false);

  const wrongHash = structuredClone(record);
  wrongHash.sourceDeltas[0].observedSha256 = `sha256:${'1'.repeat(64)}`;
  assert.equal(validatePdp1Pxd164SemanticRepairImpact(wrongHash, { observedDigests }).valid, false);

  const wrongPath = structuredClone(record);
  wrongPath.sourceDeltas[0].path = '.product-experience/decision-log.md#PXD-164';
  assert.equal(validatePdp1Pxd164SemanticRepairImpact(wrongPath, { observedDigests }).valid, false);

  const wrongMeaning = structuredClone(record);
  wrongMeaning.sourceDeltas[2].meaningIdsChanged = ['PXD-164/MDC30-C-04'];
  assert.equal(validatePdp1Pxd164SemanticRepairImpact(wrongMeaning, { observedDigests }).valid, false);

  const falseAcceptance = structuredClone(record);
  falseAcceptance.decision.ownerAcceptance = 'ACCEPTED';
  assert.equal(validatePdp1Pxd164SemanticRepairImpact(falseAcceptance, { observedDigests }).valid, false);

  const falsePdp2Disposition = structuredClone(record);
  falsePdp2Disposition.decision.pdp2ImpactDisposition = 'NO_PDP2_IMPACT';
  assert.equal(validatePdp1Pxd164SemanticRepairImpact(falsePdp2Disposition, { observedDigests }).valid, false);

  assert.equal(validatePdp1Pxd164SemanticRepairImpact(record, {
    observedDigests, recordPath: 'docs/implementation/observations/other.json',
  }).valid, false);
});

test('PDP-1 PXD-164 supplemental pin dispositions classify only the exact semantic rows and verification transition', () => {
  const recordPath = 'docs/implementation/observations/media-discovery-pdp1-pxd164-semantic-repair-impact-2026-10-14-r1.json';
  const record = readJson(recordPath);
  const targetPaths = [
    '.product-experience/decision-log.md',
    '.product-experience/pdp-1-domain-data/owner-action-wire-contracts.yaml',
    'tests/pdp1-operation-current-source-review.test.mjs',
  ];
  const statusPins = readJson('docs/implementation/pdp-1-phase-dev-status.json').sourceShaSet;
  const semanticPins = readJson('docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json').sourceFingerprints;
  const observedDigests = Object.fromEntries([...new Set([
    ...pxd164Paths,
    'scripts/lib/pdp-selected-target-operation-binding.mjs',
    'tests/pdp1-j04-selected-target-operation-binding.test.mjs',
    ...targetPaths,
  ])].map((sourcePath) => [sourcePath, digest(sourcePath)]));
  const args = { record, recordPath, statusPins, semanticPins, fileDigests: observedDigests };
  const dispositions = validatePdp1Pxd164SupplementalPinDispositions(args);
  const joinedPinChanges = dispositions.map(pdp1SupplementalPinChangeDisposition);
  assert.deepEqual(joinedPinChanges.map(({ classification, meaningChange, meaningIdsChanged }) => ({
    classification, meaningChange, meaningIdsChanged,
  })), [
    {
      classification: 'PXD164_SPEECH_SELECTED_TARGET_WRAPPER_SEMANTIC_REPAIR',
      meaningChange: 'PDP1_MEANING_CHANGED_AND_REVIEWED_UNDER_DELEGATED_INTERNAL_SOURCE_REVIEW',
      meaningIdsChanged: ['media.operation.action.request-admitted-speech-operation'],
    },
    {
      classification: 'PXD164_SPEECH_SELECTED_TARGET_WRAPPER_WIRE_ALIGNMENT',
      meaningChange: 'PDP1_MEANING_CHANGED_AND_REVIEWED_UNDER_DELEGATED_INTERNAL_SOURCE_REVIEW',
      meaningIdsChanged: ['media.operation.action.request-admitted-speech-operation'],
    },
    {
      classification: 'PDP1_FOCUSED_VERIFICATION_ONLY',
      meaningChange: 'NO_PDP1_MEANING_CHANGE',
      meaningIdsChanged: [],
    },
  ]);
  assert.deepEqual(dispositions.map(({ path, predecessorSha256, observedSha256, classification, meaningChange, meaningIdsChanged, valid, freshCurrentnessRequired }) => ({
    path, predecessorSha256, observedSha256, classification, meaningChange, meaningIdsChanged, valid, freshCurrentnessRequired,
  })), [
    {
      path: targetPaths[0],
      predecessorSha256: 'sha256:9831b03ecd3f30d2cbfd7a1db62d934035ba20cf1482bb5e621d166eacdb9b4c',
      observedSha256: 'sha256:97ad3104abec9ba6670804394c68a11c663f37171e90ea2a1f2e629aa5619bbc',
      classification: 'PXD164_SPEECH_SELECTED_TARGET_WRAPPER_SEMANTIC_REPAIR',
      meaningChange: 'PDP1_MEANING_CHANGED_AND_REVIEWED_UNDER_DELEGATED_INTERNAL_SOURCE_REVIEW',
      meaningIdsChanged: ['media.operation.action.request-admitted-speech-operation'],
      valid: true, freshCurrentnessRequired: true,
    },
    {
      path: targetPaths[1],
      predecessorSha256: 'sha256:19605e76b089ffc91cc7a08ce09bed375c638c29edf7b623df61ca2e89cfcf0b',
      observedSha256: 'sha256:c5f6a711b9b8d90e139aeeda5bc22eebd90648f544a9dca17bb72b7cafb55bda',
      classification: 'PXD164_SPEECH_SELECTED_TARGET_WRAPPER_WIRE_ALIGNMENT',
      meaningChange: 'PDP1_MEANING_CHANGED_AND_REVIEWED_UNDER_DELEGATED_INTERNAL_SOURCE_REVIEW',
      meaningIdsChanged: ['media.operation.action.request-admitted-speech-operation'],
      valid: true, freshCurrentnessRequired: true,
    },
    {
      path: targetPaths[2],
      predecessorSha256: 'sha256:0eba3c1f978587e94052b717ecb3a712104e972cfeeeddeef65982a5ebf2f641',
      observedSha256: 'sha256:fae9e284461a294d15de7acfc05fa739f26ccf20b351107916fe32206497e331',
      classification: 'PDP1_FOCUSED_VERIFICATION_ONLY',
      meaningChange: 'NO_PDP1_MEANING_CHANGE',
      meaningIdsChanged: [],
      valid: true, freshCurrentnessRequired: true,
    },
  ]);
  assert.equal(validatePdp1Pxd164SupplementalPinDispositions({ ...args, statusPins: { ...statusPins, [targetPaths[0]]: '0'.repeat(64) } }).every((entry) => entry.valid), false);
  const staleSemanticPin = validatePdp1Pxd164SupplementalPinDispositions({
    ...args,
    semanticPins: { ...semanticPins, [targetPaths[0]]: '0'.repeat(64) },
  });
  assert.equal(staleSemanticPin.find((entry) => entry.path === targetPaths[0]).valid, false);
  assert.equal(validatePdp1Pxd164SupplementalPinDispositions({ ...args, fileDigests: { ...observedDigests, [targetPaths[1]]: `sha256:${'1'.repeat(64)}` } }).every((entry) => entry.valid), false);
  const changedRecordHash = structuredClone(record);
  changedRecordHash.sourceDeltas[0].observedSha256 = `sha256:${'2'.repeat(64)}`;
  assert.equal(validatePdp1Pxd164SupplementalPinDispositions({ ...args, record: changedRecordHash }).every((entry) => entry.valid), false);
  const changedClassification = structuredClone(record);
  changedClassification.sourceDeltas[0].classification = 'PXD164_SPEECH_SELECTED_TARGET_WRAPPER_WIRE_ALIGNMENT';
  assert.equal(changedClassification.sourceDeltas[0].classification.startsWith('PXD164_SPEECH_SELECTED_TARGET_WRAPPER_'), true);
  assert.equal(validatePdp1Pxd164SupplementalPinDispositions({ ...args, record: changedClassification }).every((entry) => entry.valid), false);
  const changedRowScope = structuredClone(record);
  changedRowScope.sourceDeltas.push({ ...changedRowScope.sourceDeltas[0], path: '.product-experience/other.yaml' });
  assert.equal(validatePdp1Pxd164SupplementalPinDispositions({ ...args, record: changedRowScope }).every((entry) => entry.valid), false);
});

test('PDP-1 interface chain preserves R4, authorized R16 transition, and current operation review pins', () => {
  const input = chainInputs();
  const args = { ...input, threeReviewTransition: input.transition, c22Impact: input.c22 };
  const validResult = validatePdp1InterfaceReviewSuccessorChain(args);
  const olderBridge = validatePdp1AdditionalSourceImpactRecord(
    readJson('docs/implementation/observations/media-discovery-current-cut-source-impact-2026-10-14-r2.json'),
    { impact: readJson('docs/implementation/observations/media-discovery-current-cut-source-impact-2026-10-14-r1.json'), ...input },
  );
  assert.equal(validResult.valid, true, JSON.stringify({ validResult, olderBridge, transition: input.transition, c22: input.c22 }));
  const interfaceRow = input.transition.rowChecks.find((row) => row.path === interfacePath);
  const pinRefresh = validResult.interfacePinRefreshImpact;
  assert.deepEqual({
    r16ToR27AuthorizedTransition: [interfaceRow?.predecessorSha256, interfaceRow?.observedSha256],
    r27ToP2R5AuthorizedTransition: [pinRefresh?.predecessorAuthorization?.predecessorSha256,
      pinRefresh?.predecessorAuthorization?.observedSha256],
    p2R1ToUserAuthorizedCurrentTransition: [pinRefresh?.successorAuthorization?.predecessorSha256,
      pinRefresh?.successorAuthorization?.observedSha256],
    directUserAuthorization: pinRefresh?.supplementalAuthorization?.valid,
    liveDigest: pinRefresh?.liveSha256,
  }, {
    r16ToR27AuthorizedTransition: [
      'sha256:0ce764d11912596ee39057db9bd0f2dfbf3c85f6269d55632bda3b3e6e4ad0dd',
      'sha256:90fc6830f99e26abd4c27222a6193f98b1756dfa48a9ac533b86c7de6ad2fa76',
    ],
    r27ToP2R5AuthorizedTransition: [
      'sha256:90fc6830f99e26abd4c27222a6193f98b1756dfa48a9ac533b86c7de6ad2fa76',
      'sha256:866729bdb41448d7e1d08ca288e5e71300f999d26e85cd53d2e5377ecdf299bd',
    ],
    p2R1ToUserAuthorizedCurrentTransition: [
      'sha256:866729bdb41448d7e1d08ca288e5e71300f999d26e85cd53d2e5377ecdf299bd',
      'sha256:64796cfb0db909a36e030041b2d51d02fd19fc115d703cc16bca37116f92ed06',
    ],
    directUserAuthorization: true,
    liveDigest: 'sha256:64796cfb0db909a36e030041b2d51d02fd19fc115d703cc16bca37116f92ed06',
  });
  assert.equal(validResult.operationParityProjectionImpact?.valid, true);
  assert.equal(validResult.operationParityProjectionImpact?.recordId,
    'MEDIA-DISCOVERY-PDP1-OPERATION-PARITY-PROJECTION-IMPACT-2026-10-14-R1');
  assert.deepEqual(validResult.operationParityProjectionImpact?.rowChecks.map((row) => row.path), [
    '.product-experience/interface-parity/operation-parity.yaml',
    interfacePath,
    operationsReviewPath,
    'tests/pdp1-interface-current-source-review.test.mjs',
  ]);
  const badR1R2 = readJson('docs/implementation/observations/media-discovery-current-cut-source-impact-2026-10-14-r2.json');
  badR1R2.parentImpact.sha256 = `sha256:${'6'.repeat(64)}`;
  assert.equal(validatePdp1AdditionalSourceImpactRecord(badR1R2, {
    impact: readJson('docs/implementation/observations/media-discovery-current-cut-source-impact-2026-10-14-r1.json'), ...input,
  }).valid, false);
  const badR2R4 = readJson('docs/implementation/observations/media-discovery-current-cut-source-impact-2026-10-14-r4.json');
  badR2R4.parentImpact.sha256 = `sha256:${'7'.repeat(64)}`;
  assert.equal(validatePdp1InterfaceReviewImpactRecord(badR2R4, {
    predecessorRecord: readJson('docs/implementation/observations/media-discovery-current-cut-source-impact-2026-10-14-r2.json'),
    observedDigests: input.observedDigests, historicalDigests: input.historicalDigests,
    statusPins: input.statusPins, semanticPins: input.semanticPins,
  }).valid, false);
  const badR4Edge = structuredClone(input);
  badR4Edge.transition.rowChecks[0].predecessorSha256 = `sha256:${'4'.repeat(64)}`;
  assert.equal(validatePdp1InterfaceReviewSuccessorChain({ ...args, threeReviewTransition: badR4Edge.transition }).valid, false);
  const badR4Successor = structuredClone(input);
  badR4Successor.transition.rowChecks[0].observedSha256 = `sha256:${'8'.repeat(64)}`;
  assert.equal(validatePdp1InterfaceReviewSuccessorChain({ ...args, threeReviewTransition: badR4Successor.transition }).valid, false);
  const badC22Edge = structuredClone(input);
  badC22Edge.c22.sourceDeltas.find((row) => row.path === operationsPath).predecessorSha256 = `sha256:${'5'.repeat(64)}`;
  assert.equal(validatePdp1InterfaceReviewSuccessorChain({ ...args, c22Impact: badC22Edge.c22 }).valid, false);
  assert.equal(validatePdp1InterfaceReviewSuccessorChain({ ...args, observedDigests: { ...args.observedDigests, [interfacePath]: `sha256:${'2'.repeat(64)}` } }).valid, false);
  assert.equal(validatePdp1InterfaceReviewSuccessorChain({ ...args, threeReviewTransition: { ...input.transition, valid: false } }).valid, false);
  assert.equal(validatePdp1InterfaceReviewSuccessorChain({ ...args, c22Impact: { ...input.c22, valid: false } }).valid, false);
});

test('PDP-1 owner-status-join test chain preserves R3/R4 and binds the exact R5 successor', () => {
  const recordPath = 'docs/implementation/observations/media-discovery-pdp1-owner-status-join-test-refresh-2026-10-14-r3.json';
  const record = readJson(recordPath);
  const input = { [ownerStatusJoinTestPath]: {
    digest: 'sha256:c4b761d019b313d4e7fecf9a813ae007ae435e08c451aa0f127bb3751eaa156d',
  } };
  const valid = validatePdp1OwnerStatusJoinTestTransition(record, { recordPath, testInputDigests: input });
  assert.equal(valid.valid, true, JSON.stringify(valid));
  assert.equal(valid.exactR4Successor, true, 'R4 remains intact as the historical R3 successor');
  assert.equal(valid.exactR5Successor, true, 'R5 binds the exact R4-to-current test-only transition');
  assert.equal(valid.predecessorSha256, 'sha256:ec1169c9c7a5c147dac13a24460d5f73dc9517861752bb0b5b1fe72f9f068d88');
  assert.equal(valid.observedSha256, input['tests/media-discovery-pdp1-supplemental-owner-status-join.test.mjs'].digest);

  const wrongInput = { ...input, 'tests/media-discovery-pdp1-supplemental-owner-status-join.test.mjs': { digest: `sha256:${'0'.repeat(64)}` } };
  const rejectedInput = validatePdp1OwnerStatusJoinTestTransition(record, { recordPath, testInputDigests: wrongInput });
  assert.equal(rejectedInput.valid, false);
  assert.equal(rejectedInput.exactR5Successor, false);
  assert.equal(validatePdp1OwnerStatusJoinTestTransition(record, { recordPath: `${recordPath}.wrong`, testInputDigests: input }).valid, false);
  const alteredR3 = structuredClone(record);
  alteredR3.sourceTransition.observedSha256 = `sha256:${'1'.repeat(64)}`;
  assert.equal(validatePdp1OwnerStatusJoinTestTransition(alteredR3, { recordPath, testInputDigests: input }).valid, false);
});

test('PDP-1 owner-wire chain preserves R5 and exact C22 semantic repair into current status pins', () => {
  const input = chainInputs();
  const args = { ...input, c22Impact: input.c22 };
  assert.equal(validatePdp1OwnerWireC22SuccessorChain(args).valid, true);
  assert.equal(validatePdp1OwnerWireC22SuccessorChain({ ...args, observedDigests: { ...args.observedDigests, [ownerWirePath]: `sha256:${'3'.repeat(64)}` } }).valid, false);
  assert.equal(validatePdp1OwnerWireC22SuccessorChain({ ...args, statusPins: { ...args.statusPins, [ownerWirePath]: 'f'.repeat(64) } }).valid, false);
  assert.equal(validatePdp1OwnerWireC22SuccessorChain({ ...args, c22Impact: { ...input.c22, valid: false } }).valid, false);
  const wrongC22Selector = structuredClone(input.c22);
  wrongC22Selector.sourceDeltas.find((row) => row.path === ownerWirePath).selector += '/wrong';
  assert.equal(validatePdp1OwnerWireC22SuccessorChain({ ...args, c22Impact: wrongC22Selector }).valid, false);
  const wrongC22Meaning = readJson('docs/implementation/observations/media-discovery-pdp1-c22-semantic-repair-impact-2026-10-14.json');
  wrongC22Meaning.sourceDeltas.find((row) => row.path === ownerWirePath).meaningChange = 'NO_CHANGE';
  assert.equal(validatePdp1C22SemanticRepairImpact(wrongC22Meaning, {
    observedDigests: input.observedDigests,
    historicalDigests: {
      [operationsPath]: 'sha256:ec1e29eceb76333dec91b52b94d20fa882456dcb52989b1794c4f9c58fdfd111',
      [ownerWirePath]: 'sha256:e7c432e0244e7c719d211d16dd7c7d94d1c7dc87b33f339ed72ddcf5bd6e4a9b',
    },
    statusPins: input.statusPins, semanticPins: input.semanticPins,
  }).valid, false);
  const wrongC22Predecessor = structuredClone(input.c22);
  wrongC22Predecessor.sourceDeltas.find((row) => row.path === ownerWirePath).predecessorSha256 = `sha256:${'9'.repeat(64)}`;
  assert.equal(validatePdp1OwnerWireC22SuccessorChain({ ...args, c22Impact: wrongC22Predecessor }).valid, false);
});
