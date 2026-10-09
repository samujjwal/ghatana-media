const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
  Reflect.ownKeys(value).every((key) => typeof key === "string" &&
    Object.getOwnPropertyDescriptor(value, key)?.enumerable &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value"));

const exactKeys = (value, keys) => isRecord(value) && Reflect.ownKeys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const text = (value) => typeof value === "string" && value.trim().length > 0;
const canonicalUtc = (value) => typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

const held = (reason) => ({
  disposition: "HOLD_UNKNOWN",
  reason,
  projectRefs: [],
  nextPageToken: null,
  projectMutation: "NONE",
  runtimeAdmission: "NOT_ADMITTED",
});

/**
 * Definition-only projection for the J-01 list-projects query. `trustedContext`
 * is an out-of-band host adapter input; this helper does not authenticate it,
 * evaluate policy, or establish that any endpoint produced the result.
 */
export function evaluateProjectListObservation(definition, request, result, trustedContext) {
  if (!isRecord(definition) || definition.id !== "media.project-list-observation.v1" ||
      definition.operationRef !== "media.operation-slice.list-projects" ||
      !(exactKeys(request, ["workspaceId"]) || exactKeys(request, ["workspaceId", "pageToken"])) ||
      !isRecord(trustedContext) || !exactKeys(trustedContext, [
        "tenantId", "principalId", "selectedAuthorizedWorkspaceId", "projectReadAuthorityRef", "authorityObservation",
        "serverComputedQueryFingerprint", "snapshotRefForPageToken",
      ])) return held("MALFORMED_OR_NONCLOSED_QUERY_INPUT");

  if (!text(trustedContext.tenantId) || !text(trustedContext.principalId) ||
      !text(trustedContext.selectedAuthorizedWorkspaceId) ||
      trustedContext.projectReadAuthorityRef !== ".product-experience/pdp-1-domain-data/authority.yaml#ownership.identityAuthenticationAndDelegation" ||
      !isRecord(trustedContext.authorityObservation) ||
      !exactKeys(trustedContext.authorityObservation, ["disposition", "subjectTenantId", "subjectPrincipalId", "workspaceId", "authorityRef", "evidenceRef"]) ||
      trustedContext.authorityObservation.subjectTenantId !== trustedContext.tenantId ||
      trustedContext.authorityObservation.subjectPrincipalId !== trustedContext.principalId ||
      trustedContext.authorityObservation.workspaceId !== trustedContext.selectedAuthorizedWorkspaceId ||
      trustedContext.authorityObservation.authorityRef !== trustedContext.projectReadAuthorityRef ||
      !text(trustedContext.authorityObservation.evidenceRef) ||
      !["CURRENT_ALLOWED", "DENIED", "STALE", "UNKNOWN"].includes(trustedContext.authorityObservation.disposition)) return held("TRUSTED_PROJECT_READ_AUTHORITY_NOT_CURRENT_FOR_EXACT_SCOPE");
  if (trustedContext.authorityObservation.disposition === "DENIED") return {
    disposition: "DENIED",
    reason: "EXACT_SCOPED_PROJECT_READ_AUTHORITY_DENIED",
    projectRefs: [],
    nextPageToken: null,
    projectMutation: "NONE",
    runtimeAdmission: "NOT_ADMITTED",
  };
  if (trustedContext.authorityObservation.disposition !== "CURRENT_ALLOWED") return held("TRUSTED_PROJECT_READ_AUTHORITY_STALE_OR_UNKNOWN");

  if (request.workspaceId !== trustedContext.selectedAuthorizedWorkspaceId ||
      (Object.hasOwn(request, "pageToken") && !text(request.pageToken))) return held("QUERY_SCOPE_MISMATCH");
  if (!isRecord(result) || result.operationRef !== definition.operationRef) return held("QUERY_RESULT_OPERATION_MISMATCH");
  if (result.outcome === "UNKNOWN_OBSERVATION") {
    if (!exactKeys(result, ["operationRef", "outcome", "reason"]) ||
        !["AUTHORITY_UNAVAILABLE", "SNAPSHOT_UNAVAILABLE", "PAGE_TOKEN_INVALID", "QUERY_UNAVAILABLE"].includes(result.reason)) return held("UNKNOWN_QUERY_RESULT_SHAPE_INVALID");
    return {
      disposition: "HOLD_UNKNOWN",
      reason: result.reason,
      projectRefs: [],
      nextPageToken: null,
      projectMutation: "NONE",
      runtimeAdmission: "NOT_ADMITTED",
    };
  }
  if (result.outcome !== "OBSERVED" ||
      !exactKeys(result, ["operationRef", "outcome", "tenantId", "principalId", "workspaceId", "queryFingerprint", "snapshotRef", "observedAt", "records", "nextPageToken"]) ||
      !canonicalUtc(result.observedAt) || !Array.isArray(result.records) || result.records.length > 1000 ||
      (result.nextPageToken !== null && (!text(result.nextPageToken) || result.nextPageToken.length > 2048))) return held("QUERY_RESULT_SHAPE_INVALID");
  if (result.tenantId !== trustedContext.tenantId || result.principalId !== trustedContext.principalId ||
      result.workspaceId !== request.workspaceId || result.queryFingerprint !== trustedContext.serverComputedQueryFingerprint ||
      !/^sha256:[a-f0-9]{64}$/u.test(result.queryFingerprint) || !text(result.snapshotRef) ||
      (Object.hasOwn(request, "pageToken") && trustedContext.snapshotRefForPageToken !== result.snapshotRef)) return held("QUERY_RESULT_IDENTITY_FINGERPRINT_OR_SNAPSHOT_MISMATCH");

  const ids = new Set();
  for (const project of result.records) {
    if (!exactKeys(project, ["projectId", "workspaceId", "title", "headRevisionId", "projectState"]) ||
        !text(project.projectId) || ids.has(project.projectId) ||
        project.workspaceId !== trustedContext.selectedAuthorizedWorkspaceId ||
        typeof project.title !== "string" || project.title.length < 1 || project.title.length > 255 ||
        !text(project.headRevisionId) ||
        !["ACTIVE", "ARCHIVED"].includes(project.projectState)) return held("PROJECT_SUMMARY_INVALID_OR_OUT_OF_SCOPE");
    ids.add(project.projectId);
  }

  const disposition = result.records.length > 0
    ? "AUTHORIZED_QUERY_PAGE_NONEMPTY"
    : result.nextPageToken !== null
      ? "AUTHORIZED_QUERY_PAGE_EMPTY_MORE_RESULTS_POSSIBLE"
      : "AUTHORIZED_QUERY_PAGE_EMPTY_TERMINAL";
  return {
    disposition,
    reason: "SCOPED_PAGE_OBSERVATION_ONLY_NOT_GLOBAL_ABSENCE_OR_FUTURE_CURRENTNESS",
    projectRefs: result.records.map((project) => `media.domain.project:${project.projectId}`),
    observedAt: result.observedAt,
    nextPageToken: result.nextPageToken,
    projectMutation: "NONE",
    runtimeAdmission: "NOT_ADMITTED",
  };
}
