import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {validatePdp0AuditDispositions} from '../scripts/check-media-pdp0-501-audit-dispositions.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const crosswalkPath = 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json';
const parseYaml = createRequire(path.resolve(root, '../ghatana-tools/package.json'))('yaml').parse;
function workingCopy() {
  const ledger = JSON.parse(fs.readFileSync(path.join(root, crosswalkPath), 'utf8'));
  // Mutations test validation behavior against the exact present checkout. This does not write the ledger.
  for (const file of Object.keys(ledger.sourceBaseline.workingTreeSourceFingerprintsSha256)) {
    ledger.sourceBaseline.workingTreeSourceFingerprintsSha256[file] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
  }
  return ledger;
}
function errorsFor(ledger, stopAfterFirstError = true) { return validatePdp0AuditDispositions({crosswalk: ledger, stopAfterFirstError}).errors; }

test('all 428 original and 73 focused IDs round-trip to authoritative source text and acceptance', () => {
  const ledger = workingCopy();
  const audit = JSON.parse(fs.readFileSync(path.join(root, 'docs/implementation/references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json'), 'utf8'));
  const source = new Map([
    ...audit.originalAudit.inventory.map(row => [row.audit_id, {partition:'originalAudit', text:row.capability, acceptance:row.acceptance_family}]),
    ...audit.thirdPassAdditions.map(row => [row.audit_id, {partition:'focusedAudit', text:row.capability, acceptance:row.acceptance}]),
  ]);
  assert.equal(source.size, 501);
  assert.equal(ledger.rows.length, 501);
  for (const row of ledger.rows) {
    const sourceRow = source.get(row.auditId);
    assert.ok(sourceRow, `unexpected audit ID ${row.auditId}`);
    assert.equal(row.sourcePartition, sourceRow.partition, `${row.auditId} partition`);
    assert.equal(row.sourceText, sourceRow.text, `${row.auditId} source text`);
    assert.equal(row.sourceAcceptanceText, sourceRow.acceptance, `${row.auditId} acceptance text`);
  }
});


test('rights acceptance cases reject denied and revoked states for AC-03 through AC-05', () => {
  const requirements = parseYaml(fs.readFileSync(path.join(root, '.product-experience/pdp-0-product-truth/requirements.yaml'), 'utf8'));
  const rights = requirements.requirements.find(row => row.id === 'MEDIA-REQ-CAP-RIGHTS');
  const cases = new Map((rights?.acceptanceCases ?? []).map(row => [row.id, row]));
  for (const suffix of ['03', '04', '05']) {
    const clause = cases.get(`MEDIA-REQ-CAP-RIGHTS-AC-${suffix}`);
    assert.ok(clause, `missing rights AC-${suffix}`);
    assert.match(clause.then, /denied/i, `AC-${suffix} must cover DENIED`);
    assert.match(clause.then, /revoked/i, `AC-${suffix} must cover REVOKED`);
  }
});

test('AUD-SIM3-009 binds all five specialized models separately', () => {
  const row = JSON.parse(fs.readFileSync(path.join(root, crosswalkPath), 'utf8')).rows.find(item => item.auditId === 'AUD-SIM3-009');
  for (const model of ['cloth','soft-body','rope','particle','fluid']) {
    assert.ok(row?.pdp0EvidenceRefs?.includes(`.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.simulation.${model}`), `missing exact simulation model ${model}`);
  }
});

test('current crosswalk source pins and qualified scientific claim handoff validate without refreshing the ledger in memory', () => {
  const result = validatePdp0AuditDispositions();
  assert.deepEqual(result.errors, []);
  assert.equal(result.stats.total, 501);
  assert.equal(result.stats.dispositionCounts.BLOCKED_EXTERNAL_OWNER_DECISION, 0);
});

test('AUD-SIM3-010 fails if exact stochastic acceptance evidence is removed', () => {
  const ledger = workingCopy();
  const row = ledger.rows.find(item => item.auditId === 'AUD-SIM3-010');
  row.pdp0EvidenceRefs = row.pdp0EvidenceRefs.filter(ref => !ref.includes('MEDIA-DECL-P0-AC-034'));
  row.independentQcDispositionResolution.currentSourceEvidenceRefs = [...row.pdp0EvidenceRefs];
  assert.ok(errorsFor(ledger).some(error => /AUD-SIM3-010 must cite exact current AC-03 and AC-034/.test(error)));
});

test('missing and duplicate IDs fail the complete source denominator', () => {
  const missing = workingCopy();
  missing.rows.pop();
  assert.ok(errorsFor(missing).some(error => /missing crosswalk row|exactly 501 unique/.test(error)));
  const duplicate = workingCopy();
  duplicate.rows[1].auditId = duplicate.rows[0].auditId;
  assert.ok(errorsFor(duplicate).some(error => /duplicate crosswalk auditId/.test(error)));
});

test('changed source text fails exact source round-trip', () => {
  const ledger = workingCopy();
  ledger.rows[0].sourceText += ' (invented alias)';
  assert.ok(errorsFor(ledger).some(error => /sourceText does not round-trip exactly/.test(error)));
});

test('BOUND_EXISTING without exact P0 evidence fails', () => {
  const ledger = workingCopy();
  const row = ledger.rows.find(item => item.disposition === 'BOUND_EXISTING');
  row.pdp0EvidenceRefs = [];
  assert.ok(errorsFor(ledger).some(error => new RegExp(`${row.auditId}: BOUND_EXISTING requires at least one`).test(error)));
});

test('invented audit aliases fail identity and source anchor validation', () => {
  const ledger = workingCopy();
  ledger.rows[0].auditId = 'AUD-FOCUS-SPEC-001';
  assert.ok(errorsFor(ledger).some(error => /invented or unexpected audit ID/.test(error)));
});

test('stale source fingerprints fail closed', () => {
  const ledger = workingCopy();
  const first = Object.keys(ledger.sourceBaseline.workingTreeSourceFingerprintsSha256)[0];
  ledger.sourceBaseline.workingTreeSourceFingerprintsSha256[first] = '0'.repeat(64);
  assert.ok(errorsFor(ledger).some(error => /stale source fingerprint/.test(error)));
});

test('a later-phase handoff cannot substitute for a PDP-0 evidence binding', () => {
  const ledger = workingCopy();
  const row = ledger.rows.find(item => item.disposition === 'BOUND_EXISTING');
  const formerEvidence = row.pdp0EvidenceRefs[0];
  row.pdp0EvidenceRefs = [];
  row.laterPhaseHandoffs = [{phase:'PDP-1', evidenceRefs:[formerEvidence]}];
  const errors = errorsFor(ledger);
  assert.ok(errors.some(error => new RegExp(`${row.auditId}: BOUND_EXISTING requires at least one`).test(error)));
});
