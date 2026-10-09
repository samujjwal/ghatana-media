import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const reviewPath = ".product-experience/pdp-0-product-truth/migration-semantics-review.yaml";
const yamlCache = new Map();
const readYaml = (path) => {
  if (!yamlCache.has(path)) yamlCache.set(path, parse(readFileSync(resolve(root, path), "utf8")));
  return yamlCache.get(path);
};
const sha = (text) => createHash("sha256").update(text).digest("hex");
const normalizedWhitespace = (text) => text.replace(/\s+/gu, " ").trim();

function resolveRef(ref) {
  const [path, pointer] = ref.split("#", 2);
  if (path.endsWith(".md")) {
    assert.ok(pointer, `${ref}: Markdown owner reference needs an anchor`);
    const source = readFileSync(resolve(root, path), "utf8");
    assert.match(source, /DECISION 1|Decision 1/u, `${ref}: referenced mandate section is missing`);
    return source;
  }
  let value = readYaml(path);
  for (const rawSegment of pointer.split("/").filter(Boolean)) {
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (segment.startsWith("@id=")) {
      const wanted = segment.slice(4);
      assert.ok(Array.isArray(value), `${ref}: selector parent is not an array`);
      value = value.find((entry) => entry?.id === wanted);
      assert.notEqual(value, undefined, `${ref}: missing exact ID ${wanted}`);
    } else if (/^\d+$/u.test(segment)) {
      value = value[Number(segment)];
      assert.notEqual(value, undefined, `${ref}: missing index ${segment}`);
    } else {
      assert.ok(value && Object.hasOwn(value, segment), `${ref}: missing field ${segment}`);
      value = value[segment];
    }
  }
  return value;
}




function assertLicenseSemantics(claim) {
  assert.match(claim.targetRef, /mediaArchitectureRules\/licenses$/u);
  const policy = resolveRef(claim.targetRef);
  if (claim.claimId === "MPSEM-0456-C001") {
    assert.deepEqual(policy.preferredWhenSuitable, ["MIT", "Apache-2.0", "BSD", "ISC", "Zlib"]);
    assert.match(policy.selectionCondition, /technically-suitable/u);
  } else if (claim.claimId === "MPSEM-0456-C002") {
    for (const category of ["weak-copyleft", "strong-copyleft", "network-copyleft", "proprietary-services", "noncommercial-or-research-only-model-weights", "unclear-license-terms"])
      assert.ok(policy.categoriesRequiringSeparateReview.includes(category), `missing license review class ${category}`);
  } else if (claim.claimId === "MPSEM-0456-C003") {
    assert.match(policy.bundleSafetyRule, /entire-bundle-or-transitive-dependency-closure/u);
    assert.match(policy.legalReviewStatus, /no-legal-conclusion/u);
  }
}

function assertAdapterSequencingSemantics(claim) {
  const expect = (condition, message) => assert.ok(condition, message);
  if (claim.claimId === "MPSEM-0460-C001") {
    const preferences = resolveRef(claim.targetRef);
    expect(Array.isArray(preferences), "reuse preference must be an explicit list");
    expect(preferences.some((item) => /Ghatana-image-and-media/u.test(item)), "Ghatana image/media preference missing");
    expect(preferences.some((item) => /Shared-public-primitives/u.test(item)), "Shared primitive preference missing");
    expect(preferences.some((item) => /TutorPutor.*rendering-and-animation/u.test(item)), "TutorPutor render/animation preference missing");
  } else if (claim.claimId === "MPSEM-0460-C002") {
    assert.match(claim.targetRef, /mediaArchitectureRules\/engineAdapterSequencing$/u);
    const rule = resolveRef(claim.targetRef);
    assert.deepEqual(rule.engines, ["Godot", "Bevy", "Filament", "Jolt", "PhysX", "MuJoCo", "Taichi"]);
    assert.match(rule.rule, /before-the-first-end-to-end-experience/u);
  } else if (claim.claimId === "MPSEM-0460-C003") {
    assert.match(claim.targetRef, /mediaArchitectureRules\/qualifiedStackRule$/u);
    assert.match(resolveRef(claim.targetRef), /smallest-stack-that-meets-the-qualified-requirements-of-the-next-admitted-recipe/u);
  } else if (claim.claimId === "MPSEM-0460-C004") {
    assert.match(claim.targetRef, /mediaArchitectureRules\/replaceablePortsRule$/u);
    const rule = resolveRef(claim.targetRef);
    assert.match(rule.requirement, /implementation-ports-replaceable/u);
    assert.match(rule.prohibition, /unused-abstractions-or-adapters/u);
  }
}

const supersessionAllowlist = new Set([
  "MPSEM-0005-C002",
  "MPSEM-0005-C003",
  "MPSEM-0005-C004",
  "MPSEM-0006-C001",
  "MPSEM-0006-C002",
  "MPSEM-1222-C005",
]);

function assertOwnerAccountedGap(claim) {
  assert.equal(claim.disposition, "OWNER_ACCOUNTED_PENDING_SEMANTIC_DEFINITION");
  assert.ok(claim.unresolvedObligation, "a gap needs a named material obligation");
  assert.ok(claim.ownerAuthorityRef, "a gap needs a current owning authority");
  assert.equal(claim.semanticEquivalence, "NOT_ASSERTED");
  assert.equal(Object.hasOwn(claim, "targetRef"), false,
    "a source/candidate field cannot be represented as a semantic match while the obligation is open");
  assert.equal(Object.hasOwn(claim, "targetTextSha256"), false);
  assert.ok(resolveRef(claim.ownerAuthorityRef) !== undefined, "the owner authority selector resolves");
}

function assertClaimDisposition(claim) {
  if (claim.disposition === "NON_NORMATIVE_SOURCE_METADATA") {
    if (claim.claimId === "MPSEM-0001-C001") {
      assert.deepEqual(claim.metadataFields, ["document-id", "review-date", "document-status"]);
    } else if (claim.claimId === "MPSEM-0035-C001") {
      assert.deepEqual(claim.metadataFields, ["table-row-heading"]);
      assert.equal(claim.sourceEvidenceRef, "docs/migration/expert-reviewed-master-plan.md#L114");
      assert.match(claim.rationale, /first column .*review row/u);
    } else if (claim.claimId === "MPSEM-0053-C001") {
      assert.deepEqual(claim.metadataFields, ["table-row-heading"]);
      assert.equal(claim.sourceEvidenceRef, "docs/migration/expert-reviewed-master-plan.md#L143");
      assert.match(claim.rationale, /row label/u);
    } else if (claim.claimId === "MPSEM-0055-C001") {
      assert.deepEqual(claim.metadataFields, ["table-row-heading"]);
      assert.equal(claim.sourceEvidenceRef, "docs/migration/expert-reviewed-master-plan.md#L145");
      assert.match(claim.rationale, /table row label/u);
    } else if (claim.claimId === "MPSEM-0066-C001") {
      assert.deepEqual(claim.metadataFields, ["introductory-list-lead-in"]);
      assert.match(claim.rationale, /colon-terminated lead-in immediately followed by a four-item ownership list/u);
    } else if (claim.claimId === "MPSEM-0469-C001") {
      assert.deepEqual(claim.metadataFields, ["consumer-owner-table-row-label"]);
      assert.equal(claim.sourceEvidenceRef, "docs/migration/expert-reviewed-master-plan.md#L1155");
      assert.match(claim.rationale, /first Consumer\/owner cell in the source inventory table/u);
    } else {
      assert.equal(claim.claimId, "MPSEM-0023-C001");
      assert.deepEqual(claim.metadataFields, ["finding-id-and-summary-label"]);
      assert.equal(claim.sourceEvidenceRef, "docs/migration/expert-reviewed-master-plan.md#L102");
      assert.match(claim.rationale, /Finding column label in a three-column table/u);
    }
    assert.equal(Object.hasOwn(claim, "targetRef"), false,
      "bibliographic and document-status metadata must not be routed to a product behavior target");
    assert.equal(claim.acceptanceEffect, "none");
    return;
  }
  if (claim.disposition === "SUPERSEDED_AS_ACTIVE_71_PROGRAM_INSTRUCTION") {
    assert.ok(supersessionAllowlist.has(claim.claimId), `${claim.claimId} is outside the exact supersession allowlist`);
    assert.match(claim.exactSourceText, /DEFINE_PRODUCT|EXECUTE_MIGRATION|IMPLEMENT_RUNTIME|Migration is a cross-repository|Production implementation and qualification|Use the mappings below/u,
      "supersession must be a narrowly task-specific instruction, not a product, rights, or safety rule");
    assert.equal(claim.acceptanceEffect, "none");
    return;
  }
  if (claim.disposition === "OWNER_ACCOUNTED_PENDING_SEMANTIC_DEFINITION") {
    assertOwnerAccountedGap(claim);
    return;
  }
  if (claim.disposition === "RETAINED_AS_HISTORICAL_PROGRAM_TRUTH" || claim.disposition === "OUT_OF_SCOPE_RETAINED_HISTORICAL_REQUIREMENT") {
    assert.ok(claim.retainedSourceRef);
    assert.equal(claim.acceptanceEffect, "none");
    assert.match(claim.rationale, /histor|history/u);
    return;
  }
  if (claim.disposition === "DECOMPOSED_TO_OWNER_AUTHORITY_CLAIMS") {
    assert.equal(claim.subclaimCount, claim.subclaims.length);
    for (const child of claim.subclaims) {
      assert.equal(claim.exactSourceText.includes(child.exactSourceText), true, `${child.claimId} is not an exact source subspan`);
      assert.equal(child.sourceTextSha256, sha(child.exactSourceText));
      assertClaimDisposition(child);
    }
    return;
  }
  assert.equal(claim.disposition, "ROUTED_TO_CURRENT_PDP_AUTHORITY", `unknown disposition for ${claim.claimId}`);
  assert.ok(claim.targetRef, `${claim.claimId} needs one exact authority selector`);
  const target = resolveRef(claim.targetRef);
  const targetText = typeof target === "string" ? target : JSON.stringify(target);
  const targetDigest = claim.coordinatorReviewStatus === "APPROVED_BOUNDED_OWNER_SOURCE_SEMANTIC_ROUTE"
    ? sha(JSON.stringify(target))
    : sha(targetText);
  assert.equal(claim.targetTextSha256, targetDigest, `${claim.claimId} target content changed without semantic review`);
  assert.equal(claim.acceptanceEffect, "none");
  assertHighRiskMigrationSemantics(claim);
  if (claim.claimId.startsWith("MPSEM-0456-C")) assertLicenseSemantics(claim);
  if (claim.claimId.startsWith("MPSEM-0460-C")) assertAdapterSequencingSemantics(claim);
}

function assertHighRiskMigrationSemantics(claim) {
  const expected = new Map([
    ["MPSEM-0001-C002-S01", ".product-experience/pdp-0-product-truth/policy-authority-model.yaml#/migrationExecutionBoundary/legacyPlanAuthority/rule"],
    ["MPSEM-0001-C002-S02", ".product-experience/pdp-0-product-truth/glossary.yaml#/terms/@id=media.term.ghatana-media/term"],
    ["MPSEM-0001-C002-S03", ".product-experience/authority-map.yaml#/productId"],
    ["MPSEM-0001-C002-S04", ".product-experience/pdp-0-product-truth/policy-authority-model.yaml#/target/repository"],
    ["MPSEM-0001-C002-S05", ".product-experience/pdp-0-product-truth/policy-authority-model.yaml#/currentAuthority/repository"],
    ["MPSEM-0001-C002-S06", ".product-experience/pdp-0-product-truth/policy-authority-model.yaml#/currentAuthority/path"],
    ["MPSEM-0001-C002-S07", ".product-experience/pdp-0-product-truth/glossary.yaml#/terms/@id=media.term.mediasynth/term"],
    ["MPSEM-0001-C002-S08", ".product-experience/pdp-0-product-truth/applications-channels.yaml#/channels/@id=media.channel.cli/commandIdentity"],
    ["MPSEM-0001-C002-S09", ".product-experience/authority-map.yaml#/canonicalPdpPhases"],
    ["MPSEM-0001-C003", ".product-experience/authority-map.yaml#/canonicalPdpPhases/@id=EXPLORER/outsidePdpPhases"],
    ["MPSEM-0002-C002", ".product-experience/authority-map.yaml#/authorityRules/@id=AUTH-RULE-ONE-OWNER/rule"],
    ["MPSEM-0002-C003", ".product-experience/pdp-0-product-truth/constitution.yaml#/requirements/@id=MEDIA-CONST-018/statement"],
    ["MPSEM-0002-C004-S01", ".product-experience/pdp-0-product-truth/constitution.yaml#/ownerDefinedExperienceRules/nativeProtectionAndQuality/requirement"],
    ["MPSEM-0002-C004-S02", ".product-experience/pdp-0-product-truth/constitution.yaml#/ownerDefinedExperienceRules/progressiveComplexity/requirement"],
    ["MPSEM-0046-C002", ".product-experience/pdp-0-product-truth/dependency-contracts.yaml#/ownerDefinedImportBoundary/ghatanaCoreConsumerRule"],
    ["MPSEM-0388-C003", ".product-experience/pdp-0-product-truth/policy-authority-model.yaml#/modelAcquisitionAndFallback"],
    ["MPSEM-0443-C002", ".product-experience/pdp-0-product-truth/glossary.yaml#/unitsAndConventions/rules/@id=media.unit.measurement-uncertainty/estimatePresentationRule"],
    ["MPSEM-0445-C002", ".product-experience/pdp-0-product-truth/glossary.yaml#/terms/@id=media.term.intent/conversationOutputRule"],
    ["MPSEM-0074-C004", ".product-experience/pdp-0-product-truth/domain-model.yaml#/proposedRecordCatalog/@id=MediaAsset"],
    ["MPSEM-0075-C004", ".product-experience/pdp-0-product-truth/domain-model.yaml#architecturePrinciples/subsystemProposal/rule"],
    ["MPSEM-0055-C002", ".product-experience/pdp-0-product-truth/glossary.yaml#namingRules/compatibilityNames"],
  ]);
  if (!expected.has(claim.claimId)) return;
  assert.equal(claim.targetRef, expected.get(claim.claimId), `${claim.claimId} must preserve its exact semantic owner target`);
  const target = resolveRef(claim.targetRef);
  if (claim.claimId === "MPSEM-0001-C002-S01") {
    assert.match(target, /non-authoritative until decomposed into and reviewed in the exact owning PDP records/u);
    assert.match(target, /not a parallel semantic source/u);
  } else if (claim.claimId === "MPSEM-0001-C002-S02") {
    assert.equal(target, "Ghatana Media");
  } else if (claim.claimId === "MPSEM-0001-C002-S03") {
    assert.equal(target, "media");
  } else if (claim.claimId === "MPSEM-0001-C002-S04") {
    assert.equal(target, "samujjwal/ghatana-media");
  } else if (claim.claimId === "MPSEM-0001-C002-S05") {
    assert.equal(target, "samujjwal/ghatana");
  } else if (claim.claimId === "MPSEM-0001-C002-S06") {
    assert.equal(target, "services/media");
  } else if (claim.claimId === "MPSEM-0001-C002-S07") {
    assert.equal(target, "MediaSynth");
    const term = readYaml(".product-experience/pdp-0-product-truth/glossary.yaml").terms.find(({ id }) => id === "media.term.mediasynth");
    assert.match(term.distinctions.join(" "), /subsystem of Ghatana Media/u);
  } else if (claim.claimId === "MPSEM-0001-C002-S08") {
    assert.equal(target, "ghatana-media");
    const cli = readYaml(".product-experience/pdp-0-product-truth/applications-channels.yaml").channels.find(({ id }) => id === "media.channel.cli");
    assert.match(cli.commandIdentityMeaning, /does not assert an installed, published, supported, or runtime-available executable/u);
  } else if (claim.claimId === "MPSEM-0001-C002-S09") {
    assert.deepEqual(target.filter(({ outsidePdpPhases }) => !outsidePdpPhases).map(({ id }) => id), ["PDP-0", "PDP-1", "PDP-2", "PDP-3"]);
    assert.equal(target.find(({ id }) => id === "EXPLORER").outsidePdpPhases, true);
  } else if (claim.claimId === "MPSEM-0001-C003") {
    assert.equal(target, true);
  } else if (claim.claimId === "MPSEM-0002-C002") {
    assert.match(target, /Each semantic concept has one editable owner/u);
    assert.match(target, /consumer records and projections do not become parallel authorities/u);
  } else if (claim.claimId === "MPSEM-0002-C003") {
    assert.match(target, /Web, CLI, API, SDK, embedded integrations, and Explorer/u);
    assert.match(target, /one domain, action, and state authority/u);
  } else if (claim.claimId === "MPSEM-0002-C004-S01") {
    assert.match(target, /Every normal product path applies the protections required by policy/u);
    assert.match(target, /verifies applicable media structure and quality/u);
    assert.match(target, /cannot disable or weaken/u);
  } else if (claim.claimId === "MPSEM-0002-C004-S02") {
    assert.match(target, /without choosing models, queues, engines, or infrastructure/u);
    assert.match(target, /Simple, Guided, and Expert expose progressively deeper controls/u);
    assert.match(target, /ordinary product outcomes do not require Expert controls/u);
  } else if (claim.claimId === "MPSEM-0046-C002") {
    assert.match(target, /Ghatana core and neutral platform consumers use only immutable published Media artifacts/u);
    assert.match(target, /must not import Ghatana Media source trees, product implementation packages, generated implementation internals, or private modules/u);
  }
}

test("PDP-38 migration overlay exactly partitions all 260 historical unresolved blocks", () => {
  const review = readYaml(reviewPath);
  const overlay = review.pdp38ClaimReconciliation;
  const historical = new Set(review.items
    .filter(({ classification }) => classification === "UNRESOLVED")
    .map(({ itemId }) => itemId));
  const recordIds = overlay.records.map(({ itemId }) => itemId);
  assert.equal(historical.size, 260);
  assert.equal(overlay.historicalPopulation.unresolvedAtHistoricalReview, 260);
  assert.equal(recordIds.length, 260);
  assert.equal(new Set(recordIds).size, 260);
  assert.deepEqual(new Set(recordIds), historical);
  const topLevelClaims = overlay.records.flatMap(({ claims }) => claims);
  const leafClaims = topLevelClaims.flatMap((claim) => claim.disposition === "DECOMPOSED_TO_OWNER_AUTHORITY_CLAIMS" ? claim.subclaims : [claim]);
  const claimIds = leafClaims.map(({ claimId }) => claimId);
  assert.equal(claimIds.length, overlay.currentClaimUnitCount);
  assert.equal(new Set(claimIds).size, claimIds.length);
  for (const record of overlay.records) {
    const source = review.items.find(({ itemId }) => itemId === record.itemId);
    assert.ok(source);
    assert.ok(record.currentSourceLines[0] > 0 && record.currentSourceLines[1] >= record.currentSourceLines[0]);
    assert.equal(record.sourceTextSha256.length, 64, `${record.itemId} source span digest is SHA-256`);
    const recordLeafCount = record.claims.reduce((count, claim) => count + (claim.disposition === "DECOMPOSED_TO_OWNER_AUTHORITY_CLAIMS" ? claim.subclaims.length : 1), 0);
    assert.equal(recordLeafCount, record.claimUnits);
    for (const claim of record.claims) {
      assert.ok(normalizedWhitespace(source.text).includes(normalizedWhitespace(claim.exactSourceText)), `${claim.claimId} is not an exact normalized source span`);
      assert.equal(claim.sourceTextSha256, sha(claim.exactSourceText));
      try { assertClaimDisposition(claim); }
      catch (error) { error.message = `${claim.claimId}: ${error.message}`; throw error; }
    }
  }
  const superseded = leafClaims.filter(({ disposition }) => disposition === "SUPERSEDED_AS_ACTIVE_71_PROGRAM_INSTRUCTION");
  const gaps = leafClaims.filter(({ disposition }) => disposition === "OWNER_ACCOUNTED_PENDING_SEMANTIC_DEFINITION");
  const routed = leafClaims.filter(({ disposition }) => disposition === "ROUTED_TO_CURRENT_PDP_AUTHORITY");
  assert.deepEqual(new Set(superseded.map(({ claimId }) => claimId)), supersessionAllowlist);
  assert.equal(superseded.length, 6);
  assert.equal(gaps.length, 0);
  const retained = leafClaims.filter(({ disposition }) => disposition === "RETAINED_AS_HISTORICAL_PROGRAM_TRUTH");
  const outOfScope = leafClaims.filter(({ disposition }) => disposition === "OUT_OF_SCOPE_RETAINED_HISTORICAL_REQUIREMENT");
  assert.equal(outOfScope.length, 1);
  const metadata = leafClaims.filter(({ disposition }) => disposition === "NON_NORMATIVE_SOURCE_METADATA");
  const verified = routed.filter(({ semanticReviewStatus }) => semanticReviewStatus === "CLAIM_SPECIFIC_SEMANTIC_PARITY_VERIFIED");
  const pending = routed.filter(({ semanticReviewStatus }) => semanticReviewStatus === "OWNER_TARGET_LOCATOR_ONLY_PENDING_CLAIM_PARITY");
  assert.equal(metadata.length, 7);
  assert.equal(routed.length, 863);
  assert.equal(retained.length, 7);
  assert.equal(overlay.scopeSupersededClaimUnitCount, superseded.length);
  assert.equal(overlay.ownerAccountedPendingSemanticDefinitionCount, gaps.length);
  assert.equal(gaps.length, 0);
  assert.equal(overlay.retainedHistoricalProgramTruthClaimCount, retained.length);
  assert.equal(overlay.outOfScopeHistoricalRequirementCount, outOfScope.length);
  assert.equal(overlay.decomposedAggregateClaimCount, 3);
  assert.equal(overlay.nonNormativeSourceMetadataClaimUnitCount, metadata.length);
  assert.equal(overlay.currentOwnerTargetClaimUnitCount, routed.length);
  assert.equal(overlay.sourceOwnerRoutingCount, routed.length);
  assert.equal(overlay.semanticParityVerifiedClaimUnitCount, verified.length);
  assert.equal(overlay.candidateTargetPendingSemanticParityCount, pending.length);
  assert.equal(verified.length, 339);
  assert.equal(pending.length, 524);
  const historicalExplorer = leafClaims.find(({ claimId }) => claimId === "MPSEM-0160-C001");
  assert.equal(historicalExplorer.disposition, "RETAINED_AS_HISTORICAL_PROGRAM_TRUTH");
  assert.match(historicalExplorer.retainedSourceRef, /expert-reviewed-master-plan\.md#L332/u);
  assert.match(historicalExplorer.supersessionAuthorityRef, /EXECUTE-MEDIA-PDP-0-3-38-TASKS\.md/u);
  const currentMandate = readFileSync(resolve(root, "docs/implementation/EXECUTE-MEDIA-PDP-0-3-38-TASKS.md"), "utf8");
  assert.match(currentMandate, /standalone Experience Explorer development/u);
  assert.match(currentMandate, /Explorer remains an optional \*\*read-only consumer\/projection of all four PDP authorities\*\*/u);
  assert.match(historicalExplorer.rationale, /execution scope, not Media product meaning/u);
  assert.equal(review.ownerDecisionOverlay.unresolvedBlockCount + review.ownerDecisionOverlay.ownerClassifiedNonNormativeBlockCount, 349);
  assert.equal(review.counts.blockStructureProposalCounts.total, 263);
  assert.equal(review.ownerDecisionOverlay.ownerClassifiedNonNormativeBlockCount, 89);
});

test("the MPSEM-0066 lead-in is classified from its exact colon-and-list source structure", () => {
  const review = readYaml(reviewPath);
  const record = review.pdp38ClaimReconciliation.records.find(({ itemId }) => itemId === "MPSEM-0066");
  const claim = record.claims[0];
  const source = readFileSync(resolve(root, "docs/migration/expert-reviewed-master-plan.md"), "utf8").split(/\r?\n/u);
  const [start, end] = record.currentSourceLines;
  assert.deepEqual([start, end], [174, 174]);
  assert.equal(source[start - 1], "The boundary must declare that `ghatana-media`:");
  assert.equal(source[start], "");
  assert.equal(source[start + 1].startsWith("- owns Media product semantics"), true);
  assert.equal(source.slice(start + 1, start + 5).filter((line) => line.startsWith("- ")).length, 4);
  assert.equal(claim.disposition, "NON_NORMATIVE_SOURCE_METADATA");
  assert.equal(claim.semanticReviewStatus, undefined);
  assert.equal(Object.hasOwn(claim, "targetRef"), false);
  assert.equal(record.sourceClassificationPreserved, "UNRESOLVED");
});

test("the REV-03 table label is metadata while its problem and required resolution stay separate claims", () => {
  const review = readYaml(reviewPath);
  const record = review.pdp38ClaimReconciliation.records.find(({ itemId }) => itemId === "MPSEM-0023");
  const labels = record.claims;
  const heading = labels.find(({ claimId }) => claimId === "MPSEM-0023-C001");
  const problem = labels.find(({ claimId }) => claimId === "MPSEM-0023-C002");
  const resolution = labels.find(({ claimId }) => claimId === "MPSEM-0023-C003");
  const adapter = labels.find(({ claimId }) => claimId === "MPSEM-0023-C004");
  const source = readFileSync(resolve(root, "docs/migration/expert-reviewed-master-plan.md"), "utf8").split(/\r?\n/u);
  assert.equal(source[101], "| REV-03 — API redesign mixed into extraction | U1 §22.8 proposes `/v1/*`; current Media and its operation client use different `/api/v1/*` shapes [R13, R19] | Preserve supported wire contracts during relocation. Reconcile canonical operations through explicit adapters and compatibility tests before admitting new contracts. |");
  assert.equal(heading.disposition, "NON_NORMATIVE_SOURCE_METADATA");
  assert.equal(Object.hasOwn(heading, "targetRef"), false);
  assert.deepEqual(record.currentSourceLines, [102, 102]);
  assert.equal(problem.disposition, "ROUTED_TO_CURRENT_PDP_AUTHORITY");
  assert.equal(resolution.disposition, "ROUTED_TO_CURRENT_PDP_AUTHORITY");
  assert.equal(adapter.disposition, "ROUTED_TO_CURRENT_PDP_AUTHORITY");
  assert.match(resolution.targetRef, /wireCompatibilityPreservationRule$/u);
  assert.match(adapter.targetRef, /wireCompatibilityPreservationRule$/u);
});

test("high-risk cover, identity, phase, and one-owner mappings reject unrelated stable targets", () => {
  const review = readYaml(reviewPath);
  const leafClaims = review.pdp38ClaimReconciliation.records.flatMap(({ claims }) => claims)
    .flatMap((claim) => claim.disposition === "DECOMPOSED_TO_OWNER_AUTHORITY_CLAIMS" ? claim.subclaims : [claim]);
  const claimById = new Map(leafClaims.map((claim) => [claim.claimId, claim]));
  assert.equal(claimById.get("MPSEM-0001-C001").disposition, "NON_NORMATIVE_SOURCE_METADATA");
  assert.equal(Object.hasOwn(claimById.get("MPSEM-0001-C001"), "targetRef"), false);
  for (const id of ["MPSEM-0001-C002-S01", "MPSEM-0001-C002-S02", "MPSEM-0001-C002-S03", "MPSEM-0001-C002-S04", "MPSEM-0001-C002-S05", "MPSEM-0001-C002-S06", "MPSEM-0001-C002-S07", "MPSEM-0001-C002-S08", "MPSEM-0001-C002-S09", "MPSEM-0001-C003", "MPSEM-0002-C002"]) {
    const mutated = structuredClone(claimById.get(id));
    mutated.targetRef = ".product-experience/pdp-0-product-truth/handoff-contracts.yaml#/handoffs/@id=kernel-product-lifecycle/sourceOwner";
    mutated.targetTextSha256 = sha(resolveRef(mutated.targetRef));
    assert.throws(() => assertClaimDisposition(mutated), undefined, `${id} must reject Lifecycle/source-owner as a semantic substitute`);
  }
  const coverAsGenericWorkflow = structuredClone(claimById.get("MPSEM-0001-C002-S01"));
  coverAsGenericWorkflow.targetRef = ".product-experience/pdp-0-product-truth/capability-preservation-crosswalk.yaml#/legacyDocumentIntelligenceDisposition/platformOwnedScope/5";
  coverAsGenericWorkflow.targetTextSha256 = sha(resolveRef(coverAsGenericWorkflow.targetRef));
  assert.throws(() => assertClaimDisposition(coverAsGenericWorkflow), undefined, "generic document workflow must not stand in for cover metadata or authority status");
});

test("model-acquisition review preserves the pinned snapshot and records the new owner policy delta", () => {
  const review = readYaml(reviewPath);
  const claim = review.pdp38ClaimReconciliation.records.flatMap(({ claims }) => claims ?? [])
    .flatMap((item) => item.disposition === "DECOMPOSED_TO_OWNER_AUTHORITY_CLAIMS" ? item.subclaims : [item])
    .find(({ claimId }) => claimId === "MPSEM-0388-C003");
  assert.equal(claim.previouslyReviewedTargetTextSha256, "5a29712ad7914bd6856b6b9112e0cc13db54ae753c0b7b66c61c99ab9f465a7e");
  assert.equal(claim.targetTextSha256, sha(JSON.stringify(resolveRef(claim.targetRef))));
  const delta = resolveRef(claim.currentOwnerDeltaRef);
  assert.equal(delta.id, "media.policy.model-hardware-footprint-does-not-waive-admission");
  assert.equal(claim.currentOwnerDeltaTextSha256, sha(JSON.stringify(delta)));
  assert.match(delta.rule, /does not create an exception to artifact identity/u);
  assert.match(delta.localExecutionDisposition, /DENY_UNADMITTED_MODEL/u);
});

test("known migration target corrections preserve the full claim clauses at exact owner sources", () => {
  const review = readYaml(reviewPath);
  const leafClaims = review.pdp38ClaimReconciliation.records.flatMap(({ claims }) => claims);
  const claimById = new Map(leafClaims.map((claim) => [claim.claimId, claim]));
  const assertions = new Map([
    ["MPSEM-0046-C002", ["Ghatana core and neutral platform consumers", "must not import Ghatana Media source trees", "immutable published Media artifacts"]],
    ["MPSEM-0388-C003", ["do not download a model", "Cloud/provider egress is always denied", "exact owner-approved profile explicitly lists the alternate"]],
    ["MPSEM-0443-C002", ["Label every estimated or predicted value", "retain its method and applicable uncertainty", "measured ground truth"]],
    ["MPSEM-0445-C002", ["Authorized conversation-derived intent compiles", "exact user-authorized content", "conversation-wide output requires an explicit operation contract and consent"]],
    ["MPSEM-0074-C004", ["Project-specific use of an artifact version", "References bytes; does not duplicate or redefine them"]],
    ["MPSEM-0075-C004", ["MediaSynth orchestrates admitted creation capabilities", "does not own duplicate copies of rendering, synchronization, quality, or provenance mechanisms"]],
    ["MPSEM-0055-C002", ["com.ghatana.media.*", "com.ghatana.audio.video.*", "Preserve during migration"]],
  ]);
  for (const [id, phrases] of assertions) {
    const claim = claimById.get(id);
    assert.ok(claim, `${id} remains in the immutable claim population`);
    assert.equal(claim.semanticReviewStatus, "CLAIM_SPECIFIC_SEMANTIC_PARITY_VERIFIED");
    const target = resolveRef(claim.targetRef);
    const semantic = typeof target === "string" ? target : JSON.stringify(target);
    for (const phrase of phrases) assert.ok(semantic.includes(phrase), `${id} exact owner target preserves: ${phrase}`);
  }
});

test("mixed four-phase summary is decomposed into exact current owner sources", () => {
  const review = readYaml(reviewPath);
  const parent = review.pdp38ClaimReconciliation.records.find(({ itemId }) => itemId === "MPSEM-1259").claims
    .find(({ claimId }) => claimId === "MPSEM-1259-C001");
  assert.equal(parent.disposition, "DECOMPOSED_TO_OWNER_AUTHORITY_CLAIMS");
  assert.equal(parent.subclaims.length, 19);
  assert.equal(parent.subclaims.find(({ claimId }) => claimId.endsWith("-S08")).disposition, "OUT_OF_SCOPE_RETAINED_HISTORICAL_REQUIREMENT");
  assert.equal(parent.subclaims.find(({ claimId }) => claimId.endsWith("-S18")).targetRef,
    ".product-experience/pdp-0-product-truth/policy-authority-model.yaml#/migrationExecutionBoundary/selectiveInvalidationRule");
});

test("erasure negative boundary maps to the actual metadata-only confirmation rule", () => {
  const review = readYaml(reviewPath);
  const claim = review.pdp38ClaimReconciliation.records.flatMap(({ claims }) => claims)
    .find(({ claimId }) => claimId === "MPSEM-0366-C003");
  assert.equal(claim.disposition, "ROUTED_TO_CURRENT_PDP_AUTHORITY");
  assert.equal(claim.targetRef,
    ".product-experience/pdp-0-product-truth/policy-authority-model.yaml#/productPolicy/dataHandling/deletion/confirmationRule");
  const target = resolveRef(claim.targetRef);
  assert.match(claim.exactSourceText, /Do not mark physical erasure complete/u);
  assert.match(target, /metadata-hidden-or-key-unavailable-alone-is-not-physical-erasure-confirmation/u);
  assert.match(claim.rationale, /preserving the claim’s concrete negative boundary/u);
});

test("license and adapter-sequencing claims preserve their exact owner-defined rules", () => {
  const review = readYaml(reviewPath);
  const claims = new Map(review.pdp38ClaimReconciliation.records.flatMap(({ claims }) => claims)
    .map((claim) => [claim.claimId, claim]));
  const licensePreference = claims.get("MPSEM-0456-C001");
  assert.match(licensePreference.exactSourceText, /MIT, Apache-2\.0, BSD, ISC or Zlib/u);
  assert.match(licensePreference.exactSourceText, /technically suitable/u);
  assert.equal(licensePreference.disposition, "ROUTED_TO_CURRENT_PDP_AUTHORITY");
  assert.equal(licensePreference.targetRef, ".product-experience/pdp-0-product-truth/reuse-decisions.yaml#/mediaArchitectureRules/licenses");
  const licensePolicy = resolveRef(licensePreference.targetRef);
  assert.deepEqual(licensePolicy.preferredWhenSuitable, ["MIT", "Apache-2.0", "BSD", "ISC", "Zlib"]);
  assert.match(licensePolicy.selectionCondition, /technically-suitable/u);

  const licenseCategories = claims.get("MPSEM-0456-C002");
  for (const category of ["weak-copyleft", "strong-copyleft/network-copyleft", "noncommercial/research-only weights", "unclear terms"])
    assert.ok(licenseCategories.exactSourceText.includes(category), `preserve category ${category}`);
  assert.equal(licenseCategories.disposition, "ROUTED_TO_CURRENT_PDP_AUTHORITY");
  assert.deepEqual(resolveRef(licenseCategories.targetRef).categoriesRequiringSeparateReview,
    ["weak-copyleft", "strong-copyleft", "network-copyleft", "proprietary-services", "noncommercial-or-research-only-model-weights", "unclear-license-terms"]);
  const bundleBoundary = claims.get("MPSEM-0456-C003");
  assert.match(resolveRef(bundleBoundary.targetRef).bundleSafetyRule, /entire-bundle-or-transitive-dependency-closure/u);
  assert.match(bundleBoundary.exactSourceText, /selection categories, not legal conclusions/u);

  const adapterSequence = claims.get("MPSEM-0460-C002");
  for (const engine of ["Godot", "Bevy", "Filament", "Jolt", "PhysX", "MuJoCo", "Taichi"])
    assert.ok(adapterSequence.exactSourceText.includes(engine), `preserve named engine ${engine}`);
  assert.match(adapterSequence.exactSourceText, /before a first end-to-end experience/u);
  const adapterRule = resolveRef(adapterSequence.targetRef);
  assert.deepEqual(adapterRule.engines, ["Godot", "Bevy", "Filament", "Jolt", "PhysX", "MuJoCo", "Taichi"]);
  assert.match(adapterRule.rule, /before-the-first-end-to-end-experience/u);
  assert.equal(adapterSequence.disposition, "ROUTED_TO_CURRENT_PDP_AUTHORITY");

  const replaceablePorts = claims.get("MPSEM-0460-C004");
  assert.match(replaceablePorts.exactSourceText, /replaceable ports/u);
  assert.match(replaceablePorts.exactSourceText, /not dozens of unused abstractions and adapters/u);
  const portRule = resolveRef(replaceablePorts.targetRef);
  assert.match(portRule.requirement, /implementation-ports-replaceable/u);
  assert.match(portRule.prohibition, /unused-abstractions-or-adapters/u);
  assert.equal(replaceablePorts.disposition, "ROUTED_TO_CURRENT_PDP_AUTHORITY");
});

test("semantic assertions reject a stable but unrelated candidate target", () => {
  const review = readYaml(reviewPath);
  const claim = structuredClone(review.pdp38ClaimReconciliation.records.flatMap(({ claims }) => claims)
    .find(({ claimId }) => claimId === "MPSEM-0456-C001"));
  claim.disposition = "ROUTED_TO_CURRENT_PDP_AUTHORITY";
  claim.targetRef = ".product-experience/pdp-0-product-truth/reuse-decisions.yaml#/selectionRegister/externalCandidates/@id=TECH-DAV1D/authoritativeRepository";
  claim.targetTextSha256 = sha(resolveRef(claim.targetRef));
  assert.throws(() => assertClaimDisposition(claim));

  const sequence = structuredClone(review.pdp38ClaimReconciliation.records.flatMap(({ claims }) => claims)
    .find(({ claimId }) => claimId === "MPSEM-0460-C002"));
  sequence.targetRef = ".product-experience/pdp-0-product-truth/applications-channels.yaml#/channels/@id=media.channel.embedded/name";
  sequence.targetTextSha256 = sha(resolveRef(sequence.targetRef));
  assert.throws(() => assertClaimDisposition(sequence));
});
