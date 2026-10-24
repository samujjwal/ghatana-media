import {createHash} from 'node:crypto';

const sha256Pattern = /^[a-f0-9]{64}$/u;
const statusDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function requireSha256(value, label) {
  if (typeof value !== 'string' || !sha256Pattern.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
}

function nonPinStatus(status) {
  const {sourceShaSet: _sourceShaSet, ...rest} = status;
  return rest;
}

export function buildPdp0PinSuccessor({
  preimage,
  observedPins,
  targetUpdates,
  expectedMaterialRefs,
  selectorRef,
  expectedPinCount = 188,
}) {
  if (!preimage || preimage.phase !== 'PDP-0' || preimage.status !== 'IN_PROGRESS') {
    throw new Error('PDP-0 pin successor requires the exact IN_PROGRESS status preimage');
  }
  if (!Array.isArray(observedPins) || observedPins.length !== expectedPinCount
      || !Array.isArray(targetUpdates) || targetUpdates.length !== expectedMaterialRefs.length + 1) {
    throw new Error('PDP-0 pin successor requires the complete observed readset and exact target population');
  }
  const sourceShaSet = preimage.sourceShaSet;
  const sourceRefs = Object.keys(sourceShaSet ?? {}).sort();
  if (sourceRefs.length !== expectedPinCount) throw new Error('PDP-0 preimage pin count changed');
  if (preimage.sourceRecordCount?.capabilityLeafAdjudications !== 462
      || preimage.semanticallyResolvedCount?.capabilityLeafAdjudications !== 462) {
    throw new Error('PDP-0 462-leaf owner history is not preserved in the preimage');
  }

  const observedByRef = new Map();
  for (const row of observedPins) {
    if (!row || typeof row.sourceRef !== 'string' || observedByRef.has(row.sourceRef)) {
      throw new Error('PDP-0 observed pin readset has a missing or duplicate sourceRef');
    }
    requireSha256(row.statusPinnedSha256, `${row.sourceRef} status pin`);
    requireSha256(row.observedSha256, `${row.sourceRef} observed pin`);
    if (!['MATERIAL_FILE', 'PHASE_SCOPED_SELECTOR'].includes(row.sourceKind)) {
      throw new Error(`${row.sourceRef} has an unsupported sourceKind`);
    }
    observedByRef.set(row.sourceRef, row);
  }
  if (observedByRef.size !== sourceRefs.length
      || sourceRefs.some(ref => !observedByRef.has(ref))) {
    throw new Error('PDP-0 observed pin readset does not exactly cover sourceShaSet');
  }

  const updatesByRef = new Map();
  for (const update of targetUpdates) {
    if (!update || typeof update.sourceRef !== 'string' || updatesByRef.has(update.sourceRef)) {
      throw new Error('PDP-0 target updates have a missing or duplicate sourceRef');
    }
    requireSha256(update.previousSha256, `${update.sourceRef} previous pin`);
    requireSha256(update.currentSha256, `${update.sourceRef} current pin`);
    if (sourceShaSet[update.sourceRef] !== update.previousSha256) {
      throw new Error(`${update.sourceRef} target preimage differs from the exact status preimage`);
    }
    const observed = observedByRef.get(update.sourceRef);
    if (!observed || observed.observedSha256 !== update.currentSha256
        || observed.statusPinnedSha256 !== update.previousSha256) {
      throw new Error(`${update.sourceRef} target does not match the complete observed readset`);
    }
    updatesByRef.set(update.sourceRef, update);
  }
  const expectedTargets = new Set([...expectedMaterialRefs, selectorRef]);
  if (updatesByRef.size !== expectedTargets.size
      || [...expectedTargets].some(ref => !updatesByRef.has(ref))) {
    throw new Error('PDP-0 target set must be exactly nine material pins plus the PXD-225 selector');
  }
  if (updatesByRef.get(selectorRef)?.sourceKind !== 'PHASE_SCOPED_SELECTOR') {
    throw new Error('PXD-225 must be refreshed from the phase-scoped selector producer');
  }
  for (const ref of expectedMaterialRefs) {
    if (updatesByRef.get(ref)?.sourceKind !== 'MATERIAL_FILE') {
      throw new Error(`${ref} must be classified as a material file source`);
    }
  }
  for (const ref of sourceRefs) {
    const row = observedByRef.get(ref);
    if (updatesByRef.has(ref)) continue;
    if (row.statusPinnedSha256 !== sourceShaSet[ref] || row.observedSha256 !== sourceShaSet[ref]) {
      throw new Error(`${ref} is stale outside the authorized ten-pin target set`);
    }
  }

  const candidate = structuredClone(preimage);
  for (const [ref, update] of updatesByRef) candidate.sourceShaSet[ref] = update.currentSha256;
  assertPdp0PinSuccessor({preimage, candidate, targetRefs: [...expectedTargets], expectedPinCount});
  return {
    candidate,
    preimageSha256: statusDigest(preimage),
    candidateSha256: statusDigest(candidate),
    sourceShaSetPreimageSha256: statusDigest(sourceShaSet),
    sourceShaSetCandidateSha256: statusDigest(candidate.sourceShaSet),
    changedSourceRefs: [...updatesByRef.keys()].sort(),
  };
}

export function assertPdp0PinSuccessor({preimage, candidate, targetRefs, expectedPinCount = 188}) {
  if (!preimage || !candidate || preimage.phase !== 'PDP-0' || candidate.phase !== 'PDP-0'
      || preimage.status !== 'IN_PROGRESS' || candidate.status !== 'IN_PROGRESS') {
    throw new Error('PDP-0 pin successor must preserve IN_PROGRESS');
  }
  if (Object.keys(candidate.sourceShaSet ?? {}).length !== expectedPinCount
      || Object.keys(preimage.sourceShaSet ?? {}).length !== expectedPinCount) {
    throw new Error('PDP-0 pin successor must preserve the complete source pin count');
  }
  if (candidate.sourceRecordCount?.capabilityLeafAdjudications !== 462
      || candidate.semanticallyResolvedCount?.capabilityLeafAdjudications !== 462) {
    throw new Error('PDP-0 pin successor must preserve all 462 capability-leaf records');
  }
  if (statusDigest(nonPinStatus(candidate)) !== statusDigest(nonPinStatus(preimage))) {
    throw new Error('PDP-0 pin successor mutated status data outside sourceShaSet');
  }
  const expected = new Set(targetRefs);
  const changed = Object.keys(preimage.sourceShaSet).filter(ref =>
    preimage.sourceShaSet[ref] !== candidate.sourceShaSet[ref]);
  if (changed.length !== expected.size || changed.some(ref => !expected.has(ref))) {
    throw new Error('PDP-0 pin successor changed sourceShaSet outside its exact target set');
  }
  for (const ref of Object.keys(preimage.sourceShaSet)) {
    if (!expected.has(ref) && preimage.sourceShaSet[ref] !== candidate.sourceShaSet[ref]) {
      throw new Error(`${ref} changed outside the target set`);
    }
    requireSha256(candidate.sourceShaSet[ref], `${ref} candidate pin`);
  }
  return true;
}
