const GENERATED_PROJECTION_FIELDS = Object.freeze(['createdAt', 'updatedAt']);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function comparableProjection(projection) {
  const copy = structuredClone(projection);
  for (const field of GENERATED_PROJECTION_FIELDS) delete copy?.candidateModel?.[field];
  return JSON.stringify(stable(copy));
}

/**
 * Preserve the original creation time for a candidate with an established
 * timestamp pair. Preserve its update time too when every other output field
 * is unchanged; a real projection change retains the creation time and uses
 * the newly generated update time.
 */
export function preserveGeneratedProjectionTimestamps(currentText, nextProjection) {
  if (typeof currentText !== 'string' || !currentText.trim()
      || !nextProjection || typeof nextProjection !== 'object') return nextProjection;
  let current;
  try { current = JSON.parse(currentText); } catch { return nextProjection; }
  const previousCreatedAt = current?.candidateModel?.createdAt;
  const previousUpdatedAt = current?.candidateModel?.updatedAt;
  if (typeof previousCreatedAt !== 'string' || typeof previousUpdatedAt !== 'string'
      || !nextProjection.candidateModel) return nextProjection;
  nextProjection.candidateModel.createdAt = previousCreatedAt;
  if (comparableProjection(current) === comparableProjection(nextProjection)) {
    nextProjection.candidateModel.updatedAt = previousUpdatedAt;
  }
  return nextProjection;
}
