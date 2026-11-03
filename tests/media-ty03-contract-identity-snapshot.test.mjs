import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const requireTools = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse: parseYaml } = requireTools("yaml");

const read = (path) => readFileSync(path, "utf8");
const pdp1 = parseYaml(read(".product-experience/pdp-1-domain-data/operations.yaml"));
const openapi = parseYaml(read("contracts/openapi/media.yaml"));
const routeManifest = JSON.parse(read("config/route-manifest.json"));
const grpcRegistry = parseYaml(read(".product-experience/pdp-3-product-experience/grpc/service-registry.yaml"));

const protoFiles = [
  "modules/speech/stt-service/src/main/proto/stt_service.proto",
  "modules/speech/tts-service/src/main/proto/tts_service.proto",
  "modules/vision/vision-service/src/main/proto/vision_service.proto",
  "modules/intelligence/multimodal-service/src/main/proto/multimodal_service.proto",
];

function protoIdentities() {
  return protoFiles.flatMap((path) => {
    const source = read(path);
    return [...source.matchAll(/^service\s+(\w+)\s*\{([\s\S]*?)^\}/gmu)].flatMap(([, service, body]) =>
      [...body.matchAll(/^\s*rpc\s+(\w+)\s*\(/gmu)].map(([, method]) => `${service}.${method}`));
  });
}

function openApiOperationIds() {
  const ids = [];
  for (const path of Object.values(openapi.paths)) {
    for (const [method, operation] of Object.entries(path)) {
      if (["get", "post", "put", "patch", "delete", "options", "head", "trace"].includes(method)) {
        ids.push(operation.operationId);
      }
    }
  }
  return ids;
}

test("TY-03 snapshots the current wire identities without expanding PDP-1 admission", () => {
  const http = pdp1.sourceDenominators.httpOperations;
  const pdp1HttpIds = http.exactObservedOperationIds;
  const runtimeHttpIds = routeManifest.routes.map(({ operationId }) => operationId);
  const specHttpIds = openApiOperationIds();

  assert.equal(http.count, 27, "the historical PDP-1 HTTP denominator remains intact");
  assert.equal(new Set(pdp1HttpIds).size, 27, "the PDP-1 HTTP identity list has no duplicates");
  assert.equal(routeManifest.routes.length, 30, "current runtime inventory remains 30 routes");
  assert.deepEqual([...runtimeHttpIds].sort(), [...specHttpIds].sort(), "OpenAPI and runtime operation identities match");
  assert.ok(pdp1HttpIds.every((id) => runtimeHttpIds.includes(id)), "all historical PDP-1 HTTP identities remain observable");
  assert.deepEqual(
    runtimeHttpIds.filter((id) => !pdp1HttpIds.includes(id)).sort(),
    ["getMediaCaptionVersion", "listMediaCaptionVersions", "registerMediaCaptionVersion"],
    "the three later caption-version routes remain unbound to the historical PDP-1 HTTP identity set",
  );
  assert.match(http.bindingStatus, /exact route-to-logical-operation links remain unresolved/u);

  const grpc = pdp1.sourceDenominators.grpcRpcs;
  const pdp1GrpcIds = Object.entries(grpc.exactObservedIdentities)
    .flatMap(([service, methods]) => methods.map((method) => `${service}.${method}`));
  const currentGrpcIds = protoIdentities();
  assert.equal(grpc.count, 43, "the historical PDP-1 gRPC denominator remains intact");
  assert.equal(new Set(pdp1GrpcIds).size, 43, "the PDP-1 gRPC identity list has no duplicates");
  assert.equal(currentGrpcIds.length, 44, "current protobuf source inventory remains 44 RPCs");
  assert.deepEqual(new Set(grpcRegistry.rpcs.map(({ id }) => id)), new Set(currentGrpcIds.map((id) => `media.grpc.${id}`)));
  assert.ok(pdp1GrpcIds.every((id) => currentGrpcIds.includes(id)), "all historical PDP-1 gRPC identities remain observable");
  assert.deepEqual(
    currentGrpcIds.filter((id) => !pdp1GrpcIds.includes(id)),
    ["VisionService.RecognizeSceneText"],
    "the additional OCR RPC remains outside the historical PDP-1 identity set",
  );

  const sceneText = read(".product-experience/pdp-3-product-experience/grpc/operations/VisionService.RecognizeSceneText.yaml");
  assert.match(sceneText, /^  bindingStatus: proposed-exact-source-member-map; owner-review-pending$/mu);
  assert.match(sceneText, /^contractStatus: proposal-only; owner-review-pending$/mu);
});
