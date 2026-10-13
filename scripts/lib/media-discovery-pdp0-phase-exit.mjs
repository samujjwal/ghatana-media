const EXPECTED_SCOPE = {
  physicalCandidates: 26,
  semanticCompositions: 6,
  repositoryRoots: 1,
  consumers: 17,
  totalCells: 50,
};

const REQUIRED_COMMANDS = [
  'pnpm check:physical-topology',
  'pnpm test:physical-topology',
  'pnpm check:product-definition-authority',
  'pnpm check:product-experience-local',
  'node --test tests/media-discovery-currentness.test.mjs tests/pdp-0-final.test.mjs tests/product-definition-authority.test.mjs',
  'node --test tests/media-discovery-pdp0-phase-exit.test.mjs',
];

const empty = (value) => Array.isArray(value) && value.length === 0;

function validateOwnerAcceptance(acceptance, technicalCurrentness) {
  const blockers = [];
  if (acceptance?.recordKind !== 'OWNER_DECISION_INPUT_NOT_TECHNICAL_CURRENTNESS_NOT_LIFECYCLE_RECEIPT') blockers.push('INVALID_OWNER_INPUT_KIND');
  if (acceptance?.decisionStatus !== 'APPROVED_INTERNAL_DELEGATED_EXACT_MATERIAL_CUT') blockers.push('OWNER_INPUT_NOT_APPROVED');
  if (acceptance?.decisionId !== 'MEDIA-OWN-P0-2026-10-13-R2') blockers.push('OWNER_DECISION_ID_MISMATCH');
  if (acceptance?.authority?.ownerRole !== 'Media Product Truth / development-status') blockers.push('OWNER_ROLE_MISMATCH');
  if (acceptance?.authority?.actorKind !== 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION') blockers.push('OWNER_ACTOR_OR_DELEGATION_MISSING');
  if (acceptance?.subject?.phase !== 'PDP-0') blockers.push('OWNER_PHASE_MISMATCH');
  if (acceptance?.subject?.materialSourceSetFingerprint !== technicalCurrentness?.materialSourceSetFingerprint) {
    blockers.push('STALE_APPROVAL_FOR_CHANGED_MATERIAL');
  }
  if (JSON.stringify(acceptance?.subject?.surfaceScope) !== JSON.stringify({
    physicalCandidates: EXPECTED_SCOPE.physicalCandidates,
    physicalDispositions: { PHYSICAL: 12, SUPPORT_ONLY: 12, SUBSUMED: 2 },
    semanticCompositions: EXPECTED_SCOPE.semanticCompositions,
    repositoryRoot: EXPECTED_SCOPE.repositoryRoots,
    nonphysicalConsumerCrosswalks: EXPECTED_SCOPE.consumers,
    totalPhaseCells: EXPECTED_SCOPE.totalCells,
  })) blockers.push('OWNER_SCOPE_MISMATCH');
  if (!empty(acceptance?.subject?.changedMeaningIds) || !empty(acceptance?.subject?.outstandingMeaningIds)) {
    blockers.push('OWNER_REPORTS_MEANING_WORK');
  }
  if (acceptance?.decision?.meaningDevelopmentTasksRemaining !== 0 || acceptance?.decision?.mayExecuteMdc06 !== true) {
    blockers.push('OWNER_MDC06_AUTHORIZATION_MISSING');
  }
  if (acceptance?.decision?.internalDevelopmentDefinitionAcceptance !== 'APPROVED_FOR_REUSE'
      || !String(acceptance?.decision?.observedSourceCurrentnessOwnerDisposition ?? '').startsWith('ACCEPT_EXACT_MATERIAL_FINGERPRINT')) {
    blockers.push('OWNER_EXACT_CUT_DISPOSITION_MISSING');
  }
  if (acceptance?.authority?.humanIndependentSignatureProvided !== false
      || acceptance?.authority?.qualifiedExternalSpecialistSignoffProvided !== false) {
    blockers.push('OWNER_INDEPENDENCE_ATTRIBUTION_INVALID');
  }
  return blockers;
}

function validateTechnicalCurrentness(technicalCurrentness) {
  const blockers = [];
  if (technicalCurrentness?.phaseDisposition?.historicalDefinitionStatus !== 'DEV_COMPLETE') blockers.push('HISTORICAL_DEFINITION_NOT_DEV_COMPLETE');
  if (technicalCurrentness?.phaseDisposition?.historicalOutstandingMeaningIds?.length !== 0) blockers.push('HISTORICAL_MEANING_TASKS_REMAIN');
  if (technicalCurrentness?.phaseDisposition?.currentSourceCurrentness !== 'PASS'
      || technicalCurrentness?.phaseDisposition?.sourceCurrent !== true) blockers.push('TECHNICAL_CURRENTNESS_NOT_PASS');
  if (technicalCurrentness?.denominators?.totalCells !== EXPECTED_SCOPE.totalCells
      || technicalCurrentness?.physicalCompositeConsumerCells?.length !== EXPECTED_SCOPE.totalCells) blockers.push('TECHNICAL_CELL_DENOMINATOR_MISMATCH');
  if (technicalCurrentness?.authority?.changedMeaningIds?.length !== 0) blockers.push('TECHNICAL_CAPTURE_REPORTS_CHANGED_MEANING');
  if (technicalCurrentness?.unclassifiedHistoricalPdp0PinChanges?.length !== 0) blockers.push('UNCLASSIFIED_HISTORICAL_PDP0_PIN_CHANGES');
  if (technicalCurrentness?.externalOwnerContracts?.totalFiles !== 30
      || technicalCurrentness?.externalOwnerContracts?.digestMatches !== 30
      || technicalCurrentness?.externalOwnerContracts?.digestMismatches?.length !== 0) blockers.push('EXTERNAL_CONTRACT_DIGESTS_NOT_CURRENT');
  const cells = technicalCurrentness?.physicalCompositeConsumerCells ?? [];
  if (cells.length !== EXPECTED_SCOPE.totalCells || cells.some((cell) => cell.sourceCurrentness !== 'CURRENT')) {
    blockers.push('ONE_OR_MORE_PDP0_CELLS_NOT_CURRENT');
  }
  const ids = cells.map((cell) => cell.cellId);
  if (new Set(ids).size !== EXPECTED_SCOPE.totalCells) blockers.push('DUPLICATE_OR_MISSING_PDP0_CELL_ID');
  if (cells.some((cell) => !cell.applicability?.disposition || !cell.applicability?.rationale?.trim())) blockers.push('APPLICABILITY_WITHOUT_DISPOSITION_OR_RATIONALE');
  return blockers;
}

function validateChecks(testOutcomes) {
  const blockers = [];
  const byCommand = new Map((testOutcomes ?? []).map((outcome) => [outcome.command, outcome]));
  for (const command of REQUIRED_COMMANDS) {
    const outcome = byCommand.get(command);
    if (!outcome) {
      blockers.push(`REQUIRED_CHECK_NOT_RECORDED:${command}`);
      continue;
    }
    if (outcome.status !== 'PASS' || outcome.exitCode !== 0) blockers.push(`REQUIRED_CHECK_FAILED:${command}`);
    if (command.startsWith('node --test ') && (!Number.isInteger(outcome.testCount)
        || !Number.isInteger(outcome.passedCount) || !Number.isInteger(outcome.failedCount)
        || !Number.isInteger(outcome.skippedCount) || outcome.failedCount !== 0
        || outcome.passedCount + outcome.skippedCount !== outcome.testCount)) {
      blockers.push(`REQUIRED_TEST_COUNTS_INVALID:${command}`);
    }
  }
  return blockers;
}

/**
 * Join a fresh technical P0 capture, the exact-cut internal owner input, and
 * actual command outcomes. This does not perform a currentness capture, run
 * commands, or make an owner decision.
 */
export function joinMediaPdp0PhaseExit({ technicalCurrentness, ownerAcceptance, testOutcomes, baselineSha, observedAt = new Date().toISOString() }) {
  const technicalBlockers = validateTechnicalCurrentness(technicalCurrentness);
  const ownerBlockers = validateOwnerAcceptance(ownerAcceptance, technicalCurrentness);
  const testBlockers = validateChecks(testOutcomes);
  const blockers = [...technicalBlockers, ...ownerBlockers, ...testBlockers];
  const pass = blockers.length === 0;

  return {
    schemaVersion: 'media.discovery-phase-exit.v1',
    recordId: `MEDIA-PDP0-EXIT-${technicalCurrentness?.materialSourceSetFingerprint?.slice(-12) ?? 'UNKNOWN'}`,
    observedAt,
    campaign: {
      repository: 'samujjwal/ghatana-media',
      baselineSha: baselineSha ?? null,
      observedHead: technicalCurrentness?.campaign?.observedHead ?? null,
      branch: technicalCurrentness?.campaign?.branch ?? null,
      scope: 'Repository-wide Media Discovery; PDP-0 only.',
    },
    phase: 'PDP-0',
    developmentStatus: {
      status: technicalCurrentness?.phaseDisposition?.historicalDefinitionStatus ?? 'UNKNOWN',
      outstandingMeaningIds: technicalCurrentness?.phaseDisposition?.historicalOutstandingMeaningIds ?? null,
      currentMaterialSourceSetFingerprint: technicalCurrentness?.materialSourceSetFingerprint ?? null,
    },
    sourceCurrentness: {
      status: technicalCurrentness?.phaseDisposition?.currentSourceCurrentness ?? 'UNKNOWN',
      sourceCurrent: technicalCurrentness?.phaseDisposition?.sourceCurrent === true,
      lifecycle: technicalCurrentness?.lifecycleSourceCurrentness ?? null,
      denominators: technicalCurrentness?.denominators ?? null,
      materialPathDenominator: technicalCurrentness?.materialPathDenominator ?? null,
      ownerGraphFingerprint: technicalCurrentness?.physicalCompositeConsumerCells?.[0]?.ownerGraphFingerprint ?? null,
      physicalCatalogFingerprint: technicalCurrentness?.physicalCompositeConsumerCells?.[0]?.physicalCatalogFingerprint ?? null,
      providerRegistryFingerprint: technicalCurrentness?.physicalCompositeConsumerCells?.[0]?.providerRegistryFingerprint ?? null,
      materialSourceSetFingerprint: technicalCurrentness?.materialSourceSetFingerprint ?? null,
      sharedMaterialPaths: technicalCurrentness?.sharedMaterialPaths ?? [],
      sourceContentDigests: technicalCurrentness?.sourceContentDigests ?? {},
      historicalPhaseStatusComparison: technicalCurrentness?.historicalPhaseStatusComparison ?? [],
      historicalPdp0PinDriftClassifications: technicalCurrentness?.historicalPdp0PinDriftClassifications ?? [],
      requiredPdp0SourceMembership: technicalCurrentness?.requiredPdp0SourceMembership ?? [],
      externalContractCounts: {
        total: technicalCurrentness?.externalOwnerContracts?.totalFiles ?? null,
        matched: technicalCurrentness?.externalOwnerContracts?.digestMatches ?? null,
        mismatched: technicalCurrentness?.externalOwnerContracts?.digestMismatches?.length ?? null,
      },
      cells: (technicalCurrentness?.physicalCompositeConsumerCells ?? []).map((cell) => ({
        cellId: cell.cellId,
        surfaceId: cell.surfaceId,
        cellType: cell.cellType,
        applicability: cell.applicability,
        sourceCurrentness: cell.sourceCurrentness,
        expectedPathCount: cell.expectedPathCount,
        expectedPathSetFingerprint: cell.expectedPathSetFingerprint,
        sourceSetFingerprint: cell.sourceSetFingerprint,
        blockers: cell.blockers ?? [],
      })),
    },
    delegatedOwnerAcceptance: {
      decisionId: ownerAcceptance?.decisionId ?? null,
      decisionStatus: ownerAcceptance?.decisionStatus ?? 'UNKNOWN',
      actorKind: ownerAcceptance?.authority?.actorKind ?? null,
      acceptedMaterialSourceSetFingerprint: ownerAcceptance?.subject?.materialSourceSetFingerprint ?? null,
      changedMeaningIds: ownerAcceptance?.subject?.changedMeaningIds ?? null,
      outstandingMeaningIds: ownerAcceptance?.subject?.outstandingMeaningIds ?? null,
      humanIndependentSignatureProvided: ownerAcceptance?.authority?.humanIndependentSignatureProvided ?? null,
      qualifiedExternalSpecialistSignoffProvided: ownerAcceptance?.authority?.qualifiedExternalSpecialistSignoffProvided ?? null,
      status: ownerBlockers.length ? 'BLOCKED' : 'ACCEPTED_FOR_EXACT_MATERIAL_FINGERPRINT',
      blockers: ownerBlockers,
    },
    testOutcomes: testOutcomes ?? [],
    phaseExit: {
      status: pass ? 'PASS' : ownerBlockers.includes('STALE_APPROVAL_FOR_CHANGED_MATERIAL')
        ? 'STALE_APPROVAL_FOR_CHANGED_MATERIAL'
        : 'FAIL',
      sourceCurrentness: technicalBlockers.length ? 'FAIL' : 'PASS',
      delegatedOwnerAcceptance: ownerBlockers.length ? 'FAIL' : 'PASS',
      requiredChecks: testBlockers.length ? 'FAIL' : 'PASS',
      blockers,
      nextLegalAction: pass ? 'ADVANCE_TO_PDP1_MDC10' : ownerBlockers.includes('STALE_APPROVAL_FOR_CHANGED_MATERIAL')
        ? 'TARGETED_OWNER_CHANGE_REVIEW_THEN_RECAPTURE_PDP0'
        : 'REPAIR_PDP0_EXIT_BLOCKERS_AND_RECAPTURE',
    },
    independentApproval: 'NOT_CLAIMED_AND_NOT_WAIVED',
    lifecycleClosure: 'NOT_ENTERED',
    build: 'NOT_ENTERED',
    delivery: 'BLOCKED',
  };
}

export const mediaPdp0RequiredCommands = REQUIRED_COMMANDS;
