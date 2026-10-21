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
    ["media.operation.action.deliver-exact-version", "media.pdp3.step-purpose-binding.j28-step-04.v1"],
    ["media.operation.action.reconcile-delivery-acknowledgment", "media.pdp3.step-purpose-binding.j28-step-04.v1"],
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
    const bindings = (journey.pdp1ResultEvidence?.operationResultBindings ?? []).filter(({ operationRef }) => operationRef);
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
      const relatedOperationRefs = (purpose.relatedActionBindings ?? []).map(({ operationRef }) => operationRef);
      assert.ok([
        ...(purpose.operationRefs ?? []),
        ...(purpose.actionExactOperationRefs ?? []),
        ...relatedOperationRefs,
      ].includes(binding.operationRef));
      assert.equal(binding.operationSourceRef, `${operationsPath}#ownerDefinedOperationContracts/records/@id=${binding.operationRef}`);
      assert.equal(binding.operationVersion, operation.contractVersion);
      assert.equal(binding.operationVersionRef, `${binding.operationSourceRef}/contractVersion`);
      if (binding.authorityRefs) {
        assert.deepEqual(binding.authorityRefs, operation.authorityRefs);
      }
      if (binding.unknownDispositionRef) {
        assert.equal(binding.unknownDispositionRef, unknownOutcomeRef);
      }
      assert.ok(binding.exactResult?.trim());
      assert.ok(binding.unknownDisposition?.trim());
      assert.ok(!Object.hasOwn(binding, "stateRefs"), "result bindings do not invent state mappings");
      assert.ok(!Object.hasOwn(binding, "transitionRefs"), "result bindings do not invent transition mappings");

      const profile = profiles.get(operation.profileRef);
      assert.ok(profile, `${binding.operationRef} profile resolves`);
      if (binding.finalityRef) {
        assert.equal(binding.finalityRef, `${operationsPath}#ownerDefinedOperationProfiles/profiles/@id=${profile.id}/finality`);
      }
      if (binding.errorsRef) {
        assert.equal(binding.errorsRef, `${operationsPath}#ownerDefinedOperationProfiles/profiles/@id=${profile.id}/errors`);
      }
      if (binding.recoveryRef) {
        assert.equal(binding.recoveryRef, `${operationsPath}#ownerDefinedOperationProfiles/profiles/@id=${profile.id}/recovery`);
      }

      if (binding.typedObservationContractRef) {
        const observationId = binding.typedObservationContractRef.split("@id=")[1];
        const observation = observations.get(observationId);
        assert.ok(observation, `${observationId} resolves in PDP-1`);
        assert.ok(observation.operationRefs.includes(binding.operationRef));
        assert.equal(binding.observationContractRef, binding.typedObservationContractRef);
        assert.equal(binding.resultSchemaRef, `${binding.typedObservationContractRef}/resultSchema`);
      } else {
        const directOperationResultSchemaRef = `${operationsPath}#ownerDefinedOperationContracts/records/@id=${binding.operationRef}/resultSchema`;
        assert.ok([
          directOperationResultSchemaRef,
          `${operationsPath}#ownerDefinedOperationProfiles/profiles/@id=${profile.id}/resultEnvelope`,
        ].includes(binding.resultSchemaRef) || /^\.product-experience\/pdp-1-domain-data\/operations\.yaml#ownerTypedObservationContracts\/records\/@id=[^/]+\/resultSchema$/u.test(binding.resultSchemaRef), `${binding.operationRef} result schema resolves to its contract, profile, or typed observation`);
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
  assert.match(j13.sourceGap.missingJourneyAllocation, /do not produce runtime observations or establish that a submitted job produced a particular output/i);
  assert.match(j13.sourceGap.missingJourneyAllocation, /preserve UNKNOWN/i);
  assert.equal(j13.pdp1ResultEvidence.postRenderObservationBindings.status, "SOURCE_BOUND_GENERIC_OBSERVATIONS; J13_RUNTIME_AND_PRODUCER_OUTPUT_JOIN_NOT_ADMITTED");
  assert.equal(j13.pdp1ResultEvidence.postRenderObservationBindings.jobStatus.operationRef, "media.operation.job-status.read-dimensions.v1");
  assert.equal(j13.pdp1ResultEvidence.postRenderObservationBindings.outputVersionLineage.operationRef, "media.operation.action.inspect-output-preview-and-version");
  assert.match(j13.pdp1ResultEvidence.postRenderObservationBindings.outputVersionLineage.producerJoinBoundary, /does not name a job/i);
  assert.deepEqual(j13.pdp1ResultEvidence.postRenderObservationBindings.exportLossReportBinding.requiredReportFields, [
    "sourceArtifactRef", "sourceArtifactVersionRef", "targetFormatProfileRef", "targetFormatProfileVersionRef", "sourceGeometryPlanRef",
    "coordinateTransformRef", "unitTransformRef", "axisTransformRef", "handednessDisposition", "originDisposition", "fieldDispositionRecords",
    "unsupportedFieldDisposition", "integrityEvidenceRef",
  ]);
  assert.match(j13.pdp1ResultEvidence.operationResultBindings[0].exactResult, /durable job admission only/i);

  assert.equal(j14.sourceGap.id, "MDC30-C-14-terminal-simulation-render-observation");
  assert.equal(j14.sourceGap.status, "UNKNOWN_NOT_ADMITTED");
  assert.match(j14.sourceGap.missingRuntimeEvidence, /J-14 binds a follow-up inspect-simulation-result query only when its exact target equals that returned mediaRunRef/i);
  assert.match(j14.sourceGap.missingRuntimeEvidence, /no query\/capability invocation, measurement result, scientific validity, or render completion is asserted/i);
  assert.equal(j14.sourceGap.integrationDisposition, "HOST_DEPENDENT; NOT_ADMITTED");
  assert.ok(j14.channels.includes("media.channel.product-integration"));
  assert.equal(j14.channelBindingState.includes("NOT_ADMITTED"), true);
  assert.equal(j14.pdp1ResultEvidence.capabilityResultBindings[0].operationRef, "media.operation.capability.media-simulation-output-measurements");
  assert.equal(j14.pdp1ResultEvidence.capabilityResultBindings[0].ownerWireContractRef, ".product-experience/pdp-1-domain-data/operations.yaml#ownerLeafWireContracts/records/@id=media.owner-wire-contract.simulation-measurements.v1");
  assert.match(j14.pdp1ResultEvidence.capabilityResultBindings[0].exactResult, /PRODUCED versus ESTIMATED remains explicit/i);

  assert.equal(j28.sourceGap.status, "UNKNOWN_NOT_ADMITTED");
  assert.equal(j28.sourceGap.integrationDisposition, "HOST_DEPENDENT; NOT_ADMITTED");
  assert.match(j28.sourceGap.missingJourneyEvidence, /do not establish job-to-output production, export execution, package persistence, conversion-report receipt, or actual consumer receipt/i);
  assert.match(j28.sourceGap.boundary, /no result, receipt, or runtime admission is inferred/i);

  assert.equal(j28.pdp1ResultEvidence.status, "SOURCE_BOUND_DEFINITION_ONLY; CHANNEL_TRANSPORT_UNBOUND; RUNTIME_NOT_ADMITTED");
  assert.match(j28.pdp1ResultEvidence.operationResultBindings[0].exactResult, /durable job admission only/i);
  assert.match(j28.pdp1ResultEvidence.operationResultBindings[0].exactResult, /conversion loss, consumer receipt, and delivery are not established/i);
  assert.equal(j28.pdp1ResultEvidence.journeySourceBindings.spatialExport.deliveryReceiptBinding.deliveryOperationRef, "media.operation.action.deliver-exact-version");
  assert.equal(j28.pdp1ResultEvidence.journeySourceBindings.spatialExport.deliveryReceiptBinding.acknowledgmentObservationRef, ".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.destination-delivery-acknowledgment.v1");
  assert.match(j28.pdp1ResultEvidence.journeySourceBindings.spatialExport.deliveryReceiptBinding.purposeBindingBoundary, /EXPLICIT_NO_DOMAIN_DISPATCH and no operationRefs/i);
  assert.match(j28.pdp1ResultEvidence.journeySourceBindings.spatialExport.deliveryReceiptBinding.conditionalReceiptJoin, /original request result, request ID, fingerprint, artifact version, and destination match exactly/i);
  assert.match(j28.pdp1ResultEvidence.journeySourceBindings.spatialExport.deliveryReceiptBinding.pendingDisposition, /render admission\/completion, output lineage, nor the request receipt establishes consumer receipt or conversion-report receipt/i);
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
      ["media.operation.action.deliver-exact-version", "media.pdp3.step-purpose-binding.j28-step-04.v1"],
      ["media.operation.action.reconcile-delivery-acknowledgment", "media.pdp3.step-purpose-binding.j28-step-04.v1"],
    ]],
  ];
  const operations = readYaml(operationsPath);
  const purposes = new Map(readYaml(purposePath).records.map((record) => [record.id, record]));
  for (const [journeyId, contractName, expectedBindings] of cases) {
    const journey = readYaml(`.product-experience/pdp-3-product-experience/journey-contracts/${contractName}.yaml`);
    const bindings = journey.pdp1ResultEvidence.operationResultBindings.filter(({ operationRef }) => operationRef);
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
      const relatedOperationRefs = (purpose.relatedActionBindings ?? []).map(({ operationRef }) => operationRef);
      assert.ok([
        ...(purpose.operationRefs ?? []),
        ...(purpose.actionExactOperationRefs ?? []),
        ...relatedOperationRefs,
      ].includes(binding.operationRef));
      assert.equal(binding.operationVersion, operation.contractVersion);
      if (binding.authorityRefs) {
        assert.deepEqual(binding.authorityRefs, operation.authorityRefs);
      }
      if (binding.operationRef === "media.operation.action.submit-render") {
        assert.match(binding.exactResult, /durable admission only|durable job admission only/i);
      } else if (binding.operationRef === "media.operation.action.compare-candidate-on-metric") {
        assert.match(binding.exactResult, /P1 v2 returns the exact distinct originalArtifactVersionRef and candidateArtifactVersionRef/i);
      } else if (binding.operationRef === "media.operation.action.deliver-exact-version") {
        assert.match(binding.exactResult, /REQUEST_ACCEPTED is a submission receipt/i);
        assert.match(binding.exactResult, /does not establish destination receipt/i);
      } else if (binding.operationRef === "media.operation.action.reconcile-delivery-acknowledgment") {
        assert.match(binding.exactResult, /query receipt is not destination evidence/i);
        assert.match(binding.exactResult, /exactly joined to the original delivery result/i);
      } else {
        assert.match(binding.exactResult, /immediate result is the exact-target scoped owner observation/i);
      }
      if (binding.operationRef === "media.operation.action.deliver-exact-version") {
        assert.match(binding.unknownDisposition, /uncertain request is reconciled before any authorized retry/i);
      } else {
        assert.match(binding.unknownDisposition, /UNKNOWN|unknown/i);
      }
      if (binding.unknownDispositionRef) {
        assert.equal(binding.unknownDispositionRef, unknownOutcomeRef);
      }
      assert.ok(!Object.hasOwn(binding, "stateRefs"));
      assert.ok(!Object.hasOwn(binding, "transitionRefs"));
    }
    assert.match(journey.pdp1ResultEvidence.status, /SOURCE_BOUND_DEFINITION_ONLY/);
    assert.match(journey.pdp1ResultEvidence.status, /CHANNEL_TRANSPORT_UNBOUND/);
    assert.match(journey.pdp1ResultEvidence.status, /RUNTIME_NOT_ADMITTED/);
  }
  const j19 = readYaml(".product-experience/pdp-3-product-experience/journey-contracts/inspect-quality-and-optimize-within-bounds.yaml");
  assert.equal(j19.pdp1ResultEvidence.status, "SOURCE_BOUND_DEFINITION_ONLY; CHANNEL_TRANSPORT_UNBOUND; RUNTIME_NOT_ADMITTED");
  const choice = j19.terminalOutcomeBinding;
  assert.equal(choice.status, "P3_LOCAL_USER_CHOICE_BOUND; RUNTIME_NOT_ADMITTED");
  assert.equal(choice.sourceCompletionRef, ".product-experience/pdp-0-product-truth/journey-catalog.yaml#journeys/@id=J-19/completion");
  assert.equal(choice.sourceChoiceSemanticsRef, ".product-experience/pdp-3-product-experience/action-registry.yaml#actions/@id=media.action.select-exact-candidates/actionDefinitionSemantics/typedDefinition");
  assert.deepEqual(choice.exactChoice.allowedValues, ["SELECT_SUCCESSOR", "DECLINE_SUCCESSOR"]);
  assert.equal(choice.actionRef, "media.action.select-exact-candidates");
  assert.deepEqual(choice.actionSemantics.operationRefs, []);
  assert.equal(choice.actionSemantics.finality, "local-draft-only; not-a-committed-result");
  assert.match(choice.exactResult.selectSuccessor, /exact candidateArtifactVersionRef selected by the user/i);
  assert.match(choice.exactResult.declineSuccessor, /retain the exact originalArtifactVersionRef/i);
  assert.match(choice.eligibility.otherwise, /preserve NOT_COMPARABLE and UNKNOWN/i);
  assert.match(choice.boundary, /is J19 completion/i);
  assert.match(choice.boundary, /optional M-RENDER next action remains separate/i);
  const j28 = readYaml(".product-experience/pdp-3-product-experience/journey-contracts/export-spatial-media-with-format-loss-reporting.yaml");
  assert.match(j28.sourceGap.missingJourneyEvidence, /do not establish job-to-output production, export execution, package persistence, conversion-report receipt, or actual consumer receipt/i);
  assert.match(j28.sourceGap.boundary, /no result, receipt, or runtime admission is inferred/i);
});

test("J19 keeps local completion separate from the optional render operation", () => {
  const journey = readYaml(".product-experience/pdp-3-product-experience/journey-contracts/inspect-quality-and-optimize-within-bounds.yaml");
  const bindings = journey.pdp1ResultEvidence.operationResultBindings;
  const choice = journey.terminalOutcomeBinding;
  assert.equal(journey.steps.length, 4);
  assert.equal(choice.terminalStepRef, ".product-experience/pdp-3-product-experience/journey-contracts/inspect-quality-and-optimize-within-bounds.yaml#/steps/2");
  assert.match(choice.terminalActionBindingRef, /j19-successor-choice\.v1$/u);
  assert.equal(choice.actionRef, "media.action.select-exact-candidates");
  assert.deepEqual(choice.actionSemantics.operationRefs, []);
  const renderBinding = bindings.find(({ operationRef }) => operationRef === "media.operation.action.submit-render");
  assert.equal(renderBinding.journeyStepRef, ".product-experience/pdp-3-product-experience/journey-contracts/inspect-quality-and-optimize-within-bounds.yaml#/steps/3");
  assert.equal(renderBinding.journeyPurposeBindingRef, ".product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml#records/@id=media.pdp3.step-purpose-binding.j19-step-04.v1");
  assert.match(renderBinding.exactResult, /durable admission only/i);
  assert.match(renderBinding.exactResult, /not the J19 selection\/decline completion result/i);
  assert.equal(journey.pdp1ResultEvidence.status, "SOURCE_BOUND_DEFINITION_ONLY; CHANNEL_TRANSPORT_UNBOUND; RUNTIME_NOT_ADMITTED");
});
