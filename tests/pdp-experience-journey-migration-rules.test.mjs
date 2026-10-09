import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const requireTools=createRequire(resolve("../ghatana-tools/package.json"));
const {parse}=requireTools("yaml");
const journeyPath=".product-experience/pdp-0-product-truth/journey-catalog.yaml";
const migrationPath=".product-experience/pdp-0-product-truth/migration-semantics-review.yaml";
const snapshotPath="docs/implementation/verification/pdp-38/migration-journey-owner-review.json";
const approvalPath="docs/implementation/verification/pdp-38/migration-coordinator-review-25.json";
const read=(path)=>parse(readFileSync(path,"utf8"));
const sourceCache=new Map([[journeyPath,read(journeyPath)]]);
const sha=(value)=>createHash("sha256").update(String(value)).digest("hex");
const expectedClaims=[
"MPSEM-0030-C002","MPSEM-0032-C001","MPSEM-0090-C002","MPSEM-0163-C002","MPSEM-0180-C004","MPSEM-0212-C006","MPSEM-0227-C002","MPSEM-0299-C001","MPSEM-0299-C003","MPSEM-0308-C001","MPSEM-0334-C003","MPSEM-0352-C004","MPSEM-0357-C005","MPSEM-0367-C005","MPSEM-0377-C004","MPSEM-0378-C005","MPSEM-0387-C001","MPSEM-0388-C002","MPSEM-0446-C005","MPSEM-0448-C001","MPSEM-0448-C003","MPSEM-0451-C004","MPSEM-0455-C003","MPSEM-0472-C004","MPSEM-0475-C001",
];
function resolveJourneyRef(root,ref){
  if(typeof ref!=="string"||!ref.includes("#"))return undefined;
  const [path,anchor]=ref.split("#",2);
  let value=sourceCache.get(path);
  if(!value){try{value=read(path);sourceCache.set(path,value);}catch{return undefined;}}
  for(const part of anchor.split("/").filter(Boolean)){
    const match=/^@id=(.+)$/u.exec(part);
    if(match)value=Array.isArray(value)?value.find((item)=>item?.id===match[1]):undefined;
    else value=value?.[part];
  }
  return value;
}
function collectClaims(value,out=new Map()){
  if(!value||typeof value!=="object")return out;
  if(typeof value.claimId==="string"&&value.claimId.startsWith("MPSEM-"))out.set(value.claimId,value);
  for(const child of Object.values(value))collectClaims(child,out);
  return out;
}
function evaluate(rule,facts){
  const required=rule.requiredFacts.map((x)=>facts[x.factId]);
  const prohibited=rule.prohibitedFacts.map((x)=>facts[x.factId]);
  if(required.some((v)=>v===false)||prohibited.some((v)=>v===true))return "DENY";
  if(required.some((v)=>v!==true)||prohibited.some((v)=>v!==false))return "UNKNOWN";
  return "ALLOW_DEFINITION_CASE";
}
function positiveFacts(rule){return Object.fromEntries([...rule.requiredFacts.map((x)=>[x.factId,true]),...rule.prohibitedFacts.map((x)=>[x.factId,false])]);}

test("the approved journey cohort has exact source-pinned owner rule records and preserves its proposal",()=>{
  const journey=read(journeyPath), migration=collectClaims(read(migrationPath));
  const snapshot=JSON.parse(readFileSync(snapshotPath,"utf8"));
  const approval=JSON.parse(readFileSync(approvalPath,"utf8"));
  const catalog=journey.ownerMigrationSemanticRules;
  assert.equal(catalog.id,"media.journey-migration-semantic-rules.v1");
  assert.equal(catalog.recordCount,25);
  assert.equal(catalog.normativeRecordCount,24);
  assert.equal(catalog.nonNormativeMetadataCount,1);
  assert.equal(catalog.status,"APPROVED_BOUNDED_OWNER_SOURCE_SEMANTIC_ROUTE");
  assert.equal(catalog.records.length,24);
  assert.equal(catalog.nonNormativeSourceMetadata.length,1);
  assert.equal(snapshot.schemaVersion,"media.pdp38-migration-journey-owner-review.v1");
  assert.equal(snapshot.recordCount,25);
  assert.equal(snapshot.normativeRecordCount,24);
  assert.equal(snapshot.metadataCount,1);
  assert.equal(approval.schemaVersion,"media.pdp38-coordinator-journey-review.v1");
  assert.equal(approval.decisionRef,".product-experience/decision-log.md#PXD-091");
  assert.equal(approval.reviewedRecordCount,25);
  assert.equal(approval.normativeRouteCount,24);
  assert.equal(approval.metadataClassificationCount,1);
  assert.equal(approval.historicalProposalSha256,sha(readFileSync(snapshotPath,"utf8")));
  assert.equal(approval.journeySourceSha256,sha(readFileSync(journeyPath,"utf8")));
  assert.match(approval.acceptanceEffect,/does not accept PDP task completion.*runtime\/admission.*Lifecycle receipt/u);
  assert.deepEqual([...catalog.records.map((r)=>r.claimId),...catalog.nonNormativeSourceMetadata.map((r)=>r.claimId)].sort(),[...expectedClaims].sort());
  assert.equal(new Set(catalog.records.map((r)=>r.id)).size,24);
  for(const rule of catalog.records){
    const claim=migration.get(rule.claimId);
    const historical=snapshot.records.find(({claimId})=>claimId===rule.claimId);
    assert.ok(claim,`${rule.claimId} exists in the pending migration source ledger`);
    assert.equal(claim.disposition,"ROUTED_TO_CURRENT_PDP_AUTHORITY");
    assert.equal(claim.semanticReviewStatus,"CLAIM_SPECIFIC_SEMANTIC_PARITY_VERIFIED");
    assert.equal(rule.claimSourceTextSha256,sha(claim.exactSourceText),`${rule.claimId}: source text pin`);
    if(rule.previousTargetRef){
      assert.equal(rule.previousTargetRef,historical.previousTargetRef,`${rule.claimId}: retain historical routed target`);
      assert.equal(rule.previousTargetTextSha256,historical.previousTargetValueSha256,`${rule.claimId}: retain historical target pin`);
    } else {
      assert.equal(rule.targetRef,historical.proposedTargetRef,`${rule.claimId}: preserve exact proposed target`);
      assert.equal(rule.targetTextSha256,historical.proposedTargetValueSha256,`${rule.claimId}: preserve exact proposed target pin`);
    }
    assert.equal(sha(resolveJourneyRef(journey,rule.targetRef)),rule.targetTextSha256,`${rule.claimId}: current target remains pinned`);
    assert.match(rule.id,/^media\.journey-semantic-rule\.mpsem-/u);
    assert.equal(rule.status,"APPROVED_BOUNDED_OWNER_SOURCE_SEMANTIC_ROUTE");
    assert.ok(rule.semanticRule.length>80,`${rule.claimId}: material semantic rule exists`);
    assert.ok(rule.requiredFacts.length>0&&rule.prohibitedFacts.length>0,`${rule.claimId}: explicit positive and falsifying predicates exist`);
    assert.equal(rule.oraclePolicy.logic,"TRI_STATE_CLOSED_FACTS");
    assert.equal(rule.oraclePolicy.runtimeEvidence,"NOT_ASSERTED");
    assert.equal(rule.oraclePolicy.acceptanceEffect,"none");
  }
  const metadata=catalog.nonNormativeSourceMetadata[0];
  const metadataClaim=migration.get(metadata.claimId);
  assert.equal(metadata.claimId,"MPSEM-0032-C001");
  assert.equal(metadata.claimSourceTextSha256,sha(metadataClaim.exactSourceText));
  const historicalMetadata=snapshot.records.find(({claimId})=>claimId===metadata.claimId);
  assert.equal(metadata.priorTargetRef,historicalMetadata.previousTargetRef);
  assert.equal(metadata.priorTargetTextSha256,historicalMetadata.previousTargetValueSha256);
  assert.equal(Object.hasOwn(metadataClaim,"targetRef"),false);
  assert.equal(metadata.acceptanceEffect,"none");
  assert.ok(metadata.sourceProofRequirement.length>40);
  assert.equal(metadata.sourceRowRef,"docs/migration/expert-reviewed-master-plan.md#L111");
  assert.equal(metadata.sourceRowSha256,sha(readFileSync("docs/migration/expert-reviewed-master-plan.md","utf8").split(/\r?\n/u)[110]));
  assert.deepEqual(snapshot.records.map(({claimId})=>claimId).sort(),[...expectedClaims].sort());
  for(const item of snapshot.records){
    const rule=catalog.records.find(({claimId})=>claimId===item.claimId);
    if(!rule){assert.equal(item.classification,"NON_NORMATIVE_SOURCE_METADATA");assert.equal(item.proposedTargetRef,null);continue;}
    assert.equal(item.classification,"NORMATIVE_SOURCE_RULE");
    assert.equal(item.proposedTargetRef,rule.targetRef);
    assert.equal(item.proposedTargetValueSha256,rule.targetTextSha256);
    assert.equal(item.previousTargetRef,rule.previousTargetRef);
    assert.equal(item.previousTargetValueSha256,rule.previousTargetTextSha256);
  }
  assert.deepEqual(approval.records.map(({claimId})=>claimId).sort(),[...expectedClaims].sort());
  for(const row of approval.records){
    const claim=migration.get(row.claimId);
    assert.equal(row.acceptanceEffect,"none");
    assert.equal(row.decisionRef,".product-experience/decision-log.md#PXD-091");
    if(row.classification==="NORMATIVE_SOURCE_RULE"){
      const rule=catalog.records.find(({claimId})=>claimId===row.claimId);
      assert.equal(row.currentTargetRef,rule.targetRef);
      assert.equal(row.currentTargetValueSha256,sha(JSON.stringify(resolveJourneyRef(journey,rule.targetRef))));
      assert.equal(claim.coordinatorReviewStatus,"APPROVED_BOUNDED_OWNER_SOURCE_SEMANTIC_ROUTE");
      assert.equal(claim.semanticReviewRef,`docs/implementation/verification/pdp-38/migration-coordinator-review-25.json#/records/@claimId=${row.claimId}`);
    }else{
      assert.equal(row.claimId,"MPSEM-0032-C001");
      assert.equal(row.classification,"NON_NORMATIVE_SOURCE_METADATA");
      assert.equal(claim.disposition,"NON_NORMATIVE_SOURCE_METADATA");
      assert.equal(row.sourceRowSha256,sha(row.sourceRowText));
      assert.match(row.sourceRowText,/REV-12.*A seed\/version is insufficient.*Declare exact, tolerance/u);
    }
  }
});

test("every migration rule has executable positive, falsifying, and missing-fact oracle cases",()=>{
  const catalog=read(journeyPath).ownerMigrationSemanticRules;
  for(const rule of catalog.records){
    const positive=positiveFacts(rule);
    assert.equal(evaluate(rule,positive),"ALLOW_DEFINITION_CASE",`${rule.claimId}: positive definition fixture`);
    for(const fact of rule.requiredFacts){
      assert.equal(evaluate(rule,{...positive,[fact.factId]:false}),"DENY",`${rule.claimId}: falsify required ${fact.factId}`);
      assert.equal(evaluate(rule,{...positive,[fact.factId]:"UNKNOWN"}),"UNKNOWN",`${rule.claimId}: missing certainty for ${fact.factId}`);
    }
    for(const fact of rule.prohibitedFacts){
      assert.equal(evaluate(rule,{...positive,[fact.factId]:true}),"DENY",`${rule.claimId}: reject prohibited ${fact.factId}`);
      assert.equal(evaluate(rule,{...positive,[fact.factId]:undefined}),"UNKNOWN",`${rule.claimId}: absent prohibited fact ${fact.factId}`);
    }
  }
});

test("the three corrected rules preserve exact source meaning",()=>{
  const catalog=read(journeyPath).ownerMigrationSemanticRules;
  const rules=new Map(catalog.records.map((rule)=>[rule.claimId,rule]));
  const inference=rules.get("MPSEM-0030-C002");
  assert.match(inference.semanticRule,/generic inference and model\/provider selection remain AI Inference-owned, including local deployment/i);
  assert.match(inference.semanticRule,/bounded worker exceptions require their own exact owner-bound contracts/i);
  assert.match(inference.targetRef,/handoff-contracts\.yaml#\/handoffs\/@id=ai-inference-execution\/genericInferenceOwnershipBoundary\/rule/u);
  assert.equal(inference.previousTargetRef,".product-experience/pdp-0-product-truth/journey-catalog.yaml#/journeys/@id=J-04/handoffCondition");
  assert.ok(inference.prohibitedFacts.some(({meaning})=>/localDeploymentUsedToInferMediaOwnership/u.test(meaning)));

  const heading=catalog.nonNormativeSourceMetadata.find(({claimId})=>claimId==="MPSEM-0032-C001");
  assert.equal(heading.classification,"REV12_TABLE_HEADING_METADATA_ONLY");
  assert.match(heading.sourceProofRequirement,/complete original REV-12 row.*verified.*C002-C004 remain distinct normative claims/i);
  assert.ok(heading.nonClaims.includes("headingIsNotAnIndependentNormativeRequirement"));

  const owner=rules.get("MPSEM-0090-C002");
  assert.match(owner.semanticRule,/Ghatana Media owns its media domain semantics.*domain stores and adapters/s);
  assert.match(owner.semanticRule,/Media is a product consumer, not a generic platform owner/i);
  assert.ok(owner.prohibitedFacts.some(({meaning})=>/MediaOwnershipExpandedIntoGenericPlatform/u.test(meaning)));
  assert.match(owner.targetRef,/ownerMigrationSemanticRules\/records\/@id=media\.journey-semantic-rule\.mpsem-0090-c002\/semanticRule/u);
  assert.equal(owner.previousTargetRef,".product-experience/pdp-0-product-truth/journey-catalog.yaml#/journeys/@id=J-14/handoffCondition");
  assert.equal(owner.oraclePolicy.runtimeEvidence,"NOT_ASSERTED");

  const finality=rules.get("MPSEM-0212-C006");
  assert.deepEqual(finality.outcomeDispositionVocabulary,["SUCCEEDED","FAILED","UNKNOWN","NOT_APPLICABLE"]);
  assert.equal(finality.partialCase.status,"DEFINITION_ORACLE_FIXTURE_ONLY");
  assert.deepEqual(Object.values(finality.partialCase.axes).map((axis)=>axis.disposition),["SUCCEEDED","UNKNOWN","NOT_APPLICABLE","UNKNOWN"]);
  assert.ok(finality.partialCase.invariants.includes("render-success-does-not-imply-publication"));
  assert.ok(finality.requiredFacts.every(({meaning})=>/DispositionOr/u.test(meaning)));
});

test("partial cancellation, security, remote-finality and offline outcomes stay independently truthful",()=>{
  const catalog=read(journeyPath).ownerMigrationSemanticRules;
  const rules=new Map(catalog.records.map((rule)=>[rule.claimId,rule]));
  const cancellation=rules.get("MPSEM-0357-C005");
  assert.deepEqual(cancellation.partialCase.axes["cancellation-capability"].disposition,"UNKNOWN");
  assert.deepEqual(cancellation.partialCase.axes["provider-retention"].disposition,"UNKNOWN");
  assert.ok(cancellation.outcomeAxes.every((axis)=>axis.dispositions.includes("UNKNOWN")));
  assert.equal(evaluate(cancellation,positiveFacts(cancellation)),"ALLOW_DEFINITION_CASE");
  assert.ok(cancellation.prohibitedFacts.some(({meaning})=>meaning==="cancelAcknowledgementMeansProviderStopped"));

  const security=rules.get("MPSEM-0367-C005");
  assert.deepEqual(security.partialCase.claimedAxes,["encryption-at-rest"]);
  assert.equal(security.partialCase.axes["encryption-at-rest"].disposition,"OBSERVED");
  assert.equal(security.partialCase.axes["key-deletion"].disposition,"UNKNOWN");
  assert.equal(security.partialCase.axes["provider-side-deletion"].disposition,"UNKNOWN");
  assert.equal(evaluate(security,positiveFacts(security)),"ALLOW_DEFINITION_CASE");

  const exactlyOnce=rules.get("MPSEM-0378-C005");
  assert.equal(exactlyOnce.partialCase.effectOutcome.disposition,"SUCCEEDED");
  assert.equal(exactlyOnce.partialCase.exactlyOnceClaim,"OMITTED");
  assert.ok(!/Otherwise keep outcome unknown/u.test(exactlyOnce.semanticRule));
  assert.ok(exactlyOnce.prohibitedFacts.some(({meaning})=>meaning==="unknownOutcomeAutomaticallyResubmitted"));
  assert.equal(evaluate(exactlyOnce,positiveFacts(exactlyOnce)),"ALLOW_DEFINITION_CASE");

  const offline=rules.get("MPSEM-0388-C002");
  assert.deepEqual(offline.cacheDispositionVocabulary,["CURRENT_EXACT_SCOPE","ABSENT","EXPIRED","UNKNOWN"]);
  assert.equal(offline.partialCase.connectivity,"DISCONNECTED");
  assert.equal(offline.partialCase.cachedAuthority.disposition,"ABSENT");
  assert.equal(offline.partialCase.cachedAuthority.remoteRevocationCheck,"UNKNOWN");
  assert.equal(offline.partialCase.consequentialWork,"HELD");
  assert.equal(evaluate(offline,positiveFacts(offline)),"ALLOW_DEFINITION_CASE");
});
