import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const commonDir = join(repo, 'libs/common/src/main/java');
const census = JSON.parse(readFileSync(
  join(repo, 'docs/implementation/media-libs-common-census.v1.json'), 'utf8'));

const walk = (dir) => readdirSync(dir, { withFileTypes: true, recursive: true })
  .filter((e) => e.isFile() && e.name.endsWith('.java'))
  .map((e) => relative(commonDir, join(e.parentPath, e.name)).replaceAll('\\', '/'));

const files = walk(commonDir);
const classified = new Set();
for (const list of Object.values(census.classification)) {
  for (const entry of list.types) {
    classified.add(entry.split(/[\s(:]/)[0].split('.').pop());
  }
}

test('MC-01: every libs/common type is classified in the census', () => {
  assert.ok(files.length > 0, 'libs/common sources exist');
  for (const file of files) {
    const simpleName = file.replace(/\.java$/, '').split('/').pop();
    assert.ok(classified.has(simpleName),
      `${file} is not classified in media-libs-common-census.v1.json`);
  }
  // Every claimed classification names a real type.
  for (const name of classified) {
    assert.ok(files.some((f) => f.endsWith(`${name}.java`)),
      `census claims ${name} but no such source exists`);
  }
});

test('MC-01: no duplicate engine/provider/cache types are present', () => {
  for (const key of ['DUPLICATE_ENGINE', 'DUPLICATE_PROVIDER', 'DUPLICATE_CACHE']) {
    assert.deepEqual(census.classification[key].types, [],
      `${key} must stay empty — reimplementations are forbidden, not registered`);
  }
});

test('MC-01: ad-hoc metrics collector stays marked for reuse review', () => {
  const reuse = census.classification.REUSE_REVIEW.types.join('\n');
  assert.match(reuse, /MediaProcessingMetrics/);
  const src = readFileSync(
    join(commonDir, 'com/ghatana/audio/video/common/observability/MediaProcessingMetrics.java'), 'utf8');
  assert.match(src, /zero-dependency/, 'MediaProcessingMetrics remains the bounded no-Micrometer variant');
});
