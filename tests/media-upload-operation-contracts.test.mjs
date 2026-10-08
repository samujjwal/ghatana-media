import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const { parse } = createRequire(resolve(root, '../ghatana-tools/package.json'))('yaml');
const read = path => readFileSync(resolve(root, path), 'utf8');

function fixture() {
  const operations = parse(read('.product-experience/pdp-1-domain-data/operations.yaml'));
  const openapi = parse(read('contracts/openapi/media.yaml'));
  return {
    operations: operations.individualOperationContracts.records,
    openapi: openapi.paths,
    runtime: read('runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaUploadRequestFingerprint.java'),
    sdk: read('libs/audio-video-client/src/operations.ts'),
  };
}

function validate(f) {
  const errors = [];
  const get = suffix => f.operations.find(record => record.id === `media.operation-slice.${suffix}`);
  const begin = get('begin-upload');
  const append = get('append-upload-chunk');
  const complete = get('complete-upload');
  if (![begin, append, complete].every(Boolean)) return ['the three existing upload operations must remain individually bound'];
  for (const record of [begin, append, complete]) {
    if (record.contractVersion !== 1) errors.push(`${record.id}: version 1 is required`);
    if (record.ownerSemantics?.reviewStatus !== 'media-owner-accepted-bounded-definition; implementation-and-independent-qualification-open' || record.ownerDecisionRef !== '.product-experience/decision-log.md#PXD-046' || record.runtimeAdmission !== 'NOT_ADMITTED') {
      errors.push(`${record.id}: bounded owner definition must retain its exact decision and unadmitted runtime boundary`);
    }
    if (!record.ownerSemantics?.authority?.tenantAndPrincipal?.includes('trusted-host-authentication-context')) {
      errors.push(`${record.id}: tenant/principal fields cannot assert trusted identity`);
    }
    if (!record.ownerSemantics?.authority?.rightsAndConsent?.includes('does-not-grant')) {
      errors.push(`${record.id}: upload/artifact cannot grant rights or consent`);
    }
  }
  const beginWire = f.openapi['/api/v1/artifacts/uploads']?.post;
  const appendWire = f.openapi['/api/v1/artifacts/uploads/{uploadId}/chunks/{chunkIndex}']?.put;
  const completeWire = f.openapi['/api/v1/artifacts/uploads/{uploadId}/complete']?.post;
  if (beginWire?.operationId !== begin.sourceOperation) errors.push('begin-upload OpenAPI identity changed');
  if (appendWire?.operationId !== append.sourceOperation) errors.push('append-upload OpenAPI identity changed');
  if (completeWire?.operationId !== complete.sourceOperation) errors.push('complete-upload OpenAPI identity changed');
  if (begin.ownerSemantics.replay?.keyScope?.join('|') !== 'tenantId|principalId|idempotencyKey') errors.push('begin replay scope must include tenant, principal, and key');
  if (begin.ownerSemantics.replay?.requestBinding !== 'canonical-full-upload-request-v1') errors.push('begin replay must bind the full request');
  if (!f.runtime.includes('media.upload-request-fingerprint.v1') || !f.runtime.includes('request.metadata()')) errors.push('full request fingerprint source binding is missing');
  if (!append.ownerSemantics.unknownOutcome?.automaticReplay?.includes('prohibited')) errors.push('append must prohibit automatic replay after unknown outcome');
  if (!f.sdk.includes('chunkIndex !== current.nextChunkIndex') || !f.sdk.includes('nextChunkIndex !== chunkIndex + 1')) errors.push('SDK no longer enforces contiguous chunk acknowledgement');
  if (completeWire?.parameters?.some(parameter => parameter.name === 'Idempotency-Key')) errors.push('bodyless completion must not be described as a request-key operation');
  if (!complete.ownerSemantics.completionReplay?.payloadHashIdempotency?.includes('not-a-valid-description')) errors.push('completion payload-hash declaration contradiction must remain explicit');
  if (complete.ownerSemantics.completionReplay?.completedUpload !== 'return-the-original-artifact-identity-and-immutable-content-observation') errors.push('completion replay must preserve the original artifact identity');
  return errors;
}

test('three existing upload operations bind source identities to bounded version-1 owner definitions', () => {
  assert.deepEqual(validate(fixture()), []);
});

test('upload operation contracts reject false replay, finality, authority, and acceptance claims', () => {
  const mutations = [
    f => { f.operations.find(r => r.id.endsWith('.begin-upload')).ownerSemantics.replay.keyScope = ['tenantId', 'idempotencyKey']; },
    f => { f.operations.find(r => r.id.endsWith('.begin-upload')).ownerSemantics.replay.requestBinding = 'partial-upload-request-v1'; },
    f => { f.operations.find(r => r.id.endsWith('.append-upload-chunk')).ownerSemantics.unknownOutcome.automaticReplay = 'safe'; },
    f => { f.operations.find(r => r.id.endsWith('.complete-upload')).ownerSemantics.completionReplay.completedUpload = 'new-artifact-per-call'; },
    f => { f.operations.find(r => r.id.endsWith('.complete-upload')).ownerSemantics.completionReplay.payloadHashIdempotency = 'accepted'; },
    f => { f.operations.find(r => r.id.endsWith('.complete-upload')).ownerSemantics.reviewStatus = 'accepted'; },
    f => { f.operations.find(r => r.id.endsWith('.append-upload-chunk')).ownerSemantics.authority.rightsAndConsent = 'upload-grants-rights'; },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    assert.ok(validate(f).length > 0);
  }
});

test('source identity drift or invented completion key is not silently accepted as parity', () => {
  const f = fixture();
  f.openapi['/api/v1/artifacts/uploads/{uploadId}/complete'].post.operationId = 'completeByRequestKey';
  assert.ok(validate(f).some(error => error.includes('complete-upload OpenAPI identity')));
  const keyed = fixture();
  keyed.openapi['/api/v1/artifacts/uploads/{uploadId}/complete'].post.parameters.push({ name: 'Idempotency-Key' });
  assert.ok(validate(keyed).some(error => error.includes('bodyless completion')));
});
