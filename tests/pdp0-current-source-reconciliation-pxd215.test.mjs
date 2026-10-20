import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactPath = 'docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd215.json';
const crosswalkPath = 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json';
test('PXD-215 remains an immutable, non-acceptance source-cut record', () => {
  const artifact = JSON.parse(fs.readFileSync(path.join(root, artifactPath), 'utf8'));
  const crosswalk = JSON.parse(fs.readFileSync(path.join(root, crosswalkPath), 'utf8'));
  assert.equal(artifact.decisionRef, '.product-experience/decision-log.md#PXD-215');
  assert.equal(artifact.phaseScope, 'PDP-0');
  assert.equal(artifact.authority.ownerApproval, 'NOT_CLAIMED');
  assert.equal(artifact.authority.independentAcceptance, 'NOT_CLAIMED');
  assert.equal(artifact.authority.acceptanceEffect, 'none');
  assert.equal(artifact.authority.implementation, 'NOT_CLAIMED');
  assert.equal(artifact.authority.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(artifact.authority.qualification, 'NOT_EVALUATED');
  assert.equal(artifact.authority.closure, 'NOT_CLAIMED');
  assert.equal(artifact.authority.delivery, 'NOT_CLAIMED');

  for (const pins of [artifact.sourceFingerprints, artifact.phaseScopedSourceFingerprintsSha256]) {
    assert.ok(Object.keys(pins).length > 0);
    for (const [sourceRef, sha256] of Object.entries(pins)) {
      assert.ok(sourceRef);
      assert.match(sha256, /^[a-f0-9]{64}$/u, `${sourceRef} retains a complete historical digest`);
    }
  }
  const retained = crosswalk.coordinatorReview.reviewHistory.find(row => row.decisionRef === 'PXD-215');
  assert.ok(retained, 'the current crosswalk preserves PXD-215 as a historical review');
  assert.deepEqual(retained.phaseScopedSourceFingerprintsSha256, artifact.phaseScopedSourceFingerprintsSha256);
  assert.equal(retained.ownerApproval, 'NOT_CLAIMED');
  assert.equal(retained.acceptanceEffect, 'none');
});
