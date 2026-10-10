import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const base = ".product-experience/pdp-1-domain-data/";
const objects = parse(readFileSync(`${base}domain-objects.yaml`, "utf8"));
const values = parse(readFileSync(`${base}value-objects.yaml`, "utf8"));
const relationships = parse(readFileSync(`${base}relationships.yaml`, "utf8"));
const reconciliation = parse(readFileSync(`${base}canonical-reconciliation.yaml`, "utf8"));
const versioning = parse(readFileSync(`${base}versioning.yaml`, "utf8"));
const expectedRelationships = [
  ["media.rel.project-revision", "media.domain.project", "media.domain.project-revision"],
  ["media.rel.project-asset", "media.domain.project", "media.domain.media-asset"],
  ["media.rel.asset-artifact-version", "media.domain.media-asset", "media.domain.artifact-version"],
  ["media.rel.job-plan", "media.domain.processing-job", "media.domain.resolved-plan"],
  ["media.rel.job-attempt", "media.domain.processing-job", "media.domain.job-attempt"],
  ["media.rel.attempt-lease", "media.domain.job-attempt", "media.domain.job-lease"],
  ["media.rel.upload-session-chunk", "media.domain.upload-session", "media.domain.upload-chunk"],
  ["media.rel.stream-session-frame", "media.domain.stream-session", "media.domain.stream-frame"],
  ["media.rel.run-checkpoint", "media.domain.media-run", "media.domain.checkpoint"],
  ["media.rel.scene-model-binding", "media.domain.scene-graph", "media.domain.simulation-world"],
  ["media.rel.animation-property-owner", "media.domain.animation-graph", "media.domain.scene-graph"],
  ["media.rel.derived-artifact", "media.domain.artifact-version", "media.domain.artifact-version"],
  ["media.rel.assessment-subject", "media.domain.quality-assessment", ["media.domain.artifact-version", "media.domain.processing-job", "media.domain.media-run"]],
];

function assertRelationshipReferencesValid(rows, identityContracts) {
  const identities = new Map(identityContracts.map((row) => [row.objectRef, row.canonicalIdentityTuple]));
  const objectsById = new Set(objects.objects.map((row) => row.id));
  for (const row of rows) {
    const from = Array.isArray(row.from) ? row.from : [row.from];
    const to = Array.isArray(row.to) ? row.to : [row.to];
    for (const endpoint of [...from, ...to]) {
      if (!objectsById.has(endpoint)) throw new Error(`${row.id}: dangling endpoint ${endpoint}`);
      if (!identities.has(endpoint)) throw new Error(`${row.id}: endpoint lacks canonical identity ${endpoint}`);
    }
    const parentRefs = (row.ownerDefinition?.parentIdentityContracts ?? []).map(({ objectRef }) => objectRef);
    const childRefs = (row.ownerDefinition?.childIdentityContracts ?? []).map(({ objectRef }) => objectRef);
    if (JSON.stringify(parentRefs) !== JSON.stringify(from)) throw new Error(`${row.id}: typed parent refs do not match relationship endpoint refs`);
    if (JSON.stringify(childRefs) !== JSON.stringify(to)) throw new Error(`${row.id}: typed child refs do not match relationship endpoint refs`);
    const owner = row.ownerDefinition;
    if (!owner?.sameTenantRequired) throw new Error(`${row.id}: tenant equality is not required`);
    for (const group of [owner.parentIdentityContracts, owner.childIdentityContracts]) {
      for (const binding of group ?? []) {
        if (!objectsById.has(binding.objectRef)) throw new Error(`${row.id}: dangling typed reference ${binding.objectRef}`);
        if (!identities.has(binding.objectRef)) throw new Error(`${row.id}: typed reference lacks canonical identity ${binding.objectRef}`);
        if (binding.identityTuple[0] !== "tenantId") throw new Error(`${row.id}: typed reference omits trusted tenant scope`);
        if (JSON.stringify(binding.identityTuple) !== JSON.stringify(identities.get(binding.objectRef))) {
          throw new Error(`${row.id}: typed reference tuple does not match ${binding.objectRef} canonical identity/version`);
        }
      }
    }
  }
}

test("PDP-1 identity catalog keeps the canonical population distinct from historical observations", () => {
  assert.equal(objects.objects.length, 39);
  assert.equal(values.values.length, 13);
  assert.equal(relationships.relationships.length, 13);
  assert.equal(relationships.relationshipPopulationAdjudication.observedRelationshipCount, 13);
  assert.equal(relationships.relationshipPopulationAdjudication.coordinatorDecisionRef,
    ".product-experience/decision-log.md#PXD-140");
  assert.equal(relationships.relationshipPopulationAdjudication.acceptanceEffect, "none");
  assert.equal(relationships.scopeStatus,
    "coordinator-reviewed-logical-relationship-definitions; storage-and-runtime-parity-not-admitted");
  assert.deepEqual(relationships.relationships.map(({ id }) => id), expectedRelationships.map(([id]) => id),
    "current source inventory intentionally preserves all 13 unique relationship records");
  assert.equal(objects.canonicalIdentityAdjudication.registeredObjectIdentityCount, 38);
  assert.equal(objects.canonicalIdentityAdjudication.canonicalProductObjectCount, 37);

  const objectIds = new Set(objects.objects.map((row) => row.id));
  const identityContracts = objects.ownerTypedIdentityContracts.records;
  const byId = new Map(identityContracts.map((row) => [row.objectRef, row]));
  assert.equal(identityContracts.length, 38);
  assert.equal(new Set(identityContracts.map((row) => row.id)).size, identityContracts.length);

  for (const row of identityContracts) {
    assert.ok(objectIds.has(row.objectRef), `${row.id} points to an existing domain object`);
    assert.ok(row.tenantIsolationRuleRef, `${row.id} declares tenant isolation`);
    assert.ok(row.collisionRuleRef, `${row.id} declares collision handling`);
    if (row.canonicalDisposition === "CANONICAL_MEDIA_IDENTITY") {
      assert.ok(row.canonicalIdentityTuple.length > 0, `${row.id} has a typed identity tuple`);
      assert.deepEqual(row.canonicalIdentityTuple, row.identityComponents.map(({ field }) => field),
        `${row.id} tuple agrees with its typed identity components`);
      for (const component of row.identityComponents) {
        assert.ok(component.scalarTypeRef || component.inlineConstraint,
          `${row.id}.${component.field} has an explicit scalar type or inline constraint`);
        assert.ok(component.origin, `${row.id}.${component.field} declares its authority/source`);
      }
    }
  }

  const persistedAudio = byId.get("media.domain.persisted-audio-file");
  assert.equal(persistedAudio.canonicalDisposition, "SOURCE_OBSERVATION_NON_EQUIVALENCE");
  assert.deepEqual(persistedAudio.canonicalIdentityTuple, []);
  assert.equal(byId.has("media.domain.transcription"), false,
    "legacy transcription UUID observation is not promoted to a canonical identity");
  assert.equal(byId.get("media.domain.transcript-version").canonicalIdentityTuple.join("+"), "tenantId+transcriptVersionId");
});

test("version and lineage references use typed immutable identities, never digests or legacy IDs", () => {
  const artifactVersion = objects.ownerTypedIdentityContracts.records.find((row) => row.objectRef === "media.domain.artifact-version");
  const transcriptVersion = objects.ownerTypedIdentityContracts.records.find((row) => row.objectRef === "media.domain.transcript-version");
  const captionVersion = objects.ownerTypedIdentityContracts.records.find((row) => row.objectRef === "media.domain.caption-version");
  assert.deepEqual(artifactVersion.canonicalIdentityTuple, ["tenantId", "artifactId", "versionId"]);
  assert.deepEqual(transcriptVersion.canonicalIdentityTuple, ["tenantId", "transcriptVersionId"]);
  assert.deepEqual(captionVersion.canonicalIdentityTuple,
    ["tenantId", "sourceArtifactId", "sourceArtifactVersionId", "captionVersionId"]);
  assert.equal(versioning.ownerDefinedRevisionSemantics.artifactVersion.digest,
    "Content digest is computed over canonical bytes; a caller-declared digest is untrusted until verified.");
  assert.match(versioning.ownerDefinedRevisionSemantics.artifactVersion.jobSeparation,
    /jobVersion, attemptId and lease\/fencing token are not artifactVersionId/u);
  assert.ok(relationships.relationships.some((row) => row.id === "media.rel.derived-artifact"),
    "derived artifact version lineage has an explicit relationship record");

  const transcription = reconciliation.concepts.find((row) => row.canonicalRef === "media.domain.transcription");
  assert.match(transcription.disposition, /legacy|unresolved|observation/u);
  assert.match(transcription.observedIdentity, /legacy persistence transcription UUID/u);
});

test("relationship owner contracts pin exact typed endpoints, tenant, cardinality, and missing-reference behavior", () => {
  const objectIds = new Set(objects.objects.map((row) => row.id));
  const relationshipIds = new Set(relationships.relationships.map((row) => row.id));
  assert.equal(new Set(relationshipIds).size, relationships.relationships.length);
  for (const row of relationships.relationships) {
    const endpoints = [...(Array.isArray(row.from) ? row.from : [row.from]), ...(Array.isArray(row.to) ? row.to : [row.to])];
    for (const endpoint of endpoints) assert.ok(objectIds.has(endpoint), `${row.id} endpoint ${endpoint} resolves`);
    assert.ok(row.cardinality, `${row.id} states cardinality`);
    assert.ok(row.sourceRefs.length > 0, `${row.id} retains source references`);
    const owner = row.ownerDefinition;
    assert.ok(owner, `${row.id} has an owner semantic definition`);
    assert.equal(owner.disposition, "OWNER_DEFINED_LOGICAL_RELATIONSHIP_DEFINITION_ONLY");
    assert.equal(owner.sameTenantRequired, true, `${row.id} cannot cross tenant scope`);
    assert.ok(owner.cardinalityRule && owner.exactVersionRule && owner.lifecycleRule && owner.deletionRule,
      `${row.id} defines cardinality, exact version, lifecycle, and deletion semantics`);
    assert.match(owner.runtimeParity, /NOT_ADMITTED/u);
  }
  for (const id of ["media.rel.scene-model-binding", "media.rel.animation-property-owner", "media.rel.derived-artifact", "media.rel.assessment-subject"]) {
    const row = relationships.relationships.find((candidate) => candidate.id === id);
    assert.ok(row.sourceRefs.some((ref) => ref.startsWith(".product-experience/pdp-0-product-truth/")),
      `${id} retains an exact PXD-119 PDP-0 semantic concept ref`);
  }
  assert.match(relationships.relationships.find((row) => row.id === "media.rel.derived-artifact").ownerDefinition.deletionRule,
    /owner-defined lineage graph is acyclic/u);
  assert.ok(relationships.relationships.find((row) => row.id === "media.rel.scene-model-binding").ownerDefinition.deletionRule
    .includes("makes dependent simulation UNKNOWN"));
});

test("all 13 relationships resolve to their exact endpoint identities and reject dangling, cross-tenant, or wrong-version refs", () => {
  const identityContracts = objects.ownerTypedIdentityContracts.records;
  const actual = relationships.relationships;
  assertRelationshipReferencesValid(actual, identityContracts);
  assert.deepEqual(actual.map(({ id, from, to }) => [id, from, to]),
  expectedRelationships,
  "exact relationship IDs and endpoint refs remain reconciled");

  const dangling = structuredClone(actual);
  dangling[0].to = "media.domain.missing-object";
  assert.throws(() => assertRelationshipReferencesValid(dangling, identityContracts), /dangling endpoint/u);

  const wrongTenant = structuredClone(actual);
  wrongTenant[0].ownerDefinition.childIdentityContracts[0].identityTuple.shift();
  assert.throws(() => assertRelationshipReferencesValid(wrongTenant, identityContracts), /omits trusted tenant scope/u);

  const wrongVersion = structuredClone(actual);
  wrongVersion.find((row) => row.id === "media.rel.asset-artifact-version")
    .ownerDefinition.childIdentityContracts[0].identityTuple[2] = "digest";
  assert.throws(() => assertRelationshipReferencesValid(wrongVersion, identityContracts), /canonical identity\/version/u);
});

test("derived artifact lineage is owner-defined acyclic while storage enforcement remains unresolved", () => {
  const derived = relationships.relationships.find((row) => row.id === "media.rel.derived-artifact");
  assert.match(derived.cardinality, /owner-defined-lineage-must-be-acyclic/u);
  assert.match(derived.cardinality, /storage-enforcement-unverified/u);
  assert.match(derived.cardinalityBasis, /PXD-119 owner-defined logical lineage semantics/u);
  assert.match(derived.ownerDefinition.deletionRule, /owner-defined lineage graph is acyclic/u);
  assert.match(derived.ownerDefinition.lineageRule, /directed parent-version lineage.*graph is acyclic/u);
  assert.doesNotMatch(derived.cardinality, /acyclicity-contract-unbound/u);
  assert.equal(derived.ownerDefinition.runtimeParity.startsWith("NOT_ADMITTED"), true);
  assert.equal(relationships.relationshipPopulationAdjudication.pendingOwnerDecisions[0].status,
    "unresolved; no-storage-parity-claimed");
});

test("identity conflict and missing-value rules remain explicit and conservative", () => {
  const rules = new Map(objects.ownerTypedIdentityContracts.tupleRules.map((row) => [row.id, row.rule]));
  assert.match(rules.get("media.identity-rule.trusted-tenant-scope"), /authenticated|trusted/u);
  assert.match(rules.get("media.identity-rule.same-tenant-duplicate-conflict"), /conflict|different|reject/u);
  assert.match(rules.get("media.identity-rule.content-digest-not-identity"), /digest.*identity|identity.*digest/u);
  assert.match(rules.get("media.identity-rule.source-observation-not-promoted"), /source|observation|canonical/u);
  const uncertainty = values.values.find((row) => row.id === "media.value.uncertainty");
  assert.match(uncertainty.rule, /missing-is-not-pass/u);
  assert.equal(values.values.find((row) => row.id === "media.value.policy-disposition").values, "not-enumerated-here");
});
