import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const parse = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml").parse;
const read = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const p0 = read(".product-experience/pdp-0-product-truth/capabilities.yaml").capabilities;
const p1 = read(".product-experience/pdp-1-domain-data/operations.yaml").capabilityOperationContracts;

function requiredFields(schema) {
  return [...(schema?.required ?? [])].sort();
}

test("canonical P0/P1 input slots preserve requiredness and rights evidence payload requiredness", () => {
  const canonical = p1.records.filter(({ recordKind }) =>
    recordKind === "CANONICAL_OWNER_DEFINED_CAPABILITY_OPERATION");
  const operationsByCapability = new Map(canonical.map((operation) => [operation.capabilityRef, operation]));

  for (const capability of p0) {
    const operation = operationsByCapability.get(capability.id);
    if (!operation) continue;
    const p0SlotsById = new Map(capability.ownerDefinition.typedInputSlots.map((slot) => [slot.slotId, slot]));
    for (const target of operation.inputSlots) {
      const source = p0SlotsById.get(target.slotId);
      if (!source) continue;
      assert.equal(target.required, source.required, `${capability.id} ${target.slotId} requiredness matches P0`);
      assert.equal(operation.requestSchema.required.includes(target.slotId), target.required,
        `${capability.id} request schema ${target.slotId} requiredness matches its P1 slot`);
    }
  }

  const rightsOperation = operationsByCapability.get("media.rights.attestation.record");
  assert.ok(rightsOperation, "rights attestation has its canonical operation");
  const input2 = rightsOperation.requestSchema.properties.input2;
  const reusable = p1.inputPayloadSchemas.find(({ id }) => id === "media.typed-input.rights-evidence-reference");
  assert.ok(reusable, "rights evidence reusable input schema exists");
  assert.deepEqual(requiredFields(input2), requiredFields(reusable.schema), "input2 and reusable schema require the same envelope fields");
  assert.deepEqual(requiredFields(input2.properties.payload), requiredFields(reusable.schema.properties.payload),
    "inline input2 payload and reusable rights evidence payload require the same fields");
});
