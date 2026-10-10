import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const capabilitiesPath = ".product-experience/pdp-0-product-truth/capabilities.yaml";
const reviewPath = ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml";

test("source-free animation authoring does not claim a source-derived transformation", () => {
  const capabilities = readYaml(capabilitiesPath).capabilities;
  const trustRecords = readYaml(reviewPath).ownerTrustReconstructionDispositions.records;
  const byCapability = new Map(capabilities.map((record) => [record.id, record]));
  const byTrustCapability = new Map((trustRecords ?? []).map((record) => [record.capabilityRef, record]));

  for (const id of ["media.animation.2d", "media.animation.vector", "media.animation.3d"]) {
    const capability = byCapability.get(id);
    assert.ok(capability, `${id} exists`);
    assert.deepEqual(capability.inputArtifactTypes, ["animation-intent", "optional-rig-scene-or-media-references"]);
    const provenance = capability.provenance.join(" ");
    assert.match(provenance, /authored intent identity/u);
    assert.match(provenance, /optional references are dependencies/u);
    assert.match(provenance, /do not by themselves establish source-derived output/u);
    assert.match(provenance, /Preserve UNKNOWN source linkage/u);
    assert.doesNotMatch(provenance, /Source artifact\/version and rights decision reference\./u);
    const successOutputs = capability.ownerDefinition?.successOutputs ?? [];
    assert.equal(successOutputs.length, 1, `${id} retains one broad success output`);
    assert.equal(successOutputs[0].artifactType, "versioned-animation-scene-or-edit");
    assert.deepEqual(successOutputs[0].resultVariants, [
      {
        resultKind: "AUTHORED_CREATION",
        originRelation: "SOURCE_FREE_GENERATION",
        epistemicDisposition: "DEFINITION_NOT_MEDIA_CONTENT",
        disposition: "NO_RECONSTRUCTION_OR_INFERENCE",
        selector: "outputOrigin=AUTHORED_CREATION; exactSourceArtifactVersionRef=ABSENT; resultKind=AUTHORED_CREATION; originRelation=SOURCE_FREE_GENERATION; epistemicDisposition=DEFINITION_NOT_MEDIA_CONTENT",
      },
      {
        resultKind: "SOURCE_DERIVED_TRANSFORMATION",
        originRelation: "SOURCE_DERIVED",
        epistemicDisposition: "SOURCE_DERIVED_TRANSFORMATION",
        disposition: "SOURCE_DERIVED_TRANSFORMATION",
        selector: "outputOrigin=SOURCE_DERIVED_TRANSFORMATION; exactSourceArtifactVersionRef=PRESENT_AND_USED; resultKind=SOURCE_DERIVED_TRANSFORMATION; originRelation=SOURCE_DERIVED; epistemicDisposition=SOURCE_DERIVED_TRANSFORMATION",
      },
      {
        resultKind: "GENERATED_OR_INFERRED",
        originRelation: "SOURCE_FREE_GENERATION",
        epistemicDisposition: "ESTIMATED_OR_RECONSTRUCTED",
        disposition: "ESTIMATED_OR_RECONSTRUCTED",
        selector: "outputOrigin=GENERATED_OR_INFERRED; sourceLinkage=NOT_CLAIMED; resultKind=GENERATED_OR_INFERRED; originRelation=SOURCE_FREE_GENERATION; epistemicDisposition=ESTIMATED_OR_RECONSTRUCTED",
      },
    ], `${id} result variants preserve the exact source-backed trust selectors`);

    const trust = byTrustCapability.get(id);
    assert.ok(trust, `${id} has exact-output trust review`);
    assert.equal(trust.outputBranches.length, 1, `${id} has one semantic output branch`);
    const [sceneAndEdit] = trust.outputBranches;
    assert.equal(sceneAndEdit.outputArtifactType, "versioned-animation-scene-or-edit");
    assert.deepEqual(sceneAndEdit.outcomes.map(({ when }) => when), successOutputs[0].resultVariants.map(({ selector }) => selector));
    assert.deepEqual(sceneAndEdit.outcomes.map(({ disposition }) => disposition), [
      "NO_RECONSTRUCTION_OR_INFERENCE",
      "SOURCE_DERIVED_TRANSFORMATION",
      "ESTIMATED_OR_RECONSTRUCTED",
    ]);
    assert.match(sceneAndEdit.outcomes[0].meaning, /without using a source artifact version/u);
    assert.match(sceneAndEdit.outcomes[1].meaning, /exact source artifact\/version was actually used/u);
    assert.match(sceneAndEdit.outcomes[2].meaning, /generated\/inferred scene definition/u);
    assert.match(sceneAndEdit.outcomes[2].meaning, /does not establish source linkage/u);
    assert.match(trust.unknownPolicy, /UNKNOWN_OR_ABSTAINED/u);
    assert.match(trust.unknownPolicy, /missing typed provenance/u);
  }

  const timeline = byTrustCapability.get("media.compose.multitrack-timeline");
  assert.ok(timeline, "multitrack timeline has exact-output trust review");
  assert.equal(timeline.outputBranches[0].outputArtifactType, "versioned-composition-and-render-manifest");
  assert.equal(timeline.outputBranches[0].outcomes[0].disposition, "NO_RECONSTRUCTION_OR_INFERENCE");
  assert.match(timeline.outputBranches[0].outcomes[0].meaning, /not a rendered frame, clip/u);
});
