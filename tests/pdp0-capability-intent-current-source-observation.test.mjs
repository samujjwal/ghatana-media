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
const sourcePath = ".product-experience/pdp-0-product-truth/capabilities.yaml";
const read = (path) => readFileSync(resolve(root, path));

test("P0 owner intent binding observation pins the exact 462-leaf source delta without acceptance effect", () => {
  const observation = JSON.parse(read(observationPath).toString("utf8"));
  const semanticReview = JSON.parse(read(semanticReviewPath).toString("utf8"));
  const bytes = read(sourcePath);
  const capabilities = parse(bytes.toString("utf8"));
  const leaves = capabilities.capabilities;
  const sha = (value) => createHash("sha256").update(value).digest("hex");
  const ids = leaves.map(({ id }) => id).sort();
  const dispositionRows = leaves.map(({ id, ownerDefinition }) => [id, ownerDefinition?.ownerDisposition]);
  const dispositionCounts = Object.fromEntries([...new Set(dispositionRows.map(([, disposition]) => disposition))]
    .sort().map((disposition) => [disposition, dispositionRows.filter(([, value]) => value === disposition).length]));
  assert.equal(observation.source.currentSha256, semanticReview.source.historicalComparison.priorSha256,
    "PXD-121 remains pinned to its historical owner-binding source cut");
  assert.equal(sha(bytes), semanticReview.source.currentSha256,
    "the additive PXD-122 review pins the current capability source");
  assert.equal(semanticReview.source.historicalComparison.parsedPathDelta, "NOT_ASSERTED");
  assert.equal(observation.source.path, sourcePath);
  assert.equal(observation.source.recordPopulation.count, 462);
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
