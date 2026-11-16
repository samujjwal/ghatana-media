import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  buildMediaPdp0AuditAqTraceabilitySuccessor,
  DEFAULT_OUTPUT,
} from '../scripts/prepare-media-pdp0-aq-traceability-currentness-successor.mjs';
import {PDP0_AUDIT_AQ_TRACEABILITY_PATH} from '../scripts/check-media-pdp0-audit-aq-traceability.mjs';
import {PDP0_AUDIT_DISPOSITION_CROSSWALK_PATH} from '../scripts/check-media-pdp0-501-audit-dispositions.mjs';

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('AQ traceability v6 successor changes only 154 current-source refs and leaf/v6 pins', () => {
  const artifactBytes = fs.readFileSync(PDP0_AUDIT_AQ_TRACEABILITY_PATH);
  const crosswalkBytes = fs.readFileSync(PDP0_AUDIT_DISPOSITION_CROSSWALK_PATH);
  const predecessor = JSON.parse(artifactBytes.toString('utf8'));
  const result = buildMediaPdp0AuditAqTraceabilitySuccessor();
  const candidate = result.candidate;
  const savedCandidate = JSON.parse(fs.readFileSync(DEFAULT_OUTPUT, 'utf8'));

  assert.equal(result.preimageSha256, sha256(artifactBytes));
  assert.deepEqual(savedCandidate, candidate);
  assert.equal(result.candidateSha256, sha256(fs.readFileSync(DEFAULT_OUTPUT)));
  assert.equal(result.validation.traceabilityRows, 501);
  assert.equal(result.validation.canonicalCapabilityLeaves, 462);
  assert.equal(result.validation.crosswalkRows, 501);
  assert.equal(result.validation.boundExisting, 499);
  assert.equal(result.validation.postPdpImplementationOnly, 2);
  assert.equal(result.validation.errors, 0);
  assert.equal(result.changedCapabilityRefs.length, 154);
  assert.deepEqual(candidate.rows, predecessor.rows);
  assert.deepEqual(candidate.clusters, predecessor.clusters);
  assert.deepEqual(candidate.definitionExtensions, predecessor.definitionExtensions);

  const v5 = 'docs/implementation/observations/media-pdp0-currentness-refresh-2026-10-24/pdp0-aq-capability-current-source-review-001-154.successor.candidate.v5.json';
  const v6 = v5.replace('.v5.json', '.v6.json');
  for (let i = 0; i < predecessor.capabilityMappings.length; i++) {
    const before = predecessor.capabilityMappings[i];
    const after = candidate.capabilityMappings[i];
    if (before.currentSourceReviewRef === v5) assert.equal(after.currentSourceReviewRef, v6);
    else assert.equal(after.currentSourceReviewRef, before.currentSourceReviewRef);
    const beforeRest = {...before}; delete beforeRest.currentSourceReviewRef;
    const afterRest = {...after}; delete afterRest.currentSourceReviewRef;
    assert.deepEqual(afterRest, beforeRest);
  }
  assert.equal(Object.hasOwn(candidate.sourceBaseline.inputs, v5), false);
  assert.equal(candidate.sourceBaseline.inputs[v6], sha256(fs.readFileSync(v6)));
  assert.equal(candidate.sourceBaseline.inputs['.product-experience/pdp-0-product-truth/capability-leaf-review.yaml'],
    sha256(fs.readFileSync('.product-experience/pdp-0-product-truth/capability-leaf-review.yaml')));
  assert.deepEqual(fs.readFileSync(PDP0_AUDIT_AQ_TRACEABILITY_PATH), artifactBytes);
  assert.deepEqual(fs.readFileSync(PDP0_AUDIT_DISPOSITION_CROSSWALK_PATH), crosswalkBytes);
});
