import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { loadCommonVoiceReferenceReviewData } from './common-voice-pilot-manifest.mjs';
import { startCommonVoiceReferenceReview } from './common-voice-reference-review-ui.mjs';
import { retainCommonVoiceReferenceReviewMetadata } from './common-voice-ephemeral-run.mjs';

const REVISION = 'cv-corpus-27.0-2026-09-11';
const DATASETS = Object.freeze({ en: 'cmu5jplf300nwmh07iqvk9leo', 'ne-NP': 'cmu61478v00j9o107alzuue1z' });
const ARCHIVES = Object.freeze({
  en: Object.freeze({ basename: '1789502799671-cv-corpus-27.0-2026-09-11-en.tar.gz', bytes: 94956262763 }),
  'ne-NP': Object.freeze({ basename: '1789491018738-cv-corpus-27.0-2026-09-11-ne-NP.tar.gz', bytes: 42519359 }),
});
const MAX_MANIFEST_BYTES = 1024 * 1024;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function assert(condition, message) {
  if (!condition) throw new TypeError(message);
}

function requirePath(value, label) {
  assert(typeof value === 'string' && isAbsolute(value) && resolve(value) === value,
    `${label} must be an absolute normalized path`);
}

function exactKeys(value, expected, message) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), message);
  assert(Object.keys(value).sort().join(',') === [...expected].sort().join(','), message);
}

function validatePilotManifest(manifest) {
  exactKeys(manifest,
    ['schemaVersion', 'corpus', 'sourceRevision', 'sourceSplit', 'selection', 'locales', 'realInferenceAdmitted'],
    'private pilot manifest has an unexpected schema');
  assert(manifest.schemaVersion === '1.0.0'
    && manifest.corpus === 'Mozilla Common Voice Scripted Speech 27.0'
    && manifest.sourceRevision === REVISION && manifest.sourceSplit === 'test'
    && manifest.selection === 'sha256-rank-24-per-locale'
    && manifest.realInferenceAdmitted === false
    && Array.isArray(manifest.locales) && manifest.locales.length === 2,
  'private pilot manifest is not the pinned metadata-only test pilot');
  const byLocale = new Map();
  const localeKeys = ['locale', 'sourceDatasetId', 'sourceRevision', 'sourceSplit',
    'pilotSizePerLocale', 'clipManifestDigest', 'clipManifest', 'archive'];
  for (const locale of manifest.locales) {
    exactKeys(locale, localeKeys, 'pilot locale contains unapproved fields');
    assert(Object.hasOwn(DATASETS, locale.locale) && !byLocale.has(locale.locale)
      && locale.sourceDatasetId === DATASETS[locale.locale] && locale.sourceRevision === REVISION
      && locale.sourceSplit === 'test' && locale.pilotSizePerLocale === 24
      && Array.isArray(locale.clipManifest) && locale.clipManifest.length === 24
      && /^[0-9a-f]{64}$/u.test(locale.clipManifestDigest),
    'pilot locale does not match the pinned English/Nepali test profile');
    exactKeys(locale.archive,
      ['basename', 'localPath', 'sourceSizeBytes', 'localFileSizeBytes', 'localArchiveSha256', 'observationType'],
      'pilot archive observation contains unapproved fields');
    const archivePin = ARCHIVES[locale.locale];
    assert(locale.archive.basename === archivePin.basename
      && typeof locale.archive.localPath === 'string' && isAbsolute(locale.archive.localPath)
      && resolve(locale.archive.localPath) === locale.archive.localPath
      && basename(locale.archive.localPath) === archivePin.basename
      && locale.archive.sourceSizeBytes === archivePin.bytes
      && locale.archive.localFileSizeBytes === archivePin.bytes
      && /^[0-9a-f]{64}$/u.test(locale.archive.localArchiveSha256)
      && locale.archive.observationType === 'LOCAL_COMPRESSED_ARCHIVE_SHA256_NOT_PUBLISHER_HASH',
    'pilot archive observation does not match the pinned local archive');
    const seenIds = new Set();
    const seenHashes = new Set();
    for (const record of locale.clipManifest) {
      exactKeys(record,
        ['locale', 'sourceDatasetId', 'sourceRevision', 'sourceSplit', 'clipId', 'audioSha256'],
        'pilot clip contains unapproved fields');
      const prefix = locale.locale === 'en' ? /^common_voice_en_\d+\.mp3$/u : /^common_voice_ne-NP_\d+\.mp3$/u;
      assert(record.locale === locale.locale && record.sourceDatasetId === DATASETS[locale.locale]
        && record.sourceRevision === REVISION && record.sourceSplit === 'test'
        && prefix.test(record.clipId) && /^[0-9a-f]{64}$/u.test(record.audioSha256)
        && !seenIds.has(record.clipId) && !seenHashes.has(record.audioSha256),
      'pilot clip manifest contains an invalid or duplicate selection');
      seenIds.add(record.clipId);
      seenHashes.add(record.audioSha256);
    }
    const digest = createHash('sha256').update(JSON.stringify(locale.clipManifest)).digest('hex');
    assert(digest === locale.clipManifestDigest, 'pilot clip manifest digest is invalid');
    byLocale.set(locale.locale, locale);
  }
  assert(byLocale.has('en') && byLocale.has('ne-NP'), 'pilot manifest must pin en and ne-NP');
  return byLocale;
}

async function readOwnerOnlyPilotManifest(manifestPath, metadataRoot) {
  requirePath(manifestPath, 'pilot manifest');
  requirePath(metadataRoot, 'metadata root');
  assert(typeof process.getuid === 'function' && typeof fsConstants.O_NOFOLLOW === 'number',
    'owner-only manifest reads require POSIX uid and no-follow support');
  assert(basename(manifestPath) === 'pilot-manifest.json', 'manifest filename must be pilot-manifest.json');
  const uid = process.getuid();
  const root = resolve(metadataRoot);
  const rootStat = await lstat(root);
  assert(rootStat.isDirectory() && !rootStat.isSymbolicLink() && rootStat.uid === uid
    && (rootStat.mode & 0o777) === PRIVATE_DIR_MODE, 'metadata root must be current-user-owned mode 0700');
  const canonicalRoot = await realpath(root);
  const runDirectory = dirname(manifestPath);
  assert(dirname(runDirectory) === root && /^metadata-[0-9a-f-]{36}$/u.test(basename(runDirectory)),
    'manifest must be directly inside a retained metadata run directory');
  const runStat = await lstat(runDirectory);
  assert(runStat.isDirectory() && !runStat.isSymbolicLink() && runStat.uid === uid
    && (runStat.mode & 0o777) === PRIVATE_DIR_MODE && await realpath(runDirectory) === runDirectory
    && dirname(runDirectory) === canonicalRoot,
  'manifest run directory must be private and directly inside the metadata root');
  const before = await lstat(manifestPath);
  assert(before.isFile() && !before.isSymbolicLink() && before.uid === uid
    && (before.mode & 0o777) === PRIVATE_FILE_MODE && before.size > 0 && before.size <= MAX_MANIFEST_BYTES,
  'pilot manifest must be an owner-only regular file within the size bound');
  const handle = await open(manifestPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    assert(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino
      && opened.uid === uid && (opened.mode & 0o777) === PRIVATE_FILE_MODE
      && opened.size === before.size && opened.size <= MAX_MANIFEST_BYTES,
    'pilot manifest changed between lookup and open');
    const bytes = await handle.readFile();
    assert(bytes.length === opened.size && bytes.length <= MAX_MANIFEST_BYTES,
      'pilot manifest changed while it was read');
    const after = await handle.stat();
    assert(after.dev === opened.dev && after.ino === opened.ino && after.size === opened.size
      && after.uid === uid && (after.mode & 0o777) === PRIVATE_FILE_MODE
      && after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs,
    'pilot manifest changed while it was read');
    const manifest = JSON.parse(bytes.toString('utf8'));
    return Object.freeze({ manifest, byLocale: validatePilotManifest(manifest) });
  } finally {
    await handle.close();
  }
}

function parseArgs(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const values = {};
  const fields = new Map([
    ['--archive', 'archivePath'], ['--locale', 'locale'], ['--pilot-manifest', 'manifestPath'],
    ['--metadata-root', 'metadataRoot'], ['--audio-root', 'audioRoot'],
  ]);
  for (let i = 0; i < args.length; i += 1) {
    const name = fields.get(args[i]);
    assert(name && args[i + 1] && !args[i + 1].startsWith('--'), 'provide --archive, --locale, --pilot-manifest, --metadata-root, and --audio-root');
    assert(!Object.hasOwn(values, name), `duplicate argument ${args[i]}`);
    values[name] = args[++i];
  }
  assert(['archivePath', 'locale', 'manifestPath', 'metadataRoot', 'audioRoot']
    .every((field) => Object.hasOwn(values, field)),
  'provide --archive, --locale, --pilot-manifest, --metadata-root, and --audio-root');
  for (const field of ['archivePath', 'manifestPath', 'metadataRoot', 'audioRoot']) requirePath(values[field], field);
  assert(Object.hasOwn(DATASETS, values.locale), 'locale must be en or ne-NP');
  return Object.freeze(values);
}

function clearRecords(records) {
  for (const record of records ?? []) {
    if (Buffer.isBuffer(record.audioBytes)) record.audioBytes.fill(0);
    record.audioBytes = Buffer.alloc(0);
    record.sentence = '';
    record.clipId = '';
    record.audioSha256 = '';
  }
}

export async function runCommonVoiceReferenceReviewCli(argv, {
  stdout = (line) => process.stdout.write(line),
  now = () => new Date(),
  readManifest = readOwnerOnlyPilotManifest,
  loadReviewData = loadCommonVoiceReferenceReviewData,
  startReview = startCommonVoiceReferenceReview,
  retainReview = retainCommonVoiceReferenceReviewMetadata,
} = {}) {
  const args = parseArgs(argv);
  const { manifest, byLocale } = await readManifest(args.manifestPath, args.metadataRoot);
  const data = await loadReviewData({ archivePath: args.archivePath, locale: args.locale, pilotManifest: manifest });
  let session;
  let timeout;
  let interrupted = false;
  const onInterrupt = () => { interrupted = true; if (session) void session.close(); };
  process.once('SIGINT', onInterrupt);
  try {
    const pinnedLocale = byLocale.get(args.locale);
    assert(data.locale === args.locale && data.sourceDatasetId === DATASETS[args.locale]
      && data.sourceRevision === REVISION && data.sourceSplit === 'test'
      && data.clipManifestDigest === pinnedLocale.clipManifestDigest
      && Array.isArray(data.records) && data.records.length === 24,
    'archive loader result does not match the selected private test manifest');
    const expectedRecords = new Map(pinnedLocale.clipManifest.map((record) => [record.clipId, record.audioSha256]));
    assert(expectedRecords.size === data.records.length, 'private manifest contains duplicate selected clip IDs');
    for (const record of data.records) {
      assert(expectedRecords.get(record.clipId) === record.audioSha256
        && typeof record.sentence === 'string' && Buffer.isBuffer(record.audioBytes)
        && createHash('sha256').update(record.audioBytes).digest('hex') === record.audioSha256,
      'selected audio/reference record does not match the private manifest');
      expectedRecords.delete(record.clipId);
    }
    assert(expectedRecords.size === 0, 'archive loader omitted a private manifest record');

    session = await startReview(data.records, { locale: data.locale });
    if (interrupted) {
      await session.close();
    } else {
      stdout(`Open this local-only review page in a browser: ${session.url}\nPress Ctrl-C to stop; no result is retained unless all 24 clips are reviewed.\n`);
      timeout = setTimeout(() => { if (session) void session.close(); }, 60 * 60 * 1000);
      timeout.unref?.();
    }
    const result = await session.result;
    const checkedAt = now();
    assert(checkedAt instanceof Date && Number.isFinite(checkedAt.getTime()), 'review clock must return a valid Date');
    let retained = false;
    if (result.complete && !interrupted) {
      await retainReview(args.metadataRoot, args.audioRoot, {
        locale: data.locale,
        sourceDatasetId: data.sourceDatasetId,
        sourceRevision: data.sourceRevision,
        sourceSplit: data.sourceSplit,
        clipManifestDigest: data.clipManifestDigest,
        checkedAt: checkedAt.toISOString(),
        counts: result.counts,
        completed: true,
      }, { now: () => checkedAt });
      retained = true;
    }
    stdout(`${JSON.stringify({
      referenceReviewComplete: result.complete && !interrupted,
      locale: data.locale,
      sourceRevision: data.sourceRevision,
      sourceSplit: data.sourceSplit,
      counts: result.counts,
      aggregateRetainedInOwnerOnlyMetadata: retained,
      realInferenceAdmitted: false,
    })}\n`);
    return Object.freeze({ completed: result.complete && !interrupted, counts: Object.freeze({ ...result.counts }), retained });
  } finally {
    if (timeout) clearTimeout(timeout);
    process.removeListener('SIGINT', onInterrupt);
    try { await session?.close(); } finally { clearRecords(data.records); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCommonVoiceReferenceReviewCli(process.argv.slice(2)).catch((error) => {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/u.test(error.code) ? ` (${error.code})` : '';
    process.stderr.write(`Common Voice private reference review stopped${code}; no clip IDs, references, audio, or archive paths were written to output.\n`);
    process.exitCode = 1;
  });
}

export const COMMON_VOICE_REFERENCE_REVIEW_SOURCE = Object.freeze({
  sourceRevision: REVISION,
  officialTestSplit: 'test',
  clipsPerLocale: 24,
  locales: Object.freeze(Object.keys(DATASETS)),
});
