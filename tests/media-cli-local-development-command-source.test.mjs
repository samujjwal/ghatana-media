import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { parse } = createRequire(resolve(root, '../ghatana-tools/package.json'))('yaml');
const readYaml = path => parse(readFileSync(resolve(root, path), 'utf8'));

test('four local-development CLI definitions stay separate from fixture and production populations', () => {
  const source = readYaml('.product-experience/pdp-3-product-experience/cli/local-development-command-registry.yaml');
  const crosswalk = readYaml('.product-experience/pdp-3-product-experience/cli/source-crosswalk.yaml');
  const production = readYaml('.product-experience/pdp-3-product-experience/cli/production-command-registry.yaml');
  const fixture = readYaml('.product-experience/pdp-3-product-experience/cli/command-registry.yaml');
  const parity = readYaml('.product-experience/interface-parity/operation-parity.yaml');
  const packageJson = JSON.parse(readFileSync(resolve(root, 'libs/audio-video-client/package.json'), 'utf8'));
  const cliSource = readFileSync(resolve(root, 'libs/audio-video-client/src/cli.ts'), 'utf8');
  const expectedIds = [
    'media.cli.local-development.artifact.upload',
    'media.cli.local-development.artifact.inspect',
    'media.cli.local-development.job.get',
    'media.cli.local-development.job.cancel',
  ];

  assert.deepEqual(source.commands.map(command => command.id), expectedIds);
  assert.equal(source.sourceDisposition.scope, 'explicit-local-development-source-contract-extension');
  assert.equal(source.sourceDisposition.decisionRef, '.product-experience/decision-log.md#PXD-051');
  assert.equal(source.sourceDisposition.supersedesPlanConflict, true);
  assert.match(source.sourceDisposition.clarification, /four listed local-development command identities only/u);
  assert.equal(source.sourceDisposition.productionAdmission, 'OPEN');
  assert.equal(source.executionScope.binary, 'libs/audio-video-client/package.json#bin.ghatanamedia-api-dev');
  assert.equal(source.executionScope.runtimeProfile, 'MEDIA_PROFILE-exactly-dev');
  assert.equal(source.executionScope.endpointConstraint, 'HTTP-or-HTTPS-loopback-only');
  assert.equal(source.executionScope.credentialSource, 'GHATANA_MEDIA_BEARER_TOKEN-environment-only');
  assert.equal(source.executionScope.expectedIssuer, 'urn:ghatana:media:dev-only');
  assert.equal(source.executionScope.expectedAudience, 'ghatana-media-dev');
  assert.match(source.executionScope.signatureValidation, /Media-host-verifies-HMAC/u);
  assert.equal(source.productionAdmission.status, 'OPEN');
  assert.equal(source.productionAdmission.productionIdentityCount, 1);
  assert.deepEqual(source.productionAdmission.productionIdentities, ['media.cli.artifact.inspect']);

  assert.equal(crosswalk.populations.localDevelopmentCommandDefinitions.count, 4);
  assert.equal(crosswalk.populations.localDevelopmentCommandDefinitions.entrypoint, 'libs/audio-video-client/src/cli-dev.ts');
  assert.equal(crosswalk.populations.localDevelopmentCommandDefinitions.implementation,
    'libs/audio-video-client/src/cli.ts#runLocalDevelopmentCli');
  assert.equal(crosswalk.verification.localDevelopmentSourceTest, 'tests/media-cli-local-development-command-source.test.mjs');
  assert.deepEqual(crosswalk.populations.localDevelopmentCommandDefinitions.identities.map(item => item.commandId), expectedIds);
  assert.equal(crosswalk.populations.localDevelopmentCommandDefinitions.productionAdmission, 'OPEN');
  assert.equal(production.productionCommandPopulation.count, 1);
  assert.deepEqual(production.commands.map(command => command.id), ['media.cli.artifact.inspect']);
  assert.equal(fixture.commands.length, 11);
  assert.equal(packageJson.bin['ghatanamedia-api-dev'], './dist/cli-dev.js');

  const localDispatch = cliSource.match(/const LOCAL_DEVELOPMENT_COMMAND_IDS: Readonly<Record<string, string>> = \{([\s\S]*?)\n\};/u);
  assert.ok(localDispatch, 'local-development identities are implemented in the documented dispatcher');
  assert.deepEqual(
    [...localDispatch[1].matchAll(/'([^']+)': '([^']+)'/gu)].map(([, command, identity]) => `${command}:${identity}`),
    [
      'artifact upload:media.cli.local-development.artifact.upload',
      'artifact inspect:media.cli.local-development.artifact.inspect',
      'job get:media.cli.local-development.job.get',
      'job cancel:media.cli.local-development.job.cancel',
    ],
  );
  const productionDispatch = cliSource.match(/const PRODUCTION_COMMAND_IDS: Readonly<Record<string, string>> = \{([\s\S]*?)\n\};/u);
  assert.ok(productionDispatch, 'production command identities remain separately declared');
  assert.deepEqual(
    [...productionDispatch[1].matchAll(/'([^']+)': '([^']+)'/gu)].map(([, command, identity]) => `${command}:${identity}`),
    ['artifact inspect:media.cli.artifact.inspect'],
  );

  const localParity = parity.surfaces.find(surface => surface.surface === 'CLI local-development command definitions');
  const productionParity = parity.surfaces.find(surface => surface.surface === 'CLI host-configured runtime consumers');
  assert.equal(localParity.denominator, 4);
  assert.deepEqual(localParity.identities, expectedIds);
  assert.deepEqual(productionParity.identities, ['media.cli.artifact.inspect']);
  assert.equal(localParity.productionAdmission, 'OPEN');
});

test('local-dev bindings are exact and cancellation stays isolated from production admission', () => {
  const source = readYaml('.product-experience/pdp-3-product-experience/cli/local-development-command-registry.yaml');
  const crosswalk = readYaml('.product-experience/pdp-3-product-experience/cli/source-crosswalk.yaml');
  const production = readYaml('.product-experience/pdp-3-product-experience/cli/production-command-registry.yaml');
  const operations = readYaml('.product-experience/pdp-1-domain-data/operations.yaml');
  const openapi = readYaml('contracts/openapi/media.yaml');
  const rows = operations.individualOperationContracts.records;
  const operationRows = new Map(rows.map(row => [row.id, row]));
  const getOperation = operationId => Object.values(openapi.paths)
    .flatMap(item => Object.values(item))
    .find(operation => operation?.operationId === operationId);
  const ownerOperation = id => rows.find(item => item.id === id);

  const routeIds = {
    beginMediaUpload: ['POST', '/api/v1/artifacts/uploads'],
    getMediaUpload: ['GET', '/api/v1/artifacts/uploads/{uploadId}'],
    appendMediaChunk: ['PUT', '/api/v1/artifacts/uploads/{uploadId}/chunks/{chunkIndex}'],
    completeMediaUpload: ['POST', '/api/v1/artifacts/uploads/{uploadId}/complete'],
    getMediaArtifact: ['GET', '/api/v1/artifacts/{artifactId}'],
    getMediaJob: ['GET', '/api/v1/jobs/{jobId}'],
    cancelMediaJob: ['POST', '/api/v1/jobs/{jobId}/cancel'],
  };
  for (const [operationId, [method, route]] of Object.entries(routeIds)) {
    const operation = getOperation(operationId);
    assert.ok(operation, `${operationId} exists in OpenAPI`);
    assert.equal(openapi.paths[route][method.toLowerCase()].operationId, operationId);
  }

  for (const command of source.commands.filter(item => !item.id.endsWith('.job.cancel'))) {
    for (const [index, operationRef] of command.operationRefs.entries()) {
      const row = operationRows.get(operationRef);
      assert.ok(row, `${command.id} references current owner operation ${operationRef}`);
      assert.equal(row.sourceOperation, command.httpOperations[index], `${command.id} operation order is exact`);
    }
  }

  const upload = source.commands.find(item => item.id.endsWith('.artifact.upload'));
  assert.deepEqual(upload.operationRefs, [
    'media.operation-slice.begin-upload',
    'media.operation-slice.inspect-upload',
    'media.operation-slice.append-upload-chunk',
    'media.operation-slice.complete-upload',
  ]);
  assert.deepEqual(upload.httpOperations, ['beginMediaUpload', 'getMediaUpload', 'appendMediaChunk', 'completeMediaUpload']);
  assert.match(upload.unknownOutcome, /no-blind-retry/u);

  const inspect = source.commands.find(item => item.id.endsWith('.artifact.inspect'));
  assert.deepEqual(inspect.operationRefs, ['media.operation-slice.inspect-artifact']);
  assert.deepEqual(inspect.httpOperations, ['getMediaArtifact']);

  const jobRead = source.commands.find(item => item.id.endsWith('.job.get'));
  assert.deepEqual(jobRead.operationRefs, ['media.operation-slice.inspect-job']);
  assert.deepEqual(jobRead.httpOperations, ['getMediaJob']);
  assert.match(jobRead.outcome, /not-a-provider-finality-receipt/u);

  const cancel = source.commands.find(item => item.id.endsWith('.job.cancel'));
  const ownerCancel = ownerOperation('media.operation-slice.cancel-job');
  const openApiCancel = getOperation('cancelMediaJob');
  assert.equal(cancel.operationRefCandidate, 'media.operation-slice.cancel-job');
  assert.equal(cancel.observedHostRoute, 'POST-/dev/v1/jobs/{jobId}/cancel');
  assert.equal(cancel.runtimeBinding, 'EXISTING_DEV_ONLY_LOOPBACK_HTTP_OPERATION');
  assert.equal(cancel.wireContract, 'media.dev.job-cancellation-result.v1');
  assert.match(cancel.semantics.join(' '), /durably-reserve-request-before-provider-cancel/u);
  assert.match(cancel.semantics.join(' '), /same-request-replay-never-redispatches/u);
  assert.match(cancel.semantics.join(' '), /cancellation-requested-is-not-provider-finality/u);
  assert.equal(cancel.productionAdmission, 'OPEN');
  const crosswalkCancel = crosswalk.populations.localDevelopmentCommandDefinitions.identities
    .find(item => item.commandId === cancel.id);
  assert.equal(crosswalkCancel.operationRefCandidate, 'media.operation-slice.cancel-job');
  assert.equal(crosswalkCancel.observedHostRoute, 'POST-/dev/v1/jobs/{jobId}/cancel');
  assert.equal(crosswalkCancel.runtimeBinding, 'EXISTING_DEV_ONLY_LOOPBACK_HTTP_OPERATION');
  assert.equal(crosswalkCancel.wireContract, 'media.dev.job-cancellation-result.v1');
  assert.match(crosswalkCancel.semantics, /durable-request-reservation/u);
  assert.match(crosswalkCancel.semantics, /multimodal-child-finality-preserved/u);
  assert.equal(crosswalkCancel.productionAdmission, 'OPEN');
  assert.ok(!openapi.paths['/dev/v1/jobs/{jobId}/cancel'], 'DEV_ONLY cancellation stays outside canonical OpenAPI');
  assert.ok(ownerCancel.ownerDefinition.requestSchema.required.includes('requestId'));
  // Canonical production cancellation remains bodyless and outside the inspect-only CLI registry.
  assert.equal(openApiCancel.requestBody, undefined);
  assert.equal(openApiCancel['x-ghatana-idempotency'].required, false);
  assert.equal(ownerCancel.status, 'proposed-local-source-contract');
  assert.match(ownerCancel.ownerDefinition.scopeStatus, /runtime-NOT_ADMITTED/u);
  assert.ok(ownerCancel.ownerDefinition.requestSchema.required.includes('requestId'));
  assert.ok(ownerCancel.ownerDefinition.requestSchema.properties.expectedJobVersion);
  assert.ok(ownerCancel.ownerDefinition.requestSchema.properties.reason);
  assert.deepEqual(ownerCancel.ownerDefinition.resultSchema.fields, [
    'jobId', 'requestId', 'cancellationRequestId', 'currentJobState', 'currentAttemptStates', 'observedAt',
  ]);
  assert.match(ownerCancel.ownerDefinition.authority, /current-trusted-principal-and-current-job-cancel-policy/u);
  assert.match(ownerCancel.ownerDefinition.guards.join(' '), /current-attempt-and-dispatch-evidence/u);
  assert.match(ownerCancel.ownerDefinition.childCancellationRule.scopeStatus, /fan-out execution.*NOT_EVALUATED/u);
  assert.equal(production.productionCommandPopulation.count, 1);
  assert.deepEqual(production.commands.map(command => command.id), ['media.cli.artifact.inspect']);
  assert.equal(source.productionAdmission.status, 'OPEN');
});
