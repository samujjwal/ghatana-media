import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const { parse } = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"))("yaml");
const readYaml = (sourcePath) => parse(readFileSync(sourcePath, "utf8"));
const p1 = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");
const privacy = readYaml(".product-experience/pdp-1-domain-data/privacy.yaml");
const purposes = readYaml(".product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml");
const journey = readYaml(".product-experience/pdp-3-product-experience/journey-contracts/delete-or-revoke-media-with-visible-lifecycle.yaml");
const actionRegistry = readYaml(".product-experience/pdp-3-product-experience/action-registry.yaml");

test("J26 binds exact lifecycle observation and separates consent revocation from erasure", () => {
  assert.equal(journey.journeyId, "J-26");
  assert.equal(journey.steps.length, 3);
  assert.deepEqual(journey.channels, ["media.channel.web", "media.channel.http-api", "media.channel.product-integration"]);
  assert.match(journey.channelBindingState, /UNBOUND.*NOT_ADMITTED/u);

  const lifecyclePurpose = purposes.records.find(({ id }) => id === "media.pdp3.step-purpose-binding.j26-step-02.v1");
  const lifecycleBinding = journey.pdp1ResultEvidence.operationResultBindings.find(
    ({ operationRef }) => operationRef === "media.operation.artifact.lifecycle.observe.v1",
  );
  const lifecycleOperation = p1.ownerDefinedOperationContracts.records.find(
    ({ id }) => id === "media.operation.artifact.lifecycle.observe.v1",
  );
  assert.ok(lifecyclePurpose.supportingOperationRefs.includes(lifecycleOperation.id));
  assert.ok(lifecycleBinding);
  assert.equal(lifecycleBinding.journeyStepRef, lifecyclePurpose.stepRef);
  assert.equal(lifecycleBinding.journeyPurposeBindingRef.endsWith(lifecyclePurpose.id), true);
  assert.equal(lifecycleOperation.operationKind, "QUERY");
  const observedResult = lifecycleOperation.resultSchema.properties.observation.oneOf[0];
  assert.equal(observedResult.properties.stateRevision.type, "integer");
  assert.ok(observedResult.required.includes("stateEvidenceRef"));
  assert.match(lifecycleBinding.unknownDisposition, /do not infer availability, revocation, or erasure/u);

  const revoke = p1.ownerDefinedOperationContracts.records.find(
    ({ id }) => id === "media.operation.action.revoke-authorized-consent",
  );
  assert.ok(revoke);
  const revokeAction = actionRegistry.actions.find(({ id }) => id === "media.action.revoke-authorized-consent");
  const revokePurpose = purposes.records.find(({ id }) => id === "media.pdp3.step-purpose-binding.j26-step-01.v1");
  const revokeBinding = revokePurpose.relatedActionBindings.find(({ id }) => id === "media.pdp3.action-binding.j26-consent-revocation-request.v1");
  assert.ok(revokeAction);
  assert.ok(revokePurpose);
  assert.ok(revokeBinding);
  assert.equal(revokeBinding.actionRef, revokeAction.id);
  assert.equal(revokeBinding.operationRef, revoke.id);
  assert.deepEqual(revokeBinding.actionExactOperationRefs, [revoke.id]);
  assert.equal(revokeBinding.operationKind, "COMMAND");
  assert.equal(revokeBinding.operationSourceRef, ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.action.revoke-authorized-consent");
  assert.equal(revokeBinding.ownerActionWireRef, ".product-experience/pdp-1-domain-data/owner-action-wire-contracts.yaml#records/@id=media.owner-action-wire.revoke-authorized-consent.v1");
  assert.equal(revokeAction.actionDefinitionSemantics.typedDefinition.canonicalOperationBindings.operationRef, revoke.id);
  assert.equal(revokeAction.actionDefinitionSemantics.typedDefinition.canonicalOperationBindings.operationKind, "COMMAND");
  assert.equal(revokeBinding.confirmationRequired, true);
  assert.match(revokeBinding.receiptMeaning, /only the consent authority receipt confirms the scoped consent change/u);
  assert.match(revokeBinding.receiptMeaning, /In-flight work requires separate reconciliation/u);
  assert.equal(revokeBinding.erasureDisposition, "NOT_BOUND; consent revocation does not imply artifact deletion, physical erasure, or ERASURE_CONFIRMED.");
  assert.equal(revokeBinding.journeyStepTransition, false);
  assert.equal(revokeBinding.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(revokeBinding.acceptanceEffect, "none");
  const revokeResultBinding = journey.pdp1ResultEvidence.operationResultBindings.find(
    ({ operationRef }) => operationRef === revoke.id,
  );
  assert.ok(revokeResultBinding);
  assert.equal(revokeResultBinding.journeyStepRef, revokePurpose.stepRef);
  assert.equal(revokeResultBinding.journeyPurposeBindingRef.endsWith(revokePurpose.id), true);
  assert.equal(revokeResultBinding.relatedActionBindingRef.endsWith(revokeBinding.id), true);
  assert.equal(revokeResultBinding.operationKind, "COMMAND");
  assert.equal(revokeResultBinding.operationVersion, revoke.contractVersion);
  assert.equal(revokeResultBinding.requestSchemaRef,
    ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.action.revoke-authorized-consent/requestSchema");
  assert.equal(revokeResultBinding.resultSchemaRef,
    ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.action.revoke-authorized-consent/resultSchema");
  assert.match(revokeResultBinding.exactResult, /acknowledgement without the consent authority receipt does not confirm revocation/u);
  assert.match(revokeResultBinding.unknownDisposition, /do not blindly replay/u);
  assert.equal(revokeResultBinding.runtimeAdmission, "NOT_ADMITTED");
  assert.match(revoke.resultSchema.finality, /only by the consent authority receipt/u);
  assert.match(revoke.resultSchema.finality, /in-flight work requires separate reconciliation/u);
  assert.match(journey.pdp1ResultEvidence.lifecycleEffectBoundaries.consentRevocation.effectBoundary,
    /does not prove in-flight termination or recall/u);

  const deletion = p1.capabilityOperationContracts.records.find(
    ({ id }) => id === "media.operation.capability.media-artifact-delete",
  );
  assert.ok(deletion);
  assert.equal(deletion.operationKind, "COMMAND");
  const lifecycleResult = deletion.successOutputs[0];
  assert.equal(lifecycleResult.artifactType,
    "artifact-lifecycle-observation-access-revoked-hold-pending-erasure-confirmed-or-external-unknown");
  const typedOutput = p1.capabilityOperationContracts.outputPayloadSchemas.find(({ id }) =>
    id === "media.typed-output.artifact-lifecycle-observation-access-revoked-hold-pending-erasure-confirmed-or-external-unknown");
  assert.ok(typedOutput);
  assert.match(typedOutput.ownerDefinition, /only ERASURE_CONFIRMED confirms erasure/u);
  assert.match(privacy.ownerDefinedErasureInventoryContract.erasureFinality.outcomeClassifier.rule,
    /COMPLETE inventory/u);
  assert.match(privacy.ownerDefinedErasureInventoryContract.erasureFinality.outcomeClassifier.rule,
    /tombstone replay observation/u);
  assert.equal(journey.pdp1ResultEvidence.lifecycleEffectBoundaries.artifactErasure.journeyBindingStatus,
    "Bound as a separate purpose-scoped capability command under the exact artifact-inspection step; it is not the inspection step's transition, and consent revocation remains request-only and is not artifact deletion.");
  assert.equal(journey.sourceGap.id, "MDC30-C-26-purpose-bound-revocation-and-erasure-effect");
  assert.match(journey.sourceGap.status, /RUNTIME_NOT_ADMITTED/u);
  assert.match(journey.pdp1ResultEvidence.lifecycleEffectBoundaries.artifactErasure.journeyBindingStatus,
    /Bound as a separate purpose-scoped capability command/u);
  assert.match(journey.sourceGap.missingOwnerDefinition, /no current owner\/provider evidence supplies an all-copy erasure receipt/iu);
  assert.match(journey.sourceGap.missingOwnerDefinition, /do not claim consent revocation, physical deletion, or ERASURE_CONFIRMED/u);
});
