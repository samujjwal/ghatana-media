import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const artifactPath = "docs/implementation/verification/pdp-38/p0-quality-current-source-review.json";
const qualityPath = ".product-experience/pdp-0-product-truth/quality-policy.yaml";
const capabilityPath = ".product-experience/pdp-0-product-truth/capabilities.yaml";
const videoIdentityMetricId = "QUALITY-METRIC-VIDEO-IDENTITY-OBJECT-GEOMETRY";
const expectedVideoIdentityApplicableIds = [
  "media.enhance.video.compression-repair",
  "media.enhance.video.deflicker",
  "media.enhance.video.deinterlace",
  "media.enhance.video.frame-rate-conversion",
  "media.enhance.video.frame-repair",
  "media.enhance.video.grain.adjust",
  "media.enhance.video.interpolation",
  "media.enhance.video.inverse-telecine-cadence",
  "media.enhance.video.motion-blur-synthesis",
  "media.enhance.video.rolling-shutter",
  "media.enhance.video.spatiotemporal-super-resolution",
  "media.enhance.video.stabilize",
  "media.enhance.video.temporal-consistency",
  "media.enhance.video.temporal-deblur",
  "media.enhance.video.temporal-denoise",
  "media.generate.video.drive.audio",
  "media.generate.video.drive.speech",
  "media.generate.video.image-to-video",
  "media.generate.video.keyframe.end",
  "media.generate.video.keyframe.intermediate",
  "media.generate.video.keyframe.start",
  "media.generate.video.reference-video",
  "media.generate.video.text-image-to-video",
  "media.generate.video.text-to-video",
  "media.generate.video.video-to-video",
  "media.quality.video.video.assess-identity-consistency",
].sort();
const read = (path) => readFileSync(resolve(root, path));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("P0 quality current-source review pins the complete 462-leaf policy crosswalk", () => {
  const review = JSON.parse(read(artifactPath).toString("utf8"));
  const qualityBytes = read(qualityPath);
  const capabilityBytes = read(capabilityPath);
  const quality = parse(qualityBytes.toString("utf8"));
  const capabilities = parse(capabilityBytes.toString("utf8")).capabilities;
  const crosswalk = quality.ownerQualityApplicabilityCrosswalk;
  const rows = crosswalk.records;
  const capabilityById = new Map(capabilities.map((capability) => [capability.id, capability]));
  const dimensionIds = quality.qualityDimensions.map(({ id }) => id).sort();
  const metricIds = quality.metricDefinitions.map(({ id }) => id).sort();
  const dimensionScopes = quality.qualityDimensions.map(({ id, scope }) => ({ id, scope }));
  const downstreamDependency = /pdp-[1-9]-domain-data|operationContractRef|typed(Input|Output)SchemaIds|domainObjectRef|ownerOutputSchemaRef|ownerLeafWireContractRef/iu;

  assert.equal(review.sources.qualityPolicy.path, qualityPath);
  assert.equal(review.sources.qualityPolicy.currentSha256, sha256(qualityBytes));
  assert.equal(review.sources.capabilities.path, capabilityPath);
  assert.equal(review.sources.capabilities.currentSha256, sha256(capabilityBytes));
  assert.equal(review.sources.capabilities.capabilityCount, 462);
  assert.equal(capabilities.length, 462);
  assert.equal(new Set(capabilities.map(({ id }) => id)).size, 462);
  assert.equal(rows.length, 462);
  assert.equal(new Set(rows.map(({ capabilityRef }) => capabilityRef)).size, 462);
  assert.equal(quality.qualityDimensions.length, 6);
  assert.equal(quality.metricDefinitions.length, 16);
  assert.deepEqual(review.reviewedDimensions, dimensionScopes);
  assert.ok(dimensionScopes.every(({ scope }) => typeof scope === "string" && scope.trim().length > 0));
  assert.equal(new Set(dimensionScopes.map(({ scope }) => scope)).size, 6, "each quality dimension retains its own scope");
  assert.ok(dimensionScopes.every(({ scope }) => !/P0 semantic quality dimension; exact leaf applicability is enumerated/iu.test(scope)));
  assert.equal(crosswalk.population.dimensionDispositions, 462 * 6);
  assert.equal(crosswalk.population.metricDispositions, 462 * 16);
  assert.equal(review.reviewedPopulation.capabilityRows, 462);
  assert.equal(review.reviewedPopulation.uniqueCapabilityRefs, 462);
  assert.equal(review.reviewedPopulation.qualityDimensions, 6);
  assert.equal(review.reviewedPopulation.metricDefinitions, 16);
  assert.equal(review.reviewedPopulation.dimensionDispositions, 462 * 6);
  assert.equal(review.reviewedPopulation.metricDispositions, 462 * 16);

  for (const row of rows) {
    const capability = capabilityById.get(row.capabilityRef);
    assert.ok(capability, `unknown capability ${row.capabilityRef}`);
    assert.deepEqual(row.inputArtifactTypes, capability.inputArtifactTypes, `${row.capabilityRef} input types`);
    assert.deepEqual(row.outputArtifactTypes, capability.outputArtifactTypes, `${row.capabilityRef} output types`);
    assert.deepEqual(Object.keys(row.dimensionApplicability).sort(), dimensionIds, `${row.capabilityRef} dimensions`);
    assert.deepEqual(Object.keys(row.metricApplicability).sort(), metricIds, `${row.capabilityRef} metrics`);
    for (const disposition of Object.values(row.dimensionApplicability)) {
      assert.ok(["APPLICABLE", "NOT_APPLICABLE"].includes(disposition), row.capabilityRef);
    }
    for (const metric of Object.values(row.metricApplicability)) {
      assert.ok(["APPLICABLE", "NOT_APPLICABLE"].includes(metric.status), row.capabilityRef);
      assert.equal(metric.measurementState, "NOT_EVALUATED", row.capabilityRef);
      assert.equal(metric.qualificationState, "NOT_EVALUATED", row.capabilityRef);
    }
  }

  const videoIdentityApplicable = rows.filter((row) => row.metricApplicability[videoIdentityMetricId].status === "APPLICABLE");
  const videoIdentityDefinition = quality.metricDefinitions.find(({ id }) => id === videoIdentityMetricId);
  const identityCondition = crosswalk.metricModalityRules[videoIdentityMetricId].condition;
  assert.deepEqual(videoIdentityApplicable.map(({ capabilityRef }) => capabilityRef).sort(), expectedVideoIdentityApplicableIds);
  assert.equal(videoIdentityDefinition.ownerCurrentApplicability.applicableCount, 26);
  assert.equal(videoIdentityDefinition.ownerCurrentApplicability.notApplicableCount, 436);
  assert.deepEqual(videoIdentityDefinition.ownerCurrentApplicability.capabilityRefs.slice().sort(), expectedVideoIdentityApplicableIds);
  assert.deepEqual(review.videoIdentityApplicability.capabilityRefs, expectedVideoIdentityApplicableIds);
  assert.equal(review.videoIdentityApplicability.applicableCount, 26);
  assert.equal(review.videoIdentityApplicability.notApplicableCount, 436);
  assert.equal(review.videoIdentityApplicability.requiredReferenceArtifactType, "video-or-frame-reference");
  for (const row of videoIdentityApplicable) {
    const metric = row.metricApplicability[videoIdentityMetricId];
    assert.notEqual(metric.reasonCode, "REQUIRED_REFERENCE_SCHEMA_NOT_BOUND", row.capabilityRef);
    assert.deepEqual(metric.conditionalPredicates, [identityCondition], row.capabilityRef);
    assert.deepEqual(metric.requiredReferenceArtifactTypes, ["video-or-frame-reference"], row.capabilityRef);
    assert.equal(metric.measurementState, "NOT_EVALUATED", row.capabilityRef);
    assert.equal(metric.qualificationState, "NOT_EVALUATED", row.capabilityRef);
  }
  const modalityEvidence = new Map(crosswalk.modalityEvidenceRegistry.map((entry) => [entry.artifactType, entry]));
  for (const artifactType of ["candidate-video-keyframe-artifact", "candidate-video-keyframe-sequence-artifact"]) {
    assert.deepEqual(modalityEvidence.get(artifactType)?.modalities, ["video"]);
    assert.equal(modalityEvidence.get(artifactType)?.subjectRole, "MEDIA_SUBJECT");
  }
  const identityAssessor = rows.find((row) => row.capabilityRef === "media.quality.video.video.assess-identity-consistency");
  assert.deepEqual(identityAssessor.metricApplicability[videoIdentityMetricId].subjectInputArtifactTypes, ["video-candidate"]);
  assert.deepEqual(identityAssessor.ownerMeasurementBindings, [{
    metricRef: videoIdentityMetricId,
    inputArtifactTypes: ["video-candidate"],
    outputArtifactTypes: ["video-quality-observations-by-applicable-dimension"],
  }]);

  assert.doesNotMatch(JSON.stringify(crosswalk), downstreamDependency);
  assert.equal(review.semanticEquivalence, "NOT_ASSERTED");
  assert.equal(review.acceptanceEffect, "none; current-source structural and semantic join checks only");
  assert.deepEqual(review.historicalBoundary.decisions, ["PXD-098", "PXD-105"]);
  assert.equal(review.historicalBoundary.acceptanceEffect, "none");
});
