import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const root = process.cwd();
const dir = 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const file = (name) => path.join(root, dir, name);
const read = (name) => fs.readFileSync(file(name), 'utf8');
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
function caseBlock(doc, caseId) {
  const marker = `      - id: ${caseId}\n`;
  const start = doc.indexOf(marker);
  assert.notEqual(start, -1, `case exists: ${caseId}`);
  const next = doc.indexOf('\n      - id: ', start + marker.length);
  return doc.slice(start, next < 0 ? doc.length : next + 1);
}
function field(doc, caseId, key) {
  const match = caseBlock(doc, caseId).match(new RegExp(`^        ${key}: (.*)$`, 'm'));
  assert.ok(match, `${key} exists in ${caseId}`);
  return match[1];
}
function linkedParents(req, leafId) {
  return req.split(/(?=^      - id: )/m).filter((block) => block.includes(`sourceCapabilityCaseId: ${leafId}`)).map((block) => block.match(/^      - id: ([^\n]+)/m)?.[1]).filter(Boolean);
}

test('R9-R04 deterministically replays from the frozen R9-R03 review cut', () => {
  const replay = spawnSync(process.execPath, ['scripts/prepare-media-pdp0-root-selected-source-integration-r9-r04-candidate.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(replay.status, 0, replay.stderr || replay.stdout);
  assert.match(replay.stdout, /R9_R04_DETERMINISTIC_REPLAY_PASS/);
  assert.equal(sha(read('media-pdp0-root-selected-source-integration-r9-r03.freeze.v1.json')), '5c6f180b3c0a67013d33d9c452116489922be411f91cd63de1a3bc41eb2523bc');
  assert.equal(sha(read('media-pdp0-root-selected-source-integration-r9-r03.split.capabilities.postimage.yaml')), 'a1024a1297b21525a9f48415638133423177903814d549f67bfbf82262673349');
});

test('all linked cases for the seven inherited audit families now have exact parent leaf parity', () => {
  const audits = ['AUD-CAP-028','AUD-CLONE-004','AUD-CLONE-006','AUD-CLONE-017','AUD-COLOR-007','AUD-DELIV-007','AUD-COLOR-001'];
  const cap = YAML.parse(read('media-pdp0-root-selected-source-integration-r9-r04.split.capabilities.postimage.yaml'));
  const req = YAML.parse(read('media-pdp0-root-selected-source-integration-r9-r04.split.requirements.postimage.yaml'));
  let count = 0;
  for (const audit of audits) {
    for (const feature of cap.capabilities) {
      for (const leaf of feature.acceptanceCases.filter((c) => c.sourceAuditId === audit)) {
        const parents = req.requirements.flatMap((r) => r.acceptanceCases.filter((c) => c.sourceCapabilityCaseId === leaf.id));
        assert.ok(parents.length, `${leaf.id} has parent`);
        for (const parent of parents) {
          for (const key of ['polarity','given','when','then']) assert.equal(parent[key], leaf[key], `${audit}/${leaf.id}/${key}`);
          assert.equal(parent.sourceAuditId, audit);
          assert.equal(parent.sourceCapabilityId, feature.id);
          count++;
        }
      }
    }
  }
  assert.equal(count, 34);
  assert.equal(req.requirements.flatMap((r) => r.acceptanceCases).filter((c) => audits.some((a) => c.sourceAuditId === a)).length, 34);
});

test('AUD-GEN-024 maps evidence uncertainty only to UNKNOWN_OUTCOME', () => {
  const cap = YAML.parse(read('media-pdp0-root-selected-source-integration-r9-r04.split.capabilities.postimage.yaml'));
  const req = YAML.parse(read('media-pdp0-root-selected-source-integration-r9-r04.split.requirements.postimage.yaml'));
  const feature = cap.capabilities.find((x) => x.id === 'media.capability.provider-class-separation');
  const rejected = feature.ownerDefinition.nonSuccessOutputs.REJECTED.conditions.join(' ');
  const unknown = feature.ownerDefinition.nonSuccessOutputs.UNKNOWN_OUTCOME.conditions.join(' ');
  assert.match(rejected, /explicitly invalid, unsupported, or denied/);
  assert.doesNotMatch(rejected, /missing|stale|ambiguous|UNKNOWN/i);
  assert.match(unknown, /missing, stale, or ambiguous/);
  const leaf = feature.acceptanceCases.find((x) => x.id === 'MEDIA-P0-COHORT02-AUD-GEN-024-LEAF-NEG');
  const parent = req.requirements.flatMap((r) => r.acceptanceCases).find((x) => x.sourceCapabilityCaseId === leaf.id);
  assert.equal(parent.then, leaf.then);
  assert.match(leaf.then, /"UNKNOWN_OUTCOME"/);
  assert.match(leaf.then, /missing, stale, or ambiguous/);
  assert.match(leaf.then, /"REJECTED"/);
  assert.doesNotMatch(leaf.then, /"REJECTED"[^}]*missing, stale, or ambiguous/);
});

test('R9-R04 conserves full campaign counts and never applies source or status', () => {
  const freeze = JSON.parse(read('media-pdp0-root-selected-source-integration-r9-r04.freeze.v1.json'));
  const bundle = JSON.parse(read('media-pdp0-root-selected-source-integration-r9-r04.successor-bundle.candidate.v1.json'));
  assert.equal(freeze.historicalOwnerRowsPreserved, 462);
  assert.equal(freeze.phaseStatusEffect, 'NONE');
  assert.equal(freeze.canonicalApply, 'NONE');
  assert.equal(bundle.retainedProjection.operationCount, 248);
  assert.equal(bundle.selectedAllowedOperations.operationCount, 122);
  assert.equal(bundle.historicalOwnerRowsPreserved, 462);
  assert.equal(JSON.parse(read('media-pdp0-root-selected-source-integration-r9-r04.split.pdp0-501-disposition-crosswalk.postimage.json')).rows.length, 501);
  assert.equal(bundle.selectedPostimages.length, 4);
  for (const row of freeze.selectedPostimages) assert.equal(sha(read(path.basename(row.postimageRef))), row.postimageSha256);
});
