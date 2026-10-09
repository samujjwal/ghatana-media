import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const toolsRequire = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url));
const { parse } = toolsRequire('yaml');
const readYaml = async (path) => parse(await readFile(path, 'utf8'));
const [registry, interactions, operations] = await Promise.all([
  readYaml('.product-experience/pdp-3-product-experience/action-registry.yaml'),
  readYaml('.product-experience/pdp-3-product-experience/interaction-registry.yaml'),
  readYaml('.product-experience/pdp-1-domain-data/operations.yaml'),
]);
const actionDispositionInventory = operations.actionOperationDispositionInventory;

test('all 146 PDP-3 actions retain exact authored actor, guard, effect, finality, and recovery source', () => {
  const actions = registry.actions;
  assert.equal(actions.length, 146, 'the recorded UI action denominator changed');
  const actionById = new Map(actions.map((action) => [action.id, action]));
  assert.equal(actionById.size, actions.length, 'action IDs must be unique');

  for (const action of actions) {
    assert.ok(action.actorRefs?.length, `${action.id} needs its exact allowed actor roles`);
    assert.equal(new Set(action.actorRefs).size, action.actorRefs.length, `${action.id} repeats actor roles`);
    assert.ok(action.preconditions?.length, `${action.id} needs explicit applicability and authorization guards`);
    assert.equal(typeof action.effect, 'string', `${action.id} needs an effect statement`);
    assert.ok(action.effect.trim(), `${action.id} effect must be non-empty`);
    assert.ok(action.finality?.trim(), `${action.id} needs an exact finality statement`);
    assert.ok(action.failure?.trim(), `${action.id} needs a denial, failure, or unknown-outcome recovery statement`);
    assert.ok(action.reversible !== undefined, `${action.id} needs a reversibility disposition`);
  }

  assert.equal(actionDispositionInventory.exactSourceActionCount, actions.length);
  assert.equal(actionDispositionInventory.records.length, actions.length);
  const dispositions = new Map(actionDispositionInventory.records.map((record) => [record.actionId, record]));
  assert.equal(dispositions.size, actions.length, 'the PDP-1 disposition inventory must include each action exactly once');
  const allowedDispositions = new Set([
    'EXACT_OPERATION_REFERENCE',
    'OWNER_DEFINED_EXACT_OPERATION_REFERENCE',
    'EXACT_ORDERED_WORKFLOW',
    'NO_DOMAIN_OPERATION_LOCAL_SELECTION_OR_SESSION_DRAFT',
    'READ_ONLY_OBSERVATION; QUERY_BINDING_UNRESOLVED',
    'CONSEQUENTIAL_OPERATION_UNBOUND',
    'OWNER_OPERATION_CLASSIFICATION_REQUIRED',
    'EXTERNAL_SHARED_IDENTITY_HANDOFF_OR_OBSERVATION; NO_MEDIA_DOMAIN_MUTATION',
    'EXTERNAL_SHARED_IDENTITY_HANDOFF; NO_MEDIA_DOMAIN_MUTATION',
  ]);
  for (const action of actions) {
    const disposition = dispositions.get(action.id);
    assert.ok(disposition, `${action.id} needs a domain-operation or non-domain disposition`);
    assert.equal(disposition.sourceRef, `.product-experience/pdp-3-product-experience/action-registry.yaml#${action.id}`);
    assert.equal(disposition.sourceEvidence.effect, action.effect, `${action.id} effect must match its source record exactly`);
    assert.equal(disposition.sourceEvidence.finality, action.finality, `${action.id} finality must match its source record exactly`);
    assert.deepEqual(disposition.sourceEvidence.preconditions, action.preconditions, `${action.id} guards must match their source record exactly`);
    assert.ok(allowedDispositions.has(disposition.domainOperationDisposition), `${action.id} has an unknown operation disposition`);
    assert.ok(disposition.ownerDefinitionStatus?.trim(), `${action.id} must preserve its independent-review/runtime boundary`);
  }

  const interactionIds = new Set(interactions.interactions.map(({ id }) => id));
  const operationIds = new Set([
    ...operations.operations.map(({ id }) => id),
    ...(operations.individualOperationContracts?.records ?? []).map(({ id }) => id),
    ...(operations.ownerDefinedOperationContracts?.records ?? []).map(({ id }) => id),
  ]);
  for (const interaction of interactions.interactions) {
    assert.ok(actionById.has(interaction.effectRef), `${interaction.id} has stale action ${interaction.effectRef}`);
  }
  assert.equal(interactionIds.size, interactions.interactions.length, 'interaction IDs must be unique');

  for (const action of actions) {
    const disposition = dispositionFor(dispositions, action.id);
    const semantics = action.actionDefinitionSemantics;
    assert.ok(semantics, `${action.id} needs a source-backed definition envelope`);
    assert.equal(semantics.actionRef, action.id, `${action.id} action definition must retain exact identity`);
    const envelope = semantics.sourceEnvelope;
    assert.ok(envelope, `${action.id} needs an explicit source envelope`);
    assert.deepEqual(envelope.actorRefs, action.actorRefs, `${action.id} role semantics must match source`);
    assert.deepEqual(envelope.preconditions, action.preconditions, `${action.id} guard semantics must match source`);
    assert.equal(envelope.effect, action.effect, `${action.id} effect semantics must match source`);
    assert.equal(envelope.reversible, action.reversible, `${action.id} reversibility must match source`);
    assert.equal(envelope.finality, action.finality, `${action.id} finality semantics must match source`);
    assert.equal(envelope.failure, action.failure, `${action.id} recovery semantics must match source`);
    assert.equal(envelope.domainOperationDisposition, dispositionFor(dispositions, action.id).domainOperationDisposition);
    assert.deepEqual(envelope.exactOperationRefs, dispositionFor(dispositions, action.id).exactOperationRefs);
    assert.equal(envelope.runtimeAdmission, 'NOT_ADMITTED');
    const typed = semantics.typedDefinition;
    assert.ok(typed, `${action.id} needs an explicitly typed semantic definition`);
    assert.equal(typed.ownerDefinitionDecisionRef, '.product-experience/decision-log.md#PXD-075');
    assert.equal(typed.semanticRole, roleFor(disposition.domainOperationDisposition));
    assert.deepEqual(typed.actorRefs, action.actorRefs);
    assert.deepEqual(typed.applicabilityGuards, action.preconditions);
    assert.equal(typed.effect, action.effect);
    assert.equal(typed.sourceReversibleValue, action.reversible);
    assert.equal(typed.finality, action.finality);
    assert.equal(typed.failureRecovery, action.failure);
    assert.equal(typed.domainOperationDisposition, disposition.domainOperationDisposition);
    assert.deepEqual(typed.exactOperationRefs, disposition.exactOperationRefs);
    assert.equal(typed.runtimeAdmission, 'NOT_ADMITTED');
    for (const operationRef of [semantics.operationRef, ...(semantics.orderedOperationRefs ?? [])].filter(Boolean)) {
      assert.ok(operationIds.has(operationRef), `${action.id} references unknown PDP-1 operation ${operationRef}`);
    }
    if (['CONDITIONAL', 'UNKNOWN'].includes(semantics.reversibility?.kind)) {
      assert.equal(semantics.publicEffect, undefined, `${action.id} must not coerce conditional/unknown reversibility`);
      assert.equal(semantics.publicFinality, undefined, `${action.id} must not coerce conditional/unknown undoability`);
    }
  }

  const retry = actionById.get('media.action.retry-job');
  assert.ok(retry.preconditions.some((guard) => guard.includes('prior-attempt-is-classified-as-retryable')));
  assert.ok(retry.preconditions.some((guard) => guard.includes('prior-outcome-is-not-unknown')));
  assert.match(retry.finality, /processing-outcome-remains-pending/u);
  assert.match(retry.failure, /do-not-dispatch/u);

  const cancellation = actionById.get('media.action.request-cancellation');
  assert.match(cancellation.finality, /pending-until-authoritative-stop-or-racing-result/u);
  assert.match(cancellation.failure, /running-or-unknown/u);
});

function dispositionFor(dispositions, actionId) {
  return dispositions.get(actionId);
}

function roleFor(disposition) {
  return {
    EXACT_OPERATION_REFERENCE: 'DOMAIN_OPERATION',
    OWNER_DEFINED_EXACT_OPERATION_REFERENCE: 'DOMAIN_OPERATION',
    EXACT_ORDERED_WORKFLOW: 'ORDERED_DOMAIN_WORKFLOW',
    NO_DOMAIN_OPERATION_LOCAL_SELECTION_OR_SESSION_DRAFT: 'LOCAL_SELECTION_OR_SESSION_DRAFT',
    'READ_ONLY_OBSERVATION; QUERY_BINDING_UNRESOLVED': 'READ_ONLY_OBSERVATION_QUERY_BINDING_UNRESOLVED',
    CONSEQUENTIAL_OPERATION_UNBOUND: 'CONSEQUENTIAL_OPERATION_UNBOUND',
    'EXTERNAL_SHARED_IDENTITY_HANDOFF_OR_OBSERVATION; NO_MEDIA_DOMAIN_MUTATION': 'EXTERNAL_SHARED_IDENTITY_HANDOFF_OR_OBSERVATION',
    'EXTERNAL_SHARED_IDENTITY_HANDOFF; NO_MEDIA_DOMAIN_MUTATION': 'EXTERNAL_SHARED_IDENTITY_HANDOFF',
    OWNER_OPERATION_CLASSIFICATION_REQUIRED: 'OWNER_OPERATION_CLASSIFICATION_REQUIRED',
  }[disposition];
}
