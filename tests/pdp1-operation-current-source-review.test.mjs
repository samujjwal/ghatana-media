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
const p0Capabilities = parse(readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/capabilities.yaml"), "utf8"));
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
    "f2d32a678d1cbe197d92ac74c4a6ec2efbda7dedd506e38a07462bd739ba5087");
  assert.equal(review.currentSourceCutDeltaReview.currentSourceSha256, sha256);
  assert.equal(review.currentSourceCutDeltaReview.focusedVerification.status,
    "HISTORICAL_PASS_NOT_CURRENT_FOR_PXD164");
  assert.equal(review.currentSourceCutDeltaReview.focusedVerification.currentSourceSha256,
    "62d0a4050a43da1c58a63d12adaa7c27055c63afc51580bd1e2478d1da3dace8");
  assert.equal(review.currentSourceCutDeltaReview.supplementalPdp1DefinitionDelta.currentSourceSha256, sha256);
  assert.equal(reinspection.previousSourceBytesAvailableInGit, false);
  assert.equal(reinspection.immediatePredecessorSourceSha256,
    "317878be9ebe9c978f356a4e81060620fcb69af02ea25c2ff1d47bd20180c069");
  assert.equal(reinspection.immediatePredecessorSourceBytesAvailableInGit, true);
  assert.match(reinspection.method, /complete final operations source tree/u);
  assert.match(reinspection.sourceChangeGroupsInterpretation,
    /eight retained normative meaning records are a separate/u);
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
  assert.deepEqual(reinspection.currentInventoryReconciliation.typedObservationInventory.unresolvedOperationRefs, []);
  assert.equal(reinspection.currentInventoryReconciliation.actionOperationDispositionInventory.unmatchedActionIds.length, 0);
  assert.equal(reinspection.focusedVerification.status, "HISTORICAL_PASS_NOT_CURRENT_FOR_PXD164");
  assert.equal(reinspection.focusedVerification.currentSourceSha256,
    "62d0a4050a43da1c58a63d12adaa7c27055c63afc51580bd1e2478d1da3dace8");
  assert.equal(reinspection.focusedVerification.passed, 67);
  assert.equal(reinspection.focusedVerification.total, 67);
  assert.equal(reinspection.focusedVerification.sourcePins.operationsSha256,
    "62d0a4050a43da1c58a63d12adaa7c27055c63afc51580bd1e2478d1da3dace8");
  assert.equal(reinspection.focusedVerification.sourcePins.ownerActionWireContractsSha256,
    "19605e76b089ffc91cc7a08ce09bed375c638c29edf7b623df61ca2e89cfcf0b");
  const pxd164 = reinspection.pxd164SemanticReconciliation;
  assert.equal(pxd164.decisionRef, ".product-experience/decision-log.md#PXD-164");
  assert.equal(pxd164.operationId, "media.operation.action.request-admitted-speech-operation");
  assert.equal(pxd164.operationSourceSha256, sha256);
  assert.equal(pxd164.wireSourceSha256, wireSha256);
  assert.equal(pxd164.status, "INTERNAL_SOURCE_REVIEW_COMPLETE; PHASE_ACCEPTANCE_NOT_CLAIMED");
  assert.equal(pxd164.focusedVerification.status, "PASS");
  assert.equal(pxd164.focusedVerification.passed, 68);
  assert.equal(pxd164.focusedVerification.total, 68);
  assert.equal(pxd164.focusedVerification.sourcePins.operationsSha256, sha256);
  assert.equal(pxd164.focusedVerification.sourcePins.ownerActionWireContractsSha256, wireSha256);
  assert.equal(pxd164.ownerAcceptance, "NOT_CLAIMED");
  assert.equal(pxd164.independentSpecialistAcceptance, "NOT_CLAIMED");
  assert.equal(pxd164.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(pxd164.transportAdmission, "NOT_ADMITTED");
  assert.match(pxd164.requiredBoundary, /wrapper result is a request receipt only/u);
  assert.match(pxd164.requiredBoundary, /not the target operation result/u);
  assert.match(pxd164.requiredBoundary, /selected target request is validated/u);
  assert.deepEqual(review.historicalCuts.map(({ decisionRef, sourceSha256 }) => [decisionRef, sourceSha256]), [
    [".product-experience/decision-log.md#PXD-094", "16cb028dcb28ec7d91b8698412a2f1a41c05f5779d7164f42cd13facd7389e54"],
    [".product-experience/decision-log.md#PXD-046", "f279538b72a1bdd73a6cf88556eebdaf91c9799a033f460233b796bf8df8f89d"],
  ]);
  assert.match(review.historicalCuts[0].meaning, /Immutable historical/u);
  assert.match(review.historicalCuts[1].meaning, /retained as history/u);
});

test("P1 current reinspection reconciles the 147-action and typed-observation inventories", () => {
  const reinspection = review.currentSourceReinspection;
  const actionInventory = source.actionOperationDispositionInventory;
  const actionRegistry = readSourceYaml(".product-experience/pdp-3-product-experience/action-registry.yaml");
  const dispositionIds = actionInventory.records.map(({ actionId }) => actionId).sort();
  const actionIds = actionRegistry.actions.map(({ id }) => id).sort();

  assert.equal(actionInventory.exactSourceActionCount, 147);
  assert.equal(actionInventory.records.length, 147);
  assert.deepEqual(dispositionIds, actionIds);
  const fallback = actionInventory.records.find(({ actionId }) => actionId === "media.action.confirm-selected-fallback");
  assert.ok(fallback);
  assert.equal(fallback.domainOperationDisposition, "OWNER_DEFINED_EXACT_OPERATION_REFERENCE");
  assert.deepEqual(fallback.exactOperationRefs, ["media.operation.fallback-selection.confirm.v1"]);
  assert.match(fallback.sourceEvidence.effect, /do not dispatch or retry processing/u);
  assert.match(fallback.sourceEvidence.finality, /no execution, completion, approval, or delivery/u);
  assert.match(fallback.ownerDefinitionStatus, /runtime-not-admitted/u);
  const inventoryReview = reinspection.currentInventoryReconciliation.actionOperationDispositionInventory;
  const actionHash = createHash("sha256").update(readFileSync(resolve(root, ".product-experience/pdp-3-product-experience/action-registry.yaml"))).digest("hex");
  assert.equal(inventoryReview.actionRegistrySha256, actionHash);
  assert.equal(inventoryReview.declaredActionCount, 147);
  assert.equal(inventoryReview.dispositionRecordCount, 147);
  assert.equal(inventoryReview.registryRecordCount, 147);

  const semanticReview = reinspection.pxd163SemanticReconciliation;
  assert.equal(semanticReview.decisionRef, ".product-experience/decision-log.md#PXD-163");
  assert.equal(semanticReview.groupCount, 6);
  assert.equal(semanticReview.status, "INTERNAL_SOURCE_REVIEW_COMPLETE; PHASE_ACCEPTANCE_NOT_CLAIMED");
  assert.equal(semanticReview.reconciledGroupCount, 6);
  assert.equal(semanticReview.blockedGroupCount, 0);
  assert.deepEqual(semanticReview.groups.map(({ taskId }) => taskId), [
    "MDC30-C-03", "MDC30-C-04", "MDC30-C-16", "MDC30-C-22", "MDC30-C-25", "MDC30-C-27",
  ]);
  for (const group of semanticReview.groups) {
    assert.ok(group.sourceSelectors.length > 0, `${group.taskId} has exact source selectors`);
    assert.equal(group.ownerAcceptance, "NOT_CLAIMED");
    assert.equal(group.independentSpecialistAcceptance, "NOT_CLAIMED");
    assert.equal(group.runtimeAdmission, "NOT_ADMITTED");
    assert.equal(group.transportAdmission, "NOT_ADMITTED");
  }
  for (const taskId of ["MDC30-C-03", "MDC30-C-04", "MDC30-C-16", "MDC30-C-27"]) {
    assert.equal(semanticReview.groups.find(({ taskId: id }) => id === taskId).reviewDisposition,
      "INTERNAL_DELEGATED_PDP1_SOURCE_DEFINITION_REVIEW");
  }
  for (const taskId of ["MDC30-C-03", "MDC30-C-04", "MDC30-C-27"]) {
    assert.equal(semanticReview.groups.find(({ taskId: id }) => id === taskId).focusedVerification.status, "PASS");
  }
  const deliveryGroup = semanticReview.groups.find(({ taskId }) => taskId === "MDC30-C-22");
  assert.equal(deliveryGroup.reviewDisposition, "INTERNAL_DELEGATED_PDP1_SOURCE_DEFINITION_REVIEW");
  assert.equal(deliveryGroup.resolvedSourceDefects[0].id, "P1-163-C22-DELIVERY-RESULT-SHAPE");
  const wireSha = createHash("sha256")
    .update(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/owner-action-wire-contracts.yaml")))
    .digest("hex");
  assert.equal(deliveryGroup.resolvedSourceDefects[0].sourceSha256,
    "19605e76b089ffc91cc7a08ce09bed375c638c29edf7b623df61ca2e89cfcf0b",
    "PXD-163 delivery evidence remains tied to its historical reviewed wire cut");
  assert.equal(deliveryGroup.resolvedSourceDefects[0].focusedVerification.status, "PASS");
  const deliveryWire = wire.records.find(({ id }) => id === "media.owner-action-wire.deliver-exact-version.v1");
  const deliveryOperation = ownerOperations.get("media.operation.action.deliver-exact-version");
  assert.equal(deliveryGroup.wireResultProjectionFieldCount, 9);
  assert.deepEqual(deliveryGroup.wireResultProjectionFields, deliveryOperation.resultSchema.fields);
  assert.deepEqual(deliveryGroup.wireResultProjectionFields, deliveryWire.semantics.sourceDeclaredResultFields);
  assert.equal(deliveryGroup.resolvedSourceDefects[0].focusedVerification.command,
    "node --test tests/pdp1-owner-action-wire-contracts.test.mjs");
  assert.equal(deliveryGroup.resolvedSourceDefects[0].focusedVerification.passed, 13);
  assert.equal(deliveryGroup.resolvedSourceDefects[0].focusedVerification.total, 13);
  assert.equal(review.relatedOwnerSourceReconciliation.currentC22Review.wireResultProjectionFieldCount, 9);
  assert.deepEqual(review.relatedOwnerSourceReconciliation.currentC22Review.wireResultProjectionFields,
    deliveryGroup.wireResultProjectionFields);
  assert.equal(review.relatedOwnerSourceReconciliation.currentC22Review.focusedVerification.passed, 13);
  assert.equal(review.relatedOwnerSourceReconciliation.currentC22Review.focusedVerification.total, 13);
  assert.deepEqual(deliveryGroup.operationKinds, {
    "media.operation.action.deliver-exact-version": "COMMAND",
    "media.operation.action.reconcile-delivery-acknowledgment": "QUERY",
  });
  const contextGroup = semanticReview.groups.find(({ taskId }) => taskId === "MDC30-C-25");
  assert.equal(contextGroup.reviewDisposition, "INTERNAL_DELEGATED_PDP1_SOURCE_DEFINITION_REVIEW");
  assert.equal(contextGroup.resolvedSourceDefects[0].id, "P1-163-C25-JOB-STATUS-IDENTITY-JOIN");
  assert.equal(contextGroup.resolvedSourceDefects[0].sourceSha256,
    "62d0a4050a43da1c58a63d12adaa7c27055c63afc51580bd1e2478d1da3dace8",
    "PXD-163 context evidence remains pinned to its reviewed operation cut");
  assert.equal(contextGroup.resolvedSourceDefects[0].focusedVerification.status, "PASS");
  assert.equal(contextGroup.resolvedSourceDefects[0].focusedVerification.passed, 3);
  assert.equal(contextGroup.resolvedSourceDefects[0].focusedVerification.total, 3);
  assert.match(semanticReview.groups.find(({ taskId }) => taskId === "MDC30-C-16").noEqualityFinding,
    /No source declares equality/u);
  const fallbackGroup = semanticReview.groups.find(({ taskId }) => taskId === "MDC30-C-27");
  assert.deepEqual(fallbackGroup.bindingMappingCounts, {
    bindingRules: 35, evidenceJoinRules: 7, resultBindings: 19,
  });

  const populations = reinspection.currentPopulations;
  assert.equal(populations.canonicalOperations, 448);
  assert.equal(populations.capabilityBindingRecords, 14);
  assert.equal(populations.capabilityOperationRecords, 462);
  assert.equal(populations.inputPayloadSchemas, source.capabilityOperationContracts.inputPayloadSchemas.length);
  assert.equal(populations.outputPayloadSchemas, source.capabilityOperationContracts.outputPayloadSchemas.length);
  assert.equal(populations.ownerTypedObservationContracts, 15);
  assert.equal(populations.ownerTypedObservationValidationRules, 15);
  assert.equal(reinspection.currentInventoryReconciliation.capabilityOperationSchemasAndMappings.capabilityOperationMappingRecordCount,
    source.capabilityOperationContracts.records.length);

  const observations = source.ownerTypedObservationContracts.records;
  const validations = source.ownerTypedObservationValidationRules.records;
  assert.equal(observations.length, 15);
  assert.equal(validations.length, 15);
  assert.deepEqual(new Set(validations.map(({ id }) => id)),
    new Set(observations.map(({ id }) => id.replace("media.observation-contract.", "media.observation-validation."))));
  const operationIds = new Set([
    ...source.operations.map(({ id }) => id),
    ...source.individualOperationContracts.records.map(({ id }) => id),
    ...source.ownerDefinedOperationContracts.records.map(({ id }) => id),
    ...source.capabilityOperationContracts.records.map(({ id }) => id),
  ]);
  for (const observation of observations) {
    for (const operationRef of observation.operationRefs ?? []) {
      assert.ok(operationIds.has(operationRef), `${observation.id} operation ref ${operationRef} resolves`);
    }
  }

  const meaningReview = review.currentSourceCutDeltaReview.supplementalPdp1DefinitionDelta;
  assert.equal(meaningReview.reviewedOwnerTypedObservationCount, 8);
  assert.equal(meaningReview.reviewedOwnerTypedObservationValidationRuleCount, 8);
  assert.equal(meaningReview.reviewedRecords.length, 8);
  assert.deepEqual(meaningReview.reviewedRecords.map(({ id }) => id).sort(), [
    "media.observation-contract.delegated-integration-result-context.v1",
    "media.observation-contract.destination-delivery-acknowledgment.v1",
    "media.observation-contract.effective-processing-constraints.v1",
    "media.observation-contract.job-status-seven-dimension.v1",
    "media.observation-contract.output-preview-version-lineage.v1",
    "media.observation-contract.processing-parameter-read.v1",
    "media.observation-contract.rights-decision.v1",
    "media.observation-contract.transcript-submission-lineage.v1",
  ]);
  assert.equal(meaningReview.preservedBoundaries.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(meaningReview.preservedBoundaries.transportAdmission, "NOT_ADMITTED");
  assert.deepEqual(reinspection.currentInventoryReconciliation.separatelyRetainedMeaningReview.reviewedRecordIds,
    meaningReview.reviewedRecords.map(({ id }) => id));
  assert.match(reinspection.currentInventoryReconciliation.separatelyRetainedMeaningReview.relationToCensus,
    /NOT_ADDED_TO_OR_COUNTED_AS_THE_CURRENT_TYPED_OBSERVATION_CENSUS/u);
});

test("P1 source review pins the current 79-record wire cut and changed owner-wire records", () => {
  const wireReview = review.relatedOwnerSourceReconciliation;
  assert.equal(wireReview.sourcePath, wirePath);
  assert.equal(wireReview.currentSourceSha256, wireSha256);
  assert.equal(wireReview.recordCount, 79);
  assert.equal(wire.records.length, wireReview.recordCount);
  assert.equal(review.currentSourceReinspection.currentInventoryReconciliation.ownerActionWireSourceSha256, wireSha256);
  assert.equal(review.currentSourceReinspection.pxd163SemanticReconciliation.groups
    .find(({ taskId }) => taskId === "MDC30-C-22").resolvedSourceDefects[0].sourceSha256,
  "19605e76b089ffc91cc7a08ce09bed375c638c29edf7b623df61ca2e89cfcf0b",
  "PXD-163 evidence remains pinned to its reviewed wire cut; the PXD-164 review pins the successor");
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

test("PXD-163 C16 review pins the dedicated dub input, P0 locale mapping, parameters, and result echoes", () => {
  const item = review.currentSourceCutDeltaReview.supplementalPdp1DefinitionDelta.reviewedOperationRecords
    .find(({ id }) => id === "media.operation.capability.media-speech-synthesis-dub");
  assert.ok(item);
  const dub = source.capabilityOperationContracts.records.find(({ id }) => id === item.id);
  const p0Dub = p0Capabilities.capabilities.find(({ id }) => id === "media.speech.synthesis.dub");
  assert.equal(item.decisionRef, ".product-experience/decision-log.md#PXD-163");
  assert.equal(item.inputSchemaSelector,
    `${item.selector}/requestSchema/input2`);
  assert.equal(item.parameterSchemaSelector, `${item.selector}/parameterSchema`);
  assert.equal(item.resultBindingSelector, `${item.selector}/resultSchema/bindingRules[]`);
  assert.equal(item.inputSchemaId, "media.typed-input.source-media-with-speech-dub");
  assert.equal(item.inputCardinality, "EXACTLY_ONE");
  assert.equal(item.inputRequired, true);
  const sourceInput = source.capabilityOperationContracts.inputPayloadSchemas
    .find(({ id }) => id === item.inputSchemaId).schema;
  assert.equal(dub.requestSchema.required.includes("input2"), true);
  assert.deepEqual(dub.requestSchema.properties.input2, sourceInput);
  assert.equal(sourceInput.additionalProperties, false);
  assert.equal(sourceInput.properties.payload.additionalProperties, false);
  assert.deepEqual(sourceInput.properties.payload.required, item.requiredInputPayloadFields);
  assert.deepEqual(dub.inputSlots.find(({ slotId }) => slotId === "input2"), {
    slotId: "input2", sourceType: "source-media-with-speech-artifact",
    payloadSchemaRef: item.inputSchemaId, cardinality: "EXACTLY_ONE", required: true,
  });

  const expectedParameters = ["outputProfileRef", "sourceLocale", "targetLocale", "translatedSegmentVersionRef", "voiceProfileVersionRef"];
  assert.deepEqual([...dub.parameterSchema.required].sort(), [...expectedParameters].sort());
  assert.deepEqual(Object.keys(dub.parameterSchema.properties).sort(), [...expectedParameters].sort());
  assert.deepEqual(item.requiredParameters, expectedParameters);
  const p0OutputLanguage = p0Dub.ownerDefinition.parameterSchema.properties.outputLanguage;
  const scalar = source.capabilityOperationContracts.scalarTypes[p0OutputLanguage.type];
  assert.deepEqual(dub.parameterSchema.properties.targetLocale, scalar.validator);
  assert.deepEqual(item.p0OutputLanguageMapping, {
    p0Selector: ".product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.speech.synthesis.dub/ownerDefinition/parameterSchema/properties/outputLanguage",
    p1Selector: `${item.selector}/parameterSchema/properties/targetLocale`,
    relationship: "P0 outputLanguage resolves through its declared scalar schema to the exact P1 targetLocale schema; P0 optionality is preserved in P0 and P1 requires explicit targetLocale for C16 dubbing",
  });

  const bindingIds = dub.resultSchema.bindingRules.map(({ id }) => id);
  assert.equal(bindingIds.length, 13);
  assert.deepEqual(item.bindingIds, bindingIds);
  assert.equal(dub.resultSchema.bindingRuleScope, "SUCCEEDED_ONLY");
  assert.equal(dub.resultSchema.additionalProperties, false);
  assert.match(dub.resultSchema.acceptedTupleRule,
    /requestId-and-requestFingerprint-identify-the-exact-accepted-request.*without-substitution/su);
  assert.equal(item.meaning.includes("Candidate identity is not an immutable artifact version"), true);
  assert.equal(review.currentSourceCutDeltaReview.supplementalPdp1DefinitionDelta.reviewAuthority
    .includes("not a human owner signature"), true);
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
