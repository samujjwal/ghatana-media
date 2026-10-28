import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const index = JSON.parse(read('docs/implementation/observations/media-candidate-decision-crosswalk-2026-10-28.json'));

test('PDP-0 owner choices remain distinct from source and license qualification', () => {
  const rows = index.pdp0ArchitecturalSelections;
  assert.equal(rows.length, 38);
  assert.equal(new Set(rows.map((x) => x.id)).size, rows.length);
  const count = (decision) => rows.filter((x) => x.decision === decision).length;
  assert.deepEqual([count('SELECTED'), count('CONDITIONAL'), count('NOT_REQUIRED'), count('REJECTED')],
    [21,15,1,1]);
  assert.ok(rows.every((x) => x.qualificationStatus !== 'ADMITTED'));
});

test('every researched source-table option is preserved with exact source row and no runtime approval', () => {
  const expected = {B3:32, B13:30, ANIM:5, SIM:5, MIG:32};
  for (const [key,count] of Object.entries(expected)) {
    const rows = index.preservedResearchSourceTables[key];
    assert.equal(rows.length,count);
    assert.equal(new Set(rows.map((x) => x.id)).size,count);
    assert.ok(rows.every((x) => x.sourceFile && x.sourceLine > 0 &&
      x.originalSourceColumns.length >= 3 && x.productionAdmitted === false));
  }
});

test('all 22 source feature families have valid candidate observation references', () => {
  const domains = index.sourceCapabilityFamilies;
  assert.equal(domains.length,22);
  assert.equal(new Set(domains.map((x) => x.domainId)).size,22);
  assert.ok(domains.every((x) => x.candidateSourceRefs.length && x.sourceLine > 0));
});

test('all 501 original audit-local feature identities remain source-linked but not provider-qualified', () => {
  const audit = index.auditFeatureCoverage;
  assert.deepEqual([audit.base, audit.thirdPass, audit.total], [428, 73, 501]);
  assert.equal(audit.recordClass, 'SOURCE_LINKS_ONLY_NOT_ATOMIC_FEATURE_ADMISSION');
  assert.ok(audit.originalCombinedAudit.path.includes('ATTACHED-COMBINED-AUDIT'));
  assert.ok(audit.existingFeatureToPdpReconciliation.path.includes('501-feature-reconciliation'));
});

test('Wave2 reference assets and unreconciled conversation alternatives remain in separate classes', () => {
  assert.equal(index.r9AssetCandidates.length,6);
  assert.equal(index.discussionOnlyCandidates.length,9);
  assert.ok(index.r9AssetCandidates.every((x) => x.sourceCandidateStatus === 'REVIEW_ONLY' &&
    x.productionAdmitted === false));
  assert.ok(index.discussionOnlyCandidates.every((x) => x.productionAdmitted === false));
  assert.ok(index.discussionOnlyCandidates.some((x) => x.name === 'OmniVoice'));
  assert.ok(index.discussionOnlyCandidates.some((x) => x.name === 'AudioSeal'));
  assert.ok(index.historicalArchitectureDecisions.some((x) => x.id === 'H-ARCH-002'));
});

test('FFmpeg and recorder chronology are recorded without conflicting live authority', () => {
  const {explicitReconciliations} = index;
  assert.ok(explicitReconciliations.some((x) => x.key === 'ffmpeg' &&
    x.conflict.includes('COMPATIBLE_SCOPES')));
  assert.ok(explicitReconciliations.some((x) => x.key === 'recording' &&
    x.conflict.includes('superseded')));
});

test('the crosswalk detects a changed source, untracked candidate or broken relation', () => {
  const output = execFileSync(process.execPath,
    ['scripts/qualification/check-media-candidate-crosswalk.mjs'],
    {cwd:root, encoding:'utf8', maxBuffer:512*1024});
  assert.match(output,/Candidate decision crosswalk PASS/);
});
