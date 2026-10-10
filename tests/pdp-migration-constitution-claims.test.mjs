import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { validateMigrationClaimCohort, validateMigrationClaimReview } from "../scripts/lib/pdp-migration-dependency-review.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const candidatePhase = process.env.PDP_MIGRATION_CANDIDATE_PHASE ?? "ALL";
if (!["ALL", "PDP-0"].includes(candidatePhase)) throw new Error(`PDP_MIGRATION_CANDIDATE_PHASE must be ALL or PDP-0; got ${candidatePhase}`);
const parseYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const migrationPath = ".product-experience/pdp-0-product-truth/migration-semantics-review.yaml";
const constitutionPath = ".product-experience/pdp-0-product-truth/constitution.yaml";
const typographyPath = ".product-experience/pdp-2-design-interface-system/typography-layout.yaml";
const migrationPathAlt = ".product-experience/pdp-0-product-truth/nonfunctional-requirements.yaml";
const channelsPath = ".product-experience/pdp-0-product-truth/applications-channels.yaml";
const migration = parseYaml(migrationPath);
const constitution = parseYaml(constitutionPath);
const typography = candidatePhase === "PDP-0" ? null : parseYaml(typographyPath);
const nfr = parseYaml(migrationPathAlt);
const channels = parseYaml(channelsPath);
const owners = new Map([[constitutionPath, constitution], ...(typography ? [[typographyPath, typography]] : []), [migrationPathAlt, nfr], [channelsPath, channels]]);
const sha = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");

const targets = new Map([
  ["MPSEM-0002-C001", `${constitutionPath}#requirements/@id=MEDIA-CONST-014/statement`],
  ["MPSEM-0076-C002", `${constitutionPath}#productMission/statement`],
  ["MPSEM-0314-C004", `${constitutionPath}#contractRealizationRule/rule`],
  ["MPSEM-0347-C001", `${constitutionPath}#domainRules/records/@id=MEDIA-DOMAIN-RULE-003/failClosed`],
  ["MPSEM-0354-C005", `${constitutionPath}#invariants/records/@id=MEDIA-INV-001/statement`],
  ["MPSEM-0355-C002", `${constitutionPath}#invariants/records/@id=MEDIA-INV-003/statement`],
  ["MPSEM-0355-C004", `${constitutionPath}#invariants/records/@id=MEDIA-INV-002/separateEligibilityEvaluation`],
  ["MPSEM-0355-C005", `${constitutionPath}#invariants/records/@id=MEDIA-INV-004/statement`],
  ["MPSEM-0357-C004", `${constitutionPath}#invariants/records/@id=MEDIA-INV-006/violation`],
  ["MPSEM-0368-C004", `${constitutionPath}#invariants/records/@id=MEDIA-INV-005/statement`],
  ["MPSEM-0369-C002", `${constitutionPath}#invariants/records/@id=MEDIA-INV-005/auditDurabilityDistinction`],
  ["MPSEM-0371-C002", `${constitutionPath}#invariants/records/@id=MEDIA-INV-004/untrustedContentBoundary`],
  ["MPSEM-0375-C005", `${constitutionPath}#domainRules/records/@id=MEDIA-DOMAIN-RULE-003/failClosed`],
  ["MPSEM-0038-C002", `${constitutionPath}#/invariants/records/@id=MEDIA-INV-005/diagnosticDeliveryGuaranteeRule`],
  ["MPSEM-0038-C003", `${constitutionPath}#/invariants/records/@id=MEDIA-INV-005/diagnosticFailureRule`],
  ["MPSEM-0453-C006", `${channelsPath}#/localeAdmission/requiredResilienceTestRule`],
]);

const predicates = new Map([
  ["MPSEM-0002-C001", ["suitable Ghatana reuse first", "approved permissively licensed external software", "before implementing replacement mechanics"]],
  ["MPSEM-0076-C002", ["deterministic DSP/computer vision", "procedural graphics", "simulation", "specialized AI/ML", "user intent", "rights", "privacy", "predictable costs"]],
  ["MPSEM-0314-C004", ["accepted owner contract", "where the ecosystem supports generation", "runtime response validation"]],
  ["MPSEM-0347-C001", ["OUTCOME_UNKNOWN", "authoritative reconciliation", "before retry or finality claims"]],
  ["MPSEM-0354-C005", ["private context does not imply local processing", "local processing does not imply authorized use"]],
  ["MPSEM-0355-C002", ["Source classification is a floor", "authorized deidentification promotion"]],
  ["MPSEM-0355-C004", ["consent evidence and license eligibility separately", "neither implies the other", "exact operation, purpose, profile, and effect scope"]],
  ["MPSEM-0355-C005", ["cannot authorize themselves"]],
  ["MPSEM-0357-C004", ["stop future dispatch", "restrict outputs", "without claiming an in-flight effect was terminated"]],
  ["MPSEM-0368-C004", ["Required audit intent must be recorded", "before crossing an external effect boundary"]],
  ["MPSEM-0369-C002", ["Required durable audit intent", "optional debug telemetry", "cannot substitute"]],
  ["MPSEM-0371-C002", ["Untrusted user or model content", "modify system policy", "select privileged tools", "exfiltrate other assets"]],
  ["MPSEM-0375-C005", ["OUTCOME_UNKNOWN", "authoritative reconciliation", "before retry or finality claims"]],
  ["MPSEM-0038-C002", ["ambient or best-effort label specifies no delivery", "ordering, persistence, or durability guarantee", "remote sink lag is a diagnostic delivery condition"]],
  ["MPSEM-0038-C003", ["Best-effort bounded diagnostics may be delayed, dropped, or unavailable without changing the business outcome", "Diagnostic failure cannot replace", "block the effect"]],
  ["MPSEM-0453-C006", ["Latin and Devanagari fixtures", "RTL or pseudo-localization", "bidi direction", "licensed font fallback", "script shaping", "translated-caption wrapping", "does not admit a locale"]],
]);

function resolveRef(ref) {
  const [source, pointer] = ref.split("#", 2);
  let value = owners.get(source);
  assert.ok(value, `target owner is in this fixed cohort: ${source}`);
  for (const raw of pointer.split("/").filter(Boolean)) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (segment.startsWith("@id=")) {
      assert.ok(Array.isArray(value), `stable identity selector resolves to a list: ${ref}`);
      value = value.find((entry) => entry.id === segment.slice(4));
    } else if (/^\d+$/u.test(segment)) value = value[Number(segment)];
    else value = value?.[segment];
    assert.notEqual(value, undefined, `owner target resolves: ${ref}`);
  }
  return value;
}

function claimRows() {
  return migration.pdp38ClaimReconciliation.records.flatMap((record) => record.claims ?? [])
    .flatMap((claim) => claim.subclaims ?? [claim]);
}

test("the fixed constitution, density, audit, and locale cohort resolves to exact owner clauses and current value pins", () => {
  const rows = claimRows().filter((claim) => targets.has(claim.claimId));
  const result = validateMigrationClaimCohort({ claims: rows, expectedTargets: targets, resolveRef, predicatesByClaim: predicates });
  assert.deepEqual(result.errors, []);
  assert.equal(rows.length, targets.size);
  for (const claim of rows) {
    assert.equal(claim.semanticReviewStatus, "CLAIM_SPECIFIC_SEMANTIC_PARITY_VERIFIED", claim.claimId);
    assert.match(claim.semanticReviewRef, /migration-policy-source-review\.json#\/records\/@claimId=/u);
    assert.equal(claim.acceptanceEffect, "none", claim.claimId);
  }
});

test("material, source, target and acceptance mutations fail the cohort validator", () => {
  const claimId = "MPSEM-0076-C002";
  const claim = claimRows().find((row) => row.claimId === claimId);
  const targetRef = targets.get(claimId);
  const sourceValue = resolveRef(targetRef);
  const required = predicates.get(claimId);
  assert.equal(validateMigrationClaimReview({ claim, expectedTargetRef: targetRef, targetValue: sourceValue, requiredPredicates: required }).valid, true);

  for (const missing of ["rights", "privacy", "predictable costs", "specialized AI/ML"]) {
    const altered = sourceValue.replace(missing, "omitted");
    const result = validateMigrationClaimReview({ claim, expectedTargetRef: targetRef, targetValue: altered, requiredPredicates: required });
    assert.equal(result.valid, false, `must reject removal of ${missing}`);
    assert.ok(result.errors.some((error) => error.startsWith("missing-material-predicate:")));
  }
  assert.equal(validateMigrationClaimReview({ claim, expectedTargetRef: `${targetRef}/wrong`, targetValue: sourceValue, requiredPredicates: required }).valid, false);
  assert.equal(validateMigrationClaimReview({ claim: { ...claim, sourceTextSha256: "0".repeat(64) }, expectedTargetRef: targetRef, targetValue: sourceValue, requiredPredicates: required }).valid, false);
  assert.equal(validateMigrationClaimReview({ claim: { ...claim, semanticReviewStatus: "PHASE_ACCEPTED", acceptanceEffect: "phase-accepted" }, expectedTargetRef: targetRef, targetValue: sourceValue, requiredPredicates: required }).valid, false);
});

test("fail-closed, policy separation and audit clauses reject weakened variants", () => {
  const source = resolveRef(targets.get("MPSEM-0347-C001"));
  const claim = claimRows().find((row) => row.claimId === "MPSEM-0347-C001");
  const altered = source.replace("authoritative reconciliation", "best-effort retry");
  assert.equal(validateMigrationClaimReview({ claim, expectedTargetRef: targets.get(claim.claimId), targetValue: altered, requiredPredicates: predicates.get(claim.claimId) }).valid, false);

  const consentRef = targets.get("MPSEM-0355-C004");
  const consent = resolveRef(consentRef);
  const consentClaim = claimRows().find((row) => row.claimId === "MPSEM-0355-C004");
  assert.equal(validateMigrationClaimReview({ claim: consentClaim, expectedTargetRef: consentRef, targetValue: consent.replace("neither implies the other", "either implies the other"), requiredPredicates: predicates.get(consentClaim.claimId) }).valid, false);

  const auditRef = targets.get("MPSEM-0369-C002");
  const audit = resolveRef(auditRef);
  const auditClaim = claimRows().find((row) => row.claimId === "MPSEM-0369-C002");
  assert.equal(validateMigrationClaimReview({ claim: auditClaim, expectedTargetRef: auditRef, targetValue: audit.replace("cannot substitute", "may substitute"), requiredPredicates: predicates.get(auditClaim.claimId) }).valid, false);
});

test("the human-readable Simple/Guided/Expert density progression is not collapsed", { skip: candidatePhase === "PDP-0" }, () => {
  const target = `${typographyPath}#density`;
  const density = resolveRef(target);
  assert.equal(Object.keys(density).sort().join(","), "expert,guided,simple");
  assert.match(density.simple, /one primary task/u);
  assert.match(density.guided, /rights status/u);
  assert.match(density.expert, /no hidden change to action meaning/u);
  const missingSummary = structuredClone(density);
  missingSummary.simple = "primary task";
  const claim = claimRows().find((row) => row.claimId === "MPSEM-0442-C001");
  const required = ["intent and safe defaults", "one primary task", "next safe action", "quality", "style", "duration", "reference", "output", "privacy", "same state and actions", "typed graph", "curves", "solver limits", "generation", "color", "audio", "encoding controls", "no hidden change to action meaning or authority"];
  assert.equal(validateMigrationClaimReview({ claim, expectedTargetRef: target, targetValue: missingSummary, requiredPredicates: required }).valid, false);
  for (const field of ["guided", "expert"]) {
    for (const option of field === "guided" ? ["style", "duration", "reference", "output", "privacy"] : ["typed graph", "curves", "solver limits", "generation", "color", "audio", "encoding"]) {
      const weakened = structuredClone(density);
      weakened[field] = weakened[field].replace(option, "removed");
      assert.equal(validateMigrationClaimReview({ claim, expectedTargetRef: target, targetValue: weakened, requiredPredicates: required }).valid, false, `${field} must retain ${option}`);
    }
  }
});

test("audit and telemetry clauses keep best-effort delivery separate from required durable effect intent", () => {
  const deliveryId = "MPSEM-0038-C002";
  const deliveryClaim = claimRows().find((row) => row.claimId === deliveryId);
  const deliveryRef = targets.get(deliveryId);
  const delivery = resolveRef(deliveryRef);
  assert.equal(validateMigrationClaimReview({ claim: deliveryClaim, expectedTargetRef: deliveryRef, targetValue: delivery, requiredPredicates: predicates.get(deliveryId) }).valid, true);
  assert.equal(validateMigrationClaimReview({ claim: deliveryClaim, expectedTargetRef: deliveryRef, targetValue: delivery.replace("specifies no delivery", "guarantees delivery"), requiredPredicates: predicates.get(deliveryId) }).valid, false);

  const failureId = "MPSEM-0038-C003";
  const failureClaim = claimRows().find((row) => row.claimId === failureId);
  const failureRef = targets.get(failureId);
  const failure = resolveRef(failureRef);
  assert.equal(validateMigrationClaimReview({ claim: failureClaim, expectedTargetRef: failureRef, targetValue: failure, requiredPredicates: predicates.get(failureId) }).valid, true);
  assert.equal(validateMigrationClaimReview({ claim: failureClaim, expectedTargetRef: failureRef, targetValue: failure.replace("without changing the business outcome", "and changes the business outcome"), requiredPredicates: predicates.get(failureId) }).valid, false);
});
