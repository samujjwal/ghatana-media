const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
  Reflect.ownKeys(value).every((key) => typeof key === "string" &&
    Object.getOwnPropertyDescriptor(value, key)?.enumerable &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value"));

const exactKeys = (value, keys) => isRecord(value) && Reflect.ownKeys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;
const REF = /^[A-Za-z0-9][A-Za-z0-9._:/#=@-]{0,511}$/u;

const unknown = (reason) => ({
  disposition: "HOLD_UNKNOWN",
  dispatch: "NONE",
  effectApplied: false,
  finality: "NOT_ESTABLISHED",
  retryAuthorized: false,
  reason,
  runtimeAdmission: "NOT_ADMITTED",
});

/**
 * Validate a step binding and classify supplied guard verdicts as test-fixture
 * data only. Boolean verdicts are not evidence: this function never treats
 * them as guard evaluation, authorization, denial, or permission to proceed.
 * A guarded command remains HOLD_UNKNOWN until its exact typed fact contract
 * and source-backed evaluator are supplied.
 */
export function evaluatePdp3StepDefinition(binding, input, { operationKinds = {}, ownerActionsById = new Map() } = {}) {
  if (!isRecord(binding) || !isRecord(binding.action) || !exactKeys(input, [
    "sourceRef", "actorRef", "targetRefs", "fixtureGuardOutcomes", "selectedActionRef",
  ])) return unknown("MALFORMED_OR_NONCLOSED_STEP_INPUT");
  if (typeof binding.sourceRef !== "string" || input.sourceRef !== binding.sourceRef ||
      !Array.isArray(input.targetRefs) || input.targetRefs.some((ref) => typeof ref !== "string" || !REF.test(ref)) ||
      new Set(input.targetRefs).size !== input.targetRefs.length) return unknown("STEP_SOURCE_OR_TARGET_IDENTITY_MISMATCH");
  const expectedTargets = binding.canonicalBindings?.objectRefs;
  if (!Array.isArray(expectedTargets) || JSON.stringify(input.targetRefs) !== JSON.stringify(expectedTargets)) {
    return unknown("STEP_TARGET_OBJECT_SCOPE_MISMATCH");
  }

  const choice = binding.action.choiceSet ?? binding.choiceSet;
  if (choice) {
    if (choice.status !== "SOURCE_BOUND_ACTION_SET; USER_SELECTION_REQUIRED" ||
        choice.selectedActionRef !== null || choice.defaultActionRef !== null ||
        !Array.isArray(choice.options) || choice.options.length < 2) return unknown("CHOICE_DEFINITION_INVALID");
    if (input.selectedActionRef === null || input.selectedActionRef === undefined) {
      return { ...unknown("EXPLICIT_USER_ACTION_SELECTION_REQUIRED"), disposition: "CHOICE_PENDING" };
    }
    const selected = choice.options.find(({ actionRef }) => actionRef === input.selectedActionRef);
    if (!selected || selected.selection !== "EXPLICIT_USER_SELECTION_REQUIRED" || selected.runtimeAdmission !== "NOT_ADMITTED") {
      return unknown("UNLISTED_OR_UNADMITTED_CHOICE");
    }
    return { ...unknown("SELECTED_CHOICE_REQUIRES_ITS_EXACT_ACTION_CONTRACT"), disposition: "CHOICE_SELECTED_PENDING_ACTION_GUARDS", selectedActionRef: selected.actionRef };
  }

  if (input.selectedActionRef !== null && input.selectedActionRef !== undefined) return unknown("UNEXPECTED_ACTION_SELECTION");
  const actionRef = binding.ownerActionRef ?? binding.action.actionRef;
  if (actionRef === null || actionRef === undefined) {
    if (binding.action.bindingStatus === "PASSIVE_CANONICAL_QUERY_NO_ACTION_DISPATCH") {
      const op = binding.operationContractBinding;
      if (op?.operationKind !== "QUERY" || op.runtimeAdmission !== "NOT_ADMITTED" || !nonEmpty(op.operationRef)) return unknown("PASSIVE_QUERY_BINDING_INVALID");
      return { disposition: "OBSERVATION_ONLY", dispatch: "NONE", effectApplied: false, finality: "READ_ONLY_NO_WRITE_FINALITY", retryAuthorized: false, operationRefs: [op.operationRef], runtimeAdmission: "NOT_ADMITTED" };
    }
    if (binding.stepInteractionSemantics?.status === "SOURCE_DEFINED_MEDIA_OWNER_RECOVERY_RULE; REVIEW_AND_RUNTIME_OPEN") {
      const guards = binding.stepInteractionSemantics.inputs;
      if (!Array.isArray(guards) || guards.length === 0) return unknown("NO_DISPATCH_STEP_GUARDS_ABSENT");
      return { disposition: "NO_DISPATCH_RECOVERY_OBSERVATION", dispatch: "NONE", effectApplied: false, finality: "UNKNOWN_UNTIL_RECONCILED", retryAuthorized: false, guardRefs: [...guards], runtimeAdmission: "NOT_ADMITTED" };
    }
    return unknown("ACTION_BINDING_UNRESOLVED");
  }

  if (binding.ownerActionRef) {
    const ownerAction = ownerActionsById instanceof Map
      ? ownerActionsById.get(binding.ownerActionRef)
      : ownerActionsById?.[binding.ownerActionRef];
    if (!ownerAction || ownerAction.id !== binding.ownerActionRef || ownerAction.sourceRef !== binding.sourceRef ||
        ownerAction.runtimeAdmission !== "NOT_ADMITTED" || ownerAction.operationKind !== "COMMAND" ||
        binding.operationContractBinding?.operationRef !== ownerAction.operationRef ||
        !Array.isArray(ownerAction.guardRefs) || !Array.isArray(ownerAction.domainObjectRefs) ||
        !nonEmpty(ownerAction.effect) || !nonEmpty(ownerAction.finality) || !nonEmpty(ownerAction.failureRecovery)) {
      return unknown("OWNER_ACTION_CONTRACT_MISMATCH");
    }
    if (!ownerAction.actorRefs.includes(input.actorRef) ||
        JSON.stringify(input.targetRefs) !== JSON.stringify(binding.canonicalBindings.objectRefs) ||
        JSON.stringify(ownerAction.domainObjectRefs) !== JSON.stringify(binding.canonicalBindings.objectRefs)) return unknown("OWNER_ACTION_ACTOR_OR_OBJECT_SCOPE_MISMATCH");
    const fixture = classifyGuardFixture(ownerAction.guardRefs, input.fixtureGuardOutcomes);
    if (!fixture.valid) return unknown("OWNER_ACTION_GUARD_FIXTURE_INVALID");
    return {
      ...unknown("SOURCE_TYPED_GUARD_FACT_EVALUATOR_NOT_BOUND"),
      guardFixtureClassification: fixture.classification,
      guardRefs: ownerAction.guardRefs,
      actionRef: ownerAction.id,
      operationRefs: [ownerAction.operationRef],
      effect: ownerAction.effect,
      declaredFinality: ownerAction.finality,
      failureRecovery: ownerAction.failureRecovery,
    };
  }

  const definition = binding.action;
  const role = definition.semanticRole;
  if (role === "LOCAL_SELECTION_OR_SESSION_DRAFT") {
    return unknown("LOCAL_STEP_REQUIRES_TYPED_HOST_SESSION_CONTRACT; CALL_LOCAL_STEP_EFFECT_DEFINITION_ORACLE");
  }
  if (!nonEmpty(actionRef) || definition.actionRef && definition.actionRef !== actionRef ||
      !Array.isArray(definition.actorRefs) || !definition.actorRefs.includes(input.actorRef) ||
      !Array.isArray(definition.guards) || !Array.isArray(definition.exactOperationRefs) ||
      !nonEmpty(definition.effect) || !nonEmpty(definition.finality) || !nonEmpty(definition.failureRecovery) ||
      definition.runtimeAdmission !== "NOT_ADMITTED") return unknown("ACTION_SOURCE_CONTRACT_INCOMPLETE_OR_ACTOR_MISMATCH");

  const expectedOperationRefs = definition.exactOperationRefs;
  if (expectedOperationRefs.some((ref) => typeof ref !== "string" || !REF.test(ref)) ||
      new Set(expectedOperationRefs).size !== expectedOperationRefs.length) return unknown("ACTION_OPERATION_IDENTITY_INVALID");
  const actualOperationRef = binding.canonicalBindings?.canonicalOperationRef ?? binding.operationContractBinding?.operationRef ?? null;
  if (expectedOperationRefs.length === 1 && actualOperationRef !== expectedOperationRefs[0]) return unknown("STEP_ACTION_OPERATION_MISMATCH");
  if (expectedOperationRefs.length > 1 && binding.operationContractBinding?.operationRefs &&
      JSON.stringify(binding.operationContractBinding.operationRefs) !== JSON.stringify(expectedOperationRefs)) return unknown("ORDERED_WORKFLOW_OPERATION_MISMATCH");

  const guards = definition.guards;
  const fixture = classifyGuardFixture(guards, input.fixtureGuardOutcomes);
  if (!fixture.valid) return unknown("GUARD_FIXTURE_SET_INVALID");

  if ((role === "DOMAIN_OPERATION" || role === "ORDERED_DOMAIN_WORKFLOW") && expectedOperationRefs.length > 0 &&
      (!binding.versionedObjectObservation?.status ||
       binding.versionedObjectObservation.status === "CANONICAL_OBJECT_SCOPE_UNRESOLVED" ||
       binding.versionedObjectObservation.status === "SOURCE_OBSERVATION_IDENTITIES_PRESERVED; CANONICAL_PRODUCT_OBJECT_EQUIVALENCE_NOT_ASSERTED")) {
    return { ...unknown("CANONICAL_OBJECT_OR_VERSION_SCOPE_UNRESOLVED"), actionRef, operationRefs: expectedOperationRefs, effect: definition.effect, failureRecovery: definition.failureRecovery };
  }

  const kinds = expectedOperationRefs.map((ref) => operationKinds[ref]);
  if (expectedOperationRefs.length > 0 && kinds.some((kind) => !["QUERY", "COMMAND"].includes(kind))) return unknown("CANONICAL_OPERATION_KIND_UNRESOLVED");
  const disposition = role === "DOMAIN_OPERATION" || role === "ORDERED_DOMAIN_WORKFLOW"
    ? kinds.every((kind) => kind === "QUERY") ? "QUERY_DEFINITION_ONLY" : "REQUEST_DEFINITION_ONLY"
    : role === "LOCAL_SELECTION_OR_SESSION_DRAFT"
      ? "LOCAL_EFFECT_DEFINITION_ONLY"
      : role === "EXTERNAL_SHARED_IDENTITY_HANDOFF_OR_OBSERVATION" || role === "EXTERNAL_SHARED_IDENTITY_HANDOFF"
        ? "HANDOFF_DEFINITION_ONLY"
        : "OWNER_DEFINITION_REQUIRES_REVIEW";
  if (guards.length > 0) return {
    ...unknown("SOURCE_TYPED_GUARD_FACT_EVALUATOR_NOT_BOUND"),
    guardFixtureClassification: fixture.classification,
    actionRef,
    operationRefs: expectedOperationRefs,
    effect: definition.effect,
    declaredFinality: definition.finality,
    failureRecovery: definition.failureRecovery,
    guardRefs: guards,
  };
  return {
    disposition,
    dispatch: "NONE",
    effectApplied: false,
    finality: "NOT_ESTABLISHED",
    retryAuthorized: false,
    actionRef,
    operationRefs: expectedOperationRefs,
    effect: definition.effect,
    declaredFinality: definition.finality,
    failureRecovery: definition.failureRecovery,
    guardRefs: guards,
    runtimeAdmission: "NOT_ADMITTED",
  };
}

function classifyGuardFixture(guardRefs, verdicts) {
  if (!Array.isArray(guardRefs) || guardRefs.some((guard) => !nonEmpty(guard)) ||
      !exactKeys(verdicts, guardRefs) || guardRefs.some((guard) => !["TRUE", "FALSE", "UNKNOWN"].includes(verdicts[guard]))) {
    return { valid: false, classification: "INVALID_FIXTURE" };
  }
  if (guardRefs.some((guard) => verdicts[guard] === "UNKNOWN")) return { valid: true, classification: "FIXTURE_CONTAINS_UNKNOWN" };
  if (guardRefs.some((guard) => verdicts[guard] === "FALSE")) return { valid: true, classification: "FIXTURE_CONTAINS_FALSE" };
  return { valid: true, classification: "FIXTURE_ALL_TRUE" };
}
