import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const handoff = readYaml(".product-experience/pdp-1-domain-data/handoff-contracts.yaml").handoffs.pdp1ToPdp2CanonicalDomain;

const methodNames = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);
function countGrpcMethods(paths) {
  return paths.reduce((count, path) => {
    const content = readFileSync(resolve(root, path), "utf8");
    return count + [...content.matchAll(/^\s*rpc\s+\w+\s*\(/gmu)].length;
  }, 0);
}

test("PDP-1 to PDP-2 handoff names a stable source contract and current owner populations", () => {
  assert.equal(handoff.id, "media.pdp1-pdp2.canonical-domain-handoff.v1");
  assert.equal(handoff.sourcePhase, "PDP-1");
  assert.equal(handoff.consumerPhase, "PDP-2");
  assert.equal(handoff.status, "DEFINITION_HANDOFF_CONTRACT");
  assert.match(handoff.authorityBoundary, /does not claim independent domain approval/u);

  const population = handoff.sourcePopulations;
  const domain = readYaml(".product-experience/pdp-1-domain-data/domain-objects.yaml");
  const values = readYaml(".product-experience/pdp-1-domain-data/value-objects.yaml");
  const relationships = readYaml(".product-experience/pdp-1-domain-data/relationships.yaml");
  const states = readYaml(".product-experience/pdp-1-domain-data/states.yaml");
  const transitions = readYaml(".product-experience/pdp-1-domain-data/transitions.yaml");
  const guards = readYaml(".product-experience/pdp-1-domain-data/transition-guard-contracts.yaml");
  const wires = readYaml(".product-experience/pdp-1-domain-data/owner-action-wire-contracts.yaml");
  const operations = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");
  const actionRegistry = readYaml(".product-experience/pdp-3-product-experience/action-registry.yaml");
  const events = readYaml(".product-experience/pdp-1-domain-data/events.yaml");
  const sdk = readYaml(".product-experience/pdp-3-product-experience/sdk/operation-registry.yaml");
  const cli = readYaml(".product-experience/pdp-3-product-experience/cli/command-registry.yaml");
  const tools = readYaml(".product-experience/pdp-3-product-experience/agent-tools/tool-registry.yaml");
  const openapi = readYaml("contracts/openapi/media.yaml");
  const httpCount = Object.values(openapi.paths).reduce((count, pathItem) => count
    + Object.keys(pathItem).filter((method) => methodNames.has(method.toLowerCase())).length, 0);
  const grpcPaths = [
    "modules/speech/stt-service/src/main/proto/stt_service.proto",
    "modules/speech/tts-service/src/main/proto/tts_service.proto",
    "modules/vision/vision-service/src/main/proto/vision_service.proto",
    "modules/intelligence/multimodal-service/src/main/proto/multimodal_service.proto",
  ];

  assert.equal(population.domainObjects.count, domain.objects.length);
  assert.equal(population.registeredObjectIdentities.count, domain.ownerTypedIdentityContracts.records.length);
  assert.equal(population.registeredObjectIdentities.canonicalMediaIdentities
    + population.registeredObjectIdentities.sourceObservationWithoutCanonicalIdentity,
  population.registeredObjectIdentities.count);
  assert.equal(population.valueObjects.count, values.values.length);
  assert.equal(population.relationships.count, relationships.relationships.length);
  assert.equal(population.stateMachines.count, states.stateMachines.length);
  assert.equal(population.transitions.count, transitions.transitionRecords.length + transitions.ownerDefinedTransitionRecords.length);
  assert.equal(population.guardContracts.count, guards.records.length);
  assert.equal(population.typedGuardFacts.count, Object.keys(guards.facts).length);
  assert.equal(population.commonGuardFacts.count, Object.keys(guards.commonFacts).length);
  assert.equal(population.guardExclusivityGroups.count, guards.exclusiveFactGroups.length);
  assert.equal(population.ownerActionWireContracts.count, wires.records.length);
  assert.equal(population.ownerActionWireContracts.actionLinkedCount, wires.records.filter((row) => row.actionRef).length);
  assert.equal(population.ownerActionWireContracts.operationOnlyQueryCount, wires.records.filter((row) => row.id === population.ownerActionWireContracts.operationOnlyQueryId && row.actionRef == null).length);
  const registryActionIds = actionRegistry.actions.map(({ id }) => id);
  const ownerDefinedActionIds = actionRegistry.ownerDefinedActions.map(({ id }) => id);
  const allActionIds = [...registryActionIds, ...ownerDefinedActionIds];
  assert.equal(population.uiActions.count, allActionIds.length);
  assert.equal(population.uiActions.registryActions, registryActionIds.length);
  assert.equal(population.uiActions.ownerDefinedActions, ownerDefinedActionIds.length);
  assert.equal(new Set(allActionIds).size, allActionIds.length, "the exported action identity population is unique");
  assert.equal(population.uiActions.source,
    ".product-experience/pdp-3-product-experience/action-registry.yaml#actions + #ownerDefinedActions");
  assert.deepEqual(ownerDefinedActionIds, [population.uiActions.ownerDefinedActionId]);
  const reconnect = actionRegistry.ownerDefinedActions.find(({ id }) => id === population.uiActions.ownerDefinedActionId);
  assert.equal(reconnect.operationRef, population.uiActions.ownerDefinedOperationRef);
  assert.equal(operations.capabilityOperationContracts.records.some(({ id }) => id === reconnect.operationRef), true,
    "the separately owner-defined UI action selects one exact canonical PDP-1 operation");
  assert.equal(population.canonicalOperations.count, operations.capabilityOperationContracts.canonicalOperationCount);
  assert.equal(population.canonicalOperations.capabilityOperationRecordCount, operations.capabilityOperationContracts.recordCount);
  assert.equal(population.canonicalOperations.existingOperationBindingCount, operations.capabilityOperationContracts.bindingCount);
  assert.equal(population.canonicalOperations.count, 448,
    "canonicalOperations remains the capability-operation schema population");
  assert.equal(population.ownerDefinedOperations.count, operations.ownerDefinedOperationContracts.records.length);
  assert.equal(population.ownerDefinedOperations.source,
    ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records");
  assert.ok(operations.ownerDefinedOperationContracts.records.some(({ id }) =>
    id === "media.operation.stream-session.inspect-execution-recovery.v1"),
  "the J-29 read contract is included by exact identity without constraining its schema details");
  assert.equal(population.interfaceIdentities.http.count, httpCount);
  assert.equal(population.interfaceIdentities.grpc.count, countGrpcMethods(grpcPaths));
  assert.equal(population.interfaceIdentities.sdk.rawRegistryRows, sdk.methods.length);
  assert.equal(population.interfaceIdentities.sdk.count, sdk.methods.filter((row) => row.visibility === "public" && row.declaringClass !== "none; parser-artifact").length);
  assert.equal(population.interfaceIdentities.sdk.parserTokensExcluded, sdk.methods.filter((row) => row.declaringClass === "none; parser-artifact").length);
  assert.equal(population.interfaceIdentities.cli.count, cli.commands.length);
  assert.equal(population.interfaceIdentities.agentTools.count, tools.tools.length);
  assert.equal(population.interfaceIdentities.events.count, events.ownerEventContracts.records.length);
  assert.equal(population.interfaceIdentities.clientNotifications.count, events.ownerEventContracts.notificationRecords.length);

  assert.equal(population.ownerActionWireContracts.operationOnlyQueryId, "media.owner-action-wire.inspect-job-retry-policy.v1");
  assert.deepEqual(handoff.requiredMeaning && Object.keys(handoff.requiredMeaning).sort(), [
    "identitiesAndLineage", "interfaceDisposition", "operationsAndWireContracts", "rightsAndPrivacy", "statesAndGuards", "timeSpaceAndProvenance",
  ].sort());
  assert.ok(handoff.consumerObligations.length >= 6);
  assert.ok(handoff.negativeCases.length >= 6);
  assert.ok(handoff.deferredEvidence.length >= 3);
  assert.deepEqual(handoff.deferredDownstreamFindings.map(({ id }) => id), [
    "P3-CAPABILITY-INVOCATION-OPERATION-REF-SHAPE",
    "P3-PROVENANCE-ACTION-CAPABILITY-CROSSWALK",
  ]);
  const invocationShape = handoff.deferredDownstreamFindings[0];
  assert.deepEqual(invocationShape.candidates, ["J-05", "J-06", "J-08"]);
  assert.equal(invocationShape.disposition, "RESOLVED_SOURCE_CROSSWALK");
  assert.match(invocationShape.observation, /J-05, J-06, and J-08 focused source-only adapter cases pass/u);
  assert.match(invocationShape.observation, /full PDP-3 gate and runtime\/transport\s+admission remain pending and NOT_ADMITTED/u);
  assert.ok(invocationShape.sourceRefs.includes("scripts/lib/pdp3-step-capability-purpose.mjs"));
  const provenanceCrosswalk = handoff.deferredDownstreamFindings[1];
  assert.deepEqual(provenanceCrosswalk.candidates, [
    "media.action.inspect-provenance", "media.provenance.source-lineage.inspect",
  ]);
  assert.equal(provenanceCrosswalk.disposition, "RESOLVED_SOURCE_CROSSWALK");
  assert.match(provenanceCrosswalk.observation, /media\.action\.inspect-provenance now includes media\.provenance\.source-lineage\.inspect/u);
  assert.ok(provenanceCrosswalk.sourceRefs.includes(".product-experience/decision-log.md#PXD-152"));
  assert.match(provenanceCrosswalk.observation, /runtime\/transport admission remains NOT_ADMITTED/u);
  assert.match(handoff.scopeStatus, /development-gate-status-is-recorded-separately/u);
});
