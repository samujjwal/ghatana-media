import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (p) => JSON.parse(fs.readFileSync(path.join(root,p),"utf8"));
const policy = load("docs/implementation/observations/media-discovery-current-cut-owner-directions-2026-10-13-r2.json");
const impact = load("docs/implementation/observations/media-discovery-predecessor-currentness-impact-2026-10-13-r1.json");
const mdc = load("docs/implementation/observations/media-discovery-pdp3-mdc30-execution-2026-10-13-r1.json");
const matrix = load("docs/implementation/media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json");
const work = load("docs/implementation/media-discovery-reconciliation-worklist-2026-10-13.json");
const r5Progress = load("docs/implementation/observations/media-discovery-pdp3-mdc30-implementation-progress-2026-10-14-r5.json");
const pdp2ImpactR1 = load("docs/implementation/observations/media-discovery-pdp2-additional-source-impact-2026-10-14-r1.json");
const pdp2R16Impact = load("docs/implementation/observations/media-discovery-pdp2-r16-projection-impact-2026-10-14-r1.json");
const pdp0R13Attempt = load('docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r13.json');
const pdp0R14Attempt = load('docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r14.json');
const pdp1OlderR13 = load('docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r13.json');
const pdp2OlderR13 = load('docs/implementation/observations/media-discovery-pdp2-exit-2026-10-14-current-cut-r13.json');
const executionPlan = fs.readFileSync(path.join(root, 'docs/implementation/MEDIA-DISCOVERY-REMAINING-CURRENT-CUT-EXECUTION-2026-10-13.md'), 'utf8');
const predecessorExits = [
 load("docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r15.json"),
 load("docs/implementation/observations/media-discovery-pdp1-exit-2026-10-15-current-cut-r30.json"),
 load("docs/implementation/observations/media-discovery-pdp2-exit-2026-10-14-current-cut-r17.json"),
];

test("PDP-0 R15, PDP-1 R30, and PDP-2 R19 currentness remain distinct from historical attempts", () => {
 assert.equal(policy.predecessorImpactReviews.length,3);
 assert.deepEqual(policy.predecessorImpactReviews.map(p => p.phase),["PDP-0","PDP-1","PDP-2"]);
 for(const r of policy.predecessorImpactReviews) {
   const actual = impact.phaseExitAudits.find(p=>p.phase===r.phase);
   assert.ok(actual);
   assert.equal(r.sourceChanges.length,4);
   assert.equal(r.historicalRequiredPathCount,actual.sourcePathCount);
   assert.deepEqual(new Set(r.sourceChanges.map(c=>c.path)),new Set(actual.changedPaths.map(c=>c.path)));
   assert.equal(r.actualTechnicalCurrentnessAtThisCut,"NOT_REESTABLISHED");
   assert.ok(r.sourceChanges.every(c=>c.meaningIdsChangedAtReviewedCut.length===0));
 }
 assert.deepEqual([matrix.currentCut.phaseExit,matrix.currentCut.pdp1PhaseExit,matrix.currentCut.pdp2PhaseExit], [
   "docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r15.json",
   "docs/implementation/observations/media-discovery-pdp1-exit-2026-10-15-current-cut-r30.json",
   "docs/implementation/observations/media-discovery-pdp2-exit-2026-10-15-current-cut-r19.json",
 ]);
 for(const [index,key] of [[0,"pdp0"],[1,"pdp1"],[2,"pdp2"]]) {
   const exit = predecessorExits[index].currentPhaseExit ?? predecessorExits[index].phaseExit;
   assert.ok(exit,`${key} receipt has a phase-exit disposition`);
   assert.equal(exit.status,"PASS");
   assert.equal(predecessorExits[index].sourceCurrentness.status,"PASS");
   assert.equal(predecessorExits[index].sourceCurrentness.cells.length,50);
 }
 assert.equal(matrix.currentCut.pdp1MaterialSourceSetFingerprint,"sha256:34f90853f894e4e244e5e0c76643ebd94f6f2455c6a012c4dd4073bb5d62a4f4");
 assert.equal(matrix.currentCut.pdp2MaterialSourceSetFingerprint,"sha256:5bc6fd43212699311a07aa3e3b3a46bbf944a6cf09b9fbbc6e5a98b82ed96e6b");
 assert.equal(predecessorExits[2].predecessor.r27SourceMapBridge.r25PathCount,329);
 assert.deepEqual(predecessorExits[2].predecessor.r27SourceMapBridge.changedPaths,[]);
 assert.equal(matrix.currentCut.pdp2R16ProjectionImpactRef,"docs/implementation/observations/media-discovery-pdp2-r16-projection-impact-2026-10-14-r1.json");
 assert.equal(pdp2R16Impact.sourceDeltas.length,1);
 assert.equal(pdp2R16Impact.sourceDeltas[0].predecessorSha256,"sha256:612760df546543582d5b6a867e3086bc6f1b21c5ba745367fbe3dd88b27f0979");
 assert.equal(pdp2R16Impact.sourceDeltas[0].observedSha256,"sha256:e7c3f762eb95d3ea6e5111fe24266406010de05abb20f05b6e310f2b9a80bd4c");
 assert.equal(matrix.status.pdp0,"R15_TECHNICAL_PASS_50_OF_50_146_PATHS; INTERNAL_IMPACT_DISPOSITION_ONLY; OWNER_ACCEPTANCE_NOT_CLAIMED");
 assert.equal(matrix.status.pdp1,"R30_PASS_50_OF_50_329_PATHS_DEV_COMPLETE_ZERO_OUTSTANDING_MEANING; EXACT_CUT_OWNER_ACCEPTANCE_NOT_RECORDED; PASS_WITH_EXPECTED_STRICT_ADMISSION_FINDING");
 assert.equal(matrix.status.pdp2,"R19_PASS_50_OF_50_405_PATHS_AGAINST_PDP1_R30; DEV_COMPLETE_ZERO_OUTSTANDING_MEANING; EXACT_CUT_OWNER_ACCEPTANCE_NOT_RECORDED");
 assert.equal(matrix.status.pdp3,"ACTIVE_MDC30_SOURCE_GAP_RESOLUTION; R6_NOT_CAPTURED; LIVE_RAW_EDGE_REGISTRY_43_OF_61_SOURCE_BOUND_DEFINITION_ONLY_AND_18_INCOMPLETE_ACROSS_10_JOURNEYS; RAW_FIELDS_NOT_R6_VALIDATION_OR_TASK_COMPLETION; 14_STEP_SOURCE_AUDIT_COMPLETE_WITH_DISPOSITIONS_OPEN; J21_EXCLUDED_AND_BLOCKED; ALL_TRANSPORTS_UNBOUND; RUNTIME_NOT_ADMITTED");
 assert.equal(matrix.status.discovery,"FAIL_PDP3_DEFINITION_COMPLETION_PENDING");
 assert.equal(work.campaign.activePhase,"PDP-3");
 assert.equal(work.campaign.activePhaseTaskId,"MDC-30");
 assert.equal(work.campaign.currentPhaseOwnerDecisionRef,".product-experience/reviews/2026-10-13-discovery-current-cut-delegated-owner-review.md");
 assert.equal(work.campaign.currentPhaseOwnerPacketRef,"docs/implementation/observations/media-discovery-current-cut-owner-directions-2026-10-13-r2.json");
 assert.equal(work.campaign.currentPhaseOwnerChoiceStatus,"PDP2_R19_TECHNICAL_PASS_DEV_COMPLETE; EXACT_CUT_OWNER_ACCEPTANCE_NOT_RECORDED; PDP3_MDC30_ACTIVE_PENDING_R6");
 assert.equal(work.campaign.currentPhaseChoiceStatus,"PDP0_R15_PDP1_R30_PDP2_R19_TECHNICAL_CURRENTNESS_PASS; PDP3_MDC30_ACTIVE; R6_NOT_CAPTURED_PENDING_SOURCE_GAP_RESOLUTION");
 assert.equal(work.campaign.pendingCurrentPhaseReviewTargetStatus,"PDP0_R15_PASS; PDP1_R30_PASS; PDP2_R19_PASS_50_OF_50_405_PATHS_FINGERPRINT_sha256:5bc6fd43212699311a07aa3e3b3a46bbf944a6cf09b9fbbc6e5a98b82ed96e6b; PDP3_NOT_ESTABLISHED; MDC30_ACTIVE_R6_PENDING");
 assert.equal(work.pdp0PresentCutAttemptRef,"docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r15.json");
 assert.deepEqual(work.pdp0PresentCutAttemptBlockers,[]);
 assert.deepEqual(work.pdp0PresentCutAttemptCurrentness,{current:50,unknown:0,total:50,externalContractDigestsMatched:30,externalContractDigestCount:30,lifecycleContinuity:"CONTINUOUS",zeroWorkEligibleAtCapture:true,blockers:[],materialPaths:146});
 assert.equal(pdp0R13Attempt.phaseDisposition.pdp0Exit,"FAIL_SOURCE_CURRENTNESS");
 assert.equal(pdp0R13Attempt.phaseDisposition.currentSourceCurrentness,"FAIL");
 assert.equal(pdp0R14Attempt.observationId,"MEDIA-PDP0-CURRENTNESS-2026-10-14-CURRENT-CUT-R14");
 assert.equal(pdp0R14Attempt.phaseDisposition.pdp0Exit,"FAIL_SOURCE_CURRENTNESS");
 assert.equal(pdp0R14Attempt.materialSourceSetFingerprint,"sha256:eff717cf2537a285cd7a1c1a72b44a75766a0a7e6eef6ea97edbc2befa2e1a95");
 assert.deepEqual(pdp0R14Attempt.physicalCompositeConsumerCells.reduce((counts,cell)=>{
   counts[cell.sourceCurrentness]=(counts[cell.sourceCurrentness]??0)+1; return counts;
 },{}),{UNKNOWN:50});
 assert.equal(pdp0R14Attempt.externalOwnerContracts.repositories.reduce((n,repo)=>n+repo.files.length,0),30);
 assert.ok(pdp0R14Attempt.externalOwnerContracts.repositories.flatMap(repo=>repo.files).every(file=>file.digestMatches));
 assert.equal(pdp0R14Attempt.lifecycleSourceCurrentness.continuity,"UNKNOWN");
 assert.equal(pdp0R14Attempt.lifecycleSourceCurrentness.zeroWorkEligibleAtCapture,false);
 assert.deepEqual(pdp0R14Attempt.lifecycleSourceCurrentness.blockers,["UNEXPECTED_REPOSITORY_MEMBERSHIP_CHANGE"]);
 assert.equal(pdp1OlderR13.phaseExit.status,"PASS");
 assert.equal(pdp1OlderR13.predecessor.phase,"PDP-0");
 assert.equal(pdp1OlderR13.predecessor.exitRef,"docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r5.json");
 assert.equal((pdp2OlderR13.currentPhaseExit ?? pdp2OlderR13.phaseExit).status,"PASS");
 assert.equal(pdp2OlderR13.predecessor.phase,"PDP-1");
 assert.equal(pdp2OlderR13.predecessor.exitRef,"docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r22.json");
 assert.match(executionPlan,/R13\/R14 PDP-0 and PDP-1 R28\/R29 remain immutable historical attempts/u);
 assert.match(executionPlan,/preserve R18 and earlier receipts as immutable history/u);
 assert.match(executionPlan,/R5's immutable 37\/61 and 24\/13 counts and the prior 43\/61 and 18\/10 summary are historical records/u);
 assert.match(executionPlan,/Reconcile each current disposition with canonical sources, retaining explicit exclusions and blockers/u);
 assert.match(executionPlan,/Acceptance boundary:\*\* R17 and the older R13 receipts are historical technical PASS records for their captured source sets; they do not imply exact-cut owner acceptance, independent signoff, native closure, runtime admission, Delivery, or release/u);
 assert.deepEqual(work.campaign.predecessorCurrentnessRecheck.r13ChangedMaterialPaths,[
   ".product-experience/artifact-identities.yaml",
   ".product-experience/gaps.yaml",
   ".product-experience/source-manifest.yaml",
   "apps/media-experience-explorer/specification-artifacts.json",
 ]);
 assert.equal(work.campaign.predecessorCurrentnessRecheck.externalPinDisposition,"R3_INTERNAL_NO_PDP0_MEANING_DISPOSITION_FOR_FOUR_EXACT_LOCAL_DELTAS_AND_ONE_EXACT_LIFECYCLE_PACKAGE_TRANSITION; OWNER_ACCEPTANCE_NOT_CLAIMED");
 assert.deepEqual(work.campaign.completedPredecessorRecheckTaskIds,["RC-P0-01","RC-P1-01","RC-P2-01"]);
 assert.deepEqual(work.campaign.requiredPredecessorRecheckTaskIds,[]);
 assert.equal(work.campaign.predecessorCurrentnessRecheck.status,"PDP0_R15_PASS; PDP1_R30_PASS_DEV_COMPLETE; PDP2_R19_PASS_DEV_COMPLETE_ZERO_BLOCKERS; PDP3_MDC30_ACTIVE; R6_PENDING");
 assert.equal(work.campaign.predecessorCurrentnessRecheck.latestAttemptRef,"docs/implementation/observations/media-discovery-pdp2-exit-2026-10-15-current-cut-r19.json");
 assert.equal(work.campaign.predecessorCurrentnessRecheck.latestAttemptStatus,"PASS");
 assert.deepEqual(work.campaign.predecessorCurrentnessRecheck.latestAttemptBlockers,[]);
 assert.deepEqual(work.campaign.predecessorCurrentnessRecheck.latestAttemptCellCurrentness,{total:50,current:50,unknown:0,materialPaths:405,blockers:[]});
 assert.deepEqual(work.campaign.predecessorCurrentnessRecheck.requiredPhaseOrder,[]);
 assert.equal(work.presentCutRecaptureStatus,"PDP0_R15_PASS_PDP1_R30_PASS_PDP2_R19_PASS; PDP3_MDC30_SOURCE_GAP_RESOLUTION_ACTIVE_R6_PENDING");
 assert.deepEqual(work.presentCutRecaptureRequiredPhaseOrder,[]);
 assert.equal(work.campaign.presentCutRecaptureStatus,"PDP0_R15_PASS_PDP1_R30_PASS_PDP2_R19_PASS; PDP3_MDC30_SOURCE_GAP_RESOLUTION_ACTIVE_R6_PENDING");
 assert.deepEqual(work.campaign.predecessorCurrentnessRecheck.postR13GapDenominatorCorrection,{
   path:".product-experience/gaps.yaml",
   status:"R2_CONSUMED_BY_PDP0_R15_PASS",
   recordRef:"docs/implementation/observations/media-discovery-pdp0-r12-successor-impact-2026-10-14-r2.json",
   scope:"GAP-12 source/Explorer denominator correction only; preserve immutable R13, R1 and R2",
   liveDenominators:{portableManifestRecords:356,explorerSourceDerivedRecords:357},
 });
 assert.equal(work.campaign.predecessorCurrentnessRecheck.previouslyCompletedRecheckTaskIdsApplyTo,"their recorded captured source sets only");
 assert.equal(Object.hasOwn(work.campaign,"pendingCurrentPhaseReviewTarget"),false);
 assert.equal(Object.hasOwn(work.campaign,"currentPhaseReviewRef"),false);
 assert.equal(work.campaign.pdp3AuditReviewedHead,null);
 assert.equal(work.campaign.currentPhaseSourceSetFingerprint,null);
 assert.equal(work.campaign.predecessorExitsObservedHead,"161634035ed5e570372703809d8518dbf88751f6");
for(const obsoleteAlias of ["reviewedCurrentHead","lastMdc30ExecutionRef","latestImplementationProgressRef","currentPhaseStatusObservationRef","pdp3R4CountsCurrent","pdp3R4HistoricalCounts"]){
   assert.equal(Object.hasOwn(work.campaign,obsoleteAlias),false,`${obsoleteAlias} is not a second current pointer`);
 }
 assert.deepEqual(work.campaign.preR6SourceRegistryCounts,{totalEdges:61,sourceBound:37,incomplete:24,incompleteGroups:13,consequentialSteps:14,sourceDefinitionBoundConsequentialSteps:5,partialConsequentialSteps:7,gapConsequentialSteps:2,status:"R5_RECEIPT_HISTORICAL_CONFLICTS_WITH_PRIOR_PLAN_SUMMARY; R6_NOT_CAPTURED",observationRef:"docs/implementation/observations/media-discovery-pdp3-mdc30-implementation-progress-2026-10-14-r5.json",priorPlanReportedCounts:{sourceBound:43,incomplete:18,incompleteGroups:10,status:"CONFLICTING_HISTORICAL_SUMMARY; NOT_LIVE"}});
 assert.match(work.campaign.nextLegalAction,/PDP-3 MDC-30/u);
 assert.match(work.campaign.nextLegalAction,/J21 rights-approval edge excluded and blocked/u);
 assert.match(work.campaign.nextLegalAction,/Discovery remains FAIL while definition tasks remain/u);
 assert.equal(work.campaign.currentPhaseExitPublished,false);
 assert.equal(work.campaign.currentPhaseExitPhase,"PDP-3");
 const taskIds=work.tasks.map(task=>task.id);
 assert.equal(taskIds.length,21);
 assert.equal(new Set(taskIds).size,taskIds.length,"each worklist task has one authoritative row");
 const taskIdSet=new Set(taskIds);
 for(const task of work.tasks) for(const dependency of task.dependsOn??[]) assert.ok(taskIdSet.has(dependency),`${task.id} dependency ${dependency} has a worklist row`);
 assert.equal(work.tasks.find(task=>task.id==="RC-P0-01").status,"COMPLETED_CURRENTNESS_AND_PHASE_EXIT_PASS");
 assert.equal(work.tasks.find(task=>task.id==="RC-P1-01").status,"COMPLETED_CURRENTNESS_AND_PHASE_EXIT_PASS");
 assert.equal(work.tasks.find(task=>task.id==="RC-P2-01").status,"COMPLETED_CURRENTNESS_PASS");
 for(const taskId of ["RC-P0-01","RC-P1-01","RC-P2-01"]) assert.ok(work.campaign.completedTaskIds.includes(taskId));
 assert.ok(taskIds.indexOf("RC-P0-01")<taskIds.indexOf("RC-P1-01")&&taskIds.indexOf("RC-P1-01")<taskIds.indexOf("RC-P2-01")&&taskIds.indexOf("RC-P2-01")<taskIds.indexOf("MDC-30"));
 assert.equal(work.campaign.currentPhaseSourceSetFingerprint,null);
 assert.equal(work.campaign.currentPhasePredecessorSourceSetFingerprint,"sha256:5bc6fd43212699311a07aa3e3b3a46bbf944a6cf09b9fbbc6e5a98b82ed96e6b");
 assert.deepEqual([...work.campaign.preR6HistoricalBlockerIds].sort(),[
   "media.pdp3.channel-binding.j09.product-integration.v1",
   "media.pdp3.channel-binding.j09.web.v1",
   "media.pdp3.channel-binding.j05.web.v1",
   "media.pdp3.channel-binding.j05.grpc-api.v1",
   "media.pdp3.channel-binding.j05.sdk.v1",
   "media.pdp3.channel-binding.j08.web.v1",
   "media.pdp3.channel-binding.j10.web.v1",
   "media.pdp3.channel-binding.j13.web.v1",
   "media.pdp3.channel-binding.j14.web.v1",
   "media.pdp3.channel-binding.j14.product-integration.v1",
   "media.pdp3.channel-binding.j19.web.v1",
   "media.pdp3.channel-binding.j20.web.v1",
   "media.pdp3.channel-binding.j20.cli.v1",
   "media.pdp3.channel-binding.j21.web.v1",
   "media.pdp3.channel-binding.j21.product-integration.v1",
   "media.pdp3.channel-binding.j23.cli.v1",
   "media.pdp3.channel-binding.j23.web.v1",
   "media.pdp3.channel-binding.j24.cli.v1",
   "media.pdp3.channel-binding.j24.http-api.v1",
   "media.pdp3.channel-binding.j26.web.v1",
   "media.pdp3.channel-binding.j26.http-api.v1",
   "media.pdp3.channel-binding.j26.product-integration.v1",
   "media.pdp3.channel-binding.j28.web.v1",
   "media.pdp3.channel-binding.j28.product-integration.v1",
 ].sort());
 assert.equal(work.campaign.currentPhaseBlockerIds,null);
 assert.equal(work.campaign.currentPhaseBlockerSnapshotStatus,"UNKNOWN_AFTER_PDP3_SOURCE_EDITS; R6_CAPTURE_REQUIRED");
 assert.deepEqual(work.campaign.userDirectedBlockedEdgeIds,["media.pdp3.channel-binding.j21.web.v1","media.pdp3.channel-binding.j21.product-integration.v1"]);
 const mdc30Task=work.tasks.find(t=>t.id==="MDC-30");
 assert.equal(mdc30Task.status,"ACTIVE_PENDING_MDC30_SOURCE_GAP_RESOLUTION_AND_R6");
 assert.equal(mdc30Task.executionEligibility,"ELIGIBLE_FOR_PDP3_SOURCE_GAP_REVIEW_AFTER_PDP0_R15_PDP1_R30_PDP2_R19_TECHNICAL_PASSES");
 assert.equal(mdc30Task.pendingCurrentPhaseReviewTargetStatus,"ACTIVE_PDP3_MDC30_SOURCE_GAP_REVIEW; R6_PENDING");
 assert.match(mdc30Task.nextLegalAction,/PDP-2 R19 is current against exact PDP-1 R30/u);
 assert.match(mdc30Task.nextLegalAction,/J21 rights approval excluded and blocked/u);
 assert.deepEqual(mdc30Task.preR6HistoricalEffectiveSubtaskIds,["MDC30-C-05","MDC30-C-08","MDC30-C-09","MDC30-C-10","MDC30-C-13","MDC30-C-14","MDC30-C-19","MDC30-C-20","MDC30-C-21","MDC30-C-23","MDC30-C-24","MDC30-C-26","MDC30-C-28","MDC30-S-01","MDC30-S-03","MDC30-S-04","MDC30-S-05","MDC30-S-06","MDC30-S-07","MDC30-S-12","MDC30-S-13","MDC30-S-14"]);
 assert.equal(mdc30Task.currentEffectiveSubtaskIds,null);
 assert.equal(mdc30Task.currentEffectiveSubtaskStatus,"UNKNOWN_AFTER_PDP3_SOURCE_EDITS; R6_CAPTURE_REQUIRED");
 const v01Task=work.tasks.find(t=>t.id==="MDC30-V-01");
 assert.equal(v01Task.status,"BLOCKED_UNTIL_MDC30_SOURCE_GAPS_AND_R6_PASS");
 assert.deepEqual(v01Task.dependsOn,["MDC-30","RC-P2-01"]);
 assert.ok(taskIds.indexOf("MDC-30")<taskIds.indexOf("MDC30-V-01")&&taskIds.indexOf("MDC30-V-01")<taskIds.indexOf("MDC-31"));
 assert.equal(mdc30Task.preR6SourceRegistryCounts.sourceBound,37);
 assert.equal(mdc30Task.preR6SourceRegistryCounts.incomplete,24);
 assert.equal(mdc30Task.subtaskIds.includes("MDC30-V-01"),false,"verification remains one standalone gated task");
 assert.equal(mdc30Task.lastCapturedProgressRef,"docs/implementation/observations/media-discovery-pdp3-mdc30-implementation-progress-2026-10-14-r5.json");
 assert.equal(mdc30Task.pendingCurrentPhaseReviewTarget,"docs/implementation/observations/media-discovery-pdp3-currentness-2026-10-15-r6.json");
 assert.equal(pdp2ImpactR1.sourceDeltas.length,3);
 assert.equal(pdp2ImpactR1.ownerAcceptance,"NOT_CLAIMED");
 assert.equal(pdp2ImpactR1.independentReview,"NOT_CLAIMED");
 assert.equal(pdp2ImpactR1.lifecycleClosure,"NOT_ENTERED");
 assert.deepEqual(work.campaign.remainingDiscoveryTaskIds,["MDC-30","MDC30-V-01","MDC-31","MDC-32","MDC-40","MDC-41"]);
 assert.equal(work.campaign.currentPhaseExitPublished,false);
 assert.equal(work.campaign.currentPhaseExitPhase,"PDP-3");
 assert.equal(work.campaign.currentPhaseSourceSetFingerprint,null);
 assert.equal(work.campaign.currentPhasePredecessorSourceSetFingerprint,"sha256:5bc6fd43212699311a07aa3e3b3a46bbf944a6cf09b9fbbc6e5a98b82ed96e6b");
 assert.equal(work.campaign.lastPredecessorImpactDispositionRef,"docs/implementation/observations/media-discovery-pdp2-r17-to-r30-source-impact-2026-10-15-r1.json");
 assert.equal(work.campaign.lastPredecessorImpactDispositionStatus,"PDP2_R17_TO_R30_INTERNAL_SOURCE_IMPACT_R1_CONSUMED_BY_R19; PDP2_R19_CURRENTNESS_RECAPTURE_PASS");
 assert.equal(work.campaign.pdp1LatestAttemptRef,"docs/implementation/observations/media-discovery-pdp1-exit-2026-10-15-current-cut-r30.json");
 assert.equal(work.campaign.pdp1LatestAttemptStatus,"PASS");
 assert.deepEqual(work.campaign.pdp1LatestAttemptBlockers,[]);
 assert.equal(matrix.currentCut.latestPhaseCurrentnessStatus,"PDP0_R15_PASS; PDP1_R30_PASS_50_OF_50_329_PATHS_DEV_COMPLETE_ZERO_OUTSTANDING_MEANING; PDP2_R19_PASS_50_OF_50_405_PATHS_AGAINST_PDP1_R30_DEV_COMPLETE_ZERO_OUTSTANDING_MEANING; EXACT_CUT_OWNER_ACCEPTANCE_NOT_RECORDED; PDP3_MDC30_ACTIVE_R6_NOT_CAPTURED");
 assert.equal(work.sourceCurrentnessEvidenceScope,"PDP0_R15_PASS; PDP1_R30_PASS_AGAINST_PDP0_R15; PDP2_R19_PASS_AGAINST_PDP1_R30; PDP3_MDC30_SOURCE_GAP_WORK_ACTIVE_R6_NOT_CAPTURED");
 assert.equal(work.campaign.sourceCurrentnessEvidenceScope,"PDP0_R15_TECHNICAL_PASS; PDP1_R30_TECHNICAL_PASS_AGAINST_PDP0_R15; PDP2_R19_TECHNICAL_PASS_AGAINST_PDP1_R30; PDP3_MDC30_SOURCE_GAP_WORK_ACTIVE_R6_NOT_CAPTURED");
 assert.equal(work.currentPdp0MaterialFingerprintCaptured,"sha256:eff717cf2537a285cd7a1c1a72b44a75766a0a7e6eef6ea97edbc2befa2e1a95");
 assert.equal(work.source.ownerReviewBaselinePdp0MaterialFingerprint,"sha256:1a121cf988ba4a34f6b603b1f230fd0494160a3c6142c064d8d5cc2a6aa45f94");
 assert.equal(work.source.ownerReviewBaselinePdp1MaterialFingerprint,"sha256:2c982c15803a00a22a873d9874e1d00de89b1e80addc97ae984bffc578bef3aa");
 assert.equal(work.pdp2HistoricalMaterialFingerprint,"sha256:a4c43f03c44a5f1844fba5039f146473f7390c02b3a06ce582c095fc5d9e74bd");
 assert.equal(work.pdp2HistoricalReceiptDigest,"sha256:e08981102312364aad0ebe4282680e20b6d5fcf2db4e70e41a43880b2712d64d");
});

test("historical owner counts remain distinct from pending current R6 source-gap capture", () => {
 const src = mdc.journeyChannelDefinition;
 assert.equal(policy.remainingChannelTasks.length,14);
 assert.deepEqual(new Set(policy.remainingChannelTasks.map(c=>c.id)),new Set(src.remainingChannelTaskIds));
 assert.equal(policy.remainingChannelTasks.reduce((n,c)=>n+c.remainingEdgeCount,0),32);
 for(const r of policy.remainingChannelTasks){
   const actual=src.remainingEdgesByTask.find(x=>x.taskId===r.id);
   assert.ok(actual);
   assert.deepEqual(r.exactlyUnresolvedChannelRefs,actual.channels);
   assert.ok(r.where.length>=4 && r.how.includes("For EACH named channel"));
   assert.equal(r.status,"UNRESOLVED_TECHNICAL_DEFINITION; MEDIA_DESIGN_CHOICE_RECORDED");
 }
 assert.equal(policy.decidedPolicy.nonAdmittedTransport.includes("61_EXPLICIT_UNBOUND"),true);
 assert.equal(src.channelTransportEquivalenceUnboundEdges,61);
 assert.equal(policy.stageGates.discovery,"FAIL");
 assert.equal(matrix.currentCut.pdp3ImplementationProgress.sourceGapAuditStatus,"PENDING_R6_CAPTURE");
 assert.equal(matrix.currentCut.pdp3ImplementationProgress.pendingCaptureTarget,"docs/implementation/observations/media-discovery-pdp3-mdc30-implementation-progress-2026-10-14-r6.json");
 assert.equal(matrix.currentCut.pdp3ImplementationProgress.preR6HistoricalLogicalCount.sourceBound,37);
 assert.equal(matrix.currentCut.pdp3ImplementationProgress.preR6HistoricalLogicalCount.incomplete,24);
 assert.equal(matrix.currentCut.pdp3ImplementationProgress.preR6HistoricalLogicalCount.priorPlanReportedCounts.sourceBound,43);
 assert.equal(matrix.currentCut.pdp3ImplementationProgress.preR6HistoricalLogicalCount.priorPlanReportedCounts.incomplete,18);
 assert.equal(matrix.currentCut.pdp3ImplementationProgress.currentLogicalCount,null);
 assert.equal(r5Progress.logicalChannelProgress.sourceBoundDefinitionOnly,37);
 assert.equal(r5Progress.logicalChannelProgress.incomplete,24);
 assert.equal(matrix.currentCut.pdp3ImplementationProgress.preR6HistoricalLogicalCount.consequentialSteps,14);
 assert.equal(Object.hasOwn(matrix.ownerDecisionOverlay,"currentTechnicalAuditCounts"),false);
 assert.equal(Object.hasOwn(matrix.ownerDecisionOverlay,"currentTechnicalAuditRef"),false);
 assert.match(work.campaign.mdc30SourceGapStatus,/R5_RECEIPT_HISTORICAL/u);
 assert.equal(work.campaign.historicalR4CompletedMDC30SubtaskIds.includes("MDC30-C-21"),true);
 assert.equal(Object.hasOwn(work.campaign,"pdp3R4CountsCurrent"),false);
});

test("MDC30-S06 traces action, exact target capability and job.submit wrapper without claiming QUEUED",()=>{
 const x=policy.decidedPolicy.s06Trace;
 assert.equal(x.step,"J-06:01");
 assert.equal(x.actionOperationRef,"media.operation.action.submit-validated-request");
 assert.equal(x.capabilityOperationRef,"media.operation.capability.media-multimodal-observe-source-grounded");
 assert.equal(x.wrapperRef,"media.operation.job.submit.v1");
 assert.equal(x.adapterRef,"media.pdp3.invocation-adapter.j06-source-grounded.v1");
 assert.ok(x.admissionOutcome.includes("neither QUEUED"));
 assert.deepEqual(mdc.consequentialStepBinding.blockedTaskIds,["MDC30-S-06"]);
 assert.equal(policy.decidedPolicy.validPdp3StateBindingDispositions.length,3);
});

test("matrix and campaign remain phase-locked with 200 review cells and zero fake currentness/closure",()=>{
 assert.equal(matrix.cells.length,200);
 for(const phase of ["PDP-0","PDP-1","PDP-2","PDP-3"]){
   assert.equal(matrix.cells.filter(x=>x.phase===phase).length,50);
 }
 assert.equal(work.campaign.preR6HistoricalRemainingMDC30SubtaskIds.length,19);
 assert.equal(work.campaign.preR6HistoricalRemainingMDC30SubtaskIds.includes("MDC30-C-21"),true);
 assert.equal(work.campaign.currentRemainingMDC30SubtaskIds,null);
 assert.equal(work.campaign.currentMDC30RequiredWork.length,3);
 assert.equal(Object.hasOwn(work.campaign,"pdp3R4CountsCurrent"),false);
 assert.equal(work.campaign.historicalR4CompletedMDC30SubtaskIds.includes("MDC30-S-06"),true);
 assert.equal(work.campaign.historicalR4CompletedMDC30SubtaskIds.includes("MDC30-C-30"),true);
 assert.deepEqual(work.campaign.remainingDiscoveryTaskIds,["MDC-30","MDC30-V-01","MDC-31","MDC-32","MDC-40","MDC-41"]);
 assert.equal(matrix.status.discovery,"FAIL_PDP3_DEFINITION_COMPLETION_PENDING");
 assert.equal(matrix.status.pdp1,"R30_PASS_50_OF_50_329_PATHS_DEV_COMPLETE_ZERO_OUTSTANDING_MEANING; EXACT_CUT_OWNER_ACCEPTANCE_NOT_RECORDED; PASS_WITH_EXPECTED_STRICT_ADMISSION_FINDING");
 assert.equal(matrix.status.pdp2,"R19_PASS_50_OF_50_405_PATHS_AGAINST_PDP1_R30; DEV_COMPLETE_ZERO_OUTSTANDING_MEANING; EXACT_CUT_OWNER_ACCEPTANCE_NOT_RECORDED");
 assert.equal(matrix.status.pdp3,"ACTIVE_MDC30_SOURCE_GAP_RESOLUTION; R6_NOT_CAPTURED; LIVE_RAW_EDGE_REGISTRY_43_OF_61_SOURCE_BOUND_DEFINITION_ONLY_AND_18_INCOMPLETE_ACROSS_10_JOURNEYS; RAW_FIELDS_NOT_R6_VALIDATION_OR_TASK_COMPLETION; 14_STEP_SOURCE_AUDIT_COMPLETE_WITH_DISPOSITIONS_OPEN; J21_EXCLUDED_AND_BLOCKED; ALL_TRANSPORTS_UNBOUND; RUNTIME_NOT_ADMITTED");
 assert.equal(matrix.status.nativePdpClosure,"NOT_ENTERED");
 assert.equal(matrix.status.build,"NOT_ENTERED");
 assert.equal(matrix.status.delivery,"BLOCKED");
 assert.equal(policy.authority.independentHumanSpecialistAttestation,false);
 assert.deepEqual(matrix.currentCut.pdp3ImplementationProgress.preR6HistoricalLogicalCount,{totalEdges:61,sourceBound:37,incomplete:24,incompleteGroups:13,consequentialSteps:14,sourceDefinitionBoundConsequentialSteps:5,partialConsequentialSteps:7,gapConsequentialSteps:2,status:"R5_RECEIPT_HISTORICAL_CONFLICTS_WITH_PRIOR_PLAN_SUMMARY; R6_NOT_CAPTURED",observationRef:"docs/implementation/observations/media-discovery-pdp3-mdc30-implementation-progress-2026-10-14-r5.json",priorPlanReportedCounts:{sourceBound:43,incomplete:18,incompleteGroups:10,status:"CONFLICTING_HISTORICAL_SUMMARY; NOT_LIVE"}});
 assert.equal(matrix.currentCut.pdp3ImplementationProgress.currentLogicalCount,null);
 assert.equal(matrix.currentCut.pdp3ImplementationProgress.sourceGapAuditStatus,"PENDING_R6_CAPTURE");
 assert.equal(matrix.currentCut.pdp3ImplementationProgress.currentnessStatus,"NOT_ESTABLISHED");
 assert.equal(matrix.currentCut.pdp3ImplementationProgress.pdp3PhaseExitPublished,false);
 assert.equal(matrix.currentCut.pdp1LatestAttemptRef,"docs/implementation/observations/media-discovery-pdp1-exit-2026-10-15-current-cut-r30.json");
 assert.equal(matrix.currentCut.pdp1LatestAttemptStatus,"PASS");
 assert.deepEqual(matrix.currentCut.pdp1LatestAttemptBlockers,[]);
 assert.equal(matrix.currentCut.pdp2R17ToR30ImpactRef,"docs/implementation/observations/media-discovery-pdp2-r17-to-r30-source-impact-2026-10-15-r1.json");
});
