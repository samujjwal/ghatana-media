import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { validateMigrationClaimReview } from "../scripts/lib/pdp-migration-dependency-review.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const read = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const migration = read(".product-experience/pdp-0-product-truth/migration-semantics-review.yaml");
const refs = {
  "MPSEM-0030-C003": ".product-experience/pdp-0-product-truth/handoff-contracts.yaml#/handoffs/@id=ai-inference-execution/genericInferenceOwnershipBoundary",
  "MPSEM-0078-C004": ".product-experience/pdp-0-product-truth/profile-semantics.yaml#supportedIOContract",
  "MPSEM-0094-C002": ".product-experience/pdp-0-product-truth/handoff-contracts.yaml#/handoffs/@id=ai-inference-execution/genericInferenceOwnershipBoundary",
  "MPSEM-0100-C001": ".product-experience/pdp-0-product-truth/handoff-contracts.yaml#/handoffs/@id=digital-marketing-creative-brief/campaignPublicationWorkflowBoundary",
  "MPSEM-0171-C006": ".product-experience/pdp-0-product-truth/handoff-contracts.yaml#cancellationRetryReconciliationRule",
  "MPSEM-0171-C001": ".product-experience/pdp-0-product-truth/handoff-contracts.yaml#/handoffs/@id=ai-inference-execution/acceptedArtifactReferenceContract",
  "MPSEM-0181-C003": ".product-experience/pdp-0-product-truth/profile-semantics.yaml#streamProfileRule",
  "MPSEM-0288-C002": ".product-experience/pdp-0-product-truth/profile-semantics.yaml#preserveModeSemanticRule",
  "MPSEM-0291-C009": ".product-experience/pdp-0-product-truth/profile-semantics.yaml#bindingProfileRule",
  "MPSEM-0324-C002": ".product-experience/pdp-2-design-interface-system/cli-language.yaml#finiteOperationAliasRule",
  "MPSEM-0472-C003": ".product-experience/pdp-0-product-truth/handoff-contracts.yaml#/handoffs/@id=agent-runtime-media-action/mediaActionOwnershipBoundary",
};
const required = new Map([
  ["MPSEM-0030-C003", ["local deployment eligibility and placement", "AI Inference owns generic inference", "Media owns product intent"]],
  ["MPSEM-0078-C004", ["accepted input kinds", "output kinds and schemas", "cardinality and size/duration bounds", "unsupported combinations"]],
  ["MPSEM-0094-C002", ["AI Inference owns generic inference public contracts", "credential handling", "quota, health", "Media owns product intent", "rights/consent/purpose gates"]],
  ["MPSEM-0100-C001", ["campaign, brand, offer, claim approval", "campaign publication policy and workflow", "Media owns only the admitted composition"]],
  ["MPSEM-0171-C006", ["cancellation request semantics", "authoritative cancellation result/finality", "retry eligibility", "stable request/effect identity", "reconciliation steps for timeout"]],
  ["MPSEM-0171-C001", ["exact artifact kind and schema identity/version", "input/output role and cardinality", "declared size, duration, shape, and format bounds", "owning authority, access scope, purpose", "origin/provenance binding"]],
  ["MPSEM-0181-C003", ["codec, transport", "recording", "reconnect and resumption", "latency bounds", "units", "profile version"]],
  ["MPSEM-0288-C002", ["does not invent or infer semantic detail absent from its source", "even when it is disclosed as generated", "Enhancement and creative modes are distinct"]],
  ["MPSEM-0291-C009", ["steps, guidance, offload, and quantization", "not ordinary user", "requested and effective profile identities", "versions", "authority and reason for every change"]],
  ["MPSEM-0324-C002", ["finite, explicitly enumerated", "canonical creation or composition", "cannot create a new operation", "unknown aliases fail"]],
  ["MPSEM-0472-C003", ["Media defines its public media actions", "Action Plane owns privileged external effects", "Agent Runtime owns agent reasoning/execution"]],
]);
const owners = new Map([
  [".product-experience/pdp-0-product-truth/profile-semantics.yaml", read(".product-experience/pdp-0-product-truth/profile-semantics.yaml")],
  [".product-experience/pdp-0-product-truth/handoff-contracts.yaml", read(".product-experience/pdp-0-product-truth/handoff-contracts.yaml")],
  [".product-experience/pdp-2-design-interface-system/cli-language.yaml", read(".product-experience/pdp-2-design-interface-system/cli-language.yaml")],
]);
function resolveRef(ref) {
  const [path, pointer] = ref.split("#", 2);
  let value = owners.get(path);
  assert.ok(value, `registered source owner exists: ${path}`);
  for (const raw of pointer.split("/").filter(Boolean)) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (segment.startsWith("@id=")) value = value.find((entry) => entry.id === segment.slice(4));
    else value = value?.[segment];
    assert.notEqual(value, undefined, `target path resolves: ${ref}`);
  }
  return value;
}
const claims = migration.pdp38ClaimReconciliation.records.flatMap((record) => record.claims ?? [])
  .flatMap((claim) => claim.subclaims ?? [claim]);
const movedClaims = new Set([...Object.keys(refs), "MPSEM-0469-C001"]);

test("profile and cross-product claims bind the exact complete Media owner rules", () => {
  const moved = claims.filter((claim) => movedClaims.has(claim.claimId)).map((claim) => claim.claimId).sort();
  assert.deepEqual(moved, [...movedClaims].sort(), "the moved-ID partition is complete and has no duplicate/omitted claims");
  for (const [claimId, ref] of Object.entries(refs)) {
    const claim = claims.find((candidate) => candidate.claimId === claimId);
    assert.ok(claim, `claim exists: ${claimId}`);
    assert.equal(claim.targetRef, ref);
    assert.equal(claim.semanticReviewStatus, "CLAIM_SPECIFIC_SEMANTIC_PARITY_VERIFIED");
    assert.equal(claim.semanticReviewRef, `docs/implementation/verification/pdp-38/migration-profile-handoff-source-review.json#/records/@claimId=${claim.claimId}`);
    assert.equal(claim.acceptanceEffect, "none");
    const value = resolveRef(ref);
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    for (const predicate of required.get(claimId)) assert.ok(serialized.includes(predicate), `${claimId} preserves ${predicate}`);
  }
});

test("owner mappings reject loss of material clauses even when the target remains present", () => {
  const changes = [
    ["MPSEM-0030-C003", "local deployment eligibility and placement", "generic deployment ownership omitted"],
    ["MPSEM-0078-C004", "accepted input kinds", "input kinds omitted"],
    ["MPSEM-0078-C004", "output kinds and schemas", "outputs unspecified"],
    ["MPSEM-0094-C002", "quota, health", "health"],
    ["MPSEM-0094-C002", "credential handling", "credential policy omitted"],
    ["MPSEM-0100-C001", "campaign publication policy and workflow", "campaign workflow omitted"],
    ["MPSEM-0171-C006", "authoritative cancellation result/finality", "cancellation omitted"],
    ["MPSEM-0171-C006", "reconciliation steps for timeout or unknown outcome", "retry immediately on timeout"],
    ["MPSEM-0171-C001", "exact artifact kind and schema identity/version", "opaque artifact references only"],
    ["MPSEM-0171-C001", "declared size, duration, shape, and format bounds", "no input/output bounds"],
    ["MPSEM-0181-C003", "reconnect and resumption semantics", "reconnect unsupported"],
    ["MPSEM-0181-C003", "latency bounds", "latency unbounded"],
    ["MPSEM-0291-C009", "requested and effective profile identities", "requested profile identity only"],
    ["MPSEM-0291-C009", "steps, guidance, offload, and quantization", "ordinary settings"],
    ["MPSEM-0324-C002", "cannot create a new operation", "can create operations"],
    ["MPSEM-0472-C003", "Action Plane owns privileged external effects", "Media owns privileged effects"],
    ["MPSEM-0472-C003", "Agent Runtime owns agent reasoning/execution", "Agent Runtime omitted"],
  ];
  for (const [claimId, search, replacement] of changes) {
    const claim = claims.find((candidate) => candidate.claimId === claimId);
    const targetRef = refs[claimId];
    const target = resolveRef(targetRef);
    const serialized = typeof target === "string" ? target : JSON.stringify(target);
    assert.ok(serialized.includes(search), `${claimId} mutation applies: ${search}`);
    const weakened = serialized.replace(search, replacement);
    assert.equal(validateMigrationClaimReview({
      claim,
      expectedTargetRef: targetRef,
      targetValue: weakened,
      requiredPredicates: required.get(claimId),
    }).valid, false, `${claimId} rejects removal of ${search}`);
  }
  const preservedClaim = claims.find((claim) => claim.claimId === "MPSEM-0288-C002");
  const preserveRef = refs[preservedClaim.claimId];
  const preserveRule = resolveRef(preserveRef);
  const preserveText = JSON.stringify(preserveRule);
  const weakenedPreserve = preserveText.replace("does not invent or infer semantic detail absent from its source", "may invent semantic detail absent from source");
  assert.notEqual(weakenedPreserve, preserveText);
  assert.equal(validateMigrationClaimReview({ claim: preservedClaim, expectedTargetRef: preserveRef, targetValue: weakenedPreserve, requiredPredicates: required.get(preservedClaim.claimId) }).valid, false);
});

test("finite alias rule is sourced from the command-language policy and not a product-owner label", () => {
  const claim = claims.find((candidate) => candidate.claimId === "MPSEM-0324-C002");
  assert.equal(resolveRef(refs[claim.claimId]).id, "media.cli.finite-operation-aliases");
  assert.notEqual(claim.targetRef, ".product-experience/pdp-0-product-truth/handoff-contracts.yaml#/handoffs/@id=digital-marketing-creative-brief/destinationOwner");
});

test("the Gharbatai/PHR consumer phrase is only a table label, not an ownership rule", () => {
  const claim = claims.find((candidate) => candidate.claimId === "MPSEM-0469-C001");
  assert.equal(claim.disposition, "NON_NORMATIVE_SOURCE_METADATA");
  assert.deepEqual(claim.metadataFields, ["consumer-owner-table-row-label"]);
  const lines = readFileSync(resolve(root, "docs/migration/expert-reviewed-master-plan.md"), "utf8").split(/\r?\n/u);
  const cells = lines[1154].slice(1, -1).split("|").map((cell) => cell.trim());
  assert.equal(cells.length, 3, "the source table separates owner label, contract, and boundary columns");
  assert.equal(cells[0], "PHR / Gharbatai and document consumers");
  assert.match(cells[1], /Frozen document-extraction and media processing contracts/u);
  assert.match(cells[2], /Consumer discovery is mandatory/u);
});
