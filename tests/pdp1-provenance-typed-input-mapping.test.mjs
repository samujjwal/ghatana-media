import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const parse = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml").parse;
const read = (path) => parse(readFileSync(resolve(root, path), "utf8"));
function requiredLeafPointers(schema, prefix = "") {
  if (!schema || typeof schema !== "object") return [];
  const result = [];
  const propertyFor = (node, key) => {
    if (!node || typeof node !== "object") return undefined;
    if (node.properties?.[key]) return node.properties[key];
    for (const branch of [...(node.allOf ?? []), ...(node.oneOf ?? []), ...(node.anyOf ?? []), node.then, node.else]) {
      const property = propertyFor(branch, key);
      if (property) return property;
    }
    return undefined;
  };
  for (const key of schema.required ?? []) {
    const pointer = `${prefix}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
    const property = propertyFor(schema, key);
    if (property && (property.type === "object" || property.properties || property.allOf || property.oneOf || property.anyOf)
      && (property.required?.length || property.allOf?.length || property.oneOf?.length || property.anyOf?.length)) {
      result.push(...requiredLeafPointers(property, pointer));
    } else result.push(pointer);
  }
  for (const key of ["allOf", "oneOf", "anyOf"]) {
    for (const branch of schema[key] ?? []) result.push(...requiredLeafPointers(branch, prefix));
  }
  for (const branch of [schema.then, schema.else]) if (branch) result.push(...requiredLeafPointers(branch, prefix));
  return [...new Set(result)];
}
const CAP_PATH = ".product-experience/pdp-0-product-truth/capabilities.yaml";
const OPS_PATH = ".product-experience/pdp-1-domain-data/operations.yaml";
const capabilityRef = "media.provenance.source-lineage.inspect";
const operationRef = "media.operation-slice.inspect-provenance";

test("source-lineage input mapping preserves the exact artifact-version or execution-reference union", () => {
  const capabilities = read(CAP_PATH);
  const operations = read(OPS_PATH);
  const capability = capabilities.capabilities.find(({ id }) => id === capabilityRef);
  const binding = operations.capabilityOperationContracts.records.find(({ capabilityRef: id }) => id === capabilityRef);
  const sourceOperation = operations.ownerDefinedOperationContracts.records.find(({ id }) => id === operationRef);
  const mapping = binding.typedInputMappings;

  assert.deepEqual(capability.ownerDefinition.typedInputSlots.map(({ slotId, sourceType, cardinality, required, alternatives }) =>
    ({ slotId, sourceType, cardinality, required, alternatives })), [{
    slotId: "input1",
    sourceType: "artifact-or-execution-reference",
    cardinality: "EXACTLY_ONE_OF_DECLARED_ALTERNATIVES",
    required: true,
    alternatives: ["artifact", "execution-reference"],
  }]);
  assert.equal(mapping.sourceCapabilityRef, `${CAP_PATH}#capabilities/@id=${capabilityRef}`);
  assert.equal(mapping.selectedAction.actionRef, "media.action.inspect-provenance");
  assert.deepEqual(mapping.entries.map(({ source, cardinality, mappingMode, valueOrigin, targets }) => ({
    source: [source.kind, source.slotId, source.sourceRef], cardinality, mappingMode, valueOrigin,
    targets: targets.map(({ operationRef: targetOperation, step, requestPointer, required, branch }) =>
      [targetOperation, step, requestPointer, required, branch ?? null]),
  })), [{
    source: ["P0_SLOT", "input1", `${CAP_PATH}#capabilities/@id=${capabilityRef}/ownerDefinition/typedInputSlots/@slotId=input1`],
    cardinality: "EXACTLY_ONE_OF_DECLARED_ALTERNATIVES",
    mappingMode: "EXPLICIT_PROJECTION",
    valueOrigin: "P0_DERIVED",
    targets: [
      [operationRef, 1, "/subject/artifactType", true, null],
      [operationRef, 1, "/subject/payload/kind", true, null],
      [operationRef, 1, "/subject/payload/artifactId", true, "artifact"],
      [operationRef, 1, "/subject/payload/versionId", true, "artifact"],
      [operationRef, 1, "/subject/payload/reference", true, "execution-reference"],
    ],
  }]);

  const subject = sourceOperation.ownerWireSchema.requestSchema.properties.subject;
  assert.deepEqual(mapping.entries.flatMap(({ targets }) => targets.map(({ requestPointer }) => requestPointer)).sort(),
    requiredLeafPointers(sourceOperation.ownerWireSchema.requestSchema).sort());
  assert.deepEqual(subject.required, ["artifactType", "payload"]);
  assert.equal(subject.properties.artifactType.const, "artifact-or-execution-reference");
  const alternatives = subject.properties.payload.oneOf;
  assert.deepEqual(alternatives.map(({ properties }) => properties.kind.const), ["artifact", "execution-reference"]);
  assert.deepEqual(alternatives.map(({ required }) => required), [["kind", "artifactId", "versionId"], ["kind", "reference"]]);
  assert.equal(alternatives[0].properties.versionId.format, "opaque-version-id");
  assert.equal(alternatives[1].properties.reference.format, "opaque-versioned-reference");
  assert.equal(mapping.coverage.status, "COMPLETE");
  assert.equal(mapping.coverage.unresolved, 0);
  assert.deepEqual(mapping.coverage.branchRequiredFields, { artifact: 2, "execution-reference": 1 });
  assert.deepEqual(mapping.coverage.branchMappedFromP0, { artifact: 2, "execution-reference": 1 });

  const mappedFields = (kind) => mapping.entries.flatMap(({ targets }) => targets
    .filter(({ branch }) => !branch || branch === kind)
    .map(({ requestPointer }) => requestPointer)).sort();
  assert.deepEqual(mappedFields("artifact"), [
    "/subject/artifactType", "/subject/payload/artifactId", "/subject/payload/kind", "/subject/payload/versionId",
  ].sort());
  assert.deepEqual(mappedFields("execution-reference"), [
    "/subject/artifactType", "/subject/payload/kind", "/subject/payload/reference",
  ].sort());
  assert.ok(!mappedFields("execution-reference").includes("/subject/payload/artifactId"));
  assert.ok(!mappedFields("execution-reference").includes("/subject/payload/versionId"));
  assert.ok(!mappedFields("artifact").includes("/subject/payload/reference"));
});
