import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
const matrixPath = new URL('../docs/implementation/verification/pdp-38/pdp0-surface-phase-status-matrix.json', import.meta.url);
const statusPath = new URL('../docs/implementation/pdp-0-phase-dev-status.json', import.meta.url);

test('PDP-0 surface matrix accounts for source-pinned phase work without assigning global blockers to surfaces', () => {
  execFileSync(process.execPath, ['scripts/generate-media-pdp0-surface-phase-status-matrix.mjs', '--check'], { cwd: root });

  const status = JSON.parse(readFileSync(statusPath, 'utf8'));
  const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'));
  const failedCriteria = Object.entries(status.directDevelopmentCriteria)
    .filter(([, criterion]) => criterion.testStatus === 'FAIL');

  assert.equal(matrix.surfaces.length, 54);
  assert.equal(matrix.campaign.status, status.status);
  assert.equal(matrix.campaign.sourceBaselineCommit, status.mainSha);
  assert.equal(matrix.summary.nativeDevCompleteCells, 45);
  assert.equal(matrix.summary.inProgressCells, 0);
  assert.deepEqual(matrix.surfaces.reduce((counts, { developmentStatus }) => {
    counts[developmentStatus] = (counts[developmentStatus] ?? 0) + 1;
    return counts;
  }, {}), { NOT_APPLICABLE: 8, DEV_COMPLETE: 45, NOT_ACTIVE_ARCHIVED: 1 });
  assert.equal(matrix.summary.remainingPhaseLocalTaskCount,
    failedCriteria.length + status.outstandingMeaningIds.length);
  assert.equal(matrix.summary.remainingPhaseLocalSurfaceCount, 0);
  assert.deepEqual(matrix.unassignedPhaseLevelWork.failedCriteria.map(({ criterionId }) => criterionId),
    failedCriteria.map(([criterionId]) => criterionId));
  assert.deepEqual(matrix.unassignedPhaseLevelWork.outstandingMeaningTasks.map(({ taskId }) => taskId),
    status.outstandingMeaningIds);
  assert.ok(matrix.unassignedPhaseLevelWork.failedCriteria.every((item) => item.surfaceIds.length === 0 && item.owner === null));
  assert.equal(matrix.phaseSourceCurrentness.sourcePinCount, Object.keys(status.sourceShaSet).length);
  assert.equal(matrix.phaseSourceCurrentness.status,
    matrix.phaseSourceCurrentness.staleSourcePinCount === 0 ? 'CURRENT' : 'STALE');
  assert.equal(matrix.phaseSourceCurrentness.staleSourcePinCount, matrix.phaseSourceCurrentness.staleSourcePins.length);
  assert.equal(Object.hasOwn(matrix.sourceFingerprints, '.product-experience/decision-log.md'), false,
    'the matrix depends on its exact PDP-0 decision section, not the shared downstream decision log');
  assert.equal(Object.hasOwn(matrix.sourceFingerprints, '.product-experience/decision-log.md#PXD-207-section'), true);
  assert.ok(matrix.surfaces.every((surface) => !surface.sourceRefs.includes('.product-experience/decision-log.md')));
  assert.ok(matrix.surfaces.every((surface) => Object.hasOwn(surface.sourceFingerprints, '.product-experience/decision-log.md#PXD-207-section')));
  assert.ok(matrix.surfaces.every((surface) => surface.sourceCurrent === (matrix.phaseSourceCurrentness.status === 'CURRENT')));
  assert.ok(matrix.surfaces.every((surface) => surface.remainingPhaseLocalTaskIds.length === 0));
});
