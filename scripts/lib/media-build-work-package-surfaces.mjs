const phaseIds = ['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3'];

const requireText = (value, label) => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label}: missing source value`);
  return value;
};

function selector(path, fragment) {
  return `${path}#${fragment}`;
}

/**
 * Build the 54-surface handoff from topology, explicit logical-consumer
 * registry dispositions, and the four source-pinned phase matrices.
 */
export function buildMediaBuildSurfaceHandoff({ topology, surfaceRegistry, matrices }) {
  const topologyRows = [
    ...(topology?.manifestCandidates ?? []).map(row => ({ row, type: 'physical', fragment: 'manifestCandidates' })),
    ...(topology?.compositions ?? []).map(row => ({ row, type: 'composition', fragment: 'compositions' })),
    ...(topology?.consumerCrosswalk ?? []).map(row => ({ row, type: 'logical', fragment: 'consumerCrosswalk' }))
  ];
  const topologyIds = topologyRows.map(({ row }) => row.surfaceId);
  if (topologyIds.length !== 54 || new Set(topologyIds).size !== topologyIds.length || topologyIds.some(id => !id)) {
    throw new Error(`expected 54 unique topology surface identities, got ${topologyIds.length}`);
  }

  const logicalIds = new Set(topologyRows.filter(item => item.type === 'logical').map(item => item.row.surfaceId));
  const registryRows = surfaceRegistry ?? [];
  const registryById = new Map();
  for (const row of registryRows) {
    if (!row?.surfaceId || registryById.has(row.surfaceId)) throw new Error(`surface registry has duplicate or missing identity ${row?.surfaceId ?? '<empty>'}`);
    registryById.set(row.surfaceId, row);
  }
  if (registryRows.length !== logicalIds.size || [...logicalIds].some(id => !registryById.has(id)) || registryRows.some(row => !logicalIds.has(row.surfaceId))) {
    throw new Error('surface registry does not exactly cover the 21 logical topology consumers');
  }

  const matrixByPhase = new Map();
  for (const entry of matrices ?? []) {
    const phase = entry?.matrix?.campaign?.phase;
    if (!phaseIds.includes(phase) || matrixByPhase.has(phase)) throw new Error(`phase matrix is duplicate or unknown: ${phase ?? '<missing>'}`);
    const rows = entry.matrix.surfaces ?? [];
    const ids = rows.map(row => row.surfaceId);
    if (ids.length !== 54 || new Set(ids).size !== 54 || topologyIds.some(id => !ids.includes(id))) {
      throw new Error(`${entry.path}: surface membership differs from the 54-identity topology`);
    }
    matrixByPhase.set(phase, { path: entry.path, byId: new Map(rows.map(row => [row.surfaceId, row])) });
  }
  if (matrixByPhase.size !== phaseIds.length) throw new Error('all four PDP phase matrices are required for the 54-surface handoff');

  const records = topologyRows.map(({ row, type, fragment }) => {
    const id = requireText(row.surfaceId, `${type} topology identity`);
    const topologySelector = selector('.product-experience/surfaces/media-physical-topology.v1.json', `/${fragment}/@surfaceId=${id}`);
    let registryApplicability = null;
    let topologyBinding = null;

    if (type === 'logical') {
      const registry = registryById.get(id);
      const crosswalk = row;
      registryApplicability = {
        disposition: requireText(registry.applicabilityDisposition, `${id} registry applicability disposition`),
        rationale: requireText(registry.applicabilityRationale, `${id} registry applicability rationale`),
        applicablePdpArtifacts: registry.applicablePdpArtifacts,
        authoritySelector: selector('.product-experience/surface-registry.yaml', `/surfaces/@surfaceId=${id}`)
      };
      if (!Array.isArray(registry.applicablePdpArtifacts) || registry.applicablePdpArtifacts.length === 0) {
        throw new Error(`${id}: registry applicability lacks explicit PDP artifact references`);
      }
      topologyBinding = {
        state: requireText(crosswalk.bindingState, `${id} topology binding state`),
        reason: requireText(crosswalk.statusReason, `${id} topology binding reason`),
        authoritySelector: topologySelector
      };
    }

    const applicability = Object.fromEntries(phaseIds.map(phase => {
      const matrix = matrixByPhase.get(phase);
      const sourceRow = matrix.byId.get(id);
      const decision = sourceRow?.applicability;
      if (sourceRow?.sourceCurrent !== true) throw new Error(`${matrix.path}#surfaces/@surfaceId=${id}: source row is not current`);
      if (!decision || typeof decision !== 'object' || Array.isArray(decision)) throw new Error(`${matrix.path}#surfaces/@surfaceId=${id}: missing explicit applicability decision`);
      if (!Array.isArray(sourceRow.remainingPhaseLocalTaskIds)) throw new Error(`${matrix.path}#surfaces/@surfaceId=${id}: phase-local task inventory is unknown`);
      const authorityRefs = Array.isArray(decision.authorityRefs)
        ? decision.authorityRefs
        : decision.authorityRef ? [decision.authorityRef] : [];
      if (authorityRefs.length === 0 || authorityRefs.some(ref => typeof ref !== 'string' || !ref)) {
        throw new Error(`${matrix.path}#surfaces/@surfaceId=${id}: applicability authority selector is missing`);
      }
      return [phase, {
        disposition: requireText(decision.disposition, `${id} ${phase} applicability disposition`),
        rationale: requireText(decision.rationale, `${id} ${phase} applicability rationale`),
        authorityRefs,
        sourceSelector: selector(matrix.path, `/surfaces/@surfaceId=${id}/applicability`),
        sourceCurrent: sourceRow.sourceCurrent,
        developmentStatus: requireText(sourceRow.developmentStatus, `${id} ${phase} development status`),
        remainingPhaseLocalTaskIds: sourceRow.remainingPhaseLocalTaskIds,
        blockerIds: sourceRow.blockerIds ?? null,
        blockerOwner: sourceRow.blockerOwner ?? null,
        acceptanceCriterion: requireText(sourceRow.acceptanceCriterion, `${id} ${phase} acceptance criterion`),
        nextLegalAction: requireText(sourceRow.nextLegalAction, `${id} ${phase} next legal action`)
      }];
    }));

    return {
      id,
      type,
      topologySelector,
      registryApplicability,
      topologyBinding,
      applicability,
      ...(type === 'composition' ? { compositionKind: row.kind } : {})
    };
  });

  return records;
}
