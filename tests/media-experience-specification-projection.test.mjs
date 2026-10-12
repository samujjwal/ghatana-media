import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const toolsRequire = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url));
const { parse } = toolsRequire('yaml');
// Validate against the current public source entrypoint. The installed sibling
// dist may be an older package snapshot than the Tools source under review.
const { validateExperienceDefinition } = await import(new URL('../../ghatana-tools/libs/product-development/experience-specification/src/index.ts', import.meta.url));
const specPath = '.product-experience/pdp-3-product-experience/generated/experience-specification.candidate.json';
const specification = JSON.parse(await readFile(specPath, 'utf8'));
const model = specification.candidateModel;
const screenRegistry = parse(await readFile('.product-experience/pdp-3-product-experience/screen-registry.yaml', 'utf8'));
const interactionRegistry = parse(await readFile('.product-experience/pdp-3-product-experience/interaction-registry.yaml', 'utf8'));
const journeyRegistry = parse(await readFile('.product-experience/pdp-3-product-experience/journey-registry.yaml', 'utf8'));
const actionRegistry = parse(await readFile('.product-experience/pdp-3-product-experience/action-registry.yaml', 'utf8'));
const publicTaxonomy = parse(await readFile('.product-experience/pdp-3-product-experience/public-effect-finality-taxonomy.yaml', 'utf8'));
const componentContracts = parse(await readFile('.product-experience/pdp-2-design-interface-system/component-contracts.yaml', 'utf8'));
const scenarioFixtureRegistry = parse(await readFile('.product-experience/pdp-3-product-experience/scenario-fixture-registry.yaml', 'utf8'));
const journeyCatalog = parse(await readFile('.product-experience/pdp-0-product-truth/journey-catalog.yaml', 'utf8'));
const journeyActorResolutions = parse(await readFile('.product-experience/pdp-0-product-truth/journey-actor-resolutions.yaml', 'utf8'));
const stateModels = parse(await readFile('.product-experience/pdp-0-product-truth/state-models.yaml', 'utf8'));
const bindingReview = parse(await readFile('.product-experience/pdp-3-product-experience/experience-source-bindings.yaml', 'utf8'));
const viewPredicates = parse(await readFile('.product-experience/pdp-3-product-experience/view-observation-predicates.yaml', 'utf8'));
const recoveryContracts = parse(await readFile('.product-experience/pdp-3-product-experience/recovery-finality-contracts.yaml', 'utf8'));
const simulationFixtureSource = await readFile('libs/media-experience-simulation/src/fixtures.ts', 'utf8');
const phaseProjectionGenerator = await readFile('scripts/generate-media-phase-projections.mjs', 'utf8');

function assertUniqueKnownRefs(refs, known, label) {
  assert.equal(new Set(refs).size, refs.length, `${label} contains duplicate references`);
  for (const ref of refs) assert.ok(known.has(ref), `${label} contains stale reference ${ref}`);
}

test('PDP-3 views project exact component, journey, and Media-local observation state refs', async () => {
  const sourceViews = [...screenRegistry.screens, ...(screenRegistry.laneViews ?? [])];
  assert.equal(model.views.length, sourceViews.length);
  const components = new Set(componentContracts.components.map(({ id }) => id));
  const journeyIds = new Set(journeyRegistry.journeys.map(({ id }) => id));
  const p1StateIds = new Set(stateModels.models.flatMap((machine) => (machine.states ?? [])
    .filter((state) => typeof state === 'object' && typeof state.id === 'string')
    .map((state) => `${machine.modelId}.${state.id}`)));
  const predicatesByView = new Map();
  for (const predicate of viewPredicates.predicates) {
    const refs = predicatesByView.get(predicate.viewRef) ?? [];
    refs.push(predicate.id);
    predicatesByView.set(predicate.viewRef, refs);
  }
  const projectedStates = new Map(model.states.map((state) => [state.id, state]));
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
    assert.deepEqual(view.stateRefs, predicatesByView.get(view.id) ?? [], `${view.id} projects exact local predicate IDs`);
    for (const stateRef of view.stateRefs) {
      assert.ok(projectedStates.has(stateRef), `${view.id} local observation state resolves`);
      assert.ok(!p1StateIds.has(stateRef), `${view.id} does not alias a PDP-1 machine state`);
      assert.match(projectedStates.get(stateRef).description, /display-only|local display observation/iu);
    }
  }
  assert.equal(sourceViews.reduce((count, view) => count + (contracts.get(view.id)?.journeyRefs?.length ?? 0), 0), 132);
  assert.equal(model.views.reduce((count, view) => count + view.componentRefs.length, 0), 154);
  const viewsBlocker = specification.fieldMappingBlockers.find(({ field }) => field === 'views');
  assert.equal(viewsBlocker, undefined, 'view IDs and exact local state refs are fully source-mapped');
  assert.match(specification.candidateMappingReview.fieldDispositions.views.status, /LOCAL_OBSERVATION_STATE_MAPPING_364_PREDICATES/u);
  assert.match(specification.candidateMappingReview.fieldDispositions.views.status, /CANONICAL_PDP1_STATE_BINDINGS_REMAIN_SEPARATE/u);
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
  const outcomeDecisions = parse(await readFile('.product-experience/pdp-3-product-experience/journey-outcome-projection-decisions.yaml', 'utf8'));
  const outcomeDecisionByJourney = new Map((outcomeDecisions.records ?? []).map((record) => [record.journeyRef, record]));
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
    authoredStepIds: 23,
    authoredIntents: 14,
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
  assert.equal(model.journeys.filter(({ desiredOutcomeRef }) => desiredOutcomeRef).length, 30);
  const outcomeProjectionRows = new Map(specification.candidateMappingReview.journeyBindingAudit.projectedSourceRows
    .map((row) => [row.journeyId, row]));
  const sourceActorIds = new Set(journeyActorResolutions.journeys.map(({ initiatingActorRef }) => initiatingActorRef));
  for (const journey of model.journeys) {
    assert.ok(sourceActorIds.has(journey.actorRef), `${journey.id} uses a resolved P0-04 actor`);
    const sourceEntry = journeyRegistry.journeys.find(({ id }) => id === journey.id);
    const contract = contracts.get(journey.id);
    const expectedScenarioRefs = [...new Set([
      ...(contract.scenarioRefs ?? []),
      ...(contract.steps ?? []).flatMap((sourceStep) => sourceStep.scenarioRefs ?? []),
    ])].sort();
    assert.deepEqual(journey.scenarioRefs ?? [], expectedScenarioRefs,
      `${journey.id} scenario links come only from exact contract-level and step-level source refs`);
    const exactSourceOutcomeRefs = sourceJourneyById.get(journey.id)?.outcomeRefs ?? [];
    assert.deepEqual(contract.outcomes ?? [], exactSourceOutcomeRefs,
      `${journey.id} contract preserves its full PDP-0 outcome list`);
    const outcomeAudit = outcomeProjectionRows.get(journey.id);
    assert.ok(outcomeAudit, `${journey.id} has a source outcome audit row`);
    assert.deepEqual(outcomeAudit.sourceOutcomeRefs, exactSourceOutcomeRefs,
      `${journey.id} retains all plural PDP-0 outcomeRefs in mapping review`);
    assert.equal(outcomeAudit.desiredOutcomeRef, journey.desiredOutcomeRef ?? null,
      `${journey.id} audit matches its projected primary outcome`);
    const outcomeDecision = outcomeDecisionByJourney.get(journey.id);
    if (outcomeDecision) {
      assert.equal(outcomeDecision.sourceJourneyRef,
        `.product-experience/pdp-0-product-truth/journey-catalog.yaml#journeys/@id=${journey.id}`);
      assert.deepEqual(outcomeDecision.sourceOutcomeRefs, exactSourceOutcomeRefs,
        `${journey.id} primary outcome decision covers the exact full source outcome list`);
      assert.ok(exactSourceOutcomeRefs.includes(outcomeDecision.primaryDesiredOutcomeRef),
        `${journey.id} explicit primary selection belongs to the source outcomes`);
      assert.equal(outcomeDecision.selectionStatus, 'MEDIA_OWNER_EXPLICIT_PRIMARY_OUTCOME_SELECTION; REVIEW_PENDING');
      assert.equal(outcomeDecision.runtimeAdmission, 'NOT_ADMITTED');
      assert.equal(outcomeDecision.acceptanceEffect, 'none');
      assert.equal(outcomeAudit.primaryOutcomeDecisionRef,
        `.product-experience/pdp-3-product-experience/journey-outcome-projection-decisions.yaml#records/@id=${outcomeDecision.id}`);
      assert.equal(journey.desiredOutcomeRef, outcomeDecision.primaryDesiredOutcomeRef);
    } else if (exactSourceOutcomeRefs.length === 1) {
      assert.equal(journey.desiredOutcomeRef, exactSourceOutcomeRefs[0],
        `${journey.id} may use an exact singleton source outcome without a separate selection`);
    } else {
      assert.equal(journey.desiredOutcomeRef, undefined,
        `${journey.id} cannot infer a primary outcome from a plural source list`);
    }
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
      const expectedTransitions = journey.id === 'J-02' && step.stepId === 'J02-3'
        ? ['media.pdp3.transition.upload-receiving-to-verifying.v1'] : [];
      assert.deepEqual(step.transitionRefs, expectedTransitions,
        'only the exact bounded upload finalization edge is linked; unrelated empty arrays remain placeholders');
    }
  }
  assert.equal(model.journeys.filter((journey) => (journey.scenarioRefs?.length ?? 0) > 0).length, 4);
  assert.equal(model.journeys.flatMap((journey) => journey.scenarioRefs ?? []).length, 31);
  assert.ok(model.journeys.every((journey) => journey.steps.every((step) => !contracts.get(journey.id).steps.some((sourceStep) => sourceStep.result === step.intent))),
    'step result prose is never used as intent');
  const journeyBlocker = specification.fieldMappingBlockers.find((entry) => entry.field === 'journeys');
  assert.equal(journeyBlocker, undefined, 'every source step has typed semantics or a bounded source-backed version disposition');
  assert.equal(specification.candidateMappingReview.journeyBindingAudit.p0InitiatorAvailability.resolvedCount, 30);
  assert.equal(specification.candidateMappingReview.journeyBindingAudit.p0InitiatorAvailability.sourceCount, 30);
  assert.match(specification.candidateMappingReview.journeyBindingAudit.p0InitiatorAvailability.disposition, /PROJECTED_AS_CANDIDATE_ACTOR_REFS/u);
  assert.equal(specification.candidateMappingReview.journeyBindingAudit.p3OrderedStepCount, 130);
  assert.equal(specification.candidateMappingReview.journeyBindingAudit.projectedStepCount, 130);
  assert.equal(specification.candidateMappingReview.journeyBindingAudit.typedStepSemanticsProjected, 130);
  assert.equal(specification.candidateMappingReview.journeyBindingAudit.typedStepSemanticsUnresolved, 0);
  assert.deepEqual(specification.candidateMappingReview.journeyBindingAudit.stepSemanticsFailures, []);
  assert.deepEqual(specification.candidateMappingReview.journeyBindingAudit.journeyScenarioReferenceCounts, {
    withRefs: 4,
    withoutRefs: 26,
    referenceCount: 31,
    source: 'currentStepBindingObservation.scenarioReferences plus exact journey-contract scenarioRefs and steps[].scenarioRefs',
  });
  assert.equal(specification.candidateMappingReview.journeyBindingAudit.stepIntentProjection.explicitSourceIntentCount, 112);
  assert.equal(specification.candidateMappingReview.journeyBindingAudit.stepIntentProjection.linkedViewPurposeProposalOnlyCount, 18);
  assert.equal(specification.candidateMappingReview.journeyBindingAudit.stepIntentProjection.omitted.length, 0);
  assert.equal(specification.candidateMappingReview.journeyBindingAudit.transitionProjection.sourceNullCount, 129);
  assert.match(specification.candidateMappingReview.journeyBindingAudit.transitionProjection.disposition, /schema-required candidate placeholder/u);
  assert.equal(specification.candidateMappingReview.journeyBindingAudit.stepBindingCounts.transitionRefsNull, 128);
  assert.deepEqual(model.transitions.map(({ id }) => id), ['media.pdp3.transition.upload-receiving-to-verifying.v1']);
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

test('PDP-3 transition audit reads effective source dispositions and keeps request actions non-final', async () => {
  const dispositionCounts = new Map();
  const sourceStepsByJourney = new Map();
  const unresolvedApplicableSourceRows = [];
  const unresolvedSourceDispositionRows = [];
  const initialAdmissionSourceRows = [];
  const effectiveDispositionBySourceStep = new Map();
  const domainOperations = parse(await readFile('.product-experience/pdp-1-domain-data/operations.yaml', 'utf8'));
  const journeyOperationBindings = new Map((domainOperations.ownerDefinedJourneyOperationBindings?.records ?? [])
    .map((binding) => [binding.journeyStepRef.replace(/#\/?steps\//u, '#/steps/'), binding]));
  const operationKindsByRef = new Map();
  const addOperationKind = (record, fallbackKind) => {
    if (!record || typeof record !== 'object') return;
    const kind = record.operationKind ?? record.ownerDefinition?.operationKind ?? fallbackKind;
    if (kind !== 'COMMAND' && kind !== 'QUERY') return;
    for (const ref of [record.id, ...(record.operationRefs ?? [])]) if (typeof ref === 'string') operationKindsByRef.set(ref, kind);
  };
  for (const record of domainOperations.operations ?? []) addOperationKind(record);
  for (const collection of ['individualOperationContracts', 'ownerDefinedOperationContracts', 'capabilityOperationContracts']) {
    for (const record of domainOperations[collection]?.records ?? []) addOperationKind(record);
  }
  for (const record of domainOperations.ownerTypedObservationContracts?.records ?? []) {
    if (typeof record.operationRef === 'string') operationKindsByRef.set(record.operationRef, 'QUERY');
  }
  let legacyNullTransitionRefCount = 0;
  for (const entry of journeyRegistry.journeys) {
    const contract = parse(await readFile(`.product-experience/pdp-3-product-experience/${entry.contract}`, 'utf8'));
    sourceStepsByJourney.set(entry.id, contract.steps ?? []);
    for (const [stepIndex, step] of (contract.steps ?? []).entries()) {
      legacyNullTransitionRefCount += step.transitionRef == null ? 1 : 0;
      const evidenceValues = [step.transitionDisposition, step.stepDefinitionSemantics?.transitionDisposition,
        step.stepDefinitionSemantics?.action?.transitionDisposition,
        step.transitionApplicability, step.stepDefinitionSemantics?.transitionApplicability].filter((value) => value !== undefined && value !== null);
      const evidenceParts = evidenceValues.map((value) => typeof value === 'string' ? value : JSON.stringify(value)).map((value) => value.toUpperCase());
      const evidence = evidenceParts.join(' ');
      const sourceStepRef = `.product-experience/pdp-3-product-experience/${entry.contract}#/steps/${stepIndex}`;
      const p1JourneyOperationBinding = journeyOperationBindings.get(sourceStepRef);
      const p1LocalDraftNoTransition = p1JourneyOperationBinding?.stateBindingDisposition === 'SESSION_LOCAL_REVISION_ONLY; no canonical domain-state transition.'
        && Array.isArray(p1JourneyOperationBinding.stateRefs) && p1JourneyOperationBinding.stateRefs.length === 0;
      const actionScopeParts = [step.stepDefinitionSemantics?.action?.effectKind,
        step.stepDefinitionSemantics?.action?.effect, step.stepDefinitionSemantics?.action?.finality]
        .filter((value) => value !== undefined && value !== null).map((value) => String(value).toUpperCase());
      const requestAction = [step.action, step.actionRef, step.stepDefinitionSemantics?.action?.actionRef,
        step.canonicalOperationRef, step.stepDefinitionSemantics?.action?.operationRef,
        step.stepDefinitionSemantics?.canonicalBindings?.canonicalOperationRef].filter(Boolean).join(' ').toUpperCase();
      const operationRefs = [step.canonicalOperationRef, ...(step.requiredOperationRefs ?? []),
        ...(step.resumeWorkflow?.orderedOperationRefs ?? []), ...(step.stepDefinitionSemantics?.action?.operationRefs ?? []),
        step.stepDefinitionSemantics?.canonicalBindings?.canonicalOperationRef,
        step.stepDefinitionSemantics?.transitionApplicability?.operationRef, step.transitionApplicability?.operationRef]
        .flatMap((value) => typeof value === 'string' ? value.split(/[;,]/u).map((ref) => ref.trim()) : []);
      const hasCommandOperation = operationRefs.some((ref) => operationKindsByRef.get(ref) === 'COMMAND');
      const hasQueryOperation = operationRefs.some((ref) => operationKindsByRef.get(ref) === 'QUERY');
      const ownerStateDisposition = String(p1JourneyOperationBinding?.stateBindingDisposition ?? '').toUpperCase();
      const topLevelTransitionReason = step.transitionDisposition?.reason ?? step.stepDefinitionSemantics?.transitionDisposition?.reason;
      const exactTopLevelNoTransition = step.transitionDisposition?.status === 'NOT_APPLICABLE_WITH_REASON'
        && typeof topLevelTransitionReason === 'string' && /NO .*TRANSITION|READ[- ]ONLY|EXTERNAL .*HANDOFF|NO MEDIA MUTATION/iu.test(topLevelTransitionReason);
      const explicitNoTransition = [...evidenceParts, ...actionScopeParts].some((part) => /NOT[_ -]?APPLICABLE|NO (?:MEDIA |PDP-1 |DOMAIN )?TRANSITION|NO[_ -]DOMAIN[_ -]TRANSITION|OBSERVATION[_ -]ONLY|READ[_ -]ONLY|QUERY|LOCAL[_ -](?:DRAFT|REVISION)|LOCAL_DRAFT_UPDATE|SESSION.LOCAL.DRAFT|NO MUTATION/iu.test(part)
        && !/UNRESOLVED|PENDING/u.test(part));
      const hasUnresolvedApplicability = /TRANSITION_APPLICABILITY_UNRESOLVED|UNRESOLVED_APPLICABLE/iu.test(evidence);
      const hasUnboundCanonicalEdge = /CANONICAL_STATES_BOUND; EXACT_LEGAL_TRANSITION_REF_UNBOUND/iu.test(evidence);
      const disposition = /REQUEST-CANCELLATION|RETRY-JOB|REQUEST-LIVE-SESSION-RECONNECT|SESSION-RECONNECT/u.test(requestAction)
        || /REQUEST[_ -]?ONLY|CONDITIONAL|REQUEST ACCEPTANCE|RECONNECT REQUEST|ASYNC_COMMAND_WITHOUT_LOCAL_DOMAIN_TRANSITION/iu.test(evidence) ? 'CONDITIONAL_OR_REQUEST_OBSERVATION'
        : /INITIAL_AGGREGATE_ADMISSION|INITIAL_STATE_ON_COMMITTED_SUCCESS/iu.test(`${evidence} ${ownerStateDisposition}`) ? 'SOURCE_BACKED_INITIAL_ADMISSION_NO_EXISTING_TRANSITION'
          : p1LocalDraftNoTransition ? 'SOURCE_BACKED_LOCAL_NO_CANONICAL_TRANSITION'
            : /APPEND_ONLY_VERSION|IMMUTABLE_RECORD/u.test(ownerStateDisposition) ? 'SOURCE_BACKED_NO_TRANSITION'
              : p1JourneyOperationBinding?.operationKind === 'QUERY' ? 'SOURCE_BACKED_NO_TRANSITION'
                : p1JourneyOperationBinding?.operationKind === 'COMMAND' && /LOGICAL REQUEST.*RECEIPT|ACCEPTANCE IS NOT A JOB STATE|NO JOB.STATE OR ATTEMPT TRANSITION/iu.test(p1JourneyOperationBinding.ownerResultSemantics ?? '') ? 'CONDITIONAL_OR_REQUEST_OBSERVATION'
                  : /LOCAL_SELECTION_ONLY_NO_CANONICAL_TRANSITION/iu.test(JSON.stringify(step.stepDefinitionSemantics?.transitionApplicability ?? step.transitionApplicability ?? '')) ? 'SOURCE_BACKED_LOCAL_NO_CANONICAL_TRANSITION'
                    : exactTopLevelNoTransition ? 'SOURCE_BACKED_NO_TRANSITION'
          : /APPLICABLE_WITH_BOUNDS|APPLICABLE TRANSITION/iu.test(evidence) ? 'APPLICABLE_BOUNDED_CANDIDATE'
            : hasUnresolvedApplicability && explicitNoTransition ? 'MIXED_OR_OTHER_SOURCE_DISPOSITION'
              : hasUnboundCanonicalEdge ? 'UNRESOLVED_APPLICABLE_COMMAND'
              : hasUnresolvedApplicability && hasCommandOperation ? 'UNRESOLVED_APPLICABLE_COMMAND'
                : hasUnresolvedApplicability ? 'MIXED_OR_OTHER_SOURCE_DISPOSITION'
                  : explicitNoTransition || (hasQueryOperation && /TRANSITION_APPLICABILITY_UNRESOLVED/iu.test(evidence)) ? 'SOURCE_BACKED_NO_TRANSITION'
                    : hasCommandOperation && (step.transitionRef == null || /UNRESOLVED|PENDING/iu.test(evidence)) ? 'UNRESOLVED_APPLICABLE_COMMAND'
                      : evidenceValues.length ? 'MIXED_OR_OTHER_SOURCE_DISPOSITION'
                        : step.transitionRef == null ? 'MIXED_OR_OTHER_SOURCE_DISPOSITION' : 'UNRESOLVED_TRANSITION_REFERENCE';
      dispositionCounts.set(disposition, (dispositionCounts.get(disposition) ?? 0) + 1);
      effectiveDispositionBySourceStep.set(`${entry.id}/${stepIndex + 1}`, disposition);
      if (disposition === 'SOURCE_BACKED_INITIAL_ADMISSION_NO_EXISTING_TRANSITION') {
        initialAdmissionSourceRows.push(`${entry.id}/${stepIndex + 1}:${step.stepId ?? '-'}`);
      }
      if (disposition === 'UNRESOLVED_APPLICABLE_COMMAND') unresolvedApplicableSourceRows.push({ journeyId: entry.id, stepOrdinal: stepIndex + 1, sourceStepId: step.stepId ?? null });
      if (['UNRESOLVED_SOURCE_DISPOSITION', 'UNRESOLVED_SOURCE_APPLICABILITY', 'UNRESOLVED_TRANSITION_REFERENCE',
        'UNRESOLVED_APPLICABLE_COMMAND', 'MIXED_OR_OTHER_SOURCE_DISPOSITION'].includes(disposition)) {
        unresolvedSourceDispositionRows.push({ journeyId: entry.id, stepOrdinal: stepIndex + 1, sourceStepId: step.stepId ?? null, disposition });
      }
    }
  }
  assert.deepEqual(Object.fromEntries([...dispositionCounts].sort(([a], [b]) => a.localeCompare(b))), {
    APPLICABLE_BOUNDED_CANDIDATE: 1,
    CONDITIONAL_OR_REQUEST_OBSERVATION: 10,
    SOURCE_BACKED_INITIAL_ADMISSION_NO_EXISTING_TRANSITION: 11,
    SOURCE_BACKED_LOCAL_NO_CANONICAL_TRANSITION: 5,
    SOURCE_BACKED_NO_TRANSITION: 103,
  }, 'the effective source disposition census is exact across all 130 steps');
  assert.equal(unresolvedApplicableSourceRows.length, 0, 'no applicable command remains after source-backed local draft evidence is accounted for');
  assert.deepEqual(initialAdmissionSourceRows, [
    'J-01/3:J01-3', 'J-05/1:-', 'J-05/2:-', 'J-09/4:-', 'J-09/7:-', 'J-10/2:-',
    'J-13/3:-', 'J-14/4:-', 'J-18/5:-', 'J-19/4:-', 'J-28/3:-',
  ], 'initial aggregate admissions have no prior aggregate transition and keep owner observation separate');
  assert.equal(legacyNullTransitionRefCount, 129, '129 legacy source transitionRefs are null across 130 steps');
  const transitionAudit = specification.candidateMappingReview.journeyBindingAudit.transitionProjection;
  assert.equal(transitionAudit.sourceNullCount, 129, 'generated source-null census counts legacy transitionRef values');
  assert.equal(transitionAudit.rows.length, 130, 'generated transition audit has one row per journey step');
  assert.equal(specification.candidateMappingReview.journeyBindingAudit.stepBindingCounts.transitionRefsNull, 128,
    'the separate registry step-binding observation remains its independently authored 128 count');
  assert.deepEqual(unresolvedSourceDispositionRows.map(({ journeyId, stepOrdinal, sourceStepId, disposition }) =>
    `${journeyId}/${stepOrdinal}:${sourceStepId ?? '-'}:${disposition}`), [],
  'all 130 steps have a source-backed, conditional, bounded, or explicitly unresolved status; no mixed rows are hidden');
  assert.deepEqual(unresolvedApplicableSourceRows.map(({ journeyId, stepOrdinal }) => `${journeyId}/${stepOrdinal}`), []);
  const reconciledSourceDispositionCases = [
    ['J-01', 1, 'SOURCE_BACKED_NO_TRANSITION'],
    ['J-01', 3, 'SOURCE_BACKED_INITIAL_ADMISSION_NO_EXISTING_TRANSITION'],
    ['J-01', 4, 'SOURCE_BACKED_NO_TRANSITION'],
    ['J-02', 5, 'SOURCE_BACKED_NO_TRANSITION'],
    ['J-03', 2, 'CONDITIONAL_OR_REQUEST_OBSERVATION'],
    ['J-03', 4, 'SOURCE_BACKED_NO_TRANSITION'],
    ['J-03', 7, 'SOURCE_BACKED_NO_TRANSITION'],
    ['J-03', 8, 'SOURCE_BACKED_NO_TRANSITION'],
    ['J-06', 3, 'SOURCE_BACKED_NO_TRANSITION'],
    ['J-08', 1, 'SOURCE_BACKED_LOCAL_NO_CANONICAL_TRANSITION'],
    ['J-21', 3, 'SOURCE_BACKED_NO_TRANSITION'],
    ['J-23', 2, 'SOURCE_BACKED_NO_TRANSITION'],
    ['J-24', 4, 'SOURCE_BACKED_NO_TRANSITION'],
    ['J-26', 2, 'SOURCE_BACKED_NO_TRANSITION'],
  ];
  for (const [journeyId, ordinal, expectedDisposition] of reconciledSourceDispositionCases) {
    assert.equal(effectiveDispositionBySourceStep.get(`${journeyId}/${ordinal}`), expectedDisposition,
      `${journeyId}/${ordinal} follows its exact source applicability and owner-operation evidence`);
    const sourceStep = sourceStepsByJourney.get(journeyId)[ordinal - 1];
    if (journeyId === 'J-08') {
      assert.equal((sourceStep.stepDefinitionSemantics?.transitionApplicability ?? sourceStep.transitionApplicability)?.disposition,
        'LOCAL_SELECTION_ONLY_NO_CANONICAL_TRANSITION');
    } else {
      const disposition = sourceStep.transitionDisposition ?? sourceStep.stepDefinitionSemantics?.transitionDisposition
        ?? sourceStep.stepDefinitionSemantics?.action?.transitionDisposition;
      if (typeof disposition === 'string') {
        assert.equal(disposition, 'NOT_APPLICABLE_WITH_REASON', `${journeyId}/${ordinal} keeps its exact nested source disposition`);
      } else if (disposition === undefined) {
        const binding = journeyOperationBindings.get(`.product-experience/pdp-3-product-experience/${journeyRegistry.journeys.find(({ id }) => id === journeyId).contract}#/steps/${ordinal - 1}`);
        assert.ok(binding?.operationKind === 'QUERY', `${journeyId}/${ordinal} relies on its exact owner QUERY binding when no top-level reason is authored`);
        assert.match(binding.stateBindingDisposition ?? '', /QUERY|OBSERVATION|NO STATE TRANSITION/iu);
      } else {
        assert.equal(disposition?.status, 'NOT_APPLICABLE_WITH_REASON', `${journeyId}/${ordinal} preserves its explicit source no-transition reason`);
        assert.ok(typeof disposition.reason === 'string' && disposition.reason.length > 0,
          `${journeyId}/${ordinal} preserves the source-authored reason`);
      }
    }
  }
  for (const [journeyId, ordinal, bindingId, contract, actionRef] of [
    ['J-03', 5, 'media.pdp1.journey-operation-binding.transcribe-and-correct-captions.J03-5', 'transcribe-and-correct-captions.yaml', 'media.action.correct-caption'],
    ['J-03', 6, 'media.pdp1.journey-operation-binding.transcribe-and-correct-captions.J03-6', 'transcribe-and-correct-captions.yaml', 'media.action.align-caption-timing'],
    ['J-16', 3, 'media.pdp1.journey-operation-binding.translate-and-dub-existing-video.index-2', 'translate-and-dub-existing-video.yaml'],
    ['J-18', 4, 'media.pdp1.journey-operation-binding.compose-and-render-reviewed-media.index-3', 'compose-and-render-reviewed-media.yaml'],
  ]) {
    const binding = journeyOperationBindings.get(`.product-experience/pdp-3-product-experience/journey-contracts/${contract}#/steps/${ordinal - 1}`);
    assert.equal(binding?.id, bindingId, `${journeyId}/${ordinal} has the exact frozen P1 journey-operation binding`);
    assert.equal(binding.operationRef, 'media.operation.caption-draft-write');
    assert.equal(binding.actionRef, actionRef ?? 'media.action.correct-caption');
    assert.equal(binding.operationDefinitionRef, '.product-experience/pdp-1-domain-data/operations.yaml#operations/@id=media.operation.caption-draft-write');
    assert.deepEqual(binding.stateRefs, []);
    assert.equal(binding.stateBindingDisposition, 'SESSION_LOCAL_REVISION_ONLY; no canonical domain-state transition.');
    assert.match(binding.ownerResultSemantics, /session-local draft revision using compare-and-swap/u);
    assert.ok(binding.failClosedCases.some((condition) => /Stale draft revision/u.test(condition)));
    assert.equal(effectiveDispositionBySourceStep.get(`${journeyId}/${ordinal}`), 'SOURCE_BACKED_LOCAL_NO_CANONICAL_TRANSITION');
    if (journeyId === 'J-16' || journeyId === 'J-18') {
      const sourceStep = sourceStepsByJourney.get(journeyId)[ordinal - 1];
      assert.equal((sourceStep.stepDefinitionSemantics?.transitionApplicability ?? sourceStep.transitionApplicability)?.status, 'TRANSITION_APPLICABILITY_UNRESOLVED',
        'the exact P1 owner binding resolves the stale applicability marker without changing its authored contract');
    }
  }
  const auditRow = (journeyId, stepOrdinal) => transitionAudit.rows.find((row) => row.journeyId === journeyId && row.stepOrdinal === stepOrdinal);
  const projectedJourney = (journeyId) => model.journeys.find(({ id }) => id === journeyId);
  const projectedRequests = [
    { journeyId: 'J-20', ordinal: 5, stepId: 'J-20.step-05', actionRef: 'media.action.request-cancellation' },
    { journeyId: 'J-20', ordinal: 6, stepId: 'J-20.step-06', actionRef: 'media.action.retry-job' },
    { journeyId: 'J-29', ordinal: 4, stepId: 'present-bounded-return-state', actionRef: 'media.action.request-live-session-reconnect' },
  ];
  for (const expected of projectedRequests) {
    const projected = projectedJourney(expected.journeyId)?.steps.find(({ stepId }) => stepId === expected.stepId);
    const audit = auditRow(expected.journeyId, expected.ordinal);
    assert.ok(projected, `${expected.journeyId} projected request step exists`);
    assert.ok(audit, `${expected.journeyId} source row ${expected.ordinal} is in the transition audit`);
    assert.deepEqual(projected.transitionRefs, [], `${expected.actionRef} request acceptance has no projected transition`);
    assert.deepEqual(audit.projectedTransitionRefs, [], `${expected.actionRef} source row has no projected transition`);
    assert.ok(projected.semantics?.actionRefs?.includes(expected.actionRef), `${expected.actionRef} remains the exact action identity`);
    assert.equal(Object.hasOwn(projected, 'stateRef') || Object.hasOwn(projected, 'stateRefs'), false,
      'request acceptance does not assert a resulting state');
  }
  assert.deepEqual(model.transitions.map(({ id }) => id), ['media.pdp3.transition.upload-receiving-to-verifying.v1']);
  const requestStateClaims = projectedRequests.map(({ journeyId, stepId }) => {
    const step = projectedJourney(journeyId).steps.find((candidate) => candidate.stepId === stepId);
    return { stepId, transitionRefs: step.transitionRefs, stateRef: step.stateRef, stateRefs: step.stateRefs,
      resultingStateRef: step.resultingStateRef, resultingStateRefs: step.resultingStateRefs };
  });
  assert.doesNotMatch(JSON.stringify(requestStateClaims), /CANCELLED|RUNNING|restored-session/iu,
    'cancel/retry/reconnect requests have no resulting-state claim; their semantic stateRefs remain guards/eligibility bindings');
  assert.match(phaseProjectionGenerator, /step\.stepDefinitionSemantics\?\.action\?\.transitionDisposition/u);
  assert.match(phaseProjectionGenerator, /step\.stepDefinitionSemantics\?\.transitionDisposition/u);
  assert.match(phaseProjectionGenerator, /step\.transitionApplicability/u);
  assert.match(phaseProjectionGenerator, /step\.stepDefinitionSemantics\?\.transitionApplicability/u);
  assert.match(phaseProjectionGenerator, /ownerStateDisposition\.includes\("SESSION_LOCAL_REVISION_ONLY; NO CANONICAL DOMAIN-STATE TRANSITION"\)/u);
  assert.match(phaseProjectionGenerator, /p1OperationRef: ownerBinding\?\.operationRef/u);
  assert.match(phaseProjectionGenerator, /p1OperationDefinitionRef: ownerBinding\?\.operationDefinitionRef/u);
  assert.match(phaseProjectionGenerator, /p1StateRefs: ownerBinding\?\.stateRefs/u);
  assert.match(phaseProjectionGenerator, /sourceTransitionDisposition: step\.transitionDisposition \?\? null/u,
    'the source-authored top-level disposition and reason remain visible in projection audit rows');
  assert.match(phaseProjectionGenerator, /unresolvedApplicableCommandCount/u);
  assert.match(phaseProjectionGenerator, /step\.transitionRef == null/u);
  assert.match(phaseProjectionGenerator, /if \(authored\.length > 0\) return "MIXED_OR_OTHER_SOURCE_DISPOSITION"/u,
    'unknown authored source statuses fail closed as mixed/unresolved evidence');
  assert.match(phaseProjectionGenerator, /request acceptance does not project CANCELLED, RUNNING, or restored state/u);
  assert.doesNotMatch(phaseProjectionGenerator, /Other PDP-1 transition rows lack a complete operation\/action\/guard edge binding/u);
  assert.deepEqual(['J-29/1', 'J-29/3'].map((key) => effectiveDispositionBySourceStep.get(key)),
    ['SOURCE_BACKED_NO_TRANSITION', 'SOURCE_BACKED_NO_TRANSITION']);
  assert.deepEqual(['J-29/2', 'J-29/4'].map((key) => effectiveDispositionBySourceStep.get(key)),
    ['CONDITIONAL_OR_REQUEST_OBSERVATION', 'CONDITIONAL_OR_REQUEST_OBSERVATION']);
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

test('PDP-3 report has no unresolved field mappings while owner review remains distinct', () => {
  const reportResult = spawnSync('node', ['scripts/report-media-definition-residuals.mjs', '--json'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  assert.ok([0, 1].includes(reportResult.status), reportResult.stderr);
  const report = JSON.parse(reportResult.stdout);
  const pdp3 = report.projections.find(({ phase }) => phase === 'PDP-3');
  assert.equal(pdp3.unresolvedFieldCount, 0);
  assert.deepEqual(pdp3.unresolvedFields.map(({ field }) => field), []);
  assert.ok(pdp3.ownerReviewPendingFields.includes('journeys'));
  assert.equal(specification.acceptance, 'NOT_CLAIMED');
  assert.match(specification.candidateMappingReview.ownerDecisionStatus, /PENDING/);
});

test('PDP-3 finality candidates preserve exact approved membership and enum dispositions', () => {
  const allActions = [...actionRegistry.actions, ...(actionRegistry.ownerDefinedActions ?? [])];
  const taxonomyByAction = new Map(publicTaxonomy.records.map((record) => [record.actionRef, record]));
  const sharedIds = ['media.action.select-identity-confirmed-workspace', 'media.action.start-upstream-identity-handoff'];
  const expectedPxd078 = actionRegistry.actions.map(({ id }) => id).filter((id) => !sharedIds.includes(id)).sort();
  const actualPxd078 = publicTaxonomy.records.filter((record) => record.mappingDecisionRef === '.product-experience/decision-log.md#PXD-078'
    && record.publicFinalityCandidate).map(({ actionRef }) => actionRef).sort();
  assert.deepEqual(actualPxd078, expectedPxd078, 'PXD-078 maps exactly the original 146 actions minus the two Shared identity handoffs');
  assert.deepEqual(publicTaxonomy.records.filter(({ actionRef }) => sharedIds.includes(actionRef))
    .map(({ actionRef, publicFinalityCandidate, mappingDecisionRef }) => ({ actionRef, publicFinalityCandidate, mappingDecisionRef })),
  sharedIds.map((actionRef) => ({ actionRef, publicFinalityCandidate: null, mappingDecisionRef: null })));
  const reconnect = taxonomyByAction.get('media.action.request-live-session-reconnect');
  assert.equal(reconnect.mappingDecisionRef, '.product-experience/decision-log.md#PXD-077');
  assert.deepEqual(reconnect.operationRefs, ['media.operation.capability.media-stream-session-reconnect']);
  assert.equal(reconnect.runtimeAdmission, 'NOT_ADMITTED');

  const historicalFinality = new Map(allActions.filter((action) => action.actionDefinitionSemantics?.publicFinality)
    .map((action) => [action.id, action.actionDefinitionSemantics.publicFinality]));
  const expected = [];
  for (const action of allActions) {
    const oldRecord = historicalFinality.get(action.id);
    const mapping = taxonomyByAction.get(action.id);
    if (oldRecord) { expected.push(oldRecord); continue; }
    if (!mapping?.publicFinalityCandidate) continue;
    expected.push({
      id: `${mapping.id}.finality`, actionRef: action.id, description: action.finality,
      confirmationDisposition: mapping.publicFinalityCandidate.confirmationDisposition,
      undoabilityDisposition: mapping.publicFinalityCandidate.undoabilityDisposition,
    });
  }
  assert.deepEqual(model.finality, expected);
  assert.equal(model.finality.length, 145);
  for (const finality of model.finality) {
    const action = allActions.find(({ id }) => id === finality.actionRef);
    assert.ok(action, `finality action ${finality.actionRef} resolves exactly`);
    const mapping = taxonomyByAction.get(finality.actionRef);
    if (historicalFinality.has(action.id)) {
      assert.deepEqual(finality, historicalFinality.get(action.id), 'the three original public records retain exact IDs and shape');
    } else {
      assert.equal(finality.confirmationDisposition, mapping.confirmationDisposition);
      assert.equal(finality.undoabilityDisposition, mapping.reversibilityDisposition);
    }
    assert.equal(action.actionDefinitionSemantics?.runtimeAdmission ?? mapping.runtimeAdmission, 'NOT_ADMITTED');
  }
});

test('PDP-3 action/effect candidate projection preserves original census, reviewed records, and Shared exclusions', () => {
  const allActions = [...actionRegistry.actions, ...(actionRegistry.ownerDefinedActions ?? [])];
  const taxonomyByAction = new Map(publicTaxonomy.records.map((record) => [record.actionRef, record]));
  const projectedActions = new Map(model.actions.map((action) => [action.id, action]));
  assert.equal(projectedActions.size, 147, '146 historical actions plus the additive owner-defined reconnect action');
  for (const source of allActions) {
    const projected = projectedActions.get(source.id);
    assert.ok(projected, `action ${source.id} is projected`);
    assert.equal(projected.description, source.effect);
    const historical = source.actionDefinitionSemantics?.publicEffect;
    const mapping = taxonomyByAction.get(source.id);
    const expectedEffectRefs = historical ? [historical.id] : mapping?.publicEffectCandidate ? [`${mapping.id}.effect`] : [];
    assert.deepEqual(projected.producesEffectRefs, expectedEffectRefs);
  }
  const expectedEffects = [];
  for (const action of allActions) {
    const historical = action.actionDefinitionSemantics?.publicEffect;
    const mapping = taxonomyByAction.get(action.id);
    if (historical) { expectedEffects.push(historical); continue; }
    if (!mapping?.publicEffectCandidate) continue;
    expectedEffects.push({
      id: `${mapping.id}.effect`, name: action.label, kind: mapping.publicEffectCandidate.kind,
      description: action.effect, reversibilityDisposition: mapping.publicEffectCandidate.reversibilityDisposition,
    });
  }
  assert.deepEqual(model.effects, expectedEffects);
  assert.equal(model.effects.length, 145);
  const historicalIds = allActions.flatMap((action) => action.actionDefinitionSemantics?.publicEffect ? [action.actionDefinitionSemantics.publicEffect.id] : []).sort();
  assert.deepEqual(historicalIds, ['media.effect.attach-source-version', 'media.effect.create-empty-project', 'media.effect.register-caption-version']);
  assert.deepEqual(model.effects.filter(({ id }) => historicalIds.includes(id)).map(({ id }) => id).sort(), historicalIds);
  assert.equal(specification.fieldMappingBlockers.find(({ field }) => field === 'effects'), undefined,
    'every applicable action has an exact effect disposition; unadmitted handoffs remain explicit in the source mapping');
  assert.equal(specification.fieldMappingBlockers.find(({ field }) => field === 'actions'), undefined);
  assert.equal(specification.fieldMappingBlockers.find(({ field }) => field === 'finality'), undefined);
  assert.match(specification.candidateMappingReview.fieldDispositions.effects.status, /145[_ ]BOUNDED[_ ]ENUM[_ ]CANDIDATES/u);
  assert.match(specification.candidateMappingReview.fieldDispositions.effects.status, /RUNTIME_AND_PHASE_ACCEPTANCE_PENDING/u);
  assert.match(specification.candidateMappingReview.fieldDispositions.actions.status, /TWO_SHARED_HANDOFFS_EXPLICITLY_UNADMITTED_EXTERNAL_OWNER_ROLES/u);
  assert.match(specification.candidateMappingReview.fieldDispositions.finality.status, /145[_ ]BOUNDED[_ ]ENUM[_ ]CANDIDATES/u);
});

test('PDP-3 scenarios and fixture descriptors require exact state, journey, and simulation-source links', async () => {
  const allStates = new Set(stateModels.models.flatMap((item) => (item.states ?? [])
    .filter((state) => typeof state === 'object' && typeof state.id === 'string')
    .map((state) => `${item.modelId}.${state.id}`)));
  const scenarioRecords = new Map(scenarioFixtureRegistry.fixtures.map((fixture) => [fixture.id, fixture]));
  const exactBindings = new Map(bindingReview.scenarioStartingStateBindings.map((binding) => [binding.scenarioRef, binding]));
  const localBindings = new Map(bindingReview.scenarioStartingContextBindings.records.map((binding) => [binding.scenarioRef, binding]));
  const journeyRefs = new Set();
  for (const entry of specification.sourceAuthorities.filter(({ sourceRef }) => sourceRef.includes('/journey-contracts/'))) {
    const journey = parse(await readFile(entry.sourceRef, 'utf8'));
    for (const ref of journey.scenarioRefs ?? []) journeyRefs.add(ref);
  }
  const actionScenarioRefs = new Set(actionRegistry.actions.flatMap((action) => action.scenarioRefs ?? []));
  const linked = new Set([...journeyRefs, ...actionScenarioRefs]);
  assert.equal(exactBindings.size, 16, 'canonical source-start links retain their original population');
  assert.equal(localBindings.size, 15, 'remaining starts are typed local fixture contexts, not invented canonical states');
  assert.equal(model.scenarios.length, 31);
  assert.equal(model.fixtures.length, 31);
  const scenarioBlocker = specification.fieldMappingBlockers.find(({ field }) => field === 'scenarios');
  assert.equal(scenarioBlocker, undefined, 'all fixture records have a canonical or explicitly local source start');
  for (const scenario of model.scenarios) {
    const source = scenarioRecords.get(scenario.id);
    const binding = exactBindings.get(scenario.id);
    const localBinding = localBindings.get(scenario.id);
    assert.ok(linked.has(scenario.id), `${scenario.id} has a journey or action source link`);
    assert.ok(source, `${scenario.id} has a registry record`);
    assert.ok((binding && allStates.has(binding.startingStateRef)) || localBinding, `${scenario.id} has an exact canonical or local context start`);
    assert.equal(scenario.startingStateRef, binding?.startingStateRef ?? localBinding.localContextRef);
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
    'historical canonical source-start links are preserved');
  assert.equal(model.scenarios.some(({ id }) => id === 'media.scenario.consent-revoked'), true,
    'consent-revoked uses a local synthetic context, not an asserted PDP-1 terminal state');
  assert.equal(model.states.some(({ id }) => id === 'media-rights-and-consent.consent.REVOKED'), false,
    'no sink-derived terminal claim is projected for an axis state');
  assert.equal(model.scenarios.some((scenario) => scenario.id === 'media.scenario.upload-interrupted'), true,
    'interrupted upload starts from an explicitly local fixture context; it does not invent a canonical upload state');
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
