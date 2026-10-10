import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));

test("phase/noise-floor analysis is a measurement record, never a mastered-audio output", () => {
  const capabilities = readYaml(".product-experience/pdp-0-product-truth/capabilities.yaml");
  const id = "media.master.audio.phase-noise-floor-analyze";
  const capability = capabilities.capabilities.find((record) => record.id === id);
  const owner = capability.ownerDefinition;

  assert.ok(capability, `${id} exists`);
  assert.deepEqual(capability.outputArtifactTypes, ["phase-noise-floor-measurement-record"]);
  assert.deepEqual(owner.successOutputs, [{
    artifactType: "phase-noise-floor-measurement-record",
    requiredOnSuccess: true,
  }]);
  assert.ok(!capability.outputArtifactTypes.includes("mastered-audio-candidate-with-measurements"));
  assert.ok(!owner.successOutputs.some(({ artifactType }) => artifactType === "mastered-audio-candidate-with-measurements"));

  const measures = readYaml(".product-experience/pdp-0-product-truth/goals-jtbd.yaml").successMeasureContracts;
  const crosswalk = measures.ownerCapabilityApplicabilityCrosswalk.records.find(
    (record) => record.capabilityRef === id,
  );
  const projection = measures.ownerCapabilityApplicabilityCrosswalk.measureApplicabilityRecords.records
    .filter((record) => record.capabilityRef === id);
  const expectedMeasures = [
    "media.business.trustworthy-versioned-outputs.measure",
    "media.business.bounded-provider-execution.measure",
    "media.business.safe-recoverable-operations.measure",
  ];
  for (const measureRef of expectedMeasures) {
    assert.ok(!crosswalk.measureApplicability[measureRef].reason.includes("mastered-audio-candidate-with-measurements"));
    assert.ok(crosswalk.measureApplicability[measureRef].reason.includes("phase-noise-floor-measurement-record"));
    assert.match(crosswalk.measureApplicability[measureRef].reason,
      /exact declared output artifact phase-noise-floor-measurement-record is a measurement record, not mastered audio/u);
    const projected = projection.find((record) => record.measureRef === measureRef);
    assert.equal(projected.reason, crosswalk.measureApplicability[measureRef].reason);
  }
  assert.equal(projection.length, 4, "all four exact measure dispositions remain projected");
});
