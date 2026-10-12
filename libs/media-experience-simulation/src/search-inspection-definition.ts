/**
 * Small definition-only oracle for the P3 search and inspection contracts.
 * Every accepted input is synthetic fixture data; this module is not a runtime
 * search client, authorization provider, evidence verifier, or admission path.
 */

export type SearchInspectionDecision =
  | "OBSERVED"
  | "NO_MATCH"
  | "ACCESS_DENIED"
  | "UNKNOWN"
  | "STALE_OBSERVATION"
  | "INVALID_FIXTURE"
  | "NOT_FOUND_IN_CALLER_SCOPE";

export interface SearchInspectionDefinitionResult {
  readonly contractId: string;
  readonly decision: SearchInspectionDecision;
  readonly records: readonly Readonly<Record<string, unknown>>[];
  readonly reasons: readonly string[];
  readonly isSimulation: true;
  readonly effect: "NONE";
  readonly runtimeAdmission: "NOT_ADMITTED";
}

const SEARCH_CONTRACTS = new Set([
  "media.search.authorized-projects",
  "media.search.authorized-artifacts",
  "media.search.authorized-jobs",
]);
const INSPECTION_CONTRACTS = new Set([
  "media.inspection.authority",
  "media.inspection.evidence",
  "media.inspection.trace",
]);
const SEARCH_FILTERS: Readonly<Record<string, readonly string[]>> = {
  "media.search.authorized-projects": ["workspace-or-tenant", "project-visibility", "updated-at", "ownership"],
  "media.search.authorized-artifacts": ["tenant-project-scope", "media-kind", "integrity-status", "owner", "version", "time-range"],
  "media.search.authorized-jobs": ["job-kind", "status", "created-at", "source-version", "attempt", "owner"],
};
// These are the only fields the definition oracle accepts and returns for each
// search family. Keeping this closed prevents arbitrary fixture metadata from
// crossing the result boundary.
const SEARCH_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "media.search.authorized-projects": ["workspace-or-tenant", "project-visibility", "updated-at", "ownership"],
  "media.search.authorized-artifacts": ["tenant-project-scope", "media-kind", "integrity-status", "owner", "version", "time-range"],
  "media.search.authorized-jobs": ["job-kind", "status", "created-at", "source-version", "attempt", "owner"],
};
const SORTS: Readonly<Record<string, readonly string[]>> = {
  "media.search.authorized-projects": ["updated-at-descending-stable-id", "project-label-then-id"],
  "media.search.authorized-artifacts": ["created-at-descending-stable-id", "media-kind-then-id"],
  "media.search.authorized-jobs": ["updated-at-descending-stable-job-id"],
};
const SEARCH_AUTHORITY_CHECKS: Readonly<Record<string, readonly string[]>> = {
  "media.search.authorized-projects": ["identity", "tenant", "project", "visibility"],
  "media.search.authorized-artifacts": ["identity", "tenant", "project", "rights", "consent", "retention", "quarantine", "readPolicy"],
  "media.search.authorized-jobs": ["identity", "tenant", "job", "artifact"],
};
const INSPECTION_REQUIRED: Readonly<Record<string, readonly string[]>> = {
  "media.inspection.authority": ["tenantId", "projectId", "resourceId", "resourceVersion", "principalId", "policyIssuer"],
  "media.inspection.evidence": ["sourceVersion", "outputVersion", "assessmentProfile", "evidenceIssuer", "observationTime"],
  "media.inspection.trace": ["logicalJobId", "attemptIds", "sourceVersion", "evidenceFingerprint"],
};
const INSPECTION_SCOPE_CHECKS: Readonly<Record<string, readonly string[]>> = {
  "media.inspection.authority": ["resource", "policy"],
  "media.inspection.evidence": ["source", "output", "evidenceIssuer", "readPolicy"],
  "media.inspection.trace": ["job", "attempts", "source", "provenance", "readPolicy"],
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const exactKeys = (v: Obj, keys: readonly string[]) => Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(v);
const utc = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v;
const result = (contractId: string, decision: SearchInspectionDecision, reasons: string[], records: Obj[] = []): SearchInspectionDefinitionResult => ({
  contractId, decision, reasons, records, isSimulation: true, effect: "NONE", runtimeAdmission: "NOT_ADMITTED",
});

/**
 * Evaluates one of the three P3 search definitions against synthetic records.
 * Authorization is resolved before text/filter matching, and no counts or
 * suggestions are returned. Trusted context is an oracle input, not proof of
 * authenticated identity or current production policy.
 */
export function evaluateSearchDefinition(input: unknown): SearchInspectionDefinitionResult {
  if (!isObj(input) || !exactKeys(input, ["contractId", "request", "trusted", "records"]) ||
    typeof input.contractId !== "string" || !SEARCH_CONTRACTS.has(input.contractId) ||
    !isObj(input.request) || !isObj(input.trusted) || !Array.isArray(input.records)) {
    return result(typeof input === "object" && input !== null && "contractId" in input && typeof input.contractId === "string" ? input.contractId : "", "INVALID_FIXTURE", ["CLOSED_SEARCH_INPUT_REQUIRED"]);
  }
  const contractId = input.contractId;
  const request = input.request;
  const trusted = input.trusted;
  const allowedRequestKeys = ["queryText", "filters", "sort", "cursor"];
  const trustedKeys = ["tenantId", "principalId", "indexRevision", "observedAt", "now", "maxAgeMs"];
  if (!Object.keys(request).every((k) => allowedRequestKeys.includes(k)) ||
    !["filters", "sort"].every((k) => Object.hasOwn(request, k)) || !isObj(request.filters) ||
    !Object.keys(request.filters).every((k) => SEARCH_FILTERS[contractId]!.includes(k)) ||
    (request.queryText !== undefined && typeof request.queryText !== "string") ||
    (request.cursor !== undefined && !id(request.cursor)) || typeof request.sort !== "string" || !SORTS[contractId]!.includes(request.sort) ||
    !Object.keys(trusted).every((k) => trustedKeys.includes(k)) || !trustedKeys.every((k) => Object.hasOwn(trusted, k)) ||
    !id(trusted.tenantId) || !id(trusted.principalId) || !id(trusted.indexRevision) || !utc(trusted.observedAt) || !utc(trusted.now) ||
    !Number.isSafeInteger(trusted.maxAgeMs) || (trusted.maxAgeMs as number) < 0) {
    return result(contractId, "INVALID_FIXTURE", ["QUERY_OR_TRUSTED_CONTEXT_SHAPE_INVALID"]);
  }
  const age = Date.parse(trusted.now as string) - Date.parse(trusted.observedAt as string);
  if (age < 0 || age > (trusted.maxAgeMs as number)) return result(contractId, "STALE_OBSERVATION", ["INDEX_OBSERVATION_STALE_OR_FUTURE"]);
  const records = input.records;
  if (!records.every((row) => isObj(row) && exactKeys(row, ["id", "type", "tenantId", "principalId", "label", "fields", "authorization", "indexRevision", "observedAt"]))) {
    return result(contractId, "INVALID_FIXTURE", ["SEARCH_RECORD_SHAPE_INVALID"]);
  }
  const typedRows = records as Obj[];
  const expectedTypes: Readonly<Record<string, readonly string[]>> = {
    "media.search.authorized-projects": ["media.domain.project"],
    "media.search.authorized-artifacts": ["media.domain.artifact-version"],
    "media.search.authorized-jobs": ["media.domain.processing-job", "media.domain.artifact-verification-job"],
  };
  if (typedRows.some((row) => !id(row.id) || !id(row.tenantId) || !id(row.principalId) || typeof row.label !== "string" || !isObj(row.fields) ||
    !Object.keys(row.fields).every((key) => SEARCH_FIELDS[contractId]!.includes(key)) ||
    Object.values(row.fields).some((value) => !(typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))) ||
    !expectedTypes[contractId]!.includes(String(row.type)) || !isObj(row.authorization) ||
    !exactKeys(row.authorization, ["tenantId", "principalId", "resourceId", "checks", "policyVersion", "observedAt"]) ||
    !id(row.authorization.tenantId) || !id(row.authorization.principalId) || row.authorization.resourceId !== row.id ||
    !isObj(row.authorization.checks) || !exactKeys(row.authorization.checks, SEARCH_AUTHORITY_CHECKS[contractId]!) ||
    Object.values(row.authorization.checks).some((value) => !["ALLOW", "DENY", "UNKNOWN"].includes(String(value))) || !id(row.authorization.policyVersion) ||
    !utc(row.authorization.observedAt) || !id(row.indexRevision) || !utc(row.observedAt))) {
    return result(contractId, "INVALID_FIXTURE", ["SEARCH_RECORD_FACTS_INVALID"]);
  }
  // Foreign rows are ignored without indicating whether they exist. Any unknown
  // authority in the current trusted scope prevents disclosure of a partial view.
  const scoped = typedRows.filter((row) => row.tenantId === trusted.tenantId && row.principalId === trusted.principalId &&
    (row.authorization as Obj).tenantId === trusted.tenantId && (row.authorization as Obj).principalId === trusted.principalId);
  const authorityDisposition = (row: Obj): "ALLOW" | "DENY" | "UNKNOWN" => {
    const checks = row.authorization as Obj;
    const values = Object.values(checks.checks as Obj);
    return values.includes("UNKNOWN") ? "UNKNOWN" : values.includes("DENY") ? "DENY" : "ALLOW";
  };
  if (scoped.some((row) => authorityDisposition(row) === "UNKNOWN")) return result(contractId, "UNKNOWN", ["AUTHORITY_OBSERVATION_UNKNOWN"]);
  if (scoped.some((row) => authorityDisposition(row) === "ALLOW" &&
    (row.indexRevision !== trusted.indexRevision || (row.authorization as Obj).observedAt !== trusted.observedAt))) {
    return result(contractId, "STALE_OBSERVATION", ["INDEX_OR_AUTHORITY_REVISION_MISMATCH"]);
  }
  const permitted = scoped.filter((row) => authorityDisposition(row) === "ALLOW");
  const trustedObservationTime = Date.parse(trusted.observedAt as string);
  if (permitted.some((row) => {
    const rowObservedAt = Date.parse(row.observedAt as string);
    const rowAge = Date.parse(trusted.now as string) - rowObservedAt;
    return rowAge < 0 || rowAge > (trusted.maxAgeMs as number) || rowObservedAt > trustedObservationTime;
  })) return result(contractId, "STALE_OBSERVATION", ["RECORD_OBSERVATION_STALE_OR_OUTSIDE_INDEX"]);
  const ids = permitted.map((row) => row.id);
  if (new Set(ids).size !== ids.length) return result(contractId, "UNKNOWN", ["AMBIGUOUS_STABLE_ID"]);
  const query = (request.queryText as string | undefined)?.toLocaleLowerCase("en-US");
  const matches = permitted.filter((row) => {
    if (query && !`${row.id} ${row.label}`.toLocaleLowerCase("en-US").includes(query)) return false;
    return Object.entries(request.filters as Obj).every(([key, value]) => (row.fields as Obj)[key] === value);
  });
  return matches.length
    ? result(contractId, "OBSERVED", [], matches.map((row) => ({ id: row.id, type: row.type, label: row.label, fields: Object.fromEntries(
      Object.entries(row.fields as Obj).filter(([key]) => SEARCH_FIELDS[contractId]!.includes(key)),
    ) })))
    : result(contractId, "NO_MATCH", [scoped.some((row) => authorityDisposition(row) === "DENY") ? "NO_MATCH_OR_NOT_DISCLOSABLE" : "NO_MATCH"]);
}

/**
 * Exact-selector authority/evidence/trace inspection over synthetic typed
 * records. The fixture can exercise disclosure and unknown handling, but never
 * establishes actual authority, quality, provenance, event truth, or finality.
 */
export function evaluateInspectionDefinition(input: unknown): SearchInspectionDefinitionResult {
  if (!isObj(input) || !exactKeys(input, ["contractId", "selector", "trusted", "records"]) ||
    typeof input.contractId !== "string" || !INSPECTION_CONTRACTS.has(input.contractId) ||
    !isObj(input.selector) || !isObj(input.trusted) || !Array.isArray(input.records)) {
    return result(typeof input === "object" && input !== null && "contractId" in input && typeof input.contractId === "string" ? input.contractId : "", "INVALID_FIXTURE", ["CLOSED_INSPECTION_INPUT_REQUIRED"]);
  }
  const contractId = input.contractId;
  const selector = input.selector;
  const trusted = input.trusted;
  const required = INSPECTION_REQUIRED[contractId]!;
  if (!exactKeys(selector, required) || required.some((k) => k === "attemptIds"
      ? !Array.isArray(selector[k]) || (selector[k] as unknown[]).length === 0 || !(selector[k] as unknown[]).every(id)
      : k === "observationTime" ? !utc(selector[k]) : !id(selector[k])) ||
    !exactKeys(trusted, ["tenantId", "principalId", "now", "maxAgeMs"]) || !id(trusted.tenantId) || !id(trusted.principalId) ||
    !utc(trusted.now) || !Number.isSafeInteger(trusted.maxAgeMs) || (trusted.maxAgeMs as number) < 0) {
    return result(contractId, "INVALID_FIXTURE", ["EXACT_INSPECTION_SELECTOR_REQUIRED"]);
  }
  const records = input.records;
  if (!records.every((row) => isObj(row) && exactKeys(row, ["tenantId", "principalId", "selector", "scopeChecks", "issuer", "observedAt", "facts"]))) {
    return result(contractId, "INVALID_FIXTURE", ["INSPECTION_RECORD_SHAPE_INVALID"]);
  }
  const typedRows = records as Obj[];
  if (typedRows.some((row) => !id(row.tenantId) || !id(row.principalId) || !isObj(row.selector) ||
    !isObj(row.scopeChecks) || !exactKeys(row.scopeChecks, INSPECTION_SCOPE_CHECKS[contractId]!) ||
    Object.values(row.scopeChecks).some((value) => !["ALLOW", "DENY", "UNKNOWN"].includes(String(value))) ||
    !id(row.issuer) || !utc(row.observedAt) || !isObj(row.facts))) {
    return result(contractId, "INVALID_FIXTURE", ["INSPECTION_FACTS_INVALID"]);
  }
  const scoped = typedRows.filter((row) => row.tenantId === trusted.tenantId && row.principalId === trusted.principalId);
  const scopeDisposition = (row: Obj): "ALLOW" | "DENY" | "UNKNOWN" => {
    const values = Object.values(row.scopeChecks as Obj);
    return values.includes("UNKNOWN") ? "UNKNOWN" : values.includes("DENY") ? "DENY" : "ALLOW";
  };
  if (scoped.some((row) => scopeDisposition(row) === "UNKNOWN")) return result(contractId, "UNKNOWN", ["INSPECTION_AUTHORITY_OR_EVIDENCE_UNKNOWN"]);
  const exact = scoped.filter((row) => required.every((key) => (row.selector as Obj)[key] === selector[key]));
  if (exact.length > 1) return result(contractId, "UNKNOWN", ["AMBIGUOUS_EXACT_INSPECTION_RECORD"]);
  if (exact.length === 0 || scopeDisposition(exact[0]!) === "DENY") {
    return result(contractId, "NOT_FOUND_IN_CALLER_SCOPE", ["NOT_FOUND_OR_NOT_DISCLOSABLE"]);
  }
  const row = exact[0]!;
  const age = Date.parse(trusted.now as string) - Date.parse(row.observedAt as string);
  if (age < 0 || age > (trusted.maxAgeMs as number)) return result(contractId, "STALE_OBSERVATION", ["INSPECTION_OBSERVATION_STALE_OR_FUTURE"]);
  const safeFacts = { ...(row.facts as Obj) };
  // Evidence qualification is observational; presence never means approval.
  if (contractId === "media.inspection.evidence" && "disposition" in safeFacts &&
    !["PASS", "FAIL", "INDETERMINATE", "UNKNOWN", "NOT_QUALIFIED"].includes(String(safeFacts.disposition))) {
    return result(contractId, "INVALID_FIXTURE", ["EVIDENCE_DISPOSITION_INVALID"]);
  }
  if (contractId === "media.inspection.authority" &&
    (!exactKeys(safeFacts, ["resourceRef", "redactedMetadata"]) || !id(safeFacts.resourceRef) || !isObj(safeFacts.redactedMetadata))) {
    return result(contractId, "INVALID_FIXTURE", ["AUTHORITY_PROJECTION_MUST_BE_REDACTED"]);
  }
  if (contractId === "media.inspection.evidence" &&
    (!exactKeys(safeFacts, ["metricDomain", "sourceRef", "disposition"]) || !id(safeFacts.metricDomain) || !id(safeFacts.sourceRef) ||
      !["PASS", "FAIL", "INDETERMINATE", "UNKNOWN", "NOT_QUALIFIED"].includes(String(safeFacts.disposition)))) {
    return result(contractId, "INVALID_FIXTURE", ["EVIDENCE_SOURCE_AND_METRIC_DOMAIN_REQUIRED"]);
  }
  if (contractId === "media.inspection.trace" &&
    (!exactKeys(safeFacts, ["origin", "freshness", "attemptStatus"]) || !id(safeFacts.origin) ||
      !["CURRENT", "STALE", "UNKNOWN"].includes(String(safeFacts.freshness)) || !id(safeFacts.attemptStatus))) {
    return result(contractId, "INVALID_FIXTURE", ["TRACE_ORIGIN_AND_FRESHNESS_REQUIRED"]);
  }
  // Trace records expose only explicitly supplied observations, never inferred finality.
  return result(contractId, "OBSERVED", [], [{ selector: { ...selector }, issuer: row.issuer, observedAt: row.observedAt, facts: safeFacts }]);
}
