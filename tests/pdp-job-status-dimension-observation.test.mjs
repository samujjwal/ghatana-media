import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { JOB_STATUS_DIMENSION_OPERATION_ID, validateJobStatusDimensionObservation } from "../scripts/lib/pdp-job-status-dimension-observation.mjs";
import { validateOwnerClosedJsonSchema } from "../scripts/lib/pdp-owner-leaf-wire-validation.mjs";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const yaml = require("yaml");
const operations = yaml.parse(readFileSync(".product-experience/pdp-1-domain-data/operations.yaml", "utf8"));
const states = yaml.parse(readFileSync(".product-experience/pdp-1-domain-data/states.yaml", "utf8"));
const authorityRef = ".product-experience/pdp-1-domain-data/authority.yaml#ownerDefinedPdp10AuthorityScopes/jobStatusRead";
const now = "2026-10-09T19:00:00.000Z";

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
const sha = (text) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

function fixture() {
  const request = {
    queryId: "query-1", jobId: "job-1",
    stageRefs: ["stage:render", "stage:encode"],
    qualitySubjectVersionRefs: ["artifact:v1", "artifact:v2"],
    destinationRefs: ["destination:1", "destination:2"],
  };
  const host = {
    tenantId: "tenant-1", principalId: "principal-1", jobId: "job-1", queryId: "query-1",
    readAuthorityRef: authorityRef, readVersion: "read-v3", now, maxAgeMs: 30000,
    expectedResultDigest: "",
  };
  const result = {
    outcome: "OBSERVED", operationRef: JOB_STATUS_DIMENSION_OPERATION_ID,
    queryId: request.queryId, requestFingerprint: sha(canonical({ operationRef: JOB_STATUS_DIMENSION_OPERATION_ID, request, tenantId: host.tenantId, principalId: host.principalId })),
    tenantId: host.tenantId, principalId: host.principalId, jobId: host.jobId,
    readAuthorityRef: host.readAuthorityRef, readVersion: host.readVersion,
    currentness: "CURRENT", observedAt: "2026-10-09T18:59:45.000Z",
    dimensions: {
      overallJob: { kind: "OBSERVED", value: "RUNNING", evidenceRef: "evidence:job" },
      stageProgress: [
        { kind: "OBSERVED", stageRef: "stage:render", attemptRef: "attempt:2", state: "RUNNING", fencingToken: 3, basisKind: "CURRENT_STAGE_ATTEMPT_RECORD", evidenceRef: "evidence:stage" },
        { kind: "UNKNOWN_OBSERVATION", stageRef: "stage:encode", reasonRef: "stage-not-read" },
      ],
      attemptClaimAndLease: { kind: "OBSERVED", attemptRef: "attempt:2", attemptState: "RUNNING", leaseState: "ACTIVE", ownerId: "worker-1", fencingToken: 3, leaseRevisionRef: "lease-rev:3", leaseExpiresAt: "2026-10-09T19:01:00.000Z", evidenceRef: "evidence:lease" },
      cancellationOutcome: { kind: "OBSERVED", value: "NOT_REQUESTED", basis: { kind: "CURRENT_NEGATIVE_CANCELLATION_READ", operationRef: JOB_STATUS_DIMENSION_OPERATION_ID, queryId: "query-1", requestFingerprint: "", jobId: "job-1", tenantId: "tenant-1", principalId: "principal-1", readAuthorityRef: authorityRef, readVersion: "read-v3", currentness: "CURRENT", observedAt: "2026-10-09T18:59:45.000Z", value: "NOT_REQUESTED", recordRef: "cancellation-read:current" }, evidenceRef: "evidence:cancel-negative" },
      remoteOutcomeCertainty: { kind: "OBSERVED", value: "MAY_HAVE_TAKEN_EFFECT", basis: { kind: "CURRENT_DISPATCH_RECEIPT", operationRef: JOB_STATUS_DIMENSION_OPERATION_ID, queryId: "query-1", requestFingerprint: "", jobId: "job-1", tenantId: "tenant-1", principalId: "principal-1", readAuthorityRef: authorityRef, readVersion: "read-v3", currentness: "CURRENT", observedAt: "2026-10-09T18:59:45.000Z", value: "MAY_HAVE_TAKEN_EFFECT", recordRef: "dispatch-receipt:1" }, evidenceRef: "evidence:remote" },
      qualityDisposition: [
        { kind: "OBSERVED", value: "PASS", assessmentRef: "assessment:v2", basisKind: "CURRENT_ASSESSMENT_RECORD", subjectVersionRef: "artifact:v1", evidenceRef: "evidence:quality-1" },
        { kind: "UNKNOWN_OBSERVATION", subjectVersionRef: "artifact:v2", reasonRef: "quality-not-read" },
      ],
      deliveryStatus: [
        { kind: "OBSERVED", value: "SUBMITTED", destinationRef: "destination:1", basisKind: "CURRENT_DELIVERY_STATUS_RECORD", deliveryRecordRef: "delivery:1", evidenceRef: "evidence:delivery-1" },
        { kind: "UNKNOWN_OBSERVATION", destinationRef: "destination:2", reasonRef: "delivery-not-read" },
      ],
    },
  };
  const fingerprint = sha(canonical({ operationRef: JOB_STATUS_DIMENSION_OPERATION_ID, request, tenantId: host.tenantId, principalId: host.principalId }));
  result.requestFingerprint = fingerprint;
  result.dimensions.cancellationOutcome.basis.requestFingerprint = fingerprint;
  result.dimensions.remoteOutcomeCertainty.basis.requestFingerprint = fingerprint;
  const body = { ...result };
  result.resultDigest = sha(canonical(body));
  host.expectedResultDigest = result.resultDigest;
  return { request, host, result };
}

function refreshTrustedResultDigest(value) {
  value.result.resultDigest = sha(canonical(Object.fromEntries(Object.entries(value.result).filter(([key]) => key !== "resultDigest"))));
  value.host.expectedResultDigest = value.result.resultDigest;
}

function refreshRequestBinding(value) {
  const fingerprint = sha(canonical({ operationRef: JOB_STATUS_DIMENSION_OPERATION_ID, request: value.request, tenantId: value.host.tenantId, principalId: value.host.principalId }));
  value.result.requestFingerprint = fingerprint;
  for (const dimension of [value.result.dimensions.cancellationOutcome, value.result.dimensions.remoteOutcomeCertainty]) {
    if (dimension.kind === "OBSERVED") dimension.basis.requestFingerprint = fingerprint;
  }
  refreshTrustedResultDigest(value);
}

test("status read contract is a separate closed typed query with seven explicit dimensions", () => {
  const rows = operations.ownerDefinedOperationContracts.records.filter((row) => row.id === JOB_STATUS_DIMENSION_OPERATION_ID);
  assert.equal(rows.length, 1);
  const query = rows[0];
  assert.equal(query.operationKind, "QUERY");
  assert.equal(query.executionAdmission, "NOT_ADMITTED");
  assert.equal(query.resultSchema.additionalProperties, false);
  assert.deepEqual(query.requestSchema.required, ["queryId", "jobId", "stageRefs", "qualitySubjectVersionRefs", "destinationRefs"]);
  assert.deepEqual(query.resultSchema.properties.dimensions.required, ["overallJob", "stageProgress", "attemptClaimAndLease", "cancellationOutcome", "remoteOutcomeCertainty", "qualityDisposition", "deliveryStatus"]);
  const stateIds = (machineId) => states.stateMachines.find((machine) => machine.machineId === machineId).stateDefinitions.map((state) => state.id);
  const schema = query.resultSchema.properties.dimensions.properties;
  assert.deepEqual(schema.overallJob.oneOf[0].properties.value.enum, stateIds("media-job"));
  assert.deepEqual(schema.attemptClaimAndLease.oneOf[0].properties.attemptState.enum, stateIds("media-attempt"));
  assert.deepEqual(schema.qualityDisposition.items.oneOf[0].properties.value.enum, stateIds("media-quality-disposition"));
  assert.deepEqual(schema.deliveryStatus.items.oneOf[0].properties.value.enum, stateIds("media-delivery"));
  assert.ok(!schema.stageProgress.items.oneOf[0].properties.state.enum.includes("UNKNOWN"), "missing stage data is a wrapper disposition, not a stage state");
  assert.ok(!schema.overallJob.oneOf[0].properties.value.enum.includes("UNKNOWN_OBSERVATION"), "known lifecycle OUTCOME_UNKNOWN stays distinct from missing observation");
});

test("normalized status dimensions require exact host scope, current read, and explicit UNKNOWN branches", () => {
  const value = fixture();
  const operation = operations.ownerDefinedOperationContracts.records.find((row) => row.id === JOB_STATUS_DIMENSION_OPERATION_ID);
  const schemaCheck = validateOwnerClosedJsonSchema(operation.resultSchema, value.result);
  assert.equal(schemaCheck.valid, true, JSON.stringify(schemaCheck.errors));
  assert.deepEqual(validateJobStatusDimensionObservation(operations, value.request, value.result, value.host), {
    truth: "OBSERVED", reason: "CURRENT_TYPED_STATUS_DIMENSIONS", dimensions: value.result.dimensions,
  });
  assert.equal(value.result.dimensions.stageProgress.length, 2);
  assert.equal(value.result.dimensions.qualityDisposition.length, 2);
  assert.equal(value.result.dimensions.deliveryStatus.length, 2);
  assert.equal(value.result.dimensions.stageProgress[1].kind, "UNKNOWN_OBSERVATION",
    "an unknown stage cannot be promoted by another stage's running state");
  assert.equal(value.result.dimensions.qualityDisposition[1].kind, "UNKNOWN_OBSERVATION",
    "a passing assessment for one subject cannot aggregate across another subject");
  assert.equal(value.result.dimensions.deliveryStatus[1].kind, "UNKNOWN_OBSERVATION",
    "one submitted destination cannot imply acknowledgement by another destination");
  const queued = fixture();
  queued.request.stageRefs = [];
  queued.request.qualitySubjectVersionRefs = [];
  queued.request.destinationRefs = [];
  queued.result.dimensions.overallJob.value = "QUEUED";
  queued.result.dimensions.stageProgress = [];
  queued.result.dimensions.qualityDisposition = [];
  queued.result.dimensions.deliveryStatus = [];
  refreshRequestBinding(queued);
  assert.equal(validateJobStatusDimensionObservation(operations, queued.request, queued.result, queued.host).truth, "OBSERVED",
    "an initial queued-job read may explicitly request no stage, quality, or destination scope");
  assert.equal(queued.result.dimensions.overallJob.value, "QUEUED", "empty selected scope does not synthesize a global absence or completion state");
  const partial = fixture();
  partial.result.dimensions.qualityDisposition[0] = { kind: "UNKNOWN_OBSERVATION", subjectVersionRef: "artifact:v1", reasonRef: "quality-not-read" };
  delete partial.result.resultDigest;
  partial.result.resultDigest = sha(canonical(partial.result));
  partial.host.expectedResultDigest = partial.result.resultDigest;
  assert.equal(validateJobStatusDimensionObservation(operations, partial.request, partial.result, partial.host).truth, "OBSERVED",
    "a current read may carry explicit UNKNOWN for one unavailable dimension");
  const expiredLease = fixture();
  expiredLease.result.dimensions.attemptClaimAndLease.leaseExpiresAt = "2026-10-09T18:59:59.000Z";
  expiredLease.result.resultDigest = sha(canonical(Object.fromEntries(Object.entries(expiredLease.result).filter(([key]) => key !== "resultDigest"))));
  expiredLease.host.expectedResultDigest = expiredLease.result.resultDigest;
  assert.equal(validateJobStatusDimensionObservation(operations, expiredLease.request, expiredLease.result, expiredLease.host).reason,
    "STATUS_QUERY_DIMENSION_EVIDENCE_MISMATCH", "a body digest cannot make an expired lease currently ACTIVE");
  const reject = (mutate, expected) => {
    const input = fixture();
    mutate(input);
    assert.equal(validateJobStatusDimensionObservation(operations, input.request, input.result, input.host).truth, "UNKNOWN");
    if (expected) assert.equal(validateJobStatusDimensionObservation(operations, input.request, input.result, input.host).reason, expected);
  };
  reject((x) => { x.result.jobId = "job-foreign"; }, "STATUS_QUERY_RESULT_SCOPE_MISMATCH");
  reject((x) => { x.host.readAuthorityRef = "foreign.yaml#read"; }, "TRUSTED_STATUS_READ_CONTEXT_INVALID");
  reject((x) => { x.result.requestFingerprint = `sha256:${"a".repeat(64)}`; }, "STATUS_QUERY_RESULT_SCOPE_MISMATCH");
  reject((x) => { x.result.readVersion = "read-v2"; }, "STATUS_QUERY_RESULT_SCOPE_MISMATCH");
  reject((x) => { x.result.observedAt = "2026-10-09T19:00:01.000Z"; }, "STATUS_QUERY_RESULT_STALE_OR_FUTURE");
  reject((x) => { x.result.observedAt = "2026-02-30T18:59:45.000Z"; }, "STATUS_QUERY_RESULT_SCHEMA_REJECTED");
  reject((x) => { x.result.dimensions.stageProgress.pop(); }, "STATUS_QUERY_RESULT_DIGEST_MISMATCH");
  reject((x) => { x.result.dimensions.qualityDisposition[0] = { kind: "UNKNOWN_OBSERVATION", subjectVersionRef: "artifact:v1", value: "PASS", reasonRef: "missing" }; }, "STATUS_QUERY_RESULT_SCHEMA_REJECTED");
  reject((x) => { x.result.dimensions.stageProgress[0] = { kind: "OBSERVED", stageRef: "stage:x", attemptRef: "attempt:x", state: "UNKNOWN", fencingToken: 1, evidenceRef: "e" }; }, "STATUS_QUERY_RESULT_SCHEMA_REJECTED");
  reject((x) => { x.result.dimensions.cancellationOutcome = { kind: "OBSERVED", value: "NOT_REQUESTED", evidenceRef: "empty" }; }, "STATUS_QUERY_RESULT_SCHEMA_REJECTED");
  reject((x) => { x.result.dimensions.qualityDisposition[0].subjectVersionRef = "foreign:version"; }, "STATUS_QUERY_RESULT_DIGEST_MISMATCH");
  reject((x) => { x.result.dimensions.stageProgress[0].attemptRef = "foreign:attempt"; }, "STATUS_QUERY_RESULT_DIGEST_MISMATCH");
  reject((x) => { x.result.dimensions.deliveryStatus[0].destinationRef = "foreign:destination"; }, "STATUS_QUERY_RESULT_DIGEST_MISMATCH");
  reject((x) => { x.result.dimensions.stageProgress[1].stageRef = "stage:unrequested"; }, "STATUS_QUERY_RESULT_DIGEST_MISMATCH");
  reject((x) => { x.result.dimensions.stageProgress[1].stageRef = "stage:render"; }, "STATUS_QUERY_RESULT_DIGEST_MISMATCH");
  reject((x) => { x.result.dimensions.qualityDisposition[1].subjectVersionRef = "artifact:unrequested"; }, "STATUS_QUERY_RESULT_DIGEST_MISMATCH");
  reject((x) => { x.result.dimensions.deliveryStatus[1].destinationRef = "destination:unrequested"; }, "STATUS_QUERY_RESULT_DIGEST_MISMATCH");
  for (const [mutate, label] of [
    [(x) => { x.result.dimensions.stageProgress.pop(); }, "omitted stage"],
    [(x) => { x.result.dimensions.stageProgress[1].stageRef = "stage:render"; }, "duplicate stage"],
    [(x) => { x.result.dimensions.qualityDisposition.pop(); }, "omitted quality subject"],
    [(x) => { x.result.dimensions.qualityDisposition[1].subjectVersionRef = "artifact:v1"; }, "duplicate quality subject"],
    [(x) => { x.result.dimensions.deliveryStatus.pop(); }, "omitted destination"],
    [(x) => { x.result.dimensions.deliveryStatus[1].destinationRef = "destination:1"; }, "duplicate destination"],
  ]) {
    const input = fixture();
    mutate(input);
    refreshTrustedResultDigest(input);
    const observation = validateJobStatusDimensionObservation(operations, input.request, input.result, input.host);
    assert.equal(observation.truth, "UNKNOWN", `${label} must fail even with a valid owner-body digest`);
    assert.equal(observation.reason, "STATUS_QUERY_DIMENSION_EVIDENCE_MISMATCH");
  }
  reject((x) => { x.result.dimensions.cancellationOutcome.value = "REQUESTED"; }, "STATUS_QUERY_RESULT_DIGEST_MISMATCH");
});
