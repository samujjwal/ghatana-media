import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRecorderStudioSuccessor } from '../scripts/check-media-recorder-studio-successor.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const topo = JSON.parse(readFileSync(path.join(root, '.product-experience/surfaces/media-physical-topology.v1.json'),'utf8'));
const copy = () => structuredClone(topo);

test('Recorder/Studio source-only surface, product truth, domain and design are connected', () => {
  assert.deepEqual(validateRecorderStudioSuccessor(), []);
});
test('new capture surface cannot vanish from the declared consumer census', () => {
  const modified=copy();
  modified.consumerCrosswalk=modified.consumerCrosswalk.filter((x)=>x.surfaceId!=='media.surface.capture-agent');
  assert.ok(validateRecorderStudioSuccessor(modified).some((x)=>x.includes('missing Recorder/Studio consumer media.surface.capture-agent')));
});
test('new cross-child composition cannot disappear silently', () => {
  const modified=copy();
  modified.compositions=modified.compositions.filter((x)=>x.surfaceId!=='media.composition.experience-recorder-studio');
  assert.ok(validateRecorderStudioSuccessor(modified).some((x)=>x.includes('new cross-child composition missing root membership')));
});
test('PDP3 remains an explicit successor and no physical package is fabricated', () => {
  const modified=copy();
  modified.succession.PDP3='DEV_COMPLETE';
  modified.succession.physicalPackageCreation='IMPLEMENTED';
  const errors=validateRecorderStudioSuccessor(modified);
  assert.ok(errors.some((x)=>x.includes('PDP3 must remain explicit successor')));
  assert.ok(errors.some((x)=>x.includes('no phantom physical implementation')));
});
