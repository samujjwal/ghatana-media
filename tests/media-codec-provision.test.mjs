import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("local codec archive cache is checked against the pinned digest before extraction", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "media-codec-provision-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const archive = join(temporary, "wrong-archive.tar.gz");
  const outputRoot = join(temporary, "output");
  await writeFile(archive, "untrusted cache bytes");

  const result = spawnSync("bash", ["scripts/prepare-wave2-codecs.sh", "mac-arm64", outputRoot], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GHATANA_MEDIA_CODEC_ARCHIVE_SOURCE: archive },
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.equal(result.status, 1, result.error?.message ?? result.stdout ?? "expected digest rejection");
  assert.match(result.stderr, /FAIL_CLOSED_ARCHIVE_SHA256_MISMATCH/u);
  assert.deepEqual(await readdir(outputRoot), [], "no output bundle is installed on digest failure");
});
