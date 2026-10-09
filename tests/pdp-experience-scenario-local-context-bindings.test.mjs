import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createFixtureState } from "../libs/media-experience-simulation/dist/index.js";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const bindings = parse(await readFile(new URL("../.product-experience/pdp-3-product-experience/experience-source-bindings.yaml", import.meta.url), "utf8"));
const scenarios = parse(await readFile(new URL("../.product-experience/pdp-3-product-experience/scenario-fixture-registry.yaml", import.meta.url), "utf8"));
const canonicalStarts = new Set(bindings.scenarioStartingStateBindings.map((row) => row.scenarioRef));
const rows = bindings.scenarioStartingContextBindings.records;
const scenarioById = new Map(scenarios.fixtures.map((row) => [row.id, row]));

function readPath(root, path) {
  return path.split(".").reduce((value, part) => value?.[String(Number.isInteger(Number(part)) ? Number(part) : part)], root);
}

test("all noncanonical scenario starts have exact local-context bindings to executable fixtures", () => {
  assert.equal(rows.length, 15);
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
  assert.equal(new Set(rows.map((row) => row.scenarioRef)).size, rows.length);
  for (const row of rows) {
    assert.match(row.id, /^media\.pdp3\.scenario-context\.[a-z0-9-]+\.v1$/u);
    assert.match(row.localContextRef, /^media\.experience\.local-context\.[a-z0-9-]+\.v1$/u);
    assert.ok(!canonicalStarts.has(row.scenarioRef), `${row.scenarioRef} must not shadow a canonical start`);
    assert.deepEqual(row.canonicalStateRefs, [], "local UI/session facts never impersonate P1 state-machine identities");
    assert.match(row.applicabilityDisposition, /^LOCAL_SYNTHETIC_CONTEXT_ONLY(?:;|$)/u);
    assert.equal(row.acceptanceEffect, "none");
    const sourceScenario = scenarioById.get(row.scenarioRef);
    assert.ok(sourceScenario, `source scenario ${row.scenarioRef} exists`);
    assert.equal(row.fixtureKey, row.scenarioRef.slice("media.scenario.".length));
    assert.ok(sourceScenario.initialConditions && sourceScenario.expected);
    const fixture = createFixtureState(row.scenarioRef);
    assert.equal(fixture.scenarioId, row.scenarioRef);
    for (const [path, expected] of Object.entries(row.observedFixtureFields)) {
      assert.deepEqual(readPath(fixture, path), expected, `${row.scenarioRef} exact fixture field ${path}`);
    }
  }
});

test("local scenario contexts cover exactly the remaining source scenarios without canonical starts", () => {
  const expected = scenarios.fixtures.map((row) => row.id).filter((id) => !canonicalStarts.has(id)).sort();
  assert.deepEqual(rows.map((row) => row.scenarioRef).sort(), expected);
});
