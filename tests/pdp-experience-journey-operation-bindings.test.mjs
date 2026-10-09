import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { evaluatePdp3JourneyOperationBinding, resolvePdp3BindingSourceRef } from "../scripts/lib/pdp3-journey-operation-binding.mjs";

const require = createRequire(new URL("../../ghatana-tools/package.json", import.meta.url));
const { parse } = require("yaml");
const p3 = ".product-experience/pdp-3-product-experience";
const operationsPath = ".product-experience/pdp-1-domain-data/operations.yaml";
const [operationsText, objectsText, statesText, authorityText, privacyText, policyText, requirementsText, actionsText, oracleText] = await Promise.all([
  readFile(operationsPath, "utf8"),
  readFile(".product-experience/pdp-1-domain-data/domain-objects.yaml", "utf8"),
  readFile(".product-experience/pdp-1-domain-data/states.yaml", "utf8"),
  readFile(".product-experience/pdp-1-domain-data/authority.yaml", "utf8"),
  readFile(".product-experience/pdp-1-domain-data/privacy.yaml", "utf8"),
  readFile(".product-experience/pdp-0-product-truth/policy-authority-model.yaml", "utf8"),
  readFile(".product-experience/pdp-0-product-truth/requirements.yaml", "utf8"),
  readFile(`${p3}/action-registry.yaml`, "utf8"),
  readFile(`${p3}/step-definition-oracles.yaml`, "utf8"),
]);
const operations = parse(operationsText);
const sourceDocuments = {
  [operationsPath]: operations,
  ".product-experience/pdp-1-domain-data/domain-objects.yaml": parse(objectsText),
  ".product-experience/pdp-1-domain-data/states.yaml": parse(statesText),
  ".product-experience/pdp-1-domain-data/authority.yaml": parse(authorityText),
  ".product-experience/pdp-1-domain-data/privacy.yaml": parse(privacyText),
  ".product-experience/pdp-0-product-truth/policy-authority-model.yaml": parse(policyText),
  ".product-experience/pdp-0-product-truth/requirements.yaml": parse(requirementsText),
  [`${p3}/action-registry.yaml`]: parse(actionsText),
};
const joins = operations.ownerDefinedJourneyOperationBindings.records;
const oracleSteps = parse(oracleText).journeys.flatMap(({ steps }) => steps);
const byId = new Map(joins.map((record) => [record.id, record]));

test("PDP-1 operation selectors resolve exact array records and reject dotted pseudo-identities", () => {
  const operationId = "media.operation.capability.media-stream-session-reconnect";
  const exactRef = `${operationsPath}#capabilityOperationContracts/records/@id=${operationId}`;
  const dottedRef = `${operationsPath}#capabilityOperationContracts.records.${operationId}`;
  const exactRecord = resolvePdp3BindingSourceRef(exactRef, sourceDocuments);
  assert.equal(exactRecord?.id, operationId);
  assert.equal(resolvePdp3BindingSourceRef(dottedRef, sourceDocuments), undefined);
});

test("each PDP-1 journey operation join is projected with exact operation, object, state, authority, and requirement refs", () => {
  assert.equal(joins.length, 19);
  assert.equal(byId.size, 19);
  for (const join of joins) {
    const sourceRef = join.journeyStepRef.replace("#steps/", "#/steps/");
    const step = oracleSteps.find((candidate) => candidate.sourceRef === sourceRef);
    assert.ok(step, `${join.id} resolves to one exact PDP-3 step`);
    const projection = step.canonicalBindings;
    assert.equal(projection.pdp1JourneyOperationBindingId, join.id);
    assert.equal(projection.pdp1JourneyOperationBindingRef,
      `${operationsPath}#ownerDefinedJourneyOperationBindings/records/@id=${join.id}`);
    assert.deepEqual(projection.primaryOperationRefs, join.operationRefs ?? [join.operationRef]);
    assert.deepEqual(projection.supportingObservationOperationRefs, join.supportingObservationOperationRefs ?? []);
    assert.deepEqual(projection.ownerDomainObjectRefs, join.domainObjectRefs);
    assert.deepEqual(projection.ownerStateRefs, join.stateRefs);
    assert.deepEqual(projection.ownerAuthorityRefs, join.authorityRefs);
    assert.deepEqual(projection.ownerRequirementRefs, join.requirementRefs);
    assert.equal(projection.stateBindingDisposition, join.stateBindingDisposition);
    assert.equal(projection.ownerResultSemantics, join.ownerResultSemantics);
    assert.deepEqual(projection.failClosedCases, join.failClosedCases);
    assert.equal(projection.ownerOperationScopeStatus, join.scopeStatus);
    assert.equal(step.actionRef, join.actionRef);

    const result = evaluatePdp3JourneyOperationBinding(step, join, sourceDocuments);
    assert.ok(["QUERY_DEFINITION_ONLY", "REQUEST_DEFINITION_ONLY"].includes(result.disposition), `${join.id}: ${result.reason}`);
    assert.equal(result.dispatch, "NONE");
    assert.equal(result.effectApplied, false);
    assert.equal(result.finality, "NOT_ESTABLISHED_BY_DEFINITION_ORACLE");
    assert.equal(result.retryAuthorized, false);
    assert.equal(result.runtimeAdmission, "NOT_ADMITTED");
    assert.deepEqual(result.domainObjectRefs, join.domainObjectRefs);
    assert.deepEqual(result.stateRefs, join.stateRefs);
    assert.deepEqual(result.authorityRefs, join.authorityRefs);
    assert.deepEqual(result.requirementRefs, join.requirementRefs);
  }
});

test("PDP-3 step bindings reject different but valid same-source identities and reordered commands", () => {
  const composite = joins.find((join) => join.operationKind === "COMPOSITE_COMMAND_SEQUENCE");
  assert.ok(composite, "upload resume is an explicitly ordered command sequence");
  const step = oracleSteps.find((candidate) => candidate.sourceRef === composite.journeyStepRef.replace("#steps/", "#/steps/"));
  const valid = () => evaluatePdp3JourneyOperationBinding(step, composite, sourceDocuments).disposition;
  assert.equal(valid(), "REQUEST_DEFINITION_ONLY");

  const swappedStepAction = structuredClone(step);
  swappedStepAction.actionRef = "media.action.create-project";
  assert.equal(evaluatePdp3JourneyOperationBinding(swappedStepAction, composite, sourceDocuments).disposition, "HOLD_UNKNOWN");

  const otherSameKindOperation = structuredClone(composite);
  otherSameKindOperation.operationRefs = [...composite.operationRefs].reverse();
  otherSameKindOperation.operationDefinitionRefs = [...composite.operationDefinitionRefs].reverse();
  assert.equal(evaluatePdp3JourneyOperationBinding(step, otherSameKindOperation, sourceDocuments).disposition, "HOLD_UNKNOWN");

  const alternateObjectStep = structuredClone(step);
  alternateObjectStep.canonicalBindings.ownerDomainObjectRefs = ["media.domain.project"];
  assert.equal(evaluatePdp3JourneyOperationBinding(alternateObjectStep, composite, sourceDocuments).disposition, "HOLD_UNKNOWN");

  const alternateStateStep = structuredClone(step);
  alternateStateStep.canonicalBindings.ownerStateRefs = [".product-experience/pdp-1-domain-data/states.yaml#stateMachines/media-job/stateDefinitions/QUEUED"];
  assert.equal(evaluatePdp3JourneyOperationBinding(alternateStateStep, composite, sourceDocuments).disposition, "HOLD_UNKNOWN");

  const alternateAuthorityStep = structuredClone(step);
  alternateAuthorityStep.canonicalBindings.ownerAuthorityRefs = [".product-experience/pdp-1-domain-data/authority.yaml#ownership.identityAuthenticationAndDelegation"];
  assert.equal(evaluatePdp3JourneyOperationBinding(alternateAuthorityStep, composite, sourceDocuments).disposition, "HOLD_UNKNOWN");

  const alternateRequirementStep = structuredClone(step);
  alternateRequirementStep.canonicalBindings.ownerRequirementRefs = [".product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-PROJECT"];
  assert.equal(evaluatePdp3JourneyOperationBinding(alternateRequirementStep, composite, sourceDocuments).disposition, "HOLD_UNKNOWN");

  const forgedOwnerBinding = structuredClone(composite);
  forgedOwnerBinding.operationDefinitionRefs[0] = composite.operationDefinitionRefs[1];
  assert.equal(evaluatePdp3JourneyOperationBinding(step, forgedOwnerBinding, sourceDocuments).disposition, "HOLD_UNKNOWN");
});

test("artifact state observation is a supporting read, never artifact availability or erase finality", () => {
  const join = joins.find((record) => record.operationRef === "media.operation-slice.inspect-artifact" &&
    record.supportingObservationOperationRefs?.includes("media.operation.artifact.lifecycle.observe.v1"));
  assert.ok(join);
  const step = oracleSteps.find((candidate) => candidate.sourceRef === join.journeyStepRef.replace("#steps/", "#/steps/"));
  const result = evaluatePdp3JourneyOperationBinding(step, join, sourceDocuments);
  assert.equal(result.disposition, "QUERY_DEFINITION_ONLY");
  assert.match(join.ownerResultSemantics, /lifecycle state comes only from the separate lifecycle observer/u);
  assert.ok(join.stateRefs.some((ref) => ref.endsWith("/AVAILABLE")));
  assert.ok(join.stateRefs.some((ref) => ref.endsWith("/ERASURE_CONFIRMED")));
  assert.equal(result.finality, "NOT_ESTABLISHED_BY_DEFINITION_ORACLE");
  assert.equal(result.dispatch, "NONE");
});
