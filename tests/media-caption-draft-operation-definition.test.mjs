import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { validateMediaCaptionDraftDefinition } from '../scripts/lib/media-caption-draft-definition-validation.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const { parse } = createRequire(resolve(root, '../ghatana-tools/package.json'))('yaml');
const yaml = (path) => parse(readFileSync(resolve(root, path), 'utf8'));
const operations = yaml('.product-experience/pdp-1-domain-data/operations.yaml');
const actionContracts = yaml('.product-experience/pdp-1-domain-data/action-contracts.yaml');
const base = { operations, actionContracts };
const operation = operations.operations.find(({ id }) => id === 'media.operation.caption-draft-write');

test('caption draft edit definition', () => {
  assert.deepEqual(validateMediaCaptionDraftDefinition(base), []);
  assert.deepEqual(operation.inputSemantics.editKindValues, ['TEXT_CORRECTION', 'TIMING_ALIGNMENT']);
  assert.deepEqual(operation.inputSemantics.editBranches.TEXT_CORRECTION.allowedFields, ['text']);
  assert.deepEqual(operation.inputSemantics.editBranches.TIMING_ALIGNMENT.allowedFields, ['startTick', 'endTick']);
  assert.equal(operation.outputSemantics.successFields.includes('sourceArtifactVersionId'), true);
  assert.match(operation.outputSemantics.registrationReadiness, /MIXED-aggregate-blocks-registration/u);
  assert.equal(operation.transition.transitionRefs.length, 0);
  assert.match(operation.scopeStatus, /runtime-NOT_ADMITTED/u);

  const staleDraftOverwrite = structuredClone(base);
  staleDraftOverwrite.operations.operations.find(({ id }) => id === operation.id).preconditions =
    operation.preconditions.filter((condition) => !condition.includes('expectedDraftRevision'));
  assert.match(validateMediaCaptionDraftDefinition(staleDraftOverwrite).join('\n'), /compare the draft revision.*source or parent mismatch/u);

  const unboundedDraftRevision = structuredClone(base);
  unboundedDraftRevision.operations.operations.find(({ id }) => id === operation.id).inputSemantics.expectedDraftRevision = 'arbitrary revision token';
  assert.match(validateMediaCaptionDraftDefinition(unboundedDraftRevision).join('\n'), /bounded compare-and-swap semantics/u);

  const timingCanInferClock = structuredClone(base);
  timingCanInferClock.operations.operations.find(({ id }) => id === operation.id).sourceClockRequirement =
    'milliseconds may be converted to source ticks using the provider default';
  assert.match(validateMediaCaptionDraftDefinition(timingCanInferClock).join('\n'), /exact authoritative clock/u);

  const textEditChangesTiming = structuredClone(base);
  textEditChangesTiming.operations.operations.find(({ id }) => id === operation.id).inputSemantics.editBranches.TEXT_CORRECTION.allowedFields = ['text', 'startTick'];
  assert.match(validateMediaCaptionDraftDefinition(textEditChangesTiming).join('\n'), /text correction must change only text/u);

  const validationFailurePartiallyApplies = structuredClone(base);
  validationFailurePartiallyApplies.operations.operations.find(({ id }) => id === operation.id).failure =
    'apply text first, then validate timing and retain a partial draft';
  assert.match(validateMediaCaptionDraftDefinition(validationFailurePartiallyApplies).join('\n'), /preserve the prior draft/u);

  const localUndoDeletesParent = structuredClone(base);
  localUndoDeletesParent.operations.operations.find(({ id }) => id === operation.id).reversibility =
    'undo deletes the parent source and registered version';
  assert.match(validateMediaCaptionDraftDefinition(localUndoDeletesParent).join('\n'), /limited to the session-local draft/u);

  const forgedAdmission = structuredClone(base);
  forgedAdmission.operations.operations.find(({ id }) => id === operation.id).scopeStatus = 'runtime-QUALIFIED';
  assert.match(validateMediaCaptionDraftDefinition(forgedAdmission).join('\n'), /remain unadmitted/u);

  const wrongActionBinding = structuredClone(base);
  wrongActionBinding.actionContracts.operationSliceBindings[operation.id].actionIntentRefs = ['media.action.save-caption-version'];
  assert.match(validateMediaCaptionDraftDefinition(wrongActionBinding).join('\n'), /action-contract binding/u);

  const callerChoosesSession = structuredClone(base);
  callerChoosesSession.operations.operations.find(({ id }) => id === operation.id).draftSnapshotDefinition.ownerScope =
    'caller supplies activeSessionId and may rebind tenant principal source';
  assert.match(validateMediaCaptionDraftDefinition(callerChoosesSession).join('\n'), /trusted active session/u);

  const timingUnionFlattened = structuredClone(base);
  timingUnionFlattened.operations.operations.find(({ id }) => id === operation.id).draftSnapshotDefinition.initialization.timingUnion =
    { SOURCE_TICKS: 'all values are integers', PROVIDER_TIME_UNQUALIFIED: 'all values are integers', NOT_SUPPLIED: 'use zero' };
  assert.match(validateMediaCaptionDraftDefinition(timingUnionFlattened).join('\n'), /tagged source tick, provider-time, or unavailable/u);

  const inferredInitialSegments = structuredClone(base);
  inferredInitialSegments.operations.operations.find(({ id }) => id === operation.id).draftSnapshotDefinition.initialization.missingParentData =
    'automatically segment joined text and generate IDs and timing';
  assert.match(validateMediaCaptionDraftDefinition(inferredInitialSegments).join('\n'), /prohibit inferred data/u);

  const revisionWraps = structuredClone(base);
  revisionWraps.operations.operations.find(({ id }) => id === operation.id).draftSnapshotDefinition.revision =
    'increment and wrap to zero at Number.MAX_SAFE_INTEGER';
  assert.match(validateMediaCaptionDraftDefinition(revisionWraps).join('\n'), /reject safe-integer exhaustion/u);

  const undoAba = structuredClone(base);
  undoAba.operations.operations.find(({ id }) => id === operation.id).draftSnapshotDefinition.undo =
    'restore the prior revision number without checking current ownership';
  assert.match(validateMediaCaptionDraftDefinition(undoAba).join('\n'), /without rolling back identity or reusing a revision/u);

  const reparentSameDraftId = structuredClone(base);
  reparentSameDraftId.operations.operations.find(({ id }) => id === operation.id).draftSnapshotDefinition.rebase =
    'reuse the same draftId and reset the revision to zero under the new parent';
  assert.match(validateMediaCaptionDraftDefinition(reparentSameDraftId).join('\n'), /new draft identity while preserving the stale draft/u);

  const flattenedSegmentTiming = structuredClone(base);
  flattenedSegmentTiming.operations.operations.find(({ id }) => id === operation.id).outputSemantics.segmentItems.timingField =
    'one draft-level timing status replaces each segment timing disposition';
  assert.match(validateMediaCaptionDraftDefinition(flattenedSegmentTiming).join('\n'), /every returned segment must preserve its own tagged timing/u);

  const mixedTimingWithoutAggregate = structuredClone(base);
  mixedTimingWithoutAggregate.operations.operations.find(({ id }) => id === operation.id).outputSemantics.timingAvailabilityValues =
    ['NOT_SUPPLIED', 'PROVIDER_TIME_UNQUALIFIED', 'SOURCE_CLOCK_BOUND'];
  assert.match(validateMediaCaptionDraftDefinition(mixedTimingWithoutAggregate).join('\n'), /conservative aggregate that represents mixed/u);

  const partialClockPromoted = structuredClone(base);
  partialClockPromoted.operations.operations.find(({ id }) => id === operation.id).outputSemantics.timingAvailabilityAggregate.SOURCE_CLOCK_BOUND =
    'at-least-one-segment-has-clock-metadata';
  assert.match(validateMediaCaptionDraftDefinition(partialClockPromoted).join('\n'), /conservative aggregate that represents mixed/u);

  const mixedDraftCanRegister = structuredClone(base);
  mixedDraftCanRegister.operations.operations.find(({ id }) => id === operation.id).outputSemantics.registrationReadiness =
    'MIXED timing is sufficient when one segment is source-clock-bound';
  assert.match(validateMediaCaptionDraftDefinition(mixedDraftCanRegister).join('\n'), /must not promote partial timing to caption-registration readiness/u);
});

test('caption draft source observations remain synthetic and do not claim a correction provider', () => {
  assert.equal(operation.inputSemantics.parentVersionKindValues.length, 2);
  assert.match(operation.transport, /no-remote-command-or-durable-storage-binding-is-established/u);
  assert.match(operation.evidenceAudit.providerInterface, /SubmitCorrection.*none-establishes-session-local-draft-persistence/u);
  assert.match(operation.observedBindings.CLI, /synthetic-caption-edit-fixtures-only/u);
  assert.match(operation.scopeStatus, /runtime-NOT_ADMITTED/u);
});
