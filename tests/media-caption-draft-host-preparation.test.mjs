import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const root = '.product-experience/pdp-3-product-experience';
const { parse } = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url))('yaml');
const yaml = async (path) => parse(await readFile(path, 'utf8'));
const [journey, bindings, screen, operations, counters] = await Promise.all([
  yaml(`${root}/journey-contracts/transcribe-and-correct-captions.yaml`),
  yaml(`${root}/experience-source-bindings.yaml`),
  yaml(`${root}/screen-contracts/correct-captions.yaml`),
  yaml('.product-experience/pdp-1-domain-data/operations.yaml'),
  yaml(`${root}/journey-registry.yaml`),
]);
const step = (id) => journey.steps.find((item) => item.stepId === id);
const operation = operations.operations.find((item) => item.id === 'media.operation.caption-draft-write');

const validHostPreparation = (handoff) => handoff.kind === 'HOST_LOCAL_VALUE_PREPARATION'
  && handoff.fromStepId === 'J03-4'
  && handoff.fromOperationRef === 'media.operation.transcript-version-read'
  && handoff.toStepId === 'J03-5'
  && handoff.parentBinding.includes('parentVersionKind-TRANSCRIPT_VERSION')
  && handoff.parentBinding.includes('parentVersionId-equal-to-exact-transcriptVersionId')
  && handoff.authority.includes('recheck-current-trusted-tenant-principal-activeSessionId')
  && handoff.preparedValue.includes('draftId-at-revision-zero')
  && handoff.initialization.includes('block-DRAFT_INITIALIZATION_BLOCKED')
  && handoff.initialization.includes('never-auto-segment')
  && handoff.initialization.includes('never-auto-segment-join-text-generate-IDs-or-infer-identity')
  && handoff.runtimeAdmission === 'NOT_ADMITTED'
  && handoff.noNewOperationOrPersistedObject === true;

test('J03-4 transcript read hands only exact identity into guarded host-local draft preparation', () => {
  const selected = step('J03-5');
  assert.equal(selected.handoffRef.fromStepId, 'J03-4');
  assert.equal(selected.handoffRef.fromOperationRef, 'media.operation.transcript-version-read');
  assert.equal(selected.handoffRef.toStepId, 'J03-5');
  assert.ok(validHostPreparation(selected.handoffRef));
  assert.match(selected.draftEditSemantics.draftInitialization, /exact transcriptVersionId.*linked sourceArtifactId\/sourceArtifactVersionId/u);
  assert.match(selected.draftEditSemantics.draftInitialization, /parentVersionId equal to transcriptVersionId/u);
  assert.match(selected.draftEditSemantics.draftInitialization, /stable nonempty unique segment IDs/u);
  assert.match(selected.draftEditSemantics.draftInitialization, /DRAFT_INITIALIZATION_BLOCKED/u);
  assert.match(selected.draftEditSemantics.draftInitialization, /never auto-segment, join text, or infer identities/u);
  assert.equal(selected.canonicalOperationRef, 'media.operation.caption-draft-write');
  assert.deepEqual(selected.requiredOperationRefs, ['media.operation.caption-draft-write']);
  assert.equal(selected.transitionDisposition.status, 'NOT_APPLICABLE_WITH_REASON');
  assert.equal(selected.transitionDisposition.transitionRef, null);
  assert.equal(selected.definitionVerification.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(selected.verification.status, 'not-run');
  assert.deepEqual(selected.verification.actualEvidence, []);
});

test('editor screen accepts only the same guarded prepared value and preserves pending screen admission', () => {
  assert.equal(screen.entryBindingStatus, 'definition-source-bound; runtime-admission-pending');
  assert.equal(screen.fieldBindingStatus.entry, 'candidate-pending-acceptance');
  assert.ok(screen.entry.some((line) => /exact-media\.operation\.transcript-version-read-result-from-J03-4/u.test(line)));
  assert.ok(screen.entry.some((line) => /bind typed parent identity to the exact transcriptVersionId/u.test(line)));
  assert.ok(screen.entry.some((line) => /DRAFT_INITIALIZATION_BLOCKED/u.test(line)));
  assert.ok(screen.entry.some((line) => /same current read\/edit policy and trusted session checks/u.test(line)));
  assert.ok(screen.entry.some((line) => /never infer IDs, segments, language, speaker, clock, or timing/u.test(line)));
});

test('draft result preserves PDP-1 segment timing union and MIXED aggregate without promotion', () => {
  const p1 = operation.outputSemantics;
  const p3 = step('J03-5').draftEditSemantics.resultShape;
  assert.deepEqual(p1.segmentItems.requiredFields, ['segmentId', 'text', 'origin', 'timing']);
  assert.deepEqual(p3.segmentRequiredFields, p1.segmentItems.requiredFields);
  assert.deepEqual(p3.segmentOptionalFields, p1.segmentItems.optionalFields);
  assert.deepEqual(p3.timingAvailabilityAggregateValues, p1.timingAvailabilityValues);
  assert.match(p3.timingTagUnion.SOURCE_TICKS, /sourceClockId\/ticksPerSecond\/sourceDurationTicks/u);
  assert.match(p3.timingTagUnion.PROVIDER_TIME_UNQUALIFIED, /provider values and original unit/u);
  assert.match(p3.timingTagUnion.NOT_SUPPLIED, /never infer/u);
  assert.match(p3.aggregateRules.find((rule) => rule.startsWith('MIXED')), /without promotion/u);
  assert.match(p1.timingAvailabilityAggregate.MIXED, /tags-differ-or-source-tick-metadata-tuples-are-inconsistent/u);
  assert.equal(p1.timingAvailabilityAggregate.emptySegments.startsWith('not-a-valid-initialized-draft'), true);
  assert.match(p3.registrationReadiness, /any NOT_SUPPLIED or PROVIDER_TIME_UNQUALIFIED segment, or a MIXED aggregate, blocks registration/u);
});

test('negative source mutations reject guessed identity, wrong parent, generated segmentation, and false runtime admission', () => {
  const handoff = structuredClone(step('J03-5').handoffRef);
  assert.ok(validHostPreparation(handoff));
  for (const [mutate, label] of [
    [(value) => { value.fromOperationRef = 'media.operation.transcript-version-list'; }, 'wrong source operation'],
    [(value) => { value.parentBinding = 'parentVersionKind-CAPTION_VERSION-and-parentVersionId-latest'; }, 'wrong parent identity'],
    [(value) => { value.initialization = 'auto-segment-and-generate-IDs'; }, 'generated segments'],
    [(value) => { value.runtimeAdmission = 'ADMITTED'; }, 'runtime admission'],
  ]) {
    const invalid = structuredClone(handoff);
    mutate(invalid);
    assert.equal(validHostPreparation(invalid), false, label);
  }

  const p3 = structuredClone(step('J03-5').draftEditSemantics.resultShape);
  p3.timingAvailabilityAggregateValues = ['SOURCE_CLOCK_BOUND'];
  assert.notDeepEqual(p3.timingAvailabilityAggregateValues, operation.outputSemantics.timingAvailabilityValues);
});

test('host handoff does not grow journey, step, or action populations', () => {
  assert.equal(counters.coverageObservation.journeyContractCount, 30);
  assert.equal(counters.coverageObservation.orderedStepCount, 130);
  assert.equal(journey.steps.length, 8);
  assert.equal(counters.coverageObservation.stepBindings.verification.notRun, 130);
  assert.equal(counters.coverageObservation.stepBindings.objectRefs.empty, 117);
  assert.equal(counters.coverageObservation.stepBindings.authorityRef.null, 116);
});
