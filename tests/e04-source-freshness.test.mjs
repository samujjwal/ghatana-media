import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const pins = JSON.parse(await readFile(".product-experience/explorer/e04-source-pins.json", "utf8"));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function staleSources(sourcePins, readSource) {
  return sourcePins.sources.flatMap(({ path, sha256: expected }) => {
    const actual = sha256(readSource(path));
    return actual === expected ? [] : [{ path, expected, actual }];
  });
}

test("E-04 fixture and browser-audit byte fingerprints are unchanged", async () => {
  assert.equal(pins.schemaVersion, "media.e04-source-pins.v1");
  assert.match(pins.authority, /negative drift check only/u);
  assert.equal(pins.sources.length, 4);
  assert.equal(new Set(pins.sources.map(({ path }) => path)).size, pins.sources.length);
});

test("E-04 drift check detects changed bytes and reports the exact source", () => {
  const oneSource = { sources: [{ path: "fixture.ts", sha256: sha256("original") }] };
  assert.deepEqual(staleSources(oneSource, () => Buffer.from("changed")), [{
    path: "fixture.ts",
    expected: sha256("original"),
    actual: sha256("changed"),
  }]);
});

test("E-04 browser-harness pin changes preserve each reviewed semantic delta", async () => {
  const sourcePin = pins.sources.find(({ path }) => path === "scripts/check-experience-browser.mjs");
  const review = pins.reviewedSourceDeltas?.find(({ path, currentSha256 }) => path === sourcePin?.path && currentSha256 === sourcePin?.sha256);
  assert.ok(review, "browser harness pin updates must include a source review record");
  assert.equal(review.currentSha256, sourcePin.sha256);
  assert.notEqual(review.previousSha256, review.currentSha256);
  assert.match(review.semanticDiff.join("\n"), /15 Explorer modes.*five visible task-first.*remaining ten workspaces/u);
  assert.match(review.semanticDiff.join("\n"), /aria-current=page.*labelled region/u);
  assert.match(review.semanticDiff.join("\n"), /all primary and secondary mode buttons.*all 15 labels/u);
  assert.match(review.focusedVerification, /zero overflow/u);
  assert.match(review.acceptanceEffect, /No product workflow semantics.*P3 screen acceptance/u);

  const priorReview = pins.reviewedSourceDeltas.find(({ path, currentSha256 }) => path === sourcePin.path && currentSha256 === review.previousSha256);
  assert.ok(priorReview, "browser-harness source review history must connect the previous pin to the current pin");
  assert.match(priorReview.semanticDiff.join("\n"), /data-screen-id.*screenId/u);
  assert.match(priorReview.semanticDiff.join("\n"), /cross-phase canonical-ID search/u);
  assert.match(priorReview.semanticDiff.join("\n"), /CSP.*securitypolicyviolation/u);
  assert.match(priorReview.acceptanceEffect, /No P3 semantic acceptance/u);

  const source = await readFile(sourcePin.path, "utf8");
  assert.ok(source.includes("renderedScreenId !== sourceScreenId"));
  assert.ok(source.includes('window.addEventListener("securitypolicyviolation"'));
  assert.ok(source.includes('nav[aria-label="Primary Explorer activities"] button[data-mode], nav[aria-label="Additional Explorer views"] button[data-mode]'));
  assert.ok(source.includes("longLabelAudit.length"));
});

test("E-04 retry-fixture source pin changes have bounded semantic review", () => {
  const retrySourcePaths = [
    ".product-experience/pdp-3-product-experience/scenario-fixture-registry.yaml",
    ".product-experience/explorer/scenario-fixtures.yaml",
    "libs/media-experience-simulation/src/fixtures.ts",
  ];
  for (const path of retrySourcePaths) {
    const sourcePin = pins.sources.find((source) => source.path === path);
    const review = pins.reviewedSourceDeltas.find((delta) => delta.path === path && delta.currentSha256 === sourcePin?.sha256);
    assert.ok(review, `${path} pin changes require a current semantic-diff record`);
    assert.notEqual(review.previousSha256, review.currentSha256);
    assert.ok(review.semanticDiff.length > 0);
    assert.match(review.semanticDiff.join("\n"), /job-retry-ineligible/u);
    assert.match(review.acceptanceEffect, /No retry policy/u);
  }
  const registryReview = pins.reviewedSourceDeltas.find(({ path }) => path === retrySourcePaths[0]);
  const indexReview = pins.reviewedSourceDeltas.find(({ path }) => path === retrySourcePaths[1]);
  const seedReview = pins.reviewedSourceDeltas.find(({ path }) => path === retrySourcePaths[2]);
  assert.match(registryReview.semanticDiff.join("\n"), /job-retry-eligible proposal-only/u);
  assert.match(indexReview.semanticDiff.join("\n"), /denominator remains 31/u);
  assert.match(seedReview.semanticDiff.join("\n"), /same job, state, and event count unchanged/u);

  const registryCurrent = pins.sources.find(({ path }) => path === retrySourcePaths[0]);
  const registryDelta = pins.reviewedSourceDeltas.find(({ path, currentSha256 }) => path === retrySourcePaths[0] && currentSha256 === registryCurrent.sha256);
  const priorRegistryDelta = pins.reviewedSourceDeltas.find(({ path, currentSha256 }) => path === retrySourcePaths[0] && currentSha256 === registryDelta.previousSha256);
  assert.ok(priorRegistryDelta, "scenario registry source review preserves the previous pinned cut");
  assert.match(registryDelta.semanticDiff.join("\n"), /synthetic.*pre-dispatch/u);
  assert.match(registryDelta.semanticDiff.join("\n"), /no retry is dispatched/u);
  assert.match(registryDelta.acceptanceEffect, /No retry policy/u);

  const seedCurrent = pins.sources.find(({ path }) => path === retrySourcePaths[2]);
  const seedDelta = pins.reviewedSourceDeltas.find(({ path, currentSha256 }) => path === retrySourcePaths[2] && currentSha256 === seedCurrent.sha256);
  const priorSeedDelta = pins.reviewedSourceDeltas.find(({ path, currentSha256 }) => path === retrySourcePaths[2] && currentSha256 === seedDelta.previousSha256);
  assert.ok(priorSeedDelta, "fixture source review preserves the previous pinned cut");
  assert.match(seedDelta.focusedVerification, /51\/51 Node tests passed/u);
  assert.equal(seedDelta.verificationLogRef, "docs/implementation/verification/pdp-38/e04-retry-fixture-simulation-tests.log");
  assert.match(seedDelta.semanticDiff.join("\n"), /synthetic eligibility evidence is supplied test data/u);
  assert.match(seedDelta.acceptanceEffect, /No retry policy/u);
});

test("E-04 pin paths resolve to the exact observed source bytes", async () => {
  const stale = [];
  for (const source of pins.sources) {
    const bytes = await readFile(source.path);
    const actual = sha256(bytes);
    if (actual !== source.sha256) stale.push({ path: source.path, expected: source.sha256, actual });
  }
  assert.deepEqual(stale, [], `source drift detected: ${JSON.stringify(stale)}`);
});
