import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const toolsRequire = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = toolsRequire("yaml");
const operationsPath = ".product-experience/pdp-1-domain-data/operations.yaml";
const sourceTruthRef = ".product-experience/pdp-0-product-truth/journey-catalog.yaml#journeys/@id=J-13";

function renderContract() {
  const operations = parse(readFileSync(resolve(root, operationsPath), "utf8"));
  const operation = operations.ownerDefinedOperationContracts.records.find(
    ({ id }) => id === "media.operation.action.submit-render",
  );
  assert.ok(operation, "the existing submit-render operation remains the source owner");
  return { operation, contract: operation.renderOutputResultDefinition };
}

function exactBindingsMatch(required, expected, actual) {
  return required.every((field) => expected[field] === actual[field]);
}

function disposition(result, expectedSlots) {
  const expected = new Set(expectedSlots);
  if (!result.durableResultRef || !result.durableResultDigest || !result.resultAuthorityRef) return "UNKNOWN";
  if (result.outcome === "OUTCOME_UNKNOWN" || result.outcome === "RECONCILING") return result.outcome;
  if (!result.joinMatches || !result.planProfileVersionsMatch || !result.expectedSetKnown) return "UNKNOWN";
  const slots = result.outputs.map(({ expectedOutputSlotRef }) => expectedOutputSlotRef);
  if (slots.some((slot) => !expected.has(slot)) || new Set(slots).size !== slots.length) return "UNKNOWN";
  if (slots.length !== expected.size) return "UNKNOWN";
  if (result.outputs.some(({ conversionLossDisposition }) => conversionLossDisposition === "UNKNOWN")) return "UNKNOWN";
  const produced = result.outputs.every(({ outputDisposition }) => outputDisposition === "PRODUCED");
  if (produced && result.outputs.every(({ registered, digestMatches }) => registered && digestMatches)) return "COMPLETED";
  const closedPartial = result.partialPermitted && result.outputs.every(({ outputDisposition, reasonRef, evidenceRef }) =>
    outputDisposition === "PRODUCED" || (["NOT_PRODUCED", "REJECTED"].includes(outputDisposition) && reasonRef && evidenceRef));
  return closedPartial ? "PARTIALLY_SUCCEEDED" : "UNKNOWN";
}

function resultFor(expectedOutputSlotRefs) {
  return {
    durableResultRef: "result:v4",
    durableResultDigest: "sha256:result",
    resultAuthorityRef: "result-authority:v2",
    expectedSetKnown: true,
    planProfileVersionsMatch: true,
    joinMatches: true,
    partialPermitted: false,
    outputs: expectedOutputSlotRefs.map((expectedOutputSlotRef, index) => ({
      expectedOutputSlotRef,
      outputDisposition: "PRODUCED",
      artifactVersionRef: `artifact:v${index + 1}`,
      registrationReceiptRef: `receipt:${index + 1}`,
      contentDigest: `sha256:artifact${index + 1}`,
      conversionLossDisposition: "NONE",
      registered: true,
      digestMatches: true,
    })),
  };
}

test("J-13 render result definition is source-bound to the existing operation and PDP-0 truth", () => {
  const { operation, contract } = renderContract();
  assert.equal(operation.contractVersion, 1);
  assert.equal(contract.id, "media.render-result-contract.j13-exact-output-set.v1");
  assert.equal(contract.sourceTruthRef, sourceTruthRef);
  assert.match(contract.status, /PDP1_DEFINITION_ONLY/);
  assert.match(contract.status, /RUNTIME_NOT_ADMITTED/);
  assert.deepEqual(contract.expectedOutputSet.fields, [
    "resolvedPlanRef", "resolvedPlanVersionRef", "renderProfileRef", "renderProfileVersionRef", "expectedOutputSlotRefs",
  ]);
  assert.match(contract.expectedOutputSet.cardinalityRule, /never infer output cardinality from source input/i);
  assert.deepEqual(contract.exactResultBindings.required, [
    "requestId", "requestFingerprint", "logicalJobId", "jobRevisionRef", "sourceSnapshotId", "sourceSnapshotDigest",
    "exactSourceVersionRefs", "resolvedPlanRef", "resolvedPlanVersionRef", "renderProfileRef", "renderProfileVersionRef",
    "rigVersionRef", "sceneVersionRef", "durableResultRef", "durableResultDigest", "resultAuthorityRef",
  ]);
  assert.match(contract.exactResultBindings.rigSceneRule, /exact rig and scene versions declared by the J-13 render plan/i);
  assert.deepEqual(contract.perOutputResult.required, [
    "expectedOutputSlotRef", "outputDisposition", "artifactVersionRef", "registrationReceiptRef", "contentDigest", "conversionLossDisposition",
  ]);
  assert.deepEqual(contract.perOutputResult.conversionLossDisposition.allowed, ["NONE", "EXPLICITLY_ACCEPTED", "REJECTED", "UNKNOWN"]);
  assert.match(contract.finality.COMPLETED, /exact expected output slot set once each/i);
  assert.match(contract.finality.PARTIALLY_SUCCEEDED, /no consequential unknown remains/i);
  assert.match(contract.finality.unknownAndReconciling, /remain distinct/i);
  assert.match(contract.authorityBoundary, /does not establish runtime production/i);
});

test("only an exact plan-declared output set with durable authoritative evidence can complete", () => {
  const plan = {
    resolvedPlanRef: "plan:scene-render",
    resolvedPlanVersionRef: "plan:scene-render:v7",
    renderProfileRef: "profile:cinematic",
    renderProfileVersionRef: "profile:cinematic:v3",
    expectedOutputSlotRefs: ["slot:preview", "slot:master"],
    sourceInputRefs: ["source:scene", "source:rig", "source:audio"],
  };
  const complete = resultFor(plan.expectedOutputSlotRefs);
  assert.equal(disposition(complete, plan.expectedOutputSlotRefs), "COMPLETED");

  const missing = { ...complete, outputs: complete.outputs.slice(0, 1) };
  assert.equal(disposition(missing, plan.expectedOutputSlotRefs), "UNKNOWN", "missing output is not successful partiality");
  const duplicate = { ...complete, outputs: [...complete.outputs, complete.outputs[0]] };
  assert.equal(disposition(duplicate, plan.expectedOutputSlotRefs), "UNKNOWN");
  const extra = { ...complete, outputs: [...complete.outputs, { ...complete.outputs[0], expectedOutputSlotRef: "slot:unplanned" }] };
  assert.equal(disposition(extra, plan.expectedOutputSlotRefs), "UNKNOWN");
  const mismatchedPlan = { ...complete, planProfileVersionsMatch: false };
  assert.equal(disposition(mismatchedPlan, plan.expectedOutputSlotRefs), "UNKNOWN");
  const noDurableResult = { ...complete, durableResultRef: undefined };
  assert.equal(disposition(noDurableResult, plan.expectedOutputSlotRefs), "UNKNOWN");

  assert.notEqual(plan.expectedOutputSlotRefs.length, plan.sourceInputRefs.length);
  assert.equal(disposition(complete, plan.expectedOutputSlotRefs), "COMPLETED", "source input count does not define output cardinality");
});

test("request, job, source, plan/profile, rig, and scene joins must match exactly", () => {
  const { contract } = renderContract();
  const expected = Object.fromEntries(contract.exactResultBindings.required.map((field) => [field, `${field}:exact-v1`]));
  const actual = { ...expected };
  assert.equal(exactBindingsMatch(contract.exactResultBindings.required, expected, actual), true);

  for (const field of ["requestId", "requestFingerprint", "logicalJobId", "jobRevisionRef", "sourceSnapshotDigest",
    "exactSourceVersionRefs", "resolvedPlanVersionRef", "renderProfileVersionRef", "rigVersionRef", "sceneVersionRef"]) {
    assert.equal(exactBindingsMatch(contract.exactResultBindings.required, expected, { ...actual, [field]: `${field}:different-v1` }), false, `${field} mismatch blocks finality`);
  }
});

test("partial completion requires explicit closed slot dispositions and preserves unknown states", () => {
  const expected = ["slot:preview", "slot:master"];
  const complete = resultFor(expected);
  const partial = {
    ...complete,
    partialPermitted: true,
    outputs: [complete.outputs[0], {
      expectedOutputSlotRef: "slot:master",
      outputDisposition: "REJECTED",
      reasonRef: "reason:unsupported-feature",
      evidenceRef: "evidence:conversion-loss",
      conversionLossDisposition: "REJECTED",
    }],
  };
  assert.equal(disposition(partial, expected), "PARTIALLY_SUCCEEDED");
  assert.equal(disposition({ ...partial, partialPermitted: false }, expected), "UNKNOWN");
  assert.equal(disposition({ ...partial, outputs: [{ ...partial.outputs[0] }, { ...partial.outputs[1], evidenceRef: undefined }] }, expected), "UNKNOWN");
  assert.equal(disposition({ ...complete, outcome: "OUTCOME_UNKNOWN" }, expected), "OUTCOME_UNKNOWN");
  assert.equal(disposition({ ...complete, outcome: "RECONCILING" }, expected), "RECONCILING");
  assert.equal(disposition({ ...complete, outputs: complete.outputs.map((output) => ({ ...output, conversionLossDisposition: "UNKNOWN" })) }, expected), "UNKNOWN");
});
