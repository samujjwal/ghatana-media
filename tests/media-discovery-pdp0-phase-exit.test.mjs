import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { joinMediaPdp0PhaseExit, mediaPdp0RequiredCommands } from '../scripts/lib/media-discovery-pdp0-phase-exit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const fingerprint = `sha256:${'a'.repeat(64)}`;
const owner = {
  recordKind: 'OWNER_DECISION_INPUT_NOT_TECHNICAL_CURRENTNESS_NOT_LIFECYCLE_RECEIPT',
  decisionId: 'MEDIA-OWN-P0-2026-10-13-R2',
  decisionStatus: 'APPROVED_INTERNAL_DELEGATED_EXACT_MATERIAL_CUT',
  authority: {
    ownerRole: 'Media Product Truth / development-status',
    actorKind: 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION',
    humanIndependentSignatureProvided: false,
    qualifiedExternalSpecialistSignoffProvided: false,
  },
  subject: {
    phase: 'PDP-0',
    materialSourceSetFingerprint: fingerprint,
    changedMeaningIds: [],
    outstandingMeaningIds: [],
    surfaceScope: {
      physicalCandidates: 26,
      physicalDispositions: { PHYSICAL: 12, SUPPORT_ONLY: 12, SUBSUMED: 2 },
      semanticCompositions: 6,
      repositoryRoot: 1,
      nonphysicalConsumerCrosswalks: 17,
      totalPhaseCells: 50,
    },
  },
  decision: {
    meaningDevelopmentTasksRemaining: 0,
    mayExecuteMdc06: true,
    internalDevelopmentDefinitionAcceptance: 'APPROVED_FOR_REUSE',
    observedSourceCurrentnessOwnerDisposition: 'ACCEPT_EXACT_MATERIAL_FINGERPRINT_PENDING_FRESH_TECHNICAL_CAPTURE',
  },
};

function technical() {
  const cells = Array.from({ length: 50 }, (_, index) => ({
    cellId: `surface-${index}:PDP-0`,
    surfaceId: `surface-${index}`,
    cellType: 'PHYSICAL_CANDIDATE',
    applicability: { disposition: 'APPLICABLE', rationale: 'fixture rationale' },
    sourceCurrentness: 'CURRENT',
    expectedPathCount: 1,
    expectedPathSetFingerprint: fingerprint,
    sourceSetFingerprint: fingerprint,
    blockers: [],
  }));
  return {
    materialSourceSetFingerprint: fingerprint,
    campaign: { observedHead: 'abc123', branch: 'main' },
    denominators: { physicalCandidates: 26, semanticCompositions: 6, repositoryRoots: 1, consumers: 17, totalCells: 50 },
    physicalCompositeConsumerCells: cells,
    unclassifiedHistoricalPdp0PinChanges: [],
    externalOwnerContracts: { totalFiles: 30, digestMatches: 30, digestMismatches: [] },
    authority: { changedMeaningIds: [] },
    materialPathDenominator: { uniquePaths: 146, sharedPaths: 20, cellSpecificPaths: 126 },
    sharedMaterialPaths: [],
    sourceContentDigests: {},
    historicalPhaseStatusComparison: [],
    historicalPdp0PinDriftClassifications: [],
    requiredPdp0SourceMembership: [],
    lifecycleSourceCurrentness: { continuity: 'CONTINUOUS', consistencyStable: true },
    phaseDisposition: {
      historicalDefinitionStatus: 'DEV_COMPLETE',
      historicalOutstandingMeaningIds: [],
      currentSourceCurrentness: 'PASS',
      sourceCurrent: true,
    },
  };
}

const testOutcomes = mediaPdp0RequiredCommands.map((command) => ({
  command,
  status: 'PASS',
  exitCode: 0,
  ...(command.startsWith('node --test ')
    ? { testCount: 1, passedCount: 1, failedCount: 0, skippedCount: 0 }
    : {}),
}));

const currentCutOwnerDirections = JSON.parse(fs.readFileSync(path.join(root, 'docs/implementation/observations/media-discovery-current-cut-owner-directions-2026-10-13-r2.json'), 'utf8'));
const historicalPdp0Exit = JSON.parse(fs.readFileSync(path.join(root, 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-13-r2.json'), 'utf8'));

function currentCutTechnical() {
  const result = technical();
  result.sourceContentDigests = { ...historicalPdp0Exit.sourceCurrentness.sourceContentDigests };
  for (const change of currentCutOwnerDirections.predecessorImpactReviews[0].sourceChanges) {
    result.sourceContentDigests[change.path] = change.observedSha256;
  }
  result.sourceContentDigests['scripts/report-media-pdp-readiness.mjs'] = 'sha256:f3482cf689e0be2d8dc9faf9ccc72a1b63a1dcaecd056efaa1759e6f3696a5e1';
  return result;
}

test('PDP-0 phase exit passes only when the source cut, delegated owner input, scope, and required outcomes join', () => {
  const exit = joinMediaPdp0PhaseExit({
    technicalCurrentness: technical(), ownerAcceptance: owner, testOutcomes, baselineSha: 'abc123', observedAt: '2026-10-13T00:00:00.000Z',
  });
  assert.equal(exit.phaseExit.status, 'PASS');
  assert.equal(exit.phaseExit.nextLegalAction, 'ADVANCE_TO_PDP1_MDC10');
  assert.equal(exit.sourceCurrentness.cells.length, 50);
  assert.equal(exit.delegatedOwnerAcceptance.humanIndependentSignatureProvided, false);
});

test('a fingerprint mismatch is a stale owner approval and cannot pass PDP-0', () => {
  const changedTechnical = technical();
  changedTechnical.materialSourceSetFingerprint = `sha256:${'b'.repeat(64)}`;
  const exit = joinMediaPdp0PhaseExit({ technicalCurrentness: changedTechnical, ownerAcceptance: owner, testOutcomes });
  assert.equal(exit.phaseExit.status, 'STALE_APPROVAL_FOR_CHANGED_MATERIAL');
  assert.ok(exit.phaseExit.blockers.includes('STALE_APPROVAL_FOR_CHANGED_MATERIAL'));
  assert.equal(exit.phaseExit.nextLegalAction, 'TARGETED_OWNER_CHANGE_REVIEW_THEN_RECAPTURE_PDP0');
});

test('failed or skipped required tests cannot be collapsed into a passing phase exit', () => {
  const failedOutcomes = testOutcomes.map((outcome) => outcome.command.startsWith('node --test ')
    ? { ...outcome, status: 'FAIL', exitCode: 1, testCount: 2, passedCount: 1, failedCount: 1 }
    : outcome);
  const exit = joinMediaPdp0PhaseExit({ technicalCurrentness: technical(), ownerAcceptance: owner, testOutcomes: failedOutcomes });
  assert.equal(exit.phaseExit.status, 'FAIL');
  assert.ok(exit.phaseExit.blockers.some((blocker) => blocker.startsWith('REQUIRED_CHECK_FAILED:')));
});

test('the current delegated owner input is explicitly bound to the reviewed PDP-0 source cut', () => {
  const currentOwner = JSON.parse(fs.readFileSync(path.join(root, 'docs/implementation/observations/media-discovery-delegated-owner-acceptance-pdp0-2026-10-13-r2.json'), 'utf8'));
  assert.equal(currentOwner.decisionId, 'MEDIA-OWN-P0-2026-10-13-R2');
  assert.equal(currentOwner.subject.materialSourceSetFingerprint, 'sha256:7a7a0f700890915863e9f93eafa30edc2f6d856adbf7944c17fecc0aadd8031b');
  assert.deepEqual(currentOwner.subject.changedMeaningIds, []);
  assert.deepEqual(currentOwner.subject.outstandingMeaningIds, []);
  assert.equal(currentOwner.authority.humanIndependentSignatureProvided, false);
});

test('the current-cut owner direction and exact supplement join only the 146-path predecessor cut and five approved deltas', () => {
  const exit = joinMediaPdp0PhaseExit({
    technicalCurrentness: currentCutTechnical(),
    ownerAcceptance: currentCutOwnerDirections,
    historicalPdp0Exit,
    testOutcomes,
  });
  assert.equal(exit.phaseExit.status, 'PASS');
  assert.equal(exit.ownerStatusJoin.status, 'ACCEPTED_FOR_EXACT_CURRENT_FINGERPRINT_WITH_REVIEWED_DELTA');
  assert.equal(exit.ownerStatusJoin.predecessorPathCount, 146);
  assert.equal(exit.ownerStatusJoin.observedPathCount, 146);
  assert.equal(exit.ownerStatusJoin.unchangedPathCount, 141);
  assert.equal(exit.ownerStatusJoin.ownerApprovedChangedPathCount, 5);
  assert.equal(exit.ownerStatusJoin.supplementalImpactRef, 'docs/implementation/observations/media-discovery-predecessor-impact-pdp3-status-guard-2026-10-14-r1.json');
  assert.equal(exit.ownerStatusJoin.supplementalDecisionId, 'MEDIA-DISCOVERY-PREDECESSOR-IMPACT-PDP3-STATUS-GUARD-2026-10-14-R1');
  assert.equal(exit.ownerStatusJoin.unapprovedChangedPathCount, 0);
  assert.equal(exit.ownerStatusJoin.missingPathCount, 0);
  assert.equal(exit.ownerStatusJoin.additionalPathCount, 0);
  assert.equal(exit.delegatedOwnerAcceptance.humanIndependentSignatureProvided, null);
  assert.equal(exit.independentApproval, 'NOT_CLAIMED_AND_NOT_WAIVED');
});

test('the current-cut owner direction fails closed on an additional path digest change', () => {
  const changed = currentCutTechnical();
  const unchangedPath = Object.keys(changed.sourceContentDigests).find((sourcePath) => !REVIEWED_PATHS.has(sourcePath));
  changed.sourceContentDigests[unchangedPath] = `sha256:${'f'.repeat(64)}`;
  const exit = joinMediaPdp0PhaseExit({
    technicalCurrentness: changed,
    ownerAcceptance: currentCutOwnerDirections,
    historicalPdp0Exit,
    testOutcomes,
  });
  assert.equal(exit.phaseExit.status, 'FAIL');
  assert.equal(exit.ownerStatusJoin.status, 'BLOCKED');
  assert.ok(exit.delegatedOwnerAcceptance.blockers.includes(`PDP0_SOURCE_DIGEST_NOT_OWNER_REVIEWED:${unchangedPath}`));
});

test('the current-cut owner direction fails closed when predecessor path membership is incomplete', () => {
  const incomplete = currentCutTechnical();
  const missingPath = Object.keys(incomplete.sourceContentDigests)[0];
  delete incomplete.sourceContentDigests[missingPath];
  const exit = joinMediaPdp0PhaseExit({
    technicalCurrentness: incomplete,
    ownerAcceptance: currentCutOwnerDirections,
    historicalPdp0Exit,
    testOutcomes,
  });
  assert.equal(exit.phaseExit.status, 'FAIL');
  assert.equal(exit.ownerStatusJoin.status, 'BLOCKED');
  assert.ok(exit.delegatedOwnerAcceptance.blockers.includes('PDP0_MATERIAL_PATH_MEMBERSHIP_CHANGED'));
});

const REVIEWED_PATHS = new Set([
  '.product-experience/artifact-identities.yaml',
  '.product-experience/source-manifest.yaml',
  '.product-experience/surface-registry.yaml',
  'apps/media-experience-explorer/specification-artifacts.json',
  'scripts/report-media-pdp-readiness.mjs',
]);
