import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const overlay = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/media-token-aliases-current-impact.json"), "utf8"));
const aliases = readFileSync(resolve(root, ".product-experience/pdp-2-design-interface-system/media-token-aliases.yaml"), "utf8");
const changes = new Map(overlay.changes.map((change) => [change.path, change]));

test("the current token impact overlay binds exact added source paths without changing historical alias claims", () => {
  assert.equal(overlay.schemaVersion, "media.pdp38-current-source-impact.v1");
  assert.equal(overlay.historicalSourcePin, "4c06c5ad25fbba4cddea43b83f2f39ad4295eb3e2f898a9b50ab5b8cff8c6dbc");
  assert.equal(overlay.currentSourceSha256, "acaf3c0674ff542c77346fb7651a7e5193ac94738cf6be8bbae897d9f2a55637");
  assert.equal(overlay.completeScalarDeltaRecords.length, 21);
  for (const path of [
    "sharedPublicContract.pinnedDevelopmentSnapshotQualification.sourceRevision",
    "sharedPublicContract.pinnedDevelopmentSnapshotQualification.previousReviewedSourceRevision",
    "sharedPublicContract.pinnedDevelopmentSnapshotQualification.result",
    "sharedPublicContract.pinnedDevelopmentSnapshotQualification.limitations",
    "sharedPublicContract.sourceLicenseClassification.observed",
    "sharedPublicContract.sourceLicenseClassification.meaning",
    "sharedPublicContract.profileCoverage.reducedMotion",
    "sharedPublicContract.profileCoverage.forcedColors",
  ]) {
    const record = changes.get(path);
    assert.ok(record, `exact changed path recorded: ${path}`);
    assert.equal(record.oldValue, "ABSENT", path);
    assert.notEqual(record.newValue, undefined, path);
  }
  assert.match(aliases, /sourceRevision: c6d182af472c8954438f219c08d0202d1faa63a3/u);
  assert.match(aliases, /ordinary-workspace-lockfile-and-registry-resolution-unverified/u);
  assert.equal(overlay.unchangedSemanticRecords.aliasCount, 9);
  assert.equal(overlay.unchangedSemanticRecords.semanticAliasValuesChanged, false);
  assert.equal(overlay.acceptanceEffect, "none");
  assert.equal(overlay.phaseAcceptance, "OPEN");
  assert.equal(overlay.independentAcceptance, "OPEN");
});

test("a source impact overlay cannot relabel local source consumption as accepted public API adoption", () => {
  const record = changes.get("sharedPublicContract.pinnedDevelopmentSnapshotQualification.limitations");
  assert.ok(record.newValue.includes("no-registry-publication"));
  assert.ok(record.newValue.includes("no-immutable-release"));
  assert.ok(record.newValue.includes("no-Shared-owner-acceptance"));
  assert.match(overlay.notes, /does not .*convert a local candidate\/source snapshot into a verified public package API/u);
});
