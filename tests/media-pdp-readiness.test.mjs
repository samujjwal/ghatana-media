import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildReadiness, buildPdp0DevStatus, writePdp0DevStatus, validateTaskPopulation, taskIds, verificationCutChanged, resolveCriterionReviewSourceCut, selectApprovedMediaDecisions, assessCurrentTaskDependencies } from '../scripts/report-media-pdp-readiness.mjs';
import path from 'node:path';
import os from 'node:os';
import { buildMediaProductDefinitionResidualReport } from '../scripts/lib/media-product-definition-residuals.mjs';
const audit=JSON.parse(fs.readFileSync('docs/implementation/media-task-completion-blocker-report-2026-10-08.json','utf8'));
const residual=buildMediaProductDefinitionResidualReport();
const p0Only=process.env.PDP_DEV_PHASE==='PDP-0';
const broadTest=p0Only?test.skip:test;
const build=verification=>buildReadiness({audit,residual,verification,mainSha:'fixture',fingerprints:{}});
test('approved PDP-0 media decisions include only current direct and scoped corrective approvals',()=>{
 const reviews={
  'P0-01':{status:'APPROVED_DIRECT_DEFINITION_CRITERION',sourceCutCurrent:true,decisionRef:'direct-1',currentCorrectiveReview:{status:'APPROVED_CURRENT_CORRECTION',phaseScope:'PDP-0',decisionRef:'corrective-1'}},
  'P0-02':{status:'APPROVED_DIRECT_DEFINITION_CRITERION',sourceCutCurrent:false,decisionRef:'stale',currentCorrectiveReview:{status:'APPROVED_CURRENT_CORRECTION',phaseScope:'PDP-0',decisionRef:'stale-corrective'}},
  'P0-03':{status:'PENDING',sourceCutCurrent:true,decisionRef:'pending',currentCorrectiveReview:{status:'APPROVED_CURRENT_CORRECTION',phaseScope:'PDP-0',decisionRef:'orphaned-corrective'}},
  'P0-04':{status:'APPROVED_DIRECT_DEFINITION_CRITERION',sourceCutCurrent:true,decisionRef:'direct-4',currentCorrectiveReview:{status:'APPROVED_CURRENT_CORRECTION',phaseScope:'PDP-1',decisionRef:'wrong-phase'}},
  'P0-05':{status:'APPROVED_DIRECT_DEFINITION_CRITERION',sourceCutCurrent:true,decisionRef:'direct-5',currentCorrectiveReview:{status:'PENDING',phaseScope:'PDP-0',decisionRef:'pending-corrective'}},
 };
 const claimIds=['MPSEM-0078-C003','MPSEM-0181-C001','MPSEM-0278-C001','MPSEM-0367-C002','MPSEM-0475-C003'];
 const base={authorizationStatus:'APPROVED_BOUNDED_OWNER_SOURCE_SEMANTIC_ROUTE',status:'APPROVED_BOUNDED_OWNER_SOURCE_SEMANTIC_ROUTE',decisionRef:'migration-139',acceptanceEffect:'none',runtimeStatus:'NOT_EVALUATED',cliAdmission:'NOT_ADMITTED',records:claimIds.map(claimId=>({claimId,ownerPhase:'PDP-0',coordinatorDisposition:'APPROVED_BOUNDED_OWNER_SOURCE_SEMANTIC_ROUTE',coordinatorDecisionRef:'migration-139',ownerProposalObservation:{status:'PENDING_COORDINATOR_MATERIAL_REVIEW'},acceptanceEffect:'none',runtimeStatus:'NOT_EVALUATED'}))};
 assert.deepEqual(selectApprovedMediaDecisions(reviews,base),['corrective-1','direct-1','direct-4','direct-5','migration-139']);
 assert.deepEqual(selectApprovedMediaDecisions(reviews,{...base,records:base.records.slice(0,4)}),['corrective-1','direct-1','direct-4','direct-5']);
 assert.deepEqual(selectApprovedMediaDecisions(reviews,{...base,records:base.records.map((r,i)=>i===4?{...r,ownerPhase:'PDP-1'}:r)}),['corrective-1','direct-1','direct-4','direct-5']);
 assert.deepEqual(selectApprovedMediaDecisions(reviews,{...base,records:base.records.map((r,i)=>i===4?{...r,claimId:'MPSEM-9999-C001'}:r)}),['corrective-1','direct-1','direct-4','direct-5']);
 assert.deepEqual(selectApprovedMediaDecisions(reviews,{...base,records:base.records.map((r,i)=>i===4?{...r,ownerProposalObservation:{status:'APPROVED'}}:r)}),['corrective-1','direct-1','direct-4','direct-5']);
 assert.deepEqual(selectApprovedMediaDecisions(reviews,{...base,authorizationStatus:'PENDING_COORDINATOR_MATERIAL_REVIEW'}),['corrective-1','direct-1','direct-4','direct-5']);
});
test('current PDP-0 corrective source fingerprints exclude generated verification logs',()=>{
 const artifact=JSON.parse(fs.readFileSync('docs/implementation/verification/pdp-38/direct-definition-criteria-review.json','utf8'));
 for(const record of artifact.records){
  for(const file of Object.keys(record.currentCorrectiveReview?.sourceFingerprints??{})){
   assert.equal(/\/P0-\d+\.log$/u.test(file),false,`${record.taskId} does not fingerprint a generated test log`);
  }
 }
});
broadTest('a corrective approval uses its own reviewed source cut and preserves historical pins',()=>{
 const historical={sourceFingerprints:{source:'old'}};
 const current=file=>file==='source'?'new':null;
 assert.equal(resolveCriterionReviewSourceCut(historical,current).sourceCutCurrent,false);
 const correction={status:'APPROVED_CURRENT_CORRECTION',sourceFingerprints:{source:'new'}};
 const reviewed=resolveCriterionReviewSourceCut({...historical,currentCorrectiveReview:correction},current);
 assert.equal(reviewed.sourceCutCurrent,true);
 assert.equal(reviewed.historicalSourceCutCurrent,false);
 assert.deepEqual(reviewed.sourceFingerprints,{source:'old'});
 for(const pins of [undefined,{}, {source:'old'}, {missing:'new'}]) {
   assert.equal(resolveCriterionReviewSourceCut({...historical,currentCorrectiveReview:{...correction,sourceFingerprints:pins}},current).sourceCutCurrent,false);
 }
 const old=file=>file==='source'?'old':null;
 assert.equal(resolveCriterionReviewSourceCut({...historical,currentCorrectiveReview:{status:'APPROVED_CURRENT_CORRECTION'}},old).sourceCutCurrent,false,'an old matching cut cannot substitute for corrective evidence');
});
broadTest('fixed 38-task scope rejects extras, duplicates and missing tasks',()=>{
  const rows=taskIds.map(id=>({id}));
  validateTaskPopulation(rows);
  for(const bad of [rows.slice(1),[...rows,{id:'E-01'}],rows.map((r,i)=>i===0?rows[1]:r)]) assert.throws(()=>validateTaskPopulation(bad));
});
broadTest('P0-04 source completion never implies dependency completion or original ledger completion',()=>{
  const r=build({'P0-04':{status:'PASS'}});const p=r.tasks.find(t=>t.id==='P0-04');
  assert.equal(p.definitionCriterionSatisfied,true);assert.equal(p.taskSpecificSourceDone,'VERIFIED_IN_CURRENT_SOURCE');
  assert.equal(p.originalFullTaskDone,false);assert.equal(p.overallDone,'partial');assert.equal(p.dependencyReady,'NOT_ESTABLISHED');
  assert.equal(p.nativePhaseProofCurrent,'NOT_EVALUATED');assert.equal(p.independentReviewAccepted,'NOT_EVALUATED');
});
broadTest('historical complete or failed verification cannot manufacture a current source pass',()=>{
  for(const evidence of [{},{'P0-04':{status:'FAIL'}}]) assert.equal(build(evidence).tasks.find(t=>t.id==='P0-04').definitionCriterionSatisfied,false);
  assert.equal(build({}).tasks.find(t=>t.id==='P1-06').taskSpecificSourceDone,'PRIOR_SOURCE_AUDIT_MET_REVALIDATION_REQUIRED');
});
broadTest('a successful test on a changing source cut cannot establish current completion',()=>{
  assert.deepEqual(verificationCutChanged({a:'old',b:'same',removed:'old'}, {a:'new',b:'same',added:'new'}), ['a','added','removed']);
  assert.deepEqual(verificationCutChanged({a:'same'}, {a:'same'}), []);
  const row=build({'P0-04':{status:'PASS_ON_CHANGED_SOURCE_CUT_REVALIDATION_REQUIRED'}}).tasks.find(t=>t.id==='P0-04');
  assert.equal(row.definitionCriterionSatisfied,false);
  assert.equal(row.nativePhaseProofCurrent,'NOT_EVALUATED');
});
broadTest('live counters preserve receipt uncertainty and dynamic source denominator',()=>{
 const r=build({});assert.equal(r.currentCounters.obligations,residual.lifecycle.obligationCount);
 assert.equal(r.currentCounters.authoritativeReceiptCount,null);assert.equal(r.currentCounters.currentness.status,'NOT_EVALUATED');
 assert.equal(r.taskCount,38);assert.equal(r.phases.length,4);
});
broadTest('new source obligations remain distinct from the persisted evidence population',()=>{
 const r=buildReadiness({audit,residual,mainSha:'fixture',fingerprints:{},definitionCensus:{
   lifecycleSourceEnumeration:{count:residual.lifecycle.obligationCount+1,issues:[]},
 }});
 assert.equal(r.currentCounters.sourceEnumeratedObligations,residual.lifecycle.obligationCount+1);
 assert.equal(r.currentCounters.persistedObligationPopulationCountMatchesSource,false);
 assert.equal(r.currentCounters.obligations,residual.lifecycle.obligationCount);
 assert.equal(r.currentCounters.authoritativeReceiptCount,null);
});
broadTest('passing a bounded implementation suite never establishes a whole task or specialist acceptance',()=>{
 const p=build({'P1-09':{status:'PASS'}}).tasks.find(t=>t.id==='P1-09');
 assert.equal(p.currentImplementationEvidence.sourceTests,'PASS');
 assert.equal(p.currentImplementationEvidence.wholeTaskCriterionEstablished,false);
 assert.equal(p.definitionCriterionSatisfied,false);
 assert.equal(p.independentReviewAccepted,'NOT_EVALUATED');
 assert.equal(p.LifecyclePhaseReceiptCurrent,'NOT_EVALUATED');
});
broadTest('a reviewed current direct definition criterion remains separate from original task and external acceptance',()=>{
 const review={status:'APPROVED_DIRECT_DEFINITION_CRITERION',sourceCutCurrent:true,decisionRef:'.product-experience/decision-log.md#fixture'};
 const make=entry=>buildReadiness({audit,residual,verification:{'P0-01':{status:'PASS'}},definitionCriterionReviews:{'P0-01':entry},mainSha:'fixture',fingerprints:{}}).tasks.find(t=>t.id==='P0-01');
 assert.equal(make(review).definitionCriterionSatisfied,true);
 assert.equal(make(review).originalFullTaskDone,false);
 assert.equal(make(review).independentReviewAccepted,'NOT_EVALUATED');
 assert.equal(make(review).LifecyclePhaseReceiptCurrent,'NOT_EVALUATED');
 assert.equal(make({...review,sourceCutCurrent:false}).definitionCriterionSatisfied,false);
 assert.equal(make({...review,status:'PROPOSED'}).definitionCriterionSatisfied,false);
 const reopened=make({...review,currentCorrectiveReview:{status:'OPEN_MATERIAL_CORRECTION'}});
 assert.equal(reopened.definitionCriterionSatisfied,false,'prior green tests and matching hashes cannot close a known semantic defect');
 assert.equal(reopened.taskSpecificSourceDone,'REOPENED_SOURCE_CONTRACT_CORRECTION_REQUIRED');
 assert.equal(make({...review,currentCorrectiveReview:{status:'APPROVED_CURRENT_CORRECTION'}}).definitionCriterionSatisfied,true);
});

broadTest('current dependency observations cannot inherit historical no-unmet flags or source-test acceptance', () => {
 const rows = assessCurrentTaskDependencies([
  {id:'P0-01', taskSpecificSourceDone:'VERIFIED_IN_CURRENT_SOURCE', independentReviewAccepted:'NOT_EVALUATED', LifecyclePhaseReceiptCurrent:'NOT_EVALUATED'},
  {id:'P0-03', taskSpecificSourceDone:'NOT_ESTABLISHED'},
  {id:'P0-04', dependencies:'P0-01 through P0-03; X-01.', dependencyReady:'PRIOR_AUDIT_NO_UNMET_DEPENDENCY_IDENTIFIED'},
 ]);
 const observed = rows.find(row=>row.id==='P0-04').currentDependencyAssessment;
 assert.equal(observed.status,'NOT_ESTABLISHED');
 assert.deepEqual(new Set(observed.records.map(row=>row.id)),new Set(['P0-01','P0-02','P0-03','X-01']));
 assert.equal(observed.records.find(row=>row.id==='P0-01').sourceCriterion,'VERIFIED_IN_CURRENT_SOURCE');
 assert.equal(observed.records.find(row=>row.id==='P0-01').readiness,'NOT_ESTABLISHED');
 assert.equal(observed.records.find(row=>row.id==='X-01').boundary,'EXTERNAL_DEPENDENCY_ONLY');
 assert.equal(rows.find(row=>row.id==='P0-04').dependencyReady,'PRIOR_AUDIT_NO_UNMET_DEPENDENCY_IDENTIFIED');
});

broadTest('PDP-0 development status stays separate from the historical 38-task and acceptance report', () => {
 const dev=buildPdp0DevStatus({mainSha:'fixture',sourceShaSet:{'owner.yaml':'abc'},verification:{'P0-01':{status:'PASS',command:'node --test p0.test.mjs'}},definitionCriterionReviews:{},sourceInventory:{sourceRecordCount:{capabilityLeaves:462,masterPlanClaims:129},semanticallyResolvedCount:{capabilityLeafAdjudications:462,masterPlanClaims:129}},exportedHandoffIds:['MSC-07-MSD-015-L0584-C05'],approvedMediaDecisions:['PXD-123']});
 assert.equal(dev.phase,'PDP-0');
 assert.equal(dev.status,'IN_PROGRESS');
 assert.deepEqual(dev.sourceRecordCount,{capabilityLeaves:462,masterPlanClaims:129});
 assert.equal(dev.testsActuallyRun['P0-01'].command,'node --test p0.test.mjs');
 assert.deepEqual(dev.outstandingMeaningIds,[]);
 assert.equal(dev.directDevelopmentCriteria['P0-02'].testStatus,'NOT_RUN');
 assert.ok(dev.exportedHandoffIds.includes('MSC-07-MSD-015-L0584-C05'));
 assert.deepEqual(dev.approvedMediaDecisions,['PXD-123']);
 for (const forbidden of ['Lifecycle','receipts','independentReview','release','production','certification','convergence']) assert.equal(Object.keys(dev).some(key=>key.toLowerCase().includes(forbidden.toLowerCase())),false,`${forbidden} is not a dev-status field`);
 const historical=build({'P0-04':{status:'PASS'}});
 assert.equal(historical.schemaVersion,'media.pdp-38-readiness.v1');
 assert.equal(historical.taskCount,38);
 assert.ok(!Object.hasOwn(historical,'status'));
});

test('PDP-0 development status can close only with the exact full source inventory and no outstanding meaning', () => {
 const criteria=['P0-01','P0-02','P0-03','P0-04','P0-05','P0-06','P0-07','P0-08'];
 const verification=Object.fromEntries(criteria.map(id=>[id,{status:'PASS',command:`node --test ${id}`,testCount:id==='P0-03'?11:1,passedTestCount:1,skippedTestCount:id==='P0-03'?10:0,outputSha256:'observed',testSourceFingerprints:{'tests/p0.test.mjs':'abc'},sourceCut:{fingerprints:{'tests/p0.test.mjs':'abc'},changedDuringVerification:[],changedBeforeReport:[]}}]));
 const counts={capabilityLeafAdjudications:462,requirementGroups:38,intents:19,journeys:30,profileBoundCapabilityLeaves:462,qualityDimensions:6,qualityMetricDefinitions:16,qualityApplicabilityLeaves:462,channelApplicabilityLeaves:462,featureReviewDimensions:15,featureReviewCapabilityLeaves:462,masterPlanClaims:129,constitutionalRequirements:32};
 const integrityChecks={capabilities:true,profiles:true,quality:true,features:true,claims:true,requirements:true,constitution:true,handoff:true};
 const p0ScopeReviews=Object.fromEntries(['P0-01','P0-02','P0-05','P0-06','P0-07'].map(id=>[id,{
  status:'APPROVED_DIRECT_DEFINITION_CRITERION',sourceCutCurrent:true,
  currentCorrectiveReview:{status:'APPROVED_CURRENT_CORRECTION',phaseScope:'PDP-0',decisionRef:'.product-experience/decision-log.md#PXD-138'},
 }]));
 integrityChecks.currentP0CriterionScopesComplete=true;
 const completeInventory={sourceCutStable:true,integrityChecks,sourceRecordCount:counts,semanticallyResolvedCount:{...counts},sourceReconciliations:[{id:'legacy-summary',status:'HISTORICAL_SOURCE_ONLY',currentOwnerRef:'current-owner.yaml#/records'}]};
 const handoffs=['media.pdp0-pdp1.capability-intent-handoff.v1','MSC-07-MSD-015-L0584-C05'];
 const dev=buildPdp0DevStatus({mainSha:'fixture',sourceShaSet:{'capabilities.yaml':'abc'},verification,definitionCriterionReviews:p0ScopeReviews,sourceInventory:completeInventory,exportedHandoffIds:handoffs});
 assert.equal(dev.status,'DEV_COMPLETE');
 assert.deepEqual(dev.outstandingMeaningIds,[]);
 assert.equal(Object.keys(dev.directDevelopmentCriteria).length,8);
 assert.equal(dev.testsActuallyRun['P0-01'].testCount,1);
 assert.equal(dev.testsActuallyRun['P0-03'].skippedTestCount,10);
 assert.equal(dev.testsActuallyRun['P0-01'].outputSha256,'observed');
 assert.deepEqual(dev.sourceReconciliations,[{id:'legacy-summary',status:'HISTORICAL_SOURCE_ONLY',currentOwnerRef:'current-owner.yaml#/records'}]);
 assert.deepEqual(dev.exportedHandoffIds,handoffs.sort());
 const expectOpen=(mutate,message)=>{
  const nextVerification=structuredClone(verification), nextInventory=structuredClone(completeInventory), nextHandoffs=[...handoffs], nextReviews=structuredClone(p0ScopeReviews);
  mutate({verification:nextVerification,inventory:nextInventory,handoffs:nextHandoffs,reviews:nextReviews});
  const result=buildPdp0DevStatus({mainSha:'fixture',sourceShaSet:{'capabilities.yaml':'abc'},verification:nextVerification,definitionCriterionReviews:nextReviews,sourceInventory:nextInventory,exportedHandoffIds:nextHandoffs});
  assert.equal(result.status,'IN_PROGRESS',message);
 };
 expectOpen(({verification:v})=>{v['P0-01'].testCount=2;},'partial test pass cannot establish completion');
 expectOpen(({verification:v})=>{v['P0-08'].skippedTestCount=1;},'unexpected skips cannot establish completion');
 expectOpen(({verification:v})=>{v['P0-03'].skippedTestCount=9;},'missing phase-gated skips cannot establish completion');
 expectOpen(({verification:v})=>{delete v['P0-01'].outputSha256;},'missing output evidence cannot establish completion');
 expectOpen(({verification:v})=>{v['P0-01'].sourceCut.changedDuringVerification=['capabilities.yaml'];},'test-time source change cannot establish completion');
 expectOpen(({inventory})=>{inventory.sourceRecordCount.qualityMetricDefinitions--;},'denominator mismatch cannot establish completion');
 expectOpen(({inventory})=>{delete inventory.sourceRecordCount.journeys;delete inventory.semanticallyResolvedCount.journeys;},'an omitted inventory population cannot establish completion');
 expectOpen(({inventory})=>{inventory.sourceRecordCount.intents=18;inventory.semanticallyResolvedCount.intents=18;},'a self-consistent but wrong denominator cannot establish completion');
 expectOpen(({inventory})=>{delete inventory.sourceReconciliations[0].currentOwnerRef;},'an unbound historical source reconciliation cannot establish completion');
 expectOpen(({inventory})=>{inventory.integrityChecks.quality=false;},'failed inventory integrity cannot establish completion');
 expectOpen(({inventory})=>{inventory.integrityChecks.currentP0CriterionScopesComplete=false;},'unresolved sequential phase criterion scopes cannot establish completion');
 expectOpen(({reviews})=>{delete reviews['P0-01'];},'missing current P0 criterion review cannot establish completion');
 expectOpen(({reviews})=>{reviews['P0-06'].currentCorrectiveReview.phaseScope='PDP-1';},'downstream criterion scope cannot gate PDP-0 completion');
 expectOpen(({reviews})=>{reviews['P0-07'].sourceCutCurrent=false;},'stale criterion review cannot establish completion');
 expectOpen(({inventory})=>{inventory.sourceCutStable=false;},'changed source cut cannot establish completion');
 expectOpen(({handoffs:h})=>{h.push(h[0]);},'duplicate handoff identity cannot establish completion');
 const notRun=buildPdp0DevStatus({mainSha:'fixture',sourceShaSet:{},verification:Object.fromEntries(criteria.map(id=>[id,{status:'PASS',command:`node --test ${id}`,testCount:1,passedTestCount:1,outputSha256:'x',testSourceFingerprints:{'p0.test.mjs':'x'}}])),sourceInventory:completeInventory,exportedHandoffIds:handoffs});
 assert.equal(notRun.status,'IN_PROGRESS','missing stable source-cut evidence cannot establish development completion');
});

test('persisting phase status writes a separate file and preserves the historical 38-task report', () => {
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pdp0-dev-status-'));
 const historicalPath=path.join(temp,'docs/implementation/media-pdp-38-readiness.json');
 fs.mkdirSync(path.dirname(historicalPath),{recursive:true});
 fs.writeFileSync(historicalPath,'historical fixture\n');
 const status={schemaVersion:'media.phase-dev-status.v1',phase:'PDP-0',status:'IN_PROGRESS',sourceShaSet:{}};
 const written=writePdp0DevStatus(status,temp);
 assert.equal(written,path.join(temp,'docs/implementation/pdp-0-phase-dev-status.json'));
 assert.equal(fs.readFileSync(historicalPath,'utf8'),'historical fixture\n');
 assert.deepEqual(JSON.parse(fs.readFileSync(written,'utf8')),status);
 fs.rmSync(temp,{recursive:true,force:true});
});
