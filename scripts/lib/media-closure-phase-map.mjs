export const MEDIA_SOURCE_PDP_PHASES = Object.freeze(['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3']);

/**
 * Read the Media-owned mapping from source PDP identities to opaque Lifecycle
 * Closure phase identities. PDP labels remain source identities; the mapped
 * values are the only phase IDs used by Lifecycle inputs.
 */
export function readMediaSourcePhaseMapping(program) {
  const mapping = program?.metadata?.mediaSourcePhaseMapping?.sourcePhaseToClosurePhaseId;
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    throw new Error('PhaseProgram metadata.mediaSourcePhaseMapping.sourcePhaseToClosurePhaseId is required');
  }

  const sourceIds = Object.keys(mapping).sort();
  const expectedSourceIds = [...MEDIA_SOURCE_PDP_PHASES].sort();
  if (JSON.stringify(sourceIds) !== JSON.stringify(expectedSourceIds)) {
    throw new Error(`Media source phase map must contain exactly ${MEDIA_SOURCE_PDP_PHASES.join(', ')}`);
  }

  const closureIds = Object.values(mapping);
  if (closureIds.some((id) => typeof id !== 'string' || !id)
    || new Set(closureIds).size !== closureIds.length) {
    throw new Error('Media source phase map must use unique, non-empty Lifecycle phase IDs');
  }
  if (closureIds.some((id) => MEDIA_SOURCE_PDP_PHASES.includes(id))) {
    throw new Error('Lifecycle Closure phase IDs must remain distinct from Media source PDP labels');
  }

  const phases = program.phases ?? [];
  const phaseIds = phases.map((phase) => phase.id);
  if (phaseIds.some((id) => MEDIA_SOURCE_PDP_PHASES.includes(id))) {
    throw new Error('Lifecycle Closure phase IDs must remain distinct from Media source PDP labels');
  }
  if (phaseIds.length !== MEDIA_SOURCE_PDP_PHASES.length
    || new Set(phaseIds).size !== phaseIds.length
    || JSON.stringify([...phaseIds].sort()) !== JSON.stringify([...closureIds].sort())) {
    throw new Error('Media source phase map values must match the PhaseProgram phase IDs exactly');
  }

  for (const phase of phases) {
    const sourcePdpPhaseId = phase.metadata?.sourcePdpPhaseId;
    if (!MEDIA_SOURCE_PDP_PHASES.includes(sourcePdpPhaseId)
      || mapping[sourcePdpPhaseId] !== phase.id) {
      throw new Error(`Lifecycle phase ${phase.id} must declare its matching metadata.sourcePdpPhaseId`);
    }
  }

  return Object.freeze({ ...mapping });
}
