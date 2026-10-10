import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const parse = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml").parse;
const read = (path) => parse(readFileSync(resolve(root, path), "utf8"));

test("PDP-1 operation bindings back-bind to stable P0 capability intent identities", () => {
  const capabilities = read(".product-experience/pdp-0-product-truth/capabilities.yaml");
  const operations = read(".product-experience/pdp-1-domain-data/operations.yaml");
  const capabilityRows = capabilities.capabilities;
  const operationRows = operations.capabilityOperationContracts.records;
  const capabilityById = new Map(capabilityRows.map((row) => [row.id, row]));
  assert.equal(capabilityRows.length, 462, "the stable P0 capability intent denominator remains complete");
  assert.equal(operationRows.length, 462, "PDP-1 maps the complete P0 intent population");
  assert.equal(new Set(operationRows.map(({ capabilityIntentId }) => capabilityIntentId)).size, 462,
    "each P0 capability intent has one unique PDP-1 binding");

  for (const operation of operationRows) {
    const intent = capabilityById.get(operation.capabilityIntentId);
    assert.ok(intent, `${operation.id} selects an exact stable P0 capabilityIntentId`);
    assert.equal(operation.familyProfileRef, intent.ownerDefinition?.familyProfileRef,
      `${operation.id} profile mapping agrees with its P0 intent`);
    assert.equal(operation.boundsRef, intent.ownerDefinition?.boundsRef,
      `${operation.id} bounds mapping agrees with its P0 intent`);
  }
});
