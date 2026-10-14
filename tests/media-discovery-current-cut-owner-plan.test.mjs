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
const predecessorExits = [
 load("docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r1.json"),
 load("docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r4.json"),
 load("docs/implementation/observations/media-discovery-pdp2-exit-2026-10-14-current-cut-r3.json"),
];

test("historical owner direction remains immutable while successor predecessor exits are current", () => {
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
 assert.deepEqual([matrix.currentCut.phaseExit, matrix.currentCut.pdp1PhaseExit, matrix.currentCut.pdp2PhaseExit], [
   "docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r1.json",
   "docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r4.json",
   "docs/implementation/observations/media-discovery-pdp2-exit-2026-10-14-current-cut-r3.json",
 ]);
 for(const [index,key] of [[0,"pdp0"],[1,"pdp1"],[2,"pdp2"]]) {
   assert.equal(matrix.status[key],"CURRENT_PHASE_EXIT_PASS");
   const exit = predecessorExits[index].currentPhaseExit ?? predecessorExits[index].phaseExit;
   assert.ok(exit,`${key} successor receipt has a phase-exit disposition`);
   assert.equal(exit.status,"PASS");
   assert.equal(predecessorExits[index].sourceCurrentness.status,"PASS");
   assert.equal(predecessorExits[index].sourceCurrentness.cells.length,50);
 }
 assert.equal(work.campaign.activePhase,"PDP-3");
 assert.deepEqual(work.campaign.completedPredecessorRecheckTaskIds,["RC-P0-01","RC-P1-01","RC-P2-01"]);
 assert.deepEqual(work.campaign.requiredPredecessorRecheckTaskIds,[]);
 assert.equal(matrix.currentPhase,"PDP-3");
 assert.match(matrix.nextLegalAction,/21 remaining PDP-3 logical channel edges/);
 assert.deepEqual(work.tasks.find(task=>task.id==="MDC-30").effectiveRemainingSubtaskIds,[
   "MDC30-C-03","MDC30-C-04","MDC30-C-16","MDC30-C-22","MDC30-C-25","MDC30-C-27","MDC30-C-30","MDC30-V-01",
 ]);
 assert.deepEqual(work.tasks.find(task=>task.id==="MDC-30").actualCompletedSubtaskCount,{channelEdges:40,consequentialSteps:14,integrationScope:true,externalContractByteRecapture:true});
 assert.deepEqual(work.tasks.find(task=>task.id==="MDC-30").actualPendingSubtaskCount,{logicalChannelEdges:21,journeyGroups:7,consequentialStepBindings:0,currentnessRechecks:0});
});

test("current-cut owner instructions cover exactly 14 unresolved C tasks and 32 incomplete edges, no fabricated runtime", () => {
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
 assert.deepEqual(work.campaign.remainingMDC30SubtaskIds,[
   "MDC30-C-03","MDC30-C-04","MDC30-C-16","MDC30-C-22","MDC30-C-25","MDC30-C-27","MDC30-C-30","MDC30-V-01",
 ]);
 assert.equal(work.campaign.completedMDC30SubtaskIds.includes("MDC30-S-06"),true);
 assert.deepEqual(work.campaign.remainingDiscoveryTaskIds,["MDC-30","MDC-31","MDC-32","MDC-40","MDC-41"]);
 assert.equal(matrix.status.discovery,"FAIL");
 assert.equal(matrix.status.nativePdpClosure,"NOT_ENTERED");
 assert.equal(matrix.status.build,"NOT_ENTERED");
 assert.equal(matrix.status.delivery,"BLOCKED");
 assert.equal(policy.authority.independentHumanSpecialistAttestation,false);
 assert.deepEqual(matrix.currentCut.pdp3ImplementationProgress.logicalCount,{totalEdges:61,sourceBound:40,incomplete:21,consequentialSteps:14,completeConsequential:14});
});
