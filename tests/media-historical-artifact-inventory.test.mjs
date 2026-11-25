import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generator = path.join(repositoryRoot, 'scripts/media-historical-artifact-inventory.mjs');

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function run(root, ...args) {
  return spawnSync(process.execPath, [path.join(root, 'scripts/media-historical-artifact-inventory.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

test('inventory --check is read-only and detects stale tracked bytes', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'media-historical-inventory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const scripts = path.join(root, 'scripts');
  const implementation = path.join(root, 'docs/implementation');
  const development = path.join(root, 'docs/development');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(implementation, { recursive: true });
  mkdirSync(development, { recursive: true });
  copyFileSync(generator, path.join(scripts, 'media-historical-artifact-inventory.mjs'));
  writeFileSync(path.join(implementation, 'source-note.md'), 'original historical source; see source-note.md\n');
  writeFileSync(path.join(implementation, 'source-reference.md'), 'source-note.md source-note.md\n');
  writeFileSync(path.join(development, 'historical-content-preservation.json'), JSON.stringify({
    deletionApproved: false,
    externalArchiveVerified: false,
    total: 0,
    artifacts: [],
  }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', 'docs'], { cwd: root });

  const generated = run(root);
  assert.equal(generated.status, 0, generated.stderr);
  const outputPath = path.join(implementation, 'historical-artifact-inventory.v1.json');
  const currentOutput = readFileSync(outputPath);
  const currentDigest = digest(currentOutput);
  const sourceNote = JSON.parse(currentOutput).artifacts.find((item) =>
    item.path === 'docs/implementation/source-note.md');
  assert.equal(sourceNote.inboundReferences, 1, 'other historical files count once; self-mentions do not count');

  const currentCheck = run(root, '--check');
  assert.equal(currentCheck.status, 0, currentCheck.stderr);
  assert.equal(digest(readFileSync(outputPath)), currentDigest);

  writeFileSync(path.join(implementation, 'source-note.md'), 'updated historical source\n');
  const staleCheck = run(root, '--check');
  assert.equal(staleCheck.status, 1);
  assert.match(staleCheck.stderr, /HISTORICAL_INVENTORY_STALE/u);
  assert.equal(digest(readFileSync(outputPath)), currentDigest);
});
