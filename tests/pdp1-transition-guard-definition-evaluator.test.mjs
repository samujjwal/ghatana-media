import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { evaluatePdpTransition, transitionGuardFactRequirements } from "../scripts/lib/pdp1-transition-guard-definition-evaluator.mjs";
import { typedObservationRequestFingerprint } from "../scripts/lib/pdp-truth-domain-observation-currentness.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const transitions = readYaml(".product-experience/pdp-1-domain-data/transitions.yaml");
const states = readYaml(".product-experience/pdp-1-domain-data/states.yaml");
const guardContracts = readYaml(".product-experience/pdp-1-domain-data/transition-guard-contracts.yaml");
const allTransitions = [...transitions.transitionRecords, ...transitions.ownerDefinedTransitionRecords];
const byId = new Map(guardContracts.records.map((record) => [record.transitionId, record]));
const operationSource = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");
const rightsContract = operationSource.ownerTypedObservationContracts.records.find(({ id }) => id === "media.observation-contract.rights-decision.v1");
const consentRevisionContract = operationSource.ownerConsentRevisionObservationContract;
const consentAdapter = readYaml(".product-experience/pdp-3-product-experience/consent-observation-adapter-contracts.yaml");
const rightsAuthority = ".product-experience/pdp-1-domain-data/authority.yaml#ownership.identityAuthenticationAndDelegation";
const consentAuthority = ".product-experience/pdp-1-domain-data/authority.yaml#ownerDefinedPdp10AuthorityScopes/identityScope";

function setConsentRead(facts, decision = "PERMITTED") {
  facts.trustedConsentContext = {
    tenantScopeRef: "tenant-media-a", principalRef: "media.principal/principal-a", subjectArtifactVersionRef: "media.artifact-version/session-7-v4",
    purposeRef: "media.purpose.live-capture", regionRef: "media.region.us", retentionPolicyRef: "media.retention.stream-24h.v1",
    expectedRightsAuthorityRef: rightsAuthority, expectedRightsReadVersion: "rights-read-v8",
    expectedConsentReadAuthorityRef: consentAuthority, expectedConsentReadVersion: "consent-read-v8",
    now: "2026-10-09T12:00:00.000Z", maxAgeMs: 60_000,
    expectedEffects: [{ effectRef: "media.effect.stream-frame.submit", consentId: "consent-record-9", consentRef: "media.consent-reference/consent-9",
      consentRevisionRef: "media.consent-revision/consent-record-9/v9", consentRevisionVersion: 9,
      decisionAuthorityVersionRef: "media.policy-decision/decision-8/v1", externalProcessingRequirement: "NOT_REQUIRED",
      biometricProcessingRequirement: "NOT_REQUIRED" }],
  };
  const rightsRequest = { queryId: "query-rights-1", subjectArtifactVersionRef: facts.trustedConsentContext.subjectArtifactVersionRef,
    decisionKind: "CONSENT", purposeRef: facts.trustedConsentContext.purposeRef, useRef: "media.effect.stream-frame.submit",
    regionRef: facts.trustedConsentContext.regionRef, retentionPolicyRef: facts.trustedConsentContext.retentionPolicyRef };
  const rightsTrusted = { tenantScopeRef: facts.trustedConsentContext.tenantScopeRef, principalRef: facts.trustedConsentContext.principalRef,
    expectedOperationRef: rightsContract.operationRefs[0], expectedReadAuthorityRef: rightsAuthority, expectedReadVersion: "rights-read-v8" };
  const effectDisposition = decision === "PERMITTED" ? "PERMITTED" : decision;
  const observationStatus = decision === "PERMITTED" ? "ALLOWED_FOR_DECLARED_SCOPE" : decision;
  const rightsResult = { tenantScopeRef: rightsTrusted.tenantScopeRef, principalRef: rightsTrusted.principalRef, queryId: rightsRequest.queryId,
    operationRef: rightsContract.operationRefs[0], requestFingerprint: typedObservationRequestFingerprint(rightsRequest, rightsTrusted),
    readAuthorityRef: rightsAuthority, currentness: "CURRENT", decisionKind: "CONSENT", observationStatus,
    observedAt: "2026-10-09T11:59:30.000Z", readVersion: "rights-read-v8",
    decision: { tenantScopeRef: rightsTrusted.tenantScopeRef, principalRef: rightsTrusted.principalRef,
      subjectArtifactVersionRef: rightsRequest.subjectArtifactVersionRef, decisionKind: "CONSENT", purposeRef: rightsRequest.purposeRef,
      useRef: rightsRequest.useRef, regionRef: rightsRequest.regionRef, retentionPolicyRef: rightsRequest.retentionPolicyRef,
      authorityRef: rightsAuthority, authorityVersionRef: "media.policy-decision/decision-8/v1", effectDisposition,
      validFrom: "2026-10-09T11:00:00.000Z", validUntil: "2026-10-09T13:00:00.000Z",
      evidenceRefs: ["media.consent-revision/consent-record-9/v9", "media.evidence/decision-8"] } };
  const consentRequest = { queryId: "query-consent-1", consentId: "consent-record-9", purposeRef: facts.trustedConsentContext.purposeRef };
  const consentTrusted = { tenantScopeRef: facts.trustedConsentContext.tenantScopeRef, principalRef: facts.trustedConsentContext.principalRef,
    expectedOperationRef: consentRevisionContract.operationRef, expectedReadAuthorityRef: consentAuthority, expectedReadVersion: "consent-read-v8" };
  const consentResult = { queryId: consentRequest.queryId, requestFingerprint: typedObservationRequestFingerprint(consentRequest, consentTrusted),
    operationRef: consentRevisionContract.operationRef, readAuthorityRef: consentAuthority, currentness: "CURRENT",
    readVersion: "consent-read-v8", observedAt: "2026-10-09T11:59:30.000Z",
    outcome: { kind: "OBSERVED_CONSENT_REVISION", consentId: "consent-record-9", consentRef: "media.consent-reference/consent-9",
      consentRevisionRef: "media.consent-revision/consent-record-9/v9", tenantScopeRef: consentTrusted.tenantScopeRef,
      principalRef: consentTrusted.principalRef, purposes: [facts.trustedConsentContext.purposeRef], allowedRegions: [facts.trustedConsentContext.regionRef],
      externalProcessingAllowed: true, biometricProcessingAllowed: false, status: "ACTIVE", authorityRef: rightsAuthority,
      evidenceRef: "media.evidence/consent-9", grantedAt: "2026-10-09T11:00:00.000Z", expiresAt: "2026-10-09T13:00:00.000Z", revokedAt: null, version: 9 } };
  facts.typedOwnerFacts = { consentPerEffectCurrent: { effectReads: [{ rightsRequest, rightsResult, consentRequest, consentResult }] } };
}

function allFactsTrue(expression, guardFacts = {}) {
  if (expression.fact) {
    if (expression.fact === "tenant.matches") return;
    guardFacts[expression.fact] = true;
  } else if (expression.all || expression.any) {
    (expression.all ?? expression.any).forEach((child) => allFactsTrue(child, guardFacts));
  } else if (expression.not) {
    // The base positive fixture intentionally leaves the negated fact false.
  }
  return guardFacts;
}
function fixture(edge) {
  const guardFacts = allFactsTrue(edge.when, {});
  const needsVersionConflict = JSON.stringify(edge.when).includes('"expectedVersionConflicts"');
  delete guardFacts.expectedVersionMatches;
  delete guardFacts.expectedVersionConflicts;
  delete guardFacts.consentPerEffectCurrent;
  const facts = {
    tenant: { requestTenantId: "tenant-media-a", resourceTenantId: "tenant-media-a" },
    version: { expected: "head-v7", current: needsVersionConflict ? "head-v6" : "head-v7" },
    guardFacts,
  };
  setConsentRead(facts);
  return facts;
}
function evaluate(id, from, to, facts) {
  return evaluatePdpTransition({ transitions, states, guardContracts, transitionId: id, from, to, facts });
}
function makePredicateFalse(facts, id) {
  if (id === "expectedVersionMatches") facts.version.current = "stale-head";
  else if (id === "expectedVersionConflicts") facts.version.current = facts.version.expected;
  else if (id === "consentPerEffectCurrent") setConsentRead(facts, "DENIED");
  else facts.guardFacts[id] = false;
}
function removePredicate(facts, id) {
  if (id === "expectedVersionMatches" || id === "expectedVersionConflicts") delete facts.version;
  else if (id === "consentPerEffectCurrent") delete facts.typedOwnerFacts;
  else delete facts.guardFacts[id];
}
function mandatoryPredicateIds(expression) {
  const ids = new Set();
  const walk = (node, optional = false) => {
    if (node.fact) { if (!optional) ids.add(node.fact); return; }
    if (node.all) node.all.forEach((child) => walk(child, optional));
    if (node.any) node.any.forEach((child) => walk(child, true));
    if (node.not) walk(node.not, true);
  };
  walk(expression);
  return [...ids];
}

test("all 55 transition identities bind typed, source-current, explicit edge contracts", () => {
  assert.equal(transitions.transitionRecords.length, 49, "preserve historical transition population");
  assert.equal(transitions.ownerDefinedTransitionRecords.length, 6, "include owner-defined rights and consent transitions");
  assert.equal(guardContracts.records.length, 55);
  assert.equal(byId.size, 55, "every transition identity has one unique guard contract");
  const contractIds = guardContracts.records.map(({ id }) => id);
  assert.equal(new Set(contractIds).size, 55, "each typed guard record has a stable normative identity");
  assert.ok(contractIds.every((id) => id.startsWith("media.transition-guard-contract.")));
  for (const transition of allTransitions) {
    const contract = byId.get(transition.id);
    assert.ok(contract, `${transition.id} has an exact contract`);
    assert.equal(contract.sourceMachineId, transition.sourceMachineId);
    assert.equal(contract.sourceGuard, transition.ownerGuardDefinition ?? transition.sourceGuard);
    assert.ok(contract.edgeRules.length > 0, `${transition.id} enumerates explicit allowed edges`);
    for (const edge of contract.edgeRules) {
      const result = evaluate(transition.id, edge.from, edge.to, fixture(edge));
      assert.equal(result.allowed, true, `${transition.id} ${edge.from} -> ${edge.to}: ${result.reasonCodes.join(",")}`);
      assert.ok(transition.from.includes(edge.from) && transition.to.includes(edge.to));
    }
    for (const from of transition.from) for (const to of transition.to) {
      assert.equal(contract.edgeRules.some((edge) => edge.from === from && edge.to === to), true,
        `${transition.id} source relation ${from} -> ${to} has an exact edge contract`);
    }
    const unknownEdge = evaluate(transition.id, transition.from[0], "__UNDECLARED_STATE__", fixture(contract.edgeRules[0]));
    assert.deepEqual(unknownEdge.reasonCodes, ["EDGE_NOT_EXPLICITLY_DEFINED"]);
  }
});

test("each edge fails when its material positive predicate is missing or false", () => {
  let negativeCount = 0;
  for (const transition of allTransitions) {
    const contract = byId.get(transition.id);
    for (const edge of contract.edgeRules) {
      const allIds = transitionGuardFactRequirements({ edgeRules: [edge] }).filter((id) => id !== "tenant.matches");
      const ids = mandatoryPredicateIds(edge.when).filter((id) => id !== "tenant.matches");
      for (const id of ids) {
        const facts = fixture(edge);
        makePredicateFalse(facts, id);
        const result = evaluate(transition.id, edge.from, edge.to, facts);
        assert.equal(result.allowed, false, `${transition.id} ${edge.from}->${edge.to} must reject ${id}`);
        assert.ok(result.reasonCodes.length > 0);
        negativeCount += 1;
      }
      const missing = fixture(edge);
      for (const id of ids) removePredicate(missing, id);
      assert.equal(evaluate(transition.id, edge.from, edge.to, missing).allowed, false,
        `${transition.id} missing facts fail closed`);
      const noAlternative = fixture(edge);
      for (const id of allIds) makePredicateFalse(noAlternative, id);
      assert.equal(evaluate(transition.id, edge.from, edge.to, noAlternative).allowed, false,
        `${transition.id} with no available any-alternative fails closed`);
    }
  }
  assert.ok(negativeCount > 250, `negative oracle count ${negativeCount}`);
});

test("tenant, compare-and-swap, finality, and consent revocation use concrete fail-closed oracles", () => {
  const versionCommit = "media-project-version/T01";
  const versionEdge = byId.get(versionCommit).edgeRules[0];
  const stale = fixture(versionEdge);
  stale.version.current = "head-v8";
  assert.equal(evaluate(versionCommit, "DRAFT", "COMMITTED", stale).allowed, false);
  const tenantMismatch = fixture(versionEdge);
  tenantMismatch.tenant.resourceTenantId = "tenant-media-b";
  assert.ok(evaluate(versionCommit, "DRAFT", "COMMITTED", tenantMismatch).reasonCodes.includes("TENANT_MISMATCH"));

  const conflictId = "media-project-version/T02";
  const conflict = byId.get(conflictId).edgeRules[0];
  const noConflict = fixture(conflict);
  noConflict.version.current = noConflict.version.expected;
  assert.equal(evaluate(conflictId, "DRAFT", "CONFLICTED", noConflict).allowed, false,
    "a commit conflict edge needs an actual expected/current head mismatch");

  const rightsRevocation = byId.get("media-rights-and-consent/consent/T02");
  const revokeEdge = rightsRevocation.edgeRules.find(({ to }) => to === "REVOKED");
  const revokeFacts = fixture(revokeEdge);
  revokeFacts.guardFacts["consent.revocationRecorded"] = true;
  assert.equal(evaluate(rightsRevocation.transitionId, "ACTIVE", "REVOKED", revokeFacts).allowed, true,
    "authoritative revocation from ACTIVE is not blocked by lack of active consent afterward");
  const missingRevocation = fixture(revokeEdge);
  delete missingRevocation.guardFacts["consent.revocationRecorded"];
  assert.equal(evaluate(rightsRevocation.transitionId, "ACTIVE", "REVOKED", missingRevocation).allowed, false);
  const expiryEdge = rightsRevocation.edgeRules.find(({ to }) => to === "EXPIRED");
  const expiryFacts = fixture(expiryEdge);
  expiryFacts.guardFacts["consent.expiryRecorded"] = true;
  assert.equal(evaluate(rightsRevocation.transitionId, "ACTIVE", "EXPIRED", expiryFacts).allowed, true);
});

test("competing multi-target outcomes require distinct evidence and contradictory classifications fail", () => {
  const holdId = "media-upload-and-artifact/T06";
  const holdContract = byId.get(holdId);
  const proceed = holdContract.edgeRules.find(({ to }) => to === "ACCESS_REVOKED");
  const proceedFacts = fixture(proceed);
  proceedFacts.guardFacts["hold.active"] = true;
  const contradiction = evaluate(holdId, proceed.from, proceed.to, proceedFacts);
  assert.equal(contradiction.allowed, false, "proceeding while also asserting an active hold is contradictory");
  assert.ok(contradiction.reasonCodes.some((reason) => reason.startsWith("CONTRADICTORY_OUTCOME_FACTS:")));
  const blocked = holdContract.edgeRules.find(({ to }) => to === "BLOCKED_BY_HOLD");
  const unknownHold = fixture(blocked);
  delete unknownHold.guardFacts["hold.active"];
  assert.equal(evaluate(holdId, blocked.from, blocked.to, unknownHold).allowed, false,
    "unknown hold applicability cannot be treated as either clear or active");

  const deliveryId = "media-delivery/T04";
  const deliveryContract = byId.get(deliveryId);
  const acknowledged = deliveryContract.edgeRules.find(({ to }) => to === "ACKNOWLEDGED");
  const conflictingDelivery = fixture(acknowledged);
  conflictingDelivery.guardFacts["outcome.media.delivery.failed.supported"] = true;
  const deliveryConflict = evaluate(deliveryId, acknowledged.from, acknowledged.to, conflictingDelivery);
  assert.equal(deliveryConflict.allowed, false, "ACKNOWLEDGED and FAILED cannot be simultaneously asserted for one outcome");
  assert.ok(deliveryConflict.reasonCodes.some((reason) => reason.startsWith("CONTRADICTORY_OUTCOME_FACTS:")));
});

test("unknown predicates, source drift, and malformed ASTs fail closed without runtime effects", () => {
  const record = allTransitions.find(({ id }) => id === "media-job/T04");
  const contract = byId.get(record.id);
  const facts = fixture(contract.edgeRules[0]);
  assert.deepEqual(evaluatePdpTransition({ transitions, states, guardContracts: { records: [] }, transitionId: record.id, from: "OUTCOME_UNKNOWN", to: "RECONCILING", facts }).reasonCodes,
    ["GUARD_CONTRACT_MISSING"]);
  const changedTransitions = structuredClone(transitions);
  changedTransitions.transitionRecords.find(({ id }) => id === record.id).ownerGuardDefinition = "changed-source-guard";
  assert.deepEqual(evaluatePdpTransition({ transitions: changedTransitions, states, guardContracts, transitionId: record.id, from: "OUTCOME_UNKNOWN", to: "RECONCILING", facts }).reasonCodes,
    ["GUARD_CONTRACT_SOURCE_STALE"]);
  const unknownPredicateContracts = structuredClone(guardContracts);
  unknownPredicateContracts.records.find(({ transitionId }) => transitionId === record.id).edgeRules[0].when = { fact: "invented.untypedPredicate" };
  facts.guardFacts["invented.untypedPredicate"] = true;
  assert.ok(evaluatePdpTransition({ transitions, states, guardContracts: unknownPredicateContracts, transitionId: record.id, from: "OUTCOME_UNKNOWN", to: "RECONCILING", facts }).reasonCodes.includes("UNKNOWN_GUARD_FACT:invented.untypedPredicate"));
  const beforeTransitions = structuredClone(transitions);
  const beforeStates = structuredClone(states);
  const result = evaluate(record.id, "OUTCOME_UNKNOWN", "RECONCILING", facts);
  assert.equal(result.allowed, true);
  assert.deepEqual(transitions, beforeTransitions);
  assert.deepEqual(states, beforeStates);
  assert.match(transitions.authorityStatus, /proposal-only/u);
});

test("three-valued NOT and Boolean nodes never turn unknown or malformed predicates into permission", () => {
  const id = "media-job/T04";
  const contract = structuredClone(guardContracts);
  const record = contract.records.find(({ transitionId }) => transitionId === id);
  const edge = record.edgeRules[0];
  contract.facts["test.knownPredicate"] = { description: "test-only mutation predicate", valueType: "boolean", unknown: "deny" };
  const base = fixture(edge);
  base.guardFacts["test.knownPredicate"] = false;
  const evaluateMutation = (when, facts = base) => {
    const mutated = structuredClone(contract);
    mutated.records.find(({ transitionId }) => transitionId === id).edgeRules[0].when = when;
    return evaluatePdpTransition({ transitions, states, guardContracts: mutated, transitionId: id, from: edge.from, to: edge.to, facts });
  };
  assert.equal(evaluateMutation({ all: [{ fact: "tenant.matches" }, { not: { fact: "test.knownPredicate" } }] }).allowed, true,
    "NOT of a known false predicate may pass");
  const missingKnownFact = structuredClone(base);
  delete missingKnownFact.guardFacts["test.knownPredicate"];
  assert.equal(evaluateMutation({ not: { fact: "test.knownPredicate" } }, missingKnownFact).allowed, false,
    "NOT of a missing fact must stay unknown and fail closed");
  assert.ok(evaluateMutation({ not: { fact: "not.in.catalog" } }).reasonCodes.includes("UNKNOWN_GUARD_FACT:not.in.catalog"));
  assert.ok(evaluateMutation({ any: [{ fact: "tenant.matches" }, { inventedOperator: "x" }] }).reasonCodes.includes("UNKNOWN_GUARD_OPERATOR:inventedOperator"),
    "a passing any sibling cannot hide an unknown AST operator");
  for (const when of [{ all: [] }, { any: [] }, { all: [null] }]) {
    assert.equal(evaluateMutation(when).allowed, false, `${JSON.stringify(when)} is invalid`);
  }

  const versionId = "media-project-version/T01";
  const versionEdge = byId.get(versionId).edgeRules[0];
  const nullVersions = fixture(versionEdge);
  nullVersions.version = { expected: null, current: null };
  assert.equal(evaluate(versionId, "DRAFT", "COMMITTED", nullVersions).allowed, false, "null/null is not a valid CAS match");
  const emptyVersions = fixture(versionEdge);
  emptyVersions.version = { expected: "", current: "" };
  assert.equal(evaluate(versionId, "DRAFT", "COMMITTED", emptyVersions).allowed, false, "empty versions are not valid CAS identities");
  const emptyTenant = fixture(versionEdge);
  emptyTenant.tenant.requestTenantId = "";
  assert.equal(evaluate(versionId, "DRAFT", "COMMITTED", emptyTenant).allowed, false, "empty tenant context is unknown, not equal");
  const whitespaceTenant = fixture(versionEdge);
  whitespaceTenant.tenant.requestTenantId = "   ";
  whitespaceTenant.tenant.resourceTenantId = "   ";
  assert.equal(evaluate(versionId, "DRAFT", "COMMITTED", whitespaceTenant).allowed, false, "whitespace-only tenant identity is unknown");
  const whitespaceVersions = fixture(versionEdge);
  whitespaceVersions.version = { expected: " \t", current: " \t" };
  assert.equal(evaluate(versionId, "DRAFT", "COMMITTED", whitespaceVersions).allowed, false, "whitespace-only CAS identities are unknown");

  const consentEdge = byId.get("media-job/T04").edgeRules[0];
  const consentMutation = structuredClone(guardContracts);
  consentMutation.records.find(({ transitionId }) => transitionId === "media-job/T04").edgeRules[0].when = {
    not: { fact: "consentPerEffectCurrent" },
  };
  const unknownConsent = fixture(consentEdge);
  unknownConsent.typedOwnerFacts.consentPerEffectCurrent.effectReads[0].rightsResult.currentness = "UNKNOWN";
  const unknownConsentResult = evaluatePdpTransition({
    transitions,
    states,
    guardContracts: consentMutation,
    transitionId: "media-job/T04",
    from: consentEdge.from,
    to: consentEdge.to,
    facts: unknownConsent,
  });
  assert.equal(unknownConsentResult.allowed, false, "an unknown consent status under NOT must remain unknown and deny");

  const consentFact = guardContracts.facts.consentPerEffectCurrent;
  assert.equal(consentFact.valueType, "boolean", "legacy guard expression remains a Boolean model operand");
  assert.match(consentFact.unknown, /deny/u);
  assert.equal(consentFact.typedEvaluation.adapterContractRef, ".product-experience/pdp-3-product-experience/consent-observation-adapter-contracts.yaml#records/@id=media.pdp3.consent-per-effect-current-read-adapter.v1");
  assert.equal(consentAdapter.records[0].sources.rightsDecisionContractRef, ".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.rights-decision.v1");
  assert.equal(consentAdapter.records[0].sources.consentRevisionContractRef, ".product-experience/pdp-1-domain-data/operations.yaml#ownerConsentRevisionObservationContract");

  const purposeEdgeContract = guardContracts.records.find(({ edgeRules }) => JSON.stringify(edgeRules).includes("consentPerEffectCurrent"));
  const purposeEdge = purposeEdgeContract.edgeRules.find(({ when }) => JSON.stringify(when).includes("consentPerEffectCurrent"));
  const whitespacePurpose = fixture(purposeEdge);
  whitespacePurpose.typedOwnerFacts.consentPerEffectCurrent.effectReads[0].rightsRequest.purposeRef = "  ";
  assert.equal(evaluate(purposeEdgeContract.transitionId, purposeEdge.from, purposeEdge.to, whitespacePurpose).allowed, false,
    "whitespace-only purpose identity is unknown");
});

test("consent guards ignore caller booleans and reject foreign or stale typed per-effect revisions", () => {
  const contract = byId.get("media-stream-session/T02");
  const edge = contract.edgeRules[0];
  const legacyBooleanOnly = fixture(edge);
  delete legacyBooleanOnly.typedOwnerFacts;
  legacyBooleanOnly.consent = { status: "ACTIVE", current: true, tenantId: "tenant-media-a", purposes: ["media.purpose.live-capture"] };
  legacyBooleanOnly.guardFacts.consentPerEffectCurrent = true;
  assert.equal(evaluate(contract.transitionId, edge.from, edge.to, legacyBooleanOnly).allowed, false,
    "legacy ACTIVE/current booleans cannot satisfy a per-effect owner observation guard");

  const foreignRevision = fixture(edge);
  foreignRevision.typedOwnerFacts.consentPerEffectCurrent.effectReads[0].consentResult.outcome.consentRevisionRef = "media.consent-revision/other-session";
  assert.equal(evaluate(contract.transitionId, edge.from, edge.to, foreignRevision).allowed, false,
    "a valid-looking decision for a different consent revision remains unknown/denied");

  const foreignConsent = fixture(edge);
  foreignConsent.typedOwnerFacts.consentPerEffectCurrent.effectReads[0].consentResult.outcome.consentRef = "media.consent-reference/other-session";
  assert.equal(evaluate(contract.transitionId, edge.from, edge.to, foreignConsent).allowed, false,
    "a valid-looking revision for a different canonical consent reference remains unknown/denied");

  const staleRead = fixture(edge);
  staleRead.typedOwnerFacts.consentPerEffectCurrent.effectReads[0].rightsResult.readVersion = "rights-read-v9";
  assert.equal(evaluate(contract.transitionId, edge.from, edge.to, staleRead).allowed, false,
    "a stale or foreign read version cannot establish current per-effect consent");

  const forgedFingerprint = fixture(edge);
  forgedFingerprint.typedOwnerFacts.consentPerEffectCurrent.effectReads[0].rightsResult.requestFingerprint = `sha256:${"f".repeat(64)}`;
  assert.equal(evaluate(contract.transitionId, edge.from, edge.to, forgedFingerprint).allowed, false,
    "a syntactically valid but unrecomputed request fingerprint is rejected");

  const missingExpectedEffects = fixture(edge);
  missingExpectedEffects.trustedConsentContext.expectedEffects = null;
  assert.equal(evaluate(contract.transitionId, edge.from, edge.to, missingExpectedEffects).allowed, false,
    "malformed trusted expected effect sets fail closed without throwing");

  const futureGrant = fixture(edge);
  futureGrant.typedOwnerFacts.consentPerEffectCurrent.effectReads[0].consentResult.outcome.grantedAt = "2026-10-09T13:00:00.000Z";
  assert.equal(evaluate(contract.transitionId, edge.from, edge.to, futureGrant).allowed, false,
    "an ACTIVE label cannot make a future-dated consent grant current");

  const expiredGrant = fixture(edge);
  expiredGrant.typedOwnerFacts.consentPerEffectCurrent.effectReads[0].consentResult.outcome.expiresAt = "2026-10-09T11:00:00.000Z";
  assert.equal(evaluate(contract.transitionId, edge.from, edge.to, expiredGrant).allowed, false,
    "an ACTIVE label cannot override the exact consent expiry time");

  const revokedGrant = fixture(edge);
  revokedGrant.typedOwnerFacts.consentPerEffectCurrent.effectReads[0].consentResult.outcome.revokedAt = "2026-10-09T11:30:00.000Z";
  assert.equal(evaluate(contract.transitionId, edge.from, edge.to, revokedGrant).allowed, false,
    "an ACTIVE label cannot override a recorded consent revocation");

  const requiredExternalDenied = fixture(edge);
  requiredExternalDenied.trustedConsentContext.expectedEffects[0].externalProcessingRequirement = "REQUIRED";
  requiredExternalDenied.typedOwnerFacts.consentPerEffectCurrent.effectReads[0].consentResult.outcome.externalProcessingAllowed = false;
  assert.equal(evaluate(contract.transitionId, edge.from, edge.to, requiredExternalDenied).allowed, false,
    "an effect requiring external processing needs that separately scoped consent permission");

  const unrelatedBiometricPermission = fixture(edge);
  unrelatedBiometricPermission.typedOwnerFacts.consentPerEffectCurrent.effectReads[0].consentResult.outcome.biometricProcessingAllowed = false;
  assert.equal(evaluate(contract.transitionId, edge.from, edge.to, unrelatedBiometricPermission).allowed, true,
    "an unrelated biometric permission does not constrain a non-biometric effect");
});
