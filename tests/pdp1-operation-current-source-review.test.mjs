import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const sourcePath = ".product-experience/pdp-1-domain-data/operations.yaml";
const sourceBytes = readFileSync(resolve(root, sourcePath));
const source = parse(sourceBytes.toString("utf8"));
const wirePath = ".product-experience/pdp-1-domain-data/owner-action-wire-contracts.yaml";
const wireBytes = readFileSync(resolve(root, wirePath));
const wire = parse(wireBytes.toString("utf8"));
const review = JSON.parse(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/operations-current-source-review.json"), "utf8"));
const decisionLog = readFileSync(resolve(root, ".product-experience/decision-log.md"), "utf8");
const operations = new Map(source.individualOperationContracts.records.map((row) => [row.id, row]));
const ownerOperations = new Map(source.ownerDefinedOperationContracts.records.map((row) => [row.id, row]));
const sha256 = createHash("sha256").update(sourceBytes).digest("hex");
const wireSha256 = createHash("sha256").update(wireBytes).digest("hex");
const readSourceYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));

test("P1 operation current-source review pins this source and preserves historical cuts", () => {
  assert.equal(review.schemaVersion, "media.pdp1-operation-current-source-review.v1");
  assert.equal(review.reviewKind, "P1_OWNER_SOURCE_RECONCILIATION");
  assert.equal(review.sourcePath, sourcePath);
  assert.equal(review.currentSourceSha256, sha256);
  const reinspection = review.currentSourceReinspection;
  assert.equal(reinspection.status, "REINSPECTED_CURRENT_SOURCE_CUT");
  assert.equal(reinspection.currentSourceSha256, sha256);
  assert.equal(reinspection.previousReviewedSourceSha256,
    "2ea3da8af4d332be51c7322060641de5f59a13e3b00833e03105f5d13049d55c");
  assert.equal(reinspection.previousSourceBytesAvailableInGit, false);
  assert.match(reinspection.method, /complete current operations source tree directly/u);
  assert.match(reinspection.sourceChangeGroupsInterpretation,
    /do not claim to identify every incremental 2ea3da8a-to-11d51ef edit/u);
  assert.match(review.currentSourceCutDeltaReview.sourceChangeGroupsScope,
    /not asserted to enumerate an exact change set/u);
  assert.equal(reinspection.currentPopulations.capabilityOperationRecords,
    source.capabilityOperationContracts.records.length);
  assert.equal(reinspection.currentPopulations.canonicalOperations, 448);
  assert.equal(reinspection.currentPopulations.capabilityBindingRecords, 14);
  assert.equal(reinspection.currentPopulations.inputPayloadSchemas,
    source.capabilityOperationContracts.inputPayloadSchemas.length);
  assert.equal(reinspection.currentPopulations.outputPayloadSchemas,
    source.capabilityOperationContracts.outputPayloadSchemas.length);
  assert.deepEqual(reinspection.outstandingMeaningIds, []);
  assert.equal(reinspection.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(reinspection.transportAdmission, "NOT_ADMITTED");
  assert.deepEqual(review.historicalCuts.map(({ decisionRef, sourceSha256 }) => [decisionRef, sourceSha256]), [
    [".product-experience/decision-log.md#PXD-094", "16cb028dcb28ec7d91b8698412a2f1a41c05f5779d7164f42cd13facd7389e54"],
    [".product-experience/decision-log.md#PXD-046", "f279538b72a1bdd73a6cf88556eebdaf91c9799a033f460233b796bf8df8f89d"],
  ]);
  assert.match(review.historicalCuts[0].meaning, /Immutable historical/u);
  assert.match(review.historicalCuts[1].meaning, /retained as history/u);
});

test("P1 source review pins the current 79-record wire cut and changed owner-wire records", () => {
  const wireReview = review.relatedOwnerSourceReconciliation;
  assert.equal(wireReview.sourcePath, wirePath);
  assert.equal(wireReview.currentSourceSha256, wireSha256);
  assert.equal(wireReview.recordCount, 79);
  assert.equal(wire.records.length, wireReview.recordCount);
  assert.equal(wireReview.priorSourceSha256, "190538ff25b8a86bde587f28c60ccae399a30cb72f42d820ca4d9520bb0ccc5b");
  assert.deepEqual(wireReview.changedRecordIds, wire.records.map(({ id }) => id).sort(),
    "all result envelopes changed in the prior source cut; request-only changes are tracked in the same complete population");

  const query = wire.records.find(({ id }) => id === "media.owner-action-wire.inspect-job-retry-policy.v1");
  assert.ok(query);
  assert.deepEqual(wireReview.preservedRole, {
    actionRef: null,
    sourceActionRef: null,
    actionApplicability: "OWNER_OPERATION_WITH_NO_SOURCE_ACTION_IDENTITY",
    operationKind: "QUERY",
  });
  assert.equal(query.actionRef, wireReview.preservedRole.actionRef);
  assert.equal(query.sourceActionRef, wireReview.preservedRole.sourceActionRef);
  assert.equal(query.actionApplicability, wireReview.preservedRole.actionApplicability);
  assert.equal(query.operationKind, wireReview.preservedRole.operationKind);
  assert.equal(query.actionClassification, "DOMAIN_QUERY");
  assert.equal(query.semantics.runtimeAdmission, "NOT_ADMITTED");

  const statusWire = wire.records.find(({ id }) => id === "media.owner-action-wire.view-job-status.v1");
  assert.ok(statusWire);
  const statusObserved = statusWire.resultSchema.oneOf.find(({ properties }) => properties.outcome?.const === "OBSERVED");
  const statusUnknown = statusWire.resultSchema.oneOf.find(({ properties }) => properties.outcome?.enum?.includes("UNKNOWN"));
  assert.ok(statusObserved);
  assert.ok(statusUnknown);
  assert.ok(statusObserved.required.includes("currentness"));
  assert.deepEqual(statusObserved.properties.currentness.enum, ["CURRENT", "STALE"]);
  assert.equal(Object.hasOwn(statusUnknown.properties, "currentness"), false);
  assert.equal(Object.hasOwn(statusUnknown.properties, "observationRefs"), false);
  assert.equal(statusWire.sourceRecovery, "keep-last-known-state-labelled-stale");
  assert.match(statusWire.semantics.freshnessSemantics, /STALE means only last-known evidence/u);
  assert.match(statusWire.semantics.freshnessSemantics, /unavailable or unknown evidence uses the UNKNOWN result branch/u);
  assert.equal(statusWire.semantics.runtimeAdmission, "NOT_ADMITTED");
  assert.match(decisionLog, /### PXD-161 — Preserve current and stale job-status observations distinctly/u);
});

test("P1 source review reconciles the current capability mapping census and bounded projections", () => {
  const mappingReview = review.capabilityOperationMappingReconciliation;
  const mappings = source.capabilityOperationContracts.records;
  assert.equal(mappingReview.recordCount, 462);
  assert.equal(mappings.length, mappingReview.recordCount);

  const owner = ownerOperations.get("media.operation.job.submit.v1");
  const adapters = owner.requestSemantics.typedInputValidator.directFieldAdapters;
  assert.deepEqual(mappingReview.directRequestAdapters, [
    { capabilityRef: "media.artifact.import", operationRef: "media.operation.artifact.import.v1", directFields: ["source", "target", "governance"] },
    { capabilityRef: "media.artifact.derive", operationRef: "media.operation.artifact.derive.v1", directFields: ["sources", "transformation", "output", "governance"] },
  ]);
  for (const row of mappingReview.directRequestAdapters) {
    const adapter = adapters.find((candidate) => candidate.capabilityRef === row.capabilityRef);
    assert.ok(adapter);
    assert.equal(adapter.targetOperationRef, row.operationRef);
    assert.deepEqual(adapter.directFields, row.directFields);
  }

  const projections = mappingReview.acceptedOutputProjections;
  assert.equal(projections.length, 2);
  for (const item of projections) {
    const mapping = mappings.find(({ capabilityRef }) => capabilityRef === item.capabilityRef)?.outputMapping.success;
    const actual = mapping?.receiptProjection ?? mapping?.outputProjection;
    for (const key of Object.keys(item)) {
      if (key !== "capabilityRef") assert.equal(actual?.[key], item[key], `${item.capabilityRef} ${key}`);
    }
  }
  assert.equal(projections[0].operator, "OWNER_ISSUED_RECEIPT_IDENTITY");
  assert.equal(projections[1].operator, "EXACT_OPAQUE_REFERENCE_VALUE");

  const execution = mappingReview.executionReferenceDisposition;
  const provenance = mappings.find(({ capabilityRef }) => capabilityRef === execution.capabilityRef);
  assert.equal(execution.decisionRef, ".product-experience/decision-log.md#PXD-152");
  assert.equal(provenance.executionReferenceBranchDisposition.status, execution.status);
  assert.deepEqual(execution.allowedIdentityKinds, ["ProcessingJob", "JobAttempt"]);
  assert.equal(execution.excludedIdentityKind, "MediaRun");
  assert.equal(execution.runtimeAdmission, "NOT_ADMITTED");
});

test("P1 semantic delta selectors resolve to current operation facts", () => {
  const records = review.currentSemanticReconciliation.records;
  assert.equal(records.length, 11);
  assert.match(review.currentSemanticReconciliation.basis, /eleven selectors below/u);
  assert.deepEqual(new Set(records.map(({ id }) => id)), new Set([
    "media.operation-slice.inspect-upload", "media.operation-slice.inspect-artifact",
    "media.operation-slice.inspect-job", "media.operation-slice.submit-job",
    "media.operation-slice.begin-upload", "media.operation-slice.append-upload-chunk",
    "media.operation-slice.complete-upload", "media.operation-slice.inspect-provenance",
    "media.operation.action.inspect-job-retry-policy", "media.operation.job.submit.v1",
    "media.operation.stream-session.inspect-execution-recovery.v1",
  ]));
  for (const item of records) {
    assert.ok(item.selector.includes(`@id=${item.id}`), `${item.id} selector identifies its exact operation`);
    assert.ok(item.meaning.length > 30, `${item.id} has semantic reconciliation, not only a hash`);
    assert.ok(operations.has(item.id) || ownerOperations.has(item.id), `${item.id} resolves in current operations`);
  }

  for (const id of ["media.operation-slice.inspect-upload", "media.operation-slice.inspect-artifact", "media.operation-slice.inspect-job"]) {
    assert.equal(operations.get(id).operationKind, "QUERY", `${id} remains an observation`);
  }
  const submit = operations.get("media.operation-slice.submit-job");
  assert.equal(submit.operationKind, "COMMAND");
  assert.match(submit.preconditions, /source does not define complete consent\/rights/u);

  const begin = operations.get("media.operation-slice.begin-upload").ownerSemantics;
  assert.deepEqual(begin.replay.keyScope, ["tenantId", "principalId", "idempotencyKey"]);
  assert.equal(begin.replay.requestBinding, "canonical-full-upload-request-v1");
  assert.match(begin.replay.sameKeyDifferentPayload, /reject-without-creating-or-mutating/u);
  const append = operations.get("media.operation-slice.append-upload-chunk").ownerSemantics;
  assert.match(append.ordering, /current-nextChunkIndex/u);
  assert.match(append.unknownOutcome.automaticReplay, /prohibited/u);
  const complete = operations.get("media.operation-slice.complete-upload").ownerSemantics.completionReplay;
  assert.match(complete.concurrentOrRestartRecovery, /preserve-unknown/u);
  assert.match(complete.payloadHashIdempotency, /not-a-valid-description/u);

  const provenance = ownerOperations.get("media.operation-slice.inspect-provenance");
  const provenanceReview = records.find(({ id }) => id === "media.operation-slice.inspect-provenance");
  assert.equal(provenanceReview.decisionRef, ".product-experience/decision-log.md#PXD-152");
  assert.ok(provenance.sourceRefs.includes(".product-experience/decision-log.md#PXD-152"));
  assert.match(provenance.preconditions.join(" "), /exact opaque reference.*authoritative mapping.*tenant.*principal.*ProcessingJob or JobAttempt identity/su);
  assert.match(JSON.stringify(provenance.resultSchema), /ProcessingJob.*tenantId\+jobId.*JobAttempt.*tenantId\+jobId\+attemptId/u);
  assert.match(provenance.requestResultBinding.resolvedExecutionIdentity, /PROCESSING_JOB_OR_JOB_ATTEMPT/u);
  assert.match(provenance.preconditions.join(" "), /MediaRun is excluded/u);
  assert.match(provenance.scopeStatus, /transport-and-runtime-NOT_ADMITTED/u);
  assert.match(provenanceReview.meaning, /Runtime and transport remain NOT_ADMITTED/u);

  const actionRegistryPath = ".product-experience/pdp-3-product-experience/action-registry.yaml";
  const actionRegistry = readSourceYaml(actionRegistryPath);
  const provenanceAction = actionRegistry.actions.find(({ id }) => id === "media.action.inspect-provenance");
  const crosswalk = review.capabilityOperationMappingReconciliation.sourceActionCapabilityCrosswalk;
  assert.equal(crosswalk.actionRef, provenanceAction.id);
  assert.equal(crosswalk.capabilityRef, "media.provenance.source-lineage.inspect");
  assert.equal(crosswalk.operationRef, "media.operation-slice.inspect-provenance");
  assert.equal(crosswalk.decisionRef, ".product-experience/decision-log.md#PXD-152");
  assert.ok(provenanceAction.capabilityRefs.includes(crosswalk.capabilityRef));
  assert.deepEqual(provenanceAction.actionDefinitionSemantics.typedDefinition.exactOperationRefs, [crosswalk.operationRef]);
  const sourceBinding = source.capabilityOperationContracts.records.find(({ capabilityRef }) => capabilityRef === crosswalk.capabilityRef);
  assert.deepEqual(sourceBinding.operationRefs, [crosswalk.operationRef]);
  assert.equal(sourceBinding.operationKind, "QUERY");
  assert.equal(crosswalk.runtimeAdmission, "NOT_ADMITTED");
  const actionRegistryHash = createHash("sha256").update(readFileSync(resolve(root, actionRegistryPath))).digest("hex");
  assert.equal(crosswalk.actionRegistrySha256, actionRegistryHash);

  const retryReview = records.find(({ id }) => id === "media.operation.action.inspect-job-retry-policy");
  const retryOperation = ownerOperations.get(retryReview.id);
  const retryObservation = source.ownerTypedObservationContracts.records.find(({ id }) =>
    id === "media.observation-contract.retry-policy-current-read.v1");
  const retryValidation = source.ownerTypedObservationValidationRules.records.find(({ id }) =>
    id === "media.observation-validation.retry-policy-current-read.v1");
  assert.equal(retryReview.decisionRef, ".product-experience/decision-log.md#PXD-155");
  assert.ok(retryReview.meaning.includes("retry execution remain NOT_ADMITTED"));
  assert.match(decisionLog, /### PXD-155 — Bind retry eligibility only to retry dispatch/u);
  assert.equal(retryOperation.operationKind, "QUERY");
  assert.equal(retryOperation.readContractRef,
    ".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.retry-policy-current-read.v1");
  assert.equal(retryOperation.executionAdmission, "NOT_ADMITTED");
  assert.equal(retryObservation.bindingStatus, "OWNER_DEFINED_DEFINITION_ONLY_NO_ENDPOINT_OR_RUNTIME_BINDING");
  assert.deepEqual(retryObservation.requestSchema.required, ["queryId", "jobId", "priorAttemptId"]);
  assert.equal(Object.hasOwn(retryObservation.requestSchema.properties, "tenantId"), false);
  assert.equal(Object.hasOwn(retryObservation.requestSchema.properties, "principalId"), false);
  assert.match(retryObservation.trustedContext.source, /authenticated-host-context/u);
  assert.match(retryObservation.trustedContext.source, /caller-tenant-and-principal-forbidden/u);
  assert.deepEqual(retryObservation.bindingRules.map(({ id }) => id), [
    "media.observation-binding.retry-policy.query-id.v1",
    "media.observation-binding.retry-policy.job-id.v1",
    "media.observation-binding.retry-policy.attempt-id.v1",
  ]);
  assert.match(retryObservation.resultRules.join(" "), /RETRYABLE.*DEFINITIVE_NO_EFFECT.*DEFINITIVE_RETRYABLE_FAILURE.*retriesRemaining.*greater than zero/su);
  assert.match(retryObservation.resultRules.join(" "), /missing, stale, foreign-scope, malformed, mismatched, or unknown current read yields UNKNOWN/u);
  assert.ok(retryValidation.predicates.some(({ when, require }) =>
    when.includes("observation.kind == UNKNOWN") && require.includes("truth is UNKNOWN")));
  assert.match(retryObservation.scopeStatus, /runtime observation remain\s+NOT_ADMITTED_OR_UNKNOWN/u);

  const policyReview = records.find(({ id }) => id === "media.operation.job.submit.v1");
  assert.equal(policyReview.decisionRef, ".product-experience/decision-log.md#PXD-157");
  const submitWrapper = ownerOperations.get(policyReview.id).ownerWireSchema.requestSchema.definitions.typedInputs["preservation-and-enhancement-policy"];
  const canonicalPolicy = source.capabilityOperationContracts.inputPayloadSchemas.find(({ id }) => id === "media.typed-input.preservation-and-enhancement-policy").schema;
  assert.deepEqual(submitWrapper, canonicalPolicy);
  assert.match(policyReview.meaning, /canonical.*preservation.*typed input/u);

  const recoveryReview = records.find(({ id }) => id === "media.operation.stream-session.inspect-execution-recovery.v1");
  const recovery = ownerOperations.get(recoveryReview.id);
  assert.equal(recoveryReview.decisionRef, ".product-experience/decision-log.md#PXD-160");
  assert.equal(recovery.operationKind, "QUERY");
  assert.deepEqual(recovery.requestSchema.required, ["sessionId"]);
  assert.deepEqual(recovery.trustedContext, { tenantId: "host-attested", principalId: "host-attested" });
  assert.match(recovery.readSemantics, /CURRENT` means only that the referenced consent or purpose revision is current/u);
  assert.match(recovery.readSemantics, /Reconnect authority remains a separate guard/u);
  assert.equal(recovery.executionAdmission, "NOT_ADMITTED");
  assert.match(recoveryReview.meaning, /source-selected prior-effect interval/u);
  assert.match(recoveryReview.meaning, /No execution-reference identity, dispatch, replay, endpoint, or runtime admission/u);
});

test("P1 operation census semantically reconciles fixture CLI and SDK populations", () => {
  const census = source.sourceDenominators;
  const cli = census.cliSimulationCommands;
  const cliReview = review.interfacePopulationReconciliation.fixtureCli;
  const cliRegistry = readSourceYaml(".product-experience/pdp-3-product-experience/cli/command-registry.yaml");
  const cliIds = cliRegistry.commands.map(({ id }) => id).sort();
  assert.equal(cli.currentFixtureRegistryRecords, 11);
  assert.equal(cliReview.registryRecords, 11);
  assert.deepEqual(cli.exactObservedCommandIds.slice().sort(), cliIds);
  assert.deepEqual(Object.keys(cli.operationIntentByExactActionRef).sort(), cliIds);
  assert.deepEqual(cli.operationIntentByExactActionRef, cliReview.actionRefIntentCrosswalk);
  assert.equal(cliReview.operationIntentCrosswalkRecords, cliIds.length);
  assert.deepEqual(cli.directCommandOperationRefIds,
    ["media.fixture-cli.caption-save-version", "media.fixture-cli.caption-compare-versions"]);
  assert.equal(cli.directCommandOperationRefIds.length, cliReview.directCommandOperationRefRecords);
  assert.deepEqual(cli.unresolvedProductionRuntimeCommandIds.slice().sort(), cliIds,
    "operation intent on a synthetic fixture does not imply production runtime admission");
  assert.equal(cliReview.productionRuntimeAdmission, "NOT_ADMITTED");

  const sdk = census.sdkMethods;
  const sdkReview = review.interfacePopulationReconciliation.sdkMethods;
  const sdkRegistry = readSourceYaml(".product-experience/pdp-3-product-experience/sdk/operation-registry.yaml");
  const sdkIds = sdkRegistry.methods.map(({ id }) => id).sort();
  assert.equal(sdk.registryRecords, 33);
  assert.equal(sdk.parserDerivedPublicMethodIdentities, 30);
  assert.equal(sdkReview.rawRegistryRecords, sdk.registryRecords);
  assert.equal(sdkReview.publicMethodIdentities, sdk.parserDerivedPublicMethodIdentities);
  assert.deepEqual(sdk.exactObservedRegistryIds.slice().sort(), sdkIds);
  assert.ok(sdk.exactObservedRegistryIds.includes("media.sdk.getUploadSession"));
  assert.deepEqual(sdk.boundedCanonicalOperations, sdkReview.boundedCanonicalOperations);
  assert.deepEqual(sdk.boundedCanonicalReads, sdkReview.boundedCanonicalReads);
  assert.ok(sdkReview.boundedCanonicalReads.includes("media.sdk.getUploadSession"));

  const flattenRoles = (roles) => Object.values(roles).flat();
  const rolePartitions = [
    ...sdk.boundedCanonicalOperations,
    ...sdk.boundedCanonicalReads,
    ...flattenRoles(sdk.sourceBackedNonOperationDispositions),
    ...sdk.sourceBackedLegacyNotEquivalentOperationIds,
    ...sdk.unresolvedOperationIds,
  ];
  assert.equal(rolePartitions.length, 30);
  assert.equal(new Set(rolePartitions).size, rolePartitions.length, "SDK roles must partition public identities without overlap");
  assert.deepEqual(new Set(rolePartitions), new Set(sdkIds.filter((id) => !["media.sdk.for", "media.sdk.if", "media.sdk.clearTimeout"].includes(id))));
  assert.deepEqual(sdk.sourceBackedNonOperationDispositions, sdkReview.sourceBackedNonOperationDispositions);
  assert.deepEqual(sdk.sourceBackedLegacyNotEquivalentOperationIds, sdkReview.sourceBackedLegacyNotEquivalentOperationIds);
  assert.deepEqual(sdk.unresolvedOperationIds, sdkReview.equivalenceUnknownIds);
  assert.deepEqual(sdk.unresolvedOperationIds, []);

  const parity = readSourceYaml(".product-experience/interface-parity/operation-parity.yaml");
  const sdkSurface = parity.surfaces.find(({ surface }) => surface === "SDK registry");
  assert.deepEqual(sdkSurface.unresolved, sdkReview.equivalenceUnknownIds);
  assert.deepEqual(sdkReview.equivalenceUnknownIds, []);
  assert.deepEqual(sdkSurface.unresolved, []);
  for (const id of ["media.sdk.synthesize", "media.sdk.analyzeMultimodal"]) {
    const contract = parity.typedSdkMethodContracts.find((row) => row.identity === id);
    const disposition = parity.typedMethodDispositions.find((row) => row.identity === id);
    assert.equal(contract.bindingStatus, "NOT_ADMITTED");
    assert.equal(contract.candidateOperationRef, null);
    assert.equal(disposition.openApiBindingDisposition, "NOT_ADMITTED");
    assert.ok(sdkReview.sourceBackedLegacyNonEquivalenceRationale[id]);
    assert.equal(sdk.sourceBackedLegacyNotEquivalentOperationIds.includes(id), true);
  }
  assert.equal(sdkReview.runtimeAdmission, "NOT_ADMITTED");
  assert.match(sdkReview.equivalenceUnknownMeaning, /no remaining SDK exact-operation equivalence unknowns/u);
});

test("the P1 source review does not imply implementation, admission, or phase acceptance", () => {
  assert.equal(review.scope.phase, "PDP-1");
  assert.equal(review.scope.definitionStatus, "SOURCE_RECONCILED_FOR_DEVELOPMENT");
  assert.equal(review.scope.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(review.scope.implementationClaim, "NONE");
  assert.equal(review.scope.phaseAcceptanceClaim, "NONE");
  assert.equal(review.scope.p0ApprovalClaim, "NONE");
  for (const source of review.interfacePopulationReconciliation.sourcePins) {
    const actual = createHash("sha256").update(readFileSync(resolve(root, source.path))).digest("hex");
    assert.equal(actual, source.sha256, `${source.path} changed; refresh this semantic census review`);
  }
});
