import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const work = read("docs/development/remaining-work.json");
const preservation = read("docs/development/historical-content-preservation.json");
const inventory = read("docs/implementation/historical-artifact-inventory.v1.json");

test("register counts and source identity coverage come from actual rows", () => {
  const ids = work.tasks.map((task) => task.id);
  assert.equal(ids.length, 103);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(work.surfaces.length, 56);
  assert.equal(work.journeys.length, 30);
  const states = {}, groups = {}, starts = {};
  for (const task of work.tasks) {
    states[task.state] = (states[task.state] ?? 0) + 1;
    groups[task.group] = (groups[task.group] ?? 0) + 1;
    starts[task.workStartReadiness] = (starts[task.workStartReadiness] ?? 0) + 1;
    assert.ok(task.workStartReadiness, task.id);
    assert.equal(task.startApproval, "AUTHORIZED_ORDINARY_MEDIA_ENGINEERING");
    assert.deepEqual(task.integrationPrerequisites, task.requires);
    for (const dep of task.requires) assert.ok(ids.includes(dep), task.id + " -> " + dep);
  }
  assert.deepEqual(work.summary.byState, states);
  assert.deepEqual(work.summary.byGroup, groups);
  assert.deepEqual(work.summary.byWorkStartReadiness, starts);
  for (const surface of work.surfaces) {
    assert.ok(surface.work.length, surface.id);
    for (const ref of surface.work) assert.ok(ids.includes(ref), surface.id + " -> " + ref);
  }
});
test("integration prerequisites form an acyclic dependency graph", () => {
  const byId = new Map(work.tasks.map((t) => [t.id, t]));
  const visiting = new Set(), visited = new Set();
  const dfs = (id) => {
    if (visited.has(id)) return;
    assert.equal(visiting.has(id), false, "cycle at " + id);
    visiting.add(id);
    for (const child of byId.get(id).requires) dfs(child);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of work.tasks) dfs(task.id);
  assert.equal(visited.size, 103);
  assert.match(work.dependencySemantics, /not reasons to postpone/i);
});
test("42 historical artifacts cannot be deleted without immutable off-main readback", () => {
  const flagged = inventory.artifacts.filter((r) => r.disposition === "EXTERNAL_ARCHIVE");
  assert.equal(preservation.total, 42);
  assert.equal(flagged.length, 42);
  assert.equal(preservation.deletionApproved, false);
  assert.equal(preservation.externalArchiveVerified, false);
  const byPath = new Map(preservation.artifacts.map((r) => [r.path, r]));
  assert.equal(byPath.size, 42);
  let bytes = 0;
  for (const item of flagged) {
    const current = byPath.get(item.path);
    assert.ok(current, item.path);
    assert.equal(current.sha256, item.sha256);
    assert.equal(current.bytes, item.bytes);
    assert.match(current.gitBlobSha, /^[a-f0-9]{40}$/u);
    assert.equal(current.deleteApproved, false);
    bytes += item.bytes;
  }
  assert.equal(preservation.bytes, bytes);
});
