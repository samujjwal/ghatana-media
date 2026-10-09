import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { validateOwnerLeafWireRequest, validateOwnerLeafWireResult } from "../scripts/lib/pdp-owner-leaf-wire-validation.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const operations = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");
const leafReview = readYaml(".product-experience/pdp-0-product-truth/capability-leaf-review.yaml");
const caps = operations.capabilityOperationContracts;
const overlays = operations.ownerLeafWireContracts;
const leafById = new Map(leafReview.ownerCapabilityLeafAdjudication.records.map((row) => [row.capabilityRef, row]));
const baseById = new Map(caps.records.map((row) => [row.capabilityRef, row]));
const overlayByCapability = new Map(overlays.records.map((row) => [row.capabilityRef, row]));
const passKinds = new Map([
  ["media.simulation.output.rgb", "rgb-image"],
  ["media.simulation.output.depth", "depth-field"],
  ["media.simulation.output.normals", "normal-field"],
  ["media.simulation.output.segmentation", "segmentation-field"],
  ["media.simulation.output.optical-flow", "optical-flow-field"],
  ["media.simulation.output.motion-vectors", "motion-vector-field"],
  ["media.simulation.output.object-ids", "object-id-field"],
  ["media.simulation.output.contacts", "contact-event-set"],
  ["media.simulation.output.physical-events", "physical-event-set"],
  ["media.simulation.output.measurements", "measurement-series"],
  ["media.simulation.output.timestamped-state", "timestamped-state-series"],
]);
const editKinds = new Map([
  ["media.edit.inpaint", "inpaint"],
  ["media.edit.outpaint", "outpaint"],
  ["media.edit.object-remove", "object-remove"],
  ["media.edit.object-replace", "object-replace"],
  ["media.edit.background-remove", "background-remove"],
  ["media.edit.background-replace", "background-replace"],
  ["media.edit.matte", "matte"],
  ["media.edit.relight", "relight"],
  ["media.edit.recolor", "recolor"],
  ["media.edit.colorize", "colorize"],
  ["media.edit.style-transfer", "style-transfer"],
  ["media.edit.retime-slow-motion-speed-ramp", "retime-slow-motion-speed-ramp"],
  ["media.edit.smart-crop-auto-reframe", "smart-crop-auto-reframe"],
  ["media.edit.shot-color-match", "shot-color-match"],
  ["media.edit.region-correction", "region-correction"],
  ["media.edit.face-correction", "face-correction"],
  ["media.edit.hand-correction", "hand-correction"],
  ["media.edit.propagate-keyframe-mask-effect", "propagate-keyframe-mask-effect"],
]);
const simValueFields = new Map([
  ["rgb-image", ["width", "height", "colorSpaceRef", "channelCount", "valueRef"]],
  ["depth-field", ["width", "height", "depthUnitRef", "invalidSamplePolicy", "valueRef"]],
  ["normal-field", ["width", "height", "coordinateFrameRef", "normalization", "valueRef"]],
  ["segmentation-field", ["width", "height", "labelSchemaRef", "backgroundLabelRef", "valueRef"]],
  ["optical-flow-field", ["width", "height", "sourceFrameRef", "targetFrameRef", "vectorUnitRef", "valueRef"]],
  ["motion-vector-field", ["width", "height", "sourceFrameRef", "targetFrameRef", "coordinateFrameRef", "valueRef"]],
  ["object-id-field", ["width", "height", "objectIdentityMapRef", "valueRef"]],
  ["contact-event-set", ["contactSchemaRef", "timeRangeRef", "completeness", "valueRef"]],
  ["physical-event-set", ["eventSchemaRef", "timeRangeRef", "domainMethodRef", "completeness", "valueRef"]],
  ["measurement-series", ["measurementSchemaRef", "unitSystemRef", "timeRangeRef", "domainMethodRef", "valueRef"]],
  ["timestamped-state-series", ["stateSchemaRef", "timebaseRef", "timeRangeRef", "valueRef"]],
]);

function makeAjv() {
  const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true });
  addFormats(ajv);
  const declared = new Map();
  for (const row of caps.scalarTypeRecords ?? []) {
    const { format, pattern } = row.validator ?? {};
    if (!format) continue;
    if (!declared.has(format)) declared.set(format, []);
    if (pattern) declared.get(format).push(pattern);
  }
  const pending = [...overlays.records.flatMap((row) => [row.requestSchema, row.resultSchema])];
  const used = new Set();
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== "object") continue;
    if (typeof node.format === "string") used.add(node.format);
    for (const [key, value] of Object.entries(node)) {
      if (key === "properties" || key === "definitions" || key === "$defs") pending.push(...Object.values(value ?? {}));
      else if (Array.isArray(value)) pending.push(...value);
      else if (value && typeof value === "object") pending.push(value);
    }
  }
  for (const format of used) {
    if (ajv.formats[format]) continue;
    const patterns = declared.get(format);
    assert.ok(patterns, `format ${format} is a declared source scalar format or built-in format`);
    if (patterns.length) {
      assert.ok(patterns.every((pattern) => pattern === patterns[0]), `format ${format} has one stable validator`);
      ajv.addFormat(format, new RegExp(patterns[0], "u"));
    } else {
      ajv.addFormat(format, /^\S(?:[\s\S]*\S)?$/u);
    }
  }
  return ajv;
}

function sample(schema) {
  if (schema.const !== undefined) return structuredClone(schema.const);
  if (schema.enum?.length) return structuredClone(schema.enum[0]);
  if (schema.oneOf?.length) return sample(schema.oneOf[0]);
  if (schema.anyOf?.length) return sample(schema.anyOf[0]);
  if (schema.allOf?.length) {
    const own = { ...schema };
    delete own.allOf;
    return Object.assign({}, sample(own), ...schema.allOf.map(sample));
  }
  if (schema.type === "object" || schema.properties) {
    const value = {};
    for (const key of schema.required ?? []) value[key] = sample(schema.properties?.[key] ?? {});
    return value;
  }
  if (schema.type === "array") return Array.from({ length: schema.minItems ?? 0 }, () => sample(schema.items ?? {}));
  if (schema.type === "integer" || schema.type === "number") return schema.minimum ?? 0;
  if (schema.type === "boolean") return false;
  if (schema.type === "null") return null;
  if (schema.type === "string") {
    if (schema.format === "date-time") return "2026-10-09T12:00:00Z";
    if (schema.pattern?.includes("sha256:")) return `sha256:${"a".repeat(64)}`;
    if (schema.pattern?.includes("64")) return "a".repeat(64);
    const candidates = ["id-1", "v-1", "ref:one", "request-1", "image/png", "video/mp4", "application/json", "media.profile-1", "en-US", "x"];
    if (schema.pattern) {
      const matching = candidates.find((candidate) => new RegExp(schema.pattern).test(candidate));
      if (matching) return matching;
      throw new Error(`No test value satisfies pattern ${schema.pattern}`);
    }
    return "x".repeat(schema.minLength ?? 1);
  }
  return {};
}

function outputSchema(contract) {
  return contract.resultSchema.properties.outputs.items;
}

function pathValue(value, ref) {
  const tokens = ref.replace(/^\$\.?/u, "").match(/[^.[\]]+|\[(\d+)\]/gu) ?? [];
  return tokens.reduce((current, token) => {
    const key = token.startsWith("[") ? Number(token.slice(1, -1)) : token;
    return current?.[key];
  }, value);
}

function setPath(value, ref, next) {
  const tokens = ref.replace(/^\$\.?/u, "").match(/[^.[\]]+|\[(\d+)\]/gu) ?? [];
  const last = tokens.pop();
  const parent = tokens.reduce((current, token) => current[token.startsWith("[") ? Number(token.slice(1, -1)) : token], value);
  parent[last.startsWith("[") ? Number(last.slice(1, -1)) : last] = next;
}

function deletePath(value, ref) {
  const tokens = ref.replace(/^\$\.?/u, "").match(/[^.[\]]+|\[(\d+)\]/gu) ?? [];
  const last = tokens.pop();
  const parent = tokens.reduce((current, token) => current[token.startsWith("[") ? Number(token.slice(1, -1)) : token], value);
  return delete parent[last.startsWith("[") ? Number(last.slice(1, -1)) : last];
}

function pathsForSchemaFormat(schema, value, prefix = "$") {
  if (!schema || value === undefined || value === null) return [];
  if (schema.format && typeof value === "string") return [prefix];
  if (schema.properties && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(schema.properties).flatMap(([key, child]) => pathsForSchemaFormat(child, value[key], `${prefix}.${key}`));
  }
  if (schema.items && Array.isArray(value)) {
    return value.flatMap((entry, index) => pathsForSchemaFormat(schema.items, entry, `${prefix}[${index}]`));
  }
  const branch = schema.oneOf?.find((candidate) => pathsForSchemaFormat(candidate, value, prefix).length) ??
    schema.anyOf?.find((candidate) => pathsForSchemaFormat(candidate, value, prefix).length);
  return branch ? pathsForSchemaFormat(branch, value, prefix) : [];
}

function validateCrossFields(contract, request, result) {
  if (result.outcome !== "SUCCEEDED") return Array.isArray(result.outputs) && result.outputs.length === 0;
  const rules = contract.crossFieldRules;
  if (!Array.isArray(rules) || rules.length === 0) return false;
  return rules.every((rule) => {
    if (rule.mismatch !== "REJECT" || rule.missing !== "REJECT") return false;
    const context = { request, result, contract: { operationRef: contract.operationRef, selectionKind: contract.selectionKind } };
    const left = pathValue(context, rule.leftRef);
    const right = pathValue(context, rule.rightRef);
    if (left === undefined || right === undefined) return false;
    if (rule.expectedConst !== undefined && left !== rule.expectedConst) return false;
    if (rule.operator === "EXACT_EQUAL") return left === right;
    if (rule.operator === "ARRAY_CONTAINS") return Array.isArray(right) && right.includes(left);
    if (rule.operator === "MEDIA_FAMILY_EQUAL") {
      if (typeof left !== "string" || typeof right !== "string") return false;
      const leftFamily = left.split("/", 1)[0];
      const rightFamily = right.split("/", 1)[0];
      return leftFamily === rightFamily && (rule.allowedFamilies ?? []).includes(leftFamily);
    }
    return false;
  });
}

function bindCrossFields(contract, request, result) {
  const context = { request, result, contract: { operationRef: contract.operationRef, selectionKind: contract.selectionKind } };
  for (const rule of contract.crossFieldRules ?? []) {
    const left = pathValue(context, rule.leftRef);
    if (left === undefined) throw new Error(`${rule.id} has no exact source value at ${rule.leftRef}`);
    if (rule.operator === "ARRAY_CONTAINS") {
      const values = pathValue(context, rule.rightRef);
      if (!Array.isArray(values)) throw new Error(`${rule.id} target is not a declared array`);
      if (!values.includes(left)) values.push(left);
    } else if (rule.operator === "MEDIA_FAMILY_EQUAL") {
      const current = pathValue(context, rule.rightRef);
      if (typeof current !== "string" || current.split("/", 1)[0] !== left.split("/", 1)[0]) {
        setPath(context, rule.rightRef, left.replace(/\/[^/]+$/u, "/png"));
      }
    } else if (rule.operator === "EXACT_EQUAL") {
      setPath(context, rule.rightRef, left);
    } else {
      throw new Error(`${rule.id} uses unsupported operation ${rule.operator}`);
    }
  }
  return result;
}

test("all eleven simulation-pass leaves have distinct, operation-bound schemas and typed output shape", () => {
  const rows = overlays.records.filter(({ capabilityRef }) => passKinds.has(capabilityRef));
  assert.equal(rows.length, 11);
  assert.equal(new Set(rows.map(({ id }) => id)).size, 11);
  assert.equal(new Set(rows.map(({ successOutputSchemaRef }) => successOutputSchemaRef)).size, 11);
  const ajv = makeAjv();
  const outputSamples = new Map();

  for (const [capabilityRef, passKind] of passKinds) {
    const contract = overlayByCapability.get(capabilityRef);
    const base = baseById.get(capabilityRef);
    const leaf = leafById.get(capabilityRef);
    assert.ok(contract && base && leaf, `${capabilityRef} resolves through owner, base and leaf sources`);
    assert.equal(contract.capabilityRef, capabilityRef);
    assert.equal(contract.operationRef, base.operationRefs[0]);
    assert.equal(contract.id, leaf.ownerLeafWireContractRef);
    assert.ok(leaf.exactTypedOutputSchemaRefs.includes(contract.successOutputSchemaRef));
    assert.equal(contract.requestSchema.properties.input2.properties.payload.properties.passKind.const, passKind);
    assert.equal(contract.requestSchema.properties.input2.properties.payload.required.includes("passKind"), true);
    assert.equal(contract.requestSchema.properties.input2.properties.payload.required.includes("profileId"), true);
    assert.equal(contract.requestSchema.properties.input2.properties.payload.required.includes("profileVersion"), true);
    assert.equal(contract.resultSchema.properties.provenance.properties.operationRef.const, contract.operationRef);
    const profileBindings = contract.crossFieldRules.filter(({ id }) => id.endsWith("profile-id-output")
      || id.endsWith("profile-version-output") || id.endsWith("profile-id-provenance") || id.endsWith("profile-version-provenance"));
    assert.equal(profileBindings.length, 4, `${capabilityRef} binds profile identity and version to output and provenance`);
    assert.ok(contract.resultSchema.properties.provenance.required.includes("profileId"));
    assert.ok(contract.resultSchema.properties.provenance.required.includes("profileVersion"));
    assert.ok(contract.requestFieldRules.some((rule) => rule.scope === "REQUEST_ALWAYS"
      && rule.leftRef === "$.request.input2.payload.passContractRef"
      && rule.rightRef === "$.request.parameters.passContractRef"
      && rule.operator === "EXACT_EQUAL"), `${capabilityRef} binds selected pass contract to operation parameter`);

    const item = outputSchema(contract);
    const payload = item.properties.payload;
    assert.notEqual(item.properties.artifactType.const, "typed-simulation-pass-with-produced-versus-estimated-provenance",
      `${capabilityRef} must expose a leaf-specific artifact discriminator`);
    assert.equal(payload.properties.passKind.const, passKind);
    assert.equal(payload.required.includes("productionStatus"), true);
    assert.deepEqual(payload.properties.productionStatus.enum, ["PRODUCED", "ESTIMATED"]);
    for (const field of ["mediaRunRef", "simulationStateInputRef", "simulationPlanRef", "passContractRef", "productionEvidenceRef", "value"])
      assert.ok(payload.required.includes(field), `${capabilityRef} binds ${field}`);
    for (const field of simValueFields.get(passKind)) assert.ok(payload.properties.value.required.includes(field), `${capabilityRef} value requires ${field}`);
    for (const field of ["operationRef", "observedAt", "sourceRefs", "profileId", "profileVersion"])
      assert.ok(contract.resultSchema.properties.provenance.required.includes(field), `${capabilityRef} provenance requires ${field}`);
    assert.equal(contract.definitionStatus, "OWNER_DEFINED_DEFINITION_ONLY");
    assert.equal(contract.executionAdmission, "NOT_ADMITTED");
    assert.equal(contract.qualificationState, "NOT_EVALUATED");

    const inputValidate = ajv.compile(contract.requestSchema);
    const input = sample(contract.requestSchema);
    assert.equal(inputValidate(input), true, `${capabilityRef} has a schema-valid positive request fixture`);
    assert.equal(validateOwnerLeafWireRequest(contract, input).valid, true,
      `${capabilityRef} owner validator accepts its selected pass-contract request`);
    const contradictoryPassContract = structuredClone(input);
    contradictoryPassContract.parameters.passContractRef = `${contradictoryPassContract.input2.payload.passContractRef}-other`;
    assert.equal(inputValidate(contradictoryPassContract), true,
      `${capabilityRef} mismatch remains schema-valid so typed request rule must reject it`);
    assert.equal(validateOwnerLeafWireRequest(contract, contradictoryPassContract).valid, false,
      `${capabilityRef} rejects a different pass contract between input2 and parameters`);
    for (const path of new Set(pathsForSchemaFormat(contract.requestSchema, input))) {
      const whitespaceReference = structuredClone(input);
      setPath(whitespaceReference, path, "   ");
      assert.equal(inputValidate(whitespaceReference), false, `${capabilityRef} rejects whitespace-only formatted value at ${path}`);
      assert.equal(validateOwnerLeafWireRequest(contract, whitespaceReference).valid, false,
        `${capabilityRef} owner validator rejects whitespace-only formatted value at ${path}`);
    }
    const wrongInputPass = structuredClone(input);
    wrongInputPass.input2.payload.passKind = "unregistered-pass-kind";
    assert.equal(inputValidate(wrongInputPass), false, `${capabilityRef} rejects an unknown requested pass`);
    const missingInputPass = structuredClone(input);
    delete missingInputPass.input2.payload.passKind;
    assert.equal(inputValidate(missingInputPass), false, `${capabilityRef} rejects an omitted requested pass`);

    const itemValidate = ajv.compile(item);
    const positiveOutput = sample(item);
    assert.equal(itemValidate(positiveOutput), true, `${capabilityRef} has a schema-valid positive output fixture`);
    const wrongOutputPass = structuredClone(positiveOutput);
    wrongOutputPass.payload.passKind = "unregistered-pass-kind";
    assert.equal(itemValidate(wrongOutputPass), false, `${capabilityRef} rejects an unknown produced pass`);
    const missingEvidence = structuredClone(positiveOutput);
    delete missingEvidence.payload.productionEvidenceRef;
    assert.equal(itemValidate(missingEvidence), false, `${capabilityRef} rejects output without production evidence`);
    const guessedTruth = structuredClone(positiveOutput);
    guessedTruth.payload.productionStatus = "GROUND_TRUTH";
    assert.equal(itemValidate(guessedTruth), false, `${capabilityRef} cannot coerce estimated output into ground truth`);
    const resultValidate = ajv.compile(contract.resultSchema);
    const positiveResult = sample(contract.resultSchema);
    positiveResult.outcome = "SUCCEEDED";
    positiveResult.outputs = [positiveOutput];
    positiveResult.provenance.operationRef = contract.operationRef;
    bindCrossFields(contract, input, positiveResult);
    assert.equal(resultValidate(positiveResult), true, `${capabilityRef} has a valid success receipt`);
    const differentProfileSameVersion = structuredClone(positiveResult);
    differentProfileSameVersion.outputs[0].payload.profileId = `${input.input2.payload.profileId}-different`;
    assert.equal(resultValidate(differentProfileSameVersion), true,
      `${capabilityRef} same-version/different-profile mutation remains shape-valid`);
    assert.equal(validateOwnerLeafWireResult(contract, input, differentProfileSameVersion).valid, false,
      `${capabilityRef} rejects output for a different profile even when the version is unchanged`);
    const differentProvenanceProfile = structuredClone(positiveResult);
    differentProvenanceProfile.provenance.profileId = `${input.input2.payload.profileId}-different`;
    assert.equal(resultValidate(differentProvenanceProfile), true,
      `${capabilityRef} provenance profile mismatch remains shape-valid`);
    assert.equal(validateOwnerLeafWireResult(contract, input, differentProvenanceProfile).valid, false,
      `${capabilityRef} rejects provenance for a different profile`);
    const wrongReceipt = structuredClone(positiveResult);
    wrongReceipt.provenance.operationRef = "media.operation.unknown";
    assert.equal(resultValidate(wrongReceipt), false, `${capabilityRef} rejects a mismatched operation receipt`);
    const rejectedWithOutput = structuredClone(positiveResult);
    rejectedWithOutput.outcome = "REJECTED";
    assert.equal(resultValidate(rejectedWithOutput), false, `${capabilityRef} cannot attach a success pass to REJECTED`);
    const unknownWithOutput = structuredClone(positiveResult);
    unknownWithOutput.outcome = "UNKNOWN_OUTCOME";
    assert.equal(resultValidate(unknownWithOutput), false, `${capabilityRef} cannot attach a success pass to UNKNOWN_OUTCOME`);
    const noPassResult = structuredClone(positiveResult);
    noPassResult.outputs = [];
    noPassResult.outcome = "UNKNOWN_OUTCOME";
    assert.equal(resultValidate(noPassResult), true, `${capabilityRef} preserves unknown effect without an output claim`);
    assert.equal(validateOwnerLeafWireResult(contract, input, noPassResult).valid, true,
      `${capabilityRef} definition oracle accepts a valid unknown outcome without output finality`);
    assert.equal(validateOwnerLeafWireResult(contract, input, positiveResult).valid, true,
      `${capabilityRef} owner wire validator consumes the exact leaf overlay`);
    const invalidDate = structuredClone(positiveResult);
    invalidDate.observedAt = "2026-02-30T12:00:00Z";
    invalidDate.provenance.observedAt = "2026-02-30T12:00:00Z";
    assert.equal(resultValidate(invalidDate), false, `${capabilityRef} rejects an impossible observedAt date`);
    assert.equal(validateOwnerLeafWireResult(contract, input, invalidDate).valid, false,
      `${capabilityRef} owner validator rejects an impossible observedAt date`);
    assert.equal(validateCrossFields(contract, input, positiveResult), true, `${capabilityRef} cross-field bindings hold`);
    for (const rule of contract.crossFieldRules) {
      const wrong = structuredClone(positiveResult);
      const wrongRequest = structuredClone(input);
      const wrongContext = { request: wrongRequest, result: wrong, contract: { operationRef: contract.operationRef } };
      if (rule.operator === "ARRAY_CONTAINS") {
        const left = pathValue(wrongContext, rule.leftRef);
        const right = pathValue(wrongContext, rule.rightRef);
        right.splice(0, right.length, ...right.filter((entry) => entry !== left));
      } else if (rule.operator === "MEDIA_FAMILY_EQUAL") {
        const left = pathValue(wrongContext, rule.leftRef);
        setPath(wrongContext, rule.rightRef, left.startsWith("image/") ? "video/mp4" : "image/png");
      } else {
        const right = pathValue(wrongContext, rule.rightRef);
        setPath(wrongContext, rule.rightRef, `${right}-wrong`);
      }
      assert.equal(validateCrossFields(contract, wrongRequest, wrong), false, `${rule.id} rejects a material mismatch`);
      assert.equal(validateOwnerLeafWireResult(contract, wrongRequest, wrong).valid, false, `${rule.id} validator rejects a material mismatch`);
      const missing = structuredClone(positiveResult);
      const missingRequest = structuredClone(input);
      const missingContext = { request: missingRequest, result: missing, contract: { operationRef: contract.operationRef } };
      deletePath(missingContext, rule.rightRef);
      assert.equal(validateCrossFields(contract, missingRequest, missing), false, `${rule.id} rejects a missing binding`);
      assert.equal(validateOwnerLeafWireResult(contract, missingRequest, missing).valid, false, `${rule.id} validator rejects a missing binding`);
    }
    outputSamples.set(capabilityRef, { itemValidate, positiveOutput });
  }

  for (const [sourceRef, { positiveOutput }] of outputSamples) {
    for (const [targetRef, targetContract] of overlayByCapability) {
      if (!passKinds.has(targetRef) || targetRef === sourceRef) continue;
      assert.equal(ajv.compile(outputSchema(targetContract))(positiveOutput), false,
        `${sourceRef} output schema must not be accepted as ${targetRef}`);
    }
  }
  for (const [sourceRef] of passKinds) {
    const source = overlayByCapability.get(sourceRef);
    const fixture = sample(source.requestSchema);
    for (const [targetRef] of passKinds) {
      if (sourceRef === targetRef) continue;
      assert.equal(ajv.compile(overlayByCapability.get(targetRef).requestSchema)(fixture), false,
        `${sourceRef} request must not validate as ${targetRef}`);
    }
  }
});

test("all eighteen edit leaves constrain operation kind, preservation, versions, outputs and cross-field identity", () => {
  const rows = overlays.records.filter(({ capabilityRef }) => editKinds.has(capabilityRef));
  assert.equal(rows.length, 18);
  assert.equal(new Set(rows.map(({ id }) => id)).size, 18);
  assert.equal(new Set(rows.map(({ successOutputSchemaRef }) => successOutputSchemaRef)).size, 18);
  const ajv = makeAjv();
  const outputSamples = new Map();

  for (const [capabilityRef, editKind] of editKinds) {
    const contract = overlayByCapability.get(capabilityRef);
    const base = baseById.get(capabilityRef);
    const leaf = leafById.get(capabilityRef);
    assert.ok(contract && base && leaf, `${capabilityRef} resolves through owner, base and leaf sources`);
    assert.equal(contract.operationRef, base.operationRefs[0]);
    assert.equal(contract.id, leaf.ownerLeafWireContractRef);
    assert.ok(leaf.exactTypedOutputSchemaRefs.includes(contract.successOutputSchemaRef));

    const inputPayload = contract.requestSchema.properties.input2.properties.payload;
    assert.equal(contract.selectionKind, inputPayload.properties.selectionKind.const);
    assert.equal(inputPayload.properties.editKind.const, editKind);
    assert.ok(inputPayload.required.includes("editKind"));
    assert.ok(inputPayload.required.includes("sourceArtifactVersionRef"));
    assert.ok(inputPayload.required.includes("preservationPolicy"));
    assert.equal(inputPayload.properties.preservationPolicy.properties.unselectedContent.const, "PRESERVE");
    assert.ok(inputPayload.properties.preservationPolicy.properties.preservedPropertyRefs.minItems >= 1);
    assert.ok(inputPayload.properties.editParameters.required.length > 0, `${capabilityRef} has typed operation-specific controls`);
    assert.equal(inputPayload.properties.editParameters.additionalProperties, false);

    const item = outputSchema(contract);
    const outputBranches = item.properties.payload.oneOf;
    assert.ok(outputBranches.length >= 1);
    for (const branch of outputBranches) {
      assert.equal(branch.properties.editKind.const, editKind);
      for (const field of ["sourceArtifactVersionRef", "changeRecordRef", "provenanceRef"])
        assert.ok(branch.required.includes(field), `${capabilityRef} output binds ${field}`);
    }
    assert.equal(contract.positiveValidation.requiredSourceVersionBinding,
      "request sourceArtifactVersionRef equals result sourceArtifactVersionRef");
    assert.ok(Array.isArray(contract.crossFieldRules) && contract.crossFieldRules.length > 0,
      `${capabilityRef} has executable exact identity/version cross-field rules`);

    const requestValidate = ajv.compile(contract.requestSchema);
    const request = sample(contract.requestSchema);
    assert.equal(requestValidate(request), true, `${capabilityRef} has a valid positive request`);
    for (const path of new Set(pathsForSchemaFormat(contract.requestSchema, request))) {
      const whitespaceReference = structuredClone(request);
      setPath(whitespaceReference, path, "   ");
      assert.equal(requestValidate(whitespaceReference), false, `${capabilityRef} rejects whitespace-only formatted value at ${path}`);
      assert.equal(validateOwnerLeafWireRequest(contract, whitespaceReference).valid, false,
        `${capabilityRef} owner validator rejects whitespace-only formatted value at ${path}`);
    }
    const wrongEdit = structuredClone(request);
    wrongEdit.input2.payload.editKind = "some-other-edit";
    assert.equal(requestValidate(wrongEdit), false, `${capabilityRef} rejects another edit kind`);
    const unpreserved = structuredClone(request);
    unpreserved.input2.payload.preservationPolicy.unselectedContent = "ALTER";
    assert.equal(requestValidate(unpreserved), false, `${capabilityRef} rejects loss of unselected content`);
    for (const control of inputPayload.properties.editParameters.required) {
      const missingControl = structuredClone(request);
      delete missingControl.input2.payload.editParameters[control];
      assert.equal(requestValidate(missingControl), false, `${capabilityRef} rejects missing operation-specific control ${control}`);
    }
    for (const [control, schema] of Object.entries(inputPayload.properties.editParameters.properties)) {
      if (schema.maximum !== undefined) {
        const outOfRange = structuredClone(request);
        outOfRange.input2.payload.editParameters[control] = schema.maximum + 1;
        assert.equal(requestValidate(outOfRange), false, `${capabilityRef} rejects ${control} above its declared bound`);
      }
      if (schema.minimum !== undefined) {
        const outOfRange = structuredClone(request);
        outOfRange.input2.payload.editParameters[control] = schema.minimum - 1;
        assert.equal(requestValidate(outOfRange), false, `${capabilityRef} rejects ${control} below its declared bound`);
      }
    }
    const unknownControl = structuredClone(request);
    unknownControl.input2.payload.editParameters.undeclaredControl = true;
    assert.equal(requestValidate(unknownControl), false, `${capabilityRef} rejects undeclared edit controls`);

    const itemValidate = ajv.compile(item);
    const positiveOutput = sample(item);
    assert.equal(itemValidate(positiveOutput), true, `${capabilityRef} has a valid positive output`);
    const wrongEditOutput = structuredClone(positiveOutput);
    wrongEditOutput.payload.oneOf?.[0]?.editKind && (wrongEditOutput.payload.oneOf[0].editKind = "wrong");
    if (wrongEditOutput.payload.editKind) wrongEditOutput.payload.editKind = "wrong";
    assert.equal(itemValidate(wrongEditOutput), false, `${capabilityRef} rejects a result for a different edit kind`);
    const resultValidate = ajv.compile(contract.resultSchema);
    const positiveResult = sample(contract.resultSchema);
    positiveResult.outcome = "SUCCEEDED";
    positiveResult.outputs = [positiveOutput];
    positiveResult.provenance.operationRef = contract.operationRef;
    bindCrossFields(contract, request, positiveResult);
    assert.equal(resultValidate(positiveResult), true, `${capabilityRef} has a valid success receipt`);
    assert.equal(validateCrossFields(contract, request, positiveResult), true, `${capabilityRef} source/result identities match`);
    assert.equal(validateOwnerLeafWireResult(contract, request, positiveResult).valid, true,
      `${capabilityRef} definition oracle accepts the exact leaf contract`);
    const invalidDate = structuredClone(positiveResult);
    invalidDate.observedAt = "2026-02-30T12:00:00Z";
    invalidDate.provenance.observedAt = "2026-02-30T12:00:00Z";
    assert.equal(resultValidate(invalidDate), false, `${capabilityRef} rejects an impossible observedAt date`);
    assert.equal(validateOwnerLeafWireResult(contract, request, invalidDate).valid, false,
      `${capabilityRef} owner validator rejects an impossible observedAt date`);
    for (const rule of contract.crossFieldRules) {
      const mismatch = structuredClone(positiveResult);
      const mismatchContract = structuredClone(contract);
      const mismatchRequest = structuredClone(request);
      const mismatchContext = { request: mismatchRequest, result: mismatch, contract: mismatchContract };
      if (rule.operator === "MEDIA_FAMILY_EQUAL") {
        const left = pathValue(mismatchContext, rule.leftRef);
        setPath(mismatchContext, rule.rightRef, left.startsWith("image/") ? "video/mp4" : "image/png");
      } else if (rule.operator === "ARRAY_CONTAINS") {
        const left = pathValue(mismatchContext, rule.leftRef);
        const right = pathValue(mismatchContext, rule.rightRef);
        right.splice(0, right.length, ...right.filter((entry) => entry !== left));
      } else {
        const right = pathValue(mismatchContext, rule.rightRef);
        setPath(mismatchContext, rule.rightRef, `${right}-wrong`);
      }
      assert.equal(validateOwnerLeafWireResult(mismatchContract, mismatchRequest, mismatch).valid, false, `${rule.id} rejects its mismatched value`);
      const missing = structuredClone(positiveResult);
      const missingContract = structuredClone(contract);
      const missingRequest = structuredClone(request);
      deletePath({ request: missingRequest, result: missing, contract: missingContract }, rule.rightRef);
      assert.equal(validateOwnerLeafWireResult(missingContract, missingRequest, missing).valid, false, `${rule.id} rejects a missing value`);
    }
    const failedWithOutput = structuredClone(positiveResult);
    failedWithOutput.outcome = "UNKNOWN_OUTCOME";
    assert.equal(resultValidate(failedWithOutput), false, `${capabilityRef} unknown result carries no output`);
    const unknownWithoutOutput = structuredClone(positiveResult);
    unknownWithoutOutput.outcome = "UNKNOWN_OUTCOME";
    unknownWithoutOutput.outputs = [];
    assert.equal(resultValidate(unknownWithoutOutput), true, `${capabilityRef} preserves unknown outcome without outputs`);
    const unknownCheck = validateOwnerLeafWireResult(contract, request, unknownWithoutOutput);
    assert.equal(unknownCheck.valid, true,
      `${capabilityRef} validator applies cross-field rules only to successful output finality: ${JSON.stringify(unknownCheck)}`);

    for (const [branchIndex, branch] of outputBranches.entries()) {
      const branchOutput = sample(branch);
      const branchResult = structuredClone(positiveResult);
      branchResult.outputs = [{ artifactType: item.properties.artifactType.const, payload: branchOutput }];
      bindCrossFields(contract, request, branchResult);
      assert.equal(validateOwnerLeafWireResult(contract, request, branchResult).valid, true,
        `${capabilityRef} accepts declared output branch ${branchIndex}`);
      const wrongVersion = structuredClone(branchResult);
      const versionRule = contract.crossFieldRules.find(({ id }) => id.includes("source-version"));
      if (versionRule) {
        const context = { request, result: wrongVersion, contract: { operationRef: contract.operationRef, selectionKind: contract.selectionKind } };
        const current = pathValue(context, versionRule.rightRef);
        setPath(context, versionRule.rightRef, `${current}-wrong`);
        assert.equal(validateOwnerLeafWireResult(contract, request, wrongVersion).valid, false,
          `${capabilityRef} rejects wrong source version in branch ${branchIndex}`);
      }
    }
    outputSamples.set(capabilityRef, { positiveOutput });
  }

  for (const [sourceRef, { positiveOutput }] of outputSamples) {
    for (const [targetRef, targetContract] of overlayByCapability) {
      if (!editKinds.has(targetRef) || targetRef === sourceRef) continue;
      assert.equal(ajv.compile(outputSchema(targetContract))(positiveOutput), false,
        `${sourceRef} output must not validate as ${targetRef}`);
    }
  }
  for (const [sourceRef] of editKinds) {
    const source = overlayByCapability.get(sourceRef);
    const fixture = sample(source.requestSchema);
    for (const [targetRef] of editKinds) {
      if (sourceRef === targetRef) continue;
      assert.equal(ajv.compile(overlayByCapability.get(targetRef).requestSchema)(fixture), false,
        `${sourceRef} request must not validate as ${targetRef}`);
    }
  }
});
