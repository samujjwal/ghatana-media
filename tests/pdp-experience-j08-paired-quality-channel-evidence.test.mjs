import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const journeyPath = ".product-experience/pdp-3-product-experience/journey-contracts/repair-video-with-measured-quality.yaml";
const p1Path = ".product-experience/pdp-1-domain-data/operations.yaml";
const [journeyText, p0Text, operationsText, valuesText] = await Promise.all([
  readFile(journeyPath, "utf8"),
  readFile(".product-experience/pdp-0-product-truth/journey-catalog.yaml", "utf8"),
  readFile(p1Path, "utf8"),
  readFile(".product-experience/pdp-1-domain-data/value-objects.yaml", "utf8"),
]);
const journey = parse(journeyText);
const p0Journey = parse(p0Text).journeys.find((record) => record.id === "J-08");
const operations = parse(operationsText);
const values = parse(valuesText);
const compare = operations.ownerDefinedOperationContracts.records
  .find((record) => record.id === "media.operation.action.compare-candidate-on-metric");
const pairedObservation = operations.ownerTypedObservationContracts.records
  .find((record) => record.id === "media.observation-contract.candidate-metric-pair.v1");
const qualityEvidence = operations.ownerTypedObservationContracts.records
  .find((record) => record.id === "media.observation-contract.quality-evidence.v1");
const repair = operations.capabilityOperationContracts.records
  .find((record) => record.id === "media.operation.capability.media-enhance-video-compression-repair");

test("J-08 web definition binds exact repair versions to the source-defined paired metric observation", () => {
  assert.ok(p0Journey);
  assert.equal(p0Journey.completion,
    "Eligible stabilized/upscaled/repaired output is compared under applicable metrics with limitations visible.");
  assert.equal(journey.pdp0JourneyRef, "J-08");

  assert.equal(compare.contractVersion, 2);
  assert.deepEqual(compare.requestSchema.required,
    ["requestId", "originalArtifactVersionRef", "candidateArtifactVersionRef", "metricRefs"]);
  assert.deepEqual(pairedObservation.resultSchema.required,
    ["requestId", "originalArtifactVersionRef", "candidateArtifactVersionRef", "metricRefs", "metricResults", "observedAt"]);
  assert.ok(compare.outcomeSemantics.includes("NOT_COMPARABLE"));
  assert.ok(compare.outcomeSemantics.includes("UNKNOWN"));
  assert.ok(compare.outcomeSemantics.includes("winner"));
  assert.deepEqual(values.providerSignalContract.scopeIdentity,
    ["providerRef", "metricRef", "metricVersionRef", "methodRef", "methodVersionRef", "unitRef"]);
  assert.ok(qualityEvidence.resultSchema.properties.observations);

  const web = journey.channelDefinitionEvidence.webChannelEvidence;
  assert.equal(web.channelRef, "media.channel.web");
  assert.equal(web.consumerSurfaceRef, "media.surface.web");
  assert.equal(web.journeyCompletionRef,
    ".product-experience/pdp-0-product-truth/journey-catalog.yaml#journeys/@id=J-08/completion");
  assert.equal(web.sourceStepRefs.originalVersionSelection.endsWith("#/steps/0"), true);
  assert.equal(web.sourceStepRefs.repairCandidateResult.endsWith("#/steps/1"), true);
  assert.equal(web.sourceStepRefs.pairedMetricQuery.endsWith("#/steps/2"), true);
  assert.equal(web.pairedQuery.operationRef, compare.id);
  assert.equal(web.pairedQuery.operationVersion, 2);
  assert.equal(web.pairedQuery.resultSchemaRef,
    ".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.candidate-metric-pair.v1/resultSchema");
  assert.match(web.pairedQuery.exactInputs.originalArtifactVersionRef, /exact immutable source version/);
  assert.match(web.pairedQuery.exactInputs.candidateArtifactVersionRef, /exact immutable version returned/);
  assert.match(web.pairedQuery.exactInputs.metricRefs, /P0 quality-policy metric IDs/);
  assert.equal(web.pairedQuery.pairedEvidence.scopeRule,
    "all six providerSignalContract.scopeIdentity fields must match exactly across the pair");
  assert.equal(web.pairedQuery.pairedEvidence.mismatchDisposition,
    "NOT_COMPARABLE per metric while retaining both sides");
  assert.match(web.pairedQuery.pairedEvidence.unavailableOrStaleDisposition, /UNKNOWN/);
  assert.match(web.pairedQuery.pairedEvidence.derivedConclusion, /winner/);
  assert.match(web.pairedQuery.pairedEvidence.derivedConclusion, /improvement/);

  const compareBinding = journey.pdp1ResultEvidence.operationResultBindings.find((binding) =>
    binding.operationRef === compare.id && binding.journeyStepRef.endsWith("#/steps/2"));
  assert.ok(compareBinding);
  assert.equal(compareBinding.operationVersion, 2);
  assert.equal(compareBinding.resultSchemaRef,
    ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.action.compare-candidate-on-metric/resultSchema");
  assert.equal(compareBinding.pairedObservationResultSchemaRef,
    web.pairedQuery.resultSchemaRef);

  const candidateOutput = repair.resultSchema.properties.outputs.items.oneOf[0].properties.payload;
  assert.deepEqual(candidateOutput.required, ["artifactId", "versionId"]);
  assert.equal(web.transportDisposition, "UNBOUND");
  assert.equal(web.runtimeAdmission, "NOT_ADMITTED");
  assert.match(web.acceptanceBoundary, /no web transport equivalence/);
});
