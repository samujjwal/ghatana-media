import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import {
  acceptsMediaEventForOutbox,
  classifyMediaAggregateOrder,
  classifyMediaEventReplay,
  evaluateMediaEventDelivery,
} from "../scripts/lib/pdp1-event-delivery-definition.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const sharedRoot = resolve(root, "../ghatana");
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
function eventPlaneStoredId(callerEventId) {
  const bytes = createHash("md5").update(callerEventId, "utf8").digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function source() {
  return parse(read(".product-experience/pdp-1-domain-data/events.yaml"));
}

function evidenceSource() {
  return parse(read(".product-experience/pdp-1-domain-data/evidence.yaml"));
}

function provenanceSource() {
  return parse(read(".product-experience/pdp-1-domain-data/provenance.yaml"));
}

function sample() {
  const expected = {
    tenantId: "tenant-a", streamId: "media-lifecycle", eventId: "media:job.completed:job-7:4",
    eventType: "media.job.completed", eventVersion: "1.0.0", aggregateType: "job", aggregateId: "job-7", aggregateVersion: 4,
    payloadFingerprint: "a".repeat(64), publisherAuthorityRef: ".product-experience/pdp-1-domain-data/events.yaml#ownerEventContracts/records/@id=media.event-contract.media-job-completed/producer",
    lookupAuthorityRef: "../ghatana/services/event-plane/contracts/openapi/event-plane.yaml#/paths/~1api~1v1~1streams~1{streamId}~1events~1{eventId}/get/x-ghatana-security",
  };
  expected.storedEventId = eventPlaneStoredId(expected.eventId);
  const queryId = "read-event-7";
  const now = "2026-10-09T12:00:00.000Z";
  const requestFingerprint = sha256(JSON.stringify([expected.tenantId, expected.streamId, expected.eventId, queryId, expected.lookupAuthorityRef]));
  expected.lookupRequest = { queryId, requestFingerprint, authorityRef: expected.lookupAuthorityRef, now, maxAgeMs: 30_000 };
  return { expected, binding: structuredClone(expected) };
}

function exactLookup(expected, binding, overrides = {}) {
  return {
    outcome: "MATCHED_RECORD",
    queryBinding: { tenantId: expected.tenantId, streamId: expected.streamId, eventId: expected.eventId,
      queryId: expected.lookupRequest.queryId, requestFingerprint: expected.lookupRequest.requestFingerprint,
      authorityRef: expected.lookupAuthorityRef },
    readReceipt: { authorityRef: expected.lookupAuthorityRef, queryId: expected.lookupRequest.queryId,
      requestFingerprint: expected.lookupRequest.requestFingerprint, readVersion: "read-v9",
      observedAt: "2026-10-09T11:59:50.000Z", now: expected.lookupRequest.now,
      currentness: "AUTHORITATIVE_CURRENT_COMPLETE_READ" },
    recordBinding: binding,
    ...overrides,
  };
}

test("P1-08 binds the exact public Event Plane append and lookup dependency without claiming runtime readiness", () => {
  const events = source();
  const protocol = events.ownerEventContracts.deliveryProtocol;
  assert.equal(protocol.id, "media.event-delivery-protocol.definition.v1");
  assert.equal(protocol.status, "OWNER_DEFINED_DEFINITION_ONLY");
  assert.equal(protocol.eventPlaneDependency.executionAdmission, "NOT_ADMITTED");
  assert.equal(protocol.externalOwnerReviewRequest.id, "media.event-dependency-review.event-plane-retry-reconciliation.v1");
  assert.equal(protocol.externalOwnerReviewRequest.status, "PENDING_SHARED_CONTRACT_RECONCILIATION");
  assert.equal(protocol.externalOwnerReviewRequest.requiredContractEvidence.length, 4);
  assert.match(protocol.externalOwnerReviewRequest.MediaDispositionUntilClosed, /UNKNOWN/u);
  assert.deepEqual(protocol.eventPlaneDependency.publicContractRefs, [
    "../ghatana/services/event-plane/contracts/openapi/event-plane.yaml#/paths/~1api~1v1~1streams~1{streamId}~1events/post",
    "../ghatana/services/event-plane/contracts/openapi/event-plane.yaml#/paths/~1api~1v1~1streams~1{streamId}~1events~1{eventId}/get",
    "../ghatana/services/event-plane/contracts/openapi/event-plane.yaml#/components/schemas/AppendEventRequest",
    "../ghatana/services/event-plane/contracts/openapi/event-plane.yaml#/components/schemas/AppendEventResponse",
    "../ghatana/services/event-plane/contracts/openapi/event-plane.yaml#/components/schemas/EventRecord",
  ]);
  assert.equal(protocol.eventPlaneDependency.ownerServiceRequirementRef,
    "../ghatana/services/event-plane/service-contract.yaml#/requirements/@id=EVT-EXACT-LOOKUP-001");
  assert.deepEqual(protocol.eventPlaneDependency.exactLookup.requiredHostVerifiedReadReceipt.fields,
    ["tenantId", "streamId", "eventId", "queryId", "requestFingerprint", "readAuthorityRef", "readVersion", "observedAt", "observedAtCurrentness"]);
  assert.match(protocol.eventPlaneDependency.exactLookup.requiredHostVerifiedReadReceipt.admission, /NOT_ADMITTED/u);

  const apiText = readFileSync(resolve(sharedRoot, "services/event-plane/contracts/openapi/event-plane.yaml"), "utf8");
  const serviceText = readFileSync(resolve(sharedRoot, "services/event-plane/service-contract.yaml"), "utf8");
  assert.equal(sha256(apiText), protocol.eventPlaneDependency.sourceFingerprints.openApiSha256);
  assert.equal(sha256(serviceText), protocol.eventPlaneDependency.sourceFingerprints.serviceContractSha256);
  assert.match(protocol.eventPlaneDependency.sourceFingerprints.ownerRepositoryHead, /^[a-f0-9]{40}$/u);
  assert.match(protocol.eventPlaneDependency.sourceFingerprints.latestRelevantContractChange, /^[a-f0-9]{40}$/u);
  for (const sourcePath of ["services/event-plane/contracts/openapi/event-plane.yaml", "services/event-plane/service-contract.yaml"]) {
    const pinned = execFileSync("git", ["-C", sharedRoot, "show", `${protocol.eventPlaneDependency.sourceFingerprints.ownerRepositoryHead}:${sourcePath}`], { encoding: "utf8" });
    assert.equal(sha256(pinned), sha256(readFileSync(resolve(sharedRoot, sourcePath), "utf8")), `${sourcePath} matches the recorded clean owner revision`);
  }
  const api = parse(apiText);
  const service = parse(serviceText);
  const append = api.paths["/api/v1/streams/{streamId}/events"].post;
  const exactLookup = api.paths["/api/v1/streams/{streamId}/events/{eventId}"].get;
  const exactLookupRequirement = service.requirements.find(({ id }) => id === "EVT-EXACT-LOOKUP-001");
  assert.equal(append.operationId, "appendStreamEvent");
  assert.equal(append.responses["201"].content["application/json"].schema.$ref, "#/components/schemas/AppendEventResponse");
  const appendReceipt = api.components.schemas.AppendEventResponse;
  const eventRecord = api.components.schemas.EventRecord;
  assert.deepEqual(appendReceipt.required, ["eventId", "storedEventId", "streamId", "offset"]);
  assert.ok(eventRecord.required.includes("callerEventId"));
  assert.ok(eventRecord.required.includes("eventId"), "EventRecord.eventId is the stored UUID, separate from callerEventId");
  assert.match(protocol.eventPlaneDependency.requiredAppendReceipt.acceptanceRule, /storedEventId.*stable UUID mapping/u);
  assert.match(protocol.eventPlaneDependency.exactLookup.matchingRecordRule, /callerEventId.*stable UUID mapping/u);
  assert.equal(exactLookup.operationId, "getStreamEvent");
  assert.deepEqual(exactLookup["x-ghatana-security"].requiredPermissions, ["event-plane:event:read"]);
  assert.match(protocol.eventPlaneDependency.exactLookup.authorityRef, /events~1\{eventId\}\/get\/x-ghatana-security$/u);
  assert.equal(exactLookupRequirement?.id, "EVT-EXACT-LOOKUP-001");
  assert.equal(append["x-ghatana-idempotency"].required, false);
  assert.match(append["x-ghatana-idempotency"].reason, /must not automatically retry/u);
  assert.equal(protocol.eventPlaneDependency.contractMismatch.disposition.includes("MUST NOT automatically repeat"), true);
  const handler = readFileSync(resolve(sharedRoot, "services/event-plane/launcher/src/main/java/com/ghatana/event/plane/launcher/EventPlaneHttpHandler.java"), "utf8");
  assert.match(handler, /eventId\(stableUuid\(callerEventId\)\)/u);
  assert.match(handler, /return UUID\.nameUUIDFromBytes\(callerEventId\.getBytes\(StandardCharsets\.UTF_8\)\)/u);
});

test("P1-08 outbox eligibility requires one exact same-transaction tenant/event/fingerprint/version tuple", () => {
  const { expected } = sample();
  const transaction = {
    aggregateCommitted: true, outboxCommitted: true, sameAtomicCommit: true,
    tenantId: expected.tenantId, eventId: expected.eventId, payloadFingerprint: expected.payloadFingerprint,
    eventType: "media.job.completed", eventVersion: expected.eventVersion,
    aggregateType: expected.aggregateType, aggregateId: expected.aggregateId, aggregateVersion: expected.aggregateVersion,
  };
  const event = { eventId: expected.eventId, eventType: "media.job.completed", eventVersion: expected.eventVersion, tenantId: expected.tenantId,
    aggregateType: expected.aggregateType, aggregateId: expected.aggregateId };
  assert.equal(acceptsMediaEventForOutbox({ event, payloadFingerprint: expected.payloadFingerprint, aggregateVersion: 4, transaction }), true);
  assert.equal(acceptsMediaEventForOutbox({ event: { ...event, eventVersion: " " }, payloadFingerprint: expected.payloadFingerprint, aggregateVersion: 4, transaction }), false);
  for (const change of [
    (tx) => { tx.sameAtomicCommit = false; },
    (tx) => { tx.tenantId = "tenant-b"; },
    (tx) => { tx.payloadFingerprint = "b".repeat(64); },
    (tx) => { tx.eventType = "media.job.failed"; },
    (tx) => { tx.eventVersion = "2.0.0"; },
    (tx) => { tx.aggregateVersion = 3; },
    (tx) => { tx.outboxCommitted = false; },
  ]) {
    const altered = structuredClone(transaction);
    change(altered);
    assert.equal(acceptsMediaEventForOutbox({ event, payloadFingerprint: expected.payloadFingerprint, aggregateVersion: 4, transaction: altered }), false);
  }
  assert.equal(acceptsMediaEventForOutbox({ event, payloadFingerprint: "not-a-fingerprint", aggregateVersion: 4, transaction }), false);
});

test("P1-08 deduplicates exact event replay and rejects conflicting identity, payload, and stale order", () => {
  const existing = {
    tenantId: "tenant-a", eventId: "event-4", eventType: "media.job.completed", eventVersion: "1.0.0",
    aggregateType: "job", aggregateId: "job-7", aggregateVersion: 4, payloadFingerprint: "a".repeat(64),
  };
  assert.equal(classifyMediaEventReplay({ existing, candidate: { ...existing } }), "DUPLICATE_SAME_EVENT_NOOP");
  assert.equal(classifyMediaEventReplay({ existing, candidate: { ...existing, payloadFingerprint: "b".repeat(64) } }), "EVENT_ID_CONFLICT");
  assert.equal(classifyMediaEventReplay({ existing, candidate: { ...existing, aggregateVersion: 5 } }), "EVENT_ID_CONFLICT");
  assert.equal(classifyMediaEventReplay({ existing, candidate: { ...existing, eventVersion: "2.0.0" } }), "EVENT_ID_CONFLICT");
  assert.equal(classifyMediaEventReplay({ existing, candidate: { ...existing, eventVersion: " " } }), "UNKNOWN_INVALID_EVENT_IDENTITY_OR_FINGERPRINT");
  assert.equal(classifyMediaEventReplay({ existing, candidate: { ...existing, tenantId: "tenant-b" } }), "DISTINCT_EVENT_INTENT");
  assert.equal(classifyMediaEventReplay({ existing, candidate: { ...existing, payloadFingerprint: "invalid" } }), "UNKNOWN_INVALID_EVENT_IDENTITY_OR_FINGERPRINT");
  assert.equal(classifyMediaAggregateOrder({ previousVersion: 3, candidateVersion: 4 }), "ACCEPT_NEXT_AGGREGATE_VERSION");
  assert.equal(classifyMediaAggregateOrder({ previousVersion: 4, candidateVersion: 4 }), "REJECT_STALE_OR_DUPLICATE_VERSION");
  assert.equal(classifyMediaAggregateOrder({ previousVersion: 4, candidateVersion: 3 }), "REJECT_STALE_OR_DUPLICATE_VERSION");
  assert.equal(classifyMediaAggregateOrder({ previousVersion: 4, candidateVersion: 6 }), "HOLD_GAP_FOR_RECONCILIATION");
  assert.equal(classifyMediaAggregateOrder({ previousVersion: 4, candidateVersion: Number.MAX_SAFE_INTEGER + 1 }), "UNKNOWN_INVALID_AGGREGATE_VERSION");
});

test("P1-08 ambiguous append remains UNKNOWN until an exact current trusted lookup tuple matches", () => {
  const { expected, binding } = sample();
  assert.deepEqual(evaluateMediaEventDelivery({ expected, append: { transportOutcome: "TIMEOUT" } }), {
    disposition: "UNKNOWN_RETAIN_INTENT", reason: "NO_EXACT_CURRENT_TUPLE_MATCH",
    automaticAppendRetry: "FORBIDDEN_UNTIL_SHARED_CONTRACT_RECONCILES_RETRY_SEMANTICS",
  });
  const matching = { expected, append: { transportOutcome: "TIMEOUT" }, lookup: exactLookup(expected, binding) };
  assert.deepEqual(evaluateMediaEventDelivery(matching), { disposition: "RECONCILED_ACCEPTED", source: "EXACT_CURRENT_LOOKUP" });

  for (const lookup of [
    { outcome: "NOT_FOUND", current: true, authorityRef: expected.lookupAuthorityRef, recordBinding: binding },
    { outcome: "MATCHED_RECORD", current: false, authorityRef: expected.lookupAuthorityRef, recordBinding: binding },
    exactLookup(expected, binding, { readReceipt: { ...exactLookup(expected, binding).readReceipt, currentness: "STALE" } }),
    exactLookup(expected, binding, { readReceipt: { ...exactLookup(expected, binding).readReceipt, authorityRef: "foreign-authority" } }),
    exactLookup(expected, { ...binding, tenantId: "tenant-b" }),
    exactLookup(expected, { ...binding, storedEventId: "a37fdc71-11a7-4e36-a772-809c438f10f4" }),
    exactLookup(expected, { ...binding, payloadFingerprint: "b".repeat(64) }),
    exactLookup(expected, binding, { queryBinding: { ...exactLookup(expected, binding).queryBinding, eventId: "foreign-event" } }),
    exactLookup(expected, binding, { readReceipt: { ...exactLookup(expected, binding).readReceipt, observedAt: "2026-02-30T00:00:00Z" } }),
    exactLookup(expected, binding, { readReceipt: { ...exactLookup(expected, binding).readReceipt, observedAt: "2026-10-09T11:00:00Z" } }),
  ]) {
    assert.equal(evaluateMediaEventDelivery({ expected, append: { status: 503 }, lookup }).disposition, "UNKNOWN_RETAIN_INTENT");
  }
  assert.equal(evaluateMediaEventDelivery({ expected: { ...expected, aggregateVersion: 0 } }).disposition, "UNKNOWN");
});

test("P1-08 exact append receipts and all nine event identities fail closed on conflicting evidence", () => {
  const events = source();
  const contracts = events.ownerEventContracts;
  assert.equal(contracts.records.length, 9);
  assert.equal(contracts.notificationRecords.length, 15);
  const protocol = contracts.deliveryProtocol;
  assert.equal(protocol.eventPlaneDependency.executionAdmission, "NOT_ADMITTED");
  assert.equal(protocol.externalOwnerReviewRequest.status, "PENDING_SHARED_CONTRACT_RECONCILIATION");
  for (const contract of contracts.records) {
    assert.match(contract.durability.delivery, /conditional at-least-once design target only after the published Event Plane contract permits safe reconciliation/u,
      `${contract.id} conditions delivery on the accepted dependency contract`);
    assert.match(contract.durability.delivery, /consumer deduplicates duplicate observations/u,
      `${contract.id} preserves duplicate handling`);
    assert.match(contract.durability.delivery, /no current delivery guarantee/u,
      `${contract.id} makes no present delivery claim`);
    assert.match(contract.durability.dispatch, /do not issue another append until the published Event Plane contract explicitly permits safe replay/u,
      `${contract.id} preserves the Shared retry boundary`);
    assert.equal(contract.executionAdmission, "NOT_ADMITTED");
    assert.equal(contract.qualificationState, "NOT_EVALUATED");
  }
  for (const notification of contracts.notificationRecords) {
    assert.equal(notification.semanticEquivalenceToLifecycleType, "NONE");
    assert.equal(notification.durability.persisted, false);
    assert.match(notification.finality, /not a domain event/u);
  }
  const { expected, binding } = sample();
  const response = { eventId: expected.eventId, storedEventId: expected.storedEventId, streamId: expected.streamId, offset: "11" };
  assert.deepEqual(evaluateMediaEventDelivery({ expected, append: { status: 201, response, authorityRef: expected.publisherAuthorityRef, trustedRequestBinding: binding } }), {
    disposition: "EVENT_PLANE_ACCEPTED", source: "EXACT_APPEND_RECEIPT",
  });
  for (const altered of [
    { ...response, eventId: "other-event" },
    { ...response, streamId: "other-stream" },
    { ...response, storedEventId: "not-a-uuid" },
    { ...response, storedEventId: "a37fdc71-11a7-4e36-a772-809c438f10f4" },
    { ...response, offset: "-1" },
  ]) {
    assert.equal(evaluateMediaEventDelivery({ expected, append: { status: 201, response: altered, authorityRef: expected.publisherAuthorityRef, trustedRequestBinding: binding } }).disposition, "UNKNOWN_QUARANTINE");
  }
  assert.equal(evaluateMediaEventDelivery({ expected, append: { status: 201, response, authorityRef: "foreign", trustedRequestBinding: binding } }).disposition, "UNKNOWN_QUARANTINE");
  assert.equal(evaluateMediaEventDelivery({ expected, append: { status: 409 } }).disposition, "UNKNOWN_RETAIN_INTENT",
    "a conflict may identify an existing same-ID event and requires exact lookup");
  assert.equal(evaluateMediaEventDelivery({ expected, append: { status: 500 } }).disposition, "UNKNOWN_RETAIN_INTENT",
    "server errors remain ambiguous until exact lookup");
  assert.equal(evaluateMediaEventDelivery({ expected, append: { status: 401 } }).disposition, "UNKNOWN_RETAIN_INTENT", "an unbound status code cannot prove rejection of this event intent");
  assert.equal(evaluateMediaEventDelivery({ expected, append: { status: 401, authorityRef: expected.publisherAuthorityRef, trustedRequestBinding: binding } }).disposition, "NOT_ACCEPTED_RETAIN_INTENT");
  assert.equal(new Set(contracts.records.map(({ eventType }) => eventType)).size, 9);
  assert.equal(new Set(contracts.notificationRecords.map(({ eventName }) => eventName)).size, 15);
});

test("P1-08 distinguishes Event Plane append acceptance evidence from consumer effect", () => {
  const events = source();
  const evidence = evidenceSource().eventEvidenceBindings.eventPlaneAcceptanceEvidence;
  const provenance = provenanceSource().eventProvenanceObservations;
  const observed = events.observedEnvelope.lifecyclePublisherInventory.records;
  const provenanceBindings = provenance.eventBindings.records;
  const evidenceBindings = evidenceSource().eventEvidenceBindings.eventBindings.records;
  assert.equal(provenance.eventBindings.status, "proposal-only; pending-owner-review");
  assert.equal(new Set(provenanceBindings.map(({ eventType }) => eventType)).size, 9);
  assert.equal(new Set(evidenceBindings.map(({ eventType }) => eventType)).size, 9);
  for (const event of observed) {
    const provenanceBinding = provenanceBindings.find(({ eventType }) => eventType === event.eventType);
    const evidenceBinding = evidenceBindings.find(({ eventType }) => eventType === event.eventType);
    assert.equal(provenanceBinding?.sourceRef, event.sourceRef, `${event.eventType} lineage candidate points to its observed source`);
    assert.equal(evidenceBinding?.sourceObservationCandidate, event.sourceRef, `${event.eventType} evidence candidate points to its observed source`);
    assert.match(evidenceBinding?.evidenceAvailable ?? "", /source-observation/u);
    assert.equal(evidenceBinding?.finalityAndDelivery, "unavailable");
  }
  assert.equal(evidence.status, "OWNER_DEFINED_DEFINITION_ONLY; runtime-receipt-evidence-unavailable");
  assert.deepEqual(evidence.requiredReceiptFields, ["eventId", "storedEventId", "streamId", "offset"]);
  assert.equal(evidence.proves, "exact-matched-record-accepted-by-Event-Plane-append");
  assert.ok(evidence.doesNotProve.includes("consumer-processed"));
  assert.ok(evidence.doesNotProve.includes("downstream-effect-committed"));
  assert.equal(evidence.executionAdmission, "NOT_ADMITTED");
  assert.match(evidenceSource().eventEvidenceBindings.publicationAttemptEvidence, /discards the append response body/u);
});
