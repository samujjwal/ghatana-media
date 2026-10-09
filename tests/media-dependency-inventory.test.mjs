import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { assertNoDenominatorShrink, buildMediaDependencyInventory } from "../scripts/lib/media-dependency-inventory.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const EXPECTED_DENOMINATORS = Object.freeze({
  packageManifestCount: 9,
  pnpmImporterCount: 57,
  pnpmLockedPackageCount: 328,
  cargoManifestCount: 4,
  cargoLockfileCount: 2,
  cargoLockedPackageCount: 114,
  gradleDeclarationCount: 315,
  dockerfileCount: 9,
  pythonDependencyManifestCount: 0,
  trackedAssetOrFixtureCount: 31,
  modelOrWeightBinaryCount: 0,
  fontBinaryCount: 0,
  gradleLockOrVerificationFileCount: 0,
  ghatanaCandidateCount: 15,
  externalCandidateCount: 23,
  licenseExceptionCount: 1,
});
const RESPONSIVE_CAPTURE_DIRECTORY = "docs/implementation/verification/pdp-38/responsive-reference-captures";
const RESPONSIVE_CAPTURE_MANIFEST = `${RESPONSIVE_CAPTURE_DIRECTORY}/manifest.json`;

test("dependency inventory preserves current source denominators and lock membership", () => {
  const report = buildMediaDependencyInventory(root);
  assertNoDenominatorShrink(report, EXPECTED_DENOMINATORS);
  const asyncTestSupport = report.gradle.declaredDependencies.filter(({ coordinate }) =>
    coordinate === 'com.ghatana.platform:tool-test-support');
  assert.equal(asyncTestSupport.length, 1, 'async handler regression uses one explicit public test-support dependency');
  assert.equal(asyncTestSupport[0].configuration, 'testImplementation');
  assert.equal(asyncTestSupport[0].distributionProfile, 'TEST_ONLY');
  assert.deepEqual(report.denominators, EXPECTED_DENOMINATORS);
  // Historical baseline: 21 tracked assets/fixtures. The current PDP-3
  // scenario fixture registry is a newly tracked source fixture, making the
  // baseline denominator 22 before the nine reviewed responsive captures.
  const currentScenarioRegistry = report.trackedAssets.find(({ path }) =>
    path === ".product-experience/pdp-3-product-experience/scenario-fixture-registry.yaml");
  assert.ok(currentScenarioRegistry, "current denominator includes the source-owned PDP-3 scenario fixture registry");
  assert.equal(currentScenarioRegistry.kind, "SOURCE_FIXTURE_OR_TEST_DATA");
  assert.equal(currentScenarioRegistry.sha256, `sha256:${createHash("sha256").update(readFileSync(resolve(root, currentScenarioRegistry.sourceRef))).digest("hex")}`);
  // Eight committed browser-reference screenshots joined the tracked inventory.
  // They are evidence inputs, not a license or independent-review receipt.
  const browserScreenshots = report.trackedAssets.filter(({ path }) =>
    path.startsWith("docs/implementation/verification/media-experience-browser-audit-2026-10-08/screenshots/"));
  assert.deepEqual(browserScreenshots.map(({ path }) => path.split("/").at(-1)), [
    "candidate-edit-captions-desktop.png", "candidate-edit-captions-narrow-mobile.png",
    "explore-desktop.png", "explore-narrow-mobile.png",
    "specification-desktop.png", "specification-narrow-mobile.png",
    "verify-desktop.png", "verify-narrow-mobile.png",
  ]);
  assert.ok(browserScreenshots.every(({ licenseReview }) => licenseReview === "REVIEW_REQUIRED"));
  assert.equal(report.pnpmLock.packages.length, EXPECTED_DENOMINATORS.pnpmLockedPackageCount);
  assert.equal(report.cargo.lockedPackages.length, EXPECTED_DENOMINATORS.cargoLockedPackageCount);
  assert.equal(report.gradle.declaredDependencies.length, EXPECTED_DENOMINATORS.gradleDeclarationCount);
  assert.equal(report.pnpmLock.packages.filter((item) => item.distributionProfile === "LOCKED_BUT_NO_IMPORTED_PROFILE_RESOLVED").length, 0);
});

test("source pins cover the exact manifests, locks, policy authorities, and asset inputs", () => {
  const report = buildMediaDependencyInventory(root);
  const pins = new Map(report.sourcePins.map((item) => [item.path, item]));
  for (const path of [
    "package.json", "pnpm-lock.yaml", "Cargo.toml", "Cargo.lock",
    "modules/intelligence/speech/libs/speech-audio-rust/Cargo.toml",
    "modules/intelligence/speech/libs/speech-audio-rust/Cargo.lock",
    "gradle/libs.versions.toml", "gradle.properties",
    ".product-experience/pdp-0-product-truth/reuse-decisions.yaml",
    ".product-experience/pdp-0-product-truth/qualification-policy.yaml",
    "docker/Dockerfile.ai-voice",
    "scripts/lib/media-dependency-inventory.mjs",
    "scripts/report-media-dependency-inventory.mjs",
    "tests/media-dependency-inventory.test.mjs",
  ]) assert.ok(pins.has(path), `missing source pin for ${path}`);
  for (const pin of report.sourcePins) {
    assert.match(pin.sha256, /^sha256:[a-f0-9]{64}$/u, `invalid digest for ${pin.path}`);
    assert.equal(pin.sha256, `sha256:${createHash("sha256").update(readFileSync(resolve(root, pin.path))).digest("hex")}`);
  }
});

test("nine responsive reference PNGs are pinned as local test evidence, not licensed runtime assets", () => {
  const manifest = JSON.parse(readFileSync(resolve(root, RESPONSIVE_CAPTURE_MANIFEST), "utf8"));
  const captures = manifest.captures.filter(({ screenshot }) => screenshot);
  const expectedNames = [
    "job-status-medium-768.png", "job-status-narrow-390.png", "job-status-wide-1280.png",
    "review-transcript-medium-768.png", "review-transcript-narrow-390.png", "review-transcript-wide-1280.png",
    "work-in-project-medium-768.png", "work-in-project-narrow-390.png", "work-in-project-wide-1280.png",
  ].sort();
  assert.equal(captures.length, 9);
  assert.deepEqual(captures.map(({ screenshot }) => screenshot).sort(), expectedNames);
  assert.deepEqual(readdirSync(resolve(root, RESPONSIVE_CAPTURE_DIRECTORY)).filter((name) => name.endsWith(".png")).sort(), expectedNames);
  for (const capture of captures) {
    const file = `${RESPONSIVE_CAPTURE_DIRECTORY}/${capture.screenshot}`;
    const bytes = readFileSync(resolve(root, file));
    assert.equal(capture.screenshotSha256, createHash("sha256").update(bytes).digest("hex"), `${file} hash matches the capture manifest`);
    assert.match(capture.status, /RENDERED_SIMULATION_FIXTURE/u);
    assert.match(capture.status, /NOT_ADMITTED/u);
    assert.match(capture.status, /NOT_ACCEPTANCE/u);
    assert.equal(capture.structuralChecks?.admittedRuntime, false);
    assert.equal(capture.structuralChecks?.humanComprehension, "NOT_RUN");
    assert.equal(capture.structuralChecks?.accessibilityAcceptance, "NOT_RUN");
  }
  assert.ok(captures.every(({ screenshotSha256 }) => /^([a-f0-9]{64})$/u.test(screenshotSha256)));
  // The repository inventory is git-index based. Before integration, the
  // historical/current baseline is 22; once the nine captured PNGs are indexed,
  // the exact final denominator is 31.
  const report = buildMediaDependencyInventory(root);
  const indexedCaptures = report.trackedAssets.filter(({ path }) => path.startsWith(`${RESPONSIVE_CAPTURE_DIRECTORY}/`) && path.endsWith(".png"));
  assert.ok(indexedCaptures.length === 0 || indexedCaptures.length === captures.length,
    "all nine responsive captures enter the tracked inventory together");
  assert.equal(report.denominators.trackedAssetOrFixtureCount, 22 + indexedCaptures.length);
  if (indexedCaptures.length === captures.length) {
    assert.equal(report.denominators.trackedAssetOrFixtureCount, 31);
    assert.ok(indexedCaptures.every(({ licenseReview, distributionProfile }) =>
      licenseReview === "REVIEW_REQUIRED" && distributionProfile === "TEST_ONLY_UNLESS_SEPARATELY_PACKAGED"));
  }
  assert.ok(report.trackedAssets.every(({ licenseReview }) => licenseReview === "REVIEW_REQUIRED"));
});

test("the inventory keeps legal, transitive, codec, model, and font states unresolved", () => {
  const report = buildMediaDependencyInventory(root);
  assert.equal(report.authority, "NON_AUTHORITATIVE_SOURCE_INVENTORY_ONLY");
  assert.equal(report.status.licenseAdmission, "UNKNOWN_OR_REVIEW_REQUIRED");
  assert.equal(report.status.patentReview, "REVIEW_REQUIRED");
  assert.equal(report.status.transitiveDependencyReview, "REVIEW_REQUIRED");
  assert.equal(report.status.codecAndContainerChain, "REVIEW_REQUIRED; source selection does not establish an assembled, licensed, qualified chain");
  assert.equal(report.status.modelWeightRights, "NO_TRACKED_WEIGHT_BYTES_FOUND; RUNTIME_OR_EXTERNAL_WEIGHTS_REMAIN_UNKNOWN");
  assert.equal(report.status.fontRights, "NO_TRACKED_FONT_BYTES_FOUND; EXTERNAL_OR_RUNTIME_FONTS_REMAIN_UNKNOWN");
  assert.ok(report.containers.inputs.some((item) => item.reference === "python:3.11-slim-bookworm" && !item.exactDigestPinned));
  assert.ok(report.containers.unresolvedBuildReferences.some((item) => item.path === "modules/intelligence/ai-voice/requirements.txt"));
  assert.ok(report.trackedAssets.every((item) => item.licenseReview === "REVIEW_REQUIRED"));
  assert.equal(report.candidatePolicies.technologyCandidates.length, 38);
  assert.ok(report.candidatePolicies.technologyCandidates.every((item) => item.licenseAdmission === "NOT_ADMITTED_BY_SELECTION_RECORD" && item.patentReview === "REVIEW_REQUIRED"));
  assert.equal(report.candidatePolicies.exceptions[0]?.licenseAdmission, "OWNER_DISPOSITION_REQUIRED");
});

test("denominator shrink is a hard regression", () => {
  const report = buildMediaDependencyInventory(root);
  const shrunken = { ...report, denominators: { ...report.denominators, pnpmLockedPackageCount: report.denominators.pnpmLockedPackageCount - 1 } };
  assert.throws(() => assertNoDenominatorShrink(shrunken, EXPECTED_DENOMINATORS), /pnpmLockedPackageCount: shrank from 328 to 327/u);
});
