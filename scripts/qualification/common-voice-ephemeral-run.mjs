import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

const MARKER_NAME = '.media-common-voice-run.json';
const MARKER_KIND = 'ghatana-media-common-voice-ephemeral-run';
const RUN_PREFIX = 'run-';
const MAX_INTERRUPTED_AUDIO_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_MARKER_BYTES = 4096;
const METADATA_PREFIX = 'metadata-';
const METADATA_MARKER_NAME = '.media-common-voice-metadata.json';
const METADATA_MARKER_KIND = 'ghatana-media-common-voice-retained-metadata';
const METADATA_SCHEMA_VERSION = '1.0.0';
const METADATA_RETENTION_DAYS = 90;
const METADATA_RETENTION_MS = METADATA_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_METADATA_RUN_BYTES = 16 * 1024 * 1024;
const COMMON_VOICE_V27_REVISION = 'cv-corpus-27.0-2026-09-11';
const COMMON_VOICE_V27_DATASET_IDS = Object.freeze({
  en: 'cmu5jplf300nwmh07iqvk9leo',
  'ne-NP': 'cmu61478v00j9o107alzuue1z',
});
const COMMON_VOICE_V27_TEST_CLIP_COUNTS = Object.freeze({ en: 16403, 'ne-NP': 302 });
const CLIP_MANIFEST_FIELDS = Object.freeze([
  'locale', 'sourceDatasetId', 'sourceRevision', 'sourceSplit', 'clipId', 'audioSha256',
]);
const RUN_MANIFEST_FIELDS = Object.freeze([
  'locale', 'sourceDatasetId', 'sourceRevision', 'sourceSplit',
  'clipManifestDigest', 'modelDigest', 'host', 'clipManifest',
]);
const AGGREGATE_FIELDS = Object.freeze([
  'locale', 'sourceDatasetId', 'sourceRevision', 'sourceSplit',
  'clipManifestDigest', 'modelDigest', 'host', 'wer', 'cer',
]);
const ACTIVE_RUN_DIRECTORIES = new Set();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function supportedOwnerOnlyHost() {
  return typeof process.getuid === 'function'
    && typeof fsConstants.O_NOFOLLOW === 'number';
}

function currentUid() {
  assert(supportedOwnerOnlyHost(), 'owner-only Common Voice temp storage requires POSIX uid and no-follow support');
  return process.getuid();
}

function isMode(stat, expected) {
  return (stat.mode & 0o777) === expected;
}

async function requirePrivateDirectory(path, { ownerUid = currentUid(), mode = 0o700 } = {}) {
  assert(typeof path === 'string' && path.trim() !== '' && isAbsolute(path),
    'ephemeral root path must be explicit and absolute');
  const absolute = resolve(path);
  const stat = await lstat(absolute);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'ephemeral root must be a real directory');
  assert(stat.uid === ownerUid, 'ephemeral root must be owned by the current OS user');
  assert(isMode(stat, mode), `ephemeral root must have owner-only ${mode.toString(8)} permissions`);
  const canonical = await realpath(absolute);
  // The final root component itself was lstat-checked above. Parent aliases
  // such as macOS /tmp -> /private/tmp are accepted after canonicalization.
  return canonical;
}

function isWithinDirectory(root, path) {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === '' || (pathFromRoot !== '..'
    && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot));
}

async function requireSeparatePrivateRoots(metadataRootPath, audioRootPath, ownerUid) {
  const metadataRoot = await requirePrivateDirectory(metadataRootPath, { ownerUid, mode: 0o700 });
  const audioRoot = await requirePrivateDirectory(audioRootPath, { ownerUid, mode: 0o700 });
  assert(!isWithinDirectory(metadataRoot, audioRoot) && !isWithinDirectory(audioRoot, metadataRoot),
    'metadata root must be separate from and outside the ephemeral audio root');
  return metadataRoot;
}

function exactKeys(value, expected, message) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), message);
  const keys = Object.keys(value).sort();
  assert(keys.join(',') === [...expected].sort().join(','), message);
}

function requiredText(value, field, maxLength = 512) {
  assert(typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/u.test(value), `${field} is invalid`);
}

function validateClipRecord(record, manifest) {
  exactKeys(record, CLIP_MANIFEST_FIELDS, 'clip record must contain exactly the approved fields');
  assert(record.locale === manifest.locale
    && record.sourceDatasetId === manifest.sourceDatasetId
    && record.sourceRevision === COMMON_VOICE_V27_REVISION
    && record.sourceSplit === manifest.sourceSplit, 'clip record does not match the pinned v27 source');
  requiredText(record.clipId, 'clipId', 256);
  assert(typeof record.audioSha256 === 'string' && /^[0-9a-f]{64}$/u.test(record.audioSha256),
    'clip audioSha256 must be a lowercase SHA-256 digest');
}

function deterministicClipManifestDigest(rows) {
  const canonicalRows = rows.map((record) => Object.fromEntries(
    CLIP_MANIFEST_FIELDS.map((field) => [field, record[field]]),
  ));
  return createHash('sha256').update(JSON.stringify(canonicalRows), 'utf8').digest('hex');
}

function validateRunManifest(manifest) {
  exactKeys(manifest, RUN_MANIFEST_FIELDS, 'run manifest must contain exactly the approved fields');
  assert(Object.hasOwn(COMMON_VOICE_V27_DATASET_IDS, manifest.locale)
    && manifest.sourceDatasetId === COMMON_VOICE_V27_DATASET_IDS[manifest.locale]
    && manifest.sourceRevision === COMMON_VOICE_V27_REVISION
    && manifest.sourceSplit === 'test', 'run manifest does not match a pinned v27 test dataset');
  assert(typeof manifest.clipManifestDigest === 'string'
    && /^[0-9a-f]{64}$/u.test(manifest.clipManifestDigest),
  'clipManifestDigest must be a lowercase SHA-256 digest');
  assert(typeof manifest.modelDigest === 'string' && /^[0-9a-f]{64}$/u.test(manifest.modelDigest),
    'modelDigest must be a lowercase SHA-256 digest');
  requiredText(manifest.host, 'host');
  assert(Array.isArray(manifest.clipManifest) && manifest.clipManifest.length > 0,
    'clipManifest must contain at least one selected test clip');
  assert(manifest.clipManifest.length <= COMMON_VOICE_V27_TEST_CLIP_COUNTS[manifest.locale],
    'clipManifest exceeds the pinned v27 test-split count');
  const seenClipIds = new Set();
  const seenAudioHashes = new Set();
  for (const record of manifest.clipManifest) {
    validateClipRecord(record, manifest);
    assert(!seenClipIds.has(record.clipId), 'clipManifest contains duplicate clip IDs');
    assert(!seenAudioHashes.has(record.audioSha256), 'clipManifest contains duplicate audio hashes');
    seenClipIds.add(record.clipId);
    seenAudioHashes.add(record.audioSha256);
  }
  assert(manifest.clipManifestDigest === deterministicClipManifestDigest(manifest.clipManifest),
    'clipManifestDigest does not match the canonical pinned clip rows');
}

function validateAggregate(aggregate, manifest) {
  exactKeys(aggregate, AGGREGATE_FIELDS, 'aggregate must contain only scoped dimensions and WER/CER');
  for (const field of ['locale', 'sourceDatasetId', 'sourceRevision', 'sourceSplit',
    'clipManifestDigest', 'modelDigest', 'host']) {
    assert(aggregate[field] === manifest[field], `aggregate ${field} does not match its run manifest`);
  }
  for (const metric of ['wer', 'cer']) {
    assert(typeof aggregate[metric] === 'number' && Number.isFinite(aggregate[metric])
      && aggregate[metric] >= 0, `${metric} must be a finite nonnegative aggregate`);
  }
}

const PILOT_ARCHIVE_PINS = Object.freeze({
  en: Object.freeze({ basename: '1789502799671-cv-corpus-27.0-2026-09-11-en.tar.gz', sizeBytes: 94956262763 }),
  'ne-NP': Object.freeze({ basename: '1789491018738-cv-corpus-27.0-2026-09-11-ne-NP.tar.gz', sizeBytes: 42519359 }),
});
const PILOT_LOCALE_FIELDS = Object.freeze([
  'locale', 'sourceDatasetId', 'sourceRevision', 'sourceSplit', 'pilotSizePerLocale',
  'clipManifestDigest', 'clipManifest', 'archive',
]);

function validateCommonVoicePilotManifest(pilot) {
  exactKeys(pilot, ['schemaVersion', 'corpus', 'sourceRevision', 'sourceSplit', 'selection', 'locales', 'realInferenceAdmitted'],
    'pilot manifest contains unexpected fields');
  assert(pilot.schemaVersion === '1.0.0'
    && pilot.corpus === 'Mozilla Common Voice Scripted Speech 27.0'
    && pilot.sourceRevision === COMMON_VOICE_V27_REVISION
    && ['test', 'dev'].includes(pilot.sourceSplit)
    && pilot.selection === 'sha256-rank-24-per-locale'
    && pilot.realInferenceAdmitted === false
    && Array.isArray(pilot.locales) && pilot.locales.length === 2,
  'pilot manifest identity or admission state is invalid');
  const seenLocales = new Set();
  const forbidden = new Set(['clientid', 'speakerid', 'sentence', 'sentenceid', 'sentencedomain', 'transcript', 'prediction', 'age', 'gender', 'accents', 'variant']);
  const inspect = (value) => {
    if (Array.isArray(value)) return value.forEach(inspect);
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert(!forbidden.has(key.toLowerCase().replace(/[^a-z0-9]/gu, '')),
        'pilot manifest contains a forbidden source field');
      inspect(child);
    }
  };
  inspect(pilot);
  for (const locale of pilot.locales) {
    exactKeys(locale, PILOT_LOCALE_FIELDS, 'pilot locale record has unexpected fields');
    assert(['en', 'ne-NP'].includes(locale.locale) && !seenLocales.has(locale.locale),
      'pilot manifest has an unsupported or duplicate locale');
    seenLocales.add(locale.locale);
    assert(locale.sourceDatasetId === COMMON_VOICE_V27_DATASET_IDS[locale.locale]
      && locale.sourceRevision === COMMON_VOICE_V27_REVISION && locale.sourceSplit === pilot.sourceSplit
      && locale.pilotSizePerLocale === 24 && Array.isArray(locale.clipManifest)
      && locale.clipManifest.length === 24
      && /^[0-9a-f]{64}$/u.test(locale.clipManifestDigest),
    'pilot manifest locale scope is invalid');
    exactKeys(locale.archive, ['basename', 'localPath', 'sourceSizeBytes', 'localFileSizeBytes', 'localArchiveSha256', 'observationType'],
      'pilot archive observation has unexpected fields');
    assert(locale.archive.basename === PILOT_ARCHIVE_PINS[locale.locale].basename
      && typeof locale.archive.localPath === 'string' && locale.archive.localPath.length <= 4096
      && !/[\u0000-\u001f\u007f]/u.test(locale.archive.localPath)
      && isAbsolute(locale.archive.localPath) && resolve(locale.archive.localPath) === locale.archive.localPath
      && basename(locale.archive.localPath) === locale.archive.basename
      && locale.archive.sourceSizeBytes === PILOT_ARCHIVE_PINS[locale.locale].sizeBytes
      && locale.archive.localFileSizeBytes === PILOT_ARCHIVE_PINS[locale.locale].sizeBytes
      && locale.archive.observationType === 'LOCAL_COMPRESSED_ARCHIVE_SHA256_NOT_PUBLISHER_HASH'
      && /^[0-9a-f]{64}$/u.test(locale.archive.localArchiveSha256),
    'pilot archive observation does not match the pinned local source');
    const ids = new Set();
    const hashes = new Set();
    for (const record of locale.clipManifest) {
      validateClipRecord(record, locale);
      const prefix = locale.locale === 'en' ? 'common_voice_en_' : 'common_voice_ne-NP_';
      assert(new RegExp(`^${prefix}\\d+\\.mp3$`, 'u').test(record.clipId), 'pilot clip ID is unsafe for this locale');
      assert(!ids.has(record.clipId) && !hashes.has(record.audioSha256),
        'pilot manifest has duplicate clip IDs or audio hashes');
      ids.add(record.clipId);
      hashes.add(record.audioSha256);
    }
    assert(locale.clipManifestDigest === deterministicClipManifestDigest(locale.clipManifest),
      'pilot manifest digest does not match canonical clip rows');
  }
  assert(seenLocales.has('en') && seenLocales.has('ne-NP'), 'pilot manifest must contain exactly en and ne-NP');
}

function canonicalJson(value) {
  return `${JSON.stringify(value)}\n`;
}

async function writeAtomicOwnerOnlyJson(directory, name, value, maxBytes = MAX_METADATA_BYTES) {
  const bytes = Buffer.from(canonicalJson(value), 'utf8');
  assert(bytes.length <= maxBytes, `${name} exceeds the permitted size`);
  const temporaryPath = join(directory, `.${name}.${randomUUID()}.tmp`);
  const finalPath = join(directory, name);
  const handle = await open(temporaryPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, finalPath);
    const stat = await lstat(finalPath);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === currentUid() && isMode(stat, 0o600),
      `${name} did not receive owner-only file permissions`);
  } catch (failure) {
    await unlink(temporaryPath).catch(() => {});
    throw failure;
  }
}

async function readBoundedOwnerOnlyJson(directory, name, expectedUid, maxBytes = MAX_METADATA_BYTES) {
  const filePath = join(directory, name);
  const stat = await lstat(filePath);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === expectedUid && isMode(stat, 0o600)
    && stat.size > 0 && stat.size <= maxBytes, `${name} is missing or unsafe`);
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const openedStat = await handle.stat();
    assert(openedStat.isFile() && openedStat.uid === expectedUid && isMode(openedStat, 0o600)
      && openedStat.size > 0 && openedStat.size <= maxBytes, `${name} changed or is unsafe`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    assert(total <= maxBytes, `${name} exceeds the permitted size`);
    const bytes = buffer.subarray(0, total);
    const value = JSON.parse(bytes.toString('utf8'));
    assert(bytes.equals(Buffer.from(canonicalJson(value), 'utf8')), `${name} is not canonical JSON`);
    return value;
  } finally {
    await handle.close();
  }
}

/** Reads at most one byte beyond the marker limit so overflow can be detected. */
export async function readBoundedMarkerBytes(handle) {
  const buffer = Buffer.alloc(MAX_MARKER_BYTES + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  assert(total <= MAX_MARKER_BYTES, 'run marker exceeds the permitted size');
  return buffer.subarray(0, total);
}

async function readMarker(runDirectory, expectedUid) {
  const markerPath = join(runDirectory, MARKER_NAME);
  const stat = await lstat(markerPath);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'run marker must be a regular non-symlink file');
  assert(stat.uid === expectedUid && isMode(stat, 0o600), 'run marker must be owner-only');
  assert(stat.size > 0, 'run marker size is invalid');

  const handle = await open(markerPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const openedStat = await handle.stat();
    assert(openedStat.isFile() && openedStat.uid === expectedUid && isMode(openedStat, 0o600)
      && openedStat.size > 0,
    'opened run marker changed or is unsafe');
    const bytes = await readBoundedMarkerBytes(handle);
    const marker = JSON.parse(bytes.toString('utf8'));
    const expectedKeys = ['createdAt', 'kind', 'runId', 'schemaVersion'];
    assert(Object.keys(marker).sort().join(',') === expectedKeys.join(','),
      'run marker contains unexpected persisted data');
    assert(bytes.equals(Buffer.from(`${JSON.stringify(marker)}\n`, 'utf8')),
      'run marker encoding is not canonical');
    assert(marker.kind === MARKER_KIND && marker.schemaVersion === '1.0.0', 'run marker identity is invalid');
    assert(typeof marker.runId === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(marker.runId),
    'run marker ID is invalid');
    assert(typeof marker.createdAt === 'string'
      && Number.isFinite(Date.parse(marker.createdAt))
      && new Date(marker.createdAt).toISOString() === marker.createdAt,
      'run marker timestamp is invalid');
    return marker;
  } finally {
    await handle.close();
  }
}

async function removeOwnedRun(root, runDirectory, expectedUid) {
  const absolute = resolve(runDirectory);
  assert(dirname(absolute) === root, 'refusing to remove a path outside the configured root');
  const stat = await lstat(absolute);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === expectedUid,
    'run directory ownership or type changed; refusing cleanup');
  const canonical = await realpath(absolute);
  assert(canonical === absolute, 'run directory path changed through a symlink');
  await chmod(absolute, 0o700);
  // fs.rm unlinks nested symlinks instead of following their targets.
  await rm(absolute, { recursive: true, force: false, maxRetries: 0 });
}

/**
 * Creates one owner-only scratch directory and removes it on every normal or
 * exceptional callback exit. This helper does not grant dataset access or
 * authorize model inference; callers must obtain those independently. The
 * ephemeral root must be process-exclusive while an evaluation is live: the
 * in-memory active-run guard protects cleanup in this Node process only and
 * does not coordinate another same-UID process using the same root.
 */
export async function withEphemeralCommonVoiceRun(rootPath, callback, { now = () => new Date() } = {}) {
  assert(typeof callback === 'function', 'run callback is required');
  const uid = currentUid();
  const root = await requirePrivateDirectory(rootPath, { ownerUid: uid, mode: 0o700 });
  const runId = randomUUID();
  const runDirectory = join(root, `${RUN_PREFIX}${runId}`);
  const createdAt = now();
  assert(createdAt instanceof Date && Number.isFinite(createdAt.getTime()), 'run clock must return a valid Date');
  await mkdir(runDirectory, { mode: 0o700 });
  try {
    await chmod(runDirectory, 0o700);
    const runStat = await lstat(runDirectory);
    assert(runStat.isDirectory() && !runStat.isSymbolicLink() && runStat.uid === uid && isMode(runStat, 0o700),
      'created run directory did not receive owner-only permissions');

    const marker = {
      kind: MARKER_KIND,
      schemaVersion: '1.0.0',
      runId,
      createdAt: createdAt.toISOString(),
    };
    const markerPath = join(runDirectory, MARKER_NAME);
    const markerHandle = await open(markerPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try {
      await markerHandle.chmod(0o600);
      await markerHandle.writeFile(`${JSON.stringify(marker)}\n`, 'utf8');
      await markerHandle.sync();
    } finally {
      await markerHandle.close();
    }
  } catch (setupFailure) {
    try {
      await removeOwnedRun(root, runDirectory, uid);
    } catch (cleanupFailure) {
      throw new AggregateError([setupFailure, cleanupFailure],
        'ephemeral run setup failed and its private directory could not be removed');
    }
    throw setupFailure;
  }

  ACTIVE_RUN_DIRECTORIES.add(resolve(runDirectory));
  let result;
  let callbackFailure;
  let callbackFailed = false;
  try {
    result = await callback(runDirectory);
  } catch (failure) {
    callbackFailed = true;
    callbackFailure = failure;
  }

  try {
    await removeOwnedRun(root, runDirectory, uid);
  } catch (cleanupFailure) {
    ACTIVE_RUN_DIRECTORIES.delete(resolve(runDirectory));
    if (callbackFailed) {
      throw new AggregateError([callbackFailure, cleanupFailure],
        'run failed and ephemeral audio cleanup could not be confirmed');
    }
    throw cleanupFailure;
  }
  ACTIVE_RUN_DIRECTORIES.delete(resolve(runDirectory));
  if (callbackFailed) throw callbackFailure;
  return result;
}

/**
 * Removes only expired run directories created by this helper. Unknown,
 * malformed, future-dated, fresh, or symlinked entries remain untouched.
 */
export async function cleanupExpiredCommonVoiceRuns(rootPath, { now = new Date() } = {}) {
  const uid = currentUid();
  const root = await requirePrivateDirectory(rootPath, { ownerUid: uid, mode: 0o700 });
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  assert(Number.isFinite(nowMs), 'cleanup clock must be finite');
  let removed = 0;
  let retained = 0;
  const directory = await opendir(root);
  for await (const entry of directory) {
    if (!entry.name.startsWith(RUN_PREFIX)) {
      retained += 1;
      continue;
    }
    const match = /^run-([0-9a-f-]{36})$/u.exec(entry.name);
    if (!match || !entry.isDirectory()) {
      retained += 1;
      continue;
    }
    const runDirectory = join(root, entry.name);
    if (ACTIVE_RUN_DIRECTORIES.has(resolve(runDirectory))) {
      retained += 1;
      continue;
    }
    try {
      const stat = await lstat(runDirectory);
      assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid && isMode(stat, 0o700),
        'run directory is unsafe');
      const marker = await readMarker(runDirectory, uid);
      assert(marker.runId === match[1], 'run marker ID does not match directory name');
      const createdAt = Date.parse(marker.createdAt);
      const age = nowMs - createdAt;
      if (age < MAX_INTERRUPTED_AUDIO_AGE_MS || age < 0) {
        retained += 1;
        continue;
      }
      await removeOwnedRun(root, runDirectory, uid);
      removed += 1;
    } catch {
      // Invalid or raced entries are preserved for operator review.
      retained += 1;
    }
  }
  return Object.freeze({ removed, retained, maxInterruptedAgeHours: 24 });
}

/**
 * Stores only the pinned source manifest dimensions and aggregate WER/CER in an
 * explicit owner-only metadata root, separate from ephemeral audio scratch.
 * This is retention plumbing only; it does not admit dataset access or prove a
 * quality/acceptance result.
 */
export async function retainCommonVoiceRunMetadata(
  metadataRootPath,
  ephemeralAudioRootPath,
  { runManifest, aggregate },
  { now = () => new Date() } = {},
) {
  const ownerUid = currentUid();
  const metadataRoot = await requireSeparatePrivateRoots(
    metadataRootPath, ephemeralAudioRootPath, ownerUid);
  const createdAt = now();
  assert(createdAt instanceof Date && Number.isFinite(createdAt.getTime()),
    'metadata retention clock must return a valid Date');

  // Snapshot the caller values before the first async write so validation and
  // persisted bytes refer to exactly the same JSON values.
  const manifestSnapshot = JSON.parse(canonicalJson(runManifest));
  const aggregateSnapshot = JSON.parse(canonicalJson(aggregate));
  validateRunManifest(manifestSnapshot);
  validateAggregate(aggregateSnapshot, manifestSnapshot);

  const runId = randomUUID();
  const marker = {
    kind: METADATA_MARKER_KIND,
    schemaVersion: METADATA_SCHEMA_VERSION,
    runId,
    createdAt: createdAt.toISOString(),
  };
  const totalBytes = [manifestSnapshot, aggregateSnapshot, marker]
    .reduce((total, value) => total + Buffer.byteLength(canonicalJson(value), 'utf8'), 0);
  assert(totalBytes <= MAX_METADATA_RUN_BYTES,
    'metadata run exceeds the permitted total size');
  const runDirectory = join(metadataRoot, `${METADATA_PREFIX}${runId}`);
  await mkdir(runDirectory, { mode: 0o700 });
  try {
    await chmod(runDirectory, 0o700);
    const directoryStat = await lstat(runDirectory);
    assert(directoryStat.isDirectory() && !directoryStat.isSymbolicLink()
      && directoryStat.uid === ownerUid && isMode(directoryStat, 0o700),
    'created metadata directory did not receive owner-only permissions');

    await writeAtomicOwnerOnlyJson(runDirectory, 'run-manifest.json', manifestSnapshot);
    await writeAtomicOwnerOnlyJson(runDirectory, 'aggregate.json', aggregateSnapshot);
    // The marker is the commit point. Cleanup ignores directories without this
    // exact marker, so interrupted writes are preserved for operator review.
    await writeAtomicOwnerOnlyJson(runDirectory, METADATA_MARKER_NAME, marker, MAX_MARKER_BYTES);
  } catch (failure) {
    try {
      await removeOwnedRun(metadataRoot, runDirectory, ownerUid);
    } catch (cleanupFailure) {
      throw new AggregateError([failure, cleanupFailure],
        'metadata write failed and its owner-only directory could not be removed');
    }
    throw failure;
  }
  return Object.freeze({ runId, createdAt: createdAt.toISOString(), directory: runDirectory });
}

/** Retains a metadata-only pilot manifest under the same owner-only 90-day policy. */
export async function retainCommonVoicePilotMetadata(
  metadataRootPath,
  ephemeralAudioRootPath,
  pilotManifest,
  { now = () => new Date() } = {},
) {
  const ownerUid = currentUid();
  const metadataRoot = await requireSeparatePrivateRoots(metadataRootPath, ephemeralAudioRootPath, ownerUid);
  const createdAt = now();
  assert(createdAt instanceof Date && Number.isFinite(createdAt.getTime()), 'pilot retention clock must return a valid Date');
  const snapshot = JSON.parse(canonicalJson(pilotManifest));
  validateCommonVoicePilotManifest(snapshot);
  const runId = randomUUID();
  const runDirectory = join(metadataRoot, `${METADATA_PREFIX}${runId}`);
  const marker = { kind: METADATA_MARKER_KIND, schemaVersion: METADATA_SCHEMA_VERSION, runId, createdAt: createdAt.toISOString() };
  assert(Buffer.byteLength(canonicalJson(snapshot), 'utf8') + Buffer.byteLength(canonicalJson(marker), 'utf8')
    <= MAX_METADATA_RUN_BYTES, 'pilot metadata exceeds the permitted total size');
  await mkdir(runDirectory, { mode: 0o700 });
  try {
    await chmod(runDirectory, 0o700);
    const stat = await lstat(runDirectory);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === ownerUid && isMode(stat, 0o700),
      'created pilot metadata directory is unsafe');
    await writeAtomicOwnerOnlyJson(runDirectory, 'pilot-manifest.json', snapshot, 1024 * 1024);
    await writeAtomicOwnerOnlyJson(runDirectory, METADATA_MARKER_NAME, marker, MAX_MARKER_BYTES);
  } catch (failure) {
    try {
      await removeOwnedRun(metadataRoot, runDirectory, ownerUid);
    } catch (cleanupFailure) {
      throw new AggregateError([failure, cleanupFailure],
        'pilot metadata write failed and its owner-only directory could not be removed');
    }
    throw failure;
  }
  return Object.freeze({ runId, createdAt: createdAt.toISOString(), directory: runDirectory });
}

/**
 * Removes only valid helper-owned v27 metadata after the exact 90-day retention
 * period. This enforces persistence duration only; it grants no access and
 * establishes no consent, quality, or acceptance authority.
 */
export async function cleanupExpiredCommonVoiceMetadataRuns(
  metadataRootPath,
  ephemeralAudioRootPath,
  { now = new Date() } = {},
) {
  const ownerUid = currentUid();
  const metadataRoot = await requireSeparatePrivateRoots(
    metadataRootPath, ephemeralAudioRootPath, ownerUid);
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  assert(Number.isFinite(nowMs), 'metadata cleanup clock must be finite');
  let removed = 0;
  let retained = 0;
  const runEntriesExpected = [METADATA_MARKER_NAME, 'aggregate.json', 'run-manifest.json'].sort();
  const pilotEntriesExpected = [METADATA_MARKER_NAME, 'pilot-manifest.json'].sort();
  const directory = await opendir(metadataRoot);
  for await (const entry of directory) {
    if (!entry.name.startsWith(METADATA_PREFIX)) {
      retained += 1;
      continue;
    }
    const match = /^metadata-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u
      .exec(entry.name);
    if (!match || !entry.isDirectory()) {
      retained += 1;
      continue;
    }
    const runDirectory = join(metadataRoot, entry.name);
    try {
      const stat = await lstat(runDirectory);
      assert(stat.isDirectory() && !stat.isSymbolicLink()
        && stat.uid === ownerUid && isMode(stat, 0o700), 'metadata directory is unsafe');
      const runEntries = [];
      let totalBytes = 0;
      const runContents = await opendir(runDirectory);
      for await (const child of runContents) {
        runEntries.push(child.name);
        const childStat = await lstat(join(runDirectory, child.name));
        assert(childStat.isFile() && !childStat.isSymbolicLink()
          && childStat.uid === ownerUid && isMode(childStat, 0o600),
        'metadata run contains an unsafe file');
        totalBytes += childStat.size;
      }
      const sortedRunEntries = runEntries.sort();
      const isPilotManifest = sortedRunEntries.join(',') === pilotEntriesExpected.join(',');
      assert(isPilotManifest || sortedRunEntries.join(',') === runEntriesExpected.join(','),
        'metadata run has missing or unrecognized files');
      assert(totalBytes <= MAX_METADATA_RUN_BYTES,
        'metadata run exceeds the permitted total size');

      const marker = await readBoundedOwnerOnlyJson(
        runDirectory, METADATA_MARKER_NAME, ownerUid, MAX_MARKER_BYTES);
      exactKeys(marker, ['createdAt', 'kind', 'runId', 'schemaVersion'],
        'metadata marker contains unexpected fields');
      assert(marker.kind === METADATA_MARKER_KIND
        && marker.schemaVersion === METADATA_SCHEMA_VERSION
        && marker.runId === match[1], 'metadata marker identity is invalid');
      assert(typeof marker.createdAt === 'string'
        && Number.isFinite(Date.parse(marker.createdAt))
        && new Date(marker.createdAt).toISOString() === marker.createdAt,
      'metadata marker timestamp is invalid');

      if (isPilotManifest) {
        const pilot = await readBoundedOwnerOnlyJson(runDirectory, 'pilot-manifest.json', ownerUid, 1024 * 1024);
        validateCommonVoicePilotManifest(pilot);
      } else {
        const manifest = await readBoundedOwnerOnlyJson(
          runDirectory, 'run-manifest.json', ownerUid);
        const aggregate = await readBoundedOwnerOnlyJson(runDirectory, 'aggregate.json', ownerUid);
        validateRunManifest(manifest);
        validateAggregate(aggregate, manifest);
      }
      const age = nowMs - Date.parse(marker.createdAt);
      if (age < METADATA_RETENTION_MS || age < 0) {
        retained += 1;
        continue;
      }
      await removeOwnedRun(metadataRoot, runDirectory, ownerUid);
      removed += 1;
    } catch {
      // Unrecognized, malformed, raced, or future-dated entries stay for review.
      retained += 1;
    }
  }
  return Object.freeze({ removed, retained, retentionDays: METADATA_RETENTION_DAYS });
}

export const COMMON_VOICE_RUN_MAX_INTERRUPTED_AUDIO_AGE_MS = MAX_INTERRUPTED_AUDIO_AGE_MS;
export const COMMON_VOICE_METADATA_RETENTION_DAYS = METADATA_RETENTION_DAYS;
