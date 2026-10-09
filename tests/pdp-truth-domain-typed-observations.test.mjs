import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root=resolve(new URL("..",import.meta.url).pathname);
const parse=createRequire(resolve(root,"../ghatana-tools/package.json"))("yaml").parse;
const operations=parse(readFileSync(resolve(root,".product-experience/pdp-1-domain-data/operations.yaml"),"utf8"));
const contracts=operations.ownerTypedObservationContracts;
const rules=operations.ownerTypedObservationValidationRules;
const byId=new Map(contracts.records.map(row=>[row.id,row]));
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

test("seven observation schemas are stable typed query definitions and never imply runtime binding",()=>{
  assert.equal(contracts.records.length,7);
  assert.match(contracts.status,/existing-runtime-binding-NOT_ESTABLISHED/);
  assert.deepEqual([...byId.keys()].sort(),[
    "media.observation-contract.declared-options.v1",
    "media.observation-contract.language-uncertainty.v1",
    "media.observation-contract.profile-qualification.v1",
    "media.observation-contract.provenance-completeness.v1",
    "media.observation-contract.quality-action-plan.v1",
    "media.observation-contract.quality-evidence.v1",
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
  assert.equal(validation.size,7);
  const rights=byId.get("media.observation-contract.rights-decision.v1");
  assert.deepEqual(rights.requestSchema.required,["queryId","subjectArtifactVersionRef","decisionKind","purposeRef","useRef","regionRef","retentionPolicyRef"]);
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
});
