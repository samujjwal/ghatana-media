import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { addPdpTruthDomainKeywords, assertPdpTruthDomainSchemaKeywords } from "../scripts/lib/pdp-truth-domain-schema-validator.mjs";
import { resolveEffectiveOwnerLeafWireContract } from "../scripts/lib/pdp-owner-leaf-wire-validation.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const read = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const operations = read(".product-experience/pdp-1-domain-data/operations.yaml");
const contract = operations.capabilityOperationContracts;
const isSchemaType = (value) => ["object", "array", "string", "integer", "number", "boolean", "null"].includes(value);

function walk(value, visit, path = "$") {
  if (!value || typeof value !== "object") return;
  visit(value, path);
  for (const [key, child] of Object.entries(value)) walk(child, visit, `${path}.${key}`);
}

function example(schema) {
  if (schema.const !== undefined) return schema.const;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.oneOf) return example(schema.oneOf[0]);
  if (schema.anyOf && schema.type !== "object" && !schema.properties) return example(schema.anyOf[0]);
  if (schema.type === "object" || schema.properties) {
    const result = {};
    const required = new Set(schema.required ?? []);
    if (schema.anyOf?.[0]?.required) for (const key of schema.anyOf[0].required) required.add(key);
    for (const key of required) result[key] = example(schema.properties?.[key] ?? {});
    return result;
  }
  if (schema.allOf) return Object.assign({}, ...schema.allOf.map(example));
  if (schema.type === "array") return Array.from({ length: schema.minItems ?? 0 }, () => example(schema.items ?? {}));
  if (schema.type === "integer") return schema.minimum ?? 0;
  if (schema.type === "number") return schema.minimum ?? 0;
  if (schema.type === "boolean") return false;
  if (schema.type === "null") return null;
  if (schema.type === "string") {
    if (schema.pattern?.startsWith("^video/")) return "video/mp4";
    if (schema.pattern?.startsWith("^(?:image|video)/")) return "image/png";
    if (schema.format === "date-time") return "2026-10-08T12:00:00Z";
    if (schema.pattern?.includes("sha256:")) return `sha256:${"a".repeat(64)}`;
    if (schema.pattern?.includes("{64}")) return "a".repeat(64);
    if (schema.format === "bcp47-language-tag" || schema.pattern?.includes("A-Za-z]{2,8}")) return "en-US";
    if (schema.format === "iana-media-type" || schema.pattern?.includes("/[A-Za-z0-9")) return "application/octet-stream";
    if (schema.pattern) {
      for (const candidate of ["id-1", "v-1", "ref:one", "request-1", "input1", "parameter-1", "media.capability-bounds.profile-1", "media.typed-input.field-1", "x", "1.0.0", "P1D"]) {
        if (new RegExp(schema.pattern).test(candidate)) return candidate;
      }
      throw new Error(`No example satisfies pattern ${schema.pattern}`);
    }
    return "x".repeat(schema.minLength ?? 1);
  }
  return {};
}

function deleteDeepRequiredMaterial(schema, value, depth = 0) {
  if (!schema || value === null || typeof value !== "object") return false;
  if (schema.oneOf) return deleteDeepRequiredMaterial(schema.oneOf[0], value, depth);
  if (schema.anyOf && schema.anyOf[0]?.required) {
    for (const key of schema.anyOf[0].required) {
      if (Object.hasOwn(value, key) && deleteDeepRequiredMaterial(schema.properties?.[key], value[key], depth + 1)) return true;
      if (Object.hasOwn(value, key)) { delete value[key]; return true; }
    }
  }
  if (schema.type === "array" && value.length > 0) return deleteDeepRequiredMaterial(schema.items, value[0], depth + 1);
  if (schema.type === "object" || schema.properties) {
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key === "artifactType" || !Object.hasOwn(value, key)) continue;
      if (deleteDeepRequiredMaterial(child, value[key], depth + 1)) return true;
    }
    for (const key of schema.required ?? []) {
      if ((key === "artifactType" || (key === "payload" && depth === 0)) || !Object.hasOwn(value, key)) continue;
      delete value[key];
      return true;
    }
  }
  return false;
}

function buildAjv() {
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true });
  addFormats(ajv);
  addPdpTruthDomainKeywords(ajv);
  const formatValidators = new Map();
  for (const row of contract.scalarTypeRecords) {
    const format = row.validator.format;
    if (!format || format === "date-time") continue;
    const validator = row.validator.pattern ? new RegExp(row.validator.pattern) : () => true;
    formatValidators.set(format, validator);
  }
  for (const row of contract.records) {
    for (const schema of [row.requestSchema, row.resultSchema]) {
      assertPdpTruthDomainSchemaKeywords(ajv, schema);
      walk(schema, (node) => {
        if (typeof node.format !== "string" || ["date-time", "email", "uri", "uuid"].includes(node.format)) return;
        const registered = formatValidators.get(node.format);
        assert.ok(registered, `unsupported custom scalar format ${node.format} in ${row.id}`);
        if (!ajv.formats[node.format]) ajv.addFormat(node.format, registered);
      });
    }
  }
  return ajv;
}

function resolvedSchemas(row) {
  const effectiveWire = resolveEffectiveOwnerLeafWireContract(operations, row.capabilityRef);
  if (row.ownerLeafWireContractRef) {
    assert.equal(effectiveWire.valid, true, `${row.id} effective owner wire ref resolves through the production resolver`);
    assert.equal(effectiveWire.contract.id, row.ownerLeafWireContractRef, `${row.id} has exact owner overlay identity`);
    assert.equal(effectiveWire.contract.operationRef, row.id, `${row.id} overlay is bound to this canonical operation`);
    const request = structuredClone(effectiveWire.contract.requestSchema);
    const result = structuredClone(effectiveWire.contract.resultSchema);
    const item = result.properties?.outputs?.items;
    assert.ok(item, `${row.id} effective overlay declares its exact result output schema`);
    return { request, result, outputSchemas: [item], effectiveOwnerWire: effectiveWire.contract };
  }
  assert.equal(effectiveWire.reason, "OWNER_WIRE_OVERLAY_NOT_BOUND", `${row.id} remains on its canonical base schema`);
  const inputById = new Map(contract.inputPayloadSchemas.map((item) => [item.id, item]));
  const outputById = new Map(contract.outputPayloadSchemas.map((item) => [item.id, item]));
  const request = structuredClone(row.requestSchema);
  for (const slot of row.inputSlots) {
    const typed = inputById.get(slot.payloadSchemaRef);
    assert.ok(typed, `${row.id} unresolved input schema ${slot.payloadSchemaRef}`);
    const key = slot.slotId;
    assert.ok(request.properties[key], `${row.id} missing request slot ${key}`);
    request.properties[key] = structuredClone(typed.schema);
  }
  const result = structuredClone(row.resultSchema);
  const expectedTypes = row.successOutputs.map((output) => {
    const typed = outputById.get(output.payloadSchemaRef);
    assert.ok(typed, `${row.id} unresolved output schema ${output.payloadSchemaRef}`);
    assert.equal(typed.artifactType, output.artifactType, `${row.id} output type ref and discriminator disagree`);
    return typed.artifactType;
  });
  assert.deepEqual(result.properties.outputs.items.oneOf.map((schema) => schema.properties.artifactType.const), expectedTypes,
    `${row.id} result schema must contain the exact typed output alternatives`);
  return { request, result, outputSchemas: row.successOutputs.map((entry) => outputById.get(entry.payloadSchemaRef).schema) };
}

test("all 448 canonical capability request and result schemas close against exact typed payload/scalar definitions", () => {
  const rows = contract.records.filter((row) => row.recordKind === "CANONICAL_OWNER_DEFINED_CAPABILITY_OPERATION");
  assert.equal(rows.length, 448);
  const effectiveRows = rows.filter((row) => row.ownerLeafWireContractRef);
  assert.equal(effectiveRows.length, 29, "the exact current overlays replace the historical base schemas for 29 leaves");
  assert.equal(rows.length - effectiveRows.length, 419, "the remaining canonical rows retain their base operation schemas");
  assert.equal(new Set(effectiveRows.map((row) => row.ownerLeafWireContractRef)).size, 29, "no two leaves may alias one effective overlay");
  const inputIds = new Set(contract.inputPayloadSchemas.map(({ id }) => id));
  const outputIds = new Set(contract.outputPayloadSchemas.map(({ id }) => id));
  const profileIds = new Set(contract.families.map(({ id }) => id));
  const boundsIds = new Set(contract.bounds.map(({ id }) => id));
  assert.equal(contract.scalarTypeRecords.length, 29);
  const ajv = buildAjv();
  for (const row of rows) {
    assert.ok(profileIds.has(row.familyProfileRef), `${row.id} unresolved profile`);
    assert.ok(boundsIds.has(row.boundsRef), `${row.id} unresolved bounds`);
    assert.ok(row.inputSlots.every(({ payloadSchemaRef }) => inputIds.has(payloadSchemaRef)), `${row.id} has unresolved input type`);
    assert.ok(row.successOutputs.every(({ payloadSchemaRef }) => outputIds.has(payloadSchemaRef)), `${row.id} has unresolved output type`);
    assert.equal(row.requestSchema.additionalProperties, false, `${row.id} request is not closed`);
    assert.equal(row.resultSchema.additionalProperties, false, `${row.id} result is not closed`);
    assert.ok(row.resultSchema.allOf?.some((rule) => rule.if?.properties?.outcome?.const === "REJECTED" && rule.then?.properties?.outputs?.maxItems === 0),
      `${row.id} rejected results must contain no success artifact`);
    assert.ok(row.resultSchema.allOf?.some((rule) => rule.if?.properties?.outcome?.const === "UNKNOWN_OUTCOME" && rule.then?.properties?.outputs?.maxItems === 0),
      `${row.id} unknown outcomes must contain no success artifact`);
    const { request, result, outputSchemas } = resolvedSchemas(row);
    walk({ request, result, outputSchemas }, (node, path) => {
      if (node.type !== undefined) {
        for (const type of Array.isArray(node.type) ? node.type : [node.type]) assert.ok(isSchemaType(type), `${row.id} unsupported type ${type} at ${path}`);
      }
      assert.ok(!(typeof node.schemaRef === "string" && /^media\.typed-(input|output)\./u.test(node.schemaRef)), `${row.id} has unresolved executable schemaRef at ${path}`);
      assert.ok(!(typeof node.payloadSchemaRef === "string" && /^media\.typed-(input|output)\./u.test(node.payloadSchemaRef)), `${row.id} has unresolved executable payloadSchemaRef at ${path}`);
    });
    const validateRequest = ajv.compile(request);
    const validRequest = example(request);
    assert.equal(validateRequest(validRequest), true, `${row.id} generated request should validate: ${ajv.errorsText(validateRequest.errors)}`);
    assert.equal(validateRequest({ ...validRequest, untrustedExtra: true }), false, `${row.id} must reject unknown caller fields`);
    assert.equal(validateRequest({ ...validRequest, tenantId: "attacker-tenant" }), false, `${row.id} must reject trusted tenant override`);
    if (Object.hasOwn(validRequest, "parameters")) {
      assert.equal(validateRequest({ ...validRequest, parameters: { ...validRequest.parameters, tenantId: "attacker-tenant" } }), false,
        `${row.id} must reject tenant smuggling in parameters`);
    }
    for (const slot of row.inputSlots.filter(({ required }) => required)) {
      const withoutSlot = { ...validRequest };
      delete withoutSlot[slot.slotId];
      assert.equal(validateRequest(withoutSlot), false, `${row.id} must reject missing required slot ${slot.slotId}`);
      const wrongType = { ...validRequest, [slot.slotId]: {} };
      assert.equal(validateRequest(wrongType), false, `${row.id} must reject an untyped required slot ${slot.slotId}`);
    }
    for (const slot of row.inputSlots.filter(({ required }) => !required)) {
      const withoutSlot = { ...validRequest };
      delete withoutSlot[slot.slotId];
      assert.equal(validateRequest(withoutSlot), true, `${row.id} optional slot ${slot.slotId} must remain optional`);
    }
    const validateResult = ajv.compile(result);
    const success = example(result);
    success.outcome = "SUCCEEDED";
    success.outputs = outputSchemas.map(example);
    if (row.capabilityRef === "media.stream.session.reconnect") {
      success.reconnectReceipt = example(row.resultSchema.properties.reconnectReceipt);
      assert.equal(validateResult({ ...success, reconnectReceipt: undefined }), false, `${row.id} success requires an authoritative reconnect receipt`);
    }
    assert.equal(validateResult(success), true, `${row.id} generated success result should validate: ${ajv.errorsText(validateResult.errors)}`);
    const rejected = { ...success, outcome: "REJECTED", outputs: [] };
    if (row.capabilityRef === "media.stream.session.reconnect") delete rejected.reconnectReceipt;
    assert.equal(validateResult(rejected), true, `${row.id} rejected result without output should validate: ${ajv.errorsText(validateResult.errors)}`);
    const rejectedWithSuccessArtifact = { ...success, outcome: "REJECTED" };
    if (row.capabilityRef === "media.stream.session.reconnect") delete rejectedWithSuccessArtifact.reconnectReceipt;
    assert.equal(validateResult(rejectedWithSuccessArtifact), false, `${row.id} must reject a success artifact on rejection`);
    if (row.capabilityRef === "media.stream.session.reconnect") {
      assert.equal(validateResult({ ...rejected, reconnectReceipt: success.reconnectReceipt }), false, `${row.id} must reject reconnect receipt on rejection`);
      assert.equal(validateResult({ ...success, outcome: "UNKNOWN_OUTCOME", outputs: [] }), false, `${row.id} must reject reconnect receipt on unknown outcome`);
    }
    assert.equal(validateResult({ ...success, outcome: "SUCCEEDED", outputs: [] }), false, `${row.id} must enforce required output cardinality`);
    assert.equal(validateResult({ ...success, outcome: "SUCCEEDED", outputs: [...success.outputs, success.outputs[0]] }), false,
      `${row.id} must reject excess output slots`);
    const wrongOutput = structuredClone(success);
    wrongOutput.outputs[0].artifactType = "media.output.unrelated";
    assert.equal(validateResult(wrongOutput), false, `${row.id} must reject a wrong output type`);
  }
});


test("all 101 input and 69 output type definitions are material, closed, and reject missing required evidence", () => {
  assert.equal(contract.inputPayloadSchemas.length, 101);
  assert.equal(contract.outputPayloadSchemas.length, 69);
  const ajv = buildAjv();
  const all = [...contract.inputPayloadSchemas, ...contract.outputPayloadSchemas];
  for (const row of all) {
    const schema = row.schema;
    assert.equal(schema.additionalProperties, false, `${row.id} root schema is closed`);
    walk(schema, (node, path) => {
      assert.ok(!(node.type === "object" && node.additionalProperties === false && Object.keys(node.properties ?? {}).length === 0),
        `${row.id} has an empty closed object at ${path}`);
    });
    assertPdpTruthDomainSchemaKeywords(ajv, schema);
    const validate = ajv.compile(schema);
    const valid = example(schema);
    assert.equal(validate(valid), true, `${row.id} positive typed example: ${ajv.errorsText(validate.errors)}`);
    const missingEnvelope = structuredClone(valid);
    delete missingEnvelope.payload;
    assert.equal(validate(missingEnvelope), false, `${row.id} rejects missing typed payload`);
    const missingMaterial = structuredClone(valid);
    assert.ok(deleteDeepRequiredMaterial(schema, missingMaterial), `${row.id} has a required material field to test`);
    assert.equal(validate(missingMaterial), false, `${row.id} rejects missing material field`);
  }
  const template = contract.inputPayloadSchemas.find(({ id }) => id === "media.typed-input.typed-operation-request");
  assert.match(template.ownerDefinition, /cannot carry executable caller values/u);
  assert.equal(example(template.schema).payload.executionRole, "NON_EXECUTABLE_SCHEMA_DESCRIPTOR_ONLY");
});

test("rational frame-rate limits use the exact BigInt validator and fail closed", () => {
  const ajv = addPdpTruthDomainKeywords(new Ajv({ allErrors: true, strict: false }));
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["numerator", "denominator"],
    properties: {
      numerator: { type: "integer", minimum: 1, maximum: 120000 },
      denominator: { type: "integer", minimum: 1, maximum: 1001 },
    },
    "x-rationalRange": {
      minimum: { numerator: 1, denominator: 1 },
      maximum: { numerator: 120, denominator: 1 },
    },
  };
  const validate = ajv.compile(schema);
  assert.equal(validate({ numerator: 1, denominator: 1 }), true, "minimum is inclusive");
  assert.equal(validate({ numerator: 120, denominator: 1 }), true, "maximum is inclusive");
  assert.equal(validate({ numerator: 24, denominator: 1 }), true);
  assert.equal(validate({ numerator: 24000, denominator: 1001 }), true);
  assert.equal(validate({ numerator: 121, denominator: 1 }), false, "value above inclusive maximum fails");
  assert.equal(validate({ numerator: 1, denominator: 0 }), false, "zero denominator fails");
  assert.equal(validate({ numerator: -1, denominator: 1 }), false, "nonpositive numerator fails");
  assert.equal(validate({ numerator: 48, denominator: 2 }), false, "unreduced equivalent fraction fails canonical representation");
  assert.equal(validate({ numerator: Number.MAX_SAFE_INTEGER + 1, denominator: 1 }), false, "unsafe integer fails");
  const invalidBounds = structuredClone(schema);
  invalidBounds["x-rationalRange"].maximum.denominator = 0;
  assert.throws(() => assertPdpTruthDomainSchemaKeywords(ajv, invalidBounds), /invalid x-rationalRange definition/u,
    "invalid declared limits fail at definition preflight");
  const reversedBounds = structuredClone(schema);
  reversedBounds["x-rationalRange"].minimum = { numerator: 121, denominator: 1 };
  assert.throws(() => assertPdpTruthDomainSchemaKeywords(ajv, reversedBounds), /invalid x-rationalRange definition/u,
    "reversed limits fail at definition preflight");
  const unknownFlags = structuredClone(schema);
  unknownFlags["x-rationalRange"].exclusiveMaximum = true;
  assert.throws(() => assertPdpTruthDomainSchemaKeywords(ajv, unknownFlags), /invalid x-rationalRange definition/u,
    "unsupported inclusivity flags fail at definition preflight");
  const nullBounds = structuredClone(schema);
  nullBounds["x-rationalRange"] = null;
  assert.throws(() => assertPdpTruthDomainSchemaKeywords(ajv, nullBounds), /invalid x-rationalRange definition/u,
    "null bounds fail without a type error");
  const noKeywordValidator = new Ajv({ allErrors: true, strict: false });
  assert.throws(() => assertPdpTruthDomainSchemaKeywords(noKeywordValidator, schema), /unregistered Media schema keyword x-rationalRange/u,
    "a permissive JSON Schema engine without the exact domain validator is rejected");
  const unsupported = structuredClone(schema);
  unsupported["x-rationalTypo"] = unsupported["x-rationalRange"];
  assert.throws(() => assertPdpTruthDomainSchemaKeywords(ajv, unsupported), /unsupported or unregistered Media schema keyword x-rationalTypo/u);
});

test("all 14 existing-operation capability bindings resolve to their exact source-owned wire schemas", () => {
  const bindings = contract.records.filter((row) => row.recordKind === "CAPABILITY_TO_EXISTING_OPERATION_BINDING");
  assert.equal(bindings.length, 14);
  const sourceOperations = [
    ...operations.operations,
    ...operations.individualOperationContracts.records,
    ...operations.ownerDefinedOperationContracts.records,
  ];
  const sourceById = new Map(sourceOperations.map((row) => [row.id, row]));
  const sourceWireByOperation = new Map(sourceOperations.filter((row) => row.ownerWireSchema)
    .map((row) => [row.ownerWireSchema.operationRef, row.ownerWireSchema]));
  const ajv = buildAjv();
  const validatedWireIds = new Set();
  const resolveOperationSelector = (ref) => {
    const prefix = ".product-experience/pdp-1-domain-data/operations.yaml#";
    assert.ok(typeof ref === "string" && ref.startsWith(prefix), `exact operations source selector: ${ref}`);
    let value = operations;
    for (const part of ref.slice(prefix.length).split("/")) {
      const id = /^@id=(.+)$/u.exec(part);
      if (id) {
        assert.ok(Array.isArray(value), `identity selector traverses an array: ${ref}`);
        const matches = value.filter((row) => row?.id === id[1]);
        assert.equal(matches.length, 1, `exact identity selector has one match: ${ref}`);
        [value] = matches;
      } else value = Array.isArray(value) && /^\d+$/u.test(part) ? value[Number(part)] : value?.[part];
      assert.notEqual(value, undefined, `selector resolves: ${ref}`);
    }
    return value;
  };
  for (const binding of bindings) {
    assert.deepEqual(binding.canonicalWireSchemaRefs.length, binding.operationRefs.length, `${binding.capabilityRef} has an exact wire-schema ref per canonical source operation`);
    for (let index = 0; index < binding.operationRefs.length; index++) {
      const operationRef = binding.operationRefs[index];
      const source = sourceById.get(operationRef);
      assert.ok(source, `${binding.capabilityRef} unknown source operation ${operationRef}`);
      const sourceRef = binding.canonicalSourceContractRefs[index];
      const resolvedSource = resolveOperationSelector(sourceRef);
      assert.equal(resolvedSource.id, operationRef, `${binding.capabilityRef} selector resolves to declared operation`);
      const wire = sourceWireByOperation.get(operationRef);
      assert.ok(wire, `${operationRef} has no source-owned wire schema`);
      assert.equal(binding.canonicalWireSchemaRefs[index], `${sourceRef}/ownerWireSchema`);
      assert.equal(resolveOperationSelector(binding.canonicalWireSchemaRefs[index]), source.ownerWireSchema,
        `${operationRef} wire-schema reference resolves through source tree`);
      assert.equal(wire.operationRef, operationRef);
      assert.equal(wire.operationKind, source.operationKind ?? source.ownerDefinition?.operationKind ?? source.operationKind);
      if (wire.requestSchema.oneOf) assert.ok(wire.requestSchema.oneOf.every((branch) => branch.additionalProperties === false));
      else assert.equal(wire.requestSchema.additionalProperties, false);
      if (wire.resultSchema.oneOf) assert.ok(wire.resultSchema.oneOf.every((branch) => branch.additionalProperties === false));
      else assert.equal(wire.resultSchema.additionalProperties, false);
      assertPdpTruthDomainSchemaKeywords(ajv, wire.requestSchema);
      assertPdpTruthDomainSchemaKeywords(ajv, wire.resultSchema);
      const validateRequest = ajv.compile(wire.requestSchema);
      let validRequest = example(wire.requestSchema);
      if (wire.id === "media.operation-wire-schema.job-submit-v1") {
        validRequest = {
          operationRef: "media.operation.job.submit.v1", operationVersion: 1, capabilityRef: contract.records.find((row) => row.capabilityRef === "media.job.submit").capabilityRef,
          requestId: "request-1", typedInputs: [example(contract.inputPayloadSchemas[0].schema)],
          profile: { profileRef: "profile:v1", profileVersion: "1.0.0", configurationDigest: `sha256:${"a".repeat(64)}` },
          fallbackPolicy: { mode: "DENY", alternatives: [] }, deadline: { maximumDurationMs: 60000 },
          resourceBudget: { maximumInputBytes: 1048576, maximumOutputBytes: 1048576, maximumAttempts: 2, maximumCostUnits: 100 }, purpose: "requested job",
        };
      }
      assert.equal(validateRequest(validRequest), true, `${operationRef} request: ${ajv.errorsText(validateRequest.errors)}`);
      assert.equal(validateRequest({ ...validRequest, tenantId: "caller-override" }), false, `${operationRef} rejects body tenant override`);
      assert.equal(validateRequest({ ...validRequest, unrecognized: true }), false, `${operationRef} rejects unknown caller fields`);
      if (wire.requestHeadersSchema) {
        const validateHeaders = ajv.compile(wire.requestHeadersSchema);
        assert.equal(validateHeaders(example(wire.requestHeadersSchema)), true, `${operationRef} request headers validate`);
        assert.equal(validateHeaders({ "Idempotency-Key": "key-1", "X-Tenant-Id": "caller-override" }), false,
          `${operationRef} client headers cannot override trusted tenant`);
      }
      const validateResult = ajv.compile(wire.resultSchema);
      if (wire.id === "media.operation-wire-schema.job-submit-v1") {
        const acknowledged = example(wire.resultSchema.oneOf[0]);
        assert.equal(acknowledged.canonicalStatus, "QUEUED");
        assert.equal(validateResult(acknowledged), true, `${operationRef} accepted receipt: ${ajv.errorsText(validateResult.errors)}`);
        assert.equal(validateResult({ ...acknowledged, canonicalStatus: "COMPLETED" }), false, `${operationRef} cannot claim completion on admission`);
        assert.equal(validateResult({ ...acknowledged, observationLocation: { ...acknowledged.observationLocation, operationRef: "http://guessed-route" } }), false,
          `${operationRef} observation location uses exact query identity`);
        assert.equal(validateResult(example(wire.resultSchema.oneOf[1])), true, `${operationRef} unknown outcome remains explicit`);
        assert.equal(validateResult(example(wire.resultSchema.oneOf[2])), true, `${operationRef} rejection carries no accepted job state`);
      } else if (wire.resultSchema.oneOf && operationRef.startsWith("media.operation.artifact.")) {
        const successBranch = wire.resultSchema.oneOf[0];
        const success = example(successBranch);
        success.outputs = successBranch.properties.outputs.items.oneOf.map(example);
        assert.equal(validateResult(success), true, `${operationRef} typed success: ${ajv.errorsText(validateResult.errors)}`);
        const rejected = example(wire.resultSchema.oneOf[1]);
        const unknown = example(wire.resultSchema.oneOf[2]);
        assert.equal(validateResult(rejected), true, `${operationRef} rejection has no success output`);
        assert.equal(validateResult(unknown), true, `${operationRef} unknown outcome has no success output`);
        assert.equal(validateResult({ ...rejected, outputs: success.outputs }), false, `${operationRef} rejects finality/artifacts on REJECTED`);
        assert.equal(validateResult({ ...unknown, outputs: success.outputs }), false, `${operationRef} rejects finality/artifacts on UNKNOWN_OUTCOME`);
        assert.equal(validateResult({ ...success, outputs: [] }), false, `${operationRef} requires exact successful output cardinality`);
        if (operationRef === "media.operation.artifact.import.v1") {
          const duplicate = structuredClone(success);
          duplicate.outputs[1] = structuredClone(duplicate.outputs[0]);
          assert.equal(validateResult(duplicate), false, `${operationRef} requires all three distinct typed import outputs`);
        }
      } else {
        const success = example(wire.resultSchema);
        success.outcome = "SUCCEEDED";
        success.outputs = wire.resultSchema.properties.outputs.items.oneOf.map(example);
        assert.equal(validateResult(success), true, `${operationRef} result: ${ajv.errorsText(validateResult.errors)}`);
        assert.equal(validateResult({ ...success, outcome: "REJECTED" }), false, `${operationRef} cannot carry output on rejected result`);
        assert.equal(validateResult({ ...success, outcome: "UNKNOWN_OUTCOME" }), false, `${operationRef} cannot carry output on unknown result`);
        const noOutputRejection = { ...success, outcome: "REJECTED", outputs: [], error: { code: "ACCESS_DENIED" } };
        delete noOutputRejection.requestId;
        assert.equal(validateResult(noOutputRejection), true, `${operationRef} rejection without finality/output validates`);
      }
      validatedWireIds.add(wire.id);
    }
  }
  assert.equal(validatedWireIds.size, 16, "14 capability bindings resolve to 16 distinct existing, generic-job, and full-leaf source schemas");
  const resume = bindings.find(({ capabilityRef }) => capabilityRef === "media.artifact.upload.resume");
  assert.deepEqual(resume.operationRefs, ["media.operation-slice.inspect-upload", "media.operation-slice.append-upload-chunk", "media.operation-slice.complete-upload"],
    "upload resume retains its exact inspect → append → complete sequence");
  const foreignRef = bindings[0].canonicalSourceContractRefs[0].replace("operations.yaml#", "privacy.yaml#");
  assert.throws(() => resolveOperationSelector(foreignRef), /exact operations source selector/u,
    "a valid foreign-file selector cannot satisfy an operation binding");
});
