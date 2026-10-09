import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));

const capabilityPath = ".product-experience/pdp-0-product-truth/capabilities.yaml";
const claimId = "MPSEM-0336-C006";

function interruptionContract(capabilities) {
  const watch = capabilities.capabilities.find(({ id }) => id === "media.job.watch");
  assert.ok(watch, "the canonical Media job-watch capability exists");
  const entry = watch.acceptanceCases.find(({ given }) => given.includes("Ctrl-C"));
  assert.ok(entry, "the local interruption has its own acceptance case");
  return { watch, entry };
}

function materiallyValid(capabilities) {
  const { watch, entry } = interruptionContract(capabilities);
  return entry.when.includes("Ctrl-C")
    && entry.when.includes("exit code 130")
    && entry.then.includes("Only the observer stops")
    && entry.then.includes("job and attempt state remain unchanged")
    && entry.then.includes("no remote cancellation is issued")
    && watch.supportDimensions.implementationState === "UNKNOWN"
    && watch.supportDimensions.qualificationState === "NOT_EVALUATED";
}

test("Ctrl-C has exact local-observation semantics and does not imply remote cancellation or failure", () => {
  const capabilities = readYaml(capabilityPath);
  const migration = readYaml(".product-experience/pdp-0-product-truth/migration-semantics-review.yaml");
  const claim = migration.pdp38ClaimReconciliation.records.flatMap((record) => record.claims ?? [])
    .flatMap((record) => record.subclaims ?? [record]).find((record) => record.claimId === claimId);
  assert.ok(claim, `${claimId} remains in the immutable migration claim population`);
  assert.match(claim.exactSourceText, /Ctrl-C stops local observation and exits 130/u);
  assert.equal(claim.semanticReviewStatus, "OWNER_TARGET_LOCATOR_ONLY_PENDING_CLAIM_PARITY",
    "this test supplies owner-source evidence only; the coordinator retains review authority");

  assert.equal(materiallyValid(capabilities), true);
  for (const [field, weakened] of [
    ["exit", (copy) => { interruptionContract(copy).entry.when = "Ctrl-C ends local observation."; }],
    ["remote cancellation", (copy) => { interruptionContract(copy).entry.then = "Only the observer stops; job and attempt state remain unchanged."; }],
    ["remote job state", (copy) => { interruptionContract(copy).entry.then = "Only the observer stops; job state may be cancelled."; }],
  ]) {
    const copy = structuredClone(capabilities);
    weakened(copy);
    assert.equal(materiallyValid(copy), false, `removing ${field} semantics fails the claim-specific oracle`);
  }
});
