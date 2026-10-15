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
const pdp2ImpactR1 = load("docs/implementation/observations/media-discovery-pdp2-additional-source-impact-2026-10-14-r1.json");
const pdp2R16Impact = load("docs/implementation/observations/media-discovery-pdp2-r16-projection-impact-2026-10-14-r1.json");
const predecessorExits = [
 load("docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r12.json"),
 load("docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r27.json"),
 load("docs/implementation/observations/media-discovery-pdp2-exit-2026-10-14-current-cut-r17.json"),
];

test("current cut retains PDP-0 R12, PDP-1 R27, PDP-2 R17, and activates PDP-3 re-audit", () => {
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
 assert.equal(matrix.status.pdp0,"CURRENT_PHASE_EXIT_PASS_R12_INTERNAL_IMPACT_DISPOSITION_ONLY");
 assert.equal(matrix.status.pdp1,"CURRENT_PHASE_EXIT_PASS_R27_INTERNAL_IMPACT_DISPOSITION_ONLY_OWNER_ACCEPTANCE_NOT_RECORDED");
 assert.equal(matrix.status.pdp2,"CURRENT_PHASE_EXIT_PASS_R17_INTERNAL_IMPACT_DISPOSITIONS_ONLY_OWNER_ACCEPTANCE_NOT_RECORDED");
 assert.equal(matrix.status.pdp3,"NOT_ESTABLISHED_MDC30_REAUDIT_REQUIRED");
 assert.equal(work.campaign.activePhase,"PDP-3");
 assert.deepEqual(work.campaign.completedPredecessorRecheckTaskIds,["RC-P0-01","RC-P1-01","RC-P2-01"]);
 assert.deepEqual(work.campaign.requiredPredecessorRecheckTaskIds,[]);
 assert.match(work.campaign.latestNextLegalAction,/Re-audit all 61 MDC-30 journey×channel edges and 14 consequential steps/u);
 assert.match(work.campaign.latestNextLegalAction,/MDC-41 remains gated until the Discovery barrier passes/u);
 assert.equal(pdp2ImpactR1.sourceDeltas.length,3);
 assert.equal(pdp2ImpactR1.ownerAcceptance,"NOT_CLAIMED");
 assert.equal(pdp2ImpactR1.independentReview,"NOT_CLAIMED");
 assert.equal(pdp2ImpactR1.lifecycleClosure,"NOT_ENTERED");
 assert.deepEqual(work.campaign.remainingDiscoveryTaskIds,["MDC-30","MDC-31","MDC-32","MDC-40","MDC-41"]);
});

test("historical R4 owner instructions remain historical pending 61-edge and 14-step re-audit", () => {
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
 assert.equal(matrix.currentCut.pdp3ImplementationProgress.historicalPendingCurrentReaudit,true);
 assert.equal(matrix.currentCut.pdp3ImplementationProgress.logicalCount.sourceBound,43);
 assert.equal(matrix.currentCut.pdp3ImplementationProgress.logicalCount.incomplete,18);
 assert.equal(matrix.currentCut.pdp3ImplementationProgress.logicalCount.consequentialSteps,14);
 assert.match(work.campaign.latestMdc30ProgressStatus,/HISTORICAL_R4_ONLY/u);
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
 assert.deepEqual(work.campaign.remainingMDC30SubtaskIds,[]);
 assert.equal(work.campaign.remainingMDC30SubtaskIdsAreHistoricalR4Only,true);
 assert.equal(work.campaign.currentMDC30RequiredWork.length,3);
 assert.equal(work.campaign.pdp3R4CountsCurrent,false);
 assert.equal(work.campaign.completedMDC30SubtaskIds.includes("MDC30-S-06"),true);
 assert.equal(work.campaign.completedMDC30SubtaskIds.includes("MDC30-C-30"),true);
 assert.deepEqual(work.campaign.remainingDiscoveryTaskIds,["MDC-30","MDC-31","MDC-32","MDC-40","MDC-41"]);
 assert.equal(matrix.status.discovery,"FAIL");
 assert.equal(matrix.status.pdp1,"CURRENT_PHASE_EXIT_PASS_R27_INTERNAL_IMPACT_DISPOSITION_ONLY_OWNER_ACCEPTANCE_NOT_RECORDED");
 assert.equal(matrix.status.pdp2,"CURRENT_PHASE_EXIT_PASS_R17_INTERNAL_IMPACT_DISPOSITIONS_ONLY_OWNER_ACCEPTANCE_NOT_RECORDED");
 assert.equal(matrix.status.pdp3,"NOT_ESTABLISHED_MDC30_REAUDIT_REQUIRED");
 assert.equal(matrix.status.nativePdpClosure,"NOT_ENTERED");
 assert.equal(matrix.status.build,"NOT_ENTERED");
 assert.equal(matrix.status.delivery,"BLOCKED");
 assert.equal(policy.authority.independentHumanSpecialistAttestation,false);
 assert.deepEqual(matrix.currentCut.pdp3ImplementationProgress.logicalCount,{totalEdges:61,sourceBound:43,incomplete:18,consequentialSteps:14,completeConsequential:14});
 assert.equal(matrix.currentCut.pdp3ImplementationProgress.historicalPendingCurrentReaudit,true);
 assert.equal(matrix.currentCut.pdp3ImplementationProgress.currentnessStatus,"NOT_ESTABLISHED");
 assert.equal(matrix.currentCut.pdp3ImplementationProgress.pdp3PhaseExitPublished,false);
});
