import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const parse = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml").parse;
const p1 = parse(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/operations.yaml"), "utf8"));
const byteLimit = 2_147_483_648;

function findById(value, id, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  if (!Array.isArray(value) && value.id === id) return value;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const match = findById(child, id, seen);
    if (match) return match;
  }
  return undefined;
}

const cases = [
  {
    wireSchemaId: "media.operation-wire-schema.begin-upload",
    wirePointer: ["properties", "expectedSizeBytes", "maximum"],
    boundId: "media.capability-bounds.media-artifact-upload",
  },
  {
    wireSchemaId: "media.operation-wire-schema.artifact-import-v1",
    wirePointer: ["properties", "source", "oneOf", 0, "properties", "expectedByteLength", "maximum"],
    boundId: "media.capability-bounds.media-artifact-import",
  },
  {
    wireSchemaId: "media.operation-wire-schema.artifact-derive-v1",
    wirePointer: ["properties", "output", "properties", "maximumBytes", "maximum"],
    boundId: "media.capability-bounds.media-artifact-derive",
  },
  {
    wireSchemaId: "media.operation-wire-schema.artifact-output-register-v1",
    wirePointer: ["properties", "byteLength", "maximum"],
    boundId: "media.capability-bounds.media-artifact-output-register",
  },
];

const sharedPayloadCases = [
  {
    schemaId: "media.typed-input.declared-content-metadata-and-purpose",
    pointer: ["properties", "payload", "properties", "declaredByteLength", "maximum"],
  },
  {
    schemaId: "media.typed-output.stable-uploadid-and-owner-acknowledged-transfer-state",
    pointer: ["properties", "payload", "properties", "value", "properties", "expectedByteLength", "maximum"],
  },
  {
    schemaId: "media.typed-output.same-uploadid-and-authoritative-transfer-state",
    pointer: ["properties", "payload", "properties", "value", "properties", "expectedByteLength", "maximum"],
  },
];

function atPath(value, path) {
  return path.reduce((current, key) => current?.[key], value);
}

test("artifact byte fields use the selected 2 GiB PDP-1 limit while request bodies stay 65,536 bytes", () => {
  for (const item of cases) {
    const wire = findById(p1, item.wireSchemaId);
    assert.ok(wire, `${item.wireSchemaId} exists`);
    assert.equal(atPath(wire.requestSchema, item.wirePointer), byteLimit, `${item.wireSchemaId} byte maximum`);

    const bounds = findById(p1.capabilityOperationContracts.bounds, item.boundId);
    assert.ok(bounds, `${item.boundId} exists`);
    assert.equal(bounds.maximumRequestBytes, 65_536, `${item.boundId} request-byte limit`);
    assert.equal(bounds.maximumInputArtifactBytes, byteLimit, `${item.boundId} input-artifact limit`);
    assert.equal(bounds.maximumOutputArtifactBytes, byteLimit, `${item.boundId} output-artifact limit`);
  }

  for (const item of sharedPayloadCases) {
    const schema = findById(p1, item.schemaId);
    assert.ok(schema, `${item.schemaId} exists`);
    assert.equal(atPath(schema.schema, item.pointer), byteLimit, `${item.schemaId} byte maximum`);
  }

  const genericJobSubmit = findById(p1, "media.operation-wire-schema.job-submit-v1");
  assert.ok(genericJobSubmit, "generic job-submit wire schema exists");
  const resourceBudget = genericJobSubmit.requestSchema.properties.resourceBudget.properties;
  assert.equal(resourceBudget.maximumInputBytes.maximum, 1_073_741_824);
  assert.equal(resourceBudget.maximumOutputBytes.maximum, 1_073_741_824);
});
