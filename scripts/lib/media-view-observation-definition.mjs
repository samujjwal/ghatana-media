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
      predicate.factSchemaRef !== ".product-experience/pdp-3-product-experience/view-observation-input-contracts.yaml#factSchemas/@id=media.view-observation-schema.local-connectivity.v1" ||
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

const OWNER_OBSERVATION_REF = {
  OWNER_RIGHTS_STATE: ".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.rights-decision.v1",
  OWNER_QUALITY_STATE: ".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.quality-evidence.v1",
  OWNER_PROFILE_STATE: ".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.profile-qualification.v1",
  OWNER_PROVENANCE_STATE: ".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.provenance-completeness.v1",
};
const OWNER_OPERATION_REFS = {
  OWNER_RIGHTS_STATE: ["media.operation.action.inspect-consent-and-permitted-use"],
  OWNER_QUALITY_STATE: ["media.operation.action.inspect-quality-evidence"],
  OWNER_PROFILE_STATE: ["media.operation.action.search-named-profiles", "media.operation.action.validate-processing-profile"],
  OWNER_PROVENANCE_STATE: ["media.operation-slice.inspect-provenance"],
};
const OWNER_READ_AUTHORITY_REF = ".product-experience/pdp-1-domain-data/authority.yaml#ownership.identityAuthenticationAndDelegation";
const OWNER_RESULT_KEYS = {
  OWNER_RIGHTS_STATE: { required: ["tenantScopeRef", "principalRef", "queryId", "operationRef", "requestFingerprint", "readAuthorityRef", "currentness", "decisionKind", "observationStatus", "observedAt", "readVersion"], allowed: ["tenantScopeRef", "principalRef", "queryId", "operationRef", "requestFingerprint", "readAuthorityRef", "currentness", "decisionKind", "observationStatus", "observedAt", "readVersion", "decision", "unknownReasonRef"] },
  OWNER_QUALITY_STATE: { required: ["tenantScopeRef", "principalRef", "queryId", "operationRef", "requestFingerprint", "readAuthorityRef", "currentness", "subjectArtifactVersionRef", "observationStatus", "observations", "observedAt", "readVersion"], allowed: ["tenantScopeRef", "principalRef", "queryId", "operationRef", "requestFingerprint", "readAuthorityRef", "currentness", "subjectArtifactVersionRef", "observationStatus", "observations", "observedAt", "readVersion", "unknownReasonRef"] },
  OWNER_PROFILE_STATE: { required: ["tenantScopeRef", "principalRef", "queryId", "operationRef", "requestFingerprint", "readAuthorityRef", "currentness", "profileRef", "targetRef", "domainRef", "qualificationStatus", "observedAt", "readVersion"], allowed: ["tenantScopeRef", "principalRef", "queryId", "operationRef", "requestFingerprint", "readAuthorityRef", "currentness", "profileRef", "profileVersionRef", "targetRef", "domainRef", "providerRef", "qualificationStatus", "qualificationRecordRef", "scopeRef", "validFrom", "validUntil", "observedAt", "readVersion", "evidenceRefs", "unknownReasonRef"] },
  OWNER_PROVENANCE_STATE: { required: ["tenantScopeRef", "principalRef", "queryId", "operationRef", "requestFingerprint", "readAuthorityRef", "currentness", "subjectArtifactVersionRef", "observationStatus", "completeness", "accessDisposition", "traversedRelationKinds", "lineageEdges", "observedAt", "readVersion"], allowed: ["tenantScopeRef", "principalRef", "queryId", "operationRef", "requestFingerprint", "readAuthorityRef", "currentness", "subjectArtifactVersionRef", "observationStatus", "completeness", "accessDisposition", "traversedRelationKinds", "lineageEdges", "observedAt", "readVersion", "unknownReasonRef"] },
};
const canonicalOwnerRef = (value) => nonEmptyString(value) && value.startsWith(".product-experience/");
const safeAge = (observedAt, now, maxAgeMs) => {
  if (!canonicalInstant(observedAt) || !canonicalInstant(now) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) return null;
  const age = Date.parse(now) - Date.parse(observedAt);
  return age >= 0 && age <= maxAgeMs ? age : null;
};
const sameSet = (left, right) => Array.isArray(left) && Array.isArray(right) &&
  left.length === right.length && new Set(left).size === left.length && left.every((value) => right.includes(value));
const nonEmptyUniqueRefs = (items) => Array.isArray(items) && items.length > 0 &&
  items.every(nonEmptyString) && new Set(items).size === items.length;

const EXTENDED_OWNER_OBSERVATIONS = {
  "media.observation-contract.declared-options.v1": {
    factKind: "OWNER_DECLARED_OPTIONS_STATE",
    operationRef: "media.operation.capability.media-capability-check-declared-options",
    authorityRef: ".product-experience/pdp-1-domain-data/authority.yaml#ownership.identityAuthenticationAndDelegation",
    requestKeys: ["queryId", "capabilityRef", "operationRef", "profileRef", "dimensionRefs"],
  },
  "media.observation-contract.quality-action-plan.v1": {
    factKind: "OWNER_QUALITY_ACTION_PLAN_STATE",
    operationRef: "media.operation.action.inspect-quality-evidence",
    authorityRef: ".product-experience/pdp-1-domain-data/authority.yaml#ownership.identityAuthenticationAndDelegation",
    requestKeys: ["queryId", "subjectArtifactVersionRef", "purposeRef", "scopeRef", "requestedKinds"],
  },
  "media.observation-contract.language-uncertainty.v1": {
    factKind: "OWNER_LANGUAGE_UNCERTAINTY_STATE",
    operationRef: "media.operation.action.inspect-quality-evidence",
    authorityRef: ".product-experience/pdp-1-domain-data/authority.yaml#ownership.identityAuthenticationAndDelegation",
    requestKeys: ["queryId", "subjectArtifactVersionRef", "contentKind", "declaredLanguageTag", "purposeRef"],
  },
};

function evaluateExtendedOwnerObservation(predicate, fact, trusted) {
  const unknown = (reason) => ({ truth: "UNKNOWN", reason, runtimeObservation: "UNKNOWN_UNTIL_QUERY_IMPLEMENTED", executionAdmission: "NOT_ADMITTED" });
  const contractRef = Object.entries(EXTENDED_OWNER_OBSERVATIONS).find(([id]) =>
    predicate?.ownerObservationContractRef?.endsWith(`/@id=${id}`))?.[0];
  const contract = contractRef && EXTENDED_OWNER_OBSERVATIONS[contractRef];
  if (!contract) return null;
  if (!plainRecord(predicate) || !plainRecord(predicate.ownerObservationExpectation) ||
      predicate.ownerObservationExpectation.status !== "OWNER_DEFINED_EXPECTATION_REVIEW_PENDING" ||
      !plainRecord(predicate.ownerObservationExpectation.expected) || !exactKeys(fact, ["viewRef", "queryContractRef", "queryRequest", "queryResult"])) {
    return unknown("EXTENDED_OWNER_OBSERVATION_INPUT_MALFORMED");
  }
  const contractSourceRef = `.product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=${contractRef}`;
  if (predicate.factKind !== contract.factKind || fact.queryContractRef !== contractSourceRef ||
      fact.viewRef !== predicate.viewRef || !exactKeys(fact.queryRequest, contract.requestKeys)) return unknown("EXTENDED_OWNER_OBSERVATION_CONTRACT_MISMATCH");
  const trustedKeysByContract = {
    "media.observation-contract.declared-options.v1": ["viewRef", "tenantScopeRef", "principalRef", "expectedQueryId", "expectedRequestFingerprint", "expectedOperationRef", "expectedReadAuthorityRef", "expectedReadVersion", "capabilityRef", "profileRef", "dimensionRefs", "now", "maxAgeMs"],
    "media.observation-contract.quality-action-plan.v1": ["viewRef", "tenantScopeRef", "principalRef", "expectedQueryId", "expectedRequestFingerprint", "expectedOperationRef", "expectedReadAuthorityRef", "expectedReadVersion", "subjectArtifactVersionRef", "purposeRef", "scopeRef", "requestedKinds", "now", "maxAgeMs"],
    "media.observation-contract.language-uncertainty.v1": ["viewRef", "tenantScopeRef", "principalRef", "expectedQueryId", "expectedRequestFingerprint", "expectedOperationRef", "expectedReadAuthorityRef", "expectedReadVersion", "subjectArtifactVersionRef", "contentKind", "declaredLanguageTag", "purposeRef", "now", "maxAgeMs"],
  }[contractRef];
  if (!plainRecord(trusted) || !exactKeys(trusted, trustedKeysByContract)) return unknown("EXTENDED_OWNER_TRUSTED_CONTEXT_NOT_CLOSED");
  const request = fact.queryRequest;
  const result = fact.queryResult;
  const isUniqueRefList = (refs, max) => Array.isArray(refs) && refs.length > 0 && refs.length <= max && refs.every(nonEmptyString) && new Set(refs).size === refs.length;
  const readEnvelopeKeys = ["tenantScopeRef", "principalRef", "queryId", "operationRef", "requestFingerprint", "readAuthorityRef", "currentness", "observedAt", "readVersion"];
  const resultKeys = {
    "media.observation-contract.declared-options.v1": [...readEnvelopeKeys, "capabilityRef", "profileRef", "declarationDisposition", "compatibility", "dimensionResults"],
    "media.observation-contract.quality-action-plan.v1": [...readEnvelopeKeys, "subjectArtifactVersionRef", "purposeRef", "scopeRef", "assessmentCoverage", "coveredKinds", "assessments"],
    "media.observation-contract.language-uncertainty.v1": [...readEnvelopeKeys, "subjectArtifactVersionRef", "contentKind", "declaredLanguageTag", "purposeRef", "observedLanguageTag", "languageSource", "uncertaintyDisposition", "uncertaintyReasonRefs", "methodRef", "methodVersionRef", "evidenceRefs", "unknownReasonRef"],
  }[contractRef];
  if (!exactKeys(trusted, trustedKeysByContract) || !plainRecord(result) ||
      Object.keys(result).some((key) => !resultKeys.includes(key)) ||
      !readEnvelopeKeys.every((key) => Object.hasOwn(result, key))) return unknown("EXTENDED_OWNER_RESULT_NOT_CLOSED");
  if (trusted.viewRef !== predicate.viewRef || fact.viewRef !== trusted.viewRef ||
      !nonEmptyString(trusted.tenantScopeRef) || result.tenantScopeRef !== trusted.tenantScopeRef ||
      !nonEmptyString(trusted.principalRef) || result.principalRef !== trusted.principalRef ||
      trusted.expectedOperationRef !== contract.operationRef || result.operationRef !== contract.operationRef ||
      trusted.expectedReadAuthorityRef !== contract.authorityRef || result.readAuthorityRef !== contract.authorityRef ||
      !/^sha256:[a-f0-9]{64}$/u.test(trusted.expectedRequestFingerprint) || result.requestFingerprint !== trusted.expectedRequestFingerprint ||
      !nonEmptyString(trusted.expectedQueryId) || request.queryId !== trusted.expectedQueryId || result.queryId !== trusted.expectedQueryId ||
      !nonEmptyString(trusted.expectedReadVersion) || result.readVersion !== trusted.expectedReadVersion || result.currentness !== "CURRENT" ||
      safeAge(result.observedAt, trusted.now, trusted.maxAgeMs) === null) return unknown("EXTENDED_OWNER_READ_RECEIPT_STALE_FOREIGN_OR_MISMATCHED");

  if (contractRef === "media.observation-contract.declared-options.v1") {
    const dims = trusted.dimensionRefs;
    if (!nonEmptyString(trusted.capabilityRef) || !nonEmptyString(trusted.profileRef) ||
        !Array.isArray(dims) || dims.length === 0 || dims.length > 64 || dims.some((x) => !nonEmptyString(x)) || new Set(dims).size !== dims.length ||
        request.capabilityRef !== trusted.capabilityRef || request.operationRef !== contract.operationRef || request.profileRef !== trusted.profileRef ||
        !sameSet(request.dimensionRefs, dims) || result.capabilityRef !== trusted.capabilityRef || result.profileRef !== trusted.profileRef ||
        !["DECLARED", "NOT_DECLARED", "UNKNOWN"].includes(result.declarationDisposition) ||
        !["COMPATIBLE", "INCOMPATIBLE", "PARTIAL", "UNKNOWN"].includes(result.compatibility) ||
        !Array.isArray(result.dimensionResults) || result.dimensionResults.length !== dims.length) return unknown("DECLARED_OPTIONS_SCOPE_OR_RESULT_INVALID");
    const rows = result.dimensionResults;
    if (rows.some((row) => !exactKeys(row, ["dimensionRef", "disposition", "reasonRef", "evidenceRefs"]) ||
        !nonEmptyString(row.dimensionRef) || !nonEmptyString(row.reasonRef) || !isUniqueRefList(row.evidenceRefs, 32) ||
        !["SUPPORTED", "UNSUPPORTED", "UNKNOWN", "NOT_APPLICABLE"].includes(row.disposition)) || !sameSet(dims, rows.map(({ dimensionRef }) => dimensionRef))) return unknown("DECLARED_OPTIONS_DIMENSION_SET_INVALID");
    const disposition = result.declarationDisposition;
    if (disposition === "UNKNOWN") return unknown("DECLARED_OPTIONS_DISPOSITION_UNKNOWN");
    const truth = predicate.ownerObservationExpectation.expected.declarationDisposition === disposition;
    return { truth: truth ? "TRUE" : "FALSE", reason: truth ? "EXACT_VERSIONED_DECLARATION_PRESENT" : "EXACT_VERSIONED_DECLARATION_ABSENT", declarationDisposition: disposition, compatibility: result.compatibility, dimensionResults: rows, runtimeObservation: "UNKNOWN_UNTIL_QUERY_IMPLEMENTED", executionAdmission: "NOT_ADMITTED" };
  }

  if (contractRef === "media.observation-contract.quality-action-plan.v1") {
    if (!nonEmptyString(trusted.subjectArtifactVersionRef) || !nonEmptyString(trusted.purposeRef) || !nonEmptyString(trusted.scopeRef) ||
        request.subjectArtifactVersionRef !== trusted.subjectArtifactVersionRef || request.purposeRef !== trusted.purposeRef || request.scopeRef !== trusted.scopeRef ||
        result.subjectArtifactVersionRef !== trusted.subjectArtifactVersionRef || result.purposeRef !== trusted.purposeRef || result.scopeRef !== trusted.scopeRef ||
        !Array.isArray(trusted.requestedKinds) || trusted.requestedKinds.length !== 1 ||
        !["RECOMMENDATION", "BOUNDED_REPAIR_PLAN"].includes(trusted.requestedKinds[0]) || !sameSet(request.requestedKinds, trusted.requestedKinds) ||
        !["COMPLETE", "PARTIAL", "UNKNOWN", "NOT_EVALUATED"].includes(result.assessmentCoverage) ||
        !Array.isArray(result.coveredKinds) || result.coveredKinds.some((kind) => !["RECOMMENDATION", "BOUNDED_REPAIR_PLAN"].includes(kind)) ||
        !sameSet(result.coveredKinds, trusted.requestedKinds) || !Array.isArray(result.assessments) || result.assessments.length > 2) return unknown("QUALITY_ACTION_PLAN_SCOPE_INVALID");
    if (result.assessmentCoverage !== "COMPLETE") return unknown("QUALITY_ACTION_PLAN_COVERAGE_INCOMPLETE");
    const assessmentKeys = ["kind", "subjectArtifactVersionRef", "queryId", "requestFingerprint", "purposeRef", "scopeRef", "methodRef", "methodVersionRef", "profileRef", "profileVersionRef", "validationDisposition", "proposedActionRefs", "resourceBudgetRef", "costBudgetRef", "preservationGuarantees", "evidenceRefs"];
    const allowedValidation = ["DEFINITION_VALIDATED", "PROPOSAL_ONLY", "BLOCKED", "UNKNOWN", "NOT_APPLICABLE"];
    for (const row of result.assessments) {
      if (!plainRecord(row) || Object.keys(row).some((key) => !assessmentKeys.includes(key)) ||
          !["RECOMMENDATION", "BOUNDED_REPAIR_PLAN"].includes(row.kind) || !trusted.requestedKinds.includes(row.kind) ||
          row.subjectArtifactVersionRef !== trusted.subjectArtifactVersionRef || row.queryId !== trusted.expectedQueryId ||
          row.requestFingerprint !== trusted.expectedRequestFingerprint || row.purposeRef !== trusted.purposeRef || row.scopeRef !== trusted.scopeRef ||
          !nonEmptyString(row.methodRef) || !nonEmptyString(row.methodVersionRef) || !allowedValidation.includes(row.validationDisposition) ||
          !isUniqueRefList(row.evidenceRefs, 64)) return unknown("QUALITY_ACTION_ASSESSMENT_SCOPE_INVALID");
      if ((row.profileRef === undefined) !== (row.profileVersionRef === undefined) ||
          (row.profileRef !== undefined && (!nonEmptyString(row.profileRef) || !nonEmptyString(row.profileVersionRef)))) return unknown("QUALITY_ACTION_PROFILE_VERSION_PAIR_INVALID");
      if (row.kind === "BOUNDED_REPAIR_PLAN" && row.validationDisposition === "DEFINITION_VALIDATED" &&
          (!isUniqueRefList(row.proposedActionRefs, 32) || !nonEmptyString(row.resourceBudgetRef) || !nonEmptyString(row.costBudgetRef) ||
           !Array.isArray(row.preservationGuarantees) || row.preservationGuarantees.length === 0 ||
           row.preservationGuarantees.some((x) => !["SOURCE_VERSION_UNCHANGED", "UNSELECTED_CONTENT_PRESERVED", "NO_PUBLISH_WITHOUT_APPROVAL", "NO_SILENT_FALLBACK"].includes(x)))) return unknown("REPAIR_PLAN_DEFINITION_BOUNDS_INCOMPLETE");
    }
    const requestedKind = trusted.requestedKinds[0];
    const matches = result.assessments.filter((row) => row.kind === requestedKind);
    let truth;
    if (requestedKind === "RECOMMENDATION") truth = matches.length === 1 && result.assessments.length === 1;
    else truth = matches.length === 1 && result.assessments.length === 1 && matches[0].validationDisposition === "DEFINITION_VALIDATED";
    const reason = truth ? (requestedKind === "RECOMMENDATION" ? "EXACT_RECOMMENDATION_ONLY" : "EXACT_PLAN_DEFINITION_VALIDATED") : (requestedKind === "RECOMMENDATION" ? "COMPLETE_QUERY_HAS_NO_RECOMMENDATION_ONLY_RESULT" : "COMPLETE_QUERY_HAS_NO_DEFINITION_VALIDATED_PLAN");
    return { truth: truth ? "TRUE" : "FALSE", reason, assessment: matches[0] ?? null, effect: "NONE", executionApproval: "NOT_ESTABLISHED", runtimeObservation: "UNKNOWN_UNTIL_QUERY_IMPLEMENTED", executionAdmission: "NOT_ADMITTED" };
  }

  if (contractRef === "media.observation-contract.language-uncertainty.v1") {
    if (!nonEmptyString(trusted.subjectArtifactVersionRef) || !nonEmptyString(trusted.contentKind) || !nonEmptyString(trusted.declaredLanguageTag) || !nonEmptyString(trusted.purposeRef) ||
        request.subjectArtifactVersionRef !== trusted.subjectArtifactVersionRef || request.contentKind !== trusted.contentKind ||
        request.declaredLanguageTag !== trusted.declaredLanguageTag || request.purposeRef !== trusted.purposeRef ||
        result.subjectArtifactVersionRef !== trusted.subjectArtifactVersionRef || result.contentKind !== trusted.contentKind || result.declaredLanguageTag !== trusted.declaredLanguageTag || !nonEmptyString(trusted.purposeRef) || result.purposeRef !== trusted.purposeRef ||
        !["DECLARED_METADATA", "OBSERVED_METHOD", "HUMAN_REVIEW", "NONE"].includes(result.languageSource) ||
        !["UNCERTAIN", "NOT_UNCERTAIN", "NOT_APPLICABLE", "UNKNOWN", "NOT_EVALUATED"].includes(result.uncertaintyDisposition)) return unknown("LANGUAGE_UNCERTAINTY_SCOPE_INVALID");
    if (["UNKNOWN", "NOT_EVALUATED", "NOT_APPLICABLE"].includes(result.uncertaintyDisposition) || result.languageSource === "NONE") return unknown("LANGUAGE_UNCERTAINTY_NOT_EVALUATED_OR_NOT_APPLICABLE");
    if (!nonEmptyString(result.methodRef) || !nonEmptyString(result.methodVersionRef) || !isUniqueRefList(result.evidenceRefs, 64)) return unknown("LANGUAGE_UNCERTAINTY_METHOD_EVIDENCE_MISSING");
    if (!nonEmptyString(result.observedLanguageTag) ||
        (result.uncertaintyDisposition === "UNCERTAIN" && !isUniqueRefList(result.uncertaintyReasonRefs, 16))) return unknown("LANGUAGE_UNCERTAINTY_REASON_OR_OBSERVATION_MISSING");
    const expected = predicate.ownerObservationExpectation.expected;
    const truth = expected.uncertaintyDisposition === result.uncertaintyDisposition && expected.contentKind === result.contentKind;
    return { truth: truth ? "TRUE" : "FALSE", reason: truth ? "EXACT_LANGUAGE_UNCERTAINTY_REPORTED" : "EXACT_LANGUAGE_UNCERTAINTY_NOT_REPORTED", uncertaintyDisposition: result.uncertaintyDisposition, languageSource: result.languageSource, methodRef: result.methodRef, methodVersionRef: result.methodVersionRef, evidenceRefs: result.evidenceRefs, runtimeObservation: "UNKNOWN_UNTIL_QUERY_IMPLEMENTED", executionAdmission: "NOT_ADMITTED" };
  }
  return unknown("EXTENDED_OWNER_OBSERVATION_UNSUPPORTED");
}

/**
 * Evaluate one of the four exact owner-defined typed observation queries.
 * The `trusted` tuple is supplied out-of-band by the host; this function checks
 * tuple equality and freshness but does not authenticate that host or admit an
 * endpoint. All four query contracts remain definition-only, so TRUE/FALSE are
 * source-model oracle results, never live runtime evidence.
 */
export function evaluateOwnerTypedObservation(predicate, fact, trusted) {
  const extended = evaluateExtendedOwnerObservation(predicate, fact, trusted);
  if (extended) return extended;
  const unknown = (reason) => ({ truth: "UNKNOWN", reason, runtimeObservation: "UNKNOWN_UNTIL_QUERY_IMPLEMENTED", executionAdmission: "NOT_ADMITTED" });
  if (!plainRecord(predicate) || !plainRecord(predicate.ownerObservationExpectation) ||
      !exactKeys(fact, ["viewRef", "queryContractRef", "queryResult"])) return unknown("OWNER_OBSERVATION_INPUT_MALFORMED");
  const kind = predicate.factKind;
  const expectedContract = OWNER_OBSERVATION_REF[kind];
  if (!expectedContract || predicate.ownerObservationContractRef !== expectedContract || fact.queryContractRef !== expectedContract) return unknown("OWNER_OBSERVATION_CONTRACT_UNBOUND");
  const expectation = predicate.ownerObservationExpectation;
  if (expectation.status !== "OWNER_DEFINED_EXPECTATION_REVIEW_PENDING" || !plainRecord(expectation.expected)) {
    return unknown(expectation.unsupportedReason ? `OWNER_LABEL_CONDITION_UNSUPPORTED:${expectation.unsupportedReason}` : "OWNER_LABEL_CONDITION_UNRESOLVED");
  }
  if (predicate.id !== predicate.predicateId || fact.viewRef !== predicate.viewRef ||
      !Array.isArray(predicate.factScope?.requiredIdentityFields)) return unknown("OWNER_OBSERVATION_VIEW_SCOPE_INVALID");
  const result = fact.queryResult;
  const expectedTopKeys = OWNER_RESULT_KEYS[kind];
  if (!plainRecord(result) || Reflect.ownKeys(result).some((key) => typeof key !== "string" || !expectedTopKeys.allowed.includes(key)) ||
      !expectedTopKeys.required.every((key) => Object.hasOwn(result, key))) return unknown("OWNER_OBSERVATION_RESULT_NOT_CLOSED_OR_INCOMPLETE");
  const trustedAllowed = {
    OWNER_RIGHTS_STATE: ["viewRef", "tenantScopeRef", "principalRef", "expectedQueryId", "expectedRequestFingerprint", "expectedOperationRef", "expectedReadAuthorityRef", "expectedReadVersion", "subjectArtifactVersionRef", "purposeRef", "useRef", "regionRef", "retentionPolicyRef", "authorityRef", "authorityVersionRef", "now", "maxAgeMs"],
    OWNER_QUALITY_STATE: ["viewRef", "tenantScopeRef", "principalRef", "expectedQueryId", "expectedRequestFingerprint", "expectedOperationRef", "expectedReadAuthorityRef", "expectedReadVersion", "subjectArtifactVersionRef", "requestedMetricRefs", "metricRef", "modalityRef", "methodRef", "methodVersionRef", "now", "maxAgeMs"],
    OWNER_PROFILE_STATE: ["viewRef", "tenantScopeRef", "principalRef", "expectedQueryId", "expectedRequestFingerprint", "expectedOperationRef", "expectedReadAuthorityRef", "expectedReadVersion", "profileRef", "profileVersionRef", "targetRef", "domainRef", "providerRef", "scopeRef", "now", "maxAgeMs"],
    OWNER_PROVENANCE_STATE: ["viewRef", "tenantScopeRef", "principalRef", "expectedQueryId", "expectedRequestFingerprint", "expectedOperationRef", "expectedReadAuthorityRef", "expectedReadVersion", "subjectArtifactVersionRef", "requestedRelationKinds", "now", "maxAgeMs"],
  }[kind];
  if (!plainRecord(trusted) || Reflect.ownKeys(trusted).some((key) => typeof key !== "string" || !trustedAllowed.includes(key))) return unknown("OWNER_OBSERVATION_TRUSTED_CONTEXT_NOT_CLOSED");
  if (!OWNER_OPERATION_REFS[kind].includes(trusted.expectedOperationRef) || trusted.expectedReadAuthorityRef !== OWNER_READ_AUTHORITY_REF ||
      !nonEmptyString(trusted.expectedQueryId) || !/^sha256:[a-f0-9]{64}$/u.test(trusted.expectedRequestFingerprint)) return unknown("OWNER_OBSERVATION_EXPECTED_READ_BINDING_MISSING_OR_UNBOUND");
  if (!nonEmptyString(result.tenantScopeRef) || !nonEmptyString(result.principalRef) ||
      result.tenantScopeRef !== trusted?.tenantScopeRef || result.principalRef !== trusted?.principalRef ||
      fact.viewRef !== trusted?.viewRef || !nonEmptyString(trusted?.tenantScopeRef) || !nonEmptyString(trusted?.principalRef)) return unknown("OWNER_OBSERVATION_TRUSTED_IDENTITY_MISMATCH");
  if (safeAge(result.observedAt, trusted.now, trusted.maxAgeMs) === null || !nonEmptyString(result.readVersion) ||
      !nonEmptyString(trusted.expectedReadVersion) || result.readVersion !== trusted.expectedReadVersion ||
      result.queryId !== trusted.expectedQueryId || result.operationRef !== trusted.expectedOperationRef ||
      result.requestFingerprint !== trusted.expectedRequestFingerprint || result.readAuthorityRef !== trusted.expectedReadAuthorityRef ||
      result.currentness !== "CURRENT") return unknown("OWNER_OBSERVATION_STALE_OR_UNVERSIONED_OR_FOREIGN_READ_RECEIPT");

  if (kind === "OWNER_RIGHTS_STATE") {
    const requiredContext = ["subjectArtifactVersionRef", "purposeRef", "useRef", "regionRef", "retentionPolicyRef", "authorityRef", "authorityVersionRef"];
    if (!requiredContext.every((key) => nonEmptyString(trusted[key]))) return unknown("RIGHTS_TRUSTED_SCOPE_INCOMPLETE");
    const validStatuses = ["ALLOWED_FOR_DECLARED_SCOPE", "DENIED", "RESTRICTED", "EXPIRED", "REVOKED", "REVIEW_REQUIRED", "APPROVAL_REQUIRED", "CONSENT_REQUIRED", "VOICE_AUTHORIZATION_REQUIRED", "UNKNOWN", "NOT_FOUND"];
    if (!validStatuses.includes(result.observationStatus)) return unknown("RIGHTS_STATUS_INVALID");
    if (!["RIGHTS", "CONSENT", "VOICE_AUTHORIZATION", "HUMAN_REVIEW_APPROVAL"].includes(result.decisionKind)) return unknown("RIGHTS_DECISION_KIND_INVALID");
    if (result.observationStatus === "UNKNOWN" || result.observationStatus === "NOT_FOUND") {
      if (Object.hasOwn(result, "decision") || !nonEmptyString(result.unknownReasonRef)) return unknown("RIGHTS_UNKNOWN_RESULT_MUST_OMIT_DECISION_AND_GIVE_REASON");
      const matchesUnknown = expectation.expected.observationStatus === result.observationStatus;
      return { truth: matchesUnknown ? "TRUE" : "FALSE", reason: matchesUnknown ? "EXACT_SCOPED_RIGHTS_UNKNOWN" : "SCOPED_RIGHTS_UNKNOWN_STATUS_DIFFERS", runtimeObservation: "UNKNOWN_UNTIL_QUERY_IMPLEMENTED", executionAdmission: "NOT_ADMITTED" };
    }
    const decisionKeys = ["tenantScopeRef", "principalRef", "subjectArtifactVersionRef", "decisionKind", "purposeRef", "useRef", "regionRef", "retentionPolicyRef", "authorityRef", "authorityVersionRef", "effectDisposition", "validFrom", "evidenceRefs"];
    if (!(exactKeys(result.decision, decisionKeys) || exactKeys(result.decision, [...decisionKeys, "validUntil"]))) return unknown("RIGHTS_DECISION_SCOPE_SCHEMA_INVALID");
    const d = result.decision;
    if (d.decisionKind !== result.decisionKind) return unknown("RIGHTS_RESULT_AND_DECISION_KIND_MISMATCH");
    for (const key of ["tenantScopeRef", "principalRef", ...requiredContext]) {
      if (d[key] !== (key === "tenantScopeRef" ? trusted.tenantScopeRef : key === "principalRef" ? trusted.principalRef : trusted[key])) return unknown("RIGHTS_DECISION_TUPLE_MISMATCH");
    }
    if (!nonEmptyUniqueRefs(d.evidenceRefs) || !canonicalInstant(d.validFrom) || Date.parse(d.validFrom) > Date.parse(trusted.now) ||
        (Object.hasOwn(d, "validUntil") && (!canonicalInstant(d.validUntil) ||
          (result.observationStatus === "EXPIRED" ? Date.parse(trusted.now) < Date.parse(d.validUntil) : Date.parse(trusted.now) >= Date.parse(d.validUntil)))) ||
        (result.observationStatus === "EXPIRED" && !Object.hasOwn(d, "validUntil"))) return unknown("RIGHTS_DECISION_EVIDENCE_OR_VALIDITY_INVALID");
    const expected = expectation.expected;
    const exactMapping = {
      DENIED: { kinds: ["RIGHTS"], effect: "DENIED" },
      RESTRICTED: { kinds: ["RIGHTS"], effect: "RESTRICTED" },
      CONSENT_REQUIRED: { kinds: ["CONSENT"], effect: "CONSENT_REQUIRED" },
      REVIEW_REQUIRED: { kinds: ["RIGHTS"], effect: "PENDING_REVIEW" },
      APPROVAL_REQUIRED: { kinds: ["HUMAN_REVIEW_APPROVAL"], effect: "APPROVAL_REQUIRED" },
      VOICE_AUTHORIZATION_REQUIRED: { kinds: ["VOICE_AUTHORIZATION"], effect: "VOICE_AUTHORIZATION_REQUIRED" },
      EXPIRED: { kinds: ["RIGHTS", "HUMAN_REVIEW_APPROVAL"], effect: "EXPIRED" },
      REVOKED: { kinds: ["RIGHTS", "CONSENT"], effect: "REVOKED" },
    }[result.observationStatus];
    if (exactMapping && (!exactMapping.kinds.includes(result.decisionKind) || d.effectDisposition !== exactMapping.effect)) return unknown("RIGHTS_STATUS_KIND_DISPOSITION_CONTRADICTS_OWNER_MAPPING");
    if (result.observationStatus === "ALLOWED_FOR_DECLARED_SCOPE" && d.effectDisposition !== "PERMITTED") return unknown("RIGHTS_ALLOWED_STATUS_WITHOUT_PERMITTED_DISPOSITION");
    if (!exactMapping && result.observationStatus !== "ALLOWED_FOR_DECLARED_SCOPE") return unknown("RIGHTS_STATUS_HAS_NO_EXACT_OWNER_MAPPING");
    const match = result.decisionKind === expected.decisionKind && result.observationStatus === expected.observationStatus && d.effectDisposition === expected.effectDisposition;
    return { truth: match ? "TRUE" : "FALSE", reason: match ? "EXACT_SCOPED_RIGHTS_DECISION_MATCH" : "EXACT_SCOPED_RIGHTS_DECISION_DIFFERS", runtimeObservation: "UNKNOWN_UNTIL_QUERY_IMPLEMENTED", executionAdmission: "NOT_ADMITTED" };
  }

  if (kind === "OWNER_QUALITY_STATE") {
    if (!nonEmptyString(trusted.subjectArtifactVersionRef) || result.subjectArtifactVersionRef !== trusted.subjectArtifactVersionRef) return unknown("QUALITY_SUBJECT_VERSION_MISMATCH");
    if (!Array.isArray(trusted.requestedMetricRefs) || trusted.requestedMetricRefs.length < 1 || trusted.requestedMetricRefs.length > 16 ||
        trusted.requestedMetricRefs.some((ref) => !nonEmptyString(ref)) || new Set(trusted.requestedMetricRefs).size !== trusted.requestedMetricRefs.length ||
        !trusted.requestedMetricRefs.includes(trusted.metricRef)) return unknown("QUALITY_REQUESTED_METRIC_SCOPE_INVALID");
    if (expectation.expected.metricRef !== undefined &&
        (trusted.metricRef !== expectation.expected.metricRef || !sameSet(trusted.requestedMetricRefs, [expectation.expected.metricRef]))) {
      return unknown("QUALITY_EXPECTED_METRIC_NOT_EXACTLY_REQUESTED");
    }
    if (!["OBSERVATIONS_PRESENT", "NO_OBSERVATIONS", "UNKNOWN", "SUBJECT_NOT_FOUND"].includes(result.observationStatus) || !Array.isArray(result.observations)) return unknown("QUALITY_RESULT_SCHEMA_INVALID");
    if (result.observationStatus === "UNKNOWN" || result.observationStatus === "SUBJECT_NOT_FOUND") return unknown("QUALITY_OBSERVATION_UNKNOWN_OR_NOT_FOUND");
    if (result.observationStatus === "NO_OBSERVATIONS") {
      if (result.observations.length !== 0) return unknown("QUALITY_EMPTY_STATUS_CONTRADICTS_ROWS");
      const truth = expectation.expected.condition === "NO_OBSERVATIONS";
      return { truth: truth ? "TRUE" : "FALSE", reason: truth ? "EXACT_NO_QUALITY_OBSERVATIONS" : "QUALITY_OBSERVATIONS_ABSENT", runtimeObservation: "UNKNOWN_UNTIL_QUERY_IMPLEMENTED", executionAdmission: "NOT_ADMITTED" };
    }
    if (result.observationStatus !== "OBSERVATIONS_PRESENT" || result.observations.length === 0) return unknown("QUALITY_OBSERVATION_STATUS_CONTRADICTS_ROWS");
    for (const row of result.observations) {
      const allowedQualityKeys = ["metricRef", "modalityRef", "methodRef", "methodVersionRef", "applicability", "disposition", "value", "unitRef", "uncertainty", "abstentionReasonRef", "calibrationRef", "evidenceRefs"];
      const requiredQualityKeys = ["metricRef", "modalityRef", "methodRef", "methodVersionRef", "applicability", "disposition", "evidenceRefs"];
      if (!plainRecord(row) || Object.keys(row).some((key) => !allowedQualityKeys.includes(key)) || !requiredQualityKeys.every((key) => Object.hasOwn(row,key)) ||
          !nonEmptyString(row.metricRef) || !nonEmptyString(row.modalityRef) || !nonEmptyString(row.methodRef) || !nonEmptyString(row.methodVersionRef) ||
          !["APPLICABLE", "NOT_APPLICABLE", "ABSTAINED", "NOT_EVALUATED", "BLOCKED"].includes(row.applicability) ||
          !["PASS", "FAIL", "INDETERMINATE", "NOT_EVALUATED"].includes(row.disposition) ||
          !(row.value === undefined || row.value === null || ["number", "string"].includes(typeof row.value)) ||
          !(row.uncertainty === undefined || row.uncertainty === null || ["number", "string"].includes(typeof row.uncertainty)) ||
          !nonEmptyUniqueRefs(row.evidenceRefs)) return unknown("QUALITY_ROW_SCHEMA_INVALID");
      if (!trusted.requestedMetricRefs.includes(row.metricRef) ||
          (typeof row.value === "number" && !Number.isFinite(row.value)) ||
          (typeof row.uncertainty === "number" && (!Number.isFinite(row.uncertainty) || row.uncertainty < 0)) ||
          (["PASS", "FAIL"].includes(row.disposition) && (row.applicability !== "APPLICABLE" || !Object.hasOwn(row, "value") || row.value === null)) ||
          (["NOT_EVALUATED", "ABSTAINED", "BLOCKED"].includes(row.applicability) && ["PASS", "FAIL"].includes(row.disposition)) ||
          (typeof row.value === "number" && !nonEmptyString(row.unitRef)) ||
          (row.unitRef !== undefined && !nonEmptyString(row.unitRef))) return unknown("QUALITY_ROW_VALUE_OR_REQUEST_SCOPE_INVALID");
    }
    const matching = result.observations.filter((r) => r.metricRef === trusted.metricRef && r.modalityRef === trusted.modalityRef && r.methodRef === trusted.methodRef && r.methodVersionRef === trusted.methodVersionRef);
    if (matching.length === 0) return unknown("QUALITY_EXACT_METRIC_METHOD_TUPLE_NOT_OBSERVED");
    const condition = expectation.expected.condition;
    const signatures = new Set(matching.map((row) => JSON.stringify([row.applicability, row.disposition, row.value ?? null, row.unitRef ?? null, row.uncertainty ?? null])));
    if (signatures.size > 1 && condition !== "CONFLICTING_DUPLICATE_METRIC_EVIDENCE") return unknown("QUALITY_DUPLICATE_EXACT_TUPLE_HAS_CONFLICTING_EVIDENCE");
    let matches = false;
    if (condition === "APPLICABLE_MEASUREMENT_WITH_VALUE") matches = matching.some((r) => r.applicability === "APPLICABLE" && ["PASS", "FAIL"].includes(r.disposition) && r.value !== null);
    else if (condition === "PARTIAL_OR_ABSTAINED_EVIDENCE") matches = matching.some((r) => ["ABSTAINED", "NOT_EVALUATED", "BLOCKED"].includes(r.applicability) || ["INDETERMINATE", "NOT_EVALUATED"].includes(r.disposition));
    else if (condition === "CONFLICTING_DUPLICATE_METRIC_EVIDENCE") {
      const values = new Set(matching.map((r) => JSON.stringify([r.disposition, r.value, r.unitRef ?? null])));
      matches = values.size > 1;
    } else if (condition === "APPLICABLE_DEFECT_METRIC_FAILED") {
      const defectMetrics = expectation.expected.metricRefs;
      if (!Array.isArray(defectMetrics) || !defectMetrics.includes(trusted.metricRef)) return unknown("QUALITY_DEFECT_METRIC_ID_UNRESOLVED");
      matches = matching.some((r) => r.applicability === "APPLICABLE" && r.disposition === "FAIL");
    } else return unknown("QUALITY_EXPECTATION_UNSUPPORTED");
    return { truth: matches ? "TRUE" : "FALSE", reason: matches ? "EXACT_TYPED_QUALITY_CONDITION_MATCH" : "EXACT_TYPED_QUALITY_CONDITION_DIFFERS", runtimeObservation: "UNKNOWN_UNTIL_QUERY_IMPLEMENTED", executionAdmission: "NOT_ADMITTED" };
  }

  if (kind === "OWNER_PROFILE_STATE") {
    const required = ["profileRef", "profileVersionRef", "targetRef", "domainRef"];
    if (!required.every((key) => nonEmptyString(trusted[key]))) return unknown("PROFILE_TRUSTED_TUPLE_INCOMPLETE");
    for (const key of required) if (result[key] !== trusted[key]) return unknown("PROFILE_QUALIFICATION_TUPLE_MISMATCH");
    if ((trusted.providerRef ?? null) !== (result.providerRef ?? null) || (trusted.scopeRef ?? null) !== (result.scopeRef ?? null)) return unknown("PROFILE_PROVIDER_OR_SCOPE_MISMATCH");
    const statuses = ["PROPOSAL_ONLY", "IMPLEMENTED_UNQUALIFIED", "OWNER_REVIEW_REQUIRED", "UNQUALIFIED", "QUALIFIED", "EXPIRED", "REVOKED", "UNKNOWN", "NOT_FOUND"];
    if (!statuses.includes(result.qualificationStatus) || !nonEmptyString(result.qualificationRecordRef) || !nonEmptyString(result.readVersion) || !Array.isArray(result.evidenceRefs) || result.evidenceRefs.length === 0 || !result.evidenceRefs.every(nonEmptyString)) return unknown("PROFILE_QUALIFICATION_EVIDENCE_INCOMPLETE");
    if (["UNKNOWN", "NOT_FOUND"].includes(result.qualificationStatus)) return unknown("PROFILE_QUALIFICATION_UNKNOWN_OR_NOT_FOUND");
    if (!canonicalInstant(result.validFrom) || !canonicalInstant(result.validUntil) || Date.parse(result.validFrom) > Date.parse(trusted.now) || Date.parse(trusted.now) >= Date.parse(result.validUntil)) return unknown("PROFILE_QUALIFICATION_WINDOW_INVALID");
    const matches = result.qualificationStatus === expectation.expected.qualificationStatus;
    return { truth: matches ? "TRUE" : "FALSE", reason: matches ? "EXACT_VERSIONED_PROFILE_STATUS_MATCH" : "EXACT_VERSIONED_PROFILE_STATUS_DIFFERS", runtimeObservation: "UNKNOWN_UNTIL_QUERY_IMPLEMENTED", executionAdmission: "NOT_ADMITTED" };
  }

  if (kind === "OWNER_PROVENANCE_STATE") {
    if (!nonEmptyString(trusted.subjectArtifactVersionRef) || result.subjectArtifactVersionRef !== trusted.subjectArtifactVersionRef) return unknown("PROVENANCE_SUBJECT_VERSION_MISMATCH");
    const statuses = ["OBSERVED", "PARTIAL", "ACCESS_LIMITED", "UNKNOWN", "NOT_FOUND"];
    const completeness = ["COMPLETE_FOR_REQUESTED_RELATIONS", "PARTIAL", "UNKNOWN", "NOT_EVALUATED"];
    const access = ["FULL", "LIMITED", "DENIED", "UNKNOWN"];
    const relations = ["DERIVED_FROM", "TRANSFORMED_FROM", "GENERATED_FROM", "INFERRED_FROM", "EXECUTED_BY", "AUTHORIZED_BY", "ASSESSED_BY"];
    if (!statuses.includes(result.observationStatus) || !completeness.includes(result.completeness) || !access.includes(result.accessDisposition) ||
        !Array.isArray(result.traversedRelationKinds) || result.traversedRelationKinds.some((r) => !relations.includes(r)) ||
        !Array.isArray(result.lineageEdges) || result.lineageEdges.some((e) => !exactKeys(e,["tenantScopeRef","fromArtifactVersionRef","toArtifactVersionRef","relationKind","sourceRecordRef","edgeDisposition"]) || e.tenantScopeRef !== trusted.tenantScopeRef || !relations.includes(e.relationKind) || !["VERIFIED","DECLARED","INFERRED","UNKNOWN"].includes(e.edgeDisposition) || !nonEmptyString(e.fromArtifactVersionRef) || !nonEmptyString(e.toArtifactVersionRef) || !nonEmptyString(e.sourceRecordRef))) return unknown("PROVENANCE_RESULT_SCHEMA_OR_TENANT_INVALID");
    if (["UNKNOWN", "NOT_FOUND"].includes(result.observationStatus) || result.completeness === "UNKNOWN" || result.completeness === "NOT_EVALUATED" || result.accessDisposition === "UNKNOWN") return unknown("PROVENANCE_QUERY_UNKNOWN_OR_NOT_FOUND");
    const requested=trusted.requestedRelationKinds;
    if (!Array.isArray(requested) || requested.length===0 || requested.some((r)=>!relations.includes(r))) return unknown("PROVENANCE_REQUESTED_RELATIONS_INVALID");
    if (result.traversedRelationKinds.some((r) => !requested.includes(r)) ||
        result.lineageEdges.some((e) => !requested.includes(e.relationKind))) return unknown("PROVENANCE_RESULT_ESCAPES_REQUESTED_RELATION_SCOPE");
    const relatedVersions = new Set([trusted.subjectArtifactVersionRef]);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const edge of result.lineageEdges) {
        if (relatedVersions.has(edge.fromArtifactVersionRef) && !relatedVersions.has(edge.toArtifactVersionRef)) { relatedVersions.add(edge.toArtifactVersionRef); expanded = true; }
        if (relatedVersions.has(edge.toArtifactVersionRef) && !relatedVersions.has(edge.fromArtifactVersionRef)) { relatedVersions.add(edge.fromArtifactVersionRef); expanded = true; }
      }
    }
    if (result.lineageEdges.some((e) => !relatedVersions.has(e.fromArtifactVersionRef) || !relatedVersions.has(e.toArtifactVersionRef))) return unknown("PROVENANCE_EDGE_NOT_CONNECTED_TO_EXACT_SUBJECT");
    const condition=expectation.expected.condition;
    let matches=false;
    if(condition==="COMPLETE_VERIFIED_REQUESTED_RELATIONS") matches=result.observationStatus==="OBSERVED"&&result.completeness==="COMPLETE_FOR_REQUESTED_RELATIONS"&&result.accessDisposition==="FULL"&&sameSet(requested,result.traversedRelationKinds)&&result.lineageEdges.every(e=>e.edgeDisposition==="VERIFIED");
    else if(condition==="PARTIAL_OR_REDACTED_OR_UNVERIFIED_RELATIONS") matches=result.observationStatus==="PARTIAL"||result.completeness==="PARTIAL"||["LIMITED","DENIED"].includes(result.accessDisposition)||result.lineageEdges.some(e=>e.edgeDisposition!=="VERIFIED");
    else if(condition==="REQUESTED_EXECUTED_BY_RELATION_COMPLETE_AND_ABSENT"){
      if(!requested.includes("EXECUTED_BY"))return unknown("PROVENANCE_EXECUTION_RELATION_NOT_REQUESTED");
      if(result.completeness!=="COMPLETE_FOR_REQUESTED_RELATIONS"||!result.traversedRelationKinds.includes("EXECUTED_BY"))return unknown("PROVENANCE_EXECUTION_RELATION_ABSENCE_NOT_COMPLETE");
      matches=!result.lineageEdges.some(e=>e.relationKind==="EXECUTED_BY");
    } else if(condition==="EXACT_VERIFIED_GENERATED_FROM_EDGE") matches=result.lineageEdges.some(e=>e.relationKind==="GENERATED_FROM"&&e.edgeDisposition==="VERIFIED");
    else if(condition==="EXACT_INFERRED_FROM_EDGE") matches=result.lineageEdges.some(e=>e.relationKind==="INFERRED_FROM"&&["INFERRED","DECLARED"].includes(e.edgeDisposition));
    else if(condition==="ACCESS_LIMITED_OR_DENIED") matches=["ACCESS_LIMITED","PARTIAL"].includes(result.observationStatus)||["LIMITED","DENIED"].includes(result.accessDisposition);
    else return unknown("PROVENANCE_EXPECTATION_UNSUPPORTED");
    if(condition==="COMPLETE_VERIFIED_REQUESTED_RELATIONS"&&!matches&&! ["COMPLETE_FOR_REQUESTED_RELATIONS", "PARTIAL"].includes(result.completeness))return unknown("PROVENANCE_COMPLETENESS_NOT_ESTABLISHED");
    if(condition==="PARTIAL_OR_REDACTED_OR_UNVERIFIED_RELATIONS"&&!matches&&! ["OBSERVED", "PARTIAL"].includes(result.observationStatus))return unknown("PROVENANCE_PARTIALITY_NOT_ESTABLISHED");
    return {truth:matches?"TRUE":"FALSE",reason:matches?"EXACT_SCOPED_PROVENANCE_CONDITION_MATCH":"EXACT_SCOPED_PROVENANCE_CONDITION_DIFFERS",runtimeObservation:"UNKNOWN_UNTIL_QUERY_IMPLEMENTED",executionAdmission:"NOT_ADMITTED"};
  }
  return unknown("OWNER_OBSERVATION_FAMILY_UNSUPPORTED");
}
