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
    assert.equal(consequence.bindingStatus, "source-defined-action-semantics; runtime-and-screen-admission-pending");
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
  const decision = ".product-experience/decision-log.md#PXD-072";
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
  assert.match(step.transitionDisposition.reason, /no job-state or attempt transition/u);
  assert.equal(step.definitionVerification.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(step.definitionVerification.runtimeVerification, "not-run");
  assert.equal(step.verification.status, "not-run");
  assert.deepEqual(step.verification.actualEvidence, []);
  assert.deepEqual(step.submissionSemantics.submitRequiredFields, ["requestId", "sourceArtifactId", "sourceArtifactVersionId", "languageIntent", "profileId", "profileVersion", "profileConfigurationDigest", "purpose", "consentRef", "rightsEvidenceRef", "retentionPolicyRef", "processingLocation"]);
  assert.deepEqual(step.submissionSemantics.reconcileRequiredFields, ["requestId", "requestFingerprint"]);
  assert.match(step.submissionSemantics.requestFingerprint.replay, /retain the complete validated canonical submit snapshot.*before first dispatch/u);
  assert.match(step.submissionSemantics.reconciliation, /separately rechecked current scoped receipt-read authority/u);
  assert.match(step.submissionSemantics.reconciliation, /does not authorize processing\/replay/u);
  assert.match(step.submissionSemantics.asynchronousBoundary, /no job state, provider execution, recognition completion/u);
  assert.match(step.submissionSemantics.retries, /no blind replay, no new key/u);
  const operation = readYaml(".product-experience/pdp-1-domain-data/operations.yaml").operations
    .find(({ id }) => id === "media.operation.transcription-submission");
  assert.ok(operation);
  assert.equal(operation.ownerDefinitionRef, sourceDecision);
  assert.deepEqual(step.submissionSemantics.submitRequiredFields, operation.inputSemantics.submitRequiredFields);
  assert.deepEqual(step.submissionSemantics.submitAllowedFields, operation.inputSemantics.submitAllowedFields);
  assert.deepEqual(step.submissionSemantics.reconcileAllowedFields, operation.inputSemantics.reconcileAllowedFields);
  assert.equal(step.submissionSemantics.branchFieldRule, operation.inputSemantics.branchFieldRule);
  assert.deepEqual(step.submissionSemantics.requestFingerprint.binds, operation.inputSemantics.requestFingerprint.fields);
  assert.deepEqual(step.submissionSemantics.acknowledgedFields, operation.outputSemantics.acknowledgedFields);
  const action = readYaml(".product-experience/pdp-3-product-experience/action-registry.yaml").actions
    .find(({ id }) => id === "media.action.request-transcription");
  assert.equal(action.actionDefinitionSemantics.operationRef, operation.id);
  assert.equal(action.actionDefinitionSemantics.sourceDecisionRef, sourceDecision);
  assert.equal(action.actionDefinitionSemantics.grammarDecisionRef, grammarDecision);
  assert.equal(action.actionDefinitionSemantics.reviewDecisionRef, decision);
  assert.equal(action.actionDefinitionSemantics.effectKind, "REQUEST_ACCEPTANCE");
  assert.equal(action.actionDefinitionSemantics.reversibility.kind, "UNKNOWN");
  assert.equal(action.actionDefinitionSemantics.publicBooleanDisposition, "PUBLIC_BOOLEAN_NOT_REPRESENTABLE");
  assert.equal(action.actionDefinitionSemantics.publicEffect, undefined);
  assert.equal(action.actionDefinitionSemantics.publicFinality, undefined);
  const binding = readYaml(".product-experience/pdp-3-product-experience/experience-source-bindings.yaml").j03TranscriptionSubmissionBindings;
  assert.equal(binding.reviewDecisionRef, decision);
  assert.equal(binding.runtimeAdmission, "NOT_ADMITTED");
  assert.deepEqual(binding.steps.map(({ stepId }) => stepId), ["J03-2"]);
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

test("canonical Media product-definition authority is structurally closed locally", () => {
  const output = execFileSync(process.execPath, ["scripts/check-product-definition-authority.mjs"], { cwd: root, encoding: "utf8" });
  assert.match(output, /authority check passed/u);
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
      assert.match(consequencesBody, /effectRef:\s*(?:null|unresolved)?\s*$/mu, `${screenId} must keep public effects null unless exactly source-defined`);
      if (screenId === "media.view.find-projects") {
        assert.deepEqual(consequenceIds, ["media.action.open-project", "media.action.create-project"]);
        assert.match(consequencesBody, /source-defined under PXD-054\/055; execution NOT_ADMITTED/u,
          `${screenId} bounded source definition cannot imply runtime admission`);
        assert.match(consequencesBody, /operationRef: media\.operation-slice\.inspect-project/u);
        assert.match(consequencesBody, /operationRef: media\.operation-slice\.create-project/u);
      } else {
        assert.match(consequencesBody, /(?:bindingStatus|status): pending/u, `${screenId} action consequences remain unresolved`);
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
  assert.match(fixtures, /content-payload-owned-by-PDP-3/u);
  assert.match(fixtures, /pdp3PayloadState:/u);
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
      const bindingStart = block.search(new RegExp(`^${fieldIndent}bindingStatus:\\s*$`, "mu"));
      assert.notEqual(bindingStart, -1, `${journeyId}/${stepId} missing bindingStatus mapping`);
      const bindingBlock = block.slice(bindingStart).split(new RegExp(`\\n${fieldIndent}[A-Za-z][A-Za-z0-9]*:`, "u"))[0];
      const bindingReason = bindingBlock.match(new RegExp(`^${fieldIndent}  reason:\\s*(.+)$`, "mu"))?.[1]?.trim();
      for (const field of required) {
        const directReason = bindingBlock.match(new RegExp(`^${fieldIndent}  ${field}:\\s*(.+)$`, "mu"))?.[1]?.trim();
        const listedReason = new RegExp(`^${fieldIndent}    - ${field}$`, "mu").test(bindingBlock);
        const fieldBlock = block.match(new RegExp(`^${fieldIndent}${field}:\\n([\\s\\S]*?)(?=^${fieldIndent}[A-Za-z][A-Za-z0-9]*:|$(?![\\s\\S]))`, "mu"))?.[1] ?? "";
        const localStatus = fieldBlock.match(/^\s+status: ([^\n]+)$/mu)?.[1];
        assert.ok(directReason || listedReason || localStatus,
          `${journeyId}/${stepId} missing binding status/reason for ${field}`);
        const reason = directReason ?? bindingReason ?? localStatus;
        const pendingReason = reason && /pending|candidate|unresolved|not-run|not-specified|not-accepted/iu.test(reason);
        const boundedDefinitionReason = (sourceDefinedJ01 && boundedJ01Validated
          && content.includes(".product-experience/decision-log.md#PXD-055")
          && content.includes("runtimeAdmission: NOT_ADMITTED"))
          || (sourceDefinedJ03 && boundedJ03SubmissionValidated && itemIndex === 1
            && content.includes(".product-experience/decision-log.md#PXD-070")
            && content.includes(".product-experience/decision-log.md#PXD-071")
            && content.includes(".product-experience/decision-log.md#PXD-072")
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
            && content.includes("runtimeAdmission: NOT_ADMITTED"));
        const externalIdentityHandoffReason = sourceDefinedJ01 && itemIndex === 0 && field === "handoffRef"
          && content.includes("runtimeAdmission: NOT_ADMITTED") && /external Shared identity contract only/iu.test(reason ?? "");
        assert.ok(pendingReason || boundedDefinitionReason || externalIdentityHandoffReason,
          `${journeyId}/${stepId} binding reason for ${field} must remain proposal/unresolved or pass its exact bounded source-definition and NOT_ADMITTED validation`);
      }
      const verificationBlock = block.match(new RegExp(`^${fieldIndent}verification:\\n([\\s\\S]*?)(?=^${fieldIndent}[A-Za-z][A-Za-z0-9]*:|$(?![\\s\\S]))`, "mu"))?.[1] ?? "";
      assert.match(verificationBlock, /^\s+status: not-run$/mu, `${journeyId}/${stepId} verification must remain not-run`);
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
  assert.equal(boundedJ03DraftValidated, true, "only J-03 steps 5 and 6 use the exact bounded caption-draft definition check");
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
  assert.equal(denominators.sdkMethods.registryRecords, 32);
  assert.equal(denominators.agentToolHandlers.count, 4);
  assert.equal(denominators.lifecycleEventNames.count, 15);
  assert.equal(parsed.ownerReview, "pending-owner-review");

});

test("active G-05 mirrors match current proposal counts without implying acceptance", () => {
  const acceptance = readFileSync(resolve(root, ".product-experience/acceptance.yaml"), "utf8");
  const gap = readFileSync(resolve(root, ".product-experience/gaps.yaml"), "utf8");
  const closureMatrix = readFileSync(resolve(root, ".product-experience/mandatory-surface-closure-matrix.yaml"), "utf8");
  const dashboard = readFileSync(resolve(root, ".product-experience/closure-dashboard.yaml"), "utf8");
  const decisionLog = readFileSync(resolve(root, ".product-experience/decision-log.md"), "utf8");

  assert.match(acceptance, /14 of 146 UI actions have exact proposed operation refs, zero are ambiguous, and 132 remain unresolved/u);
  assert.match(acceptance, /17 proposed family refs and 26 unresolved identities/u);
  assert.match(gap, /14 exact proposed\s+operation refs and 132 unresolved; none is ambiguous/u);
  assert.match(gap, /PDP1 proposes 17 family links and\s+leaves 26 unresolved/u);
  assert.match(gap, /Resolve the 132 unmatched UI action links; bind the 27 HTTP IDs and 26\s+gRPC identities/u);
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
  assert.equal(eventData.observedEnvelope.wireObservations.eventVersion.status, "publisher-implementation-observed; compatibility-schema-and-evolution-policy: unresolved");
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

  assert.match(offlineSync, /durableLocalQueue: not-established/u);
  assert.match(offlineSync, /safeReplay: not-established/u);
  assert.match(offlineSync, /conflictAndConcurrentEditPolicy: pending-owner-definition/u);
  assert.match(offlineSync, /providerOutcomeReconciliation: not-established/u);
  assert.match(offlineSync, /jobVersionIsNotArtifactVersionOrAttemptHistory: true/u);

  assert.match(interoperability, /job-version-does-not-establish-durable-attempt-history-or-artifact-version-identity/u);
  assert.match(interoperability, /cross-product/u);
  assert.match(versioning, /cross-boundary-references[\s\S]*?canonical-version-reference-and-consumer-contract-pending/u);

  assert.match(authority, /^proposalStatus: proposal-only;/mu);
  assert.match(authority, /deployed-identity-and-delegation-provider-binding-not-established/u);
  assert.match(authority, /storage-and-provider-owners-own-deletion-mechanics-and-evidence/u);
  assert.match(decisions, /Media-domain-owner-definition-of-version-key-lineage-and-cross-product-reference/u);
  assert.match(decisions, /independent-P0-010-acceptance/u);
  assert.match(decisions, /offline-sync-and-runtime-owners-define-conflict-authority/u);

  assert.match(domainModel, /An unaccepted PDP-0 lifecycle proposal separates authored specifications,[\s\S]*?proposed artifact versions/u);
  assert.match(domainModel, /does not establish canonical artifact-version identity/u);
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
  assert.match(output, /source findings audited: 47 \(45 dispositioned; 2 unresolved\)/u);
  assert.match(output, /source-dispositioned findings: 45/u);
  assert.match(output, /historical source findings: 52 \(50 dispositioned; 2 unresolved; 5 retired routes\)/u);
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
