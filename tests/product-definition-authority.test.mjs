import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { validateScopeStatuses } from "../scripts/normalize-media-scope-status.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const requireTools = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse: parseYaml } = requireTools("yaml");
const sourceCache = new Map();
const readYaml = (path) => {
  const text = readFileSync(resolve(root, path), "utf8");
  const cached = sourceCache.get(path);
  if (!cached || cached.text !== text) sourceCache.set(path, { text, value: parseYaml(text) });
  return structuredClone(sourceCache.get(path).value);
};

function validateBoundedJ01ProjectDefinitions(journey) {
  assert.equal(journey.journeyId, "J-01");
  assert.equal(journey.steps.length, 4);
  assert.deepEqual(journey.steps.map(({ stepId }) => stepId), ["J01-1", "J01-2", "J01-3", "J01-4"]);
  const operations = readYaml(".product-experience/pdp-1-domain-data/operations.yaml").individualOperationContracts.records;
  const operationById = new Map(operations.map((record) => [record.id, record]));
  const objectIds = new Set(readYaml(".product-experience/pdp-1-domain-data/domain-objects.yaml").objects.map(({ id }) => id));
  const stateIds = new Set(readYaml(".product-experience/pdp-1-domain-data/states.yaml").stateMachines
    .flatMap(({ machineId, stateIds: states }) => states.map((state) => `${machineId}/${state}`)));
  const actions = readYaml(".product-experience/pdp-3-product-experience/action-registry.yaml").actions;
  const actionById = new Map(actions.map((action) => [action.id, action]));

  for (const step of journey.steps) {
    assert.equal(step.decisionRef, ".product-experience/decision-log.md#PXD-055", `${step.stepId} decision must be exact`);
    assert.equal(step.definitionVerification?.runtimeAdmission, "NOT_ADMITTED", `${step.stepId} cannot claim execution admission`);
    assert.equal(step.transitionDisposition?.status, "NOT_APPLICABLE_WITH_REASON", `${step.stepId} has no invented project-state edge`);
    assert.equal(step.transitionDisposition?.decisionRef, ".product-experience/decision-log.md#PXD-055");
    assert.ok(step.transitionDisposition?.reason, `${step.stepId} must explain why no transition applies`);
    for (const objectId of step.objectRefs ?? []) assert.ok(objectIds.has(objectId), `${step.stepId} has stale domain object ${objectId}`);
    for (const stateRef of step.stateRefs ?? []) assert.ok(stateIds.has(stateRef), `${step.stepId} has stale state ${stateRef}`);
    const operationRefs = new Set([...(step.requiredOperationRefs ?? []), ...(step.canonicalOperationRef ? [step.canonicalOperationRef] : [])]);
    for (const operationRef of operationRefs) {
      const operation = operationById.get(operationRef);
      assert.ok(operation, `${step.stepId} operation ${operationRef} must resolve to PDP-1`);
      assert.match(operation.status, /bounded-J01-owner-definition-under-PXD-054/u);
      assert.equal(operation.executionAdmission, "NOT_ADMITTED");
      assert.equal(operation.sourceRef, ".product-experience/pdp-0-product-truth/journey-catalog.yaml#J-01");
      assert.ok(operation.sourceBounds, `${operationRef} must retain explicit source bounds`);
    }
    for (const actionRef of [step.action, ...(step.actionRefs ?? [])].filter(Boolean)) {
      const action = actionById.get(actionRef);
      assert.ok(action, `${step.stepId} action ${actionRef} must resolve to the action registry`);
      assert.equal(action.actionDefinitionSemantics?.sourceDecisionRef, ".product-experience/decision-log.md#PXD-054");
      assert.equal(action.actionDefinitionSemantics?.reviewDecisionRef, ".product-experience/decision-log.md#PXD-055");
      assert.equal(action.actionDefinitionSemantics?.runtimeAdmission, "NOT_ADMITTED");
      if (action.actionDefinitionSemantics.operationRef) {
        assert.ok(operationRefs.has(action.actionDefinitionSemantics.operationRef), `${actionRef} operation is not the exact operation on ${step.stepId}`);
      }
    }
  }
  assert.equal(journey.steps[0].handoffRef, "media.handoff.identity", "the first step remains an external Shared handoff");
  assert.deepEqual(journey.steps[0].requiredOperationRefs, [], "Media does not invent an identity operation");
  assert.equal(journey.steps[1].canonicalOperationRef, "media.operation-slice.list-projects");
  assert.equal(journey.steps[2].canonicalOperationRef, "media.operation-slice.create-project");
  assert.equal(journey.steps[3].canonicalOperationRef, "media.operation-slice.inspect-project");
}

function validateBoundedJ03CaptionDraftDefinitions(journey, { operationDoc = readYaml(".product-experience/pdp-1-domain-data/operations.yaml") } = {}) {
  const sourceDecision = ".product-experience/decision-log.md#PXD-066";
  const grammarDecision = ".product-experience/decision-log.md#PXD-067";
  const decision = ".product-experience/decision-log.md#PXD-068";
  assert.equal(journey.journeyId, "J-03");
  assert.equal(journey.steps.length, 8);
  const operation = operationDoc.operations.find(({ id }) => id === "media.operation.caption-draft-write");
  assert.ok(operation);
  assert.equal(operation.ownerDefinitionRef, sourceDecision);
  assert.match(operation.scopeStatus, /runtime-NOT_ADMITTED/u);
  assert.deepEqual(operation.inputSemantics.requiredFields, [
    "draftId", "expectedDraftRevision", "sourceArtifactId", "sourceArtifactVersionId", "parentVersionKind", "parentVersionId", "editKind", "segmentId", "edit",
  ]);
  assert.deepEqual(operation.inputSemantics.editBranches.TEXT_CORRECTION.allowedFields, ["text"]);
  assert.deepEqual(operation.inputSemantics.editBranches.TIMING_ALIGNMENT.allowedFields, ["startTick", "endTick"]);
  assert.match(operation.sourceClockRequirement, /authoritative-sourceClockId-positive-safe-integer-ticksPerSecond.*sourceDurationTicks/u);
  assert.match(operation.sourceClockRequirement, /0-<=-startTick-<-endTick-<=-sourceDurationTicks/u);
  assert.match(operation.draftSnapshotDefinition.undo, /same-trusted-tenant-principal-activeSessionId-draftId-and-source-parent-lineage/u);
  assert.match(operation.draftSnapshotDefinition.undo, /restore-prior-content-as-a-new-current-revision-increment/u);
  assert.match(operation.draftSnapshotDefinition.rebase, /distinct-new-draftId-at-revision-zero/u);

  const actions = readYaml(".product-experience/pdp-3-product-experience/action-registry.yaml").actions;
  const bindings = readYaml(".product-experience/pdp-3-product-experience/experience-source-bindings.yaml").j03CaptionDraftBindings;
  assert.equal(bindings.reviewDecisionRef, decision);
  assert.equal(bindings.sourceDecisionRef, sourceDecision);
  assert.equal(bindings.grammarDecisionRef, grammarDecision);
  assert.equal(bindings.runtimeAdmission, "NOT_ADMITTED");
  assert.deepEqual(bindings.steps.map(({ stepId }) => stepId), ["J03-5", "J03-6"]);
  const checks = [
    { stepId: "J03-5", actionId: "media.action.correct-caption", kind: "TEXT_CORRECTION", fields: ["text"] },
    { stepId: "J03-6", actionId: "media.action.align-caption-timing", kind: "TIMING_ALIGNMENT", fields: ["startTick", "endTick"] },
  ];
  for (const { stepId, actionId, kind, fields } of checks) {
    const step = journey.steps.find((entry) => entry.stepId === stepId);
    assert.ok(step, `${stepId} exists`);
    assert.equal(step.action, actionId);
    assert.equal(step.canonicalOperationRef, operation.id);
    assert.deepEqual(step.requiredOperationRefs, [operation.id]);
    assert.equal(step.sourceDecisionRef, sourceDecision);
    assert.equal(step.grammarDecisionRef, grammarDecision);
    assert.equal(step.decisionRef, decision);
    assert.equal(step.authorityRef, "current-trusted-tenant-principal-and-source-read-plus-derived-content-edit-policy");
    assert.deepEqual(step.stateRefs, []);
    assert.deepEqual(step.objectRefs, ["media.domain.artifact-version", "media.domain.transcript-version", "media.domain.caption-version"]);
    assert.deepEqual(step.actorRefs, ["media.creator", "media.editor"]);
    assert.equal(step.transitionDisposition.status, "NOT_APPLICABLE_WITH_REASON");
    assert.equal(step.transitionDisposition.transitionRef, null);
    assert.equal(step.definitionVerification.runtimeAdmission, "NOT_ADMITTED");
    assert.equal(step.definitionVerification.runtimeVerification, "not-run");
    assert.equal(step.verification.status, "not-run");
    assert.deepEqual(step.verification.actualEvidence, []);
    assert.equal(step.draftEditSemantics.editKind, kind);
    assert.deepEqual(step.draftEditSemantics.allowedEditFields, fields);
    assert.deepEqual(step.draftEditSemantics.trustedHostFields, ["tenantId", "principalId"]);
    if (kind === "TIMING_ALIGNMENT") {
      assert.match(step.draftEditSemantics.sourceClockRequirement, /authoritative sourceClockId/u);
      assert.match(step.draftEditSemantics.sourceClockRequirement, /0 <= startTick < endTick <= sourceDurationTicks/u);
      assert.match(step.draftEditSemantics.provenance, /not forced alignment/u);
    }
    const action = actions.find(({ id }) => id === actionId);
    assert.ok(action);
    assert.deepEqual(action.capabilityRefs, ["media.artifact.derive"]);
    assert.equal(action.actionDefinitionSemantics.actionRef, actionId);
    assert.equal(action.actionDefinitionSemantics.sourceDecisionRef, sourceDecision);
    assert.equal(action.actionDefinitionSemantics.grammarDecisionRef, grammarDecision);
    assert.equal(action.actionDefinitionSemantics.reviewDecisionRef, decision);
    assert.equal(action.actionDefinitionSemantics.operationRef, operation.id);
    assert.equal(action.actionDefinitionSemantics.effectKind, "LOCAL_DRAFT_UPDATE");
    assert.equal(action.actionDefinitionSemantics.reversibility.kind, "CONDITIONAL");
    assert.equal(action.actionDefinitionSemantics.runtimeAdmission, "NOT_ADMITTED");
    assert.equal(action.actionDefinitionSemantics.publicBooleanDisposition, "PUBLIC_BOOLEAN_NOT_REPRESENTABLE");
    assert.equal(action.actionDefinitionSemantics.publicEffect, undefined);
    assert.equal(action.actionDefinitionSemantics.publicFinality, undefined);
    const screen = readYaml(".product-experience/pdp-3-product-experience/screen-contracts/correct-captions.yaml");
    const consequence = screen.actionConsequences.find(({ actionId: id }) => id === actionId);
    assert.equal(consequence.operationRef, operation.id);
    assert.deepEqual(consequence.capabilityRefs, ["media.artifact.derive"]);
    assert.deepEqual(consequence.requirementRefs, ["MEDIA-REQ-CAP-ARTIFACT"]);
    assert.equal(consequence.bindingStatus, "source-definition-exact; screen-admission-pending; runtime-NOT_ADMITTED");
  }
  assert.equal(journey.steps.find(({ stepId }) => stepId === "J03-5").draftEditSemantics.timingUnavailableAllowed, true);
  assert.equal(journey.steps.find(({ stepId }) => stepId === "J03-6").draftEditSemantics.timingUnavailableAllowed, false);
  assert.match(journey.steps.find(({ stepId }) => stepId === "J03-6").draftEditSemantics.provenance, /not forced alignment/u);
}

function validateBoundedJ03CaptionVersionDefinitions(journey) {
  const decision = ".product-experience/decision-log.md#PXD-060";
  const sourceDecision = ".product-experience/decision-log.md#PXD-058";
  const grammarDecision = ".product-experience/decision-log.md#PXD-059";
  assert.equal(journey.journeyId, "J-03");
  assert.equal(journey.steps.length, 8, "only the original eight J-03 steps are in scope");
  assert.deepEqual(journey.definitionReview, {
    status: "SOURCE_DEFINED_OWNER_ACCEPTED",
    sourceDecisionRef: sourceDecision,
    grammarDecisionRef: grammarDecision,
    decisionRef: decision,
    boundary: "PXD-060 covers immutable caption registration and exact-pair comparison; PXD-064 separately covers exact transcript inspection, and PXD-068 covers the two session-local draft edit branches. Independent review, runtime admission, and phase acceptance remain separate.",
    runtimeAdmission: "NOT_ADMITTED",
  });

  const operationDoc = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");
  const operationById = new Map([
    ...(operationDoc.operations ?? []),
    ...(operationDoc.individualOperationContracts?.records ?? []),
  ].map((record) => [record.id, record]));
  const objectIds = new Set(readYaml(".product-experience/pdp-1-domain-data/domain-objects.yaml").objects.map(({ id }) => id));
  const actions = readYaml(".product-experience/pdp-3-product-experience/action-registry.yaml").actions;
  const actionById = new Map(actions.map((action) => [action.id, action]));
  const write = journey.steps[6];
  const compare = journey.steps[7];

  const checkStep = (step, { stepId, operationRef, actionRef, objects, actors }) => {
    assert.equal(step.stepId, stepId);
    assert.equal(step.action, actionRef);
    assert.equal(step.canonicalOperationRef, operationRef);
    assert.deepEqual(step.requiredOperationRefs, [operationRef]);
    assert.deepEqual(step.objectRefs, objects);
    for (const objectId of step.objectRefs) assert.ok(objectIds.has(objectId), `${stepId} stale object ${objectId}`);
    assert.deepEqual(step.actorRefs, actors);
    assert.ok(step.authorityRef, `${stepId} must bind an authority source`);
    assert.equal(step.decisionRef, decision);
    assert.deepEqual(step.stateRefs, [], `${stepId} must not invent states`);
    assert.deepEqual(step.transitionDisposition, {
      status: "NOT_APPLICABLE_WITH_REASON",
      transitionRef: null,
      decisionRef: decision,
      reason: step.transitionDisposition.reason,
    });
    assert.equal(step.transitionRef, null);
    assert.equal(step.definitionVerification.runtimeAdmission, "NOT_ADMITTED");
    assert.equal(step.verification.status, "not-run");
    assert.deepEqual(step.verification.actualEvidence, []);
    assert.ok(step.definitionVerification.evidence.includes("tests/media-caption-version-experience-definitions.test.mjs"));
    const operation = operationById.get(operationRef);
    assert.ok(operation, `${stepId} exact operation resolves to PDP-1`);
    assert.equal(operation.ownerDefinitionRef, sourceDecision);
    assert.deepEqual(operation.transition?.transitionRefs ?? operation.transitionRefs ?? [], []);
    assert.equal(operation.executionAdmission ?? operation.runtimeAdmission ?? "NOT_ADMITTED", "NOT_ADMITTED");
    return operation;
  };

  const writeOperation = checkStep(write, {
    stepId: "J03-7",
    operationRef: "media.operation.caption-version-write",
    actionRef: "media.action.save-caption-version",
    objects: ["media.domain.caption-version", "media.domain.artifact-version", "media.domain.transcription"],
    actors: ["media.creator", "media.editor"],
  });
  const readOperation = checkStep(compare, {
    stepId: "J03-8",
    operationRef: "media.operation.caption-version-read",
    actionRef: "media.action.compare-caption-versions",
    objects: ["media.domain.caption-version", "media.domain.artifact-version"],
    actors: ["media.creator", "media.editor", "media.reviewer"],
  });
  assert.deepEqual(writeOperation.inputSemantics.requiredFields, [
    "sourceArtifactId", "sourceArtifactVersionId", "parentVersionKind", "parentVersionId", "sourceClockId",
    "ticksPerSecond", "sourceDurationTicks", "languageDisposition", "captionSegments", "requestId",
  ]);
  assert.match(writeOperation.idempotency, /same-key-same-fingerprint/u);
  assert.match(writeOperation.unknownOutcome, /same.*requestId.*requestFingerprint/u);
  assert.match(write.recovery.proposal, /never retry automatically or use a new key/u);
  assert.deepEqual(readOperation.inputSemantics.selectorKindValues, ["EXACT_PAIR", "REGISTRATION_REQUEST"]);
  assert.deepEqual(readOperation.inputSemantics.selectorBranches.EXACT_PAIR.requiredFields, ["leftCaptionVersionId", "rightCaptionVersionId"]);
  assert.deepEqual(readOperation.inputSemantics.selectorBranches.REGISTRATION_REQUEST.requiredFields, ["requestId", "requestFingerprint"]);
  assert.equal(write.recovery.sourceRef, "media.operation.caption-version-read");
  assert.equal(write.recovery.selector, "REGISTRATION_REQUEST with the same trusted tenantId, principalId, requestId, and full requestFingerprint");
  assert.match(compare.failure.proposal, /CAPTION_VERSIONS_NOT_COMPARABLE/u);

  for (const [actionId, operationRef, capability, reversibility] of [
    ["media.action.save-caption-version", "media.operation.caption-version-write", "media.artifact.output.register", "NOT_REVERSIBLE"],
    ["media.action.compare-caption-versions", "media.operation.caption-version-read", "media.artifact.inspect", "UNKNOWN"],
  ]) {
    const action = actionById.get(actionId);
    assert.ok(action, `${actionId} exists`);
    assert.deepEqual(action.capabilityRefs, [capability]);
    assert.equal(action.actionDefinitionSemantics.operationRef, operationRef);
    assert.equal(action.actionDefinitionSemantics.sourceDecisionRef, sourceDecision);
    assert.equal(action.actionDefinitionSemantics.grammarDecisionRef, grammarDecision);
    assert.equal(action.actionDefinitionSemantics.reviewDecisionRef, decision);
    assert.equal(action.actionDefinitionSemantics.runtimeAdmission, "NOT_ADMITTED");
    assert.equal(action.actionDefinitionSemantics.reversibility.kind, reversibility);
  }
  assert.ok(!actionById.get("media.action.save-caption-version").capabilityRefs.includes("media.artifact.provenance.export"));
  assert.equal(actionById.get("media.action.save-caption-version").actionDefinitionSemantics.publicEffect.reversible, false);
  assert.equal(actionById.get("media.action.save-caption-version").actionDefinitionSemantics.publicFinality.undoable, false);
  assert.equal(actionById.get("media.action.compare-caption-versions").actionDefinitionSemantics.publicEffect, undefined);
  assert.equal(actionById.get("media.action.compare-caption-versions").actionDefinitionSemantics.publicFinality, undefined);
}

function validateBoundedJ03TranscriptionSubmissionDefinition(journey) {
  const sourceDecision = ".product-experience/decision-log.md#PXD-070";
  const grammarDecision = ".product-experience/decision-log.md#PXD-071";
  const decision = ".product-experience/decision-log.md#PXD-159";
  const actionDecision = ".product-experience/decision-log.md#PXD-072";
  assert.equal(journey.journeyId, "J-03");
  assert.equal(journey.steps.length, 8, "transcription submission binds an existing step only");
  const step = journey.steps.find(({ stepId }) => stepId === "J03-2");
  assert.ok(step);
  assert.equal(step.view, "media.view.monitor-transcription");
  assert.equal(step.action, "media.action.request-transcription");
  assert.equal(step.canonicalOperationRef, "media.operation.transcription-submission");
  assert.deepEqual(step.requiredOperationRefs, ["media.operation.transcription-submission"]);
  assert.deepEqual(step.objectRefs, ["media.domain.artifact-version", "media.domain.processing-job"]);
  assert.deepEqual(step.stateRefs, []);
  assert.equal(step.sourceDecisionRef, sourceDecision);
  assert.equal(step.grammarDecisionRef, grammarDecision);
  assert.equal(step.decisionRef, decision);
  assert.equal(step.transitionDisposition.status, "NOT_APPLICABLE_WITH_REASON");
  assert.equal(step.transitionDisposition.transitionRef, null);
  assert.equal(step.transitionDisposition.decisionRef, decision);
  assert.match(step.transitionDisposition.reason, /no job-state or attempt transition/u);
  assert.equal(step.definitionVerification.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.definitionVerification.runtimeVerification, "not-run");
  assert.equal(step.verification.status, "not-run");
  assert.deepEqual(step.verification.actualEvidence, []);
  assert.deepEqual(step.submissionSemantics.reconcileRequiredFields, ["requestId", "requestFingerprint"]);
  assert.match(step.submissionSemantics.requestFingerprint.replay, /retain the complete validated canonical submit snapshot.*before first dispatch/u);
  assert.match(step.submissionSemantics.reconciliation, /separately rechecked current scoped receipt-read authority/u);
  assert.match(step.submissionSemantics.reconciliation, /does not authorize processing\/replay/u);
  assert.match(step.submissionSemantics.asynchronousBoundary, /acceptedAt proves no job state or worker dispatch/u);
  assert.match(step.submissionSemantics.retries, /no blind replay, no new key/u);
  const operation = readYaml(".product-experience/pdp-1-domain-data/operations.yaml").operations
    .find(({ id }) => id === "media.operation.transcription-submission");
  assert.ok(operation);
  const p2Slice = readYaml(".product-experience/pdp-2-design-interface-system/action-finality-grammar.yaml")
    .boundedTranscriptionSubmissionSlice.operation;
  assert.equal(operation.ownerDefinitionRef, sourceDecision);
  assert.equal(p2Slice.operationRef, operation.id);
  assert.deepEqual(p2Slice.requestModes, operation.inputSemantics.selectorValues);
  assert.deepEqual(p2Slice.commonRequiredFields, operation.inputSemantics.commonRequiredFields);
  assert.deepEqual(p2Slice.commonAllowedFields, operation.inputSemantics.commonAllowedFields);
  assert.deepEqual(p2Slice.submitFields, operation.inputSemantics.submitRequiredFields);
  assert.deepEqual(p2Slice.submitAllowedFields, operation.inputSemantics.submitAllowedFields);
  assert.deepEqual(p2Slice.reconcileFields, operation.inputSemantics.reconcileRequiredFields);
  assert.deepEqual(p2Slice.reconcileAllowedFields, operation.inputSemantics.reconcileAllowedFields);
  assert.equal(p2Slice.branchFieldRule, operation.inputSemantics.branchFieldRule);
  assert.deepEqual(p2Slice.scalarNullability, operation.inputSemantics.scalarNullability);
  assert.deepEqual(p2Slice.requestResolution.optionalAuthorityReferences,
    ["consentRef", "retentionPolicyRef", "policyDecisionRef"]);
  assert.equal(p2Slice.requestResolution.absentReferenceDisposition,
    "resolve-from-current-authoritative-owner-context-or-canonical-null-only-when-policy-says-not-applicable");
  assert.equal(p2Slice.requestResolution.processingLocationDisposition,
    "resolve-from-current-trusted-policy-and-qualified-profile-context; never-accept-a-caller-asserted-location");
  assert.match(operation.inputSemantics.purposeAndLocation,
    /purposeRef-is-an-exact-typed-purpose-reference; processingLocation-is-resolved-only-from-current-trusted-policy-and-qualified-profile-context/u);
  assert.match(operation.inputSemantics.reconciliation,
    /retained-original-submit-snapshot/u);
  assert.deepEqual(p2Slice.requestFingerprint.fields, operation.inputSemantics.requestFingerprint.fields);
  assert.equal(p2Slice.requestFingerprint.version, operation.inputSemantics.requestFingerprint.version);
  assert.equal(p2Slice.profilePreconstructionBoundary,
    step.submissionSemantics.profilePreconstructionBoundary);
  assert.deepEqual(step.submissionSemantics.submitRequiredFields, operation.inputSemantics.submitRequiredFields);
  assert.deepEqual(step.submissionSemantics.submitAllowedFields, operation.inputSemantics.submitAllowedFields);
  assert.deepEqual(step.submissionSemantics.reconcileAllowedFields, operation.inputSemantics.reconcileAllowedFields);
  assert.equal(step.submissionSemantics.branchFieldRule, operation.inputSemantics.branchFieldRule);
  assert.deepEqual(step.submissionSemantics.requestFingerprint.binds, operation.inputSemantics.requestFingerprint.fields);
  assert.equal(step.submissionSemantics.requestFingerprint.version, operation.inputSemantics.requestFingerprint.version);
  assert.deepEqual(step.submissionSemantics.scalarNullability, operation.inputSemantics.scalarNullability);
  assert.deepEqual(step.submissionSemantics.requestResolution, p2Slice.requestResolution);
  assert.deepEqual(step.submissionSemantics.requestFingerprint.binds, p2Slice.requestFingerprint.fields);
  assert.equal(step.submissionSemantics.requestFingerprint.version, p2Slice.requestFingerprint.version);
  assert.deepEqual(step.submissionSemantics.acknowledgedFields, operation.outputSemantics.acknowledgedFields);
  assert.match(operation.outputSemantics.receiptMeaning, /it-does-not-assert-a-job-state-at-acceptedAt/u);
  assert.equal(operation.outputSemantics.completedRecognitionIsNotImplied, true);
  const action = readYaml(".product-experience/pdp-3-product-experience/action-registry.yaml").actions
    .find(({ id }) => id === "media.action.request-transcription");
  assert.equal(action.actionDefinitionSemantics.operationRef, operation.id);
  assert.equal(action.actionDefinitionSemantics.sourceDecisionRef, sourceDecision);
  assert.equal(action.actionDefinitionSemantics.grammarDecisionRef, grammarDecision);
  assert.equal(action.actionDefinitionSemantics.reviewDecisionRef, actionDecision);
  assert.equal(action.actionDefinitionSemantics.effectKind, "REQUEST_ACCEPTANCE");
  assert.equal(action.actionDefinitionSemantics.reversibility.kind, "UNKNOWN");
  assert.equal(action.actionDefinitionSemantics.publicBooleanDisposition, "PUBLIC_BOOLEAN_NOT_REPRESENTABLE");
  assert.equal(action.actionDefinitionSemantics.publicEffect, undefined);
  assert.equal(action.actionDefinitionSemantics.publicFinality, undefined);
  const binding = readYaml(".product-experience/pdp-3-product-experience/experience-source-bindings.yaml").j03TranscriptionSubmissionBindings;
  assert.equal(binding.reviewDecisionRef, decision);
  assert.equal(binding.runtimeAdmission, "NOT_ADMITTED");
  assert.deepEqual(binding.steps.map(({ stepId }) => stepId), ["J03-2"]);
  assert.equal(binding.steps[0].operationRef, p2Slice.operationRef);
  assert.deepEqual(binding.steps[0].requestModes, p2Slice.requestModes);
  assert.deepEqual(binding.steps[0].commonRequiredFields, p2Slice.commonRequiredFields);
  assert.deepEqual(binding.steps[0].commonAllowedFields, p2Slice.commonAllowedFields);
  assert.deepEqual(binding.steps[0].submitRequiredFields, p2Slice.submitFields);
  assert.deepEqual(binding.steps[0].submitAllowedFields, p2Slice.submitAllowedFields);
  assert.deepEqual(binding.steps[0].reconcileRequiredFields, p2Slice.reconcileFields);
  assert.deepEqual(binding.steps[0].reconcileAllowedFields, p2Slice.reconcileAllowedFields);
  assert.equal(binding.steps[0].branchFieldRule, p2Slice.branchFieldRule);
  assert.deepEqual(binding.steps[0].scalarNullability, p2Slice.scalarNullability);
  assert.deepEqual(binding.steps[0].requestResolution, p2Slice.requestResolution);
  assert.equal(binding.steps[0].profilePreconstructionBoundary, p2Slice.profilePreconstructionBoundary);
  assert.deepEqual(binding.steps[0].submitRequiredFields, operation.inputSemantics.submitRequiredFields);
  assert.deepEqual(binding.steps[0].submitAllowedFields, operation.inputSemantics.submitAllowedFields);
  assert.deepEqual(binding.steps[0].fingerprintFields, operation.inputSemantics.requestFingerprint.fields);
  assert.equal(binding.steps[0].fingerprintVersion, operation.inputSemantics.requestFingerprint.version);
}

function validateBoundedJ03TranscriptReviewDefinition(journey) {
  const decision = ".product-experience/decision-log.md#PXD-064";
  const sourceDecision = ".product-experience/decision-log.md#PXD-062";
  const grammarDecision = ".product-experience/decision-log.md#PXD-063";
  assert.equal(journey.journeyId, "J-03");
  assert.equal(journey.steps.length, 8, "transcript review binds an existing step only");
  const step = journey.steps.find(({ stepId }) => stepId === "J03-4");
  assert.ok(step, "J03-4 is the existing transcript review step");
  assert.equal(step.view, "media.view.review-transcript");
  assert.equal(step.action, "media.action.review-transcript");
  assert.equal(step.canonicalOperationRef, "media.operation.transcript-version-read");
  assert.deepEqual(step.requiredOperationRefs, ["media.operation.transcript-version-read"]);
  assert.deepEqual(step.objectRefs, ["media.domain.transcript-version", "media.domain.artifact-version"]);
  assert.deepEqual(step.stateRefs, [], "read-only transcript inspection defines no state machine or transition");
  assert.deepEqual(step.actorRefs, ["media.creator", "media.editor", "media.reviewer"]);
  assert.equal(step.authorityRef, ".product-experience/pdp-1-domain-data/operations.yaml#media.operation.transcript-version-read");
  assert.equal(step.sourceDecisionRef, sourceDecision);
  assert.equal(step.grammarDecisionRef, grammarDecision);
  assert.equal(step.decisionRef, decision);
  assert.equal(step.transitionRef, null);
  assert.equal(step.transitionDisposition.status, "NOT_APPLICABLE_WITH_REASON");
  assert.equal(step.transitionDisposition.decisionRef, decision);
  assert.match(step.transitionDisposition.reason, /read-only observation/u);
  assert.equal(step.definitionVerification.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.definitionVerification.runtimeVerification, "not-run");
  assert.equal(step.verification.status, "not-run");
  assert.deepEqual(step.verification.actualEvidence, []);
  assert.match(step.success.proposal, /Missing timing does not block inspection/u);
  assert.match(step.failure.proposal, /TRANSCRIPT_VERSION_NOT_FOUND_IN_CALLER_SCOPE/u);
  assert.match(step.failure.proposal, /SOURCE_IDENTITY_MISMATCH/u);
  assert.match(step.failure.proposal, /UNAVAILABLE/u);
  assert.match(step.recovery.proposal, /same transcriptVersionId/u);
  assert.match(step.recovery.proposal, /never substitute a job ID/u);
  assert.ok(step.postconditions.includes("no-mutation-or-caption-registration-or-approval-or-publication"));

  const operationDoc = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");
  const operation = [...(operationDoc.operations ?? []), ...(operationDoc.individualOperationContracts?.records ?? [])]
    .find(({ id }) => id === "media.operation.transcript-version-read");
  assert.ok(operation);
  assert.equal(operation.ownerDefinitionRef, sourceDecision);
  assert.deepEqual(operation.inputSemantics.requiredFields, ["transcriptVersionId"]);
  assert.deepEqual(operation.inputSemantics.trustedHostFields, ["tenantId", "principalId"]);
  assert.deepEqual(operation.transition.transitionRefs, []);
  assert.match(operation.inputSemantics.selector, /no-jobId-transcriptArtifactId-sourceArtifactId-latest-alias-or-global-list/u);
  assert.match(operation.recovery, /same-exact-transcriptVersionId/u);
  assert.equal(operation.scopeStatus, "proposal-only; bounded-owner-semantics-under-PXD-062; canonical-materializer-and-runtime-NOT_ADMITTED; independent-PDP1-review-pending");

  const transcript = readYaml(".product-experience/pdp-1-domain-data/domain-objects.yaml").objects
    .find(({ id }) => id === "media.domain.transcript-version");
  assert.ok(transcript);
  assert.match(transcript.identity, /trusted-tenantId-plus-opaque-transcriptVersionId/u);
  assert.match(transcript.materialization, /no-qualified-producer-is-claimed/u);

  const bindings = readYaml(".product-experience/pdp-3-product-experience/experience-source-bindings.yaml").j03TranscriptReviewBindings;
  assert.equal(bindings.status, "SOURCE_DEFINED_OWNER_ACCEPTED");
  assert.equal(bindings.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(bindings.sourceDecisionRef, sourceDecision);
  assert.equal(bindings.grammarDecisionRef, grammarDecision);
  assert.equal(bindings.reviewDecisionRef, decision);
  assert.deepEqual(bindings.steps.map(({ stepId }) => stepId), ["J03-4"]);
  assert.deepEqual(bindings.steps[0].domainObjectRefs, step.objectRefs);
  assert.deepEqual(bindings.steps[0].stateRefs, []);

  const action = readYaml(".product-experience/pdp-3-product-experience/action-registry.yaml").actions
    .find(({ id }) => id === "media.action.review-transcript");
  assert.ok(action);
  assert.equal(action.actionDefinitionSemantics.operationRef, operation.id);
  assert.equal(action.actionDefinitionSemantics.sourceDecisionRef, sourceDecision);
  assert.equal(action.actionDefinitionSemantics.grammarDecisionRef, grammarDecision);
  assert.equal(action.actionDefinitionSemantics.reviewDecisionRef, decision);
  assert.equal(action.actionDefinitionSemantics.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(action.actionDefinitionSemantics.reversibility.kind, "UNKNOWN");
  assert.equal(action.actionDefinitionSemantics.publicBooleanDisposition, "PUBLIC_BOOLEAN_NOT_REPRESENTABLE");
  assert.equal(action.actionDefinitionSemantics.publicEffect, undefined);
  assert.equal(action.actionDefinitionSemantics.publicFinality, undefined);
}

function validateBoundedJ29ReconnectDefinition(journey) {
  const decision = ".product-experience/decision-log.md#PXD-077";
  const operationRef = "media.operation.capability.media-stream-session-reconnect";
  const actionRef = "media.action.request-live-session-reconnect";
  const expectedGuards = [
    "media.guard.stream.reconnect.same-session-scope",
    "media.guard.stream.reconnect.degraded-session",
    "media.guard.stream.reconnect.current-consent",
    "media.guard.stream.reconnect.current-fence",
    "media.guard.stream.reconnect.prior-effects-resolved",
    "media.guard.stream.reconnect.budget-available",
    "media.guard.stream.reconnect.next-sequence-contiguous",
  ];
  assert.equal(journey.journeyId, "J-29");
  assert.equal(journey.steps.length, 4);
  const step = journey.steps[3];
  assert.equal(step.stepId, "present-bounded-return-state");
  assert.equal(step.decisionRef, decision);
  assert.equal(step.canonicalOperationRef, operationRef);
  assert.equal(step.ownerActionRef, actionRef);
  assert.equal(step.bindingStatus.status.split(";")[0], "BOUNDED_MEDIA_OWNER_DEFINITION_PXD_077");
  assert.deepEqual(step.guardRefs, expectedGuards);
  assert.deepEqual(step.canonicalOperationRefs, [operationRef]);
  assert.deepEqual(step.capabilityRefs, ["media.stream.session.reconnect"]);
  assert.deepEqual(step.requirementRefs, ["MEDIA-REQ-CAP-STREAM"]);
  const semantics = step.stepDefinitionSemantics;
  const operationBinding = semantics?.operationContractBinding;
  assert.equal(semantics?.ownerDefinitionDecisionRef, decision);
  assert.equal(semantics?.action?.actionRef, actionRef);
  assert.equal(semantics?.action?.semanticRole, "DOMAIN_OPERATION");
  assert.equal(semantics?.action?.runtimeAdmission, "NOT_ADMITTED");
  assert.deepEqual(semantics?.action?.guards, expectedGuards);
  assert.match(semantics?.action?.effect ?? "", /fenced reconnect handshake/u);
  assert.doesNotMatch(semantics?.action?.effect ?? "", /session restored|frame sent/u);
  assert.equal(operationBinding?.operationRef, operationRef);
  assert.equal(operationBinding?.operationKind, "COMMAND");
  assert.equal(operationBinding?.scopeStatus, "OWNER_DEFINED_DEFINITION_ONLY");
  assert.equal(operationBinding?.runtimeAdmission, "NOT_ADMITTED");
  assert.deepEqual(operationBinding?.guardRefs, expectedGuards);
  assert.ok(operationBinding?.sourceRef.endsWith(operationRef));
  assert.deepEqual(step.objectRefs, ["media.domain.stream-session"]);
  assert.deepEqual(step.stateRefs, [".product-experience/pdp-1-domain-data/states.yaml#media-stream-session"]);
  assert.deepEqual(step.authorityRefs, [
    ".product-experience/pdp-1-domain-data/authority.yaml#ownerDefinedPdp10AuthorityScopes.identityScope",
    ".product-experience/pdp-1-domain-data/privacy.yaml#ownerDefinedPdp10Boundary.consentRevocation",
    ".product-experience/pdp-1-domain-data/privacy.yaml#ownerDefinedPdp10Boundary.duplicateEffectPrevention",
  ]);
  assert.match(semantics?.action?.finality ?? "", /UNKNOWN_OUTCOME/u);

  const ownerAction = readYaml(".product-experience/pdp-3-product-experience/action-registry.yaml").ownerDefinedActions
    .find(({ id }) => id === actionRef);
  assert.ok(ownerAction);
  assert.equal(ownerAction.sourceDefinitionDecisionRef, decision);
  assert.equal(ownerAction.operationRef, operationRef);
  assert.equal(ownerAction.operationKind, "COMMAND");
  assert.deepEqual(ownerAction.guardRefs, expectedGuards);
  assert.equal(ownerAction.runtimeAdmission, "NOT_ADMITTED");
  assert.deepEqual(ownerAction.requestSemantics.requiredInputs.serverDerived, [{
    field: "requestFingerprint",
    source: "SERVER_COMPUTED_FROM_TRUSTED_IDENTITY_AND_CANONICAL_REQUEST_BODY",
    callerMaySupply: false,
  }]);

  const operation = readYaml(".product-experience/pdp-1-domain-data/operations.yaml").capabilityOperationContracts.records
    .find(({ id }) => id === operationRef);
  assert.ok(operation);
  assert.equal(operation.operationKind, "COMMAND");
  assert.equal(operation.admission?.executionAdmission, "NOT_ADMITTED");
  assert.deepEqual(operation.domainObjectRefs, ["media.domain.stream-session"]);
  assert.deepEqual(operation.stateRefs, [".product-experience/pdp-1-domain-data/states.yaml#media-stream-session"]);
  assert.deepEqual(operation.requirementRefs, ["MEDIA-REQ-CAP-STREAM"]);
  assert.ok(operation.requestSchema && operation.resultSchema, "the exact operation schema must resolve");
}

function validateBoundedJ29ObservationDefinition(journey) {
  const sourceRef = ".product-experience/pdp-3-product-experience/journey-contracts/live-session-loss-consent-change-and-bounded-recovery.yaml#/steps/0";
  const laterOutcomeRef = ".product-experience/pdp-3-product-experience/journey-contracts/live-session-loss-consent-change-and-bounded-recovery.yaml#/terminalSuccess";
  const decisionRef = ".product-experience/decision-log.md#PXD-119";
  const step = journey.steps[0];
  const semantics = step.stepDefinitionSemantics;
  assert.equal(journey.journeyId, "J-29");
  assert.equal(step.stepId, "detect-loss-or-consent-change");
  assert.equal(step.view, "media.view.review-activity");
  assert.equal(step.actionRef, undefined);
  assert.equal(step.canonicalOperationRef, null);
  assert.equal(step.authorityRef, null);
  assert.equal(step.transitionRef, null);
  assert.equal(semantics.ownerDefinitionDecisionRef, decisionRef);
  assert.equal(semantics.action.actionRef, null);
  assert.equal(semantics.action.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(semantics.action.semanticRole, "NO_DOMAIN_DISPATCH_OBSERVATION_OR_GATE");
  assert.equal(semantics.action.finality, "No external operation is bound; provider/session/frame finality remains owner-observed or UNKNOWN.");
  assert.equal(semantics.stepSourceFacts.result,
    "NO_OPERATION_RESULT: this gate/observation step has no bound operation query; missing owner evidence remains UNKNOWN.");
  assert.deepEqual(semantics.stepSourceFacts.resultSourceRef, [
    `${sourceRef}/stepDefinitionSemantics/action/bindingStatus`,
    `${sourceRef}/stepDefinitionSemantics/canonicalBindingDisposition/fields/canonicalOperationRef`,
    `${sourceRef}/stepDefinitionSemantics/stepInteractionSemantics/positive`,
  ]);
  assert.equal(semantics.stepSourceFacts.success.status, "NO_RESULT_UNTIL_OWNER_OBSERVATION");
  assert.equal(semantics.stepSourceFacts.success.sourceRef, `${sourceRef}/stepDefinitionSemantics`);
  assert.equal(semantics.stepSourceFacts.success.meaning,
    "No operation result is produced because no exact query is bound; missing/unavailable owner observation remains UNKNOWN.");
  assert.equal(semantics.stepSourceFacts.success.laterJourneyOutcomeRef, laterOutcomeRef);
  assert.equal(step.success.status, "NO_RESULT_UNTIL_OWNER_OBSERVATION");
  assert.equal(step.success.scope, "immediate-step-result");
  assert.equal(step.success.sourceRef, `${sourceRef}/stepDefinitionSemantics`);
  assert.equal(step.success.meaning, semantics.stepSourceFacts.success.meaning);
  assert.equal(step.success.laterJourneyOutcomeRef, laterOutcomeRef);
  assert.equal(step.bindingStatus.success,
    `step-scoped immediate result defined by ${sourceRef}/stepDefinitionSemantics; later journey outcome remains separate`);
  assert.equal(step.bindingStatus.degradedBehavior,
    `source-backed immediate-step degraded disposition defined by ${sourceRef}/stepDefinitionSemantics`);
  assert.equal(semantics.stepInteractionSemantics.kind, "OBSERVE_SESSION_RECOVERY_CONTEXT");
  assert.deepEqual(semantics.stepInteractionSemantics.inputs, [
    "tenantId", "sessionId", "observedSessionState", "leaseVersionOrFencingToken",
    "consentReferenceIdAndVersion", "lastAcknowledgedFrameSequence", "perFrameOutcomeEvidence",
  ]);
  assert.deepEqual(semantics.stepInteractionSemantics.outputs, [
    "exactly-bound-session-observation-or-unknown", "consent-and-lease-currentness-or-unknown", "per-frame-finality-map",
  ]);
  assert.match(semantics.stepInteractionSemantics.positive, /absent, stale, or mismatched evidence remains UNKNOWN/u);
  assert.match(semantics.stepInteractionSemantics.effect, /do not mutate session, consent, job, or frame state/u);
  assert.equal(semantics.transitionApplicability.status, "OBSERVATION_ONLY_NO_TRANSITION");
  assert.equal(semantics.transitionApplicability.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.degradedBehavior.status, "SOURCE_BACKED_UNKNOWN_OR_PARTIAL_HOLD");
  assert.equal(step.degradedBehavior.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.degradedBehavior.dispatch, "NEVER");
  assert.equal(step.degradedBehavior.ownerAcceptedOutcomeOracle, false);
  assert.equal(step.verification.status, "not-run");
  assert.deepEqual(step.verification.actualEvidence, []);
  assert.equal(step.recovery.status, "candidate-proposal");
  assert.match(step.bindingStatus.recovery, /pending/u);
  for (const field of ["authorityRef", "decisionRef", "transitionRef", "handoffRef"]) {
    assert.equal(step[field], null, `${field} remains unbound`);
  }
}

function validateBoundedJ29FenceObservationDefinition(journey) {
  const sourceRef = ".product-experience/pdp-3-product-experience/journey-contracts/live-session-loss-consent-change-and-bounded-recovery.yaml#/steps/1";
  const resultRef = ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.stream-session.inspect-execution-recovery.v1/resultSchema";
  const operation = readYaml(".product-experience/pdp-1-domain-data/operations.yaml").ownerDefinedOperationContracts.records
    .find(({ id }) => id === "media.operation.stream-session.inspect-execution-recovery.v1");
  const step = journey.steps[1];
  const semantics = step.stepDefinitionSemantics;
  const observation = operation?.resultSchema.properties.observation.oneOf.find(({ properties }) => properties?.disposition?.const === "OBSERVED");
  assert.ok(operation, "the exact same-session observation query must resolve");
  assert.ok(observation, "the exact observed-session schema branch must resolve");
  assert.deepEqual(operation.resultSchema.required, ["sessionId", "observation", "observedAt", "readVersion"]);
  assert.deepEqual(observation.required, [
    "disposition", "canonicalStateRef", "stateAuthorityRef", "stateEvidenceRef", "consentRef", "consentRevision",
    "consentCurrentness", "purposeRef", "purposeRevision", "purposeCurrentness", "leaseVersion", "leaseCurrentness",
    "fencingToken", "lastAcknowledgedSequence", "nextSequence", "resolvedFrameOutcomeCoverage",
    "resolvedFrameOutcomeRange", "resolvedFrameOutcomeRefs", "reconnectBudgetRemaining",
  ]);
  assert.equal(journey.journeyId, "J-29");
  assert.equal(step.stepId, "fence-new-frame-submission");
  assert.equal(step.canonicalOperationRef, null, "the step stays an observation/gate and does not bind a fence command");
  assert.deepEqual(step.supportingObservationOperationRefs, [
    "media.operation.stream-session.inspect.v1", "media.operation.consent-record-inspect.v1", operation.id,
  ]);
  assert.equal(step.success.status, "EXACT_OBSERVATION_RESULT_DEFINED");
  assert.equal(step.success.sourceRef, resultRef);
  assert.equal(step.success.resultSchemaRef, resultRef);
  assert.equal(step.success.meaning,
    "One exact same-session observation query result only (sessionId, typed observation, observedAt, readVersion); the query does not dispatch, replay, close, or restore the session.");
  assert.equal(step.success.laterJourneyOutcomeRef,
    ".product-experience/pdp-3-product-experience/journey-contracts/live-session-loss-consent-change-and-bounded-recovery.yaml#/terminalSuccess");
  assert.equal(step.bindingStatus.success,
    `step-scoped immediate result defined by ${resultRef}; later journey outcome remains separate`);
  assert.equal(step.bindingStatus.degradedBehavior,
    `source-backed immediate-step degraded disposition defined by ${resultRef}`);
  assert.equal(semantics.supportingObservationDecisionRef, ".product-experience/decision-log.md#PXD-160");
  assert.equal(semantics.stepSourceFacts.success.resultSchemaRef, resultRef);
  assert.equal(semantics.stepSourceFacts.resultDisposition, "SOURCE_BOUND_IMMEDIATE_RESULT");
  assert.equal(semantics.action.semanticRole, "NO_DOMAIN_DISPATCH_OBSERVATION_OR_GATE");
  assert.equal(semantics.action.actionRef, null);
  assert.equal(semantics.action.runtimeAdmission, "NOT_ADMITTED");
  assert.match(semantics.action.effect, /No frame, close, drain, or cancel request is dispatched/u);
  assert.match(semantics.action.finality, /remains owner-observed or UNKNOWN/u);
  assert.match(semantics.stepSourceFacts.intent, /Do not turn fencing intent into a provider-close or cancellation success/u);
  assert.equal(step.degradedBehavior.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.degradedBehavior.dispatch, "NEVER");
  assert.equal(step.degradedBehavior.ownerAcceptedOutcomeOracle, false);
  assert.equal(step.verification.status, "not-run");
  assert.deepEqual(step.verification.actualEvidence, []);
  assert.equal(step.recovery.status, "candidate-proposal");
  for (const field of ["authorityRef", "decisionRef", "transitionRef", "handoffRef"]) {
    assert.equal(step[field], null, `${field} remains unbound`);
  }
  for (const field of ["authorityRef", "decisionRef", "transitionRef", "handoffRef", "recovery"]) {
    assert.match(step.bindingStatus[field], /pending/u, `${field} remains pending`);
  }
}

function validateBoundedJ29ReconcileNoResultDefinition(journey) {
  const sourceRef = ".product-experience/pdp-3-product-experience/journey-contracts/live-session-loss-consent-change-and-bounded-recovery.yaml#/steps/2";
  const laterOutcomeRef = ".product-experience/pdp-3-product-experience/journey-contracts/live-session-loss-consent-change-and-bounded-recovery.yaml#/terminalSuccess";
  const step = journey.steps[2];
  const semantics = step.stepDefinitionSemantics;
  assert.equal(journey.journeyId, "J-29");
  assert.equal(step.stepId, "reconcile-dispatched-frame-effects");
  assert.equal(step.canonicalOperationRef, null);
  assert.equal(semantics.action.actionRef, null);
  assert.equal(semantics.action.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(semantics.stepSourceFacts.result,
    "NO_OPERATION_RESULT: this gate/observation step has no bound operation query; missing owner evidence remains UNKNOWN.");
  assert.equal(step.success.status, "NO_RESULT_UNTIL_OWNER_OBSERVATION");
  assert.equal(step.success.sourceRef, `${sourceRef}/stepDefinitionSemantics`);
  assert.equal(step.success.meaning,
    "No operation result is produced because no exact query is bound; missing/unavailable owner observation remains UNKNOWN.");
  assert.equal(step.success.laterJourneyOutcomeRef, laterOutcomeRef);
  assert.equal(step.bindingStatus.success,
    `step-scoped immediate result defined by ${sourceRef}/stepDefinitionSemantics; later journey outcome remains separate`);
  assert.equal(step.bindingStatus.degradedBehavior,
    `source-backed immediate-step degraded disposition defined by ${sourceRef}/stepDefinitionSemantics`);
  assert.equal(semantics.stepSourceFacts.success.status, step.success.status);
  assert.deepEqual(semantics.stepSourceFacts.resultSourceRef, [
    `${sourceRef}/stepDefinitionSemantics/action/bindingStatus`,
    `${sourceRef}/stepDefinitionSemantics/canonicalBindingDisposition/fields/canonicalOperationRef`,
    `${sourceRef}/stepDefinitionSemantics/stepInteractionSemantics/positive`,
  ]);
  assert.match(semantics.stepInteractionSemantics.transition, /^OBSERVATION_ONLY_NO_STATE_TRANSITION/u);
  assert.match(semantics.stepInteractionSemantics.effect, /Do not replay an uncertain frame, infer provider stop, or mark stream closed/u);
  assert.match(semantics.stepInteractionSemantics.recovery, /never resend merely because an acknowledgment is absent/u);
  assert.equal(step.degradedBehavior.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.degradedBehavior.dispatch, "NEVER");
  assert.equal(step.degradedBehavior.ownerAcceptedOutcomeOracle, false);
  assert.equal(step.verification.status, "not-run");
  assert.deepEqual(step.verification.actualEvidence, []);
  assert.equal(step.recovery.status, "candidate-proposal");
  for (const field of ["authorityRef", "decisionRef", "transitionRef", "handoffRef"]) {
    assert.equal(step[field], null, `${field} remains unbound`);
  }
}

function validateBoundedJ19ScopedQueryDefinition(journey, { stepIndex, view, operationId, objectRefs }) {
  assert.equal(journey.journeyId, "J-19");
  const step = journey.steps[stepIndex];
  const operations = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");
  const operation = operations.ownerDefinedOperationContracts.records
    .find(({ id }) => id === operationId);
  const profile = operations.ownerDefinedOperationProfiles.profiles
    .find(({ id }) => id === "media.operation-profile.scoped-query.v1");
  const resultRef = ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationProfiles/profiles/@id=media.operation-profile.scoped-query.v1/resultEnvelope";
  assert.ok(operation, "the exact owner-defined quality evidence query must resolve");
  assert.ok(profile, "the exact scoped-query profile must resolve");
  assert.equal(operation.operationKind, "QUERY");
  assert.equal(operation.actionRef, step.actionRef);
  assert.deepEqual(operation.domainObjectRefs, objectRefs);
  assert.deepEqual(operation.resultSchema.fields, ["requestId", "exactTargetRef", "ownerReceipt", "observedAt"]);
  assert.equal(operation.resultSchemaRef, `${profile.id}#resultEnvelope`);
  assert.equal(operation.profileRef, profile.id);
  assert.deepEqual(profile.resultEnvelope.fields, ["typed observations", "observedAt"]);
  assert.equal(profile.resultEnvelope.absence, "scoped absence only; never global absence or proof of no prior effect");
  assert.equal(profile.resultEnvelope.freshness, "observation timestamp, no write precondition");
  assert.equal(profile.finality, "read-only observation; no state mutation, external effect, or authorization grant");
  assert.match(operation.scopeStatus, /transport\/runtime-NOT_ADMITTED/u);
  assert.match(operation.sourceFinality, /^(?:read-only(?:-or-navigation)?(?:; no-write-finality)?|remains-unknown-until-evidence-classifies-outcome)$/u);

  assert.equal(step.view, view);
  assert.equal(step.actionRef, operation.actionRef);
  assert.equal(step.canonicalOperationRef, operation.id);
  assert.deepEqual(step.objectRefs, operation.domainObjectRefs);
  assert.deepEqual(step.stateRefs, []);
  assert.equal(step.success.status, "EXACT_OPERATION_RESULT_DEFINED");
  assert.equal(step.success.scope, "immediate-step-result");
  assert.equal(step.success.sourceRef, resultRef);
  assert.equal(step.success.resultSchemaRef, resultRef);
  assert.equal(step.success.operationRef, operation.id);
  assert.match(step.success.meaning, /exact-target scoped owner observation with requestId, exactTargetRef, ownerReceipt and observedAt/u);
  assert.match(step.success.meaning, /Missing\/stale\/unavailable evidence is UNKNOWN; absence is scoped only/u);
  assert.match(step.success.meaning, /no command effect or replay/u);
  assert.match(step.success.evidenceBoundary, /definition-grade operation contract only/u);
  assert.match(step.success.evidenceBoundary, /runtimeAdmission NOT_ADMITTED and no owner evidence\/result is asserted/u);
  assert.equal(step.success.laterJourneyOutcomeRef,
    ".product-experience/pdp-3-product-experience/journey-contracts/inspect-quality-and-optimize-within-bounds.yaml#/terminalSuccess");
  assert.equal(step.bindingStatus.success,
    `step-scoped immediate result defined by ${resultRef}; later journey outcome remains separate`,
    "J-19 step 3 bindingStatus.success");
  assert.equal(step.degradedBehavior.status, "SOURCE_BACKED_UNKNOWN_OR_PARTIAL_HOLD");
  assert.equal(step.degradedBehavior.sourceRef, resultRef);
  assert.equal(step.degradedBehavior.conditionSourceRef,
    ".product-experience/pdp-0-product-truth/journey-catalog.yaml#journeys/@id=J-19/criticalNonhappyPaths");
  assert.match(step.degradedBehavior.disposition, /UNKNOWN; preserve exact target and label stale\/unknown/u);
  assert.match(step.degradedBehavior.disposition, /infer neither global absence nor downstream effect/u);
  assert.match(step.degradedBehavior.disposition, /reobserve the same selector only\. No command replay/u);
  assert.equal(step.degradedBehavior.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.degradedBehavior.dispatch, "NEVER");
  assert.equal(step.degradedBehavior.ownerAcceptedOutcomeOracle, false);
  assert.equal(step.bindingStatus.degradedBehavior,
    `source-backed immediate-step degraded disposition defined by ${resultRef}`);
  assert.equal(step.stepDefinitionSemantics.ownerDefinitionDecisionRef, ".product-experience/decision-log.md#PXD-075");
  assert.equal(step.stepDefinitionSemantics.action.actionDefinitionDecisionRef, ".product-experience/decision-log.md#PXD-075");
  assert.equal(step.stepDefinitionSemantics.action.runtimeAdmission, "NOT_ADMITTED");
  assert.deepEqual(step.stepDefinitionSemantics.action.exactOperationRefs, [operation.id]);
  assert.equal(step.stepDefinitionSemantics.stepSourceFacts.resultSourceRef, resultRef);
  assert.equal(step.verification.status, "not-run");
  assert.deepEqual(step.verification.actualEvidence, []);
  assert.equal(step.recovery.status, "candidate-proposal");
  assert.match(step.bindingStatus.recovery, /candidate-proposal-only/u);
  for (const field of ["authorityRef", "decisionRef", "transitionRef", "handoffRef"]) {
    assert.equal(step[field], null, `${field} remains unbound`);
  }
}

const boundedScopedQueryStepSpecs = [
  ["J-20", 0, "media.operation.action.view-job-status", "long-running-job-observation-and-recovery.yaml"],
  ["J-20", 1, "media.operation.action.view-job-status", "long-running-job-observation-and-recovery.yaml"],
  ["J-20", 2, "media.operation.action.view-job-status", "long-running-job-observation-and-recovery.yaml"],
  ["J-20", 3, "media.operation.action.view-job-status", "long-running-job-observation-and-recovery.yaml"],
  ["J-20", 6, "media.operation.action.check-job-outcome", "long-running-job-observation-and-recovery.yaml"],
  ["J-17", 2, "media.operation.action.inspect-quality-evidence", "mix-and-master-music-and-effects.yaml"],
  ["J-17", 3, "media.operation.action.inspect-output-preview-and-version", "mix-and-master-music-and-effects.yaml"],
  ["J-25", 0, "media.operation.action.review-processing-parameters", "return-bounded-results-to-integrating-products.yaml"],
  ["J-25", 1, "media.operation.action.view-job-status", "return-bounded-results-to-integrating-products.yaml"],
  ["J-25", 2, "media.operation.action.inspect-output-preview-and-version", "return-bounded-results-to-integrating-products.yaml"],
  ["J-21", 0, "media.operation.action.inspect-version-and-review-scope", "review-exact-version-and-recheck-changes.yaml"],
  ["J-21", 1, "media.operation.action.inspect-output-preview-and-version", "review-exact-version-and-recheck-changes.yaml"],
  ["J-24", 1, "media.operation.action.review-processing-parameters", "run-cli-batch-and-review-verified-outputs.yaml"],
  ["J-24", 2, "media.operation.action.view-job-status", "run-cli-batch-and-review-verified-outputs.yaml"],
  ["J-16", 0, "media.operation.action.review-translated-segment", "translate-and-dub-existing-video.yaml"],
  ["J-16", 4, "media.operation.action.compare-candidate-on-metric", "translate-and-dub-existing-video.yaml"],
  ["J-23", 2, "media.operation.action.view-job-status", "work-locally-and-reconcile-after-reconnect.yaml"],
  ["J-23", 3, "media.operation.action.view-job-status", "work-locally-and-reconcile-after-reconnect.yaml"],
];

function validateBoundedScopedQueryStepDefinition(journey, { journeyId, stepIndex, operationId, sourceFile }) {
  const step = journey.steps[stepIndex];
  const resultRef = ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationProfiles/profiles/@id=media.operation-profile.scoped-query.v1/resultEnvelope";
  const operations = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");
  const operation = operations.ownerDefinedOperationContracts.records.find(({ id }) => id === operationId);
  const profile = operations.ownerDefinedOperationProfiles.profiles.find(({ id }) => id === "media.operation-profile.scoped-query.v1");
  const laterOutcomeRef = `.product-experience/pdp-3-product-experience/journey-contracts/${sourceFile}#/terminalSuccess`;
  const authoredActionRef = step.actionRef ?? step.action;
  assert.equal(journey.journeyId, journeyId);
  assert.ok(operation, `${journeyId} step ${stepIndex} exact scoped-query operation must resolve`);
  assert.ok(profile, "the exact scoped-query profile must resolve");
  assert.equal(operation.operationKind, "QUERY");
  assert.equal(operation.actionRef, authoredActionRef);
  assert.deepEqual(operation.domainObjectRefs, step.objectRefs);
  assert.equal(operation.profileRef, profile.id);
  assert.equal(operation.resultSchemaRef, `${profile.id}#resultEnvelope`);
  assert.deepEqual(operation.resultSchema.fields, ["requestId", "exactTargetRef", "ownerReceipt", "observedAt"]);
  assert.deepEqual(profile.resultEnvelope.fields, ["typed observations", "observedAt"]);
  assert.equal(profile.resultEnvelope.absence, "scoped absence only; never global absence or proof of no prior effect");
  assert.equal(profile.finality, "read-only observation; no state mutation, external effect, or authorization grant");
  assert.match(operation.scopeStatus, /transport\/runtime-NOT_ADMITTED/u);
  assert.match(operation.sourceFinality, /^(?:read-only(?:-or-navigation)?(?:; no-write-finality)?|remains-unknown-until-evidence-classifies-outcome)$/u);
  assert.equal(step.canonicalOperationRef, operationId);
  assert.deepEqual(step.stateRefs, []);
  assert.equal(step.success.status, "EXACT_OPERATION_RESULT_DEFINED");
  assert.equal(step.success.sourceRef, resultRef);
  assert.equal(step.success.resultSchemaRef, resultRef);
  assert.equal(step.success.operationRef, operationId);
  assert.equal(step.success.laterJourneyOutcomeRef, laterOutcomeRef);
  assert.match(step.success.meaning, /requestId, exactTargetRef, ownerReceipt and observedAt/u);
  assert.match(step.success.meaning, /Missing\/stale\/unavailable evidence is UNKNOWN; absence is scoped only/u);
  assert.match(step.success.meaning, /no command effect or replay/u);
  assert.match(step.success.evidenceBoundary, /runtimeAdmission NOT_ADMITTED and no owner evidence\/result is asserted/u);
  assert.equal(step.bindingStatus.success,
    `step-scoped immediate result defined by ${resultRef}; later journey outcome remains separate`,
    `${journeyId} step ${stepIndex} bindingStatus.success`);
  assert.equal(step.degradedBehavior.status, "SOURCE_BACKED_UNKNOWN_OR_PARTIAL_HOLD");
  assert.equal(step.degradedBehavior.sourceRef, resultRef);
  assert.equal(step.degradedBehavior.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.degradedBehavior.dispatch, "NEVER");
  assert.equal(step.degradedBehavior.ownerAcceptedOutcomeOracle, false);
  assert.match(step.degradedBehavior.disposition, /UNKNOWN/u);
  assert.match(step.degradedBehavior.disposition, /no command replay/iu);
  assert.equal(step.bindingStatus.degradedBehavior, `source-backed immediate-step degraded disposition defined by ${resultRef}`);
  assert.equal(step.stepDefinitionSemantics.action.runtimeAdmission, "NOT_ADMITTED");
  assert.deepEqual(step.stepDefinitionSemantics.action.exactOperationRefs, [operationId]);
  assert.equal(step.stepDefinitionSemantics.stepSourceFacts.resultSourceRef, resultRef);
  assert.equal(step.verification.status, "not-run");
  assert.deepEqual(step.verification.actualEvidence, []);
  assert.equal(step.recovery.status, "candidate-proposal");
  for (const field of ["authorityRef", "decisionRef", "transitionRef", "handoffRef"]) {
    assert.equal(step[field], null, `${journeyId} step ${stepIndex} ${field} remains unbound`);
  }
  for (const field of ["authorityRef", "decisionRef", "transitionRef", "handoffRef"]) {
    assert.match(step.bindingStatus[field], /pending/u, `${journeyId} step ${stepIndex} ${field} remains pending`);
  }
}

const boundedJ20CommandStepSpecs = [
  [4, "media.operation-slice.cancel-job", ["jobId", "requestId"], "cancellation-request-observation-with-job-and-attempt-references"],
  [5, "media.operation-slice.retry-job", ["jobId", "priorAttemptId", "requestId"], "same-media-job-reference-and-new-attempt-observation"],
];

function validateBoundedJ20CommandOutcomeDefinition(journey, { stepIndex, operationId, requestFields, expectedArtifactType }) {
  const step = journey.steps[stepIndex];
  const resultRef = `.product-experience/pdp-1-domain-data/operations.yaml#individualOperationContracts/records/@id=${operationId}/ownerWireSchema/resultSchema`;
  const operation = readYaml(".product-experience/pdp-1-domain-data/operations.yaml").individualOperationContracts.records
    .find(({ id }) => id === operationId);
  const outcome = operation?.ownerWireSchema?.resultSchema;
  const artifact = outcome?.properties?.outputs?.items?.oneOf?.find(({ properties }) => properties?.artifactType?.const === expectedArtifactType);
  assert.equal(journey.journeyId, "J-20");
  assert.ok(operation, `${operationId} source operation contract must resolve`);
  assert.ok(outcome, `${operationId} exact owner wire result schema must resolve`);
  assert.ok(artifact, `${operationId} exact output artifact must resolve`);
  assert.equal(operation.operationKind, "COMMAND");
  assert.equal(operation.ownerWireSchema.operationRef, operationId);
  assert.deepEqual(operation.ownerWireSchema.requestSchema.required, requestFields);
  assert.deepEqual(outcome.required, ["operationRef", "outcome", "observedAt", "outputs"]);
  assert.deepEqual(outcome.properties.outcome.enum, ["SUCCEEDED", "REJECTED", "UNKNOWN_OUTCOME"]);
  assert.equal(artifact.properties.artifactType.const, expectedArtifactType);
  assert.equal(step.canonicalOperationRef, operationId);
  assert.equal(step.success.status, "EXACT_OPERATION_RESULT_DEFINED");
  assert.equal(step.success.sourceRef, resultRef);
  assert.equal(step.success.resultSchemaRef, resultRef);
  assert.equal(step.success.operationRef, operationId);
  assert.equal(step.success.scope, "immediate-step-result");
  assert.equal(step.success.laterJourneyOutcomeRef,
    ".product-experience/pdp-3-product-experience/journey-contracts/long-running-job-observation-and-recovery.yaml#/terminalSuccess");
  assert.equal(step.bindingStatus.success,
    `step-scoped immediate result defined by ${resultRef}; later journey outcome remains separate`);
  assert.match(step.success.evidenceBoundary, /runtimeAdmission NOT_ADMITTED and no owner evidence\/result is asserted/u);
  assert.equal(step.stepDefinitionSemantics.action.runtimeAdmission, "NOT_ADMITTED");
  assert.deepEqual(step.stepDefinitionSemantics.action.exactOperationRefs, [operationId]);
  assert.equal(step.stepDefinitionSemantics.stepSourceFacts.resultSourceRef, resultRef);
  assert.match(operation.ownerWireSchema.scopeStatus, /NOT_ADMITTED/u);
  assert.equal(step.degradedBehavior.sourceRef, resultRef);
  assert.equal(step.degradedBehavior.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.degradedBehavior.dispatch, "NEVER");
  assert.equal(step.degradedBehavior.ownerAcceptedOutcomeOracle, false);
  assert.match(step.degradedBehavior.disposition, /unknown/iu);
  assert.equal(step.bindingStatus.degradedBehavior,
    `source-backed immediate-step degraded disposition defined by ${resultRef}`);
  assert.equal(step.verification.status, "not-run");
  assert.deepEqual(step.verification.actualEvidence, []);
  assert.equal(step.recovery.status, "candidate-proposal");
  assert.match(step.recovery.proposal, /check an uncertain outcome before considering a new request/u);
  assert.match(step.recovery.proposal, /retry starts only after the prior attempt is classified retryable and current owner policy allows it/u);
  if (operationId === "media.operation-slice.cancel-job") {
    assert.match(step.success.meaning, /request acknowledgement does not prove stop or prevent a racing result/u);
    assert.match(step.degradedBehavior.disposition, /Do not claim cancelled unless the job owner confirms stop/u);
    assert.match(operation.finality, /cancellation request is not cancellation completion/u);
    assert.ok(operation.ownerDefinition.negativeCases.includes("unknown-dispatch-treated-as-no-effect"));
    assert.match(operation.ownerDefinition.recovery, /inspect-the-same-job-and-attempt-evidence/u);
    assert.match(operation.ownerDefinition.retry, /same-request-reconciliation-before-resubmission/u);
  } else {
    assert.match(step.success.meaning, /fenced new-attempt identity under the same logical job/u);
    assert.match(step.success.meaning, /provider dispatch and outcome remain separate/u);
    assert.match(step.degradedBehavior.disposition, /unknown prior-effect/u);
    assert.match(step.degradedBehavior.disposition, /no blind retry/u);
    assert.ok(operation.negativeCases.includes("retry-unknown-effect-without-reconciliation"));
    assert.ok(operation.ownerDefinition.guards.includes("prior-outcome-is-not-unknown"));
    assert.match(operation.ownerDefinition.recovery, /if-prior-outcome-is-unknown-run-the-separate-authoritative-reconciliation-contract-first/u);
    assert.match(operation.ownerDefinition.recovery, /do-not-retry-until-it-classifies-a-safe-retryable-outcome/u);
  }
  for (const field of ["authorityRef", "decisionRef", "transitionRef", "handoffRef"]) {
    assert.equal(step[field], null, `${stepIndex} ${field} remains unbound`);
  }
}

const boundedLocalStepEffectSpecs = [
  ["J-17", 0, "media.local-step-effect.j-17.step-01.v1", "mix-and-master-music-and-effects.yaml", "CATALOG_SELECTION"],
  ["J-17", 1, "media.local-step-effect.j-17.step-02.v1", "mix-and-master-music-and-effects.yaml", "DRAFT_PATCH"],
  ["J-24", 0, "media.local-step-effect.j-24.step-01.v1", "run-cli-batch-and-review-verified-outputs.yaml", "CATALOG_SELECTION"],
  ["J-16", 3, "media.local-step-effect.j-16.step-04.v1", "translate-and-dub-existing-video.yaml", "CATALOG_SELECTION"],
  ["J-23", 0, "media.local-step-effect.j-23.step-01.v1", "work-locally-and-reconcile-after-reconnect.yaml", "CATALOG_SELECTION"],
];

function validateBoundedLocalStepEffectDefinition(journey, { journeyId, stepIndex, effectId, sourceFile, effectMode }) {
  const step = journey.steps[stepIndex];
  const effectRef = `.product-experience/pdp-3-product-experience/local-step-effect-contracts.yaml#records/@id=${effectId}`;
  const sourceRef = `.product-experience/pdp-3-product-experience/journey-contracts/${sourceFile}#/steps/${stepIndex}`;
  const record = readYaml(".product-experience/pdp-3-product-experience/local-step-effect-contracts.yaml").records
    .find(({ id }) => id === effectId);
  assert.equal(journey.journeyId, journeyId);
  assert.ok(record, `${effectId} exact local-step-effect contract must resolve`);
  assert.equal(record.sourceRef, sourceRef);
  assert.equal(record.journeyRef, journeyId);
  assert.equal(record.ordinal, stepIndex + 1);
  assert.equal(record.actionRef, step.actionRef);
  assert.equal(record.effectMode, effectMode);
  assert.deepEqual(record.exactOperationRefs, []);
  assert.deepEqual(record.canonicalDomainObjectRefs, []);
  assert.equal(record.canonicalTransitionRef, null);
  assert.equal(record.decisionRef, ".product-experience/decision-log.md#PXD-119");
  assert.deepEqual(record.inputContract.requiredKeys, [
    "sessionRef", "actorRef", "tenantId", "workspaceRef", "projectRef", "expectedDraftRevision",
    "actionRef", "draftSlotRef", "mutationId", "mutation",
  ]);
  if (effectMode === "CATALOG_SELECTION") {
    assert.deepEqual(record.inputContract.mutation.requiredKeys, ["kind", "candidateValue", "catalogRef", "catalogRevision"]);
    assert.equal(record.inputContract.mutation.kind, "SELECT_CATALOG_ENTRY");
  } else {
    assert.deepEqual(record.inputContract.mutation.requiredKeys, ["kind", "value"]);
    assert.equal(record.inputContract.mutation.kind, "PATCH_LOCAL_DRAFT_SLOT");
    assert.ok(record.inputContract.mutation.valueSchemaRefs.length > 0);
  }
  assert.equal(record.inputContract.mutationId,
    "unique request identity within one local editor session; never an idempotency key for server work");
  assert.match(record.inputContract.effectBoundary, /only makes a local editor-session patch eligible/u);
  assert.match(record.inputContract.effectBoundary, /does not mutate the session or dispatch any canonical operation/u);
  assert.equal(record.trustedContextContract.source, "HOST_EDITOR_SESSION_CONTEXT");
  assert.equal(record.trustedContextContract.notCallerSupplied, true);
  assert.ok(record.guards.includes("trusted-editor-session-current-and-same-session"));
  assert.ok(record.guards.includes("draft-revision-cas-matches-current-local-revision"));
  if (effectMode === "CATALOG_SELECTION") {
    assert.ok(record.guards.includes("catalog-is-current-and-selected-ref-is-visible-and-selectable"));
  } else {
    assert.ok(record.guards.includes("patch-is-well-formed-for-the-declared-local-slot"));
  }
  assert.equal(record.effect.scope, "current local editor-session draft only");
  assert.equal(record.effect.committedMediaObjects, "unchanged");
  assert.equal(record.effect.remoteDispatch, "none");
  assert.equal(record.finality.split(";")[0], "LOCAL_DRAFT_REVISION_ONLY");
  assert.equal(record.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.canonicalOperationRef, null);
  assert.deepEqual(step.objectRefs, []);
  assert.deepEqual(step.stateRefs, []);
  assert.equal(step.success.status, "STEP_RESULT_DEFINED");
  assert.equal(step.success.scope, "immediate-step-result");
  assert.equal(step.success.sourceRef, effectRef);
  assert.equal(step.success.laterJourneyOutcomeRef, `.product-experience/pdp-3-product-experience/journey-contracts/${sourceFile}#/terminalSuccess`);
  assert.match(step.success.meaning, /local patch eligibility/u);
  assert.match(step.success.meaning, /does not apply or persist a patch/u);
  assert.match(step.success.evidenceBoundary, /no runtime execution, owner evidence, or applied patch is claimed/u);
  assert.equal(step.bindingStatus.success,
    `step-scoped immediate result defined by ${effectRef}; later journey outcome remains separate`);
  assert.equal(step.bindingStatus.degradedBehavior,
    `source-backed immediate-step degraded disposition defined by ${effectRef}`);
  assert.equal(step.degradedBehavior.sourceRef, effectRef);
  assert.equal(step.degradedBehavior.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.degradedBehavior.dispatch, "NEVER");
  assert.equal(step.degradedBehavior.ownerAcceptedOutcomeOracle, false);
  assert.match(step.degradedBehavior.disposition, /HOLD/u);
  assert.match(step.degradedBehavior.disposition, /not an applied edit/u);
  assert.equal(step.stepDefinitionSemantics.action.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.verification.status, "not-run");
  assert.deepEqual(step.verification.actualEvidence, []);
  assert.equal(step.recovery.status, "candidate-proposal");
  for (const field of ["authorityRef", "decisionRef", "transitionRef", "handoffRef"]) {
    assert.equal(step[field], null, `${journeyId} step ${stepIndex} ${field} remains unbound`);
  }
}

function validateBoundedJ21InspectProvenanceDefinition(journey) {
  const step = journey.steps[2];
  const operationId = "media.operation-slice.inspect-provenance";
  const resultRef = `.product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=${operationId}/resultSchema`;
  const operation = readYaml(".product-experience/pdp-1-domain-data/operations.yaml").ownerDefinedOperationContracts.records
    .find(({ id }) => id === operationId);
  assert.equal(journey.journeyId, "J-21");
  assert.ok(operation, "the source-owned provenance inspection operation must resolve");
  assert.deepEqual(operation.resultSchema.fields, ["requestSubject", "manifestRefs", "lineageEdges", "observedAt"]);
  assert.match(operation.resultSchema.absence, /not proof that no lineage exists elsewhere/u);
  assert.match(operation.resultSchema.unresolvedExecutionReference, /semantic UNKNOWN as a completed/u);
  assert.match(operation.resultSchema.unresolvedExecutionReference, /no resolved identity, artifact-version identity, manifest, or lineage/u);
  assert.match(operation.resultSchema.resolvedExecutionIdentity, /ProcessingJob \(tenantId\+jobId\) or JobAttempt \(tenantId\+jobId\+attemptId\)/u);
  assert.match(operation.resultSchema.resolvedExecutionIdentity, /MediaRun is excluded/u);
  assert.equal(operation.requestResultBinding.resolvedExecutionIdentity,
    "EXACTLY_ONE_AUTHORITATIVE_SAME_TENANT_CURRENT_PRINCIPAL_PROCESSING_JOB_OR_JOB_ATTEMPT_IDENTITY");
  assert.match(operation.finality, /read-only time-scoped lineage observation/u);
  assert.match(operation.scopeStatus, /route-owner-logical-contract-accepted/u);
  assert.match(operation.scopeStatus, /transport-and-runtime-NOT_ADMITTED/u);
  assert.ok(operation.sourceRefs.includes(".product-experience/decision-log.md#PXD-152"));
  assert.ok(operation.negativeCases.includes("parse-or-guess-opaque-execution-reference-as-canonical-identity"));
  assert.ok(operation.negativeCases.includes("return-excluded-MediaRun-identity"));
  assert.equal(step.view, "media.view.inspect-provenance");
  assert.equal(step.actionRef, "media.action.inspect-provenance");
  assert.equal(step.canonicalOperationRef, operationId);
  assert.equal(step.success.status, "EXACT_OPERATION_RESULT_DEFINED");
  assert.equal(step.success.sourceRef, resultRef);
  assert.equal(step.success.resultSchemaRef, resultRef);
  assert.equal(step.success.operationRef, operationId);
  assert.match(step.success.meaning, /COMPLETE\/PARTIAL\/UNKNOWN/u);
  assert.match(step.success.meaning, /no global completeness\/absence inference/u);
  assert.match(step.success.evidenceBoundary, /runtimeAdmission NOT_ADMITTED and no owner evidence\/result is asserted/u);
  assert.equal(step.bindingStatus.success,
    `step-scoped immediate result defined by ${resultRef}; later journey outcome remains separate`);
  assert.equal(step.success.laterJourneyOutcomeRef,
    ".product-experience/pdp-3-product-experience/journey-contracts/review-exact-version-and-recheck-changes.yaml#/terminalSuccess");
  assert.equal(step.degradedBehavior.sourceRef, resultRef);
  assert.equal(step.degradedBehavior.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.degradedBehavior.dispatch, "NEVER");
  assert.equal(step.degradedBehavior.ownerAcceptedOutcomeOracle, false);
  assert.match(step.degradedBehavior.disposition, /UNKNOWN/u);
  assert.match(step.degradedBehavior.disposition, /No command replay/u);
  assert.equal(step.bindingStatus.degradedBehavior,
    `source-backed immediate-step degraded disposition defined by ${resultRef}`);
  assert.equal(step.stepDefinitionSemantics.action.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.verification.status, "not-run");
  assert.deepEqual(step.verification.actualEvidence, []);
  assert.equal(step.recovery.status, "candidate-proposal");
  for (const field of ["authorityRef", "decisionRef", "transitionRef", "handoffRef"]) {
    assert.equal(step[field], null, `${field} remains unbound`);
  }
}

const boundedInspectArtifactStepSpecs = [
  ["J-24", 3, "run-cli-batch-and-review-verified-outputs.yaml"],
  ["J-23", 1, "work-locally-and-reconcile-after-reconnect.yaml"],
];

function validateBoundedInspectArtifactDefinition(journey, { journeyId, stepIndex, sourceFile }) {
  const step = journey.steps[stepIndex];
  const operationId = "media.operation-slice.inspect-artifact";
  const resultRef = ".product-experience/pdp-1-domain-data/operations.yaml#individualOperationContracts/records/@id=media.operation-slice.inspect-artifact/readSemantics";
  const operation = readYaml(".product-experience/pdp-1-domain-data/operations.yaml").individualOperationContracts.records
    .find(({ id }) => id === operationId);
  assert.equal(journey.journeyId, journeyId);
  assert.ok(operation, "the exact source-backed caller-scoped artifact query must resolve");
  assert.equal(operation.operationKind, "QUERY");
  assert.equal(operation.resourceScope, "tenant-and-owning-principal");
  assert.equal(operation.outcomes.success, "HTTP-200-artifact-metadata-observation");
  assert.deepEqual(operation.outcomes.declaredErrors, ["HTTP-404-absent-or-inaccessible-within-caller-scope-ARTIFACT_NOT_FOUND"]);
  assert.equal(operation.readSemantics.mutatesDomainState, false);
  assert.equal(operation.readSemantics.noResultMeaning, "absent-in-caller-scope; never-global-nonexistence-or-no-prior-effect");
  assert.equal(operation.readSemantics.unknownOutcome, "unavailable-read-remains-unavailable; never-inferred-job-failure-or-safe-replay");
  assert.equal(operation.readSemantics.retry, "bounded-query-reobservation-only; no-command-replay");
  assert.equal(operation.readSemantics.rightsImplication, "none; metadata-read-does-not-authorize-bytes-processing-or-delivery");
  assert.match(operation.finality, /does not prove object dereference, current rights, retention state, or content integrity recheck/u);
  assert.match(operation.executionAdmission, /production-trusted-identity-and-independent-acceptance-unqualified/u);
  assert.equal(step.view, journeyId === "J-24" ? "media.view.review-outputs" : "media.view.inspect-media");
  assert.equal(step.actionRef, "media.action.inspect-artifact");
  assert.equal(step.canonicalOperationRef, operationId);
  assert.equal(step.success.status, "EXACT_OPERATION_RESULT_DEFINED");
  assert.equal(step.success.sourceRef, resultRef);
  assert.equal(step.success.resultSchemaRef, resultRef);
  assert.equal(step.success.operationRef, operationId);
  assert.equal(step.success.laterJourneyOutcomeRef,
    `.product-experience/pdp-3-product-experience/journey-contracts/${sourceFile}#/terminalSuccess`);
  assert.match(step.success.meaning, /caller-scoped artifact metadata observation/u);
  assert.match(step.success.meaning, /unavailable read is UNKNOWN/u);
  assert.match(step.success.meaning, /proves neither global absence nor no prior effect/u);
  assert.match(step.success.evidenceBoundary, /runtimeAdmission NOT_ADMITTED and no owner evidence\/result is asserted/u);
  assert.equal(step.bindingStatus.success,
    `step-scoped immediate result defined by ${resultRef}; later journey outcome remains separate`);
  assert.equal(step.degradedBehavior.sourceRef, resultRef);
  assert.equal(step.degradedBehavior.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.degradedBehavior.dispatch, "NEVER");
  assert.equal(step.degradedBehavior.ownerAcceptedOutcomeOracle, false);
  assert.match(step.degradedBehavior.disposition, /UNKNOWN/u);
  assert.match(step.degradedBehavior.disposition, /infer neither global absence nor downstream effect/u);
  assert.equal(step.bindingStatus.degradedBehavior,
    `source-backed immediate-step degraded disposition defined by ${resultRef}`);
  assert.equal(step.stepDefinitionSemantics.action.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.verification.status, "not-run");
  assert.deepEqual(step.verification.actualEvidence, []);
  assert.equal(step.recovery.status, "candidate-proposal");
  for (const field of ["authorityRef", "decisionRef", "transitionRef", "handoffRef"]) {
    assert.equal(step[field], null, `${journeyId} step ${stepIndex} ${field} remains unbound`);
  }
}

function validateBoundedJ16CaptionDraftWriteDefinition(journey) {
  const step = journey.steps[2];
  const operationId = "media.operation.caption-draft-write";
  const resultRef = ".product-experience/pdp-1-domain-data/operations.yaml#operations/@id=media.operation.caption-draft-write/outputSemantics";
  const operation = readYaml(".product-experience/pdp-1-domain-data/operations.yaml").operations
    .find(({ id }) => id === operationId);
  assert.equal(journey.journeyId, "J-16");
  assert.ok(operation, "the exact session-local caption draft operation must resolve");
  assert.deepEqual(operation.outputSemantics.successFields, [
    "draftId", "draftRevision", "sourceArtifactId", "sourceArtifactVersionId", "parentVersionKind",
    "parentVersionId", "editKind", "segments", "timingAvailability", "observedAt",
  ]);
  assert.match(operation.outputSemantics.result, /complete-new-session-local-draft-snapshot/u);
  assert.match(operation.outputSemantics.result, /do-not-claim-persistence-beyond-the-active-session/u);
  assert.match(operation.finality, /no-immutable-caption-registration-review-approval-delivery-or-publication/u);
  assert.match(operation.unknownOutcome, /inspect-the-same-session-local-draft/u);
  assert.match(operation.unknownOutcome, /no-remote-effect-or-automatic-replay-is-implied/u);
  assert.match(operation.idempotency, /after-uncertain-local-result-inspect-the-same-draft-before-applying-any-edit-again/u);
  assert.match(operation.idempotency, /never-blindly-reapply-or-increment-again/u);
  assert.equal(operation.transition.applicability, "no-domain-transition");
  assert.match(operation.scopeStatus, /session-local-draft-only/u);
  assert.match(operation.scopeStatus, /runtime-NOT_ADMITTED/u);
  assert.equal(step.view, "media.view.edit-captions");
  assert.equal(step.canonicalOperationRef, operationId);
  assert.equal(step.success.status, "EXACT_OPERATION_RESULT_DEFINED");
  assert.equal(step.success.sourceRef, resultRef);
  assert.equal(step.success.resultSchemaRef, resultRef);
  assert.equal(step.success.operationRef, operationId);
  assert.equal(step.success.laterJourneyOutcomeRef,
    ".product-experience/pdp-3-product-experience/journey-contracts/translate-and-dub-existing-video.yaml#/terminalSuccess");
  assert.match(step.success.meaning, /SUCCEEDED, REJECTED, or UNKNOWN_OUTCOME/u);
  assert.match(step.success.meaning, /complete session-local draft snapshot/u);
  assert.match(step.success.meaning, /no persistence or canonical-version claim/u);
  assert.match(step.success.evidenceBoundary, /runtimeAdmission NOT_ADMITTED and no owner evidence\/result is asserted/u);
  assert.equal(step.bindingStatus.success,
    `step-scoped immediate result defined by ${resultRef}; later journey outcome remains separate`);
  assert.equal(step.degradedBehavior.sourceRef, resultRef);
  assert.equal(step.degradedBehavior.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.degradedBehavior.dispatch, "NEVER");
  assert.equal(step.degradedBehavior.ownerAcceptedOutcomeOracle, false);
  assert.match(step.degradedBehavior.disposition, /UNKNOWN_OUTCOME holds/u);
  assert.match(step.degradedBehavior.disposition, /reconcile the same request before any retry/u);
  assert.match(step.degradedBehavior.disposition, /no blind replay/u);
  assert.equal(step.bindingStatus.degradedBehavior,
    `source-backed immediate-step degraded disposition defined by ${resultRef}`);
  assert.equal(step.stepDefinitionSemantics.action.runtimeAdmission, "NOT_ADMITTED");
  assert.deepEqual(step.stepDefinitionSemantics.action.exactOperationRefs, [operationId]);
  assert.deepEqual(step.stepDefinitionSemantics.stepSourceFacts.resultSourceRef, [`${resultRef}/result`]);
  assert.equal(step.verification.status, "not-run");
  assert.deepEqual(step.verification.actualEvidence, []);
  assert.equal(step.recovery.status, "candidate-proposal");
  for (const field of ["authorityRef", "decisionRef", "transitionRef", "handoffRef"]) {
    assert.equal(step[field], null, `${field} remains unbound`);
  }
}

function validateBoundedJ16UnselectedActionSetDefinition(journey) {
  const step = journey.steps[1];
  const sourceRef = ".product-experience/pdp-3-product-experience/journey-contracts/translate-and-dub-existing-video.yaml#/steps/1/candidateActionRefs";
  assert.equal(journey.journeyId, "J-16");
  assert.equal(step.view, "media.view.work-with-speech");
  assert.equal(step.actionRef, null);
  assert.equal(step.canonicalOperationRef, null);
  assert.deepEqual(step.candidateActionRefs, [
    "media.action.choose-source", "media.action.request-transcription", "media.action.view-job-status",
    "media.action.review-transcript", "media.action.choose-intent", "media.action.request-admitted-speech-operation",
    "media.action.review-recognized-or-synthesized-content",
  ]);
  assert.equal(step.success.status, "NO_RESULT_UNTIL_EXPLICIT_USER_SELECTION");
  assert.equal(step.success.sourceRef, sourceRef);
  assert.equal(step.success.meaning,
    "No operation result exists until the user explicitly selects one candidate; no default action or result is inferred.");
  assert.equal(step.degradedBehavior.status, "NOT_APPLICABLE_UNTIL_EXPLICIT_USER_SELECTION");
  assert.equal(step.degradedBehavior.sourceRef, sourceRef);
  assert.equal(step.degradedBehavior.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.degradedBehavior.dispatch, "NEVER");
  assert.equal(step.degradedBehavior.ownerAcceptedOutcomeOracle, false);
  assert.equal(step.bindingStatus.success,
    `NO_RESULT_UNTIL_EXPLICIT_USER_SELECTION defined by ${sourceRef}; no default action/result is inferred; later journey outcome remains separate`);
  assert.equal(step.bindingStatus.degradedBehavior,
    `NOT_APPLICABLE_UNTIL_EXPLICIT_USER_SELECTION defined by ${sourceRef}; no operation is dispatched and no degraded outcome exists`);
  assert.equal(step.stepDefinitionSemantics.actionRef, null);
  assert.equal(step.stepDefinitionSemantics.action.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.stepDefinitionSemantics.domainOperationDisposition, "NO_OPERATION_SELECTED");
  assert.equal(step.stepDefinitionSemantics.stepSourceFacts.success.status, "NO_RESULT_UNTIL_EXPLICIT_USER_SELECTION");
  assert.equal(step.stepDefinitionSemantics.stepSourceFacts.success.sourceRef, sourceRef);
  assert.equal(step.stepDefinitionSemantics.stepSourceFacts.success.meaning,
    "No operation result exists until the user explicitly selects one candidate; no default action or result is inferred.");
  assert.equal(step.stepDefinitionSemantics.stepSourceFacts.degradedBehavior.status,
    "NOT_APPLICABLE_UNTIL_EXPLICIT_USER_SELECTION");
  assert.equal(step.stepDefinitionSemantics.stepSourceFacts.degradedBehavior.sourceRef, sourceRef);
  assert.equal(step.stepDefinitionSemantics.stepSourceFacts.degradedBehavior.disposition,
    "No operation is dispatched and no operation result/degraded outcome exists until the user explicitly selects one declared candidate; no default is inferred.");
  for (const field of ["authorityRef", "decisionRef", "transitionRef", "handoffRef"]) {
    assert.equal(step[field], null, `${field} remains unbound`);
    assert.match(step.bindingStatus[field], /pending/u, `${field} remains pending`);
  }
  assert.equal(step.verification.status, "not-run");
  assert.deepEqual(step.verification.actualEvidence, []);
  assert.equal(step.recovery.status, "candidate-proposal");
}

function validateBoundedJ22InspectOutputDefinition(journey) {
  assert.equal(journey.journeyId, "J-22");
  const step = journey.steps[0];
  const operationId = "media.operation.action.inspect-output-preview-and-version";
  const actionId = "media.action.inspect-output-preview-and-version";
  const operations = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");
  const operation = operations.ownerDefinedOperationContracts.records.find(({ id }) => id === operationId);
  assert.ok(operation, `${operationId} must resolve to the P1 owner-defined operation contract`);
  assert.equal(operation.operationKind, "QUERY");
  assert.equal(operation.actionRef, actionId);
  assert.deepEqual(operation.domainObjectRefs, ["media.domain.render-outcome", "media.domain.artifact-version"]);
  const resultRef = ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationProfiles/profiles/@id=media.operation-profile.scoped-query.v1/resultEnvelope";
  assert.equal(step.success.status, "EXACT_OPERATION_RESULT_DEFINED");
  assert.equal(step.success.scope, "immediate-step-result");
  assert.equal(step.success.sourceRef, resultRef);
  assert.equal(step.success.resultSchemaRef, resultRef);
  assert.equal(step.success.operationRef, operation.id);
  assert.equal(step.success.evidenceBoundary,
    "definition-grade operation contract only; runtimeAdmission NOT_ADMITTED and no owner evidence/result is asserted");
  assert.equal(operation.resultSchemaRef, "media.operation-profile.scoped-query.v1#resultEnvelope");
  assert.match(operation.scopeStatus, /runtime-NOT_ADMITTED/u);
  assert.equal(step.bindingStatus.success,
    `step-scoped immediate result defined by ${resultRef}; later journey outcome remains separate`);
  assert.equal(step.degradedBehavior.status, "SOURCE_BACKED_UNKNOWN_OR_PARTIAL_HOLD");
  assert.equal(step.degradedBehavior.sourceRef, resultRef);
  assert.equal(step.degradedBehavior.conditionSourceRef,
    ".product-experience/pdp-0-product-truth/journey-catalog.yaml#journeys/@id=J-22/criticalNonhappyPaths");
  assert.equal(step.degradedBehavior.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.degradedBehavior.dispatch, "NEVER");
  assert.equal(step.degradedBehavior.ownerAcceptedOutcomeOracle, false);
  assert.equal(step.bindingStatus.degradedBehavior,
    `source-backed immediate-step degraded disposition defined by ${resultRef}`);
  assert.equal(step.view, "media.view.inspect-output");
  assert.equal(step.actionRef, actionId);
  assert.equal(step.canonicalOperationRef, operation.id);
  assert.deepEqual(step.objectRefs, operation.domainObjectRefs);
  assert.deepEqual(operation.authorityRefs, [
    ".product-experience/pdp-1-domain-data/authority.yaml#ownership.identityAuthenticationAndDelegation",
    ".product-experience/pdp-1-domain-data/authority.yaml#ownership.privilegedEffects",
  ]);
  assert.equal(step.authorityRef, null, "J22 leaves the singular step authorityRef null");
  assert.equal(step.bindingStatus.authorityRef, "P1 identity and privileged-effect recheck");
  assert.equal(step.bindingStatus.objectRefs, "exact-render-outcome-and-artifact-version-set-defined-by-the-bound-P1-inspect-query");
  assert.equal(step.bindingStatus.canonicalOperationRef, `${operation.id}; runtime NOT_ADMITTED`);
  assert.deepEqual(step.stateRefs, operation.stateRefs);
  assert.deepEqual(step.stepDefinitionSemantics.canonicalBindings.stateRefs, operation.stateRefs);
  assert.equal(step.bindingStatus.stateRefs, "no-media-state-transition; external-delivery-finality-is-separate");
  assert.deepEqual(step.stepDefinitionSemantics.canonicalBindings.objectRefs, operation.domainObjectRefs);
  assert.equal(step.stepDefinitionSemantics.canonicalBindings.canonicalOperationRef, operation.id);
  assert.deepEqual(step.stepDefinitionSemantics.canonicalBindings.authorityRefs, operation.authorityRefs,
    "J22 canonical authority array must match the resolved P1 query authorities");
  assert.equal(step.stepDefinitionSemantics.ownerDefinitionDecisionRef, ".product-experience/decision-log.md#PXD-075");
  assert.equal(step.stepDefinitionSemantics.action.runtimeAdmission, "NOT_ADMITTED");
  assert.deepEqual(step.stepDefinitionSemantics.action.exactOperationRefs, [operation.id]);
  const deliveryStep = journey.steps[1];
  assert.equal(deliveryStep.view, "media.view.deliver-output");
  assert.equal(deliveryStep.canonicalOperationRef, "media.operation.action.deliver-exact-version");
  assert.deepEqual(deliveryStep.objectRefs, ["media.domain.artifact-version", "media.domain.delivery-outcome"]);
  assert.equal(deliveryStep.bindingStatus.canonicalOperationRef, "media.operation.action.deliver-exact-version; request receipt only");
  assert.equal(deliveryStep.stepDefinitionSemantics.canonicalBindings.canonicalOperationRef,
    "media.operation.action.deliver-exact-version");
  assert.deepEqual(deliveryStep.stepDefinitionSemantics.canonicalBindings.objectRefs,
    ["media.domain.artifact-version", "media.domain.delivery-outcome"]);
  assert.equal(deliveryStep.stepDefinitionSemantics.action.runtimeAdmission, "NOT_ADMITTED");
  assert.deepEqual(deliveryStep.stepDefinitionSemantics.action.exactOperationRefs,
    ["media.operation.action.deliver-exact-version"]);
  const deliveryOperation = operations.ownerDefinedOperationContracts.records.find(
    ({ id }) => id === "media.operation.action.deliver-exact-version");
  assert.ok(deliveryOperation, "J22 delivery operation must resolve to the P1 owner-defined operation contract");
  assert.equal(deliveryOperation.operationKind, "COMMAND");
  assert.equal(deliveryOperation.actionRef, "media.action.deliver-exact-version");
  assert.deepEqual(deliveryOperation.domainObjectRefs, ["media.domain.artifact-version", "media.domain.delivery-outcome"]);
  assert.equal(deliveryStep.actionRef, deliveryOperation.actionRef);
  assert.deepEqual(deliveryStep.objectRefs, deliveryOperation.domainObjectRefs);
  assert.deepEqual(deliveryStep.stateRefs, deliveryOperation.stateRefs);
  assert.equal(deliveryStep.authorityRef, ".product-experience/pdp-1-domain-data/authority.yaml#ownership.privilegedEffects");
  assert.equal(deliveryStep.bindingStatus.objectRefs, "exact artifact-version request and delivery-outcome identity");
  assert.equal(deliveryStep.bindingStatus.canonicalOperationRef, `${deliveryOperation.id}; request receipt only`);
  assert.equal(deliveryStep.bindingStatus.stateRefs, "no Media state transition; destination acknowledgment is separate");
  assert.equal(deliveryStep.bindingStatus.authorityRef, "identity and privileged-effect authority must be rechecked");
  assert.equal(deliveryStep.stepDefinitionSemantics.canonicalBindings.canonicalOperationRef, deliveryOperation.id);
  assert.deepEqual(deliveryStep.stepDefinitionSemantics.canonicalBindings.objectRefs, deliveryOperation.domainObjectRefs);
  assert.deepEqual(deliveryStep.stepDefinitionSemantics.canonicalBindings.stateRefs, deliveryOperation.stateRefs);
  assert.ok(deliveryOperation.authorityRefs.includes(
    deliveryStep.stepDefinitionSemantics.canonicalBindings.authorityRef),
  "J22 delivery canonical binding authority must resolve to one of the P1 operation authorities");
  assert.equal(deliveryStep.stepDefinitionSemantics.canonicalBindings.authorityRef,
    ".product-experience/pdp-1-domain-data/authority.yaml#ownership.privilegedEffects");
  assert.equal(deliveryStep.stepDefinitionSemantics.action.runtimeAdmission, "NOT_ADMITTED");
  assert.deepEqual(deliveryStep.stepDefinitionSemantics.action.exactOperationRefs, [deliveryOperation.id]);
}

function validateBoundedJ22DeliverySuccessDefinition(journey) {
  assert.equal(journey.journeyId, "J-22");
  const step = journey.steps[1];
  const operationId = "media.operation.action.deliver-exact-version";
  const resultRef = ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.action.deliver-exact-version/resultSchema";
  const operation = readYaml(".product-experience/pdp-1-domain-data/operations.yaml").ownerDefinedOperationContracts.records
    .find(({ id }) => id === operationId);
  assert.ok(operation, `${operationId} must resolve to the P1 owner-defined delivery contract`);
  assert.equal(operation.operationKind, "COMMAND");
  assert.deepEqual(operation.domainObjectRefs, ["media.domain.artifact-version", "media.domain.delivery-outcome"]);
  assert.deepEqual(operation.resultSchema.fields,
    ["requestId", "deliveryRequestId", "artifactVersionId", "destinationRef", "ownerReceipt", "observedAt"]);
  assert.equal(operation.resultSchema.unknown,
    "submission/acknowledgment is unknown until authoritative destination evidence; never claim delivery from dispatch");
  assert.equal(operation.resultSchemaRef, "media.operation-profile.governed-external-effect.v1#resultEnvelope");
  assert.match(operation.scopeStatus, /runtime-NOT_ADMITTED/u);
  assert.equal(step.success.status, "EXACT_OPERATION_RESULT_DEFINED");
  assert.equal(step.success.scope, "immediate-step-result");
  assert.equal(step.success.sourceRef, resultRef);
  assert.equal(step.success.resultSchemaRef, resultRef);
  assert.equal(step.success.operationRef, operation.id);
  assert.equal(step.success.meaning,
    "Immediate result is the delivery request/owner receipt for the exact artifactVersionId and destinationRef; destination delivery remains UNKNOWN until authoritative destination evidence.");
  assert.equal(step.success.evidenceBoundary,
    "definition-grade operation contract only; runtimeAdmission NOT_ADMITTED and no owner evidence/result is asserted");
  assert.equal(step.success.laterJourneyOutcomeRef,
    ".product-experience/pdp-3-product-experience/journey-contracts/deliver-export-with-destination-acknowledgement.yaml#/terminalSuccess");
  assert.equal(step.bindingStatus.success,
    `step-scoped immediate result defined by ${resultRef}; later journey outcome remains separate`);
  assert.equal(step.degradedBehavior.status, "SOURCE_BACKED_UNKNOWN_OR_PARTIAL_HOLD");
  assert.equal(step.degradedBehavior.sourceRef, resultRef);
  assert.equal(step.degradedBehavior.conditionSourceRef,
    ".product-experience/pdp-0-product-truth/journey-catalog.yaml#journeys/@id=J-22/criticalNonhappyPaths");
  assert.equal(step.degradedBehavior.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.degradedBehavior.dispatch, "NEVER");
  assert.equal(step.degradedBehavior.ownerAcceptedOutcomeOracle, false);
  assert.equal(step.bindingStatus.degradedBehavior,
    `source-backed immediate-step degraded disposition defined by ${resultRef}`);
  assert.equal(step.stepDefinitionSemantics.action.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.verification.status, "not-run");
  assert.deepEqual(step.verification.actualEvidence, []);
}

function validateBoundedJ22JobStatusSuccessDefinition(journey) {
  assert.equal(journey.journeyId, "J-22");
  const step = journey.steps[2];
  const actionId = "media.action.view-job-status";
  const operationId = "media.operation.action.view-job-status";
  const resultRef = ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationProfiles/profiles/@id=media.operation-profile.scoped-query.v1/resultEnvelope";
  const operations = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");
  const action = readYaml(".product-experience/pdp-3-product-experience/action-registry.yaml").actions
    .find(({ id }) => id === actionId);
  const operation = operations.ownerDefinedOperationContracts.records.find(({ id }) => id === operationId);
  const profile = operations.ownerDefinedOperationProfiles.profiles.find(({ id }) => id === "media.operation-profile.scoped-query.v1");
  assert.ok(action, `${actionId} must resolve to the exact action definition`);
  assert.ok(operation, `${operationId} must resolve to the exact P1 query definition`);
  assert.ok(profile, "the scoped-query profile must resolve to its P1 owner definition");
  assert.equal(action.actionDefinitionSemantics.actionRef, actionId);
  assert.equal(action.actionDefinitionSemantics.typedDefinition.effectKind, "read-only-observation-query-binding-unresolved");
  assert.deepEqual(action.actionDefinitionSemantics.typedDefinition.exactOperationRefs, [operationId]);
  assert.equal(action.actionDefinitionSemantics.typedDefinition.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(operation.operationKind, "QUERY");
  assert.equal(operation.actionRef, actionId);
  assert.equal(operation.profileRef, profile.id);
  assert.deepEqual(operation.domainObjectRefs, ["media.domain.project", "media.domain.artifact-version", "media.domain.processing-job"]);
  assert.deepEqual(step.objectRefs, operation.domainObjectRefs);
  assert.deepEqual(step.stateRefs, operation.stateRefs);
  assert.deepEqual(operation.stateRefs, []);
  assert.deepEqual(step.stepDefinitionSemantics.canonicalBindings.objectRefs, operation.domainObjectRefs);
  assert.deepEqual(step.stepDefinitionSemantics.canonicalBindings.stateRefs, operation.stateRefs);
  assert.deepEqual(operation.authorityRefs, [
    ".product-experience/pdp-1-domain-data/authority.yaml#ownership.identityAuthenticationAndDelegation",
    ".product-experience/pdp-1-domain-data/authority.yaml#ownership.privilegedEffects",
  ]);
  assert.equal(step.authorityRef, null);
  assert.deepEqual(step.stepDefinitionSemantics.canonicalBindings.authorityRefs, operation.authorityRefs);
  assert.equal(step.canonicalOperationRef, operationId);
  assert.deepEqual(step.stepDefinitionSemantics.action.exactOperationRefs, [operationId]);
  assert.equal(step.stepDefinitionSemantics.action.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(operation.resultSchemaRef, `${profile.id}#resultEnvelope`);
  assert.deepEqual(operation.resultSchema.fields, ["requestId", "exactTargetRef", "ownerReceipt", "observedAt"]);
  assert.equal(operation.resultSchema.finality, "profile-specific durable or owner receipt only; no unstated downstream effect is implied");
  assert.deepEqual(profile.resultEnvelope.fields, ["typed observations", "observedAt"]);
  assert.equal(profile.resultEnvelope.absence, "scoped absence only; never global absence or proof of no prior effect");
  assert.equal(profile.resultEnvelope.freshness, "observation timestamp, no write precondition");
  assert.equal(operation.sourceFinality, "read-only");
  assert.match(operation.scopeStatus, /runtime-NOT_ADMITTED/u);
  assert.equal(step.success.status, "EXACT_OPERATION_RESULT_DEFINED");
  assert.equal(step.success.scope, "immediate-step-result");
  assert.equal(step.success.sourceRef, resultRef);
  assert.equal(step.success.resultSchemaRef, resultRef);
  assert.equal(step.success.operationRef, operationId);
  assert.equal(step.success.meaning,
    "Immediate result is the exact-target scoped owner observation with requestId, exactTargetRef, ownerReceipt and observedAt. Missing/stale/unavailable evidence is UNKNOWN; absence is scoped only and this read implies no command effect or replay.");
  assert.equal(step.success.evidenceBoundary,
    "definition-grade operation contract only; runtimeAdmission NOT_ADMITTED and no owner evidence/result is asserted");
  assert.equal(step.success.laterJourneyOutcomeRef,
    ".product-experience/pdp-3-product-experience/journey-contracts/deliver-export-with-destination-acknowledgement.yaml#/terminalSuccess");
  assert.equal(step.bindingStatus.success,
    `step-scoped immediate result defined by ${resultRef}; later journey outcome remains separate`);
  assert.equal(step.degradedBehavior.ownerAcceptedOutcomeOracle, false);
  assert.equal(step.degradedBehavior.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.verification.status, "not-run");
  assert.deepEqual(step.verification.actualEvidence, []);
}

function validateBoundedJ22JobStatusDegradedDefinition(journey) {
  assert.equal(journey.journeyId, "J-22");
  const step = journey.steps[2];
  const resultRef = ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationProfiles/profiles/@id=media.operation-profile.scoped-query.v1/resultEnvelope";
  const conditionRef = ".product-experience/pdp-0-product-truth/journey-catalog.yaml#journeys/@id=J-22/criticalNonhappyPaths";
  const operations = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");
  const profile = operations.ownerDefinedOperationProfiles.profiles.find(({ id }) => id === "media.operation-profile.scoped-query.v1");
  const operation = operations.ownerDefinedOperationContracts.records.find(({ id }) => id === "media.operation.action.view-job-status");
  assert.ok(profile && operation, "the exact scoped query and operation must resolve");
  assert.equal(operation.resultSchemaRef, `${profile.id}#resultEnvelope`);
  assert.deepEqual(operation.resultSchema.fields, ["requestId", "exactTargetRef", "ownerReceipt", "observedAt"]);
  assert.equal(operation.sourceFinality, "read-only");
  assert.equal(profile.resultEnvelope.absence, "scoped absence only; never global absence or proof of no prior effect");
  assert.equal(profile.resultEnvelope.freshness, "observation timestamp, no write precondition");
  assert.equal(profile.recovery, "bounded read-only re-observation with the same selector; never command replay");
  assert.equal(profile.finality, "read-only observation; no state mutation, external effect, or authorization grant");
  assert.equal(step.degradedBehavior.status, "SOURCE_BACKED_UNKNOWN_OR_PARTIAL_HOLD");
  assert.equal(step.degradedBehavior.sourceRef, resultRef);
  assert.equal(step.degradedBehavior.conditionSourceRef, conditionRef);
  assert.equal(step.degradedBehavior.disposition,
    "Unavailable, missing, stale, or target-mismatched owner evidence is UNKNOWN; preserve exact target and label stale/unknown, infer neither global absence nor downstream effect, and reobserve the same selector only. No command replay.");
  assert.equal(step.degradedBehavior.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.degradedBehavior.dispatch, "NEVER");
  assert.equal(step.degradedBehavior.ownerAcceptedOutcomeOracle, false);
  assert.equal(step.bindingStatus.degradedBehavior,
    `source-backed immediate-step degraded disposition defined by ${resultRef}`);
  assert.equal(step.stepDefinitionSemantics.action.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.verification.status, "not-run");
  assert.deepEqual(step.verification.actualEvidence, []);
}

function validateBoundedJ28LocalEligibilityDefinition(journey) {
  assert.equal(journey.journeyId, "J-28");
  const step = journey.steps[0];
  const actionId = "media.action.add-scene-entity";
  const effectId = "media.local-step-effect.j-28.step-01.v1";
  const effectRef = `.product-experience/pdp-3-product-experience/local-step-effect-contracts.yaml#records/@id=${effectId}`;
  const action = readYaml(".product-experience/pdp-3-product-experience/action-registry.yaml").actions
    .find(({ id }) => id === actionId);
  const effect = readYaml(".product-experience/pdp-3-product-experience/local-step-effect-contracts.yaml").records
    .find(({ id }) => id === effectId);
  assert.ok(action, `${actionId} must resolve to the exact source action`);
  assert.ok(effect, `${effectId} must resolve to the exact local effect contract`);
  assert.equal(step.view, "media.view.compose-scene");
  assert.equal(step.actionRef, actionId);
  assert.equal(action.actionDefinitionSemantics.actionRef, actionId);
  assert.equal(action.actionDefinitionSemantics.typedDefinition.semanticRole, "LOCAL_SELECTION_OR_SESSION_DRAFT");
  assert.equal(action.actionDefinitionSemantics.typedDefinition.effectKind, "local-selection-or-session-draft");
  assert.equal(action.actionDefinitionSemantics.typedDefinition.domainOperationDisposition,
    "NO_DOMAIN_OPERATION_LOCAL_SELECTION_OR_SESSION_DRAFT");
  assert.deepEqual(action.actionDefinitionSemantics.typedDefinition.exactOperationRefs, []);
  assert.equal(action.actionDefinitionSemantics.typedDefinition.operationRef, null);
  assert.deepEqual(action.actionDefinitionSemantics.typedDefinition.orderedOperationRefs, []);
  assert.equal(action.actionDefinitionSemantics.typedDefinition.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.canonicalOperationRef, null);
  assert.deepEqual(step.objectRefs, []);
  assert.deepEqual(step.stateRefs, []);
  assert.equal(effect.sourceRef,
    ".product-experience/pdp-3-product-experience/journey-contracts/export-spatial-media-with-format-loss-reporting.yaml#/steps/0");
  assert.equal(effect.journeyRef, "J-28");
  assert.equal(effect.ordinal, 1);
  assert.equal(effect.actionRef, actionId);
  assert.equal(effect.effectMode, "DRAFT_PATCH");
  assert.deepEqual(effect.exactOperationRefs, []);
  assert.deepEqual(effect.canonicalDomainObjectRefs, []);
  assert.equal(effect.canonicalTransitionRef, null);
  assert.equal(effect.decisionRef, ".product-experience/decision-log.md#PXD-119");
  assert.equal(effect.inputContract.effectBoundary,
    "Accepting this request only makes a local editor-session patch eligible; the evaluator does not mutate the session or dispatch any canonical operation.");
  assert.deepEqual(effect.effect, {
    scope: "current local editor-session draft only",
    mutation: "replace only the declared local draft slot value",
    revision: "advance local draft revision exactly once under expectedDraftRevision compare-and-set",
    committedMediaObjects: "unchanged",
    remoteDispatch: "none",
  });
  assert.match(effect.finality, /^LOCAL_DRAFT_REVISION_ONLY; no project revision, artifact version, job, remote effect, or committed result is established$/u);
  assert.equal(effect.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(effect.canonicalIdentityDisposition, "NO_PDP1_CANONICAL_PRODUCT_OBJECT_OR_TRANSITION");
  assert.equal(step.success.status, "STEP_RESULT_DEFINED");
  assert.equal(step.success.scope, "immediate-step-result");
  assert.equal(step.success.sourceRef, effectRef);
  assert.equal(step.success.meaning,
    "This step may establish only source-contract local patch eligibility; it does not apply or persist a patch.");
  assert.equal(step.success.evidenceBoundary,
    "definition-grade only; no runtime execution, owner evidence, or applied patch is claimed");
  assert.equal(step.success.laterJourneyOutcomeRef,
    ".product-experience/pdp-3-product-experience/journey-contracts/export-spatial-media-with-format-loss-reporting.yaml#/terminalSuccess");
  assert.equal(step.bindingStatus.success,
    `step-scoped immediate result defined by ${effectRef}; later journey outcome remains separate`);
  assert.equal(step.stepDefinitionSemantics.canonicalBindings.canonicalOperationRef, null);
  assert.deepEqual(step.stepDefinitionSemantics.action.exactOperationRefs, []);
  assert.equal(step.stepDefinitionSemantics.action.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.stepDefinitionSemantics.stepSourceFacts.success.sourceRef, effectRef);
  assert.equal(step.stepDefinitionSemantics.stepSourceFacts.success.status, "STEP_RESULT_DEFINED");
  assert.equal(step.stepDefinitionSemantics.stepSourceFacts.success.meaning,
    "This step may establish only source-contract local patch eligibility; it does not apply or persist a patch.");
  assert.equal(step.stepDefinitionSemantics.stepSourceFacts.success.evidenceBoundary,
    "definition-grade only; no runtime execution, owner evidence, or applied patch is claimed");
  assert.equal(step.stepDefinitionSemantics.stepSourceFacts.resultDisposition, "SOURCE_BOUND_IMMEDIATE_RESULT");
  assert.deepEqual(step.stepDefinitionSemantics.stepSourceFacts.resultSourceRef, [
    `${effectRef}/inputContract/effectBoundary`,
  ]);
  assert.equal(step.stepDefinitionSemantics.verification.status, "not-run");
  assert.deepEqual(step.stepDefinitionSemantics.verification.actualEvidence, []);
  assert.equal(step.stepDefinitionSemantics.action.actionDefinitionDecisionRef,
    ".product-experience/decision-log.md#PXD-075");
}

function validateBoundedSubmitRenderOutcomeDefinition(journey, { journeyId, stepIndex, laterOutcomeRef, criticalNonhappyPathRef }) {
  assert.equal(journey.journeyId, journeyId);
  const step = journey.steps[stepIndex];
  const resultRef = ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.action.submit-render/resultSchema";
  const operation = readYaml(".product-experience/pdp-1-domain-data/operations.yaml").ownerDefinedOperationContracts.records
    .find(({ id }) => id === "media.operation.action.submit-render");
  const asyncProfile = readYaml(".product-experience/pdp-1-domain-data/operations.yaml").ownerDefinedOperationProfiles.profiles
    .find(({ id }) => id === "media.operation-profile.async-job-command.v1");
  assert.ok(operation, "the exact source-owned render command must resolve");
  assert.ok(asyncProfile, "the exact async command profile must resolve");
  assert.equal(step.view, "media.view.prepare-render");
  assert.equal(step.actionRef, "media.action.submit-render");
  assert.equal(step.canonicalOperationRef, operation.id);
  assert.deepEqual(operation.resultSchema.fields, [
    "requestId", "logicalJobId", "sourceSnapshotDigest", "renderProfileRef", "durableAdmissionReceipt",
  ]);
  assert.equal(operation.resultSchema.finality,
    "only durable job admission is confirmed; render completion and delivery require separate observations");
  assert.match(operation.scopeStatus, /independent-PDP1-and-PDP3-review-open/u);
  assert.match(operation.scopeStatus, /transport\/runtime-NOT_ADMITTED/u);
  assert.equal(operation.profileRef, asyncProfile.id);
  assert.ok(asyncProfile.errors.includes("UNKNOWN_OUTCOME"));
  assert.equal(asyncProfile.recovery,
    "same request identity reconciliation precedes any retry; unknown is neither success nor failure; retries require an eligible new fenced attempt under retry-job");
  assert.equal(asyncProfile.finality,
    "durable request acceptance only; model result, output, or delivery is not claimed");

  assert.equal(step.success.status, "EXACT_OPERATION_RESULT_DEFINED");
  assert.equal(step.success.scope, "immediate-step-result");
  assert.equal(step.success.sourceRef, resultRef);
  assert.equal(step.success.resultSchemaRef, resultRef);
  assert.equal(step.success.operationRef, operation.id);
  assert.match(step.success.meaning, /^Immediate result is durable job admission only/u);
  assert.match(step.success.meaning, /render completion and delivery are separate later observations/u);
  assert.match(step.success.evidenceBoundary, /definition-grade operation contract only/u);
  assert.match(step.success.evidenceBoundary, /runtimeAdmission NOT_ADMITTED/u);
  assert.match(step.success.evidenceBoundary, /no owner evidence\/result is asserted/u);
  assert.equal(step.success.laterJourneyOutcomeRef, laterOutcomeRef);
  assert.equal(step.bindingStatus.success,
    `step-scoped immediate result defined by ${resultRef}; later journey outcome remains separate`);
  assert.equal(step.degradedBehavior.status, "SOURCE_BACKED_UNKNOWN_OR_PARTIAL_HOLD");
  assert.equal(step.degradedBehavior.sourceRef, resultRef);
  assert.equal(step.degradedBehavior.conditionSourceRef, criticalNonhappyPathRef);
  assert.match(step.degradedBehavior.disposition, /^UNKNOWN_OUTCOME holds; preserve request identity and reconcile the same request before any retry/u);
  assert.match(step.degradedBehavior.disposition, /Do not infer success, completion, persistence, or delivery; no blind replay\.$/u);
  assert.equal(step.degradedBehavior.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.degradedBehavior.dispatch, "NEVER");
  assert.equal(step.degradedBehavior.ownerAcceptedOutcomeOracle, false);
  assert.equal(step.bindingStatus.degradedBehavior,
    `source-backed immediate-step degraded disposition defined by ${resultRef}`);
  assert.equal(step.stepDefinitionSemantics.ownerDefinitionDecisionRef, ".product-experience/decision-log.md#PXD-075");
  assert.equal(step.stepDefinitionSemantics.action.actionDefinitionDecisionRef, ".product-experience/decision-log.md#PXD-075");
  assert.equal(step.stepDefinitionSemantics.action.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.stepDefinitionSemantics.stepSourceFacts.success.sourceRef, resultRef);
  assert.equal(step.stepDefinitionSemantics.stepSourceFacts.success.evidenceBoundary, step.success.evidenceBoundary);
  assert.equal(step.verification.status, "not-run");
  assert.deepEqual(step.verification.actualEvidence, []);
  assert.equal(step.recovery.status, "candidate-proposal");
  assert.match(step.bindingStatus.recovery, /candidate-proposal-only/u);

  for (const field of ["authorityRef", "decisionRef", "transitionRef", "handoffRef"]) {
    assert.equal(step[field], null, `${field} remains unbound`);
  }
  assert.match(step.bindingStatus.authorityRef, /pending/u);
  assert.match(step.bindingStatus.decisionRef, /pending/u);
  assert.match(step.bindingStatus.transitionRef, /pending/u);
  assert.match(step.bindingStatus.handoffRef, /pending/u);
}

function validateBoundedJ28DestinationSelectionDefinition(journey) {
  assert.equal(journey.journeyId, "J-28");
  const step = journey.steps[3];
  const effectId = "media.local-step-effect.j-28.step-04.v1";
  const effectRef = `.product-experience/pdp-3-product-experience/local-step-effect-contracts.yaml#records/@id=${effectId}`;
  const effect = readYaml(".product-experience/pdp-3-product-experience/local-step-effect-contracts.yaml").records
    .find(({ id }) => id === effectId);
  assert.ok(effect, "the exact source-owned local destination-selection contract must resolve");
  assert.equal(step.view, "media.view.deliver-output");
  assert.equal(step.actionRef, "media.action.choose-named-destination");
  assert.equal(step.canonicalOperationRef, null);
  assert.deepEqual(step.objectRefs, []);
  assert.deepEqual(step.stateRefs, []);
  assert.equal(effect.sourceRef,
    ".product-experience/pdp-3-product-experience/journey-contracts/export-spatial-media-with-format-loss-reporting.yaml#/steps/3");
  assert.equal(effect.journeyRef, "J-28");
  assert.equal(effect.ordinal, 4);
  assert.equal(effect.actionRef, step.actionRef);
  assert.equal(effect.effectMode, "CATALOG_SELECTION");
  assert.deepEqual(effect.exactOperationRefs, []);
  assert.deepEqual(effect.canonicalDomainObjectRefs, []);
  assert.equal(effect.canonicalTransitionRef, null);
  assert.equal(effect.decisionRef, ".product-experience/decision-log.md#PXD-119");
  assert.equal(effect.inputContract.mutation.kind, "SELECT_CATALOG_ENTRY");
  assert.equal(effect.inputContract.mutation.eligibilityPredicate, "exact-current-destination-catalog-member");
  assert.match(effect.inputContract.effectBoundary, /only makes a local editor-session patch eligible/u);
  assert.match(effect.inputContract.effectBoundary, /does not mutate the session or dispatch any canonical operation/u);
  assert.equal(effect.finality,
    "LOCAL_DRAFT_REVISION_ONLY; no project revision, artifact version, job, remote effect, or committed result is established");
  assert.equal(effect.runtimeAdmission, "NOT_ADMITTED");

  assert.equal(step.success.status, "STEP_RESULT_DEFINED");
  assert.equal(step.success.scope, "immediate-step-result");
  assert.equal(step.success.sourceRef, effectRef);
  assert.equal(step.success.meaning,
    "This step may establish only source-contract local patch eligibility; it does not apply or persist a patch.");
  assert.match(step.success.evidenceBoundary, /definition-grade only; no runtime execution, owner evidence/u);
  assert.equal(step.success.laterJourneyOutcomeRef,
    ".product-experience/pdp-3-product-experience/journey-contracts/export-spatial-media-with-format-loss-reporting.yaml#/terminalSuccess");
  assert.equal(step.bindingStatus.success,
    `step-scoped immediate result defined by ${effectRef}; later journey outcome remains separate`);
  assert.equal(step.degradedBehavior.status, "SOURCE_BACKED_UNKNOWN_OR_PARTIAL_HOLD");
  assert.equal(step.degradedBehavior.sourceRef, effectRef);
  assert.equal(step.degradedBehavior.conditionSourceRef,
    ".product-experience/pdp-0-product-truth/journey-catalog.yaml#journeys/@id=J-28/criticalNonhappyPaths");
  assert.match(step.degradedBehavior.disposition, /stale, missing, or unknown, HOLD without applying a patch or replay/u);
  assert.match(step.degradedBehavior.disposition, /evaluator result is eligibility only, not an applied edit/u);
  assert.equal(step.degradedBehavior.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.degradedBehavior.dispatch, "NEVER");
  assert.equal(step.degradedBehavior.ownerAcceptedOutcomeOracle, false);
  assert.equal(step.bindingStatus.degradedBehavior,
    `source-backed immediate-step degraded disposition defined by ${effectRef}`);
  assert.equal(step.stepDefinitionSemantics.ownerDefinitionDecisionRef, ".product-experience/decision-log.md#PXD-075");
  assert.equal(step.stepDefinitionSemantics.action.actionDefinitionDecisionRef, ".product-experience/decision-log.md#PXD-075");
  assert.equal(step.stepDefinitionSemantics.action.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.stepDefinitionSemantics.stepSourceFacts.success.sourceRef, effectRef);
  assert.equal(step.stepDefinitionSemantics.stepSourceFacts.resultDisposition, "SOURCE_BOUND_IMMEDIATE_RESULT");
  assert.equal(step.verification.status, "not-run");
  assert.deepEqual(step.verification.actualEvidence, []);
  assert.equal(step.recovery.status, "candidate-proposal");
  assert.match(step.bindingStatus.recovery, /candidate-proposal-only/u);

  for (const field of ["authorityRef", "decisionRef", "transitionRef", "handoffRef"]) {
    assert.equal(step[field], null, `${field} remains unbound`);
  }
  for (const field of ["objectRefs", "stateRefs", "authorityRef", "decisionRef", "transitionRef", "handoffRef"]) {
    assert.match(step.bindingStatus[field], /pending/u, `${field} remains pending`);
  }
}

function validateBoundedJ28LocalEligibilityDegradedDefinition(journey) {
  validateBoundedJ28LocalEligibilityDefinition(journey);
  const step = journey.steps[0];
  const effectRef = ".product-experience/pdp-3-product-experience/local-step-effect-contracts.yaml#records/@id=media.local-step-effect.j-28.step-01.v1";
  const conditionRef = ".product-experience/pdp-0-product-truth/journey-catalog.yaml#journeys/@id=J-28/criticalNonhappyPaths";
  const effect = readYaml(".product-experience/pdp-3-product-experience/local-step-effect-contracts.yaml").records
    .find(({ id }) => id === "media.local-step-effect.j-28.step-01.v1");
  const degraded = step.degradedBehavior;
  const sourceFacts = step.stepDefinitionSemantics.stepSourceFacts.degradedBehavior;
  assert.equal(effect.inputContract.effectBoundary,
    "Accepting this request only makes a local editor-session patch eligible; the evaluator does not mutate the session or dispatch any canonical operation.");
  assert.match(effect.failureRecovery,
    /^on denial preserve current local revision; on stale or unknown session\/read evidence hold without applying or replaying;/u);
  assert.equal(degraded.status, "SOURCE_BACKED_UNKNOWN_OR_PARTIAL_HOLD");
  assert.equal(degraded.sourceRef, effectRef);
  assert.equal(degraded.conditionSourceRef, conditionRef);
  assert.equal(degraded.disposition,
    "If the active local session/catalog is stale, missing, or unknown, HOLD without applying a patch or replay; denial preserves the local revision. The evaluator result is eligibility only, not an applied edit.");
  assert.equal(degraded.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(degraded.dispatch, "NEVER");
  assert.equal(degraded.ownerAcceptedOutcomeOracle, false);
  assert.equal(step.bindingStatus.degradedBehavior,
    `source-backed immediate-step degraded disposition defined by ${effectRef}`);
  assert.deepEqual(sourceFacts, degraded);
  assert.equal(step.stepDefinitionSemantics.action.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.stepDefinitionSemantics.canonicalBindings.canonicalOperationRef, null);
  assert.deepEqual(step.stepDefinitionSemantics.canonicalBindings.objectRefs, []);
  assert.deepEqual(step.stepDefinitionSemantics.canonicalBindings.stateRefs, []);
  assert.equal(step.stepDefinitionSemantics.verification.status, "not-run");
  assert.deepEqual(step.stepDefinitionSemantics.verification.actualEvidence, []);
}

function validateBoundedJ28KeyframeEligibilityDefinition(journey) {
  const step = journey.steps[1];
  const actionId = "media.action.edit-keyframe";
  const effectId = "media.local-step-effect.j-28.step-02.v1";
  const effectRef = `.product-experience/pdp-3-product-experience/local-step-effect-contracts.yaml#records/@id=${effectId}`;
  const action = readYaml(".product-experience/pdp-3-product-experience/action-registry.yaml").actions
    .find(({ id }) => id === actionId);
  const effect = readYaml(".product-experience/pdp-3-product-experience/local-step-effect-contracts.yaml").records
    .find(({ id }) => id === effectId);
  assert.ok(action, `${actionId} must resolve to the exact source action`);
  assert.ok(effect, `${effectId} must resolve to the exact local effect contract`);
  assert.equal(step.view, "media.view.animate-media");
  assert.equal(step.actionRef, actionId);
  assert.equal(action.actionDefinitionSemantics.actionRef, actionId);
  assert.equal(action.actionDefinitionSemantics.typedDefinition.semanticRole, "LOCAL_SELECTION_OR_SESSION_DRAFT");
  assert.equal(action.actionDefinitionSemantics.typedDefinition.domainOperationDisposition,
    "NO_DOMAIN_OPERATION_LOCAL_SELECTION_OR_SESSION_DRAFT");
  assert.deepEqual(action.actionDefinitionSemantics.typedDefinition.exactOperationRefs, []);
  assert.equal(action.actionDefinitionSemantics.typedDefinition.operationRef, null);
  assert.deepEqual(action.actionDefinitionSemantics.typedDefinition.orderedOperationRefs, []);
  assert.equal(action.actionDefinitionSemantics.typedDefinition.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.canonicalOperationRef, null);
  assert.deepEqual(step.objectRefs, []);
  assert.deepEqual(step.stateRefs, []);
  assert.equal(effect.sourceRef,
    ".product-experience/pdp-3-product-experience/journey-contracts/export-spatial-media-with-format-loss-reporting.yaml#/steps/1");
  assert.equal(effect.journeyRef, "J-28");
  assert.equal(effect.ordinal, 2);
  assert.equal(effect.actionRef, actionId);
  assert.equal(effect.effectMode, "DRAFT_PATCH");
  assert.equal(effect.localDraftSlotRef, "media.local-draft.slot.timeline-keyframes");
  assert.deepEqual(effect.exactOperationRefs, []);
  assert.deepEqual(effect.canonicalDomainObjectRefs, []);
  assert.equal(effect.canonicalTransitionRef, null);
  assert.deepEqual(effect.inputContract.mutation.valueSchemaRefs, ["media.component-value-types.v1#/$defs/Keyframe"]);
  assert.equal(effect.inputContract.effectBoundary,
    "Accepting this request only makes a local editor-session patch eligible; the evaluator does not mutate the session or dispatch any canonical operation.");
  assert.deepEqual(effect.effect, {
    scope: "current local editor-session draft only",
    mutation: "replace only the declared local draft slot value",
    revision: "advance local draft revision exactly once under expectedDraftRevision compare-and-set",
    committedMediaObjects: "unchanged",
    remoteDispatch: "none",
  });
  assert.match(effect.finality, /^LOCAL_DRAFT_REVISION_ONLY; no project revision, artifact version, job, remote effect, or committed result is established$/u);
  assert.equal(effect.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(effect.canonicalIdentityDisposition, "NO_PDP1_CANONICAL_PRODUCT_OBJECT_OR_TRANSITION");
  assert.equal(step.success.status, "STEP_RESULT_DEFINED");
  assert.equal(step.success.scope, "immediate-step-result");
  assert.equal(step.success.sourceRef, effectRef);
  assert.equal(step.success.meaning,
    "This step may establish only source-contract local patch eligibility; it does not apply or persist a patch.");
  assert.equal(step.success.evidenceBoundary,
    "definition-grade only; no runtime execution, owner evidence, or applied patch is claimed");
  assert.equal(step.success.laterJourneyOutcomeRef,
    ".product-experience/pdp-3-product-experience/journey-contracts/export-spatial-media-with-format-loss-reporting.yaml#/terminalSuccess");
  assert.equal(step.bindingStatus.success,
    `step-scoped immediate result defined by ${effectRef}; later journey outcome remains separate`);
  assert.equal(step.stepDefinitionSemantics.sourceRef,
    ".product-experience/pdp-3-product-experience/journey-contracts/export-spatial-media-with-format-loss-reporting.yaml#/steps/1");
  assert.equal(step.stepDefinitionSemantics.viewRef, "media.view.animate-media");
  assert.equal(step.stepDefinitionSemantics.ordinal, 2);
  assert.equal(step.stepDefinitionSemantics.canonicalBindings.canonicalOperationRef, null);
  assert.deepEqual(step.stepDefinitionSemantics.canonicalBindings.objectRefs, []);
  assert.deepEqual(step.stepDefinitionSemantics.canonicalBindings.stateRefs, []);
  assert.equal(step.stepDefinitionSemantics.canonicalBindings.localEffectContractRef, effectRef);
  assert.equal(step.stepDefinitionSemantics.canonicalBindings.localDraftSlotRef, "media.local-draft.slot.timeline-keyframes");
  assert.equal(step.stepDefinitionSemantics.stepSourceFacts.success.sourceRef, effectRef);
  assert.equal(step.stepDefinitionSemantics.stepSourceFacts.success.meaning, step.success.meaning);
  assert.equal(step.stepDefinitionSemantics.stepSourceFacts.success.evidenceBoundary, step.success.evidenceBoundary);
  assert.equal(step.stepDefinitionSemantics.stepSourceFacts.resultDisposition, "SOURCE_BOUND_IMMEDIATE_RESULT");
  assert.deepEqual(step.stepDefinitionSemantics.stepSourceFacts.resultSourceRef, [
    `${effectRef}/inputContract/effectBoundary`,
  ]);
  assert.equal(step.stepDefinitionSemantics.action.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.stepDefinitionSemantics.transitionApplicability.operationRef, null);
  assert.equal(step.stepDefinitionSemantics.transitionApplicability.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.stepDefinitionSemantics.verification.status, "not-run");
  assert.deepEqual(step.stepDefinitionSemantics.verification.actualEvidence, []);
  // This immediate local keyframe edit makes no claim about source-free animation
  // provenance; P0's authored-versus-derived output question remains open.
  assert.match(readFileSync(resolve(root, "docs/implementation/PDP-0-3-SEQUENTIAL-DEVELOPMENT-COMPLETION-PLAN.md"), "utf8"),
    /source-free animation creation\/edit outputs mislabeled as necessarily `SOURCE_DERIVED_TRANSFORMATION`/u);
  assert.doesNotMatch(step.success.meaning, /source-derived|generated output|derivative/u);
}

function validateBoundedJ28KeyframeEligibilityDegradedDefinition(journey) {
  validateBoundedJ28KeyframeEligibilityDefinition(journey);
  const step = journey.steps[1];
  const effectId = "media.local-step-effect.j-28.step-02.v1";
  const effectRef = `.product-experience/pdp-3-product-experience/local-step-effect-contracts.yaml#records/@id=${effectId}`;
  const conditionRef = ".product-experience/pdp-0-product-truth/journey-catalog.yaml#journeys/@id=J-28/criticalNonhappyPaths";
  const effect = readYaml(".product-experience/pdp-3-product-experience/local-step-effect-contracts.yaml").records
    .find(({ id }) => id === effectId);
  const degraded = step.degradedBehavior;
  const sourceFacts = step.stepDefinitionSemantics.stepSourceFacts.degradedBehavior;
  assert.match(effect.failureRecovery,
    /^on denial preserve current local revision; on stale or unknown session\/read evidence hold without applying or replaying;/u);
  assert.equal(effect.inputContract.effectBoundary,
    "Accepting this request only makes a local editor-session patch eligible; the evaluator does not mutate the session or dispatch any canonical operation.");
  assert.equal(degraded.status, "SOURCE_BACKED_UNKNOWN_OR_PARTIAL_HOLD");
  assert.equal(degraded.sourceRef, effectRef);
  assert.equal(degraded.conditionSourceRef, conditionRef);
  assert.equal(degraded.disposition,
    "If the active local session/catalog is stale, missing, or unknown, HOLD without applying a patch or replay; denial preserves the local revision. The evaluator result is eligibility only, not an applied edit.");
  assert.equal(degraded.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(degraded.dispatch, "NEVER");
  assert.equal(degraded.ownerAcceptedOutcomeOracle, false);
  assert.equal(step.bindingStatus.degradedBehavior,
    `source-backed immediate-step degraded disposition defined by ${effectRef}`);
  assert.deepEqual(sourceFacts, degraded);
  assert.equal(step.stepDefinitionSemantics.action.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.stepDefinitionSemantics.canonicalBindings.canonicalOperationRef, null);
  assert.deepEqual(step.stepDefinitionSemantics.canonicalBindings.objectRefs, []);
  assert.deepEqual(step.stepDefinitionSemantics.canonicalBindings.stateRefs, []);
  assert.equal(step.stepDefinitionSemantics.transitionApplicability.operationRef, null);
  assert.equal(step.stepDefinitionSemantics.verification.status, "not-run");
  assert.deepEqual(step.stepDefinitionSemantics.verification.actualEvidence, []);
}

test("canonical Media product-definition authority is structurally closed locally", () => {
  const output = execFileSync(process.execPath, ["scripts/check-product-definition-authority.mjs"], { cwd: root, encoding: "utf8" });
  assert.match(output, /authority check passed/u);
});

test("bounded J-28 local eligibility result rejects a forged operation or persisted effect", () => {
  const journey = readYaml(".product-experience/pdp-3-product-experience/journey-contracts/export-spatial-media-with-format-loss-reporting.yaml");
  assert.doesNotThrow(() => validateBoundedJ28LocalEligibilityDefinition(journey));
  const forgedOperation = structuredClone(journey);
  forgedOperation.steps[0].canonicalOperationRef = "media.operation.action.inspect-output-preview-and-version";
  assert.throws(() => validateBoundedJ28LocalEligibilityDefinition(forgedOperation));
  const forgedExactOperation = structuredClone(journey);
  forgedExactOperation.steps[0].stepDefinitionSemantics.action.exactOperationRefs = ["media.operation.action.inspect-output-preview-and-version"];
  assert.throws(() => validateBoundedJ28LocalEligibilityDefinition(forgedExactOperation));
  const persistedEffect = structuredClone(journey);
  persistedEffect.steps[0].success.meaning = "This step applies and persists the local patch.";
  assert.throws(() => validateBoundedJ28LocalEligibilityDefinition(persistedEffect), /does not apply or persist/u);
});

test("bounded J-28 degraded local eligibility holds without operation, persistence, or runtime evidence", () => {
  const journey = readYaml(".product-experience/pdp-3-product-experience/journey-contracts/export-spatial-media-with-format-loss-reporting.yaml");
  assert.doesNotThrow(() => validateBoundedJ28LocalEligibilityDegradedDefinition(journey));
  const forgedOperation = structuredClone(journey);
  forgedOperation.steps[0].canonicalOperationRef = "media.operation.action.inspect-output-preview-and-version";
  assert.throws(() => validateBoundedJ28LocalEligibilityDegradedDefinition(forgedOperation));
  const persistedEffect = structuredClone(journey);
  persistedEffect.steps[0].degradedBehavior.disposition = "The evaluator applies and persists the patch.";
  assert.throws(() => validateBoundedJ28LocalEligibilityDegradedDefinition(persistedEffect));
});

test("bounded J-28 keyframe edit result is local eligibility and does not claim animation provenance", () => {
  const journey = readYaml(".product-experience/pdp-3-product-experience/journey-contracts/export-spatial-media-with-format-loss-reporting.yaml");
  assert.doesNotThrow(() => validateBoundedJ28KeyframeEligibilityDefinition(journey));
  const forgedOperation = structuredClone(journey);
  forgedOperation.steps[1].canonicalOperationRef = "media.operation.animation.render";
  assert.throws(() => validateBoundedJ28KeyframeEligibilityDefinition(forgedOperation));
  const appliedPatch = structuredClone(journey);
  appliedPatch.steps[1].success.meaning = "This step applies and persists an animation patch.";
  assert.throws(() => validateBoundedJ28KeyframeEligibilityDefinition(appliedPatch));
  const falseProvenance = structuredClone(journey);
  falseProvenance.steps[1].success.meaning = "This step establishes a source-derived animation output.";
  assert.throws(() => validateBoundedJ28KeyframeEligibilityDefinition(falseProvenance));
});

test("bounded J-28 keyframe degraded result holds without operation, persistence, or runtime evidence", () => {
  const journey = readYaml(".product-experience/pdp-3-product-experience/journey-contracts/export-spatial-media-with-format-loss-reporting.yaml");
  assert.doesNotThrow(() => validateBoundedJ28KeyframeEligibilityDegradedDefinition(journey));
  const forgedOperation = structuredClone(journey);
  forgedOperation.steps[1].canonicalOperationRef = "media.operation.animation.render";
  assert.throws(() => validateBoundedJ28KeyframeEligibilityDegradedDefinition(forgedOperation));
  const persistedEffect = structuredClone(journey);
  persistedEffect.steps[1].degradedBehavior.disposition = "The evaluator applies and persists the patch.";
  assert.throws(() => validateBoundedJ28KeyframeEligibilityDegradedDefinition(persistedEffect));
});

test("bounded J-01 source bindings fail closed on forged authority, operation, or runtime admission", () => {
  const journey = readYaml(".product-experience/pdp-3-product-experience/journey-contracts/first-use-and-project-creation.yaml");
  assert.doesNotThrow(() => validateBoundedJ01ProjectDefinitions(journey));
  const badDecision = structuredClone(journey);
  badDecision.steps[0].decisionRef = ".product-experience/decision-log.md#PXD-999";
  assert.throws(() => validateBoundedJ01ProjectDefinitions(badDecision), /decision must be exact/u);
  const badAdmission = structuredClone(journey);
  badAdmission.steps[2].definitionVerification.runtimeAdmission = "ADMITTED";
  assert.throws(() => validateBoundedJ01ProjectDefinitions(badAdmission), /cannot claim execution admission/u);
  const swappedOperation = structuredClone(journey);
  swappedOperation.steps[2].canonicalOperationRef = "media.operation-slice.inspect-project";
  assert.throws(() => validateBoundedJ01ProjectDefinitions(swappedOperation), /create-project/u);
});

test("bounded J-03 caption-version definitions fail closed on swapped action, operation, decision, or admission", () => {
  const journey = readYaml(".product-experience/pdp-3-product-experience/journey-contracts/transcribe-and-correct-captions.yaml");
  assert.doesNotThrow(() => validateBoundedJ03CaptionVersionDefinitions(journey));
  const wrongOperation = structuredClone(journey);
  wrongOperation.steps[6].canonicalOperationRef = "media.operation.caption-version-read";
  assert.throws(() => validateBoundedJ03CaptionVersionDefinitions(wrongOperation), /caption-version-write/u);
  const wrongAction = structuredClone(journey);
  wrongAction.steps[7].action = "media.action.save-caption-version";
  assert.throws(() => validateBoundedJ03CaptionVersionDefinitions(wrongAction), /compare-caption-versions/u);
  const wrongDecision = structuredClone(journey);
  wrongDecision.steps[6].decisionRef = ".product-experience/decision-log.md#PXD-059";
  assert.throws(() => validateBoundedJ03CaptionVersionDefinitions(wrongDecision), /PXD-060/u);
  const admitted = structuredClone(journey);
  admitted.steps[6].definitionVerification.runtimeAdmission = "ADMITTED";
  assert.throws(() => validateBoundedJ03CaptionVersionDefinitions(admitted), /NOT_ADMITTED/u);
});

test("bounded J-03 caption-draft definitions fail closed on action, operation, clock, undo, or admission drift", () => {
  const journey = readYaml(".product-experience/pdp-3-product-experience/journey-contracts/transcribe-and-correct-captions.yaml");
  assert.doesNotThrow(() => validateBoundedJ03CaptionDraftDefinitions(journey));

  const wrongAction = structuredClone(journey);
  wrongAction.steps[4].action = "media.action.align-caption-timing";
  assert.throws(() => validateBoundedJ03CaptionDraftDefinitions(wrongAction), /media\.action\.correct-caption/u);

  const wrongOperation = structuredClone(journey);
  wrongOperation.steps[5].canonicalOperationRef = "media.operation.caption-version-write";
  assert.throws(() => validateBoundedJ03CaptionDraftDefinitions(wrongOperation), /caption-draft-write/u);

  const clockless = structuredClone(journey);
  clockless.steps[5].draftEditSemantics.sourceClockRequirement = "infer timing from transcript text";
  assert.throws(() => validateBoundedJ03CaptionDraftDefinitions(clockless), /sourceClockId/u);

  const unsafeUndo = structuredClone(journey);
  const operationDoc = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");
  operationDoc.operations.find(({ id }) => id === "media.operation.caption-draft-write").draftSnapshotDefinition.undo = "always reversible; reset revision to prior number";
  assert.throws(() => validateBoundedJ03CaptionDraftDefinitions(unsafeUndo, { operationDoc }), /same-trusted-tenant/u);

  const admitted = structuredClone(journey);
  admitted.steps[4].definitionVerification.runtimeAdmission = "ADMITTED";
  assert.throws(() => validateBoundedJ03CaptionDraftDefinitions(admitted), /NOT_ADMITTED/u);
});

test("bounded J-03 submission fails closed on wrong operation, a fabricated state edge, or admission", () => {
  const journey = readYaml(".product-experience/pdp-3-product-experience/journey-contracts/transcribe-and-correct-captions.yaml");
  const validate = (value) => {
    const step = value.steps.find(({ stepId }) => stepId === "J03-2");
    assert.equal(step.action, "media.action.request-transcription");
    assert.equal(step.canonicalOperationRef, "media.operation.transcription-submission");
    assert.deepEqual(step.stateRefs, []);
    assert.equal(step.transitionDisposition.transitionRef, null);
    assert.equal(step.definitionVerification.runtimeAdmission, "NOT_ADMITTED");
    assert.deepEqual(step.submissionSemantics.reconcileRequiredFields, ["requestId", "requestFingerprint"]);
    assert.match(step.submissionSemantics.asynchronousBoundary, /no job state/u);
    assert.match(step.submissionSemantics.reconciliation, /does not authorize processing\/replay/u);
  };
  assert.doesNotThrow(() => validate(journey));
  const wrongOperation = structuredClone(journey);
  wrongOperation.steps[1].canonicalOperationRef = "media.operation.job-lifecycle";
  assert.throws(() => validate(wrongOperation), /transcription-submission/u);
  const stateEdge = structuredClone(journey);
  stateEdge.steps[1].stateRefs = ["media-job/QUEUED"];
  assert.throws(() => validate(stateEdge), /deepStrictEqual|Expected values/u);
  const admitted = structuredClone(journey);
  admitted.steps[1].definitionVerification.runtimeAdmission = "ADMITTED";
  assert.throws(() => validate(admitted), /NOT_ADMITTED/u);
});

test("bounded J-03 transcript review fails closed on wrong identity, source, operation, or admission", () => {
  const journey = readYaml(".product-experience/pdp-3-product-experience/journey-contracts/transcribe-and-correct-captions.yaml");
  assert.doesNotThrow(() => validateBoundedJ03TranscriptReviewDefinition(journey));
  const wrongOperation = structuredClone(journey);
  wrongOperation.steps[3].canonicalOperationRef = "media.operation.caption-version-read";
  assert.throws(() => validateBoundedJ03TranscriptReviewDefinition(wrongOperation), /transcript-version-read/u);
  const wrongIdentity = structuredClone(journey);
  wrongIdentity.steps[3].objectRefs = ["media.domain.transcription", "media.domain.artifact-version"];
  assert.throws(() => validateBoundedJ03TranscriptReviewDefinition(wrongIdentity), /deepStrictEqual|Expected values/u);
  const wrongSource = structuredClone(journey);
  wrongSource.steps[3].sourceDecisionRef = ".product-experience/decision-log.md#PXD-060";
  assert.throws(() => validateBoundedJ03TranscriptReviewDefinition(wrongSource), /PXD-062/u);
  const wrongDecision = structuredClone(journey);
  wrongDecision.steps[3].decisionRef = ".product-experience/decision-log.md#PXD-063";
  assert.throws(() => validateBoundedJ03TranscriptReviewDefinition(wrongDecision), /PXD-064/u);
  const admitted = structuredClone(journey);
  admitted.steps[3].definitionVerification.runtimeAdmission = "ADMITTED";
  assert.throws(() => validateBoundedJ03TranscriptReviewDefinition(admitted), /NOT_ADMITTED/u);
});

test("PDP3 screen registry has 47 structurally complete v2 canonical screen proposals", () => {
  const experienceRoot = resolve(root, ".product-experience/pdp-3-product-experience");
  const registry = readFileSync(resolve(experienceRoot, "screen-registry.yaml"), "utf8");
  const schemaPath = ".product-experience/pdp-3-product-experience/screen-contract-schema.yaml";
  const schema = readFileSync(resolve(root, schemaPath), "utf8");
  const requiredFields = [
    "contractSchemaRef", "surfaceId", "templateId", "layoutIds", "componentIds", "patternIds",
    "tokenDependencies", "domainObjectRefs", "operationRefs", "stateRefs", "entry", "exit",
    "actionConsequences", "responsiveBehavior", "fixtures", "verification", "fieldBindingStatus",
  ];
  assert.match(registry, new RegExp(`^contractSchemaRef: ${schemaPath.replaceAll(".", "\\.")}$`, "mu"));
  assert.match(schema, /^contractVersion: media\.screen-contract\.v2$/mu);
  for (const field of requiredFields) assert.ok(schema.includes(`  - ${field}\n`), `schema missing required field ${field}`);

  const screenRecords = [...registry.matchAll(/^- id: (media\.view\.[^\n]+)\n([\s\S]*?)(?=^- id: |^coverage:|^contextualSpecializations:|$(?![\s\S]))/gmu)];
  assert.equal(screenRecords.length, 47, "canonical screen registry denominator must remain 47");
  const screenIds = screenRecords.map(([, id]) => id);
  assert.equal(new Set(screenIds).size, 47, "canonical screen IDs must be unique");
  const templateCatalog = readFileSync(resolve(root, ".product-experience/pdp-2-design-interface-system/gui/templates/catalog.yaml"), "utf8");
  const knownTemplates = new Set([...templateCatalog.matchAll(/^  - id: ([^\n]+)$/gmu)].map(([, id]) => id));
  const actionRegistry = readYaml(".product-experience/pdp-3-product-experience/action-registry.yaml");
  const actionById = new Map(actionRegistry.actions.map((action) => [action.id, action]));
  const centralResponsiveAuthority = ".product-experience/pdp-2-design-interface-system/gui/layout.yaml";

  for (const [, screenId, record] of screenRecords) {
    const contractRef = record.match(/^  - (screen-contracts\/[^\n]+)$/mu)?.[1];
    assert.ok(contractRef, `${screenId} must have one contract ref`);
    const contract = readFileSync(resolve(experienceRoot, contractRef), "utf8");
    assert.match(contract, /^schemaVersion: media\.screen-contract\.v2$/mu, `${screenId} schema version`);
    for (const field of requiredFields) assert.match(contract, new RegExp(`^${field}:`, "mu"), `${screenId} missing ${field}`);
    const bindingStatus = contract.match(/^fieldBindingStatus:\n([\s\S]*?)(?=^[A-Za-z][A-Za-z0-9]*:|$(?![\s\S]))/mu)?.[1] ?? "";
    for (const field of requiredFields.filter((name) => !["contractSchemaRef", "fieldBindingStatus"].includes(name))) {
      assert.match(bindingStatus, new RegExp(`^  ${field}:`, "mu"), `${screenId} missing binding-status reason for ${field}`);
    }
    assert.match(contract, /^surfaceId: media\.surface\.web$/mu, `${screenId} candidate surface`);
    const templateId = contract.match(/^templateId: (.+)$/mu)?.[1];
    if (templateId && templateId !== "null") assert.ok(knownTemplates.has(templateId), `${screenId} unresolved template ${templateId}`);
    for (const field of ["componentIds", "patternIds"]) {
      const value = contract.match(new RegExp(`^${field}:(.*)$`, "mu"))?.[1];
      assert.ok(value !== undefined, `${screenId} ${field} must be an array`);
      if (value.trim()) assert.match(value.trim(), /^\[[^\n]*\]$/u, `${screenId} ${field} must use YAML array syntax`);
      else assert.match(contract, new RegExp(`^${field}:\\n(?:(?:  - [^\\n]*|    \\[\\])\\n)*`, "mu"), `${screenId} ${field} must be a YAML list`);
    }
    const actionsBody = contract.match(/^actions:\n([\s\S]*?)(?=^[A-Za-z][A-Za-z0-9]*:|$(?![\s\S]))/mu)?.[1] ?? "";
    const actions = [...actionsBody.matchAll(/^\s*- ([^\n]+)$/gmu)].map(([, id]) => id);
    const consequencesBody = contract.match(/^actionConsequences:\n([\s\S]*?)(?=^[A-Za-z][A-Za-z0-9]*:|$(?![\s\S]))/mu)?.[1] ?? "";
    const consequenceIds = [...consequencesBody.matchAll(/^\s*- actionId: ([^\n]+)$/gmu)].map(([, id]) => id);
    assert.equal(consequenceIds.length, actions.length, `${screenId} consequence count must match actions`);
    assert.deepEqual(consequenceIds, actions, `${screenId} consequence refs must match action IDs and order`);
    if (actions.length) {
      const parsedContract = parseYaml(contract);
      for (const consequence of parsedContract.actionConsequences) {
        const action = actionById.get(consequence.actionId);
        assert.ok(action, `${screenId}/${consequence.actionId} must resolve to the action registry`);
        assert.equal(consequence.runtimeAdmission, "NOT_ADMITTED",
          `${screenId}/${consequence.actionId} must remain NOT_ADMITTED`);
        if (consequence.effectRef === null || consequence.effectRef === "unresolved") continue;
        const exactTypedDefinitionRef = `.product-experience/pdp-3-product-experience/action-registry.yaml#actions/@id=${consequence.actionId}/actionDefinitionSemantics/typedDefinition`;
        assert.equal(consequence.effectRef, exactTypedDefinitionRef,
          `${screenId}/${consequence.actionId} effectRef must be null/unresolved or the exact action typedDefinition`);
        assert.equal(action.actionDefinitionSemantics?.actionRef, consequence.actionId,
          `${screenId}/${consequence.actionId} typedDefinition ref must resolve to that action's source definition`);
        assert.equal(action.actionDefinitionSemantics?.typedDefinition?.runtimeAdmission, "NOT_ADMITTED",
          `${screenId}/${consequence.actionId} source definition must remain NOT_ADMITTED`);
      }
      if (screenId === "media.view.find-projects") {
        assert.deepEqual(consequenceIds, ["media.action.open-project", "media.action.create-project"]);
        assert.match(consequencesBody, /bindingStatus: source-definition-exact; screen-admission-pending; runtime-NOT_ADMITTED/u,
          `${screenId} bounded source definition cannot imply runtime admission`);
        assert.match(consequencesBody, /operationRef: media\.operation-slice\.inspect-project/u);
        assert.match(consequencesBody, /operationRef: media\.operation-slice\.create-project/u);
      } else if (screenId === "media.view.work-in-project") {
        assert.match(consequencesBody, /bindingStatus: source-definition-exact; screen-admission-pending; runtime-NOT_ADMITTED/u,
          `${screenId} source-defined local selection remains NOT_ADMITTED`);
      } else if (screenId === "media.view.browse-media") {
        const browseConsequences = parseYaml(contract).actionConsequences;
        assert.deepEqual(browseConsequences.map(({ actionId }) => actionId), [
          "media.action.inspect-artifact", "media.action.begin-artifact-upload",
        ]);
        assert.ok(browseConsequences.every(({ bindingStatus, runtimeAdmission }) =>
          bindingStatus === "source-definition-exact; screen-admission-pending; runtime-NOT_ADMITTED"
          && runtimeAdmission === "NOT_ADMITTED"), `${screenId} exact definitions remain runtime NOT_ADMITTED`);
        assert.deepEqual(browseConsequences.map(({ operationRefs }) => operationRefs), [
          ["media.operation-slice.inspect-artifact"], ["media.operation-slice.begin-upload"],
        ]);
        assert.deepEqual(browseConsequences[1].requiredOperationRefs, [
          "media.operation-slice.begin-upload",
          "media.operation-slice.append-upload-chunk",
          "media.operation-slice.complete-upload",
        ]);
      } else {
        const allConsequencesAreExactSourceDefinitions = parseYaml(contract).actionConsequences.every(({ bindingStatus }) =>
          bindingStatus === "source-definition-exact; screen-admission-pending; runtime-NOT_ADMITTED");
        if (allConsequencesAreExactSourceDefinitions) {
          assert.match(consequencesBody, /bindingStatus: source-definition-exact; screen-admission-pending; runtime-NOT_ADMITTED/u,
            `${screenId} exact action-registry definitions remain runtime NOT_ADMITTED`);
        } else {
          assert.match(consequencesBody, /(?:bindingStatus|status): pending/u, `${screenId} action consequences remain unresolved`);
        }
      }
    }
    assert.match(contract, new RegExp(`^responsiveBehavior:[\\s\\S]*?${centralResponsiveAuthority.replaceAll(".", "\\.")}`, "mu"), `${screenId} responsive authority must be central PDP-2`);
    assert.match(contract, /^verification:\n  status: not-run\n/mu, `${screenId} verification remains unrun`);
    assert.ok(/^  evidenceRefs: \[\]$/mu.test(contract) || /^  evidenceRefs:\n    \[\]$/mu.test(contract), `${screenId} must not invent verification evidence`);
  }
});

test("acceptance inputs use the four canonical PDP phases and keep Explorer outside the phase ledger", () => {
  const acceptance = readFileSync(resolve(root, ".product-experience/acceptance.yaml"), "utf8");
  assert.match(acceptance, /^schemaVersion: media\.product-acceptance-inputs\.v2$/mu);
  assert.match(acceptance, /^canonicalPdpPhases: \[PDP-0, PDP-1, PDP-2, PDP-3\]$/mu);

  const phaseStart = acceptance.indexOf("phaseAcceptanceInputs:\n");
  const phaseEnd = acceptance.indexOf("\nprojectionAcceptanceInputs:", phaseStart);
  assert.notEqual(phaseStart, -1, "missing phaseAcceptanceInputs");
  assert.notEqual(phaseEnd, -1, "missing projectionAcceptanceInputs after phase inputs");
  const phaseSection = acceptance.slice(phaseStart + "phaseAcceptanceInputs:\n".length, phaseEnd);
  const parseRecords = (section) => section.trim().split(/\n(?=- id: )/u).map((record) => ({
    id: record.match(/^- id: (\S+)$/mu)?.[1],
    phase: record.match(/^  phase: (PDP-[0-3])$/mu)?.[1],
    decisionInput: record.match(/^  decisionInput: (\S+)$/mu)?.[1],
    legacyId: record.match(/^  legacyId: (\S+)$/mu)?.[1],
    prerequisite: record.match(/^  prerequisite: (\S+)$/mu)?.[1],
    text: record,
  }));
  const phaseRows = parseRecords(phaseSection);
  assert.deepEqual([...new Set(phaseRows.map(({ phase }) => phase))], ["PDP-0", "PDP-1", "PDP-2", "PDP-3"]);
  assert.deepEqual(phaseRows.slice(0, 9).map(({ id, phase }) => [id, phase]), [
    ...Array.from({ length: 9 }, (_, index) => [`ACCEPT-INPUT-P0-${String(index + 2).padStart(3, "0")}`, "PDP-0"]),
  ]);
  assert.deepEqual(phaseRows.slice(9).map(({ id, phase, legacyId }) => [id, phase, legacyId]), [
    ["ACCEPT-INPUT-PDP-1", "PDP-1", undefined],
    ["ACCEPT-INPUT-PDP-2", "PDP-2", "ACCEPT-INPUT-P1"],
    ["ACCEPT-INPUT-PDP-3", "PDP-3", "ACCEPT-INPUT-P2"],
  ]);
  for (const legacyId of ["ACCEPT-INPUT-P1", "ACCEPT-INPUT-P2", "ACCEPT-INPUT-P3"]) {
    assert.deepEqual(acceptance.split("\n").filter((line) => line.includes(legacyId)), [`  legacyId: ${legacyId}`]);
  }
  assert.deepEqual(phaseRows.slice(9).map(({ decisionInput }) => decisionInput), [
    "pending-prerequisite-PDP-0-independent-P0-010-acceptance-and-human-review",
    "pending-prerequisite-PDP-1-and-human-review",
    "pending-prerequisite-PDP-2-and-full-experience-review",
  ]);
  assert.deepEqual(phaseRows.slice(9).map(({ prerequisite }) => prerequisite), [
    "independent-PDP-0-acceptance-including-P0-010",
    "accepted-PDP-1-canonical-domain-and-data-model",
    "accepted-PDP-2-design-language-and-interface-system",
  ]);
  assert.deepEqual(phaseRows.slice(0, 9).map(({ decisionInput }) => decisionInput), [
    ...Array.from({ length: 8 }, () => "pending-no-acceptance-recorded"),
    "pending-independent-review-not-executed",
  ]);

  const projectionStart = acceptance.indexOf("projectionAcceptanceInputs:\n");
  const projectionEnd = acceptance.indexOf("\ngeneratedResults:", projectionStart);
  assert.notEqual(projectionStart, -1, "missing projectionAcceptanceInputs");
  assert.notEqual(projectionEnd, -1, "missing generatedResults after projection inputs");
  const projectionSection = acceptance.slice(projectionStart + "projectionAcceptanceInputs:\n".length, projectionEnd);
  const projectionRows = parseRecords(projectionSection);
  assert.deepEqual(projectionRows.map(({ id, legacyId, phase }) => [id, legacyId, phase]), [
    ["ACCEPT-INPUT-PROJECTION-EXPLORER", "ACCEPT-INPUT-P3", undefined],
  ]);
  assert.match(projectionSection, /^  projection: EXPERIENCE-EXPLORER$/mu);
  assert.match(projectionSection, /^  decisionInput: pending-prerequisite-PDP-3-tools-binding-browser-evidence-and-human-review$/mu);
  assert.match(projectionSection, /^  prerequisite: accepted-PDP-3-product-experience$/mu);
  assert.doesNotMatch(projectionSection, /^  phase:/mu);
  assert.doesNotMatch(phaseSection, /EXPLORER|^- id: ACCEPT-INPUT-P[123]$/mu);
  assert.match(phaseRows[11].text, /journey-contracts\/live-session-loss-consent-change-and-bounded-recovery\.yaml/u);
  assert.match(phaseRows[11].text, /journey-contracts\/check-which-processing-options-are-eligible\.yaml/u);
  assert.doesNotMatch(acceptance, /^laterPhaseAcceptanceInputs:/mu);
});

test("active authority and experience metadata use canonical PDP labels without renaming stable IDs", () => {
  const authority = readFileSync(resolve(root, ".product-experience/authority-map.yaml"), "utf8");
  assert.match(authority, /- phase: PDP-0[\s\S]*?- phase: PDP-2[\s\S]*?- phase: PDP-3/mu);
  assert.match(authority, /outsidePdpPhases: true/u);
  assert.match(authority, /id: ART-P1-PHASE-1-DESIGN-LANGUAGE-DESIGN-LANGUAGE-MD/u);
  assert.match(authority, /id: ART-P2-PHASE-2-PRODUCT-EXPERIENCE-COMPLETE-PRODUCT-EXPERIENCE-MD/u);
  assert.match(authority, /P1-006/u);
  assert.doesNotMatch(authority, /canonical-if-and-when-the-P[12]-scope-is-accepted/u);

  const explorer = readFileSync(resolve(root, ".product-experience/explorer/EXPERIENCE-EXPLORER.md"), "utf8");
  assert.match(explorer, /Explorer is outside the four PDP phases/u);
  assert.match(explorer, /PDP-3 definitions remain unaccepted, and Explorer projection acceptance remains outstanding/u);
  assert.doesNotMatch(explorer, /Phase 3 is not accepted/u);

  const fixtures = readFileSync(resolve(root, ".product-experience/pdp-3-product-experience/scenario-fixture-registry.yaml"), "utf8");
  const fixtureRegistry = parseYaml(fixtures);
  assert.equal(fixtureRegistry.fixtures.length, 31);
  const payloadStateRecords = fixtureRegistry.fixtures.filter(({ pdp3PayloadState }) => pdp3PayloadState !== undefined);
  assert.equal(payloadStateRecords.length, 18, "current PDP-3 payload-state provenance is present on the 18 records that define it");
  assert.ok(payloadStateRecords.every(({ pdp3PayloadState }) => typeof pdp3PayloadState === "string" && pdp3PayloadState.length > 0),
    "each explicit PDP-3 payload-state field must have a source-bound value");
  assert.equal(fixtureRegistry.status, "30-of-30-journeys-and-130-of-130-steps-have-bounded-synthetic-definition-oracles; owner-acceptance-open; runtime-not-admitted");
  assert.doesNotMatch(fixtures, /content-payload-owned-by-PDP-3/u);
  assert.doesNotMatch(fixtures, /phase3PayloadState|content-payload-owned-by-Phase-3/u);

  const journey = readFileSync(resolve(root, ".product-experience/pdp-3-product-experience/journey-contracts/clean-noisy-interview-audio.yaml"), "utf8");
  const journeyDefinition = parseYaml(journey);
  assert.match(journeyDefinition.scope, /PDP-0 outcome[\s\S]*PDP-3 screen registry/u);
  assert.match(journeyDefinition.status, /pdp3-action-state-scenario-channel-and-owner-bindings-pending; not-accepted/u);
});

test("active cross-phase metadata uses canonical PDP labels while stable exception identities remain intact", () => {
  const experienceRoot = resolve(root, ".product-experience/pdp-3-product-experience");
  const journeyRegistry = readFileSync(resolve(experienceRoot, "journey-registry.yaml"), "utf8");
  assert.match(journeyRegistry, /^pdp0Authority:/mu);
  assert.match(journeyRegistry, /^additionalPdp0JourneyCount: 2$/mu);
  assert.equal(parseYaml(journeyRegistry).journeys.find(row=>row.id==='J-01').pdp0JourneyRef,'J-01');
  assert.match(journeyRegistry, /PDP-3 acceptance/u);
  assert.doesNotMatch(journeyRegistry, /phase0Authority|phase0JourneyRef|additionalPhase0JourneyCount|Phase-2 acceptance/u);

  const contracts = execFileSync("rg", ["--files", "--hidden", resolve(experienceRoot, "journey-contracts")], { cwd: root, encoding: "utf8" })
    .trim().split("\n").filter(Boolean);
  assert.ok(contracts.length >= 28, "expected the complete active journey contract set");
  for (const path of contracts) {
    const content = readFileSync(path, "utf8");
    assert.doesNotMatch(content, /phase0Authority|phase0JourneyRef|Phase-2 acceptance|phase-0-grounded/u, path);
    if (/^pdp0JourneyRef:/mu.test(content)) {
      assert.match(content, /^pdp0Authority: \.product-experience\/pdp-0-product-truth\/journey-catalog\.yaml$/mu, path);
      assert.match(content, /^pdp0JourneyRef: J-\d{2}$/mu, path);
    }
    if (content.includes("phase0-critical-exception")) {
      assert.ok(parseYaml(content).criticalNonhappyPaths?.some(({ id }) => id === "phase0-critical-exception"), path);
    }
  }

  const fixtures = readFileSync(resolve(root, ".product-experience/explorer/scenario-fixtures.yaml"), "utf8");
  assert.match(fixtures, /^    pdp3Ref: media\.scenario\.first-use-empty$/mu);
  assert.doesNotMatch(fixtures, /^    phase2Ref:/mu);
  const projections = readFileSync(resolve(root, ".product-experience/explorer/view-projections.yaml"), "utf8");
  assert.match(projections, /PDP-3-declared-context-dimensions/u);
  assert.match(projections, /PDP-0-to-PDP-3-references/u);

  const actions = readFileSync(resolve(experienceRoot, "action-registry.yaml"), "utf8");
  assert.match(actions, /proposal-derived-from-PDP-2-component-intent/u);
  assert.doesNotMatch(actions, /proposal-derived-from-phase-1-component-intent/u);
  const screens = readFileSync(resolve(experienceRoot, "screen-contracts/job-status.yaml"), "utf8");
  assert.match(screens, /bound-to-existing-PDP-3-actions/u);
  assert.match(screens, /pdp-0:journey:J-02/u);

  for (const file of ["media-token-aliases.yaml", "typography-layout.yaml"]) {
    const metadata = readFileSync(resolve(root, ".product-experience/pdp-2-design-interface-system", file), "utf8");
    assert.match(metadata, /^  pdp0:/mu);
    assert.doesNotMatch(metadata, /^  phase0:/mu);
  }

  const gaps = readFileSync(resolve(root, ".product-experience/gaps.yaml"), "utf8");
  assert.match(gaps, /^- id: GAP-MEDIA-PHASE2-COVERAGE$/mu);
  assert.match(gaps, /^- id: GAP-MEDIA-PHASE1-COMPONENT-COVERAGE$/mu);
  assert.match(gaps, /PDP-0, PDP-1, PDP-2,\s+and PDP-3 checks/u);
  assert.match(gaps, /PDP-0-through-PDP-3-certification/u);
  const verification = readFileSync(resolve(root, ".product-experience/explorer/verification-matrix.yaml"), "utf8");
  assert.match(verification, /462-PDP-0-capability-leaves/u);
});

test("PDP3-005 journey steps are structured, provenance-bound proposals across all 30 contracts", () => {
  const journeyRoot = resolve(root, ".product-experience/pdp-3-product-experience/journey-contracts");
  const files = execFileSync("rg", ["--files", "--hidden", journeyRoot], { cwd: root, encoding: "utf8" })
    .trim().split("\n").filter(Boolean).sort();
  assert.equal(files.length, 30, "PDP3-005 contract denominator, including J-29 and J-30");

  const required = [
    "surfaceRefs", "objectRefs", "stateRefs", "canonicalOperationRef", "authorityRef", "decisionRef",
    "transitionRef", "handoffRef", "success", "failure", "degradedBehavior", "recovery", "postconditions",
    "requirementRefs", "verification",
  ];
  const screenRegistry = readFileSync(resolve(root, ".product-experience/pdp-3-product-experience/screen-registry.yaml"), "utf8");
  const journeyCatalog = readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/journey-catalog.yaml"), "utf8");
  const journeys = new Map();

  let boundedJ01Validated = false;
  let boundedJ03Validated = false;
  let boundedJ03DraftValidated = false;
  let boundedJ03TranscriptReviewValidated = false;
  let boundedJ03SubmissionValidated = false;
  let boundedJ29ReconnectValidated = false;
  let boundedJ29ObservationValidated = false;
  let boundedJ29FenceObservationValidated = false;
  let boundedJ29ReconcileNoResultValidated = false;
  let boundedJ21InspectProvenanceValidated = false;
  let boundedJ16CaptionDraftWriteValidated = false;
  let boundedJ16UnselectedActionSetValidated = false;
  const boundedScopedQueryBindings = new Set();
  const boundedJ20CommandBindings = new Set();
  const boundedLocalStepEffectBindings = new Set();
  const boundedInspectArtifactBindings = new Set();
  let boundedJ19QualityEvidenceValidated = false;
  let boundedJ19RenderOutcomeValidated = false;
  let boundedJ22InspectOutputValidated = false;
  let boundedJ22DeliveryValidated = false;
  let boundedJ22DeliverySuccessValidated = false;
  let boundedJ22JobStatusSuccessValidated = false;
  let boundedJ22JobStatusDegradedValidated = false;
  let boundedJ28LocalEligibilityValidated = false;
  let boundedJ28LocalEligibilityDegradedValidated = false;
  let boundedJ28SubmitRenderOutcomeValidated = false;
  let boundedJ28DestinationSelectionValidated = false;
  let boundedJ28KeyframeEligibilityValidated = false;
  let boundedJ28KeyframeEligibilityDegradedValidated = false;
  for (const path of files) {
    const content = readFileSync(path, "utf8");
    const journeyId = content.match(/^journeyId: (J-\d{2})$/mu)?.[1];
    assert.ok(journeyId, `${path} must declare a source-grounded journey ID`);
    assert.match(journeyCatalog, new RegExp(`^- id: ${journeyId}$`, "mu"), `${journeyId} must exist in PDP-0 catalog`);
    assert.ok(!journeys.has(journeyId), `${journeyId} must be unique`);
    const parsedJourney = parseYaml(content);
    const sourceDefinedJ01 = journeyId === "J-01";
    if (sourceDefinedJ01) {
      validateBoundedJ01ProjectDefinitions(parsedJourney);
      boundedJ01Validated = true;
    }
    const sourceDefinedJ03 = journeyId === "J-03";
    if (sourceDefinedJ03) {
      validateBoundedJ03CaptionVersionDefinitions(parsedJourney);
      boundedJ03Validated = true;
      validateBoundedJ03CaptionDraftDefinitions(parsedJourney);
      boundedJ03DraftValidated = true;
      validateBoundedJ03TranscriptReviewDefinition(parsedJourney);
      boundedJ03TranscriptReviewValidated = true;
      validateBoundedJ03TranscriptionSubmissionDefinition(parsedJourney);
      boundedJ03SubmissionValidated = true;
    }
    const sourceDefinedJ29 = journeyId === "J-29";
    if (sourceDefinedJ29) {
      validateBoundedJ29ReconnectDefinition(parsedJourney);
      boundedJ29ReconnectValidated = true;
      validateBoundedJ29ObservationDefinition(parsedJourney);
      boundedJ29ObservationValidated = true;
      validateBoundedJ29FenceObservationDefinition(parsedJourney);
      boundedJ29FenceObservationValidated = true;
      validateBoundedJ29ReconcileNoResultDefinition(parsedJourney);
      boundedJ29ReconcileNoResultValidated = true;
    }
    if (journeyId === "J-19") {
      validateBoundedJ19ScopedQueryDefinition(parsedJourney, {
        stepIndex: 0,
        view: "media.view.review-quality",
        operationId: "media.operation.action.inspect-quality-evidence",
        objectRefs: ["media.domain.render-outcome", "media.domain.artifact-version", "media.domain.quality-assessment"],
      });
      validateBoundedJ19ScopedQueryDefinition(parsedJourney, {
        stepIndex: 1,
        view: "media.view.review-creation-plan",
        operationId: "media.operation.action.review-processing-parameters",
        objectRefs: ["media.domain.artifact-version", "media.domain.processing-job", "media.domain.resolved-plan"],
      });
      validateBoundedJ19ScopedQueryDefinition(parsedJourney, {
        stepIndex: 2,
        view: "media.view.compare-results",
        operationId: "media.operation.action.compare-candidate-on-metric",
        objectRefs: ["media.domain.quality-assessment", "media.domain.artifact-version"],
      });
      boundedJ19QualityEvidenceValidated = true;
      validateBoundedSubmitRenderOutcomeDefinition(parsedJourney, {
        journeyId: "J-19",
        stepIndex: 3,
        laterOutcomeRef: ".product-experience/pdp-3-product-experience/journey-contracts/inspect-quality-and-optimize-within-bounds.yaml#/terminalSuccess",
        criticalNonhappyPathRef: ".product-experience/pdp-0-product-truth/journey-catalog.yaml#journeys/@id=J-19/criticalNonhappyPaths",
      });
      boundedJ19RenderOutcomeValidated = true;
    }
    if (journeyId === "J-21") {
      validateBoundedJ21InspectProvenanceDefinition(parsedJourney);
      boundedJ21InspectProvenanceValidated = true;
    }
    if (journeyId === "J-16") {
      validateBoundedJ16CaptionDraftWriteDefinition(parsedJourney);
      boundedJ16CaptionDraftWriteValidated = true;
      validateBoundedJ16UnselectedActionSetDefinition(parsedJourney);
      boundedJ16UnselectedActionSetValidated = true;
    }
    for (const [scopedJourneyId, stepIndex, operationId, sourceFile] of boundedScopedQueryStepSpecs) {
      if (journeyId !== scopedJourneyId) continue;
      validateBoundedScopedQueryStepDefinition(parsedJourney, { journeyId, stepIndex, operationId, sourceFile });
      boundedScopedQueryBindings.add(`${journeyId}:${stepIndex}`);
    }
    if (journeyId === "J-20") {
      for (const [stepIndex, operationId, requestFields, expectedArtifactType] of boundedJ20CommandStepSpecs) {
        validateBoundedJ20CommandOutcomeDefinition(parsedJourney, { stepIndex, operationId, requestFields, expectedArtifactType });
        boundedJ20CommandBindings.add(`${journeyId}:${stepIndex}`);
      }
    }
    for (const [localJourneyId, stepIndex, effectId, sourceFile, effectMode] of boundedLocalStepEffectSpecs) {
      if (journeyId !== localJourneyId) continue;
      validateBoundedLocalStepEffectDefinition(parsedJourney, { journeyId, stepIndex, effectId, sourceFile, effectMode });
      boundedLocalStepEffectBindings.add(`${journeyId}:${stepIndex}`);
    }
    for (const [inspectJourneyId, stepIndex, sourceFile] of boundedInspectArtifactStepSpecs) {
      if (journeyId !== inspectJourneyId) continue;
      validateBoundedInspectArtifactDefinition(parsedJourney, { journeyId, stepIndex, sourceFile });
      boundedInspectArtifactBindings.add(`${journeyId}:${stepIndex}`);
    }
    if (journeyId === "J-22") {
      validateBoundedJ22InspectOutputDefinition(parsedJourney);
      boundedJ22InspectOutputValidated = true;
      boundedJ22DeliveryValidated = true;
      validateBoundedJ22DeliverySuccessDefinition(parsedJourney);
      boundedJ22DeliverySuccessValidated = true;
      validateBoundedJ22JobStatusSuccessDefinition(parsedJourney);
      boundedJ22JobStatusSuccessValidated = true;
      validateBoundedJ22JobStatusDegradedDefinition(parsedJourney);
      boundedJ22JobStatusDegradedValidated = true;
    }
    if (journeyId === "J-28") {
      validateBoundedJ28LocalEligibilityDefinition(parsedJourney);
      boundedJ28LocalEligibilityValidated = true;
      validateBoundedJ28LocalEligibilityDegradedDefinition(parsedJourney);
      boundedJ28LocalEligibilityDegradedValidated = true;
      validateBoundedSubmitRenderOutcomeDefinition(parsedJourney, {
        journeyId: "J-28",
        stepIndex: 2,
        laterOutcomeRef: ".product-experience/pdp-3-product-experience/journey-contracts/export-spatial-media-with-format-loss-reporting.yaml#/terminalSuccess",
        criticalNonhappyPathRef: ".product-experience/pdp-0-product-truth/journey-catalog.yaml#journeys/@id=J-28/criticalNonhappyPaths",
      });
      boundedJ28SubmitRenderOutcomeValidated = true;
      validateBoundedJ28DestinationSelectionDefinition(parsedJourney);
      boundedJ28DestinationSelectionValidated = true;
      validateBoundedJ28KeyframeEligibilityDefinition(parsedJourney);
      boundedJ28KeyframeEligibilityValidated = true;
      validateBoundedJ28KeyframeEligibilityDegradedDefinition(parsedJourney);
      boundedJ28KeyframeEligibilityDegradedValidated = true;
    }
    const lines = content.split(/\r?\n/u);
    const stepsKey = lines.findIndex((line) => /^steps:\s*$/u.test(line));
    assert.notEqual(stepsKey, -1, `${journeyId} must declare steps`);
    let sectionEnd = stepsKey + 1;
    while (sectionEnd < lines.length && !/^[A-Za-z][A-Za-z0-9]*:/u.test(lines[sectionEnd])) sectionEnd++;
    const firstListItem = lines.slice(stepsKey + 1, sectionEnd).find((line) => /^ {0,8}-\s/u.test(line));
    assert.ok(firstListItem, `${journeyId} must have a steps list`);
    const stepIndent = firstListItem.match(/^( *)-/u)[1].length;
    const listItems = [];
    for (let index = stepsKey + 1; index < sectionEnd; index++) {
      const item = lines[index].match(new RegExp(`^ {${stepIndent}}-\\s*(.*)$`, "u"));
      if (!item) continue;
      assert.match(item[1], /^[A-Za-z][A-Za-z0-9_-]*\s*:/u, `${journeyId} step at line ${index + 1} must be a mapping, not a bare string`);
      listItems.push({ start: index, indent: stepIndent });
    }
    assert.ok(listItems.length > 0, `${journeyId} must have structured steps`);
    const stepIds = [];
    const declaredStepIds = [];
    for (let itemIndex = 0; itemIndex < listItems.length; itemIndex++) {
      const item = listItems[itemIndex];
      let end = sectionEnd;
      for (let index = item.start + 1; index < sectionEnd; index++) {
        const nextItem = lines[index].match(/^( {0,2})-\s/u);
        if (nextItem && nextItem[1].length <= item.indent) { end = index; break; }
      }
      const block = lines.slice(item.start, end).join("\n");
      const stepId = block.match(/^\s{0,4}(?:-\s*)?(?:stepId|view):\s*(["']?)([^\s"']+)\1/mu)?.[2];
      const declaredStepId = block.match(/^\s{0,4}(?:-\s*)?stepId:\s*(["']?)([^\s"']+)\1/mu)?.[2];
      assert.ok(stepId, `${journeyId} step ${itemIndex + 1} needs a source-grounded stepId or view`);
      stepIds.push(stepId);
      if (declaredStepId) declaredStepIds.push(declaredStepId);
      const fieldIndent = " ".repeat(item.indent + 2);
      for (const field of required) {
        assert.match(block, new RegExp(`^${fieldIndent}${field}:`, "mu"), `${journeyId}/${stepId} missing ${field}`);
      }
      const bindingStart = block.search(new RegExp(`^${fieldIndent}bindingStatus:(?:\\s*.*)?$`, "mu"));
      assert.notEqual(bindingStart, -1, `${journeyId}/${stepId} missing bindingStatus mapping`);
      const bindingBlock = block.slice(bindingStart).split(new RegExp(`\\n${fieldIndent}[A-Za-z][A-Za-z0-9]*:`, "u"))[0];
      const bindingReason = bindingBlock.match(new RegExp(`^${fieldIndent}  reason:\\s*(.+)$`, "mu"))?.[1]?.trim()
        ?? bindingBlock.match(new RegExp(`^${fieldIndent}bindingStatus:\\s*(.+)$`, "mu"))?.[1]?.trim();
      const boundedJ08Selection = journeyId === "J-08" && itemIndex === 0
        && stepId === "media.view.select-source"
        && bindingReason === "SOURCE_DEFINED_LOCAL_SELECTION; runtime and independent review remain open"
        && block.includes("localStepEffectContractRef: .product-experience/pdp-3-product-experience/local-step-effect-contracts.yaml#records/@id=media.local-step-effect.j-08.step-01.v1")
        && content.includes(".product-experience/decision-log.md#PXD-119")
        && /canonicalOperationRef: null/u.test(block)
        && /exactOperationRefs: \[\]/u.test(block)
        && /runtimeAdmission: NOT_ADMITTED/u.test(block)
        && /effect: bind-one-exact-source-version-to-the-current-workflow/u.test(block);
      for (const field of required) {
        const directReason = bindingBlock.match(new RegExp(`^${fieldIndent}  ${field}:\\s*(.+)$`, "mu"))?.[1]?.trim();
        const listedReason = new RegExp(`^${fieldIndent}    - ${field}$`, "mu").test(bindingBlock);
        const fieldBlock = block.match(new RegExp(`^${fieldIndent}${field}:\\n([\\s\\S]*?)(?=^${fieldIndent}[A-Za-z][A-Za-z0-9]*:|$(?![\\s\\S]))`, "mu"))?.[1] ?? "";
        const localStatus = fieldBlock.match(/^\s+status: ([^\n]+)$/mu)?.[1];
        assert.ok(directReason || listedReason || localStatus || boundedJ08Selection,
          `${journeyId}/${stepId} missing binding status/reason for ${field}`);
        const reason = directReason ?? bindingReason ?? localStatus;
        const boundedJ06SourceDefinition = journeyId === "J-06" && itemIndex === 0
          && ["canonicalOperationRef", "authorityRef"].includes(field)
          && ((field === "canonicalOperationRef"
            && directReason === "media.operation.job.submit.v1; selected target operation remains user-bound")
            || (field === "authorityRef"
              && directReason === "trusted tenant/principal/delegation context is host-supplied and rechecked"))
          && block.includes("canonicalOperationRef: media.operation.job.submit.v1")
          && block.includes("authorityRef: .product-experience/pdp-1-domain-data/authority.yaml#ownership.identityAuthenticationAndDelegation")
          && /exactOperationRefs:\n\s+- media\.operation\.action\.submit-validated-request/u.test(block)
          && block.includes(".product-experience/decision-log.md#PXD-075")
          && /runtimeAdmission: NOT_ADMITTED/u.test(block);
        const pendingReason = Boolean(reason && /pending|candidate|unresolved|not-run|not-specified|not-accepted/iu.test(reason));
        const boundedDefinitionReason = (sourceDefinedJ01 && boundedJ01Validated
          && content.includes(".product-experience/decision-log.md#PXD-055")
          && content.includes("runtimeAdmission: NOT_ADMITTED"))
          || (sourceDefinedJ03 && boundedJ03SubmissionValidated && itemIndex === 1
            && content.includes(".product-experience/decision-log.md#PXD-070")
            && content.includes(".product-experience/decision-log.md#PXD-071")
            && content.includes("SOURCE_DEFINED_OWNER_ACCEPTED under PXD-072; runtime-admission-pending")
            && /runtimeAdmission: NOT_ADMITTED/u.test(block))
          || (sourceDefinedJ03 && boundedJ03TranscriptReviewValidated && itemIndex === 3
            && content.includes(".product-experience/decision-log.md#PXD-064")
            && /runtimeAdmission: NOT_ADMITTED/u.test(block))
          || (sourceDefinedJ03 && boundedJ03DraftValidated && [4, 5].includes(itemIndex)
            && block.includes(".product-experience/decision-log.md#PXD-066")
            && block.includes(".product-experience/decision-log.md#PXD-067")
            && block.includes(".product-experience/decision-log.md#PXD-068")
            && /runtimeAdmission: NOT_ADMITTED/u.test(block))
          || (sourceDefinedJ03 && boundedJ03Validated && [6, 7].includes(itemIndex)
            && content.includes(".product-experience/decision-log.md#PXD-060")
            && content.includes("runtimeAdmission: NOT_ADMITTED"))
          || (sourceDefinedJ29 && boundedJ29ReconnectValidated && itemIndex === 3
            && content.includes(".product-experience/decision-log.md#PXD-077")
            && content.includes("runtimeAdmission: NOT_ADMITTED"))
          || (sourceDefinedJ29 && boundedJ29ObservationValidated && itemIndex === 0 && ["success", "degradedBehavior"].includes(field)
            && content.includes(".product-experience/decision-log.md#PXD-119")
            && /runtimeAdmission: NOT_ADMITTED/u.test(block))
          || (sourceDefinedJ29 && boundedJ29FenceObservationValidated && itemIndex === 1 && ["success", "degradedBehavior"].includes(field)
            && content.includes(".product-experience/decision-log.md#PXD-119")
            && content.includes(".product-experience/decision-log.md#PXD-160")
            && /runtimeAdmission: NOT_ADMITTED/u.test(block))
          || (sourceDefinedJ29 && boundedJ29ReconcileNoResultValidated && itemIndex === 2 && ["success", "degradedBehavior"].includes(field)
            && content.includes(".product-experience/decision-log.md#PXD-119")
            && /runtimeAdmission: NOT_ADMITTED/u.test(block))
          || (boundedScopedQueryBindings.has(`${journeyId}:${itemIndex}`) && ["success", "degradedBehavior"].includes(field)
            && content.includes("runtimeAdmission: NOT_ADMITTED"))
          || (boundedJ20CommandBindings.has(`${journeyId}:${itemIndex}`) && ["success", "degradedBehavior"].includes(field)
            && content.includes("runtimeAdmission: NOT_ADMITTED"))
          || (boundedLocalStepEffectBindings.has(`${journeyId}:${itemIndex}`) && ["success", "degradedBehavior"].includes(field)
            && content.includes("runtimeAdmission: NOT_ADMITTED"))
          || (journeyId === "J-21" && itemIndex === 2 && ["success", "degradedBehavior"].includes(field)
            && boundedJ21InspectProvenanceValidated && content.includes(".product-experience/decision-log.md#PXD-075")
            && content.includes("runtimeAdmission: NOT_ADMITTED"))
          || (journeyId === "J-16" && itemIndex === 2 && ["success", "degradedBehavior"].includes(field)
            && boundedJ16CaptionDraftWriteValidated && content.includes(".product-experience/decision-log.md#PXD-075")
            && content.includes("runtimeAdmission: NOT_ADMITTED"))
          || (journeyId === "J-16" && itemIndex === 1 && ["success", "degradedBehavior"].includes(field)
            && boundedJ16UnselectedActionSetValidated && content.includes("runtimeAdmission: NOT_ADMITTED"))
          || (boundedInspectArtifactBindings.has(`${journeyId}:${itemIndex}`) && ["success", "degradedBehavior"].includes(field)
            && content.includes("runtimeAdmission: NOT_ADMITTED"))
          || (journeyId === "J-19" && [0, 1, 2].includes(itemIndex) && ["success", "degradedBehavior"].includes(field)
            && boundedJ19QualityEvidenceValidated && content.includes(".product-experience/decision-log.md#PXD-075")
            && /runtimeAdmission: NOT_ADMITTED/u.test(block))
          || (journeyId === "J-19" && itemIndex === 3 && ["success", "degradedBehavior"].includes(field)
            && boundedJ19RenderOutcomeValidated && content.includes(".product-experience/decision-log.md#PXD-075")
            && /runtimeAdmission: NOT_ADMITTED/u.test(block))
          || boundedJ06SourceDefinition
          || (boundedJ08Selection && required.includes(field))
          || (journeyId === "J-22" && itemIndex === 0 && ["objectRefs", "canonicalOperationRef", "stateRefs", "authorityRef", "success", "degradedBehavior"].includes(field)
            && boundedJ22InspectOutputValidated && content.includes(".product-experience/decision-log.md#PXD-075")
            && /runtimeAdmission: NOT_ADMITTED/u.test(block))
          || (journeyId === "J-22" && itemIndex === 1 && ["objectRefs", "canonicalOperationRef", "stateRefs", "authorityRef", "degradedBehavior"].includes(field)
            && boundedJ22DeliveryValidated && content.includes(".product-experience/decision-log.md#PXD-075")
            && /runtimeAdmission: NOT_ADMITTED/u.test(block))
          || (journeyId === "J-22" && itemIndex === 1 && field === "success"
            && boundedJ22DeliverySuccessValidated && content.includes(".product-experience/decision-log.md#PXD-075")
            && /runtimeAdmission: NOT_ADMITTED/u.test(block))
          || (journeyId === "J-22" && itemIndex === 2 && field === "success"
            && boundedJ22JobStatusSuccessValidated && content.includes(".product-experience/decision-log.md#PXD-075")
            && /runtimeAdmission: NOT_ADMITTED/u.test(block))
          || (journeyId === "J-22" && itemIndex === 2 && field === "degradedBehavior"
            && boundedJ22JobStatusDegradedValidated && content.includes(".product-experience/decision-log.md#PXD-075")
            && /runtimeAdmission: NOT_ADMITTED/u.test(block))
          || (journeyId === "J-28" && itemIndex === 0 && field === "success"
            && boundedJ28LocalEligibilityValidated && content.includes(".product-experience/decision-log.md#PXD-075")
            && /runtimeAdmission: NOT_ADMITTED/u.test(block))
          || (journeyId === "J-28" && itemIndex === 0 && field === "degradedBehavior"
            && boundedJ28LocalEligibilityDegradedValidated && content.includes(".product-experience/decision-log.md#PXD-075")
            && /runtimeAdmission: NOT_ADMITTED/u.test(block))
          || (journeyId === "J-28" && itemIndex === 1 && field === "success"
            && boundedJ28KeyframeEligibilityValidated && content.includes(".product-experience/decision-log.md#PXD-075")
            && /runtimeAdmission: NOT_ADMITTED/u.test(block))
          || (journeyId === "J-28" && itemIndex === 2 && field === "success"
            && boundedJ28SubmitRenderOutcomeValidated && content.includes(".product-experience/decision-log.md#PXD-075")
            && /runtimeAdmission: NOT_ADMITTED/u.test(block))
          || (journeyId === "J-28" && itemIndex === 2 && field === "degradedBehavior"
            && boundedJ28SubmitRenderOutcomeValidated && content.includes(".product-experience/decision-log.md#PXD-075")
            && /runtimeAdmission: NOT_ADMITTED/u.test(block))
          || (journeyId === "J-28" && itemIndex === 3 && ["success", "degradedBehavior"].includes(field)
            && boundedJ28DestinationSelectionValidated && content.includes(".product-experience/decision-log.md#PXD-075")
            && /runtimeAdmission: NOT_ADMITTED/u.test(block))
          || (journeyId === "J-28" && itemIndex === 1 && field === "degradedBehavior"
            && boundedJ28KeyframeEligibilityDegradedValidated && content.includes(".product-experience/decision-log.md#PXD-075")
            && /runtimeAdmission: NOT_ADMITTED/u.test(block));
        const externalIdentityHandoffReason = sourceDefinedJ01 && itemIndex === 0 && field === "handoffRef"
          && content.includes("runtimeAdmission: NOT_ADMITTED") && /external Shared identity contract only/iu.test(reason ?? "");
        assert.ok(pendingReason || boundedDefinitionReason || externalIdentityHandoffReason,
          `${journeyId}/${stepId} binding reason for ${field} must remain proposal/unresolved or pass its exact bounded source-definition and NOT_ADMITTED validation`);
      }
      const verificationBlock = block.match(new RegExp(`^${fieldIndent}verification:\\n([\\s\\S]*?)(?=^${fieldIndent}[A-Za-z][A-Za-z0-9]*:|$(?![\\s\\S]))`, "mu"))?.[1] ?? "";
      const sourceDefinitionOnlyVerification = boundedJ08Selection
        && /^\s+status: source-definition-only$/mu.test(verificationBlock);
      assert.ok(/^\s+status: not-run$/mu.test(verificationBlock) || sourceDefinitionOnlyVerification,
        `${journeyId}/${stepId} verification must remain not-run or the exact source-definition-only local-selection disposition`);
      const emptyEvidenceField = (field) => new RegExp(`^\\s+${field}:\\s*\\[\\]\\s*$|^\\s+${field}:\\s*\\n\\s+\\[\\]\\s*$`, "mu").test(verificationBlock);
      const hasActualEvidence = /^\s+actualEvidence:/mu.test(verificationBlock);
      if (hasActualEvidence) {
        assert.ok(emptyEvidenceField("actualEvidence"), `${journeyId}/${stepId} actualEvidence must be exactly empty`);
      }
      assert.ok(hasActualEvidence || /^\s+evidenceRefs:/mu.test(verificationBlock),
        `${journeyId}/${stepId} verification must declare actualEvidence or evidenceRefs`);
      assert.ok(emptyEvidenceField(hasActualEvidence ? "actualEvidence" : "evidenceRefs"),
        `${journeyId}/${stepId} verification evidence list must be exactly empty`);
      const operation = block.match(new RegExp(`^${fieldIndent}canonicalOperationRef:[ \\t]*(.*)$`, "mu"))?.[1].trim();
      const externalIdentityNoOperation = sourceDefinedJ01 && itemIndex === 0
        && operation === "" && boundedJ01Validated;
      assert.ok(externalIdentityNoOperation || operation === "null" || /^media\.operation(?:-slice)?\.[a-z0-9.-]+$/u.test(operation ?? ""),
        `${journeyId}/${stepId} canonicalOperationRef must be null or a logical operation ID, never a transport route`);
      const screenRef = block.match(new RegExp(`^${fieldIndent}screenContractRef:\\s*([^\\s]+)$`, "mu"))?.[1];
      if (screenRef) {
        const experienceRoot = resolve(root, ".product-experience/pdp-3-product-experience");
        const registryRelativeRef = screenRef.startsWith(".product-experience/pdp-3-product-experience/")
          ? screenRef.slice(".product-experience/pdp-3-product-experience/".length)
          : screenRef;
        assert.match(registryRelativeRef, /^screen-contracts\/[\w.-]+\.yaml$/u,
          `${journeyId}/${stepId} screen ref must follow the screen-registry contractRefs convention`);
        assert.ok(existsSync(resolve(experienceRoot, registryRelativeRef)), `${journeyId}/${stepId} screen contract ref must exist`);
        assert.ok(screenRegistry.includes(`  - ${registryRelativeRef}\n`),
          `${journeyId}/${stepId} screen contract ref must be listed by the canonical screen registry`);
      }
      const view = block.match(new RegExp(`^${fieldIndent}view:\\s*([^\\s]+)$`, "mu"))?.[1];
      if (view) assert.ok(screenRegistry.includes(`- id: ${view}\n`), `${journeyId}/${stepId} view must exist in screen registry`);
    }
    assert.equal(new Set(declaredStepIds).size, declaredStepIds.length, `${journeyId} declared stepIds must be unique`);
    journeys.set(journeyId, stepIds);
  }

  assert.equal(journeys.size, 30, "all 30 distinct journey IDs must be represented");
  assert.equal(boundedJ01Validated, true, "J-01 source-defined bindings require their bounded source checks");
  assert.equal(boundedJ03Validated, true, "only J-03 steps 7 and 8 use their exact bounded caption-version source checks");
  assert.equal(boundedJ03SubmissionValidated, true, "only J-03 step 2 uses the exact bounded submission definition check");
  assert.equal(boundedJ29ReconnectValidated, true, "only J-29 reconnect step uses the exact bounded PXD-077 definition check");
  assert.equal(boundedJ29ObservationValidated, true, "only J-29 detect-loss step uses the exact no-result observation definition without runtime admission");
  assert.equal(boundedJ29FenceObservationValidated, true, "only J-29 fence-new-frame step binds the exact read-only same-session observation query without dispatch");
  assert.equal(boundedJ29ReconcileNoResultValidated, true, "only J-29 reconcile step preserves no-result-until-owner-observation without runtime admission");
  assert.equal(boundedScopedQueryBindings.size, 18, "only the audited 18 journey/ordinal pairs bind the exact scoped-query profile without runtime admission");
  assert.equal(boundedJ20CommandBindings.size, 2, "only J-20 cancel/retry indices 4–5 bind their exact conditional command result contracts without runtime admission");
  assert.equal(boundedLocalStepEffectBindings.size, 5, "only the five audited local catalog-selection steps use their exact local-draft eligibility contracts");
  assert.equal(boundedJ21InspectProvenanceValidated, true, "only J-21 inspect-provenance binds the exact typed owner observation definition without runtime admission");
  assert.equal(boundedJ16CaptionDraftWriteValidated, true, "only J-16 edit-captions binds the exact session-local draft output and unknown-recovery semantics without runtime admission");
  assert.equal(boundedJ16UnselectedActionSetValidated, true, "J-16 work-with-speech remains an exact no-result-until-selection state with no default dispatch or runtime admission");
  assert.equal(boundedInspectArtifactBindings.size, 2, "only the two audited inspect-artifact steps bind caller-scoped metadata semantics without runtime admission");
  assert.equal(boundedJ19QualityEvidenceValidated, true, "J-19 review-quality binds only the exact scoped observation result without runtime admission");
  assert.equal(boundedJ19RenderOutcomeValidated, true, "J-19 prepare-render binds only the exact source-defined admission/unknown outcomes without runtime admission");
  assert.equal(boundedJ03DraftValidated, true, "only J-03 steps 5 and 6 use the exact bounded caption-draft definition check");
  assert.equal(boundedJ22InspectOutputValidated, true, "J-22 inspect-output binds the exact P1 query and object set without runtime admission");
  assert.equal(boundedJ28LocalEligibilityValidated, true, "J-28 compose-scene binds the exact local eligibility result without an operation or runtime admission");
  assert.equal(boundedJ28LocalEligibilityDegradedValidated, true, "J-28 compose-scene degraded result holds locally without operation or runtime admission");
  assert.equal(boundedJ28SubmitRenderOutcomeValidated, true, "J-28 prepare-render binds only the exact source-defined admission/unknown outcomes without runtime admission");
  assert.equal(boundedJ28DestinationSelectionValidated, true, "J-28 deliver-output binds only local destination-selection eligibility without canonical effects or runtime admission");
  assert.equal(boundedJ28KeyframeEligibilityValidated, true, "J-28 animate-media success is local keyframe eligibility with provenance unresolved");
  assert.equal(boundedJ28KeyframeEligibilityDegradedValidated, true, "J-28 animate-media degraded result holds locally without operation or runtime admission");
  assert.deepEqual(journeys.get("J-29"), [
    "detect-loss-or-consent-change", "fence-new-frame-submission", "reconcile-dispatched-frame-effects", "present-bounded-return-state",
  ]);
  assert.deepEqual(journeys.get("J-30"), [
    "establish-scope-and-permissions", "inspect-profile-and-provider-dimensions", "preserve-unknown-or-unavailable-reasons", "return-eligible-options-with-provenance",
  ]);
});

test("gRPC source inventory status matches the active proto census without changing pending bindings", () => {
  const registry = readYaml(".product-experience/pdp-3-product-experience/grpc/service-registry.yaml");
  assert.equal(registry.status, "active-source-inventory; observed-proto-projections; protocol-authority-unselected; operation-bindings-proposal-only; owner-review-pending");
  assert.equal(registry.observedRpcCount, 43);
  assert.equal(registry.requestedRpcCount, 43);
  assert.equal(registry.unresolvedRpcCount, 0);
  assert.equal(registry.rpcs.length, 43);
  assert.equal(new Set(registry.rpcs.map(record => record.id)).size, 43);
  assert.ok(registry.rpcs.every(record => record.experienceBinding === "pending-owner-review"));

});

test("PDP1 operation proposal preserves source denominators and the complete proposal field shape", () => {
  const registry = readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/operations.yaml"), "utf8");
  const requiredFields = [
    "operationId", "consumerActor", "authority", "context", "preconditions", "inputSemantics", "effect",
    "affectedObjects", "transition", "events", "risk", "reversibility", "commitFinality", "downstreamEffects",
    "failure", "partialSuccess", "unknownOutcome", "retry", "idempotency", "recovery", "evidenceAudit", "nextSafeAction",
  ];
  const parsed = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");
  const records = parsed.operations.map(record => [null, record.id, record]);
  assert.equal(records.length, 14, "nine organizational families include five source-specific operations");
  assert.equal(new Set(records.map(([, id]) => id)).size, 14);
  const sourceSpecificIds = new Set([
    "media.operation.transcription-submission", "media.operation.transcript-version-read",
    "media.operation.caption-draft-write", "media.operation.caption-version-write",
    "media.operation.caption-version-read",
  ]);
  const sourceSpecificFields = [
    "operationId", "consumerActor", "authority", "inputSemantics", "effect", "outputSemantics",
    "authorization", "error", "finality", "version", "transport", "idempotency", "cancellation",
    "actionRefs", "observedBindings", "scopeStatus",
  ];
  for (const [, id, body] of records) {
    const fields = sourceSpecificIds.has(id) ? sourceSpecificFields : requiredFields;
    for (const field of fields) assert.ok(Object.hasOwn(body, field), `${id} missing ${field}`);
  }

  const denominators = parsed.sourceDenominators;
  assert.equal(denominators.uiProductActions.count, 146);
  assert.equal(Object.keys(denominators.uiProductActions.explicitOperationIds).length, 14);
  assert.equal(denominators.uiProductActions.unresolvedActionIds.length, 132);
  assert.equal(denominators.uiProductActions.explicitOperationIds["media.action.request-transcription"], "media.operation.transcription-submission");
  assert.equal(denominators.httpOperations.count, 27);
  assert.equal(denominators.grpcRpcs.count, 43);
  assert.equal(denominators.cliSimulationCommands.planDenominator, 11);
  assert.equal(denominators.cliSimulationCommands.currentFixtureRegistryRecords, 11);
  assert.equal(denominators.sdkMethods.registryRecords, 33);
  assert.equal(denominators.agentToolHandlers.count, 4);
  assert.equal(denominators.lifecycleEventNames.count, 15);
  assert.equal(parsed.ownerReview, "pending-owner-review");

});

test("G-05 proposal counts stay distinct from its historical snapshot and acceptance", () => {
  const acceptance = readFileSync(resolve(root, ".product-experience/acceptance.yaml"), "utf8");
  const gap = readFileSync(resolve(root, ".product-experience/gaps.yaml"), "utf8");
  const closureMatrix = readFileSync(resolve(root, ".product-experience/mandatory-surface-closure-matrix.yaml"), "utf8");
  const dashboard = readFileSync(resolve(root, ".product-experience/closure-dashboard.yaml"), "utf8");
  const decisionLog = readFileSync(resolve(root, ".product-experience/decision-log.md"), "utf8");

  assert.match(acceptance, /14 of 146 UI actions have exact proposed operation refs, zero are ambiguous, and 132 remain unresolved/u);
  assert.match(acceptance, /17 proposed family refs and 26 unresolved identities/u);
  assert.match(gap, /currentStatusRef: \.product-experience\/gap-current-status\.yaml#GAP-05/u);
  assert.match(gap, /Historical PDP3-002\/PDP1-002 review snapshot \(retained as provenance, not a current denominator\): PDP1-002 recorded 14 proposals:[\s\S]*?14 exact proposed\s+operation refs and 132 unresolved; none was marked ambiguous/u);
  assert.match(gap, /PDP1 proposes 17 family links and\s+leaves 26 unresolved/u);
  assert.match(gap, /owner acceptance of public wire\/client bindings,[\s\S]*?remains open[\s\S]*?current classification in gap-current-status\.yaml/u);
  assert.match(closureMatrix, /14 exact proposed operation refs, zero ambiguous links, and 132 unresolved/u);
  assert.match(closureMatrix, /17 proposed family refs and 26 unresolved identities/u);
  assert.match(dashboard, /^observationDate: '2026-10-08'$/mu);
  assert.match(dashboard, /- id: domain-objects\n      target: all-applicable\n      observed: 38/u);
  assert.match(dashboard, /- id: logical-operations\n      target: all-applicable\n      observed: 14/u);
  assert.match(dashboard, /- id: templates\n      target: all-applicable\n      observed: 13/u);
  assert.match(dashboard, /- id: layouts\n      target: all-applicable\n      observed: 11/u);
  assert.match(decisionLog, /2026-10-08 source-status update:[\s\S]*?Fourteen of 146 UI actions[\s\S]*?17 proposed\s+family refs and 26 unresolved identities/u);
  assert.match(acceptance, /These source links remain proposals; no operation semantics, mappings, runtime reachability, or wire behavior are accepted/u);
});

test("PDP1 event inventory preserves lifecycle and local-client populations without inventing contracts", () => {
  const eventData = readYaml(".product-experience/pdp-1-domain-data/events.yaml");
  const evidenceData = readYaml(".product-experience/pdp-1-domain-data/evidence.yaml");
  const provenanceData = readYaml(".product-experience/pdp-1-domain-data/provenance.yaml");
  const operationsData = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");
  const lifecycle = eventData.observedEnvelope.lifecyclePublisherInventory;
  const client = eventData.observedEnvelope.clientNotificationInventory;
  const proposals = lifecycle.evidenceProvenanceProposals;
  const evidenceBindings = evidenceData.eventEvidenceBindings.eventBindings;
  const provenanceBindings = provenanceData.eventProvenanceObservations.eventBindings;
  const runtimeSource = readFileSync(resolve(root, "launcher/src/main/java/com/ghatana/media/launcher/MediaRuntime.java"), "utf8");
  const clientSource = readFileSync(resolve(root, "libs/audio-video-client/src/index.ts"), "utf8");
  const clientRegistry = readYaml(".product-experience/pdp-3-product-experience/events/event-registry.yaml");
  const lifecycleTypes = [
    "media.upload.started", "media.artifact.completed", "media.job.accepted", "media.job.cancelled",
    "media.job.cancel_requested", "media.stream.opened", "media.stream.closed", "media.job.completed", "media.job.failed",
  ];
  assert.equal(lifecycle.publisherCallSites, 7);
  assert.equal(lifecycle.concreteEventTypes, 9);
  assert.equal(lifecycle.classification, "source-observed-implementation-inventory; not-canonical-taxonomy");
  assert.deepEqual(lifecycle.records.map(({ eventType }) => eventType), lifecycleTypes);
  assert.equal([...runtimeSource.matchAll(/publishLifecycle\(/gu)].length - 1, 7, "runtime retains seven publisher call sites plus method declaration");
  assert.match(runtimeSource, /"media\.job\." \+ terminal\.status\(\)\.name\(\)\.toLowerCase/u);
  assert.match(runtimeSource, /JobStatus\.COMPLETED/u);
  assert.match(runtimeSource, /JobStatus\.FAILED/u);
  assert.match(lifecycle.sharedPublisher, /dynamic media\.job\.<status>/u);
  assert.equal(lifecycle.canonicalTaxonomy, "unresolved");
  assert.equal(lifecycle.perEventProducerAuthority, "unresolved");

  const clientEvents = readYaml(".product-experience/pdp-3-product-experience/events/event-registry.yaml").events;
  const clientNames = clientEvents.map(({ eventName }) => eventName);
  assert.equal(client.count, 15);
  assert.equal(client.records.length, 15);
  assert.equal(new Set(clientNames).size, 15);
  for (const name of clientNames) {
    assert.ok(client.records.some(({ eventName }) => eventName === name), `event inventory missing ${name}`);
    assert.ok(clientSource.includes(`'${name}'`), `client source no longer emits ${name}`);
  }
  assert.equal(client.delivery, "local-client-listener-bus; durable-Event-Plane-publication-not-established");
  assert.equal(client.relationToLifecyclePublisher, "separate-population; not-equivalent");
  assert.ok(operationsData.channelFamilies.event.includes("15 separate local client-listener notifications"));
  assert.ok(operationsData.channelFamilies.event.includes("7 runtime publisher call sites/9 concrete event types; populations are not equivalent"));

  const expectedSourceRefs = [
    ["media.upload.started", "MediaRuntime.java#L275-L280", "UploadSession", "session.uploadId", "literal-1"],
    ["media.artifact.completed", "MediaRuntime.java#L321-L328", "MediaArtifact", "artifact.artifactId", "literal-1"],
    ["media.job.accepted", "MediaRuntime.java#L404-L410", "ProcessingJob", "accepted.jobId", "accepted.version"],
    ["media.job.cancelled", "MediaRuntime.java#L472-L506", "ProcessingJob", "current.jobId", "stored.version"],
    ["media.job.cancel_requested", "MediaRuntime.java#L472-L506", "ProcessingJob", "current.jobId", "stored.version"],
    ["media.stream.opened", "MediaRuntime.java#L532-L536", "StreamSession", "sessionId", "session.version"],
    ["media.stream.closed", "MediaRuntime.java#L672-L678", "StreamSession", "sessionId", "closed.version"],
    ["media.job.completed", "MediaRuntime.java#L1211-L1218", "ProcessingJob", "value.jobId", "terminal.version"],
    ["media.job.failed", "MediaRuntime.java#L1211-L1218", "ProcessingJob", "value.jobId", "terminal.version"],
  ];
  assert.deepEqual(proposals.records.map(({ eventType }) => eventType), lifecycleTypes);
  assert.deepEqual(evidenceBindings.records.map(({ eventType }) => eventType), lifecycleTypes);
  assert.deepEqual(provenanceBindings.records.map(({ eventType }) => eventType), lifecycleTypes);
  for (const [type, sourceSuffix, domainType, aggregateIdentity, aggregateVersion] of expectedSourceRefs) {
    const proposal = proposals.records.find((row) => row.eventType === type);
    const evidence = evidenceBindings.records.find((row) => row.eventType === type);
    const provenance = provenanceBindings.records.find((row) => row.eventType === type);
    assert.ok(proposal, `missing event proposal ${type}`);
    assert.ok(proposal.sourceObservation.sourceRef.endsWith(sourceSuffix), `${type} proposal must cite its exact source call site`);
    assert.equal(proposal.aggregateProposal.identity, aggregateIdentity, `${type} aggregate identity mapping`);
    assert.ok(String(proposal.aggregateProposal.version).startsWith(aggregateVersion), `${type} aggregate version mapping`);
    assert.match(proposal.evidenceStatus, /^source-observation-candidate-only; .+/u);
    assert.equal(proposal.policySemantics, "pending-owner-review");
    assert.ok(evidence.sourceObservationCandidate.endsWith(sourceSuffix));
    assert.ok(evidence.sourceDomainRecordCandidate.includes(domainType));
    assert.equal(evidence.finalityAndDelivery, "unavailable");
    assert.ok(provenance.sourceRef.endsWith(sourceSuffix));
    assert.ok(provenance.aggregate.type.includes(domainType.replace("ProcessingJob", "job").replace("MediaArtifact", "artifact").replace("UploadSession", "upload").replace("StreamSession", "stream")));
    assert.equal(provenance.policyStatus, "pending-owner-review");
  }

  assert.equal(proposals.status, "source-observation-candidates-only; not-committed-event-evidence");
  assert.equal(evidenceBindings.status, "proposal-only; pending-owner-review");
  assert.equal(provenanceBindings.status, "proposal-only; pending-owner-review");
  assert.ok(evidenceBindings.commonUnavailableEvidence.includes("authoritative-finality"));
  assert.ok(evidenceBindings.commonUnavailableEvidence.includes("durable-delivery-receipt"));
  assert.ok(provenanceBindings.commonUnknowns.includes("immutable-version-identity"));
  assert.equal(eventData.observedEnvelope.fieldObservations.attributes.semanticPiiRedactionAndEventSpecificMinimization, "unresolved");
  assert.equal(eventData.observedEnvelope.wireObservations.eventVersion.status, "exact-publisher-value-equals-each-owner-event-schema-const");
  assert.equal(eventData.observedEnvelope.wireObservations.eventVersion.value, "1.0.0");
  assert.equal(eventData.observedEnvelope.wireObservations.eventVersion.mapping.type, "identity");
  assert.equal(eventData.ownerEventContracts.records.length, 9);
  assert.ok(eventData.ownerEventContracts.records.every(({ eventVersion }) => eventVersion === "1.0.0"));
  assert.equal(eventData.observedEnvelope.wireObservations.publicationFailure.behavior, "runtime-logs-unconfirmed-and-continues; outbox-retry-replay-and-recovery-contract: not-established");
  assert.ok(eventData.observedEnvelope.excludedEventShapedSources.some(({ sourceRef, classification }) => sourceRef.includes("CrossModalEvent.event_type") && classification === "message-content-examples-not-lifecycle-publication"));
  assert.ok(eventData.observedEnvelope.excludedEventShapedSources.some(({ classification }) => classification === "test-payload-strings-not-production-publication"));
});

test("PDP1-005 registries preserve observed facts, proposal boundaries, and owner gates", () => {
  const registryRoot = resolve(root, ".product-experience/pdp-1-domain-data");
  const readRegistry = (name) => readFileSync(resolve(registryRoot, name), "utf8");
  const versioning = readRegistry("versioning.yaml");
  const privacy = readRegistry("privacy.yaml");
  const offlineSync = readRegistry("offline-sync.yaml");
  const interoperability = readRegistry("interoperability.yaml");
  const authority = readRegistry("authority.yaml");
  const decisions = readRegistry("decisions.yaml");
  const domainModel = readRegistry("DOMAIN-MODEL.md");

  for (const [name, content] of Object.entries({ versioning, privacy, offlineSync, interoperability, authority, decisions })) {
    assert.match(content, /^schemaVersion: media\.pdp-1\./mu, `${name} must be a PDP-1 registry`);
  }

  assert.match(versioning, /sourceRefs:.*launcher\/src\/main\/java\/com\/ghatana\/media\/launcher\/MediaRuntime\.java/u);
  assert.match(versioning, /sourceRefs:.*modules\/infrastructure\/persistence\/src\/main\/resources\/db\/migration\/V1__init_schema\.sql/u);
  assert.match(versioning, /source-artifact-immutability[\s\S]*?status: unresolved;/u);
  assert.match(versioning, /derived-artifact-identity[\s\S]*?status: unresolved;/u);
  assert.match(versioning, /checksum-and-sourceArtifactIds-fields; neither-proves-immutable-source-bytes-canonical-version-identity-or-complete-ancestry/u);
  assert.match(versioning, /run-and-attempt-history[\s\S]*?do-not-claim-durable-attempt-history/u);
  assert.match(versioning, /job-version-and-lease-fencing-do-not-establish-durable-attempt-history/u);
  assert.match(versioning, /startup-handler-marks-recoverable-persisted-nonterminal-jobs-OUTCOME_UNKNOWN-without-failure-code-or-completion-timestamp; this-is-not-outcome-reconciliation/u);
  assert.match(versioning, /cancellation-uncertainty-is-represented-but-resolution-and-finality-semantics-remain-unaccepted/u);
  assert.match(versioning, /canonical-version-reference-and-consumer-contract-pending/u);

  assert.match(privacy, /consentModel:\n  status: proposal-only;/u);
  assert.match(privacy, /atomic-revocation-propagation-to-in-flight-jobs-stream-frames-caches-and-delegated-provider-work/u);
  assert.match(privacy, /bounded-purge-cycle-accepts-a-clock-instant-and-returns-deletion-counts/u);
  assert.match(privacy, /complete-inventory-of-primary-replica-backup-cache-export-and-provider-held-copies/u);
  assert.match(privacy, /deletion-from-provider-systems-or-proof-of-provider-side-erasure/u);
  assert.match(authority, /purge-counts-or-runtime-readiness-are-not-proof/u);

  const offlineSyncDefinition = parseYaml(offlineSync);
  const offlineSemantics = offlineSyncDefinition.ownerDefinedOfflineSemantics;
  assert.equal(offlineSemantics.scopeStatus, "OWNER_DEFINED_PRODUCT_SEMANTICS; offline capability admission and device-security review pending");
  assert.match(offlineSemantics.queuePolicy, /No consequential command is queued for automatic replay/u);
  assert.ok(offlineSemantics.reconnectProtocol.some((rule) => /submit only a new explicit request with a fresh idempotency identity/u.test(rule)));
  assert.match(offlineSemantics.idempotencyGuard.ambiguousOutcome, /preserve UNKNOWN_OUTCOME and prohibit blind replay/u);
  assert.ok(offlineSemantics.nonClaims.includes("No automatic background synchronization"));
  assert.equal(offlineSyncDefinition.semantics.status, "owner-defined-product-semantics; runtime-and-platform-admission-not-established");
  assert.match(offlineSync, /durableLocalQueue: not-established/u);
  assert.match(offlineSync, /safeReplay: not-established/u);
  assert.match(offlineSync, /providerOutcomeReconciliation: not-established/u);
  assert.match(offlineSync, /jobVersionIsNotArtifactVersionOrAttemptHistory: true/u);

  assert.match(interoperability, /job-version-does-not-establish-durable-attempt-history-or-artifact-version-identity/u);
  assert.match(interoperability, /cross-product/u);
  assert.match(versioning, /cross-boundary-references[\s\S]*?canonical-version-reference-and-consumer-contract-pending/u);

  assert.match(authority, /^proposalStatus: proposal-only;/mu);
  assert.match(authority, /deployed-identity-and-delegation-provider-binding-not-established/u);
  assert.match(authority, /storage-and-provider-owners-own-deletion-mechanics-and-evidence/u);
  assert.match(decisions, /id: media\.pdp1\.decision\.artifact-version-and-lineage[\s\S]*?state: OWNER_DEFINED_LOGICAL_MEANING; independent-acceptance-pending/u);
  assert.match(decisions, /independent-P0-010-acceptance/u);
  assert.match(decisions, /offline-sync-and-runtime-owners-define-durable-recovery-provider-outcome-reconciliation-and-any-runtime-admission/u);

  const normalizedDomainModel = domainModel.replaceAll(/\s+/gu, " ");
  assert.ok(normalizedDomainModel.includes("currentDefinitionAdjudication` separately defines scoped Media logical meanings, including ArtifactVersion identity and exact-version ancestry, while leaving persistence, external authority, consumer compatibility, and independent acceptance distinct"));
  assert.ok(normalizedDomainModel.includes("`ArtifactVersion` has a current Media owner-defined logical identity and lineage rule in `canonical-reconciliation.yaml#currentDefinitionAdjudication` and `versioning.yaml#ownerDefinedRevisionSemantics/artifactVersion`; the inspected runtime still does not establish a separate persisted version record"));
});

test("PDP1 state and transition extraction remains proposal-only and preserves unresolved source conflicts", () => {
  const states = readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/states.yaml"), "utf8");
  const transitions = readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/transitions.yaml"), "utf8");
  const source = readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/state-models.yaml"), "utf8");
  const domainModel = readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/DOMAIN-MODEL.md"), "utf8");

  const parsedStates = readYaml(".product-experience/pdp-1-domain-data/states.yaml");
  const parsedTransitions = readYaml(".product-experience/pdp-1-domain-data/transitions.yaml");
  assert.equal(parsedStates.authorityStatus, "proposal-only; owner-review-pending; P0-010-independent-acceptance-pending");
  assert.equal(parsedTransitions.authorityStatus, parsedStates.authorityStatus);
  assert.equal(parsedStates.inventory.sourceMachineRecords, 11);
  assert.equal(parsedStates.inventory.extractedMachineRecords, 11);
  assert.equal(parsedStates.inventory.sourceStateRecords, 75);
  assert.equal(parsedStates.inventory.extractedStateRecords, 75);
  assert.equal(parsedStates.stateMachines.length, 11);
  assert.equal(parsedStates.stateMachines.reduce((sum, machine) => sum + machine.stateIds.length, 0), 75);
  const rights = parsedStates.stateMachines.find(machine => machine.machineId === "media-rights-and-consent");
  assert.deepEqual(rights.stateIds, []);
  assert.equal(rights.stateCount, 0);
  assert.equal(Object.values(rights.stateDefinitionsByDimension).flat().length, 12, "new rights definitions remain separate from historical extraction");
  assert.match(rights.ownerSemanticDisposition, /no-legal-licensor-authority-claimed; independent-review-open; runtime-not-admitted/u);
  for (const id of ["RETRY_PENDING", "RETRYING", "CANCEL_REQUESTED", "CANCELLING", "OUTCOME_UNKNOWN", "RECONCILING", "PARTIALLY_SUCCEEDED"]) assert.ok(states.includes(id));
  for (const id of ["state-conflict.retry-pending-vs-retrying", "state-conflict.cancel-requested-vs-cancelling", "state-conflict.unknown-reconciling-partial-outcomes"]) assert.ok(states.includes(id));
  assert.match(states, /mappingDisposition: unresolved/u);
  assert.match(states, /lossy-implementation-observed/u);
  assert.equal(parsedStates.authorityBoundary.projectionRule, "React, TypeScript, OpenAPI, protobuf, Java, and runtime projections do not independently define product state");
  assert.match(states.replace(/\s+/gu, " "), /no matching job-lifecycle state enum was found in the four inspected active Media service proto files/u);
  assert.equal(parsedTransitions.inventory.sourceMachineRecords, 11);
  assert.equal(parsedTransitions.inventory.transitionRecords, 49);
  assert.equal(parsedTransitions.transitionRecords.length, 49);
  assert.equal(new Set(parsedTransitions.transitionRecords.map(record => record.id)).size, 49);
  for (const record of parsedTransitions.transitionRecords) {
    assert.equal(record.eventTriggers, "pending-PDP1-004");
    assert.equal(record.permissions, "pending-owner-contracts");
    assert.equal(record.executionEffects, "pending-runtime-and-platform-owner-contracts");
  }
  const job = parsedTransitions.transitionRecords.find(record => record.id === "media-job/T03");
  assert.deepEqual(job.from, ["RETRY_PENDING"]);
  assert.deepEqual(job.to, ["RUNNING", "CANCELLED", "FAILED", "OUTCOME_UNKNOWN"]);
  const attempt = parsedTransitions.transitionRecords.find(record => record.id === "media-attempt/T05");
  assert.deepEqual(attempt.from, ["CANCEL_REQUESTED"]);
  assert.deepEqual(attempt.to, ["CANCEL_CONFIRMED", "SUCCEEDED", "FAILED", "OUTCOME_UNKNOWN", "SUPERSEDED"]);
  assert.match(domainModel, /PDP1-003 state\/transition extraction verification/u);
  assert.match(domainModel.replace(/\s+/gu, " "), /it does not verify runtime behavior, select a canonical projection, accept meanings, or establish phase completion/u);

});

test("PDP-1 negative state cases encode owner-approved non-equivalences without claiming runtime proof", () => {
  const adjudication = readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/state-adjudication.yaml"), "utf8");
  assert.match(adjudication, /^  status: canonical-policy-tests; does-not-verify-runtime-or-provider-behavior$/mu);
  for (const [caseId, forbidden] of [
    ["state-identity.same-spelling-different-machine", "infer-state-equivalence"],
    ["ingress.ACCEPTED-is-not-job.QUEUED", "assert-durable-queue-eligibility"],
    ["retry.RETRY_PENDING-is-not-attempt-execution", "assert-new-attempt-claimed-or-dispatched"],
    ["cancellation.CANCEL_REQUESTED-is-not-CANCELLED", "assert-job-cancellation-finality"],
    ["finality.OUTCOME_UNKNOWN-is-not-RUNNING", "normalize-to-RUNNING-or-authorize-replay"],
    ["finality.PARTIALLY_SUCCEEDED-requires-closed-sub-effects", "assert-terminal-partial-success"],
    ["delivery.COMPLETED-is-not-ACKNOWLEDGED", "assert-recipient-delivery-acknowledgment"],
  ]) {
    const escaped = caseId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(adjudication, new RegExp(`- id: ${escaped}[\\s\\S]*?mustNot: ${forbidden}`, "u"));
  }
});

test("PDP-0 YAML source preserves corrected indentation and symbol-scoped OCR disposition (text checks only)", () => {
  const capabilities = readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/capabilities.yaml"), "utf8");
  const requirements = readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/requirements.yaml"), "utf8");
  const ocr = readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/ocr-ownership.yaml"), "utf8");
  assert.equal(readYaml(".product-experience/pdp-0-product-truth/capabilities.yaml").families.find(record => record.id === "media.project").scopeStatus, "TARGET");
  assert.equal(readYaml(".product-experience/pdp-0-product-truth/requirements.yaml").requirements.find(record => record.id === "MEDIA-REQ-CAP-PROJECT").scopeStatus, "TARGET");

  for (const [recordId, method, excludedMethods] of [
    ["media.ocr.vision-model-engine", "VisionModelEngine.extractText", [
      "VisionModelEngine.detectObjects",
      "VisionModelEngine.classify",
      "VisionModelEngine.detectFaces",
    ]],
    ["media.ocr.vision-detector-contract", "VisionDetector.extractText", [
      "VisionDetector.detectObjects",
      "VisionDetector.classify",
      "VisionDetector.detectFaces",
    ]],
  ]) {
    const record = readYaml(".product-experience/pdp-0-product-truth/ocr-ownership.yaml").classifications.find(record => record.id === recordId);
    assert.ok(record, `missing OCR classification ${recordId}`);
    assert.equal(record.scope, "symbol");
    assert.equal(record.symbol, method);
    assert.match(record.exclusionStatement, /outside this OCR disposition and remain governed by their owning vision definitions/u);
    assert.deepEqual(record.excludedSymbols, excludedMethods);
  }
});

test("scope-status validation never infers compatibility from nearby wording", () => {
  const path = ".product-experience/pdp-0-product-truth/capabilities.yaml";
  const missing = "- id: media.compatibility\n  description: compatibility is supported\n";
  assert.throws(() => validateScopeStatuses(missing, path), /missing explicit scopeStatus/u);

  const explicitTarget = "- id: media.compatibility\n  scopeStatus: TARGET\n  description: compatibility is supported\n";
  assert.equal(validateScopeStatuses(explicitTarget, path), explicitTarget);
});

test("nested journey records each require exactly one allowed scopeStatus", () => {
  const path = ".product-experience/pdp-0-product-truth/journey-catalog.yaml";
  const validJourney = "journeys:\n  - id: J-01\n    scopeStatus: TARGET\n    title: Example\n";
  assert.equal(validateScopeStatuses(validJourney, path), validJourney);

  const missingJourney = "journeys:\n  - id: J-01\n    title: Example\n";
  assert.throws(() => validateScopeStatuses(missingJourney, path), /missing explicit scopeStatus.*J-01/u);

  const duplicateJourney = `${validJourney.trimEnd()}\n    scopeStatus: TARGET\n`;
  assert.throws(() => validateScopeStatuses(duplicateJourney, path), /duplicate scopeStatus.*J-01/u);

  const invalidJourney = validJourney.replace("TARGET", "SUPPORTED");
  assert.throws(() => validateScopeStatuses(invalidJourney, path), /invalid scopeStatus SUPPORTED.*J-01/u);
  assert.throws(() => validateScopeStatuses(validJourney, path, undefined, 30), /found 1 records; expected 30/u);
});

test("Explorer index exposes source paths without workstation identity", () => {
  const index = JSON.parse(readFileSync(resolve(root, "apps/media-experience-explorer/specification-artifacts.json"), "utf8"));
  assert.equal(index.filter((artifact) => artifact.phase === "PDP-3" && artifact.path.includes("/screen-contracts/")).length, 48);
  assert.ok(index.some((artifact) => artifact.path === ".product-experience/source-manifest.yaml"));
  assert.equal(index.some((artifact) => artifact.path.startsWith("/")), false);
});

test("generated Explorer index covers every current source-manifest artifact exactly once", () => {
  const manifest = readFileSync(resolve(root, ".product-experience/source-manifest.yaml"), "utf8");
  const index = JSON.parse(readFileSync(resolve(root, "apps/media-experience-explorer/specification-artifacts.json"), "utf8"));
  const gaps = readFileSync(resolve(root, ".product-experience/gaps.yaml"), "utf8");
  const sourceRecords = [...manifest.matchAll(/^  - artifactId: ([^\s]+)\n(?:.*\n){0,20}?    owningPhase: ([^\n]+)\n    path: ([^\n]+)$/gmu)]
    .map(([, artifactId, phase, path]) => ({ artifactId, phase: phase.trim(), path: path.trim() }));
  const indexedSourceRecords = index.filter((artifact) => artifact.path !== ".product-experience/source-manifest.yaml");
  const byPath = new Map(indexedSourceRecords.map((artifact) => [artifact.path, artifact]));

  assert.equal(byPath.size, indexedSourceRecords.length, "each canonical source path must occur once");
  assert.deepEqual([...byPath.keys()].sort(), sourceRecords.map(({ path }) => path).sort(), "index paths must exactly match generated source-manifest paths");
  assert.equal(index.length, sourceRecords.length + 1, "Explorer index must include each source artifact plus its manifest projection");
  assert.ok(gaps.includes(`Current generated source index: ${sourceRecords.length} source-derived records plus the manifest projection (${index.length} total)`),
    "active Explorer gap mirrors must report the current source and index denominators");
  for (const record of sourceRecords) {
    assert.deepEqual(
      { artifactId: byPath.get(record.path)?.artifactId, phase: byPath.get(record.path)?.phase },
      { artifactId: record.artifactId, phase: record.phase },
      `${record.path} must retain its canonical identity and owner phase in Explorer navigation`,
    );
  }

  const sourcePaths = [];
  const visit = (directory) => {
    for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (path !== ".product-experience/source-manifest.yaml" && path !== ".product-experience/artifact-identities.yaml") sourcePaths.push(path);
    }
  };
  visit(".product-experience");
  assert.deepEqual(sourceRecords.map(({ path }) => path).sort(), sourcePaths.sort(), "manifest inventory must expose every active source file");
});

test("HTTP route, SDK, and interface projections retain canonical ownership", () => {
  const result = spawnSync(process.execPath, ["scripts/check-media-contract-parity.mjs"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /Media contract parity: NON-GREEN/u);
  assert.match(output, /"openapiRoutes":27,"runtimeRoutes":27,"httpRegistryRoutes":27/u);
  assert.match(output, /semantic binding: UNRESOLVED/u);
  assert.match(output, /source findings audited: 47 \(46 dispositioned; 1 unresolved\)/u);
  assert.match(output, /source-dispositioned findings: 46/u);
  assert.match(output, /historical source findings: 52 \(51 dispositioned; 1 unresolved; 5 retired routes\)/u);
});

test("screen composition records retain Shared-boundary design metadata", () => {
  const result = spawnSync(process.execPath, ["scripts/check-media-design-conformance.mjs"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /Media design conformance BLOCKED/u);
  assert.match(output, /\d+ unexplained findings across \d+ root causes/u);
  assert.match(output, /design-governance gate shared-artifact-binding remains EXTERNAL_PENDING/u);
  assert.match(output, /design-governance gate conformance-and-specialist-review remains INDEPENDENT_PENDING/u);
  assert.doesNotMatch(output, /design-governance gate concrete-component-bindings remains SOURCE_INCOMPLETE/u);
});

test("PDP2-002 GUI pattern registry covers every required category without inventing destructive semantics", () => {
  const guiRoot = resolve(root, ".product-experience/pdp-2-design-interface-system/gui");
  const catalog = readFileSync(resolve(guiRoot, "patterns/catalog.yaml"), "utf8");
  const templates = readFileSync(resolve(guiRoot, "templates/catalog.yaml"), "utf8");
  const requiredPatternIds = [
    "media.gui.pattern.project-browser",
    "media.gui.pattern.upload-and-verification",
    "media.gui.pattern.job-status-and-recovery",
    "media.gui.pattern.review-approval",
    "media.gui.pattern.source-picker",
    "media.gui.pattern.transcript-and-playback",
    "media.gui.pattern.caption-editor",
    "media.gui.pattern.version-comparison",
    "media.gui.pattern.provenance-and-lineage",
    "media.gui.pattern.rights-and-consent-review",
    "media.gui.pattern.rendering",
    "media.gui.pattern.safe-confirmation-and-unknown-outcome",
    "media.gui.pattern.intent-launcher",
    "media.gui.pattern.activity-attention",
    "media.gui.pattern.destructive-lifecycle-action",
  ];
  const listedPatternIds = [...catalog.matchAll(/^  - id: (media\.gui\.pattern\.[a-z0-9-]+)$/gmu)].map((match) => match[1]);
  assert.equal(new Set(listedPatternIds).size, listedPatternIds.length, "pattern IDs must be unique");
  for (const id of requiredPatternIds) assert.ok(listedPatternIds.includes(id), `missing required pattern ${id}`);
  const templateIds = new Set([...templates.matchAll(/^  - id: (media\.gui\.template\.[a-z0-9-]+)$/gmu)].map((match) => match[1]));

  for (const id of [
    "activity-attention",
    "review-approval",
    "rendering",
    "destructive-lifecycle-action",
  ]) {
    const proposal = readFileSync(resolve(guiRoot, "patterns", `${id}.yaml`), "utf8");
    assert.match(proposal, /^schemaVersion: media\.gui-pattern\.v1$/mu, id);
    assert.match(proposal, /^id: media\.gui\.pattern\./mu, id);
    assert.match(proposal, /^sourceRefs:/mu, id);
    assert.ok(catalog.includes(`sourceRef: .product-experience/pdp-2-design-interface-system/gui/patterns/${id}.yaml#media.gui.pattern.${id}`), id);
  }

  for (const id of [
    "media.gui.pattern.activity-attention",
    "media.gui.pattern.review-approval",
    "media.gui.pattern.rendering",
    "media.gui.pattern.destructive-lifecycle-action",
  ]) assert.ok(templates.includes(id), `no template references ${id}`);

  const reviewOutputs = readFileSync(resolve(root, ".product-experience/pdp-3-product-experience/screen-contracts/review-outputs.yaml"), "utf8");
  const prepareRender = readFileSync(resolve(root, ".product-experience/pdp-3-product-experience/screen-contracts/prepare-render.yaml"), "utf8");
  const reviewActivity = readFileSync(resolve(root, ".product-experience/pdp-3-product-experience/screen-contracts/review-activity.yaml"), "utf8");
  assert.ok(reviewOutputs.includes("media.gui.pattern.review-approval"));
  assert.ok(prepareRender.includes("media.gui.pattern.rendering"));
  assert.ok(reviewActivity.includes("media.gui.pattern.activity-attention"));
  for (const [screen, content] of [["review-outputs", reviewOutputs], ["prepare-render", prepareRender], ["review-activity", reviewActivity]]) {
    const templateRef = content.match(/^  templateRef: (\S+)$/mu)?.[1];
    assert.ok(templateRef && templateIds.has(templateRef), `${screen} templateRef must resolve in the PDP-2 GUI template catalog`);
  }

  const destructive = readFileSync(resolve(guiRoot, "patterns/destructive-lifecycle-action.yaml"), "utf8");
  assert.match(destructive, /No supported artifact-deletion action or operation is established/u);
  assert.match(destructive, /media\.action\.remove-storyboard-scene is a scene-editing action/u);
  assert.match(destructive, /media\.action\.revoke-authorized-consent/u);
  assert.match(destructive, /^status: proposal; operation semantics, owner bindings, accessibility, and implementation pending$/mu);
});

test("PDP2-004/005 interface registries are complete proposals with owner and runtime boundaries explicit", () => {
  const designRoot = resolve(root, ".product-experience/pdp-2-design-interface-system");
  const apiNames = [
    "conventions", "errors", "auth", "identifiers", "pagination", "filtering-sorting", "idempotency",
    "concurrency", "async-operations", "cancellation", "retry-timeout-unknown-outcome", "correlation",
    "compatibility", "versioning", "http-canonical-adapters",
  ];
  const apiFiles = new Map(apiNames.map((name) => [name, readFileSync(resolve(designRoot, `api/${name}.yaml`), "utf8")]));
  const apiConventions = apiFiles.get("conventions");
  assert.match(apiConventions, /scopeStatus: proposal-only/u);
  assert.match(apiConventions, /OpenAPI is a transport\/schema projection of approved rules and operation bindings/u);
  assert.match(apiConventions, /not an independent source of product semantics/u);
  assert.match(apiFiles.get("async-operations"), /this proposal establishes no durable storage or retention guarantee/u);
  assert.match(apiFiles.get("idempotency"), /state the implemented retention only after runtime binding/u);

  // Keep the API convention index closed over the actual protocol files, while
  // preserving the proposal boundary until operation owners accept bindings.
  const related = apiConventions.match(/^relatedConventions: \[(.*)\]$/mu)?.[1]
    .split(", ").map((name) => name.replace(/\.yaml$/u, ""));
  assert.deepEqual(related, apiNames.slice(1), "API convention index must resolve every convention exactly once");
  for (const [name, content] of apiFiles) {
    assert.match(content, /^owner: [^\n]+$/mu, `${name} must identify its semantic owner`);
    assert.match(content, /^scopeStatus: proposal(?:-only)?(?:;|$)/mu, `${name} must remain visibly proposed`);
    assert.match(content, /^acceptance: \{criteria: \[[^\]]+\], status: pending[^}]*\}$/mu, `${name} must retain pending owner acceptance`);
    for (const ref of content.matchAll(/^sourceRefs: \[([^\]]*)\]$/gmu)) {
      for (const item of ref[1].split(", ")) {
        if (item.startsWith(".product-experience/pdp-2-design-interface-system/api/")) {
          const target = item.slice(".product-experience/pdp-2-design-interface-system/api/".length).replace(/\.yaml$/u, "");
          assert.ok(apiFiles.has(target), `${name} references missing API convention ${target}`);
        }
      }
    }
  }

  const cli = readFileSync(resolve(designRoot, "cli/conventions.yaml"), "utf8");
  const sdk = readFileSync(resolve(designRoot, "sdk/conventions.yaml"), "utf8");
  const events = readFileSync(resolve(designRoot, "events/conventions.yaml"), "utf8");
  const agentTools = readFileSync(resolve(designRoot, "agent-tools/conventions.yaml"), "utf8");
  assert.match(cli, /production-runtime-cli-not-connected/u);
  assert.match(cli, /process exit status reports the CLI invocation\/observation result; domain state and effect finality are separate/u);
  assert.match(sdk, /canonical mapping is unresolved/u);
  assert.match(events, /runtimeLifecyclePublishers:[\s\S]*?count: 9[\s\S]*?clientLocalNotifications:[\s\S]*?count: 15/u);
  assert.match(events, /not Event Plane publication or runtime lifecycle event taxonomy/u);
  assert.match(events, /scopeStatus: proposal; conventions below are design constraints, not an accepted event contract/u);
  assert.match(events, /exactly-once-or-at-least-once-delivery/u);

  const requiredToolFields = [
    "canonicalToolId", "inputSchema", "resultSchema", "authorityAndDelegation", "idempotency",
    "timeout", "cancellation", "unknownOutcome", "evidence", "safeFailure",
  ];
  const inventory = agentTools.split("observedHandlerInventory:")[1]?.split("\nadmissionGates:")[0];
  assert.ok(inventory, "missing observed handler inventory");
  const toolRecords = inventory.split(/\n    - canonicalToolId: /u).slice(1);
  assert.equal(toolRecords.length, 4, "expected four observed handlers, not admitted tools");
  for (const field of requiredToolFields) assert.match(agentTools, new RegExp(`^    ${field}:$`, "mu"), `missing per-tool field ${field}`);
  for (const record of toolRecords) {
    for (const field of requiredToolFields.slice(1)) assert.ok(record.includes(`      ${field}:`), `observed handler missing ${field}`);
  }
  assert.match(agentTools, /After dispatch, a timeout or cancellation race returns outcome-unknown/u);
  assert.match(agentTools, /no tool is admitted, callable, or authorized by this convention/u);
});
