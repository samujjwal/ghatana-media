import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {
  prepareMediaPdp0SourceAmendmentV7CasPlan,
  v7SourceAmendmentRefs,
} from '../scripts/lib/media-pdp0-source-amendment-v7-plan.mjs';
import {runV7CasPlanCli} from '../scripts/plan-media-pdp0-source-amendment-cas-v7.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OBS = 'docs/implementation/observations/pdp0-semantic-audit-slices';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = ref => fs.readFileSync(path.join(REPO, ref));

function copyRef(root, ref) {
  const lifecycle = ref.startsWith('ghatana-lifecycle:');
  const sourceRef = lifecycle ? ref.slice('ghatana-lifecycle:'.length) : ref;
  const sourceRoot = lifecycle ? path.resolve(REPO, '..', 'ghatana-lifecycle') : REPO;
  const targetRoot = lifecycle ? path.resolve(root, '..', 'ghatana-lifecycle') : root;
  const source = path.join(sourceRoot, sourceRef);
  const target = path.join(targetRoot, sourceRef);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, fs.readFileSync(source));
}

function isolatedRepository() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'media-v7-plan-'));
  const root = path.join(temp, 'ghatana-media');
  fs.mkdirSync(root);
  const manifest = JSON.parse(read(v7SourceAmendmentRefs.manifest));
  const candidate = JSON.parse(read(v7SourceAmendmentRefs.candidate));
  const peer = JSON.parse(read(v7SourceAmendmentRefs.peer));
  const refs = new Set([
    v7SourceAmendmentRefs.candidate,
    v7SourceAmendmentRefs.manifest,
    v7SourceAmendmentRefs.peer,
    `${OBS}/AUD-SPEC-002-source-amendment-candidate.v7.schema.json`,
    `${OBS}/AUD-SPEC-002-source-amendment-postimage.v7.json`,
    `${OBS}/AUD-SPEC-002-source-amendment-postimage.v7.schema.json`,
    `${OBS}/AUD-SPEC-002-source-amendment-v6-freeze-manifest.v1.json`,
    `${OBS}/AUD-SPEC-002-source-amendment-candidate.v6.json`,
    `${OBS}/AUD-SPEC-002-source-amendment-candidate.v6.schema.json`,
    `${OBS}/AUD-SPEC-002-source-amendment-postimage.v6.json`,
    `${OBS}/AUD-SPEC-002-source-amendment-postimage.v6.schema.json`,
    '.product-experience/pdp-0-product-truth/applications-channels.yaml',
    'docs/implementation/references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json',
    ...Object.keys(manifest.producerPins),
    manifest.reconciliationRef,
    candidate.rootDecisionRef,
    ...manifest.postimageArtifactRefs.map(row => row.ref),
    ...peer.sourceOrigin ? [peer.sourceOrigin.priorReviewRecordRef, peer.sourceOrigin.correctedSuccessorRef] : [],
  ]);
  for (const row of manifest.targetPostimages) refs.add(row.targetRef);
  for (const ref of refs) if (typeof ref === 'string') copyRef(root, ref);
  return {temp, root};
}

function writeAuthorityRecords(root, reviewed) {
  const refs = v7SourceAmendmentRefs;
  const decisionPath = path.join(root, refs.ownerDecision);
  const authPath = path.join(root, refs.applyAuthorization);
  const manifestBytes = fs.readFileSync(path.join(root, refs.manifest));
  const peerBytes = fs.readFileSync(path.join(root, refs.peer));
  const targetPostimages = Object.fromEntries(reviewed.targets.map(row => [row.targetRef, row.expectedPostimageSha256]));
  const ownerDecision = {
    schemaVersion: 'media.pdp0.source-amendment-owner-decision.v7',
    decisionKind: 'EXACT_PDP0_SOURCE_AMENDMENT',
    candidateRef: refs.candidate,
    candidateSha256: reviewed.plan.candidateSha256,
    candidatePostimageSha256: reviewed.plan.candidatePostimageSha256,
    freezeManifestRef: refs.manifest,
    freezeManifestSha256: sha(manifestBytes),
    sourceBindings: reviewed.candidate.sourceBindings,
    targetPostimages,
    decisionRef: reviewed.plan.decisionRef,
    decisionSectionSha256: reviewed.plan.decisionSectionSha256,
    sourceOwner: {identity: reviewed.plan.sourceOwnerIdentity, role: reviewed.plan.sourceOwnerRole},
    technicalPeerReviewRef: refs.peer,
    technicalPeerReviewSha256: sha(peerBytes),
    disposition: 'APPROVE_EXACT_CANDIDATE_FOR_SOURCE_APPLY',
    authorityBoundary: {ownerApproval:'NOT_CLAIMED',independentAcceptance:'NOT_CLAIMED',phaseStatusEffect:'NONE',runtimeAdmission:'NOT_ADMITTED',nativeClosure:'NOT_CLAIMED'},
  };
  const decisionBytes = Buffer.from(`${JSON.stringify(ownerDecision, null, 2)}\n`);
  fs.mkdirSync(path.dirname(decisionPath), {recursive:true});
  fs.writeFileSync(decisionPath, decisionBytes);
  const ownerSha = sha(decisionBytes);
  const peerSha = sha(peerBytes);
  const grant = {
    grantId: 'TEST-ONLY-SYNTHETIC-CURRENT-GRANT', status:'CURRENT', issuerIdentity:reviewed.plan.sourceOwnerIdentity,
    candidateSha256:reviewed.plan.candidateSha256,candidatePostimageSha256:reviewed.plan.candidatePostimageSha256,
    sourceOwnerDecisionSha256:ownerSha,technicalPeerReviewSha256:peerSha,decisionRef:reviewed.plan.decisionRef,
    decisionSectionSha256:reviewed.plan.decisionSectionSha256,targetPostimages,
  };
  const authorization = {
    schemaVersion:'media.pdp0.source-amendment-apply-authorization.v7',effect:'APPLY_EXACT_AUD_SPEC_002_SOURCE_AMENDMENT_V7',
    authorizationId:`MEDIA-AUD-SPEC-002-V7-APPLY-${reviewed.plan.candidateSha256.slice(0,12)}`,
    candidateRef:refs.candidate,candidateSha256:reviewed.plan.candidateSha256,candidatePostimageSha256:reviewed.plan.candidatePostimageSha256,
    sourceOwnerDecisionRef:refs.ownerDecision,sourceOwnerDecisionSha256:ownerSha,technicalPeerReviewRef:refs.peer,technicalPeerReviewSha256:peerSha,
    decisionRef:reviewed.plan.decisionRef,decisionSectionSha256:reviewed.plan.decisionSectionSha256,targetPostimages,currentRootGrant:grant,
    authorityBoundary:{ownerApproval:'NOT_CLAIMED',independentAcceptance:'NOT_CLAIMED',phaseStatusEffect:'NONE',runtimeAdmission:'NOT_ADMITTED',nativeClosure:'NOT_CLAIMED'},
  };
  fs.mkdirSync(path.dirname(authPath), {recursive:true});
  fs.writeFileSync(authPath, `${JSON.stringify(authorization, null, 2)}\n`);
}

test('v7 planner reads the current owner decision, remains blocked without current grant, and rejects injected-plan CLI options', () => {
  const {plan, targets, peer} = prepareMediaPdp0SourceAmendmentV7CasPlan();
  assert.equal(plan.planDisposition, 'BLOCKED_AWAITING_EXACT_V7_OWNER_PEER_AND_CURRENT_ROOT_GRANT');
  assert.deepEqual(plan.blockers, ['CURRENT_EXACT_V7_ROOT_GRANT_REQUIRED']);
  assert.match(plan.sourceOwnerDecisionSha256,/^[a-f0-9]{64}$/u);
  assert.equal(plan.targets.length, 6);
  assert.equal(plan.peerIdentity, 'agent:thread:01a16a35-bbcf-74d2-ac99-1ed74c29c3c9');
  assert.equal(peer.reviewer?.independentHumanReviewer, false);
  for (const row of targets) assert.equal(sha(row.preimageBytes), row.expectedPreimageSha256);
  assert.throws(() => runV7CasPlanCli(['--plan','caller-plan.json']), /unsupported option/u);
});

test('v7 planner accepts schema-valid synthetic authority records only in an isolated fixture and emits an exact ready plan', () => {
  const {temp, root} = isolatedRepository();
  try {
    const blocked = prepareMediaPdp0SourceAmendmentV7CasPlan({root});
    writeAuthorityRecords(root, blocked);
    const ready = prepareMediaPdp0SourceAmendmentV7CasPlan({root});
    assert.equal(ready.plan.planDisposition, 'READY_EXACT_V7_CUT_WITH_CURRENT_ROOT_GRANT_NO_WRITE_PERFORMED');
    assert.deepEqual(ready.plan.blockers, []);
    assert.equal(ready.plan.rootGrantCurrent, true);
    assert.equal(ready.plan.targets.length, 6);
    assert.equal(ready.plan.effects.canonicalWrite, 'NOT_PERFORMED');
    assert.equal(fs.existsSync(path.join(root, v7SourceAmendmentRefs.ownerDecision)), true);
    assert.equal(fs.existsSync(path.join(root, v7SourceAmendmentRefs.applyAuthorization)), true);
    const peerPath = path.join(root, v7SourceAmendmentRefs.peer);
    const changedPeer = JSON.parse(fs.readFileSync(peerPath, 'utf8'));
    changedPeer.reviewer.identity = 'agent:thread:aliased-owner';
    fs.writeFileSync(peerPath, `${JSON.stringify(changedPeer, null, 2)}\n`);
    const stale = prepareMediaPdp0SourceAmendmentV7CasPlan({root});
    assert.equal(stale.plan.planDisposition, 'BLOCKED_AWAITING_EXACT_V7_OWNER_PEER_AND_CURRENT_ROOT_GRANT');
    assert.ok(stale.plan.blockers.includes('EXACT_V7_DISTINCT_PEER_REVIEW_REQUIRED_OR_STALE'));
  } finally { fs.rmSync(temp, {recursive:true,force:true}); }
});

test('v7 planner rejects a symlinked fixed peer record before trusting it', () => {
  const {temp, root} = isolatedRepository();
  const outside = path.join(temp,'peer-outside.json');
  const peerPath = path.join(root,v7SourceAmendmentRefs.peer);
  try {
    fs.writeFileSync(outside,fs.readFileSync(peerPath));
    fs.unlinkSync(peerPath);
    fs.symlinkSync(outside,peerPath);
    assert.throws(()=>prepareMediaPdp0SourceAmendmentV7CasPlan({root}),/symlink/u);
    assert.equal(fs.readFileSync(outside).length>0,true);
  } finally { fs.rmSync(temp,{recursive:true,force:true}); }
});
