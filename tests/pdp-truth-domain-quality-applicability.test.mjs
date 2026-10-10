import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const parse = require("yaml").parse;
const source = (name) => parse(readFileSync(resolve(root, `.product-experience/pdp-0-product-truth/${name}.yaml`), "utf8"));
const quality = source("quality-policy");
const capabilitySource = source("capabilities");
const review = source("capability-leaf-review").ownerCapabilityLeafAdjudication;
const crosswalk = quality.ownerQualityApplicabilityCrosswalk;
const capabilities = new Map(capabilitySource.capabilities.map((row) => [row.id, row]));
const rows = new Map(crosswalk.records.map((row) => [row.capabilityRef, row]));
const p1Ref = /pdp-1-domain-data|operationContractRef|typed(Input|Output)SchemaIds|domainObjectRef/i;

test("P0 quality applicability is complete from capability intent and semantic artifact types alone", () => {
  assert.equal(capabilities.size, 462);
  assert.equal(review.records.length, 462);
  assert.equal(crosswalk.records.length, 462);
  assert.equal(rows.size, 462);
  assert.equal(crosswalk.population.dimensionDispositions, 462 * 6);
  assert.equal(crosswalk.population.metricDispositions, 462 * 16);
  assert.equal(quality.qualityDimensions.length, 6);
  assert.equal(quality.metricDefinitions.length, 16);
  assert.ok(crosswalk.modalityEvidenceRegistry.every((entry) => entry.sourceRef === ".product-experience/pdp-0-product-truth/capabilities.yaml#capabilities"));
  assert.ok(!JSON.stringify(crosswalk).match(p1Ref), "P0 applicability contains no P1 operation or domain-object prerequisite");
  assert.doesNotMatch(JSON.stringify(crosswalk), /ownerOutputSchemaRef|ownerLeafWireContractRef|typed(Input|Output)SchemaIds|operationContractRef/u);
  for (const [id, capability] of capabilities) {
    const row = rows.get(id);
    assert.ok(row, id);
    assert.deepEqual(row.inputArtifactTypes, capability.inputArtifactTypes, `${id} inputs are P0 semantic types`);
    assert.deepEqual(row.outputArtifactTypes, capability.outputArtifactTypes, `${id} outputs are P0 semantic types`);
    assert.equal(row.ownerCapabilityIntentRef, `.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=${id}`);
    assert.equal(row.ownerOutputSemanticShapeRef, `${row.ownerCapabilityIntentRef}/outputArtifactTypes`);
    assert.ok(!Object.keys(row).some((key) => /wire|schema|operationContract|domainObject/i.test(key)), `${id} has no operation/wire-schema prerequisite`);
    assert.deepEqual(Object.keys(row.dimensionApplicability).sort(), quality.qualityDimensions.map((x) => x.id).sort());
    assert.deepEqual(Object.keys(row.metricApplicability).sort(), quality.metricDefinitions.map((x) => x.id).sort());
    assert.ok(["APPLICABLE", "NOT_APPLICABLE"].includes(row.dimensionApplicability["QUALITY-DIM-STRUCTURAL-VALIDITY"]));
    for (const metric of Object.values(row.metricApplicability)) {
      assert.ok(["APPLICABLE", "NOT_APPLICABLE"].includes(metric.status));
      assert.equal(metric.measurementState, "NOT_EVALUATED");
      assert.equal(metric.qualificationState, "NOT_EVALUATED");
      for (const type of [...metric.subjectInputArtifactTypes, ...metric.subjectOutputArtifactTypes]) {
        assert.ok([...capability.inputArtifactTypes, ...capability.outputArtifactTypes].includes(type), `${id} metric type ${type} is declared by its capability`);
      }
    }
  }
  const phaseNoise = rows.get("media.master.audio.phase-noise-floor-analyze");
  assert.deepEqual(phaseNoise.outputArtifactTypes, ["phase-noise-floor-measurement-record"]);
  assert.deepEqual(phaseNoise.ownerMeasurementBindings.map((item) => item.metricRef), ["QUALITY-METRIC-AUDIO-SPECTRAL-PHASE"]);
  assert.equal(phaseNoise.metricApplicability["QUALITY-METRIC-AUDIO-DEFECTS"].status, "NOT_APPLICABLE");
  const simulation = crosswalk.records.filter((row) => row.capabilityRef.startsWith("media.simulation."));
  assert.equal(simulation.length, 33);
  assert.ok(simulation.every((row) => row.dimensionApplicability["QUALITY-DIM-DOMAIN-SCIENTIFIC"] === "APPLICABLE"));
});

test("quality crosswalk semantic input and output types exactly match the frozen P0 capability intents", () => {
  assert.equal(crosswalk.records.length, 462);
  for (const capability of capabilitySource.capabilities) {
    const row = rows.get(capability.id);
    assert.ok(row, capability.id);
    assert.deepEqual(row.inputArtifactTypes, capability.inputArtifactTypes, `${capability.id} input artifact types`);
    assert.deepEqual(row.outputArtifactTypes, capability.outputArtifactTypes, `${capability.id} output artifact types`);
    for (const metric of Object.values(row.metricApplicability)) {
      assert.equal(metric.measurementState, "NOT_EVALUATED", `${capability.id} measurement state`);
      assert.equal(metric.qualificationState, "NOT_EVALUATED", `${capability.id} qualification state`);
    }
  }
});

test("P0 quality checks reject foreign semantic types and missing applicability decisions", () => {
  const original = structuredClone(crosswalk);
  const foreignType = structuredClone(original);
  foreignType.records[0].outputArtifactTypes[0] = "media.typed-output.foreign-pdp1-wire-schema";
  const cap = capabilities.get(foreignType.records[0].capabilityRef);
  assert.ok(!cap.outputArtifactTypes.includes(foreignType.records[0].outputArtifactTypes[0]));
  assert.throws(() => assert.deepEqual(foreignType.records[0].outputArtifactTypes, cap.outputArtifactTypes));
  const missingDecision = structuredClone(original);
  delete missingDecision.records[0].dimensionApplicability["QUALITY-DIM-STRUCTURAL-VALIDITY"];
  assert.throws(() => assert.deepEqual(Object.keys(missingDecision.records[0].dimensionApplicability).sort(), quality.qualityDimensions.map((x) => x.id).sort()));
});
