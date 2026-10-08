import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const manifest = parse(readFileSync(resolve(root, ".product-experience/source-manifest.yaml"), "utf8"));
const crosswalk = JSON.parse(readFileSync(resolve(root, "docs/migration/external-platform-contract-observation.json"), "utf8"));
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

test("generated external-owner observations pin the current sibling source HEADs and files", (t) => {
  assert.match(manifest.externalOwnerObservations.status, /SOURCE_OBSERVATION_ONLY/u);
  const generatedById = new Map(manifest.externalOwnerObservations.repositories.map((repository) => [repository.repositoryId, repository]));

  for (const snapshot of crosswalk.sourceSnapshots) {
    const repositoryId = snapshot.repository.split("/").at(-1);
    const expectedPaths = [...new Set(crosswalk.gates
      .flatMap((gate) => gate.sourceEvidence)
      .filter((evidence) => evidence.repository === snapshot.repository)
      .map((evidence) => evidence.path))].sort();
    const generated = generatedById.get(repositoryId);
    assert.ok(generated, `missing generated external observation for ${repositoryId}`);

    if (!existsSync(snapshot.path)) {
      assert.equal(generated.available, false, `${repositoryId} absence must be explicit`);
      assert.equal(generated.revision, "UNAVAILABLE");
      t.diagnostic(`${repositoryId}: checkout unavailable; generator records unavailable status`);
      continue;
    }

    assert.equal(generated.available, true, `${repositoryId} exists but manifest says unavailable`);
    const head = execFileSync("git", ["-C", snapshot.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(generated.revision, head, `${repositoryId} HEAD pin is stale`);
    const currentWorkingTree = execFileSync("git", ["-C", snapshot.path, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim()
      ? "MODIFIED"
      : "CLEAN";
    assert.equal(generated.workingTree, currentWorkingTree, `${repositoryId} tracked worktree status is stale`);
    const filesByPath = new Map(generated.files.map((file) => [file.path, file]));
    for (const path of expectedPaths) assert.ok(filesByPath.has(path), `${repositoryId}:${path} is absent from generated evidence`);
    assert.equal(filesByPath.size, generated.files.length, `${repositoryId} has duplicate generated paths`);

    for (const path of expectedPaths) {
      const filePath = resolve(snapshot.path, path);
      const observation = filesByPath.get(path);
      if (!existsSync(filePath)) {
        assert.equal(observation.state, "UNAVAILABLE", `${repositoryId}:${path} missing without explicit status`);
        continue;
      }
      assert.equal(observation.sha256, sha256(filePath), `${repositoryId}:${path} hash is stale`);
      assert.equal(observation.state, undefined, `${repositoryId}:${path} is incorrectly marked unavailable`);
    }
  }
});
