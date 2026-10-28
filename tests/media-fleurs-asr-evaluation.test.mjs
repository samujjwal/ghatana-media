import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluate, scoreLocale, validateManifest } from '../scripts/qualification/evaluate-fleurs-asr.mjs';

const revision = '70bb2e84b976b7e960aa89f1c648e09c59f894dd';
const sha = 'a'.repeat(64);

function clip(locale, id, partition, speakerId) {
  return {
    clipId: id,
    locale,
    partition,
    sourceSplit: partition === 'holdout' ? 'dev' : 'train',
    sourceRowId: Number(id.replace(/\D/g, '')) || 1,
    sourceFile: `${id}.wav`,
    transcript: 'Reference phrase',
    durationSeconds: 2.5,
    sizeBytes: 12000,
    audioSha256: sha,
    sourceRevision: revision,
    license: 'CC-BY-4.0',
    attribution: 'Google FLEURS, CC-BY-4.0; source row attribution pending review',
    speakerId,
    speakerSourceReference: `pinned source speaker metadata: ${speakerId}`,
  };
}

function frozenManifest() {
  const clips = [];
  for (const [locale, prefix] of [['eng', 'e'], ['hin', 'h'], ['npi', 'n']]) {
    clips.push(clip(locale, `${prefix}1`, 'training', `${prefix}-speaker-1`));
    clips.push(clip(locale, `${prefix}2`, 'holdout', `${prefix}-speaker-2`));
  }
  return {
    schemaVersion: '1.0.0',
    status: 'FROZEN',
    dataset: {
      name: 'google/fleurs',
      sourceRevision: revision,
      license: 'CC-BY-4.0',
      locales: { eng: {}, hin: {}, npi: {} },
    },
    selection: { trainingSplit: 'train', holdoutSplit: 'dev', clips },
  };
}

test('checked-in preparation config pins R9 source and remains unfrozen', async () => {
  const config = JSON.parse(await readFile(new URL('../config/qualification/fleurs-asr-evaluation.v1.json', import.meta.url), 'utf8'));
  assert.equal(config.status, 'METADATA_ONLY_NOT_FROZEN');
  assert.equal(config.dataset.sourceRevision, revision);
  assert.equal(config.dataset.license, 'CC-BY-4.0');
  assert.deepEqual(Object.keys(config.dataset.locales).sort(), ['eng', 'hin', 'npi']);
  assert.equal(config.selection.clips.length, 0);
  assert.equal(config.selection.mode, 'PILOT');
  assert.equal(config.selectionLimits.maxClipsPerLocale, 24);
  assert.equal(config.qualificationSelectionLimits.minHoldoutClipsPerLocale, 100);
  assert.equal(config.qualificationSelectionLimits.maxTotalClipsPerLocale, 124);
  assert.equal(config.metricProtocol.thresholds.scope, 'REFERENCE_ONLY_NOT_PRODUCTION_SLO');
  assert.deepEqual(config.metricProtocol.thresholds.werMaxByLocale,
    { eng: 0.3, hin: 0.45, npi: 0.55 });
  assert.equal(config.metricProtocol.confidenceIntervals.replicates, 1000);
});

test('blocked metadata-only manifest validates but cannot be scored', () => {
  const manifest = {
    schemaVersion: '1.0.0',
    status: 'METADATA_ONLY_NOT_FROZEN',
    dataset: { name: 'google/fleurs', sourceRevision: revision, license: 'CC-BY-4.0', locales: { eng: {}, hin: {}, npi: {} } },
    selection: { trainingSplit: 'train', holdoutSplit: 'dev', clips: [] },
  };
  assert.equal(validateManifest(manifest).clipCount, 0);
  assert.throws(() => evaluate(manifest, []), /not frozen/);
});

test('frozen pack enforces clip evidence, caps, and speaker-disjoint partitions', () => {
  const manifest = frozenManifest();
  assert.equal(validateManifest(manifest, { requireFrozen: true }).clipCount, 6);
  manifest.selection.clips[1].speakerId = manifest.selection.clips[0].speakerId;
  assert.throws(() => validateManifest(manifest, { requireFrozen: true }), /overlaps training and holdout/);
});

test('WER and CER scoring plumbing uses aggregate edit counts and requires exact holdout predictions', () => {
  const score = scoreLocale([{ clipId: '1', transcript: 'Hello world' }], [{ clipId: '1', text: 'hello there' }]);
  assert.equal(score.wordErrors, 1);
  assert.equal(score.referenceWords, 2);
  assert.equal(score.charErrors, 5);
  const manifest = frozenManifest();
  const predictions = manifest.selection.clips.filter((item) => item.partition === 'holdout').map((item) => ({
    locale: item.locale,
    clipId: item.clipId,
    text: item.transcript,
  }));
  assert.equal(evaluate(manifest, predictions).status, 'MEASURED_ON_FROZEN_HOLDOUT');
  assert.throws(() => evaluate(manifest, predictions.slice(0, 2)), /missing prediction/);
});


function qualificationManifest() {
  const config = {
    schemaVersion: '1.0.0',
    status: 'FROZEN',
    dataset: {
      name: 'google/fleurs',
      sourceRevision: revision,
      license: 'CC-BY-4.0',
      locales: { eng: {}, hin: {}, npi: {} },
    },
    metricProtocol: {
      thresholds: {
        scope: 'REFERENCE_ONLY_NOT_PRODUCTION_SLO',
        minHoldoutClipsPerLocale: 100,
        werMaxByLocale: { eng: 0.3, hin: 0.45, npi: 0.55 },
      },
    },
    selection: {
      mode: 'QUALIFICATION',
      trainingSplit: 'train',
      holdoutSplit: 'dev',
      clips: [],
    },
  };
  for (const [locale, prefix] of [['eng', 'e'], ['hin', 'h'], ['npi', 'n']]) {
    config.selection.clips.push(clip(locale, prefix + '-pilot-1000', 'training', prefix + '-pilot-speaker'));
    for (let i = 1; i <= 100; i += 1) {
      config.selection.clips.push(clip(locale, prefix + '-holdout-' + i, 'holdout',
        prefix + '-holdout-speaker-' + i));
    }
  }
  return config;
}

test('qualification mode admits 100 source-grounded holdout clips per locale within strict budget', () => {
  const manifest = qualificationManifest();
  const validated = validateManifest(manifest, { requireFrozen: true });
  assert.equal(validated.mode, 'QUALIFICATION');
  assert.equal(validated.clipCount, 303);
  assert.deepEqual(validated.holdoutCounts, { eng: 100, hin: 100, npi: 100 });
  const gold = manifest.selection.clips.filter((row) => row.partition === 'holdout')
    .map((row) => ({ locale: row.locale, clipId: row.clipId, text: row.transcript }));
  const measured = evaluate(manifest, gold);
  assert.equal(measured.status, 'MEASURED_ON_FROZEN_HOLDOUT');
  assert.equal(measured.qualityDecision.status,
    'PROVISIONAL_REFERENCE_EVALUATED_NOT_MODEL_OR_PRODUCTION_ADMISSION');
  assert.equal(measured.qualityDecision.legalRightsAndProviderQualification,
    'NOT_EVALUATED_BY_THIS_TOOL');
  assert.equal(measured.qualityDecision.allReferenceThresholdsMet, true);
  assert.equal(measured.qualityDecision.byLocale.eng.interval.replicates, 1000);
  assert.equal(measured.qualityDecision.byLocale.eng.interval.upper, 0);
  assert.equal(measured.thresholds.npi, 0.55);
  const degraded = gold.map((row) => ({ ...row, text: 'unrelated prediction' }));
  assert.equal(evaluate(manifest, degraded).qualityDecision.allReferenceThresholdsMet, false);
});

test('qualification refuses smaller holdout, altered thresholds, implausible speakers and excessive data', () => {
  const original = qualificationManifest();
  const undersized = structuredClone(original);
  undersized.selection.clips.splice(2, 1);
  assert.throws(() => validateManifest(undersized, { requireFrozen: true }),
    /requires at least 100 holdout clips/);
  const alteredThreshold = structuredClone(original);
  alteredThreshold.metricProtocol.thresholds.werMaxByLocale.eng = 0.9;
  assert.throws(() => validateManifest(alteredThreshold, { requireFrozen: true }),
    /reference WER threshold mismatch/);
  const duplicateSpeakers = structuredClone(original);
  for (const row of duplicateSpeakers.selection.clips) {
    if (row.locale === 'eng' && row.partition === 'holdout') row.speakerId = 'same-speaker';
  }
  assert.throws(() => validateManifest(duplicateSpeakers, { requireFrozen: true }),
    /distinct grounded holdout speakers/);
  const excessiveAudio = structuredClone(original);
  for (const row of excessiveAudio.selection.clips) row.sizeBytes = 500000;
  assert.throws(() => validateManifest(excessiveAudio, { requireFrozen: true }),
    /selected audio exceeds/);
  const badMode = structuredClone(original);
  badMode.selection.mode = 'PRODUCTION';
  assert.throws(() => validateManifest(badMode), /invalid evaluation selection mode/);
});

test('pilot mode retains its 24 clips per locale cap without accidental quality admission', () => {
  const pilot = frozenManifest();
  pilot.selection.mode = 'PILOT';
  for (let i = 3; i <= 25; i += 1) {
    pilot.selection.clips.push(clip('eng', 'epilot-' + i, 'training', 'eng-pilot-speaker-' + i));
  }
  assert.throws(() => validateManifest(pilot), /locale cap exceeded for eng/);
  const valid = frozenManifest();
  valid.selection.mode = 'PILOT';
  const predictions = valid.selection.clips.filter((c) => c.partition === 'holdout')
    .map((c) => ({ locale: c.locale, clipId: c.clipId, text: c.transcript }));
  assert.equal(evaluate(valid, predictions).thresholds, null);
  assert.equal(evaluate(valid, predictions).qualityDecision, undefined);
});
