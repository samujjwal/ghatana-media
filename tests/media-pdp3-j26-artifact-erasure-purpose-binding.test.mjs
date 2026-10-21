import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const { parse } = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"))("yaml");
const readYaml = (sourcePath) => parse(readFileSync(sourcePath, "utf8"));
const p0Capabilities = readYaml(".product-experience/pdp-0-product-truth/capabilities.yaml");
const p0Journeys = readYaml(".product-experience/pdp-0-product-truth/journey-catalog.yaml");
const p1 = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");
const privacy = readYaml(".product-experience/pdp-1-domain-data/privacy.yaml");
const journey = readYaml(".product-experience/pdp-3-product-experience/journey-contracts/delete-or-revoke-media-with-visible-lifecycle.yaml");
const purposeRegistry = readYaml(".product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml");

test("J26 purpose-binds exact artifact deletion and keeps erasure finality source-bounded", () => {
  const effect = journey.pdp1ResultEvidence.lifecycleEffectBoundaries.artifactErasure;
  const binding = effect.capabilityActionBinding;
  const p0Journey = p0Journeys.journeys.find(({ id }) => id === "J-26");
  const capability = p0Capabilities.capabilities.find(({ id }) => id === "media.artifact.delete");
  const operation = p1.capabilityOperationContracts.records.find(
    ({ id }) => id === "media.operation.capability.media-artifact-delete",
  );
  const classifier = privacy.ownerDefinedErasureInventoryContract.erasureFinality.outcomeClassifier;
  const stepPurpose = purposeRegistry.records.find(({ id }) => id === "media.pdp3.step-purpose-binding.j26-step-02.v1");
  const deleteAction = stepPurpose?.relatedActionBindings?.find(({ id }) => id === "media.pdp3.action-binding.j26-artifact-delete.v1");

  assert.ok(p0Journey.intentRefs.includes(effect.journeyPurpose.purposeRef));
  assert.ok(capability.journeyRefs.includes(p0Journey.id));
  assert.deepEqual(binding.actorScope.eligibleActorRefs, capability.actorRefs);
  assert.equal(binding.capabilityRef, capability.id);
  assert.equal(binding.operationRef, operation.id);
  assert.equal(binding.operationKind, "COMMAND");
  assert.deepEqual(binding.authorityRefs, [
    ".product-experience/pdp-1-domain-data/authority.yaml#ownership.identityAuthenticationAndDelegation",
    ".product-experience/pdp-1-domain-data/authority.yaml#ownership.privilegedEffects",
  ]);
  assert.match(binding.target.artifactInput, /artifactId.*versionId/u);
  assert.match(binding.target.policyContextInput, /purposeRef.*rightsEvidenceRefs/u);
  assert.match(binding.target.identityRule, /exactly equal/u);
  assert.match(binding.effectBoundary, /acceptance is not deletion or erasure finality/u);

  const dispositions = effect.resultBoundary.dispositions;
  assert.deepEqual(Object.keys(dispositions), [
    "ACCESS_REVOKED",
    "BLOCKED_BY_HOLD",
    "ERASURE_REQUESTED",
    "PENDING",
    "EXTERNAL_ERASURE_UNCONFIRMED",
    "ERASURE_CONFIRMED",
  ]);
  assert.match(dispositions.PENDING, /exact P1 PHYSICAL_ERASURE_PENDING state/u);
  assert.match(dispositions.ERASURE_CONFIRMED, /exact current all-copy inventory/u);
  assert.match(classifier.rule, /COMPLETE inventory/u);
  assert.match(classifier.rule, /tombstone replay observation/u);
  assert.match(binding.unknownDisposition, /UNKNOWN_OUTCOME has no output claim/u);
  assert.match(binding.unknownDisposition, /cannot be promoted to success/u);
  assert.ok(stepPurpose && deleteAction, "the delete capability has a separate related action under an exact artifact/version inspection purpose");
  assert.equal(purposeRegistry.recordCount, 130, "the purpose-bound action does not add a journey step or change the denominator");
  assert.equal(deleteAction.journeyStepTransition, false);
  assert.equal(deleteAction.purposeRef, "media.intent.manage-artifact-lifecycle");
  assert.equal(deleteAction.capabilityRef, capability.id);
  assert.equal(deleteAction.operationRef, operation.id);
  assert.equal(deleteAction.operationKind, "COMMAND");
  assert.equal(deleteAction.requestSchemaRef, `${binding.operationSourceRef}/requestSchema`);
  assert.equal(deleteAction.resultSchemaRef, `${binding.operationSourceRef}/resultSchema`);
  assert.match(deleteAction.targetBinding.exactArtifactVersion, /exactly one immutable governed artifact version/u);
  assert.match(deleteAction.targetBinding.purposeAndPolicy, /rights, consent, retention, and hold evidence/u);
  assert.match(deleteAction.unknownDisposition, /pending\/UNKNOWN/u);
  assert.equal(deleteAction.runtimeAdmission, "NOT_ADMITTED");
  assert.deepEqual(Object.keys(deleteAction.resultClasses), [
    "sourceRef", "classifierRef", "ACCESS_REVOKED", "HOLD", "PENDING", "PARTIAL", "EXTERNAL_UNKNOWN", "ERASURE_CONFIRMED",
  ]);
  assert.equal(deleteAction.resultClasses.classifierRef,
    ".product-experience/pdp-1-domain-data/privacy.yaml#ownerDefinedErasureInventoryContract/erasureFinality/outcomeClassifier");
  assert.match(deleteAction.resultClasses.PARTIAL, /PARTIALLY_ERASED/u);
  assert.match(deleteAction.resultClasses.ERASURE_CONFIRMED, /exact current all-copy inventory/u);
  assert.equal(effect.journeyBindingStatus.includes("NOT_BOUND"), false);
  assert.ok(journey.sourceGap.sourceRefs.includes(
    ".product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml#records/@id=media.pdp3.step-purpose-binding.j26-step-02.v1/relatedActionBindings/@id=media.pdp3.action-binding.j26-artifact-delete.v1",
  ));
  assert.match(effect.resultBoundary.forbiddenInferences[0], /Consent inspection, consent revocation/u);
  assert.match(effect.resultBoundary.forbiddenInferences[1], /purge count, request\/command receipt/u);
  assert.match(effect.resultBoundary.forbiddenInferences[2], /is UNKNOWN, not ERASURE_CONFIRMED/u);
  assert.equal(effect.runtimeAdmission, "NOT_ADMITTED");
  assert.match(journey.channelBindingState, /UNBOUND.*NOT_ADMITTED/u);
});
