import crypto from 'node:crypto';

const allowedStatuses = new Set(['INCOMPLETE_SOURCE_RELATIONS', 'SOURCE_RELATIONS_CURRENT']);
const sortedUnique = values => [...new Set(values)].sort((a, b) => a.localeCompare(b));
const ownerDispositionSchema = 'media.gtool-build-owner-dispositions.v1';
const obligationTotals = { 'PDP-0': 4028, 'PDP-1': 2336, 'PDP-2': 436, 'PDP-3': 1864 };
const f00ObservationSchema = 'media.build-f00-t01-source-material-topology-observation.v1';
const f00ObservationKind = 'SOURCE_ONLY_F00_T01_RECONCILIATION_NOT_BUILD_ADMISSION_OR_PDP_CLOSURE';
export const DEFAULT_F00_T01_OBSERVATION_PATH = 'docs/implementation/evidence/media-gtool-campaign/media-build-f00-t01-source-material-topology-observation-20261023T105424Z.v1.json';
const blockerInventoryRef = 'docs/implementation/MEDIA-BUILD-BRIDGE-BLOCKER-INVENTORY.v1.json';
const executionAuthorizationSchema = 'media.lifecycle-closure-owner-execution-authorization.v1';
const executionAuthorizationKind = 'OWNER_DIRECTED_EXECUTION_SCOPE_APPROVAL_NOT_TRUSTED_VERIFIER_REGISTRATION';
const executionAuthorizationRef = 'config/closure/media-product-definition/owner-execution-authorization.v1.json';

function gitBlobSha(bytes) {
  return crypto.createHash('sha1').update(`blob ${Buffer.byteLength(bytes)}\0`).update(bytes).digest('hex');
}

function projectOwnerTasks(dispositions) {
  if (dispositions?.schemaVersion !== ownerDispositionSchema ||
      dispositions?.recordKind !== 'DELEGATED_OWNER_DECISION_AND_EXECUTION_INPUT_NOT_GTOOL_RECEIPT' ||
      !Array.isArray(dispositions?.tasks) || dispositions.tasks.length !== 19) {
    throw new Error('CURRENT_OWNER_DISPOSITIONS_WITH_19_TASKS_REQUIRED');
  }
  const ids = dispositions.tasks.map(task => task.taskId);
  if (new Set(ids).size !== 19 || dispositions.tasks.some(task =>
    task.status !== 'OPEN_TECHNICAL_WORK' || task.completionClaim !== 'NOT_COMPLETE' ||
    task.routineApprovalOutstanding !== false || task.independentFormalProofWaived !== false)) {
    throw new Error('OWNER_TASKS_MUST_REMAIN_OPEN_AND_UNWAIVED');
  }
  return dispositions.tasks.map(task => ({
    taskId: task.taskId,
    ownerRepository: task.ownerRepository,
    ownerRole: task.ownerRole,
    executionLane: task.executionLane,
    status: task.status,
    disposition: task.disposition,
    exactSourceAndTargetAreas: task.exactSourceAndTargetAreas,
    implementationDirective: task.implementationDirective,
    blockingDependencies: task.blockingDependencies,
    requiredStructuredIO: task.requiredStructuredIO,
    acceptanceCriterion: task.acceptanceCriterion,
    completionClaim: task.completionClaim,
    authorizedTechnicalAction: task.authorizedTechnicalAction,
    routineApprovalOutstanding: task.routineApprovalOutstanding,
    independentFormalProofWaived: task.independentFormalProofWaived,
  }));
}

export function deriveMediaGtoolExecutionQueue(queue, ownerDispositions, dispositionBytes, blockerInventory, inventoryBytes, f00Observation, f00ObservationBytes, executionAuthorization, executionAuthorizationBytes, f00ObservationRef = DEFAULT_F00_T01_OBSERVATION_PATH, executionAuthorizationSourceRef = executionAuthorizationRef) {
  if (queue?.schemaVersion !== 'media.gtool-owner-execution-queue.v2' ||
      queue?.recordKind !== 'DERIVED_EXECUTION_COORDINATION_NOT_GTOOL_STATE_OR_PROOF' ||
      !Array.isArray(queue?.tasks) || queue.tasks.length !== 19) {
    throw new Error('GTOOL_EXECUTION_QUEUE_IDENTITY_REQUIRED');
  }
  if (typeof dispositionBytes !== 'string' || !ownerDispositions ||
      JSON.stringify(JSON.parse(dispositionBytes)) !== JSON.stringify(ownerDispositions)) {
    throw new Error('OWNER_DISPOSITION_BYTES_MUST_MATCH_PARSED_SOURCE');
  }
  const tasks = projectOwnerTasks(ownerDispositions);
  if (queue.tasks.some((task, index) => task.taskId !== tasks[index].taskId)) {
    throw new Error('QUEUE_TASK_ORDER_MUST_MATCH_OWNER_DISPOSITIONS');
  }
  if (!f00Observation || typeof f00ObservationBytes !== 'string' ||
      JSON.stringify(JSON.parse(f00ObservationBytes)) !== JSON.stringify(f00Observation) ||
      f00Observation.schemaVersion !== f00ObservationSchema || f00Observation.recordKind !== f00ObservationKind ||
      f00Observation.campaign?.selectedTaskId !== 'M-BLD-F00.T01' ||
      f00Observation.campaign?.campaignDenominator?.surfaceIdentities !== 54 ||
      f00Observation.campaign?.campaignDenominator?.phaseSurfaceCells !== 216 ||
      f00Observation.reconciliation?.status !== 'SOURCE_INPUTS_RECONCILED_WITH_CURRENT_G0_SOURCE_READBACK' ||
      f00Observation.sourceBaseline?.g0Status?.status !== 'SOURCE_DEFINITION_DEV_COMPLETE_CURRENT' ||
      f00Observation.sourceBaseline?.g0Status?.sourceSubjectCount !== 54 ||
      f00Observation.sourceBaseline?.g0Status?.sourcePhaseCellCount !== 216 ||
      f00Observation.taskAndGateBoundaries?.sourceStatusAxes?.independentAcceptanceStatus !== 'NOT_EVALUATED' ||
      f00Observation.taskAndGateBoundaries?.sourceStatusAxes?.nativeClosureStatus !== 'NOT_EVALUATED' ||
      f00Observation.claimsBoundary?.taskCompletion !== 'NOT_ESTABLISHED' ||
      f00Observation.claimsBoundary?.nativePdpClosure !== 'NOT_EVALUATED') {
    throw new Error('CURRENT_F00_T01_SOURCE_OBSERVATION_REQUIRED');
  }
  if (queue.campaign?.sourceIdentities !== 54 || queue.campaign?.phaseCells !== 216 ||
      queue.campaign?.implementationPackages !== 50 || queue.campaign?.implementationTasks !== 57 ||
      queue.campaign?.ownerApprovedIncompleteTaskCount !== 19 ||
      JSON.stringify(queue.campaign?.canonicalObligationTotals) !== JSON.stringify(obligationTotals)) {
    throw new Error('CAMPAIGN_DENOMINATOR_REQUIRED');
  }
  if (blockerInventory?.schemaVersion !== 'media.build-source-bridge-blocker-inventory.v1' ||
      blockerInventory?.recordKind !== 'GENERATED_READ_ONLY_EXACT_SOURCE_JOIN_BLOCKERS_NOT_PDP_MEANING_AUTHORITY' ||
      blockerInventory?.sourceBridge !== 'docs/implementation/MEDIA-BUILD-CONTRACT-BRIDGE.v1.json' ||
      !allowedStatuses.has(blockerInventory?.sourceBridgeStatus) ||
      (blockerInventory?.sourceBridgeStatus === 'SOURCE_RELATIONS_CURRENT' && blockerInventory?.status !== 'SOURCE_RELATIONS_CURRENT') ||
      (blockerInventory?.sourceBridgeStatus === 'INCOMPLETE_SOURCE_RELATIONS' && blockerInventory?.status !== 'TECHNICAL_WORK_REMAINING') ||
      !blockerInventory?.census || !Array.isArray(blockerInventory?.exactMissingP1Operations) ||
      !Array.isArray(blockerInventory?.unresolvedCrossLayerRelations) ||
      !Array.isArray(blockerInventory?.unresolvedHandoffSelectors) ||
      !Array.isArray(blockerInventory?.otherUnclassified) ||
      typeof inventoryBytes !== 'string') {
    throw new Error('CURRENT_SOURCE_BRIDGE_BLOCKER_INVENTORY_REQUIRED');
  }
  if (JSON.stringify(JSON.parse(inventoryBytes)) !== JSON.stringify(blockerInventory)) {
    throw new Error('BLOCKER_INVENTORY_BYTES_MUST_MATCH_PARSED_SOURCE');
  }
  if (executionAuthorizationSourceRef !== executionAuthorizationRef) {
    throw new Error('EXECUTION_AUTHORIZATION_REFERENCE_MUST_BE_CANONICAL');
  }
  if (!executionAuthorization || typeof executionAuthorizationBytes !== 'string' ||
      JSON.stringify(JSON.parse(executionAuthorizationBytes)) !== JSON.stringify(executionAuthorization) ||
      executionAuthorization.schemaVersion !== executionAuthorizationSchema ||
      executionAuthorization.recordKind !== executionAuthorizationKind ||
      executionAuthorization.decisionId !== 'MEDIA-GTOOL-CLOSURE-EXECUTION-2026-10-22' ||
      executionAuthorization.ownerDecisionRevision !== 3 ||
      executionAuthorization.status !== 'OWNER_DISCRETIONARY_DECISIONS_APPROVED' ||
      executionAuthorization.effect !== 'EXECUTION_SCOPE_APPROVED_ONLY' ||
      executionAuthorization.scope?.repository !== 'samujjwal/ghatana-media' ||
      executionAuthorization.scope?.macroStage !== 'BUILD' ||
      executionAuthorization.scope?.firstPhase !== 'PDP-0' ||
      executionAuthorization.scope?.sourceIdentityDenominator !== 54 ||
      executionAuthorization.scope?.sourceObligationDenominatorAtStartingCut !== 8664 ||
      JSON.stringify(executionAuthorization.scope?.phaseOrder) !== JSON.stringify(['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3']) ||
      executionAuthorization.technicalPrerequisiteStatus !== 'AUTHENTICATED_AP02_AP03_AND_NATIVE_PROOFS_STILL_REQUIRED' ||
      executionAuthorization.trustedAdmission !== 'NOT_ISSUED' || executionAuthorization.nativeReceipts !== 0 ||
      executionAuthorization.deliveryAuthorization !== false) {
    throw new Error('CURRENT_OWNER_EXECUTION_AUTHORIZATION_REVISION_3_REQUIRED');
  }
  const census = blockerInventory.census;
  const countKeys = [
    'traceIdentityCount', 'sourceBridgeEdgeCount', 'unresolvedSourceIdentityCount', 'unresolvedSourceBlockerCount',
    'p1OperationMissingReferenceCount', 'uniqueMissingP1OperationCount', 'unresolvedCrossLayerRelationCount',
    'unresolvedHandoffSelectorCount', 'otherReasonCount',
  ];
  if (countKeys.some(key => !Number.isSafeInteger(census[key]) || census[key] < 0) ||
      census.unresolvedCrossLayerRelationCount !== blockerInventory.unresolvedCrossLayerRelations.length ||
      census.unresolvedHandoffSelectorCount !== blockerInventory.unresolvedHandoffSelectors.length ||
      census.otherReasonCount !== blockerInventory.otherUnclassified.length ||
      (blockerInventory.status === 'SOURCE_RELATIONS_CURRENT' &&
        (census.unresolvedSourceBlockerCount !== 0 || census.p1OperationMissingReferenceCount !== 0 ||
         census.uniqueMissingP1OperationCount !== 0 || census.unresolvedCrossLayerRelationCount !== 0 ||
         census.unresolvedHandoffSelectorCount !== 0 || census.otherReasonCount !== 0)) ||
      (blockerInventory.status === 'INCOMPLETE_SOURCE_RELATIONS' && census.unresolvedSourceBlockerCount === 0)) {
    throw new Error('BLOCKER_INVENTORY_CENSUS_MUST_MATCH_EXPLICIT_ROWS_AND_STATUS');
  }
  const remainingExactOperationIds = sortedUnique(blockerInventory.exactMissingP1Operations.map(row => row.operationId));
  const unresolvedRelations = sortedUnique(blockerInventory.unresolvedCrossLayerRelations.map(row => row.operationId));
  const unresolvedHandoffSelectors = sortedUnique(blockerInventory.unresolvedHandoffSelectors.map(row => row.handoffSelector));
  if (remainingExactOperationIds.some(value => typeof value !== 'string' || value.length === 0) ||
      unresolvedRelations.some(value => typeof value !== 'string' || value.length === 0) ||
      unresolvedHandoffSelectors.some(value => typeof value !== 'string' || value.length === 0) ||
      census.uniqueMissingP1OperationCount !== remainingExactOperationIds.length ||
      census.unresolvedSourceBlockerCount !== census.p1OperationMissingReferenceCount + census.unresolvedCrossLayerRelationCount +
        census.unresolvedHandoffSelectorCount + census.otherReasonCount) {
    throw new Error('BLOCKER_INVENTORY_EXPLICIT_ROWS_MUST_MATCH_CENSUS');
  }
  const derivedBridge = {
    ...queue.bridge,
    traceIdentityCount: census.traceIdentityCount,
    sourceBridgeEdgeCount: census.sourceBridgeEdgeCount,
    unresolvedSourceIdentityCount: census.unresolvedSourceIdentityCount,
    unresolvedSourceBlockerCount: census.unresolvedSourceBlockerCount,
    p1OperationMissingReferenceCount: census.p1OperationMissingReferenceCount,
    uniqueMissingP1OperationCount: census.uniqueMissingP1OperationCount,
    unresolvedCrossLayerRelationCount: census.unresolvedCrossLayerRelationCount,
    unresolvedHandoffSelectorCount: census.unresolvedHandoffSelectorCount,
    otherReasonCount: census.otherReasonCount,
    sourceBridgeStatus: blockerInventory.sourceBridgeStatus,
    blockerInventoryStatus: blockerInventory.status,
    sourceBridgeRef: blockerInventory.sourceBridge,
    blockerInventoryRef,
    blockerInventoryDigest: `sha256:${crypto.createHash('sha256').update(inventoryBytes).digest('hex')}`,
    taskCompletionStatus: blockerInventory.taskCompletionStatus,
    proofStatus: blockerInventory.proofStatus,
    remainingExactOperationIds,
    unresolvedRelations,
    unresolvedHandoffSelectors,
  };
  const g0Wave = queue.waves?.find(wave => wave.id === 'G0');
  if (!g0Wave || !['READY_TO_RUN_ON_FRESH_CHECKOUT', 'SOURCE_READBACK_OBSERVED'].includes(g0Wave.status)) {
    throw new Error('G0_QUEUE_WAVE_SOURCE_STATUS_REQUIRED');
  }
  const g1Wave = queue.waves?.find(wave => wave.id === 'G1');
  if (!g1Wave || g1Wave.status !== 'OPEN_TECHNICAL_WORK') {
    throw new Error('G1_QUEUE_WAVE_MUST_REMAIN_OPEN_UNTIL_TASK_ACCEPTANCE');
  }
  const observationDigest = `sha256:${crypto.createHash('sha256').update(f00ObservationBytes).digest('hex')}`;
  const authorizationDigest = `sha256:${crypto.createHash('sha256').update(executionAuthorizationBytes).digest('hex')}`;
  const bridgeReadback = {
    status: blockerInventory.sourceBridgeStatus,
    inventoryRef: blockerInventoryRef,
    inventoryDigest: derivedBridge.blockerInventoryDigest,
    sourceBridgeRef: blockerInventory.sourceBridge,
    traceIdentityCount: census.traceIdentityCount,
    sourceBridgeEdgeCount: census.sourceBridgeEdgeCount,
    unresolvedSourceIdentityCount: census.unresolvedSourceIdentityCount,
    unresolvedSourceBlockerCount: census.unresolvedSourceBlockerCount,
    p1OperationMissingReferenceCount: census.p1OperationMissingReferenceCount,
    uniqueMissingP1OperationCount: census.uniqueMissingP1OperationCount,
    unresolvedCrossLayerRelationCount: census.unresolvedCrossLayerRelationCount,
    unresolvedHandoffSelectorCount: census.unresolvedHandoffSelectorCount,
    otherReasonCount: census.otherReasonCount,
    taskCompletionStatus: blockerInventory.taskCompletionStatus,
    proofStatus: blockerInventory.proofStatus,
    authority: 'SOURCE_RELATION_CENSUS_NOT_TASK_ACCEPTANCE_OR_PROOF',
  };
  const waves = queue.waves.map(wave => wave.id === 'G0' ? {
    ...wave,
    status: 'SOURCE_READBACK_OBSERVED',
    sourceReadback: {
      status: 'SOURCE_DEFINITION_DEV_COMPLETE_CURRENT',
      observationRef: f00ObservationRef,
      observationDigest,
      sourceSnapshotFingerprint: f00Observation.sourceBaseline.g0Status.sourceSnapshotFingerprint,
      sourceIdentities: 54,
      phaseCells: 216,
      remainingDefinitionTasks: 0,
      authority: 'READ_ONLY_OBSERVATION_NOT_STAGE_TRANSITION_OR_CLOSURE',
    },
    exit: '54 IDs and 216 current phase observations with known-zero definition tasks; source readback observed; native receipt still NOT_EVALUATED',
  } : wave.id === 'G1' ? {
    ...wave,
    input: 'Current generated source-bridge blocker inventory plus exact source-bound F00.T02 acceptance artifacts and owner review.',
    effect: 'Refresh deterministic source-bridge projections and evaluate task acceptance without inferring semantic links or closure.',
    exit: 'Current source-relation census is projected below; F00.T02 remains open until its source-bound tests, negative/UNKNOWN/rollback readback, and source-current owner review are evaluated.',
    sourceReadback: bridgeReadback,
  } : wave);
  return {
    ...queue,
    statusAxes: {
      ...queue.statusAxes,
      sourceDevelopment: f00Observation.sourceBaseline.g0Status.status,
    },
    source: {
      ...queue.source,
      ownerDispositionsBlobSha: gitBlobSha(dispositionBytes),
    },
    executionAuthorization: {
      ref: executionAuthorizationSourceRef,
      sha256: authorizationDigest,
      decisionId: executionAuthorization.decisionId,
      ownerDecisionRevision: executionAuthorization.ownerDecisionRevision,
      status: executionAuthorization.status,
      effect: executionAuthorization.effect,
      technicalPrerequisiteStatus: executionAuthorization.technicalPrerequisiteStatus,
      sourceIdentityDenominator: executionAuthorization.scope.sourceIdentityDenominator,
      sourceObligationDenominatorAtStartingCut: executionAuthorization.scope.sourceObligationDenominatorAtStartingCut,
      trustedAdmission: executionAuthorization.trustedAdmission,
      nativeReceipts: executionAuthorization.nativeReceipts,
      deliveryAuthorization: executionAuthorization.deliveryAuthorization,
      boundary: 'OWNER_SCOPE_ONLY_NOT_TRUSTED_ADMISSION_NATIVE_CLOSURE_BUILD_COMPLETION_OR_DELIVERY',
    },
    campaign: { ...queue.campaign, sourceTraceIdentities: census.traceIdentityCount },
    bridge: derivedBridge,
    tasks,
    waves,
  };
}
