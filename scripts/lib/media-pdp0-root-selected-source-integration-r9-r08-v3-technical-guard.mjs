import crypto from 'node:crypto';
import {fingerprintPxdDecisionSection} from './pdp0-phase-scoped-source-fingerprints.mjs';
import {R9R08_V2_READ_SET,R9R08_V2_WRITE_TARGETS} from './media-pdp0-root-selected-source-integration-r9-r08-v2-guard.mjs';

export const R9R08_V3_PROFILE_ID='media.pdp0.root-selected-source-integration.r9-r08.source-only-technical.v3';
export const R9R08_V3_EFFECT='APPLY_EXACT_R9_R08_SOURCE_ONLY_TECHNICAL_SUCCESSOR';
export const R9R08_V3_DELEGATION_REF='docs/implementation/observations/media-pdp0-parent-case-resolution-candidates/media-pdp0-root-selected-source-integration-r9-r08.technical-source-role-delegation.v1.json';
export const R9R08_V3_REVOCATION_REF='config/closure/media-product-definition/technical-source-role-revocations.v1.json';
export const R9R08_V3_POLICY_REF='config/closure/media-product-definition/owner-execution-authorization.v1.json';
export const R9R08_V3_ROOT_DECISION_REF='../ghatana-lifecycle/docs/engineering/reviews/gtool-critical-2026-10-23/central/media-r08-source-technical-authority-boundary-root-decision-r01.json';
export const R9R08_V3_POLICY_SHA256='9a083ad119062b16865c944def9bdee1e14ca924be76e34b6f332c4aca798319';
export const R9R08_V3_ROOT_DECISION_SHA256='26e437be25c5ad465b3e48fb1a9c53e1bec58f85ac667cb60fa358dd41d65a70';
export const R9R08_V2_GUARD_BASELINE_SHA256='e6f2f06d9507eafdc20b30378b402bf9f22448511c0355f95272ab75d8ec0895';
export const R9R08_V3_AGENTS_BASELINE_SHA256='a3ad22a9d18f264329ab64264efdf81fdd407f2ea9f33bd4f7f982787b83b829';
export const R9R08_V3_SEMANTIC_SELECTOR='.product-experience/decision-log.md#PXD-225-section';
export const R9R08_V3_DELEGATION_SECTION_ID='PXD-901';
export const R9R08_V3_ROLES=Object.freeze([
  {role:'PDP0_TECHNICAL_SOURCE_OWNER',scopeId:'R9-R08-PDP0-SOURCE-OWNER-DECISION'},
  {role:'PDP0_TECHNICAL_ROOT_ADOPTER',scopeId:'R9-R08-PDP0-ROOT-ADOPTION-DECISION'},
  {role:'PDP0_TECHNICAL_PROFILE_REGISTRAR',scopeId:'R9-R08-PDP0-EXACT-PROFILE-REGISTRATION'},
  {role:'PDP0_TECHNICAL_APPLY_AUTHORITY',scopeId:'R9-R08-PDP0-EXACT-FOUR-TARGET-SOURCE-APPLY'},
]);
export const R9R08_V3_AUTHORIZATION_KEYS=Object.freeze([
  'schemaVersion','recordKind','delegationId','status','repository','macroStage','phaseId','effect','profileId',
  'delegatingPrincipal','policyRef','policySha256','rootBoundaryDecisionRef',
  'rootBoundaryDecisionSha256','agentsRef','agentsSha256','candidateRef','candidateSha256','freezeRef','freezeSha256','semanticReviewRef',
  'semanticReviewSha256','semanticSelector','semanticSectionSha256','delegationDecisionSectionSha256','sourceBaseline','targetRows','roles','issuedAt',
  'expiresAt','revocationStatus','revocationRegisterRef','revocationRegisterSha256','authorityBoundary',
]);

const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`
  :value&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    :JSON.stringify(value);
const fail=message=>{throw new Error(`R9-R08 v3 technical source guard: ${message}`);};
const isSha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const exactKeys=(value,keys,label)=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||canonical(Object.keys(value).sort())!==canonical([...keys].sort()))fail(`${label} has missing or unknown fields`);
};
const principalPattern=/^agent:thread:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const roleSectionId=index=>`PXD-${902+index}`;
function pxdSectionRecord(text,id,expectedHash,label){
  const actual=fingerprintPxdDecisionSection(text,id);
  if(actual.sha256!==expectedHash)fail(`${label} section pin is stale`);
  const marker=new RegExp(`^### ${id}[^\\n]*\\n`,'mu').exec(text);
  const start=marker?marker.index+marker[0].length:-1;
  const next=start<0?-1:text.indexOf('\n### ',start);
  const body=start<0?'':text.slice(start,next<0?text.length:next);
  const blocks=[...body.matchAll(/```json\s*\n([\s\S]*?)\n```/gu)];
  if(blocks.length!==1)fail(`${label} must contain exactly one typed JSON decision block`);
  try{return JSON.parse(blocks[0][1]);}catch{fail(`${label} typed JSON decision block is invalid`);}
}

/**
 * Validate ordinary PDP-0 technical source delegation. This path intentionally
 * does not accept or resolve credentials, signatures, native reviewer evidence,
 * acceptance, closure receipts, or delivery authority.
 */
export function validateR9R08V3TechnicalSourceDelegation({delegation,policy,policySha256,rootBoundaryDecision,
  rootBoundaryDecisionSha256,agentsSha256,v2GuardSha256,revocationRegister,revocationRegisterSha256,liveReadSet,decisionLogText,now=Date.now()}){
  exactKeys(delegation,R9R08_V3_AUTHORIZATION_KEYS,'technical source role delegation');
  if(delegation.schemaVersion!=='media.pdp0.root-selected-source-integration.r9-r08.technical-source-role-delegation.v1'
    ||delegation.recordKind!=='ROOT_DELEGATED_NON_SPECIALIST_TECHNICAL_SOURCE_ROLES'||delegation.status!=='ACTIVE'
    ||typeof delegation.delegationId!=='string'||delegation.delegationId.length===0
    ||delegation.repository!=='samujjwal/ghatana-media'||delegation.macroStage!=='DISCOVERY'||delegation.phaseId!=='PDP-0'
    ||delegation.effect!==R9R08_V3_EFFECT||delegation.profileId!==R9R08_V3_PROFILE_ID)fail('delegation type, lifecycle scope, or source-only effect is invalid');
  if(delegation.policyRef!==R9R08_V3_POLICY_REF||delegation.policySha256!==R9R08_V3_POLICY_SHA256
    ||policySha256!==R9R08_V3_POLICY_SHA256||sha(Buffer.from(JSON.stringify(policy,null,2)+'\n'))!==policySha256
    ||policy?.approvedOwnerDecisions?.ownerRoles===undefined||policy?.trustedAdmission!=='NOT_ISSUED'
    ||!Array.isArray(policy?.requiresActualIndependentAuthority))fail('live owner policy does not support the pinned delegated technical-source lane');
  if(delegation.rootBoundaryDecisionRef!==R9R08_V3_ROOT_DECISION_REF
    ||delegation.rootBoundaryDecisionSha256!==R9R08_V3_ROOT_DECISION_SHA256
    ||delegation.agentsRef!=='AGENTS.md'||delegation.agentsSha256!==R9R08_V3_AGENTS_BASELINE_SHA256
    ||rootBoundaryDecisionSha256!==R9R08_V3_ROOT_DECISION_SHA256
    ||sha(Buffer.from(JSON.stringify(rootBoundaryDecision,null,2)+'\n'))!==rootBoundaryDecisionSha256
    ||rootBoundaryDecision?.decision!=='APPROVE_EXPLICIT_VERSIONED_TECHNICAL_SOURCE_ONLY_OWNER_WORKFLOW_IMPLEMENTATION'
    ||rootBoundaryDecision?.effectAuthorizedNow!=='SOFTWARE_AND_PROPOSAL_PREPARATION_ONLY_NO_CANONICAL_SOURCE_APPLICATION'
    ||rootBoundaryDecision?.nativeTrustRegistered!==false||rootBoundaryDecision?.nativeAcceptance!==false
    ||rootBoundaryDecision?.release!==false
    ||agentsSha256!==R9R08_V3_AGENTS_BASELINE_SHA256
    ||rootBoundaryDecision?.baseline?.find(row=>row.repository==='ghatana-media'&&row.path==='AGENTS.md')?.sha256!==R9R08_V3_AGENTS_BASELINE_SHA256
    ||v2GuardSha256!==R9R08_V2_GUARD_BASELINE_SHA256
    ||rootBoundaryDecision?.baseline?.find(row=>row.repository==='ghatana-media'&&row.path==='scripts/lib/media-pdp0-root-selected-source-integration-r9-r08-v2-guard.mjs')?.sha256!==R9R08_V2_GUARD_BASELINE_SHA256)
    fail('pinned root boundary decision does not authorize only implementation and proposal preparation or protected v2 has drifted');
  if(!principalPattern.test(delegation.delegatingPrincipal??'')
    ||delegation.delegatingPrincipal!==rootBoundaryDecision?.actorIdentity)
    fail('delegating principal does not match the principal on the pinned root boundary decision');
  for(const [key,value] of [['candidateSha256',delegation.candidateSha256],
    ['freezeSha256',delegation.freezeSha256],['semanticReviewSha256',delegation.semanticReviewSha256],
    ['semanticSectionSha256',delegation.semanticSectionSha256],['delegationDecisionSectionSha256',delegation.delegationDecisionSectionSha256],
    ['revocationRegisterSha256',delegation.revocationRegisterSha256]])
    if(!isSha(value))fail(`${key} is malformed`);
  if(delegation.revocationStatus!=='NOT_REVOKED'||delegation.revocationRegisterRef!==R9R08_V3_REVOCATION_REF
    ||revocationRegisterSha256!==delegation.revocationRegisterSha256
    ||sha(Buffer.from(JSON.stringify(revocationRegister,null,2)+'\n'))!==revocationRegisterSha256
    ||revocationRegister?.schemaVersion!=='media.pdp0.root-selected-source-integration.r9-r08.technical-source-role-revocations.v1'
    ||!Array.isArray(revocationRegister?.revokedDelegationIds)
    ||revocationRegister.revokedDelegationIds.includes(delegation.delegationId))fail('role delegation is stale, revoked, or its live revocation register differs');
  const issued=Date.parse(delegation.issuedAt),expires=Date.parse(delegation.expiresAt);
  if(!Number.isFinite(issued)||!Number.isFinite(expires)||new Date(issued).toISOString()!==delegation.issuedAt
    ||new Date(expires).toISOString()!==delegation.expiresAt||issued>now||expires<=now||expires<=issued)
    fail('technical role delegation is outside its validity window');
  if(delegation.semanticSelector!==R9R08_V3_SEMANTIC_SELECTOR||typeof decisionLogText!=='string')fail('PXD-225 source semantic guard is missing');
  const currentSemantic=fingerprintPxdDecisionSection(decisionLogText,'PXD-225').sha256;
  if(currentSemantic!==delegation.semanticSectionSha256)fail('PXD-225 semantic section pin is stale');
  const sourceRefs=R9R08_V2_READ_SET;
  if(!Array.isArray(delegation.sourceBaseline)||delegation.sourceBaseline.length!==7
    ||canonical(delegation.sourceBaseline.map(row=>row.targetRef))!==canonical(sourceRefs)
    ||canonical(liveReadSet.map(row=>row.targetRef))!==canonical(sourceRefs))fail('seven-member current source read set differs from the delegation');
  delegation.sourceBaseline.forEach((row,index)=>{
    exactKeys(row,['targetRef','sha256'],`source baseline pin ${index+1}`);
    if(!isSha(row.sha256)||row.sha256!==liveReadSet[index]?.sha256)fail('seven-member current source read set differs from the delegation');
  });
  const loggedBytes=liveReadSet.find(row=>row.targetRef==='.product-experience/decision-log.md')?.bytes;
  if(!Buffer.isBuffer(loggedBytes)||sha(loggedBytes)!==delegation.sourceBaseline.find(row=>row.targetRef==='.product-experience/decision-log.md')?.sha256
    ||loggedBytes.toString('utf8')!==decisionLogText)fail('whole-log bytes passed to semantic section parsing do not match the pinned seventh read-set member');
  if(!Array.isArray(delegation.targetRows)||delegation.targetRows.length!==4
    ||canonical(delegation.targetRows.map(row=>row.targetRef))!==canonical(R9R08_V2_WRITE_TARGETS))
    fail('four exact source target pins are missing or out of order');
  delegation.targetRows.forEach((row,index)=>{
    exactKeys(row,['targetRef','preimageSha256','postimageSha256'],`target pin ${index+1}`);
    if(!isSha(row.preimageSha256)||!isSha(row.postimageSha256)
      ||row.preimageSha256!==delegation.sourceBaseline.find(pin=>pin.targetRef===row.targetRef)?.sha256)
      fail('four exact source target pins are missing or out of order');
  });
  if(!Array.isArray(delegation.roles)||delegation.roles.length!==R9R08_V3_ROLES.length)fail('four root-delegated technical role assignments are required');
  const effectRolePrincipals=new Set();

  const rootDecisionRecord=pxdSectionRecord(decisionLogText,R9R08_V3_DELEGATION_SECTION_ID,
    delegation.delegationDecisionSectionSha256,'root delegation decision');
  const commonDecision={delegationId:delegation.delegationId,repository:delegation.repository,macroStage:delegation.macroStage,
    phaseId:delegation.phaseId,effect:delegation.effect,profileId:delegation.profileId,candidateRef:delegation.candidateRef,
    candidateSha256:delegation.candidateSha256,freezeRef:delegation.freezeRef,freezeSha256:delegation.freezeSha256,
    sourcePins:delegation.sourceBaseline.filter(row=>row.targetRef!=='.product-experience/decision-log.md'),
    targetRows:delegation.targetRows,issuedAt:delegation.issuedAt,expiresAt:delegation.expiresAt,
    revocationStatus:delegation.revocationStatus,revocationRegisterRef:delegation.revocationRegisterRef,
    revocationRegisterSha256:delegation.revocationRegisterSha256,authorityBoundary:delegation.authorityBoundary};
  if(rootDecisionRecord.recordKind!=='ROOT_DELEGATED_NON_SPECIALIST_TECHNICAL_SOURCE_ROLES'
    ||rootDecisionRecord.delegatingPrincipal!==delegation.delegatingPrincipal
    ||canonical(Object.fromEntries(Object.keys(commonDecision).map(key=>[key,rootDecisionRecord[key]])))!==canonical(commonDecision)
    ||!Array.isArray(rootDecisionRecord.roles)||rootDecisionRecord.roles.length!==R9R08_V3_ROLES.length)
    fail('PXD root delegation decision is not a semantic match for the exact pinned source-only delegation');
  for(let index=0;index<R9R08_V3_ROLES.length;index++){
    const role=delegation.roles[index],expected=R9R08_V3_ROLES[index];
    exactKeys(role,['role','principal','scopeId','decisionRef','decisionSectionSha256'],`technical role ${index+1}`);
    if(role.role!==expected.role||role.scopeId!==expected.scopeId||!principalPattern.test(role.principal??''))
      fail(`technical role ${expected.role} lacks exact principal or scope`);
    const expectedSectionId=roleSectionId(index),selector=`.product-experience/decision-log.md#${expectedSectionId}-section`;
    if(role.decisionRef!==selector||!isSha(role.decisionSectionSha256))fail(`technical role ${expected.role} lacks a fixed decision selector and section digest`);
    const rootRole=rootDecisionRecord.roles[index];
    if(canonical(rootRole)!==canonical({role:role.role,principal:role.principal,scopeId:role.scopeId,
      decisionRef:role.decisionRef,decisionSectionSha256:role.decisionSectionSha256}))
      fail(`PXD root delegation omits or changes technical role ${expected.role}`);
    const roleRecord=pxdSectionRecord(decisionLogText,expectedSectionId,role.decisionSectionSha256,`technical role ${expected.role}`);
    if(canonical(roleRecord)!==canonical({recordKind:'TECHNICAL_SOURCE_ROLE_ASSIGNMENT',...commonDecision,
      role:role.role,principal:role.principal,scopeId:role.scopeId}))
      fail(`PXD role decision for ${expected.role} is semantically unrelated to its exact source-only assignment`);
    if(effectRolePrincipals.has(role.principal))fail('the four technical effect-role principals must be mutually distinct');
    effectRolePrincipals.add(role.principal);
    if(role.principal===delegation.delegatingPrincipal&&role.role!=='PDP0_TECHNICAL_ROOT_ADOPTER')
      fail('only PDP0_TECHNICAL_ROOT_ADOPTER may share the pinned delegating principal');
  }
  if(canonical({recordKind:rootDecisionRecord.recordKind,delegatingPrincipal:rootDecisionRecord.delegatingPrincipal,
    ...Object.fromEntries(Object.keys(commonDecision).map(key=>[key,rootDecisionRecord[key]])),roles:rootDecisionRecord.roles})
    !==canonical({recordKind:'ROOT_DELEGATED_NON_SPECIALIST_TECHNICAL_SOURCE_ROLES',delegatingPrincipal:delegation.delegatingPrincipal,
      ...commonDecision,roles:delegation.roles.map(({role,principal,scopeId,decisionRef,decisionSectionSha256})=>({role,principal,scopeId,decisionRef,decisionSectionSha256}))}))
    fail('PXD root delegation decision has extra, missing, or changed fields');
  exactKeys(delegation.authorityBoundary,['sourceApply','nativeVerifier','pdpAcceptance','nativeReceipt','build','delivery','release'],'technical source authority boundary');
  if(canonical(delegation.authorityBoundary)!==canonical({sourceApply:'EXACT_FOUR_TARGET_R9_R08_ONLY',nativeVerifier:'NONE',
    pdpAcceptance:'NONE',nativeReceipt:'NONE',build:'NONE',delivery:'NONE',release:'NONE'}))
    fail('delegation crosses the source-only effect boundary');
  return {delegatedTechnicalRoles:4,distinctEffectRolePrincipals:effectRolePrincipals.size,
    delegatorAlsoRootAdopter:delegation.roles.find(role=>role.role==='PDP0_TECHNICAL_ROOT_ADOPTER')?.principal===delegation.delegatingPrincipal,
    sourceReadSetCount:7,sourceWriteTargetCount:4,
    semanticSelector:R9R08_V3_SEMANTIC_SELECTOR,sourceOnly:true,nativeTrust:false};
}
