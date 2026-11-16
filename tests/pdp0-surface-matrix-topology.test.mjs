import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  appendPdp0TopologyRows,
  isPdp0RowSourceCurrent,
  isPdp0SourceDefinitionReviewCurrent,
  missingPdp0PhaseSourcePins,
} from '../scripts/lib/media-pdp0-surface-matrix-topology.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
const topologyPath = '.product-experience/surfaces/media-physical-topology.v1.json';
const matrixPath = 'docs/implementation/verification/pdp-38/pdp0-surface-phase-status-matrix.json';
const reviewPins = (topology) => {
  const refs = [...new Set(topology.manifestCandidates.flatMap((row) => row.phaseApplicability?.['PDP-0']?.sourceDefinitionReview?.reviewedSourceRefs ?? []))];
  const current = Object.fromEntries(refs.map((ref) => [ref,
    crypto.createHash('sha256').update(fs.readFileSync(path.join(root, ref))).digest('hex'),
  ]));
  return {current, phaseSourceShaSet: {...current}};
};

test('PDP-0 applies the two explicit delegated source-definition reviews without claiming acceptance', () => {
  const topology = readJson(topologyPath);
  const matrix = readJson(matrixPath);
  matrix.surfaces = matrix.surfaces.filter(({ surfaceId }) => ![
    'media.physical.adapters-agent-tools-media', 'media.physical.adapters-data-cloud-media',
  ].includes(surfaceId));
  const previousIds = matrix.surfaces.map(({ surfaceId }) => surfaceId);
  const pins = reviewPins(topology);
  const { addedSurfaceIds, topologyRows } = appendPdp0TopologyRows(matrix, topology, pins.current, topologyPath, {phaseSourceShaSet:pins.phaseSourceShaSet});

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
  assert.equal(agentTools.sourceOwnerReviewState, 'DELEGATED_SOURCE_DEFINITION_REVIEW_COMPLETE');
  assert.deepEqual(agentTools.remainingPhaseLocalTaskIds, []);
  assert.equal(agentTools.sourceDefinitionReview.authority, 'USER_EXPLICITLY_DELEGATED_SOURCE_DEFINITION_DECISION');
  assert.deepEqual(agentTools.applicability.capabilityIntentIds, []);
  assert.deepEqual(agentTools.applicability.requirementIds, []);
  assert.equal(dataCloud.applicability.disposition, 'APPLICABLE');
  assert.equal(dataCloud.developmentStatus, 'IN_PROGRESS');
  assert.equal(dataCloud.sourceCurrent, false);
  assert.deepEqual(dataCloud.remainingPhaseLocalTaskIds, []);
  assert.equal(dataCloud.sourceOwnerReviewState, 'DELEGATED_SOURCE_DEFINITION_REVIEW_COMPLETE');
  assert.equal(dataCloud.blockerOwner, null);
  assert.deepEqual(dataCloud.requirementRefs, [
    'MEDIA-REQ-CAP-SPEECH-TRANSCRIPTION', 'MEDIA-REQ-CAP-VISION', 'MEDIA-REQ-CAP-MULTIMODAL',
  ]);
  assert.deepEqual(dataCloud.capabilityFamilyIds, []);
  assert.deepEqual(dataCloud.capabilityIntentRefs, []);
  assert.deepEqual(dataCloud.intentRefs, []);
  assert.equal(dataCloud.sourceDefinitionReview.requirementRefDisposition, 'BOUNDARY_TRACE_ONLY_NOT_DIRECT_CAPABILITY_OWNERSHIP');
  assert.equal(dataCloud.sourceDefinitionReview.evaluatedCanonicalCapabilityCount, 43);
  assert.deepEqual(dataCloud.sourceDefinitionReview.criterionCoverage.map(({ criterionId }) => criterionId), ['P0-01', 'P0-04', 'P0-07', 'P0-08']);
  assert.deepEqual(dataCloud.sourceDefinitionReview.phaseLocalTaskIds, []);
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

test('PDP-0 preserves the reviewed applicable row and task disposition across repeated projection', () => {
  const topology = readJson(topologyPath);
  const matrix = readJson(matrixPath);
  matrix.surfaces = matrix.surfaces.filter(({ surfaceId }) => ![
    'media.physical.adapters-agent-tools-media', 'media.physical.adapters-data-cloud-media',
  ].includes(surfaceId));
  const pins = reviewPins(topology);
  appendPdp0TopologyRows(matrix, topology, pins.current, topologyPath, {phaseSourceShaSet:pins.phaseSourceShaSet});
  const dataCloud = matrix.surfaces.find(({ surfaceId }) => surfaceId === 'media.physical.adapters-data-cloud-media');
  assert.deepEqual(dataCloud.remainingPhaseLocalTaskIds, []);
  appendPdp0TopologyRows(matrix, topology, pins.current, topologyPath, {phaseSourceShaSet:pins.phaseSourceShaSet});

  assert.equal(dataCloud.sourceOwnerReviewState, 'DELEGATED_SOURCE_DEFINITION_REVIEW_COMPLETE');
  assert.match(dataCloud.sourceCurrentBasis, /delegated source-definition review/u);
  assert.deepEqual(dataCloud.remainingPhaseLocalTaskIds, []);
});

test('PDP-0 support/N/A row review marker persists across repeated generation', () => {
  const topology = readJson(topologyPath);
  const matrix = readJson(matrixPath);
  matrix.surfaces = matrix.surfaces.filter(({ surfaceId }) => ![
    'media.physical.adapters-agent-tools-media', 'media.physical.adapters-data-cloud-media',
  ].includes(surfaceId));
  const pins = reviewPins(topology);
  appendPdp0TopologyRows(matrix, topology, pins.current, topologyPath, {phaseSourceShaSet:pins.phaseSourceShaSet});
  const agentTools = matrix.surfaces.find(({ surfaceId }) => surfaceId === 'media.physical.adapters-agent-tools-media');
  assert.equal(agentTools.developmentStatus, 'NOT_APPLICABLE');
  assert.deepEqual(agentTools.remainingPhaseLocalTaskIds, []);
  assert.equal(agentTools.sourceOwnerReviewState, 'DELEGATED_SOURCE_DEFINITION_REVIEW_COMPLETE');

  appendPdp0TopologyRows(matrix, topology, pins.current, topologyPath, {phaseSourceShaSet:pins.phaseSourceShaSet});

  assert.equal(agentTools.sourceOwnerReviewState, 'DELEGATED_SOURCE_DEFINITION_REVIEW_COMPLETE');
  assert.match(agentTools.sourceCurrentBasis, /delegated source-definition review/u);
});

test('PDP-0 review gate rejects a mismatched surface, missing source pin, or nonzero task disposition', () => {
  const topology = readJson(topologyPath);
  const pins = reviewPins(topology);
  const row = topology.manifestCandidates.find(({ surfaceId }) => surfaceId === 'media.physical.adapters-data-cloud-media');
  const review = row.phaseApplicability['PDP-0'].sourceDefinitionReview;
  const sourceCell = row.phaseApplicability['PDP-0'];
  assert.equal(isPdp0SourceDefinitionReviewCurrent(review, row.surfaceId, pins.current, pins.phaseSourceShaSet, sourceCell), true);
  assert.equal(isPdp0SourceDefinitionReviewCurrent({...review, reviewedSurfaceId:'media.physical.adapters-agent-tools-media'}, row.surfaceId, pins.current, pins.phaseSourceShaSet, sourceCell), false);
  assert.equal(isPdp0SourceDefinitionReviewCurrent({...review, reviewedSourceRefs:review.reviewedSourceRefs.slice(1)}, row.surfaceId, pins.current, pins.phaseSourceShaSet, sourceCell), false);
  assert.equal(isPdp0SourceDefinitionReviewCurrent({...review, taskDisposition:'OPEN_PDP0_TASKS', phaseLocalTaskIds:['P0-08:missing-boundary-review']}, row.surfaceId, pins.current, pins.phaseSourceShaSet, sourceCell), false);
  const stalePins = {...pins.phaseSourceShaSet, [review.reviewedSourceRefs[0]]:'0'.repeat(64)};
  assert.equal(isPdp0SourceDefinitionReviewCurrent(review, row.surfaceId, pins.current, stalePins, sourceCell), false);
});

test('PDP-0 row source currentness requires every phase pin to be current', () => {
  const row = {
    requiresDefinitionReview:true,
    reviewCurrent:true,
    sourceOwnerReviewState:'DELEGATED_SOURCE_DEFINITION_REVIEW_COMPLETE',
    remainingPhaseLocalTaskIds:[],
  };
  assert.equal(isPdp0RowSourceCurrent({...row, phaseSourceCurrentnessStatus:'CURRENT'}), true);
  assert.equal(isPdp0RowSourceCurrent({...row, phaseSourceCurrentnessStatus:'STALE'}), false);
  assert.equal(isPdp0RowSourceCurrent({...row, phaseSourceCurrentnessStatus:'UNKNOWN'}), false);
  assert.equal(isPdp0RowSourceCurrent({...row, phaseSourceCurrentnessStatus:'CURRENT', reviewCurrent:false}), false);
});

test('PDP-0 phase currentness rejects empty or truncated source pin sets', () => {
  const required = ['.product-experience/pdp-0-product-truth/capabilities.yaml', 'docs/surfaces/adapters-agent-tools-media/README.md'];
  const pins = Object.fromEntries(required.map((ref) => [ref, 'a'.repeat(64)]));
  assert.deepEqual(missingPdp0PhaseSourcePins({}, required), required);
  assert.deepEqual(missingPdp0PhaseSourcePins({[required[0]]:pins[required[0]]}, required), [required[1]]);
  assert.deepEqual(missingPdp0PhaseSourcePins(pins, required), []);
});
