const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const plainRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
  Reflect.ownKeys(value).every((key) => typeof key === "string" && Object.getOwnPropertyDescriptor(value, key)?.enumerable &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value"));
const exactKeys = (value, keys) => plainRecord(value) &&
  Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const nonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;
const canonicalInstant = (value) => {
  if (typeof value !== "string" || !ISO_UTC.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};

const FACT_KEYS = ["viewRef", "operationRef", "query"];
const QUERY_KEYS = ["tenantId", "principalId", "workspaceId", "queryId", "rows", "nextPageToken", "observedAt", "readVersion", "readAuthorityRef"];
const TRUSTED_KEYS = ["viewRef", "operationRef", "tenantId", "principalId", "workspaceId", "queryId", "readVersion", "readAuthorityRef", "now", "maxAgeMs"];
const PROJECT_ROW_KEYS = ["projectId", "workspaceId", "title", "headRevisionId", "projectState"];
const ACTIVITY_FACT_KEYS = ["viewRef", "actionRef", "operationRef", "requestId", "activityState", "localStartedAt"];
const ACTIVITY_TRUSTED_KEYS = ["viewRef", "actionRef", "operationRef", "requestId", "now", "maxAgeMs"];
const STALENESS_FACT_KEYS = ["viewRef", "operationRef", "objectRef", "snapshotVersionRef", "observedAt"];
const STALENESS_TRUSTED_KEYS = ["viewRef", "operationRef", "objectRef", "currentVersionRef", "now", "maxAgeMs"];
const JOB_FACT_KEYS = ["viewRef", "queryResult"];
const JOB_RESULT_KEYS = ["outcome", "operationRef", "operationVersion", "tenantId", "principalId", "job", "readObservation"];
const JOB_KEYS = ["jobId", "requestId", "tenantId", "principalId", "artifactId", "jobType", "providerId", "status", "createdAt", "startedAt", "completedAt", "result", "failureCode", "version", "requestFingerprint"];
const JOB_READ_KEYS = ["tenantId", "principalId", "readVersion", "observedAt", "readAuthorityRef", "effectFinality", "canonicalStateMapping"];
const JOB_MAPPING_KEYS = ["sourceStatus", "disposition", "reason", "canonicalStateRef"];
const JOB_STATUS = ["ACCEPTED", "RUNNING", "OUTCOME_UNKNOWN", "COMPLETED", "FAILED", "CANCELLED"];
const JOB_FINALITY = ["NOT_TERMINAL", "EFFECT_MAY_BE_ACTIVE", "OUTCOME_UNKNOWN", "OUTPUT_REGISTRATION_UNVERIFIED", "CONTINUATION_FINALITY_UNVERIFIED", "CANCELLATION_EFFECTS_UNFENCED"];
const JOB_TRUSTED_KEYS = ["viewRef", "operationRef", "tenantId", "principalId", "jobId", "requestId", "requestFingerprint", "readVersion", "readAuthorityRef", "now", "maxAgeMs"];
const ARTIFACT_FACT_KEYS = ["viewRef", "queryResult"];
const ARTIFACT_TRUSTED_KEYS = ["viewRef", "operationRef", "tenantId", "principalId", "artifactId", "artifactVersionId", "stateRevision", "readVersion", "stateAuthorityRef", "stateEvidenceRef", "now", "maxAgeMs"];
const ARTIFACT_RESULT_KEYS = ["operationRef", "outcome", "observedAt", "observation", "unknownReason"];
const ARTIFACT_OBSERVATION_KEYS = ["artifactId", "artifactVersionId", "lifecycleState", "canonicalStateRef", "meaningSourceRef", "tenantId", "principalId", "stateRevision", "observedAt", "stateAuthorityRef", "stateEvidenceRef", "readVersion"];
const ARTIFACT_LIFECYCLE_STATES = ["RECEIVING", "VERIFYING", "AVAILABLE", "QUARANTINED", "REJECTED", "EXPIRED", "ERASURE_REQUESTED", "ACCESS_REVOKED", "PHYSICAL_ERASURE_PENDING", "BLOCKED_BY_HOLD", "ERASURE_CONFIRMED", "EXTERNAL_ERASURE_UNCONFIRMED"];
const ARTIFACT_UNKNOWN_REASONS = ["AUTHORITATIVE_LIFECYCLE_READ_NOT_IMPLEMENTED", "READ_MODEL_DOES_NOT_EXPOSE_LIFECYCLE_STATE", "EXACT_VERSION_NOT_CURRENTLY_OBSERVABLE", "STATE_REVISION_OR_EVIDENCE_MISSING", "READ_AUTHORITY_UNAVAILABLE", "SCOPED_NOT_FOUND", "READ_UNAVAILABLE"];
const ARTIFACT_STATE_AUTHORITY_REF = ".product-experience/pdp-1-domain-data/states.yaml#stateMachines/media-upload-and-artifact";
const CONNECTIVITY_FACT_KEYS = ["viewRef", "clientInstanceRef", "observationId", "reportedState", "observedAt"];
const CONNECTIVITY_TRUSTED_KEYS = ["viewRef", "clientInstanceRef", "now", "maxAgeMs"];
const JOB_MAPPING_REASONS = {
  ACCEPTED: "OpenAPI and runtime contracts state ACCEPTED does not establish durable queueing; PDP-1 QUEUED requires durable registration and no executing attempt.",
  RUNNING: "The stored status has no fenced current attempt or admitted-stage evidence; PDP-1 RUNNING requires a current fenced attempt executing an admitted stage.",
  OUTCOME_UNKNOWN: "Both source and PDP-1 explicitly preserve uncertainty that an external effect may have occurred without a known result; this does not establish completion, failure, replay safety, or provider reconciliation.",
  COMPLETED: "The stored response does not establish verified outputs are registered and satisfy the accepted result contract required by PDP-1 COMPLETED.",
  FAILED: "The stored response does not establish that no eligible continuation remains or that failure truth is persisted as required by PDP-1 FAILED.",
  CANCELLED: "The stored response does not establish cancellation finality for every effect that could still mutate the job, as required by PDP-1 CANCELLED.",
};
const JOB_FINALITY_BY_STATUS = {
  ACCEPTED: "NOT_TERMINAL", RUNNING: "EFFECT_MAY_BE_ACTIVE", OUTCOME_UNKNOWN: "OUTCOME_UNKNOWN",
  COMPLETED: "OUTPUT_REGISTRATION_UNVERIFIED", FAILED: "CONTINUATION_FINALITY_UNVERIFIED",
  CANCELLED: "CANCELLATION_EFFECTS_UNFENCED",
};

function validProjectRow(row, trusted) {
  if (!exactKeys(row, PROJECT_ROW_KEYS)) return false;
  return nonEmptyString(row.projectId) && row.workspaceId === trusted.workspaceId &&
    nonEmptyString(row.title) && nonEmptyString(row.headRevisionId) &&
    ["ACTIVE", "ARCHIVED"].includes(row.projectState);
}

/**
 * Definition-only evaluator for the owner-defined project-list read model.
 * `trusted` represents context established outside the returned query. This
 * does not validate that the host actually established that context.
 */
export function evaluateScopedMediaQuery(predicate, fact, trusted) {
  const unknown = (reason) => ({ truth: "UNKNOWN", reason });
  if (!plainRecord(predicate) || !plainRecord(predicate.factScope) || !plainRecord(predicate.queryPredicate) ||
      !exactKeys(fact, FACT_KEYS) || !exactKeys(trusted, TRUSTED_KEYS)) return unknown("MALFORMED_OR_NONCLOSED_QUERY_INPUT");
  if (!["LOCAL_QUERY", "LOCAL_QUERY_EMPTY"].includes(predicate.factKind) ||
      !["NONEMPTY", "EMPTY_COMPLETE_QUERY", "EMPTY_SCOPED_PAGE"].includes(predicate.queryPredicate.kind) ||
      typeof predicate.viewRef !== "string" || !Array.isArray(predicate.factScope.operationRefs) ||
      !predicate.factScope.operationRefs.includes("media.operation-slice.list-projects")) {
    return unknown("UNSUPPORTED_QUERY_DEFINITION");
  }
  if (fact.viewRef !== predicate.viewRef || trusted.viewRef !== predicate.viewRef) return unknown("VIEW_SCOPE_MISMATCH");
  if (fact.operationRef !== "media.operation-slice.list-projects" || trusted.operationRef !== fact.operationRef) {
    return unknown("QUERY_OPERATION_SCOPE_MISMATCH");
  }
  for (const key of ["tenantId", "principalId", "workspaceId", "queryId", "readVersion", "readAuthorityRef"]) {
    if (!nonEmptyString(trusted[key])) return unknown("TRUSTED_QUERY_CONTEXT_MISSING");
  }
  const query = fact.query;
  if (!exactKeys(query, QUERY_KEYS)) return unknown("QUERY_RESULT_SCHEMA_INVALID");
  for (const key of ["tenantId", "principalId", "workspaceId", "queryId", "readVersion", "readAuthorityRef"]) {
    if (query[key] !== trusted[key]) return unknown("QUERY_RESULT_CONTEXT_MISMATCH");
  }
  if (query.readAuthorityRef !== ".product-experience/pdp-1-domain-data/authority.yaml#ownership.identityAuthenticationAndDelegation" &&
      query.readAuthorityRef !== ".product-experience/pdp-0-product-truth/policy-authority-model.yaml#productPolicy") {
    return unknown("QUERY_READ_AUTHORITY_UNBOUND");
  }
  if (!Array.isArray(query.rows) ||
      !(query.nextPageToken === null || nonEmptyString(query.nextPageToken)) ||
      !canonicalInstant(query.observedAt)) return unknown("QUERY_RESULT_INCOMPLETE_OR_INVALID");
  if (query.rows.some((row) => !validProjectRow(row, trusted))) return unknown("QUERY_ROW_SCHEMA_OR_SCOPE_INVALID");
  if (new Set(query.rows.map((row) => row.projectId)).size !== query.rows.length) return unknown("QUERY_ROW_IDENTITY_DUPLICATED");
  if (!canonicalInstant(trusted.now) || !Number.isSafeInteger(trusted.maxAgeMs) || trusted.maxAgeMs < 0) {
    return unknown("TRUSTED_FRESHNESS_POLICY_MISSING");
  }
  const age = Date.parse(trusted.now) - Date.parse(query.observedAt);
  if (age < 0 || age > trusted.maxAgeMs) return unknown("QUERY_RESULT_STALE_OR_FUTURE_DATED");

  const count = query.rows.length;
  if (predicate.queryPredicate.kind === "NONEMPTY") {
    return { truth: count > 0 ? "TRUE" : "FALSE", reason: "SCOPED_PROJECT_QUERY_ROW_COUNT", rowCount: count };
  }
  if (predicate.queryPredicate.kind === "EMPTY_SCOPED_PAGE") {
    return { truth: count === 0 ? "TRUE" : "FALSE", reason: "SCOPED_QUERY_PAGE_ROW_COUNT", rowCount: count };
  }
  if (count > 0) return { truth: "FALSE", reason: "COMPLETE_SCOPED_PROJECT_QUERY_HAS_ROWS", rowCount: count };
  if (query.nextPageToken !== null) return unknown("EMPTY_PAGE_DOES_NOT_ESTABLISH_COMPLETE_QUERY_ABSENCE");
  return { truth: "TRUE", reason: "COMPLETE_SCOPED_PROJECT_QUERY_EMPTY", rowCount: 0 };
}

/** Classify a request-local pending indicator without claiming server finality. */
export function evaluateLocalRequestActivity(predicate, fact, trusted) {
  const unknown = (reason) => ({ truth: "UNKNOWN", reason });
  if (!plainRecord(predicate) || !plainRecord(predicate.factScope) ||
      !exactKeys(fact, ACTIVITY_FACT_KEYS) || !exactKeys(trusted, ACTIVITY_TRUSTED_KEYS)) return unknown("MALFORMED_OR_NONCLOSED_ACTIVITY_INPUT");
  const allowedOperations = predicate.factScope.operationRefs;
  const allowedActions = predicate.factScope.actionRefs;
  if (predicate.factKind !== "LOCAL_INFLIGHT" || predicate.factPath !== "local.operation.disposition" ||
      !Array.isArray(allowedOperations) || allowedOperations.length === 0 ||
      !Array.isArray(allowedActions) || typeof predicate.viewRef !== "string") return unknown("UNSUPPORTED_LOCAL_ACTIVITY_DEFINITION");
  if (fact.viewRef !== predicate.viewRef || trusted.viewRef !== predicate.viewRef) return unknown("VIEW_SCOPE_MISMATCH");
  if (!allowedOperations.includes(fact.operationRef) || fact.operationRef !== trusted.operationRef ||
      (allowedActions.length > 0 && (!allowedActions.includes(fact.actionRef) || fact.actionRef !== trusted.actionRef)) ||
      (allowedActions.length === 0 && fact.actionRef !== trusted.actionRef)) return unknown("REQUEST_ACTION_OR_OPERATION_SCOPE_MISMATCH");
  if (!nonEmptyString(fact.requestId) || fact.requestId !== trusted.requestId ||
      !canonicalInstant(fact.localStartedAt) || !canonicalInstant(trusted.now) ||
      !Number.isSafeInteger(trusted.maxAgeMs) || trusted.maxAgeMs < 0) return unknown("REQUEST_IDENTITY_OR_FRESHNESS_MISSING");
  const age = Date.parse(trusted.now) - Date.parse(fact.localStartedAt);
  if (age < 0 || age > trusted.maxAgeMs) return unknown("LOCAL_ACTIVITY_STALE_OR_FUTURE_DATED");
  if (fact.activityState === "REQUEST_PENDING") return { truth: "TRUE", reason: "EXACT_LOCAL_REQUEST_PENDING", remoteFinality: "NOT_ASSERTED" };
  if (fact.activityState === "SETTLED") return { truth: "FALSE", reason: "EXACT_LOCAL_REQUEST_NOT_PENDING", remoteFinality: "NOT_ASSERTED" };
  return unknown("LOCAL_REQUEST_ACTIVITY_UNKNOWN");
}

/** Evaluate a client-local network availability signal without inferring remote service state. */
export function evaluateLocalConnectivity(predicate, fact, trusted) {
  const unknown = (reason) => ({ truth: "UNKNOWN", reason, remoteServiceState: "NOT_ASSERTED" });
  if (!plainRecord(predicate) || !plainRecord(predicate.connectivityObservation) ||
      !exactKeys(fact, CONNECTIVITY_FACT_KEYS) || !exactKeys(trusted, CONNECTIVITY_TRUSTED_KEYS)) {
    return unknown("MALFORMED_OR_NONCLOSED_CONNECTIVITY_INPUT");
  }
  if (predicate.id !== predicate.predicateId || predicate.factKind !== "LOCAL_CONNECTIVITY" ||
      predicate.factPath !== "local.connectivity" ||
      predicate.factSchemaRef !== ".product-experience/pdp-3-product-experience/view-observation-input-contracts.yaml#factSchemas.media.view-observation-schema.local-connectivity.v1" ||
      predicate.connectivityObservation.expectedReportedState !== "CLIENT_NETWORK_UNAVAILABLE" ||
      predicate.connectivityObservation.nonClaim !== "This does not establish remote service, provider, or in-flight operation status.") {
    return unknown("CONNECTIVITY_DEFINITION_UNSUPPORTED_OR_DRIFTED");
  }
  if (fact.viewRef !== predicate.viewRef || trusted.viewRef !== predicate.viewRef ||
      !nonEmptyString(trusted.clientInstanceRef) || fact.clientInstanceRef !== trusted.clientInstanceRef ||
      !nonEmptyString(fact.observationId)) return unknown("CONNECTIVITY_VIEW_OR_CLIENT_SCOPE_MISMATCH");
  if (!canonicalInstant(fact.observedAt) || !canonicalInstant(trusted.now) ||
      !Number.isSafeInteger(trusted.maxAgeMs) || trusted.maxAgeMs < 0) return unknown("CONNECTIVITY_FRESHNESS_POLICY_INVALID");
  const age = Date.parse(trusted.now) - Date.parse(fact.observedAt);
  if (age < 0 || age > trusted.maxAgeMs) return unknown("CONNECTIVITY_SIGNAL_STALE_OR_FUTURE_DATED");
  if (fact.reportedState === "UNKNOWN") return unknown("CLIENT_CONNECTIVITY_SIGNAL_UNKNOWN");
  if (!["CLIENT_NETWORK_AVAILABLE", "CLIENT_NETWORK_UNAVAILABLE"].includes(fact.reportedState)) return unknown("CLIENT_CONNECTIVITY_SIGNAL_INVALID");
  return fact.reportedState === predicate.connectivityObservation.expectedReportedState
    ? { truth: "TRUE", reason: "EXACT_FRESH_CLIENT_NETWORK_UNAVAILABLE_SIGNAL", remoteServiceState: "NOT_ASSERTED" }
    : { truth: "FALSE", reason: "CLIENT_NETWORK_IS_REPORTED_AVAILABLE", remoteServiceState: "NOT_ASSERTED" };
}

const DRAFT_FACT_KEYS = ["viewRef", "sessionId", "draftId", "draftRevision", "baseVersionRef", "draftValue", "baseValue", "observedAt"];
const DRAFT_TRUSTED_KEYS = ["viewRef", "sessionId", "draftId", "baseVersionRef", "now", "maxAgeMs"];
function isJsonValue(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  if (!Array.isArray(value) && !plainRecord(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : Object.keys(value).every((key) => isJsonValue(value[key], seen));
  seen.delete(value);
  return valid;
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (plainRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Compare an exact local draft snapshot with its exact base; no persisted write is implied. */
export function evaluateLocalDraftSnapshot(predicate, fact, trusted) {
  const unknown = (reason) => ({ truth: "UNKNOWN", reason });
  if (!plainRecord(predicate) || !plainRecord(predicate.draftObservation) ||
      !exactKeys(fact, DRAFT_FACT_KEYS) || !exactKeys(trusted, DRAFT_TRUSTED_KEYS)) return unknown("MALFORMED_OR_NONCLOSED_DRAFT_INPUT");
  const expected = predicate.factKind === "LOCAL_DRAFT" ? "DIFFERENT" :
    predicate.factKind === "LOCAL_DRAFT_CLEAN" ? "EQUAL" : null;
  if (!expected || predicate.draftObservation.expectedStructuralRelation !== expected ||
      predicate.draftObservation.comparison !== "CANONICAL_JSON_STRUCTURAL_EQUALITY") return unknown("UNSUPPORTED_DRAFT_PREDICATE");
  if (fact.viewRef !== predicate.viewRef || trusted.viewRef !== predicate.viewRef ||
      fact.sessionId !== trusted.sessionId || fact.draftId !== trusted.draftId ||
      fact.baseVersionRef !== trusted.baseVersionRef || !nonEmptyString(fact.sessionId) ||
      !nonEmptyString(fact.draftId) || !nonEmptyString(fact.baseVersionRef)) return unknown("DRAFT_VIEW_SESSION_OR_BASE_SCOPE_MISMATCH");
  if (!Number.isSafeInteger(fact.draftRevision) || fact.draftRevision < 1 ||
      !isJsonValue(fact.draftValue) || !isJsonValue(fact.baseValue)) return unknown("DRAFT_SNAPSHOT_SCHEMA_INVALID");
  if (!canonicalInstant(fact.observedAt) || !canonicalInstant(trusted.now) ||
      !Number.isSafeInteger(trusted.maxAgeMs) || trusted.maxAgeMs < 0) return unknown("DRAFT_FRESHNESS_POLICY_INVALID");
  const age = Date.parse(trusted.now) - Date.parse(fact.observedAt);
  if (age < 0 || age > trusted.maxAgeMs) return unknown("DRAFT_SNAPSHOT_STALE_OR_FUTURE_DATED");
  const relation = canonicalJson(fact.draftValue) === canonicalJson(fact.baseValue) ? "EQUAL" : "DIFFERENT";
  return {
    truth: relation === expected ? "TRUE" : "FALSE",
    reason: relation === expected ? "EXACT_LOCAL_DRAFT_BASE_COMPARISON" : "LOCAL_DRAFT_BASE_COMPARISON_CONTRADICTS_PREDICATE",
    structuralRelation: relation,
    persistedState: "NOT_ASSERTED",
  };
}

const UNKNOWN_OUTCOME_FACT_KEYS = ["viewRef", "actionRef", "operationRef", "requestId", "requestFingerprint", "sendObservationRef", "sendDisposition", "waitDisposition", "sendObservedAt", "waitObservedAt"];
const UNKNOWN_OUTCOME_TRUSTED_KEYS = ["viewRef", "actionRef", "operationRef", "requestId", "requestFingerprint", "sendObservationRef", "now", "maxAgeMs"];

/** Derive local request uncertainty from the exact source action-operation tuple and local transport observation only. */
export function evaluateLocalUnknownOutcome(predicate, fact, trusted) {
  const unknown = (reason) => ({ truth: "UNKNOWN", reason, serverOutcome: "NOT_ASSERTED", retryAuthorization: "NONE" });
  if (!plainRecord(predicate) || !plainRecord(predicate.unknownOutcomeObservation) ||
      !exactKeys(fact, UNKNOWN_OUTCOME_FACT_KEYS) || !exactKeys(trusted, UNKNOWN_OUTCOME_TRUSTED_KEYS)) return unknown("MALFORMED_OR_NONCLOSED_UNKNOWN_OUTCOME_INPUT");
  const pairs = predicate.unknownOutcomeObservation.allowedActionOperationPairs;
  if (predicate.factKind !== "LOCAL_UNKNOWN" || !Array.isArray(pairs) ||
      !Array.isArray(predicate.factScope?.actionRefs) || !Array.isArray(predicate.factScope?.operationRefs)) return unknown("UNKNOWN_OUTCOME_SOURCE_PAIR_UNBOUND");
  if (pairs.length === 0) return unknown("QUERY_FINALITY_NOT_SUPPORTED_BY_LOCAL_TRANSPORT_OBSERVATION");
  if (fact.viewRef !== predicate.viewRef || trusted.viewRef !== predicate.viewRef ||
      fact.actionRef !== trusted.actionRef || fact.operationRef !== trusted.operationRef ||
      !predicate.factScope.actionRefs.includes(fact.actionRef) || !predicate.factScope.operationRefs.includes(fact.operationRef)) return unknown("UNKNOWN_OUTCOME_VIEW_OR_ACTION_SCOPE_MISMATCH");
  const pair = pairs.find((candidate) => candidate.actionRef === fact.actionRef && candidate.operationRef === fact.operationRef);
  // A LOCAL_UNKNOWN predicate describes uncertainty about a requested effect.
  // Read-only queries may themselves be unavailable, but cannot have an
  // ambiguous effect finality and must use the query observation contract.
  if (!pair || pair.operationKind !== "COMMAND") return unknown("UNKNOWN_OUTCOME_ACTION_OPERATION_PAIR_UNREVIEWED");
  if (!nonEmptyString(fact.requestId) || fact.requestId !== trusted.requestId ||
      !/^sha256:[a-f0-9]{64}$/u.test(fact.requestFingerprint) || fact.requestFingerprint !== trusted.requestFingerprint ||
      !nonEmptyString(fact.sendObservationRef) || fact.sendObservationRef !== trusted.sendObservationRef) return unknown("UNKNOWN_OUTCOME_REQUEST_IDENTITY_UNBOUND");
  if (!canonicalInstant(fact.sendObservedAt) || !canonicalInstant(fact.waitObservedAt) || !canonicalInstant(trusted.now) ||
      !Number.isSafeInteger(trusted.maxAgeMs) || trusted.maxAgeMs < 0) return unknown("UNKNOWN_OUTCOME_FRESHNESS_INVALID");
  const sentAt = Date.parse(fact.sendObservedAt);
  const waitAt = Date.parse(fact.waitObservedAt);
  const now = Date.parse(trusted.now);
  if (sentAt > waitAt || waitAt > now || now - waitAt > trusted.maxAgeMs) return unknown("UNKNOWN_OUTCOME_EVENT_ORDER_OR_FRESHNESS_INVALID");
  if (fact.sendDisposition === "NOT_SENT") {
    if (fact.waitDisposition !== "NOT_WAITED") return unknown("NOT_SENT_CONTRADICTS_RESPONSE_WAIT_OBSERVATION");
    return { truth: "FALSE", reason: "EXACT_LOCAL_REQUEST_NOT_SENT", serverOutcome: "NOT_ASSERTED", retryAuthorization: "NONE" };
  }
  if (fact.sendDisposition !== "TRANSPORT_WRITE_CONFIRMED") return unknown("LOCAL_SEND_DISPOSITION_UNCONFIRMED");
  if (["TIMEOUT", "CONNECTION_LOST", "INTERRUPTED"].includes(fact.waitDisposition)) {
    return { truth: "TRUE", reason: "LOCAL_SENT_REQUEST_RESPONSE_NOT_OBSERVED", serverOutcome: "UNKNOWN_NOT_ASSERTED", retryAuthorization: "NONE" };
  }
  if (fact.waitDisposition === "RESPONSE_RECEIVED") {
    return unknown("RESPONSE_RECEIVED_BUT_OPERATION_SPECIFIC_RESULT_NOT_VALIDATED");
  }
  return unknown("LOCAL_REQUEST_RESPONSE_OBSERVATION_INCOMPLETE");
}

/** Compare one exact observed version with trusted current-version and age policy. */
export function evaluateScopedStaleness(predicate, fact, trusted) {
  const unknown = (reason) => ({ truth: "UNKNOWN", reason });
  if (!plainRecord(predicate) || !plainRecord(predicate.factScope) ||
      !exactKeys(fact, STALENESS_FACT_KEYS) || !exactKeys(trusted, STALENESS_TRUSTED_KEYS)) return unknown("MALFORMED_OR_NONCLOSED_STALENESS_INPUT");
  if (predicate.factKind !== "LOCAL_STALENESS" || !Array.isArray(predicate.factScope.operationRefs) ||
      predicate.factScope.operationRefs.length === 0) return unknown("UNSUPPORTED_STALENESS_DEFINITION");
  if (fact.viewRef !== predicate.viewRef || trusted.viewRef !== predicate.viewRef) return unknown("VIEW_SCOPE_MISMATCH");
  if (fact.operationRef !== trusted.operationRef || !predicate.factScope.operationRefs.includes(fact.operationRef) ||
      fact.objectRef !== trusted.objectRef) return unknown("STALE_EVIDENCE_SCOPE_MISMATCH");
  for (const key of ["objectRef", "snapshotVersionRef", "currentVersionRef"]) {
    if (!nonEmptyString(fact[key]) && key !== "currentVersionRef") return unknown("STALE_EVIDENCE_VERSION_MISSING");
    if (!nonEmptyString(trusted[key]) && key !== "snapshotVersionRef") return unknown("TRUSTED_CURRENT_VERSION_MISSING");
  }
  if (!canonicalInstant(fact.observedAt) || !canonicalInstant(trusted.now) ||
      !Number.isSafeInteger(trusted.maxAgeMs) || trusted.maxAgeMs < 0) return unknown("STALE_EVIDENCE_FRESHNESS_POLICY_MISSING");
  const age = Date.parse(trusted.now) - Date.parse(fact.observedAt);
  if (age < 0) return unknown("STALE_EVIDENCE_FUTURE_DATED");
  const outdatedVersion = fact.snapshotVersionRef !== trusted.currentVersionRef;
  const exceedsAgePolicy = age > trusted.maxAgeMs;
  return outdatedVersion || exceedsAgePolicy
    ? { truth: "TRUE", reason: outdatedVersion ? "EXACT_VERSION_SUPERSEDED" : "OBSERVATION_EXCEEDS_TRUSTED_MAX_AGE" }
    : { truth: "FALSE", reason: "EXACT_VERSION_CURRENT_WITHIN_TRUSTED_MAX_AGE" };
}

/** Read the typed ProcessingJob result. Canonical state truth is exact only for the declared mapping. */
export function evaluateStoredJobStatus(predicate, fact, trusted) {
  const unknown = (reason) => ({ truth: "UNKNOWN", reason, canonicalStateRef: null });
  if (!plainRecord(predicate) || !plainRecord(predicate.jobStatusObservation) ||
      !exactKeys(fact, JOB_FACT_KEYS) || !exactKeys(trusted, JOB_TRUSTED_KEYS)) return unknown("MALFORMED_OR_NONCLOSED_JOB_OBSERVATION");
  if (predicate.factKind !== "OWNER_JOB_STATE" || fact.viewRef !== predicate.viewRef || trusted.viewRef !== predicate.viewRef) {
    return unknown("JOB_VIEW_SCOPE_MISMATCH");
  }
  if (!predicate.factScope?.operationRefs?.includes("media.operation-slice.inspect-job") ||
      trusted.operationRef !== "media.operation-slice.inspect-job" ||
      predicate.jobStatusObservation.queryOperationRef !== "media.operation-slice.inspect-job" ||
      predicate.jobStatusObservation.ownerReadModelRef !== ".product-experience/pdp-1-domain-data/operations.yaml#individualOperationContracts.records.media.operation-slice.inspect-job.ownerWireSchema") return unknown("JOB_QUERY_OPERATION_UNBOUND");
  const result = fact.queryResult;
  if (!exactKeys(result, JOB_RESULT_KEYS) || result.outcome !== "OBSERVED" ||
      result.operationRef !== "media.operation-slice.inspect-job" || result.operationVersion !== 1 ||
      result.operationRef !== trusted.operationRef || !exactKeys(result.job, JOB_KEYS) || !exactKeys(result.readObservation, JOB_READ_KEYS)) {
    return unknown("JOB_READ_MODEL_SCHEMA_INVALID");
  }
  const job = result.job;
  const read = result.readObservation;
  if (job.jobId !== trusted.jobId || job.requestId !== trusted.requestId || job.requestFingerprint !== trusted.requestFingerprint ||
      job.tenantId !== trusted.tenantId || job.principalId !== trusted.principalId ||
      result.tenantId !== trusted.tenantId || result.principalId !== trusted.principalId ||
      read.tenantId !== trusted.tenantId || read.principalId !== trusted.principalId ||
      read.readVersion !== trusted.readVersion || read.readAuthorityRef !== trusted.readAuthorityRef) return unknown("JOB_TENANT_PRINCIPAL_JOB_OR_READ_SCOPE_MISMATCH");
  if (!nonEmptyString(trusted.jobId) || !nonEmptyString(trusted.tenantId) || !nonEmptyString(trusted.principalId) ||
      !nonEmptyString(trusted.requestId) || !(trusted.requestFingerprint === "" || /^sha256:[a-f0-9]{64}$/u.test(trusted.requestFingerprint)) ||
      !nonEmptyString(trusted.readAuthorityRef) || !Number.isSafeInteger(trusted.readVersion) || trusted.readVersion < 1 ||
      !JOB_STATUS.includes(job.status) || !JOB_STATUS.includes(read.canonicalStateMapping?.sourceStatus) ||
      !JOB_FINALITY.includes(read.effectFinality) || read.effectFinality !== JOB_FINALITY_BY_STATUS[job.status] ||
      read.canonicalStateMapping.reason !== JOB_MAPPING_REASONS[read.canonicalStateMapping.sourceStatus] ||
      !exactKeys(read.canonicalStateMapping, Object.hasOwn(read.canonicalStateMapping, "canonicalStateRef") ? JOB_MAPPING_KEYS : JOB_MAPPING_KEYS.filter((key) => key !== "canonicalStateRef")) ||
      !nonEmptyString(job.requestId) || !nonEmptyString(job.artifactId) ||
      !["TRANSCODE", "SPEECH_TO_TEXT", "TEXT_TO_SPEECH", "VISION", "MULTIMODAL"].includes(job.jobType) ||
      !(job.providerId === null || nonEmptyString(job.providerId)) ||
      !canonicalInstant(job.createdAt) || !(job.startedAt === null || canonicalInstant(job.startedAt)) ||
      !(job.completedAt === null || canonicalInstant(job.completedAt)) || !plainRecord(job.result) ||
      !(job.failureCode === null || typeof job.failureCode === "string") || !Number.isSafeInteger(job.version) || job.version < 1 ||
      !(job.requestFingerprint === "" || /^sha256:[a-f0-9]{64}$/u.test(job.requestFingerprint))) return unknown("JOB_READ_MODEL_TYPED_FACT_INVALID");
  if (!canonicalInstant(read.observedAt) || !canonicalInstant(trusted.now) || !Number.isSafeInteger(trusted.maxAgeMs) || trusted.maxAgeMs < 0) {
    return unknown("JOB_READ_FRESHNESS_POLICY_INVALID");
  }
  const age = Date.parse(trusted.now) - Date.parse(read.observedAt);
  if (age < 0 || age > trusted.maxAgeMs) return unknown("JOB_READ_STALE_OR_FUTURE_DATED");
  const mapping = read.canonicalStateMapping;
  if (mapping.sourceStatus !== job.status) return unknown("JOB_STATUS_MAPPING_SOURCE_MISMATCH");
  if (job.status === "OUTCOME_UNKNOWN") {
    const ref = ".product-experience/pdp-1-domain-data/states.yaml#stateMachines/media-job/stateDefinitions/OUTCOME_UNKNOWN";
    if (mapping.disposition !== "EXACT_CANONICAL_STATE" || mapping.canonicalStateRef !== ref) return unknown("JOB_UNKNOWN_STATE_MAPPING_MISSING_OR_FORGED");
    const expectedRuntimeStatus = predicate.jobStatusObservation.runtimeStatus;
    return expectedRuntimeStatus === job.status
      ? { truth: "TRUE", reason: "EXACT_TYPED_JOB_STATUS_AND_CANONICAL_MAPPING", canonicalStateRef: ref, runtimeStatus: job.status }
      : { truth: "FALSE", reason: "EXACT_TYPED_JOB_STATUS_DIFFERS_FROM_VIEW_CONDITION", canonicalStateRef: ref, runtimeStatus: job.status };
  }
  if (mapping.disposition !== "NOT_MAPPED_RUNTIME_ONLY" || Object.hasOwn(mapping, "canonicalStateRef")) return unknown("UNSUPPORTED_RUNTIME_STATUS_MAPPING_FORGED");
  return unknown("RUNTIME_STATUS_HAS_NO_CANONICAL_PDP1_STATE_MAPPING");
}

/** Evaluate the proposed exact-version lifecycle read definition, never runtime admission. */
export function evaluateArtifactLifecycleObservation(predicate, fact, trusted) {
  const unknown = (reason) => ({ truth: "UNKNOWN", reason, canonicalStateRef: null });
  const operationRef = "media.operation.artifact.lifecycle.observe.v1";
  const ownerReadModelRef = ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts.records.media.operation.artifact.lifecycle.observe.v1.ownerWireSchema";
  const stateRef = (state) => `.product-experience/pdp-1-domain-data/states.yaml#stateMachines/media-upload-and-artifact/stateDefinitions/${state}`;
  const meaningRef = (state) => `${stateRef(state)}/meaning`;
  if (!plainRecord(predicate) || !plainRecord(predicate.artifactLifecycleObservation) ||
      !exactKeys(fact, ARTIFACT_FACT_KEYS) || !exactKeys(trusted, ARTIFACT_TRUSTED_KEYS)) return unknown("MALFORMED_OR_NONCLOSED_ARTIFACT_OBSERVATION");
  const definition = predicate.artifactLifecycleObservation;
  if (predicate.factKind !== "OWNER_ARTIFACT_STATE" || definition.queryOperationRef !== operationRef ||
      definition.ownerReadModelRef !== ownerReadModelRef || definition.runtimeObservationStatus !== "UNKNOWN_UNTIL_IMPLEMENTED" ||
      !ARTIFACT_LIFECYCLE_STATES.includes(definition.expectedState) ||
      definition.canonicalStateRef !== stateRef(definition.expectedState) || definition.meaningSourceRef !== meaningRef(definition.expectedState)) {
    return unknown("ARTIFACT_LIFECYCLE_SOURCE_BINDING_UNRESOLVED");
  }
  if (fact.viewRef !== predicate.viewRef || trusted.viewRef !== predicate.viewRef ||
      !predicate.factScope?.operationRefs?.includes(operationRef) || trusted.operationRef !== operationRef) return unknown("ARTIFACT_VIEW_OR_OPERATION_SCOPE_MISMATCH");
  for (const key of ["tenantId", "principalId", "artifactId", "artifactVersionId", "stateAuthorityRef", "stateEvidenceRef"]) {
    if (!nonEmptyString(trusted[key])) return unknown("ARTIFACT_TRUSTED_IDENTITY_OR_EVIDENCE_MISSING");
  }
  if (trusted.stateAuthorityRef !== ARTIFACT_STATE_AUTHORITY_REF) return unknown("ARTIFACT_STATE_AUTHORITY_NOT_IN_OWNER_ALLOWLIST");
  if (!Number.isSafeInteger(trusted.stateRevision) || trusted.stateRevision < 1 ||
      !Number.isSafeInteger(trusted.readVersion) || trusted.readVersion < 1 ||
      !canonicalInstant(trusted.now) || !Number.isSafeInteger(trusted.maxAgeMs) || trusted.maxAgeMs < 0) return unknown("ARTIFACT_TRUSTED_CURRENTNESS_POLICY_INVALID");
  const result = fact.queryResult;
  if (!plainRecord(result) || result.operationRef !== operationRef || !["OBSERVED", "UNKNOWN_OUTCOME", "NOT_FOUND_IN_CALLER_SCOPE", "UNAVAILABLE"].includes(result.outcome)) {
    return unknown("ARTIFACT_QUERY_ENVELOPE_INVALID");
  }
  if (result.outcome !== "OBSERVED") {
    if (!exactKeys(result, ARTIFACT_RESULT_KEYS.filter((key) => key !== "observation")) ||
        !ARTIFACT_UNKNOWN_REASONS.includes(result.unknownReason) || !canonicalInstant(result.observedAt)) return unknown("ARTIFACT_UNKNOWN_RESULT_INVALID");
    return unknown(result.unknownReason);
  }
  if (!exactKeys(result, ARTIFACT_RESULT_KEYS.filter((key) => key !== "unknownReason")) || !canonicalInstant(result.observedAt) ||
      !exactKeys(result.observation, ARTIFACT_OBSERVATION_KEYS)) return unknown("ARTIFACT_OBSERVED_RESULT_SCHEMA_INVALID");
  const observation = result.observation;
  if (observation.artifactId !== trusted.artifactId || observation.artifactVersionId !== trusted.artifactVersionId ||
      observation.tenantId !== trusted.tenantId || observation.principalId !== trusted.principalId ||
      observation.stateAuthorityRef !== trusted.stateAuthorityRef || observation.stateEvidenceRef !== trusted.stateEvidenceRef ||
      observation.stateRevision !== trusted.stateRevision || observation.readVersion !== trusted.readVersion) return unknown("ARTIFACT_IDENTITY_VERSION_AUTHORITY_OR_EVIDENCE_MISMATCH");
  if (!ARTIFACT_LIFECYCLE_STATES.includes(observation.lifecycleState) ||
      observation.canonicalStateRef !== stateRef(observation.lifecycleState) || observation.meaningSourceRef !== meaningRef(observation.lifecycleState) ||
      observation.observedAt !== result.observedAt || !canonicalInstant(observation.observedAt) ||
      !Number.isSafeInteger(observation.stateRevision) || observation.stateRevision < 1 ||
      !Number.isSafeInteger(observation.readVersion) || observation.readVersion < 1) return unknown("ARTIFACT_STATE_IDENTITY_OR_EVIDENCE_INVALID");
  const age = Date.parse(trusted.now) - Date.parse(observation.observedAt);
  if (age < 0 || age > trusted.maxAgeMs) return unknown("ARTIFACT_LIFECYCLE_READ_STALE_OR_FUTURE_DATED");
  const canonicalStateRef = stateRef(observation.lifecycleState);
  return observation.lifecycleState === definition.expectedState
    ? { truth: "TRUE", reason: "EXACT_SCOPED_ARTIFACT_LIFECYCLE_OBSERVATION", canonicalStateRef }
    : { truth: "FALSE", reason: "EXACT_SCOPED_ARTIFACT_LIFECYCLE_STATE_DIFFERS", canonicalStateRef };
}
