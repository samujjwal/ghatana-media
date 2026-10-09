import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { resolvePdp3BindingSourceRef } from "./helpers/pdp-migration-source-selector.mjs";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const [partition, rules, review] = await Promise.all([
  readFile("docs/implementation/verification/pdp-38/migration-pending-owner-partition-499.json", "utf8").then(JSON.parse),
  readFile(".product-experience/pdp-3-product-experience/migration-semantic-rules.yaml", "utf8").then(parse),
  readFile("docs/implementation/verification/pdp-38/experience-40-migration-candidate-review.json", "utf8").then(JSON.parse),
]);
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Independent, claim-specific meaning guards. These do not promote status;
// they prevent a long replacement sentence plus refreshed hash from erasing
// a source obligation while the candidate still resolves syntactically.
const meaningPredicates = {
  "MPSEM-0003-C003": ["stays a proposal", "parallel semantic authority"],
  "MPSEM-0003-C005": ["remain execution references", "phase acceptance"],
  "MPSEM-0055-C003": ["Java namespaces remain compatible", "approved compatibility map"],
  "MPSEM-0091-C003": ["accepted published Shared contracts", "rather than copying Shared implementations"],
  "MPSEM-0101-C001": ["owned by the domain product", "never makes clinical or KYC decisions"],
  "MPSEM-0122-C003": ["single structured requirement register", "not a second editable rule set"],
  "MPSEM-0178-C003": ["Declared, qualified and currently available are distinct", "does not prove present availability"],
  "MPSEM-0204-C003": ["exact source", "measured deltas are explicit"],
  "MPSEM-0225-C002": ["mutable execution progression", "do not mutate the source graph"],
  "MPSEM-0280-C001": ["deterministic measurements", "sufficient for the requested analysis or decision"],
  "MPSEM-0280-C003": ["authorized preservation and cost bounds", "LLM critique alone cannot approve"],
  "MPSEM-0288-C001": ["preserve", "enhance", "creative", "distinct requested processing intents"],
  "MPSEM-0291-C007": ["requested and effective profiles", "quality, resource and confirmation bounds"],
  "MPSEM-0297-C003": ["existing response shapes", "version negotiation or migration"],
  "MPSEM-0299-C002": ["fail-fast or continue-on-item-failure", "per-item results"],
  "MPSEM-0305-C001": ["submit, status/list", "separate operations with separate finality"],
  "MPSEM-0306-C001": ["project/scene/timeline context", "ownership boundary"],
  "MPSEM-0315-C005": ["without sibling repository source", "provider credentials"],
  "MPSEM-0316-C002": ["same canonical request/plan", "long form"],
  "MPSEM-0319-C001": ["distinguishes planning from execution", "non-interchangeable input semantics"],
  "MPSEM-0335-C004": ["stderr", "redacted before emission"],
  "MPSEM-0357-C001": ["Rights, consent, retention and format admission", "before bytes become admitted Media artifacts"],
  "MPSEM-0357-C003": ["rechecks revocation and expiry", "effect boundaries"],
  "MPSEM-0367-C001": ["beyond Media control", "deployment-specific evidence confirms it"],
  "MPSEM-0368-C003": ["admitted durable path", "acceptance separate from sink acknowledgement"],
  "MPSEM-0378-C003": ["do not rewrite historical execution evidence", "meaning/version under which they were produced"],
  "MPSEM-0379-C002": ["tenant/ownership compatibility", "fresh checks of rights, consent, retention, license and policy"],
  "MPSEM-0380-C001": ["not shared across tenants by default", "sensitive deduplication existence"],
  "MPSEM-0440-C005": ["relevant context", "authorized role"],
  "MPSEM-0441-C003": ["source-backed state", "unsupported state remains UNKNOWN"],
  "MPSEM-0444-C001": ["apply automatically only", "admits the exact transformation"],
  "MPSEM-0445-C001": ["near relevant work", "never the only route"],
  "MPSEM-0449-C004": ["does not cancel or mutate", "underlying operation"],
  "MPSEM-0451-C006": ["visible controls", "keyboard-operable alternatives"],
  "MPSEM-0452-C001": ["reviewable candidates", "correctness is never presumed"],
  "MPSEM-0454-C004": ["exact public exports", "installed-consumer behavior"],
  "MPSEM-0458-C002": ["package-specific evidence", "Apache-2.0"],
  "MPSEM-0458-C006": ["Legal review is required", "remain uncertain"],
  "MPSEM-0467-C004": ["accepted public or extracted interfaces", "not an integration contract"],
  "MPSEM-0468-C002": ["distinct publication request", "exact output version, purpose, approver authority and destination scope"],
};
const assertClaimMeaning = (claimId, semanticRule) => {
  for (const phrase of meaningPredicates[claimId] ?? []) {
    assert.ok(semanticRule.toLowerCase().includes(phrase.toLowerCase()), `${claimId} must preserve reviewed meaning: ${phrase}`);
  }
  assert.ok(meaningPredicates[claimId], `${claimId} has an independent semantic predicate`);
};

test("all 40 pending PDP-3 migration claims have individual owner rules and review candidates", async () => {
  const pending = partition.records.filter((row) => row.sourceOwnerPhase === "PDP-3");
  assert.equal(pending.length, 40);
  assert.equal(rules.count, 40);
  assert.equal(review.count, 40);
  const byRule = new Map(rules.records.map((row) => [row.claimId, row]));
  const byReview = new Map(review.records.map((row) => [row.claimId, row]));
  assert.equal(byRule.size, 40);
  assert.equal(byReview.size, 40);
  for (const claim of pending) {
    const rule = byRule.get(claim.claimId);
    const candidate = byReview.get(claim.claimId);
    assert.ok(rule && candidate, `${claim.claimId} is accounted for`);
    assert.equal(rule.sourceText, claim.exactSourceText);
    assert.equal(rule.sourceTextSha256, claim.sourceTextSha256);
    assert.equal(candidate.sourceText, claim.exactSourceText);
    assert.equal(candidate.sourceTextSha256, claim.sourceTextSha256);
    assert.equal(candidate.previousTargetRef, claim.currentTargetRef);
    assert.equal(candidate.proposedTargetRef, `.product-experience/pdp-3-product-experience/migration-semantic-rules.yaml#/records/@id=${rule.id}`);
    assert.equal(candidate.contractSelector, candidate.proposedTargetRef);
    assert.equal(candidate.targetValueSha256, digest({ ...rule, ownerDecisionStatus: "PROPOSED_MEDIA_DEFINITION; ROOT_REVIEW_PENDING" }));
    assert.equal(rule.ownerDecisionStatus, "OWNER_REVIEWED_SOURCE_DEFINITION; PXD-097; independent acceptance pending");
    assert.equal(rule.runtimeAdmission, "NOT_ADMITTED");
    assert.equal(rule.acceptanceEffect, "none");
    assert.ok(rule.semanticRule.length > 40 && rule.semanticRule !== claim.exactSourceText, `${claim.claimId} has an authored rule rather than copied locator text`);
    assert.ok(rule.positiveCase.length > 20 && rule.negativeCase.length > 20, `${claim.claimId} has falsifiable review examples`);
    assertClaimMeaning(claim.claimId, rule.semanticRule);
  }
  assert.equal(review.rootReviewStatus, "PENDING");
  const authorityRefs = review.records.flatMap((row) => row.sourceAuthorityRefs ?? []);
  const sourceDocuments = {};
  for (const ref of authorityRefs) {
    const path = ref.slice(0, ref.indexOf("#"));
    sourceDocuments[path] ??= parse(await readFile(path, "utf8"));
    assert.ok(resolvePdp3BindingSourceRef(ref, sourceDocuments), `source authority resolves exactly: ${ref}`);
  }
});

test("refreshing target hashes cannot erase a claim-specific meaning predicate", () => {
  const valid = rules.records.find((row) => row.claimId === "MPSEM-0357-C003");
  const weakened = { ...valid, semanticRule: "Long explanatory prose that says checks may happen whenever convenient and does not bind revocation or expiry to an effect boundary." };
  const refreshedCandidate = { ...review.records.find((row) => row.claimId === valid.claimId), semanticRule: weakened.semanticRule, targetValueSha256: digest(weakened) };
  assert.equal(refreshedCandidate.targetValueSha256, digest(weakened));
  assert.throws(() => assertClaimMeaning(valid.claimId, weakened.semanticRule), /rechecks revocation and expiry/u);
});


test("all forty source rules reject refreshed-hash removal of every reviewed material boundary", () => {
  for (const rule of rules.records) {
    for (const phrase of meaningPredicates[rule.claimId]) {
      const weakened = { ...rule, semanticRule: rule.semanticRule.replace(phrase, "removed-boundary") };
      assert.notEqual(weakened.semanticRule, rule.semanticRule, `${rule.claimId} mutation changes the actual clause`);
      const candidate = { targetValueSha256: digest(weakened) };
      assert.equal(candidate.targetValueSha256, digest(weakened));
      assert.throws(() => assertClaimMeaning(rule.claimId, weakened.semanticRule), /must preserve reviewed meaning/u);
    }
  }
});
