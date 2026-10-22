// Source-derived F00.T02 blocker inventory. Never infer owner acceptance or add trace edges.
const missingPrefix = 'REQUIRED_P1_OPERATION_OMITTED_FROM_TRACE:';
const relationPrefix = 'SOURCE_RELATION_UNRESOLVED:';
const handoffPrefix = 'UNRESOLVED_HANDOFF_SELECTOR:';
function sorted(values) { return [...values].sort((a,b)=>a.localeCompare(b)); }
export function deriveMediaBridgeBlockerInventory(bridge) {
  if(bridge?.schemaVersion!=='media.build-contract-bridge.v1' || bridge?.status!=='INCOMPLETE_SOURCE_RELATIONS' || !Array.isArray(bridge?.identities)) throw new Error('SOURCE_BRIDGE_IDENTITY_REQUIRED');
  const missing=new Map(), relations=[], handoffs=[], unknown=[];
  const unresolvedIds=new Set();
  const items=bridge.identities;
  for(const row of items) {
    for(const reason of row.unresolvedSourceBlockers??[]) {
      unresolvedIds.add(row.id);
      const impact={sourceIdentity:row.id,ownerPackageId:row.ownerAssignments?.[0]?.packageId??null,sourceSelectors:row.sourceRecordSelectors??[]};
      if(reason.startsWith(missingPrefix)) {
        const operationId=reason.slice(missingPrefix.length).split(':').at(-1);
        const edge=Object.values(row.joins??{}).flat().find(x=>x.phase==='PDP-1' && x.id===operationId && x.endpointClassification==='SOURCE_RECORD_NOT_IN_TRACE' && typeof x.targetSelector==='string');
        if(!edge) throw new Error('REQUIRED_P1_OPERATION_SOURCE_SELECTOR_MISSING:'+operationId);
        const entry=missing.get(operationId)??{operationId,sourceSelector:edge.targetSelector,references:[]};
        if(entry.sourceSelector!==edge.targetSelector)throw new Error('OPERATION_ID_MULTIPLE_SOURCE_SELECTORS:'+operationId);
        entry.references.push({...impact,joinedFrom:edge.sourceRef});
        missing.set(operationId,entry);
      } else if(reason.startsWith(relationPrefix)){
        relations.push({...impact,reason,operationId:row.id.split(':').at(-1),repair:'Find exact P0/P1/P3 source-declared relation or formally record a valid terminal/source-only semantic disposition in the owning contract; do not synthesize a new edge'});
      } else if(reason.startsWith(handoffPrefix)){
        handoffs.push({...impact,reason,handoffSelector:reason.split(':').at(-1),repair:'Bind to an actual exact PDP-1 handoff contract selector and independently verify the target exists; do not infer source from name'});
      } else unknown.push({...impact,reason});
    }
  }
  const operationRows=sorted(missing.keys()).map(id=>{
    const x=missing.get(id);
    return {...x,occurrenceCount:x.references.length,referencingPackageIds:sorted(new Set(x.references.map(r=>r.ownerPackageId).filter(Boolean))),requiredRepair:'Admit this existing source-defined operation into the versioned trace only after authoritative identity/ownership/case impact review; retain every explicit referring edge'};
  });
  const unique=(xs)=>xs.sort((a,b)=>a.sourceIdentity.localeCompare(b.sourceIdentity));
  const p1Refs=operationRows.reduce((n,r)=>n+r.occurrenceCount,0);
  return {
    schemaVersion:'media.build-source-bridge-blocker-inventory.v1',
    recordKind:'GENERATED_READ_ONLY_EXACT_SOURCE_JOIN_BLOCKERS_NOT_PDP_MEANING_AUTHORITY',
    sourceBridge:'docs/implementation/MEDIA-BUILD-CONTRACT-BRIDGE.v1.json',
    sourceBridgeStatus:bridge.status,
    stage:'BUILD',phase:'KDEV-STAGE-PLAN-IMPLEMENTATION',selectedTaskId:'M-BLD-F00.T02',
    census:{traceIdentityCount:bridge.census?.identityCount,sourceBridgeEdgeCount:bridge.census?.edgeCount,unresolvedSourceIdentityCount:unresolvedIds.size,p1OperationMissingReferenceCount:p1Refs,uniqueMissingP1OperationCount:operationRows.length,unresolvedCrossLayerRelationCount:relations.length,unresolvedHandoffSelectorCount:handoffs.length,otherReasonCount:unknown.length},
    exactMissingP1Operations:operationRows,unresolvedCrossLayerRelations:unique(relations),unresolvedHandoffSelectors:unique(handoffs),otherUnclassified:unique(unknown),
    ownerDecision:'DO_NOT_HIDE_OR_RELABEL; repair exact source/trace membership, validate real semantic joins, version affected trace denominator and rebuild generated bridge/workpackage projections when material inputs change',
    status:'TECHNICAL_WORK_REMAINING',proofStatus:'NOT_VERIFIED',writesPerformed:false
  };
}