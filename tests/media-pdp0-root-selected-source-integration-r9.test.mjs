import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import YAML from 'yaml';
import {fileURLToPath} from 'node:url';
import {buildRootSelectedSourceIntegrationR7Postimages, ROOT_SELECTED_R7_TARGETS} from '../scripts/lib/media-pdp0-root-selected-source-integration-projector-r7.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir='docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const ref=name=>`${dir}/${name}`;
const read=r=>fs.readFileSync(path.join(root,r));
const json=r=>JSON.parse(read(r));
const sha=b=>createHash('sha256').update(b).digest('hex');
const canon=value=>Array.isArray(value)?value.map(canon):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canon(value[k])])):value;
const require=createRequire(path.resolve(root,'../ghatana-tools/package.json'));

const r8Freeze=json(ref('media-pdp0-root-selected-source-integration-r8.freeze.v1.json'));
const r8Bundle=json(ref('media-pdp0-root-selected-source-integration-r8.successor-bundle.candidate.v1.json'));
const r8Ledger=json(ref('media-pdp0-root-selected-source-integration-r8.split.allowed-operations.candidate.v1.json'));
const r9Freeze=json(ref('media-pdp0-root-selected-source-integration-r9-r02.freeze.v1.json'));
const r9Bundle=json(ref('media-pdp0-root-selected-source-integration-r9-r02.successor-bundle.candidate.v1.json'));
const r9Ledger=json(ref('media-pdp0-root-selected-source-integration-r9-r02.split.allowed-operations.candidate.v1.json'));
const retained=json(ref('media-pdp0-231-cases-v7-consolidated-projection.v1.json'));

function loadPostimages(freeze){return Object.fromEntries(freeze.selectedPostimages.map(row=>[row.targetRef,read(row.postimageRef)]));}
function currentBase(){const baseline=json(ref('media-pdp0-quality2target-current-source-baseline-2026-10-23.json'));const out={};for(const row of baseline.currentTargets)if(Object.values(ROOT_SELECTED_R7_TARGETS).includes(row.targetRef)){const bytes=read(row.targetRef);assert.equal(sha(bytes),row.sha256,`current baseline ${row.targetRef}`);out[row.targetRef]=bytes;}return out;}

 test('R9 is a candidate-only immutable successor of exact R8 and its source peer',()=>{
  assert.equal(r9Freeze.freezeStatus,'FROZEN_FOR_ACTUAL_H_R02_REVIEW_ONLY');
  assert.equal(r9Freeze.predecessor.ref,ref('media-pdp0-root-selected-source-integration-r8.freeze.v1.json'));
  assert.equal(r9Freeze.predecessor.sha256,sha(read(r9Freeze.predecessor.ref)));
  assert.equal(r9Freeze.actualHReviewR01.reviewStatus,'REQUEST_CHANGES');
  assert.equal(r9Freeze.actualHReviewR01.sha256,sha(read(r9Freeze.actualHReviewR01.ref)));
  assert.equal(r9Bundle.status,'CANDIDATE_ONLY_NOT_REGISTERED_NOT_APPLIED');
  assert.equal(r9Freeze.canonicalApply,'NONE');
  assert.equal(r9Bundle.ownerAdjudicationMutations,0);
  assert.equal(r9Bundle.trustReconstructionMutations,0);
  assert.equal(r9Bundle.historicalOwnerRowsPreserved,462);
  assert.equal(r9Ledger.counts.retainedProjectionOperations,248);
  assert.equal(r9Ledger.counts.predecessorR8Operations,113);
  assert.equal(r9Ledger.counts.r9RepairOperations,9);
  assert.equal(r9Ledger.operations.slice(0,r8Ledger.operations.length).map(x=>JSON.stringify(x)).join('\n'),r8Ledger.operations.map(x=>JSON.stringify(x)).join('\n'));
  assert.equal(new Set(r9Ledger.operations.map(row=>row.operationId)).size,r9Ledger.operations.length);
  const schema=json(r9Freeze.operationSchema.ref);
  const Ajv2020=require('ajv/dist/2020');
  assert.equal(new Ajv2020({strict:true}).compile(schema)(r9Ledger),true);
 });

test('R9 exact semantic replay preserves R8 history and reaches all four frozen postimages',()=>{
  const result=buildRootSelectedSourceIntegrationR7Postimages({baseSources:currentBase(),retainedProjectionOperations:retained.operations,
    operations:r9Ledger.operations,frozenPostimages:loadPostimages(r9Freeze)});
  assert.equal(result.rebuildSemanticallyMatchesFrozenPostimages,true);
  assert.equal(r9Ledger.counts.historicalOwnerRowsPreserved,462);
  const frozenByTarget=new Map(r9Freeze.selectedPostimages.map(row=>[row.targetRef,row.postimageSha256]));
  for(const targetRef of Object.values(ROOT_SELECTED_R7_TARGETS))assert.equal(result.postimageHashes[targetRef],frozenByTarget.get(targetRef));
  const ids=r8Ledger.operations.filter(row=>row.kind==='ADD_CAPABILITY_DEFINITION'&&!['AUD-DIRECT-010','AUD-EDIT-022'].includes(row.auditId)).map(row=>row.capabilityId);
  assert.equal(ids.length,16);
  const caps8=YAML.parse(loadPostimages(r8Freeze)[ROOT_SELECTED_R7_TARGETS.capabilities].toString('utf8'));
  const caps9=YAML.parse(loadPostimages(r9Freeze)[ROOT_SELECTED_R7_TARGETS.capabilities].toString('utf8'));
  for(const id of ids){
    assert.deepEqual(canon(caps9.capabilities.find(row=>row.id===id)),canon(caps8.capabilities.find(row=>row.id===id)),`unrelated feature definition ${id}`);
  }
  const leaf8=loadPostimages(r8Freeze)[ROOT_SELECTED_R7_TARGETS.leaf];
  const leaf9=loadPostimages(r9Freeze)[ROOT_SELECTED_R7_TARGETS.leaf];
  assert.deepEqual(leaf9,leaf8);
});

test('R9 closes the three H findings while keeping preview, approval, and effect outcomes separate',()=>{
  const caps=YAML.parse(read(r9Freeze.selectedPostimages[0].postimageRef).toString('utf8'));
  const reqs=YAML.parse(read(r9Freeze.selectedPostimages[1].postimageRef).toString('utf8'));
  const previewId='media.agent.edit.preview-scope-guard';
  const applyId='media.agent.edit.approval-apply-compensating-rollback';
  const preview=caps.capabilities.find(row=>row.id===previewId);
  const apply=caps.capabilities.find(row=>row.id===applyId);
  assert.ok(apply.ownerDefinition.typedInputSlots.some(row=>row.slotId==='previewResult'&&row.required===true&&row.cardinality==='EXACTLY_ONE'));
  const output=apply.ownerDefinition.successOutputs.find(row=>row.artifactType==='approved-edit-transaction-result');
  for(const field of ['previewResultRef','previewBaseRevision','previewDiffIdentity','previewScope','approvalEvidenceRef','resultingRevision'])assert.ok(output.fields.includes(field));
  assert.equal(output.previewBinding.required,true);
  assert.equal(apply.ownerDefinition.semanticOutcomeContract.acceptanceCriterion,
    YAML.parse(read(r8Freeze.selectedPostimages[0].postimageRef).toString('utf8')).capabilities.find(row=>row.id===applyId).ownerDefinition.semanticOutcomeContract.acceptanceCriterion);
  assert.match(apply.ownerDefinition.semanticOutcomeContract.acceptanceCriterion,/52 typed edit kinds/u);
  const previewPos=preview.acceptanceCases.find(row=>row.polarity==='POSITIVE');
  const applyPos=apply.acceptanceCases.find(row=>row.polarity==='POSITIVE');
  assert.match(previewPos.then,/only the read-only semantic diff plan/u);
  assert.match(previewPos.then,/no approval or effect/u);
  assert.doesNotMatch(previewPos.then,/approved edit transaction|approval evidence|resultingRevision/u);
  assert.match(applyPos.given,/exact preview result/u);
  assert.match(applyPos.then,/authorized effect and is not a dry-run/u);
  assert.doesNotMatch(applyPos.then,/dry-run never commits/u);
  const exactInvocation=new RegExp(`Invoke ${previewId} once`);
  assert.match(previewPos.when,exactInvocation);
  assert.doesNotMatch(previewPos.when,new RegExp(`${previewId}\\.${previewId.replace(/^media\./u,'')}`));
  const parentOps=r9Ledger.operations.filter(row=>row.kind==='APPEND_REQUIREMENT_CASE');
  assert.equal(parentOps.length,58);
  for(const op of parentOps){
    const cap=caps.capabilities.find(row=>row.id===op.sourceCapabilityId);
    const child=cap?.acceptanceCases.find(row=>row.id===op.sourceCapabilityCaseId);
    assert.ok(child,`missing child for ${op.record.id}`);
    assert.equal(op.record.sourceCapabilityId,op.sourceCapabilityId);
    assert.equal(op.record.sourceCapabilityCaseId,op.sourceCapabilityCaseId);
    assert.equal(op.record.polarity,op.polarity);
    assert.equal(op.polarity,child.polarity);
  }
  const repairedParentOps=parentOps.filter(row=>['MEDIA-P0-AUD-DIRECT-010-B_SPLIT_DIRECT-POS','MEDIA-P0-AUD-DIRECT-010-B_SPLIT_DIRECT-NEG','MEDIA-P0-AUD-EDIT-022-B_SPLIT_EDIT-POS','MEDIA-P0-AUD-EDIT-022-B_SPLIT_EDIT-NEG'].includes(row.sourceCapabilityCaseId));
  assert.equal(repairedParentOps.length,4);
  for(const op of repairedParentOps){
    const cap=caps.capabilities.find(row=>row.id===op.sourceCapabilityId);
    const child=cap.acceptanceCases.find(row=>row.id===op.sourceCapabilityCaseId);
    assert.equal(op.record.polarity,child.polarity);
    assert.equal(op.record.sourceCapabilityCaseId,child.id);
    const escapedId=op.sourceCapabilityId.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    assert.equal((op.record.when.match(new RegExp(escapedId,'gu'))??[]).length,1);
  }
  assert.equal(preview.acceptanceCases.filter(row=>row.polarity==='POSITIVE').length,1);
  assert.equal(apply.acceptanceCases.filter(row=>row.polarity==='POSITIVE').length,1);
});
