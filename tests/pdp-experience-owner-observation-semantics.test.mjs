import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { evaluateOwnerTypedObservation } from "../scripts/lib/media-view-observation-definition.mjs";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats").default;
const ajv = new Ajv2020({ allErrors: true, validateFormats: true, allowUnionTypes: true });
ajv.addKeyword({ keyword: "scalarTypeRef", schemaType: "string", validate: () => true });
addFormats(ajv);
const root = process.cwd();
const predicates = parse(await readFile(resolve(root, ".product-experience/pdp-3-product-experience/view-observation-predicates.yaml"), "utf8")).predicates;
const inputContracts = parse(await readFile(resolve(root, ".product-experience/pdp-3-product-experience/view-observation-input-contracts.yaml"), "utf8")).factSchemas;
const operationDocument = parse(await readFile(resolve(root, ".product-experience/pdp-1-domain-data/operations.yaml"), "utf8"));
const operationContracts = operationDocument.ownerTypedObservationContracts.records;
const queryRef = (id) => `.product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=${id}`;
const get = (id) => predicates.find((row) => row.id === id);
const getFactSchema = (id) => inputContracts.find((row) => row.id === id);
const now = "2026-10-09T12:00:00.000Z";
const fresh = { observedAt: "2026-10-09T11:59:30.000Z", readVersion: "read:v1" };
const expectedRead = (operationRef) => ({
  expectedQueryId: "query:q1", expectedRequestFingerprint: `sha256:${"a".repeat(64)}`,
  expectedOperationRef: operationRef,
  expectedReadAuthorityRef: ".product-experience/pdp-1-domain-data/authority.yaml#ownership.identityAuthenticationAndDelegation",
});
const readReceipt = (operationRef) => ({
  queryId: "query:q1", operationRef, requestFingerprint: `sha256:${"a".repeat(64)}`,
  readAuthorityRef: ".product-experience/pdp-1-domain-data/authority.yaml#ownership.identityAuthenticationAndDelegation",
  currentness: "CURRENT",
});
const baseRightsTrusted = {
  viewRef: "media.view.review-rights-and-consent", tenantScopeRef: "tenant:t1", principalRef: "principal:p1",
  ...expectedRead("media.operation.action.inspect-consent-and-permitted-use"), expectedReadVersion: "read:v1",
  subjectArtifactVersionRef: "artifact-version:a1", purposeRef: "purpose:review", useRef: "use:publish",
  regionRef: "region:us", retentionPolicyRef: "retention:r1", authorityRef: "authority:rights",
  authorityVersionRef: "authority-version:1", now, maxAgeMs: 60_000,
};
function rightsResult(overrides = {}) {
  const decision = {
    tenantScopeRef: baseRightsTrusted.tenantScopeRef, principalRef: baseRightsTrusted.principalRef,
    subjectArtifactVersionRef: baseRightsTrusted.subjectArtifactVersionRef, decisionKind: "RIGHTS",
    purposeRef: baseRightsTrusted.purposeRef, useRef: baseRightsTrusted.useRef, regionRef: baseRightsTrusted.regionRef,
    retentionPolicyRef: baseRightsTrusted.retentionPolicyRef, authorityRef: baseRightsTrusted.authorityRef,
    authorityVersionRef: baseRightsTrusted.authorityVersionRef, effectDisposition: "PENDING_REVIEW",
    validFrom: "2026-10-09T11:00:00.000Z", validUntil: "2026-10-09T13:00:00.000Z", evidenceRefs: ["evidence:rights:1"],
  };
  const base = {
    tenantScopeRef: baseRightsTrusted.tenantScopeRef, principalRef: baseRightsTrusted.principalRef,
    ...readReceipt(baseRightsTrusted.expectedOperationRef), decisionKind: "RIGHTS", observationStatus: "REVIEW_REQUIRED", ...fresh, decision,
  };
  return { ...base, ...overrides };
}
function assertMissingCurrentReadFactsFailClosed(row, fact, trusted) {
  for (const key of ["expectedQueryId", "expectedRequestFingerprint", "expectedOperationRef", "expectedReadAuthorityRef", "expectedReadVersion"]) {
    const without = { ...trusted };
    delete without[key];
    assert.equal(evaluateOwnerTypedObservation(row, fact, without).truth, "UNKNOWN", `missing trusted ${key} cannot support a label`);
  }
}

test("rights observations bind exact decision kind, subject/purpose/use/region/retention, authority version and validity", () => {
  const row = get("media.view-observation.review-rights-and-consent.review-required.v1");
  const contract = operationContracts.find(({ id }) => id === "media.observation-contract.rights-decision.v1");
  const fact = { viewRef: row.viewRef, queryContractRef: queryRef("media.observation-contract.rights-decision.v1"), queryResult: rightsResult() };
  assert.equal(ajv.compile(getFactSchema("media.view-observation-schema.owner-rights-state.v1").closedSchema)(fact), true, "PDP-3 fact schema mirrors the exact owner result tuple");
  assert.equal(ajv.compile(getFactSchema("media.view-observation-schema.owner-rights-state.v1").trustedContextSchema)(baseRightsTrusted), true, "trusted query context requires current-read and request correlation fields");
  assert.equal(ajv.compile(contract.resultSchema)(fact.queryResult), true);
  assert.equal(evaluateOwnerTypedObservation(row, fact, baseRightsTrusted).truth, "TRUE");
  assertMissingCurrentReadFactsFailClosed(row, fact, baseRightsTrusted);
  assert.equal(evaluateOwnerTypedObservation(row, fact, { ...baseRightsTrusted, expectedReadVersion: "read:stale" }).truth, "UNKNOWN");
  assert.equal(evaluateOwnerTypedObservation(row, fact, { ...baseRightsTrusted, subjectArtifactVersionRef: "artifact-version:other" }).truth, "UNKNOWN");
  assert.equal(evaluateOwnerTypedObservation(row, { ...fact, queryResult: rightsResult({ queryId: "query:foreign" }) }, baseRightsTrusted).truth, "UNKNOWN");
  assert.equal(evaluateOwnerTypedObservation(row, { ...fact, queryResult: rightsResult({ requestFingerprint: `sha256:${"b".repeat(64)}` }) }, baseRightsTrusted).truth, "UNKNOWN");
  assert.equal(evaluateOwnerTypedObservation(row, { ...fact, queryResult: rightsResult({ readAuthorityRef: "authority:foreign" }) }, baseRightsTrusted).truth, "UNKNOWN");
  assert.equal(evaluateOwnerTypedObservation(row, { ...fact, queryResult: rightsResult({ currentness: "STALE" }) }, baseRightsTrusted).truth, "UNKNOWN");
  assert.equal(evaluateOwnerTypedObservation(row, { ...fact, queryResult: rightsResult({ decisionKind: "CONSENT" }) }, baseRightsTrusted).truth, "UNKNOWN");
  const expired = rightsResult(); expired.decision.validUntil = "2026-10-09T11:59:00.000Z";
  assert.equal(evaluateOwnerTypedObservation(row, { ...fact, queryResult: expired }, baseRightsTrusted).truth, "UNKNOWN");
  const unknownRow = get("media.view-observation.review-rights-and-consent.unknown.v1");
  const unknownResult = { tenantScopeRef: baseRightsTrusted.tenantScopeRef, principalRef: baseRightsTrusted.principalRef, ...readReceipt(baseRightsTrusted.expectedOperationRef), decisionKind: "RIGHTS", observationStatus: "UNKNOWN", ...fresh, unknownReasonRef: "reason:authority-unavailable" };
  assert.equal(evaluateOwnerTypedObservation(unknownRow, { ...fact, queryResult: unknownResult }, baseRightsTrusted).truth, "TRUE");
  assert.equal(evaluateOwnerTypedObservation(unknownRow, { ...fact, queryResult: { ...unknownResult, decision: rightsResult().decision } }, baseRightsTrusted).truth, "UNKNOWN");
  const rightsContract = operationContracts.find(({ id }) => id === "media.observation-contract.rights-decision.v1");
  for (const [observationStatus, decisionKind, effectDisposition] of [
    ["DENIED", "RIGHTS", "DENIED"], ["RESTRICTED", "RIGHTS", "RESTRICTED"], ["CONSENT_REQUIRED", "CONSENT", "CONSENT_REQUIRED"],
  ]) {
    const expectedRow = structuredClone(row);
    expectedRow.ownerObservationExpectation.expected = { decisionKind, observationStatus, effectDisposition };
    const mapped = rightsResult({ decisionKind, observationStatus });
    mapped.decision = { ...mapped.decision, decisionKind, effectDisposition };
    assert.equal(ajv.compile(rightsContract.resultSchema)(mapped), true, `${observationStatus} has exact source schema mapping`);
    assert.equal(evaluateOwnerTypedObservation(expectedRow, { ...fact, queryResult: mapped }, baseRightsTrusted).truth, "TRUE", `${observationStatus} binds exact non-permitted decision`);
    const mismapped = { ...mapped, decisionKind: "HUMAN_REVIEW_APPROVAL", decision: { ...mapped.decision, decisionKind: "HUMAN_REVIEW_APPROVAL" } };
    assert.equal(ajv.compile(rightsContract.resultSchema)(mismapped), false, `${observationStatus} rejects unrelated authority kind`);
    assert.equal(evaluateOwnerTypedObservation(expectedRow, { ...fact, queryResult: mismapped }, baseRightsTrusted).truth, "UNKNOWN");
  }
  assert.equal(operationContracts.find(({ id }) => id === "media.observation-contract.rights-decision.v1").bindingStatus, "DEFINITION_ONLY_NO_EXISTING_ENDPOINT_OR_RUNTIME_BINDING");
});

test("remaining rights labels bind exact rights, voice, approval and expiry dispositions", () => {
  const contract=operationContracts.find(({id})=>id==="media.observation-contract.rights-decision.v1");
  const cases=[
    ["media.view-observation.work-with-speech.review-required.v1","RIGHTS","REVIEW_REQUIRED","PENDING_REVIEW"],
    ["media.view-observation.use-authorized-voice.review-required.v1","VOICE_AUTHORIZATION","VOICE_AUTHORIZATION_REQUIRED","VOICE_AUTHORIZATION_REQUIRED"],
    ["media.view-observation.edit-media-region.review-required.v1","HUMAN_REVIEW_APPROVAL","APPROVAL_REQUIRED","APPROVAL_REQUIRED"],
    ["media.view-observation.review-exact-version.approval-expired.v1","HUMAN_REVIEW_APPROVAL","EXPIRED","EXPIRED"],
  ];
  for(const [id,decisionKind,observationStatus,effectDisposition] of cases){
    const row=get(id), trusted={...baseRightsTrusted,viewRef:row.viewRef};
    const result=rightsResult({decisionKind,observationStatus});
    result.decision={...result.decision,decisionKind,effectDisposition};
    if(observationStatus==="EXPIRED")result.decision.validUntil="2026-10-09T11:59:00.000Z";
    assert.equal(ajv.compile(contract.resultSchema)(result),true,`${id}: source schema accepts the exact scoped disposition`);
    const fact={viewRef:row.viewRef,queryContractRef:queryRef("media.observation-contract.rights-decision.v1"),queryResult:result};
    assert.equal(evaluateOwnerTypedObservation(row,fact,trusted).truth,"TRUE",`${id}: exact expected decision only`);
    const wrongDecisionKind=decisionKind==="CONSENT"?"RIGHTS":"CONSENT";
    const wrongKind={...result,decisionKind:wrongDecisionKind,decision:{...result.decision,decisionKind:wrongDecisionKind}};
    assert.equal(evaluateOwnerTypedObservation(row,{...fact,queryResult:wrongKind},trusted).truth,"UNKNOWN",`${id}: incompatible authority kind is not coerced`);
  }
});

test("quality observations derive a condition only from exact subject, requested metric and versioned method tuple", () => {
  const row = get("media.view-observation.review-quality.measured.v1");
  const trusted = {
    viewRef: row.viewRef, tenantScopeRef: "tenant:t1", principalRef: "principal:p1", ...expectedRead("media.operation.action.inspect-quality-evidence"), expectedReadVersion: "read:v1", subjectArtifactVersionRef: "artifact-version:a1",
    requestedMetricRefs: ["metric:audio-naturalness"],
    metricRef: "metric:audio-naturalness", modalityRef: "modality:audio", methodRef: "method:human-panel",
    methodVersionRef: "method-version:3", now, maxAgeMs: 60_000,
  };
  const result = {
    tenantScopeRef: trusted.tenantScopeRef, principalRef: trusted.principalRef, subjectArtifactVersionRef: trusted.subjectArtifactVersionRef,
    ...readReceipt(trusted.expectedOperationRef), observationStatus: "OBSERVATIONS_PRESENT", ...fresh,
    observations: [{ metricRef: trusted.metricRef, modalityRef: trusted.modalityRef, methodRef: trusted.methodRef,
      methodVersionRef: trusted.methodVersionRef, applicability: "APPLICABLE", disposition: "PASS", value: 0.8,
      unitRef: "unit:score-0-1", uncertainty: 0.04, evidenceRefs: ["evidence:quality:1"] }],
  };
  assert.equal(ajv.compile(operationContracts.find(({ id }) => id === "media.observation-contract.quality-evidence.v1").resultSchema)(result), true);
  const fact = { viewRef: row.viewRef, queryContractRef: queryRef("media.observation-contract.quality-evidence.v1"), queryResult: result };
  assert.equal(ajv.compile(getFactSchema("media.view-observation-schema.owner-quality-state.v1").closedSchema)(fact), true);
  assert.equal(ajv.compile(getFactSchema("media.view-observation-schema.owner-quality-state.v1").trustedContextSchema)(trusted), true);
  assert.equal(evaluateOwnerTypedObservation(row, fact, trusted).truth, "TRUE");
  assertMissingCurrentReadFactsFailClosed(row, fact, trusted);
  const contractSchema = operationContracts.find(({ id }) => id === "media.observation-contract.quality-evidence.v1").resultSchema;
  const optionalUncertainty = structuredClone(result); delete optionalUncertainty.observations[0].uncertainty;
  assert.equal(ajv.compile(contractSchema)(optionalUncertainty), true, "owner schema permits absent optional uncertainty");
  assert.equal(evaluateOwnerTypedObservation(row, { ...fact, queryResult: optionalUncertainty }, trusted).truth, "TRUE");
  const numericWithoutUnit = structuredClone(result); delete numericWithoutUnit.observations[0].unitRef;
  assert.equal(ajv.compile(contractSchema)(numericWithoutUnit), false, "numeric measurements require units in the source schema");
  assert.equal(evaluateOwnerTypedObservation(row, { ...fact, queryResult: numericWithoutUnit }, trusted).truth, "UNKNOWN");
  const impossibleApplicability = structuredClone(result);
  impossibleApplicability.observations[0].applicability = "NOT_APPLICABLE";
  assert.equal(ajv.compile(contractSchema)(impossibleApplicability), false, "a non-applicable metric cannot pass");
  assert.equal(evaluateOwnerTypedObservation(row, { ...fact, queryResult: impossibleApplicability }, trusted).truth, "UNKNOWN");
  assert.equal(evaluateOwnerTypedObservation(row, fact, { ...trusted, expectedReadVersion: "read:stale" }).truth, "UNKNOWN");
  assert.equal(evaluateOwnerTypedObservation(row, { ...fact, queryResult: { ...result, operationRef: "media.operation.action.search-named-profiles" } }, trusted).truth, "UNKNOWN");
  assert.equal(evaluateOwnerTypedObservation(row, { ...fact, queryResult: { ...result, queryId: "query:foreign" } }, trusted).truth, "UNKNOWN");
  assert.equal(evaluateOwnerTypedObservation(row, fact, { ...trusted, methodVersionRef: "method-version:2" }).truth, "UNKNOWN");
  assert.equal(evaluateOwnerTypedObservation(row, { ...fact, queryResult: { ...result, observations: [{ ...result.observations[0], metricRef: "metric:other" }] } }, trusted).truth, "UNKNOWN");
  assert.equal(evaluateOwnerTypedObservation(row, fact, { ...trusted, now: "2026-10-09T11:00:00.000Z" }).truth, "UNKNOWN");
  const unresolved = get("media.view-observation.edit-captions.language-uncertain.v1");
  assert.equal(evaluateOwnerTypedObservation(unresolved, fact, trusted).truth, "UNKNOWN");
});

test("profile qualification requires exact profile/version/target/domain/provider/scope and current evidence window", () => {
  const row = get("media.view-observation.check-processing-options.qualified.v1");
  const trusted = {
    viewRef: row.viewRef, tenantScopeRef: "tenant:t1", principalRef: "principal:p1", ...expectedRead("media.operation.action.validate-processing-profile"), expectedReadVersion: "read:v1", profileRef: "profile:p1",
    profileVersionRef: "profile-version:2", targetRef: "target:audio", domainRef: "domain:transcription",
    providerRef: "provider:local", scopeRef: "scope:tenant", now, maxAgeMs: 60_000,
  };
  const result = {
    tenantScopeRef: trusted.tenantScopeRef, principalRef: trusted.principalRef, profileRef: trusted.profileRef,
    ...readReceipt(trusted.expectedOperationRef),
    profileVersionRef: trusted.profileVersionRef, targetRef: trusted.targetRef, domainRef: trusted.domainRef,
    providerRef: trusted.providerRef, scopeRef: trusted.scopeRef, qualificationStatus: "QUALIFIED",
    qualificationRecordRef: "qualification-record:q1", validFrom: "2026-10-09T11:00:00.000Z",
    validUntil: "2026-10-09T13:00:00.000Z", evidenceRefs: ["evidence:qualification:1"], ...fresh,
  };
  assert.equal(ajv.compile(operationContracts.find(({ id }) => id === "media.observation-contract.profile-qualification.v1").resultSchema)(result), true);
  const fact = { viewRef: row.viewRef, queryContractRef: queryRef("media.observation-contract.profile-qualification.v1"), queryResult: result };
  assert.equal(ajv.compile(getFactSchema("media.view-observation-schema.owner-profile-state.v1").closedSchema)(fact), true);
  assert.equal(ajv.compile(getFactSchema("media.view-observation-schema.owner-profile-state.v1").trustedContextSchema)(trusted), true);
  assert.equal(evaluateOwnerTypedObservation(row, fact, trusted).truth, "TRUE");
  assertMissingCurrentReadFactsFailClosed(row, fact, trusted);
  assert.equal(evaluateOwnerTypedObservation(row, fact, { ...trusted, expectedReadVersion: "read:stale" }).truth, "UNKNOWN");
  assert.equal(evaluateOwnerTypedObservation(row, fact, { ...trusted, providerRef: "provider:other" }).truth, "UNKNOWN");
  assert.equal(evaluateOwnerTypedObservation(row, { ...fact, queryResult: { ...result, requestFingerprint: `sha256:${"b".repeat(64)}` } }, trusted).truth, "UNKNOWN");
  assert.equal(evaluateOwnerTypedObservation(row, { ...fact, queryResult: { ...result, readAuthorityRef: "authority:foreign" } }, trusted).truth, "UNKNOWN");
  assert.equal(evaluateOwnerTypedObservation(row, { ...fact, queryResult: { ...result, validUntil: "2026-10-09T11:59:00.000Z" } }, trusted).truth, "UNKNOWN");
  assert.equal(evaluateOwnerTypedObservation(row, { ...fact, queryResult: { ...result, qualificationStatus: "OWNER_REVIEW_REQUIRED" } }, trusted).truth, "FALSE");
});

test("unqualified profile labels require exact profile-version, target, domain, provider and scope tuples",()=>{
  const contract=operationContracts.find(({id})=>id==="media.observation-contract.profile-qualification.v1");
  const cases=[
    "media.view-observation.compose-scene.binding-unqualified.v1",
    "media.view-observation.explore-simulation.unqualified-domain.v1",
    "media.view-observation.choose-eligible-processing-option.profile-unqualified.v1",
  ];
  for(const id of cases){
    const row=get(id), trusted={
      viewRef:row.viewRef,tenantScopeRef:"tenant:t1",principalRef:"principal:p1",
      ...expectedRead("media.operation.action.validate-processing-profile"),expectedReadVersion:"read:v1",
      profileRef:"profile:p1",profileVersionRef:"profile-version:2",targetRef:"target:media-operation",
      domainRef:"domain:media",providerRef:"provider:local",scopeRef:"scope:tenant",now,maxAgeMs:60_000,
    };
    const result={tenantScopeRef:trusted.tenantScopeRef,principalRef:trusted.principalRef,...readReceipt(trusted.expectedOperationRef),
      profileRef:trusted.profileRef,profileVersionRef:trusted.profileVersionRef,targetRef:trusted.targetRef,domainRef:trusted.domainRef,
      providerRef:trusted.providerRef,scopeRef:trusted.scopeRef,qualificationStatus:"UNQUALIFIED",
      qualificationRecordRef:"qualification-record:unqualified",validFrom:"2026-10-09T11:00:00.000Z",
      validUntil:"2026-10-09T13:00:00.000Z",evidenceRefs:["evidence:profile:unqualified"],...fresh};
    const fact={viewRef:row.viewRef,queryContractRef:queryRef("media.observation-contract.profile-qualification.v1"),queryResult:result};
    assert.equal(ajv.compile(contract.resultSchema)(result),true,`${id}: profile record has an exact typed unqualified status`);
    assert.equal(evaluateOwnerTypedObservation(row,fact,trusted).truth,"TRUE",`${id}: exact tuple is required`);
    assert.equal(evaluateOwnerTypedObservation(row,fact,{...trusted,domainRef:"domain:other"}).truth,"UNKNOWN",`${id}: a foreign domain cannot support the label`);
    assert.equal(evaluateOwnerTypedObservation(row,{...fact,queryResult:{...result,qualificationStatus:"QUALIFIED"}},trusted).truth,"FALSE",`${id}: qualified status contradicts the label`);
  }
});

test("dubbing timing and synchronization labels use the exact AV-sync metric and never infer a failed measurement",()=>{
  const contract=operationContracts.find(({id})=>id==="media.observation-contract.quality-evidence.v1");
  for(const [id,condition] of [
    ["media.view-observation.review-dubbing.timing-incomplete.v1","NO_OBSERVATIONS"],
    ["media.view-observation.review-dubbing.sync-review-required.v1","PARTIAL_OR_ABSTAINED_EVIDENCE"],
  ]){
    const row=get(id), metricRef="QUALITY-METRIC-VIDEO-LIP-AV-SYNC";
    const trusted={viewRef:row.viewRef,tenantScopeRef:"tenant:t1",principalRef:"principal:p1",
      ...expectedRead("media.operation.action.inspect-quality-evidence"),expectedReadVersion:"read:v1",
      subjectArtifactVersionRef:"artifact-version:dubbed",requestedMetricRefs:[metricRef],metricRef,
      modalityRef:"modality:audio-video",methodRef:"method:sync-measurement",methodVersionRef:"method-version:1",
      now,maxAgeMs:60_000};
    const observations=condition==="NO_OBSERVATIONS"?[]:[{metricRef,modalityRef:trusted.modalityRef,methodRef:trusted.methodRef,
      methodVersionRef:trusted.methodVersionRef,applicability:"APPLICABLE",disposition:"INDETERMINATE",
      evidenceRefs:["evidence:av-sync:1"]}];
    const result={tenantScopeRef:trusted.tenantScopeRef,principalRef:trusted.principalRef,
      subjectArtifactVersionRef:trusted.subjectArtifactVersionRef,...readReceipt(trusted.expectedOperationRef),
      observationStatus:observations.length?"OBSERVATIONS_PRESENT":"NO_OBSERVATIONS",...fresh,observations};
    const fact={viewRef:row.viewRef,queryContractRef:queryRef("media.observation-contract.quality-evidence.v1"),queryResult:result};
    assert.equal(ajv.compile(contract.resultSchema)(result),true,`${id}: exact AV-sync query result schema`);
    assert.equal(evaluateOwnerTypedObservation(row,fact,trusted).truth,"TRUE",`${id}: condition is sourced from the exact AV-sync metric`);
    assert.equal(evaluateOwnerTypedObservation(row,fact,{...trusted,requestedMetricRefs:[metricRef,"metric:other"]}).truth,"UNKNOWN",`${id}: broader query cannot prove exact timing disposition`);
    assert.equal(evaluateOwnerTypedObservation(row,{...fact,queryResult:{...result,subjectArtifactVersionRef:"artifact-version:other"}},trusted).truth,"UNKNOWN");
  }
});

test("declared options bind the exact requested declaration tuple and keep compatibility separate",()=>{
  const row=get("media.view-observation.check-processing-options.declared.v1");
  const id="media.observation-contract.declared-options.v1", contract=operationContracts.find(({id: candidate})=>candidate===id);
  assert.ok(contract);
  const trusted={viewRef:row.viewRef,tenantScopeRef:"tenant:t1",principalRef:"principal:p1",...expectedRead(contract.operationRefs[0]),expectedReadVersion:"read:v1",
    capabilityRef:"media.capability.transcribe",profileRef:"profile-version:en-v2",dimensionRefs:["dimension:language"],now,maxAgeMs:60_000};
  const request={queryId:trusted.expectedQueryId,capabilityRef:trusted.capabilityRef,operationRef:trusted.expectedOperationRef,profileRef:trusted.profileRef,dimensionRefs:trusted.dimensionRefs};
  const result={tenantScopeRef:trusted.tenantScopeRef,principalRef:trusted.principalRef,...readReceipt(trusted.expectedOperationRef),capabilityRef:trusted.capabilityRef,profileRef:trusted.profileRef,
    declarationDisposition:"DECLARED",compatibility:"UNKNOWN",dimensionResults:[{dimensionRef:"dimension:language",disposition:"UNKNOWN",reasonRef:"reason:awaiting-method",evidenceRefs:["evidence:declared-profile"]}],...fresh};
  const fact={viewRef:row.viewRef,queryContractRef:queryRef(id),queryRequest:request,queryResult:result};
  assert.equal(ajv.compile(contract.requestSchema)(request),true);
  assert.equal(ajv.compile(contract.resultSchema)(result),true);
  assert.equal(evaluateOwnerTypedObservation(row,fact,trusted).truth,"TRUE","an exact declaration stays distinct from unknown compatibility");
  const absent={...result,declarationDisposition:"NOT_DECLARED"};
  assert.equal(ajv.compile(contract.resultSchema)(absent),true);
  assert.equal(evaluateOwnerTypedObservation(row,{...fact,queryResult:absent},trusted).truth,"FALSE");
  assert.equal(evaluateOwnerTypedObservation(row,{...fact,queryRequest:{...request,profileRef:"profile-version:foreign"}},trusted).truth,"UNKNOWN");
  assert.equal(evaluateOwnerTypedObservation(row,{...fact,queryResult:{...result,dimensionResults:[{...result.dimensionResults[0],dimensionRef:"dimension:other"}]}},trusted).truth,"UNKNOWN");
  assert.equal(evaluateOwnerTypedObservation(row,fact,{...trusted,expectedReadVersion:"read:stale"}).truth,"UNKNOWN");
  assert.equal(evaluateOwnerTypedObservation(row,{...fact,queryResult:{...result,currentness:"STALE"}},trusted).truth,"UNKNOWN");
});

test("quality recommendation and repair-plan labels use complete exact-scope assessment records only",()=>{
  const contractId="media.observation-contract.quality-action-plan.v1", contract=operationContracts.find(({id})=>id===contractId);
  const make= (id, requestedKind) => {
    const row=get(id), trusted={viewRef:row.viewRef,tenantScopeRef:"tenant:t1",principalRef:"principal:p1",...expectedRead(contract.operationRefs[0]),expectedReadVersion:"read:v1",
      subjectArtifactVersionRef:"artifact-version:master-v2",purposeRef:"purpose:review-quality",scopeRef:"scope:audio-naturalness",requestedKinds:[requestedKind],now,maxAgeMs:60_000};
    const request={queryId:trusted.expectedQueryId,subjectArtifactVersionRef:trusted.subjectArtifactVersionRef,purposeRef:trusted.purposeRef,scopeRef:trusted.scopeRef,requestedKinds:trusted.requestedKinds};
    const result={tenantScopeRef:trusted.tenantScopeRef,principalRef:trusted.principalRef,...readReceipt(trusted.expectedOperationRef),subjectArtifactVersionRef:trusted.subjectArtifactVersionRef,purposeRef:trusted.purposeRef,scopeRef:trusted.scopeRef,
      assessmentCoverage:"COMPLETE",coveredKinds:trusted.requestedKinds,assessments:[],...fresh};
    return {row,trusted,request,result,fact:{viewRef:row.viewRef,queryContractRef:queryRef(contractId),queryRequest:request,queryResult:result}};
  };
  const recommendation=make("media.view-observation.review-quality.recommendation-only.v1","RECOMMENDATION");
  const rec={kind:"RECOMMENDATION",subjectArtifactVersionRef:recommendation.trusted.subjectArtifactVersionRef,queryId:recommendation.trusted.expectedQueryId,requestFingerprint:recommendation.trusted.expectedRequestFingerprint,
    purposeRef:recommendation.trusted.purposeRef,scopeRef:recommendation.trusted.scopeRef,methodRef:"method:quality-review",methodVersionRef:"method-version:3",validationDisposition:"PROPOSAL_ONLY",evidenceRefs:["evidence:quality:1"]};
  recommendation.result.assessments=[rec];
  assert.equal(ajv.compile(contract.requestSchema)(recommendation.request),true);
  assert.equal(ajv.compile(contract.resultSchema)(recommendation.result),true);
  assert.equal(evaluateOwnerTypedObservation(recommendation.row,recommendation.fact,recommendation.trusted).truth,"TRUE");
  assert.equal(evaluateOwnerTypedObservation(recommendation.row,{...recommendation.fact,queryResult:{...recommendation.result,assessments:[]}},recommendation.trusted).truth,"FALSE","complete empty coverage is a negative, not missing evidence");
  assert.equal(evaluateOwnerTypedObservation(recommendation.row,{...recommendation.fact,queryResult:{...recommendation.result,assessmentCoverage:"PARTIAL"}},recommendation.trusted).truth,"UNKNOWN");
  assert.equal(evaluateOwnerTypedObservation(recommendation.row,{...recommendation.fact,queryResult:{...recommendation.result,assessments:[{...rec,scopeRef:"scope:foreign"}]}},recommendation.trusted).truth,"UNKNOWN");

  const repair=make("media.view-observation.review-quality.repair-plan-ready.v1","BOUNDED_REPAIR_PLAN");
  const plan={...rec,kind:"BOUNDED_REPAIR_PLAN",validationDisposition:"DEFINITION_VALIDATED",proposedActionRefs:["media.action.normalize-audio"],resourceBudgetRef:"budget:resources:v1",costBudgetRef:"budget:cost:v1",preservationGuarantees:["SOURCE_VERSION_UNCHANGED","NO_SILENT_FALLBACK"]};
  repair.result.assessments=[plan];
  assert.equal(ajv.compile(contract.requestSchema)(repair.request),true);
  assert.equal(ajv.compile(contract.resultSchema)(repair.result),true);
  const ready=evaluateOwnerTypedObservation(repair.row,repair.fact,repair.trusted);
  assert.equal(ready.truth,"TRUE");
  assert.equal(ready.effect,"NONE");
  assert.equal(ready.executionApproval,"NOT_ESTABLISHED");
  assert.equal(ready.runtimeObservation,"UNKNOWN_UNTIL_QUERY_IMPLEMENTED");
  assert.equal(evaluateOwnerTypedObservation(repair.row,{...repair.fact,queryResult:{...repair.result,assessments:[{...plan,validationDisposition:"PROPOSAL_ONLY"}]}},repair.trusted).truth,"FALSE");
  assert.equal(evaluateOwnerTypedObservation(repair.row,{...repair.fact,queryResult:{...repair.result,assessments:[{...plan,subjectArtifactVersionRef:"artifact-version:other"}]}},repair.trusted).truth,"UNKNOWN");
  assert.equal(evaluateOwnerTypedObservation(repair.row,{...repair.fact,queryResult:{...repair.result,assessments:[{...plan,purposeRef:"purpose:foreign"}]}},repair.trusted).truth,"UNKNOWN");
  assert.equal(evaluateOwnerTypedObservation(repair.row,{...repair.fact,queryResult:{...repair.result,assessments:[{...plan,kind:"RECOMMENDATION"}]}},repair.trusted).truth,"UNKNOWN","an unrequested assessment kind cannot satisfy a repair-plan request");
  assert.equal(evaluateOwnerTypedObservation(repair.row,{...repair.fact,queryResult:{...repair.result,assessments:[(({proposedActionRefs,...without})=>without)(plan)]}},repair.trusted).truth,"UNKNOWN","a ready plan requires action bounds");
  assert.equal(evaluateOwnerTypedObservation(repair.row,{...repair.fact,queryResult:{...repair.result,assessments:[{...plan,profileRef:"profile:v1"}]}},repair.trusted).truth,"UNKNOWN","profile version refs must be paired");
  assert.equal(evaluateOwnerTypedObservation(repair.row,{...repair.fact,queryResult:{...repair.result,currentness:"UNKNOWN"}},repair.trusted).truth,"UNKNOWN");
});

test("language uncertainty is versioned and method-evidenced without a numeric confidence threshold",()=>{
  const contractId="media.observation-contract.language-uncertainty.v1", contract=operationContracts.find(({id})=>id===contractId);
  for(const [id,contentKind,versionRef] of [
    ["media.view-observation.edit-captions.language-uncertain.v1","CAPTION_TEXT","caption-version:captions-v3"],
    ["media.view-observation.review-transcript.language-uncertain.v1","TRANSCRIPT_TEXT","transcript-version:transcript-v4"],
  ]){
    const row=get(id), trusted={viewRef:row.viewRef,tenantScopeRef:"tenant:t1",principalRef:"principal:p1",...expectedRead(contract.operationRefs[0]),expectedReadVersion:"read:v1",
      subjectArtifactVersionRef:versionRef,contentKind,declaredLanguageTag:"en-US",purposeRef:"purpose:caption-quality",now,maxAgeMs:60_000};
    const request={queryId:trusted.expectedQueryId,subjectArtifactVersionRef:versionRef,contentKind,declaredLanguageTag:trusted.declaredLanguageTag,purposeRef:trusted.purposeRef};
    const result={tenantScopeRef:trusted.tenantScopeRef,principalRef:trusted.principalRef,...readReceipt(trusted.expectedOperationRef),subjectArtifactVersionRef:versionRef,contentKind,declaredLanguageTag:"en-US",purposeRef:trusted.purposeRef,observedLanguageTag:"es-ES",languageSource:"OBSERVED_METHOD",
      uncertaintyDisposition:"UNCERTAIN",uncertaintyReasonRefs:["reason:language-disagreement"],methodRef:"method:language-identification",methodVersionRef:"method-version:2",evidenceRefs:["evidence:language:1"],...fresh};
    const fact={viewRef:row.viewRef,queryContractRef:queryRef(contractId),queryRequest:request,queryResult:result};
    assert.equal(ajv.compile(contract.requestSchema)(request),true);
    assert.equal(ajv.compile(contract.resultSchema)(result),true);
    assert.equal(evaluateOwnerTypedObservation(row,fact,trusted).truth,"TRUE",`${id}: exact source reports uncertainty`);
    assert.equal(evaluateOwnerTypedObservation(row,{...fact,queryResult:{...result,uncertaintyDisposition:"NOT_UNCERTAIN"}},trusted).truth,"FALSE",`${id}: exact contrary disposition is a negative`);
    assert.equal(evaluateOwnerTypedObservation(row,{...fact,queryResult:{...result,subjectArtifactVersionRef:"artifact-version:other"}},trusted).truth,"UNKNOWN");
    assert.equal(evaluateOwnerTypedObservation(row,{...fact,queryResult:{...result,purposeRef:"purpose:foreign"}},trusted).truth,"UNKNOWN","purpose must be echoed and source-bound");
    assert.equal(evaluateOwnerTypedObservation(row,{...fact,queryResult:{...result,evidenceRefs:[]}},trusted).truth,"UNKNOWN");
    assert.equal(evaluateOwnerTypedObservation(row,{...fact,queryResult:{...result,uncertaintyDisposition:"UNKNOWN",unknownReasonRef:"reason:no-method"}},trusted).truth,"UNKNOWN");
    assert.equal(evaluateOwnerTypedObservation(row,fact,{...trusted,expectedReadVersion:"read:stale"}).truth,"UNKNOWN");
  }
});

test("provenance observations bind requested relation coverage and exact subject version without inferring global completeness", () => {
  const row = get("media.view-observation.inspect-provenance.complete-lineage.v1");
  const trusted = {
    viewRef: row.viewRef, tenantScopeRef: "tenant:t1", principalRef: "principal:p1",
    ...expectedRead("media.operation-slice.inspect-provenance"), expectedReadVersion: "read:v1",
    subjectArtifactVersionRef: "artifact-version:subject", requestedRelationKinds: ["DERIVED_FROM"], now, maxAgeMs: 60_000,
  };
  const result = {
    tenantScopeRef: trusted.tenantScopeRef, principalRef: trusted.principalRef, subjectArtifactVersionRef: trusted.subjectArtifactVersionRef,
    ...readReceipt(trusted.expectedOperationRef),
    observationStatus: "OBSERVED", completeness: "COMPLETE_FOR_REQUESTED_RELATIONS", accessDisposition: "FULL",
    traversedRelationKinds: ["DERIVED_FROM"], ...fresh,
    lineageEdges: [{ tenantScopeRef: trusted.tenantScopeRef, fromArtifactVersionRef: "artifact-version:source",
      toArtifactVersionRef: trusted.subjectArtifactVersionRef, relationKind: "DERIVED_FROM", sourceRecordRef: "lineage:1", edgeDisposition: "VERIFIED" }],
  };
  assert.equal(ajv.compile(operationContracts.find(({ id }) => id === "media.observation-contract.provenance-completeness.v1").resultSchema)(result), true);
  const fact = { viewRef: row.viewRef, queryContractRef: queryRef("media.observation-contract.provenance-completeness.v1"), queryResult: result };
  assert.equal(ajv.compile(getFactSchema("media.view-observation-schema.owner-provenance-state.v1").closedSchema)(fact), true);
  assert.equal(ajv.compile(getFactSchema("media.view-observation-schema.owner-provenance-state.v1").trustedContextSchema)(trusted), true);
  assert.equal(evaluateOwnerTypedObservation(row, fact, trusted).truth, "TRUE");
  assertMissingCurrentReadFactsFailClosed(row, fact, trusted);
  assert.equal(evaluateOwnerTypedObservation(row, fact, { ...trusted, expectedReadVersion: "read:stale" }).truth, "UNKNOWN");
  assert.equal(evaluateOwnerTypedObservation(row, { ...fact, queryResult: { ...result, currentness: "UNKNOWN" } }, trusted).truth, "UNKNOWN");
  assert.equal(evaluateOwnerTypedObservation(row, { ...fact, queryResult: { ...result, operationRef: "media.operation.action.inspect-quality-evidence" } }, trusted).truth, "UNKNOWN");
  assert.equal(evaluateOwnerTypedObservation(row, { ...fact, queryResult: { ...result, completeness: "PARTIAL" } }, trusted).truth, "FALSE");
  assert.equal(evaluateOwnerTypedObservation(row, { ...fact, queryResult: { ...result, subjectArtifactVersionRef: "artifact-version:other" } }, trusted).truth, "UNKNOWN");
  assert.equal(evaluateOwnerTypedObservation(row, { ...fact, queryResult: { ...result, lineageEdges: [{ ...result.lineageEdges[0], tenantScopeRef: "tenant:other" }] } }, trusted).truth, "UNKNOWN");
  assert.equal(evaluateOwnerTypedObservation(row, { ...fact, queryResult: { ...result, traversedRelationKinds: ["DERIVED_FROM", "EXECUTED_BY"] } }, trusted).truth, "UNKNOWN");
});
