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
    assert.equal(observation.currentSourceFileSha256, sha(source));
    assert.equal(observation.currentSourceValueSha256, sha(serialized));
  }
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
    assert.equal(material.currentSourceFileSha256, sha(source));
    assert.equal(material.currentTargetValueSha256, sha(serialized));
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
    assert.deepEqual(record.ownerProposalObservation, owner.currentProposalObservation,
      `${record.claimId} preserves owner proposal status and history without promotion`);
    assert.equal(record.ownerProposalObservation.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
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
