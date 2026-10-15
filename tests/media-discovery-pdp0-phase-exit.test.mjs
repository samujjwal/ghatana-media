import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { joinMediaPdp0PhaseExit, mediaPdp0RequiredCommands, resolveMediaPdp0SuccessorPredecessorRefs } from '../scripts/lib/media-discovery-pdp0-phase-exit.mjs';
import {
  buildMediaPdp0CurrentnessPhaseDisposition,
  classifyCurrentCutPdp0PinChange,
} from '../scripts/record-media-discovery-pdp0-currentness.mjs';

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
const currentCutPdp0Predecessor = JSON.parse(fs.readFileSync(path.join(root, 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r2.json'), 'utf8'));
const currentCutImpact = JSON.parse(fs.readFileSync(path.join(root, 'docs/implementation/observations/media-discovery-current-cut-source-impact-2026-10-14-r1.json'), 'utf8'));
const currentCutImpactPath = 'docs/implementation/observations/media-discovery-current-cut-source-impact-2026-10-14-r1.json';
const currentCutImpactDigest = `sha256:${createHash('sha256').update(fs.readFileSync(path.join(root, currentCutImpactPath))).digest('hex')}`;
const r8ExitPath = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r8.json';
const r8CurrentnessPath = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r8.json';
const r8Exit = JSON.parse(fs.readFileSync(path.join(root, r8ExitPath), 'utf8'));
const r8SuccessorImpactPath = 'docs/implementation/observations/media-discovery-pdp0-r8-successor-impact-2026-10-14-r2.json';
const r8SuccessorImpact = JSON.parse(fs.readFileSync(path.join(root, r8SuccessorImpactPath), 'utf8'));
const r8Currentness = JSON.parse(fs.readFileSync(path.join(root, r8CurrentnessPath), 'utf8'));

test('PDP-0 successor CLI binds each impact record to its exact predecessor exit and currentness', () => {
  assert.deepEqual(resolveMediaPdp0SuccessorPredecessorRefs('MEDIA-DISCOVERY-PDP0-R6-SUCCESSOR-IMPACT-2026-10-14-R1'), {
    exitRef: 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r6.json',
    currentnessRef: 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r6.json',
  });
  assert.deepEqual(resolveMediaPdp0SuccessorPredecessorRefs('MEDIA-DISCOVERY-PDP0-R8-SUCCESSOR-IMPACT-2026-10-14-R2'), {
    exitRef: r8ExitPath, currentnessRef: r8CurrentnessPath,
  });
  assert.deepEqual(resolveMediaPdp0SuccessorPredecessorRefs('MEDIA-DISCOVERY-PDP0-PXD164-SUCCESSOR-IMPACT-2026-10-14-R1'), {
    exitRef: 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r10.json',
    currentnessRef: 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r10.json',
  });
  assert.deepEqual(resolveMediaPdp0SuccessorPredecessorRefs('MEDIA-DISCOVERY-PDP0-R11-SUCCESSOR-IMPACT-2026-10-14-R1'), {
    exitRef: 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r11.json',
    currentnessRef: 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r11.json',
  });
  assert.deepEqual(resolveMediaPdp0SuccessorPredecessorRefs('MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R1'), {
    exitRef: 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r12.json',
    currentnessRef: 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r12.json',
  });
  assert.deepEqual(resolveMediaPdp0SuccessorPredecessorRefs('MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R2'), {
    exitRef: 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r12.json',
    currentnessRef: 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r12.json',
  });
  assert.throws(() => resolveMediaPdp0SuccessorPredecessorRefs('MEDIA-DISCOVERY-PDP0-R13-SUCCESSOR-IMPACT-2026-10-14-R1'), /Unsupported PDP-0 successor impact recordId/);
});

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

function currentCutImpactTechnical() {
  const result = technical();
  result.sourceContentDigests = { ...currentCutPdp0Predecessor.sourceCurrentness.sourceContentDigests };
  result.sourceContentDigests['scripts/report-media-pdp-readiness.mjs'] = 'sha256:ca59f6c4e1313bd58387f91b41eb51fc1a10ac04b2db01faed30b9edcc9b2573';
  return result;
}

test('the current-cut impact disposition joins only the exact PDP0 R2 predecessor and one reporter change', () => {
  const exit = joinMediaPdp0PhaseExit({
    technicalCurrentness: currentCutImpactTechnical(),
    ownerAcceptance: currentCutImpact,
    historicalPdp0Exit: currentCutPdp0Predecessor,
    testOutcomes,
  });
  assert.equal(exit.phaseExit.status, 'PASS');
  assert.equal(exit.ownerStatusJoin.status, 'ACCEPTED_FOR_EXACT_CURRENT_FINGERPRINT_WITH_REVIEWED_DELTA');
  assert.equal(exit.ownerStatusJoin.predecessorExitRef, 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r2.json');
  assert.equal(exit.ownerStatusJoin.supplementalImpactRef, 'docs/implementation/observations/media-discovery-current-cut-source-impact-2026-10-14-r1.json');
  assert.equal(exit.ownerStatusJoin.supplementalDecisionId, 'MEDIA-DISCOVERY-CURRENT-CUT-SOURCE-IMPACT-2026-10-14-R1');
  assert.equal(exit.ownerStatusJoin.supplementalImpactSha256, currentCutImpactDigest);
  assert.equal(exit.ownerStatusJoin.predecessorPathCount, 146);
  assert.equal(exit.ownerStatusJoin.observedPathCount, 146);
  assert.equal(exit.ownerStatusJoin.unchangedPathCount, 145);
  assert.equal(exit.ownerStatusJoin.ownerApprovedChangedPathCount, 1);
  assert.equal(exit.ownerStatusJoin.unapprovedChangedPathCount, 0);
  assert.equal(exit.ownerStatusJoin.missingPathCount, 0);
  assert.equal(exit.ownerStatusJoin.additionalPathCount, 0);
  assert.equal(exit.independentApproval, 'NOT_CLAIMED_AND_NOT_WAIVED');
  assert.equal(exit.delegatedOwnerAcceptance.status, 'INTERNAL_IMPACT_DISPOSITION_ONLY_NOT_OWNER_ACCEPTANCE');
  assert.equal(exit.delegatedOwnerAcceptance.acceptedMaterialSourceSetFingerprint, null);
  assert.equal(exit.delegatedOwnerAcceptance.impactDispositionRecordId, currentCutImpact.recordId);
  assert.equal(exit.phaseExit.delegatedOwnerAcceptance, 'NOT_CLAIMED_IMPACT_DISPOSITION_ONLY');
  assert.equal(exit.phaseExit.sourceCurrentness, 'PASS');
});

test('PDP0 currentness classifies the exact sourceShaSet pin through its historical digest and the separate R2 chain', () => {
  const pin = {
    path: 'scripts/report-media-pdp-readiness.mjs',
    recordedDigest: 'sha256:6655e0344b7f4b03f6ca0b7e594a5448eed72ae5aeac198cef4bb1b28252028c',
    currentDigest: 'sha256:ca59f6c4e1313bd58387f91b41eb51fc1a10ac04b2db01faed30b9edcc9b2573',
    disposition: 'CHANGED',
  };
  assert.equal(classifyCurrentCutPdp0PinChange([pin], currentCutImpact)?.path, pin.path);
  assert.equal(classifyCurrentCutPdp0PinChange([{ ...pin, recordedDigest: 'sha256:f3482cf689e0be2d8dc9faf9ccc72a1b63a1dcaecd056efaa1759e6f3696a5e1' }], currentCutImpact), null);
  assert.equal(classifyCurrentCutPdp0PinChange([{ ...pin, currentDigest: 'sha256:' + 'f'.repeat(64) }], currentCutImpact), null);
});

test('PDP0 technical currentness records impact-only disposition without claiming owner acceptance or passing Discovery', () => {
  const disposition = buildMediaPdp0CurrentnessPhaseDisposition(true, true);
  assert.equal(disposition.currentSourceCurrentness, 'PASS');
  assert.equal(disposition.pdp0Exit, 'PASS_INTERNAL_IMPACT_DISPOSITION_ONLY');
  assert.equal(disposition.ownerAcceptance, 'NOT_OBTAINED');
  assert.equal(disposition.ownerAcceptanceClaim, 'NOT_CLAIMED');
  assert.equal(disposition.discoveryBarrier, 'FAIL_PDP1_PDP3_NOT_VALIDATED');
  assert.equal(disposition.build, 'NOT_ENTERED');
  assert.equal(disposition.pdpClosure, 'NOT_ENTERED');
  assert.equal(disposition.delivery, 'BLOCKED');
});

test('PDP0 technical currentness remains blocked without exact impact disposition and fails on stale sources', () => {
  const pendingOwner = buildMediaPdp0CurrentnessPhaseDisposition(true, false);
  assert.equal(pendingOwner.pdp0Exit, 'BLOCKED_PENDING_OWNER_ACCEPTANCE');
  assert.equal(pendingOwner.ownerAcceptance, 'NOT_OBTAINED');
  assert.equal(pendingOwner.ownerAcceptanceClaim, 'NOT_CLAIMED');
  assert.equal(pendingOwner.discoveryBarrier, 'FAIL_PDP0_OWNER_ACCEPTANCE_PENDING_AND_PDP1_PDP3_NOT_VALIDATED');
  const stale = buildMediaPdp0CurrentnessPhaseDisposition(false, true);
  assert.equal(stale.currentSourceCurrentness, 'FAIL');
  assert.equal(stale.pdp0Exit, 'FAIL_SOURCE_CURRENTNESS');
  assert.equal(stale.discoveryBarrier, 'FAIL_PDP0_SOURCE_CURRENTNESS_AND_PDP1_PDP3_NOT_VALIDATED');
});

test('the current-cut impact disposition rejects an unexpected PDP0 path digest', () => {
  const changed = currentCutImpactTechnical();
  const otherPath = Object.keys(changed.sourceContentDigests).find((sourcePath) => sourcePath !== 'scripts/report-media-pdp-readiness.mjs');
  changed.sourceContentDigests[otherPath] = `sha256:${'f'.repeat(64)}`;
  const exit = joinMediaPdp0PhaseExit({
    technicalCurrentness: changed,
    ownerAcceptance: currentCutImpact,
    historicalPdp0Exit: currentCutPdp0Predecessor,
    testOutcomes,
  });
  assert.equal(exit.phaseExit.status, 'FAIL');
  assert.ok(exit.delegatedOwnerAcceptance.blockers.includes(`PDP0_SOURCE_DIGEST_NOT_OWNER_REVIEWED:${otherPath}`));
});

test('the current-cut impact disposition rejects an incorrect reporter digest', () => {
  const changed = currentCutImpactTechnical();
  changed.sourceContentDigests['scripts/report-media-pdp-readiness.mjs'] = `sha256:${'f'.repeat(64)}`;
  const exit = joinMediaPdp0PhaseExit({
    technicalCurrentness: changed,
    ownerAcceptance: currentCutImpact,
    historicalPdp0Exit: currentCutPdp0Predecessor,
    testOutcomes,
  });
  assert.equal(exit.phaseExit.status, 'FAIL');
  assert.ok(exit.delegatedOwnerAcceptance.blockers.includes('PDP0_REPORTER_DIGEST_NOT_AUTHORIZED'));
});

test('the current-cut impact disposition rejects a changed authorized path', () => {
  const invalidImpact = structuredClone(currentCutImpact);
  invalidImpact.sourceDeltas.find((entry) => entry.path === 'scripts/report-media-pdp-readiness.mjs').path = 'scripts/other-readiness-script.mjs';
  const exit = joinMediaPdp0PhaseExit({
    technicalCurrentness: currentCutImpactTechnical(),
    ownerAcceptance: invalidImpact,
    historicalPdp0Exit: currentCutPdp0Predecessor,
    testOutcomes,
  });
  assert.equal(exit.phaseExit.status, 'FAIL');
  assert.ok(exit.delegatedOwnerAcceptance.blockers.includes('CURRENT_CUT_IMPACT_PATH_SET_INVALID'));
});

test('the current-cut impact disposition rejects changed authority attribution', () => {
  const invalidImpact = structuredClone(currentCutImpact);
  invalidImpact.authority.userAuthorization = 'NOT_AUTHORIZED';
  const exit = joinMediaPdp0PhaseExit({
    technicalCurrentness: currentCutImpactTechnical(),
    ownerAcceptance: invalidImpact,
    historicalPdp0Exit: currentCutPdp0Predecessor,
    testOutcomes,
  });
  assert.equal(exit.phaseExit.status, 'FAIL');
  assert.ok(exit.delegatedOwnerAcceptance.blockers.includes('CURRENT_CUT_IMPACT_AUTHORITY_INVALID'));
});

test('PDP-0 R10 phase exit joins exactly the authorized R8 test transition without claiming acceptance', () => {
  const currentDigests = { ...r8Exit.sourceCurrentness.sourceContentDigests,
    'tests/pdp-truth-domain.test.mjs': 'sha256:8ef1a6d5e11dc2e10ca32c3e6813fc8671c22a6c7f7038d48300d52f8feae578' };
  const technicalCurrentness = {
    ...r8Currentness,
    materialPathDenominator: { uniquePaths: 146, sharedPaths: 111, cellSpecificPaths: 35 },
    physicalCompositeConsumerCells: r8Currentness.physicalCompositeConsumerCells.map((cell) => ({ ...cell, sourceCurrentness: 'CURRENT', blockers: [] })),
    sourceContentDigests: currentDigests,
    historicalPdp0PinDriftClassifications: r8Currentness.historicalPdp0PinDriftClassifications,
    unclassifiedHistoricalPdp0PinChanges: [],
    externalOwnerContracts: { totalFiles: 30, digestMatches: 30, digestMismatches: [] },
    authority: { changedMeaningIds: [] },
    phaseDisposition: { historicalDefinitionStatus: 'DEV_COMPLETE', historicalOutstandingMeaningIds: [], currentSourceCurrentness: 'PASS', sourceCurrent: true },
  };
  const exit = joinMediaPdp0PhaseExit({
    technicalCurrentness,
    ownerAcceptance: r8SuccessorImpact,
    ownerAcceptancePath: r8SuccessorImpactPath,
    historicalPdp0Exit: r8Exit,
    testOutcomes,
    baselineSha: r8Exit.campaign.observedHead,
  });
  assert.equal(exit.phaseExit.status, 'PASS');
  assert.equal(exit.sourceCurrentness.status, 'PASS');
  assert.equal(exit.developmentStatus.status, 'DEV_COMPLETE');
  assert.deepEqual(exit.developmentStatus.outstandingMeaningIds, []);
  assert.equal(exit.ownerStatusJoin.predecessorExitRef, r8ExitPath);
  assert.equal(exit.ownerStatusJoin.predecessorCurrentnessRef, r8CurrentnessPath);
  assert.equal(exit.ownerStatusJoin.predecessorPathCount, 146);
  assert.equal(exit.ownerStatusJoin.unchangedPathCount, 145);
  assert.equal(exit.ownerStatusJoin.internallyDispositionedChangedPathCount, 1);
  assert.equal(exit.ownerStatusJoin.unreviewedChangedPathCount, 0);
  assert.equal(exit.delegatedOwnerAcceptance.status, 'INTERNAL_SUCCESSOR_IMPACT_DISPOSITION_ONLY_NOT_OWNER_ACCEPTANCE');
  assert.equal(exit.delegatedOwnerAcceptance.humanIndependentSignatureProvided, false);
  assert.equal(exit.phaseExit.delegatedOwnerAcceptance, 'NOT_CLAIMED_IMPACT_DISPOSITION_ONLY');
  assert.equal(exit.independentApproval, 'NOT_CLAIMED_AND_NOT_WAIVED');
  assert.equal(exit.lifecycleClosure, 'NOT_ENTERED');
  assert.equal(exit.delivery, 'BLOCKED');
});

const REVIEWED_PATHS = new Set([
  '.product-experience/artifact-identities.yaml',
  '.product-experience/source-manifest.yaml',
  '.product-experience/surface-registry.yaml',
  'apps/media-experience-explorer/specification-artifacts.json',
  'scripts/report-media-pdp-readiness.mjs',
]);
