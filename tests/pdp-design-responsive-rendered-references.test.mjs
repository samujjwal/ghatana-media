import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidence = path.join(root, "docs/implementation/verification/pdp-38/responsive-reference-captures");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = (relative) => readFile(path.join(root, relative));

test("responsive reference evidence covers only the implemented views and exact three bands", async () => {
  const manifest = JSON.parse(await readFile(path.join(evidence, "manifest.json"), "utf8"));
  assert.equal(manifest.captures.length, 9);
  assert.deepEqual([...new Set(manifest.captures.map((capture) => capture.viewRef))].sort(), [
    "media.view.job-status", "media.view.review-transcript", "media.view.work-in-project",
  ]);
  assert.deepEqual([...new Set(manifest.captures.map((capture) => capture.viewport.widthCssPx))].sort((a, b) => a - b), [390, 768, 1280]);
  assert.equal(manifest.captures.every((capture) => capture.status === "RENDERED_SIMULATION_FIXTURE; NOT_ADMITTED; NOT_ACCEPTANCE"), true);
  assert.equal(manifest.captures.every((capture) => capture.structuralChecks.controlsVisible), true);
  assert.equal(manifest.captures.every((capture) => capture.structuralChecks.humanComprehension === "NOT_RUN" && capture.structuralChecks.accessibilityAcceptance === "NOT_RUN"), true);
});

test("captured pixels and source/prop fingerprints match the recorded evidence", async () => {
  const manifest = JSON.parse(await readFile(path.join(evidence, "manifest.json"), "utf8"));
  for (const [source, expected] of Object.entries(manifest.sourceFingerprints)) assert.equal(digest(await read(source)), expected, `${source} fingerprint`);
  for (const capture of manifest.captures) {
    const image = await readFile(path.join(evidence, capture.screenshot));
    assert.equal(digest(image), capture.screenshotSha256, capture.screenshot);
    assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${capture.screenshot} PNG signature`);
    assert.equal(image.readUInt32BE(16), capture.viewport.widthCssPx, `${capture.screenshot} width`);
    assert.equal(digest(Buffer.from(JSON.stringify(capture.propProjection))), capture.propProjectionSha256, `${capture.screenshot} props`);
    assert.equal(digest(await read(capture.contractPath)), capture.contractSha256, `${capture.contractPath} fingerprint`);
  }
});

test("critical composition facts are visible and unsupported rights view remains an explicit gap", async () => {
  const manifest = JSON.parse(await readFile(path.join(evidence, "manifest.json"), "utf8"));
  const workProject = manifest.captures.filter((capture) => capture.viewRef === "media.view.work-in-project");
  assert.equal(workProject.length, 3);
  for (const capture of workProject) {
    assert.deepEqual(capture.missingCriticalFacts, []);
    assert.equal(capture.structuralChecks.criticalFactsVisible, true);
    assert.equal(capture.criticalFactsObserved.some((fact) => fact.fact === "project-version" && fact.expectedText === "project-v1"), true);
  }
  assert.equal(manifest.contractOnly.viewRef, "media.view.review-rights-and-consent");
  assert.equal(manifest.contractOnly.status, "CONTRACT_ONLY_NO_RENDERED_REFERENCE");
  assert.equal(manifest.contractOnly.notCapturedAtBands.length, 3);
  assert.match(manifest.contractOnly.missingRenderDependency, /no rights-and-consent view route or MediaProductRenderer kind/u);
  const rightsComponent = manifest.contractOnly.requiredReusableComponentContracts.find(({ componentId }) => componentId === "media.component.rights-retention-review");
  assert.equal(rightsComponent.contractStatus, "OWNER_DEFINED_TYPED_COMPONENT_CONTRACT; INDEPENDENT_REVIEW_OPEN");
  assert.deepEqual(rightsComponent.requiredProps, ["subjectVersionRef", "authorityRef", "rightOrConsent", "scope", "validity", "retentionDisposition", "decisionHistory", "nextActions", "state", "variant", "actionIntents", "keyboardBehavior"]);
  assert.match(manifest.contractOnly.actionAdapterDependency, /actionConsequences$/u);
  assert.deepEqual(manifest.limits.includes("No human comprehension study or independent accessibility review was performed"), true);
});
