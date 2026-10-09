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
const profilePath = ".product-experience/pdp-0-product-truth/profile-semantics.yaml";
const profile = parseYaml(profilePath);
const migration = parseYaml(migrationPath);
const reviewedClaims = new Set(JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/migration-profile-handoff-source-review.json"), "utf8")).records.map(({ claimId }) => claimId));
const owners = new Map([[profilePath, profile]]);
const targets = new Map([
  ["MPSEM-0166-C001", `${profilePath}#/candidateDeliveryProfiles/@id=media.delivery-profile.webm-opus-av1-permissive/sourceAuthority`],
  ["MPSEM-0267-C001", `${profilePath}#/profileAxes/@id=PROFILE-AXIS-REPRODUCIBILITY/meanings/EXACT_ENVIRONMENT`],
  ["MPSEM-0269-C001", `${profilePath}#/profileAxes/@id=PROFILE-AXIS-REPRODUCIBILITY/meanings/STATISTICAL`],
  ["MPSEM-0270-C002", `${profilePath}#/profileAxes/@id=PROFILE-AXIS-REPRODUCIBILITY/meanings/REPLAY_UNAVAILABLE`],
  ["MPSEM-0271-C002", `${profilePath}#/profileAxes/@id=PROFILE-AXIS-REPRODUCIBILITY/axisRule`],
  ["MPSEM-0285-C001", `${profilePath}#/fallbackSemantics/permissionFields/qualityIntentChange/rule`],
  ["MPSEM-0285-C002", `${profilePath}#/orthogonalityRules/@id=PROFILE-RULE-CINEMATIC-ALIAS/rule`],
  ["MPSEM-0286-C002", `${profilePath}#/profileAxes/@id=PROFILE-AXIS-RESOURCE/axisRule`],
  ["MPSEM-0287-C003", `${profilePath}#/fallbackSemantics/permissionFields/executionLocationChange/localOnlyRule`],
  ["MPSEM-0288-C003", `${profilePath}#/profileAxes/@id=PROFILE-AXIS-PRESERVATION/values/@id=PRESERVATION-MODE-ENHANCE/meaning`],
  ["MPSEM-0288-C004", `${profilePath}#/profileAxes/@id=PROFILE-AXIS-PRESERVATION/values/@id=PRESERVATION-MODE-CREATIVE/meaning`],
  ["MPSEM-0289-C002", `${profilePath}#/profileAxes/@id=PROFILE-AXIS-DELIVERY/axisRule`],
  ["MPSEM-0290-C001", `${profilePath}#/orthogonalityRules/@id=PROFILE-RULE-TEST-ONLY/rule`],
  ["MPSEM-0291-C008", `${profilePath}#/fallbackSemantics/permissionFields/qualityIntentChange/rule`],
]);
const predicates = new Map([
  ["MPSEM-0166-C001", ["reuse-decisions.yaml"]],
  ["MPSEM-0267-C001", ["Identical declared output representation", "evidence-backed", "engine/model/runtime/hardware/configuration/assets/seed"]],
  ["MPSEM-0269-C001", ["Repeated outputs", "named distribution/quality protocol", "seed does not promise identical output"]],
  ["MPSEM-0270-C002", ["Preserve inputs, outputs, and execution provenance", "do not offer unsupported reproduction"]],
  ["MPSEM-0271-C002", ["Render determinism", "solver determinism", "encoded-byte determinism", "separate claims"]],
  ["MPSEM-0285-C001", ["OOM or capacity pressure alone", "does not authorize lowering", "master/high-quality", "preview/balanced"]],
  ["MPSEM-0285-C002", ["presentation/template alias", "explicit quality-intent plus delivery-profile combination", "not a new independent quality or execution policy"]],
  ["MPSEM-0286-C002", ["Resource savings alone", "not authorize lower fidelity", "quality", "resolution", "duration", "frame rate"]],
  ["MPSEM-0287-C003", ["Remote or cloud execution", "never an implicit fallback", "local-only intent"]],
  ["MPSEM-0288-C003", ["bounded", "authorized perceptual reconstruction", "preservation and quality constraints"]],
  ["MPSEM-0288-C004", ["admitted generative edits", "current rights", "privacy", "safety", "effect authority"]],
  ["MPSEM-0289-C002", ["exact codec/container", "color/audio/caption", "target", "compatibility constraints", "do not imply format support or qualification"]],
  ["MPSEM-0290-C001", ["deterministic-test", "fixture/test binding", "never a production provider or runtime profile"]],
  ["MPSEM-0291-C008", ["OOM or capacity pressure alone", "does not authorize lowering", "master/high-quality", "preview/balanced"]],
]);

function resolveRef(ref) {
  const [source, pointer] = ref.split("#", 2);
  let value = owners.get(source);
  assert.ok(value, `owner in fixed profile cohort: ${source}`);
  for (const raw of pointer.split("/").filter(Boolean)) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (segment.startsWith("@id=")) {
      assert.ok(Array.isArray(value), `stable identity selector resolves to list: ${ref}`);
      value = value.find((entry) => entry.id === segment.slice(4));
    } else if (/^\d+$/u.test(segment)) value = value[Number(segment)];
    else value = value?.[segment];
    assert.notEqual(value, undefined, `owner target resolves: ${ref}`);
  }
  return value;
}
const claims = () => migration.pdp38ClaimReconciliation.records.flatMap((record) => record.claims ?? []).flatMap((claim) => claim.subclaims ?? [claim]);

test("the fixed profile-semantics migration cohort preserves per-axis material meaning", () => {
  const rows = claims().filter((claim) => targets.has(claim.claimId));
  const result = validateMigrationClaimCohort({ claims: rows, expectedTargets: targets, resolveRef, predicatesByClaim: predicates });
  assert.deepEqual(result.errors, []);
  assert.equal(rows.length, targets.size);
  for (const claim of rows) {
    const approved = reviewedClaims.has(claim.claimId);
    assert.equal(claim.semanticReviewStatus, approved ? "CLAIM_SPECIFIC_SEMANTIC_PARITY_VERIFIED" : "OWNER_TARGET_LOCATOR_ONLY_PENDING_CLAIM_PARITY", claim.claimId);
    if (approved) assert.equal(claim.semanticReviewRef, `docs/implementation/verification/pdp-38/migration-profile-handoff-source-review.json#/records/@claimId=${claim.claimId}`);
    assert.equal(claim.acceptanceEffect, "none", claim.claimId);
  }
});

test("profile material mutations cannot erase independent constraints or turn fallback into permission", () => {
  const cases = [
    ["MPSEM-0267-C001", "evidence-backed", "assumed"],
    ["MPSEM-0271-C002", "separate claims", "one claim"],
    ["MPSEM-0285-C001", "does not authorize lowering", "authorizes lowering"],
    ["MPSEM-0287-C003", "never an implicit fallback", "is an implicit fallback"],
    ["MPSEM-0290-C001", "never a production provider", "is a production provider"],
  ];
  for (const [claimId, search, replacement] of cases) {
    const claim = claims().find((row) => row.claimId === claimId);
    const targetRef = targets.get(claimId);
    const actual = resolveRef(targetRef);
    const source = typeof actual === "string" ? actual : JSON.stringify(actual);
    const mutation = source.replace(search, replacement);
    assert.notEqual(mutation, source, `mutation applies to ${claimId}`);
    assert.equal(validateMigrationClaimReview({ claim, expectedTargetRef: targetRef, targetValue: mutation, requiredPredicates: predicates.get(claimId) }).valid, false, claimId);
  }
});
