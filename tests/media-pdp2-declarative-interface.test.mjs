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
  assert.deepEqual(result.stats, {
    p0Cases: 61, p1Bindings: 61, p2Bindings: 61, surfaceCount: 4, manualEditKinds: 52,
    sourceAuditRows: 501, sourceAuditRouteFamilies: 13, sourceAuditTaskRows: 86,
  });
});

test('PDP-2 source audit review preserves all 501 exact source IDs', () => {
  const source = JSON.parse(read('sourceAuditReview'));
  source.sourceAuditRows.pop();
  const result = verifyPdp2DeclarativeInterface({ overrides: { sourceAuditReview: JSON.stringify(source) } });
  assert.ok(result.errors.some(error => error.includes('exact ordered 428 + 73 = 501 source IDs')),
    result.errors.join('\n'));
});

test('PDP-2 source audit routes cannot create a new Studio workspace', () => {
  const source = JSON.parse(read('sourceAuditReview'));
  source.routeFamilies[0].workspaces.push('new-recorder-dashboard');
  const result = verifyPdp2DeclarativeInterface({ overrides: { sourceAuditReview: JSON.stringify(source) } });
  assert.ok(result.errors.some(error => error.includes('outside the existing 13 Studio workspaces')),
    result.errors.join('\n'));
});

test('PDP-2 source audit task review preserves all 86 original IDs and classifications', () => {
  const source = JSON.parse(read('sourceAuditReview'));
  source.sourceTaskInventory.rows[0].stageClassification = ['DELIVERY'];
  const result = verifyPdp2DeclarativeInterface({ overrides: { sourceAuditReview: JSON.stringify(source) } });
  assert.ok(result.errors.some(error => error.includes('all 86 exact task/experiment IDs')),
    result.errors.join('\n'));
});

test('PDP-2 preserves current project and mixer routes beside narrowly deferred capability scopes', () => {
  const source = JSON.parse(read('sourceAuditReview'));
  const scenePatchMerge = source.sourceAuditRows.find(row => row.sourceAuditId === 'AUD-SPEC-015');
  scenePatchMerge.reviewDisposition = 'PDP0_FUTURE_VERSION_SUBSCOPE; SHOW_UNAVAILABLE_IF_REQUESTED';
  const result = verifyPdp2DeclarativeInterface({ overrides: { sourceAuditReview: JSON.stringify(source) } });
  assert.ok(result.errors.some(error => error.includes('AUD-SPEC-015: PDP-2 review disposition disagrees with exact case and scope evidence')),
    result.errors.join('\n'));

  const valid = JSON.parse(read('sourceAuditReview'));
  valid.sourceAuditRows.find(row => row.sourceAuditId === 'AUD-DSP-003').currentPdp2Bindings.pop();
  const missingCurrentRoute = verifyPdp2DeclarativeInterface({ overrides: { sourceAuditReview: JSON.stringify(valid) } });
  assert.ok(missingCurrentRoute.errors.some(error => error.includes('AUD-DSP-003: mixed current and deferred PDP-0 scope must preserve')),
    missingCurrentRoute.errors.join('\n'));
});

test('PDP-2 M-02/INV-03 split route grammar from PDP-3 action flows and Build testing', () => {
  const source = JSON.parse(read('sourceAuditReview'));
  const m02 = source.sourceTaskInventory.rows.find(row => row.sourceTaskId === 'M-02');
  m02.p2Disposition = 'PDP2_PORTION_REUSES_CURRENT_ROUTES; PDP3_PORTION_REMAINS_SEPARATE';
  const result = verifyPdp2DeclarativeInterface({ overrides: { sourceAuditReview: JSON.stringify(source) } });
  assert.ok(result.errors.some(error => error.includes('scope M-02/INV-03 definitions separately from PDP-3 flow binding and Build verification')),
    result.errors.join('\n'));
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
