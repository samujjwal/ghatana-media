import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { canonicalIdentityKey, registerImmutableIdentity, validateAcyclicSameTenantLineage, IdentityContractError } from "../scripts/lib/pdp-truth-domain-identity-oracle.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const parse = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml").parse;
const objects = parse(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/domain-objects.yaml"), "utf8"));
const operations = parse(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/operations.yaml"), "utf8"));
const relationships = parse(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/relationships.yaml"), "utf8"));
const source = objects.ownerTypedIdentityContracts;
const records = new Map(source.records.map((record) => [record.objectRef, record]));
const scalarTypeDefinitions = operations.capabilityOperationContracts.scalarTypes;
const scalarTypes = new Set(Object.keys(scalarTypeDefinitions));
const scalarRefPrefix = ".product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/scalarTypes/";
const canonicalObjectRefs = new Set(source.records.filter((record) => record.canonicalDisposition === "CANONICAL_MEDIA_IDENTITY").map(({ objectRef }) => objectRef));
const fingerprint = (char) => `sha256:${char.repeat(64)}`;

function throwsCode(code, operation) {
  assert.throws(operation, (error) => error instanceof IdentityContractError && error.code === code);
}

test("all 38 current object identities have explicit typed owner or source-observation dispositions", () => {
  assert.deepEqual(source.population, {
    registeredCurrentIdentities: 38,
    canonicalMediaObjects: 33,
    sourceObservationsWithExplicitNonEquivalence: 5,
    excludedLegacyTranscriptionCount: 1,
  });
  assert.equal(source.records.length, 38);
  assert.equal(records.size, 38);
  assert.equal(objects.canonicalIdentityAdjudication.registeredObjectIdentityRefs.length, 38);
  assert.equal(objects.canonicalIdentityAdjudication.excludedHistoricalRecords[0].objectId, "media.domain.transcription");
  const canonical = source.records.filter((record) => record.canonicalDisposition === "CANONICAL_MEDIA_IDENTITY");
  const observations = source.records.filter((record) => record.canonicalDisposition === "SOURCE_OBSERVATION_NON_EQUIVALENCE");
  assert.equal(canonical.length, 33);
  assert.equal(observations.length, 5);
  assert.equal(source.persistenceAndWireSemantics.id, "media.identity.persistence-wire-boundary.v1");
  assert.match(source.persistenceAndWireSemantics.canonicalObjectDisposition, /persistenceAdapter_NOT_ADMITTED; wireAdapter_NOT_ADMITTED/);
  assert.match(source.persistenceAndWireSemantics.sourceObservationDisposition, /no canonical tuple/);
  assert.match(source.persistenceAndWireSemantics.trustedTenantDisposition, /trusted authenticated host context/);
  assert.match(source.persistenceAndWireSemantics.immutableFingerprintDefinition, /sha256:\` plus 64 lowercase hexadecimal characters/);
  for (const record of canonical) {
    assert.ok(record.id.startsWith("media.identity-contract."));
    assert.equal(record.identityComponents[0].field, "tenantId", record.objectRef);
    assert.equal(record.canonicalIdentityTuple[0], "tenantId", record.objectRef);
    assert.equal(new Set(record.canonicalIdentityTuple).size, record.canonicalIdentityTuple.length, record.objectRef);
    assert.equal(record.identityComponents.length, record.canonicalIdentityTuple.length, record.objectRef);
    for (const component of record.identityComponents) {
      if (component.scalarTypeRef) {
        assert.ok(component.scalarTypeRef.startsWith(scalarRefPrefix), `${record.objectRef}.${component.field} uses exact source registry`);
        const type = component.scalarTypeRef.split("/").at(-1);
        assert.ok(scalarTypes.has(type), `${record.objectRef}.${component.field} resolves type ${type}`);
      } else assert.ok(component.inlineConstraint, `${record.objectRef}.${component.field} has an explicit validator`);
    }
    assert.ok(["OBSERVED_FIELDS_REQUIRE_EXACT_CANONICAL_ADAPTER", "NO_CROSS_INTERFACE_IDENTITY_PROJECTION_ESTABLISHED"].includes(record.projectionDisposition));
    assert.ok(record.sourceProjectionRefs.length > 0);
  }
  for (const record of observations) {
    assert.deepEqual(record.identityComponents, [], record.objectRef);
    assert.deepEqual(record.canonicalIdentityTuple, [], record.objectRef);
    assert.equal(record.projectionDisposition, "SOURCE_OBSERVATION_ONLY_NO_CANONICAL_DTO_EQUIVALENCE");
    assert.ok(record.sourceObservationFields.length > 0);
  }
});

test("named cross-entity relationships bind exact same-tenant typed references", () => {
  assert.equal(source.relationshipBindings.length, relationships.relationships.length);
  assert.equal(new Set(source.relationshipBindings.map((row) => row.sourceRelationshipRef)).size, relationships.relationships.length);
  for (const binding of source.relationshipBindings) {
    const id = binding.sourceRelationshipRef.split("/").at(-1);
    assert.ok(relationships.relationships.some((relationship) => relationship.id === id), `relationship ${id} exists`);
    assert.ok(binding.sourceRefField.includes("."), `${id} binds a named field`);
    assert.equal(binding.sameTenant, true, id);
    assert.ok(binding.targetRef, `${id} names the target object`);
    assert.match(binding.exactVersionRef, /\S/);
  }
  assert.ok(source.tupleRules.some(({ id }) => id === "media.identity-rule.content-digest-not-identity"));
  assert.ok(source.tupleRules.some(({ id }) => id === "media.identity-rule.immutable-version-lineage"));
  assert.ok(source.tupleRules.some(({ id }) => id === "media.identity-rule.source-observation-not-promoted"));
});

test("identity oracle rejects missing or caller-overridden tenant, malformed IDs, and same-tenant collisions", () => {
  const project = records.get("media.domain.project");
  const registry = new Map();
  const payload = { projectId: "p-1" };
  const first = registerImmutableIdentity(registry, project, payload, "tenant-a", fingerprint("a"), scalarTypeDefinitions);
  assert.equal(first.disposition, "CREATED");
  assert.equal(registerImmutableIdentity(registry, project, payload, "tenant-a", fingerprint("a"), scalarTypeDefinitions).disposition, "IDEMPOTENT_DUPLICATE");
  assert.notEqual(canonicalIdentityKey(project, payload, "tenant-a", scalarTypeDefinitions), canonicalIdentityKey(project, payload, "tenant-b", scalarTypeDefinitions));
  assert.equal(registerImmutableIdentity(registry, project, payload, "tenant-b", fingerprint("a"), scalarTypeDefinitions).disposition, "CREATED");

  throwsCode("TRUSTED_TENANT_REQUIRED", () => canonicalIdentityKey(project, payload, "", scalarTypeDefinitions));
  throwsCode("IDENTITY_FIELD_INVALID", () => canonicalIdentityKey(project, payload, "tenant with spaces", scalarTypeDefinitions));
  throwsCode("CALLER_TENANT_FORBIDDEN", () => canonicalIdentityKey(project, { ...payload, tenantId: "attacker" }, "tenant-a", scalarTypeDefinitions));
  throwsCode("IDENTITY_FIELD_INVALID", () => canonicalIdentityKey(project, { projectId: " " }, "tenant-a", scalarTypeDefinitions));
  throwsCode("UNKNOWN_IDENTITY_FIELD", () => canonicalIdentityKey(project, { ...payload, digest: "sha256:abc" }, "tenant-a", scalarTypeDefinitions));
  throwsCode("IMMUTABLE_FINGERPRINT_INVALID", () => registerImmutableIdentity(registry, project, payload, "tenant-a", "different-immutable-content", scalarTypeDefinitions));
  throwsCode("IDENTITY_COLLISION", () => registerImmutableIdentity(registry, project, payload, "tenant-a", fingerprint("b"), scalarTypeDefinitions));
  throwsCode("SOURCE_OBSERVATION_NOT_CANONICAL", () => canonicalIdentityKey(records.get("media.domain.stream-session"), { sessionId: "s-1" }, "tenant-a", scalarTypeDefinitions));
  const lease = records.get("media.domain.job-lease");
  throwsCode("IDENTITY_FIELD_INVALID", () => canonicalIdentityKey(lease, { jobId: "j-1", ownerId: "w-1", fencingToken: Number.MAX_SAFE_INTEGER + 1 }, "tenant-a", scalarTypeDefinitions));
  throwsCode("IDENTITY_FIELD_INVALID", () => canonicalIdentityKey(lease, { jobId: "j-1", ownerId: "w-1", fencingToken: 0 }, "tenant-a", scalarTypeDefinitions));
  const foreignTenantType = structuredClone(project);
  foreignTenantType.identityComponents[0].scalarTypeRef = "foreign-owner.yaml#capabilityOperationContracts/scalarTypes/opaque-id";
  throwsCode("IDENTITY_TYPE_UNRESOLVED", () => canonicalIdentityKey(foreignTenantType, payload, "tenant-a", scalarTypeDefinitions));
  const foreignComponentType = structuredClone(project);
  foreignComponentType.identityComponents[1].scalarTypeRef = "foreign-owner.yaml#capabilityOperationContracts/scalarTypes/opaque-id";
  throwsCode("IDENTITY_TYPE_UNRESOLVED", () => canonicalIdentityKey(foreignComponentType, payload, "tenant-a", scalarTypeDefinitions));
});

test("shared subtype identity namespaces collide on the canonical ProcessingJob tuple", () => {
  const processing = structuredClone(records.get("media.domain.processing-job"));
  const render = structuredClone(records.get("media.domain.render-job"));
  const verification = structuredClone(records.get("media.domain.artifact-verification-job"));
  assert.equal(render.canonicalIdentityNamespaceRef, "media.domain.processing-job");
  assert.equal(verification.canonicalIdentityNamespaceRef, "media.domain.processing-job");
  for (const contract of [render, verification]) {
    assert.equal(contract.canonicalIdentityNamespaceSourceRef, ".product-experience/pdp-1-domain-data/domain-objects.yaml#media.domain.processing-job");
    assert.ok(canonicalObjectRefs.has(contract.canonicalIdentityNamespaceRef));
  }
  const processingKey = canonicalIdentityKey(processing, { jobId: "job-1" }, "tenant-a", scalarTypeDefinitions, canonicalObjectRefs);
  assert.equal(canonicalIdentityKey(render, { jobId: "job-1" }, "tenant-a", scalarTypeDefinitions, canonicalObjectRefs), processingKey);
  assert.equal(canonicalIdentityKey(verification, { jobId: "job-1" }, "tenant-a", scalarTypeDefinitions, canonicalObjectRefs), processingKey);
  assert.notEqual(canonicalIdentityKey(render, { jobId: "job-2" }, "tenant-a", scalarTypeDefinitions, canonicalObjectRefs), processingKey);
  throwsCode("IDENTITY_NAMESPACE_UNRESOLVED", () => canonicalIdentityKey(render, { jobId: "job-1" }, "tenant-a", scalarTypeDefinitions));
  throwsCode("IDENTITY_NAMESPACE_UNRESOLVED", () => canonicalIdentityKey({ ...render, canonicalIdentityNamespaceSourceRef: "foreign.yaml#media.domain.processing-job" }, { jobId: "job-1" }, "tenant-a", scalarTypeDefinitions, canonicalObjectRefs));
  throwsCode("IDENTITY_NAMESPACE_UNRESOLVED", () => canonicalIdentityKey({ ...render, canonicalIdentityNamespaceRef: "media.domain.not-a-job", canonicalIdentityNamespaceSourceRef: ".product-experience/pdp-1-domain-data/domain-objects.yaml#media.domain.not-a-job" }, { jobId: "job-1" }, "tenant-a", scalarTypeDefinitions, canonicalObjectRefs));
});

test("every canonical identity tuple has an executable typed positive and missing/malformed negative",()=>{
  const valueFor=(component)=>{
    const constraint=component.inlineConstraint;
    if(constraint?.type==="integer")return constraint.minimum??1;
    const type=component.scalarTypeRef.split("/").at(-1);
    const rule=scalarTypeDefinitions[type].validator;
    const candidates=["id-1","v1","1.0.0","artifact:v1","https://example.test/id","sha256:"+"a".repeat(64),"a"];
    const value=candidates.find(candidate=>candidate.length>=(rule.minLength??0)&&candidate.length<=(rule.maxLength??Infinity)&&(!rule.pattern||new RegExp(rule.pattern).test(candidate)));
    assert.ok(value,`test fixture can satisfy declared scalar ${type}`);
    return value;
  };
  const canonical=source.records.filter(row=>row.canonicalDisposition==="CANONICAL_MEDIA_IDENTITY");
  for(const record of canonical){
    const body=Object.fromEntries(record.identityComponents.filter(c=>c.field!=="tenantId").map(c=>[c.field,valueFor(c)]));
    const key=canonicalIdentityKey(record,body,"tenant-1",scalarTypeDefinitions,canonicalObjectRefs);
    assert.equal(canonicalIdentityKey(record,{...body},"tenant-1",scalarTypeDefinitions,canonicalObjectRefs),key,`${record.objectRef} tuple is stable`);
    for(const component of record.identityComponents.filter(c=>c.field!=="tenantId")){
      const missing={...body};delete missing[component.field];
      throwsCode("IDENTITY_FIELD_REQUIRED",()=>canonicalIdentityKey(record,missing,"tenant-1",scalarTypeDefinitions,canonicalObjectRefs));
      const malformed={...body,[component.field]:component.inlineConstraint?.type==="integer"?Number.MAX_SAFE_INTEGER+1:123};
      throwsCode("IDENTITY_FIELD_INVALID",()=>canonicalIdentityKey(record,malformed,"tenant-1",scalarTypeDefinitions,canonicalObjectRefs));
    }
  }
});

test("version identity is independent from digest and lineage rejects cross-tenant, kind-mismatch, and cycles", () => {
  const version = records.get("media.domain.artifact-version");
  const registry = new Map();
  const v1 = { artifactId: "a-1", versionId: "v1" };
  const v2 = { artifactId: "a-1", versionId: "v2" };
  const key1 = canonicalIdentityKey(version, v1, "tenant-a", scalarTypeDefinitions);
  const key2 = canonicalIdentityKey(version, v2, "tenant-a", scalarTypeDefinitions);
  assert.notEqual(key1, key2);
  assert.equal(registerImmutableIdentity(registry, version, v1, "tenant-a", fingerprint("c"), scalarTypeDefinitions).disposition, "CREATED");
  assert.equal(registerImmutableIdentity(registry, version, v2, "tenant-a", fingerprint("c"), scalarTypeDefinitions).disposition, "CREATED");
  assert.equal(validateAcyclicSameTenantLineage([{kind:"version-parent",from:{objectRef:version.objectRef,tenantId:"tenant-a",artifactId:"a-1",versionId:"v2"},to:{objectRef:version.objectRef,tenantId:"tenant-a",artifactId:"a-1",versionId:"v1"}}],[...records.values()],scalarTypeDefinitions).acyclic, true);
  throwsCode("CROSS_TENANT_LINEAGE", () => validateAcyclicSameTenantLineage([{kind:"version-parent",from:{objectRef:version.objectRef,tenantId:"tenant-a",artifactId:"a-1",versionId:"v2"},to:{objectRef:version.objectRef,tenantId:"tenant-b",artifactId:"a-1",versionId:"v1"}}],[...records.values()],scalarTypeDefinitions));
  throwsCode("LINEAGE_OBJECT_KIND_MISMATCH", () => validateAcyclicSameTenantLineage([{kind:"version-parent",from:{objectRef:version.objectRef,tenantId:"tenant-a",artifactId:"a-1",versionId:"v2"},to:{objectRef:"media.domain.project-revision",tenantId:"tenant-a",projectId:"p-1",revisionId:"r-1"}}],[...records.values()],scalarTypeDefinitions));
  throwsCode("IDENTITY_FIELD_REQUIRED", () => validateAcyclicSameTenantLineage([{kind:"version-parent",from:{objectRef:version.objectRef,tenantId:"tenant-a",versionId:"v2"},to:{objectRef:version.objectRef,tenantId:"tenant-a",artifactId:"a-1",versionId:"v1"}}],[...records.values()],scalarTypeDefinitions));
  throwsCode("UNKNOWN_IDENTITY_FIELD", () => validateAcyclicSameTenantLineage([{kind:"version-parent",from:{objectRef:version.objectRef,tenantId:"tenant-a",artifactId:"a-1",versionId:"v2",extra:"noise"},to:{objectRef:version.objectRef,tenantId:"tenant-a",artifactId:"a-1",versionId:"v1"}}],[...records.values()],scalarTypeDefinitions));
  throwsCode("LINEAGE_RELATION_KIND_INVALID", () => validateAcyclicSameTenantLineage([{kind:"made-up-kind",from:{objectRef:version.objectRef,tenantId:"tenant-a",artifactId:"a-1",versionId:"v2"},to:{objectRef:version.objectRef,tenantId:"tenant-a",artifactId:"a-1",versionId:"v1"}}],[...records.values()],scalarTypeDefinitions));
  throwsCode("LINEAGE_CYCLE", () => validateAcyclicSameTenantLineage([
    {kind:"version-parent",from:{versionId:"v1",artifactId:"a-1",tenantId:"tenant-a",objectRef:version.objectRef},to:{versionId:"v2",artifactId:"a-1",tenantId:"tenant-a",objectRef:version.objectRef}},
    {kind:"version-parent",from:{objectRef:version.objectRef,tenantId:"tenant-a",artifactId:"a-1",versionId:"v2"},to:{objectRef:version.objectRef,tenantId:"tenant-a",artifactId:"a-1",versionId:"v1"}},
  ],[...records.values()],scalarTypeDefinitions));
});
