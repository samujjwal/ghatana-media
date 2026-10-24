import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveMediaPdp0SourceDevelopmentDelta } from '../scripts/lib/media-pdp0-source-development-current-cut.mjs';

const addedSurfaceIds = [
  'media.surface.capture-adapters',
  'media.surface.interactive-demo-player',
  'media.surface.production-studio',
  'media.surface.recorder-orchestrator',
];

function makeCuts() {
  const priorCells = Array.from({ length: 50 }, (_, index) => ({ cellId: `historic-${String(index).padStart(2, '0')}:PDP-0` }));
  const currentCells = [
    ...priorCells,
    ...addedSurfaceIds.map((surfaceId) => ({ cellId: `${surfaceId}:PDP-0` })),
  ];
  const priorPaths = Object.fromEntries(Array.from({ length: 146 }, (_, index) => [`path-${String(index).padStart(3, '0')}`, `sha256:${String(index).padStart(64, '0')}`]));
  const currentPaths = { ...priorPaths };
  for (let index = 0; index < 8; index += 1) delete currentPaths[`path-${String(index).padStart(3, '0')}`];
  for (let index = 0; index < 69; index += 1) currentPaths[`new-path-${String(index).padStart(3, '0')}`] = `sha256:${String(index + 1).padStart(64, '0')}`;
  for (let index = 8; index < 64; index += 1) currentPaths[`path-${String(index).padStart(3, '0')}`] = `sha256:${String(index + 500).padStart(64, '0')}`;
  return {
    historical: { physicalCompositeConsumerCells: priorCells, sourceContentDigests: priorPaths },
    currentness: {
      physicalCompositeConsumerCells: currentCells,
      sourceContentDigests: currentPaths,
    },
  };
}

test('PDP-0 current-source successor records the exact historical 50/146 to current 54/207 inventory delta', () => {
  const { historical, currentness } = makeCuts();
  const delta = deriveMediaPdp0SourceDevelopmentDelta(historical, currentness);
  assert.deepEqual(delta.addedCellIds, addedSurfaceIds.map((id) => `${id}:PDP-0`).sort());
  assert.deepEqual(delta.removedCellIds, []);
  assert.equal(delta.currentCellIds.length, 54);
  assert.equal(delta.currentMaterialPaths.length, 207);
  assert.equal(delta.addedMaterialPaths.length, 69);
  assert.equal(delta.removedMaterialPaths.length, 8);
  assert.equal(delta.changedMaterialPaths.length, 56);
});

test('PDP-0 source-development delta fails closed when a new consumer is omitted', () => {
  const { historical, currentness } = makeCuts();
  currentness.physicalCompositeConsumerCells = currentness.physicalCompositeConsumerCells
    .filter((cell) => !cell.cellId.startsWith('media.surface.production-studio:'));
  assert.throws(() => deriveMediaPdp0SourceDevelopmentDelta(historical, currentness), /exact immutable 50\/146 to current 54\/207 cut/u);
});

test('PDP-0 source-development delta fails closed when current material membership is incomplete', () => {
  const { historical, currentness } = makeCuts();
  delete currentness.sourceContentDigests['new-path-000'];
  assert.throws(() => deriveMediaPdp0SourceDevelopmentDelta(historical, currentness), /exact immutable 50\/146 to current 54\/207 cut/u);
});
