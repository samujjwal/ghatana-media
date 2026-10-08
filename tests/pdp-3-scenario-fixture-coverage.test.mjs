import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const toolsRequire = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url));
const { parse } = toolsRequire('yaml');

const registry = parse(await readFile('.product-experience/pdp-3-product-experience/scenario-fixture-registry.yaml', 'utf8'));
const fixtureIndex = parse(await readFile('.product-experience/explorer/scenario-fixtures.yaml', 'utf8'));
const sourceBindings = parse(await readFile('.product-experience/pdp-3-product-experience/experience-source-bindings.yaml', 'utf8'));
const actionRegistry = parse(await readFile('.product-experience/pdp-3-product-experience/action-registry.yaml', 'utf8'));
const stateModels = parse(await readFile('.product-experience/pdp-0-product-truth/state-models.yaml', 'utf8'));
const domainStates = parse(await readFile('.product-experience/pdp-1-domain-data/states.yaml', 'utf8'));
const simulationSource = await readFile('libs/media-experience-simulation/src/fixtures.ts', 'utf8');
const journeyDirectory = '.product-experience/pdp-3-product-experience/journey-contracts';

function simulationSeedKeys(source) {
  const seedMap = source.match(/const seeds: Record<FixtureId, MediaExperienceState> = \{([\s\S]*?)\n\};/u)?.[1];
  assert.ok(seedMap, 'simulation fixture source has a bounded seeds record');
  return [...seedMap.matchAll(/^\s+"([^"]+)":/gmu)].map(([, key]) => key);
}

test('P3-05 scenario and fixture denominator preserves source-linked and blocked populations', async () => {
  const scenarios = new Map(registry.fixtures.map((fixture) => [fixture.id, fixture]));
  const seeds = new Set(simulationSeedKeys(simulationSource));
  const indexed = new Map(fixtureIndex.fixtures.map((fixture) => [fixture.scenarioId, fixture]));
  const stateBindings = new Map(sourceBindings.scenarioStartingStateBindings.map((binding) => [binding.scenarioRef, binding]));

  assert.equal(scenarios.size, 31, 'the authored scenario registry denominator remains explicit');
  assert.equal(seeds.size, 30, 'only exact keys in the simulation seed record count as seeded');
  assert.equal(indexed.size, 30, 'only indexed synthetic fixture payloads count as Explorer fixtures');
  assert.deepEqual(new Set(indexed.keys()), new Set([...seeds].map((key) => `media.scenario.${key}`)));
  assert.deepEqual(new Set(seeds), new Set([...scenarios.keys()].map((id) => id.slice('media.scenario.'.length)).filter((key) => seeds.has(key))));

  const unseeded = [...scenarios.keys()].filter((id) => !seeds.has(id.slice('media.scenario.'.length))).sort();
  assert.deepEqual(unseeded, [
    'media.scenario.job-retry-eligible',
  ]);
  assert.ok(unseeded.every((id) => /proposal-only/u.test(scenarios.get(id).pdp3PayloadState ?? '')));
  const retryAction = actionRegistry.actions.find(({ id }) => id === 'media.action.retry-job');
  assert.deepEqual(retryAction.scenarioRefs, ['media.scenario.job-retry-eligible', 'media.scenario.job-retry-ineligible'], 'the action authority links both retry proposals while payload availability is tracked independently');
  assert.match(retryAction.effect, /new-fenced-attempt/u);
  assert.ok(retryAction.scenarioRefs.every((id) => /no-local-retry-reducer/u.test(scenarios.get(id).pdp3PayloadState)));
  assert.equal(scenarios.get('media.scenario.job-retry-ineligible').sourceFixtureRef, 'FIXTURE-PROVIDER-AMBIGUITY');
  assert.match(scenarios.get('media.scenario.job-retry-ineligible').pdp3PayloadState, /unknown-outcome-branch-seeded/u);

  const pdp1CanonicalStateRefs = new Set(domainStates.stateMachines.flatMap(({ machineId, stateIds }) =>
    stateIds.map((stateId) => `${machineId}.${stateId}`)));
  const canonicalStartBindings = [...stateBindings.values()].filter(({ startingStateRef }) => pdp1CanonicalStateRefs.has(startingStateRef));
  const sourceSeededWithoutCanonicalStart = [...seeds]
    .map((key) => `media.scenario.${key}`)
    .filter((id) => !pdp1CanonicalStateRefs.has(stateBindings.get(id)?.startingStateRef))
    .sort();
  const sourceSeededWithoutAnyStateLink = sourceSeededWithoutCanonicalStart.filter((id) => !stateBindings.has(id));
  assert.equal(stateBindings.size, 16, 'exact source-state links include proposal-only links');
  assert.equal(canonicalStartBindings.length, 15, 'only PDP-1 enumerated state IDs count as canonical starts');
  assert.deepEqual(sourceSeededWithoutCanonicalStart, [
    'media.scenario.alignment-required',
    'media.scenario.caption-conflict',
    'media.scenario.caption-corrected',
    'media.scenario.caption-source-mismatch',
    'media.scenario.caption-version-comparison',
    'media.scenario.consent-revoked',
    'media.scenario.first-use-empty',
    'media.scenario.identity-required',
    'media.scenario.intent-unavailable',
    'media.scenario.language-uncertain',
    'media.scenario.project-create-outcome-unknown',
    'media.scenario.project-created-empty',
    'media.scenario.upload-interrupted',
    'media.scenario.upload-outcome-unknown',
    'media.scenario.workspace-access-denied',
  ], 'seeded payloads without exact PDP-1 canonical starting-state links remain individually visible');
  assert.ok(sourceSeededWithoutCanonicalStart.every((id) => seeds.has(id.slice('media.scenario.'.length))));
  assert.deepEqual(sourceSeededWithoutAnyStateLink, sourceSeededWithoutCanonicalStart.filter((id) => id !== 'media.scenario.consent-revoked'),
    'the consent proposal link is the only source-state link that is not a PDP-1 canonical state');
  assert.equal(sourceSeededWithoutAnyStateLink.length, 14);
  const canonicalModelIds = new Set(stateModels.models.map(({ modelId }) => modelId));
  const consentModel = stateModels.models.find(({ modelId }) => modelId === 'media-rights-and-consent');
  const domainConsentMachine = domainStates.stateMachines.find(({ machineId }) => machineId === 'media-rights-and-consent');
  assert.ok(consentModel.consentStates.includes('REVOKED'));
  assert.equal(consentModel.states, undefined, 'the consent axis has no explicitly terminal-annotated state records');
  assert.deepEqual(domainConsentMachine.stateIds, [], 'PDP-1 confirms no owner-selected canonical rights/consent machine states');
  assert.equal(stateBindings.get('media.scenario.consent-revoked').startingStateRef, 'media-rights-and-consent.consent.REVOKED',
    'the exact seed is cross-referenced to the PDP-0 proposal identity, without filling PDP-1 stateIds');
  assert.equal(stateBindings.get('media.scenario.job-retry-ineligible').startingStateRef, 'media-job.OUTCOME_UNKNOWN',
    'the ineligible retry seed uses the exact canonical state for its explicit unknown-outcome branch');
  assert.match(sourceBindings.status, /^proposal-only;/u,
    'source-state cross-references remain proposals pending independent review');
  assert.ok(!domainConsentMachine.stateIds.includes('REVOKED'),
    'the cross-reference does not imply an owner-selected PDP-1 rights/consent machine state');
  assert.match(simulationSource, /"consent-revoked": \{[\s\S]*?consentState: "REVOKED"/u,
    'the exact synthetic fixture records the same consent-axis state');
  assert.match(simulationSource, /"job-retry-ineligible": \{[\s\S]*?state: "OUTCOME_UNKNOWN",[\s\S]*?attemptState: "OUTCOME_UNKNOWN",[\s\S]*?finality: "UNKNOWN"/u,
    'the ineligible retry fixture represents only the explicitly sourced unknown-outcome branch');
  assert.equal(canonicalModelIds.has('media-first-use'), false,
    'first-use payloads lack a matching canonical first-use state model');
  assert.equal(canonicalModelIds.has('media-caption'), false,
    'caption and transcript payload dimensions lack a matching canonical content state model');
  const uploadStates = new Set(stateModels.models.find(({ modelId }) => modelId === 'media-upload-and-artifact')
    .states.map((state) => typeof state === 'string' ? state : state.id));
  assert.equal(uploadStates.has('INTERRUPTED'), false,
    'the interrupted-upload payload has no exact canonical upload state');
  assert.equal(uploadStates.has('OUTCOME_UNKNOWN'), false,
    'the upload-outcome-unknown payload has no exact canonical upload state');
  assert.equal(canonicalStartBindings.length + sourceSeededWithoutCanonicalStart.length + unseeded.length, scenarios.size);

  const journeyFiles = (await readdir(journeyDirectory)).filter((file) => file.endsWith('.yaml'));
  const journeys = await Promise.all(journeyFiles.map(async (file) => parse(await readFile(`${journeyDirectory}/${file}`, 'utf8'))));
  assert.equal(journeys.length, 30);
  const seededJourneyIds = registry.journeyCoverage.journeysWithExactSimulationSeeds;
  const blockedJourneyIds = registry.journeyCoverage.journeysWithoutExactSimulationSeeds;
  assert.equal(seededJourneyIds.length, 3);
  assert.equal(blockedJourneyIds.length, 27);
  assert.equal(new Set([...seededJourneyIds, ...blockedJourneyIds]).size, 30);
  assert.deepEqual(new Set(journeys.map(({ journeyId }) => journeyId)), new Set([...seededJourneyIds, ...blockedJourneyIds]));
  assert.match(registry.journeyCoverage.status, /owner-approved-oracles-pending/u);
  assert.match(fixtureIndex.status, /deterministic-synthetic-fixtures/u);
  assert.match(fixtureIndex.status, /Tools-host-binding-pending/u);
});
