import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const protoFiles = [
  "modules/speech/stt-service/src/main/proto/stt_service.proto",
  "modules/speech/tts-service/src/main/proto/tts_service.proto",
  "modules/vision/vision-service/src/main/proto/vision_service.proto",
  "modules/intelligence/multimodal-service/src/main/proto/multimodal_service.proto",
];
const grpcRoot = ".product-experience/pdp-3-product-experience/grpc";

function parseProtoServices(source, sourcePath) {
  const packageName = source.match(/^package\s+([^;]+);/mu)?.[1];
  assert.ok(packageName, `${sourcePath} declares a protobuf package`);
  const services = [...source.matchAll(/^service\s+(\w+)\s*\{/gmu)];
  const rows = [];
  for (let index = 0; index < services.length; index += 1) {
    const service = services[index][1];
    const start = services[index].index + services[index][0].length;
    const end = services[index + 1]?.index ?? source.length;
    const body = source.slice(start, end);
    for (const match of body.matchAll(/^\s*rpc\s+(\w+)\s*\(\s*(stream\s+)?(\w+)\s*\)\s*returns\s*\(\s*(stream\s+)?(\w+)\s*\)/gmu)) {
      rows.push({
        service,
        method: match[1],
        packageName,
        request: match[3],
        response: match[5],
        clientStreaming: Boolean(match[2]),
        serverStreaming: Boolean(match[4]),
        sourcePath,
      });
    }
  }
  return rows;
}

function scalar(contract, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return contract.match(new RegExp(`^\\s*${escaped}:\\s*(.+?)\\s*$`, "mu"))?.[1];
}

function registryRecord(registry, identity) {
  const escaped = identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^  - id: media\\.grpc\\.${escaped}\\n`, "mu").exec(registry);
  if (!match) return "";
  const start = match.index + match[0].length;
  const next = registry.slice(start).search(/^  - id: /mu);
  return registry.slice(start, next < 0 ? undefined : start + next);
}

function assertRegistryProjection(registry, row) {
  const identity = `${row.service}.${row.method}`;
  const record = registryRecord(registry, identity);
  assert.ok(record, `${identity} has a gRPC registry record`);
  assert.match(registry, new RegExp(`^  - id: media\\.grpc\\.${identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "mu"));
  for (const [key, value] of Object.entries({
    service: row.service,
    method: row.method,
    package: row.packageName,
    source: row.sourcePath,
    request: row.request,
    response: row.response,
    clientStreaming: String(row.clientStreaming),
    serverStreaming: String(row.serverStreaming),
  })) {
    assert.equal(scalar(record, key), value, `${identity} registry ${key} matches protobuf source`);
  }
  assert.equal(scalar(record, "contractFile"), `operations/${identity}.yaml`, `${identity} registry contract file matches identity`);
}

test("all PDP-3 gRPC records project exact protobuf identity, message refs, and stream shape", () => {
  const sourceRows = protoFiles.flatMap((path) => parseProtoServices(readFileSync(path, "utf8"), path));
  const contractDir = join(grpcRoot, "operations");
  const contractFiles = readdirSync(contractDir).filter((path) => path.endsWith(".yaml") && path !== "README.md");
  const registry = readFileSync(join(grpcRoot, "service-registry.yaml"), "utf8");
  const identities = sourceRows.map(({ service, method }) => `${service}.${method}`);
  assert.equal(sourceRows.length, 43, "the governed protobuf service source population is 43 RPCs");
  assert.equal(new Set(identities).size, 43, "protobuf RPC identities are unique");
  assert.equal(contractFiles.length, 43, "there is one PDP-3 gRPC operation record per protobuf RPC");

  for (const row of sourceRows) {
    const identity = `${row.service}.${row.method}`;
    const relativePath = `operations/${identity}.yaml`;
    assert.ok(contractFiles.includes(`${identity}.yaml`), `${identity} has a protocol record`);
    const contract = readFileSync(join(contractDir, `${identity}.yaml`), "utf8");
    assert.equal(scalar(contract, "operationId"), `media.grpc.${identity}`, `${identity} projection identity matches source`);
    assert.equal(scalar(contract, "protocol"), "gRPC", `${identity} remains gRPC`);
    assert.equal(scalar(contract, "service"), row.service, `${identity} service matches source`);
    assert.equal(scalar(contract, "method"), row.method, `${identity} method matches source`);
    assert.equal(scalar(contract, "package"), row.packageName, `${identity} package matches source`);
    assert.equal(scalar(contract, "fullyQualifiedService"), `${row.packageName}.${row.service}`, `${identity} full service identity matches source`);
    assert.equal(scalar(contract, "sourceContract"), row.sourcePath, `${identity} points to the declaring proto file`);
    assert.equal(scalar(contract, "clientStreaming"), String(row.clientStreaming), `${identity} client-streaming flag matches source`);
    assert.equal(scalar(contract, "serverStreaming"), String(row.serverStreaming), `${identity} server-streaming flag matches source`);
    assert.equal(scalar(contract, "protobufMessage"), row.request, `${identity} request message matches source`);
    assert.ok(contract.includes(`schemaRef: ${row.sourcePath}#${row.packageName}.${row.request}`), `${identity} request schema ref matches source`);
    const responseSection = contract.split(/^response:\s*$/mu)[1] ?? "";
    assert.equal(scalar(responseSection, "protobufMessage"), row.response, `${identity} response message matches source`);
    assert.ok(responseSection.includes(`schemaRef: ${row.sourcePath}#${row.packageName}.${row.response}`), `${identity} response schema ref matches source`);
    assertRegistryProjection(registry, row);
  }

  for (const file of contractFiles) {
    assert.ok(identities.includes(file.slice(0, -".yaml".length)), `${file} is not an orphan projection`);
  }
});

test("gRPC registry projection rejects a request or stream-shape drift", () => {
  const sourceRows = protoFiles.flatMap((path) => parseProtoServices(readFileSync(path, "utf8"), path));
  const row = sourceRows.find(({ service, method }) => service === "STTService" && method === "StreamTranscribe");
  assert.ok(row, "the source declares STTService.StreamTranscribe");
  const registry = readFileSync(join(grpcRoot, "service-registry.yaml"), "utf8");
  const record = registryRecord(registry, `${row.service}.${row.method}`);
  assert.ok(record, "the matching registry record exists");
  assert.notEqual(scalar(record, "request"), "WrongRequest", "fixture begins with the source request message");
  const wrongRequest = registry.replace(`    request: ${row.request}\n`, "    request: WrongRequest\n");
  assert.throws(() => assertRegistryProjection(wrongRequest, row), /registry request matches protobuf source/u);
  const wrongStreaming = registry.replace(`    serverStreaming: ${row.serverStreaming}\n`, "    serverStreaming: false\n");
  assert.throws(() => assertRegistryProjection(wrongStreaming, row), /registry serverStreaming matches protobuf source/u);
});
