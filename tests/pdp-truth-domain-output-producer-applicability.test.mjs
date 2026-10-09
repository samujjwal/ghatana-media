import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const read = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const { validateMediaJobReadProjection } = await import("../scripts/pdp-truth-domain-job-read-model.mjs");
const goalsPath = ".product-experience/pdp-0-product-truth/goals-jtbd.yaml";
const capPath = ".product-experience/pdp-0-product-truth/capabilities.yaml";
const measureId = "media.business.trustworthy-versioned-outputs.measure";
const candidate = "APPLICABLE_OUTPUT_PRODUCER_CANDIDATE";
const excluded = "NOT_APPLICABLE_READ_ONLY_OR_NO_OUTPUT_OPERATION";

test("trustworthy-output applicability follows output-producer role and preserves incomplete candidates", () => {
  const goals = read(goalsPath);
  const capabilities = read(capPath).capabilities;
  const contract = goals.successMeasureContracts.records.find(({ id }) => id === measureId);
  const crosswalk = goals.successMeasureContracts.ownerCapabilityApplicabilityCrosswalk;
  const dispositions = new Map(crosswalk.records.map(({ capabilityRef, measureApplicability }) => [capabilityRef, measureApplicability[measureId]]));
  const producerRefs = [...dispositions].filter(([, row]) => row.disposition === candidate).map(([id]) => id).sort();
  const metricRefs = [...contract.capabilityRefs].sort();

  assert.equal(capabilities.length, 462);
  assert.equal(producerRefs.length, 430);
  assert.deepEqual(metricRefs, producerRefs, "metric candidate set is exactly the output-producer disposition set");
  assert.equal(contract.ownerApplicabilityDefinition.sourceCandidateCount, producerRefs.length);
  assert.equal(crosswalk.applicableCandidateCounts[measureId], producerRefs.length);
  assert.equal(contract.denominator, "Count every output-producing operation-contract/profile pair selected in the frozen release profile, including pairs with missing, rejected, or incomplete contracts. Exclude read-only operations only with a source-linked non-output rationale recorded per pair.");

  for (const id of [
    "media.project.create",
    "media.project.version",
    "media.project.source-asset.attach",
    "media.deliver.package",
    "media.deliver.subtitles",
    "media.artifact.upload.resume",
    "media.job.submit",
    "media.job.submit",
    "media.job.retry",
    "media.artifact.import",
    "media.artifact.derive",
    "media.artifact.output.register",
    "media.stream.frame.submit",
    "media.stream.live-processing.integrate",
    "media.stream.recording.integrate",
    "media.stream.caption.live",
    "media.stream.transport.hls",
    "media.rights.attestation.record",
    "media.speech.transcription.file",
    "media.vision.detect",
    "media.simulation.output.rgb",
    "media.quality.image.image.assess-noise",
  ]) {
    const row = dispositions.get(id);
    assert.equal(row.disposition, candidate, `${id} is a producer, including when its result identity contract is incomplete`);
    assert.match(row.ownerApplicabilityBasis, /^OWNER_/);
    if (!new Set(["media.job.retry", "media.stream.frame.submit", "media.rights.attestation.record"]).has(id)) {
      assert.match(row.reason, /even if the present contract lacks immutable identity/);
    } else {
      assert.match(row.reason, /incomplete/);
    }
    assert.ok(row.sourceRefs.some((ref) => ref === `${capPath}#${id}`));
  }

  for (const id of [
    "media.project.inspect",
    "media.project.search",
    "media.artifact.inspect",
    "media.artifact.search",
    "media.artifact.list",
    "media.artifact.source-reference.resolve",
    "media.job.outputs.inspect",
    "media.provenance.source-lineage.inspect",
    "media.provenance.execution-lineage.inspect",
    "media.job.view-status",
    "media.job.list",
    "media.job.cancel",
    "media.profile.validate",
    "media.capability.discover",
    "media.health.readiness.inspect",
    "media.rights.permitted-use.evaluate",
    "media.stream.session.open",
  ]) {
    const row = dispositions.get(id);
    assert.equal(row.disposition, excluded, `${id} observes or controls state without producing Media content`);
    assert.equal(row.ownerApplicabilityBasis, "READ_ONLY_OR_NO_MEDIA_CONTENT_OUTPUT");
    assert.match(row.reason, /(?:not produced or delivered Media content|creates or delivers no Media output|creates no new media output|creates no media content|creates no new media content|creates or delivers no media content|produces no new Media content|not an output-producing operation)/i);
    assert.ok(row.sourceRefs.some((ref) => ref === `${capPath}#${id}`));
  }

  const projected = crosswalk.measureApplicabilityRecords.records.filter(({ measureRef }) => measureRef === measureId);
  assert.equal(projected.length, 462);
  for (const { capabilityRef, disposition, reason, ownerApplicabilityBasis } of projected) {
    const sourceRow = dispositions.get(capabilityRef);
    assert.equal(disposition, sourceRow.disposition);
    assert.equal(reason, sourceRow.reason);
    assert.equal(ownerApplicabilityBasis, sourceRow.ownerApplicabilityBasis);
  }
  assert.equal(contract.baseline, "NOT_EVALUATED; applicable operations and runtime evidence have not been qualified as a complete population.");
  assert.equal(contract.qualification, "NOT_EVALUATED");
});

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
    assert.equal(binding.ownerReadModelRef, ".product-experience/pdp-1-domain-data/operations.yaml#individualOperationContracts.records.media.operation-slice.inspect-job.ownerWireSchema");
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
    startedAt: "2026-10-08T12:01:00Z", completedAt: null, result: {}, failureCode: null, version: 7, requestFingerprint: `sha256:${"a".repeat(64)}`,
  };
  const readObservation = {
    tenantId: "tenant-1", principalId: "principal-1", readVersion: 7, observedAt: "2026-10-08T12:02:00Z",
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

test("provider and recovery populations include exact local compute and unknown asynchronous operations", () => {
  const goals = read(goalsPath);
  const capabilities = read(capPath).capabilities;
  const contracts = goals.successMeasureContracts;
  const crosswalk = contracts.ownerCapabilityApplicabilityCrosswalk;
  const providerId = "media.business.bounded-provider-execution.measure";
  const recoveryId = "media.business.safe-recoverable-operations.measure";
  const provider = new Map(crosswalk.records.map((row) => [row.capabilityRef, row.measureApplicability[providerId]]));
  const recovery = new Map(crosswalk.records.map((row) => [row.capabilityRef, row.measureApplicability[recoveryId]]));
  const providerContract = contracts.records.find(({ id }) => id === providerId);
  const recoveryContract = contracts.records.find(({ id }) => id === recoveryId);
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
    assert.match(recovery.get(id).reason, /mutation boundary[\s\S]*may commit[\s\S]*request is interrupted/u);
    assert.equal(provider.get(id).disposition, "NOT_APPLICABLE_NOT_EXECUTION_PROFILE_OPERATION", `${id} defines a recipe but does not dispatch media execution`);
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
    assert.equal(provider.get(id).disposition, "APPLICABLE_PROVIDER_PROFILE_CANDIDATE", id);
    assert.equal(recovery.get(id).disposition, "APPLICABLE_ASYNCHRONOUS_OPERATION_CANDIDATE", id);
    assert.ok(binding.profileRef, `${id} has an exact selected profile contract`);
    assert.ok(binding.boundsRef, `${id} has exact bounds`);
    assert.ok(binding.operationRefs.length, `${id} has exact canonical operation refs`);
    assert.ok(capability.outputArtifactTypes.length, `${id} has a typed output`);
    assert.match(provider.get(id).reason, new RegExp(capability.outputArtifactTypes[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(provider.get(id).reason, new RegExp(binding.profileRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(recovery.get(id).reason, /no exact owner contract proves this operation completes/);
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
