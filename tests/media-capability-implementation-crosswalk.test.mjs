import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const requireTools = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse: parseYaml } = requireTools("yaml");

const artifact = JSON.parse(readFileSync(resolve(root, "docs/development/capability-implementation-crosswalk.v1.json"), "utf8"));
const capabilities = parseYaml(readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/capabilities.yaml"), "utf8"));
const register = JSON.parse(readFileSync(resolve(root, "docs/development/remaining-work.json"), "utf8"));
const taskState = new Map(register.tasks.map((task) => [task.id, task.state]));

test("every authored capability leaf is classified exactly once with no unknown intents", () => {
  const leafIds = capabilities.capabilities.map((leaf) => leaf.id);
  const recordIds = artifact.records.map((record) => record.id);
  assert.equal(recordIds.length, new Set(recordIds).size, "crosswalk records are unique");
  assert.deepEqual([...recordIds].sort(), [...leafIds].sort(), "crosswalk covers every PDP-0 capability leaf exactly");
  assert.equal(artifact.records.filter((record) => !["IMPLEMENTED", "DELEGATED", "OPTIONAL_DEFERRED", "NOT_IMPLEMENTED"].includes(record.classification)).length, 0,
    "no unclassified active intent remains");
  assert.equal(artifact.summary.leafCount, leafIds.length);
});

test("deferred leaves are OPTIONAL_DEFERRED and carry no fabricated blocking work", () => {
  const deferred = capabilities.capabilities.filter((leaf) => leaf.scopeStatus === "DEFERRED").map((leaf) => leaf.id);
  const deferredRecords = artifact.records.filter((record) => record.classification === "OPTIONAL_DEFERRED");
  assert.deepEqual(deferredRecords.map((record) => record.id).sort(), deferred.sort());
  for (const record of deferredRecords) {
    assert.deepEqual(record.blockingTaskRefs, [], `${record.id} must not fake progress through unrelated tasks`);
  }
});

test("no leaf claims IMPLEMENTED without a VERIFIED register task, and all task refs resolve", () => {
  const implemented = artifact.records.filter((record) => record.classification === "IMPLEMENTED");
  for (const record of implemented) {
    assert.ok(record.verifiedTaskRefs.length > 0, `${record.id} claims IMPLEMENTED without VERIFIED evidence`);
  }
  for (const record of artifact.records) {
    for (const taskId of record.blockingTaskRefs) {
      assert.ok(taskState.has(taskId), `${record.id} references missing register task ${taskId}`);
    }
    assert.equal(record.classification === "NOT_IMPLEMENTED" ? record.blockingTaskRefs.length > 0 : true, true,
      `${record.id} NOT_IMPLEMENTED must carry exact blocking task references`);
  }
  for (const record of artifact.records) {
    assert.deepEqual(record.verifiedTaskRefs, record.blockingTaskRefs.filter((id) => taskState.get(id) === "VERIFIED"));
  }
});

test("external dependency attribution stays delegated-consumption, never a hidden second owner", () => {
  const sceneText = artifact.records.filter((record) => record.familyId === "media.vision.scene-text");
  assert.equal(sceneText.length, 2);
  for (const record of sceneText) {
    assert.ok(record.delegatedDependencies.some((dep) => dep.startsWith("document-intelligence-v1-public-client")),
      `${record.id} records the DI public-client dependency per MDI-001`);
    assert.equal(record.classification, "NOT_IMPLEMENTED", `${record.id} is Media-owned scene semantics, not delegated OCR execution`);
    assert.ok(record.blockingTaskRefs.includes("media.dev.vision-document-intelligence"));
  }
  assert.ok(Object.keys(artifact.externalOwnedDependencies).includes("data-cloud-optional-downstream"),
    "Data Cloud remains an explicitly optional downstream dependency, not a core task");
});
