import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  MATRIX_PATHS,
  ROSTER_RECONCILIATION_PATH,
  ROSTER_RECONCILIATION_SCHEMA,
  TOPOLOGY_PATH,
  reconcileMediaSurfaceRoster
} from './lib/media-surface-roster-reconciliation.mjs';

const root = process.cwd();
const read = p => fs.readFileSync(`${root}/${p}`);
const sha = p => crypto.createHash('sha256').update(read(p)).digest('hex');
const topology = JSON.parse(read(TOPOLOGY_PATH));
const matrices = MATRIX_PATHS.map(path => ({ path, matrix: JSON.parse(read(path)) }));
const result = reconcileMediaSurfaceRoster({ topology, matrices });

const record = {
  schemaVersion: ROSTER_RECONCILIATION_SCHEMA,
  authority: 'Generated Track A roster reconciliation; not PDP status, Lifecycle admission, or closure authority.',
  claimsBoundary: 'Matrix-bound rows keep their existing source-owned phase status. Delta rows have no phase status until their owning matrix generators are extended; no N/A, DEV_COMPLETE or receipt is inferred here.',
  sourcePins: Object.fromEntries([TOPOLOGY_PATH, ...MATRIX_PATHS].map(path => [path, sha(path)])),
  ...result
};
const text = JSON.stringify(record, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (!fs.existsSync(`${root}/${ROSTER_RECONCILIATION_PATH}`) || read(ROSTER_RECONCILIATION_PATH).toString('utf8') !== text) {
    console.error(`${ROSTER_RECONCILIATION_PATH} is stale; run node scripts/reconcile-media-surface-roster.mjs`);
    process.exit(1);
  }
  console.log(`PASS ${ROSTER_RECONCILIATION_PATH} current (${result.census.total} identities, ${result.census.matrixBound} matrix-bound, ${result.census.matrixDelta} declared delta)`);
} else {
  fs.writeFileSync(`${root}/${ROSTER_RECONCILIATION_PATH}`, text);
  console.log(`Wrote ${ROSTER_RECONCILIATION_PATH} (${result.census.total} identities, ${result.census.matrixBound} matrix-bound, ${result.census.matrixDelta} declared delta)`);
}
