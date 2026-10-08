import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const toolsRequire = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url));
const { parse } = toolsRequire('yaml');

const bindings = parse(await readFile('.product-experience/pdp-3-product-experience/experience-source-bindings.yaml', 'utf8'));
const proposalStates = parse(await readFile('.product-experience/pdp-0-product-truth/state-models.yaml', 'utf8'));
const domainStates = parse(await readFile('.product-experience/pdp-1-domain-data/states.yaml', 'utf8'));
const source = await readFile('libs/media-experience-simulation/src/fixtures.ts', 'utf8');

function seedBlock(key) {
  const keys = [...source.matchAll(/^\s+"([^"]+)":/gmu)];
  const index = keys.findIndex(([, found]) => found === key);
  assert.notEqual(index, -1, `simulation source contains seed ${key}`);
  const start = keys[index].index;
  const end = keys[index + 1]?.index ?? source.length;
  return source.slice(start, end);
}

function boundFixtureState(binding) {
  const block = seedBlock(binding.sourceFixtureKey);

  if (binding.startingStateRef.startsWith('media-rights-and-consent.consent.')) {
    const explicitConsentState = block.match(/consentState:\s*"([A-Z_]+)"/u)?.[1];
    assert.ok(explicitConsentState, `${binding.sourceFixtureKey} declares a consent state`);
    return explicitConsentState;
  }

  if (['source-available', 'source-quarantined'].includes(binding.sourceFixtureKey)) {
    const explicitLifecycle = block.match(/lifecycle:\s*"([A-Z_]+)"/u)?.[1];
    if (explicitLifecycle) return explicitLifecycle;
    assert.match(block, /baseState\("media\.scenario\.source-available"\)/u);
    return source.match(/const baseState = \(scenarioId: ScenarioId\): TranscriptionExperienceState => \([\s\S]*?source:\s*\{[\s\S]*?lifecycle:\s*"([A-Z_]+)"/u)?.[1];
  }

  if (binding.startingStateRef.startsWith('media-upload-and-artifact.')) {
    const status = block.match(/uploadFixture\(\s*"([A-Z_]+)"/u)?.[1];
    assert.ok(status, `${binding.sourceFixtureKey} declares an upload status`);
    return status;
  }

  if (binding.startingStateRef.startsWith('media-job.') && binding.sourceFixtureKey.startsWith('artifact-verification-')) {
    const status = block.match(/status:\s*"([A-Z_]+)"/u)?.[1];
    assert.ok(status, `${binding.sourceFixtureKey} declares a verification job status`);
    return status;
  }

  if (binding.startingStateRef.startsWith('media-job.')) {
    const explicitJobState = block.match(/state:\s*"([A-Z_]+)"/u)?.[1];
    if (explicitJobState) return explicitJobState;
    assert.match(block, /readyState\("media\.scenario\.transcript-ready"\)/u,
      `${binding.sourceFixtureKey} must derive its job state from the exact ready-state helper`);
    return source.match(/const readyState = \(scenarioId: ScenarioId\): MediaExperienceState => \{[\s\S]*?job:\s*\{\s*jobId:[\s\S]*?state:\s*"([A-Z_]+)"/u)?.[1];
  }

  assert.fail(`unsupported state binding source for ${binding.scenarioRef}`);
}

test('P3-05 source start-state links match exact simulation seed fields without implying state acceptance', () => {
  const seenScenarios = new Set();
  const seenKeys = new Set();

  assert.equal(bindings.scenarioStartingStateBindings.length, 16);
  for (const binding of bindings.scenarioStartingStateBindings) {
    assert.equal(seenScenarios.has(binding.scenarioRef), false, `${binding.scenarioRef} is bound once`);
    assert.equal(seenKeys.has(binding.sourceFixtureKey), false, `${binding.sourceFixtureKey} is used once`);
    seenScenarios.add(binding.scenarioRef);
    seenKeys.add(binding.sourceFixtureKey);
    assert.equal(binding.scenarioRef, `media.scenario.${binding.sourceFixtureKey}`,
      'a canonical state binding names the seed with the identical stable scenario suffix');
    assert.equal(boundFixtureState(binding), binding.startingStateRef.split('.').at(-1),
      `${binding.scenarioRef} state ref matches the source seed value`);
  }

  const consentBinding = bindings.scenarioStartingStateBindings.find(({ scenarioRef }) => scenarioRef === 'media.scenario.consent-revoked');
  const consentProposal = proposalStates.models.find(({ modelId }) => modelId === 'media-rights-and-consent');
  const consentMachine = domainStates.stateMachines.find(({ machineId }) => machineId === 'media-rights-and-consent');
  assert.ok(consentProposal.consentStates.includes('REVOKED'), 'PDP-0 source proposal contains the referenced consent state');
  assert.deepEqual(consentMachine.stateIds, [], 'PDP-1 has not selected consent state IDs');
  assert.match(bindings.status, /^proposal-only;/u, 'all bindings remain proposal-only pending independent review');
  assert.equal(consentBinding.startingStateRef, 'media-rights-and-consent.consent.REVOKED');
  const retryIneligible = bindings.scenarioStartingStateBindings.find(({ scenarioRef }) => scenarioRef === 'media.scenario.job-retry-ineligible');
  assert.equal(retryIneligible.sourceFixtureKey, 'job-retry-ineligible');
  assert.equal(retryIneligible.startingStateRef, 'media-job.OUTCOME_UNKNOWN');
});
