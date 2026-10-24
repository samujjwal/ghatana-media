import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {
  PDP0_AUDIT_DISPOSITION_CROSSWALK_PATH,
  validatePdp0AuditDispositions,
} from '../scripts/check-media-pdp0-501-audit-dispositions.mjs';
import {buildPdp0AuditCrosswalkCurrentnessCandidate as buildCandidate} from '../scripts/prepare-media-pdp0-audit-crosswalk-currentness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = ref => JSON.parse(fs.readFileSync(path.join(root, ref), 'utf8'));

test('currentness candidate preserves 501 rows and records PXD-226 as decision provenance, not P0 evidence', () => {
  const result = buildCandidate();
  const row = result.candidate.rows.find(item => item.auditId === 'AUD-SPEC-002');
  assert.equal(result.validation.total, 501);
  assert.equal(result.validation.original, 428);
  assert.equal(result.validation.focused, 73);
  assert.equal(row.pdp0EvidenceRefs.includes('.product-experience/decision-log.md#PXD-226'), false);
  assert.equal(row.decisionRef.id, 'PXD-226');
  assert.equal(row.decisionRef.sourceOwnerDisposition, 'APPROVE_EXACT_CANDIDATE_FOR_SOURCE_APPLY');
  assert.equal(row.decisionRef.ownerApproval, 'NOT_CLAIMED');
  assert.equal(row.pdp0EvidenceRefs.every(ref => ref.startsWith('.product-experience/pdp-0-product-truth/')), true);
  const onlyAuthorizedStaleFiles = [
    '.product-experience/pdp-0-product-truth/campaign-extensions.yaml',
    '.product-experience/pdp-0-product-truth/capabilities.yaml',
    '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml',
    '.product-experience/pdp-0-product-truth/quality-policy.yaml',
    '.product-experience/pdp-0-product-truth/requirements.yaml',
  ];
  assert.ok(result.directStaleFiles.length === 0
    || JSON.stringify(result.directStaleFiles) === JSON.stringify(onlyAuthorizedStaleFiles));
});

test('stale or unclassified PXD-226 evidence fails the native audit validator', () => {
  const result = buildCandidate();
  const row = result.candidate.rows.find(item => item.auditId === 'AUD-SPEC-002');
  row.pdp0EvidenceRefs.push('.product-experience/decision-log.md#PXD-226');
  const validation = validatePdp0AuditDispositions({repositoryRoot: root, crosswalk: result.candidate});
  assert.ok(validation.errors.some(error => error.includes('PDP-0 evidence reference is not a PDP-0 source')));
  assert.ok(validation.errors.some(error => error.includes('referenced source is not fingerprinted: .product-experience/decision-log.md')));
});

test('candidate generation does not mutate canonical crosswalk input', () => {
  const before = fs.readFileSync(path.join(root, PDP0_AUDIT_DISPOSITION_CROSSWALK_PATH));
  const result = buildCandidate();
  const after = fs.readFileSync(path.join(root, PDP0_AUDIT_DISPOSITION_CROSSWALK_PATH));
  assert.deepEqual(after, before);
  const canonical = JSON.parse(after.toString('utf8'));
  assert.deepEqual(result.candidate, canonical, 'the currentness producer is idempotent on a current source cut');
});
