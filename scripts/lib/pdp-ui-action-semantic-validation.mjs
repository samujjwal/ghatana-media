const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Validate exact PDP-3 local/draft semantic projections; no runtime behavior is implied. */
export function validatePdpUiLocalActionSemantics({ parity, actionRegistry }) {
  const errors = [];
  if (!isRecord(parity) || !Array.isArray(parity.typedUiActionSemantics)) return ["typedUiActionSemantics is required"];
  if (!isRecord(actionRegistry) || !Array.isArray(actionRegistry.actions)) return ["the historical PDP-3 actions collection is required"];

  const actions = new Map(actionRegistry.actions.map((row) => [row.id, row]));
  const entries = new Map((parity.typedUiActionDispositions?.entries ?? []).map((row) => [row.identity, row]));
  const seen = new Set();
  const localRows = [];
  for (const row of parity.typedUiActionSemantics) {
    if (!row?.identity || seen.has(row.identity)) {
      errors.push(`missing or duplicate action identity: ${row?.identity ?? "<empty>"}`);
      continue;
    }
    seen.add(row.identity);
    const source = actions.get(row.identity);
    if (!source) {
      // PXD-077 reconnect is an additive owner-defined action outside the immutable 146-row source collection.
      if (row.identity !== "media.action.request-live-session-reconnect") errors.push(`${row.identity}: exact action source is missing`);
      continue;
    }
    const semantics = row.actionDefinitionSemantics;
    if (JSON.stringify(semantics) !== JSON.stringify(source.actionDefinitionSemantics)) {
      errors.push(`${row.identity}: projected action semantics differ from the exact action-registry source`);
    }
    const typed = semantics?.typedDefinition;
    if (typed?.semanticRole !== "LOCAL_SELECTION_OR_SESSION_DRAFT") continue;
    localRows.push(row);
    const envelope = semantics.sourceEnvelope;
    if (!isRecord(typed) || !isRecord(envelope)) {
      errors.push(`${row.identity}: local/draft semantic definition and source envelope are required`);
      continue;
    }
    if (semantics.actionRef !== row.identity || source.actionDefinitionSemantics?.actionRef !== row.identity) {
      errors.push(`${row.identity}: local action identity must match the source record`);
    }
    if (envelope.effect !== source.effect || envelope.finality !== source.finality || envelope.reversible !== source.reversible) {
      errors.push(`${row.identity}: local effect, finality, and reversibility must match the exact source`);
    }
    if (typed.effect !== source.effect || typed.finality !== source.finality || typed.sourceReversibleValue !== source.reversible) {
      errors.push(`${row.identity}: typed local effect/finality/reversibility contradicts the source action`);
    }
    if (typed.domainOperationDisposition !== "NO_DOMAIN_OPERATION_LOCAL_SELECTION_OR_SESSION_DRAFT"
      || !Array.isArray(typed.exactOperationRefs) || typed.exactOperationRefs.length !== 0
      || typed.operationRef !== null || (typed.orderedOperationRefs?.length ?? 0) !== 0) {
      errors.push(`${row.identity}: local selection/draft cannot imply a domain operation`);
    }
    if (!Array.isArray(typed.actorRefs) || typed.actorRefs.length === 0
      || !Array.isArray(typed.applicabilityGuards) || typed.applicabilityGuards.length === 0
      || typeof typed.failureRecovery !== "string" || !typed.failureRecovery.trim()) {
      errors.push(`${row.identity}: local/draft action needs actors, applicability guards, and a failure disposition`);
    }
    if (!/^(?:local|playback|view)(?:-|;|$)/u.test(typed.finality ?? "")) {
      errors.push(`${row.identity}: local/draft action finality must stay local, playback-only, or view-only`);
    }
    const disposition = entries.get(row.identity)?.type;
    if (!new Set(["CLIENT_ONLY", "NAVIGATION_OR_PRESENTATION"]).has(disposition)) {
      errors.push(`${row.identity}: local/draft action cannot be classified as a domain operation`);
    }
  }

  const clientOnly = [...entries.values()].filter((row) => row.type === "CLIENT_ONLY");
  const nonClientLocal = localRows.filter((row) => entries.get(row.identity)?.type !== "CLIENT_ONLY").map((row) => row.identity);
  if (localRows.length !== 49) errors.push(`expected 49 local/draft action semantics, found ${localRows.length}`);
  if (clientOnly.length !== 48) errors.push(`expected 48 CLIENT_ONLY dispositions, found ${clientOnly.length}`);
  if (JSON.stringify(nonClientLocal) !== JSON.stringify(["media.action.switch-measurement-presentation"])) {
    errors.push("local/draft semantic scope and CLIENT_ONLY allowlist must preserve only the explicit measurement-presentation distinction");
  }
  return errors;
}

const CANDIDATE_OPERATION_BINDINGS = Object.freeze({
  "media.action.begin-artifact-upload": ["media.operation-slice.begin-upload"],
  "media.action.resume-artifact-upload": ["media.operation-slice.inspect-upload", "media.operation-slice.append-upload-chunk", "media.operation-slice.complete-upload"],
  "media.action.inspect-artifact": ["media.operation-slice.inspect-artifact"],
  "media.action.attach-source-asset": ["media.operation-slice.attach-source-asset"],
  "media.action.view-job-status": ["media.operation.action.view-job-status"],
  "media.action.check-job-outcome": ["media.operation.action.check-job-outcome"],
  "media.action.request-cancellation": ["media.operation-slice.cancel-job"],
  "media.action.retry-job": ["media.operation-slice.retry-job"],
  "media.action.request-transcription": ["media.operation.transcription-submission"],
  "media.action.review-transcript": ["media.operation.transcript-version-read"],
  "media.action.correct-caption": ["media.operation.caption-draft-write"],
  "media.action.align-caption-timing": ["media.operation.caption-draft-write"],
  "media.action.save-caption-version": ["media.operation.caption-version-write"],
  "media.action.compare-caption-versions": ["media.operation.caption-version-read"],
});

function operationRequestAndResult(operation) {
  if (operation.ownerWireSchema?.requestSchema && operation.ownerWireSchema?.resultSchema) {
    return { request: operation.ownerWireSchema.requestSchema, result: operation.ownerWireSchema.resultSchema };
  }
  if (operation.requestSchema && operation.resultSchema) return { request: operation.requestSchema, result: operation.resultSchema };
  if (operation.inputSemantics && Object.keys(operation.inputSemantics).length > 0
    && operation.outputSemantics && Object.keys(operation.outputSemantics).length > 0) {
    return { request: operation.inputSemantics, result: operation.outputSemantics };
  }
  if (operation.id === "media.operation-slice.inspect-artifact"
    && operation.requestFields?.length && operation.outcomes?.success && operation.outcomes?.unknownOutcome && operation.readSemantics) {
    return { request: operation.requestFields, result: operation.readSemantics };
  }
  return undefined;
}

/** Verify the exact current owner-definition selections without claiming wire parity. */
export function validatePdpUiCandidateOperationBindings({ parity, operations }) {
  const errors = [];
  const semanticRows = new Map((parity?.typedUiActionSemantics ?? []).map((row) => [row.identity, row]));
  const allOperations = [
    ...(operations?.operations ?? []),
    ...(operations?.individualOperationContracts?.records ?? []),
    ...(operations?.ownerDefinedOperationContracts?.records ?? []),
    ...(operations?.capabilityOperationContracts?.records ?? []),
  ];
  const operationById = new Map(allOperations.map((operation) => [operation.id, operation]));

  for (const [actionId, expectedRefs] of Object.entries(CANDIDATE_OPERATION_BINDINGS)) {
    const action = semanticRows.get(actionId);
    if (!action) {
      errors.push(`${actionId}: current action meaning is missing`);
      continue;
    }
    const typed = action.actionDefinitionSemantics?.typedDefinition;
    const expectedRole = actionId === "media.action.resume-artifact-upload" ? "ORDERED_DOMAIN_WORKFLOW" : "DOMAIN_OPERATION";
    if (typed?.semanticRole !== expectedRole || JSON.stringify(typed.exactOperationRefs) !== JSON.stringify(expectedRefs)) {
      errors.push(`${actionId}: exact owner operation sequence is missing or substituted`);
    }
    if (typed?.operationRef !== (expectedRefs.length === 1 ? expectedRefs[0] : null)) {
      errors.push(`${actionId}: singleton operationRef does not match the exact operation sequence`);
    }
    if (typed?.runtimeAdmission !== "NOT_ADMITTED") errors.push(`${actionId}: definition mapping cannot imply runtime admission`);
    if (!action.actionDefinitionSemantics?.sourceEnvelope?.effect
      || !action.actionDefinitionSemantics?.sourceEnvelope?.finality
      || !action.actionDefinitionSemantics?.sourceEnvelope?.failure) {
      errors.push(`${actionId}: source action effect, finality, and failure disposition are required`);
    }
    for (const ref of expectedRefs) {
      const operation = operationById.get(ref);
      if (!operation) {
        errors.push(`${actionId}: exact owner operation ${ref} does not resolve`);
        continue;
      }
      if (!operation.operationKind && !operation.ownerWireSchema?.operationKind) errors.push(`${ref}: query/command kind is missing`);
      if (!operationRequestAndResult(operation)) errors.push(`${ref}: request/input or result/output semantics are missing`);
      if (ref === "media.operation.transcript-version-read") {
        const required = operation.outputSemantics?.requiredFields ?? [];
        for (const field of ["transcriptVersionId", "sourceArtifactId", "sourceArtifactVersionId", "uncertaintyAvailability", "timingAvailability", "observedAt"]) {
          if (!required.includes(field)) errors.push(`${ref}: output semantics omit ${field}`);
        }
      }
      if (ref === "media.operation.caption-version-read") {
        const input = operation.inputSemantics?.selectorBranches;
        const output = operation.outputSemantics?.EXACT_PAIR;
        if (!input?.EXACT_PAIR?.requiredFields?.includes("leftCaptionVersionId")
          || !input?.EXACT_PAIR?.requiredFields?.includes("rightCaptionVersionId")
          || !input?.REGISTRATION_REQUEST?.requiredFields?.includes("requestFingerprint")) {
          errors.push(`${ref}: both exact-pair and same-request receipt selectors must be defined`);
        }
        if (!output?.requiredFields?.includes("comparability") || !output?.requiredFields?.includes("segmentDifferences")) {
          errors.push(`${ref}: exact-pair result must disclose comparability and typed differences`);
        }
      }
      if (ref === "media.operation-slice.inspect-artifact") {
        const response = parity.typedHttpOperationContracts?.find((row) => row.canonicalOperationRef === ref && row.identity === "getMediaArtifact");
        if (!response || !response.responseContracts?.some((contract) => contract.status === "200" && contract.schemaRefs?.includes("#/components/schemas/MediaArtifact"))) {
          errors.push(`${ref}: exact getMediaArtifact response schema must remain the bounded read adapter source`);
        }
      }
      const detailedOwner = Array.isArray(operation.actionRefs) || operation.inputSemantics || operation.requestSchema;
      if (detailedOwner && !operation.authority && !operation.authorityRefs && !operation.authorization) errors.push(`${ref}: authority semantics are missing`);
      if (detailedOwner && !operation.finality && !operation.sourceFinality && !operation.commitFinality && !operation.resultSchema?.finality) errors.push(`${ref}: finality semantics are missing`);
      if (detailedOwner && !operation.error && !operation.errors && !operation.negativeCases && !operation.errorSchemaRef) errors.push(`${ref}: error/negative semantics are missing`);
      if (detailedOwner && !operation.unknownOutcome && !operation.outcomes?.unknownOutcome && !operation.resultSchema?.unknownOutcome && !operation.ownerWireSchema?.ownerDefinition?.unknownOutcome) errors.push(`${ref}: unknown-outcome semantics are missing`);
      if (detailedOwner && !Object.hasOwn(operation, "sourceRecovery") && !Object.hasOwn(operation, "recoverySemantics")
        && !Object.hasOwn(operation, "recovery") && !operation.failure && !operation.ownerWireSchema?.ownerDefinition?.failureRecovery) errors.push(`${ref}: recovery semantics are missing`);
    }
  }
  return errors;
}
