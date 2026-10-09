import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../ghatana-tools/package.json", import.meta.url));
const { parse } = require("yaml");
const read = (path) => parse(readFileSync(path, "utf8"));
const base = ".product-experience/pdp-3-product-experience/";
const registry = read(`${base}journey-registry.yaml`);
const fixtures = read(`${base}scenario-fixture-registry.yaml`);
const links = read(`${base}journey-scenario-bindings.yaml`);

test("the 31 journey-scenario links exactly mirror contract-authored scenarioRefs", () => {
  assert.equal(links.schemaVersion, "media.pdp3.journey-scenario-bindings.v1");
  assert.equal(links.records.length, 31);
  assert.equal(new Set(links.records.map(({ scenarioRef }) => scenarioRef)).size, 31);
  const fixtureIds = new Set(fixtures.fixtures.map(({ id }) => id));
  const journeyById = new Map(registry.journeys.map((journey) => [journey.pdp0JourneyRef, journey]));
  const counts = new Map();

  for (const binding of links.records) {
    const journey = journeyById.get(binding.journeyRef);
    assert.ok(journey, `unknown journey ${binding.journeyRef}`);
    assert.ok(fixtureIds.has(binding.scenarioRef), `missing scenario fixture ${binding.scenarioRef}`);
    const contractPath = `${base}${journey.contract}`;
    assert.equal(binding.journeyContractRef, contractPath);
    const contract = read(contractPath);
    const declared = new Set([
      ...(contract.scenarioRefs ?? []),
      ...(contract.steps ?? []).flatMap((step) => step.scenarioRefs ?? []),
    ]);
    assert.ok(declared.has(binding.scenarioRef), `link is not contract-authored: ${binding.scenarioRef}`);
    const expectedStepRefs = (contract.steps ?? []).flatMap((step, index) =>
      (step.scenarioRefs ?? []).includes(binding.scenarioRef) ? [`${contractPath}#/steps/${index}`] : []);
    assert.deepEqual(binding.journeyContractStepRefs, expectedStepRefs);
    assert.equal(binding.scopeStatus, "OWNER_DEFINED_EXACT_SCENARIO_TO_JOURNEY_LINK; definition-only; runtime NOT_ADMITTED; acceptance effect none");
    counts.set(binding.journeyRef, (counts.get(binding.journeyRef) ?? 0) + 1);
  }

  for (const journey of registry.journeys) {
    const contract = read(`${base}${journey.contract}`);
    const declared = new Set([...(contract.scenarioRefs ?? []), ...(contract.steps ?? []).flatMap((step) => step.scenarioRefs ?? [])]);
    const linked = new Set(links.records.filter((binding) => binding.journeyRef === journey.pdp0JourneyRef).map((binding) => binding.scenarioRef));
    assert.deepEqual([...linked].sort(), [...declared].sort(), `${journey.pdp0JourneyRef} scenario coverage`);
  }
  assert.deepEqual(Object.fromEntries(counts), { "J-01": 6, "J-02": 10, "J-03": 13, "J-20": 2 });
});
