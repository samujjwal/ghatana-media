import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createGzip } from 'node:zlib';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, stat, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  COMMON_VOICE_PILOT_LIMITS,
  parseCommonVoicePilotArchive,
  loadCommonVoiceReferenceReviewData,
  prepareCommonVoicePilotManifest,
  runCommonVoicePilotCli,
} from '../scripts/qualification/common-voice-pilot-manifest.mjs';
import {
  cleanupExpiredCommonVoiceMetadataRuns,
  retainCommonVoicePilotMetadata,
} from '../scripts/qualification/common-voice-ephemeral-run.mjs';

const REVISION = 'cv-corpus-27.0-2026-09-11';
const DATASET_IDS = { en: 'cmu5jplf300nwmh07iqvk9leo', 'ne-NP': 'cmu61478v00j9o107alzuue1z' };
const ARCHIVE_NAMES = {
  en: '1789502799671-cv-corpus-27.0-2026-09-11-en.tar.gz',
  'ne-NP': '1789491018738-cv-corpus-27.0-2026-09-11-ne-NP.tar.gz',
};
const ROW_COUNTS = { en: 16403, 'ne-NP': 302 };
const ROOT = (locale) => `${REVISION}/${locale}/`;
function clipName(locale, i) { return `common_voice_${locale === 'en' ? 'en' : 'ne-NP'}_${String(i + 1).padStart(6, '0')}.mp3`; }
function clipRank(locale, clipId) { return createHash('sha256').update(`${REVISION}\0${locale}\0${clipId}`).digest('hex'); }

function tarMember(name, body, declaredSize = body.length) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${declaredSize.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

async function archive(locale = 'ne-NP', options = {}) {
  const {
    rowCount = ROW_COUNTS[locale], durations = {}, includeSelected = true,
    duplicate = false, unsupportedOrder = false, unsafePath = false,
    oversizedSelected = false, oversizedMember = false, oversizedDuration = false, split = 'test',
    sentenceForClip = () => 'private sentence',
  } = options;
  const root = await mkdtemp(join(tmpdir(), 'cv-pilot-'));
  const path = join(root, ARCHIVE_NAMES[locale]);
  const rows = ['client_id\tpath\tsentence_id\tsentence\tup_votes\tdown_votes\tage\tgender\taccents\tvariant\tlocale\tsegment\tsentence_domain'];
  const filenames = Array.from({ length: rowCount }, (_, i) => clipName(locale, i));
  for (const clip of filenames) rows.push(`private-client\t${clip}\tprivate-sentence-id\t${sentenceForClip(clip)}\t1\t0\t30\tunspecified\t\t\t${locale}\t\tgeneral`);
  const durationsRows = ['clip\tduration[ms]', ...filenames.map((clip) => `${clip}\t${durations[clip] ?? 1000}`)];
  const metadata = [
    tarMember(`${REVISION}/README.md`, Buffer.from('fixture README')),
    tarMember(`${ROOT(locale)}${split}.tsv`, Buffer.from(`${rows.join('\n')}\n`)),
    tarMember(`${ROOT(locale)}clip_durations.tsv`, oversizedDuration ? Buffer.alloc(0) : Buffer.from(`${durationsRows.join('\n')}\n`),
      oversizedDuration ? 96 * 1024 * 1024 + 1 : undefined),
  ];
  const selected = filenames.map((clipId) => ({ clipId, rank: clipRank(locale, clipId) }))
    .sort((a, b) => a.rank.localeCompare(b.rank) || a.clipId.localeCompare(b.clipId))
    .slice(0, 24).map(({ clipId }) => clipId);
  const audio = selected.flatMap((clipId, index) => {
    if (!includeSelected && index === selected.length - 1) return [];
    const oversized = oversizedSelected && index === 0;
    return [tarMember(`${ROOT(locale)}clips/${clipId}`,
      oversized ? Buffer.alloc(0) : Buffer.from(`audio:${clipId}`),
      oversized ? 120 * 1024 * 1024 + 1 : undefined)];
  });
  let members = unsupportedOrder ? [audio.shift(), ...metadata, ...audio] : [...metadata, ...audio];
  if (duplicate) members.push(tarMember(`${ROOT(locale)}clips/${selected[0]}`, Buffer.from('duplicate')));
  if (unsafePath) members.push(tarMember(`${ROOT(locale)}clips/../escape.mp3`, Buffer.from('bad')));
  if (oversizedMember) members.push(tarMember(`${ROOT(locale)}clips/huge.mp3`, Buffer.alloc(0), 8 * 1024 * 1024 * 1024 + 1));
  const tar = Buffer.concat([...members, Buffer.alloc(1024)]);
  const gzip = createGzip();
  const output = createWriteStream(path);
  gzip.pipe(output);
  gzip.end(tar);
  await once(output, 'close');
  return { root, path, locale, sizeBytes: (await stat(path)).size };
}

function fixturePin(fixture, overrides = {}) { return { basename: ARCHIVE_NAMES[fixture.locale], bytes: fixture.sizeBytes, ...overrides }; }
async function parseFixture(fixture, overrides, split = 'test') {
  return parseCommonVoicePilotArchive(fixture.path, fixture.locale, fixturePin(fixture, overrides), { split });
}
function makePilotManifest(split = 'test') {
  const locales = ['en', 'ne-NP'].map((locale) => {
    const clips = Array.from({ length: 24 }, (_, i) => ({
      locale, sourceDatasetId: DATASET_IDS[locale], sourceRevision: REVISION, sourceSplit: split,
      clipId: clipName(locale, i), audioSha256: createHash('sha256').update(`${locale}-${i}`).digest('hex'),
    }));
    const basename = ARCHIVE_NAMES[locale];
    return {
      locale, sourceDatasetId: DATASET_IDS[locale], sourceRevision: REVISION, sourceSplit: split,
      pilotSizePerLocale: 24, clipManifest: clips,
      clipManifestDigest: createHash('sha256').update(JSON.stringify(clips)).digest('hex'),
      archive: {
        basename, localPath: `/private/fixture/${basename}`,
        sourceSizeBytes: locale === 'en' ? 94956262763 : 42519359,
        localFileSizeBytes: locale === 'en' ? 94956262763 : 42519359,
        localArchiveSha256: createHash('sha256').update(locale).digest('hex'),
        observationType: 'LOCAL_COMPRESSED_ARCHIVE_SHA256_NOT_PUBLISHER_HASH',
      },
    };
  });
  return {
    schemaVersion: '1.0.0', corpus: 'Mozilla Common Voice Scripted Speech 27.0',
    sourceRevision: REVISION, sourceSplit: split, selection: 'sha256-rank-24-per-locale',
    locales, realInferenceAdmitted: false,
  };
}

test('streams synthetic test metadata and hashes the deterministic hash-ranked pilot', async () => {
  const fixture = await archive();
  try {
    const result = await parseFixture(fixture);
    assert.equal(result.clipManifest.length, 24);
    assert.equal(result.pilotSizePerLocale, 24);
    assert.equal(result.clipManifest.every((record) => record.locale === fixture.locale
      && record.sourceSplit === 'test' && /^[0-9a-f]{64}$/u.test(record.audioSha256)), true);
    const expectedSelectedFirst = Array.from({ length: ROW_COUNTS[fixture.locale] }, (_, i) => clipName(fixture.locale, i))
      .map((clipId) => ({ clipId, rank: clipRank(fixture.locale, clipId) }))
      .sort((a, b) => a.rank.localeCompare(b.rank) || a.clipId.localeCompare(b.clipId))
      .slice(0, 24).map(({ clipId }) => clipId).sort()[0];
    assert.equal(result.clipManifest[0].clipId, expectedSelectedFirst);
    assert.match(result.archive.localArchiveSha256, /^[0-9a-f]{64}$/u);
    assert.equal(result.archive.localArchiveSha256,
      createHash('sha256').update(await readFile(fixture.path)).digest('hex'));
    assert.equal(result.archive.observationType, 'LOCAL_COMPRESSED_ARCHIVE_SHA256_NOT_PUBLISHER_HASH');
    assert.equal(result.clipManifest.every((record) => !Object.hasOwn(record, 'sentence')
      && !Object.hasOwn(record, 'audioBytes')), true);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('reference review returns only manifest-selected test sentences and matching audio bytes', async () => {
  const fixture = await archive('ne-NP', { sentenceForClip: (clipId) => `private sentence:${clipId}` });
  try {
    const parsed = await parseFixture(fixture);
    const localeManifest = { ...parsed, sourceSplit: 'test' };
    const pilotManifest = { sourceRevision: REVISION, sourceSplit: 'test', locales: [localeManifest] };
    const result = await loadCommonVoiceReferenceReviewData({
      archivePath: fixture.path, locale: fixture.locale, pilotManifest, archivePin: fixturePin(fixture),
    });
    assert.equal(result.locale, fixture.locale);
    assert.equal(result.sourceSplit, 'test');
    assert.equal(result.records.length, 24);
    const selectedIds = new Set(localeManifest.clipManifest.map(({ clipId }) => clipId));
    const nonselectedSentences = new Set(Array.from({ length: ROW_COUNTS[fixture.locale] }, (_, i) => clipName(fixture.locale, i))
      .filter((clipId) => !selectedIds.has(clipId)).map((clipId) => `private sentence:${clipId}`));
    for (const record of result.records) {
      assert.equal(record.sentence, `private sentence:${record.clipId}`);
      assert.equal(nonselectedSentences.has(record.sentence), false);
      assert.equal(record.audioBytes.toString(), `audio:${record.clipId}`);
      assert.equal(record.audioSha256, createHash('sha256').update(record.audioBytes).digest('hex'));
      assert.equal(localeManifest.clipManifest.find((item) => item.clipId === record.clipId).audioSha256,
        record.audioSha256);
      assert.deepEqual(Object.keys(record).sort(), ['audioBytes', 'audioSha256', 'clipId', 'sentence']);
    }
    assert.equal(Object.hasOwn(result, 'archivePath'), false);
    assert.equal(Object.hasOwn(result, 'localArchiveSha256'), false);
    assert.equal(Object.isFrozen(result.records), false);
    for (const record of result.records) {
      record.audioBytes.fill(0);
      record.audioBytes = Buffer.alloc(0);
      record.sentence = '';
      record.clipId = '';
    }
    assert.equal(result.records.every((record) => record.sentence === '' && record.clipId === ''
      && record.audioBytes.length === 0), true);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('wipes selected audio buffers when post-parse archive observation comparison fails', async () => {
  const localeManifest = makePilotManifest().locales.find(({ locale }) => locale === 'ne-NP');
  const pilotManifest = { sourceRevision: REVISION, sourceSplit: 'test', locales: [localeManifest] };
  const captured = localeManifest.clipManifest.map(({ clipId, audioSha256 }) => ({
    clipId, sentence: `private sentence:${clipId}`, audioSha256, audioBytes: Buffer.from(`audio:${clipId}`),
  }));
  await assert.rejects(loadCommonVoiceReferenceReviewData({
    archivePath: '/private/fixture/archive.tar.gz', locale: 'ne-NP', pilotManifest,
  }, {
    parseArchive: async () => ({
      archiveObservation: {
        basename: 'mismatched-archive.tar.gz',
        localFileSizeBytes: localeManifest.archive.localFileSizeBytes,
        localArchiveSha256: localeManifest.archive.localArchiveSha256,
      },
      references: captured,
    }),
  }), /archive bytes do not match the private manifest archive observation/u);
  assert.equal(captured.every(({ audioBytes }) => audioBytes.every((byte) => byte === 0)), true);
});

test('reference review denies a manifest whose selected audio hash does not match', async () => {
  const fixture = await archive();
  try {
    const parsed = await parseFixture(fixture);
    const localeManifest = structuredClone(parsed);
    localeManifest.clipManifest[0].audioSha256 = 'f'.repeat(64);
    localeManifest.clipManifestDigest = createHash('sha256').update(JSON.stringify(localeManifest.clipManifest)).digest('hex');
    await assert.rejects(loadCommonVoiceReferenceReviewData({
      archivePath: fixture.path, locale: fixture.locale, archivePin: fixturePin(fixture),
      pilotManifest: { sourceRevision: REVISION, sourceSplit: 'test', locales: [localeManifest] },
    }), /SHA-256 does not match/u);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('prepares a separate 24-clip development manifest from dev.tsv with only approved fields', async () => {
  const fixture = await archive('ne-NP', { rowCount: 31, split: 'dev' });
  try {
    const result = await parseFixture(fixture, undefined, 'dev');
    assert.equal(result.sourceSplit, 'dev');
    assert.equal(result.clipManifest.length, 24);
    assert.equal(result.clipManifest.every((record) => record.sourceSplit === 'dev'
      && Object.keys(record).sort().join(',')
        === ['audioSha256', 'clipId', 'locale', 'sourceDatasetId', 'sourceRevision', 'sourceSplit'].sort().join(',')), true);
    await assert.rejects(parseFixture(fixture), /audio member encountered before both metadata TSVs/u);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

for (const [name, options, pattern] of [
  ['rejects an incorrect official test row count', { rowCount: 301 }, /row count mismatch/u],
  ['rejects a missing selected audio member', { includeSelected: false }, /selected audio members are missing/u],
  ['rejects duplicate selected tar member paths', { duplicate: true }, /duplicate official-test audio member path/u],
  ['rejects unsafe archive member paths', { unsafePath: true }, /unsafe tar member path/u],
  ['rejects audio encountered before both metadata tables', { unsupportedOrder: true }, /audio member encountered before both metadata TSVs/u],
  ['rejects a pilot audio total above 120 MiB before reading the member', { oversizedSelected: true }, /exceeds 120 MiB/u],
  ['rejects an oversized archive member before reading its body', { oversizedMember: true }, /per-member expanded-byte cap/u],
  ['rejects a duration table above the 96 MiB bound before reading it', { oversizedDuration: true }, /exceeds 96 MiB parsing bound/u],
  ['rejects a selected clip over 30 seconds', {
    durations: { [Array.from({ length: ROW_COUNTS['ne-NP'] }, (_, i) => clipName('ne-NP', i))
      .map((clipId) => ({ clipId, rank: clipRank('ne-NP', clipId) }))
      .sort((a, b) => a.rank.localeCompare(b.rank) || a.clipId.localeCompare(b.clipId))[0].clipId]: 30001 },
  }, /exceeds 30 seconds/u],
]) {
  test(name, async () => {
    const fixture = await archive('ne-NP', options);
    try { await assert.rejects(parseFixture(fixture), pattern); }
    finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
}

test('fails closed for unsupported locale', async () => {
  await assert.rejects(parseCommonVoicePilotArchive('/does/not/open', 'hi'), /unsupported Common Voice locale/u);
});

test('rejects symlink archive paths before opening their targets', async () => {
  const fixture = await archive();
  const aliasDirectory = join(fixture.root, 'alias');
  const aliasPath = join(aliasDirectory, ARCHIVE_NAMES[fixture.locale]);
  try {
    await mkdir(aliasDirectory);
    await symlink(fixture.path, aliasPath);
    await assert.rejects(parseCommonVoicePilotArchive(aliasPath, fixture.locale, fixturePin(fixture)),
      /regular non-symlink file/u);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('rejects an archive identity change between lstat and O_NOFOLLOW open', async () => {
  const fixture = await archive();
  try {
    const actual = await stat(fixture.path);
    const changedIdentity = {
      isFile: () => true,
      isSymbolicLink: () => false,
      dev: actual.dev,
      ino: actual.ino + 1,
      size: actual.size,
      uid: actual.uid,
    };
    await assert.rejects(parseCommonVoicePilotArchive(fixture.path, fixture.locale, fixturePin(fixture), {
      lstatArchive: async () => changedIdentity,
    }), /identity changed between lookup and open/u);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('enforces aggregate expanded-byte and archive-member-count caps before consuming member bodies', async () => {
  const fixture = await archive();
  try {
    await assert.rejects(parseFixture(fixture, { maxExpandedArchiveBytes: 1024 }), /aggregate expanded-byte cap/u);
    await assert.rejects(parseFixture(fixture, { maxArchiveMembers: 2 }), /member count exceeds safety bound/u);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('CLI prints aggregate-only output and does not expose archive paths', async () => {
  const secretEn = '/private/user-specific/path/secret-en.tar.gz';
  const secretNe = '/private/other/secret-ne.tar.gz';
  const metadataRoot = '/private/local/metadata';
  const audioRoot = '/private/local/audio';
  let output = '';
  let prepared;
  try {
    await runCommonVoicePilotCli([
      '--',
      '--en-archive', secretEn, '--ne-np-archive', secretNe,
      '--metadata-root', metadataRoot, '--audio-root', audioRoot,
    ], {
      prepare: async (options) => {
        prepared = options;
        return { localeCounts: { en: 24, 'ne-NP': 24 }, realInferenceAdmitted: false,
          retained: { directory: '/private/secret-metadata-location' } };
      },
      stdout: (line) => { output += line; },
    });
    assert.match(output, /"pilotPrepared":true/u);
    assert.match(output, /"en":24,"ne-NP":24/u);
    assert.doesNotMatch(output, /common_voice_|audioSha256|secret-en|secret-ne|secret-metadata-location/u);
    assert.deepEqual(prepared, {
      archives: { en: secretEn, 'ne-NP': secretNe }, metadataRoot, audioRoot, split: 'test',
    });
  } catch (error) {
    throw error;
  }
});

test('CLI accepts explicit dev split and emits split without private metadata', async () => {
  let output = '';
  let prepared;
  await runCommonVoicePilotCli([
    '--', '--en-archive', '/private/en.tar.gz', '--ne-np-archive', '/private/ne.tar.gz',
    '--metadata-root', '/private/metadata', '--audio-root', '/private/audio', '--split', 'dev',
  ], {
    prepare: async (options) => {
      prepared = options;
      return { localeCounts: { en: 24, 'ne-NP': 24 }, realInferenceAdmitted: false, retained: {} };
    },
    stdout: (line) => { output += line; },
  });
  assert.equal(prepared.split, 'dev');
  assert.match(output, /"sourceSplit":"dev"/u);
  assert.doesNotMatch(output, /common_voice_|audioSha256|\/private\//u);
});

test('prepares and retains the assembled two-locale manifest through the owner-only path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cv-pilot-prepare-retain-'));
  const metadataRoot = join(root, 'metadata');
  const audioRoot = join(root, 'audio');
  await mkdir(metadataRoot, { mode: 0o700 });
  await mkdir(audioRoot, { mode: 0o700 });
  await chmod(metadataRoot, 0o700);
  await chmod(audioRoot, 0o700);
  const archives = {
    en: `/private/downloads/${ARCHIVE_NAMES.en}`,
    'ne-NP': `/private/downloads/${ARCHIVE_NAMES['ne-NP']}`,
  };
  const sourceLocales = makePilotManifest('dev').locales;
  const observed = [];
  try {
    const result = await prepareCommonVoicePilotManifest({
      archives, metadataRoot, audioRoot,
      split: 'dev',
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    }, {
      parseArchive: async (path, locale) => {
        observed.push({ path, locale });
        const parsed = structuredClone(sourceLocales.find((item) => item.locale === locale));
        parsed.archive.localPath = path;
        return parsed;
      },
    });
    assert.deepEqual(observed, [
      { path: archives.en, locale: 'en' },
      { path: archives['ne-NP'], locale: 'ne-NP' },
    ]);
    assert.deepEqual(result.localeCounts, { en: 24, 'ne-NP': 24 });
    assert.equal(result.realInferenceAdmitted, false);
    assert.equal((await stat(result.retained.directory)).mode & 0o777, 0o700);
    const persisted = JSON.parse(await readFile(join(result.retained.directory, 'pilot-manifest.json'), 'utf8'));
    assert.deepEqual(persisted.locales.map((item) => item.locale), ['en', 'ne-NP']);
    assert.equal(persisted.realInferenceAdmitted, false);
    assert.equal(persisted.sourceSplit, 'dev');
    assert.equal(persisted.locales.every((item) => item.sourceSplit === 'dev'
      && item.clipManifest.every((record) => record.sourceSplit === 'dev')), true);
    assert.equal(persisted.locales.every((item) => item.clipManifest.length === 24), true);
    assert.match(await readFile(join(result.retained.directory, 'pilot-manifest.json'), 'utf8'),
      /localArchiveSha256/u);
    assert.doesNotMatch(await readFile(join(result.retained.directory, 'pilot-manifest.json'), 'utf8'),
      /private sentence|private-client|private-sentence-id|"sentence"|"age"|"gender"|"accents"/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('retention helper validates roots and expires a valid pilot at the exact 90-day boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cv-pilot-retention-'));
  const metadataRoot = join(root, 'metadata');
  const audioRoot = join(root, 'audio');
  await mkdir(metadataRoot, { mode: 0o700 });
  await mkdir(audioRoot, { mode: 0o700 });
  await chmod(metadataRoot, 0o700);
  await chmod(audioRoot, 0o700);
  const manifest = makePilotManifest('dev');
  try {
    await assert.rejects(retainCommonVoicePilotMetadata(metadataRoot, metadataRoot, manifest), /separate from and outside/u);
    const retained = await retainCommonVoicePilotMetadata(metadataRoot, audioRoot, manifest,
      { now: () => new Date('2026-01-01T00:00:00.000Z') });
    assert.equal((await stat(retained.directory)).mode & 0o777, 0o700);
    const files = await readdir(retained.directory);
    assert.deepEqual(files.sort(), ['.media-common-voice-metadata.json', 'pilot-manifest.json']);
    const manifestPath = join(retained.directory, 'pilot-manifest.json');
    assert.equal((await stat(manifestPath)).mode & 0o777, 0o600);
    const persisted = await readFile(manifestPath, 'utf8');
    assert.match(persisted, /localArchiveSha256/u);
    assert.doesNotMatch(persisted, /private sentence|private-client|private-sentence-id|"sentence"|"age"|"gender"|"accents"/u);
    const beforeBoundary = await cleanupExpiredCommonVoiceMetadataRuns(metadataRoot, audioRoot, { now: new Date('2026-03-31T23:59:59.999Z') });
    assert.deepEqual(beforeBoundary, { removed: 0, retained: 1, retentionDays: 90 });
    const boundary = await cleanupExpiredCommonVoiceMetadataRuns(metadataRoot, audioRoot, { now: new Date('2026-04-01T00:00:00.000Z') });
    assert.deepEqual(boundary, { removed: 1, retained: 0, retentionDays: 90 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('pilot cleanup preserves malformed locale schemas, duplicates, unsafe IDs, and bad digests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cv-pilot-invalid-retention-'));
  const metadataRoot = join(root, 'metadata');
  const audioRoot = join(root, 'audio');
  await mkdir(metadataRoot, { mode: 0o700 });
  await mkdir(audioRoot, { mode: 0o700 });
  await chmod(metadataRoot, 0o700);
  await chmod(audioRoot, 0o700);
  const mutations = [
    (pilot) => { pilot.locales[1].locale = 'en'; },
    (pilot) => { pilot.locales[0].unexpected = 'field'; },
    (pilot) => { pilot.locales[0].clipManifestDigest = 'f'.repeat(64); },
    (pilot) => { pilot.locales[0].clipManifest[0].clipId = 'unsafe-id.mp3'; },
    (pilot) => { pilot.locales[0].archive.localFileSizeBytes = 1234; },
    (pilot) => { pilot.locales[0].archive.localPath = '/private/elsewhere/../fixture/' + ARCHIVE_NAMES.en; },
    (pilot) => { pilot.transcript = 'private'; },
  ];
  try {
    for (const [index, mutate] of mutations.entries()) {
      const runId = `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      const directory = join(metadataRoot, `metadata-${runId}`);
      await mkdir(directory, { mode: 0o700 });
      await chmod(directory, 0o700);
      const manifest = makePilotManifest();
      mutate(manifest);
      await writeFile(join(directory, 'pilot-manifest.json'), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
      await writeFile(join(directory, '.media-common-voice-metadata.json'), `${JSON.stringify({
        kind: 'ghatana-media-common-voice-retained-metadata', schemaVersion: '1.0.0', runId,
        createdAt: '2026-01-01T00:00:00.000Z',
      })}\n`, { mode: 0o600 });
    }
    const result = await cleanupExpiredCommonVoiceMetadataRuns(metadataRoot, audioRoot, { now: new Date('2026-12-01T00:00:00.000Z') });
    assert.deepEqual(result, { removed: 0, retained: mutations.length, retentionDays: 90 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('pilot limits are explicit and bounded', () => {
  assert.deepEqual(COMMON_VOICE_PILOT_LIMITS, {
    clipsPerLocale: 24,
    maxSelectedAudioBytes: 120 * 1024 * 1024,
    maxTestTsvBytes: 16 * 1024 * 1024,
    maxDurationTsvBytes: 96 * 1024 * 1024,
    maxDurationRows: 5000000,
    maxArchiveMemberBytes: 8 * 1024 * 1024 * 1024,
    maxExpandedArchiveBytes: 256 * 1024 * 1024 * 1024,
    maxArchiveMembers: 5000000,
  });
});
