import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  currentnessOwnerStatusJoin,
  validatePdp1EvidenceRefresh,
  validatePdp2CurrentCutImpact,
  validatePdp2R9HistoricalCheckpoint,
} from '../scripts/capture-media-discovery-pdp2-current-cut.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
const sha = (relativePath) => `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relativePath))).digest('hex')}`;
const r9Path = 'docs/implementation/observations/media-discovery-pdp2-exit-current-cut-r9.json';
const r4Path = 'docs/implementation/observations/media-discovery-pdp2-current-cut-source-impact-2026-10-14-r4.json';
const r5Path = 'docs/implementation/observations/media-discovery-pdp2-current-cut-source-impact-2026-10-14-r5.json';
const r22Path = 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r22.json';
const statusGuardPath = 'docs/implementation/observations/media-discovery-predecessor-impact-pdp3-status-guard-2026-10-14-r1.json';
const statusPath = 'docs/implementation/pdp-1-phase-dev-status.json';
const semanticReviewPath = 'docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json';
const r9 = read(r9Path);
const r4 = read(r4Path);
const r5 = read(r5Path);
const r22 = read(r22Path);

const r4Transitions = [
  ['.product-experience/interface-parity/current-source-review.json', '0ce764d11912596ee39057db9bd0f2dfbf3c85f6269d55632bda3b3e6e4ad0dd', '90fc6830f99e26abd4c27222a6193f98b1756dfa48a9ac533b86c7de6ad2fa76'],
  ['.product-experience/pdp-1-domain-data/handoff-contracts.yaml', '3605ff3a216e8187acad158666be6e0a13801ee947099a7e657e3e29c59e9338', '0055cb68ee08825d8936763353e011ffa5e3979562c42685566d525a6a074024'],
  ['.product-experience/pdp-3-product-experience/action-registry.yaml', 'da420ef9636484039f64963219e8f361e1e4c35ed05fee61a6fbccc92a9ea4c2', '832beaf50f03f9e3c4d8bf0f7e5f47ffe38b570c3e4864bef04c7362352180fe'],
  ['docs/implementation/pdp-1-phase-dev-status.json', '73a491d5ab0ba0c5ad97bde97d2f3592c13bf9282bb8cae197d34b25bff23e18', '5e78da9588c880c497eb5e3e2a632910501ea722af05c1938c02bc5f64431e65'],
  ['docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json', 'e0a67706f34270e8dd8a873a0193fc3ef50342acf417db2767d4b98f94217020', '610a7eb85ab8be0c127f4e66361803496a784c01b53e8b0534d402cb75548b76'],
  ['scripts/report-media-pdp-readiness.mjs', 'ca59f6c4e1313bd58387f91b41eb51fc1a10ac04b2db01faed30b9edcc9b2573', '4f0400c142d2f3df39c4497839925dad80f1ac90584573b390af386e491faa0f'],
  ['.product-experience/pdp-2-design-interface-system/component-value-types.yaml', 'e47dc82ee2b2bcb5b1908976b4be5f452c843854d578893ecf3f3d42287b35ba', 'aed62bda69a5d44bccee0873eb03bada142994d2256f515fbe1ea89af50d0313'],
  ['tests/pdp-design-interface-component-contracts.test.mjs', '338e06f661d423cc2cfc8ca5f2a71dce3957e947be45aad95a59273e1918ac4a', '0242344bcc4c4880ee7242466acd00333f8d5402658987f4bd98fbab15331062'],
];
const r5Transitions = [
  ['.product-experience/interface-parity/operation-parity.yaml', '8b95782fe47cb7e44ec159c168399f78a674dbc1c6f72065881c278f7e3c13d6', '24e4699d42dd1a2a0363628387fdf2a12c539f8ac697a0b8771277bbd4aa8555'],
  ['.product-experience/interface-parity/current-source-review.json', '90fc6830f99e26abd4c27222a6193f98b1756dfa48a9ac533b86c7de6ad2fa76', '866729bdb41448d7e1d08ca288e5e71300f999d26e85cd53d2e5377ecdf299bd'],
  ['docs/implementation/pdp-1-phase-dev-status.json', '5e78da9588c880c497eb5e3e2a632910501ea722af05c1938c02bc5f64431e65', 'eb9e7e8ce14c73469daf29406642793c58669351a0035d7bd937e9fe79b8dd2d'],
  ['docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json', '610a7eb85ab8be0c127f4e66361803496a784c01b53e8b0534d402cb75548b76', 'e9350fb4424fceeca2f13b93f756231e5b648904bb002de11d3d9659a0b994b6'],
  ['tests/pdp-design-interface-parity.test.mjs', '0a62ff64736fa6f8a4965a9ba10dffb4213b22c22a6c23e02b681da225a16d6b', 'bf459ddf4af32ba7a960c8b2909e65f873453c276dafc7bff9660842f7e21acd'],
];

function r5Impact(candidate = r5) {
  const sourceMap = r9.sourceCurrentness.sourceSetDigests.sourceContentDigests;
  const currentDigests = Object.fromEntries(Object.keys(sourceMap).map((sourcePath) => [sourcePath, sha(sourcePath)]));
  const actualCurrentDigests = { ...currentDigests };
  return validatePdp2CurrentCutImpact({
    impact: candidate,
    predecessor: r9,
    currentDigests,
    actualCurrentDigests,
    predecessorDigest: sha(r9Path),
    impactDigest: candidate === r5 ? sha(r5Path) : sha(r5Path),
    predecessorPath: r9Path,
    impactPath: r5Path,
    pdp1Exit: r22,
    pdp1ExitDigest: sha(r22Path),
    pdp1ExitPath: r22Path,
  });
}

test('PDP-2 R5 preserves the R4 transition baseline and binds its exact five-path successor cut', () => {
  assert.equal(r5.recordId, 'MEDIA-DISCOVERY-PDP2-CURRENT-CUT-SOURCE-IMPACT-2026-10-14-R5');
  assert.equal(r5.supersedes.ref, r4Path);
  assert.equal(r5.supersedes.recordId, r4.recordId);
  assert.equal(r5.supersedes.sha256, sha(r4Path));
  const transitions = (record) => [...record.sourceDeltas, ...(record.supplementalSourceWork ?? [])]
    .map(({ path: p, predecessorSha256, observedSha256 }) => [p, predecessorSha256.slice(7), observedSha256.slice(7)]);
  const r4Rows = transitions(r4);
  const r5Rows = transitions(r5);
  for (const expected of r4Transitions) assert.ok(r4Rows.some((row) => JSON.stringify(row) === JSON.stringify(expected)), `R4 baseline missing exact transition ${expected[0]}`);
  for (const expected of r5Transitions) assert.ok(r5Rows.some((row) => JSON.stringify(row) === JSON.stringify(expected)), `R5 missing exact transition ${expected[0]}`);
  assert.equal(r5Transitions.every((expected) => r5Rows.some((row) => JSON.stringify(row) === JSON.stringify(expected))), true);
  assert.equal(r5.pdp1Predecessor.receiptRef, r22Path);
  assert.equal(r5.pdp1Predecessor.receiptSha256, sha(r22Path));
  assert.equal(r5.scopeLimits.onlyTheseSixInheritedR4TransitionsAuthorized, true);
  assert.equal(r5.supplementalSourceWork.length, 2);
  const result = r5Impact();
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.transitionCount, 11);
  assert.equal(result.independentOrExternalOrLifecycleClaims, false);
});

test('PDP-1 R22 refresh is current and joined to the R5 impact without promoting acceptance or closure', () => {
  assert.equal(r22.observationId, 'MEDIA-PDP1-CURRENTNESS-2026-10-14-CURRENT-CUT-R22');
  const sourceMap = r9.sourceCurrentness.sourceSetDigests.sourceContentDigests;
  const currentDigests = Object.fromEntries(Object.keys(sourceMap).map((sourcePath) => [sourcePath, sha(sourcePath)]));
  const actualCurrentDigests = { ...currentDigests };
  const p1 = validatePdp1EvidenceRefresh({
    predecessor: r9,
    currentDigests,
    actualCurrentDigests,
    pdp1Exit: r22,
    pdp1ExitDigest: sha(r22Path),
    pdp1ExitPath: r22Path,
    statusSource: read(statusPath),
    semanticReviewSource: read(semanticReviewPath),
  });
  assert.equal(p1.valid, true, JSON.stringify(p1));
  assert.equal(p1.pdp1Proof.phaseStatus, 'PASS');
  assert.equal(r22.phaseExit.status, 'PASS');
  assert.equal(r22.ownerAcceptance ?? 'NOT_CLAIMED', 'NOT_CLAIMED');
  assert.equal(r22.independentAcceptance ?? 'NOT_CLAIMED', 'NOT_CLAIMED');
  assert.equal(r22.lifecycleClosure ?? 'NOT_ENTERED', 'NOT_ENTERED');
});

test('PDP-2 R5 rejects altered transition hashes, unapproved paths, and stale PDP-1 R22 bindings', () => {
  const alteredTransition = structuredClone(r5);
  alteredTransition.sourceDeltas.find((delta) => delta.path === r5Transitions[0][0]).observedSha256 = `sha256:${'0'.repeat(64)}`;
  assert.equal(r5Impact(alteredTransition).valid, false);
  const extraPath = structuredClone(r5);
  extraPath.sourceDeltas.push({ ...extraPath.sourceDeltas[0], path: 'unapproved/r5-input.yaml' });
  assert.equal(r5Impact(extraPath).valid, false);
  const stalePdp1 = structuredClone(r5);
  stalePdp1.pdp1Predecessor.receiptSha256 = `sha256:${'1'.repeat(64)}`;
  assert.equal(r5Impact(stalePdp1).valid, false);
});

test('PDP-2 R5 rejects same-count duplicate hops, altered no-meaning classification, and changed authorization evidence', () => {
  const duplicateHop = structuredClone(r5);
  duplicateHop.sourceDeltas[6] = structuredClone(duplicateHop.sourceDeltas[7]);
  assert.equal(duplicateHop.sourceDeltas.length, r5.sourceDeltas.length);
  assert.equal(r5Impact(duplicateHop).valid, false);

  const alteredNonC22 = structuredClone(r5);
  const nonC22 = alteredNonC22.sourceDeltas.find((delta) => delta.path === 'docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json'
    && delta.predecessorSha256.endsWith('610a7eb85ab8be0c127f4e66361803496a784c01b53e8b0534d402cb75548b76'));
  nonC22.classification = 'PDP2_NEW_GENERAL_MEANING';
  nonC22.meaningChange = 'PDP2_DEFINITION_CHANGE';
  nonC22.meaningIdsChanged = ['UNAUTHORIZED.MEANING'];
  assert.equal(r5Impact(alteredNonC22).valid, false);

  const alteredAuthorization = structuredClone(r5);
  alteredAuthorization.authority.authorizationEvidence[1].exactResponse = 'Authorize all unspecified future transitions';
  assert.equal(r5Impact(alteredAuthorization).valid, false);
  const alteredPaths = structuredClone(r5);
  alteredPaths.authority.authorizationEvidence[1].authorizedPaths[0] = 'unapproved/path.yaml';
  assert.equal(r5Impact(alteredPaths).valid, false);
  const alteredHopList = structuredClone(r5);
  alteredHopList.authority.authorizationEvidence[1].authorizedTransitions.pop();
  assert.equal(r5Impact(alteredHopList).valid, false);

  const alteredSupplement = structuredClone(r5);
  alteredSupplement.supplementalSourceWork[0].observedSha256 = `sha256:${'9'.repeat(64)}`;
  assert.equal(r5Impact(alteredSupplement).valid, false);
});

test('the reporter source chain preserves status-guard history and the R4-to-R5 authorized successor', () => {
  const statusGuard = read(statusGuardPath);
  const reporterPath = 'scripts/report-media-pdp-readiness.mjs';
  const guardHop = statusGuard.sourceDelta;
  const r4Hop = [...r4.sourceDeltas, ...(r4.supplementalSourceWork ?? [])].find((delta) => delta.path === reporterPath);
  const r5Hop = [...r5.sourceDeltas, ...(r5.supplementalSourceWork ?? [])].find((delta) => delta.path === reporterPath);
  assert.deepEqual([guardHop.predecessorSha256, guardHop.observedSha256], [
    'sha256:6655e0344b7f4b03f6ca0b7e594a5448eed72ae5aeac198cef4bb1b28252028c',
    'sha256:f3482cf689e0be2d8dc9faf9ccc72a1b63a1dcaecd056efaa1759e6f3696a5e1',
  ]);
  assert.deepEqual([r4Hop.predecessorSha256, r4Hop.observedSha256], [
    'sha256:ca59f6c4e1313bd58387f91b41eb51fc1a10ac04b2db01faed30b9edcc9b2573',
    'sha256:4f0400c142d2f3df39c4497839925dad80f1ac90584573b390af386e491faa0f',
  ]);
  assert.deepEqual([r5Hop.predecessorSha256, r5Hop.observedSha256], [r4Hop.predecessorSha256, r4Hop.observedSha256]);
  assert.equal(r5Impact().valid, true);
});

test('the active owner join uses the exact R9 checkpoint and R5 R9-to-live transition set', () => {
  const historicalR2 = read('docs/implementation/observations/media-discovery-pdp2-exit-2026-10-13-r2.json');
  const ownerDirections = read('docs/implementation/observations/media-discovery-current-cut-owner-directions-2026-10-13-r2.json');
  const ownerReview = ownerDirections.predecessorImpactReviews.find((review) => review.phase === 'PDP-2');
  const sourceMap = r9.sourceCurrentness.sourceSetDigests.sourceContentDigests;
  const currentDigests = Object.fromEntries(Object.keys(sourceMap).map((sourcePath) => [sourcePath, sha(sourcePath)]));
  const checkpoint = validatePdp2R9HistoricalCheckpoint(r9);
  const result = currentnessOwnerStatusJoin(historicalR2, currentDigests, ownerReview,
    'sha256:current-test-material-fingerprint', { r9Checkpoint: r9 });

  assert.equal(checkpoint.valid, true, JSON.stringify(checkpoint));
  assert.equal(checkpoint.historicalJoinStatus, 'PASS');
  assert.deepEqual(checkpoint.decisionLogCheckpoint, {
    path: '.product-experience/decision-log.md',
    predecessorSha256: 'sha256:cdea20d6fa57cc4d7bbea866d911c03685eeb74e0bfdb4e0a5df0c90ded56db4',
    observedSha256: 'sha256:9831b03ecd3f30d2cbfd7a1db62d934035ba20cf1482bb5e621d166eacdb9b4c',
    classification: 'PDP1_DELEGATED_DEFINITION_DECISION_LOG_PREDECESSOR_REFRESH',
    valid: true,
  });
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  assert.equal(result.checkpointStatus, 'PASS');
  assert.equal(result.legacyR2HistoricalDiagnostic.ref, 'docs/implementation/observations/media-discovery-pdp2-exit-2026-10-13-r2.json');
  assert.deepEqual([result.historicalPathCount, result.currentPathCount, result.unchangedPathCount,
    result.changedPathCount, result.unapprovedChangedPathCount, result.missingPathCount,
    result.additionalPathCount], [405, 405, 395, 10, 0, 0, 0]);
  assert.equal(result.pdp2ScopedImpact.valid, true);
});

test('the active owner join blocks post-R9 decision-log changes and a tampered R9 historical linkage', () => {
  const historicalR2 = read('docs/implementation/observations/media-discovery-pdp2-exit-2026-10-13-r2.json');
  const ownerDirections = read('docs/implementation/observations/media-discovery-current-cut-owner-directions-2026-10-13-r2.json');
  const ownerReview = ownerDirections.predecessorImpactReviews.find((review) => review.phase === 'PDP-2');
  const sourceMap = r9.sourceCurrentness.sourceSetDigests.sourceContentDigests;
  const currentDigests = Object.fromEntries(Object.keys(sourceMap).map((sourcePath) => [sourcePath, sha(sourcePath)]));

  const postR9DecisionLogChange = { ...currentDigests,
    '.product-experience/decision-log.md': `sha256:${'d'.repeat(64)}` };
  const blockedChange = currentnessOwnerStatusJoin(historicalR2, postR9DecisionLogChange, ownerReview,
    'sha256:current-test-material-fingerprint', { r9Checkpoint: r9 });
  assert.equal(blockedChange.status, 'FAIL');
  assert.ok(blockedChange.unapprovedChangedPaths.includes('.product-experience/decision-log.md'));
  assert.equal(blockedChange.checkpointStatus, 'PASS');

  const tamperedCheckpoint = structuredClone(r9);
  tamperedCheckpoint.ownerStatusJoin.historicalExitRef = 'docs/implementation/observations/unrelated-pdp2-exit.json';
  const invalidCheckpoint = validatePdp2R9HistoricalCheckpoint(tamperedCheckpoint);
  assert.equal(invalidCheckpoint.valid, false);
  const blockedCheckpoint = currentnessOwnerStatusJoin(historicalR2, currentDigests, ownerReview,
    'sha256:current-test-material-fingerprint', { r9Checkpoint: tamperedCheckpoint });
  assert.equal(blockedCheckpoint.status, 'FAIL');
  assert.equal(blockedCheckpoint.checkpointStatus, 'FAIL');
});
