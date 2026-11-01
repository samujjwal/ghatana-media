export function appendPdp0TopologyRows(matrix, topology, sourceFingerprints, topologyPath) {
  const topologyRows = [...topology.manifestCandidates, ...topology.compositions, ...topology.consumerCrosswalk];
  const topologySurfaceIds = topologyRows.map(({ surfaceId }) => surfaceId);
  if (topologySurfaceIds.some((surfaceId) => typeof surfaceId !== 'string' || !surfaceId.trim())
      || new Set(topologySurfaceIds).size !== topologySurfaceIds.length) {
    throw new Error('PDP-0 source topology must contain unique, nonblank surface identities.');
  }
  const topologyIds = new Set(topologySurfaceIds);
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
      sourceCurrentBasis: 'New topology identity is represented, but PDP-0 source status and full-denominator owner review have not been reissued for this row.',
      sourceOwnerReviewState: 'PENDING',
      developmentStatus: archived ? 'NOT_ACTIVE_ARCHIVED' : notApplicable ? 'NOT_APPLICABLE' : 'IN_PROGRESS',
      remainingPhaseLocalTaskIds: archived || notApplicable ? [] : null,
      blockerOwner: archived || notApplicable ? null : 'UNKNOWN_PHASE_LOCAL_OWNER',
      acceptanceCriterion: 'Bind this source-owned topology identity to a current PDP-0 full-denominator review and exact phase-local task ownership before claiming completion.',
      nextLegalAction: 'Obtain a current source-owner review and exact phase-local task mapping; this generated row does not imply PDP completion or admission.',
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
    if (row.sourceOwnerReviewState === 'PENDING' || row.remainingPhaseLocalTaskIds === null) {
      row.sourceCurrent = false;
      row.sourceCurrentBasis = row.sourceOwnerReviewState === 'PENDING'
        ? 'This topology row still requires source-owner review; matching phase-wide byte pins cannot establish row currentness.'
        : 'Exact phase-local task ownership is unknown for this row; matching phase-wide byte pins cannot establish row currentness.';
    }
  }
  return { addedSurfaceIds, topologyRows };
}
