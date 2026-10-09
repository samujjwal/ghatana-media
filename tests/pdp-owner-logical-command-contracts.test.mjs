import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { validateOwnerClosedJsonSchema } from '../scripts/lib/pdp-owner-leaf-wire-validation.mjs';
import { validateLogicalOwnerOperationResult } from '../scripts/lib/pdp-owner-logical-operation-validation.mjs';

const require = createRequire(resolve(process.cwd(), '../ghatana-tools/package.json'));
const yaml = require('yaml');
const operations = yaml.parse(readFileSync('.product-experience/pdp-1-domain-data/operations.yaml', 'utf8'));
const records = operations.ownerDefinedOperationContracts.records;
const byId = (id) => records.find((record) => record.id === id);
const valid = (schema, value) => validateOwnerClosedJsonSchema(schema, value, schema).valid;
const refs = (record) => record.sourceRefs ?? [];
const parsedSources = new Map([['.product-experience/pdp-1-domain-data/operations.yaml', operations]]);
const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const fingerprint = (operationRef, request, tenantId, principalId) => `sha256:${createHash('sha256').update(canonicalJson({ operationRef, request, tenantId, principalId })).digest('hex')}`;

function resolvesLocalSourceRef(reference) {
  const separator = reference.indexOf('#');
  if (separator < 0) return false;
  const sourcePath = reference.slice(0, separator);
  if (!sourcePath.startsWith('.product-experience/')) return false;
  let value;
  try {
    if (!parsedSources.has(sourcePath)) parsedSources.set(sourcePath, yaml.parse(readFileSync(join(process.cwd(), sourcePath), 'utf8')));
    value = parsedSources.get(sourcePath);
  } catch { return false; }
  const fragment = reference.slice(separator + 1);
  for (const segment of fragment.split('/').filter(Boolean)) {
    if (segment.startsWith('@id=')) {
      if (!Array.isArray(value)) return false;
      value = value.find((item) => item?.id === segment.slice(4));
    } else value = value?.[segment];
    if (value === undefined || value === null) return false;
  }
  return true;
}

const commands = {
  'media.operation.project.export.v1': {
    request: { requestId: 'req-export-1', projectId: 'project-1', expectedHeadRevisionId: 'revision-4', exportProfileRef: 'profile://export/v1', purposeRef: 'purpose://archive/v1' },
    result: { outcome: 'PREPARED', requestId: 'req-export-1', projectId: 'project-1', sourceRevisionId: 'revision-4', exportDisposition: 'VERSIONED_EXPORT_ARTIFACT', exportArtifactId: 'artifact-export-1', exportVersionId: 'version-export-1', manifestRef: 'manifest://export/v1' },
    invalidResult: (value) => { delete value.sourceRevisionId; },
  },
  'media.operation.voice-model.train.v1': {
    request: { requestId: 'req-train-1', sourceVersionRefs: ['artifact://enrollment/v3'], trainingProfileRef: 'profile://voice-train/v2', purposeRef: 'purpose://voice/v1', consentRef: 'consent://subject/v4', rightsEvidenceRefs: ['rights://subject/v2'] },
    result: { outcome: 'SUCCEEDED', requestId: 'req-train-1', disposition: 'VERSIONED_VOICE_MODEL', modelArtifactId: 'voice-model-1', modelVersionId: 'version-3', sourceVersionRefs: ['artifact://enrollment/v3'], trainingProfileRef: 'profile://voice-train/v2', purposeRef: 'purpose://voice/v1', consentRef: 'consent://subject/v4', rightsEvidenceRefs: ['rights://subject/v2'] },
    invalidResult: (value) => { value.sourceVersionRefs = ['artifact://other/v1']; },
  },
  'media.operation.voice-model.convert.v1': {
    request: { requestId: 'req-convert-1', sourceModelVersionRef: 'voice-model://source/v3', targetProfileRef: 'profile://target/v2', purposeRef: 'purpose://voice/v1', consentRef: 'consent://subject/v4', rightsEvidenceRefs: ['rights://subject/v2'] },
    result: { outcome: 'SUCCEEDED', requestId: 'req-convert-1', disposition: 'VERSIONED_CONVERTED_MODEL', modelArtifactId: 'voice-model-2', modelVersionId: 'version-1', sourceModelVersionRef: 'voice-model://source/v3', targetProfileRef: 'profile://target/v2', purposeRef: 'purpose://voice/v1', consentRef: 'consent://subject/v4', rightsEvidenceRefs: ['rights://subject/v2'] },
    invalidResult: (value) => { value.sourceModelVersionRef = 'voice-model://foreign/v1'; },
  },
  'media.operation.audio-master.aggregate.v1': {
    request: { requestId: 'req-master-1', sourceAudioVersionRef: 'audio://source/v5', masteringProfileRef: 'profile://master/v1', orderedStageRefs: ['stage://eq/v1', 'stage://limit/v2'], purposeRef: 'purpose://master/v1' },
    result: { outcome: 'SUCCEEDED', requestId: 'req-master-1', disposition: 'MASTERED_AUDIO_VERSION', outputArtifactId: 'audio-master-1', outputVersionId: 'version-2', sourceAudioVersionRef: 'audio://source/v5', masteringProfileRef: 'profile://master/v1', orderedStageRefs: ['stage://eq/v1', 'stage://limit/v2'] },
    invalidResult: (value) => { value.disposition = 'NO_MEDIA_CHANGE'; },
  },
};

test('new logical CLI operations have exact closed schemas, source refs, and operation-specific effects', () => {
  for (const [id, fixture] of Object.entries(commands)) {
    const operation = byId(id);
    assert.ok(operation, `${id} exists`);
    assert.equal(operation.executionAdmission, 'NOT_ADMITTED');
    assert.equal(operation.requestSchema.additionalProperties, false);
    assert.equal(operation.resultSchema.additionalProperties, false);
    assert.ok(operation.errors?.length && operation.finality && operation.recovery && operation.requestResultBindings, `${id} defines errors, finality, recovery, and joins`);
    assert.ok(refs(operation).length, `${id} has source references`);
    for (const sourceRef of refs(operation)) assert.equal(resolvesLocalSourceRef(sourceRef), true, `${id} resolves ${sourceRef}`);
    assert.equal(valid(operation.requestSchema, fixture.request), true, id);
    assert.equal(valid(operation.resultSchema, fixture.result), true, id);
    assert.equal(validateLogicalOwnerOperationResult(id, fixture.request, fixture.result).valid, true, `${id} exact request/result binding`);
    const mutated = structuredClone(fixture.result);
    fixture.invalidResult(mutated);
    assert.equal(validateLogicalOwnerOperationResult(id, fixture.request, mutated).valid, false, `${id} rejects a contradictory or incomplete result binding`);
    const unknown = id === 'media.operation.project.export.v1'
      ? { outcome: 'UNKNOWN_OUTCOME', requestId: fixture.request.requestId, projectId: fixture.request.projectId, sourceRevisionId: fixture.request.expectedHeadRevisionId, exportDisposition: 'UNKNOWN' }
      : { outcome: 'UNKNOWN_OUTCOME', requestId: fixture.request.requestId, disposition: 'UNKNOWN' };
    assert.equal(valid(operation.resultSchema, unknown), true, `${id} allows an unresolved outcome without output`);
  }
});

test('provider diagnostics is a current read-only observation and unknown remains empty', () => {
  const operation = byId('media.operation.provider-diagnostics.inspect.v1');
  assert.equal(operation.operationKind, 'QUERY');
  assert.equal(operation.idempotency, 'NOT_APPLICABLE_READ_ONLY_QUERY');
  assert.equal(operation.executionAdmission, 'NOT_ADMITTED');
  const request = { queryId: 'query-1', providerRef: 'provider://acme', operationRef: 'media.operation.audio-master.aggregate.v1' };
  const trusted = { tenantId: 'tenant-1', principalId: 'principal-1', readAuthorityRef: 'authority://provider-diagnostics/v1', readVersion: 'read-v2', now: '2026-10-09T10:00:10.000Z' };
  const observed = {
    outcome: 'OBSERVED', operationRef: operation.id, queryId: 'query-1', requestFingerprint: fingerprint(operation.id, request, trusted.tenantId, trusted.principalId),
    tenantId: trusted.tenantId, principalId: trusted.principalId, readAuthorityRef: trusted.readAuthorityRef,
    readVersion: 'read-v2', currentness: 'CURRENT', observedAt: '2026-10-09T10:00:00.000Z',
    outputs: [{ artifactType: 'provider-diagnostic-observation', payload: { providerRef: 'provider://acme', operationRef: 'media.operation.audio-master.aggregate.v1', diagnosticStatus: 'DEGRADED', capabilityRefs: [] } }],
  };
  assert.equal(valid(operation.requestSchema, request), true);
  assert.equal(valid(operation.resultSchema, observed), true);
  assert.equal(validateLogicalOwnerOperationResult(operation.id, request, observed, trusted).valid, true);
  const rejectTrustedMutation = (mutate, message) => {
    const altered = structuredClone(observed); mutate(altered);
    assert.equal(validateLogicalOwnerOperationResult(operation.id, request, altered, trusted).valid, false, message);
  };
  rejectTrustedMutation((value) => { value.observedAt = '2020-01-01T00:00:00.000Z'; }, 'stale observations are not current');
  rejectTrustedMutation((value) => { value.observedAt = '2026-10-09T10:00:11.000Z'; }, 'future observations are not current');
  rejectTrustedMutation((value) => { value.observedAt = '2026-02-30T10:00:00.000Z'; }, 'impossible calendar dates are rejected');
  rejectTrustedMutation((value) => { value.tenantId = 'tenant-foreign'; }, 'foreign tenant is rejected');
  rejectTrustedMutation((value) => { value.readAuthorityRef = 'authority://foreign'; }, 'foreign read authority is rejected');
  rejectTrustedMutation((value) => { value.readVersion = 'read-old'; }, 'wrong read version is rejected');
  rejectTrustedMutation((value) => { value.requestFingerprint = `sha256:${'a'.repeat(64)}`; }, 'caller-shaped digest is not trusted');
  const incompleteContext = { ...trusted }; delete incompleteContext.now;
  assert.equal(validateLogicalOwnerOperationResult(operation.id, request, observed, incompleteContext).reason, 'TRUSTED_READ_CONTEXT_INCOMPLETE');
  const keyOrderRequest = { operationRef: request.operationRef, providerRef: request.providerRef, queryId: request.queryId };
  const keyOrderResult = { ...observed, requestFingerprint: fingerprint(operation.id, keyOrderRequest, trusted.tenantId, trusted.principalId) };
  assert.equal(validateLogicalOwnerOperationResult(operation.id, keyOrderRequest, keyOrderResult, trusted).valid, true, 'canonical request identity ignores object key order');
  assert.equal(valid(operation.resultSchema, { ...observed, currentness: 'STALE' }), false);
  const foreignObservation = structuredClone(observed); foreignObservation.outputs[0].payload.providerRef = 'provider://foreign';
  assert.equal(validateLogicalOwnerOperationResult(operation.id, request, foreignObservation, trusted).valid, false);
  const unknown = { ...observed, outcome: 'UNKNOWN_OBSERVATION', currentness: 'UNKNOWN', outputs: [] };
  assert.equal(valid(operation.resultSchema, unknown), true);
  assert.equal(validateLogicalOwnerOperationResult(operation.id, request, unknown, trusted).valid, true);
  assert.equal(valid(operation.resultSchema, { ...unknown, outputs: observed.outputs }), false);
});

test('inspect-project request schema closes the root and requires exactly one selector', () => {
  const operation = operations.individualOperationContracts.records.find((record) => record.id === 'media.operation-slice.inspect-project');
  const schema = operation.ownerWireSchema.requestSchema;
  assert.equal(schema.additionalProperties, false);
  assert.equal(valid(schema, { selectedAuthorizedWorkspaceId: 'workspace-1', projectId: 'project-1' }), true);
  assert.equal(valid(schema, { selectedAuthorizedWorkspaceId: 'workspace-1', creationRequestId: 'request-1' }), true);
  assert.equal(valid(schema, { selectedAuthorizedWorkspaceId: 'workspace-1', projectId: 'project-1', creationRequestId: 'request-1' }), false);
  assert.equal(valid(schema, { selectedAuthorizedWorkspaceId: 'workspace-1', projectId: 'project-1', injected: true }), false);
});
