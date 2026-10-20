import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const observationPath = "docs/implementation/verification/pdp-38/p0-capability-intent-owner-binding-current-source-observation.json";
const semanticReviewPath = "docs/implementation/verification/pdp-38/p0-capability-semantic-current-source-review.json";
const correctionReviewPath = "docs/implementation/verification/pdp-38/p0-existing-operation-semantic-corrections-current-source-review.json";
const uploadCorrectionReviewPath = "docs/implementation/verification/pdp-38/p0-upload-byte-length-minimum-current-source-review.json";
const currentCorrectionsReviewPath = "docs/implementation/verification/pdp-38/p0-capability-corrections-current-source-review-current.json";
const sourcePath = ".product-experience/pdp-0-product-truth/capabilities.yaml";
const read = (path) => readFileSync(resolve(root, path));

test("P0 owner intent binding observation pins the exact 462-leaf source delta without acceptance effect", () => {
  const observation = JSON.parse(read(observationPath).toString("utf8"));
  const semanticReview = JSON.parse(read(semanticReviewPath).toString("utf8"));
  const correctionReview = JSON.parse(read(correctionReviewPath).toString("utf8"));
  const uploadCorrectionReview = JSON.parse(read(uploadCorrectionReviewPath).toString("utf8"));
  const currentCorrectionsReview = JSON.parse(read(currentCorrectionsReviewPath).toString("utf8"));
  const bytes = read(sourcePath);
  const capabilities = parse(bytes.toString("utf8"));
  const ownerLeafReview = parse(read(".product-experience/pdp-0-product-truth/capability-leaf-review.yaml").toString("utf8"));
  const campaignExtensions = parse(read(".product-experience/pdp-0-product-truth/campaign-extensions.yaml").toString("utf8"));
  const canonicalIds = new Set(ownerLeafReview.ownerCapabilityLeafAdjudication.records.map(({ capabilityRef }) => capabilityRef));
  const extensionIds = new Set(campaignExtensions.currentDefinitionPopulation.records.map(({ capabilityId }) => capabilityId));
  const leaves = capabilities.capabilities.filter(({ id }) => canonicalIds.has(id));
  const sha = (value) => createHash("sha256").update(value).digest("hex");
  const ids = leaves.map(({ id }) => id).sort();
  const dispositionRows = leaves.map(({ id, ownerDefinition }) => [id, ownerDefinition?.ownerDisposition]);
  const dispositionCounts = Object.fromEntries([...new Set(dispositionRows.map(([, disposition]) => disposition))]
    .sort().map((disposition) => [disposition, dispositionRows.filter(([, value]) => value === disposition).length]));
  assert.equal(observation.source.currentSha256, semanticReview.source.historicalComparison.priorSha256,
    "PXD-121 remains pinned to its historical owner-binding source cut");
  assert.equal(semanticReview.source.currentSha256, correctionReview.historicalPins.find(({ decisionRef }) => decisionRef.endsWith("#PXD-122")).capabilitySha256,
    "PXD-122 remains pinned to its historical capability source cut");
  assert.equal(uploadCorrectionReview.source.currentSha256, "4b4b4f1ab5d4908c93af5c6b4c2be47008b04f75ac45160a1be5e167edbec42d",
    "PXD-153 remains pinned to its historical capability source cut");
  assert.equal(currentCorrectionsReview.source.currentSha256, "f9a979392587069dbb9c2a653fe9866e9b61ee31192725404ec01e5426291f5d",
    "PXD-171 retains its historical source-cut pin");
  assert.equal(semanticReview.source.historicalComparison.parsedPathDelta, "NOT_ASSERTED");
  assert.equal(observation.source.path, sourcePath);
  assert.equal(observation.source.recordPopulation.count, 462);
  assert.equal(capabilities.capabilities.length, 469, "seven proposals remain separate from the historical owner-adjudicated set");
  assert.equal(extensionIds.size, 7);
  assert.ok([...extensionIds].every((id) => !canonicalIds.has(id)), "proposal IDs are not represented as owner adjudications");
  assert.equal(new Set([...canonicalIds, ...extensionIds]).size, capabilities.capabilities.length,
    "the canonical and proposal populations exactly cover the current definition catalog");
  assert.equal(ids.length, 462);
  assert.equal(new Set(ids).size, 462);
  assert.equal(sha(`${ids.join("\n")}\n`), observation.source.recordPopulation.sortedIdentitySetSha256);
  assert.equal(observation.source.recordPopulation.identitySetChange, "none");
  assert.equal(sha(JSON.stringify(dispositionRows)), observation.source.recordPopulation.ownerDispositionSnapshotSha256);
  assert.deepEqual(dispositionCounts, observation.source.recordPopulation.ownerDispositionCounts);
  assert.deepEqual(dispositionCounts, {
    JOURNEY_STEP_CAPABILITY: 77,
    MACHINE_CAPABILITY_WITH_EXPLICIT_CHANNEL_APPLICABILITY: 383,
    PLATFORM_DEPENDENCY_WITH_EXPLICIT_APPLICABILITY: 2,
  });
  assert.equal(observation.source.recordPopulation.ownerDispositionUnchanged, true);
  assert.equal(observation.decisionRef, "PXD-121");
  assert.equal(observation.semanticEquivalence, "NOT_ASSERTED");
  assert.match(observation.acceptanceEffect, /none/u);
  assert.match(observation.acceptanceEffect, /P0-010 semantic acceptance remains pending/u);
  assert.equal(observation.changes.length, 5);
  assert.equal(capabilities.ownerDefinedCapabilityIntentBinding.id, observation.authorityRule.id);
  assert.match(capabilities.ownerDefinedCapabilityIntentBinding.exactLeafMeaningRule, /ownerDisposition selects its meaning/u);
  assert.match(capabilities.ownerDefinedCapabilityIntentBinding.exactLeafMeaningRule, /does not relabel journey or platform records as machine capabilities/u);
  assert.match(capabilities.ownerDefinedCapabilityIntentBinding.exactLeafMeaningRule, /without a PDP-1 operation/u);
  for (const leaf of leaves) {
    assert.equal(leaf.ownerDefinition.capabilityIntentId, leaf.id);
    assert.ok(leaf.ownerDefinition.ownerDisposition);
    assert.equal(leaf.intentBindingState, observation.changes[1].current);
    assert.equal(leaf.requirementTraceState, observation.changes[2].current);
    assert.equal(leaf.semanticReferenceScope, observation.authorityRule.id);
  }
});
