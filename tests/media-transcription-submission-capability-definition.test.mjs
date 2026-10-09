import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { validateTranscriptionSubmissionCapabilityDefinition as validate } from '../scripts/lib/media-transcription-submission-capability-definition-validation.mjs';
const { parse } = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url))('yaml');
const yaml = path => parse(readFileSync(path, 'utf8'));
const base = { review: yaml('.product-experience/pdp-0-product-truth/capability-leaf-review.yaml'), operations: yaml('.product-experience/pdp-1-domain-data/operations.yaml'), journey: yaml('.product-experience/pdp-3-product-experience/journey-contracts/transcribe-and-correct-captions.yaml'), actions: yaml('.product-experience/pdp-3-product-experience/action-registry.yaml') };
const slice = value => value.review.leaves.find(({ id }) => id === 'media.speech.transcription.file').transcriptionSubmissionDefinitionSlice;
test('existing job and file-transcription leaves bind only request acceptance', () => {
  assert.deepEqual(validate(base), []);
  assert.equal(base.review.leaves.length, 462);
  const file = base.review.leaves.find(({ id }) => id === 'media.speech.transcription.file');
  assert.deepEqual(file.operation.explicitOperationBindings, []);
  assert.match(file.operation.canonicalOperationDisposition, /unresolved/u);
});
test('submission slice rejects scientific quality, full leaf admission and streaming equivalence', () => {
  for (const change of [s => { s.fullLeafAcceptance = 'ACCEPTED'; }, s => { s.runtimeAdmission = 'ADMITTED'; }, s => { s.profileApplicability.noRecognitionOrQualityAdmission = false; }, s => { s.profileApplicability.noStreamingOrProviderCorrectionEquivalence = false; }, s => { s.profileApplicability.scopedReceiptReadDistinctFromProcessing = false; }]) {
    const negative = structuredClone(base); change(slice(negative)); assert.ok(validate(negative).length);
  }
});
test('submission slice rejects swapped operation, source pointer, action and step', () => {
  for (const change of [s => { s.operationRefs = ['media.operation.transcription']; }, s => { s.sourceContractRefs = ['.product-experience/pdp-1-domain-data/operations.yaml#/operations/2']; }, s => { s.actionRefs = ['media.action.review-transcript']; }, s => { s.journeyStepRefs = ['J03-3']; }]) {
    const negative = structuredClone(base); change(slice(negative)); assert.ok(validate(negative).length);
  }
});
