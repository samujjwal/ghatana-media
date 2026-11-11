#!/usr/bin/env node
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_ROOT = path.join(REPO_ROOT, '.local-test-pass-cache');
const CACHE_VERSION = 1;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonicalize = (value) => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
    : value;
const canonical = (value) => JSON.stringify(canonicalize(value));
const ORCHESTRATION_ENV = new Set(['NODE_TEST_CONTEXT', 'CODEX_TOOL_CALL_ID']);
const inheritedEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !ORCHESTRATION_ENV.has(name)));

async function hashInput(relativePath) {
  if (path.isAbsolute(relativePath)) throw new Error(`input must be repository-relative: ${relativePath}`);
  const absolutePath = path.resolve(REPO_ROOT, relativePath);
  const relative = path.relative(REPO_ROOT, absolutePath);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..') throw new Error(`input must be inside the repository: ${relativePath}`);
  const resolved = await realpath(absolutePath);
  if (!resolved.startsWith(`${REPO_ROOT}${path.sep}`)) throw new Error(`input resolves outside the repository: ${relativePath}`);
  const fileStat = await stat(resolved);
  if (fileStat.isFile()) return { path: relative.split(path.sep).join('/'), sha256: sha256(await readFile(resolved)) };
  if (!fileStat.isDirectory()) throw new Error(`input must be a file or directory: ${relativePath}`);
  const children = (await readdir(resolved)).sort();
  const hashes = [];
  for (const child of children) hashes.push(await hashInput(path.relative(REPO_ROOT, path.join(resolved, child))));
  return { path: relative.split(path.sep).join('/'), sha256: sha256(canonical(hashes)) };
}

function parseTapPass(output) {
  const summaries = [...output.matchAll(/^# tests (\d+)\r?\n(?:# suites \d+\r?\n)?# pass (\d+)\r?\n# fail (\d+)\r?\n# cancelled (\d+)\r?\n# skipped (\d+)\r?\n# todo (\d+)(?:\r?\n|$)/gm)];
  if (summaries.length !== 1) return null;
  const [, tests, pass, fail, cancelled, skipped, todo] = summaries[0].map(Number);
  if (tests < 1 || pass !== tests || fail !== 0 || cancelled !== 0 || skipped !== 0 || todo !== 0) return null;
  return { tests, pass, fail, cancelled, skipped, todo };
}

function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('config must be a JSON object');
  for (const key of ['checkId', 'providerProfile', 'providerSourceRevision']) {
    if (typeof config[key] !== 'string' || !config[key].trim()) throw new Error(`config.${key} must be a non-empty string`);
  }
  if (!['deterministic-local', 'current-host-only'].includes(config.reusePolicy)) throw new Error('config.reusePolicy must be deterministic-local or current-host-only');
  if (!Array.isArray(config.inputs) || config.inputs.length === 0 || config.inputs.some((item) => typeof item !== 'string' || !item)) throw new Error('config.inputs must be a non-empty array of repository-relative paths');
  if (!Array.isArray(config.command) || config.command.length === 0 || config.command.some((part) => typeof part !== 'string')) throw new Error('config.command must be a non-empty argv array of strings');
  if (!Array.isArray(config.toolchainVersionCommands) || config.toolchainVersionCommands.length === 0 || config.toolchainVersionCommands.some((command) => !Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== 'string'))) throw new Error('config.toolchainVersionCommands must list argv commands that report every test toolchain version');
  if (typeof config.fixtureDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(config.fixtureDigest)) throw new Error('config.fixtureDigest must be a SHA-256 hex digest');
  if (config.env !== undefined && (!config.env || typeof config.env !== 'object' || Array.isArray(config.env) || Object.values(config.env).some((value) => typeof value !== 'string'))) throw new Error('config.env must map names to string values');
}

async function ensureSecret() {
  await mkdir(CACHE_ROOT, { recursive: true, mode: 0o700 });
  if ((await lstat(CACHE_ROOT)).isSymbolicLink()) throw new Error('cache directory must not be a symlink');
  await chmod(CACHE_ROOT, 0o700);
  const secretPath = path.join(CACHE_ROOT, 'hmac.key');
  try {
    if ((await lstat(secretPath)).isSymbolicLink()) throw new Error('cache HMAC key must not be a symlink');
    const handle = await open(secretPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const keyStat = await handle.stat();
      const key = await handle.readFile();
      if (!keyStat.isFile() || key.length !== 32 || (keyStat.mode & 0o077)) throw new Error('cache HMAC key has unsafe permissions or size');
      return key;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const key = randomBytes(32);
    try {
      const handle = await open(secretPath, 'wx', 0o600);
      await handle.writeFile(key);
      await handle.close();
      await chmod(secretPath, 0o600);
      return key;
    } catch (createError) {
      if (createError.code !== 'EEXIST') throw createError;
      return ensureSecret();
    }
  }
}

function authenticated(secret, payload) {
  return createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
}

async function loadTrustedEntry(secret, entryPath, expectedKey) {
  let fileHandle;
  try {
    fileHandle = await open(entryPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const fileStat = await fileHandle.stat();
    if (!fileStat.isFile() || (fileStat.mode & 0o077) !== 0) return null;
    const entry = JSON.parse(await fileHandle.readFile('utf8'));
    if (entry.version !== CACHE_VERSION || entry.key !== expectedKey || entry.result?.status !== 'PASS' || !Number.isInteger(entry.result.tests) || entry.result.tests < 1 || !Number.isFinite(entry.result.durationMs) || entry.result.durationMs < 0) return null;
    const signature = Buffer.from(entry.hmac || '', 'hex');
    const expected = Buffer.from(authenticated(secret, { version: entry.version, key: entry.key, result: entry.result }), 'hex');
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
    return entry;
  } catch { return null; }
  finally { await fileHandle?.close(); }
}

async function run(config) {
  validateConfig(config);
  const inputs = [];
  for (const input of [...new Set(config.inputs)].sort()) inputs.push(await hashInput(input));
  const toolchainVersions = [];
  for (const command of config.toolchainVersionCommands) toolchainVersions.push({ command, version: await commandVersion(command[0], command.slice(1), config.env || {}) });
  const keyMaterial = {
    checkId: config.checkId,
    inputs,
    runtime: { node: process.version, platform: process.platform, arch: process.arch, toolchainVersions },
    provider: { profile: config.providerProfile, sourceRevision: config.providerSourceRevision },
    reusePolicy: config.reusePolicy,
    command: config.command,
    fixtureDigest: config.fixtureDigest.toLowerCase(),
    env: config.env || {},
    inheritedEnvSha256: sha256(JSON.stringify(Object.entries(inheritedEnvironment()).sort(([a], [b]) => a.localeCompare(b)))),
  };
  const key = sha256(JSON.stringify(keyMaterial));
  const entryPath = path.join(CACHE_ROOT, `${key}.json`);
  let secret;
  if (config.reusePolicy === 'deterministic-local') {
    secret = await ensureSecret();
    const hit = await loadTrustedEntry(secret, entryPath, key);
    if (hit) {
      console.log(JSON.stringify({ status: 'REUSED_PASS', key, checkId: config.checkId, tests: hit.result.tests }));
      return 0;
    }
  }

  const started = Date.now();
  const result = await spawnAndCapture(config.command, config.env || {});
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.code !== 0 || result.signal) {
    console.error(JSON.stringify({ status: 'FAIL', key, checkId: config.checkId, exitCode: result.code, signal: result.signal }));
    return result.code || 1;
  }
  const summary = parseTapPass(result.stdout);
  if (!summary) {
    console.error(JSON.stringify({ status: 'UNCACHEABLE', key, checkId: config.checkId, reason: 'command did not produce one complete, non-empty, zero-skip Node TAP PASS summary' }));
    return 1;
  }
  if (config.reusePolicy === 'current-host-only') {
    console.log(JSON.stringify({ status: 'PASS_UNCACHED', key, checkId: config.checkId, tests: summary.tests }));
    return 0;
  }
  const payload = { version: CACHE_VERSION, key, result: { status: 'PASS', tests: summary.tests, durationMs: Date.now() - started, recordedAt: new Date().toISOString() } };
  const entry = { ...payload, hmac: authenticated(secret, payload) };
  const tempPath = `${entryPath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(entry)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(tempPath, entryPath);
  await chmod(entryPath, 0o600);
  console.log(JSON.stringify({ status: 'PASS_RECORDED', key, checkId: config.checkId, tests: summary.tests }));
  return 0;
}

function spawnAndCapture([executable, ...args], env) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...inheritedEnvironment(), ...env };
    for (const name of ORCHESTRATION_ENV) delete childEnv[name];
    const child = spawn(executable, args, { cwd: REPO_ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function commandVersion(executable, args, env) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...inheritedEnvironment(), ...env };
    for (const name of ORCHESTRATION_ENV) delete childEnv[name];
    const child = spawn(executable, args, { cwd: REPO_ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      const output = { stdout: stdout.trim(), stderr: stderr.trim() };
      if (code !== 0) reject(new Error(`${executable} ${args.join(' ')} failed (${code})`));
      else if (!output.stdout && !output.stderr) reject(new Error(`${executable} ${args.join(' ')} produced no version output`));
      else resolve(output);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configFlag = process.argv.indexOf('--config');
  if (configFlag === -1 || !process.argv[configFlag + 1]) {
    console.error('usage: node scripts/local-test-pass-cache.mjs --config <config.json>');
    process.exitCode = 2;
  } else {
    try {
      const configPath = path.resolve(REPO_ROOT, process.argv[configFlag + 1]);
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      process.exitCode = await run(config);
    } catch (error) {
      console.error(`local test-pass cache: ${error.message}`);
      process.exitCode = 2;
    }
  }
}

export { parseTapPass, validateConfig };
