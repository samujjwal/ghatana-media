import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { validateLeafTrustReconstructionSources } from "../scripts/lib/pdp-leaf-trust-reconstruction-validation.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const parse = require("yaml").parse;
const sourceFiles = {
  capabilities: ".product-experience/pdp-0-product-truth/capabilities.yaml",
  review: ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml",
  operations: ".product-experience/pdp-1-domain-data/operations.yaml",
  requirements: ".product-experience/pdp-0-product-truth/requirements.yaml",
};
const sources = Object.fromEntries(Object.entries(sourceFiles).map(([key, file]) => [key, parse(readFileSync(resolve(root, file), "utf8"))]));
const dispositions = sources.review.ownerTrustReconstructionDispositions;
const byCapability = new Map(dispositions.records.map((row) => [row.capabilityRef, row]));

test("trust and reconstruction definition resolves every exact typed capability leaf and output branch", () => {
  const result = validateLeafTrustReconstructionSources(sources);
  assert.deepEqual(result, { valid: true, capabilityCount: 462, recordCount: 462, issues: [] });
  assert.equal(dispositions.population.recordCount, 462);
  assert.equal(new Set(dispositions.records.map((row) => row.id)).size, 462);
  assert.equal(new Set(dispositions.records.map((row) => row.capabilityRef)).size, 462);
  for (const row of dispositions.records) for (const branch of row.outputBranches) for (const outcome of branch.outcomes) {
    if (outcome.disposition === "NO_RECONSTRUCTION_OR_INFERENCE") assert.ok(outcome.epistemicRole, row.capabilityRef);
    if (outcome.when === "$.outputs[*].payload.kind=bounded-repair-plan") {
      assert.equal(outcome.epistemicRole, "CALLER_PLAN_NOT_STATE");
      assert.match(outcome.meaning, /not a state observation and not an applied effect/u);
    }
  }
  const deterministicConversions = new Set([
    "media.enhance.image.white-balance", "media.enhance.image.exposure",
    "media.enhance.image.gamut-conversion", "media.enhance.image.tone-conversion",
    "media.enhance.audio.sample-rate-conversion",
  ]);
  for (const id of deterministicConversions) {
    const row = byCapability.get(id);
    assert.ok(row, id);
    assert.ok(row.outputBranches.flatMap((branch) => branch.outcomes).some((outcome) => outcome.disposition === "SOURCE_DERIVED_TRANSFORMATION"), id);
  }
  const semanticTimeline = byCapability.get("media.animation.output.accessibility.semantic-timeline");
  assert.ok(semanticTimeline.outputBranches.flatMap((branch) => branch.outcomes).some((outcome) => outcome.epistemicRole === "DEFINITION_NOT_MEDIA_CONTENT"));
  const motionCapture = byCapability.get("media.animation.motion-capture.extract");
  assert.ok(motionCapture.outputBranches.flatMap((branch) => branch.outcomes).some((outcome) => outcome.disposition === "ESTIMATED_OR_INFERRED_OBSERVATION" && /pose estimate is not ground truth/u.test(outcome.meaning)));
  const speakerFace = byCapability.get("media.sync.speaker-face-associate");
  assert.ok(speakerFace.outputBranches.flatMap((branch) => branch.outcomes).some((outcome) => outcome.disposition === "ESTIMATED_OR_INFERRED_OBSERVATION" && /association is not an identity fact/u.test(outcome.meaning)));
  const intentAuthoredAnimationDefinitions = [
    "media.animation.2d", "media.animation.vector", "media.animation.3d", "media.animation.keyframe",
    "media.animation.interpolation-easing", "media.animation.procedural", "media.animation.path",
    "media.animation.skeletal", "media.animation.inverse-kinematics", "media.animation.constraint",
    "media.animation.morph-target", "media.animation.camera", "media.animation.material", "media.animation.light",
    "media.animation.particle", "media.animation.drive.physics", "media.animation.drive.audio",
    "media.animation.drive.speech", "media.animation.drive.pose", "media.animation.facial-expression",
    "media.animation.gaze", "media.animation.lip", "media.animation.motion.retarget", "media.animation.character",
  ];
  for (const id of intentAuthoredAnimationDefinitions) {
    const row = byCapability.get(id);
    assert.ok(row, id);
    const operationRef = row.sourceRefs.find((ref) => ref.startsWith(".product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/records/"));
    const operationId = operationRef?.split("@id=").at(-1);
    const operation = sources.operations.capabilityOperationContracts.records.find((candidate) => candidate.id === operationId);
    assert.ok(row.exactTypedInputs.includes("optional-rig-scene-or-media-references"), `${id}: capability source declares optional references`);
    assert.ok(!operation.requestSchema.required.includes("input2"), `${id}: source-free intent is permitted by the operation request`);
    const outcomes = row.outputBranches.flatMap((branch) => branch.outcomes);
    assert.equal(outcomes.length, 2, `${id}: both exact output alternatives need a disposition`);
    for (const outcome of outcomes) {
      assert.equal(outcome.disposition, "NO_RECONSTRUCTION_OR_INFERENCE", `${id}:${outcome.when}`);
      assert.equal(outcome.epistemicRole, "DEFINITION_NOT_MEDIA_CONTENT", `${id}:${outcome.when}`);
      assert.match(outcome.meaning, /request schema permits source-free intent because input2 is optional/u, `${id}:${outcome.when}`);
      assert.match(outcome.meaning, /do not prove that the output preserves, derives from, or recovers referenced media/u, `${id}:${outcome.when}`);
      assert.match(outcome.meaning, /exact source artifact\/version to an output result/u, `${id}:${outcome.when}`);
    }
  }
  const composeIds = ["media.compose.multitrack-timeline", "media.compose.scene-storyboard-assemble", "media.compose.track.video-audio-caption-overlay", "media.compose.transition", "media.compose.titles-credits-lower-thirds", "media.compose.exact-typography-logo-brand", "media.compose.safe-area", "media.compose.reusable-composition", "media.compose.render-manifest"];
  for (const id of composeIds) {
    const branch = byCapability.get(id).outputBranches[0];
    const outcome = branch.outcomes[0];
    const resultKind = id === "media.compose.render-manifest" ? "RENDER_MANIFEST" : "COMPOSITION_DEFINITION";
    assert.equal(branch.expectedResultKind, resultKind, id);
    assert.equal(outcome.when, `$.outputs[*].payload.resultKind=${resultKind}`, id);
    assert.equal(outcome.disposition, "NO_RECONSTRUCTION_OR_INFERENCE", id);
    assert.equal(outcome.epistemicRole, "DEFINITION_NOT_MEDIA_CONTENT", id);
    assert.match(outcome.meaning, /Actual rendering and produced media require a separate admitted execution/u, id);
    assert.match(branch.exactOperationResultKindRef, /\/successOutputs\/0\/resultKind$/u, id);
    assert.match(branch.operationResultSchemaKindRef, /\/resultSchema\/properties\/outputs\/items\/oneOf\/0\/properties\/payload\/properties\/resultKind\/const$/u, id);
  }
  const subtitles = byCapability.get("media.speech.transcription.subtitle.generate").outputBranches[0];
  assert.equal(subtitles.requestSelector, "$.input1.payload.kind");
  assert.deepEqual(subtitles.outcomes.map((outcome) => outcome.requestWhen), [
    "$.input1.payload.kind=exact-transcript", "$.input1.payload.kind=recognition-result-version",
  ]);
  const liveCaption = byCapability.get("media.stream.caption.live");
  assert.ok(liveCaption, "live-caption capability has an explicit trust disposition");
  for (const outcome of liveCaption.outputBranches.flatMap((branch) => branch.outcomes)) {
    assert.equal(outcome.disposition, "NO_RECONSTRUCTION_OR_INFERENCE");
    assert.match(outcome.meaning, /reports only an ordered stream-session observation or a terminal session-state reference/u);
    assert.match(outcome.meaning, /contains no live-caption text, transcript segments, subtitle cues, or derived caption artifact/u);
    assert.match(outcome.meaning, /does not establish that caption content was produced or delivered/u);
  }
  const phaseNoise = byCapability.get("media.master.audio.phase-noise-floor-analyze");
  assert.deepEqual(phaseNoise.exactTypedOutputs, ["phase-noise-floor-measurement-record"]);
  const phaseNoiseBranch = phaseNoise.outputBranches[0];
  assert.equal(phaseNoiseBranch.outputArtifactType, "phase-noise-floor-measurement-record");
  assert.equal(phaseNoiseBranch.sourceSchemaRef, ".product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/outputPayloadSchemas/@id=media.typed-output.phase-noise-floor-measurement.v1");
  assert.equal(phaseNoiseBranch.outcomes[0].disposition, "NO_RECONSTRUCTION_OR_INFERENCE");
  assert.equal(phaseNoiseBranch.outcomes[0].epistemicRole, "MEASUREMENT_RECORD_NOT_TRANSFORMED_MEDIA");
  assert.match(phaseNoiseBranch.outcomes[0].meaning, /metric, method and method version, measured value and unit, observation time, and evidence references/u);
});

test("reconstruction and fidelity-sensitive outputs cannot be mislabeled as source-preserving truth", () => {
  const reconstructedPrefixes = [
    "media.generate.image.", "media.generate.video.", "media.generate.audio.", "media.generate.spatial.",
    "media.speech.synthesis.", "media.enhance.image.", "media.enhance.video.", "media.enhance.audio.",
  ];
  const reconstructedExact = new Set([
    "media.speech.transcription.file", "media.edit.inpaint", "media.edit.outpaint", "media.edit.object-remove",
    "media.edit.object-replace", "media.edit.background-remove", "media.edit.background-replace", "media.edit.relight",
    "media.edit.recolor", "media.edit.colorize", "media.edit.style-transfer", "media.edit.region-correction",
    "media.edit.face-correction", "media.edit.hand-correction", "media.sync.lip-synchronize", "media.sync.phoneme-viseme-align",
  ]);
  const selected = dispositions.records.filter((row) => reconstructedExact.has(row.capabilityRef)
    || reconstructedPrefixes.some((prefix) => row.capabilityRef.startsWith(prefix)));
  assert.ok(selected.length >= 120);
  for (const row of selected) {
    const branches = row.outputBranches.flatMap((branch) => branch.outcomes);
    const contentOutcomes = branches.filter((outcome) => outcome.disposition !== "NO_RECONSTRUCTION_OR_INFERENCE");
    assert.ok(contentOutcomes.length > 0, row.capabilityRef);
    assert.ok(contentOutcomes.every((outcome) => outcome.disposition === "SOURCE_DERIVED_TRANSFORMATION"
      || outcome.disposition === "ESTIMATED_OR_RECONSTRUCTED"
      || outcome.disposition === "ESTIMATED_OR_INFERRED_OBSERVATION"), row.capabilityRef);
    assert.ok(contentOutcomes.every((outcome) => outcome.disposition === "SOURCE_DERIVED_TRANSFORMATION"
      ? /does not establish that the original capture was correct/u.test(outcome.meaning) && /perceptual meaning is unchanged/u.test(outcome.meaning)
      : outcome.disposition === "ESTIMATED_OR_RECONSTRUCTED"
      ? /not recovered source truth/u.test(outcome.meaning)
      : /never present a label or estimate as ground truth/u.test(outcome.meaning)), row.capabilityRef);
  }

  const sourceDerived = dispositions.records.flatMap((row) => row.outputBranches.flatMap((branch) => branch.outcomes
    .filter((outcome) => outcome.disposition === "SOURCE_DERIVED_TRANSFORMATION")));
  assert.ok(sourceDerived.length > 50, "the full leaf population retains explicit source-derived branches where defined");
  assert.ok(sourceDerived.every((outcome) => /not a claim of lossless preservation/u.test(outcome.meaning)
    || (/does not establish that the original capture was correct/u.test(outcome.meaning)
      && /perceptual meaning is unchanged/u.test(outcome.meaning))
    || (/not a verified transcript/u.test(outcome.meaning)
      && /does not prove source speech truth/u.test(outcome.meaning))));
});

test("valid sibling references, incomplete branch coverage, and invented output classes fail closed", () => {
  const original = structuredClone(sources);
  const first = original.review.ownerTrustReconstructionDispositions.records[0];
  const other = original.review.ownerTrustReconstructionDispositions.records[1];

  const wrongOperation = structuredClone(original);
  wrongOperation.review.ownerTrustReconstructionDispositions.records[0].sourceRefs = first.sourceRefs.map((ref) => ref.startsWith(".product-experience/pdp-1-domain-data/operations.yaml#")
    ? other.sourceRefs.find((candidate) => candidate.startsWith(".product-experience/pdp-1-domain-data/operations.yaml#")) : ref);
  assert.equal(validateLeafTrustReconstructionSources(wrongOperation).valid, false, "a valid operation from another capability is not equivalent");

  const wrongBranchSchema = structuredClone(original);
  const firstType = first.outputBranches[0].outputArtifactType;
  const otherSchemaRef = original.review.ownerTrustReconstructionDispositions.records
    .flatMap((row) => row.outputBranches)
    .find((branch) => branch.outputArtifactType !== firstType).sourceSchemaRef;
  wrongBranchSchema.review.ownerTrustReconstructionDispositions.records[0].outputBranches[0].sourceSchemaRef = otherSchemaRef;
  assert.equal(validateLeafTrustReconstructionSources(wrongBranchSchema).valid, false, "another leaf's valid output schema does not satisfy this leaf");

  const exactTypedSource = original.operations.capabilityOperationContracts.outputPayloadSchemas;
  const selectedOutputSchemaId = first.outputBranches[0].sourceSchemaRef.split("@id=").at(-1);
  const selectedOutputSchema = exactTypedSource.find((schema) => schema.id === selectedOutputSchemaId);
  assert.ok(selectedOutputSchema, "fixture resolves the currently selected output schema");
  const sameArtifactSibling = structuredClone(selectedOutputSchema);
  sameArtifactSibling.id = `${selectedOutputSchema.id}.same-artifact-sibling`;
  exactTypedSource.push(sameArtifactSibling);
  const substitutedSibling = structuredClone(original);
  substitutedSibling.operations.capabilityOperationContracts.outputPayloadSchemas.push(sameArtifactSibling);
  substitutedSibling.review.ownerTrustReconstructionDispositions.records[0].outputBranches[0].sourceSchemaRef = `.product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/outputPayloadSchemas/@id=${sameArtifactSibling.id}`;
  assert.equal(validateLeafTrustReconstructionSources(substitutedSibling).valid, false, "a structurally valid same-artifact sibling schema must not replace this capability's exact selected schema");

  const missingBranch = structuredClone(original);
  missingBranch.review.ownerTrustReconstructionDispositions.records[0].outputBranches.pop();
  assert.equal(validateLeafTrustReconstructionSources(missingBranch).valid, false);

  const inventedOutcome = structuredClone(original);
  inventedOutcome.review.ownerTrustReconstructionDispositions.records[0].outputBranches[0].outcomes[0].disposition = "SOURCE_PRESERVING_TRANSFORMATION";
  assert.equal(validateLeafTrustReconstructionSources(inventedOutcome).valid, false, "an unowned or semantically misleading disposition is rejected");

  const missingUnknown = structuredClone(original);
  missingUnknown.review.ownerTrustReconstructionDispositions.records[0].outputBranches[0].missingOrUnknown = "assume success";
  assert.equal(validateLeafTrustReconstructionSources(missingUnknown).valid, false);

  const plan = original.review.ownerTrustReconstructionDispositions.records.flatMap((row) => row.outputBranches.flatMap((branch) => branch.outcomes))
    .find((outcome) => outcome.when === "$.outputs[*].payload.kind=bounded-repair-plan");
  assert.ok(plan);
  const planWithoutRole = structuredClone(original);
  const removedPlan = planWithoutRole.review.ownerTrustReconstructionDispositions.records.flatMap((row) => row.outputBranches.flatMap((branch) => branch.outcomes))
    .find((outcome) => outcome.when === "$.outputs[*].payload.kind=bounded-repair-plan");
  delete removedPlan.epistemicRole;
  assert.equal(validateLeafTrustReconstructionSources(planWithoutRole).valid, false, "a plan cannot be relabeled as an observed state");

  const missingRequestBranch = structuredClone(original);
  const subtitle = missingRequestBranch.review.ownerTrustReconstructionDispositions.records.find((row) => row.capabilityRef === "media.speech.transcription.subtitle.generate").outputBranches[0];
  subtitle.outcomes.pop();
  assert.equal(validateLeafTrustReconstructionSources(missingRequestBranch).valid, false, "both exact-transcript and recognition-result request branches need dispositions");

  const invalidRequestCondition = structuredClone(original);
  const invalidSubtitle = invalidRequestCondition.review.ownerTrustReconstructionDispositions.records.find((row) => row.capabilityRef === "media.speech.transcription.subtitle.generate").outputBranches[0];
  invalidSubtitle.outcomes[1].requestWhen = "$.input1.payload.kind=unregistered-kind";
  assert.equal(validateLeafTrustReconstructionSources(invalidRequestCondition).valid, false, "invented request discriminator cannot establish an output meaning");

  const animationAsMediaTransform = structuredClone(original);
  const animationOutcome = animationAsMediaTransform.review.ownerTrustReconstructionDispositions.records
    .find((row) => row.capabilityRef === "media.animation.2d").outputBranches[0].outcomes[0];
  animationOutcome.disposition = "SOURCE_DERIVED_TRANSFORMATION";
  delete animationOutcome.epistemicRole;
  animationOutcome.meaning = "The scene definition is a source-preserving rendered media transformation.";
  assert.equal(validateLeafTrustReconstructionSources(animationAsMediaTransform).valid, false, "animation definition references do not establish source-derived rendered media");

  const animationSourceFreeRequestBroken = structuredClone(original);
  const animationOperation = animationSourceFreeRequestBroken.operations.capabilityOperationContracts.records
    .find((row) => row.id === "media.operation.capability.media-animation-2d");
  animationOperation.requestSchema.required.push("input2");
  assert.equal(validateLeafTrustReconstructionSources(animationSourceFreeRequestBroken).valid, false, "an optional source reference cannot become required while claiming source-free creation");

  const motionCaptureAsGroundTruth = structuredClone(original);
  const motionOutcome = motionCaptureAsGroundTruth.review.ownerTrustReconstructionDispositions.records
    .find((row) => row.capabilityRef === "media.animation.motion-capture.extract").outputBranches[0].outcomes[0];
  motionOutcome.disposition = "SOURCE_DERIVED_TRANSFORMATION";
  motionOutcome.meaning = "This extracted pose is ground truth.";
  assert.equal(validateLeafTrustReconstructionSources(motionCaptureAsGroundTruth).valid, false, "motion capture remains an estimate rather than ground truth");

  const liveCaptionAsContent = structuredClone(original);
  const liveCaptionOutcome = liveCaptionAsContent.review.ownerTrustReconstructionDispositions.records
    .find((row) => row.capabilityRef === "media.stream.caption.live").outputBranches[0].outcomes[0];
  liveCaptionOutcome.meaning = "The stream operation produces live-caption text and subtitle cues as content.";
  assert.equal(validateLeafTrustReconstructionSources(liveCaptionAsContent).valid, false, "session observations cannot be relabeled as caption content production");

  const phaseNoiseAsMasteredAudio = structuredClone(original);
  const phaseNoiseOutcome = phaseNoiseAsMasteredAudio.review.ownerTrustReconstructionDispositions.records
    .find((row) => row.capabilityRef === "media.master.audio.phase-noise-floor-analyze").outputBranches[0].outcomes[0];
  phaseNoiseOutcome.disposition = "SOURCE_DERIVED_TRANSFORMATION";
  phaseNoiseOutcome.epistemicRole = "OWNER_STATE_OR_REFERENCE";
  phaseNoiseOutcome.meaning = "The measurement record transforms and masters the source audio.";
  assert.equal(validateLeafTrustReconstructionSources(phaseNoiseAsMasteredAudio).valid, false, "a measurement record cannot be mislabeled as transformed or mastered audio");

  for (const id of ["media.compose.multitrack-timeline", "media.compose.scene-storyboard-assemble", "media.compose.track.video-audio-caption-overlay", "media.compose.transition", "media.compose.titles-credits-lower-thirds", "media.compose.exact-typography-logo-brand", "media.compose.safe-area", "media.compose.reusable-composition", "media.compose.render-manifest"]) {
    const composition = structuredClone(original);
    const branch = composition.review.ownerTrustReconstructionDispositions.records.find((row) => row.capabilityRef === id).outputBranches[0];
    branch.expectedResultKind = id === "media.compose.render-manifest" ? "COMPOSITION_DEFINITION" : "RENDER_MANIFEST";
    assert.equal(validateLeafTrustReconstructionSources(composition).valid, false, `${id}: a sibling result kind cannot be substituted`);

    const falseMediaClaim = structuredClone(original);
    const outcome = falseMediaClaim.review.ownerTrustReconstructionDispositions.records.find((row) => row.capabilityRef === id).outputBranches[0].outcomes[0];
    outcome.epistemicRole = "OWNER_STATE_OR_REFERENCE";
    outcome.meaning = "This result is produced rendered media content.";
    assert.equal(validateLeafTrustReconstructionSources(falseMediaClaim).valid, false, `${id}: a definition or render manifest cannot be represented as rendered media`);
  }
});
