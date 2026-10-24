import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {fingerprintPxdDecisionSection} from '../scripts/lib/pdp0-phase-scoped-source-fingerprints.mjs';
import {R9R08_V2_READ_SET,R9R08_V2_WRITE_TARGETS} from '../scripts/lib/media-pdp0-root-selected-source-integration-r9-r08-v2-guard.mjs';
import {R9R08_V3_EFFECT,R9R08_V3_PROFILE_ID,R9R08_V3_ROLES,R9R08_V3_POLICY_REF,R9R08_V3_POLICY_SHA256,
  R9R08_V3_ROOT_DECISION_REF,R9R08_V3_ROOT_DECISION_SHA256,R9R08_V3_DELEGATION_REF,R9R08_V3_REVOCATION_REF,
  R9R08_V3_SEMANTIC_SELECTOR,R9R08_V3_DELEGATION_SECTION_ID,R9R08_V2_GUARD_BASELINE_SHA256,validateR9R08V3TechnicalSourceDelegation} from '../scripts/lib/media-pdp0-root-selected-source-integration-r9-r08-v3-technical-guard.mjs';
import {requireR9R08V2TrustedActors} from '../scripts/lib/media-pdp0-root-selected-source-integration-r9-r08-v2-guard.mjs';

const repoRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const candidateRef='docs/implementation/observations/media-pdp0-parent-case-resolution-candidates/media-pdp0-root-selected-source-integration-r9-r08.successor-bundle.candidate.v1.json';
const freezeRef='docs/implementation/observations/media-pdp0-parent-case-resolution-candidates/media-pdp0-root-selected-source-integration-r9-r08.freeze.v1.json';
const materialRef='docs/implementation/observations/media-pdp0-parent-case-resolution-candidates/media-pdp0-root-selected-source-integration-r9-r08.decision-section-material.r5.candidate.v1.json';
const semanticReviewRef='docs/implementation/observations/media-pdp0-parent-case-resolution-candidates/media-pdp0-root-selected-source-integration-r9-r08.independent-peer.r08-semantic-review.v1.json';
const rootDecisionRepoPath='docs/engineering/reviews/gtool-critical-2026-10-23/central/media-r08-source-technical-authority-boundary-root-decision-r01.json';
const revocationSchema='media.pdp0.root-selected-source-integration.r9-r08.technical-source-role-revocations.v1';
const testOnlyPrincipal=i=>`agent:thread:00000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const readJson=ref=>JSON.parse(fs.readFileSync(path.join(repoRoot,ref),'utf8'));
const sourceWriter=path.join(repoRoot,'scripts/lib/media-pdp0-review-successor-cas.mjs');
const originalWriterHash=hash(fs.readFileSync(sourceWriter));
const originalV2GuardHash=hash(fs.readFileSync(path.join(repoRoot,'scripts/lib/media-pdp0-root-selected-source-integration-r9-r08-v2-guard.mjs')));

function copyFile(root,ref,sourceRoot=repoRoot){
  const src=path.join(sourceRoot,ref),dest=path.join(root,ref);
  fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(src,dest);return fs.readFileSync(dest);
}
function appendSections(text,records){
  return `${text.trimEnd()}\n\n${Object.entries(records).map(([id,record])=>`### ${id} — TEST_ONLY synthetic technical delegation section\n\n\`\`\`json\n${JSON.stringify(record,null,2)}\n\`\`\``).join('\n\n')}\n`;
}
function mutatePxd225(text){
  const start=text.indexOf('### PXD-225 ');if(start<0)throw new Error('missing PXD-225');
  const next=text.indexOf('\n### ',start+1),end=next<0?text.length:next;
  return `${text.slice(0,end)}\nTEST_ONLY_PXD225_DRIFT\n${text.slice(end)}`;
}
function replaceSection(text,id,body){
  const re=new RegExp(`(^### ${id}[^\\n]*\\n)([\\s\\S]*?)(?=^### |\\s*$)`,'mu');
  if(!re.test(text))throw new Error(`missing ${id}`);
  return text.replace(re,`$1\n${body.trim()}\n\n`);
}
function replaceDecisionRecord(text,id,record){
  const sectionStart=text.indexOf(`### ${id} `),blockStart=text.indexOf('```json\n',sectionStart),blockEnd=text.indexOf('\n```',blockStart);
  if(sectionStart<0||blockStart<0||blockEnd<0)throw new Error(`missing typed JSON decision ${id}`);
  return `${text.slice(0,blockStart+8)}${JSON.stringify(record,null,2)}${text.slice(blockEnd)}`;
}
function makeFixture({mutateLog,rootAdopterIsDelegator=false,sourceOwnerIsDelegator=false,rolePrincipalOverrides={}}={}){
  const container=fs.mkdtempSync(path.join(os.tmpdir(),'media-r9-r08-v3-source-only-'));
  const root=path.join(container,'ghatana-media'),toolsRoot=path.join(container,'ghatana-tools'),lifecycleRoot=path.join(container,'ghatana-lifecycle');
  fs.mkdirSync(root,{recursive:true});fs.mkdirSync(toolsRoot,{recursive:true});fs.mkdirSync(lifecycleRoot,{recursive:true});
  fs.writeFileSync(path.join(toolsRoot,'package.json'),'{}\n');
  fs.symlinkSync(path.join(repoRoot,'node_modules'),path.join(toolsRoot,'node_modules'),'dir');
  fs.cpSync(path.join(repoRoot,'scripts/lib'),path.join(root,'scripts/lib'),{recursive:true});
  fs.copyFileSync(path.join(repoRoot,'scripts/plan-media-pdp0-root-selected-source-integration-r9-r07-application.mjs'),path.join(root,'scripts/plan-media-pdp0-root-selected-source-integration-r9-r07-application.mjs'));
  fs.symlinkSync(path.join(repoRoot,'node_modules'),path.join(root,'node_modules'),'dir');
  const rootDecisionBytes=copyFile(lifecycleRoot,rootDecisionRepoPath,path.join(repoRoot,'../ghatana-lifecycle'));
  const agentsBytes=copyFile(root,'AGENTS.md');
  const policyBytes=copyFile(root,R9R08_V3_POLICY_REF);
  const policy=JSON.parse(policyBytes.toString('utf8'));
  const candidate=readJson(candidateRef),freeze=readJson(freezeRef),material=readJson(materialRef),semanticReview=readJson(semanticReviewRef);
  for(const ref of [candidateRef,freezeRef,materialRef,semanticReviewRef,...freeze.selectedPostimages.map(row=>row.postimageRef)])copyFile(root,ref);
  for(const ref of R9R08_V2_READ_SET)copyFile(root,ref);
  const candidateSha256=hash(fs.readFileSync(path.join(root,candidateRef)));
  const freezeSha256=hash(fs.readFileSync(path.join(root,freezeRef)));
  const semanticReviewSha256=hash(fs.readFileSync(path.join(root,semanticReviewRef)));
  const nonLogBaseline=R9R08_V2_READ_SET.filter(ref=>ref!=='.product-experience/decision-log.md').map(targetRef=>({targetRef,sha256:hash(fs.readFileSync(path.join(root,targetRef)))}));
  let sourceBaseline=[];
  const targetRows=R9R08_V2_WRITE_TARGETS.map(targetRef=>({targetRef,
    preimageSha256:hash(fs.readFileSync(path.join(root,targetRef))),
    postimageSha256:freeze.selectedPostimages.find(row=>row.targetRef===targetRef).postimageSha256}));
  const rootDecision=JSON.parse(rootDecisionBytes.toString('utf8'));
  const delegation={schemaVersion:'media.pdp0.root-selected-source-integration.r9-r08.technical-source-role-delegation.v1',
    recordKind:'ROOT_DELEGATED_NON_SPECIALIST_TECHNICAL_SOURCE_ROLES',delegationId:'TEST_ONLY_DELEGATION_R9R08_V3',status:'ACTIVE',
    repository:'samujjwal/ghatana-media',macroStage:'DISCOVERY',phaseId:'PDP-0',effect:R9R08_V3_EFFECT,profileId:R9R08_V3_PROFILE_ID,
    delegatingPrincipal:rootDecision.actorIdentity,
    policyRef:R9R08_V3_POLICY_REF,policySha256:R9R08_V3_POLICY_SHA256,rootBoundaryDecisionRef:R9R08_V3_ROOT_DECISION_REF,
    rootBoundaryDecisionSha256:R9R08_V3_ROOT_DECISION_SHA256,agentsRef:'AGENTS.md',agentsSha256:hash(agentsBytes),candidateRef,candidateSha256,freezeRef,freezeSha256,semanticReviewRef,semanticReviewSha256,
    semanticSelector:R9R08_V3_SEMANTIC_SELECTOR,semanticSectionSha256:'',delegationDecisionSectionSha256:'',
    sourceBaseline,targetRows,roles:R9R08_V3_ROLES.map((spec,i)=>({...spec,principal:rolePrincipalOverrides[i]??((rootAdopterIsDelegator&&i===1)||(sourceOwnerIsDelegator&&i===0)?rootDecision.actorIdentity:testOnlyPrincipal(i+1)),
      decisionRef:`.product-experience/decision-log.md#PXD-${902+i}-section`,decisionSectionSha256:''})),
    issuedAt:new Date(Date.now()-60_000).toISOString(),expiresAt:new Date(Date.now()+24*60*60_000).toISOString(),revocationStatus:'NOT_REVOKED',
    revocationRegisterRef:R9R08_V3_REVOCATION_REF,revocationRegisterSha256:'',authorityBoundary:{sourceApply:'EXACT_FOUR_TARGET_R9_R08_ONLY',nativeVerifier:'NONE',pdpAcceptance:'NONE',nativeReceipt:'NONE',build:'NONE',delivery:'NONE',release:'NONE'}};
  const revocationRegister={schemaVersion:revocationSchema,revokedDelegationIds:[]};
  delegation.revocationRegisterSha256=hash(Buffer.from(`${JSON.stringify(revocationRegister,null,2)}\n`));
  const commonDecision={delegationId:delegation.delegationId,repository:delegation.repository,macroStage:delegation.macroStage,
    phaseId:delegation.phaseId,effect:delegation.effect,profileId:delegation.profileId,candidateRef:delegation.candidateRef,
    candidateSha256:delegation.candidateSha256,freezeRef:delegation.freezeRef,freezeSha256:delegation.freezeSha256,
    sourcePins:nonLogBaseline,targetRows:delegation.targetRows,issuedAt:delegation.issuedAt,expiresAt:delegation.expiresAt,
    revocationStatus:delegation.revocationStatus,revocationRegisterRef:delegation.revocationRegisterRef,
    revocationRegisterSha256:delegation.revocationRegisterSha256,authorityBoundary:delegation.authorityBoundary};
  const records={};
  for(let i=0;i<delegation.roles.length;i++){
    const role=delegation.roles[i];records[`PXD-${902+i}`]={recordKind:'TECHNICAL_SOURCE_ROLE_ASSIGNMENT',...commonDecision,
      role:role.role,principal:role.principal,scopeId:role.scopeId};
  }
  records[R9R08_V3_DELEGATION_SECTION_ID]={recordKind:'ROOT_DELEGATED_NON_SPECIALIST_TECHNICAL_SOURCE_ROLES',
    delegatingPrincipal:delegation.delegatingPrincipal,...commonDecision,roles:[]};
  let log=appendSections(fs.readFileSync(path.join(root,'.product-experience/decision-log.md'),'utf8'),records);
  for(let i=0;i<delegation.roles.length;i++)delegation.roles[i].decisionSectionSha256=fingerprintPxdDecisionSection(log,`PXD-${902+i}`).sha256;
  const rootRoles=delegation.roles.map(({role,principal,scopeId,decisionRef,decisionSectionSha256})=>({role,principal,scopeId,decisionRef,decisionSectionSha256}));
  records[R9R08_V3_DELEGATION_SECTION_ID]={recordKind:'ROOT_DELEGATED_NON_SPECIALIST_TECHNICAL_SOURCE_ROLES',
    delegatingPrincipal:delegation.delegatingPrincipal,...commonDecision,roles:rootRoles};
  log=appendSections(fs.readFileSync(path.join(root,'.product-experience/decision-log.md'),'utf8'),records);
  delegation.sourceBaseline=R9R08_V2_READ_SET.map(targetRef=>({targetRef,sha256:targetRef==='.product-experience/decision-log.md'
    ?hash(Buffer.from(log)):hash(fs.readFileSync(path.join(root,targetRef)))}));
  sourceBaseline=delegation.sourceBaseline;
  delegation.semanticSectionSha256=fingerprintPxdDecisionSection(log,'PXD-225').sha256;
  delegation.delegationDecisionSectionSha256=fingerprintPxdDecisionSection(log,R9R08_V3_DELEGATION_SECTION_ID).sha256;
  if(mutateLog)log=mutateLog(log);
  fs.writeFileSync(path.join(root,'.product-experience/decision-log.md'),log);
  fs.mkdirSync(path.dirname(path.join(root,R9R08_V3_DELEGATION_REF)),{recursive:true});
  fs.writeFileSync(path.join(root,R9R08_V3_DELEGATION_REF),`${JSON.stringify(delegation,null,2)}\n`);
  fs.mkdirSync(path.dirname(path.join(root,R9R08_V3_REVOCATION_REF)),{recursive:true});
  fs.writeFileSync(path.join(root,R9R08_V3_REVOCATION_REF),`${JSON.stringify(revocationRegister,null,2)}\n`);
  const baseline=Object.fromEntries(R9R08_V2_READ_SET.map(ref=>[ref,fs.readFileSync(path.join(root,ref))]));
  return {container,root,toolsRoot,lifecycleRoot,policy,policyBytes,rootDecision,rootDecisionBytes,revocationRegister,delegation,log,sourceBaseline,targetRows,freeze,candidate,material,semanticReview,baseline,
    dispose:()=>fs.rmSync(container,{recursive:true,force:true})};
}
function validationArgs(f){
  const delegation=f.delegation,revocationRegister=f.revocationRegister;
  return {delegation,policy:f.policy,policySha256:hash(f.policyBytes),rootBoundaryDecision:f.rootDecision,
    rootBoundaryDecisionSha256:hash(f.rootDecisionBytes),agentsSha256:hash(fs.readFileSync(path.join(f.root,'AGENTS.md'))),v2GuardSha256:originalV2GuardHash,revocationRegister,
    revocationRegisterSha256:hash(Buffer.from(`${JSON.stringify(revocationRegister,null,2)}\n`)),
    liveReadSet:f.sourceBaseline.map(row=>({...row,bytes:fs.readFileSync(path.join(f.root,row.targetRef))})),decisionLogText:f.log,now:Date.now()};
}
async function copyWriter(root){return import(pathToFileURL(path.join(root,'scripts/lib/media-pdp0-review-successor-cas.mjs')).href);}
function installMutationAfterLock(root,mutate){
  const original=fs.openSync;let injected=false;
  fs.openSync=(file,...args)=>{const fd=original.call(fs,file,...args);if(!injected&&args[0]==='wx'&&String(file).endsWith('.canonical-source-amendment-cas.lock')){injected=true;mutate();}return fd;};
  return {restore(){fs.openSync=original;},assertInjected(){assert.equal(injected,true);}};
}
function assertNoTargetsChanged(f){for(const [ref,bytes] of Object.entries(f.baseline))if(R9R08_V2_WRITE_TARGETS.includes(ref))assert.deepEqual(fs.readFileSync(path.join(f.root,ref)),bytes,ref);}
function snapshotTargets(root){return Object.fromEntries(R9R08_V2_WRITE_TARGETS.map(ref=>[ref,fs.readFileSync(path.join(root,ref))]));}

// The fixture contains only TEST_ONLY principals and approvals, in a disposable copy.
test('temporary delegation validates with four distinct effect-role principals',()=>{
  const f=makeFixture();try{const result=validateR9R08V3TechnicalSourceDelegation(validationArgs(f));assert.equal(result.sourceOnly,true);assert.equal(result.nativeTrust,false);assert.equal(result.distinctEffectRolePrincipals,4);assert.equal(result.delegatorAlsoRootAdopter,false);}finally{f.dispose();}
});

test('root adopter may share the delegator while the four effect-role principals remain distinct',()=>{
  const f=makeFixture({rootAdopterIsDelegator:true});try{
    const result=validateR9R08V3TechnicalSourceDelegation(validationArgs(f));
    assert.equal(f.delegation.roles[1].principal,f.delegation.delegatingPrincipal);
    assert.equal(result.distinctEffectRolePrincipals,4);assert.equal(result.delegatorAlsoRootAdopter,true);
  }finally{f.dispose();}
});

test('a non-adopter role may not collide with the delegator',()=>{
  const f=makeFixture({sourceOwnerIsDelegator:true});try{
    assert.equal(f.delegation.roles[0].principal,f.delegation.delegatingPrincipal);
    assert.throws(()=>validateR9R08V3TechnicalSourceDelegation(validationArgs(f)),/only PDP0_TECHNICAL_ROOT_ADOPTER may share/u);
  }finally{f.dispose();}
});

test('v3 rejects assigning the delegator identity to a non-root effect role',()=>{
  const f=makeFixture({sourceOwnerIsDelegator:true});try{
    assert.throws(()=>validateR9R08V3TechnicalSourceDelegation(validationArgs(f)),/only PDP0_TECHNICAL_ROOT_ADOPTER may share/u);
  }finally{f.dispose();}
});

test('v3 rejects a native or expanded effect',()=>{const f=makeFixture();try{const args=validationArgs(f);args.delegation={...args.delegation,effect:'APPLY_NATIVE_VERIFIER_AND_SOURCE'};assert.throws(()=>validateR9R08V3TechnicalSourceDelegation(args),/source-only effect/u);}finally{f.dispose();}});

test('v3 rejects mismatched root-delegator identity',()=>{const f=makeFixture();try{const args=validationArgs(f);args.delegation={...args.delegation,delegatingPrincipal:testOnlyPrincipal(77)};assert.throws(()=>validateR9R08V3TechnicalSourceDelegation(args),/root principal|delegating principal/u);}finally{f.dispose();}});

test('v3 rejects non-distinct effect-role principals',()=>{const f=makeFixture({rolePrincipalOverrides:{2:testOnlyPrincipal(1)}});try{assert.throws(()=>validateR9R08V3TechnicalSourceDelegation(validationArgs(f)),/four technical effect-role principals must be mutually distinct/u);}finally{f.dispose();}});

test('v3 rejects revoked and expired technical role delegation',()=>{const f=makeFixture();try{let args=validationArgs(f);args.revocationRegister={...args.revocationRegister,revokedDelegationIds:[args.delegation.delegationId]};args.revocationRegisterSha256=hash(Buffer.from(`${JSON.stringify(args.revocationRegister,null,2)}\n`));args.delegation={...args.delegation,revocationRegisterSha256:args.revocationRegisterSha256};assert.throws(()=>validateR9R08V3TechnicalSourceDelegation(args),/revoked/u);args=validationArgs(f);args.delegation={...args.delegation,expiresAt:new Date(Date.now()-1_000).toISOString()};assert.throws(()=>validateR9R08V3TechnicalSourceDelegation(args),/validity window/u);}finally{f.dispose();}});

test('v3 detects policy, PXD-225, whole-log, source-readset, target-order, and decision-section tampering',()=>{
  const f=makeFixture();try{
    let args=validationArgs(f);args.policy={...args.policy,trustedAdmission:'REGISTERED'};assert.throws(()=>validateR9R08V3TechnicalSourceDelegation(args),/owner policy/u);
    args=validationArgs(f);args.decisionLogText=args.decisionLogText.replace('PXD-225','PXD-225');args.decisionLogText=args.decisionLogText.replace(/(### PXD-225[^\n]*\n)/,'$1\nTEST_ONLY_PIN_DRIFT\n');assert.throws(()=>validateR9R08V3TechnicalSourceDelegation(args),/PXD-225 semantic section pin is stale/u);
    args=validationArgs(f);args.liveReadSet=args.liveReadSet.map(row=>row.targetRef==='.product-experience/decision-log.md'?{...row,sha256:'a'.repeat(64)}:row);assert.throws(()=>validateR9R08V3TechnicalSourceDelegation(args),/seven-member/u);
    args=validationArgs(f);args.decisionLogText+='\nTEST_ONLY_DIFFERENT_TEXT_THAN_PINNED_BYTES\n';assert.throws(()=>validateR9R08V3TechnicalSourceDelegation(args),/whole-log bytes passed to semantic section parsing/u);
    args=validationArgs(f);args.delegation={...args.delegation,sourceBaseline:args.delegation.sourceBaseline.map((row,i)=>i===0?{...row,sha256:'b'.repeat(64)}:row)};assert.throws(()=>validateR9R08V3TechnicalSourceDelegation(args),/seven-member/u);
    args=validationArgs(f);args.delegation={...args.delegation,targetRows:[...args.delegation.targetRows].reverse()};assert.throws(()=>validateR9R08V3TechnicalSourceDelegation(args),/four exact source target pins/u);
    args=validationArgs(f);args.delegation={...args.delegation,roles:args.delegation.roles.map((r,i)=>i===0?{...r,scopeId:'R9-R08-PDP0-NATIVE-VERIFIER'}:r)};assert.throws(()=>validateR9R08V3TechnicalSourceDelegation(args),/role PDP0_TECHNICAL_SOURCE_OWNER lacks exact principal or scope/u);
  }finally{f.dispose();}
});

test('v3 binds the delegation principal to the pinned actual root decision actor',()=>{
  const f=makeFixture();try{const args=validationArgs(f);assert.equal(args.delegation.delegatingPrincipal,args.rootBoundaryDecision.actorIdentity);args.delegation={...args.delegation,delegatingPrincipal:testOnlyPrincipal(99)};assert.throws(()=>validateR9R08V3TechnicalSourceDelegation(args),/root principal|delegating principal/u);}finally{f.dispose();}
});

test('v3 rejects a byte-current but semantically unrelated role decision',()=>{
  const f=makeFixture();try{
    const args=validationArgs(f),role=args.delegation.roles[0],roleId='PXD-902';
    let changed=JSON.parse(fingerprintPxdDecisionSection(args.decisionLogText,roleId).section.match(/```json\n([\s\S]*?)\n```/u)[1]);
    changed.recordKind='UNRELATED_DECISION';
    args.decisionLogText=replaceDecisionRecord(args.decisionLogText,roleId,changed);
    role.decisionSectionSha256=fingerprintPxdDecisionSection(args.decisionLogText,roleId).sha256;
    let rootRecord=JSON.parse(fingerprintPxdDecisionSection(args.decisionLogText,R9R08_V3_DELEGATION_SECTION_ID).section.match(/```json\n([\s\S]*?)\n```/u)[1]);
    rootRecord.roles[0].decisionSectionSha256=role.decisionSectionSha256;
    args.decisionLogText=replaceDecisionRecord(args.decisionLogText,R9R08_V3_DELEGATION_SECTION_ID,rootRecord);
    args.delegation.delegationDecisionSectionSha256=fingerprintPxdDecisionSection(args.decisionLogText,R9R08_V3_DELEGATION_SECTION_ID).sha256;
    const wholeLogBytes=Buffer.from(args.decisionLogText),wholeLogSha256=hash(wholeLogBytes);
    args.delegation.sourceBaseline=args.delegation.sourceBaseline.map(row=>row.targetRef==='.product-experience/decision-log.md'?{...row,sha256:wholeLogSha256}:row);
    args.liveReadSet=args.liveReadSet.map(row=>row.targetRef==='.product-experience/decision-log.md'?{...row,sha256:wholeLogSha256,bytes:wholeLogBytes}:row);
    assert.throws(()=>validateR9R08V3TechnicalSourceDelegation(args),/semantically unrelated/u);
  }finally{f.dispose();}
});

test('v3 transaction revalidates authority, PXD-225, log, readset, and targets after acquiring the lease',async()=>{
  const mutations=[
    ['delegation',f=>fs.appendFileSync(path.join(f.root,R9R08_V3_DELEGATION_REF),' \n')],
    ['policy',f=>fs.appendFileSync(path.join(f.root,R9R08_V3_POLICY_REF),' \n')],
    ['root decision',f=>fs.appendFileSync(path.join(f.lifecycleRoot,rootDecisionRepoPath),' \n')],
    ['revocation register',f=>{const p=path.join(f.root,R9R08_V3_REVOCATION_REF);fs.writeFileSync(p,JSON.stringify({...f.revocationRegister,revokedDelegationIds:[f.delegation.delegationId]},null,2)+'\n');}],
    ['PXD-225 section',f=>{const p=path.join(f.root,'.product-experience/decision-log.md');fs.writeFileSync(p,mutatePxd225(fs.readFileSync(p,'utf8')));}],
    ['whole decision log',f=>fs.appendFileSync(path.join(f.root,'.product-experience/decision-log.md'),'\nTEST_ONLY_WHOLE_LOG_DRIFT\n')],
    ['a readset member',f=>fs.appendFileSync(path.join(f.root,'.product-experience/pdp-0-product-truth/quality-policy.yaml'),'\n# TEST_ONLY_READSET_DRIFT\n')],
    ['a write target',f=>fs.appendFileSync(path.join(f.root,R9R08_V2_WRITE_TARGETS[0]),'\n# TEST_ONLY_TARGET_DRIFT\n')],
    ['target authorization pin',f=>{const p=path.join(f.root,R9R08_V3_DELEGATION_REF),d=JSON.parse(fs.readFileSync(p,'utf8'));d.targetRows[0].postimageSha256='d'.repeat(64);fs.writeFileSync(p,JSON.stringify(d,null,2)+'\n');}],
  ];
  for(const [label,mutate] of mutations){
    const f=makeFixture();let expectedTargetBytes;const hook=installMutationAfterLock(f.root,()=>{mutate(f);expectedTargetBytes=snapshotTargets(f.root);});
    try{const writer=await copyWriter(f.root);let thrown;try{writer.commitValidatedPdp0RootSelectedSourceIntegrationR9R08V3Technical({});}catch(e){thrown=e;}assert.ok(thrown,`${label} drift must reject`);assert.match(thrown.message,/changed after preflight; no snapshots or writes|canonical source targets changed since the approved CAS preimage|four exact source target pins are missing or out of order/u);assert.equal(thrown.effectState,'NO_NEW_TARGET_EFFECTS_BY_THIS_ATTEMPT');hook.assertInjected();for(const [ref,bytes] of Object.entries(expectedTargetBytes))assert.deepEqual(fs.readFileSync(path.join(f.root,ref)),bytes,`${label}: writer must add no target effect`);}
    finally{hook.restore();f.dispose();}
  }
});

test('v3 publishes only four exact frozen source targets in the temporary repository',async()=>{
  const f=makeFixture();try{const writer=await copyWriter(f.root);const result=writer.commitValidatedPdp0RootSelectedSourceIntegrationR9R08V3Technical({});assert.equal(result.state,'COMMITTED_EXACT_READBACK');assert.equal(result.effect,R9R08_V3_EFFECT);assert.equal(result.nativeTrust,'NOT_USED');assert.equal(result.canonicalApply,'EXACT_R9_R08_SOURCE_ONLY_TECHNICAL_APPLY_PERFORMED');assert.deepEqual(result.targets.map(row=>row.targetRef),R9R08_V2_WRITE_TARGETS);for(const ref of R9R08_V2_READ_SET)if(!R9R08_V2_WRITE_TARGETS.includes(ref))assert.deepEqual(fs.readFileSync(path.join(f.root,ref)),f.baseline[ref],`${ref} read-only`);}finally{f.dispose();}
});

test('v3 read-only readiness stays blocked when the fixed root delegation record is absent',async()=>{
  const f=makeFixture();try{fs.unlinkSync(path.join(f.root,R9R08_V3_DELEGATION_REF));const writer=await copyWriter(f.root);const result=writer.inspectMediaPdp0RootSelectedSourceIntegrationR9R08V3TechnicalReadiness();assert.equal(result.blocked,true);assert.equal(result.canonicalApply,'NONE');assert.equal(result.sourceWrites,'NONE');assert.match(result.blocker,/technical source artifact is invalid JSON|ENOENT|R9-R08 v3|CAS path component/u);assertNoTargetsChanged(f);}finally{f.dispose();}
});

test('v3 reports a post-rename interrupted publication as UNKNOWN and refuses retry',async()=>{
  const f=makeFixture(),originalRename=fs.renameSync,first=path.join(fs.realpathSync(f.root),R9R08_V2_WRITE_TARGETS[0]);let injected=false;
  fs.renameSync=(from,to)=>{const out=originalRename.call(fs,from,to);if(!injected&&path.resolve(String(to))===first){injected=true;throw new Error('TEST_ONLY_UNKNOWN_AFTER_TARGET_RENAME');}return out;};
  try{const writer=await copyWriter(f.root);let thrown;try{writer.commitValidatedPdp0RootSelectedSourceIntegrationR9R08V3Technical({});}catch(e){thrown=e;}assert.ok(thrown);assert.equal(thrown.effectState,'UNKNOWN_PARTIAL_EFFECTS_REQUIRES_EXPLICIT_RECONCILIATION');assert.equal(thrown.observedTargets.length,4);assert.equal(thrown.observedTargets[0].state,'POSTIMAGE_OBSERVED');assert.throws(()=>writer.commitValidatedPdp0RootSelectedSourceIntegrationR9R08V3Technical({}),/seven-member current source read set differs|source-amendment bytes differ from approved fingerprints/u);assert.equal(injected,true);}finally{fs.renameSync=originalRename;f.dispose();}
});

test('v2 protected native authorization still fails closed on the temporary synthetic technical delegation',async()=>{
  const f=makeFixture();try{assert.throws(()=>requireR9R08V2TrustedActors([{identity:'TEST_ONLY',role:'CANONICAL_APPLY_AUTHORITY'}]),/fixed authenticated actor trust registry is not registered/u);assertNoTargetsChanged(f);}finally{f.dispose();}
});

test('temporary tests did not modify production writer or protected v2 guard',()=>{assert.equal(hash(fs.readFileSync(sourceWriter)),originalWriterHash);assert.equal(hash(fs.readFileSync(path.join(repoRoot,'scripts/lib/media-pdp0-root-selected-source-integration-r9-r08-v2-guard.mjs'))),originalV2GuardHash);});
