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

test('R9-R05 replays byte-identically and preserves frozen R9-R04', () => {
  const replay = spawnSync(process.execPath, ['scripts/prepare-media-pdp0-root-selected-source-integration-r9-r05-candidate.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(replay.status, 0, replay.stderr || replay.stdout);
  assert.match(replay.stdout, /R9_R05_DETERMINISTIC_REPLAY_PASS/);
  assert.equal(sha(read('media-pdp0-root-selected-source-integration-r9-r04.freeze.v1.json')), 'e40c5799ececef5dbec8f7de7ddce76f3e4a088b66495ed35a0feafc0c162dab');
  assert.equal(sha(read('media-pdp0-root-selected-source-integration-r9-r04.split.capabilities.postimage.yaml')), '15f5336b36881ae628a5c171e97d0deab930f7d6b2ec92e778ea87383463c638');
});

test('GEN-024 success result variants are separate from UNKNOWN_OUTCOME and UNAVAILABLE', () => {
  const capDoc = YAML.parse(read('media-pdp0-root-selected-source-integration-r9-r05.split.capabilities.postimage.yaml'));
  const reqDoc = YAML.parse(read('media-pdp0-root-selected-source-integration-r9-r05.split.requirements.postimage.yaml'));
  const cap = capDoc.capabilities.find((x) => x.id === 'media.capability.provider-class-separation');
  const output = cap.ownerDefinition.successOutputs[0];
  assert.deepEqual(output.resultVariants, ['LICENSE_POLICY_AXIS_RECORDED','PLACEMENT_AXIS_RECORDED']);
  assert.deepEqual(output.observableContract.resultVariants, ['LICENSE_POLICY_AXIS_RECORDED','PLACEMENT_AXIS_RECORDED']);
  assert.deepEqual(Object.keys(cap.ownerDefinition.nonSuccessOutputs).sort(), ['REJECTED','UNAVAILABLE','UNKNOWN_OUTCOME']);
  assert.match(cap.ownerDefinition.nonSuccessOutputs.UNKNOWN_OUTCOME.conditions.join(' '), /missing, stale, or ambiguous/);
  const positive = cap.acceptanceCases.find((x) => x.id === 'MEDIA-P0-COHORT02-AUD-GEN-024-LEAF-POS');
  const positiveParent = reqDoc.requirements.flatMap((x) => x.acceptanceCases).find((x) => x.sourceCapabilityCaseId === positive.id);
  assert.equal(positive.then, positiveParent.then);
  assert.match(positive.then, /"resultVariants":\["LICENSE_POLICY_AXIS_RECORDED","PLACEMENT_AXIS_RECORDED"\]/);
  assert.doesNotMatch(positive.then, /"UNAVAILABLE"|"UNKNOWN"/);
});

test('R9-R05 retains campaign counts and no canonical/status effect', () => {
  const freeze = JSON.parse(read('media-pdp0-root-selected-source-integration-r9-r05.freeze.v1.json'));
  const bundle = JSON.parse(read('media-pdp0-root-selected-source-integration-r9-r05.successor-bundle.candidate.v1.json'));
  assert.equal(freeze.canonicalApply, 'NONE');
  assert.equal(freeze.phaseStatusEffect, 'NONE');
  assert.equal(freeze.historicalOwnerRowsPreserved, 462);
  assert.equal(bundle.retainedProjection.operationCount, 248);
  assert.equal(bundle.selectedAllowedOperations.operationCount, 122);
  assert.equal(bundle.historicalOwnerRowsPreserved, 462);
  assert.equal(JSON.parse(read('media-pdp0-root-selected-source-integration-r9-r05.split.pdp0-501-disposition-crosswalk.postimage.json')).rows.length, 501);
  for (const row of freeze.selectedPostimages) assert.equal(sha(read(path.basename(row.postimageRef))), row.postimageSha256);
});
