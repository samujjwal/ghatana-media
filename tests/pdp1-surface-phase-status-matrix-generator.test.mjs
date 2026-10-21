import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { buildPdp1SurfaceMatrix, PDP0_STATUS_PATH, PDP1_REVIEW_PATH, PDP1_STATUS_PATH, REGISTRY_PATH, TOPOLOGY_PATH } from '../scripts/generate-media-pdp1-surface-phase-status-matrix.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const write = (root, relativePath, content) => {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const json = (root, relativePath, value) => write(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdp1-matrix-'));
  const physical = Array.from({ length: 26 }, (_, i) => ({
    surfaceId: `media.physical.${i}`,
    sourcePath: `modules/${i}`,
    manifestPath: `modules/${i}/build.gradle.kts`,
    owner: 'media-team',
    disposition: i < 8 ? 'SUPPORT_ONLY' : 'PHYSICAL',
    dispositionRationale: 'Fixture topology disposition.',
    consumerSurfaceRefs: [],
    consumerMappingState: 'MAPPED',
    phaseApplicability: { 'PDP-1': { disposition: i < 8 ? 'REFERENCED_ONLY' : 'APPLICABLE', authorityRef: 'authority/domain.yaml', operationAuthorityRef: 'authority/operations.yaml', rationale: 'Fixture explicit PDP-1 applicability.' } },
  }));
  const compositions = Array.from({ length: 7 }, (_, i) => ({
    surfaceId: `media.composition.${i}`,
    kind: 'SEMANTIC_COMPOSITION',
    canonicalOwner: 'media',
    directMeaning: 'Fixture composite meaning.',
    children: [],
    membershipSemantics: { relation: 'CONTAINS' },
    phaseApplicability: { 'PDP-1': { disposition: i === 0 ? 'ROOT_AUTHORITY_REFERENCE' : 'DIRECT_INTEGRATION_CONTRACT', authorityRef: 'authority/domain.yaml', rationale: 'Fixture explicit PDP-1 applicability.' } },
  }));
  const consumers = Array.from({ length: 21 }, (_, i) => ({
    surfaceId: `media.surface.${i}`,
    consumerType: 'SERVICE_API',
    physicalRefs: [],
    bindingState: 'MAPPED',
    statusReason: 'Fixture logical consumer.',
  }));
  const registry = consumers.map((consumer, i) => ({
    surfaceId: consumer.surfaceId,
    owners: ['media-team'],
    consumers: ['users'],
    canonicalDomainConcepts: ['media.domain.artifact'],
    applicablePdpArtifacts: i === 20 ? ['PDP-0'] : ['PDP-0', 'PDP-1'],
    applicabilityDisposition: i === 20 ? 'NOT_ACTIVE_ARCHIVED' : 'TARGET_PENDING_ADMISSION',
    applicabilityRationale: 'Fixture explicit applicability decision.',
    interactionModel: 'authority/domain.yaml',
    contractAuthority: 'authority/operations.yaml',
    upstreamProductTruth: ['authority/domain.yaml'],
    securityAuthorityModel: 'authority/domain.yaml',
  }));
  for (const relative of ['authority/domain.yaml', 'authority/operations.yaml']) write(root, relative, 'fixture: true\n');
  json(root, TOPOLOGY_PATH, { activeManifestCandidateCount: 26, manifestCandidates: physical, compositions, consumerCrosswalk: consumers });
  write(root, REGISTRY_PATH, `surfaces:\n${registry.map((row) => `  - surfaceId: ${row.surfaceId}\n    owners: [media-team]\n    consumers: [users]\n    canonicalDomainConcepts: [media.domain.artifact]\n    applicablePdpArtifacts: [${row.applicablePdpArtifacts.join(', ')}]\n    applicabilityDisposition: ${row.applicabilityDisposition}\n    applicabilityRationale: ${row.applicabilityRationale}\n    interactionModel: ${row.interactionModel}\n    contractAuthority: ${row.contractAuthority}\n    upstreamProductTruth: [authority/domain.yaml]\n    securityAuthorityModel: ${row.securityAuthorityModel}`).join('\n')}\n`);
  const pdp0SourceBytes = Buffer.from('current PDP-0 source');
  write(root, 'authority/pdp0-input.yaml', pdp0SourceBytes);
  json(root, PDP0_STATUS_PATH, { phase: 'PDP-0', status: 'DEV_COMPLETE', sourceShaSet: { 'authority/pdp0-input.yaml': digest(pdp0SourceBytes) } });
  const sourceBytes = Buffer.from('current source');
  write(root, 'authority/phase-input.yaml', sourceBytes);
  const registryBytes = fs.readFileSync(path.join(root, REGISTRY_PATH));
  const topologyBytes = fs.readFileSync(path.join(root, TOPOLOGY_PATH));
  const livePins = {
    'authority/phase-input.yaml': digest(sourceBytes),
    [REGISTRY_PATH]: digest(registryBytes),
    [TOPOLOGY_PATH]: digest(topologyBytes),
  };
  const status = {
    phase: 'PDP-1', status: 'DEV_COMPLETE', mainSha: 'fixture-sha', sourceShaSet: livePins,
    sourceIdentityIds: ['object:artifact'], outstandingMeaningIds: [], directDevelopmentCriteria: { 'P1-01': { testStatus: 'PASS' } },
  };
  const review = {
    phase: 'PDP-1', status: 'APPROVED_PDP1_DEVELOPMENT_SEMANTIC_REVIEW', sourceCutStable: true,
    sourceFingerprints: livePins, reviewedIdentityIds: ['object:artifact'], outstandingMeaningIds: [],
    currentCutReview: { currentSurfaceApplicability: {
      denominator: physical.length + compositions.length + consumers.length,
      physical: physical.length,
      compositions: compositions.length,
      logicalConsumers: consumers.length,
      pdp1ApplicableOrReferenceBound: physical.length + compositions.length + registry.filter((row) => row.applicablePdpArtifacts.includes('PDP-1')).length,
      explicitArchivedNotApplicable: registry.filter((row) => row.applicabilityDisposition === 'NOT_ACTIVE_ARCHIVED').length,
      sourceRefs: [REGISTRY_PATH, TOPOLOGY_PATH],
    } },
  };
  json(root, PDP1_STATUS_PATH, status);
  json(root, PDP1_REVIEW_PATH, review);
  return { root, status, review, pdp0ProjectionPins: {}, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('PDP-1 projection builds exact topology and registry denominator with source-derived N/A', () => {
  const f = fixture();
  try {
    const matrix = buildPdp1SurfaceMatrix({ root: f.root, status: f.status, semanticReview: f.review, pdp0ProjectionPins: f.pdp0ProjectionPins, generatedAt: 'fixture-time' });
    assert.equal(matrix.surfaces.length, 54);
    assert.equal(new Set(matrix.surfaces.map(({ surfaceId }) => surfaceId)).size, 54);
    assert.equal(matrix.denominatorValidation.status, 'PASS');
    assert.equal(matrix.campaign.status, 'DEV_COMPLETE');
    assert.equal(matrix.summary.sourceCurrentDevCompleteCells, 53);
    assert.equal(matrix.summary.archivedLogicalConsumers, 1);
    assert.equal(matrix.surfaces.find(({ surfaceId }) => surfaceId === 'media.surface.20').developmentStatus, 'NOT_ACTIVE_ARCHIVED');
    assert.equal(matrix.surfaces.find(({ surfaceId }) => surfaceId === 'media.physical.0').applicability.disposition, 'REFERENCED_ONLY');
    assert.equal(matrix.claimsBoundary.nativeClosure, 'NOT_PERFORMED');
    const second = buildPdp1SurfaceMatrix({ root: f.root, status: f.status, semanticReview: f.review, pdp0ProjectionPins: f.pdp0ProjectionPins, generatedAt: 'fixture-time' });
    assert.deepEqual(second, matrix);
  } finally { f.cleanup(); }
});

test('incomplete or stale PDP-1 input cannot project any applicable row as DEV_COMPLETE', () => {
  const f = fixture();
  try {
    const incomplete = structuredClone(f.status);
    incomplete.status = 'IN_PROGRESS';
    incomplete.outstandingMeaningIds = ['P1-01:fixture'];
    const matrix = buildPdp1SurfaceMatrix({ root: f.root, status: incomplete, semanticReview: f.review, pdp0ProjectionPins: f.pdp0ProjectionPins, generatedAt: 'fixture-time' });
    assert.equal(matrix.campaign.status, 'IN_PROGRESS');
    assert.equal(matrix.summary.sourceCurrentDevCompleteCells, 0);
    assert.ok(matrix.surfaces.filter((row) => row.applicability.disposition !== 'NOT_ACTIVE_ARCHIVED').every((row) => row.developmentStatus === 'IN_PROGRESS'));
    assert.deepEqual(matrix.unassignedPhaseLevelWork.outstandingMeaningIds, ['P1-01:fixture']);
    assert.ok(matrix.surfaces.filter((row) => row.applicability.disposition !== 'NOT_ACTIVE_ARCHIVED').every((row) => row.remainingPhaseLocalTaskIds === null && row.blockerOwner === 'UNKNOWN_PHASE_LOCAL_OWNER' && row.remainingPhaseLocalTaskMapping === 'UNKNOWN_PHASE_LOCAL_OWNERSHIP'));
    const stale = structuredClone(f.status);
    write(f.root, 'authority/unreviewed-extra.yaml', 'old source');
    stale.sourceShaSet['authority/unreviewed-extra.yaml'] = '0'.repeat(64);
    const staleMatrix = buildPdp1SurfaceMatrix({ root: f.root, status: stale, semanticReview: f.review, pdp0ProjectionPins: f.pdp0ProjectionPins, generatedAt: 'fixture-time' });
    assert.equal(staleMatrix.campaign.status, 'IN_PROGRESS');
    assert.equal(staleMatrix.phaseSourceCurrentness.status, 'STALE');
    assert.ok(staleMatrix.surfaces.filter((row) => row.applicability.disposition !== 'NOT_ACTIVE_ARCHIVED').every((row) => row.developmentStatus === 'IN_PROGRESS' && row.remainingPhaseLocalTaskIds === null && row.blockerOwner === 'UNKNOWN_PHASE_LOCAL_OWNER'));
  } finally { f.cleanup(); }
});

test('identity, applicability and authority inconsistencies fail closed', () => {
  const f = fixture();
  try {
    const duplicate = JSON.parse(fs.readFileSync(path.join(f.root, TOPOLOGY_PATH), 'utf8'));
    duplicate.manifestCandidates[1].surfaceId = duplicate.manifestCandidates[0].surfaceId;
    json(f.root, TOPOLOGY_PATH, duplicate);
    assert.throws(() => buildPdp1SurfaceMatrix({ root: f.root, status: f.status, semanticReview: f.review, pdp0ProjectionPins: f.pdp0ProjectionPins }), /unique, stable surface IDs/);
  } finally { f.cleanup(); }
  const g = fixture();
  try {
    const topology = JSON.parse(fs.readFileSync(path.join(g.root, TOPOLOGY_PATH), 'utf8'));
    delete topology.manifestCandidates[0].phaseApplicability['PDP-1'].rationale;
    json(g.root, TOPOLOGY_PATH, topology);
    const topologyDigest = digest(fs.readFileSync(path.join(g.root, TOPOLOGY_PATH)));
    g.status.sourceShaSet[TOPOLOGY_PATH] = topologyDigest;
    g.review.sourceFingerprints[TOPOLOGY_PATH] = topologyDigest;
    assert.throws(() => buildPdp1SurfaceMatrix({ root: g.root, status: g.status, semanticReview: g.review, pdp0ProjectionPins: g.pdp0ProjectionPins }), /explicit disposition, rationale, and authorityRef/);
  } finally { g.cleanup(); }
});

test('unsupported selector pins and stale native PDP-0 status pins fail closed', () => {
  const f = fixture();
  try {
    const selectorStatus = structuredClone(f.status);
    selectorStatus.sourceShaSet['authority/phase-input.yaml#selector'] = selectorStatus.sourceShaSet['authority/phase-input.yaml'];
    assert.throws(() => buildPdp1SurfaceMatrix({ root: f.root, status: selectorStatus, semanticReview: f.review, pdp0ProjectionPins: f.pdp0ProjectionPins }), /Unsupported PDP-1 source pin selector/);
    const p0Status = JSON.parse(fs.readFileSync(path.join(f.root, PDP0_STATUS_PATH), 'utf8'));
    p0Status.sourceShaSet['authority/pdp0-input.yaml#PDP-0-projection'] = 'projection-fingerprint';
    json(f.root, PDP0_STATUS_PATH, p0Status);
    const projected = buildPdp1SurfaceMatrix({ root: f.root, status: f.status, semanticReview: f.review, pdp0ProjectionPins: { 'authority/pdp0-input.yaml#PDP-0-projection': 'projection-fingerprint' } });
    assert.equal(projected.campaign.status, 'DEV_COMPLETE');
    write(f.root, 'authority/pdp0-input.yaml', 'changed PDP-0 source');
    assert.throws(() => buildPdp1SurfaceMatrix({ root: f.root, status: f.status, semanticReview: f.review, pdp0ProjectionPins: { 'authority/pdp0-input.yaml#PDP-0-projection': 'projection-fingerprint' } }), /PDP-0 native status DEV_COMPLETE with all byte and native projection pins current/);
  } finally { f.cleanup(); }
});
