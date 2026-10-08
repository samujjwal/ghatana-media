import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { validateCanonicalMediaReads } from '../scripts/lib/media-canonical-read-contracts.mjs';
const root = resolve(new URL('..', import.meta.url).pathname);
const { parse } = createRequire(resolve(root, '../ghatana-tools/package.json'))('yaml');
const read = path => readFileSync(resolve(root, path), 'utf8');
const fixture = () => ({
  operations: parse(read('.product-experience/pdp-1-domain-data/operations.yaml')),
  openapi: parse(read('contracts/openapi/media.yaml')),
  runtimeSource: read('launcher/src/main/java/com/ghatana/media/launcher/MediaRuntime.java'),
  handlerSource: read('launcher/src/main/java/com/ghatana/media/launcher/MediaHttpHandler.java'),
});
test('exact upload/artifact/job queries retain owner-scoped authority and actual handler guards', () => {
  assert.deepEqual(validateCanonicalMediaReads(fixture()), []);
});
test('family approval cannot bypass per-operation review, context or finality', () => {
  for (const mutate of [
    f => { f.operations.individualOperationContracts.records.find(r => r.id.endsWith('.inspect-artifact')).ownerDecisionRef = ''; },
    f => { f.operations.individualOperationContracts.records.find(r => r.id.endsWith('.inspect-job')).requestFields = ['tenantId', 'jobId']; },
    f => { f.operations.individualOperationContracts.records.find(r => r.id.endsWith('.inspect-upload')).readSemantics.mutatesDomainState = true; },
    f => { f.operations.individualOperationContracts.records.find(r => r.id.endsWith('.inspect-job')).executionAdmission = 'AVAILABLE'; },
  ]) {
    const f = fixture();
    f.operations.scopeStatus = 'accepted';
    mutate(f);
    assert.ok(validateCanonicalMediaReads(f).length > 0);
  }
});
test('renamed route, missing principal guard and leaked absence each reject the exact source binding', () => {
  const wire = fixture(); wire.openapi.paths['/api/v1/jobs/{jobId}'].get.operationId = 'renamed';
  assert.ok(validateCanonicalMediaReads(wire).some(x => x.includes('OpenAPI')));
  const guard = fixture(); guard.runtimeSource = guard.runtimeSource.replaceAll('.principalId().equals(principalId)', '.principalId().equals("other")');
  assert.equal(validateCanonicalMediaReads(guard).filter(x => x.includes('runtime guard')).length, 3);
  const handler = fixture(); handler.handlerSource = handler.handlerSource.replace('runtime.artifact(tenantId, principalId, artifactId)', 'runtime.artifact(tenantId, artifactId)');
  assert.ok(validateCanonicalMediaReads(handler).some(x => x.includes('handler scope')));
  const finality = fixture(); finality.operations.individualOperationContracts.records.find(r => r.id.endsWith('.inspect-job')).readSemantics.noResultMeaning = 'no-external-effect';
  assert.ok(validateCanonicalMediaReads(finality).some(x => x.includes('absence')));
});
