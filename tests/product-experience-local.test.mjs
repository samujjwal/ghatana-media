import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("Product Definition local invariant check covers all phase denominators", () => {
  const output = execFileSync(process.execPath, ["scripts/check-product-experience-local.mjs"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

  assert.match(output, /Media Product Definition local check passed/u);
  assert.match(output, /462 PDP-0 capability leaves/u);
  assert.match(output, /28 PDP-2 components/u);
  assert.match(output, /47 PDP-3 screen contracts/u);
  assert.match(output, /28 baseline plus J-29\/J-30 extensions/u);
  assert.match(output, /currentness\.yaml is absent/u);
});
