export const ROSTER_RECONCILIATION_SCHEMA = 'media.surface-roster-reconciliation.v1';
export const ROSTER_RECONCILIATION_PATH = 'docs/implementation/MEDIA-SURFACE-ROSTER-RECONCILIATION.v1.json';
export const TOPOLOGY_PATH = '.product-experience/surfaces/media-physical-topology.v1.json';
export const PHASE_IDS = ['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3'];
export const MATRIX_PATHS = [0, 1, 2, 3].map(i => `docs/implementation/verification/pdp-38/pdp${i}-surface-phase-status-matrix.json`);

/**
 * Owner-reviewed dispositions for topology identities that are not rows of the
 * frozen 54-identity PDP phase matrices. Every delta must be declared here; an
 * undeclared or stale declaration fails the reconciliation. These dispositions
 * never assert PDP status: they say what source action is required next.
 */
export const DECLARED_MATRIX_DELTA = {
  'media.physical.adapters-agent-tools-media': {
    disposition: 'MATRIX_EXTENSION_REQUIRED',
    lifecycleState: 'SUPPORT',
    expectedTopologyDisposition: 'SUPPORT_ONLY',
    rationale: 'Optional Tools SPI adapter added to topology after the 54-row matrices were frozen. Topology proposes support-only N/A for PDP-0/2 and referenced-only PDP-1; the four phase matrices need an impacted one-row extension through their generators before any phase status may be claimed.',
    nextAction: 'Extend pdp0..pdp3 surface-phase-status matrix generators with this support row (owner-reviewed N/A rationale); do not reopen the 54 unchanged rows.'
  },
  'media.physical.adapters-data-cloud-media': {
    disposition: 'MATRIX_EXTENSION_REQUIRED',
    lifecycleState: 'ACTIVE',
    expectedTopologyDisposition: 'PHYSICAL',
    rationale: 'Physical Data Cloud MediaProcessorPort adapter added to topology after the matrices were frozen. Topology marks PDP-0 APPLICABLE under DEP-DATA-CLOUD; Data Cloud is an optional downstream integration (MDI-001/PDP0-003-D4) and must not gate Media processing.',
    nextAction: 'Owner-review PDP-0 DEP-DATA-CLOUD obligations for this row, then extend all four phase matrices through their generators; keep optional-dependency negative cases explicit.'
  },
  'media.physical.adapters-ocr-compat': {
    disposition: 'RETIRE_UNDER_OCR_M03',
    lifecycleState: 'RETIRING',
    expectedTopologyDisposition: 'SUPPORT_ONLY',
    rationale: 'Legacy Kernel OCR compatibility adapter. MDI-001 makes Document Intelligence the only OCR executor; OCR-M03 deletes this module after consumers migrate. It must not be added to the PDP matrices as a durable surface.',
    nextAction: 'Complete OCR-M01/M02/K01, delete adapters/ocr-compat (OCR-M03), then remove its topology manifest candidate and this declaration together.'
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
 * Reconcile current topology identities with the four frozen phase matrices.
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
