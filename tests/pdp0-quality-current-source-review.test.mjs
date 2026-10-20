import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const artifactPath = "docs/implementation/verification/pdp-38/p0-quality-current-source-review-current.json";
const historicalArtifactPath = "docs/implementation/verification/pdp-38/p0-quality-current-source-review.json";
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

test("P0 quality current-source review pins the frozen 462-leaf policy crosswalk and excludes seven extensions", () => {
  const review = JSON.parse(read(artifactPath).toString("utf8"));
  const historicalReview = JSON.parse(read(historicalArtifactPath).toString("utf8"));
  const correctionReview = JSON.parse(read(correctionReviewPath).toString("utf8"));
  const currentReconciliation = JSON.parse(read("docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd206.json").toString("utf8"));
  const uploadCorrectionReview = JSON.parse(read("docs/implementation/verification/pdp-38/p0-upload-byte-length-minimum-current-source-review.json").toString("utf8"));
  const qualityBytes = read(qualityPath);
  const capabilityBytes = read(capabilityPath);
  const quality = parse(qualityBytes.toString("utf8"));
  const capabilitySource = parse(capabilityBytes.toString("utf8"));
  const ownerCapabilityRefs = new Set(parse(read(capabilityLeafReviewPath).toString("utf8"))
    .ownerCapabilityLeafAdjudication.records.map(({ capabilityRef }) => capabilityRef));
  const capabilities = capabilitySource.capabilities.filter(({ id }) => ownerCapabilityRefs.has(id));
  const goals = parse(read(goalsPath).toString("utf8"));
  const directCriteria = JSON.parse(read(directCriteriaPath).toString("utf8"));
  const crosswalk = quality.ownerQualityApplicabilityCrosswalk;
  const rows = crosswalk.records;
  const capabilityById = new Map(capabilities.map((capability) => [capability.id, capability]));
  const dimensionIds = quality.qualityDimensions.map(({ id }) => id).sort();
  const metricIds = quality.metricDefinitions.map(({ id }) => id).sort();
  const dimensionScopes = quality.qualityDimensions.map(({ id, scope }) => ({ id, scope }));
  const historicalPxd208Pins = {
    ".product-experience/pdp-0-product-truth/requirements.yaml": "9f3dc3e9af961a5c24a2fe5e2c9ad65ff2f3f4f5d46ffb231e80f162b23231af",
    ".product-experience/pdp-0-product-truth/campaign-extensions.yaml": "f2f970b6f30a325a34a64ab8d8dab51d297510cf74136322b499fa04a2de7bc6",
    [capabilityPath]: "fc7c481af2a93697266bc1dacf0449551dba044d5420e065b5739823e4a2397e",
    [qualityPath]: "e0aad41a1934e7f5588d8e011740ba661890ab8f0d2c18c85d7e54ce912ad4d6",
    [capabilityLeafReviewPath]: "dfcbc43e98f5f89285f6bc9bad4e56a40235fea5e9e7efd691724bfb8d431af5",
    [channelsPath]: "d1e76dea4176012aa23ef4be097ed85881fff24102725d15171ed483ee354978",
    "docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json": "b3b52c0e48a95f41761c19ab780b03a589133c8ac4d7cd34f01d317ed0055fd3",
    "docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-audit-aq-traceability.json": "1e76bedaff8372d24fa93a81b921fe552a4dd0994436f3e26b4b44a1826e7e3b",
    ".product-experience/decision-log.md#PXD-207-section": "eedde5bd30fabed060af9a1b8b16bf55f4a5648331950daaf3ca860d99d7ec3a",
    ".product-experience/decision-log.md#PXD-208-section": "f56e9d99f4ca5b4c2ba625a9923c1c11cd3f9b043cdb2613710cf798bf9fbbec",
  };
  const historicalPxd209Pins = {
    [capabilityPath]: "6a0674f350af8bb75f54641f31377f199b27e016e2c3163b557ffa19397dac45",
    "docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json": "b2294ecff9f545ddc4829f3736234ba3a117baa0a4f9cacb0a4619530defcc4f",
    "docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-audit-aq-traceability.json": "fb94993ed9903137771cfaf6f563afe6af018f4a86ea8a63497a48fba26b02b2",
    ".product-experience/decision-log.md#PXD-209-section": "bd024f73efbd5dffe4962de912767f35d27ffc94460184d54e13c6afe1cc6f5f",
    "docs/implementation/verification/pdp-38/p0-caption-import-current-source-review-pxd209.json": "af80730aebc6a557b983752df726b1ed869abf83e386ec1c97b95f446c0e2693",
  };
  const downstreamDependency = /pdp-[1-9]-domain-data|operationContractRef|typed(Input|Output)SchemaIds|domainObjectRef|ownerOutputSchemaRef|ownerLeafWireContractRef/iu;

  assert.equal(review.sources.qualityPolicy.path, qualityPath);
  assert.equal(review.sources.qualityPolicy.currentSha256, historicalPxd208Pins[qualityPath],
    "PXD-208 quality-policy pin remains the historical source cut");
  assert.equal(review.sources.capabilities.path, capabilityPath);
  assert.equal(review.sources.capabilities.currentSha256, historicalPxd209Pins[capabilityPath],
    "PXD-209 capability pin remains historical; current bytes belong to PXD-212");
  const pxd170Refresh = review.historicalSourceRefreshes.find(({ decisionRef }) => decisionRef === ".product-experience/decision-log.md#PXD-170");
  const pxd196Refresh = review.historicalSourceRefreshes.find(({ decisionRef }) => decisionRef === ".product-experience/decision-log.md#PXD-196");
  assert.ok(pxd170Refresh, "PXD-170 remains preserved as the prior no-effect source review");
  assert.equal(uploadCorrectionReview.source.currentSha256, pxd170Refresh.priorSourceSha256,
    "PXD-153 remains the historical predecessor source pin");
  assert.equal(review.artifactId, "P0-QUALITY-CURRENT-SOURCE-REVIEW-002");
  assert.equal(review.predecessorReviewRef, historicalArtifactPath);
  assert.equal(historicalReview.currentSourceRefresh.decisionRef, ".product-experience/decision-log.md#PXD-153");
  assert.equal(pxd170Refresh.decisionRef, ".product-experience/decision-log.md#PXD-170");
  assert.equal(pxd170Refresh.priorSourceSha256,
    "4b4b4f1ab5d4908c93af5c6b4c2be47008b04f75ac45160a1be5e167edbec42d");
  assert.equal(pxd170Refresh.currentSourceSha256,
    "f9a979392587069dbb9c2a653fe9866e9b61ee31192725404ec01e5426291f5d");
  assert.equal(pxd196Refresh?.priorSourceSha256, pxd170Refresh.currentSourceSha256);
  assert.equal(pxd196Refresh?.currentSourceSha256, "bc1d9c389afc3445015679aa9bbf63dae310b5a91b34dbf7046a8de92f52dbba");
  assert.equal(review.currentSourceRefresh.decisionRef, ".product-experience/decision-log.md#PXD-208");
  assert.equal(review.currentSourceRefresh.predecessorRefreshRef, ".product-experience/decision-log.md#PXD-206");
  assert.equal(review.currentSourceRefresh.priorSourceSha256, "801e9eab9b6d2936b52254276c940456ae6d98fd9dc95f2364b56bd9e02da527");
  assert.equal(review.currentSourceRefresh.currentSourceSha256, "fc7c481af2a93697266bc1dacf0449551dba044d5420e065b5739823e4a2397e");
  assert.equal(review.currentSourceRefresh.reviewedCapabilityRefCount, 462);
  assert.deepEqual(review.currentSourceRefresh.sourceFingerprints, historicalPxd208Pins,
    "PXD-208 remains pinned to its immutable source cut, with no PXD-209 currentness mixed into it");
  assert.equal(review.postReviewCurrentnessRefresh.status, "CURRENT_SOURCE_PIN_REFRESH_ONLY");
  assert.equal(review.postReviewCurrentnessRefresh.phaseScope, "PDP-0");
  assert.equal(review.postReviewCurrentnessRefresh.decisionRef, ".product-experience/decision-log.md#PXD-209");
  assert.equal(review.postReviewCurrentnessRefresh.predecessorSourceSha256, review.currentSourceRefresh.currentSourceSha256);
  assert.equal(review.postReviewCurrentnessRefresh.currentSourceSha256, historicalPxd209Pins[capabilityPath],
    "PXD-209 retains its reviewed capability source digest");
  assert.equal(review.postReviewCurrentnessRefresh.successOutputsPredecessorSha256, "8f819298dcfbe119a3967ef9eefe5cf3d3bfac9c912d700aa96e654fef534514");
  assert.equal(review.postReviewCurrentnessRefresh.successOutputsCurrentBaseProjectionSha256, review.postReviewCurrentnessRefresh.successOutputsPredecessorSha256);
  assert.equal(review.postReviewCurrentnessRefresh.importCapabilityTypeJoins.qualityJoinChanged, false);
  assert.equal(review.postReviewCurrentnessRefresh.frozenQualityPopulation.capabilityRows, 462);
  assert.equal(review.postReviewCurrentnessRefresh.frozenQualityPopulation.dimensionDispositions, 2772);
  assert.equal(review.postReviewCurrentnessRefresh.frozenQualityPopulation.metricDispositions, 7392);
  assert.equal(review.postReviewCurrentnessRefresh.frozenQualityPopulation.definitionExtensionsExcluded, 7);
  assert.equal(review.postReviewCurrentnessRefresh.semanticReview, "NOT_PERFORMED");
  assert.equal(review.postReviewCurrentnessRefresh.ownerApproval, "NOT_CLAIMED");
  assert.equal(review.postReviewCurrentnessRefresh.acceptanceEffect, "none");
  assert.deepEqual(review.postReviewCurrentnessRefresh.sourceFingerprints, historicalPxd209Pins,
    "PXD-209 source fingerprints remain immutable historical pins");
  assert.equal(review.latestCurrentnessRefresh.sourceFingerprints[capabilityPath], sha256(capabilityBytes),
    "PXD-212 owns the current capability bytes");
  assert.equal(review.latestCurrentnessRefresh.sourceFingerprints[qualityPath], sha256(qualityBytes),
    "PXD-212 owns the current quality-policy bytes");
  assert.equal(review.postReviewCurrentnessRefresh.reviewArtifactSha256,
    sha256(read("docs/implementation/verification/pdp-38/p0-caption-import-current-source-review-pxd209.json")));
  const historicalPxd206Refresh = review.historicalSourceRefreshes.find(({ decisionRef }) => decisionRef === ".product-experience/decision-log.md#PXD-206");
  assert.ok(historicalPxd206Refresh, "PXD-206 remains preserved as the exact predecessor source refresh");
  assert.equal(historicalPxd206Refresh.priorSourceSha256, "7d6d3931506b9a0565cd558932c967a7e330dda9bed3cc58f912490d1c9c623d");
  assert.equal(historicalPxd206Refresh.currentSourceSha256, "801e9eab9b6d2936b52254276c940456ae6d98fd9dc95f2364b56bd9e02da527");
  assert.equal(historicalPxd206Refresh.reviewedCapabilityRefCount, 462);
  assert.equal(historicalPxd206Refresh.acceptanceEffect, "none");
  const changedCapabilityRefs = [
    "media.compose.multitrack-timeline", "media.compose.reusable-composition", "media.compose.safe-area",
    "media.master.audio.stereo-width", "media.speech.synthesis.speaker.condition",
  ].map((id) => `${capabilityPath}#capabilities/@id=${id}`).sort();
  assert.deepEqual(review.currentSourceRefresh.reviewedCapabilityRefs, changedCapabilityRefs);
  assert.equal(review.sourceDelta.capabilityRowsRechecked, 462);
  assert.deepEqual(review.sourceDelta.changedCapabilityRefs, changedCapabilityRefs);
  assert.equal(review.sourceDelta.artifactTypeProjectionChanged, true);
  assert.equal(review.sourceDelta.qualityDispositionProjectionChanged, false);
  assert.equal(review.sourceDelta.measurementStateProjectionChanged, false);
  assert.equal(review.sourceDelta.qualificationStateProjectionChanged, false);
  assert.equal(review.currentSourceRefresh.acceptanceEffect, "none");
  assert.deepEqual(review.currentSourceRefresh.frozenPopulation, {
    capabilityRows: 462,
    uniqueCapabilityRefs: 462,
    qualityDimensions: 6,
    metricDefinitions: 16,
    dimensionDispositions: 2772,
    metricDispositions: 7392,
    measurementState: "NOT_EVALUATED",
    qualificationState: "NOT_EVALUATED",
  });
  assert.equal(review.sources.capabilities.capabilityCount, 462);
  assert.equal(review.sources.capabilities.totalDefinitionCount, 469);
  assert.equal(review.sources.capabilities.proposalDefinitionCount, 7);
  assert.equal(capabilities.length, 462);
  assert.equal(capabilitySource.capabilities.length, 469);
  const extensionIds = [
    "media.recipe.specification.compile", "media.project.scene.patch-merge",
    "media.quality.audio.content-similarity.assess", "media.generate.video.preset.manage",
    "media.generate.video.shot-condition", "media.job.schedule.manage",
    "media.master.audio.creative-effect.apply",
  ];
  const excludedExtensions = review.currentSourceRefresh.excludedDefinitionExtensions;
  assert.deepEqual(excludedExtensions.map(({ capabilityId }) => capabilityId).sort(), extensionIds.slice().sort());
  assert.ok(excludedExtensions.every((record) => record.disposition === "OUTSIDE_FROZEN_HISTORICAL_462_QUALITY_COHORT"
    && record.qualityDisposition === "NOT_ASSIGNED_BY_THIS_REVIEW"
    && record.measurementState === "NOT_EVALUATED"
    && record.qualificationState === "NOT_EVALUATED"
    && record.decisionRef === ".product-experience/decision-log.md#PXD-207"
    && !Object.hasOwn(record, "ownerAcceptance") && !Object.hasOwn(record, "ownerApproval")));
  assert.ok(extensionIds.every((id) => !rows.some(({ capabilityRef }) => capabilityRef === id)),
    "the seven extensions receive no inherited quality dispositions from the frozen cohort");
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
  assert.equal(correctionReview.ownerMeasureApplicabilityPreservation.rowCount, 1848);
  assert.equal(correctionReview.sources.measureApplicability.rowCount, 1848);
  assert.equal(currentReconciliation.measureProjection.rowCount, measureRows.length);
  assert.equal(currentReconciliation.measureProjection.projectionSha256, sha256(JSON.stringify(measureProjection)));
  assert.equal(currentReconciliation.sources.goals.sha256, "519d266c35931f2738f2f82c0a1d472abe171ef0b731bb371f72e81f83edc9ec",
    "PXD-206 keeps its historical goals source digest");
  assert.equal(currentReconciliation.sources.quality.sha256, "e0aad41a1934e7f5588d8e011740ba661890ab8f0d2c18c85d7e54ce912ad4d6",
    "PXD-206 keeps its historical quality-policy source digest");
  assert.equal(currentReconciliation.sources.capabilities.sha256, "801e9eab9b6d2936b52254276c940456ae6d98fd9dc95f2364b56bd9e02da527",
    "the PXD-206 reconciliation retains its historical capability source cut");
  assert.equal(currentReconciliation.sources.leafReview.sha256, "dfcbc43e98f5f89285f6bc9bad4e56a40235fea5e9e7efd691724bfb8d431af5",
    "PXD-206 keeps its historical capability-leaf review digest");
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
  assert.equal(currentReconciliation.sources.quality.sha256, historicalPxd208Pins[qualityPath]);
  assert.equal(currentReconciliation.sources.leafReview.sha256, historicalPxd208Pins[capabilityLeafReviewPath]);
  const channelLeafObservation = correctionReview.channelLeafCurrentSourceObservation;
  const historicalChannelPin = correctionReview.historicalPins.find(({ decisionRef }) => decisionRef === ".product-experience/decision-log.md#PXD-141");
  assert.equal(channelLeafObservation.historicalPxd141Sha256, historicalChannelPin.channelApplicabilitySha256);
  assert.equal(channelLeafObservation.currentSha256, correctionReview.sources.channelApplicability.currentSha256,
    "PXD-142 keeps its historical channel-leaf source pin");
  assert.equal(channelLeafObservation.changedOwnerLeafCount, 65);
  assert.deepEqual(channelLeafObservation.changedFields.slice().sort(), ["inputArtifactTypes", "outputArtifactTypes"]);
  assert.equal(channelLeafObservation.allOtherOwnerLeafFieldsUnchangedFromHistoricalPxd141Source, true);
  assert.equal(channelLeafObservation.channelApplicabilityDecisionsChanged, false);
  assert.equal(channelLeafObservation.acceptanceEffect, "none");
  assert.equal(correctionReview.sources.activeChannelCatalog.currentSha256, priorP141Channels.sourceFingerprints[channelsPath],
    "PXD-142 retains its historical active-channel catalog pin");
  const p0SurfaceScope = directCriteria.records.find(({ taskId }) => taskId === "P0-07").historicalCorrectiveReviews
    .find(({ decisionRef }) => decisionRef === ".product-experience/decision-log.md#PXD-165");
  assert.equal(p0SurfaceScope.decisionRef, ".product-experience/decision-log.md#PXD-165");
  assert.equal(p0SurfaceScope.reviewKind, "SCOPED_SOURCE_DEFINITION_REVIEW");
  assert.equal(p0SurfaceScope.sourceFingerprints[channelsPath], "cc25faf0326d9868842b561626629ce0f3a2d4e4365452d8caa1995268df6f76",
    "PXD-165 retains its historical source-scope pin before PXD-196 changes the current source");
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
