import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validatePdp3StepCapabilityPurpose, validatePdp3JourneyPurposeBinding } from "../scripts/lib/pdp3-step-capability-purpose.mjs";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const p3 = ".product-experience/pdp-3-product-experience";
const [purposeText, oracleText, p0Text, capabilityText, actionText, operationText, localText] = await Promise.all([
  readFile(`${p3}/journey-purpose-bindings.yaml`, "utf8"),
  readFile(`${p3}/step-definition-oracles.yaml`, "utf8"),
  readFile(".product-experience/pdp-0-product-truth/journey-catalog.yaml", "utf8"),
  readFile(".product-experience/pdp-0-product-truth/capabilities.yaml", "utf8"),
  readFile(`${p3}/action-registry.yaml`, "utf8"),
  readFile(".product-experience/pdp-1-domain-data/operations.yaml", "utf8"),
  readFile(`${p3}/local-step-effect-contracts.yaml`, "utf8"),
]);
const purpose = parse(purposeText);
const oracle = parse(oracleText);
const p0 = parse(p0Text);
const capabilities = parse(capabilityText).capabilities;
const actionRegistry = parse(actionText);
const operations = parse(operationText);
const localContracts = parse(localText);
const capabilityById = new Map(capabilities.map((item) => [item.id, item]));
const p0ById = new Map(p0.journeys.map((item) => [item.id, item]));
const actionsById = new Map([...actionRegistry.actions, ...actionRegistry.ownerDefinedActions].map((item) => [item.id, item]));
const actionSourceRefsById = new Map([
  ...actionRegistry.actions.map((item) => [item.id, `.product-experience/pdp-3-product-experience/action-registry.yaml#actions/@id=${item.id}`]),
  ...actionRegistry.ownerDefinedActions.map((item) => [item.id, `.product-experience/pdp-3-product-experience/action-registry.yaml#ownerDefinedActions/@id=${item.id}`]),
]);
const ownerBindings = operations.ownerDefinedJourneyOperationBindings.records;
const ownerBindingsById = new Map(ownerBindings.map((item) => [item.id, item]));
const localContractsById = new Map(localContracts.records.map((item) => [item.id, item]));
const steps = oracle.journeys.flatMap((journey) => journey.steps.map((step) => [journey, step]));
const stepByRef = new Map(steps.map(([, step]) => [step.sourceRef, step]));
const purposeContext = {
  stepsByRef: stepByRef,
  p0ById,
  actionsById,
  actionSourceRefsById,
  ownerBindingsById,
  localContractsById,
  capabilitiesById: capabilityById,
};

test("all 130 step-purpose records resolve exact PDP-0 purpose and PDP-3 bindings", () => {
  assert.equal(purpose.recordCount, 130);
  assert.equal(purpose.records.length, 130);
  assert.equal(new Set(purpose.records.map((record) => record.id)).size, 130);
  assert.equal(new Set(purpose.records.map((record) => record.stepRef)).size, 130);
  assert.ok(purpose.records.every((record) => typeof record.purposeClass === "string" && record.purposeClass.length > 0));
  assert.equal(stepByRef.size, 130);
  for (const record of purpose.records) {
    const step = stepByRef.get(record.stepRef);
    const p0Journey = p0ById.get(record.journeyRef);
    assert.ok(step, `${record.id} resolves one exact P3 step`);
    assert.ok(p0Journey, `${record.id} resolves one exact P0 journey`);
    assert.equal(record.journeySourceRef,
      `.product-experience/pdp-0-product-truth/journey-catalog.yaml#journeys/@id=${record.journeyRef}`);
    assert.deepEqual(record.outcomeRefs, p0Journey.outcomeRefs, record.id);
    assert.equal(record.stepIntent, step.stepIntent, record.id);
    assert.equal(record.viewRef, step.viewRef, record.id);
    assert.equal(record.actionRef, step.actionRef ?? null, record.id);
    assert.equal(record.semanticRole, step.semanticRole ?? null, record.id);
    const bindings = step.canonicalBindings;
    const options = bindings.capabilityOptions ?? [];
    const expectedOperations = options.length
      ? [...new Set(options.flatMap((option) => option.operationRefs ?? []))]
      : (bindings.primaryOperationRefs ?? bindings.ownerOperationRefs ?? bindings.operationRefs ?? []);
    assert.deepEqual(record.operationRefs, expectedOperations, record.id);
    assert.deepEqual(record.allowedOperationRefs, expectedOperations, record.id);
    assert.deepEqual(record.supportingOperationRefs, bindings.supportingObservationOperationRefs ?? [], record.id);
    assert.deepEqual(record.capabilityRefs, options.map((option) => option.capabilityRef), record.id);
    assert.deepEqual(record.domainObjectRefs, bindings.ownerDomainObjectRefs ?? bindings.domainObjectRefs ?? [], record.id);
    assert.deepEqual(record.stateRefs, bindings.ownerStateRefs ?? bindings.stateRefs ?? [], record.id);
    assert.deepEqual(record.authorityRefs, bindings.ownerAuthorityRefs ?? bindings.authorityRefs ?? [], record.id);
    assert.deepEqual(record.requirementRefs, bindings.ownerRequirementRefs ?? bindings.requirementRefs ?? [], record.id);
    assert.equal(record.runtimeAdmission, "NOT_ADMITTED");
    assert.equal(record.acceptanceEffect, "none");
    assert.ok(record.mappingBasis.length > 20, `${record.id} records the binding basis`);
    assert.deepEqual(validatePdp3JourneyPurposeBinding(record, purposeContext),
      { valid: true, reason: "EXACT_STEP_PURPOSE_AND_SCOPE" }, record.id);
  }
});

test("purpose classifications reject missing scope and valid but wrong non-menu operations", () => {
  const ordinary = purpose.records.find((record) => record.purposeClass === "EXACT_ACTION_OPERATION");
  const wrongOperation = structuredClone(ordinary);
  wrongOperation.operationRefs = ["media.operation.action.inspect-provenance"];
  wrongOperation.allowedOperationRefs = [...wrongOperation.operationRefs];
  assert.equal(validatePdp3JourneyPurposeBinding(wrongOperation, purposeContext).valid, false);

  const unclassified = structuredClone(ordinary);
  delete unclassified.purposeClass;
  assert.equal(validatePdp3JourneyPurposeBinding(unclassified, purposeContext).valid, false);
});

test("capability choice alternatives are source-checked against the journey purpose", () => {
  for (const journey of oracle.journeys) {
    for (const step of journey.steps) {
      const options = step.canonicalBindings.capabilityOptions ?? [];
      if (!options.length) continue;
      assert.ok(step.purposeBinding, `${step.id} needs an explicit capability purpose`);
      const result = validatePdp3StepCapabilityPurpose(step, capabilityById, p0ById.get(journey.journeyId));
      assert.deepEqual(result, { valid: true, reason: "EXACT_SOURCE_ANALYSIS_ALTERNATIVES" }, step.id);
    }
  }
  const j05 = oracle.journeys.find((journey) => journey.journeyId === "J-05");
  const wrongPurposeFixture = j05.steps[0].inputCases.find((item) => item.expectedDecision === "REJECT_WRONG_PURPOSE");
  assert.equal(wrongPurposeFixture.selectedCapabilityRef, "media.generate.image.text-to-image");
  const wrongButValid = structuredClone(j05.steps[0]);
  const generated = capabilityById.get(wrongPurposeFixture.selectedCapabilityRef);
  wrongButValid.capabilityOptions[0] = {
    capabilityRef: generated.id,
    operationRefs: generated.ownerDefinition.operationRefs,
    operationKind: generated.ownerDefinition.operationKind,
    requirementRefs: ["MEDIA-REQ-CAP-GENERATE-IMAGE"],
  };
  assert.equal(validatePdp3StepCapabilityPurpose(wrongButValid, capabilityById, p0ById.get("J-05")).valid, false);
});
