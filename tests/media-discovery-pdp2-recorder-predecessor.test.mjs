import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validatePdp0Predecessor, validatePdp1Predecessor } from '../scripts/record-media-discovery-pdp2-phase-exit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
const matrix = read('docs/implementation/media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json');
const pdp1Path = 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-15-current-cut-r30.json';
const pdp0Path = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r15.json';
const pdp1 = read(pdp1Path);
const pdp0 = read(pdp0Path);

function exactPredecessors() {
  const p0 = validatePdp0Predecessor(pdp0, matrix, pdp0Path);
  const p1 = validatePdp1Predecessor(pdp1, matrix, pdp1Path, p0);
  return { p0, p1 };
}

test('PDP-2 recorder accepts only matrix-selected PDP-1 R30 paired with PDP-0 R15', () => {
  const { p0, p1 } = exactPredecessors();
  assert.equal(p0.valid, true);
  assert.equal(p0.status, 'PASS');
  assert.equal(p0.cellCount, 50);
  assert.equal(p1.valid, true);
  assert.equal(p1.exitRef, pdp1Path);
  assert.equal(p1.observationId, 'MEDIA-PDP1-CURRENTNESS-2026-10-15-CURRENT-CUT-R30');
  assert.equal(p1.materialSourceSetFingerprint, 'sha256:34f90853f894e4e244e5e0c76643ebd94f6f2455c6a012c4dd4073bb5d62a4f4');
  assert.equal(p1.cellCount, 50);
  assert.equal(p1.pdp0Predecessor.exitRef, pdp0Path);
  assert.equal(p1.pdp0Predecessor.materialSourceSetFingerprint,
    'sha256:eff717cf2537a285cd7a1c1a72b44a75766a0a7e6eef6ea97edbc2befa2e1a95');
});

test('PDP-2 recorder rejects stale R27, a replayed R30 identity mismatch, and a wrong R30 to PDP-0 digest', () => {
  const p0 = validatePdp0Predecessor(pdp0, matrix, pdp0Path);
  const stalePath = 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r27.json';
  const stale = read(stalePath);
  assert.equal(validatePdp1Predecessor(stale, matrix, stalePath, p0).valid, false);

  const replayedMatrix = structuredClone(matrix);
  replayedMatrix.currentCut.pdp1PhaseExitRecordId = 'MEDIA-PDP1-CURRENTNESS-2026-10-14-CURRENT-CUT-R27';
  assert.equal(validatePdp1Predecessor(pdp1, replayedMatrix, pdp1Path, p0).valid, false);

  const wrongPdp0 = structuredClone(p0);
  wrongPdp0.exitDigest = `sha256:${'0'.repeat(64)}`;
  assert.equal(validatePdp1Predecessor(pdp1, matrix, pdp1Path, wrongPdp0).valid, false);
  const wrongCurrentness = structuredClone(pdp1);
  wrongCurrentness.predecessor.currentnessDigest = `sha256:${'0'.repeat(64)}`;
  assert.equal(validatePdp1Predecessor(wrongCurrentness, matrix, pdp1Path, p0).valid, false);
  assert.equal(validatePdp0Predecessor(pdp0, matrix, stalePath).valid, false);
});
