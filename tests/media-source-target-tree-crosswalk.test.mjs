import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildMediaSourceTargetTreeCrosswalk, compareSourceTargetTrees, parseLsTreeZ, readGitTreeObjectId } from '../scripts/lib/media-source-target-tree-crosswalk.mjs';

function git(repo, ...args) {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
}

test('parses NUL-delimited git tree records, including executable and symlink modes', () => {
  const entries = parseLsTreeZ(Buffer.from([
    '100644 blob abc123\tservices/media/a.txt\0',
    '100755 blob def456\tservices/media/run.sh\0',
    '120000 blob ghi789\tservices/media/link\0',
  ].join(''), 'utf8'));
  assert.deepEqual([...entries], [
    ['services/media/a.txt', { mode: '100644', objectId: 'abc123' }],
    ['services/media/run.sh', { mode: '100755', objectId: 'def456' }],
    ['services/media/link', { mode: '120000', objectId: 'ghi789' }],
  ]);
});

test('compares exact relative paths, modes, and blobs with a reconciled denominator', () => {
  const source = new Map([
    ['services/media/same.txt', { mode: '100644', objectId: 'one' }],
    ['services/media/changed.txt', { mode: '100644', objectId: 'two' }],
    ['services/media/absent.txt', { mode: '100755', objectId: 'three' }],
  ]);
  const target = new Map([
    ['same.txt', { mode: '100644', objectId: 'one' }],
    ['changed.txt', { mode: '100644', objectId: 'different' }],
  ]);
  const result = compareSourceTargetTrees(source, target);
  assert.deepEqual(result.counts, {
    sourceTrackedPathCount: 3,
    identicalModeAndBlobCount: 1,
    differentModeOrBlobCount: 1,
    absentAtSameRelativePathCount: 1,
  });
  assert.deepEqual(result.entries.map(({ classification }) => classification), [
    'ABSENT_AT_SAME_RELATIVE_PATH',
    'PRESENT_DIFFERENT_MODE_OR_BLOB',
    'PRESENT_IDENTICAL_MODE_AND_BLOB',
  ]);
});

test('reads the commit tree object instead of mistaking the commit ID for the tree ID', () => {
  const repo = mkdtempSync(join(tmpdir(), 'media-crosswalk-tree-'));
  try {
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.invalid');
    git(repo, 'config', 'user.name', 'Test');
    mkdirSync(join(repo, 'nested'));
    writeFileSync(join(repo, 'nested', 'source.txt'), 'source\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'fixture');

    const commit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const rootTree = readGitTreeObjectId(repo);
    const nestedTree = readGitTreeObjectId(repo, 'HEAD', 'nested');
    assert.equal(rootTree, execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim());
    assert.equal(nestedTree, execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD:nested'], { encoding: 'utf8' }).trim());
    assert.notEqual(rootTree, commit);
    assert.notEqual(nestedTree, rootTree);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('marks missing remote source cuts UNVERIFIABLE instead of emitting an empty comparison', () => {
  const source = mkdtempSync(join(tmpdir(), 'media-crosswalk-source-'));
  const target = mkdtempSync(join(tmpdir(), 'media-crosswalk-target-'));
  try {
    for (const repo of [source, target]) {
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'config', 'user.email', 'test@example.invalid');
      git(repo, 'config', 'user.name', 'Test');
      mkdirSync(join(repo, 'services/media'), { recursive: true });
      writeFileSync(join(repo, 'services/media/a.txt'), 'source\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'fixture');
    }
    const report = buildMediaSourceTargetTreeCrosswalk({ sourceRoot: source, targetRoot: target });
    assert.equal(report.status, 'UNVERIFIABLE');
    assert.equal(report.unverifiable, true);
    assert.equal(report.counts, null);
    assert.equal(report.entries, null);
    assert.ok(report.errors.some(({ repository, reason }) => repository === 'samujjwal/ghatana' && reason.length > 0));
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('flags a main branch and remote-cut head mismatch as UNVERIFIABLE', () => {
  const source = mkdtempSync(join(tmpdir(), 'media-crosswalk-mismatch-source-'));
  const target = mkdtempSync(join(tmpdir(), 'media-crosswalk-mismatch-target-'));
  try {
    for (const repo of [source, target]) {
      git(repo, 'init', '-q', '-b', 'main');
      git(repo, 'config', 'user.email', 'test@example.invalid');
      git(repo, 'config', 'user.name', 'Test');
      mkdirSync(join(repo, 'services/media'), { recursive: true });
      writeFileSync(join(repo, 'services/media/a.txt'), 'first\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'first');
      const first = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      git(repo, 'update-ref', 'refs/remotes/origin/main', first);
      writeFileSync(join(repo, 'services/media/a.txt'), 'second\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'second');
    }
    const report = buildMediaSourceTargetTreeCrosswalk({ sourceRoot: source, targetRoot: target });
    assert.equal(report.status, 'UNVERIFIABLE');
    assert.ok(report.errors.some(({ reason }) => reason === 'UNVERIFIABLE_BRANCH_HEAD_MISMATCH'));
    assert.ok(report.counts, 'the raw tree comparison remains inspectable alongside the mismatch');
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test('current source-cut evidence pins both remote-tracking trees and keeps checkout drift separate', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const report = JSON.parse(readFileSync(join(root, 'docs/migration/evidence/media-source-target-tree-crosswalk-current-2026-10-12.json'), 'utf8'));
  assert.equal(report.status, 'OBSERVED_REMOTE_TRACKING_CUTS');
  assert.equal(report.unverifiable, false);
  assert.match(report.source.revision, /^[a-f0-9]{40}$/u);
  assert.match(report.target.revision, /^[a-f0-9]{40}$/u);
  assert.match(report.source.tree, /^[a-f0-9]{40}$/u);
  assert.match(report.target.tree, /^[a-f0-9]{40}$/u);
  assert.equal(report.verification.workingTreeIncluded, false);
  assert.match(report.verification.externalRetrieval, /NOT_VERIFIED/u);
  assert.ok(['ALIGNED', 'LOCAL_BRANCH_DIFFERS_FROM_REMOTE_CUT'].includes(report.source.checkout.alignment));
  assert.equal(report.target.checkout.alignment, 'ALIGNED');
  assert.deepEqual(report.counts, {
    sourceTrackedPathCount: report.entries.length,
    identicalModeAndBlobCount: report.entries.filter(({ classification }) => classification === 'PRESENT_IDENTICAL_MODE_AND_BLOB').length,
    differentModeOrBlobCount: report.entries.filter(({ classification }) => classification === 'PRESENT_DIFFERENT_MODE_OR_BLOB').length,
    absentAtSameRelativePathCount: report.entries.filter(({ classification }) => classification === 'ABSENT_AT_SAME_RELATIVE_PATH').length,
  });
});
