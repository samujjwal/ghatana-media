import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
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
const currentObservationPath = "docs/implementation/verification/pdp-38/pending-locator-current-source-observations.json";
const sourceImpactPath = "docs/implementation/verification/pdp-38/migration-frozen-source-deltas.json";
const frozenSourceCommit = "11eb14ea9059045ca4d983383d36c01f9a08bc8f";
const historicalQuality = parse(execFileSync("git", ["show", `${frozenSourceCommit}:${qualityPath}`], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }));
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
  ["MPSEM-0354-C001", `${glossaryPath}#/terms/@id=media.term.privacy-axes`],
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

function resolveHistoricalQualityRef(ref) {
  const [source, pointer] = ref.split("#", 2);
  let value = source === qualityPath ? historicalQuality : owners.get(source);
  assert.ok(value, `historical/current source resolves: ${source}`);
  for (const raw of pointer.split("/").filter(Boolean)) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (segment.startsWith("@id=")) {
      assert.ok(Array.isArray(value), `stable ID selector addresses a list: ${ref}`);
      value = value.find((entry) => entry.id === segment.slice(4));
    } else if (/^\d+$/u.test(segment)) value = value[Number(segment)];
    else value = value?.[segment];
    assert.notEqual(value, undefined, `exact historical owner target resolves: ${ref}`);
  }
  return value;
}

function claims() {
  return migration.pdp38ClaimReconciliation.records.flatMap((record) => record.claims ?? [])
    .flatMap((claim) => claim.subclaims ?? [claim]);
}

const targetDigest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("privacy, preservation, person-inference and wire-compatibility claims bind exact current owner rules", () => {
  const rows = claims().filter((claim) => targets.has(claim.claimId));
  // The ledger locator digest is an immutable historical observation. Validate it
  // against the frozen source tree; current additive policy is checked separately.
  const result = validateMigrationClaimCohort({ claims: rows, expectedTargets: targets, resolveRef: resolveHistoricalQualityRef, predicatesByClaim: predicates });
  assert.deepEqual(result.errors, []);
  assert.equal(rows.length, targets.size);
  for (const claim of rows) {
    const approvedBoundedClaim = claim.claimId === "MPSEM-0354-C001";
    assert.equal(claim.semanticReviewStatus, approvedBoundedClaim
      ? "CLAIM_SPECIFIC_SEMANTIC_PARITY_VERIFIED"
      : "OWNER_TARGET_LOCATOR_ONLY_PENDING_CLAIM_PARITY", claim.claimId);
    assert.equal(claim.acceptanceEffect, "none", claim.claimId);
    if (approvedBoundedClaim) {
      assert.equal(claim.coordinatorReviewStatus, "APPROVED_BOUNDED_OWNER_SOURCE_SEMANTIC_ROUTE");
      assert.equal(claim.semanticReviewRef, "docs/implementation/verification/pdp-38/migration-coordinator-review-112.json#/records/@claimId=MPSEM-0354-C001");
    }
  }
});

test("PXD-100 person-inference addition is current-source evidence only; historical locator remains pending", () => {
  const claim = claims().find((row) => row.claimId === "MPSEM-0187-C002");
  const observation = JSON.parse(readFileSync(resolve(root, currentObservationPath), "utf8"));
  const observed = observation.records.find((row) => row.claimId === claim.claimId);
  const impact = JSON.parse(readFileSync(resolve(root, sourceImpactPath), "utf8"));
  const impactRecord = impact.records.find((row) => row.claimId === claim.claimId);
  const current = resolveRef(targets.get(claim.claimId));
  const historical = historicalQuality.personAndIdentityInferenceRule;
  const currentWithoutAddition = structuredClone(current);
  delete currentWithoutAddition.anonymousTrackIdsByDefault;

  assert.equal(claim.targetTextSha256, observed.priorHash, "the historical ledger pin is unchanged");
  assert.equal(claim.semanticReviewStatus, "OWNER_TARGET_LOCATOR_ONLY_PENDING_CLAIM_PARITY");
  assert.equal(observed.status, claim.semanticReviewStatus);
  assert.equal(observed.semanticEquivalence, "NOT_ASSERTED");
  assert.equal(observed.acceptanceEffect, "none");
  assert.equal(observed.targetRef, targets.get(claim.claimId));
  assert.equal(observed.currentHash, targetDigest(current));
  const impactSourceHash = createHash("sha256").update(readFileSync(resolve(root, qualityPath))).digest("hex");
  assert.equal(impactSourceHash, impactRecord.currentSourceFileSha256, "the additive source-impact artifact pins the live file separately");
  assert.equal(observed.sourceFileSha256, impactRecord.currentSourceFileSha256,
    "PXD-108's frozen current-file observation remains exact; later source edits invalidate this test until reviewed");
  assert.equal(targetDigest(historical), observed.priorHash, "the frozen source resolves the exact prior target value");
  assert.deepEqual(currentWithoutAddition, historical, "only the separately bounded anonymous-track rule was added to this target");
  assert.equal(impactRecord.historicalTargetValueSha256, observed.priorHash);
  assert.equal(impactRecord.currentTargetValueSha256, observed.currentHash);
  assert.deepEqual(impactRecord.addedPaths, ["#/personAndIdentityInferenceRule/anonymousTrackIdsByDefault"]);
  assert.equal(impactRecord.semanticPromotion, false);
  assert.equal(impactRecord.observationRef, `${currentObservationPath}#/records/@claimId=${claim.claimId}`);
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
