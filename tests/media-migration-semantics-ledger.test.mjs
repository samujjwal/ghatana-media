import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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
    unresolved: 263,
    mixedRequiresDecomposition: 124,
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

test("migration source diff hunks have exact, non-accepting coverage", () => {
  const review = readYaml(reviewPath);
  const ledger = review.sourceChangeLedger;
  const coverage = ledger.diffHunkCoverage;
  const diff = execFileSync("git", ["diff", "--no-ext-diff", "--unified=0", `${ledger.historicalSource.commit}`, "--", sourcePath], {
    cwd: root,
    encoding: "utf8",
  });
  const actual = [];
  let hunk = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      if (hunk) actual.push(hunk);
      const match = line.match(/-(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?/u);
      assert.ok(match, `parse zero-context hunk header: ${line}`);
      hunk = {
        historicalLines: Number(match[2] ?? 1) ? [Number(match[1]), Number(match[1]) + Number(match[2] ?? 1) - 1] : [],
        currentLines: Number(match[4] ?? 1) ? [Number(match[3]), Number(match[3]) + Number(match[4] ?? 1) - 1] : [],
        historical: [],
        current: [],
      };
    } else if (hunk && line.startsWith("-") && !line.startsWith("---")) {
      hunk.historical.push(line.slice(1));
    } else if (hunk && line.startsWith("+") && !line.startsWith("+++")) {
      hunk.current.push(line.slice(1));
    }
  }
  if (hunk) actual.push(hunk);

  assert.equal(coverage.schemaVersion, "media.migration-source-diff-hunk-coverage.v1");
  assert.equal(coverage.records.length, actual.length);
  assert.match(coverage.completeness, /coverage only, not semantic acceptance/u);
  const clusters = new Set(ledger.clusters.map(({ id }) => id));
  let added = 0;
  let deleted = 0;
  let addedLines = 0;
  let deletedLines = 0;
  for (const [index, expected] of coverage.records.entries()) {
    const observed = actual[index];
    assert.equal(expected.hunkId, `MSD-${String(index + 1).padStart(3, "0")}`);
    assert.deepEqual(expected.historicalLines, observed.historicalLines, `${expected.hunkId} historical span`);
    assert.deepEqual(expected.currentLines, observed.currentLines, `${expected.hunkId} current span`);
    assert.equal(expected.historicalChangedLineCount, observed.historical.length, `${expected.hunkId} deleted-line count`);
    assert.equal(expected.currentChangedLineCount, observed.current.length, `${expected.hunkId} added-line count`);
    assert.equal(expected.historicalNonblankLineCount, observed.historical.filter((line) => line.trim()).length);
    assert.equal(expected.currentNonblankLineCount, observed.current.filter((line) => line.trim()).length);
    assert.equal(expected.historicalChangedTextSha256, createHash("sha256").update(observed.historical.join("\n")).digest("hex"));
    assert.equal(expected.currentChangedTextSha256, createHash("sha256").update(observed.current.join("\n")).digest("hex"));
    assert.ok(clusters.has(expected.clusterId), `${expected.hunkId} references an existing source-change cluster`);
    assert.equal(expected.acceptanceEffect, "none", `${expected.hunkId} has no acceptance effect`);
    assert.ok(expected.coverageKind && expected.disposition, `${expected.hunkId} has explicit semantic classification`);
    if (expected.coverageKind === "task-index-or-task-card-owner-routing") {
      assert.match(expected.disposition, /unresolved/u, `${expected.hunkId} owner routing stays unresolved`);
    }
    added += expected.currentNonblankLineCount;
    deleted += expected.historicalNonblankLineCount;
    addedLines += expected.currentChangedLineCount;
    deletedLines += expected.historicalChangedLineCount;
  }
  assert.equal(addedLines, 182);
  assert.equal(deletedLines, 168);
  assert.ok(added <= addedLines && deleted <= deletedLines, "nonblank line totals exclude blank additions and deletions");
  assert.equal(ledger.sourcePinDisposition, "keep-stale");
  assert.match(ledger.reconciliationStatus, /partial/u);
  assert.deepEqual(ledger.unchangedReviewCounts, { uniqueUnits: 1340, unresolved: 263, mixedRequiresDecomposition: 124, ownerReviewed: 0 });
  assert.equal(review.sourcePin.sha256, ledger.historicalSource.sha256);
});

test("narrow metadata slices preserve the mixed header while bounded source classifications stay non-accepting", () => {
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
  assert.equal(review.ownerDecisionOverlay.unresolvedBlockCount, 263);
  assert.match(review.blockStructureProposalAuthority, /Proposal-only classification/u, "no reviewed slice upgrades proposal-only block structure classifications");
  assert.equal(items.get("MPSEM-0001").classification, "UNRESOLVED", "metadata slicing does not resolve the containing mixed header block");
  assert.equal(items.get("MPSEM-0007").classification, "EVIDENCE_REFERENCE", "the exact reading guide is classified only as document evidence");
  assert.equal(items.get("MPSEM-0001").blockStructureProposal.status, "PROPOSAL_ONLY");
  assert.equal(items.get("MPSEM-0007").blockStructureProposal.status, "BOUNDED_SOURCE_REVIEWED");

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

  const sourceProvenance = slices.get("MPSEM-0001-SOURCE-PROVENANCE-09");
  assert.deepEqual(sourceProvenance.sourceLines, [9, 9]);
  assert.deepEqual(sourceProvenance.currentSourceLines, [9, 9]);
  assert.equal(sourceProvenance.reviewStatus, "BOUNDED_SOURCE_REVIEWED");
  assert.equal(sourceProvenance.classification, "EVIDENCE_REFERENCE");
  assert.equal(sourceProvenance.acceptanceEffect, "none");
  assert.equal(sourceProvenance.exactText, historical[8].trim());
  assert.equal(sourceProvenance.exactText, source[8].trim());
  assert.equal(items.get("MPSEM-0001").classification, "UNRESOLVED", "source provenance does not resolve the mixed header block");
  assert.match(sourceProvenance.basis, /does not establish present ownership/u);
  assert.equal(review.sourcePin.sha256, review.sourceChangeLedger.historicalSource.sha256, "source-only provenance keeps the plan pin stale");

  const navigation = slices.get("MPSEM-0007-READING-ORDER");
  assert.deepEqual(navigation.sourceLines, [26, 26]);
  assert.deepEqual(navigation.currentSourceLines, [28, 28]);
  assert.equal(navigation.reviewStatus, "BOUNDED_SOURCE_REVIEWED");
  assert.equal(navigation.reviewMethod, "exact-text-comparison-to-historical-pin-and-current-source");
  assert.equal(navigation.classification, "NO_NORMATIVE_CONTENT", "the exact navigation slice remains non-normative source text");
  assert.equal(navigation.acceptanceEffect, "none");
  assert.match(navigation.authorityEffect, /does not classify or accept/u);
  assert.equal(navigation.exactText, historical[25].trim());
  assert.equal(navigation.exactText, source[27].trim());
});

test("delegated non-normative classification is limited to the exact approved 86 item IDs", () => {
  const review = readYaml(reviewPath);
  const items = new Map(review.items.map((item) => [item.itemId, item]));
  const decision = review.ownerDecisionOverlay.nonNormativeClassificationDecision;
  const executionOnly = [
    "MPSEM-0020", "MPSEM-0050", "MPSEM-0081", "MPSEM-0089", "MPSEM-0123", "MPSEM-0156",
    "MPSEM-0173", "MPSEM-0182", "MPSEM-0216", "MPSEM-0266", "MPSEM-0284", "MPSEM-0302",
    "MPSEM-0317", "MPSEM-0332", "MPSEM-0337", "MPSEM-0466", "MPSEM-1190", "MPSEM-1223",
  ];
  const evidenceReference = [
    "MPSEM-0007", "MPSEM-0018", "MPSEM-0019", "MPSEM-1189",
    ...Array.from({ length: 31 }, (_, i) => `MPSEM-${String(1191 + i).padStart(4, "0")}`),
    ...Array.from({ length: 4 }, (_, i) => `MPSEM-${String(1224 + i).padStart(4, "0")}`),
    ...Array.from({ length: 17 }, (_, i) => `MPSEM-${String(1229 + i).padStart(4, "0")}`),
    ...Array.from({ length: 12 }, (_, i) => `MPSEM-${String(1247 + i).padStart(4, "0")}`),
  ];
  const approved = new Set([...executionOnly, ...evidenceReference]);
  assert.equal(approved.size, 86);
  assert.deepEqual(decision.itemIds.executionOnly, executionOnly);
  assert.deepEqual(decision.itemIds.evidenceReference, evidenceReference);
  assert.equal(decision.decisionRef, "MEDIA-OWNER-2026-10-08-NONNORMATIVE-01");
  assert.equal(decision.acceptanceEffect, "none");
  assert.match(decision.classificationEffect, /do not imply semantic equivalence or task completion/u);
  assert.equal(decision["p0-03"], "remains open");
  assert.equal(review.ownerDecisionOverlay.ownerClassifiedNonNormativeBlockCount, 86);
  assert.equal(review.ownerDecisionOverlay.resolvedBlockCount, 0, "no semantic block is accepted by this classification");
  assert.equal(review.ownerDecisionOverlay.unresolvedBlockCount, 263);
  assert.equal(review.counts.uniqueUnitsByClassification.UNRESOLVED, 263);
  assert.equal(review.counts.uniqueUnitsByClassification.EVIDENCE_REFERENCE, 163);
  assert.equal(review.counts.uniqueUnitsByClassification.EXECUTION_ONLY, 783);
  assert.deepEqual(review.counts.blockStructureProposalCounts, {
    MIXED_REQUIRES_DECOMPOSITION: 124,
    NO_NORMATIVE_CONTENT: 6,
    SINGLE_SEMANTIC_CLASS: 133,
    total: 263,
    ownerReviewed: 0,
    ownerClassifiedNonNormative: 86,
  });
  assert.deepEqual(review.sourceChangeLedger.unchangedReviewCounts, {
    uniqueUnits: 1340, unresolved: 263, mixedRequiresDecomposition: 124, ownerReviewed: 0,
  });
  for (const [ids, classification] of [[executionOnly, "EXECUTION_ONLY"], [evidenceReference, "EVIDENCE_REFERENCE"]]) {
    for (const id of ids) {
      const item = items.get(id);
      assert.ok(item, `${id} exists`);
      assert.equal(item.classification, classification, `${id} receives only the approved non-semantic disposition`);
      assert.equal(item.blockStructureProposal.classification, classification, `${id} block disposition matches`);
      assert.equal(item.blockStructureProposal.status, "BOUNDED_SOURCE_REVIEWED");
      assert.equal(item.blockStructureProposal.decisionRef, decision.decisionRef);
      assert.equal(item.blockStructureProposal.acceptanceEffect, "none");
      assert.equal(item.blockStructureProposal.sourcePinRef, "docs/migration/expert-reviewed-master-plan.md@e62514f94c45a4ecbc438c26298bf82b6a6f3d69");
      assert.deepEqual(item.blockStructureProposal.sourceLineRanges, item.sourceLocations.map(({ lineStart, lineEnd }) => [lineStart, lineEnd]), `${id} approval is exact-span-bound`);
      assert.ok(item.sourceLocations.length, `${id} has exact historical source lines`);
    }
  }
  for (const id of ["MPSEM-0001", "MPSEM-0044", "MPSEM-0062", "MPSEM-0064", "MPSEM-0066", "MPSEM-0301"]) {
    assert.equal(items.get(id).classification, "UNRESOLVED", `${id} remains semantically unresolved`);
    assert.equal(items.get(id).blockStructureProposal.classification, "NO_NORMATIVE_CONTENT", `${id} retains its original proposal only`);
    assert.equal(items.get(id).blockStructureProposal.status, "PROPOSAL_ONLY");
  }
  assert.deepEqual(review.reviewedClaimSlices.find(({ sliceId }) => sliceId === "MPSEM-0001-META-04-05").sourceLines, [4, 5]);
  assert.equal(review.items.find(({ itemId }) => itemId === "MPSEM-0001").classification, "UNRESOLVED");
  assert.equal(review.sourcePin.sha256, review.sourceChangeLedger.historicalSource.sha256);
  assert.equal(review.sourceChangeLedger.sourcePinDisposition, "keep-stale");
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
  assert.equal(review.ownerDecisionOverlay.unresolvedBlockCount, 263);
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
  assert.equal(review.counts.uniqueUnitsByClassification.UNRESOLVED, 263);
  assert.equal(review.ownerDecisionOverlay.resolvedBlockCount, 0);
  assert.equal(claims.length, 5);

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
  const boundedFamilyClaims = [
    ["MPSEM-0713-C03", "simulation", [22], ["media.simulation"]],
    ["MPSEM-0713-C04", "spatial", [18], ["media.generate.spatial"]],
    ["MPSEM-0713-C05", "enhancement", [25, 26, 27], ["media.enhance.image", "media.enhance.video", "media.enhance.audio"]],
  ];
  for (const [claimId, exactClaim, crosswalkIndexes, expectedFamilyIds] of boundedFamilyClaims) {
    const claim = claimById.get(claimId);
    assert.equal(claim.exactClaim, exactClaim);
    assert.ok(historical[1559].includes(exactClaim), `${claimId} is an exact substring of the pinned task`);
    assert.ok(current[1573].includes(exactClaim), `${claimId} is an exact substring of the current task`);
    assert.equal(claim.reviewStatus, "BOUNDED_SOURCE_REVIEWED");
    assert.equal(claim.mappingStatus, "SCOPE_CROSSWALKED_PENDING_SEMANTIC_DETAIL");
    assert.deepEqual(claim.candidatePdpRefs, crosswalkIndexes.map((index) => `.product-experience/pdp-0-product-truth/capability-preservation-crosswalk.yaml#/familyCrosswalk/${index}`));
    const mappedFamilies = crosswalkIndexes.map((index) => crosswalk.familyCrosswalk[index]);
    assert.deepEqual(mappedFamilies.map(({ familyId }) => familyId), expectedFamilyIds);
    assert.ok(mappedFamilies.every(({ disposition }) => disposition === "retained-as-Media-semantic-leaves"));
    assert.equal(claim.acceptanceEffect, "none");
    assert.ok(claim.unresolvedClaimRef);
  }
  assert.deepEqual(review.unresolvedClaimFragments.filter(({ itemId }) => itemId === "MPSEM-0713").map(({ fragmentId }) => fragmentId).sort(), ["MPSEM-0713-U01", "MPSEM-0713-U02", "MPSEM-0713-U03", "MPSEM-0713-U04", "MPSEM-0713-U05"]);
  const streamingWorkerScope = review.unresolvedClaimFragments.find(({ fragmentId }) => fragmentId === "MPSEM-0713-U01");
  assert.match(streamingWorkerScope.text, /original streaming\/document worker/u);
  assert.match(streamingWorkerScope.status, /^UNRESOLVED$/u);
});

test("MSC-04 path claims reconcile only source-supported PDP and Explorer identities", () => {
  const review = readYaml(reviewPath);
  const historical = execFileSync("git", ["show", `${review.sourceChangeLedger.historicalSource.commit}:${sourcePath}`], {
    cwd: root,
    encoding: "utf8",
  }).split("\n");
  const current = readFileSync(resolve(root, sourcePath), "utf8").split("\n");
  const manifest = readYaml(".product-experience/source-manifest.yaml").productArtifactIndex.records;
  const identity = readYaml(".product-experience/artifact-identities.yaml").records;
  const generated = JSON.parse(readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/generated/product-definition.candidate.json"), "utf8"));
  const claims = new Map(review.claimDecompositions.filter(({ itemId }) => ["MPSEM-0118", "MPSEM-0164", "MPSEM-0463"].includes(itemId)).map((claim) => [claim.claimId, claim]));
  const unresolved = new Map(review.unresolvedClaimFragments.filter(({ itemId }) => ["MPSEM-0118", "MPSEM-0164", "MPSEM-0463"].includes(itemId)).map((fragment) => [fragment.fragmentId, fragment]));
  const sourceCommit = review.sourceChangeLedger.historicalSource.commit;

  assert.equal(review.sourcePin.sha256, review.sourceChangeLedger.historicalSource.sha256, "the stale historical pin is preserved");
  assert.equal(review.ownerDecisionOverlay.resolvedBlockCount, 0);
  assert.equal(review.ownerDecisionOverlay.unresolvedBlockCount, 263);
  assert.deepEqual(review.counts.uniqueContentUnits, 1340);

  const reuse = claims.get("MPSEM-0118-C01");
  assert.equal(reuse.sourcePinRef, `${sourcePath}@${sourceCommit}`);
  assert.deepEqual(reuse.historicalSourceLines, [257, 257]);
  assert.deepEqual(reuse.currentSourceLines, [260, 260]);
  assert.ok(historical[256].includes(".product-experience/phase-0-product-truth/reuse-decisions.yaml"));
  assert.ok(current[259].includes(reuse.exactClaim));
  assert.equal(reuse.mappingStatus, "CANDIDATE_TARGET");
  assert.deepEqual(reuse.candidatePdpRefs, [".product-experience/pdp-0-product-truth/reuse-decisions.yaml"]);
  assert.equal(manifest.find(({ path }) => path === reuse.exactClaim)?.artifactId, "ART-P0-REUSE-DECISIONS");
  assert.deepEqual(identity.find(({ path }) => path === reuse.exactClaim), {
    path: reuse.exactClaim,
    artifactId: "ART-P0-REUSE-DECISIONS",
    authorityClass: "PRODUCT_TRUTH_AUTHORITY",
  });
  assert.ok(readFileSync(resolve(root, reuse.exactClaim), "utf8").length > 0);

  const authorityRoot = claims.get("MPSEM-0164-C01");
  assert.equal(authorityRoot.sourcePinRef, `${sourcePath}@${sourceCommit}`);
  assert.deepEqual(authorityRoot.historicalSourceLines, [351, 351]);
  assert.deepEqual(authorityRoot.currentSourceLines, [355, 355]);
  assert.ok(historical[350].includes("phase-0-product-truth/"));
  assert.ok(current[354].includes(authorityRoot.exactClaim));
  assert.equal(authorityRoot.mappingStatus, "PARTIAL_CANDIDATE");
  assert.ok(manifest.some(({ path }) => path === ".product-experience/pdp-0-product-truth/constitution.yaml"));
  assert.ok(generated.sourceAuthorities.some(({ sourceRef }) => sourceRef === ".product-experience/pdp-0-product-truth/constitution.yaml"));

  const explorer = claims.get("MPSEM-0463-C01");
  assert.equal(explorer.sourcePinRef, `${sourcePath}@${sourceCommit}`);
  assert.deepEqual(explorer.historicalSourceLines, [1075, 1075]);
  assert.deepEqual(explorer.currentSourceLines, [1089, 1089]);
  assert.ok(historical[1074].includes("PRODUCT-CONSTITUTION.md"));
  assert.ok(current[1087].includes("apps/"));
  assert.ok(current[1088].includes(explorer.exactClaim));
  assert.ok(review.sourceChangeLedger.clusters.find(({ id }) => id === "MSC-04").currentLineSpans.includes(1089));
  assert.equal(explorer.mappingStatus, "UNMAPPED");
  assert.deepEqual(explorer.candidatePdpRefs, [], "Explorer remains outside PDP authority mappings");
  assert.ok(readFileSync(resolve(root, ".product-experience/explorer/EXPERIENCE-EXPLORER.md"), "utf8").includes("apps/media-experience-explorer/"));
  assert.ok(readFileSync(resolve(root, ".product-experience/executable-representation/host-map.yaml"), "utf8").includes("apps/media-experience-explorer"));
  assert.equal(manifest.find(({ path }) => path === ".product-experience/explorer/EXPERIENCE-EXPLORER.md")?.authorityClass, "EXPLORER_PROJECTION");
  assert.equal(manifest.some(({ path }) => path === "apps/media-experience-explorer"), false, "the application identity gap remains explicit");

  for (const [id, claim] of claims) {
    assert.equal(claim.acceptanceEffect, "none", `${id} cannot accept a target`);
    assert.equal(unresolved.get(claim.unresolvedClaimRef)?.status, "UNRESOLVED", `${id} keeps its unmapped remainder open`);
  }
  for (const itemId of ["MPSEM-0118", "MPSEM-0164", "MPSEM-0463"]) {
    assert.equal(review.items.find(({ itemId: id }) => id === itemId).classification === "RESOLVED", false, `${itemId} remains open`);
  }
});

test("MSC-05 source-scope claims map explicit PDP-0 and Explorer records while leaving absent projections open", () => {
  const review = readYaml(reviewPath);
  const historical = execFileSync("git", ["show", `${review.sourceChangeLedger.historicalSource.commit}:${sourcePath}`], {
    cwd: root,
    encoding: "utf8",
  }).split("\n");
  const current = readFileSync(resolve(root, sourcePath), "utf8").split("\n");
  const sourceManifest = readYaml(".product-experience/source-manifest.yaml");
  const records = sourceManifest.productArtifactIndex.records;
  const identities = readYaml(".product-experience/artifact-identities.yaml").records;
  const generatedPdp0 = JSON.parse(readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/generated/product-definition.candidate.json"), "utf8"));
  const itemIds = ["MPSEM-0165", "MPSEM-0166", "MPSEM-0167"];
  const claims = new Map(review.claimDecompositions.filter(({ itemId }) => itemIds.includes(itemId)).map((claim) => [claim.claimId, claim]));
  const fragments = new Map(review.unresolvedClaimFragments.filter(({ itemId }) => itemIds.includes(itemId)).map((fragment) => [fragment.fragmentId, fragment]));
  const manifestRecord = (path) => records.find((record) => record.path === path);
  const checkPinnedClaim = (claim, oldLine, newLine) => {
    assert.equal(claim.sourcePinRef, `${sourcePath}@${review.sourceChangeLedger.historicalSource.commit}`);
    assert.deepEqual(claim.historicalSourceLines, [oldLine, oldLine]);
    assert.deepEqual(claim.currentSourceLines, [newLine, newLine]);
    if (claim.historicalCounterpart) assert.ok(historical[oldLine - 1].includes(claim.historicalCounterpart), `${claim.claimId} pins historical source`);
    assert.ok(current[newLine - 1].includes(claim.exactClaim), `${claim.claimId} pins current source`);
    assert.equal(claim.acceptanceEffect, "none");
  };

  assert.equal(review.sourcePin.sha256, review.sourceChangeLedger.historicalSource.sha256, "the stale source pin remains unchanged");
  assert.equal(review.ownerDecisionOverlay.resolvedBlockCount, 0);
  assert.equal(review.ownerDecisionOverlay.unresolvedBlockCount, 263);
  assert.equal(review.counts.uniqueContentUnits, 1340);
  assert.equal(review.counts.blockStructureProposalCounts.ownerReviewed, 0);
  assert.deepEqual(review.sourceChangeLedger.clusters.find(({ id }) => id === "MSC-05").historicalLineSpans, [357, 359, 361]);
  assert.deepEqual(review.sourceChangeLedger.clusters.find(({ id }) => id === "MSC-05").currentLineSpans, [364, 366, 368]);

  for (const claimId of ["MPSEM-0165-C01", "MPSEM-0165-C02"]) {
    const claim = claims.get(claimId);
    checkPinnedClaim(claim, 357, 364);
    assert.equal(claim.mappingStatus, "UNMAPPED");
    assert.deepEqual(claim.candidatePdpRefs, []);
    assert.equal(fragments.get(claim.unresolvedClaimRef)?.status, "UNRESOLVED");
  }
  const rootGaps = manifestRecord(".product-experience/gaps.yaml");
  const rootAcceptance = manifestRecord(".product-experience/acceptance.yaml");
  assert.equal(rootGaps?.artifactId, "ART-GOV-GAPS");
  assert.equal(rootGaps?.owningPhase, "CROSS_PHASE");
  assert.equal(rootGaps?.generatedOrAuthored, "AUTHORED");
  assert.equal(rootAcceptance?.artifactId, "ART-P0-ACCEPTANCE-INPUTS");
  assert.equal(rootAcceptance?.owningPhase, "CROSS_PHASE");
  assert.equal(records.some(({ path }) => /^\.product-experience\/pdp-[0-3]-[^/]+\/(gaps|coverage|acceptance)(\.|\/)/u.test(path)), false, "no PDP-local filtered ledger file is currently registered");
  assert.equal(manifestRecord("capabilities.yaml"), undefined);
  assert.equal(manifestRecord("dependencies.yaml"), undefined);
  assert.equal(generatedPdp0.projectionStatus, "GENERATED_CANDIDATE_NOT_ACCEPTED_NOT_CURRENT");
  assert.equal(generatedPdp0.sourceAuthorities.some(({ sourceRef }) => sourceRef === "capabilities.yaml" || sourceRef === "dependencies.yaml"), false);

  const reuse = claims.get("MPSEM-0166-C01");
  checkPinnedClaim(reuse, 359, 366);
  assert.equal(reuse.mappingStatus, "CANDIDATE_TARGET");
  assert.deepEqual(reuse.candidatePdpRefs, [".product-experience/pdp-0-product-truth/reuse-decisions.yaml"]);
  const reuseRecord = manifestRecord(".product-experience/pdp-0-product-truth/reuse-decisions.yaml");
  assert.equal(reuseRecord?.artifactId, "ART-P0-REUSE-DECISIONS");
  assert.equal(reuseRecord?.authorityClass, "PRODUCT_TRUTH_AUTHORITY");
  assert.equal(reuseRecord?.owningPhase, "PDP-0");
  assert.equal(reuseRecord?.generatedOrAuthored, "AUTHORED");
  assert.equal(reuseRecord?.acceptanceState, "PENDING_OWNER_REVIEW");
  assert.deepEqual(identities.find(({ path }) => path === reuseRecord.path), {
    path: reuseRecord.path,
    artifactId: "ART-P0-REUSE-DECISIONS",
    authorityClass: "PRODUCT_TRUTH_AUTHORITY",
  });
  for (const claimId of ["MPSEM-0166-C02", "MPSEM-0166-C03", "MPSEM-0166-C04"]) {
    const claim = claims.get(claimId);
    checkPinnedClaim(claim, 359, 366);
    assert.equal(claim.mappingStatus, "UNMAPPED");
    assert.deepEqual(claim.candidatePdpRefs, []);
    assert.equal(fragments.get(claim.unresolvedClaimRef)?.status, "UNRESOLVED");
    for (const path of ["config/reuse-decisions.yaml", "config/dependency-bindings.yaml", "config/oss-components.yaml"].filter((p) => claim.exactClaim.includes(p))) {
      assert.equal(manifestRecord(path), undefined, `${path} has no exact source-manifest identity`);
      assert.equal(existsSync(resolve(root, path)), false, `${path} is not a current repository file`);
    }
  }

  const ownership = claims.get("MPSEM-0167-C01");
  checkPinnedClaim(ownership, 361, 368);
  assert.equal(ownership.mappingStatus, "PARTIAL_CANDIDATE");
  assert.deepEqual(ownership.candidatePdpRefs, [".product-experience/source-manifest.yaml#/productArtifactIndex/records"]);
  const sampleRecord = manifestRecord(".product-experience/pdp-0-product-truth/reuse-decisions.yaml");
  for (const key of ["artifactId", "title", "owner", "authorityClass", "owningPhase", "path", "generatedOrAuthored", "semanticFingerprint", "dependencies", "dependents", "verification", "acceptanceState"]) {
    assert.ok(Object.hasOwn(sampleRecord, key), `source-manifest record includes ${key}`);
  }
  assert.equal(fragments.get(ownership.unresolvedClaimRef)?.status, "UNRESOLVED", "the ownership-field distinction stays open");

  const explorer = claims.get("MPSEM-0167-C02");
  checkPinnedClaim(explorer, 361, 368);
  assert.equal(sourceManifest.authorityModel.explorerOutsidePdpPhases, true);
  assert.equal(explorer.mappingStatus, "EXPLORER_BOUNDARY_CROSSWALKED_PENDING_COMPLETE_LINKAGE");
  assert.deepEqual(explorer.candidatePdpRefs, [], "Explorer is not routed to a PDP authority");
  const explorerRecords = records.filter(({ authorityClass }) => authorityClass === "EXPLORER_PROJECTION");
  assert.ok(explorerRecords.length > 0);
  assert.ok(explorerRecords.every(({ owningPhase }) => owningPhase === "EXPLORER"));
  assert.ok(explorerRecords.every(({ acceptanceState }) => acceptanceState === "PENDING_OWNER_REVIEW"));
  assert.equal(fragments.get(explorer.unresolvedClaimRef)?.status, "UNRESOLVED");

  for (const itemId of itemIds) {
    const item = review.items.find(({ itemId: id }) => id === itemId);
    assert.notEqual(item.classification, "RESOLVED", `${itemId} remains unresolved`);
    assert.notEqual(item.blockStructureProposal?.status, "OWNER_REVIEWED", `${itemId} remains proposal-only`);
  }
});

test("MSC-07 routes scene validation, budgets, boundary, and locale claims only to exact source records", () => {
  const review = readYaml(reviewPath);
  const historical = execFileSync("git", ["show", `${review.sourceChangeLedger.historicalSource.commit}:${sourcePath}`], {
    cwd: root,
    encoding: "utf8",
  }).split("\n");
  const current = readFileSync(resolve(root, sourcePath), "utf8").split("\n");
  const timeUnits = readYaml(".product-experience/pdp-0-product-truth/time-units-fidelity.yaml");
  const values = readYaml(".product-experience/pdp-1-domain-data/value-objects.yaml");
  const nfr = readYaml(".product-experience/pdp-0-product-truth/nonfunctional-requirements.yaml");
  const channels = readYaml(".product-experience/pdp-0-product-truth/applications-channels.yaml");
  const acceptance = readYaml(".product-experience/acceptance.yaml");
  const authority = readYaml(".product-experience/authority-map.yaml");
  const items = new Map(review.items.map((item) => [item.itemId, item]));
  const claimIds = ["MPSEM-0261-C01", "MPSEM-0389-C01", "MPSEM-0403-C01", "MPSEM-0453-C01", "MPSEM-0453-C02"];
  const claims = new Map(review.claimDecompositions.filter(({ claimId }) => claimIds.includes(claimId)).map((claim) => [claim.claimId, claim]));
  const fragments = new Map(review.unresolvedClaimFragments.filter(({ claimId }) => claimIds.includes(claimId)).map((fragment) => [fragment.claimId, fragment]));
  const expectClaim = (id, oldLine, newLine) => {
    const claim = claims.get(id);
    assert.equal(claim.sourcePinRef, `${sourcePath}@${review.sourceChangeLedger.historicalSource.commit}`);
    assert.deepEqual(claim.historicalSourceLines, [oldLine, oldLine]);
    assert.deepEqual(claim.currentSourceLines, [newLine, newLine]);
    if (claim.historicalCounterpart) assert.ok(historical[oldLine - 1].includes(claim.historicalCounterpart), `${id} exact historical text`);
    assert.ok(current[newLine - 1].includes(claim.exactClaim), `${id} exact current text`);
    assert.equal(claim.acceptanceEffect, "none");
    assert.equal(fragments.get(id)?.status, "UNRESOLVED", `${id} keeps its remaining scope open`);
    return claim;
  };

  assert.equal(review.sourcePin.sha256, review.sourceChangeLedger.historicalSource.sha256, "the source pin remains stale");
  assert.equal(review.ownerDecisionOverlay.resolvedBlockCount, 0);
  assert.equal(review.ownerDecisionOverlay.unresolvedBlockCount, 263);
  assert.equal(review.counts.uniqueContentUnits, 1340);
  assert.equal(review.counts.blockStructureProposalCounts.ownerReviewed, 0);

  const coordinates = expectClaim("MPSEM-0261-C01", 577, 584);
  assert.equal(coordinates.mappingStatus, "OWNER_ROUTE_CROSSWALKED_PENDING_DOMAIN_VALIDATION");
  assert.deepEqual(coordinates.candidatePdpRefs, [
    ".product-experience/pdp-0-product-truth/time-units-fidelity.yaml#/unitAndCoordinateProposal",
    ".product-experience/pdp-1-domain-data/value-objects.yaml#/observedTemporalSpatialFields/canonicalization/coordinate-system",
  ]);
  assert.equal(timeUnits.unitAndCoordinateProposal.status, "proposed-by-master-plan; validation-against-admitted-scene-model-contracts-pending");
  assert.equal(values.observedTemporalSpatialFields.canonicalization["coordinate-system"], "unresolved; no handedness, axis, origin, units, transform order, or normalization rule accepted");

  const budgets = expectClaim("MPSEM-0389-C01", 884, 891);
  assert.equal(budgets.mappingStatus, "TARGET_RECORD_CROSSWALKED_PENDING_QUALIFICATION");
  assert.deepEqual(budgets.candidatePdpRefs, [".product-experience/pdp-0-product-truth/nonfunctional-requirements.yaml#/requirements/7"]);
  assert.equal(nfr.requirements[7].id, "NFR-PERF-001");
  assert.equal(nfr.requirements[7].initialProposedBudgets.length, 6);
  assert.equal(nfr.requirements[7].acceptance, "targets-are-proposals-until-environment-corpus-load-method-and-owner-approval-are-recorded");

  const boundary = expectClaim("MPSEM-0403-C01", 911, 918);
  assert.equal(boundary.mappingStatus, "EXISTING_BOUNDARY_RECORD_CROSSWALKED");
  assert.deepEqual(boundary.candidatePdpRefs, [
    ".product-experience/acceptance.yaml#/recordedHumanDecisionInputs/0",
    ".product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md#P0-001-boundary-slice",
    ".product-experience/authority-map.yaml#/phaseAuthorities/0",
  ]);
  const acceptedBoundary = acceptance.recordedHumanDecisionInputs.find(({ id }) => id === "ACCEPT-INPUT-P0-001");
  assert.equal(acceptedBoundary.decisionInput, "accepted", "this slice only references the already-recorded boundary input");
  assert.deepEqual(acceptedBoundary.acceptedScope, [
    "Media product identity and bounded repository/product boundary",
    "Initial ownership split, including the MDI-001 supplemental decision",
    "Named consumer and compatibility commitments in the boundary record",
    "Authority-transfer conditions and the rule that migration preparation is not cutover",
  ], "the reviewed claim scope is compared against the recorded acceptance evidence, not inferred from a fingerprint");
  assert.ok(boundary.mappingBasis.includes("term by term to ACCEPT-INPUT-P0-001.acceptedScope"));
  assert.ok(boundary.mappingBasis.includes("does not expand acceptance to full PDP-0, PDP-1, later phases, runtime implementation, or cutover"));
  assert.equal(fragments.get("MPSEM-0403-C01")?.status, "UNRESOLVED", "the plan's broader authority and sequencing remainder remains open");
  assert.match(authority.phaseAuthorities[0].acceptance, /P0-001-boundary-slice-only/u);

  const localeIntent = expectClaim("MPSEM-0453-C01", 1020, 1027);
  assert.equal(localeIntent.mappingStatus, "INTENT_TARGET_CROSSWALKED_PENDING_LOCALE_ADMISSION");
  assert.deepEqual(localeIntent.candidatePdpRefs, [
    ".product-experience/pdp-0-product-truth/applications-channels.yaml#/localeAdmission",
    ".product-experience/pdp-0-product-truth/nonfunctional-requirements.yaml#/requirements/5",
  ]);
  assert.equal(channels.localeAdmission.status, "no-product-locale-set-admitted");
  assert.equal(nfr.requirements[5].id, "NFR-LOC-001");
  const localeData = expectClaim("MPSEM-0453-C02", 1020, 1027);
  assert.equal(localeData.mappingStatus, "UNMAPPED");
  assert.deepEqual(localeData.candidatePdpRefs, [], "no PDP-1 language/data authority is inferred from observed fields");

  for (const itemId of ["MPSEM-0261", "MPSEM-0389", "MPSEM-0403", "MPSEM-0453"]) {
    assert.notEqual(items.get(itemId).classification, "RESOLVED", `${itemId} remains unresolved`);
    assert.notEqual(items.get(itemId).blockStructureProposal?.status, "OWNER_REVIEWED", `${itemId} remains proposal-only`);
  }
});

test("MSC-08 separates PDP-0 path identity from changed completion criteria", () => {
  const review = readYaml(reviewPath);
  const historical = execFileSync("git", ["show", `${review.sourceChangeLedger.historicalSource.commit}:${sourcePath}`], {
    cwd: root,
    encoding: "utf8",
  }).split("\n");
  const current = readFileSync(resolve(root, sourcePath), "utf8").split("\n");
  const items = new Map(review.items.map((item) => [item.itemId, item]));
  const claims = new Map(review.claimDecompositions.filter(({ itemId }) => ["MPSEM-0478", "MPSEM-0499"].includes(itemId)).map((claim) => [claim.claimId, claim]));
  const fragments = new Map(review.unresolvedClaimFragments.filter(({ itemId }) => ["MPSEM-0478", "MPSEM-0499"].includes(itemId)).map((fragment) => [fragment.claimId, fragment]));
  const sourceManifest = readYaml(".product-experience/source-manifest.yaml");
  const manifestRecords = sourceManifest.productArtifactIndex.records;
  const identities = readYaml(".product-experience/artifact-identities.yaml").records;
  const authorityMap = readYaml(".product-experience/authority-map.yaml");
  const p0 = readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md"), "utf8");
  const requirements = readYaml(".product-experience/pdp-0-product-truth/requirements.yaml");
  const policy = readYaml(".product-experience/pdp-0-product-truth/policy-authority-model.yaml");
  const states = readYaml(".product-experience/pdp-0-product-truth/state-models.yaml");
  const channels = readYaml(".product-experience/pdp-0-product-truth/applications-channels.yaml");
  const journeys = readYaml(".product-experience/pdp-0-product-truth/journey-catalog.yaml");
  const leafReview = readYaml(".product-experience/pdp-0-product-truth/capability-leaf-review.yaml");
  const generated = JSON.parse(readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/generated/product-definition.candidate.json"), "utf8"));
  const manifestRecord = (path) => manifestRecords.find((record) => record.path === path);
  const verifySource = (claimId, historicalLine, currentLine) => {
    const claim = claims.get(claimId);
    assert.equal(claim.sourcePinRef, `${sourcePath}@${review.sourceChangeLedger.historicalSource.commit}`);
    assert.deepEqual(claim.historicalSourceLines, [historicalLine, historicalLine]);
    assert.deepEqual(claim.currentSourceLines, [currentLine, currentLine]);
    assert.ok(historical[historicalLine - 1].includes(claim.historicalCounterpart), `${claimId} historical source`);
    assert.ok(current[currentLine - 1].includes(claim.exactClaim), `${claimId} current source`);
    assert.equal(claim.acceptanceEffect, "none");
    assert.equal(fragments.get(claimId)?.status, "UNRESOLVED", `${claimId} keeps its unresolved remainder`);
    return claim;
  };

  assert.equal(review.sourcePin.sha256, review.sourceChangeLedger.historicalSource.sha256, "the master-plan source pin stays stale");
  assert.equal(review.ownerDecisionOverlay.resolvedBlockCount, 0);
  assert.equal(review.ownerDecisionOverlay.unresolvedBlockCount, 263);
  assert.equal(review.counts.uniqueContentUnits, 1340);
  assert.equal(review.counts.blockStructureProposalCounts.ownerReviewed, 0);
  assert.equal(items.get("MPSEM-0478").classification, "EXECUTION_ONLY", "the stored path-source item is unchanged");
  assert.equal(items.get("MPSEM-0499").classification, "EXECUTION_ONLY", "the stored pass-criteria item is unchanged");
  assert.ok(items.get("MPSEM-0478").text.includes("phase-0-product-truth/"), "stored source text remains historical");
  assert.ok(items.get("MPSEM-0499").text.includes("state transitions and dependencies are defined"), "stored criteria text remains historical");

  const pathClaim = verifySource("MPSEM-0478-C01", 1167, 1177);
  assert.equal(pathClaim.mappingStatus, "PATH_IDENTITY_CROSSWALKED");
  assert.deepEqual(pathClaim.candidatePdpRefs, [".product-experience/pdp-0-product-truth/"]);
  assert.ok(authorityMap.canonicalPdpPhases.some(({ id, path }) => id === "PDP-0" && path === pathClaim.candidatePdpRefs[0]));
  assert.match(p0, /P0-001 migration boundary slice/u);
  assert.ok(manifestRecords.some(({ path }) => path.startsWith(pathClaim.candidatePdpRefs[0])));
  assert.equal(identities.some(({ path }) => path.startsWith(pathClaim.candidatePdpRefs[0])), true);
  assert.equal(generated.projectionStatus, "GENERATED_CANDIDATE_NOT_ACCEPTED_NOT_CURRENT");
  assert.ok(generated.sourceAuthorities.some(({ sourceRef }) => sourceRef === ".product-experience/pdp-0-product-truth/requirements.yaml"));
  const registration = verifySource("MPSEM-0478-C02", 1167, 1177);
  assert.equal(registration.mappingStatus, "AUTHORITY_MAP_CANDIDATE");
  assert.deepEqual(registration.candidatePdpRefs, [".product-experience/authority-map.yaml#/phaseAuthorities/0/artifacts"]);
  assert.ok(authorityMap.phaseAuthorities[0].artifacts.some(({ path }) => path === "pdp-0-product-truth/requirements.yaml"));

  const sourceSet = verifySource("MPSEM-0499-C01", 1195, 1201);
  assert.equal(sourceSet.mappingStatus, "SOURCE_SET_CROSSWALKED_PENDING_RECONCILIATION");
  const expectedSourcePaths = [
    ".product-experience/pdp-0-product-truth/requirements.yaml",
    ".product-experience/pdp-0-product-truth/capabilities.yaml",
    ".product-experience/pdp-0-product-truth/actors-responsibilities.yaml",
    ".product-experience/pdp-0-product-truth/goals-jtbd.yaml",
  ];
  assert.deepEqual(sourceSet.candidatePdpRefs, expectedSourcePaths);
  for (const path of expectedSourcePaths) {
    assert.ok(manifestRecord(path), `${path} is in the source manifest`);
    assert.ok(identities.find(({ path: identityPath }) => identityPath === path), `${path} has a stable artifact identity`);
    assert.ok(generated.sourceAuthorities.some(({ sourceRef }) => sourceRef === path), `${path} is listed in the generated PDP-0 candidate`);
  }
  assert.match(generated.projectionStatus, /NOT_ACCEPTED_NOT_CURRENT/u);

  const failureCriteria = verifySource("MPSEM-0499-C02", 1195, 1201);
  assert.equal(failureCriteria.mappingStatus, "PARTIAL_CANDIDATE");
  assert.ok(failureCriteria.candidatePdpRefs.includes(".product-experience/pdp-0-product-truth/policy-authority-model.yaml"));
  assert.ok(failureCriteria.candidatePdpRefs.includes(".product-experience/pdp-0-product-truth/requirements.yaml"));
  assert.ok(policy.productPolicy, "the PDP-0 policy authority record exists");
  assert.ok(requirements.requirements.some(({ failureDegradationRecovery }) => failureDegradationRecovery));
  assert.ok(states.models.length > 0);
  assert.match(authorityMap.authorityRules.find(({ id }) => id === "AUTH-RULE-ACCEPTANCE").rule, /all other PDP-0 records are proposals/u);

  const scopeDisposition = verifySource("MPSEM-0499-C03", 1195, 1201);
  assert.equal(scopeDisposition.mappingStatus, "PARTIAL_CANDIDATE_PENDING_FULL_SCOPE");
  assert.ok(channels.channels.length > 0);
  assert.equal(channels.status.maturity, "proposed-for-phase-0-review");
  assert.equal(journeys.status.acceptance, "not-submitted");
  assert.equal(leafReview.denominatorReconciliation.capabilityLeaves, 462);
  assert.equal(leafReview.denominatorReconciliation.leavesWithOwnerCoverageDisposition, 79);
  assert.equal(leafReview.denominatorReconciliation.unresolvedCoverageDispositions, 383);

  const authorityClosure = verifySource("MPSEM-0499-C04", 1195, 1201);
  assert.equal(authorityClosure.mappingStatus, "PARTIAL_CANDIDATE");
  assert.equal(authorityMap.authorityRules.find(({ id }) => id === "AUTH-RULE-ONE-OWNER").rule, "Each semantic concept has one editable owner; consumer records and projections do not become parallel authorities.");
  assert.ok(manifestRecords.every(({ artifactId, path }) => artifactId && path), "manifest records carry artifact identity and path fields");

  const changedCriteria = claims.get("MPSEM-0499-C05");
  assert.equal(changedCriteria.sourcePinRef, `${sourcePath}@${review.sourceChangeLedger.historicalSource.commit}`);
  assert.deepEqual(changedCriteria.historicalSourceLines, [1195, 1195]);
  assert.deepEqual(changedCriteria.currentSourceLines, [1201, 1201]);
  assert.ok(historical[1194].includes(changedCriteria.exactClaim), "removed criteria are pinned to the historical source");
  assert.equal(current[1200].includes("state transitions and dependencies are defined"), false, "the new pass sentence omits these explicit criteria");
  assert.equal(current[1200].includes("trust/fidelity"), false, "the new pass sentence omits explicit trust/fidelity wording");
  assert.equal(changedCriteria.mappingStatus, "CRITERION_CHANGE_REQUIRES_OWNER_REVIEW");
  assert.equal(changedCriteria.acceptanceEffect, "none");
  assert.equal(fragments.get("MPSEM-0499-C05")?.status, "UNRESOLVED");
  const removedTrustFidelity = claims.get("MPSEM-0499-C06");
  assert.deepEqual(removedTrustFidelity.historicalSourceLines, [1195, 1195]);
  assert.deepEqual(removedTrustFidelity.currentSourceLines, [1201, 1201]);
  assert.ok(historical[1194].includes(removedTrustFidelity.exactClaim));
  assert.equal(current[1200].includes(removedTrustFidelity.exactClaim), false);
  assert.equal(removedTrustFidelity.mappingStatus, "CRITERION_CHANGE_REQUIRES_OWNER_REVIEW");
  assert.deepEqual(removedTrustFidelity.candidatePdpRefs, [
    ".product-experience/pdp-0-product-truth/quality-policy.yaml",
    ".product-experience/pdp-0-product-truth/qualification-policy.yaml",
  ]);
  assert.equal(removedTrustFidelity.acceptanceEffect, "none");
  assert.equal(fragments.get("MPSEM-0499-C06")?.status, "UNRESOLVED");
});

test("MSC-10 viewport fixture wording maps only to the proposed PDP-2 responsive record", () => {
  const review = readYaml(reviewPath);
  const historical = execFileSync("git", ["show", `${review.sourceChangeLedger.historicalSource.commit}:${sourcePath}`], {
    cwd: root,
    encoding: "utf8",
  }).split("\n");
  const current = readFileSync(resolve(root, sourcePath), "utf8").split("\n");
  const responsive = readYaml(".product-experience/pdp-2-design-interface-system/responsive-adaptive.yaml");
  const claim = review.claimDecompositions.find(({ claimId }) => claimId === "MPSEM-0504-C01");
  const fragment = review.unresolvedClaimFragments.find(({ fragmentId }) => fragmentId === "MPSEM-0504-U01");
  const expected = ["1536x960", "1280x800", "1024x768", "768x1024", "390x844", "320x640"];

  assert.equal(review.sourcePin.sha256, review.sourceChangeLedger.historicalSource.sha256);
  assert.equal(review.ownerDecisionOverlay.resolvedBlockCount, 0);
  assert.equal(review.ownerDecisionOverlay.unresolvedBlockCount, 263);
  assert.equal(review.counts.uniqueContentUnits, 1340);
  assert.equal(review.items.find(({ itemId }) => itemId === "MPSEM-0504").classification, "EXECUTION_ONLY");
  assert.deepEqual(claim.historicalSourceLines, [1215, 1215]);
  assert.deepEqual(claim.currentSourceLines, [1229, 1229]);
  assert.ok(historical[1214].includes("product test fixtures to accept in Phase 1, not universal device claims"));
  assert.ok(current[1228].includes(claim.exactClaim));
  assert.equal(claim.mappingStatus, "FIXTURE_CROSSWALKED_PENDING_ACCEPTANCE");
  assert.deepEqual(claim.candidatePdpRefs, [".product-experience/pdp-2-design-interface-system/responsive-adaptive.yaml"]);
  assert.deepEqual(responsive.variants["wide-desktop"].viewports, expected.slice(0, 2));
  assert.deepEqual(responsive.variants["compact-desktop"].viewports, expected.slice(2, 3));
  assert.deepEqual(responsive.variants.tablet.viewports, expected.slice(3, 4));
  assert.deepEqual(responsive.variants.mobile.viewports, expected.slice(4));
  assert.equal(responsive.status, "authored-proposal; P0-010-and-human-viewport-review-pending");
  assert.match(responsive.statusNote, /proposed verification fixtures, not supported-device claims/u);
  assert.equal(claim.acceptanceEffect, "none");
  assert.equal(fragment.status, "UNRESOLVED");
});

test("MSC-10 crosswalks the legacy design-artifact names to current PDP-2 paths only", () => {
  const review = readYaml(reviewPath);
  const historical = execFileSync("git", ["show", `${review.sourceChangeLedger.historicalSource.commit}:${sourcePath}`], {
    cwd: root,
    encoding: "utf8",
  }).split("\n");
  const current = readFileSync(resolve(root, sourcePath), "utf8").split("\n");
  const manifest = readYaml(".product-experience/source-manifest.yaml").productArtifactIndex.records;
  const identities = readYaml(".product-experience/artifact-identities.yaml").records;
  const names = [
    "DESIGN-LANGUAGE.md", "media-token-aliases.yaml", "typography-layout.yaml",
    "component-contracts.yaml", "semantic-state-grammar.yaml", "action-finality-grammar.yaml",
    "trust-provenance-grammar.yaml", "media-editing-grammar.yaml", "animation-simulation-grammar.yaml",
    "responsive-adaptive.yaml", "accessibility.yaml", "localization-content.yaml", "motion.yaml", "cli-language.yaml",
  ];
  const claims = new Map(review.claimDecompositions.filter(({ itemId }) => itemId === "MPSEM-0501").map((claim) => [claim.claimId, claim]));
  const fragments = new Map(review.unresolvedClaimFragments.filter(({ itemId }) => itemId === "MPSEM-0501").map((fragment) => [fragment.claimId, fragment]));

  assert.equal(review.sourceChangeLedger.sourcePinDisposition, "keep-stale");
  assert.equal(review.ownerDecisionOverlay.resolvedBlockCount, 0);
  assert.equal(review.ownerDecisionOverlay.unresolvedBlockCount, 263);
  assert.deepEqual(review.counts.blockStructureProposalCounts.MIXED_REQUIRES_DECOMPOSITION, 124);
  assert.equal(review.items.find(({ itemId }) => itemId === "MPSEM-0501").classification, "EXECUTION_ONLY");
  assert.equal(claims.size, names.length);

  for (const [index, name] of names.entries()) {
    const suffix = String(index + 1).padStart(2, "0");
    const claimId = `MPSEM-0501-C${suffix}`;
    const claim = claims.get(claimId);
    const fragment = fragments.get(claimId);
    const target = `.product-experience/pdp-2-design-interface-system/${name}`;
    assert.ok(claim, `${claimId} exists`);
    assert.deepEqual(claim.historicalSourceLines, [1207, 1207]);
    assert.deepEqual(claim.currentSourceLines, [1221, 1221]);
    assert.ok(historical[1206].includes("phase-1-design-language/") && historical[1206].includes(name));
    assert.ok(current[1220].includes("pdp-2-design-interface-system/") && current[1220].includes(name));
    assert.equal(claim.mappingStatus, "PATH_IDENTITY_CROSSWALKED");
    assert.deepEqual(claim.candidatePdpRefs, [target]);
    assert.ok(manifest.find(({ path }) => path === target)?.artifactId, `${target} is in the source manifest`);
    assert.ok(identities.find(({ path }) => path === target)?.artifactId, `${target} has an artifact identity`);
    assert.ok(readFileSync(resolve(root, target), "utf8").length > 0, `${target} exists`);
    assert.equal(claim.acceptanceEffect, "none");
    assert.equal(fragment?.status, "UNRESOLVED");
  }
});

test("MSC-11 maps only the P1-001 workstream label to the registered PDP-2 authority", () => {
  const review = readYaml(reviewPath);
  const historical = execFileSync("git", ["show", `${review.sourceChangeLedger.historicalSource.commit}:${sourcePath}`], {
    cwd: root,
    encoding: "utf8",
  }).split("\n");
  const current = readFileSync(resolve(root, sourcePath), "utf8").split("\n");
  const authorityMap = readYaml(".product-experience/authority-map.yaml");
  const claim = review.claimDecompositions.find(({ claimId }) => claimId === "MPSEM-0636-C01");
  const dependencyText = review.claimDecompositions.find(({ claimId }) => claimId === "MPSEM-0636-C02");
  const fragment = review.unresolvedClaimFragments.find(({ fragmentId }) => fragmentId === "MPSEM-0636-U01");

  assert.equal(review.sourcePin.sha256, review.sourceChangeLedger.historicalSource.sha256);
  assert.equal(review.ownerDecisionOverlay.resolvedBlockCount, 0);
  assert.equal(review.ownerDecisionOverlay.unresolvedBlockCount, 263);
  assert.equal(review.counts.uniqueContentUnits, 1340);
  assert.equal(review.items.find(({ itemId }) => itemId === "MPSEM-0636").classification, "EXECUTION_ONLY");
  assert.deepEqual(claim.historicalSourceLines, [1430, 1430]);
  assert.deepEqual(claim.currentSourceLines, [1444, 1444]);
  assert.ok(historical[1429].includes("| P1-001 | Phase 1 |"));
  assert.ok(current[1443].includes(claim.exactClaim));
  assert.equal(claim.mappingStatus, "WORKSTREAM_CROSSWALKED_PENDING_TASK_SCOPE_RECONCILIATION");
  assert.deepEqual(claim.candidatePdpRefs, [".product-experience/pdp-2-design-interface-system/"]);
  assert.ok(authorityMap.canonicalPdpPhases.some(({ id, path }) => id === "PDP-2" && path === claim.candidatePdpRefs[0]));
  assert.equal(claim.acceptanceEffect, "none");
  assert.deepEqual(dependencyText.historicalSourceLines, [1430, 1430]);
  assert.deepEqual(dependencyText.currentSourceLines, [1444, 1444]);
  assert.equal(dependencyText.historicalCounterpart, "| P1-001 | Phase 1 | P0-010, GOV-002 |");
  assert.equal(dependencyText.exactClaim, "| P1-001 | PDP-2 (legacy P1 task group) | P0-010, GOV-002 |");
  assert.ok(historical[1429].includes(dependencyText.historicalCounterpart));
  assert.ok(current[1443].includes(dependencyText.exactClaim));
  assert.equal(dependencyText.mappingStatus, "TASK_INDEX_DEPENDENCY_TEXT_PRESERVED");
  assert.match(dependencyText.mappingBasis, /row-text preservation only/u);
  assert.match(dependencyText.mappingBasis, /does not establish dependency meaning, task-card scope, owner routing, source currency, or acceptance/u);
  assert.equal(dependencyText.acceptanceEffect, "none");
  assert.equal(fragment.status, "UNRESOLVED");
});

test("MSC-12 crosswalks only the GOV-002 reuse-register path and stable artifact identity", () => {
  const review = readYaml(reviewPath);
  const historical = execFileSync("git", ["show", `${review.sourceChangeLedger.historicalSource.commit}:${sourcePath}`], {
    cwd: root,
    encoding: "utf8",
  }).split("\n");
  const current = readFileSync(resolve(root, sourcePath), "utf8").split("\n");
  const manifest = readYaml(".product-experience/source-manifest.yaml").productArtifactIndex.records;
  const identities = readYaml(".product-experience/artifact-identities.yaml").records;
  const authorityMap = readYaml(".product-experience/authority-map.yaml");
  const claim = review.claimDecompositions.find(({ claimId }) => claimId === "MPSEM-0683-C01");
  const fragment = review.unresolvedClaimFragments.find(({ fragmentId }) => fragmentId === "MPSEM-0683-U01");
  const reusePath = ".product-experience/pdp-0-product-truth/reuse-decisions.yaml";

  assert.equal(review.sourcePin.sha256, review.sourceChangeLedger.historicalSource.sha256);
  assert.equal(review.ownerDecisionOverlay.resolvedBlockCount, 0);
  assert.equal(review.ownerDecisionOverlay.unresolvedBlockCount, 263);
  assert.equal(review.counts.uniqueContentUnits, 1340);
  assert.equal(review.items.find(({ itemId }) => itemId === "MPSEM-0683").classification, "EXECUTION_ONLY");
  assert.deepEqual(claim.historicalSourceLines, [1492, 1492]);
  assert.deepEqual(claim.currentSourceLines, [1506, 1506]);
  assert.ok(historical[1491].includes(".product-experience/phase-0-product-truth/reuse-decisions.yaml"));
  assert.ok(current[1505].includes(reusePath));
  assert.equal(claim.mappingStatus, "PATH_IDENTITY_CROSSWALKED");
  assert.deepEqual(claim.candidatePdpRefs, [reusePath]);
  assert.equal(manifest.find(({ path }) => path === reusePath)?.artifactId, "ART-P0-REUSE-DECISIONS");
  assert.deepEqual(identities.find(({ path }) => path === reusePath), {
    path: reusePath,
    artifactId: "ART-P0-REUSE-DECISIONS",
    authorityClass: "PRODUCT_TRUTH_AUTHORITY",
  });
  assert.ok(authorityMap.phaseAuthorities[0].artifacts.some(({ path }) => path === "pdp-0-product-truth/reuse-decisions.yaml"));
  assert.ok(readFileSync(resolve(root, reusePath), "utf8").length > 0);
  assert.equal(claim.acceptanceEffect, "none");
  assert.equal(fragment.status, "UNRESOLVED");
});

test("MSC-14 pins the legacy Phase 0 crosswalk to the registered PDP-0 authority root", () => {
  const review = readYaml(reviewPath);
  const historical = execFileSync("git", ["show", `${review.sourceChangeLedger.historicalSource.commit}:${sourcePath}`], {
    cwd: root,
    encoding: "utf8",
  }).split("\n");
  const current = readFileSync(resolve(root, sourcePath), "utf8").split("\n");
  const authorityMap = readYaml(".product-experience/authority-map.yaml");
  const claim = review.claimDecompositions.find(({ claimId }) => claimId === "MPSEM-1210-C01");
  const fragment = review.unresolvedClaimFragments.find(({ fragmentId }) => fragmentId === "MPSEM-1210-U01");
  const p0Root = ".product-experience/pdp-0-product-truth/";

  assert.equal(review.sourcePin.sha256, review.sourceChangeLedger.historicalSource.sha256);
  assert.equal(review.ownerDecisionOverlay.resolvedBlockCount, 0);
  assert.equal(review.ownerDecisionOverlay.unresolvedBlockCount, 263);
  assert.equal(review.counts.uniqueContentUnits, 1340);
  assert.equal(review.items.find(({ itemId }) => itemId === "MPSEM-1210").classification, "EVIDENCE_REFERENCE", "Appendix A task-ID crosswalk remains reference-only");
  assert.deepEqual(claim.historicalSourceLines, [2611, 2611]);
  assert.deepEqual(claim.currentSourceLines, [2625, 2625]);
  assert.ok(historical[2610].includes("| 20 Phase0 | §18; P0-001–010 |"));
  assert.ok(current[2624].includes(claim.exactClaim));
  assert.equal(claim.mappingStatus, "PDP_AUTHORITY_ROUTE_CROSSWALKED_PENDING_ITEM_REVIEW");
  assert.deepEqual(claim.candidatePdpRefs, [p0Root]);
  assert.ok(authorityMap.canonicalPdpPhases.some(({ id, path }) => id === "PDP-0" && path === p0Root));
  assert.equal(claim.acceptanceEffect, "none");
  assert.equal(fragment.status, "UNRESOLVED");
});

test("MSC-15 crosswalks the four-authority taxonomy while preserving the broader assessment gap", () => {
  const review = readYaml(reviewPath);
  const historical = execFileSync("git", ["show", `${review.sourceChangeLedger.historicalSource.commit}:${sourcePath}`], {
    cwd: root,
    encoding: "utf8",
  }).split("\n");
  const current = readFileSync(resolve(root, sourcePath), "utf8").split("\n");
  const authorityMap = readYaml(".product-experience/authority-map.yaml");
  const claim = review.claimDecompositions.find(({ claimId }) => claimId === "MPSEM-0017-C01");
  const fragment = review.unresolvedClaimFragments.find(({ fragmentId }) => fragmentId === "MPSEM-0017-U01");
  const pdpRoots = [
    ".product-experience/pdp-0-product-truth/",
    ".product-experience/pdp-1-domain-data/",
    ".product-experience/pdp-2-design-interface-system/",
    ".product-experience/pdp-3-product-experience/",
  ];

  assert.equal(review.sourcePin.sha256, review.sourceChangeLedger.historicalSource.sha256);
  assert.equal(review.ownerDecisionOverlay.resolvedBlockCount, 0);
  assert.equal(review.ownerDecisionOverlay.unresolvedBlockCount, 263);
  assert.equal(review.counts.uniqueContentUnits, 1340);
  assert.equal(review.items.find(({ itemId }) => itemId === "MPSEM-0017").classification, "UNRESOLVED");
  assert.deepEqual(claim.historicalSourceLines, [89, 89]);
  assert.deepEqual(claim.currentSourceLines, [92, 92]);
  assert.ok(historical[88].includes(claim.historicalCounterpart));
  assert.ok(current[91].includes(claim.exactClaim));
  assert.equal(claim.mappingStatus, "AUTHORITY_SET_CROSSWALKED_PENDING_SEMANTIC_REVIEW");
  assert.deepEqual(claim.candidatePdpRefs, pdpRoots);
  const registeredPdpRoots = authorityMap.canonicalPdpPhases.filter(({ id }) => id.startsWith("PDP-")).map(({ path }) => path);
  assert.deepEqual(registeredPdpRoots, pdpRoots);
  assert.equal(authorityMap.canonicalPdpPhases.find(({ id }) => id === "EXPLORER").outsidePdpPhases, true);
  for (const path of pdpRoots) assert.ok(existsSync(resolve(root, path)), `${path} exists`);
  assert.equal(claim.acceptanceEffect, "none");
  assert.equal(fragment.status, "UNRESOLVED");
});

test("MSC-13 maps only the retained P2 task group to the registered PDP-3 authority", () => {
  const review = readYaml(reviewPath);
  const historical = execFileSync("git", ["show", `${review.sourceChangeLedger.historicalSource.commit}:${sourcePath}`], {
    cwd: root,
    encoding: "utf8",
  }).split("\n");
  const current = readFileSync(resolve(root, sourcePath), "utf8").split("\n");
  const authorityMap = readYaml(".product-experience/authority-map.yaml");
  const claim = review.claimDecompositions.find(({ claimId }) => claimId === "MPSEM-1157-C01");
  const fragment = review.unresolvedClaimFragments.find(({ fragmentId }) => fragmentId === "MPSEM-1157-U01");
  const p3Root = ".product-experience/pdp-3-product-experience/";

  assert.equal(review.sourcePin.sha256, review.sourceChangeLedger.historicalSource.sha256);
  assert.equal(review.ownerDecisionOverlay.resolvedBlockCount, 0);
  assert.equal(review.ownerDecisionOverlay.unresolvedBlockCount, 263);
  assert.equal(review.counts.uniqueContentUnits, 1340);
  assert.equal(review.items.find(({ itemId }) => itemId === "MPSEM-1157").classification, "EXECUTION_ONLY");
  assert.deepEqual(claim.historicalSourceLines, [2534, 2534]);
  assert.deepEqual(claim.currentSourceLines, [2548, 2548]);
  assert.ok(historical[2533].includes("P2-001–008 define Web/CLI/API/embedded behavior"));
  assert.ok(current[2547].includes(claim.exactClaim));
  assert.equal(claim.mappingStatus, "WORKSTREAM_CROSSWALKED_PENDING_SCOPE_RECONCILIATION");
  assert.deepEqual(claim.candidatePdpRefs, [p3Root]);
  assert.ok(authorityMap.canonicalPdpPhases.some(({ id, path }) => id === "PDP-3" && path === p3Root));
  assert.ok(existsSync(resolve(root, p3Root)));
  assert.equal(claim.acceptanceEffect, "none");
  assert.equal(fragment.status, "UNRESOLVED");
});

test("P0-003 future relabeling cannot remove a capability from the preserved scope", () => {
  const review = readYaml(reviewPath);
  const historical = execFileSync("git", ["show", `${review.sourceChangeLedger.historicalSource.commit}:${sourcePath}`], {
    cwd: root,
    encoding: "utf8",
  }).split("\n");
  const current = readFileSync(resolve(root, sourcePath), "utf8").split("\n");
  const crosswalk = readYaml(".product-experience/pdp-0-product-truth/capability-preservation-crosswalk.yaml");
  const items = new Map(review.items.map((item) => [item.itemId, item]));
  const claim = review.claimDecompositions.find(({ claimId }) => claimId === "MPSEM-0170-C01");
  const unresolved = review.unresolvedClaimFragments.find(({ fragmentId }) => fragmentId === "MPSEM-0170-U01");
  const historicalText = historical[371].trim();
  const currentText = current[378].trim();
  const capabilityIds = crosswalk.familyCrosswalk.flatMap(({ capabilityIds: ids }) => ids);

  assert.equal(review.sourcePin.sha256, review.sourceChangeLedger.historicalSource.sha256, "the plan pin remains stale");
  assert.equal(review.ownerDecisionOverlay.resolvedBlockCount, 0);
  assert.equal(review.ownerDecisionOverlay.unresolvedBlockCount, 263);
  assert.equal(review.counts.uniqueUnitsByClassification.UNRESOLVED, 263);
  assert.equal(items.get("MPSEM-0170").classification, "UNRESOLVED", "the bounded claim does not resolve its mixed parent block");
  assert.equal(items.get("MPSEM-0170").blockStructureProposal.status, "PROPOSAL_ONLY");
  assert.equal(claim.sourcePinRef, `docs/migration/expert-reviewed-master-plan.md@${review.sourceChangeLedger.historicalSource.commit}`);
  assert.deepEqual(claim.historicalSourceLines, [372, 372]);
  assert.deepEqual(claim.currentSourceLines, [379, 379]);
  assert.equal(claim.exactClaim, "An operation cannot vanish by being relabeled “future.”");
  assert.ok(historicalText.includes(claim.exactClaim));
  assert.ok(currentText.includes(claim.exactClaim));
  assert.equal(claim.reviewStatus, "BOUNDED_SOURCE_REVIEWED");
  assert.equal(claim.mappingStatus, "SCOPE_CROSSWALKED_PENDING_SEMANTIC_DETAIL");
  assert.deepEqual(claim.candidatePdpRefs, [".product-experience/pdp-0-product-truth/capability-preservation-crosswalk.yaml#/rules/0"]);
  assert.match(crosswalk.rules[0], /every §6 family\/operation is represented by one leaf or an explicit semantic alias/iu);
  assert.match(crosswalk.rules[0], /462 canonical capability leaf IDs exactly once, without reducing the denominator/iu);
  assert.equal(new Set(capabilityIds).size, 462);
  assert.equal(capabilityIds.length, 462);
  assert.equal(claim.acceptanceEffect, "none");
  assert.equal(unresolved.status, "UNRESOLVED");
  assert.match(unresolved.text, /availability treatment/u, "adjacent mixed assertions remain explicitly unresolved");
});

test("MSC-07 erasure routing is crosswalked while proposed state and effect semantics remain unresolved", () => {
  const review = readYaml(reviewPath);
  const historical = execFileSync("git", ["show", `${review.sourceChangeLedger.historicalSource.commit}:${sourcePath}`], {
    cwd: root,
    encoding: "utf8",
  }).split("\n");
  const current = readFileSync(resolve(root, sourcePath), "utf8").split("\n");
  const states = readYaml(".product-experience/pdp-1-domain-data/states.yaml");
  const policy = readYaml(".product-experience/pdp-0-product-truth/policy-authority-model.yaml");
  const items = new Map(review.items.map((item) => [item.itemId, item]));
  const claim = review.claimDecompositions.find(({ claimId }) => claimId === "MPSEM-0366-C01");
  const unresolved = review.unresolvedClaimFragments.find(({ fragmentId }) => fragmentId === "MPSEM-0366-U01");
  const erasureStateIds = ["ERASURE_REQUESTED", "ACCESS_REVOKED", "PHYSICAL_ERASURE_PENDING", "ERASURE_CONFIRMED", "BLOCKED_BY_HOLD", "EXTERNAL_ERASURE_UNCONFIRMED"];
  const stateRecord = states.stateMachines.find(({ machineId }) => machineId === "media-upload-and-artifact");

  assert.equal(review.sourcePin.sha256, review.sourceChangeLedger.historicalSource.sha256, "the master-plan pin remains stale");
  assert.equal(review.ownerDecisionOverlay.resolvedBlockCount, 0);
  assert.equal(review.ownerDecisionOverlay.unresolvedBlockCount, 263);
  assert.equal(review.counts.uniqueUnitsByClassification.UNRESOLVED, 263);
  assert.equal(review.counts.blockStructureProposalCounts.ownerReviewed, 0);
  assert.equal(items.get("MPSEM-0366").classification, "UNRESOLVED", "the bounded owner route does not resolve the mixed item");
  assert.deepEqual(claim.historicalSourceLines, [820, 820]);
  assert.deepEqual(claim.currentSourceLines, [827, 827]);
  assert.equal(claim.exactClaim, "State names are product proposals to reconcile in PDP-1, with policy meaning retained by PDP-0.");
  assert.equal(claim.historicalCounterpart, "State names are product proposals to materialize in Phase 0.");
  assert.ok(historical[819].includes(claim.historicalCounterpart));
  assert.ok(current[826].includes(claim.exactClaim));
  assert.equal(claim.reviewStatus, "BOUNDED_SOURCE_REVIEWED");
  assert.equal(claim.mappingStatus, "OWNER_BOUNDARY_CROSSWALKED_PENDING_STATE_REVIEW");
  assert.deepEqual(claim.candidatePdpRefs, [
    ".product-experience/pdp-1-domain-data/states.yaml#/stateMachines/2",
    ".product-experience/pdp-0-product-truth/policy-authority-model.yaml#/productPolicy/dataHandling/deletion",
  ]);
  assert.ok(erasureStateIds.every((stateId) => stateRecord.stateIds.includes(stateId)));
  assert.ok(erasureStateIds.every((stateId) => policy.productPolicy.dataHandling.deletion.states.includes(stateId)));
  assert.match(states.authorityStatus, /proposal-only/u);
  assert.match(stateRecord.meaningDisposition, /pending-owner-review/u);
  assert.match(policy.productPolicy.authorityStatus, /authored-proposal/u);
  assert.match(claim.mappingBasis, /supports only the source's owner-boundary distinction/u);
  assert.equal(claim.acceptanceEffect, "none");
  assert.equal(unresolved.status, "UNRESOLVED");
  assert.match(unresolved.text, /physical-erasure finality/u);
});

test("MSC-02 bounds the changed DEFINE_PRODUCT scope without resolving its mixed block", () => {
  const review = readYaml(reviewPath);
  const historical = execFileSync("git", ["show", `${review.sourceChangeLedger.historicalSource.commit}:${sourcePath}`], {
    cwd: root,
    encoding: "utf8",
  }).split("\n");
  const current = readFileSync(resolve(root, sourcePath), "utf8").split("\n");
  const items = new Map(review.items.map((item) => [item.itemId, item]));
  const claims = review.claimDecompositions.filter(({ itemId }) => itemId === "MPSEM-0005");
  const unresolved = review.unresolvedClaimFragments.filter(({ itemId }) => itemId === "MPSEM-0005");
  const authorityMap = readYaml(".product-experience/authority-map.yaml");

  assert.equal(review.sourcePin.sha256, review.sourceChangeLedger.historicalSource.sha256, "the source pin stays stale");
  assert.equal(review.ownerDecisionOverlay.resolvedBlockCount, 0);
  assert.equal(review.ownerDecisionOverlay.unresolvedBlockCount, 263);
  assert.equal(review.counts.uniqueUnitsByClassification.UNRESOLVED, 263);
  assert.equal(items.get("MPSEM-0005").classification, "UNRESOLVED");
  assert.equal(items.get("MPSEM-0005").blockStructureProposal.status, "PROPOSAL_ONLY");
  assert.equal(claims.length, 3);
  assert.equal(unresolved.length, 3);
  for (const claim of claims) {
    assert.equal(claim.sourcePinRef, `docs/migration/expert-reviewed-master-plan.md@${review.sourceChangeLedger.historicalSource.commit}`);
    assert.deepEqual(claim.historicalSourceLines, [22, 22]);
    assert.deepEqual(claim.currentSourceLines, [24, 24]);
    assert.ok(historical[21].includes(claim.historicalCounterpart));
    assert.ok(current[23].includes(claim.exactClaim));
    assert.equal(claim.reviewStatus, "BOUNDED_SOURCE_REVIEWED");
    assert.equal(claim.acceptanceEffect, "none");
  }
  const deterministic = claims.find(({ claimId }) => claimId === "MPSEM-0005-C02");
  const explorer = claims.find(({ claimId }) => claimId === "MPSEM-0005-C03");
  assert.equal(deterministic.exactClaim, "as their deterministic projection.");
  assert.equal(deterministic.mappingStatus, "UNMAPPED");
  assert.deepEqual(deterministic.candidatePdpRefs, []);
  assert.equal(explorer.exactClaim, "builds the Experience Explorer");
  assert.equal(explorer.mappingStatus, "EXPLORER_WORKSTREAM_CROSSWALKED_PENDING_SCOPE_REVIEW");
  assert.deepEqual(explorer.candidatePdpRefs, [
    ".product-experience/authority-map.yaml#/canonicalPdpPhases/4",
    ".product-experience/authority-map.yaml#/phaseAuthorities/4",
  ]);
  assert.equal(authorityMap.canonicalPdpPhases[4].id, "EXPLORER");
  assert.equal(authorityMap.canonicalPdpPhases[4].outsidePdpPhases, true);
  assert.equal(authorityMap.phaseAuthorities.find(({ phase }) => phase === "EXPLORER").acceptance, "not-accepted; prerequisite-PDP-3-pending");
  assert.equal(review.unresolvedClaimFragments.find(({ fragmentId }) => fragmentId === "MPSEM-0005-U03").status, "UNRESOLVED");
  assert.equal(unresolved.every(({ status }) => status === "UNRESOLVED"), true);
});

test("MSC-03 authority rows are source-pinned to PDP candidates without accepting parent items", () => {
  const review = readYaml(reviewPath);
  const historical = execFileSync("git", ["show", `${review.sourceChangeLedger.historicalSource.commit}:${sourcePath}`], {
    cwd: root,
    encoding: "utf8",
  }).split("\n");
  const current = readFileSync(resolve(root, sourcePath), "utf8").split("\n");
  const items = new Map(review.items.map((item) => [item.itemId, item]));
  const claims = review.claimDecompositions.filter(({ itemId }) => ["MPSEM-0122", "MPSEM-0157", "MPSEM-0158", "MPSEM-0159", "MPSEM-0160"].includes(itemId));
  const unresolved = review.unresolvedClaimFragments.filter(({ itemId }) => ["MPSEM-0122", "MPSEM-0157", "MPSEM-0158", "MPSEM-0159", "MPSEM-0160"].includes(itemId));
  const expected = new Map([
    ["MPSEM-0122-C01", [284, 287]],
    ["MPSEM-0157-C01", [329, 332]],
    ["MPSEM-0157-C02", [329, 333]],
    ["MPSEM-0158-C01", [330, 334]],
    ["MPSEM-0159-C01", [331, 335]],
    ["MPSEM-0160-C01", [332, 336]],
  ]);

  assert.equal(review.sourcePin.sha256, review.sourceChangeLedger.historicalSource.sha256, "the master-plan source pin remains stale");
  assert.equal(review.ownerDecisionOverlay.resolvedBlockCount, 0);
  assert.equal(review.ownerDecisionOverlay.unresolvedBlockCount, 263);
  assert.equal(review.counts.uniqueUnitsByClassification.UNRESOLVED, 263);
  assert.equal(review.counts.blockStructureProposalCounts.MIXED_REQUIRES_DECOMPOSITION, 124);
  assert.equal(review.counts.blockStructureProposalCounts.ownerReviewed, 0);
  assert.equal(claims.length, expected.size);
  assert.equal(unresolved.length, expected.size);
  for (const claim of claims) {
    const [historicalLine, currentLine] = expected.get(claim.claimId);
    assert.equal(claim.sourcePinRef, `docs/migration/expert-reviewed-master-plan.md@${review.sourceChangeLedger.historicalSource.commit}`);
    assert.deepEqual(claim.historicalSourceLines, [historicalLine, historicalLine]);
    assert.deepEqual(claim.currentSourceLines, [currentLine, currentLine]);
    assert.ok(historical[historicalLine - 1].includes(claim.historicalCounterpart), `${claim.claimId} historical counterpart is exact source text`);
    assert.ok(current[currentLine - 1].includes(claim.exactClaim), `${claim.claimId} claim is exact current source text`);
    assert.equal(claim.reviewStatus, "BOUNDED_SOURCE_REVIEWED");
    assert.equal(claim.acceptanceEffect, "none");
    assert.equal(items.get(claim.itemId).classification, "UNRESOLVED");
    assert.equal(items.get(claim.itemId).blockStructureProposal.status, "PROPOSAL_ONLY");
    assert.equal(unresolved.some(({ fragmentId, status }) => fragmentId === claim.unresolvedClaimRef && status === "UNRESOLVED"), true);
    for (const ref of claim.candidatePdpRefs) {
      assert.doesNotThrow(() => readFileSync(resolve(root, ref.split("#")[0]), "utf8"), `${claim.claimId} candidate exists: ${ref}`);
    }
  }
  const explorer = claims.find(({ claimId }) => claimId === "MPSEM-0160-C01");
  const authorityMap = readYaml(".product-experience/authority-map.yaml");
  const sourceManifest = readYaml(".product-experience/source-manifest.yaml");
  assert.equal(authorityMap.canonicalPdpPhases[4].id, "EXPLORER");
  assert.equal(authorityMap.canonicalPdpPhases[4].outsidePdpPhases, true);
  assert.match(authorityMap.canonicalPdpPhases[4].semanticOwner, /projection owner does not own PDP meaning/u);
  const explorerWorkstream = authorityMap.phaseAuthorities.find(({ phase }) => phase === "EXPLORER");
  assert.equal(explorerWorkstream.acceptance, "not-accepted; prerequisite-PDP-3-pending");
  const explorerOverview = sourceManifest.productArtifactIndex.records.find(({ path }) => path === ".product-experience/explorer/EXPERIENCE-EXPLORER.md");
  assert.equal(explorerOverview.authorityClass, "EXPLORER_PROJECTION");
  assert.equal(explorerOverview.owningPhase, "EXPLORER");
  assert.equal(explorerOverview.semanticStatus, "PROPOSAL_PENDING_OWNER_REVIEW");
  assert.equal(explorer.mappingStatus, "EXPLORER_BOUNDARY_CROSSWALKED_PENDING_PROJECTION_LINKAGE");
  assert.deepEqual(explorer.candidatePdpRefs, []);
  assert.match(explorer.mappingBasis, /does not establish deterministic projection behavior/u);
  assert.match(unresolved.find(({ fragmentId }) => fragmentId === explorer.unresolvedClaimRef).text, /accepted PDP inputs/u);
  assert.ok(unresolved.every(({ status }) => status === "UNRESOLVED"));
});

test("MSC-01 and MSC-09 owner-routing claims are reconciled at bounded source spans", () => {
  const review = readYaml(reviewPath);
  const evidence = review.migrationClaimReconciliations;
  const plan = readFileSync(resolve(root, sourcePath), "utf8").split("\n");
  const checklistPath = "/home/samujjwal/Downloads/Ghatana-Media-TODO-Checklist-2026-10-07.md";
  const checklist = readFileSync(checklistPath, "utf8");
  const authority = readYaml(".product-experience/authority-map.yaml");
  const decisions = readFileSync(resolve(root, ".product-experience/decision-log.md"), "utf8");
  const truth = readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md"), "utf8");
  const domain = readYaml(".product-experience/pdp-0-product-truth/domain-model.yaml");
  const states = readYaml(".product-experience/pdp-0-product-truth/state-models.yaml");
  const time = readYaml(".product-experience/pdp-0-product-truth/time-units-fidelity.yaml");
  const claims = evidence.claims;
  const scopedRoutingClaims = claims.filter(({ clusterId }) => ["MSC-01", "MSC-09"].includes(clusterId));
  const byId = new Map(claims.map((claim) => [claim.claimId, claim]));

  // The two unmapped semantic-diff clusters have no historical MPSEM item.
  // Pin their source phrases directly so the bounded claim overlay cannot
  // silently outgrow (or drift away from) the current text it routes.
  const legacyTaxonomyText = plan[13];
  const pdp1AuthorityText = plan[1208];
  assert.match(legacyTaxonomyText, /legacy `Phase 0`–`Phase 3` labels and `P0-`–`P3-` execution IDs/u);
  assert.match(legacyTaxonomyText, /legacy Phase\/P0 → PDP-0, except P0-004 and P0-005 which are owned by PDP-1/u);
  assert.match(legacyTaxonomyText, /legacy Phase\/P1 → PDP-2/u);
  assert.match(legacyTaxonomyText, /legacy Phase\/P2 → PDP-3/u);
  assert.match(legacyTaxonomyText, /legacy Phase\/P3 → Experience Explorer, outside the PDP phases/u);
  assert.match(legacyTaxonomyText, /Existing IDs and task content are preserved/u);
  assert.match(pdp1AuthorityText, /`P0-004` \(domain\/time\/unit semantics\) and `P0-005` \(state\/transition semantics\) map to PDP-1/u);
  assert.match(pdp1AuthorityText, /Their related PDP-0 requirements, policy and product-boundary decisions remain PDP-0/u);
  assert.match(pdp1AuthorityText, /Do not infer authority from a legacy prefix or copy an unresolved PDP-0 proposal into PDP-1 without reconciliation and owner review/u);

  assert.equal(evidence.schemaVersion, "media.migration-claim-reconciliation.v1");
  assert.equal(new Set(claims.map(({ claimId }) => claimId)).size, claims.length);
  assert.equal(claims.filter(({ clusterId }) => clusterId === "MSC-01").length, 4);
  assert.equal(claims.filter(({ clusterId }) => clusterId === "MSC-09").length, 5);
  for (const claim of claims) {
    assert.ok(["supported", "contradicted", "superseded", "unresolved"].includes(claim.disposition));
    assert.equal(claim.acceptanceEffect, "none");
    assert.ok(claim.reviewBasis.length);
    assert.ok(claim.rationale.length);
    for (const [start, end] of [claim.masterPlanLines]) {
      assert.ok(start > 0 && end >= start && end <= plan.length);
      assert.ok(plan.slice(start - 1, end).join("\n").includes(claim.exactClaim.split(" ")[0].replace(/^\W+/u, "")) || claim.masterPlanLines[0] === 1209);
    }
  }
  assert.equal(byId.get("MSC-01-C01").disposition, "supported");
  assert.equal(byId.get("MSC-01-C02").disposition, "supported");
  assert.equal(byId.get("MSC-01-C03").disposition, "supported");
  assert.equal(byId.get("MSC-01-C04").disposition, "superseded");
  assert.equal(byId.get("MSC-09-C01").disposition, "supported");
  assert.equal(byId.get("MSC-09-C02").disposition, "supported");
  assert.equal(byId.get("MSC-09-C03").disposition, "supported");
  assert.equal(byId.get("MSC-09-C04").disposition, "supported");
  assert.equal(byId.get("MSC-09-C05").disposition, "superseded");
  assert.equal(scopedRoutingClaims.filter(({ disposition }) => disposition === "supported").length, 7);
  assert.equal(scopedRoutingClaims.filter(({ disposition }) => disposition === "superseded").length, 2);
  assert.equal(scopedRoutingClaims.filter(({ disposition }) => disposition === "unresolved").length, 0);
  assert.ok(scopedRoutingClaims.every(({ acceptanceEffect }) => acceptanceEffect === "none"), "new MSC-01/09 routing claims remain non-accepting source proposals");
  assert.match(checklist, /`P0-04` \| P0 \| Resolve ProductDefinition actor/u);
  assert.match(checklist, /`P0-05` \| P0 \| Resolve ProductDefinition rules/u);
  assert.doesNotMatch(checklist, /`P0-004`|`P0-005`/u);

  assert.match(authority.phaseAuthorities[0].scope, /product-level\s+policy/u);
  assert.match(authority.phaseAuthorities[0].scope, /product requirements for temporal\/fidelity preservation/u);
  assert.match(authority.phaseAuthorities[0].scope, /PDP-1 owns canonical domain objects/u);
  assert.match(authority.phaseAuthorities[1].scope, /Canonical domain objects, values and units/u);
  assert.match(authority.phaseAuthorities[1].scope, /detailed\s+transition\/effect semantics/u);
  assert.match(truth, /PDP-1 owns canonical\ndomain objects/u);
  assert.match(truth, /phase authority boundary is settled\nfor task routing/u);
  assert.match(truth, /record-level source\ncrosswalks, extraction, exact mappings, specialist review, and PDP-1 owner\nacceptance remain open/u);
  assert.match(decisions, /PXD-003 — Approve the canonical four-phase authority model/u);
  assert.match(decisions, /\*\*Approved:\*\* PDP-0 owns Product Truth; PDP-1 owns canonical domain\/data\s+meaning/u);
  assert.match(decisions, /PXD-026 — Accept bounded Media owner semantic policies/u);
  assert.match(decisions, /\*\*Approved:\*\* canonical four-phase source-of-truth authority/u);
  assert.equal(domain.phaseTask, "P0-004");
  assert.equal(domain.status.maturity, "proposal");
  assert.equal(time.phaseTask, "P0-004");
  assert.equal(time.status.maturity, "proposal-with-source-observations");
  assert.match(states.authorityStatus, /pending-P0-010-independent-acceptance/u);
  assert.match(states.authorityStatus, /authored-proposal/u);
  assert.equal(authority.canonicalPdpPhases[1].id, "PDP-1");
  assert.equal(authority.phaseAuthorities[0].acceptance, "P0-001-boundary-slice-only");
  assert.equal(authority.phaseAuthorities[1].acceptance, "pending-PDP-0-independent-review-and-domain-owner-acceptance");
  assert.equal(authority.canonicalPdpPhases[4].id, "EXPLORER");
  assert.equal(authority.canonicalPdpPhases[4].outsidePdpPhases, true);
  assert.equal(review.sourcePin.sha256, review.sourceChangeLedger.historicalSource.sha256);
  assert.equal(review.ownerDecisionOverlay.resolvedBlockCount, 0);
});

test("MSC-03 canonical domain ownership slice is supported without phase acceptance", () => {
  const review = readYaml(reviewPath);
  const plan = readFileSync(resolve(root, sourcePath), "utf8").split("\n");
  const authority = readYaml(".product-experience/authority-map.yaml");
  const decisions = readFileSync(resolve(root, ".product-experience/decision-log.md"), "utf8");
  const truth = readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md"), "utf8");
  const claim = review.migrationClaimReconciliations.claims.find(({ claimId }) => claimId === "MSC-03-C01");

  assert.ok(claim, "one bounded MSC-03 claim is recorded");
  assert.equal(claim.clusterId, "MSC-03");
  assert.deepEqual(claim.masterPlanLines, [333, 333]);
  assert.ok(plan[332].includes(claim.exactClaim), "the exact ownership slice is present at its cited source line");
  assert.equal(claim.disposition, "supported");
  assert.equal(claim.acceptanceEffect, "none");
  assert.ok(claim.reviewBasis.includes(".product-experience/decision-log.md#PXD-003"));
  assert.match(decisions, /PXD-003[\s\S]*?PDP-1 owns canonical domain\/data\s+meaning/u);
  assert.match(authority.phaseAuthorities[0].scope, /PDP-1 owns canonical domain objects, values/u);
  assert.match(truth, /PDP-1 owns canonical\ndomain objects, values/u);
  assert.match(claim.rationale, /record-level extraction, specialist review, and PDP-1 acceptance remain open/u);
  assert.equal(review.ownerDecisionOverlay.resolvedBlockCount, 0);
  assert.equal(review.ownerDecisionOverlay.unresolvedBlockCount, 263);
  assert.deepEqual(review.counts.uniqueContentUnits, 1340);
  assert.equal(review.counts.blockStructureProposalCounts.ownerReviewed, 0);
  assert.equal(review.sourcePin.sha256, review.sourceChangeLedger.historicalSource.sha256);
});

test("MSC-03 four-phase taxonomy diff has bounded owner-routing reconciliation only", () => {
  const review = readYaml(reviewPath);
  const evidence = review.migrationClaimReconciliations;
  const source = readFileSync(resolve(root, sourcePath), "utf8").split("\n");
  const expected = new Map([
    ["MSC-03-C01", [333, "PDP-1 — Domain & Data | Canonical domain objects, values"]],
    ["MSC-03-C02", [332, "PDP-0 — Product Truth"]],
    ["MSC-03-C03", [334, "PDP-2 — Design & Interface System"]],
    ["MSC-03-C04", [335, "PDP-3 — Product Experience"]],
    ["MSC-03-C05", [336, "Experience Explorer — outside the PDP phases"]],
  ]);
  const claims = new Map(evidence.claims.map((claim) => [claim.claimId, claim]));
  const hunk = review.sourceChangeLedger.diffHunkCoverage.records.find(({ hunkId }) => hunkId === "MSD-009");
  const decisions = readFileSync(resolve(root, ".product-experience/decision-log.md"), "utf8");

  assert.equal(evidence.claims.filter(({ clusterId }) => clusterId === "MSC-03").length, expected.size);
  for (const [claimId, [line, exactText]] of expected) {
    const claim = claims.get(claimId);
    assert.ok(claim, `${claimId} is recorded`);
    assert.deepEqual(claim.masterPlanLines, [line, line]);
    assert.equal(claim.exactClaim, exactText);
    assert.equal(source[line - 1].includes(exactText), true, `${claimId} matches its exact current source line`);
    assert.equal(claim.disposition, "supported");
    assert.equal(claim.acceptanceEffect, "none");
    assert.ok(claim.reviewBasis.length > 0);
  }
  assert.match(decisions, /PXD-003 — Approve the canonical four-phase authority model/u);
  assert.match(decisions, /PDP-0 owns Product Truth; PDP-1 owns canonical domain\/data\s+meaning; PDP-2 owns design and interface systems; PDP-3 owns complete\s+product experiences; the Experience Explorer is a projection outside those\s+phases/u);
  assert.match(decisions, /PXD-027 — Approve bounded semantic-source decisions/u);
  assert.ok(hunk.disposition.startsWith("partially reconciled; bounded phase-owner routing claims supported"));
  assert.equal(hunk.acceptanceEffect, "none");
  assert.equal(review.sourceChangeLedger.sourcePinDisposition, "keep-stale");
  assert.deepEqual(review.sourceChangeLedger.unchangedReviewCounts, {
    uniqueUnits: 1340,
    unresolved: 263,
    mixedRequiresDecomposition: 124,
    ownerReviewed: 0,
  });
});

test("MSC-10 PDP-3 upstream input routing is decomposed without accepting the inputs", () => {
  const review = readYaml(reviewPath);
  const ledger = review.sourceChangeLedger;
  const historical = execFileSync("git", ["show", `${ledger.historicalSource.commit}:${sourcePath}`], {
    cwd: root,
    encoding: "utf8",
  }).split("\n");
  const current = readFileSync(resolve(root, sourcePath), "utf8").split("\n");
  const claims = review.migrationClaimReconciliations.claims.filter(({ clusterId }) => clusterId === "MSC-10");
  const expected = new Map([
    ["MSC-10-C01", "Consume accepted PDP-0 meaning"],
    ["MSC-10-C02", "PDP-1 domain/data semantics"],
    ["MSC-10-C03", "PDP-2 representation"],
  ]);

  assert.equal(review.sourcePin.sha256, ledger.historicalSource.sha256);
  assert.equal(review.ownerDecisionOverlay.resolvedBlockCount, 0);
  assert.equal(review.items.find(({ itemId }) => itemId === "MPSEM-0507").classification, "EXECUTION_ONLY");
  assert.equal(claims.length, expected.size);
  for (const [claimId, exactClaim] of expected) {
    const claim = claims.find((item) => item.claimId === claimId);
    assert.ok(claim, `${claimId} is recorded`);
    assert.deepEqual(claim.masterPlanLines, [1243, 1243]);
    assert.ok(current[1242].includes("Consume accepted PDP-0 meaning, PDP-1 domain/data semantics, and PDP-2 representation."));
    assert.ok(historical[1228].includes("Consume accepted Phase0 meaning and Phase1 representation."));
    assert.equal(claim.exactClaim, exactClaim);
    assert.equal(claim.disposition, "supported");
    assert.equal(claim.acceptanceEffect, "none");
    assert.ok(claim.rationale.includes("only"));
  }
  assert.deepEqual(ledger.unchangedReviewCounts, {
    uniqueUnits: 1340,
    unresolved: 263,
    mixedRequiresDecomposition: 124,
    ownerReviewed: 0,
  });
});

test("MSC-15 routes semantic edits to the owning authority without resolving the historical parent block", () => {
  const review = readYaml(reviewPath);
  const ledger = review.sourceChangeLedger;
  const line = readFileSync(resolve(root, sourcePath), "utf8").split("\n")[2818];
  const historicalLine = execFileSync("git", ["show", `${ledger.historicalSource.commit}:${sourcePath}`], {
    cwd: root,
    encoding: "utf8",
  }).split("\n")[2804];
  const claim = review.migrationClaimReconciliations.claims.find(({ claimId }) => claimId === "MSC-15-C01");
  const hunk = ledger.diffHunkCoverage.records.find(({ hunkId }) => hunkId === "MSD-119");

  assert.ok(line.includes("Update the owning PDP-0–PDP-3 authority when implementation exposes a semantic gap"));
  assert.ok(historicalLine.includes("Update owning Phase0–2 when implementation exposes a semantic gap"));
  assert.equal(claim.clusterId, "MSC-15");
  assert.deepEqual(claim.masterPlanLines, [2819, 2819]);
  assert.equal(claim.exactClaim, "Update the owning PDP-0–PDP-3 authority when implementation exposes a semantic gap");
  assert.equal(claim.disposition, "supported");
  assert.deepEqual(claim.reviewBasis, [
    ".product-experience/authority-map.yaml#/authorityRules/0",
    ".product-experience/pdp-0-product-truth/schema-bindings.yaml#/projectionRules/edits",
  ]);
  assert.equal(claim.acceptanceEffect, "none");
  assert.equal(hunk.clusterId, "MSC-15");
  assert.deepEqual(hunk.historicalLines, [2805, 2805]);
  assert.deepEqual(hunk.currentLines, [2819, 2819]);
  assert.match(hunk.disposition, /semantic equivalence unresolved/u);
  assert.equal(hunk.acceptanceEffect, "none");
  assert.equal(ledger.clusters.find(({ id }) => id === "MSC-15").disposition, "source-scope change");
  assert.equal(review.items.find(({ itemId }) => itemId === "MPSEM-1336").classification, "EXECUTION_ONLY");
  assert.equal(ledger.sourcePinDisposition, "keep-stale");
  assert.deepEqual(ledger.unchangedReviewCounts, {
    uniqueUnits: 1340,
    unresolved: 263,
    mixedRequiresDecomposition: 124,
    ownerReviewed: 0,
  });
  assert.match(claim.rationale, /does not .*accept the containing historical task block/u);
});
