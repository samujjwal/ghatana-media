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
  ["J-19", [
    ["media.operation.action.inspect-quality-evidence", "media.pdp3.step-purpose-binding.j19-step-01.v1"],
    ["media.operation.action.review-processing-parameters", "media.pdp3.step-purpose-binding.j19-step-02.v1"],
    ["media.operation.action.compare-candidate-on-metric", "media.pdp3.step-purpose-binding.j19-step-03.v1"],
    ["media.operation.action.submit-render", "media.pdp3.step-purpose-binding.j19-step-04.v1"],
  ]],
  ["J-28", [
    ["media.operation.action.submit-render", "media.pdp3.step-purpose-binding.j28-step-03.v1"],
  ]],
]);

test("J13/J14/J19/J28 bind each exact P1 operation result to its purpose and source semantics", () => {
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
    const contractNames = {
      "J-13": "animate-3d-scenes-and-characters",
      "J-14": "explore-domain-simulation-and-review-measurements",
      "J-19": "inspect-quality-and-optimize-within-bounds",
      "J-28": "export-spatial-media-with-format-loss-reporting",
    };
    const journeyPath = `.product-experience/pdp-3-product-experience/journey-contracts/${contractNames[journeyId]}.yaml`;
    const journey = readYaml(journeyPath);
    const bindings = journey.pdp1ResultEvidence?.operationResultBindings ?? [];
    assert.deepEqual(bindings.map(({ operationRef, journeyPurposeBindingRef }) => [
      operationRef,
      journeyPurposeBindingRef.split("@id=")[1],
    ]), expectedBindings, `${journeyId} result bindings cover the exact audited operation/purpose pairs`);
    const resultContractsByPair = new Map();
    for (const binding of bindings) {
      const pair = `${binding.operationRef}|${binding.journeyPurposeBindingRef}`;
      const contracts = resultContractsByPair.get(pair) ?? [];
      contracts.push(binding.typedObservationContractRef ?? binding.resultSchemaRef);
      resultContractsByPair.set(pair, contracts);
    }
    for (const [pair, contracts] of resultContractsByPair) {
      assert.equal(new Set(contracts).size, contracts.length, `${journeyId} ${pair} repeats only for distinct result contracts`);
    }

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

test("MDC-30 render and simulation journeys preserve exact upstream definition blockers", () => {
  const j13 = readYaml(".product-experience/pdp-3-product-experience/journey-contracts/animate-3d-scenes-and-characters.yaml");
  const j14 = readYaml(".product-experience/pdp-3-product-experience/journey-contracts/explore-domain-simulation-and-review-measurements.yaml");
  const j19 = readYaml(".product-experience/pdp-3-product-experience/journey-contracts/inspect-quality-and-optimize-within-bounds.yaml");
  const j28 = readYaml(".product-experience/pdp-3-product-experience/journey-contracts/export-spatial-media-with-format-loss-reporting.yaml");

  assert.equal(j13.sourceGap.id, "MDC30-C-13-render-completion-and-conversion-observation");
  assert.equal(j13.sourceGap.status, "UNKNOWN_NOT_ADMITTED");
  assert.match(j13.sourceGap.missingOwnerDefinition, /admission,\s*not terminal rendering/i);
  assert.match(j13.sourceGap.missingOwnerDefinition, /typed format\/geometry conversion-loss report/i);
  assert.match(j13.pdp1ResultEvidence.operationResultBindings[0].exactResult, /durable job admission only/i);

  assert.equal(j14.sourceGap.id, "MDC30-C-14-terminal-simulation-render-observation");
  assert.equal(j14.sourceGap.status, "UNKNOWN_NOT_ADMITTED");
  assert.match(j14.sourceGap.missingOwnerDefinition, /does\s+not join that envelope to a typed simulation-pass result/i);
  assert.match(j14.sourceGap.missingOwnerDefinition, /exact constraints\/units\/fidelity semantics/i);
  assert.equal(j14.sourceGap.integrationDisposition, "HOST_DEPENDENT; NOT_ADMITTED");
  assert.ok(j14.channels.includes("media.channel.product-integration"));
  assert.equal(j14.channelBindingState.includes("NOT_ADMITTED"), true);

  assert.equal(j19.pdp1ResultEvidence.terminalOutcomeObservationGap.status, "SOURCE_DEFINITION_MISSING; TERMINAL_OPTIMIZATION_NOT_BOUND");
  assert.match(j19.pdp1ResultEvidence.terminalOutcomeObservationGap.missingOwnerDefinition, /no source-defined operation\/result selects or declines/i);
  assert.match(j19.pdp1ResultEvidence.terminalOutcomeObservationGap.disposition, /do not infer selection, render completion, or output version/i);

  assert.equal(j28.sourceGap.status, "UNKNOWN_NOT_ADMITTED");
  assert.equal(j28.sourceGap.integrationDisposition, "HOST_DEPENDENT; NOT_ADMITTED");
  assert.match(j28.sourceGap.missingOwnerDefinition, /no conversion-report result/i);
  assert.match(j28.sourceGap.boundary, /no result, receipt, or runtime admission is inferred/i);

  assert.equal(j19.pdp1ResultEvidence.status, "SOURCE_BOUND_DEFINITION_ONLY; CHANNEL_TRANSPORT_UNBOUND; RUNTIME_NOT_ADMITTED");
  assert.equal(j19.pdp1ResultEvidence.terminalOutcomeObservationGap.status, "SOURCE_DEFINITION_MISSING; TERMINAL_OPTIMIZATION_NOT_BOUND");
  assert.match(j19.pdp1ResultEvidence.terminalOutcomeObservationGap.missingOwnerDefinition, /no source-defined operation\/result selects or declines/i);
  assert.match(j19.pdp1ResultEvidence.terminalOutcomeObservationGap.missingOwnerDefinition, /no J-19 purpose-bound observation joins render completion/i);
  assert.match(j19.pdp1ResultEvidence.terminalOutcomeObservationGap.disposition, /do not infer selection, render completion, or output version/i);

  assert.equal(j28.pdp1ResultEvidence.status, "SOURCE_BOUND_DEFINITION_ONLY; CHANNEL_TRANSPORT_UNBOUND; RUNTIME_NOT_ADMITTED");
  assert.match(j28.pdp1ResultEvidence.operationResultBindings[0].exactResult, /durable job admission only/i);
  assert.match(j28.pdp1ResultEvidence.operationResultBindings[0].exactResult, /conversion loss, consumer receipt, and delivery are not established/i);
  assert.match(j28.sourceGap.missingOwnerDefinition, /inspect-output-\s*preview-and-version defines output lineage but has no J-28 purpose\/operation join/i);
});

test("J19 and J28 bind only their source-defined operations and retain terminal-result gaps", () => {
  const cases = [
    ["J-19", "inspect-quality-and-optimize-within-bounds", [
      ["media.operation.action.inspect-quality-evidence", "media.pdp3.step-purpose-binding.j19-step-01.v1"],
      ["media.operation.action.review-processing-parameters", "media.pdp3.step-purpose-binding.j19-step-02.v1"],
      ["media.operation.action.compare-candidate-on-metric", "media.pdp3.step-purpose-binding.j19-step-03.v1"],
      ["media.operation.action.submit-render", "media.pdp3.step-purpose-binding.j19-step-04.v1"],
    ]],
    ["J-28", "export-spatial-media-with-format-loss-reporting", [
      ["media.operation.action.submit-render", "media.pdp3.step-purpose-binding.j28-step-03.v1"],
    ]],
  ];
  const operations = readYaml(operationsPath);
  const purposes = new Map(readYaml(purposePath).records.map((record) => [record.id, record]));
  for (const [journeyId, contractName, expectedBindings] of cases) {
    const journey = readYaml(`.product-experience/pdp-3-product-experience/journey-contracts/${contractName}.yaml`);
    const bindings = journey.pdp1ResultEvidence.operationResultBindings;
    assert.deepEqual(bindings.map(({ operationRef, journeyPurposeBindingRef }) => [
      operationRef,
      journeyPurposeBindingRef.split("@id=")[1],
    ]), expectedBindings, `${journeyId} has only its explicitly bound P1 operations`);
    for (const binding of bindings) {
      const operation = [
        ...(operations.ownerDefinedOperationContracts?.records ?? []),
        ...(operations.operations ?? []),
      ].find((candidate) => candidate.id === binding.operationRef);
      const purpose = purposes.get(binding.journeyPurposeBindingRef.split("@id=")[1]);
      assert.ok(operation, `${journeyId} P1 operation resolves`);
      assert.ok(purpose, `${journeyId} purpose resolves`);
      assert.equal(purpose.journeyRef, journeyId);
      assert.equal(purpose.stepRef, binding.journeyStepRef);
      assert.ok([...(purpose.operationRefs ?? []), ...(purpose.actionExactOperationRefs ?? [])].includes(binding.operationRef));
      assert.equal(binding.operationVersion, operation.contractVersion);
      assert.deepEqual(binding.authorityRefs, operation.authorityRefs);
      if (binding.operationRef === "media.operation.action.submit-render") {
        assert.match(binding.exactResult, /durable job admission only/i);
      } else {
        assert.match(binding.exactResult, /immediate result is the exact-target scoped owner observation/i);
      }
      assert.match(binding.unknownDisposition, /UNKNOWN|unknown/i);
      assert.equal(binding.unknownDispositionRef, unknownOutcomeRef);
      assert.ok(!Object.hasOwn(binding, "stateRefs"));
      assert.ok(!Object.hasOwn(binding, "transitionRefs"));
    }
    assert.match(journey.pdp1ResultEvidence.status, /SOURCE_BOUND_DEFINITION_ONLY/);
    assert.match(journey.pdp1ResultEvidence.status, /CHANNEL_TRANSPORT_UNBOUND/);
    assert.match(journey.pdp1ResultEvidence.status, /RUNTIME_NOT_ADMITTED/);
  }
  const j19 = readYaml(".product-experience/pdp-3-product-experience/journey-contracts/inspect-quality-and-optimize-within-bounds.yaml");
  assert.equal(j19.pdp1ResultEvidence.terminalOutcomeObservationGap.status, "SOURCE_DEFINITION_MISSING; TERMINAL_OPTIMIZATION_NOT_BOUND");
  assert.match(j19.pdp1ResultEvidence.terminalOutcomeObservationGap.disposition, /do not infer selection, render completion, or output version/i);
  const j28 = readYaml(".product-experience/pdp-3-product-experience/journey-contracts/export-spatial-media-with-format-loss-reporting.yaml");
  assert.match(j28.sourceGap.missingOwnerDefinition, /no conversion-report result/i);
  assert.match(j28.sourceGap.boundary, /no result, receipt, or runtime admission is inferred/i);
});
