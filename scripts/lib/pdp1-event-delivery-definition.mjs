import { createHash } from "node:crypto";

const fingerprintPattern = /^[a-f0-9]{64}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const nonblank = (value) => typeof value === "string" && value.trim().length > 0;

function completeTuple(tuple) {
  return tuple && ["tenantId", "streamId", "eventId", "eventType", "eventVersion", "aggregateType", "aggregateId", "payloadFingerprint", "publisherAuthorityRef", "lookupAuthorityRef"]
    .every((key) => nonblank(tuple[key]))
    && Number.isSafeInteger(tuple.aggregateVersion) && tuple.aggregateVersion > 0
    && fingerprintPattern.test(tuple.payloadFingerprint);
}

function matchesTuple(observation, expected) {
  return observation && ["tenantId", "streamId", "eventId", "eventType", "eventVersion", "aggregateType", "aggregateId", "payloadFingerprint"]
    .every((key) => observation[key] === expected[key])
    && observation.aggregateVersion === expected.aggregateVersion;
}

function validUtcInstant(value) {
  const match = typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/u.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return false;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function exactLookupReceipt(lookup, expected) {
  const request = expected.lookupRequest;
  const result = lookup?.queryBinding;
  const receipt = lookup?.readReceipt;
  if (!request || !result || !receipt || !nonblank(request.queryId) || !fingerprintPattern.test(request.requestFingerprint ?? "")
    || request.authorityRef !== expected.lookupAuthorityRef || !validUtcInstant(request.now)
    || !Number.isSafeInteger(request.maxAgeMs) || request.maxAgeMs < 0) return false;
  const canonicalRequest = JSON.stringify([expected.tenantId, expected.streamId, expected.eventId, request.queryId, request.authorityRef]);
  const expectedFingerprint = createHash("sha256").update(canonicalRequest).digest("hex");
  if (request.requestFingerprint !== expectedFingerprint) return false;
  if (["tenantId", "streamId", "eventId", "queryId", "requestFingerprint", "authorityRef"].some((key) => result[key] !== (key === "authorityRef" ? request.authorityRef : key === "tenantId" ? expected.tenantId : key === "streamId" ? expected.streamId : key === "eventId" ? expected.eventId : request[key]))) return false;
  if (receipt.authorityRef !== expected.lookupAuthorityRef || receipt.queryId !== request.queryId
    || receipt.requestFingerprint !== request.requestFingerprint || !nonblank(receipt.readVersion)
    || !validUtcInstant(receipt.observedAt) || !validUtcInstant(receipt.now) || receipt.now !== request.now
    || receipt.currentness !== "AUTHORITATIVE_CURRENT_COMPLETE_READ") return false;
  const observedMs = Date.parse(receipt.observedAt);
  const nowMs = Date.parse(request.now);
  return observedMs <= nowMs && nowMs - observedMs <= request.maxAgeMs;
}

/**
 * Definition-only fail-closed oracle for Media's event append/reconciliation boundary.
 * This does not model or attest a deployed Event Plane or Media outbox.
 */
export function evaluateMediaEventDelivery({ expected, append, lookup } = {}) {
  if (!completeTuple(expected)) return { disposition: "UNKNOWN", reason: "INCOMPLETE_OR_INVALID_TRUSTED_EXPECTED_TUPLE" };

  if (append?.status === 201) {
    const response = append.response;
    const binding = append.trustedRequestBinding;
    const validResponse = response && response.eventId === expected.eventId
      && response.streamId === expected.streamId
      && uuidPattern.test(response.storedEventId ?? "")
      && typeof response.offset === "string" && /^(0|[1-9][0-9]*)$/u.test(response.offset);
    if (validResponse && append.authorityRef === expected.publisherAuthorityRef && matchesTuple(binding, expected)) {
      return { disposition: "EVENT_PLANE_ACCEPTED", source: "EXACT_APPEND_RECEIPT" };
    }
    return { disposition: "UNKNOWN_QUARANTINE", reason: "APPEND_RECEIPT_OR_TRUSTED_REQUEST_BINDING_MISMATCH" };
  }

  const definitiveRejection = append?.status === 400 || append?.status === 401;
  if (definitiveRejection && append.authorityRef === expected.publisherAuthorityRef
    && matchesTuple(append.trustedRequestBinding, expected)) {
    return { disposition: "NOT_ACCEPTED_RETAIN_INTENT", reason: "EXACT_HOST_BOUND_VALIDATION_OR_AUTH_REJECTION; RETAIN_INTENT_FOR_CORRECTION" };
  }

  if (lookup?.outcome === "MATCHED_RECORD" && exactLookupReceipt(lookup, expected)
    && matchesTuple(lookup.recordBinding, expected)) {
    return { disposition: "RECONCILED_ACCEPTED", source: "EXACT_CURRENT_LOOKUP" };
  }
  return {
    disposition: "UNKNOWN_RETAIN_INTENT",
    reason: lookup?.outcome === "NOT_FOUND"
      ? "NOT_FOUND_WITHOUT_EXACT_CURRENT_COMPLETE_ABSENCE_RECEIPT"
      : "NO_EXACT_CURRENT_TUPLE_MATCH",
    automaticAppendRetry: "FORBIDDEN_UNTIL_SHARED_CONTRACT_RECONCILES_RETRY_SEMANTICS",
  };
}

export function acceptsMediaEventForOutbox({ event, payloadFingerprint, aggregateVersion, transaction } = {}) {
  if (!event || !nonblank(event.eventId) || !nonblank(event.eventType) || !nonblank(event.eventVersion) || !nonblank(event.tenantId)
    || !nonblank(event.aggregateType) || !nonblank(event.aggregateId)
    || !fingerprintPattern.test(payloadFingerprint ?? "")
    || !Number.isSafeInteger(aggregateVersion) || aggregateVersion < 1) return false;
  return transaction?.aggregateCommitted === true
    && transaction?.outboxCommitted === true
    && transaction?.sameAtomicCommit === true
    && transaction?.tenantId === event.tenantId
    && transaction?.eventId === event.eventId
    && transaction?.eventType === event.eventType
    && transaction?.eventVersion === event.eventVersion
    && transaction?.payloadFingerprint === payloadFingerprint
    && transaction?.aggregateType === event.aggregateType
    && transaction?.aggregateId === event.aggregateId
    && transaction?.aggregateVersion === aggregateVersion;
}

export function classifyMediaEventReplay({ existing, candidate } = {}) {
  const valid = (value) => value && ["tenantId", "eventId", "eventType", "eventVersion", "aggregateType", "aggregateId"]
    .every((key) => nonblank(value[key])) && fingerprintPattern.test(value.payloadFingerprint ?? "")
    && Number.isSafeInteger(value.aggregateVersion) && value.aggregateVersion > 0;
  if (!valid(existing) || !valid(candidate)) return "UNKNOWN_INVALID_EVENT_IDENTITY_OR_FINGERPRINT";
  if (existing.tenantId !== candidate.tenantId || existing.eventId !== candidate.eventId) return "DISTINCT_EVENT_INTENT";
  if (existing.eventType !== candidate.eventType || existing.eventVersion !== candidate.eventVersion || existing.aggregateType !== candidate.aggregateType
    || existing.aggregateId !== candidate.aggregateId || existing.aggregateVersion !== candidate.aggregateVersion
    || existing.payloadFingerprint !== candidate.payloadFingerprint) return "EVENT_ID_CONFLICT";
  return "DUPLICATE_SAME_EVENT_NOOP";
}

export function classifyMediaAggregateOrder({ previousVersion, candidateVersion } = {}) {
  if (!Number.isSafeInteger(previousVersion) || previousVersion < 0
    || !Number.isSafeInteger(candidateVersion) || candidateVersion < 1) return "UNKNOWN_INVALID_AGGREGATE_VERSION";
  if (candidateVersion <= previousVersion) return "REJECT_STALE_OR_DUPLICATE_VERSION";
  if (candidateVersion !== previousVersion + 1) return "HOLD_GAP_FOR_RECONCILIATION";
  return "ACCEPT_NEXT_AGGREGATE_VERSION";
}
