import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolveExperienceDefinitionSemantics } from '../scripts/lib/media-experience-definition-mapping.mjs';

const root = '.product-experience/pdp-3-product-experience';
const { parse } = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url))('yaml');
const readYaml = async (path) => parse(await readFile(path, 'utf8'));
const [journey, p1Objects, p1Operations, actionRegistry, bindings, screen, registry, decisions, grammar] = await Promise.all([
  readYaml(`${root}/journey-contracts/transcribe-and-correct-captions.yaml`),
  readYaml('.product-experience/pdp-1-domain-data/domain-objects.yaml'),
  readYaml('.product-experience/pdp-1-domain-data/operations.yaml'),
  readYaml(`${root}/action-registry.yaml`),
  readYaml(`${root}/experience-source-bindings.yaml`),
  readYaml(`${root}/screen-contracts/review-transcript.yaml`),
  readYaml(`${root}/journey-registry.yaml`),
  readFile('.product-experience/decision-log.md', 'utf8'),
  readYaml('.product-experience/pdp-2-design-interface-system/action-finality-grammar.yaml'),
]);
const sourceDecision = '.product-experience/decision-log.md#PXD-062';
const grammarDecision = '.product-experience/decision-log.md#PXD-063';
const decision = '.product-experience/decision-log.md#PXD-064';
const transcriptObject = p1Objects.objects.find(({ id }) => id === 'media.domain.transcript-version');
const operationRecords = [...p1Operations.operations, ...p1Operations.individualOperationContracts.records];
const readOperation = operationRecords.find(({ id }) => id === 'media.operation.transcript-version-read');
const reviewAction = actionRegistry.actions.find(({ id }) => id === 'media.action.review-transcript');
const step = journey.steps.find(({ stepId }) => stepId === 'J03-4');

function assertBoundDefinition(j, action, source) {
  const s = j.steps.find(({ stepId }) => stepId === 'J03-4');
  assert.equal(s.action, 'media.action.review-transcript');
  assert.equal(s.canonicalOperationRef, 'media.operation.transcript-version-read');
  assert.deepEqual(s.requiredOperationRefs, ['media.operation.transcript-version-read']);
  assert.deepEqual(s.objectRefs, ['media.domain.transcript-version', 'media.domain.artifact-version']);
  assert.deepEqual(s.stateRefs, []);
  assert.equal(s.authorityRef, '.product-experience/pdp-1-domain-data/operations.yaml#media.operation.transcript-version-read');
  assert.equal(s.sourceDecisionRef, sourceDecision);
  assert.equal(s.grammarDecisionRef, grammarDecision);
  assert.equal(s.decisionRef, decision);
  assert.deepEqual(s.transitionDisposition, {
    status: 'NOT_APPLICABLE_WITH_REASON',
    transitionRef: null,
    decisionRef: decision,
    reason: s.transitionDisposition.reason,
  });
  assert.match(s.transitionDisposition.reason, /read-only observation/u);
  assert.match(s.success.proposal, /Missing timing does not block inspection/u);
  assert.match(s.failure.proposal, /TRANSCRIPT_VERSION_NOT_FOUND_IN_CALLER_SCOPE/u);
  assert.match(s.failure.proposal, /SOURCE_IDENTITY_MISMATCH/u);
  assert.match(s.failure.proposal, /UNAVAILABLE/u);
  assert.match(s.recovery.proposal, /same transcriptVersionId/u);
  assert.match(s.recovery.proposal, /never substitute a job ID/u);
  assert.ok(s.postconditions.includes('no-mutation-or-caption-registration-or-approval-or-publication'));
  assert.equal(s.verification.status, 'not-run');
  assert.deepEqual(s.verification.actualEvidence, []);
  assert.equal(s.definitionVerification.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(s.definitionVerification.runtimeVerification, 'not-run');
  assert.equal(action.actionDefinitionSemantics.operationRef, 'media.operation.transcript-version-read');
  assert.equal(action.actionDefinitionSemantics.sourceDecisionRef, sourceDecision);
  assert.equal(action.actionDefinitionSemantics.grammarDecisionRef, grammarDecision);
  assert.equal(action.actionDefinitionSemantics.reviewDecisionRef, decision);
  assert.equal(action.actionDefinitionSemantics.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(action.actionDefinitionSemantics.reversibility.kind, 'UNKNOWN');
  assert.equal(action.reversible, 'unknown');
  assert.equal(action.actionDefinitionSemantics.effectKind, 'QUERY');
  assert.equal(action.actionDefinitionSemantics.publicBooleanDisposition, 'PUBLIC_BOOLEAN_NOT_REPRESENTABLE');
  assert.equal(action.actionDefinitionSemantics.publicEffect, undefined);
  assert.equal(action.actionDefinitionSemantics.publicFinality, undefined);
  assert.deepEqual(source.j03TranscriptReviewBindings.steps.map(({ stepId }) => stepId), ['J03-4']);
  assert.equal(source.j03TranscriptReviewBindings.runtimeAdmission, 'NOT_ADMITTED');
  assert.deepEqual(source.j03TranscriptReviewBindings.steps[0].domainObjectRefs, s.objectRefs);
  assert.deepEqual(source.j03TranscriptReviewBindings.steps[0].stateRefs, []);
}

test('J-03 binds the existing transcript review step without changing the journey or action population', async () => {
  const journeyFiles = (await readdir(`${root}/journey-contracts`)).filter((name) => name.endsWith('.yaml'));
  let totalSteps = 0;
  for (const name of journeyFiles) totalSteps += (await readYaml(`${root}/journey-contracts/${name}`)).steps?.length ?? 0;
  assert.equal(journeyFiles.length, 30);
  assert.equal(totalSteps, 130);
  assert.equal(actionRegistry.actions.length, 146);
  assert.equal(journey.journeyId, 'J-03');
  assert.equal(journey.steps.length, 8);
  assert.deepEqual(journey.steps.map(({ action }) => action ?? null), [
    'media.action.choose-source', 'media.action.request-transcription', 'media.action.view-job-status',
    'media.action.review-transcript', 'media.action.correct-caption', 'media.action.align-caption-timing',
    'media.action.save-caption-version', 'media.action.compare-caption-versions',
  ]);
  assertBoundDefinition(journey, reviewAction, bindings);
  assert.equal(registry.coverageObservation.orderedStepCount, 130);
  assert.equal(registry.coverageObservation.stepBindings.objectRefs.empty, 116);
  assert.equal(registry.coverageObservation.stepBindings.stateRefs.empty, 122);
  assert.equal(registry.coverageObservation.stepBindings.authorityRef.null, 115);
  assert.equal(registry.coverageObservation.stepBindings.canonicalOperationRef.null, 111);
  assert.equal(registry.coverageObservation.stepBindings.transitionRef.null, 128);
  assert.equal(registry.coverageObservation.stepBindings.transitionRef.sourceDefinedNoMutationReasonCount, 13);
  assert.equal(registry.coverageObservation.stepBindings.verification.notRun, 130);
  assert.equal(registry.coverageObservation.stepBindings.verification.evidenceRefsPresent, 0);
  assert.equal(registry.coverageObservation.stepBindings.verification.sourceDefinitionCheckedSteps, 6);
  assert.deepEqual(registry.j03TranscriptReviewDefinitionObservation, {
    sourceRef: 'journey-contracts/transcribe-and-correct-captions.yaml#J03-4',
    decisionRef: decision,
    sourceDecisionRef: sourceDecision,
    grammarDecisionRef: grammarDecision,
    journeyId: 'J-03',
    existingStepsWithBoundedDefinition: 1,
    exactTranscriptReadOperationReferences: 1,
    sourceDefinitionCheckedSteps: 1,
    transitionReferences: 0,
    runtimeAdmission: 'NOT_ADMITTED',
    independentReview: 'PENDING',
    phaseAcceptance: 'NOT_CLAIMED',
  });
  assert.match(decisions, /### PXD-064 — Existing J03-4 transcript review experience/u);
  assert.equal(grammar.boundedTranscriptReviewSlice.decisionRef, grammarDecision);
  assert.equal(grammar.boundedTranscriptReviewSlice.operation.journeyStepId, 'J03-4');
});

test('transcript identity, read selector, source link, availability, and errors match PDP-1', () => {
  assert.ok(transcriptObject);
  assert.match(transcriptObject.identity, /trusted-tenantId-plus-opaque-transcriptVersionId/u);
  assert.match(transcriptObject.sourceLink, /sourceArtifactId-and-sourceArtifactVersionId/u);
  assert.match(transcriptObject.materialization, /legacy-transcription-UUID-are-not-automatically-canonical-version-identities/u);
  assert.match(transcriptObject.reviewBoundary, /not-caption-correction-caption-registration-review-approval-or-publication/u);
  assert.match(transcriptObject.materialization, /no-qualified-producer-is-claimed/u);
  assert.equal(readOperation.inputSemantics.requiredFields.length, 1);
  assert.deepEqual(readOperation.inputSemantics.requiredFields, ['transcriptVersionId']);
  assert.deepEqual(readOperation.inputSemantics.trustedHostFields, ['tenantId', 'principalId']);
  assert.deepEqual(readOperation.outputSemantics.requiredFields, [
    'transcriptVersionId', 'sourceArtifactId', 'sourceArtifactVersionId', 'textAvailability', 'segmentsAvailability',
    'languageAvailability', 'uncertaintyAvailability', 'timingAvailability', 'sourceClockAvailability', 'evidenceAvailability', 'observedAt',
  ]);
  assert.ok(readOperation.outputSemantics.conditionalFields.includes('sourceClockMappingEvidenceRef'));
  assert.deepEqual(readOperation.outputSemantics.timingAvailabilityValues, ['NOT_SUPPLIED', 'PROVIDER_TIME_UNQUALIFIED', 'SOURCE_CLOCK_BOUND']);
  assert.deepEqual(readOperation.error, ['INVALID_REQUEST', 'ACCESS_DENIED', 'TRANSCRIPT_VERSION_NOT_FOUND_IN_CALLER_SCOPE', 'SOURCE_IDENTITY_MISMATCH', 'UNAVAILABLE']);
  assert.deepEqual(readOperation.transition.transitionRefs, []);
  assert.match(readOperation.recovery, /same-exact-transcriptVersionId/u);
  assert.match(readOperation.inputSemantics.selector, /no-jobId-transcriptArtifactId-sourceArtifactId-latest-alias-or-global-list/u);
  assert.match(readOperation.outputSemantics.clockMappingContext, /does-not-rewrite-or-retime-stored-provider-milliseconds/u);
  assert.equal(readOperation.scopeStatus, 'proposal-only; bounded-owner-semantics-under-PXD-062; canonical-materializer-and-runtime-NOT_ADMITTED; independent-PDP1-review-pending');
});

test('review screen binds only the exact query while local playback actions remain separate', () => {
  assert.equal(screen.journeyDefinitionBindings.stepId, 'J03-4');
  assert.equal(screen.journeyDefinitionBindings.decisionRef, decision);
  assert.equal(screen.journeyDefinitionBindings.runtimeAdmission, 'NOT_ADMITTED');
  assert.deepEqual(screen.operationRefs, ['media.operation.transcript-version-read']);
  assert.deepEqual(screen.domainObjectRefs, ['media.domain.transcript-version', 'media.domain.artifact-version']);
  assert.deepEqual(screen.stateRefs, []);
  assert.deepEqual([...new Set(screen.actors)].sort(), ['media.creator', 'media.editor', 'media.reviewer'].sort());
  assert.deepEqual(screen.actionConsequences.find(({ actionId }) => actionId === 'media.action.review-transcript').capabilityRefs, ['media.artifact.inspect']);
  assert.deepEqual(screen.actionConsequences.find(({ actionId }) => actionId === 'media.action.review-transcript').requirementRefs, ['MEDIA-REQ-CAP-ARTIFACT']);
  assert.deepEqual(screen.actionConsequences.filter(({ actionId }) => ['media.action.play-source', 'media.action.seek-source'].includes(actionId)).map(({ operationRef }) => operationRef), [null, null]);
});

test('read action stays UNKNOWN for reversibility and cannot project or forge an unapproved public boolean', () => {
  const projection = resolveExperienceDefinitionSemantics(actionRegistry.actions, []);
  assert.ok(projection.conditionalActions.includes('media.action.review-transcript'));
  assert.ok(!projection.effects.some(({ id }) => id === 'media.effect.review-transcript'));
  assert.ok(!projection.finality.some(({ id }) => id === 'media.finality.review-transcript'));
  const forged = structuredClone(actionRegistry.actions);
  const review = forged.find(({ id }) => id === 'media.action.review-transcript');
  review.actionDefinitionSemantics.publicEffect = {
    id: 'media.effect.reversible-transcript-read', name: 'Read transcript', kind: 'query', description: 'Read', reversible: true,
  };
  assert.throws(() => resolveExperienceDefinitionSemantics(forged, []), /conditional boolean coercion|unbounded historical public record|unbounded action review|historical decision scope drift/u);
});

test('PXD-064 cannot be reused for a different action, operation, authority, decision, or admission', () => {
  for (const [label, mutate] of [
    ['wrong action', (semantics) => { semantics.actionRef = 'media.action.compare-caption-versions'; }],
    ['wrong operation', (semantics) => { semantics.operationRef = 'media.operation.caption-version-read'; }],
    ['wrong source decision', (semantics) => { semantics.sourceDecisionRef = '.product-experience/decision-log.md#PXD-060'; }],
    ['wrong grammar decision', (semantics) => { semantics.grammarDecisionRef = '.product-experience/decision-log.md#PXD-062'; }],
    ['wrong review decision', (semantics) => { semantics.reviewDecisionRef = '.product-experience/decision-log.md#PXD-063'; }],
    ['forged admission', (semantics) => { semantics.runtimeAdmission = 'ADMITTED'; }],
  ]) {
    const forged = structuredClone(actionRegistry.actions);
    mutate(forged.find(({ id }) => id === 'media.action.review-transcript').actionDefinitionSemantics);
    assert.throws(() => resolveExperienceDefinitionSemantics(forged, []), /unbounded historical public record|unbounded action review|typed action definition mismatch|unlinked exact operation|historical decision scope drift/u, label);
  }

  const wrongJourney = structuredClone(journey);
  wrongJourney.steps.find(({ stepId }) => stepId === 'J03-4').canonicalOperationRef = 'media.operation.caption-version-read';
  assert.throws(() => assertBoundDefinition(wrongJourney, reviewAction, bindings), /media\.operation\.transcript-version-read/u);

  const wrongSource = structuredClone(bindings);
  wrongSource.j03TranscriptReviewBindings.steps[0].domainObjectRefs = ['media.domain.transcription'];
  assert.throws(() => assertBoundDefinition(journey, reviewAction, wrongSource), /deepStrictEqual|Expected values/u);
});
