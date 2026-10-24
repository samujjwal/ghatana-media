import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {applyPdp0SourceAmendment, validatePdp0SourceAmendmentApplyAuthorization} from '../scripts/lib/media-pdp0-source-amendment-apply.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const refs = [
  '.product-experience/pdp-0-product-truth/capabilities.yaml',
  '.product-experience/pdp-0-product-truth/requirements.yaml',
  'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json',
];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-source-amendment-'));
  const candidateText = '{"candidate":"exact"}\n';
  const decisionText = '{"decision":"exact"}\n';
  const peerReviewText = '{"peer":"distinct"}\n';
  const candidateSha256 = sha(candidateText);
  const candidatePostimageSha256 = 'c'.repeat(64);
  const decisionRef = '.product-experience/decision-log.md#PXD-900';
  const decisionSectionSha256 = 'd'.repeat(64);
  const peerIdentity = 'agent:thread:distinct-reviewer';
  const sourceOwnerDecisionRef = 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-owner-decision.v1.json';
  const technicalPeerReviewRef = 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-amendment-peer-review.v1.json';
  const sourceOwnerDecisionSha256 = sha(Buffer.from(decisionText));
  const technicalPeerReviewSha256 = sha(Buffer.from(peerReviewText));
  const preimageBytes = refs.map((_, i) => Buffer.from(`preimage-${i}\n`));
  const sourceBytes = Object.fromEntries(refs.map((ref, i) => [ref, preimageBytes[i]]));
  const postimageBytes = Object.fromEntries(refs.map((ref, i) => [ref, Buffer.from(`postimage-${i}\n`)]));
  const targets = refs.map((targetRef, i) => ({
    targetRef,
    expectedPreimageSha256: sha(preimageBytes[i]),
    expectedPostimageSha256: sha(postimageBytes[targetRef]),
  }));
  const plan = {
    schemaVersion: 'media.pdp0.source-amendment-cas-plan.v1',
    planDisposition: 'REVIEWED_AWAITING_EXPLICIT_APPLY_AUTHORIZATION',
    blockers: [],
    candidateRef: 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-amendment-candidate.v2.json',
    candidateSha256,
    candidatePostimageSha256,
    sourceOwnerDecisionRef,
    sourceOwnerDecisionSha256,
    technicalPeerReviewRef,
    technicalPeerReviewSha256,
    decisionRef,
    decisionSectionSha256,
    peerIdentity,
    targets,
  };
  const targetPostimages = Object.fromEntries(targets.map(row => [row.targetRef, row.expectedPostimageSha256]));
  const authorization = {
    schemaVersion: 'media.pdp0.source-amendment-apply-authorization.v1',
    effect: 'APPLY_EXACT_AUD_SPEC_002_SOURCE_AMENDMENT',
    candidateRef: plan.candidateRef,
    candidateSha256,
    candidatePostimageSha256,
    sourceOwnerDecisionRef,
    sourceOwnerDecisionSha256,
    technicalPeerReviewRef,
    technicalPeerReviewSha256,
    decisionRef,
    decisionSectionSha256,
    targetPostimages,
    technicalSourceOwner: {identity: 'agent:/root', role: 'PDP0_SOURCE_OWNER'},
    distinctTechnicalPeer: {identity: peerIdentity, role: 'DISTINCT_TECHNICAL_PEER', reviewedCandidateSha256: candidateSha256, reviewedPostimageSha256: candidatePostimageSha256},
    authorityBoundary: {ownerApproval: 'NOT_CLAIMED', independentAcceptance: 'NOT_CLAIMED', phaseStatusEffect: 'NONE', runtimeAdmission: 'NOT_ADMITTED', nativeClosure: 'NOT_CLAIMED'},
  };
  refs.forEach((ref, i) => {
    const target = path.join(root, ref);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, preimageBytes[i]);
  });
  return {root, plan, candidateText, decisionText, peerReviewText, sourceBytes, postimageBytes, authorization};
}

test('exact three-file apply snapshots predecessors and records exact postimage readback', () => {
  const f = fixture();
  try {
    const result = applyPdp0SourceAmendment(f);
    assert.equal(result.state, 'COMMITTED_EXACT_READBACK');
    assert.equal(result.canonicalWrite, 'PERFORMED');
    const journal = JSON.parse(fs.readFileSync(path.join(f.root, result.journalPath), 'utf8'));
    assert.equal(journal.targets.length, 3);
    assert.equal(journal.state, 'COMMITTED_EXACT_READBACK');
    journal.targets.forEach((row, i) => {
      assert.equal(fs.readFileSync(path.join(f.root, refs[i]), 'utf8'), f.postimageBytes[refs[i]].toString('utf8'));
      assert.equal(sha(fs.readFileSync(path.join(f.root, row.immutablePreimageRef))), row.expectedPreimageSha256);
      assert.equal(row.exactReadbackSha256, row.postimageSha256);
    });
  } finally { fs.rmSync(f.root, {recursive: true, force: true}); }
});

test('fails closed on stale target, tampered postimage, or forged peer/owner authorization', () => {
  const f = fixture();
  try {
    const target = path.join(f.root, refs[1]);
    fs.writeFileSync(target, 'intervening owner edit\n');
    assert.throws(() => applyPdp0SourceAmendment(f), /changed since the approved CAS preimage/u);
    assert.equal(fs.existsSync(path.join(f.root, 'docs/implementation/observations/pdp0-semantic-audit-slices/source-amendment-journals', `${f.plan.candidateSha256}.json`)), false);
    assert.throws(() => validatePdp0SourceAmendmentApplyAuthorization({...f, postimageBytes: {...f.postimageBytes, [refs[0]]: Buffer.from('tampered')}}), /postimage bytes changed/u);
    assert.throws(() => validatePdp0SourceAmendmentApplyAuthorization({...f, authorization: {...f.authorization, distinctTechnicalPeer: {...f.authorization.distinctTechnicalPeer, identity: 'agent:/root'}}}), /distinct peer/u);
    assert.throws(() => validatePdp0SourceAmendmentApplyAuthorization({...f, authorization: {...f.authorization, authorityBoundary: {...f.authorization.authorityBoundary, independentAcceptance: 'ACCEPTED'}}}), /cannot claim/u);
  } finally { fs.rmSync(f.root, {recursive: true, force: true}); }
});

test('an interrupted three-file attempt retains its journal and never redispatches writes', () => {
  const f = fixture();
  const fsOps = Object.create(fs);
  let failOnce = true;
  fsOps.renameSync = (...args) => {
    if (failOnce && String(args[1]).includes('.product-experience')) { failOnce = false; throw new Error('simulated interruption'); }
    return fs.renameSync(...args);
  };
  try {
    assert.throws(() => applyPdp0SourceAmendment({...f, fsOps}), /simulated interruption/u);
    const journalPath = path.join(f.root, 'docs/implementation/observations/pdp0-semantic-audit-slices/source-amendment-journals', `${f.plan.candidateSha256}.json`);
    assert.equal(JSON.parse(fs.readFileSync(journalPath, 'utf8')).state, 'PREPARED');
    assert.throws(() => applyPdp0SourceAmendment(f), /partial or uncertain target set; reconcile explicitly; no redispatch/u);
  } finally { fs.rmSync(f.root, {recursive: true, force: true}); }
});
