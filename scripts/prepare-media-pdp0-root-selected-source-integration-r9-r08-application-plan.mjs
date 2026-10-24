#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {fingerprintPxdDecisionSection} from './lib/pdp0-phase-scoped-source-fingerprints.mjs';
import {R9R08_V2_PROFILE_ID,R9R08_V2_READ_SET,R9R08_V2_WRITE_TARGETS} from './lib/media-pdp0-root-selected-source-integration-r9-r08-v2-guard.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const DIR='docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const BASE=`${DIR}/media-pdp0-root-selected-source-integration-r9-r08`;
const LOG='.product-experience/decision-log.md';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const read=ref=>fs.readFileSync(path.join(ROOT,ref));
const readJson=ref=>JSON.parse(read(ref));
const encode=value=>Buffer.from(`${JSON.stringify(value,null,2)}\n`);
const outputRef=`${BASE}.application-plan.v2.r2.candidate.v1.json`;

export function prepareR9R08ApplicationPlan({check=false}={}){
  const bundleRef=`${BASE}.successor-bundle.candidate.v1.json`;
  const freezeRef=`${BASE}.freeze.v1.json`;
  const materialRef=`${BASE}.decision-section-material.r5.candidate.v1.json`;
  const materialBindingReviewRef=`${BASE}-material-binding-review-r01.json`;
  const semanticReviewRef=`${BASE}.independent-peer.r08-semantic-review.v1.json`;
  const registrationRef=`${BASE}.operation-profile-registration.r2.json`;
  const authorityRefs=[
    [`${BASE}.source-owner-decision.r2.json`,'PDP0_SOURCE_OWNER_DECISION'],
    [`${BASE}.root-adoption-decision.r2.json`,'ROOT_ADOPTION_DECISION'],
    [registrationRef,'OPERATION_PROFILE_REGISTRATION'],
    [`${BASE}.apply-authorization.r2.json`,'DISTINCT_APPLY_AUTHORIZATION'],
  ];
  const bundleBytes=read(bundleRef),freezeBytes=read(freezeRef),materialBytes=read(materialRef);
  const bundle=JSON.parse(bundleBytes),freeze=JSON.parse(freezeBytes),material=JSON.parse(materialBytes);
  const semanticReviewBytes=read(semanticReviewRef),semanticReview=JSON.parse(semanticReviewBytes);
  const bindingReviewBytes=read(materialBindingReviewRef),bindingReview=JSON.parse(bindingReviewBytes);
  const logBytes=read(LOG),logText=logBytes.toString('utf8');
  const liveReadSet=R9R08_V2_READ_SET.map(targetRef=>({targetRef,sha256:sha(read(targetRef))}));
  const historicalReadSet=freeze.current7Preimages;
  const status=readJson('docs/implementation/pdp-0-phase-dev-status.json');
  const statusPxdPin=status.sourceShaSet?.[`${LOG}#PXD-225-section`]??null;
  const currentPxdPin=fingerprintPxdDecisionSection(logText,'PXD-225').sha256;
  const authorityInputs=authorityRefs.map(([ref,recordKind],index)=>({sequence:index+1,recordKind,ref,
    status:fs.existsSync(path.join(ROOT,ref))?'PRESENT_REQUIRES_VALIDATION':'NOT_RECORDED'}));
  const blockers=[];
  if(bundle.candidateRevision!=='R9-R08'||freeze.candidateBundle?.sha256!==sha(bundleBytes))blockers.push('FROZEN_R9_R08_CANDIDATE_BINDING_INVALID');
  if(material.schemaVersion!=='media.pdp0.root-selected-source-integration.r9-r08.material-binding.v2'
    ||material.decisionSectionRawPin?.decisionSectionSha256!==currentPxdPin)blockers.push('PXD225_SEMANTIC_SECTION_PIN_STALE');
  if(semanticReview.reviewStatus!=='PASS_FOR_SELECTED_CANDIDATE_SEMANTICS_ONLY_BLOCKED_FOR_CURRENTNESS_AND_AUTHORITY_CHAIN'
    ||semanticReview.semanticDisposition?.status!=='PASS_FOR_FROZEN_R9_R08_SELECTED_CUT_ONLY')blockers.push('FULL_R08_SEMANTIC_PEER_NOT_CURRENT_PASS');
  if(liveReadSet.some((row,index)=>row.sha256!==historicalReadSet[index]?.sha256))blockers.push('R9_R08_SEVEN_FILE_SOURCE_READSET_CHANGED');
  if(status.status!=='DEV_COMPLETE'||statusPxdPin!==currentPxdPin)blockers.push('PDP0_STATUS_PIN_OR_CURRENTNESS_NOT_COMPLETE');
  if(material.authoritySectionBindings?.length!==4||material.authoritySectionBindings.some(row=>row.decisionSelector?.status!=='ALLOCATED_BY_DECISION_LOG_OWNER'||!row.decisionSelector.ref||!row.decisionSelector.sha256))blockers.push('FOUR_OWNER_ALLOCATED_AUTHORITY_SELECTORS_NOT_AVAILABLE');
  if(authorityInputs.some(row=>row.status==='NOT_RECORDED'))blockers.push('FOUR_AUTHORITY_RECORD_CHAIN_NOT_COMPLETE');
  const registrationExists=fs.existsSync(path.join(ROOT,registrationRef));
  if(!registrationExists)blockers.push('V2_OPERATION_PROFILE_NOT_REGISTERED');
  blockers.push('FINAL_EXTERNAL_APPLY_READSET_NOT_CAPTURED_AFTER_AUTHORITY_RECORDS');
  if(bindingReview.recordKind!=='READ_ONLY_TECHNICAL_RECOMMENDATION'||sha(bindingReviewBytes)!=='5c0c90c4ae7a31a1b7bd3b971c8b071daa1289675fa5327dece745f37239026d')blockers.push('MATERIAL_BINDING_RECOMMENDATION_PIN_INVALID');
  const targetRows=freeze.selectedPostimages.map(row=>({targetRef:row.targetRef,
    preimageSha256:freeze.current7Preimages.find(pin=>pin.targetRef===row.targetRef)?.sha256??null,
    postimageRef:row.postimageRef,postimageSha256:row.postimageSha256}));
  if(JSON.stringify(targetRows.map(row=>row.targetRef))!==JSON.stringify(R9R08_V2_WRITE_TARGETS))blockers.push('FIXED_FOUR_TARGET_ALLOWLIST_MISMATCH');
  const plan={schemaVersion:'media.pdp0.root-selected-source-integration.r9-r08.application-plan.v2',
    planDisposition:blockers.length?'BLOCKED_PENDING_AUTHORITY_AND_CURRENTNESS':'READY_FOR_DISTINCT_AUTHORITY_REVIEW',
    profileId:R9R08_V2_PROFILE_ID,candidate:{ref:bundleRef,sha256:sha(bundleBytes)},freeze:{ref:freezeRef,sha256:sha(freezeBytes)},
    materialBinding:{ref:materialRef,sha256:sha(materialBytes),semanticSelector:material.decisionSectionRef,semanticSha256:currentPxdPin,
      historicalWholeLogSha256:material.decisionLogCaptureProvenance.wholeFileSha256AtR9R08V1Capture},
    semanticReview:{ref:semanticReviewRef,sha256:sha(semanticReviewBytes),status:semanticReview.reviewStatus,
      disposition:semanticReview.semanticDisposition.status,semanticFindingCount:semanticReview.semanticDisposition.semanticFindings.length},
    materialBindingRecommendation:{ref:materialBindingReviewRef,sha256:sha(bindingReviewBytes),status:bindingReview.reviewStatus,
      recordKind:bindingReview.recordKind,disposition:'TECHNICAL_RECOMMENDATION_ONLY'},
    sourceReadSet:{version:material.applyReadSetV2.version,members:liveReadSet,allSevenMatchFrozen:!liveReadSet.some((row,index)=>row.sha256!==historicalReadSet[index]?.sha256),
      finalPostAuthorityWholeLogSha256:null,captureStatus:'DEFERRED_UNTIL_FOUR_AUTHORITY_SECTIONS_AND_RECORDS_FINAL'},
    writeTargets:{count:targetRows.length,rows:targetRows,exactAllowlist:R9R08_V2_WRITE_TARGETS,decisionLogIsReadOnly:true},
    authorityInputs,authoritySectionBindings:material.authoritySectionBindings,
    currentness:{pdp0Status:status.status,statusPin:statusPxdPin,currentPxd225SectionSha256:currentPxdPin,
      pxd225PinMatches:statusPxdPin===currentPxdPin,staleR08TargetPins:7,taskInventory:'UNKNOWN_FAIL_CLOSED'},
    blockers:[...new Set(blockers)],canonicalApply:'NONE',phaseStatusEffect:'NONE',sourceWrites:'NONE',
    authorityBoundary:{sourceOwnerDecision:'NOT_RECORDED',rootAdoptionDecision:'NOT_RECORDED',profileRegistration:'NOT_RECORDED',applyAuthorization:'NOT_RECORDED',independentAcceptance:'NOT_CLAIMED',nativeClosure:'NOT_CLAIMED'}};
  const bytes=encode(plan),target=path.join(ROOT,outputRef);
  if(fs.existsSync(target)){if(!fs.readFileSync(target).equals(bytes))throw new Error(`refusing to overwrite immutable R9-R08 v2 application plan: ${outputRef}`);}
  else if(check)throw new Error(`R9-R08 v2 application plan is not prepared: ${outputRef}`);
  else fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600});
  return {plan,ref:outputRef,sha256:sha(bytes)};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const result=prepareR9R08ApplicationPlan({check:process.argv.includes('--check')});
  console.log(JSON.stringify({status:result.plan.planDisposition,ref:result.ref,sha256:result.sha256,
    blockers:result.plan.blockers,canonicalApply:'NONE',phaseStatusEffect:'NONE'},null,2));
}
