import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const readYaml = (path) => parse(readFileSync(resolve(process.cwd(), path), "utf8"));
const parity = readYaml(".product-experience/interface-parity/operation-parity.yaml");
const cli = readYaml(".product-experience/pdp-2-design-interface-system/cli-language.yaml");
const actions = readYaml(".product-experience/pdp-3-product-experience/action-registry.yaml");
const operations = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");

function validate(binding, operationDoc, cliDoc, actionDoc) {
  const errors = [];
  const op = operationDoc.ownerDefinedOperationContracts.records.find(({ id }) => id === binding.operationRef);
  if (binding.operationRef !== "media.operation.job-status.read-dimensions.v1" || !op || op.operationKind !== "QUERY") errors.push("dimension read must resolve to one exact owner QUERY");
  if (binding.operationContractRef !== `.product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=${binding.operationRef}`) errors.push("owner operation selector does not identify the exact record");
  if (binding.requestSchemaRef !== `${binding.operationContractRef}/requestSchema` || binding.resultSchemaRef !== `${binding.operationContractRef}/resultSchema`) errors.push("request/result schemas must resolve from the selected owner operation");
  if (op?.requestSchema?.type !== "object" || op.requestSchema.additionalProperties !== false || op?.resultSchema?.type !== "object" || op.resultSchema.additionalProperties !== false) errors.push("logical read request and result must use closed object schemas");
  if (op?.trustedContext?.source !== "authenticated-host-context-only") errors.push("trusted context must be assembled out of band by the host");
  if (binding.admission !== "NOT_ADMITTED" || binding.transportParity !== "NOT_ESTABLISHED") errors.push("logical read reference cannot imply runtime or transport parity");
  const command = cliDoc.ownerDefinedCanonicalCommandContracts.contracts.find(({ id }) => id === binding.consumers.find(({ consumerId }) => consumerId === "media.cli.command.job-status.v1")?.consumerId);
  if (!command || !command.operationContractRef.endsWith("@id=media.operation.capability.media-job-view-status")) errors.push("legacy CLI status read must remain separately identified");
  const action = actionDoc.actions.find(({ id }) => id === "media.action.view-job-status");
  if (!action || !binding.consumers.some(({ consumerId }) => consumerId === action.id)) errors.push("UI status consumer identity is missing");
  if (binding.operationRef === "media.operation.action.view-job-status") errors.push("logical dimension query cannot be conflated with the legacy scalar status action operation");
  return errors;
}

test("job status CLI and UI projections reference the exact additive logical dimensions query", () => {
  const binding = parity.currentLogicalOwnerReadConsumers;
  assert.deepEqual(validate(binding, operations, cli, actions), []);
  assert.deepEqual(binding.consumers.map(({ consumerId }) => consumerId), ["media.cli.command.job-status.v1", "media.action.view-job-status"]);
  assert.ok(operations.ownerDefinedOperationContracts.records.some(({ id }) => id === "media.operation.job-status.read-dimensions.v1"));
});

test("status consumer binding rejects swapped queries and legacy-status conflation", () => {
  const binding = structuredClone(parity.currentLogicalOwnerReadConsumers);
  binding.operationRef = "media.operation.action.view-job-status";
  assert.ok(validate(binding, operations, cli, actions).some((error) => error.includes("exact owner QUERY")));
  const wrongConsumer = structuredClone(parity.currentLogicalOwnerReadConsumers);
  wrongConsumer.consumers[0].consumerId = "media.cli.command.job-watch.v1";
  assert.ok(validate(wrongConsumer, operations, cli, actions).some((error) => error.includes("legacy CLI status read")));
});
