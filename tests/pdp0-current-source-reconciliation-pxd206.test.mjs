import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const artifactPath = "docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd206.json";
const pxd212Path = "docs/implementation/verification/pdp-38/p0-quality-current-source-review-pxd212.json";
const sourcePaths = {
  capabilities: ".product-experience/pdp-0-product-truth/capabilities.yaml",
  profileSemantics: ".product-experience/pdp-0-product-truth/profile-semantics.yaml",
  goals: ".product-experience/pdp-0-product-truth/goals-jtbd.yaml",
  quality: ".product-experience/pdp-0-product-truth/quality-policy.yaml",
  leafReview: ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml",
  decisionLog: ".product-experience/decision-log.md",
  qualityReview: "docs/implementation/verification/pdp-38/p0-quality-current-source-review-current.json",
};
const read = (path) => readFileSync(resolve(root, path));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const document = (path) => parse(read(path).toString("utf8"));
const changedIds = [
  "media.compose.multitrack-timeline",
  "media.compose.safe-area",
  "media.compose.reusable-composition",
  "media.master.audio.stereo-width",
  "media.speech.synthesis.speaker.condition",
];

test("PXD-206 current PDP-0 projections are source-pinned and preserve owner blockers", () => {
  const review = JSON.parse(read(artifactPath).toString("utf8"));
  const capabilitiesDoc = document(sourcePaths.capabilities);
  const profile = document(sourcePaths.profileSemantics);
  const goals = document(sourcePaths.goals);
  const quality = document(sourcePaths.quality);
  const leafReview = document(sourcePaths.leafReview);
  const ownerRows = leafReview.ownerCapabilityLeafAdjudication.records;
  const ownerById = new Map(ownerRows.map((row) => [row.capabilityRef, row]));
  const trustRows = leafReview.ownerTrustReconstructionDispositions.records;
  const trustById = new Map(trustRows.map((row) => [row.capabilityRef, row]));
  const capabilities = new Map(capabilitiesDoc.capabilities.map((row) => [row.id, row]));
  const canonical = new Map([...capabilities].filter(([id]) => ownerById.has(id)));

  assert.equal(review.schemaVersion, "media.pdp0.current-source-reconciliation.v1");
  assert.equal(review.artifactId, "PDP0-CURRENT-SOURCE-RECONCILIATION-PXD206");
  assert.equal(review.decisionRef, ".product-experience/decision-log.md#PXD-206");
  for (const [key, expectedPath] of Object.entries(sourcePaths)) {
    assert.equal(review.sources[key].path, expectedPath);
    assert.match(review.sources[key].sha256, /^[a-f0-9]{64}$/u,
      `${key} retains the exact PXD-206 historical source fingerprint`);
  }
  const decisionLog = read(sourcePaths.decisionLog).toString("utf8");
  const decisionStart = decisionLog.indexOf("### PXD-206 —");
  const nextDecisionStart = decisionLog.indexOf("\n### ", decisionStart + 1);
  const decisionBlock = decisionLog.slice(decisionStart, nextDecisionStart >= 0 ? nextDecisionStart : decisionLog.length);
  assert.ok(decisionStart >= 0);
  assert.equal(review.decisionSectionSha256, sha(decisionBlock));
  assert.match(decisionBlock, /five exact type differences require the Media semantic owner to adjudicate/u);
  assert.match(decisionBlock, /does not claim owner approval/u);

  const slots = [...canonical.values()].flatMap((capability) => capability.ownerDefinition.typedInputSlots);
  const shapeIdentity = (slot) => JSON.stringify({
    sourceType: slot.sourceType,
    cardinality: slot.cardinality,
    required: slot.required,
    alternatives: slot.alternatives,
    condition: slot.condition,
  });
  assert.equal(ownerRows.length, 462);
  assert.equal(capabilities.size, 469);
  assert.equal(canonical.size, 462);
  assert.equal(capabilities.size - canonical.size, 7);
  assert.equal(slots.length, 939);
  assert.equal(new Set(slots.map(shapeIdentity)).size, 144);
  assert.equal(profile.capabilityBoundsEnvelope.inputShapeFamilyReconciliation.currentPopulation.leafCount, 462);
  assert.equal(profile.capabilityBoundsEnvelope.inputShapeFamilyReconciliation.currentPopulation.slotCount, 939);
  assert.equal(profile.capabilityBoundsEnvelope.inputShapeFamilyReconciliation.currentPopulation.distinctSharedShapeCount, 144);
  assert.equal(profile.capabilityBoundsEnvelope.inputShapeFamilyReconciliation.currentPopulation.sourceRefresh.previousDistinctSharedShapeCount, 142);
  assert.deepEqual(profile.capabilityBoundsEnvelope.inputShapeFamilyReconciliation.currentPopulation.sourceRefresh.changedCapabilityRefs, [
    `${sourcePaths.capabilities}#capabilities/@id=media.speech.synthesis.speaker.condition/ownerDefinition/typedInputSlots`,
    `${sourcePaths.capabilities}#capabilities/@id=media.master.audio.stereo-width/ownerDefinition/typedInputSlots`,
  ]);
  assert.equal(review.population.canonicalOwnerAdjudicatedCapabilityCount, 462);
  assert.equal(review.population.totalCapabilityDefinitionCount, 468);
  assert.equal(review.population.separateProposalDefinitionCount, 6);
  assert.equal(review.population.typedInputSlotCount, 939);
  assert.equal(review.population.currentDistinctSharedInputShapeCount, 144);

  for (const id of changedIds) {
    const capability = capabilities.get(id);
    const trust = trustById.get(id);
    const recorded = review.currentProjectionChanges.find((item) => item.capabilityId === id);
    assert.ok(recorded, `${id} is in the current-source reconciliation`);
    assert.deepEqual(recorded.currentInputArtifactTypes, capability.inputArtifactTypes, `${id} current inputs`);
    assert.deepEqual(recorded.currentOutputArtifactTypes, capability.outputArtifactTypes, `${id} current outputs`);
    assert.deepEqual(recorded.trustReconstructionInputArtifactTypes, trust.inputArtifactTypes, `${id} trust inputs`);
    assert.deepEqual(recorded.trustReconstructionOutputArtifactTypes, trust.outputArtifactTypes, `${id} trust outputs`);
    assert.deepEqual(capability.inputArtifactTypes, capability.ownerDefinition.typedInputSlots.map(({ sourceType }) => sourceType), `${id} top-level/slot input projection`);
    assert.deepEqual(capability.outputArtifactTypes, capability.ownerDefinition.successOutputs.map(({ artifactType }) => artifactType), `${id} top-level/success output projection`);
  }
  const conditionedSpeaker = capabilities.get("media.speech.synthesis.speaker.condition").ownerDefinition.typedInputSlots[1];
  assert.equal(conditionedSpeaker.sourceType, "authorized-speaker-reference-or-ordered-segment-speaker-map");
  assert.equal(conditionedSpeaker.cardinality, "EXACTLY_ONE_OF_DECLARED_ALTERNATIVES");
  assert.deepEqual(conditionedSpeaker.alternatives, ["authorized-speaker-reference", "ordered-segment-speaker-map"]);

  const actualOwnerDifferences = [];
  for (const [id, capability] of canonical) {
    const owner = ownerById.get(id);
    for (const field of ["inputArtifactTypes", "outputArtifactTypes"]) {
      if (JSON.stringify(capability[field]) !== JSON.stringify(owner[field])) {
        actualOwnerDifferences.push({
          capabilityId: id,
          fieldPath: field,
          capabilitySourceRef: `${sourcePaths.capabilities}#capabilities/@id=${id}/${field}`,
          ownerAdjudicationSourceRef: `${sourcePaths.leafReview}#ownerCapabilityLeafAdjudication/records/@id=${owner.id}/${field}`,
          currentValue: capability[field],
          ownerRecordedValue: owner[field],
          disposition: "PENDING_MEDIA_SEMANTIC_OWNER_ADJUDICATION",
        });
      }
    }
  }
  const pxd212 = JSON.parse(read(pxd212Path).toString("utf8"));
  const pxd212JoinedIds = [
    "media.edit.inpaint",
    "media.edit.matte",
    "media.edit.retime-slow-motion-speed-ramp",
  ];
  const pxd212JoinById = new Map(pxd212.latestCurrentnessRefresh.changedTypeJoins
    .map((join) => [join.capabilityId, join]));
  const pxd212ExtraDifferences = actualOwnerDifferences.filter((difference) => pxd212JoinedIds.includes(difference.capabilityId));
  const pxd206HistoricalDifferences = actualOwnerDifferences.filter((difference) => !pxd212JoinedIds.includes(difference.capabilityId));
  assert.equal(actualOwnerDifferences.length, 8, "the live source has the five PXD-206 differences plus three reviewed later joins");
  assert.equal(pxd206HistoricalDifferences.length, 5);
  assert.deepEqual(pxd206HistoricalDifferences, review.ownerAdjudicationDifferences,
    "PXD-206's five owner differences remain its immutable historical cut");
  assert.deepEqual(pxd212ExtraDifferences.map(({ capabilityId }) => capabilityId).sort(), pxd212JoinedIds.slice().sort());
  assert.deepEqual(pxd212.latestCurrentnessRefresh.changedTypeJoins.map(({ capabilityId }) => capabilityId).sort(), pxd212JoinedIds.slice().sort());
  assert.equal(pxd212.latestCurrentnessRefresh.decisionRef, ".product-experience/decision-log.md#PXD-212");
  assert.equal(pxd212.latestCurrentnessRefresh.semanticReview, "PERFORMED_EXACT_TYPE_JOIN_REVIEW");
  assert.equal(pxd212.latestCurrentnessRefresh.ownerApproval, "NOT_CLAIMED");
  assert.equal(pxd212.latestCurrentnessRefresh.independentAcceptance, "NOT_CLAIMED");
  for (const [key, sourcePath] of [
    [".product-experience/pdp-0-product-truth/capabilities.yaml", sourcePaths.capabilities],
    [".product-experience/pdp-0-product-truth/quality-policy.yaml", sourcePaths.quality],
    [".product-experience/pdp-0-product-truth/capability-leaf-review.yaml", sourcePaths.leafReview],
    [".product-experience/pdp-0-product-truth/goals-jtbd.yaml", sourcePaths.goals],
  ]) {
    assert.equal(pxd212.latestCurrentnessRefresh.sourceFingerprints[key], sha(read(sourcePath)), `${key} PXD-212 current source pin`);
  }
  const qualityRowsById = new Map(quality.ownerQualityApplicabilityCrosswalk.records.map((row) => [row.capabilityRef, row]));
  const goalRowsById = new Map(goals.successMeasureContracts.ownerCapabilityApplicabilityCrosswalk.records
    .map((row) => [row.capabilityIntentId, row]));
  const trustRowsById = new Map(trustRows.map((row) => [row.capabilityRef, row]));
  for (const id of pxd212JoinedIds) {
    const join = pxd212JoinById.get(id);
    const capabilityOutput = `${sourcePaths.capabilities}#capabilities/@id=${id}/outputArtifactTypes`;
    const qualityOutput = `${sourcePaths.quality}#ownerQualityApplicabilityCrosswalk/records/@capabilityRef=${id}/outputArtifactTypes`;
    assert.equal(join.capabilityOutputTypesRef, capabilityOutput);
    assert.equal(join.qualityOutputTypesRef, qualityOutput);
    assert.equal(join.capabilityOutputTypesSha256, sha(JSON.stringify(capabilities.get(id).outputArtifactTypes)));
    assert.equal(join.qualityOutputTypesSha256, sha(JSON.stringify(qualityRowsById.get(id).outputArtifactTypes)));
    assert.equal(join.capabilityOutputTypesSha256, join.qualityOutputTypesSha256);
    assert.equal(join.reviewStatus, "SEMANTIC_JOIN_REVIEWED");
    assert.equal(join.typeJoinStatus, "MATCHED_CURRENT_SOURCE");
    assert.equal(join.trustDispositionSha256, sha(JSON.stringify(trustRowsById.get(id))));
    assert.equal(join.goalApplicabilitySha256, sha(JSON.stringify(goalRowsById.get(id))));
    const difference = pxd212ExtraDifferences.find((item) => item.capabilityId === id);
    assert.equal(difference.fieldPath, "outputArtifactTypes");
    assert.equal(difference.capabilitySourceRef, capabilityOutput);
    assert.equal(difference.ownerAdjudicationSourceRef,
      `${sourcePaths.leafReview}#ownerCapabilityLeafAdjudication/records/@id=${ownerById.get(id).id}/outputArtifactTypes`);
  }
  assert.equal(review.reviewBoundary.ownerBlockerCount, 5);
  assert.equal(review.reviewBoundary.ownerApproval, "NOT_CLAIMED");
  assert.equal(review.reviewBoundary.independentAcceptance, "NOT_CLAIMED; P0-010 remains open");
  assert.equal(review.reviewBoundary.semanticEquivalence, "NOT_ASSERTED");
  assert.equal(review.reviewBoundary.acceptanceEffect, "none");

  const measureRows = goals.successMeasureContracts.ownerCapabilityApplicabilityCrosswalk.measureApplicabilityRecords.records;
  const measureProjection = measureRows.map(({ id, capabilityRef, measureRef, disposition, sourceDisposition, admission, baseline, target, qualification }) => ({
    id, capabilityRef, measureRef, disposition, sourceDisposition, admission, baseline, target, qualification,
  }));
  assert.equal(measureRows.length, 1848);
  assert.equal(review.measureProjection.rowCount, 1848);
  assert.equal(review.measureProjection.projectionSha256, sha(JSON.stringify(measureProjection)));
  assert.equal(review.measureProjection.semanticDispositionChanges, "NONE_ASSERTED");
  for (const [field, recordKey] of [
    ["disposition", "distinctDispositionValues"],
    ["admission", "distinctAdmissionValues"],
    ["baseline", "distinctBaselineValues"],
    ["target", "distinctTargetValues"],
    ["qualification", "distinctQualificationValues"],
  ]) {
    assert.deepEqual([...new Set(measureRows.map((row) => row[field]))].sort(), review.measureProjection[recordKey]);
  }

  const qualityRows = quality.ownerQualityApplicabilityCrosswalk.records;
  const dimensions = quality.qualityDimensions.map(({ id }) => id).sort();
  const metrics = quality.metricDefinitions.map(({ id }) => id).sort();
  assert.equal(qualityRows.length, 462);
  assert.equal(dimensions.length, 6);
  assert.equal(metrics.length, 16);
  for (const row of qualityRows) {
    const capability = canonical.get(row.capabilityRef);
    assert.ok(capability, `${row.capabilityRef} has an owner-adjudicated capability`);
    assert.deepEqual(row.inputArtifactTypes, capability.inputArtifactTypes, `${row.capabilityRef} current quality inputs`);
    assert.deepEqual(row.outputArtifactTypes, capability.outputArtifactTypes, `${row.capabilityRef} current quality outputs`);
    assert.deepEqual(Object.keys(row.dimensionApplicability).sort(), dimensions);
    assert.deepEqual(Object.keys(row.metricApplicability).sort(), metrics);
  }
  const qualityDispositionProjection = qualityRows.map((row) => ({
    capabilityRef: row.capabilityRef,
    dimensionApplicability: row.dimensionApplicability,
    metricApplicability: Object.fromEntries(Object.entries(row.metricApplicability).map(([id, metric]) => [id, {
      status: metric.status,
      measurementState: metric.measurementState,
      qualificationState: metric.qualificationState,
    }])),
  }));
  assert.equal(review.qualityProjection.rowCount, 462);
  assert.deepEqual(review.qualityProjection.changedCapabilityIds, changedIds.slice().sort());
  assert.equal(review.qualityProjection.artifactTypeProjectionChanged, true);
  assert.equal(review.qualityProjection.qualityDispositionProjectionChanged, false);
  assert.equal(review.qualityProjection.measurementStateProjectionChanged, false);
  assert.equal(review.qualityProjection.qualificationStateProjectionChanged, false);
  assert.equal(review.qualityProjection.dispositionProjectionSha256, sha(JSON.stringify(qualityDispositionProjection)));
  assert.deepEqual(review.qualityProjection.allMeasurementStates, ["NOT_EVALUATED"]);
  assert.deepEqual(review.qualityProjection.allQualificationStates, ["NOT_EVALUATED"]);

  assert.equal(review.qualityProjection.currentReviewDecisionRef, ".product-experience/decision-log.md#PXD-206",
    "the quality projection keeps its PXD-206 historical review reference");

  const composeIds = review.trustReconstructionProjection.refreshedComposeCapabilityIds;
  assert.equal(trustRows.length, 462);
  assert.deepEqual(composeIds, ["media.compose.multitrack-timeline", "media.compose.safe-area", "media.compose.reusable-composition"]);
  for (const id of composeIds) {
    const branch = trustById.get(id).outputBranches[0];
    const outcome = branch.outcomes[0];
    assert.equal(branch.outputArtifactType, "local-versioned-composition-candidate");
    assert.equal(outcome.epistemicRole, "DEFINITION_NOT_MEDIA_CONTENT");
    assert.equal(outcome.disposition, "NO_RECONSTRUCTION_OR_INFERENCE");
    assert.match(outcome.meaning, /local versioned composition candidate, a reviewable definition and not rendered media bytes/u);
    assert.match(outcome.meaning, /does not imply a project commit or completed render/u);
  }
  assert.equal(review.trustReconstructionProjection.reviewableCandidateIsRenderedMedia, false);
  assert.equal(review.trustReconstructionProjection.impliesProjectCommit, false);
  assert.equal(review.trustReconstructionProjection.impliesCompletedRender, false);
  assert.equal(review.trustReconstructionProjection.sourceEffect, "none");
});
