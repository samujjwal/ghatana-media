import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const styles = readFileSync(resolve(process.cwd(), "apps/media-experience-explorer/src/styles.css"), "utf8");

test("Media CLI command input keeps a visible keyboard focus indicator on its dark surface", () => {
  const rule = styles.match(/\.command-form input:focus-visible\s*\{([^}]+)\}/u)?.[1];

  assert.ok(rule, "the command input has an explicit focus-visible rule");
  assert.match(rule, /outline:\s*2px solid #8fc9ff/u);
  assert.match(rule, /outline-offset:\s*3px/u);
  assert.doesNotMatch(rule, /outline:\s*none|box-shadow:\s*none/u);
});
