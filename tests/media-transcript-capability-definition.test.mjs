import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { validateTranscriptCapabilityDefinition } from '../scripts/lib/media-transcript-capability-definition-validation.mjs';
const parse = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url))('yaml').parse;
const read = (path) => parse(fs.readFileSync(path, 'utf8'));
const base = {
  review: read('.product-experience/pdp-0-product-truth/capability-leaf-review.yaml'),
  operations: read('.product-experience/pdp-1-domain-data/operations.yaml'),
  journey: read('.product-experience/pdp-3-product-experience/journey-contracts/transcribe-and-correct-captions.yaml'),
  actions: read('.product-experience/pdp-3-product-experience/action-registry.yaml'),
};
test('transcript inspection binds one existing capability without retiring other inspection definitions', () => {
  assert.deepEqual(validateTranscriptCapabilityDefinition(base), []);
  assert.equal(base.review.leaves.length, 462);
  assert.equal(base.review.leaves.filter((leaf) => leaf.coverageDecision.disposition === 'UNRESOLVED').length, 383);
  const inspect = base.review.leaves.find(({ id }) => id === 'media.artifact.inspect');
  assert.equal(inspect.ownerDefinitionSlice.decisionRef, '.product-experience/decision-log.md#PXD-050');
  assert.equal(inspect.captionVersionDefinitionSlice.decisionRef, '.product-experience/decision-log.md#PXD-061');
  assert.equal(base.journey.steps.length, 8);
});
test('transcript definition rejects unrelated identity, source pointer and promoted admission', () => {
  for (const [field, value, error] of [
    ['operationRefs', ['media.operation.caption-version-read'], 'swapped transcript meaning'],
    ['journeyStepRefs', ['J03-8'], 'swapped transcript meaning'],
    ['domainObjectRefs', ['media.domain.transcription'], 'swapped transcript meaning'],
    ['sourceContractRefs', ['.product-experience/pdp-1-domain-data/operations.yaml#/operations/0'], 'stale transcript source pointer'],
    ['runtimeAdmission', 'ADMITTED', 'forged transcript admission'],
    ['fullLeafAcceptance', 'ACCEPTED', 'forged transcript admission'],
    ['sourceDecisionRef', '.product-experience/decision-log.md#PXD-039', 'unreviewed transcript definition'],
  ]) {
    const changed = structuredClone(base);
    changed.review.leaves.find(({ id }) => id === 'media.artifact.inspect').transcriptVersionDefinitionSlice[field] = value;
    assert.ok(validateTranscriptCapabilityDefinition(changed).some((issue) => issue.includes(error)));
  }
});
test('untimed transcript inspection cannot qualify a caption parent or invent scientific evidence', () => {
  for (const field of ['missingTimingDoesNotBlockInspection', 'missingRequiredClockBlocksCaptionParentQualification', 'noScientificQualityAdmission']) {
    const changed = structuredClone(base);
    changed.review.leaves.find(({ id }) => id === 'media.artifact.inspect').transcriptVersionDefinitionSlice.profileApplicability[field] = false;
    assert.ok(validateTranscriptCapabilityDefinition(changed).some((issue) => issue.endsWith(field)));
  }
  const changed = structuredClone(base);
  changed.actions.actions.find(({ id }) => id === 'media.action.review-transcript').capabilityRefs.push('media.artifact.output.register');
  assert.ok(validateTranscriptCapabilityDefinition(changed).includes('transcript inspection cannot imply registration or approval'));
});
