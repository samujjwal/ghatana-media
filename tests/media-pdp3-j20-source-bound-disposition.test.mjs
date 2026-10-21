import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';

const { parse } = createRequire(resolve(process.cwd(), '../ghatana-tools/package.json'))('yaml');
const readYaml = (sourcePath) => parse(readFileSync(sourcePath, 'utf8'));
const p0 = readYaml('.product-experience/pdp-0-product-truth/journey-catalog.yaml');
const p1 = readYaml('.product-experience/pdp-1-domain-data/operations.yaml');
const outcomes = readYaml('.product-experience/pdp-1-domain-data/action-contracts.yaml');
const journey = readYaml('.product-experience/pdp-3-product-experience/journey-contracts/long-running-job-observation-and-recovery.yaml');

test('J20 source-bound completion disposition preserves exact identity and UNKNOWN semantics', () => {
  const definition = journey.completionDisposition;
  const p0Journey = p0.journeys.find(({ id }) => id === 'J-20');
  const scopedQuery = p1.ownerDefinedOperationProfiles.profiles.find(({ id }) => id === 'media.operation-profile.scoped-query.v1');
  const observationBinding = journey.pdp1ResultEvidence.operationResultBindings.find(({ operationRef }) => operationRef === 'media.operation.action.view-job-status');

  assert.ok(p0Journey && scopedQuery);
  assert.equal(definition.status, 'SOURCE_BOUND_DEFINITION_ONLY; RUNTIME_NOT_ADMITTED; OWNER_EVIDENCE_NOT_ASSERTED');
  assert.deepEqual(definition.sourceRefs, [
    '.product-experience/pdp-0-product-truth/journey-catalog.yaml#journeys/@id=J-20/completion',
    '.product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationProfiles/profiles/@id=media.operation-profile.scoped-query.v1/resultEnvelope',
    '.product-experience/pdp-1-domain-data/action-contracts.yaml#outcomes/@id=UNKNOWN_OUTCOME',
  ]);
  assert.match(p0Journey.completion, /User observes completion or known uncertainty/u);
  assert.match(p0Journey.completion, /preserves completed work/u);
  assert.match(definition.completion, /owner-confirmed completion or a known uncertainty/u);
  assert.match(definition.completion, /preserves already completed work/u);
  assert.match(definition.identity, /exact requestId and job identity \(exactTargetRef\)/u);
  assert.match(definition.unknownDisposition, /retain UNKNOWN for that same requestId and job/u);
  assert.match(definition.unknownDisposition, /do not infer success, failure, cancellation, or absence from timeout/u);
  assert.match(definition.recoveryDisposition, /inspect\/reconcile the existing job first/u);
  assert.match(definition.recoveryDisposition, /Preserve completed work and prior-attempt history/u);
  assert.match(definition.evidenceBoundary, /no owner receipt, runtime result, transport admission, or completion evidence is asserted/u);
  assert.equal(definition.runtimeAdmission, 'NOT_ADMITTED');
  assert.ok(observationBinding);
  assert.equal(observationBinding.requestSchemaRef, '.product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationProfiles/profiles/@id=media.operation-profile.scoped-query.v1/requestEnvelope');
  assert.equal(observationBinding.resultSchemaRef, '.product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationProfiles/profiles/@id=media.operation-profile.scoped-query.v1/resultEnvelope');
  assert.match(observationBinding.exactResult, /requestId, exactTargetRef, ownerReceipt, and observedAt/u);
  assert.match(observationBinding.unknownDisposition, /Missing, stale, unavailable, or incomplete evidence remains UNKNOWN/u);
  assert.ok(scopedQuery.resultEnvelope.absence.includes('never global absence'));
  assert.ok(outcomes.outcomes.some(({ id }) => id === 'UNKNOWN_OUTCOME'));
});
