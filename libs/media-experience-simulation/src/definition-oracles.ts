export type DefinitionGuardVerdict = "PASS" | "DENIED" | "UNKNOWN";
export type DefinitionOracleDecision =
  | "REQUEST_DEFINED_EFFECT_ONLY"
  | "APPLY_LOCAL_DEFINITION_EFFECT"
  | "READ_ONLY_DEFINITION_OBSERVATION"
  | "DENY_WITHOUT_EFFECT"
  | "HOLD_WITHOUT_EFFECT_OR_REPLAY"
  | "EXTERNAL_HANDOFF_NOT_EXECUTED"
  | "UNBOUND_OPERATION_NOT_EXECUTED"
  | "NON_EXECUTABLE_NO_ACTION_DISPATCH";

export interface DefinitionOracleAction {
  readonly actionRef: string | null;
  readonly semanticRole: string | null;
  readonly operationDisposition: string;
  readonly canonicalOperationRefs: readonly string[];
  readonly operationKinds: readonly ("QUERY" | "COMMAND" | "WORKFLOW" | "UNKNOWN")[];
  readonly guardRefs: readonly string[];
  readonly capabilityOptions?: readonly {
    readonly capabilityRef: string;
    readonly operationRefs: readonly string[];
    readonly operationKind: "QUERY" | "COMMAND" | "WORKFLOW" | "COMMAND_OR_COMPUTATION" | "MULTI_OPERATION";
  }[];
  readonly effect: string | null;
  readonly finality: string | null;
  readonly recovery: string | null;
  readonly runtimeAdmission: "NOT_ADMITTED";
}

export interface DefinitionOracleResult {
  readonly decision: DefinitionOracleDecision;
  readonly requestedEffect: string | null;
  readonly finality: string | null;
  readonly recovery: string | null;
  readonly unknownGuardRefs: readonly string[];
  readonly deniedGuardRefs: readonly string[];
  readonly runtimeAdmission: "NOT_ADMITTED";
  readonly completionClaim: "NONE";
}

export interface DefinitionActionChoiceSet {
  readonly status: string;
  readonly selectedActionRef: string | null;
  readonly defaultActionRef: string | null;
  readonly options: readonly { readonly actionRef: string; readonly runtimeAdmission: "NOT_ADMITTED" }[];
}

export type DefinitionActionChoiceDecision = "CHOICE_REQUIRED" | "ACTION_SELECTED_NOT_DISPATCHED" | "INVALID_ACTION_SELECTION";

/** Resolve only the user's explicit choice among source-listed actions. This never dispatches. */
export function evaluateDefinitionActionChoiceSet(
  source: DefinitionActionChoiceSet,
  selectedActionRef: string | null,
): { readonly decision: DefinitionActionChoiceDecision; readonly selectedActionRef: string | null; readonly runtimeAdmission: "NOT_ADMITTED"; readonly completionClaim: "NONE" } {
  const ids = source.options.map(({ actionRef }) => actionRef);
  const malformed = source.status !== "SOURCE_BOUND_ACTION_SET; USER_SELECTION_REQUIRED"
    || source.selectedActionRef !== null
    || source.defaultActionRef !== null
    || ids.length < 2
    || ids.some((id) => typeof id !== "string" || id.length === 0)
    || new Set(ids).size !== ids.length
    || source.options.some(({ runtimeAdmission }) => runtimeAdmission !== "NOT_ADMITTED");
  if (malformed || selectedActionRef === null || !ids.includes(selectedActionRef)) {
    return { decision: malformed || selectedActionRef !== null ? "INVALID_ACTION_SELECTION" : "CHOICE_REQUIRED", selectedActionRef: null, runtimeAdmission: "NOT_ADMITTED", completionClaim: "NONE" };
  }
  return { decision: "ACTION_SELECTED_NOT_DISPATCHED", selectedActionRef, runtimeAdmission: "NOT_ADMITTED", completionClaim: "NONE" };
}

/**
 * Evaluate only an explicit guard-verdict fixture against a source definition.
 * This interpreter never resolves free-text predicates, dispatches operations,
 * or claims that an external effect completed.
 */
export function evaluateDefinitionOracle(
  source: DefinitionOracleAction,
  guardVerdicts: Readonly<Record<string, DefinitionGuardVerdict>>,
  capabilitySelection?: { readonly capabilityRef: string; readonly operationRef: string },
): DefinitionOracleResult {
  const deniedGuardRefs = source.guardRefs.filter((ref) => guardVerdicts[ref] === "DENIED");
  const unknownGuardRefs = source.guardRefs.filter((ref) => guardVerdicts[ref] !== "PASS" && guardVerdicts[ref] !== "DENIED");
  const base = {
    finality: source.finality,
    recovery: source.recovery,
    unknownGuardRefs,
    deniedGuardRefs,
    runtimeAdmission: "NOT_ADMITTED" as const,
    completionClaim: "NONE" as const,
  };
  if (!source.actionRef) {
    return { ...base, decision: "NON_EXECUTABLE_NO_ACTION_DISPATCH", requestedEffect: null };
  }
  if (deniedGuardRefs.length > 0) {
    return { ...base, decision: "DENY_WITHOUT_EFFECT", requestedEffect: null };
  }
  if (unknownGuardRefs.length > 0) {
    return { ...base, decision: "HOLD_WITHOUT_EFFECT_OR_REPLAY", requestedEffect: null };
  }
  if (source.guardRefs.length === 0 && ["DOMAIN_OPERATION", "ORDERED_DOMAIN_WORKFLOW", "EXTERNAL_SHARED_IDENTITY_HANDOFF", "EXTERNAL_SHARED_IDENTITY_HANDOFF_OR_OBSERVATION"].includes(source.semanticRole ?? "")) {
    return { ...base, decision: "UNBOUND_OPERATION_NOT_EXECUTED", requestedEffect: null };
  }
  if (source.capabilityOptions?.length) {
    const option = source.capabilityOptions.find((entry) => entry.capabilityRef === capabilitySelection?.capabilityRef);
    if (!option || !capabilitySelection?.operationRef || !option.operationRefs.includes(capabilitySelection.operationRef)) {
      return { ...base, decision: "UNBOUND_OPERATION_NOT_EXECUTED", requestedEffect: null };
    }
    const actionIsReadOnly = source.semanticRole === "READ_ONLY_OBSERVATION_QUERY_BINDING_UNRESOLVED" ||
      source.semanticRole === "DOMAIN_OPERATION" && source.operationKinds.length > 0 && source.operationKinds.every((kind) => kind === "QUERY");
    if (actionIsReadOnly && option.operationKind !== "QUERY") {
      return { ...base, decision: "UNBOUND_OPERATION_NOT_EXECUTED", requestedEffect: null };
    }
    const actionIsCommand = source.semanticRole === "ORDERED_DOMAIN_WORKFLOW" ||
      source.semanticRole === "DOMAIN_OPERATION" && source.operationKinds.some((kind) => kind === "COMMAND" || kind === "WORKFLOW");
    if (actionIsCommand && option.operationKind === "QUERY") {
      return { ...base, decision: "UNBOUND_OPERATION_NOT_EXECUTED", requestedEffect: null };
    }
    if (option.operationKind === "MULTI_OPERATION" && option.operationRefs.length < 2) {
      return { ...base, decision: "UNBOUND_OPERATION_NOT_EXECUTED", requestedEffect: null };
    }
  }
  if (source.semanticRole === "LOCAL_SELECTION_OR_SESSION_DRAFT") {
    return { ...base, decision: "APPLY_LOCAL_DEFINITION_EFFECT", requestedEffect: source.effect };
  }
  if (source.semanticRole?.startsWith("EXTERNAL_SHARED_IDENTITY")) {
    return { ...base, decision: "EXTERNAL_HANDOFF_NOT_EXECUTED", requestedEffect: null };
  }
  if (source.semanticRole === "READ_ONLY_OBSERVATION_QUERY_BINDING_UNRESOLVED" ||
      source.semanticRole === "DOMAIN_OPERATION" && source.operationKinds.length === 1 && source.operationKinds[0] === "QUERY") {
    return { ...base, decision: "READ_ONLY_DEFINITION_OBSERVATION", requestedEffect: source.effect };
  }
  if (source.semanticRole === "DOMAIN_OPERATION" || source.semanticRole === "ORDERED_DOMAIN_WORKFLOW") {
    if (source.canonicalOperationRefs.length === 0 || source.operationKinds.length !== source.canonicalOperationRefs.length || source.operationKinds.some((kind) => kind === "UNKNOWN")) {
      return { ...base, decision: "UNBOUND_OPERATION_NOT_EXECUTED", requestedEffect: null };
    }
    if (source.operationKinds.every((kind) => kind === "QUERY")) {
      return { ...base, decision: "READ_ONLY_DEFINITION_OBSERVATION", requestedEffect: source.effect };
    }
    return { ...base, decision: "REQUEST_DEFINED_EFFECT_ONLY", requestedEffect: source.effect };
  }
  return { ...base, decision: "UNBOUND_OPERATION_NOT_EXECUTED", requestedEffect: null };
}
