import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { resolvePdp3BindingSourceRef } from "../scripts/lib/pdp3-journey-operation-binding.mjs";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const root = process.cwd();
const p3 = ".product-experience/pdp-3-product-experience/";
const p1 = ".product-experience/pdp-1-domain-data/";
const [guardDoc, oracle, actions, operations, authority, domain, transitions] = await Promise.all([
  readFile(`${p3}step-guard-fact-contracts.yaml`, "utf8").then(parse),
  readFile(`${p3}step-definition-oracles.yaml`, "utf8").then(parse),
  readFile(`${p3}action-registry.yaml`, "utf8").then(parse),
  readFile(`${p1}operations.yaml`, "utf8").then(parse),
  readFile(`${p1}authority.yaml`, "utf8").then(parse),
  readFile(`${p1}domain-objects.yaml`, "utf8").then(parse),
  readFile(`${p1}transitions.yaml`, "utf8").then(parse),
]);
const sources = {
  [`${p3}action-registry.yaml`]: actions,
  [`${p3}step-definition-oracles.yaml`]: oracle,
  [`${p3}step-guard-fact-contracts.yaml`]: guardDoc,
  [`${p1}operations.yaml`]: operations,
  [`${p1}authority.yaml`]: authority,
  [`${p1}domain-objects.yaml`]: domain,
  [`${p1}transitions.yaml`]: transitions,
};
const guards = new Map(guardDoc.guardContracts.records.map((row) => [row.guardRef, row]));
const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");

test("all 94 guarded domain, identity and ordered-workflow steps have exact guard contract rows", () => {
  const guarded = oracle.journeys.flatMap((journey) => journey.steps
    .filter((step) => ["DOMAIN_OPERATION", "EXTERNAL_SHARED_IDENTITY_HANDOFF_OR_OBSERVATION", "ORDERED_DOMAIN_WORKFLOW"].includes(step.semanticRole))
    .map((step) => ({ journey, step })));
  assert.equal(guarded.length, 94);
  assert.equal(guardDoc.stepBindings.count, 94);
  assert.equal(guardDoc.counts.guardInstances, 254);
  assert.equal(guardDoc.counts.uniqueGuardContracts, 57);
  const bindings = new Map(guardDoc.stepBindings.records.map((row) => [row.stepRef, row]));
  let guardInstances = 0;
  for (const { journey, step } of guarded) {
    const binding = bindings.get(step.sourceRef);
    assert.ok(binding, `${journey.journeyId}/${step.id} has an exact step binding`);
    assert.equal(binding.actionRef, step.actionRef);
    assert.deepEqual(binding.operationRefs, step.canonicalOperationRefs ?? []);
    assert.deepEqual(binding.guardFactContractRefs.map((ref) => ref.split("@id=").at(-1)), (step.guardRefs ?? []).map((guard) => `media.pdp3.guard-fact.${normalize(guard)}.v1`));
    guardInstances += (step.guardRefs ?? []).length;
    for (const guardRef of step.guardRefs ?? []) {
      const contract = guards.get(guardRef);
      assert.ok(contract, `missing guard contract ${guardRef}`);
      assert.ok(contract.semanticRule.length > 50, `${guardRef} has an explicit derivation boundary`);
      assert.equal(contract.truthRules.true.includes("exact referenced typed fact"), true);
      assert.ok(contract.truthRules.unknown.includes("stale"));
      assert.equal(contract.runtimeAdmission, "NOT_ADMITTED");
    }
  }
  assert.equal(guardInstances, 254);
});

test("guard source references resolve to exact action, operation and observation definitions", () => {
  for (const contract of guards.values()) {
    const action = resolvePdp3BindingSourceRef(contract.sourceActionDefinitionRef, sources);
    assert.equal(action?.id, contract.sourceActionRef);
    const sourceActionGuards = resolvePdp3BindingSourceRef(contract.sourceActionGuardRef, sources);
    assert.ok(Array.isArray(sourceActionGuards));
    assert.ok(sourceActionGuards.includes(contract.sourceActionGuardExpected), `${contract.guardRef} is an exact action-owned guard`);
    for (const operationRef of contract.sourceOperationRefs) {
      assert.ok(resolvePdp3BindingSourceRef(contract.sourceOperationContractRefs.find((ref) => ref.endsWith(`@id=${operationRef}`)), sources), `${operationRef} resolves`);
    }
    if (contract.sourceGuardRef) {
      const sourceGuards = resolvePdp3BindingSourceRef(contract.sourceGuardRef, sources);
      assert.ok(Array.isArray(sourceGuards));
      assert.ok(sourceGuards.includes(contract.sourceGuardExpected));
    }
    if (contract.requiredObservationContractRef) {
      const observation = resolvePdp3BindingSourceRef(contract.requiredObservationContractRef, sources);
      assert.ok(observation?.requestSchema && observation?.resultSchema);
      assert.match(contract.typedSourceEvidenceStatus, /TYPED_QUERY_AVAILABLE.*RUNTIME|EXACT_TYPED_QUERY_DEFINITION.*RUNTIME/u);
      if (contract.guardRef === "retry-budget-remains-under-current-policy") {
        assert.equal(contract.sourceObservationOperationRef, "media.operation.action.inspect-job-retry-policy");
        assert.equal(resolvePdp3BindingSourceRef(contract.sourceObservationOperationRefSelector, sources)?.id, contract.sourceObservationOperationRef);
        assert.match(contract.requiredObservationValidationRef, /media\.observation-validation\.retry-policy-current-read\.v1/u);
      }
    } else {
      assert.notEqual(contract.typedSourceEvidenceStatus, "EXACT_TYPED_QUERY_DEFINITION; RUNTIME_NOT_ADMITTED");
    }
  }
});

test("all 57 unique guards have typed predicate definitions with source-only boundaries", () => {
  const definitions = new Map(guardDoc.predicateDefinitions.map((row) => [row.guardRef, row]));
  assert.equal(definitions.size, 57);
  assert.equal(guardDoc.predicateDefinitions.length, 57);
  for (const contract of guards.values()) {
    const predicate = definitions.get(contract.guardRef);
    assert.ok(predicate, `${contract.guardRef} has a typed derivation rule`);
    assert.match(predicate.id, /^media\.pdp3\.guard-predicate\..+\.v1$/u);
    assert.ok(predicate.requiredObservationProperties.length > 0);
    assert.ok(predicate.truthDerivation.trueWhen.length > 30);
    assert.ok(predicate.truthDerivation.falseWhen.length > 30);
    if (predicate.guardRef === "retry-budget-remains-under-current-policy") {
      assert.match(predicate.truthDerivation.unknownWhen, /stale.*foreign.*fingerprint/u);
    } else {
      assert.match(predicate.truthDerivation.unknownWhen, /stale.*malformed.*mismatched/u);
    }
    assert.equal(predicate.runtimeAdmission, "NOT_ADMITTED");
    assert.equal(predicate.acceptanceEffect, "none");
  }
  assert.equal(guardDoc.counts.definitionFixturePredicateEvaluators, 57);
  assert.equal(guardDoc.counts.definitionPredicateInstances, 254);
  assert.equal(guardDoc.counts.fullTrustedFactEvaluators, 0);
});

test("P3 guard fact coverage distinguishes implemented query facts from the unresolved population", () => {
  assert.equal(guardDoc.counts.fullTrustedFactEvaluators, 0);
  assert.equal(guardDoc.counts.definitionFixturePredicateEvaluators, 57);
  assert.equal(guardDoc.counts.sourceGuardRulesWithPendingFactEvaluator, 0);
  assert.equal(guardDoc.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(guardDoc.acceptanceEffect, "none");
  for (const row of guardDoc.stepBindings.records) {
    assert.equal(row.coverageStatus, "TYPED_DEFINITION_PREDICATE_AVAILABLE; RUNTIME_ADAPTER_NOT_ADMITTED");
    assert.equal(row.runtimeAdmission, "NOT_ADMITTED");
  }
  const forged = structuredClone(guardDoc.guardContracts.records[0]);
  forged.sourceActionRef = "media.action.not-registered";
  assert.notEqual(resolvePdp3BindingSourceRef(forged.sourceActionDefinitionRef, sources)?.id, forged.sourceActionRef);
});
