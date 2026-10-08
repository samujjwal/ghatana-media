import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const pins = JSON.parse(await readFile(".product-experience/explorer/e04-source-pins.json", "utf8"));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function staleSources(sourcePins, readSource) {
  return sourcePins.sources.flatMap(({ path, sha256: expected }) => {
    const actual = sha256(readSource(path));
    return actual === expected ? [] : [{ path, expected, actual }];
  });
}

test("E-04 fixture and browser-audit byte fingerprints are unchanged", async () => {
  assert.equal(pins.schemaVersion, "media.e04-source-pins.v1");
  assert.match(pins.authority, /negative drift check only/u);
  assert.equal(pins.sources.length, 4);
  assert.equal(new Set(pins.sources.map(({ path }) => path)).size, pins.sources.length);
});

test("E-04 drift check detects changed bytes and reports the exact source", () => {
  const oneSource = { sources: [{ path: "fixture.ts", sha256: sha256("original") }] };
  assert.deepEqual(staleSources(oneSource, () => Buffer.from("changed")), [{
    path: "fixture.ts",
    expected: sha256("original"),
    actual: sha256("changed"),
  }]);
});

test("E-04 pin paths resolve to the exact observed source bytes", async () => {
  const stale = [];
  for (const source of pins.sources) {
    const bytes = await readFile(source.path);
    const actual = sha256(bytes);
    if (actual !== source.sha256) stale.push({ path: source.path, expected: source.sha256, actual });
  }
  assert.deepEqual(stale, [], `source drift detected: ${JSON.stringify(stale)}`);
});
