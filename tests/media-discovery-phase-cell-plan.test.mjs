import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const matrix = read('docs/implementation/media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json');
const topology = read('.product-experience/surfaces/media-physical-topology.v1.json');
const ownerEvidence = read('docs/implementation/observations/media-discovery-delegated-owner-evidence-2026-10-13.json');
const phases = ['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3'];

test('Discovery execution plan retains physical/composite/consumer denominators without double counting', () => {
  assert.equal(topology.manifestCandidates.length, 26);
  assert.equal(topology.compositions.filter(c => c.kind === 'SEMANTIC_COMPOSITION').length, 6);
  assert.equal(topology.compositions.filter(c => c.kind === 'REPOSITORY_ROOT').length, 1);
  assert.equal(topology.consumerCrosswalk.length, 17);
  const ids = [
    ...topology.manifestCandidates.map(x => x.surfaceId),
    ...topology.compositions.map(x => x.surfaceId),
    ...topology.consumerCrosswalk.map(x => x.surfaceId),
  ];
  assert.equal(new Set(ids).size, 50);
  assert.equal(matrix.cells.length, ids.length * phases.length);
  assert.equal(new Set(matrix.cells.map(x => x.cellId)).size, 200);
  assert.deepEqual(new Set(matrix.cells.map(x => x.surfaceId)), new Set(ids));
  for (const id of ids) {
    assert.deepEqual(matrix.cells.filter(x => x.surfaceId === id).map(x => x.phase), phases);
  }
});

test('Discovery plan keeps source-current PDP-0 separate from unpublished phase exit and future phases', () => {
  const observation = read('docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-13.json');
  assert.equal(matrix.baseline.pdp0MaterialSetFingerprint, observation.materialSourceSetFingerprint);
  assert.equal(ownerEvidence.source.materialSetFingerprint, observation.materialSourceSetFingerprint);
  assert.equal(observation.physicalCompositeConsumerCells.length, 50);
  assert.ok(observation.physicalCompositeConsumerCells.every(x => x.sourceCurrentness === 'CURRENT'));
  assert.ok(matrix.cells.filter(c => c.phase === 'PDP-0').every(c => c.currentnessAtReview === 'CURRENT' && c.currentPhaseExitPublished === false));
  for (const c of matrix.cells.filter(c => c.phase !== 'PDP-0')) {
    assert.equal(c.currentnessAtReview, 'NOT_REVALIDATED');
    assert.equal(c.currentPhaseExitPublished, false);
  }
  assert.equal(matrix.status.discovery, 'FAIL');
  assert.equal(matrix.status.build, 'NOT_ENTERED');
  assert.equal(matrix.status.nativePdpClosure, 'NOT_ENTERED');
});

test('Every phase cell has executable prescriptive links, owner, scope and no manufactured authoring backlog', () => {
  const topoById = new Map([
    ...topology.manifestCandidates,
    ...topology.compositions,
    ...topology.consumerCrosswalk,
  ].map(s => [s.surfaceId, s]));
  for (const c of matrix.cells) {
    assert.ok(c.owner && c.phaseTaskIds?.length > 0 && c.inspectWhere?.length > 0);
    assert.ok(c.what && c.how && c.acceptWhen && c.nextLegalAction);
    assert.equal(c.historicalDefinitionState, 'DEV_COMPLETE');
    assert.equal(c.historicalOutstandingMeaningIds, 0);
    const t = topoById.get(c.surfaceId);
    assert.ok(t);
    const actual = t.phaseApplicability?.[c.phase]?.disposition;
    const expected = c.surfaceKind === 'CONSUMER_BINDING'
      ? (t.bindingState === 'ARCHIVED' ? 'NOT_APPLICABLE_ARCHIVED' : 'APPLICABLE_CONSUMER_BINDING')
      : actual;
    assert.equal(c.phaseApplicabilityDisposition, expected);
    assert.deepEqual(c.phaseTaskIds, matrix.phaseTaskMap[c.phase]);
  }
});
