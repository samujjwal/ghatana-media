import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const sourcePath = ".product-experience/pdp-0-product-truth/capabilities.yaml";
const readCapabilities = () => parse(readFileSync(resolve(root, sourcePath), "utf8"));
const actorPath = ".product-experience/pdp-0-product-truth/actors-responsibilities.yaml";
const genericOutcome = "with explicit preconditions, effect, provenance, and recovery semantics";
const effectIntentScopes = new Set([
  "OBSERVATION_ONLY",
  "LOCAL_CANDIDATE_OR_DRAFT",
  "CANONICAL_PRODUCT_STATE_CHANGE",
  "GOVERNED_EXTERNAL_REQUEST",
]);
const exactEffectIntentScopes = new Map([
  ["media.project.search", "OBSERVATION_ONLY"],
  ["media.project.update", "CANONICAL_PRODUCT_STATE_CHANGE"],
  ["media.project.composition.update", "CANONICAL_PRODUCT_STATE_CHANGE"],
  ["media.artifact.derive", "CANONICAL_PRODUCT_STATE_CHANGE"],
  ["media.artifact.output.register", "CANONICAL_PRODUCT_STATE_CHANGE"],
  ["media.sync.drift-detect-correct", "LOCAL_CANDIDATE_OR_DRAFT"],
  ["media.artifact.retain", "CANONICAL_PRODUCT_STATE_CHANGE"],
  ["media.speech.transcription.file", "CANONICAL_PRODUCT_STATE_CHANGE"],
  ["media.vision.scene-text.observation.create", "CANONICAL_PRODUCT_STATE_CHANGE"],
  ["media.artifact.provenance.export", "GOVERNED_EXTERNAL_REQUEST"],
  ["media.artifact.share", "GOVERNED_EXTERNAL_REQUEST"],
  ["media.artifact.share.revoke", "GOVERNED_EXTERNAL_REQUEST"],
  ["media.artifact.delete", "GOVERNED_EXTERNAL_REQUEST"],
  ["media.deliver.publish-governed", "GOVERNED_EXTERNAL_REQUEST"],
  ["media.quality.repair-plan", "LOCAL_CANDIDATE_OR_DRAFT"],
  ["media.generate.image.reference", "LOCAL_CANDIDATE_OR_DRAFT"],
  ["media.generate.video.reference-video", "LOCAL_CANDIDATE_OR_DRAFT"],
  ["media.generate.spatial.generate.novel-view", "LOCAL_CANDIDATE_OR_DRAFT"],
  ["media.simulation.procedural-world", "LOCAL_CANDIDATE_OR_DRAFT"],
  ["media.simulation.output.timestamped-state", "LOCAL_CANDIDATE_OR_DRAFT"],
]);
function expectedSourcePreservation(leaf) {
  const requiredSource = leaf.ownerDefinition.typedInputSlots.some(({ sourceType, required }) => required
    && /(artifact|reference|recording|media|project|version|image|video|audio|spatial|speaker|voice)/iu.test(sourceType)
    && !/(intent|query|context|request|condition)/iu.test(sourceType));
  const outputs = leaf.outputArtifactTypes.join(" ");
  const sourceDerivedOutput = /(derived-|candidate-|versioned-animation|versioned-composition|versioned-edited|alignment-map-and-derived|source-grounded-cross-modal|transcript-draft)/iu.test(outputs)
    || ["media.artifact.derive", "media.artifact.output.register"].includes(leaf.id);
  return requiredSource && sourceDerivedOutput;
}
function validateJobSubmitIdempotencyExpiry(leaf) {
  const contract = leaf?.ownerDefinition?.idempotencyExpiryContract;
  if (leaf?.id !== "media.job.submit" || !contract
      || contract.productWideDuration !== "NOT_DEFINED_BY_P0"
      || !/expiry, deletion, or unavailability[\s\S]*never proves[\s\S]*no prior job or consequential effect[\s\S]*UNKNOWN_OUTCOME[\s\S]*same scoped idempotency identity/iu.test(contract.expiryRule ?? "")
      || !/does not authorize[\s\S]*new idempotency key[\s\S]*fresh semantic request[\s\S]*another consequential effect/iu.test(contract.freshIdentityRule ?? "")
      || !/artifact retention expiry is independent[\s\S]*idempotency and reconciliation evidence expiry/iu.test(contract.artifactRetentionRule ?? "")
      || !/PDP-1 defines the exact approved per-operation retention duration[\s\S]*No duration is selected here/iu.test(contract.pdp1Delegation ?? "")
      || !Array.isArray(contract.sourceRefs) || contract.sourceRefs.length !== 3
      || contract.sourceRefs.some((ref) => resolveSourceRef(ref) === undefined)) return false;
  return true;
}
const specificMeanings = new Map([
  ["media.artifact.derive", "The P0 meaning of a derivation result is bound to exact source-version references, transformation-profile identity, requested output/media type, purpose, and rights decision. Distinguish a queued-job observation from derived content and derived content from a registered artifact-version identity; exact source lineage is required and an identified profile is not an assumed default. Unknown source, authority, or result remains UNKNOWN. This P0 meaning does not establish dispatch, job creation, persistence, derived content, registration, or completion."],
  ["media.artifact.output.register", "The P0 meaning of output registration distinguishes the supplied candidate from an immutable Media artifact-version identity, an accepted registration result from rejected or unknown outcomes, and registration from project attachment, export, delivery, or publication. Candidate lineage, content digest, policy decision, and target project revision are identity constraints; a registered version is not inferred from the request. This P0 meaning does not establish mutation, registration, persistence, or finality."],
]);
const paginatedResultTypes = new Map([
  ["media.project.search", "bounded-project-search-result-page-and-opaque-continuation"],
  ["media.artifact.search", "bounded-governed-artifact-result-page-and-opaque-continuation"],
  ["media.artifact.list", "bounded-governed-artifact-result-page-and-opaque-continuation"],
  ["media.capability.discover", "bounded-declared-capability-compatibility-result-page-and-opaque-continuation"],
]);
const sourceInputByCapability = new Map([
  ["media.generate.image.image-to-image", "source-image-artifact"],
  ["media.generate.image.reference", "source-image-artifact"],
  ["media.generate.image.multi-reference", "multiple-authorized-image-references"],
  ["media.generate.image.sketch-to-image", "source-sketch-artifact"],
  ["media.generate.image.layout-to-image", "source-layout-artifact"],
  ["media.generate.image.condition.pose", "source-pose-reference"],
  ["media.generate.image.condition.depth", "source-depth-reference"],
  ["media.generate.image.condition.edge", "source-edge-reference"],
  ["media.generate.image.condition.segmentation", "source-segmentation-reference"],
  ["media.generate.image.control.reference", "source-image-reference"],
  ["media.generate.image.control.palette", "palette-control-intent"],
  ["media.generate.image.control.style", "style-control-intent"],
  ["media.generate.video.image-to-video", "source-image-artifact"],
  ["media.generate.video.video-to-video", "source-video-artifact"],
  ["media.generate.video.reference-video", "source-video-reference"],
  ["media.generate.video.drive.audio", "source-audio-artifact"],
  ["media.generate.video.drive.speech", "source-speech-artifact"],
  ["media.generate.audio.video-to-audio", "source-video-artifact"],
  ["media.generate.audio.foley", "source-video-or-scene-artifact"],
  ["media.generate.audio.audio-to-audio", "source-audio-artifact"],
  ["media.generate.audio.music.continue", "source-music-audio-artifact"],
  ["media.generate.audio.music.vary", "source-music-audio-artifact"],
  ["media.generate.audio.stem.generate", "source-audio-artifact"],
  ["media.generate.spatial.image-to-3d", "source-image-artifact"],
  ["media.generate.spatial.reconstruct.multiview", "multiple-authorized-image-views"],
  ["media.generate.spatial.reconstruct.depth", "source-depth-or-image-data"],
  ["media.generate.spatial.reconstruct.camera", "source-camera-or-multiview-data"],
  ["media.generate.spatial.generate.novel-view", "source-spatial-scene-representation"],
  ["media.generate.spatial.relight-3d", "source-spatial-scene-representation"],
  ["media.generate.spatial.compose-3d", "source-spatial-assets-and-scene"],
  ["media.generate.spatial.representation.nerf-adapter", "source-nerf-representation"],
  ["media.generate.spatial.representation.gaussian-splatting-adapter", "source-gaussian-splat-representation"],
  ["media.speech.synthesis.speaker.clone-authorized", "authorized-source-speaker-recording"],
  ["media.speech.synthesis.speaker.condition", "authorized-speaker-reference"],
  ["media.speech.synthesis.voice.convert", "source-speech-artifact"],
  ["media.speech.synthesis.speech-to-speech", "source-speech-artifact"],
  ["media.speech.synthesis.speech.translate", "source-speech-artifact"],
  ["media.speech.synthesis.dub", "source-media-with-speech-artifact"],
]);
const metricOutputByCapability = new Map([
  ["media.audio.analysis.segment.content-kind", "speech-music-nonspeech-segmentation-observation"],
  ["media.audio.analysis.measure.loudness", "audio-loudness-measurement-record"],
  ["media.audio.analysis.measure.peaks", "audio-peak-measurement-record"],
  ["media.audio.analysis.detect.clipping", "audio-clipping-detection-observation"],
  ["media.audio.analysis.measure.noise", "audio-noise-measurement-record"],
  ["media.audio.analysis.analyze.spectral", "audio-spectral-analysis-measurement-record"],
  ["media.audio.analysis.analyze.phase", "typed-audio-measurement-or-observation-with-method-and-limits"],
  ["media.audio.analysis.analyze.channels", "audio-channel-analysis-measurement-record"],
  ["media.audio.analysis.detect.beat-onset", "audio-beat-onset-detection-observation"],
  ["media.audio.analysis.detect.silence", "audio-silence-detection-observation"],
  ["media.audio.analysis.diagnose.source-separation", "audio-source-separation-diagnostic-record"],
  ["media.audio.analysis.assess.timing", "audio-timing-assessment-record"],
  ["media.audio.analysis.assess.intelligibility", "speech-intelligibility-assessment-record"],
]);

const sourceCache = new Map();
function resolveSourceRef(ref) {
  const [sourcePath, pointer = ""] = ref.split("#", 2);
  if (!sourcePath.startsWith(".product-experience/pdp-0-product-truth/")) return undefined;
  if (!sourceCache.has(sourcePath)) {
    sourceCache.set(sourcePath, parse(readFileSync(resolve(root, sourcePath), "utf8")));
  }
  let value = sourceCache.get(sourcePath);
  for (const raw of pointer.split("/").filter(Boolean)) {
    const token = raw.replace(/~1/gu, "/").replace(/~0/gu, "~");
    const byId = /^@id=(.+)$/u.exec(token);
    value = byId
      ? (Array.isArray(value) ? value.find((item) => item?.id === byId[1]) : undefined)
      : value?.[token];
  }
  return value;
}

function validateOutcomePopulation(catalog, actorCatalog) {
  const leaves = catalog?.capabilities;
  const rule = catalog?.ownerDefinedP0CapabilityOutcomeRule;
  if (!Array.isArray(leaves) || leaves.length !== 462 || new Set(leaves.map(({ id }) => id)).size !== 462) return false;
  if (rule?.id !== "media.capability-outcome.owner-defined-result.v1" || rule.count !== 462
      || !rule.resultRule?.includes("ownerDefinition.semanticOutcomeContract")
      || !rule.resultRule?.includes("sourceRefs identify the exact owner evidence")
      || !rule.resultRule?.includes("does not assert dispatch")
      || !rule.traceRule?.includes("must not supply unstated behavior")
      || !rule.effectBoundary?.includes("Concrete operation effects and finality remain downstream")
      || !rule.gapDisposition?.includes("record that exact leaf as a P0 semantic gap")) return false;

  for (const leaf of leaves) {
    const contract = leaf.ownerDefinition?.semanticOutcomeContract;
    if (!Array.isArray(leaf.actorRefs) || leaf.actorRefs.length === 0
        || !Array.isArray(leaf.ownerDefinition?.typedInputSlots) || leaf.ownerDefinition.typedInputSlots.length === 0
        || !Array.isArray(leaf.ownerDefinition?.successOutputs) || leaf.ownerDefinition.successOutputs.length === 0) return false;
    if (leaf.outcome.includes(genericOutcome) || leaf.ownerDefinition.effect?.semanticOutcome?.includes(genericOutcome)) return false;
    if (typeof leaf.outcome !== "string" || leaf.outcome.length < 40
        || leaf.outcome.startsWith("The P0 result for “")
        || /typed input slots \[|actor roles \[/u.test(leaf.outcome)
        || contract?.result !== leaf.outcome
        || leaf.ownerDefinition.effect?.semanticOutcome !== leaf.outcome
        || !Array.isArray(contract.outputDistinctions) || contract.outputDistinctions.length < 2
        || new Set(contract.outputDistinctions.map((value) => typeof value === "string"
          ? `text:${value}`
          : `branch:${value?.id}:${value?.when}`)).size !== contract.outputDistinctions.length
        || contract.outputDistinctions.some((value) => typeof value === "string"
          ? value.trim().length < 12
          : !value || typeof value.id !== "string" || value.id.trim().length < 3
            || typeof value.when !== "string" || value.when.trim().length < 12
            || typeof value.outputMeaning !== "string" || value.outputMeaning.trim().length < 12)
        || typeof contract.unknownDisposition !== "string"
        || !/(unknown|unresolved|unavailable|uncertain|not established|not specified|not[_ ]evaluated|not applicable|abstain|blocked)/iu.test(contract.unknownDisposition)
        || !Array.isArray(contract.sourceRefs) || contract.sourceRefs.length < 2
        || new Set(contract.sourceRefs).size !== contract.sourceRefs.length) return false;
    const capPointer = `.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=${leaf.id}`;
    if (!contract.sourceRefs.some((ref) => ref.startsWith(`${capPointer}/`))
        || contract.sourceRefs.some((ref) => resolveSourceRef(ref) === undefined)) return false;
    const trustRef = contract.sourceRefs.find((ref) => ref.includes("capability-leaf-review.yaml#ownerTrustReconstructionDispositions/records/@id="));
    if (!trustRef || resolveSourceRef(trustRef)?.capabilityRef !== leaf.id) return false;
    if (!Array.isArray(leaf.requirementIds) || leaf.requirementIds.length === 0
        || leaf.requirementIds.some((requirementId) => !contract.sourceRefs.includes(
          `.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=${requirementId}`))) return false;
    if (specificMeanings.has(leaf.id) && specificMeanings.get(leaf.id) !== leaf.outcome) return false;
    if (specificMeanings.has(leaf.id) && leaf.ownerDefinition.effect?.semanticOutcome !== leaf.outcome) return false;
    if (leaf.actorRefs.some((ref) => !actorCatalog?.actors?.some(({ id }) => id === ref))) return false;
    if (leaf.inputArtifactTypes.length === 0 || leaf.outputArtifactTypes.length === 0
        || leaf.outputArtifactTypes.length !== leaf.ownerDefinition.successOutputs.length
        || leaf.outputArtifactTypes.some((type) => !leaf.ownerDefinition.successOutputs.some((output) => output.artifactType === type))) return false;
    if (leaf.ownerDefinition.typedInputSlots.some(({ slotId, sourceType, cardinality, required }) =>
      !slotId || !sourceType || !cardinality || typeof required !== "boolean")) return false;
    if (leaf.provenance?.[0] === "Source artifact/version and rights decision reference.") return false;
    if (!effectIntentScopes.has(leaf.ownerDefinition.effect?.effectIntentScope)) return false;
    if (leaf.ownerDefinition.effect.sourcePreservationRequired !== expectedSourcePreservation(leaf)) return false;
    if (JSON.stringify(leaf.inputArtifactTypes) !== JSON.stringify(leaf.ownerDefinition.typedInputSlots.map(({ sourceType }) => sourceType))) return false;
    if (paginatedResultTypes.has(leaf.id)) {
      const expectedType = paginatedResultTypes.get(leaf.id);
      if (!Object.keys(leaf.ownerDefinition.parameterSchema.properties ?? {}).some((key) => /pageSize|pageToken/iu.test(key))
          || leaf.outputArtifactTypes.length !== 1 || leaf.outputArtifactTypes[0] !== expectedType
          || leaf.ownerDefinition.successOutputs.length !== 1
          || leaf.ownerDefinition.successOutputs[0].artifactType !== expectedType) return false;
    }
  }
  const byId = new Map(leaves.map((leaf) => [leaf.id, leaf]));
  if (!validateJobSubmitIdempotencyExpiry(byId.get("media.job.submit"))) return false;
  if (byId.get("media.project.create")?.ownerDefinition.typedInputSlots.some(({ sourceType }) => sourceType === "versioned-project")) return false;
  for (const [id, sourceType] of sourceInputByCapability) {
    const slot = byId.get(id)?.ownerDefinition.typedInputSlots.find(({ slotId }) => slotId === "input2");
    if (slot?.sourceType !== sourceType || slot.required !== true) return false;
  }
  for (const [id, outputType] of metricOutputByCapability) {
    if (byId.get(id)?.outputArtifactTypes?.length !== 1 || byId.get(id).outputArtifactTypes[0] !== outputType) return false;
  }
  if (byId.get("media.rights.attestation.record")?.outputArtifactTypes?.[0] !== "asserted-rights-attestation-record") return false;
  if (byId.get("media.artifact.share")?.outputArtifactTypes?.[0] !== "artifact-sharing-grant-observation"
      || byId.get("media.artifact.share.revoke")?.outputArtifactTypes?.[0] !== "artifact-sharing-revocation-observation-confirmed-or-unknown"
      || byId.get("media.artifact.delete")?.outputArtifactTypes?.[0] !== "artifact-lifecycle-observation-access-revoked-hold-pending-erasure-confirmed-or-external-unknown") return false;
  if (byId.get("media.artifact.share")?.ownerDefinition.typedInputSlots[1]?.sourceType !== "recipient-and-sharing-scope"
      || byId.get("media.artifact.delete")?.ownerDefinition.typedInputSlots[0]?.sourceType !== "governed-artifact-reference") return false;
  if (catalog.ownerDefinedP0EffectIntentRule?.id !== "media.capability-effect-intent.owner-scope.v1"
      || !catalog.ownerDefinedP0EffectIntentRule.rule.includes("not evidence of dispatch")) return false;
  for (const [id, scope] of exactEffectIntentScopes) {
    if (byId.get(id)?.ownerDefinition.effect.effectIntentScope !== scope) return false;
  }
  return new Set(leaves.map(({ outcome }) => outcome)).size === 462
    && [...specificMeanings.keys()].every((id) => leaves.some((leaf) => leaf.id === id));
}

test("P0 capability outcomes state exact result meaning without operation claims", () => {
  const catalog = readCapabilities();
  const actors = parse(readFileSync(resolve(root, actorPath), "utf8"));
  assert.equal(validateOutcomePopulation(catalog, actors), true);
  assert.equal(new Set(catalog.capabilities.map(({ outcome }) => outcome)).size, 462);
  assert.equal(catalog.capabilities.filter(({ outcome }) => outcome.includes(genericOutcome)).length, 0);
  assert.equal(catalog.capabilities.filter(({ ownerDefinition }) =>
    ownerDefinition.effect.semanticOutcome.includes(genericOutcome)).length, 0);
});

test("rights success outputs retain their broad types and define explicit semantic result variants", () => {
  const { capabilities } = readCapabilities();
  for (const id of ["media.rights.consent.reference", "media.rights.permitted-use.evaluate"]) {
    const capability = capabilities.find((item) => item.id === id);
    const [output] = capability.ownerDefinition.successOutputs;
    assert.equal(capability.outputArtifactTypes.length, capability.ownerDefinition.successOutputs.length);
    assert.equal(output.artifactType, capability.outputArtifactTypes[0]);
    assert.deepEqual(output.resultVariants.map(({ resultKind }) => resultKind), ["POLICY_DECISION_REFERENCE", "RIGHTS_OBSERVATION"]);
    assert.ok(output.resultVariants.every(({ disposition }) => disposition === "NO_RECONSTRUCTION_OR_INFERENCE"));
  }
});

test("P0 outcome validation rejects generic, incomplete, or operation-specific result claims", () => {
  const base = readCapabilities();
  const actors = parse(readFileSync(resolve(root, actorPath), "utf8"));
  const rejectMutation = (mutate) => {
    const candidate = structuredClone(base);
    mutate(candidate.capabilities[0]);
    assert.equal(validateOutcomePopulation(candidate, actors), false);
  };
  rejectMutation((leaf) => { leaf.outcome = genericOutcome; });
  rejectMutation((leaf) => { leaf.outcome = ""; });
  rejectMutation((leaf) => { leaf.outcome = leaf.label; });
  rejectMutation((leaf) => { leaf.ownerDefinition.semanticOutcomeContract.outputDistinctions = []; });
  rejectMutation((leaf) => { leaf.ownerDefinition.semanticOutcomeContract.unknownDisposition = ""; });
  rejectMutation((leaf) => { leaf.ownerDefinition.semanticOutcomeContract.sourceRefs = []; });
  rejectMutation((leaf) => { leaf.ownerDefinition.semanticOutcomeContract.result = "A different result."; });
  rejectMutation((leaf) => { leaf.ownerDefinition.effect.semanticOutcome = "The operation commits and finalizes the project."; });
  const stalePageOutput = structuredClone(base);
  const search = stalePageOutput.capabilities.find(({ id }) => id === "media.project.search");
  search.outputArtifactTypes = ["versioned-project-state"];
  search.ownerDefinition.successOutputs[0].artifactType = "versioned-project-state";
  assert.equal(validateOutcomePopulation(stalePageOutput, actors), false);
});

test("P0 job submit expiry semantics reject unsafe replay and artifact-retention conflation", () => {
  const base = readCapabilities();
  const submit = base.capabilities.find(({ id }) => id === "media.job.submit");
  assert.equal(validateJobSubmitIdempotencyExpiry(submit), true);
  for (const mutate of [
    (contract) => { contract.expiryRule = "Expiry proves no prior job exists."; },
    (contract) => { contract.expiryRule = "Expiry is unknown; reconcile the identity."; },
    (contract) => { contract.freshIdentityRule = "A new key may create a fresh semantic request."; },
    (contract) => { contract.artifactRetentionRule = "Artifact retention expiry releases idempotency evidence."; },
    (contract) => { contract.pdp1Delegation = "P0 selects a 30 day duration."; },
    (contract) => { contract.productWideDuration = "30 days"; },
    (contract) => { contract.sourceRefs = []; },
  ]) {
    const candidate = structuredClone(submit);
    mutate(candidate.ownerDefinition.idempotencyExpiryContract);
    assert.equal(validateJobSubmitIdempotencyExpiry(candidate), false);
  }
});

test("P0 source-derived branches, artifact lifecycle, rights assertions, and metric results retain distinct meanings", () => {
  const catalog = readCapabilities();
  const leaves = new Map(catalog.capabilities.map((leaf) => [leaf.id, leaf]));
  for (const [id, sourceType] of sourceInputByCapability) {
    const slot = leaves.get(id)?.ownerDefinition?.typedInputSlots?.find(({ slotId }) => slotId === "input2");
    assert.equal(slot?.sourceType, sourceType, `${id} must require its source class`);
    assert.equal(slot?.required, true, `${id} must not treat its source as optional`);
  }
  assert.deepEqual(leaves.get("media.project.create").ownerDefinition.typedInputSlots.map(({ sourceType }) => sourceType), ["user-intent"]);
  assert.deepEqual(leaves.get("media.generate.image.text-to-image").ownerDefinition.typedInputSlots.map(({ sourceType }) => sourceType), ["text-or-visual-intent", "optional-authorized-reference-artifacts"]);
  assert.deepEqual(leaves.get("media.speech.synthesis.text-to-speech").ownerDefinition.typedInputSlots.map(({ sourceType }) => sourceType), ["text-or-speech-intent", "optional-authorized-speaker-reference"]);

  for (const [id, outputType] of metricOutputByCapability) {
    assert.deepEqual(leaves.get(id).outputArtifactTypes, [outputType]);
  }
  assert.deepEqual(leaves.get("media.rights.attestation.record").outputArtifactTypes, ["asserted-rights-attestation-record"]);
  assert.notDeepEqual(leaves.get("media.rights.attestation.record").outputArtifactTypes, leaves.get("media.rights.permitted-use.evaluate").outputArtifactTypes);
  assert.deepEqual(leaves.get("media.artifact.share").ownerDefinition.typedInputSlots.map(({ sourceType }) => sourceType), ["governed-artifact-reference", "recipient-and-sharing-scope", "rights-and-retention-context"]);
  assert.deepEqual(leaves.get("media.artifact.share").outputArtifactTypes, ["artifact-sharing-grant-observation"]);
  assert.deepEqual(leaves.get("media.artifact.share.revoke").outputArtifactTypes, ["artifact-sharing-revocation-observation-confirmed-or-unknown"]);
  assert.deepEqual(leaves.get("media.artifact.delete").outputArtifactTypes, ["artifact-lifecycle-observation-access-revoked-hold-pending-erasure-confirmed-or-external-unknown"]);
  assert.deepEqual(leaves.get("media.speech.synthesis.speaker.clone-authorized").outputArtifactTypes, ["derived-authorized-speaker-voice-profile-record"]);
  assert.deepEqual(leaves.get("media.speech.synthesis.dub").outputArtifactTypes, ["candidate-dubbed-media-artifact-with-speech-sync-provenance"]);
  assert.deepEqual(catalog.ownerDefinedP0ArtifactLifecycleOutcomeContract.states, ["ACCESS_REVOKED", "BLOCKED_BY_HOLD", "ERASURE_REQUESTED", "PHYSICAL_ERASURE_PENDING", "ERASURE_CONFIRMED", "EXTERNAL_ERASURE_UNCONFIRMED"]);
  assert.match(catalog.ownerDefinedP0ArtifactLifecycleOutcomeContract.rule, /not physical erasure/u);
  assert.match(catalog.ownerDefinedP0AudioMeasurementContract.rule, /UNKNOWN/u);
  assert.ok(catalog.capabilities.every(({ ownerDefinition }) => effectIntentScopes.has(ownerDefinition.effect.effectIntentScope)));
  assert.equal(leaves.get("media.project.search").ownerDefinition.effect.effectIntentScope, "OBSERVATION_ONLY");
  assert.equal(leaves.get("media.project.update").ownerDefinition.effect.effectIntentScope, "CANONICAL_PRODUCT_STATE_CHANGE");
  assert.equal(leaves.get("media.generate.image.text-to-image").ownerDefinition.effect.effectIntentScope, "LOCAL_CANDIDATE_OR_DRAFT");
  assert.equal(leaves.get("media.artifact.share").ownerDefinition.effect.effectIntentScope, "GOVERNED_EXTERNAL_REQUEST");
  for (const [id, scope] of exactEffectIntentScopes) assert.equal(leaves.get(id).ownerDefinition.effect.effectIntentScope, scope, id);
  assert.ok(catalog.capabilities.every((leaf) => JSON.stringify(leaf.inputArtifactTypes)
    === JSON.stringify(leaf.ownerDefinition.typedInputSlots.map(({ sourceType }) => sourceType))));

  const sourceFree = ["media.generate.image.text-to-image", "media.speech.synthesis.text-to-speech", "media.health.readiness.inspect"];
  for (const id of sourceFree) {
    const leaf = leaves.get(id);
    assert.match(leaf.provenance[0], /conditional/u);
    assert.equal(leaf.ownerDefinition.effect.sourcePreservationRequired, false);
  }
  assert.equal(leaves.get("media.generate.audio.audio-to-audio").ownerDefinition.effect.sourcePreservationRequired, true);
  assert.equal(catalog.ownerDefinedP0SourcePreservationRule?.id, "media.capability-source-preservation.owner-rule.v1");
  assert.match(catalog.ownerDefinedP0SourcePreservationRule.rule, /Source-free authoring/u);
  assert.ok(catalog.capabilities.every(({ provenance, constraints }) =>
    !provenance.includes("Source artifact/version and rights decision reference.")
      && !constraints.includes("Preserve source and report reconstruction or estimation distinctly from measured/ground-truth output.")));
});

test("P0 semantic cohort checks reject source-free creation, decision substitution, and generic metric output", () => {
  const base = readCapabilities();
  const sourceFree = structuredClone(base);
  const textToImage = sourceFree.capabilities.find(({ id }) => id === "media.generate.image.text-to-image");
  textToImage.ownerDefinition.typedInputSlots[1].required = true;
  assert.equal(validateOutcomePopulation(sourceFree, parse(readFileSync(resolve(root, actorPath), "utf8"))), false);

  const createNeedsNoExistingProject = structuredClone(base);
  const create = createNeedsNoExistingProject.capabilities.find(({ id }) => id === "media.project.create");
  create.ownerDefinition.typedInputSlots.push({ slotId: "input2", sourceType: "versioned-project", cardinality: "EXACTLY_ONE", required: true });
  create.inputArtifactTypes.push("versioned-project");
  assert.equal(validateOutcomePopulation(createNeedsNoExistingProject, parse(readFileSync(resolve(root, actorPath), "utf8"))), false);

  const decisionSubstitution = structuredClone(base);
  const attestation = decisionSubstitution.capabilities.find(({ id }) => id === "media.rights.attestation.record");
  attestation.outputArtifactTypes = ["policy-decision-reference-or-rights-observation"];
  attestation.ownerDefinition.successOutputs[0].artifactType = "policy-decision-reference-or-rights-observation";
  assert.equal(validateOutcomePopulation(decisionSubstitution, parse(readFileSync(resolve(root, actorPath), "utf8"))), false);

  const phaseNoiseFloorClaim = structuredClone(base);
  const phase = phaseNoiseFloorClaim.capabilities.find(({ id }) => id === "media.audio.analysis.analyze.phase");
  phase.outputArtifactTypes = ["phase-noise-floor-measurement-record"];
  phase.ownerDefinition.successOutputs[0].artifactType = phase.outputArtifactTypes[0];
  assert.equal(validateOutcomePopulation(phaseNoiseFloorClaim, parse(readFileSync(resolve(root, actorPath), "utf8"))), false);

  const wrongEffectBoundary = structuredClone(base);
  wrongEffectBoundary.capabilities.find(({ id }) => id === "media.artifact.output.register").ownerDefinition.effect.effectIntentScope = "OBSERVATION_ONLY";
  assert.equal(validateOutcomePopulation(wrongEffectBoundary, parse(readFileSync(resolve(root, actorPath), "utf8"))), false);
});
