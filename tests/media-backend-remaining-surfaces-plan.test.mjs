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
