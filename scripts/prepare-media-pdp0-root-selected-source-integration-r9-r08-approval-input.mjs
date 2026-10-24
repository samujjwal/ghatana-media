import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import YAML from 'yaml';
import {fingerprintPxdDecisionSection} from './lib/pdp0-phase-scoped-source-fingerprints.mjs';
import {prepareR9R08ApplicationPlan} from './prepare-media-pdp0-root-selected-source-integration-r9-r08-application-plan.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const DIR='docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const LOG='.product-experience/decision-log.md';
const AUTH='.product-experience/authority-map.yaml';
const MATERIAL_BINDING_REVIEW=`${DIR}/media-pdp0-root-selected-source-integration-r9-r08-material-binding-review-r01.json`;
const MATERIAL_BINDING_REVIEW_SHA256='5c0c90c4ae7a31a1b7bd3b971c8b071daa1289675fa5327dece745f37239026d';
const PDP0_STATUS='docs/implementation/pdp-0-phase-dev-status.json';
const BASE=`${DIR}/media-pdp0-root-selected-source-integration-r9-r08`;
const sha=b=>createHash('sha256').update(b).digest('hex');
const canon=v=>JSON.stringify(sort(v));
function sort(v){if(Array.isArray(v))return v.map(sort);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])]));return v;}
const read=ref=>fs.readFileSync(path.join(ROOT,ref));
const readJson=ref=>JSON.parse(read(ref));
const bytes=v=>Buffer.from(`${JSON.stringify(v,null,2)}\n`);
const createOnly=(ref,expected,check)=>{
  const absolute=path.join(ROOT,ref);
  if(check){if(!fs.existsSync(absolute)||!fs.readFileSync(absolute).equals(expected))throw new Error(`R9-R08 approval artifact differs from deterministic source replay: ${ref}`);return;}
  if(fs.existsSync(absolute)){if(!fs.readFileSync(absolute).equals(expected))throw new Error(`refusing to overwrite immutable R9-R08 approval artifact: ${ref}`);return;}
  fs.writeFileSync(absolute,expected,{flag:'wx',mode:0o600});
};

function extractPxd225LabelSections(text){
  const section=fingerprintPxdDecisionSection(text,'PXD-225').section;
  const matches=[...section.matchAll(/^\*\*(Authority|Decision|Currentness|Boundary):\*\*/gm)];
  const expected=['Authority','Decision','Currentness','Boundary'];
  if(matches.length!==expected.length||matches.some((m,i)=>m[1]!==expected[i]))throw new Error('PXD-225 must contain exactly one ordered Authority, Decision, Currentness, and Boundary section');
  return matches.map((match,index)=>({
    label:match[1],
    raw:section.slice(match.index,matches[index+1]?.index??section.length),
  }));
}

export function buildR9R08DecisionSectionMaterial({decisionLogText,authorityMapText,historicalPdp0StatusSha256,historicalPdp0StatusPin,decisionLogWholeSha256=sha(Buffer.from(decisionLogText)),authorityMapWholeSha256=sha(Buffer.from(authorityMapText))}){
  const pxd=fingerprintPxdDecisionSection(decisionLogText,'PXD-225');
  const labels=extractPxd225LabelSections(decisionLogText);
  const authorityMap=YAML.parse(authorityMapText);
  const phase=authorityMap.canonicalPdpPhases?.find(row=>row.id==='PDP-0');
  const phaseAuthority=authorityMap.phaseAuthorities?.find(row=>row.phase==='PDP-0');
  if(!phase||!phaseAuthority)throw new Error('authority-map must contain canonical PDP-0 and phaseAuthorities PDP-0 records');
  const sectionRefs=labels.filter(({label})=>label!=='Authority').map(({label,raw})=>({
    sectionId:`PXD-225/${label}`,
    ref:`${LOG}#PXD-225/${label}`,
    sectionKind:'SEMANTIC_DECISION_SECTION',
    selection:'BOLD_LABEL_BODY_UNTIL_NEXT_PXD225_LABEL',
    sha256:sha(Buffer.from(raw,'utf8')),
  }));
  const pdpAuthorities=[
    {ref:`${LOG}#PXD-225/Authority`,sourceFileRef:LOG,sourceFileSha256:decisionLogWholeSha256,sectionKind:'DECISION_AUTHORITY_BASIS',selection:'BOLD_LABEL_BODY_UNTIL_NEXT_PXD225_LABEL',sectionSha256:sha(Buffer.from(labels.find(x=>x.label==='Authority').raw,'utf8'))},
    {ref:`${AUTH}#canonicalPdpPhases[PDP-0]`,sourceFileRef:AUTH,sourceFileSha256:authorityMapWholeSha256,sectionKind:'PDP_PHASE_SEMANTIC_OWNER_AUTHORITY',selection:'YAML_RECORD_BY_ARRAY_KEY:id=PDP-0',sectionSha256:sha(Buffer.from(canon(phase),'utf8'))},
    {ref:`${AUTH}#phaseAuthorities[PDP-0]`,sourceFileRef:AUTH,sourceFileSha256:authorityMapWholeSha256,sectionKind:'PDP_PHASE_OWNER_AUTHORITY',selection:'YAML_RECORD_BY_ARRAY_KEY:phase=PDP-0',sectionSha256:sha(Buffer.from(canon(phaseAuthority),'utf8'))},
  ];
  const authoritySectionBindings=[
    {sequence:1,recordKind:'PDP0_SOURCE_OWNER_DECISION',recordRef:`${DIR}/media-pdp0-root-selected-source-integration-r9-r08.source-owner-decision.r2.json`,decisionSelector:{status:'NOT_ALLOCATED_BY_DECISION_LOG_OWNER',ref:null,sha256:null},predecessorRecordRefs:[],recordDigestBinding:'EXACT_EXTERNAL_SOURCE_OWNER_DECISION_JSON_SHA256'},
    {sequence:2,recordKind:'ROOT_ADOPTION_DECISION',recordRef:`${DIR}/media-pdp0-root-selected-source-integration-r9-r08.root-adoption-decision.r2.json`,decisionSelector:{status:'NOT_ALLOCATED_BY_DECISION_LOG_OWNER',ref:null,sha256:null},predecessorRecordRefs:[`${DIR}/media-pdp0-root-selected-source-integration-r9-r08.source-owner-decision.r2.json`],recordDigestBinding:'EXACT_EXTERNAL_ROOT_DECISION_JSON_SHA256_AND_SOURCE_OWNER_PREDECESSOR_SHA256'},
    {sequence:3,recordKind:'OPERATION_PROFILE_REGISTRATION',recordRef:`${DIR}/media-pdp0-root-selected-source-integration-r9-r08.operation-profile-registration.r2.json`,decisionSelector:{status:'NOT_ALLOCATED_BY_DECISION_LOG_OWNER',ref:null,sha256:null},predecessorRecordRefs:[`${DIR}/media-pdp0-root-selected-source-integration-r9-r08.source-owner-decision.r2.json`,`${DIR}/media-pdp0-root-selected-source-integration-r9-r08.root-adoption-decision.r2.json`],recordDigestBinding:'EXACT_EXTERNAL_REGISTRATION_JSON_SHA256_AND_OWNER_ROOT_PREDECESSOR_SHA256'},
    {sequence:4,recordKind:'DISTINCT_APPLY_AUTHORIZATION',recordRef:`${DIR}/media-pdp0-root-selected-source-integration-r9-r08.apply-authorization.r2.json`,decisionSelector:{status:'NOT_ALLOCATED_BY_DECISION_LOG_OWNER',ref:null,sha256:null},predecessorRecordRefs:[`${DIR}/media-pdp0-root-selected-source-integration-r9-r08.source-owner-decision.r2.json`,`${DIR}/media-pdp0-root-selected-source-integration-r9-r08.root-adoption-decision.r2.json`,`${DIR}/media-pdp0-root-selected-source-integration-r9-r08.operation-profile-registration.r2.json`],recordDigestBinding:'EXACT_EXTERNAL_APPLY_AUTHORIZATION_JSON_SHA256_AND_ALL_PREDECESSOR_RECORD_SHA256'},
  ];
  return {
    schemaVersion:'media.pdp0.root-selected-source-integration.r9-r08.material-binding.v2',
    materialKind:'DECISION_SECTION',
    decisionId:'PXD-225',
    documentRef:LOG,
    decisionSectionRef:`${LOG}#PXD-225-section`,
    decisionSectionSha256:pxd.sha256,
    sectionSelector:'ANCHORED_PXD_HEADING_UNTIL_NEXT_PXD_HEADING',
    // Keep the legacy approval fields as a raw exact-section SHA. The prior status pin remains separately recorded as history.
    decisionSectionRawPin:{decisionRef:`${LOG}#PXD-225`,decisionSectionSha256:pxd.sha256,semantics:'RAW_SHA256_OF_EXACT_ANCHORED_PXD_SECTION'},
    historicalSourceStatusPin:{statusRecordRef:PDP0_STATUS,statusRecordWholeFileSha256:historicalPdp0StatusSha256,selector:`${LOG}#PXD-225-section`,historicalSha256:historicalPdp0StatusPin,semantics:'HISTORICAL_RAW_EXACT_SECTION_SHA; NOT_CURRENT_AUTHORITY',matchesCurrentRawSection:historicalPdp0StatusPin===pxd.sha256},
    decisionLogCaptureProvenance:{targetRef:LOG,wholeFileSha256AtR9R08V1Capture:decisionLogWholeSha256,wholeFileSha256AtMaterialPreparation:sha(Buffer.from(decisionLogText)),captureShaMatches:decisionLogWholeSha256===sha(Buffer.from(decisionLogText)),disposition:'HISTORICAL_CAPTURE_PROVENANCE_ONLY; NOT_THE_POST_AUTHORITY_APPLY_READ_PREIMAGE'},
    sections:sectionRefs,
    pdpAuthoritySectionRefs:pdpAuthorities,
    authoritySectionBindings,
    authorityMapSourcePin:{targetRef:AUTH,wholeFileSha256:authorityMapWholeSha256,comparison:'EXACT_WHOLE_FILE_SHA256'},
    applyReadSetV2:{version:'media.pdp0.root-selected-source-integration.r9-r08.apply-read-set.v2',members:['.product-experience/pdp-0-product-truth/capabilities.yaml','.product-experience/pdp-0-product-truth/requirements.yaml','docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json','.product-experience/pdp-0-product-truth/capability-leaf-review.yaml','.product-experience/pdp-0-product-truth/campaign-extensions.yaml',LOG,'.product-experience/pdp-0-product-truth/quality-policy.yaml'],capturePoint:'AFTER_FOUR_UNIQUE_AUTHORITY_SECTIONS_AND_EXTERNAL_RECORDS_ARE_FINALIZED',wholeDecisionLogSha256:null,status:'NOT_CAPTURED_PENDING_AUTHORITY_SECTION_ALLOCATION_AND_RECORD_CHAIN',bindingLocation:'EXTERNAL_APPLY_AUTHORIZATION_JSON_NOT_A_PXD_SECTION'},
    authorityBoundary:{ownerAuthorityDecision:'NOT_RECORDED',rootAuthorityDecision:'NOT_RECORDED',operationProfileRegistration:'NOT_RECORDED',distinctApplyAuthorization:'NOT_RECORDED',canonicalApply:'NOT_AUTHORIZED',phaseStatusEffect:'NONE',independentAcceptance:'NOT_CLAIMED',nativeClosure:'NOT_CLAIMED'},
  };
}

function exactObjectSchema(value){return {type:'object',additionalProperties:false,required:Object.keys(value),properties:Object.fromEntries(Object.entries(value).map(([key,entry])=>[key,{const:entry}]))};}
const digest={type:'string',pattern:'^[a-f0-9]{64}$'};
const actor=(role)=>({type:'object',additionalProperties:false,required:['identity','role'],properties:{identity:{type:'string',minLength:1},role:{const:role}}});

function verifySemanticReview(review,{bundleRef,bundleSha,freezeRef,freezeSha,decisionLogSha}){
  const baseline=new Map((review.sourceBaseline??[]).map(row=>[row.ref,row.sha256]));
  const logRow=review.sourceBaseline?.find(row=>row.ref===LOG);
  const required=[
    [bundleRef,bundleSha],
    [freezeRef,freezeSha],
  ];
  if(review.reviewKind!=='INDEPENDENT_READ_ONLY_FULL_R9_R08_SELECTED_CUT_PDP0_SEMANTIC_REVIEW'
    ||review.semanticDisposition?.status!=='PASS_FOR_FROZEN_R9_R08_SELECTED_CUT_ONLY'
    ||!Array.isArray(review.semanticDisposition.semanticFindings)||review.semanticDisposition.semanticFindings.length!==0
    ||review.reviewer?.humanOwnerAuthority!==false
    ||review.authorityBoundary?.sourceOwnerDecision!=='NOT_CREATED_OR_CLAIMED'
    ||review.authorityBoundary?.rootAdoptionDecision!=='NOT_CREATED_OR_CLAIMED'
    ||review.authorityBoundary?.canonicalApply!=='NONE'
    ||required.some(([ref,digest])=>baseline.get(ref)!==digest)
    ||logRow?.wholeFileSha256AtReview!==decisionLogSha){
    throw new Error('R9-R08 semantic peer record is missing, stale, not a full selected-cut PASS, or crosses an authority boundary');
  }
  const decisions=logRow.wholeFileSha256AtReview;
  const pxd225=logRow.decisionSections?.[`${LOG}#PXD-225-section`];
  const livePxd225=fingerprintPxdDecisionSection(read(LOG).toString('utf8'),'PXD-225').sha256;
  if(decisions!==decisionLogSha||pxd225!==livePxd225)throw new Error('R9-R08 semantic review decision-section evidence is stale');
  return sha(read(`${DIR}/media-pdp0-root-selected-source-integration-r9-r08.independent-peer.r08-semantic-review.v1.json`));
}

export function prepareR9R08ApprovalInput({check=false}={}){
  const bundleRef=`${BASE}.successor-bundle.candidate.v1.json`;
  const freezeRef=`${BASE}.freeze.v1.json`;
  const bundle=readJson(bundleRef),freeze=readJson(freezeRef);
  if(bundle.candidateRevision!=='R9-R08'||freeze.candidateBundle?.ref!==bundleRef)throw new Error('R9-R08 bundle/freeze binding is invalid');
  const logBytes=read(LOG),authBytes=read(AUTH),statusBytes=read(PDP0_STATUS);
  const logSha=sha(logBytes),authSha=sha(authBytes);
  const status=JSON.parse(statusBytes.toString('utf8'));
  const statusPin=status.sourceShaSet?.[`${LOG}#PXD-225-section`];
  if(!/^[a-f0-9]{64}$/.test(statusPin??''))throw new Error('PDP-0 status has no exact historical PXD-225 section pin');
  const pinnedLog=bundle.sourceBaseline.targets.find(row=>row.targetRef===LOG)?.preimageSha256;
  if(!pinnedLog||pinnedLog!==logSha)throw new Error('R9-R08 candidate whole decision-log preimage is stale; prepare a new candidate revision');
  const material=buildR9R08DecisionSectionMaterial({decisionLogText:logBytes.toString('utf8'),authorityMapText:authBytes.toString('utf8'),historicalPdp0StatusSha256:sha(statusBytes),historicalPdp0StatusPin:statusPin,decisionLogWholeSha256:pinnedLog,authorityMapWholeSha256:authSha});
  const materialRef=`${BASE}.decision-section-material.r5.candidate.v1.json`;
  const ownerSchemaRef=`${BASE}.source-owner-decision.schema.r11.candidate.v1.json`;
  const rootSchemaRef=`${BASE}.root-adoption-decision.schema.r9.candidate.v1.json`;
  const applySchemaRef=`${BASE}.apply-authorization.schema.v2.r3.candidate.v1.json`;
  const rootInputRef=`${BASE}.root-adoption-decision.input.r10.candidate.v1.json`;
  const freezeRefOut=`${BASE}.approval-input-freeze.r10.candidate.v1.json`;
  const ownerDecisionRef=`${BASE}.source-owner-decision.r2.json`;
  const fullSemanticReviewRef=`${BASE}.independent-peer.r08-semantic-review.v1.json`;
  const materialBindingReview=readJson(MATERIAL_BINDING_REVIEW);
  const applicationPlan=prepareR9R08ApplicationPlan({check});
  if(sha(read(MATERIAL_BINDING_REVIEW))!==MATERIAL_BINDING_REVIEW_SHA256
    ||materialBindingReview.recordKind!=='READ_ONLY_TECHNICAL_RECOMMENDATION'
    ||materialBindingReview.recommendedVersionedMaterialBinding?.schemaVersion!=='media.pdp0.root-selected-source-integration.r9-r08.material-binding.v2'){
    throw new Error('R9-R08 v2 binding recommendation is missing, stale, or has an unexpected authority status');
  }
  const materialBytes=bytes(material),materialSha=sha(materialBytes),bundleSha=sha(read(bundleRef)),freezeSha=sha(read(freezeRef));
  const review=readJson(fullSemanticReviewRef);
  const reviewSha=verifySemanticReview(review,{bundleRef,bundleSha,freezeRef,freezeSha,decisionLogSha:logSha});
  const ownerSchema={
    $schema:'https://json-schema.org/draft/2020-12/schema',
    $id:'media.pdp0.root-selected-source-integration-r9-r08.source-owner-decision.r11.candidate.v1',
    title:'R9-R08 source-owner approval schema with typed PXD-225 evidence',
    description:'Candidate-only schema. Requires the exact frozen R9-R08 input, a typed PXD-225 DECISION_SECTION binding, separate exact authority-section references, and a deferred post-authority apply read-set. It does not register authority or authorize apply.',
    type:'object',additionalProperties:false,
    required:['schemaVersion','decisionKind','candidateRef','candidateSha256','freezeManifestRef','freezeManifestSha256','fullSemanticReview','decisionRef','decisionSectionSha256','decisionSectionMaterialRef','decisionSectionMaterialSha256','decisionEvidence','sourceOwner','disposition','authorityBoundary'],
    properties:{
      schemaVersion:{const:'media.pdp0.root-selected-source-integration-r9-r08.source-owner-decision.r11.v1'},decisionKind:{const:'SOURCE_OWNER_ADOPT_EXACT_R9_R08_PDP0_SOURCE_SUCCESSOR'},
      candidateRef:{const:bundleRef},candidateSha256:{const:bundleSha},freezeManifestRef:{const:freezeRef},freezeManifestSha256:{const:freezeSha},
      fullSemanticReview:{type:'object',additionalProperties:false,required:['ref','sha256','reviewStatus','reviewScope','semanticDisposition','reviewedCandidateSha256','reviewedFreezeSha256','reviewerIdentity','semanticFindingIds'],properties:{ref:{const:fullSemanticReviewRef},sha256:{const:reviewSha},reviewStatus:{const:review.reviewStatus},reviewScope:{const:review.reviewKind},semanticDisposition:{const:review.semanticDisposition.status},reviewedCandidateSha256:{const:bundleSha},reviewedFreezeSha256:{const:freezeSha},reviewerIdentity:{const:review.reviewer.identity},semanticFindingIds:{const:review.semanticDisposition.semanticFindings.map(row=>row.findingId??row.id)}}},
      // These raw fields preserve existing R8/R07 semantics and history exactly.
      decisionRef:{const:material.decisionSectionRawPin.decisionRef},decisionSectionSha256:{const:material.decisionSectionRawPin.decisionSectionSha256},
      decisionSectionMaterialRef:{const:materialRef},decisionSectionMaterialSha256:{const:materialSha},decisionEvidence:exactObjectSchema(material),
      sourceOwner:actor('PDP0_SOURCE_OWNER'),disposition:{enum:['APPROVE_EXACT_CANDIDATE_FOR_SOURCE_ADOPTION','DECLINE_EXACT_CANDIDATE','REQUEST_CANDIDATE_REVISION']},
      authorityBoundary:{type:'object',additionalProperties:false,required:['sourceOwnerAdoption','canonicalApply','phaseStatusEffect','independentAcceptance','nativeClosure'],properties:{sourceOwnerAdoption:{enum:['ADOPTED_EXACT_CANDIDATE','NOT_ADOPTED']},canonicalApply:{const:'NOT_AUTHORIZED_BY_SOURCE_OWNER_DECISION'},phaseStatusEffect:{const:'NONE'},independentAcceptance:{const:'NOT_CLAIMED'},nativeClosure:{const:'NOT_CLAIMED'}}},
    },
  };
  const rootSchema={
    $schema:'https://json-schema.org/draft/2020-12/schema',
    $id:'media.pdp0.root-selected-source-integration-r9-r08.root-adoption-decision.r9.candidate.v1',
    title:'R9-R08 root adoption decision schema with typed PXD-225 evidence',
    description:'Candidate-only schema for a distinct root authority decision after exact source-owner adoption and a full R9-R08 semantic peer review. This decision cannot authorize canonical apply.',
    type:'object',additionalProperties:false,
    required:['schemaVersion','decisionStatus','candidateRef','candidateSha256','freezeManifestRef','freezeManifestSha256','sourceOwnerDecisionRef','sourceOwnerDecisionSha256','fullSemanticReview','decisionRef','decisionSectionSha256','decisionSectionMaterialRef','decisionSectionMaterialSha256','decisionEvidence','rootAuthority','authorityBoundary'],
    properties:{
      schemaVersion:{const:'media.pdp0.root-selected-source-integration-r9-r08.root-adoption-decision.r9.v1'},decisionStatus:{enum:['ADOPT_EXACT_R9_R08_SPLIT_SOURCE_SUCCESSOR','DECLINE_EXACT_R9_R08_SPLIT_SOURCE_SUCCESSOR','REQUEST_R9_R08_CANDIDATE_REVISION']},
      candidateRef:{const:bundleRef},candidateSha256:{const:bundleSha},freezeManifestRef:{const:freezeRef},freezeManifestSha256:{const:freezeSha},
      sourceOwnerDecisionRef:{const:ownerDecisionRef},sourceOwnerDecisionSha256:digest,fullSemanticReview:{type:'object',additionalProperties:false,required:['ref','sha256','reviewStatus','reviewScope','semanticDisposition','reviewedCandidateSha256','reviewedFreezeSha256','reviewerIdentity','semanticFindingIds'],properties:{ref:{const:fullSemanticReviewRef},sha256:{const:reviewSha},reviewStatus:{const:review.reviewStatus},reviewScope:{const:review.reviewKind},semanticDisposition:{const:review.semanticDisposition.status},reviewedCandidateSha256:{const:bundleSha},reviewedFreezeSha256:{const:freezeSha},reviewerIdentity:{const:review.reviewer.identity},semanticFindingIds:{const:review.semanticDisposition.semanticFindings.map(row=>row.findingId??row.id)}}},
      decisionRef:{const:material.decisionSectionRawPin.decisionRef},decisionSectionSha256:{const:material.decisionSectionRawPin.decisionSectionSha256},decisionSectionMaterialRef:{const:materialRef},decisionSectionMaterialSha256:{const:materialSha},decisionEvidence:exactObjectSchema(material),
      rootAuthority:actor('ROOT_AUTHORITY'),authorityBoundary:{type:'object',additionalProperties:false,required:['rootAdoption','canonicalApply','phaseStatusEffect','independentAcceptance','nativeClosure'],properties:{rootAdoption:{enum:['ADOPTED_EXACT_CANDIDATE','NOT_ADOPTED']},canonicalApply:{const:'NOT_AUTHORIZED_BY_ROOT_ADOPTION_DECISION'},phaseStatusEffect:{const:'NONE'},independentAcceptance:{const:'NOT_CLAIMED'},nativeClosure:{const:'NOT_CLAIMED'}}},
    },
  };
  const applyAuthorizationSchema={
    $schema:'https://json-schema.org/draft/2020-12/schema',
    $id:'media.pdp0.root-selected-source-integration-r9-r08.apply-authorization.v2.r3.candidate.v1',
    title:'Candidate R9-R08 external apply authorization schema v2',
    description:'Candidate-only exact-input apply schema. The full decision-log digest is an external read-set CAS pin captured after the four profile-fixed authority sections; the log remains a read-only guard. Schema validity does not establish actor identity or authorization.',
    type:'object',additionalProperties:false,
    required:['schemaVersion','effect','profileId','candidateRef','candidateSha256','freezeRef','freezeSha256','profileRegistrationRef','profileRegistrationSha256','sourceOwnerDecisionRef','sourceOwnerDecisionSha256','rootAdoptionDecisionRef','rootAdoptionDecisionSha256','semanticReviewRef','semanticReviewSha256','readSetVersion','sourceBaseline','wholeDecisionLogSha256','targetRows','decisionRef','decisionSectionSha256','applyAuthority','authorityBoundary','recordKind','recordRef','actorIdentity','actorRole','predecessorRecordSha256'],
    properties:{schemaVersion:{const:'media.pdp0.root-selected-source-integration-r9-r08.apply-authorization.v2'},effect:{const:'APPLY_EXACT_R9_R08_SPLIT_SOURCE_SUCCESSOR'},profileId:{const:'media.pdp0.root-selected-source-integration.r9-r08.operation-profile.v2'},candidateRef:{const:bundleRef},candidateSha256:{const:bundleSha},freezeRef:{const:freezeRef},freezeSha256:{const:freezeSha},profileRegistrationRef:{const:`${BASE}.operation-profile-registration.r2.json`},profileRegistrationSha256:digest,sourceOwnerDecisionRef:{const:ownerDecisionRef},sourceOwnerDecisionSha256:digest,rootAdoptionDecisionRef:{const:`${BASE}.root-adoption-decision.r2.json`},rootAdoptionDecisionSha256:digest,semanticReviewRef:{const:fullSemanticReviewRef},semanticReviewSha256:{const:reviewSha},readSetVersion:{const:material.applyReadSetV2.version},sourceBaseline:{type:'array',minItems:7,maxItems:7,prefixItems:material.applyReadSetV2.members.map(targetRef=>({type:'object',additionalProperties:false,required:['targetRef','sha256'],properties:{targetRef:{const:targetRef},sha256:digest}})),items:false},wholeDecisionLogSha256:digest,targetRows:{type:'array',minItems:4,maxItems:4,prefixItems:['.product-experience/pdp-0-product-truth/capabilities.yaml','.product-experience/pdp-0-product-truth/requirements.yaml','.product-experience/pdp-0-product-truth/capability-leaf-review.yaml','docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json'].map(targetRef=>{const post=freeze.selectedPostimages.find(row=>row.targetRef===targetRef);const pre=freeze.current7Preimages.find(row=>row.targetRef===targetRef);return {type:'object',additionalProperties:false,required:['targetRef','preimageSha256','postimageSha256'],properties:{targetRef:{const:targetRef},preimageSha256:{const:pre.sha256},postimageSha256:{const:post.postimageSha256}}};}),items:false},decisionRef:{type:'string',minLength:1},decisionSectionSha256:digest,applyAuthority:{type:'object',additionalProperties:false,required:['identity','role','credentialRef','credentialSha256','roleGrantRef','roleGrantSha256'],properties:{identity:{type:'string',minLength:1},role:{const:'CANONICAL_APPLY_AUTHORITY'},credentialRef:{type:'string',minLength:1},credentialSha256:digest,roleGrantRef:{type:'string',minLength:1},roleGrantSha256:digest}},authorityBoundary:{type:'object',additionalProperties:false,required:['canonicalApply','phaseStatusEffect'],properties:{canonicalApply:{const:'EXACT_R9_R08_CANONICAL_SOURCE_APPLY_AUTHORIZED'},phaseStatusEffect:{const:'NONE'}}},recordKind:{const:'DISTINCT_APPLY_AUTHORIZATION'},recordRef:{const:`${BASE}.apply-authorization.r2.json`},actorIdentity:{type:'string',minLength:1},actorRole:{const:'CANONICAL_APPLY_AUTHORITY'},predecessorRecordSha256:digest},
  };
  const ownerSchemaBytes=bytes(ownerSchema),rootSchemaBytes=bytes(rootSchema),applySchemaBytes=bytes(applyAuthorizationSchema),materialBindingReviewSha=sha(read(MATERIAL_BINDING_REVIEW));
  const input={schemaVersion:'media.pdp0.root-selected-source-integration-r9-r08.root-adoption-decision-input.r10.v1',inputKind:'ROOT_APPROVAL_INPUT_TEMPLATE_NOT_A_DECISION',approvalReadiness:'BLOCKED_PENDING_AUTHORITY_SECTION_ALLOCATION_SOURCE_OWNER_DECISION_ROOT_ADOPTION_PROFILE_REGISTRATION_AND_FINAL_APPLY_READSET',candidate:{ref:bundleRef,sha256:bundleSha},freezeManifest:{ref:freezeRef,sha256:freezeSha},sourceOwnerDecision:{ref:ownerDecisionRef,sha256:null,status:'NOT_RECORDED'},fullSemanticReview:{ref:fullSemanticReviewRef,sha256:reviewSha,reviewStatus:review.reviewStatus,reviewScope:review.reviewKind,semanticDisposition:review.semanticDisposition.status,reviewedCandidateSha256:bundleSha,reviewedFreezeSha256:freezeSha,reviewerIdentity:review.reviewer.identity,semanticFindingIds:review.semanticDisposition.semanticFindings.map(row=>row.findingId??row.id)},materialBindingReview:{ref:MATERIAL_BINDING_REVIEW,sha256:materialBindingReviewSha,recordKind:materialBindingReview.recordKind,reviewStatus:materialBindingReview.reviewStatus,findingIds:materialBindingReview.findings.map(row=>row.findingId)},applicationPlan:{ref:applicationPlan.ref,sha256:applicationPlan.sha256,disposition:applicationPlan.plan.planDisposition,blockers:applicationPlan.plan.blockers},decisionEvidence:{ref:materialRef,sha256:materialSha,schemaVersion:material.schemaVersion,decisionLogCaptureProvenance:material.decisionLogCaptureProvenance,applyReadSetV2:material.applyReadSetV2,decisionSectionRawPin:material.decisionSectionRawPin,historicalSourceStatusPin:material.historicalSourceStatusPin,authoritySectionBindings:material.authoritySectionBindings},validatorRoute:{moduleRef:'scripts/lib/media-pdp0-root-selected-source-integration-r9-r08-v2-guard.mjs',lockedReadSetEntrypoint:'validateMediaPdp0RootSelectedSourceIntegrationR9R08V2ReadSetUnderLease',routeStatus:'CANDIDATE_VALIDATOR_IMPLEMENTED_AUTHORITY_CHAIN_BLOCKED',applyAuthorizationSchemaRef:applySchemaRef,applyAuthorizationSchemaSha256:sha(applySchemaBytes),canonicalApply:'NONE'},rootDecision:{status:'NOT_SET',rootAuthority:{identity:null,role:'ROOT_AUTHORITY'}},readinessBlockers:review.readinessFindings.map(row=>({findingId:row.findingId,status:row.status,owner:row.owner})),requiredBeforeDecision:['ACTUAL_PDP0_SOURCE_OWNER_DECISION_RECORDED_AND_VALIDATED','FOUR_UNIQUE_DECISION_SELECTORS_ALLOCATED_BY_DECISION_LOG_OWNER','AUTHENTIC_ORDERED_OWNER_ROOT_PROFILE_AND_APPLY_RECORD_CHAIN','FINAL_APPLY_READSET_CAPTURED_AFTER_AUTHORITY_SECTIONS_AND_EXTERNAL_RECORDS','ROOT_AUTHORITY_IDENTITY_RESOLVED_BY_AUTHORITY','CURRENT_PDP0_STATUS_AND_PHASE_LOCAL_TASK_INVENTORY_VALIDATED'],authorityBoundary:{canonicalApply:'NOT_AUTHORIZED_BY_ROOT_ADOPTION_DECISION',phaseStatusEffect:'NONE',independentAcceptance:'NOT_CLAIMED',nativeClosure:'NOT_CLAIMED'},canonicalApply:'NONE'};
  const inputBytes=bytes(input);
  const freezeOut={schemaVersion:'media.pdp0.root-selected-source-integration-r9-r08.approval-input-freeze.r10.v1',supersedes:`${BASE}.approval-input-freeze.r9.candidate.v1.json`,artifactStatus:'CANDIDATE_ONLY_NOT_AUTHORITY_REGISTRATION',candidate:{ref:bundleRef,sha256:bundleSha},candidateFreeze:{ref:freezeRef,sha256:freezeSha},decisionLogCaptureProvenance:material.decisionLogCaptureProvenance,applyReadSetV2:material.applyReadSetV2,authorityMapWholeFilePin:{targetRef:AUTH,sha256:authSha},historicalPdp0StatusPin:{targetRef:PDP0_STATUS,sha256:sha(statusBytes),pinnedPxd225SectionSha256:statusPin,currentSectionMatches:statusPin===material.decisionSectionRawPin.decisionSectionSha256},decisionEvidenceMaterial:{ref:materialRef,sha256:materialSha},sourceOwnerDecisionSchema:{ref:ownerSchemaRef,sha256:sha(ownerSchemaBytes)},rootAdoptionDecisionSchema:{ref:rootSchemaRef,sha256:sha(rootSchemaBytes)},applyAuthorizationSchema:{ref:applySchemaRef,sha256:sha(applySchemaBytes)},rootApprovalInput:{ref:rootInputRef,sha256:sha(inputBytes)},applicationPlan:{ref:applicationPlan.ref,sha256:applicationPlan.sha256},fullSemanticReview:{ref:fullSemanticReviewRef,sha256:reviewSha,reviewStatus:review.reviewStatus,semanticStatus:review.semanticDisposition.status,findings:review.semanticDisposition.semanticFindings.map(row=>row.findingId??row.id)},materialBindingReview:{ref:MATERIAL_BINDING_REVIEW,sha256:materialBindingReviewSha,reviewStatus:materialBindingReview.reviewStatus,findings:materialBindingReview.findings.map(row=>row.findingId)},decisionSectionMaterialSha256:materialSha,rawPxd225SectionSha256:material.decisionSectionRawPin.decisionSectionSha256,semanticSectionCount:material.sections.length,authoritySectionRefCount:material.pdpAuthoritySectionRefs.length,authorityBoundary:{canonicalSourceWrites:'NONE',phaseStatusEffect:'NONE',ownerAdoption:'NOT_RECORDED',rootAdoption:'NOT_RECORDED',independentAcceptance:'NOT_CLAIMED',nativeClosure:'NOT_CLAIMED',delivery:'NOT_CLAIMED'}};
  for(const [ref,value] of [[materialRef,material],[ownerSchemaRef,ownerSchema],[rootSchemaRef,rootSchema],[applySchemaRef,applyAuthorizationSchema],[rootInputRef,input],[freezeRefOut,freezeOut]])createOnly(ref,bytes(value),check);
  return {material,ownerSchema,rootSchema,applyAuthorizationSchema,input,freeze:freezeOut,refs:{material:materialRef,ownerSchema:ownerSchemaRef,rootSchema:rootSchemaRef,applyAuthorizationSchema:applySchemaRef,rootInput:rootInputRef,freeze:freezeRefOut}};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const check=process.argv.includes('--check');
  const result=prepareR9R08ApprovalInput({check});
  console.log(JSON.stringify({status:check?'R9_R08_APPROVAL_INPUT_REPLAY_PASS':'R9_R08_APPROVAL_INPUT_CANDIDATES_PREPARED',refs:result.refs,materialSha256:sha(bytes(result.material)),decisionSectionSha256:result.material.decisionSectionSha256,historicalDecisionSectionPin:result.material.historicalSourceStatusPin.historicalSha256,wholeDecisionLogSha256:result.material.decisionLogCaptureProvenance.wholeFileSha256AtMaterialPreparation,finalApplyReadSetSha256:result.material.applyReadSetV2.wholeDecisionLogSha256,semanticSectionCount:result.material.sections.length,authoritySectionRefCount:result.material.pdpAuthoritySectionRefs.length,canonicalApply:'NONE',phaseStatusEffect:'NONE'},null,2));
}
