/**
 * Synthetic-only Common Voice v27 aggregate metric helper.
 *
 * This module performs no file, network, or model I/O and grants no data or
 * inference authority. It accepts in-memory test records only and returns
 * aggregate metrics without returning or persisting per-clip references or
 * predictions. Clip IDs and audio hashes are held in ephemeral in-memory sets
 * only to reject duplicates, then cleared before scoring; they are never
 * returned or persisted. Its output is code-path evidence only; it is not a
 * real Common Voice result or a model-quality qualification.
 */

const SOURCE_REVISION = 'cv-corpus-27.0-2026-09-11';
const MAX_TOTAL_TEST_ROWS = 16_403 + 3_402 + 302;
const MAX_TEXT_CODE_UNITS = 16_384;
const MAX_CUMULATIVE_EDIT_CELLS = 50_000_000;
const LOCALES = Object.freeze({
  en: Object.freeze({ locale: 'en', sourceDatasetId: 'cmu5jplf300nwmh07iqvk9leo', testRowCap: 16_403 }),
  hi: Object.freeze({ locale: 'hi', sourceDatasetId: 'cmu5vlext009to107ev1s9lk8', testRowCap: 3_402 }),
  ne: Object.freeze({ locale: 'ne-NP', sourceDatasetId: 'cmu61478v00j9o107alzuue1z', testRowCap: 302 }),
});
const RECORD_FIELDS = Object.freeze([
  'locale',
  'sourceDatasetId',
  'sourceRevision',
  'sourceSplit',
  'clipId',
  'audioSha256',
  'reference',
  'prediction',
]);

function assert(condition, message) {
  if (!condition) throw new TypeError(message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactRecordFields(record) {
  assert(isRecord(record), 'each score input must be a plain object');
  const ownKeys = Reflect.ownKeys(record);
  assert(ownKeys.every((key) => typeof key === 'string'), 'score input contains an unsupported field');
  const keys = ownKeys.sort();
  assert(keys.length === RECORD_FIELDS.length
    && keys.every((key, index) => key === [...RECORD_FIELDS].sort()[index]),
  'score input must contain exactly the approved fields');
  for (const key of RECORD_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    assert(descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value'),
      'score input fields must be enumerable data properties');
  }
}

function normalizeWer(text) {
  return text.normalize('NFC').toLowerCase().trim().replace(/\s+/gu, ' ');
}

function normalizeCer(text) {
  return Array.from(text.normalize('NFC').toLowerCase());
}

function editDistance(left, right) {
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  // Keep only one row, using the shorter sequence as the column dimension.
  let source = left;
  let target = right;
  if (target.length > source.length) [source, target] = [target, source];

  let previous = Array.from({ length: target.length + 1 }, (_, index) => index);
  for (let sourceIndex = 1; sourceIndex <= source.length; sourceIndex += 1) {
    const current = new Array(target.length + 1);
    current[0] = sourceIndex;
    for (let targetIndex = 1; targetIndex <= target.length; targetIndex += 1) {
      const substitutionCost = source[sourceIndex - 1] === target[targetIndex - 1] ? 0 : 1;
      current[targetIndex] = Math.min(
        previous[targetIndex] + 1,
        current[targetIndex - 1] + 1,
        previous[targetIndex - 1] + substitutionCost,
      );
    }
    previous = current;
  }
  return previous[target.length];
}

function validateRecord(record) {
  assertExactRecordFields(record);
  const localeEntry = Object.values(LOCALES).find((entry) => entry.locale === record.locale);
  assert(localeEntry !== undefined, 'score input locale is not in the pinned v27 profile');
  assert(record.sourceDatasetId === localeEntry.sourceDatasetId,
    'score input dataset ID does not match its locale');
  assert(record.sourceRevision === SOURCE_REVISION, 'score input revision is not the pinned v27 release');
  assert(record.sourceSplit === 'test', 'score input must use the official test split');
  assert(typeof record.clipId === 'string' && record.clipId.trim() !== ''
    && !/[\u0000-\u001f\u007f]/u.test(record.clipId), 'score input clip ID is invalid');
  assert(typeof record.audioSha256 === 'string' && /^[0-9a-f]{64}$/u.test(record.audioSha256),
    'score input audioSha256 must be a lowercase SHA-256 hex digest');
  assert(typeof record.reference === 'string', 'score input reference must be a string');
  assert(typeof record.prediction === 'string', 'score input prediction must be a string');
  assert(record.reference.length <= MAX_TEXT_CODE_UNITS
    && record.prediction.length <= MAX_TEXT_CODE_UNITS,
  `score input text exceeds the ${MAX_TEXT_CODE_UNITS}-code-unit limit`);

  const werReference = normalizeWer(record.reference);
  const werPrediction = normalizeWer(record.prediction);
  const cerReference = normalizeCer(record.reference);
  const cerPrediction = normalizeCer(record.prediction);
  assert(werReference.length > 0 && cerReference.length > 0,
    'score input reference must have non-empty WER and CER denominators');

  return {
    locale: localeEntry.locale,
    werReference: werReference.split(' '),
    werPrediction: werPrediction.split(' ').filter(Boolean),
    cerReference,
    cerPrediction,
    editCells: (werReference.split(' ').length * werPrediction.split(' ').filter(Boolean).length)
      + (cerReference.length * cerPrediction.length),
  };
}

/**
 * Score synthetic in-memory clip records into per-locale aggregate WER/CER.
 *
 * Accepted record shape is exactly:
 * `{locale, sourceDatasetId, sourceRevision, sourceSplit, clipId,
 *   audioSha256, reference, prediction}`.
 *
 * No per-clip result is returned or persisted. The input records are processed
 * in memory; only normalized sequences needed for the current bounded call are
 * held until aggregate scoring completes. Clip IDs and hashes exist only in
 * ephemeral duplicate-detection sets, which are cleared before scoring. This
 * scorer must not be treated as an admission path for real Common Voice audio
 * or as a qualification oracle.
 */
export function scoreCommonVoiceV27Aggregates(records) {
  assert(Array.isArray(records) && records.length > 0, 'score input must be a non-empty array');
  assert(records.length <= MAX_TOTAL_TEST_ROWS,
    `score input exceeds the pinned v27 public test-row ceiling of ${MAX_TOTAL_TEST_ROWS}`);

  const totals = Object.fromEntries(Object.keys(LOCALES).map((key) => [key, {
    clipsScored: 0,
    referenceWordCount: 0,
    wordErrors: 0,
    referenceCharacterCount: 0,
    characterErrors: 0,
  }]));
  const clipKeys = new Set();
  const audioKeys = new Set();
  const validatedRecords = [];
  let cumulativeEditCells = 0;

  for (const record of records) {
    const validated = validateRecord(record);
    const localeKey = Object.keys(LOCALES).find((key) => LOCALES[key].locale === validated.locale);
    const datasetId = LOCALES[localeKey].sourceDatasetId;
    const clipKey = `${datasetId}\u0000${record.clipId}`;
    const audioKey = record.audioSha256;
    assert(!clipKeys.has(clipKey), 'score input contains a duplicate dataset clip ID');
    assert(!audioKeys.has(audioKey), 'score input contains a duplicate dataset audio hash');
    clipKeys.add(clipKey);
    audioKeys.add(audioKey);

    const aggregate = totals[localeKey];
    aggregate.clipsScored += 1;
    assert(aggregate.clipsScored <= LOCALES[localeKey].testRowCap,
      `score input exceeds the pinned ${validated.locale} public test-row ceiling of ${LOCALES[localeKey].testRowCap}`);
    aggregate.referenceWordCount += validated.werReference.length;
    aggregate.referenceCharacterCount += validated.cerReference.length;
    cumulativeEditCells += validated.editCells;
    assert(cumulativeEditCells <= MAX_CUMULATIVE_EDIT_CELLS,
      `score input exceeds the ${MAX_CUMULATIVE_EDIT_CELLS}-cell cumulative edit budget`);
    validatedRecords.push({ localeKey, ...validated });
  }

  for (const [key, locale] of Object.entries(LOCALES)) {
    assert(totals[key].clipsScored > 0, `score input must include at least one ${locale.locale} clip`);
  }
  clipKeys.clear();
  audioKeys.clear();

  for (const validated of validatedRecords) {
    const aggregate = totals[validated.localeKey];
    aggregate.wordErrors += editDistance(validated.werReference, validated.werPrediction);
    aggregate.characterErrors += editDistance(validated.cerReference, validated.cerPrediction);
  }

  const localeResults = {};
  for (const [key, locale] of Object.entries(LOCALES)) {
    const aggregate = totals[key];
    assert(aggregate.referenceWordCount > 0 && aggregate.referenceCharacterCount > 0,
      `score input must have non-empty aggregate denominators for ${locale.locale}`);
    localeResults[locale.locale] = Object.freeze({
      sourceDatasetId: locale.sourceDatasetId,
      sourceRevision: SOURCE_REVISION,
      sourceSplit: 'test',
      clipsScored: aggregate.clipsScored,
      referenceWordCount: aggregate.referenceWordCount,
      wordErrors: aggregate.wordErrors,
      wer: aggregate.wordErrors / aggregate.referenceWordCount,
      referenceCharacterCount: aggregate.referenceCharacterCount,
      characterErrors: aggregate.characterErrors,
      cer: aggregate.characterErrors / aggregate.referenceCharacterCount,
    });
  }

  return Object.freeze({
    corpus: 'Mozilla Common Voice Scripted Speech 27.0',
    evidenceClass: 'SYNTHETIC_LOCAL_CODE_PATH_ONLY',
    disposition: 'NOT_QUALIFIED_THRESHOLDS_UNSET',
    locales: Object.freeze(localeResults),
  });
}
