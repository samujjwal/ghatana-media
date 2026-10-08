import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const ledger = JSON.parse(readFileSync(resolve(root, "docs/migration/compatibility-cutover-observation.json"), "utf8"));
const read = (path) => readFileSync(resolve(root, path), "utf8");

test("compatibility ledger preserves canonical-source and unverified-cutover boundary", () => {
  assert.equal(ledger.schemaVersion, "media.compatibility-cutover-observation.v1");
  assert.equal(ledger.authority, "SOURCE_OBSERVATION_ONLY");
  assert.equal(ledger.cutover.status, "NOT_VERIFIED");
  assert.equal(ledger.cutover.releaseOwnerApproval, "UNKNOWN");
  assert.equal(ledger.cutover.productionCutover, "UNKNOWN");
  assert.equal(ledger.cutover.rollbackRehearsal, "UNKNOWN");
  assert.equal(ledger.cutover.remoteReleaseAndBranchCoverage, "UNKNOWN");
  assert.match(read("BOUNDARY.md"), /Current canonical source:.*ghatana:services\/media/u);
  assert.match(read("config/repo-boundary.json"), /"status": "canonical-until-cutover"/u);
});

test("ledger records every observed local Gradle and Docker compatibility path", () => {
  const gradle = ledger.observations.find((item) => item.id === "gradle-coordinate-compatibility");
  assert.ok(gradle);
  assert.equal(gradle.status, "LEGACY_COORDINATE_IS_EXPLICITLY_SUPPORTED_IN_STANDALONE_SETTINGS");
  assert.equal(gradle.evidence.length, 4);
  assert.match(read("settings.gradle.kts"), /val productProjectPrefix = if \(isStandaloneBuild\) "services:media" else "media"/u);
  assert.match(read("settings.gradle.kts"), /project\(":\$productProjectPrefix"\)\.projectDir = rootDir\.parentFile/u);

  const docker = ledger.observations.find((item) => item.id === "docker-build-context-paths");
  assert.ok(docker);
  assert.equal(docker.findings.length, 5);
  assert.ok(docker.findings.every((item) => item.status === "REVIEW_REQUIRED_CONTEXT_OR_SOURCE_MISSING"));
  for (const finding of docker.findings) {
    const source = read(finding.path);
    assert.ok(source.includes(finding.reference), `missing observed Docker reference ${finding.path}: ${finding.reference}`);
    assert.equal(finding.checkoutPresence, "ABSENT");
  }
  assert.equal(docker.findingLimit.includes("context"), true);
});

test("quarantined obsolete workflow paths remain explicitly inactive observations", () => {
  const workflow = ledger.observations.find((item) => item.id === "quarantined-workflow-docker-paths");
  assert.ok(workflow);
  assert.equal(workflow.status, "QUARANTINED_CANDIDATE_CONTAINS_OBSOLETE_PATHS");
  assert.match(read("migration/transfer-receipt.yaml"), /state: quarantined-outside-active-workflow-discovery/u);
  assert.match(read("migration/candidates/root-media/audio-video-ci.yml"), /products\/audio-video\/docker\/Dockerfile\.stt-service/u);
  assert.match(read("migration/candidates/root-media/gitea-audio-video-ci.yml"), /file: docker\/Dockerfile\.stt-service/u);
});

test("local consumer evidence and external gates cannot silently disappear", () => {
  assert.equal(ledger.observations.length, 6);
  assert.equal(ledger.localRepositorySnapshots.length, 9);
  const consumers = ledger.observations.find((item) => item.id === "existing-consumer-and-contract-ledgers");
  assert.ok(consumers);
  assert.equal(consumers.observedConsumers.length, 5);
  assert.equal(consumers.currentTreeSourceReferences.length, 7);
  assert.ok(consumers.limitations.some((item) => item.includes("not an exhaustive scan")));
  assert.deepEqual(ledger.externalGates.map((gate) => gate.id), ["X-04", "X-05", "X-06", "X-09"]);
  for (const item of ledger.observations) {
    for (const evidence of item.evidence ?? []) {
      if (!evidence.path) continue;
      if (existsSync(resolve(root, evidence.path))) {
        assert.ok(read(evidence.path).length > 0, `empty local evidence path ${evidence.path}`);
      }
    }
  }
});
