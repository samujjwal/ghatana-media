import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {commitValidatedPdp0ReviewPostimage} from '../scripts/lib/media-pdp0-review-successor-cas.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const targetRef = 'docs/implementation/verification/pdp-38/direct-definition-criteria-review.json';
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-pdp0-review-cas-'));
  const target = path.join(root, targetRef);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  const preimage = '{"old":"review"}\n';
  fs.writeFileSync(target, preimage);
  const postimage = '{"new":"typed-review-successor"}\n';
  const args = {root, expectedTargetSha256: digest(preimage), candidateSha256: 'a'.repeat(64), postimageText: postimage, postimageSha256: digest(postimage), decisionRef: '.product-experience/decision-log.md#PXD-900', decisionSectionSha256: 'b'.repeat(64), applyAuthorizationSha256: 'c'.repeat(64)};
  return {root, target, preimage, postimage, args};
}

test('CAS writer preserves immutable preimage and proves exact postimage readback', () => {
  const {root, target, preimage, postimage, args} = setup();
  try {
    const result = commitValidatedPdp0ReviewPostimage(args);
    assert.equal(result.state, 'COMMITTED_EXACT_READBACK');
    assert.equal(fs.readFileSync(target, 'utf8'), postimage);
    assert.equal(fs.readFileSync(path.join(root, result.immutablePreimageSnapshotRef), 'utf8'), preimage);
    const journal = JSON.parse(fs.readFileSync(path.join(root, result.journalPath), 'utf8'));
    assert.equal(journal.state, 'COMMITTED_EXACT_READBACK');
    assert.equal(journal.exactReadbackSha256, digest(postimage));
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('rejects stale CAS targets and tampered postimage bytes without a journal or canonical write', () => {
  const {root, target, postimage, args} = setup();
  try {
    fs.writeFileSync(target, 'intervening owner update\n');
    assert.throws(() => commitValidatedPdp0ReviewPostimage(args), /changed since the approved CAS preimage/u);
    assert.equal(fs.existsSync(path.join(root, 'docs/implementation/observations/media-pdp0-current-source-reviews-2026-10-23/apply-journal.json')), false);
    assert.throws(() => commitValidatedPdp0ReviewPostimage({...args, expectedTargetSha256: digest('intervening owner update\n'), postimageText: `${postimage}tampered`,}), /fingerprints are malformed or inconsistent/u);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('retains PREPARED journal after interrupted rename and refuses automatic redispatch', () => {
  const {root, target, preimage, postimage, args} = setup();
  const fsOps = Object.create(fs);
  let fail = true;
  fsOps.renameSync = (...args_) => { if (fail) { fail = false; throw new Error('simulated interruption after journal'); } return fs.renameSync(...args_); };
  try {
    assert.throws(() => commitValidatedPdp0ReviewPostimage({...args, fsOps}), /simulated interruption/u);
    const journalPath = path.join(root, 'docs/implementation/observations/media-pdp0-current-source-reviews-2026-10-23/apply-journal.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    assert.equal(journal.state, 'PREPARED');
    assert.equal(fs.readFileSync(target, 'utf8'), preimage);
    assert.throws(() => commitValidatedPdp0ReviewPostimage(args), /reconcile explicitly; no redispatch/u);
    // Model the uncertain-outcome case where the atomic rename completed but the process died before journal commit.
    fs.writeFileSync(target, postimage);
    const observed = commitValidatedPdp0ReviewPostimage(args);
    assert.equal(observed.state, 'POSTIMAGE_OBSERVED_AFTER_PRIOR_ATTEMPT');
    assert.equal(observed.canonicalWrite, 'NOT_PERFORMED_BY_THIS_CALL');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
