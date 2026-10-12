import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMediaSourceTargetTreeCrosswalk } from './lib/media-source-target-tree-crosswalk.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const report = buildMediaSourceTargetTreeCrosswalk({
  targetRoot: root,
  sourceRoot: resolve(root, '..', 'ghatana'),
});
const outputPath = resolve(root, 'docs/migration/evidence/media-source-target-tree-crosswalk-2026-10-12.json');
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({
  source: report.source,
  target: report.target,
  counts: report.counts,
  outputPath,
}, null, 2)}\n`);
