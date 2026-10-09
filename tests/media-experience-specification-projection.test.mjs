import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const toolsRequire = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url));
const { parse } = toolsRequire('yaml');
const { validateExperienceDefinition } = await import('@ghatana/experience-specification');
const specPath = '.product-experience/pdp-3-product-experience/generated/experience-specification.candidate.json';
const specification = JSON.parse(await readFile(specPath, 'utf8'));
const model = specification.candidateModel;
const screenRegistry = parse(await readFile('.product-experience/pdp-3-product-experience/screen-registry.yaml', 'utf8'));
const interactionRegistry = parse(await readFile('.product-experience/pdp-3-product-experience/interaction-registry.yaml', 'utf8'));
const journeyRegistry = parse(await readFile('.product-experience/pdp-3-product-experience/journey-registry.yaml', 'utf8'));
const actionRegistry = parse(await readFile('.product-experience/pdp-3-product-experience/action-registry.yaml', 'utf8'));
const componentContracts = parse(await readFile('.product-experience/pdp-2-design-interface-system/component-contracts.yaml', 'utf8'));
const scenarioFixtureRegistry = parse(await readFile('.product-experience/pdp-3-product-experience/scenario-fixture-registry.yaml', 'utf8'));
const journeyCatalog = parse(await readFile('.product-experience/pdp-0-product-truth/journey-catalog.yaml', 'utf8'));
const journeyActorResolutions = parse(await readFile('.product-experience/pdp-0-product-truth/journey-actor-resolutions.yaml', 'utf8'));
const stateModels = parse(await readFile('.product-experience/pdp-0-product-truth/state-models.yaml', 'utf8'));
const bindingReview = parse(await readFile('.product-experience/pdp-3-product-experience/experience-source-bindings.yaml', 'utf8'));
const recoveryContracts = parse(await readFile('.product-experience/pdp-3-product-experience/recovery-finality-contracts.yaml', 'utf8'));
const simulationFixtureSource = await readFile('libs/media-experience-simulation/src/fixtures.ts', 'utf8');

function assertUniqueKnownRefs(refs, known, label) {
  assert.equal(new Set(refs).size, refs.length, `${label} contains duplicate references`);
  for (const ref of refs) assert.ok(known.has(ref), `${label} contains stale reference ${ref}`);
}

test('PDP-3 views project exact component and journey refs while state refs remain unbound', async () => {
  const sourceViews = [...screenRegistry.screens, ...(screenRegistry.laneViews ?? [])];
  assert.equal(model.views.length, sourceViews.length);
  const components = new Set(componentContracts.components.map(({ id }) => id));
  const journeyIds = new Set(journeyRegistry.journeys.map(({ id }) => id));
  const contracts = new Map();
  for (const { sourceRef } of specification.sourceAuthorities.filter(({ sourceRef }) => sourceRef.includes('/screen-contracts/'))) {
    const contract = parse(await readFile(sourceRef, 'utf8'));
    contracts.set(contract.screenId, contract);
  }
  for (const view of model.views) {
    assert.ok(sourceViews.some(({ id }) => id === view.id));
    const exactRefs = (contracts.get(view.id)?.componentIds ?? []).filter((ref) => components.has(ref));
    assert.deepEqual(view.componentRefs, exactRefs, `${view.id} preserves exact resolvable source component refs`);
    assert.ok(view.componentRefs.every((ref) => components.has(ref)), `${view.id} has only exact component contract IDs`);
    const sourceJourneyRefs = sourceViews.find(({ id }) => id === view.id)?.journeyRefs ?? [];
    assertUniqueKnownRefs(sourceJourneyRefs, journeyIds, `${view.id} source journeyRefs`);
    assert.deepEqual(view.journeyRefs, sourceJourneyRefs, `${view.id} projects exact authored journeyRefs`);
    assert.deepEqual(view.stateRefs, []);
  }
  assert.equal(sourceViews.reduce((count, view) => count + (contracts.get(view.id)?.journeyRefs?.length ?? 0), 0), 132);
  assert.equal(model.views.reduce((count, view) => count + view.componentRefs.length, 0), 137);
  const viewsBlocker = specification.fieldMappingBlockers.find(({ field }) => field === 'views');
  assert.match(viewsBlocker?.reasons?.join(' ') ?? '', /132 source journeyRefs are directly projected/u);
  assert.doesNotMatch(viewsBlocker?.reasons?.join(' ') ?? '', /no schema-shaped journeys|journey refs remain unresolved/iu);
  assert.match(specification.candidateMappingReview.fieldDispositions.views.status, /JOURNEY_REF_MAPPING/u);
  assert.match(specification.candidateMappingReview.fieldDispositions.views.status, /PDP1_STATE_REFS_PENDING/u);
});

test('PDP-3 public resolver rejects a view journey ref after its projected journey target is removed', () => {
  assert.equal(model.journeys.length, 30);
  const candidateWithDanglingJourneyRef = structuredClone(model);
  candidateWithDanglingJourneyRef.journeys = candidateWithDanglingJourneyRef.journeys.filter(({ id }) => id !== 'J-01');
  candidateWithDanglingJourneyRef.views[0].journeyRefs = ['J-01'];
  assert.throws(() => validateExperienceDefinition(candidateWithDanglingJourneyRef), /references journey 'J-01' via 'journeyRefs', which does not exist/);
});

test('PDP-3 journeys project source-grounded actor, outcome, intent, view, and step identity with unresolved transition metadata', async () => {
  const contracts = new Map();
  const sourceJourneyById = new Map(journeyCatalog.journeys.map((entry) => [entry.id, entry]));
  let stepCount = 0;
  let authoredStepIds = 0;
  let authoredIntents = 0;
  let authoredViewIntents = 0;
  let authoredLabels = 0;
  let authoredTransitionRefArrays = 0;
  let directViewRefs = 0;
  let journeysWithOneOutcome = 0;
  let journeysWithMultipleOutcomes = 0;

  for (const entry of journeyRegistry.journeys) {
    const contract = parse(await readFile(`.product-experience/pdp-3-product-experience/${entry.contract}`, 'utf8'));
    contracts.set(entry.id, contract);
    for (const step of contract.steps ?? []) {
      stepCount++;
      authoredStepIds += typeof step.stepId === 'string' && step.stepId.length > 0 ? 1 : 0;
      authoredIntents += typeof step.intent === 'string' && step.intent.length > 0 ? 1 : 0;
      authoredViewIntents += typeof step.viewIntent === 'string' && step.viewIntent.length > 0 ? 1 : 0;
      authoredLabels += typeof step.label === 'string' && step.label.length > 0 ? 1 : 0;
      authoredTransitionRefArrays += Array.isArray(step.transitionRefs) ? 1 : 0;
      directViewRefs += typeof step.view === 'string' || typeof step.viewRef === 'string' ? 1 : 0;
    }
    const outcomes = sourceJourneyById.get(entry.id)?.outcomeRefs ?? [];
    journeysWithOneOutcome += outcomes.length === 1 ? 1 : 0;
    journeysWithMultipleOutcomes += outcomes.length > 1 ? 1 : 0;
  }

  const actorResolutionById = new Map(journeyActorResolutions.journeys.map((entry) => [entry.id, entry]));
  const resolvedActorCount = journeyRegistry.journeys.filter((entry) =>
    typeof actorResolutionById.get(entry.id)?.initiatingActorRef === 'string').length;
  const sourceJourneyIds = new Set(journeyCatalog.journeys.map((entry) => entry.id));
  const screenIds = new Set([...screenRegistry.screens, ...(screenRegistry.laneViews ?? [])].map((entry) => entry.id));
  assert.equal(journeyRegistry.journeys.length, 30);
  assert.equal(sourceJourneyIds.size, 30);
  assert.equal(stepCount, 130);
  assert.ok([...contracts.values()].every((contract) => (contract.steps ?? [])
    .filter((step) => typeof step.view === 'string' || typeof step.viewRef === 'string')
    .every((step) => screenIds.has(step.view ?? step.viewRef))),
  'all directly named step views resolve to a registered PDP-3 screen');
  assert.deepEqual({
    resolvedActorCount,
    unresolvedActorCount: journeyRegistry.journeys.length - resolvedActorCount,
    authoredStepIds,
    authoredIntents,
    authoredViewIntents,
    authoredLabels,
    authoredTransitionRefArrays,
    directViewRefs,
    journeysWithOneOutcome,
    journeysWithMultipleOutcomes,
  }, {
    resolvedActorCount: 30,
    unresolvedActorCount: 0,
    authoredStepIds: 13,
    authoredIntents: 8,
    authoredViewIntents: 98,
    authoredLabels: 4,
    authoredTransitionRefArrays: 0,
    directViewRefs: 130,
    journeysWithOneOutcome: 5,
    journeysWithMultipleOutcomes: 25,
  });
  assert.equal(model.journeys.length, 30);
  assert.equal(model.journeys.reduce((count, journey) => count + journey.steps.length, 0), 130);
  assert.equal(model.journeys.find(({ id }) => id === 'J-29').steps.length, 4,
    'J-29 steps project from explicit owner-selected intents and exact view links');
  assert.equal(model.journeys.filter(({ desiredOutcomeRef }) => desiredOutcomeRef).length, 5);
  const sourceActorIds = new Set(journeyActorResolutions.journeys.map(({ initiatingActorRef }) => initiatingActorRef));
  for (const journey of model.journeys) {
    assert.ok(sourceActorIds.has(journey.actorRef), `${journey.id} uses a resolved P0-04 actor`);
    const sourceEntry = journeyRegistry.journeys.find(({ id }) => id === journey.id);
    const contract = contracts.get(journey.id);
    const sourceIds = (contract.steps ?? []).map(({ stepId }) => stepId).filter(Boolean);
    const sourceCounts = new Map(sourceIds.map((id) => [id, sourceIds.filter((candidate) => candidate === id).length]));
    for (const [index, step] of journey.steps.entries()) {
      const sourceStep = (contract.steps ?? []).find((candidate, sourceIndex) => {
        const candidateId = candidate.stepId && sourceCounts.get(candidate.stepId) === 1
          ? candidate.stepId
          : `${journey.id}.step-${String(sourceIndex + 1).padStart(2, '0')}`;
        return candidateId === step.stepId;
      });
      assert.ok(sourceStep, `${journey.id}/${step.stepId} maps to a source step`);
      const viewRef = sourceStep.view ?? sourceStep.viewRef;
      const sourceView = [...screenRegistry.screens, ...(screenRegistry.laneViews ?? [])].find(({ id }) => id === viewRef);
      const expectedIntent = sourceStep.intent ?? sourceStep.viewIntent ?? sourceStep.label ?? sourceView?.purpose;
      assert.equal(step.intent, expectedIntent);
      assert.deepEqual(step.transitionRefs, [], 'required schema placeholder is not an asserted transition semantics');
    }
  }
  assert.ok(model.journeys.every((journey) => journey.steps.every((step) => !contracts.get(journey.id).steps.some((sourceStep) => sourceStep.result === step.intent))),
    'step result prose is never used as intent');
  const journeyBlocker = specification.fieldMappingBlockers.find((entry) => entry.field === 'journeys');
  assert.match(journeyBlocker?.status ?? '', /PARTIAL_SOURCE_PROJECTION_30_OF_30_JOURNEYS_130_OF_130_STEPS/u);
  assert.ok(journeyBlocker.reasons.join(' ').includes('partial source-grounded PDP-3 journey projection now includes 30/30 journeys and 130/130 steps'));
  assert.match(journeyBlocker.reasons.join(' '), /step-view 130 linked\/0 unresolved/iu);
  assert.match(journeyBlocker.reasons.join(' '), /step-action 18 linked\/112 unresolved/iu);
  assert.match(journeyBlocker.reasons.join(' '), /128 source transitionRef values are null/u);
  assert.match(journeyBlocker.reasons.join(' '), /empty arrays are schema placeholders only|empty arrays are schema placeholders/iu);
  assert.equal(specification.candidateMappingReview.journeyBindingAudit.p0InitiatorAvailability.resolvedCount, 30);
  assert.equal(specification.candidateMappingReview.journeyBindingAudit.p0InitiatorAvailability.sourceCount, 30);
  assert.match(specification.candidateMappingReview.journeyBindingAudit.p0InitiatorAvailability.disposition, /PROJECTED_AS_CANDIDATE_ACTOR_REFS/u);
  assert.equal(specification.candidateMappingReview.journeyBindingAudit.p3OrderedStepCount, 130);
  assert.equal(specification.candidateMappingReview.journeyBindingAudit.projectedStepCount, 130);
  assert.equal(specification.candidateMappingReview.journeyBindingAudit.stepIntentProjection.explicitSourceIntentCount, 106);
  assert.equal(specification.candidateMappingReview.journeyBindingAudit.stepIntentProjection.linkedViewPurposeProposalOnlyCount, 24);
  assert.equal(specification.candidateMappingReview.journeyBindingAudit.stepIntentProjection.omitted.length, 0);
  assert.equal(specification.candidateMappingReview.journeyBindingAudit.transitionProjection.sourceNullCount, 128);
  assert.equal(specification.candidateMappingReview.journeyBindingAudit.transitionProjection.sourceNoMutationReasonCount, 3);
  assert.match(specification.candidateMappingReview.journeyBindingAudit.transitionProjection.disposition, /required schema placeholder/u);
  assert.equal(specification.candidateMappingReview.journeyBindingAudit.stepBindingCounts.transitionRefsNull, 128);
  assert.equal(specification.candidateMappingReview.journeyBindingAudit.stepBindingCounts.stepViewUnresolved, 0);

  const resolvedJourney = journeyRegistry.journeys.find((entry) =>
    actorResolutionById.get(entry.id)?.initiatingActorRef === 'media.creator');
  assert.ok(resolvedJourney, 'fixture uses a source-resolved actor');
  const validJourneyBase = {
    id: resolvedJourney.id,
    name: resolvedJourney.title,
    actorRef: actorResolutionById.get(resolvedJourney.id).initiatingActorRef,
    steps: [],
  };
  const candidateWithJourney = (journey) => {
    const candidate = { ...structuredClone(model), journeys: [journey] };
    candidate.views = candidate.views.map((view) => ({ ...view, journeyRefs: view.journeyRefs.filter((ref) => ref === journey.id) }));
    return candidate;
  };

  assert.throws(() => validateExperienceDefinition(candidateWithJourney({
    ...validJourneyBase,
    steps: [{ viewRef: 'media.view.work-with-speech' }],
  }), { resolveReference: () => true }), /\.stepId is required/u);
  assert.throws(() => validateExperienceDefinition(candidateWithJourney({
    ...validJourneyBase,
    steps: [{ stepId: 'test-only', viewRef: 'media.view.work-with-speech' }],
  }), { resolveReference: () => true }), /\.intent is required/u);
  assert.throws(() => validateExperienceDefinition(candidateWithJourney({
    ...validJourneyBase,
    steps: [{ stepId: 'test-only', intent: 'test-only', viewRef: 'media.view.work-with-speech' }],
  }), { resolveReference: () => true }), /\.transitionRefs is required/u);
  assert.throws(() => validateExperienceDefinition(candidateWithJourney(validJourneyBase)),
    /actor owner resolver is required/u);
});

test('PDP-3 interactions inherit preconditions from their exact referenced action source', () => {
  const actions = new Map(actionRegistry.actions.map((action) => [action.id, action]));
  const projected = new Map(model.interactions.map((interaction) => [interaction.id, interaction]));
  const eligible = interactionRegistry.interactions.filter(({ effectRef }) => actions.has(effectRef));
  assert.equal(projected.size, eligible.length);
  for (const interaction of eligible) {
    const item = projected.get(interaction.id);
    assert.equal(item.actionRef, interaction.effectRef);
    assert.deepEqual(item.preconditions, actions.get(interaction.effectRef).preconditions ?? []);
    assert.equal(item.trigger, interaction.input);
  }
  assert.equal(specification.candidateMappingReview.fieldDispositions.interactions.status, 'DIRECT_INTERACTION_AND_ACTION_PRECONDITION_MAPPING');
});

test('PDP-3 report retains only genuinely unresolved specification mappings', () => {
  const report = JSON.parse(execFileSync('node', ['scripts/report-media-definition-residuals.mjs', '--json'], { encoding: 'utf8' }));
  const pdp3 = report.projections.find(({ phase }) => phase === 'PDP-3');
  assert.equal(pdp3.unresolvedFieldCount, 9);
  assert.deepEqual(pdp3.unresolvedFields.map(({ field }) => field), [
    'actions', 'componentContracts', 'effects', 'finality', 'fixtures', 'journeys',
    'scenarios', 'transitions', 'views',
  ]);
  assert.equal(specification.acceptance, 'NOT_CLAIMED');
  assert.match(specification.candidateMappingReview.ownerDecisionStatus, /PENDING/);
});

test('PDP-3 finality projects only explicit confirmations and source boolean reversibility', () => {
  const sourceById = new Map(actionRegistry.actions.map((action) => [action.id, action]));
  const expected = actionRegistry.actions.filter((action) => typeof action.finality === 'string'
    && typeof action.reversible === 'boolean'
    && typeof action.confirmation === 'string'
    && /require a separate explicit confirmation before dispatch/iu.test(action.confirmation));
  const explicit = actionRegistry.actions.flatMap((action) => action.actionDefinitionSemantics?.publicFinality ? [action.actionDefinitionSemantics.publicFinality] : []);
  const explicitActions = new Set(explicit.map((entry) => entry.actionRef));
  assert.equal(model.finality.length, expected.filter((action) => !explicitActions.has(action.id)).length + explicit.length);
  assert.equal(model.finality.length, 19);
  for (const finality of model.finality) {
    const action = sourceById.get(finality.actionRef);
    assert.ok(action, `finality action ${finality.actionRef} is exact`);
    if (explicitActions.has(action.id)) {
      assert.deepEqual(finality, action.actionDefinitionSemantics.publicFinality);
      assert.equal(action.actionDefinitionSemantics.runtimeAdmission, "NOT_ADMITTED");
      continue;
    }
    assert.equal(finality.description, action.finality);
    assert.equal(finality.confirmationRequired, true);
    assert.equal(finality.undoable, action.reversible);
  }
  assert.ok(model.finality.every((item) => !String(sourceById.get(item.actionRef).reversible).includes('only-before')));
});

test('PDP-3 preserves exact action prose while leaving unsupported effect taxonomy unresolved', () => {
  const projectedActions = new Map(model.actions.map((action) => [action.id, action]));
  assert.equal(projectedActions.size, actionRegistry.actions.length);
  for (const source of actionRegistry.actions) {
    assert.equal(projectedActions.get(source.id).description, source.effect);
    const definedEffect = source.actionDefinitionSemantics?.publicEffect;
    assert.deepEqual(projectedActions.get(source.id).producesEffectRefs, definedEffect ? [definedEffect.id] : []);
    if (["CONDITIONAL", "UNKNOWN"].includes(source.actionDefinitionSemantics?.reversibility.kind)) assert.equal(definedEffect, undefined);
  }
  assert.deepEqual(model.effects, actionRegistry.actions.flatMap((action) => action.actionDefinitionSemantics?.publicEffect ? [action.actionDefinitionSemantics.publicEffect] : []));
  assert.equal(model.effects.length, 1, 'only the unconditional attachment definition has a directly representable effect');
  const blocker = specification.fieldMappingBlockers.find(({ field }) => field === 'effects');
  assert.ok(blocker?.reasons?.some((reason) => /effect kind|reversib/iu.test(reason)));
});

test('PDP-3 scenarios and fixture descriptors require exact state, journey, and simulation-source links', async () => {
  const allStates = new Set(stateModels.models.flatMap((item) => (item.states ?? [])
    .filter((state) => typeof state === 'object' && typeof state.id === 'string')
    .map((state) => `${item.modelId}.${state.id}`)));
  const scenarioRecords = new Map(scenarioFixtureRegistry.fixtures.map((fixture) => [fixture.id, fixture]));
  const exactBindings = new Map(bindingReview.scenarioStartingStateBindings.map((binding) => [binding.scenarioRef, binding]));
  const journeyRefs = new Set();
  for (const entry of specification.sourceAuthorities.filter(({ sourceRef }) => sourceRef.includes('/journey-contracts/'))) {
    const journey = parse(await readFile(entry.sourceRef, 'utf8'));
    for (const ref of journey.scenarioRefs ?? []) journeyRefs.add(ref);
  }
  const actionScenarioRefs = new Set(actionRegistry.actions.flatMap((action) => action.scenarioRefs ?? []));
  const linked = new Set([...journeyRefs, ...actionScenarioRefs]);
  assert.equal(exactBindings.size, 16, 'source identity links include a consent proposal without a selected state object');
  const expected = [...exactBindings.values()].filter((binding) => allStates.has(binding.startingStateRef));
  assert.equal(expected.length, 15);
  assert.equal(model.scenarios.length, 15);
  assert.equal(model.fixtures.length, 15);
  const scenarioBlocker = specification.fieldMappingBlockers.find(({ field }) => field === 'scenarios');
  assert.deepEqual(scenarioBlocker.reasons, [
    `Only ${model.scenarios.length} of ${scenarioRecords.size} registry records have an exact source-fixture state that maps to a canonical PDP-0 state; ${scenarioRecords.size - model.scenarios.length} remain unresolved, and context dimensions are not asserted.`,
  ]);
  for (const scenario of model.scenarios) {
    const source = scenarioRecords.get(scenario.id);
    const binding = exactBindings.get(scenario.id);
    assert.ok(linked.has(scenario.id), `${scenario.id} has a journey or action source link`);
    assert.ok(source, `${scenario.id} has a registry record`);
    assert.ok(binding && allStates.has(binding.startingStateRef), `${scenario.id} has an exact canonical starting state`);
    assert.equal(scenario.startingStateRef, binding.startingStateRef);
    assert.deepEqual(scenario.contextDimensions, {}, 'no source context value is asserted');
    assert.equal(scenario.description, source.initialConditions);
  }
  for (const fixture of model.fixtures) {
    const source = scenarioRecords.get(fixture.scenarioRef);
    assert.ok(model.scenarios.some((scenario) => scenario.id === fixture.scenarioRef), `${fixture.id} links an emitted scenario`);
    assert.ok(source, `${fixture.id} links a registry record`);
    assert.equal(fixture.data.sourceFixtureRef, source.sourceFixtureRef);
    assert.equal(fixture.data.expected, source.expected);
    assert.match(simulationFixtureSource, new RegExp(`^[ \\t]*[\"']${fixture.data.sourceFixtureKey}[\"']:[ \\t]*`, 'mu'));
  }
  assert.equal(bindingReview.scenarioStartingStateBindings.length, 16,
    'source-level links include one consent proposal state that does not project as a canonical state');
  assert.equal(model.scenarios.some(({ id }) => id === 'media.scenario.consent-revoked'), false,
    'PDP-0 enumerates the consent axis but does not provide explicit terminal metadata, so the fixture remains unbound');
  assert.equal(model.states.some(({ id }) => id === 'media-rights-and-consent.consent.REVOKED'), false,
    'no sink-derived terminal claim is projected for an axis state');
  assert.equal(model.scenarios.some((scenario) => scenario.id === 'media.scenario.upload-interrupted'), false,
    'interrupted upload is unresolved because no canonical upload INTERRUPTED state exists');
});

test('PDP-3 recovery links reject stale and duplicate action or scenario references', () => {
  const actions = new Set(actionRegistry.actions.map((action) => action.id));
  const scenarios = new Set(scenarioFixtureRegistry.fixtures.map((fixture) => fixture.id));
  const recoveryIds = new Set(recoveryContracts.contracts.map((contract) => contract.id));
  assert.equal(bindingReview.recoveryCrossReferences.length, recoveryIds.size);
  assert.deepEqual(model.recovery, recoveryContracts.contracts.map((contract) => contract.definitionSemantics.publicRecovery), 'recovery booleans come from individually reviewed typed definitions, never inferred prose');
  assert.ok(!specification.fieldMappingBlockers.some(({ field }) => field === 'recovery'));
  assert.ok(model.recovery.every((entry) => !entry.automaticRecovery && entry.userActionRequired));
  assert.equal(specification.candidateMappingReview.recoverySourceProposals.length, recoveryIds.size);
  for (const binding of bindingReview.recoveryCrossReferences) {
    assert.ok(recoveryIds.has(binding.recoveryRef));
    for (const [kind, refs, known] of [['action', binding.actionRefs, actions], ['scenario', binding.scenarioRefs, scenarios]]) {
      assertUniqueKnownRefs(refs, known, `${binding.recoveryRef}.${kind}Refs`);
    }
  }
  assert.throws(() => assertUniqueKnownRefs(['media.action.missing'], actions, 'recovery.actionRefs'), /stale reference/u);
  assert.throws(() => assertUniqueKnownRefs(['media.scenario.missing'], scenarios, 'recovery.scenarioRefs'), /stale reference/u);
  assert.throws(() => assertUniqueKnownRefs(['media.action.view-job-status', 'media.action.view-job-status'], actions, 'recovery.actionRefs'), /duplicate/u);
  assert.throws(() => {
    const stale = 'media-job.MISSING';
    assert.ok(new Set(stateModels.models.flatMap((item) => (item.states ?? []).map((state) =>
      typeof state === 'object' ? `${item.modelId}.${state.id}` : `${item.modelId}.${state}`))).has(stale));
  });
});
