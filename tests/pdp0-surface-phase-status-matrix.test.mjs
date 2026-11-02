import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
const matrixPath = new URL('../docs/implementation/verification/pdp-38/pdp0-surface-phase-status-matrix.json', import.meta.url);
const statusPath = new URL('../docs/implementation/pdp-0-phase-dev-status.json', import.meta.url);

test('PDP-0 surface matrix accounts for source-pinned phase work without assigning global blockers to surfaces', () => {
  const status = JSON.parse(readFileSync(statusPath, 'utf8'));
  const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'));
  const check = spawnSync(process.execPath, ['scripts/generate-media-pdp0-surface-phase-status-matrix.mjs', '--check'], {
    cwd: root,
    encoding: 'utf8',
  });
  const failedCriteria = Object.entries(status.directDevelopmentCriteria)
    .filter(([, criterion]) => criterion.testStatus === 'FAIL');

  assert.equal(matrix.surfaces.length, 56);
  assert.equal(matrix.summary.totalSurfaceIdentities, 56);
  assert.equal(matrix.campaign.status, status.status);
  assert.equal(matrix.campaign.sourceBaselineCommit, status.mainSha);
  assert.equal(matrix.summary.nativeDevCompleteCells, 0);
  assert.equal(matrix.summary.inProgressCells, 46);
  assert.deepEqual(matrix.surfaces.reduce((counts, { developmentStatus }) => {
    counts[developmentStatus] = (counts[developmentStatus] ?? 0) + 1;
    return counts;
  }, {}), { NOT_APPLICABLE: 9, IN_PROGRESS: 46, NOT_ACTIVE_ARCHIVED: 1 });
  const agentTools = matrix.surfaces.find(({ surfaceId }) => surfaceId === 'media.physical.adapters-agent-tools-media');
  const dataCloud = matrix.surfaces.find(({ surfaceId }) => surfaceId === 'media.physical.adapters-data-cloud-media');
  assert.equal(agentTools.applicability.disposition, 'NOT_APPLICABLE_SUPPORT');
  assert.equal(agentTools.developmentStatus, 'NOT_APPLICABLE');
  assert.equal(dataCloud.applicability.disposition, 'APPLICABLE');
  assert.equal(dataCloud.developmentStatus, 'IN_PROGRESS');
  assert.equal(dataCloud.sourceCurrent, false);
  assert.equal(matrix.summary.remainingPhaseLocalTaskCount, null);
  assert.equal(matrix.summary.remainingPhaseLocalTaskCountKnown, false);
  assert.equal(matrix.summary.remainingPhaseLocalSurfaceCount, 46);
  assert.deepEqual(matrix.unassignedPhaseLevelWork.failedCriteria.map(({ criterionId }) => criterionId),
    failedCriteria.map(([criterionId]) => criterionId));
  assert.deepEqual(matrix.unassignedPhaseLevelWork.outstandingMeaningTasks.map(({ taskId }) => taskId),
    status.outstandingMeaningIds);
  assert.ok(matrix.unassignedPhaseLevelWork.failedCriteria.every((item) => item.surfaceIds.length === 0 && item.owner === null));
  assert.equal(matrix.phaseSourceCurrentness.sourcePinCount, Object.keys(status.sourceShaSet).length);
  assert.equal(matrix.phaseSourceCurrentness.status,
    matrix.phaseSourceCurrentness.staleSourcePinCount === 0 ? 'CURRENT' : 'STALE');
  assert.equal(matrix.phaseSourceCurrentness.staleSourcePinCount, matrix.phaseSourceCurrentness.staleSourcePins.length);
  if (matrix.phaseSourceCurrentness.status === 'CURRENT') {
    assert.equal(check.status, 0, check.stderr);
  } else {
    assert.notEqual(check.status, 0, 'check-only must fail when the generated projection reports stale source pins');
    assert.match(check.stderr, /PDP-0 phase source currentness is STALE/u);
  }
  assert.equal(Object.hasOwn(matrix.sourceFingerprints, '.product-experience/decision-log.md'), false,
    'the matrix depends on its exact PDP-0 decision section, not the shared downstream decision log');
  assert.equal(Object.hasOwn(matrix.sourceFingerprints, '.product-experience/decision-log.md#PXD-207-section'), true);
  assert.ok(matrix.surfaces.every((surface) => !surface.sourceRefs.includes('.product-experience/decision-log.md')));
  assert.ok(matrix.surfaces.every((surface) => Object.hasOwn(surface.sourceFingerprints, '.product-experience/decision-log.md#PXD-207-section')));
  assert.ok(matrix.surfaces.every((surface) => surface.sourceCurrent === (matrix.phaseSourceCurrentness.status === 'CURRENT')));
  assert.ok(matrix.surfaces.every((surface) => surface.remainingPhaseLocalTaskIds === null || surface.remainingPhaseLocalTaskIds.length === 0));
});
