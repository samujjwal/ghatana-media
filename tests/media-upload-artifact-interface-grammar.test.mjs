import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const { parse } = createRequire(resolve(root, '../ghatana-tools/package.json'))('yaml');
const yaml = path => parse(readFileSync(resolve(root, path), 'utf8'));
const text = path => readFileSync(resolve(root, path), 'utf8');

const expectedHttp = {
  beginMediaUpload: ['media.operation-slice.begin-upload', 'media.http.beginMediaUpload', 'POST', '/api/v1/artifacts/uploads'],
  getMediaUpload: ['media.operation-slice.inspect-upload', 'media.http.getMediaUpload', 'GET', '/api/v1/artifacts/uploads/{uploadId}'],
  appendMediaChunk: ['media.operation-slice.append-upload-chunk', 'media.http.appendMediaChunk', 'PUT', '/api/v1/artifacts/uploads/{uploadId}/chunks/{chunkIndex}'],
  completeMediaUpload: ['media.operation-slice.complete-upload', 'media.http.completeMediaUpload', 'POST', '/api/v1/artifacts/uploads/{uploadId}/complete'],
  getMediaArtifact: ['media.operation-slice.inspect-artifact', 'media.http.getMediaArtifact', 'GET', '/api/v1/artifacts/{artifactId}'],
};

test('HTTP upload/artifact contracts map each existing route to its exact bounded PDP-1 slice', () => {
  const api = yaml('.product-experience/pdp-3-product-experience/api/api-registry.yaml');
  const openapi = yaml('contracts/openapi/media.yaml');
  const records = yaml('.product-experience/pdp-1-domain-data/operations.yaml').individualOperationContracts.records;
  for (const [operationId, [logicalRef, registryId, method, path]] of Object.entries(expectedHttp)) {
    const http = api.operations.find(item => item.id === registryId);
    const contract = yaml(`.product-experience/pdp-3-product-experience/api/operations/${operationId}.yaml`);
    const operation = openapi.paths[path]?.[method.toLowerCase()];
    const logical = records.find(item => item.id === logicalRef);
    assert.ok(http, `${registryId} remains an existing HTTP identity`);
    assert.equal(http.operationId, operationId);
    assert.equal(http.method, method);
    assert.equal(http.path, path);
    assert.equal(http.pdp1OperationRef, logicalRef);
    assert.equal(contract.pdp1SemanticBinding.logicalOperationRef, logicalRef);
    assert.equal(contract.ownerDecisionRef ?? contract.pdp1SemanticBinding.ownerDecisionRef, '.product-experience/decision-log.md#PXD-051');
    assert.equal(contract.interfaceDefinition.runtimeAdmission, 'NOT_ADMITTED');
    assert.equal(contract.protocolIdentity.path, path);
    assert.equal(contract.protocolIdentity.method, method);
    assert.equal(operation.operationId, operationId);
    assert.equal(logical.sourceOperation, operationId);
    assert.equal(logical.wireBinding.method, method);
    assert.equal(logical.sourceRef, `contracts/openapi/media.yaml#/paths/${path.replaceAll('/', '~1')}/${method.toLowerCase()}`);
  }
  const begin = yaml('.product-experience/pdp-3-product-experience/api/operations/beginMediaUpload.yaml');
  assert.deepEqual(begin.parameters.refs, ['#/components/parameters/TenantHeader', '#/components/parameters/PrincipalHeader', '#/components/parameters/IdempotencyKeyHeader']);
  const append = yaml('.product-experience/pdp-3-product-experience/api/operations/appendMediaChunk.yaml');
  assert.match(append.interfaceDefinition.unknownOutcome, /automatic-replay-prohibited/u);
  assert.match(append.interfaceDefinition.request.body, /raw-application-octet-stream/u);
  const complete = yaml('.product-experience/pdp-3-product-experience/api/operations/completeMediaUpload.yaml');
  assert.equal(complete.interfaceDefinition.request.body, 'absent');
  assert.equal(complete.interfaceDefinition.request.requestIdempotencyKey, 'absent');
  assert.match(complete.interfaceDefinition.finality, /T02 verification evidence is a separate unimplemented\/unbound transition/u);
  const artifact = yaml('.product-experience/pdp-3-product-experience/api/operations/getMediaArtifact.yaml');
  assert.match(artifact.interfaceDefinition.result, /does-not-include-canonical-artifact-versionId/u);
  assert.match(artifact.interfaceDefinition.finality, /not-byte-access/u);
});

test('SDK methods preserve the guarded workflow without inventing a resume method or versioned wire alias', () => {
  const registry = yaml('.product-experience/pdp-3-product-experience/sdk/operation-registry.yaml');
  const methods = new Map(registry.methods.map(method => [method.id, method]));
  const bindings = {
    'media.sdk.createUploadSession': ['media.operation-slice.begin-upload', 'beginMediaUpload'],
    'media.sdk.getUploadSession': ['media.operation-slice.inspect-upload', 'getMediaUpload'],
    'media.sdk.uploadPart': ['media.operation-slice.append-upload-chunk', 'appendMediaChunk'],
    'media.sdk.completeUploadSession': ['media.operation-slice.complete-upload', 'completeMediaUpload'],
    'media.sdk.getArtifact': ['media.operation-slice.inspect-artifact', 'getMediaArtifact'],
  };
  for (const [id, [operationRef, httpOperationId]] of Object.entries(bindings)) {
    const binding = methods.get(id)?.boundedInterfaceDefinition;
    assert.equal(binding.operationRef, operationRef);
    assert.equal(binding.httpOperationId, httpOperationId);
    assert.equal(binding.decisionRef, '.product-experience/decision-log.md#PXD-051');
    assert.match(binding.status, /runtimeAdmission-NOT_ADMITTED/u);
  }
  const grammar = yaml('.product-experience/pdp-2-design-interface-system/action-finality-grammar.yaml').boundedUploadArtifactSlice;
  const resume = grammar.actions['media.action.resume-artifact-upload'];
  assert.deepEqual(resume.orderedOperationRefs, [
    'media.operation-slice.inspect-upload', 'media.operation-slice.append-upload-chunk', 'media.operation-slice.complete-upload',
  ]);
  assert.match(resume.prerequisites, /explicit-user-confirmation/u);
  assert.match(resume.unknownOutcome, /no-automatic-append/u);
  assert.equal(resume.kind, 'compound-user-confirmed-workflow; not-a-single-operation-or-route');
  assert.equal(methods.get('media.sdk.getArtifact').boundedInterfaceDefinition.success.includes('versionId'), true);
  assert.equal(methods.get('media.sdk.completeUploadSession').boundedInterfaceDefinition.legacyIdOverload.includes('cannot-bind'), true);
  assert.equal(methods.has('media.sdk.resumeUpload'), false);
});

test('CLI and Agent Tool populations are not inflated to imply unsupported upload interfaces', () => {
  const cli = yaml('.product-experience/pdp-3-product-experience/cli/production-command-registry.yaml');
  const crosswalk = yaml('.product-experience/pdp-3-product-experience/cli/source-crosswalk.yaml');
  assert.equal(cli.productionCommandPopulation.count, 1);
  assert.equal(cli.commands[0].id, 'media.cli.artifact.inspect');
  assert.ok(cli.commands[0].operationRef.endsWith('#/individualOperationContracts/records/media.operation-slice.inspect-artifact'));
  assert.deepEqual(cli.commands[0].interactionDefinition.missingCommands, ['begin-upload', 'append-upload-chunk', 'complete-upload', 'inspect-upload-session', 'compound-resume']);
  assert.equal(crosswalk.populations.hostConfiguredRuntimeConsumers.count, 1);
  assert.equal(crosswalk.populations.explorerFixtureCommands.count, 11);
  assert.match(cli.commands[0].interactionDefinition.unknownOutcome, /no-domain-mutation-to-replay/u);

  const tools = yaml('.product-experience/pdp-3-product-experience/agent-tools/tool-registry.yaml');
  const toolGrammar = yaml('.product-experience/pdp-2-design-interface-system/agent-tools/conventions.yaml').mediaUploadArtifactSlice;
  assert.deepEqual(tools.tools.map(tool => tool.id), ['av.speech-to-text', 'av.text-to-speech', 'av.vision-analysis', 'av.multimodal-inference']);
  assert.deepEqual(toolGrammar.matchingToolIds, []);
  assert.deepEqual(toolGrammar.operationRefs, []);
  assert.equal(toolGrammar.runtimeAdmission, 'NOT_ADMITTED');
  assert.match(toolGrammar.prohibitedInference, /analysis-tool-does-not-bind/u);
});

test('source parity separately records bounded command bindings and keeps global parity unaccepted', () => {
  const parity = yaml('.product-experience/interface-parity/operation-parity.yaml');
  const sdkSurface = parity.surfaces.find(surface => surface.surface === 'SDK registry');
  const httpSurface = parity.surfaces.find(surface => surface.surface === 'HTTP');
  assert.deepEqual(sdkSurface.boundedCanonicalOperations.sort(), ['media.sdk.completeUploadSession', 'media.sdk.createUploadSession', 'media.sdk.uploadPart']);
  assert.equal(sdkSurface.dispositionCounts.boundedCanonicalOperation, 3);
  assert.equal(httpSurface.boundedDefinitionBindings.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(httpSurface.dispositionCounts.boundedDefinition, 5);
  assert.match(httpSurface.boundedDefinitionBindings.boundary, /not-production-route-qualification-or-full-cross-interface-parity/u);
  assert.equal(parity.status, 'source-inventory-reconciliation; no-cross-interface-bindings-owner-accepted');
  assert.match(text('.product-experience/pdp-2-design-interface-system/action-finality-grammar.yaml'), /phaseAdmission: pending-independent-PDP2-review/u);
});
