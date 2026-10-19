import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const parse = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml").parse;
const p0 = parse(readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/capabilities.yaml"), "utf8"));
const p1 = parse(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/operations.yaml"), "utf8"));
const capability = p0.capabilities.find(({ id }) => id === "media.speech.transcription.file");
const operation = p1.operations.find(({ id }) => id === "media.operation.transcription-submission");
const binding = p1.capabilityOperationContracts.records.find(({ id }) => id === "media.capability-binding.media-speech-transcription-file");
const submit = operation.ownerWireSchema.requestSchema.oneOf.find(({ properties }) => properties.requestMode.enum?.includes("SUBMIT_OR_REPLAY"));

test("transcription submit preserves every required P0 parameter in typed wire fields and fingerprint", () => {
  const p0Params = capability.ownerDefinition.parameterSchema;
  assert.deepEqual(p0Params.required, ["timestamps", "speakerDiarization"]);
  assert.deepEqual(submit.properties.timestamps, { type: "string", enum: ["none", "segment", "word", "phoneme"] });
  assert.deepEqual(submit.properties.speakerDiarization, { type: "boolean" });
  for (const field of p0Params.required) {
    assert.ok(submit.required.includes(field), `${field} must be required by the submit wire schema`);
    assert.ok(operation.inputSemantics.submitRequiredFields.includes(field), `${field} must be required by operation semantics`);
    assert.ok(operation.inputSemantics.requestFingerprint.fields.includes(field), `${field} must be fingerprint-bound`);
  }
  assert.equal(operation.inputSemantics.requestFingerprint.version, "media.transcription-submission-fingerprint.v3");
  assert.match(operation.inputSemantics.requestFingerprint.scalarEncoding, /speakerDiarization-is-a-JSON-boolean-without-coercion/u);
  assert.match(operation.inputSemantics.requestFingerprint.scalarEncoding, /timestamps-is-one-of-none-segment-word-phoneme/u);
});

test("optional glossary and filler-retake parameters preserve their exact mappings and conditional behavior", () => {
  const typed = binding.typedInputMappings;
  const sourceContract = binding.sourceSemanticContract;
  const mappings = new Map(typed.entries
    .filter(({ source }) => source.kind === "P0_PARAMETER")
    .map((entry) => [entry.source.parameterName, entry]));

  const glossary = mappings.get("customGlossaryRef");
  assert.ok(glossary, "the optional P0 glossary parameter must have a direct typed-input mapping");
  assert.equal(glossary.mappingMode, "DIRECT");
  assert.equal(glossary.mappingDisposition, "EXACT_OPTIONAL_VERSIONED_GLOSSARY_REFERENCE");
  assert.equal(glossary.targets.length, 1);
  assert.equal(glossary.targets[0].requestPointer, "/customGlossaryRef");
  assert.equal(glossary.targets[0].required, false);
  assert.ok(!submit.required.includes("customGlossaryRef"));
  assert.deepEqual(submit.properties.customGlossaryRef, {
    type: "string", format: "opaque-versioned-reference", pattern: ".*\\S.*", minLength: 1, maxLength: 384,
  });
  assert.equal(sourceContract.requestFields.customGlossaryRef.optional, true);
  assert.equal(sourceContract.requestFields.customGlossaryRef.type, "opaque-versioned-reference");
  assert.equal(sourceContract.requestFields.customGlossaryRef.unavailable,
    "reject-or-report-UNAVAILABLE; never-silently-ignore");
  assert.ok(sourceContract.validatorContract.requestResultInvariants.includes(
    "if-request.customGlossaryRef-is-present-then-APPLIED-requires-glossaryApplication.exactGlossaryRef-equals-that-exact-reference"));
  assert.ok(sourceContract.validatorContract.requestResultInvariants.includes(
    "if-customGlossaryRef-is-absent-then-disposition-is-NOT_REQUESTED"));

  const filler = mappings.get("fillerRetakeCandidates");
  assert.ok(filler, "the optional P0 filler-retake parameter must have a direct typed-input mapping");
  assert.equal(filler.mappingMode, "DIRECT");
  assert.equal(filler.mappingDisposition, "EXACT_OPTIONAL_BOOLEAN");
  assert.equal(filler.targets.length, 1);
  assert.equal(filler.targets[0].requestPointer, "/fillerRetakeCandidates");
  assert.equal(filler.targets[0].required, false);
  assert.ok(!submit.required.includes("fillerRetakeCandidates"));
  assert.deepEqual(submit.properties.fillerRetakeCandidates, { type: "boolean" });
  assert.equal(sourceContract.requestFields.fillerRetakeCandidates.optional, true);
  assert.equal(sourceContract.requestFields.fillerRetakeCandidates.type, "boolean");
  assert.equal(sourceContract.requestFields.fillerRetakeCandidates.default, false);
  assert.equal(sourceContract.requestFields.fillerRetakeCandidates.true,
    "request-uncertain-filler-and-retake-candidate-observations");
  assert.ok(sourceContract.validatorContract.requestResultInvariants.includes(
    "fillerRetakeCandidateObservations-is-present-only-if-request.fillerRetakeCandidates-is-true"));
  assert.ok(sourceContract.validatorContract.requestResultInvariants.includes(
    "otherwise-no-filler-retake-classification-claim"));
  assert.deepEqual(sourceContract.fingerprint.include, ["customGlossaryRef", "fillerRetakeCandidates"]);
  assert.equal(sourceContract.fingerprint.preserveOptionalPresence, true);
});

test("transcription policy inputs preserve exact purpose and ordered rights references", () => {
  assert.ok(submit.required.includes("purposeRef"));
  assert.ok(submit.required.includes("rightsEvidenceRefs"));
  assert.deepEqual(submit.properties.purposeRef, {
    type: "string", format: "opaque-reference", minLength: 1, maxLength: 256,
  });
  assert.deepEqual(submit.properties.rightsEvidenceRefs, {
    type: "array", minItems: 1, maxItems: 32,
    items: { type: "string", format: "opaque-reference", minLength: 1, maxLength: 256 },
  });
  for (const field of ["purposeRef", "rightsEvidenceRefs"]) {
    assert.ok(operation.inputSemantics.submitRequiredFields.includes(field));
    assert.ok(operation.inputSemantics.requestFingerprint.fields.includes(field));
  }
  assert.ok(!("purpose" in submit.properties));
  assert.ok(!("rightsEvidenceRef" in submit.properties));
  assert.match(operation.inputSemantics.requestFingerprint.scalarEncoding, /ordered-array-of-exact-validated-references/u);
});

test("optional policy references and processing location resolve only through trusted owner context", () => {
  for (const field of ["consentRef", "retentionPolicyRef", "policyDecisionRef"]) {
    assert.ok(!(submit.required ?? []).includes(field), `${field} may be omitted for owner resolution`);
    assert.ok(operation.inputSemantics.submitAllowedFields.includes(field));
    assert.ok(operation.inputSemantics.requestFingerprint.fields.includes(field));
  }
  assert.ok(!("processingLocation" in submit.properties), "the request cannot self-assert processing location");
  assert.ok(!operation.inputSemantics.submitAllowedFields.includes("processingLocation"));
  assert.match(operation.inputSemantics.scalarNullability.consentRef, /current-trusted-owner-context/u);
  assert.match(operation.inputSemantics.scalarNullability.consentRef, /canonical-null-only-when-current-authoritative-policy-says-consent-is-not-required/u);
  assert.match(operation.inputSemantics.scalarNullability.retentionPolicyRef, /canonical-null-only-when-current-authoritative-policy-resolves-no-retention-policy/u);
  assert.match(operation.inputSemantics.authorityReferences, /not-self-grants/u);
  assert.match(operation.ownerWireSchema.requestResolution.processingLocationDisposition, /never-accept-a-caller-asserted-location/u);
  assert.match(operation.ownerWireSchema.requestResolution.fingerprintUses, /explicit-null-and-resolvedProcessingLocation/u);
});

test("optional profile absence remains a pre-request rejection and success maps only the stable job reference", () => {
  const mapping = binding.inputSlotMapping;
  assert.equal(mapping.p0Cardinality, "ZERO_OR_ONE");
  assert.match(mapping.absent, /UNSUPPORTED_PROFILE.*before-operation-request.*job.*receipt.*dispatch/u);
  assert.match(mapping.absent, /do-not-default-infer-or-map-to-AUTO_REQUESTED/u);
  assert.equal(binding.parameterMapping.timestamps, "required-exact-enum-none-segment-word-phoneme; preserve-value-through-request-and-fingerprint");
  assert.equal(binding.parameterMapping.speakerDiarization, "required-json-boolean; preserve-value-through-request-and-fingerprint-without-coercion");
  assert.equal(binding.outputMapping.success.targetArtifactType, "owner-issued-transcription-job-reference");
  assert.equal(binding.outputMapping.success.targetIdentity, "exact-jobId-from-authoritative-accepted-request-observation");
  assert.match(binding.outputMapping.transcriptDraft, /not-produced-by-request-acknowledgment/u);
  assert.match(binding.outputMapping.recognitionEvidence, /only-when-authoritatively-provided/u);
  assert.match(operation.unknownOutcome, /same-requestId-and-full-requestFingerprint/u);
  assert.match(operation.retry, /no-automatic-submit-replay-after-unknown/u);
});

test("the specialized wire response carries the atomic acknowledgment tuple and keeps failure outcomes distinct", () => {
  const wire = operation.ownerWireSchema;
  const result = wire.resultSchema;
  assert.equal(wire.sourceCapabilityRef, ".product-experience/pdp-0-product-truth/capabilities.yaml#media.speech.transcription.file");
  assert.equal(operation.outputSemantics.acknowledgedOutcome, "REQUEST_ACKNOWLEDGED");
  assert.equal(binding.outputMapping.acknowledgedOutcome, "REQUEST_ACKNOWLEDGED");
  assert.equal(wire.outcomeMapping[binding.outputMapping.wireOutcome], "REQUEST_ACKNOWLEDGED");

  const acknowledged = result.allOf.find(({ if: condition }) => condition?.properties?.outcome?.const === "SUCCEEDED").then;
  for (const field of ["requestId", "requestFingerprint", "submissionReceiptId", "jobId", "acceptedAt", "replayDisposition", "outputs"]) {
    assert.ok(acknowledged.required.includes(field), `${field} is required for the atomic acknowledgment`);
  }
  assert.deepEqual(result.properties.replayDisposition.enum, ["NEW_LOGICAL_REQUEST", "SAME_REQUEST_REPLAY"]);
  assert.deepEqual(result.properties.outputs.items.oneOf.map(({ properties }) => properties.artifactType.const), [
    "accepted-media-job-reference-and-admission-observation",
  ], "acknowledgment output contains only the job/admission observation");

  const rejected = result.allOf.find(({ if: condition }) => condition?.properties?.outcome?.const === "REJECTED").then;
  const unknown = result.allOf.find(({ if: condition }) => condition?.properties?.outcome?.const === "UNKNOWN_OUTCOME").then;
  assert.ok(rejected.required.includes("error"));
  assert.deepEqual(rejected.properties.outputs, { maxItems: 0 });
  assert.deepEqual(result.properties.error.properties.code.enum, operation.error.definitivePreDispatchCodes);
  for (const ambiguousCode of operation.error.nonterminalOrAmbiguousCodes) {
    assert.ok(!result.properties.error.properties.code.enum.includes(ambiguousCode), `${ambiguousCode} cannot be encoded as REJECTED`);
  }
  assert.ok(unknown.required.includes("uncertaintyReason"));
  assert.deepEqual(unknown.properties.outputs, { maxItems: 0 });
  assert.ok(unknown.properties.error.not, "UNKNOWN_OUTCOME cannot be collapsed into definitive rejection");
});

test("all P0 success identities are represented by an acknowledgment adapter or an explicit later observation", () => {
  const p0Outputs = capability.ownerDefinition.successOutputs;
  const outputMapping = binding.outputMapping;
  assert.deepEqual(p0Outputs.map(({ artifactType }) => artifactType), [
    outputMapping.success.targetArtifactType,
    ...outputMapping.deferredP0Outputs.map(({ artifactType }) => artifactType),
  ]);
  assert.equal(p0Outputs[0].requiredOnSuccess, true);
  for (const deferred of outputMapping.deferredP0Outputs) {
    assert.equal(deferred.requiredOnAcknowledgment, false);
    assert.match(deferred.disposition, /not-produced-by-request-acknowledgment/u);
  }
  assert.ok(!operation.ownerWireSchema.resultSchema.properties.outputs.items.oneOf.some(({ properties }) =>
    outputMapping.deferredP0Outputs.some(({ artifactType }) => properties.artifactType.const === artifactType)),
  "transcript and recognition evidence cannot be fabricated by the request acknowledgment");
});

test("typed input mapping covers all slots and parameters through resolvable request fields", () => {
  const typed = binding.typedInputMappings;
  assert.equal(typed.coverage.status, "COMPLETE");
  assert.equal(typed.coverage.requiredFields, 14);
  assert.equal(typed.coverage.mappedFromP0, 11);
  assert.equal(typed.coverage.generatedProtocol, 3);
  assert.deepEqual(typed.entries.map(({ source }) => source.kind === "P0_SLOT" ? source.slotId : source.parameterName), [
    "input1", "input2", "input3", "timestamps", "speakerDiarization", "languageHint",
    "customGlossaryRef", "fillerRetakeCandidates",
  ]);
  assert.ok(typed.entries.every(({ targets }) => targets.every(({ requestPointer }) => !requestPointer.includes("/oneOf/"))));
  assert.ok(typed.entries.find(({ source }) => source.parameterName === "languageHint").targets.some(({ required }) => required === false));
});
