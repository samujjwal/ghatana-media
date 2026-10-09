import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const root = '.product-experience/pdp-3-product-experience';
const { parse } = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url))('yaml');
const yaml = async (path) => parse(await readFile(path, 'utf8'));
const [journey, registry, bindings, correctScreen, editScreen, operations, grammar, counters] = await Promise.all([
  yaml(`${root}/journey-contracts/transcribe-and-correct-captions.yaml`),
  yaml(`${root}/action-registry.yaml`),
  yaml(`${root}/experience-source-bindings.yaml`),
  yaml(`${root}/screen-contracts/correct-captions.yaml`),
  yaml(`${root}/screen-contracts/edit-captions.yaml`),
  yaml('.product-experience/pdp-1-domain-data/operations.yaml'),
  yaml('.product-experience/pdp-2-design-interface-system/action-finality-grammar.yaml'),
  yaml(`${root}/journey-registry.yaml`),
]);

const action = (id) => registry.actions.find((entry) => entry.id === id);
const step = (id) => journey.steps.find((entry) => entry.stepId === id);
const consequence = (screen, id) => screen.actionConsequences.find((entry) => entry.actionId === id);
const operation = operations.operations.find((entry) => entry.id === 'media.operation.caption-draft-write');
const deepClone = (value) => structuredClone(value);
const assertBoundDraftStep = (selected, expectedId, expectedAction, editKind) => {
  assert.equal(selected.stepId, expectedId);
  assert.equal(selected.action, expectedAction);
  assert.equal(selected.canonicalOperationRef, 'media.operation.caption-draft-write');
  assert.deepEqual(selected.requiredOperationRefs, ['media.operation.caption-draft-write']);
  assert.equal(selected.draftEditSemantics.editKind, editKind);
  assert.deepEqual(selected.transitionDisposition, {
    status: 'NOT_APPLICABLE_WITH_REASON',
    transitionRef: null,
    reason: selected.transitionDisposition.reason,
  });
  assert.equal(selected.definitionVerification.runtimeAdmission, 'NOT_ADMITTED');
  if (editKind === 'TEXT_CORRECTION') {
    assert.deepEqual(selected.draftEditSemantics.allowedEditFields, ['text']);
    assert.equal(selected.draftEditSemantics.timingUnavailableAllowed, true);
  } else {
    assert.deepEqual(selected.draftEditSemantics.allowedEditFields, ['startTick', 'endTick']);
    assert.equal(selected.draftEditSemantics.timingUnavailableAllowed, false);
    assert.match(selected.draftEditSemantics.sourceClockRequirement, /authoritative sourceClockId/u);
  }
};
const assertBoundDraftAction = (selected, expectedId) => {
  const semantics = selected.actionDefinitionSemantics;
  assert.equal(selected.id, expectedId);
  assert.equal(semantics.actionRef, expectedId);
  assert.equal(semantics.operationRef, 'media.operation.caption-draft-write');
  assert.equal(semantics.effectKind, 'LOCAL_DRAFT_UPDATE');
  assert.equal(semantics.reversibility.kind, 'CONDITIONAL');
  assert.equal(semantics.publicBooleanDisposition, 'PUBLIC_BOOLEAN_NOT_REPRESENTABLE');
  assert.equal(semantics.publicEffect, undefined);
  assert.equal(semantics.publicFinality, undefined);
  assert.equal(semantics.runtimeAdmission, 'NOT_ADMITTED');
};

test('J03 steps 5 and 6 bind only the two existing caption-draft edit branches', () => {
  assert.equal(journey.steps.length, 8);
  for (const [id, actionRef, editKind] of [
    ['J03-5', 'media.action.correct-caption', 'TEXT_CORRECTION'],
    ['J03-6', 'media.action.align-caption-timing', 'TIMING_ALIGNMENT'],
  ]) {
    const selected = step(id);
    assert.equal(selected.action, actionRef);
    assert.equal(selected.sourceDecisionRef, '.product-experience/decision-log.md#PXD-066');
    assert.equal(selected.grammarDecisionRef, '.product-experience/decision-log.md#PXD-067');
    assert.equal(selected.canonicalOperationRef, 'media.operation.caption-draft-write');
    assert.deepEqual(selected.requiredOperationRefs, ['media.operation.caption-draft-write']);
    assert.deepEqual(selected.draftEditSemantics.trustedHostFields, ['tenantId', 'principalId']);
    assert.deepEqual(selected.draftEditSemantics.allowedEditFields, editKind === 'TEXT_CORRECTION' ? ['text'] : ['startTick', 'endTick']);
    assert.equal(selected.transitionDisposition.status, 'NOT_APPLICABLE_WITH_REASON');
    assert.equal(selected.transitionDisposition.transitionRef, null);
    assert.match(selected.transitionDisposition.reason, /session-local draft snapshot/u);
    assert.match(selected.authorityRef, /current-trusted-tenant-principal/u);
    assert.deepEqual(selected.verification.actualEvidence, []);
    assert.equal(selected.verification.status, 'not-run');
    assert.equal(selected.definitionVerification.runtimeAdmission, 'NOT_ADMITTED');
    assert.equal(selected.definitionVerification.runtimeVerification, 'not-run');
  }
  assert.equal(step('J03-5').draftEditSemantics.timingUnavailableAllowed, true);
  assert.equal(step('J03-6').draftEditSemantics.timingUnavailableAllowed, false);
  assert.match(step('J03-6').draftEditSemantics.provenance, /explicit user-entered.*not forced alignment/u);
  assert.equal(step('J03-5').transitionDisposition.transitionRef, null);
  assert.equal(step('J03-6').transitionDisposition.transitionRef, null);
});

test('draft operation, PDP2 grammar, and experience steps agree on CAS, exact lineage, and clock guards', () => {
  assert.deepEqual(operation.inputSemantics.requiredFields, [
    'draftId', 'expectedDraftRevision', 'sourceArtifactId', 'sourceArtifactVersionId', 'parentVersionKind', 'parentVersionId', 'editKind', 'segmentId', 'edit',
  ]);
  assert.deepEqual(operation.inputSemantics.parentVersionKindValues, ['TRANSCRIPT_VERSION', 'CAPTION_VERSION']);
  assert.deepEqual(operation.inputSemantics.editBranches.TEXT_CORRECTION.allowedFields, ['text']);
  assert.deepEqual(operation.inputSemantics.editBranches.TIMING_ALIGNMENT.allowedFields, ['startTick', 'endTick']);
  assert.match(operation.sourceClockRequirement, /sourceClockId-positive-safe-integer-ticksPerSecond-and-nonnegative-safe-integer-sourceDurationTicks/u);
  assert.match(operation.sourceClockRequirement, /0-<=-startTick-<-endTick-<=-sourceDurationTicks/u);
  assert.match(operation.idempotency, /inspect-the-same-draft.*never-blindly-reapply/u);
  const draftGrammar = grammar.boundedCaptionDraftSlice;
  assert.equal(draftGrammar.sourceDecisionRef, '.product-experience/decision-log.md#PXD-066');
  assert.equal(draftGrammar.experienceDecisionRef, '.product-experience/decision-log.md#PXD-068');
  assert.deepEqual(draftGrammar.actions.correctCaptionText.branchRequestFields, ['text']);
  assert.deepEqual(draftGrammar.actions.alignCaptionTiming.branchRequestFields, ['startTick', 'endTick']);
  assert.equal(draftGrammar.runtimeAdmission, 'NOT_ADMITTED');
  assert.match(draftGrammar.actions.alignCaptionTiming.timingRule, /no-conversion-estimation-or-clock-inference/u);
});

test('action and screen definitions keep conditional local undo out of public reversible booleans', () => {
  for (const id of ['media.action.correct-caption', 'media.action.align-caption-timing']) {
    const semantics = action(id).actionDefinitionSemantics;
    assert.equal(semantics.operationRef, 'media.operation.caption-draft-write');
    assert.equal(semantics.sourceDecisionRef, '.product-experience/decision-log.md#PXD-066');
    assert.equal(semantics.grammarDecisionRef, '.product-experience/decision-log.md#PXD-067');
    assert.equal(semantics.reviewDecisionRef, '.product-experience/decision-log.md#PXD-068');
    assert.equal(semantics.runtimeAdmission, 'NOT_ADMITTED');
    assert.equal(semantics.effectKind, 'LOCAL_DRAFT_UPDATE');
    assert.equal(semantics.reversibility.kind, 'CONDITIONAL');
    assert.equal(semantics.publicBooleanDisposition, 'PUBLIC_BOOLEAN_NOT_REPRESENTABLE');
    assert.equal(semantics.publicEffect, undefined);
    assert.equal(semantics.publicFinality, undefined);
  }
  for (const screen of [correctScreen, editScreen]) {
    assert.deepEqual(consequence(screen, 'media.action.correct-caption').capabilityRefs, ['media.artifact.derive']);
    assert.deepEqual(consequence(screen, 'media.action.align-caption-timing').capabilityRefs, ['media.artifact.derive']);
    assert.equal(consequence(screen, 'media.action.correct-caption').operationRef, 'media.operation.caption-draft-write');
    assert.equal(consequence(screen, 'media.action.align-caption-timing').operationRef, 'media.operation.caption-draft-write');
    assert.deepEqual(screen.requirementRefs, ['MEDIA-REQ-CAP-ARTIFACT']);
  }
  assert.deepEqual(action('media.action.align-caption-timing').capabilityRefs, ['media.artifact.derive']);
  assert.deepEqual(correctScreen.operationRefs, ['media.operation.caption-draft-write', 'media.operation.caption-version-write']);
  assert.deepEqual(editScreen.operationRefs, ['media.operation.caption-draft-write', 'media.operation.caption-version-write', 'media.operation.caption-version-read']);
});

test('selected source bindings preserve same-draft recovery and do not admit remote or canonical effects', () => {
  const selected = bindings.j03CaptionDraftBindings;
  assert.equal(selected.reviewDecisionRef, '.product-experience/decision-log.md#PXD-068');
  assert.equal(selected.capabilityScopeDecisionRef, '.product-experience/decision-log.md#PXD-069');
  assert.equal(selected.runtimeAdmission, 'NOT_ADMITTED');
  assert.deepEqual(selected.steps.map(({ stepId }) => stepId), ['J03-5', 'J03-6']);
  assert.match(selected.steps[0].concurrencyAndRecovery, /same active-session draft.*never silently overwrite/u);
  assert.match(selected.steps[1].editSemantics, /0 <= startTick < endTick <= sourceDurationTicks/u);
  assert.deepEqual(selected.steps[0].stateRefs, []);
  assert.deepEqual(selected.steps[1].stateRefs, []);
  assert.match(selected.steps[1].prohibitedClaims.join(','), /forced-alignment/u);
  assert.equal(counters.coverageObservation.orderedStepCount, 130);
  assert.equal(counters.coverageObservation.journeyContractCount, 30);
  assert.equal(counters.coverageObservation.stepBindings.objectRefs.empty, 117);
  assert.equal(counters.coverageObservation.stepBindings.authorityRef.null, 116);
  assert.equal(counters.coverageObservation.stepBindings.stateRefs.empty, 122);
  assert.equal(counters.coverageObservation.stepBindings.transitionRef.null, 128);
  assert.equal(counters.coverageObservation.stepBindings.verification.notRun, 130);
  assert.equal(counters.j03CaptionDraftDefinitionObservation.sourceDefinitionCheckedSteps, 2);
  assert.equal(counters.j03TranscriptReviewDefinitionObservation.sourceDefinitionCheckedSteps, 1);
  assert.equal(counters.j03DefinitionReviewObservation.sourceDefinitionCheckedSteps, 2);
});

test('negative mutations cannot broaden timing, undo, or effect scope', () => {
  const wrongAction = deepClone(journey);
  wrongAction.steps.find(({ stepId }) => stepId === 'J03-6').action = 'media.action.review-transcript';
  assert.throws(() => assertBoundDraftStep(wrongAction.steps.find(({ stepId }) => stepId === 'J03-6'), 'J03-6', 'media.action.align-caption-timing', 'TIMING_ALIGNMENT'));

  const wrongOperation = deepClone(journey);
  wrongOperation.steps.find(({ stepId }) => stepId === 'J03-5').canonicalOperationRef = 'media.operation.caption-version-write';
  assert.throws(() => assertBoundDraftStep(wrongOperation.steps.find(({ stepId }) => stepId === 'J03-5'), 'J03-5', 'media.action.correct-caption', 'TEXT_CORRECTION'));

  const widenedTiming = deepClone(operation);
  widenedTiming.inputSemantics.editBranches.TIMING_ALIGNMENT.allowedFields.push('text');
  assert.notDeepEqual(widenedTiming.inputSemantics.editBranches.TIMING_ALIGNMENT.allowedFields, ['startTick', 'endTick']);
  assert.notDeepEqual(widenedTiming.inputSemantics.editBranches.TIMING_ALIGNMENT.allowedFields, operation.inputSemantics.editBranches.TIMING_ALIGNMENT.allowedFields);

  const forgedUndo = deepClone(action('media.action.align-caption-timing'));
  forgedUndo.actionDefinitionSemantics.publicEffect = { reversible: true };
  assert.throws(() => assertBoundDraftAction(forgedUndo, 'media.action.align-caption-timing'));

  const admitted = deepClone(step('J03-5'));
  admitted.definitionVerification.runtimeAdmission = 'ADMITTED';
  assert.throws(() => assertBoundDraftStep(admitted, 'J03-5', 'media.action.correct-caption', 'TEXT_CORRECTION'));
});
