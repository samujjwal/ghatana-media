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
  const exactObservationRef = (ref) => {
    const match = ref.match(/^\.product-experience\/pdp-1-domain-data\/operations\.yaml#ownerTypedObservationContracts\/records\/@id=(.+)$/);
    return match ? observationById.get(match[1]) : undefined;
  };

  for (const edgeId of operationStateProofEdgeIds) {
    const edge = document.edges.find((item) => item.id === edgeId);
    assert.ok(edge, `${edgeId} remains in the owner-approved edge denominator`);
    assert.ok(Array.isArray(edge.p1OperationStateProofs), `${edgeId} retains its explicit per-operation proof branch`);
    assertOperationStateProofs(edge, { operationsById, purposeById, exactStateRefExists, exactObservationRef });
    assertLocalStepNoP1MachineProofs(edge, {
      journeyContract: readYaml(edge.journeyContractRef.split("#")[0]),
      purposeById,
      localStepEffectsById,
    });
  }

  for (const expected of intended) {
    const edge = document.edges.find((item) => item.journeyRef === expected.journeyId && item.channelRef === expected.channelRef);
    assert.ok(edge, `${expected.taskId} has an edge`);
    if (Object.hasOwn(edge, "p1OperationStateProofs")) {
      assertOperationStateProofs(edge, { operationsById, purposeById, exactStateRefExists, exactObservationRef });
      assertLocalStepNoP1MachineProofs(edge, {
        journeyContract: readYaml(edge.journeyContractRef.split("#")[0]),
        purposeById,
        localStepEffectsById,
      });
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
    assert.equal(
      edge.logicalDefinitionDisposition,
      edge.pdp1OperationRefs.length && (edge.pdp1StateOrObservationRefs.length || Object.hasOwn(edge, "p1OperationStateProofs")) && edge.pdp2GrammarRef
        ? "SOURCE_BOUND_DEFINITION_ONLY"
        : "INCOMPLETE_P1_STATE_OR_OBSERVATION_BINDING",
      `${edge.id} reports exact logical definition coverage without inferring missing state/observation selectors`,
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
      assert.equal(binding.operationVersion ?? null, p1Operation.contractVersion ?? null, `${edge.id} preserves the P1 operation version`);
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
        const directlyCites = ["authorityRefs", "sourceRefs", "operationRefs"].some((field) => (record?.[field] ?? []).includes(ref));
        const journeyOperationRefs = [...(record?.operationRefs ?? []), ...(record?.actionExactOperationRefs ?? [])];
        const chainJoins = observation.operationRefs.some((operationRef) => journeyOperationRefs.includes(operationRef) && edge.pdp1OperationRefs.includes(operationRef));
        return directlyCites && chainJoins;
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

test("MDC30-C-30 binds exact effective-constraint observations and the local no-dispatch step", () => {
  const registry = readYaml(registryPath);
  const observationRef = ".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.effective-processing-constraints.v1";
  const localProofSource = ".product-experience/pdp-3-product-experience/local-step-effect-contracts.yaml#records/@id=media.local-step-effect.j-30.step-04.v1";
  const observation = sources.operations.ownerTypedObservationContracts.records.find((record) => record.id === "media.observation-contract.effective-processing-constraints.v1");
  const expectedDimensions = ["qualification", "license", "health", "capability", "rights"];
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

test("MDC30-C accepts an explicit per-operation NO_P1_MACHINE_STATE proof for a source-defined read-only query", () => {
  const fixture = operationProofFixture();
  assertOperationStateProofs(fixture.edge, fixture);
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
