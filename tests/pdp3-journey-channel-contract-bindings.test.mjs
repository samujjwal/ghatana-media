import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { assertLocalStepNoP1MachineProofs, assertOperationStateProofs } from "./lib/pdp3-operation-state-proof.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const toolsRequire = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = toolsRequire("yaml");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const readYaml = (path) => parse(read(path));

const registryPath = ".product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml";
const packetPath = "docs/implementation/observations/media-discovery-pdp3-owner-binding-directions-2026-10-13.json";
const journeyPurposePath = ".product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml";
const operationPath = ".product-experience/pdp-1-domain-data/operations.yaml";
const statePath = ".product-experience/pdp-1-domain-data/states.yaml";
const apiPath = ".product-experience/pdp-3-product-experience/api/api-registry.yaml";
const sdkPath = ".product-experience/pdp-3-product-experience/sdk/operation-registry.yaml";
const productionCliPath = ".product-experience/pdp-3-product-experience/cli/production-command-registry.yaml";
const fixtureCliPath = ".product-experience/pdp-3-product-experience/cli/command-registry.yaml";
const scenarioFixturePath = ".product-experience/pdp-3-product-experience/scenario-fixture-registry.yaml";
const localStepEffectPath = ".product-experience/pdp-3-product-experience/local-step-effect-contracts.yaml";
const operationStateProofEdgeIds = new Set([
  "media.pdp3.channel-binding.j07.web.v1",
  "media.pdp3.channel-binding.j11.web.v1",
  "media.pdp3.channel-binding.j12.web.v1",
  "media.pdp3.channel-binding.j15.web.v1",
  "media.pdp3.channel-binding.j15.product-integration.v1",
  "media.pdp3.channel-binding.j17.web.v1",
  "media.pdp3.channel-binding.j21.web.v1",
  "media.pdp3.channel-binding.j21.product-integration.v1",
  "media.pdp3.channel-binding.j06.http-api.v1",
  "media.pdp3.channel-binding.j06.grpc-api.v1",
  "media.pdp3.channel-binding.j06.product-integration.v1",
]);

function operationRecords(document) {
  return [
    ...(document.operations ?? []),
    ...(document.individualOperationContracts?.records ?? []),
    ...(document.ownerDefinedOperationContracts?.records ?? []),
    ...(document.capabilityOperationContracts?.records ?? []),
  ];
}

function pairKey(edge) {
  return `${edge.journeyRef}\u0000${edge.channelRef}`;
}

function assertValid(document, sources) {
  const { packet, operations, states, api, sdk, productionCli, fixtureCli, journeyPurpose, scenarioFixtures } = sources;
  const intended = packet.journeyChannelTasks.flatMap((task) =>
    task.channelBindingsToAuthor.map((binding) => ({
      taskId: task.taskId,
      journeyId: task.journeyId,
      channelRef: binding.channelRef,
      consumerSurfaceId: binding.consumerSurfaceId,
      contractSource: task.contractSource,
    })),
  );
  const keys = document.edges.map(pairKey);
  assert.equal(new Set(keys).size, keys.length, "journey×channel edge pairs are unique");
  assert.equal(new Set(document.edges.map((edge) => edge.id)).size, document.edges.length, "edge IDs are unique");
  assert.equal(document.edges.length, 61, "all 61 owner-approved edges are present");
  assert.deepEqual(
    [...keys].sort(),
    intended.map((edge) => `${edge.journeyId}\u0000${edge.channelRef}`).sort(),
    "the edge denominator exactly matches the owner packet",
  );

  const operationsById = new Map(operationRecords(operations).map((operation) => [operation.id, operation]));
  const apiById = new Map((api.operations ?? []).map((operation) => [operation.id, operation]));
  const sdkById = new Map((sdk.methods ?? []).map((method) => [method.id, method]));
  const productionCommandsById = new Map((productionCli.commands ?? []).map((command) => [command.id, command]));
  const fixtureCommandIds = new Set((fixtureCli.commands ?? []).map((command) => command.id));
  const purposeById = new Map((journeyPurpose.records ?? []).map((record) => [record.id, record]));
  const observationById = new Map((operations.ownerTypedObservationContracts?.records ?? []).map((record) => [record.id, record]));
  const canonicalFixtureIds = new Set([
    ...(scenarioFixtures.stepDefinitionOracleCoverage.records ?? []).map((record) => record.fixtureId),
    ...(scenarioFixtures.fixtures ?? []).map((fixture) => fixture.id),
  ]);
  const localStepEffectsById = new Map((readYaml(localStepEffectPath).records ?? []).map((record) => [record.id, record]));
  const requiredFields = [
    "journeyId", "channelRef", "consumerSurfaceId", "pdp1OperationRefs",
    "pdp1StateOrObservationRefs", "pdp2GrammarRef", "typedRequestResultErrors",
    "authorityAndVersion", "deniedUnknownRecovery", "finality",
    "transportRefOrUnbound", "runtimeAdmission", "fixtureIds",
  ];
  const exactStateRefExists = (ref) => {
    const match = ref.match(/^\.product-experience\/pdp-1-domain-data\/states\.yaml#stateMachines\/([^/]+)\/stateDefinitions\/([^/]+)$/);
    if (!match) return false;
    const machine = (states.stateMachines ?? []).find((item) => item.machineId === match[1]);
    return Boolean(machine?.stateDefinitions?.some((state) => state.id === match[2]));
  };
  const exactStateSourceRefExists = (ref) => {
    const machineRef = /^\.product-experience\/pdp-1-domain-data\/states\.yaml#([^/#]+)$/.exec(ref);
    if (machineRef) return Boolean((states.stateMachines ?? []).some((machine) => machine.machineId === machineRef[1]));
    const stateFamilyRef = /^\.product-experience\/pdp-1-domain-data\/states\.yaml#stateMachines\/([^/#]+)\/stateDefinitions$/.exec(ref);
    if (!stateFamilyRef) return false;
    const machine = (states.stateMachines ?? []).find((item) => item.machineId === stateFamilyRef[1]);
    return Boolean(machine?.stateDefinitions?.length);
  };
  const exactObservationRef = (ref) => {
    const match = ref.match(/^\.product-experience\/pdp-1-domain-data\/operations\.yaml#ownerTypedObservationContracts\/records\/@id=(.+)$/);
    return match ? observationById.get(match[1]) : undefined;
  };

  for (const edgeId of operationStateProofEdgeIds) {
    const edge = document.edges.find((item) => item.id === edgeId);
    assert.ok(edge, `${edgeId} remains in the owner-approved edge denominator`);
  }

  for (const expected of intended) {
    const edge = document.edges.find((item) => item.journeyRef === expected.journeyId && item.channelRef === expected.channelRef);
    assert.ok(edge, `${expected.taskId} has an edge`);
    if (edge.logicalDefinitionDisposition === "SOURCE_BOUND_DEFINITION_ONLY" || Object.hasOwn(edge, "p1OperationStateProofs")) {
      assertOperationStateProofs(edge, { operationsById, purposeById, exactStateRefExists, exactStateSourceRefExists, exactObservationRef, journeyOperationBindings: operations.ownerDefinedJourneyOperationBindings?.records ?? [], journeyContract: readYaml(edge.journeyContractRef) });
      if (Object.hasOwn(edge, "localStepNoP1MachineProofs")) {
        assertLocalStepNoP1MachineProofs(edge, {
          journeyContract: readYaml(edge.journeyContractRef.split("#")[0]),
          purposeById,
          localStepEffectsById,
        });
      }
    }
    for (const field of requiredFields) assert.ok(Object.hasOwn(edge, field), `${edge.id} explicitly exposes ${field}`);
    assert.equal(edge.journeyId, expected.journeyId);
    assert.equal(edge.taskId, expected.taskId);
    assert.equal(edge.consumerSurfaceId, expected.consumerSurfaceId);
    assert.equal(edge.journeyContractRef, expected.contractSource);
    assert.ok(edge.purposeBindingRefs.length > 0, `${edge.id} cites journey-purpose bindings`);
    assert.ok(edge.purposeBindingRefs.every((ref) => purposeById.has(ref.split("@id=")[1]?.split(/[&#]/)[0])), `${edge.id} purpose refs resolve`);
    assert.ok(edge.p1OperationBindings.length > 0, `${edge.id} carries its exact journey operation inventory`);
    assert.deepEqual(edge.pdp1OperationRefs, [...new Set(edge.p1OperationBindings.map((binding) => binding.operationRef))]);
    assert.ok(edge.p1OperationBindings.every((binding) => operationsById.has(binding.operationRef)), `${edge.id} uses known P1 operation identities`);
    assert.ok(edge.p1OperationBindings.every((binding) => binding.sourceRef.includes(binding.operationRef)), `${edge.id} operation refs resolve to exact P1 records`);
    assert.ok(edge.p1StateRefs.length > 0 || edge.p1ObservationRefs.length > 0, `${edge.id} has P1 state or exact source observation references`);
    for (const field of ["authSourceRefs", "versionSourceRefs", "errorSourceRefs", "finalitySourceRefs", "recoverySourceRefs"]) {
      assert.ok(edge[field].length > 0, `${edge.id} carries ${field}`);
    }
    assert.equal(edge.authBindingDisposition, "SOURCE_RULES_REFERENCED; CHANNEL_AUTHENTICATION_AND_TRUSTED_CONTEXT_BINDING_UNBOUND");
    assert.equal(edge.runtimeAdmission, "NOT_ADMITTED", `${edge.id} cannot admit runtime`);
    const proofOperations = (edge.p1OperationStateProofs ?? []).map((proof) => proof.operationRef);
    const proofCoverageExact = proofOperations.length === edge.p1OperationBindings.length
      && new Set(proofOperations).size === proofOperations.length
      && edge.p1OperationBindings.every((binding) => proofOperations.includes(binding.operationRef));
    const exactLogicalProof = edge.pdp1OperationRefs.length && proofCoverageExact
      && !(edge.logicalDefinitionBlockers ?? []).length && edge.pdp2GrammarRef;
    assert.equal(
      edge.logicalDefinitionDisposition,
      exactLogicalProof ? "SOURCE_BOUND_DEFINITION_ONLY" : "INCOMPLETE_P1_STATE_OR_OBSERVATION_BINDING",
      `${edge.id} requires one source-bound P1 semantic proof per operation and no unresolved blocker`,
    );
    assert.equal(edge.semanticCompleteness, edge.logicalDefinitionDisposition);
    assert.equal(edge.channelTransportEquivalence, "UNBOUND", `${edge.id} does not overclaim end-to-end channel equivalence`);
    assert.equal(edge.transportRefOrUnbound, "UNBOUND", `${edge.id} leaves aggregate channel transport unbound while any operation is unresolved`);
    assert.ok(edge.fixtureIds.length > 0, `${edge.id} cites existing canonical fixtures`);
    assert.ok(edge.fixtureIds.every((id) => canonicalFixtureIds.has(id)), `${edge.id} fixture IDs are source-defined`);
    assert.ok(edge.authorityAndVersion.authoritySourceRefs.length > 0, `${edge.id} authority definition is nonempty`);
    assert.ok(edge.authorityAndVersion.versionSourceRefs.length > 0, `${edge.id} version definition is nonempty`);
    assert.deepEqual(edge.authorityAndVersion.authoritySourceRefs, edge.authSourceRefs);
    assert.deepEqual(edge.authorityAndVersion.versionSourceRefs, edge.versionSourceRefs);
    assert.ok(edge.authorityAndVersion.authoritySourceRefs.some((ref) => ref.includes("authority.yaml#ownership.")));
    assert.ok(edge.authorityAndVersion.versionSourceRefs.some((ref) => ref.includes("versioning.yaml#ownerDefinedRevisionSemantics")));
    assert.equal(edge.authorityAndVersion.authBindingDisposition, "SOURCE_RULES_REFERENCED; CHANNEL_AUTHENTICATION_AND_TRUSTED_CONTEXT_BINDING_UNBOUND");
    assert.equal(edge.authorityAndVersion.versionBindingDisposition, "EXACT_ONLY_PER_SOURCE_CROSSWALK; OTHERWISE_UNBOUND");
    assert.ok(edge.typedRequestResultErrors.sourceRefs.length > 0, `${edge.id} typed request/result/error definitions are nonempty`);
    assert.deepEqual(edge.typedRequestResultErrors.sourceRefs, edge.errorSourceRefs);
    assert.ok(edge.typedRequestResultErrors.sourceRefs.some((ref) => ref.includes("action-contracts.yaml#outcomes")));
    assert.equal(edge.typedRequestResultErrors.disposition, "SOURCE_RULES_REFERENCED; CHANNEL_TYPED_REQUEST_RESULT_ERROR_EQUIVALENCE_UNBOUND");
    assert.ok(edge.deniedUnknownRecovery.sourceRefs.length > 0, `${edge.id} denial and recovery definitions are nonempty`);
    assert.deepEqual(edge.deniedUnknownRecovery.sourceRefs, edge.recoverySourceRefs);
    assert.ok(edge.deniedUnknownRecovery.sourceRefs.includes(edge.deniedUnknownRecovery.unknownOutcomeSourceRef));
    assert.equal(edge.deniedUnknownRecovery.unknownOutcomeSourceRef, ".product-experience/pdp-1-domain-data/action-contracts.yaml#outcomes/@id=UNKNOWN_OUTCOME");
    assert.equal(edge.deniedUnknownRecovery.disposition, edge.unknownOutcomeDisposition);
    assert.ok(edge.finality.sourceRefs.length > 0, `${edge.id} finality definitions are nonempty`);
    assert.deepEqual(edge.finality.sourceRefs, edge.finalitySourceRefs);
    assert.ok(edge.finality.sourceRefs.includes(".product-experience/pdp-2-design-interface-system/action-finality-grammar.yaml"));
    assert.equal(edge.finality.disposition, "SOURCE_FINALITY_RULES_REFERENCED; CHANNEL_FINALITY_EQUIVALENCE_UNBOUND");
    assert.equal(edge.unknownOutcomeDisposition, "PRESERVE_UNKNOWN_AS_NEITHER_SUCCESS_NOR_FAILURE; RECONCILE_SAME_IDENTITY; NO_BLIND_RETRY");
    assert.ok(edge.p2GrammarRef.startsWith(".product-experience/pdp-2-design-interface-system/interface-grammar.yaml#/channels/"));

    for (const binding of edge.p1OperationBindings) {
      const p1Operation = operationsById.get(binding.operationRef);
      const expectedOperationVersion = Number.isSafeInteger(p1Operation.operationVersion)
        ? p1Operation.operationVersion
        : Number.isSafeInteger(p1Operation.contractVersion) ? p1Operation.contractVersion : null;
      assert.equal(binding.operationVersion ?? null, expectedOperationVersion, `${edge.id} preserves the P1 operation version`);
      if (binding.disposition === "SOURCE_BOUND_DEFINITION_ONLY") {
        assert.notEqual(binding.transportRef, "UNBOUND", `${edge.id} has a source-backed transport identity`);
        assert.ok(binding.sourceRefs.length > 0, `${edge.id} transport mapping cites its source`);
        if (edge.channelRef === "media.channel.http-api") {
          const source = apiById.get(binding.transportRef);
          assert.ok(source, `${edge.id} HTTP transport is in the API source registry`);
          assert.equal(source.pdp1OperationRef, binding.operationRef, `${edge.id} HTTP route maps to the same P1 operation`);
          assert.deepEqual(binding.transportIdentity, {
            operationId: source.operationId,
            method: source.method,
            path: source.path,
            routeVersion: `v${p1Operation.contractVersion}`,
          }, `${edge.id} HTTP method/path/version match the source registry`);
        } else if (edge.channelRef === "media.channel.sdk") {
          const source = sdkById.get(binding.transportRef);
          assert.ok(source, `${edge.id} SDK method is in the SDK source registry`);
          assert.equal(source.boundedInterfaceDefinition.operationRef, binding.operationRef);
          assert.equal(binding.transportIdentity.routeVersion, `v${p1Operation.contractVersion}`);
        } else if (edge.channelRef === "media.channel.cli") {
          const source = productionCommandsById.get(binding.transportRef);
          assert.ok(source, `${edge.id} CLI identity comes from the production command registry`);
          assert.equal(source.operationRef, binding.operationRef);
          assert.ok(!fixtureCommandIds.has(binding.transportRef), `${edge.id} does not promote a fixture command`);
        } else {
          assert.fail(`${edge.id} claims a source-bound mapping for an unsupported channel class`);
        }
      } else {
        assert.equal(binding.disposition, "UNBOUND", `${edge.id} unresolved mapping is explicit`);
        assert.equal(binding.transportRef, "UNBOUND", `${edge.id} unresolved transport is explicit`);
      }
    }
    const stateRefs = edge.p1StateRefs
      .filter((state) => state.disposition === "EXACT_P1_STATE_SOURCE_REF")
      .map((state) => state.stateRef);
    for (const ref of stateRefs) assert.ok(exactStateRefExists(ref), `${edge.id} exact state selector resolves against PDP-1 states: ${ref}`);
    const observationRefs = edge.pdp1StateOrObservationRefs.filter((ref) => ref.includes("ownerTypedObservationContracts"));
    for (const ref of observationRefs) {
      const observation = exactObservationRef(ref);
      assert.ok(observation, `${edge.id} observation selector resolves against PDP-1 operations`);
      const citedPurposeRecords = edge.purposeBindingRefs.map((purposeRef) => purposeById.get(purposeRef.split("@id=")[1]?.split(/[&#]/)[0]));
      assert.ok(citedPurposeRecords.some((record) => {
        const directlyCites = ["authorityRefs", "sourceRefs", "operationRefs", "observationContractRefs"].some((field) => (record?.[field] ?? []).includes(ref));
        const journeyOperationRefs = [...(record?.operationRefs ?? []), ...(record?.actionExactOperationRefs ?? [])];
        const chainJoins = observation.operationRefs.some((operationRef) => journeyOperationRefs.includes(operationRef) && edge.pdp1OperationRefs.includes(operationRef));
        const relatedActionJoin = (record?.relatedActionBindings ?? []).some((binding) =>
          binding.observationContractRef === ref
            && observation.operationRefs.includes(binding.operationRef)
            && edge.pdp1OperationRefs.includes(binding.operationRef)
            && (binding.sourceRefs ?? []).includes(ref));
        return (directlyCites && chainJoins) || relatedActionJoin;
      }), `${edge.id} observation has an exact observation → operation → purpose-binding join`);
    }
    const exactStateOrObservationRefs = [...new Set([...stateRefs, ...observationRefs])];
    assert.deepEqual(edge.pdp1StateOrObservationRefs, exactStateOrObservationRefs);
    assert.equal(edge.pdp2GrammarRef, edge.p2GrammarRef);

    if (edge.channelRef === "media.channel.cli") {
      assert.ok(edge.p3InterfaceSourceRefs.includes(productionCliPath));
      assert.ok(edge.p3InterfaceSourceRefs.includes(fixtureCliPath));
      assert.equal(edge.runtimeAdmission, "NOT_ADMITTED", "fixture simulator cannot be treated as production execution");
    }
  }
}

const sources = {
  packet: JSON.parse(read(packetPath)),
  operations: readYaml(operationPath),
  states: readYaml(statePath),
  api: readYaml(apiPath),
  sdk: readYaml(sdkPath),
  productionCli: readYaml(productionCliPath),
  fixtureCli: readYaml(fixtureCliPath),
  journeyPurpose: readYaml(journeyPurposePath),
  scenarioFixtures: readYaml(scenarioFixturePath),
};

test("MDC30-C channel binding registry covers the owner-approved 61-edge set without promoting proposals", () => {
  const registry = readYaml(registryPath);
  assertValid(registry, sources);
  assert.equal(registry.status, "SOURCE_BOUND_LOGICAL_DEFINITIONS_PARTIAL; CHANNEL_TRANSPORT_EQUIVALENCE_UNBOUND; RUNTIME_NOT_ADMITTED");
  assert.equal(registry.counts.sourceBoundDefinitionOnlyOperationMappings, 6);
  assert.equal(registry.counts.sourceBoundHttpOperationMappings, 6);
  assert.equal(registry.counts.logicalDefinitionOnlyEdges, 43);
  assert.equal(registry.counts.incompleteP1StateOrObservationEdges, 18);
  assert.equal(registry.edges.filter((edge) => edge.logicalDefinitionDisposition === "SOURCE_BOUND_DEFINITION_ONLY").length, 43);
  assert.equal(registry.edges.filter((edge) => edge.logicalDefinitionDisposition === "INCOMPLETE_P1_STATE_OR_OBSERVATION_BINDING").length, 18);
  assert.equal(registry.counts.transportEquivalenceUnboundEdges, 61);
  assert.equal(registry.adversarialFixtureCases.length, 14);
  assert.deepEqual(registry.adversarialFixtureCases.slice(-7).map((fixture) => fixture.id), [
    "MDC30-CHANNEL-NEG-008-NONEXISTENT-STATE-SELECTOR",
    "MDC30-CHANNEL-NEG-009-EMPTY-NESTED-SEMANTICS",
    "MDC30-CHANNEL-NEG-010-MALFORMED-OBSERVATION-OPERATION-JOIN",
    "MDC30-CHANNEL-NEG-011-EMPTY-NO-P1-STATE-PROOF",
    "MDC30-CHANNEL-NEG-012-COMMAND-MISCLASSIFIED-NO-STATE",
    "MDC30-CHANNEL-NEG-013-PARTIAL-OPERATION-PROOF-COVERAGE",
    "MDC30-CHANNEL-NEG-014-FORGED-LOCAL-SESSION-NO-TRANSITION",
  ]);
});

test("current source gaps remain explicit after operation-result proofs are joined", () => {
  const registry = readYaml(registryPath);
  const incompleteEdges = registry.edges
    .filter((edge) => edge.logicalDefinitionDisposition === "INCOMPLETE_P1_STATE_OR_OBSERVATION_BINDING")
    .map((edge) => edge.id)
    .sort();
  assert.deepEqual(incompleteEdges, [
    "media.pdp3.channel-binding.j05.grpc-api.v1",
    "media.pdp3.channel-binding.j05.sdk.v1",
    "media.pdp3.channel-binding.j05.web.v1",
    "media.pdp3.channel-binding.j08.web.v1",
    "media.pdp3.channel-binding.j10.web.v1",
    "media.pdp3.channel-binding.j13.web.v1",
    "media.pdp3.channel-binding.j14.product-integration.v1",
    "media.pdp3.channel-binding.j14.web.v1",
    "media.pdp3.channel-binding.j19.web.v1",
    "media.pdp3.channel-binding.j20.cli.v1",
    "media.pdp3.channel-binding.j20.web.v1",
    "media.pdp3.channel-binding.j21.product-integration.v1",
    "media.pdp3.channel-binding.j21.web.v1",
    "media.pdp3.channel-binding.j26.http-api.v1",
    "media.pdp3.channel-binding.j26.product-integration.v1",
    "media.pdp3.channel-binding.j26.web.v1",
    "media.pdp3.channel-binding.j28.product-integration.v1",
    "media.pdp3.channel-binding.j28.web.v1",
  ]);
  const blockerFor = (edgeId) => registry.edges.find((edge) => edge.id === edgeId).logicalDefinitionBlockers.join(" ");
  for (const id of ["media.pdp3.channel-binding.j09.web.v1", "media.pdp3.channel-binding.j09.product-integration.v1"]) {
    const edge = registry.edges.find((item) => item.id === id);
    assert.equal(edge.logicalDefinitionDisposition, "SOURCE_BOUND_DEFINITION_ONLY");
    assert.equal(edge.channelTransportEquivalence, "UNBOUND");
    assert.equal(edge.runtimeAdmission, "NOT_ADMITTED");
    assert.deepEqual(edge.logicalDefinitionBlockers, []);
    const proof = edge.p1OperationStateProofs.find((item) => item.operationRef === "media.operation.action.deliver-exact-version");
    assert.deepEqual(proof.typedObservationBindingRefs, [".product-experience/pdp-3-product-experience/journey-contracts/create-review-and-deliver-from-a-brief.yaml#/pdp1ResultEvidence/typedObservationBindings/0"]);
    assert.ok(edge.p1ObservationRefs.includes(".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.destination-delivery-acknowledgment.v1"));
  }
  for (const id of ["media.pdp3.channel-binding.j05.web.v1", "media.pdp3.channel-binding.j05.grpc-api.v1", "media.pdp3.channel-binding.j05.sdk.v1"]) {
    const edge = registry.edges.find((item) => item.id === id);
    assert.equal(edge.logicalDefinitionDisposition, "INCOMPLETE_P1_STATE_OR_OBSERVATION_BINDING", `${id} retains terminal-output blocker`);
    assert.match(edge.logicalDefinitionBlockers.join(" "), /frame\/region selectors, model\/provider identity, and confidence evidence unresolved/u);
  }
  assert.match(blockerFor("media.pdp3.channel-binding.j05.web.v1"), /frame\/region selectors, model\/provider identity, and confidence evidence unresolved/u);
  const j08 = readYaml(".product-experience/pdp-3-product-experience/journey-contracts/repair-video-with-measured-quality.yaml");
  const j08CapabilityStep = j08.steps[1].stepDefinitionSemantics.stepSourceFacts.terminalResultObservation;
  const j08QualityObservation = j08.steps[3].stepDefinitionSemantics.stepSourceFacts.typedQualityEvidenceObservation;
  assert.deepEqual(j08CapabilityStep.successfulOutput.requiredIdentity, ["artifactId", "versionId"]);
  assert.equal(j08.pdp1ResultEvidence.typedObservationBindings.length, 1, "J-08 binds its source-defined typed quality observation to the selected output and review purpose");
  const j08TypedObservation = j08.pdp1ResultEvidence.typedObservationBindings[0];
  assert.equal(j08TypedObservation.operationRef, "media.operation.action.inspect-quality-evidence");
  assert.deepEqual(j08TypedObservation.requiredExactIdentity, ["queryId", "requestFingerprint", "subjectArtifactVersionRef", "metricRefs"]);
  assert.match(j08TypedObservation.subjectBinding, /exact selected output version under review/u);
  assert.match(j08TypedObservation.subjectBinding, /metricRefs must be nonempty and unique/u);
  assert.match(j08QualityObservation.subjectBinding, /selected successful capability output identity/u);
  assert.match(j08QualityObservation.metricSelection, /nonempty unique metricRefs/u);
  assert.match(j08QualityObservation.comparisonBoundary, /original-versus-candidate version pair or evaluation algorithm context/u);
  assert.match(blockerFor("media.pdp3.channel-binding.j08.web.v1"), /original-versus-candidate version pair, evaluation algorithm context, and matched same-subject metric result remain unjoined/u);
  assert.match(blockerFor("media.pdp3.channel-binding.j10.web.v1"), /per-condition state, copy, action, expected-result, and finality bindings/u);
  assert.match(blockerFor("media.pdp3.channel-binding.j28.web.v1"), /post-render consumer receipt or conversion-report result/u);
  for (const id of [
    "media.pdp3.channel-binding.j23.cli.v1",
    "media.pdp3.channel-binding.j23.web.v1",
    "media.pdp3.channel-binding.j24.cli.v1",
    "media.pdp3.channel-binding.j24.http-api.v1",
  ]) {
    const edge = registry.edges.find((item) => item.id === id);
    assert.equal(edge.logicalDefinitionDisposition, "SOURCE_BOUND_DEFINITION_ONLY", `${id} has complete P1 result proof coverage`);
    assert.equal(edge.channelTransportEquivalence, "UNBOUND", `${id} does not claim transport equivalence`);
    assert.equal(edge.runtimeAdmission, "NOT_ADMITTED", `${id} does not admit runtime`);
    assert.equal(edge.p1OperationStateProofs.length, edge.p1OperationBindings.length, `${id} proves each exact P1 operation`);
    assert.deepEqual(
      edge.unresolvedOperationRefs,
      edge.p1OperationBindings.filter((binding) => binding.disposition === "UNBOUND").map((binding) => binding.operationRef),
      `${id} keeps channel-unbound operations visible even when logical definitions are source-bound`,
    );
  }
  for (const id of ["media.pdp3.channel-binding.j20.cli.v1", "media.pdp3.channel-binding.j20.web.v1"]) {
    const edge = registry.edges.find((item) => item.id === id);
    assert.equal(edge.logicalDefinitionDisposition, "INCOMPLETE_P1_STATE_OR_OBSERVATION_BINDING");
    assert.deepEqual(
      edge.unresolvedOperationRefs,
      edge.p1OperationBindings.filter((binding) => binding.disposition === "UNBOUND").map((binding) => binding.operationRef),
      `${id} retains all operations without channel mappings`,
    );
    assert.match(edge.logicalDefinitionBlockers.join(" "), /no exact cancellation or retry transition ID\/finality is defined or joined/u);
    assert.match(edge.logicalDefinitionBlockers.join(" "), /Retry remains conditional on current owner eligibility; UNKNOWN does not authorize replay/u);
    assert.equal(edge.p1OperationStateProofs.length, 4);
    assert.deepEqual(edge.p1OperationStateProofs.map((proof) => proof.operationRef).sort(), [
      "media.operation-slice.cancel-job", "media.operation-slice.retry-job",
      "media.operation.action.check-job-outcome", "media.operation.action.view-job-status",
    ].sort());
    assert.equal(edge.channelTransportEquivalence, "UNBOUND");
    assert.equal(edge.runtimeAdmission, "NOT_ADMITTED");
  }
  const j20 = readYaml(".product-experience/pdp-3-product-experience/journey-contracts/long-running-job-observation-and-recovery.yaml");
  const j20ExpectedAuthorityRefs = [
    ".product-experience/pdp-1-domain-data/authority.yaml#ownerDefinedPdp10AuthorityScopes.identityScope",
    ".product-experience/pdp-1-domain-data/privacy.yaml#ownerDefinedPdp10Boundary.effectBoundary",
    ".product-experience/pdp-1-domain-data/privacy.yaml#ownerDefinedPdp10Boundary.duplicateEffectPrevention",
  ];
  for (const operationRef of ["media.operation-slice.cancel-job", "media.operation-slice.retry-job"]) {
    const semantics = j20.steps.find((item) => item.stepDefinitionSemantics?.transitionApplicability?.operationRef === operationRef)?.stepDefinitionSemantics;
    assert.ok(semantics, `${operationRef} has a journey step`);
    assert.deepEqual(semantics.canonicalBindingDisposition.authorityRefs, j20ExpectedAuthorityRefs);
    assert.deepEqual(semantics.operationContractBinding.operations[0].authorityRefs, j20ExpectedAuthorityRefs);
    assert.equal(new Set(semantics.operationContractBinding.operations[0].authorityRefs).size, j20ExpectedAuthorityRefs.length,
      `${operationRef} records each distinct authority reference once`);
    assert.equal(semantics.transitionApplicability.transitionRef, null, `${operationRef} does not invent a transition ID`);
    assert.equal(semantics.operationContractBinding.operations[0].transitionRefs.length, 0, `${operationRef} does not invent a transition ID`);
  }
  for (const id of ["media.pdp3.channel-binding.j26.http-api.v1", "media.pdp3.channel-binding.j26.product-integration.v1", "media.pdp3.channel-binding.j26.web.v1"]) {
    const edge = registry.edges.find((item) => item.id === id);
    assert.equal(edge.logicalDefinitionDisposition, "INCOMPLETE_P1_STATE_OR_OBSERVATION_BINDING");
    assert.equal(edge.channelTransportEquivalence, "UNBOUND");
    assert.equal(edge.runtimeAdmission, "NOT_ADMITTED");
    assert.equal(edge.p1OperationStateProofs.length, 4);
    const revokeProof = edge.p1OperationStateProofs.find((proof) => proof.operationRef === "media.operation.action.revoke-authorized-consent");
    assert.deepEqual(revokeProof.purposeBindingRefs, [".product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml#records/@id=media.pdp3.step-purpose-binding.j26-step-01.v1"]);
    assert.deepEqual(revokeProof.relatedActionBindingRefs, [".product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml#records/@id=media.pdp3.step-purpose-binding.j26-step-01.v1/relatedActionBindings/@id=media.pdp3.action-binding.j26-consent-revocation-request.v1"]);
    assert.match(edge.logicalDefinitionBlockers.join(" "), /artifact-delete still lacks a J-26 action-purpose join/u);
    assert.match(edge.logicalDefinitionBlockers.join(" "), /no terminal lifecycle transition\/finality or all-copy erasure receipt/u);
    assert.ok(edge.unresolvedOperationRefs.includes("media.operation.action.revoke-authorized-consent"));
    if (id.endsWith("j26.http-api.v1")) assert.equal(edge.exactTransportMappingCount, 1, "the existing GET route is preserved as the only exact HTTP mapping");
  }
  const j21Edges = registry.edges.filter((edge) => edge.journeyRef === "J-21");
  assert.deepEqual(j21Edges.map((edge) => edge.id).sort(), [
    "media.pdp3.channel-binding.j21.product-integration.v1",
    "media.pdp3.channel-binding.j21.web.v1",
  ]);
  for (const edge of j21Edges) {
    assert.equal(edge.logicalDefinitionDisposition, "INCOMPLETE_P1_STATE_OR_OBSERVATION_BINDING");
    assert.equal(edge.channelTransportEquivalence, "UNBOUND");
    assert.match(edge.logicalDefinitionBlockers.join(" "), /approval mutation remains BLOCKED_EXCLUDED pending genuine rights-owner approval/u);
    assert.equal(edge.p1OperationStateProofs.length, edge.p1OperationBindings.length);
    const rightsQuery = edge.p1OperationStateProofs.find((proof) => proof.operationRef === "media.operation.action.review-rights-approval-and-format-effects");
    assert.deepEqual(rightsQuery.journeyResultBindingRefs, [".product-experience/pdp-3-product-experience/journey-contracts/review-exact-version-and-recheck-changes.yaml#/pdp1ResultEvidence/operationResultBindings/1"]);
    assert.deepEqual(rightsQuery.typedObservationBindingRefs, [".product-experience/pdp-3-product-experience/journey-contracts/review-exact-version-and-recheck-changes.yaml#/pdp1ResultEvidence/typedObservationBindings/0"]);
    assert.deepEqual(rightsQuery.relatedActionBindingRefs, [".product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml#records/@id=media.pdp3.step-purpose-binding.j21-step-01.v1/relatedActionBindings/@id=media.pdp3.action-binding.j21-read-rights-observation.v1"]);
    assert.ok(edge.unresolvedOperationRefs.includes("media.operation.action.review-rights-approval-and-format-effects"));
  }
});

test("J-02 complete-upload proof resolves nested P1 state bindings strictly", () => {
  const operation = structuredClone(operationRecords(sources.operations).find(
    (item) => item.id === "media.operation-slice.complete-upload",
  ));
  assert.deepEqual(operation.stateBinding.transitionRefs, ["media-upload-and-artifact/T01"]);
  for (const collection of ["operations", "individualOperationContracts", "ownerDefinedOperationContracts", "capabilityOperationContracts"]) {
    const container = collection === "operations" ? { operations: [operation] } : { [collection]: { records: [operation] } };
    assert.equal(operationRecords(container).find((item) => item.id === operation.id), operation,
      `operation resolver retains nested stateBinding from ${collection}`);
  }
  assert.equal(Object.hasOwn(operation.stateBinding, "stateRefs"), false);
  assert.equal(Object.hasOwn(operation, "stateRefs"), false);
  assert.equal(Object.hasOwn(operation, "transitionRefs"), false);
  const journeyContract = readYaml(".product-experience/pdp-3-product-experience/journey-contracts/upload-import-and-verify-artifact.yaml");
  const operationRef = operation.id;
  const purposeRef = ".product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml#records/@id=media.pdp3.step-purpose-binding.j02-step-03.v1";
  const resultRef = ".product-experience/pdp-3-product-experience/journey-contracts/upload-import-and-verify-artifact.yaml#/pdp1ResultEvidence/operationResultBindings/2";
  const purposeId = purposeRef.split("@id=")[1];
  const purpose = sources.journeyPurpose.records.find((item) => item.id === purposeId);
  assert.ok(purpose);
  assert.equal(journeyContract.pdp1ResultEvidence.operationResultBindings[2].operationRef, operationRef);
  const edge = {
    id: "media.pdp3.channel-binding.j02.web.v1", journeyRef: "J-02",
    journeyContractRef: ".product-experience/pdp-3-product-experience/journey-contracts/upload-import-and-verify-artifact.yaml",
    p1OperationBindings: [{ operationRef, sourceRef: `.product-experience/pdp-1-domain-data/operations.yaml#individualOperationContracts/records/@id=${operationRef}` }],
    purposeBindingRefs: [purposeRef], p1ObservationRefs: [], pdp1StateOrObservationRefs: [],
    p1OperationStateProofs: [{ operationRef, disposition: "EXACT_JOURNEY_TYPED_RESULT_SOURCE_REF",
      purposeBindingRefs: [purposeRef], journeyResultBindingRefs: [resultRef], stateRefs: [],
      transitionRefs: ["media-upload-and-artifact/T01"] }],
  };
  const run = (op = operation, proof = edge.p1OperationStateProofs[0]) => assertOperationStateProofs(
    { ...edge, p1OperationStateProofs: [proof] },
    { operationsById: new Map([[operationRef, op]]), purposeById: new Map([[purposeId, purpose]]),
      exactStateRefExists: () => false, exactObservationRef: () => undefined, journeyContract },
  );
  run();
  assert.throws(() => run(operation, { ...edge.p1OperationStateProofs[0], transitionRefs: undefined }), /transitionRefs must exactly match/);
  assert.throws(() => run(operation, { ...edge.p1OperationStateProofs[0], transitionRefs: [] }), /transitionRefs must exactly match/);
  assert.throws(() => run(operation, { ...edge.p1OperationStateProofs[0], transitionRefs: ["media-upload-and-artifact/T02"] }), /transitionRefs must exactly match/);
  assert.throws(() => run(operation, { ...edge.p1OperationStateProofs[0], stateRefs: undefined }), /stateRefs must exactly match/);
  assert.throws(() => run(operation, { ...edge.p1OperationStateProofs[0], stateRefs: [".product-experience/pdp-1-domain-data/states.yaml#stateMachines/media-upload-and-artifact/stateDefinitions/VERIFYING"] }), /stateRefs must exactly match/);
  const topLevelEmpty = structuredClone(operation);
  topLevelEmpty.transitionRefs = [];
  assert.throws(() => run(topLevelEmpty), /transitionRefs must exactly match/);
  const alteredNested = structuredClone(operation);
  alteredNested.stateBinding.transitionRefs = ["media-upload-and-artifact/T02"];
  assert.throws(() => run(alteredNested), /transitionRefs must exactly match/);
});

test("J-18 submit-render binds machine roots without asserting a current job state", () => {
  const operationRef = "media.operation.action.submit-render";
  const operation = operationRecords(sources.operations).find((item) => item.id === operationRef);
  const journeyFile = ".product-experience/pdp-3-product-experience/journey-contracts/compose-and-render-reviewed-media.yaml";
  const journeyContract = readYaml(journeyFile);
  const resultIndex = journeyContract.pdp1ResultEvidence.operationResultBindings.findIndex((item) => item.operationRef === operationRef);
  assert.equal(resultIndex, 1);
  const resultRef = `${journeyFile}#/pdp1ResultEvidence/operationResultBindings/${resultIndex}`;
  const resultBinding = journeyContract.pdp1ResultEvidence.operationResultBindings[resultIndex];
  assert.equal(Object.hasOwn(resultBinding, "stateRefs"), false,
    "durable job admission does not assert a current job state");
  assert.match(resultBinding.exactResult, /No current job state is returned or asserted/);
  const purposeRef = ".product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml#records/@id=media.pdp3.step-purpose-binding.j18-step-05.v1";
  const purpose = sources.journeyPurpose.records.find((item) => item.id === "media.pdp3.step-purpose-binding.j18-step-05.v1");
  const purposeById = new Map([[purpose.id, purpose]]);
  const sourceRefs = [
    ".product-experience/pdp-1-domain-data/states.yaml#media-job",
    ".product-experience/pdp-1-domain-data/states.yaml#media-attempt",
  ];
  assert.deepEqual(operation.stateRefs, sourceRefs);
  const sourceRef = `.product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=${operationRef}`;
  const edge = {
    id: "fixture.j18.submit-render", journeyRef: "J-18", journeyContractRef: journeyFile,
    p1OperationBindings: [{ operationRef, sourceRef }], purposeBindingRefs: [purposeRef],
    p1OperationStateProofs: [{ operationRef, disposition: "EXACT_JOURNEY_TYPED_RESULT_SOURCE_REF",
      purposeBindingRefs: [purposeRef], journeyResultBindingRefs: [resultRef], stateRefs: sourceRefs, transitionRefs: [] }],
  };
  const states = sources.states;
  const exactStateRefExists = (ref) => /^\.product-experience\/pdp-1-domain-data\/states\.yaml#stateMachines\/([^/]+)\/stateDefinitions\/([^/]+)$/.test(ref);
  const exactStateSourceRefExists = (ref) => {
    const machineRef = /^\.product-experience\/pdp-1-domain-data\/states\.yaml#([^/#]+)$/.exec(ref);
    if (machineRef) return states.stateMachines.some((machine) => machine.machineId === machineRef[1]);
    const stateFamilyRef = /^\.product-experience\/pdp-1-domain-data\/states\.yaml#stateMachines\/([^/#]+)\/stateDefinitions$/.exec(ref);
    if (!stateFamilyRef) return false;
    const machine = states.stateMachines.find((item) => item.machineId === stateFamilyRef[1]);
    return Boolean(machine?.stateDefinitions?.length);
  };
  const stateFamilyRef = ".product-experience/pdp-1-domain-data/states.yaml#stateMachines/media-upload-and-artifact/stateDefinitions";
  assert.ok(exactStateSourceRefExists(stateFamilyRef), "an exact stateDefinitions family reference resolves only for a declared machine");
  assert.equal(exactStateSourceRefExists(`${stateFamilyRef}/UNKNOWN`), false, "a family reference cannot admit an undeclared state suffix");
  const run = (proof) => assertOperationStateProofs({ ...edge, p1OperationStateProofs: [proof] }, {
    operationsById: new Map([[operationRef, operation]]), purposeById,
    exactStateRefExists, exactStateSourceRefExists, exactObservationRef: () => undefined, journeyContract,
  });
  run(edge.p1OperationStateProofs[0]);
  assert.throws(() => run({ ...edge.p1OperationStateProofs[0], stateRefs: [sourceRefs[0]] }), /stateRefs must exactly match/);
  assert.throws(() => run({ ...edge.p1OperationStateProofs[0], stateRefs: [sourceRefs[0], `${sourceRefs[1]}-invented`] }), /stateRefs must exactly match/);
  assert.throws(() => run({ ...edge.p1OperationStateProofs[0], stateRefs: undefined }), /stateRefs must exactly match/);
  assert.throws(() => run({ ...edge.p1OperationStateProofs[0], disposition: "EXACT_P1_STATE_SOURCE_REF", stateRef: sourceRefs[0], journeyResultBindingRefs: undefined }), /proof state reference must resolve/);
});

test("J-29 reconnect result preserves the exact receipt and one-output outcome rules", () => {
  const journey = readYaml(".product-experience/pdp-3-product-experience/journey-contracts/live-session-loss-consent-change-and-bounded-recovery.yaml");
  const binding = journey.pdp1ResultEvidence.operationResultBindings.find(
    (item) => item.operationRef === "media.operation.capability.media-stream-session-reconnect",
  );
  assert.ok(binding);
  assert.match(binding.exactResult, /SUCCEEDED requires the typed reconnectReceipt/);
  assert.match(binding.exactResult, /exactly one typed output/);
  assert.match(binding.exactResult, /REJECTED and UNKNOWN_OUTCOME carry neither receipt nor output/);
  assert.match(binding.unknownDisposition, /reconcile the same session and receipt identity/);
  assert.match(binding.exactResult, /does not establish that a frame was sent/);
  assert.match(binding.exactResult, /provider effect occurred/);
  assert.match(binding.exactResult, /runtime was qualified/);
  assert.match(binding.exactResult, /session was otherwise restored/);
});

test("MDC30-C-30 binds exact effective-constraint observations and the local no-dispatch step", () => {
  const registry = readYaml(registryPath);
  const observationRef = ".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.effective-processing-constraints.v1";
  const localProofSource = ".product-experience/pdp-3-product-experience/local-step-effect-contracts.yaml#records/@id=media.local-step-effect.j-30.step-04.v1";
  const observation = sources.operations.ownerTypedObservationContracts.records.find((record) => record.id === "media.observation-contract.effective-processing-constraints.v1");
  const expectedDimensions = ["qualification", "license", "health", "capability", "rights", "resourceCapacity", "costEstimate"];
  assert.deepEqual(observation.operationRefs, ["media.operation.action.inspect-effective-processing-constraints"]);
  assert.deepEqual(observation.requestSchema.properties.dimensionRefs.items.enum, expectedDimensions);
  assert.deepEqual(observation.resultSchema.properties.observation.properties.dimensions.items.properties.dimension.enum, expectedDimensions);
  assert.deepEqual(observation.resultSchema.properties.observation.properties.dimensions.items.properties.dimensionStatus.enum, ["SATISFIED", "NOT_SATISFIED", "UNKNOWN", "NOT_APPLICABLE"]);
  assert.ok(observation.bindingRules.some((rule) => rule.id === "media.observation-binding.effective-constraints.dimension-set" && rule.operator === "EXACT_SET_EQUAL"));
  assert.ok(observation.resultRules.some((rule) => /no aggregate eligible, ready, qualified, or executable result is defined/u.test(rule)));
  assert.ok(observation.resultRules.some((rule) => /Missing, stale, mismatched, untrusted, or unavailable dimension evidence is UNKNOWN/u.test(rule)));
  const edges = registry.edges.filter((edge) => edge.taskId === "MDC30-C-30");
  assert.equal(edges.length, 3);
  assertValid(registry, sources);
  for (const edge of edges) {
    assert.deepEqual(edge.pdp1StateOrObservationRefs, [observationRef]);
    assert.equal(edge.p1OperationStateProofs[0].observationRef, observationRef);
    assert.equal(edge.p1OperationStateProofs[0].operationRef, "media.operation.action.inspect-effective-processing-constraints");
    assert.deepEqual(edge.p1OperationStateProofs[0].purposeBindingRefs.map((ref) => ref.split("@id=")[1]), [
      "media.pdp3.step-purpose-binding.j30-step-01.v1",
      "media.pdp3.step-purpose-binding.j30-step-02.v1",
      "media.pdp3.step-purpose-binding.j30-step-03.v1",
    ]);
    assert.equal(edge.localStepNoP1MachineProofs[0].localEffectContractRef, localProofSource);
    assert.equal(edge.localStepNoP1MachineProofs[0].stepIndex, 3);
    assert.ok(edge.localStepNoP1MachineProofs[0].sourceRefs.includes(`${localProofSource}/inputContract/effectBoundary`));
    assert.equal(edge.transportRefOrUnbound, "UNBOUND");
    assert.equal(edge.runtimeAdmission, "NOT_ADMITTED");
  }

  const wrongObservation = structuredClone(registry);
  const wrongEdge = wrongObservation.edges.find((edge) => edge.taskId === "MDC30-C-30");
  wrongEdge.p1OperationStateProofs[0].observationRef = ".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.processing-parameter-read.v1";
  assert.throws(() => assertValid(wrongObservation, sources), /typed observation must bind the exact operation/);

  const wrongPurpose = structuredClone(registry);
  const wrongPurposeEdge = wrongPurpose.edges.find((edge) => edge.taskId === "MDC30-C-30");
  wrongPurposeEdge.p1OperationStateProofs[0].purposeBindingRefs = [".product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml#records/@id=media.pdp3.step-purpose-binding.j30-step-04.v1"];
  assert.throws(() => assertValid(wrongPurpose, sources), /wrong purpose-to-operation join/);

  const missingLocalProof = structuredClone(registry);
  const localEdge = missingLocalProof.edges.find((edge) => edge.taskId === "MDC30-C-30");
  localEdge.localStepNoP1MachineProofs = [];
  assert.throws(() => assertValid(missingLocalProof, sources), /requires one exact local-step no-P1-state proof/);

  const alteredLocalSource = structuredClone(registry);
  const alteredEdge = alteredLocalSource.edges.find((edge) => edge.taskId === "MDC30-C-30");
  alteredEdge.localStepNoP1MachineProofs[0].localEffectContractRef = localProofSource.replace("step-04", "step-03");
  assert.throws(() => assertValid(alteredLocalSource, sources), /local-step proof must preserve the exact source-defined local-only effect/);
});

test("MDC30-C adversarial fixtures reject missing and duplicate edges", () => {
  const missing = structuredClone(readYaml(registryPath));
  missing.edges.pop();
  assert.throws(() => assertValid(missing, sources), /all 61 owner-approved edges are present/);

  const duplicate = structuredClone(readYaml(registryPath));
  duplicate.edges.push(structuredClone(duplicate.edges[0]));
  assert.throws(() => assertValid(duplicate, sources), /journey×channel edge pairs are unique/);
});

test("MDC30-C adversarial fixture rejects an invented HTTP route", () => {
  const candidate = structuredClone(readYaml(registryPath));
  const edge = candidate.edges.find((item) => item.channelRef === "media.channel.http-api" && item.exactTransportMappingCount > 0);
  const binding = edge.p1OperationBindings.find((item) => item.disposition === "SOURCE_BOUND_DEFINITION_ONLY");
  binding.transportIdentity.path = "/api/v1/invented-route";
  assert.throws(() => assertValid(candidate, sources), /HTTP method\/path\/version match the source registry/);
});

test("MDC30-C adversarial fixture rejects mismatched operation versions", () => {
  const candidate = structuredClone(readYaml(registryPath));
  const edge = candidate.edges.find((item) => item.p1OperationBindings.some((binding) => binding.disposition === "SOURCE_BOUND_DEFINITION_ONLY"));
  const binding = edge.p1OperationBindings.find((item) => item.disposition === "SOURCE_BOUND_DEFINITION_ONLY");
  binding.operationVersion += 1;
  assert.throws(() => assertValid(candidate, sources), /preserves the P1 operation version/);
});

test("MDC30-C adversarial fixture rejects a nonexistent PDP-1 state selector", () => {
  const candidate = structuredClone(readYaml(registryPath));
  const edge = candidate.edges.find((item) => item.p1StateRefs.some((state) => state.disposition === "EXACT_P1_STATE_SOURCE_REF"));
  const state = edge.p1StateRefs.find((item) => item.disposition === "EXACT_P1_STATE_SOURCE_REF");
  state.stateRef = state.stateRef.replace(/stateDefinitions\/[^/]+$/, "stateDefinitions/INVENTED_STATE");
  assert.throws(() => assertValid(candidate, sources), /exact state selector resolves against PDP-1 states/);
});

test("MDC30-C adversarial fixtures reject semantically empty nested definitions", () => {
  const cases = [
    ["typed request/result/errors", (edge) => { edge.typedRequestResultErrors.sourceRefs = []; }, /typed request\/result\/error definitions are nonempty/],
    ["authority", (edge) => { edge.authorityAndVersion.authoritySourceRefs = []; }, /authority definition is nonempty/],
    ["version", (edge) => { edge.authorityAndVersion.versionSourceRefs = []; }, /version definition is nonempty/],
    ["denied/unknown recovery", (edge) => { edge.deniedUnknownRecovery.sourceRefs = []; }, /denial and recovery definitions are nonempty/],
    ["finality", (edge) => { edge.finality.sourceRefs = []; }, /finality definitions are nonempty/],
  ];
  for (const [label, mutate, message] of cases) {
    const candidate = structuredClone(readYaml(registryPath));
    mutate(candidate.edges[0]);
    assert.throws(() => assertValid(candidate, sources), message, `${label} cannot be empty`);
  }
});

test("MDC30-C adversarial fixture rejects an observation without a purpose-to-operation join", () => {
  const candidate = structuredClone(readYaml(registryPath));
  const edge = candidate.edges.find((item) => item.journeyId === "J-05");
  const observationRef = ".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.rights-decision.v1";
  edge.pdp1StateOrObservationRefs.push(observationRef);
  assert.throws(() => assertValid(candidate, sources), /observation → operation → purpose-binding join/);
});

test("MDC30-C adversarial fixture rejects missing authentication and authority refs", () => {
  const candidate = structuredClone(readYaml(registryPath));
  candidate.edges[0].authSourceRefs = [];
  assert.throws(() => assertValid(candidate, sources), /carries authSourceRefs/);
});

test("MDC30-C adversarial fixture rejects UNKNOWN_OUTCOME conflation", () => {
  const candidate = structuredClone(readYaml(registryPath));
  candidate.edges[0].unknownOutcomeDisposition = "UNKNOWN_OUTCOME_IS_FAILURE";
  assert.throws(() => assertValid(candidate, sources), /PRESERVE_UNKNOWN/);
});

test("MDC30-C adversarial fixture rejects CLI simulator-as-production bindings", () => {
  const candidate = structuredClone(readYaml(registryPath));
  const edge = candidate.edges.find((item) => item.channelRef === "media.channel.cli");
  const binding = edge.p1OperationBindings[0];
  binding.disposition = "SOURCE_BOUND_DEFINITION_ONLY";
  binding.transportRef = "media.fixture-cli.upload-inspect";
  binding.transportIdentity = { commandId: binding.transportRef, canonicalCommand: "ghatana-media upload inspect", operationVersion: 1 };
  assert.throws(() => assertValid(candidate, sources), /CLI identity comes from the production command registry/);
});

function operationProofFixture() {
  const operationRef = "media.operation.action.view-job-status";
  const purposeRef = ".product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml#records/@id=media.pdp3.step-purpose-binding.j02-step-04.v1";
  const sourceRef = ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.action.view-job-status";
  const profileSourceRef = `.product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationProfiles/profiles/@id=${"media.operation-profile.scoped-query.v1"}`;
  const operation = operationRecords(sources.operations).find((record) => record.id === operationRef);
  const proof = {
    operationRef,
    disposition: "NO_P1_MACHINE_STATE",
    purposeBindingRefs: [purposeRef],
    noP1MachineState: {
      sourceRefs: [
        sourceRef,
        `${sourceRef}/sourceEffect`,
        `${sourceRef}/resultSchema`,
        `${profileSourceRef}/requestEnvelope`,
        `${profileSourceRef}/resultEnvelope`,
        `${profileSourceRef}/errors`,
        `${profileSourceRef}/recovery`,
        `${profileSourceRef}/finality`,
      ],
      noEffectRef: `${sourceRef}/sourceEffect`,
      resultRef: operation.resultSchemaRef,
      authorityRefs: [...operation.authorityRefs],
      versionRefs: [`${sourceRef}/contractVersion`],
      operationVersion: operation.contractVersion,
      deniedUnknownRecoveryRefs: [
        ".product-experience/pdp-1-domain-data/action-contracts.yaml#outcomes/@id=UNKNOWN_OUTCOME",
        operation.errorSchemaRef,
        `${profileSourceRef}/recovery`,
      ],
      finalityRefs: [operation.resultSchemaRef, `${profileSourceRef}/finality`, `${sourceRef}/sourceFinality`],
    },
  };
  const edge = { id: "fixture.read-only-query", p1OperationBindings: [{ operationRef, sourceRef }], purposeBindingRefs: [purposeRef], p1OperationStateProofs: [proof] };
  const operationsById = new Map(operationRecords(sources.operations).map((record) => [record.id, record]));
  const purposeById = new Map(sources.journeyPurpose.records.map((record) => [record.id, record]));
  const exactStateRefExists = (ref) => /^\.product-experience\/pdp-1-domain-data\/states\.yaml#stateMachines\/[^/]+\/stateDefinitions\/[^/]+$/.test(ref);
  const exactObservationRef = (ref) => (sources.operations.ownerTypedObservationContracts?.records ?? []).find((record) => ref.endsWith(`@id=${record.id}`));
  return { edge, proof, operation, operationsById, purposeById, exactStateRefExists, exactObservationRef };
}

function canonicalQueryProofFixture() {
  const operationRef = "media.operation.fixture.canonical-inspect";
  const sourceRef = `.product-experience/pdp-1-domain-data/operations.yaml#operations/@id=${operationRef}`;
  const purposeRef = ".product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml#records/@id=media.pdp3.step-purpose-binding.fixture-canonical-query.v1";
  const errorRef = ".product-experience/pdp-1-domain-data/action-contracts.yaml#outcomes/@id=DENIED";
  const operation = {
    id: operationRef,
    operationKind: "QUERY",
    stateRefs: [],
    resultSchemaRef: `${sourceRef}/resultSchema`,
    resultSchema: { type: "object", required: ["operationRef", "outputs"], properties: { operationRef: { const: operationRef }, outputs: { type: "array" } } },
    sourceEffect: "read-only inspect current canonical operation evidence; no mutation",
    contractVersion: 2,
    authorityRefs: [".product-experience/pdp-1-domain-data/authority.yaml#ownership.identityAuthenticationAndDelegation"],
    errorSchemaRef: errorRef,
    recovery: "reconcile current evidence before another read",
    sourceFinality: "the result is a current read observation only",
  };
  const purpose = { id: purposeRef.split("@id=")[1], operationRefs: [operationRef], actionExactOperationRefs: [] };
  const refs = {
    result: `${sourceRef}/resultSchema`,
    effect: `${sourceRef}/sourceEffect`,
    version: `${sourceRef}/contractVersion`,
    finality: `${sourceRef}/sourceFinality`,
    error: `${sourceRef}/errorSchemaRef`,
    recovery: `${sourceRef}/recovery`,
    authority: `${sourceRef}/authorityRefs`,
  };
  const proof = {
    operationRef,
    disposition: "NO_P1_MACHINE_STATE",
    purposeBindingRefs: [purposeRef],
    noP1MachineState: {
      sourceRefs: [sourceRef, ...Object.values(refs)],
      noEffectRef: refs.effect,
      resultRef: refs.result,
      authorityRefs: [...operation.authorityRefs],
      versionRefs: [refs.version],
      operationVersion: operation.contractVersion,
      deniedUnknownRecoveryRefs: [errorRef, refs.recovery, ".product-experience/pdp-1-domain-data/action-contracts.yaml#outcomes/@id=UNKNOWN_OUTCOME"],
      finalityRefs: [refs.result, refs.finality],
    },
  };
  const edge = {
    id: "fixture.canonical-read-query",
    p1OperationBindings: [{ operationRef, sourceRef }],
    purposeBindingRefs: [purposeRef],
    p1OperationStateProofs: [proof],
  };
  return {
    edge,
    operationsById: new Map([[operationRef, operation]]),
    purposeById: new Map([[purpose.id, purpose]]),
    exactStateRefExists: () => false,
    exactObservationRef: () => undefined,
  };
}

function noTransitionCommandFixture(sourcePath = "ownerDefinedOperationContracts/records") {
  const operationRef = "media.operation.fixture.submit-request";
  const sourceRef = `.product-experience/pdp-1-domain-data/operations.yaml#${sourcePath}/@id=${operationRef}`;
  const purposeRef = ".product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml#records/@id=media.pdp3.step-purpose-binding.fixture-submit.v1";
  const operation = {
    id: operationRef,
    operationKind: "COMMAND",
    stateRefs: [],
    transitionRefs: [],
    sourceEffect: "submit one request and return its typed receipt",
    resultSchema: { type: "object", required: ["outcome", "requestId"], properties: { outcome: { type: "string" }, requestId: { type: "string" } } },
    contractVersion: 3,
    authorityRefs: [".product-experience/pdp-1-domain-data/authority.yaml#ownership.identityAuthenticationAndDelegation"],
    errorSchemaRef: ".product-experience/pdp-1-domain-data/action-contracts.yaml#outcomes/@id=DENIED",
    recovery: "reconcile the same request identity before retrying",
    finality: "the typed receipt confirms request acceptance only",
  };
  const purpose = {
    id: purposeRef.split("@id=")[1],
    operationRefs: [operationRef],
    operationKinds: ["COMMAND"],
    stateRefs: [],
    transitionRefs: [],
    sourceRefs: [sourceRef],
    transitionDisposition: { status: "NO_P1_MACHINE_TRANSITION", transitionRef: null, reason: "The request result does not assert a machine transition." },
  };
  const refs = {
    result: `${sourceRef}/resultSchema`,
    version: `${sourceRef}/contractVersion`,
    finality: `${sourceRef}/finality`,
    recovery: `${sourceRef}/recovery`,
    errors: `${sourceRef}/errorSchemaRef`,
    authority: `${sourceRef}/authorityRefs`,
  };
  const proof = {
    operationRef,
    disposition: "NO_P1_MACHINE_TRANSITION_TYPED_RESULT",
    purposeBindingRefs: [purposeRef],
    noP1MachineTransition: {
      sourceRefs: [sourceRef, ...Object.values(refs), `${purposeRef}/transitionDisposition`, `${purposeRef}/stateRefs`, `${purposeRef}/transitionRefs`],
      operationResultRef: refs.result,
      operationVersion: operation.contractVersion,
      authorityRefs: [...operation.authorityRefs],
      versionRefs: [refs.version],
      deniedUnknownRecoveryRefs: [operation.errorSchemaRef, refs.recovery, ".product-experience/pdp-1-domain-data/action-contracts.yaml#outcomes/@id=UNKNOWN_OUTCOME"],
      finalityRefs: [refs.result, refs.finality],
    },
  };
  const edge = {
    id: "fixture.no-transition-command",
    p1OperationBindings: [{ operationRef, sourceRef }],
    purposeBindingRefs: [purposeRef],
    p1OperationStateProofs: [proof],
  };
  return {
    edge,
    operationsById: new Map([[operationRef, operation]]),
    purposeById: new Map([[purpose.id, purpose]]),
    exactStateRefExists: () => false,
    exactObservationRef: () => undefined,
  };
}

test("MDC30-C accepts an explicit per-operation NO_P1_MACHINE_STATE proof for a source-defined read-only query", () => {
  const fixture = operationProofFixture();
  assertOperationStateProofs(fixture.edge, fixture);
});

test("MDC30-C accepts exact NO_P1_MACHINE_STATE results from canonical PDP-1 QUERY records", () => {
  const fixture = canonicalQueryProofFixture();
  assertOperationStateProofs(fixture.edge, fixture);
});

test("MDC30-C rejects canonical PDP-1 COMMAND records mislabeled NO_P1_MACHINE_STATE", () => {
  const fixture = canonicalQueryProofFixture();
  fixture.operationsById.get("media.operation.fixture.canonical-inspect").operationKind = "COMMAND";
  assert.throws(() => assertOperationStateProofs(fixture.edge, fixture), /cannot label a command\/write or stateful operation/);
});

test("MDC30-C rejects canonical QUERY proofs with mismatched exact result or source joins", () => {
  const resultMismatch = canonicalQueryProofFixture();
  resultMismatch.edge.p1OperationStateProofs[0].noP1MachineState.resultRef = "invented-result";
  assert.throws(() => assertOperationStateProofs(resultMismatch.edge, resultMismatch), /exact effect, result, authority, and version/);

  const sourceOmission = canonicalQueryProofFixture();
  sourceOmission.edge.p1OperationStateProofs[0].noP1MachineState.sourceRefs.pop();
  assert.throws(() => assertOperationStateProofs(sourceOmission.edge, sourceOmission), /exact operation source fields/);

  const emptyResult = canonicalQueryProofFixture();
  emptyResult.operationsById.get("media.operation.fixture.canonical-inspect").resultSchema.required = [];
  assert.throws(() => assertOperationStateProofs(emptyResult.edge, emptyResult), /exact typed result schema/);
});

test("MDC30-C keeps canonical QUERY no-state proofs exclusive and rejects declared transitions", () => {
  const dualProof = canonicalQueryProofFixture();
  dualProof.edge.p1OperationStateProofs[0].noP1MachineTransition = {};
  assert.throws(() => assertOperationStateProofs(dualProof.edge, dualProof), /explicit and exclusive/);

  const statefulQuery = canonicalQueryProofFixture();
  statefulQuery.operationsById.get("media.operation.fixture.canonical-inspect").transitionRefs = ["transition-1"];
  assert.throws(() => assertOperationStateProofs(statefulQuery.edge, statefulQuery), /stateful operation/);
});

test("MDC30-C rejects empty state selectors without an explicit per-operation proof", () => {
  const fixture = operationProofFixture();
  fixture.edge.p1OperationStateProofs = [];
  assert.throws(() => assertOperationStateProofs(fixture.edge, fixture), /exactly one state\/observation proof/);
});

test("MDC30-C rejects incomplete, duplicate, wrong-purpose, and unsupported operation proofs", () => {
  for (const [mutate, pattern] of [
    [(edge) => { edge.p1OperationStateProofs.pop(); }, /exactly one state\/observation proof/],
    [(edge) => { edge.p1OperationStateProofs.push(structuredClone(edge.p1OperationStateProofs[0])); }, /missing or duplicate/],
    [(edge) => { edge.p1OperationStateProofs[0].purposeBindingRefs = []; }, /empty or non-edge purpose join/],
    [(edge) => { edge.p1OperationStateProofs[0].disposition = "UNBOUND"; }, /unsupported operation proof kind/],
  ]) {
    const fixture = operationProofFixture();
    mutate(fixture.edge);
    assert.throws(() => assertOperationStateProofs(fixture.edge, fixture), pattern);
  }
  const wrongJoin = operationProofFixture();
  const unrelatedPurposeRef = ".product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml#records/@id=media.pdp3.step-purpose-binding.j02-step-01.v1";
  wrongJoin.edge.purposeBindingRefs = [unrelatedPurposeRef];
  wrongJoin.edge.p1OperationStateProofs[0].purposeBindingRefs = [unrelatedPurposeRef];
  assert.throws(() => assertOperationStateProofs(wrongJoin.edge, wrongJoin), /wrong purpose-to-operation join/);
});

test("MDC30-C rejects NO_P1_MACHINE_STATE for command/write operations and incomplete proof semantics", () => {
  const command = operationProofFixture();
  const commandOperation = operationRecords(sources.operations).find((record) => record.id === "media.operation.action.submit-render");
  command.edge.p1OperationBindings[0] = { operationRef: commandOperation.id, sourceRef: ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.action.submit-render" };
  command.edge.p1OperationStateProofs[0].operationRef = commandOperation.id;
  const commandPurposeId = "media.pdp3.step-purpose-binding.j02-step-04.v1";
  command.purposeById.set(commandPurposeId, { id: commandPurposeId, operationRefs: [commandOperation.id] });
  command.edge.p1OperationStateProofs[0].noP1MachineState.sourceRefs = [command.edge.p1OperationBindings[0].sourceRef];
  command.edge.p1OperationStateProofs[0].noP1MachineState.resultRef = commandOperation.resultSchemaRef;
  assert.throws(() => assertOperationStateProofs(command.edge, { ...command, operationsById: new Map(operationRecords(sources.operations).map((record) => [record.id, record])) }), /cannot label a command\/write or stateful operation/);

  const emptyProof = operationProofFixture();
  emptyProof.edge.p1OperationStateProofs[0].noP1MachineState.sourceRefs = [];
  assert.throws(() => assertOperationStateProofs(emptyProof.edge, emptyProof), /requires nonempty sourceRefs/);
  const noResult = operationProofFixture();
  noResult.edge.p1OperationStateProofs[0].noP1MachineState.resultRef = "invented-result";
  assert.throws(() => assertOperationStateProofs(noResult.edge, noResult), /typed result/);
});

test("MDC30-C accepts strict no-transition typed results for source-defined COMMAND records", () => {
  for (const sourcePath of ["operations", "ownerDefinedOperationContracts/records"]) {
    const fixture = noTransitionCommandFixture(sourcePath);
    assertOperationStateProofs(fixture.edge, fixture);
  }
});

test("MDC30-C rejects incomplete or mismatched no-transition COMMAND result joins", () => {
  const attacks = [
    [(f) => { f.edge.p1OperationBindings[0].sourceRef += "/wrong"; }, /exact source-defined command purpose/],
    [(f) => { f.edge.p1OperationStateProofs[0].noP1MachineTransition.sourceRefs = []; }, /exact operation, purpose, result/],
    [(f) => { f.edge.p1OperationStateProofs[0].noP1MachineTransition.operationResultRef = "invented-result"; }, /exact typed result and operation version/],
    [(f) => { f.edge.p1OperationStateProofs[0].noP1MachineTransition.finalityRefs.pop(); }, /typed result and exact finality/],
    [(f) => { f.edge.p1OperationStateProofs[0].noP1MachineTransition.deniedUnknownRecoveryRefs.pop(); }, /exact error, unknown, and recovery semantics/],
    [(f) => { f.operationsById.get("media.operation.fixture.submit-request").recovery = ""; }, /source-defined recovery/],
    [(f) => { delete f.operationsById.get("media.operation.fixture.submit-request").errorSchemaRef; }, /source-defined version and error/],
    [(f) => { delete f.operationsById.get("media.operation.fixture.submit-request").contractVersion; }, /source-defined version and error/],
    [(f) => { f.operationsById.get("media.operation.fixture.submit-request").resultSchema = null; }, /exact typed result/],
    [(f) => { f.operationsById.get("media.operation.fixture.submit-request").resultSchema.required = []; }, /exact typed result/],
    [(f) => { f.operationsById.get("media.operation.fixture.submit-request").resultSchema.required = ["missing"]; }, /exact typed result/],
    [(f) => { f.operationsById.get("media.operation.fixture.submit-request").resultSchema.properties = {}; }, /exact typed result/],
    [(f) => { f.edge.p1OperationStateProofs[0].noP1MachineState = {}; }, /exact typed result/],
    [(f) => { f.operationsById.get("media.operation.fixture.submit-request").stateRefs = ["state-ACTIVE"]; }, /no state or transition refs/],
    [(f) => { f.operationsById.get("media.operation.fixture.submit-request").transitionRefs = ["transition-ACTIVATE"]; }, /no state or transition refs/],
    [(f) => { f.operationsById.get("media.operation.fixture.submit-request").sourceEffect = "read-only inspection; no effect"; }, /as read-only/],
    [(f) => { f.purposeById.get("media.pdp3.step-purpose-binding.fixture-submit.v1").transitionDisposition.status = "UNBOUND"; }, /no state or transition refs/],
    [(f) => { f.purposeById.get("media.pdp3.step-purpose-binding.fixture-submit.v1").stateRefs = ["state-ACTIVE"]; }, /no state or transition refs/],
    [(f) => { f.purposeById.get("media.pdp3.step-purpose-binding.fixture-submit.v1").sourceRefs = []; }, /no state or transition refs/],
  ];
  for (const [mutate, pattern] of attacks) {
    const fixture = noTransitionCommandFixture();
    mutate(fixture);
    assert.throws(() => assertOperationStateProofs(fixture.edge, fixture), pattern);
  }
});

function pxd163CanonicalWriteProofFixture(operationId) {
  const operation = structuredClone(sources.operations.operations.find((item) => item.id === operationId));
  const binding = structuredClone(sources.operations.ownerDefinedJourneyOperationBindings.records.find((item) => item.operationRef === operationId));
  const purposeId = operationId === "media.operation.transcription-submission" ? "media.pdp3.step-purpose-binding.j03-step-02.v1"
    : operationId === "media.operation.caption-version-write" ? "media.pdp3.step-purpose-binding.j03-step-07.v1"
      : "media.pdp3.step-purpose-binding.j03-step-05.v1";
  const purpose = structuredClone(sources.journeyPurpose.records.find((item) => item.id === purposeId));
  const sourceRef = `.product-experience/pdp-1-domain-data/operations.yaml#operations/@id=${operationId}`;
  const purposeRef = `${journeyPurposePath}#records/@id=${purposeId}`;
  const bindingRef = `.product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedJourneyOperationBindings/records/@id=${binding.id}`;
  const resultRef = `${sourceRef}/ownerWireSchema/resultSchema`;
  const sourceRefs = [sourceRef, resultRef, `${sourceRef}/version`, `${sourceRef}/finality`, `${sourceRef}/recovery`, `${sourceRef}/error`, `${sourceRef}/ownerWireSchema`, bindingRef, `${bindingRef}/authorityRefs`, `${purposeRef}/transitionDisposition`, `${purposeRef}/stateRefs`, `${purposeRef}/transitionRefs`];
  const proof = {
    operationRef: operationId,
    disposition: "NO_P1_MACHINE_TRANSITION_TYPED_RESULT",
    purposeBindingRefs: [purposeRef],
    noP1MachineTransition: {
      sourceRefs,
      operationResultRef: resultRef,
      operationVersion: operation.version,
      authorityRefs: [...binding.authorityRefs],
      versionRefs: [`${sourceRef}/version`],
      deniedUnknownRecoveryRefs: [`${sourceRef}/error`, `${sourceRef}/recovery`, ".product-experience/pdp-1-domain-data/action-contracts.yaml#outcomes/@id=UNKNOWN_OUTCOME"],
      finalityRefs: [resultRef, `${sourceRef}/finality`],
    },
  };
  return {
    edge: { id: `fixture.pxd163.${operationId}`, p1OperationBindings: [{ operationRef: operationId, sourceRef }], purposeBindingRefs: [purposeRef], p1OperationStateProofs: [proof] },
    operationsById: new Map([[operationId, operation]]),
    purposeById: new Map([[purposeId, purpose]]),
    journeyOperationBindings: [binding],
    exactStateRefExists: () => false,
    exactObservationRef: () => undefined,
  };
}

test("MDC30-C03 consumes exact nested owner wire results for its three canonical writes", () => {
  for (const operationId of ["media.operation.transcription-submission", "media.operation.caption-draft-write", "media.operation.caption-version-write"]) {
    const fixture = pxd163CanonicalWriteProofFixture(operationId);
    assertOperationStateProofs(fixture.edge, fixture);
  }
});

test("MDC30-C03 rejects malformed source, invented state/transition, partial purpose, and omitted proof obligations", () => {
  const attacks = [
    [(f) => { f.edge.p1OperationBindings[0].sourceRef = ".product-experience/pdp-1-domain-data/operations.yaml#operations/@id=media.operation.invented"; }, /no-transition command proof requires an exact source-defined command purpose/],
    [(f) => { f.operationsById.get("media.operation.caption-draft-write").ownerWireSchema.resultSchema = null; }, /exact typed result/],
    [(f) => { f.journeyOperationBindings[0].wireSchemaRef += "/invented"; }, /exact canonical operation and owner journey-operation binding/],
    [(f) => { f.operationsById.get("media.operation.caption-draft-write").stateRefs = ["media.state.invented"]; f.journeyOperationBindings[0].stateRefs = ["media.state.invented"]; }, /no state or transition refs/],
    [(f) => { f.operationsById.get("media.operation.caption-draft-write").transitionRefs = ["media.transition.invented"]; }, /no state or transition refs/],
    [(f) => { const ref = ".product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml#records/@id=media.pdp3.step-purpose-binding.j03-step-01.v1"; f.edge.purposeBindingRefs.push(ref); f.edge.p1OperationStateProofs[0].purposeBindingRefs = [ref]; }, /wrong purpose-to-operation join/],
    [(f) => { f.edge.p1OperationStateProofs[0].noP1MachineTransition.authorityRefs = []; }, /exact operation authority set/],
    [(f) => { f.edge.p1OperationStateProofs[0].noP1MachineTransition.versionRefs = []; }, /exact typed result and operation version/],
    [(f) => { f.edge.p1OperationStateProofs[0].noP1MachineTransition.finalityRefs = []; }, /typed result and exact finality/],
    [(f) => { f.edge.p1OperationStateProofs[0].noP1MachineTransition.deniedUnknownRecoveryRefs = []; }, /exact error, unknown, and recovery semantics/],
    [(f) => { f.operationsById.get("media.operation.caption-draft-write").recovery = ""; }, /source-defined recovery/],
    [(f) => { f.operationsById.get("media.operation.caption-draft-write").error = undefined; }, /source-defined version and error/],
  ];
  for (const [mutate, pattern] of attacks) {
    const fixture = pxd163CanonicalWriteProofFixture("media.operation.caption-draft-write");
    mutate(fixture);
    assert.throws(() => assertOperationStateProofs(fixture.edge, fixture), pattern);
  }
});

test("MDC30-C03 caption comparison result schema preserves only its two source-defined output branches", () => {
  const operation = sources.operations.operations.find((item) => item.id === "media.operation.caption-version-read");
  const schema = operation.resultSchema;
  assert.ok(schema && Array.isArray(schema.oneOf) && schema.oneOf.length === 2);
  for (const branch of ["EXACT_PAIR", "REGISTRATION_REQUEST"]) {
    const sourceFields = operation.outputSemantics[branch].requiredFields;
    const schemaBranch = schema.oneOf.find((candidate) => sourceFields.every((field) => candidate.required.includes(field)));
    assert.ok(schemaBranch, `${branch} keeps every outputSemantics required field`);
  }
  assert.equal(schema.properties?.outcome, undefined);
  assert.equal(operation.outputSemantics.registrationRequestRules.includes("UNKNOWN_OUTCOME"), true);
});

test("MDC30-C accepts local session draft proofs only with exact no-domain-transition source contracts", () => {
  const edge = {
    id: "fixture.local-session-step",
    journeyContractRef: ".product-experience/pdp-3-product-experience/journey-contracts/animate-vector-or-procedural-scenes.yaml#/steps/0",
    purposeBindingRefs: [".product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml#records/@id=media.pdp3.step-purpose-binding.j12-step-01.v1"],
    localStepNoP1MachineProofs: [{
      stepIndex: 0,
      stepRef: ".product-experience/pdp-3-product-experience/journey-contracts/animate-vector-or-procedural-scenes.yaml#/steps/0",
      actionRef: "media.action.edit-keyframe",
      disposition: "LOCAL_SESSION_OR_DRAFT_EFFECT; NO_MEDIA_DOMAIN_TRANSITION",
      purposeBindingRefs: [".product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml#records/@id=media.pdp3.step-purpose-binding.j12-step-01.v1"],
      localEffectContractRef: ".product-experience/pdp-3-product-experience/local-step-effect-contracts.yaml#records/@id=media.local-step-effect.j-12.step-01.v1",
      sourceRefs: [
        ".product-experience/pdp-3-product-experience/journey-contracts/animate-vector-or-procedural-scenes.yaml#/steps/0",
        ".product-experience/pdp-3-product-experience/journey-contracts/animate-vector-or-procedural-scenes.yaml#/steps/0/stepDefinitionSemantics/action",
        ".product-experience/pdp-3-product-experience/journey-contracts/animate-vector-or-procedural-scenes.yaml#/steps/0/stepDefinitionSemantics/transitionApplicability",
        ".product-experience/pdp-3-product-experience/local-step-effect-contracts.yaml#records/@id=media.local-step-effect.j-12.step-01.v1",
        ".product-experience/pdp-3-product-experience/local-step-effect-contracts.yaml#records/@id=media.local-step-effect.j-12.step-01.v1/effect",
        ".product-experience/pdp-3-product-experience/local-step-effect-contracts.yaml#records/@id=media.local-step-effect.j-12.step-01.v1/finality",
      ],
    }],
  };
  const purpose = {
    id: "media.pdp3.step-purpose-binding.j12-step-01.v1",
    sourceRefs: [".product-experience/pdp-3-product-experience/journey-contracts/animate-vector-or-procedural-scenes.yaml#/steps/0"],
  };
  const effects = new Map(readYaml(localStepEffectPath).records.map((record) => [record.id, record]));
  assertLocalStepNoP1MachineProofs(edge, {
    journeyContract: readYaml(edge.journeyContractRef.split("#")[0]),
    purposeById: new Map([[purpose.id, purpose]]),
    localStepEffectsById: effects,
  });

  const falseDomainTransition = structuredClone(edge);
  falseDomainTransition.localStepNoP1MachineProofs[0].disposition = "NO_P1_MACHINE_STATE";
  assert.throws(() => assertLocalStepNoP1MachineProofs(falseDomainTransition, {
    journeyContract: readYaml(edge.journeyContractRef.split("#")[0]),
    purposeById: new Map([[purpose.id, purpose]]),
    localStepEffectsById: effects,
  }), /exact source-defined local-only effect/);

  const omittedLocalStep = structuredClone(edge);
  omittedLocalStep.localStepNoP1MachineProofs = [];
  assert.throws(() => assertLocalStepNoP1MachineProofs(omittedLocalStep, {
    journeyContract: readYaml(edge.journeyContractRef.split("#")[0]),
    purposeById: new Map([[purpose.id, purpose]]),
    localStepEffectsById: effects,
  }), /every source-defined local session step/);

  const j03Edge = readYaml(registryPath).edges.find((item) => item.id === "media.pdp3.channel-binding.j03.web.v1");
  const j03ContractPath = j03Edge.journeyContractRef.split("#")[0];
  const j03Purpose = readYaml(journeyPurposePath).records.find((item) => item.id === "media.pdp3.step-purpose-binding.j03-step-01.v1");
  const j03PurposeById = new Map([[j03Purpose.id, j03Purpose]]);
  const checkJ03 = (contract = readYaml(j03ContractPath), effectChanges = () => {}) => {
    const j03Effects = new Map(readYaml(localStepEffectPath).records.map((record) => [record.id, structuredClone(record)]));
    effectChanges(j03Effects.get("media.local-step-effect.j-03.step-01.v1"));
    assertLocalStepNoP1MachineProofs(j03Edge, {
      journeyContract: contract,
      purposeById: j03PurposeById,
      localStepEffectsById: j03Effects,
    });
  };
  assert.doesNotThrow(() => checkJ03(), "selected ArtifactVersionRef may be named without implying a canonical state mutation");

  for (const mutate of [
    (contract) => { contract.steps[0].stepDefinitionSemantics.transitionApplicability.transitionRef = "invented-transition"; },
    (contract) => { contract.steps[0].stepDefinitionSemantics.transitionApplicability.stateRefs = ["invented-state"]; },
    (contract) => {
      contract.steps[0].stepDefinitionSemantics.transitionApplicability.operationRef = "media.operation.caption-version-write";
      contract.steps[0].stepDefinitionSemantics.action.exactOperationRefs = ["media.operation.caption-version-write"];
      contract.steps[0].stepDefinitionSemantics.canonicalBindings.canonicalOperationRef = "media.operation.caption-version-write";
    },
  ]) {
    const contract = readYaml(j03ContractPath);
    mutate(contract);
    assert.throws(() => checkJ03(contract), /exact source-defined local-only effect/);
  }
  assert.throws(() => checkJ03(undefined, (effect) => { effect.effect.remoteDispatch = "dispatch"; }), /exact source-defined local-only effect/);
  assert.throws(() => checkJ03(undefined, (effect) => { effect.effect.committedMediaObjects = "changed"; }), /exact source-defined local-only effect/);
});

test("MDC30-C J-06 binds all channel operation roles to the exact request-only no-transition result", () => {
  const document = readYaml(registryPath);
  const j06Edges = document.edges.filter((edge) => edge.taskId === "MDC30-C-06");
  assert.equal(j06Edges.length, 3);
  for (const edge of j06Edges) {
    assert.deepEqual(edge.p1OperationStateProofs.map((proof) => proof.operationRef).sort(), [...edge.pdp1OperationRefs].sort());
    const actionProof = edge.p1OperationStateProofs.find((proof) => proof.operationRef === "media.operation.action.submit-validated-request");
    const capabilityProof = edge.p1OperationStateProofs.find((proof) => proof.operationRef === "media.operation.capability.media-multimodal-observe-source-grounded");
    assert.equal(actionProof.disposition, "NO_P1_MACHINE_TRANSITION_TYPED_RESULT");
    assert.equal(capabilityProof.disposition, "NO_P1_MACHINE_TRANSITION_TYPED_RESULT");
    assert.equal(actionProof.noP1MachineTransition.wrapperOperationRef, "media.operation.job.submit.v1");
    assert.equal(capabilityProof.noP1MachineTransition.wrapperOperationRef, "media.operation.job.submit.v1");
    assert.equal(edge.transportRefOrUnbound, "UNBOUND");
    assert.equal(edge.runtimeAdmission, "NOT_ADMITTED");
    assert.ok(edge.pdp1StateOrObservationRefs.includes(".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.provenance-completeness.v1"));
  }

  const falseQueue = structuredClone(j06Edges[0]);
  const actionProof = falseQueue.p1OperationStateProofs.find((proof) => proof.operationRef === "media.operation.action.submit-validated-request");
  actionProof.noP1MachineTransition.sourceRefs = actionProof.noP1MachineTransition.sourceRefs.filter((ref) => !ref.endsWith("/transitionDisposition"));
  assert.throws(() => assertValid({ ...document, edges: [falseQueue, ...document.edges.filter((edge) => edge.id !== falseQueue.id)] }, sources), /J-06 proof must join exact operation/);

  const claimedExecution = structuredClone(j06Edges[1]);
  claimedExecution.runtimeAdmission = "ADMITTED";
  assert.throws(() => assertValid({ ...document, edges: [claimedExecution, ...document.edges.filter((edge) => edge.id !== claimedExecution.id)] }, sources), /J-06 command proof must bind/);
});
