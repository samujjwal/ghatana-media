import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const readText = (path) => readFileSync(resolve(root, path), "utf8");
const readYaml = (path) => parse(readText(path));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const ledgerPath = ".product-experience/pdp-0-product-truth/migration-semantics-review.yaml";
const reviewPath = "docs/implementation/verification/pdp-38/migration-profile-handoff-source-review.json";
const sourceImpactPath = "docs/implementation/verification/pdp-38/migration-reviewed-source-impact.json";
const frozenSourceDeltasPath = "docs/implementation/verification/pdp-38/migration-frozen-source-deltas.json";
const handoffImpactPath = "docs/implementation/verification/pdp-38/migration-handoff-owner-source-impact.json";
const domainImpactPath = "docs/implementation/verification/pdp-38/migration-domain-model-owner-source-impact.json";
const ledger = readYaml(ledgerPath).pdp38ClaimReconciliation;
const review = JSON.parse(readText(reviewPath));
const frozenDeltas = JSON.parse(readText(frozenSourceDeltasPath));
const claims = ledger.records.flatMap((record) => record.claims ?? []).flatMap((claim) => claim.subclaims ?? [claim]);
const claimById = new Map(claims.map((claim) => [claim.claimId, claim]));

function resolveRef(ref) {
  const [source, pointer] = ref.split("#", 2);
  let value = readYaml(source);
  for (const raw of pointer.split("/").filter(Boolean)) {
    const part = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (part.startsWith("@id=")) value = value.find((entry) => entry.id === part.slice(4));
    else if (/^\d+$/u.test(part)) value = value[Number(part)];
    else value = value?.[part];
    assert.notEqual(value, undefined, `source selector resolves: ${ref}`);
  }
  return value;
}

function targetDigest(value) {
  return sha(typeof value === "string" ? value : JSON.stringify(value));
}

test("PXD-086 verifies exactly 57 bounded profile/handoff claims and one source-metadata row", () => {
  assert.equal(review.decisionRef, ".product-experience/decision-log.md#PXD-086");
  assert.equal(review.records.length, 57);
  assert.equal(review.recordCount, 57);
  assert.equal(review.acceptanceEffect, "none");
  for (const [path, expectedDigest] of Object.entries(review.sourceFingerprints)) {
    const impactPath = path === ".product-experience/pdp-0-product-truth/handoff-contracts.yaml"
      ? handoffImpactPath
      : path === ".product-experience/pdp-0-product-truth/domain-model.yaml" ? domainImpactPath : null;
    if (!impactPath) {
      if (path === ".product-experience/pdp-2-design-interface-system/cli-language.yaml") {
        const impact = frozenDeltas.records.find((record) => record.sourcePath === path);
        assert.ok(impact, "current CLI additive source delta is separately documented");
        const frozenText = execFileSync("git", ["show", `${frozenDeltas.priorSourceCommit}:${path}`], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
        assert.equal(sha(frozenText), expectedDigest, "PXD-086 historical CLI fingerprint remains unchanged");
        assert.equal(sha(frozenText), impact.historicalSourceFileSha256);
        const currentText = readText(path);
        assert.equal(sha(currentText), impact.currentSourceFileSha256);
        const current = parse(currentText);
        for (const addedKey of ["ownerDefinedInvocationRules", "normativeRuleRecords", "ownerDefinedMachineOutputRules"]) {
          assert.ok(Object.hasOwn(current, addedKey), `the current CLI definition adds ${addedKey}`);
          assert.ok(!Object.hasOwn(parse(frozenText), addedKey), `the frozen PXD-086 source predates ${addedKey}`);
        }
        const currentProjection = structuredClone(current);
        for (const key of ["ownerDefinedInvocationRules", "normativeRuleRecords", "ownerDefinedMachineOutputRules"]) delete currentProjection[key];
        assert.equal(sha(JSON.stringify(currentProjection)), impact.removedAddedPathsProjectionSha256);
        assert.deepEqual(currentProjection, parse(frozenText), "removing only the three reviewed additive collections reproduces the PXD-086 parsed source");

        const currentReview = JSON.parse(readText("docs/implementation/verification/pdp-38/migration-coordinator-p2-review-97.json"));
        const cliRecords = currentReview.records.filter((record) => record.currentTargetRef?.startsWith(`${path}#`));
        assert.ok(cliRecords.length > 0, "current CLI rules have exact PXD-100 reviewed targets");
        for (const record of cliRecords) {
          assert.equal(record.reviewStatus, "APPROVED_BOUNDED_SOURCE_SEMANTIC_ROUTE", record.claimId);
          assert.equal(targetDigest(resolveRef(record.currentTargetRef)), record.currentTargetValueSha256, `${record.claimId} current CLI target matches its bounded review`);
          assert.equal(record.acceptanceEffect, "none");
        }
      } else {
        assert.equal(sha(readText(path)), expectedDigest, `${path} remains at the bounded reviewed source cut`);
      }
      continue;
    }
    const impact = JSON.parse(readText(impactPath));
    const currentText = readText(path);
    const priorText = execFileSync("git", ["show", `${impact.priorSourceCommit}:${path}`], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    assert.equal(impact.priorSourceFileSha256, expectedDigest, "PXD-086 historical file pin is preserved exactly");
    assert.equal(sha(priorText), expectedDigest);
    assert.equal(sha(currentText), impact.currentSourceFileSha256);
    const prior = parse(priorText);
    const current = parse(currentText);
    const projected = structuredClone(current);
    if (path === ".product-experience/pdp-0-product-truth/handoff-contracts.yaml") {
      delete projected.handoffs.find(({ id }) => id === "ai-inference-execution").boundedWorkerExceptionRule;
      assert.equal(impact.changedScalarPaths[0], "#/handoffs/@id=ai-inference-execution/boundedWorkerExceptionRule");
      assert.equal(sha(JSON.stringify(resolveRef(impact.currentChangedValueRef))), impact.currentChangedValueSha256);
    } else {
      delete projected.ownerDefinedMigrationRules;
      assert.equal(impact.changedScalarPaths[0], "#/ownerDefinedMigrationRules");
      assert.equal(sha(JSON.stringify(current.ownerDefinedMigrationRules)), impact.currentChangedValueSha256);
    }
    assert.deepEqual(projected, prior, `only the separately reviewed additive owner rule changed in ${path}`);
    assert.equal(impact.priorParsedTreeSha256, impact.currentParsedTreeWithoutAddedRuleSha256 ?? impact.currentParsedTreeWithoutAddedRulesSha256);
  }
  assert.deepEqual([...new Set(review.records.map(({ claimId }) => claimId))].sort(), review.records.map(({ claimId }) => claimId).sort());

  for (const record of review.records) {
    const claim = claimById.get(record.claimId);
    assert.ok(claim, `current migration claim exists: ${record.claimId}`);
    assert.equal(claim.sourceTextSha256, record.sourceTextSha256, `${record.claimId} source span remains exact`);
    assert.equal(claim.targetRef, record.targetRef, `${record.claimId} exact target remains pinned`);
    assert.equal(claim.targetTextSha256, record.targetValueSha256, `${record.claimId} reviewed target digest is preserved`);
    assert.equal(targetDigest(resolveRef(record.targetRef)), record.targetValueSha256, `${record.claimId} live target value is unchanged`);
    assert.deepEqual(resolveRef(record.targetRef), record.expectedOwnerValue, `${record.claimId} reviewed owner meaning is unchanged`);
    assert.equal(claim.semanticReviewStatus, "CLAIM_SPECIFIC_SEMANTIC_PARITY_VERIFIED");
    assert.equal(claim.semanticReviewRef, `${reviewPath}#/records/@claimId=${record.claimId}`);
    assert.equal(claim.acceptanceEffect, "none");
  }

  const metadata = review.nonNormativeMetadataReview;
  const metadataClaim = claimById.get(metadata.claimId);
  assert.equal(metadata.claimId, "MPSEM-0469-C001");
  assert.equal(metadataClaim.disposition, "NON_NORMATIVE_SOURCE_METADATA");
  assert.equal(metadataClaim.sourceTextSha256, metadata.sourceTextSha256);
  assert.equal(metadataClaim.sourceEvidenceRef, "docs/migration/expert-reviewed-master-plan.md#L1155");
  assert.deepEqual(metadataClaim.metadataFields, ["consumer-owner-table-row-label"]);
  assert.equal(metadataClaim.acceptanceEffect, "none");
  assert.deepEqual(review.nonClaims, [
    "Every other migration claim",
    "Whole task completion",
    "Qualified independent acceptance",
    "Publisher or legal approval",
    "Runtime admission",
    "Lifecycle phase receipt",
  ]);
});

test("PXD-084, PXD-085 and PXD-086 are disjoint immutable review cohorts", () => {
  const older = [
    { path: "docs/implementation/verification/pdp-38/migration-coordinator-review.json", artifact: JSON.parse(readText("docs/implementation/verification/pdp-38/migration-coordinator-review.json")), historicalEncoding: true },
    { path: "docs/implementation/verification/pdp-38/migration-policy-source-review.json", artifact: JSON.parse(readText("docs/implementation/verification/pdp-38/migration-policy-source-review.json")), historicalEncoding: false },
  ];
  const expectedReviewFiles = new Map([
    [older[0].path, "5d641e5070d2fa3ce807b665ba18a4a58291450b56dcb708c05ded0d87eb2b38"],
    [older[1].path, "707d4cbaa6c82089b98eb575d8d14079d69fca2d8250d28ef721ae4e9e0ed595"],
    [reviewPath, "e8a5aaa6c6ea0621488529797ba45782deb3a129382ca165bf9e66e340c73792"],
  ]);
  for (const [path, digest] of expectedReviewFiles) assert.equal(sha(readText(path)), digest, `${path} remains the reviewed immutable record`);
  const oldIds = older.flatMap(({ artifact }) => artifact.records.map((record) => record.claimId));
  const newIds = review.records.map((record) => record.claimId);
  assert.equal(oldIds.length, 127, "the established 81+46 bounded records remain intact");
  assert.equal(new Set(oldIds).size, oldIds.length);
  assert.equal(newIds.length, 57);
  assert.equal(new Set(newIds).size, newIds.length);
  assert.equal(newIds.some((id) => oldIds.includes(id)), false, "new review has no overlap with the existing reviewed cohorts");

  for (const { artifact, historicalEncoding } of older) for (const record of artifact.records) {
    const claim = claimById.get(record.claimId);
    assert.ok(claim, `historically reviewed claim remains in current overlay: ${record.claimId}`);
    assert.equal(claim.targetRef, record.targetRef, `${record.claimId} prior target unchanged`);
    assert.equal(claim.sourceTextSha256, record.sourceTextSha256, `${record.claimId} prior source digest unchanged`);
    const currentTarget = resolveRef(record.targetRef);
    const reviewedEncodingDigest = sha(historicalEncoding ? JSON.stringify(currentTarget) : (typeof currentTarget === "string" ? currentTarget : JSON.stringify(currentTarget)));
    let historicalTarget = currentTarget;
    if (reviewedEncodingDigest !== record.targetValueSha256) {
      assert.ok(["MPSEM-0388-C003", "MPSEM-0455-C002"].includes(record.claimId), "only explicitly separated additive source observations can differ from a historical target snapshot");
      if (record.claimId === "MPSEM-0455-C002") {
        assert.equal(frozenDeltas.records.some(({ claimId }) => claimId === record.claimId), false,
          "the later GPU scheduler addition is outside the frozen PXD-085/PXD-100/105 impact evidence");
        const projected = structuredClone(currentTarget);
        delete projected.gpuSchedulerBoundary;
        assert.deepEqual(projected, record.expectedOwnerValue, "PXD-085's reviewed Shared-mechanics clauses remain unchanged");
        assert.ok(currentTarget.gpuSchedulerBoundary, "the live GPU scheduler addition is explicitly present but unreviewed by this cohort");
        assert.equal(claim.targetTextSha256, record.targetValueSha256, "the old approved target digest remains in the ledger");
        assert.equal(claim.semanticReviewRef, `docs/implementation/verification/pdp-38/migration-policy-source-review.json#/records/@claimId=${record.claimId}`);
        historicalTarget = projected;
      } else {
      const sourceImpact = JSON.parse(readText(sourceImpactPath));
      assert.equal(sha(readText(sourceImpactPath)), "4c3b9d12fe072c5f58b735eae38d197f94790d056979c66c5ab65dac15f5b9a7", "PXD-088 reviewed impact artifact remains exact");
      assert.equal(claim.sourceImpactReviewRef, `${sourceImpactPath}#/records/@claimId=MPSEM-0388-C003`);
      const impact = sourceImpact.records.find(({ claimId }) => claimId === record.claimId);
      assert.ok(impact, "the exact additive target impact has a reviewed record");
      assert.equal(impact.disposition, "APPROVED_BOUNDED_CURRENT_TARGET_IMPACT");
      assert.equal(impact.acceptanceEffect, "none");
      assert.equal(impact.priorReviewRef, ".product-experience/decision-log.md#PXD-084");
      assert.equal(impact.previousTargetValueSha256, record.targetValueSha256);
      assert.equal(impact.currentTargetValueSha256, targetDigest(currentTarget));
      assert.deepEqual(impact.currentExpectedOwnerValue, currentTarget);
      assert.equal(impact.soleAdditiveField, "hardwareFootprintDoesNotWaiveAdmission");
      const domainReview = JSON.parse(readText("docs/implementation/verification/pdp-38/migration-domain-review.json"));
      const deltaRecord = [...domainReview.records, ...domainReview.pendingRecords].find((entry) => entry.claimId === record.claimId);
      assert.ok(deltaRecord, "the original owner-source review preserves the old target snapshot");
      assert.equal(deltaRecord.targetValueSha256, record.targetValueSha256, "historical owner value digest is unchanged");
      assert.deepEqual(deltaRecord.expectedOwnerValue, JSON.parse(JSON.stringify(currentTarget, (key, value) => key === "hardwareFootprintDoesNotWaiveAdmission" ? undefined : value)),
        "the additive owner rule is kept separate from the historical target value");
      assert.equal(claim.previouslyReviewedTargetTextSha256, record.targetValueSha256);
      assert.equal(claim.currentOwnerDeltaRef, deltaRecord.currentOwnerDelta.targetRef);
      assert.equal(claim.currentOwnerDeltaTextSha256, deltaRecord.currentOwnerDelta.targetValueSha256);
      assert.deepEqual(resolveRef(claim.currentOwnerDeltaRef), deltaRecord.currentOwnerDelta.expectedOwnerValue);
      }
    }
    assert.equal(claim.targetTextSha256, targetDigest(historicalTarget), `${record.claimId} retains its reviewed target value or explicit current overlay digest`);
    assert.equal(claim.semanticReviewStatus, "CLAIM_SPECIFIC_SEMANTIC_PARITY_VERIFIED");
    assert.equal(claim.acceptanceEffect, "none");
  }
});

test("migration review counters include PXD-086 without promoting phase acceptance", () => {
  const routed = claims.filter((claim) => claim.disposition === "ROUTED_TO_CURRENT_PDP_AUTHORITY");
  const verified = routed.filter((claim) => claim.semanticReviewStatus === "CLAIM_SPECIFIC_SEMANTIC_PARITY_VERIFIED");
  const pending = routed.filter((claim) => claim.semanticReviewStatus === "OWNER_TARGET_LOCATOR_ONLY_PENDING_CLAIM_PARITY");
  assert.equal(routed.length, 862, "the PXD-090 approved claim supersession is counted once, not duplicated as a new routed unit");
  assert.equal(verified.length + pending.length, routed.length, "Every routed claim remains in exactly one reviewed or pending partition; bounded approval suites check their exact immutable cohorts");
  assert.equal(ledger.sourceOwnerRoutingCount, routed.length);
  assert.equal(ledger.currentOwnerTargetClaimUnitCount, routed.length);
  assert.equal(ledger.semanticParityVerifiedClaimUnitCount, verified.length);
  assert.equal(ledger.candidateTargetPendingSemanticParityCount, pending.length);
  assert.equal(ledger.nonNormativeSourceMetadataClaimUnitCount, 8,
    "the separately routed source-metadata unit remains outside the 862 normative claim count");
  assert.equal(ledger.acceptanceEffect.startsWith("none; source routing does not establish independent migration review"), true);
});
