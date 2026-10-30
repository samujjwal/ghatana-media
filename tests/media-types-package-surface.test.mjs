// TY-05/06: the public package surface is exactly one authority — index.ts is
// the source; the handwritten index.d.ts compat mirror must never drift, and
// the two subpath exports (./contracts, ./production) are the only contract
// registries. No second schema source is allowed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(repo, 'libs/audio-video-types/src');
const pkg = JSON.parse(readFileSync(join(repo, 'libs/audio-video-types/package.json'), 'utf8'));

const indexSrc = readFileSync(join(srcDir, 'index.ts'), 'utf8');
const indexDts = readFileSync(join(srcDir, 'index.d.ts'), 'utf8');

function exportedNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:declare\s+)?(?:type\s+|interface\s+|class\s+|const\s+|function\s+|enum\s+)(\w+)/g)) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name.replace(/^type\s+/, ''));
    }
  }
  return names;
}

test('TY-06: index.d.ts mirrors every index.ts export and adds nothing', () => {
  const ts = exportedNames(indexSrc);
  const dts = exportedNames(indexDts);
  for (const n of ts) assert.ok(dts.has(n), `index.d.ts missing export ${n}`);
  for (const n of dts) assert.ok(ts.has(n), `index.d.ts declares ${n} absent from index.ts`);
});

test('TY-05: package exposes exactly the declared subpaths, all backed by real modules', () => {
  const subpaths = Object.keys(pkg.exports).filter((k) => k !== '.');
  for (const sub of subpaths) {
    const entry = pkg.exports[sub];
    const target = join(srcDir, entry.import.replace('./dist/', '').replace('.js', '.ts'));
    assert.ok(existsSync(target), `${sub} → ${entry.import} has no source module`);
  }
  assert.deepEqual([...subpaths].sort(), ['./contracts', './production'],
    'exactly two contract subpaths — no second registry');
});

test('TY-05/06: no duplicate semantic type authority inside the package', () => {
  const schemaFiles = readdirSync(srcDir).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'));
  // Each file is a distinct bounded surface; the contract registry lives once.
  for (const f of schemaFiles) {
    const src = readFileSync(join(srcDir, f), 'utf8');
    const dup = /export\s+const\s+(\w+)Schema/g;
    for (const m of src.matchAll(dup)) {
      for (const other of schemaFiles) {
        if (other === f) continue;
        assert.ok(!readFileSync(join(srcDir, other), 'utf8').includes(`export const ${m[1]}Schema`),
          `${m[1]}Schema is declared in both ${f} and ${other} — duplicate authority`);
      }
    }
  }
});
