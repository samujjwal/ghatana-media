import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { evaluate, scoreLocale, validateManifest } from '../scripts/qualification/evaluate-fleurs-asr.mjs';

const revision = '70bb2e84b976b7e960aa89f1c648e09c59f894dd';

function datasetLocales() {
  return { eng: { datasetConfig: 'en_us' }, hin: { datasetConfig: 'hi_in' }, npi: { datasetConfig: 'ne_np' } };
}

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
    audioSha256: createHash('sha256').update(`${locale}:${id}`).digest('hex'),
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
      locales: datasetLocales(),
    },
    selection: { trainingSplit: 'train', holdoutSplit: 'dev', clips },
  };
}

function evaluateSynthetic(manifest, predictions) {
  const bytes = Buffer.from(JSON.stringify(manifest));
  return evaluate(manifest, predictions, bytes);
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
  assert.deepEqual(Object.fromEntries(Object.entries(config.dataset.locales).map(([locale, source]) => [locale, source.datasetConfig])),
    { eng: 'en_us', hin: 'hi_in', npi: 'ne_np' });
});

test('blocked metadata-only manifest validates but cannot be scored', () => {
  const manifest = {
    schemaVersion: '1.0.0',
    status: 'METADATA_ONLY_NOT_FROZEN',
    dataset: { name: 'google/fleurs', sourceRevision: revision, license: 'CC-BY-4.0', locales: datasetLocales() },
    selection: { trainingSplit: 'train', holdoutSplit: 'dev', clips: [] },
  };
  assert.equal(validateManifest(manifest).clipCount, 0);
  assert.throws(() => evaluateSynthetic(manifest, []), /not frozen/);
});

test('frozen pack enforces clip evidence, caps, and speaker-disjoint partitions', () => {
  const manifest = frozenManifest();
  assert.equal(validateManifest(manifest, { requireFrozen: true }).clipCount, 6);
  manifest.selection.clips[1].speakerId = manifest.selection.clips[0].speakerId;
  assert.throws(() => validateManifest(manifest, { requireFrozen: true }), /overlaps training and holdout/);
});

test('frozen manifest binds each declared locale to the pinned FLEURS dataset config', () => {
  const manifest = frozenManifest();
  manifest.dataset.locales.hin.datasetConfig = 'en_us';
  assert.throws(() => validateManifest(manifest, { requireFrozen: true }), /dataset config mismatch for hin/);
});

test('frozen manifest cannot swap pinned training and holdout source splits', () => {
  const manifest = frozenManifest();
  manifest.selection.trainingSplit = 'dev';
  manifest.selection.holdoutSplit = 'train';
  for (const row of manifest.selection.clips) {
    row.sourceSplit = row.partition === 'training' ? 'dev' : 'train';
  }
  assert.throws(() => validateManifest(manifest, { requireFrozen: true }),
    /training split does not match pinned source selection/);
});

test('manifest source rows and filenames must be safe source identities', () => {
  const negativeRow = frozenManifest();
  negativeRow.selection.clips[0].sourceRowId = -1;
  assert.throws(() => validateManifest(negativeRow), /non-negative safe integer/);

  const unsafeRow = frozenManifest();
  unsafeRow.selection.clips[0].sourceRowId = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => validateManifest(unsafeRow), /non-negative safe integer/);

  const pathSource = frozenManifest();
  pathSource.selection.clips[0].sourceFile = '../audio.wav';
  assert.throws(() => validateManifest(pathSource), /safe single filename/);
});

test('manifest rejects duplicate pinned source row and filename identities', () => {
  const duplicateRow = frozenManifest();
  const extraTrainingClip = clip('eng', 'e3', 'training', 'e-speaker-3');
  extraTrainingClip.sourceRowId = duplicateRow.selection.clips[0].sourceRowId;
  duplicateRow.selection.clips.push(extraTrainingClip);
  assert.throws(() => validateManifest(duplicateRow), /duplicate source row/);

  const duplicateFile = frozenManifest();
  const sameSplitClip = clip('eng', 'e3', 'training', 'e-speaker-3');
  sameSplitClip.sourceFile = duplicateFile.selection.clips[0].sourceFile;
  duplicateFile.selection.clips.push(sameSplitClip);
  assert.throws(() => validateManifest(duplicateFile), /duplicate source file/);
});

test('rejects identical audio across distinct source rows and partitions, including uppercase digests', () => {
  const manifest = frozenManifest();
  manifest.selection.clips[1].audioSha256 = manifest.selection.clips[0].audioSha256.toUpperCase();
  assert.throws(() => validateManifest(manifest, { requireFrozen: true }), /duplicate audioSha256/);
  assert.throws(() => evaluateSynthetic(manifest, []), /duplicate audioSha256/);
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
  const rawManifestBytes = Buffer.from(` ${JSON.stringify(manifest)}\n`);
  const measured = evaluate(manifest, predictions, rawManifestBytes);
  assert.equal(measured.status, 'MEASURED_ON_FROZEN_HOLDOUT');
  assert.equal(measured.manifestSha256,
    `sha256:${createHash('sha256').update(rawManifestBytes).digest('hex')}`);
  assert.deepEqual(measured.holdoutProvenance, {
    partition: 'holdout',
    clipCount: 3,
    clipCountByLocale: { eng: 1, hin: 1, npi: 1 },
    speakerClusterCountByLocale: { eng: 1, hin: 1, npi: 1 },
  });
  assert.throws(() => evaluate(manifest, predictions), /exact raw manifest bytes/);
  assert.throws(() => evaluateSynthetic(manifest, predictions.slice(0, 2)), /missing prediction/);
});

test('source-bound evaluation rejects manifest objects that differ from the exact raw bytes', () => {
  const manifest = frozenManifest();
  const predictions = manifest.selection.clips.filter((item) => item.partition === 'holdout').map((item) => ({
    locale: item.locale,
    clipId: item.clipId,
    text: item.transcript,
  }));
  const rawManifestBytes = Buffer.from(JSON.stringify(manifest));
  const changedManifest = structuredClone(manifest);
  changedManifest.selection.clips.find((item) => item.partition === 'holdout').transcript = 'different reference';

  assert.throws(() => evaluate(changedManifest, predictions, rawManifestBytes),
    /raw manifest bytes do not match the supplied manifest/);
  assert.throws(() => evaluate(manifest, predictions, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])),
    /raw manifest bytes must be valid UTF-8/);
});

test('empty model failure text remains scoreable while malformed prediction text is rejected', () => {
  const score = scoreLocale([{ clipId: '1', transcript: 'hello world' }], [{ clipId: '1', text: '' }]);
  assert.equal(score.wordErrors, 2);
  assert.equal(score.referenceWords, 2);
  assert.throws(() => scoreLocale([{ clipId: '1', transcript: 'hello' }], [{ clipId: '1', text: null }]),
    /prediction text must be a string/);
  assert.throws(() => scoreLocale([{ clipId: '1', transcript: 'hello' }], [null]),
    /prediction must be an object/);
});


function qualificationManifest() {
  const config = {
    schemaVersion: '1.0.0',
    status: 'FROZEN',
    dataset: {
      name: 'google/fleurs',
      sourceRevision: revision,
      license: 'CC-BY-4.0',
      locales: datasetLocales(),
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

test('qualification mode handles 100 synthetic test rows per locale without claiming real corpus', () => {
  const manifest = qualificationManifest();
  const validated = validateManifest(manifest, { requireFrozen: true });
  assert.equal(validated.mode, 'QUALIFICATION');
  assert.equal(validated.clipCount, 303);
  assert.deepEqual(validated.holdoutCounts, { eng: 100, hin: 100, npi: 100 });
  const gold = manifest.selection.clips.filter((row) => row.partition === 'holdout')
    .map((row) => ({ locale: row.locale, clipId: row.clipId, text: row.transcript }));
  const measured = evaluateSynthetic(manifest, gold);
  assert.equal(measured.status, 'MEASURED_ON_FROZEN_HOLDOUT');
  assert.equal(measured.qualityDecision.status,
    'PROVISIONAL_REFERENCE_EVALUATED_NOT_MODEL_OR_PRODUCTION_ADMISSION');
  assert.equal(measured.qualityDecision.legalRightsAndProviderQualification,
    'NOT_EVALUATED_BY_THIS_TOOL');
  assert.equal(measured.qualityDecision.allReferenceThresholdsMet, true);
  assert.equal(measured.qualityDecision.byLocale.eng.interval.replicates, 1000);
  assert.equal(measured.qualityDecision.byLocale.eng.interval.upper, 0);
  assert.equal(measured.qualityDecision.byLocale.eng.interval.seed,
    20261028 + [...'eng'].reduce((n, ch) => n + ch.codePointAt(0), 0));
  assert.equal(measured.thresholds.npi, 0.55);
  const degraded = gold.map((row) => ({ ...row, text: 'unrelated prediction' }));
  assert.equal(evaluateSynthetic(manifest, degraded).qualityDecision.allReferenceThresholdsMet, false);
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
  assert.equal(evaluateSynthetic(valid, predictions).thresholds, null);
  assert.equal(evaluateSynthetic(valid, predictions).qualityDecision, undefined);
});
