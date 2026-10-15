import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const p3 = ".product-experience/pdp-3-product-experience";
const operations = parse(readFileSync(".product-experience/pdp-1-domain-data/operations.yaml", "utf8"));
const purposes = parse(readFileSync(`${p3}/journey-purpose-bindings.yaml`, "utf8"));
const actions = parse(readFileSync(`${p3}/action-registry.yaml`, "utf8"));
const delegatedJourney = parse(readFileSync(`${p3}/journey-contracts/return-bounded-results-to-integrating-products.yaml`, "utf8"));
const unavailableJourney = parse(readFileSync(`${p3}/journey-contracts/continue-safely-when-processing-is-unavailable.yaml`, "utf8"));
const typedObservations = new Map(operations.ownerTypedObservationContracts.records.map((item) => [item.id, item]));
const purposeRecords = new Map(purposes.records.map((item) => [item.id, item]));
const operationRecords = new Map(operations.ownerDefinedOperationContracts.records.map((item) => [item.id, item]));

function suffixId(ref) {
  return ref.split("@id=").at(-1);
}

function requirePurpose(ref, step, actionRef) {
  const purpose = purposeRecords.get(suffixId(ref));
  assert.ok(purpose, `${ref} resolves to a canonical purpose record`);
  assert.equal(purpose.stepRef, `${p3}/journey-contracts/${step.journeyFile}#/steps/${step.index}`);
  assert.equal(purpose.actionRef, actionRef);
  return purpose;
}

function requireTypedContract(ref) {
  const contract = typedObservations.get(suffixId(ref));
  assert.ok(contract, `${ref} resolves to a canonical P1 typed observation`);
  return contract;
}

function assertExactFallbackConfirmationResultBinding(binding) {
  const operationRef = "media.operation.fallback-selection.confirm.v1";
  const operation = operationRecords.get(operationRef);
  assert.ok(operation, "P1 fallback confirmation operation exists");
  assert.equal(binding.operationRef, operationRef);
  assert.equal(binding.sourceOperationRef,
    `.product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=${operationRef}`);
  assert.equal(binding.resultSchemaRef, `${binding.sourceOperationRef}/resultSchema`);
  assert.deepEqual(binding.resultBindingIds,
    operation.resultBindings.find((item) => item.whenOutcome === "CONFIRMATION_RECORDED").bindings.map((item) => item.id));
  assert.equal(binding.stateDisposition, "NO_P1_STATE_DECLARED");
  assert.equal(binding.stateRefsRef, `${binding.sourceOperationRef}/stateRefs`);
  assert.equal(binding.finalityRef, `${binding.sourceOperationRef}/sourceFinality`);
  assert.equal(binding.unknownRecoveryRef, `${binding.sourceOperationRef}/sourceRecovery`);
}

test("C25 binds each journey operation and purpose to its exact delegated typed-result evidence", () => {
  const evidence = delegatedJourney.pdp1ResultEvidence;
  const delegatedContractRef = evidence.boundedResultContext.sourceRef;
  const delegatedContract = requireTypedContract(delegatedContractRef);
  const bindings = evidence.operationResultBindings;
  assert.equal(bindings.length, 3);
  assert.deepEqual(bindings.map((item) => item.delegatedResultKind).sort(), [
    "JOB_STATUS", "OUTPUT_PREVIEW_VERSION", "PROCESSING_PARAMETERS",
  ]);

  for (const binding of bindings) {
    const index = Number(binding.journeyStepRef.match(/#\/steps\/(\d+)$/u)?.[1]);
    const step = delegatedJourney.steps[index];
    assert.ok(step, `step ${index} exists`);
    assert.equal(step.canonicalOperationRef, binding.operationRef);
    const purpose = requirePurpose(binding.journeyPurposeBindingRef, {
      journeyFile: "return-bounded-results-to-integrating-products.yaml", index,
    }, step.actionRef);
    assert.deepEqual(purpose.actionExactOperationRefs, [binding.operationRef]);
    assert.ok(delegatedContract.operationRefs.includes(binding.operationRef));

    const typedContract = requireTypedContract(binding.typedObservationContractRef);
    if (binding.operationRef === "media.operation.action.view-job-status") {
      assert.equal(binding.sourceQueryOperationRef, "media.operation.job-status.read-dimensions.v1");
      assert.equal(typedContract.sourceQueryOperationRef,
        ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.job-status.read-dimensions.v1");
      assert.deepEqual(typedContract.resultSchema.properties.presentationOperationRef.enum, [binding.operationRef]);
      assert.ok(delegatedContract.resultSchema.properties.observation.properties.resultRefs.items.properties.sourceQueryOperationRef.enum
        .includes(binding.sourceQueryOperationRef));
    } else {
      assert.ok(typedContract.operationRefs.includes(binding.operationRef));
    }
  }

  const requestRequired = delegatedContract.requestSchema.required;
  assert.ok(requestRequired.includes("originalRequestId"));
  assert.ok(requestRequired.includes("originalRequestFingerprint"));
  assert.ok(evidence.boundedResultContext.identityJoinRuleRefs.some((ref) => ref.includes("original-request-id")));
  assert.ok(evidence.boundedResultContext.identityJoinRuleRefs.some((ref) => ref.includes("original-request-fingerprint")));
  assert.deepEqual(evidence.boundedResultContext.boundedAuthorityFields,
    ["delegationRef", "purposeRef", "budgetRef", "deadlineRef"]);
  assert.equal(evidence.boundedResultContext.recursiveInvocationAllowed, false);
  assert.equal(delegatedJourney.channelBindingState.includes("UNBOUND"), true);
  assert.equal(evidence.channelAndRuntimeBoundary.transport, "UNBOUND");
  assert.equal(evidence.channelAndRuntimeBoundary.runtimeAdmission, "NOT_ADMITTED");
});

test("C27 keeps four read-only evidence steps separate from the exact explicit fallback command", () => {
  const evidence = unavailableJourney.pdp1ResultEvidence;
  assert.equal(evidence.operationResultBindings.length, 4);
  for (const binding of evidence.operationResultBindings) {
    const index = Number(binding.journeyStepRef.match(/#\/steps\/(\d+)$/u)?.[1]);
    const step = unavailableJourney.steps[index];
    assert.ok(step, `step ${index} exists`);
    assert.equal(step.canonicalOperationRef,
      binding.presentationOperationRef ?? binding.operationRef);
    const purpose = requirePurpose(binding.journeyPurposeBindingRef, {
      journeyFile: "continue-safely-when-processing-is-unavailable.yaml", index,
    }, step.actionRef);
    const typedContract = requireTypedContract(binding.typedObservationContractRef);
    if (binding.sourceQueryOperationRef) {
      assert.equal(typedContract.sourceQueryOperationRef,
        ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.job-status.read-dimensions.v1");
      assert.deepEqual(typedContract.resultSchema.properties.presentationOperationRef.enum,
        [binding.presentationOperationRef]);
    } else {
      assert.ok(typedContract.operationRefs.includes(binding.operationRef));
      assert.deepEqual(purpose.actionExactOperationRefs, [binding.operationRef]);
    }
  }

  const confirmation = evidence.fallbackConfirmation;
  const action = actions.actions.find((item) => item.id === "media.action.confirm-selected-fallback");
  const operation = operationRecords.get("media.operation.fallback-selection.confirm.v1");
  const purpose = purposeRecords.get("media.pdp3.step-purpose-binding.j27-step-04.v1");
  const secondary = purpose.relatedActionBindings.find((item) => item.id === "media.pdp3.action-binding.j27-fallback-confirmation.v1");
  assert.ok(action);
  assert.ok(operation);
  assert.ok(secondary);
  assert.equal(confirmation.operationRef, operation.id);
  assert.equal(confirmation.operationKind, "COMMAND");
  assert.equal(secondary.actionRef, action.id);
  assert.equal(secondary.operationRef, operation.id);
  assert.equal(secondary.operationKind, "COMMAND");
  assert.equal(operation.operationKind, "COMMAND");
  assert.ok(action.actionDefinitionSemantics.typedDefinition.exactOperationRefs.includes(operation.id));
  assert.ok(operation.requestSchema.required.includes("originalRequestId"));
  assert.ok(operation.requestSchema.required.includes("originalRequestFingerprint"));
  assert.ok(operation.requestSchema.required.includes("explicitConfirmation"));
  assert.match(action.confirmation, /separate explicit confirmation/u);
  assert.match(action.effect, /do not dispatch or retry processing/u);
  assert.match(confirmation.dispatchDisposition, /NEVER/u);
  assert.match(confirmation.unknownRecovery, /does not imply denial, failure, or permission to resubmit/u);

  const resultBinding = evidence.fallbackConfirmationResultBinding;
  assert.ok(resultBinding, "fallback command result has its own P1 join");
  assertExactFallbackConfirmationResultBinding(resultBinding);
  assert.equal(resultBinding.operationKind, "COMMAND");
  assert.equal(resultBinding.journeyStepRef,
    `${p3}/journey-contracts/continue-safely-when-processing-is-unavailable.yaml#/steps/3`);
  assert.equal(resultBinding.journeyPurposeBindingRef,
    `${p3}/journey-purpose-bindings.yaml#records/@id=media.pdp3.step-purpose-binding.j27-step-04.v1/relatedActionBindings/@id=media.pdp3.action-binding.j27-fallback-confirmation.v1`);
  assert.deepEqual(operation.stateRefs, []);
  assert.equal(operation.sourceFinality,
    "explicit-selection-receipt-only; no execution, completion, approval, or delivery");
  assert.equal(operation.sourceRecovery,
    "reconcile the same confirmation request ID and fingerprint; UNKNOWN does not imply denial, failure, or permission to resubmit");
  const confirmationRecorded = operation.resultSchema.oneOf.find((branch) =>
    branch.properties.outcome.const === "CONFIRMATION_RECORDED");
  assert.ok(confirmationRecorded.required.includes("selectionReceiptRef"));
  assert.ok(confirmationRecorded.required.includes("requestFingerprint"));
  assert.ok(confirmationRecorded.required.includes("originalRequestFingerprint"));
  assert.ok(operation.resultSchema.oneOf.some((branch) => branch.properties.outcome.const === "DENIED"));
  assert.ok(operation.resultSchema.oneOf.some((branch) => branch.properties.outcome.const === "UNKNOWN_OUTCOME"));
  assert.throws(() => assertExactFallbackConfirmationResultBinding({ ...resultBinding, resultSchemaRef: undefined }));
  assert.throws(() => assertExactFallbackConfirmationResultBinding({
    ...resultBinding,
    resultSchemaRef: `${resultBinding.sourceOperationRef}/requestSchema`,
  }));
  assert.throws(() => assertExactFallbackConfirmationResultBinding({
    ...resultBinding,
    operationRef: "media.operation.action.view-job-status",
  }));

  const qualityStep = unavailableJourney.steps[3];
  assert.equal(qualityStep.actionRef, "media.action.inspect-quality-evidence");
  assert.deepEqual(qualityStep.relatedActionBindings.map((item) => item.operationRef), [operation.id]);
  assert.match(qualityStep.relatedActionBindings[0].role, /Separate explicit user opt-in/u);
  assert.equal(qualityStep.relatedActionBindings[0].runtimeAdmission, "NOT_ADMITTED");
  assert.equal(unavailableJourney.terminalSuccess.includes("admitted equivalent fallback"), false);
  assert.equal(evidence.channelAndRuntimeBoundary.transport, "UNBOUND");
  assert.equal(evidence.channelAndRuntimeBoundary.runtimeAdmission, "NOT_ADMITTED");
});
