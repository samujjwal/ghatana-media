import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const docs = {
  pdp0: '.product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md',
  pdp1: '.product-experience/pdp-1-domain-data/DOMAIN-MODEL.md',
  pdp2: '.product-experience/pdp-2-design-interface-system/DESIGN-LANGUAGE.md',
  pdp3: '.product-experience/pdp-3-product-experience/COMPLETE-PRODUCT-EXPERIENCE.md',
};
const candidates = {
  pdp0: '.product-experience/pdp-0-product-truth/generated/product-definition.candidate.json',
  pdp2: '.product-experience/pdp-2-design-interface-system/generated/experience-language.candidate.json',
  pdp3: '.product-experience/pdp-3-product-experience/generated/experience-specification.candidate.json',
};
const contents = Object.fromEntries(await Promise.all(Object.entries(docs).map(async ([key, path]) => [key, await readFile(path, 'utf8')])));
const projections = Object.fromEntries(await Promise.all(Object.entries(candidates).map(async ([key, path]) => [key, JSON.parse(await readFile(path, 'utf8'))])));

test('PDP overview pages link current authority, acceptance, and source inventory records', () => {
  for (const [name, body] of Object.entries(contents)) {
    assert.match(body, /\.\.\/source-manifest\.yaml/, `${name} source manifest link`);
    assert.match(body, /\.\.\/artifact-identities\.yaml/, `${name} artifact identity link`);
    assert.match(body, /\.\.\/acceptance\.yaml/, `${name} acceptance record link`);
    assert.match(body, /\.\.\/authority-map\.yaml/, `${name} authority map link`);
    assert.match(body, /Lifecycle/i, `${name} must identify Lifecycle evidence as a separate authority`);
  }
  assert.match(contents.pdp0, /independent-product-definition-reviewer/);
  assert.match(contents.pdp1, /media-domain-lead/);
  assert.match(contents.pdp2, /accessibility and\s+localization specialist/);
  assert.match(contents.pdp3, /UX information architect/);
});

test('PDP overview blocker summaries match generated candidate projections', () => {
  const p0 = projections.pdp0;
  assert.deepEqual(p0.fieldMappingBlockers.map(({ field }) => field), []);
  assert.equal(p0.candidateModel.userIntents.length, 19);
  assert.match(contents.pdp0, /zero\s+semantic field projection blockers/);
  assert.match(contents.pdp0, /all 19\s+source intents and\s+30 journeys with representative initiators selected by PXD-030/);
  assert.equal(p0.acceptance, 'NOT_CLAIMED');

  const p2 = projections.pdp2;
  assert.deepEqual(p2.fieldMappingBlockers.map(({ field }) => field), []);
  assert.equal(p2.candidateModel.recipeBindings.length, 13);
  assert.match(contents.pdp2, /13 owner-approved GUI recipe identities/);
  assert.match(contents.pdp2, /13 reusable templates, 11 layouts/);
  assert.match(contents.pdp2, /3 density profiles, 3 presentation profiles, 18 interaction patterns/);
  assert.equal(p2.acceptance, 'NOT_CLAIMED');

  const p3 = projections.pdp3;
  assert.deepEqual(p3.fieldMappingBlockers.map(({ field }) => field), ['componentContracts', 'views', 'journeys', 'transitions', 'actions', 'effects', 'finality', 'scenarios', 'fixtures']);
  assert.deepEqual(Object.fromEntries(['componentContracts', 'views', 'journeys', 'transitions', 'actions', 'effects', 'finality', 'recovery', 'scenarios', 'fixtures'].map((key) => [key, p3.candidateModel[key].length])), {
    componentContracts: 31, views: 47, journeys: 30, transitions: 0, actions: 146, effects: 1, finality: 19, recovery: 5, scenarios: 15, fixtures: 15,
  });
  assert.match(contents.pdp3, /nine\s+semantic field blockers/);
  assert.match(contents.pdp3, /projects 31\s+component contracts, 47 views,\s+30 journey records with 130 of 130 source\s+steps/);
  assert.equal(p3.acceptance, 'NOT_CLAIMED');
});

test('PDP overview docs keep phase prerequisites and independent/external gates explicit', () => {
  assert.match(contents.pdp0, /P0-010 independent review remain open/);
  assert.match(contents.pdp1, /independent P0-010 acceptance/);
  assert.match(contents.pdp2, /accepted PDP-1/);
  assert.match(contents.pdp2, /Shared public package binding.*remain pending/s);
  assert.match(contents.pdp3, /depends on accepted PDP-2/);
  assert.match(contents.pdp3, /independent experience review.*remain separate pending gates/s);
});

test('PDP-3 overview preserves historical PXD-028 and current PXD-037 composition-link decisions', () => {
  assert.match(contents.pdp3, /PXD-028 historically approved 41 exact top-level\s+template\/layout links; PXD-037 reviewed the six remaining purposes and approved/);
  assert.match(contents.pdp3, /bringing the definition mapping\s+to 47 of 47 screens/);
  assert.match(contents.pdp3, /zero screen compositions are admitted/);
});
