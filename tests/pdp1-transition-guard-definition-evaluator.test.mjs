import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { evaluatePdpTransition, transitionGuardFactRequirements } from "../scripts/lib/pdp1-transition-guard-definition-evaluator.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const transitions = readYaml(".product-experience/pdp-1-domain-data/transitions.yaml");
const states = readYaml(".product-experience/pdp-1-domain-data/states.yaml");
const guardContracts = readYaml(".product-experience/pdp-1-domain-data/transition-guard-contracts.yaml");
const allTransitions = [...transitions.transitionRecords, ...transitions.ownerDefinedTransitionRecords];
const byId = new Map(guardContracts.records.map((record) => [record.transitionId, record]));

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
  return {
    tenant: { requestTenantId: "tenant-media-a", resourceTenantId: "tenant-media-a" },
    version: { expected: "head-v7", current: needsVersionConflict ? "head-v6" : "head-v7" },
    consent: { status: "ACTIVE", current: true, tenantId: "tenant-media-a", purposes: ["media.process"] },
    purpose: "media.process",
    guardFacts,
  };
}
function evaluate(id, from, to, facts) {
  return evaluatePdpTransition({ transitions, states, guardContracts, transitionId: id, from, to, facts });
}
function makePredicateFalse(facts, id) {
  if (id === "expectedVersionMatches") facts.version.current = "stale-head";
  else if (id === "expectedVersionConflicts") facts.version.current = facts.version.expected;
  else if (id === "consentPerEffectCurrent") {
    facts.consent.status = "REVOKED";
    facts.consent.current = false;
  } else facts.guardFacts[id] = false;
}
function removePredicate(facts, id) {
  if (id === "expectedVersionMatches" || id === "expectedVersionConflicts") delete facts.version;
  else if (id === "consentPerEffectCurrent") delete facts.consent;
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
  unknownConsent.consent.status = "BOGUS";
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
  const consentStates = states.stateMachines.find(({ machineId }) => machineId === "media-rights-and-consent")
    .stateDefinitionsByDimension.consent.map(({ id }) => id);
  assert.deepEqual(consentFact.recognizedStatuses, consentStates, "consent guard status vocabulary matches the canonical consent state definition");

  const purposeEdgeContract = guardContracts.records.find(({ edgeRules }) => JSON.stringify(edgeRules).includes("consentPerEffectCurrent"));
  const purposeEdge = purposeEdgeContract.edgeRules.find(({ when }) => JSON.stringify(when).includes("consentPerEffectCurrent"));
  const whitespacePurpose = fixture(purposeEdge);
  whitespacePurpose.purpose = "  ";
  assert.equal(evaluate(purposeEdgeContract.transitionId, purposeEdge.from, purposeEdge.to, whitespacePurpose).allowed, false,
    "whitespace-only purpose identity is unknown");
});
