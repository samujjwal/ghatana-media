#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {buildRootSelectedSourceIntegrationR7Postimages, deriveRootSelectedSourceIntegrationR7Operations, assertRootSelectedCurrent7Preimages, ROOT_SELECTED_R7_TARGETS, ROOT_SELECTED_R7_ALLOWED_OPERATIONS, ROOT_SELECTED_R7_CROSSWALK_PATCH_FIELDS, ROOT_SELECTED_R7_CURRENT7, sha256R7} from './lib/media-pdp0-root-selected-source-integration-projector-r7.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const read = ref => fs.readFileSync(path.resolve(root, ref));
const json = ref => JSON.parse(read(ref));
const write = (ref, value) => fs.writeFileSync(path.resolve(root, ref), `${JSON.stringify(value, null, 2)}\n`);
const baselineRef = `${folder}/media-pdp0-quality2target-current-source-baseline-2026-10-23.json`;
const projectionRef = `${folder}/media-pdp0-231-cases-v7-consolidated-projection.v1.json`;
const r7OpsRef = `${folder}/media-pdp0-root-selected-source-integration-r7.operations.json`;
const r7ManifestRef = `${folder}/media-pdp0-root-selected-source-integration-r7.postimages.json`;
const freezeRef = `${folder}/media-pdp0-root-selected-source-integration-r7.freeze.v1.json`;
const schemaRef = `${folder}/media-pdp0-root-selected-source-integration-r8.allowed-operations.schema.candidate.v1.json`;
const ledgerRefs = Object.fromEntries(['core','shared','split'].map(branch => [branch,`${folder}/media-pdp0-root-selected-source-integration-r8.${branch}.allowed-operations.candidate.v1.json`]));
const baseline = json(baselineRef), targets = baseline.currentTargets;
const targetRefs = Object.values(ROOT_SELECTED_R7_TARGETS);
const sourceBytes = Object.fromEntries(targetRefs.map(ref => [ref,read(ref)]));
const current7Bytes = Object.fromEntries(ROOT_SELECTED_R7_CURRENT7.map(ref=>[ref,read(ref)]));
assertRootSelectedCurrent7Preimages(targets,current7Bytes);
const projection = json(projectionRef);
if (projection.operations.length!==248) throw new Error('retained projection must contain exactly 248 source operations');
for (const row of projection.projectedTargetSet) if (!targets.some(base=>base.targetRef===row.targetRef&&base.sha256===row.preimageSha256)) throw new Error(`retained projection preimage differs from current7 baseline: ${row.targetRef}`);
const baseProjection = Object.fromEntries(projection.projectedTargetSet.map(row=>[row.targetRef,read(row.postimageRef)]));
const sourceOps = json(r7OpsRef), postimages = json(r7ManifestRef), freeze = json(freezeRef);
const branchRefs = Object.fromEntries(['core','shared','split'].map(branch => [branch,postimages[branch === 'core' ? 'corePostimages' : 'packetAlternatives'][branch === 'core' ? undefined : branch]?.postimages]));
// The core target set is named directly; packet alternatives are already composed over that core.
branchRefs.core = postimages.corePostimages;
branchRefs.shared = postimages.packetAlternatives.shared.postimages;
branchRefs.split = postimages.packetAlternatives.split.postimages;
// R8 is an immutable successor to frozen R7. It repairs packet parent-case
// lineage by binding each parent case to the unique embedded capability case
// with the same polarity; it does not alter the historical R7 artifacts.
const rootDecisionRef = `${folder}/media-pdp0-direct010-edit022-actual-root-mapping-decision-r01.json`;
const rootDecisionSha256 = sha256R7(read(rootDecisionRef));
const r8Branches = {};
for (const branch of ['core','shared','split']) {
  const refs = [];
  const branchFiles = Object.fromEntries(branchRefs[branch].map(row=>[row.targetRef,read(row.postimageRef)]));
  const reqRef = ROOT_SELECTED_R7_TARGETS.requirements;
  const reqDoc = YAML.parseDocument(branchFiles[reqRef].toString('utf8'),{uniqueKeys:true});
  const capsDoc = YAML.parseDocument(branchFiles[ROOT_SELECTED_R7_TARGETS.capabilities].toString('utf8'),{uniqueKeys:true});
  if (reqDoc.errors.length || capsDoc.errors.length) throw new Error(`R8 ${branch} source YAML is invalid`);
  const caps = capsDoc.toJS().capabilities;
  const capCases = new Map(caps.map(cap=>[cap.id,cap.acceptanceCases??[]]));
  const requirements = reqDoc.get('requirements',true);
  for (const reqNode of requirements.items) {
    const cases = reqNode.get('acceptanceCases',true);
    if (!cases?.items) continue;
    for (const caseNode of cases.items) {
      const record = caseNode.toJS(reqDoc);
      const hasCaseId = record.sourceCapabilityCaseId || record.sourceCapabilityCaseRef;
      if (!record.sourceCapabilityId || hasCaseId) continue;
      const matches = (capCases.get(record.sourceCapabilityId)??[]).filter(capCase=>
        String(capCase.polarity).toUpperCase()===String(record.polarity).toUpperCase()
        && (!record.sourceAuditId || !capCase.sourceAuditId || capCase.sourceAuditId===record.sourceAuditId));
      if (matches.length!==1) throw new Error(`R8 ${branch}: parent case ${record.id} has ${matches.length} exact polarity-matched source capability cases`);
      caseNode.set('sourceCapabilityCaseId',matches[0].id);
    }
  }
  branchFiles[reqRef]=Buffer.from(reqDoc.toString({lineWidth:0}));
  for (const targetRef of targetRefs) {
    const basename = path.basename(targetRef).replace(/\.(yaml|json)$/,'');
    const extension = path.extname(targetRef);
    const outputRef = `${folder}/media-pdp0-root-selected-source-integration-r8.${branch}.${basename}.postimage${extension}`;
    fs.writeFileSync(path.resolve(root,outputRef),branchFiles[targetRef]);
    refs.push({targetRef,postimageRef:outputRef,postimageSha256:sha256R7(branchFiles[targetRef])});
  }
  r8Branches[branch]=refs;
}
const outputs = {};

for (const branch of ['core','shared','split']) {
  const candidate = Object.fromEntries(r8Branches[branch].map(row => [row.targetRef,read(row.postimageRef)]));
  const packetOperationLedger = branch === 'shared' ? sourceOps.sharedPacketOperations : branch === 'split' ? sourceOps.splitPacketOperations : [];
  const operations = deriveRootSelectedSourceIntegrationR7Operations({retainedProjectionSources:baseProjection,candidatePostimages:candidate,operationIdentityLedger:sourceOps,packetOperationLedger});
  const projected = buildRootSelectedSourceIntegrationR7Postimages({baseSources:sourceBytes,retainedProjectionOperations:projection.operations,retainedProjectionPostimages:baseProjection,operations,frozenPostimages:candidate});
  for (const row of r8Branches[branch]) if (projected.postimages[row.targetRef].compare(candidate[row.targetRef]) !== 0) throw new Error(`${branch} rebuilt bytes differ for ${row.targetRef}`);
  const operationIds = operations.map(op => op.operationId);
  const retainedIds = new Set(projection.operations.map(op => op.operationId));
  if (new Set(operationIds).size !== operationIds.length || operationIds.some(id => retainedIds.has(id))) throw new Error(`${branch} operation IDs collide with retained projection history`);
  const ledger = {
    schemaVersion:'media.pdp0.root-selected-source-integration-allowed-operations.v1',
    artifactId:`MEDIA-PDP0-ROOT-SELECTED-SOURCE-INTEGRATION-R8-${branch.toUpperCase()}-ALLOWED-OPERATIONS-2026-10-23`,
    candidateSchemaRef:schemaRef,
    candidateSchemaStatus:'NOT_REGISTERED; ROOT_AND_SOURCE_OWNER_ADOPTION_REQUIRED',
    predecessorFreeze:{ref:freezeRef,sha256:sha256R7(read(freezeRef))},rootMappingDecision:{ref:rootDecisionRef,sha256:rootDecisionSha256,optionId:'B_SPLIT_BY_OPERATION_SCOPE'},
    candidateRevision:'R8_LINEAGE_SUCCESSOR_CANDIDATE_ONLY',
    branch,branchStatus:branch==='core'?'CORE_FEATURES_ONLY':`PACKET_ALTERNATIVE_${branch.toUpperCase()}_UNSELECTED`,
    sourceBaseline:{ref:baselineRef,sha256:sha256R7(read(baselineRef)),targets:targets.map(row=>({targetRef:row.targetRef,preimageSha256:row.sha256}))},
    retainedProjection:{ref:projectionRef,sha256:sha256R7(read(projectionRef)),operationCount:projection.operations.length,operationIds:projection.operations.map(op=>op.operationId)},
    operations,
    counts:{operations:operations.length,definitions:operations.filter(op=>op.kind==='ADD_CAPABILITY_DEFINITION').length,embeddedCapabilityCases:operations.filter(op=>op.kind==='ADD_CAPABILITY_DEFINITION').reduce((n,op)=>n+op.record.acceptanceCases.length,0),parentCases:operations.filter(op=>op.kind==='APPEND_REQUIREMENT_CASE').length,bindings:operations.filter(op=>op.kind==='APPEND_REQUIREMENT_CAPABILITY_BINDING').length,crosswalkPatches:operations.filter(op=>op.kind==='PATCH_CROSSWALK_TRACE').length,ownerAdjudicationMutations:0,trustReconstructionMutations:0},
    outputPostimages:r8Branches[branch].map(row=>({targetRef:row.targetRef,postimageRef:row.postimageRef,postimageSha256:row.postimageSha256,rebuiltSha256:projected.postimageHashes[row.targetRef]})),
    validation:{allSevenPreimagesCurrent:targets.every(row=>sha256R7(read(row.targetRef))===row.sha256),allFrozenPostimageSemanticsRebuilt:true,outputPostimageBytesBoundToFrozenCandidate:true,sourceCaseLineageAndPolarityResolved:true,historicalOwnerRowsPreserved:462,canonicalApply:'NONE'}
  };
  outputs[branch]=ledger;
  write(ledgerRefs[branch],ledger);
}

const schema={
  $schema:'https://json-schema.org/draft/2020-12/schema',
  $id:'media.pdp0.root-selected-source-integration-allowed-operations.v1.candidate',
  title:'Candidate schema for root-selected PDP-0 source postimage operations',
  description:'Candidate-only schema. It is not registered or self-admitted; authentic source-owner and root decisions plus independent review are required before any use for canonical source adoption.',
  type:'object',additionalProperties:false,required:['schemaVersion','artifactId','candidateSchemaRef','candidateSchemaStatus','predecessorFreeze','rootMappingDecision','candidateRevision','branch','branchStatus','sourceBaseline','retainedProjection','operations','counts','outputPostimages','validation'],
  properties:{schemaVersion:{const:'media.pdp0.root-selected-source-integration-allowed-operations.v1'},artifactId:{type:'string'},candidateSchemaRef:{type:'string'},candidateSchemaStatus:{const:'NOT_REGISTERED; ROOT_AND_SOURCE_OWNER_ADOPTION_REQUIRED'},predecessorFreeze:{type:'object'},rootMappingDecision:{type:'object'},candidateRevision:{type:'string'},branch:{enum:['core','shared','split']},branchStatus:{type:'string'},sourceBaseline:{type:'object'},retainedProjection:{type:'object'},operations:{type:'array',items:{oneOf:[
    {type:'object',additionalProperties:false,required:['operationId','kind','auditId','capabilityId','record'],properties:{operationId:{type:'string'},kind:{const:'ADD_CAPABILITY_DEFINITION'},auditId:{type:'string'},capabilityId:{type:'string'},record:{type:'object'}}},
    {type:'object',additionalProperties:false,required:['operationId','kind','auditId','requirementId','sourceCapabilityId','sourceCapabilityCaseId','polarity','record'],properties:{operationId:{type:'string'},kind:{const:'APPEND_REQUIREMENT_CASE'},auditId:{type:'string'},requirementId:{type:'string'},sourceCapabilityId:{type:'string'},sourceCapabilityCaseId:{type:'string'},polarity:{enum:['POSITIVE','NEGATIVE']},record:{type:'object'}}},
    {type:'object',additionalProperties:false,required:['operationId','kind','auditId','capabilityId','requirementId'],properties:{operationId:{type:'string'},kind:{const:'APPEND_REQUIREMENT_CAPABILITY_BINDING'},auditId:{type:'string'},capabilityId:{type:'string'},requirementId:{type:'string'}}},
    {type:'object',additionalProperties:false,required:['operationId','kind','auditId','patch'],properties:{operationId:{type:'string'},kind:{const:'PATCH_CROSSWALK_TRACE'},auditId:{type:'string'},patch:{type:'object',additionalProperties:false,required:['pdp0EvidenceRefs','rootDirectedSourceCandidate','proposedPdp0SourceChange'],properties:{pdp0EvidenceRefs:{type:'array',items:{type:'string'}},rootDirectedSourceCandidate:{type:'object'},proposedPdp0SourceChange:{type:'object'}}}}}
  ]}},counts:{type:'object'},outputPostimages:{type:'array'},validation:{type:'object'}}
};
write(schemaRef,schema);
const bundleRef = `${folder}/media-pdp0-root-selected-source-integration-r8.successor-bundle.candidate.v1.json`;
const verificationRef = `${folder}/media-pdp0-root-selected-source-integration-r8.rebuild-verification.candidate.v1.json`;
const proposalRef = `${folder}/media-pdp0-root-selected-source-integration-r8.source-adoption-cas-proposal.candidate.v1.json`;
const decisionTemplateRefs = {
  sourceOwner:`${folder}/media-pdp0-root-selected-source-integration-r8.source-owner-decision.template.v1.json`,
  rootAdoption:`${folder}/media-pdp0-root-selected-source-integration-r8.root-adoption-decision.template.v1.json`,
  applyAuthorization:`${folder}/media-pdp0-root-selected-source-integration-r8.apply-authorization.template.v1.json`,
};
const bundle={schemaVersion:'media.pdp0.root-selected-source-integration-successor-bundle.v1',candidateRevision:'R8',status:'CANDIDATE_ONLY_NOT_FROZEN_NOT_REGISTERED',predecessor:{ref:freezeRef,sha256:sha256R7(read(freezeRef))},actualRootMappingDecision:{ref:rootDecisionRef,sha256:rootDecisionSha256,optionId:'B_SPLIT_BY_OPERATION_SCOPE'},selectedBranch:'split',branches:Object.fromEntries(Object.entries(r8Branches).map(([branch,rows])=>[branch,rows.map(row=>({...row,bytes:fs.statSync(path.resolve(root,row.postimageRef)).size}))])),ledgers:ledgerRefs,schemaCandidate:schemaRef,canonicalApply:'NONE'};
write(bundleRef,bundle);
const verification={schemaVersion:'media.pdp0.root-selected-source-integration-r8-rebuild-verification.v1',status:'PREPARATION_PASS_CANDIDATE_ONLY',bundleRef,bundleSha256:sha256R7(read(bundleRef)),current7Baseline:{ref:baselineRef,sha256:sha256R7(read(baselineRef)),allSevenPreimagesCurrent:true,preimages:targets.map(row=>({targetRef:row.targetRef,sha256:row.sha256}))},retainedProjection:{ref:projectionRef,sha256:sha256R7(read(projectionRef)),operationCount:projection.operations.length},branches:Object.fromEntries(Object.entries(outputs).map(([branch,ledger])=>[branch,{ledgerRef:ledgerRefs[branch],ledgerSha256:sha256R7(read(ledgerRefs[branch])),...ledger.counts,rebuildSemanticallyMatchesFrozenPostimages:ledger.validation.allFrozenPostimageSemanticsRebuilt,allParentCaseLineageAndPolarityResolved:ledger.validation.sourceCaseLineageAndPolarityResolved,ownerRowsPreserved:ledger.validation.historicalOwnerRowsPreserved}])),rootDecisionRef,rootDecisionSha256,sourceOwnerAdoption:'NOT_SET',schemaRegistration:'NOT_SET',independentFinalPeerReview:'PENDING',canonicalApply:'NONE'};
write(verificationRef,verification);
const selectedLedger=outputs.split;
const proposal={schemaVersion:'media.pdp0.root-selected-source-integration-source-adoption-cas-proposal.v1',proposalId:'MEDIA-PDP0-ROOT-SELECTED-SOURCE-INTEGRATION-R8-SPLIT-ADOPTION-PROPOSAL-2026-10-23',stage:'DISCOVERY',phase:'PDP-0',campaignDenominator:{physicalCompositeSurfaces:54,phaseCells:216,historicalOwnerRows:462},decisionChain:{actualMappingDecision:{ref:rootDecisionRef,sha256:rootDecisionSha256,selectedOptionId:'B_SPLIT_BY_OPERATION_SCOPE'},sourceOwnerDecision:{ref:decisionTemplateRefs.sourceOwner,status:'NOT_SET'},rootAdoptionDecision:{ref:decisionTemplateRefs.rootAdoption,status:'NOT_SET'},applyAuthorization:{ref:decisionTemplateRefs.applyAuthorization,status:'NOT_SET'},independentFinalPeerReview:{status:'PENDING'}},candidate:{bundleRef,bundleSha256:sha256R7(read(bundleRef)),verificationRef,verificationSha256:sha256R7(read(verificationRef)),candidateSchemaRef:schemaRef,candidateSchemaSha256:sha256R7(read(schemaRef)),schemaRegistration:'NOT_REGISTERED_PENDING_AUTHORIZED_REGISTRATION',selectedAllowedOperationsRef:ledgerRefs.split,selectedAllowedOperationsSha256:sha256R7(read(ledgerRefs.split)),selectedBranch:'split'},sourceTransaction:{current7Preimages:targets.map(row=>({targetRef:row.targetRef,sha256:row.sha256})),writeTargets:selectedLedger.outputPostimages.map(row=>({targetRef:row.targetRef,preimageSha256:targets.find(pin=>pin.targetRef===row.targetRef).sha256,postimageRef:row.postimageRef,postimageSha256:row.postimageSha256})),readOnlyGuards:targets.filter(row=>!selectedLedger.outputPostimages.some(target=>target.targetRef===row.targetRef)),leafReviewByteIdentical:true,decisionLogWrite:'NONE_IN_PROPOSAL',selectedOperations:selectedLedger.operations.map(op=>({operationId:op.operationId,kind:op.kind,auditId:op.auditId,requirementId:op.requirementId??null,capabilityId:op.capabilityId??null,sourceCapabilityCaseId:op.sourceCapabilityCaseId??null,polarity:op.polarity??null})),retainedProjectionOperationCount:projection.operations.length,ownerAdjudicationMutations:0,trustReconstructionMutations:0},alternatives:{shared:{status:'PRESERVED_AS_SEPARATE_UNSELECTED_HISTORY',ledgerRef:ledgerRefs.shared,postimages:r8Branches.shared},preRootSelection:{freezeRef,freezeSha256:sha256R7(read(freezeRef))}},executionGate:{proposalExecutableNow:false,blockedUntil:['candidate schema and allowed operations are adopted/registered under actual repository authority','source-owner decision template is completed by authorized source owner and references actual decision-log evidence','fresh H independent peer review passes against this exact bundle and proposal','root adoption decision is completed by root authority','distinct exact-input apply authorization is recorded if canonical apply is later requested'],canonicalApply:'NONE',phaseStatusChanged:false,discoveryStatus:'UNKNOWN_PENDING_SOURCE_CURRENTNESS_RECONCILIATION'},nextAction:'Obtain final H peer review for this exact R8 bundle/proposal; then route the candidate to the actual source owner and root decision authority. This artifact does not execute writes.'};
const unsetTemplate=(templateType,requiredFields)=>({schemaVersion:'media.pdp0.root-selected-source-integration-decision-template.v1',templateType,candidateBundleRef:bundleRef,candidateBundleSha256:sha256R7(read(bundleRef)),selectedAllowedOperationsRef:ledgerRefs.split,requiredFields,decisionStatus:'NOT_SET',decisionLogEvidenceRef:null,decisionLogEvidenceSha256:null,deciderIdentity:null,decidedAt:null,canonicalApplyAuthorized:false,phaseStatusChanged:false});
write(decisionTemplateRefs.sourceOwner,unsetTemplate('SOURCE_OWNER_ADOPTION_DECISION',['authorized source owner identity','specific source-owned meaning decision for all four targets','actual decision-log evidence reference and section hash','adopt candidate schema and allowed operations or precise refusal/revision','explicit no-apply statement']));
write(decisionTemplateRefs.rootAdoption,unsetTemplate('ROOT_ADOPTION_DECISION',['root authority identity','accept or reject the source-owner decision and exact R8 candidate bundle hash','actual decision-log evidence reference and section hash','explicit selected branch split','explicit canonical apply not authorized by this decision']));
write(decisionTemplateRefs.applyAuthorization,unsetTemplate('CANONICAL_SOURCE_APPLY_AUTHORIZATION',['distinct authorized apply authority','exact proposal and decision artifact hashes','seven exact current preimage hashes and four exact postimage hashes','registered schema and allowed-operation versions','fresh independent peer-review artifact hash','explicit target allowlist and decision-log evidence']));
write(proposalRef,proposal);
console.log(JSON.stringify({schemaRef,ledgers:ledgerRefs,counts:Object.fromEntries(Object.entries(outputs).map(([key,value])=>[key,value.counts])),canonicalApply:'NONE'},null,2));
