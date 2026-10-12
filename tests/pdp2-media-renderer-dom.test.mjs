import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("Media renderer DOM regression passes in the UI package", () => {
  const result = spawnSync("pnpm", [
    "--dir", "libs/audio-video-ui", "exec", "vitest", "run", "src/screens/MediaProductRenderer.test.ts",
  ], { cwd: root, encoding: "utf8", timeout: 120_000 });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, output);
  assert.match(output, /Test Files\s+1 passed \(1\)/u);
  assert.match(output, /Tests\s+11 passed \(11\)/u);
});
