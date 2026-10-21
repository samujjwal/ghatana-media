import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse } from 'yaml';

const requirements = parse(fs.readFileSync('.product-experience/pdp-0-product-truth/requirements.yaml', 'utf8'));
const capabilityDefinitions = parse(fs.readFileSync('.product-experience/pdp-0-product-truth/capabilities.yaml', 'utf8'));
const audio = requirements.requirements.find(row => row.id === 'MEDIA-REQ-CAP-GENERATE-AUDIO');
const checkpointRights = audio?.acceptanceCases?.find(row => row.id === 'MEDIA-REQ-CAP-GENERATE-AUDIO-AC-05');
const artifact = requirements.requirements.find(row => row.id === 'MEDIA-REQ-CAP-ARTIFACT');
const artifactRights = artifact?.acceptanceCases?.find(row => row.id === 'MEDIA-REQ-CAP-ARTIFACT-AC-05');
const artifactSearch = capabilityDefinitions.capabilities.find(row => row.id === 'media.artifact.search');

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

test('PXD-208 authorization applies to both asset search and checkpoint use at the declared scope', () => {
  const verifiedAuthority = 'The caller identity, tenant/workspace context, and delegated authority are verified by the owning platform contracts.';
  assert.match(artifact.statement, /explicit, authorized, compatible binding/i);
  assert.match(audio.statement, /explicit, authorized, compatible binding/i);
  assert.ok(artifact.preconditions.includes(verifiedAuthority));
  assert.ok(audio.preconditions.includes(verifiedAuthority));
  assert.match(artifactRights.given, /authorized Studio creator.*explicitly declared intended-use scope/i);
  assert.match(checkpointRights.given, /authorized creator.*identified model checkpoint.*declared use scope/i);

  const searchGuards = artifactSearch?.ownerDefinition?.guards;
  assert.ok(searchGuards?.preconditions.includes('Verified actor/workspace and required delegated authority.'));
  assert.ok(searchGuards?.authorityRefs.includes('operation-specific-policy-and-rights'));
  const licensedSearch = artifactSearch.ownerDefinition.parameterSchema.conditionalSemantics
    .find(row => row.when === 'searchIntent=LICENSE_ELIGIBLE_ASSET_CANDIDATES');
  assert.equal(licensedSearch.requires, 'declaredIntendedUseScope');
  assert.match(licensedSearch.meaning, /unresolved evidence is UNKNOWN or review-required, never eligible/i);
  assert.match(artifactSearch.ownerDefinition.semanticOutcomeContract.unknownDisposition,
    /If authorized scope.*report denied or unknown as applicable/i);
  assert.ok(artifactSearch.ownerDefinition.errors.includes('ACCESS_DENIED'));
  assert.ok(artifactSearch.ownerDefinition.errors.includes('UNKNOWN_OUTCOME'));
  assert.match(artifactRights.then, /current authoritative per-version rights and license evidence explicitly permits the declared scope/i);
  assert.match(artifactRights.rejection, /legal clearance/i);
  assert.ok(artifactSearch.ownerDefinition.nonSuccessOutputs.UNKNOWN_OUTCOME.some(row =>
    /current authoritative rights\/license evidence cannot resolve candidate eligibility/u.test(row.when)));
});
