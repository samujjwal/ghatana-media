import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {fingerprintPxdDecisionSection} from '../scripts/lib/pdp0-phase-scoped-source-fingerprints.mjs';
import {R9R08_V2_PROFILE_ID,R9R08_V2_READ_SET,R9R08_V2_RECORD_REFS,R9R08_V2_WRITE_TARGETS} from '../scripts/lib/media-pdp0-root-selected-source-integration-r9-r08-v2-guard.mjs';

const repoRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const candidateRef='docs/implementation/observations/media-pdp0-parent-case-resolution-candidates/media-pdp0-root-selected-source-integration-r9-r08.successor-bundle.candidate.v1.json';
const freezeRef='docs/implementation/observations/media-pdp0-parent-case-resolution-candidates/media-pdp0-root-selected-source-integration-r9-r08.freeze.v1.json';
const materialRef='docs/implementation/observations/media-pdp0-parent-case-resolution-candidates/media-pdp0-root-selected-source-integration-r9-r08.decision-section-material.r5.candidate.v1.json';
const semanticReviewRef='docs/implementation/observations/media-pdp0-parent-case-resolution-candidates/media-pdp0-root-selected-source-integration-r9-r08.independent-peer.r08-semantic-review.v1.json';
const ownerAuthRef='config/closure/media-product-definition/owner-execution-authorization.v1.json';
const statusRef='docs/implementation/pdp-0-phase-dev-status.json';
const journalRoot='docs/implementation/observations/pdp0-semantic-audit-slices/source-amendment-journals';
const snapshotRoot='docs/implementation/observations/pdp0-semantic-audit-slices/source-amendment-preimages';
const roles=['PDP0_SOURCE_OWNER','ROOT_AUTHORITY','PDP0_PROFILE_REGISTRAR','CANONICAL_APPLY_AUTHORITY'];
const kinds=['PDP0_SOURCE_OWNER_DECISION','ROOT_ADOPTION_DECISION','OPERATION_PROFILE_REGISTRATION','DISTINCT_APPLY_AUTHORIZATION'];
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const readJson=ref=>JSON.parse(fs.readFileSync(path.join(repoRoot,ref),'utf8'));
const syntheticEvidence=index=>({identity:`TEST_ONLY_SYNTHETIC_ACTOR_${index+1}`,role:roles[index],status:'TRUSTED_CURRENT_ROLE_EVIDENCE',
  credentialRef:`TEST_ONLY_SYNTHETIC_TRUST/actor-${index+1}/credential`,credentialSha256:'e'.repeat(64),
  grantRef:`TEST_ONLY_SYNTHETIC_TRUST/actor-${index+1}/role-grant`,grantSha256:'f'.repeat(64)});

const oldProductionSourceHashes={
  guard:hash(fs.readFileSync(path.join(repoRoot,'scripts/lib/media-pdp0-root-selected-source-integration-r9-r08-v2-guard.mjs'))),
  writer:hash(fs.readFileSync(path.join(repoRoot,'scripts/lib/media-pdp0-review-successor-cas.mjs'))),
};

function copySource(root,ref){
  const source=path.join(repoRoot,ref),target=path.join(root,ref);
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.copyFileSync(source,target);
  return fs.readFileSync(target);
}

function appendSyntheticAuthoritySections(text){
  const suffix='\n\n'+['PXD-901','PXD-902','PXD-903','PXD-904'].map((id,index)=>
    `### ${id} — TEST ONLY synthetic R9-R08 authority section\n\nTEST_ONLY_SYNTHETIC_AUTHORITY_SECTION_${index+1}.\n`).join('\n');
  return `${text.trimEnd()}${suffix}\n`;
}

function mutatePxd225(text){
  const start=text.indexOf('### PXD-225 ');
  if(start<0)throw new Error('PXD-225 fixture section missing');
  const next=text.indexOf('\n### ',start+1);
  const end=next<0?text.length:next;
  return `${text.slice(0,end)}\nTEST_ONLY_PXD225_SEMANTIC_DRIFT.\n${text.slice(end)}`;
}

function copyAndPatchTestModules(root){
  fs.mkdirSync(path.join(root,'scripts'),{recursive:true});
  fs.cpSync(path.join(repoRoot,'scripts/lib'),path.join(root,'scripts/lib'),{recursive:true});
  fs.copyFileSync(path.join(repoRoot,'scripts/plan-media-pdp0-root-selected-source-integration-r9-r07-application.mjs'),
    path.join(root,'scripts/plan-media-pdp0-root-selected-source-integration-r9-r07-application.mjs'));
  fs.symlinkSync(path.join(repoRoot,'node_modules'),path.join(root,'node_modules'),'dir');

  // The following two patches exist only in this disposable repository copy. They model
  // the successful authenticated-resolver branch without adding production credentials,
  // a live registry entry, or an actor-trust input to the public writer API.
  const guardRef='scripts/lib/media-pdp0-root-selected-source-integration-r9-r08-v2-guard.mjs';
  let guard=fs.readFileSync(path.join(root,guardRef),'utf8');
  const registryNeedle="export const R9R08_V2_TRUST_REGISTRY_STATUS='NOT_REGISTERED';";
  assert.ok(guard.includes(registryNeedle),'copied guard must expose the expected closed registry baseline');
  guard=guard.replace(registryNeedle,"// TEST_ONLY_SYNTHETIC_TRUST in temporary repository copy only.\nexport const R9R08_V2_TRUST_REGISTRY_STATUS='REGISTERED';");
  const resolverPattern=/export function resolveR9R08V2TrustedActors\(records\)\{[\s\S]*?\n\}/u;
  assert.match(guard,resolverPattern,'copied guard must expose the fixed resolver to replace with fixture evidence');
  guard=guard.replace(resolverPattern,`export function resolveR9R08V2TrustedActors(records){
  if(!Array.isArray(records)||records.length!==4)throw new Error('TEST_ONLY_SYNTHETIC_TRUST fixture requires four records');
  return records.map((entry,index)=>({
    identity:entry.value.actorIdentity,role:entry.value.actorRole,status:'TRUSTED_CURRENT_ROLE_EVIDENCE',
    credentialRef:'TEST_ONLY_SYNTHETIC_TRUST/actor-'+(index+1)+'/credential',credentialSha256:'${'e'.repeat(64)}',
    grantRef:'TEST_ONLY_SYNTHETIC_TRUST/actor-'+(index+1)+'/role-grant',grantSha256:'${'f'.repeat(64)}'
  }));
}`);
  fs.writeFileSync(path.join(root,guardRef),guard);

  const writerPath=path.join(root,'scripts/lib/media-pdp0-review-successor-cas.mjs');
}

function installAuthorityFixture(root,{stalePxd225=false}={}){
  const freeze=readJson(freezeRef),bundle=readJson(candidateRef),semanticReview=readJson(semanticReviewRef),material=readJson(materialRef);
  for(const ref of [candidateRef,freezeRef,semanticReviewRef,materialRef,...freeze.selectedPostimages.map(row=>row.postimageRef)])copySource(root,ref);

  let decisionLogText=fs.readFileSync(path.join(root,'.product-experience/decision-log.md'),'utf8');
  if(stalePxd225)decisionLogText=mutatePxd225(decisionLogText);
  decisionLogText=appendSyntheticAuthoritySections(decisionLogText);
  fs.writeFileSync(path.join(root,'.product-experience/decision-log.md'),decisionLogText);

  const candidateSha256=hash(fs.readFileSync(path.join(root,candidateRef)));
  const freezeSha256=hash(fs.readFileSync(path.join(root,freezeRef)));
  const semanticReviewSha256=hash(fs.readFileSync(path.join(root,semanticReviewRef)));
  const selectorIds=['PXD-901','PXD-902','PXD-903','PXD-904'];
  const authoritySections=selectorIds.map(id=>{
    const selected=fingerprintPxdDecisionSection(decisionLogText,id);
    return {ref:`.product-experience/decision-log.md#${id}`,sectionSha256:selected.sha256};
  });
  const recordRefs={sourceOwnerDecision:R9R08_V2_RECORD_REFS[0],rootAdoptionDecision:R9R08_V2_RECORD_REFS[1],
    profileRegistration:R9R08_V2_RECORD_REFS[2],applyAuthorization:R9R08_V2_RECORD_REFS[3]};
  const sourceBaseline=R9R08_V2_READ_SET.map(targetRef=>({targetRef,sha256:hash(fs.readFileSync(path.join(root,targetRef)))}));
  const targetRows=R9R08_V2_WRITE_TARGETS.map(targetRef=>({
    targetRef,preimageSha256:sourceBaseline.find(row=>row.targetRef===targetRef).sha256,
    postimageSha256:freeze.selectedPostimages.find(row=>row.targetRef===targetRef).postimageSha256,
  }));
  const profile={schemaVersion:'media.pdp0.root-selected-source-integration.r9-r08.operation-profile-registration.v2',
    profileId:R9R08_V2_PROFILE_ID,registrationStatus:'REGISTERED_FOR_EXACT_R9_R08_SOURCE_SUCCESSOR_ONLY',
    candidateRef,candidateSha256,freezeRef,freezeSha256,semanticReviewRef,semanticReviewSha256,targetRows,authoritySections,recordRefs};
  const actorEvidence=roles.map((role,index)=>syntheticEvidence(index));
  const records=[];
  let predecessorRecordSha256;
  for(let index=0;index<3;index++){
    const record={recordKind:kinds[index],recordRef:Object.values(recordRefs)[index],decisionRef:authoritySections[index].ref,
      profileId:R9R08_V2_PROFILE_ID,candidateSha256,freezeSha256,actorIdentity:actorEvidence[index].identity,actorRole:roles[index],
      ...(index?{predecessorRecordSha256}:{}),...(index===2?{operationProfile:profile}:{})};
    const bytes=Buffer.from(`${JSON.stringify(record,null,2)}\n`);
    predecessorRecordSha256=hash(bytes);
    records.push({value:record,bytes,sha256:predecessorRecordSha256});
    const target=path.join(root,record.recordRef);
    fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.writeFileSync(target,bytes);
  }
  const applyAuthorization={
    schemaVersion:'media.pdp0.root-selected-source-integration-r9-r08.apply-authorization.v2',
    effect:'APPLY_EXACT_R9_R08_SPLIT_SOURCE_SUCCESSOR',profileId:R9R08_V2_PROFILE_ID,
    candidateRef,candidateSha256,freezeRef,freezeSha256,
    profileRegistrationRef:recordRefs.profileRegistration,profileRegistrationSha256:records[2].sha256,
    sourceOwnerDecisionRef:recordRefs.sourceOwnerDecision,sourceOwnerDecisionSha256:records[0].sha256,
    rootAdoptionDecisionRef:recordRefs.rootAdoptionDecision,rootAdoptionDecisionSha256:records[1].sha256,
    semanticReviewRef,semanticReviewSha256,
    readSetVersion:'media.pdp0.root-selected-source-integration.r9-r08.apply-read-set.v2',sourceBaseline,
    wholeDecisionLogSha256:sourceBaseline.find(row=>row.targetRef==='.product-experience/decision-log.md').sha256,
    targetRows,decisionRef:authoritySections[3].ref,decisionSectionSha256:authoritySections[3].sectionSha256,
    applyAuthority:{identity:actorEvidence[3].identity,role:roles[3],credentialRef:actorEvidence[3].credentialRef,
      credentialSha256:actorEvidence[3].credentialSha256,roleGrantRef:actorEvidence[3].grantRef,roleGrantSha256:actorEvidence[3].grantSha256},
    authorityBoundary:{canonicalApply:'EXACT_R9_R08_CANONICAL_SOURCE_APPLY_AUTHORIZED',phaseStatusEffect:'NONE'},
    recordKind:kinds[3],recordRef:recordRefs.applyAuthorization,actorIdentity:actorEvidence[3].identity,actorRole:roles[3],
    predecessorRecordSha256:records[2].sha256,
  };
  assert.equal(applyAuthorization.schemaVersion,'media.pdp0.root-selected-source-integration-r9-r08.apply-authorization.v2');
  assert.equal(applyAuthorization.effect,'APPLY_EXACT_R9_R08_SPLIT_SOURCE_SUCCESSOR');
  assert.equal(applyAuthorization.profileId,R9R08_V2_PROFILE_ID);
  assert.equal(applyAuthorization.readSetVersion,'media.pdp0.root-selected-source-integration.r9-r08.apply-read-set.v2');
  const bytes=Buffer.from(`${JSON.stringify(applyAuthorization,null,2)}\n`);
  const applyRow={value:applyAuthorization,bytes,sha256:hash(bytes)};
  records.push(applyRow);
  fs.writeFileSync(path.join(root,applyAuthorization.recordRef),bytes);
  return {root,records,profile,applyAuthorization,decisionLogText,freeze,bundle,semanticReview,material,
    actorEvidence,sourceBaseline,targetRows};
}

function createFixture(options={}){
  const container=fs.mkdtempSync(path.join(os.tmpdir(),'media-r9-r08-full-writer-'));
  const root=path.join(container,'ghatana-media'),toolsRoot=path.join(container,'ghatana-tools');
  fs.mkdirSync(root,{recursive:true});fs.mkdirSync(toolsRoot,{recursive:true});
  fs.writeFileSync(path.join(toolsRoot,'package.json'),'{}\n');
  fs.symlinkSync(path.join(repoRoot,'node_modules'),path.join(toolsRoot,'node_modules'),'dir');
  copyAndPatchTestModules(root);
  for(const ref of [...R9R08_V2_READ_SET,statusRef,...[candidateRef,freezeRef,materialRef,semanticReviewRef]])copySource(root,ref);
  const fixture=installAuthorityFixture(root,options);
  const baseline=Object.fromEntries([...new Set([...R9R08_V2_READ_SET,statusRef])].map(ref=>[ref,fs.readFileSync(path.join(root,ref))]));
  return {...fixture,container,baseline,dispose:()=>fs.rmSync(container,{recursive:true,force:true})};
}

async function loadWriter(root){
  return import(pathToFileURL(path.join(root,'scripts/lib/media-pdp0-review-successor-cas.mjs')).href);
}

function installPostLockMutation(root,mutate){
  const original=fs.openSync;
  let injected=false;
  fs.openSync=(filePath,...args)=>{
    const fd=original.call(fs,filePath,...args);
    if(!injected&&args[0]==='wx'&&String(filePath).endsWith('.canonical-source-amendment-cas.lock')){
      injected=true;
      mutate();
    }
    return fd;
  };
  return {restore:()=>{fs.openSync=original;},assertInjected:()=>assert.equal(injected,true,'drift must be injected after the owner lease is acquired')};
}

function assertNoTemporaryArtifacts(root){
  const journalDir=path.join(root,journalRoot);
  if(fs.existsSync(journalDir))assert.deepEqual(fs.readdirSync(journalDir).filter(name=>name!=='.DS_Store'),[],'lock must be released and no journal left');
  assert.equal(fs.existsSync(path.join(root,snapshotRoot)),false,'preflight drift must reject before snapshots');
}

function assertProductionSourcesUnchanged(){
  assert.equal(hash(fs.readFileSync(path.join(repoRoot,'scripts/lib/media-pdp0-root-selected-source-integration-r9-r08-v2-guard.mjs'))),oldProductionSourceHashes.guard);
  assert.equal(hash(fs.readFileSync(path.join(repoRoot,'scripts/lib/media-pdp0-review-successor-cas.mjs'))),oldProductionSourceHashes.writer);
}

test('temporary R9-R08 authority fixture publishes only the exact four approved targets',async()=>{
  const fixture=createFixture();
  try{
    const cas=await loadWriter(fixture.root);
    const copiedGuard=await import(pathToFileURL(path.join(fixture.root,'scripts/lib/media-pdp0-root-selected-source-integration-r9-r08-v2-guard.mjs')).href);
    assert.equal(fixture.profile.schemaVersion,'media.pdp0.root-selected-source-integration.r9-r08.operation-profile-registration.v2');
    assert.equal(fixture.profile.profileId,copiedGuard.R9R08_V2_PROFILE_ID);
    assert.equal(fixture.profile.registrationStatus,'REGISTERED_FOR_EXACT_R9_R08_SOURCE_SUCCESSOR_ONLY');
    assert.deepEqual(Object.values(fixture.profile.recordRefs),copiedGuard.R9R08_V2_RECORD_REFS);
    const authOnDisk=JSON.parse(fs.readFileSync(path.join(fixture.root,R9R08_V2_RECORD_REFS[3]),'utf8'));
    const directReadSet=R9R08_V2_READ_SET.map(targetRef=>({targetRef,sha256:hash(fs.readFileSync(path.join(fixture.root,targetRef)))}));
    copiedGuard.validateR9R08V2ExternalApplyReadSet({authorization:authOnDisk,liveReadSet:directReadSet});
    const result=cas.commitValidatedPdp0RootSelectedSourceIntegrationR9R08V2({});
    assert.equal(result.state,'COMMITTED_EXACT_READBACK');
    assert.equal(result.canonicalApply,'EXACT_R9_R08_CANONICAL_SOURCE_APPLY_PERFORMED');
    assert.deepEqual(result.targets.map(row=>row.targetRef),R9R08_V2_WRITE_TARGETS);
    for(const row of fixture.targetRows){
      const expected=fs.readFileSync(path.join(fixture.root,fixture.freeze.selectedPostimages.find(item=>item.targetRef===row.targetRef).postimageRef));
      assert.deepEqual(fs.readFileSync(path.join(fixture.root,row.targetRef)),expected,row.targetRef);
    }
    for(const [ref,bytes] of Object.entries(fixture.baseline)){
      if(!R9R08_V2_WRITE_TARGETS.includes(ref))assert.deepEqual(fs.readFileSync(path.join(fixture.root,ref)),bytes,`${ref} must remain read-only`);
    }
    const journal=JSON.parse(fs.readFileSync(path.join(fixture.root,result.journalPath),'utf8'));
    assert.equal(journal.state,'COMMITTED_EXACT_READBACK');
    assert.equal(journal.schemaVersion,'media.pdp0.root-selected-source-integration-r9-r08-v2-apply-journal.v1');
    assertProductionSourcesUnchanged();
  }finally{fixture.dispose();}
});

test('temporary authority fixture rejects a stale PXD-225 pin even when its whole-log baseline is current',async()=>{
  const fixture=createFixture({stalePxd225:true});
  try{
    const cas=await loadWriter(fixture.root);
    assert.throws(()=>cas.commitValidatedPdp0RootSelectedSourceIntegrationR9R08V2({}),/PXD-225 semantic section pin is stale/u);
    assertNoTemporaryArtifacts(fixture.root);
    for(const row of fixture.targetRows)assert.deepEqual(fs.readFileSync(path.join(fixture.root,row.targetRef)),fixture.baseline[row.targetRef]);
    assertProductionSourcesUnchanged();
  }finally{fixture.dispose();}
});

const driftCases=[
  ...[0,1,2,3].map(index=>[`${kinds[index]} bytes`,fixture=>{
    const ref=fixture.records[index].value.recordRef,target=path.join(fixture.root,ref);
    // Whitespace is valid JSON but changes the byte-level authority-record digest.
    fs.appendFileSync(target,' \n');
  }]),
  ['PXD-225 section bytes',fixture=>{
    const target=path.join(fixture.root,'.product-experience/decision-log.md');
    fs.writeFileSync(target,mutatePxd225(fs.readFileSync(target,'utf8')));
  }],
  ['whole decision-log bytes outside PXD-225',fixture=>{
    fs.appendFileSync(path.join(fixture.root,'.product-experience/decision-log.md'),'\nTEST_ONLY_WHOLE_LOG_APPEND\n');
  }],
  ['a read-only member of the seven-file guard',fixture=>{
    fs.appendFileSync(path.join(fixture.root,'.product-experience/pdp-0-product-truth/quality-policy.yaml'),'\n# TEST_ONLY_READSET_DRIFT\n');
  }],
];

for(const [label,mutate] of driftCases)test(`temporary R9-R08 writer revalidates ${label} under the lease before snapshots`,async()=>{
  const fixture=createFixture();
  const hook=installPostLockMutation(fixture.root,()=>mutate(fixture));
  try{
    const cas=await loadWriter(fixture.root);
    let thrown;
    try{cas.commitValidatedPdp0RootSelectedSourceIntegrationR9R08V2({});}catch(error){thrown=error;}
    assert.ok(thrown,'post-preflight drift must be rejected');
    assert.match(thrown.message,/changed after preflight; no snapshots or writes/u);
    assert.equal(thrown.effectState,'NO_NEW_TARGET_EFFECTS_BY_THIS_ATTEMPT');
    hook.assertInjected();
    assertNoTemporaryArtifacts(fixture.root);
    for(const row of fixture.targetRows)assert.deepEqual(fs.readFileSync(path.join(fixture.root,row.targetRef)),fixture.baseline[row.targetRef]);
    assertProductionSourcesUnchanged();
  }finally{
    hook.restore();
    fixture.dispose();
  }
});

test('temporary R9-R08 writer classifies an interrupted post-rename result as UNKNOWN and refuses redispatch',async()=>{
  const fixture=createFixture();
  const originalRename=fs.renameSync;
  const firstTarget=path.join(fs.realpathSync(fixture.root),R9R08_V2_WRITE_TARGETS[0]);
  let targetRenames=0,injected=false;
  const renameDestinations=[];
  fs.renameSync=(from,to)=>{
    renameDestinations.push(path.resolve(String(to)));
    const result=originalRename.call(fs,from,to);
    if(path.resolve(String(to))===firstTarget){
      targetRenames+=1;
      if(!injected){injected=true;throw new Error('TEST_ONLY_UNKNOWN_AFTER_TARGET_RENAME');}
    }
    return result;
  };
  try{
    const cas=await loadWriter(fixture.root);
    let thrown;
    try{cas.commitValidatedPdp0RootSelectedSourceIntegrationR9R08V2({});}catch(error){thrown=error;}
    assert.ok(thrown,`interruption must surface an error (injected=${injected}, targetRenames=${targetRenames}, firstTarget=${firstTarget}, destinations=${JSON.stringify(renameDestinations)})`);
    assert.match(thrown.message,/^TEST_ONLY_UNKNOWN_AFTER_TARGET_RENAME; UNKNOWN_PARTIAL_EFFECTS_REQUIRES_EXPLICIT_RECONCILIATION/u);
    assert.equal(thrown.effectState,'UNKNOWN_PARTIAL_EFFECTS_REQUIRES_EXPLICIT_RECONCILIATION');
    assert.ok(thrown.journalRef);
    assert.equal(thrown.journalState,'PREPARED');
    assert.equal(targetRenames,1);
    assert.equal(thrown.observedTargets.length,4);
    assert.equal(thrown.observedTargets[0].state,'POSTIMAGE_OBSERVED');
    assert.deepEqual(thrown.observedTargets.slice(1).map(row=>row.state),['PREIMAGE_OBSERVED','PREIMAGE_OBSERVED','PREIMAGE_OBSERVED']);
    const journal=JSON.parse(fs.readFileSync(path.join(fixture.root,thrown.journalRef),'utf8'));
    assert.equal(journal.state,'PREPARED');
    assert.equal(journal.targets[0].state,'PENDING','failure occurred after rename and before journal readback update');
    assert.deepEqual(fs.readFileSync(path.join(fixture.root,R9R08_V2_WRITE_TARGETS[0])),
      fs.readFileSync(path.join(fixture.root,fixture.freeze.selectedPostimages.find(row=>row.targetRef===R9R08_V2_WRITE_TARGETS[0]).postimageRef)));

    assert.throws(()=>cas.commitValidatedPdp0RootSelectedSourceIntegrationR9R08V2({}),/source-amendment bytes differ from approved fingerprints/u);
    assert.equal(targetRenames,1,'retry must not redispatch any target rename');
    assert.deepEqual(fs.readFileSync(path.join(fixture.root,thrown.journalRef)),Buffer.from(`${JSON.stringify(journal,null,2)}\n`),
      'the incomplete journal remains durable for explicit reconciliation');
    assertProductionSourcesUnchanged();
  }finally{
    fs.renameSync=originalRename;
    fixture.dispose();
  }
});

test('fixture-only resolver and authority markers never alter production trust or writer modules',()=>{
  assert.equal(hash(fs.readFileSync(path.join(repoRoot,'scripts/lib/media-pdp0-root-selected-source-integration-r9-r08-v2-guard.mjs'))),oldProductionSourceHashes.guard);
  assert.equal(hash(fs.readFileSync(path.join(repoRoot,'scripts/lib/media-pdp0-review-successor-cas.mjs'))),oldProductionSourceHashes.writer);
  assert.ok(syntheticEvidence(0).identity.startsWith('TEST_ONLY_SYNTHETIC_ACTOR_'));
  assert.ok(ownerAuthRef.endsWith('owner-execution-authorization.v1.json'));
});
