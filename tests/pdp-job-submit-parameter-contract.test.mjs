import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeJobParameterJson, resolveJobSubmitParameterSchema, validateJobSubmitParameterContract, validateJobSubmitTypedInputContract } from "../scripts/lib/pdp-job-submit-parameter-contract.mjs";
import { validateOwnerClosedJsonSchema } from "../scripts/lib/pdp-owner-leaf-wire-validation.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const operations = parse(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/operations.yaml"), "utf8"));

function example(schema, definitions, depth = 0) {
  assert.ok(depth < 32, "example schema recursion is bounded");
  if (schema.$ref) {
    const selected = schema.$ref.replace(/^#\//u, "").split("/").reduce((value, key) => value?.[key.replaceAll("~1", "/").replaceAll("~0", "~")], { definitions });
    assert.ok(selected, `example resolves ${schema.$ref}`);
    return example(selected, definitions, depth + 1);
  }
  if (schema.const !== undefined) return schema.const;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.oneOf) return example(schema.oneOf[0], definitions, depth + 1);
  if (schema.anyOf) return example(schema.anyOf[0], definitions, depth + 1);
  if (schema.type === "object" || schema.properties) {
    const result = {};
    for (const key of schema.required ?? []) result[key] = example(schema.properties?.[key] ?? {}, definitions, depth + 1);
    return result;
  }
  if (schema.type === "array") return Array.from({ length: schema.minItems ?? 0 }, () => example(schema.items ?? {}, definitions, depth + 1));
  if (schema.type === "integer" || schema.type === "number") return schema.minimum ?? 0;
  if (schema.type === "boolean") return false;
  if (schema.type === "string") {
    if (schema.format === "date-time") return "2026-10-09T12:00:00Z";
    if (schema.format === "semantic-version-or-owner-version-id") return "1.0.0";
    if (schema.format === "versioned-profile-reference") return "profile:1";
    if (schema.format?.includes("digest") || schema.pattern?.includes("sha256:")) return `sha256:${"a".repeat(64)}`;
    for (const candidate of ["request-1", "id-1", "v-1", "ref:one", "profile:1", "en-US", "x"]) {
      if (!schema.pattern || new RegExp(schema.pattern).test(candidate)) return candidate;
    }
    return "x".repeat(schema.minLength ?? 1);
  }
  return {};
}

function parameterExample(schema, context, depth = 0) {
  assert.ok(depth < 48, "parameter schema example recursion is bounded");
  if (schema.$ref) {
    const rootRef = schema.$ref.replace(/^#\//u, "").split("/").reduce((value, key) => value?.[key.replaceAll("~1", "/").replaceAll("~0", "~")], context);
    assert.ok(rootRef, `parameter schema resolves ${schema.$ref}`);
    return parameterExample(rootRef, context, depth + 1);
  }
  if (schema.const !== undefined) return schema.const;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.oneOf) return parameterExample(schema.oneOf[0], context, depth + 1);
  if (schema.anyOf) return parameterExample(schema.anyOf[0], context, depth + 1);
  if (schema.type === "object" || schema.properties) {
    const value = {};
    for (const key of schema.required ?? []) value[key] = parameterExample(schema.properties?.[key] ?? {}, context, depth + 1);
    for (const part of schema.allOf ?? []) {
      const branch = parameterExample(part, context, depth + 1);
      if (branch && typeof branch === "object" && !Array.isArray(branch)) Object.assign(value, branch);
    }
    return value;
  }
  if (schema.allOf) {
    const values = schema.allOf.map((part) => parameterExample(part, context, depth + 1));
    const objects = values.filter((value) => value && typeof value === "object" && !Array.isArray(value));
    return objects.length ? Object.assign({}, ...objects) : values[0];
  }
  if (schema.type === "array") return Array.from({ length: schema.minItems ?? 0 }, () => parameterExample(schema.items ?? {}, context, depth + 1));
  if (schema.type === "integer" || schema.type === "number") return schema.minimum ?? 0;
  if (schema.type === "boolean") return false;
  if (schema.type === "null") return null;
  if (schema.type === "string") {
    if (schema.format === "date-time") return "2026-10-09T12:00:00Z";
    if (schema.format === "bcp47-language-tag") return "en-US";
    if (schema.format === "opaque-reference" || schema.format === "opaque-versioned-reference") return "ref:one";
    if (schema.format === "opaque-id") return "id-1";
    if (schema.format === "opaque-version-id") return "v-1";
    if (schema.format === "iana-media-type") return "application/octet-stream";
    if (schema.format === "semantic-version-or-owner-version-id") return "1.0.0";
    if (schema.pattern?.startsWith("^video/")) return "video/mp4";
    if (schema.pattern?.startsWith("^(?:image|video)/")) return "image/png";
    if (schema.pattern?.startsWith("^image/")) return "image/png";
    if (schema.pattern?.includes("sha256:")) return `sha256:${"a".repeat(64)}`;
    for (const candidate of ["id-1", "v-1", "ref:one", "request-1", "profile:1", "en-US", "x", "1.0.0", "00:00:00.000"]) {
      if (!schema.pattern || new RegExp(schema.pattern).test(candidate)) return candidate;
    }
    return "x".repeat(schema.minLength ?? 1);
  }
  return {};
}

function requestFor(capabilityRef, operationRef) {
  const contract = operations.ownerDefinedOperationContracts.records.find(({ id }) => id === "media.operation.job.submit.v1");
  const requestSchema = contract.ownerWireSchema.requestSchema;
  const request = example(requestSchema, requestSchema.definitions);
  request.operationRef = "media.operation.job.submit.v1";
  request.operationVersion = 1;
  request.capabilityRef = capabilityRef;
  request.targetOperationRef = operationRef;
  request.targetOperationVersion = 1;
  const wrapper = operations.capabilityOperationContracts.records.find(({ capabilityRef: ref }) => ref === capabilityRef);
  const selectedOperation = resolveJobSubmitParameterSchema(operations, capabilityRef, operationRef, 1).requestSchema;
  assert.ok(selectedOperation, "test operation has an exact closed request schema");
  const inputSlots = Object.entries(selectedOperation.properties ?? {})
    .filter(([name]) => /^input[1-9]\d*$/u.test(name))
    .sort(([left], [right]) => Number(left.slice(5)) - Number(right.slice(5)));
  request.typedInputs = inputSlots.map(([, schema]) => parameterExample(schema, selectedOperation));
  request.parameters = selectedOperation.properties?.parameters
    ? parameterExample(selectedOperation.properties.parameters, selectedOperation)
    : {};
  const owner = operations.ownerDefinedOperationContracts.records.find(({ id }) => id === "media.operation.job.submit.v1");
  const directAdapter = owner.requestSemantics.typedInputValidator.directFieldAdapters.find((adapter) =>
    adapter.capabilityRef === capabilityRef && adapter.targetOperationRef === operationRef);
  request.directRequestFields = directAdapter
    ? Object.fromEntries(directAdapter.directFields.map((field) => [field, parameterExample(selectedOperation.properties[field], selectedOperation)]))
    : {};
  if (capabilityRef === "media.generate.image.text-to-image") {
    request.parameters = { outputWidth: 1024, outputHeight: 1024, outputProfileRef: "profile:1" };
  }
  return request;
}

test("job submission parameters are dynamically validated against the exact selected capability operation", () => {
  const request = requestFor("media.generate.image.text-to-image", "media.operation.capability.media-generate-image-text-to-image");
  const accepted = validateJobSubmitParameterContract(operations, request);
  assert.equal(accepted.valid, true, JSON.stringify(accepted.errors ?? []));
  assert.match(accepted.parameterBindingSha256, /^[a-f0-9]{64}$/u);
  assert.equal(accepted.runtimeAdmission, "NOT_ADMITTED");

  const changedValue = structuredClone(request);
  changedValue.parameters.outputWidth = 2048;
  const changedFingerprint = validateJobSubmitParameterContract(operations, changedValue);
  assert.equal(changedFingerprint.valid, true);
  assert.notEqual(changedFingerprint.parameterBindingSha256, accepted.parameterBindingSha256);

  const reorderedParameters = Object.fromEntries(Object.entries(request.parameters).reverse());
  const reordered = validateJobSubmitParameterContract(operations, { ...request, parameters: reorderedParameters });
  assert.equal(reordered.valid, true);
  assert.equal(reordered.parameterBindingSha256, accepted.parameterBindingSha256,
    "JSON object member order does not change semantic request identity");

  const selectedCapability = operations.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === request.capabilityRef);
  const savedSchema = structuredClone(selectedCapability.requestSchema);
  try {
    selectedCapability.requestSchema.definitions = {
      outputDimension: { type: "integer", minimum: 1, maximum: 4096 },
    };
    selectedCapability.requestSchema.properties.parameters.properties.outputWidth = { "$ref": "#/definitions/outputDimension" };
    const changedSchema = validateJobSubmitParameterContract(operations, request);
    assert.equal(changedSchema.valid, true);
    assert.notEqual(changedSchema.requestSchemaSha256, accepted.requestSchemaSha256,
      "a changed referenced definition changes the schema digest bound into request identity");
    assert.notEqual(changedSchema.parameterBindingSha256, accepted.parameterBindingSha256);
    selectedCapability.requestSchema.definitions.outputDimension.maximum = 8192;
    const sameReferenceChangedDefinition = validateJobSubmitParameterContract(operations, request);
    assert.equal(sameReferenceChangedDefinition.valid, true);
  assert.equal(selectedCapability.requestSchema.properties.parameters.properties.outputWidth.$ref,
    "#/definitions/outputDimension");
    assert.notEqual(sameReferenceChangedDefinition.requestSchemaSha256, changedSchema.requestSchemaSha256,
      "identical $ref text with changed referenced definition changes the complete schema digest");
    assert.notEqual(sameReferenceChangedDefinition.parameterBindingSha256, changedSchema.parameterBindingSha256);
  } finally {
    selectedCapability.requestSchema = savedSchema;
  }

  const sparse = [];
  sparse.length = 1;
  assert.throws(() => canonicalizeJobParameterJson({ value: sparse }), /sparse arrays/u);

  for (const mutate of [
    (candidate) => { delete candidate.parameters.outputWidth; },
    (candidate) => { candidate.parameters.unrecognized = true; },
    (candidate) => { candidate.parameters.outputWidth = "1024"; },
    (candidate) => { candidate.targetOperationRef = "media.operation-slice.inspect-job"; },
    (candidate) => { candidate.targetOperationVersion = 2; },
    (candidate) => { candidate.capabilityRef = "media.generate.image.image-to-image"; },
    (candidate) => { candidate.parameters.outputProfileRef = " "; },
  ]) {
    const changed = structuredClone(request);
    mutate(changed);
    assert.equal(validateJobSubmitParameterContract(operations, changed).valid, false,
      "missing, unknown, wrong-typed, foreign, or mismatched values fail closed");
  }
});

test("job submission typed inputs bind exact target slot count, order, and closed slot schemas", () => {
  const request = requestFor("media.edit.retime-slow-motion-speed-ramp", "media.operation.capability.media-edit-retime-slow-motion-speed-ramp");
  const accepted = validateJobSubmitTypedInputContract(operations, request);
  assert.equal(accepted.valid, true, JSON.stringify(accepted.errors ?? []));
  assert.deepEqual(accepted.slotRefs.map((ref) => ref.split("/").at(-1)), ["input1", "input2"]);

  const wrongType = structuredClone(request);
  wrongType.typedInputs[0].artifactType = "edit-intent-and-preservation-policy";
  assert.equal(validateJobSubmitTypedInputContract(operations, wrongType).valid, false,
    "a valid envelope for another slot cannot substitute for the exact input1 type");

  const reversed = structuredClone(request);
  reversed.typedInputs.reverse();
  assert.equal(validateJobSubmitTypedInputContract(operations, reversed).valid, false,
    "slot order is exact even when both envelopes are individually valid");

  const missingRequired = structuredClone(request);
  missingRequired.typedInputs.pop();
  assert.equal(validateJobSubmitTypedInputContract(operations, missingRequired).valid, false,
    "required trailing slot cannot be omitted");

  const duplicate = structuredClone(request);
  duplicate.typedInputs.push(structuredClone(duplicate.typedInputs[1]));
  assert.equal(validateJobSubmitTypedInputContract(operations, duplicate).valid, false,
    "extra duplicate slots are rejected");

  const directFields = resolveJobSubmitParameterSchema(operations, "media.project.create", "media.operation.capability.media-project-create", 1);
  assert.equal(directFields.valid, false);
  assert.equal(directFields.reason, "TARGET_OPERATION_NOT_ASYNC_SUBMITTABLE",
    "project creation is an exact direct owner command, not an asynchronous processor job");
});

test("artifact import and derive reconstruct exact direct target requests before acceptance", () => {
  for (const [capabilityRef, operationRef] of [
    ["media.artifact.import", "media.operation.artifact.import.v1"],
    ["media.artifact.derive", "media.operation.artifact.derive.v1"],
  ]) {
    const request = requestFor(capabilityRef, operationRef);
    const accepted = validateJobSubmitParameterContract(operations, request);
    assert.equal(accepted.valid, true, `${capabilityRef}: ${JSON.stringify(accepted.errors ?? accepted)}`);
    assert.match(accepted.targetRequestSha256, /^[a-f0-9]{64}$/u);
    assert.ok(accepted.targetRequestSchemaRef.endsWith("/ownerWireSchema/requestSchema"));
    const omitted = structuredClone(request);
    delete omitted.directRequestFields.governance;
    assert.equal(validateJobSubmitParameterContract(operations, omitted).valid, false, `${capabilityRef} requires exact governance`);
    const foreign = structuredClone(request);
    foreign.directRequestFields.unrelated = { value: true };
    assert.equal(validateJobSubmitParameterContract(operations, foreign).valid, false, `${capabilityRef} rejects unbound direct fields`);
    const malformed = structuredClone(request);
    malformed.directRequestFields.governance = {};
    assert.equal(validateJobSubmitParameterContract(operations, malformed).valid, false, `${capabilityRef} validates direct field values against the source schema`);
  }
});

test("all 24 intent-authored animation jobs permit omitted optional references without shifting typed slots", () => {
  const animationCapabilities = [
    "media.animation.2d", "media.animation.vector", "media.animation.3d", "media.animation.keyframe",
    "media.animation.interpolation-easing", "media.animation.procedural", "media.animation.path",
    "media.animation.skeletal", "media.animation.inverse-kinematics", "media.animation.constraint",
    "media.animation.morph-target", "media.animation.camera", "media.animation.material", "media.animation.light",
    "media.animation.particle", "media.animation.drive.physics", "media.animation.drive.audio",
    "media.animation.drive.speech", "media.animation.drive.pose", "media.animation.facial-expression",
    "media.animation.gaze", "media.animation.lip", "media.animation.motion.retarget", "media.animation.character",
  ];
  const records = operations.capabilityOperationContracts.records;
  for (const capabilityRef of animationCapabilities) {
    const operation = records.find((row) => row.capabilityRef === capabilityRef);
    assert.ok(operation, `${capabilityRef}: exact owner operation exists`);
    assert.equal(operation.operationRefs.length, 1, `${capabilityRef}: one exact operation identity`);
    assert.equal(operation.requestSchema.required.includes("input1"), true, `${capabilityRef}: animation intent remains mandatory`);
    assert.equal(operation.requestSchema.required.includes("input2"), false, `${capabilityRef}: source/reference slot is optional`);
    assert.equal(operation.requestSchema.properties.input2.properties.artifactType.const,
      "optional-rig-scene-or-media-references", `${capabilityRef}: optional input retains its exact closed type`);
    assert.equal(operation.requestSchema.properties.input2.additionalProperties, false);
    assert.equal(operation.requestSchema.properties.input2.properties.payload.oneOf.length, 2,
      `${capabilityRef}: when supplied, input2 remains one closed rig-scene or media-reference alternative`);
    const slot = operation.inputSlots.find(({ slotId }) => slotId === "input2");
    assert.equal(slot.cardinality, "ZERO_OR_ONE");
    assert.equal(slot.required, false);

    const complete = requestFor(capabilityRef, operation.operationRefs[0]);
    const supplied = validateJobSubmitTypedInputContract(operations, complete);
    assert.equal(supplied.valid, true, `${capabilityRef}: supplied valid reference slot is accepted`);
    const omitted = structuredClone(complete);
    omitted.typedInputs.pop();
    const omittedResult = validateJobSubmitTypedInputContract(operations, omitted);
    assert.equal(omittedResult.valid, true, `${capabilityRef}: source-free intent request is accepted`);
    assert.deepEqual(omittedResult.slotRefs.map((ref) => ref.split("/").at(-1)), ["input1"],
      `${capabilityRef}: omitting input2 cannot shift or relabel input1`);

    const invalidPresent = structuredClone(complete);
    invalidPresent.typedInputs[1] = { artifactType: "optional-rig-scene-or-media-references", payload: { kind: "media-references", artifactId: "a-1" } };
    assert.equal(validateJobSubmitTypedInputContract(operations, invalidPresent).valid, false,
      `${capabilityRef}: a supplied but incomplete reference tuple is rejected`);
    const shifted = structuredClone(omitted);
    shifted.typedInputs[0] = structuredClone(complete.typedInputs[1]);
    assert.equal(validateJobSubmitTypedInputContract(operations, shifted).valid, false,
      `${capabilityRef}: input2 cannot slide into the mandatory intent slot`);

    const requiredMutation = structuredClone(operation);
    requiredMutation.requestSchema.required.push("input2");
    const originalIndex = records.indexOf(operation);
    try {
      records[originalIndex] = requiredMutation;
      assert.equal(validateJobSubmitTypedInputContract(operations, omitted).valid, false,
        `${capabilityRef}: making input2 required invalidates source-free acceptance`);
    } finally {
      records[originalIndex] = operation;
    }
  }
  const motionCapture = records.find(({ capabilityRef }) => capabilityRef === "media.animation.motion-capture.extract");
  assert.ok(motionCapture);
  assert.ok(motionCapture.requestSchema.required.includes("input1"), "motion capture still requires its source input");
});

test("job-submit operation requires the dynamic validator before fingerprinting, acceptance, or dispatch", () => {
  const owner = operations.ownerDefinedOperationContracts.records.find(({ id }) => id === "media.operation.job.submit.v1");
  const rule = owner.parameterBindingRule;
  assert.equal(rule.id, "media.job-submit.operation-parameters.v1");
  assert.equal(rule.definitionValidator.module, "scripts/lib/pdp-job-submit-parameter-contract.mjs");
  assert.equal(rule.definitionValidator.export, "validateJobSubmitParameterContract");
  assert.deepEqual(rule.definitionValidator.requiredBefore,
    ["request-fingerprint", "durable-acceptance", "audit-intent-commit", "provider-dispatch"]);
  assert.match(rule.validation, /reject before fingerprinting, durable acceptance, audit-intent commit, or dispatch/u);
  assert.match(rule.fingerprint, /canonical JSON parameter values/u);
  assert.match(rule.nonClaims, /does not create a target operation/u);
});

test("all finite capability bindings explicitly distinguish submit commands, queries, workflows, versions, and parameter schemas", () => {
  const records = operations.capabilityOperationContracts.records;
  assert.equal(records.length, 462);
  let exactInputEnvelopeCoverage = 0;
  let directFieldAdaptersRequired = 0;
  const owner = operations.ownerDefinedOperationContracts.records.find(({ id }) => id === "media.operation.job.submit.v1");
  const applicability = owner.targetApplicabilityRule;
  const explicitlyExcluded = new Map(Object.entries(applicability.dispositions).flatMap(([disposition, rule]) =>
    rule.appliesToCapabilityRefs.map((capabilityRef) => [capabilityRef, disposition])));
  assert.equal(explicitlyExcluded.size, 62, "direct owner commands, stream/session controls, job controls, and query semantics are exhaustively excluded");
  const dispositions = new Map([
    ["COMMAND", "COMMAND_MAY_BE_SUBMITTED"],
    ["QUERY", "NOT_SUBMITTABLE_QUERY"],
    ["ORDERED_WORKFLOW", "NOT_SUBMITTABLE_ORDERED_WORKFLOW"],
  ]);
  for (const contract of records) {
    assert.equal(Number.isSafeInteger(contract.operationVersion) && contract.operationVersion > 0, true, `${contract.capabilityRef} version is explicit`);
    const excludedDisposition = explicitlyExcluded.get(contract.capabilityRef);
    if (contract.capabilityRef === "media.job.submit") {
      assert.equal(contract.asyncSubmissionDisposition, "NOT_SUBMITTABLE_RECURSIVE_SUBMISSION");
      continue;
    }
    if (excludedDisposition) assert.equal(contract.asyncSubmissionDisposition, excludedDisposition, `${contract.capabilityRef} has the exact owner exclusion`);
    else assert.equal(contract.asyncSubmissionDisposition, dispositions.get(contract.operationKind), `${contract.capabilityRef} has explicit operation-kind disposition`);
    for (const operationRef of contract.operationRefs) {
      const resolved = resolveJobSubmitParameterSchema(operations, contract.capabilityRef, operationRef, contract.operationVersion);
      if (contract.asyncSubmissionDisposition !== "COMMAND_MAY_BE_SUBMITTED") {
        assert.equal(resolved.valid, false, `${contract.capabilityRef} cannot be submitted as a job`);
        continue;
      }
      if (!resolved.valid) {
        assert.equal(resolved.reason, "TARGET_DIRECT_REQUEST_FIELDS_REQUIRE_EXACT_ADAPTER",
          `${contract.capabilityRef} must not be hidden by a partial generic request envelope`);
        assert.ok(resolved.unboundTargetFields.length > 0, `${contract.capabilityRef} exact direct fields are named`);
        directFieldAdaptersRequired += 1;
        continue;
      }
      assert.equal(resolved.valid, true, `${contract.capabilityRef}: ${resolved.reason}`);
      const fullRequest = requestFor(contract.capabilityRef, operationRef);
      const typedInputResult = validateJobSubmitTypedInputContract(operations, fullRequest);
      assert.equal(typedInputResult.valid, true,
        `${contract.capabilityRef} exact target input-slot example: ${JSON.stringify(typedInputResult)}`);
      exactInputEnvelopeCoverage += 1;
      const parameters = parameterExample(resolved.parameterSchema, resolved.requestSchema);
      assert.equal(validateOwnerClosedJsonSchema(resolved.parameterSchema, parameters, resolved.requestSchema).valid, true,
        `${contract.capabilityRef} positive exact parameter example`);
      if (resolved.parameterDisposition === "EXPLICIT_NO_PARAMETERS") {
        assert.equal(validateOwnerClosedJsonSchema(resolved.parameterSchema, {}).valid, true);
        assert.equal(validateOwnerClosedJsonSchema(resolved.parameterSchema, { unexpected: true }).valid, false);
      } else if (resolved.parameterSchema.type === "object") {
        assert.equal(validateOwnerClosedJsonSchema(resolved.parameterSchema, { ...parameters, unexpected: true }, resolved.requestSchema).valid, false,
          `${contract.capabilityRef} rejects unknown operation parameters`);
      }
    }
  }
  assert.ok(exactInputEnvelopeCoverage > 0, "at least one selected target has a complete generic inputN envelope");
  assert.ok(directFieldAdaptersRequired > 0, "direct canonical fields are not silently accepted as generic typed inputs");
  for (const capabilityRef of ["media.stream.session.open", "media.stream.session.connect", "media.stream.frame.submit", "media.job.cancel", "media.job.retry", "media.quality.compare"]) {
    const contract = records.find((row) => row.capabilityRef === capabilityRef);
    assert.ok(contract);
    assert.notEqual(resolveJobSubmitParameterSchema(operations, capabilityRef, contract.operationRefs[0], contract.operationVersion).valid, true,
      `${capabilityRef} must not inherit job eligibility from COMMAND kind`);
  }
  for (const capabilityRef of ["media.project.create", "media.project.export", "media.artifact.upload", "media.consent.grant"]) {
    const contract = records.find((row) => row.capabilityRef === capabilityRef);
    if (!contract) continue;
    assert.equal(contract.operationKind, "COMMAND");
    assert.equal(contract.asyncSubmissionDisposition, "NOT_SUBMITTABLE_DIRECT_OWNER_COMMAND",
      `${capabilityRef} requires its direct owner operation instead of a generic processor job`);
    assert.equal(explicitlyExcluded.get(capabilityRef), "NOT_SUBMITTABLE_DIRECT_OWNER_COMMAND");
  }
});
