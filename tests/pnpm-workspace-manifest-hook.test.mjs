import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const mediaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const readPackage = require(path.join(mediaRoot, '.pnpmfile.cjs')).hooks.readPackage;

function readProjection(repositoryRoot, relativePath) {
  return parse(fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8'));
}

function readCanonicalManifest(repositoryRoot, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8'));
}

test('Lifecycle evidence-contracts projection resolves to its canonical npm dependency maps', () => {
  const lifecycleRoot = path.resolve(mediaRoot, '../ghatana-lifecycle');
  const projection = readProjection(lifecycleRoot, 'libs/evidence-contracts/package.yaml');
  const canonical = readCanonicalManifest(lifecycleRoot, 'libs/evidence-contracts/package.json');

  assert.equal(projection.repositoryRef, 'ghatana:ghatana-lifecycle');
  assert.equal(projection.layoutStandard, 'ghatana.kernel-compat.temp.v1');

  const resolved = readPackage(projection, { dir: path.join(lifecycleRoot, 'libs/evidence-contracts') });

  assert.equal(resolved.name, canonical.name);
  assert.equal(resolved.version, canonical.version);
  assert.deepEqual(resolved.dependencies ?? {}, canonical.dependencies ?? {});
  assert.deepEqual(resolved.devDependencies ?? {}, canonical.devDependencies ?? {});
  assert.equal(resolved.dependencies['@ghatana/tool-platform-contracts'], 'workspace:*');
  assert.equal('@ghatana/lifecycle-protected-host-files-native' in (resolved.dependencies ?? {}), false);
});

test('unrelated package manifests pass through unchanged', () => {
  const unrelated = {
    name: '@audio-video/client',
    dependencies: { react: '^19.0.0' },
    devDependencies: { typescript: '^6.0.0' },
  };

  assert.strictEqual(readPackage(unrelated, {}), unrelated);
});

test('temporary projections from owners outside the Media workspace dispatch pass through unchanged', () => {
  const unrelatedProjection = {
    kind: 'package',
    layoutStandard: 'ghatana.kernel-compat.temp.v1',
    repositoryRef: 'ghatana:ghatana-tools',
    name: '@ghatana/unincluded-tools-package',
    dependencies: { projectionOnly: '1.0.0' },
  };

  assert.strictEqual(readPackage(unrelatedProjection, {}), unrelatedProjection);
});
