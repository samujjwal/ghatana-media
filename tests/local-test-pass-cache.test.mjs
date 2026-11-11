import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTapPass, validateConfig } from '../scripts/local-test-pass-cache.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'scripts/local-test-pass-cache.mjs');
const fixtureDigest = 'a'.repeat(64);

test('accepts only complete, non-empty, zero-skip Node TAP summaries', () => {
  assert.deepEqual(parseTapPass('# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n'), {
    tests: 2, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0,
  });
  for (const output of [
    '# tests 0\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n',
    '# tests 2\n# pass 1\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n',
    '# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n',
    '# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n',
  ]) assert.equal(parseTapPass(output), null);
});

test('requires the complete source, provider, command, and fixture key', () => {
  const config = { checkId: 'check', reusePolicy: 'deterministic-local', providerProfile: 'none', providerSourceRevision: 'none', inputs: ['tests/local-test-pass-cache.test.mjs'], command: ['node', '--test', 'tests/local-test-pass-cache.test.mjs'], toolchainVersionCommands: [['node', '--version']], fixtureDigest };
  assert.doesNotThrow(() => validateConfig(config));
  for (const missing of ['checkId', 'reusePolicy', 'providerProfile', 'providerSourceRevision', 'inputs', 'command', 'toolchainVersionCommands', 'fixtureDigest']) {
    const invalid = { ...config };
    delete invalid[missing];
    assert.throws(() => validateConfig(invalid));
  }
});

test('runs a real Node test command once, reuses the authenticated exact match, and distrusts tampering', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'local-test-pass-cache-'));
  const configPath = path.join(temp, 'config.json');
  const checkId = `cache-test-${randomBytes(8).toString('hex')}`;
  const config = {
    checkId,
    reusePolicy: 'deterministic-local',
    inputs: ['scripts/local-test-pass-cache.mjs', 'tests/fixtures/local-test-pass-cache.sample.test.mjs'],
    providerProfile: 'none',
    providerSourceRevision: 'none',
    command: ['node', '--test', '--test-reporter=tap', 'tests/fixtures/local-test-pass-cache.sample.test.mjs'],
    toolchainVersionCommands: [['node', '--version']],
    fixtureDigest,
  };
  await writeFile(configPath, JSON.stringify(config));
  let entryPath;
  t.after(async () => {
    if (entryPath) await rm(entryPath, { force: true });
    await rm(temp, { recursive: true, force: true });
  });

  const invoke = () => spawnSync(process.execPath, [cli, '--config', configPath], { cwd: root, encoding: 'utf8' });
  const first = invoke();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /PASS_RECORDED/);
  const cacheDir = path.join(root, '.local-test-pass-cache');
  const key = JSON.parse(first.stdout.trim().split('\n').at(-1)).key;
  entryPath = path.join(cacheDir, `${key}.json`);
  const entry = JSON.parse(await readFile(entryPath, 'utf8'));
  assert.equal(entry.result.status, 'PASS');
  assert.ok(entry.result.tests > 0);

  const second = invoke();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /REUSED_PASS/);
  assert.doesNotMatch(second.stdout, /PASS_RECORDED/);

  entry.result.tests += 100;
  await writeFile(entryPath, JSON.stringify(entry));
  const tampered = invoke();
  assert.equal(tampered.status, 0, tampered.stderr);
  assert.match(tampered.stdout, /PASS_RECORDED/);
  assert.doesNotMatch(tampered.stdout, /REUSED_PASS/);

  await chmod(entryPath, 0o644);
  const permissive = invoke();
  assert.equal(permissive.status, 0, permissive.stderr);
  assert.match(permissive.stdout, /PASS_RECORDED/);
  assert.doesNotMatch(permissive.stdout, /REUSED_PASS/);
});

test('does not follow a symlinked cache entry when considering reuse', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'local-test-pass-cache-symlink-'));
  const configPath = path.join(temp, 'config.json');
  const config = {
    checkId: `symlink-cache-${randomBytes(8).toString('hex')}`,
    reusePolicy: 'deterministic-local',
    inputs: ['scripts/local-test-pass-cache.mjs', 'tests/fixtures/local-test-pass-cache.sample.test.mjs'],
    providerProfile: 'none',
    providerSourceRevision: 'none',
    command: ['node', '--test', '--test-reporter=tap', 'tests/fixtures/local-test-pass-cache.sample.test.mjs'],
    toolchainVersionCommands: [['node', '--version']],
    fixtureDigest,
  };
  await writeFile(configPath, JSON.stringify(config));
  let entryPath;
  t.after(async () => {
    if (entryPath) await rm(entryPath, { force: true });
    await rm(temp, { recursive: true, force: true });
  });
  const invoke = () => spawnSync(process.execPath, [cli, '--config', configPath], { cwd: root, encoding: 'utf8' });

  const first = invoke();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /PASS_RECORDED/);
  const key = JSON.parse(first.stdout.trim().split('\n').at(-1)).key;
  entryPath = path.join(root, '.local-test-pass-cache', `${key}.json`);
  const externalTarget = path.join(temp, 'entry.json');
  await writeFile(externalTarget, await readFile(entryPath), { mode: 0o600 });
  await rm(entryPath);
  await symlink(externalTarget, entryPath);

  const symlinked = invoke();
  assert.equal(symlinked.status, 0, symlinked.stderr);
  assert.match(symlinked.stdout, /PASS_RECORDED/);
  assert.doesNotMatch(symlinked.stdout, /REUSED_PASS/);
});

test('current-host-only runs every time and ignores an exact matching authenticated PASS entry', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'local-test-pass-cache-current-host-'));
  const configPath = path.join(temp, 'config.json');
  const counterPath = path.join(temp, 'runs.txt');
  const config = {
    checkId: `volatile-host-${randomBytes(8).toString('hex')}`,
    reusePolicy: 'current-host-only',
    inputs: ['scripts/local-test-pass-cache.mjs', 'tests/fixtures/local-test-pass-cache-current-host.test.mjs'],
    providerProfile: 'local-host-provider',
    providerSourceRevision: 'provider-revision-17',
    command: ['node', '--test', '--test-reporter=tap', 'tests/fixtures/local-test-pass-cache-current-host.test.mjs'],
    toolchainVersionCommands: [['node', '--version']],
    fixtureDigest,
    env: { LOCAL_TEST_PASS_CACHE_COUNTER: counterPath },
  };
  await writeFile(configPath, JSON.stringify(config));
  let entryPath;
  t.after(async () => {
    if (entryPath) await rm(entryPath, { force: true });
    await rm(temp, { recursive: true, force: true });
  });
  const invoke = () => spawnSync(process.execPath, [cli, '--config', configPath], { cwd: root, encoding: 'utf8' });

  const first = invoke();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /PASS_UNCACHED/);
  const key = JSON.parse(first.stdout.trim().split('\n').at(-1)).key;
  const cacheDir = path.join(root, '.local-test-pass-cache');
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  entryPath = path.join(cacheDir, `${key}.json`);
  assert.equal(existsSync(entryPath), false, 'current-host-only must not record a reusable entry');
  const payload = { version: 1, key, result: { status: 'PASS', tests: 1, durationMs: 1, recordedAt: new Date().toISOString() } };
  let secret;
  try { secret = await readFile(path.join(cacheDir, 'hmac.key')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    secret = randomBytes(32);
    await writeFile(path.join(cacheDir, 'hmac.key'), secret, { mode: 0o600 });
  }
  const preexisting = { ...payload, hmac: createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex') };
  await writeFile(entryPath, JSON.stringify(preexisting), { mode: 0o600 });
  const originalEntry = await readFile(entryPath);

  const second = invoke();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /PASS_UNCACHED/);
  assert.doesNotMatch(second.stdout, /REUSED_PASS|PASS_RECORDED/);
  assert.equal((await readFile(counterPath, 'utf8')).trim(), '2');
  assert.deepEqual(await readFile(entryPath), originalEntry);
});

test('stderr-only toolchain version changes produce distinct cache keys', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'local-test-pass-cache-toolchain-'));
  const configPath = path.join(temp, 'config.json');
  const versionPath = path.join(temp, 'toolchain-version.txt');
  const config = {
    checkId: `stderr-toolchain-${randomBytes(8).toString('hex')}`,
    reusePolicy: 'current-host-only',
    inputs: ['scripts/local-test-pass-cache.mjs', 'tests/fixtures/local-test-pass-cache.sample.test.mjs'],
    providerProfile: 'none',
    providerSourceRevision: 'none',
    command: ['node', '--test', '--test-reporter=tap', 'tests/fixtures/local-test-pass-cache.sample.test.mjs'],
    toolchainVersionCommands: [[process.execPath, '-e', "process.stderr.write(require('node:fs').readFileSync(process.env.VERSION_PATH, 'utf8'))"]],
    fixtureDigest,
    env: { VERSION_PATH: versionPath },
  };
  await writeFile(configPath, JSON.stringify(config));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const invoke = () => spawnSync(process.execPath, [cli, '--config', configPath], { cwd: root, encoding: 'utf8' });

  await writeFile(versionPath, 'toolchain-version-one');
  const first = invoke();
  assert.equal(first.status, 0, first.stderr);
  const firstRecord = JSON.parse(first.stdout.trim().split('\n').at(-1));
  assert.equal(firstRecord.status, 'PASS_UNCACHED');

  await writeFile(versionPath, 'toolchain-version-two');
  const second = invoke();
  assert.equal(second.status, 0, second.stderr);
  const secondRecord = JSON.parse(second.stdout.trim().split('\n').at(-1));
  assert.equal(secondRecord.status, 'PASS_UNCACHED');
  assert.notEqual(firstRecord.key, secondRecord.key);
});

test('different Codex tool call IDs do not change the key or prevent reuse', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'local-test-pass-cache-codex-env-'));
  const configPath = path.join(temp, 'config.json');
  const config = {
    checkId: `codex-env-${randomBytes(8).toString('hex')}`,
    reusePolicy: 'deterministic-local',
    inputs: ['scripts/local-test-pass-cache.mjs', 'tests/fixtures/local-test-pass-cache.sample.test.mjs'],
    providerProfile: 'none',
    providerSourceRevision: 'none',
    command: ['node', '--test', '--test-reporter=tap', 'tests/fixtures/local-test-pass-cache.sample.test.mjs'],
    toolchainVersionCommands: [['node', '--version']],
    fixtureDigest,
  };
  await writeFile(configPath, JSON.stringify(config));
  let entryPath;
  t.after(async () => {
    if (entryPath) await rm(entryPath, { force: true });
    await rm(temp, { recursive: true, force: true });
  });
  const invoke = (callId) => spawnSync(process.execPath, [cli, '--config', configPath], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CODEX_TOOL_CALL_ID: callId },
  });

  const first = invoke('tool-call-one');
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /PASS_RECORDED/);
  const firstRecord = JSON.parse(first.stdout.trim().split('\n').at(-1));
  entryPath = path.join(root, '.local-test-pass-cache', `${firstRecord.key}.json`);

  const second = invoke('tool-call-two');
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /REUSED_PASS/);
  const secondRecord = JSON.parse(second.stdout.trim().split('\n').at(-1));
  assert.equal(secondRecord.key, firstRecord.key);
});
