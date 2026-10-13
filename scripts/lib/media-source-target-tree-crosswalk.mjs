import { execFileSync } from 'node:child_process';

function git(repo, args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const details = error.stderr?.toString('utf8').trim();
    throw new Error(details || error.message);
  }
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
  const args = ['ls-tree', '-r', '-z', '--full-tree', ref];
  if (path !== '.') args.push('--', path);
  return parseLsTreeZ(git(repo, args));
}

function workingTree(repo) {
  const raw = git(repo, ['status', '--porcelain=v1', '--untracked-files=all']).toString('utf8');
  return raw.split(/\r?\n/u).filter(Boolean).map((line) => line.slice(3));
}

function observeCut(repo, ref, path) {
  const commit = readRef(repo, `${ref}^{commit}`);
  const tree = readGitTreeObjectId(repo, ref, path === '.' ? null : path);
  const entries = readTree(repo, ref, path);
  const checkoutRevision = readRef(repo, 'HEAD^{commit}');
  const branch = readBranch(repo);
  const isMainCheckout = branch === 'main';
  return {
    commit,
    tree,
    entries,
    checkout: {
      branch,
      revision: checkoutRevision,
      alignment: checkoutRevision === commit ? 'ALIGNED'
        : isMainCheckout ? 'UNVERIFIABLE_BRANCH_HEAD_MISMATCH' : 'LOCAL_BRANCH_DIFFERS_FROM_REMOTE_CUT',
    },
  };
}

export function buildMediaSourceTargetTreeCrosswalk({ targetRoot, sourceRoot }) {
  // Compare only the checked remote-tracking main cuts. A local feature branch
  // can be useful preparation evidence, but it is not a current public source cut.
  const sourceRef = 'origin/main';
  const targetRef = 'origin/main';
  let sourceCut;
  let targetCut;
  let comparison;
  const errors = [];
  try { sourceCut = observeCut(sourceRoot, sourceRef, 'services/media'); }
  catch (error) { errors.push({ repository: 'samujjwal/ghatana', ref: sourceRef, reason: String(error.message ?? error) }); }
  try { targetCut = observeCut(targetRoot, targetRef, '.'); }
  catch (error) { errors.push({ repository: 'samujjwal/ghatana-media', ref: targetRef, reason: String(error.message ?? error) }); }
  if (sourceCut && targetCut) comparison = compareSourceTargetTrees(sourceCut.entries, targetCut.entries);
  if (sourceCut?.checkout.alignment === 'UNVERIFIABLE_BRANCH_HEAD_MISMATCH') {
    errors.push({ repository: 'samujjwal/ghatana', ref: sourceRef, reason: 'UNVERIFIABLE_BRANCH_HEAD_MISMATCH' });
  }
  if (targetCut?.checkout.alignment === 'UNVERIFIABLE_BRANCH_HEAD_MISMATCH') {
    errors.push({ repository: 'samujjwal/ghatana-media', ref: targetRef, reason: 'UNVERIFIABLE_BRANCH_HEAD_MISMATCH' });
  }
  const sourceHead = sourceCut?.commit ?? null;
  const targetHead = targetCut?.commit ?? null;
  let gitVersion = null;
  try { gitVersion = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(); } catch { /* reported as unavailable */ }
  return {
    schemaVersion: 'media.source-target-tree-crosswalk.v1',
    authority: 'BOUNDED_COMMITTED_TREE_PATH_COMPARISON_ONLY',
    status: errors.length ? 'UNVERIFIABLE' : 'OBSERVED_REMOTE_TRACKING_CUTS',
    unverifiable: errors.length > 0,
    errors,
    verification: {
      profile: 'COMMITTED_GIT_TREE_PATH_COMPARISON_ONLY_NO_BUILD',
      externalRetrieval: 'NOT_VERIFIED; refs are locally available remote-tracking observations',
      gitVersion,
      nodeVersion: process.version,
      workingTreeIncluded: false,
    },
    source: {
      repository: 'samujjwal/ghatana',
      branch: readBranch(sourceRoot),
      revision: sourceHead,
      ref: sourceRef,
      tree: sourceCut?.tree ?? null,
      checkout: sourceCut?.checkout ?? null,
      workingTreePaths: workingTree(sourceRoot),
      pathPrefix: 'services/media/',
    },
    target: {
      repository: 'samujjwal/ghatana-media',
      branch: readBranch(targetRoot),
      revision: targetHead,
      ref: targetRef,
      tree: targetCut?.tree ?? null,
      checkout: targetCut?.checkout ?? null,
      workingTreePaths: workingTree(targetRoot),
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
    counts: comparison?.counts ?? null,
    entries: comparison?.entries ?? null,
  };
}
