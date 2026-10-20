import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { projectPdp0DefinitionExtensionApplicability, readSources } from '../scripts/check-media-pdp0-surface-denominator.mjs';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(resolve(root, '../ghatana-tools/package.json'));
const parseYaml = require('yaml').parse;
const matrixPath = 'docs/implementation/verification/pdp-38/pdp0-surface-phase-status-matrix.json';
const extensionPath = '.product-experience/pdp-0-product-truth/campaign-extensions.yaml';
const appPath = '.product-experience/pdp-0-product-truth/applications-channels.yaml';
const decisionPath = '.product-experience/decision-log.md';
const read = path => readFileSync(resolve(root, path), 'utf8');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const expectedCounts = {
  OWNER_DECIDED_APPLICABLE: 14,
  DERIVED_AGGREGATE_OWNER_DECISION: 21,
  NOT_APPLICABLE_OWNER_DECISION: 3430,
  NOT_APPLICABLE_SUPPORT: 616,
  NOT_APPLICABLE_ARCHIVED: 77,
};

test('PXD-207 source records bind seven exact feature decisions and complete explicit exclusions', () => {
  const applications = parseYaml(read(appPath));
  const campaign = parseYaml(read(extensionPath));
  const records = applications.coordinatorDefinitionExtensionApplicability.records;
  const campaignRecords = campaign.currentDefinitionPopulation.records;
  assert.equal(records.length, 7);
  assert.equal(campaignRecords.length, 7);
  assert.equal(campaign.currentDefinitionPopulation.currentCapabilityDefinitions, 469);
  assert.equal(campaign.currentDefinitionPopulation.definitionExtensionCapabilityLeaves, 7);
  assert.equal(applications.coordinatorDefinitionExtensionApplicability.decisionRef, `${decisionPath}#PXD-207`);
  assert.equal(applications.coordinatorDefinitionExtensionApplicability.ownerApproval, 'NOT_CLAIMED');
  assert.equal(applications.coordinatorDefinitionExtensionApplicability.independentAcceptance, 'NOT_CLAIMED');
  assert.equal(applications.coordinatorDefinitionExtensionApplicability.executionAdmission, 'NOT_ADMITTED');

  for (const row of records) {
    const decision = row.decision;
    const campaignRow = campaignRecords.find(item => item.capabilityId === row.capabilityRef);
    assert.ok(campaignRow, `${row.capabilityRef} has a campaign binding`);
    assert.deepEqual(campaignRow.declaredSupportedChannelRefs, [row.candidateChannelRef]);
    assert.equal(decision.decisionRef, `${decisionPath}#PXD-207`);
    assert.equal(decision.status, 'DELEGATED_PDP0_APPLICABILITY_DECISION');
    assert.equal(decision.ownerApproval, 'NOT_CLAIMED');
    assert.equal(decision.independentAcceptance, 'NOT_CLAIMED');
    assert.equal(decision.executionAdmission, 'NOT_ADMITTED');
    assert.equal(decision.excludedChannelRefs.length, 10);
    assert.equal(decision.excludedSurfaceRefs.length, 40);
    assert.ok(decision.excludedChannelRefs.every(item => item.rationale.trim()));
    assert.ok(decision.excludedSurfaceRefs.every(item => item.rationale.trim()));
    assert.ok(decision.sourceRefs.includes(`${decisionPath}#PXD-207`));
    assert.ok(decision.sourceRefs.some(ref => ref.includes(`/@audit_id=${row.sourceAuditIds[0]}/owner_surface_proposal`)));
  }
});

test('PDP-0 matrix projection resolves all 4,158 channel-by-surface cells from PXD-207', () => {
  const matrix = JSON.parse(read(matrixPath));
  const { registry, topology, authority } = readSources(root);
  const projection = projectPdp0DefinitionExtensionApplicability(registry, topology, authority);
  assert.equal(projection.ok, true, JSON.stringify(projection.findings));
  assert.equal(projection.records.length, 4158);
  assert.equal(projection.surfaceCellCount, 378);
  assert.deepEqual(projection.counts, expectedCounts);
  assert.deepEqual(matrix.definitionExtensionApplicability, {
    status: 'SOURCE_CURRENT_OWNER_DECISIONS_COMPLETE',
    extensionCount: 7,
    surfaceIdentityCount: 54,
    channelCount: 11,
    surfaceCellCount: 378,
    cellCount: 4158,
    surfaceCellCounts: projection.surfaceCounts,
    cellCounts: expectedCounts,
    outstandingTaskId: null,
    ownerApproval: 'NOT_CLAIMED',
    independentAcceptance: 'NOT_CLAIMED',
  });
  assert.equal(matrix.summary.unknownExtensionApplicabilityCells, 0);
  assert.equal(matrix.summary.proposedDirectChannelSurfaceCells, 14);
  assert.equal(matrix.summary.derivedAggregateProposalCells, 21);

  const expected = new Map(projection.records.map(cell => [`${cell.surfaceId}\u0000${cell.capabilityRef}\u0000${cell.channelRef}`, cell]));
  for (const surface of matrix.surfaces) {
    const evidence = (surface.campaignExtensionApplicability ?? []).filter(item => item.definitionExtensionId);
    assert.equal(evidence.length, 77, `${surface.surfaceId} has seven extensions × eleven channels`);
    for (const item of evidence) {
      const cell = expected.get(`${surface.surfaceId}\u0000${item.capabilityRef}\u0000${item.channelRef}`);
      assert.ok(cell, `${surface.surfaceId}/${item.capabilityRef}/${item.channelRef} exists`);
      for (const field of ['disposition', 'decisionRef', 'ownerApproval', 'independentAcceptance', 'executionAdmission', 'rationale']) {
        assert.equal(item[field], cell[field]);
      }
      assert.deepEqual(item.channelRefs, cell.channelRefs);
    }
  }
  assert.equal(expected.size, 4158);
});

test('support-only topology changes invalidate the source decision instead of promoting a composite', () => {
  const { registry, topology, authority } = readSources(root);
  const changedTopology = structuredClone(topology);
  const changedAuthority = structuredClone(authority);
  const extension = changedAuthority.applications.coordinatorDefinitionExtensionApplicability.records
    .find(item => item.capabilityRef === 'media.recipe.specification.compile');
  const owner = changedTopology.consumerCrosswalk.find(item => item.surfaceId === extension.sourceOwnerSurfaceRef);
  assert.ok(owner);
  owner.physicalRefs = ['media.physical.libs-media-experience-simulation'];
  const projection = projectPdp0DefinitionExtensionApplicability(registry, changedTopology, changedAuthority);
  assert.equal(projection.ok, false);
  assert.ok(projection.findings.some(item => item.code === 'PDP0_EXTENSION_APPLICABILITY_RECORD'));
});

test('PDP-0 surface matrix pins PXD-207 applicability source fingerprints', () => {
  const matrix = JSON.parse(read(matrixPath));
  assert.equal(matrix.sourceFingerprints[extensionPath], sha256(read(extensionPath)));
  assert.equal(matrix.sourceFingerprints[decisionPath], sha256(read(decisionPath)));
  assert.equal(matrix.sourceFingerprints[appPath], sha256(read(appPath)));
  const serialized = JSON.stringify(Object.entries(matrix.sourceFingerprints).sort(([a], [b]) => a.localeCompare(b)));
  assert.equal(matrix.sourceFingerprintSetSha256, sha256(serialized));
});
