import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const parse = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml").parse;
const read = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const p0 = read(".product-experience/pdp-0-product-truth/capabilities.yaml");
const p1 = read(".product-experience/pdp-1-domain-data/operations.yaml");
const p0File = p0.capabilities.find(({ id }) => id === "media.speech.transcription.file");
const p1Operation = p1.operations.find(({ id }) => id === "media.operation.transcription-submission");
const binding = p1.capabilityOperationContracts.records.find(({ id }) => id === "media.capability-binding.media-speech-transcription-file");
const slot = p0File.ownerDefinition.typedInputSlots.find(({ slotId }) => slotId === "input2");
const mapping = binding.inputSlotMapping;
const wireSchema = p1Operation.ownerWireSchema.requestSchema.oneOf.find(({ properties }) => properties.requestMode.enum?.includes("SUBMIT_OR_REPLAY"));

test("P0 keeps input2 optional while binding absence is a pre-request negative", () => {
  assert.equal(slot.cardinality, "ZERO_OR_ONE");
  assert.equal(slot.required, false);
  assert.equal(mapping.p0Cardinality, "ZERO_OR_ONE");
  assert.equal(mapping.p0Required, false);
  assert.match(mapping.boundary, /before-construction-of-operation-request/u);
  assert.match(mapping.absent, /UNSUPPORTED_PROFILE.*before-operation-request.*job.*receipt.*dispatch/u);
  assert.match(mapping.absent, /do-not-default-infer-or-map-to-AUTO_REQUESTED/u);
  assert.ok(p1Operation.error.definitivePreDispatchCodes.includes("UNSUPPORTED_PROFILE"));
  const slotFields = ["languageIntent", "profileId", "profileVersion", "profileConfigurationDigest"];
  assert.ok(slotFields.every((field) => p1Operation.inputSemantics.submitRequiredFields.includes(field)), "the source operation still requires the complete mapped slot");
  assert.ok(slotFields.every((field) => wireSchema.required.includes(field)), "the operation request cannot accept a missing profile mapping");
});

test("a present mapping is explicit, exact, and qualified", () => {
  assert.match(mapping.present, /explicit-BCP-47-language-intent-or-explicit-AUTO_REQUESTED-and-exact-profileId-profileVersion-profileConfigurationDigest/u);
  assert.match(mapping.present, /current-for-exact-source-purpose-processingLocation-and-languageIntent/u);
  assert.match(mapping.present, /AUTO_REQUESTED-requires-qualified-language-detection/u);
  assert.equal(binding.parameterSchemaDisposition, "EXACT_P0_PARAMETER_FIELD_MAPPINGS");
  assert.equal(binding.parameterSchemaSourceRef, ".product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.speech.transcription.file/ownerDefinition/parameterSchema");
  const intentBranches = wireSchema.properties.languageIntent.oneOf;
  const explicit = intentBranches.find(({ properties }) => properties.mode.const === "EXPLICIT");
  const automatic = intentBranches.find(({ properties }) => properties.mode.const === "AUTO_REQUESTED");
  assert.ok(explicit, "EXPLICIT language intent has its own wire branch");
  assert.ok(automatic, "AUTO_REQUESTED is an explicit user-selected wire branch");
  assert.match(explicit.properties.languageTag.format, /bcp47/u);
  assert.deepEqual(wireSchema.properties.languageHint, {
    type: "string",
    format: "bcp47-language-tag",
    pattern: "^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$",
    minLength: 2,
    maxLength: 63,
  });
  assert.ok(!wireSchema.required.includes("languageHint"), "P0 languageHint remains optional");
  assert.match(p1Operation.inputSemantics.languageHint.EXPLICIT, /exactly-equal-languageIntent.languageTag/u);
  assert.equal(p1Operation.inputSemantics.languageHint.AUTO_REQUESTED, "forbidden");
  const autoHintConstraint = wireSchema.allOf.find(({ if: condition }) => condition?.properties?.languageIntent?.properties?.mode?.const === "AUTO_REQUESTED");
  assert.ok(autoHintConstraint, "the structural schema forbids a redundant languageHint for AUTO_REQUESTED");
  assert.deepEqual(autoHintConstraint.then.not.required, ["languageHint"]);
  assert.deepEqual(wireSchema.properties.profileConfigurationDigest, { type: "string", pattern: "^[a-f0-9]{64}$" });
});

test("absent slot never defaults to AUTO_REQUESTED; AUTO_REQUESTED requires explicit intent and exact qualification", () => {
  assert.ok(p1Operation.inputSemantics.languageIntent.modes.includes("AUTO_REQUESTED"));
  assert.equal(mapping.absent.includes("AUTO_REQUESTED"), true);
  assert.match(mapping.absent, /do-not-default-infer-or-map-to-AUTO_REQUESTED/u);
  assert.match(p1Operation.inputSemantics.languageIntent.AUTO_REQUESTED.rule, /explicit-user-request-for-profile-language-detection/u);
  assert.match(p1Operation.inputSemantics.languageIntent.AUTO_REQUESTED.rule, /detection-support-must-be-qualified-and-is-not-inferred/u);
  assert.match(mapping.reconciliation, /exact-original-operation-request-snapshot-and-fingerprint/u);
  assert.match(p1Operation.scopeStatus, /runtime-NOT_ADMITTED/u);
  assert.equal(binding.asyncSubmissionDisposition, "NOT_SUBMITTABLE_SPECIALIZED_REQUEST_SEMANTICS");
});
