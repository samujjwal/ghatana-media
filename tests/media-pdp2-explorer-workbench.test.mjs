import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTopology } from '../scripts/check-media-physical-topology.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(repo, file), 'utf8');
const topology = JSON.parse(read('.product-experience/surfaces/media-physical-topology.v1.json'));
const explorer = () => topology.manifestCandidates.find((item) => item.surfaceId === 'media.physical.apps-media-experience-explorer');

test('Explorer workbench has a source-bound applicable PDP-2 GUI contract', () => {
  const candidate = explorer();
  assert.equal(candidate.phaseApplicability['PDP-2'].disposition, 'GUI_TOOLING_CONSUMER');
  assert.ok(candidate.phaseApplicability['PDP-2'].authorityRefs.includes(
    '.product-experience/pdp-2-design-interface-system/gui/explorer-workbench.yaml'
  ));
  assert.deepEqual(validateTopology(topology), []);
});

test('Explorer workbench contract defines the documented modes and projection boundary', () => {
  const contract = read('.product-experience/pdp-2-design-interface-system/gui/explorer-workbench.yaml');
  const explorerDocs = read('.product-experience/explorer/EXPERIENCE-EXPLORER.md');
  const appReadme = read('apps/media-experience-explorer/README.md');
  for (const mode of ['Product', 'Explore', 'Specification', 'Verify', 'Tools Review']) {
    assert.ok(contract.includes(mode), `contract is missing documented mode ${mode}`);
    assert.ok(explorerDocs.includes(mode), `Explorer source docs do not support mode ${mode}`);
  }
  assert.match(contract, /authorityBoundary: Explorer is a projection of PDP-owned records/u);
  assert.match(contract, /runtime admission, owner acceptance, or native phase acceptance/u);
  assert.match(contract, /SOURCE_AUTHORED_DEFINITION; owner review and phase acceptance are not claimed/u);
  assert.match(appReadme, /does not\s+connect to the Media runtime/u);
});

test('topology rejects restoration of Explorer PDP-2 NOT_APPLICABLE or weakened contract binding', () => {
  const changed = structuredClone(topology);
  const cell = changed.manifestCandidates.find((item) => item.surfaceId === 'media.physical.apps-media-experience-explorer').phaseApplicability['PDP-2'];
  cell.disposition = 'NOT_APPLICABLE';
  cell.authorityRefs = cell.authorityRefs.filter((ref) => !ref.endsWith('/gui/explorer-workbench.yaml'));
  cell.rationale = 'Developer-facing read-only Explorer application; not a production Media UI.';
  const errors = validateTopology(changed);
  assert.ok(errors.some((error) => error.includes('applicable PDP-2 GUI tooling consumer')));
  assert.ok(errors.some((error) => error.includes('PDP-2 GUI authority refs must exactly match')));
  assert.ok(errors.some((error) => error.includes('must bind its own GUI contract')));
});
