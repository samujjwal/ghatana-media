import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const dir = 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const file = (name) => path.join(root, dir, name);
const read = (name) => fs.readFileSync(file(name), 'utf8');
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const r03cap = 'media-pdp0-root-selected-source-integration-r9-r03.split.capabilities.postimage.yaml';
const r03req = 'media-pdp0-root-selected-source-integration-r9-r03.split.requirements.postimage.yaml';

function caseBlock(doc, caseId) {
  const marker = `      - id: ${caseId}\n`;
  const start = doc.indexOf(marker);
  assert.notEqual(start, -1, `case exists: ${caseId}`);
  const next = doc.indexOf('\n      - id: ', start + marker.length);
  return doc.slice(start, next < 0 ? doc.length : next + 1);
}
function field(doc, caseId, name) {
  const match = caseBlock(doc, caseId).match(new RegExp(`^        ${name}: (.*)$`, 'm'));
  assert.ok(match, `${name} exists in ${caseId}`);
  return match[1];
}
function linkedParents(doc, leafId) {
  return doc.split(/(?=^      - id: )/m).filter((block) => block.includes(`sourceCapabilityCaseId: ${leafId}`)).map((block) => block.match(/^      - id: ([^\n]+)/m)?.[1]).filter(Boolean);
}

test('R9-R03 replays byte-for-byte from the frozen R9-R02 predecessor', () => {
  const replay = spawnSync(process.execPath, ['scripts/prepare-media-pdp0-root-selected-source-integration-r9-r03-candidate.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(replay.status, 0, replay.stderr || replay.stdout);
  assert.match(replay.stdout, /R9_R03_DETERMINISTIC_REPLAY_PASS/);
  assert.equal(sha(read('media-pdp0-root-selected-source-integration-r9-r02.split.capabilities.postimage.yaml')), '59746d493ab1bd0ebee93e3b1b7efd594689cb5cfa42abf222c04a863988a133');
  assert.equal(sha(read('media-pdp0-root-selected-source-integration-r9-r02.split.requirements.postimage.yaml')), '80c54dd68c30199feeaf84e7e6550ffb52ae5a0f082a5f0c9b65b7d1c7783fe2');
});

test('all nine H invocation findings are repaired with linked parent parity and conserved IDs', () => {
  const audits = ['AUD-DELIV-019','AUD-DUB-015','AUD-EDIT-016','AUD-EDIT-024','AUD-GEN-010','AUD-GEN-020','AUD-GEN-021','AUD-GEN-023','AUD-GEN-024'];
  const cap = read(r03cap);
  const req = read(r03req);
  for (const audit of audits) {
    const leaves = [`MEDIA-P0-COHORT02-${audit}-LEAF-POS`, `MEDIA-P0-COHORT02-${audit}-LEAF-NEG`];
    for (const leafId of leaves) {
      const leaf = caseBlock(cap, leafId);
      assert.doesNotMatch(field(cap, leafId, 'when'), /\.([a-z0-9-]+\.)?\1\./);
      const leafWhen = field(cap, leafId, 'when');
      const parents = linkedParents(req, leafId);
      assert.ok(parents.length, `linked requirement parent exists for ${leafId}`);
      for (const parentId of parents) {
        assert.equal(field(req, parentId, 'when'), leafWhen, `when parity for ${leafId}/${parentId}`);
        assert.equal(field(req, parentId, 'polarity'), field(cap, leafId, 'polarity'), `polarity parity for ${leafId}/${parentId}`);
        assert.equal(field(req, parentId, 'sourceCapabilityCaseId'), leafId);
      }
      assert.ok(leaf.includes(`sourceAuditId: ${audit}`));
    }
  }
  assert.equal((cap.match(/      - id: MEDIA-P0-COHORT02-/g) ?? []).length, 18);
  assert.equal((req.match(/      - id: MEDIA-P0-COHORT02-/g) ?? []).length, 20);
});

test('AUD-GEN-024 observes independent evidence, policy, provider and placement axes and retains UNKNOWN', () => {
  const cap = read(r03cap);
  const req = read(r03req);
  const capStart = cap.indexOf('  - id: media.capability.provider-class-separation\n');
  const capEnd = cap.indexOf('\n  - id: media.agent.', capStart + 1);
  const feature = cap.slice(capStart, capEnd);
  for (const token of ['licenseRightsEvidence:', 'contentDigest:', 'policyDecision:', 'providerBinding:', 'providerId:', 'bindingId:', 'executionPlacement: LOCAL or HOSTED', 'axesIndependent: true', 'mutualExclusivity: false']) assert.ok(feature.includes(token), token);
  for (const caseId of ['MEDIA-P0-COHORT02-AUD-GEN-024-LEAF-POS','MEDIA-P0-COHORT02-AUD-GEN-024-MEDIA-REQ-CAP-CAPABILITY-POS']) {
    const source = caseId.includes('-LEAF-') ? cap : req;
    assert.match(field(source, caseId, 'given'), /policyDecision:"PERMITTED".*execution-placement=HOSTED/);
    assert.match(field(source, caseId, 'then'), /evidenceId=evidence-example-01.*providerId=provider-example-01.*executionPlacement=HOSTED/);
  }
  for (const caseId of ['MEDIA-P0-COHORT02-AUD-GEN-024-LEAF-NEG','MEDIA-P0-COHORT02-AUD-GEN-024-MEDIA-REQ-CAP-CAPABILITY-NEG']) {
    const source = caseId.includes('-LEAF-') ? cap : req;
    assert.match(field(source, caseId, 'then'), /UNKNOWN/);
    assert.match(field(source, caseId, 'given'), /Missing, stale, or ambiguous provider-class evidence returns UNKNOWN/);
  }
});

test('R9-R03 retains aggregate denominator and makes no source/status effect', () => {
  const freeze = JSON.parse(read('media-pdp0-root-selected-source-integration-r9-r03.freeze.v1.json'));
  const bundle = JSON.parse(read('media-pdp0-root-selected-source-integration-r9-r03.successor-bundle.candidate.v1.json'));
  assert.equal(freeze.historicalOwnerRowsPreserved, 462);
  assert.equal(freeze.phaseStatusEffect, 'NONE');
  assert.equal(freeze.canonicalApply, 'NONE');
  assert.equal(bundle.retainedProjection.operationCount, 248);
  assert.equal(bundle.selectedAllowedOperations.operationCount, 122);
  assert.equal(bundle.historicalOwnerRowsPreserved, 462);
  assert.deepEqual(bundle.selectedPostimages.map((x) => x.targetRef), freeze.selectedPostimages.map((x) => x.targetRef));
  const provenance = JSON.parse(read('media-pdp0-root-selected-source-integration-r9-r03.audit-gen-024-provenance-reconciliation.v1.json'));
  assert.match(provenance.reconciliation, /supersedes only the prior AUD-GEN-024 disposition/);
  assert.equal(provenance.repairEvidence.canonicalApply, 'NONE');
});
