import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { evaluateLocalStepEffect } from "../scripts/lib/pdp3-local-step-effect-definition.mjs";

const require = createRequire(new URL("../../ghatana-tools/package.json", import.meta.url));
const { parse } = require("yaml");
const base = ".product-experience/pdp-3-product-experience";
const contracts = parse(await readFile(`${base}/local-step-effect-contracts.yaml`, "utf8"));
const stepOracles = parse(await readFile(`${base}/step-definition-oracles.yaml`, "utf8"));
const componentTypes = parse(await readFile(".product-experience/pdp-2-design-interface-system/component-value-types.yaml", "utf8"));
const actionRegistry = parse(await readFile(`${base}/action-registry.yaml`, "utf8"));
const actionById = new Map(actionRegistry.actions.map((action) => [action.id, action]));
const byStep = new Map(contracts.records.map((record) => [record.sourceRef, record]));
const localSteps = [];
for (const filename of (await readdir(`${base}/journey-contracts`)).filter((name) => name.endsWith(".yaml") && name !== "local-step-effect-contracts.yaml").sort()) {
  const journey = parse(await readFile(`${base}/journey-contracts/${filename}`, "utf8"));
  journey.steps.forEach((step, index) => {
    if (step.stepDefinitionSemantics?.action?.semanticRole === "LOCAL_SELECTION_OR_SESSION_DRAFT") {
      localSteps.push({ journey, filename, step, index, sourceRef: `${base}/journey-contracts/${filename}#/steps/${index}` });
    }
  });
}

function positiveInput(contract) {
  const candidateSchemaRef = contract.trustedContextContract.candidateSchemaRef;
  const candidateType = candidateSchemaRef?.split("/").at(-1);
  const candidateValue = candidateType === "ArtifactVersionCandidate" ? {
    versionRef: { tenantId: "tenant-a", artifactId: "artifact-a", versionId: "v1" },
    mediaType: "audio/wav", access: "authorized", rightsDisposition: "permitted-with-scope", integrityDisposition: "verified",
  } : candidateType === "SourceVersionCandidate" ? {
    versionRef: { tenantId: "tenant-a", artifactId: "artifact-a", versionId: "v1" },
    mediaType: "audio/wav", access: "authorized", rightsDisposition: "permitted-with-scope", sourceName: "Source A",
  } : candidateType === "IntentOption" ? {
    intentRef: "media.intent.create", label: "Create", availability: "available", reasonRef: null,
  } : candidateType === "CapabilityProfileDisposition" ? {
    capabilityRef: "media.audio.clean", profileRef: "media.profile.local-a", availability: "available", qualification: "qualified", reasonRef: "media.reason.qualified",
  } : "media.delivery.profile.v1";
  let patchValue = null;
  if (contract.effectMode === "DRAFT_PATCH") {
    const ref = contract.inputContract.mutation.valueSchemaRefs[0];
    const name = ref.split("/").at(-1);
    patchValue = name === "SceneEntityDraftValue" ? {
      sceneRef: "media.local-scene.session-1", entityRef: "media.entity.camera-1", entityKind: "camera",
      sourceVersionRef: null, materialRef: null, modelRef: null,
    } : name === "AdjustmentDraftValue" ? {
      parameterRef: "media.adjustment.exposure", targetVersionRef: { tenantId: "tenant-a", artifactId: "artifact-a", versionId: "v1" },
      value: 0.25, unitRef: "media.unit.normalized", boundsRef: "media.bounds.exposure.v1", validationDisposition: "valid",
    } : structuredClone(componentTypes.$defs[name].examples[0]);
  }
  const request = {
    sessionRef: "media.editor-session.test-1",
    actorRef: contract.actorRefs[0],
    tenantId: "tenant-a",
    workspaceRef: "workspace-a",
    projectRef: "media.project.test-1",
    expectedDraftRevision: 4,
    actionRef: contract.actionRef,
    draftSlotRef: contract.localDraftSlotRef,
    mutationId: `local-mutation:${contract.id}`,
    mutation: contract.effectMode === "DRAFT_PATCH"
      ? { kind: "PATCH_LOCAL_DRAFT_SLOT", value: patchValue }
      : { kind: "SELECT_CATALOG_ENTRY", candidateValue, catalogRef: "media.catalog.test", catalogRevision: 7 },
  };
  const trustedSession = {
    sessionRef: request.sessionRef,
    actorRef: request.actorRef,
    tenantId: request.tenantId,
    workspaceRef: request.workspaceRef,
    projectRef: request.projectRef,
    draftRevision: request.expectedDraftRevision,
    sessionCurrentness: "CURRENT",
    catalogContext: contract.effectMode === "DRAFT_PATCH" ? null : {
      catalogRef: "media.catalog.test",
      catalogRevision: 7,
      catalogCurrentness: "CURRENT",
      candidateValues: [candidateValue],
      candidateSchemaRef,
      authorityRef: contract.trustedContextContract.catalogContextRequired.authorityRef,
      tenantId: request.tenantId,
      workspaceRef: request.workspaceRef,
      projectRef: request.projectRef,
    },
  };
  return { request, trustedSession };
}

test("each local step has a distinct exact session-local contract, never a canonical product mutation", () => {
  assert.equal(contracts.schemaVersion, "media.pdp-3-local-step-effect-contracts.v1");
  assert.equal(contracts.recordCount, 25);
  assert.equal(contracts.records.length, 25);
  assert.equal(localSteps.length, 25);
  const oracleSteps = stepOracles.journeys.flatMap(({ steps }) => steps);
  assert.equal(oracleSteps.length, 130);
  assert.equal(byStep.size, 25);
  assert.equal(new Set(contracts.records.map(({ id }) => id)).size, 25);
  for (const item of localSteps) {
    const contract = byStep.get(item.sourceRef);
    assert.ok(contract, `${item.journey.journeyId}/${item.index + 1} exact local contract`);
    assert.equal(contract.actionRef, item.step.actionRef ?? item.step.stepDefinitionSemantics.action.actionRef);
    assert.deepEqual(contract.actorRefs, item.step.stepDefinitionSemantics.action.actorRefs);
    assert.equal(contract.stepIntent, item.step.intent ?? item.step.stepDefinitionSemantics.stepSourceFacts.intent);
    assert.deepEqual(contract.exactOperationRefs, []);
    assert.deepEqual(contract.canonicalDomainObjectRefs, item.step.objectRefs ?? []);
    assert.equal(contract.canonicalTransitionRef, null);
    assert.equal(contract.runtimeAdmission, "NOT_ADMITTED");
    assert.ok(contract.localScopeRequirements.tenantId && contract.localScopeRequirements.workspaceRef);
    assert.match(contract.localScopeRequirements.workspaceRef, /required/u);
    const binding = item.step.stepDefinitionSemantics;
    const exactContractRef = `${base}/local-step-effect-contracts.yaml#records/@id=${contract.id}`;
    assert.equal(binding.localStepEffectContractRef, exactContractRef);
    assert.equal(binding.canonicalBindings.localEffectContractId, contract.id);
    assert.equal(binding.canonicalBindings.localEffectContractRef, exactContractRef);
    const oracleStep = oracleSteps.find((candidate) => candidate.sourceRef === item.sourceRef);
    assert.ok(oracleStep, `exact step oracle exists for ${item.sourceRef}`);
    assert.equal(oracleStep.canonicalBindings.localEffectContractId, contract.id);
    assert.equal(oracleStep.canonicalBindings.localEffectContractRef, exactContractRef);
    assert.equal(oracleStep.canonicalBindings.localEffectEvaluatorRef,
      "scripts/lib/pdp3-local-step-effect-definition.mjs#evaluateLocalStepEffect");
    assert.equal(binding.canonicalBindings.localObjectRef, contract.localObjectRef);
    assert.equal(binding.canonicalBindings.localDraftSlotRef, contract.localDraftSlotRef);
    assert.equal(binding.canonicalBindings.localStateRef, contract.localStateRef);
    assert.deepEqual(binding.canonicalBindings.objectRefs, contract.canonicalDomainObjectRefs, "only selected immutable source candidates may carry canonical identity refs");
    assert.deepEqual(binding.canonicalBindings.objectRefs, item.step.objectRefs ?? []);
    assert.deepEqual(binding.canonicalBindings.stateRefs, [], "local draft revision is not a PDP-1 product state");
    assert.equal(binding.versionedObjectObservation.status, contract.canonicalDomainObjectRefs.length
      ? "EXACT_SOURCE_CANDIDATE_DOMAIN_IDENTITY; LOCAL_SELECTION_ONLY; NO_CANONICAL_MUTATION"
      : "LOCAL_EDITOR_SESSION_DRAFT_ONLY; CANONICAL_MEDIA_OBJECT_EQUIVALENCE_NOT_ASSERTED");
    assert.deepEqual(binding.versionedObjectObservation.canonicalObjectRefs, contract.canonicalDomainObjectRefs);
    const { request, trustedSession } = positiveInput(contract);
    const result = evaluateLocalStepEffect(contract, request, trustedSession);
    assert.equal(result.disposition, "LOCAL_PATCH_ELIGIBLE_NOT_APPLIED", `${contract.id}: ${result.reason}`);
    assert.equal(result.localPatchApplied, false);
    assert.equal(result.remoteDispatch, "NONE");
    assert.equal(result.committedMediaEffect, false);
    assert.equal(result.nextDraftRevision, request.expectedDraftRevision + 1);
    assert.equal(result.retryAuthorized, false);
  }
});

test("local effect contracts cannot absorb consequential source actions", async () => {
  for (const contract of contracts.records) {
    const typedAction = actionById.get(contract.actionRef)?.actionDefinitionSemantics?.typedDefinition;
    assert.equal(typedAction?.semanticRole, "LOCAL_SELECTION_OR_SESSION_DRAFT", `${contract.id} source action is not local`);
    assert.deepEqual(typedAction?.exactOperationRefs, [], `${contract.id} must not bind a canonical operation`);
    assert.deepEqual(typedAction?.actorRefs, contract.actorRefs, `${contract.id} actor scope must match the source action`);
  }
  const j08 = parse(await readFile(`${base}/journey-contracts/repair-video-with-measured-quality.yaml`, "utf8"));
  assert.equal(j08.steps[1].stepDefinitionSemantics.action.semanticRole, "DOMAIN_OPERATION");
  assert.equal(j08.steps[1].stepDefinitionSemantics.action.actionRef, "media.action.submit-validated-request");
  const contract = contracts.records[0];
  const fixture = positiveInput(contract);
  const forged = { ...contract, actionRef: "media.action.submit-validated-request" };
  assert.equal(evaluateLocalStepEffect(forged, {
    ...fixture.request,
    actionRef: "media.action.submit-validated-request",
  }, fixture.trustedSession).disposition, "HOLD_UNKNOWN");
});

test("local effects fail closed for stale, mismatched, malformed, and unknown session/catalog evidence", () => {
  for (const contract of contracts.records) {
    const { request, trustedSession } = positiveInput(contract);
    const staleRevision = evaluateLocalStepEffect(contract, { ...request, expectedDraftRevision: 3 }, trustedSession);
    assert.equal(staleRevision.disposition, "DENIED_NO_LOCAL_PATCH", `${contract.id}: ${staleRevision.reason}`);
    assert.equal(evaluateLocalStepEffect(contract, request, { ...trustedSession, sessionCurrentness: "UNKNOWN" }).disposition, "HOLD_UNKNOWN");
    assert.equal(evaluateLocalStepEffect(contract, { ...request, actorRef: "media.attacker" }, trustedSession).localPatchApplied, false);
    assert.equal(evaluateLocalStepEffect(contract, { ...request, draftSlotRef: "media.local-draft.slot.other" }, trustedSession).disposition, "HOLD_UNKNOWN");
    assert.equal(evaluateLocalStepEffect(contract, request, { ...trustedSession, sessionRef: "media.editor-session.other" }).disposition, "HOLD_UNKNOWN");
    assert.equal(evaluateLocalStepEffect(contract, { ...request, mutation: { ...request.mutation, extra: true } }, trustedSession).disposition, "HOLD_UNKNOWN");
    assert.equal(evaluateLocalStepEffect(contract, request, null).disposition, "HOLD_UNKNOWN");
    if (contract.effectMode !== "DRAFT_PATCH") {
      assert.equal(evaluateLocalStepEffect(contract, request, { ...trustedSession, catalogContext: { ...trustedSession.catalogContext, catalogCurrentness: "UNKNOWN" } }).disposition, "HOLD_UNKNOWN");
      assert.equal(evaluateLocalStepEffect(contract, request, { ...trustedSession, catalogContext: { ...trustedSession.catalogContext, candidateValues: [] } }).disposition, "DENIED_NO_LOCAL_PATCH");
      assert.equal(evaluateLocalStepEffect(contract, request, { ...trustedSession, catalogContext: { ...trustedSession.catalogContext, catalogRevision: 8 } }).disposition, "HOLD_UNKNOWN");
      assert.equal(evaluateLocalStepEffect(contract, request, { ...trustedSession, catalogContext: { ...trustedSession.catalogContext, tenantId: "tenant-foreign" } }).disposition, "HOLD_UNKNOWN");
      assert.equal(evaluateLocalStepEffect(contract, request, { ...trustedSession, catalogContext: { ...trustedSession.catalogContext, projectRef: "media.project.foreign" } }).disposition, "HOLD_UNKNOWN");
      const staleCandidate = structuredClone(request.mutation.candidateValue);
      if (typeof staleCandidate === "object") {
        if (Object.hasOwn(staleCandidate, "availability")) staleCandidate.availability = "unavailable";
        if (Object.hasOwn(staleCandidate, "access")) staleCandidate.access = "unknown";
        if (Object.hasOwn(staleCandidate, "qualification")) staleCandidate.qualification = "not-evaluated";
        const staleCandidateSession = { ...trustedSession, catalogContext: { ...trustedSession.catalogContext, candidateValues: [staleCandidate] } };
        const staleCandidateRequest = { ...request, mutation: { ...request.mutation, candidateValue: staleCandidate } };
        assert.equal(evaluateLocalStepEffect(contract, staleCandidateRequest, staleCandidateSession).disposition, "DENIED_NO_LOCAL_PATCH");
      }
      const extraCandidate = { ...(typeof request.mutation.candidateValue === "object" ? request.mutation.candidateValue : {}), injected: true };
      assert.equal(evaluateLocalStepEffect(contract, { ...request, mutation: { ...request.mutation, candidateValue: extraCandidate } }, trustedSession).disposition, "HOLD_UNKNOWN");
    } else {
      assert.equal(evaluateLocalStepEffect(contract, { ...request, projectRef: null }, { ...trustedSession, projectRef: null }).disposition, "HOLD_UNKNOWN");
      assert.equal(evaluateLocalStepEffect(contract, { ...request, expectedDraftRevision: Number.MAX_SAFE_INTEGER }, { ...trustedSession, draftRevision: Number.MAX_SAFE_INTEGER }).disposition, "HOLD_UNKNOWN");
      const overlappingSchemas = structuredClone(contract);
      overlappingSchemas.inputContract.mutation.valueSchemaRefs.push(overlappingSchemas.inputContract.mutation.valueSchemaRefs[0]);
      assert.equal(evaluateLocalStepEffect(overlappingSchemas, request, trustedSession).disposition, "HOLD_UNKNOWN");
    }
  }
});

test("selection and draft values cannot escape the closed local-session contract", () => {
  const edit = contracts.records.find((record) => record.effectMode === "DRAFT_PATCH");
  const editFixture = positiveInput(edit);
  assert.equal(evaluateLocalStepEffect(edit, { ...editFixture.request, mutation: { kind: "PATCH_LOCAL_DRAFT_SLOT", value: { nested: { bad: NaN } } } }, editFixture.trustedSession).disposition, "HOLD_UNKNOWN");
  const extraPatchValue = { ...editFixture.request.mutation.value, injected: true };
  assert.equal(evaluateLocalStepEffect(edit, { ...editFixture.request, mutation: { ...editFixture.request.mutation, value: extraPatchValue } }, editFixture.trustedSession).disposition, "HOLD_UNKNOWN");
  assert.equal(evaluateLocalStepEffect(edit, { ...editFixture.request, mutation: { kind: "PATCH_LOCAL_DRAFT_SLOT", value: "untyped scalar" } }, editFixture.trustedSession).disposition, "HOLD_UNKNOWN");
  const select = contracts.records.find((record) => record.actionRef === "media.action.choose-intent");
  const selectFixture = positiveInput(select);
  assert.equal(evaluateLocalStepEffect(select, { ...selectFixture.request, mutation: { ...selectFixture.request.mutation, candidateValue: { ...selectFixture.request.mutation.candidateValue, intentRef: "media.intent.animate", label: "Other" } } }, selectFixture.trustedSession).disposition, "DENIED_NO_LOCAL_PATCH");
  assert.equal(evaluateLocalStepEffect({ ...edit, runtimeAdmission: "ADMITTED" }, editFixture.request, editFixture.trustedSession).disposition, "HOLD_UNKNOWN");
});
