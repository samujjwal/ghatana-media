import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {prepareMediaPdp0SourceAmendmentV7CasPlan,v7SourceAmendmentRefs} from '../../scripts/lib/media-pdp0-source-amendment-v7-plan.mjs';

const REPO=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const OBS='docs/implementation/observations/pdp0-semantic-audit-slices';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=ref=>fs.readFileSync(path.join(REPO,ref));

function copyRef(root,ref){
  const lifecycle=ref.startsWith('ghatana-lifecycle:');
  const sourceRef=lifecycle?ref.slice('ghatana-lifecycle:'.length):ref;
  const sourceRoot=lifecycle?path.resolve(REPO,'..','ghatana-lifecycle'):REPO;
  const targetRoot=lifecycle?path.resolve(root,'..','ghatana-lifecycle'):root;
  const source=path.join(sourceRoot,sourceRef),target=path.join(targetRoot,sourceRef);
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,fs.readFileSync(source));
}

export function isolatedV7Repository(){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'media-v7-fixture-'));
  const root=path.join(temp,'ghatana-media');fs.mkdirSync(root);
  const manifest=JSON.parse(read(v7SourceAmendmentRefs.manifest));
  const candidate=JSON.parse(read(v7SourceAmendmentRefs.candidate));
  const peer=JSON.parse(read(v7SourceAmendmentRefs.peer));
  const refs=new Set([
    v7SourceAmendmentRefs.candidate,v7SourceAmendmentRefs.manifest,v7SourceAmendmentRefs.peer,
    `${OBS}/AUD-SPEC-002-source-amendment-candidate.v7.schema.json`,
    `${OBS}/AUD-SPEC-002-source-amendment-postimage.v7.json`,`${OBS}/AUD-SPEC-002-source-amendment-postimage.v7.schema.json`,
    `${OBS}/AUD-SPEC-002-source-amendment-v6-freeze-manifest.v1.json`,`${OBS}/AUD-SPEC-002-source-amendment-candidate.v6.json`,
    `${OBS}/AUD-SPEC-002-source-amendment-candidate.v6.schema.json`,`${OBS}/AUD-SPEC-002-source-amendment-postimage.v6.json`,
    `${OBS}/AUD-SPEC-002-source-amendment-postimage.v6.schema.json`,
    '.product-experience/pdp-0-product-truth/applications-channels.yaml',
    'docs/implementation/references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json',
    ...Object.keys(manifest.producerPins),manifest.reconciliationRef,candidate.rootDecisionRef,
    ...manifest.postimageArtifactRefs.map(row=>row.ref),
    peer.sourceOrigin.priorReviewRecordRef,peer.sourceOrigin.correctedSuccessorRef,
  ]);
  for(const row of manifest.targetPostimages)refs.add(row.targetRef);
  for(const ref of refs)copyRef(root,ref);
  const journalRef=`${OBS}/source-amendment-journals/${manifest.candidateSha256}.json`;
  const journalPath=path.join(REPO,journalRef);
  if(fs.existsSync(journalPath)){
    const journal=JSON.parse(fs.readFileSync(journalPath,'utf8'));
    if(journal.state==='COMMITTED_EXACT_READBACK'){
      const journalRows=new Map((journal.targets??[]).map(row=>[row.targetRef,row]));
      for(const row of manifest.targetPostimages){
        const journalRow=journalRows.get(row.targetRef);
        if(!journalRow||journalRow.state!=='COMMITTED_EXACT_READBACK'
            ||journalRow.expectedPreimageSha256!==row.preimageSha256
            ||journalRow.postimageSha256!==row.postimageSha256){
          throw new Error(`applied V7 journal does not bind the frozen target: ${row.targetRef}`);
        }
        const snapshotPath=path.join(REPO,journalRow.immutablePreimageRef);
        const snapshot=fs.readFileSync(snapshotPath);
        if(sha(snapshot)!==row.preimageSha256)throw new Error(`applied V7 journal preimage snapshot is stale: ${row.targetRef}`);
        const target=path.join(root,row.targetRef);
        fs.writeFileSync(target,snapshot);
      }
    }
  }
  return {temp,root};
}

export function writeSyntheticV7AuthorityRecords(root,reviewed){
  const refs=v7SourceAmendmentRefs;
  const manifestBytes=fs.readFileSync(path.join(root,refs.manifest));
  const peerBytes=fs.readFileSync(path.join(root,refs.peer));
  const targetPostimages=Object.fromEntries(reviewed.targets.map(row=>[row.targetRef,row.expectedPostimageSha256]));
  const ownerDecision={schemaVersion:'media.pdp0.source-amendment-owner-decision.v7',decisionKind:'EXACT_PDP0_SOURCE_AMENDMENT',
    candidateRef:refs.candidate,candidateSha256:reviewed.plan.candidateSha256,candidatePostimageSha256:reviewed.plan.candidatePostimageSha256,
    freezeManifestRef:refs.manifest,freezeManifestSha256:sha(manifestBytes),sourceBindings:reviewed.candidate.sourceBindings,targetPostimages,
    decisionRef:reviewed.plan.decisionRef,decisionSectionSha256:reviewed.plan.decisionSectionSha256,
    sourceOwner:{identity:reviewed.plan.sourceOwnerIdentity,role:reviewed.plan.sourceOwnerRole},technicalPeerReviewRef:refs.peer,
    technicalPeerReviewSha256:sha(peerBytes),disposition:'APPROVE_EXACT_CANDIDATE_FOR_SOURCE_APPLY',
    authorityBoundary:{ownerApproval:'NOT_CLAIMED',independentAcceptance:'NOT_CLAIMED',phaseStatusEffect:'NONE',runtimeAdmission:'NOT_ADMITTED',nativeClosure:'NOT_CLAIMED'}};
  const decisionBytes=Buffer.from(`${JSON.stringify(ownerDecision,null,2)}\n`);
  const decisionPath=path.join(root,refs.ownerDecision);fs.mkdirSync(path.dirname(decisionPath),{recursive:true});fs.writeFileSync(decisionPath,decisionBytes);
  const ownerSha=sha(decisionBytes),peerSha=sha(peerBytes);
  const grant={grantId:'TEST_ONLY_SYNTHETIC_GRANT',status:'CURRENT',issuerIdentity:reviewed.plan.sourceOwnerIdentity,
    candidateSha256:reviewed.plan.candidateSha256,candidatePostimageSha256:reviewed.plan.candidatePostimageSha256,
    sourceOwnerDecisionSha256:ownerSha,technicalPeerReviewSha256:peerSha,decisionRef:reviewed.plan.decisionRef,
    decisionSectionSha256:reviewed.plan.decisionSectionSha256,targetPostimages};
  const authorization={schemaVersion:'media.pdp0.source-amendment-apply-authorization.v7',effect:'APPLY_EXACT_AUD_SPEC_002_SOURCE_AMENDMENT_V7',
    authorizationId:`MEDIA-AUD-SPEC-002-V7-APPLY-${reviewed.plan.candidateSha256.slice(0,12)}`,
    candidateRef:refs.candidate,candidateSha256:reviewed.plan.candidateSha256,candidatePostimageSha256:reviewed.plan.candidatePostimageSha256,
    sourceOwnerDecisionRef:refs.ownerDecision,sourceOwnerDecisionSha256:ownerSha,technicalPeerReviewRef:refs.peer,technicalPeerReviewSha256:peerSha,
    decisionRef:reviewed.plan.decisionRef,decisionSectionSha256:reviewed.plan.decisionSectionSha256,targetPostimages,currentRootGrant:grant,
    authorityBoundary:{ownerApproval:'NOT_CLAIMED',independentAcceptance:'NOT_CLAIMED',phaseStatusEffect:'NONE',runtimeAdmission:'NOT_ADMITTED',nativeClosure:'NOT_CLAIMED'}};
  const authorizationPath=path.join(root,refs.applyAuthorization);fs.mkdirSync(path.dirname(authorizationPath),{recursive:true});
  fs.writeFileSync(authorizationPath,`${JSON.stringify(authorization,null,2)}\n`);
}

export function authorizedV7CasFixture(){
  const fixture=isolatedV7Repository();
  try{
    const blocked=prepareMediaPdp0SourceAmendmentV7CasPlan({root:fixture.root});
    writeSyntheticV7AuthorityRecords(fixture.root,blocked);
    const ready=prepareMediaPdp0SourceAmendmentV7CasPlan({root:fixture.root});
    if(ready.plan.planDisposition!=='READY_EXACT_V7_CUT_WITH_CURRENT_ROOT_GRANT_NO_WRITE_PERFORMED')throw new Error('synthetic v7 test authority did not create a ready plan');
    return {...fixture,plan:ready.plan,targets:ready.targets};
  }catch(error){fs.rmSync(fixture.temp,{recursive:true,force:true});throw error;}
}
