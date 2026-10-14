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
  'node --test tests/media-discovery-currentness.test.mjs tests/media-discovery-pdp0-phase-exit.test.mjs',
];

const REVIEWED_PDP0_CHANGES = new Set([
  '.product-experience/artifact-identities.yaml',
  '.product-experience/source-manifest.yaml',
  '.product-experience/surface-registry.yaml',
  'apps/media-experience-explorer/specification-artifacts.json',
]);

const empty = (value) => Array.isArray(value) && value.length === 0;

function validateCurrentCutOwnerDirections(acceptance, technicalCurrentness, historicalPdp0Exit) {
  const blockers = [];
  const review = acceptance?.predecessorImpactReviews?.find((entry) => entry.phase === 'PDP-0');
  const expectedScope = {
    physicalCandidates: 26,
    physical: 12,
    support: 12,
    subsumed: 2,
    semanticCompositions: 6,
    root: 1,
    consumerBindings: 17,
    phaseReviewCells: 200,
    nonPhysicalConsumerRefsCountedSeparately: true,
  };
  if (acceptance?.recordKind !== 'SCOPED_DELEGATED_MEDIA_OWNER_DESIGN_AND_MATERIAL_IMPACT_DECISIONS_NOT_TECHNICAL_CURRENTNESS_NOT_LIFECYCLE_RECEIPT') blockers.push('OWNER_INPUT_NOT_CURRENT_CUT_DIRECTIONS');
  if (acceptance?.decisionId !== 'MEDIA-DISCOVERY-CURRENT-CUT-OWNER-2026-10-13-R2') blockers.push('OWNER_DIRECTION_ID_MISMATCH');
  if (acceptance?.stage !== 'DISCOVERY' || acceptance?.earliestPhaseRevalidation !== 'PDP-0') blockers.push('OWNER_DIRECTION_PHASE_MISMATCH');
  if (JSON.stringify(acceptance?.scope) !== JSON.stringify(expectedScope)) blockers.push('OWNER_DIRECTION_SCOPE_MISMATCH');
  if (acceptance?.reviewed?.repository !== 'samujjwal/ghatana-media'
      || acceptance?.reviewed?.head !== 'f5ae3461c53eb1d490362a9bb8818ce74573147c') blockers.push('OWNER_REVIEWED_SOURCE_CUT_MISMATCH');
  if (acceptance?.authority?.delegate !== 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION'
      || acceptance?.authority?.internalDesignReviewAccepted !== true
      || acceptance?.authority?.independentHumanSpecialistAttestation !== false
      || acceptance?.authority?.externalContractOwnerAcceptance !== false
      || acceptance?.authority?.technicalCurrentnessRecapturedInThisDecision !== false
      || acceptance?.authority?.newPhaseExitPublished !== false) blockers.push('OWNER_DIRECTION_AUTHORITY_ATTRIBUTION_INVALID');
  if (acceptance?.decidedPolicy?.predecessorSemanticNonImpact
      !== 'APPROVED_EXACT_DELTA_ONLY_CONDITIONAL_ON_FRESH_FILE_MEMBERSHIP_AND_TECHNICAL_CURRENTNESS') blockers.push('OWNER_DELTA_NOT_CONDITIONALLY_APPROVED');
  if (review?.sourceCut !== 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-13-r2.json'
      || review?.historicalExitStatus !== 'PASS'
      || review?.previousMaterialFingerprint !== 'sha256:7a7a0f700890915863e9f93eafa30edc2f6d856adbf7944c17fecc0aadd8031b'
      || review?.historicalRequiredPathCount !== 146
      || review?.pinComparison?.matching !== 142
      || review?.pinComparison?.changed !== 4
      || review?.pinComparison?.missing !== 0
      || review?.ownerDesignDisposition !== 'APPROVE_REUSE_OF_PRIOR_PHASE_MEANING_FOR_EXACT_REVIEWED_DELTA_WITH_NO_NEW_MEANING_IDS'
      || review?.actualTechnicalCurrentnessAtThisCut !== 'NOT_REESTABLISHED'
      || !review?.tasks?.includes('RC-P0-01')) blockers.push('PDP0_PREDECESSOR_REVIEW_MISMATCH');

  const previousDigests = historicalPdp0Exit?.sourceCurrentness?.sourceContentDigests ?? {};
  const currentDigests = technicalCurrentness?.sourceContentDigests ?? {};
  const sourceChanges = review?.sourceChanges ?? [];
  const approvedChanges = new Map(sourceChanges.map((change) => [change.path, change]));
  if (sourceChanges.length !== 4 || [...approvedChanges.keys()].some((sourcePath) => !REVIEWED_PDP0_CHANGES.has(sourcePath))
      || [...REVIEWED_PDP0_CHANGES].some((sourcePath) => !approvedChanges.has(sourcePath))) blockers.push('OWNER_REVIEWED_DELTA_PATH_SET_MISMATCH');

  const previousPaths = Object.keys(previousDigests).sort();
  const currentPaths = Object.keys(currentDigests).sort();
  const previousPathSet = new Set(previousPaths);
  const currentPathSet = new Set(currentPaths);
  const missingPaths = previousPaths.filter((sourcePath) => !currentPathSet.has(sourcePath));
  const additionalPaths = currentPaths.filter((sourcePath) => !previousPathSet.has(sourcePath));
  if (previousPaths.length !== 146 || currentPaths.length !== 146 || missingPaths.length || additionalPaths.length) {
    blockers.push('PDP0_MATERIAL_PATH_MEMBERSHIP_CHANGED');
  }

  const pathComparisons = previousPaths.map((sourcePath) => {
    const priorDigest = previousDigests[sourcePath];
    const currentDigest = currentDigests[sourcePath];
    const approved = approvedChanges.get(sourcePath);
    const expectedDigest = approved?.observedSha256 ?? priorDigest;
    if (approved && (approved.recordedSha256 !== priorDigest
        || approved.meaningIdsChangedAtReviewedCut?.length !== 0
        || approved.requiresFreshCurrentness !== true)) blockers.push(`OWNER_REVIEWED_DELTA_RECORD_MISMATCH:${sourcePath}`);
    if (currentDigest !== expectedDigest) blockers.push(`PDP0_SOURCE_DIGEST_NOT_OWNER_REVIEWED:${sourcePath}`);
    return {
      path: sourcePath,
      predecessorDigest: priorDigest,
      ownerReviewedDigest: expectedDigest,
      observedDigest: currentDigest ?? null,
      disposition: currentDigest === priorDigest ? 'UNCHANGED' : approved && currentDigest === expectedDigest ? 'OWNER_APPROVED_DELTA' : 'UNAPPROVED_CHANGE',
    };
  });
  if (sourceChanges.some((change) => !previousPathSet.has(change.path))) blockers.push('OWNER_REVIEWED_DELTA_PATH_NOT_IN_PREDECESSOR_SET');
  const unchangedCount = pathComparisons.filter((entry) => entry.disposition === 'UNCHANGED').length;
  const approvedDeltaCount = pathComparisons.filter((entry) => entry.disposition === 'OWNER_APPROVED_DELTA').length;
  const unapprovedChangeCount = pathComparisons.filter((entry) => entry.disposition === 'UNAPPROVED_CHANGE').length;

  return {
    blockers: [...new Set(blockers)],
    sourceComparison: {
      predecessorExitRef: review?.sourceCut ?? null,
      predecessorMaterialSourceSetFingerprint: review?.previousMaterialFingerprint ?? null,
      ownerDirectionsRef: 'docs/implementation/observations/media-discovery-current-cut-owner-directions-2026-10-13-r2.json',
      ownerDecisionId: acceptance?.decisionId ?? null,
      ownerReviewedHead: acceptance?.reviewed?.head ?? null,
      predecessorPathCount: previousPaths.length,
      observedPathCount: currentPaths.length,
      unchangedPathCount: unchangedCount,
      ownerApprovedChangedPathCount: approvedDeltaCount,
      unapprovedChangedPathCount: unapprovedChangeCount,
      missingPathCount: missingPaths.length,
      additionalPathCount: additionalPaths.length,
      missingPaths,
      additionalPaths,
      paths: pathComparisons,
    },
  };
}

function validateOwnerAcceptance(acceptance, technicalCurrentness, historicalPdp0Exit) {
  if (acceptance?.recordKind === 'SCOPED_DELEGATED_MEDIA_OWNER_DESIGN_AND_MATERIAL_IMPACT_DECISIONS_NOT_TECHNICAL_CURRENTNESS_NOT_LIFECYCLE_RECEIPT') {
    return validateCurrentCutOwnerDirections(acceptance, technicalCurrentness, historicalPdp0Exit);
  }
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
  return { blockers, sourceComparison: null };
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
export function joinMediaPdp0PhaseExit({ technicalCurrentness, ownerAcceptance, historicalPdp0Exit, testOutcomes, baselineSha, observedAt = new Date().toISOString() }) {
  const technicalBlockers = validateTechnicalCurrentness(technicalCurrentness);
  const ownerValidation = validateOwnerAcceptance(ownerAcceptance, technicalCurrentness, historicalPdp0Exit);
  const ownerBlockers = ownerValidation.blockers;
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
      ownerInputKind: ownerAcceptance?.recordKind ?? 'UNKNOWN',
      actorKind: ownerAcceptance?.authority?.actorKind ?? null,
      acceptedMaterialSourceSetFingerprint: ownerAcceptance?.subject?.materialSourceSetFingerprint ?? null,
      changedMeaningIds: ownerAcceptance?.subject?.changedMeaningIds ?? null,
      outstandingMeaningIds: ownerAcceptance?.subject?.outstandingMeaningIds ?? null,
      humanIndependentSignatureProvided: ownerAcceptance?.authority?.humanIndependentSignatureProvided ?? null,
      qualifiedExternalSpecialistSignoffProvided: ownerAcceptance?.authority?.qualifiedExternalSpecialistSignoffProvided ?? null,
      status: ownerBlockers.length ? 'BLOCKED' : 'ACCEPTED_FOR_EXACT_MATERIAL_FINGERPRINT',
      blockers: ownerBlockers,
    },
    ownerStatusJoin: ownerValidation.sourceComparison ? {
      ...ownerValidation.sourceComparison,
      freshMaterialSourceSetFingerprint: technicalCurrentness?.materialSourceSetFingerprint ?? null,
      status: ownerBlockers.length ? 'BLOCKED' : 'ACCEPTED_FOR_EXACT_CURRENT_FINGERPRINT_WITH_REVIEWED_DELTA',
      limitation: 'This source-bound internal delegated owner-status join reuses prior phase meaning only for the exact approved source delta; it is not independent approval, lifecycle closure, runtime admission, Build entry, or Delivery readiness.',
    } : null,
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
