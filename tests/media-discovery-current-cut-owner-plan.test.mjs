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
 load("docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r12.json"),
 load("docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r27.json"),
 load("docs/implementation/observations/media-discovery-pdp2-exit-2026-10-14-current-cut-r17.json"),
];

test("historical PDP-0 R12, PDP-1 R27, PDP-2 R17 remain distinct from failed present-cut R13 and R14", () => {
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
   "docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r12.json",
   "docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r27.json",
   "docs/implementation/observations/media-discovery-pdp2-exit-2026-10-14-current-cut-r17.json",
 ]);
 for(const [index,key] of [[0,"pdp0"],[1,"pdp1"],[2,"pdp2"]]) {
   const exit = predecessorExits[index].currentPhaseExit ?? predecessorExits[index].phaseExit;
   assert.ok(exit,`${key} receipt has a phase-exit disposition`);
   assert.equal(exit.status,"PASS");
   assert.equal(predecessorExits[index].sourceCurrentness.status,"PASS");
   assert.equal(predecessorExits[index].sourceCurrentness.cells.length,50);
 }
 assert.equal(matrix.currentCut.pdp1MaterialSourceSetFingerprint,"sha256:2c982c15803a00a22a873d9874e1d00de89b1e80addc97ae984bffc578bef3aa");
 assert.equal(matrix.currentCut.pdp2MaterialSourceSetFingerprint,"sha256:a4c43f03c44a5f1844fba5039f146473f7390c02b3a06ce582c095fc5d9e74bd");
 assert.equal(predecessorExits[2].predecessor.r27SourceMapBridge.r25PathCount,329);
 assert.deepEqual(predecessorExits[2].predecessor.r27SourceMapBridge.changedPaths,[]);
 assert.equal(matrix.currentCut.pdp2R16ProjectionImpactRef,"docs/implementation/observations/media-discovery-pdp2-r16-projection-impact-2026-10-14-r1.json");
 assert.equal(pdp2R16Impact.sourceDeltas.length,1);
 assert.equal(pdp2R16Impact.sourceDeltas[0].predecessorSha256,"sha256:612760df546543582d5b6a867e3086bc6f1b21c5ba745367fbe3dd88b27f0979");
 assert.equal(pdp2R16Impact.sourceDeltas[0].observedSha256,"sha256:e7c3f762eb95d3ea6e5111fe24266406010de05abb20f05b6e310f2b9a80bd4c");
 assert.equal(matrix.status.pdp0,"HISTORICAL_R12_PASS_CAPTURED_SOURCE_SET_ONLY; PRIOR_R13_FAIL_SOURCE_CURRENTNESS; PRESENT_CUT_R14_FAIL_SOURCE_CURRENTNESS_0_CURRENT_50_UNKNOWN");
 assert.equal(matrix.status.pdp1,"HISTORICAL_R27_PASS_CAPTURED_SOURCE_SET_ONLY; PRESENT_CUT_RECAPTURE_BLOCKED_PENDING_PDP0");
 assert.equal(matrix.status.pdp2,"HISTORICAL_R17_PASS_CAPTURED_SOURCE_SET_ONLY; PRESENT_CUT_RECAPTURE_BLOCKED_PENDING_PDP1");
 assert.equal(matrix.status.pdp3,"NOT_ESTABLISHED_PREDECESSOR_CURRENTNESS_RECAPTURE_BLOCKED; R6_NOT_CAPTURED");
 assert.equal(matrix.status.discovery,"FAIL");
 assert.equal(work.campaign.activePhase,"PDP-0");
 assert.equal(work.campaign.activePhaseTaskId,"RC-P0-01");
 assert.equal(work.campaign.currentPhaseOwnerDecisionRef,".product-experience/reviews/2026-10-13-discovery-current-cut-delegated-owner-review.md");
 assert.equal(work.campaign.currentPhaseOwnerPacketRef,"docs/implementation/observations/media-discovery-current-cut-owner-directions-2026-10-13-r2.json");
 assert.equal(work.campaign.currentPhaseOwnerChoiceStatus,"HISTORICAL_PDP0_DIRECTIONS_FOR_RECORDED_CUT_ONLY; R14_FAIL_SOURCE_CURRENTNESS; EXTERNAL_LIFECYCLE_OWNER_DISPOSITION_AND_ROOT_CONTINUITY_PENDING");
 assert.equal(work.campaign.currentPhaseChoiceStatus,"HISTORICAL_PDP3_OWNER_DIRECTIONS_ONLY; MDC-30_EXECUTION_BLOCKED_PENDING_PDP0_R14_CURRENTNESS");
 assert.equal(work.campaign.pendingCurrentPhaseReviewTargetStatus,"BLOCKED_UNTIL_PDP0_R14_SUCCESSOR_CURRENTNESS_PASSES");
 assert.equal(work.pdp0PresentCutAttemptRef,"docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r14.json");
 assert.deepEqual(work.pdp0PresentCutAttemptBlockers,["UNEXPECTED_REPOSITORY_MEMBERSHIP_CHANGE"]);
 assert.deepEqual(work.pdp0PresentCutAttemptCurrentness,{current:0,unknown:50,total:50,lifecycleContinuity:"UNKNOWN",zeroWorkEligibleAtCapture:false});
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
 assert.match(executionPlan,/Older-cut R13 records/u);
 assert.match(executionPlan,/Neither is a present-cut recapture or satisfies the required PDP-0 → PDP-1 → PDP-2 chain/u);
 assert.match(executionPlan,/latest pre-R6 live-registry source audit recorded 43\/61 edges source-bound definition-only and 18 incomplete/u);
 assert.match(executionPlan,/After the source-local repairs, the acceptance criterion is \*\*zero logically incomplete\*\*/u);
 assert.match(executionPlan,/Acceptance boundary:\*\* R17 and the older R13 receipts are historical technical PASS records for their captured source sets; they do not imply exact-cut owner acceptance, independent signoff, native closure, runtime admission, Delivery, or release/u);
 assert.deepEqual(work.campaign.predecessorCurrentnessRecheck.r13ChangedMaterialPaths,[
   ".product-experience/artifact-identities.yaml",
   ".product-experience/gaps.yaml",
   ".product-experience/source-manifest.yaml",
   "apps/media-experience-explorer/specification-artifacts.json",
 ]);
 assert.equal(work.campaign.predecessorCurrentnessRecheck.externalPinDisposition,"AWAITING_EXTERNAL_OWNER_DISPOSITION");
 assert.deepEqual(work.campaign.completedPredecessorRecheckTaskIds,["RC-P0-01","RC-P1-01","RC-P2-01"]);
 assert.deepEqual(work.campaign.requiredPredecessorRecheckTaskIds,["RC-P0-01","RC-P1-01","RC-P2-01"]);
 assert.equal(work.campaign.predecessorCurrentnessRecheck.status,"PDP0_R14_FAIL_SOURCE_CURRENTNESS_0_CURRENT_50_UNKNOWN_PDP1_PDP2_BLOCKED");
 assert.equal(work.campaign.predecessorCurrentnessRecheck.latestAttemptRef,"docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r14.json");
 assert.equal(work.campaign.predecessorCurrentnessRecheck.latestAttemptStatus,"FAIL_SOURCE_CURRENTNESS");
 assert.deepEqual(work.campaign.predecessorCurrentnessRecheck.latestAttemptBlockers,["UNEXPECTED_REPOSITORY_MEMBERSHIP_CHANGE"]);
 assert.deepEqual(work.campaign.predecessorCurrentnessRecheck.latestAttemptCellCurrentness,{current:0,unknown:50,total:50});
 assert.deepEqual(work.campaign.predecessorCurrentnessRecheck.latestAttemptExternalContractDigests,{matched:30,total:30});
 assert.equal(work.campaign.predecessorCurrentnessRecheck.latestAttemptLifecycleContinuity,"UNKNOWN");
 assert.equal(work.campaign.predecessorCurrentnessRecheck.latestAttemptZeroWorkEligible,false);
 assert.deepEqual(work.campaign.predecessorCurrentnessRecheck.requiredPhaseOrder,["PDP-0","PDP-1","PDP-2"]);
 assert.deepEqual(work.campaign.predecessorCurrentnessRecheck.postR13GapDenominatorCorrection,{
   path:".product-experience/gaps.yaml",
   status:"R2_RECORDED_NOT_APPLIED_R14_CURRENTNESS_FAILED",
   recordRef:"docs/implementation/observations/media-discovery-pdp0-r12-successor-impact-2026-10-14-r2.json",
   scope:"GAP-12 source/Explorer denominator correction only; preserve immutable R13, R1 and R2",
   liveDenominators:{portableManifestRecords:356,explorerSourceDerivedRecords:357},
 });
 assert.equal(work.campaign.predecessorCurrentnessRecheck.previouslyCompletedRecheckTaskIdsApplyTo,"their recorded captured source sets only");
 assert.equal(work.campaign.pendingCurrentPhaseReviewTarget,"docs/implementation/observations/media-discovery-pdp3-mdc30-implementation-progress-2026-10-14-r6.json");
 assert.equal(Object.hasOwn(work.campaign,"currentPhaseReviewRef"),false);
 assert.equal(work.campaign.pdp3AuditReviewedHead,null);
 assert.equal(work.campaign.currentPhaseSourceSetFingerprint,null);
 assert.equal(work.campaign.predecessorExitsObservedHead,"e58e67084a4871dc21fb10523f0bcd0df8167d47");
 for(const obsoleteAlias of ["reviewedCurrentHead","lastMdc30ExecutionRef","latestImplementationProgressRef","currentPhaseStatusObservationRef"]){
   assert.equal(Object.hasOwn(work.campaign,obsoleteAlias),false,`${obsoleteAlias} is not a second current pointer`);
 }
 assert.deepEqual(work.campaign.preR6SourceRegistryCounts,{totalEdges:61,sourceBound:43,incomplete:18,consequentialSteps:14,sourceDefinitionBoundConsequentialSteps:5,partialConsequentialSteps:7,gapConsequentialSteps:2,status:"R6_CAPTURE_PENDING_SOURCE_GAP_COUNTS_NOT_PHASE_EXIT"});
 assert.match(work.campaign.nextLegalAction,/R14’s 0\/50-current, 50\/50-unknown result did not apply the exact existing R2/u);
 assert.match(work.campaign.nextLegalAction,/external Lifecycle package.json fingerprint transition through its owner/u);
 assert.match(work.campaign.nextLegalAction,/re-establish root-wide Lifecycle continuity/u);
 assert.match(work.campaign.nextLegalAction,/Then capture a fresh PDP-0 successor applying R2.*after PDP-0 passes, recapture PDP-1 followed by PDP-2 serially/u);
 assert.match(work.campaign.nextLegalAction,/After predecessor currentness passes/u);
 assert.match(work.campaign.nextLegalAction,/J21 excluded and blocked/u);
 assert.match(work.campaign.nextLegalAction,/MDC-41 gated behind a passing Discovery barrier/u);
 const mdc30Task=work.tasks.find(t=>t.id==="MDC-30");
 assert.equal(mdc30Task.status,"BLOCKED_PENDING_PDP0_R14_CURRENTNESS_RECAPTURE");
 assert.equal(mdc30Task.executionEligibility,"BLOCKED_UNTIL_PDP0_SUCCESSOR_PASSES");
 assert.equal(mdc30Task.pendingCurrentPhaseReviewTargetStatus,"BLOCKED_UNTIL_PDP0_R14_SUCCESSOR_CURRENTNESS_PASSES");
 assert.deepEqual(mdc30Task.effectiveRemainingSubtaskIds,["MDC30-C-05","MDC30-C-08","MDC30-C-10","MDC30-C-13","MDC30-C-14","MDC30-C-19","MDC30-C-20","MDC30-C-21","MDC30-C-26","MDC30-C-28","MDC30-S-01","MDC30-S-03","MDC30-S-04","MDC30-S-05","MDC30-S-06","MDC30-S-07","MDC30-S-12","MDC30-S-13","MDC30-S-14"]);
 assert.equal(mdc30Task.preR6SourceRegistryCounts.sourceBound,43);
 assert.equal(mdc30Task.preR6SourceRegistryCounts.incomplete,18);
 assert.equal(mdc30Task.lastCapturedProgressRef,"docs/implementation/observations/media-discovery-pdp3-mdc30-implementation-progress-2026-10-14-r5.json");
 assert.equal(mdc30Task.pendingCurrentPhaseReviewTarget,"docs/implementation/observations/media-discovery-pdp3-mdc30-implementation-progress-2026-10-14-r6.json");
 assert.equal(pdp2ImpactR1.sourceDeltas.length,3);
 assert.equal(pdp2ImpactR1.ownerAcceptance,"NOT_CLAIMED");
 assert.equal(pdp2ImpactR1.independentReview,"NOT_CLAIMED");
 assert.equal(pdp2ImpactR1.lifecycleClosure,"NOT_ENTERED");
 assert.deepEqual(work.campaign.remainingDiscoveryTaskIds,["MDC-30","MDC-31","MDC-32","MDC-40","MDC-41"]);
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
 assert.equal(matrix.currentCut.pdp3ImplementationProgress.logicalCount.sourceBound,43);
 assert.equal(matrix.currentCut.pdp3ImplementationProgress.logicalCount.incomplete,18);
 assert.equal(r5Progress.logicalChannelProgress.sourceBoundDefinitionOnly,37);
 assert.equal(r5Progress.logicalChannelProgress.incomplete,24);
 assert.equal(matrix.currentCut.pdp3ImplementationProgress.logicalCount.consequentialSteps,14);
 assert.equal(Object.hasOwn(matrix.ownerDecisionOverlay,"currentTechnicalAuditCounts"),false);
 assert.equal(Object.hasOwn(matrix.ownerDecisionOverlay,"currentTechnicalAuditRef"),false);
 assert.match(work.campaign.mdc30SourceGapStatus,/PRE_R6_LIVE_REGISTRY/u);
 assert.equal(work.campaign.historicalR4CompletedMDC30SubtaskIds.includes("MDC30-C-21"),true);
 assert.equal(work.campaign.pdp3R4CountsCurrent,false);
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
 assert.equal(work.campaign.remainingMDC30SubtaskIds.length,19);
 assert.equal(work.campaign.remainingMDC30SubtaskIds.includes("MDC30-C-21"),true);
 assert.equal(work.campaign.currentMDC30RequiredWork.length,3);
 assert.equal(work.campaign.pdp3R4CountsCurrent,false);
 assert.equal(work.campaign.historicalR4CompletedMDC30SubtaskIds.includes("MDC30-S-06"),true);
 assert.equal(work.campaign.historicalR4CompletedMDC30SubtaskIds.includes("MDC30-C-30"),true);
 assert.deepEqual(work.campaign.remainingDiscoveryTaskIds,["MDC-30","MDC-31","MDC-32","MDC-40","MDC-41"]);
 assert.equal(matrix.status.discovery,"FAIL");
 assert.equal(matrix.status.pdp1,"HISTORICAL_R27_PASS_CAPTURED_SOURCE_SET_ONLY; PRESENT_CUT_RECAPTURE_BLOCKED_PENDING_PDP0");
 assert.equal(matrix.status.pdp2,"HISTORICAL_R17_PASS_CAPTURED_SOURCE_SET_ONLY; PRESENT_CUT_RECAPTURE_BLOCKED_PENDING_PDP1");
 assert.equal(matrix.status.pdp3,"NOT_ESTABLISHED_PREDECESSOR_CURRENTNESS_RECAPTURE_BLOCKED; R6_NOT_CAPTURED");
 assert.equal(matrix.status.nativePdpClosure,"NOT_ENTERED");
 assert.equal(matrix.status.build,"NOT_ENTERED");
 assert.equal(matrix.status.delivery,"BLOCKED");
 assert.equal(policy.authority.independentHumanSpecialistAttestation,false);
 assert.deepEqual(matrix.currentCut.pdp3ImplementationProgress.logicalCount,{totalEdges:61,sourceBound:43,incomplete:18,consequentialSteps:14,sourceDefinitionBoundConsequentialSteps:5,partialConsequentialSteps:7,gapConsequentialSteps:2,status:"R6_CAPTURE_PENDING_SOURCE_GAP_COUNTS_NOT_PHASE_EXIT"});
 assert.equal(matrix.currentCut.pdp3ImplementationProgress.sourceGapAuditStatus,"PENDING_R6_CAPTURE");
 assert.equal(matrix.currentCut.pdp3ImplementationProgress.currentnessStatus,"NOT_ESTABLISHED");
 assert.equal(matrix.currentCut.pdp3ImplementationProgress.pdp3PhaseExitPublished,false);
});
