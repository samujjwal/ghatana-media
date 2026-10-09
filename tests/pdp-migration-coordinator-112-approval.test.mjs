import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const approvalPath = "docs/implementation/verification/pdp-38/migration-coordinator-review-112.json";
const approval = JSON.parse(readFileSync(resolve(root, approvalPath), "utf8"));
const migrationPath = ".product-experience/pdp-0-product-truth/migration-semantics-review.yaml";
const review = parse(readFileSync(resolve(root, migrationPath), "utf8"));
const ledger = review.pdp38ClaimReconciliation;
const sourceText = readFileSync(resolve(root, "docs/migration/expert-reviewed-master-plan.md"), "utf8");
const sourceLines = sourceText.split("\n");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const jsonSha = (value) => sha(JSON.stringify(value));
const proposalPaths = [
  "docs/implementation/verification/pdp-38/migration-goal-owner-review.json",
  "docs/implementation/verification/pdp-38/migration-domain-model-owner-review.json",
  "docs/implementation/verification/pdp-38/migration-glossary-owner-review.json",
  "docs/implementation/verification/pdp-38/migration-temporal-owner-review.json",
];
const proposalArtifacts = new Map(proposalPaths.map((path) => [path, {
  text: readFileSync(resolve(root, path), "utf8"),
  artifact: JSON.parse(readFileSync(resolve(root, path), "utf8")),
}]));
const parsedSourceCache = new Map();
const proposalById = new Map();
for (const [path, { artifact }] of proposalArtifacts) {
  for (const record of artifact.records) proposalById.set(record.claimId, { path, artifact, record });
}

function claimById(claimId) {
  for (const item of ledger.records) {
    for (const claim of item.claims ?? []) {
      for (const leaf of claim.subclaims ?? [claim]) if (leaf.claimId === claimId) return leaf;
    }
  }
}

function resolveRef(ref) {
  const marker = ref.indexOf("#");
  const path = ref.slice(0, marker);
  if (!parsedSourceCache.has(path)) parsedSourceCache.set(path, parse(readFileSync(resolve(root, path), "utf8")));
  let value = parsedSourceCache.get(path);
  for (const encoded of ref.slice(marker + 1).replace(/^\//u, "").split("/")) {
    if (!encoded) continue;
    const token = encoded.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (token.startsWith("@id=")) value = value.find((entry) => entry.id === token.slice(4));
    else if (Array.isArray(value)) value = value[Number(token)];
    else value = value[token];
    assert.notEqual(value, undefined, `resolves ${ref} at ${token}`);
  }
  return value;
}

test("PXD-090 approves the exact 112-row proposal set without rewriting proposal snapshots", () => {
  assert.equal(approval.decisionRef, ".product-experience/decision-log.md#PXD-090");
  assert.equal(approval.reviewedRecordCount, 112);
  assert.equal(approval.normativeRouteCount, 109);
  assert.equal(approval.metadataClassificationCount, 3);
  assert.equal(approval.acceptanceEffect.startsWith("none;"), true);
  assert.equal(approval.targetValueEncoding, "JSON.stringify for all normative target values; exact source claim UTF-8 bytes for metadata classifications");
  assert.equal(approval.records.length, 112);
  assert.equal(new Set(approval.records.map(({ claimId }) => claimId)).size, 112);
  assert.equal(proposalById.size, 112);

  for (const approved of approval.records) {
    const proposal = proposalById.get(approved.claimId);
    assert.ok(proposal, `${approved.claimId} is in the immutable proposal set`);
    const { path, artifact, record } = proposal;
    const proposalText = proposalArtifacts.get(path).text;
    assert.equal(approved.proposalArtifactRef, `${path}#/records/@claimId=${approved.claimId}`);
    assert.equal(approved.proposalArtifactSha256, sha(proposalText));
    assert.equal(approved.proposalRecordSha256, jsonSha(record));
    assert.equal(record.coordinatorReviewStatus, "PENDING", "proposal remains unchanged and pending as an immutable review input");
    assert.equal(approved.exactSourceText, record.exactSourceText);
    assert.equal(approved.sourceTextSha256, record.sourceTextSha256);
    assert.equal(approved.previousTargetRef, record.previousTargetRef);
    assert.equal(approved.previousTargetValueSha256, record.previousTargetValueSha256);
    const current = claimById(approved.claimId);
    assert.ok(current, `${approved.claimId} remains in the source ledger`);
    assert.equal(current.exactSourceText, record.exactSourceText);
    assert.equal(current.sourceTextSha256, record.sourceTextSha256);
    assert.equal(current.semanticReviewRef, `${approvalPath}#/records/@claimId=${approved.claimId}`);
    assert.equal(current.semanticReviewStatus, approved.semanticReviewStatus);
    assert.equal(current.coordinatorReviewStatus, approved.coordinatorReviewStatus);
    assert.equal(current.acceptanceEffect, "none");

    if (record.proposedTargetRef) {
      const target = resolveRef(record.proposedTargetRef);
      assert.equal(approved.currentTargetRef, record.proposedTargetRef);
      assert.equal(approved.proposedTargetRef, record.proposedTargetRef);
      assert.equal(approved.currentTargetValueSha256, jsonSha(target));
      assert.equal(approved.currentTargetValueSha256, record.proposedTargetValueSha256);
      assert.equal(approved.targetHashEncoding, "SHA-256(UTF-8(JSON.stringify(resolved YAML/JSON value)))");
      assert.equal(current.disposition, "ROUTED_TO_CURRENT_PDP_AUTHORITY");
      assert.equal(current.targetRef, approved.currentTargetRef);
      assert.equal(current.targetTextSha256, approved.currentTargetValueSha256);
      assert.equal(current.semanticReviewStatus, "CLAIM_SPECIFIC_SEMANTIC_PARITY_VERIFIED");
    } else {
      assert.equal(record.proposedDisposition, "NON_NORMATIVE_SOURCE_METADATA");
      assert.equal(approved.proposedDisposition, record.proposedDisposition);
      assert.equal(approved.currentTargetRef, record.sourceEvidenceRef);
      assert.equal(approved.currentTargetValue, record.exactSourceText);
      assert.equal(approved.currentTargetValueSha256, sha(record.exactSourceText));
      const lineNumber = Number(record.sourceEvidenceRef.match(/#L(\d+)$/u)?.[1]);
      const line = sourceLines[lineNumber - 1];
      assert.ok(line?.includes(record.exactSourceText), `${approved.claimId} is an exact source-row label`);
      assert.equal(approved.currentTargetLineSha256, sha(line));
      assert.equal(current.disposition, "NON_NORMATIVE_SOURCE_METADATA");
      assert.equal(current.sourceEvidenceRef, record.sourceEvidenceRef);
      assert.deepEqual(current.metadataFields, record.metadataFields);
      assert.equal(current.rationale, approved.rationale);
      assert.equal(current.targetRef, undefined);
      assert.equal(current.targetTextSha256, undefined);
      assert.equal(current.semanticReviewStatus, "CLAIM_SPECIFIC_NON_NORMATIVE_CLASSIFICATION_VERIFIED");
    }
  }
});

test("PXD-090 reconciliation counters are derived from the live 884-unit ledger", () => {
  const leaves = ledger.records.flatMap(({ claims }) => claims ?? []).flatMap((claim) => claim.subclaims ?? [claim]);
  const routed = leaves.filter(({ disposition }) => disposition === "ROUTED_TO_CURRENT_PDP_AUTHORITY");
  const verified = routed.filter(({ semanticReviewStatus }) => semanticReviewStatus === "CLAIM_SPECIFIC_SEMANTIC_PARITY_VERIFIED");
  const pending = routed.filter(({ semanticReviewStatus }) => semanticReviewStatus === "OWNER_TARGET_LOCATOR_ONLY_PENDING_CLAIM_PARITY");
  const metadata = leaves.filter(({ disposition }) => disposition === "NON_NORMATIVE_SOURCE_METADATA");
  const approvedIds = new Set(approval.records.map(({ claimId }) => claimId));
  const approvedNormative = verified.filter(({ claimId }) => approvedIds.has(claimId));
  const approvedMetadata = metadata.filter(({ claimId }) => approvedIds.has(claimId));
  assert.equal(leaves.length, ledger.currentClaimUnitCount);
  assert.equal(approvedNormative.length, approval.normativeRouteCount, "the bounded 109 approved normative rows remain exact even as later cohorts are integrated");
  assert.equal(approvedMetadata.length, approval.metadataClassificationCount, "the bounded 3 metadata classifications remain exact");
  assert.equal(routed.length, verified.length + pending.length);
  assert.equal(ledger.sourceOwnerRoutingCount, routed.length);
  assert.equal(ledger.currentOwnerTargetClaimUnitCount, routed.length);
  assert.equal(ledger.semanticParityVerifiedClaimUnitCount, verified.length);
  assert.equal(ledger.candidateTargetPendingSemanticParityCount, pending.length);
  assert.equal(ledger.nonNormativeSourceMetadataClaimUnitCount, metadata.length);
});

test("the goal-rule addition is isolated and does not rewrite prior goal measures", () => {
  const impactPath = "docs/implementation/verification/pdp-38/migration-goals-owner-source-impact.json";
  const impact = JSON.parse(readFileSync(resolve(root, impactPath), "utf8"));
  const currentText = readFileSync(resolve(root, impact.sourcePath), "utf8");
  const current = parse(currentText);
  const withoutRules = structuredClone(current);
  delete withoutRules.ownerDefinedMigrationRules;
  assert.equal(impact.decisionRef, approval.decisionRef);
  assert.equal(impact.changedScalarPaths.length, 1);
  assert.equal(impact.changedScalarPaths[0], "#/ownerDefinedMigrationRules");
  assert.equal(impact.currentFileSha256, sha(currentText));
  assert.equal(impact.currentOwnerDefinedMigrationRulesSha256, jsonSha(current.ownerDefinedMigrationRules));
  assert.equal(impact.currentParsedTreeWithoutOwnerRulesSha256, jsonSha(withoutRules));
  assert.equal(impact.currentParsedTreeWithoutOwnerRulesSha256, impact.priorCommittedParsedTreeSha256);
  const priorText = execFileSync("git", ["show", `${impact.priorSourceCommit}:${impact.sourcePath}`], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.equal(sha(priorText), impact.priorSourceFileSha256);
  assert.deepEqual(withoutRules, parse(priorText));
  assert.equal(impact.existingSuccessMeasuresPreservedSha256, jsonSha(current.successMeasureContracts));
  assert.deepEqual(current.successMeasureContracts, parse(priorText).successMeasureContracts);
});
