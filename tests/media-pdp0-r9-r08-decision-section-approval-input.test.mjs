import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {buildR9R08DecisionSectionMaterial,prepareR9R08ApprovalInput} from '../scripts/prepare-media-pdp0-root-selected-source-integration-r9-r08-approval-input.mjs';
import {prepareR9R08ApplicationPlan} from '../scripts/prepare-media-pdp0-root-selected-source-integration-r9-r08-application-plan.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.resolve(root,'../ghatana-tools/package.json'));
const Ajv2020=require('ajv/dist/2020');
const dir='docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const base=`${dir}/media-pdp0-root-selected-source-integration-r9-r08`;
const sha=value=>createHash('sha256').update(value).digest('hex');
const read=ref=>fs.readFileSync(path.join(root,ref));
function mutatePxd225(text,from,to){
  const start=text.indexOf('### PXD-225');
  const end=text.indexOf('### PXD-226',start);
  assert.ok(start>=0&&end>start,'PXD-225 and next decision headings exist');
  const current=text.slice(start,end);
  assert.ok(current.includes(from),`PXD-225 contains ${from}`);
  return `${text.slice(0,start)}${current.replace(from,to)}${text.slice(end)}`;
}

function schemaValue(schema){
  if(Object.hasOwn(schema,'const'))return structuredClone(schema.const);
  if(Array.isArray(schema.enum))return structuredClone(schema.enum[0]);
  if(schema.type==='object')return Object.fromEntries((schema.required??[]).map(key=>[key,schemaValue(schema.properties[key])]));
  if(schema.type==='array')return schema.prefixItems?schema.prefixItems.map(schemaValue):Array.from({length:schema.minItems??0},()=>schemaValue(schema.items));
  if(schema.type==='string')return schema.pattern?.includes('a-f')?'a'.repeat(64):'test-evidence';
  if(schema.type==='integer'||schema.type==='number')return schema.minimum??0;
  if(schema.type==='boolean')return false;
  throw new Error(`unsupported schema fixture type: ${JSON.stringify(schema)}`);
}

test('R9-R08 approval producer freezes typed PXD-225 sections, separate authority references, and deferred post-authority CAS',()=>{
  const result=prepareR9R08ApprovalInput({check:true});
  const material=result.material;
  assert.equal(material.materialKind,'DECISION_SECTION');
  assert.equal(material.decisionId,'PXD-225');
  assert.equal(material.sections.length,3);
  assert.deepEqual(material.sections.map(section=>section.sectionId),['PXD-225/Decision','PXD-225/Currentness','PXD-225/Boundary']);
  assert.equal(material.pdpAuthoritySectionRefs.length,3);
  assert.deepEqual(material.pdpAuthoritySectionRefs.map(row=>row.ref),[
    '.product-experience/decision-log.md#PXD-225/Authority',
    '.product-experience/authority-map.yaml#canonicalPdpPhases[PDP-0]',
    '.product-experience/authority-map.yaml#phaseAuthorities[PDP-0]',
  ]);
  assert.equal(material.decisionLogCaptureProvenance.wholeFileSha256AtR9R08V1Capture,'0d4c518af9ac6023475467f01711606ab9388ef34ac51b9bb47f917615c89298');
  assert.equal(material.decisionLogCaptureProvenance.wholeFileSha256AtMaterialPreparation,sha(read('.product-experience/decision-log.md')));
  assert.equal(material.decisionLogCaptureProvenance.disposition,'HISTORICAL_CAPTURE_PROVENANCE_ONLY; NOT_THE_POST_AUTHORITY_APPLY_READ_PREIMAGE');
  assert.equal(material.applyReadSetV2.wholeDecisionLogSha256,null);
  assert.equal(material.applyReadSetV2.status,'NOT_CAPTURED_PENDING_AUTHORITY_SECTION_ALLOCATION_AND_RECORD_CHAIN');
  assert.deepEqual(material.authoritySectionBindings.map(row=>row.recordKind),['PDP0_SOURCE_OWNER_DECISION','ROOT_ADOPTION_DECISION','OPERATION_PROFILE_REGISTRATION','DISTINCT_APPLY_AUTHORIZATION']);
  assert.ok(material.authoritySectionBindings.every(row=>row.decisionSelector.status==='NOT_ALLOCATED_BY_DECISION_LOG_OWNER'&&row.decisionSelector.ref===null));
  assert.equal(material.decisionSectionRawPin.semantics,'RAW_SHA256_OF_EXACT_ANCHORED_PXD_SECTION');
  assert.equal(material.decisionSectionRawPin.decisionSectionSha256,material.decisionSectionSha256);
  assert.equal(material.historicalSourceStatusPin.historicalSha256,'cb2d928f85f3f791ac68f85a3d02e80040a19c7c6efb9a0d6bbb4273662e80e9');
  assert.equal(material.historicalSourceStatusPin.matchesCurrentRawSection,false);
  assert.equal(result.input.inputKind,'ROOT_APPROVAL_INPUT_TEMPLATE_NOT_A_DECISION');
  assert.equal(result.input.rootDecision.status,'NOT_SET');
  assert.equal(result.input.canonicalApply,'NONE');
  assert.match(result.input.approvalReadiness,/BLOCKED_PENDING/);
  assert.equal(result.input.fullSemanticReview.reviewStatus,'PASS_FOR_SELECTED_CANDIDATE_SEMANTICS_ONLY_BLOCKED_FOR_CURRENTNESS_AND_AUTHORITY_CHAIN');
  assert.equal(result.input.fullSemanticReview.sha256,sha(read(`${dir}/media-pdp0-root-selected-source-integration-r9-r08.independent-peer.r08-semantic-review.v1.json`)));
  assert.equal(result.input.materialBindingReview.sha256,'5c0c90c4ae7a31a1b7bd3b971c8b071daa1289675fa5327dece745f37239026d');
  assert.ok(result.input.readinessBlockers.some(row=>row.findingId==='R9-R08-SEM-CURRENTNESS-001'));
  assert.equal(result.freeze.authorityBoundary.rootAdoption,'NOT_RECORDED');
});

test('R9-R08 section material rejects missing or ambiguous semantic section anchors and flags stale historical capture provenance',()=>{
  const decisionLogText=read('.product-experience/decision-log.md').toString('utf8');
  const authorityMapText=read('.product-experience/authority-map.yaml').toString('utf8');
  assert.throws(()=>buildR9R08DecisionSectionMaterial({decisionLogText:mutatePxd225(decisionLogText,'**Currentness:**','**Currentness removed:**'),authorityMapText}),/exactly one ordered/);
  assert.throws(()=>buildR9R08DecisionSectionMaterial({decisionLogText:mutatePxd225(decisionLogText,'**Boundary:**','**Decision:**'),authorityMapText}),/exactly one ordered/);
  const stale=buildR9R08DecisionSectionMaterial({decisionLogText,authorityMapText,decisionLogWholeSha256:'f'.repeat(64)});
  assert.equal(stale.decisionLogCaptureProvenance.captureShaMatches,false);
  assert.equal(stale.applyReadSetV2.wholeDecisionLogSha256,null);
});

test('R9-R08 source-owner and root schemas require the exact typed decision and authority material',()=>{
  const result=prepareR9R08ApprovalInput({check:true});
  const ownerSchema=JSON.parse(read(result.refs.ownerSchema));
  const rootSchema=JSON.parse(read(result.refs.rootSchema));
  const applySchema=JSON.parse(read(result.refs.applyAuthorizationSchema));
  const owner=schemaValue(ownerSchema);
  const rootDecision=schemaValue(rootSchema);
  const ajv=new Ajv2020({strict:true});
  const validateOwner=ajv.compile(ownerSchema),validateRoot=ajv.compile(rootSchema),validateApply=ajv.compile(applySchema);
  assert.equal(validateOwner(owner),true,JSON.stringify(validateOwner.errors));
  assert.equal(validateRoot(rootDecision),true,JSON.stringify(validateRoot.errors));
  const apply=schemaValue(applySchema);
  assert.equal(validateApply(apply),true,JSON.stringify(validateApply.errors));
  const reorderedApply=structuredClone(apply);reorderedApply.sourceBaseline.reverse();
  assert.equal(validateApply(reorderedApply),false);
  const wrongOwner=structuredClone(owner);wrongOwner.decisionEvidence.sections[1].sha256='0'.repeat(64);
  assert.equal(validateOwner(wrongOwner),false);
  const wrongRoot=structuredClone(rootDecision);wrongRoot.decisionEvidence.applyReadSetV2.wholeDecisionLogSha256='0'.repeat(64);
  assert.equal(validateRoot(wrongRoot),false);
  assert.equal(owner.decisionSectionSha256,owner.decisionEvidence.decisionSectionRawPin.decisionSectionSha256);
  assert.equal(rootDecision.decisionRef,owner.decisionRef);
});

test('R9-R08 approval candidate artifacts are source-pinned and deterministic on replay',()=>{
  const result=prepareR9R08ApprovalInput({check:true});
  const freeze=JSON.parse(read(result.refs.freeze));
  assert.equal(freeze.candidate.sha256,sha(read(freeze.candidate.ref)));
  assert.equal(freeze.candidateFreeze.sha256,sha(read(freeze.candidateFreeze.ref)));
  assert.equal(freeze.decisionEvidenceMaterial.sha256,sha(read(freeze.decisionEvidenceMaterial.ref)));
  assert.equal(freeze.rootApprovalInput.sha256,sha(read(freeze.rootApprovalInput.ref)));
  assert.equal(freeze.fullSemanticReview.sha256,sha(read(freeze.fullSemanticReview.ref)));
  assert.equal(freeze.fullSemanticReview.semanticStatus,'PASS_FOR_FROZEN_R9_R08_SELECTED_CUT_ONLY');
  assert.equal(freeze.decisionLogCaptureProvenance.captureShaMatches,true);
  assert.equal(freeze.applyReadSetV2.wholeDecisionLogSha256,null);
  assert.equal(freeze.canonicalApply,undefined);
  assert.equal(freeze.authorityBoundary.canonicalSourceWrites,'NONE');
  assert.equal(JSON.parse(read(result.refs.rootInput)).rootDecision.status,'NOT_SET');
});

test('R9-R08 v2 application planner produces a read-only blocked plan until genuine authority inputs and currentness exist',()=>{
  const result=prepareR9R08ApplicationPlan({check:true});
  assert.equal(result.plan.schemaVersion,'media.pdp0.root-selected-source-integration.r9-r08.application-plan.v2');
  assert.equal(result.plan.planDisposition,'BLOCKED_PENDING_AUTHORITY_AND_CURRENTNESS');
  assert.ok(result.plan.blockers.includes('PDP0_STATUS_PIN_OR_CURRENTNESS_NOT_COMPLETE'));
  assert.ok(result.plan.blockers.includes('FOUR_OWNER_ALLOCATED_AUTHORITY_SELECTORS_NOT_AVAILABLE'));
  assert.ok(result.plan.blockers.includes('FOUR_AUTHORITY_RECORD_CHAIN_NOT_COMPLETE'));
  assert.ok(result.plan.blockers.includes('V2_OPERATION_PROFILE_NOT_REGISTERED'));
  assert.ok(result.plan.blockers.includes('FINAL_EXTERNAL_APPLY_READSET_NOT_CAPTURED_AFTER_AUTHORITY_RECORDS'));
  assert.equal(result.plan.sourceReadSet.finalPostAuthorityWholeLogSha256,null);
  assert.equal(result.plan.writeTargets.count,4);
  assert.equal(result.plan.writeTargets.decisionLogIsReadOnly,true);
  assert.equal(result.plan.canonicalApply,'NONE');
  assert.equal(result.plan.phaseStatusEffect,'NONE');
});

