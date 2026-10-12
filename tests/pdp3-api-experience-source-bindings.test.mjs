import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const parse = createRequire(new URL("../../ghatana-tools/package.json", import.meta.url))("yaml").parse;
const p1 = ".product-experience/pdp-1-domain-data";
const p3 = ".product-experience/pdp-3-product-experience";
const [mapping, actionRegistry, ownerWire, operations] = await Promise.all([
  readFile(`${p3}/api-experience-mapping.yaml`, "utf8").then(parse),
  readFile(`${p3}/action-registry.yaml`, "utf8").then(parse),
  readFile(`${p1}/owner-action-wire-contracts.yaml`, "utf8").then(parse),
  readFile(`${p1}/operations.yaml`, "utf8").then(parse),
]);

function collectIds(value, result = new Set()) {
  if (Array.isArray(value)) {
    for (const entry of value) collectIds(entry, result);
  } else if (value && typeof value === "object") {
    for (const key of ["id", "operationId"]) if (typeof value[key] === "string") result.add(value[key]);
    for (const entry of Object.values(value)) collectIds(entry, result);
  }
  return result;
}

const actionIds = new Set(actionRegistry.actions.map(({ id }) => id));
const ownerWireByAction = new Map(ownerWire.records.map((record) => [record.actionRef, record]));
const operationIds = collectIds(operations);

test("API experience mappings use exact action and operation identities and reuse available owner wire contracts", () => {
  assert.ok(mapping.mappings.length > 0);
  assert.equal(new Set(mapping.mappings.map(({ actionRef }) => actionRef)).size, mapping.mappings.length);
  for (const row of mapping.mappings) {
    const binding = row.sourceContractBindings;
    assert.ok(actionIds.has(row.actionRef), `${row.actionRef} exists in the action registry`);
    assert.equal(binding.actionDefinitionRef, `${p3}/action-registry.yaml#actions/@id=${row.actionRef}`);
    assert.deepEqual(binding.channels, row.channels, `${row.actionRef} channel bindings remain exact`);
    assert.equal(binding.runtimeAdmission, "NOT_ADMITTED", `${row.actionRef} must not imply runtime admission`);
    for (const field of ["request", "result", "errors", "authority", "finality", "retry", "transportBinding"]) {
      assert.equal(typeof binding[field], "string", `${row.actionRef} omits ${field}`);
      assert.ok(binding[field].length > 0);
    }

    const existingOwnerWire = ownerWireByAction.get(row.actionRef);
    if (existingOwnerWire) {
      assert.equal(binding.ownerWireDisposition, "OWNER_TYPED_WIRE_CONTRACT", `${row.actionRef} has a reusable typed wire record`);
      assert.equal(binding.ownerWireContractRef, `${p1}/owner-action-wire-contracts.yaml#records/@actionRef=${row.actionRef}`);
    } else {
      assert.equal(binding.ownerWireContractRef, null, `${row.actionRef} must not invent a wire record`);
      assert.match(binding.ownerWireDisposition, /^NO_OWNER_ACTION_WIRE_RECORD;/u);
    }

    if (binding.canonicalOperationRef === null) {
      assert.equal(binding.operationBinding, "NOT_DECLARED_FOR_ACTION", `${row.actionRef} null operation requires an explicit disposition`);
    } else {
      const operationId = binding.canonicalOperationRef.includes("#")
        ? binding.canonicalOperationRef.match(/@id=([^/]+)/u)?.[1]
        : binding.canonicalOperationRef;
      assert.ok(operationId && operationIds.has(operationId), `${row.actionRef} operation ${binding.canonicalOperationRef} exists in PDP-1`);
      assert.equal(binding.operationBinding, "EXACT_ACTION_SOURCE_REFERENCE");
    }
  }
});
