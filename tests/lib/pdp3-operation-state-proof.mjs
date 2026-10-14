const isNonemptyStrings = (value) => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim().length > 0);

/** Validate the strict, per-operation PDP-1 state/observation proof branch. */
export function assertOperationStateProofs(edge, { operationsById, purposeById, exactStateRefExists, exactObservationRef }) {
  const proofs = edge.p1OperationStateProofs;
  if (!Array.isArray(proofs)) throw new Error(`${edge.id} requires exactly one state/observation proof for every P1 operation`);
  const proofByOperation = new Map();
  for (const proof of proofs) {
    if (!proof?.operationRef || proofByOperation.has(proof.operationRef)) {
      throw new Error(`${edge.id} has missing or duplicate operation proof coverage`);
    }
    proofByOperation.set(proof.operationRef, proof);
  }
  const expected = new Set(edge.p1OperationBindings.map((binding) => binding.operationRef));
  if (proofByOperation.size !== expected.size) {
    throw new Error(`${edge.id} requires exactly one state/observation proof for every P1 operation`);
  }
  if ([...proofByOperation.keys()].some((ref) => !expected.has(ref))) {
    throw new Error(`${edge.id} operation proof coverage must exactly match its P1 operations`);
  }

  for (const [operationRef, proof] of proofByOperation) {
    const operation = operationsById.get(operationRef);
    if (!operation) throw new Error(`${edge.id} proof references an unknown P1 operation`);
    if (!isNonemptyStrings(proof.purposeBindingRefs) || !proof.purposeBindingRefs.every((ref) => edge.purposeBindingRefs.includes(ref))) {
      throw new Error(`${edge.id} operation proof has an empty or non-edge purpose join`);
    }
    const purposeJoin = proof.purposeBindingRefs.some((ref) => {
      const purpose = purposeById.get(ref.split("@id=")[1]?.split(/[&#]/)[0]);
      return [...(purpose?.operationRefs ?? []), ...(purpose?.actionExactOperationRefs ?? [])].includes(operationRef);
    });
    if (!purposeJoin) throw new Error(`${edge.id} operation proof has a wrong purpose-to-operation join`);

    if (proof.disposition === "EXACT_P1_STATE_SOURCE_REF") {
      if (!proof.stateRef || !exactStateRefExists(proof.stateRef)) throw new Error(`${edge.id} proof has an unresolved exact state reference`);
      if (proof.observationRef || proof.noP1MachineState) throw new Error(`${edge.id} proof must select exactly one proof kind`);
      continue;
    }
    if (proof.disposition === "EXACT_TYPED_OBSERVATION_SOURCE_REF") {
      const observation = proof.observationRef && exactObservationRef(proof.observationRef);
      if (!observation || !observation.operationRefs?.includes(operationRef)
        || !purposeBindingRefsResolveObservation(proof.purposeBindingRefs, purposeById, proof.observationRef)
        || !edge.p1ObservationRefs.includes(proof.observationRef)
        || !edge.pdp1StateOrObservationRefs.includes(proof.observationRef)
        || !observation.readAuthorityRefs?.length
        || !observation.resultSchema || !Array.isArray(observation.resultSchema.required)
        || !observation.resultSchema.properties || typeof observation.resultSchema.properties !== "object"
        || !["operationRef", "currentness", "observationStatus", "accessDisposition", "observedAt", "readVersion"]
          .every((field) => observation.resultSchema.required.includes(field) && Object.hasOwn(observation.resultSchema.properties, field))) {
        throw new Error(`${edge.id} typed observation must bind the exact operation and expose its source-backed result schema`);
      }
      if (proof.stateRef || proof.noP1MachineState) throw new Error(`${edge.id} proof must select exactly one proof kind`);
      continue;
    }
    if (proof.disposition === "NO_P1_MACHINE_TRANSITION_TYPED_RESULT") {
      assertJ06NoTransitionTypedResultProof(edge, operation, proof, { purposeById, operationsById });
      continue;
    }
    if (proof.disposition !== "NO_P1_MACHINE_STATE") throw new Error(`${edge.id} proof has an unsupported operation proof kind`);

    const noState = proof.noP1MachineState;
    if (!noState || proof.stateRef || proof.observationRef) throw new Error(`${edge.id} no-state proof must be explicit and exclusive`);
    if (operation.operationKind !== "QUERY" || (operation.stateRefs ?? []).length !== 0) {
      throw new Error(`${edge.id} cannot label a command/write or stateful operation NO_P1_MACHINE_STATE`);
    }
    const effect = `${operation.sourceEffect ?? ""} ${operation.effectSemantics ?? ""}`.toLowerCase()
      .replace(/do not mutate/g, "")
      .replace(/no mutation/g, "");
    if (!/(read|inspect|observe|navigate)/.test(effect) || /(write|mutat|submit|create|delete|transition|persist|effectful)/.test(effect)) {
      throw new Error(`${edge.id} owner operation contract does not prove a no-effect query`);
    }
    for (const field of ["sourceRefs", "authorityRefs", "versionRefs", "deniedUnknownRecoveryRefs", "finalityRefs"]) {
      if (!isNonemptyStrings(noState[field])) throw new Error(`${edge.id} no-state proof requires nonempty ${field}`);
    }
    const operationSourceRef = `.product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=${operationRef}`;
    const exactNoEffectRef = `${operationSourceRef}/sourceEffect`;
    const exactResultSchemaSourceRef = `${operationSourceRef}/resultSchema`;
    const exactVersionRef = `${operationSourceRef}/contractVersion`;
    const exactSourceFinalityRef = `${operationSourceRef}/sourceFinality`;
    const profileSourceRef = `.product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationProfiles/profiles/@id=${operation.profileRef}`;
    const exactProfileRefs = [
      `${profileSourceRef}/requestEnvelope`,
      `${profileSourceRef}/resultEnvelope`,
      `${profileSourceRef}/errors`,
      `${profileSourceRef}/recovery`,
      `${profileSourceRef}/finality`,
    ];
    if (edge.p1OperationBindings.find((binding) => binding.operationRef === operationRef)?.sourceRef !== operationSourceRef
      || !noState.sourceRefs.includes(operationSourceRef)
      || !noState.sourceRefs.includes(exactResultSchemaSourceRef)
      || exactProfileRefs.some((ref) => !noState.sourceRefs.includes(ref))) {
      throw new Error(`${edge.id} no-state proof must cite the exact owner operation contract`);
    }
    if (!noState.resultRef || noState.resultRef !== operation.resultSchemaRef || !operation.resultSchema) {
      throw new Error(`${edge.id} no-state proof must cite the operation's typed result`);
    }
    if (noState.noEffectRef !== exactNoEffectRef || !noState.sourceRefs.includes(exactNoEffectRef)) {
      throw new Error(`${edge.id} no-state proof requires a source-bound no-effect statement`);
    }
    if (!noState.operationVersion || noState.operationVersion !== operation.contractVersion) {
      throw new Error(`${edge.id} no-state proof must bind the exact operation version`);
    }
    if (!(operation.authorityRefs ?? []).length || operation.authorityRefs.some((ref) => !noState.authorityRefs.includes(ref))) {
      throw new Error(`${edge.id} no-state proof must bind the exact operation authority set`);
    }
    if (!noState.versionRefs.includes(exactVersionRef)) {
      throw new Error(`${edge.id} no-state proof must bind the exact owner operation version reference`);
    }
    if (!noState.finalityRefs.includes(operation.resultSchemaRef)
      || !noState.finalityRefs.includes(`${profileSourceRef}/finality`)
      || !noState.finalityRefs.includes(exactSourceFinalityRef)) {
      throw new Error(`${edge.id} no-state proof must bind the exact result and owner finality sources`);
    }
    if (!operation.errorSchemaRef || !noState.deniedUnknownRecoveryRefs.includes(operation.errorSchemaRef)
      || !noState.deniedUnknownRecoveryRefs.includes(".product-experience/pdp-1-domain-data/action-contracts.yaml#outcomes/@id=UNKNOWN_OUTCOME")
      || !noState.deniedUnknownRecoveryRefs.includes(`${profileSourceRef}/recovery`)) {
      throw new Error(`${edge.id} no-state proof must bind denied, unknown, and recovery semantics`);
    }
  }
}

function assertJ06NoTransitionTypedResultProof(edge, operation, proof, { purposeById, operationsById }) {
  const purposeRef = ".product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml#records/@id=media.pdp3.step-purpose-binding.j06-step-01.v1";
  const purpose = purposeById.get("media.pdp3.step-purpose-binding.j06-step-01.v1");
  const operationRef = operation.id;
  const isAction = operationRef === "media.operation.action.submit-validated-request";
  const isCapability = operationRef === "media.operation.capability.media-multimodal-observe-source-grounded";
  const proofBody = proof.noP1MachineTransition;
  const operationSourceRef = isAction
    ? `.product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=${operationRef}`
    : `.product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/records/@id=${operationRef}`;
  const wrapperRef = ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.job.submit.v1";
  const adapterRef = ".product-experience/pdp-3-product-experience/capability-invocation-adapters.yaml#records/@id=media.pdp3.invocation-adapter.j06-source-grounded.v1";
  const stepRef = ".product-experience/pdp-3-product-experience/journey-contracts/return-grounded-typed-consumer-results.yaml#/steps/0";
  if ((!isAction && !isCapability) || operation.operationKind !== "COMMAND" || !proofBody
    || proof.stateRef || proof.observationRef || proof.purposeBindingRefs.length !== 1
    || proof.purposeBindingRefs[0] !== purposeRef || !purpose
    || purpose.transitionDisposition?.status !== "NO_P1_MACHINE_TRANSITION"
    || purpose.transitionDisposition.transitionRef !== null
    || purpose.transitionRefs?.length !== 0 || purpose.stateRefs?.length !== 0
    || !/durable request identity only/u.test(purpose.transitionDisposition.reason ?? "")
    || !/QUEUED, execution, completion, and output availability require separate owner-issued/u.test(purpose.transitionDisposition.reason ?? "")
    || !purpose.sourceRefs?.includes(operationSourceRef)
    || !purpose.sourceRefs?.includes(wrapperRef)
    || purpose.invocationAdapterRef !== adapterRef
    || !purpose.sourceRefs?.includes(adapterRef)
    || !edge.p1ObservationRefs?.includes(adapterRef)
    || !edge.p1ObservationRefs?.includes(stepRef)
    || edge.runtimeAdmission !== "NOT_ADMITTED"
    || edge.transportRefOrUnbound !== "UNBOUND") {
    throw new Error(`${edge.id} J-06 command proof must bind the exact owner-defined no-transition request/result chain without claiming execution`);
  }

  const wrapper = operationsById.get("media.operation.job.submit.v1");
  if (!wrapper || wrapper.operationVersion !== 1 || wrapper.executionAdmission !== "NOT_ADMITTED"
    || !String(wrapper.finality ?? "").includes("REQUEST_ACKNOWLEDGED proves a durable logical Media job receipt only")
    || !String(wrapper.finality ?? "").includes("QUEUED does not prove provider dispatch, execution, completion")) {
    throw new Error(`${edge.id} J-06 proof must retain the exact non-admitted job-submit receipt finality`);
  }
  const requiredResultRefs = [
    `${purposeRef}/transitionDisposition`,
    `${purposeRef}/stateRefs`,
    `${purposeRef}/transitionRefs`,
    `${operationSourceRef}/resultSchema`,
    `${wrapperRef}/ownerWireSchema/resultSchema`,
    `${wrapperRef}/resultObservationSemantics`,
    adapterRef,
    stepRef,
  ];
  if (!isNonemptyStrings(proofBody.sourceRefs)
    || requiredResultRefs.some((ref) => !proofBody.sourceRefs.includes(ref))
    || !purpose.sourceRefs?.includes(operationSourceRef)
    || proofBody.wrapperOperationRef !== "media.operation.job.submit.v1"
    || proofBody.wrapperOperationVersion !== wrapper.operationVersion
    || proofBody.operationVersion !== (operation.contractVersion ?? operation.operationVersion)
    || proofBody.operationResultRef !== `${operationSourceRef}/resultSchema`
    || proofBody.wrapperResultRef !== `${wrapperRef}/ownerWireSchema/resultSchema`
    || !isNonemptyStrings(proofBody.authorityRefs)
    || (purpose.authorityRefs ?? []).some((ref) => !proofBody.authorityRefs.includes(ref))
    || !proofBody.versionRefs?.includes(`${operationSourceRef}/${isAction ? "contractVersion" : "operationVersion"}`)
    || !proofBody.versionRefs?.includes(`${wrapperRef}/operationVersion`)
    || !proofBody.finalityRefs?.includes(`${wrapperRef}/resultObservationSemantics`)
    || !proofBody.finalityRefs?.includes(`${wrapperRef}/finality`)
    || !proofBody.deniedUnknownRecoveryRefs?.includes(`${wrapperRef}/errors`)
    || !proofBody.deniedUnknownRecoveryRefs?.includes(`${wrapperRef}/retry`)) {
    throw new Error(`${edge.id} J-06 proof must join exact operation, wrapper receipt, authority, version, errors, recovery, and finality`);
  }

  if (isAction) {
    if (!(operation.stateRefs ?? []).length
      || !String(operation.resultSchema?.finality ?? "").includes("owner receipt only; no unstated downstream effect is implied")
      || !String(operation.sourceFinality ?? "").includes("unknown-is-not-failure")
      || !proofBody.finalityRefs.includes(`${operationSourceRef}/sourceFinality`)
      || !proofBody.deniedUnknownRecoveryRefs.includes(operation.errorSchemaRef)) {
      throw new Error(`${edge.id} J-06 action proof requires the exact request-receipt-only owner result and unknown finality`);
    }
  } else {
    const schema = operation.resultSchema;
    if (operation.operationVersion !== 1 || operation.admission?.executionAdmission !== "NOT_ADMITTED"
      || !schema?.required?.includes("outcome") || !schema.required.includes("outputs")
      || !schema.required.includes("provenance") || !schema.required.includes("implementationState")
      || !schema.required.includes("qualificationState") || !schema.required.includes("runtimeAvailability")
      || schema.properties?.implementationState?.const !== "UNKNOWN"
      || schema.properties?.qualificationState?.const !== "NOT_EVALUATED"
      || schema.properties?.runtimeAvailability?.const !== "UNKNOWN"
      || !schema.properties?.outcome?.enum?.includes("UNKNOWN_OUTCOME")
      || !proofBody.finalityRefs.includes(`${operationSourceRef}/resultSchema`)) {
      throw new Error(`${edge.id} J-06 capability proof must bind the typed result and explicit non-admission/unknown fields`);
    }
    if (!proofBody.sourceRefs.includes(`${operationSourceRef}/resultSchema`)
      || !proofBody.sourceRefs.includes(`${operationSourceRef}/admission`)) {
      throw new Error(`${edge.id} J-06 capability proof omits its exact typed result or admission source`);
    }
  }
}

function purposeBindingRefsResolveObservation(refs, purposeById, observationRef) {
  return refs.some((ref) => {
    const purpose = purposeById.get(ref.split("@id=")[1]?.split(/[&#]/)[0]);
    return purpose?.sourceRefs?.includes(observationRef);
  });
}

/** Validate explicitly source-bound local session steps without treating them as PDP-1 state. */
export function assertLocalStepNoP1MachineProofs(edge, { journeyContract, purposeById, localStepEffectsById }) {
  const proofs = edge.localStepNoP1MachineProofs ?? [];
  if (!Array.isArray(proofs)) throw new Error(`${edge.id} local-step no-state proofs must be an array`);
  const path = edge.journeyContractRef.split("#")[0];
  const stepRefFor = (index) => `${path}#/steps/${index}`;
  const required = (journeyContract.steps ?? [])
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.stepDefinitionSemantics?.action?.domainOperationDisposition === "NO_DOMAIN_OPERATION_LOCAL_SELECTION_OR_SESSION_DRAFT");
  if (proofs.length !== required.length) {
    throw new Error(`${edge.id} requires one exact local-step no-P1-state proof for every source-defined local session step`);
  }
  const proofByStep = new Map();
  for (const proof of proofs) {
    if (!Number.isInteger(proof.stepIndex) || proofByStep.has(proof.stepIndex)) {
      throw new Error(`${edge.id} has a missing or duplicate local-step proof`);
    }
    proofByStep.set(proof.stepIndex, proof);
  }
  for (const { step, index } of required) {
    const proof = proofByStep.get(index);
    const stepDefinition = step.stepDefinitionSemantics;
    const sourceStepRef = stepRefFor(index);
    const action = stepDefinition.action;
    const transition = stepDefinition.transitionApplicability;
    const effectRef = stepDefinition.canonicalBindings?.localEffectContractRef;
    const effectId = stepDefinition.canonicalBindings?.localEffectContractId;
    const effect = effectId && localStepEffectsById.get(effectId);
    if (!proof || proof.stepRef !== sourceStepRef || proof.actionRef !== step.actionRef
      || proof.disposition !== "LOCAL_SESSION_OR_DRAFT_EFFECT; NO_MEDIA_DOMAIN_TRANSITION"
      || action?.domainOperationDisposition !== "NO_DOMAIN_OPERATION_LOCAL_SELECTION_OR_SESSION_DRAFT"
      || action?.exactOperationRefs?.length !== 0
      || transition?.status !== proof.disposition || transition.transitionRef !== null
      || transition.stateRefs?.length !== 0 || transition.operationRef !== null
      || !effectRef || proof.localEffectContractRef !== effectRef || !effect || effect.sourceRef !== sourceStepRef
      || effect.canonicalTransitionRef !== null || effect.canonicalDomainObjectRefs?.length !== 0
      || effect.exactOperationRefs?.length !== 0 || effect.effect?.committedMediaObjects !== "unchanged"
      || effect.effect?.remoteDispatch !== "none" || !String(effect.finality ?? "").includes("LOCAL_DRAFT_REVISION_ONLY")
      || !effect.failureRecovery || !effect.inputContract?.effectBoundary?.includes("does not mutate the session")) {
      throw new Error(`${edge.id} local-step proof must preserve the exact source-defined local-only effect and recovery`);
    }
    if (!Array.isArray(proof.purposeBindingRefs) || proof.purposeBindingRefs.length === 0
      || !proof.purposeBindingRefs.every((ref) => edge.purposeBindingRefs.includes(ref))) {
      throw new Error(`${edge.id} local-step proof must cite its edge purpose binding`);
    }
    const purposeJoinsStep = proof.purposeBindingRefs.some((ref) => {
      const purpose = purposeById.get(ref.split("@id=")[1]?.split(/[&#]/)[0]);
      return purpose?.sourceRefs?.includes(sourceStepRef);
    });
    if (!purposeJoinsStep) throw new Error(`${edge.id} local-step proof has a wrong purpose-to-step join`);
    const requiredSources = [
      sourceStepRef,
      `${sourceStepRef}/stepDefinitionSemantics/action`,
      `${sourceStepRef}/stepDefinitionSemantics/transitionApplicability`,
      effectRef,
      ...(stepDefinition.stepSourceFacts?.resultSourceRef ?? []),
    ];
    if (!Array.isArray(proof.sourceRefs) || requiredSources.some((ref) => !proof.sourceRefs.includes(ref))) {
      throw new Error(`${edge.id} local-step proof omits its source, no-transition, local-effect, or typed-result references`);
    }
  }
}
