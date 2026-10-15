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
  validatePdp2AdditionalSourceImpact,
  validatePdp2CurrentCutImpact,
  pdp2CurrentCutImpact,
  currentnessOwnerStatusJoin,
  sourcePinReview,
  pdp2OwnerReview,
  validatePdp1Predecessor,
  validatePdp1R27SourceMapBridge,
  validatePdp2R16ProjectionImpact,
  composePdp2CurrentnessSourceChains,
  pdp3StatusGuardSupplement,
} from '../scripts/capture-media-discovery-pdp2-current-cut.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const impactPath = 'docs/implementation/observations/media-discovery-pdp2-current-cut-source-impact-2026-10-14-r2.json';
const impactR3Path = 'docs/implementation/observations/media-discovery-pdp2-current-cut-source-impact-2026-10-14-r3.json';
const predecessorPath = 'docs/implementation/observations/media-discovery-pdp2-exit-2026-10-14-current-cut-r4.json';
const impact = read(impactPath);
const predecessor = read(predecessorPath);
const currentPredecessorPath = 'docs/implementation/observations/media-discovery-pdp2-exit-current-cut-r9.json';
const currentPredecessor = read(currentPredecessorPath);
const pdp1ExitPath = 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r15.json';
const pdp1Exit = read(pdp1ExitPath);
const pdp1ExitR16Path = 'docs/implementation/observations/media-discovery-pdp1-exit-current-cut-r16.json';
const pdp1ExitR16 = read(pdp1ExitR16Path);
const impactR3 = read(impactR3Path);
const statusPath = 'docs/implementation/pdp-1-phase-dev-status.json';
const semanticReviewPath = 'docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json';
const decisionLogPath = '.product-experience/decision-log.md';
const interfaceReviewPath = '.product-experience/interface-parity/current-source-review.json';
const handoffContractsPath = '.product-experience/pdp-1-domain-data/handoff-contracts.yaml';
const reporterPath = 'scripts/report-media-pdp-readiness.mjs';
const statusSource = read(statusPath);
const semanticReviewSource = read(semanticReviewPath);
const decisionLogText = fs.readFileSync(path.join(root, decisionLogPath), 'utf8');
const interfaceReviewText = fs.readFileSync(path.join(root, interfaceReviewPath), 'utf8');
const handoffContractsText = fs.readFileSync(path.join(root, handoffContractsPath), 'utf8');
const reporterText = fs.readFileSync(path.join(root, reporterPath), 'utf8');
const operationsSourcePath = '.product-experience/pdp-1-domain-data/operations.yaml';
const operationsReviewPath = '.product-experience/pdp-1-domain-data/operations-current-source-review.json';
const operationsSourceText = fs.readFileSync(path.join(root, operationsSourcePath), 'utf8');
const operationsReviewText = fs.readFileSync(path.join(root, operationsReviewPath), 'utf8');
const impactDigest = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, impactPath))).digest('hex')}`;
const predecessorDigest = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, predecessorPath))).digest('hex')}`;
const pdp1ExitDigest = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, pdp1ExitPath))).digest('hex')}`;
const p1EvidencePaths = [statusPath, semanticReviewPath];
const expectedTransitions = [
  ['.product-experience/decision-log.md', 'sha256:cdea20d6fa57cc4d7bbea866d911c03685eeb74e0bfdb4e0a5df0c90ded56db4', 'sha256:9831b03ecd3f30d2cbfd7a1db62d934035ba20cf1482bb5e621d166eacdb9b4c'],
  ['.product-experience/interface-parity/current-source-review.json', 'sha256:14cf6c3d9ea948e39e41ffa2de3453c08b7b6a23267f407f3504c5462b7428fc', 'sha256:0ce764d11912596ee39057db9bd0f2dfbf3c85f6269d55632bda3b3e6e4ad0dd'],
  ['.product-experience/pdp-1-domain-data/handoff-contracts.yaml', 'sha256:4e1553875033beb543aabdae013385057a3651a83a1db7949ce7c5704c2acf55', 'sha256:3605ff3a216e8187acad158666be6e0a13801ee947099a7e657e3e29c59e9338'],
  ['docs/implementation/pdp-1-phase-dev-status.json', 'sha256:ee7b68839a6fba3745f27183ce13ec45d9b90e32f0f5df376952f4bde40ae23b', 'sha256:73a491d5ab0ba0c5ad97bde97d2f3592c13bf9282bb8cae197d34b25bff23e18'],
  ['docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json', 'sha256:ab5ebe42f834ec604f4bd0cd525f0b779d58fdd73ff0851d731669ef132eb680', 'sha256:e0a67706f34270e8dd8a873a0193fc3ef50342acf417db2767d4b98f94217020'],
  ['scripts/report-media-pdp-readiness.mjs', 'sha256:f3482cf689e0be2d8dc9faf9ccc72a1b63a1dcaecd056efaa1759e6f3696a5e1', 'sha256:ca59f6c4e1313bd58387f91b41eb51fc1a10ac04b2db01faed30b9edcc9b2573'],
];
const sha = (sourcePath) => `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, sourcePath))).digest('hex')}`;
const r16ProjectionPath = '.product-experience/pdp-2-design-interface-system/generated/experience-language.candidate.json';

function historicalR25Digests(r13) {
  const digests = Object.fromEntries(Object.keys(r13.sourceCurrentness.sourceSetDigests.sourceContentDigests)
    .map((sourcePath) => [sourcePath, sha(sourcePath)]));
  // R25 predates the separately authorized R16-to-live generated projection hop.
  digests[r16ProjectionPath] = r13.sourceCurrentness.sourceSetDigests.sourceContentDigests[r16ProjectionPath];
  return digests;
}

function v2Fixture({ mutateRecord, mutateCurrent, mutateActual } = {}) {
  const recordPath = impactR3Path;
  const deltas = [
    '.product-experience/pdp-3-product-experience/action-registry.yaml',
    'libs/audio-video-client/src/operations.ts',
  ].map((sourcePath) => ({
    path: sourcePath,
    predecessorSha256: currentPredecessor.sourceCurrentness.sourceSetDigests.sourceContentDigests[sourcePath],
    observedSha256: sha(sourcePath),
    classification: 'PDP2_DELEGATED_SOURCE_IMPACT_NO_ADDITIONAL_MEANING',
    sourceSelector: `${sourcePath}#reviewed-source`,
    summary: 'Reviewed source delta; no PDP-2 meaning added.',
    meaningChange: 'NO_ADDITIONAL_PDP2_MEANING',
    meaningIdsChanged: [],
    requiresFreshCurrentness: true,
  }));
  const record = {
    schemaVersion: 'media.discovery-pdp2-additional-source-impact.v2',
    recordId: 'MEDIA-DISCOVERY-PDP2-ADDITIONAL-SOURCE-IMPACT-2026-10-14-R1',
    campaign: { repository: 'samujjwal/ghatana-media', stage: 'DISCOVERY', activePhase: 'PDP-2' },
    predecessorCut: { phase: 'PDP-2', receiptRef: currentPredecessorPath, receiptSha256: sha(currentPredecessorPath) },
    pdp1Predecessor: {
      phase: 'PDP-1', receiptRef: pdp1ExitR16Path, receiptSha256: sha(pdp1ExitR16Path), status: 'PASS',
      sourceCurrentness: 'PASS', sourceCurrent: true, cellCount: 50, developmentStatus: 'DEV_COMPLETE', outstandingMeaningIds: 0,
    },
    authority: {
      delegate: 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION',
      decisionRole: 'SCOPED_INTERNAL_MEDIA_PDP2_SOURCE_IMPACT_REVIEW',
      delegationEvidence: { sourceRef: '.product-experience/decision-log.md#PXD-163', sha256: sha('.product-experience/decision-log.md') },
      humanSignatureProvided: false, independentReviewerProvided: false, lifecycleReceiptProvided: false,
    },
    reviewedPdp2Grammar: {
      path: '.product-experience/pdp-2-design-interface-system/semantic-state-grammar.yaml',
      sha256: currentPredecessor.sourceCurrentness.sourceSetDigests.sourceContentDigests['.product-experience/pdp-2-design-interface-system/semantic-state-grammar.yaml'],
    },
    sourceDeltas: deltas,
    ownerAcceptance: 'NOT_CLAIMED', independentReview: 'NOT_CLAIMED', lifecycleClosure: 'NOT_ENTERED',
    runtimeAdmission: 'NOT_ADMITTED', delivery: 'NOT_AUTHORIZED', release: 'NOT_AUTHORIZED',
  };
  mutateRecord?.(record);
  const currentDigests = { ...currentPredecessor.sourceCurrentness.sourceSetDigests.sourceContentDigests };
  const actualCurrentDigests = {};
  for (const delta of record.sourceDeltas) {
    if (delta?.path && fs.existsSync(path.join(root, delta.path))) {
      currentDigests[delta.path] = sha(delta.path);
      actualCurrentDigests[delta.path] = sha(delta.path);
    }
  }
  currentDigests['.product-experience/decision-log.md'] = sha('.product-experience/decision-log.md');
  actualCurrentDigests['.product-experience/decision-log.md'] = sha('.product-experience/decision-log.md');
  const grammarPath = record.reviewedPdp2Grammar?.path;
  if (grammarPath) {
    currentDigests[grammarPath] = sha(grammarPath);
    actualCurrentDigests[grammarPath] = sha(grammarPath);
  }
  mutateCurrent?.(currentDigests);
  mutateActual?.(actualCurrentDigests);
  return {
    record, currentDigests, actualCurrentDigests,
    result: validatePdp2AdditionalSourceImpact({
      record, recordPath, predecessor: currentPredecessor, predecessorPath: currentPredecessorPath,
      predecessorDigest: sha(currentPredecessorPath),
      currentDigests, actualCurrentDigests,
    }),
  };
}

function r3Fixture({ mutateImpact, mutateCurrent, mutateActual, mutatePdp1Exit, overrideImpactDigest, overridePdp1ExitDigest } = {}) {
  const candidate = structuredClone(impactR3);
  mutateImpact?.(candidate);
  const candidatePdp1Exit = structuredClone(pdp1ExitR16);
  mutatePdp1Exit?.(candidatePdp1Exit);
  const currentDigests = { ...predecessor.sourceCurrentness.sourceSetDigests.sourceContentDigests };
  const actualCurrentDigests = {};
  for (const delta of candidate.sourceDeltas ?? []) {
    currentDigests[delta.path] = delta.observedSha256;
    actualCurrentDigests[delta.path] = delta.observedSha256;
  }
  for (const { path: sourcePath } of candidate.reviewedPdp2Sources ?? []) {
    currentDigests[sourcePath] = sha(sourcePath);
    actualCurrentDigests[sourcePath] = sha(sourcePath);
  }
  mutateCurrent?.(currentDigests);
  mutateActual?.(actualCurrentDigests);
  const result = validatePdp2CurrentCutImpact({
    impact: candidate,
    predecessor,
    currentDigests,
    actualCurrentDigests,
    predecessorDigest,
    impactDigest: overrideImpactDigest ?? sha(impactR3Path),
    predecessorPath,
    impactPath: impactR3Path,
    pdp1Exit: candidatePdp1Exit,
    pdp1ExitDigest: overridePdp1ExitDigest ?? sha(pdp1ExitR16Path),
    pdp1ExitPath: pdp1ExitR16Path,
  });
  return { result, currentDigests, actualCurrentDigests };
}

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
  for (const { path: sourcePath } of candidate.reviewedPdp2Sources ?? []) {
    currentDigests[sourcePath] = sha(sourcePath);
    actualCurrentDigests[sourcePath] = sha(sourcePath);
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
    predecessorPath,
    impactPath,
    pdp1Exit: candidateP1Exit,
    pdp1ExitDigest,
    pdp1ExitPath,
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

test('historical PDP-2 R2 preserves its exact six-path impact and predecessor pins', () => {
  assert.deepEqual(impact.sourceDeltas.map(({ path: sourcePath, predecessorSha256, observedSha256 }) => [sourcePath, predecessorSha256, observedSha256]), expectedTransitions);
  assert.equal(impact.supersedes?.ref, 'docs/implementation/observations/media-discovery-pdp2-current-cut-source-impact-2026-10-14-r1.json');
  assert.equal(impact.pdp1Predecessor?.receiptRef, pdp1ExitPath);
  assert.equal(impact.pdp1Predecessor?.status, 'PASS');
  assert.equal(impact.pdp1Predecessor?.sourceCurrentness, 'PASS');
  assert.equal(impact.pdp1Predecessor?.developmentStatus, 'DEV_COMPLETE');
  assert.equal(impact.pdp1Predecessor?.materialPathCount, 329);
  assert.equal(impact.pdp1Predecessor?.cellCount, 50);
  assert.equal(impact.pdp1Predecessor?.outstandingMeaningIds, 0);
  assert.equal(impact.authority?.authorizationEvidence?.[1]?.authorizedTransitions?.length, 5);
  assert.deepEqual(impact.authority.authorizationEvidence[1].authorizedTransitions.map(({ path: sourcePath, predecessorSha256, observedSha256 }) => [sourcePath, predecessorSha256, observedSha256]), expectedTransitions.slice(0, 5));
  assert.equal(impact.scopeLimits?.onlyTheseSixExactR4ToCurrentPathTransitionsAreAuthorized, true);
  assert.equal(impact.sourceDeltas.length, 6);
  // This fixture asserts the immutable R2 transition record. Its observed hashes are historical and are not live R4 inputs.
  assert.match(decisionLogText, /### PXD-163\b/u);
  assert.match(interfaceReviewText, /The exact source inventory contains 15\/15 current owner typed observation contracts and 15 validation rules/u);
  assert.match(handoffContractsText, /ownerDefinedOperations:\s*\n\s*count:\s*107\b/u);
  assert.match(reporterText, /pdp-1/u);
});

test('PDP-2 R3 immutably supersedes R2, preserves its six exact transitions and binds PDP-1 R16', () => {
  const { result } = r3Fixture();
  assert.equal(impactR3.recordId, 'MEDIA-DISCOVERY-PDP2-CURRENT-CUT-SOURCE-IMPACT-2026-10-14-R3');
  assert.equal(impactR3.supersedes.ref, impactPath);
  assert.equal(impactR3.supersedes.recordId, impact.recordId);
  assert.equal(impactR3.supersedes.sha256, sha(impactPath));
  assert.deepEqual(impactR3.sourceDeltas, impact.sourceDeltas);
  assert.deepEqual(impactR3.authority.authorizationEvidence, impact.authority.authorizationEvidence);
  assert.equal(impactR3.pdp1Predecessor.receiptRef, pdp1ExitR16Path);
  assert.equal(impactR3.pdp1Predecessor.receiptSha256, sha(pdp1ExitR16Path));
  assert.equal(impactR3.scopeLimits.onlyTheseSixExactR4ToCurrentPathTransitionsAreAuthorized, true);
  assert.equal(impactR3.scopeLimits.noOtherPathAuthorizedByThisRecord, true);
  assert.equal(impactR3.decision.pdp2MeaningDisposition, impact.decision.pdp2MeaningDisposition);
  assert.equal(impactR3.sourceDeltas.length, 6);
  assert.equal(result.valid, true);
  assert.equal(result.changedPathCount, 6);
  assert.equal(result.transitionCount, 6);
  assert.equal(result.meaningChangeCount, 0);
  assert.equal(result.supersedesR2Valid, true);
  assert.equal(result.inheritedAuthorizationValid, true);
  assert.equal(result.pdp1PredecessorValid, true);
  assert.equal(result.pdp2MeaningScopeValid, true);
  assert.equal(result.independentOrExternalOrLifecycleClaims, false);
});

test('PDP-2 R3 rejects altered supersession, PDP-1 R16 digest, transition set, or no-meaning scope', () => {
  assert.equal(r3Fixture({ mutateImpact: (value) => { value.supersedes.sha256 = `sha256:${'0'.repeat(64)}`; } }).result.valid, false);
  assert.equal(r3Fixture({ overridePdp1ExitDigest: `sha256:${'1'.repeat(64)}` }).result.valid, false);
  assert.equal(r3Fixture({ mutateImpact: (value) => { value.sourceDeltas[0].observedSha256 = `sha256:${'2'.repeat(64)}`; } }).result.valid, false);
  assert.equal(r3Fixture({ mutateImpact: (value) => { value.sourceDeltas.push({ ...value.sourceDeltas[5], path: 'unapproved/path.yaml' }); } }).result.valid, false);
  assert.equal(r3Fixture({ mutateImpact: (value) => { value.sourceDeltas.pop(); } }).result.valid, false);
  assert.equal(r3Fixture({ mutateImpact: (value) => { value.sourceDeltas[0].meaningChange = 'PDP2_MEANING_CHANGED'; } }).result.valid, false);
  assert.equal(r3Fixture({ mutateImpact: (value) => { value.scopeLimits.noOtherPathAuthorizedByThisRecord = false; } }).result.valid, false);
  assert.equal(r3Fixture({ mutateImpact: (value) => { value.decision.pdp2MeaningDisposition = 'PDP2_MEANING_CHANGED'; } }).result.valid, false);
  assert.equal(r3Fixture({ mutateImpact: (value) => { value.pdp1Predecessor.receiptRef = pdp1ExitPath; } }).result.valid, false);
  assert.equal(r3Fixture({ mutatePdp1Exit: (value) => { value.sourceCurrentness.sourceCurrent = false; } }).result.valid, false);
  assert.equal(r3Fixture({ overrideImpactDigest: `sha256:${'3'.repeat(64)}` }).result.valid, false);
  assert.equal(r3Fixture({ mutateCurrent: (digests) => { digests['extra/unpinned.txt'] = `sha256:${'4'.repeat(64)}`; } }).result.valid, false);
  assert.equal(r3Fixture({ mutateActual: (digests) => { delete digests['scripts/report-media-pdp-readiness.mjs']; } }).result.valid, false);
});

test('PDP-2 additional source-impact v2 validates finite delegated delta lists and projects every exact path', () => {
  const { result } = v2Fixture();
  assert.equal(result.valid, true);
  assert.equal(result.paths.length, 2);
  assert.equal(result.transitions.length, 2);
  assert.equal(new Set(result.paths).size, result.paths.length);
});

test('PDP-2 additional source-impact v2 fails closed on predecessor/current hashes, path set, meaning, authority, grammar, and downstream claims', () => {
  assert.equal(v2Fixture({ mutateRecord: (record) => { record.predecessorCut.receiptSha256 = `sha256:${'0'.repeat(64)}`; } }).result.valid, false);
  assert.equal(v2Fixture({ mutateRecord: (record) => { record.predecessorCut.receiptRef = impactPath; } }).result.valid, false);
  assert.equal(v2Fixture({ mutateRecord: (record) => { record.pdp1Predecessor.receiptRef = pdp1ExitPath; } }).result.valid, false);
  assert.equal(v2Fixture({ mutateRecord: (record) => { record.pdp1Predecessor.receiptSha256 = `sha256:${'6'.repeat(64)}`; } }).result.valid, false);
  assert.equal(v2Fixture({ mutateRecord: (record) => { record.sourceDeltas[0].predecessorSha256 = `sha256:${'0'.repeat(64)}`; } }).result.valid, false);
  assert.equal(v2Fixture({ mutateRecord: (record) => { record.sourceDeltas[0].observedSha256 = `sha256:${'1'.repeat(64)}`; } }).result.valid, false);
  assert.equal(v2Fixture({ mutateCurrent: (digests) => { digests['.product-experience/pdp-3-product-experience/action-registry.yaml'] = `sha256:${'2'.repeat(64)}`; } }).result.valid, false);
  assert.equal(v2Fixture({ mutateActual: (digests) => { digests['.product-experience/pdp-3-product-experience/action-registry.yaml'] = `sha256:${'3'.repeat(64)}`; } }).result.valid, false);
  assert.equal(v2Fixture({ mutateCurrent: (digests) => { delete digests['.product-experience/pdp-3-product-experience/action-registry.yaml']; } }).result.valid, false);
  assert.equal(v2Fixture({ mutateRecord: (record) => { record.sourceDeltas.push({ ...record.sourceDeltas[0] }); } }).result.valid, false);
  assert.equal(v2Fixture({ mutateRecord: (record) => { record.sourceDeltas[1].path = 'unapproved/extra.yaml'; } }).result.valid, false);
  assert.equal(v2Fixture({ mutateRecord: (record) => { record.sourceDeltas[0].meaningChange = 'PDP2_MEANING_CHANGED'; } }).result.valid, false);
  assert.equal(v2Fixture({ mutateRecord: (record) => { record.sourceDeltas[0].meaningIdsChanged = ['new.meaning']; } }).result.valid, false);
  assert.equal(v2Fixture({ mutateRecord: (record) => { record.authority.delegationEvidence.sourceRef = '.product-experience/decision-log.md#OTHER'; } }).result.valid, false);
  assert.equal(v2Fixture({ mutateRecord: (record) => { record.authority.delegationEvidence.sha256 = `sha256:${'4'.repeat(64)}`; } }).result.valid, false);
  assert.equal(v2Fixture({ mutateRecord: (record) => { record.reviewedPdp2Grammar.sha256 = `sha256:${'5'.repeat(64)}`; } }).result.valid, false);
  assert.equal(v2Fixture({ mutateRecord: (record) => { record.release = 'RELEASE_READY'; } }).result.valid, false);
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

test('PDP-2 scoped impact rejects a seventh changed path, a missing pin, or bytes that differ from the record', () => {
  assert.equal(fixture({ mutateImpact: (value) => { value.sourceDeltas.push({ ...value.sourceDeltas[5], path: 'unapproved/path.yaml' }); } }).p2Impact.valid, false);
  assert.equal(fixture({ mutateCurrent: (digests) => { digests['.product-experience/pdp-2-design-interface-system/DESIGN-LANGUAGE.md'] = `sha256:${'1'.repeat(64)}`; } }).combined.valid, false);
  assert.equal(fixture({ mutateCurrent: (digests) => { delete digests['.product-experience/interface-parity/current-source-review.json']; } }).p2Impact.valid, false);
  assert.equal(fixture({ mutateCurrent: (digests) => { delete digests['.product-experience/decision-log.md']; } }).p2Impact.valid, false);
  assert.equal(fixture({ mutateCurrent: (digests) => { digests['extra/unpinned.txt'] = `sha256:${'2'.repeat(64)}`; } }).combined.valid, false);
  assert.equal(fixture({ mutateActual: (digests) => { digests['scripts/report-media-pdp-readiness.mjs'] = `sha256:${'3'.repeat(64)}`; } }).p2Impact.valid, false);
  assert.equal(fixture({ mutateActual: (digests) => { delete digests['.product-experience/pdp-1-domain-data/handoff-contracts.yaml']; } }).p2Impact.valid, false);
  assert.equal(fixture({ mutateImpact: (value) => { value.authority.authorizationEvidence[1].authorizedTransitions[0].observedSha256 = `sha256:${'5'.repeat(64)}`; } }).p2Impact.valid, false);
  assert.equal(fixture({ mutateImpact: (value) => { value.scopeLimits.onlyTheseSixExactR4ToCurrentPathTransitionsAreAuthorized = false; } }).p2Impact.valid, false);
  assert.equal(fixture({ mutateImpact: (value) => { value.sourceDeltas[2].predecessorSha256 = `sha256:${'6'.repeat(64)}`; } }).p2Impact.valid, false);
  assert.equal(fixture({ mutateImpact: (value) => { value.sourceDeltas[4].observedSha256 = `sha256:${'7'.repeat(64)}`; } }).p2Impact.valid, false);
  assert.equal(fixture({ mutateP1Exit: (value) => { value.authority.historicalPinReview.historicalStatusChangedPinCount = 1; } }).p1EvidenceRefresh.valid, false);
  assert.equal(fixture({ mutateP1Exit: (value) => { value.ownerStatusJoin.testEvidence.skippedCount = 1; } }).p1EvidenceRefresh.valid, false);
  assert.equal(fixture({ mutateP1Exit: (value) => { value.phaseExit.status = 'FAIL'; } }).p1EvidenceRefresh.valid, false);
  assert.equal(fixture({ mutateP1Exit: (value) => { value.ownerStatusJoin.testEvidence.testCount = 82; } }).p1EvidenceRefresh.valid, false);
  assert.equal(fixture({ mutateP1Exit: (value) => { value.sourceCurrentness.materialPathDenominator.uniquePaths = 328; } }).p1EvidenceRefresh.valid, false);
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
  assert.equal(fixture({ mutateStatus: (value) => { value.testsActuallyRun['P1-01'].testCount = 1; } }).p1EvidenceRefresh.valid, false);
  assert.equal(fixture({ mutateSemanticReview: (value) => { value.sourceCutStable = false; } }).p1EvidenceRefresh.valid, false);
  assert.equal(fixture({ mutateSemanticReview: (value) => { value.currentCutReview.verificationStatus = 'old R13 marker'; } }).p1EvidenceRefresh.valid, false);
  assert.equal(fixture({ mutateSemanticReview: (value) => { value.sourceFingerprints[operationsSourcePath] = 'wrong-hash'; } }).p1EvidenceRefresh.valid, false);
  assert.equal(fixture({ mutateSemanticReview: (value) => { value.sourceFingerprints[operationsReviewPath] = 'wrong-hash'; } }).p1EvidenceRefresh.valid, false);
  assert.equal(fixture({ mutateSemanticReview: (value) => { value.reviewedIdentityIds[0] = 'wrong-identity'; } }).p1EvidenceRefresh.valid, false);
  assert.equal(fixture({ mutateSemanticReview: (value) => { value.supplementaryReviews.find((review) => review.id === 'P1-current-owner-typed-observation-definition-delta-2026-10-14').sourceSha256 = 'wrong-hash'; } }).p1EvidenceRefresh.valid, false);
  assert.equal(fixture({ mutateOperationsReview: (value) => { value.currentSourceCutDeltaReview.supplementalPdp1DefinitionDelta.reviewedRecords[0].meaning = ''; } }).p1EvidenceRefresh.valid, false);
  assert.equal(fixture({ mutateOperationsReview: (value) => { value.currentSourceCutDeltaReview.supplementalPdp1DefinitionDelta.reviewedRecords[0].id = 'wrong.id'; } }).p1EvidenceRefresh.valid, false);
  assert.equal(fixture({ mutateSemanticReview: (value) => { value.currentCutReview.parityTestPinDispositionReview.verificationStatus = 'PASS'; } }).p1EvidenceRefresh.valid, false);
  assert.equal(fixture({ mutateSemanticReview: (value) => { value.currentCutReview.definitionContractRefresh.verificationEvidence.fullPhaseGate.testCount = 343; } }).p1EvidenceRefresh.valid, false);
});

test('the live R4 comparison blocks newly changed PDP-2 and PDP-1 pins beyond its six-path R2 record', () => {
  const currentDigests = { ...predecessor.sourceCurrentness.sourceSetDigests.sourceContentDigests };
  for (const sourcePath of Object.keys(currentDigests)) {
    currentDigests[sourcePath] = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, sourcePath))).digest('hex')}`;
  }
  const actualCurrentPaths = [
    ...impact.sourceDeltas.map(({ path: sourcePath }) => sourcePath),
    ...impact.reviewedPdp2Sources.map(({ path: sourcePath }) => sourcePath),
    ...p1EvidencePaths,
  ];
  const actualCurrentDigests = Object.fromEntries(actualCurrentPaths.map((sourcePath) => [sourcePath, currentDigests[sourcePath]]));
  const p2Impact = validatePdp2CurrentCutImpact({ impact, predecessor, currentDigests, actualCurrentDigests, predecessorDigest, impactDigest, predecessorPath, impactPath, pdp1Exit, pdp1ExitDigest, pdp1ExitPath });
  const p1EvidenceRefresh = validatePdp1EvidenceRefresh({ predecessor, currentDigests, actualCurrentDigests, pdp1Exit, pdp1ExitDigest, statusSource, semanticReviewSource, operationsSourceText, operationsReviewText, operationsReviewSource: read(operationsReviewPath) });
  const result = validatePdp2CombinedSourceRefresh({ predecessor, currentDigests, p2Impact, p1EvidenceRefresh });
  assert.equal(p2Impact.valid, false);
  assert.equal(p2Impact.changedPaths.includes('.product-experience/pdp-3-product-experience/action-registry.yaml'), true);
  assert.equal(p1EvidenceRefresh.valid, false);
  assert.equal(p1EvidenceRefresh.pdp1Proof.p1DefinitionSourceHashesMatch, false);
  assert.equal(result.valid, false);
  assert.equal(result.changedPathCount > 6, true);
  assert.deepEqual(result.pdp2MeaningDispositionAppliedOnlyTo, impact.sourceDeltas.map(({ path: sourcePath }) => sourcePath));
});

test('the combined R5 join rejects an unpinned material path after exact current predecessor evidence', () => {
  const r9Path = 'docs/implementation/observations/media-discovery-pdp2-exit-current-cut-r9.json';
  const r5ImpactPath = 'docs/implementation/observations/media-discovery-pdp2-current-cut-source-impact-2026-10-14-r5.json';
  const r22Path = 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r22.json';
  const r9 = read(r9Path);
  const r5Impact = read(r5ImpactPath);
  const r22 = read(r22Path);
  const r13 = read('docs/implementation/observations/media-discovery-pdp2-exit-2026-10-14-current-cut-r13.json');
  const currentDigests = { ...r13.sourceCurrentness.sourceSetDigests.sourceContentDigests };
  const actualCurrentDigests = { ...currentDigests };
  const p2Impact = validatePdp2CurrentCutImpact({ impact: r5Impact, predecessor: r9, currentDigests, actualCurrentDigests,
    predecessorDigest: sha(r9Path), impactDigest: sha(r5ImpactPath), predecessorPath: r9Path, impactPath: r5ImpactPath,
    pdp1Exit: r22, pdp1ExitDigest: sha(r22Path), pdp1ExitPath: r22Path });
  const p1EvidenceRefresh = validatePdp1EvidenceRefresh({ predecessor: r9, currentDigests, actualCurrentDigests,
    pdp1Exit: r22, pdp1ExitDigest: sha(r22Path), pdp1ExitPath: r22Path,
    statusSource: read(statusPath), semanticReviewSource: read(semanticReviewPath) });
  const extra = { ...currentDigests, 'tests/not-in-pdp2-cut.test.mjs': `sha256:${'4'.repeat(64)}` };
  const result = validatePdp2CombinedSourceRefresh({ predecessor: r9, currentDigests: extra, p2Impact, p1EvidenceRefresh });
  assert.equal(p2Impact.valid, true);
  assert.equal(p1EvidenceRefresh.valid, true);
  assert.equal(result.valid, false);
  assert.equal(result.additionalPaths.length, 1);
});

test('the historical R2 ownerStatusJoin stays blocked and identifies the superseded R5 and R22 comparison', () => {
  const historicalR2 = read('docs/implementation/observations/media-discovery-pdp2-exit-2026-10-13-r2.json');
  const ownerDirections = read('docs/implementation/observations/media-discovery-current-cut-owner-directions-2026-10-13-r2.json');
  const ownerReview = ownerDirections.predecessorImpactReviews.find((review) => review.phase === 'PDP-2');
  const r13 = read('docs/implementation/observations/media-discovery-pdp2-exit-2026-10-14-current-cut-r13.json');
  const currentDigests = { ...r13.sourceCurrentness.sourceSetDigests.sourceContentDigests };
  const result = ownerStatusJoin(historicalR2, currentDigests, ownerReview, 'sha256:current-test-material-fingerprint');
  assert.equal(result.status, 'FAIL');
  assert.equal(result.predecessorEvidenceRefresh, undefined);
  assert.equal(result.pdp2ScopedImpact.valid, false);
  assert.equal(result.unapprovedChangedPathCount > 0, true);
  assert.equal(result.additionalPathCount, 0);
  assert.equal(result.missingPathCount, 0);
  assert.equal(result.pdp2ScopedImpact.blocker, 'PDP2_R27_REQUIRES_EXACT_R13_TO_R25_R1_IMPACT_RECORD');
});

test('the R5 R9-to-R22 join keeps authorized transitions separate from source-derived enum work', () => {
  const r9Path = 'docs/implementation/observations/media-discovery-pdp2-exit-current-cut-r9.json';
  const r5ImpactPath = 'docs/implementation/observations/media-discovery-pdp2-current-cut-source-impact-2026-10-14-r5.json';
  const r22Path = 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r22.json';
  const r9 = read(r9Path);
  const r5Impact = read(r5ImpactPath);
  const r22 = read(r22Path);
  const r13 = read('docs/implementation/observations/media-discovery-pdp2-exit-2026-10-14-current-cut-r13.json');
  const currentDigests = { ...r13.sourceCurrentness.sourceSetDigests.sourceContentDigests };
  const actualCurrentDigests = { ...currentDigests };
  const p2Impact = validatePdp2CurrentCutImpact({
    impact: r5Impact,
    predecessor: r9,
    currentDigests,
    actualCurrentDigests,
    predecessorDigest: sha(r9Path),
    impactDigest: sha(r5ImpactPath),
    predecessorPath: r9Path,
    impactPath: r5ImpactPath,
    pdp1Exit: r22,
    pdp1ExitDigest: sha(r22Path),
    pdp1ExitPath: r22Path,
  });
  const p1EvidenceRefresh = validatePdp1EvidenceRefresh({
    predecessor: r9,
    currentDigests,
    actualCurrentDigests,
    pdp1Exit: r22,
    pdp1ExitDigest: sha(r22Path),
    pdp1ExitPath: r22Path,
    statusSource: read(statusPath),
    semanticReviewSource: read(semanticReviewPath),
  });
  const combined = validatePdp2CombinedSourceRefresh({ predecessor: r9, currentDigests, p2Impact, p1EvidenceRefresh });

  assert.equal(p2Impact.valid, true);
  assert.equal(p2Impact.transitionCount, 11);
  assert.equal(p2Impact.supplementalSourceWork.length, 2);
  assert.equal(p2Impact.authorityValid, true);
  assert.equal(p2Impact.supplementalSourceWorkValid, true);
  assert.equal(r5Impact.scopeLimits.onlyTheseSixInheritedR4TransitionsAuthorized, true);
  assert.equal(r5Impact.supplementalSourceWork.some((work) => r5Impact.authority.authorizationEvidence[0].authorizedPaths.includes(work.path)), false);
  assert.equal(p1EvidenceRefresh.valid, true);
  assert.equal(combined.valid, true);
  assert.deepEqual(combined.changedPaths, [...new Set([...r5Impact.sourceDeltas, ...r5Impact.supplementalSourceWork].map(({ path: sourcePath }) => sourcePath))].sort());

  const invalidWork = structuredClone(r5Impact);
  invalidWork.supplementalSourceWork[0].disposition = 'NO_ADDITIONAL_PDP2_MEANING';
  const rejected = validatePdp2CurrentCutImpact({
    impact: invalidWork,
    predecessor: r9,
    currentDigests,
    actualCurrentDigests,
    predecessorDigest: sha(r9Path),
    impactDigest: sha(r5ImpactPath),
    predecessorPath: r9Path,
    impactPath: r5ImpactPath,
    pdp1Exit: r22,
    pdp1ExitDigest: sha(r22Path),
    pdp1ExitPath: r22Path,
  });
  assert.equal(rejected.valid, false);
});

function v3R25Fixture({ mutateRecord, mutatePredecessor, mutateCurrent, mutateActual } = {}) {
  const r13Path = 'docs/implementation/observations/media-discovery-pdp2-exit-2026-10-14-current-cut-r13.json';
  const r25Path = 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r25.json';
  const r13 = structuredClone(read(r13Path));
  const r25 = read(r25Path);
  const transitions = [
    ['.product-experience/decision-log.md', 'sha256:9831b03ecd3f30d2cbfd7a1db62d934035ba20cf1482bb5e621d166eacdb9b4c', 'sha256:97ad3104abec9ba6670804394c68a11c663f37171e90ea2a1f2e629aa5619bbc', 'PDP1_PXD164_SEMANTIC_REPAIR_NO_ADDITIONAL_PDP2_MEANING', '.product-experience/decision-log.md#PXD-164'],
    ['.product-experience/interface-parity/current-source-review.json', 'sha256:866729bdb41448d7e1d08ca288e5e71300f999d26e85cd53d2e5377ecdf299bd', 'sha256:64796cfb0db909a36e030041b2d51d02fd19fc115d703cc16bca37116f92ed06', 'PDP1_INTERFACE_SOURCE_REVIEW_REFRESH', '.product-experience/interface-parity/current-source-review.json'],
    [semanticReviewPath, 'sha256:e9350fb4424fceeca2f13b93f756231e5b648904bb002de11d3d9659a0b994b6', 'sha256:15ec0101ba8d7c178bed46b116284b0de1150ac38caacedd65904225ab4b51c9', 'PDP1_SEMANTIC_REVIEW_EVIDENCE_REFRESH', semanticReviewPath],
  ].map(([sourcePath, predecessorSha256, observedSha256, classification, sourceSelector]) => ({
    path: sourcePath, predecessorSha256, observedSha256, classification, sourceSelector, phase: 'PDP-2',
    meaningChange: 'NO_ADDITIONAL_PDP2_MEANING', meaningIdsChanged: [], requiresFreshCurrentness: true,
  }));
  const record = {
    schemaVersion: 'media.discovery-pdp2-additional-source-impact.v3',
    recordId: 'MEDIA-DISCOVERY-PDP2-ADDITIONAL-SOURCE-IMPACT-2026-10-14-R1',
    campaign: { repository: 'samujjwal/ghatana-media', stage: 'DISCOVERY', activePhase: 'PDP-2' },
    predecessorCut: { phase: 'PDP-2', receiptRef: r13Path, receiptSha256: sha(r13Path) },
    pdp1Predecessor: {
      phase: 'PDP-1', receiptRef: r25Path, receiptSha256: sha(r25Path),
      sourceFingerprint: r25.sourceCurrentness.materialSourceSetFingerprint, status: 'PASS',
      sourceCurrentness: 'PASS', sourceCurrent: true, cellCount: 50,
      developmentStatus: 'DEV_COMPLETE', outstandingMeaningIds: 0,
    },
    authority: {
      delegate: 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION',
      decisionRole: 'SCOPED_INTERNAL_MEDIA_PDP2_SOURCE_IMPACT_REVIEW',
      userAuthorization: {
        status: 'AUTHORIZED', authorizedBy: 'USER',
        exactResponse: 'Authorize these three exact transitions (Recommended)',
        additionalScopedAuthorizationResponse: 'Authorize this scoped PDP-2 impact disposition (Recommended)',
        exactResponses: [
          'Authorize these three exact transitions (Recommended)',
          'Authorize this scoped PDP-2 impact disposition (Recommended)',
        ],
        authorizedTransitions: transitions.map(({ path: sourcePath, predecessorSha256, observedSha256 }) => ({ path: sourcePath, predecessorSha256, observedSha256 })),
      },
      humanSignatureProvided: false, independentReviewerProvided: false, lifecycleReceiptProvided: false,
    },
    sourceDeltas: transitions,
    ownerAcceptance: 'NOT_CLAIMED', independentReview: 'NOT_CLAIMED', lifecycleClosure: 'NOT_ENTERED',
    runtimeAdmission: 'NOT_ADMITTED', delivery: 'NOT_AUTHORIZED', release: 'NOT_AUTHORIZED',
  };
  mutateRecord?.(record);
  mutatePredecessor?.(r13);
  const currentDigests = { ...r13.sourceCurrentness.sourceSetDigests.sourceContentDigests };
  const actualCurrentDigests = { ...currentDigests };
  for (const transition of transitions) {
    currentDigests[transition.path] = transition.observedSha256;
    actualCurrentDigests[transition.path] = transition.observedSha256;
  }
  mutateCurrent?.(currentDigests);
  mutateActual?.(actualCurrentDigests);
  const recordPath = 'docs/implementation/observations/media-discovery-pdp2-current-cut-source-impact-2026-10-14-r5.json';
  const result = validatePdp2AdditionalSourceImpact({
    record, recordPath, predecessor: r13, predecessorPath: r13Path, predecessorDigest: sha(r13Path), currentDigests, actualCurrentDigests,
  });
  return { record, r13, r13Path, r25, r25Path, currentDigests, actualCurrentDigests, result };
}

function fullR25CurrentnessFixture() {
  const r9Path = 'docs/implementation/observations/media-discovery-pdp2-exit-current-cut-r9.json';
  const r13Path = 'docs/implementation/observations/media-discovery-pdp2-exit-2026-10-14-current-cut-r13.json';
  const r5Path = 'docs/implementation/observations/media-discovery-pdp2-current-cut-source-impact-2026-10-14-r5.json';
  const r22Path = 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r22.json';
  const r9 = read(r9Path);
  const r13 = read(r13Path);
  const r5Record = read(r5Path);
  const r22 = read(r22Path);
  const currentDigests = historicalR25Digests(r13);
  return { r9Path, r13Path, r5Path, r22Path, r9, r13, r5Record, r22, currentDigests, impact: pdp2CurrentCutImpact(r9, currentDigests, {
    pdp1ExitPath: 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r25.json',
    additionalSourceImpactPath: 'docs/implementation/observations/media-discovery-pdp2-additional-source-impact-2026-10-14-r1.json',
  }) };
}

test('PDP-2 supplemental v3 joins exact R13-to-live transitions to the current PDP-1 R25 receipt', () => {
  const fixture = v3R25Fixture();
  assert.equal(fixture.result.valid, true);
  assert.equal(fixture.result.paths.length, 3);
  assert.equal(fixture.result.ownerAcceptance, 'NOT_CLAIMED');
  const p1Current = validatePdp1EvidenceRefresh({
    predecessor: fixture.r13, currentDigests: fixture.currentDigests, actualCurrentDigests: fixture.actualCurrentDigests,
    pdp1Exit: fixture.r25, pdp1ExitDigest: sha(fixture.r25Path), pdp1ExitPath: fixture.r25Path,
  });
  assert.equal(p1Current.valid, true);
  assert.equal(p1Current.pdp1Proof.developmentStatus, 'DEV_COMPLETE');
});

test('PDP-2 R25 currentness composes immutable R9→R13 R5 hops, exact R13→live R1 hops, and source work once per path', () => {
  const r9Path = 'docs/implementation/observations/media-discovery-pdp2-exit-current-cut-r9.json';
  const r13Path = 'docs/implementation/observations/media-discovery-pdp2-exit-2026-10-14-current-cut-r13.json';
  const r9 = read(r9Path);
  const r13 = read(r13Path);
  const currentDigests = historicalR25Digests(r13);
  const impact = pdp2CurrentCutImpact(r9, currentDigests, {
    pdp1ExitPath: 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r25.json',
    additionalSourceImpactPath: 'docs/implementation/observations/media-discovery-pdp2-additional-source-impact-2026-10-14-r1.json',
  });
  const chains = impact.currentnessSourceChains;
  assert.equal(impact.valid, true);
  assert.equal(impact.supplementalSourceWorkValid, true);
  assert.equal(impact.supplementalSourceWork.length, 2);
  assert.equal(chains.valid, true);
  assert.equal(chains.materialPathCount, 405);
  assert.equal(chains.changedPathCount, 11);
  assert.equal(chains.uniqueTransitionPathCount, 11);
  assert.deepEqual(chains.unaccountedChangedPaths, []);
  assert.deepEqual(chains.staleAuthorizationPaths, []);
  const byPath = new Map(chains.chains.map((chain) => [chain.path, chain]));
  assert.equal(byPath.get(interfaceReviewPath).r5HopCount, 2);
  assert.equal(byPath.get(interfaceReviewPath).r1HopCount, 1);
  assert.equal(byPath.get(semanticReviewPath).r5HopCount, 2);
  assert.equal(byPath.get(semanticReviewPath).r1HopCount, 1);
  assert.equal(byPath.get(statusPath).r5HopCount, 2);
  assert.equal(byPath.get(statusPath).r1HopCount, 0);
  assert.equal(byPath.get(decisionLogPath).r5HopCount, 0);
  assert.equal(byPath.get(decisionLogPath).r1HopCount, 1);
  const sourceWorkPaths = impact.supplementalSourceWork.map(({ path: sourcePath }) => sourcePath);
  assert.equal(new Set([...byPath.keys()]).size, 11);
  assert(sourceWorkPaths.every((sourcePath) => byPath.get(sourcePath).r5HopCount === 1));
  const projectedSourceWork = sourcePinReview(
    { sourceShaSet: Object.fromEntries(impact.supplementalSourceWork.map((work) => [work.path, work.predecessorSha256])) },
    currentDigests, { pinReview: { changedPins: [] } }, [], { valid: false }, impact,
  );
  assert.equal(projectedSourceWork.changedPinCount, 2);
  assert.equal(projectedSourceWork.expectedChangedPaths.filter((sourcePath) => sourceWorkPaths.includes(sourcePath)).length, 2);
  assert.equal(projectedSourceWork.changedPins[0].disposition?.sourceDerivedFrom, '.product-experience/pdp-2-design-interface-system/component-contracts.yaml');
  assert.equal(projectedSourceWork.changedPins[1].disposition?.workKind, 'REGRESSION_TEST_FOR_CANONICAL_ACTION_IDENTITY_PROJECTION');
  assert.deepEqual(projectedSourceWork.unclassifiedChangedPins, []);

  const guard = pdp3StatusGuardSupplement(read('docs/implementation/observations/media-discovery-pdp2-exit-2026-10-14-current-cut-r2.json'), currentDigests);
  assert.equal(guard.valid, true);
  assert.equal(guard.r9IntermediateSha256, 'sha256:ca59f6c4e1313bd58387f91b41eb51fc1a10ac04b2db01faed30b9edcc9b2573');
  assert.equal(guard.r13PredecessorSha256, 'sha256:4f0400c142d2f3df39c4497839925dad80f1ac90584573b390af386e491faa0f');
  const badReporterTerminal = { ...currentDigests, [reporterPath]: 'sha256:ca59f6c4e1313bd58387f91b41eb51fc1a10ac04b2db01faed30b9edcc9b2573' };
  assert.equal(pdp3StatusGuardSupplement(read('docs/implementation/observations/media-discovery-pdp2-exit-2026-10-14-current-cut-r2.json'), badReporterTerminal).valid, false);

  const join = currentnessOwnerStatusJoin(r13, currentDigests, { sourceChanges: [] }, 'sha256:test', {
    r9Checkpoint: r9,
    pdp2CurrentCutOptions: {
      pdp1ExitPath: 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r25.json',
      additionalSourceImpactPath: 'docs/implementation/observations/media-discovery-pdp2-additional-source-impact-2026-10-14-r1.json',
    },
  });
  assert.equal(join.status, 'PASS');
  assert.equal(join.composedR9ToR13ToLiveSourceChains.valid, true);
  assert.equal(join.changedPathCount, 11);
});

test('PDP-2 R25 currentness chain rejects reordered, forked, broken, and source-work-mutated hops', () => {
  const fixture = fullR25CurrentnessFixture();
  const compose = (r5 = fixture.impact.historicalR5Impact, current = fixture.currentDigests, r9 = fixture.r9, r13 = fixture.r13,
    r9ReceiptPath = fixture.r9Path, r9ReceiptDigest = sha(fixture.r9Path),
    r13ReceiptPath = fixture.r13Path, r13ReceiptDigest = sha(fixture.r13Path)) => composePdp2CurrentnessSourceChains({
    r9Checkpoint: r9, r9ReceiptPath, r9ReceiptDigest, r13Checkpoint: r13, r13ReceiptPath, r13ReceiptDigest,
    historicalR5Impact: r5, additionalSourceImpact: fixture.impact.additionalSourceImpact, currentDigests: current,
  });
  const interfaceR5 = fixture.impact.historicalR5Impact.scopedTransitions.filter(({ path: sourcePath }) => sourcePath === interfaceReviewPath);
  assert.equal(interfaceR5.length, 2);

  const reordered = structuredClone(fixture.impact.historicalR5Impact);
  const indexes = reordered.scopedTransitions.map((hop, index) => hop.path === interfaceReviewPath ? index : -1).filter((index) => index >= 0);
  [reordered.scopedTransitions[indexes[0]], reordered.scopedTransitions[indexes[1]]] = [reordered.scopedTransitions[indexes[1]], reordered.scopedTransitions[indexes[0]]];
  assert.equal(compose(reordered).valid, false);

  const broken = structuredClone(fixture.impact.historicalR5Impact);
  broken.scopedTransitions.find((hop) => hop.path === interfaceReviewPath && hop.predecessorSha256 !== fixture.r9.sourceCurrentness.sourceSetDigests.sourceContentDigests[interfaceReviewPath]).predecessorSha256 = `sha256:${'a'.repeat(64)}`;
  assert.equal(compose(broken).valid, false);

  const forked = structuredClone(fixture.impact.historicalR5Impact);
  forked.scopedTransitions.find((hop) => hop.path === interfaceReviewPath).observedSha256 = `sha256:${'b'.repeat(64)}`;
  assert.equal(compose(forked).valid, false);

  const badWork = structuredClone(fixture.r5Record);
  badWork.supplementalSourceWork[0].observedSha256 = `sha256:${'c'.repeat(64)}`;
  const badWorkValidation = validatePdp2CurrentCutImpact({
    impact: badWork, predecessor: fixture.r9, currentDigests: fixture.r13.sourceCurrentness.sourceSetDigests.sourceContentDigests,
    actualCurrentDigests: fixture.r13.sourceCurrentness.sourceSetDigests.sourceContentDigests,
    predecessorDigest: sha(fixture.r9Path), impactDigest: sha(fixture.r5Path), predecessorPath: fixture.r9Path, impactPath: fixture.r5Path,
    pdp1Exit: fixture.r22, pdp1ExitDigest: sha(fixture.r22Path), pdp1ExitPath: fixture.r22Path,
  });
  assert.equal(badWorkValidation.supplementalSourceWorkValid, false);
  assert.equal(compose(badWorkValidation).valid, false);
  const badDerivation = structuredClone(fixture.r5Record);
  badDerivation.supplementalSourceWork[0].derivedFrom.sha256 = `sha256:${'9'.repeat(64)}`;
  const badDerivationValidation = validatePdp2CurrentCutImpact({
    impact: badDerivation, predecessor: fixture.r9, currentDigests: fixture.r13.sourceCurrentness.sourceSetDigests.sourceContentDigests,
    actualCurrentDigests: fixture.r13.sourceCurrentness.sourceSetDigests.sourceContentDigests,
    predecessorDigest: sha(fixture.r9Path), impactDigest: sha(fixture.r5Path), predecessorPath: fixture.r9Path, impactPath: fixture.r5Path,
    pdp1Exit: fixture.r22, pdp1ExitDigest: sha(fixture.r22Path), pdp1ExitPath: fixture.r22Path,
  });
  assert.equal(badDerivationValidation.supplementalSourceWorkValid, false);
  assert.equal(compose(badDerivationValidation).valid, false);

  assert.equal(compose(fixture.impact.historicalR5Impact, fixture.currentDigests, fixture.r9, fixture.r13,
    `${fixture.r9Path}.mutated`).r9ReceiptValid, false);
  assert.equal(compose(fixture.impact, fixture.currentDigests, fixture.r9, fixture.r13,
    fixture.r9Path, `sha256:${'d'.repeat(64)}`).r9ReceiptValid, false);
  assert.equal(compose(fixture.impact.historicalR5Impact, fixture.currentDigests, fixture.r9, fixture.r13,
    fixture.r9Path, sha(fixture.r9Path), `${fixture.r13Path}.mutated`).r13ReceiptValid, false);
  assert.equal(compose(fixture.impact, fixture.currentDigests, fixture.r9, fixture.r13,
    fixture.r9Path, sha(fixture.r9Path), fixture.r13Path, `sha256:${'e'.repeat(64)}`).r13ReceiptValid, false);
  const terminalMutation = { ...fixture.currentDigests, [semanticReviewPath]: `sha256:${'f'.repeat(64)}` };
  assert.equal(compose(fixture.impact, terminalMutation).valid, false);
});

test('PDP-2 R25 source pin review joins all 14 changes to exact R9/R5/R1 chain dispositions', () => {
  const fixture = fullR25CurrentnessFixture();
  const status = read('docs/implementation/pdp-2-phase-dev-status.json');
  const ownerDirections = read('docs/implementation/observations/media-discovery-current-cut-owner-directions-2026-10-13-r2.json');
  const ownerReview = pdp2OwnerReview(ownerDirections);
  const supplement = pdp3StatusGuardSupplement(read('docs/implementation/observations/media-discovery-pdp2-exit-2026-10-14-current-cut-r2.json'), fixture.currentDigests);
  const review = (impact) => sourcePinReview(status, fixture.currentDigests,
    read('docs/implementation/observations/media-discovery-pdp2-mdc20-design-drift-2026-10-13-r1.json'),
    ownerReview?.sourceChanges ?? [], supplement, impact);
  const result = review(fixture.impact);
  assert.equal(result.changedPinCount, 14);
  assert.equal(result.expectedChangedPathCount, 14);
  assert.equal(result.expectedChangedPathsMatch, true);
  assert.deepEqual(result.unclassifiedChangedPins, []);
  const exactHistoricalChainPaths = [
    '.product-experience/interface-parity/operation-parity.yaml',
    '.product-experience/pdp-1-domain-data/handoff-contracts.yaml',
    '.product-experience/pdp-3-product-experience/action-registry.yaml',
    'docs/implementation/pdp-1-phase-dev-status.json',
    'tests/pdp-design-interface-parity.test.mjs',
  ];
  for (const sourcePath of exactHistoricalChainPaths) {
    const pin = result.changedPins.find(({ path: changedPath }) => changedPath === sourcePath);
    assert.equal(pin?.historicalR5Chain?.valid, true, sourcePath);
  }
  const c22 = result.changedPins.find(({ path: sourcePath }) => sourcePath === '.product-experience/interface-parity/operation-parity.yaml');
  assert(c22.historicalR5Chain.transitions.some((transition) => transition.meaningChange === 'PDP2_DEFINITION_CHANGE_LIMITED_TO_MDC30_C22_DELIVERY_ACK_EVIDENCE_BINDING'));
  const reporterPin = result.changedPins.find(({ path: sourcePath }) => sourcePath === reporterPath);
  assert.equal(reporterPin?.historicalR5Chain?.valid, true);

  const badR5Path = structuredClone(fixture.impact);
  badR5Path.historicalR5Impact.scopedTransitions.find(({ path: sourcePath }) => sourcePath === exactHistoricalChainPaths[1]).observedSha256 = `sha256:${'7'.repeat(64)}`;
  const badR5Review = review(badR5Path);
  assert(badR5Review.unclassifiedChangedPins.some(({ path: sourcePath }) => sourcePath === exactHistoricalChainPaths[1]));
  assert.equal(badR5Review.expectedChangedPaths.includes(exactHistoricalChainPaths[1]), false);

  const badR9Path = structuredClone(fixture.impact);
  badR9Path.historicalR9Checkpoint.ownerStatusJoin.pdp2ScopedImpact.scopedTransitions
    .find(({ path: sourcePath }) => sourcePath === exactHistoricalChainPaths[1]).predecessorSha256 = `sha256:${'8'.repeat(64)}`;
  const badR9Review = review(badR9Path);
  assert(badR9Review.unclassifiedChangedPins.some(({ path: sourcePath }) => sourcePath === exactHistoricalChainPaths[1]));

  const reorderedReporterBridge = structuredClone(fixture.impact);
  reorderedReporterBridge.historicalR9Checkpoint.ownerStatusJoin.supplementalDelta.currentSha256 = `sha256:${'a'.repeat(64)}`;
  const reorderedReporterReview = review(reorderedReporterBridge);
  assert.equal(reorderedReporterReview.changedPins.find(({ path: sourcePath }) => sourcePath === reporterPath)?.historicalR5Chain, null);
  const brokenReporterLink = structuredClone(fixture.impact);
  brokenReporterLink.historicalR9Checkpoint.ownerStatusJoin.pdp2ScopedImpact.scopedTransitions
    .find(({ path: sourcePath }) => sourcePath === reporterPath).predecessorSha256 = 'sha256:ca59f6c4e1313bd58387f91b41eb51fc1a10ac04b2db01faed30b9edcc9b2573';
  const brokenReporterReview = review(brokenReporterLink);
  assert.equal(brokenReporterReview.changedPins.find(({ path: sourcePath }) => sourcePath === reporterPath)?.historicalR5Chain, null);
});

test('legacy owner-status diagnostic projects mixed R5 and R1 source transitions without looking up missing R5 sourceDeltas', () => {
  const fixture = fullR25CurrentnessFixture();
  const historicalR2 = read('docs/implementation/observations/media-discovery-pdp2-exit-2026-10-13-r2.json');
  const diagnostic = ownerStatusJoin(historicalR2, fixture.currentDigests, { sourceChanges: [] }, 'sha256:test', {
    pdp2CurrentCutOptions: {
      pdp1ExitPath: 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r25.json',
      additionalSourceImpactPath: 'docs/implementation/observations/media-discovery-pdp2-additional-source-impact-2026-10-14-r1.json',
    },
  });
  assert.equal(diagnostic.pdp2ScopedImpact.currentnessSourceChains.valid, true);
  const interfaceChain = diagnostic.changedPathChecks.find(({ path: sourcePath }) => sourcePath === interfaceReviewPath
    && sourcePath === '.product-experience/interface-parity/current-source-review.json'
    && Array.isArray(diagnostic.pdp2ScopedImpact.scopedTransitions)
    && diagnostic.pdp2ScopedImpact.scopedTransitions.filter(({ path: transitionPath }) => transitionPath === sourcePath).length > 1);
  assert(interfaceChain);
  assert.equal(interfaceChain.transitionChainValid, true);
  assert.equal(interfaceChain.recordedSha256, 'sha256:0ce764d11912596ee39057db9bd0f2dfbf3c85f6269d55632bda3b3e6e4ad0dd');
  assert.equal(interfaceChain.observedSha256, 'sha256:64796cfb0db909a36e030041b2d51d02fd19fc115d703cc16bca37116f92ed06');
  assert.equal(interfaceChain.transitionHops.length, 3);
  assert.equal(diagnostic.pdp2ScopedImpact.additionalSourceImpact.valid, true);
});

test('PDP-2 predecessor gate accepts only the current matrix-bound PDP-1 R27 receipt', () => {
  const matrix = read('docs/implementation/media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json');
  const p1Path = 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r27.json';
  const p1 = read(p1Path);
  const staleP1Path = 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r25.json';
  const staleP1 = read(staleP1Path);
  const pairedP0 = { valid: true, status: 'PASS' };
  assert.equal(validatePdp1Predecessor(p1, matrix, p1Path, pairedP0).valid, true);
  assert.equal(validatePdp1Predecessor(staleP1, matrix, staleP1Path, pairedP0).valid, false);
  const staleMatrix = structuredClone(matrix);
  staleMatrix.currentCut.pdp1PhaseExit = staleP1Path;
  assert.equal(validatePdp1Predecessor(p1, staleMatrix, p1Path, pairedP0).valid, false);
  assert.equal(validatePdp1Predecessor(p1, matrix, p1Path, { valid: false, status: 'FAIL' }).valid, false);
});

test('PDP-2 currentness binds exact PDP-1 R27 with unchanged R25 source map and the separately authorized R16 projection hop', () => {
  const r27Path = 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r27.json';
  const r25Path = 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r25.json';
  const r13Path = 'docs/implementation/observations/media-discovery-pdp2-exit-2026-10-14-current-cut-r13.json';
  const r9Path = 'docs/implementation/observations/media-discovery-pdp2-exit-current-cut-r9.json';
  const r1ImpactPath = 'docs/implementation/observations/media-discovery-pdp2-additional-source-impact-2026-10-14-r1.json';
  const r16ImpactPath = 'docs/implementation/observations/media-discovery-pdp2-r16-projection-impact-2026-10-14-r1.json';
  const r27 = read(r27Path);
  const r25 = read(r25Path);
  const r13 = read(r13Path);
  const r9 = read(r9Path);
  const matrix = read('docs/implementation/media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json');
  const currentDigests = Object.fromEntries(Object.keys(r13.sourceCurrentness.sourceSetDigests.sourceContentDigests)
    .map((sourcePath) => [sourcePath, sha(sourcePath)]));
  const bridgeArgs = { r27Exit: r27, r25Exit: r25, matrix, pdp1ExitPath: r27Path, pdp1ExitDigest: sha(r27Path),
    actualCurrentDigests: currentDigests, currentDigests };
  const bridge = validatePdp1R27SourceMapBridge(bridgeArgs);
  assert.equal(bridge.valid, true);
  assert.equal(bridge.r27ReceiptValid, true);
  assert.equal(bridge.p0PredecessorValid, true);
  assert.equal(bridge.matrixMatches, true);
  assert.equal(bridge.samePathSet, true);
  assert.deepEqual(bridge.changedPaths, []);
  assert.equal(bridge.r25PathCount, 329);
  assert.equal(bridge.r27PathCount, 329);
  assert.equal(r27.observationId, 'MEDIA-PDP1-CURRENTNESS-2026-10-14-CURRENT-CUT-R27');
  assert.equal(r27.sourceCurrentness.materialSourceSetFingerprint,
    'sha256:2c982c15803a00a22a873d9874e1d00de89b1e80addc97ae984bffc578bef3aa');
  assert.equal(r27.developmentStatus.status, 'DEV_COMPLETE');
  assert.equal(r27.developmentStatus.outstandingMeaningIds.length, 0);
  assert.equal(r27.sourceCurrentness.materialPathDenominator.uniquePaths, 329);
  assert.equal(r27.sourceCurrentness.cells.length, 50);
  assert.equal(r27.predecessor.exitRef, 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r12.json');

  const p1Evidence = validatePdp1EvidenceRefresh({ predecessor: r13, currentDigests, actualCurrentDigests: currentDigests,
    pdp1Exit: r27, pdp1ExitDigest: sha(r27Path), pdp1ExitPath: r27Path });
  assert.equal(p1Evidence.valid, true);
  assert.equal(p1Evidence.pdp1Proof.developmentStatus, 'DEV_COMPLETE');
  const r16ProjectionRecord = read(r16ImpactPath);
  const r16ProjectionImpact = validatePdp2R16ProjectionImpact({ record: r16ProjectionRecord, recordPath: r16ImpactPath,
    currentDigests, actualCurrentDigests: currentDigests });
  assert.equal(r16ProjectionImpact.valid, true);
  assert.equal(r16ProjectionImpact.digest, 'sha256:230a0a04d46a6000b915c67bca4354418408c41a1bbda63ea62fa1eb9c1b86e5');
  assert.equal(r16ProjectionImpact.ownerAcceptance, 'NOT_CLAIMED');
  const p2Impact = pdp2CurrentCutImpact(r9, currentDigests, {
    pdp1ExitPath: r27Path,
    additionalSourceImpactPath: r1ImpactPath,
    additionalProjectionImpactPath: r16ImpactPath,
  });
  assert.equal(p2Impact.valid, true);
  assert.equal(p2Impact.r25ToR27Bridge.valid, true);
  assert.equal(p2Impact.additionalSourceImpact.valid, true);
  assert.equal(p2Impact.r16ProjectionImpact.valid, true);
  assert.equal(p2Impact.r16ProjectionImpact.paths.length, 1);
  assert.equal(p2Impact.currentnessSourceChains.valid, true);
  assert.equal(p2Impact.currentnessSourceChains.materialPathCount, 405);
  assert.equal(p2Impact.currentnessSourceChains.changedPathCount, 12);
  assert.equal(p2Impact.currentnessSourceChains.uniqueTransitionPathCount, 12);
  assert.equal(p2Impact.currentnessSourceChains.chains.find(({ path: sourcePath }) => sourcePath
    === '.product-experience/pdp-2-design-interface-system/generated/experience-language.candidate.json')?.r16ChainMatchesCurrent, true);
  assert.equal(p2Impact.additionalSourceImpact.ownerAcceptance, 'NOT_CLAIMED');
  assert.equal(p2Impact.r16ProjectionImpact.ownerAcceptance, 'NOT_CLAIMED');
  assert.equal(p2Impact.combinedSourceRefresh.noOverlappingImpactPaths, true);
  assert.equal(p2Impact.combinedSourceRefresh.predecessorPathCount, 405);
  assert.equal(p2Impact.combinedSourceRefresh.changedPathCount, 4);
  assert.equal(p2Impact.combinedSourceRefresh.changedPaths.length, 4);

  const badReceiptDigest = validatePdp1R27SourceMapBridge({ ...bridgeArgs, pdp1ExitDigest: `sha256:${'0'.repeat(64)}` });
  assert.equal(badReceiptDigest.valid, false);
  assert.equal(badReceiptDigest.r27ReceiptValid, false);
  const wrongDenominatorReceipt = structuredClone(r27);
  wrongDenominatorReceipt.sourceCurrentness.materialPathDenominator.uniquePaths = 330;
  assert.equal(validatePdp1R27SourceMapBridge({ ...bridgeArgs, r27Exit: wrongDenominatorReceipt }).valid, false);
  const staleMatrixPointer = structuredClone(matrix);
  staleMatrixPointer.currentCut.pdp1PhaseExit = r25Path;
  assert.equal(validatePdp1R27SourceMapBridge({ ...bridgeArgs, matrix: staleMatrixPointer }).valid, false);
  const changedR27Map = structuredClone(r27);
  changedR27Map.sourceCurrentness.sourceContentDigests[Object.keys(changedR27Map.sourceCurrentness.sourceContentDigests)[0]] = `sha256:${'1'.repeat(64)}`;
  const deltaBridge = validatePdp1R27SourceMapBridge({ ...bridgeArgs, r27Exit: changedR27Map });
  assert.equal(deltaBridge.valid, false);
  assert.equal(deltaBridge.changedPaths.length, 1);
});

test('PDP-2 supplemental v3 rejects wrong exact paths, hashes, receipts, classes, overlaps, and denominators', () => {
  assert.equal(v3R25Fixture({ mutateRecord: (record) => { record.sourceDeltas[0].path = '.product-experience/decision-log.md#other'; } }).result.valid, false);
  assert.equal(v3R25Fixture({ mutateRecord: (record) => { record.sourceDeltas[1].observedSha256 = `sha256:${'0'.repeat(64)}`; } }).result.valid, false);
  assert.equal(v3R25Fixture({ mutateRecord: (record) => { record.predecessorCut.receiptSha256 = `sha256:${'1'.repeat(64)}`; } }).result.valid, false);
  assert.equal(v3R25Fixture({ mutateRecord: (record) => { record.pdp1Predecessor.receiptRef = pdp1ExitR16Path; } }).result.valid, false);
  assert.equal(v3R25Fixture({ mutateRecord: (record) => { record.sourceDeltas[0].classification = 'PDP2_MEANING_CHANGE'; } }).result.valid, false);
  assert.equal(v3R25Fixture({ mutateRecord: (record) => { record.sourceDeltas[2] = { ...record.sourceDeltas[1] }; } }).result.valid, false);
  assert.equal(v3R25Fixture({ mutateRecord: (record) => { record.authority.userAuthorization.authorizedTransitions[0].observedSha256 = `sha256:${'2'.repeat(64)}`; } }).result.valid, false);
  assert.equal(v3R25Fixture({ mutateRecord: (record) => { record.authority.userAuthorization.exactResponse = 'Authorized'; } }).result.valid, false);
  assert.equal(v3R25Fixture({ mutateRecord: (record) => { record.authority.userAuthorization.additionalScopedAuthorizationResponse = 'Authorized'; } }).result.valid, false);
  assert.equal(v3R25Fixture({ mutateRecord: (record) => { record.authority.userAuthorization.exactResponses[1] = 'Authorized'; } }).result.valid, false);
  assert.equal(v3R25Fixture({ mutatePredecessor: (receipt) => { delete receipt.sourceCurrentness.sourceSetDigests.sourceContentDigests['tests/media-pdp-p2-dev-status.test.mjs']; } }).result.valid, false);
  assert.equal(v3R25Fixture({ mutateCurrent: (digests) => { delete digests[semanticReviewPath]; } }).result.valid, false);
  assert.equal(v3R25Fixture({ mutateActual: (digests) => { digests[semanticReviewPath] = `sha256:${'3'.repeat(64)}`; } }).result.valid, false);

  const fixture = v3R25Fixture();
  const overlap = validatePdp2CombinedSourceRefresh({
    predecessor: fixture.r13, currentDigests: fixture.currentDigests,
    p2Impact: { valid: true, scopedChangedPaths: [fixture.result.paths[0]], supplementalSourceWork: [] },
    p1EvidenceRefresh: { valid: true, paths: [] },
    additionalP2Impact: fixture.result,
  });
  assert.equal(overlap.valid, false);
  assert.equal(overlap.noOverlappingImpactPaths, false);
});
