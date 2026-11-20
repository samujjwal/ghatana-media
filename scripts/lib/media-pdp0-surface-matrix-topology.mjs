export const PDP0_SOURCE_DEFINITION_REVIEW_REQUIRED_REFS = Object.freeze([
  '.product-experience/surfaces/media-physical-topology.v1.json',
  '.product-experience/pdp-0-product-truth/capabilities.yaml',
  '.product-experience/pdp-0-product-truth/requirements.yaml',
  '.product-experience/pdp-0-product-truth/goals-jtbd.yaml',
  '.product-experience/pdp-0-product-truth/dependency-contracts.yaml',
]);

const SURFACE_REVIEW_SOURCE_REFS = Object.freeze({
  'media.physical.adapters-agent-tools-media': 'docs/surfaces/adapters-agent-tools-media/README.md',
  'media.physical.adapters-data-cloud-media': 'adapters/data-cloud-media/README.md',
});

const REQUIRED_REVIEW_NONCLAIMS = Object.freeze([
  'owner acceptance',
  'independent acceptance',
  'PDP-1/PDP-2/PDP-3 completion',
  'runtime admission',
  'qualification',
  'release',
]);

export function isPdp0SourceDefinitionReviewCurrent(review, surfaceId, sourceFingerprints = {}, phaseSourceShaSet = {}, sourceCell = {}) {
  const requiredRefs = [...PDP0_SOURCE_DEFINITION_REVIEW_REQUIRED_REFS, SURFACE_REVIEW_SOURCE_REFS[surfaceId]];
  const reviewedRefs = review?.reviewedSourceRefs;
  const sourceRefsExact = requiredRefs.every(Boolean)
    && Array.isArray(reviewedRefs)
    && reviewedRefs.length === requiredRefs.length
    && new Set(reviewedRefs).size === reviewedRefs.length
    && requiredRefs.every((sourceRef) => reviewedRefs.includes(sourceRef));
  const sourceRefsCurrent = sourceRefsExact && requiredRefs.every((sourceRef) => {
    const live = sourceFingerprints[sourceRef];
    const pinned = phaseSourceShaSet[sourceRef];
    return typeof live === 'string' && /^[a-f0-9]{64}$/u.test(live)
      && typeof pinned === 'string' && /^[a-f0-9]{64}$/u.test(pinned)
      && live === pinned;
  });
  const criterionCoverage = review?.criterionCoverage;
  const validScopeDisposition = sourceCell.disposition === 'NOT_APPLICABLE_SUPPORT'
    ? review?.scopeDisposition === 'NOT_APPLICABLE_SUPPORT'
    : sourceCell.disposition === 'APPLICABLE'
      ? review?.scopeDisposition === 'APPLICABLE_INTEGRATION_BOUNDARY; REQUIREMENT_REFS_ARE_BOUNDARY_TRACE_ONLY'
      : false;
  return review?.status === 'DELEGATED_SOURCE_DEFINITION_REVIEW_COMPLETE'
    && review.authority === 'USER_EXPLICITLY_DELEGATED_SOURCE_DEFINITION_DECISION'
    && review.reviewerRole === 'delegated-agent; source-definition scope only'
    && review.phase === 'PDP-0'
    && review.reviewedSurfaceId === surfaceId
    && sourceRefsCurrent
    && review.taskDisposition === 'ZERO_OUTSTANDING_PDP0_DEFINITION_TASKS'
    && Array.isArray(review.phaseLocalTaskIds)
    && review.phaseLocalTaskIds.length === 0
    && Array.isArray(criterionCoverage)
    && criterionCoverage.length > 0
    && criterionCoverage.every((item) => /^P0-0[1-8]$/u.test(item?.criterionId ?? '')
      && typeof item.coverage === 'string' && item.coverage.trim())
    && typeof review.acceptanceCriterion === 'string' && review.acceptanceCriterion.trim()
    && typeof review.taskRationale === 'string' && review.taskRationale.trim()
    && validScopeDisposition
    && typeof review.nextLegalAction === 'string' && /re-pin|revalidate|validate/iu.test(review.nextLegalAction)
    && Array.isArray(review.nonClaims)
    && REQUIRED_REVIEW_NONCLAIMS.every((claim) => review.nonClaims.includes(claim));
}

export function isPdp0RowSourceCurrent({phaseSourceCurrentnessStatus, requiresDefinitionReview, reviewCurrent, sourceOwnerReviewState, remainingPhaseLocalTaskIds}) {
  return phaseSourceCurrentnessStatus === 'CURRENT'
    && (!requiresDefinitionReview || reviewCurrent)
    && sourceOwnerReviewState !== 'PENDING'
    && remainingPhaseLocalTaskIds !== null;
}

export function missingPdp0PhaseSourcePins(phaseSourceShaSet = {}, requiredSourceRefs = []) {
  return [...new Set(requiredSourceRefs)].filter((sourceRef) =>
    typeof phaseSourceShaSet[sourceRef] !== 'string' || !/^[a-f0-9]{64}$/u.test(phaseSourceShaSet[sourceRef]));
}

export function appendPdp0TopologyRows(matrix, topology, sourceFingerprints, topologyPath, {phaseSourceShaSet = {}} = {}) {
  const topologyRows = [...topology.manifestCandidates, ...topology.compositions, ...topology.consumerCrosswalk];
  const topologySurfaceIds = topologyRows.map(({ surfaceId }) => surfaceId);
  if (topologySurfaceIds.some((surfaceId) => typeof surfaceId !== 'string' || !surfaceId.trim())
      || new Set(topologySurfaceIds).size !== topologySurfaceIds.length) {
    throw new Error('PDP-0 source topology must contain unique, nonblank surface identities.');
  }
  const topologyIds = new Set(topologySurfaceIds);
  const topologyById = new Map(topologyRows.map((surface) => [surface.surfaceId, surface]));
  const existingIds = matrix.surfaces.map(({ surfaceId }) => surfaceId);
  if (existingIds.some((surfaceId) => typeof surfaceId !== 'string' || !surfaceId.trim())
      || new Set(existingIds).size !== existingIds.length) {
    throw new Error('PDP-0 prior matrix must contain unique, nonblank surface identities.');
  }
  if (existingIds.some((surfaceId) => !topologyIds.has(surfaceId))) {
    throw new Error('PDP-0 matrix contains an identity outside the current source topology; reviewed retirement is required.');
  }
  const matrixIds = new Set(existingIds);
  const parentsById = new Map(topologyRows.map(({ surfaceId }) => [surfaceId, new Set()]));
  for (const composition of topology.compositions) {
    for (const child of composition.children ?? []) parentsById.get(child)?.add(composition.surfaceId);
  }
  const addedSurfaceIds = new Set();
  for (const surface of topologyRows) {
    if (matrixIds.has(surface.surfaceId)) continue;
    const cell = surface.phaseApplicability?.['PDP-0'];
    if (!cell?.disposition || !cell?.rationale || !cell?.authorityRef) {
      throw new Error(`${surface.surfaceId}: new PDP-0 matrix identity lacks source-owned applicability disposition, rationale, or authority.`);
    }
    const refs = [...new Set([topologyPath, cell.authorityRef, ...(cell.authorityRefs ?? [])])].sort();
    const sourceType = topology.manifestCandidates.includes(surface) ? 'PHYSICAL'
      : topology.compositions.includes(surface) ? 'SEMANTIC_COMPOSITION' : surface.consumerType ?? 'LOGICAL_CONSUMER';
    const archived = cell.disposition === 'NOT_ACTIVE_ARCHIVED';
    const notApplicable = cell.disposition === 'NOT_APPLICABLE_SUPPORT' || cell.disposition === 'NOT_APPLICABLE_OWNER_DECISION';
    const review = cell.sourceDefinitionReview;
    const reviewCurrent = isPdp0SourceDefinitionReviewCurrent(review, surface.surfaceId, sourceFingerprints, phaseSourceShaSet, cell);
    matrix.surfaces.push({
      surfaceId: surface.surfaceId,
      surfaceType: sourceType,
      owner: surface.owner ?? surface.canonicalOwner ?? (surface.owners ?? []).join(', '),
      parentSurfaceIds: [...(parentsById.get(surface.surfaceId) ?? [])].sort(),
      phase: 'PDP-0',
      applicability: {
        disposition: cell.disposition,
        rationale: cell.rationale,
        authorityRef: cell.authorityRef,
        capabilityFamilyIds: [...(cell.capabilityFamilyIds ?? [])],
        capabilityIntentIds: [...(cell.capabilityIntentIds ?? [])],
        requirementIds: [...(cell.requirementIds ?? [])],
      },
      sourceRefs: refs,
      sourceFingerprints: Object.fromEntries(refs.filter((ref) => sourceFingerprints[ref]).map((ref) => [ref, sourceFingerprints[ref]])),
      sourceCurrent: false,
      sourceCurrentBasis: reviewCurrent
        ? 'The canonical PDP-0 topology source records a delegated source-definition review; currentness still depends on matching phase pins.'
        : 'New topology identity is represented, but PDP-0 source status and full-denominator source-definition review have not been reissued for this row.',
      sourceOwnerReviewState: reviewCurrent ? review.status : 'PENDING',
      sourceDefinitionReview: reviewCurrent ? review : null,
      developmentStatus: archived ? 'NOT_ACTIVE_ARCHIVED' : notApplicable ? 'NOT_APPLICABLE' : 'IN_PROGRESS',
      remainingPhaseLocalTaskIds: reviewCurrent ? [...review.phaseLocalTaskIds] : archived || notApplicable ? [] : null,
      blockerOwner: reviewCurrent || archived || notApplicable ? null : 'UNKNOWN_PHASE_LOCAL_OWNER',
      acceptanceCriterion: reviewCurrent ? review.acceptanceCriterion : 'Bind this source-owned topology identity to a current PDP-0 full-denominator review and exact phase-local task ownership before claiming completion.',
      nextLegalAction: reviewCurrent ? review.nextLegalAction : 'Obtain a current source-definition review and exact phase-local task mapping; this generated row does not imply PDP completion or admission.',
      repositoryPath: surface.sourcePath ?? (surface.physicalRefs ?? [])[0] ?? null,
      manifestPath: surface.manifestPath ?? null,
      deployability: surface.deployability ?? null,
      consumerSurfaceRefs: [...(surface.consumerSurfaceRefs ?? [])],
      capabilityFamilyIds: [...(cell.capabilityFamilyIds ?? [])],
      capabilityIntentRefs: [...(cell.capabilityIntentIds ?? [])],
      requirementRefs: [...(cell.requirementIds ?? [])],
      intentRefs: [...(cell.intentIds ?? [])],
      campaignExtensionApplicability: [],
    });
    matrixIds.add(surface.surfaceId);
    addedSurfaceIds.add(surface.surfaceId);
  }
  if (matrix.surfaces.length !== topologyRows.length) {
    throw new Error(`PDP-0 matrix topology count mismatch (matrix=${matrix.surfaces.length}, source=${topologyRows.length}).`);
  }
  const topologyOrder = new Map(topologyRows.map(({ surfaceId }, index) => [surfaceId, index]));
  matrix.surfaces.sort((left, right) => topologyOrder.get(left.surfaceId) - topologyOrder.get(right.surfaceId));
  for (const row of matrix.surfaces) {
    const sourceCell = topologyById.get(row.surfaceId)?.phaseApplicability?.['PDP-0'];
    const review = sourceCell?.sourceDefinitionReview;
    const reviewCurrent = isPdp0SourceDefinitionReviewCurrent(review, row.surfaceId, sourceFingerprints, phaseSourceShaSet, sourceCell);
    const requiresDefinitionReview = Boolean(review) || row.sourceOwnerReviewState === 'DELEGATED_SOURCE_DEFINITION_REVIEW_COMPLETE';
    if (requiresDefinitionReview && reviewCurrent) {
      row.applicability = {
        disposition: sourceCell.disposition,
        rationale: sourceCell.rationale,
        authorityRef: sourceCell.authorityRef,
        capabilityFamilyIds: [...(sourceCell.capabilityFamilyIds ?? [])],
        capabilityIntentIds: [...(sourceCell.capabilityIntentIds ?? [])],
        requirementIds: [...(sourceCell.requirementIds ?? [])],
      };
      row.capabilityFamilyIds = [...(sourceCell.capabilityFamilyIds ?? [])];
      row.capabilityIntentRefs = [...(sourceCell.capabilityIntentIds ?? [])];
      row.requirementRefs = [...(sourceCell.requirementIds ?? [])];
      row.intentRefs = [...(sourceCell.intentIds ?? [])];
      row.sourceRefs = [...new Set([...(row.sourceRefs ?? []), ...review.reviewedSourceRefs])].sort();
      row.sourceFingerprints = {
        ...(row.sourceFingerprints ?? {}),
        ...Object.fromEntries(review.reviewedSourceRefs.map((sourceRef) => [sourceRef, sourceFingerprints[sourceRef]])),
      };
      row.sourceOwnerReviewState = review.status;
      row.sourceDefinitionReview = review;
      row.remainingPhaseLocalTaskIds = [...review.phaseLocalTaskIds];
      row.blockerOwner = null;
      row.acceptanceCriterion = review.acceptanceCriterion;
      row.nextLegalAction = review.nextLegalAction;
      row.sourceCurrentBasis = 'The canonical PDP-0 topology source records a delegated source-definition review; currentness still depends on matching phase pins.';
    } else if (requiresDefinitionReview) {
      row.sourceOwnerReviewState = 'PENDING';
      row.sourceDefinitionReview = review ?? null;
      const notApplicable = ['NOT_APPLICABLE_SUPPORT', 'NOT_APPLICABLE_OWNER_DECISION'].includes(sourceCell?.disposition);
      row.remainingPhaseLocalTaskIds = notApplicable ? [] : null;
      row.blockerOwner = notApplicable ? null : 'UNKNOWN_PHASE_LOCAL_OWNER';
    }
    if (row.sourceOwnerReviewState === 'PENDING' || row.remainingPhaseLocalTaskIds === null) {
      row.sourceCurrent = false;
      row.sourceCurrentBasis = row.sourceOwnerReviewState === 'PENDING'
        ? 'This topology row still requires source-owner review; matching phase-wide byte pins cannot establish row currentness.'
        : 'Exact phase-local task ownership is unknown for this row; matching phase-wide byte pins cannot establish row currentness.';
    }
  }
  return { addedSurfaceIds, topologyRows };
}
