import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMediaGtoolOwnerDispositions } from '../scripts/lib/media-gtool-owner-dispositions.mjs';
const mk=()=>{
 const ids=['F00.T02','F03.T01','F06.T01','F10.T01','L01.T01','L01.T02','L01.T03','L01.T04','V01.T01','V02.T01','V03.T01','V03.T02','V04.T01','V16.T01','V18.T01','V20.T01','V23.T01','V24.T01','V26.T01'].map(x=>'M-BLD-'+x);
 const all=[...ids,...Array.from({length:38},(_,i)=>'M-BLD-X'+String(i%4).padStart(2,'0')+'.T'+String(i).padStart(2,'0'))];
 const projection={schemaVersion:'media.build-work-packages.v1',packages:Array.from({length:50},(_,i)=>({id:'p'+i})),tasks:all.map(id=>({id,packageId:id.split('.T')[0]}))};
 const decision={schemaVersion:'media.gtool-build-owner-dispositions.v1',recordKind:'DELEGATED_OWNER_DECISION_AND_EXECUTION_INPUT_NOT_GTOOL_RECEIPT',
 planExit:{status:'NOT_YET_PROVEN',blockingBuildTasks:ids},
 status:'APPROVED_OWNER_POLICY_TECHNICAL_TASKS_OPEN',
 sourceGaps:{buildContractBridge:{status:'INCOMPLETE_SOURCE_RELATIONS'},pdp0CaseMap:{executableLinks:0},lifecycleAdmission:{nativeReceipts:'NOT_PROVEN'}},
 tasks:ids.map(taskId=>({taskId,disposition:'APPROVE_IMPLEMENTATION_PLANNING_AND_SOURCE_REPAIR',status:'OPEN_TECHNICAL_WORK',
 completionClaim:'NOT_COMPLETE',ownerRepository:'samujjwal/ghatana-media',ownerRole:'Media',
 exactSourceAndTargetAreas:['sources'],implementationDirective:'Implement',acceptanceCriterion:'Evidence',blockingDependencies:'pinned',
 requiredStructuredIO:{input:['source'],output:['result']}}))
 };
 return {decision,projection};
};
test('19 source-specific owner approvals are distinct from Plan Ready',()=>{
 const {decision,projection}=mk();const out=validateMediaGtoolOwnerDispositions(decision,projection);
 assert.equal(out.structuralStatus,'PASS');assert.equal(out.ownerApprovalStatus,'OWNER_SCOPE_DECISIONS_APPROVED');
 assert.equal(out.kernelPlanReady,'NOT_PROVEN');assert.equal(out.remainingTechnicalTaskCount,19);
});
test('refuse counterfeit source completion',()=>{
 const {decision,projection}=mk();decision.tasks[0].completionClaim='COMPLETE';
 const out=validateMediaGtoolOwnerDispositions(decision,projection);
 assert.equal(out.structuralStatus,'FAIL');
 assert.ok(out.errors.some(x=>x.code==='OWNER_TASK_FALSE_COMPLETION_OR_AUTHORITY'));
});
test('refuse missing canonical task and wrong blocker set',()=>{
 const {decision,projection}=mk();projection.tasks[0].id='REMOVED';decision.planExit.blockingBuildTasks.pop();
 const out=validateMediaGtoolOwnerDispositions(decision,projection);
 assert.equal(out.structuralStatus,'FAIL');
 assert.ok(out.errors.some(x=>x.code==='OWNER_TASK_NOT_IN_CANONICAL_WORK_PACKAGE'));
});
