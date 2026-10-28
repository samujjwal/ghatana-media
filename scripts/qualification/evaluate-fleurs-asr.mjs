#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const LOCALES = new Set(['eng', 'hin', 'npi']);
const SHA256 = /^[a-f0-9]{64}$/i;
// Approved provisional reference thresholds are owned by the existing R10 decision map,
// not by an independently editable user-supplied evaluation manifest.
const ownerDecision = JSON.parse(readFileSync(new URL('../../docs/implementation/MEDIA-WAVE2-R10-OWNER-BLOCKER-RESOLUTION.json', import.meta.url), 'utf8'));
const STT_REFERENCE = ownerDecision.approvedReferenceQualificationProfiles.stt;
const PILOT_MAX_CLIPS_PER_LOCALE = STT_REFERENCE.qualityPilotClipsPerLocale;
const QUALIFICATION_MIN_HOLDOUT_CLIPS_PER_LOCALE = STT_REFERENCE.qualityHoldoutMinimumPerLocale;
const QUALIFICATION_MAX_CLIPS_PER_LOCALE = PILOT_MAX_CLIPS_PER_LOCALE + QUALIFICATION_MIN_HOLDOUT_CLIPS_PER_LOCALE;
const REFERENCE_WER_THRESHOLDS = Object.freeze({
  eng: STT_REFERENCE.qualityGateProvisional.enUsWerMax,
  hin: STT_REFERENCE.qualityGateProvisional.hiInWerMax,
  npi: STT_REFERENCE.qualityGateProvisional.neNpWerMax,
});
const BOOTSTRAP_REPLICATES = 1000;
const MAX_CLIP_SECONDS = 30;
const MAX_TOTAL_BYTES = 120 * 1024 * 1024;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalized(value) {
  return value.normalize('NFC').toLocaleLowerCase().trim().replace(/\s+/gu, ' ');
}

function tokens(value) {
  const text = normalized(value);
  return text === '' ? [] : text.split(' ');
}

function codepoints(value) {
  return [...normalized(value)];
}

export function editDistance(reference, hypothesis) {
  let previous = Array.from({ length: hypothesis.length + 1 }, (_, i) => i);
  for (let i = 1; i <= reference.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= hypothesis.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (reference[i - 1] === hypothesis[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[hypothesis.length];
}

export function scoreLocale(clips, predictions) {
  const byId = new Map(predictions.map((item) => [item.clipId, item.text]));
  assert(byId.size === predictions.length, 'duplicate prediction clipId');
  let wordErrors = 0;
  let referenceWords = 0;
  let charErrors = 0;
  let referenceCodepoints = 0;
  for (const clip of clips) {
    assert(byId.has(clip.clipId), `missing prediction for ${clip.clipId}`);
    const refWords = tokens(clip.transcript);
    const hypWords = tokens(byId.get(clip.clipId));
    const refChars = codepoints(clip.transcript);
    const hypChars = codepoints(byId.get(clip.clipId));
    wordErrors += editDistance(refWords, hypWords);
    referenceWords += refWords.length;
    charErrors += editDistance(refChars, hypChars);
    referenceCodepoints += refChars.length;
  }
  assert(byId.size === clips.length, 'predictions include unknown clipId');
  assert(referenceWords > 0 && referenceCodepoints > 0, 'empty gold reference denominator');
  return {
    clipCount: clips.length,
    wordErrors,
    referenceWords,
    wer: wordErrors / referenceWords,
    charErrors,
    referenceCodepoints,
    cer: charErrors / referenceCodepoints,
  };
}

export function validateManifest(manifest, { requireFrozen = false } = {}) {
  assert(manifest?.schemaVersion === '1.0.0', 'unsupported schemaVersion');
  assert(manifest.dataset?.name === 'google/fleurs', 'unexpected dataset');
  assert(manifest.dataset?.sourceRevision === '70bb2e84b976b7e960aa89f1c648e09c59f894dd', 'unexpected source revision');
  assert(manifest.dataset?.license === 'CC-BY-4.0', 'unexpected dataset license');
  for (const locale of LOCALES) assert(manifest.dataset?.locales?.[locale], `missing locale ${locale}`);
  const clips = manifest.selection?.clips;
  assert(Array.isArray(clips), 'selection.clips must be an array');
  const mode = manifest.selection?.mode ?? 'PILOT';
  assert(mode === 'PILOT' || mode === 'QUALIFICATION', 'invalid evaluation selection mode');
  if (requireFrozen) assert(manifest.status === 'FROZEN', 'manifest is not frozen; refusing to score');
  const ids = new Set();
  const sourceRows = new Set();
  const speakersByPartition = { training: new Set(), holdout: new Set() };
  const counts = Object.fromEntries([...LOCALES].map((locale) => [locale, 0]));
  const holdoutCounts = Object.fromEntries([...LOCALES].map((locale) => [locale, 0]));
  const trainingCounts = Object.fromEntries([...LOCALES].map((locale) => [locale, 0]));
  const holdoutSpeakers = Object.fromEntries([...LOCALES].map((locale) => [locale, new Set()]));
  let totalBytes = 0;
  for (const clip of clips) {
    assert(LOCALES.has(clip.locale), `unsupported locale ${clip.locale}`);
    assert(typeof clip.clipId === 'string' && clip.clipId.length > 0, 'clipId is required');
    assert(!ids.has(clip.clipId), `duplicate clipId ${clip.clipId}`);
    ids.add(clip.clipId);
    assert(['training', 'holdout'].includes(clip.partition), `invalid partition for ${clip.clipId}`);
    assert(typeof clip.sourceSplit === 'string' && clip.sourceSplit.length > 0, `sourceSplit required for ${clip.clipId}`);
    assert(clip.sourceSplit === (clip.partition === 'training' ? manifest.selection.trainingSplit : manifest.selection.holdoutSplit),
      `source split does not match partition for ${clip.clipId}`);
    assert(Number.isInteger(clip.sourceRowId), `sourceRowId required for ${clip.clipId}`);
    const sourceRowKey = `${clip.locale}:${clip.sourceSplit}:${clip.sourceRowId}`;
    assert(!sourceRows.has(sourceRowKey), `duplicate source row ${sourceRowKey}`);
    sourceRows.add(sourceRowKey);
    assert(typeof clip.sourceFile === 'string' && clip.sourceFile.length > 0, `sourceFile required for ${clip.clipId}`);
    assert(typeof clip.transcript === 'string' && clip.transcript.trim().length > 0, `transcript required for ${clip.clipId}`);
    assert(Number.isFinite(clip.durationSeconds) && clip.durationSeconds > 0 && clip.durationSeconds <= MAX_CLIP_SECONDS,
      `duration must be in (0, ${MAX_CLIP_SECONDS}] for ${clip.clipId}`);
    assert(Number.isInteger(clip.sizeBytes) && clip.sizeBytes > 0, `sizeBytes required for ${clip.clipId}`);
    totalBytes += clip.sizeBytes;
    assert(SHA256.test(clip.audioSha256 ?? ''), `audioSha256 required for ${clip.clipId}`);
    assert(clip.sourceRevision === manifest.dataset.sourceRevision, `source revision mismatch for ${clip.clipId}`);
    assert(clip.license === 'CC-BY-4.0', `clip license required for ${clip.clipId}`);
    assert(typeof clip.attribution === 'string' && clip.attribution.trim().length > 0, `attribution required for ${clip.clipId}`);
    assert(typeof clip.speakerId === 'string' && clip.speakerId.length > 0, `speakerId required for ${clip.clipId}`);
    assert(typeof clip.speakerSourceReference === 'string' && clip.speakerSourceReference.length > 0,
      `speakerSourceReference required for ${clip.clipId}`);
    const set = speakersByPartition[clip.partition];
    set.add(`${clip.locale}:${clip.speakerId}`);
    counts[clip.locale] += 1;
    if (clip.partition === 'holdout') {
      holdoutCounts[clip.locale] += 1;
      holdoutSpeakers[clip.locale].add(clip.speakerId);
    } else {
      trainingCounts[clip.locale] += 1;
    }
    assert(counts[clip.locale] <= (mode === 'QUALIFICATION'
      ? QUALIFICATION_MAX_CLIPS_PER_LOCALE : PILOT_MAX_CLIPS_PER_LOCALE),
    `locale cap exceeded for ${clip.locale}`);
    assert(trainingCounts[clip.locale] <= PILOT_MAX_CLIPS_PER_LOCALE,
      `pilot/training cap exceeded for ${clip.locale}`);
  }
  for (const speaker of speakersByPartition.holdout) {
    assert(!speakersByPartition.training.has(speaker), `speaker overlaps training and holdout: ${speaker}`);
  }
  assert(totalBytes <= MAX_TOTAL_BYTES, `selected audio exceeds ${MAX_TOTAL_BYTES} byte budget`);
  if (requireFrozen) {
    for (const locale of LOCALES) {
      assert(counts[locale] > 0, `frozen manifest has no clips for ${locale}`);
      assert(holdoutCounts[locale] > 0, `no holdout clips for ${locale}`);
    }
    if (mode === 'QUALIFICATION') {
      const preregistered = manifest.metricProtocol?.thresholds;
      assert(preregistered?.scope === 'REFERENCE_ONLY_NOT_PRODUCTION_SLO'
        && preregistered.minHoldoutClipsPerLocale === QUALIFICATION_MIN_HOLDOUT_CLIPS_PER_LOCALE,
      'source-pinned reference qualification threshold policy required');
      for (const locale of LOCALES) {
        assert(preregistered?.werMaxByLocale?.[locale] === REFERENCE_WER_THRESHOLDS[locale],
          `reference WER threshold mismatch for ${locale}`);
        assert(holdoutCounts[locale] >= QUALIFICATION_MIN_HOLDOUT_CLIPS_PER_LOCALE,
          `qualification requires at least ${QUALIFICATION_MIN_HOLDOUT_CLIPS_PER_LOCALE} holdout clips for ${locale}`);
        assert(holdoutSpeakers[locale].size >= 2,
          `qualification requires at least two distinct grounded holdout speakers for ${locale}`);
      }
    }
  }
  return { clipCount: clips.length, counts, holdoutCounts, mode, totalBytes };
}


/** Deterministic speaker-clustered uncertainty; not license/provider admission. */
function speakerBootstrapWer(clips, predictions, locale) {
  const byId = new Map(predictions.map((row) => [row.clipId, row.text]));
  const bySpeaker = new Map();
  for (const clip of clips) {
    const reference = tokens(clip.transcript);
    const hypothesis = tokens(byId.get(clip.clipId));
    const contribution = { errors: editDistance(reference, hypothesis), words: reference.length };
    const previous = bySpeaker.get(clip.speakerId) ?? { errors: 0, words: 0 };
    previous.errors += contribution.errors;
    previous.words += contribution.words;
    bySpeaker.set(clip.speakerId, previous);
  }
  const clusters = [...bySpeaker.values()];
  assert(clusters.length >= 2, 'qualification requires distinct holdout speaker clusters');
  let seed = (20261028 + [...locale].reduce((n, ch) => n + ch.codePointAt(0), 0)) >>> 0;
  const draws = [];
  for (let replicate = 0; replicate < BOOTSTRAP_REPLICATES; replicate += 1) {
    let errors = 0;
    let words = 0;
    for (let i = 0; i < clusters.length; i += 1) {
      seed ^= (seed << 13) >>> 0;
      seed ^= seed >>> 17;
      seed ^= (seed << 5) >>> 0;
      const sample = clusters[(seed >>> 0) % clusters.length];
      errors += sample.errors;
      words += sample.words;
    }
    assert(words > 0, 'bootstrap sample has no reference words');
    draws.push(errors / words);
  }
  draws.sort((a, b) => a - b);
  return {
    method: 'SPEAKER_CLUSTER_PERCENTILE_BOOTSTRAP',
    seed: 20261028,
    confidence: 0.95,
    replicates: BOOTSTRAP_REPLICATES,
    holdoutSpeakerClusters: clusters.length,
    lower: draws[Math.floor(0.025 * BOOTSTRAP_REPLICATES)],
    upper: draws[Math.ceil(0.975 * BOOTSTRAP_REPLICATES) - 1],
  };
}

export function evaluate(manifest, predictions) {
  validateManifest(manifest, { requireFrozen: true });
  const holdout = manifest.selection.clips.filter((clip) => clip.partition === 'holdout');
  const predictionGroups = new Map();
  for (const prediction of predictions) {
    assert(LOCALES.has(prediction.locale), `unsupported prediction locale ${prediction.locale}`);
    const group = predictionGroups.get(prediction.locale) ?? [];
    group.push(prediction);
    predictionGroups.set(prediction.locale, group);
  }
  const results = {};
  for (const locale of LOCALES) {
    const clips = holdout.filter((clip) => clip.locale === locale);
    const rows = predictionGroups.get(locale) ?? [];
    assert(clips.length > 0, `no holdout gold clips for ${locale}`);
    results[locale] = scoreLocale(clips, rows);
  }
  const mode = manifest.selection?.mode ?? 'PILOT';
  const qualityDecision = mode === 'QUALIFICATION' ? Object.fromEntries([...LOCALES].map((locale) => {
    const clips = holdout.filter((clip) => clip.locale === locale);
    const interval = speakerBootstrapWer(clips, predictionGroups.get(locale) ?? [], locale);
    const werMax = REFERENCE_WER_THRESHOLDS[locale];
    return [locale, {
      werMax,
      observedWer: results[locale].wer,
      interval,
      provisionalReferenceThresholdMet: interval.upper <= werMax,
    }];
  })) : null;
  return {
    status: 'MEASURED_ON_FROZEN_HOLDOUT',
    sourceRevision: manifest.dataset.sourceRevision,
    results,
    thresholds: mode === 'QUALIFICATION' ? REFERENCE_WER_THRESHOLDS : null,
    ...(qualityDecision ? {
      qualityDecision: {
        status: 'PROVISIONAL_REFERENCE_EVALUATED_NOT_MODEL_OR_PRODUCTION_ADMISSION',
        byLocale: qualityDecision,
        allReferenceThresholdsMet: Object.values(qualityDecision)
          .every((decision) => decision.provisionalReferenceThresholdMet),
        legalRightsAndProviderQualification: 'NOT_EVALUATED_BY_THIS_TOOL',
      },
    } : {}),
  };
}

async function main(args) {
  const manifestPath = args[0];
  const predictionsPath = args[1];
  if (!manifestPath || !predictionsPath) {
    throw new Error('usage: evaluate-fleurs-asr.mjs <frozen-manifest.json> <predictions.json>');
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const predictions = JSON.parse(await readFile(predictionsPath, 'utf8'));
  process.stdout.write(`${JSON.stringify(evaluate(manifest, predictions), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
