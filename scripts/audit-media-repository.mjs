#!/usr/bin/env node
/**
 * Repository-wide, read-only cleanup audit. Inspects every Git-tracked file,
 * including historical evidence and binary artifacts, without inventing a
 * runtime/release claim or deleting provenance. No sibling repo dependency.
 *
 * Usage:
 *   node scripts/audit-media-repository.mjs [--json] [--check]
 * --check only fails for broken local links in maintained entry-point docs.
 * All other findings are review candidates, not automatic removals.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (arg !== '--json' && arg !== '--check') {
    throw new Error('Usage: node scripts/audit-media-repository.mjs [--json] [--check]');
  }
}
const textExtensions = new Set([
  '.md', '.json', '.yaml', '.yml', '.txt', '.mjs', '.js', '.ts', '.tsx', '.css',
  '.html', '.java', '.kt', '.kts', '.py', '.rs', '.sh', '.toml', '.proto',
  '.gradle', '.properties', '.xml', '.sql', '.example'
]);
const mandatoryDocs = new Set([
  'README.md', 'docs/README.md', 'BOUNDARY.md', 'OWNER.md', 'docs/VISION.md',
  'docs/REQUIREMENTS.md', 'docs/ARCHITECTURE.md', 'docs/DESIGN.md',
  'docs/OPERATIONS.md', 'docs/TESTING.md'
]);
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'buffer' })
  .toString('utf8').split('\0').filter(Boolean).sort();
const trackedSet = new Set(tracked);
const absolute = (name) => resolve(root, name);
const decode = (value) => {
  try { return decodeURIComponent(value); } catch { return value; }
};
const category = (path) => {
  if (path.startsWith('archive/')) return 'archived-compatibility';
  if (path.startsWith('docs/implementation/verification/')) return 'historical-verification';
  if (path.startsWith('.product-experience/pdp-')) return 'canonical-product-definition';
  if (path.startsWith('.product-experience/')) return 'product-definition-index-or-projection';
  if (path.startsWith('migration/') || path.startsWith('docs/migration/')) return 'migration-provenance';
  if (path.startsWith('docs/')) return 'documentation';
  if (path.startsWith('tests/') || path.includes('/src/test/')) return 'tests';
  if (path.startsWith('apps/') || path.startsWith('libs/audio-video-')) return 'client-or-explorer';
  if (path.startsWith('modules/') || path.startsWith('launcher/') ||
      path.startsWith('providers/') || path.startsWith('runtime-contracts/') ||
      path.startsWith('adapters/')) return 'prepared-runtime-source';
  if (path.startsWith('scripts/') || path.startsWith('config/')) return 'tooling-or-config';
  return 'repository-root-or-other';
};
const isText = (path) => {
  const base = path.split('/').at(-1);
  const dot = base.lastIndexOf('.');
  return (dot !== -1 && textExtensions.has(base.slice(dot))) ||
    ['Dockerfile', 'Makefile', '.gitignore', '.gitattributes', 'gradlew'].includes(base);
};
const directoryTracked = (prefix) => {
  const withSlash = prefix.endsWith('/') ? prefix : prefix + '/';
  return tracked.some((path) => path.startsWith(withSlash));
};
function relativeLinks(markdown, from) {
  const results = [];
  const exp = /(?<!!)\[[^\]]*]\((<[^>]+>|[^)\s]+)(?:\s+["'][^)]*["'])?\)/g;
  for (const match of markdown.matchAll(exp)) {
    const raw = match[1].replace(/^<|>$/g, '');
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/iu.test(raw)) continue;
    const target = decode(raw.split('#', 1)[0].split('?', 1)[0]);
    if (!target) continue;
    const full = resolve(root, dirname(from), target);
    const rel = relative(root, full);
    if (rel === '..' || rel.startsWith('..' + sep)) {
      results.push({ source: from, target: raw, reason: 'LINK_OUTSIDE_REPOSITORY' });
      continue;
    }
    const canonical = normalize(rel).split(sep).join('/');
    if (!trackedSet.has(canonical) && !directoryTracked(canonical)) {
      results.push({ source: from, target: raw, reason: 'UNRESOLVED_TRACKED_PATH' });
    }
  }
  return results;
}

const groups = {};
const digests = new Map();
const missing = [];
const unreadable = [];
const brokenLinks = [];
const compatibilityNames = [];
const referencedArchivePaths = new Map();
const legacyLogFiles = [];
let totalBytes = 0;
let scannedFiles = 0;
let textFiles = 0;
let symlinks = 0;
for (const path of tracked) {
  let bytes;
  try {
    const entry = lstatSync(absolute(path));
    if (entry.isSymbolicLink()) {
      symlinks++;
      bytes = Buffer.from(readlinkSync(absolute(path)), 'utf8');
    } else {
      bytes = readFileSync(absolute(path));
    }
  } catch (failure) {
    unreadable.push({ path, reason: failure?.code || 'UNKNOWN_READ_FAILURE' });
    continue;
  }
  scannedFiles++;
  totalBytes += bytes.length;
  const group = category(path);
  groups[group] ??= { files: 0, bytes: 0 };
  groups[group].files++;
  groups[group].bytes += bytes.length;
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (!digests.has(hash)) digests.set(hash, []);
  digests.get(hash).push(path);
  if (path.endsWith('.log')) legacyLogFiles.push(path);
  if (/^(?:AUDIO_VIDEO_|SERVICE_ENDPOINTS_CONFIG|ARCHITECTURE_ALIGNMENT_SUMMARY)/u.test(path)) {
    compatibilityNames.push({ path, reason: 'HISTORICAL_ALIAS_CHECK_CONSUMERS_BEFORE_RENAME' });
  }
  if (!isText(path)) continue;
  textFiles++;
  const content = bytes.toString('utf8');
  if (path.endsWith('.md')) brokenLinks.push(...relativeLinks(content, path));
  if (!path.startsWith('archive/')) {
    for (const match of content.matchAll(/archive\/media-desktop-apps\/[a-zA-Z0-9_.\/-]+/gu)) {
      const target = match[0].replace(/[),.;]+$/u, '');
      referencedArchivePaths.set(target, (referencedArchivePaths.get(target) || 0) + 1);
    }
  }
  if (mandatoryDocs.has(path) &&
      /Only the P0-001 migration boundary slice is accepted in the current source tree/u.test(content)) {
    missing.push({ path, reason: 'MAINTAINED_DOCUMENT_CONTAINS_STALE_PDP_COMPLETION_CLAIM' });
  }
}
const duplicates = [...digests].filter(([, values]) => values.length > 1)
  .map(([sha256, paths]) => ({ sha256, paths })).sort((a, b) =>
    a.paths[0].localeCompare(b.paths[0]));
const activeDupes = duplicates.filter((group) =>
  group.paths.filter((p) => !p.startsWith('archive/') &&
    !p.startsWith('docs/implementation/verification/')).length > 1);
const result = {
  schemaVersion: 'media.repository-hygiene-audit.v1',
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  trackedFiles: tracked.length,
  scannedFiles,
  unreadable,
  totalBytes,
  textFiles,
  symlinks,
  categories: Object.fromEntries(Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))),
  duplicateGroups: duplicates,
  activeDuplicateGroups: activeDupes,
  historicalLogFileCount: legacyLogFiles.length,
  historicalLogFiles: legacyLogFiles,
  compatibilityNames,
  referencedArchivedPaths: [...referencedArchivePaths].map(([path, references]) =>
    ({ path, references })).sort((a, b) => a.path.localeCompare(b.path)),
  brokenRelativeMarkdownLinks: brokenLinks,
  maintainedDocumentDrift: missing,
  policy: {
    autoDelete: false,
    protected: ['normative PDP IDs', 'public compatibility coordinates',
      'source manifests and migration inventories', 'receipt/version source cuts',
      'archived paths referenced by source or historical review'],
    interpretation: 'Candidate report only; remove after path/consumer/test proof.'
  }
};
if (args.has('--json')) console.log(JSON.stringify(result, null, 2));
else {
  console.log('Ghatana Media tracked-file hygiene inventory');
  console.log('  revision:', result.sourceRevision);
  console.log('  tracked/scanned:', tracked.length, scannedFiles);
  console.log('  file bytes:', totalBytes);
  console.log('  categories:', JSON.stringify(result.categories));
  console.log('  exact duplicate groups:', duplicates.length, '(active:', activeDupes.length + ')');
  console.log('  historical log files:', legacyLogFiles.length);
  console.log('  compatibility aliases:', compatibilityNames.length);
  console.log('  archived source references:', referencedArchivePaths.size);
  console.log('  broken local markdown links:', brokenLinks.length);
  console.log('  maintained document drift:', missing.length);
  console.log('Use --json for path-by-path findings; none are auto-removed.');
}
const blockingLinks = brokenLinks.filter((entry) => mandatoryDocs.has(entry.source));
if (args.has('--check') && (blockingLinks.length || missing.length || unreadable.length)) {
  console.error('Maintained-document link/drift or unreadable-file checks failed:',
    JSON.stringify({ blockingLinks, missing, unreadable }, null, 2));
  process.exitCode = 1;
}
