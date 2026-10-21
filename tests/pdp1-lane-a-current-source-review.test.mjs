import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const base = ".product-experience/pdp-1-domain-data/";
const review = JSON.parse(readFileSync("docs/implementation/verification/pdp-1/lane-a-current-source-review.json", "utf8"));
const objects = parse(readFileSync(`${base}domain-objects.yaml`, "utf8"));
const relations = parse(readFileSync(`${base}relationships.yaml`, "utf8"));
const reconciliation = parse(readFileSync(`${base}canonical-reconciliation.yaml`, "utf8"));
const values = parse(readFileSync(`${base}value-objects.yaml`, "utf8"));
const versioning = parse(readFileSync(`${base}versioning.yaml`, "utf8"));
const interop = parse(readFileSync(`${base}interoperability.yaml`, "utf8"));
const stateTruth = parse(readFileSync(".product-experience/pdp-0-product-truth/state-models.yaml", "utf8"));
const productTruth = parse(readFileSync(".product-experience/pdp-0-product-truth/domain-model.yaml", "utf8"));
const timeFidelity = parse(readFileSync(".product-experience/pdp-0-product-truth/time-units-fidelity.yaml", "utf8"));

const fingerprint = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

test("Lane A current-source review binds exact reviewed inputs and preserves historical pins", () => {
  for (const [path, expected] of Object.entries(review.sourceFingerprints)) {
    assert.equal(fingerprint(path), expected, `${path} changed after the current source review`);
  }
  assert.match(review.historicalPins.identity, /PXD-093.*historical/u);
  assert.match(review.historicalPins.relationships, /PXD-140.*acceptanceEffect:none/u);
  assert.equal(review.acceptanceEffect, "none");
  assert.equal(review.runtimeStorageAndWireParity, "NOT_ADMITTED");
  assert.equal(review.independentReviewAndQualification, "NOT_EVALUATED");
});

test("Lane A reconciles the current PDP-0 product clocks without promoting decode timestamps", () => {
  const reconciliation = review.currentPdp0TemporalReconciliation;
  assert.equal(reconciliation.sourcePath, ".product-experience/pdp-0-product-truth/time-units-fidelity.yaml");
  assert.equal(reconciliation.currentSourceSha256, review.sourceFingerprints[reconciliation.sourcePath]);
  assert.deepEqual(reconciliation.clockDomainIds, timeFidelity.productTruthClockDomains.domainIds);
  assert.deepEqual(reconciliation.excludedDecodeMetadata, ["DTS"]);
  assert.match(review.reviewFindings.find(({ id }) => id === "temporal-spatial-precision-and-loss").meaning,
    /five distinct product clock domains.*DTS remains ordering metadata/iu);
});

test("Lane A populations remain distinct and current relationship endpoints resolve to exact tenant-scoped identities", () => {
  assert.equal(objects.objects.length, 39);
  assert.equal(objects.ownerTypedIdentityContracts.records.length, 38);
  assert.equal(values.values.length, 13);
  assert.equal(relations.relationships.length, 13);
  assert.equal(review.population.historicalRelationshipCount, 11);
  assert.deepEqual(review.objectReview.map(({ objectId }) => objectId), objects.objects.map(({ id }) => id));
  assert.equal(review.objectReview.length, 39, "every catalog object has an explicit identity and remaining-scope disposition");
  assert.equal(review.objectReview.filter(({ classification }) => classification.startsWith("MEDIA_LOGICAL_IDENTITY_DEFINED")).length, 37);
  assert.equal(review.objectReview.filter(({ classification }) => classification.startsWith("SOURCE_OBSERVATION_ONLY")).length, 1);
  assert.equal(review.objectReview.filter(({ classification }) => classification.startsWith("LEGACY_OBSERVATION_EXCLUDED")).length, 1);
  assert.deepEqual(review.relationshipReview.map(({ relationshipId }) => relationshipId), relations.relationships.map(({ id }) => id));
  assert.deepEqual(review.valueReview.map(({ valueId }) => valueId), values.values.map(({ id }) => id));
  assert.equal(review.valueReview.length, 13);
  assert.equal(relations.relationshipPopulationAdjudication.observedRelationshipCount, 13);
  assert.equal(relations.relationshipPopulationAdjudication.acceptanceEffect, "none");

  const objectIds = new Set(objects.objects.map(({ id }) => id));
  const identityByObject = new Map(objects.ownerTypedIdentityContracts.records.map((row) => [row.objectRef, row]));
  for (const relationship of relations.relationships) {
    const from = Array.isArray(relationship.from) ? relationship.from : [relationship.from];
    const to = Array.isArray(relationship.to) ? relationship.to : [relationship.to];
    assert.ok(relationship.ownerDefinition, `${relationship.id} has an owner definition`);
    for (const endpoint of [...from, ...to]) {
      assert.ok(objectIds.has(endpoint), `${relationship.id} endpoint is catalogued`);
      assert.ok(identityByObject.has(endpoint), `${relationship.id} endpoint has an identity contract`);
    }
    const bindings = [
      ...relationship.ownerDefinition.parentIdentityContracts,
      ...relationship.ownerDefinition.childIdentityContracts,
    ];
    for (const binding of bindings) {
      const identity = identityByObject.get(binding.objectRef);
      assert.equal(binding.identityTuple[0], "tenantId", `${relationship.id} rejects untrusted cross-tenant joins`);
      assert.deepEqual(binding.identityTuple, identity.canonicalIdentityTuple, `${relationship.id} binds the full canonical identity`);
    }
    assert.match(relationship.ownerDefinition.runtimeParity, /NOT_ADMITTED/u);
  }

  const transcription = identityByObject.get("media.domain.transcription");
  assert.equal(transcription, undefined, "legacy transcription UUID cannot become canonical transcript identity");
  assert.equal(identityByObject.get("media.domain.persisted-audio-file").canonicalDisposition,
    "SOURCE_OBSERVATION_NON_EQUIVALENCE");
});

test("open canonical questions are classified into Media definition and genuinely external or implementation residuals", () => {
  const adjudications = reconciliation.currentDefinitionAdjudication.records;
  assert.deepEqual(adjudications.map(({ id }) => id), reconciliation.openDecisions.map(({ id }) => id));
  for (const row of adjudications) {
    assert.match(row.classification, /MEDIA_LOGICAL_MEANING_RESOLVED/u);
    assert.ok(row.disposition.length > 40);
    assert.ok(row.definitionRefs.length > 0);
    assert.ok(row.remaining.length > 20);
  }
  assert.match(adjudications.find(({ id }) => id === "canonical-tenant-and-global-identity").remaining, /external identity/u);
  assert.match(adjudications.find(({ id }) => id === "canonical-artifact-version-and-lineage").disposition, /digest.*never.*version key/u);
  assert.match(adjudications.find(({ id }) => id === "canonical-job-and-attempt-history").disposition, /fencing token.*not attempt identity/u);
  assert.match(adjudications.find(({ id }) => id === "consent-and-rights-authority").disposition, /remain distinct/u);
});

test("all interoperability residuals have an explicit ownership/deferment classification", () => {
  const rows = interop.unresolvedItemAdjudication.items;
  assert.deepEqual(rows.map(({ id }) => id), interop.unresolved);
  assert.deepEqual(rows.map(({ id }) => id), [
    "canonical-versioned-domain-wire-schema", "artifact-version-key-and-byte-identity-contract",
    "complete-transcript-caption-and-derived-artifact-ancestry", "exact-runtime-contract-path-and-operation-map-for-each-protobuf-family",
    "consumer-inventory-and-compatibility-proof", "verified-cross-product-artifact-reference-and-version-semantics",
    "tool-protocol-and-SDK-release-support-status", "spatial-frame-transform-registry-and-3d-algorithm",
    "provider-signal-calibration-and-cross-provider-equivalence",
  ]);
  assert.equal(rows.length, 9);
  for (const row of rows) {
    assert.match(row.classification, /DEFERRED|REQUIRED/u);
    assert.ok(row.disposition.length > 30);
    assert.ok(row.remainingEvidence.length > 20);
    assert.ok(row.sourceRefs.length > 0);
  }
  assert.equal(rows.find(({ id }) => id === "artifact-version-key-and-byte-identity-contract").classification,
    "MEDIA_LOGICAL_MEANING_RESOLVED; IMPLEMENTATION_DEFERRED");
  assert.equal(rows.find(({ id }) => id === "consumer-inventory-and-compatibility-proof").classification,
    "EXTERNAL_OWNER_EVIDENCE_REQUIRED");
  assert.equal(rows.find(({ id }) => id === "spatial-frame-transform-registry-and-3d-algorithm").classification,
    "MEDIA_DECLARATION_SEMANTICS_DEFINED; IMPLEMENTATION_AND_SCIENTIFIC_QUALIFICATION_DEFERRED");
  assert.equal(rows.find(({ id }) => id === "provider-signal-calibration-and-cross-provider-equivalence").classification,
    "MEDIA_SCOPED_SIGNAL_SEMANTICS_DEFINED; PROVIDER_AND_SCIENTIFIC_EVIDENCE_REQUIRED");
});

test("all 13 value meanings have explicit conservative dispositions and temporal/spatial conversions fail closed", () => {
  const rows = values.valueDefinitionAdjudication.records;
  assert.deepEqual(rows.map(({ valueRef }) => valueRef), values.values.map(({ id }) => id));
  assert.equal(rows.length, 13);
  assert.match(rows.find(({ valueRef }) => valueRef === "media.value.duration").rule, /unqualified duration.*cannot be silently converted/u);
  assert.match(rows.find(({ valueRef }) => valueRef === "media.value.frame-rate").rule, /not promoted to rational or constant cadence/u);
  assert.match(rows.find(({ valueRef }) => valueRef === "media.value.physical-quantity").rule, /cannot default/u);
  assert.match(values.canonicalConversionDefinitions.records.find(({ id }) => id === "media.value.rational-media-time").failClosed,
    /unknown units\/clocks.*overflow/u);
  assert.match(values.canonicalConversionDefinitions.records.find(({ id }) => id === "media.value.image-pixel-boundary").failClosed,
    /stale image version/u);
  assert.equal(values.canonicalConversionDefinitions.machineContract.qualification, "NOT_EVALUATED");
});

test("versioning rule inventory resolves Media semantics while identifying implementation and external evidence separately", () => {
  const rows = versioning.definitionAdjudication.ruleDispositions;
  assert.deepEqual(rows.map(({ ruleId }) => ruleId), versioning.rules.map(({ id }) => id));
  assert.equal(rows.length, 9);
  for (const row of rows) {
    assert.ok(row.classification.length > 10);
    assert.ok(row.definition.length > 30);
    assert.ok(row.sourceRefs.length > 0);
    assert.ok(row.notEstablished.length > 20);
  }
  assert.match(rows.find(({ ruleId }) => ruleId === "derived-artifact-identity").definition, /acyclic/u);
  assert.match(rows.find(({ ruleId }) => ruleId === "wire-compatibility").notEstablished, /external acceptance/u);
});

test("the 21 proposal-scope object records have bounded source-backed logical definitions without scope-status promotion", () => {
  const rows = objects.ownerDefinedLogicalSemantics.records;
  const expected = [
    "media.domain.media-asset", "media.domain.recipe", "media.domain.processing-graph",
    "media.domain.resolved-plan", "media.domain.media-run", "media.domain.checkpoint",
    "media.domain.scene-plan", "media.domain.scene-brief", "media.domain.scene-graph",
    "media.domain.animation-graph", "media.domain.simulation-world", "media.domain.timeline",
    "media.domain.composition-config", "media.domain.continuity-state", "media.domain.quality-assessment",
    "media.domain.render-outcome", "media.domain.delivery-outcome", "media.domain.rights-decision",
    "media.domain.provenance-manifest", "media.domain.consent-reference", "media.domain.generation-control-bundle",
  ];
  assert.deepEqual(rows.map(({ objectRef }) => objectRef), expected);
  assert.equal(rows.length, 21);
  assert.match(objects.ownerDefinedLogicalSemantics.status, /^OWNER_DEFINED_LOGICAL_DEFINITION_ONLY/u);
  const currentObjectReview = new Map(review.objectReview.map((record) => [record.objectId, record]));
  const identities = new Map(objects.ownerTypedIdentityContracts.records.map((record) => [record.id, record]));
  const relationshipsById = new Map(relations.relationships.map((record) => [record.id, record]));
  const catalogIds = new Set((productTruth.proposedRecordCatalog ?? []).map(({ id }) => id));
  const stateModelIds = new Set((stateTruth.models ?? []).map(({ modelId }) => modelId));
  for (const row of rows) {
    assert.ok(row.identityRule && row.lifecycleRule && row.sourceOrParentRule && row.unknownBehavior);
    assert.match(row.unknownBehavior, /unknown|missing|unavailable|blocks|denies/iu);
    assert.equal(row.sourceRefs.some((ref) => ref.includes("domain-model.yaml#")), true, `${row.objectRef} cites PDP-0 domain meaning`);
    const object = objects.objects.find(({ id }) => id === row.objectRef);
    assert.ok(object, `${row.objectRef} resolves to the object catalog`);
    assert.equal(object.scopeStatus, currentObjectReview.get(row.objectRef).currentScopeStatus,
      `${row.objectRef} keeps its existing independent/materialization boundary`);
    const identityId = row.identityContractRef.split("@id=")[1];
    assert.deepEqual(row.identityContractRef.startsWith(`${base}domain-objects.yaml#ownerTypedIdentityContracts/records/@id=`), true);
    assert.ok(identities.has(identityId), `${row.objectRef} points to a current identity contract`);
    const tuple = identities.get(identityId).canonicalIdentityTuple;
    assert.equal(tuple[0], "tenantId", `${row.objectRef} remains tenant scoped`);
    for (const relationshipId of row.relationshipRefs) {
      const relationship = relationshipsById.get(relationshipId);
      assert.ok(relationship, `${row.objectRef} cites a current relationship`);
      assert.ok([relationship.from, relationship.to].flat().includes(row.objectRef),
        `${row.objectRef} is an endpoint of ${relationshipId}`);
      assert.equal(relationship.ownerDefinition.sameTenantRequired, true);
    }
    for (const ref of row.sourceRefs) {
      const [path, anchor] = ref.split("#", 2);
      assert.ok(readFileSync(path), `${row.objectRef} source file exists: ${path}`);
      if (path.endsWith("domain-model.yaml") && anchor) assert.ok(catalogIds.has(anchor), `${row.objectRef} P0 anchor exists: ${anchor}`);
      if (path.endsWith("state-models.yaml") && anchor?.startsWith("models/@modelId=")) {
        assert.ok(stateModelIds.has(anchor.split("=")[1]), `${row.objectRef} state model exists: ${anchor}`);
      }
    }
  }

  assert.match(rows.find(({ objectRef }) => objectRef === "media.domain.simulation-world").unknownBehavior,
    /blocks quantitative\/scientific claims/u);
  assert.match(rows.find(({ objectRef }) => objectRef === "media.domain.delivery-outcome").unknownBehavior,
    /remains UNKNOWN/u);
  assert.match(rows.find(({ objectRef }) => objectRef === "media.domain.rights-decision").unknownBehavior,
    /blocks rights-dependent effects/u);
  assert.match(rows.find(({ objectRef }) => objectRef === "media.domain.provenance-manifest").sourceOrParentRule,
    /no fabricated source version/u);
  const consent = rows.find(({ objectRef }) => objectRef === "media.domain.consent-reference");
  assert.deepEqual(identities.get(consent.identityContractRef.split("@id=")[1]).canonicalIdentityTuple,
    ["tenantId", "consentId", "consentRevisionId"]);
  assert.deepEqual(consent.relationshipRefs, [], "consent reference must not imply permission or a new relation");
  assert.match(consent.unknownBehavior, /blocks consent-dependent work/u);
  assert.match(consent.deferredBoundary, /owns decision issuance\/currentness/u);
  const controls = rows.find(({ objectRef }) => objectRef === "media.domain.generation-control-bundle");
  assert.deepEqual(identities.get(controls.identityContractRef.split("@id=")[1]).canonicalIdentityTuple,
    ["tenantId", "controlBundleId", "semanticVersion"]);
  assert.deepEqual(controls.relationshipRefs, [], "generation controls do not synthesize ancestry edges");
  assert.match(controls.sourceOrParentRule, /does not create a derived-source edge/u);
  assert.match(controls.unknownBehavior, /blocks that dependent mapping/u);
  assert.match(objects.objects.find(({ id }) => id === consent.objectRef).scopeStatus, /consent-authority-remains-governed-by-PDP-0.*pending-owner-review/u);
  assert.match(objects.objects.find(({ id }) => id === controls.objectRef).scopeStatus, /does-not-assert-model-or-identity-truth.*pending-owner-review/u);
  assert.match(productTruth.proposedRecordCatalog.find(({ id }) => id === "ConsentReference-RightsDecision-ProvenanceManifest").meaning,
    /Separate authority references for permission, lawful\/contractual permitted use, and observed creation history/u);
  assert.match(productTruth.proposedRecordCatalog.find(({ id }) => id === "GenerationControlBundle").stateBoundary,
    /do not imply model\/identity truth/u);
  const rightsConsent = stateTruth.models.find(({ modelId }) => modelId === "media-rights-and-consent");
  assert.ok(rightsConsent.invariants.includes("consent-is-bound-to-tenant-principal-purpose-region-and-validity"));
  assert.ok(rightsConsent.invariants.includes("caller-supplied-consent-ids-and-booleans-are-intent-not-authority"));
});
