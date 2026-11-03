import {
  chmod,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rm,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const MARKER_NAME = '.media-common-voice-run.json';
const MARKER_KIND = 'ghatana-media-common-voice-ephemeral-run';
const RUN_PREFIX = 'run-';
const MAX_INTERRUPTED_AUDIO_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_MARKER_BYTES = 4096;

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

async function readMarker(runDirectory, expectedUid) {
  const markerPath = join(runDirectory, MARKER_NAME);
  const stat = await lstat(markerPath);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'run marker must be a regular non-symlink file');
  assert(stat.uid === expectedUid && isMode(stat, 0o600), 'run marker must be owner-only');
  assert(stat.size > 0 && stat.size <= MAX_MARKER_BYTES, 'run marker size is invalid');

  const handle = await open(markerPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const openedStat = await handle.stat();
    assert(openedStat.isFile() && openedStat.uid === expectedUid && isMode(openedStat, 0o600)
      && openedStat.size > 0 && openedStat.size <= MAX_MARKER_BYTES,
    'opened run marker changed or is unsafe');
    const bytes = await handle.readFile();
    assert(bytes.length <= MAX_MARKER_BYTES, 'run marker exceeds the permitted size');
    const marker = JSON.parse(bytes.toString('utf8'));
    const expectedKeys = ['createdAt', 'kind', 'runId', 'schemaVersion'];
    assert(Object.keys(marker).sort().join(',') === expectedKeys.join(','),
      'run marker contains unexpected persisted data');
    assert(marker.kind === MARKER_KIND && marker.schemaVersion === '1.0.0', 'run marker identity is invalid');
    assert(typeof marker.runId === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(marker.runId),
    'run marker ID is invalid');
    assert(typeof marker.createdAt === 'string' && Number.isFinite(Date.parse(marker.createdAt)),
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
 * authorize model inference; callers must obtain those independently.
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
    if (callbackFailed) {
      throw new AggregateError([callbackFailure, cleanupFailure],
        'run failed and ephemeral audio cleanup could not be confirmed');
    }
    throw cleanupFailure;
  }
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

export const COMMON_VOICE_RUN_MAX_INTERRUPTED_AUDIO_AGE_MS = MAX_INTERRUPTED_AUDIO_AGE_MS;
