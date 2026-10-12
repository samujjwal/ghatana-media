import { execFileSync } from 'node:child_process';

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'buffer' });
}

export function parseLsTreeZ(raw) {
  const entries = new Map();
  for (const record of raw.toString('utf8').split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) throw new Error(`Invalid git ls-tree record: ${record}`);
    const [mode, type, objectId] = record.slice(0, tab).split(' ');
    if (!mode || type !== 'blob' || !objectId) {
      throw new Error(`Expected a blob entry in git ls-tree output: ${record}`);
    }
    const path = record.slice(tab + 1);
    if (entries.has(path)) throw new Error(`Duplicate git tree path: ${path}`);
    entries.set(path, { mode, objectId });
  }
  return entries;
}

export function compareSourceTargetTrees(sourceTree, targetTree, sourcePrefix = 'services/media/') {
  const entries = [];
  for (const [sourcePath, source] of [...sourceTree].sort(([a], [b]) => a.localeCompare(b))) {
    if (!sourcePath.startsWith(sourcePrefix)) {
      throw new Error(`Source path is outside ${sourcePrefix}: ${sourcePath}`);
    }
    const targetPath = sourcePath.slice(sourcePrefix.length);
    const target = targetTree.get(targetPath);
    const classification = !target
      ? 'ABSENT_AT_SAME_RELATIVE_PATH'
      : target.mode === source.mode && target.objectId === source.objectId
        ? 'PRESENT_IDENTICAL_MODE_AND_BLOB'
        : 'PRESENT_DIFFERENT_MODE_OR_BLOB';
    entries.push({
      sourcePath,
      targetPath,
      sourceMode: source.mode,
      sourceObjectId: source.objectId,
      targetMode: target?.mode ?? null,
      targetObjectId: target?.objectId ?? null,
      classification,
    });
  }

  const counts = {
    sourceTrackedPathCount: entries.length,
    identicalModeAndBlobCount: entries.filter((entry) => entry.classification === 'PRESENT_IDENTICAL_MODE_AND_BLOB').length,
    differentModeOrBlobCount: entries.filter((entry) => entry.classification === 'PRESENT_DIFFERENT_MODE_OR_BLOB').length,
    absentAtSameRelativePathCount: entries.filter((entry) => entry.classification === 'ABSENT_AT_SAME_RELATIVE_PATH').length,
  };
  if (counts.sourceTrackedPathCount !== counts.identicalModeAndBlobCount
      + counts.differentModeOrBlobCount + counts.absentAtSameRelativePathCount) {
    throw new Error('Crosswalk denominators do not reconcile');
  }
  return { counts, entries };
}

function readRef(repo, ref) {
  return git(repo, ['rev-parse', ref]).toString('utf8').trim();
}

export function readGitTreeObjectId(repo, ref = 'HEAD', path = null) {
  const treeish = path ? `${ref}:${path}` : `${ref}^{tree}`;
  return readRef(repo, treeish);
}

function readBranch(repo) {
  return git(repo, ['branch', '--show-current']).toString('utf8').trim() || '(detached HEAD)';
}

function readTree(repo, ref, path) {
  return parseLsTreeZ(git(repo, ['ls-tree', '-r', '-z', '--full-tree', ref, '--', path]));
}

export function buildMediaSourceTargetTreeCrosswalk({ targetRoot, sourceRoot }) {
  const sourceRef = 'HEAD';
  const targetRef = 'HEAD';
  const sourceHead = readRef(sourceRoot, sourceRef);
  const targetHead = readRef(targetRoot, targetRef);
  const sourceTree = readTree(sourceRoot, sourceRef, 'services/media');
  const targetTree = readTree(targetRoot, targetRef, '.');
  const comparison = compareSourceTargetTrees(sourceTree, targetTree);
  return {
    schemaVersion: 'media.source-target-tree-crosswalk.v1',
    authority: 'BOUNDED_COMMITTED_TREE_PATH_COMPARISON_ONLY',
    source: {
      repository: 'samujjwal/ghatana',
      branch: readBranch(sourceRoot),
      revision: sourceHead,
      tree: readGitTreeObjectId(sourceRoot, sourceRef, 'services/media'),
      pathPrefix: 'services/media/',
    },
    target: {
      repository: 'samujjwal/ghatana-media',
      branch: readBranch(targetRoot),
      revision: targetHead,
      tree: readGitTreeObjectId(targetRoot, targetRef),
      pathPrefix: '',
    },
    method: {
      comparison: 'source services/media paths stripped to their relative target-root paths',
      identity: 'exact Git mode and blob object ID',
      sourceTreeIncludesWorkingTreeEdits: false,
      targetTreeIncludesWorkingTreeEdits: false,
      ownershipOrSemanticParityInferred: false,
      pathMapRelocationsApplied: false,
    },
    counts: comparison.counts,
    entries: comparison.entries,
  };
}
