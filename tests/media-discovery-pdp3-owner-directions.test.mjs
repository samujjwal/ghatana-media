import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const plan = read('docs/implementation/observations/media-discovery-pdp3-owner-binding-directions-2026-10-13.json');
const prev = read('docs/implementation/observations/media-discovery-pdp3-mdc30-currentness-2026-10-13-r1.json');
const matrix = read('docs/implementation/media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json');
const work = read('docs/implementation/media-discovery-reconciliation-worklist-2026-10-13.json');

test('delegated PDP3 owner packet exactly enumerates 30 journeys and source-intended channels', () => {
  assert.equal(plan.journeyChannelTasks.length, 30);
  assert.equal(new Set(plan.journeyChannelTasks.map(j => j.journeyId)).size, 30);
  for (let i = 1; i <= 30; i++) assert.ok(plan.journeyChannelTasks.some(j => j.journeyId === 'J-' + String(i).padStart(2,'0')));
  assert.equal(plan.journeyChannelTasks.reduce((n,j)=>n+j.channelBindingsToAuthor.length,0),61);
  assert.ok(plan.journeyChannelTasks.every(j => j.contractSource.endsWith('.yaml') && j.channelBindingsToAuthor.every(c => c.consumerSurfaceId && c.sourceAuthorities?.length)));
  assert.deepEqual(plan.journeyChannelTasks.find(j => j.journeyId === 'J-03').approvedIntendedChannels,[
    'media.channel.web','media.channel.cli','media.channel.grpc-api','media.channel.sdk']);
  assert.deepEqual(plan.journeyChannelTasks.find(j => j.journeyId === 'J-20').approvedIntendedChannels,[
    'media.channel.web','media.channel.cli']);
  assert.ok(['J-29','J-30'].every(id => plan.journeyChannelTasks.find(j => j.journeyId === id).observedChannelDeclaration === 'channelRefs'));
});

test('14 consequential step decisions have the exact observed step/action/operation identities and no fabricated transition IDs', () => {
  const expected = prev.findings.find(f => f.id === 'MDC30-STEP-STATE-BINDING-REVIEW').evidence.purposeBindingClassification.consequentialStepRefs;
  assert.equal(expected.length, 14);
  assert.equal(plan.consequentialStepTasks.length,14);
  assert.deepEqual(new Set(plan.consequentialStepTasks.map(s => s.stepRef)),new Set(expected.map(s => s.step)));
  assert.ok(plan.consequentialStepTasks.every(s => s.actionRef && s.exactOrLogicalOperationRefs.length && s.exactPdp1TransitionId.startsWith('NOT_ESTABLISHED')));
  assert.equal(plan.approvalRules.technicalMappingsCompleted,false);
});

test('integration applicability is an internal approved choice, not retroactive source-currentness or external qualification', () => {
  assert.equal(plan.integration.ownerApprovedApplicability,'PDP3_APPLICABLE_CONTRACT_ONLY_HOST_DEPENDENT');
  assert.equal(plan.integration.ownerDecisionRecordedNotCanonicalUpdate,true);
  assert.equal(plan.integration.requiredEdits.applicabilityDisposition,'TARGET_HOST_CONTRACT_PENDING');
  const row = matrix.cells.find(r => r.cellId === 'media.surface.integrations::PDP-3');
  assert.equal(row.ownerApprovedApplicabilityDisposition,plan.integration.ownerApprovedApplicability);
  assert.equal(row.currentPhaseExitPublished,false);
});

test('phase lock retains prior exits, open PDP3, no Build/closure/Delivery false assertions', () => {
  assert.deepEqual(work.campaign.remainingDiscoveryTaskIds,['MDC-30','MDC30-V-01','MDC-31','MDC-32','MDC-40','MDC-41']);
  const expectedMdc30Subtasks = [
    ...Array.from({length: 30}, (_, i) => `MDC30-C-${String(i + 1).padStart(2, '0')}`),
    ...Array.from({length: 14}, (_, i) => `MDC30-S-${String(i + 1).padStart(2, '0')}`),
    'MDC30-I-01',
    'MDC30-E-01',
  ];
  assert.deepEqual(work.tasks.find(t => t.id === 'MDC-30').subtaskIds, expectedMdc30Subtasks);
  assert.equal(work.campaign.activePhase,'PDP-3');
  assert.deepEqual(work.campaign.completedPredecessorRecheckTaskIds,['RC-P0-01','RC-P1-01','RC-P2-01']);
  assert.deepEqual(work.campaign.requiredPredecessorRecheckTaskIds,[]);
  assert.equal(matrix.status.pdp0,'R15_TECHNICAL_PASS_50_OF_50_146_PATHS; INTERNAL_IMPACT_DISPOSITION_ONLY; OWNER_ACCEPTANCE_NOT_CLAIMED');
  assert.equal(matrix.status.pdp1,'R30_PASS_50_OF_50_329_PATHS_DEV_COMPLETE_ZERO_OUTSTANDING_MEANING; EXACT_CUT_OWNER_ACCEPTANCE_NOT_RECORDED; PASS_WITH_EXPECTED_STRICT_ADMISSION_FINDING');
  assert.equal(matrix.status.pdp2,'R19_PASS_50_OF_50_405_PATHS_AGAINST_PDP1_R30; DEV_COMPLETE_ZERO_OUTSTANDING_MEANING; EXACT_CUT_OWNER_ACCEPTANCE_NOT_RECORDED');
  assert.match(matrix.status.pdp3,/ACTIVE_MDC30_SOURCE_GAP_RESOLUTION; R6_NOT_CAPTURED; R5_HISTORICAL_BASELINE/u);
  assert.equal(matrix.currentPhase,'PDP-3');
  assert.equal(plan.approvalRules.newMdc30ExitPublished,false);
  assert.equal(matrix.status.discovery,'FAIL_PDP3_DEFINITION_COMPLETION_PENDING');
  assert.equal(matrix.status.build,'NOT_ENTERED');
  assert.equal(matrix.status.nativePdpClosure,'NOT_ENTERED');
  assert.equal(matrix.status.delivery,'BLOCKED');
});
