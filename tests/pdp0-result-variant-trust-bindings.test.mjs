import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const parse = require("yaml").parse;
const read = (name) => parse(readFileSync(resolve(root, `.product-experience/pdp-0-product-truth/${name}.yaml`), "utf8"));
const capabilities = read("capabilities").capabilities;
const trust = read("capability-leaf-review").ownerTrustReconstructionDispositions.records;
const capById = new Map(capabilities.map((row) => [row.id, row]));
const trustById = new Map(trust.map((row) => [row.capabilityRef, row]));

const rights = [
  "media.rights.consent.reference",
  "media.rights.permitted-use.evaluate",
];
const spatial = [
  ["media.generate.spatial.text-to-3d", "SPATIAL_3D_ASSET_WITH_COORDINATE_AND_FIDELITY_METADATA"],
  ["media.generate.spatial.asset.create-3d", "SPATIAL_3D_ASSET_WITH_COORDINATE_AND_FIDELITY_METADATA"],
  ["media.generate.spatial.create.360-media", "SPATIAL_360_MEDIA_PASS_WITH_PROJECTION_AND_FIDELITY_METADATA"],
  ["media.generate.spatial.create.spatial-audio", "SPATIAL_AUDIO_MEDIA_PASS_WITH_COORDINATE_AND_FIDELITY_METADATA"],
];
const simulation = [
  "rgb", "depth", "normals", "segmentation", "optical-flow", "motion-vectors",
  "object-ids", "contacts", "physical-events", "measurements", "timestamped-state",
].map((pass) => `media.simulation.output.${pass}`);
const editing = [
  "inpaint", "outpaint", "object-remove", "object-replace", "background-remove", "background-replace",
  "matte", "relight", "recolor", "colorize", "style-transfer", "retime-slow-motion-speed-ramp",
  "smart-crop-auto-reframe", "shot-color-match", "region-correction", "face-correction", "hand-correction",
  "propagate-keyframe-mask-effect",
].map((operation) => `media.edit.${operation}`);
const quality = ["inspect", "compare", "diagnose", "rank", "recommend", "repair-plan", "bounded-optimize"]
  .map((operation) => `media.quality.${operation}`);
const delivery = [
  "media.deliver.encode", "media.deliver.transcode", "media.deliver.master", "media.deliver.package",
  "media.deliver.stream", "media.deliver.download", "media.deliver.export", "media.deliver.publish-governed",
  "media.deliver.renditions.aspect-ratio", "media.deliver.renditions.resolution",
  "media.deliver.renditions.adaptive-bitrate", "media.deliver.profile.web", "media.deliver.profile.social",
  "media.deliver.profile.podcast", "media.deliver.profile.broadcast", "media.deliver.profile.cinematic",
  "media.deliver.profile.archival", "media.deliver.profile.interactive", "media.deliver.profile.named",
  "media.deliver.subtitles", "media.deliver.transcripts", "media.deliver.thumbnails", "media.deliver.posters",
  "media.deliver.interactive-scene-bundle", "media.deliver.provenance-manifest",
  "media.deliver.compatibility-fallback",
];

const expectedIds = new Set([...rights, ...spatial.map(([id]) => id), ...simulation, ...editing, ...quality, ...delivery]);
const expectedResultKinds = new Map();
for (const id of rights) expectedResultKinds.set(id, ["POLICY_DECISION_REFERENCE", "RIGHTS_OBSERVATION"]);
for (const [id, resultKind] of spatial) expectedResultKinds.set(id, [resultKind]);
for (const id of simulation) expectedResultKinds.set(id, ["SIMULATION_PASS_OUTPUT"]);
for (const id of editing) expectedResultKinds.set(id, ["EDITED_ARTIFACT", "PROJECT_CHANGE"]);
for (const id of quality) expectedResultKinds.set(id, ["QUALITY_OBSERVATION", "BOUNDED_REPAIR_PLAN"]);
for (const id of delivery) expectedResultKinds.set(id, ["DELIVERY_PACKAGE", "EXPLICIT_DELIVERY_OUTCOME"]);
expectedResultKinds.set("media.deliver.export", ["DELIVERY_PACKAGE", "EXPORT_OUTCOME"]);
expectedResultKinds.set("media.deliver.publish-governed", ["DELIVERY_PACKAGE", "GOVERNED_PUBLICATION_OUTCOME"]);

const expectedDisposition = (id, resultKind) => {
  if (rights.includes(id) || resultKind === "PROJECT_CHANGE" || resultKind === "BOUNDED_REPAIR_PLAN"
      || ["EXPLICIT_DELIVERY_OUTCOME", "EXPORT_OUTCOME", "GOVERNED_PUBLICATION_OUTCOME"].includes(resultKind)) {
    return "NO_RECONSTRUCTION_OR_INFERENCE";
  }
  if (simulation.includes(id) || resultKind === "QUALITY_OBSERVATION") return "ESTIMATED_OR_INFERRED_OBSERVATION";
  if (resultKind === "DELIVERY_PACKAGE") return "SOURCE_DERIVED_TRANSFORMATION";
  if (resultKind === "EDITED_ARTIFACT") return null; // Existing leaf meaning distinguishes reconstruction from source transformation.
  if (spatial.some(([spatialId]) => spatialId === id)) return "ESTIMATED_OR_RECONSTRUCTED";
  return null;
};

function parseSelector(selector) {
  return Object.fromEntries(selector.split(";").map((part) => {
    const [key, ...value] = part.trim().split("=");
    return [key, value.join("=")];
  }));
}

function validateVariantBindings(capRows, trustRows) {
  const caps = new Map(capRows.map((row) => [row.id, row]));
  const trustRowsById = new Map(trustRows.map((row) => [row.capabilityRef, row]));
  if (expectedIds.size !== 68 || [...expectedIds].some((id) => !caps.has(id))) return false;
  for (const id of expectedIds) {
    const cap = caps.get(id);
    const trustRow = trustRowsById.get(id);
    const outputs = cap?.ownerDefinition?.successOutputs;
    const variants = outputs?.flatMap((output) => output.resultVariants ?? []);
    const branches = trustRow?.outputBranches;
    if (!Array.isArray(outputs) || outputs.length !== cap.outputArtifactTypes?.length || !variants?.length) return false;
    if (outputs.some((output, index) => output.artifactType !== cap.outputArtifactTypes[index])) return false;
    if (!Array.isArray(branches) || branches.length !== outputs.length) return false;

    const selectors = variants.map((variant) => variant.selector);
    if (selectors.some((selector) => typeof selector !== "string" || !selector.trim()) || new Set(selectors).size !== selectors.length) return false;
    const selectedKinds = variants.map((variant) => variant.resultKind);
    if ([...new Set(selectedKinds)].sort().join("|") !== [...expectedResultKinds.get(id)].sort().join("|")) return false;
    if (variants.some((variant) => !variant.resultKind || !variant.selector.startsWith(`resultKind=${variant.resultKind}`))) return false;

    for (const [index, branch] of branches.entries()) {
      if (branch.outputArtifactType !== outputs[index].artifactType || branch.outcomes?.length !== outputs[index].resultVariants.length) return false;
      const branchSelectors = branch.outcomes.map((outcome) => outcome.when);
      if (new Set(branchSelectors).size !== branchSelectors.length || selectors.some((selector) => !branchSelectors.includes(selector))) return false;
      for (const variant of outputs[index].resultVariants) {
        const outcome = branch.outcomes.find((candidate) => candidate.when === variant.selector);
        const selector = parseSelector(variant.selector);
        if (!outcome || outcome.disposition !== variant.disposition) return false;
        if (selector.resultKind !== variant.resultKind) return false;
        const expected = expectedDisposition(id, variant.resultKind);
        if (expected && variant.disposition !== expected) return false;
        if (simulation.includes(id)) {
          if (selector.originRelation !== "SOURCE_DERIVED" || selector.epistemicDisposition !== "ESTIMATED_OR_INFERRED_OBSERVATION") return false;
        }
        if (spatial.some(([spatialId]) => spatialId === id)) {
          if (!["SOURCE_FREE_GENERATION", "SOURCE_DERIVED"].includes(selector.originRelation)
            || selector.epistemicDisposition !== "ESTIMATED_OR_RECONSTRUCTED") return false;
        }
        if (id.startsWith("media.edit.") && variant.resultKind === "EDITED_ARTIFACT"
          && !["ESTIMATED_OR_RECONSTRUCTED", "SOURCE_DERIVED_TRANSFORMATION"].includes(variant.disposition)) return false;
      }
      if (spatial.some(([spatialId]) => spatialId === id)) {
        const origins = outputs[index].resultVariants.map((variant) => parseSelector(variant.selector).originRelation);
        if (new Set(origins).size !== 2 || !origins.includes("SOURCE_FREE_GENERATION") || !origins.includes("SOURCE_DERIVED")) return false;
      }
    }
  }
  return true;
}

test("PXD-128 result variants cover every audited leaf and bind to one exact trust outcome", () => {
  assert.equal(expectedIds.size, 68);
  assert.equal(validateVariantBindings(capabilities, trust), true);
});

test("PXD-128 rejects missing, duplicate, mismatched, and unsafe result selectors", () => {
  const mutateAndReject = (mutate) => {
    const caps = structuredClone(capabilities);
    const trustRows = structuredClone(trust);
    mutate(caps, trustRows);
    assert.equal(validateVariantBindings(caps, trustRows), false);
  };
  mutateAndReject((caps) => {
    const leaf = caps.find((row) => row.id === "media.rights.consent.reference");
    leaf.ownerDefinition.successOutputs[0].resultVariants.pop();
  });
  mutateAndReject((caps) => {
    const leaf = caps.find((row) => row.id === "media.quality.inspect");
    leaf.ownerDefinition.successOutputs[0].resultVariants[1].selector = leaf.ownerDefinition.successOutputs[0].resultVariants[0].selector;
  });
  mutateAndReject((caps) => {
    const leaf = caps.find((row) => row.id === "media.generate.spatial.text-to-3d");
    leaf.ownerDefinition.successOutputs[0].resultVariants[0].selector = "resultKind=FOREIGN_RESULT; originRelation=SOURCE_FREE_GENERATION; epistemicDisposition=ESTIMATED_OR_RECONSTRUCTED";
  });
  mutateAndReject((caps) => {
    const leaf = caps.find((row) => row.id === "media.simulation.output.depth");
    leaf.ownerDefinition.successOutputs[0].resultVariants[0].selector = "resultKind=SIMULATION_PASS_OUTPUT; originRelation=SOURCE_FREE_GENERATION; epistemicDisposition=ESTIMATED_OR_INFERRED_OBSERVATION";
  });
  mutateAndReject((caps, trustRows) => {
    const leaf = caps.find((row) => row.id === "media.deliver.encode");
    leaf.ownerDefinition.successOutputs[0].resultVariants[0].disposition = "NO_RECONSTRUCTION_OR_INFERENCE";
    trustRows.find((row) => row.capabilityRef === "media.deliver.encode").outputBranches[0].outcomes[0].disposition = "NO_RECONSTRUCTION_OR_INFERENCE";
  });
  mutateAndReject((caps, trustRows) => {
    const row = trustRows.find((item) => item.capabilityRef === "media.rights.permitted-use.evaluate");
    row.outputBranches[0].outcomes[1].when = row.outputBranches[0].outcomes[0].when;
  });
});

test("PXD-128 keeps the original capability output artifact population stable", () => {
  for (const id of expectedIds) {
    const cap = capById.get(id);
    assert.deepEqual(cap.ownerDefinition.successOutputs.map((output) => output.artifactType), cap.outputArtifactTypes, id);
  }
});
