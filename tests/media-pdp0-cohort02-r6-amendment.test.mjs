import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readBytes = (ref) => fs.readFileSync(path.join(ROOT, ref));
const readJson = (ref) => JSON.parse(readBytes(ref).toString('utf8'));

test('preserves the independently reviewed R6 source-content result without rebinding its historical preimage', () => {
  const artifactRef = `${DIR}/cohort-02.r6.json`;
  const candidateRef = `${DIR}/cohort-02.source-amendment-candidate.r6.json`;
  const postimagesRef = `${DIR}/cohort-02.source-amendment-postimages.r6.json`;
  const peerRef = `${DIR}/cohort-02.r6.independent-peer-2026-10-23.json`;
  const artifact = readJson(artifactRef);
  const candidate = readJson(candidateRef);
  const postimages = readJson(postimagesRef);
  const peer = readJson(peerRef);

  assert.equal(artifact.status, 'SOURCE_GROUNDED_R6_REPAIRS_READY_FOR_DISTINCT_SOURCE_CONTENT_PEER_REVIEW_AND_ROOT_DECISIONS');
  assert.equal(peer.r6ContentReview.result, 'SOURCE_CONTENT_FINDINGS_ADDRESSED; ROOT_CHOICES_REMAIN_PENDING');
  assert.equal(peer.r6ContentReview.counts.capabilityCaseRecordAdditions, 120);
  assert.equal(peer.r6ContentReview.counts.rootChoicesPending, 11);
  assert.equal(peer.r6ContentReview.counts.historicalLeafAdjudicationsPreserved, 462);
  assert.equal(peer.reviewStatus, 'REQUEST_CHANGES');
  assert.equal(peer.findings.some((finding) => finding.findingId === 'PDP0-BATCH-PEER-IDENTITY-001'), true);
  assert.equal(candidate.canonicalApply, 'NOT_PERFORMED');
  assert.equal(postimages.canonicalApply, 'NOT_PERFORMED');
  assert.equal(artifact.canonicalSourceWrite, 'NOT_PERFORMED');
  assert.equal(artifact.independentAcceptance, 'NOT_CLAIMED');
  assert.equal(artifact.nativeClosure, 'NOT_CLAIMED');
  assert.equal(artifact.missingMeaningRootDecisionOptions.length + artifact.overlapRootDecisionOptions.length, 11);
  assert.equal(artifact.exactFeatureCasePostimages.length, 60);

  for (const target of candidate.exactTargetPostimages) {
    assert.equal(sha(readBytes(target.postimageRef)), target.postimageSha256, `${target.postimageRef} remains the exact historical R6 candidate byte set`);
  }
  assert.equal(sha(readBytes(artifactRef)), 'a4c7e7d2d23a4c0c23684a65d557ec944164ed1fb0abee0b664adededccfa963');
  assert.equal(sha(readBytes(peerRef)), '7551b0367917e71ef1874a93bdc9b8b10450c83a97cc4b939a453c7f7234680c');
});
