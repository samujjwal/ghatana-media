import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import YAML from 'yaml';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const FOLDER='docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=ref=>fs.readFileSync(path.resolve(ROOT,ref));
const json=ref=>JSON.parse(read(ref));
const writeCreateOnly=(ref,bytes)=>{const target=path.resolve(ROOT,ref);if(fs.existsSync(target)){if(!fs.readFileSync(target).equals(bytes))throw new Error(`refusing to overwrite immutable R8 owner-plan artifact: ${ref}`);return;}fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600});};
const OUT_SCHEMA=`${FOLDER}/media-pdp0-root-selected-source-integration-r8.source-owner-decision.schema.r3.candidate.v1.json`;
const OUT_PLAN=`${FOLDER}/media-pdp0-root-selected-source-integration-r8.source-owner-transition-plan.r3.candidate.v1.json`;
const REFS=Object.freeze({
  bundle:`${FOLDER}/media-pdp0-root-selected-source-integration-r8.successor-bundle.candidate.v1.json`,
  freeze:`${FOLDER}/media-pdp0-root-selected-source-integration-r8.freeze.v1.json`,
  peer:`${FOLDER}/media-pdp0-root-selected-source-integration-r8.independent-peer.source-peer-r2.json`,
  ledger:`${FOLDER}/media-pdp0-root-selected-source-integration-r8.split.allowed-operations.candidate.v1.json`,
  operationSchema:`${FOLDER}/media-pdp0-root-selected-source-integration-r8.allowed-operations.schema.candidate.v1.json`,
  proposal:`${FOLDER}/media-pdp0-root-selected-source-integration-r8.source-adoption-cas-proposal.r2.candidate.v1.json`,
  baseline:`${FOLDER}/media-pdp0-quality2target-current-source-baseline-2026-10-23.json`,
  rootMappingDecision:`${FOLDER}/media-pdp0-direct010-edit022-actual-root-mapping-decision-r01.json`,
  authorityMap:'.product-experience/authority-map.yaml',
});
const SOURCE_OWNER_DECISION=`${FOLDER}/media-pdp0-root-selected-source-integration-r8.source-owner-decision.r1.json`;
const ROOT_ADOPTION_DECISION=`${FOLDER}/media-pdp0-root-selected-source-integration-r8.root-adoption-decision.r1.json`;
const APPLY_AUTHORIZATION=`${FOLDER}/media-pdp0-root-selected-source-integration-r8.apply-authorization.r1.json`;

function makeOwnerDecisionSchema({bundleSha,freezeSha,peerSha,ledgerSha,operationSchemaSha,rootDecisionSha,targets}){
  const pinProps=Object.fromEntries(targets.map(row=>[row.targetRef,{const:row.sha256}]));
  const targetProps=Object.fromEntries(targets.filter(row=>row.writeTarget).map(row=>[row.targetRef,{const:row.postimageSha256}]));
  const operationProfileProps={
    profileId:{const:'media.pdp0.root-selected-source-integration.r8.source-owner.v1'},
    operationLedgerRef:{const:REFS.ledger},operationLedgerSha256:{const:ledgerSha},
    operationSchemaRef:{const:REFS.operationSchema},operationSchemaSha256:{const:operationSchemaSha},
    operationKinds:{const:['ADD_CAPABILITY_DEFINITION','APPEND_REQUIREMENT_CASE','APPEND_REQUIREMENT_CAPABILITY_BINDING','PATCH_CROSSWALK_TRACE']},
    ownerAdjudicationMutations:{const:0},trustReconstructionMutations:{const:0},
  };
  return {$schema:'https://json-schema.org/draft/2020-12/schema',$id:'media.pdp0.root-selected-source-integration-r8.source-owner-decision.r3.candidate.v1',
    title:'Candidate source-owner decision schema for exact R8 PDP-0 source adoption',
    description:'Candidate-only schema for the actual PDP-0 source owner to decide this exact frozen source successor. The source owner identity must be supplied by the real decider. The source-peer subagent technical check is not H independent review; H review remains a separate pending input. This schema is not registered and does not authorize root adoption or canonical apply.',
    type:'object',additionalProperties:false,required:['schemaVersion','decisionKind','candidateRef','candidateSha256','freezeManifestRef','freezeManifestSha256','rootMappingDecisionRef','rootMappingDecisionSha256','subagentTechnicalCheckRef','subagentTechnicalCheckSha256','actualHReview','operationProfile','sourceBaseline','targetPostimages','decisionRef','decisionSectionSha256','sourceOwner','disposition','authorityBoundary'],
    properties:{schemaVersion:{const:'media.pdp0.root-selected-source-integration-r8.source-owner-decision.r3.v1'},decisionKind:{const:'SOURCE_OWNER_ADOPT_EXACT_PDP0_SOURCE_SUCCESSOR'},candidateRef:{const:REFS.bundle},candidateSha256:{const:bundleSha},freezeManifestRef:{const:REFS.freeze},freezeManifestSha256:{const:freezeSha},rootMappingDecisionRef:{const:REFS.rootMappingDecision},rootMappingDecisionSha256:{const:rootDecisionSha},subagentTechnicalCheckRef:{const:REFS.peer},subagentTechnicalCheckSha256:{const:peerSha},actualHReview:{type:'object',additionalProperties:false,required:['reviewRef','reviewSha256','reviewerIdentity','reviewStatus'],properties:{reviewRef:{type:'string',minLength:1},reviewSha256:{type:'string',pattern:'^[a-f0-9]{64}$'},reviewerIdentity:{type:'string',minLength:1},reviewStatus:{const:'PASS'}}},operationProfile:{type:'object',additionalProperties:false,required:Object.keys(operationProfileProps),properties:operationProfileProps},sourceBaseline:{type:'object',additionalProperties:false,required:targets.map(row=>row.targetRef),properties:pinProps},targetPostimages:{type:'object',additionalProperties:false,required:Object.keys(targetProps),properties:targetProps},decisionRef:{type:'string',pattern:'^\\.product-experience/decision-log\\.md#PXD-[0-9]{3}$'},decisionSectionSha256:{type:'string',pattern:'^[a-f0-9]{64}$'},sourceOwner:{type:'object',additionalProperties:false,required:['identity','role'],properties:{identity:{type:'string',minLength:1},role:{const:'PDP0_SOURCE_OWNER'}}},disposition:{enum:['APPROVE_EXACT_CANDIDATE_FOR_SOURCE_ADOPTION','DECLINE_EXACT_CANDIDATE','REQUEST_CANDIDATE_REVISION']},authorityBoundary:{type:'object',additionalProperties:false,required:['sourceOwnerAdoption','canonicalApply','phaseStatusEffect','independentAcceptance','nativeClosure'],properties:{sourceOwnerAdoption:{enum:['ADOPTED_EXACT_CANDIDATE','NOT_ADOPTED']},canonicalApply:{const:'NOT_AUTHORIZED_BY_SOURCE_OWNER_DECISION'},phaseStatusEffect:{const:'NONE'},independentAcceptance:{const:'NOT_CLAIMED'},nativeClosure:{const:'NOT_CLAIMED'}}}},
  };
}

export function prepareMediaPdp0RootSelectedSourceIntegrationR8OwnerPlan(){
  const bundle=json(REFS.bundle),freeze=json(REFS.freeze),peer=json(REFS.peer),ledger=json(REFS.ledger),proposal=json(REFS.proposal),baseline=json(REFS.baseline),rootDecision=json(REFS.rootMappingDecision);
  const authorityDoc=YAML.parse(read(REFS.authorityMap).toString('utf8'));
  const p0=authorityDoc.canonicalPdpPhases?.find(row=>row.id==='PDP-0');
  const p0Owner=authorityDoc.phaseAuthorities?.find(row=>row.phase==='PDP-0')?.owner;
  const current7=baseline.currentTargets.map(row=>({targetRef:row.targetRef,sha256:row.sha256,actualSha256:sha(read(row.targetRef)),matches:sha(read(row.targetRef))===row.sha256}));
  const writes=ledger.outputPostimages.map(row=>({...row,preimageSha256:baseline.currentTargets.find(pin=>pin.targetRef===row.targetRef)?.sha256,writeTarget:true}));
  const targets=baseline.currentTargets.map(pin=>({...pin,writeTarget:false,...(writes.find(row=>row.targetRef===pin.targetRef)?{writeTarget:true,postimageSha256:writes.find(row=>row.targetRef===pin.targetRef).postimageSha256,postimageRef:writes.find(row=>row.targetRef===pin.targetRef).postimageRef}:{})}));
  const sourceOwnerDecisionSchema=makeOwnerDecisionSchema({bundleSha:sha(read(REFS.bundle)),freezeSha:sha(read(REFS.freeze)),peerSha:sha(read(REFS.peer)),ledgerSha:sha(read(REFS.ledger)),operationSchemaSha:sha(read(REFS.operationSchema)),rootDecisionSha:sha(read(REFS.rootMappingDecision)),targets});
  const schemaBytes=Buffer.from(`${JSON.stringify(sourceOwnerDecisionSchema,null,2)}\n`);
  writeCreateOnly(OUT_SCHEMA,schemaBytes);
  const p0Status=json('docs/implementation/pdp-0-phase-dev-status.json');
  const blockers=[];
  if(current7.some(row=>!row.matches))blockers.push('CURRENT7_PREIMAGE_STALE');
  blockers.push('ACTUAL_H_INDEPENDENT_REVIEW_PENDING');
  if(ledger.candidateSchemaStatus!=='NOT_REGISTERED; ROOT_AND_SOURCE_OWNER_ADOPTION_REQUIRED')blockers.push('CANDIDATE_ALLOWED_OPERATION_SCHEMA_STATUS_CHANGED');
  blockers.push('R8_OPERATION_PROFILE_REGISTRATION_REQUIRES_ACTUAL_SOURCE_OWNER_AUTHORITY');
  blockers.push('EXACT_R8_SOURCE_OWNER_DECISION_NOT_RECORDED');
  blockers.push('EXACT_R8_ROOT_ADOPTION_DECISION_NOT_RECORDED');
  blockers.push('DISTINCT_EXACT_INPUT_APPLY_AUTHORIZATION_NOT_RECORDED');
  blockers.push('CANONICAL_APPLY_ROUTE_NOT_ENABLED_FOR_R8');
  const plan={schemaVersion:'media.pdp0.root-selected-source-integration-r8.source-owner-transition-plan.r3.v1',supersedes:'media.pdp0.root-selected-source-integration-r8.source-owner-transition-plan.r2.v1',planKind:'READ_ONLY_EXACT_SOURCE_OWNER_ADOPTION_TRANSITION_PLAN',planDisposition:'BLOCKED_AWAITING_SOURCE_OWNER_PROFILE_REGISTRATION_DECISIONS_AND_ACTUAL_H_REVIEW',candidateBundle:{ref:REFS.bundle,sha256:sha(read(REFS.bundle))},freezeManifest:{ref:REFS.freeze,sha256:sha(read(REFS.freeze))},rootMappingDecision:{ref:REFS.rootMappingDecision,sha256:sha(read(REFS.rootMappingDecision)),selectedOptionId:rootDecision.selectedOptionId},subagentTechnicalCheck:{ref:REFS.peer,sha256:sha(read(REFS.peer)),reviewStatus:peer.reviewStatus,reviewerIdentity:peer.reviewerIdentity??'/root/source_peer',disposition:'PASS_TECHNICAL_SUBAGENT_ONLY'},actualHReview:{status:'NOT_VERIFIED',reviewerIdentity:'NOT_ESTABLISHED',reviewRef:null,sha256:null},operationProfile:{profileId:'media.pdp0.root-selected-source-integration.r8.source-owner.v1',status:'CANDIDATE_NOT_REGISTERED',ownerDecisionSchemaRef:OUT_SCHEMA,ownerDecisionSchemaSha256:sha(schemaBytes),operationSchemaRef:REFS.operationSchema,operationSchemaSha256:sha(read(REFS.operationSchema)),allowedOperations:sourceOwnerDecisionSchema.properties.operationProfile.properties.operationKinds.const,ledgerRef:REFS.ledger,ledgerSha256:sha(read(REFS.ledger)),operationCount:ledger.operations.length,counts:ledger.counts},authorityRegistry:{ref:REFS.authorityMap,sha256:sha(read(REFS.authorityMap)),pdp0SemanticOwnerRole:p0?.semanticOwner??null,pdp0PhaseOwner:p0Owner??null,decisionRecordRole:'PDP0_SOURCE_OWNER',individualIdentity:'NOT_RESOLVED_BY_AUTHORITY_MAP'},current7Preimages:current7,writeTargets:writes,readOnlyGuards:targets.filter(row=>!row.writeTarget),decisionInputs:{sourceOwnerDecision:{ref:SOURCE_OWNER_DECISION,status:'NOT_SET',schemaRef:OUT_SCHEMA,identity:'MUST_BE_SUPPLIED_BY_ACTUAL_SOURCE_OWNER'},rootAdoptionDecision:{ref:ROOT_ADOPTION_DECISION,status:'NOT_SET'},applyAuthorization:{ref:APPLY_AUTHORIZATION,status:'NOT_SET'},actualHReview:{status:'PENDING',mustBeIndependentOfCandidateAuthorAndSourceOwner:true}},existingWriter:{module:'scripts/lib/media-pdp0-review-successor-cas.mjs',transactionCore:'commitSourceAmendmentTargets',availableFixedEntryPoints:['commitValidatedPdp0SourceAmendmentSixFile','commitValidatedPdp0SourceAmendmentQualityTwoTarget'],r8EntryPoint:'NOT_IMPLEMENTED',requiredFutureBehavior:'Add a fixed four-target R8 wrapper with seven-source preimage guards under the CAS lock; invoke only after the source-owner profile is registered, source-owner decision and root adoption are recorded, actual H review is verified, and distinct exact-input apply authorization passes.'},transitionOrder:[{step:1,owner:'PDP-0 source authority',action:'Register the candidate R8 allowed-operation profile in the existing semantic-source workflow; add trace-only PATCH_CROSSWALK_TRACE support and a narrowly typed R8 definition-extension profile without weakening the base new-meaning owner/trust companion gate.'},{step:2,owner:'Actual PDP-0 source owner',action:'Validate the R8 owner decision against the generated exact-input schema, supply actual identity and decision-log PXD evidence, then adopt or decline the exact four postimages.'},{step:3,owner:'Independent H reviewer',action:'Review the exact frozen R8 inputs in an independently identified chat and provide a source-bound result; the source_peer subagent technical check is not this review.'},{step:4,owner:'Root authority',action:'Record a separate root adoption decision for the exact R8 bundle, operation profile, source-owner decision, and verified H review; the existing B_SPLIT mapping decision only selects the packet mapping.'},{step:5,owner:'Distinct apply authority',action:'Record exact-input apply authorization binding all seven preimages, all four postimages, profile/schema, owner decision, root adoption decision, and verified H review.'},{step:6,owner:'Existing guarded CAS writer',action:'Add/use a fixed R8 wrapper over commitSourceAmendmentTargets with exact four write targets and three read-only guards rechecked in beforePrepare; journal and read back every target.'}],blockers,authorityBoundary:{canonicalWrite:'NOT_PERFORMED',phaseStatus:'UNCHANGED',sourceOwnerDecision:'NOT_SET',rootAdoptionDecision:'NOT_SET',applyAuthorization:'NOT_SET',schemaRegistration:'NOT_PERFORMED',actualHReview:'NOT_VERIFIED',independentAcceptance:'NOT_CLAIMED',nativeClosure:'NOT_CLAIMED'},pdp0Status:{status:p0Status.status,sourceCurrentness:'UNKNOWN_UNTIL_NATIVE_VALIDATOR_CONFIRMS',campaignDenominator:54},canonicalApply:'NONE'};
  writeCreateOnly(OUT_PLAN,Buffer.from(`${JSON.stringify(plan,null,2)}\n`));
  return {plan,sourceOwnerDecisionSchema,refs:{schema:OUT_SCHEMA,plan:OUT_PLAN}};
}
