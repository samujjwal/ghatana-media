/**
 * Exact historical 2026-10-15 Media 50-surface Discovery source cohort lens.
 * This is NOT a second editable topology or a currentness/DEV_COMPLETE claim.
 * Old R15/R30/R19 tests and records must keep their original indices and
 * source-meaning denominator while new Recorder/Studio candidates are added.
 */
export const RECORDER_STUDIO_SUCCESSOR_CONSUMERS = Object.freeze([
  'media.surface.experience-recorder',
  'media.surface.capture-agent',
  'media.surface.presentation-studio',
  'media.surface.interactive-demo-player',
]);
export const RECORDER_STUDIO_SUCCESSOR_COMPOSITION = 'media.composition.experience-recorder-studio';

export function projectHistoricalMediaTopology(current) {
  const copy = structuredClone(current);
  const extra = new Set(RECORDER_STUDIO_SUCCESSOR_CONSUMERS);
  copy.consumerCrosswalk = copy.consumerCrosswalk.filter((item) => !extra.has(item.surfaceId));
  copy.compositions = copy.compositions.filter((item) => item.surfaceId !== RECORDER_STUDIO_SUCCESSOR_COMPOSITION);
  const root = copy.compositions.find((item) => item.kind === 'REPOSITORY_ROOT');
  if (!root) throw new TypeError('Historical Media topology root missing');
  root.children = root.children.filter((id) => id !== RECORDER_STUDIO_SUCCESSOR_COMPOSITION);
  root.sharedPhysicalMemberships = (root.sharedPhysicalMemberships ?? [])
    .map((item) => ({
      ...item,
      parentCompositionIds: item.parentCompositionIds.filter(
        (id) => id !== RECORDER_STUDIO_SUCCESSOR_COMPOSITION
      ),
    }))
    .filter((item) => item.parentCompositionIds.length > 1);
  for (const candidate of copy.manifestCandidates) {
    candidate.consumerSurfaceRefs = (candidate.consumerSurfaceRefs ?? []).filter((id) => !extra.has(id));
    candidate.consumerMappingState = candidate.consumerSurfaceRefs.length ? 'MAPPED' : 'NO_DIRECT_CONSUMER_SUPPORT_ONLY';
  }
  const sizes = [
    copy.manifestCandidates.length,
    copy.compositions.filter((item) => item.kind === 'SEMANTIC_COMPOSITION').length,
    copy.compositions.filter((item) => item.kind === 'REPOSITORY_ROOT').length,
    copy.consumerCrosswalk.length,
  ];
  if (sizes.join('/') !== '26/6/1/17') {
    throw new TypeError('Historical Media cohort must remain exactly 26/6/1/17');
  }
  return copy;
}
