import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { buildReadiness, buildPdp0DevStatus, writePdp0DevStatus, validateTaskPopulation, taskIds, verificationCutChanged, resolveCriterionReviewSourceCut, selectApprovedMediaDecisions, assessCurrentTaskDependencies, pdp0PhaseScopedSourcePins, createSourceOwnerPhaseResolver, sourceOwnerPhase } from '../scripts/report-media-pdp-readiness.mjs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import { buildMediaProductDefinitionResidualReport } from '../scripts/lib/media-product-definition-residuals.mjs';
const parseYaml=createRequire(path.resolve(process.cwd(),'../ghatana-tools/package.json'))('yaml').parse;
const audit=JSON.parse(fs.readFileSync('docs/implementation/media-task-completion-blocker-report-2026-10-08.json','utf8'));
const residual=buildMediaProductDefinitionResidualReport();
const p0Only=process.env.PDP_DEV_PHASE==='PDP-0';
const broadTest=p0Only?test.skip:test;
const build=verification=>buildReadiness({audit,residual,verification,mainSha:'fixture',fingerprints:{}});
test('approved PDP-0 media decisions include only current direct and scoped corrective approvals',()=>{
 const reviews={
  'P0-01':{status:'APPROVED_DIRECT_DEFINITION_CRITERION',sourceCutCurrent:true,decisionRef:'direct-1',currentCorrectiveReview:{status:'APPROVED_CURRENT_CORRECTION',phaseScope:'PDP-0',decisionRef:'corrective-1'}},
  'P0-02':{status:'APPROVED_DIRECT_DEFINITION_CRITERION',sourceCutCurrent:false,decisionRef:'stale',currentCorrectiveReview:{status:'APPROVED_CURRENT_CORRECTION',phaseScope:'PDP-0',decisionRef:'stale-corrective'}},
  'P0-03':{status:'PENDING',sourceCutCurrent:true,decisionRef:'pending',currentCorrectiveReview:{status:'APPROVED_CURRENT_CORRECTION',phaseScope:'PDP-0',decisionRef:'orphaned-corrective'}},
  'P0-04':{status:'APPROVED_DIRECT_DEFINITION_CRITERION',sourceCutCurrent:true,decisionRef:'direct-4',currentCorrectiveReview:{status:'APPROVED_CURRENT_CORRECTION',phaseScope:'PDP-1',decisionRef:'wrong-phase'}},
  'P0-05':{status:'APPROVED_DIRECT_DEFINITION_CRITERION',sourceCutCurrent:true,decisionRef:'direct-5',currentCorrectiveReview:{status:'PENDING',phaseScope:'PDP-0',decisionRef:'pending-corrective'}},
 };
 const claimIds=['MPSEM-0078-C003','MPSEM-0181-C001','MPSEM-0278-C001','MPSEM-0367-C002','MPSEM-0475-C003'];
 const base={authorizationStatus:'APPROVED_BOUNDED_OWNER_SOURCE_SEMANTIC_ROUTE',status:'APPROVED_BOUNDED_OWNER_SOURCE_SEMANTIC_ROUTE',decisionRef:'migration-139',acceptanceEffect:'none',runtimeStatus:'NOT_EVALUATED',cliAdmission:'NOT_ADMITTED',records:claimIds.map(claimId=>({claimId,ownerPhase:'PDP-0',coordinatorDisposition:'APPROVED_BOUNDED_OWNER_SOURCE_SEMANTIC_ROUTE',coordinatorDecisionRef:'migration-139',ownerProposalObservation:{status:'PENDING_COORDINATOR_MATERIAL_REVIEW'},acceptanceEffect:'none',runtimeStatus:'NOT_EVALUATED'}))};
 assert.deepEqual(selectApprovedMediaDecisions(reviews,base),['corrective-1','direct-1','direct-4','direct-5','migration-139']);
 assert.deepEqual(selectApprovedMediaDecisions(reviews,{...base,records:base.records.slice(0,4)}),['corrective-1','direct-1','direct-4','direct-5']);
 assert.deepEqual(selectApprovedMediaDecisions(reviews,{...base,records:base.records.map((r,i)=>i===4?{...r,ownerPhase:'PDP-1'}:r)}),['corrective-1','direct-1','direct-4','direct-5']);
 assert.deepEqual(selectApprovedMediaDecisions(reviews,{...base,records:base.records.map((r,i)=>i===4?{...r,claimId:'MPSEM-9999-C001'}:r)}),['corrective-1','direct-1','direct-4','direct-5']);
 assert.deepEqual(selectApprovedMediaDecisions(reviews,{...base,records:base.records.map((r,i)=>i===4?{...r,ownerProposalObservation:{status:'APPROVED'}}:r)}),['corrective-1','direct-1','direct-4','direct-5']);
 assert.deepEqual(selectApprovedMediaDecisions(reviews,{...base,authorizationStatus:'PENDING_COORDINATOR_MATERIAL_REVIEW'}),['corrective-1','direct-1','direct-4','direct-5']);
});
test('current PDP-0 corrective source fingerprints exclude generated verification logs',()=>{
 const artifact=JSON.parse(fs.readFileSync('docs/implementation/verification/pdp-38/direct-definition-criteria-review.json','utf8'));
 for(const record of artifact.records){
  for(const file of Object.keys((record.currentCorrectiveReview??record.currentSourceReview)?.sourceFingerprints??{})){
   assert.equal(/\/P0-\d+\.log$/u.test(file),false,`${record.taskId} does not fingerprint a generated test log`);
  }
 }
});
test('PXD-225 refreshes only P0-01 currentness while preserving PXD-216 semantic review',()=>{
 const artifact=JSON.parse(fs.readFileSync('docs/implementation/verification/pdp-38/direct-definition-criteria-review.json','utf8'));
 const record=artifact.records.find(({taskId})=>taskId==='P0-01');
 const pxd216=JSON.parse(fs.readFileSync('docs/implementation/verification/pdp-38/p0-capability-meaning-20-leaf-current-source-review-pxd216.json','utf8'));
 const pxd223=JSON.parse(fs.readFileSync('docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd223.json','utf8'));
 const scopedPins=pdp0PhaseScopedSourcePins();
 const sourcePin=file=>scopedPins[file]??createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 assert.equal(record.currentCorrectiveReview.decisionRef,'.product-experience/decision-log.md#PXD-216');
 assert.equal(record.currentSourceReview.decisionRef,'.product-experience/decision-log.md#PXD-225');
 assert.equal(record.currentSourceReview.reviewKind,'COORDINATOR_AUTHORED_CURRENT_SOURCE_RECONCILIATION');
 assert.equal(record.currentSourceReview.ownerApproval,'NOT_CLAIMED');
 assert.equal(record.currentSourceReview.acceptanceEffect,'none');
 assert.match(record.currentSourceReview.acceptanceBoundary,/PXD-216 remains the semantic review/u);
 assert.equal(pxd223.preservedSemanticReview.changedReviewedCapabilityIds.length,0);
 assert.equal(pxd223.preservedSemanticReview.reviewedCapabilityCount,20);
 assert.equal(pxd223.preservedSemanticReview.semanticReviewStatus,'PXD-216_SEMANTIC_REVIEW_PRESERVED; NO_NEW_SEMANTIC_REVIEW');
 assert.equal(pxd216.reviewedCapabilityIds.length,20);
 assert.equal(pxd223.decisionSectionSha256,sourcePin('.product-experience/decision-log.md#PXD-223-section'));
 for(const [file,digest] of Object.entries(record.currentSourceReview.sourceFingerprints))
  assert.equal(digest,sourcePin(file),`P0-01 PXD-223 currentness pin ${file}`);
 assert.equal(resolveCriterionReviewSourceCut(record,sourcePin,sourceOwnerPhase).sourceCutCurrent,true);
 const historicalOnly={...record,currentCorrectiveReview:undefined,currentSourceReview:undefined,currentSourcePinRefresh:undefined};
 assert.equal(resolveCriterionReviewSourceCut(historicalOnly,sourcePin,sourceOwnerPhase).sourceCutCurrent,false);
});
test('PXD-225 refreshes P0-01 currentness while preserving PXD-216 semantic review and PXD-196 history',()=>{
 const artifact=JSON.parse(fs.readFileSync('docs/implementation/verification/pdp-38/direct-definition-criteria-review.json','utf8'));
 const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 const scopedPins=pdp0PhaseScopedSourcePins();
 const sourcePin=file=>scopedPins[file]??sha(file);
  const byId=new Map(artifact.records.map(record=>[record.taskId,record]));
 const pxd216=JSON.parse(fs.readFileSync('docs/implementation/verification/pdp-38/p0-capability-meaning-20-leaf-current-source-review-pxd216.json','utf8'));
 const pxd223=JSON.parse(fs.readFileSync('docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd223.json','utf8'));
 const pxd225=JSON.parse(fs.readFileSync('docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd225.json','utf8'));
  for(const id of ['P0-01','P0-02','P0-05','P0-06','P0-07']){
  const record=byId.get(id);
  const current=record.currentSourceReview ?? record.currentCorrectiveReview;
  const currentDecisionRef=id==='P0-01'
   ?'.product-experience/decision-log.md#PXD-216'
   :id==='P0-05'?'.product-experience/decision-log.md#PXD-208'
   :'.product-experience/decision-log.md#PXD-196';
  const reviewEvidence=id==='P0-01'?pxd216:current;
  assert.equal(reviewEvidence.decisionRef,currentDecisionRef);
  assert.equal(reviewEvidence.phaseScope,'PDP-0');
  assert.equal(reviewEvidence.ownerApproval,'NOT_CLAIMED');
  if(id==='P0-01') {
   assert.equal(reviewEvidence.decisionRef,'.product-experience/decision-log.md#PXD-216');
   assert.deepEqual(pxd223.preservedSemanticReview.changedReviewedCapabilityIds,[]);
   assert.equal(pxd223.preservedSemanticReview.reviewedCapabilityCount,20);
   assert.equal(pxd223.preservedSemanticReview.semanticReviewStatus,'PXD-216_SEMANTIC_REVIEW_PRESERVED; NO_NEW_SEMANTIC_REVIEW');
   assert.equal(current.decisionRef,'.product-experience/decision-log.md#PXD-225');
   assert.equal(current.reviewKind,'COORDINATOR_AUTHORED_CURRENT_SOURCE_RECONCILIATION');
   assert.equal(current.ownerApproval,'NOT_CLAIMED');
   assert.equal(current.acceptanceEffect,'none');
   assert.match(current.acceptanceBoundary,/PXD-216 remains the semantic review/u);
   assert.equal(current.sourceFingerprints['docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd225.json'],sha('docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd225.json'));
   assert.equal(current.sourceFingerprints['.product-experience/decision-log.md#PXD-216-section'],sourcePin('.product-experience/decision-log.md#PXD-216-section'));
   assert.equal(current.sourceFingerprints['.product-experience/decision-log.md#PXD-225-section'],sourcePin('.product-experience/decision-log.md#PXD-225-section'));
   assert.equal(pxd225.decisionSectionSha256,sourcePin('.product-experience/decision-log.md#PXD-225-section'));
   assert.ok(record.historicalCorrectiveReviews.some(review=>review.decisionRef==='.product-experience/decision-log.md#PXD-209'),
    'PXD-209 remains preserved as its historical correction record');
   for(const [file,digest] of Object.entries(current.sourceFingerprints))assert.equal(digest,sourcePin(file),`P0-01 PXD-225 currentness pin ${file}`);
   assert.equal(resolveCriterionReviewSourceCut(record,sourcePin,sourceOwnerPhase).sourceCutCurrent,true,
    'the PXD-225 currentness layer establishes P0-01 source currentness while PXD-216 remains semantic authority');
   const historicalOnly={...record,currentCorrectiveReview:undefined,currentSourceReview:undefined,currentSourcePinRefresh:undefined};
   assert.equal(resolveCriterionReviewSourceCut(historicalOnly,sourcePin,sourceOwnerPhase).sourceCutCurrent,false,
    'historical PXD-209 and PXD-216 pins do not establish current P0-01 source currentness');
  } else {
  assert.equal(current.status,'APPROVED_CURRENT_SOURCE_REVIEW');
  assert.match(current.acceptanceBoundary,/Coordinator-authored PDP-0 source review only/u);
  assert.match(current.acceptanceBoundary,/independent acceptance/iu);
  assert.match(current.acceptanceBoundary,/(?:NOT_CLAIMED|not claimed|not asserted)/iu,
   `${id} boundary keeps owner/acceptance effect explicitly unclaimed`);
  for(const term of ['runtime admission','qualification','closure','Delivery readiness'])
   assert.match(current.acceptanceBoundary,new RegExp(term,'iu'),`${id} boundary retains the ${term} limit`);
  if(current.acceptanceEffect!==undefined)assert.equal(current.acceptanceEffect,'none');
  assert.equal(current.verification.status,'PASS');
  assert.equal(resolveCriterionReviewSourceCut(record,sourcePin,sourceOwnerPhase).sourceCutCurrent,true,`${id} has current exact or phase-scoped source pins`);
  const currentPins=record.currentProjectionRefresh?.sourceFingerprints
   ??record.currentSourcePinRefresh?.currentSourceFingerprints
   ??current.sourceFingerprints;
  for(const [file,digest] of Object.entries(currentPins))assert.equal(digest,sourcePin(file),`${id} current source pin ${file}`);
  if(['P0-05','P0-07'].includes(id)) {
   assert.equal(record.currentSourcePinRefresh.currentnessAuthority.decisionRef,'.product-experience/decision-log.md#PXD-225');
   assert.equal(record.currentSourcePinRefresh.currentnessAuthority.artifactSha256,sourcePin(record.currentSourcePinRefresh.currentnessAuthority.artifactRef));
   assert.equal(record.currentSourcePinRefresh.currentnessAuthority.decisionSectionSha256,sourcePin('.product-experience/decision-log.md#PXD-225-section'));
   assert.equal(resolveCriterionReviewSourceCut(record,sourcePin,sourceOwnerPhase).currentnessAuthorityCurrent,true);
  }
  if(id==='P0-06') {
   assert.equal(record.currentProjectionRefresh.projectionArtifactRef,'docs/implementation/verification/pdp-38/p0-quality-current-source-review-pxd225.json');
   assert.equal(record.currentProjectionRefresh.projectionArtifactSha256,sourcePin(record.currentProjectionRefresh.projectionArtifactRef));
  }
  }
  if(['P0-01','P0-02'].includes(id))assert.ok(record.historicalCorrectiveReviews.some(review=>review.decisionRef==='.product-experience/decision-log.md#PXD-171'),`${id} retains PXD-171 as history`);
  if(id==='P0-06')assert.ok(record.historicalCorrectiveReviews.some(review=>review.decisionRef==='.product-experience/decision-log.md#PXD-170'),`${id} retains PXD-170 as history`);
  if(['P0-05','P0-07'].includes(id))for(const prior of ['PXD-194','PXD-193','PXD-192','PXD-191'])assert.ok(record.historicalCorrectiveReviews.some(review=>review.decisionRef===`.product-experience/decision-log.md#${prior}`),`${id} retains ${prior} as history`);
 }
 const crosswalk=JSON.parse(fs.readFileSync('docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json','utf8'));
 assert.ok(crosswalk.coordinatorReview.reviewHistory.some(review=>review.decisionRef==='PXD-190'),'PXD-190 remains in its authentic audit-crosswalk history');
 const productTruth=byId.get('P0-01').currentCorrectiveReview;
 assert.equal(productTruth.decisionRef,'.product-experience/decision-log.md#PXD-216');
 assert.equal(productTruth.reviewKind,'CURRENT_SOURCE_DEFINITION_REVIEW');
 assert.match(productTruth.scope,/20 capability leaves with materially changed PDP-0 meaning fields/u);
 assert.match(productTruth.scope,/all 462 canonical lane records/u);
 assert.equal(byId.get('P0-01').currentSourceReview.decisionRef,'.product-experience/decision-log.md#PXD-225');
 const rightsReview=byId.get('P0-01').historicalCorrectiveReviews.find(review=>review.decisionRef==='.product-experience/decision-log.md#PXD-209');
 assert.ok(rightsReview,'PXD-209 rights and import review remains in its source-cut history');
 assert.match(rightsReview.scope,/media\.artifact\.search/u);
 assert.match(rightsReview.scope,/exact immutable asset versions/u);
 assert.match(rightsReview.scope,/declared intended-use scope/u);
 assert.match(rightsReview.scope,/current authoritative per-version rights\/license evidence/u);
 assert.match(rightsReview.scope,/501 audit identities/u);
 const bounds=byId.get('P0-02').currentCorrectiveReview;
 assert.equal(bounds.reviewKind,'EXACT_FIELD_CURRENT_SOURCE_RECHECK');
 assert.match(bounds.scope,/462 capability.*profile.*bound/u);
 assert.match(bounds.scope,/no numeric resource bound.*changed/u);
 const policy=byId.get('P0-05').currentCorrectiveReview;
 assert.equal(policy.reviewKind,'SCOPED_SOURCE_DEFINITION_REVIEW');
 assert.match(policy.scope,/MEDIA-REQ-CAP-GENERATE-AUDIO-AC-05/u);
 assert.match(policy.scope,/checkpoint identity and version.*license.*use-scope.*declared purpose/u);
 assert.match(policy.scope,/noncommercial.*commercial/u);
 assert.match(policy.scope,/similarity observation is not rights clearance/u);
 const authorizationReview=byId.get('P0-05').currentSourceReview;
 assert.equal(authorizationReview.status,'APPROVED_CURRENT_SOURCE_REVIEW');
 assert.equal(authorizationReview.decisionRef,'.product-experience/decision-log.md#PXD-208');
 assert.equal(authorizationReview.phaseScope,'PDP-0');
 assert.equal(authorizationReview.reviewKind,'COORDINATOR_AUTHORED_CURRENT_SOURCE_SEMANTIC_REVIEW');
 assert.equal(authorizationReview.verification.status,'PASS');
 assert.equal(authorizationReview.ownerApproval,'NOT_CLAIMED');
 assert.equal(authorizationReview.acceptanceEffect,'none');
 assert.match(authorizationReview.acceptanceBoundary,/independent acceptance.*not claimed/iu);
 for(const [file,digest] of Object.entries(authorizationReview.sourceFingerprints))
  assert.equal(digest,sourcePin(file),`P0-05 current authorization review source pin ${file}`);
 const resolvedAuthorizationReview=resolveCriterionReviewSourceCut(byId.get('P0-05'),sourcePin,sourceOwnerPhase);
 assert.equal(resolvedAuthorizationReview.currentSourceReviewCurrent,true);
 assert.equal(resolvedAuthorizationReview.currentSourcePinRefreshCurrent,true);
 assert.equal(resolvedAuthorizationReview.sourceCutCurrent,true);
 const quality=byId.get('P0-06').currentCorrectiveReview;
 assert.equal(quality.reviewKind,'SCOPED_SOURCE_DEFINITION_REVIEW');
 assert.match(quality.scope,/462 capability identities.*quality applicability crosswalk/u);
 assert.match(quality.scope,/2,772 dimension dispositions.*7,392 metric dispositions/u);
 assert.match(quality.scope,/NOT_EVALUATED/u);
 const applicability=byId.get('P0-07').currentCorrectiveReview;
 assert.equal(applicability.reviewKind,'CURRENT_CONSUMER_SCOPE_CORRECTION');
 assert.match(applicability.scope,/61 exact declarative acceptance-case bindings/u);
 assert.match(applicability.scope,/48 previously unresolved case pairs/u);
 assert.match(applicability.scope,/Studio.*37.*20.*17/u);
 assert.match(applicability.scope,/Interactive Demo Player.*8.*3.*5/u);
 assert.match(applicability.scope,/Recorder Orchestrator.*25.*13.*12/u);
 assert.match(applicability.scope,/generic Web partition remains 77 applicable and 385 non-applicable/u);
 assert.match(applicability.scope,/CLI runtime admission remains NOT_ADMITTED/u);
 assert.match(applicability.scope,/54 registered identities/u);
 assert.match(applicability.scope,/owner approval and independent acceptance remain NOT_CLAIMED/u);
 assert.equal(crosswalk.coordinatorReview.decisionRef,'PXD-225');
 assert.equal(crosswalk.coordinatorReview.priorDecisionRef,'PXD-223');
 assert.equal(crosswalk.coordinatorReview.ownerApproval,'NOT_CLAIMED');
 assert.ok(!crosswalk.coordinatorReview.reviewHistory.some(review=>review.decisionRef==='PXD-195'));
 assert.ok(crosswalk.coordinatorReview.reviewHistory.some(review=>review.decisionRef==='PXD-194'));
 assert.equal(crosswalk.denominator.surfaceDenominator.registeredIdentities,54);
 assert.equal(crosswalk.denominator.surfaceDenominator.logicalConsumers,21);
 assert.equal(crosswalk.denominator.surfaceDenominator.physicalCandidates,26);
 assert.equal(crosswalk.denominator.surfaceDenominator.compositionsIncludingRoot,7);
});

broadTest('a corrective approval uses its own reviewed source cut and preserves historical pins',()=>{
 const historical={sourceFingerprints:{source:'old'}};
 const current=file=>file==='source'?'new':null;
 assert.equal(resolveCriterionReviewSourceCut(historical,current).sourceCutCurrent,false);
 const correction={status:'APPROVED_CURRENT_CORRECTION',sourceFingerprints:{source:'new'}};
 const reviewed=resolveCriterionReviewSourceCut({...historical,currentCorrectiveReview:correction},current);
 assert.equal(reviewed.sourceCutCurrent,true);
 assert.equal(reviewed.historicalSourceCutCurrent,false);
 assert.deepEqual(reviewed.sourceFingerprints,{source:'old'});
 for(const pins of [undefined,{}, {source:'old'}, {missing:'new'}]) {
   assert.equal(resolveCriterionReviewSourceCut({...historical,currentCorrectiveReview:{...correction,sourceFingerprints:pins}},current).sourceCutCurrent,false);
 }
 const old=file=>file==='source'?'old':null;
 assert.equal(resolveCriterionReviewSourceCut({...historical,currentCorrectiveReview:{status:'APPROVED_CURRENT_CORRECTION'}},old).sourceCutCurrent,false,'an old matching cut cannot substitute for corrective evidence');
});
broadTest('a PDP-0 criterion cannot use a downstream-scoped current review',()=>{
 const record={taskId:'P0-01',sourceFingerprints:{p0:'live'},currentCorrectiveReview:{
  status:'APPROVED_CURRENT_SOURCE_REVIEW',phaseScope:'PDP-1',decisionRef:'wrong-phase',sourceFingerprints:{p0:'live'},
 }};
 assert.equal(resolveCriterionReviewSourceCut(record,file=>file==='p0'?'live':null,()=> 'PDP-0').sourceCutCurrent,false);
});
broadTest('a PDP-0 source review remains current when only downstream phase inputs change',()=>{
 const pins={
  '.product-experience/pdp-0-product-truth/capabilities.yaml':'current-p0',
  '.product-experience/pdp-1-domain-data/operations.yaml':'previous-p1',
  'tests/pdp2-interface-contracts.test.mjs':'previous-p2',
  'tests/pdp3-journey-bindings.test.mjs':'previous-p3',
 };
 const record={taskId:'P0-01',sourceFingerprints:{...pins},currentCorrectiveReview:{
  status:'APPROVED_CURRENT_SOURCE_REVIEW',phaseScope:'PDP-0',decisionRef:'p0-current-review',sourceFingerprints:pins,
 }};
 const owner=file=>file==='.product-experience/pdp-1-domain-data/operations.yaml'?'PDP-1'
  :file==='tests/pdp2-interface-contracts.test.mjs'?'PDP-2'
  :file==='tests/pdp3-journey-bindings.test.mjs'?'PDP-3':'PDP-0';
 const downstreamOnlyChanged=file=>file.includes('pdp-0-product-truth/capabilities.yaml')?'current-p0':'changed-downstream';
 assert.equal(resolveCriterionReviewSourceCut(record,downstreamOnlyChanged,owner).sourceCutCurrent,true,
  'downstream PDP-1/PDP-2/PDP-3 references cannot reopen PDP-0 currentness');
 const p0MeaningChanged=file=>file.includes('pdp-0-product-truth/capabilities.yaml')?'changed-p0':'changed-downstream';
 assert.equal(resolveCriterionReviewSourceCut(record,p0MeaningChanged,owner).sourceCutCurrent,false,
  'a changed PDP-0 source still makes the PDP-0 review stale');
});
broadTest('phase ownership is explicit and ambiguous or unknown paths fail closed',()=>{
 const owner=createSourceOwnerPhaseResolver({productArtifactIndex:{records:[
  {path:'definitions/pdp-1-named-p0.yaml',owningPhase:'PDP-0'},
  {path:'definitions/p1.yaml',owningPhase:'PDP-1'},
  {path:'definitions/shared.yaml',owningPhase:'CROSS_PHASE'},
  {path:'definitions/conflict.yaml',owningPhase:'PDP-1'},
  {path:'definitions/conflict.yaml',owningPhase:'PDP-2'},
 ]}},{
  'P0-01':['tests/shared-pdp-1-name.test.mjs','tests/p0-only.test.mjs'],
  'P1-01':['tests/shared-pdp-1-name.test.mjs','tests/p1-only.test.mjs'],
  'P2-01':['tests/p2-only.test.mjs'],
 });
 assert.equal(owner('definitions/p1.yaml'),'PDP-1');
 assert.equal(owner('definitions/pdp-1-named-p0.yaml'),'PDP-0');
 assert.equal(owner('definitions/shared.yaml'),'CROSS_PHASE');
 assert.equal(owner('definitions/conflict.yaml'),undefined);
 assert.equal(owner('tests/p1-only.test.mjs'),'PDP-1');
 assert.equal(owner('tests/shared-pdp-1-name.test.mjs'),undefined);
 assert.equal(owner('tests/pdp-2-unknown.test.mjs'),undefined);
});
broadTest('PDP-0 current-source refreshes drive currentness while retaining historical review pins',()=>{
 const files={p0:'live',p1:'prior',decision:'context'};
 const current=file=>files[file]??null;
 const owner=file=>file==='p1'?'PDP-1':'PDP-0';
 const pinRefresh={status:'CURRENT_SOURCE_PIN_REFRESH_ONLY',phaseScope:'PDP-0',preservesReviewRef:'.product-experience/decision-log.md#PXD-196',
   semanticReview:'NOT_PERFORMED',ownerApproval:'NOT_CLAIMED',acceptanceEffect:'none',currentSourceFingerprints:{p0:'live',p1:'prior'},
   decisionContextFingerprint:{sourceRef:'decision',sha256:'context'}};
 const record={taskId:'P0-02',sourceFingerprints:{source:'old'},currentCorrectiveReview:{status:'APPROVED_CURRENT_SOURCE_REVIEW',sourceFingerprints:{source:'old'}},currentSourcePinRefresh:pinRefresh};
 const resolved=resolveCriterionReviewSourceCut(record,current,owner);
 assert.equal(resolved.historicalSourceCutCurrent,false);
 assert.equal(resolved.currentSourcePinRefreshCurrent,true);
 assert.equal(resolved.sourceCutCurrent,true);
 assert.deepEqual(resolved.currentCorrectiveReview.sourceFingerprints,{source:'old'});
 files.p1='changed-downstream';
 assert.equal(resolveCriterionReviewSourceCut(record,current,owner).sourceCutCurrent,true,'a downstream-only pin change does not reopen the PDP-0 pin refresh');
 files.p0='changed-p0';
 assert.equal(resolveCriterionReviewSourceCut(record,current,owner).sourceCutCurrent,false,'a PDP-0 source change stales the pin refresh');
 files.p0='live';
 files.decision='changed';
 assert.equal(resolveCriterionReviewSourceCut(record,current,owner).sourceCutCurrent,false,'stale decision context cannot support currentness');
 const qualityRefresh={status:'CURRENT_PDP0_QUALITY_PROJECTION_REFRESH',phaseScope:'PDP-0',preservesReviewRef:'.product-experience/decision-log.md#PXD-196',
   semanticDecision:'NOT_MADE',ownerApproval:'NOT_CLAIMED',acceptanceEffect:'none',sourceFingerprints:{p0:'live',p1:'prior'},
   projectionArtifactRef:'quality.json',projectionArtifactSha256:'artifact',decisionContextFingerprints:{decision:'context'}};
 files['quality.json']='artifact';
 files.decision='context';
 files.p1='prior';
 const projectionRecord={taskId:'P0-06',sourceFingerprints:{source:'old'},currentProjectionRefresh:qualityRefresh};
 const projection=resolveCriterionReviewSourceCut(projectionRecord,current,owner);
 assert.equal(projection.historicalSourceCutCurrent,false);
 assert.equal(projection.currentProjectionRefreshCurrent,true);
 assert.equal(projection.sourceCutCurrent,true);
 files.p1='changed-downstream';
 assert.equal(resolveCriterionReviewSourceCut(projectionRecord,current,owner).sourceCutCurrent,true,'a downstream-only pin change does not reopen the PDP-0 quality projection');
 files.p0='changed-p0';
 assert.equal(resolveCriterionReviewSourceCut(projectionRecord,current,owner).sourceCutCurrent,false,'a PDP-0 source change stales the quality projection');
});
broadTest('an explicit PDP-0 source review and its authorized refresh evidence must remain current independently',()=>{
 const authorityArtifact='docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd225.json';
 const authoritySection='.product-experience/decision-log.md#PXD-225-section';
 const files={reviewSource:'review-current',p0Source:'p0-current',decision:'context-current',p1Source:'p1-prior',
  [authorityArtifact]:'authority-current',[authoritySection]:'authority-section-current'};
 const current=file=>files[file]??null;
 const owner=file=>file==='p1Source'?'PDP-1':'PDP-0';
 const pinRefresh={status:'CURRENT_SOURCE_PIN_REFRESH_ONLY',phaseScope:'PDP-0',preservesReviewRef:'.product-experience/decision-log.md#PXD-196',
   semanticReview:'NOT_PERFORMED',ownerApproval:'NOT_CLAIMED',acceptanceEffect:'none',currentSourceFingerprints:{p0Source:'p0-current',p1Source:'p1-prior'},
   currentnessAuthority:{decisionRef:'.product-experience/decision-log.md#PXD-225',artifactRef:authorityArtifact,
    artifactSha256:'authority-current',decisionSectionSha256:'authority-section-current'},
   decisionContextFingerprint:{sourceRef:'decision',sha256:'context-current'}};
 const sourceReview={status:'APPROVED_CURRENT_SOURCE_REVIEW',phaseScope:'PDP-0',decisionRef:'.product-experience/decision-log.md#PXD-208',
   sourceFingerprints:{reviewSource:'review-current',p1Source:'p1-prior',decision:'context-current'}};
 const record={taskId:'P0-05',status:'APPROVED_DIRECT_DEFINITION_CRITERION',currentCorrectiveReview:{status:'APPROVED_CURRENT_SOURCE_REVIEW',phaseScope:'PDP-0',decisionRef:'.product-experience/decision-log.md#PXD-196'},
   currentSourceReview:sourceReview,currentSourcePinRefresh:pinRefresh};
 let resolved=resolveCriterionReviewSourceCut(record,current,owner);
 assert.equal(resolved.currentSourcePinRefreshCurrent,true);
 assert.equal(resolved.currentSourceReviewCurrent,true);
 assert.equal(resolved.sourceCutCurrent,true);
 files.reviewSource='review-stale';
 resolved=resolveCriterionReviewSourceCut(record,current,owner);
 assert.equal(resolved.currentSourcePinRefreshCurrent,true,'a current pin refresh remains separately diagnosable');
 assert.equal(resolved.currentSourceReviewCurrent,false,'a pin refresh cannot make a stale semantic review current');
 assert.equal(resolved.sourceCutCurrent,false);
 assert.equal(resolved.currentSourceReviewCurrent===true && resolved.sourceCutCurrent===true,false,
   'a stale explicit source review cannot satisfy a PDP-0 criterion');
 files.reviewSource='review-current';
 files[authorityArtifact]='authority-stale';
 resolved=resolveCriterionReviewSourceCut(record,current,owner);
 assert.equal(resolved.currentnessAuthorityCurrent,false,'a stale PXD-225 refresh authority cannot support currentness');
 assert.equal(resolved.currentSourcePinRefreshCurrent,false);
 files[authorityArtifact]='authority-current';
 files.p0Source='p0-stale';
 resolved=resolveCriterionReviewSourceCut(record,current,owner);
 assert.equal(resolved.currentSourceReviewCurrent,true,'a current semantic review stays distinct from its stale pin refresh');
 assert.equal(resolved.currentSourcePinRefreshCurrent,false);
 assert.equal(resolved.sourceCutCurrent,false);
 files.p0Source='p0-current';
 files.p1Source='p1-changed';
 assert.equal(resolveCriterionReviewSourceCut(record,current,owner).currentSourceReviewCurrent,true,
   'PDP-1-only source movement remains excluded from PDP-0 source currentness');
 const withoutRefresh={...record,currentSourcePinRefresh:undefined};
 assert.equal(resolveCriterionReviewSourceCut(withoutRefresh,current,owner).sourceCutCurrent,true,
   'a current explicit source review can establish its own current source cut');
 assert.equal(resolveCriterionReviewSourceCut({...withoutRefresh,currentSourceReview:{...sourceReview,sourceFingerprints:{}}},current,owner).sourceCutCurrent,false,
   'an approved review with missing fingerprints fails closed');
});
broadTest('fixed 38-task scope rejects extras, duplicates and missing tasks',()=>{
  const rows=taskIds.map(id=>({id}));
  validateTaskPopulation(rows);
  for(const bad of [rows.slice(1),[...rows,{id:'E-01'}],rows.map((r,i)=>i===0?rows[1]:r)]) assert.throws(()=>validateTaskPopulation(bad));
});
broadTest('P0-04 source completion never implies dependency completion or original ledger completion',()=>{
  const r=build({'P0-04':{status:'PASS'}});const p=r.tasks.find(t=>t.id==='P0-04');
  assert.equal(p.definitionCriterionSatisfied,true);assert.equal(p.taskSpecificSourceDone,'VERIFIED_IN_CURRENT_SOURCE');
  assert.equal(p.originalFullTaskDone,false);assert.equal(p.overallDone,'partial');assert.equal(p.dependencyReady,'NOT_ESTABLISHED');
  assert.equal(p.nativePhaseProofCurrent,'NOT_EVALUATED');assert.equal(p.independentReviewAccepted,'NOT_EVALUATED');
});
broadTest('historical complete or failed verification cannot manufacture a current source pass',()=>{
  for(const evidence of [{},{'P0-04':{status:'FAIL'}}]) assert.equal(build(evidence).tasks.find(t=>t.id==='P0-04').definitionCriterionSatisfied,false);
  assert.equal(build({}).tasks.find(t=>t.id==='P1-06').taskSpecificSourceDone,'PRIOR_SOURCE_AUDIT_MET_REVALIDATION_REQUIRED');
});
broadTest('a successful test on a changing source cut cannot establish current completion',()=>{
  assert.deepEqual(verificationCutChanged({a:'old',b:'same',removed:'old'}, {a:'new',b:'same',added:'new'}), ['a','added','removed']);
  assert.deepEqual(verificationCutChanged({a:'same'}, {a:'same'}), []);
  const row=build({'P0-04':{status:'PASS_ON_CHANGED_SOURCE_CUT_REVALIDATION_REQUIRED'}}).tasks.find(t=>t.id==='P0-04');
  assert.equal(row.definitionCriterionSatisfied,false);
  assert.equal(row.nativePhaseProofCurrent,'NOT_EVALUATED');
});
broadTest('live counters preserve receipt uncertainty and dynamic source denominator',()=>{
 const r=build({});assert.equal(r.currentCounters.obligations,residual.lifecycle.obligationCount);
 assert.equal(r.currentCounters.authoritativeReceiptCount,null);assert.equal(r.currentCounters.currentness.status,'NOT_EVALUATED');
 assert.equal(r.taskCount,38);assert.equal(r.phases.length,4);
});
broadTest('new source obligations remain distinct from the persisted evidence population',()=>{
 const r=buildReadiness({audit,residual,mainSha:'fixture',fingerprints:{},definitionCensus:{
   lifecycleSourceEnumeration:{count:residual.lifecycle.obligationCount+1,issues:[]},
 }});
 assert.equal(r.currentCounters.sourceEnumeratedObligations,residual.lifecycle.obligationCount+1);
 assert.equal(r.currentCounters.persistedObligationPopulationCountMatchesSource,false);
 assert.equal(r.currentCounters.obligations,residual.lifecycle.obligationCount);
 assert.equal(r.currentCounters.authoritativeReceiptCount,null);
});
broadTest('passing a bounded implementation suite never establishes a whole task or specialist acceptance',()=>{
 const p=build({'P1-09':{status:'PASS'}}).tasks.find(t=>t.id==='P1-09');
 assert.equal(p.currentImplementationEvidence.sourceTests,'PASS');
 assert.equal(p.currentImplementationEvidence.wholeTaskCriterionEstablished,false);
 assert.equal(p.definitionCriterionSatisfied,false);
 assert.equal(p.independentReviewAccepted,'NOT_EVALUATED');
 assert.equal(p.LifecyclePhaseReceiptCurrent,'NOT_EVALUATED');
});
broadTest('a reviewed current direct definition criterion remains separate from original task and external acceptance',()=>{
 const review={status:'APPROVED_DIRECT_DEFINITION_CRITERION',sourceCutCurrent:true,decisionRef:'.product-experience/decision-log.md#fixture'};
 const make=entry=>buildReadiness({audit,residual,verification:{'P0-01':{status:'PASS'}},definitionCriterionReviews:{'P0-01':entry},mainSha:'fixture',fingerprints:{}}).tasks.find(t=>t.id==='P0-01');
 assert.equal(make(review).definitionCriterionSatisfied,true);
 assert.equal(make(review).originalFullTaskDone,false);
 assert.equal(make(review).independentReviewAccepted,'NOT_EVALUATED');
 assert.equal(make(review).LifecyclePhaseReceiptCurrent,'NOT_EVALUATED');
 assert.equal(make({...review,sourceCutCurrent:false}).definitionCriterionSatisfied,false);
 assert.equal(make({...review,status:'PROPOSED'}).definitionCriterionSatisfied,false);
 const reopened=make({...review,currentCorrectiveReview:{status:'OPEN_MATERIAL_CORRECTION'}});
 assert.equal(reopened.definitionCriterionSatisfied,false,'prior green tests and matching hashes cannot close a known semantic defect');
 assert.equal(reopened.taskSpecificSourceDone,'REOPENED_SOURCE_CONTRACT_CORRECTION_REQUIRED');
 assert.equal(make({...review,currentCorrectiveReview:{status:'APPROVED_CURRENT_CORRECTION'}}).definitionCriterionSatisfied,true);
});

broadTest('current dependency observations cannot inherit historical no-unmet flags or source-test acceptance', () => {
 const rows = assessCurrentTaskDependencies([
  {id:'P0-01', taskSpecificSourceDone:'VERIFIED_IN_CURRENT_SOURCE', independentReviewAccepted:'NOT_EVALUATED', LifecyclePhaseReceiptCurrent:'NOT_EVALUATED'},
  {id:'P0-03', taskSpecificSourceDone:'NOT_ESTABLISHED'},
  {id:'P0-04', dependencies:'P0-01 through P0-03; X-01.', dependencyReady:'PRIOR_AUDIT_NO_UNMET_DEPENDENCY_IDENTIFIED'},
 ]);
 const observed = rows.find(row=>row.id==='P0-04').currentDependencyAssessment;
 assert.equal(observed.status,'NOT_ESTABLISHED');
 assert.deepEqual(new Set(observed.records.map(row=>row.id)),new Set(['P0-01','P0-02','P0-03','X-01']));
 assert.equal(observed.records.find(row=>row.id==='P0-01').sourceCriterion,'VERIFIED_IN_CURRENT_SOURCE');
 assert.equal(observed.records.find(row=>row.id==='P0-01').readiness,'NOT_ESTABLISHED');
 assert.equal(observed.records.find(row=>row.id==='X-01').boundary,'EXTERNAL_DEPENDENCY_ONLY');
 assert.equal(rows.find(row=>row.id==='P0-04').dependencyReady,'PRIOR_AUDIT_NO_UNMET_DEPENDENCY_IDENTIFIED');
});

broadTest('PDP-0 development status stays separate from the historical 38-task and acceptance report', () => {
 const dev=buildPdp0DevStatus({mainSha:'fixture',sourceShaSet:{'owner.yaml':'abc'},verification:{'P0-01':{status:'PASS',command:'node --test p0.test.mjs'}},definitionCriterionReviews:{},sourceInventory:{sourceRecordCount:{capabilityLeaves:462,masterPlanClaims:129},semanticallyResolvedCount:{capabilityLeafAdjudications:462,masterPlanClaims:129}},exportedHandoffIds:['MSC-07-MSD-015-L0584-C05'],approvedMediaDecisions:['PXD-123']});
 assert.equal(dev.phase,'PDP-0');
 assert.equal(dev.status,'IN_PROGRESS');
 assert.deepEqual(dev.sourceRecordCount,{capabilityLeaves:462,masterPlanClaims:129});
 assert.equal(dev.testsActuallyRun['P0-01'].command,'node --test p0.test.mjs');
 assert.deepEqual(dev.outstandingMeaningIds,[]);
 assert.equal(dev.directDevelopmentCriteria['P0-02'].testStatus,'NOT_RUN');
 assert.ok(dev.exportedHandoffIds.includes('MSC-07-MSD-015-L0584-C05'));
 assert.deepEqual(dev.approvedMediaDecisions,['PXD-123']);
 for (const forbidden of ['Lifecycle','receipts','independentReview','release','production','certification','convergence']) assert.equal(Object.keys(dev).some(key=>key.toLowerCase().includes(forbidden.toLowerCase())),false,`${forbidden} is not a dev-status field`);
 const historical=build({'P0-04':{status:'PASS'}});
 assert.equal(historical.schemaVersion,'media.pdp-38-readiness.v1');
 assert.equal(historical.taskCount,38);
 assert.ok(!Object.hasOwn(historical,'status'));
});

test('PDP-0 development status can close only with the exact full source inventory and no outstanding meaning', () => {
 const criteria=['P0-01','P0-02','P0-03','P0-04','P0-05','P0-06','P0-07','P0-08'];
 const verification=Object.fromEntries(criteria.map(id=>[id,{status:'PASS',command:`node --test ${id}`,testCount:id==='P0-03'?30:1,passedTestCount:1,skippedTestCount:id==='P0-03'?29:0,outputSha256:'observed',testSourceFingerprints:{'tests/p0.test.mjs':'abc'},sourceCut:{fingerprints:{'tests/p0.test.mjs':'abc'},changedDuringVerification:[],changedBeforeReport:[]}}]));
 const counts={capabilityLeafAdjudications:462,requirementGroups:38,intents:19,journeys:30,profileBoundCapabilityLeaves:462,qualityDimensions:6,qualityMetricDefinitions:16,qualityApplicabilityLeaves:462,channelApplicabilityLeaves:462,featureReviewDimensions:15,featureReviewCapabilityLeaves:462,masterPlanClaims:129,constitutionalRequirements:32};
 const integrityChecks={capabilities:true,profiles:true,quality:true,features:true,claims:true,requirements:true,constitution:true,handoff:true,pdp0SurfaceDenominatorComplete:true,pdp0AuditDispositionsComplete:true};
 const p0ScopeReviews=Object.fromEntries(['P0-01','P0-02','P0-05','P0-06','P0-07'].map(id=>[id,{
  status:'APPROVED_DIRECT_DEFINITION_CRITERION',sourceCutCurrent:true,
  currentCorrectiveReview:{status:'APPROVED_CURRENT_CORRECTION',phaseScope:'PDP-0',decisionRef:'.product-experience/decision-log.md#PXD-138'},
 }]));
 integrityChecks.currentP0CriterionScopesComplete=true;
 const completeInventory={sourceCutStable:true,integrityChecks,sourceRecordCount:counts,semanticallyResolvedCount:{...counts},
  campaignDenominator:{physicalManifestCandidates:26,compositions:7,logicalConsumers:21,registrySurfaces:21,archivedConsumers:1,activeLogicalConsumers:20,activeLogicalScopesResolved:20,denominator:54},
  auditDispositions:{original:428,focused:73,total:501,boundExisting:501,resolvedPdp0:501,unresolvedPdp0:0},
  sourceReconciliations:[{id:'legacy-summary',status:'HISTORICAL_SOURCE_ONLY',currentOwnerRef:'current-owner.yaml#/records'}]};
 const handoffs=['media.pdp0-pdp1.capability-intent-handoff.v1','MSC-07-MSD-015-L0584-C05'];
 const dev=buildPdp0DevStatus({mainSha:'fixture',sourceShaSet:{'capabilities.yaml':'abc'},verification,definitionCriterionReviews:p0ScopeReviews,sourceInventory:completeInventory,exportedHandoffIds:handoffs});
 assert.equal(dev.status,'DEV_COMPLETE');
 assert.deepEqual(dev.outstandingMeaningIds,[]);
 assert.equal(Object.keys(dev.directDevelopmentCriteria).length,8);
 assert.equal(dev.testsActuallyRun['P0-01'].testCount,1);
 assert.equal(dev.testsActuallyRun['P0-03'].skippedTestCount,29);
 assert.equal(dev.testsActuallyRun['P0-01'].outputSha256,'observed');
 assert.deepEqual(dev.sourceReconciliations,[{id:'legacy-summary',status:'HISTORICAL_SOURCE_ONLY',currentOwnerRef:'current-owner.yaml#/records'}]);
 assert.deepEqual(dev.exportedHandoffIds,handoffs.sort());
 const expectOpen=(mutate,message)=>{
  const nextVerification=structuredClone(verification), nextInventory=structuredClone(completeInventory), nextHandoffs=[...handoffs], nextReviews=structuredClone(p0ScopeReviews);
  mutate({verification:nextVerification,inventory:nextInventory,handoffs:nextHandoffs,reviews:nextReviews});
  const result=buildPdp0DevStatus({mainSha:'fixture',sourceShaSet:{'capabilities.yaml':'abc'},verification:nextVerification,definitionCriterionReviews:nextReviews,sourceInventory:nextInventory,exportedHandoffIds:nextHandoffs});
  assert.equal(result.status,'IN_PROGRESS',message);
 };
 expectOpen(({verification:v})=>{v['P0-01'].testCount=2;},'partial test pass cannot establish completion');
 expectOpen(({verification:v})=>{v['P0-08'].skippedTestCount=1;},'unexpected skips cannot establish completion');
 expectOpen(({verification:v})=>{v['P0-03'].skippedTestCount=13;},'missing phase-gated skips cannot establish completion');
 expectOpen(({verification:v})=>{delete v['P0-01'].outputSha256;},'missing output evidence cannot establish completion');
 expectOpen(({verification:v})=>{v['P0-01'].sourceCut.changedDuringVerification=['capabilities.yaml'];},'test-time source change cannot establish completion');
 expectOpen(({inventory})=>{inventory.sourceRecordCount.qualityMetricDefinitions--;},'denominator mismatch cannot establish completion');
 expectOpen(({inventory})=>{delete inventory.sourceRecordCount.journeys;delete inventory.semanticallyResolvedCount.journeys;},'an omitted inventory population cannot establish completion');
 expectOpen(({inventory})=>{inventory.sourceRecordCount.intents=18;inventory.semanticallyResolvedCount.intents=18;},'a self-consistent but wrong denominator cannot establish completion');
 expectOpen(({inventory})=>{delete inventory.sourceReconciliations[0].currentOwnerRef;},'an unbound historical source reconciliation cannot establish completion');
 expectOpen(({inventory})=>{inventory.integrityChecks.quality=false;},'failed inventory integrity cannot establish completion');
 expectOpen(({inventory})=>{inventory.integrityChecks.currentP0CriterionScopesComplete=false;},'unresolved sequential phase criterion scopes cannot establish completion');
 expectOpen(({inventory})=>{inventory.campaignDenominator.denominator=53;},'a narrowed physical/composite/logical surface denominator cannot establish completion');
 expectOpen(({inventory})=>{inventory.auditDispositions.unresolvedPdp0=1;},'an unresolved PDP-0 audit definition cannot establish completion');
 expectOpen(({inventory})=>{inventory.integrityChecks.pdp0AuditDispositionsComplete=false;},'a failed 501-row source crosswalk cannot establish completion');
 expectOpen(({reviews})=>{delete reviews['P0-01'];},'missing current P0 criterion review cannot establish completion');
 expectOpen(({reviews})=>{reviews['P0-06'].currentCorrectiveReview.phaseScope='PDP-1';},'downstream criterion scope cannot gate PDP-0 completion');
 expectOpen(({reviews})=>{reviews['P0-07'].sourceCutCurrent=false;},'stale criterion review cannot establish completion');
 expectOpen(({inventory})=>{inventory.sourceCutStable=false;},'changed source cut cannot establish completion');
 expectOpen(({handoffs:h})=>{h.push(h[0]);},'duplicate handoff identity cannot establish completion');
 const notRun=buildPdp0DevStatus({mainSha:'fixture',sourceShaSet:{},verification:Object.fromEntries(criteria.map(id=>[id,{status:'PASS',command:`node --test ${id}`,testCount:1,passedTestCount:1,outputSha256:'x',testSourceFingerprints:{'p0.test.mjs':'x'}}])),sourceInventory:completeInventory,exportedHandoffIds:handoffs});
 assert.equal(notRun.status,'IN_PROGRESS','missing stable source-cut evidence cannot establish development completion');
});

test('persisting phase status writes a separate file and preserves the historical 38-task report', () => {
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pdp0-dev-status-'));
 const historicalPath=path.join(temp,'docs/implementation/media-pdp-38-readiness.json');
 fs.mkdirSync(path.dirname(historicalPath),{recursive:true});
 fs.writeFileSync(historicalPath,'historical fixture\n');
 const status={schemaVersion:'media.phase-dev-status.v1',phase:'PDP-0',status:'IN_PROGRESS',sourceShaSet:{}};
 const written=writePdp0DevStatus(status,temp);
 assert.equal(written,path.join(temp,'docs/implementation/pdp-0-phase-dev-status.json'));
 assert.equal(fs.readFileSync(historicalPath,'utf8'),'historical fixture\n');
 assert.deepEqual(JSON.parse(fs.readFileSync(written,'utf8')),status);
 fs.rmSync(temp,{recursive:true,force:true});
});
