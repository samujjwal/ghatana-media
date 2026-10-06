import test from "node:test";
import assert from "node:assert/strict";
import { traceMetadataForArtifact } from "../apps/media-experience-explorer/src/specification.ts";
import { parseArtifactIdentityRegistry, validateArtifactIdentities } from "../scripts/generate-media-product-manifest.mjs";

const classes = [
  "CROSS_PHASE_GOVERNANCE", "EXPLORER_PROJECTION", "PRODUCT_TRUTH_AUTHORITY",
  "DOMAIN_DATA_AUTHORITY", "DESIGN_INTERFACE_AUTHORITY", "PRODUCT_EXPERIENCE_AUTHORITY",
];

function registryFixture({ duplicateRoot = false, duplicateRecordField = false, unknownField = false } = {}) {
  return [
    "schemaVersion: media.artifact-identities.v1",
    "status: PROPOSED_PENDING_OWNER_REVIEW",
    ...(duplicateRoot ? ["status: DUPLICATE"] : []),
    "purpose: Test identity registry",
    "inventoryPolicy:",
    "  locationMetadata: Repository relative paths",
    "  identityPolicy: Explicit pinned identity",
    "  classificationPolicy: Explicit authority class",
    "  selfExclusion: Registry excluded from inventory",
    "allowedAuthorityClasses:",
    ...classes.map((value) => `  - ${JSON.stringify(value)}`),
    "manifestProjection:",
    '  path: ".product-experience/source-manifest.yaml"',
    '  artifactId: "ART-MEDIA-SOURCE-MANIFEST"',
    '  authorityClass: "CROSS_PHASE_GOVERNANCE"',
    "records:",
    '  - path: ".product-experience/fixture.yaml"',
    '    artifactId: "ART-MEDIA-FIXTURE"',
    ...(duplicateRecordField ? ['    artifactId: "ART-MEDIA-DUPLICATE"'] : []),
    '    authorityClass: "PRODUCT_EXPERIENCE_AUTHORITY"',
    ...(unknownField ? ['    semanticAuthority: "not-allowed"'] : []),
  ].join("\n");
}

function record({ artifactId, authorityClass, path }) {
  return [
    `  - artifactId: ${artifactId}`,
    "    title: Fixture",
    `    authorityClass: ${authorityClass}`,
    "    owningPhase: PDP-2",
    `    path: ${path}`,
    "    dependencies: []",
    "    dependents: []",
  ].join("\n");
}

test("relocating an artifact changes its location but not its canonical identity", () => {
  const artifactId = "ART-MEDIA-CANONICAL-001";
  const original = {
    artifactId,
    authorityClass: "DESIGN_INTERFACE_AUTHORITY",
    phase: "PDP-2",
    path: ".product-experience/pdp-2-design-interface-system/components.yaml",
    title: "Components",
  };
  const relocated = {
    ...original,
    path: ".product-experience/pdp-2-design-interface-system/library/components.yaml",
  };
  const originalManifest = record({ ...original, path: original.path });
  const relocatedManifest = record({ ...relocated, path: relocated.path });

  const before = traceMetadataForArtifact(original, originalManifest);
  const after = traceMetadataForArtifact(relocated, relocatedManifest);

  assert.equal(before.stableId, artifactId);
  assert.equal(after.stableId, artifactId);
  assert.equal(before.canonicalArtifactId, after.canonicalArtifactId);
  assert.notEqual(before.canonicalLocation, after.canonicalLocation);
});

test("Explorer classification follows manifest authority metadata, not the phase", () => {
  const artifact = {
    artifactId: "ART-MEDIA-CLASS-001",
    authorityClass: "STALE_INDEX_VALUE",
    phase: "PDP-2",
    path: ".product-experience/reclassified.yaml",
    title: "Reclassified",
  };
  const sourceManifest = record({
    artifactId: artifact.artifactId,
    authorityClass: "CROSS_PHASE_GOVERNANCE",
    path: artifact.path,
  });

  assert.equal(traceMetadataForArtifact(artifact, sourceManifest).authorityClass, "CROSS_PHASE_GOVERNANCE");
});

test("missing manifest authority remains unresolved instead of being inferred", () => {
  const artifact = {
    artifactId: "ART-MEDIA-UNBOUND",
    authorityClass: "UNTRUSTED_INDEX_VALUE",
    phase: "PDP-3",
    path: ".product-experience/not-in-manifest.yaml",
    title: "Unbound",
  };

  const metadata = traceMetadataForArtifact(artifact, "");
  assert.equal(metadata.authorityClass, "Not resolved from source manifest");
  assert.equal(metadata.canonicalArtifactId, "Not resolved from source manifest");
  assert.equal(metadata.currentness, "NOT_GENERATED_CURRENTNESS_YAML_INTENTIONALLY_ABSENT");
});

test("a relocated source retains its explicitly pinned identity", () => {
  const before = { path: ".product-experience/old-location.yaml", artifactId: "ART-MEDIA-8A2F64E9D0B14327C6A1", authorityClass: "CROSS_PHASE_GOVERNANCE" };
  const after = { ...before, path: ".product-experience/new-location.yaml" };
  const priorRegistry = validateArtifactIdentities([before], [before.path]);
  const relocatedRegistry = validateArtifactIdentities([after], [after.path]);
  assert.equal(priorRegistry.get(before.path).artifactId, "ART-MEDIA-8A2F64E9D0B14327C6A1");
  assert.equal(relocatedRegistry.get(after.path).artifactId, priorRegistry.get(before.path).artifactId);
});

test("identity coverage rejects missing records and duplicate paths or IDs", () => {
  const first = { path: "a.yaml", artifactId: "ART-MEDIA-OPAQUE-A", authorityClass: "CROSS_PHASE_GOVERNANCE" };
  const second = { path: "b.yaml", artifactId: "ART-MEDIA-OPAQUE-B", authorityClass: "EXPLORER_PROJECTION" };

  assert.throws(() => validateArtifactIdentities([first], ["a.yaml", "b.yaml"], classes), /missing: b\.yaml/u);
  assert.throws(() => validateArtifactIdentities([first, { ...second, path: "a.yaml" }], ["a.yaml"], classes), /Duplicate artifact identity path/u);
  assert.throws(() => validateArtifactIdentities([first, { ...second, artifactId: first.artifactId }], ["a.yaml", "b.yaml"], classes), /Duplicate artifactId/u);
});

test("registry rejects authority classes outside its allowed vocabulary", () => {
  const record = { path: "a.yaml", artifactId: "ART-MEDIA-A", authorityClass: "UNAPPROVED_CLASS" };
  assert.throws(() => validateArtifactIdentities([record], [record.path], classes), /Unknown authorityClass/u);
  assert.throws(() => validateArtifactIdentities([], [], classes, {
    path: "manifest.yaml", artifactId: "ART-MEDIA-MANIFEST", authorityClass: "UNAPPROVED_CLASS",
  }), /Unknown authorityClass/u);
});

test("registry YAML profile rejects duplicate keys and unknown fields", () => {
  assert.equal(parseArtifactIdentityRegistry(registryFixture()).records.length, 1);
  assert.throws(() => parseArtifactIdentityRegistry(registryFixture({ duplicateRoot: true })), /Duplicate YAML key 'status'/u);
  assert.throws(() => parseArtifactIdentityRegistry(registryFixture({ duplicateRecordField: true })), /Duplicate YAML key 'artifactId'/u);
  assert.throws(() => parseArtifactIdentityRegistry(registryFixture({ unknownField: true })), /Unknown artifact identity field 'semanticAuthority'/u);
});

test("manifest projection identity cannot collide with a source artifact identity", () => {
  const source = { path: "a.yaml", artifactId: "ART-MEDIA-DUPLICATE", authorityClass: "CROSS_PHASE_GOVERNANCE" };
  const projection = { path: "manifest.yaml", artifactId: source.artifactId, authorityClass: "CROSS_PHASE_GOVERNANCE" };
  assert.throws(() => validateArtifactIdentities([source], [source.path], classes, projection), /Manifest projection artifactId collides/u);
});
