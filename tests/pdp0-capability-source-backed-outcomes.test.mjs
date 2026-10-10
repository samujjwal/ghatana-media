import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const source = parse(readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/capabilities.yaml"), "utf8"));
const leaves = new Map(source.capabilities.map((leaf) => [leaf.id, leaf]));
const review = parse(readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml"), "utf8"));
const leaf = (id) => {
  const found = leaves.get(id);
  assert.ok(found, `capability ${id} exists`);
  return found;
};

test("project creation requires a title without claiming initial project contents", () => {
  const create = leaf("media.project.create");
  assert.equal(create.ownerDefinition.semanticOutcomeContract.result, create.outcome);
  assert.ok(create.ownerDefinition.semanticOutcomeContract.sourceRefs.includes(
    ".product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.project.create/ownerDefinition/parameterSchema"));
  const schema = create.ownerDefinition.parameterSchema;
  assert.deepEqual(schema.required, ["title"]);
  assert.deepEqual(schema.properties.title, { type: "string", minLength: 1, maxLength: 200 });
  assert.deepEqual(create.ownerDefinition.typedInputSlots.map(({ sourceType }) => [sourceType]), [["user-intent"]]);
  assert.deepEqual(create.ownerDefinition.successOutputs, [{ artifactType: "versioned-project-state", requiredOnSuccess: true }]);
  assert.equal(create.ownerDefinition.effect.semanticOutcome.includes("initial contents"), false);
  assert.equal(create.ownerDefinition.effect.sourcePreservationRequired, false);
});

test("all project capability leaves have distinct source-backed intent results and safe unknown handling", () => {
  const projects = source.capabilities.filter(({ id }) => id.startsWith("media.project."));
  assert.equal(projects.length, 16);
  assert.equal(new Set(projects.map(({ outcome }) => outcome)).size, 16);
  for (const project of projects) {
    const contract = project.ownerDefinition.semanticOutcomeContract;
    assert.ok(contract, `${project.id} has a result contract`);
    assert.equal(contract.result, project.outcome);
    assert.equal(project.ownerDefinition.effect.semanticOutcome, project.outcome);
    assert.ok(contract.outputDistinctions.length >= 2, `${project.id} has material distinctions`);
    assert.match(contract.unknownDisposition, /unknown|unresolved|uncertain|unavailable/iu);
    assert.ok(contract.sourceRefs.some((ref) => ref.startsWith(
      `.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=${project.id}/`)));
    for (const requirementId of project.requirementIds) {
      assert.ok(contract.sourceRefs.includes(
        `.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=${requirementId}`));
    }
  }

  const meanings = new Map(projects.map(({ id, outcome }) => [id, outcome]));
  assert.match(meanings.get("media.project.collaborate"), /membership state/u);
  assert.match(meanings.get("media.project.review"), /review outcome/u);
  assert.match(meanings.get("media.project.review"), /exact immutable project version/u);
  assert.match(meanings.get("media.project.review"), /selected review scopes \(quality, rights, provenance, or approval\)/u);
  assert.match(meanings.get("media.project.source-asset.attach"), /source asset/u);
  assert.match(meanings.get("media.project.derived-asset.attach"), /derived asset/u);
  assert.notEqual(meanings.get("media.project.source-asset.attach"), meanings.get("media.project.derived-asset.attach"));
  assert.match(meanings.get("media.project.composition.update"), /composition/u);
  assert.match(meanings.get("media.project.settings.update"), /settings/u);
  assert.match(meanings.get("media.project.version"), /does not specify|not specified/u);
});

test("phase analysis allows a typed observation or measurement without asserting a noise-floor metric", () => {
  const phase = leaf("media.audio.analysis.analyze.phase");
  assert.deepEqual(phase.ownerDefinition.successOutputs, [{
    artifactType: "typed-audio-measurement-or-observation-with-method-and-limits",
    requiredOnSuccess: true,
  }]);
  assert.equal(phase.ownerDefinition.effect.effectIntentScope, "OBSERVATION_ONLY");
  assert.deepEqual(phase.ownerDefinition.parameterSchema.properties, {});
  assert.deepEqual(phase.ownerDefinition.parameterSchema.required, []);
  assert.match(phase.outcome, /typed observation or measurement record about phase properties/u);
  assert.match(phase.outcome, /does not assert a phase-noise-floor metric/u);
  assert.match(phase.ownerDefinition.semanticOutcomeContract.unknownDisposition, /UNKNOWN or ABSTAINED/u);

  // The P0 contract has no metric, unit, or analysis-window identity to justify
  // a numeric measurement. Preserve that as an unresolved result, never invent
  // a value from the record's name.
  const unsupportedMeasurementFields = ["metricRef", "unit", "analysisWindow", "measuredValue"];
  for (const field of unsupportedMeasurementFields) {
    assert.equal(Object.hasOwn(phase.ownerDefinition.parameterSchema.properties, field), false);
  }
  assert.equal(phase.ownerDefinition.effect.semanticOutcome, phase.outcome);
});

test("scientific demo separates visual plausibility from domain-validated results", () => {
  const demo = leaf("media.simulation.scientific-demo");
  assert.match(demo.outcome, /identify(?:ing)? the domain owner/u);
  assert.match(demo.outcome, /separat(?:e|ing) visual plausibility from validated results/u);
  assert.match(demo.constraints.join(" "), /visual plausibility is not simulation correctness/u);
  assert.match(demo.constraints.join(" "), /calibration, empirical validation.*qualified domain owner/u);
  assert.match(demo.ownerDefinition.effect.semanticOutcome, /visual plausibility.*validated results/u);
});

test("drift detection and correction returns alignment evidence with a source-derived local candidate", () => {
  const capability = leaf("media.sync.drift-detect-correct");
  assert.deepEqual(capability.outputArtifactTypes, ["alignment-map-and-derived-synchronized-artifact"]);
  assert.equal(capability.ownerDefinition.effect.effectIntentScope, "LOCAL_CANDIDATE_OR_DRAFT");
  assert.equal(capability.ownerDefinition.effect.sourcePreservationRequired, true);
  assert.match(capability.outcome, /alignment map/u);
  assert.match(capability.outcome, /local candidate synchronized artifact/u);
  assert.match(capability.outcome, /exact consumed source version/u);
  assert.match(capability.ownerDefinition.semanticOutcomeContract.unknownDisposition, /tolerance/u);
});

test("export creates a delivery package or explicit outcome; publish and acknowledgment remain separate", () => {
  const exportLeaf = leaf("media.deliver.export");
  const publish = leaf("media.deliver.publish-governed");
  const exportTypes = exportLeaf.ownerDefinition.successOutputs.map(({ artifactType }) => artifactType);
  assert.deepEqual(exportTypes, ["delivery-package-or-explicit-delivery-outcome"]);
  assert.deepEqual(exportLeaf.ownerDefinition.successOutputs[0].resultVariants.map(({ resultKind }) => resultKind), [
    "DELIVERY_PACKAGE",
    "EXPORT_OUTCOME",
  ]);
  assert.deepEqual(publish.ownerDefinition.successOutputs[0].resultVariants.map(({ resultKind }) => resultKind), [
    "DELIVERY_PACKAGE",
    "GOVERNED_PUBLICATION_OUTCOME",
  ]);
  assert.notDeepEqual(publish.ownerDefinition.successOutputs, exportLeaf.ownerDefinition.successOutputs);
  assert.equal(exportLeaf.ownerDefinition.successOutputs.some(({ artifactType }) => /publish|acknowledg/iu.test(artifactType)), false);
  assert.equal(exportLeaf.ownerDefinition.successOutputs.some(({ resultVariants = [] }) => resultVariants.some(({ resultKind, selector = "" }) =>
    /PUBLISH|ACKNOWLEDG/iu.test(`${resultKind} ${selector}`))), false);
  assert.match(exportLeaf.outcome, /EXPORT_OUTCOME/u);
  assert.match(publish.outcome, /GOVERNED_PUBLICATION_OUTCOME/u);
  assert.notEqual(exportLeaf.operation, publish.operation);
  // Both branches retain the broad output type, but their owner-reported outcomes
  // remain distinct and neither claims destination acknowledgment or access.
  assert.ok(exportLeaf.stateModelBindings.find(({ modelId }) => modelId === "media-delivery")
    .modeledStateSets.states.includes("ACKNOWLEDGED"), "delivery lifecycle can model acknowledgment without making it export success");
});

test("authorized speaker identification requires an exact versioned reference and current consent", () => {
  const id = "media.speech.transcription.speaker.identify-authorized";
  const capability = leaf(id);
  const reference = capability.ownerDefinition.typedInputSlots.find(({ sourceType }) => sourceType === "authorized-speaker-reference");
  assert.deepEqual(reference, { slotId: "input3", sourceType: "authorized-speaker-reference", cardinality: "EXACTLY_ONE", required: true });
  assert.ok(capability.inputArtifactTypes.includes("authorized-speaker-reference"));
  assert.ok(capability.ownerDefinition.guards.preconditions.some((value) => /versioned.*tenant-scoped.*purpose-specific consent/u.test(value)));
  assert.ok(capability.ownerDefinition.guards.authorityRefs.includes("speaker-reference-identification-purpose-and-consent-authorization"));
  assert.ok(capability.explicitUnsupportedCases.some((value) => /without an exact authorized speaker reference.*consent.*UNKNOWN/u.test(value)));
  assert.match(capability.ownerDefinition.semanticOutcomeContract.unknownDisposition, /No identity, match, authorization validity/u);

  const adjudication = review.ownerCapabilityLeafAdjudication.records.find(({ capabilityRef }) => capabilityRef === id);
  const trust = review.ownerTrustReconstructionDispositions.records.find(({ capabilityRef }) => capabilityRef === id);
  assert.ok(adjudication.inputArtifactTypes.includes("authorized-speaker-reference"));
  assert.ok(trust.inputArtifactTypes.includes("authorized-speaker-reference"));
  assert.match(trust.unknownPolicy, /foreign\/stale audio or speaker reference.*purpose-specific consent/u);
});
