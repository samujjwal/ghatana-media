import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const [purposeText, operationsText] = await Promise.all([
  readFile(".product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml", "utf8"),
  readFile(".product-experience/pdp-1-domain-data/operations.yaml", "utf8"),
]);
const purpose = parse(purposeText);
const operations = parse(operationsText);
const purposeById = new Map(purpose.records.map((record) => [record.id, record]));
const observationsById = new Map(operations.ownerTypedObservationContracts.records.map((record) => [record.id, record]));
const p1 = ".product-experience/pdp-1-domain-data/operations.yaml";
const observationRef = (id) => `${p1}#ownerTypedObservationContracts/records/@id=${id}`;

function getPurpose(suffix) {
  const record = purposeById.get(`media.pdp3.step-purpose-binding.${suffix}.v1`);
  assert.ok(record, `missing purpose record ${suffix}`);
  assert.equal(record.runtimeAdmission, "NOT_ADMITTED", `${suffix} runtime admission changed`);
  return record;
}

function assertObservation(suffix, id, operationRef) {
  const record = getPurpose(suffix);
  const observation = observationsById.get(id);
  assert.ok(observation, `missing P1 observation ${id}`);
  assert.equal(observation.operationRefs.includes(operationRef), true, `${id} must own ${operationRef}`);
  assert.equal(record.observationContractRefs.includes(observationRef(id)), true, `${suffix} must bind ${id}`);
}

function assertResultSource(suffix, operationId, resultPath) {
  const record = getPurpose(suffix);
  const expected = `${p1}#${resultPath}`;
  assert.equal(record.allowedOperationRefs.includes(operationId), true, `${suffix} operation mismatch`);
  assert.equal(record.sourceRefs.includes(expected), true, `${suffix} must cite ${expected}`);
  assert.deepEqual(record.stateRefs, [], `${suffix} query must not claim P1 machine state`);
}

test("PDP-3 query purposes bind exact P1 observations or result schemas without state claims", () => {
  const projectList = getPurpose("j01-step-02");
  assert.deepEqual(projectList.stateRefs, []);
  assert.equal(projectList.operationRefs.includes("media.operation-slice.list-projects"), true);
  assert.equal(projectList.sourceRefs.includes(`${p1}#ownerDefinedOperationContracts/records/@id=media.operation-slice.list-projects/ownerWireSchema/resultSchema`), true);
  assert.equal(projectList.finality.includes("not complete cross-workspace inventory or transition"), true);

  assertObservation("j02-step-04", "media.observation-contract.delegated-integration-result-context.v1", "media.operation.action.view-job-status");
  assertResultSource("j02-step-05", "media.operation-slice.inspect-artifact-version", "ownerDefinedOperationContracts/records/@id=media.operation-slice.inspect-artifact-version/ownerWireSchema/resultSchema");

  assertObservation("j05-step-03", "media.observation-contract.quality-evidence.v1", "media.operation.action.inspect-quality-evidence");
  assertObservation("j05-step-03", "media.observation-contract.quality-action-plan.v1", "media.operation.action.inspect-quality-evidence");
  assertResultSource("j05-step-03", "media.operation.capability.media-quality-inspect", "capabilityOperationContracts/records/@id=media.operation.capability.media-quality-inspect");
  assertResultSource("j05-step-04", "media.operation.action.compare-candidate-on-metric", "ownerDefinedOperationContracts/records/@id=media.operation.action.compare-candidate-on-metric/resultSchema");
  assertResultSource("j08-step-03", "media.operation.action.compare-candidate-on-metric", "ownerDefinedOperationContracts/records/@id=media.operation.action.compare-candidate-on-metric/resultSchema");
  assertObservation("j08-step-04", "media.observation-contract.quality-evidence.v1", "media.operation.action.inspect-quality-evidence");

  assertObservation("j09-step-02", "media.observation-contract.processing-parameter-read.v1", "media.operation.action.review-processing-parameters");
  assertResultSource("j09-step-08", "media.operation.action.inspect-version-and-review-scope", "ownerDefinedOperationContracts/records/@id=media.operation.action.inspect-version-and-review-scope/resultSchema");
  assertObservation("j10-step-01", "media.observation-contract.processing-parameter-read.v1", "media.operation.action.review-processing-parameters");
  assertObservation("j10-step-04", "media.observation-contract.quality-evidence.v1", "media.operation.action.inspect-quality-evidence");
  assertObservation("j10-step-04", "media.observation-contract.quality-action-plan.v1", "media.operation.action.inspect-quality-evidence");
  assertResultSource("j10-step-05", "media.operation.action.compare-candidate-on-metric", "ownerDefinedOperationContracts/records/@id=media.operation.action.compare-candidate-on-metric/resultSchema");

  assertObservation("j13-step-04", "media.observation-contract.output-preview-version-lineage.v1", "media.operation.action.inspect-output-preview-and-version");
  assertResultSource("j14-step-02", "media.operation.action.inspect-simulation-result", "ownerDefinedOperationContracts/records/@id=media.operation.action.inspect-simulation-result/resultSchema");
  assertObservation("j14-step-03", "media.observation-contract.quality-evidence.v1", "media.operation.action.inspect-quality-evidence");
  assertObservation("j14-step-03", "media.observation-contract.quality-action-plan.v1", "media.operation.action.inspect-quality-evidence");
});
