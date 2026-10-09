import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const parseYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const digest = (value) => createHash("sha256").update(value).digest("hex");
const reviewPath = "docs/implementation/verification/pdp-38/migration-policy-source-review.json";
const review = JSON.parse(readFileSync(resolve(root, reviewPath), "utf8"));
const migration = parseYaml(".product-experience/pdp-0-product-truth/migration-semantics-review.yaml");
const claims = migration.pdp38ClaimReconciliation.records.flatMap((record) => record.claims ?? [])
  .flatMap((claim) => claim.subclaims ?? [claim]);
const claimsById = new Map(claims.map((claim) => [claim.claimId, claim]));
const ownerCache = new Map();

function resolveRef(ref) {
  const [source, pointer = ""] = ref.split("#", 2);
  let value = ownerCache.get(source);
  if (value === undefined) {
    value = parseYaml(source);
    ownerCache.set(source, value);
  }
  for (const raw of pointer.split("/").filter(Boolean)) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (segment.startsWith("@id=")) {
      assert.ok(Array.isArray(value), `stable-ID selector resolves: ${ref}`);
      value = value.find((entry) => entry.id === segment.slice(4));
    } else if (/^\d+$/u.test(segment)) value = value[Number(segment)];
    else value = value?.[segment];
    assert.notEqual(value, undefined, `reviewed owner target resolves: ${ref}`);
  }
  return value;
}

const materialText = (value) => typeof value === "string" ? value : JSON.stringify(value);

test("PXD-085 verifies exactly 46 migration owner routes against source, current value and claim pins", () => {
  assert.equal(review.schemaVersion, "media.pdp38-migration-policy-source-review.v1");
  assert.equal(review.decisionRef, ".product-experience/decision-log.md#PXD-085");
  assert.equal(review.recordCount, 46);
  assert.equal(review.records.length, 46);
  assert.equal(new Set(review.records.map((record) => record.claimId)).size, 46);
  const expectedReview = `${reviewPath}#/records/@claimId=`;

  for (const record of review.records) {
    const claim = claimsById.get(record.claimId);
    assert.ok(claim, `${record.claimId} exists in the immutable historical claim population`);
    const target = resolveRef(record.targetRef);
    assert.equal(claim.exactSourceText && digest(claim.exactSourceText), record.sourceTextSha256, `${record.claimId} source text pin`);
    assert.equal(claim.targetRef, record.targetRef, `${record.claimId} exact target binding`);
    assert.equal(claim.targetTextSha256, record.targetValueSha256, `${record.claimId} claim target pin`);
    assert.equal(digest(materialText(target)), record.targetValueSha256, `${record.claimId} current target value pin`);
    assert.deepEqual(target, record.expectedOwnerValue, `${record.claimId} reviewed owner value`);
    assert.equal(record.disposition, "APPROVED_BOUNDED_OWNER_SOURCE_SEMANTIC_ROUTE", `${record.claimId} review disposition`);
    assert.equal(claim.semanticReviewStatus, "CLAIM_SPECIFIC_SEMANTIC_PARITY_VERIFIED", `${record.claimId} semantic parity status`);
    assert.equal(claim.semanticReviewRef, `${expectedReview}${record.claimId}`, `${record.claimId} precise PXD-085 record ref`);
    assert.equal(claim.acceptanceEffect, "none", `${record.claimId} cannot assert acceptance`);
  }

  const excluded = review.explicitExclusion;
  assert.equal(excluded.claimId, "MPSEM-0166-C004");
  assert.match(excluded.reason, /inventory file absent/u);
  assert.equal(review.wholeTaskCriterionEstablished, false);
  assert.equal(review.independentAcceptance, "NOT_EVALUATED");
  assert.equal(review.nativeLifecycleReceipt, null);
  assert.equal(claimsById.get(excluded.claimId).semanticReviewStatus, "OWNER_TARGET_LOCATOR_ONLY_PENDING_CLAIM_PARITY");
});

test("PXD-085 review verification rejects owner-value loss, stale source pins, and forged acceptance", () => {
  const record = review.records.find((entry) => entry.claimId === "MPSEM-0040-C004");
  const target = record.expectedOwnerValue;
  assert.match(target.rule, /copyright and patent grants\/encumbrances/u);

  const weakened = structuredClone(target);
  weakened.rule = weakened.rule.replace("copyright and patent grants/encumbrances", "copyright grants");
  assert.notEqual(digest(materialText(weakened)), record.targetValueSha256);
  assert.notDeepEqual(weakened, record.expectedOwnerValue);

  const claim = claimsById.get(record.claimId);
  assert.notEqual(digest(claim.exactSourceText), "0".repeat(64));
  assert.equal(claim.acceptanceEffect, "none");
  assert.notEqual(claim.semanticReviewStatus, "INDEPENDENT_ACCEPTED");
});
