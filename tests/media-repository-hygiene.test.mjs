import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = () => execFileSync('node', ['scripts/audit-media-repository.mjs', '--json'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});

test('repository hygiene audit inspects every tracked file without changing it', () => {
  const audit = JSON.parse(source());
  const list = execFileSync('git', ['ls-files', '-z'], {
    cwd: root, encoding: 'utf8'
  }).split('\0').filter(Boolean);
  assert.equal(audit.schemaVersion, 'media.repository-hygiene-audit.v1');
  assert.equal(audit.trackedFiles, list.length);
  assert.equal(audit.scannedFiles, list.length);
  assert.deepEqual(audit.unreadable, []);
  assert.ok(['COMMITTED_HEAD_TRACKED_BYTES', 'HEAD_WITH_LOCAL_TRACKED_MODIFICATIONS'].includes(audit.sourceObservation));
  assert.ok(Array.isArray(audit.localTrackedDeltaPaths));
  assert.equal(audit.sourceObservation === 'COMMITTED_HEAD_TRACKED_BYTES', audit.localTrackedDeltaPaths.length === 0);
  assert.equal(audit.policy.autoDelete, false);
  assert.ok(audit.totalBytes > 0);
  assert.ok(audit.categories['canonical-product-definition']?.files > 0);
  assert.ok(audit.categories['historical-verification']?.files > 0);
  assert.ok(audit.categories['prepared-runtime-source']?.files > 0);
});

test('audit output is stable for an unchanged checkout and contains exact paths', () => {
  const a = JSON.parse(source());
  const b = JSON.parse(source());
  assert.deepEqual(a, b);
  assert.ok(Array.isArray(a.duplicateGroups));
  assert.ok(Array.isArray(a.brokenRelativeMarkdownLinks));
  assert.ok(Array.isArray(a.referencedArchivedPaths));
  assert.ok(Array.isArray(a.compatibilityNames));
  assert.ok(Array.isArray(a.nonPortableBuildRecipes));
  assert.ok(a.historicalLogFiles.every((path) => path.endsWith('.log')));
});
