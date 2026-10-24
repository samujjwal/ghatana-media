import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {fingerprintPxdDecisionSection} from '../scripts/lib/pdp0-phase-scoped-source-fingerprints.mjs';
import {prepareQualityExtensionSourceCandidateV2} from '../scripts/lib/media-pdp0-quality-extension-source-candidate-v2.mjs';
import {applyQualityExtensionSourceAdoptionV2, planQualityExtensionSourceAdoptionV2, qualityExtensionAdoptionPlanFingerprint, verifyQualityExtensionSourceAdoptionV2, TARGETS} from '../scripts/lib/media-pdp0-quality-extension-source-adoption-v2.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.resolve(root, '../ghatana-tools/package.json'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(`${JSON.stringify(value,null,2)}\n`);
const read = ref => fs.readFileSync(ref.startsWith('ghatana-lifecycle:')
  ? path.resolve(root,'../ghatana-lifecycle',ref.slice('ghatana-lifecycle:'.length))
  : ref.startsWith('../ghatana-lifecycle/')
    ? path.resolve(root,'..',ref.slice('../'.length))
    : path.join(root,ref));
const obs = 'docs/implementation/observations/pdp0-semantic-audit-slices/';
const candidateRef = `${obs}AUD-SPEC-002-quality-extension-source-candidate.v2.json`;
const schemaRef = `${obs}AUD-SPEC-002-quality-extension-source-candidate.v2.schema.json`;
const freezeRef = `${obs}AUD-SPEC-002-quality-extension-source-candidate-v2-freeze-manifest.v1.json`;
const peerRef = `${obs}AUD-SPEC-002-quality-extension-independent-peer.v2.json`;
const decisionRef = `${obs}AUD-SPEC-002-quality-extension-source-owner-decision.v2.json`;
const authRef = `${obs}AUD-SPEC-002-quality-extension-apply-authorization.v2.json`;
const v7ManifestRef = `${obs}AUD-SPEC-002-source-amendment-v7-freeze-manifest.v1.json`;
const v7Manifest = JSON.parse(read(v7ManifestRef));
const qualityApplyReadback = JSON.parse(read('docs/implementation/observations/media-pdp0-parent-case-resolution-candidates/media-pdp0-quality2target-actual-root-source-readback-2026-10-23.json'));
const qualityPolicyPreimageRef = qualityApplyReadback.result.targets.find(row => row.targetRef === TARGETS[1]).immutablePreimageRef;
const fixtureRead = ref => ref === TARGETS[1] ? read(qualityPolicyPreimageRef) : read(ref);

function preparedFixture({v7Current = false, decisionEnabled = false, authorizationEnabled = false, peerEnabled = false, divergedTarget} = {}) {
  const prepared = prepareQualityExtensionSourceCandidateV2({readSource:fixtureRead});
  const candidateBytes = json(prepared.candidate);
  const schemaBytes = json(prepared.schema);
  const freeze = {schemaVersion:'media.pdp0.quality-extension-source-candidate-v2-freeze-manifest.v1',
    candidateRef,candidateSha256:sha(candidateBytes),schemaRef,schemaSha256:sha(schemaBytes),targets:prepared.candidate.targets};
  const peerRow = {schemaVersion:'media.pdp0.quality-extension-independent-peer.v2',auditId:'AUD-SPEC-002',candidateRef,
    candidateSha256:sha(candidateBytes),candidatePostimageSha256:prepared.candidate.candidatePostimageSha256,
    predecessor:{v7CandidateRef:`${obs}AUD-SPEC-002-source-amendment-candidate.v7.json`,v7CandidateSha256:v7Manifest.candidateSha256,
      v7ManifestRef,v7ManifestSha256:sha(read(v7ManifestRef)),v7PeerRef:`${obs}AUD-SPEC-002-v7-quality-extension-independent-peer.v2.json`,v7PeerSha256:sha(read(`${obs}AUD-SPEC-002-v7-quality-extension-independent-peer.v2.json`))},
    targetPostimages:prepared.candidate.targets.map(({targetRef,preimageSha256,postimageSha256})=>({targetRef,preimageSha256,postimageSha256})),
    reviewer:{identity:'agent:thread:test-peer',role:'DISTINCT_TECHNICAL_PEER',candidateAuthorIdentity:'agent:/root/phase_io',independentHumanReviewer:false,credentialedAttestation:false},
    disposition:'TECHNICAL_APPROVE_EXACT_CANDIDATE_ONLY',findings:[],authorityBoundary:{sourceOwnerAdoption:'PENDING',canonicalApply:'NOT_PERFORMED',sourceCurrentness:'NOT_CLAIMED',phaseStatusEffect:'NONE',independentAcceptance:'NOT_CLAIMED',nativeProof:'NOT_CLAIMED'}};
  const peerBytes = json(peerRow);
  const targetRows = prepared.candidate.targets.map(({targetRef,preimageSha256,postimageSha256})=>({targetRef,expectedPreimageSha256:preimageSha256,expectedPostimageSha256:postimageSha256}));
  const decision = {schemaVersion:'media.pdp0.quality-extension-source-owner-decision.v2',decisionKind:'ADOPT_EXACT_QUALITY_EXTENSION_TWO_TARGET_SOURCE_CANDIDATE',
    candidateRef,candidateSha256:sha(candidateBytes),candidatePostimageSha256:prepared.candidate.candidatePostimageSha256,peerReviewRef:peerRef,peerReviewSha256:sha(peerBytes),
    v7ManifestSha256:sha(read(v7ManifestRef)),decisionRef:'.product-experience/decision-log.md#PXD-227',
    decisionSectionSha256:fingerprintPxdDecisionSection(prepared.decisionLogPostimageBytes.toString('utf8'),'PXD-227').sha256,
    targetRows,sourceOwner:{identity:'agent:/root',role:'PDP0_SOURCE_OWNER'},disposition:'APPROVE_EXACT_CANDIDATE_FOR_SOURCE_APPLY',
    authorityBoundary:{sourceDefinitionOnly:true,independentAcceptance:'NOT_CLAIMED',phaseStatusEffect:'NONE',nativeProof:'NOT_CLAIMED',runtimeAdmission:'NOT_ADMITTED',measurement:'NOT_EVALUATED',qualification:'NOT_EVALUATED'}};
  const decisionBytes = json(decision);
  const authorizationRow = {schemaVersion:'media.pdp0.quality-extension-apply-authorization.v2',effect:'APPLY_EXACT_QUALITY_EXTENSION_TWO_TARGET_SOURCE_CANDIDATE',
    candidateRef,candidateSha256:sha(candidateBytes),candidatePostimageSha256:prepared.candidate.candidatePostimageSha256,
    sourceOwnerDecisionRef:decisionRef,sourceOwnerDecisionSha256:sha(decisionBytes),peerReviewRef:peerRef,peerReviewSha256:sha(peerBytes),
    decisionRef:decision.decisionRef,decisionSectionSha256:decision.decisionSectionSha256,targetRows,
    sourceOwner:{identity:'agent:/root',role:'PDP0_SOURCE_OWNER'},
    distinctTechnicalPeer:{identity:'agent:thread:test-peer',role:'DISTINCT_TECHNICAL_PEER',reviewedCandidateSha256:sha(candidateBytes),reviewedPostimageSha256:prepared.candidate.candidatePostimageSha256},
    authorityBoundary:{sourceOwnerAdoption:'EXACT_SOURCE_CHANGE_AUTHORIZED',independentAcceptance:'NOT_CLAIMED',phaseStatusEffect:'NONE',nativeProof:'NOT_CLAIMED',runtimeAdmission:'NOT_ADMITTED',measurement:'NOT_EVALUATED',qualification:'NOT_EVALUATED'}};
  const authBytes = json(authorizationRow);
  const artifacts = new Map([[candidateRef,candidateBytes],[schemaRef,schemaBytes],[freezeRef,json(freeze)],
    [prepared.candidate.targets[0].postimageRef,prepared.decisionLogPostimageBytes],
    [prepared.candidate.targets[1].postimageRef,prepared.qualityPostimageBytes]]);
  const v7Postimages = new Map(v7Manifest.postimageArtifactRefs.map((row,index)=>[v7Manifest.targetPostimages[index].targetRef,read(row.ref)]));
  const currentTargets = new Map(TARGETS.map(ref => [ref,read(ref)]));
  currentTargets.set(TARGETS[1],read(qualityPolicyPreimageRef));
  if (v7Current) {
    for (const [ref,bytes] of v7Postimages) currentTargets.set(ref,bytes);
  } else {
    const journalRef=`${obs}source-amendment-journals/${v7Manifest.candidateSha256}.json`;
    const journalPath=path.join(root,journalRef);
    if(fs.existsSync(journalPath)) {
      const journal=JSON.parse(fs.readFileSync(journalPath,'utf8'));
      assert.equal(journal.state,'COMMITTED_EXACT_READBACK','fixture must explicitly model the installed V7 postimage or its archived preimage');
      const journalRows=new Map((journal.targets??[]).map(row=>[row.targetRef,row]));
      for(const target of v7Manifest.targetPostimages) {
        const row=journalRows.get(target.targetRef);
        assert.equal(row?.state,'COMMITTED_EXACT_READBACK');
        assert.equal(row.expectedPreimageSha256,target.preimageSha256);
        const bytes=read(row.immutablePreimageRef);
        assert.equal(sha(bytes),target.preimageSha256);
        currentTargets.set(target.targetRef,bytes);
      }
    }
  }
  if (divergedTarget) currentTargets.set(divergedTarget,Buffer.from('diverged current source'));
  const optionalAuthority = new Map([[peerRef,peerEnabled?peerBytes:null],[decisionRef,decisionEnabled?decisionBytes:null],[authRef,authorizationEnabled?authBytes:null]]);
  const source = ref => {
    if(optionalAuthority.has(ref)){
      const bytes=optionalAuthority.get(ref);
      if(bytes)return bytes;
      const error=new Error(`fixture authority record absent: ${ref}`);error.code='ENOENT';throw error;
    }
    return artifacts.get(ref) ?? currentTargets.get(ref) ?? read(ref);
  };
  const result = planQualityExtensionSourceAdoptionV2({readSource:source,peerReviewBytes:peerEnabled?peerBytes:undefined,
    ownerDecisionBytes:decisionEnabled?decisionBytes:undefined,applyAuthorizationBytes:authorizationEnabled?authBytes:undefined});
  return {prepared,source,result,peerRow,peerBytes,decision,decisionBytes,authorizationRow,authBytes,freeze,candidateBytes,schemaBytes};
}

function isolatedReadyAdapterFixture() {
  const prepared=preparedFixture({v7Current:true,peerEnabled:true,decisionEnabled:true,authorizationEnabled:true});
  const parent=fs.mkdtempSync(path.join(os.tmpdir(),'media-quality-adoption-adapter-'));
  const mediaRoot=path.join(parent,'ghatana-media');
  const lifecycleRoot=path.join(parent,'ghatana-lifecycle');
  fs.mkdirSync(path.join(mediaRoot,'scripts/lib'),{recursive:true});
  fs.mkdirSync(lifecycleRoot,{recursive:true});
  fs.symlinkSync(path.resolve(root,'../ghatana-tools'),path.join(parent,'ghatana-tools'),'dir');
  for(const name of fs.readdirSync(path.join(root,'scripts/lib')).filter(name=>name.endsWith('.mjs'))){
    fs.copyFileSync(path.join(root,'scripts/lib',name),path.join(mediaRoot,'scripts/lib',name));
  }
  const refs=new Set([
    candidateRef,schemaRef,freezeRef,peerRef,`${obs}AUD-SPEC-002-quality-extension-independent-peer.v2.schema.json`,
    decisionRef,`${obs}AUD-SPEC-002-quality-extension-source-owner-decision.v2.schema.json`,
    authRef,`${obs}AUD-SPEC-002-quality-extension-apply-authorization.v2.schema.json`,
    `${obs}AUD-SPEC-002-quality-extension-source-adoption-cas-plan.v2.schema.json`,
    `${obs}AUD-SPEC-002-quality-applicability-extension-candidate.v1.json`,
    `${obs}AUD-SPEC-002-quality-extension-pxd227-section-candidate.v1.md`,
    v7ManifestRef,`${obs}AUD-SPEC-002-source-amendment-candidate.v7.json`,`${obs}AUD-SPEC-002-source-amendment-candidate.v7.schema.json`,
    `${obs}AUD-SPEC-002-source-amendment-postimage.v7.json`,`${obs}AUD-SPEC-002-source-amendment-postimage.v7.schema.json`,
    `${obs}AUD-SPEC-002-v7-quality-extension-independent-peer.v2.json`,
    '../ghatana-lifecycle/docs/engineering/reviews/gtool-critical-2026-10-23/media-aud-spec-002-quality-applicability-root-choice-r01.json',
    'ghatana-lifecycle:docs/engineering/reviews/gtool-critical-2026-10-23/media-aud-spec-002-version-population-root-decision.json',
    '.product-experience/pdp-0-product-truth/applications-channels.yaml',
    'docs/implementation/references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json',
    ...TARGETS,
  ]);
  const addPeerLineage=ref=>{
    const row=JSON.parse(prepared.source(ref));
    for(const item of [row.sourceOrigin?.priorReviewRecordRef,row.sourceOrigin?.correctedSuccessorRef]) if(item) refs.add(item);
    for(const item of Object.values(row.reviewBinding?.exactCutRefs??{})) if(typeof item==='string') refs.add(item);
  };
  const manifest=JSON.parse(prepared.source(v7ManifestRef));
  for(const row of manifest.targetPostimages) refs.add(row.targetRef);
  for(const row of manifest.postimageArtifactRefs) refs.add(row.ref);
  refs.add(manifest.reconciliationRef);
  for(const ref of Object.keys(manifest.producerPins??{})) refs.add(ref);
  const v7candidate=JSON.parse(prepared.source(`${obs}AUD-SPEC-002-source-amendment-candidate.v7.json`));
  refs.add(v7candidate.rootDecisionRef);
  addPeerLineage(`${obs}AUD-SPEC-002-v7-quality-extension-independent-peer.v2.json`);
  addPeerLineage(`${obs}AUD-SPEC-002-source-amendment-independent-peer.v7.json`);
  const qualityPeer=JSON.parse(prepared.source(peerRef));
  for(const ref of Object.values(qualityPeer.reviewBinding?.exactCutRefs??{})) if(typeof ref==='string') refs.add(ref);
  for(const row of prepared.prepared.candidate.targets){refs.add(row.targetRef);refs.add(row.preimageRef);refs.add(row.postimageRef);}
  const writeRef=(ref,bytes)=>{
    const external=ref.startsWith('ghatana-lifecycle:')||ref.startsWith('../ghatana-lifecycle/');
    const base=external?lifecycleRoot:mediaRoot;
    const suffix=ref.startsWith('ghatana-lifecycle:')?ref.slice('ghatana-lifecycle:'.length):ref.startsWith('../ghatana-lifecycle/')?ref.slice('../ghatana-lifecycle/'.length):ref;
    const file=path.join(base,suffix);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);
  };
  for(const ref of refs) writeRef(ref,prepared.source(ref));
  writeRef(peerRef,prepared.peerBytes);writeRef(decisionRef,prepared.decisionBytes);writeRef(authRef,prepared.authBytes);
  return {parent,mediaRoot,peerRef,authRef,targets:[...TARGETS,...manifest.targetPostimages.map(row=>row.targetRef)],writeRef};
}

test('adoption plan preserves the six-file V7 blocker and returns typed prerequisites without writes', () => {
  const before = read(TARGETS[1]);
  const f = preparedFixture();
  assert.equal(f.result.plan.v7Predecessor.state,'NOT_APPLIED');
  assert.ok(f.result.plan.blockers.includes('V7_SIX_SOURCE_AMENDMENT_NOT_APPLIED'));
  assert.ok(f.result.plan.blockers.includes('DISTINCT_PEER_REVIEW_OF_EXACT_TWO_TARGET_CANDIDATE_REQUIRED'));
  assert.ok(f.result.plan.blockers.includes('ROOT_SOURCE_OWNER_DECISION_REQUIRED'));
  assert.ok(f.result.plan.blockers.includes('EXACT_TWO_TARGET_APPLY_AUTHORIZATION_REQUIRED'));
  const Ajv2020 = require('ajv/dist/2020');
  const schema = JSON.parse(read(`${obs}AUD-SPEC-002-quality-extension-source-adoption-cas-plan.v2.schema.json`));
  assert.equal(new Ajv2020({strict:true}).compile(schema)(f.result.plan),true);
  assert.ok(read(TARGETS[1]).equals(before));
});

test('exact V7 currentness clears only its predecessor blocker; the new two-target candidate stays blocked for its own reviews', () => {
  const f = preparedFixture({v7Current:true});
  assert.equal(f.result.plan.v7Predecessor.state,'EXACT_CURRENT_READBACK');
  assert.equal(f.result.plan.targets[0].expectedPreimageSha256,f.result.plan.v7Predecessor.targets.find(row=>row.targetRef===TARGETS[0]).expectedPostimageSha256);
  assert.ok(!f.result.plan.blockers.includes('V7_SIX_SOURCE_AMENDMENT_NOT_APPLIED'));
  assert.ok(f.result.plan.blockers.includes('DISTINCT_PEER_REVIEW_OF_EXACT_TWO_TARGET_CANDIDATE_REQUIRED'));
});

test('divergent predecessor target cannot be treated as V7 current', () => {
  const f = preparedFixture({divergedTarget:'.product-experience/pdp-0-product-truth/capabilities.yaml'});
  assert.equal(f.result.plan.v7Predecessor.state,'DIVERGED');
  assert.ok(f.result.plan.blockers.includes('V7_SOURCE_TARGET_DIVERGED_REQUIRES_EXPLICIT_RECONCILIATION'));
});

test('peer, owner decision, and apply authorization must all bind the exact two-target successor', () => {
  const f = preparedFixture({v7Current:true,peerEnabled:true,decisionEnabled:true,authorizationEnabled:true});
  assert.deepEqual(f.result.plan.blockers,[]);
  assert.equal(f.result.plan.planDisposition,'READY_FOR_SHARED_OWNER_CONTROLLED_CAS');
  const corruptPeer = structuredClone(f.peerRow);
  corruptPeer.reviewer.identity = 'agent:/root';
  assert.throws(() => planQualityExtensionSourceAdoptionV2({readSource:f.source,peerReviewBytes:json(corruptPeer)}),/schema-invalid|distinct source author\/owner/u);
  const corruptDecision = {...f.decision,candidateSha256:'0'.repeat(64)};
  const bytes = json(corruptDecision);
  assert.throws(() => planQualityExtensionSourceAdoptionV2({readSource:f.source,peerReviewBytes:f.peerBytes,ownerDecisionBytes:bytes,applyAuthorizationBytes:f.authBytes}),/does not authorize/u);
  const corruptAuth = {...f.authorizationRow,candidatePostimageSha256:'0'.repeat(64)};
  assert.throws(() => planQualityExtensionSourceAdoptionV2({readSource:f.source,peerReviewBytes:f.peerBytes,ownerDecisionBytes:f.decisionBytes,applyAuthorizationBytes:json(corruptAuth)}),/does not bind/u);
});

test('apply ignores cached caller authority and re-reads fixed authority records before any effect', async () => {
  const f = preparedFixture({v7Current:true,peerEnabled:true,decisionEnabled:true,authorizationEnabled:true});
  assert.equal(f.result.plan.planDisposition,'READY_FOR_SHARED_OWNER_CONTROLLED_CAS');
  const before = [...TARGETS,...v7Manifest.targetPostimages.map(row=>row.targetRef)]
    .map(ref=>[ref,read(ref)]);
  await assert.rejects(applyQualityExtensionSourceAdoptionV2({expectedPlanSha256:qualityExtensionAdoptionPlanFingerprint(f.result.plan)}));
  for (const [ref,bytes] of before) assert.ok(read(ref).equals(bytes),`${ref} must remain unchanged when fixed authority records are missing`);
});

test('dispatch rejects changed or deleted fixed authority after review preflight with no source writes', async () => {
  const fixture=isolatedReadyAdapterFixture();let deletionFixture;
  try{
    const adapter=await import(`${pathToFileURL(path.join(fixture.mediaRoot,'scripts/lib/media-pdp0-quality-extension-source-adoption-v2.mjs')).href}?case=${Date.now()}`);
    const planned=adapter.planQualityExtensionSourceAdoptionV2();
    assert.equal(planned.plan.planDisposition,'READY_FOR_SHARED_OWNER_CONTROLLED_CAS');
    const before=fixture.targets.map(ref=>[ref,fs.readFileSync(path.join(fixture.mediaRoot,ref))]);
    const peer=JSON.parse(fs.readFileSync(path.join(fixture.mediaRoot,fixture.peerRef),'utf8'));
    peer.reviewer.identity='agent:thread:changed-after-review';
    fs.writeFileSync(path.join(fixture.mediaRoot,fixture.peerRef),json(peer));
    await assert.rejects(adapter.applyQualityExtensionSourceAdoptionV2({expectedPlanSha256:adapter.qualityExtensionAdoptionPlanFingerprint(planned.plan)}),/changed|peer|review/u);
    for(const [ref,bytes] of before)assert.deepEqual(fs.readFileSync(path.join(fixture.mediaRoot,ref)),bytes);
  }finally{fs.rmSync(fixture.parent,{recursive:true,force:true});}
  deletionFixture=isolatedReadyAdapterFixture();
  try{
    const adapter=await import(`${pathToFileURL(path.join(deletionFixture.mediaRoot,'scripts/lib/media-pdp0-quality-extension-source-adoption-v2.mjs')).href}?delete=${Date.now()}`);
    const planned=adapter.planQualityExtensionSourceAdoptionV2();
    const before=deletionFixture.targets.map(ref=>[ref,fs.readFileSync(path.join(deletionFixture.mediaRoot,ref))]);
    fs.unlinkSync(path.join(deletionFixture.mediaRoot,deletionFixture.authRef));
    await assert.rejects(adapter.applyQualityExtensionSourceAdoptionV2({expectedPlanSha256:adapter.qualityExtensionAdoptionPlanFingerprint(planned.plan)}));
    for(const [ref,bytes] of before)assert.deepEqual(fs.readFileSync(path.join(deletionFixture.mediaRoot,ref)),bytes);
  }finally{fs.rmSync(deletionFixture.parent,{recursive:true,force:true});}
});

test('post-write readback requires both exact outputs and retains PXD-226 while adding PXD-227', () => {
  const f = preparedFixture({v7Current:true});
  const artifacts = new Map([[candidateRef,f.candidateBytes],[schemaRef,f.schemaBytes],[freezeRef,json(f.freeze)],
    [f.prepared.candidate.targets[0].postimageRef,f.prepared.decisionLogPostimageBytes],
    [f.prepared.candidate.targets[1].postimageRef,f.prepared.qualityPostimageBytes],
    [TARGETS[0],f.prepared.decisionLogPostimageBytes],[TARGETS[1],f.prepared.qualityPostimageBytes]]);
  const v7Postimages = new Map(v7Manifest.postimageArtifactRefs.map((row,index)=>[v7Manifest.targetPostimages[index].targetRef,read(row.ref)]));
  const source = ref => artifacts.get(ref) ?? v7Postimages.get(ref) ?? read(ref);
  const result = verifyQualityExtensionSourceAdoptionV2({readSource:source});
  assert.equal(result.state,'EXACT_TWO_TARGET_POSTIMAGE_READBACK');
  assert.equal(result.population.historicalRows,462);
  assert.equal(result.population.currentRowsCount,463);
  assert.equal(result.population.futureRows,6);
  assert.equal(result.independentAcceptance,'NOT_CLAIMED');
});

