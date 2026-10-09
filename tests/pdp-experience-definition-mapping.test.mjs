import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolveExperienceDefinitionSemantics } from '../scripts/lib/media-experience-definition-mapping.mjs';

const toolsRequire = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url));
const { parse } = toolsRequire('yaml');
const [actionRegistry, recoveryRegistry, taxonomy] = await Promise.all([
  readFile('.product-experience/pdp-3-product-experience/action-registry.yaml', 'utf8').then(parse),
  readFile('.product-experience/pdp-3-product-experience/recovery-finality-contracts.yaml', 'utf8').then(parse),
  readFile('.product-experience/pdp-3-product-experience/public-effect-finality-taxonomy.yaml', 'utf8').then(parse),
]);

test('PDP-3 typed action semantics project only exact owner definitions', () => {
  const result = resolveExperienceDefinitionSemantics(actionRegistry.actions, recoveryRegistry.contracts, taxonomy);
  assert.equal(actionRegistry.actions.length, 146);
  assert.equal(result.effects.length, 144, 'bounded PXD-078 candidates project with enum reversibility dispositions');
  assert.equal(result.finality.length, 144, 'bounded PXD-078 candidates project with enum confirmation/undoability dispositions');
  assert.equal(result.unmappedPublicActions.length, 2, 'the exact Shared identity handoffs remain unmapped');
  assert.equal(result.effects.length + result.unmappedPublicActions.length, 146,
    'every original action is either mapped or remains explicitly unmapped');
  assert.ok(!result.conditionalActions.includes('media.action.begin-artifact-upload'), 'conditional enum values are representable without boolean coercion');
  assert.ok(!result.conditionalActions.includes('media.action.request-transcription'));
  assert.ok(!result.effectRefsByAction.has('media.action.attach-source-asset') || result.effectRefsByAction.get('media.action.attach-source-asset').length === 1);

  const actionsById = new Map([...actionRegistry.actions, ...(actionRegistry.ownerDefinedActions ?? [])].map((action) => [action.id, action]));
  for (const effect of result.effects) {
    const actionRef = taxonomy.records.find((record) => `${record.id}.effect` === effect.id)?.actionRef;
    const action = actionsById.get(actionRef) ?? [...actionsById.values()].find((candidate) => candidate.actionDefinitionSemantics?.publicEffect?.id === effect.id);
    assert.ok(action, `${effect.id} has an exact source action`);
    if (action.actionDefinitionSemantics.publicEffect) {
      assert.deepEqual(effect, action.actionDefinitionSemantics.publicEffect, 'historical public records retain their exact IDs and values');
    } else {
      assert.equal(typeof effect.reversibilityDisposition, 'string');
      assert.equal('reversible' in effect, false);
    }
  }
  for (const entry of result.finality) {
    const action = actionsById.get(entry.actionRef);
    assert.ok(action, `${entry.id} has an exact source action`);
    if (action.actionDefinitionSemantics.publicFinality) assert.deepEqual(entry, action.actionDefinitionSemantics.publicFinality, 'historical public records retain their exact IDs and values');
    else {
      assert.equal(typeof entry.confirmationDisposition, 'string');
      assert.equal(typeof entry.undoabilityDisposition, 'string');
      assert.equal('undoable' in entry, false);
      assert.equal('confirmationRequired' in entry, false);
    }
    if (action.actionDefinitionSemantics.typedDefinition.confirmationDisposition === 'REQUIRED') assert.ok(action.confirmation?.trim());
  }
  assert.deepEqual(result.effects.filter(({ id }) => !id.startsWith('media.public-taxonomy.')).map(({ id }) => id).sort(), [
    'media.effect.attach-source-version', 'media.effect.create-empty-project', 'media.effect.register-caption-version',
  ]);
});

test('PDP-3 typed action mapping rejects stale decision, effect, role, and operation identities', () => {
  const clone = () => structuredClone(actionRegistry.actions);
  const reject = (mutate, pattern) => {
    const actions = clone();
    mutate(actions);
    assert.throws(() => resolveExperienceDefinitionSemantics(actions, recoveryRegistry.contracts, taxonomy), pattern);
  };
  reject((actions) => { actions[0].actionDefinitionSemantics.typedDefinition.ownerDefinitionDecisionRef = 'PXD-999'; }, /typed action definition mismatch/u);
  reject((actions) => { actions[0].actionDefinitionSemantics.typedDefinition.effect = 'invented-effect'; }, /typed action definition mismatch/u);
  reject((actions) => { actions[0].actionDefinitionSemantics.typedDefinition.semanticRole = 'DOMAIN_OPERATION'; }, /typed action definition mismatch/u);
  reject((actions) => { const semantics = actions.find((action) => action.id === 'media.action.attach-source-asset').actionDefinitionSemantics; semantics.operationRef = 'media.operation-slice.inspect-artifact'; semantics.typedDefinition.operationRef = 'media.operation-slice.inspect-artifact'; }, /unlinked exact operation|historical decision scope drift/u);
  reject((actions) => {
    const action = actions.find((entry) => ['CONDITIONAL', 'UNKNOWN'].includes(entry.actionDefinitionSemantics.typedDefinition.reversibilityDisposition));
    action.actionDefinitionSemantics.publicEffect = { id: 'bad', name: 'bad', kind: 'state-change', description: 'bad', reversible: false };
  }, /conditional boolean coercion|unbounded historical public record/u);
});
