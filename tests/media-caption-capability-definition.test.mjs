import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { validateCaptionCapabilityDefinitions } from '../scripts/lib/media-caption-capability-definition-validation.mjs';
const parse = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url))('yaml').parse;
const read = (path) => parse(fs.readFileSync(path, 'utf8'));
const base = {
  review: read('.product-experience/pdp-0-product-truth/capability-leaf-review.yaml'),
  operations: read('.product-experience/pdp-1-domain-data/operations.yaml'),
  journey: read('.product-experience/pdp-3-product-experience/journey-contracts/transcribe-and-correct-captions.yaml'),
  actions: read('.product-experience/pdp-3-product-experience/action-registry.yaml'),
};
test('caption capabilities bind exact existing registration and comparison source identities', () => {
  assert.deepEqual(validateCaptionCapabilityDefinitions(base), []);
  assert.equal(base.review.leaves.length, 462);
  assert.equal(base.review.leaves.filter((leaf) => leaf.coverageDecision.disposition === 'UNRESOLVED').length, 383);
  assert.equal(base.review.leaves.filter((leaf) => leaf.coverageDecision.disposition === 'ACCEPTED').length, 0);
  assert.equal(base.journey.steps.length, 8);
  assert.equal(base.review.leaves.find(({ id }) => id === 'media.artifact.inspect').ownerDefinitionSlice.decisionRef, '.product-experience/decision-log.md#PXD-050');
});
test('caption definitions reject swapped scope, stale pointers and invented admission', () => {
  for (const [field, value, error] of [
    ['operationRefs', ['media.operation.caption-version-read'], 'swapped caption meaning'],
    ['journeyStepRefs', ['J03-8'], 'swapped caption meaning'],
    ['sourceContractRefs', ['.product-experience/pdp-1-domain-data/operations.yaml#/operations/0'], 'stale caption source pointer'],
    ['runtimeAdmission', 'ADMITTED', 'forged caption admission'],
    ['fullLeafAcceptance', 'ACCEPTED', 'forged caption admission'],
    ['decisionRef', '.product-experience/decision-log.md#PXD-039', 'unreviewed caption source'],
  ]) {
    const changed = structuredClone(base);
    changed.review.leaves.find(({ id }) => id === 'media.artifact.output.register').captionVersionDefinitionSlice[field] = value;
    assert.ok(validateCaptionCapabilityDefinitions(changed).some((issue) => issue.includes(error)));
  }
});
test('internal provenance metadata and declared clocks cannot admit export or scientific quality', () => {
  const changed = structuredClone(base);
  changed.actions.actions.find(({ id }) => id === 'media.action.save-caption-version').capabilityRefs.push('media.artifact.provenance.export');
  assert.ok(validateCaptionCapabilityDefinitions(changed).includes('internal registration provenance cannot imply provenance export'));
  for (const id of ['media.artifact.output.register', 'media.artifact.inspect']) {
    const slice = base.review.leaves.find((leaf) => leaf.id === id).captionVersionDefinitionSlice;
    assert.match(slice.contentBoundary, /do not.*scientific/u);
    assert.deepEqual(slice.profileApplicability.unresolvedAxes, ['execution-location', 'resource', 'reproducibility']);
  }
});
