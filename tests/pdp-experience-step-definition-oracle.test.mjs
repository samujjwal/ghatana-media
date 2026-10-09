import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluatePdp3StepDefinition } from "../scripts/lib/pdp3-step-definition-oracle.mjs";
import { validatePdp3StepCapabilityPurpose } from "../scripts/lib/pdp3-step-capability-purpose.mjs";
import { resolvePdp3BindingSourceRef } from "../scripts/lib/pdp3-journey-operation-binding.mjs";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const base = ".product-experience/pdp-3-product-experience";
const actions = parse(await readFile(`${base}/action-registry.yaml`, "utf8")).actions;
const ownerActions = parse(await readFile(`${base}/action-registry.yaml`, "utf8")).ownerDefinedActions ?? [];
const stepOracleSource = parse(await readFile(`${base}/step-definition-oracles.yaml`, "utf8"));
const capabilitySource = parse(await readFile(".product-experience/pdp-0-product-truth/capabilities.yaml", "utf8"));
const p0JourneyCatalog = parse(await readFile(".product-experience/pdp-0-product-truth/journey-catalog.yaml", "utf8"));
const capabilitiesById = new Map(capabilitySource.capabilities.map((capability) => [capability.id, capability]));
const journeys = [];
for (const filename of (await readdir(`${base}/journey-contracts`)).filter((name) => name.endsWith(".yaml")).sort()) {
  const document = parse(await readFile(`${base}/journey-contracts/${filename}`, "utf8"));
  journeys.push({ filename, document });
}
const operationDocument = parse(await readFile(".product-experience/pdp-1-domain-data/operations.yaml", "utf8"));
const operationKinds = {};
for (const collection of [operationDocument.operations ?? [], operationDocument.individualOperationContracts?.records ?? [], operationDocument.ownerDefinedOperationContracts?.records ?? [], operationDocument.capabilityOperationContracts?.records ?? []]) {
  for (const operation of collection) {
    if (!operation.id) continue;
    const refs = [operation.id, ...(operation.operationRefs ?? [])];
    for (const ref of refs) if (operation.operationKind) operationKinds[ref] = operation.operationKind;
  }
}
for (const operation of operationDocument.individualOperationContracts?.records ?? []) {
  if (operation.id && operation.operationKind) operationKinds[operation.id] = operation.operationKind;
}
const actionById = new Map(actions.map((action) => [action.id, action]));
const ownerActionById = new Map(ownerActions.map((action) => [action.id, action]));
const oracleOptions = { operationKinds, ownerActionsById: ownerActionById };
const steps = journeys.flatMap(({ filename, document }) => document.steps.map((step, index) => ({ filename, journey: document, index, step })));

function inputFor(binding, actorRef, fixtureOutcomes, selectedActionRef = null) {
  return {
    sourceRef: binding.sourceRef,
    actorRef,
    targetRefs: binding.canonicalBindings.objectRefs,
    fixtureGuardOutcomes: fixtureOutcomes,
    selectedActionRef,
  };
}

test("all 130 steps bind fail-closed, but fixture booleans never establish guard semantics", () => {
  assert.equal(steps.length, 130);
  const outcomes = new Set();
  for (const { journey, index, step } of steps) {
    const binding = step.stepDefinitionSemantics;
    assert.ok(binding, `${journey.journeyId}/${index + 1} has a source definition`);
    const choice = binding.action.choiceSet ?? binding.choiceSet;
    if (choice) {
      const pending = evaluatePdp3StepDefinition(binding, inputFor(binding, "media.creator", {}, null), oracleOptions);
      assert.equal(pending.disposition, "CHOICE_PENDING", `${journey.journeyId}/${index + 1} must wait for explicit user selection`);
      outcomes.add(pending.disposition);
      const forged = evaluatePdp3StepDefinition(binding, inputFor(binding, "media.creator", {}, "media.action.not-in-choice-set"), oracleOptions);
      assert.equal(forged.disposition, "HOLD_UNKNOWN");
      assert.equal(forged.dispatch, "NONE");
      continue;
    }
    if (binding.ownerActionRef) {
      const ownerAction = ownerActionById.get(binding.ownerActionRef);
      assert.ok(ownerAction);
      assert.equal(ownerAction.runtimeAdmission, "NOT_ADMITTED");
      const ownerVerdicts = Object.fromEntries(ownerAction.guardRefs.map((guard) => [guard, "TRUE"]));
      const ownerActor = ownerAction.actorRefs[0];
      const ownerEligible = evaluatePdp3StepDefinition(binding, inputFor(binding, ownerActor, ownerVerdicts), oracleOptions);
      assert.equal(ownerEligible.disposition, "HOLD_UNKNOWN");
      assert.equal(ownerEligible.reason, "SOURCE_TYPED_GUARD_FACT_EVALUATOR_NOT_BOUND");
      assert.equal(ownerEligible.guardFixtureClassification, "FIXTURE_ALL_TRUE");
      assert.equal(ownerEligible.dispatch, "NONE");
      assert.equal(ownerEligible.effectApplied, false);
      assert.equal(ownerEligible.retryAuthorized, false);
      assert.deepEqual(ownerEligible.operationRefs, [ownerAction.operationRef]);
      const firstGuard = ownerAction.guardRefs[0];
      const fixtureFalse = evaluatePdp3StepDefinition(binding, inputFor(binding, ownerActor, { ...ownerVerdicts, [firstGuard]: "FALSE" }), oracleOptions);
      assert.equal(fixtureFalse.disposition, "HOLD_UNKNOWN");
      assert.equal(fixtureFalse.guardFixtureClassification, "FIXTURE_CONTAINS_FALSE");
      const ownerUnknown = evaluatePdp3StepDefinition(binding, inputFor(binding, ownerActor, { ...ownerVerdicts, [firstGuard]: "UNKNOWN" }), oracleOptions);
      assert.equal(ownerUnknown.disposition, "HOLD_UNKNOWN");
      assert.equal(ownerUnknown.guardFixtureClassification, "FIXTURE_CONTAINS_UNKNOWN");
      assert.equal(ownerUnknown.retryAuthorized, false);
      outcomes.add(ownerEligible.disposition);
      continue;
    }
    const actionRef = binding.action.actionRef;
    if (!actionRef) {
      const passive = evaluatePdp3StepDefinition(binding, inputFor(binding, "media.creator", {}), oracleOptions);
      assert.equal(passive.dispatch, "NONE", `${journey.journeyId}/${index + 1} cannot dispatch without a bound action`);
      assert.equal(passive.effectApplied, false);
      outcomes.add(passive.disposition);
      continue;
    }
    const action = actionById.get(actionRef);
    assert.ok(action, `${journey.journeyId}/${index + 1} references an existing action`);
    const typed = action.actionDefinitionSemantics.typedDefinition;
    const verdicts = Object.fromEntries(binding.action.guards.map((guard) => [guard, "TRUE"]));
    const actorRef = binding.action.actorRefs[0];
    const approved = evaluatePdp3StepDefinition(binding, inputFor(binding, actorRef, verdicts), oracleOptions);
    if (binding.action.semanticRole === "LOCAL_SELECTION_OR_SESSION_DRAFT") {
      assert.equal(approved.disposition, "HOLD_UNKNOWN", `${journey.journeyId}/${index + 1} cannot use asserted guard booleans as local-session evidence`);
      assert.equal(approved.effectApplied, false);
      assert.equal(approved.dispatch, "NONE");
      assert.equal(approved.retryAuthorized, false);
      assert.equal(approved.reason, "LOCAL_STEP_REQUIRES_TYPED_HOST_SESSION_CONTRACT; CALL_LOCAL_STEP_EFFECT_DEFINITION_ORACLE");
      continue;
    }
    const objectScopeUnresolved = ["CANONICAL_OBJECT_SCOPE_UNRESOLVED", "SOURCE_OBSERVATION_IDENTITIES_PRESERVED; CANONICAL_PRODUCT_OBJECT_EQUIVALENCE_NOT_ASSERTED", undefined].includes(binding.versionedObjectObservation?.status) && typed.exactOperationRefs.length > 0;
    if (binding.action.guards.length > 0) {
      assert.equal(approved.disposition, "HOLD_UNKNOWN", `${journey.journeyId}/${index + 1} fixture booleans are not guard evidence`);
      if (!objectScopeUnresolved) {
        assert.equal(approved.reason, "SOURCE_TYPED_GUARD_FACT_EVALUATOR_NOT_BOUND");
        assert.equal(approved.guardFixtureClassification, "FIXTURE_ALL_TRUE");
      }
      assert.equal(approved.dispatch, "NONE");
      assert.equal(approved.effectApplied, false);
      assert.equal(approved.retryAuthorized, false);
      continue;
    }
    if (objectScopeUnresolved) assert.equal(approved.disposition, "HOLD_UNKNOWN", `${journey.journeyId}/${index + 1} must hold until canonical object/version scope is resolved`);
    else assert.ok(["QUERY_DEFINITION_ONLY", "REQUEST_DEFINITION_ONLY", "LOCAL_EFFECT_DEFINITION_ONLY", "HANDOFF_DEFINITION_ONLY", "OWNER_DEFINITION_REQUIRES_REVIEW"].includes(approved.disposition), `${journey.journeyId}/${index + 1}: ${approved.reason ?? approved.disposition}`);
    assert.equal(approved.dispatch, "NONE", "a passing definition oracle never invokes the operation");
    assert.equal(approved.effectApplied, false);
    assert.equal(approved.retryAuthorized, false);
    assert.deepEqual(approved.operationRefs, typed.exactOperationRefs);
    assert.equal(approved.effect, typed.effect);
    if (!objectScopeUnresolved) assert.equal(approved.declaredFinality, typed.finality);
    assert.equal(approved.failureRecovery, typed.failureRecovery);
    assert.equal(approved.runtimeAdmission, "NOT_ADMITTED");
    outcomes.add(approved.disposition);

    const extraGuard = evaluatePdp3StepDefinition(binding, inputFor(binding, actorRef, { ...verdicts, "unlisted.guard": "TRUE" }), oracleOptions);
    assert.equal(extraGuard.disposition, "HOLD_UNKNOWN", `${journey.journeyId}/${index + 1} rejects forged guard evidence`);
  }
  assert.equal(outcomes.has("LOCAL_EFFECT_DEFINITION_ONLY"), false, "untrusted guard verdict inputs cannot approve local session edits");
  assert.ok(outcomes.has("CHOICE_PENDING"));
  assert.ok(outcomes.has("OBSERVATION_ONLY"));
});

test("all 130 projected steps retain exact action and step recovery source clauses", async () => {
  const actionDocument = parse(await readFile(`${base}/action-registry.yaml`, "utf8"));
  const actionById = new Map([...(actionDocument.actions ?? []), ...(actionDocument.ownerDefinedActions ?? [])].map((action) => [action.id, action]));
  const oracleDocumentRef = `${base}/step-definition-oracles.yaml`;
  const oracleBySourceRef = new Map();
  const oracleRecoveryRefByStepId = new Map();
  for (const [journeyIndex, oracleJourney] of (stepOracleSource.journeys ?? []).entries()) {
    for (const [stepIndex, oracleStep] of (oracleJourney.steps ?? []).entries()) {
      oracleBySourceRef.set(oracleStep.sourceRef, oracleStep);
      if (oracleStep.sessionRecoveryDefinition) {
        oracleRecoveryRefByStepId.set(oracleStep.id,
          `${oracleDocumentRef}#journeys/${journeyIndex}/steps/${stepIndex}/sessionRecoveryDefinition`);
      }
    }
  }
  const sourceDocuments = {
    [`${base}/action-registry.yaml`]: actionDocument,
    [oracleDocumentRef]: stepOracleSource,
    ...Object.fromEntries(journeys.map(({ filename, document }) => [`${base}/journey-contracts/${filename}`, document])),
  };
  let sourceBoundRecoveryCount = 0;
  for (const { filename, document } of journeys) {
    for (const [index, step] of document.steps.entries()) {
      const sourceRef = `${base}/journey-contracts/${filename}#/steps/${index}`;
      const oracle = oracleBySourceRef.get(sourceRef);
      assert.ok(oracle, `${sourceRef} has an exact step oracle`);
      const actionRef = oracle.canonicalBindings?.actionRef;
      if (actionRef) {
        const action = actionById.get(actionRef);
        assert.ok(action, `${sourceRef} action resolves`);
        const collection = actionDocument.actions?.some((row) => row.id === actionRef) ? "actions" : "ownerDefinedActions";
        const ref = `${base}/action-registry.yaml#${collection}/@id=${actionRef}/actionDefinitionSemantics/typedDefinition/failureRecovery`;
        assert.equal(resolvePdp3BindingSourceRef(ref, sourceDocuments), action.actionDefinitionSemantics?.typedDefinition?.failureRecovery,
          `${sourceRef} failure recovery points to its selected action`);
        sourceBoundRecoveryCount += 1;
      }
      const sessionRef = oracleRecoveryRefByStepId.get(oracle.id);
      const stepRecoveryRef = `${sourceRef}/recovery`;
      const recoveryRef = sessionRef ?? (step.recovery ? stepRecoveryRef : undefined);
      assert.ok(recoveryRef, `${sourceRef} has a declared recovery or typed session-recovery definition`);
      const recovered = resolvePdp3BindingSourceRef(recoveryRef, sourceDocuments);
      if (sessionRef) assert.deepEqual(recovered, oracle.sessionRecoveryDefinition, `${sourceRef} session recovery resolves exactly`);
      else assert.equal(recovered, step.recovery, `${sourceRef} recovery resolves exactly`);
    }
  }
  assert.equal(sourceBoundRecoveryCount, 121);
});

test("step source-binding coverage is not reported as guard-semantic completion", () => {
  const coverage = stepOracleSource.guardFactEvaluationCoverage;
  assert.equal(coverage.id, "media.pdp3.step-guard-fact-coverage.v1");
  assert.equal(coverage.stepCount, 130);
  assert.equal(coverage.sourceBindingsRecorded, 130);
  assert.equal(coverage.guardedDomainIdentityWorkflowSteps, 94);
  assert.equal(coverage.guardedDomainIdentityWorkflowFactEvaluators, 57);
  assert.equal(coverage.definitionFixturePredicateEvaluators, 57);
  assert.equal(coverage.evaluatedGuardInstances, 254);
  assert.equal(coverage.unresolvedGuardFactInstances, 0);
  assert.equal(coverage.unresolvedGuardFactSteps, 0);
  assert.equal(coverage.trustedRuntimeGuardEvaluators, 0);
  assert.equal(coverage.runtimeReceiptBindings, 0);
  assert.equal(coverage.fixtureOutcomeFieldsAreEvidence, false);
  assert.equal(coverage.status, "DEFINITION_PREDICATES_AVAILABLE; host attestation and runtime adapters not admitted");
  for (const journey of stepOracleSource.journeys) {
    for (const [index, binding] of journey.steps.entries()) {
      assert.equal(binding.coverageDisposition, "SOURCE_BINDING_RECORDED", `${journey.journeyId}/${index + 1}`);
    }
  }
});

test("J-05 capability alternatives follow source-analysis purpose, not create-image/create-video labels", () => {
  const journey = stepOracleSource.journeys.find((item) => item.journeyId === "J-05");
  const p0Journey = p0JourneyCatalog.journeys.find((item) => item.id === "J-05");
  assert.ok(journey && p0Journey);
  assert.deepEqual(p0Journey.outcomeRefs, ["media.goal.understand-media", "media.goal.review-trustworthy-output"]);
  assert.deepEqual(journey.steps.slice(0, 3).map((step) => step.capabilityOptions.length), [13, 7, 1]);
  for (const step of journey.steps.slice(0, 3)) {
    const result = validatePdp3StepCapabilityPurpose(step, capabilitiesById, p0Journey);
    assert.deepEqual(result, { valid: true, reason: "EXACT_SOURCE_ANALYSIS_ALTERNATIVES" }, step.id);
    assert.equal(step.stepIntent.toLowerCase().includes("generation"), false, step.id);
  }
  const imageStep = journey.steps[0];
  const generatedCapability = capabilitiesById.get("media.generate.image.text-to-image");
  assert.ok(generatedCapability, "the wrong-purpose control is itself a valid source capability");
  const wrongButValidCapability = structuredClone(imageStep);
  wrongButValidCapability.capabilityOptions[0] = {
    capabilityRef: generatedCapability.id,
    operationRefs: generatedCapability.ownerDefinition.operationRefs,
    operationKind: generatedCapability.ownerDefinition.operationKind,
    requirementRefs: ["MEDIA-REQ-CAP-GENERATE-IMAGE"],
    admission: "NOT_ADMITTED",
  };
  assert.deepEqual(validatePdp3StepCapabilityPurpose(wrongButValidCapability, capabilitiesById, p0Journey), {
    valid: false, reason: "CAPABILITY_OPTIONS_DO_NOT_MATCH_AUTHORED_PURPOSE_SET",
  });
  const falsifiedPurposeSet = structuredClone(wrongButValidCapability);
  falsifiedPurposeSet.purposeBinding.allowedCapabilityRefs[0] = generatedCapability.id;
  assert.deepEqual(validatePdp3StepCapabilityPurpose(falsifiedPurposeSet, capabilitiesById, p0Journey), {
    valid: false, reason: "CAPABILITY_SOURCE_DOES_NOT_MATCH_ANALYSIS_PURPOSE",
  });
  assert.equal(imageStep.inputCases.find((item) => item.expectedDecision === "REJECT_WRONG_PURPOSE")?.selectedCapabilityRef,
    "media.generate.image.text-to-image");
  assert.equal(journey.steps[3].capabilityOptions.length, 0, "comparison remains read-only and does not invent a generation branch");
});

test("step oracle enrichment preserves the distinction between source bindings and evaluated guards", async () => {
  const generator = await readFile("scripts/enrich-media-step-definition-bindings.py", "utf8");
  assert.match(generator, /SOURCE_BINDING_RECORDED/u);
  assert.doesNotMatch(generator, /SOURCE_BOUND_DEFINITION_COMPLETE/u);
  assert.match(generator, /guardFactEvaluationCoverage/u);
  assert.match(generator, /fixtureOutcomeFieldsAreEvidence':False/u);
});

test("step oracle rejects stale or forged source and target tuples and never treats unknown as retry permission", () => {
  const { step } = steps.find(({ step }) => step.stepDefinitionSemantics?.action?.actionRef === "media.action.create-project");
  const binding = step.stepDefinitionSemantics;
  const actor = binding.action.actorRefs[0];
  const verdicts = Object.fromEntries(binding.action.guards.map((guard) => [guard, "TRUE"]));
  const base = inputFor(binding, actor, verdicts);
  assert.equal(evaluatePdp3StepDefinition(binding, { ...base, sourceRef: `${binding.sourceRef}#stale` }, oracleOptions).disposition, "HOLD_UNKNOWN");
  assert.equal(evaluatePdp3StepDefinition(binding, { ...base, actorRef: "media.unknown-actor" }, oracleOptions).disposition, "HOLD_UNKNOWN");
  assert.equal(evaluatePdp3StepDefinition(binding, { ...base, targetRefs: ["media.domain.other"] }, oracleOptions).disposition, "HOLD_UNKNOWN");
  assert.equal(evaluatePdp3StepDefinition(binding, { ...base, fixtureGuardOutcomes: null }, oracleOptions).disposition, "HOLD_UNKNOWN");
  const unknownGuard = binding.action.guards[0];
  const result = evaluatePdp3StepDefinition(binding, { ...base, fixtureGuardOutcomes: { ...verdicts, [unknownGuard]: "UNKNOWN" } }, oracleOptions);
  assert.equal(result.disposition, "HOLD_UNKNOWN");
  assert.equal(result.retryAuthorized, false);
});
