import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const parse = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml").parse;
const read = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const wire = read(".product-experience/pdp-1-domain-data/owner-action-wire-contracts.yaml");
const operations = read(".product-experience/pdp-1-domain-data/operations.yaml");
const actionRegistry = read(".product-experience/pdp-3-product-experience/action-registry.yaml");
const operationById = new Map([
  ...(operations.individualOperationContracts?.records ?? []),
  ...(operations.ownerDefinedOperationContracts?.records ?? []),
].map((row) => [row.id, row]));
const actionById = new Map(actionRegistry.actions.map((row) => [row.id, row]));
const protectedQueryId = "media.owner-action-wire.inspect-job-retry-policy.v1";

function validateWireRole(record, action, operation) {
  assert.ok(operation, `${record.id} points to an existing canonical operation`);
  assert.equal(record.operationKind, operation.operationKind, `${record.id} preserves the canonical operation kind`);
  assert.equal(record.actionClassification, operation.operationKind === "COMMAND" ? "DOMAIN_COMMAND" : "DOMAIN_QUERY",
    `${record.id} has a domain role matching the canonical operation kind`);
  assert.equal(record.requestAuthority.tenantId, "HOST_AUTHENTICATED_ONLY",
    `${record.id} cannot accept caller-selected tenant scope`);
  assert.equal(record.requestAuthority.principalId, "HOST_AUTHENTICATED_ONLY",
    `${record.id} cannot accept caller-selected actor scope`);

  if (record.id === protectedQueryId) {
    assert.equal(record.actionRef, null, "the source-less owner query must not acquire a UI action identity");
    assert.equal(record.actionApplicability, "OWNER_OPERATION_WITH_NO_SOURCE_ACTION_IDENTITY");
    assert.equal(record.operationKind, "QUERY");
    assert.equal(record.sourceActionRef, null);
    return;
  }

  assert.ok(action, `${record.id} points to an existing source action`);
  assert.equal(record.actionApplicability, "SOURCE_ACTION_BOUND");
  assert.equal(record.sourceActionRef, `.product-experience/pdp-3-product-experience/action-registry.yaml#actions/@id=${record.actionRef}`);
  assert.equal(action.actionDefinitionSemantics?.typedDefinition?.semanticRole, "DOMAIN_OPERATION",
    `${record.id} must remain a domain operation rather than local or presentation behavior`);
  assert.equal(action.actionDefinitionSemantics?.typedDefinition?.operationRef, operation.id,
    `${record.id} operation binding agrees with the action's typed source definition`);
  assert.equal(record.sourceEffect, action.effect, `${record.id} preserves exact source effect meaning`);
  assert.equal(record.sourceFinality, action.finality, `${record.id} preserves exact source finality meaning`);
  assert.ok(record.sourceRecovery, `${record.id} states recovery behavior for its effect scope`);
  assert.deepEqual(record.sourceGuards, action.preconditions, `${record.id} preserves all source preconditions`);
}

function operationFor(record) {
  const match = record.sourceOperationRef?.match(/@id=([^/]+)$/u);
  return match ? operationById.get(match[1]) : undefined;
}

function closedSchemaErrors(schema, rootSchema, path = "$", visited = new Set()) {
  if (!schema || typeof schema !== "object") return [`${path}: missing schema`];
  if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/")) {
    if (visited.has(schema.$ref)) return [];
    const target = schema.$ref.slice(2).split("/").map((part) => part.replace(/~1/gu, "/").replace(/~0/gu, "~"))
      .reduce((value, key) => value?.[key], rootSchema);
    if (!target) return [`${path}: unresolved ${schema.$ref}`];
    const nextVisited = new Set(visited).add(schema.$ref);
    return closedSchemaErrors(target, rootSchema, path, nextVisited);
  }
  const errors = [];
  const typedAdditionalValues = typeof schema.additionalProperties?.$ref === "string"
    && schema.additionalProperties.$ref.startsWith("#/");
  if (schema.type === "object" && schema.additionalProperties !== false && !typedAdditionalValues) {
    errors.push(`${path}: object accepts undeclared properties`);
  }
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    errors.push(...closedSchemaErrors(child, rootSchema, `${path}.${key}`, visited));
  }
  for (const key of ["oneOf", "anyOf", "allOf"]) {
    for (const [index, child] of (schema[key] ?? []).entries()) {
      errors.push(...closedSchemaErrors(child, rootSchema, `${path}.${key}[${index}]`, visited));
    }
  }
  if (schema.items) errors.push(...closedSchemaErrors(schema.items, rootSchema, `${path}[]`, visited));
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    errors.push(...closedSchemaErrors(schema.additionalProperties, rootSchema, `${path}{value}`, visited));
  }
  return errors;
}

test("all 79 owner wire definitions retain exact source identity and domain role", () => {
  assert.equal(wire.records.length, 79);
  assert.equal(new Set(wire.records.map((row) => row.id)).size, 79);
  assert.equal(wire.records.filter((row) => row.actionRef !== null).length, 78);
  assert.equal(new Set(wire.records.filter((row) => row.actionRef).map((row) => row.actionRef)).size, 78);
  assert.equal(wire.records.filter((row) => row.actionClassification === "DOMAIN_COMMAND").length, 27);
  assert.equal(wire.records.filter((row) => row.actionClassification === "DOMAIN_QUERY").length, 52);

  for (const record of wire.records) {
    validateWireRole(record, actionById.get(record.actionRef), operationFor(record));
  }
});

test("wire requests and results are closed, tenant-bound, and distinguish effects from unknown outcomes", () => {
  for (const record of wire.records) {
    for (const schema of [record.requestSchema, record.resultSchema]) {
      assert.equal(schema.type, "object", `${record.id} has an object wire schema`);
      assert.equal(schema.additionalProperties, false, `${record.id} rejects undeclared wire fields`);
      assert.deepEqual(closedSchemaErrors(schema, wire), [], `${record.id} recursively closes request/result object schemas`);
    }
    assert.ok(record.requestSchema.required?.length > 0, `${record.id} declares required request data`);
    assert.equal(record.requestAuthority.tenantId, "HOST_AUTHENTICATED_ONLY");
    assert.equal(record.requestAuthority.principalId, "HOST_AUTHENTICATED_ONLY");
    assert.equal(record.semantics.unknownIsNotSuccess, true);
    assert.equal(record.semantics.runtimeAdmission, "NOT_ADMITTED");

    if (record.actionRef !== null) {
      assert.ok(record.sourceEffect, `${record.id} retains its source effect meaning`);
      assert.ok(record.sourceFinality, `${record.id} distinguishes request/observation finality`);
      assert.ok(record.sourceGuards.length > 0, `${record.id} retains source preconditions`);
      assert.equal(record.operationKind === "QUERY", record.semantics.effectKind === "READ_ONLY_OBSERVATION");
    }
  }
});

test("negative cases reject role, operation, scope, effect, finality, and fabricated UI identity drift", () => {
  const sourceBound = wire.records.find((row) => row.actionRef);
  const protectedQuery = wire.records.find((row) => row.id === protectedQueryId);
  const sourceOperation = operationFor(sourceBound);
  const sourceAction = actionById.get(sourceBound.actionRef);

  assert.throws(() => validateWireRole({ ...sourceBound, actionClassification: "DOMAIN_QUERY" }, sourceAction, sourceOperation));
  assert.throws(() => validateWireRole({ ...sourceBound, operationKind: "QUERY" }, sourceAction, sourceOperation));
  assert.throws(() => validateWireRole({ ...sourceBound, requestAuthority: { ...sourceBound.requestAuthority, tenantId: "CALLER_SUPPLIED" } }, sourceAction, sourceOperation));
  assert.throws(() => validateWireRole({ ...sourceBound, sourceFinality: "COMPLETED" }, sourceAction, sourceOperation));
  assert.throws(() => validateWireRole({ ...sourceBound, sourceEffect: "unrelated-effect" }, sourceAction, sourceOperation));
  assert.throws(() => validateWireRole({ ...protectedQuery, actionRef: "media.action.fictitious-retry-policy" }, {}, operationFor(protectedQuery)));
});
