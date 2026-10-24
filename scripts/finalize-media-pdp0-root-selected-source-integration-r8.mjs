#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const folder='docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const read=ref=>fs.readFileSync(path.resolve(root,ref));
const json=ref=>JSON.parse(read(ref));
const write=(ref,value)=>fs.writeFileSync(path.resolve(root,ref),`${JSON.stringify(value,null,2)}\n`);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const refs={
  predecessorFreeze:`${folder}/media-pdp0-root-selected-source-integration-r7.freeze.v1.json`,
  bundle:`${folder}/media-pdp0-root-selected-source-integration-r8.successor-bundle.candidate.v1.json`,
  verification:`${folder}/media-pdp0-root-selected-source-integration-r8.rebuild-verification.candidate.v1.json`,
  proposal:`${folder}/media-pdp0-root-selected-source-integration-r8.source-adoption-cas-proposal.candidate.v1.json`,
  peer:`${folder}/media-pdp0-root-selected-source-integration-r8.independent-peer.source-peer-r2.json`,
  schema:`${folder}/media-pdp0-root-selected-source-integration-r8.allowed-operations.schema.candidate.v1.json`,
  ledger:`${folder}/media-pdp0-root-selected-source-integration-r8.split.allowed-operations.candidate.v1.json`,
  baseline:`${folder}/media-pdp0-quality2target-current-source-baseline-2026-10-23.json`,
  rootDecision:`${folder}/media-pdp0-direct010-edit022-actual-root-mapping-decision-r01.json`,
};
const peer=json(refs.peer),verification=json(refs.verification),proposal=json(refs.proposal),ledger=json(refs.ledger),baseline=json(refs.baseline);
if(peer.reviewStatus!=='PASS'||peer.findings?.length!==0||peer.authorityAndExecutionBoundary?.canonicalApply!=='NONE')throw new Error('H peer review is not a clean technical PASS');
if(!peer.preimageChecks?.allMatch||!peer.splitPostimageChecks?.allMatchBundleLedgerAndLiveBytes||!peer.operationAndOwnershipChecks?.passed)throw new Error('H peer verification predicates are incomplete');
if(verification.independentFinalPeerReview!=='PENDING'||verification.canonicalApply!=='NONE'||proposal.executionGate.canonicalApply!=='NONE')throw new Error('candidate preparation authority boundary changed');
const freezeRef=`${folder}/media-pdp0-root-selected-source-integration-r8.freeze.v1.json`;
const proposalR2Ref=`${folder}/media-pdp0-root-selected-source-integration-r8.source-adoption-cas-proposal.r2.candidate.v1.json`;
const freeze={schemaVersion:'media.pdp0.root-selected-source-integration-freeze.v1',artifactId:'MEDIA-PDP0-ROOT-SELECTED-SOURCE-INTEGRATION-R8-FREEZE-2026-10-23',freezeStatus:'FROZEN_FOR_SOURCE_OWNER_AND_ROOT_REVIEW_ONLY',predecessor:{ref:refs.predecessorFreeze,sha256:sha(read(refs.predecessorFreeze))},candidateBundle:{ref:refs.bundle,sha256:sha(read(refs.bundle))},rebuildVerification:{ref:refs.verification,sha256:sha(read(refs.verification))},reviewedProposal:{ref:refs.proposal,sha256:sha(read(refs.proposal))},independentPeer:{ref:refs.peer,sha256:sha(read(refs.peer)),reviewStatus:peer.reviewStatus,technicalOnly:true},actualRootMappingDecision:{ref:refs.rootDecision,sha256:sha(read(refs.rootDecision)),selectedOptionId:'B_SPLIT_BY_OPERATION_SCOPE'},current7Preimages:baseline.currentTargets.map(row=>({targetRef:row.targetRef,sha256:row.sha256})),selectedBranch:'split',selectedAllowedOperations:{ref:refs.ledger,sha256:sha(read(refs.ledger))},candidateSchema:{ref:refs.schema,sha256:sha(read(refs.schema)),status:'NOT_REGISTERED'},selectedPostimages:ledger.outputPostimages.map(row=>({targetRef:row.targetRef,postimageRef:row.postimageRef,sha256:row.postimageSha256})),unselectedAlternative:{branch:'shared',status:'PRESERVED_AS_SEPARATE_UNSELECTED_HISTORY',ledgerRef:`${folder}/media-pdp0-root-selected-source-integration-r8.shared.allowed-operations.candidate.v1.json`,ledgerSha256:sha(read(`${folder}/media-pdp0-root-selected-source-integration-r8.shared.allowed-operations.candidate.v1.json`))},sourceOwnerDecision:'NOT_SET',rootAdoptionDecision:'NOT_SET',applyAuthorization:'NOT_SET',canonicalApply:'NONE',phaseStatusChanged:false,ownerAdjudicationMutations:0,trustReconstructionMutations:0,historicalOwnerRowsPreserved:462};
write(freezeRef,freeze);
const proposalR2=structuredClone(proposal);
proposalR2.proposalId='MEDIA-PDP0-ROOT-SELECTED-SOURCE-INTEGRATION-R8-SPLIT-ADOPTION-PROPOSAL-R2-2026-10-23';
proposalR2.predecessorProposal={ref:refs.proposal,sha256:sha(read(refs.proposal))};
proposalR2.freezeManifest={ref:freezeRef,sha256:sha(read(freezeRef)),status:freeze.freezeStatus};
proposalR2.decisionChain.independentFinalPeerReview={ref:refs.peer,sha256:sha(read(refs.peer)),status:'PASS_TECHNICAL_ONLY'};
proposalR2.executionGate.blockedUntil=proposalR2.executionGate.blockedUntil.filter(item=>!item.includes('fresh H independent peer review'));
proposalR2.executionGate.blockedUntil.push('root adoption decision is completed by root authority and source-owner decision remains separately recorded');
proposalR2.executionGate.proposalExecutableNow=false;
proposalR2.executionGate.canonicalApply='NONE';
proposalR2.nextAction='Route the frozen exact-input candidate to the authorized source owner and root authority. This proposal does not execute writes; canonical apply would require separate current exact-input authorization after schema registration.';
write(proposalR2Ref,proposalR2);
console.log(JSON.stringify({freezeRef,freezeSha256:sha(read(freezeRef)),proposalR2Ref,proposalR2Sha256:sha(read(proposalR2Ref)),peerRef:refs.peer,peerSha256:sha(read(refs.peer)),canonicalApply:'NONE'},null,2));
