import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sourceDigestCache = new Map();
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const currentDigest = absolutePath => {
  if (!sourceDigestCache.has(absolutePath)) {
    sourceDigestCache.set(absolutePath, fs.existsSync(absolutePath)
      ? crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex')
      : null);
  }
  return sourceDigestCache.get(absolutePath);
};

export const KERNEL_PLAN_OWNER_REQUEST_SCHEMA = 'ghatana.kernel-plan-owner-request.v1';
export const KERNEL_PLAN_OWNER_RESULT_SCHEMA = 'ghatana.kernel-plan-owner-result.v1';
const PLAN_TASK_CLOSURE = 'KCRIT-PLAN-TASK-CLOSURE';
const PLAN_READY = 'KCRIT-PLAN-READY';

/**
 * @typedef {object} KernelPlanOwnerRequest
 * @property {'ghatana.kernel-plan-owner-request.v1'} schemaVersion
 * @property {'READ_ONLY_OWNER_KERNEL_PLAN_EVALUATION_REQUEST'} recordKind
 * @property {string} operationId stable idempotency/reconciliation identity
 * @property {'KCRIT-PLAN-TASK-CLOSURE'|'KCRIT-PLAN-READY'} operation
 * @property {string} criterionId exact Kernel criterion
 * @property {'TASK_SET'|'COMPLETE_PLAN'} scopeKind result is bounded to the selected task set
 * @property {number} expectedOwnerRevision optimistic owner-state fence
 * @property {string[]} selectedTaskIds exact selected task denominator
 * @property {string} planInputFingerprint SHA-256 of exact selected input rows
 */
/**
 * @typedef {object} KernelPlanOwnerDecision
 * @property {'ghatana.kernel-plan-owner-result.v1'} schemaVersion
 * @property {'HOST_OWNER_KERNEL_PLAN_DECISION'} recordKind
 * @property {string} operationId
 * @property {'KCRIT-PLAN-TASK-CLOSURE'|'KCRIT-PLAN-READY'} operation
 * @property {string} criterionId
 * @property {'TASK_SET'|'COMPLETE_PLAN'} scopeKind
 * @property {string[]} selectedTaskIds
 * @property {number} expectedOwnerRevision
 * @property {number} ownerRevision
 * @property {string} planInputFingerprint
 * @property {string} authorityRef
 * @property {string} decisionRef source-bound owner readback reference
 * @property {'PASS'|'FAIL'|'NOT_EVALUATED'} taskClosure
 * @property {'APPROVED'|'DENIED'|'NOT_EVALUATED'} planReady
 */

/** Build a stable, read-only request packet; only the owner host can decide. */
export function createKernelPlanOwnerRequest({ planningReport, operationId, operation, selectedTaskIds, expectedOwnerRevision }) {
  if (!planningReport || planningReport.recordKind !== 'READ_ONLY_OWNER_PLAN_INPUT_NOT_ADMISSION_OR_TRANSITION') throw new Error('PLAN_INPUT_INVALID');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(operationId ?? '')) throw new Error('OPERATION_ID_INVALID');
  if (![PLAN_TASK_CLOSURE, PLAN_READY].includes(operation)) throw new Error('PLAN_OPERATION_INVALID');
  if (!Array.isArray(selectedTaskIds) || selectedTaskIds.length === 0 || new Set(selectedTaskIds).size !== selectedTaskIds.length) throw new Error('SELECTED_TASK_IDS_INVALID');
  if (!Number.isSafeInteger(expectedOwnerRevision) || expectedOwnerRevision < 0) throw new Error('EXPECTED_OWNER_REVISION_INVALID');
  const taskMap = new Map((planningReport.tasks ?? []).map(task => [task.taskId, task]));
  if (operation === PLAN_READY && taskMap.size !== planningReport.campaign?.taskDenominator) throw new Error('PLAN_READY_REQUIRES_COMPLETE_TASK_DENOMINATOR');
  const tasks = selectedTaskIds.map(taskId => {
    const task = taskMap.get(taskId);
    if (!task) throw new Error(`SELECTED_TASK_UNKNOWN:${taskId}`);
    return task;
  });
  const input = {
    schemaVersion: KERNEL_PLAN_OWNER_REQUEST_SCHEMA,
    recordKind: 'READ_ONLY_OWNER_KERNEL_PLAN_EVALUATION_REQUEST',
    operationId,
    operation,
    criterionId: operation,
    scopeKind: selectedTaskIds.length === planningReport.campaign?.taskDenominator ? 'COMPLETE_PLAN' : 'TASK_SET',
    expectedOwnerRevision,
    campaign: planningReport.campaign,
    selectedTaskIds: [...selectedTaskIds],
    planInputFingerprint: `sha256:${crypto.createHash('sha256').update(JSON.stringify(tasks)).digest('hex')}`,
    sourceInputs: tasks.map(task => ({
      taskId: task.taskId,
      exactSourceAndTargetAreas: task.exactSourceAndTargetAreas,
      sourceJoinIdentityCount: task.sourceJoinIdentityCount,
      taskSourceSelectorStatus: task.taskSourceSelectorStatus,
      sourceUnitCandidates: task.sourceUnitCandidates,
      predecessorTaskIds: task.predecessorTaskIds,
      declaredPackageDependencyIds: task.declaredPackageDependencyIds
    }))
  };
  return Object.freeze(input);
}

/**
 * Host adapter port. Implementations must come from the Gtool host registration
 * path; a Media-local adapter cannot authenticate an owner or create evidence.
 * @typedef {{ authorityRef: string, registrationRef: string, evaluateKernelPlan: (request: object) => Promise<object> }} KernelPlanOwnerHostPort
 */
export async function dispatchKernelPlanOwnerRequest({ request, ownerHostPort }) {
  if (request?.schemaVersion !== KERNEL_PLAN_OWNER_REQUEST_SCHEMA || request?.recordKind !== 'READ_ONLY_OWNER_KERNEL_PLAN_EVALUATION_REQUEST') {
    return { status: 'BLOCKED', reason: 'PLAN_OWNER_REQUEST_INVALID', taskClosure: 'NOT_EVALUATED', planReady: 'NOT_EVALUATED' };
  }
  if (!SHA256.test(request.planInputFingerprint ?? '') || typeof request.operationId !== 'string'
      || ![PLAN_TASK_CLOSURE, PLAN_READY].includes(request.operation)
      || request.criterionId !== request.operation || !Number.isSafeInteger(request.expectedOwnerRevision)
      || !['TASK_SET', 'COMPLETE_PLAN'].includes(request.scopeKind)
      || !Array.isArray(request.selectedTaskIds) || request.selectedTaskIds.length === 0
      || new Set(request.selectedTaskIds).size !== request.selectedTaskIds.length) {
    return { status: 'BLOCKED', reason: 'PLAN_OWNER_REQUEST_BINDING_INVALID', taskClosure: 'NOT_EVALUATED', planReady: 'NOT_EVALUATED' };
  }
  if (!ownerHostPort || typeof ownerHostPort.evaluateKernelPlan !== 'function'
      || typeof ownerHostPort.authorityRef !== 'string' || !ownerHostPort.authorityRef
      || typeof ownerHostPort.registrationRef !== 'string' || !ownerHostPort.registrationRef) {
    return { status: 'BLOCKED', reason: 'KERNEL_PLAN_OWNER_HOST_REGISTRATION_REQUIRED', taskClosure: 'NOT_EVALUATED', planReady: 'NOT_EVALUATED' };
  }
  let hostResult;
  try {
    hostResult = await ownerHostPort.evaluateKernelPlan(request);
  } catch {
    return { status: 'UNKNOWN', reason: 'KERNEL_PLAN_OWNER_HOST_TRANSPORT_UNKNOWN', taskClosure: 'NOT_EVALUATED', planReady: 'NOT_EVALUATED', redispatchAllowed: false };
  }
  const valid = hostResult?.schemaVersion === KERNEL_PLAN_OWNER_RESULT_SCHEMA
    && hostResult.recordKind === 'HOST_OWNER_KERNEL_PLAN_DECISION'
    && hostResult.operationId === request.operationId
    && hostResult.operation === request.operation
    && hostResult.criterionId === request.criterionId
    && hostResult.scopeKind === request.scopeKind
    && JSON.stringify(hostResult.selectedTaskIds) === JSON.stringify(request.selectedTaskIds)
    && hostResult.expectedOwnerRevision === request.expectedOwnerRevision
    && hostResult.planInputFingerprint === request.planInputFingerprint
    && /^sha256:[a-f0-9]{64}$/u.test(hostResult.planInputFingerprint ?? '')
    && typeof hostResult.authorityRef === 'string' && hostResult.authorityRef === ownerHostPort.authorityRef
    && typeof hostResult.decisionRef === 'string' && hostResult.decisionRef.length > 0
    && Number.isSafeInteger(hostResult.ownerRevision) && hostResult.ownerRevision >= request.expectedOwnerRevision
    && (hostResult.taskClosure === 'PASS' || hostResult.taskClosure === 'FAIL' || hostResult.taskClosure === 'NOT_EVALUATED')
    && (hostResult.planReady === 'APPROVED' || hostResult.planReady === 'DENIED' || hostResult.planReady === 'NOT_EVALUATED')
    && (request.operation !== PLAN_TASK_CLOSURE || ['PASS', 'FAIL'].includes(hostResult.taskClosure))
    && (request.operation !== PLAN_TASK_CLOSURE || hostResult.planReady === 'NOT_EVALUATED')
    && (request.operation !== PLAN_READY || hostResult.planReady !== 'NOT_EVALUATED')
    && (hostResult.planReady !== 'APPROVED' || hostResult.taskClosure === 'PASS');
  if (!valid) return { status: 'UNKNOWN', reason: 'KERNEL_PLAN_OWNER_RESULT_BINDING_INVALID', taskClosure: 'NOT_EVALUATED', planReady: 'NOT_EVALUATED', redispatchAllowed: false };
  return {
    status: 'HOST_RESULT_BOUND',
    authorityRef: ownerHostPort.authorityRef,
    registrationRef: ownerHostPort.registrationRef,
    decisionRef: hostResult.decisionRef,
    ownerRevision: hostResult.ownerRevision,
    taskClosure: hostResult.taskClosure,
    planReady: hostResult.planReady,
    planInputFingerprint: hostResult.planInputFingerprint,
    authenticationStatus: 'DELEGATED_TO_GTOOL_HOST_REGISTRATION',
    mediaAdapterDecision: 'NONE'
  };
}

/**
 * Construct a thin adapter around a Gtool host's registered owner-port resolver.
 * This module deliberately cannot register that authority itself.
 */
export function createKernelPlanOwnerAdapter({ resolveRegisteredOwnerPort } = {}) {
  if (typeof resolveRegisteredOwnerPort !== 'function') throw new Error('KERNEL_PLAN_OWNER_HOST_RESOLVER_REQUIRED');
  return Object.freeze({
    evaluate: async request => {
      let registration;
      try {
        registration = await resolveRegisteredOwnerPort({ capability: 'kernel-plan-owner-evaluation', operationId: request?.operationId });
      } catch {
        return { status: 'BLOCKED', reason: 'KERNEL_PLAN_OWNER_HOST_REGISTRATION_REQUIRED', taskClosure: 'NOT_EVALUATED', planReady: 'NOT_EVALUATED' };
      }
      return dispatchKernelPlanOwnerRequest({ request, ownerHostPort: registration });
    }
  });
}

/**
 * Fail-closed planning view for owner-approved Media Build tasks.
 * This is an input packet for Kernel/Lifecycle owners, never task closure,
 * Plan Ready, source admission, or a stage transition.
 */
export function projectMediaBuildScopedTaskPlanning({ queue, workPackages, structuralValidation, phaseSourceRecords = [], phaseProjectionPins = {}, surfaceMatrices = [] }) {
  const campaign = queue?.campaign ?? {};
  const approvedRows = queue?.tasks ?? [];
  const approved = new Map(approvedRows.map(task => [task.taskId, task]));
  const planTasks = new Map((workPackages?.tasks ?? []).map(task => [task.id, task]));
  const packages = new Map((workPackages?.packages ?? []).map(pkg => [pkg.id, pkg]));
  const sourcePinMap = new Map(Object.entries(workPackages?.sourcePins ?? {}));
  const phasePinMaps = new Map(phaseSourceRecords.map(row => [row.phase, row.sourceShaSet ?? {}]));
  const tasks = [...approved.values()].map(task => {
    const planTask = planTasks.get(task.taskId);
    const packageRow = planTask ? packages.get(planTask.packageId) : null;
    const predecessorTaskIds = [...new Set([...(planTask?.predecessorTaskIds ?? []), ...(packageRow?.dependencies ?? []).flatMap(id => packages.get(id)?.taskIds ?? [])])].sort();
    const predecessorReadback = predecessorTaskIds.map(id => ({
      taskId: id,
      status: planTasks.get(id)?.status ?? 'UNKNOWN',
      accepted: false,
      evidenceStatus: 'NO_OWNER_BOUND_TASK_COMPLETION_READBACK'
    }));
    const dependencyGateStatus = predecessorReadback.some(row => row.status === 'UNKNOWN')
      ? 'UNKNOWN'
      : predecessorReadback.length ? 'FAIL' : 'UNKNOWN';
    const selectors = new Map();
    for (const row of planTask?.joinedSourceIdentities ?? []) {
      for (const selector of [...(row.sourceRecordSelectors ?? []), ...(row.sourceSelectors ?? [])]) {
        if (typeof selector === 'string') selectors.set(`${row.phase}\u0000${selector}`, { phase: row.phase, selector });
      }
      for (const value of Object.values(row.joins ?? {}).flatMap(value => Array.isArray(value) ? value : [value])) {
        if (value && typeof value === 'object') for (const selector of [value.sourceRef, value.targetSelector, value.sourceRecordSelector]) if (typeof selector === 'string') {
          const phase = value.phase ?? row.phase;
          selectors.set(`${phase}\u0000${selector}`, { phase, selector });
        }
      }
    }
    const taskSourceSelectors = [...selectors.values()].map(({ phase, selector }) => {
      const sourcePath = selector.split('#')[0];
      if (!sourcePath.startsWith('.') && !sourcePath.startsWith('/') && !/^[A-Za-z0-9_-]+\//u.test(sourcePath)) return { selector, status: 'TRACE_REFERENCE_ONLY' };
      const statusRecordMatch = sourcePath.match(/^docs\/implementation\/pdp-(\d)-phase-dev-status\.json$/u);
      const statusIdentityMatch = selector.match(/#sourceIdentityIds\/([^:]+:.+)$/u);
      if (statusRecordMatch && statusIdentityMatch) {
        const sourceStatus = phaseSourceRecords.find(record => record.phase === `PDP-${statusRecordMatch[1]}`);
        const identityRef = statusIdentityMatch[1];
        const present = (sourceStatus?.sourceIdentityIds ?? []).includes(identityRef);
        return { phase, selector, sourcePath, status: present ? 'CURRENT_IDENTITY_PRESENT' : 'MISSING_IDENTITY' };
      }
      const absolutePath = path.resolve(sourcePath);
      const expectedSha256 = phasePinMaps.get(phase)?.[selector] ?? phasePinMaps.get(phase)?.[sourcePath] ?? sourcePinMap.get(sourcePath) ?? null;
      const currentSha256 = selector.includes('#') && phase === 'PDP-0' && phaseProjectionPins[selector]
        ? phaseProjectionPins[selector]
        : currentDigest(absolutePath);
      return {
        phase,
        selector,
        sourcePath,
        expectedSha256,
        currentSha256,
        status: currentSha256 === null ? 'MISSING' : !expectedSha256 ? 'UNPINNED' : currentSha256 === expectedSha256 ? 'CURRENT' : 'STALE'
      };
    });
    const staleTaskSelectors = taskSourceSelectors.filter(row => ['MISSING', 'UNPINNED', 'STALE'].includes(row.status));
    const taskBlockers = [];
    if (approvedRows.length !== campaign.ownerApprovedIncompleteTaskCount) taskBlockers.push({ owner: 'Media plan owner', reason: 'OWNER_APPROVED_TASK_DENOMINATOR_MISMATCH' });
    if (!planTask) taskBlockers.push({ owner: 'Media plan owner', reason: 'OWNER_APPROVED_TASK_NOT_FOUND_IN_57_TASK_PLAN' });
    if (planTask && !Array.isArray(planTask.sourceUnitBindings)) {
      taskBlockers.push({ owner: 'Media source/plan owner', reason: 'TASK_TO_SOURCE_UNIT_BINDING_NOT_AUTHORED_IN_PLAN' });
    }
    for (const dependency of predecessorReadback.filter(row => !row.accepted)) {
      taskBlockers.push({ owner: 'Declared predecessor owner', reason: 'DEPENDENCY_TASK_HAS_NO_OWNER_BOUND_COMPLETION_READBACK', dependencyTaskId: dependency.taskId, observedStatus: dependency.status });
    }
    for (const selector of staleTaskSelectors) taskBlockers.push({ owner: 'Source selector owner', reason: `TASK_SOURCE_SELECTOR_${selector.status}`, sourceSelector: selector.selector });
    taskBlockers.push({ owner: 'Kernel Work Planner', reason: 'KCRIT-PLAN-TASK-CLOSURE_AND_KCRIT-PLAN-READY_OWNER_READBACK_NOT_PRESENT' });
    const taskSourceInputCurrent = Boolean(planTask) && taskSourceSelectors.length > 0 && staleTaskSelectors.length === 0;
    const sourceUnitCandidates = deriveTaskSurfaceCandidates({ task, planTask, surfaceMatrices });
    return {
      taskId: task.taskId,
      ownerRole: task.ownerRole,
      status: task.status,
      exactSourceAndTargetAreas: task.exactSourceAndTargetAreas,
      declaredDependencies: task.blockingDependencies,
      acceptanceCriterion: task.acceptanceCriterion,
      planTaskPresent: Boolean(planTask),
      sourceJoinIdentityCount: planTask?.joinedSourceIdentities?.length ?? 0,
      sourceJoinIdentities: planTask?.joinedSourceIdentities ?? [],
      sourcePins: planTask?.fingerprints?.sourcePins ?? [],
      taskSourceSelectors,
      taskSourceSelectorStatus: staleTaskSelectors.length ? 'UNKNOWN_OR_STALE' : 'PINNED_CURRENT',
      declaredSourceUnitBindings: planTask?.sourceUnitBindings ?? [],
      sourceUnitBindingStatus: Array.isArray(planTask?.sourceUnitBindings) && planTask.sourceUnitBindings.length ? 'PRESENT' : 'UNKNOWN',
      sourceUnitCandidates,
      predecessorTaskIds: planTask?.predecessorTaskIds ?? [],
      declaredPackageDependencyIds: packageRow?.dependencies ?? [],
      dependencyTaskReadback: predecessorReadback,
      sourcePlanningInputStatus: taskSourceInputCurrent ? 'TASK_SOURCE_SELECTORS_CURRENT_ONLY' : 'UNKNOWN_OR_STALE_TASK_SOURCE_SELECTORS',
      perUnitSourceGateStatus: sourceUnitCandidates.length
        ? (sourceUnitCandidates.every(candidate => candidate.phaseGateStatus === 'PASS') ? 'CANDIDATE_ROWS_PASS_OWNER_BINDING_REQUIRED' : 'CANDIDATE_ROWS_BLOCKED_OR_UNKNOWN')
        : 'UNKNOWN_NO_CANONICAL_SURFACE_MATCH',
      declaredDependencyGateStatus: dependencyGateStatus,
      kernelTaskClosureStatus: 'NOT_PROVEN',
      kernelPlanReadyStatus: 'NOT_PROVEN',
      implementationMayBegin: false,
      blockers: taskBlockers
    };
  });
  return {
    schemaVersion: 'media.build-scoped-task-planning.v1',
    recordKind: 'READ_ONLY_OWNER_PLAN_INPUT_NOT_ADMISSION_OR_TRANSITION',
    campaign: {
      stage: campaign.stage,
      sourceIdentityDenominator: campaign.sourceIdentities,
      phaseCellDenominator: campaign.phaseCells,
      packageDenominator: campaign.implementationPackages,
      taskDenominator: campaign.implementationTasks,
      sourceTraceIdentityDenominator: campaign.sourceTraceIdentities,
    ownerApprovedOpenTaskDenominator: campaign.ownerApprovedIncompleteTaskCount
    },
    sourcePlanStructuralStatus: structuralValidation?.structuralStatus ?? 'UNKNOWN',
    sourcePlanStructuralDiagnostics: { errors: structuralValidation?.errors ?? [], sourceBlockers: structuralValidation?.sourceBlockers ?? [] },
    nativeTaskClosureStatus: 'NOT_EVALUATED',
    kernelPlanReadyStatus: 'NOT_PROVEN',
    tasks,
    writesPerformed: false,
    stageTransitionPerformed: false,
    trustFabricated: false,
    note: 'A source bridge census and a structurally valid plan do not provide task acceptance or Kernel owner decisions.'
  };
}

function deriveTaskSurfaceCandidates({ task, planTask, surfaceMatrices }) {
  if (!planTask || !Array.isArray(surfaceMatrices) || surfaceMatrices.length !== 4) return [];
  const rowsByPhase = new Map(surfaceMatrices.map(entry => [entry.phase, entry.surfaces ?? []]));
  const matched = new Map();
  const addMatch = (surfaceId, phase, matchRef) => {
    if (!matched.has(surfaceId)) matched.set(surfaceId, { phases: new Set(), refs: new Set() });
    matched.get(surfaceId).phases.add(phase);
    matched.get(surfaceId).refs.add(matchRef);
  };
  for (const identity of planTask.joinedSourceIdentities ?? []) {
    const phase = identity.phase;
    if (!phase?.startsWith('PDP-')) continue;
    const matrixRows = rowsByPhase.get(phase) ?? [];
    for (const row of matrixRows) {
      const identityRefs = [
        ...(row.capabilityIntentRefs ?? []), ...(row.requirementRefs ?? []), ...(row.intentRefs ?? [])
      ];
      const identityMatch = identityRefs.includes(identity.id);
      if (identityMatch) addMatch(row.surfaceId, phase, `${phase}:${identity.kind}:${identity.id}`);
    }
  }
  const targetAreas = (task?.exactSourceAndTargetAreas ?? []).filter(area => typeof area === 'string'
    && !area.startsWith('.product-experience/') && !area.startsWith('docs/')
    && !area.includes('Shared') && !area.includes('ADR') && !area.includes('production host'));
  for (const { surfaces = [] } of surfaceMatrices) for (const row of surfaces) {
    const repositoryPath = row.repositoryPath?.replace(/\/$/u, '');
    if (!repositoryPath) continue;
    const matchedArea = targetAreas.find(area => {
      const normalized = area.replace(/[{}]/gu, '').replace(/\/$/u, '');
      return normalized === repositoryPath || normalized.endsWith(`/${repositoryPath}`)
        || normalized.startsWith(`${repositoryPath}/`) || repositoryPath.startsWith(`${normalized}/`);
    });
    if (matchedArea) addMatch(row.surfaceId, row.phase, `targetArea:${matchedArea}`);
  }
  return [...matched.entries()].map(([surfaceId, match]) => {
    const obligations = surfaceMatrices.map(({ phase }) => {
      const row = rowsByPhase.get(phase)?.find(surface => surface.surfaceId === surfaceId);
      if (!row) return { phase, status: 'UNKNOWN', reason: 'PHASE_ROW_MISSING' };
      const applicable = row.developmentStatus === 'DEV_COMPLETE';
      const explicitNa = ['NOT_APPLICABLE', 'NOT_ACTIVE_ARCHIVED'].includes(row.developmentStatus)
        && typeof row.applicability?.rationale === 'string'
        && (row.applicability.authorityRef || row.applicability.authorityRefs?.length);
      const current = row.sourceCurrent === true && Array.isArray(row.remainingPhaseLocalTaskIds);
      const pass = current && row.remainingPhaseLocalTaskIds.length === 0 && (applicable || explicitNa);
      return { phase, status: pass ? 'PASS' : 'FAIL', developmentStatus: row.developmentStatus, sourceCurrent: row.sourceCurrent, remainingPhaseLocalTaskIds: row.remainingPhaseLocalTaskIds, applicability: row.applicability };
    });
    return {
      surfaceId,
      matchedTaskPhases: [...match.phases].sort(),
      matchEvidence: [...match.refs].sort(),
      phaseGateStatus: obligations.every(row => row.status === 'PASS') ? 'PASS' : obligations.some(row => row.status === 'FAIL') ? 'FAIL' : 'UNKNOWN',
      phaseObligations: obligations,
      authority: 'SOURCE_JOIN_TO_CANONICAL_MATRIX_CANDIDATE_REQUIRES_OWNER_CONFIRMATION'
    };
  }).sort((a, b) => a.surfaceId.localeCompare(b.surfaceId));
}

