import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const parse = createRequire(new URL("../../ghatana-tools/package.json", import.meta.url))("yaml").parse;
const p1 = ".product-experience/pdp-1-domain-data";
const p3 = ".product-experience/pdp-3-product-experience";
const [mapping, actionRegistry, ownerWire, operations, p3ApiRegistry, sdkRegistry, p2Conventions, devOpenApi, routeManifest, publicOpenApi] = await Promise.all([
  readFile(`${p3}/api-experience-mapping.yaml`, "utf8").then(parse),
  readFile(`${p3}/action-registry.yaml`, "utf8").then(parse),
  readFile(`${p1}/owner-action-wire-contracts.yaml`, "utf8").then(parse),
  readFile(`${p1}/operations.yaml`, "utf8").then(parse),
  readFile(`${p3}/api/api-registry.yaml`, "utf8").then(parse),
  readFile(`${p3}/sdk/operation-registry.yaml`, "utf8").then(parse),
  readFile(".product-experience/pdp-2-design-interface-system/api/conventions.yaml", "utf8").then(parse),
  readFile("contracts/openapi/media-dev.v1.yaml", "utf8").then(parse),
  readFile("config/route-manifest.json", "utf8").then(JSON.parse),
  readFile("contracts/openapi/media.yaml", "utf8").then(parse),
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

test("PXD-232 keeps seven DEV_ONLY route operations one-to-one with their canonical SDK methods", () => {
  const api = p3ApiRegistry.developmentOnlyCatalog;
  const sdk = sdkRegistry.developmentOnlyMethods;
  const p2 = p2Conventions.ownerDefinedDevelopmentOnlyApiCandidate;
  assert.equal(api.authorityDecisionRef, ".product-experience/decision-log.md#PXD-232");
  assert.equal(sdk.authorityDecisionRef, api.authorityDecisionRef);
  assert.equal(api.operations.length, 7);
  assert.equal(sdk.methods.length, 7);
  assert.equal(p2.routeSdkBindings.length, 7);
  assert.equal(api.implementationStatus, "NOT_ASSERTED");
  assert.equal(sdk.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(api.productionRouteManifest, "excluded");
  assert.equal(api.productionOpenApi, "excluded");
  assert.equal(p3ApiRegistry.operations.length, 30, "the production API inventory count remains unchanged");

  const methodIdentity = (method, path) => `${method.toUpperCase()} ${path}`;
  assert.equal(new Set(api.operations.map(({ id }) => id)).size, 7, "candidate API identities are unique");
  assert.equal(new Set(api.operations.map(({ method, path }) => methodIdentity(method, path))).size, 7,
    "candidate route method/path pairs are unique");
  assert.equal(new Set(sdk.methods.map(({ apiOperationRef }) => apiOperationRef)).size, 7,
    "each candidate route maps to one distinct SDK method");

  for (const operation of api.operations) {
    const sdkMethod = sdk.methods.find(({ apiOperationRef }) => apiOperationRef === operation.id);
    const p2Binding = p2.routeSdkBindings.find(({ apiOperationId }) => apiOperationId === operation.id);
    const openApiOperation = devOpenApi.paths[operation.path]?.[operation.method.toLowerCase()];
    assert.ok(sdkMethod, `${operation.id} has exactly one SDK method`);
    assert.ok(p2Binding, `${operation.id} has an owning PDP-2 binding`);
    assert.equal(sdkMethod.httpMethod, operation.method);
    assert.equal(sdkMethod.httpPath, operation.path);
    assert.equal(p2Binding.method, operation.method);
    assert.equal(p2Binding.path, operation.path);
    assert.equal(openApiOperation.operationId, operation.operationId);
    assert.equal(openApiOperation["x-media-candidate-operation-id"], operation.id);
    assert.equal(openApiOperation["x-media-sdk-source"], `${sdkMethod.source}#${sdkMethod.declaringClass}.${sdkMethod.method}`);
    assert.ok(Array.isArray(openApiOperation["x-media-required-permissions"]));
    assert.ok(existsSync(sdkMethod.source), `${operation.id} SDK source exists`);
    assert.ok(existsSync(p2Binding.handlerSource), `${operation.id} handler source exists`);
    assert.ok(existsSync(sdkMethod.testSelector), `${operation.id} focused SDK test selector exists`);
    assert.ok(existsSync(p2Binding.hostIntegrationSelector.split("#")[0]), `${operation.id} host test selector exists`);
  }

  assert.equal(routeManifest.routes.some(({ path }) => path.startsWith("/dev/v1/")), false,
    "candidate development routes remain outside the production route manifest");
  assert.equal(Object.keys(publicOpenApi.paths).some((path) => path.startsWith("/dev/v1/")), false,
    "candidate development routes remain outside the production OpenAPI document");
});
