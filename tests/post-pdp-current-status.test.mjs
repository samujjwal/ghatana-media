import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const status = JSON.parse(fs.readFileSync(path.join(root, 'docs/implementation/post-pdp-current-status.json'), 'utf8'));
const gapSource = fs.readFileSync(path.join(root, '.product-experience/gaps.yaml'), 'utf8');
const gapView = fs.readFileSync(path.join(root, '.product-experience/gap-current-status.yaml'), 'utf8');

test('current status keeps development, acceptance, runtime, Lifecycle and release dimensions separate', () => {
  assert.equal(status.phaseDevelopment.status, 'DEV_COMPLETE');
  assert.deepEqual(status.phaseDevelopment.phases.map(p => p.phase), ['PDP-0','PDP-1','PDP-2','PDP-3']);
  for (const key of ['independentAccepted','runtimeQualified','LifecycleReceiptCurrent','releaseReady']) {
    assert.equal(typeof status.readinessDimensions[key].claim, 'boolean');
  }
  assert.equal(status.readinessDimensions.independentAccepted.claim, false);
  assert.equal(status.readinessDimensions.runtimeQualified.claim, false);
  assert.equal(status.readinessDimensions.LifecycleReceiptCurrent.status, 'NOT_RECORDED');
  assert.equal(status.readinessDimensions.releaseReady.status, 'NOT_AUTHORIZED');
  assert.equal(status.historicalVerification.reportedFullSuite.independentlyReproducedInThisStatusProjection, false);
  assert.equal(status.historicalVerification.reportedFullSuite.skips, 0);
  assert.equal(status.historicalVerification.historicalPdp0FocusedSkipCount, 10);
});
test('dated gap view classifies every gap identity exactly once', () => {
  const sourceIds = [...gapSource.matchAll(/^\s*- id: (\S+)/gm)].map(match => match[1]);
  const viewIds = [...gapView.matchAll(/^\s+- \{ id: ([^,]+), classification: ([^,]+)/gm)].map(match => ({id:match[1], classification:match[2]}));
  assert.equal(sourceIds.length, 27);
  assert.equal(viewIds.length, sourceIds.length);
  assert.deepEqual([...new Set(viewIds.map(item=>item.id))].sort(), [...sourceIds].sort());
  const allowed = new Set(['DEFINITION_COMPLETE_BUT_ACCEPTANCE_PENDING','IMPLEMENTATION_OPEN','MIGRATION_OPEN','OWNER_EXTERNAL','HISTORICAL_SNAPSHOT','ACTUAL_NEW_DEFECT']);
  assert.ok(viewIds.every(item=>allowed.has(item.classification)));
});
