import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createKernelPlanOwnerAdapter,
  createKernelPlanOwnerRequest,
  dispatchKernelPlanOwnerRequest,
  KERNEL_PLAN_OWNER_RESULT_SCHEMA,
  projectMediaBuildScopedTaskPlanning
} from '../scripts/lib/media-build-scoped-task-planning.mjs';

const queue = JSON.parse(fs.readFileSync('docs/implementation/MEDIA-GTOOL-EXECUTION-QUEUE.v2.json', 'utf8'));
const workPackages = JSON.parse(fs.readFileSync('docs/implementation/MEDIA-BUILD-WORK-PACKAGES.v1.json', 'utf8'));

test('retains the complete campaign and all 19 owner-approved tasks without granting admission', () => {
  const report = projectMediaBuildScopedTaskPlanning({
    queue, workPackages,
    structuralValidation: { structuralStatus: 'PASS', errors: [], sourceBlockers: [], unresolvedBlockerTaskIds: [] }
  });
  assert.deepEqual(report.campaign, {
    stage: 'BUILD / KDEV-STAGE-PLAN-IMPLEMENTATION', sourceIdentityDenominator: 54,
    phaseCellDenominator: 216, packageDenominator: 50, taskDenominator: 57,
    sourceTraceIdentityDenominator: 3186, ownerApprovedOpenTaskDenominator: 19
  });
  assert.equal(report.tasks.length, 19);
  assert.ok(report.tasks.every(task => task.implementationMayBegin === false));
  assert.ok(report.tasks.every(task => ['UNKNOWN_MISSING_EXACT_SOURCE_UNIT_BINDING', 'UNKNOWN_NO_CANONICAL_SURFACE_MATCH'].includes(task.perUnitSourceGateStatus)));
  assert.ok(report.tasks.every(task => task.kernelTaskClosureStatus === 'NOT_PROVEN' && task.kernelPlanReadyStatus === 'NOT_PROVEN'));
  assert.equal(report.trustFabricated, false);
});

test('preserves aggregate stale diagnostics without turning them into a global task gate', () => {
  const report = projectMediaBuildScopedTaskPlanning({
    queue, workPackages,
    structuralValidation: { structuralStatus: 'FAIL', errors: ['stale pin: source-manifest'], sourceBlockers: ['receipt is stale'], unresolvedBlockerTaskIds: ['M-BLD-F00.T01'] }
  });
  assert.equal(report.sourcePlanStructuralDiagnostics.errors[0], 'stale pin: source-manifest');
  assert.ok(report.tasks.every(task => !task.blockers.some(blocker => blocker.reason === 'stale pin: source-manifest')));
  assert.ok(report.tasks.every(task => ['TASK_SOURCE_SELECTORS_CURRENT_ONLY', 'UNKNOWN_OR_STALE_TASK_SOURCE_SELECTORS'].includes(task.sourcePlanningInputStatus)));
  assert.ok(report.tasks.every(task => task.blockers.some(blocker => blocker.reason === 'TASK_TO_SOURCE_UNIT_BINDING_NOT_AUTHORED_IN_PLAN')));
  assert.ok(report.tasks.every(task => task.blockers.some(blocker => blocker.owner === 'Kernel Work Planner')));
});

test('missing approved task rows fail closed without shrinking the campaign denominator', () => {
  const altered = structuredClone(queue);
  altered.tasks = altered.tasks.slice(1);
  const report = projectMediaBuildScopedTaskPlanning({
    queue: altered, workPackages,
    structuralValidation: { structuralStatus: 'PASS', errors: [], sourceBlockers: [], unresolvedBlockerTaskIds: [] }
  });
  assert.equal(report.campaign.ownerApprovedOpenTaskDenominator, 19);
  assert.equal(report.tasks.length, 18);
});

test('maps exact source identity matches to canonical rows and keeps owner binding separate from gate results', () => {
  const task = { taskId: 'M-BLD-X01.T01', ownerRole: 'owner', status: 'OPEN_TECHNICAL_WORK', exactSourceAndTargetAreas: ['runtime-contracts/'], blockingDependencies: '', acceptanceCriterion: 'criterion' };
  const planTask = { id: task.taskId, packageId: 'M-BLD-X01', status: 'ASSIGNED_UNVERIFIED', joinedSourceIdentities: [{ phase: 'PDP-0', kind: 'capability-intent', id: 'cap.alpha' }], predecessorTaskIds: [], fingerprints: { sourcePins: [] } };
  const rows = ['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3'].map((phase, index) => ({
    phase,
    surfaces: [{ surfaceId: 'media.physical.runtime-contracts', sourceCurrent: true, remainingPhaseLocalTaskIds: [], developmentStatus: 'DEV_COMPLETE', applicability: { disposition: 'APPLICABLE', rationale: 'explicit', authorityRef: `matrix-${index}` }, ...(index === 0 ? { capabilityIntentRefs: ['cap.alpha'] } : {}) }]
  }));
  const report = projectMediaBuildScopedTaskPlanning({
    queue: { campaign: { ownerApprovedIncompleteTaskCount: 1 }, tasks: [task] },
    workPackages: { tasks: [planTask], packages: [{ id: 'M-BLD-X01', dependencies: [], taskIds: [task.taskId] }], sourcePins: {} },
    structuralValidation: { structuralStatus: 'PASS' }, surfaceMatrices: rows
  });
  assert.equal(report.tasks[0].sourceUnitCandidates[0].surfaceId, 'media.physical.runtime-contracts');
  assert.equal(report.tasks[0].sourceUnitCandidates[0].phaseGateStatus, 'PASS');
  assert.equal(report.tasks[0].perUnitSourceGateStatus, 'CANDIDATE_ROWS_PASS_OWNER_BINDING_REQUIRED');
  assert.equal(report.tasks[0].implementationMayBegin, false);
  rows[2].surfaces[0].sourceCurrent = false;
  const blocked = projectMediaBuildScopedTaskPlanning({
    queue: { campaign: { ownerApprovedIncompleteTaskCount: 1 }, tasks: [task] },
    workPackages: { tasks: [planTask], packages: [{ id: 'M-BLD-X01', dependencies: [], taskIds: [task.taskId] }], sourcePins: {} },
    structuralValidation: { structuralStatus: 'PASS' }, surfaceMatrices: rows
  });
  assert.equal(blocked.tasks[0].sourceUnitCandidates[0].phaseGateStatus, 'FAIL');
});

test('Kernel Plan owner request requires exact selected task, operation, and revision', () => {
  const planningReport = { recordKind: 'READ_ONLY_OWNER_PLAN_INPUT_NOT_ADMISSION_OR_TRANSITION', campaign: { taskDenominator: 57 }, tasks: [{ taskId: 'M-BLD-F03.T01', sourceJoinIdentityCount: 2, taskSourceSelectorStatus: 'PINNED_CURRENT', sourceUnitCandidates: [], predecessorTaskIds: [] }] };
  const request = createKernelPlanOwnerRequest({ planningReport, operationId: 'plan-review-1', operation: 'KCRIT-PLAN-TASK-CLOSURE', selectedTaskIds: ['M-BLD-F03.T01'], expectedOwnerRevision: 7 });
  assert.equal(request.schemaVersion, 'ghatana.kernel-plan-owner-request.v1');
  assert.equal(request.criterionId, 'KCRIT-PLAN-TASK-CLOSURE');
  assert.throws(() => createKernelPlanOwnerRequest({ planningReport, operationId: 'plan-ready-1', operation: 'KCRIT-PLAN-READY', selectedTaskIds: ['M-BLD-F03.T01'], expectedOwnerRevision: 7 }), /PLAN_READY_REQUIRES_COMPLETE_TASK_DENOMINATOR/u);
  assert.throws(() => createKernelPlanOwnerRequest({ planningReport, operationId: 'x', operation: 'KCRIT-PLAN-TASK-CLOSURE', selectedTaskIds: ['MISSING'], expectedOwnerRevision: 7 }), /SELECTED_TASK_UNKNOWN/u);
  assert.throws(() => createKernelPlanOwnerRequest({ planningReport, operationId: 'x', operation: 'KCRIT-PLAN-TASK-CLOSURE', selectedTaskIds: ['M-BLD-F03.T01', 'M-BLD-F03.T01'], expectedOwnerRevision: 7 }), /SELECTED_TASK_IDS_INVALID/u);
});

test('Kernel Plan dispatch blocks without the Gtool host registration and never falls back locally', async () => {
  let calls = 0;
  const request = { schemaVersion: 'ghatana.kernel-plan-owner-request.v1', recordKind: 'READ_ONLY_OWNER_KERNEL_PLAN_EVALUATION_REQUEST', operationId: 'op-1', operation: 'KCRIT-PLAN-READY', criterionId: 'KCRIT-PLAN-READY', scopeKind: 'TASK_SET', selectedTaskIds: ['T1'], expectedOwnerRevision: 1, planInputFingerprint: `sha256:${'a'.repeat(64)}` };
  const result = await dispatchKernelPlanOwnerRequest({ request, ownerHostPort: null });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.reason, 'KERNEL_PLAN_OWNER_HOST_REGISTRATION_REQUIRED');
  assert.equal(calls, 0);
  assert.throws(() => createKernelPlanOwnerAdapter(), /KERNEL_PLAN_OWNER_HOST_RESOLVER_REQUIRED/u);
  const hostUnavailable = createKernelPlanOwnerAdapter({ resolveRegisteredOwnerPort: async () => { throw new Error('no host'); } });
  assert.equal((await hostUnavailable.evaluate(request)).reason, 'KERNEL_PLAN_OWNER_HOST_REGISTRATION_REQUIRED');
});

test('Kernel Plan dispatch binds the owner result to request, revision, and input fingerprint', async () => {
  const request = { schemaVersion: 'ghatana.kernel-plan-owner-request.v1', recordKind: 'READ_ONLY_OWNER_KERNEL_PLAN_EVALUATION_REQUEST', operationId: 'op-2', operation: 'KCRIT-PLAN-TASK-CLOSURE', criterionId: 'KCRIT-PLAN-TASK-CLOSURE', scopeKind: 'TASK_SET', selectedTaskIds: ['T2'], expectedOwnerRevision: 4, planInputFingerprint: `sha256:${'b'.repeat(64)}` };
  const port = {
    authorityRef: 'kernel-work-planner-owner', registrationRef: 'host-registration:wp-1',
    evaluateKernelPlan: async req => ({ schemaVersion: KERNEL_PLAN_OWNER_RESULT_SCHEMA, recordKind: 'HOST_OWNER_KERNEL_PLAN_DECISION', operationId: req.operationId, operation: req.operation, criterionId: req.criterionId, scopeKind: req.scopeKind, selectedTaskIds: req.selectedTaskIds, expectedOwnerRevision: req.expectedOwnerRevision, ownerRevision: 4, planInputFingerprint: req.planInputFingerprint, authorityRef: 'kernel-work-planner-owner', decisionRef: 'owner-readback:42', taskClosure: 'PASS', planReady: 'NOT_EVALUATED' })
  };
  const result = await dispatchKernelPlanOwnerRequest({ request, ownerHostPort: port });
  assert.equal(result.status, 'HOST_RESULT_BOUND');
  assert.equal(result.taskClosure, 'PASS');
  assert.equal(result.mediaAdapterDecision, 'NONE');
  const mismatched = await dispatchKernelPlanOwnerRequest({ request, ownerHostPort: { ...port, evaluateKernelPlan: async req => ({ schemaVersion: KERNEL_PLAN_OWNER_RESULT_SCHEMA, recordKind: 'HOST_OWNER_KERNEL_PLAN_DECISION', operationId: req.operationId, operation: req.operation, criterionId: req.criterionId, scopeKind: req.scopeKind, selectedTaskIds: req.selectedTaskIds, expectedOwnerRevision: req.expectedOwnerRevision, ownerRevision: 5, planInputFingerprint: `sha256:${'c'.repeat(64)}`, authorityRef: 'kernel-work-planner-owner', decisionRef: 'owner-readback:43', taskClosure: 'PASS', planReady: 'NOT_EVALUATED' }) } });
  assert.equal(mismatched.status, 'UNKNOWN');
  assert.equal(mismatched.reason, 'KERNEL_PLAN_OWNER_RESULT_BINDING_INVALID');
});

test('Kernel Plan transport unknown is terminal for this dispatch and Plan Ready cannot bypass task closure', async () => {
  const request = { schemaVersion: 'ghatana.kernel-plan-owner-request.v1', recordKind: 'READ_ONLY_OWNER_KERNEL_PLAN_EVALUATION_REQUEST', operationId: 'op-3', operation: 'KCRIT-PLAN-READY', criterionId: 'KCRIT-PLAN-READY', scopeKind: 'TASK_SET', selectedTaskIds: ['T3'], expectedOwnerRevision: 2, planInputFingerprint: `sha256:${'d'.repeat(64)}` };
  const port = { authorityRef: 'kernel-work-planner-owner', registrationRef: 'host-registration:wp-1', evaluateKernelPlan: async () => { throw new Error('transport'); } };
  const unknown = await dispatchKernelPlanOwnerRequest({ request, ownerHostPort: port });
  assert.equal(unknown.status, 'UNKNOWN');
  assert.equal(unknown.redispatchAllowed, false);
  const bypass = await dispatchKernelPlanOwnerRequest({ request, ownerHostPort: { ...port, evaluateKernelPlan: async req => ({ schemaVersion: KERNEL_PLAN_OWNER_RESULT_SCHEMA, recordKind: 'HOST_OWNER_KERNEL_PLAN_DECISION', operationId: req.operationId, operation: req.operation, criterionId: req.criterionId, scopeKind: req.scopeKind, selectedTaskIds: req.selectedTaskIds, expectedOwnerRevision: req.expectedOwnerRevision, ownerRevision: 2, planInputFingerprint: req.planInputFingerprint, authorityRef: 'kernel-work-planner-owner', decisionRef: 'owner-readback:44', taskClosure: 'NOT_EVALUATED', planReady: 'APPROVED' }) } });
  assert.equal(bypass.status, 'UNKNOWN');
  assert.equal(bypass.planReady, 'NOT_EVALUATED');
});
