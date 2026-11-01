export const ROSTER_RECONCILIATION_SCHEMA = 'media.surface-roster-reconciliation.v1';
export const ROSTER_RECONCILIATION_PATH = 'docs/implementation/MEDIA-SURFACE-ROSTER-RECONCILIATION.v1.json';
export const TOPOLOGY_PATH = '.product-experience/surfaces/media-physical-topology.v1.json';
export const PHASE_IDS = ['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3'];
export const MATRIX_PATHS = [0, 1, 2, 3].map(i => `docs/implementation/verification/pdp-38/pdp${i}-surface-phase-status-matrix.json`);

/**
 * No current topology identities are missing from the phase matrices. Keep the
 * declared-delta input as an extension point so a future topology-only identity
 * must still have an explicit owner disposition before reconciliation passes.
 */
export const DECLARED_MATRIX_DELTA = Object.freeze({});

/**
 * Retired surface declarations: identities removed from topology together with
 * their delta declarations. Retained as provenance only; never re-add to
 * DECLARED_MATRIX_DELTA or the matrices.
 */
export const RETIRED_MATRIX_DELTA = {
  'media.physical.adapters-ocr-compat': {
    disposition: 'RETIRED_UNDER_OCR_M03',
    rationale: 'Legacy Media OCR adapter source is retired under OCR-M03. This source disposition does not establish a DI-backed Kernel provider or installed consumer replacement.',
    removedInCommits: ['f212cf6b', '0613884a']
  }
};

const fail = message => { throw new Error(`surface roster reconciliation: ${message}`); };

function topologyRows(topology) {
  return [
    ...(topology?.manifestCandidates ?? []).map(row => ({ row, type: 'physical' })),
    ...(topology?.compositions ?? []).map(row => ({ row, type: 'composition' })),
    ...(topology?.consumerCrosswalk ?? []).map(row => ({ row, type: 'logical' }))
  ];
}

function lifecycleStateOf({ row, type }) {
  if (type === 'composition') return row.kind === 'REPOSITORY_ROOT' ? 'ROOT' : 'ACTIVE';
  if (type === 'logical') return row.bindingState === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE';
  if (row.disposition === 'PHYSICAL') return 'ACTIVE';
  if (row.disposition === 'SUBSUMED') return 'SUBSUMED';
  return 'SUPPORT';
}

/**
 * Reconcile current topology identities with the four owner-generated phase matrices.
 * Returns the full classified roster plus the declared matrix delta, or throws
 * on duplicates, matrix-only ghosts, inconsistent matrices, or undeclared drift.
 */
export function reconcileMediaSurfaceRoster({ topology, matrices, declaredDelta = DECLARED_MATRIX_DELTA }) {
  const rows = topologyRows(topology);
  const ids = rows.map(({ row }) => row.surfaceId);
  if (ids.some(id => typeof id !== 'string' || !id)) fail('topology has a missing surface identity');
  if (new Set(ids).size !== ids.length) fail('topology has duplicate surface identities');
  if (topology.activeManifestCandidateCount !== topology.manifestCandidates.length) {
    fail(`activeManifestCandidateCount ${topology.activeManifestCandidateCount} differs from ${topology.manifestCandidates.length} manifest candidates`);
  }
  if ((matrices ?? []).length !== PHASE_IDS.length) fail('all four PDP phase matrices are required');

  const matrixIdSets = matrices.map(({ path, matrix }) => {
    const matrixIds = (matrix?.surfaces ?? []).map(row => row.surfaceId);
    if (new Set(matrixIds).size !== matrixIds.length) fail(`${path} has duplicate surface rows`);
    return { path, phase: matrix?.campaign?.phase, ids: new Set(matrixIds) };
  });
  const [first, ...rest] = matrixIdSets;
  for (const other of rest) {
    if (other.ids.size !== first.ids.size || [...other.ids].some(id => !first.ids.has(id))) fail(`${other.path} membership differs from ${first.path}`);
  }
  const topologyIds = new Set(ids);
  const ghosts = [...first.ids].filter(id => !topologyIds.has(id));
  if (ghosts.length) fail(`matrix rows absent from topology (ghost surfaces): ${ghosts.join(', ')}`);

  const delta = ids.filter(id => !first.ids.has(id));
  const undeclared = delta.filter(id => !declaredDelta[id]);
  if (undeclared.length) fail(`undeclared topology identities missing from phase matrices: ${undeclared.join(', ')}`);
  const stale = Object.keys(declaredDelta).filter(id => !delta.includes(id));
  if (stale.length) fail(`stale delta declarations (identity absent from topology or already matrix-bound): ${stale.join(', ')}`);

  const roster = rows.map(entry => {
    const id = entry.row.surfaceId;
    const declared = declaredDelta[id];
    if (declared && entry.row.disposition !== declared.expectedTopologyDisposition) {
      fail(`${id}: topology disposition ${entry.row.disposition} differs from declared ${declared.expectedTopologyDisposition}`);
    }
    return {
      id,
      type: entry.type,
      sourcePath: entry.row.sourcePath ?? null,
      topologyDisposition: entry.row.disposition ?? entry.row.kind ?? entry.row.bindingState ?? null,
      lifecycleState: declared?.lifecycleState ?? lifecycleStateOf(entry),
      matrixBound: !declared,
      ...(declared ? { matrixDelta: { disposition: declared.disposition, rationale: declared.rationale, nextAction: declared.nextAction } } : {})
    };
  });
  const count = predicate => roster.filter(predicate).length;
  return {
    census: {
      physical: count(r => r.type === 'physical'),
      compositions: count(r => r.type === 'composition'),
      logical: count(r => r.type === 'logical'),
      total: roster.length,
      matrixBound: count(r => r.matrixBound),
      matrixDelta: delta.length,
      byLifecycleState: Object.fromEntries([...new Set(roster.map(r => r.lifecycleState))].sort().map(state => [state, count(r => r.lifecycleState === state)]))
    },
    matrixBoundIds: ids.filter(id => first.ids.has(id)),
    delta: delta.map(id => ({ id, ...declaredDelta[id] })),
    roster
  };
}
