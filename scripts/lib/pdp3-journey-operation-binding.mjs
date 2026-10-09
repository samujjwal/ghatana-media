const plainRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function resolveFragment(document, fragment) {
  if (fragment === "" || fragment === "/") return document;
  const segments = fragment.includes("/")
    ? (fragment.startsWith("/") ? fragment.slice(1) : fragment).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    : fragment.split(".");
  let value = document;
  for (const segment of segments) {
    if (value === null || value === undefined) return undefined;
    const selector = segment.match(/^@(id|point|key|type)=([^/]+)$/u);
    if (selector) {
      if (!Array.isArray(value)) return undefined;
      value = value.find((row) => row?.[selector[1]] === selector[2]);
    } else if (Array.isArray(value)) {
      const index = Number(segment);
      value = Number.isInteger(index) ? value[index] : value.find((row) =>
        row?.id === segment || row?.machineId === segment || row?.stateId === segment || row?.point === segment);
    } else if (!Object.hasOwn(value, segment) && segment.includes(".")) {
      for (const part of segment.split(".")) value = value?.[part];
    } else {
      value = value[segment];
    }
  }
  return value;
}

export function resolvePdp3BindingSourceRef(reference, sourceDocuments) {
  if (typeof reference !== "string" || !reference.includes("#") || !plainRecord(sourceDocuments)) return undefined;
  const hash = reference.indexOf("#");
  const path = reference.slice(0, hash);
  const fragment = reference.slice(hash + 1);
  if (/^(?:capabilityOperationContracts|ownerDefinedOperationContracts|individualOperationContracts)\.records\./u.test(fragment)) return undefined;
  const document = sourceDocuments[path];
  return document === undefined ? undefined : resolveFragment(document, fragment);
}

function hasUniqueStrings(values) {
  return Array.isArray(values) && values.every((value) => typeof value === "string" && value.length > 0) &&
    new Set(values).size === values.length;
}

/**
 * Validate a current journey-step projection against its exact PDP-1 owner join.
 * The result is a definition-only classification and never evaluates real guards,
 * dispatches an operation, claims terminal state, or grants replay permission.
 */
export function evaluatePdp3JourneyOperationBinding(step, ownerBinding, sourceDocuments) {
  const hold = (reason) => ({ disposition: "HOLD_UNKNOWN", dispatch: "NONE", effectApplied: false, finality: "NOT_ESTABLISHED", retryAuthorized: false, reason, runtimeAdmission: "NOT_ADMITTED" });
  if (!plainRecord(step) || !plainRecord(step.canonicalBindings) || !plainRecord(ownerBinding) || !plainRecord(sourceDocuments)) {
    return hold("STEP_OWNER_BINDING_INPUT_NOT_CLOSED");
  }
  const binding = step.canonicalBindings;
  const journeyStepRef = ownerBinding.journeyStepRef?.replace("#steps/", "#/steps/");
  if (step.sourceRef !== journeyStepRef || step.actionRef !== ownerBinding.actionRef ||
      binding.pdp1JourneyOperationBindingId !== ownerBinding.id ||
      binding.pdp1JourneyOperationBindingRef !== `.product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedJourneyOperationBindings/records/@id=${ownerBinding.id}`) {
    return hold("STEP_OWNER_BINDING_IDENTITY_MISMATCH");
  }
  if (ownerBinding.scopeStatus !== "OWNER_DEFINED_DEFINITION_ONLY; runtime-admission NOT_ADMITTED; qualification NOT_EVALUATED; independent PDP acceptance pending" ||
      binding.runtimeAdmission !== "NOT_ADMITTED") return hold("OWNER_BINDING_SCOPE_OR_ADMISSION_INVALID");

  const operationRefs = ownerBinding.operationRefs ?? (ownerBinding.operationRef ? [ownerBinding.operationRef] : []);
  const definitionRefs = ownerBinding.operationDefinitionRefs ?? (ownerBinding.operationDefinitionRef ? [ownerBinding.operationDefinitionRef] : []);
  if (!hasUniqueStrings(operationRefs) || !Array.isArray(definitionRefs) || definitionRefs.length !== operationRefs.length ||
      !hasUniqueStrings(ownerBinding.domainObjectRefs) || !hasUniqueStrings(ownerBinding.stateRefs) ||
      !hasUniqueStrings(ownerBinding.authorityRefs) || !hasUniqueStrings(ownerBinding.requirementRefs) ||
      !hasUniqueStrings(ownerBinding.supportingObservationOperationRefs ?? []) ||
      typeof ownerBinding.ownerResultSemantics !== "string" || ownerBinding.ownerResultSemantics.trim() === "" ||
      !Array.isArray(ownerBinding.failClosedCases) || ownerBinding.failClosedCases.length === 0) {
    return hold("OWNER_BINDING_REQUIRED_SEMANTICS_INCOMPLETE");
  }
  if (!equal(binding.primaryOperationRefs, operationRefs) ||
      !equal(binding.supportingObservationOperationRefs, ownerBinding.supportingObservationOperationRefs ?? []) ||
      !equal(binding.ownerDomainObjectRefs, ownerBinding.domainObjectRefs) ||
      !equal(binding.ownerStateRefs, ownerBinding.stateRefs) ||
      !equal(binding.ownerAuthorityRefs, ownerBinding.authorityRefs) ||
      !equal(binding.ownerRequirementRefs, ownerBinding.requirementRefs) ||
      binding.stateBindingDisposition !== ownerBinding.stateBindingDisposition ||
      binding.ownerResultSemantics !== ownerBinding.ownerResultSemantics ||
      !equal(binding.failClosedCases, ownerBinding.failClosedCases)) {
    return hold("STEP_PROJECTION_DRIFTS_FROM_EXACT_OWNER_BINDING");
  }

  const actionSource = sourceDocuments[".product-experience/pdp-3-product-experience/action-registry.yaml"];
  const actions = [...(actionSource?.actions ?? []), ...(actionSource?.ownerDefinedActions ?? [])];
  const action = actions.find((record) => record.id === ownerBinding.actionRef);
  const typedAction = action?.actionDefinitionSemantics?.typedDefinition;
  const primaryCommandRefs = operationRefs.filter((reference, index) => {
    const operation = resolvePdp3BindingSourceRef(definitionRefs[index], sourceDocuments);
    return (operation?.operationKind ?? operation?.ownerDefinition?.operationKind) === "COMMAND";
  });
  if (!typedAction || !equal(typedAction.exactOperationRefs.filter((reference) => {
    const operation = lookupOperation(reference, sourceDocuments);
    return (operation?.operationKind ?? operation?.ownerDefinition?.operationKind) === "COMMAND";
  }), primaryCommandRefs)) return hold("ACTION_AND_OWNER_COMMAND_SEQUENCE_MISMATCH");

  const sourceActionRefs = typedAction.exactOperationRefs ?? [];
  for (const operationRef of ownerBinding.supportingObservationOperationRefs ?? []) {
    const operation = lookupOperation(operationRef, sourceDocuments);
    if (!operation || (operation.operationKind ?? operation.ownerDefinition?.operationKind) !== "QUERY") {
      return hold("SUPPORTING_QUERY_NOT_BOUND_AS_EXACT_READ_MODEL");
    }
  }

  const resolvedOperations = [];
  for (let index = 0; index < operationRefs.length; index += 1) {
    const operation = resolvePdp3BindingSourceRef(definitionRefs[index], sourceDocuments);
    const operationKind = operation?.operationKind ?? operation?.ownerDefinition?.operationKind;
    if (!operation || operation.id !== operationRefs[index] || !["COMMAND", "QUERY"].includes(operationKind)) {
      return hold("CANONICAL_OPERATION_REFERENCE_OR_KIND_INVALID");
    }
    resolvedOperations.push({ operationRef: operation.id, operationKind });
  }
  if (ownerBinding.operationKind === "COMPOSITE_COMMAND_SEQUENCE" &&
      (resolvedOperations.length < 2 || resolvedOperations.some(({ operationKind }) => operationKind !== "COMMAND"))) {
    return hold("COMPOSITE_COMMAND_SEQUENCE_INVALID");
  }
  if (ownerBinding.operationKind !== "COMPOSITE_COMMAND_SEQUENCE" &&
      (resolvedOperations.length !== 1 || resolvedOperations[0].operationKind !== ownerBinding.operationKind)) {
    return hold("SINGLE_OPERATION_KIND_MISMATCH");
  }
  const expectedOperations = [...operationRefs, ...(ownerBinding.supportingObservationOperationRefs ?? [])];
  if (!operationRefs.every((reference) => typedAction.exactOperationRefs.includes(reference)) ||
      !equal(binding.operationRefs, typedAction.exactOperationRefs)) return hold("CANONICAL_STEP_OPERATION_SET_MISMATCH");

  for (const objectRef of ownerBinding.domainObjectRefs) {
    if (!(sourceDocuments[".product-experience/pdp-1-domain-data/domain-objects.yaml"]?.objects ?? []).some((row) => row.id === objectRef)) {
      return hold("CANONICAL_OBJECT_IDENTITY_NOT_REGISTERED");
    }
  }
  for (const stateRef of ownerBinding.stateRefs) {
    const state = resolvePdp3BindingSourceRef(stateRef, sourceDocuments);
    if (!state || typeof state.id !== "string" || !state.meaning) return hold("CANONICAL_STATE_REFERENCE_NOT_REGISTERED");
  }
  for (const authorityRef of ownerBinding.authorityRefs) {
    if (resolvePdp3BindingSourceRef(authorityRef, sourceDocuments) === undefined) return hold("CANONICAL_AUTHORITY_REFERENCE_NOT_REGISTERED");
  }
  for (const requirementRef of ownerBinding.requirementRefs) {
    const requirement = resolvePdp3BindingSourceRef(requirementRef, sourceDocuments);
    if (!requirement || !requirement.id) return hold("CANONICAL_REQUIREMENT_REFERENCE_NOT_REGISTERED");
  }

  return {
    disposition: ownerBinding.operationKind === "QUERY" ? "QUERY_DEFINITION_ONLY" : "REQUEST_DEFINITION_ONLY",
    operationRefs,
    supportingObservationOperationRefs: ownerBinding.supportingObservationOperationRefs ?? [],
    resolvedOperations,
    domainObjectRefs: [...ownerBinding.domainObjectRefs],
    stateRefs: [...ownerBinding.stateRefs],
    authorityRefs: [...ownerBinding.authorityRefs],
    requirementRefs: [...ownerBinding.requirementRefs],
    stateBindingDisposition: ownerBinding.stateBindingDisposition,
    ownerResultSemantics: ownerBinding.ownerResultSemantics,
    failClosedCases: [...ownerBinding.failClosedCases],
    dispatch: "NONE",
    effectApplied: false,
    finality: "NOT_ESTABLISHED_BY_DEFINITION_ORACLE",
    retryAuthorized: false,
    runtimeAdmission: "NOT_ADMITTED",
  };
}

function lookupOperation(operationRef, sourceDocuments) {
  const document = sourceDocuments[".product-experience/pdp-1-domain-data/operations.yaml"];
  for (const collection of ["ownerDefinedOperationContracts", "individualOperationContracts", "capabilityOperationContracts"]) {
    const found = document?.[collection]?.records?.find((record) => record.id === operationRef);
    if (found) return found;
  }
  return document?.operations?.find((record) => record.id === operationRef);
}
