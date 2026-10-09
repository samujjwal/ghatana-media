import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  canonicalJobResultJson,
  resolveSubmittedJobTarget,
  validateJobResultObservation,
} from "../scripts/lib/pdp-job-result-observation.mjs";
import { computeOwnerRequestSchemaDigest } from "../scripts/lib/pdp-tts-request-origin-binding.mjs";
import { validateOwnerClosedJsonSchema, resolveEffectiveCapabilityWireSchemas } from "../scripts/lib/pdp-owner-leaf-wire-validation.mjs";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const yaml = require("yaml");
const source = yaml.parse(readFileSync(".product-experience/pdp-1-domain-data/operations.yaml", "utf8"));
const targetRef = "media.operation.capability.media-speech-synthesis-text-to-speech";
const capabilityRef = "media.speech.synthesis.text-to-speech";
const now = "2026-10-09T18:00:00.000Z";
const sha = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");

function fixture() {
  const operations = structuredClone(source);
  const capability = operations.capabilityOperationContracts.records.find((row) => row.capabilityRef === capabilityRef);
  capability.successOutputs = [{ artifactType: "typed-test-output", payloadSchemaRef: "job-result-test-payload" }];
  capability.resultSchema = {
    type: "object",
    additionalProperties: false,
    required: ["outcome", "operationRef", "operationVersion", "requestId", "outputs"],
    properties: {
      outcome: { const: "SUCCEEDED" },
      operationRef: { const: targetRef },
      operationVersion: { const: 1 },
      requestId: { type: "string", minLength: 1 },
      outputs: {
        type: "array",
        minItems: 1,
        maxItems: 1,
        items: { oneOf: [{
          type: "object",
          additionalProperties: false,
          required: ["artifactType", "payload"],
          properties: {
            artifactType: { const: "typed-test-output" },
            payload: { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "string" } } },
          },
        }] },
      },
    },
  };
  operations.capabilityOperationContracts.outputPayloadSchemas.push({
    id: "job-result-test-payload",
    artifactType: "typed-test-output",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["artifactType", "payload"],
      properties: {
        artifactType: { const: "typed-test-output" },
        payload: { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "string" } } },
      },
    },
  });
  const target = {
    jobId: "job-1",
    requestId: "request-1",
    tenantId: "tenant-1",
    principalId: "principal-1",
    requestFingerprint: sha("accepted-request"),
    acceptedRequestSnapshotRef: "snapshot://job-1/request-1/v1",
    capabilityRef,
    targetOperationRef: targetRef,
    targetOperationVersion: 1,
    targetSchemaDigest: computeOwnerRequestSchemaDigest(operations, targetRef, capabilityRef),
    readAuthorityRef: "authority://accepted-snapshot",
    readVersion: "read-v4",
    observedAt: now,
    currentness: "CURRENT",
  };
  const effective = resolveSubmittedJobTarget(operations, target);
  assert.equal(effective.valid, true);
  const result = {
    outcome: "SUCCEEDED",
    operationRef: targetRef,
    operationVersion: 1,
    requestId: "request-1",
    outputs: [{ artifactType: "typed-test-output", payload: { value: "observed" } }],
  };
  const resultJsonText = canonicalJobResultJson(result);
  const observation = {
    disposition: "TARGET_SCHEMA_VALIDATED",
    targetOperationRef: targetRef,
    targetOperationVersion: 1,
    targetSchemaDigest: target.targetSchemaDigest,
    targetResultSchemaDigest: effective.resultSchemaDigest,
    resultJsonText,
  };
  const trusted = {
    expectedScope: {
      jobId: target.jobId,
      requestId: target.requestId,
      tenantId: target.tenantId,
      principalId: target.principalId,
      requestFingerprint: target.requestFingerprint,
      acceptedRequestSnapshotRef: target.acceptedRequestSnapshotRef,
      capabilityRef: target.capabilityRef,
      targetOperationRef: target.targetOperationRef,
      targetOperationVersion: target.targetOperationVersion,
      targetSchemaDigest: target.targetSchemaDigest,
      acceptedReadAuthorityRef: target.readAuthorityRef,
      acceptedReadVersion: target.readVersion,
      statusReadAuthorityRef: "authority://status-read",
      statusReadVersion: 9,
    },
    acceptedRequest: target,
    statusRead: {
      jobId: target.jobId,
      requestId: target.requestId,
      tenantId: target.tenantId,
      principalId: target.principalId,
      requestFingerprint: target.requestFingerprint,
      readAuthorityRef: "authority://status-read",
      readVersion: 9,
      observedAt: now,
      currentness: "CURRENT",
      resultDigest: sha(resultJsonText),
    },
    now,
    maxAgeMs: 30_000,
    acceptedReadAuthorityAllowlist: ["authority://accepted-snapshot"],
  };
  return { operations, target, result, observation, trusted };
}

function actualCanonicalTtsFixture() {
  const operations = structuredClone(source);
  const target = {
    jobId: "tts-job-1", requestId: "tts-request-1", tenantId: "tenant-1", principalId: "principal-1",
    requestFingerprint: sha("tts-accepted-request"), acceptedRequestSnapshotRef: "snapshot://tts-job-1/tts-request-1/v1",
    capabilityRef: "media.speech.synthesis.text-to-speech",
    targetOperationRef: "media.operation.capability.media-speech-synthesis-text-to-speech", targetOperationVersion: 1,
    targetSchemaDigest: computeOwnerRequestSchemaDigest(operations, "media.operation.capability.media-speech-synthesis-text-to-speech", "media.speech.synthesis.text-to-speech"),
    readAuthorityRef: "authority://accepted-snapshot", readVersion: "read-v4", observedAt: now, currentness: "CURRENT",
  };
  const result = {
    outcome: "SUCCEEDED", observedAt: now, implementationState: "UNKNOWN", qualificationState: "NOT_EVALUATED", runtimeAvailability: "UNKNOWN",
    outputs: [{ artifactType: "speech-artifact-with-voice-rights-and-execution-provenance", payload: {
      purposeRef: "purpose://speech-synthesis", rightsEvidenceRefs: ["evidence://voice-rights/v1"],
      targetOperationRef: target.targetOperationRef, targetOperationVersion: 1, capabilityRef: target.capabilityRef,
      tenantId: target.tenantId, principalId: target.principalId, jobId: target.jobId, requestId: target.requestId,
      profileRef: "profile://speech/default@v3", profileVersion: "3", profileVersionRef: "profile://speech/default/v3",
      originKind: "GENERATED_FROM_REQUEST", acceptedRequestSnapshotRef: target.acceptedRequestSnapshotRef,
      requestFingerprint: target.requestFingerprint, targetSchemaDigest: target.targetSchemaDigest,
      outputCandidateRef: "candidate://tts-job-1/attempt-1/output-1", outputDigest: sha("tts-output"),
      originBindingRef: "origin://tts-job-1/request-1/v1", sourceVersionRefs: [],
      dependencyVersionRefs: ["voice-model://default/model-v3"], consentRef: "consent://voice-profile/default/v3",
      retentionPolicyRef: "retention://voice-standard/v1",
    } }],
    provenance: {
      operationRef: target.targetOperationRef, observedAt: now,
      sourceRefs: [target.acceptedRequestSnapshotRef, "voice-model://default/model-v3"],
      outputDigest: sha("tts-output"), originBindingRef: "origin://tts-job-1/request-1/v1",
      jobId: target.jobId, requestId: target.requestId, tenantId: target.tenantId, principalId: target.principalId,
      readAuthorityRef: "authority://status-read", readVersion: "status-v9", currentness: "CURRENT",
    },
  };
  const capability = operations.capabilityOperationContracts.records.find((row) => row.capabilityRef === target.capabilityRef);
  const effective = resolveEffectiveCapabilityWireSchemas(operations, target.capabilityRef);
  assert.equal(effective.valid, true);
  assert.equal(validateOwnerClosedJsonSchema(effective.resultSchema, result).valid, true,
    JSON.stringify(validateOwnerClosedJsonSchema(effective.resultSchema, result).errors));
  const acceptedRequest = { ...target };
  const resultDigest = sha(canonicalJobResultJson(result));
  const statusRead = {
    jobId: target.jobId, requestId: target.requestId, tenantId: target.tenantId, principalId: target.principalId,
    requestFingerprint: target.requestFingerprint, readAuthorityRef: "authority://status-read", readVersion: 9,
    observedAt: now, currentness: "CURRENT", resultDigest,
  };
  const expectedScope = {
    jobId: target.jobId, requestId: target.requestId, tenantId: target.tenantId, principalId: target.principalId,
    requestFingerprint: target.requestFingerprint, acceptedRequestSnapshotRef: target.acceptedRequestSnapshotRef,
    capabilityRef: target.capabilityRef, targetOperationRef: target.targetOperationRef, targetOperationVersion: target.targetOperationVersion,
    targetSchemaDigest: target.targetSchemaDigest, acceptedReadAuthorityRef: target.readAuthorityRef,
    acceptedReadVersion: target.readVersion, statusReadAuthorityRef: statusRead.readAuthorityRef, statusReadVersion: statusRead.readVersion,
  };
  return {
    operations, result,
    observation: {
      disposition: "TARGET_SCHEMA_VALIDATED", targetOperationRef: target.targetOperationRef,
      targetOperationVersion: target.targetOperationVersion, targetSchemaDigest: target.targetSchemaDigest,
      targetResultSchemaDigest: resolveSubmittedJobTarget(operations, target).resultSchemaDigest,
      resultJsonText: canonicalJobResultJson(result),
    },
    trusted: { expectedScope, acceptedRequest, statusRead, now, maxAgeMs: 30_000, acceptedReadAuthorityAllowlist: [target.readAuthorityRef] },
  };
}

test("legacy job result stays opaque and UNKNOWN", () => {
  const { operations, trusted } = fixture();
  const result = validateJobResultObservation(operations, {
    disposition: "UNVALIDATED_LEGACY_RESULT",
    rawJsonText: '{"status":"COMPLETED"}',
  }, trusted);
  assert.equal(result.truth, "UNKNOWN");
  assert.equal(result.reason, "LEGACY_RESULT_PRESERVED_UNVALIDATED");
  assert.equal(result.canonicalResult, null);
});

test("typed target result requires exact accepted target schema and trusted current read digest", () => {
  const { operations, observation, trusted, result } = fixture();
  const validated = validateJobResultObservation(operations, observation, trusted);
  assert.equal(validated.truth, "UNKNOWN", "schema compatibility never proves effect finality");
  assert.equal(validated.reason, "TARGET_RESULT_SCHEMA_VALIDATED_EFFECT_FINALITY_NOT_ESTABLISHED");
  assert.deepEqual(validated.canonicalResult, result);
  const foreignResult = { ...result, outputs: [{ artifactType: "typed-test-output", payload: { value: "foreign" } }] };
  const changedObservation = { ...observation, resultJsonText: canonicalJobResultJson(foreignResult) };
  assert.equal(validateJobResultObservation(operations, changedObservation, trusted).reason, "STATUS_READ_RESULT_DIGEST_MISMATCH");
});

test("an unchanged canonical TTS target/result schema validates through the real effective owner resolver", () => {
  const { operations, observation, trusted, result } = actualCanonicalTtsFixture();
  const resolved = resolveSubmittedJobTarget(operations, trusted.acceptedRequest);
  assert.equal(resolved.valid, true);
  assert.equal(resolved.capability.id, targetRef);
  assert.equal(validateJobResultObservation(operations, observation, trusted).reason,
    "TARGET_RESULT_SCHEMA_VALIDATED_EFFECT_FINALITY_NOT_ESTABLISHED");
  const mismatchedRegistry = structuredClone(operations);
  const typed = mismatchedRegistry.capabilityOperationContracts.inputPayloadSchemas.find((row) => row.id === "media.typed-input.text-or-speech-intent");
  typed.schema.properties.payload.oneOf[0].properties.text.maxLength = 4000;
  assert.equal(validateJobResultObservation(mismatchedRegistry, observation, trusted).reason,
    "TARGET_SCHEMA_OR_ACCEPTED_OPERATION_BINDING_MISMATCH",
    "changing a referenced input payload schema invalidates the accepted target request-schema digest");
  assert.equal(result.outcome, "SUCCEEDED");
});

test("same-schema foreign request, stale snapshot, and schema drift never bind as a typed result", () => {
  const { operations, observation, trusted } = fixture();
  const foreignRequest = { outcome: "SUCCEEDED", operationRef: targetRef, operationVersion: 1, requestId: "other-request", outputs: [{ artifactType: "typed-test-output", payload: { value: "x" } }] };
  const foreignText = canonicalJobResultJson(foreignRequest);
  const foreignObservation = { ...observation, resultJsonText: foreignText };
  const foreignTrusted = structuredClone(trusted);
  foreignTrusted.statusRead.resultDigest = sha(foreignText);
  assert.equal(validateJobResultObservation(operations, foreignObservation, foreignTrusted).reason, "TARGET_RESULT_IDENTITY_BINDING_MISMATCH");

  const foreignScope = structuredClone(trusted);
  for (const field of ["jobId", "requestId", "tenantId", "principalId", "acceptedRequestSnapshotRef"]) {
    foreignScope.acceptedRequest[field] = "foreign-" + field;
    foreignScope.statusRead[field] = "foreign-" + field;
  }
  foreignScope.acceptedRequest.requestFingerprint = sha("foreign-accepted-request");
  foreignScope.statusRead.requestFingerprint = foreignScope.acceptedRequest.requestFingerprint;
  foreignScope.statusRead.resultDigest = sha(observation.resultJsonText);
  assert.equal(validateJobResultObservation(operations, observation, foreignScope).reason, "ACCEPTED_REQUEST_SCOPE_MISMATCH");

  const stale = structuredClone(trusted);
  stale.now = "2026-10-09T18:01:00.001Z";
  assert.equal(validateJobResultObservation(operations, observation, stale).reason, "ACCEPTED_REQUEST_SNAPSHOT_STALE_OR_FUTURE");

  const drifted = structuredClone(operations);
  drifted.capabilityOperationContracts.outputPayloadSchemas.find((row) => row.id === "job-result-test-payload").schema.properties.payload.properties.value.maxLength = 5;
  assert.equal(validateJobResultObservation(drifted, observation, trusted).reason, "TARGET_SCHEMA_OR_ACCEPTED_OPERATION_BINDING_MISMATCH");
});

test("malformed and extra trusted/result fields fail closed without throwing", () => {
  const { operations, observation, trusted } = fixture();
  assert.equal(validateJobResultObservation(operations, { ...observation, ignored: true }, trusted).reason, "TARGET_RESULT_OBSERVATION_INVALID");
  const malformed = structuredClone(trusted);
  delete malformed.statusRead.requestId;
  assert.equal(validateJobResultObservation(operations, observation, malformed).reason, "STATUS_READ_NOT_BOUND_TO_ACCEPTED_REQUEST");
  const cycle = {};
  cycle.self = cycle;
  assert.equal(validateJobResultObservation(operations, { disposition: "TARGET_SCHEMA_VALIDATED", cycle }, trusted).truth, "UNKNOWN");
});
