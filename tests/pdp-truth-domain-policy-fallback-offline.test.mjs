import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateOfflineEntitlementDefinition } from "../scripts/lib/pdp-offline-entitlement-definition.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const sourcePath = ".product-experience/pdp-0-product-truth/policy-authority-model.yaml";
const source = parse(readFileSync(resolve(root, sourcePath), "utf8"));
const fallback = source.modelAcquisitionAndFallback.fallback.compatibilityDecisionRule;
const offline = source.modelAcquisitionAndFallback.offlineEntitlementWindow;
const archive = source.productPolicy.inputAndExecutionThreats.archiveExtractionDestinationRule;
const normative = new Map(source.ownerNormativeRuleRecords.map((row) => [row.id, row.ruleRef]));

function archiveSafe(rule) {
  return rule?.id === "media.policy.archive-extraction-destination-safety.v1"
    && /canonical per-job destination root/u.test(rule.rule)
    && /must not overwrite an existing destination by default/u.test(rule.rule)
    && /exact target identity and expected revision/u.test(rule.rule)
    && /atomic compare-and-set/u.test(rule.rule)
    && /REJECT_BEFORE_DESTINATION_MUTATION/u.test(rule.failure)
    && rule.negativeCases.includes("preexisting-target-without-explicit-overwrite-authority")
    && rule.scopeStatus.includes("NOT_EVALUATED");
}

function fallbackComplete(rule) {
  return rule?.id === "media.policy.fallback-compatibility-decision.v1"
    && ["capability", "immutable", "profile", "consent", "rights", "residency", "locality", "retention", "cost", "fidelity", "result contract"]
      .every((term) => rule.rule.toLowerCase().includes(term))
    && /missing, stale, or unknown compatibility fact is not a match/u.test(rule.rule)
    && /repeat current policy/u.test(rule.reauthorization)
    && /different target/u.test(rule.reauthorization)
    && /Never infer compatibility/u.test(rule.noSilentSubstitution)
    && rule.runtimeStatus === "NOT_EVALUATED";
}

function offlineComplete(rule) {
  return rule?.id === "media.policy.offline-entitlement-validity-window.v1"
    && JSON.stringify(rule.exactTuple) === JSON.stringify([
      "tenantScopeRef", "principalRef", "issuerRef", "capabilityRef", "profileRef", "profileVersionRef",
      "entitlementRef", "entitlementVersionRef", "policyDecisionRef", "purposeRef", "allowedOperationRefs",
      "validFrom", "validUntil", "revocationDisposition", "observedAt", "readAuthorityRef", "readVersion",
    ])
    && rule.bindingRules.exactTrustedContext.includes("purposeRef")
    && /requestedOperationRef/u.test(rule.bindingRules.operationMembership)
    && /exactly millisecond precision/u.test(rule.timeRepresentation)
    && /validFrom <= now < validUntil/u.test(rule.rule)
    && /missing, stale, malformed, revoked, expired-at-equality/u.test(rule.rule)
    && /No grace period is implied/u.test(rule.rule)
    && /Cached bytes or a locally present model do not prove a current entitlement/u.test(rule.offlineBoundary)
    && rule.runtimeStatus === "NOT_EVALUATED";
}

test("fallback and offline policies require exact current compatibility and entitlement tuples", () => {
  assert.equal(fallbackComplete(fallback), true);
  assert.equal(offlineComplete(offline), true);
  assert.equal(archiveSafe(archive), true);
  assert.equal(normative.get(fallback.id), `${sourcePath}#modelAcquisitionAndFallback/fallback/compatibilityDecisionRule`);
  assert.equal(normative.get(offline.id), `${sourcePath}#modelAcquisitionAndFallback/offlineEntitlementWindow`);
  assert.equal(normative.get(archive.id), `${sourcePath}#productPolicy/inputAndExecutionThreats/archiveExtractionDestinationRule`);
  for (const mutate of [
    (value) => { value.rule = value.rule.replace("retention, cost, and fidelity conditions", "retention and fidelity conditions"); },
    (value) => { value.noSilentSubstitution = "Use any provider with the same capability name."; },
    (value) => { value.reauthorization = "Reuse the primary target authorization."; },
  ]) {
    const changed = structuredClone(fallback);
    mutate(changed);
    assert.equal(fallbackComplete(changed), false);
  }
  for (const mutate of [
    (value) => { value.exactTuple = value.exactTuple.filter((field) => field !== "validUntil"); },
    (value) => { value.rule = value.rule.replace("validFrom <= now < validUntil", "now <= validUntil"); },
    (value) => { value.rule = value.rule.replace("No grace period is implied.", "A grace period applies automatically."); },
    (value) => { value.runtimeStatus = "AVAILABLE"; },
  ]) {
    const changed = structuredClone(offline);
    mutate(changed);
    assert.equal(offlineComplete(changed), false);
  }
  for (const mutate of [
    (value) => { value.rule = value.rule.replace("must not overwrite an existing destination by default", "may overwrite existing destinations"); },
    (value) => { value.rule = value.rule.replace("atomic compare-and-set", "best-effort update"); },
    (value) => { value.negativeCases = value.negativeCases.filter((entry) => entry !== "preexisting-target-without-explicit-overwrite-authority"); },
  ]) {
    const changed = structuredClone(archive);
    mutate(changed);
    assert.equal(archiveSafe(changed), false);
  }
  const expected = {
    tenantScopeRef: "tenant:t1", principalRef: "principal:p1", issuerRef: "issuer:i1",
    capabilityRef: "capability:c1", profileRef: "profile:p1", profileVersionRef: "profile-version:p1:v4",
    purposeRef: "purpose:offline-edit", entitlementRef: "entitlement:e1", entitlementVersionRef: "entitlement:e1:v3",
    policyDecisionRef: "policy-decision:d8", readAuthorityRef: "authority:trusted-reader", readVersion: "read:v11",
    currentness: "CURRENT", revocationDisposition: "ACTIVE", allowedOperationRefs: ["operation:edit.v2", "operation:read.v1"],
    validFrom: "2026-10-09T00:00:00.000Z", validUntil: "2026-10-10T00:00:00.000Z",
  };
  const entitlement = {
    ...expected,
    entitlementRef: "entitlement:e1", entitlementVersionRef: "entitlement:e1:v3",
    policyDecisionRef: "policy-decision:d8", allowedOperationRefs: ["operation:edit.v2", "operation:read.v1"],
    validFrom: "2026-10-09T00:00:00.000Z", validUntil: "2026-10-10T00:00:00.000Z",
    revocationDisposition: "ACTIVE", currentness: "CURRENT",
  };
  const now = "2026-10-09T12:00:00.000Z";
  assert.equal(evaluateOfflineEntitlementDefinition(entitlement, expected, "operation:edit.v2", now).disposition, "ELIGIBLE_BY_DEFINITION_ONLY");
  assert.equal(evaluateOfflineEntitlementDefinition({ ...entitlement, allowedOperationRefs: [...entitlement.allowedOperationRefs].reverse() }, expected, "operation:edit.v2", now).disposition, "ELIGIBLE_BY_DEFINITION_ONLY",
    "the allowlist is compared as a set, independent of serialization order");
  assert.equal(evaluateOfflineEntitlementDefinition(entitlement, { ...expected, purposeRef: "purpose:other" }, "operation:edit.v2", now).disposition, "DENIED");
  assert.equal(evaluateOfflineEntitlementDefinition(entitlement, { ...expected, entitlementRef: "entitlement:other" }, "operation:edit.v2", now).disposition, "DENIED");
  assert.equal(evaluateOfflineEntitlementDefinition(entitlement, { ...expected, entitlementVersionRef: "entitlement:e1:v2" }, "operation:edit.v2", now).disposition, "DENIED");
  assert.equal(evaluateOfflineEntitlementDefinition(entitlement, { ...expected, policyDecisionRef: "policy-decision:old" }, "operation:edit.v2", now).disposition, "DENIED");
  assert.equal(evaluateOfflineEntitlementDefinition(entitlement, { ...expected, currentness: "STALE" }, "operation:edit.v2", now).disposition, "DENIED");
  assert.equal(evaluateOfflineEntitlementDefinition(entitlement, { ...expected, revocationDisposition: "REVOKED" }, "operation:edit.v2", now).disposition, "DENIED");
  assert.equal(evaluateOfflineEntitlementDefinition(entitlement, expected, "operation:other.v2", now).disposition, "DENIED");
  assert.equal(evaluateOfflineEntitlementDefinition({ ...entitlement, allowedOperationRefs: [...entitlement.allowedOperationRefs, "operation:delete.v2"] }, expected, "operation:edit.v2", now).disposition, "DENIED",
    "the trusted owner-read allowlist cannot be widened while retaining the same read version");
  assert.equal(evaluateOfflineEntitlementDefinition({ ...entitlement, allowedOperationRefs: [17] }, expected, "operation:edit.v2", now).disposition, "DENIED",
    "non-string operations cannot enter an entitlement allowlist");
  assert.equal(evaluateOfflineEntitlementDefinition(entitlement, { ...expected, allowedOperationRefs: ["operation:edit.v2", "operation:delete.v2"] }, "operation:edit.v2", now).disposition, "DENIED",
    "the trusted expected operation set is exact and cannot be widened by the caller");
  assert.equal(evaluateOfflineEntitlementDefinition(entitlement, { ...expected, validUntil: "2026-10-11T00:00:00.000Z" }, "operation:edit.v2", now).disposition, "DENIED",
    "an entitlement interval cannot be widened beyond the trusted current-read tuple");
  assert.equal(evaluateOfflineEntitlementDefinition({ ...entitlement, validUntil: now }, { ...expected, validUntil: now }, "operation:edit.v2", now).disposition, "DENIED",
    "expiry equality is denied after exact tuple equality passes");
  const reversedInterval = { ...expected, validFrom: "2026-10-10T00:00:00.000Z", validUntil: "2026-10-09T00:00:00.000Z" };
  assert.equal(evaluateOfflineEntitlementDefinition({ ...entitlement, ...reversedInterval }, reversedInterval, "operation:edit.v2", now).disposition, "UNKNOWN",
    "an invalid owner interval is unknown after tuple equality passes");
  assert.equal(evaluateOfflineEntitlementDefinition({ ...entitlement, revocationDisposition: "REVOKED" }, expected, "operation:edit.v2", now).disposition, "DENIED");
  assert.equal(evaluateOfflineEntitlementDefinition(entitlement, expected, "operation:edit.v2", "2026-02-30T12:00:00.000Z").disposition, "UNKNOWN");
  assert.equal(evaluateOfflineEntitlementDefinition(entitlement, expected, "operation:edit.v2", "2026-10-09T24:00:00.000Z").disposition, "UNKNOWN");
  assert.equal(evaluateOfflineEntitlementDefinition(entitlement, expected, "operation:edit.v2", "2026-10-09T12:00:00.000000001Z").disposition, "UNKNOWN");
});

test("hash-chain evidence requires an independent anchor and never proves against its controller", () => {
  const rule = source.productPolicy.dataHandling.auditRecordBoundary.hashChainLimitRule;
  assert.equal(rule.id, "media.policy.audit-hash-chain-trust-limit.v1");
  assert.match(rule.rule, /independently protected key, checkpoint, or append-only external anchor/u);
  assert.match(rule.rule, /same administrator is not proof/u);
  assert.match(rule.rule, /report the integrity conclusion as UNKNOWN/u);
  assert.ok(rule.requiredEvidence.includes("keyAuthorityRef"));
  assert.equal(normative.get(rule.id), `${sourcePath}#productPolicy/dataHandling/auditRecordBoundary/hashChainLimitRule`);
  for (const mutate of [
    (value) => { value.rule = value.rule.replace("independently protected key, checkpoint, or append-only external anchor", "local hash chain"); },
    (value) => { value.rule = value.rule.replace("report the integrity conclusion as UNKNOWN rather than tamper-proof", "report tamper-proof"); },
    (value) => { value.requiredEvidence = value.requiredEvidence.filter((field) => field !== "keyAuthorityRef"); },
  ]) {
    const changed = structuredClone(rule);
    mutate(changed);
    assert.ok(!/independently protected key, checkpoint, or append-only external anchor/u.test(changed.rule)
      || !/report the integrity conclusion as UNKNOWN/u.test(changed.rule)
      || !changed.requiredEvidence.includes("keyAuthorityRef"));
  }
});
