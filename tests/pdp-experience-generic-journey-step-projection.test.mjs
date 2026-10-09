import test from "node:test";
import assert from "node:assert/strict";
import { isPdp3ReferenceInStepScope, projectPdp3JourneyStepSemantics as projectCore } from "../scripts/lib/pdp3-experience-journey-step-projection.mjs";

const kinds = new Map([
  ["media.op.append", "COMMAND"], ["media.op.complete", "COMMAND"],
  ["media.op.inspect", "QUERY"], ["media.op.option-a", "COMMAND"], ["media.op.option-b", "COMMAND"],
]);

function versionBinding(sourceRef, id, versionFieldBindings = [], journeyRef = "J-01", stepSemanticDefinitionId = "J-01.step-01") {
  return {
    id, journeyRef, stepSemanticDefinitionId, stepRef: sourceRef, runtimeAdmission: "NOT_ADMITTED", acceptanceEffect: "none",
    versionFieldBindings, versionDisposition: versionFieldBindings.length ? "EXACT_CANONICAL_VERSION_TUPLE_REQUIRED" : "NO_CANONICAL_OBJECT_VERSION_TUPLE_IN_STEP_SOURCE",
  };
}

function projectPdp3JourneyStepSemantics(input) {
  const ownerBinding = {
    ...(input.ownerBinding ?? input.oracleStep?.canonicalBindings ?? {}),
    id: input.ownerBinding?.id ?? "media.test-owner-binding.v1",
    journeyStepRef: input.sourceRef,
  };
  const sourceBindingRef = `.product-experience/pdp-3-product-experience/test-owner-bindings.yaml#records/@id=${ownerBinding.id}`;
  const resolveDefinitionRef = input.resolveDefinitionRef ?? (() => true);
  return projectCore({
    ...input,
    ownerBinding,
    sourceBindingRef,
    resolveDefinitionRef: (ref) => ref === sourceBindingRef ? ownerBinding
      : typeof ref === "string" ? resolveDefinitionRef(ref) : undefined,
  });
}

test("projects a P1 ordered workflow with a separate supporting observation", () => {
  const sourceRef = ".product-experience/pdp-3-product-experience/journey-contracts/upload.yaml#/steps/2";
  const semantics = projectPdp3JourneyStepSemantics({
    sourceRef,
    oracleStep: { id: "J-01.step-01", journeyId: "J-01", sourceRef, canonicalBindings: { bindingKind: "EXPLICIT_ORDERED_WORKFLOW", actionRef: "media.action.resume-upload", actorRefs: ["media.creator"], guardRefs: ["media.guard.upload"], sourceRefs: [sourceRef] } },
    ownerBinding: {
      operationRefs: ["media.op.append", "media.op.complete"], supportingObservationOperationRefs: ["media.op.inspect"],
      domainObjectRefs: ["media.domain.upload-session"], stateRefs: [".product-experience/pdp-1-domain-data/states.yaml#stateMachines/upload/RECEIVING"],
      authorityRefs: [".product-experience/pdp-1-domain-data/authority.yaml#identity"], requirementRefs: ["MEDIA-REQ-UPLOAD"],
    },
    versionBinding: versionBinding(sourceRef, "media.step-version-binding.j-01-03.v1"),
    actionIds: new Set(["media.action.resume-upload"]), operationKindsByRef: kinds,
    effectRefsByAction: new Map(), finalityByAction: new Map(),
    validObjectRefs: new Set(["media.domain.upload-session"]),
    resolveDefinitionRef: (ref) => ref === `.product-experience/pdp-3-product-experience/step-version-binding-contracts.yaml#records/@id=${versionBinding(sourceRef, "media.step-version-binding.j-01-03.v1").id}` ? versionBinding(sourceRef, "media.step-version-binding.j-01-03.v1") : true,
  });
  assert.equal(semantics.bindingDisposition, "ORDERED_WORKFLOW");
  assert.deepEqual(semantics.operationRefs, ["media.op.append", "media.op.complete"]);
  assert.deepEqual(semantics.supportingOperationRefs, ["media.op.inspect"]);
  assert.deepEqual(semantics.supportingOperationKinds, ["QUERY"]);
  assert.deepEqual(semantics.stateRefs, [".product-experience/pdp-1-domain-data/states.yaml#stateMachines/upload/RECEIVING"]);
  assert.deepEqual(semantics.authorityRefs, [".product-experience/pdp-1-domain-data/authority.yaml#identity"]);
});

test("keeps a passive consent read as supporting observation without turning it into a mutating action", () => {
  const sourceRef = ".product-experience/pdp-3-product-experience/journey-contracts/live-session-loss-consent-change-and-bounded-recovery.yaml#/steps/0";
  const binding = versionBinding(sourceRef, "media.step-version-binding.j-29-01.v1", [], "J-29", "J-29.step-01");
  const stepRef = `.product-experience/pdp-3-product-experience/step-version-binding-contracts.yaml#records/@id=${binding.id}`;
  const projected = projectPdp3JourneyStepSemantics({
    sourceRef,
    oracleStep: { id: "J-29.step-01", journeyId: "J-29", sourceRef, canonicalBindings: {
      bindingKind: "EXPLICIT_NO_DOMAIN_DISPATCH", actionRef: null, operationRefs: [],
      supportingObservationOperationRefs: ["media.operation.consent-record-inspect.v1"],
      actorRefs: ["media.creator"], guardRefs: [], sourceRefs: [sourceRef], domainObjectRefs: [], stateRefs: [], authorityRefs: [],
    } },
    versionBinding: binding, actionIds: new Set(), operationKindsByRef: new Map([...kinds, ["media.operation.consent-record-inspect.v1", "QUERY"]]),
    effectRefsByAction: new Map(), finalityByAction: new Map(), recoveryRefsByAction: new Map(), validObjectRefs: new Set(),
    resolveDefinitionRef: (ref) => ref === stepRef ? binding : undefined,
  });
  assert.equal(projected.bindingDisposition, "NO_DISPATCH");
  assert.deepEqual(projected.actionRefs, []);
  assert.deepEqual(projected.operationRefs, []);
  assert.deepEqual(projected.supportingOperationRefs, ["media.operation.consent-record-inspect.v1"]);
  assert.deepEqual(projected.supportingOperationKinds, ["QUERY"]);
});

test("keeps Media's identity handoff as a bound single action while Shared wire mapping stays separate", () => {
  const sourceRef = ".product-experience/pdp-3-product-experience/journey-contracts/first-use-and-project-creation.yaml#/steps/0";
  const actionRef = "media.action.select-identity-confirmed-workspace";
  const binding = versionBinding(sourceRef, "media.step-version-binding.j-01-01.v1", [], "J-01", "J-01.step-01");
  const projected = projectPdp3JourneyStepSemantics({
    sourceRef,
    oracleStep: { id: "J-01.step-01", journeyId: "J-01", sourceRef, canonicalBindings: {
      bindingKind: "EXTERNAL_SHARED_IDENTITY_HANDOFF_BOUNDARY", actionRef,
      actorRefs: ["media.creator"], operationRefs: [], domainObjectRefs: [], stateRefs: [],
      authorityRefs: [], requirementRefs: [], guardRefs: ["resolve-context"], sourceRefs: [sourceRef],
    } },
    versionBinding: binding, actionIds: new Set([actionRef]), operationKindsByRef: new Map(),
    effectRefsByAction: new Map(), finalityByAction: new Map(), recoveryRefsByAction: new Map(), validObjectRefs: new Set(),
    resolveDefinitionRef: (ref) => ref === `.product-experience/pdp-3-product-experience/step-version-binding-contracts.yaml#records/@id=${binding.id}` ? binding : true,
  });
  assert.equal(projected.bindingDisposition, "SINGLE_ACTION");
  assert.deepEqual(projected.actionRefs, [actionRef]);
  assert.deepEqual(projected.operationRefs, []);
  assert.deepEqual(projected.objectRefs, []);
  assert.deepEqual(projected.objectVersionRefs, []);
});

test("projects user-selected capability alternatives without defaulting a branch", () => {
  const sourceRef = ".product-experience/pdp-3-product-experience/journey-contracts/generate.yaml#/steps/0";
  const semantics = projectPdp3JourneyStepSemantics({
    sourceRef,
    oracleStep: { id: "J-01.step-01", journeyId: "J-01", sourceRef, canonicalBindings: {
      bindingKind: "EXPLICIT_USER_CHOICE_AMONG_EXACT_OPERATIONS", actionRef: "media.action.submit-request",
      actorRefs: ["media.creator"], operationRefs: ["media.op.generic-dispatch"], operationKinds: ["COMMAND"],
      capabilityOptions: [
        { operationRefs: ["media.op.option-a"] }, { operationRefs: ["media.op.option-b"] },
      ], domainObjectRefs: [], stateRefs: [], authorityRefs: [], requirementRefs: [], guardRefs: [], sourceRefs: [sourceRef],
    } },
    versionBinding: versionBinding(sourceRef, "media.step-version-binding.j-01-01.v1"),
    actionIds: new Set(["media.action.submit-request"]), operationKindsByRef: kinds,
    effectRefsByAction: new Map(), finalityByAction: new Map(),
    validObjectRefs: new Set(),
    resolveDefinitionRef: (ref) => ref === `.product-experience/pdp-3-product-experience/step-version-binding-contracts.yaml#records/@id=${versionBinding(sourceRef, "media.step-version-binding.j-01-01.v1").id}` ? versionBinding(sourceRef, "media.step-version-binding.j-01-01.v1") : true,
  });
  assert.equal(semantics.bindingDisposition, "ACTION_CHOICE");
  assert.deepEqual(semantics.operationRefs, ["media.op.option-a", "media.op.option-b"]);
  assert.deepEqual(semantics.choiceAlternatives, [
    { actionRefs: ["media.action.submit-request"], operationRefs: ["media.op.option-a"] },
    { actionRefs: ["media.action.submit-request"], operationRefs: ["media.op.option-b"] },
  ]);
});

test("fails closed for missing or untyped source operation identities", () => {
  const sourceRef = ".product-experience/pdp-3-product-experience/journey-contracts/query.yaml#/steps/0";
  const input = {
    sourceRef,
    oracleStep: { sourceRef, canonicalBindings: { bindingKind: "EXACT_SINGLE_OPERATION", actionRef: null, operationRefs: ["media.op.untyped"], actorRefs: [], guardRefs: [], sourceRefs: [sourceRef] } },
    actionIds: new Set(), operationKindsByRef: kinds,
    effectRefsByAction: new Map(), finalityByAction: new Map(),
    versionBinding: versionBinding(sourceRef, "media.step-version-binding.j-01-01.v1"),
    validObjectRefs: new Set(), resolveDefinitionRef: () => undefined,
  };
  assert.equal(projectPdp3JourneyStepSemantics(input), undefined);
  assert.equal(projectPdp3JourneyStepSemantics({ ...input, sourceRef: "foreign" }), undefined);
});

test("projects only the exact per-step version definition refs", () => {
  const sourceRef = ".product-experience/pdp-3-product-experience/journey-contracts/read.yaml#/steps/0";
  const stepVersionRef = ".product-experience/pdp-3-product-experience/step-version-binding-contracts.yaml#records/@id=media.step-version-binding.j-01-01.v1";
  const field = {
    id: "media.step-version-object-binding.j-01-01.artifact-version.v1", objectRef: "media.domain.artifact-version",
    coverageDisposition: "EXACT_VERSION_REQUEST_OR_RESULT_FIELD_BOUND", fields: [{ direction: "REQUEST", operationRef: "media.op.inspect" }],
    canonicalVersionIdentityRequirement: { identityContractRef: "identity-contract-ref", identityComponentsRef: "identity-components-ref" },
  };
  const binding = { ...versionBinding(sourceRef, "media.step-version-binding.j-01-01.v1", [field]), journeyRef: "J-01", stepSemanticDefinitionId: "J-01.step-01" };
  const oracleStep = { id: "J-01.step-01", journeyId: "J-01", sourceRef, canonicalBindings: {
    bindingKind: "EXACT_SINGLE_OPERATION", actionRef: null, operationRefs: ["media.op.inspect"], actorRefs: [],
    guardRefs: [], sourceRefs: [sourceRef], domainObjectRefs: ["media.domain.artifact-version"],
  } };
  const input = {
    sourceRef, oracleStep, versionBinding: binding, actionIds: new Set(), operationKindsByRef: kinds,
    effectRefsByAction: new Map(), finalityByAction: new Map(), validObjectRefs: new Set(["media.domain.artifact-version"]),
    resolveDefinitionRef: (ref) => ref === stepVersionRef ? binding
      : ref.endsWith("/versionFieldBindings/@id=media.step-version-object-binding.j-01-01.artifact-version.v1") ? field
        : ref === "identity-contract-ref" || ref === "identity-components-ref" ? {} : undefined,
  };
  const projected = projectPdp3JourneyStepSemantics(input);
  assert.deepEqual(projected.objectVersionRefs, [`${stepVersionRef}/versionFieldBindings/@id=media.step-version-object-binding.j-01-01.artifact-version.v1`]);
  assert.equal(projectPdp3JourneyStepSemantics({ ...input, versionBinding: { ...binding, stepRef: "foreign" } }), undefined);
  assert.equal(projectPdp3JourneyStepSemantics({ ...input, versionBinding: { ...binding, versionFieldBindings: [{ ...field, objectRef: "media.domain.foreign" }] } }), undefined);
});

test("reference resolution is scoped to the exact public journey-step owner", () => {
  const reference = ".product-experience/pdp-3-product-experience/step-version-binding-contracts.yaml#records/@id=media.step-version-binding.j-02-01.v1/versionFieldBindings/@id=media.step-version-object-binding.j-02-01.artifact-version.v1";
  const owners = new Map([[reference, "journey 'J-02' step 'J02-1'"]]);
  assert.equal(isPdp3ReferenceInStepScope({ ref: reference, owner: "journey 'J-02' step 'J02-1'", ownersByReference: owners }), true);
  assert.equal(isPdp3ReferenceInStepScope({ ref: reference, owner: "journey 'J-03' step 'J03-1'", ownersByReference: owners }), false);
  assert.equal(isPdp3ReferenceInStepScope({ ref: reference, owner: undefined, ownersByReference: owners }), false);
  assert.equal(isPdp3ReferenceInStepScope({ ref: `${reference}/unknown`, owner: "journey 'J-02' step 'J-02.step-01'", ownersByReference: owners }), false);
});
