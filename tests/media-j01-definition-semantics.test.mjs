import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolveExperienceDefinitionSemantics } from '../scripts/lib/media-experience-definition-mapping.mjs';

const toolsRequire = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url));
const { parse } = toolsRequire('yaml');
const base = '.product-experience/pdp-3-product-experience';
const [journey, operations, actionRegistry, sourceBindings, screenRegistry, decisionLog, journeyRegistry] = await Promise.all([
  readFile(`${base}/journey-contracts/first-use-and-project-creation.yaml`, 'utf8').then(parse),
  readFile('.product-experience/pdp-1-domain-data/operations.yaml', 'utf8').then(parse),
  readFile(`${base}/action-registry.yaml`, 'utf8').then(parse),
  readFile(`${base}/experience-source-bindings.yaml`, 'utf8').then(parse),
  readFile(`${base}/screen-registry.yaml`, 'utf8').then(parse),
  readFile('.product-experience/decision-log.md', 'utf8'),
  readFile(`${base}/journey-registry.yaml`, 'utf8').then(parse),
]);
const decision = '.product-experience/decision-log.md#PXD-055';
const sourceDecision = '.product-experience/decision-log.md#PXD-054';
const opIds = new Set(operations.individualOperationContracts.records.map(({ id }) => id));
const action = (id) => actionRegistry.actions.find((record) => record.id === id);

test('J-01 keeps its four ordered steps and five registered screens without expanding the denominator', async () => {
  const journeyFiles = (await readdir(`${base}/journey-contracts`)).filter((name) => name.endsWith('.yaml'));
  let steps = 0;
  for (const file of journeyFiles) steps += (parse(await readFile(`${base}/journey-contracts/${file}`, 'utf8')).steps ?? []).length;
  assert.equal(journeyFiles.length, 30);
  assert.equal(steps, 130);
  assert.equal(actionRegistry.actions.length, 146);
  assert.equal(journey.journeyId, 'J-01');
  assert.equal(journey.steps.length, 4);
  assert.equal(journey.steps.filter(({ action }) => action).length, 1);
  assert.deepEqual(journey.steps.filter(({ action }) => action).map(({ action }) => action), ['media.action.create-project']);
  assert.equal(journey.steps.reduce((count, step) => count + step.requiredOperationRefs.length, 0), 3);
  assert.deepEqual(journey.steps.map(({ stepId }) => stepId), ['J01-1', 'J01-2', 'J01-3', 'J01-4']);
  assert.equal(journey.definitionReview.decisionRef, decision);
  assert.equal(journey.definitionReview.sourceDecisionRef, sourceDecision);
  assert.equal(journey.definitionReview.runtimeAdmission, 'NOT_ADMITTED');
  assert.match(decisionLog, /## PXD-055 — Four-step J-01 experience definition/);
  assert.equal(journeyRegistry.coverageObservation.orderedStepCount, 130);
  assert.equal(journeyRegistry.coverageObservation.stepBindings.action.linked, 18);
  assert.equal(journeyRegistry.coverageObservation.stepBindings.objectRefs.empty, 116);
  assert.equal(journeyRegistry.coverageObservation.stepBindings.stateRefs.empty, 122);
  assert.equal(journeyRegistry.coverageObservation.stepBindings.canonicalOperationRef.null, 111);
  assert.equal(journeyRegistry.coverageObservation.stepBindings.canonicalOperationRef.nonNullCandidateRefs, 19);
  assert.equal(journeyRegistry.coverageObservation.stepBindings.authorityRef.null, 115);
  assert.equal(journeyRegistry.coverageObservation.stepBindings.transitionRef.null, 128);
  assert.equal(journeyRegistry.coverageObservation.stepBindings.transitionRef.sourceDefinedNoMutationReasonCount, 13);
  assert.equal(journeyRegistry.coverageObservation.stepBindings.verification.notRun, 130);
  assert.deepEqual(journeyRegistry.j01DefinitionReviewObservation, {
    sourceRef: 'journey-contracts/first-use-and-project-creation.yaml#definitionReview',
    decisionRef: decision,
    sourceDecisionRef: sourceDecision,
    journeyId: 'J-01',
    existingStepsWithBoundedDefinition: 4,
    requiredScreenContracts: 4,
    optionalPostJourneyScreen: 'media.view.create-media',
    exactProjectOperationReferences: 3,
    projectStateTransitionReferences: 0,
    runtimeAdmission: 'NOT_ADMITTED',
    independentReview: 'PENDING',
    phaseAcceptance: 'NOT_CLAIMED',
  });
  const registered = new Set(screenRegistry.screens.filter((screen) => screen.journeyRefs?.includes('J-01')).map(({ id }) => id));
  assert.deepEqual([...registered].sort(), [
    'media.view.authenticate-and-select-context', 'media.view.create-media', 'media.view.find-projects',
    'media.view.resume-work', 'media.view.work-in-project',
  ].sort());
  assert.equal(journey.optionalContinuation.view, 'media.view.create-media');
  assert.match(journey.optionalContinuation.boundary, /J-01-completes-after-project-creation/);
});

test('each ordered step binds only its exact project query or create operation and applies no state transition', () => {
  const expected = [null, 'media.operation-slice.list-projects', 'media.operation-slice.create-project', 'media.operation-slice.inspect-project'];
  for (const [index, step] of journey.steps.entries()) {
    assert.equal(step.canonicalOperationRef, expected[index]);
    assert.deepEqual(step.requiredOperationRefs, expected[index] ? [expected[index]] : []);
    if (expected[index]) assert.ok(opIds.has(expected[index]), `unknown operation ${expected[index]}`);
    assert.deepEqual(step.transitionDisposition, {
      status: 'NOT_APPLICABLE_WITH_REASON',
      transitionRef: null,
      decisionRef: decision,
      reason: step.transitionDisposition.reason,
    });
    assert.ok(step.actorRefs.length > 0);
    assert.equal(step.definitionVerification.runtimeAdmission, 'NOT_ADMITTED');
    assert.equal(step.definitionVerification.runtimeVerification, 'not-run');
  }
  assert.match(journey.steps[0].failure.proposal, /do not query protected project data/);
  assert.deepEqual(journey.steps[2].objectRefs, ['media.domain.project', 'media.domain.project-revision']);
  assert.deepEqual(journey.steps[2].stateRefs, ['media-project/ACTIVE', 'media-project-version/COMMITTED']);
  assert.match(journey.steps[2].failure.proposal, /UNKNOWN_OUTCOME/);
  assert.match(journey.steps[2].recovery.proposal, /same creationRequestId/);
  assert.match(journey.steps[3].failure.proposal, /NOT_FOUND means absent or inaccessible/);
  assert.match(journey.steps[1].failure.proposal, /never means global absence/);
});

test('screen links distinguish trusted identity, scoped project views, and optional post-journey continuation', async () => {
  const screenNames = [
    'authenticate-and-select-context.yaml', 'resume-work.yaml', 'find-projects.yaml',
    'work-in-project.yaml', 'create-media.yaml',
  ];
  for (const name of screenNames) {
    const screen = parse(await readFile(`${base}/screen-contracts/${name}`, 'utf8'));
    assert.equal(screen.journeyDefinitionBindings.journeyRef, 'J-01');
    assert.equal(screen.journeyDefinitionBindings.decisionRef, decision);
    assert.equal(screen.journeyDefinitionBindings.runtimeAdmission, 'NOT_ADMITTED');
  }
  const createMedia = parse(await readFile(`${base}/screen-contracts/create-media.yaml`, 'utf8'));
  assert.equal(createMedia.journeyDefinitionBindings.applicability, 'optional-post-J01-continuation');
  assert.deepEqual(createMedia.journeyDefinitionBindings.operationRefs, []);
  assert.equal(sourceBindings.j01StepBindings.screenApplicability.optionalPostJourneyContinuation, 'media.view.create-media');
  assert.equal(sourceBindings.j01StepBindings.runtimeAdmission, 'NOT_ADMITTED');
  for (const step of sourceBindings.j01StepBindings.steps) {
    assert.equal(step.transitionDisposition, 'NOT_APPLICABLE_WITH_REASON');
    if (step.operationRef) assert.ok(opIds.has(step.operationRef));
  }
});

test('create finality is receipt-bound; project reads do not claim reversible remote effects', () => {
  for (const id of ['media.action.create-project', 'media.action.open-project', 'media.action.inspect-project-creation']) {
    const semantics = action(id).actionDefinitionSemantics;
    assert.equal(semantics.reviewDecisionRef, decision);
    assert.equal(semantics.sourceDecisionRef, sourceDecision);
    assert.equal(semantics.runtimeAdmission, 'NOT_ADMITTED');
    assert.ok(opIds.has(semantics.operationRef));
  }
  const create = action('media.action.create-project').actionDefinitionSemantics;
  assert.equal(create.reversibility.kind, 'NOT_REVERSIBLE');
  assert.equal(create.publicEffect.reversible, false);
  assert.equal(create.publicFinality.confirmationRequired, true);
  assert.equal(create.publicFinality.undoable, false);
  for (const id of ['media.action.open-project', 'media.action.inspect-project-creation']) {
    const semantics = action(id).actionDefinitionSemantics;
    assert.equal(semantics.reversibility.kind, 'UNKNOWN');
    assert.equal(semantics.publicBooleanDisposition, 'PUBLIC_BOOLEAN_NOT_REPRESENTABLE');
    assert.equal(semantics.publicEffect, undefined);
    assert.equal(semantics.publicFinality, undefined);
  }
  const projection = resolveExperienceDefinitionSemantics(actionRegistry.actions, []);
  assert.ok(projection.effects.some(({ id }) => id === create.publicEffect.id));
  assert.ok(projection.finality.some(({ id }) => id === create.publicFinality.id));
});

test('PXD-055 cannot authorize unrelated actions or substitute another operation or source decision', () => {
  const create = action('media.action.create-project');
  const clone = () => structuredClone(create);

  const unrelated = clone();
  unrelated.id = 'media.action.archive-project';
  unrelated.actionDefinitionSemantics.actionRef = unrelated.id;
  assert.throws(() => resolveExperienceDefinitionSemantics([unrelated], []), /unbounded action review/);

  const wrongOperation = clone();
  wrongOperation.actionDefinitionSemantics.operationRef = 'media.operation-slice.list-projects';
  assert.throws(() => resolveExperienceDefinitionSemantics([wrongOperation], []), /unbounded action review/);

  const wrongSource = clone();
  wrongSource.actionDefinitionSemantics.sourceDecisionRef = '.product-experience/decision-log.md#PXD-053';
  assert.throws(() => resolveExperienceDefinitionSemantics([wrongSource], []), /unbounded action review/);
});
