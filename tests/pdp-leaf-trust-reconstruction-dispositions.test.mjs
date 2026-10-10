import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const parse = require("yaml").parse;
const read = (name) => parse(readFileSync(resolve(root, `.product-experience/pdp-0-product-truth/${name}.yaml`), "utf8"));
const capabilities = read("capabilities").capabilities;
const review = read("capability-leaf-review");
const currentReview = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/p0-capability-semantic-current-source-review.json"), "utf8"));
const driftInventory = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/p0-leaf-trust-current-type-drift-inventory.json"), "utf8"));
const policy = review.ownerTrustReconstructionDispositions;
const rows = new Map(policy.records.map((row) => [row.capabilityRef, row]));
const capById = new Map(capabilities.map((row) => [row.id, row]));
const capRef = (id) => `.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=${id}`;
const sha = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");

function valid(doc, inventory = driftInventory, semanticReview = currentReview) {
  const nope = () => false;

  const caps = new Map(doc.capabilities.capabilities.map((row) => [row.id, row]));
  const adjudications = new Map(doc.review.ownerCapabilityLeafAdjudication.records.map((row) => [row.capabilityRef, row]));
  const records = doc.review.ownerTrustReconstructionDispositions.records;
  if (caps.size !== 462 || records.length !== 462 || new Set(records.map((row) => row.capabilityRef)).size !== 462) return false;
  if (inventory.counts.inputTypeMismatches !== 42 || inventory.counts.outputTypeMismatches !== 26 || inventory.counts.individualTypeMismatches !== 68) return false;
  if (inventory.source.currentSourceFileSha256 !== sha(readFileSync(resolve(root, inventory.source.capabilitiesPath), "utf8"))) return false;
  if (inventory.records.length !== 63 || inventory.mismatches.length !== 68) return false;
  const historicalMismatches = new Map();
  for (const mismatch of inventory.mismatches) {
    if (mismatch.semanticEquivalence !== "NOT_ASSERTED" || mismatch.acceptanceEffect !== "none") return false;
    const key = `${mismatch.capabilityId}:${mismatch.mismatchKind}`;
    if (historicalMismatches.has(key)) return false;
    historicalMismatches.set(key, mismatch);
  }
  if (semanticReview.source.currentSha256 !== inventory.source.currentSourceFileSha256) return false;
  const audit = inventory.duplicateSelectorAudit;
  if (!audit || audit.semanticEquivalence !== "NOT_ASSERTED" || audit.acceptanceEffect !== "none") return false;
  const distinctHistoricalBranches = new Set(audit.historicalDuplicateSelectorBranches
    .filter((item) => !item.outcomesByteEquivalent).map((item) => `${item.capabilityId}:${item.branchIndex}`));
  let activeDistinctDuplicateSelectors = 0;
  for (const row of records) {
    const cap = caps.get(row.capabilityRef), adjudication = adjudications.get(row.capabilityRef);
    if (!cap || !adjudication) return false;
    const currentInputTypes = cap.ownerDefinition.typedInputSlots.map((slot) => slot.sourceType);
    const currentOutputTypes = cap.ownerDefinition.successOutputs.map((output) => output.artifactType);
    if (JSON.stringify(row.inputArtifactTypes) !== JSON.stringify(currentInputTypes)) return false;
    if (JSON.stringify(row.outputArtifactTypes) !== JSON.stringify(currentOutputTypes)) return false;
    for (const [kind, currentTypes] of [["INPUT_ARTIFACT_TYPES", currentInputTypes], ["OUTPUT_ARTIFACT_TYPES", currentOutputTypes]]) {
      const mismatch = historicalMismatches.get(`${row.capabilityRef}:${kind}`);
      if (!mismatch) continue;
      if (JSON.stringify(mismatch.currentTypes) !== JSON.stringify(currentTypes) || mismatch.currentTypesSha256 !== sha(currentTypes)) return false;
      const full = inventory.records.find((item) => item.capabilityId === row.capabilityRef);
      if (!full || full.semanticEquivalence !== "NOT_ASSERTED" || full.acceptanceEffect !== "none") return false;
      const historical = kind === "INPUT_ARTIFACT_TYPES" ? full.historicalInputArtifactTypes : full.historicalTrustOutputArtifactTypes;
      const historicalHash = kind === "INPUT_ARTIFACT_TYPES" ? full.historicalInputArtifactTypesSha256 : full.historicalTrustOutputArtifactTypesSha256;
      if (JSON.stringify(historical) !== JSON.stringify(mismatch.historicalTypes) || historicalHash !== mismatch.historicalTypesSha256
        || historicalHash !== sha(historical)) return false;
      if (full.currentTypesMatchP0 !== true || full.resolvedCurrentTrustRecordSha256 !== sha(row)
        || full.resolvedCurrentOutputBranchesSha256 !== sha(row.outputBranches)) return false;
    }
    if (row.outputBranches.length !== row.outputArtifactTypes.length) return false;
    if (row.sourceRefs.some((ref) => !ref.startsWith(".product-experience/pdp-0-product-truth/"))) return false;
    for (let i = 0; i < row.outputBranches.length; i++) {
      const branch = row.outputBranches[i];
      if (branch.outputArtifactType !== row.outputArtifactTypes[i]) return false;
      if (branch.sourceArtifactTypeRef !== `${capRef(row.capabilityRef)}/outputArtifactTypes/${i}`) return false;
      if (fullSpatialSelectorIds.has(row.capabilityRef)) {
        const selected = `outputArtifactType=${cap.ownerDefinition.successOutputs[i].artifactType}; originRelation=SOURCE_DERIVED; epistemicDisposition=ESTIMATED_OR_RECONSTRUCTED`;
        const sourceSlot = cap.ownerDefinition.typedInputSlots[1];
        const provenance = JSON.stringify(cap.provenance);
        if (branch.when !== selected || branch.outcomes.length !== 1 || branch.outcomes[0].when !== selected
          || branch.outcomes[0].disposition !== "ESTIMATED_OR_RECONSTRUCTED"
          || cap.ownerDefinition.successOutputs[i].originRelation !== "SOURCE_DERIVED"
          || cap.ownerDefinition.successOutputs[i].epistemicDisposition !== "ESTIMATED_OR_RECONSTRUCTED"
          || !sourceSlot?.required || !sourceSlot.sourceType || cap.ownerDefinition.effect.sourcePreservationRequired !== false
          || !/exact artifact\/version/u.test(provenance) || /(?:is recovered source truth|establishes ground truth)/u.test(branch.outcomes[0].meaning)) return false;
      }
      if (!branch.outcomes.length || branch.outcomes.some((outcome) => !["NO_RECONSTRUCTION_OR_INFERENCE", "SOURCE_DERIVED_TRANSFORMATION", "ESTIMATED_OR_RECONSTRUCTED", "ESTIMATED_OR_INFERRED_OBSERVATION"].includes(outcome.disposition))) return false;
      const selectors = branch.outcomes.map((outcome) => outcome.when);
      if (new Set(selectors).size !== selectors.length) {
        if (!distinctHistoricalBranches.has(`${row.capabilityRef}:${i}`) || new Set(branch.outcomes.map((outcome) => JSON.stringify(outcome))).size !== branch.outcomes.length) return false;
        activeDistinctDuplicateSelectors++;
      }
      if (["media.animation.2d", "media.animation.vector", "media.animation.3d"].includes(row.capabilityRef)) {
        const predicates = branch.outcomes.map((outcome) => outcome.when);
        if (new Set(predicates).size !== predicates.length) return false;
      }
    }
  }
  if (activeDistinctDuplicateSelectors !== 0) return false;
  const pxd128Ids = new Set(driftInventory.resultVariantReview?.capabilityIds?.map(({ capabilityId }) => capabilityId) ?? []);
  if (pxd128Ids.size !== 68) return false;
  for (const id of pxd128Ids) {
    const cap = caps.get(id);
    const row = records.find((item) => item.capabilityRef === id);
    const variants = cap?.ownerDefinition?.successOutputs?.[0]?.resultVariants;
    const outcomes = row?.outputBranches?.[0]?.outcomes;
    if (!Array.isArray(variants) || !variants.length || !Array.isArray(outcomes)
      || variants.length !== outcomes.length
      || new Set(variants.map(({ selector }) => selector)).size !== variants.length
      || JSON.stringify(variants.map(({ selector }) => selector)) !== JSON.stringify(outcomes.map(({ when }) => when))) return false;
  }
  for (const [id, [disposition, role, meaningPattern]] of Object.entries(materialOutcomeExpectations)) {
    const row = policy.records.find((item) => item.capabilityRef === id);
    if (row.outputBranches.length !== 1 || row.outputBranches[0].outcomes.length !== 1) return false;
    const outcome = row.outputBranches[0].outcomes[0];
    if (outcome.disposition !== disposition || outcome.epistemicRole !== role || !meaningPattern.test(outcome.meaning)) return false;
  }
  return true;
}

const fullSpatialSelectorIds = new Set([
  "media.generate.spatial.image-to-3d", "media.generate.spatial.reconstruct.multiview",
  "media.generate.spatial.reconstruct.depth", "media.generate.spatial.reconstruct.camera",
  "media.generate.spatial.generate.novel-view", "media.generate.spatial.relight-3d",
  "media.generate.spatial.compose-3d", "media.generate.spatial.representation.nerf-adapter",
  "media.generate.spatial.representation.gaussian-splatting-adapter",
]);
const materialOutcomeExpectations = {
  "media.artifact.share": ["NO_RECONSTRUCTION_OR_INFERENCE", "ARTIFACT_SHARING_GRANT_OBSERVATION", /observation of the governed sharing grant.*does not expand the supplied authority/u],
  "media.artifact.share.revoke": ["NO_RECONSTRUCTION_OR_INFERENCE", "ARTIFACT_SHARING_REVOCATION_OBSERVATION", /confirmed revocation or UNKNOWN.*UNKNOWN does not imply revocation/u],
  "media.artifact.delete": ["NO_RECONSTRUCTION_OR_INFERENCE", "ARTIFACT_LIFECYCLE_OBSERVATION_NOT_PHYSICAL_ERASURE", /access revocation.*does not claim physical erasure/u],
  "media.rights.attestation.record": ["NO_RECONSTRUCTION_OR_INFERENCE", "ASSERTED_RIGHTS_ATTESTATION_NOT_EVALUATION", /asserted rights-attestation record.*distinct from a consent reference and permitted-use evaluation/u],
  "media.speech.synthesis.speaker.clone-authorized": ["ESTIMATED_OR_RECONSTRUCTED", "DERIVED_SPEAKER_PROFILE_NOT_SPEECH_MEDIA", /derived authorized speaker voice-profile record, not speech media/u],
};

const sources = { capabilities: read("capabilities"), review };

test("P0-122 current capability contracts and historical trust rows reconcile without asserting equivalence", () => {
  assert.equal(policy.population.recordCount, 462);
  assert.equal(driftInventory.source.currentSourceFileSha256, "d4b8b1747831dd3843ac5945530087c4fc2af01410d09c803bb1b84d52960c22");
  assert.deepEqual(driftInventory.currentSourceCutRefresh.affectedCapabilityIds, ["media.project.review"]);
  assert.equal(driftInventory.currentSourceCutRefresh.affectedCurrentTypeMismatches, 0);
  assert.equal(driftInventory.currentSourceCutRefresh.semanticEquivalence, "NOT_ASSERTED");
  assert.equal(driftInventory.currentSourceCutRefresh.acceptanceEffect, "none");
  assert.equal(driftInventory.currentSourceCutRefresh.decisionRef, ".product-experience/decision-log.md#PXD-135");
  assert.equal(driftInventory.currentSourceCutRefresh.currentSourceSha256, "c46903fcef1e378b6f396efe81947e026c51699811f14491d361c0ddcabb63db",
    "the PXD-135 source-cut observation remains immutable");
  const subsequentRefresh = driftInventory.subsequentCurrentSourceCutRefresh;
  assert.equal(subsequentRefresh.decisionRef, ".product-experience/decision-log.md#PXD-122");
  assert.equal(subsequentRefresh.priorSourceSha256, driftInventory.currentSourceCutRefresh.currentSourceSha256);
  assert.equal(subsequentRefresh.currentSourceSha256, driftInventory.source.currentSourceFileSha256);
  assert.deepEqual(subsequentRefresh.affectedCapabilityIds, ["media.job.submit"]);
  assert.equal(subsequentRefresh.affectedCurrentTypeMismatches, 0);
  assert.equal(subsequentRefresh.contractRef,
    ".product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.job.submit/ownerDefinition/idempotencyExpiryContract");
  assert.equal(subsequentRefresh.populationCountsUnchanged.capabilityRecords, 462);
  assert.equal(subsequentRefresh.populationCountsUnchanged.uniqueCapabilities, driftInventory.counts.uniqueCapabilities);
  assert.equal(subsequentRefresh.populationCountsUnchanged.identityTypeMismatches, driftInventory.counts.individualTypeMismatches);
  assert.equal(subsequentRefresh.populationCountsUnchanged.inputTypeMismatches, driftInventory.counts.inputTypeMismatches);
  assert.equal(subsequentRefresh.populationCountsUnchanged.outputTypeMismatches, driftInventory.counts.outputTypeMismatches);
  assert.equal(subsequentRefresh.semanticEquivalence, "NOT_ASSERTED");
  assert.equal(subsequentRefresh.acceptanceEffect, "none");
  assert.match(subsequentRefresh.meaning, /no product-wide duration/u);
  const phaseInventory = driftInventory.records.find(({ capabilityId }) => capabilityId === "media.audio.analysis.analyze.phase");
  const phaseMismatch = driftInventory.mismatches.find(({ capabilityId, mismatchKind }) => capabilityId === "media.audio.analysis.analyze.phase" && mismatchKind === "OUTPUT_ARTIFACT_TYPES");
  assert.equal(phaseInventory.historicalTrustOutputArtifactTypesSha256, "36c76818ecd60118d5ce4995a83a35af9c6229e175b91178f87bd98e4a9ab165");
  assert.equal(phaseInventory.outputOriginMeaningAssessment, "HISTORICAL_MEANING_REMAINS_ONLY_A_FROZEN_CLAIM; NO_EQUIVALENCE_ASSERTED");
  assert.deepEqual(phaseMismatch.currentTypes, capById.get("media.audio.analysis.analyze.phase").ownerDefinition.successOutputs.map(({ artifactType }) => artifactType));
  assert.equal(phaseMismatch.disposition, "SAFE_TYPED_OUTPUT_LABEL_REFINEMENT_CANDIDATE");
  assert.equal(phaseInventory.outputTypesChanged, false);
  assert.equal(phaseInventory.outputBranchTypeMappingAssessment, "EXACT_OUTPUT_TYPE_AND_INDEX_AGREE_WITH_CURRENT_P0");
  assert.equal(phaseInventory.semanticEquivalence, "NOT_ASSERTED");
  assert.equal(phaseInventory.acceptanceEffect, "none");
  assert.equal(valid(sources), true);
  assert.match(policy.scopeStatus, /runtime NOT_ADMITTED; qualification NOT_EVALUATED/u);
  assert.match(policy.joinRule, /P0 capability ID[\s\S]*no PDP-1 operation, wire schema, or domain-object definition/u);
  assert.doesNotMatch(JSON.stringify(policy), /pdp-1-domain-data|operationContractRef|sourceSchemaRef|requestSchemaRef|domainObjectRef/u);
  const activeMeanings = policy.records.flatMap((record) => record.outputBranches.flatMap((branch) => branch.outcomes.map((outcome) => outcome.meaning))).join("\n");
  assert.doesNotMatch(activeMeanings, /exact owner, operation, tenant\/version scope|operation contract binds|separate exact operation must bind|exact operation (?:result|applies)|separately authorized operation result|operation authority and finality remain governed by the exact operation contract/u);
  assert.match(activeMeanings, /exact owner, capability-intent identity, tenant\/version scope/u);
  assert.match(activeMeanings, /Source linkage and rendered-content effects remain UNKNOWN until authoritative evidence identifies the exact source artifact\/version actually used/u);

  const deterministicConversions = [
    "media.enhance.image.white-balance", "media.enhance.image.exposure", "media.enhance.image.gamut-conversion",
    "media.enhance.image.tone-conversion", "media.enhance.audio.sample-rate-conversion",
  ];
  for (const id of deterministicConversions) {
    assert.ok(rows.get(id).outputBranches.flatMap((branch) => branch.outcomes).some((outcome) => outcome.disposition === "SOURCE_DERIVED_TRANSFORMATION"), id);
  }
  for (const id of ["media.animation.2d", "media.animation.vector", "media.animation.3d", "media.animation.keyframe"]) {
    const outcomes = rows.get(id).outputBranches.flatMap((branch) => branch.outcomes);
    assert.ok(outcomes.some((outcome) => outcome.epistemicRole === "DEFINITION_NOT_MEDIA_CONTENT"));
    if (id === "media.animation.keyframe") {
      assert.ok(outcomes.every((outcome) => outcome.disposition === "NO_RECONSTRUCTION_OR_INFERENCE"));
    }
    assert.ok(!JSON.stringify(outcomes).match(/operation request schema|wire schema/u));
  }
  for (const id of ["media.animation.2d", "media.animation.vector", "media.animation.3d"]) {
    const outcomes = rows.get(id).outputBranches[0].outcomes;
    assert.deepEqual(outcomes.map(({ when }) => when), [
      "outputOrigin=AUTHORED_CREATION; exactSourceArtifactVersionRef=ABSENT; resultKind=AUTHORED_CREATION; originRelation=SOURCE_FREE_GENERATION; epistemicDisposition=DEFINITION_NOT_MEDIA_CONTENT",
      "outputOrigin=SOURCE_DERIVED_TRANSFORMATION; exactSourceArtifactVersionRef=PRESENT_AND_USED; resultKind=SOURCE_DERIVED_TRANSFORMATION; originRelation=SOURCE_DERIVED; epistemicDisposition=SOURCE_DERIVED_TRANSFORMATION",
      "outputOrigin=GENERATED_OR_INFERRED; sourceLinkage=NOT_CLAIMED; resultKind=GENERATED_OR_INFERRED; originRelation=SOURCE_FREE_GENERATION; epistemicDisposition=ESTIMATED_OR_RECONSTRUCTED",
    ]);
    assert.match(rows.get(id).unknownPolicy, /UNKNOWN_OR_ABSTAINED/u);
  }
  const subtitle = rows.get("media.speech.transcription.subtitle.generate").outputBranches.find((branch) => branch.outputArtifactType === "subtitle-draft-version");
  assert.equal(subtitle.outcomes.length, 1, "the P0 combined transcript/recognition input type does not falsely distinguish source classes");
  assert.equal(subtitle.outcomes[0].disposition, "ESTIMATED_OR_INFERRED_OBSERVATION");
  assert.match(subtitle.outcomes[0].meaning, /does not distinguish those source classes/u);
  const phaseNoise = rows.get("media.master.audio.phase-noise-floor-analyze");
  assert.deepEqual(phaseNoise.outputArtifactTypes, ["phase-noise-floor-measurement-record"]);
  assert.equal(phaseNoise.outputBranches[0].outcomes[0].epistemicRole, "MEASUREMENT_RECORD_NOT_TRANSFORMED_MEDIA");
});

test("rights result variants select one exact active trust outcome", () => {
  const ids = ["media.rights.consent.reference", "media.rights.permitted-use.evaluate"];
  const expectedKinds = ["POLICY_DECISION_REFERENCE", "RIGHTS_OBSERVATION"];
  for (const id of ids) {
    const cap = capById.get(id);
    const row = policy.records.find((item) => item.capabilityRef === id);
    const variants = cap.ownerDefinition.successOutputs[0].resultVariants;
    assert.deepEqual(variants.map(({ resultKind }) => resultKind), expectedKinds);
    assert.ok(variants.every(({ disposition }) => disposition === "NO_RECONSTRUCTION_OR_INFERENCE"));
    assert.equal(cap.ownerDefinition.successOutputs.length, cap.outputArtifactTypes.length);
    const outcomes = row.outputBranches[0].outcomes;
    assert.equal(outcomes.length, variants.length);
    assert.deepEqual(outcomes.map(({ when }) => when), expectedKinds.map((kind) => `resultKind=${kind}`));
    assert.equal(new Set(outcomes.map(({ when }) => when)).size, outcomes.length);

    const missingVariant = structuredClone(variants);
    missingVariant.pop();
    assert.notDeepEqual(missingVariant.map(({ resultKind }) => resultKind), expectedKinds);
    const duplicateSelector = structuredClone(outcomes);
    duplicateSelector[1].when = duplicateSelector[0].when;
    assert.equal(new Set(duplicateSelector.map(({ when }) => when)).size, outcomes.length - 1);
  }
});

test("simulation pass variants are limited to the eleven output leaves", () => {
  const outputIds = ["rgb", "depth", "normals", "segmentation", "optical-flow", "motion-vectors", "object-ids", "contacts", "physical-events", "measurements", "timestamped-state"]
    .map((name) => `media.simulation.output.${name}`);
  const algorithmIds = ["rigid-body", "soft-body", "cloth", "rope", "particle", "fluid", "smoke", "fire", "collision", "constraint", "vehicle"]
    .map((name) => `media.simulation.${name}`);
  for (const id of outputIds) {
    const cap = capById.get(id);
    const row = policy.records.find((item) => item.capabilityRef === id);
    const [variant] = cap.ownerDefinition.successOutputs[0].resultVariants;
    const outcome = row.outputBranches[0].outcomes[0];
    assert.equal(variant.resultKind, "SIMULATION_PASS_OUTPUT");
    assert.equal(variant.originRelation, "SOURCE_DERIVED");
    assert.equal(variant.epistemicDisposition, "ESTIMATED_OR_INFERRED_OBSERVATION");
    assert.equal(variant.claimLimit.includes("exact evidence and qualified domain-owner authorization"), true);
    assert.equal(outcome.when, variant.selector);
    assert.equal(outcome.epistemicRole, "SIMULATION_PASS_ESTIMATE_NOT_GROUND_TRUTH");
    assert.match(outcome.meaning, /Measured or ground-truth claims require exact evidence and qualified domain-owner authorization/u);
  }
  for (const id of algorithmIds) {
    const cap = capById.get(id);
    const row = policy.records.find((item) => item.capabilityRef === id);
    assert.equal(Object.hasOwn(cap.ownerDefinition.successOutputs[0], "resultVariants"), false);
    assert.equal(row.outputBranches[0].outcomes[0].when, `outputArtifactType=${row.outputArtifactTypes[0]}`);
  }
});

test("P0 trust regression rejects foreign, mismatched, or incomplete semantic references", () => {
  const original = structuredClone(sources);
  assert.equal(valid(original), true);
  const wrongCapability = structuredClone(original);
  wrongCapability.review.ownerTrustReconstructionDispositions.records[0].capabilityRef = "media.foreign.capability";
  assert.equal(valid(wrongCapability), false);
  const wrongOutputType = structuredClone(original);
  wrongOutputType.review.ownerTrustReconstructionDispositions.records[0].outputBranches[0].outputArtifactType = "foreign-output-type";
  assert.equal(valid(wrongOutputType), false);
  const changedCurrentSource = structuredClone(original);
  changedCurrentSource.capabilities.capabilities.find((cap) => cap.id === "media.project.create")
    .ownerDefinition.typedInputSlots[0].sourceType = "unreviewed-input-change";
  assert.equal(valid(changedCurrentSource), false, "current source contract must remain joined to PXD-122 review");
  const changedHistoricalBranch = structuredClone(original);
  changedHistoricalBranch.review.ownerTrustReconstructionDispositions.records
    .find((row) => row.capabilityRef === "media.project.create").outputBranches[0].outcomes[0].meaning += " changed";
  assert.equal(valid(changedHistoricalBranch), false, "historical output-origin review fingerprint must remain immutable");
  const wrongSource = structuredClone(original);
  wrongSource.review.ownerTrustReconstructionDispositions.records[0].outputBranches[0].sourceArtifactTypeRef = ".product-experience/pdp-1-domain-data/operations.yaml#outputSchema";
  assert.equal(valid(wrongSource), false);
  const missingBranch = structuredClone(original);
  missingBranch.review.ownerTrustReconstructionDispositions.records[0].outputBranches.pop();
  assert.equal(valid(missingBranch), false);
  const duplicateAnimationBranch = structuredClone(original);
  const duplicateAnimation = duplicateAnimationBranch.review.ownerTrustReconstructionDispositions.records
    .find((row) => row.capabilityRef === "media.animation.2d");
  duplicateAnimation.outputBranches[0].outcomes[1].when = duplicateAnimation.outputBranches[0].outcomes[0].when;
  assert.equal(valid(duplicateAnimationBranch), false, "animation branch predicates must be unique");
});

test("PXD-122 spatial source outputs require the exact source-derived reconstruction selector", () => {
  assert.equal(valid(sources), true);
  const mutateAndReject = (mutate) => {
    const candidate = structuredClone(sources);
    mutate(candidate);
    assert.equal(valid(candidate), false);
  };
  const id = "media.generate.spatial.image-to-3d";
  const capability = (doc) => doc.capabilities.capabilities.find((item) => item.id === id);
  const trust = (doc) => doc.review.ownerTrustReconstructionDispositions.records.find((item) => item.capabilityRef === id);
  mutateAndReject((doc) => { delete capability(doc).ownerDefinition.successOutputs[0].originRelation; });
  mutateAndReject((doc) => { capability(doc).ownerDefinition.successOutputs[0].epistemicDisposition = "UNKNOWN"; });
  mutateAndReject((doc) => { trust(doc).outputBranches[0].when = `outputArtifactType=${trust(doc).outputArtifactTypes[0]}`; });
  mutateAndReject((doc) => { trust(doc).outputBranches[0].outcomes.push(structuredClone(trust(doc).outputBranches[0].outcomes[0])); });
  mutateAndReject((doc) => { trust(doc).outputBranches[0].outcomes[0].disposition = "ESTIMATED_OR_INFERRED_OBSERVATION"; });
  mutateAndReject((doc) => { capability(doc).ownerDefinition.typedInputSlots[1].required = false; });
  mutateAndReject((doc) => {
    capability(doc).provenance = capability(doc).provenance.filter((entry) => !entry.includes("exact artifact/version"));
  });
  mutateAndReject((doc) => { trust(doc).outputBranches[0].outcomes[0].meaning = "The result is recovered source truth and establishes ground truth."; });
});
