import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse } from 'yaml';

const requirements = parse(fs.readFileSync('.product-experience/pdp-0-product-truth/requirements.yaml', 'utf8'));
const audio = requirements.requirements.find(row => row.id === 'MEDIA-REQ-CAP-GENERATE-AUDIO');
const checkpointRights = audio?.acceptanceCases?.find(row => row.id === 'MEDIA-REQ-CAP-GENERATE-AUDIO-AC-05');

test('P0 generated-audio checkpoint rights bind exact identity, license, declared purpose, and commercial scope', () => {
  assert.ok(checkpointRights, 'checkpoint rights acceptance case exists');
  assert.match(checkpointRights.given, /identified model checkpoint.*declared use scope/i);
  assert.match(checkpointRights.then, /exact checkpoint identity and version/i);
  assert.match(checkpointRights.then, /license identity and use-scope terms/i);
  assert.match(checkpointRights.then, /declared purpose/i);
  assert.match(checkpointRights.then, /noncommercial checkpoint terms for commercial use/i);
});

test('P0 checkpoint rights block unknown and incompatible use without asserting runtime admission', () => {
  assert.match(checkpointRights.then, /absent, unknown, denied, expired, restricted, or incompatible/i);
  assert.match(checkpointRights.rejection, /similarity observation.*rights clearance/i);
  assert.match(checkpointRights.rejection, /silently substituting a different checkpoint/i);
  assert.equal(audio.downstreamMappings.implementation, 'not-authorized-by-definition');
  assert.match(audio.statement, /license admission, qualification, and runtime availability are separately established/i);
});
