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
const correctionReviewPath = "docs/implementation/verification/pdp-38/p0-existing-operation-semantic-corrections-current-source-review.json";
const qualityPath = ".product-experience/pdp-0-product-truth/quality-policy.yaml";
const capabilityPath = ".product-experience/pdp-0-product-truth/capabilities.yaml";
const capabilityLeafReviewPath = ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml";
const channelsPath = ".product-experience/pdp-0-product-truth/applications-channels.yaml";
const goalsPath = ".product-experience/pdp-0-product-truth/goals-jtbd.yaml";
const directCriteriaPath = "docs/implementation/verification/pdp-38/direct-definition-criteria-review.json";
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
  const correctionReview = JSON.parse(read(correctionReviewPath).toString("utf8"));
  const uploadCorrectionReview = JSON.parse(read("docs/implementation/verification/pdp-38/p0-upload-byte-length-minimum-current-source-review.json").toString("utf8"));
  const qualityBytes = read(qualityPath);
  const capabilityBytes = read(capabilityPath);
  const quality = parse(qualityBytes.toString("utf8"));
  const capabilities = parse(capabilityBytes.toString("utf8")).capabilities;
  const goals = parse(read(goalsPath).toString("utf8"));
  const directCriteria = JSON.parse(read(directCriteriaPath).toString("utf8"));
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
  assert.equal(uploadCorrectionReview.source.currentSha256, sha256(capabilityBytes),
    "PXD-153 pins the current capability source");
  assert.equal(review.currentSourceRefresh.decisionRef, ".product-experience/decision-log.md#PXD-153");
  assert.equal(review.currentSourceRefresh.priorSourceSha256,
    "d66135cd7fb2f8fa4d506fcfde197d28af43e478defc35dd886986100466cfcf");
  assert.equal(review.currentSourceRefresh.currentSourceSha256, sha256(capabilityBytes));
  assert.equal(review.currentSourceRefresh.fieldRef,
    ".product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.artifact.upload/ownerDefinition/parameterSchema/properties/declaredByteLength/minimum");
  assert.equal(review.currentSourceRefresh.acceptanceEffect, "none");
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
  const correctedInputs = new Map(correctionReview.typedInputCorrections.map(({ capabilityId, typedInputSlots }) => [
    capabilityId,
    typedInputSlots.map(({ sourceType }) => sourceType),
  ]));
  for (const [capabilityId, inputTypes] of correctedInputs) {
    assert.deepEqual(capabilityById.get(capabilityId).inputArtifactTypes, inputTypes, `${capabilityId} PXD-142 typed inputs`);
    assert.deepEqual(rows.find(({ capabilityRef }) => capabilityRef === capabilityId).inputArtifactTypes, inputTypes, `${capabilityId} quality projection`);
  }
  for (const correction of correctionReview.qualityCrosswalkProjectionCorrections) {
    const row = rows.find(({ capabilityRef }) => capabilityRef === correction.capabilityId);
    assert.deepEqual(row.inputArtifactTypes, correction.inputArtifactTypes, `${correction.capabilityId} current input projection`);
    for (const [metricId, subjectTypes] of Object.entries(correction.metricSubjectInputArtifactTypes)) {
      assert.deepEqual(row.metricApplicability[metricId].subjectInputArtifactTypes, subjectTypes, `${correction.capabilityId} ${metricId} subject inputs`);
    }
  }
  const expectedMetricSubjects = new Map([
    ["media.artifact.derive", "exact-source-versioned-media-or-project-reference"],
    ["media.artifact.output.register", "output-candidate-with-lineage"],
  ]);
  for (const [capabilityId, subjectType] of expectedMetricSubjects) {
    const row = rows.find(({ capabilityRef }) => capabilityRef === capabilityId);
    const applicableMetricIds = Object.entries(row.metricApplicability).filter(([, value]) => value.status === "APPLICABLE").map(([id]) => id).sort();
    assert.equal(applicableMetricIds.length, 5, `${capabilityId} preserves its five applicable metrics`);
    for (const metricId of applicableMetricIds) {
      assert.deepEqual(row.metricApplicability[metricId].subjectInputArtifactTypes, [subjectType], `${capabilityId} ${metricId} exact typed subject`);
    }
  }
  const qualityDispositionProjection = rows.map((row) => ({
    capabilityRef: row.capabilityRef,
    dimensionApplicability: row.dimensionApplicability,
    metricApplicability: Object.fromEntries(Object.entries(row.metricApplicability).map(([id, metric]) => [id, {
      status: metric.status,
      measurementState: metric.measurementState,
      qualificationState: metric.qualificationState,
    }])),
  }));
  assert.equal(sha256(JSON.stringify(qualityDispositionProjection)), correctionReview.qualityDispositionPreservation.dispositionProjectionSha256);
  assert.equal(correctionReview.qualityDispositionPreservation.dimensionDispositionCount, 462 * 6);
  assert.equal(correctionReview.qualityDispositionPreservation.metricDispositionCount, 462 * 16);
  assert.equal(correctionReview.qualityDispositionPreservation.dispositionProjectionChanged, false);
  assert.equal(correctionReview.sourceDelta.exactProjectionChanges.length, 5);
  assert.equal(correctionReview.sourceDelta.unchangedStatusCount, 2772 + 7392);
  assert.equal(correctionReview.sourceDelta.qualityDispositionProjectionSha256, correctionReview.qualityDispositionPreservation.dispositionProjectionSha256);
  const measureRows = goals.successMeasureContracts.ownerCapabilityApplicabilityCrosswalk.measureApplicabilityRecords.records;
  const measureProjection = measureRows.map(({ id, capabilityRef, measureRef, disposition, sourceDisposition, admission, baseline, target, qualification }) => ({
    id, capabilityRef, measureRef, disposition, sourceDisposition, admission, baseline, target, qualification,
  }));
  assert.equal(measureRows.length, 1848);
  assert.equal(sha256(JSON.stringify(measureProjection)), correctionReview.ownerMeasureApplicabilityPreservation.unchangedDispositionProjectionSha256);
  assert.equal(correctionReview.sources.measureApplicability.currentSha256, sha256(read(goalsPath)));
  assert.equal(correctionReview.ownerMeasureApplicabilityPreservation.rowCount, 1848);
  assert.equal(correctionReview.sources.measureApplicability.rowCount, 1848);
  const priorP141Quality = directCriteria.records.find(({ taskId }) => taskId === "P0-06").historicalCorrectiveReviews
    .find(({ decisionRef }) => decisionRef === ".product-experience/decision-log.md#PXD-141");
  const priorP141Channels = directCriteria.records.find(({ taskId }) => taskId === "P0-07").historicalCorrectiveReviews
    .find(({ decisionRef }) => decisionRef === ".product-experience/decision-log.md#PXD-141");
  assert.equal(priorP141Quality.sourceFingerprints[qualityPath], correctionReview.qualityDispositionPreservation.previousQualityPolicySha256);
  assert.equal(priorP141Quality.sourceFingerprints[goalsPath], correctionReview.sources.measureApplicability.currentSha256);
  const priorP141ChannelSha256 = correctionReview.historicalPins.find(({ decisionRef }) => decisionRef === ".product-experience/decision-log.md#PXD-141").channelApplicabilitySha256;
  assert.equal(priorP141Channels.sourceFingerprints[capabilityLeafReviewPath], priorP141ChannelSha256);
  assert.equal(priorP141Channels.sourceFingerprints[channelsPath], correctionReview.sources.activeChannelCatalog.currentSha256);
  assert.equal(correctionReview.qualityAndChannelDecisionBoundary.qualityApplicabilityDecisionsChanged, false);
  assert.equal(correctionReview.qualityAndChannelDecisionBoundary.channelApplicabilityDecisionsChanged, false);
  assert.equal(correctionReview.sources.qualityPolicy.currentSha256, sha256(qualityBytes));
  assert.equal(correctionReview.sources.channelApplicability.currentSha256, sha256(read(capabilityLeafReviewPath)));
  const channelLeafObservation = correctionReview.channelLeafCurrentSourceObservation;
  const historicalChannelPin = correctionReview.historicalPins.find(({ decisionRef }) => decisionRef === ".product-experience/decision-log.md#PXD-141");
  assert.equal(channelLeafObservation.historicalPxd141Sha256, historicalChannelPin.channelApplicabilitySha256);
  assert.equal(channelLeafObservation.currentSha256, sha256(read(capabilityLeafReviewPath)));
  assert.equal(channelLeafObservation.changedOwnerLeafCount, 65);
  assert.deepEqual(channelLeafObservation.changedFields.slice().sort(), ["inputArtifactTypes", "outputArtifactTypes"]);
  assert.equal(channelLeafObservation.allOtherOwnerLeafFieldsUnchangedFromHistoricalPxd141Source, true);
  assert.equal(channelLeafObservation.channelApplicabilityDecisionsChanged, false);
  assert.equal(channelLeafObservation.acceptanceEffect, "none");
  assert.equal(correctionReview.sources.activeChannelCatalog.currentSha256, sha256(read(channelsPath)));
  assert.equal(review.correctionOverlay.artifactSha256, sha256(read(correctionReviewPath)));
  assert.equal(review.correctionOverlay.qualityApplicabilityDecisionsChanged, false);
  assert.equal(review.correctionOverlay.channelApplicabilityDecisionsChanged, false);

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
  assert.equal(review.historicalSourceSnapshots.supersededCapabilitySha256, "d4b8b1747831dd3843ac5945530087c4fc2af01410d09c803bb1b84d52960c22");
  assert.equal(review.historicalSourceSnapshots.qualityPolicySha256, correctionReview.qualityDispositionPreservation.previousQualityPolicySha256);
});
