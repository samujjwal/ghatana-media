import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {prepareCohort03SourceAmendmentPeer} from '../scripts/review-media-pdp0-cohort03-source-amendment.mjs';
import {buildCohort03SourceAmendmentPeer, validateCohort03SourceAmendmentPeer, cohort03SourceAmendmentPeerSchema} from '../scripts/lib/media-pdp0-cohort03-source-amendment-peer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const read = ref => fs.readFileSync(path.join(root, ref));
const prepared = prepareCohort03SourceAmendmentPeer();
const record = prepared.record;
const Ajv2020 = createRequire(path.resolve(root, '../ghatana-tools/package.json'))('ajv/dist/2020');

test('cohort 03 peer review covers exact 20 R2 missing-definition rows and current source pins', () => {
  assert.equal(validateCohort03SourceAmendmentPeer(record), true);
  assert.deepEqual(record.auditFindings.technicalDispositionCounts, {TECHNICAL_PASS: 19, REQUEST_CHANGES: 1, UNKNOWN: 0});
  assert.deepEqual(record.rows.map(row => row.auditId), record.sourceBaseline.actualR2MissingDefinitionIds);
  assert.equal(record.sourceBaseline.liveSourceMismatches.length, 0);
  assert.equal(record.rows.find(row => row.auditId === 'AUD-TRUST-014').technicalDisposition, 'REQUEST_CHANGES');
  assert.equal(record.rows.find(row => row.auditId === 'AUD-TTS-002').technicalDisposition, 'TECHNICAL_PASS');
  assert.equal(record.rows.find(row => row.auditId === 'AUD-TTS-010').technicalDisposition, 'TECHNICAL_PASS');
  assert.deepEqual(record.excludedFromThisVerdict.auditIds, ['AUD-SPEC-002']);
});

test('cohort 03 source amendment peer output validates against its strict schema', () => {
  const schema = cohort03SourceAmendmentPeerSchema();
  const validate = new Ajv2020({strict: true}).compile(schema);
  assert.equal(validate(record), true, JSON.stringify(validate.errors));
  assert.equal(validate({...record, canonicalOwnerDisposition: 'OWNER_APPROVED'}), false);
  assert.equal(validate({...record, rows: record.rows.slice(1)}), false);
  assert.equal(validate({...record, unexpected: true}), false);
});

test('peer validator rejects duplicated/missing rows, promotion claims, and altered disposition counts', () => {
  assert.throws(() => validateCohort03SourceAmendmentPeer({...record, rows: [...record.rows, record.rows[0]]}), /denominator|membership/u);
  const duplicated = {...record, rows: record.rows.map((row, index) => index === 1 ? {...row, auditId: record.rows[0].auditId} : row)};
  assert.throws(() => validateCohort03SourceAmendmentPeer(duplicated), /membership/u);
  const promotion = {...record, rows: record.rows.map((row, index) => index === 0 ? {...row, canonicalOwnerDisposition: 'DEV_COMPLETE'} : row)};
  assert.throws(() => validateCohort03SourceAmendmentPeer(promotion), /cannot promote owner state/u);
  const falseCount = {...record, auditFindings: {...record.auditFindings, technicalDispositionCounts: {...record.auditFindings.technicalDispositionCounts, TECHNICAL_PASS: 20}}};
  assert.throws(() => validateCohort03SourceAmendmentPeer(falseCount), /counts differ/u);
});

test('builder refuses stale sources and unsupported assignment membership before review output', () => {
  const proposalBytes = read(`${folder}/cohort-03-source-amendment-proposals.r1.json`);
  const cohortBytes = read(`${folder}/cohort-03.r2.json`);
  const cohortPeerBytes = read(`${folder}/cohort-03.r2.independent-peer.json`);
  const cohort01Bytes = read(`${folder}/cohort-01.r2.json`);
  const cohort01PeerBytes = read(`${folder}/cohort-01.independent-peer.json`);
  const residualBytes = read('docs/implementation/observations/media-pdp0-p0-07-parent-case-residual-classification-2026-10-23.json');
  const auditBytes = read('docs/implementation/references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json');
  const capabilityBytes = read('.product-experience/pdp-0-product-truth/capabilities.yaml');
  const requirementBytes = read('.product-experience/pdp-0-product-truth/requirements.yaml');
  const authorityMapBytes = read('.product-experience/authority-map.yaml');
  const phaseStatusBytes = read('docs/implementation/pdp-0-phase-dev-status.json');
  const assignmentBytes = fs.readFileSync('/Users/samujjwal/Development/ghatana-lifecycle/docs/engineering/reviews/gtool-critical-2026-10-23/media-pdp0-resolution-cohort-assignments.json');
  const args = {proposalBytes, cohortBytes, cohortPeerBytes, cohort01Bytes, cohort01PeerBytes, residualBytes, auditBytes, capabilityBytes, requirementBytes, authorityMapBytes, phaseStatusBytes, assignmentBytes};
  assert.throws(() => buildCohort03SourceAmendmentPeer({...args, capabilityBytes: Buffer.from('stale')}), /source baseline mismatch/u);
  const badAssignment = Buffer.from(assignmentBytes.toString('utf8').replace('AUD-MUSIC-010', 'AUD-ZZZ-999'));
  assert.throws(() => buildCohort03SourceAmendmentPeer({...args, assignmentBytes: badAssignment}), /assignment fingerprint is stale/u);
});
