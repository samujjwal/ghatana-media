import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { validateMigrationClaimCohort, validateMigrationClaimReview } from "../scripts/lib/pdp-migration-dependency-review.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const parseYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const migrationPath = ".product-experience/pdp-0-product-truth/migration-semantics-review.yaml";
const handoffPath = ".product-experience/pdp-0-product-truth/handoff-contracts.yaml";
const domainPath = ".product-experience/pdp-0-product-truth/domain-model.yaml";
const migration = parseYaml(migrationPath);
const reviewedClaims = new Set(JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/migration-profile-handoff-source-review.json"), "utf8")).records.map(({ claimId }) => claimId));
const handoff = parseYaml(handoffPath);
const domain = parseYaml(domainPath);
const owners = new Map([[handoffPath, handoff], [domainPath, domain]]);
const targets = new Map([
  ["MPSEM-0160-C003", `${handoffPath}#handoffs/@id=kernel-product-lifecycle/batchAndProofBoundary`],
  ["MPSEM-0215-C003", `${domainPath}#proposedRecordCatalog/@id=MediaRecipe/agentRuntimeBoundary/rule`],
  ["MPSEM-0296-C002", `${handoffPath}#ownerDefinedInventoryRule`],
  ["MPSEM-0299-C005", `${handoffPath}#handoffs/@id=kernel-product-lifecycle/batchAndProofBoundary`],
  ["MPSEM-0320-C003", `${handoffPath}#handoffs/@id=ai-inference-execution/requestInputBoundary`],
  ["MPSEM-0322-C002", `${handoffPath}#handoffs/@id=action-plane-publication/actionSelectionRule`],
  ["MPSEM-0352-C007", `${handoffPath}#handoffs/@id=phr-document-client-references/clinicalFeatureBoundary`],
  ["MPSEM-0447-C002", `${handoffPath}#handoffs/@id=tutorputor-governed-media-artifact/reuseSelectionRule`],
  ["MPSEM-0467-C003", `${handoffPath}#handoffs/@id=tutorputor-governed-media-artifact/learningFidelityBoundary`],
  ["MPSEM-0468-C006", `${handoffPath}#handoffs/@id=digital-marketing-creative-brief/campaignPolicyBoundary`],
  ["MPSEM-0469-C004", `${handoffPath}#handoffs/@id=gharbatai-direct-document-intelligence/consumerPreservationBoundary`],
  ["MPSEM-0469-C005", `${handoffPath}#handoffs/@id=phr-document-client-references/clinicalFeatureBoundary`],
  ["MPSEM-0470-C003", `${handoffPath}#handoffs/@id=yappc-product-authoring/implementationImportProhibition`],
]);
const predicates = new Map([
  ["MPSEM-0160-C003", ["Media authors product meaning", "not production proof", "migration alone does not activate a feature", "no Kernel materialization"]],
  ["MPSEM-0215-C003", ["ordinary MediaRecipe", "not an agent-runtime graph", "does not grant agent", "does not itself dispatch work"]],
  ["MPSEM-0296-C002", ["actual route, client operation, transport/proto fields, and external consumer", "scan scope", "does not prove no consumer", "Do not derive an operation"]],
  ["MPSEM-0299-C005", ["existing Media job and operation contracts", "not establish a new generic workflow engine"]],
  ["MPSEM-0320-C003", ["bounded input bytes or immutable authorized artifact references", "explicit capability-specific intent options", "Exact accepted fields", "remain unresolved"]],
  ["MPSEM-0322-C002", ["Version, branch", "exact Action Plane public operation/version", "authorization/delegation", "unsupported actions stay unavailable"]],
  ["MPSEM-0352-C007", ["Missing device/PKCE or identity flows remain owner dependencies", "do not invent an endpoint or credential flow"]],
  ["MPSEM-0447-C002", ["existing Ghatana and TutorPutor collaboration components", "exact public contracts", "CRDT", "retain the dependency gap"]],
  ["MPSEM-0467-C003", ["TutorPutor remains authoritative", "units", "measurements", "accessibility requirements", "unsupported or lossy conversion is disclosed"]],
  ["MPSEM-0468-C006", ["Digital Marketing owns campaign, brand, offer, claim approval", "does not recreate a campaign or brand-policy engine", "permission to publish externally"]],
  ["MPSEM-0469-C004", ["operation identity", "authentication/delegation", "cancellation/finality", "retention", "qualification restrictions", "establish runtime availability"]],
  ["MPSEM-0469-C005", ["clinical or financial interpretation", "feature activation", "owner identity", "retention", "do not invent an endpoint"]],
  ["MPSEM-0470-C003", ["YAPPC private packages", "internal schemas", "implementation modules", "exact public authoring contract"]],
]);

// Source-backed handoff distinctions whose existing owner fields already
// carry narrow semantics are pinned separately from the authored rule cohort
// above. Claims with only a sentence heading or an external-owner fact remain
// open; this list does not turn them into admitted integrations.
const existingOwnerTargets = new Map([
  ["MPSEM-0027-C004", `${handoffPath}#/handoffs/@id=tutorputor-governed-media-artifact/ownerBoundary/0`],
  ["MPSEM-0028-C003", `${handoffPath}#/handoffs/@id=tutorputor-domain-scene/prohibition`],
  ["MPSEM-0093-C002", `${handoffPath}#/handoffs/@id=kernel-product-lifecycle/direction`],
  ["MPSEM-0094-C003", `${handoffPath}#/handoffs/@id=document-intelligence-scene-text/operationAndVersion/authority`],
  ["MPSEM-0096-C002", `${handoffPath}#/handoffs/@id=action-plane-publication/destinationOwner`],
  ["MPSEM-0103-C001", `${handoffPath}#/handoffs/@id=tutorputor-domain-scene/destinationOwner`],
  ["MPSEM-0215-C004", `${handoffPath}#/handoffs/@id=action-plane-publication/direction`],
  ["MPSEM-0467-C001", `${handoffPath}#/handoffs/@id=tutorputor-domain-scene/destinationOwner`],
  ["MPSEM-0468-C001", `${handoffPath}#/handoffs/@id=digital-marketing-creative-brief/direction`],
  ["MPSEM-0468-C003", `${handoffPath}#/handoffs/@id=digital-marketing-creative-brief/sourceOwner`],
  ["MPSEM-0468-C004", `${handoffPath}#/handoffs/@id=digital-marketing-creative-brief/acceptedArtifactReferences`],
  ["MPSEM-0468-C005", `${handoffPath}#/handoffs/@id=action-plane-publication/direction`],
  ["MPSEM-0470-C001", `${handoffPath}#/handoffs/@id=yappc-product-authoring/direction`],
  ["MPSEM-0470-C002", `${handoffPath}#/handoffs/@id=yappc-product-authoring/sourceOwner`],
  ["MPSEM-0471-C001", `${handoffPath}#/handoffs/@id=datacloud-media-compatibility/classificationAndPurpose`],
  ["MPSEM-0471-C003", `${handoffPath}#/handoffs/@id=datacloud-media-compatibility/destinationOwner`],
  ["MPSEM-0472-C001", `${handoffPath}#/handoffs/@id=agent-runtime-media-action/direction`],
  ["MPSEM-0473-C001", `${handoffPath}#/handoffs/@id=kernel-product-lifecycle/direction`],
  ["MPSEM-0473-C003", `${handoffPath}#/handoffs/@id=kernel-product-lifecycle/operationAndVersion`],
]);
const existingOwnerPredicates = new Map([
  ["MPSEM-0027-C004", ["TutorPutor owns Experience IR, Model IR, Scene IR", "pedagogy", "scientific meaning", "assessment"]],
  ["MPSEM-0028-C003", ["Do not import @tutorputor/simulation broad internals", "copy/fork TutorPutor IRs"]],
  ["MPSEM-0093-C002", ["published Kernel lifecycle/shell/provider contract", "deliberately adopted"]],
  ["MPSEM-0094-C003", ["Shared retains @ghatana/document-extraction", "admitted public Document Intelligence boundary"]],
  ["MPSEM-0096-C002", ["Action Plane", "privileged effect authority", "approval", "idempotency", "execution", "reconciliation"]],
  ["MPSEM-0103-C001", ["Media for an explicitly accepted render/animation boundary", "TutorPutor for lesson/experience artifact use"]],
  ["MPSEM-0215-C004", ["authorized external publication effect", "Action Plane"]],
  ["MPSEM-0467-C001", ["Media for an explicitly accepted render/animation boundary", "TutorPutor for lesson/experience artifact use"]],
  ["MPSEM-0468-C001", ["approved brief/brand/claim/copy/asset references", "reviewed output refs"]],
  ["MPSEM-0468-C003", ["Digital Marketing", "brand", "campaign", "offer", "claims", "campaign approval"]],
  ["MPSEM-0468-C004", ["Authorized versioned brand/claim refs", "exact Media output refs only"]],
  ["MPSEM-0468-C005", ["authorized external publication effect", "Action Plane"]],
  ["MPSEM-0470-C001", ["YAPPC public product/capability authoring facility", "only if separately admitted"]],
  ["MPSEM-0470-C002", ["YAPPC", "product metadata/authoring contracts"]],
  ["MPSEM-0471-C001", ["Governed metadata/read-model projection", "scoped search/reference access", "current owner policy and purpose"]],
  ["MPSEM-0471-C003", ["Ghatana Data Cloud", "Media remains artifact/job/stream semantic owner"]],
  ["MPSEM-0472-C001", ["Agent Runtime sends bounded intent/action to Media", "job/result references"]],
  ["MPSEM-0473-C001", ["published Kernel lifecycle/shell/provider contract", "deliberately adopted"]],
  ["MPSEM-0473-C003", ["No adopted Kernel operation/version is established", "does not imply Kernel-native materialization"]],
]);

function resolveRef(ref) {
  const [source, pointer] = ref.split("#", 2);
  let value = owners.get(source);
  assert.ok(value, `owner in handoff claim cohort: ${source}`);
  for (const raw of pointer.split("/").filter(Boolean)) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (segment.startsWith("@id=")) {
      assert.ok(Array.isArray(value), `stable ID selector resolves a list: ${ref}`);
      value = value.find((entry) => entry.id === segment.slice(4));
    } else if (/^\d+$/u.test(segment)) value = value[Number(segment)];
    else value = value?.[segment];
    assert.notEqual(value, undefined, `target resolves: ${ref}`);
  }
  return value;
}
const claims = () => migration.pdp38ClaimReconciliation.records.flatMap((record) => record.claims ?? []).flatMap((claim) => claim.subclaims ?? [claim]);

test("the finite cross-product handoff cohort binds exact owner clauses and claim-level hashes", () => {
  const rows = claims().filter((claim) => targets.has(claim.claimId));
  const result = validateMigrationClaimCohort({ claims: rows, expectedTargets: targets, resolveRef, predicatesByClaim: predicates });
  assert.deepEqual(result.errors, []);
  assert.equal(rows.length, targets.size);
  for (const claim of rows) {
    const approved = reviewedClaims.has(claim.claimId);
    assert.equal(claim.semanticReviewStatus, approved ? "CLAIM_SPECIFIC_SEMANTIC_PARITY_VERIFIED" : "OWNER_TARGET_LOCATOR_ONLY_PENDING_CLAIM_PARITY", claim.claimId);
    if (approved) assert.equal(claim.semanticReviewRef, `docs/implementation/verification/pdp-38/migration-profile-handoff-source-review.json#/records/@claimId=${claim.claimId}`);
    assert.equal(claim.acceptanceEffect, "none", claim.claimId);
  }
});

test("handoff owner clauses reject invented contracts, missing authority and lossy fidelity", () => {
  const mutations = [
    ["MPSEM-0296-C002", "Do not derive an operation", "Derive operation names by similarity"],
    ["MPSEM-0215-C003", "not an agent-runtime graph", "is an agent-runtime graph"],
    ["MPSEM-0320-C003", "remain unresolved", "are admitted"],
    ["MPSEM-0322-C002", "unsupported actions stay unavailable", "unsupported actions are inferred"],
    ["MPSEM-0352-C007", "do not invent an endpoint", "invent an endpoint"],
    ["MPSEM-0447-C002", "retain the dependency gap", "silently add a new integration"],
    ["MPSEM-0467-C003", "unsupported or lossy conversion is disclosed", "lossy conversion is hidden"],
    ["MPSEM-0468-C006", "does not recreate a campaign or brand-policy", "recreates a campaign or brand-policy"],
    ["MPSEM-0469-C004", "or establish runtime availability", "or assert runtime availability"],
    ["MPSEM-0470-C003", "do not import YAPPC private packages", "import YAPPC private packages"],
  ];
  for (const [claimId, search, replacement] of mutations) {
    const claim = claims().find((row) => row.claimId === claimId);
    const targetRef = targets.get(claimId);
    const value = resolveRef(targetRef);
    const source = typeof value === "string" ? value : JSON.stringify(value);
    const weakened = source.replace(search, replacement);
    assert.notEqual(weakened, source, `mutation applies: ${claimId}`);
    assert.equal(validateMigrationClaimReview({ claim, expectedTargetRef: targetRef, targetValue: weakened, requiredPredicates: predicates.get(claimId) }).valid, false, claimId);
  }
});

test("remaining source-backed handoff roles preserve exact owners and admitted public boundaries", () => {
  const rows = claims().filter((claim) => existingOwnerTargets.has(claim.claimId));
  const result = validateMigrationClaimCohort({
    claims: rows,
    expectedTargets: existingOwnerTargets,
    resolveRef,
    predicatesByClaim: existingOwnerPredicates,
  });
  assert.deepEqual(result.errors, []);
  assert.equal(rows.length, existingOwnerTargets.size);
  for (const claim of rows) {
    const approved = reviewedClaims.has(claim.claimId);
    assert.equal(claim.semanticReviewStatus, approved ? "CLAIM_SPECIFIC_SEMANTIC_PARITY_VERIFIED" : "OWNER_TARGET_LOCATOR_ONLY_PENDING_CLAIM_PARITY", claim.claimId);
    if (approved) assert.equal(claim.semanticReviewRef, `docs/implementation/verification/pdp-38/migration-profile-handoff-source-review.json#/records/@claimId=${claim.claimId}`);
    assert.equal(claim.acceptanceEffect, "none", claim.claimId);
  }
});

test("cross-product owner and boundary clauses reject role substitution and implicit admission", () => {
  for (const [claimId, targetRef] of existingOwnerTargets) {
    const claim = claims().find((row) => row.claimId === claimId);
    const target = resolveRef(targetRef);
    const text = typeof target === "string" ? target : JSON.stringify(target);
    const predicate = existingOwnerPredicates.get(claimId)[0];
    const weakened = text.replace(predicate, `UNOWNED_OR_UNADMITTED_${claimId}`);
    assert.notEqual(weakened, text, `${claimId} material mutation applies`);
    assert.equal(validateMigrationClaimReview({
      claim,
      expectedTargetRef: targetRef,
      targetValue: weakened,
      requiredPredicates: existingOwnerPredicates.get(claimId),
    }).valid, false, claimId);
  }
});
