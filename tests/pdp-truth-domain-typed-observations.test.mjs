import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { typedObservationRequestFingerprint, validateRetryPolicyCurrentRead } from "../scripts/lib/pdp-truth-domain-observation-currentness.mjs";

const root=resolve(new URL("..",import.meta.url).pathname);
const parse=createRequire(resolve(root,"../ghatana-tools/package.json"))("yaml").parse;
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

test("current PDP-1 semantic review binds the exact owner typed observation delta without claiming admission",()=>{
  const sha256=createHash("sha256").update(operationSourceBytes).digest("hex");
  const delta=operationSourceReview.currentSourceCutDeltaReview.supplementalPdp1DefinitionDelta;
  const expectedIds=[
    "media.observation-contract.rights-decision.v1",
    "media.observation-contract.destination-delivery-acknowledgment.v1",
    "media.observation-contract.delegated-integration-result-context.v1",
    "media.observation-contract.processing-parameter-read.v1",
    "media.observation-contract.effective-processing-constraints.v1",
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
  assert.deepEqual(delta.reviewedRecords.map(record=>record.id),expectedIds);
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
  assert.equal(delta.preservedBoundaries.runtimeAdmission,"NOT_ADMITTED");
  assert.equal(delta.preservedBoundaries.transportAdmission,"NOT_ADMITTED");
  assert.equal(delta.preservedBoundaries.externalContractOwnerAcceptance,"NOT_CLAIMED");
  assert.equal(delta.preservedBoundaries.independentSpecialistAttestation,"NOT_CLAIMED");
  assert.equal(delta.preservedBoundaries.proposalOperationRecordCount,14);
  const reviewedIdentityIds=semanticReview.reviewedIdentityIds;
  const reviewedIdentitySet=new Set(reviewedIdentityIds);
  assert.equal(reviewedIdentityIds.length,2023);
  assert.equal(reviewedIdentitySet.size,2023);
  assert.deepEqual(createHash("sha256").update(JSON.stringify([...reviewedIdentitySet].sort())).digest("hex"),"842fc763764f09c291d4eb1ec5aba4ca30386e9f0b793ee19334bbd47b055b88");
  assert.equal(semanticReview.outstandingMeaningIds.length,0);
  assert.equal(semanticReview.sourceFingerprints[".product-experience/pdp-1-domain-data/operations.yaml"],sha256);
  assert.equal(semanticReview.currentCutReview.supplementalDefinitionDeltaReview.sourceSha256,sha256);
  assert.equal(semanticReview.currentCutReview.supplementalDefinitionDeltaReview.identitySetChanged,false);
  assert.deepEqual(semanticReview.currentCutReview.supplementalDefinitionDeltaReview.reviewedRecordIds,expectedIds);
});

test("twelve observation schemas are stable typed query definitions and never imply runtime binding",()=>{
  assert.equal(contracts.records.length,12);
  assert.match(contracts.status,/existing-runtime-binding-NOT_ESTABLISHED/);
  assert.deepEqual([...byId.keys()].sort(),[
    "media.observation-contract.declared-options.v1",
    "media.observation-contract.delegated-integration-result-context.v1",
    "media.observation-contract.destination-delivery-acknowledgment.v1",
    "media.observation-contract.effective-processing-constraints.v1",
    "media.observation-contract.language-uncertainty.v1",
    "media.observation-contract.processing-parameter-read.v1",
    "media.observation-contract.profile-qualification.v1",
    "media.observation-contract.provenance-completeness.v1",
    "media.observation-contract.quality-action-plan.v1",
    "media.observation-contract.quality-evidence.v1",
    "media.observation-contract.retry-policy-current-read.v1",
    "media.observation-contract.rights-decision.v1",
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
    assert.deepEqual(record.resultSchema.properties.operationRef.enum,record.operationRefs,`${record.id} result is restricted to exact operation identities`);
  }
  assert.deepEqual(contracts.trustedContext.requiredHostFacts,["tenantId","principalId","expectedOperationRef","expectedReadAuthorityRef","expectedReadVersion"]);
  assert.match(rules.commonCurrentReadValidation.join(" "),/exactly echoes request queryId/u);
  assert.match(rules.commonCurrentReadValidation.join(" "),/expectedReadAuthorityRef/u);
  assert.match(rules.commonCurrentReadValidation.join(" "),/expectedReadVersion/u);
});

test("raw rights, quality, profile and provenance observations retain their fail-closed material predicates",()=>{
  const validation=new Map(rules.records.map(row=>[row.observationContractRef,row]));
  assert.equal(validation.size,12);
  assert.equal(rules.records.length,12, "each observation contract has exactly one unique validator");
  assert.deepEqual([...new Set(rules.records.map(row=>row.id))].sort(),[
    "media.observation-validation.declared-options.v1",
    "media.observation-validation.delegated-integration-result-context.v1",
    "media.observation-validation.destination-delivery-acknowledgment.v1",
    "media.observation-validation.effective-processing-constraints.v1",
    "media.observation-validation.language-uncertainty.v1",
    "media.observation-validation.processing-parameter-read.v1",
    "media.observation-validation.profile-qualification.v1",
    "media.observation-validation.provenance-completeness.v1",
    "media.observation-validation.quality-action-plan.v1",
    "media.observation-validation.quality-evidence.v1",
    "media.observation-validation.retry-policy-current-read.v1",
    "media.observation-validation.rights-decision.v1",
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
  assert.deepEqual(rights.decisionKindStateMapping.slice(0,3).map(({decisionKind,observationStatus,effectDisposition})=>[decisionKind,observationStatus,effectDisposition]),[
    ["RIGHTS","DENIED","DENIED"],["RIGHTS","RESTRICTED","RESTRICTED"],["CONSENT","CONSENT_REQUIRED","CONSENT_REQUIRED"],
  ]);
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
  assert.deepEqual(new Set(dimensions.items.properties.dimension.enum),new Set(["qualification","license","health","capability","rights"]));
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
