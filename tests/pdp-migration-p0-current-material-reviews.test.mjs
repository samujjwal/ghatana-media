import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const candidate = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/truth-domain-pdp0-pdp1-owner-candidate-199.json"), "utf8"));
const currentReview = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/migration-p0-current-material-review.json"), "utf8"));
const currentSourceSupplement = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/migration-p0-current-material-source-observations.json"), "utf8"));
const pxd173Successor = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/pdp0-migration-current-source-successor-pxd173.json"), "utf8"));
const pxd183Successor = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/pdp0-migration-current-source-successor-pxd183.json"), "utf8"));
const pxd185Successor = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/pdp0-migration-current-source-successor-pxd185.json"), "utf8"));
const pxd196Successor = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/pdp0-migration-current-source-successor-pxd196.json"), "utf8"));
const pxd206Successor = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/pdp0-migration-current-source-successor-pxd206.json"), "utf8"));
const pxd153SourceCorrection = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/p0-upload-byte-length-minimum-current-source-review.json"), "utf8"));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const cache = new Map();
function resolveRef(ref) {
  const [file, pointer = ""] = ref.split("#", 2);
  let record = cache.get(file);
  if (!record) {
    const source = readFileSync(resolve(root, file), "utf8");
    record = { source, document: parse(source) };
    cache.set(file, record);
  }
  let value = record.document;
  for (const raw of pointer.split("/").filter(Boolean)) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (segment.startsWith("@id=")) value = Array.isArray(value) ? value.find((item) => item?.id === segment.slice(4)) : undefined;
    else if (/^\d+$/u.test(segment)) value = value?.[Number(segment)];
    else value = value?.[segment];
    assert.notEqual(value, undefined, `${ref} resolves`);
  }
  return { source: record.source, value };
}
const currentHash = (value) => sha(typeof value === "string" ? value : JSON.stringify(value));
const row = (claimId) => {
  const record = candidate.records.find((item) => item.claimId === claimId);
  assert.ok(record, `${claimId} is present`);
  return record;
};

test("PXD-183 remains immutable historical source evidence", () => {
  const requirementsPath = ".product-experience/pdp-0-product-truth/requirements.yaml";
  const requirementsBytes = readFileSync(resolve(root, requirementsPath));
  assert.equal(pxd183Successor.sourceFingerprints[requirementsPath], "4fe7fa39a380c8209741301b5488739db204a89444c150adba39f4ec3d2ff3a8");
  assert.notEqual(pxd183Successor.sourceFingerprints[requirementsPath], sha(requirementsBytes),
    "PXD-183 remains pinned to its historical source cut");

  const candidatePath = "docs/implementation/verification/pdp-38/truth-domain-pdp0-pdp1-owner-candidate-199.json";
  const materialSourcePath = "docs/implementation/verification/pdp-38/migration-p0-current-material-source-observations.json";
  const pxd173Path = "docs/implementation/verification/pdp-38/pdp0-migration-current-source-successor-pxd173.json";
  assert.equal(currentReview.decisionRef, ".product-experience/decision-log.md#PXD-139");
  assert.equal(currentSourceSupplement.decisionRef, currentReview.decisionRef);
  assert.equal(pxd173Successor.decisionRef, ".product-experience/decision-log.md#PXD-173");
  assert.deepEqual(pxd183Successor.predecessorArtifacts, [
    {
      artifactRef: pxd173Path,
      role: "predecessor current-source successor; retained unchanged as history",
    },
    {
      artifactRef: candidatePath,
      role: "source artifact with current PDP-0 observation pointers updated to this successor",
    },
    {
      artifactRef: materialSourcePath,
      role: "source artifact with current PDP-0 observation pointer updated to this successor",
    },
  ]);
  assert.deepEqual(
    [...new Set(pxd183Successor.records.map(({ sourceArtifactRef }) => sourceArtifactRef))].sort(),
    [candidatePath, materialSourcePath].sort(),
    "successor source records are exactly the candidate and PXD-139 material-observation artifacts",
  );
  for (const successor of pxd183Successor.records) {
    assert.equal(successor.targetRef.split("#", 1)[0], requirementsPath,
      `${successor.observationId} targets only PDP-0 requirements.yaml`);
  }
});

test("PXD-185 remains immutable historical requirements evidence and preserves PXD-183", () => {
  const requirementsPath = ".product-experience/pdp-0-product-truth/requirements.yaml";
  assert.deepEqual(pxd185Successor.sourceFingerprints, { [requirementsPath]: "49c079d4aff2499bb3c226ac52e3a7101d483392775bd9b05a0a469295329ce2" });
  assert.notEqual(pxd185Successor.sourceFingerprints[requirementsPath], sha(readFileSync(resolve(root, requirementsPath))),
    "PXD-185 keeps its historical source cut after later PDP-0 changes");
  assert.deepEqual(pxd185Successor.predecessorArtifacts, [
    { artifactRef: "docs/implementation/verification/pdp-38/pdp0-migration-current-source-successor-pxd183.json", role: "predecessor current-source successor; retained unchanged as history" },
    { artifactRef: "docs/implementation/verification/pdp-38/truth-domain-pdp0-pdp1-owner-candidate-199.json", role: "source artifact with current PDP-0 observation pointers updated to this successor" },
    { artifactRef: "docs/implementation/verification/pdp-38/migration-p0-current-material-source-observations.json", role: "source artifact with current PDP-0 observation pointer updated to this successor" },
  ]);
  assert.equal(pxd185Successor.records.length, 23);
  assert.equal(pxd185Successor.counts.targetValueDrift, 0);
  for (let index = 0; index < pxd185Successor.records.length; index++) {
    const current = pxd185Successor.records[index];
    const predecessor = pxd183Successor.records[index];
    assert.equal(current.predecessorCurrentSourceFileSha256, predecessor.currentSourceFileSha256);
    assert.equal(current.predecessorCurrentTargetValueSha256, predecessor.currentTargetValueSha256);
    assert.equal(current.semanticEquivalence, "NOT_ASSERTED");
    assert.equal(current.acceptanceEffect, "none");
  }
});

test("PXD-196 is the current additive successor for the refreshed PDP-0 observation population", () => {
  assert.equal(pxd196Successor.decisionRef, ".product-experience/decision-log.md#PXD-196");
  assert.deepEqual(pxd196Successor.counts, {
    candidateObservations: 63,
    materialObservations: 15,
    total: 78,
    targetValueDrift: 0,
  });
  assert.equal(pxd196Successor.records.length, 78);
  assert.equal(pxd185Successor.records.some((record) => record.claimId === "MPSEM-0022-C002"), true);
  assert.equal(pxd196Successor.records.some((record) => record.claimId === "MPSEM-0022-C002"), true,
    "the stale PXD-185 source pin for MPSEM-0022-C002 receives a current additive successor");
  assert.deepEqual(pxd196Successor.predecessorArtifacts[0], {
    artifactRef: "docs/implementation/verification/pdp-38/pdp0-migration-current-source-successor-pxd185.json",
    role: "prior P0 current-source successor; preserve unchanged as historical source/value pins",
  });
  assert.ok(pxd196Successor.records.every((record) => record.semanticEquivalence === "NOT_ASSERTED"
    && record.semanticPromotion === false && record.acceptanceEffect === "none"));
});

test("PXD-206 advances only current PDP-0 requirements source pins and preserves PXD-196 history", () => {
  assert.equal(pxd206Successor.decisionRef, ".product-experience/decision-log.md#PXD-206");
  assert.deepEqual(pxd206Successor.counts, {
    candidateObservations: 22,
    materialObservations: 1,
    total: 23,
    targetValueDrift: 0,
  });
  assert.equal(pxd206Successor.records.length, 23);
  const requirementsPath = ".product-experience/pdp-0-product-truth/requirements.yaml";
  assert.match(pxd206Successor.sourceFingerprints[requirementsPath], /^[a-f0-9]{64}$/u,
    "PXD-206 preserves its exact requirements source cut as history");
  assert.equal(pxd196Successor.records.filter((record) => record.targetRef.startsWith(`${requirementsPath}#`)).length, 23);
  for (const successor of pxd206Successor.records) {
    assert.equal(successor.targetRef.startsWith(`${requirementsPath}#`), true);
    assert.equal(successor.currentSourceFileSha256, pxd206Successor.sourceFingerprints[requirementsPath],
      "PXD-206 successor records remain bound to their immutable source cut");
    assert.equal(successor.semanticEquivalence, "NOT_ASSERTED");
    assert.equal(successor.semanticPromotion, false);
    assert.equal(successor.acceptanceEffect, "none");
    const prior = pxd196Successor.records.find((record) => record.claimId === successor.claimId
      && record.targetRef === successor.targetRef && record.sourceArtifactRef === successor.sourceArtifactRef
      && record.sourceRecordRef === successor.sourceRecordRef);
    assert.ok(prior, `${successor.claimId} exact PXD-196 predecessor is retained`);
    assert.equal(successor.predecessorObservationRef,
      `docs/implementation/verification/pdp-38/pdp0-migration-current-source-successor-pxd196.json#/records/@observationId=${prior.observationId}`);
    assert.equal(successor.predecessorCurrentSourceFileSha256, prior.currentSourceFileSha256);
    assert.equal(successor.predecessorCurrentTargetValueSha256, prior.currentTargetValueSha256);
    assert.equal(successor.currentTargetValueSha256, prior.currentTargetValueSha256,
      `${successor.claimId} selected target meaning is unchanged`);
  }
});

function assertPxd185Successor(record, targetRef, refreshed) {
  const pxd173Predecessor = pxd173Successor.records.find((item) => item.sourceArtifactRef === "docs/implementation/verification/pdp-38/migration-p0-current-material-source-observations.json"
    && item.claimId === record.claimId && item.targetRef === targetRef);
  const predecessor = pxd183Successor.records.find((item) => item.sourceArtifactRef === "docs/implementation/verification/pdp-38/migration-p0-current-material-source-observations.json"
    && item.claimId === record.claimId && item.targetRef === targetRef);
  const successor = pxd185Successor.records.find((item) => item.sourceArtifactRef === "docs/implementation/verification/pdp-38/migration-p0-current-material-source-observations.json"
    && item.claimId === record.claimId && item.targetRef === targetRef);
  assert.ok(pxd173Predecessor, `${record.claimId} ${targetRef} retains its PXD-173 history`);
  assert.ok(predecessor, `${record.claimId} ${targetRef} retains its PXD-183 history`);
  assert.ok(successor, `${record.claimId} ${targetRef} has a PXD-185 historical successor`);
  assert.equal(predecessor.predecessorCurrentSourceFileSha256, pxd173Predecessor.currentSourceFileSha256);
  assert.equal(predecessor.currentSourceFileSha256, refreshed.currentSourceSuccessorPredecessorFileSha256);
  assert.equal(successor.predecessorCurrentSourceFileSha256, predecessor.currentSourceFileSha256);
  assert.equal(successor.predecessorCurrentTargetValueSha256, predecessor.currentTargetValueSha256);
  assert.equal(successor.currentSourceFileSha256, refreshed.currentSourceFileSha256);
  assert.equal(successor.currentTargetValueSha256, refreshed.currentTargetValueSha256);
  assert.equal(successor.semanticEquivalence, "NOT_ASSERTED");
  assert.equal(successor.semanticPromotion, false);
  assert.equal(successor.acceptanceEffect, "none");
  assert.equal(pxd173Successor.decisionRef, ".product-experience/decision-log.md#PXD-173");
  assert.equal(pxd185Successor.decisionRef, ".product-experience/decision-log.md#PXD-185");
}

function assertCurrentMaterial(record) {
  const review = record.ownerSemanticReview;
  assert.equal(review.disposition, "SOURCE_RULE_CONTENT_SUPPORTS_CLAIM_AT_DEFINITION_LEVEL");
  assert.equal(review.acceptanceEffect, "none");
  assert.equal(review.runtimeStatus, "NOT_EVALUATED");
  assert.equal(review.proposedTargetRef, review.exactContractRefs[0]);
  assert.equal(new Set(review.exactContractRefs).size, review.exactContractRefs.length);
  assert.deepEqual(review.materialBindings.map((binding) => binding.ref), review.exactContractRefs);
  for (const binding of review.materialBindings) {
    const { source, value } = resolveRef(binding.ref);
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    const observation = binding.currentProposalObservation;
    assert.equal(serialized.includes(binding.requiredSourcePhrase), true, `${record.claimId} exact material phrase`);
    assert.equal(observation.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
    assert.ok(observation.currentSourceFileSha256, "PXD-139 source-file pin remains recorded as historical review evidence");
    assert.ok(observation.currentSourceValueSha256, "PXD-139 target-value pin remains recorded as historical review evidence");
    const refreshed = currentSourceSupplement.records.find((item) => item.claimId === record.claimId)?.materials.find((item) => item.targetRef === binding.ref);
    assert.ok(refreshed, `${record.claimId} has an additive current-source observation`);
    const historicalPxd139Material = currentReview.records.find((item) => item.claimId === record.claimId)?.materials.find((item) => item.targetRef === binding.ref);
    assert.ok(historicalPxd139Material, `${record.claimId} has its original PXD-139 material pin`);
    assert.equal(refreshed.historicalCurrentSourceFileSha256, historicalPxd139Material.currentSourceFileSha256);
    assert.equal(refreshed.historicalCurrentTargetValueSha256, historicalPxd139Material.currentTargetValueSha256);
    if (binding.ref.startsWith(".product-experience/pdp-0-product-truth/capabilities.yaml#")) {
      assert.equal(refreshed.sourceCorrectionDecisionRef, pxd153SourceCorrection.decisionRef);
      assert.equal(refreshed.sourceCorrectionEvidenceRef, "docs/implementation/verification/pdp-38/p0-upload-byte-length-minimum-current-source-review.json");
      assert.equal(pxd153SourceCorrection.supersedes.historicalCapabilitiesSha256, refreshed.historicalCurrentSourceFileSha256);
      assert.equal(pxd153SourceCorrection.source.currentSha256, refreshed.supersededCurrentSourceFileSha256,
        "PXD-153 remains pinned to its historical source cut");
    }
    assert.match(refreshed.currentSourceFileSha256, /^[a-f0-9]{64}$/u,
      "stored observation retains its recorded source cut; currentness requires an exact current successor");
    assert.match(refreshed.currentTargetValueSha256, /^[a-f0-9]{64}$/u,
      "stored observation retains its recorded selected-value cut");
    if (refreshed.currentSourceSuccessorRef) {
      const successorRef = refreshed.currentSourceSuccessorRef;
      const successorRecords = successorRef.includes("pxd206") ? pxd206Successor.records
        : successorRef.includes("pxd196") ? pxd196Successor.records : pxd185Successor.records;
      const successor = successorRecords.find((item) => item.claimId === record.claimId && item.targetRef === binding.ref
        && item.sourceArtifactRef === "docs/implementation/verification/pdp-38/migration-p0-current-material-source-observations.json");
      assert.ok(successor, `${record.claimId} has the referenced additive successor`);
      assert.equal(successor.currentSourceFileSha256, refreshed.currentSourceFileSha256);
      assert.equal(successor.currentTargetValueSha256, refreshed.currentTargetValueSha256);
      assert.equal(successor.acceptanceEffect, "none");
      assert.equal(successor.semanticPromotion, false);
    }
    assert.equal(refreshed.semanticEquivalence, "NOT_ASSERTED");
    assert.equal(refreshed.acceptanceEffect, "none");
    if (refreshed.currentSourceSuccessorRef) {
      if (refreshed.currentSourceSuccessorRef.includes("pxd206")) assertPxd206Successor(record, binding.ref, refreshed);
      else if (refreshed.currentSourceSuccessorRef.includes("pxd196")) assertPxd196Successor(record, binding.ref, refreshed);
      else assertPxd185Successor(record, binding.ref, refreshed);
    }
  }
}

function assertPxd206Successor(record, targetRef, refreshed) {
  const successor = pxd206Successor.records.find((item) => item.claimId === record.claimId && item.targetRef === targetRef
    && item.sourceArtifactRef === "docs/implementation/verification/pdp-38/migration-p0-current-material-source-observations.json");
  assert.ok(successor, `${record.claimId} ${targetRef} has a PXD-206 current source successor`);
  assert.equal(successor.currentSourceFileSha256, refreshed.currentSourceFileSha256);
  assert.equal(successor.currentTargetValueSha256, refreshed.currentTargetValueSha256);
  assert.equal(successor.semanticEquivalence, "NOT_ASSERTED");
  assert.equal(successor.semanticPromotion, false);
  assert.equal(successor.acceptanceEffect, "none");
  assert.equal(pxd206Successor.decisionRef, ".product-experience/decision-log.md#PXD-206");
}

function assertPxd196Successor(record, targetRef, refreshed) {
  const successor = pxd196Successor.records.find((item) => item.claimId === record.claimId && item.targetRef === targetRef
    && item.sourceArtifactRef === "docs/implementation/verification/pdp-38/migration-p0-current-material-source-observations.json");
  assert.ok(successor, `${record.claimId} ${targetRef} has a PXD-196 current source successor`);
  assert.equal(successor.currentSourceFileSha256, refreshed.currentSourceFileSha256);
  assert.equal(successor.currentTargetValueSha256, refreshed.currentTargetValueSha256);
  assert.equal(successor.semanticEquivalence, "NOT_ASSERTED");
  assert.equal(successor.semanticPromotion, false);
  assert.equal(successor.acceptanceEffect, "none");
  assert.equal(pxd196Successor.decisionRef, ".product-experience/decision-log.md#PXD-196");
}

test("five P0 migration reviews bind current owner meaning and reject cross-phase promotion", () => {
  const ids = ["MPSEM-0078-C003", "MPSEM-0181-C001", "MPSEM-0278-C001", "MPSEM-0367-C002", "MPSEM-0475-C003"];
  for (const id of ids) {
    const record = row(id);
    assert.equal(record.ownerPhase, "PDP-0");
    assertCurrentMaterial(record);
  }

  const leaf = row("MPSEM-0078-C003").ownerSemanticReview;
  assert.ok(leaf.materialBindings.some((binding) => binding.requiredSourcePhrase === "Each capability declares an explicit trust/reconstruction disposition against its P0 semantic inputs and outputs."));
  assert.ok(leaf.materialBindings.some((binding) => binding.requiredSourcePhrase === "Every scoped capability below is a finite semantic leaf."));
  assert.match(leaf.reason, /P0 does not require a PDP-1 operation contract as a prerequisite/u);

  const stream = row("MPSEM-0181-C001").ownerSemanticReview;
  assert.ok(stream.materialBindings.some((binding) => binding.ref.endsWith("#coverageRule") && binding.requiredSourcePhrase === "Every scoped capability below is a finite semantic leaf."));

  const quality = row("MPSEM-0278-C001").ownerSemanticReview;
  assert.deepEqual(quality.exactContractRefs, [".product-experience/pdp-0-product-truth/qualification-policy.yaml#/decisionRules/6"]);
  const qualityRecord = row("MPSEM-0278-C001");
  const currentQualityTargetRef = ".product-experience/pdp-0-product-truth/qualification-policy.yaml#/decisionRules/6";
  assert.equal(qualityRecord.priorLocatorRef, ".product-experience/pdp-0-product-truth/qualification-policy.yaml#/decisionRules/5", "historical source locator is retained");
  assert.equal(qualityRecord.currentProposalObservation.currentTargetRef, currentQualityTargetRef);
  assert.notEqual(qualityRecord.currentProposalObservation.currentTargetRef, qualityRecord.priorLocatorRef, "current review cannot resolve through the stale selector");
  const selectedQualityRule = resolveRef(quality.proposedTargetRef).value;
  const selectedQualityRuleHash = currentHash(selectedQualityRule);
  assert.equal(quality.proposedTargetRef, currentQualityTargetRef);
  assert.equal(selectedQualityRuleHash, "1761028bd34799e45da3421f4cdd42f89e85ca51c4daddaaa3fbc6532cf20421");
  assert.equal(qualityRecord.currentTargetValueSha256, selectedQualityRuleHash);
  assert.equal(qualityRecord.currentProposalObservation.currentTargetValueSha256, selectedQualityRuleHash);

  const erasure = row("MPSEM-0367-C002").ownerSemanticReview;
  assert.ok(erasure.materialBindings.every((binding) => binding.ref.startsWith(".product-experience/pdp-0-product-truth/state-models.yaml#")));
  assert.equal(erasure.historicalMaterialBindings.length, 3, "superseded P1 material pins remain preserved as history");
  assert.ok(erasure.historicalMaterialBindings.every((binding) => binding.ref.startsWith(".product-experience/pdp-1-domain-data/privacy.yaml#")));

  const cli = row("MPSEM-0475-C003").ownerSemanticReview;
  assert.equal(cli.runtimeStatus, "NOT_EVALUATED");
  assert.match(cli.reason, /no executable, runtime support, or admission is claimed/u);
  assert.ok(cli.exactContractRefs.some((ref) => ref.endsWith("/channels/@id=media.channel.cli/evidence")));
  assert.ok(cli.exactContractRefs.some((ref) => ref.endsWith("/commandSurfaceSeparationRule/executionAdmission")));
});

test("P0 migration review selections reject unrelated or weakened source material", () => {
  const cli = row("MPSEM-0475-C003").ownerSemanticReview;
  const unrelated = structuredClone(cli);
  unrelated.exactContractRefs[0] = ".product-experience/pdp-0-product-truth/capabilities.yaml#coverageRule";
  unrelated.proposedTargetRef = unrelated.exactContractRefs[0];
  assert.notDeepEqual(unrelated.exactContractRefs, cli.exactContractRefs, "generic capability coverage is not CLI evidence");

  const leaf = row("MPSEM-0078-C003").ownerSemanticReview;
  assert.equal(leaf.reason.includes("operation contract is a P0 prerequisite"), false);
  const erasure = row("MPSEM-0367-C002").ownerSemanticReview;
  assert.ok(erasure.materialPredicates.includes("do-not-claim-remote-recall"));
  const cliAdmission = cli.materialBindings.find((binding) => binding.ref.endsWith("/executionAdmission"));
  assert.equal(cliAdmission.requiredSourcePhrase, "NOT_ADMITTED");
});

function assertCurrentReviewRecord(record) {
  const owner = row(record.claimId);
  const review = owner.ownerSemanticReview;
  assert.equal(record.ownerPhase, "PDP-0");
  assert.equal(owner.ownerPhase, "PDP-0");
  assert.deepEqual(record.materials.map(({ targetRef }) => targetRef), review.exactContractRefs);
  for (let i = 0; i < record.materials.length; i += 1) {
    const material = record.materials[i];
    const binding = review.materialBindings[i];
    const { source, value } = resolveRef(material.targetRef);
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    assert.equal(material.requiredSourcePhrase, binding.requiredSourcePhrase);
    assert.ok(material.currentSourceFileSha256, "PXD-139 historical current-source file pin remains present");
    assert.ok(material.currentTargetValueSha256, "PXD-139 historical target pin remains present");
    const refreshed = currentSourceSupplement.records.find((item) => item.claimId === record.claimId)?.materials.find((item) => item.targetRef === material.targetRef);
    assert.ok(refreshed, `${record.claimId} has an additive current-source observation`);
    assert.equal(refreshed.historicalCurrentSourceFileSha256, material.currentSourceFileSha256);
    assert.equal(refreshed.historicalCurrentTargetValueSha256, material.currentTargetValueSha256);
    assert.match(refreshed.currentSourceFileSha256, /^[a-f0-9]{64}$/u,
      "stored observation retains its recorded source cut; currentness requires an exact current successor");
    assert.match(refreshed.currentTargetValueSha256, /^[a-f0-9]{64}$/u,
      "stored observation retains its recorded selected-value cut");
    if (refreshed.currentSourceSuccessorRef) assert.match(refreshed.currentSourceSuccessorRef,
      /pdp0-migration-current-source-successor-pxd(?:185|196|206)\.json/u,
      "the current pointer may reference the latest additive successor while earlier successors remain history");
    assert.equal(serialized.includes(material.requiredSourcePhrase), true, `${record.claimId} phrase remains present in exact target`);
    assert.match(material.targetRef, /^\.product-experience\/pdp-0-product-truth\//u, `${record.claimId} target remains in PDP-0 owner boundary`);
  }
}

test("PXD-139 P0 migration material proposal pins exact claims, source history, and current owner targets", () => {
  const ids = ["MPSEM-0078-C003", "MPSEM-0181-C001", "MPSEM-0278-C001", "MPSEM-0367-C002", "MPSEM-0475-C003"];
  assert.equal(currentReview.decisionRef, ".product-experience/decision-log.md#PXD-139");
  assert.equal(currentReview.authorizationStatus, "APPROVED_BOUNDED_OWNER_SOURCE_SEMANTIC_ROUTE");
  assert.equal(currentReview.status, "APPROVED_BOUNDED_OWNER_SOURCE_SEMANTIC_ROUTE");
  assert.equal(currentReview.acceptanceEffect, "none");
  assert.equal(currentReview.runtimeStatus, "NOT_EVALUATED");
  assert.equal(currentReview.cliAdmission, "NOT_ADMITTED");
  assert.deepEqual(currentReview.records.map(({ claimId }) => claimId), ids);

  for (const record of currentReview.records) {
    const owner = row(record.claimId);
    assert.equal(record.coordinatorDisposition, "APPROVED_BOUNDED_OWNER_SOURCE_SEMANTIC_ROUTE");
    assert.equal(record.coordinatorDecisionRef, currentReview.decisionRef);
    const planPath = resolve(root, record.source.ref.split("#", 1)[0]);
    const currentPlan = readFileSync(planPath, "utf8");
    assert.equal(record.source.textSha256, owner.sourceTextSha256);
    assert.equal(record.source.exactText, owner.exactSourceText);
    assert.equal(sha(record.source.exactText), record.source.textSha256, `${record.claimId} exact source text hash`);
    assert.equal(currentPlan.includes(record.source.exactText), true, `${record.claimId} exact source text remains in the source plan`);
    assert.equal(record.ownerProposalObservation.status, "PENDING_COORDINATOR_MATERIAL_REVIEW",
      `${record.claimId} preserves the PXD-139 historical pending disposition`);
    assert.ok(record.ownerProposalObservation.priorSourceFileSha256, `${record.claimId} retains the pre-review source pin`);
    if (record.ownerProposalObservation.previousCurrentSourceFileSha256)
      assert.match(record.ownerProposalObservation.previousCurrentSourceFileSha256, /^[a-f0-9]{64}$/u);
    assertCurrentReviewRecord(record);
  }

  const cli = currentReview.records.find(({ claimId }) => claimId === "MPSEM-0475-C003");
  assert.equal(cli.cliAdmission, "NOT_ADMITTED");
  assert.ok(cli.materials.some(({ targetRef }) => targetRef.endsWith("/channels/@id=media.channel.cli/evidence")));
  assert.ok(cli.materials.some(({ targetRef, currentTargetPreview }) => targetRef.endsWith("/executionAdmission") && currentTargetPreview === "NOT_ADMITTED"));
});

test("PXD-139 proposal validator rejects foreign or weakened targets", () => {
  const leaf = structuredClone(currentReview.records.find(({ claimId }) => claimId === "MPSEM-0078-C003"));
  const foreign = structuredClone(leaf);
  foreign.materials[0].targetRef = ".product-experience/pdp-1-domain-data/privacy.yaml#ownerDefinedErasureInventoryContract";
  assert.throws(() => assertCurrentReviewRecord(foreign));

  const weakened = structuredClone(leaf);
  weakened.materials[0].targetRef = ".product-experience/pdp-0-product-truth/capabilities.yaml#coverageRule";
  assert.throws(() => assertCurrentReviewRecord(weakened));
  const quality = currentReview.records.find(({ claimId }) => claimId === "MPSEM-0278-C001");
  const currentQualityTargetRef = ".product-experience/pdp-0-product-truth/qualification-policy.yaml#/decisionRules/6";
  assert.deepEqual(quality.materials.map(({ targetRef }) => targetRef), [currentQualityTargetRef]);
  assert.equal(quality.ownerProposalObservation.currentTargetRef, currentQualityTargetRef);
  assert.equal(quality.materials[0].currentTargetValueSha256, "1761028bd34799e45da3421f4cdd42f89e85ca51c4daddaaa3fbc6532cf20421");
});
