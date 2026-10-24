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

test('R9-R06 replays deterministically and leaves R9-R05 immutable', () => {
  const replay = spawnSync(process.execPath, ['scripts/prepare-media-pdp0-root-selected-source-integration-r9-r06-candidate.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(replay.status, 0, replay.stderr || replay.stdout);
  assert.match(replay.stdout, /R9_R06_DETERMINISTIC_REPLAY_PASS/);
  assert.equal(sha(read('media-pdp0-root-selected-source-integration-r9-r05.freeze.v1.json')), '4ce72424e401e58cc16b59a28f552c79ffad60ef25094f005537d7322c4f0b37');
});

test('GEN-024 has one UNKNOWN_OUTCOME token in semantics and exact negative case parity', () => {
  const capDoc = YAML.parse(read('media-pdp0-root-selected-source-integration-r9-r06.split.capabilities.postimage.yaml'));
  const reqDoc = YAML.parse(read('media-pdp0-root-selected-source-integration-r9-r06.split.requirements.postimage.yaml'));
  const cap = capDoc.capabilities.find((x) => x.id === 'media.capability.provider-class-separation');
  const condition = cap.ownerDefinition.semanticOutcomeContract.conditions.find((x) => x.includes('missing/stale evidence'));
  assert.match(condition, /UNKNOWN_OUTCOME/);
  assert.doesNotMatch(condition, /\bUNKNOWN\b(?!_OUTCOME)/);
  const leaf = cap.acceptanceCases.find((x) => x.id === 'MEDIA-P0-COHORT02-AUD-GEN-024-LEAF-NEG');
  const parent = reqDoc.requirements.flatMap((x) => x.acceptanceCases).find((x) => x.sourceCapabilityCaseId === leaf.id);
  assert.ok(parent);
  for (const field of ['polarity','given','when','then']) assert.equal(parent[field], leaf[field], field);
  assert.match(leaf.given, /returns UNKNOWN_OUTCOME/);
  assert.match(leaf.given, /evidence stays UNKNOWN_OUTCOME/);
  assert.doesNotMatch(leaf.given, /\bUNKNOWN\b(?!_OUTCOME)/);
  assert.deepEqual(cap.ownerDefinition.successOutputs[0].observableContract.resultVariants, ['LICENSE_POLICY_AXIS_RECORDED','PLACEMENT_AXIS_RECORDED']);
  assert.ok(cap.ownerDefinition.nonSuccessOutputs.UNKNOWN_OUTCOME);
});

test('R9-R06 preserves campaign denominator and no-source-effect boundary', () => {
  const freeze = JSON.parse(read('media-pdp0-root-selected-source-integration-r9-r06.freeze.v1.json'));
  const bundle = JSON.parse(read('media-pdp0-root-selected-source-integration-r9-r06.successor-bundle.candidate.v1.json'));
  assert.equal(freeze.canonicalApply, 'NONE');
  assert.equal(freeze.phaseStatusEffect, 'NONE');
  assert.equal(freeze.historicalOwnerRowsPreserved, 462);
  assert.equal(bundle.retainedProjection.operationCount, 248);
  assert.equal(bundle.selectedAllowedOperations.operationCount, 122);
  assert.equal(bundle.historicalOwnerRowsPreserved, 462);
  assert.equal(JSON.parse(read('media-pdp0-root-selected-source-integration-r9-r06.split.pdp0-501-disposition-crosswalk.postimage.json')).rows.length, 501);
  for (const row of freeze.selectedPostimages) assert.equal(sha(read(path.basename(row.postimageRef))), row.postimageSha256);
});
