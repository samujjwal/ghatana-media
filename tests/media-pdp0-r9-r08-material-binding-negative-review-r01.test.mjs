import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import {fingerprintPxdDecisionSection} from '../scripts/lib/pdp0-phase-scoped-source-fingerprints.mjs';
import {validateMediaPdp0RootSelectedSourceIntegrationR9R08V2ReadSetUnderLease} from '../scripts/lib/media-pdp0-review-successor-cas.mjs';
import {
  R9R08_V2_PROFILE_ID,R9R08_V2_READ_SET,R9R08_V2_WRITE_TARGETS,R9R08_V2_RECORD_REFS,
  validateR9R08V2ApplyAdmission,validateR9R08V2AuthorityChain,
  validateR9R08V2ExternalApplyReadSet,validateR9R08V2SemanticPin,
} from '../scripts/lib/media-pdp0-root-selected-source-integration-r9-r08-v2-guard.mjs';

const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const digest=(letter='a')=>letter.repeat(64);
const material=JSON.parse(fs.readFileSync(new URL('../docs/implementation/observations/media-pdp0-parent-case-resolution-candidates/media-pdp0-root-selected-source-integration-r9-r08.decision-section-material.r5.candidate.v1.json',import.meta.url),'utf8'));
const baseDecisionLogText=fs.readFileSync(new URL('../.product-experience/decision-log.md',import.meta.url),'utf8');
function fixture(){
  const candidateSha256=digest('c'),freezeSha256=digest('d');
  const ids=['PXD-901','PXD-902','PXD-903','PXD-904'];
  const decisionLogText=`${baseDecisionLogText.trimEnd()}\n\n${ids.map((id,i)=>`### ${id} — Test-only section fixture\n\nTest-only authority text ${i+1}.\n\n`).join('')}`;
  const selectors=ids.map(id=>{const selected=fingerprintPxdDecisionSection(decisionLogText,id);return {ref:`.product-experience/decision-log.md#${id}`,text:selected.section,sectionSha256:selected.sha256};});
  const recordRefs={sourceOwnerDecision:R9R08_V2_RECORD_REFS[0],rootAdoptionDecision:R9R08_V2_RECORD_REFS[1],profileRegistration:R9R08_V2_RECORD_REFS[2],applyAuthorization:R9R08_V2_RECORD_REFS[3]};
  const actorTrust=['PDP0_SOURCE_OWNER','ROOT_AUTHORITY','PDP0_PROFILE_REGISTRAR','CANONICAL_APPLY_AUTHORITY'].map((role,i)=>({identity:`actor-${i+1}`,role,status:'TRUSTED_CURRENT_ROLE_EVIDENCE',credentialRef:`cred/${i}`,credentialSha256:digest('e'),grantRef:`grant/${i}`,grantSha256:digest('f')}));
  const liveReadSet=R9R08_V2_READ_SET.map((targetRef,index)=>({targetRef,sha256:digest(String(index+1))}));
  const targetRows=R9R08_V2_WRITE_TARGETS.map(targetRef=>({targetRef,preimageSha256:liveReadSet.find(row=>row.targetRef===targetRef).sha256,postimageSha256:digest('b')}));
  const profile={schemaVersion:'media.pdp0.root-selected-source-integration.r9-r08.operation-profile-registration.v2',profileId:R9R08_V2_PROFILE_ID,registrationStatus:'REGISTERED_FOR_EXACT_R9_R08_SOURCE_SUCCESSOR_ONLY',candidateRef:'candidate.json',candidateSha256,freezeRef:'freeze.json',freezeSha256,semanticReviewRef:'review.json',semanticReviewSha256:digest('9'),targetRows,authoritySections:selectors.map(({ref,sectionSha256})=>({ref,sectionSha256})),recordRefs};
  const records=[];let previous=null;
  const kinds=['PDP0_SOURCE_OWNER_DECISION','ROOT_ADOPTION_DECISION','OPERATION_PROFILE_REGISTRATION','DISTINCT_APPLY_AUTHORIZATION'];
  for(let i=0;i<3;i++){
    const value={recordKind:kinds[i],recordRef:Object.values(recordRefs)[i],decisionRef:selectors[i].ref,profileId:R9R08_V2_PROFILE_ID,candidateSha256,freezeSha256,actorIdentity:`actor-${i+1}`,actorRole:['PDP0_SOURCE_OWNER','ROOT_AUTHORITY','PDP0_PROFILE_REGISTRAR','CANONICAL_APPLY_AUTHORITY'][i],...(i===2?{operationProfile:profile}:{}),...(i?{predecessorRecordSha256:previous}:{})};
    const bytes=Buffer.from(`${JSON.stringify(value,null,2)}\n`);previous=hash(bytes);records.push({value,bytes,sha256:previous});
  }
  const authorization={schemaVersion:'media.pdp0.root-selected-source-integration-r9-r08.apply-authorization.v2',effect:'APPLY_EXACT_R9_R08_SPLIT_SOURCE_SUCCESSOR',profileId:R9R08_V2_PROFILE_ID,candidateRef:'candidate.json',candidateSha256,freezeRef:'freeze.json',freezeSha256,profileRegistrationRef:recordRefs.profileRegistration,profileRegistrationSha256:records[2].sha256,sourceOwnerDecisionRef:recordRefs.sourceOwnerDecision,sourceOwnerDecisionSha256:records[0].sha256,rootAdoptionDecisionRef:recordRefs.rootAdoptionDecision,rootAdoptionDecisionSha256:records[1].sha256,semanticReviewRef:'review.json',semanticReviewSha256:digest('9'),readSetVersion:'media.pdp0.root-selected-source-integration.r9-r08.apply-read-set.v2',sourceBaseline:structuredClone(liveReadSet),wholeDecisionLogSha256:liveReadSet[5].sha256,targetRows,decisionRef:selectors[3].ref,decisionSectionSha256:selectors[3].sectionSha256,applyAuthority:{identity:actorTrust[3].identity,role:'CANONICAL_APPLY_AUTHORITY',credentialRef:actorTrust[3].credentialRef,credentialSha256:actorTrust[3].credentialSha256,roleGrantRef:actorTrust[3].grantRef,roleGrantSha256:actorTrust[3].grantSha256},authorityBoundary:{canonicalApply:'EXACT_R9_R08_CANONICAL_SOURCE_APPLY_AUTHORIZED',phaseStatusEffect:'NONE'},recordKind:'DISTINCT_APPLY_AUTHORIZATION',recordRef:recordRefs.applyAuthorization,actorIdentity:actorTrust[3].identity,actorRole:actorTrust[3].role,predecessorRecordSha256:records[2].sha256};
  const authorizationBytes=Buffer.from(`${JSON.stringify(authorization,null,2)}\n`);records.push({value:authorization,bytes:authorizationBytes,sha256:hash(authorizationBytes)});
  return {profile,records,actorTrust,liveReadSet,targetRows,authorization,material,decisionLogText};
}
const admission=source=>validateR9R08V2ApplyAdmission(source);

test('v2 authority admission fails closed until the fixed authenticated actor registry is registered',()=>{
  const source=fixture();
  assert.throws(()=>admission(source),/fixed authenticated actor trust registry is not registered/u);
});

const negatives=[
  ['wrong authorization version',s=>s.authorization.schemaVersion='v1'],
  ['wrong apply effect',s=>s.authorization.effect='APPLY_ANYTHING'],
  ['unregistered profile id',s=>s.authorization.profileId='caller-selected-profile'],
  ['wrong read-set version',s=>s.authorization.readSetVersion='v1'],
  ['malformed candidate digest',s=>s.authorization.candidateSha256='not-a-digest'],
  ['missing read-set member',s=>s.authorization.sourceBaseline.pop()],
  ['reordered read-set paths',s=>s.authorization.sourceBaseline.reverse()],
  ['duplicate read-set path',s=>s.authorization.sourceBaseline[1].targetRef=s.authorization.sourceBaseline[0].targetRef],
  ['live whole-log drift',s=>s.liveReadSet[5].sha256=digest('0')],
  ['authorization whole-log hash differs from its baseline',s=>s.authorization.wholeDecisionLogSha256=digest('0')],
  ['extra write target',s=>s.authorization.targetRows.push({...s.authorization.targetRows[3]})],
  ['reordered write target',s=>s.authorization.targetRows.reverse()],
  ['write target preimage differs from seven-file baseline',s=>s.authorization.targetRows[0].preimageSha256=digest('0')],
  ['decision log substituted as a write target',s=>s.authorization.targetRows[0].targetRef='.product-experience/decision-log.md'],
  ['duplicate profile-owned section selector',s=>s.profile.authoritySections[3].ref=s.profile.authoritySections[0].ref],
  ['section hash differs from owner-allocated profile pin',s=>s.decisionLogText=s.decisionLogText.replace('Test-only authority text 3.','Tampered test section.')],
  ['out-of-order authority record',s=>[s.records[0],s.records[1]]=[s.records[1],s.records[0]]],
  ['stale external authority JSON digest',s=>s.records[1].sha256=digest('0')],
  ['broken predecessor digest',s=>s.records[2].value.predecessorRecordSha256=digest('0')],
  ['identity string without current trusted role evidence',s=>s.actorTrust[3]='root@example.invalid'],
  ['caller-selected owner record path',s=>s.authorization.sourceOwnerDecisionRef='test/owner.json'],
  ['unregistered target mutation',s=>s.profile.targetRows[0].postimageSha256=digest('0')],
  ['unclassified profile field',s=>s.profile.allowAnyTarget=true],
];
for(const [name,mutate] of negatives)test(`v2 guard rejects ${name}`,()=>{
  const source=fixture();mutate(source);assert.throws(()=>admission(source),/R9-R08 v2 guard:/);
});

test('semantic source currentness pin remains independent from post-authority whole-file CAS',()=>{
  const source=fixture();
  assert.equal(validateR9R08V2SemanticPin({material:source.material,decisionLogText:source.decisionLogText}).semanticCurrentnessPinOnly,true);
  const changedLog=source.decisionLogText.replace('No PDP-0 capability meaning changes.','Changed for the negative test.');
  assert.throws(()=>validateR9R08V2SemanticPin({material:source.material,decisionLogText:changedLog}),/PXD-225 semantic section pin is stale/);
  assert.throws(()=>validateR9R08V2ExternalApplyReadSet({authorization:source.authorization,liveReadSet:source.liveReadSet.slice(0,6)}),/live seven-file read set/);
});

test('fixed-path under-lease CAS probe fails closed while apply authorization is absent',()=>{
  const result=validateMediaPdp0RootSelectedSourceIntegrationR9R08V2ReadSetUnderLease();
  assert.deepEqual(result,{blocked:true,blocker:'DISTINCT_EXACT_INPUT_APPLY_AUTHORIZATION_NOT_RECORDED',canonicalApply:'NONE'});
});
