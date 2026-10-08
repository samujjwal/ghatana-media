import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));

const capabilities = readYaml(".product-experience/pdp-0-product-truth/capabilities.yaml");
const requirements = readYaml(".product-experience/pdp-0-product-truth/requirements.yaml");
const nfr = readYaml(".product-experience/pdp-0-product-truth/nonfunctional-requirements.yaml");
const profiles = readYaml(".product-experience/pdp-0-product-truth/profile-semantics.yaml");
const qualification = readYaml(".product-experience/pdp-0-product-truth/qualification-policy.yaml");
const capabilityReview = readYaml(".product-experience/pdp-0-product-truth/capability-leaf-review.yaml");
const operations = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");

const genericBoundsText =
  "Not yet enumerated; the owning profile/public contract must define units, ranges, defaults, and unsupported values before a claim of support.";

test("P0-02 keeps the unbounded leaf denominator and profile availability evidence explicit", () => {
  assert.equal(capabilities.capabilities.length, 462);

  const proposed = capabilities.capabilities.filter(({ supportedParameters }) => supportedParameters !== genericBoundsText);
  const unbounded = capabilities.capabilities.filter(({ supportedParameters }) => supportedParameters === genericBoundsText);
  assert.equal(proposed.length, 17, "the 17 field-shape proposals still require exact bounds from their owners");
  assert.equal(unbounded.length, 445, "the previously reported unbounded-leaf count is reproducible");

  for (const leaf of capabilities.capabilities) {
    assert.equal(leaf.supportDimensions.implementationState, "UNKNOWN", `${leaf.id} implementation evidence`);
    assert.equal(leaf.supportDimensions.licenseAdmissionState, "UNKNOWN", `${leaf.id} license evidence`);
    assert.equal(leaf.supportDimensions.qualificationState, "NOT_EVALUATED", `${leaf.id} qualification evidence`);
    assert.equal(leaf.supportDimensions.runtimeAvailability, "UNKNOWN", `${leaf.id} live availability`);
  }

  for (const leaf of proposed) {
    assert.match(leaf.supportedParameters, /owner contract|owning .*contract|owning service|owner-defined|owner must define|owners must publish|owner qualification|profile-owner review/iu, `${leaf.id} retains an owner-bound limit`);
  }
});

test("P0-02 profile labels and proposed performance budgets do not become product guarantees", () => {
  assert.equal(requirements.requirements.length, 38, "family requirements are not per-leaf bounds");

  for (const requirement of requirements.requirements) {
    assert.equal(requirement.scopeStatus, "TARGET");
    assert.match(requirement.expectedBehavior, /does not substitute|unsupported/iu, `${requirement.id} rejects silent support claims`);
    assert.match(requirement.acceptanceCases[1].then, /blocked|absent|unknown/iu, `${requirement.id} fails closed on unknown qualification`);
  }

  assert.match(profiles.scopeNote, /does not select, qualify, or declare available any engine, model, codec, provider, runtime, or deployment/iu);
  assert.match(profiles.profileAxes.find(({ id }) => id === "PROFILE-AXIS-DELIVERY").axisRule, /do not imply format support or qualification/iu);
  assert.match(qualification.decisionRules.join(" "), /UNKNOWN is not AVAILABLE/iu);

  const performance = nfr.requirements.find(({ id }) => id === "NFR-PERF-001");
  assert.match(nfr.measurementRule, /proposed-budgets-are-not-observed-results-or-production-SLOs/iu);
  assert.match(performance.acceptance, /proposals-until-environment-corpus-load-method-and-owner-approval-are-recorded/iu);
  assert.ok(performance.initialProposedBudgets.every(({ environment }) => environment === "not-yet-named"));
});

test("P0-02 does not promote family-level operation groups into leaf-specific parameter contracts", () => {
  const proposed = capabilities.capabilities.filter(({ supportedParameters }) => supportedParameters !== genericBoundsText);
  assert.equal(proposed.length, 17);

  // The existing operation inventory groups actions under broad operations; it
  // does not yet bind capability leaves to exact runtime/API request schemas.
  assert.equal(capabilityReview.denominatorReconciliation.machineOperationDispositions, 0);
  assert.match(operations.scopeStatus, /cross-interface-bindings-and-owner-review-pending/u);
  assert.match(operations.sourceDenominators.httpOperations.bindingStatus, /exact route-to-logical-operation links remain unresolved/u);

  for (const leaf of proposed) {
    assert.equal(leaf.supportDimensions.implementationState, "UNKNOWN", `${leaf.id} implementation remains unknown`);
    assert.equal(leaf.supportDimensions.qualificationState, "NOT_EVALUATED", `${leaf.id} qualification remains unevaluated`);
    assert.match(leaf.supportedParameters, /own|contract|profile|service/iu, `${leaf.id} does not claim an ownerless parameter bound`);
  }
});
