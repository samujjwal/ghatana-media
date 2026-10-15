import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { validateOwnerActionWireCatalog } from "../scripts/lib/pdp-owner-action-wire-contract-validation.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const requireTools = createRequire(resolve(root, "../ghatana-tools/package.json"));
const parse = requireTools("yaml").parse;
const Ajv2020 = requireTools("ajv/dist/2020").default ?? requireTools("ajv/dist/2020");
const read = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const wire = read(".product-experience/pdp-1-domain-data/owner-action-wire-contracts.yaml");
const operations = read(".product-experience/pdp-1-domain-data/operations.yaml");
const actionRegistry = read(".product-experience/pdp-3-product-experience/action-registry.yaml");
const operationById = new Map([
  ...(operations.individualOperationContracts?.records ?? []),
  ...(operations.ownerDefinedOperationContracts?.records ?? []),
].map((row) => [row.id, row]));
const retryPolicyRead = operations.ownerTypedObservationContracts.records
  .find(({ id }) => id === "media.observation-contract.retry-policy-current-read.v1");
const actionById = new Map(actionRegistry.actions.map((row) => [row.id, row]));
const protectedQueryId = "media.owner-action-wire.inspect-job-retry-policy.v1";
const domainObjects = read(".product-experience/pdp-1-domain-data/domain-objects.yaml");

function validateCatalog(catalog = wire, sourceOperations = operations) {
  return validateOwnerActionWireCatalog({
    catalog,
    operations: sourceOperations,
    actions: actionRegistry,
    domainObjects,
  });
}

function sameShape(left, right) {
  const sort = (value) => Array.isArray(value)
    ? value.map(sort)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])]))
      : value;
  return JSON.stringify(sort(left)) === JSON.stringify(sort(right));
}

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
  if (Object.hasOwn(schema, "$ref")) {
    if (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#/")) {
      return [`${path}: unsupported or external ${String(schema.$ref)}`];
    }
    if (visited.has(schema.$ref)) return [];
    const target = schema.$ref.slice(2).split("/").map((part) => part.replace(/~1/gu, "/").replace(/~0/gu, "~"))
      .reduce((value, key) => value?.[key], rootSchema);
    if (target === undefined) return [`${path}: unresolved ${schema.$ref}`];
    const nextVisited = new Set(visited).add(schema.$ref);
    return closedSchemaErrors(target, rootSchema, path, nextVisited);
  }
  const errors = [];
  const typedAdditionalValues = typeof schema.additionalProperties?.$ref === "string"
    && schema.additionalProperties.$ref.startsWith("#/");
  const compositionOnlyEnvelope = !schema.properties
    && ["oneOf", "anyOf", "allOf"].some((key) => Array.isArray(schema[key]) && schema[key].length > 0);
  if (schema.type === "object" && !compositionOnlyEnvelope
    && schema.additionalProperties !== false && !typedAdditionalValues) {
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
  for (const key of ["if", "then", "else", "not"]) {
    if (schema[key]) errors.push(...closedSchemaErrors(schema[key], rootSchema, `${path}.${key}`, visited));
  }
  if (schema.items) errors.push(...closedSchemaErrors(schema.items, rootSchema, `${path}[]`, visited));
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    errors.push(...closedSchemaErrors(schema.additionalProperties, rootSchema, `${path}{value}`, visited));
  }
  return errors;
}

function schemaExample(schema, rootSchema, visited = new Set()) {
  if (schema.$ref) {
    assert.ok(schema.$ref.startsWith("#/"), `fixture requires a local reference: ${schema.$ref}`);
    assert.ok(!visited.has(schema.$ref), `fixture encountered recursive reference ${schema.$ref}`);
    const target = schema.$ref.slice(2).split("/").map((part) => part.replace(/~1/gu, "/").replace(/~0/gu, "~"))
      .reduce((value, key) => value?.[key], rootSchema);
    assert.ok(target, `fixture reference resolves: ${schema.$ref}`);
    return schemaExample(target, rootSchema, new Set(visited).add(schema.$ref));
  }
  if (Object.hasOwn(schema, "const")) return structuredClone(schema.const);
  if (Array.isArray(schema.enum)) return structuredClone(schema.enum[0]);
  if (Array.isArray(schema.oneOf)) return schemaExample(schema.oneOf[0], rootSchema, visited);
  if (Array.isArray(schema.anyOf)) return schemaExample(schema.anyOf[0], rootSchema, visited);
  if (Array.isArray(schema.allOf)) {
    return schema.allOf.reduce((result, child) => {
      const part = schemaExample(child, rootSchema, visited);
      return result && part && typeof result === "object" && typeof part === "object" && !Array.isArray(result) && !Array.isArray(part)
        ? { ...result, ...part }
        : part;
    }, {});
  }
  if (schema.type === "object" || schema.properties || schema.required) {
    const value = {};
    for (const name of schema.required ?? []) {
      assert.ok(schema.properties?.[name], `fixture has a schema for required property ${name}`);
      value[name] = schemaExample(schema.properties[name], rootSchema, visited);
    }
    if (schema.then && schema.if) {
      for (const name of schema.then.required ?? []) {
        if (!Object.hasOwn(value, name)) value[name] = schemaExample(schema.then.properties?.[name] ?? schema.properties?.[name], rootSchema, visited);
      }
    }
    return value;
  }
  if (schema.type === "array") {
    const count = schema.minItems ?? 0;
    return Array.from({ length: count }, () => schema.items ? schemaExample(schema.items, rootSchema, visited) : null);
  }
  if (schema.type === "string" || schema.pattern || schema.format) {
    if (schema.format === "date-time") return "2026-10-11T12:00:00Z";
    if (schema.pattern?.includes("sha256:")) return `sha256:${"0".repeat(64)}`;
    let candidate = schema.minLength && schema.minLength > 1 ? "x".repeat(schema.minLength) : "x";
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(candidate)) {
      candidate = schema.pattern.includes("A-Za-z0-9") ? "x" : "test";
    }
    return candidate;
  }
  if (schema.type === "integer" || schema.type === "number") return schema.minimum ?? 0;
  if (schema.type === "boolean") return false;
  if (schema.type === "null") return null;
  return {};
}

test("closed schema checks inspect conditional branches and negated schemas", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    if: { type: "object", properties: { mode: { const: "conditional" } }, additionalProperties: true },
    then: { type: "object", additionalProperties: true },
    else: { type: "object", additionalProperties: false },
    not: { type: "object", additionalProperties: true },
  };

  assert.deepEqual(closedSchemaErrors(schema, schema), [
    "$.if: object accepts undeclared properties",
    "$.then: object accepts undeclared properties",
    "$.not: object accepts undeclared properties",
  ]);
});

test("closed schema checks reject external and dangling references", () => {
  const rootSchema = { $defs: { local: { type: "string" } } };
  assert.deepEqual(closedSchemaErrors({ $ref: "https://example.invalid/schema.json#/$defs/value" }, rootSchema), [
    "$: unsupported or external https://example.invalid/schema.json#/$defs/value",
  ]);
  assert.deepEqual(closedSchemaErrors({ $ref: "#/$defs/missing" }, rootSchema), [
    "$: unresolved #/$defs/missing",
  ]);
  assert.deepEqual(closedSchemaErrors({ $ref: "#/$defs/local" }, rootSchema), []);
});

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

test("source projection proves zero mismatches across all 78 action-bound schemas plus the owner-only query", () => {
  const result = validateCatalog();
  assert.equal(wire.records.filter((record) => record.actionRef !== null).length, 78);
  assert.equal(wire.records.filter((record) => record.actionRef === null).length, 1);
  assert.equal(result.valid, true, JSON.stringify(result.issues));
  assert.deepEqual(result.issues, []);
  assert.equal(wire.idempotencyBindings.length, 79);
  assert.equal(wire.resultProjectionBindings.length, 79);
  assert.equal(wire.actorBindings.length, 78);
  assert.equal(wire.relatedOperationCoverage.length, 1);
  assert.match(wire.canonicalReferenceTenantRule, /must equal the tenant resolved by the trusted host context/u);
  assert.match(wire.unknownOutcomeRule, /never blindly replay/u);
  assert.equal(wire.resultProjectionBindings.filter((binding) => binding.mappingStatus.startsWith("OWNER_DECLARED_NORMALIZED_PROJECTION")).length, 78,
    "the 78 action-owned typed projections disclose where fields are not exposed and do not claim producer payload equivalence");
  assert.equal(wire.resultProjectionBindings.filter((binding) => binding.mappingStatus.startsWith("EXACT_TYPED_OBSERVATION_SCHEMA")).length, 1,
    "the operation-only read query remains tied to its exact observation schema");
  assert.ok(wire.resultProjectionBindings.every((binding) => binding.sourceFieldMappings.length === binding.sourceDeclaredFields.length),
    "every source-declared result field has an explicit mapping or non-exposure disposition");
  const cancellation = wire.relatedOperationCoverage[0];
  assert.equal(cancellation.operationRef, "media.operation-slice.cancel-job");
  assert.match(cancellation.requestedMeaning, /does not confirm stop/u);
  assert.match(cancellation.unknownMeaning, /UNKNOWN_OUTCOME remains unknown/u);
  assert.match(cancellation.noReversalMeaning, /not reversal/u);
});

test("opaque owner evidence and destination references reject empty or non-string values without adding grammar", () => {
  const scalarContracts = operations.capabilityOperationContracts;
  assert.equal(scalarContracts.scalarTypeRecordsCount, scalarContracts.scalarTypeRecords.length);
  assert.deepEqual(
    Object.keys(scalarContracts.scalarTypes).sort(),
    scalarContracts.scalarTypeRecords.map(({ key }) => key).sort(),
    "every canonical scalar map definition has exactly one normative record",
  );
  for (const key of ["opaque-owner-evidence-ref", "typed-destination-profile-ref"]) {
    assert.deepEqual(scalarContracts.scalarTypes[key].validator, { type: "string", minLength: 1 });
    assert.deepEqual(scalarContracts.scalarTypeRecords.find((row) => row.key === key).validator,
      scalarContracts.scalarTypes[key].validator);
  }
  assert.deepEqual(scalarContracts.scalarTypes["iana-media-type"].validator,
    scalarContracts.scalarTypeRecords.find((row) => row.key === "iana-media-type").validator,
    "the canonical IANA media-type validator and normative record stay aligned");

  const evidenceSources = operations.ownerDefinedOperationContracts.records.filter((operation) =>
    operation.requestSchema?.properties?.evidenceRefs?.items?.type === "opaque-owner-evidence-ref");
  assert.equal(evidenceSources.length, 3, "the three rights operations keep their exact evidence-reference wires");
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  for (const source of evidenceSources) {
    const operationId = source.id;
    const wireRecord = wire.records.find((record) => record.sourceOperationRef.endsWith(`@id=${operationId}`));
    assert.ok(wireRecord, `${operationId} has a normalized wire record`);
    const sourceSchema = source.requestSchema.properties.evidenceRefs;
    const wireSchema = wireRecord.requestSchema.properties.evidenceRefs;
    assert.deepEqual(wireSchema.items, scalarContracts.scalarTypes["opaque-owner-evidence-ref"].validator);
    assert.equal(wireSchema.minItems, 1);
    assert.equal(wireSchema.maxItems, 32);
    const validate = ajv.compile(wireSchema);
    assert.equal(validate([]), false, `${operationId} preserves required evidence-reference cardinality`);
    assert.equal(validate([""]), false, `${operationId} rejects an empty evidence reference`);
    assert.equal(validate([7]), false, `${operationId} rejects a non-string evidence reference`);
    assert.equal(validate(["  opaque /? ☃ value  "]), true, `${operationId} preserves opaque string contents`);
    assert.equal(validate(Array(sourceSchema.maxItems).fill("opaque")), true);
    assert.equal(validate(Array(sourceSchema.maxItems + 1).fill("opaque")), false);
  }

  const renderSource = operations.ownerDefinedOperationContracts.records.find(({ id }) => id === "media.operation.action.submit-render");
  const renderWire = wire.records.find(({ sourceOperationRef }) => sourceOperationRef.endsWith(`@id=${renderSource.id}`));
  assert.ok(renderWire);
  const destinationSchema = renderWire.requestSchema.properties.destinationOptions;
  assert.deepEqual(destinationSchema.items, scalarContracts.scalarTypes["typed-destination-profile-ref"].validator);
  assert.equal(destinationSchema.maxItems, 8);
  assert.equal(destinationSchema.minItems, 0, "the source default preserves an empty destination-option list");
  const validateDestinations = ajv.compile(destinationSchema);
  assert.equal(validateDestinations([]), true);
  assert.equal(validateDestinations([""]), false);
  assert.equal(validateDestinations([false]), false);
  assert.equal(validateDestinations(["  profile /? ☃ value  "]), true,
    "destination references remain opaque and have no invented URI or character grammar");
  assert.equal(validateDestinations(Array(8).fill("opaque")), true);
  assert.equal(validateDestinations(Array(9).fill("opaque")), false);
});

test("source projection rejects schema drift, unsafe fields, wrong bindings, and weakened outcomes", () => {
  const actionBound = wire.records.find((record) => record.actionRef !== null);
  const query = wire.records.find((record) => record.id === protectedQueryId);
  const rejectWith = (mutate, code, detail) => {
    const catalog = structuredClone(wire);
    const sourceOperations = structuredClone(operations);
    mutate(catalog, sourceOperations);
    const result = validateCatalog(catalog, sourceOperations);
    assert.equal(result.valid, false);
    assert.ok(result.issues.some((issue) => issue.code === code && issue.detail === detail), `${code} (${detail}): ${JSON.stringify(result.issues)}`);
  };

  rejectWith((catalog) => {
    const record = catalog.records.find(({ id }) => id === actionBound.id);
    record.requestSchema.properties.requestId.maxLength -= 1;
  }, "SOURCE_PROPERTY_SHAPE_DRIFT", "media.operation.action.apply-admitted-edit.requestId");
  rejectWith((catalog) => {
    const record = catalog.records.find(({ id }) => id === actionBound.id);
    record.actionRef = "media.action.inspect-job-retry-policy";
  }, "ACTION_IDENTITY_MISMATCH", "media.operation.action.apply-admitted-edit");
  rejectWith((catalog) => {
    const record = catalog.records.find(({ id }) => id === actionBound.id);
    record.requestSchema.properties.operationRef.const = "media.operation.action.unrelated";
  }, "REQUEST_OPERATION_NOT_PINNED", "media.operation.action.apply-admitted-edit");
  rejectWith((catalog) => {
    const record = catalog.records.find(({ id }) => id === actionBound.id);
    record.requestSchema.required = record.requestSchema.required.filter((name) => name !== "requestId");
  }, "SOURCE_REQUIREDNESS_DRIFT", "media.operation.action.apply-admitted-edit");
  rejectWith((catalog) => {
    const record = catalog.records.find(({ id }) => id === actionBound.id);
    record.requestSchema.properties.unreviewedInput = { type: "string" };
  }, "SOURCE_PROPERTY_SET_DRIFT", "media.operation.action.apply-admitted-edit");
  rejectWith((catalog) => {
    const record = catalog.records.find(({ id }) => id === actionBound.id);
    record.requestSchema.properties.principalId = { type: "string" };
  }, "SOURCE_PROPERTY_SET_DRIFT", "media.operation.action.apply-admitted-edit");
  rejectWith((catalog) => {
    const record = catalog.records.find(({ id }) => id === actionBound.id);
    record.resultSchema.additionalProperties = false;
  }, "OPEN_ACTION_ENVELOPE", "media.operation.action.apply-admitted-edit");
  rejectWith((catalog) => {
    const record = catalog.records.find(({ id }) => id === "media.owner-action-wire.deliver-exact-version.v1");
    record.requestSchema.properties.declaredScopeRef = {};
  }, "UNRESOLVED_OWNER_COMPLETION", "media.operation.action.deliver-exact-version.declaredScopeRef");
  rejectWith((catalog) => {
    catalog.$defs.purposeRegionTimeDistributionScope.properties.purposeId.minLength = 0;
  }, "OWNER_SCOPE_SCHEMA_DRIFT", "$defs/purposeRegionTimeDistributionScope");
  rejectWith((catalog) => {
    const record = catalog.records.find(({ id }) => id === actionBound.id);
    record.resultSchema.oneOf[1].properties.outcome.enum = ["REJECTED"];
  }, "UNKNOWN_OR_DENIED_BRANCH_MISSING", "media.operation.action.apply-admitted-edit");
  rejectWith((catalog, sourceOperations) => {
    const source = sourceOperations.ownerDefinedOperationContracts.records.find(({ id }) => id === "media.operation.action.apply-admitted-edit");
    source.requestIdempotency.replay = "";
  }, "SOURCE_RETRY_OR_FINALITY_MEANING_MISSING", "media.operation.action.apply-admitted-edit");
  rejectWith((catalog, sourceOperations) => {
    const source = sourceOperations.ownerDefinedOperationContracts.records.find(({ id }) => id === "media.operation.action.apply-admitted-edit");
    source.errorSchemaRef = "missing-profile#errors";
  }, "SOURCE_ERROR_OR_RECOVERY_MEANING_MISSING", "media.operation.action.apply-admitted-edit");
  rejectWith((catalog) => {
    const identity = catalog.$defs.canonicalReferences.media_domain_project.properties.identity;
    identity.required = identity.required.filter((field) => field !== "tenantId");
    delete identity.properties.tenantId;
  }, "CANONICAL_IDENTITY_SCHEMA_DRIFT", "media.domain.project");
  rejectWith((catalog) => {
    catalog.$defs.canonicalReferences["media_domain_artifact-version"].properties.objectType.const = "media.domain.artifact";
  }, "CANONICAL_IDENTITY_SCHEMA_DRIFT", "media.domain.artifact-version");
  rejectWith((catalog) => {
    catalog.canonicalReferenceTenantRule = "Caller-selected tenantId is authoritative.";
  }, "TENANT_REFERENCE_BINDING_RULE", "canonicalReferenceTenantRule");
  rejectWith((catalog) => {
    const binding = catalog.idempotencyBindings.find(({ sourceOperationRef }) => sourceOperationRef.endsWith("@id=media.operation.action.apply-admitted-edit"));
    binding.sourceRequestIdempotency.replay = "Blindly replay after UNKNOWN with a new requestId";
  }, "IDEMPOTENCY_BINDING_DRIFT", "media.operation.action.apply-admitted-edit");
  rejectWith((catalog, sourceOperations) => {
    const source = sourceOperations.ownerDefinedOperationContracts.records.find(({ id }) => id === "media.operation.action.apply-admitted-edit");
    source.requestIdempotency.replay = "Blindly replay after UNKNOWN with a new requestId";
  }, "IDEMPOTENCY_BINDING_DRIFT", "media.operation.action.apply-admitted-edit");
  rejectWith((catalog) => {
    const binding = catalog.resultProjectionBindings.find(({ sourceOperationRef }) => sourceOperationRef.endsWith("@id=media.operation.action.apply-admitted-edit"));
    binding.sourceFieldMappings = binding.sourceFieldMappings.filter(({ sourceField }) => sourceField !== "exactTargetRef");
  }, "RESULT_PROJECTION_BINDING_DRIFT", "media.operation.action.apply-admitted-edit");
  rejectWith((catalog) => {
    const binding = catalog.actorBindings.find(({ actionRef }) => actionRef === "media.action.apply-admitted-edit");
    binding.actorRefs = ["media.operator"];
  }, "ACTION_ACTOR_BINDING_DRIFT", "media.operation.action.apply-admitted-edit");
  rejectWith((catalog) => {
    catalog.relatedOperationCoverage[0].requestedMeaning = "SUCCEEDED confirms the provider stopped and the job is cancelled.";
  }, "CANCELLATION_SEMANTICS_COVERAGE_DRIFT", "media.operation-slice.cancel-job");
  rejectWith((catalog) => {
    const record = catalog.records.find(({ id }) => id === query.id);
    record.resultSchema.oneOf[0].properties.currentness.enum = ["CURRENT", "UNKNOWN"];
  }, "OPERATION_ONLY_QUERY_SOURCE_LINK_DRIFT", "media.operation.action.inspect-job-retry-policy");
  rejectWith((catalog) => {
    const record = catalog.records.find(({ id }) => id === query.id);
    record.sourceObservationContractRef = ".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=stale-policy-read";
  }, "OPERATION_ONLY_QUERY_SOURCE_LINK_DRIFT", "media.operation.action.inspect-job-retry-policy");
  rejectWith((catalog) => {
    const record = catalog.records.find(({ id }) => id === query.id);
    record.requestSchema.properties.unreviewedSelector = { type: "string" };
  }, "OPERATION_ONLY_QUERY_SOURCE_LINK_DRIFT", "media.operation.action.inspect-job-retry-policy");
  rejectWith((catalog) => {
    const record = catalog.records.find(({ id }) => id === query.id);
    record.requestSchema.properties.tenantId = { type: "string" };
  }, "OPERATION_ONLY_QUERY_SOURCE_LINK_DRIFT", "media.operation.action.inspect-job-retry-policy");
  rejectWith((catalog) => {
    const record = catalog.records.find(({ id }) => id === query.id);
    record.requestSchema.additionalProperties = true;
  }, "OPERATION_ONLY_QUERY_SOURCE_LINK_DRIFT", "media.operation.action.inspect-job-retry-policy");
  rejectWith((catalog) => {
    const record = catalog.records.find(({ id }) => id === query.id);
    record.resultSchema.oneOf[0].properties.unreviewedResult = { type: "string" };
  }, "OPERATION_ONLY_QUERY_SOURCE_LINK_DRIFT", "media.operation.action.inspect-job-retry-policy");

  rejectWith((catalog) => {
    catalog.$defs.immutableSourceSnapshot.properties.artifactVersionRefs.minItems = 0;
  }, "SNAPSHOT_ARTIFACT_IDENTITY_SHAPE_DRIFT", "media.operation.action.submit-render.sourceSnapshot");
  rejectWith((catalog) => {
    catalog.$defs.immutableSourceSnapshot.properties.artifactVersionRefs.uniqueItems = true;
  }, "SNAPSHOT_UNSUPPORTED_ARRAY_REFINEMENT", "media.operation.action.submit-render.sourceSnapshot");
  rejectWith((catalog) => {
    catalog.$defs.immutableSourceSnapshot.properties.artifactVersionRefs.items.oneOf = [
      { $ref: "#/$defs/canonicalReferences/media_domain_project-revision" },
    ];
  }, "SNAPSHOT_ARTIFACT_IDENTITY_SHAPE_DRIFT", "media.operation.action.submit-render.sourceSnapshot");
  rejectWith((catalog) => {
    catalog.$defs.immutableSourceSnapshot.if.required = [];
  }, "SNAPSHOT_PROJECT_REVISION_CONDITION_UNRESOLVED", "media.operation.action.submit-render.sourceSnapshot");
  rejectWith((catalog, sourceOperations) => {
    const source = sourceOperations.ownerDefinedOperationContracts.records.find(({ id }) => id === "media.operation.action.submit-render");
    source.requestSchema.properties.sourceSnapshot.allOf = [];
  }, "SNAPSHOT_PROJECT_REVISION_CONDITION_UNRESOLVED", "media.operation.action.submit-render.sourceSnapshot");
  rejectWith((catalog) => {
    const source = catalog.records.find(({ id }) => id === "media.owner-action-wire.export-authorized-provenance.v1");
    delete source.requestSchema.properties.exportScope.uniqueItems;
  }, "SOURCE_PROPERTY_SHAPE_DRIFT", "media.operation.action.export-authorized-provenance.exportScope");
  rejectWith((catalog) => {
    const source = catalog.records.find(({ id }) => id === "media.owner-action-wire.export-authorized-provenance.v1");
    source.requestSchema.properties.exportScope.items.pattern = "^.*$";
  }, "SOURCE_PROPERTY_SHAPE_DRIFT", "media.operation.action.export-authorized-provenance.exportScope");
  rejectWith((catalog) => {
    const source = catalog.records.find(({ id }) => id === "media.owner-action-wire.submit-simulation.v1");
    source.requestSchema.properties.outputSelection.items.enum.pop();
  }, "SOURCE_PROPERTY_SHAPE_DRIFT", "media.operation.action.submit-simulation.outputSelection");
  const snapshotNoExtraBounds = structuredClone(wire);
  delete snapshotNoExtraBounds.$defs.immutableSourceSnapshot.properties.artifactVersionRefs.uniqueItems;
  delete snapshotNoExtraBounds.$defs.immutableSourceSnapshot.properties.artifactVersionRefs.maxItems;
  assert.ok(!validateCatalog(snapshotNoExtraBounds).issues.some((issue) => issue.code === "SNAPSHOT_UNSUPPORTED_ARRAY_REFINEMENT"),
    "snapshot references cannot gain uniqueness or a maximum cardinality absent from source");

  const sourceArraySemantics = structuredClone(wire);
  for (const record of sourceArraySemantics.records) {
    if (record.id === "media.owner-action-wire.apply-admitted-edit.v1") {
      record.requestSchema.properties.exactTargetRefs.uniqueItems = true;
    }
  }
  const arrayReport = validateCatalog(sourceArraySemantics);
  assert.ok(arrayReport.issues.some((issue) => issue.code === "SOURCE_PROPERTY_SHAPE_DRIFT"
    && issue.detail === "media.operation.action.apply-admitted-edit.exactTargetRefs"),
  "unsupported wire uniqueness is rejected against the source array shape");
});

test("wire requests and results are closed, tenant-bound, and distinguish effects from unknown outcomes", () => {
  for (const record of wire.records) {
    for (const schema of [record.requestSchema, record.resultSchema]) {
      assert.equal(schema.type, "object", `${record.id} has an object wire schema`);
      assert.deepEqual(closedSchemaErrors(schema, wire), [], `${record.id} recursively closes request/result object schemas`);
    }
    assert.equal(record.requestSchema.additionalProperties, false, `${record.id} rejects undeclared request fields`);
    assert.equal(record.resultSchema.additionalProperties, undefined,
      `${record.id} leaves composition to its closed result branches instead of rejecting every branch property at the wrapper`);
    assert.ok(record.resultSchema.oneOf?.length > 0, `${record.id} defines finite result variants`);
    assert.ok(record.resultSchema.oneOf.every((branch) => branch.additionalProperties === false),
      `${record.id} closes every result variant against undeclared fields`);
    assert.ok(record.requestSchema.required?.length > 0, `${record.id} declares required request data`);
    assert.equal(record.requestAuthority.tenantId, "HOST_AUTHENTICATED_ONLY");
    assert.equal(record.requestAuthority.principalId, "HOST_AUTHENTICATED_ONLY");
    assert.equal(record.semantics.unknownIsNotSuccess, true);
    assert.equal(record.semantics.runtimeAdmission, "NOT_ADMITTED");
    const failureBranch = record.resultSchema.oneOf.find((branch) => branch.properties?.reasonCode);
    assert.ok(failureBranch, `${record.id} declares a closed failure result branch`);
    assert.equal(failureBranch.additionalProperties, false, `${record.id} rejects undeclared failure fields`);
    assert.ok(failureBranch.required.includes("reasonCode"), `${record.id} requires a failure reason`);
    assert.equal(failureBranch.properties.reasonCode.type, "string");
    assert.ok(failureBranch.properties.reasonCode.minLength >= 1, `${record.id} rejects an empty failure reason`);
    assert.ok(failureBranch.properties.reasonCode.maxLength > 0, `${record.id} bounds failure reason size`);
    const failureOutcomes = failureBranch.properties.outcome.enum ?? [failureBranch.properties.outcome.const];
    assert.ok(failureOutcomes.some((outcome) => outcome === "REJECTED" || outcome === "DENIED"),
      `${record.id} distinguishes failure from success`);
    if (record.operationKind === "QUERY") {
      assert.ok(failureOutcomes.includes("DENIED"), `${record.id} reports denied reads without exposing an observation`);
    } else {
      assert.ok(failureOutcomes.includes("UNKNOWN"), `${record.id} preserves unknown command outcome`);
    }

    if (record.actionRef !== null) {
      assert.ok(record.sourceEffect, `${record.id} retains its source effect meaning`);
      assert.ok(record.sourceFinality, `${record.id} distinguishes request/observation finality`);
      assert.ok(record.sourceGuards.length > 0, `${record.id} retains source preconditions`);
      assert.equal(record.operationKind === "QUERY", record.semantics.effectKind === "READ_ONLY_OBSERVATION");
    }
  }
});

test("deliver-exact-version wire result exposes the exact request tuple without claiming destination acknowledgment", () => {
  const record = wire.records.find(({ id }) => id === "media.owner-action-wire.deliver-exact-version.v1");
  const operation = operationById.get("media.operation.action.deliver-exact-version");
  assert.ok(record);
  assert.ok(operation);
  assert.equal(operation.resultSchema.successOutcome, "REQUEST_ACCEPTED");
  const success = record.resultSchema.oneOf.find(({ properties }) => properties?.outcome?.const === "REQUEST_ACCEPTED");
  const failure = record.resultSchema.oneOf.find(({ properties }) => properties?.reasonCode);
  assert.ok(success, "successful delivery command result means request accepted only");
  assert.ok(failure, "rejected/unknown command results remain represented");
  assert.deepEqual(success.required.filter((field) => !["operationRef", "actionRef", "outcome"].includes(field)),
    operation.resultSchema.fields, "the wire result requires every canonical delivery result field");
  assert.equal(record.semantics.ownerReceiptSemantics.includes("request receipt only"), true);
  assert.equal(record.semantics.ownerReceiptSemantics.includes("destination acknowledgment is a separate"), true);
  assert.deepEqual(failure.properties.outcome.enum, ["REJECTED", "UNKNOWN"]);

  const validateResult = new Ajv2020({ allErrors: true, strict: false, formats: { "date-time": true } }).compile({
    $defs: wire.$defs,
    allOf: [record.resultSchema],
  });
  const accepted = schemaExample(success, { $defs: wire.$defs });
  assert.equal(validateResult(accepted), true, JSON.stringify(validateResult.errors));
  assert.equal(validateResult({ ...accepted, outcome: "ACKNOWLEDGED" }), false,
    "a command receipt cannot use destination-acknowledgment finality");
  assert.equal(validateResult({ ...accepted, acknowledgmentStatus: "ACKNOWLEDGED" }), false,
    "the closed command result cannot carry a destination acknowledgment claim");
  for (const field of operation.resultSchema.fields) {
    const missing = structuredClone(accepted);
    delete missing[field];
    assert.equal(validateResult(missing), false, `the exact command result tuple requires ${field}`);
  }
  const malformedFingerprint = { ...accepted, deliveryRequestFingerprint: "caller-fingerprint" };
  assert.equal(validateResult(malformedFingerprint), false, "delivery fingerprint must use canonical SHA-256 syntax");
  for (const outcome of failure.properties.outcome.enum) {
    assert.equal(validateResult({
      operationRef: "media.operation.action.deliver-exact-version",
      actionRef: "media.action.deliver-exact-version",
      outcome,
      requestId: accepted.requestId,
      reasonCode: "owner-result-unknown",
    }), true, `${outcome} remains a valid fail-closed command result`);
  }
});

test("all 79 closed result variants accept a schema-valid payload and reject extensions", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false, formats: { "date-time": true } });
  const refRoot = { $defs: wire.$defs };
  let branchCount = 0;
  for (const record of wire.records) {
    const validate = ajv.compile({ $defs: wire.$defs, allOf: [record.resultSchema] });
    for (const [index, branch] of record.resultSchema.oneOf.entries()) {
      const example = schemaExample(branch, refRoot);
      assert.equal(validate(example), true,
        `${record.id} result branch ${index} accepts its schema-derived payload: ${JSON.stringify(validate.errors)}`);
      assert.equal(validate({ ...example, unreviewedResult: true }), false,
        `${record.id} result branch ${index} rejects an undeclared extension`);
      branchCount += 1;
    }
  }
  assert.equal(branchCount, wire.records.reduce((count, record) => count + record.resultSchema.oneOf.length, 0));
});

test("view-job-status distinguishes CURRENT and STALE observations from unavailable UNKNOWN", () => {
  const record = wire.records.find(({ id }) => id === "media.owner-action-wire.view-job-status.v1");
  const validateResult = new Ajv2020({ allErrors: true, strict: false, formats: { "date-time": true } }).compile({
    $defs: wire.$defs,
    allOf: [structuredClone(record.resultSchema)],
  });
  const projectRef = {
    objectType: "media.domain.project",
    identity: { tenantId: "tenant-1", projectId: "project-1" },
  };
  const observed = (currentness) => ({
    operationRef: "media.operation.action.view-job-status",
    actionRef: "media.action.view-job-status",
    outcome: "OBSERVED",
    currentness,
    requestedSubjects: [projectRef],
    observationRefs: [projectRef],
    observedAt: "2026-10-11T12:00:00Z",
  });
  const unavailable = {
    operationRef: "media.operation.action.view-job-status",
    actionRef: "media.action.view-job-status",
    outcome: "UNKNOWN",
    requestedSubjects: [projectRef],
    reasonCode: "CURRENT_EVIDENCE_UNAVAILABLE",
  };

  assert.equal(validateResult(observed("CURRENT")), true, "current evidence may be reported as observed-current");
  assert.equal(validateResult(observed("STALE")), true, "last-known evidence may be returned only with an explicit stale label");
  assert.equal(validateResult(unavailable), true, "unavailable current evidence remains a separate UNKNOWN result with no observation payload");
  assert.equal(validateResult(observed("UNKNOWN")), false, "UNKNOWN cannot be represented as an OBSERVED success");
  assert.equal(validateResult({ ...observed("CURRENT"), unreviewedResult: true }), false,
    "a valid observation rejects undeclared result properties");
  assert.equal(validateResult({ ...observed("STALE"), observationRefs: [] }), false,
    "stale requires an actual last-known observation reference");
  assert.equal(validateResult({ ...unavailable, unreviewedResult: true }), false,
    "the UNKNOWN variant rejects undeclared result properties");
  assert.equal(validateResult({ ...unavailable, observationRefs: [projectRef] }), false,
    "the unavailable UNKNOWN branch cannot carry stale/current observation data");
  assert.deepEqual(record.resultSchema.oneOf[0].properties.currentness.enum, ["CURRENT", "STALE"]);
  assert.equal(record.semantics.runtimeAdmission, "NOT_ADMITTED");
  assert.match(record.semantics.freshnessSemantics, /no runtime freshness evidence/u);
  assert.match(record.semantics.freshnessSemantics, /grants no execution admission/u);
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

function retryPolicyWireIsSourceBound(record) {
  const request = record.requestSchema;
  const currentResult = record.resultSchema.oneOf?.[0];
  const deniedResult = record.resultSchema.oneOf?.[1];
  const requiredQueryInputs = retryPolicyRead.requestSchema.required;
  const sourceResultRequired = retryPolicyRead.resultSchema.required;
  const sourceObservation = retryPolicyRead.resultSchema.properties.observation;
  const observedBranch = sourceObservation.oneOf.find(({ properties }) => properties?.kind?.const === "OBSERVED_RETRY_POLICY_AND_ATTEMPT");
  const unknownBranch = sourceObservation.oneOf.find(({ properties }) => properties?.kind?.const === "UNKNOWN");
  const expectedRequestProperties = structuredClone(retryPolicyRead.requestSchema.properties);
  expectedRequestProperties.operationRef = { const: "media.operation.action.inspect-job-retry-policy" };
  const expectedSourceResult = structuredClone(retryPolicyRead.resultSchema);
  if (expectedSourceResult.properties.operationRef.enum?.length === 1) {
    expectedSourceResult.properties.operationRef = { const: expectedSourceResult.properties.operationRef.enum[0] };
  }
  expectedSourceResult.required.sort();
  const normalizedCurrentResult = structuredClone(currentResult);
  normalizedCurrentResult.required.sort();
  const expectedDeniedRequired = ["operationRef", "queryId", "outcome", "reasonCode"].sort();

  return record.id === protectedQueryId
    && record.actionRef === null
    && record.sourceActionRef === null
    && record.actionApplicability === "OWNER_OPERATION_WITH_NO_SOURCE_ACTION_IDENTITY"
    && record.operationKind === "QUERY"
    && record.actionClassification === "DOMAIN_QUERY"
    && record.sourceOperationRef.endsWith("@id=media.operation.action.inspect-job-retry-policy")
    && record.sourceObservationContractRef.endsWith("@id=media.observation-contract.retry-policy-current-read.v1")
    && request.additionalProperties === false
    && sameShape(Object.keys(request.properties).sort(), Object.keys(expectedRequestProperties).sort())
    && sameShape(request.properties, expectedRequestProperties)
    && sameShape([...request.required].sort(), ["operationRef", ...requiredQueryInputs].sort())
    && requiredQueryInputs.every((field) => request.required.includes(field)
      && JSON.stringify(request.properties[field]) === JSON.stringify(retryPolicyRead.requestSchema.properties[field]))
    && !["tenantScopeRef", "principalRef", "readAuthorityRef", "expectedReadVersion"].some((field) => Object.hasOwn(request.properties, field))
    && record.requestAuthority.tenantId === "HOST_AUTHENTICATED_ONLY"
    && record.requestAuthority.principalId === "HOST_AUTHENTICATED_ONLY"
    && /HOST_RESOLVED_FOR_READ/u.test(record.requestAuthority.authorityDecision)
    && record.requestAuthority.readAuthorityRef === "HOST_RESOLVED_FROM_TRUSTED_CONTEXT"
    && record.requestAuthority.expectedReadVersion === "HOST_RESOLVED_FROM_TRUSTED_CONTEXT; never caller-supplied"
    && record.resultSchema.additionalProperties === undefined
    && record.resultSchema.oneOf.every((branch) => branch.additionalProperties === false)
    && currentResult.additionalProperties === false
    && sameShape(normalizedCurrentResult, expectedSourceResult)
    && record.resultSchema.oneOf.length === 2
    && deniedResult.additionalProperties === false
    && sameShape([...deniedResult.required].sort(), expectedDeniedRequired)
    && sameShape(Object.keys(deniedResult.properties).sort(), expectedDeniedRequired)
    && deniedResult.properties.operationRef.const === "media.operation.action.inspect-job-retry-policy"
    && sameShape(deniedResult.properties.queryId, retryPolicyRead.requestSchema.properties.queryId)
    && deniedResult.properties.outcome.const === "DENIED"
    && deniedResult.properties.reasonCode.type === "string"
    && deniedResult.properties.reasonCode.minLength === 1
    && deniedResult.properties.reasonCode.maxLength === 128
    && sourceResultRequired.every((field) => currentResult.required.includes(field))
    && currentResult.properties.operationRef.const === "media.operation.action.inspect-job-retry-policy"
    && currentResult.properties.readAuthorityRef.enum?.[0] === retryPolicyRead.readAuthorityRefs[0]
    && JSON.stringify(currentResult.properties.observation) === JSON.stringify(sourceObservation)
    && currentResult.properties.currentness.enum?.join(",") === "CURRENT,STALE,UNKNOWN"
    && currentResult.properties.readVersion.scalarTypeRef.endsWith("/opaque-version-id")
    && currentResult.properties.requestFingerprint.pattern === "^sha256:[a-f0-9]{64}$"
    && observedBranch?.required.includes("jobVersionRef")
    && observedBranch?.required.includes("attemptVersionRef")
    && observedBranch?.required.includes("policyVersionRef")
    && unknownBranch?.properties.kind.const === "UNKNOWN"
    && deniedResult.properties.outcome.const === "DENIED"
    && !deniedResult.properties.observation
    && record.sourceGuards.length === 3
    && /STALE or UNKNOWN/u.test(record.sourceRecovery)
    && /never infer dispatch or reserve an attempt/u.test(record.sourceRecovery)
    && record.semantics.effectKind === "READ_ONLY_OBSERVATION"
    && record.semantics.unknownIsNotSuccess === true
    && /READ_ONLY_QUERY/u.test(record.semantics.idempotency)
    && /never provider-effect/u.test(record.semantics.finality)
    && /DENIED returns no policy observation/u.test(record.semantics.errorSemantics)
    && /STALE and UNKNOWN/u.test(record.semantics.errorSemantics)
    && /reacquire current trusted read context/u.test(record.semantics.recovery)
    && record.semantics.runtimeAdmission === "NOT_ADMITTED";
}

test("operation-only retry-policy wire contract binds exact inputs and typed current-read semantics", () => {
  const record = wire.records.find(({ id }) => id === protectedQueryId);
  const operation = operationById.get("media.operation.action.inspect-job-retry-policy");
  assert.ok(retryPolicyRead, "the exact owner observation contract remains available");
  assert.ok(operation, "the operation-only query remains a canonical operation");
  assert.equal(operation.operationKind, "QUERY");
  assert.equal(operation.executionAdmission, "NOT_ADMITTED");
  assert.equal(record.actionRef, null, "the owner query does not acquire a fabricated UI action");
  assert.deepEqual(record.sourceRequiredProperties, ["queryId", "jobId", "priorAttemptId"]);
  assert.deepEqual(record.allowedSubjectObjectRefs, ["media.domain.processing-job", "media.domain.job-attempt"]);
  assert.equal(retryPolicyWireIsSourceBound(record), true);
});

test("retry-policy wire rejects omitted selectors, caller authority/version, weakened versioning, and unsafe unknown recovery", () => {
  const record = wire.records.find(({ id }) => id === protectedQueryId);
  const mutations = [
    (copy) => { copy.requestSchema.required = copy.requestSchema.required.filter((field) => field !== "jobId"); },
    (copy) => { copy.requestSchema.properties.tenantScopeRef = { type: "string" }; },
    (copy) => { copy.requestAuthority.expectedReadVersion = "CALLER_SUPPLIED"; },
    (copy) => { copy.resultSchema.oneOf[0].required = copy.resultSchema.oneOf[0].required.filter((field) => field !== "readVersion"); },
    (copy) => { copy.resultSchema.oneOf[0].properties.observation = { type: "object", additionalProperties: true }; },
    (copy) => { copy.sourceRecovery = "UNKNOWN means retry the command immediately"; },
    (copy) => { copy.semantics.finality = "provider effect completed"; },
    (copy) => { copy.semantics.idempotency = "retry command is safe after unknown"; },
    (copy) => { copy.semantics.errorSemantics = "UNKNOWN means success"; },
    (copy) => { copy.resultSchema.oneOf[1].properties.outcome.const = "UNKNOWN"; },
    (copy) => { copy.actionRef = "media.action.inspect-job-retry-policy"; },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(record);
    mutate(copy);
    assert.equal(retryPolicyWireIsSourceBound(copy), false);
  }
});
