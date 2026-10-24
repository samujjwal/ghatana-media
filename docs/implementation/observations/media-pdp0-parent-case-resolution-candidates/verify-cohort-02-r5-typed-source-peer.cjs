#!/usr/bin/env node
// Read-only peer verification of cohort 02 R5 against live owner-defined
// capability contracts. This writes only the peer artifact, not canonical data.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const YAML=require('yaml');
const dir='docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const abs=(p)=>path.join(process.cwd(),p);
const read=(p)=>fs.readFileSync(abs(p));
const json=(p)=>JSON.parse(read(p));
const sha=(b)=>crypto.createHash('sha256').update(b).digest('hex');
const dump=(x)=>Buffer.from(`${JSON.stringify(x,null,2)}\n`);
const proposalRef=`${dir}/cohort-02.r5.json`;
const candidateRef=`${dir}/cohort-02.source-amendment-candidate.r5.json`;
const postRef=`${dir}/cohort-02.source-amendment-postimages.r5.json`;
const capPostRef=`${dir}/cohort-02.source-amendment-capabilities.postimage.r5.yaml`;
const reqPostRef=`${dir}/cohort-02.source-amendment-requirements.postimage.r5.yaml`;
const r2Ref=`${dir}/cohort-02.r2.json`;
const r4PeerRef=`${dir}/cohort-02.r4.independent-peer.v1.json`;
const capRef='.product-experience/pdp-0-product-truth/capabilities.yaml';
const reqRef='.product-experience/pdp-0-product-truth/requirements.yaml';
const leafRef='.product-experience/pdp-0-product-truth/capability-leaf-review.yaml';
const prop=json(proposalRef),candidate=json(candidateRef),post=json(postRef),r2=json(r2Ref),r4Peer=json(r4PeerRef);
const capBytes=read(capRef),reqBytes=read(reqRef),leafBytes=read(leafRef);
const caps=YAML.parse(capBytes.toString('utf8')).capabilities;
const reqs=YAML.parse(reqBytes.toString('utf8')).requirements;
const authorityMap=YAML.parse(read('.product-experience/authority-map.yaml').toString('utf8'));
const capById=new Map(caps.map(x=>[x.id,x]));
const reqById=new Map(reqs.map(x=>[x.id,x]));
const findings=[];
const typedChecks=[];
const caseReviews=[];
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function fail(id,code,detail){findings.push({auditId:id,code,detail});}

const hashCandidate=sha(read(candidateRef));
const hashProposal=sha(read(proposalRef));
const hashPost=sha(read(postRef));
const hashCapPost=sha(read(capPostRef));
const hashReqPost=sha(read(reqPostRef));
const hashR4Peer=sha(read(r4PeerRef));
if(candidate.proposalSha256!==hashProposal)fail('BATCH','PROPOSAL_HASH_MISMATCH',{expected:candidate.proposalSha256,actual:hashProposal});
if(candidate.exactSemanticPostimageSha256!==hashPost||sha(read(candidate.exactSemanticPostimageRef))!==hashPost)fail('BATCH','SEMANTIC_POSTIMAGE_HASH_MISMATCH',{expected:candidate.exactSemanticPostimageSha256,actual:hashPost});
if(candidate.sourceBindings.r4PeerSha256!==hashR4Peer||post.predecessorFailedR4.peerSha256!==hashR4Peer)fail('BATCH','R4_HISTORY_PIN_MISMATCH',{expected:candidate.sourceBindings.r4PeerSha256,actual:hashR4Peer});
if(candidate.sourceBindings.capabilitiesPostimageSha256!==hashCapPost||candidate.sourceBindings.requirementsPostimageSha256!==hashReqPost)fail('BATCH','SOURCE_POSTIMAGE_HASH_MISMATCH',{});
if(sha(capBytes)!==candidate.sourceBindings.capabilitiesPreimageSha256||sha(reqBytes)!==candidate.sourceBindings.requirementsPreimageSha256)fail('BATCH','CANONICAL_PREIMAGE_MISMATCH',{});
if(sha(leafBytes)!==candidate.sourceBindings.capabilityLeafReviewSha256)fail('BATCH','LEAF_REVIEW_PIN_MISMATCH',{});
if(sha(read('.product-experience/authority-map.yaml'))!==candidate.sourceBindings.authorityMapSha256)fail('BATCH','AUTHORITY_MAP_PIN_MISMATCH',{});
if(sha(read('docs/implementation/pdp-0-phase-dev-status.json'))!==candidate.sourceBindings.phaseStatusSha256)fail('BATCH','PHASE_STATUS_PIN_MISMATCH',{});
if(prop.predecessorRef!==r4Peer.proposalRef&&prop.predecessorRef!==`${dir}/cohort-02.r4.json`)fail('BATCH','R4_PROPOSAL_REFERENCE_MISMATCH',{predecessor:prop.predecessorRef});
if(prop.r4PeerReviewSha256!==hashR4Peer||candidate.sourceBindings.r4PeerSha256!==hashR4Peer)fail('BATCH','R4_PEER_REFERENCE_MISMATCH',{});
if(post.canonicalApply!=='NOT_PERFORMED'||prop.canonicalSourceWrite!=='NOT_PERFORMED')fail('BATCH','CANONICAL_WRITE_CLAIM_PRESENT',{});

const capPost=YAML.parse(read(capPostRef).toString('utf8'));
const reqPost=YAML.parse(read(reqPostRef).toString('utf8'));
const capPostById=new Map(capPost.capabilities.map(x=>[x.id,x]));
const reqPostById=new Map(reqPost.requirements.map(x=>[x.id,x]));
const pTarget=prop.exactTargetPostimages.find(x=>x.targetRef===capRef);
const rTarget=prop.exactTargetPostimages.find(x=>x.targetRef===reqRef);
if(!pTarget||pTarget.postimageSha256!==hashCapPost||!rTarget||rTarget.postimageSha256!==hashReqPost)fail('BATCH','PROPOSAL_POSTIMAGE_MANIFEST_MISMATCH',{});
if(hashReqPost!==sha(reqBytes)||pTarget.preimageSha256!==sha(capBytes)||rTarget.preimageSha256!==sha(reqBytes))fail('BATCH','SOURCE_PREIMAGE_POSTIMAGE_BOUNDARY_MISMATCH',{});
if(candidate.counts.featureCasePairs!==60||candidate.counts.capabilityCaseRecordAdditions!==120)fail('BATCH','DECLARED_CASE_COUNTS_WRONG',{counts:candidate.counts});

const exactIds=prop.scope.exactOrderedAssignedAuditIds;
if(exactIds.length!==77||prop.rows.length!==77||!eq(prop.rows.map(x=>x.auditId),exactIds))fail('COHORT','ORDER_OR_DENOMINATOR_MISMATCH',{expected:77,actual:prop.rows.length});
if(!eq(r2.rows.map(x=>x.existingAuditId),exactIds))fail('COHORT','R2_MEMBERSHIP_NOT_PRESERVED',{});
if(r4Peer.decisionCounts?.SUPPORTED!==13||r4Peer.decisionCounts?.REQUEST_CHANGES!==64)fail('R4','FAILED_PREDECESSOR_DISPOSITION_NOT_PRESERVED',{decisionCounts:r4Peer.decisionCounts});
if(!post.predecessorFailedR4.retainedUnmodified||post.predecessorFailedR4.canonicalApply!=='NOT_PERFORMED')fail('R4','FAILED_R4_NOT_RETAINED_IMMUTABLY',{});

const postimages=prop.exactFeatureCasePostimages;
if(postimages.length!==60||postimages.reduce((n,x)=>n+x.cases.length,0)!==120)fail('CASES','CASE_PAIR_DENOMINATOR_MISMATCH',{pairs:postimages.length,records:postimages.reduce((n,x)=>n+x.cases.length,0)});
const allCaseIds=[];
for(const x of postimages){
  const live=capById.get(x.capabilityId);
  const postCap=capPostById.get(x.capabilityId);
  if(!live||!postCap){fail(x.auditId,'MAPPED_CAPABILITY_MISSING',{capabilityId:x.capabilityId});continue;}
  const owner=live.ownerDefinition||{};
  const exactSlots=eq(x.currentTypedInputSlots,owner.typedInputSlots);
  const exactOutputs=eq(x.currentSuccessOutputs,owner.successOutputs);
  const exactNonSuccess=eq(x.currentNonSuccessOutputs,owner.nonSuccessOutputs);
  const exactErrors=eq(x.currentErrors,owner.errors);
  const exactAuthority=eq(x.currentAuthority,owner.authority||live.requiredAuthority);
  const exactUnsupported=eq(x.currentExplicitUnsupportedCases,live.explicitUnsupportedCases||owner.explicitUnsupportedCases);
  const exactOperation=x.operation===live.operation;
  const pair=x.cases||[];
  const pos=pair[0]||{},neg=pair[1]||{};
  const slotsJson=JSON.stringify(owner.typedInputSlots);
  const outputsJson=JSON.stringify(owner.successOutputs);
  const nonSuccessJson=JSON.stringify(owner.nonSuccessOutputs);
  const errorsJson=JSON.stringify(owner.errors);
  const authorityJson=JSON.stringify(owner.authority||live.requiredAuthority);
  const unsupportedText=(live.explicitUnsupportedCases||[]).every(s=>neg.given?.includes(s));
  const postCases=(postCap.acceptanceCases||[]);
  const posRef=x.postimageCaseRefs?.[0],negRef=x.postimageCaseRefs?.[1];
  const posIdx=Number(posRef?.match(/acceptanceCases\/(\d+)$/)?.[1]);
  const negIdx=Number(negRef?.match(/acceptanceCases\/(\d+)$/)?.[1]);
  const actualPosIdx=postCases.findIndex(y=>eq(y,pos));
  const actualNegIdx=postCases.findIndex(y=>eq(y,neg));
  const postPos=actualPosIdx>=0;
  const postNeg=actualNegIdx>=0;
  const refIndexesMatch=posIdx===actualPosIdx&&negIdx===actualNegIdx;
  const posTyped=pos.given?.includes(slotsJson)&&pos.given?.includes(authorityJson);
  const posResult=pos.when?.includes(`${x.capabilityId}.${live.operation}`)&&pos.then?.includes(outputsJson)&&pos.then?.includes(owner.semanticOutcomeContract?.result||'');
  const negTyped=neg.given?.includes(slotsJson);
  const negBoundary=neg.then?.includes(nonSuccessJson)&&neg.then?.includes(errorsJson)&&neg.then?.includes(authorityJson)&&unsupportedText;
  const featureRef=x.sourceFeatureRef?.includes(`#originalAudit.inventory/@audit_id=${x.auditId}`);
  const parentRequirementIds=(x.parentRequirementRefs||[]).map(ref=>ref.match(/requirements\.yaml#requirements\/@id=([^/]+)/)?.[1]).filter(Boolean);
  const parentGood=parentRequirementIds.length>0&&parentRequirementIds.every(id=>reqById.has(id));
  const directRequirementBindings=parentRequirementIds.every(id=>(live.requirementIds||[]).includes(id));
  const exactCaseRefs=x.postimageCaseRefs?.length===2&&x.postimageCaseRefs.every(r=>r.startsWith(`${capRef}#capabilities/@id=${x.capabilityId}/acceptanceCases/`));
  const check={auditId:x.auditId,capabilityId:x.capabilityId,operation:x.operation,caseRefs:x.postimageCaseRefs,typedInputs:{source:owner.typedInputSlots,candidate:x.currentTypedInputSlots,exactMatch:exactSlots,posGivenIncludesExactSlotsAndAuthority:!!posTyped,negativeGivenIncludesExactSlots:!!negTyped},outputs:{source:owner.successOutputs,candidate:x.currentSuccessOutputs,exactMatch:exactOutputs,posThenIncludesExactOutputAndOwnerOutcome:!!posResult},negativeBoundary:{nonSuccessMatches:exactNonSuccess,errorsMatch:exactErrors,authorityMatch:exactAuthority,unsupportedCasesIncluded:unsupportedText,negativeThenIncludesAllExactValues:!!negBoundary},operationMatchesSource:exactOperation,sourceFeatureRefValid:featureRef,parentRequirementsExist:parentGood,parentRequirementsDirectlyBoundToCapability:directRequirementBindings,parentRequirementIds,postimageCaseRefsTargetCorrect:exactCaseRefs,postimageCasesExistInSnapshot:postPos&&postNeg,postimageCaseRefIndexesMatchContent:refIndexesMatch,actualPostimageCaseIndexes:[actualPosIdx,actualNegIdx]};
  typedChecks.push(check);
  caseReviews.push({auditId:x.auditId,capabilityId:x.capabilityId,operation:x.operation,caseRefs:x.postimageCaseRefs,actualPostimageCaseIndexes:[actualPosIdx,actualNegIdx],reviewDisposition:directRequirementBindings&&refIndexesMatch?'PASS':'REQUEST_CHANGES',typedSlotSourceTypes:owner.typedInputSlots?.map(s=>s.sourceType)||[],successOutputTypes:owner.successOutputs?.map(s=>s.artifactType)||[],parentRequirementRefs:x.parentRequirementRefs,parentRequirementIds,directRequirementBindings,caseRefIndexesMatch:refIndexesMatch});
  for(const ref of x.postimageCaseRefs||[])allCaseIds.push(`${x.capabilityId}/${ref}`);
  if(!(exactSlots&&exactOutputs&&exactNonSuccess&&exactErrors&&exactAuthority&&exactUnsupported&&exactOperation&&posTyped&&posResult&&negTyped&&negBoundary&&featureRef&&parentGood&&exactCaseRefs&&postPos&&postNeg))fail(x.auditId,'TYPED_SOURCE_OR_CASE_SEMANTICS_MISMATCH',check);
  if(postPos&&postNeg&&!refIndexesMatch)fail(x.auditId,'POSTIMAGE_CASE_REFERENCE_INDEX_MISMATCH',{capabilityId:x.capabilityId,declaredIndexes:[posIdx,negIdx],actualIndexes:[actualPosIdx,actualNegIdx],reviewAction:'Regenerate the candidate/postimage index references deterministically before peer review; do not edit the frozen R5 candidate in place.'});
  if(!directRequirementBindings)fail(x.auditId,'PARENT_REQUIREMENT_NOT_DIRECTLY_BOUND_TO_TARGET_CAPABILITY',{capabilityId:x.capabilityId,parentRequirementIds,capabilityRequirementIds:live.requirementIds||[],reviewAction:'Confirm the cross-leaf feature parent relation from source authority or bind the case to the capability’s actual requirement; do not silently repin.'});
  if(x.operation==='import'&&/export profile/i.test(x.sourceAcceptanceCriterion||''))fail(x.auditId,'SOURCE_CRITERION_MISMATCH_FOR_IMPORT_OPERATION',{capabilityId:x.capabilityId,operation:x.operation,sourceAcceptanceCriterion:x.sourceAcceptanceCriterion,reviewAction:'Keep the export-profile criterion bound to the export/package operation; the import case must use a source-backed import criterion or leave that cross-operation criterion unresolved.'});
  if(x.operation==='import'&&/sources enter the project/i.test(x.sourceAcceptanceCriterion||'')&&!/project registration|owner-confirmed registration/i.test(owner.semanticOutcomeContract?.result||''))fail(x.auditId,'IMPORT_CASE_DOES_NOT_ESTABLISH_PROJECT_ENTRY_CRITERION',{capabilityId:x.capabilityId,operation:x.operation,sourceAcceptanceCriterion:x.sourceAcceptanceCriterion,liveOwnerOutcome:owner.semanticOutcomeContract?.result,reviewAction:'Keep project-entry acceptance UNKNOWN until a source-authorized registration or project attachment operation is bound.'});
}
if(new Set(allCaseIds).size!==allCaseIds.length)fail('CASES','CASE_ID_DUPLICATE_PER_CAPABILITY',{count:allCaseIds.length,unique:new Set(allCaseIds).size});
if(prop.missingMeaningRootDecisionOptions.length!==9||prop.overlapRootDecisionOptions.length!==2)fail('ROOT','ROOT_CHOICE_COUNTS_CHANGED',{meaning:prop.missingMeaningRootDecisionOptions.length,overlap:prop.overlapRootDecisionOptions.length});
if(post.rootChoiceRecords.length!==11||post.rootChoiceRecords.some(x=>(x.canonicalMutation!==undefined&&x.canonicalMutation!=='NONE')||x.proposedPdp0OwnerResolution==='SELECTED'||/OPTION\s+\w+\s+SELECTED/i.test(x.proposedPdp0OwnerResolution||''))||post.rootChoiceRecords.some(x=>x.decision?.includes('NO DEFINITION APPLIED')===false&&x.canonicalMutation===undefined))fail('ROOT','ROOT_CHOICES_SELECTED_OR_MUTATED',{count:post.rootChoiceRecords.length});
const pdp0Authority=authorityMap.canonicalPdpPhases?.find(x=>x.id==='PDP-0');
for(const x of prop.missingMeaningRootDecisionOptions){const owner=x.concreteFeatureProposal?.accountableSourceOwner;if(owner!==pdp0Authority?.semanticOwner)fail(x.auditId,'SOURCE_OWNER_FIELD_MISMATCH',{candidateOwner:owner,livePdp0SemanticOwner:pdp0Authority?.semanticOwner,ownerAdoptionRemainsUnknown:true});}
const reusedIds=prop.reusedPeerSupportedRows.map(x=>x.auditId);
const r4SupportedIds=r4Peer.rows.filter(x=>x.technicalVerdict==='SUPPORTED').map(x=>x.auditId);
if(prop.reusedPeerSupportedRows.length!==13||!eq(reusedIds,r4SupportedIds))fail('R4','SUPPORTED_REUSE_SET_MISMATCH',{reusedIds,r4SupportedIds});
if(!post.historicalLeafAdjudications?.mutation?.startsWith('NONE')||post.historicalLeafAdjudications?.historicalAdjudicationCount!==462)fail('HISTORICAL','HISTORIC_ADJUDICATION_MUTATION_OR_DENOMINATOR',post.historicalLeafAdjudications);

const pairAuditIds=[...new Set(postimages.map(x=>x.auditId))];
const choiceIds=[...post.rootChoiceRecords.map(x=>x.auditId)];
const rows=exactIds.map(auditId=>{
  if(reusedIds.includes(auditId))return {auditId,reviewTreatment:'REUSE_R4_SUPPORTED_UNCHANGED',technicalDisposition:'SUPPORTED',canonicalOwnerDisposition:'UNKNOWN_PENDING_OWNER_ADOPTION'};
  if(pairAuditIds.includes(auditId)){const cr=caseReviews.filter(x=>x.auditId===auditId);const failed=cr.some(x=>x.reviewDisposition==='REQUEST_CHANGES')||findings.some(x=>x.auditId===auditId);return {auditId,reviewTreatment:'R5_LIVE_TYPED_SOURCE_CASES_VERIFIED',technicalDisposition:failed?'REQUEST_CHANGES':'PASS',casePairCount:postimages.filter(x=>x.auditId===auditId).length,capabilityCaseRecordCount:postimages.filter(x=>x.auditId===auditId).reduce((n,x)=>n+x.cases.length,0),caseReferences:cr};}
  if(choiceIds.includes(auditId)){const choice=[...prop.missingMeaningRootDecisionOptions,...prop.overlapRootDecisionOptions].find(x=>x.auditId===auditId);const badOwner=choice?.concreteFeatureProposal?.accountableSourceOwner&&choice.concreteFeatureProposal.accountableSourceOwner!=='media-product';return {auditId,reviewTreatment:'ROOT_DECISION_OPTIONS_PRESERVED_NO_SELECTION',technicalDisposition:badOwner?'REQUEST_CHANGES':'UNKNOWN',canonicalOwnerDisposition:'UNKNOWN_PENDING_ROOT_OWNER_DECISION',accountableSourceOwner:choice?.concreteFeatureProposal?.accountableSourceOwner||null};}
  return {auditId,reviewTreatment:'UNCLASSIFIED',technicalDisposition:'UNKNOWN'};
});
const counts={cohortRows:rows.length,reusedSupportedRows:rows.filter(x=>x.technicalDisposition==='SUPPORTED').length,exactCaseRepairRows:rows.filter(x=>x.technicalDisposition==='PASS').length,rootDecisionRowsUnknown:rows.filter(x=>x.technicalDisposition==='UNKNOWN').length,requestChangesRows:rows.filter(x=>x.technicalDisposition==='REQUEST_CHANGES').length,featureCasePairs:caseReviews.length,positiveNegativeCases:caseReviews.reduce((n,x)=>n+x.caseRefs.length,0),typedInputSlotsMatchingLiveOwnerDefinition:typedChecks.filter(x=>x.typedInputs.exactMatch).length,outputsMatchingLiveOwnerDefinition:typedChecks.filter(x=>x.outputs.exactMatch).length,operationIdentityMatches:typedChecks.filter(x=>x.operationMatchesSource).length,negativeAuthorityAndFailureBoundariesVerified:typedChecks.filter(x=>x.negativeBoundary.negativeThenIncludesAllExactValues).length,operationParentRequirementBindingMismatches:typedChecks.filter(x=>!x.parentRequirementsDirectlyBoundToCapability).length,meaningProposalOwnerFieldMismatches:[...prop.missingMeaningRootDecisionOptions].filter(x=>x.concreteFeatureProposal?.accountableSourceOwner!=='media-product').length,findings:findings.length};
if(counts.cohortRows!==77||counts.reusedSupportedRows!==13||counts.featureCasePairs!==60||counts.positiveNegativeCases!==120||counts.exactCaseRepairRows+counts.requestChangesRows+counts.reusedSupportedRows+counts.rootDecisionRowsUnknown!==77)fail('SUMMARY','EXPECTED_FINAL_DENOMINATORS_NOT_MET',counts);

const artifact={
  schemaVersion:'ghatana.media.pdp0.cohort02.typed-source-peer.v1',
  artifactId:'media-pdp0-parent-case-resolution-cohort-02-r5-independent-typed-source-peer',
  reviewStatus:findings.length===0?'R5_TYPED_SOURCE_AND_CASE_SEMANTICS_PASS; 11_ROOT_CHOICES_UNKNOWN; NO_CANONICAL_WRITE':'REQUEST_CHANGES',
  reviewKind:'INDEPENDENT_READ_ONLY_SOURCE_CONTENT_PEER',
  reviewer:'Separate read-only peer verification process. No owner identity, human acceptance, trust credential, or closure authority is claimed.',
  scope:{macroStage:'DISCOVERY',phase:'PDP-0 Product Truth',criterionId:'P0-07',cohortDenominator:77,residualDenominator:231,campaignIdentityDenominator:{physical:26,compositionsIncludingRoot:7,logical:21,total:54}},
  sourceBaseline:{proposalRef,proposalSha256:hashProposal,candidateRef,candidateSha256:hashCandidate,postimageRef:postRef,postimageSha256:hashPost,capabilityPostimageRef:capPostRef,capabilityPostimageSha256:hashCapPost,requirementPostimageRef:reqPostRef,requirementPostimageSha256:hashReqPost,r4PeerRef, r4PeerSha256:hashR4Peer,capabilitySourceRef:capRef,capabilitySourceSha256:sha(capBytes),requirementSourceRef:reqRef,requirementSourceSha256:sha(reqBytes),capabilityLeafReviewRef:leafRef,capabilityLeafReviewSha256:sha(leafBytes)},
  reviewMethod:{typedInputs:'For every operation case pair, compare its recorded currentTypedInputSlots byte-structure to the live capability ownerDefinition.typedInputSlots, and verify the positive and negative GWT text carries those exact typed slots.',outputs:'Compare currentSuccessOutputs byte-structure to live ownerDefinition.successOutputs and verify the positive then clause includes exact output shape and owner semanticOutcomeContract result.',operation:'Compare operation name to live capability.operation and verify the exact capability.operation appears in the positive invocation.',negativeBoundary:'Compare non-success outputs, error values, authority list, and unsupported cases to live source; verify all are represented in the negative clause.',integration:'Verify current parent requirement references, original audit source reference, postimage acceptance case IDs/indexes and actual serialized YAML cases.'},
  reviewSummary:counts,
  rows,
  perOperationCaseReview:caseReviews,
  typedSourceChecks:typedChecks,
  rootDecisionReview:{meaningOptions:9,overlapOptions:2,rootChoiceRecords:11,selectedChoices:0,canonicalMutation:'NONE',sourceAccountableOwner:pdp0Authority?.semanticOwner,ownerAdoption:'UNKNOWN',mismatchedMeaningProposalOwnerFields:counts.meaningProposalOwnerFieldMismatches},
  failedR4History:{proposalRef:`${dir}/cohort-02.r4.json`,proposalSha256:sha(read(`${dir}/cohort-02.r4.json`)),peerRef:r4PeerRef,peerSha256:hashR4Peer,status:'PRESERVED_FAILED_PREDECESSOR',requestChanges:64,supportedRowsReused:13},
  nonClaims:['No canonical capability, requirement, phase-status, owner-decision, or historical leaf-adjudication write.','No owner choice or adoption is claimed for the 9 meaning and 2 overlap decisions.','No whole P0-07 currentness, DEV_COMPLETE, independent acceptance, native closure, runtime admission, Build, Delivery, or release status is claimed.'],
  findings,
};
const outRef=`${dir}/cohort-02.r5.independent-typed-source-peer.v1.json`;
fs.writeFileSync(abs(outRef),dump(artifact));
console.log(JSON.stringify({outRef,sha256:sha(read(outRef)),reviewStatus:artifact.reviewStatus,reviewSummary:counts,findings:findings.slice(0,10)},null,2));
if(findings.length)process.exitCode=1;
