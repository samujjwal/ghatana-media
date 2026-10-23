import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveMediaBridgeBlockerInventory } from '../scripts/lib/media-build-bridge-blocker-inventory.mjs';
const fixture=()=>({schemaVersion:'media.build-contract-bridge.v1',status:'INCOMPLETE_SOURCE_RELATIONS',census:{identityCount:3,edgeCount:2},identities:[
 {id:'PDP-0:capability:upload',ownerAssignments:[{packageId:'M-BLD-V02'}],sourceRecordSelectors:['source.yaml#capability'],joins:{p1Operation:[{phase:'PDP-1',id:'op.upload',endpointClassification:'SOURCE_RECORD_NOT_IN_TRACE',targetSelector:'ops.yaml#operations/@id=op.upload',sourceRef:'ops.yaml#capBinding'}]},unresolvedSourceBlockers:['REQUIRED_P1_OPERATION_OMITTED_FROM_TRACE:upload:op.upload']},
 {id:'PDP-1:operations:op.other',ownerAssignments:[{packageId:'M-BLD-F03'}],sourceRecordSelectors:['ops.yaml#operations/@id=op.other'],unresolvedSourceBlockers:['SOURCE_RELATION_UNRESOLVED:PDP-1:operations:op.other']},
 {id:'PDP-2:p2-components:comp',ownerAssignments:[{packageId:'M-BLD-F10'}],sourceRecordSelectors:['component.yaml#comp'],unresolvedSourceBlockers:['UNRESOLVED_HANDOFF_SELECTOR:comp:media.handoff.identity']}
]});
test('retains precise missing source operation and separate relation/handoff blockers',()=>{const r=deriveMediaBridgeBlockerInventory(fixture());assert.equal(r.census.p1OperationMissingReferenceCount,1);assert.equal(r.census.uniqueMissingP1OperationCount,1);assert.equal(r.census.unresolvedCrossLayerRelationCount,1);assert.equal(r.census.unresolvedHandoffSelectorCount,1);assert.equal(r.proofStatus,'NOT_VERIFIED');});
test('cannot invent an operation identity without real source selector',()=>{const f=fixture();f.identities[0].joins.p1Operation=[];assert.throws(()=>deriveMediaBridgeBlockerInventory(f),/SOURCE_SELECTOR_MISSING/);});
test('no terminal success when bridge still has blockers',()=>{const r=deriveMediaBridgeBlockerInventory(fixture());assert.equal(r.status,'TECHNICAL_WORK_REMAINING');assert.equal(r.writesPerformed,false);});
test('current bridge emits a zero-blocker inventory without claiming task acceptance',()=>{
 const f=fixture();f.status='SOURCE_RELATIONS_CURRENT';f.identities.forEach(row=>row.unresolvedSourceBlockers=[]);
 const r=deriveMediaBridgeBlockerInventory(f);
 assert.equal(r.status,'SOURCE_RELATIONS_CURRENT');assert.equal(r.sourceBridgeStatus,'SOURCE_RELATIONS_CURRENT');
 assert.equal(r.census.unresolvedSourceIdentityCount,0);assert.equal(r.census.unresolvedSourceBlockerCount,0);
 assert.equal(r.census.p1OperationMissingReferenceCount,0);assert.equal(r.census.unresolvedCrossLayerRelationCount,0);
 assert.equal(r.census.unresolvedHandoffSelectorCount,0);assert.equal(r.census.otherReasonCount,0);
 assert.deepEqual(r.exactMissingP1Operations,[]);assert.deepEqual(r.unresolvedCrossLayerRelations,[]);
 assert.deepEqual(r.unresolvedHandoffSelectors,[]);assert.deepEqual(r.otherUnclassified,[]);
 assert.equal(r.taskCompletionStatus,'NOT_EVALUATED');assert.equal(r.proofStatus,'NOT_VERIFIED');assert.equal(r.writesPerformed,false);
});
test('rejects a bridge status that contradicts its unresolved source blockers',()=>{
 const currentWithBlockers=fixture();currentWithBlockers.status='SOURCE_RELATIONS_CURRENT';
 assert.throws(()=>deriveMediaBridgeBlockerInventory(currentWithBlockers),/CURRENT_WITH_UNRESOLVED_BLOCKERS/);
 const incompleteWithoutBlockers=fixture();incompleteWithoutBlockers.status='INCOMPLETE_SOURCE_RELATIONS';
 incompleteWithoutBlockers.identities.forEach(row=>row.unresolvedSourceBlockers=[]);
 assert.throws(()=>deriveMediaBridgeBlockerInventory(incompleteWithoutBlockers),/INCOMPLETE_WITHOUT_BLOCKERS/);
});
