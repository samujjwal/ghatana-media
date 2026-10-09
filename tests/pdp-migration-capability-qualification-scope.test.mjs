import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const quality = parse(await readFile(".product-experience/pdp-0-product-truth/quality-policy.yaml", "utf8"));
const domainModel = parse(await readFile(".product-experience/pdp-0-product-truth/domain-model.yaml", "utf8"));
const claims = JSON.parse(await readFile("docs/implementation/verification/pdp-38/migration-capability-reviewed.json", "utf8"));

test("metric qualification is bound to an exact metric-domain-provider-method and calibration tuple", () => {
  const rule = quality.qualificationScopeIdentity;
  assert.equal(rule.id, "media.quality.qualification-scope-identity");
  assert.deepEqual(rule.exactTuple.requiredFields, [
    "metricRef", "metricVersion", "domainRef", "providerRef", "methodRef", "methodVersion", "modelRef", "modelVersion",
    "applicabilityScopeRef", "calibrationScopeRef", "calibrationVersion",
  ]);
  assert.match(rule.semantics.join(" "), /full exact tuple/u);
  assert.match(rule.semantics.join(" "), /Any changed or missing tuple member/u);
  assert.match(rule.semantics.join(" "), /does not assert that evidence exists/u);
  assert.deepEqual(rule.nonClaims, ["no-measured-qualification", "no-provider-or-model-admission", "no-runtime-availability"]);

  const claim = claims.records.find(({ claimId }) => claimId === "MPSEM-0035-C003");
  assert.ok(claim);
  assert.equal(claim.exactSourceText, "Qualification per metric/domain/provider");
  assert.equal(claim.semanticReviewStatus, "OWNER_TARGET_LOCATOR_ONLY_PENDING_SEMANTIC_PARITY");
  assert.equal(claim.acceptanceEffect, "none");
});

test("ordinary recipe structure never grants agent-runtime or tool-execution authority", () => {
  const recipe = domainModel.proposedRecordCatalog.find(({ id }) => id === "MediaRecipe");
  const boundary = recipe.agentRuntimeBoundary;
  assert.equal(boundary.status, "owner-defined-definition-only; implementation-and-independent-review-open");
  assert.match(boundary.rule, /not an agent-runtime graph/u);
  assert.match(boundary.rule, /does not grant agent, tool, model, or privileged execution authority/u);
  assert.match(boundary.rule, /does not itself dispatch work/u);
  assert.match(boundary.integrationRequirement, /separate exact authorized contract/u);
  assert.match(boundary.integrationRequirement, /trusted principal and authority scope/u);
  assert.match(boundary.integrationRequirement, /Missing fields or authority block dispatch/u);
  assert.equal(boundary.state, "NOT_ADMITTED");
  assert.equal(boundary.runtimeQualification, "NOT_EVALUATED");

  const claim = claims.records.find(({ claimId }) => claimId === "MPSEM-0095-C004");
  assert.ok(claim);
  assert.match(claim.exactSourceText, /ordinary media recipes are not agent graphs/u);
  assert.equal(claim.proposedTargetRef, ".product-experience/pdp-0-product-truth/domain-model.yaml#/proposedRecordCatalog/@id=MediaRecipe/agentRuntimeBoundary");
  assert.equal(claim.semanticReviewStatus, "SEMANTIC_PARITY_VERIFIED");
  assert.equal(claim.targetValueSha256, createHash("sha256").update(JSON.stringify(boundary)).digest("hex"));
  assert.ok(claim.reviewedPredicates.some(({ predicate }) => predicate === "claim-specific-owner-policy-scope-and-open-limitations-verified"));
  assert.ok(claim.testSources.includes("tests/pdp-migration-capability-material-claims.test.mjs"));
  assert.ok(claim.negativeCases.some((item) => /Shared workflow\/orchestration mechanics do not establish production Media execution/u.test(item)));
  assert.ok(claim.negativeCases.some((item) => /remain NOT_ADMITTED and NOT_EVALUATED/u.test(item)));
  assert.equal(claim.acceptanceEffect, "none");
});
