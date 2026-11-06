import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { exportPinned, verifyCopy, MANIFEST_NAME } from "../scripts/prepare-media-historical-export.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const blobSha = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

test("exports pinned blobs and verifies byte, SHA-256, and Git blob identity", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "media-historical-export-")); t.after(() => rm(temp, { recursive: true, force: true }));
  const repo = join(temp, "repo"), destination = join(temp, "copy");
  await mkdir(join(repo, "nested"), { recursive: true });
  git(repo, "init", "-q"); git(repo, "config", "user.email", "test@example.invalid"); git(repo, "config", "user.name", "Fixture");
  const bytes = Buffer.from("fixture blob\0with binary bytes\n");
  await writeFile(join(repo, "nested/data.bin"), bytes);
  git(repo, "add", "."); git(repo, "commit", "-qm", "fixture");
  const commit = git(repo, "rev-parse", "HEAD");
  const preservation = join(temp, "preservation.json");
  await writeFile(preservation, JSON.stringify({ sourceCommit: commit, sourceTree: commit, total: 1, artifacts: [{ path: "nested/data.bin", bytes: bytes.length, sha256: sha(bytes), gitBlobSha: blobSha(bytes) }] }));
  const result = await exportPinned({ repo, destination, preservation });
  assert.equal(result.objects.length, 1);
  assert.deepEqual(await readFile(join(destination, "nested/data.bin")), bytes);
  assert.equal((await verifyCopy({ destination })).verified, 1);
  assert.equal(JSON.parse(await readFile(join(destination, MANIFEST_NAME), "utf8")).objects[0].gitBlobSha, blobSha(bytes));
  await writeFile(join(destination, "nested/data.bin"), Buffer.from("tampered"));
  await assert.rejects(verifyCopy({ destination }), /copy verification failed/u);

  const duplicatePin = join(temp, "duplicate-preservation.json");
  await writeFile(duplicatePin, JSON.stringify({
    sourceCommit: commit,
    sourceTree: commit,
    total: 2,
    artifacts: [
      { path: "nested/data.bin", bytes: bytes.length, sha256: sha(bytes), gitBlobSha: blobSha(bytes) },
      { path: "nested/data.bin", bytes: bytes.length, sha256: sha(bytes), gitBlobSha: blobSha(bytes) },
    ],
  }));
  await assert.rejects(exportPinned({ repo, destination: join(temp, "duplicate-copy"), preservation: duplicatePin }), /duplicate pinned path/u);

  const incorrectPin = join(temp, "incorrect-preservation.json"), incorrectDestination = join(temp, "incorrect-copy");
  await writeFile(incorrectPin, JSON.stringify({
    sourceCommit: commit,
    sourceTree: commit,
    total: 1,
    artifacts: [{ path: "nested/data.bin", bytes: bytes.length, sha256: sha(Buffer.from("wrong")), gitBlobSha: blobSha(bytes) }],
  }));
  await assert.rejects(exportPinned({ repo, destination: incorrectDestination, preservation: incorrectPin }), /written blob verification failed/u);
  assert.deepEqual(await readdir(join(incorrectDestination, "nested")), []);
});

test("verify-copy rejects traversal and symlink escapes", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "media-historical-export-")); t.after(() => rm(temp, { recursive: true, force: true }));
  const destination = join(temp, "copy"); await mkdir(destination);
  const bytes = Buffer.from("safe");
  const entry = { bytes: bytes.length, sha256: sha(bytes), gitBlobSha: blobSha(bytes) };
  const manifestPath = join(temp, "manifest.json");
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: "media.historical-export-manifest/v1", objects: [{ ...entry, path: "../escape" }] }));
  await assert.rejects(verifyCopy({ destination, manifestPath }), /unsafe artifact path/u);
  await writeFile(manifestPath, JSON.stringify({ schemaVersion: "media.historical-export-manifest/v1", objects: [{ ...entry, path: "linked/file" }] }));
  await symlink(temp, join(destination, "linked"));
  await assert.rejects(verifyCopy({ destination, manifestPath }), /unsafe directory component/u);
});
