import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const toolsRequire = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = toolsRequire("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const operationsPath = ".product-experience/pdp-1-domain-data/operations.yaml";
const purposePath = ".product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml";
const unknownOutcomeRef = ".product-experience/pdp-1-domain-data/action-contracts.yaml#outcomes/@id=UNKNOWN_OUTCOME";

const expected = new Map([
  ["J-13", [
    ["media.operation.action.submit-render", "media.pdp3.step-purpose-binding.j13-step-03.v1"],
    ["media.operation.action.inspect-output-preview-and-version", "media.pdp3.step-purpose-binding.j13-step-04.v1"],
  ]],
  ["J-14", [
    ["media.operation.action.inspect-simulation-result", "media.pdp3.step-purpose-binding.j14-step-02.v1"],
    ["media.operation.action.inspect-quality-evidence", "media.pdp3.step-purpose-binding.j14-step-03.v1"],
    ["media.operation.action.inspect-quality-evidence", "media.pdp3.step-purpose-binding.j14-step-03.v1"],
    ["media.operation.action.submit-render", "media.pdp3.step-purpose-binding.j14-step-04.v1"],
  ]],
]);

test("J13 and J14 bind each exact P1 operation result to its purpose and source semantics", () => {
  const operations = readYaml(operationsPath);
  const purposes = new Map(readYaml(purposePath).records.map((record) => [record.id, record]));
  const p1Operations = [
    ...(operations.ownerDefinedOperationContracts?.records ?? []),
    ...(operations.operations ?? []),
  ];
  const operationById = new Map(p1Operations.map((operation) => [operation.id, operation]));
  const profiles = new Map((operations.ownerDefinedOperationProfiles?.profiles ?? []).map((profile) => [profile.id, profile]));
  const observations = new Map((operations.ownerTypedObservationContracts?.records ?? []).map((record) => [record.id, record]));

  for (const [journeyId, expectedBindings] of expected) {
    const journeyPath = `.product-experience/pdp-3-product-experience/journey-contracts/${journeyId === "J-13" ? "animate-3d-scenes-and-characters" : "explore-domain-simulation-and-review-measurements"}.yaml`;
    const journey = readYaml(journeyPath);
    const bindings = journey.pdp1ResultEvidence?.operationResultBindings ?? [];
    assert.deepEqual(bindings.map(({ operationRef, journeyPurposeBindingRef }) => [
      operationRef,
      journeyPurposeBindingRef.split("@id=")[1],
    ]), expectedBindings, `${journeyId} result bindings cover the exact audited operation/purpose pairs`);

    for (const binding of bindings) {
      const operation = operationById.get(binding.operationRef);
      const purpose = purposes.get(binding.journeyPurposeBindingRef.split("@id=")[1]);
      assert.ok(operation, `${journeyId} operation resolves in PDP-1`);
      assert.ok(purpose, `${journeyId} purpose resolves`);
      assert.equal(purpose.journeyRef, journeyId);
      assert.equal(purpose.stepRef, binding.journeyStepRef);
      assert.ok([...(purpose.operationRefs ?? []), ...(purpose.actionExactOperationRefs ?? [])].includes(binding.operationRef));
      assert.equal(binding.operationSourceRef, `${operationsPath}#ownerDefinedOperationContracts/records/@id=${binding.operationRef}`);
      assert.equal(binding.operationVersion, operation.contractVersion);
      assert.equal(binding.operationVersionRef, `${binding.operationSourceRef}/contractVersion`);
      assert.deepEqual(binding.authorityRefs, operation.authorityRefs);
      assert.equal(binding.unknownDispositionRef, unknownOutcomeRef);
      assert.ok(binding.exactResult?.trim());
      assert.ok(binding.unknownDisposition?.trim());
      assert.ok(!Object.hasOwn(binding, "stateRefs"), "result bindings do not invent state mappings");
      assert.ok(!Object.hasOwn(binding, "transitionRefs"), "result bindings do not invent transition mappings");

      const profile = profiles.get(operation.profileRef);
      assert.ok(profile, `${binding.operationRef} profile resolves`);
      assert.equal(binding.finalityRef, `${operationsPath}#ownerDefinedOperationProfiles/profiles/@id=${profile.id}/finality`);
      assert.equal(binding.errorsRef, `${operationsPath}#ownerDefinedOperationProfiles/profiles/@id=${profile.id}/errors`);
      assert.equal(binding.recoveryRef, `${operationsPath}#ownerDefinedOperationProfiles/profiles/@id=${profile.id}/recovery`);

      if (binding.typedObservationContractRef) {
        const observationId = binding.typedObservationContractRef.split("@id=")[1];
        const observation = observations.get(observationId);
        assert.ok(observation, `${observationId} resolves in PDP-1`);
        assert.ok(observation.operationRefs.includes(binding.operationRef));
        assert.equal(binding.observationContractRef, binding.typedObservationContractRef);
        assert.equal(binding.resultSchemaRef, `${binding.typedObservationContractRef}/resultSchema`);
      } else {
        assert.equal(binding.resultSchemaRef, `${operationsPath}#ownerDefinedOperationProfiles/profiles/@id=${profile.id}/resultEnvelope`);
      }
    }
  }
});
