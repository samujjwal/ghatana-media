/** Definition-only descriptor decisions. No decoder, render, solver or effect is run. */
export function inspectDescriptorCompleteness(descriptor, requiredFields) {
  if (!descriptor || typeof descriptor !== 'object' || !Array.isArray(requiredFields)
    || requiredFields.length === 0 || requiredFields.some((key) => typeof key !== 'string' || !key.trim())
    || new Set(requiredFields).size !== requiredFields.length) {
    return { complete: false, gaps: ['INVALID_DESCRIPTOR_PROFILE'], runtimeAdmission: 'NOT_ADMITTED' };
  }
  const gaps = requiredFields.filter((key) => !Object.hasOwn(descriptor, key)
    || descriptor[key]?.status !== 'KNOWN' || !Object.hasOwn(descriptor[key], 'value')
    || descriptor[key].value === null || descriptor[key].value === undefined);
  return { complete: gaps.length === 0, gaps, runtimeAdmission: 'NOT_ADMITTED' };
}

/** A VFR map retains exact source PTS/DTS; no frame-count/rate duration is guessed. */
export function inspectSourceFrameTime(map, frameIndex) {
  const fail = () => { throw new Error('EXACT_SOURCE_FRAME_MAP_REQUIRED'); };
  const signedTick = (value) => typeof value === 'bigint' && value >= -(1n << 63n) && value < (1n << 63n);
  if (!map || typeof map.artifactVersionId !== 'string' || !map.artifactVersionId.trim()
    || typeof map.clockId !== 'string' || !map.clockId.trim()
    || typeof map.streamId !== 'string' || !map.streamId.trim()
    || !signedTick(map.timeBase?.numerator) || map.timeBase.numerator <= 0n
    || !signedTick(map.timeBase?.denominator) || map.timeBase.denominator <= 0n
    || !Array.isArray(map.frames) || !map.frames.length || map.frames.length > 1000000
    || !Number.isSafeInteger(frameIndex) || frameIndex < 0 || frameIndex >= map.frames.length) fail();
  for (const [index, frame] of map.frames.entries()) {
    if (!frame || frame.index !== index || !signedTick(frame.ptsTicks)
      || !signedTick(frame.dtsTicks) || !signedTick(frame.durationTicks)
      || frame.durationTicks <= 0n || typeof frame.discontinuityBefore !== 'boolean') fail();
    // DTS may reorder relative to presentation order. PTS regression is allowed
    // only where an explicitly retained discontinuity declares the new segment.
    if (index && frame.ptsTicks < map.frames[index - 1].ptsTicks && !frame.discontinuityBefore) fail();
  }
  const frame = map.frames[frameIndex];
  return { artifactVersionId: map.artifactVersionId, clockId: map.clockId, streamId: map.streamId,
    frameIndex, ptsTicks: frame.ptsTicks, dtsTicks: frame.dtsTicks,
    durationTicks: frame.durationTicks, discontinuityBefore: frame.discontinuityBefore,
    timeBase: { ...map.timeBase }, qualification: 'NOT_EVALUATED' };
}

/** Check declared display aspect including pixel aspect, without running a transform. */
export function inspectResolvedDisplayAspect(plan) {
  const positive = (value) => Number.isSafeInteger(value) && value > 0 && value <= 4294967295;
  const ratio = (value) => positive(value?.numerator) && positive(value?.denominator);
  if (!positive(plan?.finalDimensions?.width) || !positive(plan?.finalDimensions?.height)
    || !ratio(plan?.requestedDisplayAspect) || !ratio(plan?.finalPixelAspectRatio)) {
    return { allowed: false, reason: 'EXACT_DIMENSIONS_AND_ASPECT_REQUIRED', runtimeAdmission: 'NOT_ADMITTED' };
  }
  const matching = BigInt(plan.finalDimensions.width) * BigInt(plan.finalPixelAspectRatio.numerator) * BigInt(plan.requestedDisplayAspect.denominator)
    === BigInt(plan.finalDimensions.height) * BigInt(plan.finalPixelAspectRatio.denominator) * BigInt(plan.requestedDisplayAspect.numerator);
  if (plan.aspectPreservationDisposition === 'PRESERVED') return { allowed: matching, reason: matching ? 'EXACT_DISPLAY_ASPECT_PRESERVED' : 'DECLARED_ASPECT_NOT_PRESERVED', runtimeAdmission: 'NOT_ADMITTED' };
  if (plan.aspectPreservationDisposition === 'EXPLICIT_OWNER_AUTHORIZED_CHANGE'
    && plan.aspectChangeAuthorityRef?.status === 'KNOWN'
    && typeof plan.aspectChangeAuthorityRef.value === 'string' && plan.aspectChangeAuthorityRef.value.trim()) {
    return { allowed: true, reason: 'DECLARED_SEPARATE_AUTHORITY_REQUIRES_CURRENT_OWNER_VERIFICATION', runtimeAdmission: 'NOT_ADMITTED' };
  }
  return { allowed: false, reason: 'ASPECT_CHANGE_AUTHORITY_UNRESOLVED', runtimeAdmission: 'NOT_ADMITTED' };
}
