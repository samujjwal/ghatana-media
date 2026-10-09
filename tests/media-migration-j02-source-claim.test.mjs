import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const sourcePath = "docs/migration/expert-reviewed-master-plan.md";
const expectedRow = "| J-02 | Upload/import → inspect → usable artifact; interrupted parts, checksum mismatch and quarantine recovery |";
const expectedHeader = "| Journey ID | Complete outcome and critical exceptional path |";

function resolveRef(reference) {
  const separator = reference.indexOf("#");
  let value = readYaml(reference.slice(0, separator));
  const pointer = reference.slice(separator + 1);
  for (const token of pointer.replace(/^\//u, "").split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    assert.ok(value !== null && typeof value === "object" && key in value, `unresolved source ref ${reference}`);
    value = value[key];
  }
  return value;
}

test("MPSEM-0560 retains a whole-item unresolved boundary while routing exact J-02 definitions", () => {
  const review = readYaml(".product-experience/pdp-0-product-truth/migration-semantics-review.yaml");
  const item = review.items.find(({ itemId }) => itemId === "MPSEM-0560");
  const slice = review.reviewedClaimSlices.find(({ sliceId }) => sliceId === "MPSEM-0560-J02-OUTCOME-AND-RECOVERY");
  const source = readFileSync(resolve(root, sourcePath), "utf8").split("\n");
  const historical = execFileSync("git", ["show", "e62514f94c45a4ecbc438d26298bf82b6a6f3d69:" + sourcePath], {
    cwd: root, encoding: "utf8",
  }).split("\n");
  const journey = readYaml(".product-experience/pdp-0-product-truth/journey-catalog.yaml").journeys
    .find(({ id }) => id === "J-02");
  const experience = readYaml(".product-experience/pdp-3-product-experience/journey-contracts/upload-import-and-verify-artifact.yaml");
  const operations = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");
  const decisionLog = readFileSync(resolve(root, ".product-experience/decision-log.md"), "utf8");

  assert.ok(item && slice);
  assert.equal(item.classification, "EXECUTION_ONLY", "preserve the original extraction classification and historical record");
  assert.equal(slice.sourcePinRef, "docs/migration/expert-reviewed-master-plan.md@e62514f94c45a4ecbc438d26298bf82b6a6f3d69");
  assert.deepEqual(slice.sourceLines, [1298, 1298]);
  assert.deepEqual(slice.currentSourceLines, [1312, 1312]);
  assert.equal(slice.exactText, expectedRow);
  assert.equal(historical[1297].trim(), expectedRow);
  assert.equal(source[1311].trim(), expectedRow);
  assert.equal(slice.reviewStatus, "BOUNDED_SOURCE_REVIEWED");
  assert.equal(slice.acceptanceEffect, "none");
  assert.equal(slice.wholeItemDisposition, "UNRESOLVED_IMPORT_AND_VERSION_IDENTITY");
  assert.match(slice.classification, /MIXED_PRODUCT_JOURNEY_INTENT_AND_EXECUTION_RECOVERY/u);

  assert.equal(journey.title, "Upload/import, inspect, and produce a usable artifact");
  assert.deepEqual(journey.outcomeRefs, ["media.goal.understand-media", "media.goal.preserve-source", "media.goal.resolve-safely"]);
  assert.equal(experience.journeyId, "J-02");
  assert.equal(experience.definitionReview.status, "SOURCE_DEFINED_OWNER_ACCEPTED");
  assert.match(decisionLog, /PXD-049 — Accept the bounded J-02 upload and verification definition/u);
  assert.ok(slice.productSemanticClaims.some((claim) => claim.sourcePhrase === "import" && /unresolved/u.test(claim.status)));
  assert.ok(slice.productSemanticClaims.some((claim) => claim.sourcePhrase === "inspect → usable artifact"));
  assert.match(experience.unresolvedProductDecisions.join(" "), /external-provider-imports-and-progressive-transfer-limits-require-an-admitted-source-integration/u);
  const inspect = operations.individualOperationContracts.records.find(({ id }) => id === "media.operation-slice.inspect-artifact");
  assert.deepEqual(inspect.requestFields, ["tenantId", "principalId", "artifactId"]);
  assert.match(inspect.finality, /metadata and object reference only/u);
  assert.ok(!inspect.requestFields.includes("versionId"), "artifactId-only wire identity does not establish immutable version identity");
  assert.match(slice.authorityEffect, /does not imply semantic equivalence for remote import, wire version identity, runtime behavior/u);
  for (const claim of slice.productSemanticClaims) for (const ref of claim.targets ?? []) {
    if (ref.startsWith('.product-experience/decision-log.md#')) assert.match(decisionLog, /PXD-049 — Accept the bounded J-02 upload/u);
    else resolveRef(ref);
  }
});

test("PXD-053 classifies only the complete adjacent table-header item outside the 349 denominator", () => {
  const review = readYaml(".product-experience/pdp-0-product-truth/migration-semantics-review.yaml");
  const decision = review.ownerDecisionOverlay.additionalSourceClassificationsOutsideOriginalStructuralDenominator
    .find(({ decisionRef }) => decisionRef === ".product-experience/decision-log.md#PXD-053");
  const item = review.items.find(({ itemId }) => itemId === "MPSEM-0558");
  const broadRequirement = review.items.find(({ itemId }) => itemId === "MPSEM-0557");
  const j02 = review.items.find(({ itemId }) => itemId === "MPSEM-0560");
  const current = readFileSync(resolve(root, sourcePath), "utf8").split("\n");
  const historical = execFileSync("git", ["show", `e62514f94c45a4ecbc438d26298bf82b6a6f3d69:${sourcePath}`], {
    cwd: root, encoding: "utf8",
  }).split("\n");

  assert.ok(decision && item);
  assert.equal(decision.denominatorDisposition, "OUTSIDE_ORIGINAL_349_STRUCTURAL_OBSERVATIONS");
  assert.equal(decision.classification, "EVIDENCE_REFERENCE");
  assert.equal(decision.acceptanceEffect, "none");
  assert.equal(decision.item.id, "MPSEM-0558");
  assert.deepEqual(decision.item.historicalSourceLines, [1295, 1295]);
  assert.deepEqual(decision.item.currentSourceLines, [1309, 1309]);
  assert.equal(decision.item.exactText, expectedHeader);
  assert.equal(historical[1294].trim(), expectedHeader);
  assert.equal(current[1308].trim(), expectedHeader);
  assert.equal(review.sourceChangeLedger.sourcePinDisposition, "keep-stale");
  assert.equal(review.sourcePin.sha256, "2960242334b5144187a7a6b687d4513a97d7f45401e0544b772b0e80f122fa5a");
  assert.equal(item.classification, "EXECUTION_ONLY", "raw historical extraction class remains intact");
  assert.equal(Object.hasOwn(item, "blockStructureProposal"), false, "the separate review is not merged into the original 349 ledger");
  assert.equal(broadRequirement.classification, "EXECUTION_ONLY");
  assert.equal(Object.hasOwn(broadRequirement, "blockStructureProposal"), false, "the all-journey requirement is outside this header review");
  assert.equal(j02.classification, "EXECUTION_ONLY");
  assert.equal(Object.hasOwn(j02, "blockStructureProposal"), false, "J-02 normative content remains independently unresolved");
  assert.equal(review.ownerDecisionOverlay.additionalSourceClassificationsOutsideOriginalStructuralDenominator.length, 1);
  assert.equal(review.ownerDecisionOverlay.ownerClassifiedNonNormativeBlockCount, 89);
  assert.equal(review.ownerDecisionOverlay.unresolvedBlockCount, 260);
  assert.equal(review.counts.blockStructureProposalCounts.ownerReviewed, 3);
  assert.equal(review.counts.blockStructureProposalCounts.NO_NORMATIVE_CONTENT, 6);
  assert.equal(review.counts.blockStructureProposalCounts.total, 263);
});
