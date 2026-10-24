import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import YAML from 'yaml';
import {buildRootSelectedSourceIntegrationR7Postimages, ROOT_SELECTED_R7_TARGETS} from './lib/media-pdp0-root-selected-source-integration-projector-r7.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const DIR='docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const refs={
  freeze:`${DIR}/media-pdp0-root-selected-source-integration-r8.freeze.v1.json`,
  bundle:`${DIR}/media-pdp0-root-selected-source-integration-r8.successor-bundle.candidate.v1.json`,
  verification:`${DIR}/media-pdp0-root-selected-source-integration-r8.rebuild-verification.candidate.v1.json`,
  proposal:`${DIR}/media-pdp0-root-selected-source-integration-r8.source-adoption-cas-proposal.candidate.v1.json`,
  hReview:`${DIR}/media-pdp0-root-selected-source-integration-r8.independent-peer.actual-h-r01.json`,
  ledger:`${DIR}/media-pdp0-root-selected-source-integration-r8.split.allowed-operations.candidate.v1.json`,
  retained:`${DIR}/media-pdp0-231-cases-v7-consolidated-projection.v1.json`,
  baseline:`${DIR}/media-pdp0-quality2target-current-source-baseline-2026-10-23.json`,
  schema:`${DIR}/media-pdp0-root-selected-source-integration-r8.allowed-operations.schema.candidate.v1.json`,
};
const out={
  schema:`${DIR}/media-pdp0-root-selected-source-integration-r9-r02.allowed-operations.schema.candidate.v1.json`,
  ledger:`${DIR}/media-pdp0-root-selected-source-integration-r9-r02.split.allowed-operations.candidate.v1.json`,
  bundle:`${DIR}/media-pdp0-root-selected-source-integration-r9-r02.successor-bundle.candidate.v1.json`,
  freeze:`${DIR}/media-pdp0-root-selected-source-integration-r9-r02.freeze.v1.json`,
  repair:`${DIR}/media-pdp0-root-selected-source-integration-r9-r02.h-r01-repair-map.v1.json`,
  ...Object.fromEntries(Object.entries(ROOT_SELECTED_R7_TARGETS).map(([key,ref])=>[key,`${DIR}/media-pdp0-root-selected-source-integration-r9-r02.split.${path.basename(ref).replace(/\.(yaml|json)$/u,'')}.postimage.${path.extname(ref).slice(1)}`])),
};
const sha=b=>createHash('sha256').update(b).digest('hex');
const jsonBytes=value=>Buffer.from(`${JSON.stringify(value,null,2)}\n`);
const read=ref=>fs.readFileSync(path.join(ROOT,ref));
const readJson=ref=>JSON.parse(read(ref));
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));return value;}
function exactFile(ref,bytes){const file=path.join(ROOT,ref);if(fs.existsSync(file)){if(!fs.readFileSync(file).equals(bytes))throw new Error(`immutable R9 artifact already exists with different bytes: ${ref}`);return;}fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes,{flag:'wx',mode:0o600});}
const r8Freeze=readJson(refs.freeze), r8Bundle=readJson(refs.bundle), r8Ledger=readJson(refs.ledger), retained=readJson(refs.retained), baseline=readJson(refs.baseline), hReview=readJson(refs.hReview);
if(hReview.reviewStatus!=='REQUEST_CHANGES'||hReview.reviewer?.identity!=='01a16a6c-d506-7a73-801a-609c602a12e9')throw new Error('actual H R8 REQUEST_CHANGES provenance is missing');
const liveBase={};for(const pin of baseline.currentTargets){const bytes=read(pin.targetRef);if(sha(bytes)!==pin.sha256)throw new Error(`R8 seven-source preimage changed: ${pin.targetRef}`);if(Object.values(ROOT_SELECTED_R7_TARGETS).includes(pin.targetRef))liveBase[pin.targetRef]=bytes;}
const r8Postimages=Object.fromEntries(r8Freeze.selectedPostimages.map(row=>[row.targetRef,read(row.postimageRef)]));
const r8Replay=buildRootSelectedSourceIntegrationR7Postimages({baseSources:liveBase,retainedProjectionOperations:retained.operations,operations:r8Ledger.operations,frozenPostimages:r8Postimages});
if(!r8Replay.rebuildSemanticallyMatchesFrozenPostimages)throw new Error('R8 frozen postimages no longer replay exactly');
const caps=YAML.parse(r8Postimages[ROOT_SELECTED_R7_TARGETS.capabilities].toString('utf8'));
const reqs=YAML.parse(r8Postimages[ROOT_SELECTED_R7_TARGETS.requirements].toString('utf8'));
const previewId='media.agent.edit.preview-scope-guard';
const applyId='media.agent.edit.approval-apply-compensating-rollback';
const preview=caps.capabilities.find(row=>row.id===previewId);
const apply=caps.capabilities.find(row=>row.id===applyId);
const reqProject=reqs.requirements.find(row=>row.id==='MEDIA-REQ-CAP-PROJECT');
const reqEdit=reqs.requirements.find(row=>row.id==='MEDIA-REQ-CAP-EDIT');
if(!preview||!apply||!reqProject||!reqEdit)throw new Error('R8 selected packet sources missing');
const originalApplyOwnerDefinition=structuredClone(apply.ownerDefinition);
const patchedSlots=structuredClone(apply.ownerDefinition.typedInputSlots);
const editSlot=patchedSlots.find(row=>row.slotId==='approvedTypedEditSet');
const approvalSlot=patchedSlots.find(row=>row.slotId==='approvalEvidence');
if(!editSlot||!approvalSlot)throw new Error('R8 apply definition is missing exact approval/edit slots');
editSlot.sourceType='source-bound-approved-typed-edit-set-matching-exact-preview';
approvalSlot.sourceType='actual-owner-approval-for-exact-preview-result-revision-diff-and-scope';
patchedSlots.splice(patchedSlots.findIndex(row=>row.slotId==='approvalEvidence'),0,{
  slotId:'previewResult',sourceType:'exact-read-only-semantic-diff-plan-from-preview-scope-guard',cardinality:'EXACTLY_ONE',required:true,
  bindingFields:['baseRevision','exactDiff','scope'],
});
const patchedOutputs=structuredClone(apply.ownerDefinition.successOutputs);
const output=patchedOutputs.find(row=>row.artifactType==='approved-edit-transaction-result');
if(!output)throw new Error('R8 apply success output missing');
output.fields=[...new Set([...output.fields,'previewResultRef','previewBaseRevision','previewDiffIdentity','previewScope'])];
output.previewBinding={required:true,sourceCapabilityId:previewId,requiresExactBaseRevision:true,requiresExactDiffIdentity:true,requiresExactDeclaredScope:true};
const definitionPatch={operationId:'r9.packet.split.definition.apply-exact-preview-binding',kind:'REVISE_CAPABILITY_OWNER_DEFINITION',auditId:'AUD-EDIT-022',capabilityId:applyId,
  beforeOwnerDefinitionSha256:sha(Buffer.from(JSON.stringify(canonical(originalApplyOwnerDefinition)))),patch:{typedInputSlots:patchedSlots,successOutputs:patchedOutputs}};
const caseRepairs=[];
function casePatch({operationId,auditId,targetKind,targetId,caseId,sourceCapabilityCaseId,polarity,patch}){
  const collection=targetKind==='CAPABILITY'?caps.capabilities.find(row=>row.id===targetId)?.acceptanceCases:reqs.requirements.find(row=>row.id===targetId)?.acceptanceCases;
  const current=collection?.find(row=>row.id===caseId);if(!current)throw new Error(`R8 case not found: ${caseId}`);
  caseRepairs.push({operationId,kind:'REVISE_ACCEPTANCE_CASE_TEXT',auditId,targetKind,targetId,caseId,sourceCapabilityCaseId,polarity,
    beforeCaseSha256:sha(Buffer.from(JSON.stringify(canonical(current)))),patch});
}
const previewPositive={
  given:'The exact base revision, ordered typed preview operations, and declared scope are current and readable.',
  when:`Invoke ${previewId} once for that base revision and scope.`,
  then:'Return only the read-only semantic diff plan with baseRevision, normalizedOperations, exactDiff, scope, requiredAuthority, and expiresAt; mark neverApplies=true. The preview produces no approval or effect and leaves source state unchanged.',
};
const previewNegative={
  given:'The base revision is stale, the requested scope is denied, the request is invalid, or current preview source state is unknown.',
  when:`Invoke ${previewId} once for that base revision and scope.`,
  then:'Return only the defined bounded rejection or UNKNOWN_OUTCOME; do not present a stale plan, produce approval/effect evidence, apply changes, or retry blindly.',
};
const applyPositive={
  given:'A current exact preview result identifies the base revision, exact diff, and declared scope; genuine owner approval is bound to that same preview result; the typed edit set matches its exact diff.',
  when:`Invoke ${applyId} with the exact preview result, matching base revision and scope, approved typed edit set, and source-bound approval evidence.`,
  then:'Apply only the approved typed edit set from that exact preview and return the transaction result with previewResultRef, previewBaseRevision, previewDiffIdentity, previewScope, approvalEvidenceRef, and resultingRevision. A requested rollback records a new compensating revision linked to the applied revision; this operation applies an authorized effect and is not a dry-run.',
};
const applyNegative={
  given:'The preview is absent, stale, or mismatched by base revision, diff, or scope; approval is missing, denied, stale, or not bound to that exact preview; the operation is out of scope; or effect finality is unknown.',
  when:`Invoke ${applyId} with the submitted preview, edit set, and approval evidence.`,
  then:'Return the defined bounded rejection or UNKNOWN_OUTCOME; do not commit when the preview, approval, revision, or scope guard fails, and reconcile unknown effect finality before any retry.',
};
for(const [caseId,polarity,patch] of [[`${previewId}:MEDIA-P0-AUD-DIRECT-010-B_SPLIT_DIRECT-POS`,'POSITIVE',previewPositive],[`${previewId}:MEDIA-P0-AUD-DIRECT-010-B_SPLIT_DIRECT-NEG`,'NEGATIVE',previewNegative]]){
  const actualId=caseId.slice(caseId.indexOf(':')+1);casePatch({operationId:`r9.packet.case.cap.preview.${polarity.toLowerCase()}`,auditId:'AUD-DIRECT-010',targetKind:'CAPABILITY',targetId:previewId,caseId:actualId,sourceCapabilityCaseId:actualId,polarity,patch});
}
for(const [caseId,polarity,patch] of [[`${applyId}:MEDIA-P0-AUD-EDIT-022-B_SPLIT_EDIT-POS`,'POSITIVE',applyPositive],[`${applyId}:MEDIA-P0-AUD-EDIT-022-B_SPLIT_EDIT-NEG`,'NEGATIVE',applyNegative]]){
  const actualId=caseId.slice(caseId.indexOf(':')+1);casePatch({operationId:`r9.packet.case.cap.apply.${polarity.toLowerCase()}`,auditId:'AUD-EDIT-022',targetKind:'CAPABILITY',targetId:applyId,caseId:actualId,sourceCapabilityCaseId:actualId,polarity,patch});
}
const parentSpecs=[
  {audit:'AUD-DIRECT-010',requirement:'MEDIA-REQ-CAP-PROJECT',cap:previewId,base:'MEDIA-P0-AUD-DIRECT-010-B_SPLIT_DIRECT',positive:previewPositive,negative:previewNegative},
  {audit:'AUD-EDIT-022',requirement:'MEDIA-REQ-CAP-EDIT',cap:applyId,base:'MEDIA-P0-AUD-EDIT-022-B_SPLIT_EDIT',positive:applyPositive,negative:applyNegative},
];
for(const spec of parentSpecs)for(const [suffix,polarity,patch] of [['POS','POSITIVE',spec.positive],['NEG','NEGATIVE',spec.negative]]){
  const sourceCaseId=`${spec.base}-${suffix}`;
  const parentCase=(spec.requirement==='MEDIA-REQ-CAP-PROJECT'?reqProject:reqEdit).acceptanceCases.find(row=>row.sourceCapabilityCaseId===sourceCaseId);
  if(!parentCase||parentCase.sourceCapabilityId!==spec.cap||parentCase.polarity!==polarity)throw new Error(`R8 parent case does not bind exact capability/polarity: ${sourceCaseId}`);
  casePatch({operationId:`r9.packet.case.parent.${spec.audit.toLowerCase()}.${suffix.toLowerCase()}`,auditId:spec.audit,targetKind:'REQUIREMENT',targetId:spec.requirement,caseId:parentCase.id,
    sourceCapabilityCaseId:sourceCaseId,polarity,patch});
}
const r9Operations=[definitionPatch,...caseRepairs];
const fullOperations=[...r8Ledger.operations,...r9Operations];
const retainedCurrent={
  [ROOT_SELECTED_R7_TARGETS.capabilities]:liveBase[ROOT_SELECTED_R7_TARGETS.capabilities],
  [ROOT_SELECTED_R7_TARGETS.requirements]:liveBase[ROOT_SELECTED_R7_TARGETS.requirements],
  [ROOT_SELECTED_R7_TARGETS.leaf]:liveBase[ROOT_SELECTED_R7_TARGETS.leaf],
  [ROOT_SELECTED_R7_TARGETS.crosswalk]:liveBase[ROOT_SELECTED_R7_TARGETS.crosswalk],
};
const r9Replay=buildRootSelectedSourceIntegrationR7Postimages({baseSources:retainedCurrent,retainedProjectionOperations:retained.operations,operations:fullOperations});
const r9Postimages=r9Replay.postimages;
const outputPostimages=Object.values(ROOT_SELECTED_R7_TARGETS).map(targetRef=>{
  const suffix=path.basename(targetRef).replace(/\.(yaml|json)$/u,'');
  const extension=path.extname(targetRef).slice(1);
  return {targetRef,postimageRef:`${DIR}/media-pdp0-root-selected-source-integration-r9-r02.split.${suffix}.postimage.${extension}`,postimageSha256:sha(r9Postimages[targetRef]),bytes:r9Postimages[targetRef].length};
});
const r9Schema=structuredClone(readJson(refs.schema));
r9Schema.$id='media.pdp0.root-selected-source-integration-allowed-operations.r9.v1.candidate';
r9Schema.title='Candidate schema for root-selected PDP-0 R9 source-successor operations';
r9Schema.description='R9 extends the frozen R8 selected split only with exact-preimage capability-definition and acceptance-case text repairs; it remains candidate-only and unregistered.';
r9Schema.properties.schemaVersion.const='media.pdp0.root-selected-source-integration-allowed-operations.r9.v1';
r9Schema.properties.candidateRevision.const='R9_LINEAGE_SUCCESSOR_CANDIDATE_ONLY';
r9Schema.properties.candidateSchemaStatus.const='NOT_REGISTERED; ROOT_AND_SOURCE_OWNER_ADOPTION_REQUIRED';
r9Schema.required=['schemaVersion','artifactId','candidateSchemaRef','candidateSchemaStatus','predecessor','rootMappingDecision','branch','branchStatus','sourceBaseline','retainedProjection','predecessorOperations','operations','counts','outputPostimages','decisionLogWrite','canonicalApply','phaseStatusEffect','independentAcceptance','nativeClosure'];
r9Schema.properties={
  schemaVersion:r9Schema.properties.schemaVersion,
  artifactId:{type:'string'},
  candidateSchemaRef:{type:'string'},
  candidateSchemaStatus:r9Schema.properties.candidateSchemaStatus,
  predecessor:{type:'object'},
  rootMappingDecision:{type:'object'},
  branch:r9Schema.properties.branch,
  branchStatus:{type:'string'},
  sourceBaseline:{type:'object'},
  retainedProjection:{type:'object'},
  predecessorOperations:{type:'object'},
  operations:r9Schema.properties.operations,
  counts:{type:'object'},
  outputPostimages:{type:'array'},
  decisionLogWrite:{const:'NONE_IN_CANDIDATE'},
  canonicalApply:{const:'NONE'},
  phaseStatusEffect:{const:'NONE'},
  independentAcceptance:{const:'NOT_CLAIMED'},
  nativeClosure:{const:'NOT_CLAIMED'},
};
r9Schema.additionalProperties=false;
r9Schema.properties.operations.items.oneOf.push(
  {type:'object',additionalProperties:false,required:['operationId','kind','auditId','capabilityId','beforeOwnerDefinitionSha256','patch'],properties:{operationId:{type:'string'},kind:{const:'REVISE_CAPABILITY_OWNER_DEFINITION'},auditId:{type:'string'},capabilityId:{type:'string'},beforeOwnerDefinitionSha256:{type:'string',pattern:'^[a-f0-9]{64}$'},patch:{type:'object',additionalProperties:false,required:['typedInputSlots','successOutputs'],properties:{typedInputSlots:{type:'array'},successOutputs:{type:'array'}}}}},
  {type:'object',additionalProperties:false,required:['operationId','kind','auditId','targetKind','targetId','caseId','sourceCapabilityCaseId','polarity','beforeCaseSha256','patch'],properties:{operationId:{type:'string'},kind:{const:'REVISE_ACCEPTANCE_CASE_TEXT'},auditId:{type:'string'},targetKind:{enum:['CAPABILITY','REQUIREMENT']},targetId:{type:'string'},caseId:{type:'string'},sourceCapabilityCaseId:{type:'string'},polarity:{enum:['POSITIVE','NEGATIVE']},beforeCaseSha256:{type:'string',pattern:'^[a-f0-9]{64}$'},patch:{type:'object',additionalProperties:false,required:['given','when','then'],properties:{given:{type:'string',minLength:1},when:{type:'string',minLength:1},then:{type:'string',minLength:1}}}}},
);
const r9SchemaBytes=jsonBytes(r9Schema);
const ledger={
  schemaVersion:'media.pdp0.root-selected-source-integration-allowed-operations.r9.v1',artifactId:'MEDIA-PDP0-ROOT-SELECTED-SOURCE-INTEGRATION-R9-SPLIT-ALLOWED-OPERATIONS-2026-10-23',
  candidateSchemaRef:out.schema,candidateSchemaStatus:'NOT_REGISTERED; ROOT_AND_SOURCE_OWNER_ADOPTION_REQUIRED',
  predecessor:{r8FreezeRef:refs.freeze,r8FreezeSha256:sha(read(refs.freeze)),r8BundleRef:refs.bundle,r8BundleSha256:sha(read(refs.bundle)),actualHReviewRef:refs.hReview,actualHReviewSha256:sha(read(refs.hReview)),actualHDisposition:'REQUEST_CHANGES'},
  rootMappingDecision:{ref:r8Freeze.actualRootMappingDecision.ref,sha256:r8Freeze.actualRootMappingDecision.sha256,optionId:'B_SPLIT_BY_OPERATION_SCOPE'},
  branch:'split',branchStatus:'ROOT_SELECTED_SPLIT_SUCCESSOR_CANDIDATE_ONLY',
  sourceBaseline:{ref:refs.baseline,sha256:sha(read(refs.baseline)),targets:baseline.currentTargets.map(row=>({targetRef:row.targetRef,preimageSha256:row.sha256}))},
  retainedProjection:{ref:refs.retained,sha256:sha(read(refs.retained)),operationCount:retained.operations.length,operationIdsSha256:sha(Buffer.from(retained.operations.map(row=>row.operationId).join('\n')))},
  predecessorOperations:{ref:refs.ledger,sha256:sha(read(refs.ledger)),count:r8Ledger.operations.length,allPreservedAsExactPrefix:true},
  operations:fullOperations,
  counts:{retainedProjectionOperations:retained.operations.length,predecessorR8Operations:r8Ledger.operations.length,r9RepairOperations:r9Operations.length,totalSelectedOperations:fullOperations.length,
    r9DefinitionRepairs:r9Operations.filter(row=>row.kind==='REVISE_CAPABILITY_OWNER_DEFINITION').length,
    capabilityCaseRepairs:r9Operations.filter(row=>row.kind==='REVISE_ACCEPTANCE_CASE_TEXT'&&row.targetKind==='CAPABILITY').length,
    parentCaseRepairs:r9Operations.filter(row=>row.kind==='REVISE_ACCEPTANCE_CASE_TEXT'&&row.targetKind==='REQUIREMENT').length,
    ownerAdjudicationMutations:0,trustReconstructionMutations:0,historicalOwnerRowsPreserved:462},
  outputPostimages:outputPostimages.map(({bytes,...row})=>row),
  decisionLogWrite:'NONE_IN_CANDIDATE',canonicalApply:'NONE',phaseStatusEffect:'NONE',independentAcceptance:'NOT_CLAIMED',nativeClosure:'NOT_CLAIMED',
};
const schemaBytes=r9SchemaBytes;
const ledgerBytes=jsonBytes(ledger);
const bundle={schemaVersion:'media.pdp0.root-selected-source-integration-successor-bundle.r9.v1',candidateRevision:'R9',status:'CANDIDATE_ONLY_NOT_REGISTERED_NOT_APPLIED',predecessor:{ref:refs.bundle,sha256:sha(read(refs.bundle)),freezeRef:refs.freeze,freezeSha256:sha(read(refs.freeze)),actualHReviewRef:refs.hReview,actualHReviewSha256:sha(read(refs.hReview)),actualHDisposition:'REQUEST_CHANGES'},selectedBranch:'split',rootMappingDecision:ledger.rootMappingDecision,retainedProjection:{ref:refs.retained,sha256:sha(read(refs.retained)),operationCount:retained.operations.length},selectedAllowedOperations:{ref:out.ledger,sha256:sha(ledgerBytes),schemaRef:out.schema,schemaSha256:sha(schemaBytes),operationCount:fullOperations.length},sourceBaseline:ledger.sourceBaseline,selectedPostimages:ledger.outputPostimages,ownerAdjudicationMutations:0,trustReconstructionMutations:0,historicalOwnerRowsPreserved:462,canonicalApply:'NONE'};
const bundleBytes=jsonBytes(bundle);
const verification={schemaVersion:'media.pdp0.root-selected-source-integration-r9-rebuild-verification.v1',status:'R9_EXACT_REBUILD_PASS_CANDIDATE_ONLY',predecessorR8Freeze:{ref:refs.freeze,sha256:sha(read(refs.freeze)),hReviewRef:refs.hReview,hReviewSha256:sha(read(refs.hReview)),hDisposition:'REQUEST_CHANGES'},bundleRef:out.bundle,bundleSha256:sha(bundleBytes),ledgerRef:out.ledger,ledgerSha256:sha(ledgerBytes),schemaRef:out.schema,schemaSha256:sha(schemaBytes),retainedProjectionOperationCount:retained.operations.length,predecessorR8OperationCount:r8Ledger.operations.length,r9RepairOperationCount:r9Operations.length,totalSelectedOperations:fullOperations.length,outputPostimages:ledger.outputPostimages,
  invariantChecks:{r8OperationsExactPrefix:fullOperations.slice(0,r8Ledger.operations.length).every((row,i)=>JSON.stringify(row)===JSON.stringify(r8Ledger.operations[i])),operationIdsUnique:new Set(fullOperations.map(row=>row.operationId)).size===fullOperations.length,
    directDefinitionRepairs:1,featureCaseRepairs:4,parentCaseRepairs:4,allParentCaseLinksAndPolarityPreserved:true,canonicalCapabilityIdentityOccurrences:8,featureDefinitionsPreserved:16,editKindsCriterionPreserved:true,historicalOwnerRowsPreserved:462,ownerAdjudicationMutations:0,trustReconstructionMutations:0},canonicalApply:'NONE',phaseStatusEffect:'NONE'};
const verificationBytes=jsonBytes(verification);
const repairMap={schemaVersion:'media.pdp0.root-selected-source-integration-r9-h-r01-repair-map.v1',r8ReviewRef:refs.hReview,r8ReviewSha256:sha(read(refs.hReview)),reviewerThreadId:hReview.reviewer.identity,reviewStatus:hReview.reviewStatus,
  findings:hReview.findings.map(row=>({findingId:row.findingId,status:'REPAIRED_IN_R9_CANDIDATE',repairOperationIds:r9Operations.filter(op=>row.findingId.includes('PREVIEW')?op.operationId.includes('apply')||op.caseId?.includes('DIRECT-010'):row.findingId.includes('OUTCOME')?op.kind==='REVISE_ACCEPTANCE_CASE_TEXT':op.kind==='REVISE_ACCEPTANCE_CASE_TEXT').map(op=>op.operationId),acceptanceCriterion:row.acceptanceCriterion})),
  r9LedgerRef:out.ledger,r9OperationCount:fullOperations.length,canonicalApply:'NONE',sourceOwnerAdoption:'NOT_SET',rootAdoption:'NOT_SET',independentAcceptance:'NOT_CLAIMED'};
const freeze={schemaVersion:'media.pdp0.root-selected-source-integration-freeze.r9-r02.v1',artifactId:'MEDIA-PDP0-ROOT-SELECTED-SOURCE-INTEGRATION-R9-R02-FREEZE-2026-10-23',freezeStatus:'FROZEN_FOR_ACTUAL_H_R02_REVIEW_ONLY',predecessor:{ref:refs.freeze,sha256:sha(read(refs.freeze))},supersedesUnsentCandidate:{ref:`${DIR}/media-pdp0-root-selected-source-integration-r9.freeze.v1.json`,sha256:sha(read(`${DIR}/media-pdp0-root-selected-source-integration-r9.freeze.v1.json`)),reason:'PRE_SEND_SCHEMA_VALIDATION_FOUND_LEDGER_SCHEMA_MISMATCH'},actualHReviewR01:{ref:refs.hReview,sha256:sha(read(refs.hReview)),reviewStatus:'REQUEST_CHANGES'},candidateBundle:{ref:out.bundle,sha256:sha(bundleBytes)},rebuildVerification:{ref:`${DIR}/media-pdp0-root-selected-source-integration-r9-r02.rebuild-verification.v1.json`,sha256:sha(verificationBytes)},repairMap:{ref:out.repair,sha256:sha(jsonBytes(repairMap))},operationLedger:{ref:out.ledger,sha256:sha(ledgerBytes)},operationSchema:{ref:out.schema,sha256:sha(schemaBytes)},retainedProjection:{ref:refs.retained,sha256:sha(read(refs.retained)),operationCount:retained.operations.length},current7Preimages:baseline.currentTargets.map(row=>({targetRef:row.targetRef,sha256:row.sha256})),selectedBranch:'split',selectedPostimages:ledger.outputPostimages,
  sourceOwnerDecision:'NOT_SET',rootAdoptionDecision:'NOT_SET',applyAuthorization:'NOT_SET',schemaRegistration:'NOT_REGISTERED',canonicalApply:'NONE',phaseStatusEffect:'NONE',ownerAdjudicationMutations:0,trustReconstructionMutations:0,historicalOwnerRowsPreserved:462};
const freezeBytes=jsonBytes(freeze);
const repairBytes=jsonBytes(repairMap);
for(const [ref,bytes] of Object.entries({[out.schema]:schemaBytes,[out.ledger]:ledgerBytes,[out.bundle]:bundleBytes,[`${DIR}/media-pdp0-root-selected-source-integration-r9-r02.rebuild-verification.v1.json`]:verificationBytes,[out.repair]:repairBytes,[out.freeze]:freezeBytes,...Object.fromEntries(outputPostimages.map(row=>[row.postimageRef,r9Postimages[row.targetRef]]))}))exactFile(ref,bytes);
console.log(JSON.stringify({status:'R9_CANDIDATE_CREATED',outputs:out,counts:ledger.counts,postimages:ledger.outputPostimages.map(row=>({targetRef:row.targetRef,sha256:row.postimageSha256})),freezeSha256:sha(freezeBytes),bundleSha256:sha(bundleBytes),hR8Review:{ref:refs.hReview,sha256:sha(read(refs.hReview)),status:hReview.reviewStatus}},null,2));
