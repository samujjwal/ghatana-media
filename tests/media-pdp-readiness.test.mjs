import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildReadiness, validateTaskPopulation, taskIds } from '../scripts/report-media-pdp-readiness.mjs';
import { buildMediaProductDefinitionResidualReport } from '../scripts/lib/media-product-definition-residuals.mjs';
const audit=JSON.parse(fs.readFileSync('docs/implementation/media-task-completion-blocker-report-2026-10-08.json','utf8'));
const residual=buildMediaProductDefinitionResidualReport();
const build=verification=>buildReadiness({audit,residual,verification,mainSha:'fixture',fingerprints:{}});
test('fixed 38-task scope rejects extras, duplicates and missing tasks',()=>{
  const rows=taskIds.map(id=>({id}));
  validateTaskPopulation(rows);
  for(const bad of [rows.slice(1),[...rows,{id:'E-01'}],rows.map((r,i)=>i===0?rows[1]:r)]) assert.throws(()=>validateTaskPopulation(bad));
});
test('P0-04 source completion never implies dependency completion or original ledger completion',()=>{
  const r=build({'P0-04':{status:'PASS'}});const p=r.tasks.find(t=>t.id==='P0-04');
  assert.equal(p.definitionCriterionSatisfied,true);assert.equal(p.taskSpecificSourceDone,'VERIFIED_IN_CURRENT_SOURCE');
  assert.equal(p.originalFullTaskDone,false);assert.equal(p.overallDone,'partial');assert.equal(p.dependencyReady,'NOT_ESTABLISHED');
  assert.equal(p.nativePhaseProofCurrent,'NOT_EVALUATED');assert.equal(p.independentReviewAccepted,'NOT_EVALUATED');
});
test('historical complete or failed verification cannot manufacture a current source pass',()=>{
  for(const evidence of [{},{'P0-04':{status:'FAIL'}}]) assert.equal(build(evidence).tasks.find(t=>t.id==='P0-04').definitionCriterionSatisfied,false);
  assert.equal(build({}).tasks.find(t=>t.id==='P1-06').taskSpecificSourceDone,'PRIOR_SOURCE_AUDIT_MET_REVALIDATION_REQUIRED');
});
test('live counters preserve receipt uncertainty and dynamic source denominator',()=>{
 const r=build({});assert.equal(r.currentCounters.obligations,residual.lifecycle.obligationCount);
 assert.equal(r.currentCounters.authoritativeReceiptCount,null);assert.equal(r.currentCounters.currentness.status,'NOT_EVALUATED');
 assert.equal(r.taskCount,38);assert.equal(r.phases.length,4);
});
