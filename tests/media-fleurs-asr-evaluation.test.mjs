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
  assert.equal(config.metricProtocol.thresholds, null);
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
