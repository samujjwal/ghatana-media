import crypto from 'node:crypto';
import {fingerprintPxdDecisionSection} from './pdp0-phase-scoped-source-fingerprints.mjs';

export const R9R08_V2_PROFILE_ID='media.pdp0.root-selected-source-integration.r9-r08.operation-profile.v2';
export const R9R08_V2_READ_SET=Object.freeze([
  '.product-experience/pdp-0-product-truth/capabilities.yaml',
  '.product-experience/pdp-0-product-truth/requirements.yaml',
  'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json',
  '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml',
  '.product-experience/pdp-0-product-truth/campaign-extensions.yaml',
  '.product-experience/decision-log.md',
  '.product-experience/pdp-0-product-truth/quality-policy.yaml',
]);
export const R9R08_V2_WRITE_TARGETS=Object.freeze([
  '.product-experience/pdp-0-product-truth/capabilities.yaml',
  '.product-experience/pdp-0-product-truth/requirements.yaml',
  '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml',
  'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json',
]);
export const R9R08_V2_RECORD_ORDER=Object.freeze([
  ['PDP0_SOURCE_OWNER_DECISION','sourceOwnerDecision'],
  ['ROOT_ADOPTION_DECISION','rootAdoptionDecision'],
  ['OPERATION_PROFILE_REGISTRATION','profileRegistration'],
  ['DISTINCT_APPLY_AUTHORIZATION','applyAuthorization'],
]);
export const R9R08_V2_RECORD_REFS=Object.freeze([
  'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates/media-pdp0-root-selected-source-integration-r9-r08.source-owner-decision.r2.json',
  'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates/media-pdp0-root-selected-source-integration-r9-r08.root-adoption-decision.r2.json',
  'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates/media-pdp0-root-selected-source-integration-r9-r08.operation-profile-registration.r2.json',
  'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates/media-pdp0-root-selected-source-integration-r9-r08.apply-authorization.r2.json',
]);
// The current Media owner-execution authorization explicitly says trusted admission was not issued.
// Keep R9-R08 authority admission blocked until a fixed, independently anchored actor registry is registered.
export const R9R08_V2_TRUST_REGISTRY_STATUS='NOT_REGISTERED';

const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const canonical=value=>{
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const fail=message=>{throw new Error(`R9-R08 v2 guard: ${message}`);};
const isDigest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const exactKeys=(value,keys,label)=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||canonical(Object.keys(value).sort())!==canonical([...keys].sort()))fail(`${label} has missing or unknown fields`);
};
const orderedRows=(rows,refs,label)=>{
  if(!Array.isArray(rows)||canonical(rows.map(row=>row.targetRef))!==canonical(refs))fail(`${label} differs from the fixed ordered path set`);
};
export function requireR9R08V2TrustedActors(actorTrust){
  if(R9R08_V2_TRUST_REGISTRY_STATUS!=='REGISTERED')fail('fixed authenticated actor trust registry is not registered; caller-supplied actorTrust is not authority');
  if(!actorTrust||actorTrust.length!==4||actorTrust.some((actor,index)=>actor?.status!=='TRUSTED_CURRENT_ROLE_EVIDENCE'
    ||actor.role!==['PDP0_SOURCE_OWNER','ROOT_AUTHORITY','PDP0_PROFILE_REGISTRAR','CANONICAL_APPLY_AUTHORITY'][index]
    ||!actor.credentialRef||!isDigest(actor.credentialSha256)||!actor.grantRef||!isDigest(actor.grantSha256)))fail('identity strings lack current trusted credential and role-grant evidence');
  if(new Set(actorTrust.map(actor=>actor.identity)).size!==4||actorTrust.some(actor=>typeof actor.identity!=='string'||!actor.identity))fail('four authority roles must have distinct authenticated identities');
  return {distinctTrustedActors:true};
}
/**
 * Resolve the four source-record identities through the fixed authenticated
 * authority checker. Until that registry is registered, this deliberately
 * returns no evidence; source actor labels alone can never satisfy the gate.
 */
export function resolveR9R08V2TrustedActors(records){
  if(!Array.isArray(records)||records.length!==4)fail('four source-bound actor records are required for authority resolution');
  const claims=records.map(entry=>({identity:entry?.value?.actorIdentity,role:entry?.value?.actorRole}));
  return requireR9R08V2TrustedActors(claims);
}
function readProfileDecisionSections(profile,decisionLogText){
  return profile.authoritySections.map(binding=>{
    const match=/^\.product-experience\/decision-log\.md#(PXD-\d{3})$/u.exec(binding.ref??'');
    if(!match)fail('profile authority selector is not one exact owner-allocated PXD section');
    let selected;
    try{selected=fingerprintPxdDecisionSection(decisionLogText,match[1]);}
    catch{fail(`profile authority section is missing or ambiguous: ${binding.ref}`);}
    if(selected.sha256!==binding.sectionSha256)fail(`profile authority section hash is stale: ${binding.ref}`);
    return {ref:binding.ref,text:selected.section,sha256:selected.sha256};
  });
}

/**
 * Validate the final external apply read-set. Call only after acquiring the
 * shared source-amendment owner lock and immediately before target snapshots.
 * The decision log is a read guard and never a write target.
 */
export function validateR9R08V2ExternalApplyReadSet({authorization,liveReadSet}){
  const authKeys=['schemaVersion','effect','profileId','candidateRef','candidateSha256','freezeRef','freezeSha256',
    'profileRegistrationRef','profileRegistrationSha256','sourceOwnerDecisionRef','sourceOwnerDecisionSha256',
    'rootAdoptionDecisionRef','rootAdoptionDecisionSha256','semanticReviewRef','semanticReviewSha256',
    'readSetVersion','sourceBaseline','wholeDecisionLogSha256','targetRows','decisionRef','decisionSectionSha256',
    'applyAuthority','authorityBoundary','recordKind','recordRef','actorIdentity','actorRole','predecessorRecordSha256'];
  exactKeys(authorization,authKeys,'external apply authorization');
  if(authorization.schemaVersion!=='media.pdp0.root-selected-source-integration-r9-r08.apply-authorization.v2'
    ||authorization.effect!=='APPLY_EXACT_R9_R08_SPLIT_SOURCE_SUCCESSOR'
    ||authorization.profileId!==R9R08_V2_PROFILE_ID
    ||authorization.readSetVersion!=='media.pdp0.root-selected-source-integration.r9-r08.apply-read-set.v2')fail('authorization schema, effect, profile, or read-set version is invalid');
  if(authorization.sourceOwnerDecisionRef!==R9R08_V2_RECORD_REFS[0]
    ||authorization.rootAdoptionDecisionRef!==R9R08_V2_RECORD_REFS[1]
    ||authorization.profileRegistrationRef!==R9R08_V2_RECORD_REFS[2]
    ||authorization.recordRef!==R9R08_V2_RECORD_REFS[3])fail('authority record refs differ from the profile-fixed repository paths');
  if(!isDigest(authorization.candidateSha256)||!isDigest(authorization.freezeSha256)
    ||!isDigest(authorization.profileRegistrationSha256)||!isDigest(authorization.sourceOwnerDecisionSha256)
    ||!isDigest(authorization.rootAdoptionDecisionSha256)||!isDigest(authorization.semanticReviewSha256)
    ||!isDigest(authorization.wholeDecisionLogSha256)||!isDigest(authorization.decisionSectionSha256))fail('authorization contains malformed source digests');
  orderedRows(authorization.sourceBaseline,R9R08_V2_READ_SET,'authorized seven-file read set');
  orderedRows(liveReadSet,R9R08_V2_READ_SET,'live seven-file read set');
  if(authorization.sourceBaseline.some((row,index)=>!isDigest(row.sha256)||row.sha256!==liveReadSet[index].sha256))fail('a live whole-file preimage differs from the external apply authorization');
  const logPin=authorization.sourceBaseline.find(row=>row.targetRef==='.product-experience/decision-log.md');
  if(!logPin||authorization.wholeDecisionLogSha256!==logPin.sha256)fail('external authorization whole decision-log CAS is not the exact read-set member');
  orderedRows(authorization.targetRows,R9R08_V2_WRITE_TARGETS,'authorized four-target write set');
  if(authorization.targetRows.some((row,index)=>!isDigest(row.preimageSha256)||!isDigest(row.postimageSha256)
    ||row.preimageSha256!==authorization.sourceBaseline.find(pin=>pin.targetRef===R9R08_V2_WRITE_TARGETS[index])?.sha256))fail('write target preimages do not match the fixed read-set');
  if(authorization.targetRows.some(row=>row.targetRef==='.product-experience/decision-log.md'))fail('decision log cannot be a write target');
  if(authorization.authorityBoundary?.canonicalApply!=='EXACT_R9_R08_CANONICAL_SOURCE_APPLY_AUTHORIZED'
    ||authorization.authorityBoundary?.phaseStatusEffect!=='NONE')fail('authority boundary is invalid');
  return {readSetVersion:authorization.readSetVersion,readSetCount:7,writeTargetCount:4,
    decisionLogSha256:authorization.wholeDecisionLogSha256,decisionLogIsReadOnly:true};
}

/** Validate the profile-fixed authority record order and digest chain. */
export function validateR9R08V2AuthorityChain({profile,records,decisionLogText,actorTrust}){
  exactKeys(profile,['schemaVersion','profileId','registrationStatus','candidateRef','candidateSha256','freezeRef','freezeSha256',
    'semanticReviewRef','semanticReviewSha256','targetRows','authoritySections','recordRefs'],'v2 operation profile registration');
  if(profile?.schemaVersion!=='media.pdp0.root-selected-source-integration.r9-r08.operation-profile-registration.v2'
    ||profile.profileId!==R9R08_V2_PROFILE_ID||profile.registrationStatus!=='REGISTERED_FOR_EXACT_R9_R08_SOURCE_SUCCESSOR_ONLY')fail('exact v2 operation profile is not registered');
  if(!isDigest(profile.candidateSha256)||!isDigest(profile.freezeSha256)||!isDigest(profile.semanticReviewSha256)
    ||!profile.candidateRef||!profile.freezeRef||!profile.semanticReviewRef
    ||canonical(Object.values(profile.recordRefs??{}))!==canonical(R9R08_V2_RECORD_REFS))fail('profile source pins or fixed authority record refs are invalid');
  orderedRows(profile.targetRows,R9R08_V2_WRITE_TARGETS,'registered profile target rows');
  const selectors=profile.authoritySections;
  if(!Array.isArray(selectors)||selectors.length!==4||selectors.some(row=>typeof row.ref!=='string'||!row.ref.startsWith('.product-experience/decision-log.md#PXD-')||!isDigest(row.sectionSha256))
    ||new Set(selectors.map(row=>row.ref)).size!==4)fail('profile lacks four unique owner-allocated decision section selectors');
  if(!Array.isArray(records)||records.length!==4||typeof decisionLogText!=='string')fail('four ordered authority records and current decision-log bytes are required');
  const decisionSections=readProfileDecisionSections(profile,decisionLogText);
  const hashes=[];
  for(let i=0;i<R9R08_V2_RECORD_ORDER.length;i++){
    const [kind,key]=R9R08_V2_RECORD_ORDER[i],entry=records[i],record=entry?.value,section=decisionSections[i],binding=profile.authoritySections[i];
    const expectedRecordKeys=i===3
      ?['schemaVersion','effect','profileId','candidateRef','candidateSha256','freezeRef','freezeSha256','profileRegistrationRef','profileRegistrationSha256',
        'sourceOwnerDecisionRef','sourceOwnerDecisionSha256','rootAdoptionDecisionRef','rootAdoptionDecisionSha256','semanticReviewRef','semanticReviewSha256',
        'readSetVersion','sourceBaseline','wholeDecisionLogSha256','targetRows','decisionRef','decisionSectionSha256','applyAuthority','authorityBoundary',
        'recordKind','recordRef','actorIdentity','actorRole','predecessorRecordSha256']
      :['recordKind','recordRef','decisionRef','profileId','candidateSha256','freezeSha256','actorIdentity','actorRole',...(i?['predecessorRecordSha256']:[]),...(i===2?['operationProfile']:[])];
    exactKeys(record,expectedRecordKeys,`authority record ${i+1}`);
    if(i===2&&canonical(record.operationProfile)!==canonical(profile))fail('profile registration record does not contain the separately validated exact operation profile');
    if(record?.recordKind!==kind||record?.recordRef!==profile.recordRefs?.[key]||record?.recordRef!==R9R08_V2_RECORD_REFS[i]||record?.decisionRef!==binding.ref
      ||section?.ref!==binding.ref||section?.sha256!==binding.sectionSha256||!isDigest(section.sha256)
      ||typeof section.text!=='string'||sha(Buffer.from(section.text))!==section.sha256)fail(`authority record ${i+1} is not the exact fixed selector and expected role/order`);
    if(record.profileId!==R9R08_V2_PROFILE_ID||record.candidateSha256!==profile.candidateSha256||record.freezeSha256!==profile.freezeSha256)fail(`authority record ${i+1} is bound to different candidate inputs`);
    if(record.actorIdentity!==actorTrust?.[i]?.identity||record.actorRole!==actorTrust?.[i]?.role)fail(`authority record ${i+1} actor does not match its separately validated role evidence`);
    if(!Buffer.isBuffer(entry.bytes)||sha(entry.bytes)!==entry.sha256||!isDigest(entry.sha256))fail(`authority record ${i+1} external JSON digest is stale`);
    let parsedRecord;
    try{parsedRecord=JSON.parse(entry.bytes.toString('utf8'));}
    catch{fail(`authority record ${i+1} external bytes are not valid JSON`);}
    if(canonical(parsedRecord)!==canonical(record))fail(`authority record ${i+1} parsed external bytes differ from the validated record value`);
    const externalDigest=entry.sha256;
    if(i>0&&record.predecessorRecordSha256!==hashes[i-1])fail(`authority record ${i+1} predecessor digest is stale or missing`);
    hashes.push(externalDigest);
  }
  const trustedActors=requireR9R08V2TrustedActors(actorTrust);
  return {recordDigests:hashes,authoritySections:selectors.map(row=>row.ref),applyDecisionSectionSha256:decisionSections[3].sha256,...trustedActors};
}

/** The semantic source pin is checked independently from transaction CAS. */
export function validateR9R08V2SemanticPin({material,decisionLogText}){
  if(material?.schemaVersion!=='media.pdp0.root-selected-source-integration.r9-r08.material-binding.v2'
    ||material.materialKind!=='DECISION_SECTION'||material.decisionSectionRef!=='.product-experience/decision-log.md#PXD-225-section')fail('typed PXD-225 DECISION_SECTION binding is invalid');
  const actual=fingerprintPxdDecisionSection(decisionLogText,'PXD-225').sha256;
  if(!isDigest(actual)||actual!==material.decisionSectionRawPin?.decisionSectionSha256
    ||actual!==material.decisionSectionSha256)fail('PXD-225 semantic section pin is stale');
  if(material.decisionLogCaptureProvenance?.disposition!=='HISTORICAL_CAPTURE_PROVENANCE_ONLY; NOT_THE_POST_AUTHORITY_APPLY_READ_PREIMAGE')fail('historical whole-log provenance was mislabeled as current apply CAS');
  return {decisionSectionSha256:actual,semanticCurrentnessPinOnly:true};
}

/** One entry point for the read-only admission route; the writer calls this again under its shared CAS lease. */
export function validateR9R08V2ApplyAdmission({authorization,profile,records,actorTrust,liveReadSet,material,decisionLogText}){
  const semantic=validateR9R08V2SemanticPin({material,decisionLogText});
  const readSet=validateR9R08V2ExternalApplyReadSet({authorization,liveReadSet});
  const authority=validateR9R08V2AuthorityChain({profile,records,decisionLogText,actorTrust});
  const externalDigests=records.map(entry=>entry.sha256);
  if(authorization.candidateRef!==profile.candidateRef||authorization.candidateSha256!==profile.candidateSha256
    ||authorization.freezeRef!==profile.freezeRef||authorization.freezeSha256!==profile.freezeSha256
    ||authorization.semanticReviewRef!==profile.semanticReviewRef||authorization.semanticReviewSha256!==profile.semanticReviewSha256
    ||canonical(authorization.targetRows)!==canonical(profile.targetRows)
    ||authorization.sourceOwnerDecisionSha256!==externalDigests[0]
    ||authorization.rootAdoptionDecisionSha256!==externalDigests[1]
    ||authorization.profileRegistrationSha256!==externalDigests[2]
    ||authorization.profileRegistrationRef!==records[2].value.recordRef
    ||authorization.sourceOwnerDecisionRef!==records[0].value.recordRef
    ||authorization.rootAdoptionDecisionRef!==records[1].value.recordRef
    ||authorization.applyAuthority?.identity!==actorTrust[3].identity
    ||authorization.applyAuthority?.role!==actorTrust[3].role
    ||authorization.applyAuthority?.credentialRef!==actorTrust[3].credentialRef
    ||authorization.applyAuthority?.credentialSha256!==actorTrust[3].credentialSha256
    ||authorization.applyAuthority?.roleGrantRef!==actorTrust[3].grantRef
    ||authorization.applyAuthority?.roleGrantSha256!==actorTrust[3].grantSha256
    ||authorization.decisionRef!==profile.authoritySections[3].ref
    ||authorization.decisionSectionSha256!==authority.applyDecisionSectionSha256
    ||authorization.recordKind!=='DISTINCT_APPLY_AUTHORIZATION'
    ||authorization.recordRef!==records[3].value.recordRef
    ||authorization.actorIdentity!==actorTrust[3].identity
    ||authorization.actorRole!==actorTrust[3].role
    ||authorization.predecessorRecordSha256!==externalDigests[2]
    ||records[3].sha256!==sha(Buffer.from(`${JSON.stringify(authorization,null,2)}\n`))
    ||canonical(records[3].value)!==canonical(authorization)
    ||authorization.wholeDecisionLogSha256!==liveReadSet.find(row=>row.targetRef==='.product-experience/decision-log.md')?.sha256
    )fail('external apply authorization is not bound to the exact authority chain and apply-decision section');
  return {semantic,authority,readSet,canonicalApply:'READY_FOR_LOCKED_FIXED_TARGET_CAS_ONLY'};
}
