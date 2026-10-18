import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDeclarativeProductionDefinitions } from '../scripts/check-media-declarative-production-definitions.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const files = {
  p0: '.product-experience/pdp-0-product-truth/requirements.yaml',
  p1: '.product-experience/pdp-1-domain-data/declarative-production-contracts.yaml',
  p2: '.product-experience/pdp-2-design-interface-system/animation-simulation-grammar.yaml',
  p3: '.product-experience/pdp-3-product-experience/declarative-production-experience.yaml',
};

test('all PDP-0, PDP-1, and PDP-2 declarative production source contracts reconcile without synthetic runtime claims', () => {
  const result = verifyDeclarativeProductionDefinitions();
  assert.deepEqual(result.errors, [], result.errors.join('\n'));
  assert.equal(result.stats.recorderCases, 84);
  assert.equal(result.stats.declarativeCases, 61);
  assert.equal(result.stats.p1Bindings, 61);
  assert.equal(result.stats.p2Bindings, 61);
  assert.equal(result.stats.p3Bindings, 61);
  assert.equal(result.stats.valueTypes, 10);
  assert.equal(result.stats.recorderManualEdits, 52);
  assert.equal(result.stats.originClasses, 5);
});

test('reject removed or duplicated canonical PDP-0 case even when parent family unchanged', () => {
  const source = read(files.p0);
  const broken = source.replace('    - id: MEDIA-DECL-P0-AC-061', '    - id: MEDIA-DECL-P0-AC-060');
  assert.notEqual(source, broken);
  const result = verifyDeclarativeProductionDefinitions({ overrides: { p0: broken } });
  assert.ok(result.errors.some(e => /PDP-0: exact 61 canonical/.test(e)), result.errors.join('\n'));
});

test('reject missing PDP-1 canonical operation while preserving source case counts', () => {
  const source = read(files.p1);
  const broken = source.replace(
    'canonicalOperationRef: media.operation.capability.media-animation-vector',
    'canonicalOperationRef: media.operation.capability.media-does-not-exist'
  );
  assert.notEqual(source, broken);
  const result = verifyDeclarativeProductionDefinitions({ overrides: { p1: broken } });
  assert.ok(result.errors.some(e => /missing or mismatched canonical PDP-1 operation/.test(e)), result.errors.join('\n'));
});

test('reject a PDP-2 drift from exact operation/capability source binding', () => {
  const source = read(files.p2);
  const broken = source.replace(
    'operationRef: media.operation.capability.media-animation-vector',
    'operationRef: media.operation.capability.media-animation-3d'
  );
  assert.notEqual(source, broken);
  const result = verifyDeclarativeProductionDefinitions({ overrides: { p2: broken } });
  assert.ok(result.errors.some(e => /missing or mismatched canonical PDP-1 operation/.test(e)), result.errors.join('\n'));
});

test('reject a P2 duplicate YAML mapping even if all 61 source bindings remain', () => {
  const source = read(files.p2);
  const broken = source.replace('  caseCount: 61', '  caseCount: 61\n  caseCount: 61');
  assert.notEqual(source, broken);
  const result = verifyDeclarativeProductionDefinitions({ overrides: { p2: broken } });
  assert.ok(result.errors.some(e => /duplicate-key/.test(e)), result.errors.join('\n'));
});

test('reject invalid Newton law reference oracle rather than making the animation plausible', () => {
  const source = read(files.p1);
  const broken = source.replace('testInputs: {massKg: 2', 'testInputs: {massKg: 0');
  assert.notEqual(source, broken);
  const result = verifyDeclarativeProductionDefinitions({ overrides: { p1: broken } });
  assert.ok(result.errors.some(e => /analytical force-and-motion oracle inconsistent/.test(e)), result.errors.join('\n'));
});

test('reject conversion of educational model time into editorial story time', () => {
  const source = read(files.p2);
  const broken = source.replace(
    'Pausing or seeking tStory never mutates tSim',
    'Pausing or seeking story-time advances physics'
  );
  assert.notEqual(source, broken);
  const result = verifyDeclarativeProductionDefinitions({ overrides: { p2: broken } });
  assert.ok(result.errors.some(e => /simulation time and model\/visual authority/.test(e)), result.errors.join('\n'));
});

test('refuse premature phase DEV_COMPLETE status from an unexecuted source proposal', () => {
  const source = read(files.p1);
  const broken = source.replace('status: SOURCE_AUTHORED_PENDING_NATIVE_VALIDATION_AND_CURRENTNESS', 'status: DEV_COMPLETE');
  assert.notEqual(source, broken);
  const result = verifyDeclarativeProductionDefinitions({ overrides: { p1: broken } });
  assert.ok(result.errors.some(e => /cannot self-declare current-source DEV_COMPLETE/.test(e)), result.errors.join('\n'));
});

test('reject a PDP-3 journey/operation drift even with all 61 successor cases present', () => {
  const source = read(files.p3);
  const broken = source.replace(
    'pdp1OperationRef: media.operation.capability.media-animation-vector',
    'pdp1OperationRef: media.operation.capability.media-animation-3d'
  );
  assert.notEqual(source, broken);
  const result = verifyDeclarativeProductionDefinitions({ overrides: { p3: broken } });
  assert.ok(result.errors.some(e => /PDP-3 successor lacks exact P0\/1\/2/.test(e)), result.errors.join('\n'));
});
