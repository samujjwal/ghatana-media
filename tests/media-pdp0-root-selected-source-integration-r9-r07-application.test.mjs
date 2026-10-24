import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {prepareR9R07ApplicationPlan} from '../scripts/plan-media-pdp0-root-selected-source-integration-r9-r07-application.mjs';
import {buildR9R07CurrentnessDiagnosticCorrection} from '../scripts/prepare-media-pdp0-root-selected-source-integration-r9-r07-currentness-diagnostic-correction.mjs';
import {MEDIA_PDP0_ROOT_SELECTED_R9_R07_PROFILE as P} from '../scripts/lib/media-pdp0-root-selected-source-integration-r9-r07-operation-profile.mjs';
import {prepareMediaPdp0RootSelectedSourceIntegrationR9R07CasPlan,commitValidatedPdp0RootSelectedSourceIntegrationR9R07} from '../scripts/lib/media-pdp0-review-successor-cas.mjs';

const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

test('R9-R07 owner package binds exact source guards and does not globalize Discovery currentness',()=>{
  const {plan,schemas}=prepareR9R07ApplicationPlan({persist:false});
  const root=process.cwd();
  assert.equal(plan.disposition,'READY_FOR_OWNER_DECISIONS_AND_APPLY_AUTHORIZATION');
  assert.equal(plan.directCheckFailures.length,0);
  assert.equal(plan.sourceReadSet.count,7);
  assert.equal(plan.sourceReadSet.allMatch,true);
  assert.equal(plan.selectedTargets.count,4);
  assert.equal(plan.selectedTargets.readOnlyGuardCount,3);
  assert.equal(plan.phaseDiagnostic.discoveryBarrier,'FAIL');
  assert.equal(plan.phaseDiagnostic.blocksScopedPDP0SourceAuthoring,false);
  assert.equal(plan.applicationPrerequisites.aggregatePdp0DiscoveryCurrentness,'NOT_A_SCOPED_SOURCE_APPLICATION_PREREQUISITE');
  assert.equal(plan.guardedWriterContract.status,'FIXED_PATH_R9_R07_WRITER_FAILS_CLOSED_UNTIL_AUTHORITY_RECORDS_PASS');
  assert.deepEqual(plan.selectedTargets.rows.map(row=>row.targetRef),[...P.targets]);
  assert.equal(schemas.owner.properties.operationProfile.properties.ownerAdjudicationMutations.const,0);
  assert.equal(schemas.owner.properties.operationProfile.properties.trustReconstructionMutations.const,0);
  assert.equal(schemas.apply.properties.targetRows.maxItems,4);
  assert.deepEqual(schemas.root.properties.decisionStatus.enum,['ADOPT_EXACT_R9_R07_SPLIT_SOURCE_SUCCESSOR','DECLINE_EXACT_R9_R07_SPLIT_SOURCE_SUCCESSOR','REQUEST_R9_R07_CANDIDATE_REVISION']);
  assert.equal(plan.authorityInputs.length,4);
  assert.equal(plan.canonicalApply,'NONE');
  const correction=JSON.parse(fs.readFileSync(path.join(root,P.diagnosticCorrectionRef),'utf8'));
  assert.deepEqual(buildR9R07CurrentnessDiagnosticCorrection(),correction);
  assert.deepEqual(correction.typedSourceKindCounts,{wholeFilePins:{total:167,current:158,stale:9,missingFiles:0},sectionOrProjectionSelectors:{total:21,current:20,stale:1,unresolvedSelectors:0},aggregate:{references:188,current:178,stale:10,missingFiles:0,unresolvedSelectors:0}});
  assert.deepEqual(correction.staleSectionOrProjectionRefs.map(row=>row.ref),['.product-experience/decision-log.md#PXD-225-section']);
  assert.equal(plan.phaseDiagnostic.staleLiveSourcePins,undefined);
  assert.equal(plan.phaseDiagnostic.typedSourceKindCounts.sectionOrProjectionSelectors.stale,1);
  const templates=JSON.parse(fs.readFileSync(path.join(root,P.recordTemplatesRef),'utf8'));
  assert.equal(Object.keys(templates.templates).length,4);
  assert.equal(templates.templates.rootAdoptionDecision.status,'TEMPLATE_NOT_A_RECORD');
  const packet=JSON.parse(fs.readFileSync(path.join(root,P.guardedPacketRef),'utf8'));
  assert.equal(packet.operationContinuity.selectedOperations,122);
  assert.equal(packet.operationContinuity.retainedProjectionOperations,248);
  assert.equal(packet.guardedApply.executed,false);
  assert.equal(packet.canonicalApply,'NONE');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,P.planRef),'utf8')),plan);
  for(const [kind,ref] of Object.entries({owner:P.sourceOwnerDecisionSchemaRef,root:P.rootAdoptionDecisionSchemaRef,registration:P.registrationSchemaRef,apply:P.applyAuthorizationSchemaRef})){
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,ref),'utf8')),schemas[kind]);
  }
});

test('R9-R07 guarded CAS writer fails closed until exact authority records exist',()=>{
  const root=process.cwd();
  const before=[...P.targets,'docs/implementation/pdp-0-phase-dev-status.json'].map(ref=>sha(fs.readFileSync(path.join(root,ref))));
  const prepared=prepareMediaPdp0RootSelectedSourceIntegrationR9R07CasPlan();
  assert.equal(prepared.blocked,true);
  assert.equal(prepared.targets.length,0);
  assert.match(prepared.plan.casBlocker,/authority records are absent/u);
  assert.throws(()=>commitValidatedPdp0RootSelectedSourceIntegrationR9R07({plan:prepared.plan,targets:prepared.targets}),/authority records are absent/u);
  const after=[...P.targets,'docs/implementation/pdp-0-phase-dev-status.json'].map(ref=>sha(fs.readFileSync(path.join(root,ref))));
  assert.deepEqual(after,before);
});
