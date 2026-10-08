import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const sourcePath = "docs/migration/expert-reviewed-master-plan.md";
const expectedRow = "| J-02 | Upload/import → inspect → usable artifact; interrupted parts, checksum mismatch and quarantine recovery |";

test("bounded MPSEM-0560 review routes only the existing J-02 outcome and recovery claims", () => {
  const review = readYaml(".product-experience/pdp-0-product-truth/migration-semantics-review.yaml");
  const item = review.items.find(({ itemId }) => itemId === "MPSEM-0560");
  const slice = review.reviewedClaimSlices.find(({ sliceId }) => sliceId === "MPSEM-0560-J02-OUTCOME-AND-RECOVERY");
  const source = readFileSync(resolve(root, sourcePath), "utf8").split("\n");
  const historical = execFileSync("git", ["show", "e62514f94c45a4ecbc438d26298bf82b6a6f3d69:" + sourcePath], {
    cwd: root, encoding: "utf8",
  }).split("\n");
  const journey = readYaml(".product-experience/pdp-0-product-truth/journey-catalog.yaml").journeys
    .find(({ id }) => id === "J-02");
  const experience = readYaml(".product-experience/pdp-3-product-experience/journey-contracts/upload-import-and-verify-artifact.yaml");

  assert.ok(item);
  assert.equal(item.classification, "EXECUTION_ONLY", "the source ledger classification is preserved as historical extraction data");
  assert.ok(slice);
  assert.deepEqual(slice.sourceLines, [1298, 1298]);
  assert.deepEqual(slice.currentSourceLines, [1312, 1312]);
  assert.equal(slice.exactText, expectedRow);
  assert.equal(historical[1297].trim(), expectedRow);
  assert.equal(source[1311].trim(), expectedRow);
  assert.equal(slice.reviewStatus, "BOUNDED_SOURCE_REVIEWED");
  assert.equal(slice.acceptanceEffect, "none");
  assert.match(slice.classification, /MIXED_PRODUCT_JOURNEY_INTENT_AND_EXECUTION_RECOVERY/u);

  assert.equal(journey.title, "Upload/import, inspect, and produce a usable artifact");
  assert.deepEqual(journey.outcomeRefs, ["media.goal.understand-media", "media.goal.preserve-source", "media.goal.resolve-safely"]);
  assert.match(journey.criticalNonhappy, /Interrupted parts, checksum mismatch, unsupported format, quarantine/u);
  assert.match(journey.recovery, /Resume only a matching authorized upload/u);
  assert.equal(experience.journeyId, "J-02");
  assert.match(experience.status, /proposal/u);
  assert.match(slice.authorityEffect, /does not accept upload policy/u);
});
