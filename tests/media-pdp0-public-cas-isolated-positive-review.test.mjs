import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {authorizedV7CasFixture} from './helpers/media-pdp0-source-amendment-v7-fixture.mjs';

const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const obs='docs/implementation/observations/pdp0-semantic-audit-slices';
const refs={
  qualityCandidate:`${obs}/AUD-SPEC-002-quality-extension-source-candidate.v2.json`,
  qualitySchema:`${obs}/AUD-SPEC-002-quality-extension-source-candidate.v2.schema.json`,
  qualityFreeze:`${obs}/AUD-SPEC-002-quality-extension-source-candidate-v2-freeze-manifest.v1.json`,
  qualityPeer:`${obs}/AUD-SPEC-002-quality-extension-independent-peer.v2.json`,
  qualityPeerSchema:`${obs}/AUD-SPEC-002-quality-extension-independent-peer.v2.schema.json`,
  qualityOwnerDecision:`${obs}/AUD-SPEC-002-quality-extension-source-owner-decision.v2.json`,
  qualityOwnerSchema:`${obs}/AUD-SPEC-002-quality-extension-source-owner-decision.v2.schema.json`,
  qualityAuthorization:`${obs}/AUD-SPEC-002-quality-extension-apply-authorization.v2.json`,
  qualityAuthorizationSchema:`${obs}/AUD-SPEC-002-quality-extension-apply-authorization.v2.schema.json`,
  qualityPlanSchema:`${obs}/AUD-SPEC-002-quality-extension-source-adoption-cas-plan.v2.schema.json`,
  priorQuality:`${obs}/AUD-SPEC-002-quality-applicability-extension-candidate.v1.json`,
  decisionSection:`${obs}/AUD-SPEC-002-quality-extension-pxd227-section-candidate.v1.md`,
  qualityPostimage:`${obs}/AUD-SPEC-002-quality-policy-extension-postimage.v2.yaml`,
  decisionPostimage:`${obs}/AUD-SPEC-002-quality-extension-decision-log-postimage.v2.md`,
  qualityChoice:'../ghatana-lifecycle/docs/engineering/reviews/gtool-critical-2026-10-23/media-aud-spec-002-quality-applicability-root-choice-r01.json',
  v7RootChoice:'ghatana-lifecycle:docs/engineering/reviews/gtool-critical-2026-10-23/media-aud-spec-002-version-population-root-decision.json',
  applications:'.product-experience/pdp-0-product-truth/applications-channels.yaml',
  audit:'docs/implementation/references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json',
  qualityPolicy:'.product-experience/pdp-0-product-truth/quality-policy.yaml',
  decisionLog:'.product-experience/decision-log.md',
};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=value=>Buffer.from(`${JSON.stringify(value,null,2)}\n`);

function sourcePath(root,ref){
  const sibling=ref.startsWith('ghatana-lifecycle:')||ref.startsWith('../ghatana-lifecycle/');
  const base=sibling?path.resolve(root,'..','ghatana-lifecycle'):root;
  const suffix=ref.startsWith('ghatana-lifecycle:')?ref.slice('ghatana-lifecycle:'.length)
    :ref.startsWith('../ghatana-lifecycle/')?ref.slice('../ghatana-lifecycle/'.length):ref;
  return path.join(base,suffix);
}
function copyRef(root,ref){
  const source=sourcePath(sourceRoot,ref),target=sourcePath(root,ref);
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);
}
function copyLibrary(root){
  const lib=path.join(root,'scripts/lib');fs.mkdirSync(lib,{recursive:true});
  for(const name of fs.readdirSync(path.join(sourceRoot,'scripts/lib')).filter(name=>name.endsWith('.mjs'))){
    fs.copyFileSync(path.join(sourceRoot,'scripts/lib',name),path.join(lib,name));
  }
  const tools=path.resolve(root,'../ghatana-tools');
  if(!fs.existsSync(tools))fs.symlinkSync(path.resolve(sourceRoot,'../ghatana-tools'),tools,'dir');
}

function copyQualityCut(root){
  const candidate=JSON.parse(fs.readFileSync(path.join(sourceRoot,refs.qualityCandidate),'utf8'));
  const manifest=JSON.parse(fs.readFileSync(path.join(sourceRoot,`${obs}/AUD-SPEC-002-source-amendment-v7-freeze-manifest.v1.json`),'utf8'));
  const v7Candidate=JSON.parse(fs.readFileSync(path.join(sourceRoot,`${obs}/AUD-SPEC-002-source-amendment-candidate.v7.json`),'utf8'));
  const v7Peers=[`${obs}/AUD-SPEC-002-v7-quality-extension-independent-peer.v2.json`,`${obs}/AUD-SPEC-002-source-amendment-independent-peer.v7.json`]
    .map(ref=>JSON.parse(fs.readFileSync(path.join(sourceRoot,ref),'utf8')));
  const refsToCopy=new Set([
    ...Object.entries(refs).filter(([key])=>!['qualityOwnerDecision','qualityAuthorization'].includes(key)).map(([,ref])=>ref),
    `${obs}/AUD-SPEC-002-source-amendment-v7-freeze-manifest.v1.json`,
    `${obs}/AUD-SPEC-002-source-amendment-candidate.v7.json`,
    `${obs}/AUD-SPEC-002-source-amendment-candidate.v7.schema.json`,
    `${obs}/AUD-SPEC-002-source-amendment-postimage.v7.json`,
    `${obs}/AUD-SPEC-002-source-amendment-postimage.v7.schema.json`,
    `${obs}/AUD-SPEC-002-source-amendment-independent-peer.v7.json`,
    '.product-experience/pdp-0-product-truth/capabilities.yaml',
    '.product-experience/pdp-0-product-truth/requirements.yaml',
    '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml',
    '.product-experience/pdp-0-product-truth/campaign-extensions.yaml',
    ...Object.keys(manifest.producerPins??{}),manifest.reconciliationRef,v7Candidate.rootDecisionRef,
    ...manifest.postimageArtifactRefs.map(row=>row.ref),
  ]);
  for(const row of manifest.targetPostimages)refsToCopy.add(row.targetRef);
  for(const row of candidate.targets){refsToCopy.add(row.targetRef);refsToCopy.add(row.preimageRef);refsToCopy.add(row.postimageRef);}
  for(const peer of v7Peers){
    if(peer.sourceOrigin?.priorReviewRecordRef)refsToCopy.add(peer.sourceOrigin.priorReviewRecordRef);
    if(peer.sourceOrigin?.correctedSuccessorRef)refsToCopy.add(peer.sourceOrigin.correctedSuccessorRef);
    for(const ref of Object.values(peer.reviewBinding?.exactCutRefs??{}))if(typeof ref==='string')refsToCopy.add(ref);
  }
  for(const ref of refsToCopy)copyRef(root,ref);
}

function writeSyntheticQualityAuthority(root,plan){
  const candidateBytes=fs.readFileSync(sourcePath(root,refs.qualityCandidate));
  const peerBytes=fs.readFileSync(sourcePath(root,refs.qualityPeer));
  const decision={schemaVersion:'media.pdp0.quality-extension-source-owner-decision.v2',
    decisionKind:'ADOPT_EXACT_QUALITY_EXTENSION_TWO_TARGET_SOURCE_CANDIDATE',candidateRef:refs.qualityCandidate,
    candidateSha256:sha(candidateBytes),candidatePostimageSha256:plan.candidatePostimageSha256,
    peerReviewRef:refs.qualityPeer,peerReviewSha256:sha(peerBytes),v7ManifestSha256:plan.v7Predecessor.manifestSha256,
    decisionRef:plan.decisionRef,decisionSectionSha256:plan.decisionSectionSha256,
    targetRows:plan.targets.map(row=>({targetRef:row.targetRef,expectedPreimageSha256:row.expectedPreimageSha256,expectedPostimageSha256:row.expectedPostimageSha256})),
    sourceOwner:{identity:'agent:/root',role:'PDP0_SOURCE_OWNER'},disposition:'APPROVE_EXACT_CANDIDATE_FOR_SOURCE_APPLY',
    authorityBoundary:{sourceDefinitionOnly:true,independentAcceptance:'NOT_CLAIMED',phaseStatusEffect:'NONE',nativeProof:'NOT_CLAIMED',runtimeAdmission:'NOT_ADMITTED',measurement:'NOT_EVALUATED',qualification:'NOT_EVALUATED'}};
  const decisionBytes=json(decision);fs.writeFileSync(sourcePath(root,refs.qualityOwnerDecision),decisionBytes);
  const authorization={schemaVersion:'media.pdp0.quality-extension-apply-authorization.v2',
    effect:'APPLY_EXACT_QUALITY_EXTENSION_TWO_TARGET_SOURCE_CANDIDATE',candidateRef:refs.qualityCandidate,
    candidateSha256:sha(candidateBytes),candidatePostimageSha256:plan.candidatePostimageSha256,
    sourceOwnerDecisionRef:refs.qualityOwnerDecision,sourceOwnerDecisionSha256:sha(decisionBytes),
    peerReviewRef:refs.qualityPeer,peerReviewSha256:sha(peerBytes),decisionRef:plan.decisionRef,decisionSectionSha256:plan.decisionSectionSha256,
    targetRows:decision.targetRows,sourceOwner:{identity:'agent:/root',role:'PDP0_SOURCE_OWNER'},
    distinctTechnicalPeer:{identity:plan.peerIdentity,role:'DISTINCT_TECHNICAL_PEER',reviewedCandidateSha256:sha(candidateBytes),reviewedPostimageSha256:plan.candidatePostimageSha256},
    authorityBoundary:{sourceOwnerAdoption:'EXACT_SOURCE_CHANGE_AUTHORIZED',independentAcceptance:'NOT_CLAIMED',phaseStatusEffect:'NONE',nativeProof:'NOT_CLAIMED',runtimeAdmission:'NOT_ADMITTED',measurement:'NOT_EVALUATED',qualification:'NOT_EVALUATED'}};
  fs.writeFileSync(sourcePath(root,refs.qualityAuthorization),json(authorization));
}

test('fixed-root public six-target CAS applies and replays only in an isolated synthetic-authority repository',async()=>{
  const fixture=authorizedV7CasFixture();
  try{
    copyLibrary(fixture.root);
    const cas=await import(`${pathToFileURL(path.join(fixture.root,'scripts/lib/media-pdp0-review-successor-cas.mjs')).href}?six=${Date.now()}`);
    const result=cas.commitValidatedPdp0SourceAmendmentSixFile({plan:fixture.plan,targets:fixture.targets});
    assert.equal(result.state,'COMMITTED_EXACT_READBACK');
    assert.equal(result.canonicalWrite,'PERFORMED');
    for(const row of fixture.targets)assert.equal(sha(fs.readFileSync(path.join(fixture.root,row.targetRef))),row.expectedPostimageSha256);
    const replay=cas.commitValidatedPdp0SourceAmendmentSixFile({plan:fixture.plan,targets:fixture.targets});
    assert.equal(replay.state,'POSTIMAGE_SET_OBSERVED_AFTER_PRIOR_ATTEMPT');
    assert.equal(replay.canonicalWrite,'NOT_PERFORMED_BY_THIS_CALL');
  }finally{fs.rmSync(fixture.temp,{recursive:true,force:true});}
});

test('fixed-root public quality two-target CAS applies and replays only in an isolated synthetic-authority repository',async()=>{
  const fixture=authorizedV7CasFixture();
  try{
    copyQualityCut(fixture.root);copyLibrary(fixture.root);
    const cas=await import(`${pathToFileURL(path.join(fixture.root,'scripts/lib/media-pdp0-review-successor-cas.mjs')).href}?quality=${Date.now()}`);
    const adapter=await import(`${pathToFileURL(path.join(fixture.root,'scripts/lib/media-pdp0-quality-extension-source-adoption-v2.mjs')).href}?quality=${Date.now()}`);
    const v7=cas.commitValidatedPdp0SourceAmendmentSixFile({plan:fixture.plan,targets:fixture.targets});
    assert.equal(v7.state,'COMMITTED_EXACT_READBACK');
    let planned=adapter.planQualityExtensionSourceAdoptionV2();
    assert.deepEqual(planned.plan.blockers,['ROOT_SOURCE_OWNER_DECISION_REQUIRED','EXACT_TWO_TARGET_APPLY_AUTHORIZATION_REQUIRED']);
    writeSyntheticQualityAuthority(fixture.root,planned.plan);
    planned=adapter.planQualityExtensionSourceAdoptionV2();
    assert.deepEqual(planned.plan.blockers,[]);
    const targets=planned.frozen.candidate.targets.map(row=>({targetRef:row.targetRef,
      expectedPreimageSha256:row.preimageSha256,expectedPostimageSha256:row.postimageSha256,
      preimageBytes:fs.readFileSync(path.join(fixture.root,row.targetRef)),postimageBytes:planned.frozen.targetBytes.get(row.targetRef)}));
    const result=cas.commitValidatedPdp0SourceAmendmentQualityTwoTarget({plan:planned.plan,targets});
    assert.equal(result.state,'COMMITTED_EXACT_READBACK');
    for(const row of targets)assert.equal(sha(fs.readFileSync(path.join(fixture.root,row.targetRef))),row.expectedPostimageSha256);
    const replay=cas.commitValidatedPdp0SourceAmendmentQualityTwoTarget({plan:planned.plan,targets});
    assert.equal(replay.state,'POSTIMAGE_SET_OBSERVED_AFTER_PRIOR_ATTEMPT');
    assert.equal(replay.canonicalWrite,'NOT_PERFORMED_BY_THIS_CALL');
  }finally{fs.rmSync(fixture.temp,{recursive:true,force:true});}
});
