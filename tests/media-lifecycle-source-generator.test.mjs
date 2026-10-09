import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { getMediaSourceEnumerationDescriptors } from '../scripts/lib/media-obligation-denominator-audit.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generator = path.join(repo, 'scripts/generate-media-lifecycle-source-inputs.mjs');
const { parse, stringify } = createRequire(path.resolve(repo, '../ghatana-tools/package.json'))('yaml');
const sourceEnumerationDescriptors = getMediaSourceEnumerationDescriptors();
const phaseSourcePaths = [...new Set(sourceEnumerationDescriptors.map(([, sourcePath]) => sourcePath))];
const singletonFixtureCount = sourceEnumerationDescriptors.filter((descriptor) => descriptor[7]).length;

function setFixtureCollection(document, collection, descriptor) {
  const segments = collection.split('.');
  let value = document;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === '*') {
      if (!Array.isArray(value)) throw new Error(`fixture descriptor wildcard is not an array: ${collection}`);
      if (value.length === 0) value.push({ id: `fixture.${collection.replaceAll('.', '-')}` });
      value = value[0];
      continue;
    }
    const final = index === segments.length - 1;
    if (final) {
      if (descriptor[7]) value[segment] ??= { [descriptor[5] ?? 'id']: `fixture.${collection.replaceAll('.', '-')}` };
      else value[segment] ??= [];
      continue;
    }
    const next = segments[index + 1];
    value[segment] ??= next === '*' ? [] : {};
    value = value[segment];
  }
}

function emptySourceFixture(relativePath) {
  const document = {};
  for (const descriptor of sourceEnumerationDescriptors.filter((row) => row[1] === relativePath)) {
    setFixtureCollection(document, descriptor[2], descriptor);
  }
  return document;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-lifecycle-generator-'));
  const put = (relativePath, content) => {
    const absolute = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  };
  for (const relativePath of phaseSourcePaths) put(relativePath, stringify(emptySourceFixture(relativePath)));
  const base = 'config/closure/media-product-definition';
  const json = (relativePath, value) => put(`${base}/${relativePath}`, `${JSON.stringify(value, null, 2)}\n`);
  json('obligations.json', []);
  json('phase-program.json', { phases: ['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3'].map((id) => ({ id, obligationIds: [] })) });
  json('phase-binding.json', { phases: Object.fromEntries(['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3'].map((id) => [id, { obligationIds: [] }])) });
  json('surface.json', { obligationIds: [] });
  json('l02-source-case-links.json', { candidateLinks: [], obligationIds: [], unmappedObligationIds: [] });
  json('l03-proof-route-candidates.json', { l02CaseLinkReview: {}, routes: [] });
  const readSource = (relativePath) => parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
  const writeSource = (relativePath, document) => put(relativePath, stringify(document));
  return { root, put, readSource, writeSource, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
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

function generatedObligationCount(f) {
  const result = run(f.root);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(fs.readFileSync(path.join(f.root, 'config/closure/media-product-definition/obligations.json'), 'utf8')).length;
}

test('generator refuses duplicate source identities without modifying closure inputs', () => {
  const f = fixture();
  try {
    const source = phaseSourcePaths.find((sourcePath) => sourcePath.endsWith('/operations.yaml'));
    const operations = f.readSource(source);
    operations.operations = [{ id: 'media.operation.same' }, { id: 'media.operation.same' }];
    f.writeSource(source, operations);
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
    const source = phaseSourcePaths.find((sourcePath) => sourcePath.endsWith('/operations.yaml'));
    const operations = f.readSource(source);
    delete operations.operations;
    f.writeSource(source, operations);
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
    const context = obligations.find(record => record.extensions['media-source'].sourceRef.endsWith('/agent-tools/conventions.yaml#/mediaOwnedToolDefinitionContracts/hostInvocationContext'));
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
    const source = phaseSourcePaths.find((sourcePath) => sourcePath.endsWith('/requirements.yaml'));
    f.put(source, 'requirements:\n  - id: requirement.one\n');
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
    const baselineCount = generatedObligationCount(f);
    const source = phaseSourcePaths.find(p => p.endsWith('/operations.yaml'));
    const document = f.readSource(source);
    document.ownerDefinedOperationContracts.records.push({
      id: 'media.operation.fixture',
      ownerWireSchema: { id: 'media.operation-wire-schema.fixture', meaning: 'closed fixture request/result contract' },
    });
    f.writeSource(source, document);
    const generated = run(f.root);
    assert.equal(generated.status, 0, generated.stderr);
    const obligations = JSON.parse(fs.readFileSync(path.join(f.root, 'config/closure/media-product-definition/obligations.json'), 'utf8'));
    assert.equal(obligations.length, baselineCount + 2);
    const wire = obligations.find(r => r.id.endsWith('media.operation-wire-schema.fixture'));
    assert.ok(wire, 'the independently normative wire contract is not hidden in its parent operation');
    assert.match(JSON.stringify(wire), /ownerDefinedOperationContracts\/records\/media\.operation\.fixture\/ownerWireSchema/);
    assert.notEqual(wire.id, obligations.find(r => r !== wire).id);
  } finally { f.cleanup(); }
});

test('effective leaf wire, output type and modality policies enter the proof denominator without admission', () => {
  const f = fixture();
  try {
    const baselineCount = generatedObligationCount(f);
    const source = phaseSourcePaths.find(p => p.endsWith('/operations.yaml'));
    const document = f.readSource(source);
    document.ownerLeafWireContracts.records.push({ id: 'fixture.leaf-wire', meaning: 'exact effective request and result' });
    document.ownerLeafWireContracts.outputTypes.records.push({ id: 'fixture.pass-output', meaning: 'typed produced versus estimated observation' });
    document.ownerLeafWireContracts.mediaTypePolicies.records.push({ id: 'fixture.video-only', meaning: 'reject image input for a temporal video edit' });
    f.writeSource(source, document);
    const generated = run(f.root);
    assert.equal(generated.status, 0, generated.stderr);
    const obligations = JSON.parse(fs.readFileSync(path.join(f.root, 'config/closure/media-product-definition/obligations.json'), 'utf8'));
    assert.equal(obligations.length, baselineCount + 3);
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
    const baselineCount = generatedObligationCount(f);
    const source = phaseSourcePaths.find(p => p.endsWith('/step-definition-oracles.yaml'));
    f.put(source, 'journeys:\n  - journeyId: J-01\n    steps:\n      - id: J01-1\n        canonicalBindings:\n          semanticDefinitionId: media.step-semantic-definition.j01-1.v1\n      - id: J01-2\n        canonicalBindings:\n          semanticDefinitionId: media.step-semantic-definition.j01-2.v1\n');
    const generated = run(f.root);
    assert.equal(generated.status, 0, generated.stderr);
    const obligations = JSON.parse(fs.readFileSync(path.join(f.root, 'config/closure/media-product-definition/obligations.json'), 'utf8'));
    assert.equal(obligations.length, baselineCount + 2);
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
