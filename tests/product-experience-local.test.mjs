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
  assert.match(output, /462 Phase 0 capability leaves/u);
  assert.match(output, /28 Phase 1 components/u);
  assert.match(output, /47 Phase 2 screen contracts/u);
  assert.match(output, /28 required journey proposals/u);
  assert.match(output, /currentness\.yaml is absent/u);
});
