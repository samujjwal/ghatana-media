import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const p3 = ".product-experience/pdp-3-product-experience";
const p1 = ".product-experience/pdp-1-domain-data/operations.yaml";
const [captionText, speechText, operationsText, purposeText, channelBindingsText] = await Promise.all([
  readFile(`${p3}/journey-contracts/transcribe-and-correct-captions.yaml`, "utf8"),
  readFile(`${p3}/journey-contracts/authorized-text-to-speech-to-approved-audio.yaml`, "utf8"),
  readFile(p1, "utf8"),
  readFile(`${p3}/journey-purpose-bindings.yaml`, "utf8"),
  readFile(`${p3}/journey-channel-contract-bindings.yaml`, "utf8"),
]);
const captionJourney = parse(captionText);
const speechJourney = parse(speechText);
const operations = parse(operationsText);
const purposes = parse(purposeText);
const channelBindings = parse(channelBindingsText);

test("J-03 binds each existing operation result without upgrading receipt finality", () => {
  const bindings = captionJourney.pdp1ResultEvidence.operationResultBindings;
  assert.equal(bindings.length, 7);
  assert.deepEqual(bindings.map((binding) => binding.journeyStepRef.split("/steps/")[1]), ["1", "2", "3", "4", "5", "6", "7"]);
  assert.deepEqual(bindings.map((binding) => binding.operationRef), [
    "media.operation.transcription-submission",
    "media.operation.action.view-job-status",
    "media.operation.transcript-version-read",
    "media.operation.caption-draft-write",
    "media.operation.caption-draft-write",
    "media.operation.caption-version-write",
    "media.operation.caption-version-read",
  ]);
  assert.match(bindings[0].finality, /not completion/);
  assert.match(bindings[0].errorsAndRecovery, /UNKNOWN_OUTCOME/);
  assert.match(bindings[1].exactResult, /no job, attempt, or transcription-completion observation/);
  assert.match(bindings[2].exactSelector, /transcriptVersionId/);
  assert.match(bindings[3].exactResult, /Session-local/);
  assert.match(bindings[4].exactResult, /Session-local/);
  assert.match(bindings[5].exactResult, /no approval or publication/);
  assert.match(bindings[6].exactResult, /Read-only/);
  assert.equal(captionJourney.pdp1ResultEvidence.channelAndRuntimeBoundary.transport, "UNBOUND");
  assert.equal(captionJourney.pdp1ResultEvidence.channelAndRuntimeBoundary.runtimeAdmission, "NOT_ADMITTED");
  for (const binding of bindings) assert.ok(binding.resultSchemaRef.startsWith(`${p1}#`));
  for (const binding of bindings.filter((item) => item.purposeBindingRef)) {
    assert.ok(purposes.records.some((record) => binding.purposeBindingRef.endsWith(`@id=${record.id}`)));
  }
  assert.ok(operations.operations.some((operation) => operation.id === "media.operation.transcription-submission"));
});

test("J-04 defines conditional TTS provenance through exact registered output and current approval", () => {
  const evidence = speechJourney.pdp1ResultEvidence;
  const selected = evidence.conditionalSelectedCommandResultBinding;
  assert.equal(evidence.operationResultBindings.length, 3);
  assert.ok(evidence.operationResultBindings.every((binding) => purposes.records.some((record) => binding.purposeBindingRef.endsWith(`@id=${record.id}`))));
  assert.equal(selected.candidateActionRef, "media.action.request-admitted-speech-operation");
  assert.equal(selected.selectedCanonicalOperationRef, "media.operation.capability.media-speech-synthesis-text-to-speech");
  assert.equal(selected.operationKind, "COMMAND");
  assert.equal(selected.operationVersion, 1);
  assert.equal(selected.currentJoinStatus, "SOURCE_BOUND_DEFINITION_ONLY; CONDITIONAL_ACTION_PURPOSE_JOIN_AUTHORED; CHANNEL_EDGE_PROOF_REFERENCES_PRESENT; OWNER_ACCEPTANCE_NOT_RECORDED");
  assert.match(selected.selection, /EXPLICIT_USER_SELECTION_REQUIRED; NO_DEFAULT/);
  assert.match(selected.exactSharedJoinGap, /all three owner-directed channel-edge proof records cite that exact binding/u);
  assert.match(evidence.conditionalResultChain.journeyJoinStatus, /all three owner-directed J-04 channel-edge records cite/u);
  assert.equal(Object.hasOwn(evidence.conditionalResultChain, "missingJourneyJoin"), false);
  const ttsEdges = channelBindings.edges.filter((edge) => edge.taskId === "MDC30-C-04");
  assert.equal(ttsEdges.length, 3);
  for (const edge of ttsEdges) {
    const proof = edge.p1OperationStateProofs.find((item) => item.disposition === "CONDITIONAL_SELECTED_TARGET_RESULT_SOURCE_REF");
    assert.ok(proof, `${edge.id} retains the exact conditional selected-target proof`);
    assert.equal(proof.selectedActionPurposeBindingRef, selected.journeyPurposeBindingRef);
    assert.ok(!(edge.logicalDefinitionBlockers ?? []).some((blocker) => /no exact shared action-purpose binding/u.test(blocker)));
    assert.equal(edge.transportRefOrUnbound, "UNBOUND");
    assert.equal(edge.runtimeAdmission, "NOT_ADMITTED");
  }
  assert.equal(evidence.status, "SOURCE_BOUND_DEFINITION_ONLY; PDP3_CHANNEL_EDGE_PROOF_REFERENCES_PRESENT; OWNER_ACCEPTANCE_NOT_RECORDED");
  assert.match(evidence.conditionalResultChain.selectionBoundary, /No operation is dispatched/);
  assert.match(evidence.conditionalResultChain.sourceAndProfileResolution.boundary, /UNKNOWN/);
  assert.deepEqual(evidence.conditionalResultChain.rightsAndConsent.requiredDecisionKinds, ["VOICE_AUTHORIZATION", "CONSENT"]);
  assert.match(evidence.conditionalResultChain.rightsAndConsent.negativeAcceptance, /prohibit output registration/);
  assert.match(evidence.conditionalResultChain.synthesisRequestAndResult.exactRequestJoin, /requestFingerprint/);
  assert.match(evidence.conditionalResultChain.synthesisRequestAndResult.unknownDisposition, /prohibits registration/);
  assert.match(evidence.conditionalResultChain.outputRegistration.requiredJoin, /artifactId, versionId/);
  assert.match(evidence.conditionalResultChain.outputRegistration.finality, /not a registered output/);
  assert.match(evidence.conditionalResultChain.humanReviewApproval.exactSubject, /registered output ArtifactVersionRef/);
  assert.match(evidence.conditionalResultChain.humanReviewApproval.positiveAcceptance, /nonempty authoritative evidenceRefs/);
  assert.match(evidence.conditionalResultChain.humanReviewApproval.negativeAcceptance, /never creates, changes, or infers approval/);
  assert.equal(evidence.channelAndRuntimeBoundary.transport, "UNBOUND");
  assert.equal(evidence.channelAndRuntimeBoundary.runtimeAdmission, "NOT_ADMITTED");
  assert.ok(operations.capabilityOperationContracts.records.some((operation) => operation.id === "media.operation.capability.media-speech-synthesis-text-to-speech"));
  assert.ok(operations.ownerTypedObservationContracts.records.some((contract) => contract.id === "media.observation-contract.rights-decision.v1"));
});
