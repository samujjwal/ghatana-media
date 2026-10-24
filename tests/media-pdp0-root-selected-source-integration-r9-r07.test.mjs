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

test('R9-R07 replays deterministically and preserves R9-R06', () => {
  const replay = spawnSync(process.execPath, ['scripts/prepare-media-pdp0-root-selected-source-integration-r9-r07-candidate.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(replay.status, 0, replay.stderr || replay.stdout);
  assert.match(replay.stdout, /R9_R07_DETERMINISTIC_REPLAY_PASS/);
  assert.equal(sha(read('media-pdp0-root-selected-source-integration-r9-r06.freeze.v1.json')), 'ec142cda6ba9820a4113df444b1718d292d283e3f822061f77f0ec289857a57f');
});

test('GEN-024 uses only UNKNOWN_OUTCOME for missing, stale or ambiguous evidence', () => {
  const capDoc = YAML.parse(read('media-pdp0-root-selected-source-integration-r9-r07.split.capabilities.postimage.yaml'));
  const reqDoc = YAML.parse(read('media-pdp0-root-selected-source-integration-r9-r07.split.requirements.postimage.yaml'));
  const cap = capDoc.capabilities.find((x) => x.id === 'media.capability.provider-class-separation');
  for (const entry of cap.explicitUnsupportedCases.filter((x) => /\bUNKNOWN\b/.test(x))) {
    assert.match(entry, /UNKNOWN_OUTCOME/);
    assert.doesNotMatch(entry, /\bUNKNOWN\b(?!_OUTCOME)/);
  }
  const semantic = JSON.stringify(cap.ownerDefinition.semanticOutcomeContract);
  assert.match(semantic, /UNKNOWN_OUTCOME/);
  assert.doesNotMatch(semantic, /\bUNKNOWN\b(?!_OUTCOME)/);
  const leaf = cap.acceptanceCases.find((x) => x.id === 'MEDIA-P0-COHORT02-AUD-GEN-024-LEAF-NEG');
  const parent = reqDoc.requirements.flatMap((x) => x.acceptanceCases).find((x) => x.sourceCapabilityCaseId === leaf.id);
  assert.ok(parent);
  for (const field of ['polarity','given','when','then']) assert.equal(parent[field], leaf[field]);
  assert.match(leaf.given, /UNKNOWN_OUTCOME/);
  assert.doesNotMatch(leaf.given, /\bUNKNOWN\b(?!_OUTCOME)/);
});

test('R9-R07 conserves campaign counts and no-source-effect boundary', () => {
  const freeze = JSON.parse(read('media-pdp0-root-selected-source-integration-r9-r07.freeze.v1.json'));
  const bundle = JSON.parse(read('media-pdp0-root-selected-source-integration-r9-r07.successor-bundle.candidate.v1.json'));
  assert.equal(freeze.canonicalApply, 'NONE');
  assert.equal(freeze.phaseStatusEffect, 'NONE');
  assert.equal(freeze.historicalOwnerRowsPreserved, 462);
  assert.equal(bundle.retainedProjection.operationCount, 248);
  assert.equal(bundle.selectedAllowedOperations.operationCount, 122);
  assert.equal(bundle.historicalOwnerRowsPreserved, 462);
  assert.equal(JSON.parse(read('media-pdp0-root-selected-source-integration-r9-r07.split.pdp0-501-disposition-crosswalk.postimage.json')).rows.length, 501);
  for (const row of freeze.selectedPostimages) assert.equal(sha(read(path.basename(row.postimageRef))), row.postimageSha256);
});
