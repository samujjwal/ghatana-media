const isNonemptyStrings = (value) => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim().length > 0);
// Some source-authored operation families place these arrays under stateBinding.
// A canonical top-level field, including an explicitly empty array, always wins.
const operationStateRefs = (operation) => Object.hasOwn(operation, "stateRefs")
  ? operation.stateRefs : operation.stateBinding?.stateRefs ?? [];
const operationTransitionRefs = (operation) => Object.hasOwn(operation, "transitionRefs")
  ? operation.transitionRefs : operation.stateBinding?.transitionRefs ?? [];

/** Validate the strict, per-operation PDP-1 state/observation proof branch. */
export function assertOperationStateProofs(edge, { operationsById, purposeById, exactStateRefExists, exactStateSourceRefExists = () => false, exactObservationRef, journeyOperationBindings = [], journeyContract }) {
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
      return [...(purpose?.operationRefs ?? []), ...(purpose?.actionExactOperationRefs ?? [])].includes(operationRef)
        || purpose?.relatedActionBindings?.some((binding) => binding.operationRef === operationRef
          || (proof.disposition === "CONDITIONAL_SELECTED_TARGET_RESULT_SOURCE_REF"
            && binding.selectedTargetOperationRef === operationRef));
    });
    if (!purposeJoin) throw new Error(`${edge.id} operation proof has a wrong purpose-to-operation join`);

    if (proof.disposition === "EXACT_P1_STATE_SOURCE_REF") {
      if (!proof.stateRef || !exactStateRefExists(proof.stateRef)
        || !operationStateRefs(operation).includes(proof.stateRef)) {
        throw new Error(`${edge.id} proof state reference must resolve and occur in the bound operation stateRefs`);
      }
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
      if (proof.purposeBindingRefs.length === 1
        && proof.purposeBindingRefs[0] === ".product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml#records/@id=media.pdp3.step-purpose-binding.j06-step-01.v1") {
        assertJ06NoTransitionTypedResultProof(edge, operation, proof, { purposeById, operationsById });
      } else {
        assertNoTransitionTypedOperationResultProof(edge, operation, proof, { purposeById, journeyOperationBindings });
      }
      continue;
    }
    if (proof.disposition === "EXACT_JOURNEY_TYPED_RESULT_SOURCE_REF") {
      assertJourneyTypedResultProof(edge, operation, proof, {
        purposeById, exactStateRefExists, exactStateSourceRefExists, journeyContract,
      });
      continue;
    }
    if (proof.disposition === "CONDITIONAL_SELECTED_TARGET_RESULT_SOURCE_REF") {
      assertConditionalSelectedTargetResultProof(edge, operation, proof, { purposeById, journeyContract, operationsById });
      continue;
    }
    if (proof.disposition !== "NO_P1_MACHINE_STATE") throw new Error(`${edge.id} proof has an unsupported operation proof kind`);

    const noState = proof.noP1MachineState;
    if (!noState || proof.stateRef || proof.observationRef || proof.noP1MachineTransition) {
      throw new Error(`${edge.id} no-state proof must be explicit and exclusive`);
    }
    if (operation.operationKind !== "QUERY" || operationStateRefs(operation).length !== 0 || operationTransitionRefs(operation).length !== 0) {
      throw new Error(`${edge.id} cannot label a command/write or stateful operation NO_P1_MACHINE_STATE`);
    }
    const effect = `${operation.sourceEffect ?? ""} ${operation.effectSemantics ?? ""}`.toLowerCase()
      .replace(/do not mutate/g, "")
      .replace(/no mutation/g, "");
    if (!/(read|inspect|observe|navigate)/.test(effect) || /(write|mutat|submit|create|delete|transition|persist|effectful)/.test(effect)) {
      throw new Error(`${edge.id} owner operation contract does not prove a no-effect query`);
    }
    const edgeOperationSourceRef = edge.p1OperationBindings.find((binding) => binding.operationRef === operationRef)?.sourceRef;
    const canonicalOperationSourceRef = `.product-experience/pdp-1-domain-data/operations.yaml#operations/@id=${operationRef}`;
    if (edgeOperationSourceRef === canonicalOperationSourceRef) {
      assertCanonicalOperationNoStateProof(edge, operation, noState, canonicalOperationSourceRef);
      continue;
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
    const exactResultSchemaMaterialRef = typeof operation.resultSchemaRef === "string" && operation.resultSchemaRef.startsWith(".")
      ? operation.resultSchemaRef : `${profileSourceRef}/resultEnvelope`;
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
      || !noState.sourceRefs.includes(exactResultSchemaMaterialRef)
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

function assertConditionalSelectedTargetResultProof(edge, operation, proof, { purposeById, journeyContract, operationsById }) {
  const journeyFile = edge.journeyContractRef;
  const binding = journeyContract?.pdp1ResultEvidence?.conditionalSelectedCommandResultBinding;
  const journeyBindingRef = `${journeyFile}#/pdp1ResultEvidence/conditionalSelectedCommandResultBinding`;
  const purposeRef = proof.purposeBindingRefs[0];
  const purposeId = purposeRef?.split("@id=")[1]?.split(/[&#]/)[0];
  const purpose = purposeById.get(purposeId);
  const relation = proof.selectedActionPurposeBindingRef?.match(/^(.+)#records\/@id=([^/]+)\/relatedActionBindings\/@id=(.+)$/u);
  const relationRecord = relation && purposeById.get(relation[2])?.relatedActionBindings?.find((item) => item.id === relation[3]);
  const selectedBinding = operationsById.get(relationRecord?.operationRef)?.selectedTargetOperationBinding;
  const expectedTargetSource = `.product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/records/@id=${operation.id}`;
  const exactSourceRefs = {
    journey: journeyBindingRef,
    purpose: `.product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml#records/@id=${purposeId}`,
    relation: proof.selectedActionPurposeBindingRef,
    selectedBinding: `${relationRecord?.operationSourceRef}/selectedTargetOperationBinding`,
    target: expectedTargetSource,
    request: `${expectedTargetSource}/requestSchema`,
    result: `${expectedTargetSource}/resultSchema`,
    ttsResult: ".product-experience/pdp-1-domain-data/operations.yaml#media.operation.tts-request-origin-binding.v1/producedOutputObservation",
  };
  const stateRefs = operationStateRefs(operation);
  const transitionRefs = operationTransitionRefs(operation);
  if (!journeyContract || !binding || edge.journeyRef !== "J-04"
    || proof.operationRef !== operation.id || operation.operationKind !== "COMMAND"
    || edge.p1OperationBindings.find((item) => item.operationRef === operation.id)?.sourceRef !== expectedTargetSource
    || proof.journeyConditionalResultBindingRef !== exactSourceRefs.journey
    || proof.purposeBindingRefs.length !== 1 || !purpose || purposeRef !== exactSourceRefs.purpose
    || proof.selectedActionPurposeBindingRef !== `${exactSourceRefs.purpose}/relatedActionBindings/@id=media.pdp3.action-binding.j04-selected-tts-command.v1`
    || !relationRecord || relationRecord.bindingKind !== "CONDITIONAL_SELECTED_TARGET_COMMAND_ACTION_PURPOSE"
    || relationRecord.operationRef !== binding.actionPurposeOperationRef
    || relationRecord.actionRef !== binding.candidateActionRef
    || relationRecord.selectedTargetOperationRef !== operation.id
    || relationRecord.selectedTargetOperationSourceRef !== expectedTargetSource
    || relationRecord.selectedTargetOperationBindingRef !== exactSourceRefs.selectedBinding
    || binding.journeyPurposeBindingRef !== proof.selectedActionPurposeBindingRef
    || binding.selectedTargetOperationBindingRef !== exactSourceRefs.selectedBinding
    || binding.operationSourceRef !== expectedTargetSource
    || binding.selectedCanonicalOperationRef !== operation.id
    || binding.selectedCapabilityRef !== relationRecord.selectedTargetCapabilityRef
    || binding.selection !== "EXPLICIT_USER_SELECTION_REQUIRED; NO_DEFAULT; NO_DISPATCH_UNTIL_SELECTED"
    || relationRecord.selectionCondition !== "Trusted explicit user selection of exactly one current COMMAND target; no default and no dispatch before selection."
    || selectedBinding?.status !== "OWNER_DEFINED_EXACT_SELECTED_TARGET_COMMAND_BINDING"
    || selectedBinding?.admittedOperationRefMeaning?.includes("never carries the selected target identity") !== true
    || proof.selectedTargetOperationBindingRef !== exactSourceRefs.selectedBinding
    || proof.selectedTargetOperationSourceRef !== expectedTargetSource
    || proof.selectedTargetRequestSchemaRef !== exactSourceRefs.request
    || proof.selectedTargetResultSchemaRef !== exactSourceRefs.result
    || proof.ttsResultBindingRef !== exactSourceRefs.ttsResult
    || binding.resultBindingRef !== exactSourceRefs.ttsResult
    || proof.selectionDisposition !== "EXPLICIT_USER_SELECTION_REQUIRED; NO_DEFAULT; NO_DISPATCH_UNTIL_SELECTED"
    || JSON.stringify(proof.stateRefs) !== JSON.stringify(stateRefs)
    || JSON.stringify(proof.transitionRefs) !== JSON.stringify(transitionRefs)
    || proof.runtimeAdmission !== "NOT_ADMITTED" || proof.transportRef !== "UNBOUND"
    || edge.runtimeAdmission !== "NOT_ADMITTED" || edge.transportRefOrUnbound !== "UNBOUND"
    || !relationRecord.sourceRefs?.includes(expectedTargetSource)
    || !relationRecord.sourceRefs?.includes(exactSourceRefs.ttsResult)
    || !operation.requestSchema || !operation.resultSchema) {
    throw new Error(`${edge.id} conditional selected-target proof must bind the exact J-04 action-purpose, wrapper target, TTS schemas, and source result without dispatch or admission`);
  }
}

function assertJourneyTypedResultProof(edge, operation, proof, { purposeById, exactStateRefExists, exactStateSourceRefExists, journeyContract }) {
  if (!journeyContract || (!Array.isArray(proof.journeyResultBindingRefs) || proof.journeyResultBindingRefs.length === 0)
    && (!Array.isArray(proof.relatedActionBindingRefs) || proof.relatedActionBindingRefs.length === 0)
    && (!Array.isArray(proof.journeyOperationResultBindingRefs) || proof.journeyOperationResultBindingRefs.length === 0)) {
    throw new Error(`${edge.id} exact journey result proof requires a source-bound result or exact related action binding`);
  }
  const journeyFile = edge.journeyContractRef;
  const resultBindings = journeyContract.pdp1ResultEvidence?.operationResultBindings ?? [];
  for (const ref of proof.journeyResultBindingRefs) {
    const match = ref.match(/^(.+)#\/pdp1ResultEvidence\/operationResultBindings\/(\d+)$/u);
    if (!match || match[1] !== journeyFile) throw new Error(`${edge.id} journey result binding ref is not exact`);
    const binding = resultBindings[Number(match[2])];
    const boundOperationRef = binding?.presentationOperationRef ?? binding?.operationRef;
    const purposeRef = binding?.journeyPurposeBindingRef ?? binding?.purposeBindingRef;
    const resultSource = binding?.resultSchemaRef ?? binding?.typedObservationContractRef;
    if (!binding || boundOperationRef !== operation.id
      || !proof.purposeBindingRefs.includes(purposeRef)
      || !resultSource?.startsWith(".product-experience/pdp-1-domain-data/operations.yaml#")
      || !(binding.exactResult || binding.resultMeaning || binding.delegatedResultKind || binding.observationContractRef || binding.typedObservationContractRef)
      || !(binding.unknownDisposition || binding.unknownRecovery || binding.unknownDispositionRef || binding.errorsAndRecovery)) {
      throw new Error(`${edge.id} journey result binding must join the exact P1 operation, purpose, typed result, and unknown semantics`);
    }
    const purposeId = purposeRef.split("@id=")[1]?.split(/[&#]/)[0];
    const purpose = purposeById.get(purposeId);
    if (!purpose || purpose.stepRef !== binding.journeyStepRef
      || ![...(purpose.operationRefs ?? []), ...(purpose.actionExactOperationRefs ?? [])].includes(operation.id)
        && !purpose.relatedActionBindings?.some((item) => item.operationRef === operation.id)) {
      throw new Error(`${edge.id} journey result binding has a mismatched purpose/action/operation/step join`);
    }
  }

  const actualStateRefs = operationStateRefs(operation);
  if (!Array.isArray(proof.stateRefs) || JSON.stringify(proof.stateRefs) !== JSON.stringify(actualStateRefs)
    || proof.stateRefs.some((ref) => !exactStateRefExists(ref) && !exactStateSourceRefExists(ref))) {
    throw new Error(`${edge.id} result proof stateRefs must exactly match the canonical P1 operation stateRefs array`);
  }
  const actualTransitionRefs = operationTransitionRefs(operation);
  if (!Array.isArray(proof.transitionRefs) || JSON.stringify(proof.transitionRefs) !== JSON.stringify(actualTransitionRefs)) {
    throw new Error(`${edge.id} result proof transitionRefs must exactly match the canonical P1 operation transitionRefs array`);
  }

  const observationBindings = journeyContract.pdp1ResultEvidence?.typedObservationBindings ?? [];
  for (const ref of proof.typedObservationBindingRefs ?? []) {
    const match = ref.match(/^(.+)#\/pdp1ResultEvidence\/typedObservationBindings\/(\d+)$/u);
    if (!match || match[1] !== journeyFile) throw new Error(`${edge.id} typed observation binding ref is not exact`);
    const binding = observationBindings[Number(match[2])];
    const observationId = binding?.observationContractRef?.split("@id=")[1]?.split(/[&#]/)[0];
    if (!binding || binding.operationRef !== operation.id || !observationId
      || !proof.purposeBindingRefs.includes(binding.actionBindingRef?.split("/relatedActionBindings/")[0] ?? binding.purposeBindingRef)) {
      throw new Error(`${edge.id} typed observation binding does not join the exact operation and purpose`);
    }
  }

  for (const ref of proof.journeyOperationResultBindingRefs ?? []) {
    const match = ref.match(/^(.+)#\/pdp1ResultEvidence\/operationResultBindings\/(\d+)$/u);
    if (!match || match[1] !== journeyFile) throw new Error(`${edge.id} journey operation result ref is not exact`);
    const binding = resultBindings[Number(match[2])];
    const relation = (proof.relatedActionBindingRefs ?? []).map((relationRef) => {
      const relationMatch = relationRef.match(/^(.+)#records\/@id=([^/]+)\/relatedActionBindings\/@id=(.+)$/u);
      const purpose = relationMatch && purposeById.get(relationMatch[2]);
      return purpose?.relatedActionBindings?.find((item) => item.id === relationMatch?.[3]);
    }).find((item) => item?.actionRef === binding?.actionRef);
    const operationSourceRef = edge.p1OperationBindings.find((item) => item.operationRef === operation.id)?.sourceRef;
    if (!binding || binding.operationRef !== operation.id || binding.operationKind !== operation.operationKind
      || binding.operationContractRef !== operationSourceRef || !relation
      || !binding.actionSourceRef?.endsWith(`actions/@id=${relation.actionRef}`)
      || !binding.receiptMeaning && !binding.observationEffect) {
      throw new Error(`${edge.id} journey result must resolve the exact related action and operation contract`);
    }
  }

  for (const ref of proof.relatedActionBindingRefs ?? []) {
    const match = ref.match(/^(.+)#records\/@id=([^/]+)\/relatedActionBindings\/@id=(.+)$/u);
    if (!match || match[1] !== ".product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml") {
      throw new Error(`${edge.id} related action binding ref is not canonical`);
    }
    const purpose = purposeById.get(match[2]);
    const relation = purpose?.relatedActionBindings?.find((item) => item.id === match[3]);
    if (!purpose || !relation || !proof.purposeBindingRefs.includes(`${match[1]}#records/@id=${match[2]}`)
      || relation.operationRef !== operation.id
      || relation.operationSourceRef !== edge.p1OperationBindings.find((item) => item.operationRef === operation.id)?.sourceRef
      || relation.operationKind !== operation.operationKind
      || !relation.actionSourceRef?.endsWith(`actions/@id=${relation.actionRef}`)
      || !relation.intentSourceRef || !relation.effect || !relation.finality || !relation.recovery) {
      throw new Error(`${edge.id} related action proof must bind the exact purpose, action, operation, source, intent, and result semantics`);
    }
    if (relation.intentSourceRef.startsWith(journeyFile)) {
      const fallback = journeyContract.pdp1ResultEvidence?.fallbackConfirmation;
      if (fallback && relation.operationRef !== fallback.operationRef) {
        throw new Error(`${edge.id} fallback related action does not match the exact journey result operation`);
      }
      if (fallback && relation.intentSourceRef !== `${journeyFile}#/pdp1ResultEvidence/fallbackConfirmation`) {
        throw new Error(`${edge.id} fallback related action intent ref must resolve to the exact confirmation result contract`);
      }
      if (!fallback && !journeyContract.steps?.some((step, index) =>
        relation.intentSourceRef === `${journeyFile}#/steps/${index}`
          && step.relatedActionBindings?.some((item) => item.operationRef === operation.id))
        && !journeyContract.pdp1ResultEvidence?.typedObservationBindings?.some((item) =>
          item.journeyStepRef === relation.intentSourceRef
            && item.purposeBindingRef === `${match[1]}#records/@id=${match[2]}`
            && item.actionBindingRef === ref
            && item.operationRef === operation.id)
        && !(() => {
          const resultMatch = relation.intentSourceRef.match(/^(.+)#\/pdp1ResultEvidence\/operationResultBindings\/(\d+)$/u);
          if (!resultMatch || resultMatch[1] !== journeyFile) return false;
          const result = journeyContract.pdp1ResultEvidence?.operationResultBindings?.[Number(resultMatch[2])];
          return result?.operationRef === operation.id
            && (result.journeyPurposeBindingRef ?? result.purposeBindingRef) === `${match[1]}#records/@id=${match[2]}`;
        })()) {
        throw new Error(`${edge.id} related action intent does not resolve to an exact journey step action`);
      }
    }
    const journeyResultBound = (proof.journeyResultBindingRefs ?? []).some((resultRef) => {
      const resultMatch = resultRef.match(/^(.+)#\/pdp1ResultEvidence\/operationResultBindings\/(\d+)$/u);
      const binding = resultMatch && resultMatch[1] === journeyFile
        ? resultBindings[Number(resultMatch[2])]
        : null;
      return binding?.operationRef === operation.id
        && (binding?.journeyPurposeBindingRef ?? binding?.purposeBindingRef) === `${match[1]}#records/@id=${match[2]}`
        && typeof (binding.resultSchemaRef ?? binding.typedObservationContractRef) === "string"
        && (binding.resultSchemaRef ?? binding.typedObservationContractRef).startsWith(".product-experience/pdp-1-domain-data/operations.yaml#")
        && Boolean(binding.exactResult || binding.resultMeaning || binding.delegatedResultKind || binding.observationContractRef || binding.typedObservationContractRef)
        && Boolean(binding.unknownDisposition || binding.unknownRecovery || binding.unknownDispositionRef || binding.errorsAndRecovery);
    });
    const directOperationResult = operation.resultSchemaRef?.startsWith(".product-experience/pdp-1-domain-data/operations.yaml#")
      && operation.resultSchema && (operation.resultSchema.type === "object" || Array.isArray(operation.resultSchema.required));
    const fallback = journeyContract.pdp1ResultEvidence?.fallbackConfirmation;
    const operationSourceRef = edge.p1OperationBindings.find((item) => item.operationRef === operation.id)?.sourceRef;
    const fallbackOperationResult = fallback?.operationRef === operation.id
      && fallback?.sourceRef === operationSourceRef
      && fallback?.operationKind === operation.operationKind
      && Array.isArray(operation.resultSchema?.oneOf) && operation.resultSchema.oneOf.length > 0
      && typeof operation.sourceEffect === "string" && operation.sourceEffect.trim().length > 0
      && typeof operation.sourceFinality === "string" && operation.sourceFinality.trim().length > 0
      && typeof operation.sourceRecovery === "string" && operation.sourceRecovery.trim().length > 0
      && typeof fallback.effect === "string" && typeof fallback.finality === "string"
      && typeof fallback.unknownRecovery === "string";
    if (!directOperationResult && !journeyResultBound && !fallbackOperationResult) {
      throw new Error(`${edge.id} related action operation must expose its exact typed P1 result contract`);
    }
  }
}

function assertCanonicalOperationNoStateProof(edge, operation, noState, sourceRef) {
  const resultRef = `${sourceRef}/resultSchema`;
  const effectRef = `${sourceRef}/sourceEffect`;
  const versionField = operation.contractVersion !== undefined ? "contractVersion" : "operationVersion";
  const versionRef = `${sourceRef}/${versionField}`;
  const finalityField = operation.sourceFinality !== undefined ? "sourceFinality" : "finality";
  const finalityRef = `${sourceRef}/${finalityField}`;
  const errorField = operation.errorSchemaRef !== undefined ? "errorSchemaRef" : "errorRef";
  const errorSourceRef = `${sourceRef}/${errorField}`;
  const recoveryField = operation.recovery !== undefined ? "recovery" : "failureRecovery";
  const recoveryRef = `${sourceRef}/${recoveryField}`;
  const authorityRef = `${sourceRef}/authorityRefs`;
  const schema = operation.resultSchema;
  if (!hasTypedResultSchema(schema)
    || operation.resultSchemaRef !== resultRef) {
    throw new Error(`${edge.id} canonical query proof must cite its exact typed result schema`);
  }
  const effect = String(operation.sourceEffect ?? operation.effectSemantics ?? "").toLowerCase()
    .replace(/do not mutate/g, "")
    .replace(/no mutation/g, "");
  if (!/(read|inspect|observe|navigate)/.test(effect)
    || /(write|mutat|submit|create|delete|transition|persist|effectful)/.test(effect)) {
    throw new Error(`${edge.id} canonical operation source does not prove an explicit read-only query`);
  }
  if (operation[versionField] === undefined || !operation.authorityRefs?.length
    || typeof operation[finalityField] !== "string" || !operation[finalityField].trim()
    || typeof operation[recoveryField] !== "string" || !operation[recoveryField].trim()
    || !operation[errorField]) {
    throw new Error(`${edge.id} canonical query source must define version, authority, finality, error, and recovery`);
  }
  const requiredSourceRefs = [sourceRef, effectRef, resultRef, versionRef, finalityRef, errorSourceRef, recoveryRef, authorityRef];
  if (!isNonemptyStrings(noState.sourceRefs) || requiredSourceRefs.some((ref) => !noState.sourceRefs.includes(ref))) {
    throw new Error(`${edge.id} canonical no-state proof must cite the exact operation source fields`);
  }
  if (noState.noEffectRef !== effectRef || noState.resultRef !== resultRef
    || noState.operationVersion !== operation[versionField]
    || !isNonemptyStrings(noState.authorityRefs) || operation.authorityRefs.some((ref) => !noState.authorityRefs.includes(ref))
    || !isNonemptyStrings(noState.versionRefs) || !noState.versionRefs.includes(versionRef)) {
    throw new Error(`${edge.id} canonical no-state proof must bind exact effect, result, authority, and version`);
  }
  const errorRef = operation[errorField];
  if (!isNonemptyStrings(noState.deniedUnknownRecoveryRefs)
    || !noState.deniedUnknownRecoveryRefs.includes(errorRef)
    || !noState.deniedUnknownRecoveryRefs.includes(recoveryRef)
    || !noState.deniedUnknownRecoveryRefs.includes(".product-experience/pdp-1-domain-data/action-contracts.yaml#outcomes/@id=UNKNOWN_OUTCOME")) {
    throw new Error(`${edge.id} canonical no-state proof must bind exact error, unknown, and recovery semantics`);
  }
  if (!isNonemptyStrings(noState.finalityRefs)
    || !noState.finalityRefs.includes(resultRef) || !noState.finalityRefs.includes(finalityRef)) {
    throw new Error(`${edge.id} canonical no-state proof must bind exact result and finality`);
  }
}

function assertNoTransitionTypedOperationResultProof(edge, operation, proof, { purposeById, journeyOperationBindings = [] }) {
  const binding = edge.p1OperationBindings.find((item) => item.operationRef === operation.id);
  const sourceRef = binding?.sourceRef;
  const body = proof.noP1MachineTransition;
  const purposes = proof.purposeBindingRefs.map((ref) => purposeById.get(ref.split("@id=")[1]?.split(/[&#]/)[0]));
  const resultRef = sourceRef && `${sourceRef}/resultSchema`;
  const versionField = operation.contractVersion !== undefined ? "contractVersion" : "operationVersion";
  const versionRef = sourceRef && `${sourceRef}/${versionField}`;
  const finalityField = operation.sourceFinality !== undefined ? "sourceFinality" : "finality";
  const finalityRef = sourceRef && `${sourceRef}/${finalityField}`;
  const recoveryField = operation.recovery !== undefined ? "recovery" : operation.failureRecovery !== undefined ? "failureRecovery" : "recoverySemantics";
  const recoveryRef = sourceRef && `${sourceRef}/${recoveryField}`;
  const errorsField = operation.errorSchemaRef !== undefined ? "errorSchemaRef" : operation.errors !== undefined ? "errors" : "errorRef";
  const errorsRef = sourceRef && `${sourceRef}/${errorsField}`;
  const authorityRef = sourceRef && `${sourceRef}/authorityRefs`;
  const transitionSources = purposes.flatMap((purpose, index) => {
    const purposeRef = proof.purposeBindingRefs[index];
    return [
      `${purposeRef}/transitionDisposition`,
      `${purposeRef}/stateRefs`,
      `${purposeRef}/transitionRefs`,
    ];
  });
  const canonicalPxd163Operation = [
    "media.operation.transcription-submission",
    "media.operation.caption-draft-write",
    "media.operation.caption-version-write",
  ].includes(operation.id);
  const isCanonicalOperationSource = sourceRef === `.product-experience/pdp-1-domain-data/operations.yaml#operations/@id=${operation.id}`;
  const canonicalJourneyOperationBinding = journeyOperationBindings.find((item) => item.operationRef === operation.id
    && item.operationDefinitionRef === sourceRef
    && item.wireSchemaRef === `${sourceRef}/ownerWireSchema`
    && item.operationKind === operation.operationKind
    && JSON.stringify(item.stateRefs ?? []) === JSON.stringify(operationStateRefs(operation))
    && (item.sourceEvidenceRefs ?? []).includes(sourceRef));
  const exactJourneyOperationBinding = Boolean(canonicalJourneyOperationBinding);
  if (!sourceRef || operation.operationKind !== "COMMAND" || operation.readOnly === true
    || operationStateRefs(operation).length !== 0 || operationTransitionRefs(operation).length !== 0
    || purposes.some((purpose) => !purpose || purpose.transitionDisposition?.status !== "NO_P1_MACHINE_TRANSITION"
      || purpose.transitionDisposition.transitionRef !== null
      || (purpose.stateRefs ?? []).length !== 0 || (purpose.transitionRefs ?? []).length !== 0
      || !(purpose.operationRefs ?? []).includes(operation.id)
      || (!(purpose.sourceRefs ?? []).includes(sourceRef) && !(canonicalPxd163Operation && isCanonicalOperationSource))
      || ((purpose.operationKinds ?? []).length > 0 && !purpose.operationKinds.includes("COMMAND")))) {
    throw new Error(`${edge.id} no-transition command proof requires an exact source-defined command purpose with no state or transition refs`);
  }
  if (canonicalPxd163Operation && (!isCanonicalOperationSource || !exactJourneyOperationBinding)) {
    throw new Error(`${edge.id} PXD-163 result proof requires the exact canonical operation and owner journey-operation binding`);
  }
  const effectText = `${operation.sourceEffect ?? ""} ${operation.effectSemantics ?? ""}`.toLowerCase();
  if (/(read.only|read-only|no.effect|no mutation|does not mutate|query only)/.test(effectText)) {
    throw new Error(`${edge.id} cannot classify a command/write operation as read-only`);
  }
  const resultSchema = canonicalPxd163Operation && isCanonicalOperationSource && exactJourneyOperationBinding
    ? operation.ownerWireSchema?.resultSchema
    : operation.resultSchema;
  if (!body || proof.stateRef || proof.observationRef || proof.noP1MachineState
    || !hasTypedResultSchema(resultSchema)) {
    throw new Error(`${edge.id} no-transition command proof requires its exact typed result and no state/observation selector`);
  }
  const sourceVersionField = operation.contractVersion !== undefined ? "contractVersion" : operation.operationVersion !== undefined ? "operationVersion" : "version";
  const sourceErrorField = operation.errorSchemaRef !== undefined ? "errorSchemaRef" : operation.errorRef !== undefined ? "errorRef" : operation.errors !== undefined ? "errors" : "error";
  const effectiveVersion = operation[sourceVersionField];
  const effectiveErrors = operation[sourceErrorField];
  if (effectiveVersion === undefined || effectiveErrors === undefined) {
    throw new Error(`${edge.id} no-transition command proof requires source-defined version and error semantics`);
  }
  for (const [name, value] of [["finality", operation[finalityField]], ["recovery", operation[recoveryField]]]) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`${edge.id} no-transition command proof requires source-defined ${name}`);
    }
  }
  const resultRefForProof = canonicalPxd163Operation ? `${sourceRef}/ownerWireSchema/resultSchema` : resultRef;
  const versionRefForProof = canonicalPxd163Operation ? `${sourceRef}/${sourceVersionField}` : versionRef;
  const finalityRefForProof = canonicalPxd163Operation ? `${sourceRef}/finality` : finalityRef;
  const recoveryRefForProof = canonicalPxd163Operation ? `${sourceRef}/recovery` : recoveryRef;
  const errorsRefForProof = canonicalPxd163Operation ? `${sourceRef}/${sourceErrorField}` : errorsRef;
  const bindingRefForProof = canonicalPxd163Operation ? `.product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedJourneyOperationBindings/records/@id=${canonicalJourneyOperationBinding.id}` : undefined;
  const authorityRefForProof = canonicalPxd163Operation ? `${bindingRefForProof}/authorityRefs` : authorityRef;
  const requiredSourceRefs = [sourceRef, resultRefForProof, versionRefForProof, finalityRefForProof, recoveryRefForProof, errorsRefForProof, authorityRefForProof, ...(canonicalPxd163Operation ? [bindingRefForProof, `${sourceRef}/ownerWireSchema`] : []), ...transitionSources];
  if (!isNonemptyStrings(body.sourceRefs) || requiredSourceRefs.some((ref) => !ref || !body.sourceRefs.includes(ref))) {
    throw new Error(`${edge.id} no-transition command proof must cite the exact operation, purpose, result, finality, error, recovery, authority, and version sources`);
  }
  if (body.operationResultRef !== resultRefForProof || body.operationVersion !== effectiveVersion
    || !isNonemptyStrings(body.versionRefs) || !body.versionRefs.includes(versionRefForProof)) {
    throw new Error(`${edge.id} no-transition command proof must bind the exact typed result and operation version`);
  }
  const authorityRefs = canonicalPxd163Operation ? canonicalJourneyOperationBinding?.authorityRefs : operation.authorityRefs;
  if (!isNonemptyStrings(authorityRefs) || !isNonemptyStrings(body.authorityRefs)
    || authorityRefs.some((ref) => !body.authorityRefs.includes(ref))) {
    throw new Error(`${edge.id} no-transition command proof must bind the exact operation authority set`);
  }
  const errorRef = operation.errorSchemaRef ?? operation.errorRef ?? (typeof effectiveErrors === "string" ? effectiveErrors : errorsRefForProof);
  if (!isNonemptyStrings(body.deniedUnknownRecoveryRefs)
    || !body.deniedUnknownRecoveryRefs.includes(errorRef)
    || !body.deniedUnknownRecoveryRefs.includes(recoveryRefForProof)
    || !body.deniedUnknownRecoveryRefs.includes(".product-experience/pdp-1-domain-data/action-contracts.yaml#outcomes/@id=UNKNOWN_OUTCOME")) {
    throw new Error(`${edge.id} no-transition command proof must bind exact error, unknown, and recovery semantics`);
  }
  if (!isNonemptyStrings(body.finalityRefs) || !body.finalityRefs.includes(resultRefForProof) || !body.finalityRefs.includes(finalityRefForProof)) {
    throw new Error(`${edge.id} no-transition command proof must bind its typed result and exact finality`);
  }
}

function hasTypedResultSchema(schema) {
  return schema !== null && typeof schema === "object"
    && Array.isArray(schema.required) && schema.required.length > 0
    && schema.properties !== null && typeof schema.properties === "object"
    && Object.keys(schema.properties).length > 0
    && schema.required.every((field) => typeof field === "string" && Object.hasOwn(schema.properties, field));
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
    if (!operationStateRefs(operation).length
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
    return purpose?.sourceRefs?.includes(observationRef)
      || purpose?.observationContractRefs?.includes(observationRef);
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
    if (!proof || proof.stepRef !== sourceStepRef || proof.actionRef !== (step.actionRef ?? action?.actionRef)
      || proof.disposition !== "LOCAL_SESSION_OR_DRAFT_EFFECT; NO_MEDIA_DOMAIN_TRANSITION"
      || action?.domainOperationDisposition !== "NO_DOMAIN_OPERATION_LOCAL_SELECTION_OR_SESSION_DRAFT"
      || action?.exactOperationRefs?.length !== 0
      || transition?.status !== proof.disposition || transition.transitionRef !== null
      || transition.stateRefs?.length !== 0 || transition.operationRef !== null
      || stepDefinition.canonicalBindings?.stateRefs?.length !== 0
      || stepDefinition.canonicalBindings?.canonicalOperationRef !== null
      || stepDefinition.canonicalBindings?.transitionRef !== null
      || !effectRef || proof.localEffectContractRef !== effectRef || !effect || effect.sourceRef !== sourceStepRef
      || effect.canonicalTransitionRef !== null
      || !Array.isArray(effect.canonicalDomainObjectRefs)
      || effect.canonicalDomainObjectRefs.some((ref) => typeof ref !== "string" || !ref.trim())
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
