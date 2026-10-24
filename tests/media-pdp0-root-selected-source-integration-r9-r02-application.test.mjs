import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {fingerprintPxdDecisionSection} from '../scripts/lib/pdp0-phase-scoped-source-fingerprints.mjs';
import {MEDIA_PDP0_ROOT_SELECTED_R9_R02_PROFILE as P} from '../scripts/lib/media-pdp0-root-selected-source-integration-r9-r02-operation-profile.mjs';
import {prepareMediaPdp0RootSelectedSourceIntegrationR9R02CasPlan,commitValidatedPdp0RootSelectedSourceIntegrationR9R02} from '../scripts/lib/media-pdp0-review-successor-cas.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const folder='docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const jsonBytes=value=>Buffer.from(`${JSON.stringify(value,null,2)}\n`);
const read=ref=>fs.readFileSync(path.join(repo,ref));
const rootRequire=createRequire(path.resolve(repo,'../ghatana-tools/package.json'));
const baselineRef=P.baselineRef;
const requiredArtifacts=['docs/implementation/pdp-0-phase-dev-status.json',P.freezeRef,P.candidateRef,P.verificationRef,P.ledgerRef,P.operationSchemaRef,P.repairMapRef,P.retainedProjectionRef,P.baselineRef,P.rootMappingRef,P.actualHReviewRef,P.fullCutHReviewRef,
  `${folder}/media-pdp0-root-selected-source-integration-r8.freeze.v1.json`,`${folder}/media-pdp0-root-selected-source-integration-r8.split.allowed-operations.candidate.v1.json`];

function put(root,ref,bytes){const target=path.join(root,ref);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);}
function installLib(root){const dest=path.join(root,'scripts/lib');fs.mkdirSync(dest,{recursive:true});for(const name of fs.readdirSync(path.join(repo,'scripts/lib')).filter(x=>x.endsWith('.mjs')))fs.copyFileSync(path.join(repo,'scripts/lib',name),path.join(dest,name));fs.symlinkSync(path.join(repo,'node_modules'),path.join(root,'node_modules'),'dir');fs.symlinkSync(path.resolve(repo,'../ghatana-tools'),path.resolve(root,'..','ghatana-tools'),'dir');return dest;}

async function fixture({authorities=true}={}){
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'media-r9-r02-cas-'));const root=path.join(tmp,'repo');fs.mkdirSync(root,{recursive:true});
  for(const ref of requiredArtifacts)put(root,ref,read(ref));
  for(const ref of P.targets)put(root,ref,read(ref));
  for(const row of JSON.parse(read(baselineRef).toString('utf8')).currentTargets)put(root,row.targetRef,read(row.targetRef));
  for(const row of JSON.parse(read(P.freezeRef).toString('utf8')).selectedPostimages)put(root,row.postimageRef,read(row.postimageRef));
  put(root,'.product-experience/authority-map.yaml',read('.product-experience/authority-map.yaml'));
  put(root,'.product-experience/decision-log.md',read('.product-experience/decision-log.md'));
  const actualH=JSON.parse(read(P.actualHReviewRef).toString('utf8'));
  actualH.testOnlyAuthorityFixture=true;
  put(root,P.actualHReviewRef,jsonBytes(actualH));
  const fullCutH=JSON.parse(read(P.fullCutHReviewRef).toString('utf8'));
  fullCutH.testOnlyAuthorityFixture=true;
  fullCutH.reviewStatus='PASS_SCOPED_SOURCE_SEMANTIC_REVIEW';fullCutH.findings=[];
  put(root,P.fullCutHReviewRef,jsonBytes(fullCutH));
  const lib=installLib(root);
  const planner=await import(`${pathToFileURL(path.join(lib,'media-pdp0-root-selected-source-integration-r9-r02-application-plan.mjs')).href}?fixture=${Date.now()}`);
  const prepared=planner.prepareMediaPdp0RootSelectedSourceIntegrationR9R02ApplicationPlan();
  const plan=prepared.plan;
  if(authorities)writeAuthorityFixtures(root,plan,actualH);
  const cas=await import(`${pathToFileURL(path.join(lib,'media-pdp0-review-successor-cas.mjs')).href}?fixture=${Date.now()}`);
  return {tmp,root,lib,cas,actualH,plan};
}

function writeAuthorityFixtures(root,plan,actualH){
  const bundleSha=plan.candidateBundle.sha256,freezeSha=plan.freezeManifest.sha256,hRef=P.actualHReviewRef,hSha=sha(fs.readFileSync(path.join(root,hRef)));
  const fullCutHRef=P.fullCutHReviewRef,fullCutHReviewSha=sha(fs.readFileSync(path.join(root,fullCutHRef)));
  const ledgerSha=plan.operationLedger.sha256,operationSchemaSha=plan.operationSchema.sha256;
  const baseline=Object.fromEntries(plan.current7Preimages.map(row=>[row.targetRef,row.expectedSha256]));
  const postimages=Object.fromEntries(plan.writeTargets.map(row=>[row.targetRef,row.postimageSha256]));
  const decisionRef='.product-experience/decision-log.md#PXD-225';
  const log=fs.readFileSync(path.join(root,'.product-experience/decision-log.md'),'utf8');
  const sectionSha=fingerprintPxdDecisionSection(log,'PXD-225').sha256;
  const owner={schemaVersion:'media.pdp0.root-selected-source-integration-r9-r02.source-owner-decision.v2',decisionKind:'SOURCE_OWNER_ADOPT_EXACT_PDP0_SOURCE_SUCCESSOR',candidateRef:P.candidateRef,candidateSha256:bundleSha,freezeManifestRef:P.freezeRef,freezeManifestSha256:freezeSha,actualHReviewRef:hRef,actualHReviewSha256:hSha,fullCutHReviewRef:fullCutHRef,fullCutHReviewSha256:fullCutHReviewSha,
    operationProfile:{profileId:P.profileId,operationLedgerRef:P.ledgerRef,operationLedgerSha256:ledgerSha,operationSchemaRef:P.operationSchemaRef,operationSchemaSha256:operationSchemaSha,operationKinds:[...P.operationKinds],counts:{...P.counts},ownerAdjudicationMutations:0,trustReconstructionMutations:0},
    sourceBaseline:baseline,targetPostimages:postimages,decisionRef,decisionSectionSha256:sectionSha,sourceOwner:{identity:'TEST_ONLY::source-owner',role:'PDP0_SOURCE_OWNER'},disposition:'APPROVE_EXACT_CANDIDATE_FOR_SOURCE_ADOPTION',
    authorityBoundary:{sourceOwnerAdoption:'ADOPTED_EXACT_CANDIDATE',canonicalApply:'NOT_AUTHORIZED_BY_SOURCE_OWNER_DECISION',phaseStatusEffect:'NONE',independentAcceptance:'NOT_CLAIMED',nativeClosure:'NOT_CLAIMED'}};
  const ownerBytes=jsonBytes(owner);put(root,P.sourceOwnerDecisionRef,ownerBytes);const ownerSha=sha(ownerBytes);
  const rootDecision={schemaVersion:'media.pdp0.root-selected-source-integration-r9-r02.root-adoption-decision.v3',decisionStatus:'ADOPT_EXACT_R9_R02_SPLIT_SOURCE_SUCCESSOR',candidateRef:P.candidateRef,candidateSha256:bundleSha,freezeManifestRef:P.freezeRef,freezeManifestSha256:freezeSha,sourceOwnerDecisionRef:P.sourceOwnerDecisionRef,sourceOwnerDecisionSha256:ownerSha,actualHReviewRef:hRef,actualHReviewSha256:hSha,fullCutHReviewRef:fullCutHRef,fullCutHReviewSha256:fullCutHReviewSha,selectedBranch:'split',rootAuthority:{identity:'TEST_ONLY::root-authority',role:'ROOT_AUTHORITY'},decisionRef,decisionSectionSha256:sectionSha,authorityBoundary:{canonicalApply:'NOT_AUTHORIZED_BY_ROOT_ADOPTION_DECISION',phaseStatusEffect:'NONE',independentAcceptance:'NOT_CLAIMED',nativeClosure:'NOT_CLAIMED'}};
  const rootBytes=jsonBytes(rootDecision);put(root,P.rootAdoptionDecisionRef,rootBytes);const rootSha=sha(rootBytes);
  const registrationSchemaBytes=fs.readFileSync(path.join(root,P.registrationSchemaRef));
  const registration={schemaVersion:P.schemaVersion,registrationStatus:'REGISTERED_FOR_EXACT_R9_R02_SOURCE_SUCCESSOR_ONLY',profileId:P.profileId,registrationSchemaRef:P.registrationSchemaRef,registrationSchemaSha256:sha(registrationSchemaBytes),operationSchemaRef:P.operationSchemaRef,operationSchemaSha256:operationSchemaSha,operationLedgerRef:P.ledgerRef,operationLedgerSha256:ledgerSha,sourceOwnerDecisionRef:P.sourceOwnerDecisionRef,sourceOwnerDecisionSha256:ownerSha,rootAdoptionDecisionRef:P.rootAdoptionDecisionRef,rootAdoptionDecisionSha256:rootSha,actualHReviewRef:hRef,actualHReviewSha256:hSha,fullCutHReviewRef:fullCutHRef,fullCutHReviewSha256:fullCutHReviewSha,sourceOwnerIdentity:owner.sourceOwner.identity,rootAuthorityIdentity:rootDecision.rootAuthority.identity,decisionRef,decisionSectionSha256:sectionSha,authorityBoundary:{canonicalApply:'NOT_AUTHORIZED_BY_PROFILE_REGISTRATION'}};
  const registrationBytes=jsonBytes(registration);put(root,P.registrationRef,registrationBytes);const registrationSha=sha(registrationBytes);
  const targetRows=plan.writeTargets.map(row=>({targetRef:row.targetRef,preimageSha256:row.preimageSha256,postimageSha256:row.postimageSha256}));
  const authorization={schemaVersion:'media.pdp0.root-selected-source-integration-r9-r02.apply-authorization.v2',effect:'APPLY_EXACT_R9_R02_SPLIT_SOURCE_SUCCESSOR',candidateRef:P.candidateRef,candidateSha256:bundleSha,freezeManifestRef:P.freezeRef,freezeManifestSha256:freezeSha,profileRegistrationRef:P.registrationRef,profileRegistrationSha256:registrationSha,sourceOwnerDecisionRef:P.sourceOwnerDecisionRef,sourceOwnerDecisionSha256:ownerSha,rootAdoptionDecisionRef:P.rootAdoptionDecisionRef,rootAdoptionDecisionSha256:rootSha,actualHReviewRef:hRef,actualHReviewSha256:hSha,fullCutHReviewRef:fullCutHRef,fullCutHReviewSha256:fullCutHReviewSha,targetRows,sourceBaseline:baseline,decisionRef,decisionSectionSha256:sectionSha,applyAuthority:{identity:'TEST_ONLY::apply-authority',role:'CANONICAL_APPLY_AUTHORITY'},authorityBoundary:{canonicalApply:'EXACT_R9_R02_CANONICAL_SOURCE_APPLY_AUTHORIZED'}};
  put(root,P.applyAuthorizationRef,jsonBytes(authorization));
  const Ajv2020=rootRequire('ajv/dist/2020');
  for(const [schemaRef,record] of [[P.sourceOwnerDecisionSchemaRef,owner],[P.rootAdoptionDecisionSchemaRef,rootDecision],[P.registrationSchemaRef,registration],[P.applyAuthorizationSchemaRef,authorization]]){
    const validate=new Ajv2020({strict:true}).compile(JSON.parse(fs.readFileSync(path.join(root,schemaRef))));assert.equal(validate(record),true,`${schemaRef}: ${JSON.stringify(validate.errors)}`);
  }
  // All authorities above are disposable test-only fixtures in this temporary repository.
  assert.equal(actualH.testOnlyAuthorityFixture,true);
}

test('R9-R02 root package pins exact inputs and keeps aggregate Discovery currentness separate from source-application admission',()=>{
  const plan=JSON.parse(fs.readFileSync(path.join(repo,P.planRef),'utf8'));
  assert.equal(plan.planDisposition,'BLOCKED_AWAITING_EXACT_REVIEW_OWNER_ROOT_REGISTRATION_AND_APPLY_INPUTS');
  assert.equal(plan.writeTargets.length,4);assert.equal(plan.readOnlyGuards.length,3);assert.equal(plan.current7Preimages.length,7);
  assert.equal(plan.actualHReview.reviewStatus,'PASS_SCOPED_SOURCE_SEMANTIC_REVIEW');
  assert.equal(plan.actualHReview.reviewedFreezeSha256,plan.freezeManifest.sha256);
  assert.equal(plan.operationLedger.operationCount,122);assert.equal(plan.operationLedger.counts.retainedProjectionOperations,248);
  assert.equal(plan.operationLedger.counts.predecessorR8Operations,113);assert.equal(plan.operationLedger.counts.r9RepairOperations,9);
  assert.equal(plan.pdp0Status.status,'IN_PROGRESS');
  assert.equal(plan.discoveryDiagnostic.barrier,'FAIL');
  assert.equal(plan.discoveryDiagnostic.staleLiveSourcePins,8);
  assert.equal(plan.fullCutHReview.reviewStatus,'REQUEST_CHANGES');
  assert.ok(plan.blockers.includes('FULL_CUT_ACTUAL_H_REVIEW_REQUESTS_CHANGES'));
  assert.ok(!plan.blockers.some(code=>code.startsWith('PDP0_')));
  assert.ok(plan.blockers.includes('EXACT_SOURCE_OWNER_DECISION_NOT_RECORDED'));
  assert.ok(plan.blockers.includes('EXACT_ROOT_ADOPTION_DECISION_NOT_RECORDED'));
  assert.ok(plan.blockers.includes('EXACT_OPERATION_PROFILE_REGISTRATION_NOT_RECORDED'));
  assert.ok(plan.blockers.includes('DISTINCT_EXACT_INPUT_APPLY_AUTHORIZATION_NOT_RECORDED'));
});

test('R9-R02 profile passes isolated exact four-target CAS and records immutable snapshots and journal',async()=>{
  const f=await fixture();
  try{
    const ready=f.cas.prepareMediaPdp0RootSelectedSourceIntegrationR9R02CasPlan();
    assert.equal(ready.blocked,false,JSON.stringify(ready.plan.blockers));
    assert.equal(ready.plan.targets.length,4);assert.equal(ready.plan.current7Preimages.length,7);
    const result=f.cas.commitValidatedPdp0RootSelectedSourceIntegrationR9R02({plan:ready.plan,targets:ready.targets});
    assert.equal(result.state,'COMMITTED_EXACT_READBACK');assert.equal(result.canonicalWrite,'PERFORMED');assert.equal(result.targets.length,4);
    for(const row of ready.targets)assert.deepEqual(fs.readFileSync(path.join(f.root,row.targetRef)),row.postimageBytes);
    const journal=JSON.parse(fs.readFileSync(path.join(f.root,result.journalPath),'utf8'));
    assert.equal(journal.schemaVersion,'media.pdp0.root-selected-source-integration-r9-r02-apply-journal.v1');
    assert.equal(journal.state,'COMMITTED_EXACT_READBACK');assert.deepEqual(journal.targets.map(row=>row.targetRef),[...P.targets]);
    assert.ok(journal.targets.every(row=>fs.existsSync(path.join(f.root,row.immutablePreimageRef))));
    const replay=f.cas.commitValidatedPdp0RootSelectedSourceIntegrationR9R02({plan:ready.plan,targets:ready.targets});
    assert.equal(replay.state,'POSTIMAGE_SET_OBSERVED_AFTER_PRIOR_ATTEMPT');
    assert.equal(replay.canonicalWrite,'NOT_PERFORMED_BY_THIS_CALL');
  }finally{fs.rmSync(f.tmp,{recursive:true,force:true});}
});

test('R9-R02 profile blocks missing actual authority and stale read-only guards without creating a journal',async()=>{
  const missing=await fixture({authorities:false});
  try{
    const blocked=missing.cas.prepareMediaPdp0RootSelectedSourceIntegrationR9R02CasPlan();
    assert.equal(blocked.blocked,true);assert.equal(blocked.plan.canonicalApply,'NONE');assert.equal(blocked.targets.length,0);
    assert.ok(blocked.plan.blockers.some(row=>row.includes(P.sourceOwnerDecisionRef)));
    assert.equal(blocked.plan.pdp0Status.status,'IN_PROGRESS');
    assert.equal(blocked.plan.discoveryDiagnostic.barrier,'FAIL');
    assert.equal(fs.existsSync(path.join(missing.root,'docs/implementation/observations/pdp0-semantic-audit-slices/source-amendment-journals')),false);
  }finally{fs.rmSync(missing.tmp,{recursive:true,force:true});}
  const f=await fixture();
  try{
    const ready=f.cas.prepareMediaPdp0RootSelectedSourceIntegrationR9R02CasPlan();assert.equal(ready.blocked,false);
    const fullCutPath=path.join(f.root,P.fullCutHReviewRef);const passingFullCut=fs.readFileSync(fullCutPath);
    const rejectedFullCut=JSON.parse(passingFullCut.toString('utf8'));rejectedFullCut.reviewStatus='REQUEST_CHANGES';rejectedFullCut.findings=[{id:'TEST_ONLY_FULL_CUT_FINDING'}];
    fs.writeFileSync(fullCutPath,jsonBytes(rejectedFullCut));
    const fullCutBlocked=f.cas.prepareMediaPdp0RootSelectedSourceIntegrationR9R02CasPlan();assert.equal(fullCutBlocked.blocked,true);
    assert.ok(fullCutBlocked.plan.blockers.some(row=>row.includes('full-cut actual H review')));
    assert.equal(fs.existsSync(path.join(f.root,'docs/implementation/observations/pdp0-semantic-audit-slices/source-amendment-journals')),false);
    fs.writeFileSync(fullCutPath,passingFullCut);
    const guard=ready.plan.current7Preimages.find(row=>!P.targets.includes(row.targetRef));
    fs.appendFileSync(path.join(f.root,guard.targetRef),'\nTEST_ONLY stale guard\n');
    assert.throws(()=>f.cas.commitValidatedPdp0RootSelectedSourceIntegrationR9R02({plan:ready.plan,targets:ready.targets}),/seven pinned PDP-0 sources changed/u);
    assert.equal(fs.existsSync(path.join(f.root,'docs/implementation/observations/pdp0-semantic-audit-slices/source-amendment-journals')),false);
    for(const row of ready.targets)assert.deepEqual(fs.readFileSync(path.join(f.root,row.targetRef)),row.preimageBytes);
  }finally{fs.rmSync(f.tmp,{recursive:true,force:true});}
});
