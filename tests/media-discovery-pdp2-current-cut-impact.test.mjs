import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  aggregateCurrentCellDigests,
  ownerStatusJoin,
  validatePdp1EvidenceRefresh,
  validatePdp2CombinedSourceRefresh,
  validatePdp2CurrentCutImpact,
} from '../scripts/capture-media-discovery-pdp2-current-cut.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const impactPath = 'docs/implementation/observations/media-discovery-pdp2-current-cut-source-impact-2026-10-14-r1.json';
const predecessorPath = 'docs/implementation/observations/media-discovery-pdp2-exit-2026-10-14-current-cut-r4.json';
const impact = read(impactPath);
const predecessor = read(predecessorPath);
const pdp1Exit = read('docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r13.json');
const pdp1ExitPath = 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r13.json';
const statusPath = 'docs/implementation/pdp-1-phase-dev-status.json';
const semanticReviewPath = 'docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json';
const statusSource = read(statusPath);
const semanticReviewSource = read(semanticReviewPath);
const operationsSourcePath = '.product-experience/pdp-1-domain-data/operations.yaml';
const operationsReviewPath = '.product-experience/pdp-1-domain-data/operations-current-source-review.json';
const operationsSourceText = fs.readFileSync(path.join(root, operationsSourcePath), 'utf8');
const operationsReviewText = fs.readFileSync(path.join(root, operationsReviewPath), 'utf8');
const impactDigest = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, impactPath))).digest('hex')}`;
const predecessorDigest = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, predecessorPath))).digest('hex')}`;
const pdp1ExitDigest = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, pdp1ExitPath))).digest('hex')}`;
const p1EvidencePaths = [statusPath, semanticReviewPath];
const sha = (sourcePath) => `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, sourcePath))).digest('hex')}`;

function fixture({ mutateImpact, mutateCurrent, mutateActual, mutateP1Exit, mutateStatus, mutateSemanticReview, mutateOperationsReview, overridePredecessorDigest } = {}) {
  const candidate = structuredClone(impact);
  mutateImpact?.(candidate);
  const candidateP1Exit = structuredClone(pdp1Exit);
  mutateP1Exit?.(candidateP1Exit);
  const candidateStatus = structuredClone(statusSource);
  mutateStatus?.(candidateStatus);
  const candidateSemanticReview = structuredClone(semanticReviewSource);
  mutateSemanticReview?.(candidateSemanticReview);
  const candidateOperationsReview = structuredClone(read(operationsReviewPath));
  mutateOperationsReview?.(candidateOperationsReview);
  const currentDigests = { ...predecessor.sourceCurrentness.sourceSetDigests.sourceContentDigests };
  const actualCurrentDigests = {};
  for (const delta of candidate.sourceDeltas) {
    currentDigests[delta.path] = delta.observedSha256;
    actualCurrentDigests[delta.path] = delta.observedSha256;
  }
  currentDigests[statusPath] = sha(statusPath);
  currentDigests[semanticReviewPath] = sha(semanticReviewPath);
  actualCurrentDigests[statusPath] = sha(statusPath);
  actualCurrentDigests[semanticReviewPath] = sha(semanticReviewPath);
  mutateCurrent?.(currentDigests);
  mutateActual?.(actualCurrentDigests);
  const p2Impact = validatePdp2CurrentCutImpact({
    impact: candidate,
    predecessor,
    currentDigests,
    actualCurrentDigests,
    predecessorDigest: overridePredecessorDigest ?? predecessorDigest,
    impactDigest,
  });
  const p1EvidenceRefresh = validatePdp1EvidenceRefresh({
    predecessor,
    currentDigests,
    actualCurrentDigests,
    pdp1Exit: candidateP1Exit,
    pdp1ExitDigest,
    statusSource: candidateStatus,
    semanticReviewSource: candidateSemanticReview,
    operationsSourceText,
    operationsReviewText,
    operationsReviewSource: candidateOperationsReview,
  });
  const combined = validatePdp2CombinedSourceRefresh({ predecessor, currentDigests, p2Impact, p1EvidenceRefresh });
  return { p2Impact, p1EvidenceRefresh, combined, currentDigests, actualCurrentDigests };
}

test('PDP-2 and PDP-1 evidence joins partition exactly four R4-to-current paths', () => {
  const { p2Impact, p1EvidenceRefresh, combined } = fixture();
  assert.equal(p2Impact.valid, true);
  assert.equal(p2Impact.changedPathCount, 4);
  assert.equal(p2Impact.scopedChangedPaths.length, 2);
  assert.equal(p2Impact.transitionCount, 2);
  assert.equal(p2Impact.meaningChangeCount, 0);
  assert.equal(p2Impact.independentOrExternalOrLifecycleClaims, false);
  assert.equal(p1EvidenceRefresh.valid, true);
  assert.equal(p1EvidenceRefresh.classification, 'PDP1_STATUS_AND_SEMANTIC_REVIEW_EVIDENCE_REFRESH_NO_PDP2_MEANING_DISPOSITION');
  assert.equal(p1EvidenceRefresh.pdp1Proof.developmentStatus, 'DEV_COMPLETE');
  assert.equal(p1EvidenceRefresh.pdp1Proof.outstandingMeaningIdCount, 0);
  assert.equal(p1EvidenceRefresh.pdp1Proof.cellCount, 50);
  assert.equal(p1EvidenceRefresh.pdp1Proof.materialPathCount, 329);
  assert.deepEqual(p1EvidenceRefresh.pdp1Proof.historicalStatusPins, [113, 113]);
  assert.deepEqual(p1EvidenceRefresh.pdp1Proof.historicalSemanticReviewPins, [104, 104]);
  assert.equal(p1EvidenceRefresh.pdp1Proof.testCount, 75);
  assert.equal(p1EvidenceRefresh.pdp1Proof.passedCount, 75);
  assert.equal(p1EvidenceRefresh.pdp1Proof.currentStatusPhaseTestCount, 343);
  assert.equal(p1EvidenceRefresh.pdp1Proof.currentStatusPhasePassedCount, 343);
  assert.equal(p1EvidenceRefresh.pdp1Proof.historicalDefinitionGateTestCount, 342);
  assert.equal(p1EvidenceRefresh.pdp1Proof.p1SemanticMeaningIds.length, 5);
  assert.equal(p1EvidenceRefresh.pdp1Proof.p1DefinitionSourceHashesMatch, true);
  assert.equal(p1EvidenceRefresh.pdp1Proof.p1DefinitionReviewIdsMatch, true);
  assert.equal(p1EvidenceRefresh.pdp1Proof.p1ObservedHead, statusSource.mainSha);
  assert.match(p1EvidenceRefresh.pdp1Proof.supersededPhaseReviewMarker, /tests and phase-exit capture remain pending/u);
  assert.equal(p1EvidenceRefresh.pdp1Proof.supersededParityMarker, 'CURRENT_SOURCE_BOUND_REQUIRED_PDP1_SUITE_PENDING');
  assert.equal(p1EvidenceRefresh.historicalPendingReconciliation.currentStatusGate.testCount, 343);
  assert.equal(p1EvidenceRefresh.historicalPendingReconciliation.successorPdp1Receipt.phaseStatus, 'PASS');
  assert.match(p1EvidenceRefresh.historicalPendingReconciliation.disposition, /P1_SEMANTIC_DELTA_REMAINS_SEPARATELY_RECORDED/u);
  assert.equal(combined.valid, true);
  assert.equal(combined.predecessorPathCount, 405);
  assert.equal(combined.currentPathCount, 405);
  assert.equal(combined.changedPathCount, 4);
  assert.equal(combined.missingPaths.length, 0);
  assert.equal(combined.additionalPaths.length, 0);
  assert.deepEqual(combined.pdp2MeaningDispositionAppliedOnlyTo, impact.sourceDeltas.map(({ path: sourcePath }) => sourcePath));
});

test('currentness aggregates the unique path union across all cells and rejects conflicting repeated hashes', () => {
  assert.deepEqual(aggregateCurrentCellDigests([
    { fileContentDigests: { 'a.yaml': 'sha256:a', 'shared.yaml': 'sha256:s' } },
    { fileContentDigests: { 'b.yaml': 'sha256:b', 'shared.yaml': 'sha256:s' } },
  ]), {
    'a.yaml': 'sha256:a',
    'shared.yaml': 'sha256:s',
    'b.yaml': 'sha256:b',
  });
  assert.throws(() => aggregateCurrentCellDigests([
    { fileContentDigests: { 'shared.yaml': 'sha256:first' } },
    { fileContentDigests: { 'shared.yaml': 'sha256:conflict' } },
  ]), /Conflicting current cell digests for shared\.yaml/u);
});

test('PDP-2 scoped impact rejects a different path, source hash, authorization, predecessor, or changed meaning', () => {
  assert.equal(fixture({ mutateImpact: (value) => { value.sourceDeltas[0].path = 'some/other.json'; } }).p2Impact.valid, false);
  assert.equal(fixture({ mutateImpact: (value) => { value.sourceDeltas[0].observedSha256 = `sha256:${'0'.repeat(64)}`; } }).p2Impact.valid, false);
  assert.equal(fixture({ mutateImpact: (value) => { value.authority.userAuthorization = 'Other authorization'; } }).p2Impact.valid, false);
  assert.equal(fixture({ overridePredecessorDigest: `sha256:${'0'.repeat(64)}` }).p2Impact.valid, false);
  assert.equal(fixture({ mutateImpact: (value) => { value.sourceDeltas[0].meaningChange = 'PDP2_MEANING_CHANGED'; } }).p2Impact.valid, false);
});

test('PDP-2 scoped impact rejects any third changed path, missing or extra path, and bytes that differ from the record', () => {
  assert.equal(fixture({ mutateCurrent: (digests) => { digests['.product-experience/pdp-2-design-interface-system/DESIGN-LANGUAGE.md'] = `sha256:${'1'.repeat(64)}`; } }).combined.valid, false);
  assert.equal(fixture({ mutateCurrent: (digests) => { delete digests['.product-experience/interface-parity/current-source-review.json']; } }).p2Impact.valid, false);
  assert.equal(fixture({ mutateCurrent: (digests) => { digests['extra/unpinned.txt'] = `sha256:${'2'.repeat(64)}`; } }).combined.valid, false);
  assert.equal(fixture({ mutateActual: (digests) => { digests['scripts/report-media-pdp-readiness.mjs'] = `sha256:${'3'.repeat(64)}`; } }).p2Impact.valid, false);
  assert.equal(fixture({ mutateP1Exit: (value) => { value.authority.historicalPinReview.historicalStatusChangedPinCount = 1; } }).p1EvidenceRefresh.valid, false);
  assert.equal(fixture({ mutateP1Exit: (value) => { value.ownerStatusJoin.testEvidence.skippedCount = 1; } }).p1EvidenceRefresh.valid, false);
  assert.equal(fixture({ mutateP1Exit: (value) => { value.phaseExit.status = 'FAIL'; } }).p1EvidenceRefresh.valid, false);
  for (const sourcePath of [operationsSourcePath, operationsReviewPath]) {
    assert.equal(fixture({ mutateP1Exit: (value) => { value.sourceCurrentness.sourceContentDigests[sourcePath] = `sha256:${'0'.repeat(64)}`; } }).p1EvidenceRefresh.valid, false);
    assert.equal(fixture({ mutateStatus: (value) => { value.sourceShaSet[sourcePath] = '0'.repeat(64); } }).p1EvidenceRefresh.valid, false);
  }
  assert.equal(fixture({ mutateP1Exit: (value) => { value.ownerStatusJoin.supplementalPdp1DefinitionReview.reviewedDefinitionIds[0] = 'wrong.id'; } }).p1EvidenceRefresh.valid, false);
  assert.equal(fixture({ mutateP1Exit: (value) => { value.ownerStatusJoin.supplementalPdp1DefinitionReview.observedSha256 = `sha256:${'0'.repeat(64)}`; } }).p1EvidenceRefresh.valid, false);
  assert.equal(fixture({ mutateP1Exit: (value) => { value.campaign.observedHead = 'wrong-head'; } }).p1EvidenceRefresh.valid, false);
  assert.equal(fixture({ mutateP1Exit: (value) => { value.testRun.startedHead = 'wrong-head'; } }).p1EvidenceRefresh.valid, false);
  assert.equal(fixture({ mutateP1Exit: (value) => { value.testRun.completedHead = 'wrong-head'; } }).p1EvidenceRefresh.valid, false);
  assert.equal(fixture({ mutateStatus: (value) => { value.outstandingMeaningIds.push('unexpected'); } }).p1EvidenceRefresh.valid, false);
  assert.equal(fixture({ mutateStatus: (value) => { value.mainSha = 'wrong-head'; } }).p1EvidenceRefresh.valid, false);
  assert.equal(fixture({ mutateStatus: (value) => { value.sourceIdentityIds[0] = 'wrong-identity'; } }).p1EvidenceRefresh.valid, false);
  assert.equal(fixture({ mutateSemanticReview: (value) => { value.sourceCutStable = false; } }).p1EvidenceRefresh.valid, false);
  assert.equal(fixture({ mutateSemanticReview: (value) => { value.sourceFingerprints[operationsSourcePath] = 'wrong-hash'; } }).p1EvidenceRefresh.valid, false);
  assert.equal(fixture({ mutateSemanticReview: (value) => { value.sourceFingerprints[operationsReviewPath] = 'wrong-hash'; } }).p1EvidenceRefresh.valid, false);
  assert.equal(fixture({ mutateSemanticReview: (value) => { value.reviewedIdentityIds[0] = 'wrong-identity'; } }).p1EvidenceRefresh.valid, false);
  assert.equal(fixture({ mutateSemanticReview: (value) => { value.supplementaryReviews.find((review) => review.id === 'P1-current-owner-typed-observation-definition-delta-2026-10-14').sourceSha256 = 'wrong-hash'; } }).p1EvidenceRefresh.valid, false);
  assert.equal(fixture({ mutateOperationsReview: (value) => { value.currentSourceCutDeltaReview.supplementalPdp1DefinitionDelta.reviewedRecords[0].meaning = ''; } }).p1EvidenceRefresh.valid, false);
  assert.equal(fixture({ mutateOperationsReview: (value) => { value.currentSourceCutDeltaReview.supplementalPdp1DefinitionDelta.reviewedRecords[0].id = 'wrong.id'; } }).p1EvidenceRefresh.valid, false);
  assert.equal(fixture({ mutateSemanticReview: (value) => { value.currentCutReview.parityTestPinDispositionReview.verificationStatus = 'PASS'; } }).p1EvidenceRefresh.valid, false);
  assert.equal(fixture({ mutateSemanticReview: (value) => { value.currentCutReview.definitionContractRefresh.verificationEvidence.fullPhaseGate.testCount = 343; } }).p1EvidenceRefresh.valid, false);
});

test('the live R4 comparison joins only the two P2 changes and two R13 evidence refreshes', () => {
  const currentDigests = { ...predecessor.sourceCurrentness.sourceSetDigests.sourceContentDigests };
  for (const sourcePath of Object.keys(currentDigests)) {
    currentDigests[sourcePath] = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, sourcePath))).digest('hex')}`;
  }
  const actualCurrentDigests = Object.fromEntries([...impact.sourceDeltas.map(({ path: sourcePath }) => sourcePath), ...p1EvidencePaths].map((sourcePath) => [sourcePath, currentDigests[sourcePath]]));
  const p2Impact = validatePdp2CurrentCutImpact({ impact, predecessor, currentDigests, actualCurrentDigests, predecessorDigest, impactDigest });
  const p1EvidenceRefresh = validatePdp1EvidenceRefresh({ predecessor, currentDigests, actualCurrentDigests, pdp1Exit, pdp1ExitDigest, statusSource, semanticReviewSource, operationsSourceText, operationsReviewText, operationsReviewSource: read(operationsReviewPath) });
  const result = validatePdp2CombinedSourceRefresh({ predecessor, currentDigests, p2Impact, p1EvidenceRefresh });
  assert.equal(result.valid, true);
  assert.equal(result.changedPathCount, 4);
});

test('the combined R4 join rejects a fifth changed path even when both separate evidence joins pass', () => {
  const { p2Impact, p1EvidenceRefresh, currentDigests } = fixture();
  const extra = { ...currentDigests, 'tests/not-in-pdp2-cut.test.mjs': `sha256:${'4'.repeat(64)}` };
  const result = validatePdp2CombinedSourceRefresh({ predecessor, currentDigests: extra, p2Impact, p1EvidenceRefresh });
  assert.equal(p2Impact.valid, true);
  assert.equal(p1EvidenceRefresh.valid, true);
  assert.equal(result.valid, false);
  assert.equal(result.additionalPaths.length, 1);
});

test('the historical R2-to-live ownerStatusJoin retains eight unique paths across nine source transitions', () => {
  const historicalR2 = read('docs/implementation/observations/media-discovery-pdp2-exit-2026-10-13-r2.json');
  const ownerDirections = read('docs/implementation/observations/media-discovery-current-cut-owner-directions-2026-10-13-r2.json');
  const ownerReview = ownerDirections.predecessorImpactReviews.find((review) => review.phase === 'PDP-2');
  const currentDigests = Object.fromEntries(Object.keys(historicalR2.sourceCurrentness.sourceSetDigests.sourceContentDigests)
    .map((sourcePath) => [sourcePath, sha(sourcePath)]));
  const result = ownerStatusJoin(historicalR2, currentDigests, ownerReview, 'sha256:current-test-material-fingerprint');
  assert.equal(result.status, 'PASS');
  assert.equal(result.changedPathCount, 8);
  assert.equal(result.uniqueChangedPathCount, 8);
  assert.equal(result.changeTransitionCount, 9);
  assert.deepEqual(result.duplicateTransitionPaths, ['scripts/report-media-pdp-readiness.mjs']);
  const p1RefreshChecks = result.changedPathChecks.filter((entry) => entry.upstreamPhaseEvidence === 'PDP-1');
  assert.equal(p1RefreshChecks.length, 2);
  assert.ok(p1RefreshChecks.every((entry) => entry.meaningPhaseReviewed === 'PDP-2' && entry.meaningIdsChangedAtReviewedCut.length === 0));
});
