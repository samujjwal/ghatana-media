import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const observationPath = "docs/implementation/verification/pdp-38/p0-capability-semantic-current-source-review.json";
const sourcePath = ".product-experience/pdp-0-product-truth/capabilities.yaml";
const read = (path) => readFileSync(resolve(root, path));
const sha = (value) => createHash("sha256").update(value).digest("hex");

test("P0 capability semantic review pins current source checks without claiming historical equivalence or acceptance", () => {
  const observation = JSON.parse(read(observationPath).toString("utf8"));
  const bytes = read(sourcePath);
  const catalog = parse(bytes.toString("utf8"));
  const leaves = catalog.capabilities;
  const byId = new Map(leaves.map((leaf) => [leaf.id, leaf]));
  const ids = leaves.map(({ id }) => id).sort();
  const dispositionRows = leaves.map(({ id, ownerDefinition }) => [id, ownerDefinition?.ownerDisposition]);
  const dispositionCounts = Object.fromEntries([...new Set(dispositionRows.map(([, value]) => value))]
    .sort().map((value) => [value, dispositionRows.filter(([, current]) => current === value).length]));
  const effectIntentScopeCounts = Object.fromEntries([...new Set(leaves.map(({ ownerDefinition }) => ownerDefinition?.effect?.effectIntentScope))]
    .sort().map((value) => [value, leaves.filter(({ ownerDefinition }) => ownerDefinition?.effect?.effectIntentScope === value).length]));

  assert.equal(sha(bytes), observation.source.currentSha256);
  assert.equal(observation.source.path, sourcePath);
  assert.equal(observation.source.historicalComparison.availability, "UNAVAILABLE_PRIOR_BYTES_NOT_RETAINED");
  assert.equal(observation.source.historicalComparison.parsedPathDelta, "NOT_ASSERTED");
  assert.equal(observation.source.historicalComparison.priorSha256, "8e036751e35623a972668757082e1cc6f6c519d23d7f829a73cae1d117568b25");
  assert.equal(leaves.length, 462);
  assert.equal(new Set(ids).size, 462);
  assert.equal(sha(`${ids.join("\n")}\n`), observation.source.recordPopulation.sortedIdentitySetSha256);
  assert.equal(sha(JSON.stringify(dispositionRows)), observation.source.recordPopulation.ownerDispositionSnapshotSha256);
  assert.deepEqual(dispositionCounts, observation.source.recordPopulation.ownerDispositionCounts);
  assert.deepEqual(effectIntentScopeCounts, observation.source.effectIntentScopeCounts);

  const allowedScopes = new Set(catalog.ownerDefinedP0EffectIntentRule.scopes);
  for (const leaf of leaves) {
    assert.equal(leaf.ownerDefinition.capabilityIntentId, leaf.id);
    assert.ok(leaf.ownerDefinition.ownerDisposition);
    assert.deepEqual(leaf.inputArtifactTypes, leaf.ownerDefinition.typedInputSlots.map(({ sourceType }) => sourceType), leaf.id);
    assert.deepEqual(leaf.outputArtifactTypes, leaf.ownerDefinition.successOutputs.map(({ artifactType }) => artifactType), leaf.id);
    assert.ok(allowedScopes.has(leaf.ownerDefinition.effect.effectIntentScope), leaf.id);
    assert.ok(Array.isArray(leaf.provenance) && leaf.provenance.length > 0, leaf.id);
  }

  const spatialReconstructionIds = [
    "media.generate.spatial.image-to-3d", "media.generate.spatial.reconstruct.multiview",
    "media.generate.spatial.reconstruct.depth", "media.generate.spatial.reconstruct.camera",
    "media.generate.spatial.generate.novel-view", "media.generate.spatial.relight-3d",
    "media.generate.spatial.compose-3d", "media.generate.spatial.representation.nerf-adapter",
    "media.generate.spatial.representation.gaussian-splatting-adapter",
  ];
  for (const id of spatialReconstructionIds) {
    const leaf = byId.get(id);
    assert.equal(leaf.ownerDefinition.successOutputs[0].originRelation, "SOURCE_DERIVED", id);
    assert.equal(leaf.ownerDefinition.successOutputs[0].epistemicDisposition, "ESTIMATED_OR_RECONSTRUCTED", id);
    assert.equal(leaf.ownerDefinition.effect.sourcePreservationRequired, false, id);
    assert.equal(leaf.ownerDefinition.typedInputSlots[1].required, true, id);
  }
  const spatialAddition = observation.currentSourceAdditions.find((record) => record.capabilityIds.length === spatialReconstructionIds.length);
  assert.deepEqual(spatialAddition.capabilityIds, spatialReconstructionIds);
  assert.equal(spatialAddition.semanticEquivalence, "NOT_ASSERTED");
  assert.equal(spatialAddition.acceptanceEffect, "none");

  const projectReviewCorrection = observation.currentSourceCorrections.find(
    (record) => record.capabilityId === "media.project.review",
  );
  assert.equal(projectReviewCorrection.decisionRef, ".product-experience/decision-log.md#PXD-135");
  assert.ok(projectReviewCorrection.sourceFields.includes("ownerDefinition.parameterSchema"));
  assert.ok(projectReviewCorrection.sourceFields.includes("ownerDefinition.guards.authorityRefs"));
  assert.match(projectReviewCorrection.resolvedMeaning, /exact immutable project version/u);
  assert.match(projectReviewCorrection.resolvedMeaning, /explicit scope\/expiry disposition/u);
  assert.equal(projectReviewCorrection.semanticEquivalence, "NOT_ASSERTED");
  assert.equal(projectReviewCorrection.acceptanceEffect, "none");

  assert.deepEqual(byId.get("media.project.create").ownerDefinition.typedInputSlots.map(({ sourceType }) => sourceType), ["user-intent"]);
  assert.equal(byId.get("media.generate.image.text-to-image").ownerDefinition.typedInputSlots[1].required, false);
  assert.equal(byId.get("media.generate.image.text-to-image").ownerDefinition.effect.sourcePreservationRequired, false);
  assert.equal(byId.get("media.generate.image.image-to-image").ownerDefinition.typedInputSlots[1].sourceType, "source-image-artifact");
  assert.equal(byId.get("media.generate.audio.audio-to-audio").ownerDefinition.typedInputSlots[1].sourceType, "source-audio-artifact");

  assert.equal(byId.get("media.artifact.share").outputArtifactTypes[0], "artifact-sharing-grant-observation");
  assert.equal(byId.get("media.artifact.share.revoke").outputArtifactTypes[0], "artifact-sharing-revocation-observation-confirmed-or-unknown");
  assert.equal(byId.get("media.artifact.delete").outputArtifactTypes[0], "artifact-lifecycle-observation-access-revoked-hold-pending-erasure-confirmed-or-external-unknown");
  assert.equal(byId.get("media.rights.attestation.record").outputArtifactTypes[0], "asserted-rights-attestation-record");
  assert.equal(byId.get("media.audio.analysis.analyze.phase").outputArtifactTypes[0], "typed-audio-measurement-or-observation-with-method-and-limits");
  assert.equal(byId.get("media.artifact.output.register").ownerDefinition.effect.effectIntentScope, "CANONICAL_PRODUCT_STATE_CHANGE");
  assert.equal(byId.get("media.artifact.provenance.export").ownerDefinition.effect.effectIntentScope, "GOVERNED_EXTERNAL_REQUEST");

  assert.equal(observation.decisionRef, ".product-experience/decision-log.md#PXD-122");
  assert.equal(observation.semanticEquivalence, "NOT_ASSERTED");
  assert.equal(observation.acceptanceEffect.split(";")[0], "none");
  assert.match(observation.acceptanceEffect, /does not change P0-010 acceptance/u);
  assert.match(observation.historicalPins, /PXD-098/u);
  assert.match(observation.historicalPins, /PXD-105/u);
  assert.match(observation.historicalPins, /PXD-121/u);
  assert.match(observation.reviewBoundary, /No parsed path-change counts are claimed/u);
});
