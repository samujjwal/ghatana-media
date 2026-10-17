import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { projectHistoricalMediaTopology } from '../scripts/lib/media-historical-topology-projection.mjs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const matrix = read('docs/implementation/media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json');
const successorTopology = read('.product-experience/surfaces/media-physical-topology.v1.json');
const topology = projectHistoricalMediaTopology(successorTopology);
const ownerEvidence = read('docs/implementation/observations/media-discovery-delegated-owner-evidence-2026-10-13.json');
const pdp1Exit = read('docs/implementation/observations/media-discovery-pdp1-exit-2026-10-13-r3.json');
const pdp1CurrentCutExit = read('docs/implementation/observations/media-discovery-pdp1-exit-2026-10-15-current-cut-r30.json');
const pdp1FailedAttempt = read('docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r3.json');
const pdp2Exit = read('docs/implementation/observations/media-discovery-pdp2-exit-2026-10-14-current-cut-r17.json');
const pdp2FailedAttempt = read('docs/implementation/observations/media-discovery-pdp2-exit-2026-10-14-current-cut-r5.json');
const pdp3Progress = matrix.currentCut.pdp3ImplementationProgress;
const historicalPdp3R5 = read('docs/implementation/observations/media-discovery-pdp3-mdc30-implementation-progress-2026-10-14-r5.json');
const phases = ['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3'];
const requireTools = createRequire(path.resolve(root, '../ghatana-tools/package.json'));
const parseYaml = requireTools('yaml').parse;
const surfaceRegistry = parseYaml(fs.readFileSync(path.join(root, '.product-experience/surface-registry.yaml'), 'utf8'));

test('Discovery execution plan retains physical/composite/consumer denominators without double counting', () => {
  assert.equal(topology.manifestCandidates.length, 26);
  assert.equal(topology.compositions.filter(c => c.kind === 'SEMANTIC_COMPOSITION').length, 6);
  assert.equal(topology.compositions.filter(c => c.kind === 'REPOSITORY_ROOT').length, 1);
  assert.equal(topology.consumerCrosswalk.length, 17);
  const ids = [
    ...topology.manifestCandidates.map(x => x.surfaceId),
    ...topology.compositions.map(x => x.surfaceId),
    ...topology.consumerCrosswalk.map(x => x.surfaceId),
  ];
  assert.equal(new Set(ids).size, 50);
  assert.equal(matrix.cells.length, ids.length * phases.length);
  assert.equal(new Set(matrix.cells.map(x => x.cellId)).size, 200);
  assert.deepEqual(new Set(matrix.cells.map(x => x.surfaceId)), new Set(ids));
  for (const id of ids) {
    assert.deepEqual(matrix.cells.filter(x => x.surfaceId === id).map(x => x.phase), phases);
  }
});

test('Discovery plan retains predecessor exits and marks PDP-3 R6 source-gap capture pending', () => {
  const observation = read('docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r12.json');
  const p0Exit = read('docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r12.json');
  const p0R15Observation = read('docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r15.json');
  const p0R15Exit = read('docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r15.json');
  const p1Exit = pdp1CurrentCutExit;
  const p2CurrentExit = pdp2Exit;
  const p0R13Attempt = read('docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r13.json');
  const p0R14Attempt = read('docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r14.json');
  const p2Impact = read('docs/implementation/observations/media-discovery-pdp2-r16-projection-impact-2026-10-14-r1.json');
  assert.equal(matrix.baseline.pdp0MaterialSetFingerprint, ownerEvidence.source.materialSetFingerprint);
  assert.equal(matrix.currentCut.repositoryHead, '161634035ed5e570372703809d8518dbf88751f6');
  assert.equal(matrix.currentCut.phaseExit, 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r15.json');
  assert.equal(matrix.currentCut.phaseExitRecordId, 'MEDIA-PDP0-EXIT-c2befa2e1a95');
  assert.equal(matrix.currentCut.materialSourceSetFingerprint, 'sha256:eff717cf2537a285cd7a1c1a72b44a75766a0a7e6eef6ea97edbc2befa2e1a95');
  assert.equal(p0Exit.phaseExit.status, 'PASS');
  assert.equal(p0R15Exit.phaseExit.status, 'PASS');
  assert.equal(p0R15Observation.observationId, 'MEDIA-PDP0-CURRENTNESS-2026-10-14-CURRENT-CUT-R15');
  assert.equal(p0R15Observation.phaseDisposition.pdp0Exit, 'BLOCKED_PENDING_OWNER_ACCEPTANCE');
  assert.equal(p0R15Observation.phaseDisposition.currentSourceCurrentness, 'PASS');
  assert.equal(p0R15Observation.phaseDisposition.ownerAcceptanceClaim, 'NOT_CLAIMED');
  assert.equal(p0R15Observation.materialSourceSetFingerprint, matrix.currentCut.materialSourceSetFingerprint);
  assert.equal(p0R15Observation.physicalCompositeConsumerCells.length, 50);
  assert.ok(p0R15Observation.physicalCompositeConsumerCells.every(cell => cell.sourceCurrentness === 'CURRENT'));
  assert.equal(p0R15Observation.lifecycleSourceCurrentness.continuity, 'CONTINUOUS');
  assert.equal(p0R15Observation.lifecycleSourceCurrentness.zeroWorkEligibleAtCapture, true);
  assert.equal(p0R15Observation.materialPathDenominator.uniquePaths, 146);
  assert.equal(matrix.currentCut.latestPdp0CurrentnessAttempt, 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r15.json');
  assert.equal(matrix.currentCut.pdp1LatestAttemptRef, 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-15-current-cut-r30.json');
  assert.equal(matrix.currentCut.pdp1LatestAttemptStatus, 'PASS');
  assert.deepEqual(matrix.currentCut.pdp1LatestAttemptBlockers, []);
  assert.deepEqual(matrix.currentCut.latestPdp0CurrentnessSummary, {
    totalCells:50,current:50,unknown:0,externalContractDigestsMatched:30,externalContractDigestCount:30,
    lifecycleContinuity:'CONTINUOUS',zeroWorkEligibleAtCapture:true,
    r2Ref:'docs/implementation/observations/media-discovery-pdp0-r12-successor-impact-2026-10-14-r2.json',r2Applied:true,
    r3Ref:'docs/implementation/observations/media-discovery-pdp0-r12-successor-impact-2026-10-14-r3.json',r3Applied:true,
    ownerAcceptance:'NOT_CLAIMED_IMPACT_DISPOSITION_ONLY',
  });
  assert.equal(observation.observationId, 'MEDIA-PDP0-CURRENTNESS-2026-10-14-CURRENT-CUT-R12');
  assert.equal(observation.physicalCompositeConsumerCells.length, 50);
  assert.ok(observation.physicalCompositeConsumerCells.every(cell => cell.sourceCurrentness === 'CURRENT'));
  const p0Cells = matrix.cells.filter(cell => cell.phase === 'PDP-0');
  assert.equal(p0Cells.length, 50);
  assert.equal(p0R13Attempt.phaseDisposition.pdp0Exit, 'FAIL_SOURCE_CURRENTNESS');
  assert.equal(p0R14Attempt.phaseDisposition.pdp0Exit, 'FAIL_SOURCE_CURRENTNESS');
  assert.equal(p0R14Attempt.physicalCompositeConsumerCells.length, 50);
  assert.ok(p0R14Attempt.physicalCompositeConsumerCells.every(cell => cell.sourceCurrentness === 'UNKNOWN'));
  assert.equal(p0R14Attempt.lifecycleSourceCurrentness.continuity, 'UNKNOWN');
  assert.equal(p0R14Attempt.lifecycleSourceCurrentness.zeroWorkEligibleAtCapture, false);
  assert.deepEqual(p0R14Attempt.lifecycleSourceCurrentness.blockers, ['UNEXPECTED_REPOSITORY_MEMBERSHIP_CHANGE']);
  assert.equal(matrix.currentCut.latestPdp0CurrentnessAttempt, 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r15.json');
  assert.equal(matrix.currentCut.latestPdp0MaterialSourceSetFingerprint, 'sha256:eff717cf2537a285cd7a1c1a72b44a75766a0a7e6eef6ea97edbc2befa2e1a95');
  assert.equal(matrix.currentCut.externalLifecyclePackageJsonDisposition, 'R3_INTERNAL_NO_PDP0_MEANING_DISPOSITION; exact Lifecycle package.json script addition; external owner acceptance and closure NOT_CLAIMED');
  assert.deepEqual(matrix.currentCut.latestPdp0CurrentnessSummary, {
    totalCells:50,current:50,unknown:0,externalContractDigestsMatched:30,externalContractDigestCount:30,
    lifecycleContinuity:'CONTINUOUS',zeroWorkEligibleAtCapture:true,
    r2Ref:'docs/implementation/observations/media-discovery-pdp0-r12-successor-impact-2026-10-14-r2.json',r2Applied:true,
    r3Ref:'docs/implementation/observations/media-discovery-pdp0-r12-successor-impact-2026-10-14-r3.json',r3Applied:true,
    ownerAcceptance:'NOT_CLAIMED_IMPACT_DISPOSITION_ONLY',
  });
  assert.ok(p0Cells.every(cell => cell.currentnessAtReview === 'PRESENT_CUT_R15_PASS_SOURCE_CURRENTNESS; 50_OF_50; 146_MATERIAL_PATHS'
    && cell.status === 'PRESENT_CUT_R15_TECHNICAL_CURRENTNESS_AND_PHASE_EXIT_PASS; INTERNAL_IMPACT_DISPOSITION_ONLY; OWNER_ACCEPTANCE_NOT_CLAIMED'
    && cell.historicalPhaseExitPublished === true && cell.currentPhaseExitPublished === true
    && cell.currentPhaseExitRef === matrix.currentCut.phaseExit && cell.remainingTaskIds.length === 0));

  assert.equal(p1Exit.phaseExit.status, 'PASS');
  assert.equal(p1Exit.observationId, 'MEDIA-PDP1-CURRENTNESS-2026-10-15-CURRENT-CUT-R30');
  assert.equal(p1Exit.predecessor.exitRef, 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r15.json');
  assert.equal(p1Exit.sourceCurrentness.materialSourceSetFingerprint, 'sha256:34f90853f894e4e244e5e0c76643ebd94f6f2455c6a012c4dd4073bb5d62a4f4');
  assert.equal(p1Exit.phaseExit.developmentStatus, 'DEV_COMPLETE');
  assert.deepEqual(p1Exit.developmentStatus.outstandingMeaningIds, []);
  assert.equal(p1Exit.phaseExit.exactCutOwnerAcceptance, 'NOT_RECORDED');
  assert.equal(matrix.currentCut.pdp1PhaseExit, 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-15-current-cut-r30.json');
  const p1Cells = matrix.cells.filter(cell => cell.phase === 'PDP-1');
  assert.equal(p1Cells.length, 50);
  assert.ok(p1Cells.every(cell => cell.currentnessAtReview === 'R30_PASS_50_OF_50_CELLS_329_PATHS_ZERO_BLOCKERS_DEV_COMPLETE_EXACT_CUT_OWNER_ACCEPTANCE_NOT_RECORDED'
    && cell.latestTechnicalSourceCurrentness === 'R30_SOURCE_CURRENTNESS_PASS_50_OF_50_CELLS_329_PATHS; ZERO_BLOCKERS'
    && cell.historicalPhaseExitPublished === true && cell.currentPhaseExitPublished === true
    && cell.remainingTaskIds.length === 0));

  assert.equal(p2CurrentExit.observationId, 'MEDIA-PDP2-CURRENTNESS-2026-10-14-CURRENT-CUT-R17');
  assert.equal(p2CurrentExit.currentPhaseExit.status, 'PASS');
  assert.equal(p2CurrentExit.currentPhaseExit.developmentStatus, 'DEV_COMPLETE');
  assert.equal(p2CurrentExit.predecessor.exitRef, 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r27.json');
  assert.equal(p2CurrentExit.predecessor.exitDigest, 'sha256:2f57ace69d389dde7cbe7c5032c5b88d6a6b068c07177d33694fd968aa6c451e');
  assert.equal(p2CurrentExit.predecessor.r27SourceMapBridge.r25PathCount, 329);
  assert.equal(p2CurrentExit.predecessor.r27SourceMapBridge.r27PathCount, 329);
  assert.deepEqual(p2CurrentExit.predecessor.r27SourceMapBridge.changedPaths, []);
  assert.equal(p2CurrentExit.sourceCurrentness.materialSourceSetFingerprint, 'sha256:a4c43f03c44a5f1844fba5039f146473f7390c02b3a06ce582c095fc5d9e74bd');
  assert.equal(p2CurrentExit.sourceCurrentness.denominators.materialPaths, 405);
  assert.equal(p2CurrentExit.sourceCurrentness.denominators.totalCells, 50);
  assert.equal(p2Impact.sourceDeltas[0].path, '.product-experience/pdp-2-design-interface-system/generated/experience-language.candidate.json');
  assert.equal(p2Impact.sourceDeltas[0].predecessorSha256, 'sha256:612760df546543582d5b6a867e3086bc6f1b21c5ba745367fbe3dd88b27f0979');
  assert.equal(p2Impact.sourceDeltas[0].observedSha256, 'sha256:e7c3f762eb95d3ea6e5111fe24266406010de05abb20f05b6e310f2b9a80bd4c');
  assert.equal(matrix.currentCut.pdp2R16ProjectionImpactRef, 'docs/implementation/observations/media-discovery-pdp2-r16-projection-impact-2026-10-14-r1.json');
  const p2Cells = matrix.cells.filter(cell => cell.phase === 'PDP-2');
  assert.equal(p2Cells.length, 50);
  assert.ok(p2Cells.every(cell => cell.currentnessAtReview === 'R19_PASS_CURRENT_AGAINST_PDP1_R30; 50_OF_50_CELLS_405_PATHS; DEV_COMPLETE_ZERO_OUTSTANDING_MEANING; EXACT_CUT_OWNER_ACCEPTANCE_NOT_RECORDED'
    && cell.latestTechnicalSourceCurrentness === 'R19_PASS_CURRENT_AGAINST_PDP1_R30; 50_OF_50_CELLS_405_PATHS; EXACT_CUT_OWNER_ACCEPTANCE_NOT_RECORDED'
    && cell.historicalPhaseExitPublished === true && cell.currentPhaseExitPublished === true
    && cell.currentPhaseExitRef === matrix.currentCut.pdp2PhaseExit
    && cell.remainingTaskIds.length === 0));

  const p3Cells = matrix.cells.filter(cell => cell.phase === 'PDP-3');
  assert.equal(p3Cells.length, 50);
  assert.ok(p3Cells.every(cell => cell.currentnessAtReview === 'NOT_ESTABLISHED_R6_CAPTURE_PENDING_SOURCE_GAPS_REMAIN'
    && cell.currentPhaseExitPublished === false && cell.status === 'PDP3_NOT_ESTABLISHED_MDC30_ACTIVE_R6_CAPTURE_PENDING_SOURCE_GAP_RESOLUTION'
    && cell.preR6HistoricalRemainingTaskIds.length > 0
    && cell.currentRemainingTaskIds === null
    && cell.currentRemainingTaskStatus === 'UNKNOWN_AFTER_PDP3_SOURCE_EDITS; R6_REVALIDATION_REQUIRED'
    && !Object.hasOwn(cell, 'remainingTaskIds')
    && !Object.hasOwn(cell, 'latestProgressObservationRef')));
  assert.equal(pdp3Progress.pendingCaptureTarget, 'docs/implementation/observations/media-discovery-pdp3-mdc30-implementation-progress-2026-10-14-r6.json');
  assert.equal(pdp3Progress.sourceGapAuditStatus, 'PENDING_R6_CAPTURE');
  assert.equal(pdp3Progress.currentnessStatus, 'NOT_ESTABLISHED');
  assert.equal(pdp3Progress.pdp3PhaseExitPublished, false);
  assert.equal(Object.hasOwn(matrix, 'latestPdp3ProgressObservationRef'), false);
  assert.equal(Object.hasOwn(matrix, 'latestPdp3AuditReviewedHead'), false);
  assert.equal(Object.hasOwn(matrix, 'latestPdp3ReviewedMaterialInputFingerprint'), false);
  assert.deepEqual(pdp3Progress.preR6HistoricalLogicalCount, {
    totalEdges: 61, sourceBound: 37, incomplete: 24, incompleteGroups: 13, consequentialSteps: 14,
    sourceDefinitionBoundConsequentialSteps: 5, partialConsequentialSteps: 7, gapConsequentialSteps: 2,
    status: 'R5_RECEIPT_HISTORICAL_CONFLICTS_WITH_PRIOR_PLAN_SUMMARY; R6_NOT_CAPTURED',
    observationRef: 'docs/implementation/observations/media-discovery-pdp3-mdc30-implementation-progress-2026-10-14-r5.json',
    priorPlanReportedCounts: {
      sourceBound: 43, incomplete: 18, incompleteGroups: 10,
      status: 'CONFLICTING_HISTORICAL_SUMMARY; NOT_LIVE',
    },
  });
  assert.equal(pdp3Progress.currentLogicalCount, null);
  assert.equal(Object.hasOwn(pdp3Progress, 'logicalCount'), false);
  assert.equal(pdp3Progress.historicalR5ProgressRef, 'docs/implementation/observations/media-discovery-pdp3-mdc30-implementation-progress-2026-10-14-r5.json');
  assert.equal(pdp3Progress.historicalR4ProgressRef, 'docs/implementation/observations/media-discovery-pdp3-mdc30-implementation-progress-2026-10-14-r4.json');
  assert.equal(Object.hasOwn(matrix.currentCut, 'nextLegalAction'), false);
  assert.equal(Object.hasOwn(matrix.currentCut, 'latestMdc30LogicalCount'), false);
  assert.equal(Object.hasOwn(matrix.currentCut, 'latestNextLegalAction'), false);
  assert.equal(Object.hasOwn(matrix.currentCut, 'pdp3Mdc30Observation'), false);
  assert.equal(Object.hasOwn(matrix.currentCut, 'pdp3Mdc30ExecutionRef'), false);
  assert.ok(p3Cells.every(cell => !Object.hasOwn(cell, 'latestImplementationProgressRef')));
  assert.ok(matrix.cells.every(cell => !Object.hasOwn(cell, 'latestNextLegalAction')));
  assert.ok(p3Cells.every(cell => !Object.hasOwn(cell, 'latestMdc30LogicalCount')
    && !Object.hasOwn(cell, 'currentCutReviewedHead')
    && !Object.hasOwn(cell, 'currentCutIncompleteChannelTaskIds')
    && !Object.hasOwn(cell, 'currentCutPotentiallyAffectedByS06')
    && !Object.hasOwn(cell, 'currentCutOpenTaskIds')));
  assert.equal(matrix.ownerDecisionOverlay.pdp3IncompleteEdges, 32);
  assert.equal(matrix.ownerDecisionOverlay.pdp3IncompleteConsequentialSteps, 1);
  assert.match(matrix.ownerDecisionOverlay.countScope, /Historical delegated-owner review cut/u);
  assert.match(matrix.ownerDecisionOverlay.sourceNotYetUpdatedScope, /does not establish the current R6 source-gap counts/u);
  assert.equal(Object.hasOwn(matrix.ownerDecisionOverlay, 'currentTechnicalAuditCounts'), false);
  assert.equal(Object.hasOwn(matrix.ownerDecisionOverlay, 'currentTechnicalAuditRef'), false);
  assert.equal(matrix.currentCut.noCurrentPdp0Pdp1Pdp2ExitAtReviewedHead, false);
  assert.deepEqual(matrix.status.presentCutRecapturePhaseOrder, []);
  assert.deepEqual(matrix.currentCut.presentCutRecapturePhaseOrder, []);
  assert.equal(matrix.currentCut.pdp1CurrentnessStatus, 'R30_PASS_SOURCE_CURRENTNESS_50_OF_50_CELLS_329_PATHS; DEV_COMPLETE_ZERO_OUTSTANDING_MEANING_IDS; EXACT_CUT_OWNER_ACCEPTANCE_NOT_RECORDED; EXPECTED_STRICT_ADMISSION_FINDING');
  assert.equal(matrix.currentCut.pdp2CurrentnessStatus, 'R19_PASS_50_OF_50_405_PATHS_AGAINST_PDP1_R30');
  assert.equal(matrix.currentCut.pdp2R16ProjectionImpactRef, 'docs/implementation/observations/media-discovery-pdp2-r16-projection-impact-2026-10-14-r1.json');
  assert.equal(matrix.currentCut.pdp3CurrentnessStatus, 'NOT_ESTABLISHED_R6_CAPTURE_PENDING_MDC30_SOURCE_GAPS_REMAIN');
  assert.equal(matrix.status.pdp0, 'R15_TECHNICAL_PASS_50_OF_50_146_PATHS; INTERNAL_IMPACT_DISPOSITION_ONLY; OWNER_ACCEPTANCE_NOT_CLAIMED');
  assert.equal(matrix.status.pdp1, 'R30_PASS_50_OF_50_329_PATHS_DEV_COMPLETE_ZERO_OUTSTANDING_MEANING; EXACT_CUT_OWNER_ACCEPTANCE_NOT_RECORDED; PASS_WITH_EXPECTED_STRICT_ADMISSION_FINDING');
  assert.equal(matrix.status.pdp2, 'R19_PASS_50_OF_50_405_PATHS_AGAINST_PDP1_R30; DEV_COMPLETE_ZERO_OUTSTANDING_MEANING; EXACT_CUT_OWNER_ACCEPTANCE_NOT_RECORDED');
  assert.equal(matrix.status.pdp3, 'ACTIVE_MDC30_SOURCE_GAP_RESOLUTION; R6_NOT_CAPTURED; LIVE_RAW_EDGE_REGISTRY_43_OF_61_SOURCE_BOUND_DEFINITION_ONLY_AND_18_INCOMPLETE_ACROSS_10_JOURNEYS; RAW_FIELDS_NOT_R6_VALIDATION_OR_TASK_COMPLETION; 14_STEP_SOURCE_AUDIT_COMPLETE_WITH_DISPOSITIONS_OPEN; J21_EXCLUDED_AND_BLOCKED; ALL_TRANSPORTS_UNBOUND; RUNTIME_NOT_ADMITTED');
  assert.equal(matrix.status.discovery, 'FAIL_PDP3_DEFINITION_COMPLETION_PENDING');
  assert.equal(matrix.status.build, 'NOT_ENTERED');
  assert.equal(matrix.status.nativePdpClosure, 'NOT_ENTERED');
  assert.equal(matrix.status.delivery, 'BLOCKED');
  assert.match(matrix.nextLegalAction, /current PDP-0 R15, PDP-1 R30, and PDP-2 R19/u);
  assert.doesNotMatch(matrix.nextLegalAction, /through its owner|external owner acceptance is claimed/u);
  assert.match(matrix.nextLegalAction, /live edge registry contains 43 source-bound definition-only edges and 18 incomplete across 10 journeys/u);
  assert.match(matrix.nextLegalAction, /J21 rights-approval exclusion and blocked status/u);
  const pdp0Cells = matrix.cells.filter(cell => cell.phase === 'PDP-0');
  assert.equal(pdp0Cells.length, 50);
  assert.ok(pdp0Cells.every(cell => /exact successor material fingerprint and generated current manifest/u.test(cell.acceptWhen)));
  assert.ok(pdp0Cells.every(cell => /exact source-bound R12-successor impact record/u.test(cell.acceptWhen)));
  assert.ok(pdp0Cells.every(cell => !/146-path|four-path owner-approved/u.test(cell.acceptWhen)));
});

test('historical R5 fingerprint is internally reproducible and distinct from pending R6', () => {
  const inputs = historicalPdp3R5.sourceDigests.reviewedMaterialInputs;
  const fingerprintInput = [...inputs]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(({ path: inputPath, sha256 }) => `${inputPath}\t${sha256.replace(/^sha256:/u, '')}\n`)
    .join('');
  const fingerprint = `sha256:${crypto.createHash('sha256').update(fingerprintInput).digest('hex')}`;
  assert.match(historicalPdp3R5.campaign.reviewedMaterialInputFingerprintAlgorithm, /SHA-256 over UTF-8 lines sorted by path/u);
  assert.equal(historicalPdp3R5.campaign.reviewedMaterialInputFingerprint, fingerprint);
  assert.equal(new Set(inputs.map((input) => input.path)).size, inputs.length);
  assert.ok(inputs.some((input) => input.path === 'tests/media-discovery-current-cut-owner-plan.test.mjs'));
});

test('Every phase cell has executable prescriptive links, owner, scope and no manufactured authoring backlog', () => {
  const topoById = new Map([
    ...topology.manifestCandidates,
    ...topology.compositions,
    ...topology.consumerCrosswalk,
  ].map(s => [s.surfaceId, s]));
  for (const c of matrix.cells) {
    assert.ok(c.owner && c.phaseTaskIds?.length > 0 && c.inspectWhere?.length > 0);
    assert.ok(c.what && c.how && c.acceptWhen && c.nextLegalAction);
    assert.equal(c.historicalDefinitionState, 'DEV_COMPLETE');
    assert.equal(c.historicalOutstandingMeaningIds, 0);
    const t = topoById.get(c.surfaceId);
    assert.ok(t);
    const actual = t.phaseApplicability?.[c.phase]?.disposition;
    const registry = c.surfaceKind === 'CONSUMER_BINDING'
      ? surfaceRegistry.surfaces.find(surface => surface.surfaceId === c.surfaceId)
      : undefined;
    const expected = c.surfaceKind !== 'CONSUMER_BINDING'
      ? actual
      : t.bindingState === 'ARCHIVED'
        ? 'NOT_APPLICABLE_ARCHIVED'
        : c.phase === 'PDP-3' && !registry?.applicablePdpArtifacts?.includes('PDP-3')
          ? 'UNKNOWN_OWNER_DECISION_PENDING'
          : 'APPLICABLE_CONSUMER_BINDING';
    assert.equal(c.phaseApplicabilityDisposition, expected);
    assert.deepEqual(c.phaseTaskIds, matrix.phaseTaskMap[c.phase]);
  }
});

test('MDC-30 records exact transition and state-binding gaps without promoting proposals', () => {
  const observation = read('docs/implementation/observations/media-discovery-pdp3-mdc30-currentness-2026-10-13-r1.json');
  const stepStateFinding = observation.findings.find(f => f.id === 'MDC30-STEP-STATE-BINDING-REVIEW');
  const records = parseYaml(fs.readFileSync(path.join(root, '.product-experience/pdp-3-product-experience/journey-transition-edge-bindings.yaml'), 'utf8')).records;
  const exact = records.filter(r => r.journeyActionDisposition?.startsWith('EXACT')).map(r => r.id);
  const unboundByDisposition = {};
  for (const record of records.filter(r => !r.journeyActionDisposition?.startsWith('EXACT'))) {
    (unboundByDisposition[record.transitionInvocationDisposition] ??= []).push(record.id);
  }

  assert.equal(stepStateFinding.severity, 'BLOCKER');
  assert.deepEqual(stepStateFinding.evidence.exactPdp3JourneyActionOperationBindingIds, exact);
  assert.equal(exact.length, 1);
  assert.deepEqual(stepStateFinding.evidence.unboundTransitionRecordIdsByDisposition, unboundByDisposition);
  assert.equal(Object.values(unboundByDisposition).flat().length, 54);
  assert.deepEqual(Object.fromEntries(Object.entries(unboundByDisposition).map(([k, v]) => [k, v.length])), {
    'P1_EVENT_TRIGGER_PENDING; NO_EXACT_PUBLIC_OPERATION_OR_JOURNEY_ACTION': 44,
    'AUTHORITY_SOURCE_EVENT_REQUIRED; PUBLIC_OPERATION_AND_TRANSPORT_EXPLICITLY_UNBOUND': 6,
    'P1_OPERATION_FAMILY_PROPOSAL_ONLY; NO_EXACT_ACTION_INVOCATION': 3,
    'P1_EXPLICITLY_NO_VERIFICATION_OPERATION_IDENTITY; NO_ROUTE_OR_RUNTIME_ADMISSION': 1,
  });
  const stateAudit = stepStateFinding.evidence.purposeBindingClassification;
  assert.equal(stateAudit.localOrPassiveNoDomainStateChange + stateAudit.readOnlyStateProjection
    + stateAudit.consequentialCommandOrWorkflow + stateAudit.externalSharedIdentityHandoffObservationWithoutMediaMutation, 118);
  assert.equal(stateAudit.consequentialCommandOrWorkflow, stateAudit.consequentialStepRefs.length);
  assert.equal(stateAudit.acceptedMappingStatus.startsWith('NOT_ESTABLISHED'), true);
});

test('PDP-3 consumer cells bind registry owners and contracts while preserving unresolved applicability', () => {
  const topologyById = new Map(topology.consumerCrosswalk.map((surface, index) => [surface.surfaceId, { ...surface, index }]));
  const matrixById = new Map(matrix.cells.filter(cell => cell.phase === 'PDP-3' && cell.surfaceKind === 'CONSUMER_BINDING')
    .map(cell => [cell.surfaceId, cell]));
  assert.equal(matrixById.size, 17);
  for (const [registryIndex, registered] of surfaceRegistry.surfaces.entries()) {
    const crosswalk = topologyById.get(registered.surfaceId);
    const cell = matrixById.get(registered.surfaceId);
    if (!crosswalk || !cell) continue;
    const expectedDisposition = crosswalk.bindingState === 'ARCHIVED'
      ? 'NOT_APPLICABLE_ARCHIVED'
      : registered.applicablePdpArtifacts.includes('PDP-3')
        ? 'APPLICABLE_CONSUMER_BINDING'
        : 'UNKNOWN_OWNER_DECISION_PENDING';
    assert.deepEqual(cell.owner, registered.owners, `${registered.surfaceId} owner trace`);
    assert.deepEqual(cell.consumedPhysicalRefs, crosswalk.physicalRefs ?? [], `${registered.surfaceId} physical crosswalk`);
    assert.deepEqual(cell.phaseApplicabilityAuthorityRefs, [
      `.product-experience/surface-registry.yaml#/surfaces/${registryIndex}`,
      `.product-experience/surfaces/media-physical-topology.v1.json#/consumerCrosswalk/${crosswalk.index}`,
    ]);
    assert.ok(cell.parentSourceAuthorityRefs.includes(registered.contractAuthority));
    assert.ok(cell.inspectWhere.includes(registered.contractAuthority));
    assert.equal(cell.phaseApplicabilityDisposition, expectedDisposition);
    assert.match(cell.nextLegalAction, /ACTIVE: Continue MDC-30 source-gap resolution/u);
    assert.match(cell.nextLegalAction, /capture R6 only after source criteria pass/u);
  }
  const integrations = matrixById.get('media.surface.integrations');
  assert.match(integrations.phaseApplicabilityRationale, /omits PDP-3/u);
  assert.match(integrations.phaseApplicabilityRationale, /journeys reference/u);
  assert.equal(matrixById.get('media.surface.desktop-archive').phaseApplicabilityDisposition, 'NOT_APPLICABLE_ARCHIVED');
});

test('PDP-3 physical and composite cells cite their exact topology applicability records', () => {
  const topologyById = new Map();
  topology.manifestCandidates.forEach((surface, index) => topologyById.set(surface.surfaceId, {
    surface,
    authorityRef: `.product-experience/surfaces/media-physical-topology.v1.json#/manifestCandidates/${index}/phaseApplicability/PDP-3`,
  }));
  topology.compositions.forEach((surface, index) => topologyById.set(surface.surfaceId, {
    surface,
    authorityRef: `.product-experience/surfaces/media-physical-topology.v1.json#/compositions/${index}/phaseApplicability/PDP-3`,
  }));

  const cells = matrix.cells.filter(cell => cell.phase === 'PDP-3' && cell.surfaceKind !== 'CONSUMER_BINDING');
  assert.equal(cells.length, 33);
  for (const cell of cells) {
    const source = topologyById.get(cell.surfaceId);
    assert.ok(source, `missing topology source for ${cell.cellId}`);
    const isComposition = topology.compositions.some(row => row.surfaceId === cell.surfaceId);
    assert.equal(cell.surfaceKind, isComposition
      ? source.surface.kind === 'REPOSITORY_ROOT' ? 'REPOSITORY_ROOT' : 'SEMANTIC_COMPOSITION'
      : 'PHYSICAL_CANDIDATE');
    assert.equal(cell.phaseApplicabilityDisposition, source.surface.phaseApplicability['PDP-3'].disposition);
    assert.equal(cell.phaseApplicabilityRationale, source.surface.phaseApplicability['PDP-3'].rationale);
    assert.deepEqual(cell.phaseApplicabilityAuthorityRefs, [source.authorityRef]);
  }
});

test('PDP-1 composition and consumer cells trace exact canonical authority, owners, and topology crosswalks', () => {
  const registryText = fs.readFileSync(path.join(root, '.product-experience/surface-registry.yaml'), 'utf8');
  const registryRecords = new Map([...registryText.matchAll(/^  - surfaceId: (.+)\n([\s\S]*?)(?=^  - surfaceId:|^channelSurfaceProposals:|$(?![\s\S]))/gm)]
    .map((match, index) => {
      const ownerMatch = match[2].match(/^    owners: \[(.*?)\]$/m);
      const applicabilityMatch = match[2].match(/^    applicablePdpArtifacts: \[(.*?)\]$/m);
      return [match[1], {
        index,
        owners: ownerMatch ? ownerMatch[1].split(',').map(owner => owner.trim()) : [],
        applicablePdpArtifacts: applicabilityMatch ? applicabilityMatch[1].split(',').map(phase => phase.trim()) : [],
      }];
    }));
  const cells = new Map(matrix.cells.filter(c => c.phase === 'PDP-1').map(c => [c.surfaceId, c]));

  const compositions = topology.compositions.filter(c => c.kind === 'SEMANTIC_COMPOSITION');
  assert.equal(compositions.length, 6);
  for (const composition of compositions) {
    const cell = cells.get(composition.surfaceId);
    const applicability = composition.phaseApplicability['PDP-1'];
    assert.equal(cell.surfaceKind, 'SEMANTIC_COMPOSITION');
    assert.equal(cell.owner, composition.canonicalOwner);
    assert.equal(cell.phaseApplicabilityDisposition, applicability.disposition);
    assert.deepEqual(cell.parentSourceAuthorityRefs, [applicability.authorityRef, applicability.objectAuthorityRef]);
    assert.ok(cell.inspectWhere.includes(applicability.authorityRef));
    assert.ok(cell.inspectWhere.includes(applicability.objectAuthorityRef));
    assert.equal(cell.currentnessAtReview, 'R30_PASS_50_OF_50_CELLS_329_PATHS_ZERO_BLOCKERS_DEV_COMPLETE_EXACT_CUT_OWNER_ACCEPTANCE_NOT_RECORDED');
    assert.equal(cell.historicalPhaseExitPublished, true);
    assert.equal(cell.currentPhaseExitPublished, true);
    assert.equal(cell.latestTechnicalSourceCurrentness, 'R30_SOURCE_CURRENTNESS_PASS_50_OF_50_CELLS_329_PATHS; ZERO_BLOCKERS');
  }

  const rootSurface = topology.compositions.find(c => c.kind === 'REPOSITORY_ROOT');
  const rootCell = cells.get(rootSurface.surfaceId);
  assert.equal(rootCell.phaseApplicabilityDisposition, rootSurface.phaseApplicability['PDP-1'].disposition);
  assert.deepEqual(rootCell.parentSourceAuthorityRefs, [rootSurface.phaseApplicability['PDP-1'].authorityRef]);
  assert.deepEqual(rootSurface.phaseApplicability['PDP-1'].domainObjectIds, []);

  assert.equal(topology.consumerCrosswalk.length, 17);
  for (const [crosswalkIndex, crosswalk] of topology.consumerCrosswalk.entries()) {
    const { owners, applicablePdpArtifacts, index: surfaceIndex } = registryRecords.get(crosswalk.surfaceId);
    const cell = cells.get(crosswalk.surfaceId);
    const archived = crosswalk.bindingState === 'ARCHIVED';
    assert.equal(cell.surfaceKind, 'CONSUMER_BINDING');
    assert.deepEqual(cell.owner, owners, crosswalk.surfaceId);
    assert.equal(cell.ownerAuthorityRef, `.product-experience/surface-registry.yaml#/surfaces/${surfaceIndex}`);
    assert.deepEqual(cell.consumerCrosswalkRefs, crosswalk.physicalRefs, crosswalk.surfaceId);
    assert.equal(cell.consumerCrosswalkAuthorityRef, `.product-experience/surfaces/media-physical-topology.v1.json#/consumerCrosswalk/${crosswalkIndex}`);
    assert.equal(cell.phaseApplicabilityDisposition, archived ? 'NOT_APPLICABLE_ARCHIVED' : 'APPLICABLE_CONSUMER_BINDING');
    assert.equal(applicablePdpArtifacts.includes('PDP-1'), !archived, crosswalk.surfaceId);
    assert.equal(cell.currentnessAtReview, 'R30_PASS_50_OF_50_CELLS_329_PATHS_ZERO_BLOCKERS_DEV_COMPLETE_EXACT_CUT_OWNER_ACCEPTANCE_NOT_RECORDED');
    assert.equal(cell.historicalPhaseExitPublished, true);
    assert.equal(cell.currentPhaseExitPublished, true);
    assert.equal(cell.currentPhaseExitRef, matrix.currentCut.pdp1PhaseExit);
    assert.equal(cell.status, 'PDP1_R30_PASS; DEV_COMPLETE; 50_OF_50_CELLS_CURRENT; 329_PATHS; ZERO_BLOCKERS; EXACT_CUT_OWNER_ACCEPTANCE_NOT_RECORDED; PASS_WITH_EXPECTED_STRICT_ADMISSION_FINDING');
  }
});

test('PDP-2 cells bind exact surface owners and applicability to topology and consumer registry', () => {
  const registry = parseYaml(fs.readFileSync(path.join(root, '.product-experience/surface-registry.yaml'), 'utf8'));
  const registryById = new Map(registry.surfaces.map((surface, index) => [surface.surfaceId, {
    ...surface,
    authorityRef: `.product-experience/surface-registry.yaml#/surfaces/${index}`,
  }]));
  const physicalById = new Map(topology.manifestCandidates.map((surface, index) => [surface.surfaceId, {
    ...surface,
    authorityRef: `.product-experience/surfaces/media-physical-topology.v1.json#/manifestCandidates/${index}`,
  }]));
  const compositionById = new Map(topology.compositions.map((surface, index) => [surface.surfaceId, {
    ...surface,
    authorityRef: `.product-experience/surfaces/media-physical-topology.v1.json#/compositions/${index}`,
  }]));
  const crosswalkById = new Map(topology.consumerCrosswalk.map((surface, index) => [surface.surfaceId, {
    ...surface,
    topologyRef: `.product-experience/surfaces/media-physical-topology.v1.json#/consumerCrosswalk/${index}`,
  }]));
  const cells = matrix.cells.filter(cell => cell.phase === 'PDP-2');
  assert.equal(cells.length, 50);
  for (const cell of cells) {
    const physical = physicalById.get(cell.surfaceId);
    const composition = compositionById.get(cell.surfaceId);
    const crosswalk = crosswalkById.get(cell.surfaceId);
    if (physical) {
      const applicability = physical.phaseApplicability['PDP-2'];
      assert.equal(cell.surfaceKind, 'PHYSICAL_CANDIDATE');
      assert.equal(cell.owner, physical.owner);
      assert.equal(cell.ownerAuthorityRef, physical.authorityRef);
      assert.equal(cell.phaseApplicabilityDisposition, applicability.disposition);
      assert.equal(cell.phaseApplicabilityRationale, applicability.rationale);
      assert.equal(cell.surfaceDispositionRationale, physical.dispositionRationale);
      assert.deepEqual(cell.consumerCrosswalkRefs, physical.consumerSurfaceRefs ?? []);
      assert.deepEqual(cell.linkedConsumerApplicability.map(link => link.surfaceId), physical.consumerSurfaceRefs ?? []);
      for (const ref of applicability.authorityRefs ?? []) assert.ok(cell.parentSourceAuthorityRefs.includes(ref));
      if (applicability.disposition === 'NOT_APPLICABLE') {
        assert.ok(applicability.rationale.trim());
        assert.ok(cell.phaseApplicabilityAuthorityRefs.length > 0);
        if (physical.disposition === 'PHYSICAL') {
          assert.ok(physical.dispositionRationale.trim());
          assert.ok(cell.linkedConsumerApplicability.length > 0);
          assert.ok(cell.linkedConsumerApplicability.every(link => link.disposition === 'APPLICABLE_CONSUMER_BINDING' && link.authorityRef && link.rationale));
        }
      }
    } else if (composition) {
      const applicability = composition.phaseApplicability['PDP-2'];
      assert.equal(cell.surfaceKind, composition.kind === 'REPOSITORY_ROOT' ? 'REPOSITORY_ROOT' : 'SEMANTIC_COMPOSITION');
      assert.equal(cell.owner, composition.canonicalOwner);
      assert.equal(cell.ownerAuthorityRef, composition.authorityRef);
      assert.equal(cell.phaseApplicabilityDisposition, applicability.disposition);
      assert.equal(cell.phaseApplicabilityRationale, applicability.rationale);
      for (const ref of applicability.authorityRefs ?? []) assert.ok(cell.parentSourceAuthorityRefs.includes(ref));
    } else {
      assert.ok(crosswalk, `missing consumer crosswalk ${cell.surfaceId}`);
      const registered = registryById.get(cell.surfaceId);
      assert.ok(registered, `missing consumer registry ${cell.surfaceId}`);
      const archived = crosswalk.bindingState === 'ARCHIVED';
      assert.equal(cell.surfaceKind, 'CONSUMER_BINDING');
      assert.deepEqual(cell.owner, registered.owners);
      assert.equal(cell.ownerAuthorityRef, registered.authorityRef);
      assert.deepEqual(cell.phaseApplicabilityAuthorityRefs, [registered.authorityRef, crosswalk.topologyRef]);
      assert.deepEqual(cell.linkedPhysicalSurfaces.map(link => link.surfaceId).sort(), [...(crosswalk.physicalRefs ?? [])].sort());
      assert.equal(cell.phaseApplicabilityDisposition, archived ? 'NOT_APPLICABLE_ARCHIVED' : 'APPLICABLE_CONSUMER_BINDING');
      assert.equal(registered.applicablePdpArtifacts.includes('PDP-2'), !archived);
      assert.ok(cell.phaseApplicabilityRationale.trim());
    }
    assert.equal(cell.currentnessAtReview, 'R19_PASS_CURRENT_AGAINST_PDP1_R30; 50_OF_50_CELLS_405_PATHS; DEV_COMPLETE_ZERO_OUTSTANDING_MEANING; EXACT_CUT_OWNER_ACCEPTANCE_NOT_RECORDED');
    assert.equal(cell.latestTechnicalSourceCurrentness, 'R19_PASS_CURRENT_AGAINST_PDP1_R30; 50_OF_50_CELLS_405_PATHS; EXACT_CUT_OWNER_ACCEPTANCE_NOT_RECORDED');
    assert.equal(cell.status, 'R19_CURRENT_PASS_AGAINST_PDP1_R30; DEV_COMPLETE_ZERO_OUTSTANDING_MEANING; EXACT_CUT_OWNER_ACCEPTANCE_NOT_RECORDED');
    assert.equal(cell.historicalPhaseExitPublished, true);
    assert.equal(cell.currentPhaseExitPublished, true);
    assert.equal(cell.currentPhaseExitRef, matrix.currentCut.pdp2PhaseExit);
  }
});

test('machine owner acceptance is an exact source-bound input, never a phase-exit or independent review', () => {
  const approval = read('docs/implementation/observations/media-discovery-delegated-owner-acceptance-pdp0-2026-10-13.json');
  const observation = read('docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-13.json');
  assert.equal(approval.subject.phase, 'PDP-0');
  assert.equal(approval.subject.materialSourceSetFingerprint, observation.materialSourceSetFingerprint);
  assert.equal(approval.subject.surfaceScope.totalPhaseCells, 50);
  assert.equal(approval.subject.observedTechnicalCurrentCells, 50);
  assert.equal(approval.subject.outstandingMeaningIds.length, 0);
  assert.equal(approval.decision.internalDevelopmentDefinitionAcceptance, 'APPROVED_FOR_REUSE');
  assert.equal(approval.decision.actualPhaseExitStatus, 'NOT_PUBLISHED');
  assert.equal(approval.decision.canAdvanceToPdp1, false);
  assert.equal(approval.authority.humanIndependentSignatureProvided, false);
  assert.equal(approval.authority.qualifiedExternalSpecialistSignoffProvided, false);
});

test('the historical 50-cell source observation is not silently promoted to new 55-surface Recorder/Studio scope', () => {
  const historic = new Set(matrix.cells.map((cell) => cell.surfaceId));
  const current = new Set([
    ...successorTopology.manifestCandidates,
    ...successorTopology.compositions,
    ...successorTopology.consumerCrosswalk,
  ].map((node) => node.surfaceId));
  assert.equal(historic.size, 50);
  assert.equal(current.size, 55);
  assert.ok([...historic].every((id) => current.has(id)));
  assert.equal([...current].filter((id) => !historic.has(id)).length, 5);
  assert.equal(matrix.cells.length, 200);
  assert.ok(matrix.cells.every((cell) => cell.historicalDefinitionState === 'DEV_COMPLETE'));
});
