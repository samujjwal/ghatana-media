import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const { parse } = createRequire(resolve(process.cwd(), '../ghatana-tools/package.json'))('yaml');

const readYaml = (path) => parse(readFileSync(path, 'utf8'));
const purposePath = '.product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml';
const purpose = readYaml(purposePath);
const journeyCatalog = readYaml('.product-experience/pdp-0-product-truth/journey-catalog.yaml');
const transitionEdges = readYaml('.product-experience/pdp-3-product-experience/journey-transition-edge-bindings.yaml');
const sources = {
  J01: '.product-experience/pdp-3-product-experience/journey-contracts/first-use-and-project-creation.yaml',
  J02: '.product-experience/pdp-3-product-experience/journey-contracts/upload-import-and-verify-artifact.yaml',
  J03: '.product-experience/pdp-3-product-experience/journey-contracts/transcribe-and-correct-captions.yaml',
  J06: '.product-experience/pdp-3-product-experience/journey-contracts/return-grounded-typed-consumer-results.yaml',
  J09: '.product-experience/pdp-3-product-experience/journey-contracts/create-review-and-deliver-from-a-brief.yaml',
  J16: '.product-experience/pdp-3-product-experience/journey-contracts/translate-and-dub-existing-video.yaml',
  J18: '.product-experience/pdp-3-product-experience/journey-contracts/compose-and-render-reviewed-media.yaml',
  J20: '.product-experience/pdp-3-product-experience/journey-contracts/long-running-job-observation-and-recovery.yaml',
  J22: '.product-experience/pdp-3-product-experience/journey-contracts/deliver-export-with-destination-acknowledgement.yaml',
};
const keyFor = (journey, ordinal) => `media.pdp3.step-purpose-binding.${journey.toLowerCase()}-step-${String(ordinal).padStart(2, '0')}.v1`;
const records = new Map(purpose.records.map((record) => [record.id, record]));
const getRecord = (journey, ordinal) => records.get(keyFor(journey, ordinal));
const getStep = (journey, ordinal) => readYaml(sources[journey]).steps[ordinal - 1];

const expected = [
  ['J09', 9, 'NO_EXACT_ACTION_TRANSITION'],
  ['J22', 2, 'NO_EXACT_ACTION_TRANSITION'],
  ['J01', 3, 'NO_P1_MACHINE_TRANSITION'],
  ['J20', 5, 'NO_EXACT_ACTION_TRANSITION'],
  ['J20', 6, 'NO_EXACT_ACTION_TRANSITION'],
  ['J06', 1, 'NO_P1_MACHINE_TRANSITION'],
  ['J02', 2, 'NO_P1_MACHINE_TRANSITION'],
  ['J03', 2, 'NO_P1_MACHINE_TRANSITION'],
  ['J03', 5, 'NO_P1_MACHINE_TRANSITION'],
  ['J03', 6, 'NO_P1_MACHINE_TRANSITION'],
  ['J03', 7, 'NO_P1_MACHINE_TRANSITION'],
  ['J16', 3, 'NO_P1_MACHINE_TRANSITION'],
  ['J18', 4, 'NO_P1_MACHINE_TRANSITION'],
];

test('MDC30 S01-S13 retain explicit source-bounded no-transition dispositions', () => {
  for (const [journey, ordinal, status] of expected) {
    const record = getRecord(journey, ordinal);
    assert.ok(record, `${journey}:${ordinal} purpose binding exists`);
    assert.equal(record.transitionDisposition.status, status, `${journey}:${ordinal} purpose disposition`);
    assert.deepEqual(record.transitionRefs ?? [], [], `${journey}:${ordinal} no transition ref`);
    const step = getStep(journey, ordinal);
    assert.ok(step.transitionDisposition, `${journey}:${ordinal} source step has a disposition`);
    assert.equal(step.transitionDisposition.transitionRef, null, `${journey}:${ordinal} source step has no transition ref`);
    assert.match(step.transitionDisposition.reason, /transition|state|draft|receipt|initial|request|submission|upload|session|caption/i, `${journey}:${ordinal} source rationale`);
  }
  for (const ordinal of [5, 6]) {
    const record = getRecord('J20', ordinal);
    const attempts = record.stateRefs.filter((ref) => ref.includes('stateMachines/media-attempt/'));
    const jobStates = record.stateRefs.filter((ref) => ref.includes('stateMachines/media-job/'));
    assert.deepEqual(attempts, [], `J20:${ordinal} does not bind media-attempt states`);
    assert.equal(jobStates.length, 9, `J20:${ordinal} binds the nine media-job states`);
    assert.deepEqual(record.stateRefs, getStep('J20', ordinal).stateRefs.filter((ref) => ref.includes('stateMachines/media-job/')), `J20:${ordinal} purpose binding matches source media-job states`);
    assert.equal(record.transitionDisposition.status, 'NO_EXACT_ACTION_TRANSITION');
  }
  const s06 = getRecord('J06', 1);
  assert.deepEqual(s06.stateRefs, [], 'S06 does not infer QUEUED from the unresolved operation join');
  assert.equal(s06.operationBindingBlocker, undefined, 'the exact source-defined wrapper join is now bound');
  assert.match(s06.mappingBasis, /three distinct operation roles/u);
  assert.match(s06.mappingBasis, /media.operation.action.submit-validated-request/u);
  assert.match(s06.mappingBasis, /media.operation.capability.media-multimodal-observe-source-grounded/u);
  assert.match(s06.mappingBasis, /media.operation.job.submit.v1/u);
  assert.match(s06.mappingBasis, /trusted tenant, principal and delegation/i);
  assert.match(s06.mappingBasis, /rights, consent, purpose/u);
  assert.match(s06.mappingBasis, /deadline and resource bounds/u);
  assert.match(s06.mappingBasis, /UNKNOWN retains the same request identity/u);
  assert.match(s06.mappingBasis, /does not establish a machine state or output/u);
  assert.ok(s06.sourceRefs.some((ref) => ref.includes('media.operation.action.submit-validated-request')));
  assert.ok(s06.sourceRefs.some((ref) => ref.includes('media.operation.capability.media-multimodal-observe-source-grounded')));
  assert.ok(s06.sourceRefs.some((ref) => ref.includes('media.operation.job.submit.v1')));
  assert.ok(s06.sourceRefs.some((ref) => ref.includes('capability-invocation-adapters.yaml#records/@id=media.pdp3.invocation-adapter.j06-source-grounded.v1')));
  assert.match(getStep('J06', 1).transitionDisposition.reason, /does not prove a P1 job state, QUEUED, execution, completion, or output availability/i);
});

test('J06 S01 retains its five journey-level nonhappy conditions as unallocated proposals', () => {
  const step = getStep('J06', 1);
  const semantics = step.stepDefinitionSemantics;
  const fixtureOracle = semantics.fixtureOracle;
  const sourceJourney = journeyCatalog.journeys.find(({ id }) => id === 'J-06');
  const conditions = [
    /privacy denial/i,
    /unqualified fallback/i,
    /cancellation boundary/i,
    /missing public API/i,
    /generic document request/i,
  ];

  assert.ok(conditions.every((condition) => condition.test(sourceJourney.criticalNonhappy)));
  assert.equal(step.failure.status, 'candidate-proposal');
  assert.equal(step.failure.scope, 'journey-level-not-allocated-to-this-step');
  assert.equal(step.failure.sourceRef, 'journey.criticalNonhappyPaths');
  assert.equal(fixtureOracle.status, 'NO_STEP_SCENARIO_BOUND');
  assert.equal(fixtureOracle.nonhappyBranch.status, 'candidate-proposal');
  assert.equal(fixtureOracle.nonhappyBranch.scope, 'journey-level-not-allocated-to-this-step');
  assert.equal(fixtureOracle.nonhappyBranch.sourceRef, 'journey.criticalNonhappyPaths');
  assert.deepEqual(semantics.canonicalBindings.scenarioRefs, []);
  assert.deepEqual(fixtureOracle.scenarioRefs, []);
  assert.deepEqual(fixtureOracle.scenarios, []);
  assert.equal(fixtureOracle.executable, false);
  assert.match(step.failure.proposal[0].condition, /Privacy denial, unqualified fallback, cancellation boundary, missing public API, or generic document request routed as video OCR by MIME alone/i);
});

test('MDC30 S14 binds T01 only to complete-upload under guarded finalization', () => {
  const record = getRecord('J02', 3);
  assert.equal(record.transitionDisposition.status, 'EXACT_GUARDED_P1_TRANSITION');
  assert.deepEqual(record.transitionRefs, ['media-upload-and-artifact/T01']);
  assert.deepEqual(record.actionExactOperationRefs, [
    'media.operation-slice.inspect-upload',
    'media.operation-slice.append-upload-chunk',
    'media.operation-slice.complete-upload',
  ]);
  assert.match(record.transitionDisposition.reason, /Only complete-upload binds.*T01/i);
  assert.match(record.transitionDisposition.reason, /append-upload-chunk has no transition/i);
  assert.doesNotMatch(record.transitionDisposition.reason, /AVAILABLE/i);
  const edge = transitionEdges.records.find((item) => item.transitionId === 'media-upload-and-artifact/T01');
  assert.deepEqual(edge.operationRefs, ['media.operation-slice.complete-upload']);
  assert.equal(edge.journeyActionDisposition, 'EXACT_JOURNEY_TRANSITION_ACTION_AND_OPERATION_INTERSECTION');
  assert.deepEqual(edge.exactJourneyBindings.map(({ journeyRef, stepId, canonicalOperationRefs }) => ({ journeyRef, stepId, canonicalOperationRefs })), [{
    journeyRef: 'J-02',
    stepId: 'J02-3',
    canonicalOperationRefs: ['media.operation-slice.inspect-upload', 'media.operation-slice.append-upload-chunk', 'media.operation-slice.complete-upload'],
  }]);
});
