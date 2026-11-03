import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  cleanupExpiredCommonVoiceRuns,
  COMMON_VOICE_RUN_MAX_INTERRUPTED_AUDIO_AGE_MS,
  withEphemeralCommonVoiceRun,
} from '../scripts/qualification/common-voice-ephemeral-run.mjs';

const supportsOwnerOnlyStorage = typeof process.getuid === 'function'
  && typeof fsConstants.O_NOFOLLOW === 'number';
const hostSkip = supportsOwnerOnlyStorage ? false : 'requires POSIX owner identity and no-follow support';
const MARKER_NAME = '.media-common-voice-run.json';
const MARKER_KIND = 'ghatana-media-common-voice-ephemeral-run';

async function privateRoot() {
  const root = await mkdtemp(join(tmpdir(), 'media-common-voice-retention-'));
  await chmod(root, 0o700);
  return root;
}

async function createMarkedRun(root, createdAt, extra = {}) {
  const runId = randomUUID();
  const runDirectory = join(root, `run-${runId}`);
  await mkdir(runDirectory, { mode: 0o700 });
  await chmod(runDirectory, 0o700);
  const marker = { kind: MARKER_KIND, schemaVersion: '1.0.0', runId, createdAt, ...extra };
  const markerPath = join(runDirectory, MARKER_NAME);
  await writeFile(markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(markerPath, 0o600);
  return runDirectory;
}

test('removes a successful run directory and its synthetic scratch file before returning', { skip: hostSkip }, async () => {
  const root = await privateRoot();
  try {
    const result = await withEphemeralCommonVoiceRun(root, async (runDirectory) => {
      const dirStat = await lstat(runDirectory);
      const marker = JSON.parse(await readFile(join(runDirectory, MARKER_NAME), 'utf8'));
      assert.equal(dirStat.mode & 0o777, 0o700);
      assert.deepEqual(Object.keys(marker).sort(), ['createdAt', 'kind', 'runId', 'schemaVersion']);
      await writeFile(join(runDirectory, 'synthetic.bin'), Buffer.from([1, 2, 3]));
      return 'local-only-result';
    });
    assert.equal(result, 'local-only-result');
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('removes a failed run directory and preserves the callback error', { skip: hostSkip }, async () => {
  const root = await privateRoot();
  try {
    await assert.rejects(withEphemeralCommonVoiceRun(root, async (runDirectory) => {
      await writeFile(join(runDirectory, 'synthetic.bin'), 'fixture');
      throw new Error('synthetic run failed');
    }), /synthetic run failed/);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('24-hour-old and expired valid runs are removed while fresh, future, and unmarked paths remain', { skip: hostSkip }, async () => {
  const root = await privateRoot();
  const now = new Date('2026-11-03T12:00:00.000Z');
  try {
    const expired = await createMarkedRun(root,
      new Date(now.getTime() - COMMON_VOICE_RUN_MAX_INTERRUPTED_AUDIO_AGE_MS - 1).toISOString());
    const exactly24Hours = await createMarkedRun(root,
      new Date(now.getTime() - COMMON_VOICE_RUN_MAX_INTERRUPTED_AUDIO_AGE_MS).toISOString());
    const fresh = await createMarkedRun(root, new Date(now.getTime() - 1000).toISOString());
    const future = await createMarkedRun(root, new Date(now.getTime() + 1000).toISOString());
    const unmarked = join(root, `run-${randomUUID()}`);
    await mkdir(unmarked, { mode: 0o700 });
    await chmod(unmarked, 0o700);

    const result = await cleanupExpiredCommonVoiceRuns(root, { now });
    assert.deepEqual(result, { removed: 2, retained: 3, maxInterruptedAgeHours: 24 });
    await assert.rejects(lstat(expired), { code: 'ENOENT' });
    await assert.rejects(lstat(exactly24Hours), { code: 'ENOENT' });
    for (const retained of [fresh, future, unmarked]) {
      assert.equal((await lstat(retained)).isDirectory(), true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('leaves symlinked run entries and their external targets untouched', { skip: hostSkip }, async () => {
  const root = await privateRoot();
  const targetRoot = await privateRoot();
  try {
    const target = await createMarkedRun(targetRoot,
      new Date(Date.now() - COMMON_VOICE_RUN_MAX_INTERRUPTED_AUDIO_AGE_MS * 2).toISOString());
    const link = join(root, `run-${randomUUID()}`);
    await symlink(target, link, 'dir');
    const result = await cleanupExpiredCommonVoiceRuns(root, { now: new Date() });
    assert.deepEqual(result, { removed: 0, retained: 1, maxInterruptedAgeHours: 24 });
    assert.equal((await lstat(link)).isSymbolicLink(), true);
    assert.equal((await lstat(target)).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test('preserves a marked run when marker is malformed or contains reference data', { skip: hostSkip }, async () => {
  const root = await privateRoot();
  try {
    const bad = await createMarkedRun(root,
      new Date(Date.now() - COMMON_VOICE_RUN_MAX_INTERRUPTED_AUDIO_AGE_MS * 2).toISOString(),
      { transcript: 'must not be persisted' });
    const result = await cleanupExpiredCommonVoiceRuns(root, { now: new Date() });
    assert.deepEqual(result, { removed: 0, retained: 1, maxInterruptedAgeHours: 24 });
    assert.equal((await lstat(bad)).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fails closed for a root with group permissions or a symlink root', { skip: hostSkip }, async () => {
  const root = await privateRoot();
  const alias = `${root}-alias`;
  try {
    await chmod(root, 0o750);
    await assert.rejects(cleanupExpiredCommonVoiceRuns(root), /owner-only 700 permissions/);
    await chmod(root, 0o700);
    await symlink(root, alias, 'dir');
    await assert.rejects(cleanupExpiredCommonVoiceRuns(alias), /real directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(alias, { recursive: true, force: true });
  }
});
