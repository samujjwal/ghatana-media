import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { validateOwnerClosedJsonSchema } from "../scripts/lib/pdp-owner-leaf-wire-validation.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const parse = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml").parse;
const read = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const OPS_PATH = ".product-experience/pdp-1-domain-data/operations.yaml";
const CAP_PATH = ".product-experience/pdp-0-product-truth/capabilities.yaml";

function requiredLeaves(schema, prefix = "") {
  if (!schema || typeof schema !== "object") return [];
  const result = [];
  const propertyFor = (node, key) => {
    if (!node || typeof node !== "object") return undefined;
    if (node.properties?.[key]) return node.properties[key];
    for (const branch of [...(node.allOf ?? []), ...(node.oneOf ?? []), ...(node.anyOf ?? []), node.then, node.else]) {
      const found = propertyFor(branch, key);
      if (found) return found;
    }
    return undefined;
  };
  for (const key of schema.required ?? []) {
    const pointer = `${prefix}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
    const property = propertyFor(schema, key);
    if (property && (property.type === "object" || property.properties || property.allOf || property.oneOf || property.anyOf)
      && (property.required?.length || property.allOf?.length || property.oneOf?.length || property.anyOf?.length)) {
      result.push(...requiredLeaves(property, pointer));
    } else result.push(pointer);
  }
  for (const key of ["allOf", "oneOf", "anyOf"]) {
    for (const branch of schema[key] ?? []) result.push(...requiredLeaves(branch, prefix));
  }
  for (const branch of [schema.then, schema.else]) if (branch) result.push(...requiredLeaves(branch, prefix));
  for (const branch of Object.values(schema.dependentSchemas ?? {})) result.push(...requiredLeaves(branch, prefix));
  return [...new Set(result)];
}

test("job.submit carries executable typed request values and maps every required wire field", () => {
  const operations = read(OPS_PATH);
  const capabilities = read(CAP_PATH);
  const capability = capabilities.capabilities.find(({ id }) => id === "media.job.submit");
  const binding = operations.capabilityOperationContracts.records.find(({ id }) => id === "media.capability-binding.media-job-submit");
  const sourceOperation = operations.ownerDefinedOperationContracts.records.find(({ id }) => id === "media.operation.job.submit.v1");
  const requestSchema = sourceOperation.ownerWireSchema.requestSchema;
  const reusable = operations.capabilityOperationContracts.inputPayloadSchemas.find(({ id }) => id === "media.typed-input.typed-operation-request");
  const inlineInput = requestSchema.definitions.typedInputs["typed-operation-request"];
  const payload = reusable.schema.properties.payload;
  const mapping = binding.typedInputMappings;

  assert.deepEqual(capability.ownerDefinition.typedInputSlots.map(({ slotId }) => slotId), ["input1", "input2"]);
  assert.deepEqual(payload.required, [
    "capabilityRef", "operationRef", "operationVersion", "inputs", "parameters", "profile",
    "fallbackPolicy", "deadline", "resourceBudget", "purpose", "purposeRef",
  ]);
  assert.equal(payload.properties.executionRole, undefined);
  assert.equal(payload.properties.inputs.items.properties.slotId.pattern, "^input[1-9][0-9]*$");
  assert.equal(payload.properties.inputs.items.properties.value.properties.artifactType.type, "string");
  assert.equal(payload.properties.parameters.type, "object");
  assert.equal(payload.properties.parameters.additionalProperties.$ref, "#/$defs/jsonValue");
  assert.equal(payload.properties.profile.additionalProperties, false);
  assert.deepEqual(payload.properties.profile.required, ["profileRef", "profileVersion", "profileVersionRef", "configurationDigest"]);
  assert.deepEqual(payload.properties.deadline.required, ["maximumDurationMs"]);
  assert.deepEqual(payload.properties.resourceBudget.required, ["maximumInputBytes", "maximumOutputBytes", "maximumAttempts", "maximumCostUnits"]);
  const reusableWithoutLocalDefinitions = structuredClone(reusable.schema);
  delete reusableWithoutLocalDefinitions.$defs;
  assert.deepEqual(inlineInput, reusableWithoutLocalDefinitions);

  const entry = (slotId) => mapping.entries.find(({ source }) => source.slotId === slotId);
  const input1 = entry("input1");
  const input2 = entry("input2");
  assert.equal(mapping.sourceCapabilityRef, `${CAP_PATH}#capabilities/@id=media.job.submit`);
  assert.equal(input1.source.sourceRef, `${CAP_PATH}#capabilities/@id=media.job.submit/ownerDefinition/typedInputSlots/@slotId=input1`);
  assert.equal(input2.source.sourceRef, `${CAP_PATH}#capabilities/@id=media.job.submit/ownerDefinition/typedInputSlots/@slotId=input2`);
  assert.equal(input1.cardinality, capability.ownerDefinition.typedInputSlots[0].cardinality);
  assert.equal(input2.cardinality, capability.ownerDefinition.typedInputSlots[1].cardinality);
  assert.equal(input1.mappingMode, "EXPLICIT_PROJECTION");
  assert.deepEqual(input1.targets.map(({ requestPointer }) => requestPointer), [
    "/capabilityRef", "/targetOperationRef", "/targetOperationVersion", "/typedInputs", "/parameters",
    "/profile/profileRef", "/profile/profileVersion", "/profile/profileVersionRef", "/profile/configurationDigest",
    "/fallbackPolicy/mode", "/fallbackPolicy/alternatives", "/deadline/maximumDurationMs",
    "/resourceBudget/maximumInputBytes", "/resourceBudget/maximumOutputBytes", "/resourceBudget/maximumAttempts",
    "/resourceBudget/maximumCostUnits", "/purpose", "/purposeRef", "/directRequestFields", "/projectContext",
    "/consentRef", "/rightsDecisionRef", "/retentionPolicyRef", "/processingLocation",
  ]);
  assert.deepEqual(input2.targets.map(({ requestPointer }) => requestPointer), ["/requestId"]);
  assert.equal(JSON.stringify(mapping).includes("canonicalPayloadDigest"), false);

  const required = requiredLeaves(requestSchema);
  const mapped = mapping.entries.flatMap(({ targets }) => targets.map(({ requestPointer }) => requestPointer));
  const dispositioned = mapping.requestFieldDispositions.map(({ requestPointer }) => requestPointer);
  assert.equal(new Set([...mapped, ...dispositioned]).size, mapped.length + dispositioned.length);
  assert.deepEqual([...required].sort(), [...mapped, ...dispositioned].filter((pointer) => required.includes(pointer)).sort());
  assert.deepEqual(mapping.coverage, {
    requiredFields: required.length,
    mappedFromP0: mapped.filter((pointer) => required.includes(pointer)).length,
    optionalMappedFromP0: 4,
    trustedContext: 0,
    generatedProtocol: 2,
    ownerResolved: 0,
    outsideSelectedActionScope: 0,
    unresolved: 0,
    operationSelection: 0,
    status: "COMPLETE",
  });
  assert.deepEqual(dispositioned, ["/operationRef", "/operationVersion"]);
  assert.deepEqual(requestSchema.properties.operationRef, { const: "media.operation.job.submit.v1" });
  assert.deepEqual(requestSchema.properties.operationVersion, { const: 1 });
});

test("job.submit wrapper preserves the canonical preservation policy and requires consent for authorized enhancement", () => {
  const operations = read(OPS_PATH);
  const submit = operations.ownerDefinedOperationContracts.records.find(({ id }) => id === "media.operation.job.submit.v1");
  const wrapper = submit.ownerWireSchema.requestSchema.definitions.typedInputs["preservation-and-enhancement-policy"];
  const canonical = operations.capabilityOperationContracts.inputPayloadSchemas.find(({ id }) => id === "media.typed-input.preservation-and-enhancement-policy").schema;
  const required = ["preservationDisposition", "enhancementDisposition", "purposeRef", "rightsEvidenceRefs"];
  assert.deepEqual(canonical.properties.payload.required, required);
  assert.deepEqual(wrapper.properties.payload.required, required);
  assert.deepEqual(wrapper, canonical, "job.submit uses the exact canonical closed typed-input schema");
  for (const field of [...required, "consentRef", "enhancementDecisionRef"]) {
    assert.ok(wrapper.properties.payload.properties[field], `wrapper defines ${field}`);
  }
  assert.equal(wrapper.properties.payload.additionalProperties, false);

  const base = {
    artifactType: "preservation-and-enhancement-policy",
    payload: {
      preservationDisposition: "PRESERVE_SOURCE_IMMUTABLE",
      enhancementDisposition: "NO_ENHANCEMENT",
      purposeRef: "media.purpose.fixture",
      rightsEvidenceRefs: ["media.evidence.fixture"],
    },
  };
  const validate = (value) => validateOwnerClosedJsonSchema(wrapper, value, submit.ownerWireSchema.requestSchema);
  assert.equal(validate(base).valid, true, "no-enhancement needs no fabricated consent or decision reference");
  assert.equal(validate({ ...base, payload: { ...base.payload, enhancementDisposition: "AUTHORIZED_ENHANCEMENT" } }).valid, false,
    "authorized enhancement without exact consent and decision references is rejected");
  assert.equal(validate({ ...base, payload: {
    ...base.payload,
    enhancementDisposition: "AUTHORIZED_ENHANCEMENT",
    consentRef: "media.consent.fixture.v1",
    enhancementDecisionRef: "media.enhancement-decision.fixture.v1",
  } }).valid, true);
  assert.equal(validate({ ...base, payload: { ...base.payload, rightsEvidenceRefs: ["media.evidence.fixture", "media.evidence.fixture"] } }).valid, false,
    "duplicate rights evidence references are rejected");
  assert.equal(validate({ ...base, payload: { ...base.payload, retentionPolicyRef: "media.retention.fixture.v1" } }).valid, false,
    "fields absent from the canonical closed type are rejected");
  assert.equal(validate({ ...base, payload: { ...base.payload, unreviewedField: true } }).valid, false,
    "unknown policy fields remain closed");
});
