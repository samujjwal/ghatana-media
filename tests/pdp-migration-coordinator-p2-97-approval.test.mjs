import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { resolvePdp3BindingSourceRef } from "./helpers/pdp-migration-source-selector.mjs";

const root = process.cwd();
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const approvalPath = "docs/implementation/verification/pdp-38/migration-coordinator-p2-review-97.json";
const approvalText = readFileSync(resolve(root, approvalPath), "utf8");
const approval = JSON.parse(approvalText);
const candidateText = readFileSync(resolve(root, approval.proposalArtifactRef), "utf8");
const candidate = JSON.parse(candidateText);
const ledgerPath = ".product-experience/pdp-0-product-truth/migration-semantics-review.yaml";
const ledger = parse(readFileSync(resolve(root, ledgerPath), "utf8")).pdp38ClaimReconciliation;
const partition = JSON.parse(readFileSync(resolve(root, approval.sourcePartitionRef), "utf8"));
const historicalText = readFileSync(resolve(root, "docs/migration/expert-reviewed-master-plan.md"), "utf8");
const historicalLines = historicalText.split("\n");
const decisionLog = readFileSync(resolve(root, ".product-experience/decision-log.md"), "utf8");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const jsonSha = (value) => sha(JSON.stringify(value));
const leaves = ledger.records.flatMap(({ claims }) => claims ?? []).flatMap((claim) => claim.subclaims ?? [claim]);
const leafById = new Map(leaves.map((claim) => [claim.claimId, claim]));
const parsedSources = new Map();
const sourceDocs = {};

function resolveRef(ref) {
  if (ref.includes("#line=")) {
    const [, lineText] = ref.match(/#line=(\d+)$/u) ?? [];
    const line = Number(lineText);
    const value = historicalLines[line - 1];
    assert.ok(value, `historical line exists: ${ref}`);
    return value;
  }
  const source = ref.slice(0, ref.indexOf("#"));
  if (!parsedSources.has(source)) {
    sourceDocs[source] = parse(readFileSync(resolve(root, source), "utf8"));
    parsedSources.set(source, sourceDocs[source]);
  }
  return resolvePdp3BindingSourceRef(ref, sourceDocs);
}

test("PXD-100 approves the exact immutable 97-claim PDP-2 candidate cohort", () => {
  assert.equal(approval.decisionRef, ".product-experience/decision-log.md#PXD-100");
  assert.match(decisionLog, /^### PXD-100 — Accept the complete 97-claim design migration partition$/mu);
  assert.equal(approval.reviewedRecordCount, 97);
  assert.equal(approval.records.length, 97);
  assert.equal(new Set(approval.records.map(({ claimId }) => claimId)).size, 97);
  assert.equal(sha(candidateText), approval.proposalArtifactSha256);
  assert.equal(candidate.cohort.pendingLeafClaims, 97);
  assert.equal(candidate.cohort.approvalStatus, "PENDING_COORDINATOR_MATERIAL_REVIEW", "proposal remains an immutable historical input");
  assert.equal(candidate.cohort.acceptanceEffect, "none");
  assert.equal(candidate.cohort.independentAcceptance, "NOT_CLAIMED");
  assert.equal(candidate.cohort.runtimeAdmission, "NOT_CLAIMED");
  assert.equal(candidate.records.length, 97);
  assert.equal(partition.records.filter(({ sourceOwnerPhase }) => sourceOwnerPhase === "PDP-2").length, 97);
  assert.equal(sha(readFileSync(resolve(root, approval.sourcePartitionRef))), approval.sourcePartitionSha256);

  for (const approved of approval.records) {
    const proposed = candidate.records.find(({ claimId }) => claimId === approved.claimId);
    assert.ok(proposed, `${approved.claimId} remains in the exact proposal cohort`);
    const current = leafById.get(approved.claimId);
    assert.ok(current, `${approved.claimId} remains in the ledger`);
    assert.equal(jsonSha(proposed), approved.proposalRecordSha256, `${approved.claimId}: proposal record is unchanged`);
    assert.equal(proposed.acceptanceEffect, "none");
    assert.equal(proposed.exactSourceText, approved.exactSourceText);
    assert.equal(sha(proposed.exactSourceText), approved.sourceTextSha256);
    assert.equal(current.exactSourceText, approved.exactSourceText);
    assert.equal(current.sourceTextSha256, approved.sourceTextSha256);
    assert.equal(proposed.previousTargetRef, approved.previousTargetRef);
    assert.deepEqual(proposed.exactMaterialClauses, approved.exactMaterialClauses);
    assert.equal(current.semanticReviewRef, `${approvalPath}#/records/@claimId=${approved.claimId}`);
    assert.equal(current.coordinatorReviewStatus, "APPROVED_BOUNDED_OWNER_SOURCE_SEMANTIC_ROUTE");
    assert.equal(current.semanticReviewStatus, "CLAIM_SPECIFIC_SEMANTIC_PARITY_VERIFIED");
    assert.equal(current.acceptanceEffect, "none");
    assert.equal(current.targetRef, approved.currentTargetRef);
    assert.equal(current.targetTextSha256, approved.currentTargetValueSha256);
    assert.equal(proposed.previousTargetRef, approved.previousTargetRef);

    if (approved.scope === "HISTORICAL_EXTERNAL_SOURCE_FACT_ONLY") {
      assert.equal(approved.claimId, "MPSEM-0458-C001");
      assert.equal(proposed.semanticDisposition, "HISTORICAL_EXTERNAL_LICENSE_FACT_PRESERVED_PENDING_COORDINATOR_REVIEW");
      assert.equal(approved.currentTargetRef, "docs/migration/expert-reviewed-master-plan.md#line=1045");
      assert.equal(proposed.proposedTargetRef, approved.currentTargetRef);
      assert.equal(approved.currentTargetValueSha256, sha(historicalLines[1044]));
      assert.ok(historicalLines[1044].includes("OpenVDB’s official license page identifies MPL-2.0"));
      assert.equal(approval.externalSourceObservation.claimId, approved.claimId);
      assert.match(approval.externalSourceObservation.scope, /preserved historical source fact only/iu);
      assert.match(current.rationale, /historical external license statement is preserved and checked against the official source only/iu);
      assert.equal(current.disposition, "ROUTED_TO_CURRENT_PDP_AUTHORITY");
    } else {
      assert.equal(approved.scope, "BOUNDED_OWNER_DEFINITION_CLAUSE");
      assert.equal(proposed.semanticDisposition, "DEFINITION_ROUTE_CANDIDATE_PENDING_COORDINATOR_MATERIAL_REVIEW");
      assert.equal(proposed.proposedTargetRef, approved.currentTargetRef);
      assert.equal(proposed.targetValueSha256, approved.currentTargetValueSha256);
      assert.equal(approved.currentTargetValueSha256, jsonSha(resolveRef(approved.currentTargetRef)));
      assert.equal(current.disposition, "ROUTED_TO_CURRENT_PDP_AUTHORITY");
    }
  }
});

test("PXD-100 counters are derived from all current ledger leaves", () => {
  const routed = leaves.filter(({ disposition }) => disposition === "ROUTED_TO_CURRENT_PDP_AUTHORITY");
  const verified = routed.filter(({ semanticReviewStatus }) => semanticReviewStatus === "CLAIM_SPECIFIC_SEMANTIC_PARITY_VERIFIED");
  const pending = routed.filter(({ semanticReviewStatus }) => semanticReviewStatus === "OWNER_TARGET_LOCATOR_ONLY_PENDING_CLAIM_PARITY");
  const metadata = leaves.filter(({ disposition }) => disposition === "NON_NORMATIVE_SOURCE_METADATA");
  const approvedIds = new Set(approval.records.map(({ claimId }) => claimId));
  assert.equal(verified.filter(({ claimId }) => approvedIds.has(claimId)).length, 97);
  assert.equal(verified.length, ledger.semanticParityVerifiedClaimUnitCount);
  assert.equal(pending.length, ledger.candidateTargetPendingSemanticParityCount);
  assert.equal(leaves.length, ledger.currentClaimUnitCount);
  assert.equal(routed.length, ledger.sourceOwnerRoutingCount);
  assert.equal(routed.length, ledger.currentOwnerTargetClaimUnitCount);
  assert.equal(metadata.length, ledger.nonNormativeSourceMetadataClaimUnitCount);
  assert.equal(ledger.semanticParityVerifiedClaimUnitCount + ledger.candidateTargetPendingSemanticParityCount, routed.length);
});
