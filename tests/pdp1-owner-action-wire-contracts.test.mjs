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
const qualityPolicy = read(".product-experience/pdp-0-product-truth/quality-policy.yaml");
const canonicalMetricRefs = new Set(qualityPolicy.metricDefinitions.map(({ id }) => id));

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

function candidateMetricPairResultExample() {
  const metricRef = qualityPolicy.metricDefinitions[0].id;
  const artifactVersion = (artifactId, versionId) => ({
    objectType: "media.domain.artifact-version",
    identity: { tenantId: "tenant-1", artifactId, versionId },
  });
  const original = artifactVersion("original", "v1");
  const candidate = artifactVersion("candidate", "v2");
  const sourceObservation = (observationRef) => ({
    observationRef,
    providerRef: "provider:review",
    metricRef,
    metricVersionRef: "metric-version:quality-v1",
    modalityRef: "media.modality.image-quality",
    methodRef: "media.method.quality-review",
    methodVersionRef: "media.method.quality-review:v1",
    applicability: "APPLICABLE",
    disposition: "PASS",
    evidenceRefs: [`evidence:${observationRef}:v1`],
    unitRef: "media.unit.score",
  });
  const scope = sourceObservation("observation:original");
  const candidateScope = { ...sourceObservation("observation:candidate"), providerRef: scope.providerRef };
  return {
    operationRef: "media.operation.action.compare-candidate-on-metric",
    actionRef: "media.action.compare-candidate-on-metric",
    outcome: "OBSERVED",
    requestId: "request:pair-result-fixture",
    originalArtifactVersionRef: original,
    candidateArtifactVersionRef: candidate,
    metricRefs: [metricRef],
    metricResults: [{
      metricRef,
      originalSide: { subjectArtifactVersionRef: original, status: "OBSERVED", currentness: "CURRENT", sourceObservation: scope },
      candidateSide: { subjectArtifactVersionRef: candidate, status: "OBSERVED", currentness: "CURRENT", sourceObservation: candidateScope },
      comparability: "SAME_DECLARED_SCOPE",
    }],
    observedAt: "2026-10-11T12:00:00Z",
  };
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
      const example = record.id === "media.owner-action-wire.compare-candidate-on-metric.v2" && index === 0
        ? candidateMetricPairResultExample()
        : schemaExample(branch, refRoot);
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

test("candidate metric pair uses exact versioned references and preserves ordered one-row-per-metric evidence", () => {
  const record = wire.records.find(({ id }) => id === "media.owner-action-wire.compare-candidate-on-metric.v2");
  const operation = operationById.get("media.operation.action.compare-candidate-on-metric");
  const pairContract = operations.ownerTypedObservationContracts.records
    .find(({ id }) => id === "media.observation-contract.candidate-metric-pair.v1");
  assert.ok(record);
  assert.ok(operation);
  assert.ok(pairContract);
  assert.equal(operation.contractVersion, 2);
  assert.match(record.supersessionNote, /Breaking semantic revision.*single-subject.*ordered, distinct original\/candidate ArtifactVersion pair/);
  assert.equal(operation.operationKind, "QUERY");
  assert.equal(record.semantics.runtimeAdmission, "NOT_ADMITTED");
  assert.deepEqual(operation.domainObjectRefs, ["media.domain.artifact-version"]);
  assert.deepEqual(record.allowedSubjectObjectRefs, ["media.domain.artifact-version"]);
  assert.equal(operation.resultSchemaRef,
    ".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.candidate-metric-pair.v1/resultSchema");
  assert.equal(record.semantics.pairedResultContractRef, operation.resultSchemaRef);
  assert.deepEqual(operation.resultSchema.fields, [
    "requestId", "originalArtifactVersionRef", "candidateArtifactVersionRef", "metricRefs", "metricResults", "observedAt",
  ]);
  assert.deepEqual(record.semantics.forbiddenDerivedClaims,
    ["delta", "direction", "threshold", "pass/fail", "aggregate", "rank", "winner", "improvement", "qualification"]);

  const artifactVersion = (artifactId, versionId) => ({
    objectType: "media.domain.artifact-version",
    identity: { tenantId: "tenant-1", artifactId, versionId },
  });
  const originalVersion = artifactVersion("original", "v1");
  const candidateVersion = artifactVersion("candidate", "v2");
  const request = {
    operationRef: record.requestSchema.properties.operationRef.const,
    actionRef: record.requestSchema.properties.actionRef.const,
    requestId: "request-1",
    originalArtifactVersionRef: originalVersion,
    candidateArtifactVersionRef: candidateVersion,
    metricRefs: ["QUALITY-METRIC-IMAGE-DEFECTS", "QUALITY-METRIC-VIDEO-CONTINUITY", "QUALITY-METRIC-AUDIO-DEFECTS"],
  };
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validateRequestSchema = ajv.compile({ $defs: wire.$defs, ...record.requestSchema });
  const sameArtifactVersionIdentity = (left, right) =>
    left?.objectType === right?.objectType
    && left?.identity?.tenantId === right?.identity?.tenantId
    && left?.identity?.artifactId === right?.identity?.artifactId
    && left?.identity?.versionId === right?.identity?.versionId;
  const distinctArtifactVersions = (value) => !sameArtifactVersionIdentity(
    value.originalArtifactVersionRef, value.candidateArtifactVersionRef);
  const resolveMetricRefs = (metricRefs) => Array.isArray(metricRefs)
    && metricRefs.every((metricRef) => canonicalMetricRefs.has(metricRef));
  const validateRequest = (value) => validateRequestSchema(value)
    && distinctArtifactVersions(value)
    && resolveMetricRefs(value.metricRefs);
  assert.equal(validateRequest(request), true, JSON.stringify(validateRequestSchema.errors));
  assert.equal(validateRequest({ ...request, requestId: undefined }), false, "requestId is required");
  assert.equal(validateRequest({ ...request, candidateArtifactVersionRef: undefined }), false, "one target is not a pair");
  assert.equal(validateRequest({ ...request, candidateArtifactVersionRef: originalVersion }), false,
    "equal exact ArtifactVersion references are rejected");
  const reorderedOriginalVersion = {
    identity: { versionId: "v1", artifactId: "original", tenantId: "tenant-1" },
    objectType: "media.domain.artifact-version",
  };
  assert.equal(validateRequest({ ...request, candidateArtifactVersionRef: reorderedOriginalVersion }), false,
    "equal canonical identities are rejected regardless of property order");
  assert.equal(validateRequest({ ...request, originalArtifactVersionRef: { ...originalVersion, objectType: "media.domain.artifact" } }), false,
    "wrong canonical objectType is rejected");
  assert.equal(validateRequest({ ...request, candidateArtifactVersionRef: { ...candidateVersion, identity: { tenantId: "tenant-1", artifactId: "candidate" } } }), false,
    "incomplete canonical ArtifactVersion identity is rejected");
  assert.equal(validateRequest({ ...request, legacySubjectRef: "artifact-version:original:v1" }), false, "legacy singular-subject requests are rejected");
  assert.equal(validateRequest({ ...request, extraArtifactVersionRef: "artifact-version:third:v3" }), false, "three-target requests are rejected");
  assert.equal(validateRequest({ ...request, metricRefs: [] }), false, "missing requested metrics are rejected");
  assert.equal(validateRequest({ ...request, metricRefs: [request.metricRefs[0], request.metricRefs[0]] }), false, "duplicate requested metrics are rejected");
  assert.equal(validateRequest({ ...request, metricRefs: ["QUALITY-METRIC-UNKNOWN"] }), false,
    "unknown metric identities are rejected by canonical registry resolution");

  const sourceObservation = (metricRef, observationRef) => ({
    observationRef,
    providerRef: "provider:quality-review",
    metricRef,
    metricVersionRef: "metric-version:quality-v1",
    modalityRef: "media.modality.image-quality",
    methodRef: "media.method.quality-review",
    methodVersionRef: "media.method.quality-review:v1",
    applicability: "APPLICABLE",
    disposition: "PASS",
    value: 0.82,
    unitRef: "media.unit.score",
    evidenceRefs: [`evidence:${observationRef}:v1`],
  });
  const observed = {
    operationRef: request.operationRef,
    actionRef: request.actionRef,
    outcome: "OBSERVED",
    requestId: request.requestId,
    originalArtifactVersionRef: request.originalArtifactVersionRef,
    candidateArtifactVersionRef: request.candidateArtifactVersionRef,
    metricRefs: [...request.metricRefs],
    metricResults: [
      {
        metricRef: request.metricRefs[0],
        originalSide: { subjectArtifactVersionRef: originalVersion, status: "OBSERVED", currentness: "CURRENT", sourceObservation: sourceObservation(request.metricRefs[0], "observation:original-quality") },
        candidateSide: { subjectArtifactVersionRef: candidateVersion, status: "NO_OBSERVATION", currentness: "CURRENT" },
        comparability: "UNKNOWN",
      },
      {
        metricRef: request.metricRefs[1],
        originalSide: { subjectArtifactVersionRef: originalVersion, status: "UNKNOWN", currentness: "UNKNOWN" },
        candidateSide: { subjectArtifactVersionRef: candidateVersion, status: "OBSERVED", currentness: "STALE", sourceObservation: sourceObservation(request.metricRefs[1], "observation:candidate-latency") },
        comparability: "UNKNOWN",
      },
      {
        metricRef: request.metricRefs[2],
        originalSide: { subjectArtifactVersionRef: originalVersion, status: "SUBJECT_NOT_FOUND", currentness: "UNKNOWN" },
        candidateSide: { subjectArtifactVersionRef: candidateVersion, status: "UNKNOWN", currentness: "UNKNOWN" },
        comparability: "UNKNOWN",
      },
    ],
    observedAt: "2026-10-11T12:00:00Z",
  };
  const validateResult = ajv.compile({ $defs: wire.$defs, ...record.resultSchema });
  assert.equal(validateResult(observed), true, JSON.stringify(validateResult.errors));
  assert.equal(validateResult({ ...observed, outcome: "NOT_COMPARABLE" }), false,
    "noncomparability is represented on metric rows, not as a result that drops observations");
  assert.equal(observed.metricResults[0].candidateSide.status, "NO_OBSERVATION", "missing side observation remains explicit");
  assert.equal(observed.metricResults[1].originalSide.status, "UNKNOWN", "unknown side observation remains explicit");
  assert.equal(observed.metricResults[2].originalSide.status, "SUBJECT_NOT_FOUND", "missing subject status remains explicit");
  assert.equal(observed.metricResults[0].originalSide.sourceObservation.observationRef, "observation:original-quality",
    "present raw source evidence and provenance remain attached to their side");

  assert.equal(validateResult({ ...observed, metricResults: [{ ...observed.metricResults[0], originalSide: { status: "UNKNOWN", currentness: "UNKNOWN", sourceObservation: sourceObservation(request.metricRefs[0], "synthetic") } }, observed.metricResults[1]] }), false,
    "sourceObservation cannot be synthesized for an UNKNOWN side");
  assert.equal(validateResult({ ...observed, metricResults: [{ ...observed.metricResults[0], originalSide: { status: "NO_OBSERVATION", currentness: "CURRENT", sourceObservation: sourceObservation(request.metricRefs[0], "synthetic") } }, observed.metricResults[1]] }), false,
    "sourceObservation cannot be synthesized for an absent side");
  assert.equal(validateResult({ ...observed, metricResults: [{ ...observed.metricResults[0], unreviewedWinner: "candidate" }, observed.metricResults[1]] }), false,
    "results reject derived or undeclared claims");

  const exactMetricCoverage = (requested, result) =>
    JSON.stringify(requested.metricRefs) === JSON.stringify(result.metricRefs)
    && result.metricResults.length === requested.metricRefs.length
    && result.metricResults.every((row, index) => row.metricRef === requested.metricRefs[index]);
  const scopeIdentityFields = ["providerRef", "metricRef", "metricVersionRef", "methodRef", "methodVersionRef", "unitRef"];
  const deriveMetricComparability = (row) => {
    const sides = [row.originalSide, row.candidateSide];
    if (sides.some((side) => side.status !== "OBSERVED" || side.currentness !== "CURRENT")) return "UNKNOWN";
    const [left, right] = sides.map((side) => side.sourceObservation);
    const exactCompleteTuple = scopeIdentityFields.every((field) =>
      typeof left?.[field] === "string" && left[field].length > 0
      && typeof right?.[field] === "string" && right[field].length > 0
      && left[field] === right[field]);
    return exactCompleteTuple ? "SAME_DECLARED_SCOPE" : "NOT_COMPARABLE";
  };
  const validateMetricComparability = (row) => row.comparability === deriveMetricComparability(row);
  const validateCompleteResult = (requested, result) => validateResult(result)
    && exactMetricCoverage(requested, result)
    && result.requestId === requested.requestId
    && sameArtifactVersionIdentity(result.originalArtifactVersionRef, requested.originalArtifactVersionRef)
    && sameArtifactVersionIdentity(result.candidateArtifactVersionRef, requested.candidateArtifactVersionRef)
    && resolveMetricRefs(requested.metricRefs)
    && resolveMetricRefs(result.metricRefs)
    && result.metricResults.every((row) =>
      sameArtifactVersionIdentity(row.originalSide.subjectArtifactVersionRef, requested.originalArtifactVersionRef)
      && sameArtifactVersionIdentity(row.candidateSide.subjectArtifactVersionRef, requested.candidateArtifactVersionRef)
      && [row.originalSide, row.candidateSide].every((side) =>
        side.sourceObservation === undefined || (canonicalMetricRefs.has(side.sourceObservation.metricRef)
          && side.sourceObservation.metricRef === row.metricRef))
      && validateMetricComparability(row));
  assert.equal(validateCompleteResult(request, observed), true);
  assert.equal(validateCompleteResult(request, { ...observed, metricRefs: ["QUALITY-METRIC-UNKNOWN", ...request.metricRefs.slice(1)] }), false,
    "unknown result metric identities are rejected");
  assert.equal(validateCompleteResult(request, {
    ...observed,
    metricResults: [{
      ...observed.metricResults[0],
      originalSide: { ...observed.metricResults[0].originalSide, sourceObservation: { ...observed.metricResults[0].originalSide.sourceObservation, metricRef: "QUALITY-METRIC-UNKNOWN" } },
    }, ...observed.metricResults.slice(1)],
  }), false, "source observation metricRef must resolve and match its row and request metric");
  assert.equal(validateCompleteResult(request, { ...observed, requestId: "other-request" }), false,
    "result requestId must echo the exact requestId");
  assert.equal(validateCompleteResult(request, {
    ...observed,
    originalArtifactVersionRef: reorderedOriginalVersion,
    metricResults: observed.metricResults.map((row) => ({
      ...row,
      originalSide: { ...row.originalSide, subjectArtifactVersionRef: reorderedOriginalVersion },
    })),
  }), true, "identity echoes remain exact when canonical object keys are reordered");
  const makeObservedPairRow = (metricRef, originalEvidence, candidateEvidence, comparability) => ({
    metricRef,
    originalSide: { subjectArtifactVersionRef: originalVersion, status: "OBSERVED", currentness: "CURRENT", sourceObservation: originalEvidence },
    candidateSide: { subjectArtifactVersionRef: candidateVersion, status: "OBSERVED", currentness: "CURRENT", sourceObservation: candidateEvidence },
    comparability,
  });
  const replaceFirstMetricRow = (row) => ({ ...observed, metricResults: [row, ...observed.metricResults.slice(1)] });
  const exactScopeEvidence = sourceObservation(request.metricRefs[0], "observation:exact-scope");
  const sameScopeRow = makeObservedPairRow(request.metricRefs[0], exactScopeEvidence, { ...exactScopeEvidence }, "SAME_DECLARED_SCOPE");
  assert.equal(validateCompleteResult(request, replaceFirstMetricRow(sameScopeRow)), true,
    "both current observed sides with an exact complete tuple are comparable");

  for (const field of scopeIdentityFields) {
    const mismatchEvidence = { ...exactScopeEvidence, [field]: `${exactScopeEvidence[field]}:different` };
    const mismatchRow = makeObservedPairRow(request.metricRefs[0], exactScopeEvidence, mismatchEvidence, "NOT_COMPARABLE");
    const mismatchResult = replaceFirstMetricRow(mismatchRow);
    if (field === "metricRef") {
      assert.equal(validateCompleteResult(request, mismatchResult), false,
        "a source observation for another metric is rejected even though its scope tuple differs");
    } else {
      assert.equal(validateCompleteResult(request, mismatchResult), true, `${field} mismatch yields per-metric NOT_COMPARABLE with both sides retained`);
    }

    const missingEvidence = { ...exactScopeEvidence };
    delete missingEvidence[field];
    const missingRow = makeObservedPairRow(request.metricRefs[0], exactScopeEvidence, missingEvidence, "NOT_COMPARABLE");
    const missingResult = replaceFirstMetricRow(missingRow);
    if (["metricRef", "methodRef", "methodVersionRef"].includes(field)) {
      assert.equal(validateCompleteResult(request, missingResult), false,
        `quality-evidence.v1 requires ${field}; malformed observed evidence is rejected`);
    } else {
      assert.equal(validateCompleteResult(request, missingResult), true, `${field} missing yields per-metric NOT_COMPARABLE`);
    }
  }
  const contradictoryUnavailable = replaceFirstMetricRow({
    ...observed.metricResults[0], comparability: "NOT_COMPARABLE",
  });
  assert.equal(validateCompleteResult(request, contradictoryUnavailable), false,
    "NO_OBSERVATION plus NOT_COMPARABLE is rejected by complete-result validation");
  for (const resultIndex of [1, 2]) {
    for (const comparability of ["SAME_DECLARED_SCOPE", "NOT_COMPARABLE"]) {
      const invalidUnavailableResult = {
        ...observed,
        metricResults: observed.metricResults.map((row, index) => index === resultIndex
          ? { ...row, comparability }
          : row),
      };
      assert.equal(validateCompleteResult(request, invalidUnavailableResult), false,
        `${observed.metricResults[resultIndex].originalSide.status}/${observed.metricResults[resultIndex].candidateSide.currentness} cannot be labelled ${comparability}`);
    }
  }
  const validNonComparableRow = makeObservedPairRow(
    request.metricRefs[0], exactScopeEvidence,
    { ...exactScopeEvidence, providerRef: "provider:other" }, "NOT_COMPARABLE");
  assert.equal(validateCompleteResult(request, replaceFirstMetricRow(validNonComparableRow)), true,
    "NOT_COMPARABLE retains both current observed source sides when tuple fields mismatch");
  assert.equal(validateCompleteResult(request, { ...observed, metricResults: observed.metricResults.slice(0, 1) }), false,
    "the semantic result validator rejects a partial result");
  assert.equal(exactMetricCoverage(request, { ...observed, metricResults: observed.metricResults.slice(0, 2) }), false,
    "a missing metric result is rejected");
  assert.equal(exactMetricCoverage(request, { ...observed, metricRefs: request.metricRefs.slice(0, 2) }), false,
    "a missing result metric is rejected");
  assert.equal(exactMetricCoverage(request, { ...observed, metricRefs: [...request.metricRefs, "QUALITY-METRIC-UNKNOWN"] }), false,
    "an extra result metric is rejected");
  assert.equal(exactMetricCoverage(request, { ...observed, metricRefs: [request.metricRefs[0], request.metricRefs[0], request.metricRefs[2]] }), false,
    "a duplicate result metric is rejected");
  assert.equal(exactMetricCoverage(request, { ...observed, metricResults: [observed.metricResults[0], observed.metricResults[0], observed.metricResults[2]] }), false,
    "a duplicate metric result is rejected");
  assert.equal(exactMetricCoverage(request, { ...observed, metricResults: [...observed.metricResults, observed.metricResults[0]] }), false,
    "an extra metric result is rejected");
  assert.equal(exactMetricCoverage(request, { ...observed, metricResults: [...observed.metricResults].reverse() }), false,
    "metric result order must match the request");
  assert.equal(validateCompleteResult(request, { ...observed, candidateArtifactVersionRef: { ...candidateVersion, objectType: "media.domain.artifact" } }), false,
    "wrong result objectType is rejected");
  assert.equal(validateCompleteResult(request, { ...observed, originalArtifactVersionRef: { ...originalVersion, identity: { tenantId: "tenant-1", artifactId: "original" } } }), false,
    "incomplete result ArtifactVersion identity is rejected");
});

test("quality-evidence.v1 stays backward compatible and provider scope remains fail-closed", () => {
  const evidence = operations.ownerTypedObservationContracts.records
    .find(({ id }) => id === "media.observation-contract.quality-evidence.v1");
  const observation = evidence.resultSchema.properties.observations.items;
  assert.ok(observation.properties.observationRef);
  assert.ok(observation.properties.providerRef);
  assert.ok(observation.properties.metricVersionRef);
  for (const optionalField of ["observationRef", "providerRef", "metricVersionRef"]) {
    assert.equal(observation.required.includes(optionalField), false, `${optionalField} remains optional in v1`);
  }


});

test("J-28 spatial export is source-bound, report-complete, and distinct from delivery", () => {
  const operation = operationById.get("media.operation.spatial-export.execute.v1");
  assert.ok(operation, "J-28 has a canonical PDP-1 export command");
  assert.equal(operation.operationKind, "COMMAND");
  assert.equal(operation.workflowRef, "media.workflow-contract.spatial-export-boundary.v1");
  assert.ok(operation.sourceRefs.includes(".product-experience/pdp-0-product-truth/journey-catalog.yaml#/journeys/@id=J-28"));
  assert.ok(operation.requestSchema.required.includes("sourceArtifactVersionRef"));
  assert.ok(operation.requestSchema.required.includes("targetFormatProfileVersionRef"));
  assert.ok(operation.requestSchema.required.includes("lossPolicyRef"));
  assert.equal(operation.requestSchema.allOf.length, 2, "scene and rig exact versions are supplied together when applicable");
  assert.equal(operation.requestSchema.properties.sceneVersionRef.format, "opaque-versioned-reference");
  assert.equal(operation.requestSchema.properties.rigVersionRef.format, "opaque-versioned-reference");

  const report = operation.resultSchema.properties.export.properties.conversionReport;
  assert.deepEqual(report.required, [
    "sourceArtifactRef", "sourceArtifactVersionRef", "targetFormatProfileRef", "targetFormatProfileVersionRef",
    "sourceGeometryPlanRef", "coordinateTransformRef", "unitTransformRef", "axisTransformRef",
    "handednessDisposition", "originDisposition", "fieldDispositionRecords", "unsupportedFieldDisposition", "integrityEvidenceRef",
  ]);
  assert.deepEqual(report.properties.fieldDispositionRecords.items.properties.disposition.enum,
    ["PRESERVED", "TRANSFORMED", "OMITTED_WITH_EXPLICIT_LOSS", "REJECTED"]);
  assert.ok(operation.resultSchema.properties.export.required.includes("outputArtifactVersionRef"));
  assert.ok(operation.resultSchema.properties.export.required.includes("outputRegistrationResultRef"));
  assert.ok(operation.resultSchema.properties.export.required.includes("outputRegistrationReceiptRef"));
  assert.equal(operation.requestResultBindings[0].requireSeparateOutputRegistration,
    "media.operation.artifact.output.register.v1");
  const binding = operation.requestResultBindings[0];
  assert.deepEqual(binding.exactPairs, ["requestId"], "the result is joined to its exact request identity");
  assert.deepEqual(binding.exportExactPairs, [
    "sourceArtifactRef", "sourceArtifactVersionRef", "targetFormatProfileRef", "targetFormatProfileVersionRef", "sourceGeometryPlanRef",
  ], "the export echoes the exact requested source, target profile, and geometry plan tuple");
  assert.deepEqual(binding.reportExactPairs, binding.exportExactPairs,
    "the conversion report carries the same exact source, target profile, and geometry plan tuple");
  assert.equal(binding.outputVersionMustMatchRegistrationReceipt, true);
  assert.equal(binding.registrationResultMustResolveToSucceededResultForExactOperationAndRequest, true);
  assert.equal(binding.outputArtifactVersionRefMustEqualRegistrationPayloadArtifactIdAndVersionId, true,
    "the output version is the exact artifact identity/version in the registration result payload");
  assert.equal(binding.registrationSourceVersionRefsMustContainExactRequestSourceArtifactVersionRef, true,
    "the separate registration request includes this export request's exact source version");
  assert.equal(binding.registrationReceiptRefMustEqualResolvedRegistrationPayloadReceipt, true,
    "the export receipt reference is the exact receipt resolved from the registration result");
  assert.equal(binding.reportAndExportSourceTargetPlanTuplesMustEqualRequest, true,
    "both export and conversion report tuples are bound back to the request");
  assert.equal(binding.missingOrMismatch, "UNKNOWN_OUTCOME");
  assert.equal(binding.deliveryOrDestinationAcknowledgmentImplied, false);

  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
  const validate = ajv.compile(operation.resultSchema);
  const exported = Object.fromEntries(operation.resultSchema.required.map((name) =>
    [name, schemaExample(operation.resultSchema.properties[name], operation.resultSchema)]));
  exported.outcome = "EXPORTED";
  exported.operationRef = operation.id;
  exported.export = schemaExample(operation.resultSchema.properties.export, operation.resultSchema);
  assert.equal(validate(exported), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...exported, export: { ...exported.export, conversionReport: undefined } }), false,
    "an export without the complete loss/conversion report is rejected");
  assert.equal(validate({ ...exported, outcome: "UNKNOWN_OUTCOME", reasonRef: "reason:unknown" }), false,
    "unknown outcome cannot also claim a candidate output");
  const request = Object.fromEntries(operation.requestSchema.required.map((name) =>
    [name, schemaExample(operation.requestSchema.properties[name], operation.requestSchema)]));
  assert.equal(ajv.validate(operation.requestSchema, { ...request, sceneVersionRef: "scene:v1" }), false,
    "a scene version cannot be supplied without its rig version");
});

test("J-28 source binding rejects mismatched export and registration evidence", () => {
  const operation = operationById.get("media.operation.spatial-export.execute.v1");
  const binding = operation.requestResultBindings[0];
  const tupleFields = [...new Set([...binding.exportExactPairs, ...binding.reportExactPairs])];
  const request = Object.fromEntries(operation.requestSchema.required.map((name) =>
    [name, schemaExample(operation.requestSchema.properties[name], operation.requestSchema)]));
  request.requestId = "spatial-export-request-28";
  for (const field of tupleFields) request[field] = `request:${field}`;

  const report = Object.fromEntries(operation.resultSchema.properties.export.properties.conversionReport.required.map((name) =>
    [name, schemaExample(operation.resultSchema.properties.export.properties.conversionReport.properties[name],
      operation.resultSchema.properties.export.properties.conversionReport)]));
  const exportedResult = {
    outcome: "EXPORTED",
    operationRef: operation.id,
    requestId: request.requestId,
    resultDigest: `sha256:${"a".repeat(64)}`,
    observedAt: "2026-10-19T00:00:00Z",
    export: {
      ...Object.fromEntries(operation.resultSchema.properties.export.required
        .filter((name) => name !== "conversionReport")
        .map((name) => [name, schemaExample(operation.resultSchema.properties.export.properties[name],
          operation.resultSchema.properties.export)])),
      conversionReport: report,
    },
  };
  for (const field of tupleFields) {
    exportedResult.export[field] = request[field];
    exportedResult.export.conversionReport[field] = request[field];
  }

  const registrationRequest = {
    operationRef: binding.requireSeparateOutputRegistration,
    requestId: "registration-request-28",
    sourceVersionRefs: [request.sourceArtifactVersionRef],
  };
  const payload = {
    kind: "governed-artifact-reference",
    artifactId: "exported-artifact-28",
    versionId: "version-3",
    registrationReceiptRef: "receipt:registration-28",
  };
  const registrationResult = {
    outcome: "SUCCEEDED",
    operationRef: binding.requireSeparateOutputRegistration,
    operationVersion: 1,
    requestId: registrationRequest.requestId,
    outputs: [{ artifactType: "governed-artifact-reference-or-lifecycle-observation", payload }],
  };
  const registrationResultRef = "registration-result:28";
  const outputVersionRef = (artifactId, versionId) => `artifact-version:${artifactId}:${versionId}`;
  exportedResult.export.outputRegistrationResultRef = registrationResultRef;
  exportedResult.export.outputArtifactVersionRef = outputVersionRef(payload.artifactId, payload.versionId);
  exportedResult.export.outputRegistrationReceiptRef = payload.registrationReceiptRef;

  // Test-local evaluator for the declarative binding only; it is not a runtime implementation.
  const evaluateBinding = (candidate, resolvedRegistrationRef, resolvedRegistrationResult, resolvedRegistrationRequest) => {
    if (candidate.outcome !== binding.when || candidate.requestId !== request.requestId) return false;
    if (candidate.export.outputRegistrationResultRef !== resolvedRegistrationRef) return false;
    if (!resolvedRegistrationResult || resolvedRegistrationResult.outcome !== "SUCCEEDED"
      || resolvedRegistrationResult.operationRef !== binding.requireSeparateOutputRegistration
      || resolvedRegistrationResult.requestId !== resolvedRegistrationRequest?.requestId
      || resolvedRegistrationRequest.operationRef !== binding.requireSeparateOutputRegistration) return false;
    if (!resolvedRegistrationRequest.sourceVersionRefs.includes(request.sourceArtifactVersionRef)) return false;
    const outputs = resolvedRegistrationResult.outputs ?? [];
    if (outputs.length !== 1) return false;
    const registered = outputs[0]?.payload;
    if (!registered?.artifactId || !registered?.versionId || !registered?.registrationReceiptRef) return false;
    if (candidate.export.outputArtifactVersionRef !== outputVersionRef(registered.artifactId, registered.versionId)) return false;
    if (candidate.export.outputRegistrationReceiptRef !== registered.registrationReceiptRef) return false;
    return [...binding.exportExactPairs, ...binding.reportExactPairs]
      .every((field) => candidate.export[field] === request[field]
        && candidate.export.conversionReport[field] === request[field]);
  };

  assert.equal(evaluateBinding(exportedResult, registrationResultRef, registrationResult, registrationRequest), true,
    "the internally consistent positive fixture satisfies the declarative binding");
  assert.equal(evaluateBinding({ ...exportedResult, requestId: "different-request" }, registrationResultRef, registrationResult, registrationRequest), false,
    "a result cannot echo a different request ID");
  for (const field of tupleFields) {
    assert.equal(evaluateBinding({ ...exportedResult, export: { ...exportedResult.export, [field]: "foreign-value" } },
      registrationResultRef, registrationResult, registrationRequest), false, `export ${field} must exactly echo the request`);
    assert.equal(evaluateBinding({ ...exportedResult, export: { ...exportedResult.export,
      conversionReport: { ...exportedResult.export.conversionReport, [field]: "foreign-value" } },
    }, registrationResultRef, registrationResult, registrationRequest), false, `report ${field} must exactly echo the request`);
  }
  assert.equal(evaluateBinding({ ...exportedResult, export: { ...exportedResult.export,
    outputArtifactVersionRef: "artifact-version:other-artifact:version-3" } }, registrationResultRef, registrationResult, registrationRequest), false,
  "the output artifact version must match the registered artifact ID and version ID");
  assert.equal(evaluateBinding({ ...exportedResult, export: { ...exportedResult.export,
    outputRegistrationReceiptRef: "receipt:other-registration" } }, registrationResultRef, registrationResult, registrationRequest), false,
  "the export receipt reference must match the resolved registration payload receipt");
  assert.equal(evaluateBinding(exportedResult, "registration-result:unresolved", registrationResult, registrationRequest), false,
    "the output registration result reference must resolve to the supplied registration result");
  assert.equal(evaluateBinding(exportedResult, registrationResultRef, { ...registrationResult,
    outputs: [...registrationResult.outputs, ...registrationResult.outputs] }, registrationRequest), false,
  "duplicate registration outputs do not establish one exact registered output");
  for (const outcome of ["REJECTED", "UNKNOWN_OUTCOME"]) {
    assert.equal(evaluateBinding(exportedResult, registrationResultRef, { ...registrationResult, outcome }, registrationRequest), false,
      `${outcome} registration cannot substantiate an exported output`);
  }
  assert.equal(evaluateBinding(exportedResult, registrationResultRef, registrationResult,
    { ...registrationRequest, sourceVersionRefs: [] }), false,
  "registration must retain the exact source version from the export request");

  assert.equal(binding.deliveryOrDestinationAcknowledgmentImplied, false);
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
  const validateResult = ajv.compile(operation.resultSchema);
  assert.equal(validateResult({ ...exportedResult, export: { ...exportedResult.export,
    deliveryReceiptRef: "receipt:delivery" } }), false,
  "an export result cannot add a delivery receipt or destination acknowledgment claim");
});
