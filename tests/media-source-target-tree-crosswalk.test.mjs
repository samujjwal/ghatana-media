import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareSourceTargetTrees, parseLsTreeZ, readGitTreeObjectId } from '../scripts/lib/media-source-target-tree-crosswalk.mjs';

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
