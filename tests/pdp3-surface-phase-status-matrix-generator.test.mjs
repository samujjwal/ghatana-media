import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  buildPdp3SurfaceMatrix,
  PDP3_STATUS_PATH,
  PDP3_CHANNEL_BINDINGS_PATH,
  PDP0_CAMPAIGN_EXTENSIONS_PATH,
  AUTHORITY_MAP_PATH,
  PDP3_RULE_MANAGEMENT_PROPOSAL_PATH,
  PDP2_INTERFACE_GRAMMAR_PATH,
  isCompleteAudSpec020ChannelExperienceBindings,
} from '../scripts/generate-media-pdp3-surface-phase-status-matrix.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
const readYaml = (relativePath) => parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));

test('AUD-SPEC-020 J-31 channel bindings gate the proposal experience task', () => {
  const journey = readYaml(PDP3_RULE_MANAGEMENT_PROPOSAL_PATH);
  const p0 = readYaml(PDP0_CAMPAIGN_EXTENSIONS_PATH).records.find(({ id }) => id === 'AUD-SPEC-020');
  const proposedChannels = p0.channelApplicability.records[0].channelApplicability.filter(({ disposition }) => disposition === 'PROPOSED_APPLICABLE');
  const p2 = readYaml(PDP2_INTERFACE_GRAMMAR_PATH).ruleManagementProposalInterfaceBinding.channelProposalMappings.mappings;
  const inputs = { bindings: journey.channelExperienceBindings, proposedChannels, p2Mappings: p2, journey };
  assert.equal(isCompleteAudSpec020ChannelExperienceBindings(inputs), true);
  assert.equal(isCompleteAudSpec020ChannelExperienceBindings({ ...inputs, bindings: journey.channelExperienceBindings.slice(0, 7) }), false);
  assert.equal(isCompleteAudSpec020ChannelExperienceBindings({ ...inputs, bindings: journey.channelExperienceBindings.map((binding) => binding.channelRef === 'media.channel.api' ? { ...binding, inheritsChannelRefs: ['media.channel.http-api'] } : binding) }), false);
  assert.equal(isCompleteAudSpec020ChannelExperienceBindings({ ...inputs, journey: { ...journey, status: 'proposal-bound-pdp-3-definition; owner-applicability-review-pending; runtime-not-admitted' } }), false);
});

test('PDP-3 matrix binds all 54 physical, composite, and logical identities to current source fingerprints', () => {
  const status = readJson(PDP3_STATUS_PATH);
  const matrix = buildPdp3SurfaceMatrix({ root, status, generatedAt: 'fixture-time' });
  assert.equal(matrix.surfaces.length, 54);
  assert.equal(new Set(matrix.surfaces.map(({ surfaceId }) => surfaceId)).size, 54);
  assert.equal(matrix.denominatorValidation.status, 'PASS');
  assert.deepEqual(matrix.denominatorValidation.stats, {
    physical: 26, compositions: 7, logicalConsumers: 21, denominator: 54,
    applicablePdp3: 53, explicitNotApplicablePdp3: 1,
  });
  assert.equal(matrix.prerequisiteState.status, 'READY');
  assert.equal(matrix.phaseSourceCurrentness.sourcePinCount, Object.keys(status.sourceShaSet).length);
  const stalePinRefs = [];
  for (const [sourceRef, expected] of Object.entries(status.sourceShaSet)) {
    const current = sourceRef.includes('#') || !fs.existsSync(path.join(root, sourceRef))
      ? null : digest(fs.readFileSync(path.join(root, sourceRef)));
    if (!current || current !== expected) stalePinRefs.push(sourceRef);
  }
  assert.deepEqual(matrix.phaseSourceCurrentness.staleSourcePins.map(({ sourceRef }) => sourceRef).sort(), stalePinRefs.sort());
  assert.equal(matrix.phaseSourceCurrentness.status, stalePinRefs.length ? 'STALE' : 'CURRENT');
  const allTasks = [...matrix.unassignedPhaseLevelWork.tasks, ...matrix.surfaceAssignedWork.tasks];
  assert.equal(matrix.summary.remainingPhaseLocalTaskCount, allTasks.length);
  assert.equal(matrix.summary.remainingPhaseLocalTaskCountKnown, !allTasks.some(({ assignment }) => assignment.startsWith('UNKNOWN')));
  assert.equal(matrix.campaign.status, matrix.nativePdp3Readiness.status === 'READY' ? 'DEV_COMPLETE' : 'IN_PROGRESS');
  assert.equal(matrix.summary.phaseWideTaskCount, matrix.unassignedPhaseLevelWork.tasks.length);
  assert.equal(matrix.summary.mappedSurfaceTaskCount, matrix.surfaceAssignedWork.tasks.length);
  for (const [sourceRef, fingerprint] of Object.entries(matrix.sourceFingerprints)) {
    assert.equal(fingerprint, fs.existsSync(path.join(root, sourceRef)) && fs.statSync(path.join(root, sourceRef)).isFile() ? digest(fs.readFileSync(path.join(root, sourceRef))) : null);
  }
  for (const row of matrix.surfaces) {
    assert.ok(row.applicability.disposition);
    assert.ok(row.applicability.rationale);
    assert.ok(row.applicability.authorityRefs.length > 0);
    assert.ok(row.acceptanceCriterion);
    assert.ok(row.nextLegalAction);
    assert.deepEqual(row.remainingPhaseLocalTaskIds, row.applicability.disposition === 'NOT_ACTIVE_ARCHIVED' || row.applicability.disposition.startsWith('NOT_APPLICABLE') ? [] : row.assignedPhaseLocalTasks.map(({ taskId }) => taskId).sort());
    assert.ok(row.sourceRefs.every((ref) => ref in matrix.sourceFingerprints || ref.includes('*') || fs.existsSync(path.join(root, ref)) && fs.statSync(path.join(root, ref)).isDirectory()));
  }
  assert.equal(matrix.surfaces.filter(({ developmentStatus }) => developmentStatus === 'NOT_ACTIVE_ARCHIVED').length, 1);
});

test('stale channel-edge status tasks remain visibly stale until the PDP-3 projection is regenerated', () => {
  const status = structuredClone(readJson(PDP3_STATUS_PATH));
  const channels = parse(fs.readFileSync(path.join(root, PDP3_CHANNEL_BINDINGS_PATH), 'utf8'));
  assert.equal(channels.edges.length, 61);
  assert.equal(channels.edges.filter(({ logicalDefinitionBlockers, logicalDefinitionDisposition }) => (logicalDefinitionBlockers?.length ?? 0) > 0 || String(logicalDefinitionDisposition ?? '').startsWith('INCOMPLETE')).length, 0);
  status.status = 'IN_PROGRESS';
  status.channelDefinitionCoverage = { ...status.channelDefinitionCoverage, incompleteEdgeIds: channels.edges.slice(0, 18).map(({ id }) => id) };
  status.directDevelopmentCriteria = Object.fromEntries(Object.keys(status.directDevelopmentCriteria).map((criterionId) => [criterionId, { testStatus: 'PASS', testCount: 1, passedTestCount: 1 }]));
  const phaseWideId = 'P3-03:focused-development-tests-not-green-or-source-pinned';
  status.outstandingMeaningIds = [
    phaseWideId,
    ...(status.channelDefinitionCoverage.incompleteEdgeIds ?? []).map((edgeId) => `P3-03:channel-logical-edge-incomplete:${edgeId}`),
  ];
  const matrix = buildPdp3SurfaceMatrix({ root, status, generatedAt: 'fixture-time' });
  assert.equal(matrix.channelBindingCoverage.liveEdgeDenominator, 61);
  assert.equal(matrix.channelBindingCoverage.liveIncompleteEdgeCount, 0);
  assert.equal(matrix.channelBindingCoverage.statusProjectionConsistency, 'STALE');
  assert.equal(matrix.statusProjectionConsistency.statusRecordedIncompleteEdgeCount, 18);
  assert.equal(matrix.statusProjectionConsistency.liveIncompleteEdgeCount, 0);
  assert.equal(matrix.surfaceAssignedWork.tasks.filter(({ taskId }) => taskId.startsWith('P3-03:channel-logical-edge-incomplete:')).length, 0);
  assert.equal(matrix.statusProjectionConsistency.statusOnlyEdgeIds.length, 18);
  assert.ok(matrix.statusProjectionConsistency.staleOutstandingEdgeTaskIds.every(({ status: staleStatus }) => staleStatus === 'STATUS_TASK_NOT_IN_LIVE_INCOMPLETE_EDGE_SET'));

  const phaseWide = matrix.unassignedPhaseLevelWork.tasks.find(({ taskId }) => taskId === phaseWideId);
  assert.ok(phaseWide);
  assert.equal(phaseWide.assignment, 'PHASE_WIDE_TASK');
  assert.deepEqual(phaseWide.surfaceIds, []);
  const authority = parse(fs.readFileSync(path.join(root, AUTHORITY_MAP_PATH), 'utf8'));
  assert.equal(phaseWide.owner, authority.phaseAuthorities.find(({ phase }) => phase === 'PDP-3').owner);
  assert.ok(phaseWide.acceptanceCriterion);

  const audTaskId = 'PDP3-DEFINITION:AUD-SPEC-020:proposal-bound-channel-experiences';
  assert.equal(matrix.surfaceAssignedWork.tasks.some(({ taskId }) => taskId === audTaskId), false);
  const ownerDecision = matrix.externalDecisionHandoffs.find(({ handoffId }) => handoffId === 'PDP0-DECISION:AUD-SPEC-020:channel-applicability-disposition');
  assert.ok(ownerDecision);
  assert.equal(ownerDecision.status, 'PENDING_OWNER_DISPOSITION');
  assert.equal(ownerDecision.ownerApproval, 'NOT_CLAIMED');
  assert.equal(ownerDecision.independentAcceptance, 'NOT_CLAIMED');
  assert.ok(!matrix.surfaceAssignedWork.tasks.some(({ taskId }) => taskId === ownerDecision.handoffId));
  assert.ok(!matrix.unassignedPhaseLevelWork.tasks.some(({ taskId }) => taskId === ownerDecision.handoffId));
  assert.equal(ownerDecision.proposedNotApplicableChannels.length, 3);
  const incompleteMatrix = buildPdp3SurfaceMatrix({ root, status, generatedAt: 'fixture-time', channelExperienceBindingsOverride: readYaml(PDP3_RULE_MANAGEMENT_PROPOSAL_PATH).channelExperienceBindings.slice(0, 7) });
  const audTask = incompleteMatrix.surfaceAssignedWork.tasks.find(({ taskId }) => taskId === audTaskId);
  assert.ok(audTask);
  assert.equal(audTask.taskKind, 'PDP3_EXPERIENCE_DEFINITION');
  assert.equal(audTask.assignment, 'EXPLICIT_CROSS_SURFACE_DEFINITION_SCOPE');
  assert.equal(audTask.denominatorIdentityCount, 54);
  assert.equal(audTask.applicabilityProposalTargets, 37);
  assert.equal(audTask.surfaceIds.length, 37);
  assert.equal(audTask.proposedChannels.length, 8);
  assert.equal(audTask.proposedNotApplicableChannels.length, 3);
  const incompleteOwnerDecision = incompleteMatrix.externalDecisionHandoffs.find(({ handoffId }) => handoffId === 'PDP0-DECISION:AUD-SPEC-020:channel-applicability-disposition');
  assert.ok(incompleteOwnerDecision);
  assert.equal(incompleteOwnerDecision.status, 'PENDING_OWNER_DISPOSITION');
  assert.equal(incompleteOwnerDecision.ownerApproval, 'NOT_CLAIMED');
  const extensions = parse(fs.readFileSync(path.join(root, PDP0_CAMPAIGN_EXTENSIONS_PATH), 'utf8'));
  assert.equal(extensions.records.find(({ id }) => id === 'AUD-SPEC-020').channelApplicability.status, 'PROPOSAL_ONLY; cannot satisfy owner acceptance, independent acceptance, closure, admission, or runtime support');
});
