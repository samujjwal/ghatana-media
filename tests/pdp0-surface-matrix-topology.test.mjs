import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { appendPdp0TopologyRows } from '../scripts/lib/media-pdp0-surface-matrix-topology.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
const topologyPath = '.product-experience/surfaces/media-physical-topology.v1.json';
const matrixPath = 'docs/implementation/verification/pdp-38/pdp0-surface-phase-status-matrix.json';

test('PDP-0 adds the two source-owned topology rows and keeps completion unclaimed pending review', () => {
  const topology = readJson(topologyPath);
  const matrix = readJson(matrixPath);
  const previousIds = matrix.surfaces.map(({ surfaceId }) => surfaceId);
  const { addedSurfaceIds, topologyRows } = appendPdp0TopologyRows(matrix, topology, {}, topologyPath);

  assert.equal(topologyRows.length, 56);
  assert.equal(matrix.surfaces.length, 56);
  const currentIds = new Set(matrix.surfaces.map(({ surfaceId }) => surfaceId));
  assert.ok(previousIds.every((surfaceId) => currentIds.has(surfaceId)));
  assert.deepEqual([...addedSurfaceIds].sort(), [
    'media.physical.adapters-agent-tools-media',
    'media.physical.adapters-data-cloud-media',
  ]);
  const agentTools = matrix.surfaces.find(({ surfaceId }) => surfaceId === 'media.physical.adapters-agent-tools-media');
  const dataCloud = matrix.surfaces.find(({ surfaceId }) => surfaceId === 'media.physical.adapters-data-cloud-media');
  assert.equal(agentTools.applicability.disposition, 'NOT_APPLICABLE_SUPPORT');
  assert.equal(agentTools.developmentStatus, 'NOT_APPLICABLE');
  assert.equal(agentTools.sourceCurrent, false);
  assert.equal(agentTools.sourceOwnerReviewState, 'PENDING');
  assert.deepEqual(agentTools.remainingPhaseLocalTaskIds, []);
  assert.equal(dataCloud.applicability.disposition, 'APPLICABLE');
  assert.equal(dataCloud.developmentStatus, 'IN_PROGRESS');
  assert.equal(dataCloud.sourceCurrent, false);
  assert.equal(dataCloud.remainingPhaseLocalTaskIds, null);
  assert.equal(dataCloud.blockerOwner, 'UNKNOWN_PHASE_LOCAL_OWNER');
  assert.deepEqual(dataCloud.requirementRefs, [
    'MEDIA-REQ-CAP-SPEECH-TRANSCRIPTION', 'MEDIA-REQ-CAP-VISION', 'MEDIA-REQ-CAP-MULTIMODAL',
  ]);
});

test('PDP-0 refuses to silently remove an identity from the prior matrix', () => {
  const topology = readJson(topologyPath);
  const matrix = readJson(matrixPath);
  topology.manifestCandidates = topology.manifestCandidates.filter(({ surfaceId }) => surfaceId !== matrix.surfaces[0].surfaceId);
  topology.activeManifestCandidateCount = topology.manifestCandidates.length;
  assert.throws(() => appendPdp0TopologyRows(matrix, topology, {}, topologyPath), /reviewed retirement is required/u);
});

test('PDP-0 rejects duplicate identities in either the prior matrix or source topology', () => {
  const topology = readJson(topologyPath);
  const matrix = readJson(matrixPath);
  matrix.surfaces.push(structuredClone(matrix.surfaces[0]));
  assert.throws(() => appendPdp0TopologyRows(matrix, topology, {}, topologyPath), /prior matrix must contain unique/u);

  const cleanMatrix = readJson(matrixPath);
  const duplicateTopology = structuredClone(topology);
  duplicateTopology.manifestCandidates.push(structuredClone(duplicateTopology.manifestCandidates[0]));
  duplicateTopology.activeManifestCandidateCount += 1;
  assert.throws(() => appendPdp0TopologyRows(cleanMatrix, duplicateTopology, {}, topologyPath), /source topology must contain unique/u);
});

test('PDP-0 keeps row currentness false after repeated generation while task ownership remains unknown', () => {
  const topology = readJson(topologyPath);
  const matrix = readJson(matrixPath);
  appendPdp0TopologyRows(matrix, topology, {}, topologyPath);
  const dataCloud = matrix.surfaces.find(({ surfaceId }) => surfaceId === 'media.physical.adapters-data-cloud-media');
  assert.equal(dataCloud.remainingPhaseLocalTaskIds, null);

  // Model a later generation with phase-wide source pins now matching.
  for (const row of matrix.surfaces) row.sourceCurrent = true;
  appendPdp0TopologyRows(matrix, topology, {}, topologyPath);

  assert.equal(dataCloud.sourceCurrent, false);
  assert.match(dataCloud.sourceCurrentBasis, /source-owner review/u);
  assert.equal(dataCloud.remainingPhaseLocalTaskIds, null);
});

test('PDP-0 support/N/A row review marker persists across repeated generation', () => {
  const topology = readJson(topologyPath);
  const matrix = readJson(matrixPath);
  appendPdp0TopologyRows(matrix, topology, {}, topologyPath);
  const agentTools = matrix.surfaces.find(({ surfaceId }) => surfaceId === 'media.physical.adapters-agent-tools-media');
  assert.equal(agentTools.developmentStatus, 'NOT_APPLICABLE');
  assert.deepEqual(agentTools.remainingPhaseLocalTaskIds, []);
  assert.equal(agentTools.sourceOwnerReviewState, 'PENDING');

  // Phase pins can become current without a row-level source-owner review.
  for (const row of matrix.surfaces) row.sourceCurrent = true;
  appendPdp0TopologyRows(matrix, topology, {}, topologyPath);

  assert.equal(agentTools.sourceCurrent, false);
  assert.equal(agentTools.sourceOwnerReviewState, 'PENDING');
  assert.match(agentTools.sourceCurrentBasis, /source-owner review/u);
});
