import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const root = process.cwd();
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));

test("new master-plan taxonomy and PDP-1 crosswalk claims are exact, routed, and non-accepting", () => {
  const review = readYaml(".product-experience/pdp-0-product-truth/migration-semantics-review.yaml");
  const ledger = review.sourceChangeLedger;
  const source = readFileSync(resolve(root, ledger.observedCurrentSource.path), "utf8").split("\n");
  const authorityMap = readYaml(".product-experience/authority-map.yaml");
  const claims = ledger.newSourceClaims;
  const expected = new Map([
    ["MSC-01", ["MSC-01-NEW-C01", "MSC-01-NEW-C02", "MSC-01-NEW-C03", "MSC-01-NEW-C04", "MSC-01-NEW-C05", "MSC-01-NEW-C06", "MSC-01-NEW-C07"]],
    ["MSC-09", ["MSC-09-NEW-C01", "MSC-09-NEW-C02", "MSC-09-NEW-C03", "MSC-09-NEW-C04"]],
  ]);

  assert.equal(ledger.historicalSource.commit, "e62514f94c45a4ecbc438d26298bf82b6a6f3d69");
  assert.equal(ledger.sourcePinDisposition, "keep-stale");
  assert.deepEqual(ledger.reviewCountsAfterOwnerDispositions, {
    uniqueUnits: 1340,
    unresolved: 260,
    mixedRequiresDecomposition: 124,
    ownerReviewed: 3,
  });
  assert.deepEqual(claims.map(({ claimId }) => claimId), [...expected.values()].flat());
  assert.equal(new Set(claims.map(({ claimId }) => claimId)).size, claims.length);

  for (const [clusterId, claimIds] of expected) {
    const clusterClaims = claims.filter((claim) => claim.clusterId === clusterId);
    assert.deepEqual(clusterClaims.map(({ claimId }) => claimId), claimIds);
    for (const claim of clusterClaims) {
      const [start, end] = claim.currentSourceLines;
      assert.equal(start, end, `${claim.claimId} is tied to one exact source line`);
      assert.ok(source[start - 1].includes(claim.exactClaim), `${claim.claimId} exact claim occurs at current line ${start}`);
      assert.equal(claim.acceptanceEffect, "none");
      assert.ok(claim.disposition && claim.basis);
      for (const ref of claim.candidatePdpRefs) {
        const [path, pointer = ""] = ref.split("#");
        assert.ok(readFileSync(resolve(root, path), "utf8"), `${claim.claimId} target exists: ${path}`);
        if (path === ".product-experience/authority-map.yaml" && pointer.startsWith("/phaseAuthorities/")) {
          const index = Number(pointer.split("/").at(-1));
          assert.ok(authorityMap.phaseAuthorities[index], `${claim.claimId} targets a present phase authority`);
        }
      }
    }
  }

  assert.deepEqual(authorityMap.phaseAuthorities.slice(0, 4).map(({ phase }) => phase), ["PDP-0", "PDP-1", "PDP-2", "PDP-3"]);
  assert.equal(authorityMap.phaseAuthorities[0].acceptance, "P0-001-boundary-slice-only");
  assert.match(authorityMap.phaseAuthorities[1].acceptance, /pending/u, "PDP-1 routing evidence does not imply owner acceptance");
  assert.equal(ledger.clusters.find(({ id }) => id === "MSC-01").unmappedStatus, "new-claim-no-historical-MPSEM-item");
  assert.equal(ledger.clusters.find(({ id }) => id === "MSC-09").unmappedStatus, "new-section-and-routing-claims-without-historical-items");
  assert.match(ledger.reconciliationStatus, /partial/u);
});

test("migration taxonomy arbitration keeps execution-only items and unresolved hunk deltas classified without acceptance", () => {
  const review = readYaml(".product-experience/pdp-0-product-truth/migration-semantics-review.yaml");
  const items = new Map(review.items.map((item) => [item.itemId, item]));
  const hunks = new Map(review.sourceChangeLedger.diffHunkCoverage.records.map((record) => [record.hunkId, record]));
  const sourceDeltas = readYaml("docs/migration/master-plan-source-change-claims.yaml");
  const sourceHunks = new Map(sourceDeltas.hunkReconciliation.records.map((record) => [record.hunkId, record]));
  const nfrs = readYaml(".product-experience/pdp-0-product-truth/nonfunctional-requirements.yaml").requirements;
  const currentPlan = readFileSync(resolve(root, "docs/migration/expert-reviewed-master-plan.md"), "utf8").split("\n");

  assert.equal(items.get("MPSEM-0499").classification, "EXECUTION_ONLY");
  assert.equal(items.get("MPSEM-0389").classification, "EXECUTION_ONLY");
  assert.equal(items.get("MPSEM-0390").classification, "IMPLEMENTATION_GUIDANCE", "the table header is not a product requirement");
  assert.equal(items.get("MPSEM-0400").classification, "IMPLEMENTATION_GUIDANCE", "the profile-benchmark paragraph remains guidance");
  const exactTargetRows = [
    ["MPSEM-0391", "NFR-PERF-001", 0],
    ["MPSEM-0392", "NFR-PERF-001", 1],
    ["MPSEM-0393", "NFR-PERF-001", 2],
    ["MPSEM-0394", "NFR-PERF-001", 3],
    ["MPSEM-0395", "NFR-PERF-001", 4],
    ["MPSEM-0396", "NFR-PERF-001", 5],
    ["MPSEM-0397", "NFR-COST-001", null],
    ["MPSEM-0398", "NFR-TIME-001", null],
  ];
  for (const [itemId, recordId, budgetIndex] of exactTargetRows) {
    const item = items.get(itemId);
    assert.equal(item.classification, "EXTRACTED_TO_PDP", `${itemId} has an exact NFR target mapping`);
    const target = item.exactPdpRefs.find(({ recordId: id }) => id === recordId);
    assert.ok(target, `${itemId} names ${recordId}`);
    const requirement = nfrs.find(({ id }) => id === recordId);
    assert.ok(requirement, `${recordId} exists in canonical NFRs`);
    if (budgetIndex !== null) {
      assert.match(target.artifactRef, new RegExp(`/initialProposedBudgets/${budgetIndex}$`, "u"));
      assert.equal(requirement.initialProposedBudgets[budgetIndex].environment, "not-yet-named");
      assert.match(requirement.acceptance, /proposals-until/u);
    } else {
      assert.match(target.artifactRef, new RegExp(`#/requirements/\\d+$`, "u"));
    }
    assert.equal(item.sectionProvenanceRefs[0].artifactRef, ".product-experience/pdp-0-product-truth/nonfunctional-requirements.yaml");
  }
  const availability = items.get("MPSEM-0399");
  assert.equal(availability.blockStructureProposal.classification, "MIXED_REQUIRES_DECOMPOSITION");
  assert.equal(availability.blockStructureProposal.status, "PROPOSAL_ONLY");
  const availabilityClaims = review.claimDecompositions.filter(({ itemId }) => itemId === "MPSEM-0399");
  assert.deepEqual(availabilityClaims.map(({ claimId }) => claimId), ["MPSEM-0399-C01", "MPSEM-0399-C02"]);
  assert.deepEqual(availabilityClaims.map(({ mappingStatus }) => mappingStatus), [
    "TARGET_RECORD_CROSSWALKED_PENDING_QUALIFICATION",
    "TARGET_RECORD_CROSSWALKED_PENDING_RECOVERY_EVIDENCE",
  ]);
  for (const claim of availabilityClaims) {
    assert.deepEqual(claim.currentSourceLines, [903, 903]);
    assert.ok(currentPlan[902].includes(claim.exactClaim), `${claim.claimId} is exact at current plan line 903`);
    assert.equal(claim.reviewStatus, "BOUNDED_SOURCE_REVIEWED");
  }
  assert.ok(availabilityClaims.every(({ acceptanceEffect }) => acceptanceEffect === "none"));
  assert.ok(availabilityClaims.every(({ candidatePdpRefs }) => candidatePdpRefs.length));
  assert.equal(review.counts.uniqueUnitsByClassification.UNRESOLVED, 260);
  assert.equal(review.counts.uniqueUnitsByClassification.IMPLEMENTATION_GUIDANCE, 66);
  assert.equal(review.counts.uniqueUnitsByClassification.EXECUTION_ONLY, 786);
  assert.equal(review.counts.uniqueUnitsByClassification.EVIDENCE_REFERENCE, 163);
  assert.equal(review.counts.uniqueUnitsByClassification.EXTRACTED_TO_PDP, 65);
  assert.equal(review.counts.blockStructureProposalCounts.MIXED_REQUIRES_DECOMPOSITION, 124);
  assert.equal(review.sourceChangeLedger.reviewCountsAfterOwnerDispositions.mixedRequiresDecomposition, 124);
  assert.equal(review.sourceChangeLedger.reviewCountsAfterOwnerDispositions.unresolved, 260);
  assert.equal(review.ownerDecisionOverlay.resolvedBlockCount, 0);
  assert.equal(review.counts.uniqueContentUnits, 1340);

  assert.equal(hunks.get("MSD-003").coverageKind, "mixed-source-change");
  assert.match(hunks.get("MSD-003").disposition, /unresolved/u);
  assert.deepEqual(hunks.get("MSD-003").unresolvedDeltaRefs, ["MSD-003-HDELTA-01"]);
  assert.deepEqual(hunks.get("MSD-003").claimRefs, ["MSC-02-MSD-003-L0024-C02", "MSC-02-MSD-003-L0024-C03"]);
  assert.equal(hunks.get("MSD-003").acceptanceEffect, "none");
  assert.equal(hunks.get("MSD-017").coverageKind, "taxonomy-or-owner-routing");
  assert.match(hunks.get("MSD-017").disposition, /proposed and unqualified/u);
  assert.equal(hunks.get("MSD-017").acceptanceEffect, "none");

  const delta = sourceHunks.get("MSD-003").unresolvedHistoricalDeltas.find(({ deltaId }) => deltaId === "MSD-003-HDELTA-01");
  assert.equal(delta.exactHistoricalDelta, "fixtures, adapters, and verification");
  assert.equal(delta.reviewStatus, "UNRESOLVED_SOURCE_DELTA");
  assert.equal(delta.acceptanceEffect, "none");
  assert.equal(sourceHunks.get("MSD-003").acceptanceEffect, "none");
});

test("every master-plan diff hunk is claim-linked or retained as an exact unresolved fragment", () => {
  const review = readYaml(".product-experience/pdp-0-product-truth/migration-semantics-review.yaml");
  const ledger = review.sourceChangeLedger;
  const changeClaims = readYaml("docs/migration/master-plan-source-change-claims.yaml");
  const currentSourceLines = readFileSync(resolve(root, ledger.observedCurrentSource.path), "utf8").split("\n");
  const diff = execFileSync("git", ["diff", "--no-ext-diff", "--unified=0", ledger.historicalSource.commit, "--", ledger.historicalSource.path], {
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
    } else if (hunk && line.startsWith("-") && !line.startsWith("---")) hunk.historical.push(line.slice(1));
    else if (hunk && line.startsWith("+") && !line.startsWith("+++")) hunk.current.push(line.slice(1));
  }
  if (hunk) actual.push(hunk);

  assert.equal(changeClaims.sourcePin.commit, ledger.historicalSource.commit);
  assert.equal(changeClaims.sourcePin.sha256, ledger.historicalSource.sha256);
  assert.equal(changeClaims.observedCurrentSource.sha256, ledger.observedCurrentSource.sha256);
  assert.equal(changeClaims.claimDecompositions.length, 129);
  assert.equal(changeClaims.hunkReconciliation.records.length, actual.length);
  assert.equal(actual.length, ledger.diffHunkCoverage.records.length);
  const claimById = new Map(changeClaims.claimDecompositions.map((claim) => [claim.claimId, claim]));
  const newSourceClaimById = new Map(ledger.newSourceClaims.map((claim) => [claim.claimId, claim]));
  const reconciledClaimById = new Map(review.migrationClaimReconciliations.claims.map((claim) => [claim.claimId, claim]));
  const historicalClaimById = new Map(review.claimDecompositions.map((claim) => [claim.claimId, claim]));
  const decomposedClusters = new Set();
  for (const claim of changeClaims.claimDecompositions) {
    const [start, end] = claim.currentSourceLines;
    assert.equal(start, end, `${claim.claimId} has an exact single-line source boundary`);
    assert.ok(currentSourceLines[start - 1].includes(claim.exactClaim), `${claim.claimId} matches current source line ${start}`);
    assert.equal(claim.disposition, "SEMANTIC_EQUIVALENCE_UNRESOLVED");
    assert.equal(claim.acceptanceEffect, "none");
    decomposedClusters.add(claim.clusterId);
  }
  const expectedDecomposedClusterIds = ["MSC-01", "MSC-02", "MSC-03", "MSC-05", "MSC-07", "MSC-08", "MSC-09", "MSC-10", "MSC-12", "MSC-13", "MSC-14"];
  assert.deepEqual([...decomposedClusters].sort(), expectedDecomposedClusterIds.filter((id) => id !== "MSC-01" && id !== "MSC-09").sort());
  const clusters = new Map(ledger.clusters.map((cluster) => [cluster.id, cluster]));
  const expectedClaimCounts = { "MSC-01": 7, "MSC-02": 2, "MSC-03": 14, "MSC-05": 6, "MSC-07": 6, "MSC-08": 3, "MSC-09": 4, "MSC-10": 15, "MSC-12": 68, "MSC-13": 10, "MSC-14": 5 };
  for (const clusterId of expectedDecomposedClusterIds) {
    const cluster = clusters.get(clusterId);
    assert.equal(cluster.claimDecompositionStatus, "exact-claims-recorded", `${clusterId} disposition reflects completed decomposition`);
    assert.equal(cluster.semanticReconciliationStatus, "unresolved", `${clusterId} remains semantically unresolved`);
    assert.ok(cluster.claimEvidenceRef);
    assert.equal(cluster.decomposedClaimCount, expectedClaimCounts[clusterId]);
  }
  assert.equal(Object.values(expectedClaimCounts).reduce((sum, count) => sum + count, 0), 140);
  const allReferencedClaims = new Set(changeClaims.hunkReconciliation.records.flatMap((record) => record.claimRefs));
  for (const claim of changeClaims.claimDecompositions) {
    assert.ok(allReferencedClaims.has(claim.claimId), `${claim.claimId} is linked from at least one hunk`);
  }
  for (const [index, record] of changeClaims.hunkReconciliation.records.entries()) {
    const observed = actual[index];
    assert.equal(record.hunkId, `MSD-${String(index + 1).padStart(3, "0")}`);
    assert.equal(record.clusterId, ledger.diffHunkCoverage.records[index].clusterId);
    assert.deepEqual(record.historicalLines, observed.historicalLines);
    assert.deepEqual(record.currentLines, observed.currentLines);
    assert.deepEqual(record.exactHistoricalChangedText, observed.historical);
    assert.deepEqual(record.exactCurrentChangedText, observed.current);
    assert.equal(record.historicalChangedTextSha256, createHash("sha256").update(observed.historical.join("\n")).digest("hex"));
    assert.equal(record.currentChangedTextSha256, createHash("sha256").update(observed.current.join("\n")).digest("hex"));
    assert.equal(record.acceptanceEffect, "none");
    if (record.claimRefs.length) {
      assert.equal(record.fragmentDisposition, "claim-linked; additional changed text retained verbatim");
      for (const claimId of record.claimRefs) {
        const claim = claimById.get(claimId) ?? newSourceClaimById.get(claimId) ?? reconciledClaimById.get(claimId) ?? historicalClaimById.get(claimId);
        assert.ok(claim, `${record.hunkId} references an existing exact claim`);
        assert.equal(claim.clusterId, record.clusterId);
        const sourceLines = claim.currentSourceLines ?? claim.masterPlanLines;
        assert.ok(sourceLines[0] >= record.currentLines[0] && sourceLines[0] <= record.currentLines[1]);
        assert.ok(observed.current.some((line) => line.includes(claim.exactClaim)), `${record.hunkId} changed text contains ${claimId}`);
      }
    } else {
      assert.equal(record.fragmentDisposition, "explicit-unresolved-fragment");
      assert.ok(record.unresolvedReason.length);
    }
  }
  const referencedClaims = new Set(changeClaims.hunkReconciliation.records.flatMap((record) => record.claimRefs));
  for (const claim of changeClaims.claimDecompositions) assert.ok(referencedClaims.has(claim.claimId), `${claim.claimId} is linked from a changed hunk`);
  const byHunk = new Map(changeClaims.hunkReconciliation.records.map((record) => [record.hunkId, record]));
  const executionDelta = byHunk.get("MSD-003").unresolvedHistoricalDeltas?.find(({ deltaId }) => deltaId === "MSD-003-HDELTA-01");
  assert.ok(executionDelta, "MSD-003 tracks the removed historical fixture/adapter/verification responsibility");
  assert.equal(executionDelta.exactHistoricalDelta, "fixtures, adapters, and verification");
  assert.ok(byHunk.get("MSD-003").exactHistoricalChangedText.some((line) => line.includes(executionDelta.exactHistoricalDelta)));
  assert.deepEqual(executionDelta.historicalSourceLines, [22, 22]);
  assert.deepEqual(executionDelta.currentSourceLines, [24, 24]);
  assert.equal(executionDelta.reviewStatus, "UNRESOLVED_SOURCE_DELTA");
  assert.match(executionDelta.missingEvidence, /owner-reviewed mapping/u);
  assert.equal(executionDelta.acceptanceEffect, "none");
  assert.equal(byHunk.get("MSD-003").acceptanceEffect, "none");
  assert.equal(byHunk.get("MSD-009").clusterId, "MSC-03");
  assert.deepEqual(byHunk.get("MSD-009").claimRefs.filter((id) => id.startsWith("MSC-03-C0")).sort(), ["MSC-03-C01", "MSC-03-C02", "MSC-03-C03", "MSC-03-C04", "MSC-03-C05"]);
  assert.equal(byHunk.get("MSD-022").clusterId, "MSC-08");
  assert.deepEqual(byHunk.get("MSD-022").relatedHistoricalClaimRefs, ["MPSEM-0499-C01", "MPSEM-0499-C02", "MPSEM-0499-C03", "MPSEM-0499-C04", "MPSEM-0499-C05", "MPSEM-0499-C06"]);
  assert.ok(byHunk.get("MSD-022").relatedHistoricalClaimRefs.every((id) => historicalClaimById.has(id)));
  assert.deepEqual(byHunk.get("MSD-024").relatedHistoricalClaimRefs, byHunk.get("MSD-022").relatedHistoricalClaimRefs);
  for (const id of ["MSD-026", "MSD-032", "MSD-036"]) assert.ok(byHunk.get(id).claimRefs.length, `${id} has a source claim or explicit claim cross-reference`);
  assert.equal(byHunk.get("MSD-024").clusterId, "MSC-08");
  assert.equal(byHunk.get("MSD-110").clusterId, "MSC-10");
  assert.ok(!changeClaims.claimDecompositions.some((claim) => claim.clusterId === "MSC-14" && [2652, 2653].includes(claim.currentSourceLines[0])), "unchanged Appendix A context is not represented as a changed claim");
  const executionClaims = changeClaims.claimDecompositions.filter((claim) => claim.clusterId === "MSC-02");
  assert.ok(executionClaims.some((claim) => claim.exactClaim === "`DEFINE_PRODUCT` authors PDP-0–PDP-3 authorities"));
  assert.ok(executionClaims.some((claim) => claim.exactClaim === "builds the Experience Explorer as their deterministic projection."));
  const phaseAuthorityClaim = executionClaims.find(({ claimId }) => claimId === "MSC-02-MSD-003-L0024-C02");
  const authorityMap = readYaml(".product-experience/authority-map.yaml");
  assert.deepEqual(phaseAuthorityClaim.boundedSourceEvidence.corroboratedValue,
    authorityMap.canonicalPdpPhases.map(({ id }) => id).filter((id) => id.startsWith("PDP-")));
  assert.equal(phaseAuthorityClaim.boundedSourceEvidence.status, "EXACT_AUTHORITY_IDENTIFIERS_CORROBORATED");
  assert.equal(phaseAuthorityClaim.boundedSourceEvidence.acceptanceEffect, "none");
  assert.match(phaseAuthorityClaim.boundedSourceEvidence.evidenceBoundary, /does not establish what DEFINE_PRODUCT authors/u);
  assert.equal(phaseAuthorityClaim.disposition, "SEMANTIC_EQUIVALENCE_UNRESOLVED");
  assert.notEqual(executionClaims.find((claim) => claim.exactClaim.startsWith("`DEFINE_PRODUCT` authors"))?.claimId,
    executionClaims.find((claim) => claim.exactClaim.startsWith("builds the Experience Explorer"))?.claimId);
  assert.equal(ledger.sourcePinDisposition, "keep-stale");
  assert.deepEqual(ledger.reviewCountsAfterOwnerDispositions, { uniqueUnits: 1340, unresolved: 260, mixedRequiresDecomposition: 124, ownerReviewed: 3 });
});
