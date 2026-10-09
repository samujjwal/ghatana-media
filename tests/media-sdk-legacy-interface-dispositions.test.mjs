import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const readText = (path) => readFileSync(resolve(process.cwd(), path), "utf8");
const readYaml = (path) => parse(readText(path));
const parity = readYaml(".product-experience/interface-parity/operation-parity.yaml");
const sdk = parity.surfaces.find(({ surface }) => surface === "SDK registry");
const semantics = sdk.currentSourceMethodDefinitions;
const methodRegistry = readYaml(".product-experience/pdp-3-product-experience/sdk/operation-registry.yaml");
const operations = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");
const legacyClient = readText("libs/audio-video-client/src/index.ts");
const operationClient = readText("libs/audio-video-client/src/operations.ts");
const legacyTypes = readText("libs/audio-video-types/src/index.ts");
const operationTypes = readText("libs/audio-video-types/src/contracts.ts");

function validateCurrentMethodDefinitions(records, registry = methodRegistry, owner = operations) {
  const errors = [];
  const unresolvedIds = new Set(sdk.unresolved);
  if (records.length !== unresolvedIds.size) errors.push("current unresolved SDK population differs from the explicit identity set");
  const ids = records.map(({ methodId }) => methodId);
  if (new Set(ids).size !== ids.length || ids.some((id) => !unresolvedIds.has(id))) errors.push("SDK method records must exactly and uniquely cover the unresolved IDs");
  const registryIds = new Set(registry.methods.map(({ id }) => id));
  const ownerOps = new Set([
    ...(owner.operations ?? []),
    ...(owner.individualOperationContracts?.records ?? []),
    ...(owner.ownerDefinedOperationContracts?.records ?? []),
    ...(owner.capabilityOperationContracts?.records ?? []),
  ].map(({ id }) => id));
  for (const row of records) {
    if (!registryIds.has(row.methodId)) errors.push(`${row.methodId}: not present in exact SDK method registry`);
    const hasResultTypes = row.resultTypeRef || (row.acceptedResultTypeRef && row.returnedResultTypeRef);
    if (!row.methodRef || !row.requestTypeRef || !hasResultTypes || !row.observedRoute || !row.disposition) errors.push(`${row.methodId}: exact method/request/result/route disposition is incomplete`);
    if (row.canonicalOwnerOperationRef && !ownerOps.has(row.canonicalOwnerOperationRef.split("@id=")[1])) errors.push(`${row.methodId}: canonical owner operation does not resolve`);
    if (row.admission !== "NOT_ADMITTED") errors.push(`${row.methodId}: legacy source definition cannot imply runtime admission`);
    if (/CANONICAL.*EQUIVALENT/u.test(row.disposition) && !row.adapterRef) errors.push(`${row.methodId}: canonical equivalence needs an exact typed adapter`);
  }
  return errors;
}

test("all eight unresolved SDK methods have exact source, type, route, and non-equivalence dispositions", () => {
  assert.deepEqual(validateCurrentMethodDefinitions(semantics.records), []);
  const byId = new Map(semantics.records.map((record) => [record.methodId, record]));
  assert.equal(byId.size, 8);
  assert.match(semantics.records.find(({ methodId }) => methodId === "media.sdk.trainVoiceModel").exactGap, /immutable sourceVersionRefs.*trainingProfileRef.*purposeRef.*rightsEvidenceRefs/u);
  assert.match(semantics.records.find(({ methodId }) => methodId === "media.sdk.convertVoice").exactGap, /sourceModelVersionRef.*targetProfileRef.*purposeRef/u);
  assert.match(semantics.records.find(({ methodId }) => methodId === "media.sdk.processMultimodal").exactGap, /generic unknown result payload/u);
  assert.match(semantics.records.find(({ methodId }) => methodId === "media.sdk.getOperationResult").canonicalRule, /UNKNOWN.*accepted-submit snapshot.*closed-schema validation/u);

  for (const row of semantics.records) {
    const source = row.methodRef.startsWith("libs/audio-video-client/src/index.ts#") ? legacyClient : operationClient;
    const methodName = row.methodRef.split("#").at(-1).split(".").at(-1);
    assert.ok(source.includes(methodName), `${row.methodId} method is present in its cited source file`);
    assert.ok(row.requestTypeRef && (row.resultTypeRef || (row.acceptedResultTypeRef && row.returnedResultTypeRef)));
    const routePath = row.observedRoute.replace(/^[A-Z]+\s+/u, "");
    const citedClient = row.methodRef.startsWith("libs/audio-video-client/src/index.ts") ? legacyClient : operationClient;
    const routeSegments = routePath.split("/").filter(Boolean);
    const staticRouteSegments = routeSegments.filter((segment) => !/^\{[^}]+\}$/u.test(segment));
    assert.ok(staticRouteSegments.every((segment) => citedClient.includes(segment)), `${row.methodId} exact route/path segments appear in the cited client source`);
    for (const parameter of routePath.matchAll(/\{([^}]+)\}/gu)) {
      assert.ok(citedClient.includes(`encodeURIComponent(${parameter[1]})`), `${row.methodId} encodes route parameter ${parameter[1]}`);
    }
    for (const typeRef of [row.requestTypeRef, row.resultTypeRef, row.acceptedResultTypeRef, row.returnedResultTypeRef].filter(Boolean)) {
      const [sourcePath, symbol] = typeRef.split("#");
      const sourceText = sourcePath.startsWith("libs/audio-video-client/")
        ? sourcePath.endsWith("operations.ts") ? operationClient : legacyClient
        : sourcePath.includes("src/index.ts") ? legacyTypes : operationTypes;
      assert.ok(sourceText.includes(symbol.split(".").at(-1)), `${row.methodId} cited type ${symbol} exists in its source`);
    }
  }
  assert.ok(legacyTypes.includes("interface AIVoiceRequest"));
  assert.ok(legacyTypes.includes("interface VisionRequest"));
  assert.ok(legacyTypes.includes("interface MultimodalRequest"));
  assert.ok(operationTypes.includes("VoiceTrainingRequestSchema"));
  assert.ok(operationTypes.includes("VoiceConversionRequestSchema"));
  assert.ok(operations.ownerDefinedOperationContracts.records.some(({ id }) => id === "media.operation.voice-model.train.v1"));
  assert.ok(operations.ownerDefinedOperationContracts.records.some(({ id }) => id === "media.operation.voice-model.convert.v1"));
  assert.ok(semantics.records.find(({ methodId }) => methodId === "media.sdk.getOperationResult").canonicalConsumerAdapterRef.includes("validateJobResultObservation"));
});

test("SDK disposition population rejects omissions, swapped owner contracts, and name-based promotion", () => {
  const omitted = structuredClone(semantics.records);
  omitted.pop();
  assert.ok(validateCurrentMethodDefinitions(omitted).some((error) => error.includes("explicit identity set")));

  const wrongOperation = structuredClone(semantics.records);
  wrongOperation.find(({ methodId }) => methodId === "media.sdk.trainVoiceModel").canonicalOwnerOperationRef =
    ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.voice-model.convert.v1";
  const wrongRecord = wrongOperation.find(({ methodId }) => methodId === "media.sdk.trainVoiceModel");
  assert.match(wrongRecord.exactGap, /trainingProfileRef/u);
  assert.ok(operations.ownerDefinedOperationContracts.records.some(({ id }) => id === "media.operation.voice-model.convert.v1"));
  assert.notEqual(wrongRecord.canonicalOwnerOperationRef.split("@id=").at(-1), "media.operation.voice-model.train.v1");

  const guessed = structuredClone(semantics.records);
  guessed.find(({ methodId }) => methodId === "media.sdk.processAIVoice").disposition = "CANONICAL_VOICE_CONVERSION_EQUIVALENT";
  assert.ok(validateCurrentMethodDefinitions(guessed).some((error) => error.includes("canonical equivalence needs an exact typed adapter")));

  const admitted = structuredClone(semantics.records);
  admitted[0].admission = "ADMITTED";
  assert.ok(validateCurrentMethodDefinitions(admitted).some((error) => error.includes("cannot imply runtime admission")));
});
