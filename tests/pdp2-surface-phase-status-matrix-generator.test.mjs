import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  buildPdp2SurfaceMatrix,
  PDP2_MATRIX_PATH,
  PDP2_STATUS_PATH,
  PDP1_STATUS_PATH,
} from '../scripts/generate-media-pdp2-surface-phase-status-matrix.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));

test('PDP-2 matrix binds the exact 54-surface denominator and source-current native status', () => {
  const status = readJson(PDP2_STATUS_PATH);
  const previousMatrix = readJson(PDP2_MATRIX_PATH);
  const matrix = buildPdp2SurfaceMatrix({ root, status, previousMatrix, generatedAt: 'fixture-time' });
  assert.equal(matrix.surfaces.length, 54);
  assert.equal(new Set(matrix.surfaces.map(({ surfaceId }) => surfaceId)).size, 54);
  assert.equal(matrix.denominatorValidation.status, 'PASS');
  assert.equal(matrix.summary.physical, 26);
  assert.equal(matrix.summary.compositions, 7);
  assert.equal(matrix.summary.logicalConsumers, 21);
  assert.equal(matrix.phaseSourceCurrentness.status, 'CURRENT');
  assert.equal(matrix.campaign.status, status.status);
  assert.equal(matrix.summary.sourceCurrentDevCompleteCells, 40);
  assert.equal(matrix.summary.explicitNotApplicableCells, 14);
  assert.equal(matrix.summary.remainingPhaseLocalTaskCount, 0);
  assert.equal(matrix.claimsBoundary.nativeClosure, 'NOT_PERFORMED');
  assert.ok(matrix.sourceFingerprints['libs/audio-video-ui/vitest.config.ts'], 'authored package authority files remain fingerprinted');
  assert.ok(Object.keys(matrix.sourceFingerprints).every((sourceRef) => !/(?:^|\/)node_modules\/\.vite(?:\/|$)/u.test(sourceRef)));
  for (const [sourceRef, fingerprint] of Object.entries(matrix.sourceFingerprints)) {
    assert.equal(fingerprint, digest(fs.readFileSync(path.join(root, sourceRef))));
  }
  for (const row of matrix.surfaces) {
    assert.ok(Object.keys(row.sourceFingerprints).length > 0);
    assert.ok(Object.keys(row.sourceFingerprints).every((sourceRef) => !/(?:^|\/)node_modules\/\.vite(?:\/|$)/u.test(sourceRef)));
    for (const [sourceRef, fingerprint] of Object.entries(row.sourceFingerprints)) {
      assert.equal(fingerprint, digest(fs.readFileSync(path.join(root, sourceRef))));
    }
  }
  assert.ok(matrix.surfaces.every((row) => row.applicability.disposition && row.applicability.rationale));
});

test('failed native criteria remain unassigned and block applicable PDP-2 rows', () => {
  const status = structuredClone(readJson(PDP2_STATUS_PATH));
  status.directDevelopmentCriteria['P2-07'].testStatus = 'FAIL';
  status.outstandingMeaningIds = ['P2-07:focused-development-tests-not-green-or-source-pinned'];
  const matrix = buildPdp2SurfaceMatrix({ root, status, generatedAt: 'fixture-time' });
  assert.equal(matrix.campaign.status, 'IN_PROGRESS');
  assert.deepEqual(matrix.unassignedPhaseLevelWork.failedCriteria.map(({ criterionId }) => [criterionId]), [['P2-07']]);
  assert.equal(matrix.unassignedPhaseLevelWork.surfaceAssignmentState, 'UNKNOWN_PHASE_LOCAL_OWNERSHIP');
  const applicableRows = matrix.surfaces.filter((row) => row.applicability.disposition === 'APPLICABLE' || !['NOT_APPLICABLE', 'NOT_ACTIVE_ARCHIVED'].includes(row.applicability.disposition));
  assert.ok(applicableRows.length > 0);
  assert.ok(applicableRows.every((row) => row.developmentStatus === 'PENDING' && row.remainingPhaseLocalTaskIds === null && row.blockerOwner === 'UNKNOWN_PHASE_LOCAL_OWNER'));
  assert.ok(applicableRows.every((row) => row.blockerIds.includes('PDP2_DIRECT_CRITERIA_FAIL') && !row.blockerIds.includes('PDP2_NATIVE_STATUS_NOT_DEV_COMPLETE')));
  assert.ok(matrix.surfaces.filter((row) => ['NOT_APPLICABLE', 'NOT_ACTIVE_ARCHIVED'].includes(row.developmentStatus)).every((row) => row.remainingPhaseLocalTaskIds.length === 0));
});

test('a blocked predecessor barrier is distinct from PDP-2 native readiness', () => {
  const status = readJson(PDP2_STATUS_PATH);
  const previousMatrix = readJson(PDP2_MATRIX_PATH);
  const matrix = buildPdp2SurfaceMatrix({
    root,
    status,
    previousMatrix,
    generatedAt: 'fixture-time',
    predecessorInputs: { pdp1Status: { phase: 'PDP-1', status: 'IN_PROGRESS' } },
  });
  assert.equal(status.status, 'DEV_COMPLETE');
  assert.equal(matrix.nativePdp2Readiness.status, 'READY');
  assert.equal(matrix.prerequisiteState.status, 'BLOCKED_OR_UNKNOWN');
  assert.equal(matrix.campaign.status, 'IN_PROGRESS');
  const applicableRow = matrix.surfaces.find((row) => row.applicability.disposition === 'APPLICABLE');
  assert.equal(applicableRow.developmentStatus, 'PENDING');
  assert.ok(applicableRow.blockerIds.includes('PDP0_PDP1_PREDECESSOR_BARRIER_NOT_READY'));
  assert.ok(!applicableRow.blockerIds.includes('PDP2_NATIVE_STATUS_NOT_DEV_COMPLETE'));
  assert.equal(applicableRow.blockerOwner, 'PDP0_PDP1_PREDECESSOR_BARRIER');
  assert.ok(matrix.predecessorStatusRefs.includes(PDP1_STATUS_PATH));
});
