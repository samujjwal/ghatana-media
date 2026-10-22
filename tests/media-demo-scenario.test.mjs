import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildDemoScenario, readSources, ROOT, validateDemoScenario, validateJsonSchema } from '../scripts/lib/media-demo-scenario.mjs';

const schema = JSON.parse(await readFile(path.join(ROOT, 'schemas/media-demo-scenario-spec.v1.schema.json'), 'utf8'));
const inputs = await readSources(ROOT);

test('source-derived J03 recipe is schema-valid and fails closed on current missing Build joins', async () => {
  const scenario = buildDemoScenario(inputs);
  assert.deepEqual(validateJsonSchema(scenario, schema), []);
  assert.equal(scenario.demoScenarioId, 'media.demo.j03.corrected-captions.v1');
  assert.equal(scenario.journeyId, 'J-03');
  assert.deepEqual(scenario.targets.captureTargets, ['EXPLORER_SIMULATED', 'PRODUCT_EXECUTED']);
  assert.equal(scenario.targets.productRecordingRef, null);
  assert.equal(scenario.effectsExecuted, false);
  assert.equal(scenario.canonicalAdmission, 'NOT_ASSERTED');
  assert.equal(scenario.status, 'BLOCKED_SOURCE_TRACE');
  assert.ok(scenario.validationIssues.some((issue) => issue.code === 'UNADMITTED_CHANNEL'));
  assert.ok(scenario.validationIssues.some((issue) => issue.code === 'P1_OPERATION_NOT_JOINED_TO_SELECTED_EDGE'));
  assert.equal(scenario.sourcePhaseStatuses['PDP-0'].status, 'DEV_COMPLETE');
  assert.equal(scenario.storyboard.beats.length, 24);
});

test('source material changes fail the currentness check instead of silently repinning', async () => {
  const changed = structuredClone(inputs);
  changed.phaseStatuses['docs/implementation/pdp-3-phase-dev-status.json'].sourceShaSet[
    '.product-experience/pdp-3-product-experience/demo-recording-standard.yaml'
  ] = '0'.repeat(64);
  const scenario = buildDemoScenario(changed);
  assert.ok(scenario.validationIssues.some((issue) => issue.code === 'STALE_MATERIAL_HASH'));
  assert.equal(scenario.status, 'BLOCKED_SOURCE_TRACE');
});

test('missing P1 operation result and mismatched edge are explicit blockers', () => {
  const altered = structuredClone(inputs);
  const targetId = 'media.operation.transcription-submission';
  const ops = altered.parsed['.product-experience/pdp-1-domain-data/operations.yaml'];
  for (const key of ['operations', 'individualOperationContracts', 'ownerDefinedOperationContracts']) {
    const value = ops[key];
    if (Array.isArray(value)) ops[key] = value.filter((record) => record.id !== targetId);
    else if (Array.isArray(value?.records)) value.records = value.records.filter((record) => record.id !== targetId);
  }
  const j03Web = altered.parsed['.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml'].edges.find((edge) => edge.id.endsWith('j03.web.v1'));
  j03Web.pdp1OperationRefs = (j03Web.pdp1OperationRefs ?? []).filter((operationRef) => operationRef !== targetId);
  const scenario = buildDemoScenario(altered);
  assert.ok(scenario.validationIssues.some((issue) => issue.code === 'P1_RESULT_BINDING_MISSING' && issue.detail.includes(targetId)));
  assert.ok(scenario.validationIssues.some((issue) => issue.code === 'P1_OPERATION_NOT_JOINED_TO_SELECTED_EDGE' && issue.detail === targetId));
});

test('schema rejects invented Build capture, effect, or owner admission claims', async () => {
  const scenario = buildDemoScenario(inputs);
  const candidate = structuredClone(scenario);
  candidate.targets.productRecordingRef = 'recording.mov';
  candidate.effectsExecuted = true;
  candidate.canonicalAdmission = 'ADMITTED';
  const errors = validateJsonSchema(candidate, schema);
  assert.ok(errors.some((error) => error.keyword === 'type' && error.pointer === '$.targets.productRecordingRef'));
  assert.ok(errors.some((error) => error.keyword === 'const' && error.pointer === '$.effectsExecuted'));
  assert.ok(errors.some((error) => error.keyword === 'const' && error.pointer === '$.canonicalAdmission'));
  assert.ok(validateDemoScenario(candidate).some((error) => error.code === 'EFFECT_OR_ADMISSION_CLAIM_FORBIDDEN'));
});

test('schema rejects absent storyboard source bindings', async () => {
  const scenario = buildDemoScenario(inputs);
  const candidate = structuredClone(scenario);
  delete candidate.storyboard.beats[0].purposeBindingRef;
  const errors = validateJsonSchema(candidate, schema);
  assert.ok(errors.some((error) => error.keyword === 'required' && error.missing === 'purposeBindingRef'));
});
