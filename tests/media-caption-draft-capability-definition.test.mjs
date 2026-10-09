import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { validateCaptionDraftCapabilityDefinition } from '../scripts/lib/media-caption-draft-capability-definition-validation.mjs';
const parse = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url))('yaml').parse;
const read = (path) => parse(fs.readFileSync(path, 'utf8'));
const base = {
  review: read('.product-experience/pdp-0-product-truth/capability-leaf-review.yaml'),
  operations: read('.product-experience/pdp-1-domain-data/operations.yaml'),
  journey: read('.product-experience/pdp-3-product-experience/journey-contracts/transcribe-and-correct-captions.yaml'),
  actions: read('.product-experience/pdp-3-product-experience/action-registry.yaml'),
};
test('two existing draft actions bind one local derivation slice while forced alignment stays distinct', () => {
  assert.deepEqual(validateCaptionDraftCapabilityDefinition(base), []);
  assert.equal(base.review.leaves.length, 462);
  assert.equal(base.review.leaves.filter((leaf) => leaf.coverageDecision.disposition === 'UNRESOLVED').length, 383);
  assert.equal(base.review.leaves.filter((leaf) => leaf.coverageDecision.disposition === 'ACCEPTED').length, 0);
  const forced = base.review.leaves.find(({ id }) => id === 'media.speech.transcription.forced-align');
  assert.equal(forced.coverageDecision.disposition, 'JOURNEY_STEP');
  assert.match(forced.manualTimingNonEquivalence.broadJourneyTrace, /context only.*not exact operation/u);
  assert.equal(base.journey.steps.length, 8);
});
test('draft slice rejects stale source bindings and promoted persistence or alignment admission', () => {
  for (const [field, value, error] of [
    ['operationRefs', ['media.operation.caption-version-write'], 'swapped draft meaning'],
    ['journeyStepRefs', ['J03-7'], 'swapped draft meaning'],
    ['sourceContractRefs', ['.product-experience/pdp-1-domain-data/operations.yaml#/operations/0'], 'stale draft source pointer'],
    ['runtimeAdmission', 'ADMITTED', 'forged draft admission'],
    ['fullLeafAcceptance', 'ACCEPTED', 'forged draft admission'],
    ['sourceDecisionRef', '.product-experience/decision-log.md#PXD-039', 'unreviewed draft capability'],
  ]) {
    const changed = structuredClone(base);
    changed.review.leaves.find(({ id }) => id === 'media.artifact.derive').captionDraftDefinitionSlice[field] = value;
    assert.ok(validateCaptionDraftCapabilityDefinition(changed).some((issue) => issue.includes(error)));
  }
});
test('manual user ticks cannot qualify a forced-alignment operation or immutable registration', () => {
  const changed = structuredClone(base);
  changed.actions.actions.find(({ id }) => id === 'media.action.align-caption-timing').capabilityRefs.push('media.speech.transcription.forced-align');
  assert.ok(validateCaptionDraftCapabilityDefinition(changed).some((issue) => issue.startsWith('manual edit cannot admit forced alignment')));
  const falseEngine = structuredClone(base);
  falseEngine.review.leaves.find(({ id }) => id === 'media.speech.transcription.forced-align').operation.explicitOperationBindings.push({ operationRef: 'media.operation.caption-draft-write' });
  assert.ok(validateCaptionDraftCapabilityDefinition(falseEngine).includes('forced alignment is not satisfied by manual draft editing'));
  for (const field of ['noRegistrationApprovalOrPublication', 'noDurabilityOrStorageAdmission', 'conditionalLocalUndoOnly', 'unqualifiedClockBlocksTickAlignment']) {
    const clone = structuredClone(base);
    clone.review.leaves.find(({ id }) => id === 'media.artifact.derive').captionDraftDefinitionSlice.profileApplicability[field] = false;
    assert.ok(validateCaptionDraftCapabilityDefinition(clone).some((issue) => issue.endsWith(field)));
  }
});
