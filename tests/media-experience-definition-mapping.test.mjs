import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveExperienceDefinitionSemantics as resolve } from '../scripts/lib/media-experience-definition-mapping.mjs';
const decision = '.product-experience/decision-log.md#PXD-052';
function action() {
  return { id: 'media.action.fixture', actionDefinitionSemantics: {
    actionRef: 'media.action.fixture', reviewDecisionRef: decision, runtimeAdmission: 'NOT_ADMITTED',
    effectKind: 'state-change', reversibility: { kind: 'NOT_REVERSIBLE' },
    publicEffect: { id: 'fixture.effect', name: 'Fixture', kind: 'state-change', description: 'Fixture definition', reversible: false },
    publicFinality: { id: 'fixture.finality', actionRef: 'media.action.fixture', description: 'Recorded definition', confirmationRequired: true, undoable: false },
  } };
}
function recovery() {
  return { id: 'fixture.recovery', definitionSemantics: {
    reviewDecisionRef: decision, runtimeAdmission: 'NOT_ADMITTED',
    publicRecovery: { id: 'fixture.recovery', errorKind: 'outcome-unknown', recoveryPath: 'Observe original identity; never replay uncertain work', automaticRecovery: false, userActionRequired: true },
  } };
}
test('typed definition projection emits only exact unconditional effects, finality and manual recovery', () => {
  const a = action(); const r = recovery(); const result = resolve([a], [r]);
  assert.deepEqual(result.effects, [a.actionDefinitionSemantics.publicEffect]);
  assert.deepEqual(result.finality, [a.actionDefinitionSemantics.publicFinality]);
  assert.deepEqual(result.recoveries, [r.definitionSemantics.publicRecovery]);
  assert.deepEqual(result.effectRefsByAction.get(a.id), ['fixture.effect']);
});
test('conditional and unknown reversibility cannot be narrowed to public booleans', () => {
  for (const kind of ['CONDITIONAL', 'UNKNOWN']) {
    const a = action(); a.actionDefinitionSemantics.reversibility.kind = kind;
    assert.throws(() => resolve([a], []), /conditional boolean coercion/);
    delete a.actionDefinitionSemantics.publicEffect; delete a.actionDefinitionSemantics.publicFinality;
    assert.deepEqual(resolve([a], []).conditionalActions, [a.id]);
    assert.deepEqual(resolve([a], []).effects, []);
  }
});
test('wrong owner, invented runtime admission, shape drift, duplicate IDs and boolean meaning fail closed', () => {
  const mutations = [
    (d) => { d.reviewDecisionRef = '.product-experience/decision-log.md#PXD-049'; },
    (d) => { d.runtimeAdmission = 'ADMITTED'; },
    (d) => { d.actionRef = 'other'; },
    (d) => { d.publicEffect.kind = 'mutation'; },
    (d) => { d.publicEffect.reversible = true; },
    (d) => { d.publicFinality.undoable = true; },
    (d) => { d.publicEffect.guessed = true; },
    (d) => { d.publicFinality.actionRef = 'other'; },
  ];
  for (const mutate of mutations) { const a = action(); mutate(a.actionDefinitionSemantics); assert.throws(() => resolve([a], []), /Invalid experience definition/); }
  assert.throws(() => resolve([action(), action()], []), /duplicate record/);
});
test('manual recovery rejects automatic replay, source identity drift and forged admission', () => {
  const mutations = [
    (d) => { d.publicRecovery.automaticRecovery = true; },
    (d) => { d.publicRecovery.id = 'other'; },
    (d) => { d.publicRecovery.userActionRequired = 'true'; },
    (d) => { d.runtimeAdmission = 'ADMITTED'; },
    (d) => { d.reviewDecisionRef = 'invented'; },
  ];
  for (const mutate of mutations) { const r = recovery(); mutate(r.definitionSemantics); assert.throws(() => resolve([], [r]), /Invalid experience definition/); }
});
