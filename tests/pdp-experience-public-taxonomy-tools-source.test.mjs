import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const toolsRoot = new URL('../../ghatana-tools/', import.meta.url);
const toolsRequire = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url));
const { parse } = toolsRequire('yaml');
const Ajv = toolsRequire('ajv').default;
const [actionsText, operationsText, taxonomyText, schemaText] = await Promise.all([
  readFile('.product-experience/pdp-3-product-experience/action-registry.yaml', 'utf8'),
  readFile('.product-experience/pdp-1-domain-data/operations.yaml', 'utf8'),
  readFile('.product-experience/pdp-3-product-experience/public-effect-finality-taxonomy.yaml', 'utf8'),
  readFile(new URL('libs/product-development/experience-specification/schemas/experience-specification.v1.schema.json', toolsRoot), 'utf8'),
]);
const actions = parse(actionsText);
const operations = parse(operationsText);
const taxonomy = parse(taxonomyText);
const schema = JSON.parse(schemaText);

const operationById = new Map();
for (const operation of operations.operations ?? []) operationById.set(operation.id, operation);
for (const group of ['capabilityOperationContracts', 'individualOperationContracts', 'ownerDefinedOperationContracts']) {
  for (const operation of operations[group]?.records ?? []) {
    for (const ref of operation.operationRefs ?? [operation.id]) operationById.set(ref, operation);
  }
}

const sourceCommit = execFileSync('git', ['-C', new URL('../../ghatana-tools/', import.meta.url).pathname, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addSchema(schema);
const validateEffect = ajv.getSchema(`${schema.$id}#/definitions/effect`);
const validateFinality = ajv.getSchema(`${schema.$id}#/definitions/finality`);

const printErrors = (validate) => JSON.stringify(validate.errors ?? []);

test('Media enum candidates validate against the exact current Tools source schema without using the installed snapshot', () => {
  assert.equal(sourceCommit, taxonomy.toolsSchemaBoundary.sourceCommit);
  assert.equal(sourceCommit, '6ed280283872df7889369b71abb3c9e62cb17f8d');
  assert.equal(taxonomy.toolsSchemaBoundary.installedSnapshotDisposition.includes('predates the enum extension'), true);
  assert.equal(taxonomy.toolsSchemaBoundary.candidateValidation.includes('does not claim the package is published'), true);

  const sourceActions = new Map([...actions.actions, ...(actions.ownerDefinedActions ?? [])].map((action) => [action.id, action]));
  for (const record of taxonomy.records.filter((entry) => entry.publicEffectCandidate)) {
    const action = sourceActions.get(record.actionRef);
    assert.ok(action, `action ${record.actionRef} resolves`);
    const effect = {
      id: `${record.id}.effect`,
      name: record.actionRef,
      kind: record.publicEffectCandidate.kind,
      description: action.effect,
      reversibilityDisposition: record.publicEffectCandidate.reversibilityDisposition,
    };
    assert.equal(validateEffect(effect), true, `effect candidate must match Tools source schema: ${printErrors(validateEffect)}`);
    const finality = {
      id: `${record.id}.finality`,
      actionRef: record.actionRef,
      description: action.finality,
      confirmationDisposition: record.publicFinalityCandidate.confirmationDisposition,
      undoabilityDisposition: record.publicFinalityCandidate.undoabilityDisposition,
    };
  assert.equal(validateFinality(finality), true, `finality candidate must match Tools source schema: ${printErrors(validateFinality)}`);
    assert.equal(record.runtimeAdmission, 'NOT_ADMITTED');
  }
  assert.equal(taxonomy.records.filter((record) => record.mappingDecisionRef === '.product-experience/decision-log.md#PXD-078').length, 144);
  assert.equal(taxonomy.records.filter((record) => record.mappingDecisionRef === '.product-experience/decision-log.md#PXD-077').length, 1);
});

test('current Tools source schema rejects enum/boolean conflict and missing enum branches', () => {
  const effectConflict = {
    id: 'probe.effect', name: 'probe', kind: 'external-call', description: 'probe',
    reversible: true, reversibilityDisposition: 'UNKNOWN',
  };
  assert.equal(validateEffect(effectConflict), false);
  const effectMissing = { id: 'probe.effect', name: 'probe', kind: 'external-call', description: 'probe' };
  assert.equal(validateEffect(effectMissing), false);
  const finalityConflict = {
    id: 'probe.finality', actionRef: 'probe', description: 'probe',
    confirmationRequired: true, confirmationDisposition: 'UNRESOLVED',
    undoable: false, undoabilityDisposition: 'UNKNOWN',
  };
  assert.equal(validateFinality(finalityConflict), false);
});
