/**
 * Pure PDP-1 transition definition oracle. It evaluates only the explicit typed
 * Media guard contracts. It has no runtime mutation, effect, or admission path.
 */

function recordsOf(transitions) {
  return [...(transitions.transitionRecords ?? []), ...(transitions.ownerDefinedTransitionRecords ?? [])];
}

function definitionsFor(states, machineId, dimension) {
  const machine = states.stateMachines?.find((entry) => entry.machineId === machineId);
  if (!machine) return [];
  if (machine.stateDefinitionsByDimension) return machine.stateDefinitionsByDimension[dimension] ?? [];
  return machine.stateDefinitions ?? [];
}

function evaluateExpression(expression, facts, contracts) {
  if (!expression || typeof expression !== "object" || Array.isArray(expression)) {
    return { value: "UNKNOWN", failures: ["GUARD_EXPRESSION_INVALID"] };
  }
  const keys = Object.keys(expression);
  if (keys.length !== 1) return { value: "UNKNOWN", failures: ["GUARD_EXPRESSION_INVALID"] };
  const [operator] = keys;
  const operand = expression[operator];
  if (operator === "fact") {
    if (typeof operand !== "string") return { value: "UNKNOWN", failures: ["GUARD_FACT_ID_INVALID"] };
    if (operand === "tenant.matches") {
      const request = facts.tenant?.requestTenantId;
      const subject = facts.tenant?.resourceTenantId;
      if (typeof request !== "string" || request.trim().length === 0 || typeof subject !== "string" || subject.trim().length === 0) {
        return { value: "UNKNOWN", failures: ["TENANT_CONTEXT_MISSING"] };
      }
      return request === subject
        ? { value: "TRUE", failures: [] }
        : { value: "FALSE", failures: ["TENANT_MISMATCH"] };
    }
    if (!Object.hasOwn(contracts.facts ?? {}, operand)) {
      return { value: "UNKNOWN", failures: [`UNKNOWN_GUARD_FACT:${operand}`] };
    }
    if (operand === "expectedVersionMatches" || operand === "expectedVersionConflicts") {
      const expected = facts.version?.expected;
      const current = facts.version?.current;
      if (typeof expected !== "string" || expected.trim().length === 0 || typeof current !== "string" || current.trim().length === 0) {
        return { value: "UNKNOWN", failures: ["VERSION_PRECONDITION_MISSING_OR_INVALID"] };
      }
      const matches = expected === current;
      const passed = operand === "expectedVersionMatches" ? matches : !matches;
      return passed
        ? { value: "TRUE", failures: [] }
        : { value: "FALSE", failures: [operand === "expectedVersionMatches" ? "VERSION_PRECONDITION_STALE" : "VERSION_CONFLICT_NOT_PRESENT"] };
    }
    if (operand === "consentPerEffectCurrent") {
      const consent = facts.consent;
      if (!consent || typeof consent.status !== "string" || !Array.isArray(contracts.facts?.consentPerEffectCurrent?.recognizedStatuses)
          || !contracts.facts.consentPerEffectCurrent.recognizedStatuses.includes(consent.status) || typeof consent.current !== "boolean") {
        return { value: "UNKNOWN", failures: ["CONSENT_STATUS_OR_CURRENTNESS_MISSING"] };
      }
      if (consent.status !== "ACTIVE" || consent.current !== true) return { value: "FALSE", failures: ["CONSENT_NOT_CURRENT_ACTIVE"] };
      if (typeof consent.tenantId !== "string" || consent.tenantId.trim().length === 0) return { value: "UNKNOWN", failures: ["CONSENT_TENANT_MISSING"] };
      if (consent.tenantId !== facts.tenant?.requestTenantId) {
        return { value: "FALSE", failures: ["CONSENT_TENANT_MISMATCH"] };
      }
      if (typeof facts.purpose !== "string" || facts.purpose.trim().length === 0 || !Array.isArray(consent.purposes)
          || consent.purposes.some((purpose) => typeof purpose !== "string" || purpose.trim().length === 0)) {
        return { value: "UNKNOWN", failures: ["CONSENT_PURPOSE_OR_SCOPE_MISSING"] };
      }
      if (!consent.purposes.includes(facts.purpose)) return { value: "FALSE", failures: ["CONSENT_PURPOSE_OUT_OF_SCOPE"] };
      return { value: "TRUE", failures: [] };
    }
    if (!Object.hasOwn(facts.guardFacts ?? {}, operand)) return { value: "UNKNOWN", failures: [`GUARD_FACT_MISSING:${operand}`] };
    const value = facts.guardFacts[operand];
    if (typeof value !== "boolean") return { value: "UNKNOWN", failures: [`GUARD_FACT_INVALID_TYPE:${operand}`] };
    return value
      ? { value: "TRUE", failures: [] }
      : { value: "FALSE", failures: [`GUARD_FACT_NOT_ESTABLISHED:${operand}`] };
  }
  if (operator === "all" || operator === "any") {
    if (!Array.isArray(operand) || operand.length === 0) return { value: "UNKNOWN", failures: ["GUARD_EXPRESSION_INVALID"] };
    const results = operand.map((child) => evaluateExpression(child, facts, contracts));
    const failures = results.flatMap((result) => result.failures);
    // Unknown is never hidden by a passing sibling; malformed/unknown contract
    // content invalidates the whole expression tree.
    if (results.some((result) => result.value === "UNKNOWN")) return { value: "UNKNOWN", failures };
    const passed = operator === "all" ? results.every((result) => result.value === "TRUE") : results.some((result) => result.value === "TRUE");
    if (passed) return { value: "TRUE", failures: [] };
    return { value: "FALSE", failures: operator === "all" ? failures : ["ANY_GUARD_ALTERNATIVE_UNSATISFIED", ...failures] };
  }
  if (operator === "not") {
    const result = evaluateExpression(operand, facts, contracts);
    if (result.value === "UNKNOWN") return result;
    return result.value === "TRUE"
      ? { value: "FALSE", failures: ["NEGATED_GUARD_FACT_ESTABLISHED"] }
      : { value: "TRUE", failures: [] };
  }
  return { value: "UNKNOWN", failures: [`UNKNOWN_GUARD_OPERATOR:${operator}`] };
}

/** List concrete predicate IDs used by an exact edge contract. */
export function transitionGuardFactRequirements(contract) {
  const ids = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.fact) ids.add(node.fact);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  for (const edge of contract?.edgeRules ?? []) visit(edge.when);
  return [...ids];
}

/** Return an explanation-only result for one explicitly defined transition edge. */
export function evaluatePdpTransition({ transitions, states, guardContracts, transitionId, from, to, facts = {} }) {
  const record = recordsOf(transitions).find(({ id }) => id === transitionId);
  if (!record) return { allowed: false, reasonCodes: ["UNKNOWN_TRANSITION_ID"] };
  const contract = guardContracts?.records?.find(({ transitionId: id }) => id === transitionId);
  if (!contract) return { allowed: false, reasonCodes: ["GUARD_CONTRACT_MISSING"], transitionId };
  if (contract.sourceMachineId !== record.sourceMachineId || contract.stateDimension !== (record.stateDimension ?? null)) {
    return { allowed: false, reasonCodes: ["GUARD_CONTRACT_MACHINE_MISMATCH"], transitionId };
  }
  const sourceGuard = record.ownerGuardDefinition ?? record.sourceGuard;
  if (contract.sourceGuard !== sourceGuard) return { allowed: false, reasonCodes: ["GUARD_CONTRACT_SOURCE_STALE"], transitionId };
  const edge = contract.edgeRules?.find((candidate) => candidate.from === from && candidate.to === to);
  if (!edge) return { allowed: false, reasonCodes: ["EDGE_NOT_EXPLICITLY_DEFINED"], transitionId, from, to };
  if (!record.from.includes(from) || !record.to.includes(to)) {
    return { allowed: false, reasonCodes: ["EDGE_NOT_DECLARED"], transitionId, from, to };
  }
  const stateIds = new Set(definitionsFor(states, record.sourceMachineId, record.stateDimension ?? null).map(({ id }) => id));
  if (!stateIds.has(from) || !stateIds.has(to)) {
    return { allowed: false, reasonCodes: ["STATE_OUTSIDE_MACHINE_DIMENSION"], transitionId, from, to };
  }
  const seenGroups = new Set();
  for (const group of guardContracts.exclusiveFactGroups ?? []) {
    if (!group || typeof group.id !== "string" || seenGroups.has(group.id) || !Array.isArray(group.factIds) || group.factIds.length < 2
        || group.factIds.some((id) => !Object.hasOwn(guardContracts.facts ?? {}, id))) {
      return { allowed: false, reasonCodes: ["EXCLUSIVE_FACT_GROUP_INVALID"], transitionId, from, to };
    }
    seenGroups.add(group.id);
    if (group.rule !== "at-most-one-positive-outcome-fact") {
      return { allowed: false, reasonCodes: ["EXCLUSIVE_FACT_GROUP_RULE_UNKNOWN"], transitionId, from, to };
    }
    const positive = group.factIds.filter((id) => facts.guardFacts?.[id] === true);
    if (positive.length > 1) {
      return { allowed: false, reasonCodes: [`CONTRADICTORY_OUTCOME_FACTS:${group.id}`], transitionId, from, to };
    }
  }
  const result = evaluateExpression(edge.when, facts, guardContracts);
  return { allowed: result.value === "TRUE", reasonCodes: result.failures, transitionId, from, to, sourceGuard };
}
