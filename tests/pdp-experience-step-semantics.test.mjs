import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const toolsRequire = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url));
const { parse } = toolsRequire('yaml');
const base = '.product-experience/pdp-3-product-experience';
const actions = parse(await readFile(`${base}/action-registry.yaml`, 'utf8')).actions;
const ownerActions = parse(await readFile(`${base}/action-registry.yaml`, 'utf8')).ownerDefinedActions ?? [];
const ownerActionById = new Map(ownerActions.map((action) => [action.id, action]));
const actionById = new Map(actions.map((action) => [action.id, action]));
const journeyFiles = (await readdir(`${base}/journey-contracts`)).filter((path) => path.endsWith('.yaml')).sort();
const stepOracles = parse(await readFile(`${base}/step-definition-oracles.yaml`, 'utf8'));
const journeyRegistry = parse(await readFile(`${base}/journey-registry.yaml`, 'utf8'));

test('all 130 PDP-3 journey steps preserve their exact source facts and action disposition', async () => {
  const steps = [];
  for (const filename of journeyFiles) {
    const journey = parse(await readFile(`${base}/journey-contracts/${filename}`, 'utf8'));
    for (const [index, step] of journey.steps.entries()) steps.push({ filename, journey, index, step });
  }
  assert.equal(steps.length, 130);
  const oracleSteps = stepOracles.journeys.flatMap(({ steps: records }) => records);
  assert.equal(oracleSteps.length, 130);
  assert.equal(new Set(oracleSteps.map(({ canonicalBindings }) => canonicalBindings.bindingId)).size, 130);
  assert.equal(new Set(oracleSteps.map(({ canonicalBindings }) => canonicalBindings.semanticDefinitionId)).size, 130);
  assert.ok(oracleSteps.every(({ canonicalBindings }) => canonicalBindings.semanticDefinitionId.startsWith('media.step-semantic-definition.')));
  let linked = 0;
  let unresolved = 0;
  let choiceSets = 0;
  let ownerActionsBound = 0;
  for (const { filename, journey, index, step } of steps) {
    const binding = step.stepDefinitionSemantics;
    assert.ok(binding, `${journey.journeyId} step ${index + 1} has an explicit source disposition`);
    assert.equal(binding.schemaVersion, 'media.pdp-3-step-definition.v1');
    assert.equal(binding.sourceRef, `${base}/journey-contracts/${filename}#/steps/${index}`);
    assert.equal(binding.journeyRef, journey.journeyId);
    assert.equal(binding.ordinal, index + 1);
    assert.equal(binding.viewRef, step.view ?? step.viewRef);
    assert.deepEqual(binding.stepSourceFacts.result, step.result ?? null);
    assert.deepEqual(binding.stepSourceFacts.success, step.success ?? null);
    assert.deepEqual(binding.stepSourceFacts.failure, step.failure ?? null);
    assert.deepEqual(binding.stepSourceFacts.recovery, step.recovery ?? null);
    for (const key of ['surfaceRefs', 'objectRefs', 'stateRefs', 'canonicalOperationRef', 'authorityRef', 'transitionRef', 'requirementRefs', 'scenarioRefs']) {
      assert.deepEqual(binding.canonicalBindings[key], step[key] ?? (key.endsWith('Refs') ? [] : null), `${journey.journeyId}/${index + 1} exact ${key}`);
    }

    const semanticActionRef = binding.action.actionRef;
    if (binding.ownerActionRef) {
      ownerActionsBound += 1;
      const ownerAction = ownerActionById.get(binding.ownerActionRef);
      assert.ok(ownerAction, `${binding.ownerActionRef} is an exact owner-defined action`);
      assert.equal(step.ownerActionRef, ownerAction.id);
      assert.equal(ownerAction.operationRef, binding.operationContractBinding.operationRef);
      assert.equal(ownerAction.runtimeAdmission, 'NOT_ADMITTED');
      assert.deepEqual(ownerAction.guardRefs, binding.operationContractBinding.guardRefs);
      const expectedDecision = ownerAction.id === 'media.action.request-live-session-reconnect'
        ? '#PXD-077'
        : '#PXD-PENDING-PDP38-EXPERIENCE';
      assert.ok(ownerAction.ownerGuardDefinitions.every((guard) => guard.ownerDecisionRef.endsWith(expectedDecision)));
      assert.equal(binding.operationContractBinding.scopeStatus, 'OWNER_DEFINED_DEFINITION_ONLY');
      assert.equal(binding.operationContractBinding.runtimeAdmission, 'NOT_ADMITTED');
      continue;
    }
    if (!semanticActionRef) {
      if (binding.action.choiceSet || binding.choiceSet) {
        const choiceSet = binding.action.choiceSet ?? binding.choiceSet;
        choiceSets += 1;
        assert.equal(choiceSet.status, 'SOURCE_BOUND_ACTION_SET; USER_SELECTION_REQUIRED');
        assert.equal(choiceSet.selectedActionRef, null);
        assert.equal(choiceSet.defaultActionRef, null);
        assert.ok(choiceSet.options.length > 1);
        assert.deepEqual(choiceSet.options.map(({ actionRef }) => actionRef), step.candidateActionRefs);
        for (const option of choiceSet.options) {
          const action = actionById.get(option.actionRef);
          assert.ok(action, `choice option ${option.actionRef} is exact`);
          assert.equal(option.selection, 'EXPLICIT_USER_SELECTION_REQUIRED');
          assert.equal(option.runtimeAdmission, 'NOT_ADMITTED');
          assert.deepEqual(option.capabilityRefs, action.capabilityRefs);
        }
        assert.equal(binding.action.bindingStatus, 'EXPLICIT_ACTION_SET_NO_DEFAULT');
        continue;
      }
      unresolved += 1;
      if (binding.stepInteractionSemantics?.status === 'SOURCE_DEFINED_MEDIA_OWNER_RECOVERY_RULE; REVIEW_AND_RUNTIME_OPEN') {
        assert.equal(binding.bindingStatus, 'OWNER_DEFINED_LIVE_SESSION_RECOVERY_SEMANTICS; OPERATION_BINDING_AND_INDEPENDENT_REVIEW_OPEN');
        assert.equal(binding.action.bindingStatus, 'NO_DISPATCH_ACTION; LIVE_SESSION_OPERATION_IDENTITY_UNBOUND');
        assert.equal(binding.action.runtimeAdmission, 'NOT_ADMITTED');
        assert.ok(binding.stepInteractionSemantics.inputs.length > 0);
        continue;
      }
      if (binding.bindingStatus === 'PASSIVE_CANONICAL_QUERY_NO_ACTION_DISPATCH') {
        assert.equal(binding.action.bindingStatus, 'PASSIVE_CANONICAL_QUERY_NO_ACTION_DISPATCH');
        assert.equal(binding.operationContractBinding.operationRef, 'media.operation-slice.list-projects');
        assert.equal(binding.operationContractBinding.operationKind, 'QUERY');
        assert.equal(binding.operationContractBinding.runtimeAdmission, 'NOT_ADMITTED');
        continue;
      }
      assert.equal(binding.bindingStatus, 'SOURCE_STEP_RECORDED; ACTION_BINDING_UNRESOLVED');
      assert.equal(binding.action.bindingStatus, 'ACTION_BINDING_UNRESOLVED');
      assert.deepEqual(binding.action.candidateActionRefs, step.candidateActionRefs ?? []);
      assert.equal(binding.ownerDefinitionDecisionRef, null);
      continue;
    }
    linked += 1;
    const actionRef = step.actionRef ?? step.action;
    assert.equal(semanticActionRef, actionRef, `${journey.journeyId}/${index + 1} does not contradict its selected step action`);
    const action = actionById.get(semanticActionRef);
    assert.ok(action, `${journey.journeyId}/${index + 1} references an exact action`);
    const typed = action.actionDefinitionSemantics.typedDefinition;
    assert.equal(binding.ownerDefinitionDecisionRef, '.product-experience/decision-log.md#PXD-075');
    assert.equal(binding.bindingStatus, 'SOURCE_DEFINED_ACTION_SEMANTICS; REVIEW_AND_RUNTIME_OPEN');
    assert.equal(binding.action.actionDefinitionDecisionRef, typed.ownerDefinitionDecisionRef);
    assert.equal(binding.action.semanticRole, typed.semanticRole);
    assert.deepEqual(binding.action.actorRefs, action.actorRefs);
    assert.deepEqual(binding.action.guards, action.preconditions);
    assert.equal(binding.action.effect, action.effect);
    assert.equal(binding.action.reversibilityDisposition, typed.reversibilityDisposition);
    assert.equal(binding.action.finality, action.finality);
    assert.equal(binding.action.failureRecovery, action.failure);
    assert.equal(binding.action.domainOperationDisposition, typed.domainOperationDisposition);
    assert.deepEqual(binding.action.exactOperationRefs, typed.exactOperationRefs);
    assert.equal(binding.action.runtimeAdmission, 'NOT_ADMITTED');
  }
  assert.equal(linked, 120);
  assert.equal(choiceSets, 5);
  assert.equal(ownerActionsBound, 1);
  assert.equal(unresolved, 4, 'only the passive exact query and J-29 no-dispatch observations/gates remain without action selection');

  const current = journeyRegistry.currentStepBindingObservation;
  assert.equal(current.status, 'CURRENT_SOURCE_INVENTORY_ONLY; INDEPENDENT_REVIEW_AND_RUNTIME_OPEN');
  assert.deepEqual(current.actionDispositionCounts, {
    exactSourceActionRef: 120,
    ownerDefinedActionRef: 1,
    explicitUnselectedChoiceSet: 5,
    passiveCanonicalQueryWithoutActionDispatch: 1,
    explicitNoDispatchObservationOrGate: 3,
    unresolvedStepActionBinding: 0,
  });
  const nonempty = (field) => steps.filter(({ step }) => (step.stepDefinitionSemantics.canonicalBindings[field] ?? []).length > 0).length;
  assert.deepEqual(current.canonicalBindingPopulation, {
    surfaceRefsNonempty: nonempty('surfaceRefs'),
    objectRefsNonempty: nonempty('objectRefs'),
    stateRefsNonempty: nonempty('stateRefs'),
    primaryCanonicalOperationRefNonNull: steps.filter(({ step }) => step.stepDefinitionSemantics.canonicalBindings.canonicalOperationRef !== null).length,
    primaryCanonicalOperationRefNull: steps.filter(({ step }) => step.stepDefinitionSemantics.canonicalBindings.canonicalOperationRef === null).length,
    authorityRefsNonempty: nonempty('authorityRefs'),
    singularAuthorityRefNonNull: steps.filter(({ step }) => step.stepDefinitionSemantics.canonicalBindings.authorityRef !== null).length,
    transitionRefNonNull: steps.filter(({ step }) => step.stepDefinitionSemantics.canonicalBindings.transitionRef !== null).length,
    requirementRefsNonempty: nonempty('requirementRefs'),
    scenarioRefsNonempty: nonempty('scenarioRefs'),
  });
  const sourceRoleByStep = steps.map(({ step }) => {
    const binding = step.stepDefinitionSemantics;
    if (binding.ownerActionRef) return binding.action.semanticRole;
    if (binding.action.choiceSet || binding.choiceSet) return 'EXPLICIT_ACTION_CHOICE';
    if (binding.bindingStatus === 'PASSIVE_CANONICAL_QUERY_NO_ACTION_DISPATCH') return binding.bindingStatus;
    return binding.action.semanticRole;
  });
  const roleCounts = Object.fromEntries([...new Set(sourceRoleByStep)]
    .sort().map((role) => [role, sourceRoleByStep.filter((value) => value === role).length]));
  assert.deepEqual(current.actionSemanticRoleCounts, roleCounts);
  assert.equal(current.acceptanceBoundary.includes('do not establish independent PDP-3 acceptance'), true);
  assert.equal(journeyRegistry.coverageObservation.status,
    'HISTORICAL_SOURCE_INVENTORY_SUPERSEDED_BY_CURRENT_STEP_BINDING_OBSERVATION; NOT_CURRENT');
  assert.equal(journeyRegistry.coverageObservation.historicalObservationDisposition.priorStepActionBindingCount, 18);
  assert.equal(journeyRegistry.coverageObservation.historicalObservationDisposition.priorUnresolvedStepActionBindingCount, 112);
});

test('ambiguous live-session steps are not rebound to unrelated generic job actions', async () => {
  const liveSession = parse(await readFile(`${base}/journey-contracts/live-session-loss-consent-change-and-bounded-recovery.yaml`, 'utf8'));
  assert.equal(liveSession.steps.length, 4);
  for (const [index, step] of liveSession.steps.entries()) {
    if (index === 3) {
      assert.equal(step.ownerActionRef, 'media.action.request-live-session-reconnect');
      assert.equal(step.canonicalOperationRef, 'media.operation.capability.media-stream-session-reconnect');
      assert.equal(step.stepDefinitionSemantics.operationContractBinding.operationKind, 'COMMAND');
      assert.equal(step.stepDefinitionSemantics.operationContractBinding.runtimeAdmission, 'NOT_ADMITTED');
      assert.ok(step.stepDefinitionSemantics.action.ownerActionRef);
      assert.equal(step.stepDefinitionSemantics.stepInteractionSemantics.guardRefs.length, step.guardRefs.length);
      continue;
    }
    assert.equal(step.stepDefinitionSemantics.action.actionRef, null, `J-29 step ${index + 1} needs a session-specific canonical action`);
    assert.equal(step.stepDefinitionSemantics.action.bindingStatus, 'NO_DISPATCH_ACTION; LIVE_SESSION_OPERATION_IDENTITY_UNBOUND');
    assert.equal(step.stepDefinitionSemantics.stepInteractionSemantics.runtimeAdmission, 'NOT_ADMITTED');
    assert.ok(step.stepDefinitionSemantics.fixtureOracle.definitionCases.length >= 3);
  }
});

test('first-use identity step binds the approved Media adapter definition without claiming Shared wire or runtime acceptance', async () => {
  const oracle = stepOracles.journeys.find(({ journeyId }) => journeyId === 'J-01').steps[0];
  const handoffs = parse(await readFile(`${base}/handoff-bindings.yaml`, 'utf8'));
  const identity = handoffs.handoffs.find(({ id }) => id === 'media.handoff.identity');
  assert.ok(identity);
  assert.equal(identity.mediaOwnerDefinition.sourceDecisionRef, '.product-experience/decision-log.md#PXD-082');
  assert.equal(oracle.coverageDisposition, 'SOURCE_BINDING_RECORDED');
  assert.equal(oracle.canonicalBindings.bindingKind, 'EXTERNAL_SHARED_IDENTITY_HANDOFF_BOUNDARY');
  assert.equal(oracle.canonicalBindings.externalHandoffRef,
    `${base}/handoff-bindings.yaml#handoffs/@id=media.handoff.identity/mediaOwnerDefinition/adapterEnvelopeDefinition`);
  assert.equal(oracle.canonicalBindings.externalHandoffDecisionRef, '.product-experience/decision-log.md#PXD-082');
  assert.equal(oracle.canonicalBindings.externalWireBindingStatus, 'PENDING_SHARED_OWNER_EVIDENCE');
  assert.deepEqual(oracle.canonicalBindings.operationRefs, []);
  assert.equal(oracle.canonicalBindings.runtimeAdmission, 'NOT_ADMITTED');
  assert.match(oracle.coverageReason, /does not claim executable authentication, membership, or workspace authorization/u);
});
