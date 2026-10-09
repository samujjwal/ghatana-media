import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { validateMigrationClaimCohort, validateMigrationClaimReview } from "../scripts/lib/pdp-migration-dependency-review.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const parseYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const migrationPath = ".product-experience/pdp-0-product-truth/migration-semantics-review.yaml";
const policyPath = ".product-experience/pdp-0-product-truth/qualification-policy.yaml";
const migration = parseYaml(migrationPath);
const policy = parseYaml(policyPath);
const owners = new Map([[policyPath, policy]]);

const targets = new Map([
  ["MPSEM-0032-C003", `${policyPath}#ownerDefinedMigrationQualificationRules/reproducibilityClassification`],
  ["MPSEM-0040-C004", `${policyPath}#ownerDefinedMigrationQualificationRules/licenseEvidenceRule`],
  ["MPSEM-0271-C004", `${policyPath}#/ownerDefinedMigrationQualificationRules/failureRecoveryQualificationRule`],
  ["MPSEM-0291-C004", `${policyPath}#/ownerDefinedMigrationQualificationRules/substitutionAdmissionRule`],
  ["MPSEM-0356-C002", `${policyPath}#/ownerDefinedMigrationQualificationRules/identityAndConsentImplementationBoundary`],
  ["MPSEM-0379-C001", `${policyPath}#ownerDefinedMigrationQualificationRules/cacheReuseValidityRule`],
  ["MPSEM-0454-C001", `${policyPath}#/ownerDefinedMigrationQualificationRules/substitutionAdmissionRule`],
]);
const predicates = new Map([
  ["MPSEM-0032-C003", ["canonicalSolverFidelityDescriptorRef", "simulation-fidelity-definition", "exactEnvironment", "toleranceBound", "statistical", "replayUnavailable", "Solver determinism", "hardware class", "solver identity/version", "numerical/precision/time-step bounds"]],
  ["MPSEM-0040-C004", ["exact selected release/build", "license expression", "transitive/native dependencies", "model weights", "patent grants/encumbrances", "intended execution/serving profile", "legal review and license admission remain open"]],
  ["MPSEM-0271-C004", ["durable checkpoint state/version", "ordered input-event sequence", "before and after each consequential boundary", "reconcile uncertain effects before replay", "recovery-unavailable rather than success"]],
  ["MPSEM-0291-C004", ["explicit reuse-decision record", "not a silent substitute", "compatible typed inputs and outputs", "qualification for the requested scope", "Missing or unknown evidence denies substitution"]],
  ["MPSEM-0356-C002", ["parallel IAM service", "JWT parser", "generic consent framework", "Media defines operation-specific authorization"]],
  ["MPSEM-0379-C001", ["source artifact digests", "exact operation and schema versions", "quality-profile and delivery-profile identities and versions", "temporal, color, audio, layout, and font configuration", "current authorization and retention checks", "a cache hit never supplies authorization"]],
  ["MPSEM-0454-C001", ["explicit reuse-decision record before entering a critical path", "Missing or unknown evidence denies substitution"]],
]);

function resolveRef(ref) {
  const [source, pointer] = ref.split("#", 2);
  let value = owners.get(source);
  assert.ok(value, `target owner is within this qualification cohort: ${source}`);
  for (const raw of pointer.split("/").filter(Boolean)) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (segment.startsWith("@id=")) {
      assert.ok(Array.isArray(value), `stable selector resolves a list: ${ref}`);
      value = value.find((entry) => entry.id === segment.slice(4));
    } else if (/^\d+$/u.test(segment)) value = value[Number(segment)];
    else value = value?.[segment];
    assert.notEqual(value, undefined, `owner value resolves: ${ref}`);
  }
  return value;
}
const claims = () => migration.pdp38ClaimReconciliation.records.flatMap((record) => record.claims ?? []).flatMap((claim) => claim.subclaims ?? [claim]);

test("the finite qualification policy claim cohort binds exact Media owner rules and value digests", () => {
  const rows = claims().filter((claim) => targets.has(claim.claimId));
  const result = validateMigrationClaimCohort({ claims: rows, expectedTargets: targets, resolveRef, predicatesByClaim: predicates });
  assert.deepEqual(result.errors, []);
  assert.equal(rows.length, targets.size);
  for (const claim of rows) {
    assert.equal(claim.semanticReviewStatus, "CLAIM_SPECIFIC_SEMANTIC_PARITY_VERIFIED", claim.claimId);
    assert.match(claim.semanticReviewRef, /migration-policy-source-review\.json#\/records\/@claimId=/u);
    assert.equal(claim.acceptanceEffect, "none", claim.claimId);
  }
});

test("qualification routes reject material policy weakening and cannot claim acceptance", () => {
  const cases = [
    ["MPSEM-0032-C003", "Identical declared output representation", "Unspecified output representation"],
    ["MPSEM-0040-C004", "transitive/native dependencies", "selected direct package only"],
    ["MPSEM-0271-C004", "reconcile uncertain effects before replay", "replay effects"],
    ["MPSEM-0291-C004", "Missing or unknown evidence denies substitution", "unknown evidence is acceptable"],
    ["MPSEM-0356-C002", "Media must not create a parallel IAM service", "Media may create a parallel IAM service"],
    ["MPSEM-0379-C001", "current authorization and retention checks", "cached prior authorization"],
    ["MPSEM-0454-C001", "explicit reuse-decision record before entering a critical path", "reuse decision is optional"],
  ];
  for (const [claimId, predicate, replacement] of cases) {
    const claim = claims().find((row) => row.claimId === claimId);
    const targetRef = targets.get(claimId);
    const targetValue = resolveRef(targetRef);
    const replaceStrings = (value) => {
      if (typeof value === "string") return value.replace(predicate, replacement);
      if (Array.isArray(value)) return value.map(replaceStrings);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceStrings(child)]));
      return value;
    };
    const broken = replaceStrings(targetValue);
    const result = validateMigrationClaimReview({ claim, expectedTargetRef: targetRef, targetValue: broken, requiredPredicates: predicates.get(claimId) });
    assert.equal(result.valid, false, `must reject weakened ${claimId}`);
  }
  const claim = claims().find((row) => row.claimId === "MPSEM-0291-C004");
  const targetRef = targets.get(claim.claimId);
  const forged = validateMigrationClaimReview({ claim: { ...claim, semanticReviewStatus: "INDEPENDENT_ACCEPTED", acceptanceEffect: "phase-accepted" }, expectedTargetRef: targetRef, targetValue: resolveRef(targetRef), requiredPredicates: predicates.get(claim.claimId) });
  assert.equal(forged.valid, false);
});

test("cache reuse is invalidated by authority, policy, output integrity, or context changes", () => {
  const rule = resolveRef(targets.get("MPSEM-0379-C001"));
  assert.match(rule.rule, /exact key equality/u);
  assert.match(rule.rule, /intact output integrity/u);
  assert.match(rule.rule, /current authorization and retention checks/u);
  assert.match(rule.rule, /changed policy/u);
  assert.match(rule.rule, /unknown impact invalidates reuse/u);
  assert.match(rule.rule, /cache hit never supplies authorization/u);
});

test("solver bounds, patent rights, and cache profile identities are material qualification scope", () => {
  const cases = [
    ["MPSEM-0032-C003", "solver identity/version", "solver identity/version removed"],
    ["MPSEM-0040-C004", "patent grants/encumbrances", "patents omitted"],
    ["MPSEM-0379-C001", "quality-profile and delivery-profile identities and versions", "generic profile"],
  ];
  for (const [claimId, search, replacement] of cases) {
    const claim = claims().find((row) => row.claimId === claimId);
    const targetRef = targets.get(claimId);
    const targetValue = resolveRef(targetRef);
    const replaceStrings = (value) => {
      if (typeof value === "string") return value.replace(search, replacement);
      if (Array.isArray(value)) return value.map(replaceStrings);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceStrings(child)]));
      return value;
    };
    const changed = replaceStrings(targetValue);
    assert.notDeepEqual(changed, targetValue, `mutation applies: ${claimId}`);
    assert.equal(validateMigrationClaimReview({ claim, expectedTargetRef: targetRef, targetValue: changed, requiredPredicates: predicates.get(claimId) }).valid, false, claimId);
  }
});
