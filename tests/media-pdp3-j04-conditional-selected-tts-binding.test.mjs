import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateSelectedTargetOperationRequest } from "../scripts/lib/pdp-selected-target-operation-binding.mjs";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const p3 = ".product-experience/pdp-3-product-experience";
const p1 = ".product-experience/pdp-1-domain-data/operations.yaml";
const [purposeText, journeyText, operationsText] = await Promise.all([
  readFile(`${p3}/journey-purpose-bindings.yaml`, "utf8"),
  readFile(`${p3}/journey-contracts/authorized-text-to-speech-to-approved-audio.yaml`, "utf8"),
  readFile(p1, "utf8"),
]);
const purposes = parse(purposeText);
const journey = parse(journeyText);
const operations = parse(operationsText);
const purpose = purposes.records.find(({ id }) => id === "media.pdp3.step-purpose-binding.j04-step-01.v1");
const binding = purpose.relatedActionBindings.find(({ id }) => id === "media.pdp3.action-binding.j04-selected-tts-command.v1");
const evidence = journey.pdp1ResultEvidence.conditionalSelectedCommandResultBinding;
const wrapper = operations.ownerDefinedOperationContracts.records.find(({ id }) => id === binding.operationRef);
const target = operations.capabilityOperationContracts.records.find(({ id }) => id === binding.selectedTargetOperationRef);
const targetRequestSchemaRef = `${p1}#capabilityOperationContracts/records/@id=${target.id}/requestSchema`;
const targetResultSchemaRef = `${p1}#capabilityOperationContracts/records/@id=${target.id}/resultSchema`;

function selectedRequest() {
  return {
    requestId: "j04-tts-request-01",
    exactTargetRefs: [{ objectRef: "media.domain.artifact-version", artifactId: "text-01", versionId: "text-v3" }],
    admittedOperationRef: wrapper.id,
    selectedTargetCapabilityRef: target.capabilityRef,
    selectedTargetOperationRef: target.id,
    selectedTargetOperationVersion: target.operationVersion,
    selectedTargetRequestSchemaRef: targetRequestSchemaRef,
    selectedTargetResultSchemaRef: targetResultSchemaRef,
    selectedTargetRequest: {
      input1: { artifactType: "text-or-speech-intent", payload: { kind: "text", text: "Hello there", locale: "en-US" } },
      parameters: { outputProfileRef: "profile://speech/default@v3", outputLanguage: "en-US" },
      requestId: "j04-tts-request-01",
    },
    explicitConfirmation: { confirmationRef: "confirmation://j04-tts-request-01" },
  };
}

function validateRequest(request, records = operations.capabilityOperationContracts.records) {
  return validateSelectedTargetOperationRequest({
    wrapper,
    request,
    targetOperationRecords: records,
    operationsSource: operations,
  });
}

function assertPurposeJoin(candidate) {
  assert.equal(candidate.actionRef, "media.action.request-admitted-speech-operation");
  assert.equal(candidate.operationRef, "media.operation.action.request-admitted-speech-operation");
  assert.equal(candidate.selectedTargetCapabilityRef, "media.speech.synthesis.text-to-speech");
  assert.equal(candidate.selectedTargetOperationRef, "media.operation.capability.media-speech-synthesis-text-to-speech");
  assert.equal(candidate.selectedTargetOperationVersion, 1);
  assert.equal(candidate.selectedTargetRequestSchemaRef, targetRequestSchemaRef);
  assert.equal(candidate.selectedTargetResultSchemaRef, targetResultSchemaRef);
}

test("J04 keeps the umbrella step passive and binds its optional selected TTS command separately", () => {
  assert.equal(purpose.bindingKind, "EXPLICIT_NO_DOMAIN_DISPATCH");
  assert.equal(purpose.actionRef, null);
  assert.deepEqual(purpose.operationRefs, []);
  assert.deepEqual(purpose.allowedOperationRefs, []);
  assertPurposeJoin(binding);
  assert.equal(binding.operationKind, "COMMAND");
  assert.equal(binding.selectedTargetOperationBindingRef,
    `${p1}#ownerDefinedOperationContracts/records/@id=${wrapper.id}/selectedTargetOperationBinding`);
  assert.equal(binding.intentSourceRef,
    `${p3}/journey-contracts/authorized-text-to-speech-to-approved-audio.yaml#/pdp1ResultEvidence/conditionalSelectedCommandResultBinding`);
  assert.equal(evidence.journeyPurposeBindingRef,
    `${p3}/journey-purpose-bindings.yaml#records/@id=${purpose.id}/relatedActionBindings/@id=${binding.id}`);
  assert.equal(evidence.actionPurposeOperationRef, wrapper.id);
  assert.equal(evidence.selectedCanonicalOperationRef, target.id);
  assert.equal(validateRequest(selectedRequest()).reason, "EXACT_SELECTED_COMMAND_AND_SEPARATE_RESULT_BOUND");
});

test("J04 selected TTS mapping fails closed when explicit target selection is absent or ambiguous", () => {
  const absent = selectedRequest();
  delete absent.selectedTargetOperationRef;
  assert.equal(validateRequest(absent).reason, "SELECTED_TARGET_NOT_UNIQUE");
  assert.equal(validateRequest(selectedRequest(), [structuredClone(target), structuredClone(target)]).reason,
    "SELECTED_TARGET_NOT_UNIQUE");
  assert.match(binding.selectionCondition, /exactly one current COMMAND target/u);
  assert.match(binding.selectionCondition, /no default and no dispatch before selection/u);
});

test("J04 selected TTS mapping rejects wrapper substitution and target version or schema drift", () => {
  const wrapperAsTarget = selectedRequest();
  wrapperAsTarget.selectedTargetOperationRef = wrapper.id;
  assert.equal(validateRequest(wrapperAsTarget).reason, "RECURSIVE_OR_WRAPPER_TARGET_REJECTED");

  const wrongVersion = selectedRequest();
  wrongVersion.selectedTargetOperationVersion += 1;
  assert.equal(validateRequest(wrongVersion).reason, "SELECTED_TARGET_IDENTITY_OR_SCHEMA_MISMATCH");

  const wrongRequestSchema = selectedRequest();
  wrongRequestSchema.selectedTargetRequestSchemaRef = `${p1}#other/requestSchema`;
  assert.equal(validateRequest(wrongRequestSchema).reason, "SELECTED_TARGET_IDENTITY_OR_SCHEMA_MISMATCH");

  const wrongResultSchema = selectedRequest();
  wrongResultSchema.selectedTargetResultSchemaRef = `${p1}#other/resultSchema`;
  assert.equal(validateRequest(wrongResultSchema).reason, "SELECTED_TARGET_IDENTITY_OR_SCHEMA_MISMATCH");

  for (const field of ["selectedTargetOperationRef", "selectedTargetOperationVersion", "selectedTargetRequestSchemaRef", "selectedTargetResultSchemaRef"]) {
    const corrupted = { ...binding, [field]: field === "selectedTargetOperationVersion" ? 2 : "media.operation.unknown" };
    assert.throws(() => assertPurposeJoin(corrupted));
  }
});

test("J04 unknown results reconcile the same identity and never imply output or approval", () => {
  assert.match(binding.recovery, /exact request identity and fingerprint/u);
  assert.match(binding.recovery, /same identity before retry/u);
  assert.match(wrapper.recoverySemantics, /reconcile-unknown-effects-before-retry/u);
  assert.match(wrapper.requestIdempotency.fingerprint, /selected capability and target operation\/version\/schema identities/u);
  assert.match(binding.finality, /separate exact-schema observation/u);
  assert.match(binding.finality, /does not establish output registration or approval/u);
  assert.match(evidence.outputAndApprovalBoundary, /does not establish synthesis execution, output registration, or human approval/u);
  assert.match(journey.pdp1ResultEvidence.conditionalResultChain.outputRegistration.finality, /not a registered output/u);
  assert.match(journey.pdp1ResultEvidence.conditionalResultChain.humanReviewApproval.negativeAcceptance, /never creates, changes, or infers approval/u);
  assert.equal(evidence.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(journey.pdp1ResultEvidence.channelAndRuntimeBoundary.transport, "UNBOUND");
});
