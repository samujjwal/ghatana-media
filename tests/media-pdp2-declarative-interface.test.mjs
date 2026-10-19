import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { declarativePdp2Paths, verifyPdp2DeclarativeInterface } from '../scripts/check-media-pdp2-declarative-interface.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = key => fs.readFileSync(path.join(root, declarativePdp2Paths[key]), 'utf8');

test('PDP-2 declarative interface preserves exact 61-case, four-surface, 52-edit source bindings', () => {
  const result = verifyPdp2DeclarativeInterface();
  assert.deepEqual(result.errors, [], result.errors.join('\n'));
  assert.deepEqual(result.stats, { p0Cases: 61, p1Bindings: 61, p2Bindings: 61, surfaceCount: 4, manualEditKinds: 52 });
});

test('PDP-2 rejects operation drift from the exact P1 case binding', () => {
  const source = read('p2');
  const changed = source.replace(
    'operationRef: media.operation.capability.media-animation-vector',
    'operationRef: media.operation.capability.media-animation-3d'
  );
  assert.notEqual(source, changed);
  const result = verifyPdp2DeclarativeInterface({ overrides: { p2: changed } });
  assert.ok(result.errors.some(error => error.includes('operation/source binding must resolve to the exact P1 case row')),
    result.errors.join('\n'));
});

test('PDP-2 cannot self-promote its authored source status to DEV_COMPLETE', () => {
  const source = read('p2');
  const changed = source.replace(
    'status: SOURCE_AUTHORED_PDP2_DEFINITION',
    'status: DEV_COMPLETE'
  );
  assert.notEqual(source, changed);
  const result = verifyPdp2DeclarativeInterface({ overrides: { p2: changed } });
  assert.ok(result.errors.some(error => error.includes('distinct from phase DEV_COMPLETE')), result.errors.join('\n'));
});

test('PDP-2 case presentation does not claim runtime or Explorer admission', () => {
  const source = read('p2');
  const changed = source.replace(
    'admission: SCREEN_REUSE_PROPOSAL_NOT_RUNTIME_OR_EXPLORER_EVIDENCE',
    'admission: RUNTIME_AND_EXPLORER_ADMITTED'
  );
  assert.notEqual(source, changed);
  const result = verifyPdp2DeclarativeInterface({ overrides: { p2: changed } });
  assert.ok(result.errors.some(error => error.includes('admission must remain a screen-reuse proposal')),
    result.errors.join('\n'));
});

test('PDP-2 keeps presentation negatives and unknown finality explicit', () => {
  const source = read('p2');
  const changed = source.replace('no-fake-execution-no-implied-model-validation', 'fake-execution-implied-model-validation');
  assert.notEqual(source, changed);
  const result = verifyPdp2DeclarativeInterface({ overrides: { p2: changed } });
  assert.ok(result.errors.some(error => error.includes('explicit positive, negative, unknown-finality')),
    result.errors.join('\n'));
});

test('PDP-2 refuses loss of the 61-case denominator and 52-kind manual parity', () => {
  const p2 = read('p2').replace('caseCount: 61', 'caseCount: 60');
  const recorderP2 = read('recorderP2').replace('canonicalOperationCount: 52', 'canonicalOperationCount: 51');
  assert.notEqual(p2, read('p2'));
  assert.notEqual(recorderP2, read('recorderP2'));
  const result = verifyPdp2DeclarativeInterface({ overrides: { p2, recorderP2 } });
  assert.ok(result.errors.some(error => error.includes('exact 61 canonical declarative cases')),
    result.errors.join('\n'));
  assert.ok(result.errors.some(error => error.includes('exact existing 52-kind Studio manual-operation parity')),
    result.errors.join('\n'));
});
