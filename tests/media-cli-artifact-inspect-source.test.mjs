import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const { parse } = createRequire(resolve(root, '../ghatana-tools/package.json'))('yaml');
const readYaml = path => parse(readFileSync(resolve(root, path), 'utf8'));

test('one installed CLI identity maps to the accepted scoped artifact query without merging fixture populations', () => {
  const fixture = readYaml('.product-experience/pdp-3-product-experience/cli/command-registry.yaml');
  const proposals = readYaml('.product-experience/pdp-3-product-experience/cli-command-registry.yaml');
  const registry = readYaml('.product-experience/pdp-3-product-experience/cli/production-command-registry.yaml');
  const crosswalk = readYaml('.product-experience/pdp-3-product-experience/cli/source-crosswalk.yaml');
  const operations = readYaml('.product-experience/pdp-1-domain-data/operations.yaml');
  const openapi = readYaml('contracts/openapi/media.yaml');
  const parity = readYaml('.product-experience/interface-parity/operation-parity.yaml');
  const pkg = JSON.parse(readFileSync(resolve(root, 'libs/audio-video-client/package.json'), 'utf8'));
  const command = registry.commands.find(item => item.id === 'media.cli.artifact.inspect');
  const artifactRead = operations.individualOperationContracts.records.find(item => item.id === 'media.operation-slice.inspect-artifact');
  assert.equal(fixture.commands.length, 11);
  assert.equal(proposals.commands.length, 12);
  assert.ok(proposals.commands.some(item => item.id === 'media.cli.upload.inspect'));
  assert.ok(!proposals.commands.some(item => item.id === command.id), 'the installed artifact-inspect ID is distinct from the proposed upload-inspect ID');
  assert.equal(crosswalk.populations.unresolvedHistoricalAndProposedIdentities.reconciliation,
    'all-12-identities-remain-individually-unresolved; the-new-host-configured-query-does-not-close-or-alias-any-historical-entry');
  assert.equal(crosswalk.populations.unresolvedHistoricalAndProposedIdentities.nonEquivalentNearbyIdentity.commandId,
    'media.cli.upload.inspect');
  assert.match(crosswalk.populations.unresolvedHistoricalAndProposedIdentities.nonEquivalentNearbyIdentity.distinction,
    /upload-session-inspection-is-not-artifact-identity-inspection/u);
  assert.equal(registry.fixturePopulation.count, 11);
  assert.equal(registry.productionCommandPopulation.count, 1);
  assert.equal(registry.commands.length, 1);
  assert.equal(command.canonicalCommand, 'ghatanamedia-api artifact inspect');
  assert.equal(pkg.bin['ghatanamedia-api'], './dist/cli.js');
  assert.equal(command.operationRef.endsWith('media.operation-slice.inspect-artifact'), true);
  assert.equal(artifactRead.sourceOperation, 'getMediaArtifact');
  assert.equal(artifactRead.wireBinding.operationId, openapi.paths['/api/v1/artifacts/{artifactId}'].get.operationId);
  assert.equal(artifactRead.wireBinding.method, 'GET');
  assert.equal(artifactRead.wireBinding.successStatus, 200);
  assert.equal(artifactRead.wireBinding.absentOrInaccessibleCode, 'ARTIFACT_NOT_FOUND');
  assert.equal(artifactRead.ownerDecisionRef, '.product-experience/decision-log.md#PXD-040');
  assert.equal(command.ownerDecisionRefs.includes('.product-experience/decision-log.md#PXD-044'), true);
  assert.equal(crosswalk.populations.explorerFixtureCommands.count, 11);
  assert.equal(crosswalk.populations.hostConfiguredRuntimeConsumers.count, 1);
  assert.equal(crosswalk.populations.unresolvedHistoricalAndProposedIdentities.sourcePopulation, 12);
  const parityFixture = parity.surfaces.find(item => item.surface === 'CLI fixture commands');
  const parityRuntime = parity.surfaces.find(item => item.surface === 'CLI host-configured runtime consumers');
  assert.equal(parityFixture.denominator, 11);
  assert.deepEqual(parityRuntime.identities, ['media.cli.artifact.inspect']);
  assert.equal(parityRuntime.denominator, 1);
  assert.equal(parityRuntime.exactBindings[0].httpOperationId, 'getMediaArtifact');
  assert.equal(parityRuntime.exactBindings[0].operationRef, 'media.operation-slice.inspect-artifact');
  assert.match(parityRuntime.qualification, /production-qualification-open/u);
  assert.match(command.credentialSource, /environment-only/u);
  assert.match(registry.status, /production-host-qualification-open/u);
});

test('source crosswalk rejects claims that the fixture CLI is production or that unrelated identities are resolved', () => {
  const crosswalk = readYaml('.product-experience/pdp-3-product-experience/cli/source-crosswalk.yaml');
  const fixture = readYaml('.product-experience/pdp-3-product-experience/cli/command-registry.yaml');
  assert.equal(fixture.sourcePopulation.productionCommandCount, 0);
  assert.equal(fixture.sourcePopulation.admission, 'not-a-production-cli-contract; canonical-production-cli-design-pending');
  assert.equal(crosswalk.identityRule, 'matching-command-words-do-not-establish-operation-or-runtime-parity');
  assert.match(crosswalk.populations.unresolvedHistoricalAndProposedIdentities.reconciliation, /individually-unresolved/u);
  assert.match(crosswalk.populations.hostConfiguredRuntimeConsumers.identities[0].productionHost, /no-host-is-qualified/u);
  assert.match(crosswalk.populations.hostConfiguredRuntimeConsumers.identities[0].admission, /PXD-040-and-PXD-044-only/u);
});
