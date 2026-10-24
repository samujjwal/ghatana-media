import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {
  commitValidatedPdp0ReviewPostimage,
  commitValidatedPdp0SourceAmendment,
  commitValidatedPdp0SourceAmendmentV4,
  commitValidatedPdp0SourceAmendmentSixFile,
  commitValidatedPdp0SourceAmendmentQualityTwoTarget,
} from '../scripts/lib/media-pdp0-review-successor-cas.mjs';
import {authorizedV7CasFixture, isolatedV7Repository} from './helpers/media-pdp0-source-amendment-v7-fixture.mjs';
import {fingerprintPxdDecisionSection} from '../scripts/lib/pdp0-phase-scoped-source-fingerprints.mjs';
import {prepareQualityExtensionSourceCandidateV2} from '../scripts/lib/media-pdp0-quality-extension-source-candidate-v2.mjs';
import {
  QUALITY_CANDIDATE_REF, QUALITY_SCHEMA_REF, QUALITY_FREEZE_REF, QUALITY_PEER_REF,
  QUALITY_OWNER_DECISION_REF, QUALITY_APPLY_AUTHORIZATION_REF, V7_MANIFEST_REF,
  V7_CANDIDATE_REF, V7_PEER_REF, TARGETS as QUALITY_TARGETS,
} from '../scripts/lib/media-pdp0-quality-extension-source-adoption-v2.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const targetRef = 'docs/implementation/verification/pdp-38/direct-definition-criteria-review.json';
const testRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const reviewDir = 'docs/implementation/observations/media-pdp0-current-source-reviews-2026-10-23';
const sourceTargets = [
  '.product-experience/pdp-0-product-truth/capabilities.yaml',
  '.product-experience/pdp-0-product-truth/requirements.yaml',
  'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json',
];
const sourceTargetsV4 = [...sourceTargets, '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml'];
const sourceTargetsSixFile = [...sourceTargetsV4,'.product-experience/pdp-0-product-truth/campaign-extensions.yaml','.product-experience/decision-log.md'];

function reviewFixture({mode = 0o640} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-review-cas-security-'));
  const target = path.join(root, targetRef);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  const preimage = '{"old":"review"}\n';
  fs.writeFileSync(target, preimage, {mode});
  fs.chmodSync(target, mode);
  const postimage = '{"new":"typed-review-successor"}\n';
  const args = {
    root,
    expectedTargetSha256: digest(preimage),
    candidateSha256: 'a'.repeat(64),
    postimageText: postimage,
    postimageSha256: digest(postimage),
    decisionRef: '.product-experience/decision-log.md#PXD-900',
    decisionSectionSha256: 'b'.repeat(64),
    applyAuthorizationSha256: 'c'.repeat(64),
  };
  return {root, target, preimage, postimage, args};
}

function sourceFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-source-cas-security-'));
  const preimages = sourceTargets.map((_, index) => Buffer.from(`source preimage ${index}\n`));
  const postimages = sourceTargets.map((_, index) => Buffer.from(`source postimage ${index}\n`));
  const sourceBytes = Object.fromEntries(sourceTargets.map((ref, index) => [ref, preimages[index]]));
  const postimageBytes = Object.fromEntries(sourceTargets.map((ref, index) => [ref, postimages[index]]));
  const targets = sourceTargets.map((targetRef_, index) => {
    const target = path.join(root, targetRef_);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, preimages[index], {mode: 0o640});
    fs.chmodSync(target, 0o640);
    return {
      targetRef: targetRef_,
      expectedPreimageSha256: digest(preimages[index]),
      expectedPostimageSha256: digest(postimages[index]),
    };
  });
  return {root, preimages, postimages, sourceBytes, postimageBytes, targets};
}

function sourceV4Fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-source-cas-v4-security-'));
  const preimages = sourceTargetsV4.map((_, index) => Buffer.from(`v4 source preimage ${index}\n`));
  const postimages = sourceTargetsV4.map((_, index) => Buffer.from(`v4 source postimage ${index}\n`));
  const targets = sourceTargetsV4.map((targetRef_, index) => {
    const target = path.join(root, targetRef_);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, preimages[index], {mode: 0o640});
    fs.chmodSync(target, 0o640);
    return {targetRef: targetRef_, expectedPreimageSha256: digest(preimages[index]), expectedPostimageSha256: digest(postimages[index]),
      preimageBytes: preimages[index], postimageBytes: postimages[index]};
  });
  const plan = {
    schemaVersion: 'media.pdp0.source-amendment-cas-plan.v2',
    planKind: 'NON_MUTATING_EXACT_SOURCE_OWNER_MULTI_FILE_CAS_PLAN',
    planDisposition: 'REVIEWED_AWAITING_EXPLICIT_APPLY_AUTHORIZATION',
    candidateRef: 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-amendment-candidate.v4.json',
    candidateSchemaVersion: 'media.pdp0.aud-spec-002-source-amendment-candidate.v4',
    candidateSha256: '4'.repeat(64), candidatePostimageSha256: '5'.repeat(64),
    sourceOwnerDecisionRef: 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-owner-decision.v4.json',
    sourceOwnerDecisionSha256: '6'.repeat(64),
    technicalPeerReviewRef: 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-amendment-independent-peer.v4.json',
    technicalPeerReviewSha256: '7'.repeat(64),
    decisionRef: '.product-experience/decision-log.md#PXD-900', decisionSectionSha256: '8'.repeat(64),
    applyAuthorizationSha256: '9'.repeat(64), sourceOwnerIdentity: 'agent:/root', sourceOwnerRole: 'PDP0_SOURCE_OWNER',
    peerIdentity: 'agent:thread:independent-peer', blockers: [],
    targets: targets.map(({targetRef: ref, expectedPreimageSha256, expectedPostimageSha256}) => ({targetRef: ref, expectedPreimageSha256, expectedPostimageSha256})),
    authorityBoundary: {ownerApproval: 'NOT_CLAIMED', independentAcceptance: 'NOT_CLAIMED', phaseStatusEffect: 'NONE', runtimeAdmission: 'NOT_ADMITTED', nativeClosure: 'NOT_CLAIMED'},
  };
  return {root, targets, plan};
}

function sourceSixFileFixture() {
  const fixture=authorizedV7CasFixture();
  return {...fixture,targets:fixture.targets.map(row=>({...row,expectedMode:fs.statSync(path.join(fixture.root,row.targetRef)).mode&0o777}))};
}

function cleanupV7Fixture(fixture) { fs.rmSync(path.dirname(fixture.root), {recursive:true,force:true}); }

function installCasModules(fixture) {
  const sourceLib=path.join(testRepositoryRoot,'scripts/lib');
  const installedLib=path.join(fixture.root,'scripts/lib');
  fs.mkdirSync(installedLib,{recursive:true});
  for(const name of fs.readdirSync(sourceLib).filter(name=>name.endsWith('.mjs'))) {
    fs.copyFileSync(path.join(sourceLib,name),path.join(installedLib,name));
  }
  const installedPlan=path.join(fixture.root,'scripts/plan-media-pdp0-root-selected-source-integration-r9-r07-application.mjs');
  fs.copyFileSync(path.join(testRepositoryRoot,'scripts/plan-media-pdp0-root-selected-source-integration-r9-r07-application.mjs'),installedPlan);
  const nodeModulesLink=path.join(fixture.root,'node_modules');
  if(!fs.existsSync(nodeModulesLink)) fs.symlinkSync(path.join(testRepositoryRoot,'node_modules'),nodeModulesLink,'dir');
  const toolsLink=path.join(path.dirname(fixture.root),'ghatana-tools');
  if(!fs.existsSync(toolsLink)) fs.symlinkSync(path.resolve(testRepositoryRoot,'../ghatana-tools'),toolsLink,'dir');
  return installedLib;
}

function putFixtureBytes(root,ref,bytes,{lifecycle=false}={}) {
  const targetRoot=lifecycle?path.resolve(root,'..','ghatana-lifecycle'):root;
  const target=path.join(targetRoot,ref);
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,bytes);
}

function copyFixtureTree(sourceRoot,targetRoot) {
  fs.cpSync(sourceRoot,targetRoot,{recursive:true,force:true,dereference:false});
}

function isolatedQualityWriterFixture() {
  const fixture=isolatedV7Repository();
  try {
    copyFixtureTree(path.join(testRepositoryRoot,'.product-experience/pdp-0-product-truth'),path.join(fixture.root,'.product-experience/pdp-0-product-truth'));
    fs.mkdirSync(path.join(fixture.root,'.product-experience'),{recursive:true});
    fs.copyFileSync(path.join(testRepositoryRoot,'.product-experience/decision-log.md'),path.join(fixture.root,'.product-experience/decision-log.md'));
    copyFixtureTree(path.join(testRepositoryRoot,'docs/implementation/observations/pdp0-semantic-audit-slices'),
      path.join(fixture.root,'docs/implementation/observations/pdp0-semantic-audit-slices'));
    fs.rmSync(path.join(fixture.root,'docs/implementation/observations/pdp0-semantic-audit-slices/source-amendment-journals'),{recursive:true,force:true});
    const archivedQualityPreimageRef='docs/implementation/observations/pdp0-semantic-audit-slices/source-amendment-preimages/f6feb44574d87a7ee15807b80ac8cf8c95c9ca86ab81ff6c9cddea3ec5799a0a/1-quality-policy.yaml';
    const archivedQualityPreimage=fs.readFileSync(path.join(testRepositoryRoot,archivedQualityPreimageRef));
    assert.equal(digest(archivedQualityPreimage),'eb8751b7a8b84318a2ef37152a603d8256acf621a3265ce794757505d9fdaf3a');
    putFixtureBytes(fixture.root,'.product-experience/pdp-0-product-truth/quality-policy.yaml',archivedQualityPreimage);
    fs.mkdirSync(path.join(fixture.root,'docs/implementation/references'),{recursive:true});
    fs.copyFileSync(path.join(testRepositoryRoot,'docs/implementation/references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json'),
      path.join(fixture.root,'docs/implementation/references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json'));
    for(const ref of [
      'docs/engineering/reviews/gtool-critical-2026-10-23/media-aud-spec-002-quality-applicability-root-choice-r01.json',
      'docs/engineering/reviews/gtool-critical-2026-10-23/media-aud-spec-002-version-population-root-decision.json',
    ]) {
      putFixtureBytes(fixture.root,ref,fs.readFileSync(path.resolve(testRepositoryRoot,'../ghatana-lifecycle',ref)),{lifecycle:true});
    }

    const prepared=prepareQualityExtensionSourceCandidateV2({readSource:ref=>ref==='.product-experience/pdp-0-product-truth/quality-policy.yaml'
      ? archivedQualityPreimage : fs.readFileSync(path.resolve(testRepositoryRoot,ref))});
    const json=value=>Buffer.from(`${JSON.stringify(value,null,2)}\n`);
    const candidateBytes=json(prepared.candidate),schemaBytes=json(prepared.schema);
    const candidateSha256=digest(candidateBytes),schemaSha256=digest(schemaBytes);
    const freeze={schemaVersion:'media.pdp0.quality-extension-source-candidate-v2-freeze-manifest.v1',
      candidateRef:QUALITY_CANDIDATE_REF,candidateSha256,schemaRef:QUALITY_SCHEMA_REF,schemaSha256,targets:prepared.candidate.targets};
    const manifestBytes=fs.readFileSync(path.join(fixture.root,V7_MANIFEST_REF));
    const manifest=JSON.parse(manifestBytes.toString('utf8'));
    const v7PeerBytes=fs.readFileSync(path.join(fixture.root,V7_PEER_REF));
    const peer={schemaVersion:'media.pdp0.quality-extension-independent-peer.v2',auditId:'AUD-SPEC-002',candidateRef:QUALITY_CANDIDATE_REF,
      candidateSha256,candidatePostimageSha256:prepared.candidate.candidatePostimageSha256,
      predecessor:{v7CandidateRef:V7_CANDIDATE_REF,v7CandidateSha256:manifest.candidateSha256,v7ManifestRef:V7_MANIFEST_REF,
        v7ManifestSha256:digest(manifestBytes),v7PeerRef:V7_PEER_REF,v7PeerSha256:digest(v7PeerBytes)},
      targetPostimages:prepared.candidate.targets.map(({targetRef,preimageSha256,postimageSha256})=>({targetRef,preimageSha256,postimageSha256})),
      reviewer:{identity:'agent:thread:test-public-cas-peer',role:'DISTINCT_TECHNICAL_PEER',candidateAuthorIdentity:'agent:/root/phase_io',
        independentHumanReviewer:false,credentialedAttestation:false},disposition:'TECHNICAL_APPROVE_EXACT_CANDIDATE_ONLY',findings:[],
      authorityBoundary:{sourceOwnerAdoption:'PENDING',canonicalApply:'NOT_PERFORMED',sourceCurrentness:'NOT_CLAIMED',phaseStatusEffect:'NONE',independentAcceptance:'NOT_CLAIMED',nativeProof:'NOT_CLAIMED'}};
    const peerBytes=json(peer);
    const targetRows=prepared.candidate.targets.map(({targetRef,preimageSha256,postimageSha256})=>({
      targetRef,expectedPreimageSha256:preimageSha256,expectedPostimageSha256:postimageSha256}));
    const decisionSectionSha256=fingerprintPxdDecisionSection(prepared.decisionLogPostimageBytes.toString('utf8'),'PXD-227').sha256;
    const decision={schemaVersion:'media.pdp0.quality-extension-source-owner-decision.v2',decisionKind:'ADOPT_EXACT_QUALITY_EXTENSION_TWO_TARGET_SOURCE_CANDIDATE',
      candidateRef:QUALITY_CANDIDATE_REF,candidateSha256,candidatePostimageSha256:prepared.candidate.candidatePostimageSha256,
      peerReviewRef:QUALITY_PEER_REF,peerReviewSha256:digest(peerBytes),v7ManifestSha256:digest(manifestBytes),
      decisionRef:'.product-experience/decision-log.md#PXD-227',decisionSectionSha256,targetRows,
      sourceOwner:{identity:'agent:/root',role:'PDP0_SOURCE_OWNER'},disposition:'APPROVE_EXACT_CANDIDATE_FOR_SOURCE_APPLY',
      authorityBoundary:{sourceDefinitionOnly:true,independentAcceptance:'NOT_CLAIMED',phaseStatusEffect:'NONE',nativeProof:'NOT_CLAIMED',runtimeAdmission:'NOT_ADMITTED',measurement:'NOT_EVALUATED',qualification:'NOT_EVALUATED'}};
    const decisionBytes=json(decision);
    const authorization={schemaVersion:'media.pdp0.quality-extension-apply-authorization.v2',effect:'APPLY_EXACT_QUALITY_EXTENSION_TWO_TARGET_SOURCE_CANDIDATE',
      candidateRef:QUALITY_CANDIDATE_REF,candidateSha256,candidatePostimageSha256:prepared.candidate.candidatePostimageSha256,
      sourceOwnerDecisionRef:QUALITY_OWNER_DECISION_REF,sourceOwnerDecisionSha256:digest(decisionBytes),peerReviewRef:QUALITY_PEER_REF,peerReviewSha256:digest(peerBytes),
      decisionRef:decision.decisionRef,decisionSectionSha256,targetRows,sourceOwner:{identity:'agent:/root',role:'PDP0_SOURCE_OWNER'},
      distinctTechnicalPeer:{identity:peer.reviewer.identity,role:'DISTINCT_TECHNICAL_PEER',reviewedCandidateSha256:candidateSha256,
        reviewedPostimageSha256:prepared.candidate.candidatePostimageSha256},
      authorityBoundary:{sourceOwnerAdoption:'EXACT_SOURCE_CHANGE_AUTHORIZED',independentAcceptance:'NOT_CLAIMED',phaseStatusEffect:'NONE',nativeProof:'NOT_CLAIMED',runtimeAdmission:'NOT_ADMITTED',measurement:'NOT_EVALUATED',qualification:'NOT_EVALUATED'}};
    const artifacts=[[QUALITY_CANDIDATE_REF,candidateBytes],[QUALITY_SCHEMA_REF,schemaBytes],[QUALITY_FREEZE_REF,json(freeze)],
      [QUALITY_PEER_REF,peerBytes],[QUALITY_OWNER_DECISION_REF,decisionBytes],[QUALITY_APPLY_AUTHORIZATION_REF,json(authorization)],
      [prepared.candidate.targets[0].postimageRef,prepared.decisionLogPostimageBytes],
      [prepared.candidate.targets[1].postimageRef,prepared.qualityPostimageBytes]];
    for(const [ref,bytes] of artifacts) putFixtureBytes(fixture.root,ref,bytes);
    for(const [index,row] of manifest.postimageArtifactRefs.entries()) {
      putFixtureBytes(fixture.root,manifest.targetPostimages[index].targetRef,fs.readFileSync(path.join(fixture.root,row.ref)));
    }
    const lib=installCasModules(fixture);
    return {...fixture,lib,qualityTargets:prepared.candidate.targets};
  }catch(error){fs.rmSync(fixture.temp,{recursive:true,force:true});throw error;}
}

async function qualityWriterReadyCall(fixture) {
  const quality=await import(`${pathToFileURL(path.join(fixture.lib,'media-pdp0-quality-extension-source-adoption-v2.mjs')).href}?ready=${Date.now()}`);
  const cas=await import(`${pathToFileURL(path.join(fixture.lib,'media-pdp0-review-successor-cas.mjs')).href}?ready=${Date.now()}`);
  const planned=quality.planQualityExtensionSourceAdoptionV2();
  assert.equal(planned.plan.planDisposition,'READY_FOR_SHARED_OWNER_CONTROLLED_CAS');
  assert.deepEqual(planned.plan.blockers,[]);
  const targets=fixture.qualityTargets.map(row=>({
    targetRef:row.targetRef,
    expectedPreimageSha256:row.preimageSha256,
    expectedPostimageSha256:row.postimageSha256,
    preimageBytes:fs.readFileSync(path.join(fixture.root,row.targetRef)),
    postimageBytes:fs.readFileSync(path.join(fixture.root,row.postimageRef)),
  }));
  return {cas,plan:planned.plan,targets};
}

function qualityTwoTargetFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-quality-two-target-cas-'));
  const refs = ['.product-experience/decision-log.md','.product-experience/pdp-0-product-truth/quality-policy.yaml'];
  const targets = refs.map((targetRef, index) => {
    const target = path.join(root,targetRef);
    fs.mkdirSync(path.dirname(target),{recursive:true});
    const preimageBytes=Buffer.from(`quality target preimage ${index}\n`);
    const postimageBytes=Buffer.from(`quality target postimage ${index}\n`);
    fs.writeFileSync(target,preimageBytes,{mode:0o640});fs.chmodSync(target,0o640);
    return {targetRef,expectedPreimageSha256:digest(preimageBytes),expectedPostimageSha256:digest(postimageBytes),preimageBytes,postimageBytes};
  });
  const targetRows=targets.map(({targetRef,expectedPreimageSha256,expectedPostimageSha256})=>({targetRef,expectedPreimageSha256,expectedPostimageSha256}));
  const candidatePostimageSha256=digest(Buffer.from(JSON.stringify(targetRows.map(row=>({targetRef:row.targetRef,
    preimageSha256:row.expectedPreimageSha256,postimageSha256:row.expectedPostimageSha256})))));
  const v7Refs=['.product-experience/pdp-0-product-truth/capabilities.yaml','.product-experience/pdp-0-product-truth/requirements.yaml',
    'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json',
    '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml','.product-experience/pdp-0-product-truth/campaign-extensions.yaml',
    '.product-experience/decision-log.md'];
  const plan={schemaVersion:'media.pdp0.quality-extension-source-adoption-cas-plan.v2',
    planKind:'NON_MUTATING_EXACT_TWO_TARGET_QUALITY_EXTENSION_SOURCE_CAS_PLAN',planDisposition:'READY_FOR_SHARED_OWNER_CONTROLLED_CAS',
    candidateRef:'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-quality-extension-source-candidate.v2.json',
    candidateSchemaVersion:'media.pdp0.quality-extension-source-candidate.v2',candidateSha256:'1'.repeat(64),candidatePostimageSha256,
    sourceOwnerDecisionRef:'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-quality-extension-source-owner-decision.v2.json',sourceOwnerDecisionSha256:'2'.repeat(64),
    technicalPeerReviewRef:'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-quality-extension-independent-peer.v2.json',technicalPeerReviewSha256:'3'.repeat(64),
    v7Predecessor:{manifestRef:'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-amendment-v7-freeze-manifest.v1.json',manifestSha256:'4'.repeat(64),
      peerRef:'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-v7-quality-extension-independent-peer.v2.json',peerSha256:'5'.repeat(64),state:'EXACT_CURRENT_READBACK',
      targets:v7Refs.map((targetRef,index)=>({targetRef,expectedPreimageSha256:(index+1).toString(16).repeat(64).slice(0,64),
        expectedPostimageSha256:(index+8).toString(16).repeat(64).slice(0,64),actualSha256:(index+8).toString(16).repeat(64).slice(0,64)}))},
    decisionRef:'.product-experience/decision-log.md#PXD-227',decisionSectionSha256:'6'.repeat(64),applyAuthorizationSha256:'7'.repeat(64),
    sourceOwnerIdentity:'agent:/root',sourceOwnerRole:'PDP0_SOURCE_OWNER',peerIdentity:'agent:thread:quality-peer-v2',blockers:[],targets:targetRows,
    authorityBoundary:{sourceOwnerAdoption:'EXACT_DECISION_RECORDED',canonicalApply:'NOT_PERFORMED',sourceCurrentness:'NOT_CLAIMED',
      phaseStatusEffect:'NONE',independentAcceptance:'NOT_CLAIMED',nativeProof:'NOT_CLAIMED',runtimeAdmission:'NOT_ADMITTED'}};
  return {root,targets,plan};
}

test('owner lock is held across target read through publication', () => {
  const fixture = reviewFixture();
  const fsOps = Object.create(fs);
  const originalRead = fs.readFileSync.bind(fs);
  const physicalTarget = fs.realpathSync(fixture.target);
  let nestedAttempted = false;
  let nestedError;
  fsOps.readFileSync = (filePath, ...args) => {
    if (!nestedAttempted && path.resolve(filePath) === physicalTarget) {
      nestedAttempted = true;
      try { commitValidatedPdp0ReviewPostimage({ ...fixture.args, fsOps: fs }); }
      catch (error) { nestedError = error; }
    }
    return originalRead(filePath, ...args);
  };
  try {
    const result = commitValidatedPdp0ReviewPostimage({...fixture.args, fsOps});
    assert.equal(result.state, 'COMMITTED_EXACT_READBACK');
    assert.equal(nestedAttempted, true);
    assert.match(nestedError?.message ?? '', /owner lock already exists/u);
    assert.equal(fs.readFileSync(fixture.target, 'utf8'), fixture.postimage);
  } finally { fs.rmSync(fixture.root, {recursive: true, force: true}); }
});

test('rejects symlinked canonical target parent and final target before writing outside root', () => {
  const fixture = reviewFixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'media-review-cas-outside-'));
  const targetParent = path.dirname(fixture.target);
  try {
    fs.rmSync(targetParent, {recursive: true, force: true});
    fs.symlinkSync(outside, targetParent, 'dir');
    const outsideTarget = path.join(outside, path.basename(fixture.target));
    fs.writeFileSync(outsideTarget, fixture.preimage);
    assert.throws(() => commitValidatedPdp0ReviewPostimage(fixture.args), /symbolic link/u);
    assert.equal(fs.readFileSync(outsideTarget, 'utf8'), fixture.preimage);

    fs.unlinkSync(targetParent);
    fs.mkdirSync(targetParent, {recursive: true});
    fs.symlinkSync(outsideTarget, fixture.target);
    assert.throws(() => commitValidatedPdp0ReviewPostimage(fixture.args), /symbolic link/u);
    assert.equal(fs.readFileSync(outsideTarget, 'utf8'), fixture.preimage);
  } finally {
    fs.rmSync(fixture.root, {recursive: true, force: true});
    fs.rmSync(outside, {recursive: true, force: true});
  }
});

test('rejects a changed preimage immediately before rename and leaves a prepared journal for reconciliation', () => {
  const fixture = reviewFixture();
  const fsOps = Object.create(fs);
  const originalOpen = fs.openSync.bind(fs);
  let raced = false;
  fsOps.openSync = (filePath, ...args) => {
    if (!raced && String(filePath).includes('.tmp-pdp0-source-review-')) {
      raced = true;
      fs.writeFileSync(fixture.target, 'concurrent owner update\n');
    }
    return originalOpen(filePath, ...args);
  };
  try {
    assert.throws(() => commitValidatedPdp0ReviewPostimage({...fixture.args, fsOps}), /changed after the approved CAS preimage/u);
    assert.equal(fs.readFileSync(fixture.target, 'utf8'), 'concurrent owner update\n');
    const journalPath = path.join(fixture.root, reviewDir, 'apply-journal.json');
    assert.equal(JSON.parse(fs.readFileSync(journalPath, 'utf8')).state, 'PREPARED');
    assert.throws(() => commitValidatedPdp0ReviewPostimage(fixture.args), /reconcile explicitly; no redispatch/u);
    assert.equal(fs.readFileSync(fixture.target, 'utf8'), 'concurrent owner update\n');
  } finally { fs.rmSync(fixture.root, {recursive: true, force: true}); }
});

test('preserves the canonical target mode and observes exact committed postimage on idempotent replay', () => {
  const fixture = reviewFixture({mode: 0o640});
  try {
    const result = commitValidatedPdp0ReviewPostimage(fixture.args);
    assert.equal(result.state, 'COMMITTED_EXACT_READBACK');
    assert.equal(fs.statSync(fixture.target).mode & 0o777, 0o640);
    const replay = commitValidatedPdp0ReviewPostimage(fixture.args);
    assert.equal(replay.state, 'POSTIMAGE_OBSERVED_AFTER_PRIOR_ATTEMPT');
    assert.equal(replay.canonicalWrite, 'NOT_PERFORMED_BY_THIS_CALL');
    assert.equal(fs.statSync(fixture.target).mode & 0o777, 0o640);
  } finally { fs.rmSync(fixture.root, {recursive: true, force: true}); }
});

test('a rename that succeeds before reporting an uncertain error is observed without redispatch', () => {
  const fixture = reviewFixture();
  const fsOps = Object.create(fs);
  const originalRename = fs.renameSync.bind(fs);
  const physicalTarget = fs.realpathSync(fixture.target);
  let reportUnknownOnce = true;
  fsOps.renameSync = (source, destination) => {
    originalRename(source, destination);
    if (reportUnknownOnce && path.resolve(destination) === physicalTarget) {
      reportUnknownOnce = false;
      throw new Error('simulated unknown effect after atomic rename');
    }
  };
  try {
    assert.throws(() => commitValidatedPdp0ReviewPostimage({...fixture.args, fsOps}), /unknown effect/u);
    assert.equal(fs.readFileSync(fixture.target, 'utf8'), fixture.postimage);
    const replay = commitValidatedPdp0ReviewPostimage(fixture.args);
    assert.equal(replay.state, 'POSTIMAGE_OBSERVED_AFTER_PRIOR_ATTEMPT');
    assert.equal(replay.canonicalWrite, 'NOT_PERFORMED_BY_THIS_CALL');
  } finally { fs.rmSync(fixture.root, {recursive: true, force: true}); }
});

test('directory fsync failure before target publication leaves no canonical write', () => {
  const fixture = reviewFixture();
  const fsOps = Object.create(fs);
  const originalOpen = fs.openSync.bind(fs);
  const originalFsync = fs.fsyncSync.bind(fs);
  const originalClose = fs.closeSync.bind(fs);
  const openedPaths = new Map();
  const targetDirectory = path.join(fs.realpathSync(fixture.root), reviewDir);
  let failed = false;
  fsOps.openSync = (filePath, ...args) => {
    const fd = originalOpen(filePath, ...args);
    openedPaths.set(fd, path.resolve(filePath));
    return fd;
  };
  fsOps.fsyncSync = fd => {
    if (!failed && fs.fstatSync(fd).isDirectory() && openedPaths.get(fd) === targetDirectory) {
      failed = true;
      throw new Error('simulated directory fsync failure before target publication');
    }
    return originalFsync(fd);
  };
  fsOps.closeSync = fd => { openedPaths.delete(fd); return originalClose(fd); };
  try {
    assert.throws(() => commitValidatedPdp0ReviewPostimage({...fixture.args, fsOps}), /directory fsync failure/u);
    assert.equal(failed, true);
    assert.equal(fs.readFileSync(fixture.target, 'utf8'), fixture.preimage);
    assert.equal(fs.existsSync(path.join(fixture.root, reviewDir, 'apply-journal.json')), false);
  } finally { fs.rmSync(fixture.root, {recursive: true, force: true}); }
});

test('directory fsync failure after target rename returns no success and replay observes without redispatch', () => {
  const fixture = reviewFixture();
  const fsOps = Object.create(fs);
  const originalOpen = fs.openSync.bind(fs);
  const originalFsync = fs.fsyncSync.bind(fs);
  const originalClose = fs.closeSync.bind(fs);
  const originalRename = fs.renameSync.bind(fs);
  const openedPaths = new Map();
  const targetDirectory = fs.realpathSync(path.dirname(fixture.target));
  let failed = false;
  let targetRenameCount = 0;
  fsOps.openSync = (filePath, ...args) => {
    const fd = originalOpen(filePath, ...args);
    openedPaths.set(fd, path.resolve(filePath));
    return fd;
  };
  fsOps.fsyncSync = fd => {
    if (!failed && fs.fstatSync(fd).isDirectory() && openedPaths.get(fd) === targetDirectory) {
      failed = true;
      throw new Error('simulated directory fsync failure after target rename');
    }
    return originalFsync(fd);
  };
  fsOps.closeSync = fd => { openedPaths.delete(fd); return originalClose(fd); };
  fsOps.renameSync = (source, destination) => {
    if (path.resolve(destination) === fs.realpathSync(fixture.target)) targetRenameCount += 1;
    return originalRename(source, destination);
  };
  try {
    assert.throws(() => commitValidatedPdp0ReviewPostimage({...fixture.args, fsOps}), /directory fsync failure/u);
    assert.equal(failed, true);
    assert.equal(targetRenameCount, 1);
    assert.equal(fs.readFileSync(fixture.target, 'utf8'), fixture.postimage);
    const journalPath = path.join(fixture.root, reviewDir, 'apply-journal.json');
    assert.equal(JSON.parse(fs.readFileSync(journalPath, 'utf8')).state, 'PREPARED');
    const replay = commitValidatedPdp0ReviewPostimage(fixture.args);
    assert.equal(replay.state, 'POSTIMAGE_OBSERVED_AFTER_PRIOR_ATTEMPT');
    assert.equal(replay.canonicalWrite, 'NOT_PERFORMED_BY_THIS_CALL');
    assert.equal(targetRenameCount, 1);
  } finally { fs.rmSync(fixture.root, {recursive: true, force: true}); }
});

test('journal directory fsync failure after commit record rename returns no success and replay does not redispatch', () => {
  const fixture = reviewFixture();
  const fsOps = Object.create(fs);
  const originalOpen = fs.openSync.bind(fs);
  const originalFsync = fs.fsyncSync.bind(fs);
  const originalClose = fs.closeSync.bind(fs);
  const originalRename = fs.renameSync.bind(fs);
  const openedPaths = new Map();
  const journalDirectory = path.join(fs.realpathSync(fixture.root), reviewDir);
  let journalDirectorySyncs = 0;
  let failed = false;
  let targetRenameCount = 0;
  fsOps.openSync = (filePath, ...args) => {
    const fd = originalOpen(filePath, ...args);
    openedPaths.set(fd, path.resolve(filePath));
    return fd;
  };
  fsOps.fsyncSync = fd => {
    if (fs.fstatSync(fd).isDirectory() && openedPaths.get(fd) === journalDirectory) {
      journalDirectorySyncs += 1;
      if (!failed && journalDirectorySyncs === 4) {
        failed = true;
        throw new Error('simulated journal directory fsync failure after commit-record rename');
      }
    }
    return originalFsync(fd);
  };
  fsOps.closeSync = fd => { openedPaths.delete(fd); return originalClose(fd); };
  fsOps.renameSync = (source, destination) => {
    if (path.resolve(destination) === fs.realpathSync(fixture.target)) targetRenameCount += 1;
    return originalRename(source, destination);
  };
  try {
    assert.throws(() => commitValidatedPdp0ReviewPostimage({...fixture.args, fsOps}), /journal directory fsync failure/u);
    assert.equal(failed, true);
    assert.equal(targetRenameCount, 1);
    assert.equal(fs.readFileSync(fixture.target, 'utf8'), fixture.postimage);
    const journalPath = path.join(fixture.root, reviewDir, 'apply-journal.json');
    assert.equal(JSON.parse(fs.readFileSync(journalPath, 'utf8')).state, 'COMMITTED_EXACT_READBACK');
    const replay = commitValidatedPdp0ReviewPostimage(fixture.args);
    assert.equal(replay.state, 'POSTIMAGE_OBSERVED_AFTER_PRIOR_ATTEMPT');
    assert.equal(replay.canonicalWrite, 'NOT_PERFORMED_BY_THIS_CALL');
    assert.equal(targetRenameCount, 1);
  } finally { fs.rmSync(fixture.root, {recursive: true, force: true}); }
});

test('refuses to overwrite a frozen preimage snapshot with different bytes', () => {
  const fixture = reviewFixture();
  const snapshot = path.join(fixture.root, reviewDir, 'preimages', `direct-review-${fixture.args.expectedTargetSha256}.json`);
  try {
    fs.mkdirSync(path.dirname(snapshot), {recursive: true});
    fs.writeFileSync(snapshot, 'different frozen snapshot\n', {flag: 'wx', mode: 0o600});
    assert.throws(() => commitValidatedPdp0ReviewPostimage(fixture.args), /snapshot path already contains different bytes/u);
    assert.equal(fs.readFileSync(snapshot, 'utf8'), 'different frozen snapshot\n');
    assert.equal(fs.readFileSync(fixture.target, 'utf8'), fixture.preimage);
    assert.equal(fs.existsSync(path.join(fixture.root, reviewDir, 'apply-journal.json')), false);
  } finally { fs.rmSync(fixture.root, {recursive: true, force: true}); }
});

test('rejects a source-amendment target parent symlink before creating journals or snapshots', () => {
  const fixture = sourceFixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'media-source-cas-outside-'));
  const targetParent = path.join(fixture.root, '.product-experience/pdp-0-product-truth');
  const outsideTarget = path.join(outside, 'capabilities.yaml');
  try {
    fs.writeFileSync(outsideTarget, fixture.preimages[0]);
    fs.rmSync(targetParent, {recursive: true, force: true});
    fs.symlinkSync(outside, targetParent, 'dir');
    const targets = fixture.targets.map((target, index) => ({...target,
      preimageBytes: fixture.preimages[index], postimageBytes: fixture.postimageBytes[target.targetRef]}));
    assert.throws(() => commitValidatedPdp0SourceAmendment({
      root: fixture.root, candidateSha256: 'd'.repeat(64), decisionRef: '.product-experience/decision-log.md#PXD-900',
      decisionSectionSha256: 'e'.repeat(64), applyAuthorizationSha256: 'f'.repeat(64), targets,
    }), /symbolic link/u);
    assert.equal(fs.readFileSync(outsideTarget).toString(), fixture.preimages[0].toString());
    assert.equal(fs.existsSync(path.join(fixture.root, 'docs/implementation/observations/pdp0-semantic-audit-slices/source-amendment-journals')), false);
  } finally {
    fs.rmSync(fixture.root, {recursive: true, force: true});
    fs.rmSync(outside, {recursive: true, force: true});
  }
});

test('rejects symlinked snapshot and journal paths before writing outside the repository', () => {
  const snapshotFixture = reviewFixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'media-review-cas-records-outside-'));
  const observations = path.join(snapshotFixture.root, reviewDir);
  try {
    fs.mkdirSync(observations, {recursive: true});
    const preimages = path.join(observations, 'preimages');
    fs.symlinkSync(outside, preimages, 'dir');
    assert.throws(() => commitValidatedPdp0ReviewPostimage(snapshotFixture.args), /symbolic link/u);
    assert.equal(fs.readdirSync(outside).length, 0);
    assert.equal(fs.existsSync(path.join(observations, 'apply-journal.json')), false);
  } finally {
    fs.rmSync(snapshotFixture.root, {recursive: true, force: true});
  }

  const journalFixture = reviewFixture();
  const journalOutside = path.join(outside, 'journal.json');
  const journalDir = path.join(journalFixture.root, reviewDir);
  try {
    fs.mkdirSync(journalDir, {recursive: true});
    fs.writeFileSync(journalOutside, 'frozen external journal\n', {flag: 'wx'});
    fs.symlinkSync(journalOutside, path.join(journalDir, 'apply-journal.json'));
    assert.throws(() => commitValidatedPdp0ReviewPostimage(journalFixture.args), /symbolic link/u);
    assert.equal(fs.readFileSync(journalOutside, 'utf8'), 'frozen external journal\n');
    assert.equal(fs.readFileSync(journalFixture.target, 'utf8'), journalFixture.preimage);
  } finally {
    fs.rmSync(journalFixture.root, {recursive: true, force: true});
    fs.rmSync(outside, {recursive: true, force: true});
  }
});

test('preserves modes for all files in the bounded source-amendment CAS', () => {
  const fixture = sourceFixture();
  try {
    const targets = fixture.targets.map((target, index) => ({...target,
      preimageBytes: fixture.preimages[index], postimageBytes: fixture.postimageBytes[target.targetRef]}));
    const result = commitValidatedPdp0SourceAmendment({
      root: fixture.root, candidateSha256: '1'.repeat(64), decisionRef: '.product-experience/decision-log.md#PXD-900',
      decisionSectionSha256: '2'.repeat(64), applyAuthorizationSha256: '3'.repeat(64), targets,
    });
    assert.equal(result.state, 'COMMITTED_EXACT_READBACK');
    for (const ref of sourceTargets) assert.equal(fs.statSync(path.join(fixture.root, ref)).mode & 0o777, 0o640);
  } finally { fs.rmSync(fixture.root, {recursive: true, force: true}); }
});

test('v4 CAS applies only the exact four reviewed source targets and keeps v2/v4 journal identity distinct', () => {
  const fixture = sourceV4Fixture();
  try {
    const result = commitValidatedPdp0SourceAmendment(fixture);
    assert.equal(result.state, 'COMMITTED_EXACT_READBACK');
    assert.equal(result.targets.length, 4);
    const journal = JSON.parse(fs.readFileSync(path.join(fixture.root, result.journalPath), 'utf8'));
    assert.equal(journal.schemaVersion, 'media.pdp0.source-amendment-apply-journal.v2');
    for (const [index, ref] of sourceTargetsV4.entries()) {
      assert.equal(fs.readFileSync(path.join(fixture.root, ref)).toString(), fixture.targets[index].postimageBytes.toString());
      assert.equal(fs.statSync(path.join(fixture.root, ref)).mode & 0o777, 0o640);
    }
    const replay = commitValidatedPdp0SourceAmendment(fixture);
    assert.equal(replay.state, 'POSTIMAGE_SET_OBSERVED_AFTER_PRIOR_ATTEMPT');
    assert.equal(replay.canonicalWrite, 'NOT_PERFORMED_BY_THIS_CALL');
  } finally { fs.rmSync(fixture.root, {recursive: true, force: true}); }
});

test('v4 CAS records a later partial publish and refuses to redispatch the remaining targets', () => {
  const fixture = sourceV4Fixture();
  const fsOps = Object.create(fs);
  const originalRename = fs.renameSync.bind(fs);
  const physicalRoot = fs.realpathSync(fixture.root);
  const targetPaths = new Set(fixture.targets.map(row => path.resolve(physicalRoot, row.targetRef)));
  let targetRenames = 0;
  fsOps.renameSync = (source, destination) => {
    const result = originalRename(source, destination);
    if (targetPaths.has(path.join(fs.realpathSync(path.dirname(destination)), path.basename(destination)))) {
      targetRenames += 1;
      if (targetRenames === 2) throw new Error('simulated interruption after second source target rename');
    }
    return result;
  };
  const args = {...fixture, fsOps};
  const journalPath = path.join(fixture.root, 'docs/implementation/observations/pdp0-semantic-audit-slices/source-amendment-journals', `${fixture.plan.candidateSha256}.json`);
  try {
    assert.throws(() => commitValidatedPdp0SourceAmendmentV4(args), /interruption after second source target rename/u);
    assert.equal(targetRenames, 2);
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    assert.equal(journal.state, 'PREPARED');
    assert.equal(journal.targets[0].state, 'COMMITTED_EXACT_READBACK');
    assert.equal(journal.targets[1].state, 'PENDING');
    assert.deepEqual(fixture.targets.map(row => fs.readFileSync(path.join(fixture.root, row.targetRef))), [
      fixture.targets[0].postimageBytes,
      fixture.targets[1].postimageBytes,
      fixture.targets[2].preimageBytes,
      fixture.targets[3].preimageBytes,
    ]);

    fsOps.renameSync = (...renameArgs) => {
      const destination = renameArgs[1];
      const physicalDestination = path.join(fs.realpathSync(path.dirname(destination)), path.basename(destination));
      if (targetPaths.has(physicalDestination)) targetRenames += 1;
      return originalRename(...renameArgs);
    };
    assert.throws(() => commitValidatedPdp0SourceAmendmentV4(args), /partial or uncertain target set; reconcile explicitly; no redispatch/u);
    assert.equal(targetRenames, 2);
    assert.deepEqual(fixture.targets.map(row => fs.readFileSync(path.join(fixture.root, row.targetRef))), [
      fixture.targets[0].postimageBytes,
      fixture.targets[1].postimageBytes,
      fixture.targets[2].preimageBytes,
      fixture.targets[3].preimageBytes,
    ]);
  } finally { fs.rmSync(fixture.root, {recursive: true, force: true}); }
});

test('v4 CAS stops after second target parent-directory fsync failure and replay does not redispatch', () => {
  const fixture = sourceV4Fixture();
  const fsOps = Object.create(fs);
  const originalOpen = fs.openSync.bind(fs);
  const originalFsync = fs.fsyncSync.bind(fs);
  const targetDirectory = path.join(fs.realpathSync(fixture.root), '.product-experience/pdp-0-product-truth');
  const openedPaths = new Map();
  let targetDirectorySyncs = 0;
  let failed = false;
  fsOps.openSync = (filePath, ...args) => {
    const fd = originalOpen(filePath, ...args);
    openedPaths.set(fd, fs.realpathSync(filePath));
    return fd;
  };
  fsOps.fsyncSync = fd => {
    if (fs.fstatSync(fd).isDirectory() && openedPaths.get(fd) === targetDirectory) {
      targetDirectorySyncs += 1;
      if (!failed && targetDirectorySyncs === 2) {
        failed = true;
        throw new Error('simulated second target parent-directory fsync failure');
      }
    }
    return originalFsync(fd);
  };
  const args = {...fixture, fsOps};
  const journalPath = path.join(fixture.root, 'docs/implementation/observations/pdp0-semantic-audit-slices/source-amendment-journals', `${fixture.plan.candidateSha256}.json`);
  try {
    assert.throws(() => commitValidatedPdp0SourceAmendmentV4(args), /second target parent-directory fsync failure/u);
    assert.equal(failed, true);
    assert.equal(targetDirectorySyncs, 2);
    assert.deepEqual(fixture.targets.map(row => fs.readFileSync(path.join(fixture.root, row.targetRef))), [
      fixture.targets[0].postimageBytes,
      fixture.targets[1].postimageBytes,
      fixture.targets[2].preimageBytes,
      fixture.targets[3].preimageBytes,
    ]);
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    assert.equal(journal.state, 'PREPARED');
    assert.equal(journal.targets[0].state, 'COMMITTED_EXACT_READBACK');
    assert.equal(journal.targets[1].state, 'PENDING');
    assert.throws(() => commitValidatedPdp0SourceAmendmentV4({...fixture, fsOps: fs}), /partial or uncertain target set; reconcile explicitly; no redispatch/u);
    assert.deepEqual(fixture.targets.map(row => fs.readFileSync(path.join(fixture.root, row.targetRef))), [
      fixture.targets[0].postimageBytes,
      fixture.targets[1].postimageBytes,
      fixture.targets[2].preimageBytes,
      fixture.targets[3].preimageBytes,
    ]);
  } finally { fs.rmSync(fixture.root, {recursive: true, force: true}); }
});

test('v4 CAS refuses omitted, reordered, or plan-unbound fourth target before journaling', () => {
  const fixture = sourceV4Fixture();
  try {
    assert.throws(() => commitValidatedPdp0SourceAmendmentV4({...fixture, targets: fixture.targets.slice(0, 3)}), /incomplete or not explicitly reviewed/u);
    assert.throws(() => commitValidatedPdp0SourceAmendmentV4({...fixture, targets: [fixture.targets[1], fixture.targets[0], ...fixture.targets.slice(2)]}), /exact four target preimages/u);
    const altered = structuredClone(fixture.plan);
    altered.targets[3].expectedPostimageSha256 = 'a'.repeat(64);
    assert.throws(() => commitValidatedPdp0SourceAmendmentV4({...fixture, plan: altered}), /exact four target preimages/u);
    assert.equal(fs.existsSync(path.join(fixture.root, 'docs/implementation/observations/pdp0-semantic-audit-slices/source-amendment-journals')), false);
    for (let index = 0; index < sourceTargetsV4.length; index += 1) {
      assert.equal(fs.readFileSync(path.join(fixture.root, sourceTargetsV4[index])).toString(), fixture.targets[index].preimageBytes.toString());
    }
  } finally { fs.rmSync(fixture.root, {recursive: true, force: true}); }
});

test('six-file CAS rejects unbound candidate and authority references before creating a journal', () => {
  const fixture = sourceSixFileFixture();
  try {
    const invalidPlans = [
      {...fixture.plan, candidateRef: 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-amendment-candidate.v6.json'},
      {...fixture.plan, candidateSchemaVersion: 'media.pdp0.aud-spec-002-source-amendment-candidate.v6'},
      {...fixture.plan, candidateSha256: '0'.repeat(64)},
      {...fixture.plan, candidatePostimageSha256: '0'.repeat(64)},
      {...fixture.plan, sourceOwnerDecisionRef: 'docs/implementation/observations/pdp0-semantic-audit-slices/other-owner-decision.json'},
      {...fixture.plan, technicalPeerReviewRef: 'docs/implementation/observations/pdp0-semantic-audit-slices/other-peer-review.json'},
      {...fixture.plan, sourceOwnerIdentity: fixture.plan.peerIdentity},
      {...fixture.plan, peerIdentity: fixture.plan.sourceOwnerIdentity},
      {...fixture.plan, rootGrantCurrent: false},
      {...fixture.plan, blockers: ['CURRENT_EXACT_V7_ROOT_GRANT_REQUIRED']},
    ];
    for (const plan of invalidPlans) {
      assert.throws(() => commitValidatedPdp0SourceAmendmentSixFile({plan,targets:fixture.targets}), /incomplete or not explicitly reviewed/u);
    }
    assert.throws(() => commitValidatedPdp0SourceAmendmentSixFile({plan:fixture.plan,targets:fixture.targets.slice(0, 5)}), /incomplete or not explicitly reviewed/u);
    assert.throws(() => commitValidatedPdp0SourceAmendmentSixFile({plan:fixture.plan,targets:[fixture.targets[1],fixture.targets[0],...fixture.targets.slice(2)]}), /exact six target preimages/u);
    const altered = structuredClone(fixture.plan);
    altered.targets[5].expectedPostimageSha256 = '0'.repeat(64);
    assert.throws(() => commitValidatedPdp0SourceAmendmentSixFile({plan:altered,targets:fixture.targets}), /exact six target preimages/u);
    assert.equal(fs.existsSync(path.join(fixture.root, 'docs/implementation/observations/pdp0-semantic-audit-slices/source-amendment-journals')), false);
    for (const row of fixture.targets) assert.deepEqual(fs.readFileSync(path.join(fixture.root, row.targetRef)), row.preimageBytes);
  } finally { cleanupV7Fixture(fixture); }
});

test('six-file public CAS rejects caller-selected roots and filesystem adapters before invoking any hook', () => {
  const fixture=sourceSixFileFixture();
  let hooks=0;
  const fakeFs={readFileSync(){hooks+=1;return Buffer.from('{}');},openSync(){hooks+=1;return 1;},renameSync(){hooks+=1;},writeFileSync(){hooks+=1;}};
  try{
    assert.throws(()=>commitValidatedPdp0SourceAmendmentSixFile({plan:fixture.plan,targets:fixture.targets,root:fixture.root}),/caller roots, filesystem adapters, and readers are forbidden/u);
    assert.throws(()=>commitValidatedPdp0SourceAmendmentSixFile({plan:fixture.plan,targets:fixture.targets,fsOps:fakeFs}),/caller roots, filesystem adapters, and readers are forbidden/u);
    assert.throws(()=>commitValidatedPdp0SourceAmendmentSixFile({plan:fixture.plan,targets:fixture.targets,readSource:()=>Buffer.from('{}')}),/caller roots, filesystem adapters, and readers are forbidden/u);
    assert.equal(hooks,0);
  }finally{cleanupV7Fixture(fixture);}
});

test('six-file public CAS commits an exact reviewed plan in an isolated installed repository', async () => {
  const fixture=sourceSixFileFixture();
  try {
    const lib=installCasModules(fixture);
    const installed=await import(`${pathToFileURL(path.join(lib,'media-pdp0-review-successor-cas.mjs')).href}?positive=${Date.now()}`);
    const result=installed.commitValidatedPdp0SourceAmendmentSixFile({plan:fixture.plan,targets:fixture.targets});
    assert.equal(result.state,'COMMITTED_EXACT_READBACK');
    assert.equal(result.targets.length,6);
    for(const row of fixture.targets) {
      assert.deepEqual(fs.readFileSync(path.join(fixture.root,row.targetRef)),row.postimageBytes);
      assert.equal(fs.statSync(path.join(fixture.root,row.targetRef)).mode&0o777,row.expectedMode);
    }
    const journal=JSON.parse(fs.readFileSync(path.join(fixture.root,result.journalPath),'utf8'));
    assert.equal(journal.state,'COMMITTED_EXACT_READBACK');
    assert.equal(journal.targets.length,6);
  } finally { cleanupV7Fixture(fixture); }
});

test('six-file public CAS refuses a synthetic plan against installed authority or an existing attempt journal', () => {
  const fixture = sourceSixFileFixture();
  const before=sourceTargetsSixFile.map(ref=>digest(fs.readFileSync(path.join(testRepositoryRoot,ref))));
  try {
    assert.throws(()=>commitValidatedPdp0SourceAmendmentSixFile({plan:fixture.plan,targets:fixture.targets}),/fixed owner, peer, or current-root-grant records changed|existing source-amendment journal belongs to a different attempt/u);
    assert.deepEqual(sourceTargetsSixFile.map(ref=>digest(fs.readFileSync(path.join(testRepositoryRoot,ref)))),before);
  } finally { cleanupV7Fixture(fixture); }
});

test('quality adoption CAS rejects a caller-authored ready plan when exact fixed source records are absent', () => {
  const fixture=qualityTwoTargetFixture();
  try {
    assert.throws(()=>commitValidatedPdp0SourceAmendmentQualityTwoTarget({plan:fixture.plan,targets:fixture.targets}));
    assert.equal(fs.existsSync(path.join(fixture.root,'docs/implementation/observations/pdp0-semantic-audit-slices/source-amendment-journals',`${fixture.plan.candidateSha256}.json`)),false);
    for(const row of fixture.targets)assert.deepEqual(fs.readFileSync(path.join(fixture.root,row.targetRef)),row.preimageBytes);
  } finally { fs.rmSync(fixture.root,{recursive:true,force:true}); }
});

test('quality adoption CAS fails before journal creation on wrong identity, blocked plan, predecessor divergence, or target order', () => {
  const fixture=qualityTwoTargetFixture();
  try {
    const invalid=[
      {...fixture.plan,peerIdentity:'agent:/root/phase_io'},
      {...fixture.plan,planDisposition:'BLOCKED_PENDING_EXACT_PREREQUISITES'},
      {...fixture.plan,v7Predecessor:{...fixture.plan.v7Predecessor,state:'DIVERGED'}},
      {...fixture.plan,targets:[fixture.plan.targets[1],fixture.plan.targets[0]]},
      {...fixture.plan,applyAuthorizationSha256:null},
    ];
    for(const plan of invalid) assert.throws(()=>commitValidatedPdp0SourceAmendmentQualityTwoTarget({plan,targets:fixture.targets}));
    assert.equal(fs.existsSync(path.join(fixture.root,'docs/implementation/observations/pdp0-semantic-audit-slices/source-amendment-journals',`${fixture.plan.candidateSha256}.json`)),false);
    for(const row of fixture.targets) assert.deepEqual(fs.readFileSync(path.join(fixture.root,row.targetRef)),row.preimageBytes);
  } finally { fs.rmSync(fixture.root,{recursive:true,force:true}); }
});

test('quality adoption CAS rejects caller-selected filesystem adapters before effects', () => {
  const fixture=qualityTwoTargetFixture();
  let hooks=0;const fakeFs={readFileSync(){hooks+=1;return Buffer.from('{}');},openSync(){hooks+=1;return 1;},renameSync(){hooks+=1;},writeFileSync(){hooks+=1;}};
  try{
    assert.throws(()=>commitValidatedPdp0SourceAmendmentQualityTwoTarget({plan:fixture.plan,targets:fixture.targets,root:fixture.root}),/caller roots, filesystem adapters, and readers are forbidden/u);
    assert.throws(()=>commitValidatedPdp0SourceAmendmentQualityTwoTarget({plan:fixture.plan,targets:fixture.targets,fsOps:fakeFs}),/caller roots, filesystem adapters, and readers are forbidden/u);
    assert.throws(()=>commitValidatedPdp0SourceAmendmentQualityTwoTarget({plan:fixture.plan,targets:fixture.targets,readSource:()=>Buffer.from('{}')}),/caller roots, filesystem adapters, and readers are forbidden/u);
    assert.equal(hooks,0);
  }finally{fs.rmSync(fixture.root,{recursive:true,force:true});}
});

test('quality public CAS commits exact reviewed targets in an isolated installed repository', async () => {
  const fixture=isolatedQualityWriterFixture();
  try {
    const {cas,plan,targets}=await qualityWriterReadyCall(fixture);
    const result=cas.commitValidatedPdp0SourceAmendmentQualityTwoTarget({plan,targets});
    assert.equal(result.state,'COMMITTED_EXACT_READBACK');
    assert.equal(result.targets.length,2);
    for(const row of targets) assert.deepEqual(fs.readFileSync(path.join(fixture.root,row.targetRef)),row.postimageBytes);
    const journal=JSON.parse(fs.readFileSync(path.join(fixture.root,result.journalPath),'utf8'));
    assert.equal(journal.state,'COMMITTED_EXACT_READBACK');
    assert.deepEqual(journal.targets.map(row=>row.targetRef),QUALITY_TARGETS);
  } finally { fs.rmSync(fixture.temp,{recursive:true,force:true}); }
});

test('quality public CAS rejects a symlinked Lifecycle authority source before journal or target writes', async () => {
  const fixture=isolatedQualityWriterFixture();
  const siblingRoot=path.join(path.dirname(fixture.root),'ghatana-lifecycle');
  const choiceRef='docs/engineering/reviews/gtool-critical-2026-10-23/media-aud-spec-002-quality-applicability-root-choice-r01.json';
  const choicePath=path.join(siblingRoot,choiceRef);
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'media-quality-cas-lifecycle-outside-'));
  const outsidePath=path.join(outside,'choice.json');
  try {
    const {cas,plan,targets}=await qualityWriterReadyCall(fixture);
    const before=targets.map(row=>[row.targetRef,fs.readFileSync(path.join(fixture.root,row.targetRef))]);
    fs.copyFileSync(choicePath,outsidePath);
    fs.unlinkSync(choicePath);
    fs.symlinkSync(outsidePath,choicePath);
    assert.throws(()=>cas.commitValidatedPdp0SourceAmendmentQualityTwoTarget({plan,targets}),/symbolic link/u);
    for(const [ref,bytes] of before) assert.deepEqual(fs.readFileSync(path.join(fixture.root,ref)),bytes);
    assert.equal(fs.existsSync(path.join(fixture.root,'docs/implementation/observations/pdp0-semantic-audit-slices/source-amendment-journals',`${plan.candidateSha256}.json`)),false);
    assert.deepEqual(fs.readdirSync(outside),['choice.json']);
  } finally {
    fs.rmSync(fixture.temp,{recursive:true,force:true});
    fs.rmSync(outside,{recursive:true,force:true});
  }
});
