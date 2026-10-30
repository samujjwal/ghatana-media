import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = file => readFileSync(resolve(ROOT, file), 'utf8');
const plan = read('docs/implementation/MEDIA-BACKEND-TERMINAL-QUALIFICATION-2026-10-30.md');
const index = JSON.parse(read('docs/implementation/MEDIA-BACKEND-REMAINDER-SOURCE-COVERAGE.v1.json'));
const r8 = JSON.parse(read('docs/implementation/MEDIA-WAVE2-R8-FULL-ACCEPTANCE-MATRIX.json'));
const r10 = JSON.parse(read('docs/implementation/MEDIA-WAVE2-R10-OWNER-BLOCKER-RESOLUTION.json'));
const readback = JSON.parse(read('docs/implementation/evidence/media-backend-remaining-qualification-readback-20261030.v1.json'));
const support = read('modules/audio-streaming/src/main/java/com/ghatana/audio/streaming/StreamIntentSupport.java');

test('all 36 existing Wave 2 R8 IDs are mapped to full original source, owner, prerequisites and independent oracles', () => {
  const rows = [...plan.matchAll(/^\| \*\*((?:STT|TTS|VIS|MM|OBS)-\d{2})\*\* · (PARTIAL|OWNER_EXTERNAL) · ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|/gmu)]
    .map(m => ({id:m[1], status:m[2], owner:m[3], source:m[4], instruction:m[5], oracle:m[6]}));
  assert.equal(rows.length,36);
  assert.equal(new Set(rows.map(r=>r.id)).size,36);
  const same = x=>x.replaceAll('|','\\|').replace(/\s+/gu,' ').trim();
  const byId=new Map(rows.map(x=>[x.id,x]));
  const byR10=new Map(r10.remainingTasks.map(x=>[x.taskId,x]));
  for (const original of r8.rows) {
    const row=byId.get(original.id);
    assert.ok(row,'missing Wave 2 ID '+original.id);
    assert.equal(row.status,original.currentStatus);
    assert.ok(row.owner.includes(byR10.get(original.id).executionOwnership.accountableMediaRole));
    assert.ok(row.source.includes('R8 predecessors'),original.id+' missing original dependencies');
    assert.ok(row.source.includes('R10 gates'),original.id+' missing current gates');
    assert.ok(row.source.includes(same(original.requiredInputs).slice(0,60)),original.id+' missing input');
    assert.ok(row.oracle.includes(same(original.independentAcceptanceProof)),original.id+' missing independent proof');
    assert.ok(row.oracle.includes(same(original.originalAcceptance)),original.id+' missing full original acceptance');
    assert.ok(row.instruction.includes('Original work:'),original.id+' no exact instruction');
    assert.ok(row.instruction.includes('First remaining action:'),original.id+' no current owner next action');
  }
  assert.equal(r8.rows.filter(x=>x.currentStatus==='PARTIAL').length,30);
  assert.equal(r8.rows.filter(x=>x.currentStatus==='OWNER_EXTERNAL').length,6);
  assert.equal(r8.preservedVerifiedTaskIds.length,22);
  assert.deepEqual(index.wave2Continuation.lastAcceptedStatus,{
    allOriginal:58,previouslyLocallyVerified:22,partial:30,ownerExternal:6,stillUnaccepted:36,
    changeFromThisPlan:0,
  });
});

test('the seventeen terminal qualification work packages are unique, concrete and acyclic', () => {
  const rows=[...plan.matchAll(/^\| \*\*(Q\d{2})\*\* — ([^;]+); `([^`]+)` \| ([^|]+) \| ([^|]+) \| ([^|]+) \|/gmu)]
    .map(m=>({id:m[1],owner:m[2],depends:m[3],action:m[4],proof:m[5],fallback:m[6]}));
  assert.deepEqual(rows.map(x=>x.id),Array.from({length:17},(_,i)=>'Q'+String(i).padStart(2,'0')));
  const byId=new Map(rows.map(x=>[x.id,x])), visiting=new Set(),seen=new Set();
  function visit(id) {
    if(seen.has(id))return;
    assert.ok(!visiting.has(id),'cycle at '+id);
    visiting.add(id);
    const item=byId.get(id);
    for(const dep of item.depends==='none'?[]:item.depends.split(',')){
      assert.ok(byId.has(dep),id+' unknown predecessor '+dep);
      visit(dep);
    }
    visiting.delete(id);seen.add(id);
  }
  for(const row of rows){
    visit(row.id);
    assert.ok(row.action.length>=100,row.id+' action too short');
    assert.ok(row.proof.length>=55,row.id+' proof too short');
    assert.ok(row.fallback.length>=55,row.id+' safe alternate missing');
  }
  assert.equal(seen.size,17);
  assert.deepEqual(index.postPushReadback.qualificationPackageIds,rows.map(x=>x.id));
});

test('all 58 + 96 original task identities are accounted for but not falsely accepted',()=>{
  assert.equal(r8.taskCount.total,58);
  assert.equal(index.postPushReadback.originalWave2UnacceptedRows.length,36);
  assert.equal(index.postPushReadback.currentWave3HOriginalIds.length,96);
  assert.equal(index.postPushReadback.remainingOriginalTaskCounts.scopeTotalRequiredReadback,132);
  assert.equal(index.postPushReadback.originalWave2PreservedVerifiedCount,22);
  const w3 = index.reportedEngineeringPulse.perLocalTaskReadback.map(x=>x.taskId);
  assert.deepEqual(index.postPushReadback.currentWave3HOriginalIds.map(x=>x.taskId),w3);
  assert.ok(index.postPushReadback.currentWave3HOriginalIds.every(x=>x.independentlyAcceptedFromThisPlan===false));
  assert.ok(index.postPushReadback.originalWave2UnacceptedRows.every(x=>x.acceptedByThisPlan===false));
  assert.match(plan,/zero unfinished required backend|zero unassigned known obligations/u);
  assert.match(plan,/zero unassigned known obligations/u);
});

test('source-verified post-push reads all prior 18 claimed commit prefixes and preserves qualified host runs',()=>{
  const old=index.reportedEngineeringPulse,newer=index.postPushReadback;
  assert.equal(old.commitClaims.length,18);
  assert.equal(newer.formerlyMissingClaimedPrefixes,18);
  assert.equal(newer.nowReachableClaimedPrefixes,18);
  assert.equal(newer.missingClaimedPrefixes,0);
  assert.match(newer.originalReportPrePushStatus,/HISTORICAL_SUPERSEDED/u);
  assert.equal(readback.qualificationRuns.length,6);
  const native=readback.qualificationRuns.filter(x=>x.gate.includes('run-wave2-vision-oci-checks.sh'));
  assert.equal(native.length,4);
  for(const [i,n] of [4,3,3,4].entries())assert.ok(native[i].result.includes('PASS '+n+'/'+n));
  assert.ok(readback.qualificationRuns.some(x=>x.gate.includes('alert-delivery-smoke.sh')&&x.result.includes('fired AND resolved')));
  assert.ok(readback.qualificationRuns.some(x=>x.originalTaskIds.includes('IT-05')&&x.result.includes('All 9')));
  assert.match(plan,/OBS-08 is capacity/u);
  assert.match(plan,/nine skipped Compose tests are now/u);
});

test('five exact PDP stream intent gaps and real AS-07/VS-07 are never silently accepted',()=>{
  const five=[
    'media.stream.lease.renew',
    'media.stream.transport.webrtc',
    'media.stream.transport.adaptive-http',
    'media.stream.transport.hls',
    'media.stream.transport.dash',
  ];
  for(const id of five) {
    assert.ok(support.includes('notAdmitted("'+id+'"'),'source changed, refresh stream gate: '+id);
    assert.ok(plan.includes('`'+id+'`'),'plan omitted source intent '+id);
  }
  assert.match(plan,/RealAuthorizedAudioTransportIT/u);
  assert.match(plan,/RealAuthorizedVideoTransportIT/u);
  assert.match(plan,/12,000 tiny string bytes in-process/u);
  assert.match(plan,/10,000 tiny/u);
  assert.match(plan,/NOT_ADMITTED.*not.*terminal completion/u);
});

test('no prohibited legal/owner status, external public contract or source profile is manufactured',()=>{
  const required=['FLEURS','Ghatana #254','Ghatana #252','STT-10','STT-12','OBS-07','OBS-08','H-08','IT-04','32','c1→c16→c64','voice','rights','Track B','zero-orphan'];
  for(const id of required)assert.ok(plan.includes(id),'missing real qualifier '+id);
  assert.match(plan,/cannot be created by engineering instruction/u);
  assert.match(plan,/not completion of an applicable mandatory intent|not terminal completion/u);
  assert.match(plan,/No additional code duplication/u);
  assert.ok(index.postPushReadback.separateTrackB);
  assert.match(index.postPushReadback.terminalClaim,/NOT_ACCEPTED_ALL_ROWS/u);
});

test('source-bound plan and results remain correct after changes; no new phase statuses',()=>{
  assert.match(plan,/exact original task IDs/u);
  assert.match(plan,/Only the owning canonical R8\/PDP status authority/u);
  assert.match(plan,/source SHA, lawful rights/u);
  const evidence=read('docs/implementation/MEDIA-WAVE2-COMPLETION-EXECUTION-2026-10-29.md');
  assert.ok(evidence.includes('22/30/6'),'historic R8 ledger changed unexpectedly');
  assert.match(plan,/GH-90000/u);
  assert.match(plan,/no performance PASS from proposed NFR budgets alone/u);
});
