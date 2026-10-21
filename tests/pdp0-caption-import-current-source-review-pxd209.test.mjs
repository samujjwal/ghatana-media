import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const read = (path) => readFileSync(resolve(root, path));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jsonSha256 = (value) => sha256(Buffer.from(JSON.stringify(value), "utf8"));
const artifactPath = "docs/implementation/verification/pdp-38/p0-caption-import-current-source-review-pxd209.json";
const predecessorPath = "docs/implementation/verification/pdp-38/p0-capability-corrections-current-source-review-current.json";
const capabilityPath = ".product-experience/pdp-0-product-truth/capabilities.yaml";
const requirementPath = ".product-experience/pdp-0-product-truth/requirements.yaml";

test("PXD-209 pins only the delegated caption-import successor and preserves the PXD-171 source cut", () => {
  const review = JSON.parse(read(artifactPath).toString("utf8"));
  const pxd171 = JSON.parse(read(predecessorPath).toString("utf8"));
  const capabilityBytes = read(capabilityPath);
  const capabilities = parse(capabilityBytes.toString("utf8")).capabilities;
  const requirements = parse(read(requirementPath).toString("utf8")).requirements;
  const importCapability = capabilities.find(({ id }) => id === "media.artifact.import");
  const importOutputs = importCapability.ownerDefinition.successOutputs;
  const importObservation = importOutputs.find(({ artifactType }) => artifactType === "import-observation-and-source-resolution-evidence");
  const ac08 = requirements.find(({ id }) => id === "MEDIA-REQ-CAP-ARTIFACT").acceptanceCases
    .find(({ id }) => id === "MEDIA-REQ-CAP-ARTIFACT-AC-08");
  const predecessorField = pxd171.records.find(({ capabilityId, fieldPath }) => capabilityId === "media.artifact.import"
    && fieldPath === "ownerDefinition.successOutputs");
  const currentPredecessorProjection = importOutputs.map(output => {
    if (output.artifactType !== "import-observation-and-source-resolution-evidence") return output;
    const { optionalSemanticObservations: _optionalSemanticObservations, ...predecessorOutput } = output;
    return predecessorOutput;
  });
  const expectedObservation = {
    id: "importedCaptionTrack",
    when: "An authorized sidecar or embedded caption track is explicitly requested and observed in the exact immutable imported source version.",
    fields: {
      sourceVersionRef: "Exact immutable source version inspected.",
      captionTrackRef: "Track identity or source location as observed.",
      language: "Observed language tag when available; otherwise UNKNOWN.",
      format: "Observed sidecar format or embedded track encoding when available; otherwise UNKNOWN.",
      timingMapping: "Declared source timebase, any explicit mapping applied, and conversion or alignment uncertainty.",
      provenance: "Whether the track was observed embedded or supplied as an authorized sidecar.",
    },
    constraints: [
      "Observation does not alter source media, register or replace a canonical artifact, or claim caption correctness.",
      "Missing, malformed, or unknown track mapping remains explicit.",
    ],
  };

  assert.equal(pxd171.decisionRef, ".product-experience/decision-log.md#PXD-171");
  assert.equal(pxd171.source.currentSha256, "f9a979392587069dbb9c2a653fe9866e9b61ee31192725404ec01e5426291f5d");
  assert.equal(predecessorField.fieldSha256, "8f819298dcfbe119a3967ef9eefe5cf3d3bfac9c912d700aa96e654fef534514");
  assert.equal(review.schemaVersion, "media.pdp0.caption-import-current-source-review.v1");
  assert.equal(review.decisionRef, ".product-experience/decision-log.md#PXD-209");
  assert.equal(review.source.predecessorSha256, pxd171.source.currentSha256);
  assert.equal(review.source.currentSha256, "6a0674f350af8bb75f54641f31377f199b27e016e2c3163b557ffa19397dac45",
    "PXD-209 capability digest remains an immutable historical source pin");
  assert.equal(review.reviewedField.sourceRef, predecessorField.sourceRef);
  assert.equal(review.reviewedField.predecessorSha256, predecessorField.fieldSha256);
  assert.equal(review.reviewedField.currentSha256, jsonSha256(importOutputs));
  assert.equal(review.source.historicalPredecessorSourceSha256, "f9a979392587069dbb9c2a653fe9866e9b61ee31192725404ec01e5426291f5d");
  assert.equal(review.source.predecessorGitBlobSha1, "50415818c623b29a19bc82544f1b43d256ba18ef");
  assert.equal(review.reviewedField.predecessorProjectionSourceSha256, review.source.historicalPredecessorSourceSha256);
  assert.equal(review.reviewedField.predecessorProjectionSha256, predecessorField.fieldSha256);
  assert.equal(jsonSha256(review.reviewedField.predecessorProjection), predecessorField.fieldSha256);
  assert.deepEqual(review.reviewedField.predecessorProjection, currentPredecessorProjection);
  assert.deepEqual(review.reviewedField.addedOptionalObservation, expectedObservation);
  assert.deepEqual(importObservation.optionalSemanticObservations, [expectedObservation]);
  assert.equal(review.requirementBinding.sourceRef,
    `${requirementPath}#requirements/@id=MEDIA-REQ-CAP-ARTIFACT/acceptanceCases/@id=MEDIA-REQ-CAP-ARTIFACT-AC-08`);
  assert.equal(review.requirementBinding.sourceSha256, "9f3dc3e9af961a5c24a2fe5e2c9ad65ff2f3f4f5d46ffb231e80f162b23231af",
    "PXD-209 AC-08 source digest remains an immutable historical source pin");
  assert.equal(review.requirementBinding.requirementCaseSha256, jsonSha256(ac08));
  assert.deepEqual(review.decisionSection, {
    sourceRef: ".product-experience/decision-log.md#PXD-209-section",
    sha256: "bd024f73efbd5dffe4962de912767f35d27ffc94460184d54e13c6afe1cc6f5f",
  });
  assert.deepEqual(review.definitionPopulation, {
    historicalOwnerAdjudicatedCapabilityLeaves: 462,
    definitionExtensionLeaves: 7,
    currentDefinitionCount: 469,
    newCapabilityCount: 0,
  });
  assert.equal(review.reviewBoundary.semanticDisposition, "USER_DELEGATED_PDP0_SEMANTIC_ADDITION");
  assert.equal(review.reviewBoundary.semanticEquivalence, "NOT_ASSERTED");
  assert.equal(review.reviewBoundary.acceptanceEffect, "none");
  assert.equal(review.reviewBoundary.ownerApproval, "NOT_CLAIMED");
  assert.equal(review.reviewBoundary.independentAcceptance, "NOT_CLAIMED");
  assert.equal(review.reviewBoundary.implementation, "NOT_ASSERTED");
  assert.equal(review.reviewBoundary.formatOrParserSupport, "NOT_ASSERTED");
  assert.equal(review.reviewBoundary.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(review.reviewBoundary.qualification, "NOT_ASSERTED");
  assert.equal(review.reviewBoundary.nativeClosure, "NOT_ASSERTED");
  assert.equal(review.reviewBoundary.deliveryReadiness, "NOT_ASSERTED");
});
