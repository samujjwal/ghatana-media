import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolveExperienceDefinitionSemantics } from '../scripts/lib/media-experience-definition-mapping.mjs';

const toolsRequire = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url));
const { parse } = toolsRequire('yaml');
const base = '.product-experience/pdp-3-product-experience';
const [actions, recovery, bindings, journey, operations] = await Promise.all([
  readFile(`${base}/action-registry.yaml`, 'utf8').then(parse),
  readFile(`${base}/recovery-finality-contracts.yaml`, 'utf8').then(parse),
  readFile(`${base}/experience-source-bindings.yaml`, 'utf8').then(parse),
  readFile(`${base}/journey-contracts/upload-import-and-verify-artifact.yaml`, 'utf8').then(parse),
  readFile('.product-experience/pdp-1-domain-data/operations.yaml', 'utf8').then(parse),
]);
const reviewRef = '.product-experience/decision-log.md#PXD-052';
const selected = (id) => actions.actions.find((entry) => entry.id === id);

test('J-02 source definitions preserve the original population and bind only existing identities', async () => {
  const journeyFiles = (await readdir(`${base}/journey-contracts`)).filter((path) => path.endsWith('.yaml'));
  let totalSteps = 0;
  for (const path of journeyFiles) {
    const doc = parse(await readFile(`${base}/journey-contracts/${path}`, 'utf8'));
    totalSteps += doc.steps?.length ?? 0;
  }
  assert.equal(actions.actions.length, 146);
  assert.equal(journeyFiles.length, 30);
  assert.equal(totalSteps, 130);
  assert.equal(recovery.contracts.length, 5);
  assert.equal(journey.journeyId, 'J-02');

  const refs = new Set(actions.actions.map(({ id }) => id));
  for (const step of journey.steps) {
    if (step.action) assert.ok(refs.has(step.action), `unknown J-02 action ${step.action}`);
  }
  const scenarios = new Set(parse(await readFile(`${base}/scenario-fixture-registry.yaml`, 'utf8')).fixtures.map(({ id }) => id));
  const operationIds = new Set(operations.individualOperationContracts.records.map(({ id }) => id));
  assert.deepEqual(bindings.j02RecoveryApplicability.cases.map(({ scenarioRef }) => scenarioRef), [
    'media.scenario.upload-outcome-unknown',
    'media.scenario.upload-interrupted',
    'media.scenario.upload-permission-revoked',
  ]);
  for (const item of bindings.j02RecoveryApplicability.cases) {
    assert.ok(scenarios.has(item.scenarioRef));
    for (const operationRef of item.orderedOperationRefs) assert.ok(operationIds.has(operationRef), `unknown operation slice ${operationRef}`);
  }
  assert.equal(bindings.j02RecoveryApplicability.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(bindings.j02RecoveryApplicability.cases[0].distinctFromRecoveryRef, 'media.recovery.outcome-unknown');
});

test('conditional upload effects and read observations are not coerced to public undo booleans', () => {
  for (const id of ['media.action.begin-artifact-upload', 'media.action.resume-artifact-upload', 'media.action.inspect-artifact']) {
    const semantics = selected(id).actionDefinitionSemantics;
    assert.equal(semantics.actionRef, id);
    assert.equal(semantics.reviewDecisionRef, reviewRef);
    assert.equal(semantics.runtimeAdmission, 'NOT_ADMITTED');
    assert.equal(semantics.publicBooleanDisposition, 'PUBLIC_BOOLEAN_NOT_REPRESENTABLE');
    assert.equal(semantics.publicEffect, undefined);
    assert.equal(semantics.publicFinality, undefined);
  }
  assert.equal(selected('media.action.begin-artifact-upload').actionDefinitionSemantics.reversibility.kind, 'CONDITIONAL');
  const resume = selected('media.action.resume-artifact-upload').actionDefinitionSemantics;
  assert.equal(resume.reversibility.kind, 'CONDITIONAL');
  assert.deepEqual(resume.orderedOperationRefs, [
    'media.operation-slice.inspect-upload', 'media.operation-slice.append-upload-chunk', 'media.operation-slice.complete-upload',
  ]);
  assert.ok(resume.guards.includes('explicit-confirmation-before-append-or-complete'));
  assert.ok(resume.guards.includes('inspect-after-unknown-never-auto-replay'));
  const inspect = selected('media.action.inspect-artifact').actionDefinitionSemantics;
  assert.equal(inspect.reversibility.kind, 'UNKNOWN');
  assert.equal(inspect.operationRef, 'media.operation-slice.inspect-artifact');
});

test('attachment definition maps only its supported immutable project-reference effect', () => {
  const semantics = selected('media.action.attach-source-asset').actionDefinitionSemantics;
  assert.equal(semantics.reviewDecisionRef, reviewRef);
  assert.equal(semantics.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(semantics.reversibility.kind, 'NOT_REVERSIBLE');
  assert.equal(semantics.operationBinding, 'OWNER_DEFINED_EXACT_OPERATION_REFERENCE');
  assert.equal(semantics.operationRef, 'media.operation-slice.attach-source-asset');
  assert.equal(semantics.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(semantics.publicEffect.reversible, false);
  assert.equal(semantics.publicFinality.confirmationRequired, true);
  assert.equal(semantics.publicFinality.undoable, false);
  assert.equal(semantics.publicEffect.kind, semantics.effectKind);
  const projected = resolveExperienceDefinitionSemantics(actions.actions, recovery.contracts);
  assert.ok(projected.effects.some(({ id }) => id === semantics.publicEffect.id));
  assert.ok(projected.finality.some(({ id }) => id === semantics.publicFinality.id));
});

test('existing recovery records remain manual, source-defined, and non-admitted', () => {
  const projected = resolveExperienceDefinitionSemantics(actions.actions, recovery.contracts);
  assert.equal(projected.recoveries.length, 5);
  for (const contract of recovery.contracts) {
    const definition = contract.definitionSemantics;
    assert.equal(definition.reviewDecisionRef, reviewRef);
    assert.equal(definition.runtimeAdmission, 'NOT_ADMITTED');
    assert.equal(definition.publicRecovery.id, contract.id);
    assert.equal(definition.publicRecovery.automaticRecovery, false);
    assert.equal(definition.publicRecovery.userActionRequired, true);
  }
});
