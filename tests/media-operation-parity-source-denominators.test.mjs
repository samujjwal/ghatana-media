import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { discoverSdkSourceFiles } from "../scripts/check-media-contract-parity.mjs";

const parityPath = ".product-experience/interface-parity/operation-parity.yaml";
const openApiPath = "contracts/openapi/media.yaml";
const protoPaths = [
  "modules/speech/stt-service/src/main/proto/stt_service.proto",
  "modules/speech/tts-service/src/main/proto/tts_service.proto",
  "modules/vision/vision-service/src/main/proto/vision_service.proto",
  "modules/intelligence/multimodal-service/src/main/proto/multimodal_service.proto",
];

const parity = readFileSync(parityPath, "utf8");
const openApi = readFileSync(openApiPath, "utf8");
const protos = protoPaths.map((path) => ({ path, text: readFileSync(path, "utf8") }));

function surface(name, nextName) {
  const start = parity.indexOf(`  - surface: ${name}\n`);
  assert.notEqual(start, -1, `${name} parity surface exists`);
  const end = parity.indexOf(`\n  - surface: ${nextName}`, start + 1);
  return parity.slice(start, end < 0 ? undefined : end);
}

function inlineList(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`^\\s*${escaped}: \\[([^\\]]*)\\]$`, "mu"));
  assert.ok(match, `parity source contains ${key} identity list`);
  return match[1].split(",").map((value) => value.trim()).filter(Boolean);
}

function httpSourceIds(source) {
  return [...source.matchAll(/^\s+operationId:\s*([^\s#]+)\s*$/gmu)].map(([, id]) => id);
}

function protoSourceIds(sources) {
  return sources.flatMap(({ text }) => {
    const services = [...text.matchAll(/^service\s+(\w+)\s*\{/gmu)];
    return services.flatMap((service, index) => {
      const start = service.index + service[0].length;
      const end = services[index + 1]?.index ?? text.length;
      return [...text.slice(start, end).matchAll(/^\s*rpc\s+(\w+)\s*\(/gmu)]
        .map(([, method]) => `${service[1]}.${method}`);
    });
  });
}

function candidateIds(surfaceText) {
  const block = surfaceText.match(/\n    (?:proposedSemanticCandidates|explicitlyProposed):\n([\s\S]*?)(?=\n    unresolved:)/u)?.[1] ?? "";
  return [...block.matchAll(/\[([^\]]*)\]/gu)]
    .flatMap(([, values]) => values.split(",").map((value) => value.trim()).filter(Boolean));
}

function grpcUnresolvedIds(surfaceText) {
  const block = surfaceText.match(/\n    unresolved:\n([\s\S]*?)(?=\n    dispositionCounts:)/u)?.[1] ?? "";
  return [...block.matchAll(/^      (\w+): \[([^\]]*)\]$/gmu)]
    .flatMap(([, serviceName, values]) => values.split(",").filter((method) => method.trim()).map((method) => `${serviceName}.${method.trim()}`));
}

function grpcNonOperationIds(surfaceText) {
  const block = surfaceText.match(/\n    sourceBackedNonOperationDispositions:\n([\s\S]*?)(?=\n    dispositionCounts:)/u)?.[1] ?? "";
  return [...block.matchAll(/^        - ([^\n]+)$/gmu)].map(([, id]) => id);
}

function assertExactPartition(sourceIds, partitionIds, label) {
  assert.equal(new Set(sourceIds).size, sourceIds.length, `${label} source identities are unique`);
  assert.equal(new Set(partitionIds).size, partitionIds.length, `${label} crosswalk identities are unique`);
  assert.deepEqual([...partitionIds].sort(), [...sourceIds].sort(), `${label} crosswalk covers exactly the source identities`);
}

test("HTTP and gRPC proposal/unresolved crosswalks partition exact current source identities", () => {
  const http = surface("HTTP", "gRPC");
  const httpSource = httpSourceIds(openApi);
  const boundedHttpIds = [...http.matchAll(/^        (\w+): media\.operation-slice\.[^\n]+$/gmu)].map(([, identity]) => identity);
  const httpTransportOnlyIds = [...http.matchAll(/^        - (\w+)$/gmu)].map(([, identity]) => identity);
  const httpCrosswalk = [...candidateIds(http), ...boundedHttpIds, ...inlineList(http, "unresolved"), ...httpTransportOnlyIds];
  assert.equal(httpSource.length, 27);
  assertExactPartition(httpSource, httpCrosswalk, "HTTP");

  const grpc = surface("gRPC", "CLI fixture commands");
  const grpcSource = protoSourceIds(protos);
  const grpcCrosswalk = [...candidateIds(grpc), ...grpcUnresolvedIds(grpc), ...grpcNonOperationIds(grpc)];
  assert.equal(grpcSource.length, 43);
  assertExactPartition(grpcSource, grpcCrosswalk, "gRPC");
  assert.equal(candidateIds(grpc).length, 17, "the recorded gRPC candidate count remains source-inventory-only");
  assert.equal(grpcUnresolvedIds(grpc).length, 8, "only profile-adaptation and feedback identities remain semantically unresolved");
  assert.equal(grpcNonOperationIds(grpc).length, 18, "health/metrics and provider administration retain explicit non-domain role dispositions");
});

test("HTTP and gRPC source partitions reject stale, missing, and duplicate crosswalk identities", () => {
  const grpc = surface("gRPC", "CLI fixture commands");
  const sourceIds = protoSourceIds(protos);
  const candidates = candidateIds(grpc);
  const unresolved = grpcUnresolvedIds(grpc);
  const nonOperation = grpcNonOperationIds(grpc);
  const expectRejected = (ids, reason) => assert.throws(() => assertExactPartition(sourceIds, ids, "gRPC"), reason);

  expectRejected([...candidates, ...unresolved.slice(1), ...nonOperation], /covers exactly the source identities/u);
  expectRejected([...candidates, ...unresolved, ...nonOperation, "VisionService.StaleMethod"], /covers exactly the source identities/u);
  expectRejected([...candidates, ...unresolved, ...nonOperation, candidates[0]], /crosswalk identities are unique/u);

  const http = surface("HTTP", "gRPC");
  const httpIds = httpSourceIds(openApi);
  const boundedHttpIds = [...http.matchAll(/^        (\w+): media\.operation-slice\.[^\n]+$/gmu)].map(([, identity]) => identity);
  const httpTransportOnlyIds = [...http.matchAll(/^        - (\w+)$/gmu)].map(([, identity]) => identity);
  const httpCrosswalk = [...candidateIds(http), ...boundedHttpIds, ...inlineList(http, "unresolved"), ...httpTransportOnlyIds];
  assert.throws(() => assertExactPartition(httpIds, httpCrosswalk.slice(1), "HTTP"), /covers exactly the source identities/u);
  assert.throws(() => assertExactPartition(httpIds, [...httpCrosswalk, "staleHttpOperation"], "HTTP"), /covers exactly the source identities/u);
  assert.throws(() => assertExactPartition(httpIds, [...httpCrosswalk, httpCrosswalk[0]], "HTTP"), /crosswalk identities are unique/u);
});

test("CLI crosswalk is exact and SDK registry reports exact source-pair discrepancies", () => {
  const cliSurface = surface("CLI fixture commands", "SDK registry");
  const cliRegistry = readFileSync(".product-experience/pdp-3-product-experience/cli/command-registry.yaml", "utf8");
  const cliSourceIds = [...cliRegistry.matchAll(/^\s+- id: (media\.fixture-cli\.[^\n]+)$/gmu)].map(([, id]) => id);
  assert.equal(cliSourceIds.length, 11);
  assertExactPartition(cliSourceIds, [...candidateIds(cliSurface), ...inlineList(cliSurface, "unresolved")], "CLI fixture command");

  const sdkSurface = surface("SDK registry", "Agent Tool handlers");
  const sdkRegistry = readFileSync(".product-experience/pdp-3-product-experience/sdk/operation-registry.yaml", "utf8");
  const sdkRows = sdkRegistry.split(/(?=^  - id: )/mu).flatMap((record) => {
    const id = record.match(/^  - id: ([^\n]+)/mu)?.[1];
    const method = record.match(/^    method: ([^\n]+)/mu)?.[1];
    const visibility = record.match(/^    visibility: ([^\n]+)/mu)?.[1];
    const source = record.match(/^    source: ([^\n]+)/mu)?.[1];
    const declaringClass = record.match(/^    declaringClass: ([^\n]+)/mu)?.[1];
    return id && method && visibility === "public" && source ? [{ id, method, source, declaringClass }] : [];
  });
  assert.equal(sdkRows.length, 33, "SDK registry methodEntryCount must match the raw method rows");
  assert.match(sdkRegistry, /^  methodEntryCount: 33$/mu);
  const parserArtifactIds = inlineList(sdkSurface, "parserArtifactTokensExcludedFromMethodDenominator");
  const artifactIds = new Set(parserArtifactIds);
  const transportOnlyIds = inlineList(sdkSurface, "TRANSPORT_ONLY");
  const clientOnlyIds = inlineList(sdkSurface, "CLIENT_ONLY");
  const providerAdapterIds = inlineList(sdkSurface, "PROVIDER_ADAPTER");
  const notAdmittedIds = inlineList(sdkSurface, "NOT_ADMITTED");
  const boundedCanonicalReadIds = inlineList(sdkSurface, "boundedCanonicalReads");
  const boundedCanonicalOperationIds = inlineList(sdkSurface, "boundedCanonicalOperations");
  assert.deepEqual(providerAdapterIds, ["media.sdk.documentIntelligenceSceneTextAdapter.recognizeFrame"]);
  assert.deepEqual(notAdmittedIds.sort(), ["media.sdk.retry", "media.sdk.retryOperation"]);
  assert.deepEqual(boundedCanonicalReadIds.sort(), ["media.sdk.getArtifact", "media.sdk.getUploadSession"]);
  assert.deepEqual(boundedCanonicalOperationIds.sort(), ["media.sdk.completeUploadSession", "media.sdk.createUploadSession", "media.sdk.uploadPart"]);
  const nonOperationIds = [...transportOnlyIds, ...clientOnlyIds];
  assert.deepEqual(transportOnlyIds.sort(), ["media.sdk.getAllServicesStatus", "media.sdk.getServiceStatus"]);
  assert.deepEqual(clientOnlyIds.sort(), ["media.sdk.addEventListener", "media.sdk.removeEventListener"]);
  const semanticPartition = [...candidateIds(sdkSurface), ...boundedCanonicalOperationIds, ...boundedCanonicalReadIds, ...inlineList(sdkSurface, "unresolved"), ...nonOperationIds, ...providerAdapterIds, ...notAdmittedIds];
  assert.equal(new Set(sdkRows.map(({ id }) => id)).size, sdkRows.length, "SDK registry identities are unique");
  assertExactPartition(
    sdkRows.filter(({ id }) => !artifactIds.has(id)).map(({ id }) => id),
    semanticPartition,
    "SDK registry method identity",
  );

  const sdkSources = discoverSdkSourceFiles(process.cwd());
  const sourcePaths = Object.keys(sdkSources);
  const declarationPairs = [];
  const declarationNames = new Set();
  for (const source of sourcePaths) {
    const code = sdkSources[source];
    for (const exportedClass of code.matchAll(/^export class ([^{]+)\{([\s\S]*?)^\}/gmu)) {
      const className = exportedClass[1].split(/[\s<{]/u)[0];
      for (const declaration of exportedClass[2].matchAll(/^  (?:(public|private|protected)\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)(?:<[^\n>]+>)?\s*\(/gmu)) {
        const [, visibility, method] = declaration;
        if (method === "constructor" || visibility === "private" || visibility === "protected") continue;
        const pair = `${source}#${className}#${method}`;
        declarationPairs.push(pair);
        declarationNames.add(pair);
      }
    }
  }
  const overloadPairs = declarationPairs.filter((pair, index) => declarationPairs.indexOf(pair) !== index);
  assert.deepEqual(overloadPairs, [
    'libs/audio-video-client/src/operations.ts#MediaOperationClient#completeUploadSession',
    'libs/audio-video-client/src/operations.ts#MediaOperationClient#completeUploadSession',
  ], 'only the two documented completion overload signatures repeat a logical source identity');
  assert.equal(declarationPairs.length, 32, '30 logical APIs plus two source-compatible overload signatures');
  const logicalDeclarationPairs = [...new Set(declarationPairs)];
  assert.equal(logicalDeclarationPairs.length, 30);

  const nonArtifactRows = sdkRows.filter(({ id }) => !artifactIds.has(id));
  const candidateIdsAndUnresolved = new Set(semanticPartition);
  const crosswalkPairs = nonArtifactRows
    .filter(({ id }) => candidateIdsAndUnresolved.has(id))
    .map(({ source, declaringClass, method }) => `${source}#${declaringClass}#${method}`);
  assert.equal(new Set(crosswalkPairs).size, crosswalkPairs.length, "SDK source pairs are unique in the crosswalk");
  assertExactPartition(logicalDeclarationPairs, crosswalkPairs, "SDK public source/class/method");
  assert.deepEqual(parserArtifactIds.sort(), ["media.sdk.clearTimeout", "media.sdk.for", "media.sdk.if"]);
  for (const id of parserArtifactIds) {
    const row = sdkRows.find((candidate) => candidate.id === id);
    assert.ok(row, `${id} remains explicitly represented as a parser-artifact registry row`);
    assert.equal(row.declaringClass, "none; parser-artifact", `${id} is explicitly marked as a parser artifact`);
    assert.equal(declarationNames.has(`${row.source}#${row.declaringClass}#${row.method}`), false, `${id} is not an exported public method declaration in its declared source/class`);
  }
  for (const row of nonArtifactRows) {
    assert.ok(row.declaringClass, `${row.id} declares its source class`);
    assert.equal(declarationNames.has(`${row.source}#${row.declaringClass}#${row.method}`), true, `${row.id} method ${row.method} is declared in its recorded source/class`);
  }
  const adapterRow = nonArtifactRows.find(({ id }) => id === providerAdapterIds[0]);
  assert.equal(adapterRow?.source, "libs/audio-video-client/src/scene-text-adapter.ts");
  assert.equal(adapterRow?.declaringClass, "DocumentIntelligenceSceneTextAdapter");
  assert.equal(adapterRow?.method, "recognizeFrame");
  const retry = nonArtifactRows.find(({ id }) => id === "media.sdk.retryOperation");
  assert.equal(retry?.source, "libs/audio-video-client/src/operations.ts");
  assert.equal(retry?.declaringClass, "MediaOperationClient");

  const uploadRead = nonArtifactRows.find(({ id }) => id === "media.sdk.getUploadSession");
  assert.equal(uploadRead?.source, "libs/audio-video-client/src/operations.ts");
  assert.equal(uploadRead?.declaringClass, "MediaOperationClient");
  assert.equal(uploadRead?.method, "getUploadSession");

  const sdkTyped = parity.slice(parity.indexOf("typedMethodDispositions:"), parity.indexOf("typedInterfaceIdentityDispositions:"));
  assert.match(sdkTyped, /- identity: media\.sdk\.documentIntelligenceSceneTextAdapter\.recognizeFrame\n  type: COMPATIBILITY_ADAPTER\n  semanticBinding: not-a-media-http-operation/u);
  assert.match(sdkTyped, /- identity: media\.sdk\.retryOperation\n  type: NOT_ADMITTED\n  semanticBinding: not-admitted-to-current-media-runtime/u);
  assert.match(sdkTyped, /- identity: media\.sdk\.getUploadSession\n  type: DOMAIN_QUERY\n  semanticBinding: accepted-bounded-wire-read[\s\S]*?openApiOperationId: getMediaUpload[\s\S]*?ownerDecisionRef: \.product-experience\/decision-log\.md#PXD-040/u);
  assert.doesNotMatch(parity, /source: libs\/audio-video-client\/src\/operations\.ts, method: POST, path: '\/api\/v1\/media\/operations\/\{parameter\}:retry'/u,
    "retry route must not be reported as an active source call after the SDK fails closed");
  assert.match(sdkRegistry, /targetContractSource: services\/document-intelligence\/contracts\/protocol-v1\.md\n    targetClientPackageObservation: '@ghatana\/document-intelligence-client@0\.1\.0'\n    targetClientAdmission: NOT_CONSUMED; package-peer-is-@ghatana\/document-extraction@0\.1\.0-SNAPSHOT/u,
    "adapter provenance records the observed public DI contract and explicitly denies claiming package consumption");
  assert.match(sdkRegistry, /media\.sdk\.retryOperation[\s\S]*?experienceBinding: SOURCE_COMPATIBLE_BUT_NOT_ADMITTED; MediaOperationNotAdmittedError-before-transport/u);
});
