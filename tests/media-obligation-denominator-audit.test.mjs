import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { auditMediaObligationDenominator } from '../scripts/lib/media-obligation-denominator-audit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireTools = createRequire(path.resolve(root, '../ghatana-tools/package.json'));
const { parse } = requireTools('yaml');
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const input = () => ({
  root,
  obligations: readJson('config/closure/media-product-definition/obligations.json'),
  program: readJson('config/closure/media-product-definition/phase-program.json'),
  binding: readJson('config/closure/media-product-definition/phase-binding.json'),
  surface: readJson('config/closure/media-product-definition/surface.json'),
  traceability: parse(fs.readFileSync(path.join(root, '.product-experience/traceability.yaml'), 'utf8')),
  parseYaml: parse,
});

test('audits exact 318 obligation denominator, four phase counts, memberships, and resolvable source records', () => {
  const report = auditMediaObligationDenominator(input());
  assert.equal(report.total, 318);
  assert.equal(report.uniqueIds, 318);
  assert.deepEqual(report.phaseCounts, { 'PDP-0': 38, 'PDP-1': 130, 'PDP-2': 73, 'PDP-3': 77 });
  assert.equal(report.dispositionRecords, 318);
  assert.deepEqual(report.sourceReferences, { total: 318, resolved: 318, unresolved: 0 });
  assert.ok(Object.keys(report.sourceFingerprints.files).length > 0);
  assert.deepEqual(report.sourceFingerprints.comparison, { present: 318, matching: 318, stale: 0, absent: 0 });
  assert.equal(report.authoritativeObserverAssignments, 0);
  assert.equal(report.authoritativeOracleAssignments, 0);
  assert.equal(report.status, 'DENOMINATOR_AND_MEMBERSHIP_CHECKED_SOURCE_SEMANTIC_ACCEPTANCE_PENDING');
  assert.deepEqual(report.issues, []);
});

test('flags duplicate IDs, phase contradictions, and duplicate or missing selected membership', () => {
  const data = input();
  data.obligations[0].phaseSemantics.applicableIn = ['PDP-1'];
  data.obligations[1].id = data.obligations[0].id;
  data.program.phases[0].obligationIds.pop();
  data.program.phases[0].obligationIds.push(data.obligations[0].id, data.obligations[0].id);
  const report = auditMediaObligationDenominator(data);
  const codes = new Set(report.issues.map((issue) => issue.code));
  assert.ok(codes.has('DUPLICATE_ID'));
  assert.ok(codes.has('CONTRADICTORY_PHASE'));
  assert.ok(codes.has('DUPLICATE_SELECTION'));
  assert.ok(codes.has('MISSING_SELECTION'));
});

test('flags unresolved source references and stale expected fingerprints', () => {
  const data = input();
  data.obligations[0].extensions['media-source'].sourceRef = '.product-experience/missing.yaml#/requirements/missing';
  data.obligations[1].extensions['media-source'].sourceDigest = `sha256:${'0'.repeat(64)}`;
  const report = auditMediaObligationDenominator(data);
  const codes = new Set(report.issues.map((issue) => issue.code));
  assert.ok(codes.has('UNRESOLVED_SOURCE'));
  assert.ok(codes.has('STALE_SOURCE_FINGERPRINT'));
});

test('flags a missing persisted source digest', () => {
  const data = input();
  delete data.obligations[0].extensions['media-source'].sourceDigest;
  const report = auditMediaObligationDenominator(data);
  assert.deepEqual(report.sourceFingerprints.comparison, { present: 317, matching: 317, stale: 0, absent: 1 });
  assert.ok(report.issues.some((issue) => issue.code === 'MISSING_SOURCE_FINGERPRINT'));
});
