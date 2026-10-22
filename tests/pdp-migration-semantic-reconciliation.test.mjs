import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fingerprint, fingerprintPxdDecisionSection } from "../scripts/lib/pdp0-phase-scoped-source-fingerprints.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const reviewPath = ".product-experience/pdp-0-product-truth/migration-semantics-review.yaml";
const candidatePhase = process.env.PDP_MIGRATION_CANDIDATE_PHASE ?? "ALL";
if (!["ALL", "PDP-0"].includes(candidatePhase)) throw new Error(`PDP_MIGRATION_CANDIDATE_PHASE must be ALL or PDP-0; got ${candidatePhase}`);
const p0Only = candidatePhase === "PDP-0";
const downstreamOwner = (ref) => /\/pdp-[1-3]-|authority-map\.yaml#(?:\/)?phaseAuthorities\/(?:[1-3])(?:\/|$)/u.test(ref ?? "");
const nonPdp0Owner = (ref) => downstreamOwner(ref) || /^\.product-experience\/acceptance\.yaml#/u.test(ref ?? "");
const yamlCache = new Map();
const readYaml = (path) => {
  if (!yamlCache.has(path)) yamlCache.set(path, parse(readFileSync(resolve(root, path), "utf8")));
  return yamlCache.get(path);
};
const sha = (text) => createHash("sha256").update(text).digest("hex");
const normalizedWhitespace = (text) => text.replace(/\s+/gu, " ").trim();
const pendingObservationBytes = readFileSync(resolve(root, "docs/implementation/verification/pdp-38/pending-locator-current-source-observations.json"));
assert.equal(sha(pendingObservationBytes), "eff17d84f91e1e14483f41938fe0fd39bb6e5a9db5c227163e92de1f90e02aec", "exact bounded PXD-108 observation artifact");
const pendingObservations = JSON.parse(pendingObservationBytes);
assert.equal(pendingObservations.decisionRef, ".product-experience/decision-log.md#PXD-108");
assert.deepEqual(pendingObservations.records.map(({ claimId }) => claimId), ["MPSEM-0030-C001", "MPSEM-0187-C002", "MPSEM-0336-C006", "MPSEM-0349-C001", "MPSEM-0351-C001"]);
const currentTargetObservationBytes = readFileSync(resolve(root, "docs/implementation/verification/pdp-38/migration-current-owner-target-observations.json"));
assert.equal(sha(currentTargetObservationBytes), "505bdc5609f02efc3bf2b1d550de3959c78dceee95821034665629194948f0e5", "bounded current-owner target observations");
const currentTargetObservations = JSON.parse(currentTargetObservationBytes);
const migrationP0CurrentSourceObservations = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/migration-p0-current-source-observations.json"), "utf8"));
const migrationOverlayCurrentOwnerObservations = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/migration-overlay-current-owner-observations.json"), "utf8"));
const migrationPxd153CurrentSourceObservations = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/migration-p0-pxd153-current-source-observations.json"), "utf8"));
const migrationPxd173Successor = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/pdp0-migration-current-source-successor-pxd173.json"), "utf8"));
const migrationPxd183Successor = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/pdp0-migration-current-source-successor-pxd183.json"), "utf8"));
const migrationPxd185Successor = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/pdp0-migration-current-source-successor-pxd185.json"), "utf8"));
const migrationPxd196Successor = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/pdp0-migration-current-source-successor-pxd196.json"), "utf8"));
const migrationPxd210CurrentSourceReconciliation = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd210.json"), "utf8"));
const migrationPxd211RouteSuccessor = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/pdp0-current-semantic-route-successor-pxd211.json"), "utf8"));
const migrationPxd214Path = "docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd214.json";
const migrationCoordinatorReview = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/migration-coordinator-review-112.json"), "utf8"));
const migration199OwnerCandidate = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/truth-domain-pdp0-pdp1-owner-candidate-199.json"), "utf8"));
assert.equal(migrationP0CurrentSourceObservations.decisionRef, ".product-experience/decision-log.md#PXD-130");


function resolveRef(ref) {
  const [path, pointer] = ref.split("#", 2);
  if (path.endsWith(".md")) {
    assert.ok(pointer, `${ref}: Markdown owner reference needs an anchor`);
    const source = readFileSync(resolve(root, path), "utf8");
    if (/^line=\d+$/u.test(pointer)) {
      const line = source.split(/\r?\n/u)[Number(pointer.slice(5)) - 1];
      assert.ok(line, `${ref}: historical source line must exist`);
      return line;
    }
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

function readPxd214Successor() {
  try {
    return JSON.parse(readFileSync(resolve(root, migrationPxd214Path), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") assert.fail(`PXD-214 current-source successor is required: ${migrationPxd214Path}`);
    throw error;
  }
}

function collectStringValues(value, values = []) {
  if (typeof value === "string") values.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStringValues(item, values);
  else if (value && typeof value === "object") for (const item of Object.values(value)) collectStringValues(item, values);
  return values;
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

function assertPdp1CurrentLocatorObservation(claim, observation) {
  assert.ok(observation, `${claim.claimId} needs an additive PDP-1 current-locator observation`);
  assert.equal(claim.claimId, "MPSEM-0270-C001");
  assert.equal(observation.claimId, claim.claimId);
  assert.equal(observation.ownerPhase, "PDP-1");
  assert.match(observation.targetRef ?? "", /^\.product-experience\/pdp-1-domain-data\//u,
    "the observed locator must remain owned by PDP-1");
  assert.match(observation.handoff ?? "", /PDP-1 owner phase/u,
    "the record must hand semantic assessment to PDP-1");
  assert.equal(observation.historicalTargetValueSha256, claim.targetTextSha256,
    "the historical claim target pin remains unchanged");
  assert.equal(observation.currentTargetValueSha256, sha(JSON.stringify(resolveRef(observation.targetRef))));
  assert.equal(observation.currentSourceFileSha256,
    sha(readFileSync(resolve(root, observation.targetRef.split("#")[0]))));
  assert.equal(observation.semanticEquivalence, "NOT_ASSERTED");
  assert.equal(observation.acceptanceEffect, "none");
}

function assertClaimDisposition(claim) {
  if (claim.disposition === "NON_NORMATIVE_SOURCE_METADATA") {
    if (claim.claimId === "MPSEM-0001-C001") {
      assert.deepEqual(claim.metadataFields, ["document-id", "review-date", "document-status"]);
    } else if (claim.claimId === "MPSEM-0030-C001") {
      assert.deepEqual(claim.metadataFields, ["finding-id-and-summary-label"]);
      assert.equal(claim.sourceEvidenceRef, "docs/migration/expert-reviewed-master-plan.md#L106");
      assert.match(claim.rationale, /first-cell REV-10 finding label.*MPSEM-0030-C003 and C004/u);
    } else if (claim.claimId === "MPSEM-0034-C001") {
      assert.deepEqual(claim.metadataFields, ["finding-id-and-summary-label"]);
      assert.equal(claim.sourceEvidenceRef, "docs/migration/expert-reviewed-master-plan.md#L113");
      assert.match(claim.rationale, /first-cell REV-14 finding label.*C002-C004/u);
    } else if (claim.claimId === "MPSEM-0035-C001") {
      assert.deepEqual(claim.metadataFields, ["table-row-heading"]);
      assert.equal(claim.sourceEvidenceRef, "docs/migration/expert-reviewed-master-plan.md#L114");
      assert.match(claim.rationale, /first column .*review row/u);
    } else if (claim.claimId === "MPSEM-0032-C001") {
      assert.deepEqual(claim.metadataFields, ["table-row-heading"]);
      assert.equal(claim.sourceEvidenceRef, "docs/migration/expert-reviewed-master-plan.md#L111");
      assert.match(claim.rationale, /REV-12 heading is a table label only.*C002-C004 remain normative/u);
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
  if (claim.claimId === "MPSEM-0256-C001") {
    const currentRouteRef = ".product-experience/pdp-0-product-truth/time-units-fidelity.yaml#/productTruthClockDomains";
    assert.equal(claim.targetRef, currentRouteRef, "the active ledger route maps media/output presentation to the story clock");
    const coordinatorRoute = migrationCoordinatorReview.records.find(({ claimId }) => claimId === claim.claimId);
    assert.ok(coordinatorRoute, "the active coordinator route remains present");
    assert.equal(coordinatorRoute.currentTargetRef, currentRouteRef, "the coordinator current route maps to the story clock");
    assert.equal(coordinatorRoute.coordinatorReviewStatus, claim.coordinatorReviewStatus, "the existing coordinator review state is preserved");
    assert.equal(coordinatorRoute.acceptanceEffect, "none", "route correction does not claim owner acceptance");
    const domainDefinition = resolveRef(currentRouteRef);
    assert.deepEqual(domainDefinition.domainIds, [
      "source_video_presentation_time", "audio_sample_time", "story_explanation_time",
      "simulation_execution_time", "wall_clock_time",
    ]);
    assert.match(domainDefinition.status, /PDP-0 product meaning/u);
    assert.match(domainDefinition.domainIdentityRule, /five identifiers are the complete product clock set/u);
    assert.match(domainDefinition.domainIdentityRule, /Editorial and output presentation use story\/explanation time/u);
    assert.match(domainDefinition.domainIdentityRule, /decode timestamps remain source-stream ordering metadata, not an additional product clock/u);
  }
  if (p0Only && nonPdp0Owner(claim.targetRef)) {
    assert.equal(claim.acceptanceEffect, "none");
    if (claim.targetRef.startsWith(".product-experience/acceptance.yaml#")) {
      assert.match(claim.targetTextSha256, /^[a-f0-9]{64}$/u,
        "the exact acceptance-owner locator remains recorded");
      const observation = migrationOverlayCurrentOwnerObservations.records.find((record) => record.claimId === claim.claimId);
      if (observation) {
        assert.equal(observation.targetRef, claim.targetRef);
        assert.match(observation.historicalTargetValueSha256, /^[a-f0-9]{64}$/u,
          "the former acceptance-owner value remains historical provenance");
        assert.equal(observation.semanticEquivalence, "NOT_ASSERTED");
        assert.equal(observation.acceptanceEffect, "none");
      }
    }
    if (claim.claimId === "MPSEM-0270-C001") {
      const overlayObservation = migrationOverlayCurrentOwnerObservations.records.find((record) => record.claimId === claim.claimId);
      assertPdp1CurrentLocatorObservation(claim, overlayObservation);
      assert.equal(overlayObservation.targetRef, claim.targetRef,
        "the PDP-1 handoff observation must match this claim's exact locator");
    }
    return; // Keep the all-row disposition/source census, but defer downstream owner semantics to that phase.
  }
  const target = resolveRef(claim.targetRef);
  const targetText = typeof target === "string" ? target : JSON.stringify(target);
  const targetDigest = claim.claimId === "MPSEM-0172-C002"
    ? fingerprint(target)
    : claim.coordinatorReviewStatus === "APPROVED_BOUNDED_OWNER_SOURCE_SEMANTIC_ROUTE" && !claim.targetRef.includes(".md#line=")
    ? sha(JSON.stringify(target))
    : sha(targetText);
  if (claim.claimId === "MPSEM-0172-C002") {
    const successor = migrationPxd211RouteSuccessor.records.find(({ claimId }) => claimId === claim.claimId);
    const currentRoute = readYaml(reviewPath).pdp38ClaimReconciliation.pxd211CurrentRouteSuccessors.records.find(({ claimId }) => claimId === claim.claimId);
    assert.ok(successor && currentRoute, "PXD-211 historical route record and its retained source entry exist");
    assert.equal(claim.targetRef, successor.current.targetRef);
    assert.equal(claim.currentRouteSuccessorRef,
      ".product-experience/pdp-0-product-truth/migration-semantics-review.yaml#/pdp38ClaimReconciliation/pxd211CurrentRouteSuccessors/records/@claimId=MPSEM-0172-C002");
    assert.equal(currentRoute.targetRef, claim.targetRef);
    assert.match(successor.current.targetValueSha256, /^[a-f0-9]{64}$/u,
      "PXD-211 keeps its selected-target digest as historical evidence");
    assert.equal(currentRoute.historicalTargetRef, successor.predecessor.historicalTargetRef,
      "the former multimodal outcome locator remains predecessor history");
    assert.match(currentRoute.historicalTargetValueSha256, /^[a-f0-9]{64}$/u,
      "the latest prior-source observation pin remains historical");
    assert.match(successor.predecessor.historicalTargetValueSha256, /^[a-f0-9]{64}$/u,
      "the original outcome value pin remains historical");
    assert.match(successor.predecessor.pxd210SelectedTargetSha256, /^[a-f0-9]{64}$/u,
      "the PXD-210 selected target pin remains historical");
    assert.equal(currentRoute.ownerApproval, "NOT_CLAIMED");
    assert.equal(currentRoute.acceptanceEffect, "none");
    assert.equal(claim.acceptanceEffect, "none");
    assertHighRiskMigrationSemantics(claim);
    return;
  }
  const pendingObservation = pendingObservations.records.find(({ claimId }) => claimId === claim.claimId);
  if (pendingObservation) {
    assert.equal(claim.semanticReviewStatus, "OWNER_TARGET_LOCATOR_ONLY_PENDING_CLAIM_PARITY");
    assert.equal(pendingObservation.disposition, "PENDING_LOCATOR_CURRENT_SOURCE_OBSERVATION_ONLY");
    assert.equal(pendingObservation.semanticEquivalence, "NOT_ASSERTED");
    assert.equal(pendingObservation.acceptanceEffect, "none");
    assert.equal(claim.targetRef, pendingObservation.targetRef);
    assert.equal(claim.targetTextSha256, pendingObservation.priorHash, "immutable historical locator digest remains unchanged");
    const p0Supplement = migrationP0CurrentSourceObservations.records.find((record) => record.claimId === claim.claimId);
    if (p0Supplement) {
      assert.equal(p0Supplement.historicalPxd108ObservationArtifactSha256, sha(pendingObservationBytes), "PXD-108 snapshot remains byte-pinned");
      assert.equal(p0Supplement.historicalPxd108CurrentTargetSha256, pendingObservation.currentHash);
      assert.equal(p0Supplement.historicalPxd108SourceFileSha256, pendingObservation.sourceFileSha256);
      assert.equal(targetDigest, p0Supplement.currentTargetValueSha256, "PXD-130 additive current target observation is exact");
    } else {
      assert.equal(targetDigest, pendingObservation.currentHash, "current observed locator bytes remain exact");
    }
    const currentSourceFileSha = sha(readFileSync(resolve(root, claim.targetRef.split("#")[0])));
    if (p0Supplement) {
      assert.match(p0Supplement.currentSourceFileSha256, /^[a-f0-9]{64}$/u,
        `${claim.claimId} PXD-130 source fingerprint remains a recorded historical observation`);
    } else {
      assert.equal(currentSourceFileSha, pendingObservation.currentSourceFileSha256 ?? pendingObservation.sourceFileSha256);
    }
    if (pendingObservation.currentSourceFileSha256) {
      const historicalFilePin = claim.targetRef.includes("/capabilities.yaml#")
        ? "f03fb72b7a3f1c8bb74d61a7dad101125c9dc1a1d4837d9cd2d8587446c04f1c"
        : claim.targetRef.includes("/quality-policy.yaml#")
          ? "2fcb91b7b5adb57d72775584bc56d4a40c50697f737bbfddf27f920d36bfe86e"
          : assert.fail(`${claim.claimId} has no reviewed historical current-source pin`);
      assert.equal(pendingObservation.sourceFileSha256, historicalFilePin, "immutable historical source file pin");
      if (claim.targetRef.includes("/capabilities.yaml#")) {
        assert.match(pendingObservation.currentSourceFileRationale, /ownerDefinedCapabilityIntentBinding/u);
        assert.match(pendingObservation.currentSourceFileRationale, /Concrete operation and wire mappings are downstream PDP-1/u);
      } else {
        assert.match(pendingObservation.currentSourceFileRationale, /ownerQualityApplicabilityCrosswalk/u);
        assert.match(pendingObservation.currentSourceFileRationale, /payload-schema dependencies on PDP-1 operation contracts/u);
      }
      assert.match(pendingObservation.currentSourceFileRationale, /does not (establish|assert) semantic equivalence/u);
      assert.equal(pendingObservation.semanticEquivalence, "NOT_ASSERTED");
      assert.equal(pendingObservation.acceptanceEffect, "none");
    }
  } else {
    const currentSourceObservation = migrationP0CurrentSourceObservations.records.find((record) => record.claimId === claim.claimId);
    if (currentSourceObservation) {
      assert.equal(currentSourceObservation.targetRef, claim.targetRef);
      assert.match(currentSourceObservation.previousObservedTargetValueSha256, /^[a-f0-9]{64}$/u, "prior target digest is preserved as an observation");
      const pxd153Observation = migrationPxd153CurrentSourceObservations.records.find((record) => record.claimId === claim.claimId);
      if (pxd153Observation) {
        assert.equal(pxd153Observation.targetRef, claim.targetRef);
        assert.equal(pxd153Observation.historicalPxd130CurrentSourceFileSha256,
          currentSourceObservation.supersededCurrentSourceFileSha256 ?? currentSourceObservation.currentSourceFileSha256);
        assert.equal(pxd153Observation.historicalPxd130CurrentTargetValueSha256, currentSourceObservation.currentTargetValueSha256);
        assert.equal(pxd153Observation.currentSourceFileSha256,
          migrationPxd173Successor.sourceFingerprints[claim.targetRef.split("#")[0]],
          "PXD-153 source pin is preserved at the PXD-173 successor source cut");
        assert.equal(pxd153Observation.currentTargetValueSha256, targetDigest);
        assert.equal(pxd153Observation.semanticEquivalence, "NOT_ASSERTED");
        assert.equal(pxd153Observation.acceptanceEffect, "none");
      } else {
        assert.equal(currentSourceObservation.currentTargetValueSha256, targetDigest, "current target bytes are observed exactly");
        if (claim.claimId === "MPSEM-0291-C003") {
          const reconciliation = migrationPxd210CurrentSourceReconciliation.records.find(({ recordId }) => recordId === "PXD-130:MPSEM-0291-C003:117");
          assert.ok(reconciliation, "PXD-210 contains the exact current-source refresh");
          assert.equal(reconciliation.claimId, claim.claimId);
          assert.equal(reconciliation.selectorRef, claim.targetRef);
          assert.equal(reconciliation.predecessorRawSourceSha256, currentSourceObservation.currentSourceFileSha256,
            "PXD-130 source-file fingerprint remains the predecessor pin");
          assert.equal(reconciliation.currentRawSourceSha256,
            sha(readFileSync(resolve(root, claim.targetRef.split("#")[0]))), "PXD-210 refresh matches the live source file");
          assert.equal(reconciliation.selectorEquality, true);
          assert.equal(reconciliation.predecessorProjectionSha256, currentSourceObservation.currentTargetValueSha256);
          assert.equal(reconciliation.currentProjectionSha256, targetDigest,
            "current projection hash matches the claim's resolved target projection");
          assert.equal(reconciliation.semanticEquivalence, "NOT_ASSERTED");
          assert.equal(reconciliation.ownerApproval, "NOT_CLAIMED");
          assert.equal(reconciliation.acceptanceEffect, "none");
        } else {
          assert.equal(currentSourceObservation.currentSourceFileSha256, sha(readFileSync(resolve(root, claim.targetRef.split("#")[0]))));
        }
      }
      assert.equal(currentSourceObservation.claimDisposition, claim.semanticReviewStatus);
      if (currentSourceObservation.claimDisposition === "OWNER_TARGET_LOCATOR_ONLY_PENDING_CLAIM_PARITY")
        assert.equal(claim.semanticReviewStatus, "OWNER_TARGET_LOCATOR_ONLY_PENDING_CLAIM_PARITY");
      assert.equal(currentSourceObservation.semanticEquivalence, "NOT_ASSERTED");
      assert.equal(currentSourceObservation.semanticPromotion, false);
      assert.equal(currentSourceObservation.acceptanceEffect, "none");
    } else {
      const overlayObservation = migrationOverlayCurrentOwnerObservations.records.find((record) => record.claimId === claim.claimId);
      if (overlayObservation) {
        assert.equal(overlayObservation.targetRef, claim.targetRef);
        assert.match(overlayObservation.historicalTargetValueSha256, /^[a-f0-9]{64}$/u, "historical overlay target pin remains recorded");
        assert.equal(overlayObservation.currentTargetValueSha256, targetDigest, "additive current-owner bytes are exact");
        assert.equal(overlayObservation.currentSourceFileSha256, sha(readFileSync(resolve(root, claim.targetRef.split("#")[0]))));
        assert.equal(overlayObservation.semanticEquivalence, "NOT_ASSERTED");
        assert.equal(overlayObservation.acceptanceEffect, "none");
        if (claim.claimId === "MPSEM-0303-C002") {
          assert.equal(overlayObservation.previousObservedCurrentSourceFileSha256,
            "792f8ee0fe09096d68a6fa92065b56423d192b0b7445fac0408a9d73f61d7ac5",
            "the former PDP-1 raw-source pin is preserved as an observation");
          assert.equal(overlayObservation.currentSourceFileSha256,
            "7495821ea1a05ad6631f57d49722e5653bde93b416cf6f1c47d89fd6f66b5dee",
            "the current PDP-1 raw-source pin is exact");
          assert.equal(overlayObservation.currentTargetValueSha256, "d5f6f00dfde6fb8eaef4ea064b65016216fc5db44791b627adcf5dceb1c483e0",
            "the selected operation projection is unchanged");
          assert.equal(overlayObservation.semanticEquivalence, "NOT_ASSERTED");
          assert.equal(overlayObservation.acceptanceEffect, "none");
        }
        if (claim.claimId === "MPSEM-0450-C002") {
          assert.equal(claim.targetRef,
            ".product-experience/pdp-2-design-interface-system/gui/patterns/activity-attention.yaml#ownerDefinedAttentionNotificationScope",
            "the corrected notification claim points to its exact PDP-2 owner source");
          assert.equal(claim.semanticReviewStatus, "OWNER_TARGET_LOCATOR_ONLY_PENDING_CLAIM_PARITY");
          assert.equal(claim.coordinatorReviewStatus, "PENDING");
          assert.equal(overlayObservation.historicalTargetValueSha256,
            "84f80a8cd1ddae2196bbdeb1ac1af86ca63fd23a0f7c5086a9ef2fb8c6eb3fe8",
            "the unrelated former target pin remains historical");
          assert.equal(overlayObservation.currentTargetValueSha256,
            "19906b4f4255cc5371d168f00a118c9b425ba18f8ae9a3a4ebad326b80160737",
            "the exact current PDP-2 attention-scope bytes are observed");
          assert.equal(overlayObservation.semanticEquivalence, "NOT_ASSERTED");
          assert.equal(overlayObservation.acceptanceEffect, "none");
        }
        if (claim.semanticReviewStatus === "OWNER_TARGET_LOCATOR_ONLY_PENDING_CLAIM_PARITY") {
          assert.equal(overlayObservation.historicalTargetValueSha256, claim.targetTextSha256, "pending route retains its historical target pin");
          if (claim.claimId === "MPSEM-0270-C001") {
            assert.equal(claim.targetTextSha256, "b8550da2b1500f74f3371128f5b4849e0bbb405965d27a8d4429d6328120fe51",
              "the former reviewed semantic target remains a historical pin");
            assert.equal(overlayObservation.historicalTargetValueSha256, claim.targetTextSha256);
            assert.equal(overlayObservation.currentTargetValueSha256, "be781aa5be9ca23ac0603980e9aa25104123579a6d316b0077228bb4f7919b65",
              "the changed PDP-1 value is pinned only as current bytes");
            assert.equal(overlayObservation.semanticEquivalence, "NOT_ASSERTED");
            assert.equal(claim.coordinatorReviewStatus, "PENDING");
            assert.equal(overlayObservation.acceptanceEffect, "none");
            const coordinatorRoute = migrationCoordinatorReview.records.find(({ claimId }) => claimId === claim.claimId);
            assert.equal(coordinatorRoute.currentTargetValueSha256, overlayObservation.currentTargetValueSha256);
            assert.equal(coordinatorRoute.supersededCurrentTargetValueSha256, claim.targetTextSha256);
            assert.equal(coordinatorRoute.supersededSemanticReviewStatus, "CLAIM_SPECIFIC_SEMANTIC_PARITY_VERIFIED");
            assert.equal(coordinatorRoute.supersededCoordinatorReviewStatus, "APPROVED_BOUNDED_OWNER_SOURCE_SEMANTIC_ROUTE");
            assert.equal(coordinatorRoute.acceptanceEffect, "none");
          }
        } else if (claim.coordinatorReviewStatus === "APPROVED_BOUNDED_OWNER_SOURCE_SEMANTIC_ROUTE") {
          assert.equal(claim.targetTextSha256, targetDigest, "approved bounded route records the exact reviewed current target");
        } else if (claim.semanticReviewStatus === "CLAIM_SPECIFIC_SEMANTIC_PARITY_VERIFIED") {
          assert.equal(overlayObservation.historicalTargetValueSha256, claim.targetTextSha256, "verified route preserves the target digest from its reviewed source cut");
        } else assert.fail(`${claim.claimId} overlay observation has no recognized review status`);
      } else {
        const pxd173Observations = migrationPxd173Successor.records.filter((record) => record.claimId === claim.claimId);
        const pxd183Observations = migrationPxd183Successor.records.filter((record) => record.claimId === claim.claimId);
        const pxd185Observations = migrationPxd185Successor.records.filter((record) => record.claimId === claim.claimId);
        if (pxd173Observations.some(({ observationId }) => observationId === "P0-MIGRATION-CURRENT-029")) {
          assert.equal(claim.semanticReviewStatus, "OWNER_TARGET_LOCATOR_ONLY_PENDING_CLAIM_PARITY");
          const ownerCandidateRecord = migration199OwnerCandidate.records.find((record) => record.claimId === claim.claimId);
          assert.ok(ownerCandidateRecord, `${claim.claimId} current PDP-0 owner candidate remains present`);
          assert.equal(ownerCandidateRecord.semanticDisposition, "CLAIM_SPECIFIC_PARITY_NOT_YET_VERIFIED");
          assert.match(ownerCandidateRecord.materialGap, /bounded PDP-0 parent-cancellation definition is now authored/u);
          assert.match(ownerCandidateRecord.materialGap, /Claim-specific semantic parity .* remains unverified/u);
          assert.equal(ownerCandidateRecord.currentProposalObservation.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
          assert.equal(ownerCandidateRecord.ownerSemanticReview.acceptanceEffect, "none");
          assert.deepEqual(pxd173Observations.map(({ observationId }) => observationId), [
            "P0-MIGRATION-CURRENT-029",
            "P0-MIGRATION-CURRENT-030",
          ]);
          assert.equal(migrationPxd173Successor.decisionRef, ".product-experience/decision-log.md#PXD-173");
          assert.equal(migrationPxd183Successor.decisionRef, ".product-experience/decision-log.md#PXD-183");
          assert.equal(migrationPxd185Successor.decisionRef, ".product-experience/decision-log.md#PXD-185");
          assert.equal(pxd183Observations.length, 2, "PXD-183 adds a current successor for both parent-cancellation source observations");
          assert.equal(pxd185Observations.length, 2, "PXD-185 preserves a later current successor for both parent-cancellation source observations");
          const currentSourceFileSha256 = sha(readFileSync(resolve(root, claim.targetRef.split("#")[0])));
          const currentThen = resolveRef(claim.targetRef);
          for (const observation of pxd173Observations) {
            assert.equal(observation.targetRef, claim.targetRef);
            assert.equal(observation.predecessorCurrentTargetValueSha256, claim.targetTextSha256,
              "successor preserves the immutable historical target digest");
            assert.equal(observation.currentTargetValueSha256, targetDigest, "successor records exact live target bytes");
            assert.equal(observation.currentSourceFileSha256, "af774f4db0a306ac3514475d65170560c345e7a6ecdf17305edb2ac3b9af41fe",
              "PXD-173 source-file observation remains immutable history");
            assert.equal(observation.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
            assert.equal(observation.semanticEquivalence, "NOT_ASSERTED");
            assert.equal(observation.semanticPromotion, false);
            assert.equal(observation.acceptanceEffect, "none");
          }
          for (const observation of pxd183Observations) {
            assert.equal(observation.targetRef, claim.targetRef);
            const prior = pxd173Observations.find((entry) => entry.sourceRecordRef === observation.sourceRecordRef);
            assert.equal(observation.predecessorCurrentSourceFileSha256, prior?.currentSourceFileSha256);
            assert.equal(observation.predecessorCurrentTargetValueSha256, prior?.currentTargetValueSha256);
            const successor = pxd185Observations.find((entry) => entry.sourceRecordRef === observation.sourceRecordRef);
            assert.equal(successor?.predecessorCurrentSourceFileSha256, observation.currentSourceFileSha256,
              "PXD-185 preserves the PXD-183 current source file as history");
            assert.equal(successor?.predecessorCurrentTargetValueSha256, observation.currentTargetValueSha256,
              "PXD-185 preserves the PXD-183 current target value as history");
            assert.equal(observation.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
            assert.equal(observation.semanticEquivalence, "NOT_ASSERTED");
            assert.equal(observation.semanticPromotion, false);
            assert.equal(observation.acceptanceEffect, "none");
          }
          for (const observation of pxd185Observations) {
            assert.equal(observation.targetRef, claim.targetRef);
            assert.equal(observation.currentSourceFileSha256,
              migrationPxd185Successor.sourceFingerprints[claim.targetRef.split("#", 1)[0]],
              "PXD-185 preserves its historical source-file pin");
            assert.equal(observation.currentTargetValueSha256, targetDigest,
              "the unchanged target selector still resolves to the same exact target bytes");
            assert.equal(observation.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
            assert.equal(observation.semanticEquivalence, "NOT_ASSERTED");
            assert.equal(observation.semanticPromotion, false);
            assert.equal(observation.acceptanceEffect, "none");
          }
          const materialObservation = pxd183Observations.find(({ requiredSourcePhrase }) => requiredSourcePhrase !== null);
          assert.equal(materialObservation.requiredSourcePhrase, currentThen,
            "material observation phrase matches the exact current PDP-0 clause");
          assert.equal(pxd173Observations.find(({ observationId }) => observationId === "P0-MIGRATION-CURRENT-029").requiredSourcePhrase, null);
        } else {
          assert.equal(claim.targetTextSha256, targetDigest, `${claim.claimId} target content changed without semantic review`);
        }
      }
    }
  }
  assert.equal(claim.acceptanceEffect, "none");
  assertHighRiskMigrationSemantics(claim);
  if (claim.claimId.startsWith("MPSEM-0456-C")) assertLicenseSemantics(claim);
  if (claim.claimId.startsWith("MPSEM-0460-C")) assertAdapterSequencingSemantics(claim);
}

test("PXD-196 and PXD-211 remain immutable historical predecessors", () => {
  const pxd196Path = "docs/implementation/verification/pdp-38/pdp0-migration-current-source-successor-pxd196.json";
  const pxd211Path = "docs/implementation/verification/pdp-38/pdp0-current-semantic-route-successor-pxd211.json";
  const decisionLogText = readFileSync(resolve(root, ".product-experience/decision-log.md"), "utf8");
  assert.equal(sha(readFileSync(resolve(root, pxd196Path))), "d5a7c9e854c77bf9e1e506f374f69f66d1cacd0097bcce87e71af4d544f6be2f",
    "PXD-196 artifact bytes remain immutable historical evidence");
  assert.equal(sha(readFileSync(resolve(root, pxd211Path))), "aa4ec6eb60e73af1b7e65adb576e482461cecc783711d935d73fe381ab87affd",
    "PXD-211 artifact bytes remain immutable historical evidence");
  assert.equal(fingerprintPxdDecisionSection(decisionLogText, "PXD-196").sha256,
    "279837dea0dde0a45d62f79f1cbb989ac27129c4bdda41334f8b444edd6edf7c",
    "PXD-196 decision text remains immutable history");
  assert.equal(fingerprintPxdDecisionSection(decisionLogText, "PXD-211").sha256,
    "b1e0e32ae20914152547c20f0fbe8b020070c77f3fd78572e1965753f943c4cf",
    "PXD-211 decision text remains immutable history");
  assert.equal(migrationPxd196Successor.decisionRef, ".product-experience/decision-log.md#PXD-196");
  assert.deepEqual(migrationPxd196Successor.counts, {
    candidateObservations: 63,
    materialObservations: 15,
    total: 78,
    targetValueDrift: 0,
  });
  assert.equal(migrationPxd196Successor.records.length, 78);
  assert.deepEqual(migrationPxd196Successor.sourceFingerprints, {
    ".product-experience/pdp-0-product-truth/requirements.yaml": "ad3f569668f817a1536741ae105d729911c42e6fb801c01d7022ba19168b7c33",
    ".product-experience/pdp-0-product-truth/capabilities.yaml": "bc1d9c389afc3445015679aa9bbf63dae310b5a91b34dbf7046a8de92f52dbba",
    ".product-experience/pdp-0-product-truth/applications-channels.yaml": "b9f6a24eb1ef1e55dc64e4deacda7f713818acfdd8d11b1576747bdf723eccaa",
  }, "PXD-196's source cut remains an immutable historical record");
  for (const observation of migrationPxd196Successor.records) {
    const sourcePath = observation.targetRef.split("#", 1)[0];
    assert.equal(observation.currentSourceFileSha256, migrationPxd196Successor.sourceFingerprints[sourcePath],
      `${observation.observationId} PXD-196 source-cut pin`);
    assert.match(observation.currentTargetValueSha256, /^[a-f0-9]{64}$/u,
      `${observation.observationId} immutable PXD-196 target pin`);
    assert.equal(observation.semanticEquivalence, "NOT_ASSERTED");
    assert.equal(observation.semanticPromotion, false);
    assert.equal(observation.acceptanceEffect, "none");
  }
  const currentNamingRoute = migrationPxd211RouteSuccessor.records.find(({ claimId }) => claimId === "MPSEM-0172-C002");
  assert.ok(currentNamingRoute, "PXD-211 preserves the historical capability-naming route");
  assert.match(currentNamingRoute.current.targetValueSha256, /^[a-f0-9]{64}$/u,
    "PXD-211 retains its selected-target digest as history");
  assert.deepEqual(migrationPxd211RouteSuccessor.sourceFingerprints[".product-experience/decision-log.md#PXD-211-section"],
    fingerprintPxdDecisionSection(decisionLogText, "PXD-211"), "PXD-211 retains its exact decision-section pin");
  assert.equal(migrationPxd211RouteSuccessor.authority.ownerApproval, "NOT_CLAIMED");
  assert.equal(migrationPxd211RouteSuccessor.authority.acceptanceEffect, "none");
  assert.equal(migrationPxd211RouteSuccessor.authority.independentAcceptance, "NOT_CLAIMED");
  assert.equal(migrationPxd211RouteSuccessor.authority.implementation, "NOT_CLAIMED");
  assert.equal(migrationPxd211RouteSuccessor.authority.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(migrationPxd211RouteSuccessor.authority.qualification, "NOT_EVALUATED");
  assert.equal(migrationPxd211RouteSuccessor.authority.closure, "NOT_CLAIMED");
  assert.equal(migrationPxd211RouteSuccessor.authority.delivery, "NOT_CLAIMED");
  const prior0022 = migrationPxd185Successor.records.find((record) => record.claimId === "MPSEM-0022-C002");
  const current0022 = migrationPxd196Successor.records.find((record) => record.claimId === "MPSEM-0022-C002");
  assert.ok(prior0022, "PXD-185 remains preserved as predecessor history for MPSEM-0022-C002");
  assert.ok(current0022, "PXD-196 carries the current additive successor for MPSEM-0022-C002");
  assert.equal(prior0022.currentSourceFileSha256,
    migrationPxd185Successor.sourceFingerprints[prior0022.targetRef.split("#", 1)[0]],
    "PXD-185 keeps its immutable historical source hash");
  assert.notEqual(prior0022.currentSourceFileSha256, current0022.currentSourceFileSha256,
    "PXD-196 advances the stale PXD-185 source hash without rewriting history");
  assert.equal(current0022.predecessorCurrentSourceFileSha256, prior0022.currentSourceFileSha256);
  assert.equal(current0022.predecessorCurrentTargetValueSha256, prior0022.currentTargetValueSha256);

  const expectedRefreshes = new Map([
    ["P0-MIGRATION-CURRENT-121", {
      claimId: "MPSEM-0181-C001",
      source: "migration-p0-current-material-source-observations.json",
      targetRef: ".product-experience/pdp-0-product-truth/capabilities.yaml#coverageRule",
    }],
    ["P0-MIGRATION-CURRENT-122", {
      claimId: "MPSEM-0475-C003",
      source: "migration-p0-current-material-source-observations.json",
      targetRef: ".product-experience/pdp-0-product-truth/applications-channels.yaml#/channels/@id=media.channel.cli/evidence",
    }],
    ["P0-MIGRATION-CURRENT-123", {
      claimId: "MPSEM-0475-C003",
      source: "migration-p0-current-material-source-observations.json",
      targetRef: ".product-experience/pdp-0-product-truth/applications-channels.yaml#/channels/@id=media.channel.cli/ownerCliDefinitionContract/commandSurfaceSeparationRule/rule",
    }],
    ["P0-MIGRATION-CURRENT-124", {
      claimId: "MPSEM-0475-C003",
      source: "migration-p0-current-material-source-observations.json",
      targetRef: ".product-experience/pdp-0-product-truth/applications-channels.yaml#/channels/@id=media.channel.cli/ownerCliDefinitionContract/commandSurfaceSeparationRule/invocationModes",
    }],
    ["P0-MIGRATION-CURRENT-125", {
      claimId: "MPSEM-0475-C003",
      source: "migration-p0-current-material-source-observations.json",
      targetRef: ".product-experience/pdp-0-product-truth/applications-channels.yaml#/channels/@id=media.channel.cli/ownerCliDefinitionContract/commandSurfaceSeparationRule/scopeStatus",
    }],
    ["P0-MIGRATION-CURRENT-126", {
      claimId: "MPSEM-0475-C003",
      source: "migration-p0-current-material-source-observations.json",
      targetRef: ".product-experience/pdp-0-product-truth/applications-channels.yaml#/channels/@id=media.channel.cli/ownerCliDefinitionContract/commandSurfaceSeparationRule/executionAdmission",
    }],
    ["P0-MIGRATION-CURRENT-127", {
      capabilityId: "media.project.create",
      source: "migration-p0-current-source-observations.json",
      targetRef: ".product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.project.create/ownerDefinition/typedInputSlots",
    }],
    ...["MPSEM-0336-C006", "MPSEM-0349-C001", "MPSEM-0351-C001"].map((claimId, index) => [`P0-MIGRATION-CURRENT-${128 + index}`, {
      claimId,
      source: "migration-p0-current-source-observations.json",
      targetRef: ".product-experience/pdp-0-product-truth/capabilities.yaml#/capabilities/@id=media.job.watch/acceptanceCases/1/when",
    }]),
    ["P0-MIGRATION-CURRENT-131", {
      claimId: "MPSEM-0315-C002",
      source: "migration-p0-current-source-observations.json",
      targetRef: ".product-experience/pdp-0-product-truth/capabilities.yaml#/capabilities/@id=media.speech.transcription.alternatives.provide/outcome",
    }],
  ]);
  assert.equal(expectedRefreshes.size, 11);
  for (const [observationId, expected] of expectedRefreshes) {
    const record = migrationPxd196Successor.records.find((item) => item.observationId === observationId);
    assert.ok(record, `${observationId} current source observation exists`);
    if (expected.claimId) assert.equal(record.claimId, expected.claimId, `${observationId} exact claim owner`);
    if (expected.capabilityId) assert.equal(record.capabilityId, expected.capabilityId, `${observationId} exact capability owner`);
    assert.ok(record.sourceArtifactRef.endsWith(expected.source), `${observationId} exact observation source artifact`);
    assert.equal(record.targetRef, expected.targetRef, `${observationId} exact current target selector`);
    assert.equal(record.currentSourceFileSha256,
      migrationPxd196Successor.sourceFingerprints[record.targetRef.split("#", 1)[0]],
      `${observationId} immutable PXD-196 source-cut pin`);
    assert.match(record.currentTargetValueSha256, /^[a-f0-9]{64}$/u,
      `${observationId} immutable PXD-196 target pin`);
    if (["MPSEM-0336-C006", "MPSEM-0349-C001", "MPSEM-0351-C001"].includes(expected.claimId)) {
      const historicalPxd108 = migrationP0CurrentSourceObservations.records.find((item) => item.claimId === expected.claimId);
      assert.ok(historicalPxd108, `${expected.claimId} retains its PXD-108 observation`);
      assert.equal(historicalPxd108.historicalPxd108ObservationArtifactSha256, sha(pendingObservationBytes),
        `${expected.claimId} PXD-108 artifact bytes remain pinned immutably`);
      assert.equal(historicalPxd108.historicalPxd108CurrentTargetSha256, "f3ce3cf8cb3e5d09fc49c11c6bfa2722df44abcf2595003aab931bf21c7ef8eb");
      assert.equal(historicalPxd108.historicalPxd108SourceFileSha256, "f03fb72b7a3f1c8bb74d61a7dad101125c9dc1a1d4837d9cd2d8587446c04f1c");
    }
  }
});

test("PXD-214 and PXD-216 retain historical source cuts while PXD-223 binds current PDP-0 capability meaning", () => {
  const successor = readPxd214Successor();
  const currentReview = JSON.parse(readFileSync(resolve(root,
    "docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd223.json"), "utf8"));
  const requirementsPath = ".product-experience/pdp-0-product-truth/requirements.yaml";
  const capabilitiesPath = ".product-experience/pdp-0-product-truth/capabilities.yaml";
  const requirementsSha = sha(readFileSync(resolve(root, requirementsPath)));
  const capabilitiesSha = sha(readFileSync(resolve(root, capabilitiesPath)));
  const authority = successor.authority;

  assert.equal(successor.decisionRef, ".product-experience/decision-log.md#PXD-214");
  assert.equal(authority.phaseScope, "PDP-0");
  assert.equal(authority.reviewKind, "COORDINATOR_AUTHORED_CURRENT_SOURCE_RECONCILIATION");
  assert.equal(authority.ownerApproval, "NOT_CLAIMED");
  assert.equal(authority.independentAcceptance, "NOT_CLAIMED");
  assert.equal(authority.acceptanceEffect, "none");
  assert.equal(authority.implementation, "NOT_CLAIMED");
  assert.equal(authority.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(authority.qualification, "NOT_EVALUATED");
  assert.equal(authority.closure, "NOT_CLAIMED");
  assert.equal(authority.delivery, "NOT_CLAIMED");
  assert.equal(successor.sourceFingerprints[requirementsPath], requirementsSha,
    "PXD-214's unchanged requirements source remains current");
  assert.match(successor.sourceFingerprints[capabilitiesPath], /^[a-f0-9]{64}$/u,
    "PXD-214 retains its exact capability source-cut fingerprint");
  assert.notEqual(successor.sourceFingerprints[capabilitiesPath], capabilitiesSha,
    "PXD-214 remains bound to its earlier capability source cut");
  assert.equal(currentReview.currentSource.capabilitiesSha256, capabilitiesSha,
    "PXD-223 binds the exact live capabilities source bytes");
  const predecessorRefs = collectStringValues(successor.predecessorRefs);
  assert.ok(predecessorRefs.some((ref) => ref.includes("pdp0-migration-current-source-successor-pxd196.json")),
    "PXD-214 retains PXD-196 as historical predecessor");
  assert.ok(predecessorRefs.some((ref) => ref.includes("pdp0-current-semantic-route-successor-pxd211.json")),
    "PXD-214 retains PXD-211 as historical predecessor");

  const records = new Map(successor.records.map((record) => [record.claimId, record]));
  const namingClaim = readYaml(reviewPath).pdp38ClaimReconciliation.records
    .flatMap(({ claims }) => claims ?? [])
    .flatMap(({ subclaims, ...claim }) => subclaims ?? [claim])
    .find(({ claimId }) => claimId === "MPSEM-0172-C002");
  assert.ok(namingClaim, "the current capability-naming route claim exists");

  const namingRecord = records.get("MPSEM-0172-C002");
  assert.ok(namingRecord, "PXD-214 carries a current-source record for the changed naming selector");
  assert.equal(namingRecord.selectorRef, namingClaim.targetRef,
    "PXD-214 follows the current requirements selector owned by the claim");
  assert.equal(namingRecord.currentRawSourceSha256, requirementsSha);
  assert.equal(namingRecord.currentProjectionSha256, fingerprint(resolveRef(namingRecord.selectorRef)),
    "PXD-214 records the exact live canonical naming-rule projection");
  assert.equal(namingRecord.semanticEquivalence, "NOT_ASSERTED");
  assert.equal(namingRecord.ownerApproval, "NOT_CLAIMED");
  assert.equal(namingRecord.acceptanceEffect, "none");

  const capabilityRecord = records.get("MPSEM-0030-C001");
  assert.ok(capabilityRecord, "PXD-214 carries the current C001 capability-source observation");
  assert.ok(capabilityRecord.selectorRef.startsWith(`${capabilitiesPath}#`),
    "C001 remains bound to a specific capability selector");
  assert.equal(capabilityRecord.currentRawSourceSha256, successor.sourceFingerprints[capabilitiesPath],
    "PXD-214's claim observation retains its exact source-cut fingerprint");
  assert.equal(capabilityRecord.currentProjectionSha256, fingerprint(resolveRef(capabilityRecord.selectorRef)),
    "PXD-214 records the exact live capability projection");
  assert.equal(capabilityRecord.semanticEquivalence, "NOT_ASSERTED");
  assert.equal(capabilityRecord.ownerApproval, "NOT_CLAIMED");
  assert.equal(capabilityRecord.acceptanceEffect, "none");
});

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
    ["MPSEM-0181-C002", ".product-experience/pdp-0-product-truth/reuse-decisions.yaml#mediaArchitectureRules/externalStackSelectionRule"],
    ["MPSEM-0374-C006", ".product-experience/pdp-0-product-truth/reuse-decisions.yaml#mediaArchitectureRules/externalStackSelectionRule"],
    ["MPSEM-0459-C002", ".product-experience/pdp-0-product-truth/reuse-decisions.yaml#/mediaArchitectureRules/externalStackSelectionRule"],
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
  } else if (["MPSEM-0181-C002", "MPSEM-0374-C006", "MPSEM-0459-C002"].includes(claim.claimId)) {
    const rule = target;
    assert.match(rule.reuseBeforeSelection, /Before selecting a new streaming stack, inspect the exact existing Ghatana-owned streaming modules and their public contracts/u);
    assert.match(rule.reuseBeforeSelection, /Reuse an existing module when it satisfies the requirements of the exact admitted Media capability\/profile/u);
    assert.match(rule.reuseBeforeSelection, /record the concrete profile requirement it cannot meet and the evidence for that reuse gap/u);
    if (claim.claimId === "MPSEM-0181-C002") {
      assert.equal(claim.exactSourceText, "Reuse existing Ghatana streaming modules before selecting a new stack.");
    }
    assert.match(rule.scope, /select the smallest stack/u);
    assert.match(rule.scopeStatus, /no integration, candidate qualification, or runtime admission implied/u);
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
  assert.equal(metadata.length, 10);
  assert.deepEqual(new Set(metadata.map(({ claimId }) => claimId)), new Set([
    "MPSEM-0001-C001", "MPSEM-0023-C001", "MPSEM-0030-C001", "MPSEM-0032-C001",
    "MPSEM-0034-C001", "MPSEM-0035-C001", "MPSEM-0053-C001", "MPSEM-0055-C001",
    "MPSEM-0066-C001", "MPSEM-0469-C001",
  ]), "exact metadata-only claim cohort remains source-bound");
  assert.equal(routed.length, 860);
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
  if (!p0Only) {
    // These live leaf labels are the current observation. The frozen P0
    // review counters still read 499/361, while the extracted leaves contain
    // 500 verified and 360 pending claims; do not rewrite that historical pin.
    assert.equal(verified.length, 500);
    assert.equal(pending.length, 360);
    assert.equal(verified.length + pending.length, routed.length, "Every routed claim remains in exactly one reviewed or pending partition; bounded approval suites check their exact immutable cohorts");
  } else {
    assert.ok(verified.length + pending.length <= routed.length, "P0 census retains reviewed/pending labels while downstream target review remains deferred");
  }
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

test("REV-10 finding label is metadata while its governance rules stay on the exact P0 owner", () => {
  const review = readYaml(reviewPath);
  const records = review.pdp38ClaimReconciliation.records;
  const leaves = records.flatMap(({ claims }) => claims ?? []).flatMap((claim) => claim.subclaims ?? [claim]);
  const label = leaves.find(({ claimId }) => claimId === "MPSEM-0030-C001");
  assert.equal(label.disposition, "NON_NORMATIVE_SOURCE_METADATA");
  assert.deepEqual(label.metadataFields, ["finding-id-and-summary-label"]);
  assert.equal(label.sourceEvidenceRef, "docs/migration/expert-reviewed-master-plan.md#L106");
  assert.equal(Object.hasOwn(label, "targetRef"), false);
  assert.equal(label.acceptanceEffect, "none");
  const localInference = leaves.find(({ claimId }) => claimId === "MPSEM-0030-C003");
  const workerException = leaves.find(({ claimId }) => claimId === "MPSEM-0030-C004");
  assert.equal(localInference.targetRef, ".product-experience/pdp-0-product-truth/handoff-contracts.yaml#/handoffs/@id=ai-inference-execution/genericInferenceOwnershipBoundary");
  assert.equal(workerException.targetRef, ".product-experience/pdp-0-product-truth/handoff-contracts.yaml#/handoffs/@id=ai-inference-execution/boundedWorkerExceptionRule");
  assert.match(resolveRef(localInference.targetRef).rule, /local deployment eligibility and placement/u);
  assert.match(resolveRef(workerException.targetRef).rule, /does not establish a general bypass around AI Inference/u);
  assert.equal(localInference.acceptanceEffect, "none");
  assert.equal(workerException.acceptanceEffect, "none");
});

test("REV-14 heading is metadata while graph/run-state rules remain on the current owners", { skip: p0Only }, () => {
  const review = readYaml(reviewPath);
  const leaves = review.pdp38ClaimReconciliation.records.flatMap(({ claims }) => claims ?? []).flatMap((claim) => claim.subclaims ?? [claim]);
  const label = leaves.find(({ claimId }) => claimId === "MPSEM-0034-C001");
  assert.equal(label.disposition, "NON_NORMATIVE_SOURCE_METADATA");
  assert.deepEqual(label.metadataFields, ["finding-id-and-summary-label"]);
  assert.equal(label.sourceEvidenceRef, "docs/migration/expert-reviewed-master-plan.md#L113");
  assert.equal(Object.hasOwn(label, "targetRef"), false);
  assert.equal(label.acceptanceEffect, "none");
  const split = leaves.find(({ claimId }) => claimId === "MPSEM-0034-C003");
  const authorization = leaves.find(({ claimId }) => claimId === "MPSEM-0034-C004");
  assert.equal(split.disposition, "ROUTED_TO_CURRENT_PDP_AUTHORITY");
  assert.equal(authorization.disposition, "ROUTED_TO_CURRENT_PDP_AUTHORITY");
  assert.equal(split.acceptanceEffect, "none");
  assert.equal(authorization.acceptanceEffect, "none");
  assert.match(resolveRef(split.targetRef), /distinct records.*run never mutates/u);
  assert.equal(authorization.semanticReviewStatus, "OWNER_TARGET_LOCATOR_ONLY_PENDING_CLAIM_PARITY");
  assert.match(resolveRef(authorization.targetRef), /after current policy validation/u);
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
  const observation = currentTargetObservations.records.find(({ claimId }) => claimId === claim.claimId);
  assert.equal(observation.targetRef, claim.targetRef);
  if (claim.claimId === "MPSEM-0388-C003") {
    assert.equal(observation.historicalCurrentTargetValueSha256, "6ee7206bc1a51d53d526ac4cf5a7d13c4219c9f9cd915d74ffd4d23c287baef6");
    assert.equal(observation.currentTargetValueSha256, claim.targetTextSha256);
    assert.equal(observation.additionalRuleId, "media.policy.offline-entitlement-validity-window.v1");
    assert.equal(observation.additionalOwnerRuleRef, `${claim.targetRef}/offlineEntitlementWindow`);
    assert.equal(observation.disposition, "CURRENT_TARGET_EXTENDED_BY_UNRELATED_OWNER_RULE; CLAIM_PARITY_RETAINED");
    const pxd084Delta = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/migration-pxd084-current-owner-delta.json"), "utf8"));
    assert.equal(pxd084Delta.previousBoundedTargetSha256, observation.historicalCurrentTargetValueSha256);
    assert.equal(pxd084Delta.currentTargetSha256, observation.currentTargetValueSha256);
    assert.equal(pxd084Delta.projectionWithoutLaterRulesSha256, pxd084Delta.previousBoundedTargetSha256);
    assert.equal(pxd084Delta.projectionMatchesPreviousBoundedImpact, true);
    assert.deepEqual(pxd084Delta.additions.map(({ targetRef }) => targetRef), [
      `${claim.targetRef}/offlineEntitlementWindow`,
      `${claim.targetRef}/fallback/compatibilityDecisionRule`,
    ]);
    assert.ok(pxd084Delta.additions.every(({ disposition }) => disposition === "SEPARATE_CURRENT_OWNER_RULE; NOT_PART_OF_HISTORICAL_PXD084_REVIEW"));
    assert.equal(pxd084Delta.acceptanceEffect, "none");
    assert.equal(pxd084Delta.runtimeAdmission, "NOT_ADMITTED");
  }
  const policy = resolveRef(claim.targetRef);
  assert.equal(policy.automaticAcquisition.default, "DENY");
  assert.match(policy.automaticAcquisition.unavailableBehavior, /do not download a model/u);
  assert.equal(policy.fallback.default, "DENY_SILENT_FALLBACK");
  assert.match(policy.fallback.localOnly, /always denied/u);
  assert.match(policy.offlineEntitlementWindow.offlineBoundary, /Cached bytes .* do not prove a current entitlement/u);
  const graphStateClaim = review.pdp38ClaimReconciliation.records.flatMap(({ claims }) => claims ?? []).flatMap(({ subclaims, ...claim }) => subclaims ?? [claim]).find(({ claimId }) => claimId === "MPSEM-0034-C002");
  const graphStateObservation = currentTargetObservations.records.find(({ claimId }) => claimId === graphStateClaim.claimId);
  assert.equal(graphStateObservation.targetRef, graphStateClaim.targetRef);
  assert.equal(graphStateObservation.reportedReviewTargetValueSha256, "fc79ca5b22a531e4c812fdb5a1114a68365b153c6b4e71cc9726d95130056925");
  const graphStateValue = resolveRef(graphStateClaim.targetRef);
  const graphStateApproved = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/migration-coordinator-p2-review-97.json"), "utf8"))
    .records.find(({ claimId }) => claimId === graphStateClaim.claimId);
  for (const clause of graphStateApproved.exactMaterialClauses) assert.ok(graphStateValue.rule.includes(clause), `current graph rule preserves exact reviewed clause: ${clause}`);
  assert.equal(sha(JSON.stringify(graphStateValue)), graphStateObservation.recomputedCurrentTargetValueSha256);
  assert.equal(graphStateObservation.recomputedCurrentTargetValueSha256, graphStateClaim.targetTextSha256);
  assert.equal(graphStateObservation.disposition, "EXACT_CURRENT_TARGET_VALUE_REHASHED; CLAIM_PARITY_REVIEWED");
  assert.match(graphStateObservation.claimParityBasis, /each invocation has a separately identified run/u);
  const currentClaims = review.pdp38ClaimReconciliation.records.flatMap(({ claims }) => claims ?? []).flatMap(({ subclaims, ...claim }) => subclaims ?? [claim]);
  for (const claimId of ["MPSEM-0042-C003", "MPSEM-0316-C001"]) {
    const claim = currentClaims.find(({ claimId: id }) => id === claimId);
    const observation = currentTargetObservations.records.find(({ claimId: id }) => id === claimId);
    assert.equal(observation.targetRef, claim.targetRef);
    assert.equal(observation.reportedReviewTargetValueSha256, "63d8eefe808bfce7150d7dd1dfa6af1358f71de4c78c37a79761071de1a3dd0b");
    assert.equal(observation.recomputedCurrentTargetValueSha256, claim.targetTextSha256);
    assert.equal(observation.disposition, "EXACT_CURRENT_TARGET_VALUE_REHASHED; CLAIM_PARITY_REVIEWED");
  }
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

test("PXD-075 action claims preserve historical pins while later action bytes remain unadjudicated", () => {
  const review = readYaml(reviewPath);
  const claims = review.pdp38ClaimReconciliation.records.flatMap(({ claims }) => claims ?? [])
    .flatMap(({ subclaims, ...claim }) => subclaims ?? [claim]);
  const actionRows = ["MPSEM-1259-C001-S06", "MPSEM-1259-C001-S10"].map((claimId) => {
    const claim = claims.find((entry) => entry.claimId === claimId);
    const observation = migrationOverlayCurrentOwnerObservations.records.find((entry) => entry.claimId === claimId);
    assert.equal(claim.semanticReviewStatus, "CLAIM_SPECIFIC_SEMANTIC_PARITY_VERIFIED");
    assert.equal(claim.targetTextSha256, "e946bf97e4064a03a4f608d6bec344e190f58ee1a5d838a3441dc7e2d09ecec2");
    assert.equal(observation.targetRef, claim.targetRef);
    assert.equal(observation.historicalTargetValueSha256, claim.targetTextSha256);
    assert.equal(observation.previousObservedCurrentTargetValueSha256, "c71c3f306e3d0618ab4dfc248781ae1f97067bcca6fed2491f0f30f1ac3d209b");
    assert.equal(observation.previousObservedCurrentSourceFileSha256, "cf371281266f8b5bcbb953cb9a406147451cdcf74cbf0313558c2c181f4a7424");
    assert.equal(observation.currentTargetValueSha256, sha(JSON.stringify(resolveRef(claim.targetRef))));
    assert.equal(observation.currentTargetValueSha256, "e6b695bbde9ed7701e7de02426d723f672dcc5ed34a1ef8368d738077bed6347");
    assert.equal(observation.currentSourceFileSha256, sha(readFileSync(resolve(root, claim.targetRef.split("#")[0]))));
    assert.equal(observation.currentSourceFileSha256, "53633fcf162cc0cd3abc98c6f2f17e26465081154dbb1d5298ebda2957952426");
    assert.equal(observation.priorReviewRef, ".product-experience/decision-log.md#PXD-075");
    assert.equal(observation.semanticEquivalence, "NOT_ASSERTED");
    assert.equal(observation.acceptanceEffect, "none");
    assert.match(observation.observation, /does not assert semantic equivalence for later registry changes/u);
    return observation;
  });
  assert.equal(actionRows.length, 2);
  const actions = resolveRef(actionRows[0].targetRef);
  assert.ok(actions.some(({ preconditions = [] }) => preconditions.includes("exact-artifact-and-immutable-version-identity")));
  const provenanceAction = resolveRef(".product-experience/pdp-3-product-experience/action-registry.yaml#actions/@id=media.action.inspect-provenance");
  assert.ok(provenanceAction.capabilityRefs.includes("media.provenance.source-lineage.inspect"));
  assert.ok(actions.some(({ actionDefinitionSemantics }) => actionDefinitionSemantics?.sourceEnvelope?.classificationBasis === "source-declares-an-exact-logical-operation-reference; transport-and-runtime-admission-remain-NOT_ADMITTED"));
});

test("PDP-0 records only an exact PDP-1 locator handoff for MPSEM-0270-C001", () => {
  const review = readYaml(reviewPath);
  const claim = review.pdp38ClaimReconciliation.records.flatMap(({ claims }) => claims ?? [])
    .find(({ claimId }) => claimId === "MPSEM-0270-C001");
  const observation = migrationOverlayCurrentOwnerObservations.records.find(({ claimId }) => claimId === claim.claimId);
  assertPdp1CurrentLocatorObservation(claim, observation);
  assert.equal(observation.targetRef, claim.targetRef);

  assert.throws(() => assertPdp1CurrentLocatorObservation(claim, { ...observation, ownerPhase: undefined }));
  assert.throws(() => assertPdp1CurrentLocatorObservation(claim, { ...observation, ownerPhase: "PDP-2" }), /PDP-1/u);
  assert.throws(() => assertPdp1CurrentLocatorObservation(claim, { ...observation, handoff: undefined }));
  assert.throws(() => assertPdp1CurrentLocatorObservation(claim, {
    ...observation,
    handoff: "PDP-2 owner phase: assess target semantics within PDP-2.",
  }));
  assert.throws(() => assertPdp1CurrentLocatorObservation(claim, {
    ...observation,
    targetRef: ".product-experience/pdp-2-design-system/example.yaml#/field",
  }), /owned by PDP-1/u);
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


test("PXD-108 pins remain immutable while PXD-130 separately observes current source files", () => {
  const expectedCapabilityClaims = ["MPSEM-0030-C001", "MPSEM-0336-C006", "MPSEM-0349-C001", "MPSEM-0351-C001"];
  const historicalCapabilitiesSha = "f03fb72b7a3f1c8bb74d61a7dad101125c9dc1a1d4837d9cd2d8587446c04f1c";
  for (const claimId of expectedCapabilityClaims) {
    const observation = pendingObservations.records.find((record) => record.claimId === claimId);
    assert.ok(observation, `${claimId} pending observation`);
    assert.equal(observation.sourceFileSha256, historicalCapabilitiesSha, `${claimId} historical file pin`);
    assert.equal(observation.semanticEquivalence, "NOT_ASSERTED");
    assert.equal(observation.disposition, "PENDING_LOCATOR_CURRENT_SOURCE_OBSERVATION_ONLY");
    assert.equal(observation.acceptanceEffect, "none");
    const target = resolveRef(observation.targetRef);
    assert.equal(sha(typeof target === "string" ? target : JSON.stringify(target)), observation.currentHash, `${claimId} unchanged target hash`);
    assert.equal(resolveRef(observation.targetRef), observation.currentValue, `${claimId} unchanged target value`);
    const supplement = migrationP0CurrentSourceObservations.records.find((record) => record.claimId === claimId);
    assert.equal(supplement.historicalPxd108ObservationArtifactSha256, sha(pendingObservationBytes));
    assert.equal(supplement.historicalPxd108CurrentTargetSha256, observation.currentHash);
    assert.equal(supplement.historicalPxd108SourceFileSha256, observation.sourceFileSha256);
    assert.equal(supplement.currentSourceFileSha256,
      migrationPxd196Successor.sourceFingerprints[".product-experience/pdp-0-product-truth/capabilities.yaml"],
      `${claimId} immutable PXD-130-era source observation`);
    assert.equal(supplement.semanticEquivalence, "NOT_ASSERTED");
    assert.equal(supplement.acceptanceEffect, "none");
  }
  for (const claimId of ["MPSEM-0172-C002", "MPSEM-0030-C001"]) {
    const predecessor = claimId === "MPSEM-0172-C002"
      ? migrationPxd153CurrentSourceObservations.records.find((record) => record.claimId === claimId)
      : migrationP0CurrentSourceObservations.records.find((record) => record.claimId === claimId);
    const successor = migrationPxd173Successor.records.find((record) => record.claimId === claimId
      && record.sourceArtifactRef === (claimId === "MPSEM-0172-C002"
        ? "docs/implementation/verification/pdp-38/migration-p0-pxd153-current-source-observations.json"
        : "docs/implementation/verification/pdp-38/migration-p0-current-source-observations.json"));
    assert.ok(successor, `${claimId} PXD-173 current-source successor`);
    assert.equal(successor.predecessorCurrentSourceFileSha256,
      predecessor.supersededCurrentSourceFileSha256 ?? predecessor.currentSourceFileSha256);
    assert.equal(successor.currentSourceFileSha256,
      migrationPxd173Successor.sourceFingerprints[".product-experience/pdp-0-product-truth/capabilities.yaml"],
      "PXD-173 observation retains its historical source fingerprint");
    assert.match(successor.currentTargetValueSha256, /^[a-f0-9]{64}$/u,
      `${claimId} PXD-173 historical target pin`);
    assert.equal(successor.currentTargetValueSha256, predecessor.currentTargetValueSha256);
    assert.equal(successor.semanticEquivalence, "NOT_ASSERTED");
    assert.equal(successor.acceptanceEffect, "none");
  }
  assert.equal(migrationPxd173Successor.decisionRef, ".product-experience/decision-log.md#PXD-173");
  const qualityObservation = pendingObservations.records.find(({ claimId }) => claimId === "MPSEM-0187-C002");
  assert.equal(qualityObservation.sourceFileSha256, "3e0f82742ca924248d3ea1ab83085d939ba67b445f9676935a82dd0a3871b3de");
  assert.equal(qualityObservation.semanticEquivalence, "NOT_ASSERTED");
  assert.equal(qualityObservation.acceptanceEffect, "none");
  const qualitySupplement = migrationP0CurrentSourceObservations.records.find(({ claimId }) => claimId === "MPSEM-0187-C002");
  assert.equal(qualitySupplement.historicalPxd108ObservationArtifactSha256, sha(pendingObservationBytes));
  assert.equal(qualitySupplement.historicalPxd108CurrentTargetSha256, qualityObservation.currentHash);
  assert.equal(qualitySupplement.historicalPxd108SourceFileSha256, qualityObservation.sourceFileSha256);
  assert.equal(qualityObservation.sourceFileSha256, "3e0f82742ca924248d3ea1ab83085d939ba67b445f9676935a82dd0a3871b3de", "PXD-108 historical file pin remains immutable");
  assert.equal(qualitySupplement.historicalPxd108ObservationArtifactSha256, "eff17d84f91e1e14483f41938fe0fd39bb6e5a9db5c227163e92de1f90e02aec", "PXD-108 historical observation artifact pin remains immutable");
  assert.equal(qualitySupplement.currentSourceFileSha256, "439276c05d4537d80b34c9116b5e476487944aaf40ce8c09f74c0761041fe770", "PXD-130 additive current-source pin is exact after the PXD-142 crosswalk projection update");
  assert.equal(qualitySupplement.semanticEquivalence, "NOT_ASSERTED");
  assert.equal(qualitySupplement.acceptanceEffect, "none");
});
