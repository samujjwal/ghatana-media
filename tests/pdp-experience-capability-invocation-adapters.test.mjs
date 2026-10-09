import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validatePdp3JobSubmitAdapter } from "../scripts/lib/pdp3-step-capability-purpose.mjs";
import { resolveJobSubmitParameterSchema, validateJobSubmitParameterContract } from "../scripts/lib/pdp-job-submit-parameter-contract.mjs";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const [adapterText, oracleText, p0Text, capabilityText, operationText] = await Promise.all([
  readFile(".product-experience/pdp-3-product-experience/capability-invocation-adapters.yaml", "utf8"),
  readFile(".product-experience/pdp-3-product-experience/step-definition-oracles.yaml", "utf8"),
  readFile(".product-experience/pdp-0-product-truth/journey-catalog.yaml", "utf8"),
  readFile(".product-experience/pdp-0-product-truth/capabilities.yaml", "utf8"),
  readFile(".product-experience/pdp-1-domain-data/operations.yaml", "utf8"),
]);
const adapters = parse(adapterText).records;
const oracle = parse(oracleText);
const p0 = parse(p0Text);
const capabilities = parse(capabilityText).capabilities;
const operations = parse(operationText);
const capabilitiesById = new Map(capabilities.map((record) => [record.id, record]));
const operationsById = new Map(operations.capabilityOperationContracts.records.map((record) => [record.id, record]));
const jobSubmit = operations.ownerDefinedOperationContracts.records.find((record) => record.id === "media.operation.job.submit.v1");

function schemaExample(schema, root = schema, depth = 0) {
  assert.ok(depth < 40, "test schema example stays bounded");
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//u, "").split("/").reduce((value, part) => value?.[part.replaceAll("~1", "/").replaceAll("~0", "~")], root);
    assert.ok(target, `schema reference resolves: ${schema.$ref}`);
    return schemaExample(target, root, depth + 1);
  }
  if (schema.const !== undefined) return schema.const;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.oneOf) return schemaExample(schema.oneOf[0], root, depth + 1);
  if (schema.anyOf) return schemaExample(schema.anyOf[0], root, depth + 1);
  if (schema.allOf) {
    const parts = schema.allOf.map((part) => schemaExample(part, root, depth + 1));
    const objects = parts.filter((part) => part && typeof part === "object" && !Array.isArray(part));
    if (objects.length) return Object.assign({}, ...objects);
    return parts[0];
  }
  if (schema.type === "object" || schema.properties) {
    const value = {};
    for (const key of schema.required ?? []) value[key] = schemaExample(schema.properties?.[key] ?? {}, root, depth + 1);
    for (const part of schema.allOf ?? []) Object.assign(value, schemaExample(part, root, depth + 1));
    return value;
  }
  if (schema.type === "array") return Array.from({ length: schema.minItems ?? 0 }, () => schemaExample(schema.items ?? {}, root, depth + 1));
  if (schema.type === "integer" || schema.type === "number") return schema.minimum ?? 0;
  if (schema.type === "boolean") return false;
  if (schema.type === "string") {
    if (schema.format === "date-time") return "2026-10-09T12:00:00Z";
    if (schema.pattern?.includes("sha256:")) return `sha256:${"a".repeat(64)}`;
    for (const candidate of ["artifact-1", "version-1", "request-1", "ref:one", "profile:1", "en-US", "x"]) {
      if (!schema.pattern || new RegExp(schema.pattern).test(candidate)) return candidate;
    }
    return "x".repeat(schema.minLength ?? 1);
  }
  return {};
}

function jobRequestFor(capabilityRef, operationRef) {
  const wrapperSchema = jobSubmit.ownerWireSchema.requestSchema;
  const request = schemaExample(wrapperSchema, wrapperSchema);
  // A deny fallback is the closed no-alternative case in the canonical wrapper schema.
  request.fallbackPolicy = { mode: "DENY", alternatives: [] };
  const target = resolveJobSubmitParameterSchema(operations, capabilityRef, operationRef, 1);
  assert.equal(target.valid, true, `${capabilityRef}: ${target.reason}`);
  request.operationRef = "media.operation.job.submit.v1";
  request.operationVersion = 1;
  request.capabilityRef = capabilityRef;
  request.targetOperationRef = operationRef;
  request.targetOperationVersion = 1;
  const slots = Object.entries(target.requestSchema.properties ?? {})
    .filter(([name]) => /^input[1-9]\d*$/u.test(name))
    .sort(([left], [right]) => Number(left.slice(5)) - Number(right.slice(5)));
  request.typedInputs = slots.filter(([name]) => target.requestSchema.required?.includes(name))
    .map(([, schema]) => schemaExample(schema, target.requestSchema));
  request.parameters = target.requestSchema.properties?.parameters
    ? schemaExample(target.parameterSchema, target.requestSchema)
    : {};
  const direct = jobSubmit.requestSemantics.typedInputValidator.directFieldAdapters.find((row) =>
    row.capabilityRef === capabilityRef && row.targetOperationRef === operationRef);
  request.directRequestFields = direct
    ? Object.fromEntries(direct.directFields.map((field) => [field, schemaExample(target.requestSchema.properties[field], target.requestSchema)]))
    : {};
  return request;
}

test("J05 image and video analysis adapters select only exact async-submittable vision COMMANDs", () => {
  const j05Adapters = adapters.filter((adapter) => adapter.journeyRef === "J-05");
  assert.equal(j05Adapters.length, 2);
  for (const adapter of j05Adapters) {
    const journey = oracle.journeys.find((item) => item.journeyId === adapter.journeyRef);
    const step = journey.steps.find((item) => item.sourceRef === adapter.stepRef);
    const sourceJourney = p0.journeys.find((item) => item.id === adapter.journeyRef);
    assert.deepEqual(validatePdp3JobSubmitAdapter(adapter, {
      step,
      p0Journey: sourceJourney,
      capabilitiesById,
      operationsById,
      jobSubmit,
    }), { valid: true, reason: "EXACT_TARGET_COMMAND_ADAPTER_SOURCE_ONLY" });
    assert.equal(adapter.runtimeAdmission, "NOT_ADMITTED");
    assert.equal(adapter.finality.completionMeans, "none");
  }
  const repair = adapters.find((adapter) => adapter.journeyRef === "J-08");
  assert.ok(repair);
  const repairStep = oracle.journeys.find((item) => item.journeyId === "J-08").steps[1];
  assert.deepEqual(validatePdp3JobSubmitAdapter(repair, {
    step: repairStep,
    p0Journey: p0.journeys.find((item) => item.id === "J-08"),
    capabilitiesById,
    operationsById,
    jobSubmit,
  }), { valid: true, reason: "EXACT_TARGET_COMMAND_ADAPTER_SOURCE_ONLY" });
});

test("adapter rejects a valid but wrong-purpose target and a query substituted as a command", () => {
  const adapter = structuredClone(adapters.find((item) => item.journeyRef === "J-05"));
  const journey = oracle.journeys.find((item) => item.journeyId === adapter.journeyRef);
  const step = journey.steps.find((item) => item.sourceRef === adapter.stepRef);
  const sourceJourney = p0.journeys.find((item) => item.id === adapter.journeyRef);

  const wrongPurpose = structuredClone(step);
  const generated = capabilitiesById.get("media.generate.image.text-to-image");
  wrongPurpose.capabilityOptions[0] = {
    capabilityRef: generated.id,
    operationRefs: generated.ownerDefinition.operationRefs,
    operationKind: generated.ownerDefinition.operationKind,
    requirementRefs: ["MEDIA-REQ-CAP-GENERATE-IMAGE"],
  };
  const changedAdapter = structuredClone(adapter);
  changedAdapter.allowedCapabilityRefs[0] = generated.id;
  assert.equal(validatePdp3JobSubmitAdapter(changedAdapter, {
    step: wrongPurpose,
    p0Journey: sourceJourney,
    capabilitiesById,
    operationsById,
    jobSubmit,
  }).valid, false);

  const query = capabilities.find((item) => item.id === "media.quality.inspect");
  const queryOperation = operationsById.get(query.ownerDefinition.operationRefs[0]);
  assert.equal(queryOperation.operationKind, "QUERY");
  const querySubstitution = structuredClone(step);
  querySubstitution.capabilityOptions[0] = {
    capabilityRef: query.id,
    operationRefs: query.ownerDefinition.operationRefs,
    operationKind: query.ownerDefinition.operationKind,
    requirementRefs: ["MEDIA-REQ-CAP-QUALITY"],
  };
  const queryAdapter = structuredClone(adapter);
  queryAdapter.allowedCapabilityRefs[0] = query.id;
  assert.equal(validatePdp3JobSubmitAdapter(queryAdapter, {
    step: querySubstitution,
    p0Journey: sourceJourney,
    capabilitiesById,
    operationsById,
    jobSubmit,
  }).valid, false);
});

test("J06 grounded multimodal adapter submits only its selected exact COMMAND leaf", () => {
  const adapter = adapters.find((item) => item.id === "media.pdp3.invocation-adapter.j06-source-grounded.v1");
  assert.ok(adapter);
  const journey = oracle.journeys.find((item) => item.journeyId === "J-06");
  const step = journey.steps.find((item) => item.sourceRef === adapter.stepRef);
  const sourceJourney = p0.journeys.find((item) => item.id === "J-06");
  assert.deepEqual(validatePdp3JobSubmitAdapter(adapter, {
    step,
    p0Journey: sourceJourney,
    capabilitiesById,
    operationsById,
    jobSubmit,
  }), { valid: true, reason: "EXACT_TARGET_COMMAND_ADAPTER_SOURCE_ONLY" });
  assert.equal(adapter.runtimeAdmission, "NOT_ADMITTED");

  const wrongPurposeStep = structuredClone(step);
  const query = capabilitiesById.get("media.quality.inspect");
  wrongPurposeStep.capabilityOptions = [{
    capabilityRef: query.id,
    operationRefs: query.ownerDefinition.operationRefs,
    operationKind: query.ownerDefinition.operationKind,
    requirementRefs: ["MEDIA-REQ-CAP-QUALITY"],
  }];
  const wrongPurposeAdapter = structuredClone(adapter);
  wrongPurposeAdapter.allowedCapabilityRefs = [query.id];
  assert.equal(validatePdp3JobSubmitAdapter(wrongPurposeAdapter, {
    step: wrongPurposeStep,
    p0Journey: sourceJourney,
    capabilitiesById,
    operationsById,
    jobSubmit,
  }).valid, false);
});

test("all six source-selected submit steps construct a request against the exact selected target schema", () => {
  const submitSteps = oracle.journeys.flatMap((journey) => journey.steps
    .filter((step) => step.actionRef === "media.action.submit-validated-request")
    .map((step) => ({ journey, step })));
  assert.equal(submitSteps.length, 6, "the fixture population is the exact six source submit actions");
  assert.equal(adapters.length, 6, "every consequential submit action has one exact purpose adapter");
  const byStep = new Map(adapters.map((adapter) => [adapter.stepRef, adapter]));
  for (const { journey, step } of submitSteps) {
    const adapter = byStep.get(step.sourceRef);
    assert.ok(adapter, `${journey.journeyId} ${step.sourceRef} has an adapter`);
    const p0Journey = p0.journeys.find((item) => item.id === journey.journeyId);
    assert.deepEqual(validatePdp3JobSubmitAdapter(adapter, {
      step,
      p0Journey,
      capabilitiesById,
      operationsById,
      jobSubmit,
    }), { valid: true, reason: "EXACT_TARGET_COMMAND_ADAPTER_SOURCE_ONLY" });
    const capabilityRef = adapter.allowedCapabilityRefs[0];
    const operationRef = step.capabilityOptions.find((item) => item.capabilityRef === capabilityRef).operationRefs[0];
    const request = jobRequestFor(capabilityRef, operationRef);
    const result = validateJobSubmitParameterContract(operations, request);
    assert.equal(result.valid, true, `${journey.journeyId}: ${result.reason}; errors=${JSON.stringify(result.errors?.slice(0, 8))}; typed=${JSON.stringify(request.typedInputs)}`);
    assert.match(result.targetSchemaDigest, /^sha256:[a-f0-9]{64}$/u);

    const wrongTarget = structuredClone(request);
    const foreignTarget = [...operationsById.values()].find((operation) =>
      operation.capabilityRef !== capabilityRef
      && operation.operationKind === "COMMAND"
      && operation.asyncSubmissionDisposition === "COMMAND_MAY_BE_SUBMITTED");
    assert.ok(foreignTarget, "fixture includes a valid command owned by a different capability");
    wrongTarget.targetOperationRef = foreignTarget.id;
    assert.equal(validateJobSubmitParameterContract(operations, wrongTarget).valid, false,
      `${journey.journeyId} cannot replace the exact selected target operation`);
    const wrongVersion = structuredClone(request);
    wrongVersion.targetOperationVersion += 1;
    assert.equal(validateJobSubmitParameterContract(operations, wrongVersion).valid, false,
      `${journey.journeyId} cannot substitute another target version`);
  }
});
