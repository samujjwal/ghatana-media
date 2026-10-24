import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {fingerprintPxdDecisionSection} from '../scripts/lib/pdp0-phase-scoped-source-fingerprints.mjs';
import {
  R9R08_V2_PROFILE_ID,
  R9R08_V2_RECORD_REFS,
  R9R08_V2_WRITE_TARGETS,
  requireR9R08V2TrustedActors,
  validateR9R08V2AuthorityChain,
} from '../scripts/lib/media-pdp0-root-selected-source-integration-r9-r08-v2-guard.mjs';

const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const d=char=>char.repeat(64);

function fixture({rawRecords=true,credentialEvidence=false}={}){
  const ids=['PXD-991','PXD-992','PXD-993','PXD-994'];
  const decisionLogText=`${ids.map((id,index)=>`### ${id} — audit fixture ${index+1}\n\nDecision section ${index+1}.\n\n`).join('')}`;
  const authoritySections=ids.map(id=>{
    const row=fingerprintPxdDecisionSection(decisionLogText,id);
    return {ref:`.product-experience/decision-log.md#${id}`,sectionSha256:row.sha256};
  });
  const roles=['PDP0_SOURCE_OWNER','ROOT_AUTHORITY','PDP0_PROFILE_REGISTRAR','CANONICAL_APPLY_AUTHORITY'];
  const recordRefs={sourceOwnerDecision:R9R08_V2_RECORD_REFS[0],rootAdoptionDecision:R9R08_V2_RECORD_REFS[1],profileRegistration:R9R08_V2_RECORD_REFS[2],applyAuthorization:R9R08_V2_RECORD_REFS[3]};
  const profile={schemaVersion:'media.pdp0.root-selected-source-integration.r9-r08.operation-profile-registration.v2',profileId:R9R08_V2_PROFILE_ID,
    registrationStatus:'REGISTERED_FOR_EXACT_R9_R08_SOURCE_SUCCESSOR_ONLY',candidateRef:'candidate.json',candidateSha256:d('a'),freezeRef:'freeze.json',freezeSha256:d('b'),
    semanticReviewRef:'review.json',semanticReviewSha256:d('c'),targetRows:R9R08_V2_WRITE_TARGETS.map(targetRef=>({targetRef,preimageSha256:d('d'),postimageSha256:d('e')})),authoritySections,recordRefs};
  const actorTrust=roles.map((role,index)=>({identity:`fabricated-actor-${index+1}`,role,status:'TRUSTED_CURRENT_ROLE_EVIDENCE',
    credentialRef:`arbitrary/path/${index}.json`,credentialSha256:d('f'),grantRef:`arbitrary/grant/${index}.json`,grantSha256:d('0')}));
  let previousRecordSha256;
  const records=roles.map((role,index)=>{
    const record={recordKind:['PDP0_SOURCE_OWNER_DECISION','ROOT_ADOPTION_DECISION','OPERATION_PROFILE_REGISTRATION','DISTINCT_APPLY_AUTHORIZATION'][index],
      recordRef:R9R08_V2_RECORD_REFS[index],decisionRef:authoritySections[index].ref,profileId:R9R08_V2_PROFILE_ID,
      candidateSha256:profile.candidateSha256,freezeSha256:profile.freezeSha256,actorIdentity:actorTrust[index].identity,actorRole:role,
      ...(index===2?{operationProfile:profile}:{}),
      ...(index?{predecessorRecordSha256:previousRecordSha256}:{} )};
    const bytes=rawRecords?Buffer.from(`${JSON.stringify(record,null,2)}\n`):Buffer.from(`${JSON.stringify({unrelatedRecord:index})}\n`);
    const sha256=sha(bytes);previousRecordSha256=sha256;
    return {value:record,bytes,sha256};
  });
  return {profile,records,actorTrust,decisionLogText};
}

test('authority record values must equal the exact parsed content of their hashed bytes',()=>{
  const source=fixture({rawRecords:false});
  assert.throws(()=>validateR9R08V2AuthorityChain(source),/parsed external bytes differ/u);
});

test('caller-supplied credential and role-grant strings cannot satisfy an unregistered fixed trust source',()=>{
  const source=fixture({credentialEvidence:false});
  assert.throws(()=>requireR9R08V2TrustedActors(source.actorTrust),/fixed authenticated actor trust registry is not registered/u);
  assert.ok(source.actorTrust.every(actor=>actor.identity.startsWith('fabricated-actor-')));
});
