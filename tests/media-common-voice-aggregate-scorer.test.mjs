import test from 'node:test';
import assert from 'node:assert/strict';

import { scoreCommonVoiceV27Aggregates } from '../scripts/qualification/common-voice-aggregate-scorer.mjs';

const RELEASE = 'cv-corpus-27.0-2026-09-11';
const LOCALES = Object.freeze({
  en: Object.freeze({ locale: 'en', datasetId: 'cmu5jplf300nwmh07iqvk9leo' }),
  hi: Object.freeze({ locale: 'hi', datasetId: 'cmu5vlext009to107ev1s9lk8' }),
  ne: Object.freeze({ locale: 'ne-NP', datasetId: 'cmu61478v00j9o107alzuue1z' }),
});

function clip(localeKey, clipId, reference, prediction, hashChar) {
  const locale = LOCALES[localeKey];
  return {
    locale: locale.locale,
    sourceDatasetId: locale.datasetId,
    sourceRevision: RELEASE,
    sourceSplit: 'test',
    clipId,
    audioSha256: hashChar.repeat(64),
    reference,
    prediction,
  };
}

function validThreeLocaleInput() {
  return [
    clip('en', 'en-1', 'a b', 'a c', 'a'),
    clip('en', 'en-2', 'Hi', 'hi', 'b'),
    clip('hi', 'hi-1', 'नमस्ते', 'नमस्ते', 'c'),
    clip('ne', 'ne-1', 'न', '', 'd'),
  ];
}

test('returns per-locale aggregate WER/CER only for the pinned three-locale v27 test inputs', () => {
  const result = scoreCommonVoiceV27Aggregates(validThreeLocaleInput());

  assert.equal(result.disposition, 'NOT_QUALIFIED_THRESHOLDS_UNSET');
  assert.equal(result.evidenceClass, 'SYNTHETIC_LOCAL_CODE_PATH_ONLY');
  assert.equal(result.locales.en.clipsScored, 2);
  assert.equal(result.locales.en.referenceWordCount, 3);
  assert.equal(result.locales.en.wordErrors, 1);
  assert.equal(result.locales.en.wer, 1 / 3);
  assert.equal(result.locales.en.referenceCharacterCount, 5);
  assert.equal(result.locales.en.characterErrors, 1);
  assert.equal(result.locales.en.cer, 1 / 5);
  assert.equal(result.locales.hi.clipsScored, 1);
  assert.equal(result.locales.hi.wer, 0);
  assert.equal(result.locales.hi.cer, 0);
  assert.equal(result.locales['ne-NP'].clipsScored, 1);
  assert.equal(result.locales['ne-NP'].wer, 1);
  assert.equal(result.locales['ne-NP'].cer, 1);

  const serialized = JSON.stringify(result);
  for (const clipId of ['en-1', 'en-2', 'hi-1', 'ne-1']) assert.equal(serialized.includes(clipId), false);
  for (const privateText of ['a b', 'a c', 'नमस्ते']) assert.equal(serialized.includes(privateText), false);
  for (const hashChar of ['a', 'b', 'c', 'd']) assert.equal(serialized.includes(hashChar.repeat(64)), false);
  assert.deepEqual(Object.keys(result.locales.en).sort(), [
    'characterErrors', 'cer', 'clipsScored', 'referenceCharacterCount', 'referenceWordCount',
    'sourceDatasetId', 'sourceRevision', 'sourceSplit', 'wer', 'wordErrors',
  ].sort());
});

test('normalizes NFC, lowercase, and collapsed whitespace while CER preserves whitespace', () => {
  const normalized = [
    clip('en', 'en-1', 'Cafe\u0301  TIME', 'CAFÉ TIME', 'a'),
    clip('hi', 'hi-1', 'क', 'क', 'b'),
    clip('ne', 'ne-1', 'ख', 'ख', 'c'),
  ];
  const result = scoreCommonVoiceV27Aggregates(normalized);
  assert.equal(result.locales.en.wer, 0);
  assert.equal(result.locales.en.cer, 1 / 10);

  const spacing = [
    clip('en', 'en-2', 'a b', 'ab', 'd'),
    clip('hi', 'hi-2', 'क', 'क', 'e'),
    clip('ne', 'ne-2', 'ख', 'ख', 'f'),
  ];
  const spacingResult = scoreCommonVoiceV27Aggregates(spacing);
  assert.equal(spacingResult.locales.en.wer, 1);
  assert.equal(spacingResult.locales.en.cer, 1 / 3);
});

test('allows an empty prediction as a valid full-error boundary case', () => {
  const result = scoreCommonVoiceV27Aggregates([
    clip('en', 'en-1', 'hello', '', 'a'),
    clip('hi', 'hi-1', 'नमस्ते', '', 'b'),
    clip('ne', 'ne-1', 'नेपाल', '', 'c'),
  ]);
  assert.equal(result.locales.en.wer, 1);
  assert.equal(result.locales.en.cer, 1);
  assert.equal(result.locales.hi.wer, 1);
  assert.equal(result.locales.hi.cer, 1);
  assert.equal(result.locales['ne-NP'].wer, 1);
  assert.equal(result.locales['ne-NP'].cer, 1);
});

test('rejects missing locales and empty input', () => {
  assert.throws(() => scoreCommonVoiceV27Aggregates([]), /non-empty array/u);
  assert.throws(() => scoreCommonVoiceV27Aggregates(
    validThreeLocaleInput().filter((record) => record.locale !== 'en')),
  /at least one en clip/u);
});

test('rejects duplicate dataset clip IDs and duplicate audio hashes across locales', () => {
  const duplicateId = validThreeLocaleInput();
  duplicateId.push(clip('en', 'en-1', 'different', 'different', 'e'));
  assert.throws(() => scoreCommonVoiceV27Aggregates(duplicateId), /duplicate dataset clip ID/u);

  const duplicateHash = validThreeLocaleInput();
  duplicateHash.push(clip('hi', 'hi-2', 'different', 'different', 'a'));
  assert.throws(() => scoreCommonVoiceV27Aggregates(duplicateHash), /duplicate dataset audio hash/u);
});

test('rejects extra fields, including speaker or demographic identifiers and symbol keys', () => {
  for (const field of ['speakerId', 'client_id', 'age', 'gender', 'accent', 'transcript']) {
    const records = validThreeLocaleInput();
    records[0][field] = 'must-not-be-accepted';
    assert.throws(() => scoreCommonVoiceV27Aggregates(records), /exactly the approved fields/u, field);
  }
  const records = validThreeLocaleInput();
  records[0][Symbol('private')] = 'extra';
  assert.throws(() => scoreCommonVoiceV27Aggregates(records), /unsupported field/u);
});

test('rejects unknown locales, dataset IDs, revisions, splits, invalid hashes, and empty denominators', () => {
  const cases = [
    ['locale', 'xx', /locale/u],
    ['sourceDatasetId', 'unknown-dataset', /dataset ID/u],
    ['sourceRevision', 'cv-corpus-26.0', /revision/u],
    ['sourceSplit', 'dev', /official test split/u],
    ['audioSha256', 'ABCDEF', /lowercase SHA-256/u],
    ['reference', ' \t\n ', /non-empty WER and CER denominators/u],
  ];
  for (const [field, value, error] of cases) {
    const records = validThreeLocaleInput();
    records[0][field] = value;
    assert.throws(() => scoreCommonVoiceV27Aggregates(records), error, field);
  }
});

test('rejects non-string predictions and accessor-backed fields', () => {
  const wrongType = validThreeLocaleInput();
  wrongType[0].prediction = null;
  assert.throws(() => scoreCommonVoiceV27Aggregates(wrongType), /prediction must be a string/u);

  const accessor = validThreeLocaleInput();
  Object.defineProperty(accessor[0], 'reference', { enumerable: true, get: () => 'a b' });
  assert.throws(() => scoreCommonVoiceV27Aggregates(accessor), /data properties/u);
});

test('scores snapshotted data descriptor values when proxy reads would vary between passes', () => {
  const records = validThreeLocaleInput();
  const stable = records[0];
  records[0] = new Proxy(stable, {
    get(target, key, receiver) {
      if (key === 'reference' || key === 'prediction') return 'x'.repeat(1_000_000);
      return Reflect.get(target, key, receiver);
    },
  });
  const result = scoreCommonVoiceV27Aggregates(records);
  assert.equal(result.locales.en.wer, 1 / 3);
  assert.equal(result.locales.en.cer, 1 / 5);
});

test('rejects input above the combined pinned v27 public test-row ceiling before record processing', () => {
  const tooMany = new Array(20_108).fill(null);
  assert.throws(() => scoreCommonVoiceV27Aggregates(tooMany), /test-row ceiling of 20107/u);
});

test('rejects English rows above its own test-split ceiling below the combined ceiling', () => {
  const englishRows = Array.from({ length: 16_404 }, (_, index) => {
    const record = clip('en', `en-${index}`, 'a', 'a', '0');
    record.audioSha256 = index.toString(16).padStart(64, '0');
    return record;
  });
  assert.ok(englishRows.length < 20_107);
  assert.throws(() => scoreCommonVoiceV27Aggregates(englishRows),
    /pinned en public test-row ceiling of 16403/u);
});

test('rejects overlong text before normalization or distance scoring', () => {
  const records = validThreeLocaleInput();
  records[0].reference = 'x'.repeat(16_385);
  assert.throws(() => scoreCommonVoiceV27Aggregates(records), /16384-code-unit limit/u);
});

test('bounds cumulative raw text before normalization for maximum-length references and empty predictions', () => {
  const records = Array.from({ length: 62 }, (_, index) => {
    const record = clip('en', `en-max-${index}`, 'x'.repeat(16_384), '', '0');
    record.audioSha256 = index.toString(16).padStart(64, '0');
    return record;
  });
  assert.throws(() => scoreCommonVoiceV27Aggregates(records),
    /1000000-code-unit cumulative text limit/u);
});

test('preflights cumulative WER and CER edit cells before any scoring loops', () => {
  const records = [
    clip('en', 'en-large', 'a'.repeat(7_100), 'b'.repeat(7_100), 'a'),
    clip('hi', 'hi-1', 'क', 'क', 'b'),
    clip('ne', 'ne-1', 'ख', 'ख', 'c'),
  ];
  assert.throws(() => scoreCommonVoiceV27Aggregates(records),
    /50000000-cell cumulative edit budget/u);
});
