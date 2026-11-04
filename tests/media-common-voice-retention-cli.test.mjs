import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_PATH = fileURLToPath(new URL('../scripts/qualification/cleanup-common-voice-retention.mjs', import.meta.url));
const supportsOwnerOnlyStorage = typeof process.getuid === 'function'
  && typeof fsConstants.O_NOFOLLOW === 'number';
const hostSkip = supportsOwnerOnlyStorage ? false : 'requires POSIX owner identity and no-follow support';
const AUDIO_MARKER_NAME = '.media-common-voice-run.json';
const AUDIO_MARKER_KIND = 'ghatana-media-common-voice-ephemeral-run';
const METADATA_MARKER_NAME = '.media-common-voice-metadata.json';
const METADATA_MARKER_KIND = 'ghatana-media-common-voice-retained-metadata';
const REVISION = 'cv-corpus-27.0-2026-09-11';
const DATASET_ID = 'cmu5jplf300nwmh07iqvk9leo';

async function privateDirectory(path) {
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

async function writePrivateJson(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(path, 0o600);
}

function invokeCli(args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], { encoding: 'utf8' });
}

function rootsArgs(audioRoot, metadataRoot) {
  return ['--audio-root', audioRoot, '--metadata-root', metadataRoot];
}

async function addExpiredAudioRun(audioRoot, createdAt) {
  const runId = randomUUID();
  const directory = await privateDirectory(join(audioRoot, `run-${runId}`));
  await writePrivateJson(join(directory, AUDIO_MARKER_NAME), {
    kind: AUDIO_MARKER_KIND,
    schemaVersion: '1.0.0',
    runId,
    createdAt,
  });
  return directory;
}

async function addExpiredMetadataRun(metadataRoot, createdAt) {
  const runId = randomUUID();
  const directory = await privateDirectory(join(metadataRoot, `metadata-${runId}`));
  const clipManifest = [{
    locale: 'en',
    sourceDatasetId: DATASET_ID,
    sourceRevision: REVISION,
    sourceSplit: 'test',
    clipId: 'synthetic-fixture-clip',
    audioSha256: 'a'.repeat(64),
  }];
  const clipManifestDigest = createHash('sha256')
    .update(JSON.stringify(clipManifest), 'utf8').digest('hex');
  const runManifest = {
    locale: 'en',
    sourceDatasetId: DATASET_ID,
    sourceRevision: REVISION,
    sourceSplit: 'test',
    clipManifestDigest,
    modelDigest: 'b'.repeat(64),
    host: 'synthetic-test-host',
    clipManifest,
  };
  const aggregate = {
    locale: 'en',
    sourceDatasetId: DATASET_ID,
    sourceRevision: REVISION,
    sourceSplit: 'test',
    clipManifestDigest,
    modelDigest: runManifest.modelDigest,
    host: runManifest.host,
    wer: 0.25,
    cer: 0.1,
  };
  await writePrivateJson(join(directory, 'run-manifest.json'), runManifest);
  await writePrivateJson(join(directory, 'aggregate.json'), aggregate);
  await writePrivateJson(join(directory, METADATA_MARKER_NAME), {
    kind: METADATA_MARKER_KIND,
    schemaVersion: '1.0.0',
    runId,
    createdAt,
  });
  return directory;
}

test('requires both explicit absolute roots and rejects overlapping roots', async () => {
  const missing = invokeCli(['--audio-root', '/tmp/audio']);
  assert.notEqual(missing.status, 0);
  assert.equal(missing.stdout, '');
  assert.doesNotMatch(missing.stderr, /\/tmp\/audio/u);

  const relative = invokeCli(['--audio-root', 'audio', '--metadata-root', '/tmp/metadata']);
  assert.notEqual(relative.status, 0);
  assert.equal(relative.stdout, '');

  const parent = await mkdtemp(join(tmpdir(), 'media-common-voice-cli-overlap-'));
  const audioRoot = await privateDirectory(join(parent, 'audio'));
  const metadataRoot = await privateDirectory(join(audioRoot, 'metadata'));
  try {
    const expiredRun = await addExpiredAudioRun(audioRoot,
      new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());
    const overlap = invokeCli(rootsArgs(audioRoot, metadataRoot));
    assert.notEqual(overlap.status, 0);
    assert.equal(overlap.stdout, '');
    assert.doesNotMatch(overlap.stderr, new RegExp(parent.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    assert.equal((await lstat(expiredRun)).isDirectory(), true);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('removes expired marked audio and metadata fixtures and emits counts only', { skip: hostSkip }, async () => {
  const parent = await mkdtemp(join(tmpdir(), 'media-common-voice-cli-expired-'));
  const audioRoot = await privateDirectory(join(parent, 'audio'));
  const metadataRoot = await privateDirectory(join(parent, 'metadata'));
  const expiredAt = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
  try {
    const audioRun = await addExpiredAudioRun(audioRoot,
      new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());
    const metadataRun = await addExpiredMetadataRun(metadataRoot, expiredAt);
    const result = invokeCli(['--', ...rootsArgs(audioRoot, metadataRoot)]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      audio: { removed: 1, retained: 0 },
      metadata: { removed: 1, retained: 0 },
    });
    assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout, /clip|sha256|\/tmp\//iu);
    await assert.rejects(lstat(audioRun), { code: 'ENOENT' });
    await assert.rejects(lstat(metadataRun), { code: 'ENOENT' });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('preserves unmarked and fresh audio paths', { skip: hostSkip }, async () => {
  const parent = await mkdtemp(join(tmpdir(), 'media-common-voice-cli-preserve-'));
  const audioRoot = await privateDirectory(join(parent, 'audio'));
  const metadataRoot = await privateDirectory(join(parent, 'metadata'));
  try {
    const unmarked = await privateDirectory(join(audioRoot, `run-${randomUUID()}`));
    const fresh = await addExpiredAudioRun(audioRoot, new Date().toISOString());
    const result = invokeCli(rootsArgs(audioRoot, metadataRoot));

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      audio: { removed: 0, retained: 2 },
      metadata: { removed: 0, retained: 0 },
    });
    assert.equal((await lstat(unmarked)).isDirectory(), true);
    assert.equal((await lstat(fresh)).isDirectory(), true);
    assert.deepEqual(await readdir(metadataRoot), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
