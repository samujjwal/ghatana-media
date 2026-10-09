import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const require = createRequire(resolve(root, '../ghatana-tools/package.json'));
const { parse } = require('yaml');
const yaml = path => parse(readFileSync(resolve(root, path), 'utf8'));
const grammarPath = '.product-experience/pdp-2-design-interface-system/action-finality-grammar.yaml';
const operationsPath = '.product-experience/pdp-1-domain-data/operations.yaml';
const journeyPath = '.product-experience/pdp-3-product-experience/journey-contracts/transcribe-and-correct-captions.yaml';
const actionRegistryPath = '.product-experience/pdp-3-product-experience/action-registry.yaml';

function assertCaptionDraftGrammar(grammar, source, journey, actions) {
  assert.equal(grammar.status,
    'bounded-definition-grammar-under-PXD-067; independent-PDP-review-and-runtime-admission-open');
  assert.equal(grammar.decisionRef, '.product-experience/decision-log.md#PXD-067');
  assert.equal(grammar.sourceDecisionRef, '.product-experience/decision-log.md#PXD-066');
  assert.equal(grammar.experienceDecisionRef, '.product-experience/decision-log.md#PXD-068');
  assert.equal(grammar.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(grammar.phaseAdmission, 'pending-independent-PDP2-review');
  assert.deepEqual(grammar.domainRefs, [
    'media.domain.transcript-version', 'media.domain.caption-version', 'media.domain.artifact-version',
  ]);

  const operation = source.find(candidate => candidate.id === 'media.operation.caption-draft-write');
  assert.ok(operation, 'grammar must bind the existing caption-draft-write operation');
  const actionBindings = [grammar.actions.correctCaptionText, grammar.actions.alignCaptionTiming];
  assert.deepEqual(actionBindings.map(action => action.actionRef), [
    'media.action.correct-caption', 'media.action.align-caption-timing',
  ]);
  assert.ok(actionBindings.every(action => action.operationRef === operation.id),
    'both edit actions must use the existing shared draft operation');
  assert.deepEqual(operation.actionRefs, actionBindings.map(action => action.actionRef));

  const shared = grammar.actions.sharedOperation;
  assert.equal(shared.operationRef, operation.id);
  assert.deepEqual(shared.requestFields, operation.inputSemantics.requiredFields);
  assert.deepEqual(shared.trustedContextFields, operation.inputSemantics.trustedHostFields);
  assert.deepEqual(shared.parentKinds, operation.inputSemantics.parentVersionKindValues);
  assert.deepEqual(shared.editKinds, operation.inputSemantics.editKindValues);
  assert.deepEqual(shared.successFields, operation.outputSemantics.successFields);
  assert.deepEqual(shared.preservedFields, operation.outputSemantics.preservedFields);
  assert.deepEqual(shared.segmentItems, operation.outputSemantics.segmentItems);
  assert.deepEqual(shared.timingAvailabilityValues, operation.outputSemantics.timingAvailabilityValues);
  assert.deepEqual(shared.timingAvailabilityAggregate, operation.outputSemantics.timingAvailabilityAggregate);
  assert.equal(shared.registrationReadiness, operation.outputSemantics.registrationReadiness);
  assert.deepEqual(shared.problemCodes, operation.error);
  assert.deepEqual(shared.draftSnapshotDefinition, operation.draftSnapshotDefinition,
    'PDP-2 must carry the complete frozen PDP-1 initialization, timing, revision, and undo contract');

  const textBranch = operation.inputSemantics.editBranches.TEXT_CORRECTION;
  const timingBranch = operation.inputSemantics.editBranches.TIMING_ALIGNMENT;
  assert.equal(grammar.actions.correctCaptionText.editKind, 'TEXT_CORRECTION');
  assert.deepEqual(grammar.actions.correctCaptionText.branchRequestFields, textBranch.requiredFields);
  assert.equal(grammar.actions.alignCaptionTiming.editKind, 'TIMING_ALIGNMENT');
  assert.deepEqual(grammar.actions.alignCaptionTiming.branchRequestFields, timingBranch.requiredFields);
  assert.deepEqual(textBranch.allowedFields, ['text']);
  assert.deepEqual(timingBranch.allowedFields, ['startTick', 'endTick']);
  assert.match(grammar.actions.correctCaptionText.exactEffect, /target-segment-text-and-set-target-origin-to-USER_EDITED/u);
  assert.match(grammar.actions.correctCaptionText.exactEffect, /preserve-nontarget-segment-identities-order-text-origin/u);
  assert.match(grammar.actions.correctCaptionText.timingRule, /does-not-require-or-infer-a-source-clock/u);
  assert.match(grammar.actions.alignCaptionTiming.exactEffect, /half-open-source-tick-range-and-set-target-origin-to-USER_EDITED/u);
  assert.match(grammar.actions.alignCaptionTiming.method, /manual-user-entered-ticks-only/u);
  assert.match(grammar.actions.alignCaptionTiming.method, /no-forced-alignment-engine-is-invoked-or-equated/u);
  assert.match(grammar.actions.alignCaptionTiming.timingRule, /authoritative-sourceClockId/u);
  assert.match(grammar.actions.alignCaptionTiming.timingRule, /no-conversion-estimation-or-clock-inference/u);
  assert.match(operation.sourceClockRequirement, /0-<=-startTick-<-endTick-<=-sourceDurationTicks/u);
  assert.match(shared.concurrency, /expectedDraftRevision-matches/u);
  assert.match(shared.concurrency, /prior-snapshot-is-preserved/u);
  assert.match(shared.parentIdentity, /explicit-rebase-and-policy-recheck/u);
  assert.match(shared.localUndo.scope, /same-session-local-draft-lineage/u);
  assert.equal(shared.localUndo.reversibility.kind, 'CONDITIONAL');
  assert.equal(shared.localUndo.reversibility.publicBooleanDisposition, 'PUBLIC_BOOLEAN_NOT_REPRESENTABLE');
  assert.match(shared.finality, /session-local-draft-revision-only/u);
  assert.match(shared.finality, /no-commit-or-immutable-caption-registration/u);
  assert.match(shared.unknownOutcome, /same-draftId-and-revision/u);
  assert.match(shared.unknownOutcome, /no-blind-reapplication/u);
  assert.match(shared.cancellation, /stops-waiting-only/u);
  assert.match(shared.segmentItems.timingField, /tagged-union/u);
  assert.match(shared.timingAvailabilityAggregate.MIXED, /never-promote-the-aggregate-to-SOURCE_CLOCK_BOUND/u);
  assert.match(shared.registrationReadiness, /MIXED-aggregate-blocks-registration/u);
  for (const forbidden of ['new-operation-or-domain-object', 'source-or-parent-mutation',
    'implicit-rebase', 'unconditional-public-reversible-boolean', 'caption-registration-or-approval-claim',
    'gRPC-SubmitCorrection-equivalence']) {
    assert.ok(shared.prohibited.includes(forbidden), `grammar must prohibit ${forbidden}`);
  }

  const journeyByStep = new Map(journey.steps.map(step => [step.stepId, step]));
  for (const [key, actionGrammar] of Object.entries(grammar.actions).filter(([key]) => key !== 'sharedOperation')) {
    const step = journeyByStep.get(actionGrammar.journeyStepId);
    assert.ok(step, `${key} must match an exact J-03 step`);
    assert.equal(step.action, actionGrammar.actionRef);
    assert.equal(step.canonicalOperationRef, operation.id);
    assert.equal(step.definitionVerification?.runtimeAdmission, 'NOT_ADMITTED');
    assert.equal(step.actionBindingStatus, 'SOURCE_DEFINED_OWNER_ACCEPTED; runtime-admission-pending');
    assert.equal(step.sourceDecisionRef, '.product-experience/decision-log.md#PXD-066');
    assert.equal(step.grammarDecisionRef, '.product-experience/decision-log.md#PXD-067');
    assert.equal(step.decisionRef, '.product-experience/decision-log.md#PXD-068');

    const action = actions.find(candidate => candidate.id === actionGrammar.actionRef);
    assert.ok(action, `${actionGrammar.actionRef} must remain a registered action`);
    const semantics = action.actionDefinitionSemantics;
    assert.equal(semantics?.sourceDecisionRef, '.product-experience/decision-log.md#PXD-066');
    assert.equal(semantics?.grammarDecisionRef, '.product-experience/decision-log.md#PXD-067');
    assert.equal(semantics?.reviewDecisionRef, '.product-experience/decision-log.md#PXD-068');
    assert.equal(semantics?.runtimeAdmission, 'NOT_ADMITTED');
    assert.equal(semantics?.operationRef, operation.id);
    assert.equal(semantics?.effectKind, 'LOCAL_DRAFT_UPDATE');
    assert.equal(semantics?.reversibility?.kind, 'CONDITIONAL');
    assert.equal(semantics?.publicBooleanDisposition, 'PUBLIC_BOOLEAN_NOT_REPRESENTABLE');
    assert.equal(Object.hasOwn(action, 'publicEffect'), false);
    assert.equal(Object.hasOwn(action, 'publicFinality'), false);
  }
}

test('J-03 caption draft grammar cross-checks exact existing actions, operation, request branches and output fields', () => {
  const grammar = yaml(grammarPath).boundedCaptionDraftSlice;
  const operationSource = yaml(operationsPath);
  const source = [...operationSource.operations, ...operationSource.individualOperationContracts.records];
  const journey = yaml(journeyPath);
  const actions = yaml(actionRegistryPath).actions;
  assertCaptionDraftGrammar(grammar, source, journey, actions);
});

test('caption draft grammar rejects operation/action swaps, implicit clock use, commit promotion, and unconditional undo', () => {
  const grammar = structuredClone(yaml(grammarPath).boundedCaptionDraftSlice);
  const operationSource = yaml(operationsPath);
  const source = [...operationSource.operations, ...operationSource.individualOperationContracts.records];
  const journey = yaml(journeyPath);
  const actions = yaml(actionRegistryPath).actions;

  const wrongOperation = structuredClone(grammar);
  wrongOperation.actions.alignCaptionTiming.operationRef = 'media.operation.caption-version-write';
  assert.throws(() => assertCaptionDraftGrammar(wrongOperation, source, journey, actions), /existing shared draft operation/u);

  const collapsedBranches = structuredClone(grammar);
  collapsedBranches.actions.alignCaptionTiming.editKind = 'TEXT_CORRECTION';
  assert.throws(() => assertCaptionDraftGrammar(collapsedBranches, source, journey, actions), /TIMING_ALIGNMENT/u);

  const timingWithoutClock = structuredClone(grammar);
  timingWithoutClock.actions.alignCaptionTiming.timingRule = 'clock optional; infer ticks from text';
  assert.throws(() => assertCaptionDraftGrammar(timingWithoutClock, source, journey, actions), /authoritative-sourceClockId/u);

  const promoted = structuredClone(grammar);
  promoted.actions.sharedOperation.finality = 'commits and approves a caption version';
  assert.throws(() => assertCaptionDraftGrammar(promoted, source, journey, actions), /session-local-draft-revision-only/u);

  const unconditionalUndo = structuredClone(grammar);
  unconditionalUndo.actions.sharedOperation.localUndo.reversibility.kind = 'FULLY_REVERSIBLE';
  assert.throws(() => assertCaptionDraftGrammar(unconditionalUndo, source, journey, actions), /CONDITIONAL/u);

  const inferredDraftIdentity = structuredClone(grammar);
  inferredDraftIdentity.actions.sharedOperation.draftSnapshotDefinition.initialization.missingParentData =
    'split-joined-text-and-generate-segment-ids';
  assert.throws(() => assertCaptionDraftGrammar(inferredDraftIdentity, source, journey, actions),
    /deepStrictEqual|never-segment-joined-text/u);

  const abaUndo = structuredClone(grammar);
  abaUndo.actions.sharedOperation.draftSnapshotDefinition.undo = 'restore-prior-revision-number';
  assert.throws(() => assertCaptionDraftGrammar(abaUndo, source, journey, actions),
    /deepStrictEqual|no-ABA-rollback/u);

  const forcedAlignment = structuredClone(grammar);
  forcedAlignment.actions.alignCaptionTiming.method = 'forced-alignment-engine-output';
  assert.throws(() => assertCaptionDraftGrammar(forcedAlignment, source, journey, actions),
    /manual-user-entered-ticks-only/u);

  const flattenedTiming = structuredClone(grammar);
  flattenedTiming.actions.sharedOperation.segmentItems.timingField = 'flatten-timing-and-discard-unqualified-tags';
  assert.throws(() => assertCaptionDraftGrammar(flattenedTiming, source, journey, actions), /tagged-union/u);

  const promotedMixedTiming = structuredClone(grammar);
  promotedMixedTiming.actions.sharedOperation.timingAvailabilityAggregate.MIXED = 'promote-to-SOURCE_CLOCK_BOUND';
  assert.throws(() => assertCaptionDraftGrammar(promotedMixedTiming, source, journey, actions), /never-promote-the-aggregate/u);
});

test('caption draft grammar makes no production transport or provider-equivalence claims', () => {
  const grammar = yaml(grammarPath).boundedCaptionDraftSlice;
  assert.match(grammar.observedChannels.web.disposition, /local-UI-source-observed-only/u);
  assert.match(grammar.observedChannels.syntheticFixtureCli.disposition, /synthetic-fixture-only/u);
  assert.match(grammar.observedChannels.httpSdkAgentToolGrpcEvents.disposition, /unresolved/u);
  assert.match(grammar.observedChannels.httpSdkAgentToolGrpcEvents.disposition, /no-current-method-or-equivalence-claim/u);
  assert.match(grammar.observedChannels.httpSdkAgentToolGrpcEvents.disposition, /SubmitCorrection-is-a-provider-interface-not-this-operation/u);
  assert.equal(grammar.runtimeAdmission, 'NOT_ADMITTED');
});
