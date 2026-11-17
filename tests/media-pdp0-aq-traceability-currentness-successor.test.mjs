import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  PDP0_AUDIT_AQ_TRACEABILITY_PATH,
  validatePdp0AuditAqTraceability,
} from '../scripts/check-media-pdp0-audit-aq-traceability.mjs';
import {PDP0_AUDIT_DISPOSITION_CROSSWALK_PATH} from '../scripts/check-media-pdp0-501-audit-dispositions.mjs';

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('AQ traceability currentness successor is adopted against the current 501-row crosswalk', () => {
  const artifactBytes = fs.readFileSync(PDP0_AUDIT_AQ_TRACEABILITY_PATH);
  const crosswalkBytes = fs.readFileSync(PDP0_AUDIT_DISPOSITION_CROSSWALK_PATH);
  const artifact = JSON.parse(artifactBytes.toString('utf8'));
  const crosswalk = JSON.parse(crosswalkBytes.toString('utf8'));
  const result = validatePdp0AuditAqTraceability({artifact});

  assert.deepEqual(result.errors, []);
  assert.equal(result.stats.totalRows, 501);
  assert.equal(result.stats.rowsWithPdp0DefinitionJoin, 499);
  assert.equal(result.stats.unresolvedExactJoinRows, 0);
  assert.equal(result.stats.postPdpImplementationOnlyRows, 2);
  assert.equal(result.stats.capabilityLeaves, 462);
  assert.equal(result.stats.dispositionCrosswalkValid, true);
  assert.deepEqual(artifact.rows.map(row => row.auditId), crosswalk.rows.map(row => row.auditId));

  const v5 = 'docs/implementation/observations/media-pdp0-currentness-refresh-2026-10-24/pdp0-aq-capability-current-source-review-001-154.successor.candidate.v5.json';
  const v6 = v5.replace('.v5.json', '.v6.json');
  assert.equal(artifact.capabilityMappings.filter(row => row.currentSourceReviewRef === v5).length, 0);
  assert.equal(artifact.capabilityMappings.filter(row => row.currentSourceReviewRef === v6).length, 154);
  assert.equal(Object.hasOwn(artifact.sourceBaseline.inputs, v5), false);
  assert.equal(artifact.sourceBaseline.inputs[v6], sha256(fs.readFileSync(v6)));
  assert.equal(artifact.sourceBaseline.inputs['.product-experience/pdp-0-product-truth/capability-leaf-review.yaml'],
    sha256(fs.readFileSync('.product-experience/pdp-0-product-truth/capability-leaf-review.yaml')));
  assert.equal(artifact.sourceBaseline.inputs[PDP0_AUDIT_DISPOSITION_CROSSWALK_PATH], sha256(crosswalkBytes));
  assert.deepEqual(fs.readFileSync(PDP0_AUDIT_AQ_TRACEABILITY_PATH), artifactBytes);
  assert.deepEqual(fs.readFileSync(PDP0_AUDIT_DISPOSITION_CROSSWALK_PATH), crosswalkBytes);
});
