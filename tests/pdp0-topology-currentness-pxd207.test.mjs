import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { pdp0PhaseScopedSourcePins } from '../scripts/report-media-pdp-readiness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = relativePath => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

test('PXD-207 topology currentness successor preserves the 56-surface PDP-0 applicability projection', () => {
  const successor = readJson('docs/implementation/verification/pdp-38/pdp0-topology-currentness-pxd207-successor-2026-11-16.json');
  const topology = readJson('.product-experience/surfaces/media-physical-topology.v1.json');
  const matrix = readJson('docs/implementation/verification/pdp-38/pdp0-surface-phase-status-matrix.json');
  const phasePins = pdp0PhaseScopedSourcePins();
  const topologyRows = [...topology.manifestCandidates, ...topology.compositions, ...topology.consumerCrosswalk];

  assert.equal(successor.successorKind, 'CURRENTNESS_ONLY');
  assert.deepEqual(successor.topologyDenominator, {
    physicalCandidates: 28,
    compositions: 7,
    logicalConsumers: 21,
    totalSurfaceIdentities: 56,
    meaning: 'SOURCE_TOPOLOGY_POPULATION_UNCHANGED',
  });
  assert.equal(topologyRows.length, 56);
  assert.equal(matrix.surfaces.length, 56);

  for (const [sourceRef, expectedSha256] of Object.entries(successor.currentSourceFingerprints)) {
    const actualSha256 = phasePins[sourceRef]
      ?? hash(fs.readFileSync(path.join(root, sourceRef)));
    assert.equal(actualSha256, expectedSha256, `${sourceRef} successor pin is current`);
  }

  const expected = new Map(successor.reviewedSurfaceProjection.map(row => [row.surfaceId, row]));
  for (const surfaceId of expected.keys()) {
    const source = topology.manifestCandidates.find(row => row.surfaceId === surfaceId).phaseApplicability['PDP-0'];
    const projected = matrix.surfaces.find(row => row.surfaceId === surfaceId).applicability;
    const record = expected.get(surfaceId);
    assert.equal(source.disposition, record.pdp0Disposition);
    assert.equal(projected.disposition, record.pdp0Disposition);
    assert.deepEqual(source.capabilityFamilyIds, record.capabilityFamilyIds);
    assert.deepEqual(source.capabilityIntentIds, record.capabilityIntentIds);
    assert.deepEqual(source.requirementIds, record.requirementIds);
    assert.deepEqual(source.intentIds, record.intentIds);
    assert.deepEqual(projected.requirementIds, record.requirementIds);
    assert.deepEqual(source.sourceDefinitionReview.phaseLocalTaskIds, record.phaseLocalTaskIds);
  }

  const cloud = topology.manifestCandidates.find(row => row.surfaceId === 'media.physical.adapters-data-cloud-media').phaseApplicability['PDP-0'];
  assert.equal(cloud.sourceDefinitionReview.requirementRefDisposition, 'BOUNDARY_TRACE_ONLY_NOT_DIRECT_CAPABILITY_OWNERSHIP');
  assert.match(cloud.rationale, /currently report unavailable for all operations/u);
  assert.match(fs.readFileSync(path.join(root, 'adapters/data-cloud-media/README.md'), 'utf8'), /All three currently report unavailable for\s+every operation/u);
  assert.equal(successor.authority.ownerApproval, 'NOT_CLAIMED');
  assert.equal(successor.authority.independentAcceptance, 'NOT_CLAIMED');
  assert.equal(successor.authority.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(successor.authority.phaseClosure, 'NOT_CLAIMED');
});
