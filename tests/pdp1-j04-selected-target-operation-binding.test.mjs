import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateSelectedTargetOperationRequest } from "../scripts/lib/pdp-selected-target-operation-binding.mjs";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const source = parse(await readFile(".product-experience/pdp-1-domain-data/operations.yaml", "utf8"));
const wire = parse(await readFile(".product-experience/pdp-1-domain-data/owner-action-wire-contracts.yaml", "utf8"));
const wrapper = source.ownerDefinedOperationContracts.records.find(({ id }) => id === "media.operation.action.request-admitted-speech-operation");
const normalizedWrapper = wire.records.find(({ id }) => id === "media.owner-action-wire.request-admitted-speech-operation.v1");
const target = source.capabilityOperationContracts.records.find(({ id }) => id === "media.operation.capability.media-speech-synthesis-text-to-speech");
const targetRecords = source.capabilityOperationContracts.records;
const TARGET_REF = target.id;
const TTS_REQUEST_SCHEMA_REF = `.product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/records/@id=${target.id}/requestSchema`;
const TTS_RESULT_SCHEMA_REF = `.product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/records/@id=${target.id}/resultSchema`;

const request = () => ({
  requestId: "speech-request-01",
  exactTargetRefs: [{ objectRef: "media.domain.artifact-version", artifactId: "text-01", versionId: "text-v3" }],
  admittedOperationRef: wrapper.id,
  selectedTargetCapabilityRef: target.capabilityRef,
  selectedTargetOperationRef: target.id,
  selectedTargetOperationVersion: target.operationVersion,
  selectedTargetRequestSchemaRef: TTS_REQUEST_SCHEMA_REF,
  selectedTargetResultSchemaRef: TTS_RESULT_SCHEMA_REF,
  selectedTargetRequest: {
    input1: { artifactType: "text-or-speech-intent", payload: { kind: "text", text: "Hello there", locale: "en-US" } },
    parameters: { outputProfileRef: "profile://speech/default@v3", outputLanguage: "en-US" },
    requestId: "speech-request-01",
  },
  explicitConfirmation: { confirmationRef: "confirmation://speech-request-01" },
});

const validate = (nextRequest = request(), records = targetRecords, operation = wrapper) =>
  validateSelectedTargetOperationRequest({
    wrapper: operation,
    request: nextRequest,
    targetOperationRecords: records,
    operationsSource: source,
  });

test("J04 wrapper binds an explicit exact COMMAND target while preserving wrapper identity", () => {
  assert.deepEqual(validate(), { valid: true, reason: "EXACT_SELECTED_COMMAND_AND_SEPARATE_RESULT_BOUND" });
  assert.equal(wrapper.requestSchema.properties.admittedOperationRef.const, wrapper.id);
  assert.equal(wrapper.requestSchema.properties.admittedOperationRef.mustMatchActionDefinition, true);
  assert.equal(request().admittedOperationRef, "media.operation.action.request-admitted-speech-operation");
  assert.equal(request().selectedTargetOperationRef, TARGET_REF);
  assert.equal(target.operationKind, "COMMAND");
  assert.equal(request().selectedTargetOperationVersion, 1);
  assert.equal(wrapper.selectedTargetOperationBinding.selection.startsWith("TRUSTED_EXPLICIT_USER_SELECTION_REQUIRED"), true);
});

test("J04 rejects wrapper/action identity substitution, wrong target, and target ambiguity", () => {
  const wrongAction = request();
  wrongAction.admittedOperationRef = TARGET_REF;
  assert.equal(validate(wrongAction).reason, "ACTION_WRAPPER_IDENTITY_MISMATCH");

  const wrongTarget = request();
  wrongTarget.selectedTargetOperationRef = "media.operation.action.request-admitted-speech-operation";
  assert.equal(validate(wrongTarget).reason, "RECURSIVE_OR_WRAPPER_TARGET_REJECTED");

  assert.equal(validate(request(), [...targetRecords, structuredClone(target)]).reason, "SELECTED_TARGET_NOT_UNIQUE");
});

test("J04 rejects QUERY, recursive, version-mismatched, and schema-mismatched targets", () => {
  const queryTarget = structuredClone(target);
  queryTarget.operationKind = "QUERY";
  assert.equal(validate(request(), [queryTarget]).reason, "SELECTED_TARGET_IDENTITY_OR_SCHEMA_MISMATCH");

  const recursiveTarget = structuredClone(target);
  recursiveTarget.operationRefs = [target.id, wrapper.id];
  assert.equal(validate(request(), [recursiveTarget]).reason, "SELECTED_TARGET_IDENTITY_OR_SCHEMA_MISMATCH");

  const wrongVersion = request();
  wrongVersion.selectedTargetOperationVersion = 2;
  assert.equal(validate(wrongVersion).reason, "SELECTED_TARGET_IDENTITY_OR_SCHEMA_MISMATCH");

  const wrongRequestSchema = request();
  wrongRequestSchema.selectedTargetRequestSchemaRef = "operations.yaml#some-other-request-schema";
  assert.equal(validate(wrongRequestSchema).reason, "SELECTED_TARGET_IDENTITY_OR_SCHEMA_MISMATCH");

  const wrongResultSchema = request();
  wrongResultSchema.selectedTargetResultSchemaRef = "operations.yaml#some-other-result-schema";
  assert.equal(validate(wrongResultSchema).reason, "SELECTED_TARGET_IDENTITY_OR_SCHEMA_MISMATCH");

  const orderedWorkflow = structuredClone(target);
  orderedWorkflow.isOrderedWorkflow = true;
  assert.equal(validate(request(), [orderedWorkflow]).reason, "SELECTED_TARGET_IDENTITY_OR_SCHEMA_MISMATCH");
  assert.equal(validate(request(), []).reason, "SELECTED_TARGET_NOT_UNIQUE");
});

test("J04 fails closed when the selected target result schema is missing or unresolved", () => {
  const missingSchemaSource = structuredClone(source);
  const missingSchemaTarget = missingSchemaSource.capabilityOperationContracts.records
    .find(({ id }) => id === target.id);
  delete missingSchemaTarget.resultSchema;
  assert.equal(validateSelectedTargetOperationRequest({
    wrapper,
    request: request(),
    targetOperationRecords: [missingSchemaTarget],
    operationsSource: missingSchemaSource,
  }).reason, "UNKNOWN_TARGET_SCHEMA");

  const unknownResultSource = structuredClone(source);
  const unknownResultTarget = unknownResultSource.capabilityOperationContracts.records
    .find(({ id }) => id === target.id);
  unknownResultTarget.successOutputs[0].payloadSchemaRef = "media.payload-schema.unknown-j04-result";
  assert.equal(validateSelectedTargetOperationRequest({
    wrapper,
    request: request(),
    targetOperationRecords: [unknownResultTarget],
    operationsSource: unknownResultSource,
  }).reason, "UNKNOWN_TARGET_RESULT");
});

test("J04 rejects caller-supplied target version and identity spoofing against the canonical source record", () => {
  const forgedVersion = structuredClone(target);
  forgedVersion.operationVersion = 99;
  const forgedVersionRequest = request();
  forgedVersionRequest.selectedTargetOperationVersion = 99;
  assert.equal(validate(forgedVersionRequest, [forgedVersion]).reason,
    "SELECTED_TARGET_IDENTITY_OR_SCHEMA_MISMATCH");

  const forgedIdentity = structuredClone(target);
  forgedIdentity.capabilityRef = "media.speech.synthesis.transcription";
  const forgedIdentityRequest = request();
  forgedIdentityRequest.selectedTargetCapabilityRef = forgedIdentity.capabilityRef;
  assert.equal(validate(forgedIdentityRequest, [forgedIdentity]).reason,
    "SELECTED_TARGET_IDENTITY_OR_SCHEMA_MISMATCH");

  const forgedOperationRef = structuredClone(target);
  forgedOperationRef.operationRefs = ["media.operation.capability.media-speech-synthesis-speech-to-text"];
  assert.equal(validate(request(), [forgedOperationRef]).reason,
    "SELECTED_TARGET_IDENTITY_OR_SCHEMA_MISMATCH");
});

test("J04 regression cases cover every declared selected-target reject condition", () => {
  assert.deepEqual(wrapper.selectedTargetOperationBinding.reject, [
    "QUERY_TARGET",
    "ORDERED_WORKFLOW_TARGET",
    "MISSING_OR_AMBIGUOUS_TARGET",
    "WRAPPER_SELF_TARGET",
    "RECURSIVE_WRAPPER_TARGET",
    "TARGET_VERSION_MISMATCH",
    "REQUEST_SCHEMA_MISMATCH",
    "RESULT_SCHEMA_MISMATCH",
    "UNKNOWN_TARGET_SCHEMA",
    "UNKNOWN_TARGET_RESULT",
  ]);
  assert.equal(validate(request(), [structuredClone(target)]).valid, true);
  assert.equal(validate(request(), []).reason, "SELECTED_TARGET_NOT_UNIQUE");
  const selfTarget = request();
  selfTarget.selectedTargetOperationRef = wrapper.id;
  assert.equal(validate(selfTarget).reason, "RECURSIVE_OR_WRAPPER_TARGET_REJECTED");
  const recursiveTarget = structuredClone(target);
  recursiveTarget.operationRefs = [target.id, wrapper.id];
  assert.equal(validate(request(), [recursiveTarget]).reason, "SELECTED_TARGET_IDENTITY_OR_SCHEMA_MISMATCH");
  const queryTarget = structuredClone(target);
  queryTarget.operationKind = "QUERY";
  assert.equal(validate(request(), [queryTarget]).reason, "SELECTED_TARGET_IDENTITY_OR_SCHEMA_MISMATCH");
  const orderedWorkflow = structuredClone(target);
  orderedWorkflow.isOrderedWorkflow = true;
  assert.equal(validate(request(), [orderedWorkflow]).reason, "SELECTED_TARGET_IDENTITY_OR_SCHEMA_MISMATCH");
  const wrongVersion = request();
  wrongVersion.selectedTargetOperationVersion += 1;
  assert.equal(validate(wrongVersion).reason, "SELECTED_TARGET_IDENTITY_OR_SCHEMA_MISMATCH");
  const wrongRequestSchema = request();
  wrongRequestSchema.selectedTargetRequestSchemaRef = "unknown-request-schema";
  assert.equal(validate(wrongRequestSchema).reason, "SELECTED_TARGET_IDENTITY_OR_SCHEMA_MISMATCH");
  const wrongResultSchema = request();
  wrongResultSchema.selectedTargetResultSchemaRef = "unknown-result-schema";
  assert.equal(validate(wrongResultSchema).reason, "SELECTED_TARGET_IDENTITY_OR_SCHEMA_MISMATCH");
  const missingResultSchema = structuredClone(source);
  delete missingResultSchema.capabilityOperationContracts.records.find(({ id }) => id === target.id).resultSchema;
  assert.equal(validateSelectedTargetOperationRequest({
    wrapper, request: request(), targetOperationRecords: targetRecords, operationsSource: missingResultSchema,
  }).reason, "UNKNOWN_TARGET_SCHEMA");
  const unknownResult = structuredClone(source);
  unknownResult.capabilityOperationContracts.records.find(({ id }) => id === target.id)
    .successOutputs[0].payloadSchemaRef = "media.payload-schema.unknown-j04-result";
  assert.equal(validateSelectedTargetOperationRequest({
    wrapper, request: request(), targetOperationRecords: targetRecords, operationsSource: unknownResult,
  }).reason, "UNKNOWN_TARGET_RESULT");
});

test("J04 validates the nested request against the selected target's exact closed schema", () => {
  const extraField = request();
  extraField.selectedTargetRequest.unreviewedOverride = true;
  assert.equal(validate(extraField).reason, "SELECTED_TARGET_REQUEST_SCHEMA_REJECTED");

  const missingProfile = request();
  delete missingProfile.selectedTargetRequest.parameters.outputProfileRef;
  assert.equal(validate(missingProfile).reason, "SELECTED_TARGET_REQUEST_SCHEMA_REJECTED");
});

test("wrapper receipt cannot be substituted for the separate target result", () => {
  assert.deepEqual(wrapper.resultSchema.fields, ["requestId", "exactTargetRef", "ownerReceipt", "observedAt"]);
  assert.ok(wrapper.selectedTargetOperationBinding.targetResultBoundary.includes("only the wrapper receipt"));
  assert.ok(wrapper.selectedTargetOperationBinding.targetResultBoundary.includes("cannot satisfy"));
  assert.ok(target.resultSchema.required.includes("outputs"));
  assert.ok(wrapper.selectedTargetOperationBinding.targetResultSchemaJoin.includes("separately observed"));
  const success = normalizedWrapper.resultSchema.oneOf[0];
  assert.deepEqual(success.required, ["operationRef", "actionRef", "outcome", "requestId", "targetRefs", "ownerReceipt"]);
  assert.equal(success.properties.outputs, undefined);
  assert.equal(success.properties.targetResult, undefined);
  assert.match(normalizedWrapper.semantics.selectedTargetResultBoundary, /separate exact-schema observation/u);
});

test("normalized owner-action wire contract exposes all selected-target fields as required inputs", () => {
  const required = [
    "selectedTargetCapabilityRef", "selectedTargetOperationRef", "selectedTargetOperationVersion",
    "selectedTargetRequestSchemaRef", "selectedTargetResultSchemaRef", "selectedTargetRequest",
  ];
  for (const field of required) {
    assert.ok(wrapper.requestSchema.required.includes(field), `${field} is source-required`);
    assert.ok(normalizedWrapper.sourceRequiredProperties.includes(field), `${field} is declared required in the normalized source census`);
    assert.ok(normalizedWrapper.requestSchema.required.includes(field), `${field} is required on the normalized wire request`);
    assert.ok(Object.hasOwn(normalizedWrapper.requestSchema.properties, field), `${field} has an explicit normalized shape`);
  }
  assert.equal(normalizedWrapper.requestSchema.properties.admittedOperationRef.const, wrapper.id);
  assert.equal(normalizedWrapper.requestSchema.properties.selectedTargetRequest.$ref, "#/$defs/boundedPreferenceValue");
});
