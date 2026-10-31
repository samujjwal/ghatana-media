import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  DECLARED_MATRIX_DELTA,
  MATRIX_PATHS,
  TOPOLOGY_PATH,
  reconcileMediaSurfaceRoster
} from '../scripts/lib/media-surface-roster-reconciliation.mjs';

const load = () => ({
  topology: JSON.parse(fs.readFileSync(TOPOLOGY_PATH, 'utf8')),
  matrices: MATRIX_PATHS.map(path => ({ path, matrix: JSON.parse(fs.readFileSync(path, 'utf8')) }))
});

test('current topology reconciles to 54 matrix-bound identities plus exactly the declared delta', () => {
  const result = reconcileMediaSurfaceRoster(load());
  assert.deepEqual(
    { physical: result.census.physical, compositions: result.census.compositions, logical: result.census.logical, total: result.census.total, matrixBound: result.census.matrixBound, matrixDelta: result.census.matrixDelta },
    { physical: 29, compositions: 7, logical: 21, total: 57, matrixBound: 54, matrixDelta: 3 }
  );
  assert.deepEqual(result.delta.map(row => row.id).sort(), Object.keys(DECLARED_MATRIX_DELTA).sort());
  assert.equal(result.roster.find(row => row.id === 'media.surface.desktop-archive').lifecycleState, 'ARCHIVED');
  assert.equal(result.roster.find(row => row.id === 'media.physical.adapters-ocr-compat').lifecycleState, 'RETIRING');
  assert.equal(result.roster.find(row => row.id === 'media.composition.repository-root').lifecycleState, 'ROOT');
  assert(result.roster.filter(row => row.matrixDelta).every(row => row.matrixBound === false));
});

test('generated reconciliation record is current', () => {
  assert.match(execFileSync(process.execPath, ['scripts/reconcile-media-surface-roster.mjs', '--check'], { encoding: 'utf8' }), /PASS/);
});

test('rejects undeclared drift, stale declarations, ghosts, duplicates and inconsistent matrices', () => {
  const base = load();
  const clone = () => structuredClone(base);

  const undeclared = clone();
  undeclared.topology.manifestCandidates.push({ ...undeclared.topology.manifestCandidates[0], surfaceId: 'media.physical.new-unreviewed' });
  undeclared.topology.activeManifestCandidateCount += 1;
  assert.throws(() => reconcileMediaSurfaceRoster(undeclared), /undeclared topology identities/);

  const staleDeclaration = clone();
  assert.throws(() => reconcileMediaSurfaceRoster({ ...staleDeclaration, declaredDelta: { ...DECLARED_MATRIX_DELTA, 'media.physical.gone': DECLARED_MATRIX_DELTA['media.physical.adapters-ocr-compat'] } }), /stale delta declarations/);

  const ghost = clone();
  for (const { matrix } of ghost.matrices) matrix.surfaces.push({ surfaceId: 'media.physical.ghost' });
  assert.throws(() => reconcileMediaSurfaceRoster(ghost), /ghost surfaces/);

  const duplicate = clone();
  duplicate.topology.consumerCrosswalk.push(duplicate.topology.consumerCrosswalk[0]);
  assert.throws(() => reconcileMediaSurfaceRoster(duplicate), /duplicate surface identities/);

  const divergent = clone();
  divergent.matrices[2].matrix.surfaces.pop();
  assert.throws(() => reconcileMediaSurfaceRoster(divergent), /membership differs/);

  const countDrift = clone();
  countDrift.topology.activeManifestCandidateCount = 26;
  assert.throws(() => reconcileMediaSurfaceRoster(countDrift), /activeManifestCandidateCount/);

  const dispositionDrift = clone();
  dispositionDrift.topology.manifestCandidates.find(row => row.surfaceId === 'media.physical.adapters-ocr-compat').disposition = 'PHYSICAL';
  assert.throws(() => reconcileMediaSurfaceRoster(dispositionDrift), /differs from declared/);
});
