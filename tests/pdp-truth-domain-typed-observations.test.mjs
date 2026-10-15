import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { typedObservationRequestFingerprint, validateRetryPolicyCurrentRead } from "../scripts/lib/pdp-truth-domain-observation-currentness.mjs";

const root=resolve(new URL("..",import.meta.url).pathname);
const requireTools=createRequire(resolve(root,"../ghatana-tools/package.json"));
const parse=requireTools("yaml").parse;
const Ajv2020=requireTools("ajv/dist/2020").default;
const ajv=new Ajv2020({allErrors:true,strict:false,validateFormats:false});
const operationSourceBytes=readFileSync(resolve(root,".product-experience/pdp-1-domain-data/operations.yaml"));
const operations=parse(operationSourceBytes.toString("utf8"));
const operationSourceReview=JSON.parse(readFileSync(resolve(root,".product-experience/pdp-1-domain-data/operations-current-source-review.json"),"utf8"));
const semanticReview=JSON.parse(readFileSync(resolve(root,"docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json"),"utf8"));
const contracts=operations.ownerTypedObservationContracts;
const rules=operations.ownerTypedObservationValidationRules;
const byId=new Map(contracts.records.map(row=>[row.id,row]));
const validationByContractId=new Map(rules.records.map(row=>[row.observationContractRef.split("@id=").at(-1),row]));
const scalarTypes=new Set(Object.keys(operations.capabilityOperationContracts.scalarTypes));
const operationIds=new Set([
  ...operations.operations.map(row=>row.id),
  ...operations.individualOperationContracts.records.map(row=>row.operationId??row.id),
  ...operations.ownerDefinedOperationContracts.records.map(row=>row.operationId??row.id),
  ...operations.capabilityOperationContracts.records.flatMap(row=>row.operationRefs),
]);
function schemaWalk(schema,path){
  if(!schema||typeof schema!=="object")return;
  if(schema.type==="object"){
    assert.equal(schema.additionalProperties,false,`${path} is closed`);
    for(const field of schema.required??[])assert.ok(Object.hasOwn(schema.properties??{},field),`${path}.${field} required and declared`);
    for(const [key,value]of Object.entries(schema.properties??{}))schemaWalk(value,`${path}.${key}`);
  }
  if(schema.type==="array")schemaWalk(schema.items,`${path}[]`);
  for(const [index,variant]of (schema.oneOf??[]).entries())schemaWalk(variant,`${path}.oneOf[${index}]`);
  // allOf/if/then fragments are intentionally partial overlays on the closed
  // result object. Their complete base object is checked above; traversing an
  // overlay as a standalone object would wrongly require it to close fields
  // declared by sibling/base schemas.
}
function validateSchema(schema,value){
  return ajv.compile(schema)(value);
}
function pointerValue(rootValue,pointer){
  return pointer.replace(/^\$\.?/u,"").replace(/\[(\d+)\]/gu,".$1").split(".").filter(Boolean).reduce((value,key)=>value?.[key],rootValue);
}
function setPointerValue(rootValue,pointer,nextValue){
  const path=pointer.replace(/^\$\.?/u,"").replace(/\[(\d+)\]/gu,".$1").split(".").filter(Boolean);
  const leaf=path.pop();
  const parent=path.reduce((value,key)=>value[key],rootValue);
  parent[leaf]=nextValue;
}
function assertExactBindings(contract,request,result){
  for(const binding of contract.bindingRules){
    const left=pointerValue({request,result},binding.leftRef);
    const right=pointerValue({request,result},binding.rightRef);
    if(binding.operator==="EXACT_EQUAL")assert.deepEqual(left,right,binding.id);
    if(binding.operator==="EXACT_SET_EQUAL"&&Array.isArray(left)&&Array.isArray(right)){
      assert.deepEqual([...new Set(left)].sort(),[...new Set(right)].sort(),binding.id);
    }
  }
}
function fixtureCurrentRead(contract,request,observation,overrides={}){
  return {
    tenantScopeRef:"tenant-fixture",
    principalRef:"principal-fixture",
    queryId:request.queryId,
    operationRef:request.operationRef,
    requestFingerprint:`sha256:${"a".repeat(64)}`,
    readAuthorityRef:contract.readAuthorityRefs[0],
    currentness:"CURRENT",
    observedAt:"2026-10-13T12:00:00Z",
    readVersion:"read-version-fixture",
    observationStatus:"OBSERVED",
    accessDisposition:"FULL",
    observation,
    ...overrides,
  };
}
function schemaSample(schema){
  if(Object.hasOwn(schema??{},"const"))return schema.const;
  if(schema?.enum?.length)return schema.enum[0];
  if(schema?.oneOf?.length)return schemaSample(schema.oneOf[0]);
  if(schema?.type==="object")return Object.fromEntries((schema.required??[]).map(field=>[field,schemaSample(schema.properties?.[field]??{})]));
  if(schema?.type==="array")return Array.from({length:schema.minItems??0},()=>schemaSample(schema.items??{}));
  if(schema?.pattern?.includes("sha256:"))return `sha256:${"a".repeat(64)}`;
  if(schema?.type==="integer")return schema.minimum??0;
  if(schema?.type==="number")return schema.minimum??0;
  if(schema?.type==="boolean")return false;
  if(schema?.type==="string")return "fixture-value";
  return {};
}

test("current PDP-1 semantic review binds the exact owner typed observation delta without claiming admission",()=>{
  const sha256=createHash("sha256").update(operationSourceBytes).digest("hex");
  const delta=operationSourceReview.currentSourceCutDeltaReview.supplementalPdp1DefinitionDelta;
  const expectedIds=[
    "media.observation-contract.delegated-integration-result-context.v1",
    "media.observation-contract.destination-delivery-acknowledgment.v1",
    "media.observation-contract.effective-processing-constraints.v1",
    "media.observation-contract.job-status-seven-dimension.v1",
    "media.observation-contract.output-preview-version-lineage.v1",
    "media.observation-contract.processing-parameter-read.v1",
    "media.observation-contract.rights-decision.v1",
    "media.observation-contract.transcript-submission-lineage.v1",
  ];
  const expectedProposalOperationIds=[
    "media.operation.artifact-ingest",
    "media.operation.job-lifecycle",
    "media.operation.transcription",
    "media.operation.transcription-submission",
    "media.operation.transcript-version-read",
    "media.operation.caption-draft-write",
    "media.operation.caption-version-write",
    "media.operation.caption-version-read",
    "media.operation.synthesis",
    "media.operation.vision-analysis",
    "media.operation.multimodal-analysis",
    "media.operation.stream-session",
    "media.operation.consent",
    "media.operation.health-capability",
  ];
  assert.equal(operationSourceReview.currentSourceSha256,sha256);
  assert.match(operations.scopeStatus,/^proposal-only;/u);
  assert.equal(operations.operations.length,14);
  assert.deepEqual(operations.operations.map(record=>record.id),expectedProposalOperationIds);
  assert.equal(delta.status,"REVIEWED_CURRENT_SOURCE_SEMANTIC_DELTA");
  assert.equal(delta.predecessorSourceSha256,"11d51ef9cdc69e2dde09b3a72241a19a321be40372b19850e4d29c3ec2fb3e04");
  assert.equal(delta.currentSourceSha256,sha256);
  assert.match(delta.reviewAuthority,/explicit user delegation/u);
  assert.match(delta.reviewAuthority,/not a human owner signature/u);
  assert.deepEqual(delta.reviewedRecords.map(record=>record.id).sort(),expectedIds);
  for(const record of delta.reviewedRecords){
    const contract=byId.get(record.id);
    const validation=validationByContractId.get(record.id);
    assert.ok(contract,`${record.id} resolves to the exact current owner typed query`);
    assert.ok(validation,`${record.id} resolves to its exact validator`);
    assert.equal(contract.operationKind,"QUERY");
    assert.deepEqual(record.operationRefs,contract.operationRefs);
    assert.equal(record.bindingStatus,contract.bindingStatus);
    assert.equal(record.validationRuleId,validation.id);
    assert.equal(record.selector,`.product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=${record.id}`);
    assert.equal(record.validationSelector,`.product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationValidationRules/records/@id=${validation.id}`);
    assert.ok(record.meaning.length>40);
  }
  const reviewedOperations=delta.reviewedOperationRecords;
  assert.deepEqual(reviewedOperations.map(record=>record.id).sort(),[
    "media.operation.capability.media-speech-synthesis-dub",
    "media.operation.fallback-selection.confirm.v1",
  ]);
  const reviewedOperationById=new Map(reviewedOperations.map(record=>[record.id,record]));
  const decisionLog=readFileSync(resolve(root,".product-experience/decision-log.md"),"utf8");
  const pxd163=decisionLog.slice(decisionLog.indexOf("### PXD-163"),decisionLog.indexOf("\n### ",decisionLog.indexOf("### PXD-163")+1));
  assert.match(pxd163,/C16 \/ J16:[\s\S]*candidate output reference[\s\S]*not an immutable artifact version/iu);
  assert.match(pxd163,/C27 \/ J27:[\s\S]*current positive candidate-specific rights\/license\/quality\/resource observations[\s\S]*explicit confirmation/iu);
  const dubbing=operations.capabilityOperationContracts.records.find(record=>record.id==="media.operation.capability.media-speech-synthesis-dub");
  const fallback=operations.ownerDefinedOperationContracts.records.find(record=>record.id==="media.operation.fallback-selection.confirm.v1");
  const expectedOperationReview=[
    {
      id:dubbing.id,
      selector:`.product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/records/@id=${dubbing.id}`,
      source:dubbing,
      bindingIds:dubbing.resultSchema.bindingRules.map(({id})=>id),
    },
    {
      id:fallback.id,
      selector:`.product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=${fallback.id}`,
      source:fallback,
      bindingRuleIds:fallback.bindingRules.map(({id})=>id),
      evidenceJoinRuleIds:fallback.evidenceJoinRules.map(({id})=>id),
      resultBindingIds:fallback.resultBindings.flatMap(({bindings})=>(bindings??[]).map(({id})=>id)),
    },
  ];
  for(const expected of expectedOperationReview){
    const record=reviewedOperationById.get(expected.id);
    assert.equal(record.selector,expected.selector);
    if(record.operationKind!==undefined)assert.equal(record.operationKind,expected.source.operationKind);
    assert.equal(record.decisionRef,".product-experience/decision-log.md#PXD-163");
    if(record.bindingStatus!==undefined)assert.equal(record.bindingStatus,"DEFINITION_ONLY_NO_EXISTING_ENDPOINT_OR_RUNTIME_BINDING");
    for(const field of ["bindingIds","bindingRuleIds","evidenceJoinRuleIds","resultBindingIds"]){
      if(expected[field])assert.deepEqual(record[field],expected[field],`${expected.id} review records exact source-derived ${field}`);
    }
    if(expected.id===fallback.id)assert.ok(record.meaning.length>40);
  }
  assert.equal(dubbing.operationKind,"COMMAND");
  assert.equal(fallback.operationKind,"COMMAND");
  assert.equal(dubbing.admission.executionAdmission,"NOT_ADMITTED");
  assert.match(fallback.scopeStatus,/DEFINITION_ONLY/u);
  assert.equal(delta.preservedBoundaries.runtimeAdmission,"NOT_ADMITTED");
  assert.equal(delta.preservedBoundaries.transportAdmission,"NOT_ADMITTED");
  assert.equal(delta.preservedBoundaries.externalContractOwnerAcceptance,"NOT_CLAIMED");
  assert.equal(delta.preservedBoundaries.independentSpecialistAttestation,"NOT_CLAIMED");
  assert.equal(delta.preservedBoundaries.proposalOperationRecordCount,14);
  const reviewedIdentityIds=semanticReview.reviewedIdentityIds;
  const reviewedIdentitySet=new Set(reviewedIdentityIds);
  const addedFallbackIdentity="operations:media.operation.fallback-selection.confirm.v1";
  const addedC16InputSchemaIdentity="capabilityInputPayloadSchemas:media.typed-input.source-media-with-speech-dub";
  const addedFallbackActionIdentity="uiActions:media.action.confirm-selected-fallback";
  const addedIdentityIds=[addedC16InputSchemaIdentity,addedFallbackIdentity,addedFallbackActionIdentity];
  assert.equal(operations.capabilityOperationContracts.inputPayloadSchemas.length,129);
  assert.equal(semanticReview.reviewDenominators.capabilityInputPayloadSchemas,129);
  assert.equal(semanticReview.populationCoverage.find(({population})=>population==="capabilityInputPayloadSchemas").count,129);
  assert.equal(semanticReview.reviewedPopulationIds.capabilityInputPayloadSchemas.length,129);
  assert.equal(semanticReview.reviewedPopulationIds.capabilityInputPayloadSchemas.includes(addedC16InputSchemaIdentity),true);
  assert.equal(reviewedIdentityIds.length,2026);
  assert.equal(reviewedIdentitySet.size,2026);
  assert.deepEqual(semanticReview.currentCutReview.supplementalDefinitionDeltaReview.newIdentityIds,addedIdentityIds,
    "new identities use exact lexicographic census order");
  assert.deepEqual(addedIdentityIds.map(id=>reviewedIdentityIds.filter(candidate=>candidate===id).length),[1,1,1],
    "the current cut adds exactly the C16 input schema, fallback operation, and fallback action identities");
  const priorReviewedIdentitySet=[...reviewedIdentitySet].filter(id=>!addedIdentityIds.includes(id));
  assert.equal(priorReviewedIdentitySet.length,2023,"all prior reviewed identities remain in the census");
  assert.deepEqual(createHash("sha256").update(JSON.stringify(priorReviewedIdentitySet.sort())).digest("hex"),"842fc763764f09c291d4eb1ec5aba4ca30386e9f0b793ee19334bbd47b055b88");
  assert.deepEqual(createHash("sha256").update(JSON.stringify([...reviewedIdentitySet].sort())).digest("hex"),"a34771e4b2903860a3bb312f5253c6ebee2ec019f01d4ce6a86b6e48e117f4e6");
  assert.equal(semanticReview.outstandingMeaningIds.length,0);
  assert.equal(semanticReview.sourceFingerprints[".product-experience/pdp-1-domain-data/operations.yaml"],sha256);
  assert.equal(semanticReview.sourceFingerprints[".product-experience/pdp-1-domain-data/operations-current-source-review.json"],
    createHash("sha256").update(readFileSync(resolve(root,".product-experience/pdp-1-domain-data/operations-current-source-review.json")).toString()).digest("hex"));
  const sourceReviewTestPath="tests/pdp1-operation-current-source-review.test.mjs";
  assert.equal(semanticReview.sourceFingerprints[sourceReviewTestPath],
    createHash("sha256").update(readFileSync(resolve(root,sourceReviewTestPath))).digest("hex"));
  assert.equal(semanticReview.sourceCutStable,true,"sourceCutStable records current source pins, independently of suite and phase-exit evidence");
  assert.match(semanticReview.currentCutReview.verificationStatus,/^PENDING_FINAL_PDP1_STATUS_AND_PHASE_CURRENTNESS_RECUT:/u,
    "required suite and phase-exit evidence remains pending until the currentness recapture");
  const pxd164Impact=JSON.parse(readFileSync(resolve(root,"docs/implementation/observations/media-discovery-pdp1-pxd164-semantic-repair-impact-2026-10-14-r1.json"),"utf8"));
  assert.equal(semanticReview.currentCutReview.supplementalDefinitionDeltaReview.sourceSha256,
    pxd164Impact.sourcePredecessor.sourceDigests[".product-experience/pdp-1-domain-data/operations.yaml"].replace(/^sha256:/u,""),
    "the earlier supplemental review remains bound to the exact pre-PXD164 operations source");
  assert.equal(semanticReview.currentCutReview.supplementalDefinitionDeltaReview.identitySetChanged,true);
  assert.equal(semanticReview.currentCutReview.supplementalDefinitionDeltaReview.existingIdentityCountPreserved,2023);
  assert.deepEqual(semanticReview.currentCutReview.supplementalDefinitionDeltaReview.newIdentityIds,addedIdentityIds);
  assert.equal(semanticReview.currentCutReview.supplementalDefinitionDeltaReview.resultingIdentityCount,2026);
  assert.deepEqual(semanticReview.currentCutReview.supplementalDefinitionDeltaReview.reviewedRecordIds.slice().sort(),expectedIds);
});

test("fifteen observation schemas are stable typed query definitions and never imply runtime binding",()=>{
  assert.equal(contracts.records.length,15);
  assert.match(contracts.status,/existing-runtime-binding-NOT_ESTABLISHED/);
  assert.deepEqual([...byId.keys()].sort(),[
    "media.observation-contract.declared-options.v1",
    "media.observation-contract.delegated-integration-result-context.v1",
    "media.observation-contract.destination-delivery-acknowledgment.v1",
    "media.observation-contract.effective-processing-constraints.v1",
    "media.observation-contract.job-status-seven-dimension.v1",
    "media.observation-contract.language-uncertainty.v1",
    "media.observation-contract.output-preview-version-lineage.v1",
    "media.observation-contract.processing-parameter-read.v1",
    "media.observation-contract.profile-qualification.v1",
    "media.observation-contract.provenance-completeness.v1",
    "media.observation-contract.quality-action-plan.v1",
    "media.observation-contract.quality-evidence.v1",
    "media.observation-contract.retry-policy-current-read.v1",
    "media.observation-contract.rights-decision.v1",
    "media.observation-contract.transcript-submission-lineage.v1",
  ]);
  for(const record of contracts.records){
    assert.ok(record.operationRefs.length);
    assert.ok(record.operationRefs.every(ref=>operationIds.has(ref)),`${record.id} refs resolve exact existing operation identifiers`);
    assert.equal(record.operationKind,"QUERY");
    assert.match(record.bindingStatus,/DEFINITION_ONLY|ADDITIVE_DEFINITION_ONLY/);
    assert.ok(record.readAuthorityRefs.length>0,`${record.id} declares an exact read authority allowlist`);
    schemaWalk(record.requestSchema,`${record.id}.request`);
    schemaWalk(record.resultSchema,`${record.id}.result`);
    for(const schema of [record.requestSchema,record.resultSchema]){
      const encoded=JSON.stringify(schema);
      for(const match of encoded.matchAll(/"scalarTypeRef":"([^"]+)"/g)){
        const type=match[1].split("/").at(-1);
        assert.ok(scalarTypes.has(type),`${record.id} scalar ${type} resolves`);
      }
      assert.equal(Object.hasOwn(schema.properties??{},"tenantId"),false,`${record.id} caller cannot override host tenant`);
      assert.equal(Object.hasOwn(schema.properties??{},"principalId"),false,`${record.id} caller cannot override host principal`);
    }
    for(const field of ["tenantScopeRef","principalRef"]){
      assert.equal(Object.hasOwn(record.requestSchema.properties??{},field),false,`${record.id} caller cannot supply trusted ${field}`);
      assert.ok(record.resultSchema.required.includes(field),`${record.id} result binds trusted ${field}`);
      assert.ok(Object.hasOwn(record.resultSchema.properties??{},field),`${record.id} result declares trusted ${field}`);
    }
    assert.ok(record.requestSchema.required.includes("queryId"),`${record.id} request has explicit correlation identity`);
    for(const field of ["queryId","operationRef","requestFingerprint","readAuthorityRef","currentness","readVersion"]){
      assert.ok(record.resultSchema.required.includes(field),`${record.id} result binds current read field ${field}`);
      assert.ok(Object.hasOwn(record.resultSchema.properties,field),`${record.id} result declares ${field}`);
    }
    assert.deepEqual(record.resultSchema.properties.readAuthorityRef.enum,record.readAuthorityRefs,`${record.id} result is restricted to its exact read-authority allowlist`);
    const expectedResultOperationRefs=record.id==="media.observation-contract.destination-delivery-acknowledgment.v1"
      ? ["media.operation.action.reconcile-delivery-acknowledgment"] : record.operationRefs;
    assert.deepEqual(record.resultSchema.properties.operationRef.enum,expectedResultOperationRefs,`${record.id} result is restricted to exact operation identities`);
  }
  assert.deepEqual(contracts.trustedContext.requiredHostFacts,["tenantId","principalId","expectedOperationRef","expectedReadAuthorityRef","expectedReadVersion"]);
  assert.match(rules.commonCurrentReadValidation.join(" "),/exactly echoes request queryId/u);
  assert.match(rules.commonCurrentReadValidation.join(" "),/expectedReadAuthorityRef/u);
  assert.match(rules.commonCurrentReadValidation.join(" "),/expectedReadVersion/u);
});

test("raw rights, quality, profile and provenance observations retain their fail-closed material predicates",()=>{
  const validation=new Map(rules.records.map(row=>[row.observationContractRef,row]));
  assert.equal(validation.size,15);
  assert.equal(rules.records.length,15, "each observation contract has exactly one unique validator");
  assert.deepEqual([...new Set(rules.records.map(row=>row.id))].sort(),[
    "media.observation-validation.declared-options.v1",
    "media.observation-validation.delegated-integration-result-context.v1",
    "media.observation-validation.destination-delivery-acknowledgment.v1",
    "media.observation-validation.effective-processing-constraints.v1",
    "media.observation-validation.job-status-seven-dimension.v1",
    "media.observation-validation.language-uncertainty.v1",
    "media.observation-validation.output-preview-version-lineage.v1",
    "media.observation-validation.processing-parameter-read.v1",
    "media.observation-validation.profile-qualification.v1",
    "media.observation-validation.provenance-completeness.v1",
    "media.observation-validation.quality-action-plan.v1",
    "media.observation-validation.quality-evidence.v1",
    "media.observation-validation.retry-policy-current-read.v1",
    "media.observation-validation.rights-decision.v1",
    "media.observation-validation.transcript-submission-lineage.v1",
  ]);
  assert.deepEqual(rules.records.map(row=>row.observationContractRef).sort(),[...byId.keys()].sort(),"every observation contract has exactly one validator");
  const rights=byId.get("media.observation-contract.rights-decision.v1");
  assert.ok(rights.operationRefs.includes("media.operation.action.inspect-voice-authorization"),"voice authorization query is explicitly allowlisted by the rights-decision observation");
  const selectedVoiceProfileVersion=key=>/selected.*voice.*profile.*version|voice.*profile.*version/i.test(key);
  const requestVoiceProfileVersion=Object.keys(rights.requestSchema.properties).find(selectedVoiceProfileVersion);
  const resultVoiceProfileVersion=Object.keys(rights.resultSchema.properties.decision.properties).find(selectedVoiceProfileVersion);
  assert.ok(requestVoiceProfileVersion,"rights request binds the exact selected voice-profile version");
  assert.equal(rights.requestSchema.required.includes(requestVoiceProfileVersion),false,"voice-profile version is not required for general rights, consent, or approval queries");
  const voiceRequestBranch=rights.requestSchema.allOf?.find(branch=>branch.if?.properties?.decisionKind?.const==="VOICE_AUTHORIZATION");
  assert.ok(voiceRequestBranch,"voice-profile requirement is conditional on a VOICE_AUTHORIZATION request");
  assert.ok(voiceRequestBranch.then?.required?.includes(requestVoiceProfileVersion),"VOICE_AUTHORIZATION requires the selected voice-profile version");
  assert.ok(resultVoiceProfileVersion,"rights decision binds the exact selected voice-profile version");
  assert.equal(rights.resultSchema.properties.decision.required.includes(resultVoiceProfileVersion),false,"voice-profile version is not unconditionally required on non-voice decisions");
  const rightsPredicates=JSON.stringify(validation.get(rights.id).predicates);
  assert.match(rightsPredicates,/VOICE_AUTHORIZATION[\s\S]*?voice.{0,30}profile.{0,30}version|VOICE_AUTHORIZATION[\s\S]*?profile.{0,30}version.{0,30}voice/iu,"rights validation conditionally requires the selected voice-profile version");
  assert.match(rightsPredicates,/exact(ly)?[\s\S]*?voice.{0,30}profile.{0,30}version|voice.{0,30}profile.{0,30}version[\s\S]*?exact(ly)?/iu,"rights validation binds the exact selected voice-profile version in the decision");
  assert.deepEqual([...rights.requestSchema.required].sort(),["queryId","subjectArtifactVersionRef","decisionKind","purposeRef","useRef","regionRef","retentionPolicyRef"].sort());
  assert.ok(rights.resultSchema.properties.observationStatus.enum.includes("UNKNOWN"));
  for(const state of ["REVIEW_REQUIRED","APPROVAL_REQUIRED","CONSENT_REQUIRED","VOICE_AUTHORIZATION_REQUIRED"])assert.ok(rights.resultSchema.properties.observationStatus.enum.includes(state));
  assert.ok(rights.resultSchema.properties.decision.properties.effectDisposition.enum.includes("PENDING_REVIEW"));
  assert.match(JSON.stringify(validation.get(rights.id).predicates),/decision absent/);
  for(const expected of [
    ["RIGHTS","DENIED","DENIED"],["RIGHTS","RESTRICTED","RESTRICTED"],["CONSENT","CONSENT_REQUIRED","CONSENT_REQUIRED"],
  ])assert.ok(rights.decisionKindStateMapping.some(({decisionKind,observationStatus,effectDisposition})=>
    JSON.stringify([decisionKind,observationStatus,effectDisposition])===JSON.stringify(expected)));
  assert.ok(rights.decisionKindStateMapping.some((row) => row.decisionKind === "HUMAN_REVIEW_APPROVAL" && row.observationStatus === "EXPIRED" && row.effectDisposition === "EXPIRED"));
  const rightsBranches=rights.resultSchema.allOf;
  assert.ok(rightsBranches.some(branch=>branch.if?.properties?.observationStatus?.const==="DENIED"&&branch.then?.properties?.decisionKind?.const==="RIGHTS"&&branch.then?.properties?.decision?.properties?.effectDisposition?.const==="DENIED"));
  assert.ok(rightsBranches.some(branch=>branch.if?.properties?.observationStatus?.const==="RESTRICTED"&&branch.then?.properties?.decision?.properties?.effectDisposition?.const==="RESTRICTED"));
  assert.ok(rightsBranches.some(branch=>branch.if?.properties?.observationStatus?.const==="CONSENT_REQUIRED"&&branch.then?.properties?.decisionKind?.const==="CONSENT"));
  assert.ok(rightsBranches.some(branch=>branch.if?.properties?.observationStatus?.const==="EXPIRED"&&branch.if?.properties?.decisionKind?.const==="HUMAN_REVIEW_APPROVAL"&&branch.then?.properties?.decision?.properties?.effectDisposition?.const==="EXPIRED"));
  const quality=byId.get("media.observation-contract.quality-evidence.v1");
  assert.ok(quality.resultSchema.properties.observations.items.properties.evidenceRefs);
  assert.ok(validation.get(quality.id).predicates.some(x=>x.when.includes("NO_OBSERVATIONS")&&x.require.includes("observations is empty")));
  const itemRules=quality.resultSchema.allOf.find(rule=>rule.properties?.observations)?.properties.observations.items.allOf;
  assert.ok(itemRules.some(rule=>rule.if?.properties?.disposition?.enum?.includes("PASS")&&rule.then?.properties?.applicability?.const==="APPLICABLE"&&rule.then?.properties?.value?.not?.type==="null"));
  assert.ok(itemRules.some(rule=>rule.if?.properties?.value?.type==="number"&&rule.then?.required?.includes("unitRef")));
  assert.ok(itemRules.some(rule=>rule.if?.properties?.applicability?.enum?.includes("NOT_APPLICABLE")&&rule.then?.properties?.disposition?.enum?.includes("INDETERMINATE")));
  const profile=byId.get("media.observation-contract.profile-qualification.v1");
  assert.ok(profile.resultSchema.properties.qualificationStatus.enum.includes("IMPLEMENTED_UNQUALIFIED"));
  assert.match(JSON.stringify(validation.get(profile.id).predicates),/never reuse qualification across scope/);
  const provenance=byId.get("media.observation-contract.provenance-completeness.v1");
  assert.deepEqual(provenance.resultSchema.properties.completeness.enum.includes("UNKNOWN"),true);
  assert.ok(validation.get(provenance.id).predicates.some(x=>JSON.stringify(x).includes("accessDisposition == FULL")));
});

test("delivery acknowledgment, delegated result, parameter and constraint reads stay exact and fail closed",()=>{
  const validation=new Map(rules.records.map(row=>[row.observationContractRef,row]));
  const delivery=byId.get("media.observation-contract.destination-delivery-acknowledgment.v1");
  const deliveryObservation=delivery.resultSchema.properties.observation;
  const deliveryFields=deliveryObservation.properties;
  assert.ok(delivery.resultSchema.required.includes("observation"));
  for(const field of ["originalRequestId","originalRequestFingerprint","artifactVersionRef","destinationRef","acknowledgmentStatus"]){
    assert.ok(deliveryObservation.required.includes(field),`delivery observation binds ${field}`);
    assert.ok(Object.hasOwn(deliveryFields,field),`delivery observation declares ${field}`);
  }
  assert.ok(deliveryObservation.required.includes("observedAt"));
  assert.ok(deliveryFields.evidenceRefs,"delivery observation carries source evidence references");
  assert.ok(deliveryFields.acknowledgmentStatus.enum.includes("UNKNOWN"));
  assert.ok(deliveryFields.acknowledgmentStatus.enum.includes("ACKNOWLEDGED"));
  assert.notEqual(deliveryFields.acknowledgmentStatus.enum.indexOf("UNKNOWN"),deliveryFields.acknowledgmentStatus.enum.indexOf("ACKNOWLEDGED"));
  assert.match(JSON.stringify(validation.get(delivery.id).predicates),/UNKNOWN[\s\S]*?(cannot|never|no)[\s\S]*?(success|acknowledg)/iu);
  assert.match(JSON.stringify(validation.get(delivery.id).predicates),/originalRequestFingerprint[\s\S]*?artifactVersionRef[\s\S]*?destinationRef/iu);

  const integration=byId.get("media.observation-contract.delegated-integration-result-context.v1");
  const integrationObservation=integration.resultSchema.properties.observation;
  const integrationFields=integrationObservation.properties;
  assert.ok(integration.resultSchema.required.includes("observation"));
  const integrationRequired=integrationObservation.required.join(" ");
  for(const semantic of [/original.*request/i,/fingerprint/i])assert.match(integrationRequired,semantic,"delegated context binds the original request identity");
  for(const semantic of [/delegat/i,/purpose/i,/budget/i,/deadline/i])assert.ok(Object.keys(integrationFields).some(field=>semantic.test(field)),`delegated context declares ${semantic}`,"trusted delegated references are conditional on returned context");
  assert.ok(Object.keys(integrationFields).some(field=>/budget/i.test(field)&&/ref/i.test(field)),"delegated context preserves an opaque budget reference");
  assert.ok(Object.keys(integrationFields).some(field=>/deadline/i.test(field)&&/ref/i.test(field)),"delegated context preserves an opaque deadline reference");
  assert.ok(Object.keys(integrationFields).every(field=>!/(numeric|threshold|recursionDepth)/i.test(field)),"delegated context adds no numeric policy or recursion depth");
  assert.match(JSON.stringify(integrationObservation),/recursive[^"]*(false|disallowed|prohibited)|(?:false|disallowed|prohibited)[^"]*recursive/iu);
  assert.match(JSON.stringify(validation.get(integration.id).predicates),/originalRequestFingerprint[\s\S]*?delegationRef[\s\S]*?purposeRef/iu);
  assert.match(JSON.stringify(integration),/no recursive (tool )?invocation/iu);

  const parameters=byId.get("media.observation-contract.processing-parameter-read.v1");
  const parameterObservation=parameters.resultSchema.properties.observation;
  const parameterItem=parameterObservation.properties.observations.items;
  const parameterRequired=parameterItem.required.join(" ");
  assert.match(parameterRequired,/parameter|measurement/i,"parameter observation identifies the exact parameter or measurement");
  assert.ok(Object.hasOwn(parameterItem.properties,"schemaRef"),"parameter observation can bind its exact schema");
  assert.ok(Object.hasOwn(parameterItem.properties,"value"),"parameter observation can carry a source-validated value");
  assert.ok(Object.keys(parameterItem.properties).some(field=>/version/i.test(field)),"parameter observation identifies the exact parameter or source version");
  assert.match(JSON.stringify(validation.get(parameters.id).predicates),/missing[\s\S]*?(not a (negative|zero|failure)|never a (negative|zero|failure))/iu);
  assert.doesNotMatch(JSON.stringify(parameters),/threshold|minimum|maximum|pass.?fail/iu);

  const constraints=byId.get("media.observation-contract.effective-processing-constraints.v1");
  const constraintObservation=constraints.resultSchema.properties.observation;
  const dimensions=constraintObservation.properties.dimensions;
  assert.deepEqual(new Set(dimensions.items.properties.dimension.enum),new Set(["qualification","license","health","capability","rights","resourceCapacity","costEstimate"]));
  assert.ok(dimensions.items.properties.evidenceRef,"constraint dimensions can carry opaque owner evidence when established");
  assert.ok(dimensions.items.properties.evidenceRef.scalarTypeRef.endsWith("/opaque-versioned-reference"));
  assert.equal(Object.hasOwn(constraintObservation.properties,"eligible"),false);
  assert.equal(Object.hasOwn(constraintObservation.properties,"ready"),false);
  assert.equal(Object.hasOwn(constraintObservation.properties,"eligibility"),false);
  assert.match(JSON.stringify(validation.get(constraints.id).predicates),/UNKNOWN[\s\S]*?(cannot|never)[\s\S]*?(eligible|ready)/iu);
});

test("parameter, constraint, and delegated observations have mutually exclusive status branches",()=>{
  const validation=new Map(rules.records.map(row=>[row.observationContractRef,row]));
  const parameter=byId.get("media.observation-contract.processing-parameter-read.v1");
  const parameterItem=parameter.resultSchema.properties.observation.properties.observations.items;
  const parameterBranches=parameterItem.allOf??[];
  const valueObserved=parameterBranches.find(branch=>branch.if?.properties?.observationStatus?.const==="VALUE_OBSERVED");
  const parameterUnknown=parameterBranches.find(branch=>branch.if?.properties?.observationStatus?.enum?.includes("UNKNOWN"));
  assert.ok(valueObserved&&parameterUnknown,"parameter result defines observed and unknown status branches");
  assert.ok(!parameterItem.required.includes("value"),"value is not required unconditionally for unknown parameter reads");
  assert.ok(valueObserved.then?.required?.includes("value"));
  assert.ok(valueObserved.then?.required?.includes("evidenceRef"));
  assert.ok(valueObserved.then?.not?.required?.includes("unknownReasonRef"),"observed values cannot carry the unknown-only reason branch");
  assert.ok(parameterUnknown.then?.required?.includes("unknownReasonRef"));
  assert.ok(parameterUnknown.then?.not?.required?.includes("evidenceRef"),"unknown and not-found values cannot carry observed evidence");
  const observedValueSchema=valueObserved.then?.properties?.value;
  assert.ok(observedValueSchema,"VALUE_OBSERVED has a status-specific value schema");
  assert.ok(observedValueSchema.not?.type==="null"||observedValueSchema.type&&observedValueSchema.type!=="null"||observedValueSchema.const!==null,"VALUE_OBSERVED excludes a null placeholder");
  const unknownValueSchema=parameterUnknown.then?.properties?.value;
  assert.ok(!unknownValueSchema||unknownValueSchema.type==="null"||unknownValueSchema.const===null,"UNKNOWN/NOT_FOUND permits only an omitted or null value placeholder");

  const constraints=byId.get("media.observation-contract.effective-processing-constraints.v1");
  const dimension=constraints.resultSchema.properties.observation.properties.dimensions.items;
  const dimensionBranches=dimension.allOf??[];
  const unknownDimension=dimensionBranches.find(branch=>branch.if?.properties?.dimensionStatus?.const==="UNKNOWN");
  const notApplicable=dimensionBranches.find(branch=>branch.if?.properties?.dimensionStatus?.const==="NOT_APPLICABLE");
  assert.ok(unknownDimension&&notApplicable,"constraint dimensions distinguish UNKNOWN from NOT_APPLICABLE");
  assert.ok(!dimension.required.includes("evidenceRef"),"UNKNOWN dimensions may omit unavailable evidence");
  assert.ok(unknownDimension.then?.required?.includes("reasonRef"));
  assert.ok(!unknownDimension.then?.required?.includes("evidenceRef"));
  const unknownForbiddenFields=unknownDimension.then?.not?.required??[];
  assert.ok(unknownForbiddenFields.includes("evidenceRef"),"UNKNOWN dimensions cannot claim positive evidence");
  for(const field of ["sourceAuthorityRef","sourceVersionRef","reasonRef"])assert.ok(notApplicable.then?.required?.includes(field),`NOT_APPLICABLE requires ${field}`);

  const integration=byId.get("media.observation-contract.delegated-integration-result-context.v1");
  const context=integration.resultSchema.properties.observation;
  const contextBranches=context.allOf??[];
  const bounded=contextBranches.find(branch=>branch.if?.properties?.contextStatus?.const==="BOUNDED_CONTEXT_RETURNED");
  const contextUnknown=contextBranches.find(branch=>branch.if?.properties?.contextStatus?.const==="UNKNOWN");
  assert.ok(bounded&&contextUnknown,"delegated context distinguishes bounded return from unknown");
  assert.ok(!context.required.includes("delegationRef")&&!context.required.includes("purposeRef")&&!context.required.includes("budgetRef")&&!context.required.includes("deadlineRef")&&!context.required.includes("resultRefs"),"unavailable delegated references are not unconditional requirements");
  for(const field of ["delegationRef","purposeRef","budgetRef","deadlineRef","resultRefs"])assert.ok(bounded.then?.required?.includes(field),`bounded context requires ${field}`);
  assert.ok(contextUnknown.then?.required?.includes("unknownReasonRef"));
  for(const field of ["delegationRef","purposeRef","budgetRef","deadlineRef","resultRefs"])assert.ok(!contextUnknown.then?.required?.includes(field),`unknown context may omit ${field}`);

  const rights=byId.get("media.observation-contract.rights-decision.v1");
  const voiceVersion=Object.keys(rights.requestSchema.properties).find(key=>/voice.*profile.*version/i.test(key));
  const voicePredicate=validation.get(rights.id).predicates.find(row=>/decisionKind\s*==\s*VOICE_AUTHORIZATION/.test(row.when));
  assert.ok(voicePredicate,"voice selector equality is conditional on VOICE_AUTHORIZATION");
  assert.match(voicePredicate.require,new RegExp(`request\\.${voiceVersion} exactly equals result\\.${voiceVersion}`,"iu"),"voice predicate requires exact request-to-result equality");
  assert.match(voicePredicate.require,new RegExp(`exactly equals decision\\.${voiceVersion}`,"iu"),"voice predicate requires exact request-to-returned-decision equality");
});

test("new declared-options and quality-plan queries have explicit positive and negative branches",()=>{
  const validation=new Map(rules.records.map(row=>[row.observationContractRef,row]));
  const declared=byId.get("media.observation-contract.declared-options.v1");
  assert.ok(declared.resultSchema.required.includes("declarationDisposition"));
  assert.deepEqual(declared.resultSchema.properties.declarationDisposition.enum,["DECLARED","NOT_DECLARED","UNKNOWN"]);
  assert.ok(declared.bindingRules.some(rule=>rule.operator==="EXACT_SET_EQUAL"));
  assert.ok(validation.get(declared.id).predicates.some(row=>row.when.includes("NOT_DECLARED")));
  assert.ok(validation.get(declared.id).predicates.some(row=>row.when.includes("UNKNOWN")));

  const actionPlan=byId.get("media.observation-contract.quality-action-plan.v1");
  assert.ok(actionPlan.resultSchema.required.includes("assessmentCoverage"));
  assert.deepEqual(actionPlan.resultSchema.properties.assessmentCoverage.enum,["COMPLETE","PARTIAL","UNKNOWN","NOT_EVALUATED"]);
  assert.equal(actionPlan.resultSchema.properties.assessments.maxItems,2);
  assert.ok(validation.get(actionPlan.id).predicates.some(row=>row.when.includes("coveredKinds exactly equals")&&row.when.includes("empty")));
  assert.ok(validation.get(actionPlan.id).predicates.some(row=>row.when.includes("!= COMPLETE")));
  assert.match(JSON.stringify(actionPlan.resultRules),/No assessment branch dispatches a command/iu);

  const language=byId.get("media.observation-contract.language-uncertainty.v1");
  assert.ok(language.resultSchema.properties.uncertaintyDisposition.enum.includes("UNCERTAIN"));
  assert.ok(language.resultSchema.allOf.some(row=>row.if?.properties?.uncertaintyDisposition?.const==="UNCERTAIN"&&row.then?.required?.includes("evidenceRefs")));
  assert.ok(language.resultSchema.allOf.some(row=>row.if?.properties?.uncertaintyDisposition?.const==="NOT_UNCERTAIN"&&row.then?.required?.includes("observedLanguageTag")));
  assert.match(JSON.stringify(language),/no numeric confidence threshold/iu);
  const retry=byId.get("media.observation-contract.retry-policy-current-read.v1");
  assert.equal(retry.operationKind,"QUERY");
  assert.equal(retry.scopeStatus.includes("NOT_ADMITTED_OR_UNKNOWN"),true);
  assert.equal(retry.resultSchema.properties.observation.oneOf.length,2);
  assert.ok(retry.bindingRules.some(rule=>rule.rightRef==="$.result.observation.jobId"));
  assert.ok(validation.get(retry.id).predicates.some(row=>row.require.includes("retriesRemaining equals maximumExplicitRetries")));
  assert.ok(validation.get(retry.id).predicates.some(row=>row.when.includes("EFFECT_UNKNOWN")));
});

test("transcript submission lineage binds one exact accepted request and keeps UNKNOWN sparse",()=>{
  const contract=byId.get("media.observation-contract.transcript-submission-lineage.v1");
  const validation=validationByContractId.get(contract.id);
  const request={
    queryId:"query-transcript-fixture",
    operationRef:"media.operation.transcript-version-read",
    acceptedRequestId:"accepted-request-17",
    acceptedRequestFingerprint:`sha256:${"b".repeat(64)}`,
    jobId:"job-17",
    sourceArtifactId:"artifact-source-4",
    sourceArtifactVersionRef:"artifact-source-4@version-9",
    sourceDigest:`sha256:${"c".repeat(64)}`,
    transcriptVersionRef:"transcript-17@version-3",
  };
  const observation={
    lineageStatus:"EXACT_TRANSCRIPT_VERSION_LINKED",
    acceptedRequestId:request.acceptedRequestId,
    acceptedRequestFingerprint:request.acceptedRequestFingerprint,
    jobId:request.jobId,
    sourceArtifactId:request.sourceArtifactId,
    sourceArtifactVersionRef:request.sourceArtifactVersionRef,
    sourceDigest:request.sourceDigest,
    transcriptVersionRef:request.transcriptVersionRef,
    transcriptDigest:`sha256:${"d".repeat(64)}`,
  };
  const result=fixtureCurrentRead(contract,request,observation);
  assert.match(contract.requestSchema.properties.acceptedRequestFingerprint.pattern,/^\^sha256:/u);
  assert.match(contract.requestSchema.properties.sourceDigest.pattern,/^\^sha256:/u);
  assert.match(contract.resultSchema.properties.observation.properties.acceptedRequestFingerprint.pattern,/^\^sha256:/u);
  assert.match(contract.resultSchema.properties.observation.properties.transcriptDigest.pattern,/^\^sha256:/u);
  assert.equal(validateSchema(contract.requestSchema,request),true);
  assert.equal(validateSchema(contract.resultSchema,result),true);
  assertExactBindings(contract,request,result);

  const mismatchedSource=structuredClone(result);
  mismatchedSource.observation.sourceArtifactVersionRef="artifact-source-4@version-10";
  assert.throws(()=>assertExactBindings(contract,request,mismatchedSource),/transcript-submission-lineage\.source-artifact-version/u);
  const mismatchedFingerprint=structuredClone(result);
  mismatchedFingerprint.observation.acceptedRequestFingerprint=`sha256:${"e".repeat(64)}`;
  assert.throws(()=>assertExactBindings(contract,request,mismatchedFingerprint),/transcript-submission-lineage\.accepted-request-fingerprint/u);

  const unknown=fixtureCurrentRead(contract,request,{lineageStatus:"UNKNOWN"},{
    currentness:"UNKNOWN",observationStatus:"UNKNOWN",accessDisposition:"UNKNOWN",
  });
  assert.equal(validateSchema(contract.resultSchema,unknown),true,"unknown lineage can be returned without authority-bearing source or output references");
  for(const field of ["acceptedRequestId","acceptedRequestFingerprint","jobId","sourceArtifactId","sourceArtifactVersionRef","sourceDigest","transcriptVersionRef","transcriptDigest"]){
    const leaked=structuredClone(unknown);
    leaked.observation[field]=field.includes("Digest")||field.includes("Fingerprint")?`sha256:${"f".repeat(64)}`:"invented-reference";
    assert.equal(validateSchema(contract.resultSchema,leaked),false,`UNKNOWN lineage rejects ${field}`);
  }
  const predicates=JSON.stringify(validation.predicates);
  assert.match(predicates,/job completion, job status, or submission acceptance alone never implies transcript output/iu);
  assert.match(predicates,/does not correct, approve, publish, dispatch, or authorize retry/iu);
});

test("job-status query resolves exactly seven typed dimensions or returns sparse UNKNOWN",()=>{
  const contract=byId.get("media.observation-contract.job-status-seven-dimension.v1");
  const request={
    queryId:"query-job-status-fixture",jobId:"job-status-17",
    stageRefs:["stage-transcription"],
    qualitySubjectVersionRefs:["candidate-output@version-6"],
    destinationRefs:["destination-account@version-2"],
  };
  const expectedDimensions=["overallJob","stageProgress","attemptClaimAndLease","cancellationOutcome","remoteOutcomeCertainty","qualityDisposition","deliveryStatus"];
  const observation={
    jobId:request.jobId,
    sourceResultRef:"job-status-result@version-4",
    sourceResultDigest:`sha256:${"5".repeat(64)}`,
    sourceResultSchemaRef:contract.resultSchema.properties.observation.oneOf[0].properties.sourceResultSchemaRef.const,
    stageRefs:request.stageRefs,
    qualitySubjectVersionRefs:request.qualitySubjectVersionRefs,
    destinationRefs:request.destinationRefs,
    dimensionRefs:expectedDimensions,
  };
  const result=fixtureCurrentRead(contract,request,observation,{
    operationRef:"media.operation.job-status.read-dimensions.v1",
    presentationOperationRef:"media.operation.action.view-job-status",
    resultRef:"job-status-read-result@version-1",
    resultDigest:`sha256:${"6".repeat(64)}`,
  });
  const dimensionSchema=contract.resultSchema.properties.observation.oneOf[0].properties.dimensionRefs;
  assert.equal(dimensionSchema.minItems,7);
  assert.equal(dimensionSchema.maxItems,7);
  assert.equal(dimensionSchema.uniqueItems,true);
  assert.deepEqual(dimensionSchema.items.enum,expectedDimensions);
  assert.equal(validateSchema(contract.requestSchema,request),true);
  assert.equal(validateSchema(contract.resultSchema,result),true);
  assertExactBindings(contract,request,result);
  for(const field of ["stageRefs","qualitySubjectVersionRefs","destinationRefs"]){
    assert.deepEqual(observation[field],request[field],`${field} scope is preserved exactly`);
    const wrongScope=structuredClone(result);
    wrongScope.observation[field]=[...wrongScope.observation[field],`unrequested-${field}`];
    assert.throws(()=>assertExactBindings(contract,request,wrongScope),/job-status-seven-dimension\.(?:stage|quality|delivery)-scope/u,`${field} cannot be widened beyond the exact request`);
  }
  for(const invalidDimensions of [expectedDimensions.slice(1),[...expectedDimensions.slice(1),"stageProgress"],[...expectedDimensions.slice(0,6),"transcriptAvailable"]]){
    const invalid=structuredClone(result);
    invalid.observation.dimensionRefs=invalidDimensions;
    assert.equal(validateSchema(contract.resultSchema,invalid),false,"missing, duplicate, or invented dimensions fail closed");
  }
  const unknown=fixtureCurrentRead(contract,request,{unknownReasonRef:"job-status-source-unavailable"},{
    operationRef:"media.operation.job-status.read-dimensions.v1",
    presentationOperationRef:"media.operation.action.view-job-status",
    resultRef:"job-status-read-result@version-2",
    resultDigest:`sha256:${"b".repeat(64)}`,
    currentness:"UNKNOWN",observationStatus:"UNKNOWN_OBSERVATION",accessDisposition:"UNKNOWN",
  });
  assert.equal(validateSchema(contract.resultSchema,unknown),true);
  for(const field of ["sourceResultRef","sourceResultDigest","sourceResultSchemaRef","dimensionRefs"]){
    const leaked=structuredClone(unknown);
    leaked.observation[field]=field==="dimensionRefs"?expectedDimensions:`invented-${field}`;
    assert.equal(validateSchema(contract.resultSchema,leaked),false,`UNKNOWN status cannot assert ${field}`);
  }
  const resultRules=contract.resultRules.join(" ");
  assert.match(resultRules,/completed job dimension alone never establishes transcript[\s\S]*output availability/iu);
  assert.match(resultRules,/sparse UNKNOWN with no underlying source result reference or digest/iu);
});

test("output-preview lineage identifies one immutable version, content digest, and exact source ancestry",()=>{
  const contract=byId.get("media.observation-contract.output-preview-version-lineage.v1");
  const observedSchema=contract.resultSchema.properties.observation.oneOf[0];
  const unknownSchema=contract.resultSchema.properties.observation.oneOf[1];
  const request={queryId:"query-output-preview-fixture",subjectRef:"job-output-candidate@version-4"};
  const observation={
    subjectRef:request.subjectRef,
    artifactVersionRef:"output-artifact@version-11",
    artifactDigest:`sha256:${"7".repeat(64)}`,
    sourceLineage:[{
      sourceArtifactVersionRef:"source-artifact@version-9",
      sourceDigest:`sha256:${"8".repeat(64)}`,
      relationRef:"derived-from-source",
    }],
  };
  const result=fixtureCurrentRead(contract,request,observation,{
    operationRef:"media.operation.action.inspect-output-preview-and-version",
    resultRef:"output-preview-read@version-1",
    resultDigest:`sha256:${"9".repeat(64)}`,
  });
  assert.match(contract.resultSchema.properties.resultDigest.pattern,/^\^sha256:/u);
  assert.equal(observedSchema.properties.artifactVersionRef.scalarTypeRef.split("/").at(-1),"opaque-versioned-reference");
  assert.match(observedSchema.properties.artifactDigest.pattern,/^\^sha256:/u);
  assert.equal(observedSchema.properties.sourceLineage.minItems,1);
  assert.equal(observedSchema.properties.sourceLineage.uniqueItems,true);
  assert.equal(validateSchema(contract.requestSchema,request),true);
  assert.equal(validateSchema(contract.resultSchema,result),true);
  assertExactBindings(contract,request,result);
  for(const mutate of [
    value=>{value.observation.artifactDigest="unverified-digest";},
    value=>{value.observation.sourceLineage[0].sourceDigest="unverified-source-digest";},
    value=>{value.observation.sourceLineage=[];},
  ]){
    const invalid=structuredClone(result);
    mutate(invalid);
    assert.equal(validateSchema(contract.resultSchema,invalid),false,"output version and every ancestry digest are typed and exact");
  }
  const unknown=fixtureCurrentRead(contract,request,{unknownReasonRef:"lineage-not-current"},{
    operationRef:"media.operation.action.inspect-output-preview-and-version",
    resultRef:"output-preview-read@version-2",
    resultDigest:`sha256:${"a".repeat(64)}`,
    currentness:"UNKNOWN",observationStatus:"UNKNOWN",accessDisposition:"UNKNOWN",
  });
  assert.ok(unknownSchema.required.includes("unknownReasonRef"));
  assert.equal(validateSchema(contract.resultSchema,unknown),true);
  for(const field of ["artifactVersionRef","artifactDigest","sourceLineage"]){
    const leaked=structuredClone(unknown);
    leaked.observation[field]=field==="sourceLineage"?observation.sourceLineage:`invented-${field}`;
    assert.equal(validateSchema(contract.resultSchema,leaked),false,`UNKNOWN output lineage cannot assert ${field}`);
  }
  assert.match(contract.resultRules.join(" "),/one exact immutable artifact version and its content digest/iu);
  assert.match(contract.resultRules.join(" "),/sourceLineage is owner-resolved/iu);
});

test("delegated result context requires the exact closed three-kind CURRENT result tuple",()=>{
  const contract=byId.get("media.observation-contract.delegated-integration-result-context.v1");
  const request={
    queryId:"query-delegated-fixture",
    operationRef:"media.operation.action.view-job-status",
    originalRequestId:"request-22",
    originalRequestFingerprint:`sha256:${"a".repeat(64)}`,
  };
  const resultRefs=[
    ["JOB_STATUS","media.operation.action.view-job-status",".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.job-status-seven-dimension.v1"],
    ["OUTPUT_PREVIEW_VERSION","media.operation.action.inspect-output-preview-and-version",".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.output-preview-version-lineage.v1"],
    ["PROCESSING_PARAMETERS","media.operation.action.review-processing-parameters",".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.processing-parameter-read.v1"],
  ].map(([resultKind,operationRef,observationContractRef],index)=>({
    resultKind,operationRef,observationContractRef,resultRef:`result-${index+1}@version-1`,queryId:`query-${index+1}`,
    requestFingerprint:`sha256:${String(index+1).repeat(64)}`,resultDigest:`sha256:${String(index+4).repeat(64)}`,
    readVersion:`read-${index+1}`,observedAt:"2026-10-13T12:00:00Z",currentness:"CURRENT",
    ...(resultKind==="JOB_STATUS"?{sourceQueryOperationRef:"media.operation.job-status.read-dimensions.v1"}:{}),
    ...(resultKind==="OUTPUT_PREVIEW_VERSION"?{
      artifactVersionRef:"output-candidate@version-3",
      artifactDigest:`sha256:${"7".repeat(64)}`,
      sourceLineage:[{sourceArtifactVersionRef:"source@version-2",sourceDigest:`sha256:${"8".repeat(64)}`,relationRef:"derived-from"}],
    }:{}),
  }));
  const observation={
    originalRequestId:request.originalRequestId,
    originalRequestFingerprint:request.originalRequestFingerprint,
    contextStatus:"BOUNDED_CONTEXT_RETURNED",
    delegationRef:"delegation-v3",purposeRef:"purpose-v2",budgetRef:"budget-v5",deadlineRef:"deadline-v4",
    resultRefs,recursiveInvocationAllowed:false,
  };
  const result=fixtureCurrentRead(contract,request,observation);
  assert.equal(contract.resultSchema.properties.observation.properties.resultRefs.minItems,3);
  assert.equal(contract.resultSchema.properties.observation.properties.resultRefs.maxItems,3);
  assert.equal(contract.resultSchema.properties.observation.properties.resultRefs.uniqueItems,true);
  assert.equal(validateSchema(contract.requestSchema,request),true);
  assert.equal(validateSchema(contract.resultSchema,result),true);
  assertExactBindings(contract,request,result);
  const resultRefsSchema=contract.resultSchema.properties.observation.properties.resultRefs;
  for(const field of ["observationContractRef","resultRef","requestFingerprint","resultDigest","readVersion","observedAt","currentness"])assert.ok(resultRefsSchema.items.required.includes(field),`each delegated result binds ${field}`);
  assert.equal(resultRefsSchema.items.required.includes("artifactVersionRef"),false,"immutable artifact fields are conditional on OUTPUT_PREVIEW_VERSION");
  const previewTupleRule=resultRefsSchema.allOf.find(rule=>rule.contains?.required?.includes("artifactVersionRef"));
  assert.ok(previewTupleRule,"OUTPUT_PREVIEW_VERSION requires its artifact tuple");
  for(const field of ["artifactVersionRef","artifactDigest","sourceLineage"])assert.ok(previewTupleRule.contains.required.includes(field));
  assert.match(JSON.stringify(resultRefsSchema.allOf),/OUTPUT_PREVIEW_VERSION[\s\S]*media\.observation-contract\.output-preview-version-lineage\.v1/);
  assert.equal(validateSchema(contract.resultSchema,result),true,"preview tuple includes exact immutable output version, digest, and source lineage");

  for(const mutate of [
    value=>{value.observation.resultRefs.pop();},
    value=>{value.observation.resultRefs[2].operationRef="media.operation.action.view-job-status";},
    value=>{delete value.observation.resultRefs[0].sourceQueryOperationRef;},
    value=>{value.observation.resultRefs[0].sourceQueryOperationRef="media.operation.job-status.read-other-dimensions.v1";},
    value=>{value.observation.resultRefs[1].sourceQueryOperationRef="media.operation.job-status.read-dimensions.v1";},
    value=>{value.observation.resultRefs[2].sourceQueryOperationRef="media.operation.job-status.read-dimensions.v1";},
    value=>{value.observation.resultRefs[1].observationContractRef=".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.processing-parameter-read.v1";},
    value=>{value.observation.resultRefs[1].artifactDigest="not-a-sha256-digest";},
    value=>{value.observation.resultRefs[1].sourceLineage=[];},
    value=>{value.observation.resultRefs[1].resultDigest="not-a-sha256-digest";},
    value=>{value.observation.resultRefs[1].currentness="STALE";},
  ]){
    const invalid=structuredClone(result); mutate(invalid);
    assert.equal(validateSchema(contract.resultSchema,invalid),false,"incomplete, mismatched, stale, or malformed delegated results fail closed");
  }
  const unknown=fixtureCurrentRead(contract,request,{
    originalRequestId:request.originalRequestId,
    originalRequestFingerprint:request.originalRequestFingerprint,
    contextStatus:"UNKNOWN",recursiveInvocationAllowed:false,unknownReasonRef:"unknown-context",
  },{currentness:"UNKNOWN",observationStatus:"UNKNOWN",accessDisposition:"UNKNOWN"});
  assert.equal(validateSchema(contract.resultSchema,unknown),true);
  for(const field of ["delegationRef","purposeRef","budgetRef","deadlineRef","resultRefs"]){
    const leaked=structuredClone(unknown); leaked.observation[field]=field==="resultRefs"?resultRefs:[`${field}-invented`];
    assert.equal(validateSchema(contract.resultSchema,leaked),false,`UNKNOWN delegated context rejects ${field}`);
  }
  const resultItem=contract.resultSchema.properties.observation.properties.resultRefs.items;
  assert.match(resultItem.properties.resultDigest.pattern,/^\^sha256:/u);
  assert.match(resultItem.properties.requestFingerprint.pattern,/^\^sha256:/u);
});

test("effective constraints keep candidate resource capacity and cost as separate evidence-backed dimensions",()=>{
  const contract=byId.get("media.observation-contract.effective-processing-constraints.v1");
  const request={queryId:"query-constraints-fixture",exactTargetRef:"candidate-output@version-6",dimensionRefs:[
    "qualification","license","health","capability","rights","resourceCapacity","costEstimate",
  ]};
  const observation=contract.resultSchema.properties.observation;
  const dimensionSchema=observation.properties.dimensions.items;
  const dimensionNames=dimensionSchema.properties.dimension.enum;
  for(const dimension of ["resourceCapacity","costEstimate"]){
    assert.ok(dimensionNames.includes(dimension),`${dimension} is an independent requested dimension`);
    assert.ok(request.dimensionRefs.includes(dimension),`${dimension} has its own candidate-scoped query entry`);
  }
  assert.ok(contract.requestSchema.properties.exactTargetRef,"the constraint query is scoped to one exact candidate target");
  assert.ok(contract.bindingRules.some(rule=>rule.leftRef==="$.request.exactTargetRef"&&rule.rightRef==="$.result.observation.exactTargetRef"&&rule.operator==="EXACT_EQUAL"));
  assert.ok(contract.bindingRules.some(rule=>rule.leftRef==="$.request.dimensionRefs"&&rule.rightRef==="$.result.observation.dimensions[*].dimension"&&rule.operator==="EXACT_SET_EQUAL"));
  const positiveEvidence=dimensionSchema.allOf.find(branch=>branch.if?.properties?.dimensionStatus?.enum?.includes("SATISFIED"));
  assert.ok(positiveEvidence,"positive constraint evidence has an explicit status branch");
  for(const field of ["sourceAuthorityRef","sourceVersionRef","evidenceRef"])assert.ok(positiveEvidence.then?.required?.includes(field),`positive evidence requires ${field}`);
  for(const field of ["resourceCapacity","costEstimate"]){
    const fact={dimension:field,dimensionStatus:"SATISFIED",sourceAuthorityRef:"owner-authority",sourceVersionRef:`${field}-source@version-8`,evidenceRef:`${field}-evidence@version-1`};
    assert.equal(validateSchema(dimensionSchema,fact),true,`${field} can be positively established with exact source evidence`);
    delete fact.evidenceRef;
    assert.equal(validateSchema(dimensionSchema,fact),false,`${field} cannot be positive without evidence`);
    const unknown={dimension:field,dimensionStatus:"UNKNOWN",reasonRef:`${field}-unknown-reason`};
    assert.equal(validateSchema(dimensionSchema,unknown),true,`${field} may remain explicitly UNKNOWN`);
    unknown.evidenceRef=`${field}-invented-evidence`;
    assert.equal(validateSchema(dimensionSchema,unknown),false,`${field} UNKNOWN cannot carry positive evidence`);
  }
  const requestFingerprint=`sha256:${"6".repeat(64)}`;
  const fullRequest={queryId:request.queryId,exactTargetRef:request.exactTargetRef,dimensionRefs:dimensionNames};
  const dimensions=dimensionNames.map(dimension=>["resourceCapacity","costEstimate"].includes(dimension)
    ?{dimension,dimensionStatus:"SATISFIED",sourceAuthorityRef:"candidate-capacity-authority",sourceVersionRef:`${request.exactTargetRef}-source@version-1`,evidenceRef:`${dimension}-evidence@version-1`}
    :{dimension,dimensionStatus:"UNKNOWN",reasonRef:`${dimension}-not-observed`});
  const fullResult=fixtureCurrentRead(contract,fullRequest,{exactTargetRef:request.exactTargetRef,dimensions},{
    operationRef:"media.operation.action.inspect-effective-processing-constraints",
    requestFingerprint,
  });
  assert.equal(validateSchema(contract.requestSchema,fullRequest),true);
  assert.equal(validateSchema(contract.resultSchema,fullResult),true,"resource capacity and cost are independent evidence-backed facts for the exact candidate");
  assertExactBindings(contract,fullRequest,fullResult);
  assert.deepEqual(new Set(fullResult.observation.dimensions.map(row=>row.dimension)),new Set(fullRequest.dimensionRefs));
  for(const field of ["resourceCapacity","costEstimate"]){
    const withoutEvidence=structuredClone(fullResult);
    delete withoutEvidence.observation.dimensions.find(row=>row.dimension===field).evidenceRef;
    assert.equal(validateSchema(contract.resultSchema,withoutEvidence),false,`${field} cannot satisfy a positive constraint without evidence`);
  }
  const wrongCandidate=structuredClone(fullResult);
  wrongCandidate.observation.exactTargetRef="another-candidate@version-1";
  assert.throws(()=>assertExactBindings(contract,fullRequest,wrongCandidate),/effective-constraints\.target/u,"evidence from a different candidate cannot satisfy this query");
  const predicates=JSON.stringify(validationByContractId.get(contract.id).predicates);
  assert.match(predicates,/each requested dimension has its own exact sourceAuthorityRef[\s\S]*sourceVersionRef and evidenceRef/iu);
  assert.match(predicates,/UNKNOWN cannot satisfy a positive predicate/iu);
});

test("destination acknowledgment ties a positive receipt to the original delivery result and exact target tuple",()=>{
  const contract=byId.get("media.observation-contract.destination-delivery-acknowledgment.v1");
  const request={
    queryId:"query-delivery-fixture",
    deliveryRequestResultRef:"delivery-result-41@version-1",
    deliveryRequestId:"delivery-request-41",
    deliveryRequestFingerprint:`sha256:${"1".repeat(64)}`,
    artifactVersionRef:"artifact-41@version-9",
    destinationRef:"destination-account-8@version-2",
  };
  const observation={
    originalRequestResultRef:request.deliveryRequestResultRef,
    originalRequestId:request.deliveryRequestId,
    originalRequestFingerprint:request.deliveryRequestFingerprint,
    artifactVersionRef:request.artifactVersionRef,
    destinationRef:request.destinationRef,
    acknowledgmentStatus:"ACKNOWLEDGED",
    observedAt:"2026-10-13T12:00:01Z",
    evidenceRefs:["destination-receipt-41@version-1"],
    acknowledgmentAuthorityRef:"destination-owner-authority@version-2",
  };
  const result=fixtureCurrentRead(contract,request,observation,{operationRef:"media.operation.action.reconcile-delivery-acknowledgment"});
  assert.match(contract.requestSchema.properties.deliveryRequestFingerprint.pattern,/^\^sha256:/u);
  assert.equal(validateSchema(contract.requestSchema,request),true);
  assert.equal(validateSchema(contract.resultSchema,result),true);
  assertExactBindings(contract,request,result);
  for(const [field,value] of [
    ["originalRequestResultRef","different-delivery-result@version-1"],
    ["originalRequestFingerprint",`sha256:${"2".repeat(64)}`],
    ["artifactVersionRef","artifact-41@version-10"],
    ["destinationRef","destination-account-9@version-2"],
  ]){
    const mismatch=structuredClone(result); mismatch.observation[field]=value;
    assert.throws(()=>assertExactBindings(contract,request,mismatch),/destination-ack\./u,`${field} mismatch cannot support a destination receipt`);
  }
  const predicates=JSON.stringify(validationByContractId.get(contract.id).predicates);
  assert.match(predicates,/currentness != CURRENT[\s\S]*UNKNOWN/iu);
  assert.match(predicates,/UNKNOWN[\s\S]*retry is prohibited until the same request is reconciled/iu);
  assert.match(JSON.stringify(contract.resultRules),/stale[\s\S]*UNKNOWN/iu);
});

test("fallback-selection command requires six positive scoped evidence reads and exact confirmation joins",()=>{
  const fallback=operations.ownerDefinedOperationContracts.records.find(row=>row.id==="media.operation.fallback-selection.confirm.v1");
  assert.ok(fallback,"the versioned fallback-selection command is source-defined under its canonical ID");
  assert.equal(fallback.operationKind,"COMMAND");
  assert.deepEqual(fallback.sourceRefs.filter(ref=>ref.includes("ownerTypedObservationContracts/records/")),[
    ".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.job-status-seven-dimension.v1",
    ".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.output-preview-version-lineage.v1",
    ".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.rights-decision.v1",
    ".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.quality-evidence.v1",
    ".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.effective-processing-constraints.v1",
  ]);
  const requestSchema=fallback.requestSchema;
  const evidenceFields=["statusReadEvidence","rightsEvidence","licenseEvidence","qualityEvidence","resourceCapacityEvidence","costEvidence"];
  for(const field of ["originalJobId","originalRequestId","originalRequestFingerprint","sourceArtifactVersionRef","sourceDigest","alternativeOperationRef","alternativeProfileVersionRef","candidateArtifactVersionRef","candidateArtifactDigest","candidateArtifactEvidence","rightsPurposeRef","rightsUseRef","rightsRegionRef","rightsRetentionPolicyRef",...evidenceFields,"resourceBudgetCeilingRef","explicitConfirmation"]){
    assert.ok(requestSchema.required.includes(field),`fallback selection carries ${field}`);
  }
  assert.equal(requestSchema.properties.resourceBudgetCeilingRef.scalarTypeRef.split("/").at(-1),"opaque-versioned-reference");
  for(const [field,expected] of [
    ["statusReadEvidence",["media.observation-contract.job-status-seven-dimension.v1","media.operation.job-status.read-dimensions.v1","statusResultRef"]],
    ["rightsEvidence",["media.observation-contract.rights-decision.v1","media.operation.action.inspect-consent-and-permitted-use","subjectArtifactVersionRef"]],
    ["licenseEvidence",["media.observation-contract.effective-processing-constraints.v1","media.operation.action.inspect-effective-processing-constraints","exactTargetRef"]],
    ["qualityEvidence",["media.observation-contract.quality-evidence.v1","media.operation.action.inspect-quality-evidence","subjectArtifactVersionRef"]],
    ["resourceCapacityEvidence",["media.observation-contract.effective-processing-constraints.v1","media.operation.action.inspect-effective-processing-constraints","exactTargetRef"]],
    ["costEvidence",["media.observation-contract.effective-processing-constraints.v1","media.operation.action.inspect-effective-processing-constraints","exactTargetRef"]],
  ]){
    const schema=requestSchema.properties[field];
    assert.ok(requestSchema.required.includes(field));
    assert.equal(schema.properties.observationContractRef.const.split("@id=").at(-1),expected[0]);
    assert.equal(schema.properties.operationRef.const,expected[1]);
    assert.equal(schema.properties.currentness.const,"CURRENT");
    assert.equal(schema.properties[expected[2]].scalarTypeRef.split("/").at(-1),"opaque-versioned-reference");
    assert.equal(schema.properties.readVersion.scalarTypeRef.split("/").at(-1),"opaque-version-id");
    for(const required of ["queryId","requestFingerprint",expected[2],"resultDigest","readVersion","observedAt"])assert.ok(schema.required.includes(required),`${field} binds ${required}`);
    assert.match(schema.properties.requestFingerprint.pattern,/^\^sha256:/u);
    assert.match(schema.properties.resultDigest.pattern,/^\^sha256:/u);
  }
  assert.equal(requestSchema.properties.rightsEvidence.properties.observationStatus.const,"ALLOWED_FOR_DECLARED_SCOPE");
  assert.equal(requestSchema.properties.licenseEvidence.properties.dimension.const,"license");
  assert.equal(requestSchema.properties.licenseEvidence.properties.dimensionStatus.const,"SATISFIED");
  assert.equal(requestSchema.properties.qualityEvidence.properties.observationStatus.const,"OBSERVATIONS_PRESENT");
  assert.equal(requestSchema.properties.resourceCapacityEvidence.properties.dimension.const,"resourceCapacity");
  assert.equal(requestSchema.properties.resourceCapacityEvidence.properties.dimensionStatus.const,"SATISFIED");
  assert.equal(requestSchema.properties.costEvidence.properties.dimension.const,"costEstimate");
  assert.equal(requestSchema.properties.costEvidence.properties.dimensionStatus.const,"SATISFIED");
  const candidateEvidenceSchema=requestSchema.properties.candidateArtifactEvidence;
  assert.equal(candidateEvidenceSchema.properties.observationContractRef.const.split("@id=").at(-1),"media.observation-contract.output-preview-version-lineage.v1");
  assert.equal(candidateEvidenceSchema.properties.operationRef.const,"media.operation.action.inspect-output-preview-and-version");
  for(const field of ["resultRef","resultDigest","readVersion","currentness","subjectRef","artifactVersionRef","artifactDigest","sourceLineage","selectedSourceArtifactVersionRef","selectedSourceDigest"]){
    assert.ok(candidateEvidenceSchema.required.includes(field),`candidate artifact evidence binds ${field}`);
  }
  assert.equal(candidateEvidenceSchema.properties.currentness.const,"CURRENT");
  assert.equal(candidateEvidenceSchema.properties.resultRef.scalarTypeRef.split("/").at(-1),"opaque-versioned-reference");
  assert.equal(candidateEvidenceSchema.properties.readVersion.scalarTypeRef.split("/").at(-1),"opaque-version-id");
  assert.deepEqual(candidateEvidenceSchema.properties.sourceLineage.items.required,["sourceArtifactVersionRef","sourceDigest","relationRef"]);

  const expectedBindings=[
    ["$.request.statusReadEvidence.jobId","$.request.originalJobId"],
    ["$.request.candidateArtifactEvidence.artifactVersionRef","$.request.candidateArtifactVersionRef"],
    ["$.request.candidateArtifactEvidence.artifactDigest","$.request.candidateArtifactDigest"],
    ["$.request.candidateArtifactEvidence.selectedSourceArtifactVersionRef","$.request.sourceArtifactVersionRef"],
    ["$.request.candidateArtifactEvidence.selectedSourceDigest","$.request.sourceDigest"],
    ["$.request.rightsEvidence.subjectArtifactVersionRef","$.request.candidateArtifactVersionRef"],
    ["$.request.licenseEvidence.exactTargetRef","$.request.candidateArtifactVersionRef"],
    ["$.request.qualityEvidence.subjectArtifactVersionRef","$.request.candidateArtifactVersionRef"],
    ["$.request.resourceCapacityEvidence.exactTargetRef","$.request.candidateArtifactVersionRef"],
    ["$.request.costEvidence.exactTargetRef","$.request.candidateArtifactVersionRef"],
    ["$.request.rightsEvidence.purposeRef","$.request.rightsPurposeRef"],
    ["$.request.rightsEvidence.useRef","$.request.rightsUseRef"],
    ["$.request.rightsEvidence.regionRef","$.request.rightsRegionRef"],
    ["$.request.rightsEvidence.retentionPolicyRef","$.request.rightsRetentionPolicyRef"],
    ["$.request.originalJobId","$.request.explicitConfirmation.confirmedJobId"],
    ["$.request.originalRequestId","$.request.explicitConfirmation.confirmedRequestId"],
    ["$.request.originalRequestFingerprint","$.request.explicitConfirmation.confirmedRequestFingerprint"],
    ["$.request.sourceArtifactVersionRef","$.request.explicitConfirmation.confirmedSourceArtifactVersionRef"],
    ["$.request.sourceDigest","$.request.explicitConfirmation.confirmedSourceDigest"],
    ["$.request.alternativeOperationRef","$.request.explicitConfirmation.confirmedAlternativeOperationRef"],
    ["$.request.alternativeProfileVersionRef","$.request.explicitConfirmation.confirmedProfileVersionRef"],
    ["$.request.candidateArtifactVersionRef","$.request.explicitConfirmation.confirmedCandidateArtifactVersionRef"],
    ["$.request.candidateArtifactDigest","$.request.explicitConfirmation.confirmedCandidateArtifactDigest"],
    ["$.request.candidateArtifactEvidence.resultDigest","$.request.explicitConfirmation.confirmedCandidateEvidenceResultDigest"],
    ["$.request.statusReadEvidence.resultDigest","$.request.explicitConfirmation.confirmedStatusResultDigest"],
    ["$.request.statusReadEvidence.sourceResultDigest","$.request.explicitConfirmation.confirmedStatusSourceResultDigest"],
    ["$.request.rightsEvidence.resultDigest","$.request.explicitConfirmation.confirmedRightsResultDigest"],
    ["$.request.licenseEvidence.resultDigest","$.request.explicitConfirmation.confirmedLicenseResultDigest"],
    ["$.request.qualityEvidence.resultDigest","$.request.explicitConfirmation.confirmedQualityResultDigest"],
    ["$.request.resourceCapacityEvidence.resultDigest","$.request.explicitConfirmation.confirmedResourceCapacityResultDigest"],
    ["$.request.costEvidence.resultDigest","$.request.explicitConfirmation.confirmedCostResultDigest"],
    ["$.request.rightsPurposeRef","$.request.explicitConfirmation.confirmedRightsPurposeRef"],
    ["$.request.rightsUseRef","$.request.explicitConfirmation.confirmedRightsUseRef"],
    ["$.request.rightsRegionRef","$.request.explicitConfirmation.confirmedRightsRegionRef"],
    ["$.request.rightsRetentionPolicyRef","$.request.explicitConfirmation.confirmedRightsRetentionPolicyRef"],
  ];
  const exactBindings=fallback.bindingRules.filter(rule=>rule.operator==="EXACT_EQUAL").map(rule=>[rule.leftRef,rule.rightRef]);
  for(const binding of expectedBindings)assert.ok(exactBindings.some(row=>JSON.stringify(row)===JSON.stringify(binding)),`required exact join ${binding.join(" -> ")} exists`);
  const request=schemaSample(requestSchema);
  request.requestId="fallback-confirmation-request-1";
  request.originalJobId="job-original-1";
  request.originalRequestId="request-original-1";
  request.originalRequestFingerprint=`sha256:${"1".repeat(64)}`;
  request.sourceArtifactVersionRef="source@version-5";
  request.sourceDigest=`sha256:${"2".repeat(64)}`;
  request.candidateArtifactVersionRef="candidate@version-7";
  request.candidateArtifactDigest=`sha256:${"3".repeat(64)}`;
  Object.assign(request.candidateArtifactEvidence,{
    requestFingerprint:`sha256:${"a".repeat(64)}`,
    resultRef:"candidate-lineage-result@version-1",
    resultDigest:`sha256:${"b".repeat(64)}`,
    subjectRef:request.candidateArtifactVersionRef,
    artifactVersionRef:request.candidateArtifactVersionRef,
    artifactDigest:request.candidateArtifactDigest,
    selectedSourceArtifactVersionRef:request.sourceArtifactVersionRef,
    selectedSourceDigest:request.sourceDigest,
    sourceLineage:[{
      sourceArtifactVersionRef:request.sourceArtifactVersionRef,
      sourceDigest:request.sourceDigest,
      relationRef:"derived-from-original-source",
    }],
  });
  request.statusReadEvidence.jobId=request.originalJobId;
  request.statusReadEvidence.statusResultRef="status-result@version-6";
  request.statusReadEvidence.sourceResultDigest=`sha256:${"c".repeat(64)}`;
  for(const field of evidenceFields){
    request[field].queryId=`${field}-query`;
    request[field].requestFingerprint=`sha256:${"4".repeat(64)}`;
    const evidenceResultRefField=field==="statusReadEvidence"?"statusResultRef":"resultRef";
    request[field][evidenceResultRefField]=`${field}-result@version-1`;
    if(field==="statusReadEvidence")request[field].sourceResultDigest=`sha256:${"6".repeat(64)}`;
    request[field].resultDigest=`sha256:${String(evidenceFields.indexOf(field)+1).repeat(64)}`;
    request[field].readVersion=`${field}-read-version`;
  }
  request.statusReadEvidence.dimensionRefs=requestSchema.properties.statusReadEvidence.properties.dimensionRefs.items.enum;
  request.rightsEvidence.subjectArtifactVersionRef=request.candidateArtifactVersionRef;
  request.qualityEvidence.subjectArtifactVersionRef=request.candidateArtifactVersionRef;
  request.rightsEvidence.purposeRef=request.rightsPurposeRef;
  request.rightsEvidence.useRef=request.rightsUseRef;
  request.rightsEvidence.regionRef=request.rightsRegionRef;
  request.rightsEvidence.retentionPolicyRef=request.rightsRetentionPolicyRef;
  for(const field of ["licenseEvidence","resourceCapacityEvidence","costEvidence"])request[field].exactTargetRef=request.candidateArtifactVersionRef;
  Object.assign(request.explicitConfirmation,{
    confirmedJobId:request.originalJobId,
    confirmedRequestId:request.originalRequestId,
    confirmedRequestFingerprint:request.originalRequestFingerprint,
    confirmedSourceArtifactVersionRef:request.sourceArtifactVersionRef,
    confirmedSourceDigest:request.sourceDigest,
    confirmedAlternativeOperationRef:request.alternativeOperationRef,
    confirmedProfileVersionRef:request.alternativeProfileVersionRef,
    confirmedCandidateArtifactVersionRef:request.candidateArtifactVersionRef,
    confirmedCandidateArtifactDigest:request.candidateArtifactDigest,
    confirmedRightsPurposeRef:request.rightsPurposeRef,
    confirmedRightsUseRef:request.rightsUseRef,
    confirmedRightsRegionRef:request.rightsRegionRef,
    confirmedRightsRetentionPolicyRef:request.rightsRetentionPolicyRef,
    confirmedCandidateEvidenceResultDigest:request.candidateArtifactEvidence.resultDigest,
    confirmedStatusResultDigest:request.statusReadEvidence.resultDigest,
    confirmedStatusSourceResultDigest:request.statusReadEvidence.sourceResultDigest,
    confirmedRightsResultDigest:request.rightsEvidence.resultDigest,
    confirmedLicenseResultDigest:request.licenseEvidence.resultDigest,
    confirmedQualityResultDigest:request.qualityEvidence.resultDigest,
    confirmedResourceCapacityResultDigest:request.resourceCapacityEvidence.resultDigest,
    confirmedCostResultDigest:request.costEvidence.resultDigest,
  });
  const fallbackRequestValidator=ajv.compile(requestSchema);
  assert.equal(fallbackRequestValidator(request),true,`a complete current positive evidence tuple with matching explicit confirmation is well-shaped: ${JSON.stringify(fallbackRequestValidator.errors)}`);
  assert.notEqual(request.statusReadEvidence.requestFingerprint,request.originalRequestFingerprint,"the status-query fingerprint is distinct from the original submission fingerprint");
  assert.deepEqual(request.candidateArtifactEvidence.sourceLineage,[{
    sourceArtifactVersionRef:request.candidateArtifactEvidence.selectedSourceArtifactVersionRef,
    sourceDigest:request.candidateArtifactEvidence.selectedSourceDigest,
    relationRef:"derived-from-original-source",
  }]);
  assertExactBindings(fallback,request,{});
  const confirmationResult=schemaSample(fallback.resultSchema.oneOf[0]);
  Object.assign(confirmationResult,{
    outcome:"CONFIRMATION_RECORDED",
    requestId:request.requestId,
    requestFingerprint:`sha256:${"f".repeat(64)}`,
    originalJobId:request.originalJobId,
    originalRequestId:request.originalRequestId,
    originalRequestFingerprint:request.originalRequestFingerprint,
    sourceArtifactVersionRef:request.sourceArtifactVersionRef,
    sourceDigest:request.sourceDigest,
    alternativeOperationRef:request.alternativeOperationRef,
    alternativeProfileVersionRef:request.alternativeProfileVersionRef,
    candidateArtifactVersionRef:request.candidateArtifactVersionRef,
    candidateArtifactDigest:request.candidateArtifactDigest,
    candidateArtifactEvidenceResultRef:request.candidateArtifactEvidence.resultRef,
    candidateArtifactEvidenceResultDigest:request.candidateArtifactEvidence.resultDigest,
    statusResultRef:request.statusReadEvidence.statusResultRef,
    statusResultDigest:request.statusReadEvidence.resultDigest,
    statusSourceResultDigest:request.statusReadEvidence.sourceResultDigest,
    rightsResultDigest:request.rightsEvidence.resultDigest,
    licenseResultDigest:request.licenseEvidence.resultDigest,
    qualityResultDigest:request.qualityEvidence.resultDigest,
    resourceCapacityResultDigest:request.resourceCapacityEvidence.resultDigest,
    costResultDigest:request.costEvidence.resultDigest,
    selectionReceiptRef:"fallback-selection@version-1",
    observedAt:"2026-10-14T12:00:00Z",
  });
  assert.equal(validateSchema(fallback.resultSchema,confirmationResult),true,"positive confirmation emits the exact selected candidate and evidence tuple");
  const resultBindingContract={bindingRules:fallback.resultBindings.find(row=>row.whenOutcome==="CONFIRMATION_RECORDED").bindings};
  assertExactBindings(resultBindingContract,request,confirmationResult);
  for(const rule of resultBindingContract.bindingRules){
    const mismatch=structuredClone(confirmationResult);
    const target=rule.rightRef.replace(/^\$\.result\./u,"").split(".");
    const leaf=target.pop();
    const parent=target.reduce((value,key)=>value[key],mismatch);
    parent[leaf]=`${parent[leaf]}-mismatch`;
    assert.throws(()=>assertExactBindings(resultBindingContract,request,mismatch),new RegExp(rule.id.replaceAll(".","\\."),"u"),`${rule.id} rejects a mismatched successful-result echo`);
  }
  for(const [field,path] of [
    ["statusReadEvidence","jobId"],
    ["candidateArtifactEvidence","artifactVersionRef"],
    ["candidateArtifactEvidence","artifactDigest"],
    ["candidateArtifactEvidence","selectedSourceArtifactVersionRef"],
    ["candidateArtifactEvidence","selectedSourceDigest"],
    ["rightsEvidence","subjectArtifactVersionRef"],
    ["rightsEvidence","purposeRef"],
    ["licenseEvidence","exactTargetRef"],
    ["qualityEvidence","subjectArtifactVersionRef"],
    ["resourceCapacityEvidence","exactTargetRef"],
    ["costEvidence","exactTargetRef"],
  ]){
    const mismatch=structuredClone(request);
    mismatch[field][path]=path.endsWith("Digest")?`sha256:${"e".repeat(64)}`:`${mismatch[field][path]}-different`;
    assert.throws(()=>assertExactBindings(fallback,mismatch,{}),undefined,`${field}.${path} cannot drift from the exact candidate, source, or job tuple`);
  }
  const evidenceJoins=new Map(fallback.evidenceJoinRules.map(rule=>[rule.id,rule]));
  const expectedEvidenceJoins=[
    ["media.operation-evidence-join.fallback-selection.status","$.request.statusReadEvidence.statusResultRef","media.observation-contract.job-status-seven-dimension.v1"],
    ["media.operation-evidence-join.fallback-selection.candidate-output","$.request.candidateArtifactEvidence.resultRef","media.observation-contract.output-preview-version-lineage.v1"],
    ["media.operation-evidence-join.fallback-selection.rights","$.request.rightsEvidence.resultRef","media.observation-contract.rights-decision.v1"],
    ["media.operation-evidence-join.fallback-selection.license","$.request.licenseEvidence.resultRef","media.observation-contract.effective-processing-constraints.v1"],
    ["media.operation-evidence-join.fallback-selection.quality","$.request.qualityEvidence.resultRef","media.observation-contract.quality-evidence.v1"],
    ["media.operation-evidence-join.fallback-selection.resource-capacity","$.request.resourceCapacityEvidence.resultRef","media.observation-contract.effective-processing-constraints.v1"],
    ["media.operation-evidence-join.fallback-selection.cost","$.request.costEvidence.resultRef","media.observation-contract.effective-processing-constraints.v1"],
  ];
  assert.equal(evidenceJoins.size,expectedEvidenceJoins.length,"each evidence result has one exact typed-source join");
  for(const [id,evidenceRef,observationContractRef] of expectedEvidenceJoins){
    const join=evidenceJoins.get(id);
    assert.ok(join,`${id} exists`);
    assert.equal(join.evidenceRef,evidenceRef);
    assert.equal(join.observationContractRef,observationContractRef);
    assert.ok(pointerValue({request},join.evidenceRef),`${id} resolves the exact result reference in the positive request fixture`);
    assert.match(join.require,/exact queryId[\s\S]*requestFingerprint[\s\S]*resultDigest[\s\S]*readVersion[\s\S]*observedAt[\s\S]*CURRENT currentness/iu);
  }
  assert.match(evidenceJoins.get("media.operation-evidence-join.fallback-selection.candidate-output").require,/selectedSourceArtifactVersionRef and selectedSourceDigest are one exact pair in the owner-resolved complete sourceLineage/iu);
  assert.match(evidenceJoins.get("media.operation-evidence-join.fallback-selection.status").require,/never equate the status-query requestFingerprint with originalRequestFingerprint/iu);
  const previouslyCheckedBindingRefs=new Set();
  for(const rule of fallback.bindingRules.filter(row=>row.operator==="EXACT_EQUAL")){
    const mismatch=structuredClone(request);
    const mismatchRef=[rule.rightRef,rule.leftRef].find(ref=>!previouslyCheckedBindingRefs.has(ref));
    assert.ok(mismatchRef,`${rule.id} has an independently mutable exact join side`);
    const target=mismatchRef.replace(/^\$\.request\./u,"").split(".");
    const leaf=target.pop();
    const parent=target.reduce((value,key)=>value[key],mismatch);
    parent[leaf]=`${parent[leaf]}-mismatch`;
    assert.throws(()=>assertExactBindings(fallback,mismatch,{}),new RegExp(rule.id.replaceAll(".","\\."),"u"),`${rule.id} rejects a mismatched confirmation join`);
    previouslyCheckedBindingRefs.add(rule.leftRef);
    previouslyCheckedBindingRefs.add(rule.rightRef);
  }

  assert.ok(fallback.sourceGuards.includes("candidate-specific-current-rights-license-quality-resource-evidence-must-be-positive"));
  assert.ok(fallback.sourceGuards.includes("resource-budget-is-a-caller-ceiling-and-never-capacity-evidence"));
  assert.ok(fallback.sourceGuards.includes("explicit-confirmation-must-match-original-request-and-selected-alternative"));
  assert.match(fallback.sourceRecovery,/UNKNOWN does not imply denial, failure, or permission to resubmit/u);
  for(const [index,outcome] of [[1,"DENIED"],[2,"UNKNOWN_OUTCOME"]]){
    const sparse=schemaSample(fallback.resultSchema.oneOf[index]);
    sparse.outcome=outcome;
    assert.deepEqual(Object.keys(sparse).sort(),["observedAt","originalJobId","originalRequestFingerprint","outcome","reasonCode","requestFingerprint","requestId"].sort());
    assert.equal(validateSchema(fallback.resultSchema,sparse),true,`${outcome} remains a sparse fail-closed result`);
    for(const field of ["candidateArtifactVersionRef","candidateArtifactDigest","statusResultDigest","rightsResultDigest","licenseResultDigest","qualityResultDigest","resourceCapacityResultDigest","costResultDigest","selectionReceiptRef"]){
      const leaked={...sparse,[field]:`invented-${field}`};
      assert.equal(validateSchema(fallback.resultSchema,leaked),false,`${outcome} cannot infer ${field}`);
    }
  }
  const unknown=schemaSample(fallback.resultSchema.oneOf[2]);
  unknown.outcome="UNKNOWN_OUTCOME";
  unknown.selectionReceiptRef="invented-selection@version-1";
  assert.equal(validateSchema(fallback.resultSchema,unknown),false,"UNKNOWN_OUTCOME cannot expose a successful selection receipt");
});

test("C16 dubbing preserves the exact accepted source/version/profile tuple and candidate-only output",()=>{
  const dubbing=operations.capabilityOperationContracts.records.find(row=>row.id==="media.operation.capability.media-speech-synthesis-dub");
  assert.ok(dubbing,"C16 uses the exact speech dubbing capability contract");
  const bindingRules=dubbing.resultSchema.bindingRules;
  assert.equal(bindingRules.length,13,"C16 has the complete exact accepted-request tuple plus candidate-output echo");
  assert.deepEqual(bindingRules.map(({id})=>id),[
    "media.capability-binding.dub.request-id",
    "media.capability-binding.dub.source-artifact-id",
    "media.capability-binding.dub.source-artifact-version",
    "media.capability-binding.dub.source-content-digest",
    "media.capability-binding.dub.source-clock",
    "media.capability-binding.dub.ticks-per-second",
    "media.capability-binding.dub.source-duration",
    "media.capability-binding.dub.source-locale",
    "media.capability-binding.dub.target-locale",
    "media.capability-binding.dub.translated-segment-version",
    "media.capability-binding.dub.voice-profile-version",
    "media.capability-binding.dub.output-profile-version",
    "media.capability-binding.dub.candidate-output",
  ]);
  assert.ok(bindingRules.every(rule=>rule.operator==="EXACT_EQUAL"),"every C16 join requires exact equality");
  const sourceInput=dubbing.requestSchema.properties.input2;
  const sourcePayload=sourceInput.properties.payload;
  const sourceProperties=sourcePayload.properties;
  for(const field of ["artifactId","versionId","sourceContentDigest","sourceClockId","ticksPerSecond","sourceDurationTicks"]){
    assert.ok(sourcePayload.required.includes(field),`dubbing retains exact source ${field}`);
    assert.ok(Object.hasOwn(sourceProperties,field),`source ${field} is typed`);
  }
  assert.match(sourceProperties.sourceContentDigest.pattern,/^\^sha256:/u);
  for(const field of ["translatedSegmentVersionRef","sourceLocale","targetLocale","voiceProfileVersionRef","outputProfileRef"]){
    assert.ok(dubbing.parameterSchema.required.includes(field),`dubbing requires exact ${field}`);
  }
  assert.equal(dubbing.inputSlots.find(slot=>slot.slotId==="input1").cardinality,"EXACTLY_ONE_OF_DECLARED_ALTERNATIVES");
  assert.equal(dubbing.inputSlots.find(slot=>slot.slotId==="input2").cardinality,"EXACTLY_ONE");
  const accepted=dubbing.resultSchema.properties.acceptedRequest;
  for(const field of ["sourceArtifactId","sourceArtifactVersionId","sourceContentDigest","sourceClockId","ticksPerSecond","sourceDurationTicks","sourceLocale","targetLocale","translatedSegmentVersionRef","voiceProfileVersionRef","outputProfileRef","candidateOutputRef"]){
    assert.ok(accepted.required.includes(field),`accepted request echoes exact ${field}`);
  }
  assert.match(accepted.properties.sourceContentDigest.pattern,/^\^sha256:/u);
  assert.deepEqual(dubbing.resultSchema.outcomeRules,{SUCCEEDED:"exactly 1 declared typed output(s)",REJECTED:"zero output claims",UNKNOWN_OUTCOME:"zero output claims; reconcile before retry"});
  assert.match(dubbing.resultSchema.acceptedTupleRule.replaceAll("-"," "),/candidateOutputRef exactly equals the single output payload reference/iu);
  assert.match(dubbing.resultSchema.acceptedTupleRule.replaceAll("-"," "),/candidate only and never an immutable registered artifact version/iu);
  assert.match(JSON.stringify(dubbing.finality),/transport acknowledgement or dispatch is not completion/iu);

  const candidateRef="dubbed-candidate@version-1";
  const submittedRequest=schemaSample(dubbing.requestSchema);
  const successful=schemaSample(dubbing.resultSchema);
  successful.requestId="dubbing-request-16";
  successful.requestFingerprint=`sha256:${"8".repeat(64)}`;
  successful.outcome="SUCCEEDED";
  successful.observedAt="2026-10-13T12:00:00Z";
  successful.acceptedRequest=schemaSample(accepted);
  successful.acceptedRequest.candidateOutputRef=candidateRef;
  successful.outputs=[{artifactType:dubbing.successOutputs[0].artifactType,payload:{reference:candidateRef}}];
  successful.provenance.operationRef=dubbing.id;
  successful.provenance.observedAt=successful.observedAt;
  const bindingContract={bindingRules};
  for(const binding of bindingRules){
    const values={request:submittedRequest,result:successful};
    setPointerValue(values,binding.rightRef,pointerValue(values,binding.leftRef));
  }
  assert.equal(validateSchema(dubbing.resultSchema,successful),true,"success has one typed candidate output and exact source/version inputs");
  assertExactBindings(bindingContract,submittedRequest,successful);
  for(const binding of bindingRules){
    const mismatch=structuredClone(successful);
    const values={request:submittedRequest,result:mismatch};
    const boundValue=pointerValue(values,binding.rightRef);
    setPointerValue(values,binding.rightRef,typeof boundValue==="number"?boundValue+1:`${boundValue}-mismatch`);
    assert.throws(()=>assertExactBindings(bindingContract,submittedRequest,mismatch),new RegExp(binding.id.replaceAll(".","\\."),"u"),`${binding.id} rejects source/version/profile/candidate substitution`);
  }
  const rejected=structuredClone(successful); rejected.outcome="REJECTED"; rejected.outputs=[]; delete rejected.acceptedRequest;
  assert.equal(validateSchema(dubbing.resultSchema,rejected),true,"rejection carries no output claim");
  const unknown=structuredClone(rejected); unknown.outcome="UNKNOWN_OUTCOME";
  assert.equal(validateSchema(dubbing.resultSchema,unknown),true,"unknown submission outcome carries no output claim");
  unknown.outputs=[successful.outputs[0]];
  assert.equal(validateSchema(dubbing.resultSchema,unknown),false,"UNKNOWN_OUTCOME cannot imply a candidate output");
});


test("retry-policy read is exact current evidence and never self-authorizes a retry",()=>{
  const contract=byId.get("media.observation-contract.retry-policy-current-read.v1");
  const request={queryId:"query-1",jobId:"job-7",priorAttemptId:"attempt-2"};
  const trusted={tenantScopeRef:"tenant-1",principalRef:"principal-4",expectedOperationRef:"media.operation.action.inspect-job-retry-policy",expectedReadAuthorityRef:contract.readAuthorityRefs[0],expectedReadVersion:"read-v9"};
  const result={tenantScopeRef:trusted.tenantScopeRef,principalRef:trusted.principalRef,queryId:request.queryId,operationRef:trusted.expectedOperationRef,requestFingerprint:typedObservationRequestFingerprint(request,trusted),readAuthorityRef:trusted.expectedReadAuthorityRef,currentness:"CURRENT",readVersion:trusted.expectedReadVersion,observedAt:"2026-10-09T12:00:00Z",observation:{kind:"OBSERVED_RETRY_POLICY_AND_ATTEMPT",jobId:request.jobId,priorAttemptId:request.priorAttemptId,jobVersionRef:"job-version-7",attemptVersionRef:"attempt-version-2",capabilityRef:"media.job.retry",retryOperationRef:"media.operation-slice.retry-job",profileRef:"media.capability-profile.media-job",boundsRef:"media.capability-bounds.media-job-retry",policyVersionRef:"policy-version-3",retryability:"NOT_RETRYABLE",outcomeClass:"DEFINITIVE_RETRYABLE_FAILURE",budgetUnit:"ADDITIONAL_ATTEMPTS_PER_LOGICAL_JOB",maximumExplicitRetries:0,retriesUsed:0,retriesRemaining:0}};
  const args={contract,request,result,trusted,now:"2026-10-09T12:00:05Z",maxAgeMs:60000};
  assert.deepEqual(validateRetryPolicyCurrentRead(args),{truth:"TRUE",reason:"EXACT_CURRENT_RETRY_POLICY_AND_ATTEMPT_READ"});
  const wrongJob=structuredClone(result); wrongJob.observation.jobId="job-foreign";
  assert.deepEqual(validateRetryPolicyCurrentRead({...args,result:wrongJob}),{truth:"UNKNOWN",reason:"OBSERVATION_BINDING_RULE_MISMATCH"});
  const falseBudget=structuredClone(result); falseBudget.observation.retriesRemaining=1;
  assert.deepEqual(validateRetryPolicyCurrentRead({...args,result:falseBudget}),{truth:"UNKNOWN",reason:"RETRY_BUDGET_OR_OWNER_BINDING_INCONSISTENT"});
  const inventedRetry=structuredClone(result); inventedRetry.observation.retryability="RETRYABLE";
  assert.deepEqual(validateRetryPolicyCurrentRead({...args,result:inventedRetry}),{truth:"UNKNOWN",reason:"RETRYABILITY_CONTRADICTS_OUTCOME_OR_BUDGET"});
  const stale=structuredClone(result); stale.currentness="STALE";
  assert.deepEqual(validateRetryPolicyCurrentRead({...args,result:stale}),{truth:"UNKNOWN",reason:"READ_CURRENTNESS_NOT_ESTABLISHED"});
  const foreignAuthority=structuredClone(result); foreignAuthority.readAuthorityRef=".product-experience/pdp-1-domain-data/privacy.yaml#ownerDefinedPdp10Boundary.effectBoundary";
  assert.deepEqual(validateRetryPolicyCurrentRead({...args,result:foreignAuthority}),{truth:"UNKNOWN",reason:"OBSERVATION_RESULT_INVALID_OR_OPEN"});
  const forgedRequest={...request,tenantId:"tenant-foreign"};
  assert.deepEqual(validateRetryPolicyCurrentRead({...args,request:forgedRequest}),{truth:"UNKNOWN",reason:"OBSERVATION_REQUEST_INVALID_OR_OPEN"});
});
