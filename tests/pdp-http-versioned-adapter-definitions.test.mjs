import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import {
  canonicalProjectionTargetErrors,
  validateCanonicalHttpRequestBoundary,
  validateCanonicalHttpResultBoundary,
} from "../scripts/lib/pdp-http-canonical-envelope-validation.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const adaptersPath = ".product-experience/pdp-2-design-interface-system/api/http-canonical-adapters.yaml";
const adapters = readYaml(adaptersPath);
const apiConventions = readYaml(".product-experience/pdp-2-design-interface-system/api/conventions.yaml");
const parity = readYaml(".product-experience/interface-parity/operation-parity.yaml");
const operations = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");
const openApi = readYaml("contracts/openapi/media.yaml");

const expected = new Map([
  ["grantMediaConsent", "media.operation.consent-record-grant.v1"],
  ["listMediaConsents", "media.operation.consent-record-list.v1"],
  ["getMediaConsent", "media.operation.consent-record-inspect.v1"],
  ["revokeMediaConsent", "media.operation.action.revoke-authorized-consent"],
  ["submitMediaJob", "media.operation.job.submit.v1"],
  ["listMediaJobs", "media.operation.job-list.v1"],
  ["getMediaJob", "media.operation-slice.inspect-job"],
  ["cancelMediaJob", "media.operation-slice.cancel-job"],
  ["openMediaStream", "media.operation.capability.media-stream-session-open"],
  ["getMediaStream", "media.operation.stream-session.inspect.v1"],
  ["connectMediaStream", "media.operation.capability.media-stream-session-connect"],
  ["submitMediaStreamFrame", "media.operation.capability.media-stream-frame-submit"],
  ["closeMediaStream", "media.operation.capability.media-stream-session-close"],
]);

function resolveRef(ref) {
  if (typeof ref !== "string" || !ref.includes("#")) return undefined;
  const [file, pointer] = ref.split("#", 2);
  const document = file === adaptersPath ? adapters
    : file === ".product-experience/pdp-1-domain-data/operations.yaml" ? operations
      : file === "contracts/openapi/media.yaml" ? openApi
        : undefined;
  if (!document) return undefined;
  return pointer.split("/").filter(Boolean).reduce((value, token) => {
    const id = token.match(/^@id=(.*)$/u);
    if (id) return Array.isArray(value) ? value.find((entry) => entry.id === id[1]) : undefined;
    const key = token.replace(/~1/gu, "/").replace(/~0/gu, "~");
    return value?.[key];
  }, document);
}

function operationSource(record) {
  const match = record.sourceRef.match(/#\/paths\/(.*)\/(get|post|put|delete)$/u);
  if (!match) return undefined;
  const path = match[1].replace(/~1/gu, "/").replace(/~0/gu, "~");
  return openApi.paths?.[path]?.[match[2]];
}

function operationRecords() {
  return [
    ...(operations.operations ?? []),
    ...(operations.individualOperationContracts?.records ?? []),
    ...(operations.ownerDefinedOperationContracts?.records ?? []),
    ...(operations.capabilityOperationContracts?.records ?? []),
  ];
}

function schemaSample(schema, rootSchema = schema) {
  if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/")) {
    const target = schema.$ref.slice(2).split("/").map((token) => token.replace(/~1/gu, "/").replace(/~0/gu, "~"))
      .reduce((value, key) => value?.[key], rootSchema);
    assert.ok(target, `sample resolver finds ${schema.$ref}`);
    return schemaSample(target, rootSchema);
  }
  if (schema.const !== undefined) return structuredClone(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length) return structuredClone(schema.enum[0]);
  if (schema.oneOf?.length) return schemaSample(schema.oneOf[0], rootSchema);
  if (schema.anyOf?.length) return schemaSample(schema.anyOf[0], rootSchema);
  if (schema.allOf?.length) {
    const own = { ...schema };
    delete own.allOf;
    const base = schemaSample(own, rootSchema);
    const value = base && typeof base === "object" && !Array.isArray(base) ? base : {};
    for (const branch of schema.allOf) {
      const next = schemaSample(branch, rootSchema);
      if (next && typeof next === "object" && !Array.isArray(next)) Object.assign(value, next);
    }
    return value;
  }
  if (schema.type === "object" || schema.properties) {
    const value = {};
    for (const key of schema.required ?? []) value[key] = schemaSample(schema.properties?.[key] ?? {}, rootSchema);
    return value;
  }
  if (schema.type === "array" || schema.items || schema.minItems !== undefined) {
    return Array.from({ length: schema.minItems ?? 0 }, () => schemaSample(schema.items ?? {}, rootSchema));
  }
  if (Array.isArray(schema.type)) {
    if (schema.type.includes("null")) return null;
    return schemaSample({ ...schema, type: schema.type[0] }, rootSchema);
  }
  if (schema.type === "string") {
    if (schema.format === "date-time") return "2026-10-09T12:00:00Z";
    if (schema.pattern) {
      const candidates = ["id-1", "tenant-1", "v1", "en-US", "application/json", "image/png", "video/mp4", "sha256:" + "a".repeat(64), "2026-10-09T12:00:00Z"];
      const match = candidates.find((candidate) => new RegExp(schema.pattern, "u").test(candidate));
      if (match) return match;
      throw new Error(`No sample satisfies schema pattern ${schema.pattern}`);
    }
    return "sample-ref".slice(0, schema.maxLength ?? 64).padEnd(schema.minLength ?? 1, "x");
  }
  if (schema.type === "integer" || schema.type === "number") return schema.minimum ?? 1;
  if (schema.type === "boolean") return false;
  if (schema.type === "null") return null;
  return {};
}

function conditionMatches(schema, value) {
  if (schema.required?.some((key) => value?.[key] === undefined)) return false;
  for (const [key, condition] of Object.entries(schema.properties ?? {})) {
    if (condition.const !== undefined && value?.[key] !== condition.const) return false;
    if (Array.isArray(condition.enum) && !condition.enum.includes(value?.[key])) return false;
  }
  return true;
}

function applyConditionalSamples(schema, value, rootSchema = schema) {
  for (const branch of schema.allOf ?? []) {
    if (branch.if && branch.then && conditionMatches(branch.if, value)) {
      for (const [key, child] of Object.entries(branch.then.properties ?? {})) {
        if ((child.type === "array" || child.items || child.minItems !== undefined) && Array.isArray(value[key])) {
          const sampled = Array.from({ length: child.minItems ?? 0 }, () => schemaSample(child.items ?? {}, rootSchema));
          value[key] = [...value[key], ...sampled].slice(0, Math.max(value[key].length, child.minItems ?? 0));
        } else if (value[key] === undefined) value[key] = schemaSample(child, rootSchema);
      }
    }
    applyConditionalSamples(branch, value, rootSchema);
  }
  return value;
}

function canonicalEnvelopeValidators(record) {
  const requestSchema = resolveRef(record.canonicalRequestSchemaRef);
  const resultSchema = resolveRef(record.canonicalResultSchemaRef);
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true, logger: false });
  addFormats(ajv);
  const scalarTypes = operations.capabilityOperationContracts.scalarTypeRecords ?? [];
  const definitionsByFormat = new Map(scalarTypes
    .filter(({ validator }) => validator?.format)
    .map(({ validator }) => [validator.format, validator]));
  const formats = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.format === "string") formats.add(node.format);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(requestSchema);
  visit(resultSchema);
  for (const format of formats) {
    if (ajv.formats?.[format]) continue;
    const definition = definitionsByFormat.get(format);
    assert.ok(definition, `custom format ${format} has an exact Media scalar type definition`);
    const pattern = definition.pattern ?? "^\\S(?:[\\s\\S]*\\S)?$";
    ajv.addFormat(format, new RegExp(pattern, "u"));
  }
  ajv.addSchema(requestSchema, "urn:media:http-owner-request-schema:v1");
  ajv.addSchema(resultSchema, "urn:media:http-owner-result-schema:v1");
  return {
    request: ajv.compile(adapters.canonicalEnvelope.request),
    result: ajv.compile(adapters.canonicalEnvelope.result),
    ownerRequest: ajv.compile(requestSchema),
    ownerResult: ajv.compile(resultSchema),
  };
}

function hostContextMatches(asserted, trusted) {
  return ["tenantId", "principalId", "authorityRef"].every((key) => asserted?.[key] === trusted?.[key]);
}

function alignRepeatedFacts(value, facts) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(facts, key)) value[key] = facts[key];
    }
  }
  return value;
}

function hasOnlyClosedObjects(schema, path = "$") {
  if (!schema || typeof schema !== "object") return [`${path}: missing schema`];
  const errors = [];
  if (schema.type === "object" && schema.additionalProperties !== false) {
    const typedJsonValue = schema.additionalProperties && typeof schema.additionalProperties === "object"
      && schema.additionalProperties.$ref === "#/$defs/jsonValue";
    if (!typedJsonValue) errors.push(`${path}: object is not closed or recursively typed JSON`);
  }
  for (const [key, value] of Object.entries(schema.properties ?? {})) errors.push(...hasOnlyClosedObjects(value, `${path}.${key}`));
  for (const [key, branches] of [["oneOf", schema.oneOf], ["anyOf", schema.anyOf], ["allOf", schema.allOf]]) {
    for (const [index, branch] of (branches ?? []).entries()) errors.push(...hasOnlyClosedObjects(branch, `${path}.${key}[${index}]`));
  }
  if (schema.items) errors.push(...hasOnlyClosedObjects(schema.items, `${path}[]`));
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    errors.push(...hasOnlyClosedObjects(schema.additionalProperties, `${path}{value}`));
  }
  return errors;
}

function finitePropertyValues(schema, name, values = new Set()) {
  if (!schema || typeof schema !== "object") return values;
  const property = schema.properties?.[name];
  if (property?.const !== undefined) values.add(property.const);
  for (const value of property?.enum ?? []) values.add(value);
  for (const keyword of ["oneOf", "anyOf", "allOf"]) {
    for (const branch of schema[keyword] ?? []) finitePropertyValues(branch, name, values);
  }
  if (schema.then) finitePropertyValues(schema.then, name, values);
  if (schema.else) finitePropertyValues(schema.else, name, values);
  return values;
}

function dynamicSchemaAssessmentErrors(record, assessment = parity.typedHttpCanonicalAdapterAssessments.records
  .find((candidate) => candidate.identity === record.identity)?.canonicalSchemaDynamicObjectAssessment) {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (record.identity !== "submitMediaJob") return assessment ? ["dynamic schema exception is only valid for submitMediaJob"] : [];
  if (!assessment) return ["exact source-backed dynamic schema assessment is required"];
  if (assessment.status !== "SOURCE_SCHEMA_USES_TYPED_DYNAMIC_JSON; EXACT_TARGET_RESOLVER_REQUIRED; runtimeAdmission: NOT_ADMITTED") fail("dynamic schema status or admission changed");
  const request = resolveRef(assessment.canonicalRequestSchemaRef);
  if (!request || assessment.canonicalRequestSchemaRef !== record.canonicalRequestSchemaRef) fail("dynamic schema assessment must bind the exact canonical request schema");
  const validator = resolveRef(assessment.validatorRef);
  const parameterRule = resolveRef(assessment.parameterRuleRef);
  if (!validator || !parameterRule) fail("dynamic resolver and parameter binding rules must resolve");
  const expectedRequiredBefore = ["request-fingerprint", "durable-acceptance", "audit-intent-commit", "provider-dispatch"];
  if (JSON.stringify(assessment.requiredBefore) !== JSON.stringify(expectedRequiredBefore)
      || JSON.stringify(parameterRule?.definitionValidator?.requiredBefore) !== JSON.stringify(expectedRequiredBefore)) fail("dynamic parameter resolution must precede all exact effect boundaries");
  const expected = {
    "$.directRequestFields": ["directRequestFields", "dynamicObjects:direct"],
    "$.parameters": ["parameters", "dynamicObjects:parameters"],
  };
  const jsonValue = request?.$defs?.jsonValue;
  if (!jsonValue || !jsonValue.oneOf?.some((branch) => branch.type === "object"
      && branch.additionalProperties?.$ref === "#/$defs/jsonValue")
      || !jsonValue?.oneOf?.some((branch) => branch.type === "array"
        && branch.items?.$ref === "#/$defs/jsonValue")) fail("dynamic values must use recursively typed JSON, not unconstrained YAML/JavaScript values");
  if (assessment.dynamicObjects?.length !== 2) fail("only the two owner-defined dynamic schema fields may remain open");
  const byPath = new Map((assessment.dynamicObjects ?? []).map((row) => [row.path, row]));
  if (JSON.stringify([...byPath.keys()].sort()) !== JSON.stringify(Object.keys(expected).sort())) fail("dynamic schema path set differs from the exact owner request fields");
  for (const [path, [field]] of Object.entries(expected)) {
    const entry = byPath.get(path);
    const schema = request?.properties?.[field];
    if (!entry || !schema || schema.type !== "object" || schema.additionalProperties?.$ref !== "#/$defs/jsonValue") {
      fail(`${path}: exact recursive typed-JSON source schema must be recorded`);
      continue;
    }
    if (entry.additionalPropertiesSchemaRef !== schema.additionalProperties.$ref) fail(`${path}: typed-JSON value schema ref differs from source`);
    if (path === "$.directRequestFields" && (schema.maxProperties !== entry.maxProperties || entry.maxProperties !== 32)) fail("directRequestFields bound differs from source schema");
    if (!entry.targetSchemaRule?.includes("targetRequestSchemaRef") && path === "$.directRequestFields") fail(`${path}: resolver must select the exact target request schema`);
    if (!entry.targetSchemaRule?.includes("exact selected target operation schema") && path === "$.parameters") fail(`${path}: resolver must select the exact target parameter schema`);
    if (!entry.rejection?.includes("reject") || !entry.selectorRule?.includes("exact")) fail(`${path}: rejection and exact selector semantics are required`);
  }
  const typedRules = validator?.directFieldAdapters ?? [];
  if (typedRules.length !== 2 || typedRules.some((rule) => !resolveRef(rule.targetRequestSchemaRef)
      || !rule.directFields?.length || !rule.validation?.includes("before fingerprinting"))) {
    fail("direct field adapters must resolve exact target request schemas and validate before fingerprinting");
  }
  if (!assessment.parameterRuleRef?.endsWith("/parameterBindingRule")
      || !assessment.dynamicObjects.find(({ path }) => path === "$.parameters")?.targetSchemaRule?.includes("requestSchema.properties.parameters")) {
    fail("parameters must bind only to the selected operation parameter schema");
  }
  return errors;
}

function validateAdapterSet(records) {
  const identities = records.map((record) => record.identity);
  assert.equal(new Set(identities).size, identities.length, "duplicate HTTP adapter identity");
  const stableIds = records.map((record) => record.id);
  assert.ok(stableIds.every((id) => /^media\.http\.adapter\.[a-z0-9-]+\.v2$/u.test(id)), "every adapter has a stable Media obligation identity");
  assert.equal(new Set(stableIds).size, stableIds.length, "duplicate stable HTTP adapter identity");
  assert.deepEqual([...identities].sort(), [...expected.keys()].sort(), "adapter population must equal the exact 13-route cohort");
  const opById = new Map(operationRecords().map((record) => [record.id ?? record.operationRef, record]));
  for (const record of records) {
    assert.equal(record.canonicalOperationRef, expected.get(record.identity), `${record.identity}: wrong canonical operation`);
    assert.equal(record.canonicalHttpOperation?.operationRef, record.canonicalOperationRef);
    assert.match(record.canonicalHttpOperation?.path ?? "", /^\/api\/v2\//u, `${record.identity}: canonical HTTP path must be versioned`);
    assert.ok(["GET", "POST", "DELETE"].includes(record.canonicalHttpOperation?.method), `${record.identity}: method must be explicit`);
    assert.equal(record.envelopeBindings?.requestPayloadField, "ownerRequest");
    assert.equal(record.envelopeBindings?.resultPayloadField, "ownerResult");
    assert.equal(record.envelopeBindings?.requestSchemaRef, record.canonicalRequestSchemaRef);
    assert.equal(record.envelopeBindings?.resultSchemaRef, record.canonicalResultSchemaRef);
    const sourceOperation = operationSource(record);
    assert.ok(sourceOperation, `${record.identity}: source route does not resolve`);
    assert.equal(sourceOperation.operationId, record.identity, `${record.identity}: source route points at another operation`);
    assert.ok(resolveRef(record.sourceResultSchemaRef), `${record.identity}: source result ref does not resolve`);
    if (record.sourceRequestSchemaRef) assert.ok(resolveRef(record.sourceRequestSchemaRef), `${record.identity}: source request ref does not resolve`);
    const requestSchema = resolveRef(record.canonicalRequestSchemaRef);
    const resultSchema = resolveRef(record.canonicalResultSchemaRef);
    assert.ok(requestSchema, `${record.identity}: canonical request schema ref does not resolve`);
    assert.ok(resultSchema, `${record.identity}: canonical result schema ref does not resolve`);
    if (record.identity === "submitMediaJob") {
      assert.deepEqual(hasOnlyClosedObjects(requestSchema), [], "submitMediaJob dynamic JSON values are recursively typed");
      assert.deepEqual(dynamicSchemaAssessmentErrors(record), [], "submitMediaJob records exact resolver and negative semantics for both generic objects");
      const recursiveJson = requestSchema.$defs?.jsonValue;
      assert.ok(recursiveJson?.oneOf?.some((branch) => branch.type === "object" && branch.additionalProperties?.$ref === "#/$defs/jsonValue"));
      assert.ok(recursiveJson?.oneOf?.some((branch) => branch.type === "array" && branch.items?.$ref === "#/$defs/jsonValue"));
    } else {
      assert.deepEqual(hasOnlyClosedObjects(requestSchema), [], `${record.identity}: canonical request schema must be closed`);
      assert.deepEqual(dynamicSchemaAssessmentErrors(record), [], `${record.identity}: no generic-open schema exception is admitted`);
    }
    assert.deepEqual(hasOnlyClosedObjects(resultSchema), [], `${record.identity}: canonical result schema must be closed`);
    assert.deepEqual(canonicalProjectionTargetErrors(record, requestSchema, adapters.canonicalEnvelope.request), [],
      `${record.identity}: every positive source projection resolves against the exact owner request or host envelope schema`);
    if (record.identity !== "revokeMediaConsent") {
      const owner = opById.get(record.canonicalOperationRef);
      assert.ok(owner, `${record.identity}: exact canonical owner operation is absent`);
      const expectedRequest = owner.ownerWireSchema?.requestSchema ?? owner.requestSchema;
      const expectedResult = owner.ownerWireSchema?.resultSchema ?? owner.resultSchema;
      assert.deepEqual(requestSchema, expectedRequest, `${record.identity}: canonical request ref must bind the exact owner schema`);
      assert.deepEqual(resultSchema, expectedResult, `${record.identity}: canonical result ref must bind the exact owner schema`);
    } else {
      assert.ok(record.ownerSemanticContractRefs?.length === 2, "revoke adapter must retain exact action semantics source refs");
      for (const sourceRef of record.ownerSemanticContractRefs) assert.ok(resolveRef(sourceRef), `revoke owner semantic ref does not resolve: ${sourceRef}`);
    }
    assert.ok(record.sourceProjection && Object.keys(record.sourceProjection).length > 0);
    if (record.sourceRequestSchemaRef?.includes("/components/schemas/")) {
      const sourceRequest = resolveRef(record.sourceRequestSchemaRef);
      const projectedBodyFields = Object.keys(record.sourceProjection.body ?? {});
      assert.deepEqual(projectedBodyFields.sort(), Object.keys(sourceRequest.properties ?? {}).sort(), `${record.identity}: every legacy request field needs a named projection or rejection`);
    }
    assert.ok((record.rejectBeforeEffect ?? record.rejectBeforeRead)?.length > 0, `${record.identity}: missing fail-closed projection rules`);
    assert.ok(record.legacyResultProjection?.disposition);
    assert.ok(record.legacyResultProjection?.canonicalRequiredButUnrepresentable?.length > 0);
    const ownerOutcomeValues = [...finitePropertyValues(resultSchema, "outcome")];
    if (ownerOutcomeValues.length) {
      assert.equal(record.resultOutcomeBinding?.ownerOutcomeField, "outcome", `${record.identity}: owner outcome requires an explicit mapping`);
      for (const mapped of Object.values(record.resultOutcomeBinding.outerToOwnerValues ?? {}).flat()) {
        assert.ok(ownerOutcomeValues.includes(mapped), `${record.identity}: outcome binding maps to a value outside the exact result schema`);
      }
    } else {
      assert.equal(record.resultOutcomeBinding?.ownerOutcomeField, null, `${record.identity}: absent owner outcome must be explicit`);
      assert.equal(record.resultOutcomeBinding?.outerOutcomeSemantics, "ADAPTER_OBSERVATION_ONLY_NO_OWNER_OUTCOME_FIELD");
    }
    assert.match(record.routeDisposition, /NOT_ADMITTED|REJECT/u);
  }
  assert.equal(adapters.canonicalEnvelope.request.additionalProperties, false);
  assert.equal(adapters.canonicalEnvelope.result.additionalProperties, false);
}

test("all 13 observed HTTP routes have exact versioned canonical schemas and source-field adapter dispositions", () => {
  assert.equal(adapters.scopeBoundary.exactIdentityCount, 13);
  assert.equal(adapters.scopeBoundary.canonicalVersion, "media.http.canonical-envelope.v2");
  assert.equal(adapters.scopeBoundary.endpointActivation, "NOT_ADMITTED");
  assert.deepEqual([...new Map(adapters.records.map((record) => [record.identity, record.canonicalOperationRef]))], [...expected]);
  const parityRecords = parity.typedHttpCanonicalAdapterAssessments.records;
  for (const record of adapters.records) {
    const assessed = parityRecords.find((candidate) => candidate.identity === record.identity);
    assert.ok(assessed, `missing existing source assessment for ${record.identity}`);
    assert.equal(assessed.canonicalOperationRef, record.canonicalOperationRef);
  }
  validateAdapterSet(adapters.records);
  assert.ok(apiConventions.sourceRefs.includes(adaptersPath));
  assert.ok(apiConventions.relatedConventions.includes("http-canonical-adapters.yaml"));
  const rule = apiConventions.ownerDefinedProjectionRules.find(({ id }) => id === "media.api.http-v2-canonical-adapter-boundary.v1");
  assert.ok(rule?.rule.includes("missing authority, request identity, version, currentness, or finality rejects"));
  assert.match(rule?.scopeStatus ?? "", /endpoint activation, legacy adapter implementation, runtime parity, and independent acceptance remain open/u);
});

test("adapter validation rejects invented operation bindings, route admission, and lost material rejection rules", () => {
  const changedOperation = structuredClone(adapters.records);
  changedOperation.find((record) => record.identity === "grantMediaConsent").canonicalOperationRef = "media.operation.job-list.v1";
  assert.throws(() => validateAdapterSet(changedOperation), /wrong canonical operation/u);

  const admitted = structuredClone(adapters.records);
  admitted.find((record) => record.identity === "cancelMediaJob").routeDisposition = "ADMITTED";
  assert.throws(() => validateAdapterSet(admitted), /NOT_ADMITTED|REJECT/u);

  const droppedGuard = structuredClone(adapters.records);
  droppedGuard.find((record) => record.identity === "revokeMediaConsent").rejectBeforeEffect = [];
  assert.throws(() => validateAdapterSet(droppedGuard), /fail-closed projection rules/u);

  const missingAuthorityGap = structuredClone(adapters.records);
  missingAuthorityGap.find((record) => record.identity === "grantMediaConsent").legacyResultProjection.canonicalRequiredButUnrepresentable = [];
  assert.throws(() => validateAdapterSet(missingAuthorityGap), /canonicalRequiredButUnrepresentable/u);

  const submit = adapters.records.find((record) => record.identity === "submitMediaJob");
  const dynamicAssessment = parity.typedHttpCanonicalAdapterAssessments.records
    .find((record) => record.identity === "submitMediaJob").canonicalSchemaDynamicObjectAssessment;
  const omittedTargetClosure = structuredClone(dynamicAssessment);
  omittedTargetClosure.dynamicObjects[0].targetSchemaRule = "accept unvalidated direct request values";
  assert.ok(dynamicSchemaAssessmentErrors(submit, omittedTargetClosure).some((error) => error.includes("exact target request schema")));

  const renamedOpenBag = structuredClone(dynamicAssessment);
  renamedOpenBag.dynamicObjects[1].path = "$.arbitraryCallerBag";
  assert.ok(dynamicSchemaAssessmentErrors(submit, renamedOpenBag).some((error) => error.includes("path set differs")));
});

test("Media HTTP source acceptance and acknowledgements cannot erase canonical authority or finality requirements", () => {
  assert.match(adapters.adapterRules.find((rule) => rule.id === "media.http.adapter-rule.no-effect-on-reject").rule, /rejects before mutation, dispatch, stream attachment, or frame acceptance/u);
  assert.match(adapters.records.find((record) => record.identity === "submitMediaJob").legacyResultProjection.rule, /202 to completed|accepted to durable queued/u);
  assert.match(adapters.records.find((record) => record.identity === "submitMediaStreamFrame").legacyResultProjection.rule, /never processing or artifact creation/u);
  assert.match(adapters.records.find((record) => record.identity === "revokeMediaConsent").legacyResultProjection.rule, /not authority-issued finality evidence/u);
  assert.equal(adapters.scopeBoundary.directRuntimeRouteEquivalence, "NOT_ESTABLISHED");
});

test("canonical HTTP envelopes validate a closed outer shape and the exact operation payload schemas", () => {
  const host = { tenantId: "tenant-a", principalId: "principal-a", authorityRef: "authz:owner-scope" };
  for (const adapter of adapters.records) {
    const requestSchema = resolveRef(adapter.canonicalRequestSchemaRef);
    const resultSchema = resolveRef(adapter.canonicalResultSchemaRef);
    const validate = canonicalEnvelopeValidators(adapter);
    const request = {
      operationRef: adapter.canonicalOperationRef,
      operationVersion: 1,
      requestId: `req-${adapter.identity}`,
      trustedContext: structuredClone(host),
      ownerRequest: alignRepeatedFacts(schemaSample(requestSchema, requestSchema), {
        ...host, operationRef: adapter.canonicalOperationRef, operationVersion: 1, requestId: `req-${adapter.identity}`,
      }),
    };
    const resultPayload = applyConditionalSamples(resultSchema, schemaSample(resultSchema, resultSchema), resultSchema);
    const result = {
      operationRef: adapter.canonicalOperationRef,
      operationVersion: 1,
      outcome: "SUCCEEDED",
      observedAt: "2026-10-09T12:00:00Z",
      authorityRef: host.authorityRef,
      ownerResult: alignRepeatedFacts(resultPayload, {
        operationRef: adapter.canonicalOperationRef, operationVersion: 1,
        observedAt: "2026-10-09T12:00:00Z", authorityRef: host.authorityRef,
        outcome: adapter.resultOutcomeBinding?.outerToOwnerValues?.SUCCEEDED?.[0] ?? "SUCCEEDED",
      }),
    };
    assert.equal(validate.request(request), true, `${adapter.identity} request: ${JSON.stringify(validate.request.errors)}`);
    assert.equal(validate.result(result), true, `${adapter.identity} result: ${JSON.stringify(validate.result.errors)} value=${JSON.stringify(result.ownerResult)}`);
  }

  const record = adapters.records.find(({ identity }) => identity === "listMediaConsents");
  const owner = operationRecords().find(({ id }) => id === record.canonicalOperationRef);
  assert.ok(owner?.requestSchema && owner?.resultSchema);
  assert.equal(adapters.canonicalEnvelope.request.required.includes("ownerRequest"), true);
  assert.equal(adapters.canonicalEnvelope.result.required.includes("ownerResult"), true);
  assert.equal(adapters.canonicalEnvelope.request.required.includes("payload"), false);
  assert.equal(adapters.canonicalEnvelope.result.required.includes("payload"), false);
  assert.equal(adapters.canonicalEnvelope.request.properties.ownerRequest.$ref, "urn:media:http-owner-request-schema:v1");
  assert.equal(adapters.canonicalEnvelope.result.properties.ownerResult.$ref, "urn:media:http-owner-result-schema:v1");

  const validate = canonicalEnvelopeValidators(record);
  const expectedHost = { tenantId: "tenant-a", principalId: "principal-a", authorityRef: "authz:read-consents" };
  const request = {
    operationRef: record.canonicalOperationRef,
    operationVersion: 1,
    requestId: "req-a",
    trustedContext: structuredClone(expectedHost),
    ownerRequest: alignRepeatedFacts(schemaSample(owner.requestSchema, owner.requestSchema), {
      ...expectedHost, operationRef: record.canonicalOperationRef, operationVersion: 1, requestId: "req-a",
    }),
  };
  const resultPayload = applyConditionalSamples(owner.resultSchema, schemaSample(owner.resultSchema, owner.resultSchema), owner.resultSchema);
  const result = {
    operationRef: record.canonicalOperationRef,
    operationVersion: 1,
    outcome: "SUCCEEDED",
    observedAt: "2026-10-09T12:00:00Z",
    authorityRef: expectedHost.authorityRef,
    ownerResult: alignRepeatedFacts(resultPayload, {
      operationRef: record.canonicalOperationRef, operationVersion: 1,
      observedAt: "2026-10-09T12:00:00Z", authorityRef: expectedHost.authorityRef,
      outcome: record.resultOutcomeBinding?.outerToOwnerValues?.SUCCEEDED?.[0] ?? "SUCCEEDED",
    }),
  };
  assert.equal(validate.request(request), true, JSON.stringify(validate.request.errors));
  assert.equal(validate.result(result), true, JSON.stringify(validate.result.errors));

  const wrongOuterField = structuredClone(request);
  wrongOuterField.payload = wrongOuterField.ownerRequest;
  delete wrongOuterField.ownerRequest;
  assert.equal(validate.request(wrongOuterField), false, "legacy payload key cannot satisfy the canonical ownerRequest binding");

  const unknownPayloadField = structuredClone(request);
  unknownPayloadField.ownerRequest.extraAuthority = "admin";
  assert.equal(validate.request(unknownPayloadField), false, "exact owner request schemas remain closed inside the envelope");

  const unknownResultField = structuredClone(result);
  unknownResultField.ownerResult.records.push({ tenantId: "tenant-a", unexpectedAuthority: true });
  assert.equal(validate.result(unknownResultField), false, "the owner result schema rejects untyped records");

  const callerBodyContext = structuredClone(request);
  callerBodyContext.ownerRequest.trustedContext = structuredClone(expectedHost);
  assert.equal(validate.request(callerBodyContext), false, "host context cannot be moved into the caller-owned body");

  const ownerValidator = canonicalEnvelopeValidators(record);
  const trustedBoundary = (candidate, attested) => validateCanonicalHttpRequestBoundary({
    envelope: candidate,
    hostAttestedContext: attested,
    validateEnvelope: ownerValidator.request,
    validateOwnerRequest: ownerValidator.ownerRequest,
    expectedOperationRef: record.canonicalOperationRef,
  });
  const trustedResult = trustedBoundary(request, expectedHost);
  assert.equal(trustedResult.ok, true, JSON.stringify(trustedResult));
  assert.deepEqual(trustedResult.hostContext, expectedHost, "host-only assembly uses the independent attestation input");
  const innerRequestIdMismatch = structuredClone(request);
  if (Object.hasOwn(innerRequestIdMismatch.ownerRequest, "requestId")) {
    innerRequestIdMismatch.ownerRequest.requestId = "req-another-operation";
    assert.deepEqual(trustedBoundary(innerRequestIdMismatch, expectedHost), { ok: false, reason: "OWNER_REQUEST_BINDING_MISMATCH" });
  }

  const mismatchedTrustedTuple = structuredClone(request);
  mismatchedTrustedTuple.trustedContext.tenantId = "tenant-attacker";
  assert.equal(validate.request(mismatchedTrustedTuple), true, "shape validity does not establish host trust");
  assert.deepEqual(trustedBoundary(mismatchedTrustedTuple, expectedHost), { ok: false, reason: "HOST_CONTEXT_MISMATCH" },
    "the actual boundary rejects a caller tuple that differs from host-attested context");
  const missingHost = trustedBoundary(request, { ...expectedHost, principalId: " " });
  assert.deepEqual(missingHost, { ok: false, reason: "HOST_CONTEXT_MISMATCH" }, "missing/blank host authority fails closed");
  const resultBoundary = (candidate) => validateCanonicalHttpResultBoundary({
    envelope: candidate,
    hostAttestedContext: expectedHost,
    validateEnvelope: ownerValidator.result,
    validateOwnerResult: ownerValidator.ownerResult,
    expectedOperationRef: record.canonicalOperationRef,
    resultOutcomeBinding: record.resultOutcomeBinding,
  });
  assert.equal(resultBoundary(result).ok, true, JSON.stringify(resultBoundary(result)));
  const innerAuthorityMismatch = structuredClone(result);
  if (Object.hasOwn(innerAuthorityMismatch.ownerResult, "authorityRef")) {
    innerAuthorityMismatch.ownerResult.authorityRef = "authz:different";
    assert.deepEqual(resultBoundary(innerAuthorityMismatch), { ok: false, reason: "OWNER_RESULT_BINDING_MISMATCH" });
  }
  assert.match(adapters.adapterRules.find(({ id }) => id === "media.http.adapter-rule.trusted-context").rule,
    /Body or header values are assertions only; a mismatch rejects and never replaces trusted context/u);
});

test("every HTTP source projection is schema-bound and invalid canonical paths fail closed", () => {
  for (const record of adapters.records) {
    const requestSchema = resolveRef(record.canonicalRequestSchemaRef);
    assert.deepEqual(canonicalProjectionTargetErrors(record, requestSchema, adapters.canonicalEnvelope.request), [], record.identity);
  }
  const broken = structuredClone(adapters.records.find(({ identity }) => identity === "listMediaConsents"));
  broken.sourceProjection.query.limit.canonical = "ownerRequest.notADeclaredField";
  assert.match(canonicalProjectionTargetErrors(broken, resolveRef(broken.canonicalRequestSchemaRef), adapters.canonicalEnvelope.request).join("\n"),
    /does not resolve in its bound schema/u);
  broken.sourceProjection.query.limit.canonical = null;
  broken.sourceProjection.query.limit.disposition = "EXACT_VALUE_OR_OWNER_DEFAULT";
  assert.match(canonicalProjectionTargetErrors(broken, resolveRef(broken.canonicalRequestSchemaRef), adapters.canonicalEnvelope.request).join("\n"),
    /explicit reject\/host-only disposition/u);
});

test("operation identities, idempotency and owner outcome meanings cannot diverge from the outer receipt", () => {
  const host = { tenantId: "tenant-a", principalId: "principal-a", authorityRef: "authz:submit" };
  const submit = adapters.records.find(({ identity }) => identity === "submitMediaJob");
  const submitOwner = operationRecords().find(({ id }) => id === submit.canonicalOperationRef);
  const submitValidators = canonicalEnvelopeValidators(submit);
  const submitRequest = {
    operationRef: submit.canonicalOperationRef,
    operationVersion: 1,
    requestId: "req-submit",
    trustedContext: structuredClone(host),
    ownerRequest: alignRepeatedFacts(schemaSample(submitOwner.ownerWireSchema.requestSchema, submitOwner.ownerWireSchema.requestSchema), {
      ...host, operationRef: submit.canonicalOperationRef, operationVersion: 1, requestId: "req-submit",
    }),
  };
  const submitBoundary = (candidate) => validateCanonicalHttpRequestBoundary({
    envelope: candidate,
    hostAttestedContext: host,
    validateEnvelope: submitValidators.request,
    validateOwnerRequest: submitValidators.ownerRequest,
    expectedOperationRef: submit.canonicalOperationRef,
  });
  assert.equal(submitBoundary(submitRequest).ok, true);
  const changedInnerRequestId = structuredClone(submitRequest);
  changedInnerRequestId.ownerRequest.requestId = "req-other";
  assert.deepEqual(submitBoundary(changedInnerRequestId), { ok: false, reason: "OWNER_REQUEST_BINDING_MISMATCH" });

  const grant = adapters.records.find(({ identity }) => identity === "grantMediaConsent");
  const grantValidators = canonicalEnvelopeValidators(grant);
  const grantOwner = operationRecords().find(({ id }) => id === grant.canonicalOperationRef);
  const grantResult = {
    operationRef: grant.canonicalOperationRef,
    operationVersion: 1,
    outcome: "SUCCEEDED",
    observedAt: "2026-10-09T12:00:00Z",
    authorityRef: host.authorityRef,
    ownerResult: alignRepeatedFacts(schemaSample(grantOwner.resultSchema, grantOwner.resultSchema), {
      operationRef: grant.canonicalOperationRef,
      operationVersion: 1,
      outcome: "GRANT_RECORDED",
      tenantId: host.tenantId,
      principalId: host.principalId,
      observedAt: "2026-10-09T12:00:00Z",
      authorityRef: host.authorityRef,
    }),
  };
  const grantBoundary = (candidate) => validateCanonicalHttpResultBoundary({
    envelope: candidate,
    hostAttestedContext: host,
    validateEnvelope: grantValidators.result,
    validateOwnerResult: grantValidators.ownerResult,
    expectedOperationRef: grant.canonicalOperationRef,
    resultOutcomeBinding: grant.resultOutcomeBinding,
  });
  assert.equal(grantBoundary(grantResult).ok, true, JSON.stringify(grantBoundary(grantResult)));
  const outerStatusConflict = structuredClone(grantResult);
  outerStatusConflict.outcome = "REJECTED";
  assert.deepEqual(grantBoundary(outerStatusConflict), { ok: false, reason: "OWNER_RESULT_OUTCOME_BINDING_MISMATCH" });
  const innerTenantConflict = structuredClone(grantResult);
  innerTenantConflict.ownerResult.tenantId = "tenant-other";
  assert.deepEqual(grantBoundary(innerTenantConflict), { ok: false, reason: "OWNER_RESULT_BINDING_MISMATCH" });
});
