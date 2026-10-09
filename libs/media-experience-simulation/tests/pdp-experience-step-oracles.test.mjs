import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { evaluateDefinitionActionChoiceSet, evaluateDefinitionOracle } from "../dist/index.js";

const repoRoot = resolve(new URL("../../../", import.meta.url).pathname);
const toolsRequire = createRequire(new URL("../../../../ghatana-tools/package.json", import.meta.url));
const { parse } = toolsRequire("yaml");
const oracles = parse(await readFile(resolve(repoRoot, ".product-experience/pdp-3-product-experience/step-definition-oracles.yaml"), "utf8"));
const registry = parse(await readFile(resolve(repoRoot, ".product-experience/pdp-3-product-experience/action-registry.yaml"), "utf8"));
const actions = new Map([...registry.actions, ...(registry.ownerDefinedActions ?? [])].map((action) => [action.id, action]));
const journeyFiles = (await readdir(resolve(repoRoot, ".product-experience/pdp-3-product-experience/journey-contracts"))).filter((name) => name.endsWith(".yaml"));

test("explicit PDP-3 action choice sets require a real selection and never dispatch by default", async () => {
  const choices = [];
  for (const filename of journeyFiles) {
    const journey = parse(await readFile(resolve(repoRoot, `.product-experience/pdp-3-product-experience/journey-contracts/${filename}`), "utf8"));
    for (const [index, step] of journey.steps.entries()) {
      const set = step.stepDefinitionSemantics?.choiceSet;
      if (set) choices.push({ filename, index, step, set });
    }
  }
  assert.equal(choices.length, 5);
  for (const { step, set } of choices) {
    assert.equal(set.selectedActionRef, null);
    assert.equal(set.defaultActionRef, null);
    const unresolved = evaluateDefinitionActionChoiceSet(set, null);
    assert.equal(unresolved.decision, "CHOICE_REQUIRED");
    assert.equal(unresolved.runtimeAdmission, "NOT_ADMITTED");
    assert.equal(unresolved.completionClaim, "NONE");
    for (const option of set.options) {
      assert.ok(actions.has(option.actionRef), `${option.actionRef} is an exact source action`);
      const selected = evaluateDefinitionActionChoiceSet(set, option.actionRef);
      assert.equal(selected.decision, "ACTION_SELECTED_NOT_DISPATCHED");
      assert.equal(selected.selectedActionRef, option.actionRef);
    }
    assert.equal(evaluateDefinitionActionChoiceSet(set, "media.action.not-in-screen").decision, "INVALID_ACTION_SELECTION");
    const forged = { ...set, defaultActionRef: set.options[0].actionRef };
    assert.equal(evaluateDefinitionActionChoiceSet(forged, null).decision, "INVALID_ACTION_SELECTION");
    assert.equal(step.actionRef, null);
  }
});

test("J-04 first speech view has an executable choice oracle without a synthetic provider result", async () => {
  const journey = parse(await readFile(resolve(repoRoot, ".product-experience/pdp-3-product-experience/journey-contracts/authorized-text-to-speech-to-approved-audio.yaml"), "utf8"));
  const step = journey.steps[0];
  const oracle = step.stepDefinitionSemantics.fixtureOracle;
  const choices = step.stepDefinitionSemantics.choiceSet;
  assert.equal(oracle.status, "DEFINITION_CHOICE_ORACLE_BOUND; SYNTHETIC_FIXTURE_NOT_BOUND");
  assert.equal(oracle.executable, true);
  assert.deepEqual(oracle.scenarioRefs, []);
  assert.equal(oracle.executionBoundary.includes("no action dispatch"), true);
  assert.deepEqual(oracle.cases.map(({ selectedActionRef }) => selectedActionRef), [
    null, ...choices.options.map(({ actionRef }) => actionRef), "media.action.not-in-source-choice-set",
  ]);
  for (const entry of oracle.cases) {
    const result = evaluateDefinitionActionChoiceSet(choices, entry.selectedActionRef);
    assert.equal(result.decision, entry.expectedDecision);
    assert.equal(result.runtimeAdmission, "NOT_ADMITTED");
    assert.equal(result.completionClaim, "NONE");
    if (entry.selectedActionRef === null || entry.expectedDecision === "INVALID_ACTION_SELECTION") {
      assert.equal(entry.effect, "none");
    }
  }
});

test("J-29 reconnect request uses exact stream operation guards and remains definition-only", async () => {
  const ownerActions = registry.ownerDefinedActions ?? [];
  const action = ownerActions.find(({ id }) => id === "media.action.request-live-session-reconnect");
  assert.ok(action, "the reconnect request is a separate owner-defined action, not a fabricated baseline button");
  assert.equal(action.operationRef, "media.operation.capability.media-stream-session-reconnect");
  assert.deepEqual(action.capabilityRefs, ["media.stream.session.reconnect"]);
  assert.deepEqual(action.requirementRefs, ["MEDIA-REQ-CAP-STREAM"]);
  assert.deepEqual(action.domainObjectRefs, ["media.domain.stream-session"]);
  assert.ok(action.guardRefs.length >= 7);
  assert.equal(action.runtimeAdmission, "NOT_ADMITTED");
  const input = {
    actionRef: action.id,
    semanticRole: "DOMAIN_OPERATION",
    operationDisposition: "OWNER_DEFINED_EXACT_OPERATION_REFERENCE",
    canonicalOperationRefs: [action.operationRef],
    operationKinds: ["COMMAND"],
    guardRefs: action.guardRefs,
    effect: action.effect,
    finality: action.finality,
    recovery: action.failure,
    runtimeAdmission: "NOT_ADMITTED",
  };
  const pass = Object.fromEntries(action.guardRefs.map((ref) => [ref, "PASS"]));
  const denied = { ...pass, [action.guardRefs[2]]: "DENIED" };
  const unknown = { ...pass, [action.guardRefs[4]]: "UNKNOWN" };
  for (const [verdicts, expected] of [[pass, "REQUEST_DEFINED_EFFECT_ONLY"], [denied, "DENY_WITHOUT_EFFECT"], [unknown, "HOLD_WITHOUT_EFFECT_OR_REPLAY"]]) {
    const result = evaluateDefinitionOracle(input, verdicts);
    assert.equal(result.decision, expected);
    assert.equal(result.runtimeAdmission, "NOT_ADMITTED");
    assert.equal(result.completionClaim, "NONE");
  }
});

test("all 30 journeys and 130 steps have explicit definition-only positive, denied, unknown, or no-action cases", () => {
  assert.equal(oracles.journeyCount, 30);
  assert.equal(oracles.stepCount, 130);
  assert.equal(oracles.journeys.length, 30);
  const steps = oracles.journeys.flatMap((journey) => journey.steps);
  assert.equal(steps.length, 130);
  const bindingIds = steps.map((step) => step.canonicalBindings?.bindingId);
  assert.equal(new Set(bindingIds).size, 130);
  assert.ok(bindingIds.every((id) => typeof id === "string" && id.startsWith("media.step-definition-binding.")));
  for (const step of steps) {
    assert.ok(step.sourceRef && step.viewRef, `${step.id} must retain its exact source step and view`);
    assert.equal(step.runtimeAdmission, "NOT_ADMITTED");
    assert.match(step.oracleBoundary, /does not execute transport\/provider behavior/u);
    if (!step.actionRef) {
      assert.equal(step.expectedSemantics.positive.effect, "none");
      assert.equal(step.inputCases.length, 1);
      assert.equal(step.inputCases[0].expectedDecision, "NON_EXECUTABLE_NO_ACTION_DISPATCH");
      continue;
    }
    const action = actions.get(step.actionRef);
    assert.ok(action, `${step.id} must reference an exact source action`);
    const actionDefinition = action.actionDefinitionSemantics?.typedDefinition;
    const exactActionGuards = Array.isArray(action.guardRefs) ? action.guardRefs : action.preconditions;
    const exactActionRecovery = action.failureRecovery ?? action.failure;
    const exactOperationRefs = action.operationRef ? [action.operationRef] : actionDefinition?.exactOperationRefs ?? [];
    assert.deepEqual(step.guardRefs, exactActionGuards);
    assert.equal(step.effect, action.effect);
    assert.equal(step.finality, action.finality);
    assert.equal(step.recovery, exactActionRecovery);
    assert.deepEqual(step.canonicalOperationRefs, exactOperationRefs);
    const positiveCases = step.inputCases.slice(0, -2);
    assert.equal(positiveCases.length, step.capabilityOptions.length || 1);
    assert.deepEqual(step.inputCases.slice(-2).map((entry) => entry.expectedDecision), [
      "DENY_WITHOUT_EFFECT", "HOLD_WITHOUT_EFFECT_OR_REPLAY",
    ]);
    const guardMap = (verdict) => Object.fromEntries(step.guardRefs.map((ref) => [ref, verdict]));
    const positiveDecision = step.semanticRole === "LOCAL_SELECTION_OR_SESSION_DRAFT" ? "APPLY_LOCAL_DEFINITION_EFFECT" :
      step.semanticRole === "EXTERNAL_SHARED_IDENTITY_HANDOFF" || step.semanticRole === "EXTERNAL_SHARED_IDENTITY_HANDOFF_OR_OBSERVATION" ? "EXTERNAL_HANDOFF_NOT_EXECUTED" :
      step.semanticRole === "READ_ONLY_OBSERVATION_QUERY_BINDING_UNRESOLVED" || step.semanticRole === "DOMAIN_OPERATION" && step.operationKinds.length === 1 && step.operationKinds[0] === "QUERY" ? "READ_ONLY_DEFINITION_OBSERVATION" :
      ["DOMAIN_OPERATION", "ORDERED_DOMAIN_WORKFLOW"].includes(step.semanticRole) && step.canonicalOperationRefs.length && step.operationKinds.length === step.canonicalOperationRefs.length && !step.operationKinds.includes("UNKNOWN") ? step.operationKinds.every((kind) => kind === "QUERY") ? "READ_ONLY_DEFINITION_OBSERVATION" : "REQUEST_DEFINED_EFFECT_ONLY" : "UNBOUND_OPERATION_NOT_EXECUTED";
    for (const input of positiveCases) {
      const selection = input.selectedCapabilityRef ? { capabilityRef: input.selectedCapabilityRef, operationRef: input.selectedOperationRef } : undefined;
      const positive = evaluateDefinitionOracle(step, guardMap("PASS"), selection);
      assert.equal(positive.decision, input.expectedDecision);
      assert.equal(positive.runtimeAdmission, "NOT_ADMITTED");
      assert.equal(positive.completionClaim, "NONE");
    }
    if (step.capabilityOptions.length) {
      assert.equal(evaluateDefinitionOracle(step, guardMap("PASS")).decision, "UNBOUND_OPERATION_NOT_EXECUTED", `${step.id} must reject capability defaults`);
      assert.equal(evaluateDefinitionOracle(step, guardMap("PASS"), { capabilityRef: step.capabilityOptions[0].capabilityRef, operationRef: "media.operation.not-selected" }).decision, "UNBOUND_OPERATION_NOT_EXECUTED");
      const readOnlyAction = step.semanticRole === "READ_ONLY_OBSERVATION_QUERY_BINDING_UNRESOLVED" ||
        step.semanticRole === "DOMAIN_OPERATION" && step.operationKinds.length > 0 && step.operationKinds.every((kind) => kind === "QUERY");
      if (readOnlyAction) {
        const incompatible = { ...step, capabilityOptions: [{ capabilityRef: "media.test.incompatible", operationRefs: ["media.operation.test.command"], operationKind: "COMMAND" }] };
        assert.equal(evaluateDefinitionOracle(incompatible, guardMap("PASS"), { capabilityRef: "media.test.incompatible", operationRef: "media.operation.test.command" }).decision, "UNBOUND_OPERATION_NOT_EXECUTED", `${step.id} must reject command/computation options under a read-only action`);
      }
    } else assert.equal(positiveCases[0].expectedDecision, positiveDecision);
    const denied = evaluateDefinitionOracle(step, guardMap("DENIED"));
    assert.equal(denied.decision, "DENY_WITHOUT_EFFECT");
    assert.equal(denied.requestedEffect, null);
    const unknown = evaluateDefinitionOracle(step, guardMap("UNKNOWN"));
    assert.equal(unknown.decision, "HOLD_WITHOUT_EFFECT_OR_REPLAY");
    assert.equal(unknown.requestedEffect, null);
    assert.equal(unknown.completionClaim, "NONE");
  }
});
