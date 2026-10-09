import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generator = path.join(repo, 'scripts/generate-media-lifecycle-source-inputs.mjs');
const phaseSourcePaths = [
  '.product-experience/pdp-0-product-truth/requirements.yaml',
  '.product-experience/pdp-0-product-truth/domain-model.yaml',
  '.product-experience/pdp-0-product-truth/journey-catalog.yaml',
  '.product-experience/pdp-0-product-truth/handoff-contracts.yaml',
  '.product-experience/pdp-0-product-truth/quality-policy.yaml',
  '.product-experience/pdp-1-domain-data/interoperability.yaml',
  '.product-experience/pdp-2-design-interface-system/agent-tools/conventions.yaml',
  '.product-experience/pdp-0-product-truth/nonfunctional-requirements.yaml',
  '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml',
  '.product-experience/pdp-0-product-truth/goals-jtbd.yaml',
  '.product-experience/pdp-1-domain-data/states.yaml',
  '.product-experience/pdp-1-domain-data/transitions.yaml',
  '.product-experience/pdp-1-domain-data/transition-guard-contracts.yaml',
  '.product-experience/pdp-1-domain-data/domain-objects.yaml',
  '.product-experience/pdp-1-domain-data/operations.yaml',
  '.product-experience/pdp-1-domain-data/events.yaml',
  '.product-experience/pdp-1-domain-data/relationships.yaml',
  '.product-experience/pdp-1-domain-data/value-objects.yaml',
  '.product-experience/pdp-2-design-interface-system/component-contracts.yaml',
  '.product-experience/pdp-2-design-interface-system/component-value-types.yaml',
  '.product-experience/pdp-2-design-interface-system/gui/composition-validation-grammar.yaml',
  '.product-experience/pdp-2-design-interface-system/api/conventions.yaml',
  '.product-experience/pdp-2-design-interface-system/cli-language.yaml',
  '.product-experience/pdp-2-design-interface-system/gui/layout.yaml',
  '.product-experience/pdp-2-design-interface-system/gui/patterns/catalog.yaml',
  '.product-experience/pdp-2-design-interface-system/gui/templates/catalog.yaml',
  '.product-experience/pdp-2-design-interface-system/media-token-aliases.yaml',
  '.product-experience/pdp-3-product-experience/journey-registry.yaml',
  '.product-experience/pdp-3-product-experience/handoff-bindings.yaml',
  '.product-experience/pdp-3-product-experience/action-registry.yaml',
  '.product-experience/pdp-3-product-experience/public-effect-finality-taxonomy.yaml',
  '.product-experience/pdp-3-product-experience/view-observation-input-contracts.yaml',
  '.product-experience/pdp-3-product-experience/view-observation-predicates.yaml',
  '.product-experience/pdp-3-product-experience/view-state-binding-dispositions.yaml',
  '.product-experience/pdp-3-product-experience/step-definition-oracles.yaml',
  '.product-experience/pdp-3-product-experience/screen-registry.yaml',
];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-lifecycle-generator-'));
  const put = (relativePath, content) => {
    const absolute = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  };
  for (const relativePath of phaseSourcePaths) {
    const collections = {
      'goals-jtbd.yaml': 'goals', 'handoff-contracts.yaml': 'handoffs',
      'capability-leaf-review.yaml': 'leaves',
      'requirements.yaml': 'requirements', 'nonfunctional-requirements.yaml': 'ownerMeasurementDefinitions.records', 'states.yaml': 'stateMachines',
      'transition-guard-contracts.yaml': 'records',
      'public-effect-finality-taxonomy.yaml': 'records',
      'view-observation-input-contracts.yaml': 'factSchemas',
      'view-observation-predicates.yaml': 'predicates',
      'view-state-binding-dispositions.yaml': 'views',
      'step-definition-oracles.yaml': 'journeys',
      'composition-validation-grammar.yaml': 'normativeRuleRecords',
      'cli-language.yaml': 'normativeRuleRecords',
      'component-value-types.yaml': 'normativeTypeRecords',
      'handoff-bindings.yaml': 'handoffs',
      'transitions.yaml': 'transitionRecords', 'domain-objects.yaml': 'objects',
      'operations.yaml': 'operations', 'relationships.yaml': 'relationships',
      'events.yaml': 'events',
      'value-objects.yaml': 'values', 'component-contracts.yaml': 'components',
      'layout.yaml': 'layouts', 'catalog.yaml': relativePath.includes('/patterns/') ? 'patterns' : relativePath.includes('/templates/') ? 'templates' : 'journeys',
      'media-token-aliases.yaml': 'aliases', 'journey-registry.yaml': 'journeys',
      'screen-registry.yaml': 'screens', 'action-registry.yaml': 'ownerDefinedActions',
    };
    const collection = collections[path.basename(relativePath)];
    const extra = relativePath.endsWith('screen-registry.yaml') ? '\nlaneViews: []\n'
      : relativePath.endsWith('operations.yaml') ? '\nindividualOperationContracts:\n  records: []\nownerDefinedOperationContracts:\n  records: []\nownerDefinedOperationProfiles:\n  profiles: []\nownerTypedObservationContracts:\n  records: []\nownerTypedObservationValidationRules:\n  records: []\nownerLeafWireContracts:\n  records: []\n  outputTypes:\n    records: []\n  mediaTypePolicies:\n    records: []\ncapabilityOperationContracts:\n  records: []\n  families: []\n  bounds: []\n  inputPayloadSchemas: []\n  outputPayloadSchemas: []\n  scalarTypeRecords: []\n'
      : relativePath.endsWith('goals-jtbd.yaml') ? '\nownerDefinedMigrationRules:\n  records: []\nsuccessMeasureContracts:\n  ownerCapabilityApplicabilityCrosswalk:\n    measureApplicabilityRecords:\n      records: []\n'
      : relativePath.endsWith('domain-objects.yaml') ? '\nownerOutputArtifactTypeCrosswalk:\n  records: []\nownerTypedIdentityContracts:\n  records: []\n  relationshipBindings: []\n  tupleRules: []\n  persistenceAndWireSemantics:\n    id: fixture.identity-boundary\n'
      : relativePath.endsWith('events.yaml') ? '\nownerEventContracts:\n  records: []\n  notificationRecords: []\n'
      : relativePath.endsWith('transitions.yaml') ? '\nownerDefinedTransitionRecords: []\nownerMachineRaceApplicability:\n  records: []\nownerRaceResolutionContract:\n  id: fixture.race-contract\n  invariants: []\n  resolutionCases: []\n'
      : relativePath.endsWith('value-objects.yaml') ? '\ncanonicalConversionDefinitions:\n  records: []\nownerDescriptorDefinitions:\n  records: []\n'
      : relativePath.endsWith('capability-leaf-review.yaml') ? '\nownerCapabilityLeafAdjudication:\n  records: []\n'
      : relativePath.endsWith('action-registry.yaml') ? '\nactions: []\n' : '';
    const dedicated = {
      'domain-model.yaml': 'ownerDefinedMigrationRules:\n  records: []\n',
      'journey-catalog.yaml': 'ownerMigrationSemanticRules:\n  records: []\n',
      'quality-policy.yaml': 'qualityDimensions: []\nmetricDefinitions: []\nownerQualityApplicabilityCrosswalk:\n  records: []\n',
      'interoperability.yaml': 'packageCompatibilityBoundary:\n  id: fixture.compatibility\n',
      'conventions.yaml': 'mediaOwnedToolDefinitionContracts:\n  contracts: []\n  hostInvocationContext:\n    id: fixture.host-context\n  invocationSemantics:\n    id: fixture.invocation-policy\n',
      'nonfunctional-requirements.yaml': 'ownerMeasurementDefinitions:\n  records: []\n',
    };
    put(relativePath, relativePath.endsWith('/api/conventions.yaml') ? 'normativeRuleRecords: []\n' : dedicated[path.basename(relativePath)] ?? `${collection}: []${extra}`);
  }
  const base = 'config/closure/media-product-definition';
  const json = (relativePath, value) => put(`${base}/${relativePath}`, `${JSON.stringify(value, null, 2)}\n`);
  json('obligations.json', []);
  json('phase-program.json', { phases: ['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3'].map((id) => ({ id, obligationIds: [] })) });
  json('phase-binding.json', { phases: Object.fromEntries(['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3'].map((id) => [id, { obligationIds: [] }])) });
  json('surface.json', { obligationIds: [] });
  json('l02-source-case-links.json', { candidateLinks: [], obligationIds: [], unmappedObligationIds: [] });
  json('l03-proof-route-candidates.json', { l02CaseLinkReview: {}, routes: [] });
  return { root, put, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function run(root, ...args) {
  return spawnSync(process.execPath, [generator, '--root', root, ...args], { encoding: 'utf8' });
}

function snapshot(root) {
  const files = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else files.push([path.relative(root, target), crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')]);
    }
  }
  walk(root);
  return files.sort(([a], [b]) => a.localeCompare(b));
}

test('generator refuses duplicate source identities without modifying closure inputs', () => {
  const f = fixture();
  try {
    f.put(phaseSourcePaths.find(p=>p.endsWith('/operations.yaml')), 'operations:\n  - id: media.operation.same\n  - id: media.operation.same\nindividualOperationContracts:\n  records: []\nownerDefinedOperationContracts:\n  records: []\nownerDefinedOperationProfiles:\n  profiles: []\nownerTypedObservationContracts:\n  records: []\nownerTypedObservationValidationRules:\n  records: []\nownerLeafWireContracts:\n  records: []\n  outputTypes:\n    records: []\n  mediaTypePolicies:\n    records: []\ncapabilityOperationContracts:\n  records: []\n  families: []\n  bounds: []\n  inputPayloadSchemas: []\n  outputPayloadSchemas: []\n  scalarTypeRecords: []\n');
    const before = snapshot(f.root);
    const result = run(f.root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Duplicate enumerated source identity/u);
    assert.deepEqual(snapshot(f.root), before);
  } finally { f.cleanup(); }
});

test('generator refuses omitted source collections before any output is written', () => {
  const f = fixture();
  try {
    f.put(phaseSourcePaths.find(p=>p.endsWith('/operations.yaml')), 'unrelated: []\n');
    const before = snapshot(f.root);
    const result = run(f.root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SOURCE_ENUMERATION_COLLECTION/u);
    assert.deepEqual(snapshot(f.root), before);
  } finally { f.cleanup(); }
});

test('singleton normative contracts have exact anchors and reject array or anonymous substitutions', () => {
  const f = fixture();
  try {
    assert.equal(run(f.root).status, 0);
    const obligations = JSON.parse(fs.readFileSync(path.join(f.root, 'config/closure/media-product-definition/obligations.json'), 'utf8'));
    const context = obligations.find(record => record.id.endsWith('fixture.host-context'));
    assert.equal(context.extensions['media-source'].sourceRef,
      '.product-experience/pdp-2-design-interface-system/agent-tools/conventions.yaml#/mediaOwnedToolDefinitionContracts/hostInvocationContext');
    assert.deepEqual(context.observerIds, []);
    assert.deepEqual(context.oracleIds, []);
    const source = '.product-experience/pdp-1-domain-data/interoperability.yaml';
    for (const [body, errorCode] of [['packageCompatibilityBoundary: []\n', 'SOURCE_ENUMERATION_COLLECTION'],
      ['packageCompatibilityBoundary:\n  meaning: no identity\n', 'SOURCE_ENUMERATION_ID']]) {
      f.put(source, body);
      const before = snapshot(f.root);
      const result = run(f.root);
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(errorCode), result.stderr);
      assert.deepEqual(snapshot(f.root), before);
    }
  } finally { f.cleanup(); }
});

test('check mode detects stale source fingerprints and output drift without writing', () => {
  const f = fixture();
  try {
    f.put(phaseSourcePaths[0], 'requirements:\n  - id: requirement.one\n');
    const generate = run(f.root);
    assert.equal(generate.status, 0, generate.stderr);
    const obligationPath = path.join(f.root, 'config/closure/media-product-definition/obligations.json');
    const obligations = JSON.parse(fs.readFileSync(obligationPath, 'utf8'));
    obligations[0].extensions['media-source'].sourceDigest = `sha256:${'0'.repeat(64)}`;
    fs.writeFileSync(obligationPath, `${JSON.stringify(obligations, null, 2)}\n`);
    const before = snapshot(f.root);
    const check = run(f.root, '--check');
    assert.notEqual(check.status, 0);
    assert.match(check.stderr, /Lifecycle source-input drift/u);
    assert.deepEqual(snapshot(f.root), before);
  } finally { f.cleanup(); }
});

test('source-owned nested wire schemas have their own obligations and exact parent anchors', () => {
  const f = fixture();
  try {
    const source = phaseSourcePaths.find(p => p.endsWith('/operations.yaml'));
    const original = fs.readFileSync(path.join(f.root, source), 'utf8');
    f.put(source, original.replace('ownerDefinedOperationContracts:\n  records: []',
      'ownerDefinedOperationContracts:\n  records:\n    - id: media.operation.fixture\n      ownerWireSchema:\n        id: media.operation-wire-schema.fixture\n        meaning: closed fixture request/result contract\n'));
    const generated = run(f.root);
    assert.equal(generated.status, 0, generated.stderr);
    const obligations = JSON.parse(fs.readFileSync(path.join(f.root, 'config/closure/media-product-definition/obligations.json'), 'utf8'));
    assert.equal(obligations.length, 7);
    const wire = obligations.find(r => r.id.endsWith('media.operation-wire-schema.fixture'));
    assert.ok(wire, 'the independently normative wire contract is not hidden in its parent operation');
    assert.match(JSON.stringify(wire), /ownerDefinedOperationContracts\/records\/media\.operation\.fixture\/ownerWireSchema/);
    assert.notEqual(wire.id, obligations.find(r => r !== wire).id);
  } finally { f.cleanup(); }
});

test('effective leaf wire, output type and modality policies enter the proof denominator without admission', () => {
  const f = fixture();
  try {
    const source = phaseSourcePaths.find(p => p.endsWith('/operations.yaml'));
    const original = fs.readFileSync(path.join(f.root, source), 'utf8');
    f.put(source, original.replace('ownerLeafWireContracts:\n  records: []\n  outputTypes:\n    records: []\n  mediaTypePolicies:\n    records: []',
      'ownerLeafWireContracts:\n  records:\n    - id: fixture.leaf-wire\n      meaning: exact effective request and result\n  outputTypes:\n    records:\n      - id: fixture.pass-output\n        meaning: typed produced versus estimated observation\n  mediaTypePolicies:\n    records:\n      - id: fixture.video-only\n        meaning: reject image input for a temporal video edit'));
    const generated = run(f.root);
    assert.equal(generated.status, 0, generated.stderr);
    const obligations = JSON.parse(fs.readFileSync(path.join(f.root, 'config/closure/media-product-definition/obligations.json'), 'utf8'));
    for (const [id, collection] of [['fixture.leaf-wire', 'records'], ['fixture.pass-output', 'outputTypes/records'], ['fixture.video-only', 'mediaTypePolicies/records']]) {
      const obligation = obligations.find(row => row.id.endsWith(id));
      assert.ok(obligation, `${id} remains in the normative source denominator`);
      assert.equal(obligation.extensions['media-source'].sourceRef, `${source}#/ownerLeafWireContracts/${collection}/${id}`);
      assert.deepEqual(obligation.caseIds, []);
      assert.deepEqual(obligation.observerIds, []);
      assert.deepEqual(obligation.oracleIds, []);
    }
  } finally { f.cleanup(); }
});

test('nested step definitions remain distinct obligations without inventing cases or acceptance', () => {
  const f = fixture();
  try {
    const source = phaseSourcePaths.find(p => p.endsWith('/step-definition-oracles.yaml'));
    f.put(source, 'journeys:\n  - journeyId: J-01\n    steps:\n      - id: J01-1\n        canonicalBindings:\n          semanticDefinitionId: media.step-semantic-definition.j01-1.v1\n      - id: J01-2\n        canonicalBindings:\n          semanticDefinitionId: media.step-semantic-definition.j01-2.v1\n');
    const generated = run(f.root);
    assert.equal(generated.status, 0, generated.stderr);
    const obligations = JSON.parse(fs.readFileSync(path.join(f.root, 'config/closure/media-product-definition/obligations.json'), 'utf8'));
    assert.equal(obligations.length, 7);
    const stepObligations = obligations.filter(obligation => obligation.extensions['media-source'].sourceRef.startsWith(`${source}#/journeys/`));
    assert.equal(stepObligations.length, 2);
    for (const [index, obligation] of stepObligations.entries()) {
      assert.equal(obligation.extensions['media-source'].sourceRef, `${source}#/journeys/0/steps/${index}/canonicalBindings`);
      assert.deepEqual(obligation.caseIds, []);
      assert.deepEqual(obligation.observerIds, []);
      assert.deepEqual(obligation.oracleIds, []);
    }
    f.put(source, 'journeys:\n  - journeyId: J-01\n    steps:\n      - id: J01-1\n');
    const before = snapshot(f.root);
    const missing = run(f.root);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /SOURCE_ENUMERATION_ID/);
    assert.deepEqual(snapshot(f.root), before);
  } finally { f.cleanup(); }
});
