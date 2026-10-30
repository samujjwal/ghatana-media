import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = p => readFileSync(resolve(ROOT, p), 'utf8');
const plan = read('docs/implementation/MEDIA-BACKEND-REMAINING-SURFACES-2026-10-30.md');
const index = JSON.parse(read('docs/implementation/MEDIA-BACKEND-REMAINDER-SOURCE-COVERAGE.v1.json'));
const topology = JSON.parse(read('.product-experience/surfaces/media-physical-topology.v1.json'));

const backendGroups = new Map([
  ['JC', ['libs/common', 4]], ['MC', ['libs/java/common', 5]],
  ['TY', ['libs/audio-video-types', 6]], ['RS', ['modules/intelligence/speech/libs/speech-audio-rust', 7]],
  ['IP', ['modules/infrastructure/persistence', 7]], ['CA', ['modules/infrastructure/cache', 5]],
  ['LD', ['adapters/ledger', 5]], ['AS', ['modules/audio-streaming', 7]],
  ['VS', ['modules/video-streaming', 7]], ['DC', ['adapters/data-cloud-media', 6]],
  ['OC', ['adapters/ocr-compat', 4]], ['AT', ['adapters/agent-tools-media', 6]],
  ['SK', ['libs/audio-video-client', 8]], ['CT', ['modules/integration-tests', 5]],
  ['IT', ['integration-tests', 6]],
]);
const backendTasks = [...plan.matchAll(/^\| \*\*((?:JC|MC|TY|RS|IP|CA|LD|AS|VS|DC|OC|AT|SK|CT|IT)-\d{2})\*\* \| ([^|]+) \| `([^`]+)` \| ([^|]+) \| ([^|]+) \|/gmu)]
  .map(m => ({ id:m[1],deps:m[2].trim(),source:m[3].trim(),action:m[4].trim(),expected:m[5].trim() }));
const logicalTasks = [...plan.matchAll(/^\| \*\*(H-\d{2})\*\* \| ([^|]+) \| ([^|]+) \| ([^|]+) \|/gmu)]
  .map(m => ({id:m[1],deps:m[2].trim(),source:m[3].trim(),expected:m[4].trim()}));
const allTasks = [...backendTasks, ...logicalTasks];
const byId = new Map(allTasks.map(x => [x.id,x]));

function expandDependencies(value) {
  if (value === 'NONE' || value === '—') return [];
  return value.split(',').flatMap(item => {
    const token = item.trim();
    const range = token.match(/^([A-Z]{1,2})-(\d{2})\.\.(?:([A-Z]{1,2})-)?(\d{2})$/u);
    if (!range) return [token];
    const start = Number(range[2]), end = Number(range[4]), targetPrefix = range[3] || range[1];
    assert.equal(targetPrefix, range[1], 'cannot span prefixes: ' + token);
    assert.ok(end >= start && end <= 99, 'invalid dependency range ' + token);
    return Array.from({length:end-start+1}, (_,i) => range[1]+'-'+String(start+i).padStart(2,'0'));
  });
}

test('all 29 physical, 19 remaining and 21 logical consumers accounted without duplicate identities', () => {
  assert.equal(topology.manifestCandidates.length,29);
  assert.equal(topology.consumerCrosswalk.length,21);
  assert.equal(index.physicalSurfaces.length,29);
  assert.equal(index.logicalConsumers.length,21);
  assert.deepEqual(index.physicalSurfaces.map(x=>x.id),topology.manifestCandidates.map(x=>x.surfaceId));
  assert.deepEqual(index.logicalConsumers.map(x=>x.id),topology.consumerCrosswalk.map(x=>x.surfaceId));
  const categories = index.physicalSurfaces.reduce((a,x)=>(a[x.lane]=(a[x.lane]||0)+1,a),{});
  assert.deepEqual(categories,{
    PREVIOUS_WAVES_NOT_REEVALUATED:10, W3_BACKEND_SCOPE:15, NONBACKEND_HANDOFF:4,
  });
  assert.equal(index.counts.remainingPhysical,19);
  assert.equal(index.counts.localBackendTasks,88);
  assert.equal(index.counts.additionalLogicalOutcomeTasks,8);
  assert.ok(plan.includes('## 5. Whole-remaining physical applicability and explicit non-backend handoff'));
});

test('88 named backend tasks and eight headless outcomes have exact nonduplicated IDs and concrete checks',()=>{
  assert.equal(backendTasks.length,88);
  assert.equal(logicalTasks.length,8);
  assert.equal(byId.size,96);
  for(const [prefix,[path,count]] of backendGroups){
    const expected=Array.from({length:count},(_,i)=>prefix+'-'+String(i+1).padStart(2,'0'));
    const group=backendTasks.filter(x=>x.id.startsWith(prefix+'-'));
    assert.deepEqual(group.map(x=>x.id),expected);
    const physical=index.physicalSurfaces.find(x=>x.path===path);
    assert.equal(physical.workPrefix,prefix);
    assert.ok(plan.includes(physical.id), 'missing physical ID '+physical.id);
    for(const task of group) {
      assert.ok(task.source.startsWith(path+'/'), task.id+' not in Media code owner path');
      assert.ok(task.action.length>=50,task.id+' action too vague');
      assert.ok(task.expected.length>=35,task.id+' assertion too vague');
      assert.ok(!task.action.includes('update gtool status'),task.id+' implementation mixed into closure');
    }
  }
  assert.deepEqual(logicalTasks.map(x=>x.id),Array.from({length:8},(_,i)=>'H-'+String(i+1).padStart(2,'0')));
});

test('all local backend and headless dependencies resolve and form one acyclic graph',()=>{
  const visiting = new Set(),visited = new Set();
  const dfs = id => {
    if (visited.has(id)) return;
    assert.ok(!visiting.has(id),'cycle at '+id);
    visiting.add(id);
    for(const predecessorId of expandDependencies(byId.get(id).deps)){
      assert.ok(byId.has(predecessorId),id+' -> unknown '+predecessorId);
      dfs(predecessorId);
    }
    visiting.delete(id);visited.add(id);
  };
  for(const task of allTasks)dfs(task.id);
  assert.equal(visited.size,96);
});

test('source-derived coverage rows exactly match remaining PDP-0 surface membership and selected owner tasks',()=>{
  const expected=[];
  for(const physical of topology.manifestCandidates){
    const selected=index.physicalSurfaces.find(x=>x.id===physical.surfaceId);
    if(selected.lane==='PREVIOUS_WAVES_NOT_REEVALUATED')continue;
    const capabilities=physical.phaseApplicability['PDP-0']?.capabilityIntentIds||[];
    capabilities.forEach((capabilityId,sourceOrdinal)=>expected.push({
      surfaceId:physical.surfaceId,sourcePath:physical.sourcePath,sourceOrdinal,capabilityId
    }));
  }
  assert.equal(expected.length,602);
  assert.equal(index.sourceCapabilityMemberships.length,602);
  for(let i=0;i<602;i++){
    const row=index.sourceCapabilityMemberships[i],source=expected[i];
    for(const field of Object.keys(source))assert.equal(row[field],source[field],field+' drift at '+i);
    const physical=index.physicalSurfaces.find(x=>x.id===row.surfaceId);
    if(physical.lane==='W3_BACKEND_SCOPE'){
      assert.ok(byId.has(row.workOwnerTaskId),row.capabilityId+' unassigned to task');
      assert.ok(row.workOwnerTaskId.startsWith(physical.workPrefix+'-'),'wrong surface owner');
    }else{
      assert.equal(row.workOwnerTaskId,null,'deferred UI claimed a backend owner');
    }
  }
  assert.equal(index.sourceCapabilityMemberships.filter(x=>x.workOwnerTaskId).length,399);
  assert.equal(index.sourceCapabilityMemberships.filter(x=>!x.workOwnerTaskId).length,203);
});

test('all 21 consumer references match topology and only source-defined physical hosts',()=>{
  const physicalIds=new Set(topology.manifestCandidates.map(x=>x.surfaceId));
  for(let i=0;i<21;i++){
    const consumer=index.logicalConsumers[i],canonical=topology.consumerCrosswalk[i];
    assert.equal(consumer.id,canonical.surfaceId);
    assert.deepEqual(consumer.physicalRefs,canonical.physicalRefs);
    assert.ok(consumer.physicalRefs.every(ref=>physicalIds.has(ref)));
    assert.ok(plan.includes('`'+consumer.id+'`'),consumer.id+' omitted from human handoff');
  }
  for(const id of ['media.surface.recorder-orchestrator','media.surface.capture-adapters',
    'media.surface.production-studio','media.surface.interactive-demo-player']){
      assert.ok(index.logicalConsumers.some(x=>x.id===id),'missing specialized consumer '+id);
  }
});

test('production spec, animation and simulation are source-bound and do not infer Explorer scientific proof',()=>{
  for(const file of [
    '.product-experience/pdp-1-domain-data/declarative-production-contracts.yaml',
    '.product-experience/pdp-1-domain-data/recorder-studio-contracts.yaml',
    '.product-experience/pdp-2-design-interface-system/animation-simulation-grammar.yaml',
    '.product-experience/pdp-3-product-experience/declarative-production-experience.yaml',
    '.product-experience/pdp-3-product-experience/demo-recording-standard.yaml'
  ]) { assert.ok(read(file).length>100,file+' missing'); }
  assert.match(plan,/EXPLORER_SIMULATED/u);
  assert.match(plan,/a=3 m\/s², v=6 m\/s, x=6 m/u);
  assert.match(plan,/one canonical project revision/u);
  assert.match(plan,/a declared animation frame is NOT a simulation proof/u);
  assert.match(plan,/NOT_ADMITTED/u);
});

test('no Wave2, formal PDP or operational status is laundered into backend completion',()=>{
  assert.match(plan,/22 locally verified \/ 30 partial \/ 6 external-owner/u);
  assert.match(plan,/GH-90000/u);
  assert.match(plan,/Checkstyle/u);
  assert.match(plan,/Track B/u);
  assert.match(plan,/VerifyIntentionalPublicApiTask/u);
  assert.match(plan,/V009→V018/u);
  assert.match(plan,/no PDP0–3 phase closure/u);
  assert.match(plan,/no operational writer cutover/u);
  assert.match(index.recordKind,/NOT_PDP_MEANING_OR_LIFECYCLE_TASK_AUTHORITY/u);
  assert.match(plan,/Do not copy.+private Ghatana repos|public repository/u);
});


test('Wave 2 unfinished 36 task IDs, owner actions, statuses and preserved 22 are exact R8/R10 projections',()=>{
  const r8 = JSON.parse(read('docs/implementation/MEDIA-WAVE2-R8-FULL-ACCEPTANCE-MATRIX.json'));
  const r10 = JSON.parse(read('docs/implementation/MEDIA-WAVE2-R10-OWNER-BLOCKER-RESOLUTION.json'));
  const rows = r8.rows;
  const r10Rows = new Map(r10.remainingTasks.map(row => [row.taskId,row]));
  const continuation = index.wave2Continuation;
  const table = [...plan.matchAll(/^\| \*\*((?:STT|TTS|VIS|MM|OBS)-\d{2})\*\* \| (PARTIAL|OWNER_EXTERNAL) \/ NOT_ACCEPTED \|/gmu)]
    .map(match => ({id: match[1], status: match[2]}));
  assert.equal(rows.length,36);
  assert.equal(continuation.unfinishedOriginalTasks.length,36);
  assert.equal(table.length,36);
  assert.deepEqual(table,rows.map(row => ({id:row.id,status:row.currentStatus})));
  assert.deepEqual(continuation.preservedVerifiedOriginalIds,r8.preservedVerifiedTaskIds);
  assert.equal(r8.preservedVerifiedTaskIds.length,22);
  assert.equal(r8.taskCount.total,58);
  assert.deepEqual(continuation.lastAcceptedStatus,{
    allOriginal:58,previouslyLocallyVerified:22,partial:30,ownerExternal:6,stillUnaccepted:36,
    changeFromThisPlan:0,
  });
  for(let i=0;i<36;i++){
    const expected=rows[i], mapped=r10Rows.get(expected.id), joined=continuation.unfinishedOriginalTasks[i];
    assert.ok(mapped,expected.id+' absent from R10 owner map');
    assert.equal(expected.taskAccepted,false);
    assert.equal(mapped.taskAccepted,false);
    assert.equal(joined.id,expected.id);
    assert.equal(joined.originalR8RowIndex,i);
    assert.equal(joined.lastRecordedStatus,expected.currentStatus);
    assert.equal(joined.lastRecordedTaskAccepted,false);
    assert.deepEqual(joined.originalDependencyIds,expected.dependencyIds);
    assert.deepEqual(joined.r10GateIds,mapped.unblockingGateIds);
    assert.equal(joined.accountableOwnerRole,mapped.executionOwnership.accountableMediaRole);
    assert.equal(joined.lastOwnerNextAction,mapped.currentCompletionStep?.action
      ||mapped.firstCodeAction||expected.firstUnblockingImplementation);
    assert.equal(joined.independentAcceptanceAlreadyProven,false);
    assert.equal(joined.noPromotionFromSourceOnly,true);
    assert.ok(joined.originalWholeRowProofRef.includes('/rows/'+i+'/independentAcceptanceProof'));
  }
  assert.deepEqual(continuation.twelveExistingGateIds,
    r10.implementationGates.map(g=>g.id));
  assert.equal(new Set(continuation.twelveExistingGateIds).size,12);
  assert.match(continuation.recordKind,/NOT_CANONICAL_TASK_OR_ACCEPTANCE_REGISTRY/u);
});

test('cross-wave acceptance edges are valid and do not convert negative coding into a global Wave 2 block',()=>{
  const r8=JSON.parse(read('docs/implementation/MEDIA-WAVE2-R8-FULL-ACCEPTANCE-MATRIX.json'));
  const ids=new Set([...r8.preservedVerifiedTaskIds,...r8.rows.map(row=>row.id)]);
  assert.equal(ids.size,58);
  const edges=index.wave2Continuation.crossWaveAcceptanceAndOwnerLockEdges;
  assert.ok(edges.length>=16);
  const signatures=new Set();
  for(const edge of edges){
    assert.ok(ids.has(edge.fromTaskId),'unknown original Wave 2 task '+edge.fromTaskId);
    assert.ok(byId.has(edge.toTaskId),'unknown Wave 3/H task '+edge.toTaskId);
    assert.ok(['CONTRACT_PARITY','FILE_OWNER_LOCK','REAL_EFFECT_PROOF'].includes(edge.type));
    assert.equal(edge.doesNotBlockIndependentCoding,true,'must keep negative/contract tests unblocked');
    assert.ok(edge.acceptanceCondition.length>=35,'missing integration condition');
    const signature=edge.fromTaskId+' -> '+edge.toTaskId;
    assert.ok(!signatures.has(signature),'duplicate cross-wave edge '+signature);
    signatures.add(signature);
  }
  assert.equal(index.counts.combinedSelectedOutstandingWorkItems,132);
  assert.equal(index.counts.wave2UnacceptedTaskCount,36);
  assert.equal(index.counts.wave2PreservedVerifiedTaskCount,22);
  assert.equal(index.counts.crossWaveCoordinationEdges,edges.length);
  assert.match(plan,/Implementation selection count = 132 unfinished or not-yet-verified local work items/u);
  assert.match(plan,/not a second writable task ledger/u);
  assert.match(plan,/36 unaccepted task rows/u);
});


test('reported green commit reconciliation is honest and preserves all original task identities', () => {
  const report = index.reportedEngineeringPulse;
  assert.match(report.recordKind,/OWNER_REPORTED_IMPLEMENTATION_HANDOFF/u);
  assert.equal(report.userReportedCommitCount,19);
  assert.equal(report.suppliedUniqueHashPrefixCount,18);
  assert.equal(report.missingReportedCommitHashCount,1);
  assert.equal(report.confirmedSuppliedHashPrefixesReachableOnConnectedGithubAtReview,0);
  assert.equal(report.commitClaims.length,18);
  const claimed = report.commitClaims.flatMap(x=>x.taskIds);
  assert.equal(claimed.length,24);
  assert.equal(new Set(claimed).size,24);
  assert.deepEqual(report.namedTaskIds,claimed);
  assert.equal(report.reportedTaskCount,24);
  assert.equal(report.otherWave3TaskCount,72);
  assert.equal(report.perLocalTaskReadback.length,96);
  const taskIds=new Set([...backendTasks,...logicalTasks].map(x=>x.id));
  for(const claim of report.commitClaims){
    assert.match(claim.claimedHashPrefix,/^[0-9a-f]{8}$/u);
    assert.equal(claim.reportedCommitPresence,'NOT_RETRIEVABLE_VIA_CONNECTED_GITHUB_MAIN_AS_OF_REVIEW');
    assert.ok(claim.reportedChange.length>=12);
    for(const taskId of claim.taskIds)assert.ok(taskIds.has(taskId),'invented reported task '+taskId);
  }
  assert.deepEqual(report.perLocalTaskReadback.map(x=>x.taskId),
    [...backendTasks,...logicalTasks].map(x=>x.id));
  const reported=report.perLocalTaskReadback.filter(x=>x.claimedCommitHashPrefix);
  const notIndividuallyMapped=report.perLocalTaskReadback.filter(x=>!x.claimedCommitHashPrefix);
  assert.equal(reported.length,24);
  assert.equal(notIndividuallyMapped.length,72);
  for(const row of report.perLocalTaskReadback){
    assert.ok(taskIds.has(row.taskId));
    assert.equal(row.actualCodeAcceptance,'NOT_REASSESSED_ON_CURRENT_USER_LOCAL_CHECKOUT');
    assert.equal(row.reviewDisposition,'DO_NOT_REIMPLEMENT_BEFORE_SOURCE_AND_TEST_READBACK');
  }
  assert.ok(plan.includes('## 14. Current engineering residual readback'));
  assert.match(plan,/18 distinct abbreviated commit hashes/u);
  assert.match(plan,/other \*\*72\*\* of the existing/u);
  assert.match(plan,/REPORTED_COMPLETED_PENDING_GIT_AND_TEST_READBACK/u);
});

test('remaining real integration, Wave 2, Track B and external ownership gates remain explicit',()=>{
  const reported=index.reportedEngineeringPulse;
  assert.equal(index.wave2Continuation.unfinishedOriginalTasks.length,36);
  assert.equal(index.wave2Continuation.lastAcceptedStatus.changeFromThisPlan,0);
  assert.deepEqual(reported.externalOwnerFacts.map(x=>x.id),['G09','G10']);
  assert.ok(reported.externalOwnerFacts.every(x=>x.observedState==='OPEN'));
  for(const [taskId,expected] of [
    ['AS-07','REAL_TRANSPORT_RUNTIME_AND_PERFORMANCE_TARGET_UNAVAILABLE'],
    ['VS-07','REAL_TRANSPORT_RUNTIME_AND_PERFORMANCE_TARGET_UNAVAILABLE'],
    ['H-08','SYNTHETIC_ONLY_CAPTURE_NOT_QUALIFIED_LIVE_PRODUCT_FILM'],
    ['AS-06','FIVE_TRANSPORT_AND_LEASE_INTENTS_NOT_ADMITTED'],
    ['VS-05','EXTERNAL_REAL_TRANSPORT_PROFILES_UNQUALIFIED'],
    ['DC-04','GHATANA_DATA_CLOUD_PUBLIC_SOURCE_READBACK_AND_RECEIPT_EXTERNAL'],
    ['OC-04','GHATANA_DI_252_PUBLIC_CLIENT_EXTERNAL'],
  ]){
    const item=reported.perLocalTaskReadback.find(x=>x.taskId===taskId);
    assert.ok(item);
    assert.equal(item.ownerProofGap,expected);
  }
  for(const phrase of [
    'FLEURS', 'STT-10/12', 'OBS-07/08', 'VIS-03',
    'Ghatana DI #252', 'Ghatana Data/Action/Event Plane #254',
    'GH-90000', 'AS-07', 'VS-07', 'Track B', 'not a second writable task ledger'
  ]) assert.ok(plan.includes(phrase),'missing gate or status '+phrase);
  assert.match(plan,/no operational writer cutover/u);
  assert.ok(!reported.nonClaims.includes('GTOOL_CLOSED'));
  assert.ok(reported.nonClaims.includes('NOT_GTOOL_CLOSURE'));
});
