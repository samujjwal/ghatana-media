import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {prepareMediaPdp0RootSelectedSourceIntegrationR8OwnerPlan} from '../scripts/lib/media-pdp0-root-selected-source-integration-r8-owner-plan.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const folder='docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const read=ref=>fs.readFileSync(path.join(root,ref));
const json=ref=>JSON.parse(read(ref));
const require=createRequire(path.resolve(root,'../ghatana-tools/package.json'));
const planRef=`${folder}/media-pdp0-root-selected-source-integration-r8.source-owner-transition-plan.r3.candidate.v1.json`;
const schemaRef=`${folder}/media-pdp0-root-selected-source-integration-r8.source-owner-decision.schema.r3.candidate.v1.json`;
const {plan,sourceOwnerDecisionSchema:schema}=prepareMediaPdp0RootSelectedSourceIntegrationR8OwnerPlan();

test('source-owner transition plan binds exact seven preimages, four postimages, and three read-only guards',()=>{
  assert.equal(plan.current7Preimages.length,7);
  assert.ok(plan.current7Preimages.every(row=>row.matches));
  assert.equal(plan.writeTargets.length,4);
  assert.equal(plan.readOnlyGuards.length,3);
  assert.equal(plan.operationProfile.operationCount,113);
  assert.deepEqual(plan.operationProfile.allowedOperations,['ADD_CAPABILITY_DEFINITION','APPEND_REQUIREMENT_CASE','APPEND_REQUIREMENT_CAPABILITY_BINDING','PATCH_CROSSWALK_TRACE']);
  assert.equal(plan.operationProfile.counts.ownerAdjudicationMutations,0);
  assert.equal(plan.operationProfile.counts.trustReconstructionMutations,0);
  assert.equal(plan.authorityRegistry.pdp0SemanticOwnerRole,'media-product');
  assert.equal(plan.authorityRegistry.pdp0PhaseOwner,'ghatana-media-product-owners');
  assert.equal(plan.authorityRegistry.individualIdentity,'NOT_RESOLVED_BY_AUTHORITY_MAP');
  assert.equal(plan.subagentTechnicalCheck.reviewerIdentity,'/root/source_peer');
  assert.equal(plan.subagentTechnicalCheck.disposition,'PASS_TECHNICAL_SUBAGENT_ONLY');
  assert.equal(plan.actualHReview.status,'NOT_VERIFIED');
  assert.equal(plan.actualHReview.reviewerIdentity,'NOT_ESTABLISHED');
  assert.equal(json(planRef).writeTargets.length,4);
  assert.equal(json(schemaRef).$id,schema.$id);
});

test('source-owner plan remains blocked until registration and exact decisions; no write route is implied',()=>{
  assert.equal(plan.planDisposition,'BLOCKED_AWAITING_SOURCE_OWNER_PROFILE_REGISTRATION_DECISIONS_AND_ACTUAL_H_REVIEW');
  for(const blocker of ['ACTUAL_H_INDEPENDENT_REVIEW_PENDING','R8_OPERATION_PROFILE_REGISTRATION_REQUIRES_ACTUAL_SOURCE_OWNER_AUTHORITY','EXACT_R8_SOURCE_OWNER_DECISION_NOT_RECORDED','EXACT_R8_ROOT_ADOPTION_DECISION_NOT_RECORDED','DISTINCT_EXACT_INPUT_APPLY_AUTHORIZATION_NOT_RECORDED','CANONICAL_APPLY_ROUTE_NOT_ENABLED_FOR_R8']) assert.ok(plan.blockers.includes(blocker));
  assert.equal(plan.decisionInputs.sourceOwnerDecision.status,'NOT_SET');
  assert.equal(plan.decisionInputs.rootAdoptionDecision.status,'NOT_SET');
  assert.equal(plan.decisionInputs.applyAuthorization.status,'NOT_SET');
  assert.equal(plan.existingWriter.transactionCore,'commitSourceAmendmentTargets');
  assert.equal(plan.existingWriter.r8EntryPoint,'NOT_IMPLEMENTED');
  assert.equal(plan.canonicalApply,'NONE');
});

test('candidate source-owner schema binds exact inputs but does not fabricate an owner identity',()=>{
  const Ajv2020=require('ajv/dist/2020');
  const validate=new Ajv2020({strict:true}).compile(schema);
  const record={
    schemaVersion:'media.pdp0.root-selected-source-integration-r8.source-owner-decision.r3.v1',
    decisionKind:'SOURCE_OWNER_ADOPT_EXACT_PDP0_SOURCE_SUCCESSOR',
    candidateRef:plan.candidateBundle.ref,candidateSha256:plan.candidateBundle.sha256,
    freezeManifestRef:plan.freezeManifest.ref,freezeManifestSha256:plan.freezeManifest.sha256,
    rootMappingDecisionRef:plan.rootMappingDecision.ref,rootMappingDecisionSha256:plan.rootMappingDecision.sha256,
    subagentTechnicalCheckRef:plan.subagentTechnicalCheck.ref,subagentTechnicalCheckSha256:plan.subagentTechnicalCheck.sha256,
    actualHReview:{reviewRef:'docs/implementation/observations/example-h-review.json',reviewSha256:'a'.repeat(64),reviewerIdentity:'actual-h-reviewer',reviewStatus:'PASS'},
    operationProfile:{profileId:plan.operationProfile.profileId,operationLedgerRef:plan.operationProfile.ledgerRef,operationLedgerSha256:plan.operationProfile.ledgerSha256,operationSchemaRef:plan.operationProfile.operationSchemaRef,operationSchemaSha256:plan.operationProfile.operationSchemaSha256,operationKinds:plan.operationProfile.allowedOperations,ownerAdjudicationMutations:0,trustReconstructionMutations:0},
    sourceBaseline:Object.fromEntries(plan.current7Preimages.map(row=>[row.targetRef,{const:row.sha256}])),
    targetPostimages:Object.fromEntries(plan.writeTargets.map(row=>[row.targetRef,row.postimageSha256])),
    decisionRef:'.product-experience/decision-log.md#PXD-999',decisionSectionSha256:'a'.repeat(64),
    sourceOwner:{identity:'synthetic-test-identity-only',role:'PDP0_SOURCE_OWNER'},
    disposition:'DECLINE_EXACT_CANDIDATE',
    authorityBoundary:{sourceOwnerAdoption:'NOT_ADOPTED',canonicalApply:'NOT_AUTHORIZED_BY_SOURCE_OWNER_DECISION',phaseStatusEffect:'NONE',independentAcceptance:'NOT_CLAIMED',nativeClosure:'NOT_CLAIMED'},
  };
  record.sourceBaseline=Object.fromEntries(plan.current7Preimages.map(row=>[row.targetRef,row.sha256]));
  assert.equal(validate(record),true);
  assert.equal(schema.properties.sourceOwner.properties.identity.const,undefined);
  const stale=structuredClone(record);stale.targetPostimages[plan.writeTargets[0].targetRef]='f'.repeat(64);
  assert.equal(validate(stale),false);
  const blankIdentity=structuredClone(record);blankIdentity.sourceOwner.identity='';
  assert.equal(validate(blankIdentity),false);
});
