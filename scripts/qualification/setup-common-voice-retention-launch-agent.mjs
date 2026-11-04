#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import {
  lstat,
  link,
  mkdir,
  open,
  realpath,
  unlink,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LABEL = 'com.ghatana.media.common-voice-retention';
const START_INTERVAL_SECONDS = 60;
const LAUNCHCTL_PATH = '/bin/launchctl';
const CLEANUP_SCRIPT = fileURLToPath(new URL('./cleanup-common-voice-retention.mjs', import.meta.url));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseMode(args) {
  if (args.length === 0) return 'print';
  if (args.length !== 1 || !['--print', '--install', '--uninstall'].includes(args[0])) {
    throw new Error('use exactly one of --print, --install, or --uninstall');
  }
  return args[0].slice(2);
}

function xmlEscape(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function assertContained(homeRoot, targetPath) {
  const pathFromHome = relative(homeRoot, targetPath);
  assert(pathFromHome !== '' && pathFromHome !== '..'
    && !pathFromHome.startsWith(`..${sep}`) && !isAbsolute(pathFromHome),
  'LaunchAgent paths must remain inside the current user home');
}

async function inspectHome(homePath) {
  assert(typeof homePath === 'string' && isAbsolute(homePath), 'current user home must be absolute');
  const homeRoot = resolve(homePath);
  const stat = await lstat(homeRoot);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'current user home must be a real directory');
  assert(typeof process.getuid === 'function' && stat.uid === process.getuid(),
    'current user home must belong to the current user');
  assert(await realpath(homeRoot) === homeRoot, 'current user home must not resolve through an alias');
  return homeRoot;
}

function createPlan(homeRoot, execPath) {
  const baseRoot = join(homeRoot, 'Library', 'Application Support', 'Ghatana Media', 'Common Voice');
  const audioRoot = join(baseRoot, 'audio');
  const metadataRoot = join(baseRoot, 'metadata');
  const launchAgentsRoot = join(homeRoot, 'Library', 'LaunchAgents');
  const plistPath = join(launchAgentsRoot, `${LABEL}.plist`);
  assert(isAbsolute(execPath), 'Node executable path must be absolute');
  assertContained(homeRoot, audioRoot);
  assertContained(homeRoot, metadataRoot);
  assertContained(homeRoot, plistPath);
  return Object.freeze({ homeRoot, audioRoot, metadataRoot, launchAgentsRoot, plistPath, execPath });
}

export function renderLaunchAgentPlist({ audioRoot, metadataRoot, execPath = process.execPath, cleanupScript = CLEANUP_SCRIPT }) {
  for (const path of [audioRoot, metadataRoot, execPath, cleanupScript]) {
    assert(typeof path === 'string' && isAbsolute(path), 'LaunchAgent paths must be absolute');
  }
  const argumentsList = [execPath, cleanupScript, '--audio-root', audioRoot,
    '--metadata-root', metadataRoot];
  const programArguments = argumentsList.map((argument) => `    <string>${xmlEscape(argument)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${START_INTERVAL_SECONDS}</integer>
</dict>
</plist>
`;
}

function decodeXmlText(text) {
  assert(!/<|>|&(?!(?:amp|lt|gt|quot|apos);)/u.test(text), 'LaunchAgent plist contains invalid XML text');
  return text.replace(/&(amp|lt|gt|quot|apos);/gu, (_, entity) => ({
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  })[entity]);
}

function parseLaunchAgentPlist(xml) {
  const declaration = '<?xml version="1.0" encoding="UTF-8"?>\n';
  const doctype = '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n';
  assert(typeof xml === 'string' && xml.startsWith(declaration + doctype),
    'LaunchAgent plist has an unsupported XML header');
  const source = xml.slice((declaration + doctype).length);
  let cursor = 0;
  const skipWhitespace = () => {
    while (/\s/u.test(source[cursor] ?? '') && cursor < source.length) cursor += 1;
  };
  const consume = (token) => {
    skipWhitespace();
    assert(source.startsWith(token, cursor), 'LaunchAgent plist structure is invalid');
    cursor += token.length;
  };
  const textElement = (name) => {
    consume(`<${name}>`);
    const end = source.indexOf(`</${name}>`, cursor);
    assert(end >= cursor, 'LaunchAgent plist text element is incomplete');
    const raw = source.slice(cursor, end);
    assert(!raw.includes('<'), 'LaunchAgent plist text element contains nested markup');
    cursor = end + name.length + 3;
    return decodeXmlText(raw);
  };
  const parseValue = () => {
    skipWhitespace();
    if (source.startsWith('<string>', cursor)) return textElement('string');
    if (source.startsWith('<integer>', cursor)) {
      const value = textElement('integer').trim();
      assert(/^\d+$/u.test(value), 'LaunchAgent plist integer is invalid');
      return Number(value);
    }
    if (source.startsWith('<true/>', cursor)) {
      cursor += '<true/>'.length;
      return true;
    }
    if (source.startsWith('<false/>', cursor)) {
      cursor += '<false/>'.length;
      return false;
    }
    if (source.startsWith('<array>', cursor)) {
      consume('<array>');
      const values = [];
      while (true) {
        skipWhitespace();
        if (source.startsWith('</array>', cursor)) break;
        values.push(parseValue());
      }
      consume('</array>');
      return values;
    }
    if (source.startsWith('<dict>', cursor)) {
      consume('<dict>');
      const values = {};
      while (true) {
        skipWhitespace();
        if (source.startsWith('</dict>', cursor)) break;
        const key = textElement('key');
        assert(!Object.hasOwn(values, key), 'LaunchAgent plist contains a duplicate key');
        values[key] = parseValue();
      }
      consume('</dict>');
      return values;
    }
    throw new Error('LaunchAgent plist contains an unsupported value');
  };

  consume('<plist version="1.0">');
  const value = parseValue();
  consume('</plist>');
  skipWhitespace();
  assert(cursor === source.length, 'LaunchAgent plist has trailing content');
  return value;
}

export function validateOwnLaunchAgentPlist(xml, { homeRoot, audioRoot, metadataRoot }) {
  const plist = parseLaunchAgentPlist(xml);
  assert(plist !== null && typeof plist === 'object' && !Array.isArray(plist)
    && Object.keys(plist).sort().join(',') === 'Label,ProgramArguments,RunAtLoad,StartInterval',
  'LaunchAgent plist keys do not match this adapter');
  assert(plist.Label === LABEL && plist.RunAtLoad === true
    && plist.StartInterval === START_INTERVAL_SECONDS,
  'LaunchAgent plist identity or schedule does not match this adapter');
  const args = plist.ProgramArguments;
  assert(Array.isArray(args) && args.length === 6
    && args.every((value) => typeof value === 'string')
    && isAbsolute(args[0]) && isAbsolute(args[1])
    && isAbsolute(args[3]) && isAbsolute(args[5])
    && args[2] === '--audio-root' && args[3] === audioRoot
    && args[4] === '--metadata-root' && args[5] === metadataRoot
    && args[1].split(/[\\/]/u).at(-1) === 'cleanup-common-voice-retention.mjs',
  'LaunchAgent program arguments do not match this adapter');
  assertContained(homeRoot, args[1]);
  return true;
}

async function assertNoSymlinkComponents(homeRoot, targetPath) {
  assertContained(homeRoot, targetPath);
  const components = relative(homeRoot, targetPath).split(sep).filter(Boolean);
  let currentPath = homeRoot;
  for (const component of components) {
    currentPath = join(currentPath, component);
    try {
      const stat = await lstat(currentPath);
      assert(!stat.isSymbolicLink(), 'LaunchAgent paths must not contain symlinks');
      if (currentPath !== targetPath) {
        assert(stat.isDirectory(), 'LaunchAgent parent paths must be directories');
      }
      assert(stat.uid === process.getuid(), 'LaunchAgent paths must belong to the current user');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
  }
}

async function ensureDirectory(homeRoot, targetPath, { privateMode = false } = {}) {
  assertContained(homeRoot, targetPath);
  const components = relative(homeRoot, targetPath).split(sep).filter(Boolean);
  let currentPath = homeRoot;
  for (const component of components) {
    currentPath = join(currentPath, component);
    try {
      await mkdir(currentPath, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const stat = await lstat(currentPath);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid(),
      'LaunchAgent paths must be current-user directories without symlinks');
    if (privateMode && currentPath === targetPath) {
      assert((stat.mode & 0o777) === 0o700, 'audio and metadata roots must have owner-only permissions');
    }
  }
}

async function writeOwnerOnlyPlist(plan, contents) {
  const temporaryPath = join(plan.launchAgentsRoot, `.${LABEL}.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    // link is atomic and refuses to replace a pre-existing LaunchAgent.
    await link(temporaryPath, plan.plistPath);
    await unlink(temporaryPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    if (error?.code === 'EEXIST') throw new Error('LaunchAgent already exists; refusing replacement');
    throw error;
  }
  const stat = await lstat(plan.plistPath);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid()
    && (stat.mode & 0o777) === 0o600, 'LaunchAgent plist must be owner-only');
}

async function loadOwnPlist(plan) {
  const stat = await lstat(plan.plistPath);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid()
    && (stat.mode & 0o777) === 0o600, 'LaunchAgent plist is missing or unsafe');
  const handle = await open(plan.plistPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const bytes = await handle.readFile();
    validateOwnLaunchAgentPlist(bytes.toString('utf8'), plan);
  } finally {
    await handle.close();
  }
}

async function perform(mode, homePath = process.env.HOME) {
  const homeRoot = await inspectHome(homePath);
  const plan = createPlan(homeRoot, process.execPath);
  for (const path of [plan.audioRoot, plan.metadataRoot, plan.launchAgentsRoot, plan.plistPath]) {
    await assertNoSymlinkComponents(homeRoot, path);
  }
  const plist = renderLaunchAgentPlist(plan);
  if (mode === 'print') return plist;
  assert(process.platform === 'darwin', 'install and uninstall are available only on macOS');

  if (mode === 'install') {
    await ensureDirectory(homeRoot, plan.launchAgentsRoot);
    await ensureDirectory(homeRoot, plan.audioRoot, { privateMode: true });
    await ensureDirectory(homeRoot, plan.metadataRoot, { privateMode: true });
    await writeOwnerOnlyPlist(plan, plist);
    const bootstrap = spawnSync(LAUNCHCTL_PATH,
      ['bootstrap', `gui/${process.getuid()}`, plan.plistPath], { encoding: 'utf8' });
    if (bootstrap.error || bootstrap.status !== 0) {
      throw new Error('launchd did not accept the Common Voice retention agent');
    }
    return 'installed';
  }

  if (mode === 'uninstall') {
    await loadOwnPlist(plan);
    const bootout = spawnSync(LAUNCHCTL_PATH,
      ['bootout', `gui/${process.getuid()}`, plan.plistPath], { encoding: 'utf8' });
    if (bootout.error || bootout.status !== 0) {
      throw new Error('launchd did not confirm unloading the Common Voice retention agent');
    }
    await unlink(plan.plistPath);
    return 'uninstalled';
  }
  throw new Error('unsupported operation');
}

export async function setupCommonVoiceRetentionLaunchAgent(args = process.argv.slice(2)) {
  const mode = parseMode(args);
  return perform(mode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await setupCommonVoiceRetentionLaunchAgent();
    process.stdout.write(`${result}\n`);
  } catch {
    process.stderr.write('Common Voice retention LaunchAgent operation failed.\n');
    process.exitCode = 1;
  }
}
