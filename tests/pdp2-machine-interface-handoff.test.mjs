import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));

function grpcSignatures(path) {
  const source = readFileSync(resolve(root, path), "utf8");
  const signatures = new Map();
  for (const match of source.matchAll(/service\s+(\w+)\s*\{([\s\S]*?)\}/gu)) {
    for (const rpc of match[2].matchAll(/rpc\s+(\w+)\s*\(\s*(stream\s+)?(\w+)\s*\)\s*returns\s*\(\s*(stream\s+)?(\w+)\s*\)\s*;/gu)) {
      signatures.set(`${match[1]}.${rpc[1]}`, {
        service: match[1], method: rpc[1], inputMessage: rpc[3], inputStream: Boolean(rpc[2]),
        outputMessage: rpc[5], outputStream: Boolean(rpc[4]),
      });
    }
  }
  return signatures;
}

function protobufMessageFields(path, name) {
  const source = readFileSync(resolve(root, path), "utf8");
  if (new RegExp(`\\bmessage\\s+${name}\\s*\\{\\s*\\}`, "u").test(source)) return [];
  const message = source.match(new RegExp(`\\bmessage\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`, "u"));
  assert.ok(message, `missing protobuf message ${path}#message.${name}`);
  return message[1].split(/\r?\n/u).flatMap((line) => {
    const content = line.replace(/\/\/.*$/u, "").trim();
    if (!content || content === "}") return [];
    const field = content.match(/^(repeated|optional)?\s*([A-Za-z_][\w.]*|map<\s*([A-Za-z_][\w.]*)\s*,\s*([A-Za-z_][\w.]*)\s*>)\s+([A-Za-z_]\w*)\s*=\s*(\d+)\s*(?:\[[^\]]*\])?;$/u);
    assert.ok(field, `unparsed protobuf field ${path}#message.${name}: ${content}`);
    const [, label = "", type, mapKey, mapValue, fieldName, number] = field;
    return [{ number: Number(number), label: label || "singular", type: mapKey ? `map<${mapKey},${mapValue}>` : type, name: fieldName }];
  });
}

const grammarPath = ".product-experience/pdp-2-design-interface-system/interface-grammar.yaml";
const grammar = readYaml(grammarPath);
const handoff = readYaml(".product-experience/pdp-1-domain-data/handoff-contracts.yaml").handoffs.pdp1ToPdp2CanonicalDomain;

test("PDP-2 machine-interface grammar consumes the frozen PDP-1 handoff without accepting parity or runtime", () => {
  assert.equal(handoff.status, "DEFINITION_HANDOFF_CONTRACT");
  assert.match(handoff.authorityBoundary, /does not claim independent domain approval.*runtime admission/u);
  assert.deepEqual(grammar.machineInterfaceHandoff.requiredPerApplicableBinding, [
    "exact-operation-identity-and-version",
    "exact-tenant-and-object-version-scope",
    "owner-typed-request-result-and-error-refs",
    "authority-and-effect-boundary",
    "cancellation-and-finality",
    "unknown-outcome-reconciliation-and-retry-eligibility",
    "explicit-channel-admission-disposition",
  ]);
  assert.match(grammar.machineInterfaceHandoff.status, /no cross-channel-binding-or-runtime-admission/u);
  assert.deepEqual(Object.keys(grammar.invariants).sort(), [
    "admission", "authority", "cancellation", "errors", "eventObservation", "identity",
    "mutation", "progress", "retry", "tenantAndVersion", "typedContract", "unknownOutcome",
  ]);

  for (const source of grammar.sourceRefs) {
    const file = source.split("#", 1)[0];
    assert.ok(existsSync(resolve(root, file)), `missing handoff grammar source ${source}`);
  }
  for (const channel of ["HTTP", "gRPC", "SDK", "CLI", "events", "agentTools"]) {
    const rule = grammar.channels[channel].rule;
    assert.match(rule, /exact|typed|identity|operation|event|schema/u, `${channel} needs source-specific semantics`);
  }
  assert.match(grammar.channels.gRPC.rule, /exact service\/RPC identity.*request and response field inventory/u);
  assert.match(grammar.channels.gRPC.rule, /canonical error\/result.*equivalence stays unresolved/u);
  assert.equal(grammar.channels.gRPC.runtimeAdmission, "NOT_ADMITTED");

  const grpcSources = handoff.sourcePopulations.interfaceIdentities.grpc.sources.map((source) => source.split("#", 1)[0]);
  assert.equal(handoff.sourcePopulations.interfaceIdentities.grpc.count, 43);
  const sourceSignatures = new Map(grpcSources.flatMap((path) => [...grpcSignatures(path)]));
  const parity = readYaml(".product-experience/interface-parity/operation-parity.yaml");
  const contracts = parity.typedGrpcMethodContracts;
  assert.equal(contracts.length, 43);
  assert.equal(sourceSignatures.size, 43);
  assert.deepEqual([...contracts.map(({ identity }) => identity)].sort(), [...sourceSignatures.keys()].sort(),
    "gRPC identities must be derived from the exact four PDP-1 handoff proto sources");

  const nonOperationDispositions = new Map(parity.typedGrpcNonOperationDispositions.map((record) => [record.identity, record]));
  const operations = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");
  const operationIds = new Set(operations.operations.map(({ id }) => id));
  const ownerOperationIds = new Set(operations.ownerDefinedOperationContracts.records.map(({ id }) => id));
  const counts = { CANDIDATE_ONLY: 0, SOURCE_BACKED_NON_OPERATION: 0, OWNER_ADAPTER_REQUIRED: 0, UNRESOLVED: 0 };
  for (const contract of contracts) {
    const signature = sourceSignatures.get(contract.identity);
    assert.equal(contract.service, signature.service);
    assert.equal(contract.method, signature.method);
    assert.equal(contract.inputMessage, signature.inputMessage);
    assert.equal(contract.inputStream, signature.inputStream);
    assert.equal(contract.outputMessage, signature.outputMessage);
    assert.equal(contract.outputStream, signature.outputStream);
    assert.equal(contract.sourceFile, grpcSources.find((path) => path === contract.sourceFile));
    assert.equal(contract.sourceRef, `${contract.sourceFile}#service.${signature.service}.rpc.${signature.method}`);
    assert.deepEqual(contract.inputFieldInventory.fields, protobufMessageFields(contract.sourceFile, signature.inputMessage));
    assert.deepEqual(contract.outputFieldInventory.fields, protobufMessageFields(contract.sourceFile, signature.outputMessage));
    assert.equal(contract.inputFieldInventory.messageRef, `${contract.sourceFile}#message.${signature.inputMessage}`);
    assert.equal(contract.outputFieldInventory.messageRef, `${contract.sourceFile}#message.${signature.outputMessage}`);
    assert.equal(contract.inputFieldInventory.sourceMeaning,
      "PROTO_FIELD_SHAPE_OBSERVED_ONLY; canonical-semantic-equivalence-not-asserted");
    assert.equal(contract.outputFieldInventory.sourceMeaning,
      "PROTO_FIELD_SHAPE_OBSERVED_ONLY; canonical-semantic-equivalence-not-asserted");
    assert.ok(Object.hasOwn(counts, contract.bindingStatus), `${contract.identity} needs an explicit disposition`);
    counts[contract.bindingStatus] += 1;
    if (contract.bindingStatus === "CANDIDATE_ONLY") {
      assert.ok(operationIds.has(contract.canonicalFamilyCandidateRef));
      assert.match(contract.bindingBasis, /does not establish leaf semantics/u);
      assert.match(contract.fieldParityStatus, /leaf-and-field-parity-not-asserted/u);
    } else if (contract.bindingStatus === "SOURCE_BACKED_NON_OPERATION") {
      const disposition = nonOperationDispositions.get(contract.identity);
      assert.ok(disposition, `${contract.identity} needs its exact non-operation disposition`);
      assert.equal(contract.role, disposition.type);
      assert.equal(contract.canonicalFamilyCandidateRef, null);
    } else if (contract.bindingStatus === "OWNER_ADAPTER_REQUIRED") {
      assert.ok(ownerOperationIds.has(contract.canonicalOwnerOperationRef?.split("@id=")[1]),
        `${contract.identity} must identify its exact PDP-1 owner operation`);
      assert.equal(contract.mediaOwnerSemanticAdapter?.ownerOperationRef, contract.canonicalOwnerOperationRef);
      assert.match(contract.mediaOwnerSemanticAdapter?.canonicalWireEquivalence ?? "", /NOT_ESTABLISHED/u);
      assert.equal(contract.mediaOwnerSemanticAdapter?.runtimeAdmission, "NOT_ADMITTED");
    } else {
      assert.equal(contract.bindingStatus, "UNRESOLVED");
      assert.equal(contract.role, "UNRESOLVED");
      assert.equal(contract.canonicalFamilyCandidateRef, null);
    }
  }
  assert.deepEqual(counts, {
    CANDIDATE_ONLY: 17,
    SOURCE_BACKED_NON_OPERATION: 22,
    OWNER_ADAPTER_REQUIRED: 4,
    UNRESOLVED: 0,
  });

  assert.match(grammar.invariants.tenantAndVersion.rule, /trusted tenant.*object\/version tuple/u);
  assert.match(grammar.invariants.tenantAndVersion.rule, /caller-supplied identity as trusted host context/u);
  assert.match(grammar.invariants.typedContract.rule, /request, result, error, authority, and finality/u);
  assert.ok(grammar.invariants.cancellation.forbidden.includes("request-implies-cancelled"));
  assert.ok(grammar.invariants.cancellation.forbidden.includes("abort-signal-implies-server-cancel"));
  assert.ok(grammar.invariants.unknownOutcome.forbidden.includes("unknown-outcome-blind-retry"));
  assert.ok(grammar.invariants.admission.forbidden.includes("not-admitted-promoted-to-callable"));

  const canonicalApi = readYaml(".product-experience/pdp-2-design-interface-system/api/http-canonical-adapters.yaml");
  assert.equal(canonicalApi.runtimeAdmission, "NOT_ADMITTED");
  const cli = readYaml(".product-experience/pdp-2-design-interface-system/cli-language.yaml");
  assert.equal(cli.ownerDefinedCanonicalCommandContracts.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(cli.ownerDefinedCanonicalCommandContracts.contracts.length, cli.ownerDefinedCanonicalCommandContracts.requiredCommandIds.length);
  for (const command of cli.ownerDefinedCanonicalCommandContracts.contracts) {
    assert.equal(command.admissionState, "NOT_ADMITTED", `${command.commandId} must remain unadmitted`);
    assert.equal(command.runtimeState, "NOT_EVALUATED", `${command.commandId} has no runtime evaluation`);
    assert.match(command.operationContractRef, /operations\.yaml#/u);
    assert.match(command.requestSchemaRef, /requestSchema$/u);
    assert.match(command.resultSchemaRef, /resultSchema$/u);
  }

  const sdk = readYaml(".product-experience/pdp-2-design-interface-system/sdk/conventions.yaml");
  assert.match(sdk.proposalRules.pagination.observed, /no pagination contract is established/u);
  assert.match(sdk.proposalRules.errorsAndFinality.proposal.join(" "), /unknown mutation outcome/u);
  const events = readYaml(".product-experience/pdp-2-design-interface-system/events/conventions.yaml");
  assert.equal(events.observedPopulations.runtimeLifecyclePublishers.count, 9);
  assert.equal(events.observedPopulations.clientLocalNotifications.count, 15);
  assert.match(events.rules.join(" "), /cancellation-request-and-unknown-outcome-are-not-confirmed-finality/u);
  const agent = readYaml(".product-experience/pdp-2-design-interface-system/agent-tools/conventions.yaml");
  assert.equal(agent.mediaOwnedToolDefinitionContracts.invocationSemantics.resultErrorContract.id,
    "media.agent-tool-result-error-union.v1");
  assert.match(agent.scopeStatus, /no tool is admitted, callable, or authorized/u);
  assert.match(agent.mediaOwnedToolDefinitionContracts.invocationSemantics.scopeStatus, /runtime admission pending/u);
});

test("PDP-2 SDK async-handle definition keeps API operation and SDK job projections distinct", () => {
  const sdk = readYaml(".product-experience/pdp-2-design-interface-system/sdk/conventions.yaml");
  const handle = sdk.proposalRules.asynchronousHandles;
  const contract = handle.contract;
  const apiSchema = readFileSync(resolve(root, "contracts/openapi/media.yaml"), "utf8");
  const sdkTypes = readFileSync(resolve(root, "libs/audio-video-types/src/contracts.ts"), "utf8");
  const client = readFileSync(resolve(root, "libs/audio-video-client/src/operations.ts"), "utf8");

  assert.equal(contract.sdkStatusResult, "libs/audio-video-types/src/contracts.ts#MediaProcessingJobSchema");
  assert.equal(contract.sdkObservation, "libs/audio-video-client/src/operations.ts#MediaOperationClient.getOperation");
  assert.equal(contract.apiOperationEvidence, "contracts/openapi/media.yaml#/components/schemas/PlatformOperation");
  assert.equal(contract.apiOperationIdentityField,
    "contracts/openapi/media.yaml#/components/schemas/PlatformOperation/properties/operationId");
  assert.match(contract.identityRelation, /no-admitted-equality-or-crosswalk/u);
  assert.match(contract.stateRelation, /no-admitted-API-to-SDK-state-conversion/u);
  assert.equal(contract.admission, "definition-level-contract-only; legacy-route-not-active; runtime-NOT_ADMITTED");

  assert.match(apiSchema, /PlatformOperation:[\s\S]*?operationId:[\s\S]*?state:[\s\S]*?- SUCCEEDED/u);
  assert.match(sdkTypes, /export const MediaProcessingJobSchema = z\.discriminatedUnion\("state"/u);
  assert.match(sdkTypes, /state: z\.literal\("OUTCOME_UNKNOWN"\)/u);
  assert.match(sdkTypes, /state: z\.literal\("RECONCILING"\)/u);
  assert.match(sdkTypes, /state: z\.enum\(\["FAILED", "PARTIALLY_SUCCEEDED"\]\)/u);
  assert.match(client, /getOperation\([\s\S]*?MediaProcessingJobSchema/u);

  for (const expected of [
    "platform-operation-operationId-treated-as-sdk-job-id-or-canonical-jobId-without-an-explicit-owner-binding",
    "api-succeeded-promoted-to-sdk-completed-without-an-admitted-state-mapping",
    "api-state-used-to-infer-sdk-partially-succeeded-outcome-unknown-or-reconciling",
    "sdk-unknown-or-reconciling-promoted-to-success-failure-or-running-from-api-enum",
    "cancellation-request-or-cancelled-label-used-to-erase-distinct-finality-or-effect-evidence",
  ]) assert.ok(handle.negativeCases.includes(expected), `missing SDK/API distinction negative case ${expected}`);
  assert.equal(new Set(handle.negativeCases).size, handle.negativeCases.length,
    "async-handle negative cases must be unique");
});

test("handoff grammar negative cases retain each machine-channel boundary", () => {
  const negative = grammar.machineInterfaceHandoff.negativeCases;
  for (const expected of [
    "omitted-tenant-or-exact-version-scope",
    "operation-name-matched-without-request-result-error-and-authority-equivalence",
    "cancellation-request-or-local-abort-presented-as-confirmed-cancellation",
    "timeout-or-unknown-outcome-presented-as-failure-success-or-safe-retry",
    "global-pagination-or-search-guarantee-invented-without-endpoint-contract",
    "event-name-or-publication-attempt-presented-as-command-acknowledgement-or-delivery",
    "fixture-cli-or-registered-agent-tool-presented-as-production-runtime",
    "missing-route-or-method-filled-by-inventing-endpoint-or-runtime-support",
    "caller-asserted-tenant-or-principal-treated-as-authenticated-context",
    "new-request-identity-used-instead-of-reconciling-unknown-original-request",
  ]) assert.ok(negative.includes(expected), `missing negative case ${expected}`);
  assert.equal(new Set(negative).size, negative.length, "machine-interface negative cases must be unique");
});
