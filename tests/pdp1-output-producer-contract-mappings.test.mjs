import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const read = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const goalsPath = ".product-experience/pdp-0-product-truth/goals-jtbd.yaml";
const capPath = ".product-experience/pdp-0-product-truth/capabilities.yaml";
const measureId = "media.business.trustworthy-versioned-outputs.measure";
const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const { validateMediaJobReadProjection } = await import("../scripts/pdp-truth-domain-job-read-model.mjs");
test("job read projections preserve the Java/OpenAPI record and fail closed on unmapped state/finality", () => {
  const Ajv = require("ajv").default;
  const addFormats = require("ajv-formats");
  const operations = read(".product-experience/pdp-1-domain-data/operations.yaml");
  const contracts = operations.capabilityOperationContracts;
  const sourceRead = operations.individualOperationContracts.records.find(({ id }) => id === "media.operation-slice.inspect-job");
  const wire = sourceRead.ownerWireSchema;
  assert.equal(wire.operationRef, "media.operation-slice.inspect-job");
  assert.ok(wire.sourceRefs.includes("contracts/openapi/media.yaml#/components/schemas/ProcessingJob"));
  assert.ok(wire.sourceRefs.includes("runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaRuntimeContracts.java#ProcessingJob"));
  assert.equal(wire.statusMappings.mappings.length, 6);
  assert.deepEqual(wire.statusMappings.mappings.filter(({ disposition }) => disposition === "EXACT_CANONICAL_STATE").map(({ sourceStatus, canonicalStateRef }) => [sourceStatus, canonicalStateRef]), [
    ["OUTCOME_UNKNOWN", ".product-experience/pdp-1-domain-data/states.yaml#stateMachines/media-job/stateDefinitions/OUTCOME_UNKNOWN"],
  ]);
  for (const id of ["media.job.view-status", "media.job.check-outcome"]) {
    const binding = contracts.records.find(({ capabilityRef }) => capabilityRef === id);
    assert.equal(binding.ownerReadModelRef, ".product-experience/pdp-1-domain-data/operations.yaml#individualOperationContracts/records/@id=media.operation-slice.inspect-job/ownerWireSchema");
  }

  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addFormat("opaque-id", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  ajv.addFormat("opaque-versioned-reference", /^.{1,384}$/);
  const statusSchema = contracts.outputPayloadSchemas.find(({ id }) => id === "media.typed-output.media-job-status-snapshot").schema;
  const outcomeSchema = contracts.outputPayloadSchemas.find(({ id }) => id === "media.typed-output.classified-job-and-attempt-outcome-with-evidence-references").schema;
  const validateStatus = ajv.compile(statusSchema);
  const validateOutcome = ajv.compile(outcomeSchema);
  const canonicalStateRef = wire.statusMappings.mappings.find(({ sourceStatus }) => sourceStatus === "OUTCOME_UNKNOWN").canonicalStateRef;
  const sourceReason = wire.statusMappings.mappings.find(({ sourceStatus }) => sourceStatus === "OUTCOME_UNKNOWN").reason;
  const job = {
    jobId: "job-7", requestId: "req-7", tenantId: "tenant-1", principalId: "principal-1", artifactId: "artifact-7",
    jobType: "SPEECH_TO_TEXT", providerId: null, status: "OUTCOME_UNKNOWN", createdAt: "2026-10-08T12:00:00Z",
    startedAt: "2026-10-08T12:01:00Z", completedAt: null,
    result: { disposition: "UNVALIDATED_LEGACY_RESULT", rawJsonText: "{\"legacy\":true}" },
    failureCode: null, version: 7, requestFingerprint: `sha256:${"a".repeat(64)}`,
  };
  const readObservation = {
    tenantId: "tenant-1", principalId: "principal-1", readVersion: 7,
    resultDigest: sha256(job.result.rawJsonText), observedAt: "2026-10-08T12:02:00Z",
    readAuthorityRef: "media.runtime.read-model.job-store.v1", effectFinality: "OUTCOME_UNKNOWN",
    canonicalStateMapping: { sourceStatus: "OUTCOME_UNKNOWN", disposition: "EXACT_CANONICAL_STATE", canonicalStateRef, reason: sourceReason },
  };
  const statusOutput = { artifactType: "media-job-status-snapshot", payload: { job, readObservation } };
  assert.equal(validateStatus(statusOutput), true, JSON.stringify(validateStatus.errors));
  assert.deepEqual(validateMediaJobReadProjection({ job, readObservation }, wire), []);
  const wrongTenantScope = structuredClone(readObservation);
  wrongTenantScope.tenantId = "another-tenant";
  assert.ok(validateMediaJobReadProjection({ job, readObservation: wrongTenantScope }, wire).includes("TENANT_SCOPE_MISMATCH"));
  const wrongOwnerScope = structuredClone(readObservation);
  wrongOwnerScope.principalId = "another-principal";
  assert.ok(validateMediaJobReadProjection({ job, readObservation: wrongOwnerScope }, wire).includes("OWNER_SCOPE_MISMATCH"));
  const staleRead = structuredClone(readObservation);
  staleRead.readVersion = 6;
  assert.ok(validateMediaJobReadProjection({ job, readObservation: staleRead }, wire).includes("READ_VERSION_MISMATCH"));
  assert.equal(validateOutcome({
    artifactType: "classified-job-and-attempt-outcome-with-evidence-references",
    payload: { job, readObservation, outcomeClassification: "OBSERVED_OUTCOME_UNKNOWN", providerReconciliation: "NOT_PERFORMED_BY_STORED_JOB_READ", safeNextAction: "USE_AUTHORIZED_RECONCILIATION_CONTRACT" },
  }), true, JSON.stringify(validateOutcome.errors));
  assert.deepEqual(validateMediaJobReadProjection({ job, readObservation, providerReconciliation: "NOT_PERFORMED_BY_STORED_JOB_READ" }, wire), []);

  const missingOwner = structuredClone(statusOutput);
  delete missingOwner.payload.readObservation.principalId;
  assert.equal(validateStatus(missingOwner), false, "owner scope is mandatory on every observed projection");
  const missingVersion = structuredClone(statusOutput);
  delete missingVersion.payload.readObservation.readVersion;
  assert.equal(validateStatus(missingVersion), false, "readVersion is mandatory so stale reads are explicit");
  const wrongState = structuredClone(statusOutput);
  wrongState.payload.readObservation.canonicalStateMapping.sourceStatus = "RUNNING";
  assert.equal(validateStatus(wrongState), false, "runtime state cannot map to a different source status");
  const falseFinality = structuredClone(statusOutput);
  falseFinality.payload.readObservation.effectFinality = "OUTPUT_REGISTRATION_UNVERIFIED";
  assert.equal(validateStatus(falseFinality), false, "effect finality is status-correlated and unknown remains unknown");
  const unsupportedMapping = structuredClone(statusOutput);
  unsupportedMapping.payload.readObservation.canonicalStateMapping.disposition = "EXACT_CANONICAL_STATE";
  unsupportedMapping.payload.readObservation.canonicalStateMapping.sourceStatus = "ACCEPTED";
  assert.equal(validateStatus(unsupportedMapping), false, "ACCEPTED cannot be promoted to QUEUED without durable-queue evidence");
  const falseProviderProof = {
    artifactType: "classified-job-and-attempt-outcome-with-evidence-references",
    payload: { job, readObservation, outcomeClassification: "OBSERVED_OUTCOME_UNKNOWN", providerReconciliation: "PROVIDER_RECONCILED", safeNextAction: "USE_AUTHORIZED_RECONCILIATION_CONTRACT" },
  };
  assert.equal(validateOutcome(falseProviderProof), false, "stored-job reads never claim provider reconciliation");
  assert.ok(validateMediaJobReadProjection({ job, readObservation, providerReconciliation: "PROVIDER_RECONCILED" }, wire).includes("STORED_READ_CANNOT_CLAIM_PROVIDER_RECONCILIATION"));
});

test("candidate-video successful output carries the exact artifact version joined to its producing job", () => {
  const operations = read(".product-experience/pdp-1-domain-data/operations.yaml");
  const schemas = operations.capabilityOperationContracts.outputPayloadSchemas;
  const output = schemas.find(
    ({ id }) => id === "media.typed-output.candidate-video-artifact-with-execution-provenance",
  );
  assert.ok(output, "canonical P1 output schema exists");
  const { schema, resultIdentityBinding } = output;
  assert.deepEqual(schema.properties.payload.required, ["jobId", "artifactId", "versionId"]);
  assert.deepEqual(resultIdentityBinding.tuple, ["jobId", "artifactId", "versionId"]);
  assert.match(resultIdentityBinding.canonicalJoin, /same-success-result.*exact-artifactId-and-versionId.*issued-jobId/u);
  assert.match(resultIdentityBinding.attemptRule, /same-job-attempt-that-produced-this-output/u);
  assert.match(resultIdentityBinding.unavailable, /return-unknown/u);
  assert.match(resultIdentityBinding.unavailable, /do-not-infer-from-jobId-or-lineage/u);
  assert.match(resultIdentityBinding.ambiguous, /return-unknown/u);
  assert.match(resultIdentityBinding.mismatch, /attemptId/u);
  assert.match(resultIdentityBinding.mismatch, /binding-error/u);
  assert.match(resultIdentityBinding.mismatch, /do-not-accept-the-output/u);

  const Ajv = require("ajv").default;
  const ajv = new Ajv({ allErrors: true, strict: false });
  ajv.addFormat("opaque-id", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  ajv.addFormat("opaque-version-id", /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/);
  ajv.addFormat("opaque-versioned-reference", /^.{1,384}$/);
  const validate = ajv.compile(schema);
  const valid = { artifactType: "candidate-video-artifact-with-execution-provenance", payload: {
    jobId: "job-7", artifactId: "video-7", versionId: "version-3", attemptId: "attempt-2",
  } };
  assert.equal(validate(valid), true, JSON.stringify(validate.errors));
  for (const field of ["artifactId", "versionId"]) {
    const missing = structuredClone(valid);
    delete missing.payload[field];
    assert.equal(validate(missing), false, `${field} is mandatory on successful typed output`);
  }
  const blankVersion = structuredClone(valid);
  blankVersion.payload.versionId = "";
  assert.equal(validate(blankVersion), false, "an empty version identity is not an exact version");

  const sourceDerived = schemas.find(
    ({ id }) => id === "media.typed-output.source-derived-candidate-video-with-lineage",
  );
  assert.ok(sourceDerived, "canonical source-derived P1 output schema exists");
  assert.deepEqual(sourceDerived.schema.properties.payload.required, ["jobId", "artifactId", "versionId", "sourceLineage"]);
  assert.deepEqual(sourceDerived.resultIdentityBinding.tuple, ["jobId", "artifactId", "versionId"]);
  assert.match(sourceDerived.resultIdentityBinding.attemptRule, /same-job-attempt-that-produced-this-output/u);
  assert.match(sourceDerived.resultIdentityBinding.sourceIdentityRule, /sourceLineage\.artifactId.*distinct.*payload-artifactId.*versionId/u);
  assert.match(sourceDerived.resultIdentityBinding.unavailable, /do-not-infer-from-jobId-or-sourceLineage/u);
  assert.match(sourceDerived.resultIdentityBinding.ambiguous, /return-unknown/u);
  assert.match(sourceDerived.resultIdentityBinding.mismatch, /binding-error.*do-not-accept-the-output/u);
  const validateSourceDerived = ajv.compile(sourceDerived.schema);
  const generatedAndSource = { artifactType: "candidate-video-artifact-with-execution-provenance", payload: {
    jobId: "job-8", artifactId: "generated-video-8", versionId: "generated-version-2", attemptId: "attempt-4",
    sourceLineage: {
      artifactId: "source-video-3", versionId: "source-version-9", sourceRef: "artifact://source-video-3/source-version-9",
      rightsContext: { artifactType: "policy-decision-reference-or-rights-observation", payload: {
        kind: "rights-observation", reference: "rights-observation:source-video-3/v1",
      } },
    },
  } };
  assert.equal(validateSourceDerived(generatedAndSource), true, JSON.stringify(validateSourceDerived.errors));
  assert.notEqual(generatedAndSource.payload.artifactId, generatedAndSource.payload.sourceLineage.artifactId,
    "generated output identity remains distinct from source artifact identity");
  assert.notEqual(generatedAndSource.payload.versionId, generatedAndSource.payload.sourceLineage.versionId,
    "generated output version remains distinct from source version");
  for (const field of ["artifactId", "versionId"]) {
    const missing = structuredClone(generatedAndSource);
    delete missing.payload[field];
    assert.equal(validateSourceDerived(missing), false, `generated ${field} is mandatory independently of source lineage`);
  }

  const outputById = new Map(schemas.map((record) => [record.id, record]));
  const generatedVideoContracts = operations.capabilityOperationContracts.records
    .filter(({ successOutputs = [] }) => successOutputs.some(({ payloadSchemaRef }) =>
      payloadSchemaRef === output.id || payloadSchemaRef === sourceDerived.id));
  assert.equal(generatedVideoContracts.length, 7, "all seven current video producer operations use a source-defined candidate-video output");

  for (const operation of generatedVideoContracts) {
    const successOutput = operation.successOutputs.find(({ payloadSchemaRef }) =>
      payloadSchemaRef === output.id || payloadSchemaRef === sourceDerived.id);
    const outputContract = outputById.get(successOutput.payloadSchemaRef);
    const expectedPayload = outputContract.schema.properties.payload;
    const outputVariants = operation.resultSchema.properties.outputs.items.oneOf
      .filter(({ properties }) => properties.artifactType.const === outputContract.artifactType);
    assert.equal(outputVariants.length, 1, `${operation.id} has one exact result-schema variant for its declared output`);
    const assertPayloadParity = (actualPayload, label) => {
      assert.equal(actualPayload.additionalProperties, expectedPayload.additionalProperties,
        `${operation.id} ${label} preserves the closed output object boundary`);
      assert.deepEqual(actualPayload.required, expectedPayload.required,
        `${operation.id} ${label} requires every identity and lineage field in its referenced output contract`);
      assert.deepEqual(Object.keys(actualPayload.properties).sort(), Object.keys(expectedPayload.properties).sort(),
        `${operation.id} ${label} declares every canonical field, including optional attempt and evidence fields`);
      for (const field of Object.keys(expectedPayload.properties)) {
        assert.strictEqual(actualPayload.properties[field], expectedPayload.properties[field],
          `${operation.id} ${label} reuses the canonical ${field} schema from ${successOutput.payloadSchemaRef}`);
      }
    };
    assertPayloadParity(outputVariants[0].properties.payload, "base result schema");

    const successRule = operation.resultSchema.allOf.find(({ if: condition }) =>
      condition?.properties?.outcome?.const === "SUCCEEDED");
    const successVariants = successRule.then.properties.outputs.items.oneOf
      .filter(({ properties }) => properties.artifactType.const === outputContract.artifactType);
    assert.equal(successVariants.length, 1, `${operation.id} success-only result schema preserves the declared output contract`);
    assertPayloadParity(successVariants[0].properties.payload, "SUCCEEDED result schema");
  }
});

test("provider and recovery populations include exact local compute and unknown asynchronous operations", () => {
  const goals = read(goalsPath);
  const capabilities = read(capPath).capabilities;
  const operationContracts = read(".product-experience/pdp-1-domain-data/operations.yaml").capabilityOperationContracts.records;
  const contracts = goals.successMeasureContracts;
  const crosswalk = contracts.ownerCapabilityApplicabilityCrosswalk;
  const providerId = "media.business.bounded-provider-execution.measure";
  const recoveryId = "media.business.safe-recoverable-operations.measure";
  const provider = new Map(crosswalk.records.map((row) => [row.capabilityRef, row.measureApplicability[providerId]]));
  const recovery = new Map(crosswalk.records.map((row) => [row.capabilityRef, row.measureApplicability[recoveryId]]));
  const providerContract = contracts.records.find(({ id }) => id === providerId);
  const recoveryContract = contracts.records.find(({ id }) => id === recoveryId);
  const operationByCapability = new Map(operationContracts.map((row) => [row.capabilityRef, row]));
  const providerRefs = [...provider].filter(([, row]) => row.disposition === "APPLICABLE_PROVIDER_PROFILE_CANDIDATE").map(([id]) => id).sort();
  const recoveryRefs = [...recovery].filter(([, row]) => row.disposition === "APPLICABLE_ASYNCHRONOUS_OPERATION_CANDIDATE").map(([id]) => id).sort();

  assert.equal(providerRefs.length, 394);
  assert.deepEqual([...providerContract.capabilityRefs].sort(), providerRefs);
  assert.equal(providerContract.ownerApplicabilityDefinition.sourceCandidateCount, providerRefs.length);
  assert.equal(crosswalk.applicableCandidateCounts[providerId], providerRefs.length);
  assert.equal(recoveryRefs.length, 445);
  assert.deepEqual([...recoveryContract.capabilityRefs].sort(), recoveryRefs);
  assert.equal(recoveryContract.ownerApplicabilityDefinition.sourceCandidateCount, recoveryRefs.length);
  assert.equal(crosswalk.applicableCandidateCounts[recoveryId], recoveryRefs.length);
  assert.equal(crosswalk.executionAdmission, "NOT_ADMITTED");
  for (const id of capabilities.map(({ id }) => id).filter((id) => id.startsWith("media.recipe.template."))) {
    assert.equal(recovery.get(id).disposition, "APPLICABLE_ASYNCHRONOUS_OPERATION_CANDIDATE", `${id} may commit its specification after request interruption`);
    assert.match(recovery.get(id).reason, /explicitly included in this measure's owner-defined capabilityRefs population/u,
      `${id} is a conservative source-defined candidate, not a claim of admitted async behavior`);
    assert.equal(provider.get(id).disposition, "NOT_APPLICABLE_NOT_EXECUTION_PROFILE_OPERATION", `${id} defines a recipe but does not dispatch media execution`);
    const recipe = capabilities.find((entry) => entry.id === id);
    assert.equal(recipe.ownerDefinition.effect.effectIntentScope, "LOCAL_CANDIDATE_OR_DRAFT");
    assert.ok(recipe.ownerDefinition.successOutputs.some(({ artifactType }) => artifactType === "versioned-MediaRecipe-with-content-and-schema-bindings"));
  }

  for (const id of [
    "media.audio.analysis.measure.loudness",
    "media.artifact.import",
    "media.artifact.derive",
    "media.artifact.output.register",
    "media.job.submit",
    "media.job.retry",
    "media.stream.frame.submit",
    "media.stream.recording.integrate",
    "media.stream.live-processing.integrate",
    "media.stream.caption.live",
    "media.stream.transport.hls",
    "media.color.white-balance",
    "media.deliver.encode",
    "media.enhance.audio.noise-suppression",
    "media.multimodal.analyze.cross-modal",
    "media.quality.audio.audio.assess-noise",
    "media.speech.transcription.file",
    "media.sync.sample-accurate-av-map",
    "media.vision.detect",
  ]) {
    const capability = capabilities.find((entry) => entry.id === id);
    const binding = crosswalk.records.find((entry) => entry.capabilityRef === id);
    const operationBinding = operationByCapability.get(id);
    assert.equal(provider.get(id).disposition, "APPLICABLE_PROVIDER_PROFILE_CANDIDATE", id);
    assert.equal(recovery.get(id).disposition, "APPLICABLE_ASYNCHRONOUS_OPERATION_CANDIDATE", id);
    assert.ok(binding.profileRef, `${id} has an exact selected profile contract`);
    assert.ok(binding.boundsRef, `${id} has exact bounds`);
    assert.ok(operationBinding?.operationRefs.length, `${id} has exact canonical operation refs in the PDP-1 operation authority`);
    assert.ok(capability.outputArtifactTypes.length, `${id} has a typed output`);
    assert.match(provider.get(id).reason, /explicitly included in this measure's owner-defined capabilityRefs population/u,
      `${id} candidacy follows the exact frozen P0 capability population`);
    assert.ok(provider.get(id).sourceRefs.includes(`.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=${id}`));
    assert.ok(provider.get(id).sourceRefs.includes(`.product-experience/pdp-0-product-truth/goals-jtbd.yaml#successMeasureContracts/records/@id=${providerId}`));
    assert.ok(capability.ownerDefinition.successOutputs?.length, `${id} has a typed owner-defined success output`);
    assert.match(recovery.get(id).reason, /explicitly included in this measure's owner-defined capabilityRefs population/u,
      `${id} remains a conservative candidate until owner contracts supply qualified recovery proof`);
  }

  for (const id of [
    "media.project.create",
    "media.project.version",
    "media.project.source-asset.attach",
    "media.artifact.ingest",
    "media.artifact.upload",
    "media.artifact.upload.resume",
    "media.artifact.import",
    "media.artifact.download",
    "media.artifact.derive",
    "media.artifact.output.register",
    "media.artifact.provenance.export",
    "media.artifact.delete",
    "media.artifact.share",
    "media.artifact.share.revoke",
    "media.artifact.retain",
    "media.stream.session.open",
    "media.stream.session.connect",
    "media.stream.frame.submit",
    "media.stream.frame.acknowledge",
    "media.stream.session.close",
    "media.stream.session.reconnect",
    "media.stream.ordering.enforce",
    "media.stream.lease.renew",
    "media.stream.buffer.bound",
    "media.stream.backpressure.apply",
    "media.stream.recording.integrate",
    "media.stream.live-processing.integrate",
    "media.stream.transport.hls",
    "media.stream.caption.live",
    "media.rights.attestation.record",
    "media.provenance.retention.effect.record",
    "media.provenance.erasure.effect.record",
  ]) {
    assert.equal(recovery.get(id).disposition, "APPLICABLE_ASYNCHRONOUS_OPERATION_CANDIDATE", id);
  }

  for (const id of [
    "media.job.submit",
    "media.job.cancel",
    "media.job.retry",
    "media.job.watch",
  ]) {
    assert.equal(recovery.get(id).disposition, "APPLICABLE_ASYNCHRONOUS_OPERATION_CANDIDATE", id);
  }

  for (const id of [
    "media.recipe.template.physics-math-explainer",
    "media.project.create",
    "media.artifact.inspect",
    "media.job.view-status",
    "media.job.list",
  ]) {
    assert.notEqual(provider.get(id).disposition, "APPLICABLE_PROVIDER_PROFILE_CANDIDATE", id);
  }
  for (const id of [
    "media.project.inspect",
    "media.project.search",
    "media.job.view-status",
    "media.job.list",
  ]) {
    assert.notEqual(recovery.get(id).disposition, "APPLICABLE_ASYNCHRONOUS_OPERATION_CANDIDATE", id);
  }
});
