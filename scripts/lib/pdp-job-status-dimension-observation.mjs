import { createHash } from "node:crypto";
import { validateOwnerClosedJsonSchema } from "./pdp-owner-leaf-wire-validation.mjs";

const OPERATION_ID = "media.operation.job-status.read-dimensions.v1";
const AUTHORITY_REF = ".product-experience/pdp-1-domain-data/authority.yaml#ownerDefinedPdp10AuthorityScopes/jobStatusRead";
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonblank = (value) => typeof value === "string" && value.trim().length > 0;

function canonicalJson(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite JSON number.");
    return JSON.stringify(value);
  }
  if (!value || typeof value !== "object" || ancestors.has(value)) throw new TypeError("Non-JSON request value.");
  ancestors.add(value);
  let text;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new TypeError("Sparse or extended array.");
    text = `[${value.map((entry) => canonicalJson(entry, ancestors)).join(",")}]`;
  } else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError("Non-plain request object.");
    text = `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], ancestors)}`).join(",")}}`;
  }
  ancestors.delete(value);
  return text;
}

const digest = (value) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

function canonicalInstant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function resolveOperation(source) {
  const matches = source?.ownerDefinedOperationContracts?.records?.filter((row) => row?.id === OPERATION_ID) ?? [];
  return matches.length === 1 ? matches[0] : null;
}

function currentBasis(basis, result, host) {
  return isRecord(basis) && basis.operationRef === OPERATION_ID && basis.queryId === result.queryId
    && basis.requestFingerprint === result.requestFingerprint && basis.jobId === result.jobId
    && basis.tenantId === result.tenantId && basis.principalId === result.principalId
    && basis.readAuthorityRef === result.readAuthorityRef && basis.readVersion === result.readVersion
    && basis.currentness === "CURRENT" && canonicalInstant(basis.observedAt)
    && Date.parse(basis.observedAt) <= Date.parse(host.now)
    && Date.parse(host.now) - Date.parse(basis.observedAt) <= host.maxAgeMs;
}

function exactNegativeAndLifecycleBindings(result, request, host) {
  const dimensions = result.dimensions;
  const attempt = dimensions.attemptClaimAndLease;
  const uniqueKeysMatch = (rows, key, requested) => {
    if (!Array.isArray(rows) || rows.length !== requested.length) return false;
    const actual = rows.map((row) => row?.[key]);
    return actual.every(nonblank) && new Set(actual).size === actual.length
      && [...actual].sort().join("\u0000") === [...requested].sort().join("\u0000");
  };
  const stages = dimensions.stageProgress;
  const qualities = dimensions.qualityDisposition;
  const deliveries = dimensions.deliveryStatus;
  if (!uniqueKeysMatch(stages, "stageRef", request.stageRefs)
    || !uniqueKeysMatch(qualities, "subjectVersionRef", request.qualitySubjectVersionRefs)
    || !uniqueKeysMatch(deliveries, "destinationRef", request.destinationRefs)) return false;
  for (const stage of stages) {
    if (stage.kind !== "OBSERVED") continue;
    if (stage.state === "NOT_STARTED") {
      if (stage.basisKind !== "CURRENT_STAGE_PLAN_NO_ATTEMPT" || Object.hasOwn(stage, "attemptRef")
        || Object.hasOwn(stage, "fencingToken")) return false;
    } else if (stage.basisKind !== "CURRENT_STAGE_ATTEMPT_RECORD"
      || attempt.kind !== "OBSERVED" || stage.attemptRef !== attempt.attemptRef
      || stage.fencingToken !== attempt.fencingToken) return false;
  }
  for (const quality of qualities) {
    if (quality.kind !== "OBSERVED") continue;
    if (quality.value === "NOT_ASSESSED") {
      if (quality.basisKind !== "CURRENT_NEGATIVE_ASSESSMENT_READ" || Object.hasOwn(quality, "assessmentRef")) return false;
    } else if (quality.basisKind !== "CURRENT_ASSESSMENT_RECORD" || !nonblank(quality.assessmentRef)) return false;
  }
  for (const delivery of deliveries) {
    if (delivery.kind !== "OBSERVED") continue;
    const expectedDeliveryKind = delivery.value === "NOT_STARTED" ? "CURRENT_NEGATIVE_DELIVERY_RECORD" : "CURRENT_DELIVERY_STATUS_RECORD";
    if (delivery.basisKind !== expectedDeliveryKind) return false;
  }
  if (dimensions.attemptClaimAndLease.kind === "OBSERVED") {
    const lease = dimensions.attemptClaimAndLease;
    const expiry = Date.parse(lease.leaseExpiresAt);
    if ((lease.leaseState === "ACTIVE" && expiry <= Date.parse(host.now))
      || (lease.leaseState === "EXPIRED" && expiry > Date.parse(host.now))) return false;
  }
  for (const [key, expectedNegativeKind] of [
    ["cancellationOutcome", "CURRENT_NEGATIVE_CANCELLATION_READ"],
    ["remoteOutcomeCertainty", "CURRENT_NEGATIVE_DISPATCH_READ"],
  ]) {
    const value = dimensions[key];
    if (value.kind !== "OBSERVED") continue;
    if (value.value !== value.basis.value || !currentBasis(value.basis, result, host)) return false;
    const expectedKind = key === "cancellationOutcome"
      ? ({ NOT_REQUESTED: "CURRENT_NEGATIVE_CANCELLATION_READ", REQUESTED: "CURRENT_CANCELLATION_REQUEST", CONFIRMED: "CURRENT_CANCELLATION_STOP_RECEIPT" })[value.value]
      : ({ NOT_DISPATCHED: "CURRENT_NEGATIVE_DISPATCH_READ", MAY_HAVE_TAKEN_EFFECT: "CURRENT_DISPATCH_RECEIPT", AUTHORITATIVE_RESULT_OBSERVED: "CURRENT_AUTHORITATIVE_RESULT" })[value.value];
    if (value.basis.kind !== expectedKind || (expectedKind !== expectedNegativeKind && value.basis.kind === expectedNegativeKind)) return false;
  }
  return true;
}

/** Validate one normalized seven-dimension job read against host-trusted scope/currentness. */
export function validateJobStatusDimensionObservation(source, request, result, host) {
  const unknown = (reason) => ({ truth: "UNKNOWN", reason, dimensions: null });
  try {
    const operation = resolveOperation(source);
    if (!operation?.requestSchema || !operation?.resultSchema) return unknown("STATUS_QUERY_CONTRACT_UNRESOLVED");
    const requestCheck = validateOwnerClosedJsonSchema(operation.requestSchema, request);
    if (!requestCheck.valid) return unknown("STATUS_QUERY_REQUEST_INVALID");
    if (!isRecord(host)
      || !["tenantId", "principalId", "jobId", "queryId", "readAuthorityRef", "readVersion", "expectedResultDigest", "now"].every((key) => nonblank(host[key]))
      || !Number.isSafeInteger(host.maxAgeMs) || host.maxAgeMs < 0 || host.maxAgeMs > 30000
      || host.readAuthorityRef !== AUTHORITY_REF
      || !SHA256.test(host.expectedResultDigest)
      || !canonicalInstant(host.now)) return unknown("TRUSTED_STATUS_READ_CONTEXT_INVALID");
    if (request.queryId !== host.queryId || request.jobId !== host.jobId) return unknown("STATUS_REQUEST_HOST_SCOPE_MISMATCH");
    const resultCheck = validateOwnerClosedJsonSchema(operation.resultSchema, result);
    if (!resultCheck.valid) return unknown("STATUS_QUERY_RESULT_SCHEMA_REJECTED");
    const expectedFingerprint = digest(canonicalJson({
      operationRef: OPERATION_ID,
      request,
      tenantId: host.tenantId,
      principalId: host.principalId,
    }));
    if (result.operationRef !== OPERATION_ID || result.queryId !== host.queryId || result.jobId !== host.jobId
      || result.tenantId !== host.tenantId || result.principalId !== host.principalId
      || result.readAuthorityRef !== host.readAuthorityRef || result.readVersion !== host.readVersion
      || result.requestFingerprint !== expectedFingerprint) return unknown("STATUS_QUERY_RESULT_SCOPE_MISMATCH");
    if (result.currentness !== "CURRENT" || !canonicalInstant(result.observedAt)) return unknown("STATUS_QUERY_RESULT_NOT_CURRENT");
    const age = Date.parse(host.now) - Date.parse(result.observedAt);
    if (age < 0 || age > host.maxAgeMs) return unknown("STATUS_QUERY_RESULT_STALE_OR_FUTURE");
    const body = Object.fromEntries(Object.entries(result).filter(([key]) => key !== "resultDigest"));
    const computedResultDigest = digest(canonicalJson(body));
    if (result.resultDigest !== computedResultDigest || host.expectedResultDigest !== computedResultDigest) {
      return unknown("STATUS_QUERY_RESULT_DIGEST_MISMATCH");
    }
    if (result.outcome !== "OBSERVED") return unknown("STATUS_QUERY_OUTCOME_UNKNOWN");
    if (!exactNegativeAndLifecycleBindings(result, request, host)) return unknown("STATUS_QUERY_DIMENSION_EVIDENCE_MISMATCH");
    return { truth: "OBSERVED", reason: "CURRENT_TYPED_STATUS_DIMENSIONS", dimensions: result.dimensions };
  } catch {
    return unknown("MALFORMED_STATUS_QUERY_OBSERVATION");
  }
}

export { OPERATION_ID as JOB_STATUS_DIMENSION_OPERATION_ID, canonicalInstant as isCanonicalStatusInstant };
