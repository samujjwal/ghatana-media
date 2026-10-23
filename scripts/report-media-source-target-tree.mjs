import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMediaSourceTargetTreeCrosswalk } from './lib/media-source-target-tree-crosswalk.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const report = buildMediaSourceTargetTreeCrosswalk({
  targetRoot: root,
  sourceRoot: resolve(root, '..', 'ghatana'),
});
// Keep each observation date-scoped. The previous fixed path was dated
// 2026-10-12 and a refresh silently replaced that historical source cut.
const observationDate = new Date().toISOString().slice(0, 10);
const outputPath = resolve(root, `docs/migration/evidence/media-source-target-tree-crosswalk-current-${observationDate}.json`);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
const currentSourceObservation = {
  schemaVersion: 'media.current-source-cut-observation.v1',
  authority: 'LOCAL_CURRENT_SOURCE_OBSERVATION_NO_OWNER_AUTHORITY_OR_EXTERNAL_RETRIEVAL_CLAIM',
  status: report.status,
  profile: report.verification.profile,
  externalRetrieval: report.verification.externalRetrieval,
  committedPair: {
    source: { repository: report.source.repository, ref: report.source.ref, revision: report.source.revision, tree: report.source.tree, pathPrefix: report.source.pathPrefix },
    target: { repository: report.target.repository, ref: report.target.ref, revision: report.target.revision, tree: report.target.tree, pathPrefix: report.target.pathPrefix },
  },
  localCheckouts: {
    source: {
      branch: report.source.checkout?.branch ?? report.source.branch,
      revision: report.source.checkout?.revision ?? null,
      alignment: report.source.checkout?.alignment ?? 'UNVERIFIABLE',
      localOnlyRevision: report.source.checkout?.alignment === 'LOCAL_BRANCH_DIFFERS_FROM_REMOTE_CUT'
        ? report.source.checkout.revision : null,
      dirtyDeltas: {
        allPaths: report.source.workingTreePaths,
        canonicalMediaPaths: report.source.workingTreePaths.filter((path) => path.startsWith('services/media/')),
        unrelatedPaths: report.source.workingTreePaths.filter((path) => !path.startsWith('services/media/')),
      },
    },
    target: {
      branch: report.target.checkout?.branch ?? report.target.branch,
      revision: report.target.checkout?.revision ?? null,
      alignment: report.target.checkout?.alignment ?? 'UNVERIFIABLE',
      dirtyDeltas: {
        allPaths: report.target.workingTreePaths,
        mediaRepositoryPaths: report.target.workingTreePaths,
      },
    },
  },
  comparison: { counts: report.counts, sourceTrackedPathCount: report.entries?.length ?? null },
  errors: report.errors,
};
const currentSourceOutputPath = resolve(root, `docs/implementation/verification/current-source-cut-observation-${observationDate}.json`);
mkdirSync(dirname(currentSourceOutputPath), { recursive: true });
writeFileSync(currentSourceOutputPath, `${JSON.stringify(currentSourceObservation, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({
  source: report.source,
  target: report.target,
  counts: report.counts,
  outputPath,
  currentSourceOutputPath,
}, null, 2)}\n`);
