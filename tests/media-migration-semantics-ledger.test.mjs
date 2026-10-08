import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const reviewPath = ".product-experience/pdp-0-product-truth/migration-semantics-review.yaml";
const sourcePath = "docs/migration/expert-reviewed-master-plan.md";
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));

test("migration master-plan semantic ledger preserves the stale pin and accounts for source changes", () => {
  const review = readYaml(reviewPath);
  const ledger = review.sourceChangeLedger;
  const historical = ledger.historicalSource;
  const current = ledger.observedCurrentSource;
  const plan = readFileSync(resolve(root, sourcePath), "utf8");
  const historicalPlan = execFileSync("git", ["show", `${historical.commit}:${sourcePath}`], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(review.sourcePin.sha256, historical.sha256);
  assert.equal(review.sourcePin.lineCount, historical.lineCount);
  assert.equal(historical.path, sourcePath);
  assert.equal(createHash("sha256").update(historicalPlan).digest("hex"), historical.sha256);
  assert.equal(historicalPlan.split("\n").length - 1, historical.lineCount);
  assert.equal(createHash("sha256").update(plan).digest("hex"), current.sha256);
  assert.equal(plan.split("\n").length - 1, current.lineCount);
  assert.equal(ledger.sourcePinDisposition, "keep-stale");
  assert.match(ledger.reconciliationStatus, /partial/u);

  assert.deepEqual(review.counts.uniqueContentUnits, 1340);
  assert.equal(review.counts.uniqueUnitsByClassification.UNRESOLVED, ledger.unchangedReviewCounts.unresolved);
  assert.equal(review.counts.blockStructureProposalCounts.MIXED_REQUIRES_DECOMPOSITION, ledger.unchangedReviewCounts.mixedRequiresDecomposition);
  assert.equal(review.counts.blockStructureProposalCounts.ownerReviewed, ledger.unchangedReviewCounts.ownerReviewed);
  assert.deepEqual(ledger.unchangedReviewCounts, {
    uniqueUnits: 1340,
    unresolved: 349,
    mixedRequiresDecomposition: 123,
    ownerReviewed: 0,
  });

  const items = new Map(review.items.map((item) => [item.itemId, item]));
  const clusters = ledger.clusters;
  assert.equal(clusters.length, 15);
  assert.equal(new Set(clusters.map(({ id }) => id)).size, clusters.length);
  const dispositions = new Set(["still applicable", "superseded", "needs decomposition", "source-scope change"]);
  const historicalLines = historicalPlan.split("\n");
  const currentLines = plan.split("\n");
  for (const cluster of clusters) {
    assert.ok(dispositions.has(cluster.disposition), `${cluster.id} has a recognized disposition`);
    assert.ok(cluster.changedClaims?.length, `${cluster.id} describes the source change`);
    assert.ok(cluster.rationale?.length, `${cluster.id} gives a disposition rationale`);
    for (const line of cluster.historicalLineSpans ?? []) {
      assert.ok(Number.isInteger(line) && line > 0 && line <= historicalLines.length, `${cluster.id} historical line ${line} exists`);
    }
    for (const line of cluster.currentLineSpans ?? []) {
      assert.ok(Number.isInteger(line) && line > 0 && line <= currentLines.length, `${cluster.id} current line ${line} exists`);
      assert.ok(currentLines[line - 1].trim(), `${cluster.id} current line ${line} is not blank`);
    }
    if (cluster.affectedItemIds.length === 0) {
      assert.ok(cluster.unmappedStatus, `${cluster.id} explicitly records unmapped source claims`);
    }
    for (const itemId of cluster.affectedItemIds) {
      assert.ok(items.has(itemId), `${cluster.id} references existing ${itemId}`);
    }
  }
  assert.ok(clusters.some(({ id }) => id === "MSC-01" && id && !clusters.find((item) => item.id === id).affectedItemIds.length));
  assert.ok(clusters.some(({ id }) => id === "MSC-09" && !clusters.find((item) => item.id === id).affectedItemIds.length));
  assert.ok(ledger.remainingReview?.length, "pin refresh requirements remain explicit");
});

test("narrow navigation and bibliography slices do not resolve mixed master-plan blocks", () => {
  const review = readYaml(reviewPath);
  const source = readFileSync(resolve(root, sourcePath), "utf8").split("\n");
  const historical = execFileSync("git", ["show", `${review.sourceChangeLedger.historicalSource.commit}:${sourcePath}`], {
    cwd: root,
    encoding: "utf8",
  }).split("\n");
  const items = new Map(review.items.map((item) => [item.itemId, item]));
  const slices = new Map(review.reviewedClaimSlices.map((slice) => [slice.sliceId, slice]));

  assert.equal(review.sourcePin.sha256, review.sourceChangeLedger.historicalSource.sha256, "the historical source pin stays stale and unchanged");
  assert.equal(review.ownerDecisionOverlay.resolvedBlockCount, 0);
  assert.equal(review.ownerDecisionOverlay.unresolvedBlockCount, 349);
  assert.match(review.blockStructureProposalAuthority, /Proposal-only classification/u, "no reviewed slice upgrades proposal-only block structure classifications");
  assert.equal(items.get("MPSEM-0001").classification, "UNRESOLVED", "metadata slicing does not resolve the containing mixed header block");
  assert.equal(items.get("MPSEM-0007").classification, "UNRESOLVED", "navigation slicing does not accept the sections it describes");
  assert.equal(items.get("MPSEM-0001").blockStructureProposal.status, "PROPOSAL_ONLY");
  assert.equal(items.get("MPSEM-0007").blockStructureProposal.status, "PROPOSAL_ONLY");

  const metadata = slices.get("MPSEM-0001-META-04-05");
  assert.deepEqual(metadata.sourceLines, [4, 5]);
  assert.equal(metadata.reviewStatus, "BOUNDED_SOURCE_REVIEWED");
  assert.equal(metadata.reviewMethod, "exact-text-comparison-to-historical-pin-and-current-source");
  assert.equal(metadata.classification, "NO_NORMATIVE_CONTENT");
  assert.equal(metadata.acceptanceEffect, "none");
  assert.match(metadata.authorityEffect, /lines 6-12 include status and authority-phase claims/u);
  assert.equal(metadata.sourceLines.includes(6), false, "the mixed status claim is outside the metadata-only disposition");
  assert.match(historical[5], /^\*\*Status:\*\*/u);
  assert.match(historical[11], /^\*\*Authority phases:\*\*/u, "authority-phase language remains unresolved");
  assert.deepEqual(metadata.exactText.map((line) => historical[line === "**Document ID:** MEDIA-MASTER-PLAN" ? 3 : 4].trim()), metadata.exactText);
  assert.deepEqual(metadata.exactText.map((line) => source[line === "**Document ID:** MEDIA-MASTER-PLAN" ? 3 : 4].trim()), metadata.exactText);

  const navigation = slices.get("MPSEM-0007-READING-ORDER");
  assert.deepEqual(navigation.sourceLines, [26, 26]);
  assert.deepEqual(navigation.currentSourceLines, [28, 28]);
  assert.equal(navigation.reviewStatus, "BOUNDED_SOURCE_REVIEWED");
  assert.equal(navigation.reviewMethod, "exact-text-comparison-to-historical-pin-and-current-source");
  assert.equal(navigation.classification, "NO_NORMATIVE_CONTENT");
  assert.equal(navigation.acceptanceEffect, "none");
  assert.match(navigation.authorityEffect, /does not classify or accept/u);
  assert.equal(navigation.exactText, historical[25].trim());
  assert.equal(navigation.exactText, source[27].trim());
});

test("MPSEM-0002 slogan claims have bounded proposal mappings without resolving the parent block", () => {
  const review = readYaml(reviewPath);
  const historical = execFileSync("git", ["show", `${review.sourceChangeLedger.historicalSource.commit}:${sourcePath}`], {
    cwd: root,
    encoding: "utf8",
  }).split("\n");
  const current = readFileSync(resolve(root, sourcePath), "utf8").split("\n");
  const constitution = readYaml(".product-experience/pdp-0-product-truth/constitution.yaml");
  const channels = readYaml(".product-experience/pdp-0-product-truth/applications-channels.yaml");
  const policy = readYaml(".product-experience/pdp-0-product-truth/policy-authority-model.yaml");
  const reuse = readYaml(".product-experience/pdp-0-product-truth/reuse-decisions.yaml");
  const items = new Map(review.items.map((item) => [item.itemId, item]));
  const claims = review.claimDecompositions.filter(({ itemId }) => itemId === "MPSEM-0002");
  const unresolved = review.unresolvedClaimFragments.filter(({ itemId }) => itemId === "MPSEM-0002");
  const claimById = new Map(claims.map((claim) => [claim.claimId, claim]));

  assert.equal(review.sourcePin.sha256, review.sourceChangeLedger.historicalSource.sha256);
  assert.equal(items.get("MPSEM-0002").classification, "UNRESOLVED");
  assert.equal(items.get("MPSEM-0002").blockStructureProposal.classification, "MIXED_REQUIRES_DECOMPOSITION");
  assert.equal(items.get("MPSEM-0002").blockStructureProposal.status, "PROPOSAL_ONLY");
  assert.equal(review.ownerDecisionOverlay.resolvedBlockCount, 0);
  assert.equal(review.ownerDecisionOverlay.unresolvedBlockCount, 349);
  assert.equal(review.counts.blockStructureProposalCounts.ownerReviewed, 0);
  assert.equal(claims.length, 7);
  assert.equal(new Set(claims.map(({ claimId }) => claimId)).size, 7);
  assert.ok(claims.every(({ reviewStatus, historicalSourceLines, currentSourceLines, acceptanceEffect }) => reviewStatus === "PROPOSAL_ONLY" && acceptanceEffect === "none" && historicalSourceLines[0] === 14 && currentSourceLines[0] === 16));
  const historicalSlogan = historical[13].trim().replace(/^>\s*/u, "");
  const currentSlogan = current[15].trim().replace(/^>\s*/u, "");
  assert.equal(historicalSlogan, currentSlogan, "the slogan text is unchanged at historical and current lines");
  assert.ok(claims.every(({ exactClaim }) => historicalSlogan.includes(exactClaim)), "each atomic claim is an exact source substring");

  const refForConst = (id) => `.product-experience/pdp-0-product-truth/constitution.yaml#/requirements/${constitution.requirements.findIndex((record) => record.id === id)}`;
  const mappedClaimExpectations = [
    ["MPSEM-0002-C01", [refForConst("MEDIA-CONST-014"), ".product-experience/pdp-0-product-truth/reuse-decisions.yaml#/decisions"]],
    ["MPSEM-0002-C02", [refForConst("MEDIA-CONST-018"), ".product-experience/pdp-0-product-truth/policy-authority-model.yaml#/singleAuthorityInvariant"]],
    ["MPSEM-0002-C03", [".product-experience/pdp-0-product-truth/applications-channels.yaml#/channelInvariants/0"]],
    ["MPSEM-0002-C04", [refForConst("MEDIA-CONST-008")]],
    ["MPSEM-0002-C05", [refForConst("MEDIA-CONST-007")]],
    ["MPSEM-0002-C06", [refForConst("MEDIA-CONST-003"), refForConst("MEDIA-CONST-004")]],
  ];
  for (const [id, expectedRefs] of mappedClaimExpectations) {
    const claim = claimById.get(id);
    assert.deepEqual(claim.candidatePdpRefs, expectedRefs, `${id} retains only its source-supported candidate targets`);
    assert.ok(["CANDIDATE_TARGET", "PARTIAL_CANDIDATE"].includes(claim.mappingStatus));
  }
  for (const id of ["MEDIA-CONST-003", "MEDIA-CONST-004", "MEDIA-CONST-007", "MEDIA-CONST-008", "MEDIA-CONST-014", "MEDIA-CONST-018"]) {
    assert.equal(constitution.requirements.find(({ id: currentId }) => currentId === id).acceptanceState, "pending-human-review", `${id} is not accepted evidence`);
  }
  assert.match(policy.singleAuthorityInvariant, /exactly one editable Media semantic\/runtime authority/u);
  assert.match(reuse.status, /owner-acceptance-pending/u);
  assert.equal(channels.channelInvariants[0], "Web, CLI, API, SDK, and product integrations project the same versioned product semantics, authorization, finality, and recovery rules.");

  assert.equal(claimById.get("MPSEM-0002-C07").mappingStatus, "UNMAPPED");
  assert.deepEqual(claimById.get("MPSEM-0002-C07").candidatePdpRefs, []);
  assert.equal(unresolved.length, 4);
  assert.ok(unresolved.every(({ status }) => status === "UNRESOLVED"));
  assert.deepEqual(claims.filter(({ mappingStatus }) => mappingStatus === "PARTIAL_CANDIDATE").map(({ unresolvedClaimRef }) => unresolvedClaimRef).sort(), unresolved.map(({ fragmentId }) => fragmentId).filter((id) => id !== "MPSEM-0002-U04").sort());
});

test("P0-003 animation scope is crosswalked as a bounded slice while adjacent claims stay unresolved", () => {
  const review = readYaml(reviewPath);
  const historical = execFileSync("git", ["show", `${review.sourceChangeLedger.historicalSource.commit}:${sourcePath}`], {
    cwd: root,
    encoding: "utf8",
  }).split("\n");
  const current = readFileSync(resolve(root, sourcePath), "utf8").split("\n");
  const crosswalk = readYaml(".product-experience/pdp-0-product-truth/capability-preservation-crosswalk.yaml");
  const items = new Map(review.items.map((item) => [item.itemId, item]));
  const claims = review.claimDecompositions.filter(({ itemId }) => itemId === "MPSEM-0713");
  const claimById = new Map(claims.map((claim) => [claim.claimId, claim]));
  const animationClaim = claimById.get("MPSEM-0713-C01");
  const leafBindingClaim = claimById.get("MPSEM-0713-C02");
  const animationFamilies = ["media.animation", "media.animation.editing", "media.animation.output"];

  assert.equal(review.sourcePin.sha256, review.sourceChangeLedger.historicalSource.sha256, "the historical source pin remains stale");
  assert.equal(items.get("MPSEM-0713").classification, "EXECUTION_ONLY", "claim slicing does not change the parent block classification");
  assert.equal(items.get("MPSEM-0713").classificationBasis.includes("embedded unique product semantics still require separate review"), true);
  assert.equal(review.counts.uniqueUnitsByClassification.UNRESOLVED, 349);
  assert.equal(review.ownerDecisionOverlay.resolvedBlockCount, 0);
  assert.equal(claims.length, 2);

  for (const claim of claims) {
    assert.equal(claim.sourcePinRef, `docs/migration/expert-reviewed-master-plan.md@${review.sourceChangeLedger.historicalSource.commit}`);
    assert.deepEqual(claim.historicalSourceLines, [1560, 1560]);
    assert.deepEqual(claim.currentSourceLines, [1574, 1574]);
    assert.ok(historical[1559].includes(claim.exactClaim), `${claim.claimId} is an exact historical source substring`);
    assert.ok(current[1573].includes(claim.exactClaim), `${claim.claimId} is an exact current source substring`);
    assert.equal(claim.acceptanceEffect, "none");
  }
  assert.equal(animationClaim.reviewStatus, "BOUNDED_SOURCE_REVIEWED");
  assert.equal(animationClaim.mappingStatus, "SCOPE_CROSSWALKED_PENDING_SEMANTIC_DETAIL");
  assert.equal(animationClaim.exactClaim, "Include original streaming/document worker and all animation/simulation/spatial/enhancement families.");
  assert.deepEqual(animationClaim.candidatePdpRefs, animationFamilies.map((_, index) => `.product-experience/pdp-0-product-truth/capability-preservation-crosswalk.yaml#/familyCrosswalk/${19 + index}`));
  const matchedFamilies = animationClaim.candidatePdpRefs.map((ref) => crosswalk.familyCrosswalk[Number(ref.split("/").at(-1))]);
  assert.deepEqual(matchedFamilies.map(({ familyId }) => familyId), animationFamilies);
  assert.ok(matchedFamilies.every(({ masterPlanSection }) => masterPlanSection === "§6.5"));
  assert.ok(matchedFamilies.every(({ disposition }) => disposition === "retained-as-Media-semantic-leaves"));
  const animationLeafIds = matchedFamilies.flatMap(({ capabilityIds }) => capabilityIds);
  assert.equal(animationLeafIds.length, 42);
  assert.equal(new Set(animationLeafIds).size, 42);
  assert.match(crosswalk.status, /semantic-detail-and-Product-Truth-acceptance-pending/u);
  assert.equal(leafBindingClaim.reviewStatus, "PROPOSAL_ONLY");
  assert.equal(leafBindingClaim.mappingStatus, "UNRESOLVED");
  assert.equal(leafBindingClaim.unresolvedClaimRef, "MPSEM-0713-U02");
  assert.deepEqual(review.unresolvedClaimFragments.filter(({ itemId }) => itemId === "MPSEM-0713").map(({ fragmentId }) => fragmentId).sort(), ["MPSEM-0713-U01", "MPSEM-0713-U02"]);
});
