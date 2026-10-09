import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { validateMigrationClaimCohort, validateMigrationClaimReview } from "../scripts/lib/pdp-migration-dependency-review.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const parseYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const migration = parseYaml(".product-experience/pdp-0-product-truth/migration-semantics-review.yaml");
const actorsPath = ".product-experience/pdp-0-product-truth/actors-responsibilities.yaml";
const qualityPath = ".product-experience/pdp-0-product-truth/quality-policy.yaml";
const glossaryPath = ".product-experience/pdp-0-product-truth/glossary.yaml";
const interfaceParityPath = ".product-experience/interface-parity/operation-parity.yaml";
const owners = new Map([
  [actorsPath, parseYaml(actorsPath)],
  [qualityPath, parseYaml(qualityPath)],
  [glossaryPath, parseYaml(glossaryPath)],
  [interfaceParityPath, parseYaml(interfaceParityPath)],
]);
const targets = new Map([
  ["MPSEM-0023-C002", `${interfaceParityPath}#compatibilityRouteFindings/currentComparison`],
  ["MPSEM-0023-C003", `${actorsPath}#wireCompatibilityPreservationRule`],
  ["MPSEM-0023-C004", `${actorsPath}#wireCompatibilityPreservationRule`],
  ["MPSEM-0187-C002", `${qualityPath}#personAndIdentityInferenceRule`],
  ["MPSEM-0204-C004", `${qualityPath}#preservationSensitiveEnhancementRule`],
  ["MPSEM-0354-C001", `${glossaryPath}#/terms/@id=media.term.privacy-axes/summaryRule`],
]);
const predicates = new Map([
  ["MPSEM-0023-C002", ["14-of-14 observed legacy/candidate SDK paths", "absent from the 27-route active manifest", "proves non-admission", "does not choose a replacement route"]],
  ["MPSEM-0023-C003", ["request and result field identity, type, presence and bounds", "units and time bases", "authority and delegation", "idempotency, cancellation and finality", "compatibility tests", "before admitting a new public contract", "explicit compatibility gap"]],
  ["MPSEM-0023-C004", ["canonical operation through an explicit adapter", "compatibility tests", "before admitting a new public contract", "field, unit, authority or outcome"]],
  ["MPSEM-0187-C002", ["is an inference, not an established fact about a person", "method/model identity and version", "evidence/reference", "applicable scope", "uncertainty", "Do not assert ground truth"]],
  ["MPSEM-0204-C004", ["reconstruct or alter identity-bearing detail", "immutable version", "generated or reconstructed detail is uncertain", "known preservation limits", "never replace or represent the source as recovered truth"]],
  ["MPSEM-0354-C001", ["simple human-readable summary", "access/sharing, classification, processing location, consent/rights, and retention", "preserving each applicable axis independently"]],
]);

function resolveRef(ref) {
  const [source, pointer] = ref.split("#", 2);
  let value = owners.get(source);
  assert.ok(value, `owned source resolves: ${source}`);
  for (const raw of pointer.split("/").filter(Boolean)) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (segment.startsWith("@id=")) {
      assert.ok(Array.isArray(value), `stable ID selector addresses a list: ${ref}`);
      value = value.find((entry) => entry.id === segment.slice(4));
    } else if (/^\d+$/u.test(segment)) value = value[Number(segment)];
    else value = value?.[segment];
    assert.notEqual(value, undefined, `exact owner target resolves: ${ref}`);
  }
  return value;
}

function claims() {
  return migration.pdp38ClaimReconciliation.records.flatMap((record) => record.claims ?? [])
    .flatMap((claim) => claim.subclaims ?? [claim]);
}

test("privacy, preservation, person-inference and wire-compatibility claims bind exact current owner rules", () => {
  const rows = claims().filter((claim) => targets.has(claim.claimId));
  const result = validateMigrationClaimCohort({ claims: rows, expectedTargets: targets, resolveRef, predicatesByClaim: predicates });
  assert.deepEqual(result.errors, []);
  assert.equal(rows.length, targets.size);
  for (const claim of rows) {
    assert.equal(claim.semanticReviewStatus, "OWNER_TARGET_LOCATOR_ONLY_PENDING_CLAIM_PARITY", claim.claimId);
    assert.equal(claim.acceptanceEffect, "none", claim.claimId);
  }
});

test("material mutations cannot erase privacy axes, uncertainty, preservation limits or exact wire compatibility", () => {
  const mutations = [
    ["MPSEM-0023-C002", "does not choose a replacement route", "chooses a replacement route by name"],
    ["MPSEM-0023-C003", "units and time bases", "units omitted"],
    ["MPSEM-0023-C003", "authority and delegation", "authority omitted"],
    ["MPSEM-0023-C004", "before admitting a new public contract", "after automatic contract admission"],
    ["MPSEM-0187-C002", "uncertainty", "certainty"],
    ["MPSEM-0187-C002", "Do not assert ground truth", "Assert ground truth"],
    ["MPSEM-0204-C004", "known preservation limits", "no stated limits"],
    ["MPSEM-0204-C004", "immutable version", "mutable overwrite"],
    ["MPSEM-0354-C001", "access/sharing, classification, processing location, consent/rights, and retention", "privacy"],
    ["MPSEM-0354-C001", "preserving each applicable axis independently", "combining all axes into one label"],
  ];
  for (const [claimId, search, replacement] of mutations) {
    const claim = claims().find((row) => row.claimId === claimId);
    const targetRef = targets.get(claimId);
    const target = resolveRef(targetRef);
    const material = typeof target === "string" ? target : JSON.stringify(target);
    const weakened = material.replace(search, replacement);
    assert.notEqual(weakened, material, `mutation applies: ${claimId} ${search}`);
    assert.equal(validateMigrationClaimReview({
      claim,
      expectedTargetRef: targetRef,
      targetValue: weakened,
      requiredPredicates: predicates.get(claimId),
    }).valid, false, `${claimId} rejects loss of ${search}`);
  }
});
