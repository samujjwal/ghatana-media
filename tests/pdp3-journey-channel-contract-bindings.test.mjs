import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

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

  for (const expected of intended) {
    const edge = document.edges.find((item) => item.journeyRef === expected.journeyId && item.channelRef === expected.channelRef);
    assert.ok(edge, `${expected.taskId} has an edge`);
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
      edge.pdp1OperationRefs.length && edge.pdp1StateOrObservationRefs.length && edge.pdp2GrammarRef
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
  assert.equal(registry.counts.logicalDefinitionOnlyEdges, 29);
  assert.equal(registry.counts.incompleteP1StateOrObservationEdges, 32);
  assert.equal(registry.counts.transportEquivalenceUnboundEdges, 61);
  assert.equal(registry.adversarialFixtureCases.length, 10);
  assert.deepEqual(registry.adversarialFixtureCases.slice(-3).map((fixture) => fixture.id), [
    "MDC30-CHANNEL-NEG-008-NONEXISTENT-STATE-SELECTOR",
    "MDC30-CHANNEL-NEG-009-EMPTY-NESTED-SEMANTICS",
    "MDC30-CHANNEL-NEG-010-MALFORMED-OBSERVATION-OPERATION-JOIN",
  ]);
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
