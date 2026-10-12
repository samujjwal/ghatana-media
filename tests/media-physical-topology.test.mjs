import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTopology } from '../scripts/check-media-physical-topology.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const topology = JSON.parse(fs.readFileSync(path.join(repo, '.product-experience/surfaces/media-physical-topology.v1.json'), 'utf8'));
const copy = () => structuredClone(topology);

test('physical topology is deterministic and source-backed', () => {
  assert.deepEqual(validateTopology(topology), []);
});

test('rejects an unclassified or duplicate manifest candidate', () => {
  const changed = copy();
  changed.manifestCandidates[0].disposition = 'MAYBE';
  changed.manifestCandidates[1].sourcePath = changed.manifestCandidates[0].sourcePath;
  const errors = validateTopology(changed);
  assert.ok(errors.some((error) => error.includes('unsupported physical disposition')));
  assert.ok(errors.some((error) => error.includes('physical source paths must be unique')));
});

test('rejects missing crosswalk members and dangling physical bindings', () => {
  const changed = copy();
  changed.consumerCrosswalk.pop();
  changed.consumerCrosswalk[0].physicalRefs = ['media.physical.unknown'];
  const errors = validateTopology(changed);
  assert.ok(errors.some((error) => error.includes('exactly 17 unique surfaces')));
  assert.ok(errors.some((error) => error.includes('unknown physical ref')));
});

test('rejects containment cycles and unreferenced phase meaning', () => {
  const changed = copy();
  const comp = changed.compositions.find((x) => x.kind === 'SEMANTIC_COMPOSITION');
  comp.children.push(changed.compositions[0].surfaceId);
  changed.manifestCandidates[0].phaseApplicability['PDP-0'].capabilityIntentIds.push('media.unknown.capability');
  const errors = validateTopology(changed);
  assert.ok(errors.some((error) => error.includes('containment cycle')));
  assert.ok(errors.some((error) => error.includes('not in canonical source')));
});
