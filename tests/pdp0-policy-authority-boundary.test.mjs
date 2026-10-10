import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = process.cwd();
const parse = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml").parse;
const p0 = ".product-experience/pdp-0-product-truth/";
const policy = parse(readFileSync(`${p0}policy-authority-model.yaml`, "utf8"));
const dependencies = parse(readFileSync(`${p0}dependency-contracts.yaml`, "utf8"));
const constitution = parse(readFileSync(`${p0}constitution.yaml`, "utf8"));

test("P0 policy assigns one semantic authority and keeps platform mechanics separate", () => {
  const product = policy.productPolicy;
  assert.equal(product.semanticOwner, "media");
  assert.match(product.authorityStatus, /pending-P0-010-independent-acceptance/u);

  const identity = product.platformMechanics.identityAndAuthentication;
  assert.equal(identity.owner, "ghatana-shared-and-identity-service");
  assert.match(identity.mediaRole, /consume-public-principal-tenant-and-delegation-context/u);
  assert.ok(identity.prohibited.includes("parallel-media-iam"));
  assert.ok(identity.prohibited.includes("caller-selected-tenant-authority"));
  assert.ok(product.independentGovernanceAxes.every(({ policyOwner }) => typeof policyOwner === "string" && policyOwner.length > 0));

  const sharedIdentity = dependencies.dependencyContracts.find(({ dependencyId }) => dependencyId === "DEP-SHARED-IDENTITY");
  assert.equal(sharedIdentity.owner, "ghatana-shared");
  assert.match(sharedIdentity.ownerBoundaryRule, /principal, tenant, delegation, audience, and expiry facts/u);
  assert.match(sharedIdentity.ownerBoundaryRule, /Media separately authorizes each operation's purpose, rights, consent, resource, and effect scope/u);
  assert.match(sharedIdentity.ownerBoundaryRule, /Authentication alone is not permission/u);
  assert.equal(sharedIdentity.sourceCouplingAllowed, false);
  assert.match(sharedIdentity.bindingStatus, /unverified/u);
});

test("identity, consent, rights, version and revocation checks fail closed at policy boundaries", () => {
  const product = policy.productPolicy;
  const axes = new Map(product.independentGovernanceAxes.map((axis) => [axis.axis, axis]));
  assert.equal(axes.size, product.independentGovernanceAxes.length, "each governance axis has one canonical record");
  assert.match(axes.get("consent").default, /verified-active-and-narrowly-scoped/u);
  assert.match(axes.get("residency-and-egress").default, /deny-unapproved-region-or-external-transfer/u);
  assert.match(axes.get("training-and-secondary-use").default, /deny-unless-separately-authorized/u);
  assert.ok(product.invariants.includes("user-attestation-is-not-verified-consent-or-license"));
  assert.ok(product.invariants.includes("source-classification-propagates-until-an-authorized-deidentification-promotion"));
  assert.ok(product.invariants.includes("policy-revocation-stops-future-dispatch-and-restricts-outputs-at-the-next-enforcement-point"));

  const dispatch = product.enforcementPoints.find(({ point }) => point === "attempt-claim-and-provider-dispatch");
  assert.ok(dispatch.requiredChecks.includes("current-delegation"));
  assert.ok(dispatch.requiredChecks.includes("current-consent"));
  assert.ok(dispatch.requiredChecks.includes("purpose"));
  assert.ok(dispatch.requiredChecks.includes("region"));
  assert.ok(dispatch.requiredChecks.includes("provider-retention"));
  assert.equal(dispatch.failure, "do-not-dispatch; if intent may have crossed boundary, preserve-outcome-unknown");

  const offline = policy.modelAcquisitionAndFallback.offlineEntitlementWindow;
  assert.ok(offline.exactTuple.includes("principalRef"));
  assert.ok(offline.exactTuple.includes("entitlementVersionRef"));
  assert.ok(offline.exactTuple.includes("policyDecisionRef"));
  assert.ok(offline.exactTuple.includes("purposeRef"));
  assert.ok(offline.exactTuple.includes("revocationDisposition"));
  assert.match(offline.rule, /validFrom <= now < validUntil/u);
  assert.match(offline.rule, /missing, stale, malformed, revoked/u);
  assert.equal(offline.runtimeStatus, "NOT_EVALUATED");

  const relevantConstitution = new Map(constitution.requirements.map((entry) => [entry.id, entry]));
  for (const id of ["MEDIA-CONST-002", "MEDIA-CONST-026", "MEDIA-CONST-029"]) {
    assert.equal(relevantConstitution.get(id)?.acceptanceState, "pending-human-review");
  }
  assert.match(relevantConstitution.get("MEDIA-CONST-002").statement, /authorize each consequential action/u);
  assert.match(relevantConstitution.get("MEDIA-CONST-026").statement, /without separate authorization/u);
  assert.match(relevantConstitution.get("MEDIA-CONST-029").statement, /re-check current policy at the effect boundary/u);
});

test("policy definitions do not claim runtime/provider admission or acceptance", () => {
  const product = policy.productPolicy;
  assert.match(product.authorityStatus, /pending-P0-010-independent-acceptance/u);
  assert.equal(policy.modelAcquisitionAndFallback.scopeStatus,
    "OWNER_DEFINED_POLICY; no model/provider is selected, downloaded, licensed, qualified or available by this definition");
  assert.equal(policy.modelAcquisitionAndFallback.automaticAcquisition.default, "DENY");
  assert.match(policy.modelAcquisitionAndFallback.automaticAcquisition.effect, /eligibility gate only/u);
  assert.match(policy.modelAcquisitionAndFallback.fallback.compatibilityDecisionRule.scopeStatus, /no alternate is admitted or selected/u);
  assert.equal(policy.modelAcquisitionAndFallback.fallback.compatibilityDecisionRule.runtimeStatus, "NOT_EVALUATED");
  assert.equal(policy.modelAcquisitionAndFallback.offlineEntitlementWindow.runtimeStatus, "NOT_EVALUATED");
});
