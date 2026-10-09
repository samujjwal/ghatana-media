const unique = (values) => [...new Set(values ?? [])];

const same = (left, right) => JSON.stringify(left ?? []) === JSON.stringify(right ?? []);

function exactBindings(record, step, p0Journey, actionById, ownerBindingsById, localContractsById, context) {
  if (!record || !step || !p0Journey || record.journeyRef !== p0Journey.id
    || !same(record.outcomeRefs, p0Journey.outcomeRefs)
    || record.stepIntent !== step.stepIntent || record.viewRef !== step.viewRef
    || record.actionRef !== (step.actionRef ?? null)
    || record.semanticRole !== (step.semanticRole ?? null)) return false;

  const bindings = step.canonicalBindings ?? {};
  const action = record.actionRef ? actionById.get(record.actionRef) : null;
  const typed = action?.actionDefinitionSemantics?.typedDefinition;
  const exactActionOperations = typed?.exactOperationRefs ?? (action?.operationRef ? [action.operationRef] : []);
  if (record.actionRef && (!action || (typed?.semanticRole ?? action.semanticRole) !== record.semanticRole
    || !same(record.actionExactOperationRefs, exactActionOperations)
    || record.actionSourceRef !== context.actionSourceRefsById.get(record.actionRef))) return false;
  if (!record.actionRef && (record.actionExactOperationRefs?.length ?? 0) !== 0) return false;

  const declaredOptions = bindings.capabilityOptions ?? [];
  const expectedCapabilityRefs = declaredOptions.map((item) => item.capabilityRef);
  if (!same(record.capabilityRefs, expectedCapabilityRefs)) return false;
  if (declaredOptions.length) {
    const optionOperations = [...new Set(declaredOptions.flatMap((item) => item.operationRefs ?? []))];
    if (record.purposeClass !== "EXPLICIT_CAPABILITY_ALTERNATIVES"
      || !same(record.operationRefs, optionOperations)
      || record.bindingKind !== (declaredOptions.length === 1 ? "EXACT_SINGLE_OPERATION" : "EXPLICIT_USER_CHOICE_AMONG_EXACT_OPERATIONS")) return false;
  } else if (record.purposeClass === "EXPLICIT_CAPABILITY_ALTERNATIVES") return false;

  if (!same(record.allowedOperationRefs, record.operationRefs)
    || !same(record.operationRefs, record.purposeClass === "PDP1_OPERATION_BOUND_STEP"
      ? (bindings.primaryOperationRefs ?? bindings.ownerOperationRefs ?? bindings.operationRefs ?? [])
      : record.purposeClass === "EXACT_ACTION_OPERATION" || record.purposeClass === "LOCAL_SESSION_EFFECT"
        || record.purposeClass === "PASSIVE_OR_NO_DISPATCH" || record.purposeClass === "EXTERNAL_IDENTITY_HANDOFF_PENDING"
        ? exactActionOperations
        : record.purposeClass === "READ_ONLY_QUERY"
          ? (bindings.operationRefs ?? step.canonicalOperationRefs ?? [])
          : record.operationRefs)) return false;

  if (record.purposeClass === "PDP1_OPERATION_BOUND_STEP") {
    const owner = ownerBindingsById.get(record.ownerOperationBindingId);
    const ownerStepRef = record.stepRef?.replace("#/steps/", "#steps/");
    if (!owner || owner.journeyStepRef !== ownerStepRef || owner.actionRef !== record.actionRef
      || record.ownerOperationBindingRef !== `.product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedJourneyOperationBindings/records/@id=${owner.id}`
      || !same(record.operationRefs, owner.operationRefs ?? (owner.operationRef ? [owner.operationRef] : []))
      || !same(record.supportingOperationRefs, owner.supportingObservationOperationRefs)
      || !same(record.domainObjectRefs, owner.domainObjectRefs)
      || !same(record.stateRefs, owner.stateRefs)
      || !same(record.authorityRefs, owner.authorityRefs)
      || !same(record.requirementRefs, owner.requirementRefs)) return false;
  } else if (record.ownerOperationBindingId || record.ownerOperationBindingRef) return false;

  if (record.purposeClass === "LOCAL_SESSION_EFFECT") {
    const local = localContractsById.get(record.localEffectContractId);
    if (!local || local.sourceRef !== record.stepRef || local.actionRef !== record.actionRef
      || record.localEffectContractRef !== `.product-experience/pdp-3-product-experience/local-step-effect-contracts.yaml#records/@id=${local.id}`
      || (record.operationRefs?.length ?? 0) !== 0 || (record.supportingOperationRefs?.length ?? 0) !== 0
      || record.bindingKind !== "EXPLICIT_NO_DOMAIN_DISPATCH") return false;
  } else if (record.localEffectContractId || record.localEffectContractRef) return false;

  if (record.purposeClass === "EXACT_ACTION_OPERATION"
    && (!same(record.operationRefs, exactActionOperations) || record.bindingKind !== "EXACT_SINGLE_OPERATION")) return false;
  if (record.purposeClass === "PASSIVE_OR_NO_DISPATCH"
    && (record.actionRef !== null || record.operationRefs.length || record.bindingKind !== "EXPLICIT_NO_DOMAIN_DISPATCH")) return false;
  if (record.purposeClass === "READ_ONLY_QUERY"
    && (record.actionRef !== null || record.semanticRole !== "PASSIVE_QUERY"
      || record.operationRefs.length === 0 || record.operationKinds.some((kind) => kind !== "QUERY")
      || record.bindingKind !== "EXACT_SINGLE_OPERATION")) return false;
  if (record.purposeClass === "EXTERNAL_IDENTITY_HANDOFF_PENDING"
    && ((typed?.semanticRole ?? action?.semanticRole) !== "EXTERNAL_SHARED_IDENTITY_HANDOFF_OR_OBSERVATION"
      || record.operationRefs.length || record.bindingKind !== "EXTERNAL_SHARED_IDENTITY_HANDOFF_BOUNDARY")) return false;
  if (!new Set(["EXPLICIT_CAPABILITY_ALTERNATIVES", "PDP1_OPERATION_BOUND_STEP", "LOCAL_SESSION_EFFECT",
    "EXACT_ACTION_OPERATION", "PASSIVE_OR_NO_DISPATCH", "READ_ONLY_QUERY", "EXTERNAL_IDENTITY_HANDOFF_PENDING"]).has(record.purposeClass)) return false;

  return same(record.stateRefs, bindings.ownerStateRefs ?? bindings.stateRefs ?? [])
    && same(record.authorityRefs, bindings.ownerAuthorityRefs ?? bindings.authorityRefs ?? [])
    && same(record.requirementRefs, bindings.ownerRequirementRefs ?? bindings.requirementRefs ?? [])
    && same(record.domainObjectRefs, bindings.ownerDomainObjectRefs ?? bindings.domainObjectRefs ?? []);
}

/** Validate one total-purpose row against the authored journey, action, operation and local contracts. */
export function validatePdp3JourneyPurposeBinding(record, context) {
  const step = context.stepsByRef.get(record?.stepRef);
  const p0Journey = context.p0ById.get(record?.journeyRef);
  if (!exactBindings(record, step, p0Journey, context.actionsById, context.ownerBindingsById, context.localContractsById, context)) {
    return { valid: false, reason: "PURPOSE_OR_OPERATION_SCOPE_MISMATCH" };
  }
  if (record.purposeClass === "EXPLICIT_CAPABILITY_ALTERNATIVES") {
    const capPurpose = validatePdp3StepCapabilityPurpose(step, context.capabilitiesById, p0Journey);
    if (!capPurpose.valid) return capPurpose;
  }
  return { valid: true, reason: "EXACT_STEP_PURPOSE_AND_SCOPE" };
}

/** Validate that explicit capability alternatives serve the authored journey purpose. */
export function validatePdp3StepCapabilityPurpose(step, capabilitiesById, p0Journey) {
  const binding = step?.purposeBinding;
  const options = step?.capabilityOptions;
  if (!binding || binding.status !== "OWNER_DEFINED_PURPOSE_BOUND_ALTERNATIVES" || !Array.isArray(options)) {
    return { valid: false, reason: "PURPOSE_BINDING_MISSING" };
  }
  const purposeFamily = {
    SOURCE_ANALYSIS: "media.vision",
    SOURCE_QUALITY_OBSERVATION: "media.quality",
    SOURCE_VIDEO_REPAIR: "media.enhance.video",
    SOURCE_GROUNDED_MULTIMODAL: "media.multimodal",
    BRIEF_TO_VIDEO_GENERATION: "media.generate.video",
    CONTROLLED_VIDEO_GENERATION: "media.generate.video",
  }[binding.purposeClass];
  const sourceJourneyRef = `.product-experience/pdp-0-product-truth/journey-catalog.yaml#journeys/@id=${binding.journeyRef}`;
  if (!step.id?.startsWith(`${binding.journeyRef}.step-`) || !purposeFamily || !p0Journey
    || p0Journey.id !== binding.journeyRef
    || (binding.sourceRef && binding.sourceRef !== sourceJourneyRef)
    || JSON.stringify(binding.outcomeRefs ?? p0Journey.outcomeRefs) !== JSON.stringify(p0Journey.outcomeRefs)) {
    return { valid: false, reason: "PURPOSE_BINDING_MISMATCH" };
  }
  const optionIds = options.map((option) => option?.capabilityRef);
  if (optionIds.some((id) => typeof id !== "string") || new Set(optionIds).size !== optionIds.length
    || JSON.stringify(optionIds) !== JSON.stringify(binding.allowedCapabilityRefs)) {
    return { valid: false, reason: "CAPABILITY_OPTIONS_DO_NOT_MATCH_AUTHORED_PURPOSE_SET" };
  }
  for (const option of options) {
    const capability = capabilitiesById.get(option.capabilityRef);
    if (!capability || capability.familyId !== purposeFamily
      || JSON.stringify(capability.ownerDefinition?.operationRefs ?? []) !== JSON.stringify(option.operationRefs)
      || JSON.stringify(option.requirementRefs) !== JSON.stringify(binding.requirementRefs)
      || option.operationKind !== capability.ownerDefinition?.operationKind) {
      return { valid: false, reason: "CAPABILITY_SOURCE_DOES_NOT_MATCH_ANALYSIS_PURPOSE" };
    }
  }
  return { valid: true, reason: "EXACT_SOURCE_ANALYSIS_ALTERNATIVES" };
}

/** Check the source-only job-submit adapter against each exact target COMMAND contract. */
export function validatePdp3JobSubmitAdapter(adapter, { step, p0Journey, capabilitiesById, operationsById, jobSubmit }) {
  if (!adapter || !step || !p0Journey || adapter.journeyRef !== p0Journey.id
    || adapter.stepRef !== step.sourceRef || adapter.invocationOperationRef !== "media.operation.job.submit.v1"
    || adapter.invocationOperationVersion !== 1 || jobSubmit?.operationKind !== "COMMAND"
    || jobSubmit?.ownerWireSchema?.operationRef !== adapter.invocationOperationRef
    || jobSubmit?.ownerWireSchema?.requestSchema?.additionalProperties !== false
    || !Array.isArray(adapter.allowedCapabilityRefs) || adapter.allowedCapabilityRefs.length === 0
    || new Set(adapter.allowedCapabilityRefs).size !== adapter.allowedCapabilityRefs.length
    || adapter.userActionRef !== step.actionRef
    || adapter.userActionOperationRef !== "media.operation.action.submit-validated-request"
    || !same(adapter.outcomeRefs, p0Journey.outcomeRefs)
    || !same(adapter.allowedCapabilityRefs, (step.capabilityOptions ?? []).map((option) => option.capabilityRef))) {
    return { valid: false, reason: "JOB_SUBMIT_ADAPTER_SCOPE_MISMATCH" };
  }
  for (const option of step.capabilityOptions ?? []) {
    const capability = capabilitiesById.get(option.capabilityRef);
    const targetRef = option.operationRefs?.length === 1 ? option.operationRefs[0] : null;
    const target = targetRef ? operationsById.get(targetRef) : null;
    const expectedFamily = adapter.purposeClass === "SOURCE_ANALYSIS" ? "media.vision"
      : adapter.purposeClass === "SOURCE_GROUNDED_MULTIMODAL" ? "media.multimodal"
      : adapter.purposeClass === "SOURCE_VIDEO_REPAIR" ? "media.enhance.video"
      : adapter.purposeClass === "BRIEF_TO_VIDEO_GENERATION" || adapter.purposeClass === "CONTROLLED_VIDEO_GENERATION"
        ? "media.generate.video" : null;
    if (!capability || capability.familyId !== expectedFamily || !target
      || target.capabilityRef !== option.capabilityRef || target.operationKind !== "COMMAND"
      || target.asyncSubmissionDisposition !== "COMMAND_MAY_BE_SUBMITTED"
      || !Number.isSafeInteger(target.operationVersion) || target.requestSchema?.additionalProperties !== false
      || !same(capability.ownerDefinition?.operationRefs, option.operationRefs)
      || option.operationKind !== target.operationKind) {
      return { valid: false, reason: "TARGET_OPERATION_NOT_EXACT_ASYNC_COMMAND" };
    }
  }
  const construction = adapter.requestConstruction;
  if (construction?.sourceVersionBinding?.required !== true
    || construction?.sourceVersionBinding?.rejectLatestAliasOrVersionSubstitution !== true
    || construction?.typedInputs?.schemaSource !== "exact-selected-capability-operation-requestSchema"
    || construction?.typedInputs?.rejectUnknownFields !== true
    || construction?.parameters?.schemaSource !== "exact-selected-capability-operation-requestSchema.properties.parameters"
    || construction?.parameters?.defaults !== "none"
    || construction?.profile?.implicitDefault !== "forbidden"
    || construction?.fallbackPolicy?.silentFallback !== "forbidden"
    || construction?.deadlineAndResourceBudget?.absentOrStale !== "HOLD_UNKNOWN") {
    return { valid: false, reason: "JOB_SUBMIT_ADAPTER_REQUEST_CONSTRUCTION_INCOMPLETE" };
  }
  return { valid: true, reason: "EXACT_TARGET_COMMAND_ADAPTER_SOURCE_ONLY" };
}
