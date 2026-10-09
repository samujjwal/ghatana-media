import { createHash } from "node:crypto";
import { validateOwnerClosedJsonSchema, resolveEffectiveCapabilityWireSchemas } from "./pdp-owner-leaf-wire-validation.mjs";
import { computeOwnerRequestSchemaDigest, computeOwnerSchemaClosureDigest } from "./pdp-tts-request-origin-binding.mjs";

const hasExactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const sha256 = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");

function canonicalJson(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite JSON number");
    return JSON.stringify(value);
  }
  if (!value || typeof value !== "object" || ancestors.has(value)) throw new TypeError("non-JSON value");
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new TypeError("sparse or extended JSON array");
    result = "[" + value.map((item) => canonicalJson(item, ancestors)).join(",") + "]";
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("non-plain JSON object");
    const keys = Object.keys(value).sort();
    result = "{" + keys.map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key], ancestors)).join(",") + "}";
  }
  ancestors.delete(value);
  return result;
}

function resolveExactCapabilityTarget(operations, accepted) {
  const matches = operations?.capabilityOperationContracts?.records?.filter((row) => row?.capabilityRef === accepted.capabilityRef) ?? [];
  if (matches.length !== 1) return { valid: false, reason: "TARGET_CAPABILITY_NOT_UNIQUE" };
  const capability = matches[0];
  if (capability.operationRefs?.filter((ref) => ref === accepted.targetOperationRef).length !== 1
    || capability.operationKind !== "COMMAND"
    || capability.asyncSubmissionDisposition !== "COMMAND_MAY_BE_SUBMITTED"
    || capability.operationVersion !== accepted.targetOperationVersion) {
    return { valid: false, reason: "TARGET_OPERATION_NOT_EXACTLY_SUBMITTABLE" };
  }
  try {
    const schemas = resolveEffectiveCapabilityWireSchemas(operations, accepted.capabilityRef);
    if (!schemas.valid || schemas.operation.id !== capability.id) return { valid: false, reason: "TARGET_EFFECTIVE_SCHEMA_UNRESOLVED" };
    const requestSchemaDigest = computeOwnerRequestSchemaDigest(operations, accepted.targetOperationRef, accepted.capabilityRef);
    const resultSchemaDigest = computeOwnerSchemaClosureDigest(
      operations,
      accepted.targetOperationRef,
      { resultSchema: schemas.resultSchema, outputSchemas: schemas.outputSchemas },
      "effectiveResultAndOutputSchemas",
    );
    return { valid: true, capability, schemas, requestSchemaDigest, resultSchemaDigest };
  } catch {
    return { valid: false, reason: "TARGET_SCHEMA_CLOSURE_INVALID" };
  }
}

function validInstant(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u.exec(value);
  if (!match) return false;
  const [, y, m, d, h, min, s, fraction = ""] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(h), Number(min), Number(s), Number((fraction + "000").slice(0, 3))));
  return date.getUTCFullYear() === Number(y) && date.getUTCMonth() === Number(m) - 1
    && date.getUTCDate() === Number(d) && date.getUTCHours() === Number(h)
    && date.getUTCMinutes() === Number(min) && date.getUTCSeconds() === Number(s);
}

/**
 * Validates a logical status-result adapter. Legacy JSON remains opaque and
 * UNKNOWN. Typed results are decoded only after an exact accepted-submit
 * snapshot selects the target schema. Schema compatibility alone never proves
 * provider execution, registration, or finality.
 */
export function validateJobResultObservation(operations, observation, trusted) {
  const unknown = (reason) => ({ truth: "UNKNOWN", reason, canonicalResult: null });
  try {
    if (!observation || typeof observation !== "object" || Array.isArray(observation)) return unknown("RESULT_OBSERVATION_NOT_CLOSED");
    if (observation.disposition === "UNVALIDATED_LEGACY_RESULT") {
      if (!hasExactKeys(observation, ["disposition", "rawJsonText"])
        || typeof observation.rawJsonText !== "string" || observation.rawJsonText.length > 1_048_576) {
        return unknown("LEGACY_RESULT_TEXT_INVALID");
      }
      return unknown("LEGACY_RESULT_PRESERVED_UNVALIDATED");
    }
    if (observation.disposition !== "TARGET_SCHEMA_VALIDATED"
      || !hasExactKeys(observation, ["disposition", "targetOperationRef", "targetOperationVersion", "targetSchemaDigest", "targetResultSchemaDigest", "resultJsonText"])
      || typeof observation.resultJsonText !== "string" || observation.resultJsonText.length === 0 || observation.resultJsonText.length > 1_048_576
      || !/^sha256:[a-f0-9]{64}$/u.test(observation.targetSchemaDigest)
      || !/^sha256:[a-f0-9]{64}$/u.test(observation.targetResultSchemaDigest)) return unknown("TARGET_RESULT_OBSERVATION_INVALID");
    if (!hasExactKeys(trusted, ["expectedScope", "acceptedRequest", "statusRead", "now", "maxAgeMs", "acceptedReadAuthorityAllowlist"])) return unknown("TRUSTED_JOB_CONTEXT_NOT_CLOSED");
    const expectedScope = trusted.expectedScope;
    const expectedScopeKeys = ["jobId", "requestId", "tenantId", "principalId", "requestFingerprint", "acceptedRequestSnapshotRef", "capabilityRef", "targetOperationRef", "targetOperationVersion", "targetSchemaDigest", "acceptedReadAuthorityRef", "acceptedReadVersion", "statusReadAuthorityRef", "statusReadVersion"];
    if (!hasExactKeys(expectedScope, expectedScopeKeys)
      || !["jobId", "requestId", "tenantId", "principalId", "acceptedRequestSnapshotRef", "capabilityRef", "targetOperationRef", "acceptedReadAuthorityRef", "statusReadAuthorityRef"].every((key) => nonempty(expectedScope[key]))
      || !/^sha256:[a-f0-9]{64}$/u.test(expectedScope.requestFingerprint)
      || !/^sha256:[a-f0-9]{64}$/u.test(expectedScope.targetSchemaDigest)
      || !nonempty(expectedScope.acceptedReadVersion) || !Number.isSafeInteger(expectedScope.targetOperationVersion)
      || !Number.isSafeInteger(expectedScope.statusReadVersion) || expectedScope.statusReadVersion < 1) return unknown("AUTHENTICATED_HOST_JOB_SCOPE_INVALID");
    const accepted = trusted.acceptedRequest;
    const acceptedKeys = ["jobId", "requestId", "tenantId", "principalId", "requestFingerprint", "acceptedRequestSnapshotRef", "capabilityRef", "targetOperationRef", "targetOperationVersion", "targetSchemaDigest", "readAuthorityRef", "readVersion", "observedAt", "currentness"];
    if (!hasExactKeys(accepted, acceptedKeys) || accepted.currentness !== "CURRENT"
      || !["jobId", "requestId", "tenantId", "principalId", "acceptedRequestSnapshotRef", "capabilityRef", "targetOperationRef", "readAuthorityRef"].every((key) => nonempty(accepted[key]))
      || !/^sha256:[a-f0-9]{64}$/u.test(accepted.requestFingerprint) || !/^sha256:[a-f0-9]{64}$/u.test(accepted.targetSchemaDigest)
      || !Number.isSafeInteger(accepted.targetOperationVersion) || accepted.targetOperationVersion < 1
      || !nonempty(accepted.readVersion)
      || !Array.isArray(trusted.acceptedReadAuthorityAllowlist) || !trusted.acceptedReadAuthorityAllowlist.includes(accepted.readAuthorityRef)
      || !validInstant(accepted.observedAt) || !validInstant(trusted.now)
      || !Number.isSafeInteger(trusted.maxAgeMs) || trusted.maxAgeMs < 0) return unknown("ACCEPTED_REQUEST_SNAPSHOT_INVALID_OR_STALE");
    if (accepted.jobId !== expectedScope.jobId || accepted.requestId !== expectedScope.requestId
      || accepted.tenantId !== expectedScope.tenantId || accepted.principalId !== expectedScope.principalId
      || accepted.requestFingerprint !== expectedScope.requestFingerprint
      || accepted.acceptedRequestSnapshotRef !== expectedScope.acceptedRequestSnapshotRef
      || accepted.capabilityRef !== expectedScope.capabilityRef || accepted.targetOperationRef !== expectedScope.targetOperationRef
      || accepted.targetOperationVersion !== expectedScope.targetOperationVersion
      || accepted.targetSchemaDigest !== expectedScope.targetSchemaDigest
      || accepted.readAuthorityRef !== expectedScope.acceptedReadAuthorityRef || accepted.readVersion !== expectedScope.acceptedReadVersion) {
      return unknown("ACCEPTED_REQUEST_SCOPE_MISMATCH");
    }
    const age = Date.parse(trusted.now) - Date.parse(accepted.observedAt);
    if (age < 0 || age > trusted.maxAgeMs) return unknown("ACCEPTED_REQUEST_SNAPSHOT_STALE_OR_FUTURE");
    const read = trusted.statusRead;
    const readKeys = ["jobId", "requestId", "tenantId", "principalId", "requestFingerprint", "readAuthorityRef", "readVersion", "observedAt", "currentness", "resultDigest"];
    if (!hasExactKeys(read, readKeys) || read.currentness !== "CURRENT"
      || !["jobId", "requestId", "tenantId", "principalId", "readAuthorityRef"].every((key) => nonempty(read[key]))
      || !Number.isSafeInteger(read.readVersion) || read.readVersion < 1 || !validInstant(read.observedAt)
      || !/^sha256:[a-f0-9]{64}$/u.test(read.resultDigest)) return unknown("STATUS_READ_NOT_BOUND_TO_ACCEPTED_REQUEST");
    if (read.jobId !== accepted.jobId || read.requestId !== accepted.requestId || read.tenantId !== accepted.tenantId
      || read.principalId !== accepted.principalId || read.requestFingerprint !== accepted.requestFingerprint
      || read.readAuthorityRef !== expectedScope.statusReadAuthorityRef || read.readVersion !== expectedScope.statusReadVersion) {
      return unknown("STATUS_READ_SCOPE_MISMATCH");
    }
    if (read.resultDigest !== sha256(observation.resultJsonText)) return unknown("STATUS_READ_RESULT_DIGEST_MISMATCH");
    const readAge = Date.parse(trusted.now) - Date.parse(read.observedAt);
    if (readAge < 0 || readAge > trusted.maxAgeMs) return unknown("STATUS_READ_STALE_OR_FUTURE");
    const resolved = resolveExactCapabilityTarget(operations, accepted);
    if (!resolved.valid || resolved.requestSchemaDigest !== accepted.targetSchemaDigest
      || observation.targetOperationRef !== accepted.targetOperationRef
      || observation.targetOperationVersion !== accepted.targetOperationVersion
      || observation.targetSchemaDigest !== resolved.requestSchemaDigest
      || observation.targetResultSchemaDigest !== resolved.resultSchemaDigest) return unknown("TARGET_SCHEMA_OR_ACCEPTED_OPERATION_BINDING_MISMATCH");
    const parsed = JSON.parse(observation.resultJsonText);
    if (canonicalJson(parsed) !== observation.resultJsonText) return unknown("TARGET_RESULT_JSON_NOT_CANONICAL");
    const validation = validateOwnerClosedJsonSchema(resolved.schemas.resultSchema, parsed);
    if (!validation.valid) return unknown("TARGET_RESULT_DOES_NOT_MATCH_EXACT_OWNER_SCHEMA");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [field, expected] of [
        ["operationRef", accepted.targetOperationRef],
        ["operationVersion", accepted.targetOperationVersion],
        ["requestId", accepted.requestId],
        ["capabilityRef", accepted.capabilityRef],
        ["jobId", accepted.jobId],
        ["tenantId", accepted.tenantId],
        ["principalId", accepted.principalId],
      ]) {
        if (Object.hasOwn(parsed, field) && parsed[field] !== expected) return unknown("TARGET_RESULT_IDENTITY_BINDING_MISMATCH");
      }
    }
    return {
      truth: "UNKNOWN",
      reason: "TARGET_RESULT_SCHEMA_VALIDATED_EFFECT_FINALITY_NOT_ESTABLISHED",
      canonicalResult: parsed,
      targetOperationRef: accepted.targetOperationRef,
      targetOperationVersion: accepted.targetOperationVersion,
      targetSchemaDigest: resolved.requestSchemaDigest,
      targetResultSchemaDigest: resolved.resultSchemaDigest,
    };
  } catch {
    return unknown("MALFORMED_JOB_RESULT_OBSERVATION");
  }
}

export function resolveSubmittedJobTarget(operations, accepted) {
  try { return resolveExactCapabilityTarget(operations, accepted); }
  catch { return { valid: false, reason: "TARGET_SCHEMA_CLOSURE_INVALID" }; }
}

export { canonicalJson as canonicalJobResultJson };
