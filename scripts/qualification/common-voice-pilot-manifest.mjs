import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { createGunzip } from 'node:zlib';
import { Transform } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { retainCommonVoicePilotMetadata } from './common-voice-ephemeral-run.mjs';

const REVISION = 'cv-corpus-27.0-2026-09-11';
const DATASETS = Object.freeze({ en: 'cmu5jplf300nwmh07iqvk9leo', 'ne-NP': 'cmu61478v00j9o107alzuue1z' });
const ARCHIVES = Object.freeze({
  en: Object.freeze({ basename: '1789502799671-cv-corpus-27.0-2026-09-11-en.tar.gz', bytes: 94956262763, rows: 16403, root: 'en' }),
  'ne-NP': Object.freeze({ basename: '1789491018738-cv-corpus-27.0-2026-09-11-ne-NP.tar.gz', bytes: 42519359, rows: 302, root: 'ne-NP' }),
});
const PILOT_SIZE = 24;
const MAX_MEMBER_BYTES = 16 * 1024 * 1024;
const MAX_DURATION_TSV_BYTES = 96 * 1024 * 1024;
const MAX_DURATION_ROWS = 5000000;
const MAX_ARCHIVE_MEMBER_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_EXPANDED_ARCHIVE_BYTES = 256 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_MEMBERS = 5000000;
const MAX_SELECTED_AUDIO_BYTES = 120 * 1024 * 1024;

function assert(ok, message) { if (!ok) throw new Error(message); }

class StreamReader {
  constructor(iterable, maxExpandedBytes) {
    this.iterator = iterable[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
    this.done = false;
    this.maxExpandedBytes = maxExpandedBytes;
    this.bytesRead = 0;
  }
  async read(size, max = size) {
    assert(size <= max, 'archive member exceeds permitted size');
    const output = Buffer.allocUnsafe(size);
    let copied = 0;
    if (this.buffer.length) {
      const count = Math.min(size, this.buffer.length);
      this.buffer.copy(output, 0, 0, count);
      this.buffer = this.buffer.subarray(count);
      copied = count;
    }
    while (copied < size && !this.done) {
      const item = await this.iterator.next();
      if (item.done) this.done = true;
      else if (item.value.length) {
        this.bytesRead += item.value.length;
        assert(this.bytesRead <= this.maxExpandedBytes, 'archive exceeds the aggregate expanded-byte cap');
        const count = Math.min(size - copied, item.value.length);
        item.value.copy(output, copied, 0, count);
        copied += count;
        if (count < item.value.length) this.buffer = item.value.subarray(count);
      }
    }
    assert(copied === size, 'truncated tar archive');
    return output;
  }
  async skip(size, consume) {
    let left = size;
    while (left) {
      const part = await this.read(Math.min(left, 1024 * 1024), 1024 * 1024);
      consume?.(part);
      left -= part.length;
    }
    const padding = (512 - (size % 512)) % 512;
    if (padding) await this.read(padding);
  }
  async requireZeroTail() {
    while (true) {
      if (this.buffer.length) {
        assert(this.buffer.every((byte) => byte === 0), 'nonzero data after tar terminator');
        this.buffer = Buffer.alloc(0);
      }
      if (this.done) return;
      const item = await this.iterator.next();
      if (item.done) { this.done = true; return; }
      this.bytesRead += item.value.length;
      assert(this.bytesRead <= this.maxExpandedBytes, 'archive exceeds the aggregate expanded-byte cap');
      assert(item.value.every((byte) => byte === 0), 'nonzero data after tar terminator');
    }
  }
}

function tarString(buf) { return buf.toString('utf8').replace(/\0.*$/su, ''); }
function tarNumber(buf) {
  const text = tarString(buf).trim();
  if (!text) return 0;
  assert(/^[0-7]+$/u.test(text), 'unsupported tar numeric encoding');
  return Number.parseInt(text, 8);
}
function safeMemberPath(header) {
  const name = tarString(header.subarray(0, 100));
  const prefix = tarString(header.subarray(345, 500));
  const rawPath = prefix ? `${prefix}/${name}` : name;
  const path = rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
  assert(path && !path.startsWith('/') && !path.includes('\\')
    && path.split('/').every((part) => part && part !== '.' && part !== '..'), 'unsafe tar member path');
  return path;
}
function verifyHeaderChecksum(header) {
  const expected = tarNumber(header.subarray(148, 156));
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += (i >= 148 && i < 156) ? 32 : header[i];
  assert(sum === expected, 'tar header checksum mismatch');
}
function parseTestTsv(text, maxRows) {
  const lines = text.replace(/\r\n/gu, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  assert(lines.length >= 1 && lines.length <= maxRows + 1, 'TSV row count exceeds bound');
  const header = lines.shift().split('\t');
  const requiredHeader = ['client_id', 'path', 'sentence_id', 'sentence', 'up_votes', 'down_votes', 'age', 'gender', 'accents', 'variant', 'locale', 'segment'];
  const permittedHeader = new Set([...requiredHeader, 'sentence_domain']);
  assert(new Set(header).size === header.length && requiredHeader.every((field) => header.includes(field))
    && header.every((field) => permittedHeader.has(field))
    && (header.length === requiredHeader.length || header.length === requiredHeader.length + 1),
  'unexpected Common Voice test.tsv schema');
  const pathIndex = header.indexOf('path');
  return lines.map((line) => {
    const fields = line.split('\t');
    assert(fields.length === header.length, 'malformed TSV row');
    const clipPath = fields[pathIndex];
    assert(clipPath, 'test.tsv row has no clip path');
    return clipPath;
  });
}
function choosePilotIds(locale, paths) {
  const prefix = locale === 'en' ? 'common_voice_en_' : 'common_voice_ne-NP_';
  const unique = new Set();
  for (const clipPath of paths) {
    assert(new RegExp(`^${prefix}\\d+\\.mp3$`, 'u').test(clipPath), 'malformed or duplicate test clip path');
    assert(!unique.has(clipPath), 'malformed or duplicate test clip path');
    unique.add(clipPath);
  }
  return [...unique].map((clipId) => ({
    clipId, rank: createHash('sha256').update(`${REVISION}\0${locale}\0${clipId}`).digest('hex'),
  })).sort((a, b) => a.rank.localeCompare(b.rank) || a.clipId.localeCompare(b.clipId))
    .slice(0, PILOT_SIZE).map(({ clipId }) => clipId);
}
function parseSelectedDurations(buffer, selectedIds) {
  let offset = 0;
  let lineCount = 0;
  const nextLine = () => {
    if (offset >= buffer.length) return null;
    const end = buffer.indexOf(10, offset);
    const limit = end < 0 ? buffer.length : end;
    const line = buffer.toString('utf8', offset, limit).replace(/\r$/u, '');
    offset = end < 0 ? buffer.length : end + 1;
    lineCount += 1;
    assert(lineCount <= MAX_DURATION_ROWS + 1, 'clip_durations.tsv row count exceeds bound');
    return line;
  };
  const header = nextLine();
  assert(typeof header === 'string', 'clip_durations.tsv is empty');
  const columns = header.split('\t');
  assert(columns.length === 2 && columns[0] === 'clip' && /^duration(?:\s*\[([^\]]+)\])?$/u.test(columns[1]),
    'unsupported clip_durations.tsv schema');
  const unit = /\[([^\]]+)\]/u.exec(columns[1])?.[1]?.toLowerCase() ?? 'seconds';
  assert(['ms', 'milliseconds', 's', 'seconds'].includes(unit), 'unsupported duration unit');
  const selected = new Map();
  while (true) {
    const line = nextLine();
    if (line === null) break;
    if (!line) continue;
    const separator = line.indexOf('\t');
    assert(separator > 0 && separator === line.lastIndexOf('\t'), 'malformed clip duration row');
    const clip = line.slice(0, separator);
    const text = line.slice(separator + 1);
    assert(/^\d+(?:\.\d+)?$/u.test(text), 'malformed clip duration value');
    if (!selectedIds.has(clip)) continue;
    assert(!selected.has(clip), 'duplicate selected clip duration path');
    selected.set(clip, ['ms', 'milliseconds'].includes(unit) ? Number(text) : Number(text) * 1000);
  }
  assert(selected.size === selectedIds.size, 'selected clip lacks official duration');
  return selected;
}
function parseTarOctalHeader(header) {
  verifyHeaderChecksum(header);
  const path = safeMemberPath(header);
  const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
  assert(type === '0' || type === '5', 'unsupported non-regular tar member');
  if (type === '5') assert(tarNumber(header.subarray(124, 136)) === 0, 'tar directory member has a body');
  return { path, size: tarNumber(header.subarray(124, 136)), directory: type === '5' };
}

export async function parseCommonVoicePilotArchive(
  path,
  locale,
  archivePin = ARCHIVES[locale],
  { lstatArchive = lstat } = {},
) {
  assert(Object.hasOwn(ARCHIVES, locale), 'unsupported Common Voice locale');
  const config = { ...ARCHIVES[locale], ...archivePin };
  assert(typeof path === 'string' && isAbsolute(path), 'archive path must be absolute');
  const beforeOpen = await lstatArchive(path);
  assert(beforeOpen.isFile() && !beforeOpen.isSymbolicLink(), 'archive must be a regular non-symlink file');
  assert(typeof fsConstants.O_NOFOLLOW === 'number', 'archive access requires no-follow support');
  const archiveHandle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let openedStat;
  try {
    openedStat = await archiveHandle.stat();
    assert(openedStat.isFile() && openedStat.dev === beforeOpen.dev && openedStat.ino === beforeOpen.ino
      && openedStat.size === beforeOpen.size && openedStat.uid === beforeOpen.uid,
    'archive identity changed between lookup and open');
    assert(openedStat.size === config.bytes && basename(path) === config.basename,
      'archive size or basename does not match its source pin');
  } catch (failure) {
    await archiveHandle.close().catch(() => {});
    throw failure;
  }
  const source = archiveHandle.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 });
  const archiveHasher = createHash('sha256');
  const compressedHash = new Transform({ transform(chunk, _encoding, callback) { archiveHasher.update(chunk); callback(null, chunk); } });
  const gunzip = createGunzip();
  source.pipe(compressedHash).pipe(gunzip);
  const expandedCap = config.maxExpandedArchiveBytes ?? MAX_EXPANDED_ARCHIVE_BYTES;
  const memberCap = config.maxArchiveMemberBytes ?? MAX_ARCHIVE_MEMBER_BYTES;
  const memberCountCap = config.maxArchiveMembers ?? MAX_ARCHIVE_MEMBERS;
  const reader = new StreamReader(gunzip, expandedCap);
  const seenRequiredMembers = new Set();
  let rows;
  let testClipIds = new Set();
  const seenTestAudio = new Set();
  let durations;
  let durationBytes;
  let audioStarted = false;
  const audioHashes = new Map();
  const selectedIds = new Set();
  let selectedBytes = 0;
  let memberCount = 0;
  try {
    while (true) {
      const header = await reader.read(512);
      if (header.every((byte) => byte === 0)) {
        assert((await reader.read(512)).every((byte) => byte === 0), 'tar terminator is incomplete');
        await reader.requireZeroTail();
        const finalStat = await archiveHandle.stat();
        assert(finalStat.isFile() && finalStat.dev === openedStat.dev && finalStat.ino === openedStat.ino
          && finalStat.size === openedStat.size && finalStat.mtimeMs === openedStat.mtimeMs
          && finalStat.ctimeMs === openedStat.ctimeMs,
        'archive changed while it was being streamed');
        break;
      }
      const { path: memberPath, size, directory } = parseTarOctalHeader(header);
      memberCount += 1;
      assert(memberCount <= memberCountCap, 'archive member count exceeds safety bound');
      assert(size <= memberCap, 'archive member exceeds the per-member expanded-byte cap');
      const root = `cv-corpus-27.0-2026-09-11/${config.root}/`;
      if (directory) {
        assert(memberPath === 'cv-corpus-27.0-2026-09-11'
          || memberPath === `cv-corpus-27.0-2026-09-11/${config.root}`
          || memberPath === `${root}clips`, 'unexpected directory member path');
        continue;
      }
      if (memberPath === 'cv-corpus-27.0-2026-09-11/README.md') {
        assert(!audioStarted && size <= MAX_MEMBER_BYTES, 'README.md is oversized or appears after audio');
        await reader.skip(size);
        continue;
      }
      if (memberPath === 'README.md') {
        assert(!audioStarted && size <= MAX_MEMBER_BYTES, 'README.md is oversized or appears after audio');
        await reader.skip(size);
        continue;
      }
      assert(memberPath.startsWith(root), 'unexpected archive root or member ordering');
      const suffix = memberPath.slice(root.length);
      if (suffix === 'README.md') {
        assert(!audioStarted && size <= MAX_MEMBER_BYTES, 'README.md is oversized or appears after audio');
        await reader.skip(size);
        continue;
      }
      if (suffix.endsWith('.tsv')) {
        assert(!audioStarted, 'metadata member appears after audio members');
        if (['test.tsv', 'clip_durations.tsv'].includes(suffix)) {
          assert(!seenRequiredMembers.has(memberPath), 'duplicate required metadata archive member');
          seenRequiredMembers.add(memberPath);
        }
        if (suffix !== 'test.tsv' && suffix !== 'clip_durations.tsv') {
          assert(size <= 2 * 1024 * 1024 * 1024, 'oversized metadata TSV');
          await reader.skip(size);
          continue;
        }
        const metadataLimit = suffix === 'clip_durations.tsv' ? MAX_DURATION_TSV_BYTES : MAX_MEMBER_BYTES;
        assert(size <= metadataLimit, suffix === 'clip_durations.tsv'
          ? 'clip_durations.tsv exceeds 96 MiB parsing bound' : 'test.tsv exceeds 16 MiB parsing bound');
        const bytes = await reader.read(size, metadataLimit);
        const metadataPadding = (512 - (size % 512)) % 512;
        if (metadataPadding) await reader.read(metadataPadding);
        if (suffix === 'test.tsv') {
          assert(!rows, 'duplicate test.tsv');
          rows = parseTestTsv(bytes.toString('utf8'), config.rows);
          testClipIds = new Set(rows);
          selectedIds.clear();
          for (const id of choosePilotIds(locale, rows)) selectedIds.add(id);
        } else {
          assert(!durationBytes, 'duplicate clip_durations.tsv');
          durationBytes = bytes;
        }
        if (rows && durationBytes) {
          assert(rows.length === config.rows, 'official test.tsv row count mismatch');
          assert(selectedIds.size === PILOT_SIZE, 'insufficient official test rows for pilot');
          durations = parseSelectedDurations(durationBytes, selectedIds);
          durationBytes = undefined;
          for (const clip of selectedIds) {
            const duration = durations.get(clip);
            assert(Number.isFinite(duration), 'selected clip lacks official duration');
            assert(duration <= 30000, 'pilot clip exceeds 30 seconds');
          }
        }
      } else {
        assert(rows && durations, 'audio member encountered before both metadata TSVs');
        audioStarted = true;
        assert(suffix.startsWith('clips/') && suffix.endsWith('.mp3') && !suffix.slice(6).includes('/'), 'unsupported archive member ordering or path');
        const clip = suffix.slice(6);
        const clipPrefix = locale === 'en' ? 'common_voice_en_' : 'common_voice_ne-NP_';
        assert(new RegExp(`^${clipPrefix}\\d+\\.mp3$`, 'u').test(clip), 'clip member ID does not match pinned locale schema');
        if (testClipIds.has(clip)) {
          assert(!seenTestAudio.has(clip), 'duplicate official-test audio member path');
          seenTestAudio.add(clip);
        }
        if (selectedIds.has(clip)) assert(!audioHashes.has(clip), 'duplicate selected audio archive member');
        const hash = selectedIds.has(clip) ? createHash('sha256') : null;
        if (hash) selectedBytes += size;
        assert(selectedBytes <= MAX_SELECTED_AUDIO_BYTES, 'selected pilot audio exceeds 120 MiB');
        await reader.skip(size, hash ? (chunk) => hash.update(chunk) : undefined);
        if (hash) audioHashes.set(clip, hash.digest('hex'));
      }
    }
  } finally {
    source.destroy();
    compressedHash.destroy();
    gunzip.destroy();
    await archiveHandle.close().catch(() => {});
  }
  assert(rows && durations && audioStarted, 'archive is missing required metadata or clips');
  assert(audioHashes.size === PILOT_SIZE, 'one or more selected audio members are missing');
  const selected = [...selectedIds].sort();
  const clipManifest = selected.map((clipId) => ({ locale, sourceDatasetId: DATASETS[locale], sourceRevision: REVISION, sourceSplit: 'test', clipId, audioSha256: audioHashes.get(clipId) }));
  const clipManifestDigest = createHash('sha256').update(JSON.stringify(clipManifest)).digest('hex');
  return {
    locale, sourceDatasetId: DATASETS[locale], sourceRevision: REVISION, sourceSplit: 'test',
    pilotSizePerLocale: PILOT_SIZE, clipManifestDigest, clipManifest,
    archive: {
      basename: config.basename, localPath: path, sourceSizeBytes: ARCHIVES[locale].bytes,
      localFileSizeBytes: openedStat.size,
      localArchiveSha256: archiveHasher.digest('hex'),
      observationType: 'LOCAL_COMPRESSED_ARCHIVE_SHA256_NOT_PUBLISHER_HASH',
    },
  };
}

export async function prepareCommonVoicePilotManifest(
  { archives, metadataRoot, audioRoot, now } = {},
  { parseArchive = parseCommonVoicePilotArchive } = {},
) {
  assert(archives && Object.keys(archives).sort().join(',') === 'en,ne-NP', 'provide exactly the pinned en and ne-NP archives');
  assert(typeof parseArchive === 'function', 'archive parser must be a function');
  const manifests = [];
  for (const locale of ['en', 'ne-NP']) {
    const path = archives[locale];
    assert(typeof path === 'string' && isAbsolute(path), 'archive paths must be explicit and absolute');
    manifests.push(await parseArchive(path, locale));
  }
  const complete = {
    schemaVersion: '1.0.0', corpus: 'Mozilla Common Voice Scripted Speech 27.0',
    sourceRevision: REVISION, sourceSplit: 'test', selection: 'sha256-rank-24-per-locale',
    locales: manifests, realInferenceAdmitted: false,
  };
  const retained = await retainCommonVoicePilotMetadata(metadataRoot, audioRoot, complete, { now });
  return Object.freeze({ localeCounts: Object.freeze({ en: 24, 'ne-NP': 24 }), realInferenceAdmitted: false, retained });
}

function parseCli(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const options = {};
  const flags = new Map([
    ['--en-archive', 'enArchive'], ['--ne-np-archive', 'neArchive'],
    ['--metadata-root', 'metadataRoot'], ['--audio-root', 'audioRoot'],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const key = flags.get(args[index]);
    assert(key && args[index + 1] && !args[index + 1].startsWith('--'), 'CLI requires explicit --en-archive, --ne-np-archive, --metadata-root and --audio-root');
    assert(!Object.hasOwn(options, key), 'duplicate CLI argument');
    options[key] = args[++index];
  }
  assert(Object.keys(options).length === flags.size, 'CLI requires all four explicit arguments');
  for (const value of Object.values(options)) assert(isAbsolute(value), 'all CLI paths must be absolute');
  return options;
}

export async function runCommonVoicePilotCli(argv, {
  stdout = (line) => process.stdout.write(line),
  prepare = prepareCommonVoicePilotManifest,
} = {}) {
  const args = parseCli(argv);
  const result = await prepare({
    archives: { en: args.enArchive, 'ne-NP': args.neArchive },
    metadataRoot: args.metadataRoot, audioRoot: args.audioRoot,
  });
  stdout(`${JSON.stringify({ pilotPrepared: true, localeCounts: result.localeCounts, realInferenceAdmitted: false })}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCommonVoicePilotCli(process.argv.slice(2)).catch((error) => {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/u.test(error.code) ? ` (${error.code})` : '';
    process.stderr.write(`Common Voice pilot preparation failed${code}; local archive paths and content were not written to output.\n`);
    process.exitCode = 1;
  });
}

export const COMMON_VOICE_PILOT_LIMITS = Object.freeze({
  clipsPerLocale: PILOT_SIZE,
  maxSelectedAudioBytes: MAX_SELECTED_AUDIO_BYTES,
  maxTestTsvBytes: MAX_MEMBER_BYTES,
  maxDurationTsvBytes: MAX_DURATION_TSV_BYTES,
  maxDurationRows: MAX_DURATION_ROWS,
  maxArchiveMemberBytes: MAX_ARCHIVE_MEMBER_BYTES,
  maxExpandedArchiveBytes: MAX_EXPANDED_ARCHIVE_BYTES,
  maxArchiveMembers: MAX_ARCHIVE_MEMBERS,
});
