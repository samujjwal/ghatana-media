import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { validateMigrationClaimCohort, validateMigrationClaimReview } from "../scripts/lib/pdp-migration-dependency-review.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const parseYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const migrationPath = ".product-experience/pdp-0-product-truth/migration-semantics-review.yaml";
const dependencyPath = ".product-experience/pdp-0-product-truth/dependency-contracts.yaml";
const reusePath = ".product-experience/pdp-0-product-truth/reuse-decisions.yaml";
const cliPath = ".product-experience/pdp-2-design-interface-system/cli-language.yaml";
const migration = parseYaml(migrationPath);
const dependency = parseYaml(dependencyPath);
const reuse = parseYaml(reusePath);
const cli = parseYaml(cliPath);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const owners = new Map([[dependencyPath, dependency], [reusePath, reuse], [cliPath, cli]]);

const reviewedTargets = new Map([
  ["MPSEM-0024-C003", ".product-experience/pdp-0-product-truth/dependency-contracts.yaml#dependencyContracts/8/ownerBoundaryRule"],
  ["MPSEM-0026-C002", ".product-experience/pdp-0-product-truth/dependency-contracts.yaml#ownerDefinedImportBoundary/documentExtractionWorkerRule"],
  ["MPSEM-0029-C002", ".product-experience/pdp-0-product-truth/dependency-contracts.yaml#ownerDefinedImportBoundary/platformMechanicsBoundary"],
  ["MPSEM-0046-C004", ".product-experience/pdp-0-product-truth/dependency-contracts.yaml#ownerDefinedImportBoundary/replacementRule"],
  ["MPSEM-0056-C001", ".product-experience/pdp-0-product-truth/dependency-contracts.yaml#ownerDefinedImportBoundary/observedLegacyPublicCoordinates"],
  ["MPSEM-0057-C002", ".product-experience/pdp-0-product-truth/dependency-contracts.yaml#ownerDefinedImportBoundary/newPublicNameRule"],
  ["MPSEM-0070-C001", ".product-experience/pdp-0-product-truth/dependency-contracts.yaml#ownerDefinedImportBoundary/exactImportProhibitions"],
  ["MPSEM-0073-C001", ".product-experience/pdp-0-product-truth/dependency-contracts.yaml#ownerDefinedImportBoundary/portfolioRegistryBoundary"],
  ["MPSEM-0092-C001", ".product-experience/pdp-0-product-truth/dependency-contracts.yaml#dependencies/4/surfaces/0"],
  ["MPSEM-0092-C002", ".product-experience/pdp-0-product-truth/dependency-contracts.yaml#dependencies/4/surfaces/1"],
  ["MPSEM-0092-C004", ".product-experience/pdp-0-product-truth/dependency-contracts.yaml#ownerDefinedImportBoundary/toolsLifecycleNonAuthorityRule"],
  ["MPSEM-0093-C001", ".product-experience/pdp-0-product-truth/dependency-contracts.yaml#dependencyContracts/14/ownerBoundaryRule"],
  ["MPSEM-0095-C001", ".product-experience/pdp-0-product-truth/dependency-contracts.yaml#ownerDefinedImportBoundary/exactImportProhibitions/1"],
  ["MPSEM-0097-C004", ".product-experience/pdp-0-product-truth/dependency-contracts.yaml#dependencyContracts/1/ownerBoundaryRule"],
  ["MPSEM-0165-C003", ".product-experience/pdp-0-product-truth/dependency-contracts.yaml#ownerDefinedImportBoundary/portfolioProjectionRule"],
  ["MPSEM-0166-C004", ".product-experience/pdp-0-product-truth/dependency-contracts.yaml#ownerDefinedImportBoundary/historicalOssInventoryClaim"],
  ["MPSEM-0340-C001", ".product-experience/pdp-2-design-interface-system/cli-language.yaml#machineOutput/productExitCodeTaxonomy/codes/@id=media.cli.exit.authentication-failure"],
  ["MPSEM-0356-C001", ".product-experience/pdp-0-product-truth/dependency-contracts.yaml#ownerDefinedImportBoundary/sharedIdentitySecurityAndGovernanceReuseRule"],
  ["MPSEM-0374-C001", ".product-experience/pdp-0-product-truth/dependency-contracts.yaml#dependencyContracts/0/ownerBoundaryRule"],
  ["MPSEM-0374-C003", ".product-experience/pdp-0-product-truth/dependency-contracts.yaml#dependencyContracts/1/ownerBoundaryRule"],
  ["MPSEM-0374-C004", ".product-experience/pdp-0-product-truth/dependency-contracts.yaml#dependencyContracts/1/ownerBoundaryRule"],
  ["MPSEM-0455-C002", ".product-experience/pdp-0-product-truth/reuse-decisions.yaml#mediaArchitectureRules/genericMechanicsBoundary"],
  ["MPSEM-0469-C002", ".product-experience/pdp-0-product-truth/dependency-contracts.yaml#ownerDefinedImportBoundary/documentExtractionWorkerRule"],
]);

const predicatesByClaim = new Map([
  ["MPSEM-0024-C003", ["governed generic read models", "Media remains authoritative", "existing integration behavior"]],
  ["MPSEM-0026-C002", ["frozen Shared document-extraction contracts", "worker owner retains cancellation/admission", "Media authorization before invocation"]],
  ["MPSEM-0029-C002", ["candidate neutral command", "candidate claim-aware outbox", "package versions and Media consumer adoption remain unverified", "Media owns domain states/guards"]],
  ["MPSEM-0046-C004", ["neutral versioned capability contracts", "single registered authored owner", "explicitly approved public integration provider"]],
  ["MPSEM-0056-C001", ["@audio-video/types", "@audio-video/client", "@audio-video/ui", "@audio-video/desktop-app"]],
  ["MPSEM-0057-C002", ["product registry export policy", "without creating parallel duplicate behavior"]],
  ["MPSEM-0070-C001", ["ghatana/services/**", "ghatana-kernel implementation internals", "another product's internal packages", "Ghatana Tools implementation internals"]],
  ["MPSEM-0073-C001", ["portfolio and extraction identity", "not a runtime or source dependency"]],
  ["MPSEM-0092-C001", ["reusable Product Definition and Experience mechanics"]],
  ["MPSEM-0092-C002", ["generic Experience Explorer host and package mechanics"]],
  ["MPSEM-0092-C004", ["does not decide Media meaning", "Lifecycle owns evidence admission, closure and receipts"]],
  ["MPSEM-0093-C001", ["lifecycle, composition, UI/page/resource/action contracts", "explicit reviewed public-contract adoption"]],
  ["MPSEM-0095-C001", ["ghatana/services/agents/**"]],
  ["MPSEM-0097-C004", ["candidate claim-aware publication mechanics", "public package version and Media consumer adoption are unverified", "Media owns the durable outbox intent"]],
  ["MPSEM-0165-C003", ["only when the portfolio registry requires them", "accepted Phase-0 records", "do not become a runtime or source dependency of Media"]],
  ["MPSEM-0356-C001", ["existing authentication services", "identity, security, and governance contracts", "reviewed public boundaries", "Media separately decides operation-specific purpose", "Missing public contract/version or consumer binding remains an owner dependency"]],
  ["MPSEM-0374-C001", ["Shared supplies neutral command/state/CAS/idempotency/lease mechanics", "Media defines legal state transitions"]],
  ["MPSEM-0374-C003", ["candidate claim-aware publication mechanics", "public package version and Media consumer adoption are unverified", "Media owns the durable outbox intent"]],
  ["MPSEM-0374-C004", ["public package version and Media consumer adoption are unverified", "retry cadence", "truthful publication-finality disposition"]],
  ["MPSEM-0455-C002", ["behind Media-owned adapters", "exact public contract satisfies the Media operation guard and finality requirements"]],
  ["MPSEM-0469-C002", ["frozen Shared document-extraction contracts", "worker owner retains cancellation/admission behavior"]],
]);

function resolveRef(ref) {
  const [source, pointer] = ref.split("#", 2);
  let value = owners.get(source);
  assert.ok(value, `owner is in the reviewed dependency/CLI set: ${source}`);
  for (const raw of pointer.split("/").filter(Boolean)) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (segment.startsWith("@id=")) {
      assert.ok(Array.isArray(value), `stable-ID selector resolves a list in ${ref}`);
      value = value.find((entry) => entry.id === segment.slice(4));
    } else if (/^\d+$/u.test(segment)) value = value[Number(segment)];
    else value = value?.[segment];
    assert.notEqual(value, undefined, `owner target resolves: ${ref}`);
  }
  return value;
}

function allClaimRows() {
  return migration.pdp38ClaimReconciliation.records.flatMap((record) => record.claims ?? [])
    .flatMap((claim) => claim.subclaims ?? [claim]);
}

function materialText(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

test("the finite dependency migration cohort has exact owner clauses and claim-level source pins", () => {
  assert.equal(reviewedTargets.size, 23);
  const rows = allClaimRows().filter((claim) => reviewedTargets.has(claim.claimId));
  const result = validateMigrationClaimCohort({
    claims: rows,
    expectedTargets: reviewedTargets,
    resolveRef,
    predicatesByClaim,
  });
  assert.deepEqual(result.errors, [], "the fixed cohort must match exact claim membership and owner-source semantics");
  for (const [claimId, review] of result.results) assert.equal(review.valid, true, claimId);
  const approved = new Map(JSON.parse(readFileSync("docs/implementation/verification/pdp-38/migration-policy-source-review.json", "utf8")).records.map((record) => [record.claimId, record]));
  for (const claim of rows) {
    if (approved.has(claim.claimId)) {
      assert.equal(claim.semanticReviewStatus, "CLAIM_SPECIFIC_SEMANTIC_PARITY_VERIFIED", claim.claimId);
      assert.match(claim.semanticReviewRef, /migration-policy-source-review\.json#\/records\/@claimId=/u);
    } else {
      assert.equal(claim.claimId, "MPSEM-0166-C004", "only the absent historical OSS inventory remains excluded from the approved cohort");
      assert.equal(claim.semanticReviewStatus, "OWNER_TARGET_LOCATOR_ONLY_PENDING_CLAIM_PARITY");
    }
  }
});

test("dependency claim review rejects material-clause loss, wrong target, stale hash, and forged acceptance", () => {
  const claimId = "MPSEM-0026-C002";
  const claim = allClaimRows().find((row) => row.claimId === claimId);
  const expectedTargetRef = reviewedTargets.get(claimId);
  const targetValue = resolveRef(expectedTargetRef);
  const requiredPredicates = predicatesByClaim.get(claimId);
  assert.equal(validateMigrationClaimReview({ claim, expectedTargetRef, targetValue, requiredPredicates }).valid, true);

  const missingClause = targetValue.replace("worker owner retains cancellation/admission behavior", "");
  const missing = validateMigrationClaimReview({ claim, expectedTargetRef, targetValue: missingClause, requiredPredicates });
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.some((error) => error.startsWith("missing-material-predicate:")));

  const wrongTarget = validateMigrationClaimReview({ claim, expectedTargetRef: `${expectedTargetRef}/wrong`, targetValue, requiredPredicates });
  assert.ok(wrongTarget.errors.includes("wrong-owner-target"));
  const stalePin = validateMigrationClaimReview({ claim: { ...claim, targetTextSha256: "0".repeat(64) }, expectedTargetRef, targetValue, requiredPredicates });
  assert.ok(stalePin.errors.includes("owner-target-digest-mismatch"));
  const forgedAcceptance = validateMigrationClaimReview({ claim: { ...claim, semanticReviewStatus: "INDEPENDENT_ACCEPTED", acceptanceEffect: "phase-accepted" }, expectedTargetRef, targetValue, requiredPredicates });
  assert.ok(forgedAcceptance.errors.includes("forged-independent-or-phase-acceptance"));
  assert.ok(forgedAcceptance.errors.includes("acceptance-effect-must-remain-none"));

  const missingClaim = validateMigrationClaimCohort({
    claims: allClaimRows().filter((row) => reviewedTargets.has(row.claimId) && row.claimId !== claimId),
    expectedTargets: reviewedTargets,
    resolveRef,
    predicatesByClaim,
  });
  assert.equal(missingClaim.valid, false);
  assert.ok(missingClaim.errors.includes(`missing-claim:${claimId}`));
});

test("the absent historical OSS inventory stays unresolved instead of being treated as a current authoritative inventory", () => {
  const rows = new Map(allClaimRows().map((claim) => [claim.claimId, claim]));
  const claim = rows.get("MPSEM-0166-C004");
  const historicalNote = resolveRef(reviewedTargets.get("MPSEM-0166-C004"));
  assert.match(historicalNote, /config\/oss-components\.yaml/u);
  assert.match(historicalNote, /absent from the current checkout/u);
  assert.match(historicalNote, /remains unresolved/u);
  assert.equal(claim.semanticReviewStatus, "OWNER_TARGET_LOCATOR_ONLY_PENDING_CLAIM_PARITY");
  assert.equal(claim.targetTextSha256, sha(historicalNote));
  assert.equal(/exact technical supply-chain inventory and admission evidence/u.test(historicalNote), false,
    "the historical claim must not be promoted from a source path that is absent");
});

test("the shared identity handoff preserves existing auth services and public-contract dependencies", () => {
  const claim = allClaimRows().find((row) => row.claimId === "MPSEM-0356-C001");
  const targetRef = `${dependencyPath}#ownerDefinedImportBoundary/sharedIdentitySecurityAndGovernanceReuseRule`;
  const value = resolveRef(targetRef);
  const predicates = ["existing authentication services", "identity, security, and governance contracts", "reviewed public boundaries", "Media separately decides operation-specific purpose", "Missing public contract/version or consumer binding remains an owner dependency"];
  assert.equal(validateMigrationClaimReview({ claim, expectedTargetRef: targetRef, targetValue: value, requiredPredicates: predicates }).valid, true);
  for (const [needle, replacement] of [
    ["existing authentication services", "new Media authentication service"],
    ["security, and governance contracts", "UI styles"],
    ["reviewed public boundaries", "private source imports"],
    ["remains an owner dependency", "is automatically admitted"],
  ]) {
    const weakened = value.replace(needle, replacement);
    assert.equal(validateMigrationClaimReview({ claim, expectedTargetRef: targetRef, targetValue: weakened, requiredPredicates: predicates }).valid, false, `must reject removal of ${needle}`);
  }
});

test("CLI exit code 3 means authentication failure and cannot collapse into policy rejection", () => {
  const record = resolveRef(reviewedTargets.get("MPSEM-0340-C001"));
  assert.deepEqual(record, { id: "media.cli.exit.authentication-failure", code: 3, result: "authentication-failure" });
  const distinctions = cli.machineOutput.productExitCodeTaxonomy.distinctions;
  assert.ok(distinctions.includes("authentication-failure-is-not-authorization-or-rights-rejection"));
  assert.ok(distinctions.includes("production-runtime-exit-code-mapping-remains-owner-review-pending"));
  const falseContract = structuredClone(cli.machineOutput.productExitCodeTaxonomy);
  falseContract.codes.find((entry) => entry.id === "media.cli.exit.authentication-failure").result = "authorization-privacy-rights-or-policy-rejection";
  assert.notDeepEqual(falseContract.codes.find((entry) => entry.code === 3), record,
    "authentication and authorization failures remain distinct result classes");
});
