import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const Ajv = require("ajv").default;
const source = parse(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/operations.yaml"), "utf8"));
const compositionKinds = new Map([
  ["media.compose.multitrack-timeline", "COMPOSITION_DEFINITION"],
  ["media.compose.scene-storyboard-assemble", "COMPOSITION_DEFINITION"],
  ["media.compose.track.video-audio-caption-overlay", "COMPOSITION_DEFINITION"],
  ["media.compose.transition", "COMPOSITION_DEFINITION"],
  ["media.compose.titles-credits-lower-thirds", "COMPOSITION_DEFINITION"],
  ["media.compose.exact-typography-logo-brand", "COMPOSITION_DEFINITION"],
  ["media.compose.safe-area", "COMPOSITION_DEFINITION"],
  ["media.compose.reusable-composition", "COMPOSITION_DEFINITION"],
  ["media.compose.render-manifest", "RENDER_MANIFEST"],
]);
const records = source.capabilityOperationContracts.records;
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });

test("the nine composition commands discriminate immutable definitions from render manifests", () => {
  const shared = source.capabilityOperationContracts.outputPayloadSchemas
    .find((record) => record.id === "media.typed-output.versioned-composition-and-render-manifest");
  assert.deepEqual(shared.schema.properties.payload.required, ["artifactId", "versionId", "resultKind"]);
  assert.deepEqual(shared.schema.properties.payload.properties.resultKind.enum, ["COMPOSITION_DEFINITION", "RENDER_MANIFEST"]);
  assert.match(shared.ownerDefinition, /Neither result kind claims encoded or rendered media bytes/u);
  const validateOutput = ajv.compile(shared.schema);

  assert.equal(compositionKinds.size, 9);
  for (const [capabilityRef, expectedKind] of compositionKinds) {
    const record = records.find((item) => item.capabilityRef === capabilityRef);
    assert.ok(record, `${capabilityRef} has an exact canonical owner operation`);
    assert.equal(record.successOutputs.length, 1);
    assert.equal(record.successOutputs[0].resultKind, expectedKind);
    assert.equal(record.successOutputs[0].payloadSchemaRef, shared.id);
    const itemSchema = record.resultSchema.properties.outputs.items.oneOf[0];
    const validateItem = ajv.compile(itemSchema);
    const valid = {
      artifactType: shared.artifactType,
      payload: {
        artifactId: "artifact-1",
        versionId: "version-1",
        resultKind: expectedKind,
      },
    };
    assert.equal(validateOutput(valid), true, `${capabilityRef} emits a closed typed value`);
    assert.equal(validateItem(valid), true, `${capabilityRef} accepts its selected result kind`);
    const wrongKind = structuredClone(valid);
    wrongKind.payload.resultKind = expectedKind === "RENDER_MANIFEST" ? "COMPOSITION_DEFINITION" : "RENDER_MANIFEST";
    assert.equal(validateItem(wrongKind), false, `${capabilityRef} rejects the other result kind`);
    assert.equal(itemSchema.properties.payload.properties.resultKind.const, expectedKind);
    assert.equal(itemSchema.properties.payload.additionalProperties, false);
    assert.equal(Object.hasOwn(itemSchema.properties.payload.properties, "renderedMediaRef"), false,
      `${capabilityRef} cannot claim a produced-media reference through this result schema`);
    assert.equal(record.admission.executionAdmission, "NOT_ADMITTED");
  }
});
