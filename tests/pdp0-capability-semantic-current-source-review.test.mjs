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
const correctionReviewPath = "docs/implementation/verification/pdp-38/p0-existing-operation-semantic-corrections-current-source-review.json";
const sourcePath = ".product-experience/pdp-0-product-truth/capabilities.yaml";
const leafReviewPath = ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml";
const read = (path) => readFileSync(resolve(root, path));
const sha = (value) => createHash("sha256").update(value).digest("hex");

test("P0 capability semantic review pins current source checks without claiming historical equivalence or acceptance", () => {
  const observation = JSON.parse(read(observationPath).toString("utf8"));
  const correctionReview = JSON.parse(read(correctionReviewPath).toString("utf8"));
  const uploadCorrectionReview = JSON.parse(read("docs/implementation/verification/pdp-38/p0-upload-byte-length-minimum-current-source-review.json").toString("utf8"));
  const currentCorrectionsReview = JSON.parse(read("docs/implementation/verification/pdp-38/p0-capability-corrections-current-source-review-current.json").toString("utf8"));
  const bytes = read(sourcePath);
  const catalog = parse(bytes.toString("utf8"));
  const leaves = catalog.capabilities;
  const leafReview = parse(read(leafReviewPath).toString("utf8"));
  const campaignExtensions = parse(read(".product-experience/pdp-0-product-truth/campaign-extensions.yaml").toString("utf8"));
  const qualityPolicy = parse(read(".product-experience/pdp-0-product-truth/quality-policy.yaml").toString("utf8"));
  const goals = parse(read(".product-experience/pdp-0-product-truth/goals-jtbd.yaml").toString("utf8"));
  const pxd206Review = JSON.parse(read("docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd206.json").toString("utf8"));
  const pxd212QualityReview = JSON.parse(read("docs/implementation/verification/pdp-38/p0-quality-current-source-review-pxd212.json").toString("utf8"));
  const pxd213QualityCurrentness = JSON.parse(read("docs/implementation/verification/pdp-38/p0-quality-current-source-review-pxd213.json").toString("utf8"));
  const pxd216Review = JSON.parse(read("docs/implementation/verification/pdp-38/p0-capability-meaning-20-leaf-current-source-review-pxd216.json").toString("utf8"));
  const pxd223Currentness = JSON.parse(read("docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd223.json").toString("utf8"));
  const adjudications = leafReview.ownerCapabilityLeafAdjudication.records;
  const byId = new Map(leaves.map((leaf) => [leaf.id, leaf]));
  const adjudicationIdSet = new Set(adjudications.map(({ capabilityRef }) => capabilityRef));
  const canonicalLeaves = leaves.filter(({ id }) => adjudicationIdSet.has(id));
  const ids = canonicalLeaves.map(({ id }) => id).sort();
  const extensionRows = campaignExtensions.currentDefinitionPopulation.records;
  const extensionIds = extensionRows.map(({ capabilityId }) => capabilityId).sort();
  const dispositionRows = canonicalLeaves.map(({ id, ownerDefinition }) => [id, ownerDefinition?.ownerDisposition]);
  const dispositionCounts = Object.fromEntries([...new Set(dispositionRows.map(([, value]) => value))]
    .sort().map((value) => [value, dispositionRows.filter(([, current]) => current === value).length]));
  const effectIntentScopeCounts = Object.fromEntries([...new Set(canonicalLeaves.map(({ ownerDefinition }) => ownerDefinition?.effect?.effectIntentScope))]
    .sort().map((value) => [value, canonicalLeaves.filter(({ ownerDefinition }) => ownerDefinition?.effect?.effectIntentScope === value).length]));
  const pxd206ChangedIds = [
    "media.compose.multitrack-timeline", "media.compose.safe-area", "media.compose.reusable-composition",
    "media.master.audio.stereo-width", "media.speech.synthesis.speaker.condition",
  ];
  const pxd206CurrentById = new Map(pxd206Review.currentProjectionChanges.map((record) => [record.capabilityId, record]));
  const currentCandidateTypeById = new Map([
    ["media.edit.inpaint", "local-inpaint-candidate-or-draft"],
    ["media.edit.matte", "local-matte-candidate-or-draft"],
    ["media.edit.retime-slow-motion-speed-ramp", "local-timing-edit-candidate-with-explicit-source-time-mapping"],
  ]);
  const pxd212JoinById = new Map(pxd212QualityReview.latestCurrentnessRefresh.changedTypeJoins.map((record) => [record.capabilityId, record]));
  const pxd213JoinById = new Map(pxd213QualityCurrentness.latestCurrentnessRefresh.changedTypeJoins.map((record) => [record.capabilityId, record]));

  assert.equal(pxd216Review.decisionRef, ".product-experience/decision-log.md#PXD-216");
  assert.equal(pxd216Review.result.status, "PASS");
  assert.equal(pxd216Review.ownerApproval, "NOT_CLAIMED");
  assert.equal(pxd216Review.independentAcceptance, "NOT_CLAIMED");
  assert.equal(pxd216Review.acceptanceEffect, "none");
  for (const [path, digest] of Object.entries(pxd216Review.sourceFingerprints).filter(([path]) => path !== sourcePath)) {
    assert.equal(sha(read(path)), digest, `${path} PXD-216 current source pin`);
  }
  assert.equal(pxd216Review.sourceFingerprints[sourcePath], pxd223Currentness.preservedSemanticReview.historicalCapabilitiesSha256,
    "PXD-216's full-file pin remains historical evidence after the PXD-221 deferral");
  assert.equal(sha(read(sourcePath)), pxd223Currentness.currentSource.capabilitiesSha256,
    "PXD-223 binds the current capabilities source bytes");
  assert.equal(pxd223Currentness.preservedSemanticReview.semanticReviewStatus,
    "PXD-216_SEMANTIC_REVIEW_PRESERVED; NO_NEW_SEMANTIC_REVIEW");
  assert.deepEqual(pxd223Currentness.preservedSemanticReview.changedReviewedCapabilityIds, []);
  assert.equal(pxd223Currentness.authority.ownerApproval, "NOT_CLAIMED");
  assert.equal(pxd223Currentness.authority.independentAcceptance, "NOT_CLAIMED");
  assert.equal(pxd213QualityCurrentness.latestCurrentnessRefresh.decisionRef, ".product-experience/decision-log.md#PXD-213");
  assert.equal(pxd213QualityCurrentness.latestCurrentnessRefresh.status, "CURRENTNESS_REFRESH_ONLY");
  assert.equal(pxd213QualityCurrentness.latestCurrentnessRefresh.semanticReview,
    "PXD-212_SEMANTIC_REVIEW_PRESERVED; NO_NEW_SEMANTIC_REVIEW",
    "PXD-213 remains an immutable historical currentness observation, not the live meaning authority");

  assert.equal(observation.source.currentSha256, correctionReview.historicalPins.find(({ decisionRef }) => decisionRef.endsWith("#PXD-122")).capabilitySha256,
    "the PXD-122 capability source fingerprint remains an immutable historical pin");
  assert.equal(uploadCorrectionReview.source.currentSha256, "4b4b4f1ab5d4908c93af5c6b4c2be47008b04f75ac45160a1be5e167edbec42d",
    "PXD-153 remains pinned to its historical capability source cut");
  assert.equal(currentCorrectionsReview.source.currentSha256, "f9a979392587069dbb9c2a653fe9866e9b61ee31192725404ec01e5426291f5d",
    "PXD-171 retains its historical source-cut pin; the scoped fields are compared against the live source below");
  assert.equal(observation.source.path, sourcePath);
  assert.equal(observation.source.historicalComparison.availability, "UNAVAILABLE_PRIOR_BYTES_NOT_RETAINED");
  assert.equal(observation.source.historicalComparison.parsedPathDelta, "NOT_ASSERTED");
  assert.equal(observation.source.historicalComparison.priorSha256, "8e036751e35623a972668757082e1cc6f6c519d23d7f829a73cae1d117568b25");
  assert.equal(leaves.length, 469);
  assert.equal(new Set(leaves.map(({ id }) => id)).size, 469);
  assert.equal(campaignExtensions.currentDefinitionPopulation.historicalCapabilityLeavesPreserved, 462);
  assert.equal(campaignExtensions.currentDefinitionPopulation.currentCapabilityDefinitions, 469);
  assert.equal(campaignExtensions.currentDefinitionPopulation.definitionExtensionCapabilityLeaves, 7);
  assert.equal(campaignExtensions.currentDefinitionPopulation.ownerAdjudications, 462);
  assert.equal(extensionRows.length, 7);
  assert.deepEqual(extensionIds.filter((id) => id !== "media.master.audio.creative-effect.apply"), [
    "media.generate.video.preset.manage", "media.generate.video.shot-condition", "media.job.schedule.manage",
    "media.project.scene.patch-merge", "media.quality.audio.content-similarity.assess", "media.recipe.specification.compile",
  ]);
  assert.equal(extensionIds.filter((id) => id === "media.master.audio.creative-effect.apply").length, 1);
  assert.equal(campaignExtensions.currentDefinitionPopulation.ownerApproval, "NOT_CLAIMED");
  assert.equal(campaignExtensions.currentDefinitionPopulation.independentAcceptance, "NOT_CLAIMED");
  assert.equal(canonicalLeaves.length, 462);
  assert.equal(new Set(ids).size, 462);
  const adjudicationIds = adjudications.map(({ capabilityRef }) => capabilityRef).sort();
  assert.equal(adjudications.length, 462);
  assert.equal(new Set(adjudicationIds).size, 462, "each P0 capability has exactly one leaf adjudication");
  assert.deepEqual(adjudicationIds, ids, "leaf adjudications contain exactly the stable P0 capability IDs");
  const adjudicationById = new Map(adjudications.map((row) => [row.capabilityRef, row]));
  assert.deepEqual([...pxd206CurrentById.keys()].sort(), pxd206ChangedIds.slice().sort(),
    "PXD-206 bounds the five superseding current-source type differences");
  for (const leaf of canonicalLeaves) {
    const adjudication = adjudicationById.get(leaf.id);
    assert.ok(adjudication, `${leaf.id} has a leaf adjudication`);
    const currentProjection = pxd206CurrentById.get(leaf.id);
    if (currentProjection) {
      assert.deepEqual(currentProjection.currentInputArtifactTypes, leaf.inputArtifactTypes, `${leaf.id} PXD-206 current inputs`);
      assert.deepEqual(currentProjection.currentOutputArtifactTypes, leaf.outputArtifactTypes, `${leaf.id} PXD-206 current outputs`);
    } else if (currentCandidateTypeById.has(leaf.id)) {
      assert.deepEqual(adjudication.inputArtifactTypes, leaf.inputArtifactTypes, `${leaf.id} historical owner-adjudication inputs remain aligned`);
      assert.deepEqual(adjudication.outputArtifactTypes, ["versioned-edited-artifact-or-project-change"],
        `${leaf.id} owner adjudication remains unchanged as a separate source record`);
      assert.equal(adjudication.independentAcceptance, "P0-010-independent-review-open",
        `${leaf.id} owner adjudication still awaits its independent review`);

      const qualityOutputTypes = qualityPolicy.ownerQualityApplicabilityCrosswalk.records
        .find(({ capabilityRef }) => capabilityRef === leaf.id)?.outputArtifactTypes;
      const trustRecord = leafReview.ownerTrustReconstructionDispositions.records
        .find(({ capabilityRef }) => capabilityRef === leaf.id);
      const goalRecord = goals.successMeasureContracts.ownerCapabilityApplicabilityCrosswalk.records
        .find(({ capabilityIntentId }) => capabilityIntentId === leaf.id);
      assert.deepEqual(leaf.outputArtifactTypes, [currentCandidateTypeById.get(leaf.id)],
        `${leaf.id} current capability source defines its exact local candidate output`);
      assert.deepEqual(qualityOutputTypes, leaf.outputArtifactTypes,
        `${leaf.id} current quality applicability uses the current capability output`);
      assert.ok(trustRecord.outputBranches.some(({ outputArtifactType }) => outputArtifactType === leaf.outputArtifactTypes[0]),
        `${leaf.id} current trust source has the exact candidate branch`);
      assert.ok(goalRecord, `${leaf.id} current goal applicability record exists`);
      const pxd212Join = pxd212JoinById.get(leaf.id);
      const pxd213Join = pxd213JoinById.get(leaf.id);
      assert.ok(pxd212Join, `${leaf.id} has a PXD-212 current semantic-join review`);
      assert.ok(pxd213Join, `${leaf.id} has a PXD-213 currentness record`);
      assert.equal(pxd212Join.reviewStatus, "SEMANTIC_JOIN_REVIEWED");
      assert.equal(pxd212Join.capabilityOutputTypesSha256, sha(JSON.stringify(leaf.outputArtifactTypes)));
      assert.equal(pxd212Join.qualityOutputTypesSha256, sha(JSON.stringify(qualityOutputTypes)));
      assert.match(pxd213Join.capabilityOutputTypesSha256, /^[a-f0-9]{64}$/u);
      assert.match(pxd213Join.qualityOutputTypesSha256, /^[a-f0-9]{64}$/u);
      assert.match(pxd213Join.trustDispositionSha256, /^[a-f0-9]{64}$/u);
      assert.match(pxd213Join.goalApplicabilitySha256, /^[a-f0-9]{64}$/u);
      assert.equal(pxd213QualityCurrentness.latestCurrentnessRefresh.ownerApproval, "NOT_CLAIMED");
      assert.equal(pxd213QualityCurrentness.latestCurrentnessRefresh.independentAcceptance, "NOT_CLAIMED");
    } else {
      assert.deepEqual(adjudication.inputArtifactTypes, leaf.inputArtifactTypes, `${leaf.id} adjudication inputs mirror current P0`);
      assert.deepEqual(adjudication.outputArtifactTypes, leaf.outputArtifactTypes, `${leaf.id} adjudication outputs mirror current P0`);
    }
  }
  assert.equal(sha(`${ids.join("\n")}\n`), observation.source.recordPopulation.sortedIdentitySetSha256);
  assert.equal(sha(JSON.stringify(dispositionRows)), observation.source.recordPopulation.ownerDispositionSnapshotSha256);
  assert.deepEqual(dispositionCounts, observation.source.recordPopulation.ownerDispositionCounts);
  assert.deepEqual(effectIntentScopeCounts, observation.source.effectIntentScopeCounts);

  const allowedScopes = new Set(catalog.ownerDefinedP0EffectIntentRule.scopes);
  for (const leaf of canonicalLeaves) {
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

  const jobSubmitExpiry = byId.get("media.job.submit").ownerDefinition.idempotencyExpiryContract;
  const expiryReview = observation.currentSourceCorrections.find(({ capabilityId }) => capabilityId === "media.job.submit");
  assert.deepEqual(expiryReview.sourceFields, ["ownerDefinition.idempotencyExpiryContract"]);
  assert.equal(expiryReview.sourceValueSha256, sha(JSON.stringify(jobSubmitExpiry)));
  assert.equal(jobSubmitExpiry.productWideDuration, "NOT_DEFINED_BY_P0");
  assert.match(jobSubmitExpiry.expiryRule, /never proves.*UNKNOWN_OUTCOME.*same scoped idempotency identity/u);
  assert.match(jobSubmitExpiry.freshIdentityRule, /new idempotency key.*fresh semantic request.*another consequential effect/u);
  assert.match(jobSubmitExpiry.artifactRetentionRule, /independent/u);
  assert.match(jobSubmitExpiry.pdp1Delegation, /PDP-1 defines the exact approved per-operation retention duration/u);
  assert.equal(expiryReview.semanticEquivalence, "NOT_ASSERTED");
  assert.equal(expiryReview.acceptanceEffect, "none");

  assert.equal(observation.decisionRef, ".product-experience/decision-log.md#PXD-122");
  assert.equal(observation.semanticEquivalence, "NOT_ASSERTED");
  assert.equal(observation.acceptanceEffect.split(";")[0], "none");
  assert.match(observation.acceptanceEffect, /does not change P0-010 acceptance/u);
  assert.match(observation.historicalPins, /PXD-098/u);
  assert.match(observation.historicalPins, /PXD-105/u);
  assert.match(observation.historicalPins, /PXD-121/u);
  assert.match(observation.reviewBoundary, /No parsed path-change counts are claimed/u);
});
