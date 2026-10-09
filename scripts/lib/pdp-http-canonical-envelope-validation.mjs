const HOST_CONTEXT_FIELDS = ["tenantId", "principalId", "authorityRef"];

function nonemptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sameHostTuple(asserted, attested) {
  return HOST_CONTEXT_FIELDS.every((field) => nonemptyString(attested?.[field])
    && asserted?.[field] === attested[field]);
}

function matchesRepeatedFacts(value, expected) {
  for (const [key, target] of Object.entries(expected)) {
    if (Object.hasOwn(value ?? {}, key) && value[key] !== target) return false;
  }
  return true;
}

/**
 * Definition-level boundary used before a Media HTTP adapter may read or act.
 * The envelope carries assertions; the returned host context always comes from
 * the independent host-authentication input.
 */
export function validateCanonicalHttpRequestBoundary({
  envelope,
  hostAttestedContext,
  validateEnvelope,
  validateOwnerRequest,
  expectedOperationRef,
  expectedOperationVersion = 1,
}) {
  if (typeof validateEnvelope !== "function" || !validateEnvelope(envelope)) {
    return { ok: false, reason: "INVALID_CLOSED_ENVELOPE" };
  }
  if (typeof validateOwnerRequest !== "function" || !validateOwnerRequest(envelope.ownerRequest)) {
    return { ok: false, reason: "INVALID_OWNER_REQUEST" };
  }
  if (envelope.operationRef !== expectedOperationRef
      || envelope.operationVersion !== expectedOperationVersion) {
    return { ok: false, reason: "OPERATION_IDENTITY_MISMATCH" };
  }
  if (!sameHostTuple(envelope.trustedContext, hostAttestedContext)) {
    return { ok: false, reason: "HOST_CONTEXT_MISMATCH" };
  }
  const requestBindings = {
    ...hostAttestedContext,
    operationRef: expectedOperationRef,
    operationVersion: expectedOperationVersion,
    requestId: envelope.requestId,
  };
  if (!matchesRepeatedFacts(envelope.ownerRequest, requestBindings)) {
    return { ok: false, reason: "OWNER_REQUEST_BINDING_MISMATCH" };
  }
  if (!nonemptyString(envelope.requestId)) {
    return { ok: false, reason: "REQUEST_ID_REQUIRED" };
  }

  return {
    ok: true,
    operationRef: expectedOperationRef,
    operationVersion: expectedOperationVersion,
    requestId: envelope.requestId,
    ownerRequest: structuredClone(envelope.ownerRequest),
    hostContext: structuredClone(hostAttestedContext),
  };
}

/** Check repeated owner-result identities against the canonical outer receipt. */
export function validateCanonicalHttpResultBoundary({
  envelope,
  hostAttestedContext,
  validateEnvelope,
  validateOwnerResult,
  expectedOperationRef,
  expectedOperationVersion = 1,
  resultOutcomeBinding,
}) {
  if (typeof validateEnvelope !== "function" || !validateEnvelope(envelope)) {
    return { ok: false, reason: "INVALID_CLOSED_ENVELOPE" };
  }
  if (typeof validateOwnerResult !== "function" || !validateOwnerResult(envelope.ownerResult)) {
    return { ok: false, reason: "INVALID_OWNER_RESULT" };
  }
  if (envelope.operationRef !== expectedOperationRef || envelope.operationVersion !== expectedOperationVersion) {
    return { ok: false, reason: "OPERATION_IDENTITY_MISMATCH" };
  }
  const resultBindings = {
    operationRef: expectedOperationRef,
    operationVersion: expectedOperationVersion,
    observedAt: envelope.observedAt,
    authorityRef: envelope.authorityRef,
    ...(hostAttestedContext ?? {}),
  };
  if (!matchesRepeatedFacts(envelope.ownerResult, resultBindings)) {
    return { ok: false, reason: "OWNER_RESULT_BINDING_MISMATCH" };
  }
  const ownerOutcomes = Object.hasOwn(envelope.ownerResult ?? {}, "outcome") ? [envelope.ownerResult.outcome] : [];
  if (resultOutcomeBinding?.ownerOutcomeField === "outcome") {
    const allowed = resultOutcomeBinding.outerToOwnerValues?.[envelope.outcome];
    if (!Array.isArray(allowed) || ownerOutcomes.length === 0 || ownerOutcomes.some((value) => !allowed.includes(value))) {
      return { ok: false, reason: "OWNER_RESULT_OUTCOME_BINDING_MISMATCH" };
    }
  } else if (resultOutcomeBinding?.ownerOutcomeField === null) {
    if (ownerOutcomes.length !== 0 || resultOutcomeBinding.outerOutcomeSemantics !== "ADAPTER_OBSERVATION_ONLY_NO_OWNER_OUTCOME_FIELD") {
      return { ok: false, reason: "OWNER_RESULT_OUTCOME_BINDING_MISMATCH" };
    }
  } else {
    return { ok: false, reason: "OWNER_RESULT_OUTCOME_BINDING_UNDEFINED" };
  }
  return { ok: true, ownerResult: structuredClone(envelope.ownerResult) };
}

function resolveSchemaProperty(schema, pathParts) {
  let current = schema;
  for (const part of pathParts) {
    current = current?.properties?.[part];
    if (!current) return false;
  }
  return true;
}

function collectProjectionLeaves(value, path = "sourceProjection") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  if (Object.hasOwn(value, "canonical")) return [{ value, path }];
  return Object.entries(value).flatMap(([key, child]) => collectProjectionLeaves(child, `${path}.${key}`));
}

/** Verify every positive projection names a field in its exact bound schema. */
export function canonicalProjectionTargetErrors(record, requestSchema, envelopeRequestSchema) {
  return collectProjectionLeaves(record.sourceProjection).flatMap(({ value, path }) => {
    if (value.canonical === null) {
      const explicitReject = /^(?:REJECT_|HOST_AUTHORITY_CONTEXT_REQUIRED|NEVER_SELECT_)/u.test(value.disposition ?? "");
      return explicitReject ? [] : [`${path}: null target lacks an explicit reject/host-only disposition`];
    }
    if (typeof value.canonical !== "string") return [`${path}: canonical target is not a string or explicit null`];
    const match = value.canonical.match(/^(ownerRequest|trustedContext)\.([A-Za-z0-9_.-]+)$/u);
    if (!match) return [`${path}: canonical target must use an exact ownerRequest/trustedContext path`];
    const schema = match[1] === "ownerRequest" ? requestSchema : envelopeRequestSchema;
    const parts = match[1] === "ownerRequest"
      ? match[2].split(".")
      : ["trustedContext", ...match[2].split(".")];
    return resolveSchemaProperty(schema, parts) ? [] : [`${path}: ${value.canonical} does not resolve in its bound schema`];
  });
}
