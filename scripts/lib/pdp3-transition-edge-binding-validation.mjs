const fail = (message) => { throw new Error(`Invalid PDP-3 transition edge binding: ${message}`); };

function equal(left, right) {
  const stable = (value) => Array.isArray(value) ? value.map(stable)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
      : value;
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function expectedStateRef(states, machineId, dimension, stateId) {
  const machine = states.stateMachines?.find((row) => row.machineId === machineId);
  if (!machine) return null;
  if (machine.stateDefinitions?.some((row) => row.id === stateId)) {
    return `.product-experience/pdp-1-domain-data/states.yaml#stateMachines/@machineId=${machineId}/stateDefinitions/@id=${stateId}`;
  }
  if (dimension && machine.stateDefinitionsByDimension?.[dimension]?.some((row) => row.id === stateId)) {
    return `.product-experience/pdp-1-domain-data/states.yaml#stateMachines/@machineId=${machineId}/stateDefinitionsByDimension/${dimension}/@id=${stateId}`;
  }
  return null;
}

function expectedInvocationDisposition(source, exactJourneyRows, actionIds) {
  const compatible = exactJourneyRows.length > 0 && exactJourneyRows.every((step) => step.actionRef && actionIds.has(step.actionRef) &&
    (source.operationRefs ?? []).some((operationRef) => step.canonicalOperationRefs.includes(operationRef)));
  const eventTriggerSource = source.eventTriggers ?? "NOT_DECLARED_IN_P1_TRANSITION";
  const operationBindingSource = source.operationBinding ?? "NOT_DECLARED_IN_P1_TRANSITION";
  const transitionInvocationDisposition = compatible
    ? "EXACT_P3_JOURNEY_ACTION_AND_P1_OPERATION_REFERENCE"
    : eventTriggerSource.includes("authority-source-event-required")
      ? "AUTHORITY_SOURCE_EVENT_REQUIRED; PUBLIC_OPERATION_AND_TRANSPORT_EXPLICITLY_UNBOUND"
      : operationBindingSource.includes("family reference only")
        ? "P1_OPERATION_FAMILY_PROPOSAL_ONLY; NO_EXACT_ACTION_INVOCATION"
        : operationBindingSource.includes("no-existing-verification-operation-identity")
          ? "P1_EXPLICITLY_NO_VERIFICATION_OPERATION_IDENTITY; NO_ROUTE_OR_RUNTIME_ADMISSION"
          : operationBindingSource.includes("successful-upload-finalization")
            ? "P1_BOUNDED_EXACT_OPERATION_EFFECT; JOURNEY_ACTION_REQUIRES_EXACT_STEP_BINDING"
            : (source.operationRefs ?? []).length
              ? "P1_OPERATION_REFERENCE_PRESENT; EVENT_OR_ACTION_INVOKER_NOT_ESTABLISHED"
              : eventTriggerSource.includes("pending-PDP1-004")
                ? "P1_EVENT_TRIGGER_PENDING; NO_EXACT_PUBLIC_OPERATION_OR_JOURNEY_ACTION"
                : "P1_TRIGGER_AND_ACTION_BINDING_NOT_SPECIFIED";
  return { eventTriggerSource, operationBindingSource, transitionInvocationDisposition };
}

/** Validate the complete P1 state-edge/guard source projection. It does not promote runtime or action semantics. */
export function validatePdp3TransitionEdgeBindings({ bindingDocument, transitions, guardContracts, states, journeys, stepOracles, actions }) {
  const sourceRows = [
    ...(transitions.transitionRecords ?? []),
    ...(transitions.ownerDefinedTransitionRecords ?? []),
  ];
  const guardByTransition = new Map((guardContracts.records ?? []).map((row) => [row.transitionId, row]));
  if (!Array.isArray(bindingDocument?.records) || bindingDocument.records.length !== sourceRows.length || sourceRows.length !== 55) {
    fail(`expected complete 55-row transition inventory; got ${bindingDocument?.records?.length}/${sourceRows.length}`);
  }
  if (bindingDocument.runtimeAdmission !== "NOT_ADMITTED" || bindingDocument.acceptanceEffect !== "none") {
    fail("source projection must preserve non-admission and no acceptance effect");
  }
  const p3StepByTransition = new Map();
  for (const journey of journeys) {
    for (const [index, step] of journey.document.steps.entries()) {
      const refs = [step.transitionRef, ...(step.transitionRefs ?? [])].filter((ref) => typeof ref === "string" && /^[^ ]+\/T\d+$/u.test(ref));
      for (const ref of refs) {
        const sourceRef = `.product-experience/pdp-3-product-experience/journey-contracts/${journey.filename}#/steps/${index}`;
        const oracle = stepOracles.get(sourceRef);
        if (!oracle) fail(`journey step ${sourceRef} has no exact step oracle`);
        const rows = p3StepByTransition.get(ref) ?? [];
        rows.push({ stepRef: sourceRef, journeyRef: journey.document.journeyId, stepId: step.stepId ?? null, actionRef: oracle.canonicalBindings?.actionRef, canonicalOperationRefs: oracle.canonicalBindings?.operationRefs ?? [] });
        p3StepByTransition.set(ref, rows);
      }
    }
  }
  const actionIds = new Set([...(actions.actions ?? []), ...(actions.ownerDefinedActions ?? [])].map((row) => row.id));
  const byId = new Map(bindingDocument.records.map((row) => [row.transitionId, row]));
  if (byId.size !== sourceRows.length) fail("duplicate transition IDs in source projection");
  for (const source of sourceRows) {
    const row = byId.get(source.id);
    const guard = guardByTransition.get(source.id);
    if (!row || !guard) fail(`missing exact P1 transition or guard source for ${source.id}`);
    const collection = transitions.transitionRecords?.includes(source) ? "transitionRecords" : "ownerDefinedTransitionRecords";
    const expectedTransitionRef = `.product-experience/pdp-1-domain-data/transitions.yaml#${collection}/@id=${source.id}`;
    const expectedGuardRef = `.product-experience/pdp-1-domain-data/transition-guard-contracts.yaml#records/@id=${guard.id}`;
    if (row.id !== `media.transition-step-binding.${source.id.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}.v1` || row.transitionRef !== expectedTransitionRef) {
      fail(`${source.id} does not retain its exact source identity`);
    }
    if (row.guardContractRef !== expectedGuardRef || row.ownerGuardRef !== expectedGuardRef) fail(`${source.id} guard is not the exact transition-specific contract`);
    if (!equal(row.operationRefs, source.operationRefs ?? [])) fail(`${source.id} operation refs drifted from P1`);
    const invocation = expectedInvocationDisposition(source, p3StepByTransition.get(source.id) ?? [], actionIds);
    for (const [key, expected] of Object.entries(invocation)) {
      if (row[key] !== expected) fail(`${source.id} ${key} is not grounded in the exact P1/P3 source disposition`);
    }
    if (row.eventTriggerSourceRef !== `${expectedTransitionRef}/eventTriggers` || row.operationBindingSourceRef !== `${expectedTransitionRef}/operationBinding`) {
      fail(`${source.id} trigger/invocation evidence selectors do not point to its exact P1 transition record`);
    }
    const sourceEdges = guard.edgeRules ?? [];
    if (!Array.isArray(row.edgeBindings) || row.edgeBindings.length !== sourceEdges.length) fail(`${source.id} edge population differs from its guard contract`);
    for (const [index, edge] of row.edgeBindings.entries()) {
      const sourceEdge = sourceEdges[index];
      if (edge.edgeRuleRef !== `${expectedGuardRef}/edgeRules/${index}` || !equal(edge.when, sourceEdge.when)) fail(`${source.id} edge ${index} guard/source ref drift`);
      if (!(source.from ?? []).includes(sourceEdge.from) || !(source.to ?? []).includes(sourceEdge.to)) fail(`${source.id} edge ${index} is not a legal source from/to pair`);
      const dimension = source.stateDimension ?? guard.stateDimension ?? null;
      if (edge.fromStateRef !== expectedStateRef(states, source.sourceMachineId, dimension, sourceEdge.from)) fail(`${source.id} edge ${index} source state is not exact`);
      if (edge.toStateRef !== expectedStateRef(states, source.sourceMachineId, dimension, sourceEdge.to)) fail(`${source.id} edge ${index} target state is not exact`);
      if (edge.sourceLegality !== "GUARD_EDGE_IS_MEMBER_OF_TRANSITION_FROM_AND_TO") fail(`${source.id} edge ${index} is not marked source-legal`);
    }
    const exactJourneyRows = p3StepByTransition.get(source.id) ?? [];
    if (!equal(row.exactJourneyBindings, exactJourneyRows)) fail(`${source.id} P3 exact journey refs drifted from source steps`);
    if (exactJourneyRows.length) {
      const compatible = exactJourneyRows.every((step) => step.actionRef && actionIds.has(step.actionRef) &&
        (source.operationRefs ?? []).some((operationRef) => step.canonicalOperationRefs.includes(operationRef)));
      const expected = compatible ? "EXACT_JOURNEY_TRANSITION_ACTION_AND_OPERATION_INTERSECTION" : "JOURNEY_TRANSITION_REF_CONFLICTS_WITH_EXACT_ACTION_OPERATION_BINDING";
      if (row.journeyActionDisposition !== expected) fail(`${source.id} P3 action/operation compatibility disposition is incorrect`);
    } else if (row.journeyActionDisposition !== "NO_EXACT_P3_JOURNEY_TRANSITION_REF; DO_NOT_INFER_ACTION_FROM_STATE_OR_OPERATION_NAMES") {
      fail(`${source.id} invents P3 action binding without an exact transitionRef`);
    }
    if (row.runtimeAdmission !== undefined && row.runtimeAdmission !== "NOT_ADMITTED") fail(`${source.id} runtime admission was promoted`);
    if (row.acceptanceEffect !== "none") fail(`${source.id} has an acceptance effect`);
  }
  return { transitions: sourceRows.length, guardedEdges: sourceRows.reduce((count, row) => count + (guardByTransition.get(row.id)?.edgeRules?.length ?? 0), 0) };
}
