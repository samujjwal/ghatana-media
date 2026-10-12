import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePdp3ImplementationHandoff } from '../scripts/lib/pdp3-implementation-handoff-validation.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const handoffPath = '.product-experience/pdp-3-product-experience/generated/implementation-handoff.v1.json';
const load = () => JSON.parse(fs.readFileSync(path.join(root, handoffPath), 'utf8'));

test('PDP-3 implementation handoff has exact populations and current source pins', () => {
  assert.equal(validatePdp3ImplementationHandoff(load(), root), true);
});
test('handoff rejects a missing screen', () => {
  const pack = load();
  pack.experiences.screens.pop();
  assert.throws(() => validatePdp3ImplementationHandoff(pack, root), /screen population/);
});
test('handoff rejects duplicate experience identities', () => {
  const pack = load();
  pack.experiences.journeys[1].id = pack.experiences.journeys[0].id;
  assert.throws(() => validatePdp3ImplementationHandoff(pack, root), /journey IDs.*unique/);
});
test('handoff rejects a missing or stale source pin', () => {
  const pack = load();
  delete pack.sourcePins['.product-experience/pdp-3-product-experience/screen-registry.yaml'];
  assert.throws(() => validatePdp3ImplementationHandoff(pack, root), /no source pin/);
  const stale = load();
  stale.sourcePins['.product-experience/pdp-3-product-experience/screen-registry.yaml'] = '0'.repeat(64);
  assert.throws(() => validatePdp3ImplementationHandoff(stale, root), /is stale/);
});
