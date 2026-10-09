import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const toolsRequire = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url));
const { parse } = toolsRequire('yaml');
const readYaml = (path) => parse(readFileSync(path, 'utf8'));
const grammar = readYaml('.product-experience/pdp-2-design-interface-system/action-finality-grammar.yaml').boundedProjectSetupSlice;
const operations = readYaml('.product-experience/pdp-1-domain-data/operations.yaml').individualOperationContracts.records;
const journey = readYaml('.product-experience/pdp-3-product-experience/journey-contracts/first-use-and-project-creation.yaml');

test('J-01 project setup grammar binds only the three exact canonical PDP-1 project operations', () => {
  assert.equal(grammar.decisionRef, '.product-experience/decision-log.md#PXD-056');
  assert.equal(grammar.journeyRef, '.product-experience/pdp-0-product-truth/journey-catalog.yaml#J-01');
  assert.equal(grammar.scope, 'create-an-empty-project-with-its-initial-immutable-revision; intent-selection-and-media-processing-are-outside-J-01');
  assert.equal(journey.steps.length, 4);
  assert.equal(grammar.interactionGrammar.orderedJourneySteps, journey.steps.length);
  assert.deepEqual(Object.keys(grammar.interactionGrammar.stepBindings), ['J01-1', 'J01-2', 'J01-3', 'J01-4']);
  for (const step of journey.steps) {
    const binding = grammar.interactionGrammar.stepBindings[step.stepId];
    assert.ok(binding, `missing interaction binding for ${step.stepId}`);
    assert.equal(binding.view, step.view);
    assert.deepEqual(binding.operationRefs, step.requiredOperationRefs);
    assert.equal(binding.transitionDisposition, step.transitionDisposition.status);
  }
  assert.equal(journey.optionalContinuation.view, 'media.view.create-media');

  const byId = new Map(operations.map((operation) => [operation.id, operation]));
  assert.deepEqual(Object.keys(grammar.operations).sort(), ['create', 'inspect', 'list']);
  for (const [key, id] of [
    ['create', 'media.operation-slice.create-project'],
    ['list', 'media.operation-slice.list-projects'],
    ['inspect', 'media.operation-slice.inspect-project'],
  ]) {
    assert.equal(grammar.operations[key].operationRef, id);
    assert.ok(byId.has(id), `PDP-1 is missing ${id}`);
    assert.equal(byId.get(id).executionAdmission, 'NOT_ADMITTED');
  }

  const create = byId.get(grammar.operations.create.operationRef);
  assert.deepEqual(grammar.operations.create.requestFields, create.requestFields);
  assert.deepEqual(grammar.operations.create.committedState, 'media-project/ACTIVE-plus-media-project-version/COMMITTED');
  assert.deepEqual(create.transition.transitionRefs, [], 'project creation initializes its aggregate; it does not fabricate a transition');
  assert.match(create.outcomes.unknownOutcome, /inspect-by-the-same-requestId-before-any-resubmission/u);
  assert.match(grammar.operations.create.uncertainOutcome, /same-creationRequestId/u);
  assert.match(grammar.operations.create.confirmation, /explicit-user-confirmation/u);

  const list = byId.get(grammar.operations.list.operationRef);
  const inspect = byId.get(grammar.operations.inspect.operationRef);
  assert.equal(list.operationKind, 'QUERY');
  assert.equal(inspect.operationKind, 'QUERY');
  assert.deepEqual(grammar.operations.list.output, list.resultFields);
  assert.deepEqual(grammar.operations.inspect.output, inspect.resultFields);
  assert.match(inspect.selectorSemantics.creationRequestId, /never-creates-or-replays/u);
  assert.match(inspect.outcomes.notFound, /never-global-nonexistence/u);
});

test('J-01 records definition grammar separately from current channel and Shared authority availability', () => {
  assert.match(grammar.status, /bounded-definition-grammar/u);
  assert.match(grammar.authorityRefs.deploymentQualification, /NOT_ADMITTED/u);
  assert.match(grammar.identityAndContext.handoff, /Shared-owned-authentication/u);
  assert.match(grammar.identityAndContext.handoff, /remain-unqualified/u);
  assert.match(grammar.identityAndContext.protectedDataGate, /before-project-list-inspection-or-mutation/u);
  assert.match(grammar.identityAndContext.workspaceSelection, /not-itself-authentication-or-project-access-authority/u);
  assert.equal(grammar.runtimeAdmission, 'NOT_ADMITTED');

  const api = readYaml('.product-experience/pdp-3-product-experience/api/api-registry.yaml');
  const sdk = readYaml('.product-experience/pdp-3-product-experience/sdk/operation-registry.yaml');
  const cli = readYaml('.product-experience/pdp-3-product-experience/cli/production-command-registry.yaml');
  const tools = readYaml('.product-experience/pdp-3-product-experience/agent-tools/tool-registry.yaml');
  assert.equal(grammar.channelApplicability.http.currentRouteBinding, 'none-claimed; no-route-or-wire-equivalence-inferred');
  assert.equal(api.operations.some(({ operationId }) => /project/i.test(operationId)), false);
  assert.deepEqual(grammar.channelApplicability.sdk.currentMatchingMethods, []);
  assert.equal(sdk.methods.some(({ id }) => /project/i.test(id)), false);
  assert.deepEqual(grammar.channelApplicability.cli.currentMatchingCommands, []);
  assert.equal(cli.commands.some(({ commandId }) => /project/i.test(commandId)), false);
  assert.deepEqual(grammar.channelApplicability.agentTool.currentMatchingTools, []);
  assert.equal(tools.tools.some(({ id }) => /project/i.test(id)), false);
  assert.match(grammar.channelApplicability.web.implementation, /qualification-open/u);
});
