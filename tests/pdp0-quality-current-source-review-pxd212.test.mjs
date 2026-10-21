import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fingerprint, fingerprintPxdDecisionSection, projectPdp0SourceManifest } from "../scripts/lib/pdp0-phase-scoped-source-fingerprints.mjs";
import { PDP0_CAPTION_IMPORT_SELECTOR, PDP0_PXD212_CAPTION_REVIEW_PATH, PDP0_PXD213_CAPTION_REVIEW_PATH, PDP0_PXD213_QUALITY_REVIEW_PATH, PDP0_PXD216_MEANING_REVIEW_PATH, PDP0_PXD216_RECONCILIATION_PATH, PDP0_PXD218_QUALITY_REVIEW_PATH, validatePdp0Pxd212Currentness, validatePdp0Pxd213Currentness, validatePdp0Pxd218Currentness } from "../scripts/lib/pdp0-feature-review-applicability.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const sha256 = value => createHash("sha256").update(value).digest("hex");
const readText = path => readFileSync(resolve(root, path), "utf8");
const readYaml = path => parse(readText(path));

function fixture() {
  const capabilityPath = ".product-experience/pdp-0-product-truth/capabilities.yaml";
  const qualityPath = ".product-experience/pdp-0-product-truth/quality-policy.yaml";
  const leafPath = ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml";
  const goalsPath = ".product-experience/pdp-0-product-truth/goals-jtbd.yaml";
  const reqPath = ".product-experience/pdp-0-product-truth/requirements.yaml";
  const manifestPath = ".product-experience/source-manifest.yaml";
  const reusePath = ".product-experience/pdp-0-product-truth/reuse-decisions.yaml";
  const crosswalkPath = "docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json";
  const aqPath = "docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-audit-aq-traceability.json";
  const captionPath = PDP0_PXD212_CAPTION_REVIEW_PATH;
  const paths = [capabilityPath, qualityPath, leafPath, goalsPath, reqPath, crosswalkPath, aqPath];
  const sourceTexts = Object.fromEntries(paths.map(path => [path, readText(path)]));
  sourceTexts[manifestPath] = readText(manifestPath);
  sourceTexts[reusePath] = readText(reusePath);
  const sourceDocuments = Object.fromEntries(Object.entries(sourceTexts).map(([path, value]) => [path,
    path.endsWith(".yaml") ? parse(value) : JSON.parse(value)]));
  const decisionLogText = "### PXD-211 — Prior route correction\nPreserve the historical route.\n\n### PXD-212 — Current source review\nReview exact current PDP-0 type joins.\n";
  const importedCaptionTrack = sourceDocuments[capabilityPath].capabilities.find(({ id }) => id === "media.artifact.import")
    .ownerDefinition.successOutputs[0].optionalSemanticObservations.find(({ id }) => id === "importedCaptionTrack");
  const ac08 = sourceDocuments[reqPath].requirements.find(({ id }) => id === "MEDIA-REQ-CAP-ARTIFACT")
    .acceptanceCases.find(({ id }) => id === "MEDIA-REQ-CAP-ARTIFACT-AC-08");
  const captionReview = {
    schemaVersion: "media.pdp0.caption-import-current-source-review.v1",
    decisionRef: ".product-experience/decision-log.md#PXD-212",
    sourceFingerprints: {
      [capabilityPath]: sha256(sourceTexts[capabilityPath]),
      [reqPath]: sha256(sourceTexts[reqPath]),
      ".product-experience/decision-log.md#PXD-212-section": fingerprintPxdDecisionSection(decisionLogText, "PXD-212").sha256,
    },
    reviewedField: { sourceRef: PDP0_CAPTION_IMPORT_SELECTOR, currentSha256: sha256(JSON.stringify(importedCaptionTrack)) },
    requirementBinding: {
      sourceRef: `${reqPath}#requirements/@id=MEDIA-REQ-CAP-ARTIFACT/acceptanceCases/@id=MEDIA-REQ-CAP-ARTIFACT-AC-08`,
      caseSha256: sha256(JSON.stringify(ac08)),
    },
    changeAssessment: { optionalObservationChanged: false, importCapabilityTypesChanged: false, qualityDispositionChanged: false },
    reviewBoundary: { ownerApproval: "NOT_CLAIMED", independentAcceptance: "NOT_CLAIMED", acceptanceEffect: "none" },
  };
  const captionReviewText = JSON.stringify(captionReview);
  sourceTexts[captionPath] = captionReviewText;
  const typeJoins = ["media.edit.inpaint", "media.edit.matte", "media.edit.retime-slow-motion-speed-ramp"].map(capabilityId => {
    const capability = sourceDocuments[capabilityPath].capabilities.find(({ id }) => id === capabilityId);
    const qualityRow = sourceDocuments[qualityPath].ownerQualityApplicabilityCrosswalk.records.find(({ capabilityRef }) => capabilityRef === capabilityId);
    const trustRow = sourceDocuments[leafPath].ownerTrustReconstructionDispositions.records.find(({ capabilityRef }) => capabilityRef === capabilityId);
    const goalRow = sourceDocuments[goalsPath].successMeasureContracts.ownerCapabilityApplicabilityCrosswalk.records.find(({ capabilityIntentId }) => capabilityIntentId === capabilityId);
    return {
      capabilityId,
      capabilityOutputTypesRef: `${capabilityPath}#capabilities/@id=${capabilityId}/outputArtifactTypes`,
      qualityOutputTypesRef: `${qualityPath}#ownerQualityApplicabilityCrosswalk/records/@capabilityRef=${capabilityId}/outputArtifactTypes`,
      capabilityOutputTypesSha256: sha256(JSON.stringify(capability.outputArtifactTypes)),
      qualityOutputTypesSha256: sha256(JSON.stringify(qualityRow.outputArtifactTypes)),
      trustDispositionRef: `${leafPath}#ownerTrustReconstructionDispositions/records/@capabilityRef=${capabilityId}`,
      trustDispositionSha256: sha256(JSON.stringify(trustRow)),
      goalApplicabilityRef: `${goalsPath}#successMeasureContracts/ownerCapabilityApplicabilityCrosswalk/records/@capabilityIntentId=${capabilityId}`,
      goalApplicabilitySha256: sha256(JSON.stringify(goalRow)),
      reviewStatus: "SEMANTIC_JOIN_REVIEWED",
      typeJoinStatus: "MATCHED_CURRENT_SOURCE",
    };
  });
  const latestCurrentnessRefresh = {
    status: "CURRENT_SOURCE_SEMANTIC_JOIN_REVIEW",
    phaseScope: "PDP-0",
    decisionRef: ".product-experience/decision-log.md#PXD-212",
    sourceRef: capabilityPath,
    currentSourceSha256: sha256(sourceTexts[capabilityPath]),
    sourceFingerprints: {
      [capabilityPath]: sha256(sourceTexts[capabilityPath]),
      [qualityPath]: sha256(sourceTexts[qualityPath]),
      [leafPath]: sha256(sourceTexts[leafPath]),
      [goalsPath]: sha256(sourceTexts[goalsPath]),
      [reqPath]: sha256(sourceTexts[reqPath]),
      [`${manifestPath}#PDP-0-projection`]: fingerprint(projectPdp0SourceManifest(sourceDocuments[manifestPath], sourceDocuments[reusePath])),
      [crosswalkPath]: sha256(sourceTexts[crosswalkPath]),
      [aqPath]: sha256(sourceTexts[aqPath]),
      ".product-experience/decision-log.md#PXD-211-section": fingerprintPxdDecisionSection(decisionLogText, "PXD-211").sha256,
      ".product-experience/decision-log.md#PXD-212-section": fingerprintPxdDecisionSection(decisionLogText, "PXD-212").sha256,
      [captionPath]: sha256(captionReviewText),
    },
    reviewedPopulation: {
      canonicalCapabilityRows: 462, capabilityRows: 462, qualityDimensions: 6, metricDefinitions: 16,
      dimensionDispositions: 2772, metricDispositions: 7392, definitionExtensionsExcluded: 7,
      measurementState: "NOT_EVALUATED", qualificationState: "NOT_EVALUATED",
    },
    semanticReview: "PERFORMED_EXACT_TYPE_JOIN_REVIEW",
    changedTypeJoins: typeJoins,
    ownerApproval: "NOT_CLAIMED",
    independentAcceptance: "NOT_CLAIMED",
    acceptanceEffect: "none",
    reviewArtifactRef: captionPath,
    reviewArtifactSha256: sha256(captionReviewText),
  };
  const qualityHistoryReview = {
    schemaVersion: "media.pdp0.quality-current-source-review.v1",
    artifactId: "P0-QUALITY-CURRENT-SOURCE-REVIEW-002",
    latestCurrentnessRefresh,
  };
  const latestQualityReview = {
    schemaVersion: "media.pdp0.quality-currentness-successor.v1",
    latestCurrentnessRefresh: structuredClone(latestCurrentnessRefresh),
  };
  sourceTexts[".product-experience/decision-log.md"] = decisionLogText;
  return { qualityHistoryReview, latestQualityReview, captionReview, sourceDocuments, sourceTexts, decisionLogText };
}

function pxd213Fixture() {
  const input = fixture();
  const currentPath = PDP0_PXD213_CAPTION_REVIEW_PATH;
  const decisionLogText = `${input.decisionLogText}\n### PXD-213 — Current source successor\nRetain the reviewed product meanings and source joins.\n`;
  input.sourceTexts[".product-experience/decision-log.md"] = decisionLogText;
  input.sourceTexts["docs/implementation/verification/pdp-38/p0-quality-current-source-review-pxd212.json"] = readText("docs/implementation/verification/pdp-38/p0-quality-current-source-review-pxd212.json");
  const caption = structuredClone(input.captionReview);
  caption.artifactId = "P0-CAPTION-IMPORT-CURRENT-SOURCE-REVIEW-PXD213";
  caption.decisionRef = ".product-experience/decision-log.md#PXD-213";
  caption.sourceFingerprints[".product-experience/decision-log.md#PXD-213-section"] = fingerprintPxdDecisionSection(decisionLogText, "PXD-213").sha256;
  delete caption.sourceFingerprints[".product-experience/decision-log.md#PXD-212-section"];
  const captionText = JSON.stringify(caption);
  input.captionReview = caption;
  input.sourceTexts[currentPath] = captionText;
  const latest = structuredClone(input.qualityHistoryReview.latestCurrentnessRefresh);
  latest.decisionRef = ".product-experience/decision-log.md#PXD-213";
  latest.status = "CURRENTNESS_REFRESH_ONLY";
  latest.semanticReview = "PXD-212_SEMANTIC_REVIEW_PRESERVED; NO_NEW_SEMANTIC_REVIEW";
  latest.preservedSemanticReviewRef = ".product-experience/decision-log.md#PXD-212";
  latest.preservedSemanticReviewArtifactSha256 = sha256(input.sourceTexts["docs/implementation/verification/pdp-38/p0-quality-current-source-review-pxd212.json"]);
  latest.sourceFingerprints["docs/implementation/verification/pdp-38/p0-quality-current-source-review-pxd212.json"] = latest.preservedSemanticReviewArtifactSha256;
  latest.sourceFingerprints[".product-experience/decision-log.md#PXD-212-section"] = fingerprintPxdDecisionSection(decisionLogText, "PXD-212").sha256;
  latest.sourceFingerprints[".product-experience/decision-log.md#PXD-213-section"] = fingerprintPxdDecisionSection(decisionLogText, "PXD-213").sha256;
  latest.sourceFingerprints[currentPath] = sha256(captionText);
  delete latest.sourceFingerprints[PDP0_PXD212_CAPTION_REVIEW_PATH];
  latest.reviewArtifactRef = currentPath;
  latest.reviewArtifactSha256 = sha256(captionText);
  input.qualityHistoryReview.latestCurrentnessRefresh = latest;
  input.latestQualityReview = { schemaVersion: "media.pdp0.quality-currentness-successor.v1", latestCurrentnessRefresh: structuredClone(latest) };
  input.sourceTexts["docs/implementation/verification/pdp-38/p0-caption-import-current-source-review-pxd212.json"] = undefined;
  input.decisionLogText = decisionLogText;
  return input;
}

function liveFixture() {
  const paths = [
    ".product-experience/pdp-0-product-truth/capabilities.yaml",
    ".product-experience/pdp-0-product-truth/quality-policy.yaml",
    ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml",
    ".product-experience/pdp-0-product-truth/goals-jtbd.yaml",
    ".product-experience/pdp-0-product-truth/requirements.yaml",
    ".product-experience/source-manifest.yaml",
    ".product-experience/pdp-0-product-truth/reuse-decisions.yaml",
    "docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json",
    "docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-audit-aq-traceability.json",
    "docs/implementation/verification/pdp-38/p0-quality-current-source-review-pxd212.json",
  ];
  const sourceTexts = Object.fromEntries(paths.map(path => [path, readText(path)]));
  const sourceDocuments = Object.fromEntries(paths.map(path => [path, [".yaml", ".yml"].some(ext => path.endsWith(ext))
    ? parse(sourceTexts[path]) : JSON.parse(sourceTexts[path])]));
  const captionPath = PDP0_PXD212_CAPTION_REVIEW_PATH;
  sourceTexts[captionPath] = readText(captionPath);
  const decisionLogText = readText(".product-experience/decision-log.md");
  return {
    qualityHistoryReview: JSON.parse(readText("docs/implementation/verification/pdp-38/p0-quality-current-source-review-current.json")),
    latestQualityReview: JSON.parse(readText("docs/implementation/verification/pdp-38/p0-quality-current-source-review-pxd212.json")),
    captionReview: JSON.parse(sourceTexts[captionPath]),
    sourceDocuments,
    sourceTexts,
    decisionLogText,
  };
}

function livePxd213Fixture() {
  const input = liveFixture();
  input.sourceTexts[PDP0_PXD213_CAPTION_REVIEW_PATH] = readText(PDP0_PXD213_CAPTION_REVIEW_PATH);
  input.captionReview = JSON.parse(input.sourceTexts[PDP0_PXD213_CAPTION_REVIEW_PATH]);
  input.latestQualityReview = JSON.parse(readText("docs/implementation/verification/pdp-38/p0-quality-current-source-review-pxd213.json"));
  return input;
}

function livePxd218Fixture() {
  const input = livePxd213Fixture();
  input.latestQualityReview = JSON.parse(readText(PDP0_PXD218_QUALITY_REVIEW_PATH));
  for (const path of [PDP0_PXD213_QUALITY_REVIEW_PATH, PDP0_PXD216_MEANING_REVIEW_PATH, PDP0_PXD216_RECONCILIATION_PATH]) {
    input.sourceTexts[path] = readText(path);
  }
  return input;
}

test("PXD-213 remains immutable history while PXD-218 is the live currentness authority", () => {
  const input = livePxd213Fixture();
  const pxd213 = JSON.parse(readText(PDP0_PXD213_QUALITY_REVIEW_PATH));
  const pxd218 = JSON.parse(readText(PDP0_PXD218_QUALITY_REVIEW_PATH));
  assert.equal(pxd213.latestCurrentnessRefresh.decisionRef, ".product-experience/decision-log.md#PXD-213");
  assert.equal(pxd213.latestCurrentnessRefresh.sourceFingerprints["docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json"], "9ad931cee5ff073f3d8129238548f0711d66a44185d78f5a209e35f5b301772d");
  assert.equal(input.qualityHistoryReview.latestCurrentnessRefresh.decisionRef, ".product-experience/decision-log.md#PXD-218");
  assert.equal(pxd218.latestCurrentnessRefresh.decisionRef, ".product-experience/decision-log.md#PXD-218");
  assert.equal(fingerprint(input.qualityHistoryReview.latestCurrentnessRefresh), fingerprint(pxd218.latestCurrentnessRefresh));
  assert.equal(JSON.parse(readText("docs/implementation/verification/pdp-38/p0-quality-current-source-review-pxd212.json")).latestCurrentnessRefresh.decisionRef, ".product-experience/decision-log.md#PXD-212");
  assert.equal(JSON.parse(readText(PDP0_PXD212_CAPTION_REVIEW_PATH)).decisionRef, ".product-experience/decision-log.md#PXD-212");
});

test("PXD-212 validates exact current PDP-0 quality joins and unchanged caption import successor", () => {
  const input = fixture();
  const result = validatePdp0Pxd212Currentness(input);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
  assert.equal(Object.keys(result.expectedPins).length, 11);
});

test("PXD-213 currentness successor preserves quality joins and binds the current decision section", () => {
  const input = pxd213Fixture();
  const result = validatePdp0Pxd213Currentness(input);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
  assert.equal(Object.keys(result.expectedPins).length, 13);
  assert.equal(input.qualityHistoryReview.latestCurrentnessRefresh.reviewedPopulation.measurementState, "NOT_EVALUATED");
  assert.equal(input.qualityHistoryReview.latestCurrentnessRefresh.acceptanceEffect, "none");
  assert.equal(input.qualityHistoryReview.latestCurrentnessRefresh.status, "CURRENTNESS_REFRESH_ONLY");
  assert.equal(input.qualityHistoryReview.latestCurrentnessRefresh.semanticReview, "PXD-212_SEMANTIC_REVIEW_PRESERVED; NO_NEW_SEMANTIC_REVIEW");
});

test("PXD-212 rejects stale pins, a missing changed type join, or a caption disposition change", () => {
  const stale = fixture();
  stale.qualityHistoryReview.latestCurrentnessRefresh.sourceFingerprints[".product-experience/pdp-0-product-truth/capabilities.yaml"] = "0".repeat(64);
  assert.equal(validatePdp0Pxd212Currentness(stale).valid, false);

  const missingJoin = fixture();
  missingJoin.qualityHistoryReview.latestCurrentnessRefresh.changedTypeJoins.pop();
  assert.equal(validatePdp0Pxd212Currentness(missingJoin).valid, false);

  const changedCaption = fixture();
  changedCaption.captionReview.changeAssessment.qualityDispositionChanged = true;
  assert.equal(validatePdp0Pxd212Currentness(changedCaption).valid, false);
});

test("PXD-213 rejects stale successor pins, missing joins, and caption disposition changes", () => {
  const stale = livePxd213Fixture();
  stale.qualityHistoryReview.latestCurrentnessRefresh.sourceFingerprints[".product-experience/pdp-0-product-truth/capabilities.yaml"] = "0".repeat(64);
  assert.equal(validatePdp0Pxd213Currentness(stale).valid, false);

  const missingJoin = livePxd213Fixture();
  missingJoin.qualityHistoryReview.latestCurrentnessRefresh.changedTypeJoins.pop();
  assert.equal(validatePdp0Pxd213Currentness(missingJoin).valid, false);

  const changedCaption = livePxd213Fixture();
  changedCaption.captionReview.changeAssessment.qualityDispositionChanged = true;
  assert.equal(validatePdp0Pxd213Currentness(changedCaption).valid, false);
});

test("PXD-218 revalidates the exact PXD-216 source closure and rejects nested stale pins", () => {
  const input = livePxd218Fixture();
  const result = validatePdp0Pxd218Currentness(input);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
  assert.equal(Object.keys(result.expectedPins).length, 18);
  assert.equal(input.qualityHistoryReview.latestCurrentnessRefresh.semanticReview,
    "PXD-216_SEMANTIC_REVIEW_PRESERVED; NO_NEW_SEMANTIC_REVIEW");

  const stale = livePxd218Fixture();
  stale.qualityHistoryReview.latestCurrentnessRefresh.sourceFingerprints[
    "docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json"
  ] = "9ad931cee5ff073f3d8129238548f0711d66a44185d78f5a209e35f5b301772d";
  stale.latestQualityReview.latestCurrentnessRefresh.sourceFingerprints[
    "docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json"
  ] = "9ad931cee5ff073f3d8129238548f0711d66a44185d78f5a209e35f5b301772d";
  assert.equal(validatePdp0Pxd218Currentness(stale).valid, false,
    "a stale nested crosswalk pin must fail even when its containing review records are otherwise current");
});
