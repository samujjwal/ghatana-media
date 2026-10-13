import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTransferManifest, parseRecordBlocks } from '../scripts/generate-media-transfer-manifest.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifest = JSON.parse(readFileSync(resolve(root, 'migration/evidence/media-transfer-manifest-candidate-2026-10-12.json'), 'utf8'));
const pathMap = parseRecordBlocks(readFileSync(resolve(root, 'migration/path-map.yaml'), 'utf8'), 'entries');
const inventory = parseRecordBlocks(readFileSync(resolve(root, 'migration/source-inventory.yaml'), 'utf8'), 'entries');
const exceptions = parseRecordBlocks(readFileSync(resolve(root, 'migration/transfer-exceptions.yaml'), 'utf8'), 'records');
const crosswalk = JSON.parse(readFileSync(resolve(root, 'docs/migration/evidence/media-source-target-tree-crosswalk-current-2026-10-12.json'), 'utf8'));
const key = (repository, path) => `${repository}\0${path}`;

test('manifest covers each exact path-map source row exactly once', () => {
  const actual = new Map(manifest.entries.map((entry) => [key(entry.sourceRepository, entry.sourcePath), entry]));
  const sourceRecords = new Map(inventory.map((entry) => [key(entry.sourceRepository, entry.sourcePath), entry]));
  assert.equal(actual.size, manifest.entries.length, 'duplicate source path in manifest');
  for (const mapped of pathMap) {
    assert.ok(actual.has(key(mapped.sourceRepository, mapped.sourcePath)), `missing path-map path ${mapped.sourcePath}`);
  }
  for (const mapped of pathMap) {
    const entry = actual.get(key(mapped.sourceRepository, mapped.sourcePath));
    const exception = exceptions.find((candidate) => key(candidate.sourceRepository, candidate.sourcePath)
      === key(mapped.sourceRepository, mapped.sourcePath));
    assert.equal(entry.targetRepository, mapped.targetRepository);
    assert.equal(entry.targetPath, exception?.targetPath ?? mapped.targetPath);
    assert.equal(entry.targetDisposition, mapped.disposition);
    const source = sourceRecords.get(key(mapped.sourceRepository, mapped.sourcePath));
    assert.equal(entry.pathMapSnapshot.revision, mapped.sourceRevision);
    assert.equal(entry.pathMapSnapshot.mode, source.sourceMode);
    assert.equal(entry.pathMapSnapshot.blob, source.sourceFingerprint.value);
  }
  const mappedKeys = new Set(pathMap.map((entry) => key(entry.sourceRepository, entry.sourcePath)));
  const crosswalkOnly = manifest.entries.filter((entry) => !mappedKeys.has(key(entry.sourceRepository, entry.sourcePath)));
  assert.equal(crosswalkOnly.length, crosswalk.entries.filter((entry) => !mappedKeys.has(key(crosswalk.source.repository, entry.sourcePath))).length);
  for (const entry of crosswalkOnly) {
    assert.equal(entry.targetDisposition, 'UNRESOLVED_OWNER_REVIEW_REQUIRED');
    assert.equal(entry.targetRepository, 'samujjwal/ghatana-media');
    assert.equal(entry.transferAuthorization, 'NOT_AUTHORIZED');
  }
});

test('refreshed MIG-01 source identities are exact in the manifest', () => {
  const entries = new Map(manifest.entries.map((entry) => [entry.sourcePath, entry]));
  assert.equal(manifest.sourceEvidence.sourceTreeCrosswalk.counts.sourceTrackedPathCount, crosswalk.entries.length);
  for (const source of crosswalk.entries) {
    const candidate = entries.get(source.sourcePath);
    assert.ok(candidate, `missing refreshed crosswalk path ${source.sourcePath}`);
    assert.equal(candidate.sourceIdentity.revision, crosswalk.source.revision);
    assert.equal(candidate.sourceIdentity.mode, source.sourceMode);
    assert.equal(candidate.sourceIdentity.blob, source.sourceObjectId);
    if (candidate.targetPath === source.targetPath) {
      assert.equal(candidate.targetHeadObservation.mode, source.targetMode);
      assert.equal(candidate.targetHeadObservation.blob, source.targetObjectId);
    }
  }
});

test('every unresolved ownership or generator row stays unauthorized and has a proposed rollback', () => {
  assert.equal(manifest.transferAuthorization, 'NOT_AUTHORIZED');
  assert.equal(manifest.canonicalWriterSwitchAuthorization, 'NOT_AUTHORIZED');
  assert.equal(manifest.globalGates.canonicalAuthorityChange, 'NOT_AUTHORIZED');
  for (const entry of manifest.entries) {
    assert.match(entry.sourceIdentity.mode ?? '', /^(100644|100755|120000|100664|100640)$/);
    assert.match(entry.sourceIdentity.blob ?? '', /^[a-f0-9]{40}$/);
    assert.equal(entry.namedOwnerStatus, 'UNRESOLVED_OWNER_REVIEW_REQUIRED');
    assert.equal(entry.canonicalGeneratorStatus, 'UNRESOLVED_OWNER_REVIEW_REQUIRED');
    assert.equal(entry.transferAuthorization, 'NOT_AUTHORIZED');
    assert.equal(entry.canonicalWriterSwitchAuthorization, 'NOT_AUTHORIZED');
    assert.ok(entry.rollback.proposedSourceRef);
    assert.ok(entry.rollback.proposedTargetBeforeStateRef);
    assert.ok(entry.rollback.triggers.length >= 3);
    assert.equal(entry.rollback.authority, 'UNRESOLVED_OWNER_REVIEW_REQUIRED');
  }
  assert.equal(manifest.summary.transferAuthorizedCount, 0);
});

test('missing pinned trees and unavailable repository heads are explicit instead of empty-tree observations', () => {
  assert.equal(manifest.sourceEvidence.sourceTreeCrosswalk.path,
    'docs/migration/evidence/media-source-target-tree-crosswalk-current-2026-10-12.json');
  assert.equal(manifest.sourceEvidence.crosswalkHeadAlignment.sourceAligned, true);
  assert.equal(manifest.sourceEvidence.crosswalkHeadAlignment.targetAligned, true);
  for (const entry of manifest.entries) {
    assert.ok(['PINNED_COMMIT_TREE_OBSERVED', 'HISTORICAL_INVENTORY_FINGERPRINT; PINNED_TREE_UNVERIFIABLE', 'UNVERIFIABLE_SOURCE_IDENTITY']
      .includes(entry.sourceIdentityObservationStatus));
    assert.ok(['OBSERVED', 'UNVERIFIABLE', 'UNVERIFIABLE_REPOSITORY_HEAD_UNAVAILABLE']
      .includes(entry.currentSourceHeadObservation.observationStatus));
    assert.ok(['OBSERVED', 'UNVERIFIABLE', 'UNVERIFIABLE_REPOSITORY_HEAD_UNAVAILABLE']
      .includes(entry.targetHeadObservation.observationStatus));
    if (entry.currentSourceHeadObservation.observationStatus !== 'OBSERVED') {
      assert.equal(entry.currentSourceHeadObservation.present, false);
    }
    if (entry.targetHeadObservation.observationStatus !== 'OBSERVED') {
      assert.equal(entry.targetHeadObservation.present, false);
    }
  }
});

test('an UNVERIFIABLE crosswalk cannot be promoted to current by matching revision strings', () => {
  const report = buildTransferManifest({
    pathMap: [], inventory: [], exceptions: [],
    crosswalk: {
      schemaVersion: 'media.source-target-tree-crosswalk.v1', status: 'UNVERIFIABLE', unverifiable: true,
      source: { repository: 'samujjwal/ghatana', revision: 'same-revision' },
      target: { repository: 'samujjwal/ghatana-media', revision: 'same-target' },
      counts: null, entries: [],
    },
    repoHeads: { 'samujjwal/ghatana': 'same-revision', 'samujjwal/ghatana-media': 'same-target' },
    repoBranches: {}, repoPaths: new Map(), repoTrees: new Map(),
  });
  assert.equal(report.sourceEvidence.crosswalkHeadAlignment.status, 'UNVERIFIABLE');
  assert.equal(report.sourceEvidence.crosswalkHeadAlignment.sourceAligned, false);
  assert.equal(report.sourceEvidence.crosswalkHeadAlignment.targetAligned, false);
  assert.equal(report.globalGates.refreshedCrosswalkAgainstObservedSourceHead, 'UNVERIFIABLE');
});

test('all transfer exception records are represented in the per-path manifest', () => {
  const entries = new Map(manifest.entries.map((entry) => [key(entry.sourceRepository, entry.sourcePath), entry]));
  for (const exception of exceptions) {
    const candidate = entries.get(key(exception.sourceRepository, exception.sourcePath));
    assert.ok(candidate, `exception source missing from candidate ${exception.sourcePath}`);
    assert.equal(candidate.transferException.classification, exception.classification);
    assert.equal(candidate.transferException.targetPath, exception.targetPath);
    assert.equal(candidate.transferException.sourceMode, exception.sourceMode);
    assert.equal(candidate.transferException.sourceBlob, exception.sourceFingerprint);
  }
});
