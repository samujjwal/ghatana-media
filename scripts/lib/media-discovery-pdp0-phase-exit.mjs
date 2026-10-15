import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyAdditionalPdp0SourceImpact, classifyPdp0SuccessorImpact } from '../record-media-discovery-pdp0-currentness.mjs';

const EXPECTED_SCOPE = {
  physicalCandidates: 26,
  semanticCompositions: 6,
  repositoryRoots: 1,
  consumers: 17,
  totalCells: 50,
};

export function parseMediaPdp0PhaseExitArgs(argv) {
  const suffix = argv[2] ?? '2026-10-13-r2';
  const outcomesPath = argv[3];
  const currentCutImpactMode = argv[4] === '--current-cut-impact';
  const successorImpactMode = argv[4] === '--successor-impact';
  const additionalImpactPath = currentCutImpactMode ? argv[5] ?? null : null;
  const successorImpactPath = successorImpactMode ? argv[5] ?? null : null;
  if (successorImpactMode && !argv[5]) throw new Error('An impact record path is required for successor mode');
  const legacyOwnerInputPath = argv[4] && !currentCutImpactMode && !successorImpactMode ? argv[4] : null;
  if (legacyOwnerInputPath && argv[5]) throw new Error('The additional PDP-0 source-impact record is supported only alongside --current-cut-impact');
  if (argv[6]) throw new Error('Unexpected PDP-0 phase-exit argument');
  return { suffix, outcomesPath, currentCutImpactMode, additionalImpactPath, successorImpactMode, successorImpactPath, legacyOwnerInputPath };
}

const REQUIRED_COMMANDS = [
  'pnpm check:physical-topology',
  'pnpm test:physical-topology',
  'pnpm check:product-definition-authority',
  'pnpm check:product-experience-local',
  'node --test tests/media-discovery-currentness.test.mjs tests/media-discovery-pdp0-phase-exit.test.mjs',
];
const PXD164_SUCCESSOR_REQUIRED_COMMAND = 'node --test tests/media-discovery-pdp0-supplemental-impact-join.test.mjs';

export function resolveMediaPdp0SuccessorPredecessorRefs(recordId) {
  const predecessors = {
    'MEDIA-DISCOVERY-PDP0-R6-SUCCESSOR-IMPACT-2026-10-14-R1': {
      exitRef: 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r6.json',
      currentnessRef: 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r6.json',
    },
    'MEDIA-DISCOVERY-PDP0-R8-SUCCESSOR-IMPACT-2026-10-14-R2': {
      exitRef: 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r8.json',
      currentnessRef: 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r8.json',
    },
    'MEDIA-DISCOVERY-PDP0-PXD164-SUCCESSOR-IMPACT-2026-10-14-R1': {
      exitRef: 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r10.json',
      currentnessRef: 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r10.json',
    },
    'MEDIA-DISCOVERY-PDP0-R11-SUCCESSOR-IMPACT-2026-10-14-R1': {
      exitRef: 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r11.json',
      currentnessRef: 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r11.json',
    },
    'MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R1': {
      exitRef: 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r12.json',
      currentnessRef: 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r12.json',
    },
    'MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R2': {
      exitRef: 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r12.json',
      currentnessRef: 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r12.json',
    },
  };
  const predecessor = predecessors[recordId];
  if (!predecessor) throw new Error(`Unsupported PDP-0 successor impact recordId: ${recordId}`);
  return predecessor;
}

const REVIEWED_PDP0_CHANGES = new Set([
  '.product-experience/artifact-identities.yaml',
  '.product-experience/source-manifest.yaml',
  '.product-experience/surface-registry.yaml',
  'apps/media-experience-explorer/specification-artifacts.json',
]);
const SUPPLEMENTAL_IMPACT_PATH = 'docs/implementation/observations/media-discovery-predecessor-impact-pdp3-status-guard-2026-10-14-r1.json';
const SUPPLEMENTAL_DECISION = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../', SUPPLEMENTAL_IMPACT_PATH), 'utf8'));
const CURRENT_CUT_IMPACT_PATH = 'docs/implementation/observations/media-discovery-current-cut-source-impact-2026-10-14-r1.json';
const CURRENT_CUT_PREDECESSOR_PATH = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r2.json';

const empty = (value) => Array.isArray(value) && value.length === 0;

function validateCurrentCutOwnerDirections(acceptance, technicalCurrentness, historicalPdp0Exit, supplementalDecision = SUPPLEMENTAL_DECISION) {
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
  const supplemental = supplementalDecision?.sourceDelta;
  const supplementalValid = supplementalDecision?.schemaVersion === 'media.discovery-predecessor-source-impact.v1'
    && supplementalDecision?.recordId === 'MEDIA-DISCOVERY-PREDECESSOR-IMPACT-PDP3-STATUS-GUARD-2026-10-14-R1'
    && supplementalDecision?.campaign?.repository === 'samujjwal/ghatana-media'
    && supplementalDecision?.campaign?.stage === 'DISCOVERY'
    && supplementalDecision?.campaign?.activePhase === 'PDP-0'
    && supplementalDecision?.campaign?.reviewedSourceBaseline === 'f5ae3461c53eb1d490362a9bb8818ce74573147c'
    && supplementalDecision?.authority?.delegate === 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION'
    && supplementalDecision?.authority?.decisionRole === 'SCOPED_INTERNAL_MEDIA_PRODUCT_AND_ENGINEERING_SOURCE_IMPACT_REVIEW'
    && supplementalDecision?.authority?.humanIndependentSignatureProvided === false
    && supplementalDecision?.authority?.qualifiedExternalSpecialistSignoffProvided === false
    && supplementalDecision?.authority?.externalContractOwnerAcceptanceProvided === false
    && supplementalDecision?.authority?.nativeLifecycleReceiptProvided === false
    && supplementalDecision?.decision?.status === 'APPROVED_INTERNAL_NON_IMPACT_FOR_EXACT_SOURCE_DELTA'
    && supplementalDecision?.decision?.requiresOrderedTechnicalCurrentnessRecapture?.includes('PDP-0')
    && supplemental?.path === 'scripts/report-media-pdp-readiness.mjs'
    && supplemental?.predecessorSha256 === 'sha256:6655e0344b7f4b03f6ca0b7e594a5448eed72ae5aeac198cef4bb1b28252028c'
    && supplemental?.observedSha256 === 'sha256:f3482cf689e0be2d8dc9faf9ccc72a1b63a1dcaecd056efaa1759e6f3696a5e1'
    && supplemental?.freshCurrentnessRequired === true
    && empty(supplemental?.changedMeaningIds)
    && empty(supplemental?.outstandingPredecessorMeaningIds)
    && supplemental?.predecessorPhaseMeaningDisposition?.['PDP-0'] === 'NO_MEANING_CHANGE'
    && supplementalDecision?.predecessorCuts?.some((cut) => cut.phase === 'PDP-0'
      && cut.receiptRef === 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r1.json'
      && cut.receiptSha256 === 'sha256:48f8e6fa4cb7373a66f5a33524ba89a471a1e19ab719aa2800fccec08e82ea49'
      && cut.materialSourceSetFingerprint === 'sha256:8a60cf8a09e671b09729563039d31aed69b21934a59cade1af9833ca9af86cb9'
      && cut.materialPathCount === 146 && cut.recordedPathDigest === supplemental.predecessorSha256);
  if (!supplementalValid) blockers.push('SUPPLEMENTAL_PREDECESSOR_IMPACT_DECISION_INVALID');
  const approvedChanges = new Map(sourceChanges.map((change) => [change.path, change]));
  if (sourceChanges.length !== 4 || [...approvedChanges.keys()].some((sourcePath) => !REVIEWED_PDP0_CHANGES.has(sourcePath))
      || [...REVIEWED_PDP0_CHANGES].some((sourcePath) => !approvedChanges.has(sourcePath))) blockers.push('OWNER_REVIEWED_DELTA_PATH_SET_MISMATCH');
  approvedChanges.set(supplemental?.path, {
    path: supplemental?.path,
    recordedSha256: supplemental?.predecessorSha256,
    observedSha256: supplemental?.observedSha256,
    meaningIdsChangedAtReviewedCut: supplemental?.changedMeaningIds,
    requiresFreshCurrentness: supplemental?.freshCurrentnessRequired,
  });

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
      supplementalImpactRef: SUPPLEMENTAL_IMPACT_PATH,
      supplementalDecisionId: supplementalDecision?.recordId ?? null,
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

function sha256File(relativePath) {
  const absolutePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../', relativePath);
  return `sha256:${createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex')}`;
}

function validateCurrentCutImpactDisposition(impact, technicalCurrentness, historicalPdp0Exit, additionalSourceImpact = null, additionalSourceImpactPath = null) {
  const blockers = [];
  const reporterPath = 'scripts/report-media-pdp-readiness.mjs';
  const deltas = impact?.sourceDeltas ?? [];
  const reporter = deltas.find((entry) => entry.path === reporterPath);
  const expectedDeltaPaths = [
    '.product-experience/interface-parity/current-source-review.json',
    reporterPath,
    'tests/media-pdp-p1-dev-status.test.mjs',
  ].sort();
  const actualDeltaPaths = deltas.map((entry) => entry.path).sort();
  const interfaceReview = deltas.find((entry) => entry.path === '.product-experience/interface-parity/current-source-review.json');
  const regressionTest = deltas.find((entry) => entry.path === 'tests/media-pdp-p1-dev-status.test.mjs');
  const predecessorCut = impact?.predecessorCuts?.find((entry) => entry.phase === 'PDP-0');
  const linkedPriorImpact = reporter?.predecessorChain?.[0];
  const priorImpactPath = 'docs/implementation/observations/media-discovery-predecessor-impact-pdp3-status-guard-2026-10-14-r1.json';
  let priorImpact = null;
  try {
    priorImpact = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../', priorImpactPath), 'utf8'));
  } catch {
    blockers.push('PRIOR_IMPACT_RECORD_UNAVAILABLE');
  }
  const priorReporter = priorImpact?.sourceDelta;
  if (impact?.schemaVersion !== 'media.discovery-current-cut-source-impact.v1'
      || impact?.recordId !== 'MEDIA-DISCOVERY-CURRENT-CUT-SOURCE-IMPACT-2026-10-14-R1') blockers.push('CURRENT_CUT_IMPACT_IDENTITY_INVALID');
  if (impact?.campaign?.repository !== 'samujjwal/ghatana-media'
      || impact?.campaign?.stage !== 'DISCOVERY'
      || impact?.campaign?.activePhase !== 'PDP-0'
      || impact?.campaign?.reviewedSourceBaseline !== 'f5ae3461c53eb1d490362a9bb8818ce74573147c') blockers.push('CURRENT_CUT_IMPACT_SCOPE_INVALID');
  if (impact?.authority?.delegate !== 'AI_ASSISTANT_ACTING_UNDER_EXPLICIT_USER_DELEGATION'
      || impact?.authority?.userAuthorization !== 'Authorize scoped impact disposition (Recommended)'
      || impact?.authority?.decisionRole !== 'SCOPED_INTERNAL_MEDIA_SOURCE_IMPACT_REVIEW'
      || impact?.authority?.humanIndependentSignatureProvided !== false
      || impact?.authority?.qualifiedExternalSpecialistSignoffProvided !== false
      || impact?.authority?.externalContractOwnerAcceptanceProvided !== false
      || impact?.authority?.nativeLifecycleReceiptProvided !== false) blockers.push('CURRENT_CUT_IMPACT_AUTHORITY_INVALID');
  if (impact?.decision?.status !== 'APPROVED_INTERNAL_IMPACT_DISPOSITION_FOR_EXACT_SOURCE_DELTAS'
      || impact?.decision?.pdp0MeaningDisposition !== 'NO_MEANING_CHANGE_FOR_EXACT_REVIEWED_SOURCE_DELTAS'
      || impact?.decision?.independentApproval !== 'NOT_CLAIMED_AND_NOT_WAIVED'
      || impact?.decision?.externalContractOwnerAcceptance !== 'NOT_CLAIMED'
      || impact?.decision?.nativeLifecycleClosure !== 'NOT_ENTERED'
      || impact?.decision?.runtimeAdmission !== 'NOT_ADMITTED'
      || impact?.decision?.delivery !== 'BLOCKED'
      || JSON.stringify(impact?.decision?.requiresOrderedTechnicalCurrentnessRecapture) !== JSON.stringify(['PDP-0', 'PDP-1'])) blockers.push('CURRENT_CUT_IMPACT_DECISION_INVALID');
  if (JSON.stringify(actualDeltaPaths) !== JSON.stringify(expectedDeltaPaths)
      || deltas.length !== 3) blockers.push('CURRENT_CUT_IMPACT_PATH_SET_INVALID');
  if (reporter?.phases?.join(',') !== 'PDP-0,PDP-1'
      || reporter?.classification !== 'PDP_STATUS_TEST_REPORTER_SELECTION_ONLY'
      || reporter?.historicalPdp0MaterialSha256 !== 'sha256:6655e0344b7f4b03f6ca0b7e594a5448eed72ae5aeac198cef4bb1b28252028c'
      || reporter?.predecessorSha256 !== 'sha256:f3482cf689e0be2d8dc9faf9ccc72a1b63a1dcaecd056efaa1759e6f3696a5e1'
      || reporter?.observedSha256 !== 'sha256:ca59f6c4e1313bd58387f91b41eb51fc1a10ac04b2db01faed30b9edcc9b2573'
      || reporter?.meaningIdsChanged?.length !== 0
      || reporter?.requiresFreshCurrentness !== true) blockers.push('CURRENT_CUT_REPORTER_DELTA_INVALID');
  if (interfaceReview?.phases?.join(',') !== 'PDP-1'
      || interfaceReview?.predecessorSha256 !== 'sha256:14cf6c3d9ea948e39e41ffa2de3453c08b7b6a23267f407f3504c5462b7428fc'
      || interfaceReview?.observedSha256 !== 'sha256:62765cbb335572f28570fe650b3955aaa028f314322490e17e466d3ca9234abf'
      || interfaceReview?.classification !== 'PDP1_REVIEW_ARTIFACT_REFRESH_FOR_SEPARATELY_REVIEWED_OPERATION_DELTA'
      || interfaceReview?.additionalMeaningIds?.length !== 0
      || interfaceReview?.meaningChange !== 'NO_ADDITIONAL_MEANING_BEYOND_SEPARATELY_REVIEWED_PDP1_OPERATION_DELTA') blockers.push('CURRENT_CUT_INTERFACE_REVIEW_DELTA_INVALID');
  if (regressionTest?.phases?.join(',') !== 'PDP-1'
      || regressionTest?.predecessorSha256 !== 'sha256:5a007a561cc96659d7da63d2470727237d1496c3a50c80682253a9d542846599'
      || regressionTest?.observedSha256 !== 'sha256:3ff1576a4a3987f5b1e05d15ae77e35a62745260e127ebcb28c1bb49ef7ef82e'
      || regressionTest?.classification !== 'REGRESSION_COVERAGE'
      || regressionTest?.meaningChange !== 'NONE'
      || regressionTest?.meaningIdsChanged?.length !== 0) blockers.push('CURRENT_CUT_REGRESSION_TEST_DELTA_INVALID');
  if (linkedPriorImpact?.receiptRef !== priorImpactPath
      || linkedPriorImpact?.receiptSha256 !== sha256File(priorImpactPath)
      || linkedPriorImpact?.fromSha256 !== 'sha256:6655e0344b7f4b03f6ca0b7e594a5448eed72ae5aeac198cef4bb1b28252028c'
      || linkedPriorImpact?.toSha256 !== reporter?.predecessorSha256
      || priorReporter?.path !== reporterPath
      || priorReporter?.predecessorSha256 !== linkedPriorImpact?.fromSha256
      || priorReporter?.observedSha256 !== linkedPriorImpact?.toSha256) blockers.push('CURRENT_CUT_IMPACT_PREDECESSOR_CHAIN_INVALID');
  if (predecessorCut?.receiptRef !== CURRENT_CUT_PREDECESSOR_PATH
      || predecessorCut?.receiptSha256 !== sha256File(CURRENT_CUT_PREDECESSOR_PATH)
      || predecessorCut?.materialSourceSetFingerprint !== 'sha256:20e8a999b36e7fb61662183200f1e8c83eebb39523c5ab8835bea311af1f31e8'
      || predecessorCut?.materialPathCount !== 146
      || predecessorCut?.reporterSha256 !== reporter?.predecessorSha256) blockers.push('CURRENT_CUT_PDP0_PREDECESSOR_INVALID');
  if (historicalPdp0Exit?.phase !== 'PDP-0'
      || historicalPdp0Exit?.phaseExit?.status !== 'PASS'
      || historicalPdp0Exit?.sourceCurrentness?.materialSourceSetFingerprint !== predecessorCut?.materialSourceSetFingerprint
      || Object.keys(historicalPdp0Exit?.sourceCurrentness?.sourceContentDigests ?? {}).length !== 146) blockers.push('CURRENT_CUT_PDP0_RECEIPT_NOT_EXACT_PREDECESSOR');

  const previous = historicalPdp0Exit?.sourceCurrentness?.sourceContentDigests ?? {};
  const current = technicalCurrentness?.sourceContentDigests ?? {};
  const priorPaths = Object.keys(previous).sort();
  const currentPaths = Object.keys(current).sort();
  const missingPaths = priorPaths.filter((sourcePath) => !Object.hasOwn(current, sourcePath));
  const additionalPaths = currentPaths.filter((sourcePath) => !Object.hasOwn(previous, sourcePath));
  if (priorPaths.length !== 146 || currentPaths.length !== 146 || missingPaths.length || additionalPaths.length) {
    blockers.push('PDP0_MATERIAL_PATH_MEMBERSHIP_CHANGED');
  }
  const decisionLogPath = '.product-experience/decision-log.md';
  const additionalPin = {
    path: decisionLogPath,
    recordedDigest: previous[decisionLogPath],
    currentDigest: current[decisionLogPath],
    disposition: previous[decisionLogPath] === current[decisionLogPath] ? 'MATCH' : 'CHANGED',
  };
  const additionalDisposition = additionalSourceImpact
    ? classifyAdditionalPdp0SourceImpact([additionalPin], additionalSourceImpact, additionalSourceImpactPath)
    : null;
  if (additionalSourceImpact && !additionalDisposition) blockers.push('ADDITIONAL_PDP0_SOURCE_IMPACT_INVALID');
  const comparisons = priorPaths.map((sourcePath) => {
    const priorDigest = previous[sourcePath];
    const observedDigest = current[sourcePath];
    const approved = sourcePath === reporterPath;
    const internallyDispositioned = sourcePath === decisionLogPath && additionalDisposition !== null;
    const expected = approved ? reporter?.observedSha256 : internallyDispositioned ? additionalSourceImpact.observedSha256 : priorDigest;
    if (observedDigest !== expected) blockers.push(approved
      ? 'PDP0_REPORTER_DIGEST_NOT_AUTHORIZED'
      : `PDP0_SOURCE_DIGEST_NOT_OWNER_REVIEWED:${sourcePath}`);
    return {
      path: sourcePath,
      predecessorDigest: priorDigest,
      ownerReviewedDigest: expected,
      observedDigest: observedDigest ?? null,
      disposition: observedDigest === priorDigest ? 'UNCHANGED'
        : approved && observedDigest === expected ? 'OWNER_APPROVED_DELTA'
          : internallyDispositioned && observedDigest === expected ? 'INTERNAL_IMPACT_DISPOSITION' : 'UNAPPROVED_CHANGE',
    };
  });
  const unchangedCount = comparisons.filter((entry) => entry.disposition === 'UNCHANGED').length;
  const approvedCount = comparisons.filter((entry) => entry.disposition === 'OWNER_APPROVED_DELTA').length;
  const internalImpactCount = comparisons.filter((entry) => entry.disposition === 'INTERNAL_IMPACT_DISPOSITION').length;
  const unapprovedCount = comparisons.filter((entry) => entry.disposition === 'UNAPPROVED_CHANGE').length;
  if (unchangedCount !== 145 - internalImpactCount || approvedCount !== 1 || internalImpactCount !== (additionalDisposition ? 1 : 0) || unapprovedCount !== 0) blockers.push('PDP0_CURRENT_CUT_DELTA_COUNTS_INVALID');

  return {
    blockers: [...new Set(blockers)],
    sourceComparison: {
      predecessorExitRef: predecessorCut?.receiptRef ?? null,
      predecessorMaterialSourceSetFingerprint: predecessorCut?.materialSourceSetFingerprint ?? null,
      ownerDirectionsRef: null,
      supplementalImpactRef: CURRENT_CUT_IMPACT_PATH,
      supplementalDecisionId: impact?.recordId ?? null,
      supplementalImpactSha256: sha256File(CURRENT_CUT_IMPACT_PATH),
      predecessorPathCount: priorPaths.length,
      observedPathCount: currentPaths.length,
      unchangedPathCount: unchangedCount,
      ownerApprovedChangedPathCount: approvedCount,
      internalImpactDispositionCount: internalImpactCount,
      additionalSourceImpact: additionalDisposition ? {
        recordId: additionalSourceImpact.recordId,
        ref: additionalSourceImpactPath,
        sha256: additionalDisposition.authoritySha256,
        path: additionalDisposition.path,
        predecessorSha256: additionalDisposition.predecessorSha256,
        observedSha256: additionalDisposition.observedSha256,
        classification: additionalDisposition.classification,
        ownerAcceptance: additionalSourceImpact.ownerAcceptance,
        independentReview: additionalSourceImpact.independentReview,
      } : null,
      unapprovedChangedPathCount: unapprovedCount,
      missingPathCount: missingPaths.length,
      additionalPathCount: additionalPaths.length,
      missingPaths,
      additionalPaths,
      paths: comparisons,
    },
  };
}

function validatePdp0SuccessorImpactDisposition(record, technicalCurrentness, historicalPdp0Exit, recordPath) {
  const blockers = [];
  const isPxd164Successor = record?.recordId === 'MEDIA-DISCOVERY-PDP0-PXD164-SUCCESSOR-IMPACT-2026-10-14-R1';
  const isR8Successor = record?.recordId === 'MEDIA-DISCOVERY-PDP0-R8-SUCCESSOR-IMPACT-2026-10-14-R2';
  const isR11Successor = record?.recordId === 'MEDIA-DISCOVERY-PDP0-R11-SUCCESSOR-IMPACT-2026-10-14-R1';
  const isR12Successor = record?.recordId === 'MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R1'
    || record?.recordId === 'MEDIA-DISCOVERY-PDP0-R12-SUCCESSOR-IMPACT-2026-10-14-R2';
  const predecessorLabel = isR12Successor ? 'R12' : isR11Successor ? 'R11' : isPxd164Successor ? 'R10' : isR8Successor ? 'R8' : 'R6';
  const predecessorExitRef = isR12Successor
    ? 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r12.json'
    : isR11Successor
    ? 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r11.json'
    : isPxd164Successor
    ? 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r10.json'
    : isR8Successor
      ? 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r8.json'
      : 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r6.json';
  const predecessorCurrentnessRef = isR12Successor
    ? 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r12.json'
    : isR11Successor
    ? 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r11.json'
    : isPxd164Successor
    ? 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r10.json'
    : isR8Successor
      ? 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r8.json'
      : 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r6.json';
  const priorPxd163ImpactPath = 'docs/implementation/observations/media-discovery-pdp0-pxd163-source-impact-2026-10-14-r1.json';
  const previous = historicalPdp0Exit?.sourceCurrentness?.sourceContentDigests ?? {};
  const current = technicalCurrentness?.sourceContentDigests ?? {};
  const previousPaths = Object.keys(previous).sort();
  const currentPaths = Object.keys(current).sort();
  const missingPaths = previousPaths.filter((sourcePath) => !Object.hasOwn(current, sourcePath));
  const additionalPaths = currentPaths.filter((sourcePath) => !Object.hasOwn(previous, sourcePath));
  if (previousPaths.length !== 146 || currentPaths.length !== 146 || missingPaths.length || additionalPaths.length) {
    blockers.push(`PDP0_${predecessorLabel}_SUCCESSOR_PATH_MEMBERSHIP_CHANGED`);
  }
  const comparisons = previousPaths.map((sourcePath) => ({
    path: sourcePath,
    recordedDigest: previous[sourcePath],
    currentDigest: current[sourcePath] ?? null,
    disposition: current[sourcePath] === previous[sourcePath] ? 'MATCH' : 'CHANGED',
  }));
  const classified = classifyPdp0SuccessorImpact(comparisons, record, recordPath, technicalCurrentness);
  if (!classified) blockers.push(`PDP0_${predecessorLabel}_SUCCESSOR_IMPACT_INVALID`);
  const priorPxd163 = technicalCurrentness?.historicalPdp0PinDriftClassifications?.find((entry) => entry.path === '.product-experience/decision-log.md');
  if (!isPxd164Successor && !isR11Successor && !isR12Successor && (priorPxd163?.classification !== 'INTERNAL_SCOPED_IMPACT_DISPOSITION'
      || priorPxd163?.authorityRef !== priorPxd163ImpactPath
      || priorPxd163?.authoritySha256 !== sha256File(priorPxd163ImpactPath)
      || priorPxd163?.predecessorSha256 !== 'sha256:cdea20d6fa57cc4d7bbea866d911c03685eeb74e0bfdb4e0a5df0c90ded56db4'
      || priorPxd163?.observedSha256 !== 'sha256:9831b03ecd3f30d2cbfd7a1db62d934035ba20cf1482bb5e621d166eacdb9b4c'
      || priorPxd163?.disposition !== 'CHANGED')) blockers.push(`PDP0_${predecessorLabel}_SUCCESSOR_PXD163_PREDECESSOR_CLASSIFICATION_MISSING`);
  const carriedPxd163 = technicalCurrentness?.historicalPdp0PinDriftClassifications?.find((entry) => entry.path === '.product-experience/decision-log.md'
    && entry.authorityRef === priorPxd163ImpactPath);
  if (isPxd164Successor && (carriedPxd163?.classification !== 'INTERNAL_SCOPED_IMPACT_DISPOSITION'
      || carriedPxd163?.authoritySha256 !== sha256File(priorPxd163ImpactPath)
      || carriedPxd163?.impactDelta?.predecessorSha256 !== 'sha256:cdea20d6fa57cc4d7bbea866d911c03685eeb74e0bfdb4e0a5df0c90ded56db4'
      || carriedPxd163?.impactDelta?.observedSha256 !== 'sha256:9831b03ecd3f30d2cbfd7a1db62d934035ba20cf1482bb5e621d166eacdb9b4c')) {
    blockers.push('PDP0_R10_SUCCESSOR_PXD163_PREDECESSOR_CLASSIFICATION_MISSING');
  }
  const expectedDeltas = isR12Successor
    ? record?.sourceDeltas?.map(({ path: sourcePath, predecessorSha256, observedSha256 }) => ({
      path: sourcePath,
      predecessor: predecessorSha256,
      observed: observedSha256,
    })) ?? []
    : [isR11Successor
    ? { path: '.product-experience/pdp-0-product-truth/generated/product-definition.candidate.json', predecessor: 'sha256:13c0789a6fa94c51abfbc60da8465e340406947a3f5a1dff4ec5a37bcef7e341', observed: 'sha256:6cfb42b2fbf2e24ca904ab93ca98c905a6b892069f811f2f73166d7dc7e8de49' }
    : isPxd164Successor
    ? { path: '.product-experience/decision-log.md', predecessor: 'sha256:9831b03ecd3f30d2cbfd7a1db62d934035ba20cf1482bb5e621d166eacdb9b4c', observed: 'sha256:97ad3104abec9ba6670804394c68a11c663f37171e90ea2a1f2e629aa5619bbc' }
    : isR8Successor
      ? { path: 'tests/pdp-truth-domain.test.mjs', predecessor: 'sha256:0d94c83f6c081f2e67a4ba20752c0cdfff03f26ae1d9d87860d9ba97047964e0', observed: 'sha256:8ef1a6d5e11dc2e10ca32c3e6813fc8671c22a6c7f7038d48300d52f8feae578' }
      : { path: 'scripts/report-media-pdp-readiness.mjs', predecessor: 'sha256:ca59f6c4e1313bd58387f91b41eb51fc1a10ac04b2db01faed30b9edcc9b2573', observed: 'sha256:4f0400c142d2f3df39c4497839925dad80f1ac90584573b390af386e491faa0f' }];
  const unexpectedChanges = comparisons.filter((entry) => entry.disposition !== 'MATCH'
    && !expectedDeltas.some((delta) => entry.path === delta.path
      && entry.recordedDigest === delta.predecessor
      && entry.currentDigest === delta.observed));
  if (unexpectedChanges.length) blockers.push(`PDP0_${predecessorLabel}_SUCCESSOR_UNREVIEWED_SOURCE_DELTA`);
  const successorChanges = comparisons.filter((entry) => entry.disposition === 'CHANGED'
    && expectedDeltas.some((delta) => entry.path === delta.path
      && entry.recordedDigest === delta.predecessor
      && entry.currentDigest === delta.observed));
  if (successorChanges.length !== expectedDeltas.length) blockers.push(`PDP0_${predecessorLabel}_SUCCESSOR_AUTHORIZED_DELTA_MISSING`);
  if (historicalPdp0Exit?.phase !== 'PDP-0' || historicalPdp0Exit?.phaseExit?.status !== 'PASS'
      || historicalPdp0Exit?.sourceCurrentness?.cells?.length !== 50
      || technicalCurrentness?.physicalCompositeConsumerCells?.length !== 50
      || technicalCurrentness?.physicalCompositeConsumerCells?.some((cell) => cell.sourceCurrentness !== 'CURRENT')) {
    blockers.push(`PDP0_${predecessorLabel}_SUCCESSOR_PREDECESSOR_OR_TOPOLOGY_INVALID`);
  }
  const unchangedCount = comparisons.filter((entry) => entry.disposition === 'MATCH').length;
  return {
    blockers: [...new Set(blockers)],
    sourceComparison: {
      predecessorExitRef,
      predecessorCurrentnessRef,
      predecessorPathCount: previousPaths.length,
      observedPathCount: currentPaths.length,
      unchangedPathCount: unchangedCount,
      internallyDispositionedChangedPathCount: Array.isArray(classified) ? classified.length : classified ? 1 : 0,
      unreviewedChangedPathCount: unexpectedChanges.length,
      missingPathCount: missingPaths.length,
      additionalPathCount: additionalPaths.length,
      missingPaths,
      additionalPaths,
      paths: comparisons,
      successorImpact: classified,
    },
  };
}

function validateOwnerAcceptance(acceptance, technicalCurrentness, historicalPdp0Exit) {
  if (acceptance?.schemaVersion === 'media.discovery-current-cut-source-impact.v1') {
    return validateCurrentCutImpactDisposition(acceptance, technicalCurrentness, historicalPdp0Exit);
  }
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

function validateChecks(testOutcomes, requirePxd164ImpactTest = false) {
  const blockers = [];
  const byCommand = new Map((testOutcomes ?? []).map((outcome) => [outcome.command, outcome]));
  const requiredCommands = requirePxd164ImpactTest
    ? [...REQUIRED_COMMANDS, PXD164_SUCCESSOR_REQUIRED_COMMAND]
    : REQUIRED_COMMANDS;
  for (const command of requiredCommands) {
    const outcome = byCommand.get(command);
    if (!outcome) {
      blockers.push(`REQUIRED_CHECK_NOT_RECORDED:${command}`);
      continue;
    }
    if (outcome.status !== 'PASS' || outcome.exitCode !== 0) blockers.push(`REQUIRED_CHECK_FAILED:${command}`);
    if (command.startsWith('node --test ') && (!Number.isInteger(outcome.testCount) || outcome.testCount < 1
        || !Number.isInteger(outcome.passedCount) || !Number.isInteger(outcome.failedCount)
        || !Number.isInteger(outcome.skippedCount) || outcome.failedCount !== 0
        || outcome.passedCount < 0 || outcome.skippedCount < 0
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
export function joinMediaPdp0PhaseExit({ technicalCurrentness, ownerAcceptance, ownerAcceptancePath = null, additionalSourceImpact = null, additionalSourceImpactPath = null, historicalPdp0Exit, testOutcomes, baselineSha, observedAt = new Date().toISOString() }) {
  const technicalBlockers = validateTechnicalCurrentness(technicalCurrentness);
  const successorImpactOnly = ownerAcceptance?.schemaVersion === 'media.discovery.pdp0-successor-source-impact.v1';
  const ownerValidation = successorImpactOnly
    ? validatePdp0SuccessorImpactDisposition(ownerAcceptance, technicalCurrentness, historicalPdp0Exit, ownerAcceptancePath)
    : ownerAcceptance?.schemaVersion === 'media.discovery-current-cut-source-impact.v1'
    ? validateCurrentCutImpactDisposition(ownerAcceptance, technicalCurrentness, historicalPdp0Exit, additionalSourceImpact, additionalSourceImpactPath)
    : ownerAcceptance?.recordKind === 'SCOPED_DELEGATED_MEDIA_OWNER_DESIGN_AND_MATERIAL_IMPACT_DECISIONS_NOT_TECHNICAL_CURRENTNESS_NOT_LIFECYCLE_RECEIPT'
    ? validateCurrentCutOwnerDirections(ownerAcceptance, technicalCurrentness, historicalPdp0Exit)
    : validateOwnerAcceptance(ownerAcceptance, technicalCurrentness, historicalPdp0Exit);
  const ownerBlockers = ownerValidation.blockers;
  const impactDispositionOnly = ownerAcceptance?.schemaVersion === 'media.discovery-current-cut-source-impact.v1';
  const additionalImpactDispositionOnly = ownerValidation.sourceComparison?.additionalSourceImpact != null;
  const successorImpactDispositionOnly = successorImpactOnly && ownerValidation.sourceComparison?.successorImpact != null;
  const testBlockers = validateChecks(testOutcomes, successorImpactOnly
    && ownerAcceptance?.recordId === 'MEDIA-DISCOVERY-PDP0-PXD164-SUCCESSOR-IMPACT-2026-10-14-R1');
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
      decisionId: ownerAcceptance?.decisionId ?? ownerAcceptance?.recordId ?? null,
      decisionStatus: ownerAcceptance?.decisionStatus ?? ownerAcceptance?.decision?.status ?? 'UNKNOWN',
      ownerInputKind: ownerAcceptance?.recordKind ?? ownerAcceptance?.schemaVersion ?? 'UNKNOWN',
      actorKind: ownerAcceptance?.authority?.actorKind ?? ownerAcceptance?.authority?.delegate ?? null,
      acceptedMaterialSourceSetFingerprint: impactDispositionOnly ? null : ownerAcceptance?.subject?.materialSourceSetFingerprint ?? null,
      impactDispositionRecordId: impactDispositionOnly || successorImpactOnly ? ownerAcceptance.recordId : null,
      changedMeaningIds: ownerAcceptance?.subject?.changedMeaningIds ?? null,
      outstandingMeaningIds: ownerAcceptance?.subject?.outstandingMeaningIds ?? null,
      humanIndependentSignatureProvided: ownerAcceptance?.authority?.humanIndependentSignatureProvided ?? null,
      qualifiedExternalSpecialistSignoffProvided: ownerAcceptance?.authority?.qualifiedExternalSpecialistSignoffProvided ?? null,
      status: ownerBlockers.length ? 'BLOCKED' : successorImpactDispositionOnly
        ? 'INTERNAL_SUCCESSOR_IMPACT_DISPOSITION_ONLY_NOT_OWNER_ACCEPTANCE'
        : additionalImpactDispositionOnly
        ? 'INTERNAL_IMPACT_DISPOSITION_ONLY_NOT_OWNER_ACCEPTANCE'
        : impactDispositionOnly
          ? 'INTERNAL_IMPACT_DISPOSITION_ONLY_NOT_OWNER_ACCEPTANCE'
        : 'ACCEPTED_FOR_EXACT_MATERIAL_FINGERPRINT',
      blockers: ownerBlockers,
    },
    additionalSourceImpactDisposition: ownerValidation.sourceComparison?.additionalSourceImpact ?? null,
    successorSourceImpactDisposition: ownerValidation.sourceComparison?.successorImpact ?? null,
    ownerStatusJoin: ownerValidation.sourceComparison ? {
      ...ownerValidation.sourceComparison,
      freshMaterialSourceSetFingerprint: technicalCurrentness?.materialSourceSetFingerprint ?? null,
      status: ownerBlockers.length ? 'BLOCKED' : successorImpactDispositionOnly
        ? 'CURRENT_SOURCE_WITH_INTERNAL_SUCCESSOR_IMPACT_DISPOSITION_NOT_OWNER_ACCEPTANCE'
        : additionalImpactDispositionOnly
        ? 'CURRENT_SOURCE_WITH_SEPARATE_INTERNAL_IMPACT_DISPOSITION_NOT_OWNER_ACCEPTANCE'
        : 'ACCEPTED_FOR_EXACT_CURRENT_FINGERPRINT_WITH_REVIEWED_DELTA',
      limitation: successorImpactDispositionOnly
        ? `This source-bound join uses PDP-0 ${ownerValidation.sourceComparison?.predecessorExitRef?.match(/current-cut-(r\d+)\.json$/u)?.[1]?.toUpperCase() ?? 'UNKNOWN'} as the immediate predecessor and records one exact internal successor source-impact disposition. It does not claim owner acceptance, independent signoff, lifecycle closure, runtime admission, Build entry, or Delivery readiness.`
        : additionalImpactDispositionOnly
        ? 'This source-bound join reuses prior phase meaning only for the exact approved source delta and separately records an internal impact disposition; it does not claim owner acceptance for that disposition, independent approval, lifecycle closure, runtime admission, Build entry, or Delivery readiness.'
        : 'This source-bound internal delegated owner-status join reuses prior phase meaning only for the exact approved source delta; it is not independent approval, lifecycle closure, runtime admission, Build entry, or Delivery readiness.',
    } : null,
    testOutcomes: testOutcomes ?? [],
    phaseExit: {
      status: pass ? 'PASS' : ownerBlockers.includes('STALE_APPROVAL_FOR_CHANGED_MATERIAL')
        ? 'STALE_APPROVAL_FOR_CHANGED_MATERIAL'
        : 'FAIL',
      sourceCurrentness: technicalBlockers.length ? 'FAIL' : 'PASS',
      delegatedOwnerAcceptance: ownerBlockers.length ? 'FAIL' : impactDispositionOnly || successorImpactOnly
        ? 'NOT_CLAIMED_IMPACT_DISPOSITION_ONLY'
        : 'PASS',
      requiredChecks: testBlockers.length ? 'FAIL' : 'PASS',
      blockers,
      nextLegalAction: pass ? successorImpactOnly ? 'REVIEW_FRESH_PDP0_SUCCESSOR_CAPTURE_THEN_ORDER_PDP1_CURRENTNESS' : 'ADVANCE_TO_PDP1_MDC10' : ownerBlockers.includes('STALE_APPROVAL_FOR_CHANGED_MATERIAL')
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
