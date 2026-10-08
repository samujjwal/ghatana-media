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
  '.product-experience/pdp-1-domain-data/states.yaml',
  '.product-experience/pdp-1-domain-data/transitions.yaml',
  '.product-experience/pdp-1-domain-data/domain-objects.yaml',
  '.product-experience/pdp-1-domain-data/operations.yaml',
  '.product-experience/pdp-1-domain-data/relationships.yaml',
  '.product-experience/pdp-1-domain-data/value-objects.yaml',
  '.product-experience/pdp-2-design-interface-system/component-contracts.yaml',
  '.product-experience/pdp-2-design-interface-system/gui/layout.yaml',
  '.product-experience/pdp-2-design-interface-system/gui/patterns/catalog.yaml',
  '.product-experience/pdp-2-design-interface-system/gui/templates/catalog.yaml',
  '.product-experience/pdp-2-design-interface-system/media-token-aliases.yaml',
  '.product-experience/pdp-3-product-experience/journey-registry.yaml',
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
      'requirements.yaml': 'requirements', 'states.yaml': 'stateMachines',
      'transitions.yaml': 'transitionRecords', 'domain-objects.yaml': 'objects',
      'operations.yaml': 'operations', 'relationships.yaml': 'relationships',
      'value-objects.yaml': 'values', 'component-contracts.yaml': 'components',
      'layout.yaml': 'layouts', 'catalog.yaml': relativePath.includes('/patterns/') ? 'patterns' : relativePath.includes('/templates/') ? 'templates' : 'journeys',
      'media-token-aliases.yaml': 'aliases', 'journey-registry.yaml': 'journeys',
      'screen-registry.yaml': 'screens',
    };
    const collection = collections[path.basename(relativePath)];
    const extra = relativePath.endsWith('screen-registry.yaml') ? '\nlaneViews: []\n'
      : relativePath.endsWith('operations.yaml') ? '\nindividualOperationContracts:\n  records: []\n' : '';
    put(relativePath, `${collection}: []${extra}`);
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
    f.put(phaseSourcePaths[4], 'operations:\n  - id: media.operation.same\n  - id: media.operation.same\nindividualOperationContracts:\n  records: []\n');
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
    f.put(phaseSourcePaths[4], 'unrelated: []\n');
    const before = snapshot(f.root);
    const result = run(f.root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SOURCE_ENUMERATION_COLLECTION/u);
    assert.deepEqual(snapshot(f.root), before);
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
