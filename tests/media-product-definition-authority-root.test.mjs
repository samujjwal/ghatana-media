import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { repositoryRootForModuleUrl } from "../scripts/lib/media-repository-root.mjs";

test("repository root resolution decodes filesystem paths containing spaces", () => {
  assert.equal(
    repositoryRootForModuleUrl("file:///Users/test/Audio%20Video/ghatana-media/scripts/check-product-definition-authority.mjs"),
    "/Users/test/Audio Video/ghatana-media",
  );
  const scriptPath = fileURLToPath(new URL("../scripts/check-product-definition-authority.mjs", import.meta.url));
  assert.match(readFileSync(scriptPath, "utf8"), /repositoryRootForModuleUrl\(import\.meta\.url\)/u,
    "the checked authority script uses the path-safe resolver");
});
