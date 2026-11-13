#!/usr/bin/env node
/**
 * Snapshot the named Media HTTP/gRPC protocol identities and their observed
 * fields. This is a projection inventory only: it does not make PDP bindings
 * or cross-channel semantic equivalence authoritative.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(packageRoot, "../..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const require = createRequire(resolve(root, "package.json"));
const { parse } = require("yaml");
const snapshotPath = resolve(packageRoot, "src/__tests__/protocol-projection.snapshot.json");

const pdp1 = parse(read(".product-experience/pdp-1-domain-data/operations.yaml"));
const apiIds = pdp1.sourceDenominators.httpOperations.exactObservedOperationIds;
const rpcIds = Object.entries(pdp1.sourceDenominators.grpcRpcs.exactObservedIdentities)
  .flatMap(([service, methods]) => methods.map((method) => `${service}.${method}`));
const sourceExplicitRpcBindings = new Set(Object.keys(pdp1.sourceDenominators.grpcRpcs.explicitMemberOperationIds));
const apiDir = ".product-experience/pdp-3-product-experience/api/operations";
const grpcDir = ".product-experience/pdp-3-product-experience/grpc/operations";
const readYamlDir = (dir) => readdirSync(resolve(root, dir)).filter((file) => file.endsWith(".yaml"))
  .map((file) => parse(read(`${dir}/${file}`)));
const apiRows = readYamlDir(apiDir);
const grpcRows = readYamlDir(grpcDir);
const openapi = parse(read("contracts/openapi/media.yaml"));
const routeManifest = JSON.parse(read("config/route-manifest.json"));

function resolveRef(ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;
  return ref.slice(2).split("/").reduce((value, key) => value?.[key.replaceAll("~1", "/").replaceAll("~0", "~")], openapi);
}

function assertLocalRefsResolve(value, location = "openapi") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertLocalRefsResolve(item, `${location}[${index}]`));
  } else if (value && typeof value === "object") {
    if (typeof value.$ref === "string" && value.$ref.startsWith("#/")) {
      assert.ok(resolveRef(value.$ref), `unresolved local OpenAPI ref ${value.$ref} at ${location}`);
    }
    for (const [key, child] of Object.entries(value)) assertLocalRefsResolve(child, `${location}.${key}`);
  }
}
assertLocalRefsResolve(openapi);

function schemaFields(schema, seen = new Set()) {
  if (!schema || typeof schema !== "object") return [];
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return [];
    seen.add(schema.$ref);
    return schemaFields(resolveRef(schema.$ref), seen);
  }
  const fields = Object.keys(schema.properties ?? {});
  for (const child of [...(schema.allOf ?? []), ...(schema.oneOf ?? []), ...(schema.anyOf ?? [])]) {
    fields.push(...schemaFields(child, seen));
  }
  return [...new Set(fields)].sort();
}

function openApiOperation(opId) {
  for (const [path, pathItem] of Object.entries(openapi.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (operation?.operationId === opId) return { path, method: method.toUpperCase(), pathItem, operation };
    }
  }
  return undefined;
}

function responseFields(operation) {
  const result = {};
  for (const [status, responseRef] of Object.entries(operation.responses ?? {})) {
    const response = responseRef.$ref ? resolveRef(responseRef.$ref) : responseRef;
    const fields = [];
    for (const media of Object.values(response?.content ?? {})) fields.push(...schemaFields(media.schema));
    if (fields.length) result[status] = [...new Set(fields)].sort();
  }
  return result;
}

const byHttpId = new Map(apiRows.map((row) => [row.protocolIdentity?.operationId, row]));
const apiSourceIds = apiRows.map((row) => row.protocolIdentity?.operationId);
assert.equal(new Set(apiSourceIds).size, apiSourceIds.length, "PDP-3 HTTP identities must be unique");
const openApiRows = Object.entries(openapi.paths ?? {}).flatMap(([path, pathItem]) =>
  Object.entries(pathItem).filter(([method, operation]) =>
    ["get", "post", "put", "patch", "delete", "head", "options", "trace"].includes(method.toLowerCase())
      && operation?.operationId).map(([method, operation]) => ({
        id: operation.operationId,
        method: method.toUpperCase(),
        path,
      })));
const manifestRows = routeManifest.routes.map(({ operationId, method, path }) => ({ id: operationId, method, path }));
const sortedIdentityRows = (rows) => rows.map(({ id, method, path }) => `${id}\t${method}\t${path}`).sort();
assert.equal(new Set(openApiRows.map((row) => row.id)).size, openApiRows.length, "OpenAPI operationIds must be unique");
assert.equal(new Set(manifestRows.map((row) => row.id)).size, manifestRows.length, "route manifest operationIds must be unique");
assert.deepEqual(sortedIdentityRows(manifestRows), sortedIdentityRows(openApiRows), "route manifest and OpenAPI operation identity sets must match exactly");
assert.equal(apiIds.length, 27, "PDP-1 HTTP denominator must remain 27");
assert.equal(new Set(apiIds).size, apiIds.length, "PDP-1 HTTP operation identities must be unique");
assert.equal(rpcIds.length, 43, "PDP-1 gRPC denominator must remain 43");
assert.equal(new Set(rpcIds).size, rpcIds.length, "PDP-1 gRPC identities must be unique");
assert.equal(routeManifest.routes.length, 30, "route manifest population changed; review denominator/source gap explicitly");
assert.equal(openApiRows.length, 30, "OpenAPI population changed; review denominator/source gap explicitly");
const extrasHttp = sortedIdentityRows(openApiRows.filter((row) => !apiIds.includes(row.id)));
assert.deepEqual(extrasHttp.map((row) => row.split("\t")[0]).sort(), [
  "getMediaCaptionVersion", "listMediaCaptionVersions", "registerMediaCaptionVersion",
].sort(), "HTTP operations outside the named denominator changed");
const httpSourceExtras = extrasHttp.map((identityRow) => {
  const [id, method, path] = identityRow.split("\t");
  const sourceRow = byHttpId.get(id);
  const route = routeManifest.routes.find((item) => item.operationId === id);
  const source = openApiOperation(id);
  const bindingStatus = sourceRow?.pdp1SemanticBinding?.bindingStatus;
  assert.ok(sourceRow && source, `extra HTTP identity ${id} must exist in PDP-3 and OpenAPI`);
  assert.equal(sourceRow.protocolIdentity?.protocol, "HTTP", `extra PDP-3 protocol must be HTTP for ${id}`);
  assert.equal(sourceRow.protocolIdentity?.operationId, id, `extra PDP-3 operationId must match OpenAPI for ${id}`);
  assert.equal(sourceRow.protocolIdentity?.method, method, `extra PDP-3 method must match OpenAPI for ${id}`);
  assert.equal(sourceRow.protocolIdentity?.path, path, `extra PDP-3 path must match OpenAPI for ${id}`);
  assert.ok(route, `extra HTTP identity ${id} must exist in the route manifest`);
  assert.equal(route.method, method, `extra HTTP route method must match OpenAPI for ${id}`);
  assert.equal(route.path, path, `extra HTTP route path must match OpenAPI for ${id}`);
  assert.equal(sourceRow.routeManifestObservation?.routeId, route.id, `extra PDP-3 route ID must match manifest for ${id}`);
  assert.equal(sourceRow.routeManifestObservation?.identityMatch, "exact-method-path-operationId",
    `extra PDP-3 route observation must be exact for ${id}`);
  assert.ok(bindingStatus?.startsWith("unresolved-"), `extra HTTP identity ${id} must remain explicitly unbound`);
  const body = source.operation.requestBody?.$ref
    ? resolveRef(source.operation.requestBody.$ref)
    : source.operation.requestBody;
  const requestFields = [];
  for (const media of Object.values(body?.content ?? {})) requestFields.push(...schemaFields(media.schema));
  const parameters = [...(source.pathItem.parameters ?? []), ...(source.operation.parameters ?? [])]
    .map((parameter) => parameter.$ref ? resolveRef(parameter.$ref) : parameter)
    .filter(Boolean)
    .map((parameter) => {
      const projection = {
        name: parameter.name,
        in: parameter.in,
        required: Boolean(parameter.required),
        type: parameter.schema?.type ?? parameter.content?.["application/json"]?.schema?.type ?? "UNSPECIFIED",
      };
      if (parameter.schema?.format) projection.format = parameter.schema.format;
      return projection;
    })
    .sort((a, b) => `${a.in}:${a.name}`.localeCompare(`${b.in}:${b.name}`));
  return {
    id,
    identity: { method, path, routeId: route.id },
    requestFields: [...new Set(requestFields)].sort(),
    parameters,
    responseFieldsByStatus: responseFields(source.operation),
    disposition: `UNBOUND/NOT_ADMITTED: ${bindingStatus}`,
  };
});
const http = apiIds.map((id) => {
  const row = byHttpId.get(id);
  const source = openApiOperation(id);
  assert.ok(row && source, `named HTTP operation ${id} must exist in PDP-3 and OpenAPI`);
  const route = routeManifest.routes.find((item) => item.operationId === id);
  assert.ok(route, `named HTTP operation ${id} must exist in the route manifest`);
  assert.equal(route.method, source.method, `route method must match OpenAPI for ${id}`);
  assert.equal(route.path, source.path, `route path must match OpenAPI for ${id}`);
  assert.equal(row.protocolIdentity.method, source.method, `PDP-3 method must match OpenAPI for ${id}`);
  assert.equal(row.protocolIdentity.path, source.path, `PDP-3 path must match OpenAPI for ${id}`);
  const body = source.operation.requestBody?.$ref
    ? resolveRef(source.operation.requestBody.$ref)
    : source.operation.requestBody;
  const requestFields = [];
  for (const media of Object.values(body?.content ?? {})) requestFields.push(...schemaFields(media.schema));
  const parameters = [...(source.pathItem.parameters ?? []), ...(source.operation.parameters ?? [])]
    .map((parameter) => parameter.$ref ? resolveRef(parameter.$ref) : parameter)
    .filter(Boolean)
    .map((parameter) => {
      const projection = {
        name: parameter.name,
        in: parameter.in,
        required: Boolean(parameter.required),
        type: parameter.schema?.type ?? parameter.content?.["application/json"]?.schema?.type ?? "UNSPECIFIED",
      };
      if (parameter.schema?.format) projection.format = parameter.schema.format;
      return projection;
    })
    .sort((a, b) => `${a.in}:${a.name}`.localeCompare(`${b.in}:${b.name}`));
  return {
    id,
    identity: { method: source.method, path: source.path, routeId: route.id },
    requestFields: [...new Set(requestFields)].sort(),
    parameters,
    responseFieldsByStatus: responseFields(source.operation),
    pdpBinding: row.pdp1SemanticBinding?.bindingStatus?.startsWith("unresolved-")
      ? `UNBOUND/NOT_ADMITTED: ${row.pdp1SemanticBinding.bindingStatus}`
      : `BOUNDED_SOURCE_SHAPE_ONLY/NOT_ADMITTED: ${row.pdp1SemanticBinding?.bindingStatus ?? "binding status absent"}`,
  };
});

const protoPaths = [
  "modules/speech/stt-service/src/main/proto/stt_service.proto",
  "modules/speech/tts-service/src/main/proto/tts_service.proto",
  "modules/vision/vision-service/src/main/proto/vision_service.proto",
  "modules/intelligence/multimodal-service/src/main/proto/multimodal_service.proto",
];
function parseProto(path) {
  const rawSource = read(path);
  const source = rawSource.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|\s)\/\/[^\n]*/gmu, "$1");
  const pkg = /^package\s+([\w.]+)\s*;/mu.exec(source)?.[1] ?? "";
  const messages = new Map();
  const blockAt = (text, openIndex) => {
    let depth = 0;
    for (let i = openIndex; i < text.length; i += 1) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}" && --depth === 0) return i;
    }
    throw new Error(`unclosed protobuf block at offset ${openIndex}`);
  };
  const blocks = (text, keyword) => {
    const found = [];
    const pattern = new RegExp(`\\b${keyword}\\s+(\\w+)\\s*\\{`, "gu");
    for (const match of text.matchAll(pattern)) {
      const openIndex = match.index + match[0].lastIndexOf("{");
      const closeIndex = blockAt(text, openIndex);
      found.push({ name: match[1], body: text.slice(openIndex + 1, closeIndex), start: match.index, end: closeIndex + 1 });
    }
    return found;
  };
  const fieldRows = (body) => {
    // Keep oneof members as ordinary fields, while removing nested declarations
    // and enum values. Brace matching avoids truncating nested message bodies.
    let flat = body.replace(/\boneof\s+\w+\s*\{/gu, "{");
    for (const kind of ["message", "enum", "group"]) {
      const pattern = new RegExp(`\\b${kind}\\s+\\w+\\s*\\{`, "gu");
      const ranges = [];
      for (const match of flat.matchAll(pattern)) {
        const openIndex = match.index + match[0].lastIndexOf("{");
        ranges.push([match.index, blockAt(flat, openIndex) + 1]);
      }
      for (const [start, end] of ranges.reverse()) flat = `${flat.slice(0, start)}${" ".repeat(end - start)}${flat.slice(end)}`;
    }
    flat = flat.replace(/[{}]/gu, " ");
    const fields = [];
    const fieldPattern = /^\s*(?:(optional|required|repeated)\s+)?(?:map\s*<\s*([\w.]+)\s*,\s*([\w.]+)\s*>|([\w.]+))\s+(\w+)\s*=\s*(\d+)(?:\s*\[[^\]]*\])?\s*;/gmu;
    for (const match of flat.matchAll(fieldPattern)) {
      const mapType = match[2] ? `map<${match[2]},${match[3]}>` : undefined;
      fields.push({ name: match[5], type: mapType ?? match[4], number: Number(match[6]), ...(match[1] ? { cardinality: match[1] } : {}) });
    }
    return fields.sort((a, b) => a.number - b.number);
  };
  for (const message of blocks(source, "message")) {
    messages.set(message.name, fieldRows(message.body));
  }
  const rpcs = [];
  for (const service of blocks(source, "service")) {
    for (const rpc of service.body.matchAll(/\brpc\s+(\w+)\s*\(\s*(stream\s+)?([\w.]+)\s*\)\s*returns\s*\(\s*(stream\s+)?([\w.]+)\s*\)/gu)) {
      rpcs.push({ service: service.name, method: rpc[1], clientStreaming: Boolean(rpc[2]), request: rpc[3], serverStreaming: Boolean(rpc[4]), response: rpc[5] });
    }
  }
  return { path, pkg, messages, rpcs };
}
const protos = protoPaths.map(parseProto);
const byRpcId = new Map(grpcRows.map((row) => [row.operationId?.replace(/^media\.grpc\./u, ""), row]));
const grpc = rpcIds.map((id) => {
  const row = byRpcId.get(id);
  assert.ok(row, `named gRPC operation ${id} must have a PDP-3 observation`);
  const proto = protos.find((item) => item.rpcs.some((rpc) => `${rpc.service}.${rpc.method}` === id));
  assert.ok(proto, `named gRPC operation ${id} must exist in a current proto descriptor`);
  const rpc = proto.rpcs.find((item) => `${item.service}.${item.method}` === id);
  assert.ok(proto.messages.has(rpc.request), `protobuf request message ${rpc.request} missing for ${id}`);
  assert.ok(proto.messages.has(rpc.response), `protobuf response message ${rpc.response} missing for ${id}`);
  return {
    id,
    identity: {
      package: proto.pkg,
      service: rpc.service,
      method: rpc.method,
      clientStreaming: rpc.clientStreaming,
      serverStreaming: rpc.serverStreaming,
    },
    request: { message: rpc.request, fields: proto.messages.get(rpc.request) ?? [] },
    response: { message: rpc.response, fields: proto.messages.get(rpc.response) ?? [] },
    pdpBinding: sourceExplicitRpcBindings.has(id)
      ? "PROPOSED_NOT_ADMITTED: owner review pending"
      : "UNBOUND/NOT_ADMITTED",
  };
});

const actualRpcIds = protos.flatMap((proto) => proto.rpcs.map((rpc) => `${rpc.service}.${rpc.method}`)).sort();
const extraRpcIds = actualRpcIds.filter((id) => !rpcIds.includes(id));
const missingRpcIds = rpcIds.filter((id) => !actualRpcIds.includes(id)).sort();
assert.equal(actualRpcIds.length, 45, "current proto RPC population changed; review denominator/source gap explicitly");
assert.deepEqual(missingRpcIds, [], "named gRPC denominator contains identities missing from proto descriptors");
assert.deepEqual(extraRpcIds, ["VisionService.RecognizeSceneText", "VisionService.ResolveSourceFrame"], "gRPC operations outside the named denominator changed");
assert.equal(grpcRows.length, 45, "PDP-3 gRPC observation population changed; review source extras explicitly");
const grpcSourceIds = grpcRows.map((row) => row.operationId?.replace(/^media\.grpc\./u, ""));
assert.equal(new Set(grpcSourceIds).size, grpcSourceIds.length, "PDP-3 gRPC identities must be unique");
for (const id of rpcIds) assert.ok(byRpcId.has(id), `named gRPC identity ${id} missing from PDP-3 records`);
assert.deepEqual(apiSourceIds.slice().sort(), openApiRows.map((row) => row.id).sort(), "PDP-3 HTTP operation records and OpenAPI identity sets must match exactly");
assert.deepEqual(grpcSourceIds.slice().sort(), actualRpcIds.slice().sort(), "PDP-3 gRPC operation records and proto identity sets must match exactly");
const extraHttpIds = openApiRows.map((row) => row.id).filter((id) => !apiIds.includes(id)).sort();
const grpcSourceExtras = extraRpcIds.map((id) => {
  const proto = protos.find((item) => item.rpcs.some((rpc) => `${rpc.service}.${rpc.method}` === id));
  const rpc = proto?.rpcs.find((item) => `${item.service}.${item.method}` === id);
  assert.ok(proto && rpc, `extra gRPC source identity ${id} must resolve to a descriptor`);
  assert.ok(proto.messages.has(rpc.request) && proto.messages.has(rpc.response), `extra gRPC source identity ${id} messages must resolve`);
  return {
    id,
    disposition: "UNBOUND/NOT_ADMITTED: outside the named PDP-1 denominator",
    request: { message: rpc.request, fields: proto.messages.get(rpc.request) },
    response: { message: rpc.response, fields: proto.messages.get(rpc.response) },
  };
});
const fieldNames = (identity, part) => grpc.find((row) => row.id === identity)?.[part]?.fields.map((field) => field.name) ?? [];
const findField = (identity, part, name) => grpc.find((row) => row.id === identity)?.[part]?.fields.find((field) => field.name === name);
assert.equal(findField("VisionService.AnalyzeImage", "response", "metadata")?.type, "map<string,string>", "Vision AnalyzeImage metadata map field must remain captured");
assert.ok(fieldNames("VisionService.AnalyzeImage", "request").includes("analysis_types"), "Vision AnalyzeImage request fields must remain captured");
assert.equal(findField("MultimodalService.ProcessMultimodal", "request", "operation_binding")?.type, "CanonicalOperationBinding", "Multimodal operation binding field must remain captured");
assert.equal(findField("MultimodalService.ProcessMultimodal", "response", "metadata")?.type, "map<string,string>", "Multimodal metadata map field must remain captured");
assert.ok(fieldNames("MultimodalService.AnalyzeVideoWithAudio", "request").includes("operation_binding"), "AnalyzeVideoWithAudio operation binding field must remain captured");
assert.ok(fieldNames("MultimodalService.AnalyzeVideoWithAudio", "response").includes("synchronization_status"), "AnalyzeVideoWithAudio response fields must remain captured");
const sceneTextExtra = grpcSourceExtras.find((row) => row.id === "VisionService.RecognizeSceneText");
assert.deepEqual(sceneTextExtra?.response.fields.map((field) => field.name), ["recognized", "rejected"], "protobuf oneof response fields must remain captured even for an unbound source extra");
const sourceFrameExtra = grpcSourceExtras.find((row) => row.id === "VisionService.ResolveSourceFrame");
assert.deepEqual(sourceFrameExtra?.response.fields.map((field) => field.name), ["resolved", "rejected"], "source-frame oneof response fields must remain captured as unbound source-extra semantics");
assert.ok(sourceFrameExtra?.request.fields.some((field) => field.name === "source_version"), "source frame request must retain exact version identity");
const snapshot = {
  schemaVersion: "media.audio-video-types.protocol-projection-observation.v1",
  disposition: "OBSERVED_SOURCE_FIELDS_ONLY; NOT_ADMITTED; no semantic equivalence claimed",
  denominator: { http: 27, grpc: 43 },
  sourceGaps: {
    httpRouteOperationsOutsideNamedDenominator: extraHttpIds,
    grpcRpcsOutsideNamedDenominator: extraRpcIds,
  },
  httpSourceExtras,
  grpcSourceExtras,
  http,
  grpc,
};

if (process.argv.includes("--write")) {
  assert.equal(http.length, 27);
  assert.equal(grpc.length, 43);
  assert.equal(extraHttpIds.length, 3, "HTTP additions outside the named 27 must stay visible");
  assert.equal(extraRpcIds.length, 2, "gRPC additions outside the named 43 must stay visible");
  assert.equal(grpc.filter((row) => row.pdpBinding === "UNBOUND/NOT_ADMITTED").length, 26);
  writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
} else {
  const expected = JSON.parse(readFileSync(snapshotPath, "utf8"));
  assert.deepEqual(snapshot, expected, "protocol identity/field snapshot drifted; review source changes before updating");
  assert.equal(http.length, 27);
  assert.equal(grpc.length, 43);
  assert.equal(extraHttpIds.length, 3, "HTTP additions outside the named 27 must stay visible");
  assert.deepEqual(extraRpcIds, ["VisionService.RecognizeSceneText", "VisionService.ResolveSourceFrame"], "both Vision source extras must remain unbound outside the named 43");
  assert.equal(grpc.filter((row) => row.pdpBinding === "UNBOUND/NOT_ADMITTED").length, 26);
  console.log("Protocol projection snapshot: 30 HTTP routes and 45 gRPC RPCs checked; PDP-1 names 27/43, with 3 HTTP and 2 gRPC source extras retained as unbound gaps.");
}
