import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { runCommonVoiceReferenceReviewCli } from '../scripts/qualification/common-voice-reference-review.mjs';

const REVISION = 'cv-corpus-27.0-2026-09-11';
const DATASETS = { en: 'cmu5jplf300nwmh07iqvk9leo', 'ne-NP': 'cmu61478v00j9o107alzuue1z' };
const ARCHIVES = {
  en: { basename: '1789502799671-cv-corpus-27.0-2026-09-11-en.tar.gz', bytes: 94956262763 },
  'ne-NP': { basename: '1789491018738-cv-corpus-27.0-2026-09-11-ne-NP.tar.gz', bytes: 42519359 },
};

function makeRecords(locale) {
  return Array.from({ length: 24 }, (_, index) => {
    const audioBytes = Buffer.from(`synthetic audio ${locale} ${index}`);
    return {
      clipId: `common_voice_${locale}_${100000 + index}.mp3`,
      sentence: `private synthetic transcript ${locale} ${index}`,
      audioBytes,
      audioSha256: createHash('sha256').update(audioBytes).digest('hex'),
    };
  });
}

function makePilotManifest() {
  const locales = ['en', 'ne-NP'].map((locale) => {
    const records = makeRecords(locale);
    const clipManifest = records.map((record) => ({
      locale,
      sourceDatasetId: DATASETS[locale],
      sourceRevision: REVISION,
      sourceSplit: 'test',
      clipId: record.clipId,
      audioSha256: record.audioSha256,
    }));
    const archive = ARCHIVES[locale];
    return {
      locale,
      sourceDatasetId: DATASETS[locale],
      sourceRevision: REVISION,
      sourceSplit: 'test',
      pilotSizePerLocale: 24,
      clipManifestDigest: createHash('sha256').update(JSON.stringify(clipManifest)).digest('hex'),
      clipManifest,
      archive: {
        basename: archive.basename,
        localPath: `/private/synthetic/${archive.basename}`,
        sourceSizeBytes: archive.bytes,
        localFileSizeBytes: archive.bytes,
        localArchiveSha256: 'a'.repeat(64),
        observationType: 'LOCAL_COMPRESSED_ARCHIVE_SHA256_NOT_PUBLISHER_HASH',
      },
    };
  });
  return {
    schemaVersion: '1.0.0',
    corpus: 'Mozilla Common Voice Scripted Speech 27.0',
    sourceRevision: REVISION,
    sourceSplit: 'test',
    selection: 'sha256-rank-24-per-locale',
    locales,
    realInferenceAdmitted: false,
  };
}

async function privateManifestFile() {
  const rawRoot = await mkdtemp(join(tmpdir(), 'common-voice-reference-review-'));
  const root = await realpath(rawRoot);
  await chmod(root, 0o700);
  const metadataRoot = join(root, 'metadata');
  const runDirectory = join(metadataRoot, `metadata-${randomUUID()}`);
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  await chmod(metadataRoot, 0o700);
  await chmod(runDirectory, 0o700);
  const manifestPath = join(runDirectory, 'pilot-manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(makePilotManifest())}\n`, { flag: 'wx', mode: 0o600 });
  await chmod(manifestPath, 0o600);
  return { root, metadataRoot, manifestPath };
}

function cliArgs({ archive, locale, manifestPath, metadataRoot, audioRoot }) {
  return ['--archive', archive, '--locale', locale, '--pilot-manifest', manifestPath,
    '--metadata-root', metadataRoot, '--audio-root', audioRoot];
}

function fakeSession(counts, complete = true) {
  return {
    url: 'http://127.0.0.1:44001/volatile-test-token/0',
    result: Promise.resolve({ complete, counts }),
    close: async () => {},
  };
}

test('private reference review retains only manifest-bound aggregate and emits no clip data', async () => {
  const fixture = await privateManifestFile();
  const records = makeRecords('en');
  const counts = { total: 24, match: 24, mismatch: 0, unintelligible: 0, skip: 0 };
  const checkedAt = new Date('2026-11-04T12:00:00.000Z');
  let retainedOutcome;
  let retentionClock;
  let output = '';
  try {
    const result = await runCommonVoiceReferenceReviewCli(cliArgs({
      archive: `/private/synthetic/${ARCHIVES.en.basename}`,
      locale: 'en', manifestPath: fixture.manifestPath, metadataRoot: fixture.metadataRoot,
      audioRoot: join(fixture.root, 'audio'),
    }), {
      stdout: (line) => { output += line; },
      now: () => checkedAt,
      loadReviewData: async () => ({
        locale: 'en', sourceDatasetId: DATASETS.en, sourceRevision: REVISION, sourceSplit: 'test',
        clipManifestDigest: makePilotManifest().locales[0].clipManifestDigest,
        records,
      }),
      startReview: async () => fakeSession(counts),
      retainReview: async (_metadataRoot, _audioRoot, outcome, options) => {
        retainedOutcome = outcome;
        retentionClock = options.now();
        return { runId: 'private-synthetic-run' };
      },
    });

    assert.deepEqual(result, { completed: true, counts, retained: true });
    assert.equal(retainedOutcome.locale, 'en');
    assert.equal(retainedOutcome.sourceDatasetId, DATASETS.en);
    assert.equal(retainedOutcome.sourceRevision, REVISION);
    assert.equal(retainedOutcome.sourceSplit, 'test');
    assert.match(retainedOutcome.clipManifestDigest, /^[0-9a-f]{64}$/u);
    assert.equal(retainedOutcome.checkedAt, checkedAt.toISOString());
    assert.deepEqual(retainedOutcome.counts, counts);
    assert.equal(retainedOutcome.completed, true);
    assert.equal(retentionClock, checkedAt);
    assert.doesNotMatch(output, /common_voice_en_|private synthetic transcript|synthetic audio|private\/synthetic|clipManifestDigest/u);
    assert.match(output, /aggregateRetainedInOwnerOnlyMetadata":true/u);
    assert.equal(records.every((record) => record.sentence === '' && record.clipId === ''
      && record.audioSha256 === '' && record.audioBytes.length === 0), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('incomplete reference review is not retained', async () => {
  const fixture = await privateManifestFile();
  const records = makeRecords('ne-NP');
  let retainCalled = false;
  let output = '';
  try {
    const result = await runCommonVoiceReferenceReviewCli(cliArgs({
      archive: `/private/synthetic/${ARCHIVES['ne-NP'].basename}`,
      locale: 'ne-NP', manifestPath: fixture.manifestPath, metadataRoot: fixture.metadataRoot,
      audioRoot: join(fixture.root, 'audio'),
    }), {
      stdout: (line) => { output += line; },
      loadReviewData: async () => ({
        locale: 'ne-NP', sourceDatasetId: DATASETS['ne-NP'], sourceRevision: REVISION, sourceSplit: 'test',
        clipManifestDigest: makePilotManifest().locales[1].clipManifestDigest,
        records,
      }),
      startReview: async () => fakeSession({ total: 24, match: 1, mismatch: 0, unintelligible: 0, skip: 0 }, false),
      retainReview: async () => { retainCalled = true; },
    });
    assert.deepEqual(result, {
      completed: false,
      counts: { total: 24, match: 1, mismatch: 0, unintelligible: 0, skip: 0 },
      retained: false,
    });
    assert.equal(retainCalled, false);
    assert.match(output, /"referenceReviewComplete":false/u);
    assert.doesNotMatch(output, /common_voice_ne-NP_|private synthetic transcript|clipManifestDigest/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('source, manifest, and loader mismatches fail before starting a review', async () => {
  const fixture = await privateManifestFile();
  const records = makeRecords('en');
  let started = false;
  const base = {
    archive: `/private/synthetic/${ARCHIVES.en.basename}`,
    locale: 'en', manifestPath: fixture.manifestPath, metadataRoot: fixture.metadataRoot,
    audioRoot: join(fixture.root, 'audio'),
  };
  try {
    await assert.rejects(runCommonVoiceReferenceReviewCli(cliArgs({ ...base, locale: 'hi' }), {
      loadReviewData: async () => { throw new Error('must not load unsupported locale'); },
    }), /locale must be en or ne-NP/u);
    await assert.rejects(runCommonVoiceReferenceReviewCli(cliArgs(base), {
      loadReviewData: async () => ({
        locale: 'en', sourceDatasetId: 'wrong', sourceRevision: REVISION, sourceSplit: 'test',
        clipManifestDigest: 'a'.repeat(64), records,
      }),
      startReview: async () => { started = true; return fakeSession({ total: 24, match: 24, mismatch: 0, unintelligible: 0, skip: 0 }); },
    }), /selected private test manifest/u);
    assert.equal(started, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('SIGINT during review-server startup closes the server and retains no outcome', async () => {
  const fixture = await privateManifestFile();
  const records = makeRecords('en');
  const counts = { total: 24, match: 0, mismatch: 0, unintelligible: 0, skip: 0 };
  let resolveStarted;
  let resolveSession;
  let closeCalled = false;
  let retained = false;
  let output = '';
  const startCalled = new Promise((resolve) => { resolveStarted = resolve; });
  try {
    const review = runCommonVoiceReferenceReviewCli(cliArgs({
      archive: `/private/synthetic/${ARCHIVES.en.basename}`,
      locale: 'en', manifestPath: fixture.manifestPath, metadataRoot: fixture.metadataRoot,
      audioRoot: join(fixture.root, 'audio'),
    }), {
      stdout: (line) => { output += line; },
      loadReviewData: async () => ({
        locale: 'en', sourceDatasetId: DATASETS.en, sourceRevision: REVISION, sourceSplit: 'test',
        clipManifestDigest: makePilotManifest().locales[0].clipManifestDigest, records,
      }),
      startReview: async () => {
        resolveStarted();
        return new Promise((resolve) => { resolveSession = resolve; });
      },
      retainReview: async () => { retained = true; },
    });
    await startCalled;
    process.emit('SIGINT');
    let resolveResult;
    const session = {
      url: 'http://127.0.0.1:44002/volatile-test-token/0',
      result: new Promise((resolve) => { resolveResult = resolve; }),
      close: async () => {
        closeCalled = true;
        resolveResult({ complete: false, counts });
      },
    };
    resolveSession(session);
    const result = await review;
    assert.deepEqual(result, { completed: false, counts, retained: false });
    assert.equal(closeCalled, true);
    assert.equal(retained, false);
    assert.doesNotMatch(output, /volatile-test-token/u);
    assert.equal(records.every((record) => record.sentence === '' && record.clipId === ''
      && record.audioBytes.length === 0), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('owner-only manifest reader rejects group-readable metadata', async () => {
  const fixture = await privateManifestFile();
  try {
    await chmod(fixture.manifestPath, 0o640);
    await assert.rejects(runCommonVoiceReferenceReviewCli(cliArgs({
      archive: `/private/synthetic/${ARCHIVES.en.basename}`,
      locale: 'en', manifestPath: fixture.manifestPath, metadataRoot: fixture.metadataRoot,
      audioRoot: join(fixture.root, 'audio'),
    }), { loadReviewData: async () => { throw new Error('must not load archive'); } }), /owner-only regular file/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
