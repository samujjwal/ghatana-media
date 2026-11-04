import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  renderLaunchAgentPlist,
  validateOwnLaunchAgentPlist,
} from '../scripts/qualification/setup-common-voice-retention-launch-agent.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('../scripts/qualification/setup-common-voice-retention-launch-agent.mjs', import.meta.url));

async function createHome(prefix) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  await chmod(path, 0o700);
  return realpath(path);
}

function runSetup(home, args = []) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
}

test('default dry-run prints an escaped owner LaunchAgent without creating directories', async () => {
  const home = await createHome('common-voice & <home>-');
  try {
    assert.deepEqual(await readdir(home), []);
    const result = runSetup(home);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /<key>Label<\/key>\s*<string>com\.ghatana\.media\.common-voice-retention<\/string>/u);
    assert.match(result.stdout, /<key>RunAtLoad<\/key>\s*<true\/>/u);
    assert.match(result.stdout, /<key>StartInterval<\/key>\s*<integer>60<\/integer>/u);
    assert.match(result.stdout, /&amp;.*&lt;home&gt;/u);
    assert.match(result.stdout, /<string>--audio-root<\/string>/u);
    assert.match(result.stdout, /<string>--metadata-root<\/string>/u);
    assert.match(result.stdout, /cleanup-common-voice-retention\.mjs/u);
    assert.equal(result.stdout.includes(home), false);
    assert.deepEqual(await readdir(home), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('rejects invalid or combined operation arguments without writes', async () => {
  const home = await createHome('common-voice-launch-args-');
  try {
    for (const args of [['--install', '--print'], ['--uninstall', '--install'], ['--unknown']]) {
      const result = runSetup(home, args);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'Common Voice retention LaunchAgent operation failed.\n');
      assert.deepEqual(await readdir(home), []);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('rejects a symlinked HOME during dry-run', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'common-voice-launch-symlink-'));
  const realHome = await createHome('common-voice-real-home-');
  const homeAlias = join(parent, 'home-alias');
  try {
    await symlink(realHome, homeAlias, 'dir');
    const result = runSetup(homeAlias);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Common Voice retention LaunchAgent operation failed.\n');
    assert.deepEqual(await readdir(realHome), []);
    assert.equal((await lstat(homeAlias)).isSymbolicLink(), true);
  } finally {
    await rm(parent, { recursive: true, force: true });
    await rm(realHome, { recursive: true, force: true });
  }
});

test('recognizes only the adapter plist structure while allowing old absolute executable and repo paths', async () => {
  const home = await createHome('common-voice-launch-validate-');
  const audioRoot = join(home, 'Library', 'Application Support', 'Ghatana Media', 'Common Voice', 'audio');
  const metadataRoot = join(home, 'Library', 'Application Support', 'Ghatana Media', 'Common Voice', 'metadata');
  const priorPlist = renderLaunchAgentPlist({
    audioRoot,
    metadataRoot,
    execPath: '/opt/old-node/bin/node',
    cleanupScript: join(home, 'Development', 'moved-checkout', 'scripts', 'qualification',
      'cleanup-common-voice-retention.mjs'),
  });
  try {
    assert.equal(validateOwnLaunchAgentPlist(priorPlist, { homeRoot: home, audioRoot, metadataRoot }), true);

    for (const invalid of [
      priorPlist.replace('com.ghatana.media.common-voice-retention', 'com.other.agent'),
      priorPlist.replace('<true/>', '<false/>'),
      priorPlist.replace('<integer>60</integer>', '<integer>61</integer>'),
      priorPlist.replace(audioRoot, join(home, 'outside-audio')),
      priorPlist.replace('cleanup-common-voice-retention.mjs', 'other-cleanup.mjs'),
      renderLaunchAgentPlist({
        audioRoot,
        metadataRoot,
        execPath: '/opt/old-node/bin/node',
        cleanupScript: '/old/checkout/scripts/qualification/cleanup-common-voice-retention.mjs',
      }),
    ]) {
      assert.throws(() => validateOwnLaunchAgentPlist(invalid, { homeRoot: home, audioRoot, metadataRoot }));
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
