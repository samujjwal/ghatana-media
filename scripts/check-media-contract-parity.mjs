#!/usr/bin/env node
/**
 * Structural contract drift audit. This intentionally does not turn proposed
 * PDP-1/PDP-3 links into accepted semantic mappings. YAML readers below are
 * narrow source extractors for the repository's authored formats, not YAML
 * parsers or semantic validators.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const read = (path) => readFileSync(join(root, path), "utf8");

const routeKey = ({ method, path }) => `${method.toUpperCase()} ${path}`;
const uniqueBy = (rows, key, label, gaps) => {
  const seen = new Set();
  for (const row of rows) {
    const value = key(row);
    if (seen.has(value)) gaps.push(`ambiguous ${label}: duplicate ${value}`);
    seen.add(value);
  }
};

function parseYamlHttpRows(text) {
  return [...text.matchAll(/    method: (GET|POST|PUT|PATCH|DELETE)\n    path: "([^"]+)"\n    operationId: ([^\n]+)/g)]
    .map((m) => ({ method: m[1], path: m[2], operationId: m[3].trim() }));
}

function parseOpenApiRows(text) {
  const rows = [];
  const pathRe = /^  (\/[^\n]+):\s*$/gm;
  const paths = [...text.matchAll(pathRe)];
  for (let i = 0; i < paths.length; i += 1) {
    const start = paths[i].index + paths[i][0].length;
    const block = text.slice(start, paths[i + 1]?.index ?? text.length);
    for (const match of block.matchAll(/^    (get|post|put|patch|delete):[\s\S]*?^      operationId: ([^\n]+)/gm)) {
      rows.push({ method: match[1].toUpperCase(), path: paths[i][1], operationId: match[2].trim() });
    }
  }
  return rows;
}

function parseRuntimeRows(json) {
  const manifest = JSON.parse(json);
  return (manifest.routes ?? []).map(({ method, path, operationId }) => ({ method, path, operationId }));
}

/** Registry method tokens must also exist as public class/facade methods. This
 * source check excludes keywords and built-ins accidentally captured by the
 * earlier broad token scan (for, if, clearTimeout) without hiding real APIs. */
export function parseSdkRegistryMethods(registry, sourceByPath) {
  const declarations = new Map();
  const nonApiTokens = new Set(["for", "if", "clearTimeout"]);
  for (const [source, code] of Object.entries(sourceByPath)) {
    const names = new Set();
    const classBodies = [...code.matchAll(/^export class [^{]+\{\n([\s\S]*?)^\}/gm)]
      .map((match) => match[1]).join("\n");
    for (const match of classBodies.matchAll(/^  (?:(?:public|private|protected)\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)) {
      const name = match[1];
      // Only class-member declarations at the class' two-space indentation
      // count; interface signatures, control flow and nested calls do not.
      if (!nonApiTokens.has(name)) names.add(name);
    }
    declarations.set(source, names);
  }
  return [...registry.matchAll(/^  - id: ([^\n]+)\n    method: ([^\n]+)\n    visibility: public\n    source: ([^\n]+)/gm)]
    .map((m) => ({ id: m[1].trim(), method: m[2].trim(), source: m[3].trim() }))
    .filter(({ method }) => [...declarations.values()].some((names) => names.has(method)));
}

function normalizeRoutePath(path) {
  return path.replace(/\$\{[^}]+\}/g, "{}").replace(/\{[^/{}]+\}/g, "{}");
}

function routeDispositionKey({ source, method, path }) {
  return `${source} ${method.toUpperCase()} ${normalizeRoutePath(path)}`;
}

export function parseNotAdmittedSdkRoutes(parityMatrix) {
  const start = parityMatrix.indexOf("compatibilityRouteFindings:\n");
  if (start < 0) return [];
  const end = parityMatrix.indexOf("\ntypedUiActionDispositions:\n", start);
  const block = parityMatrix.slice(start, end < 0 ? undefined : end);
  if (!/^compatibilityRouteFindings:\n  disposition: NOT_ADMITTED_TO_CURRENT_RUNTIME_ROUTE_MANIFEST/mu.test(block)) return [];
  return [...block.matchAll(/^    - \{source: ([^,]+), method: ([A-Z]+), path: '([^']+)'\}$/gmu)]
    .map((match) => ({ source: match[1].trim(), method: match[2], path: match[3], disposition: "NOT_ADMITTED" }));
}

export function parseSdkOpenApiDispositions(parityMatrix) {
  const start = parityMatrix.indexOf("typedMethodDispositions:\n");
  if (start < 0) return [];
  const end = parityMatrix.indexOf("\ntypedInterfaceIdentityDispositions:\n", start);
  const section = parityMatrix.slice(start, end < 0 ? undefined : end);
  return section.split(/(?=^- identity: )/mu).flatMap((record) => {
    const identity = record.match(/^- identity: ([^\n]+)/mu)?.[1]?.trim();
    if (!identity) return [];
    return [{
      identity,
      type: record.match(/^  type: ([A-Z_]+)$/mu)?.[1],
      disposition: record.match(/^  openApiBindingDisposition: ([A-Z_]+)$/mu)?.[1],
    }];
  })
    .filter((entry) => entry.identity && entry.disposition);
}

/** Extract only SDK call-sites where the source makes method and path visible. */
export function parseSdkHttpCalls(source, sourceName = "SDK source") {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const calls = [];
  const add = (method, path) => {
    const routePath = path.match(/\/(?:api\/)?[^\s"'`]+/)?.[0] ?? path;
    if (routePath.startsWith("/")) calls.push({ source: sourceName, method: method?.toUpperCase(), path: routePath.replace(/\$\{[^}]+\}/g, "{parameter}") });
  };
  for (const match of code.matchAll(/\.request\(\s*["'](GET|POST|PUT|PATCH|DELETE)["']\s*,\s*(["'`])([^"'`]+)\2/g)) add(match[1], match[3]);
  for (const match of code.matchAll(/\.submit\(\s*(["'`])([^"'`]+)\1/g)) add("POST", match[2]);
  for (const match of code.matchAll(/\.fetchImpl\(\s*(["'`])([^"'`]+)\1\s*,\s*\{\s*method:\s*["'](GET|POST|PUT|PATCH|DELETE)["']/g)) add(match[3], match[2]);
  for (const match of code.matchAll(/\.callService(?:<[^\n(]+>)?\(\s*\{([\s\S]*?)^\s*\}\s*\)/gm)) {
    const method = match[1].match(/\bmethod:\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/i)?.[1];
    const path = match[1].match(/\bpath:\s*(['"])([^'"]+)\1/)?.[2];
    if (path) add(method, path);
  }
  return calls;
}

function compareRoutes(left, right, leftName, rightName, gaps) {
  uniqueBy(left, routeKey, leftName, gaps);
  uniqueBy(right, routeKey, rightName, gaps);
  const rightMap = new Map(right.map((row) => [routeKey(row), row]));
  const leftMap = new Map(left.map((row) => [routeKey(row), row]));
  for (const row of left) {
    const other = rightMap.get(routeKey(row));
    if (!other) gaps.push(`${leftName} route missing from ${rightName}: ${routeKey(row)}`);
    else if (row.operationId !== other.operationId) gaps.push(`${leftName}/${rightName} operationId drift at ${routeKey(row)}: ${row.operationId} != ${other.operationId}`);
  }
  for (const row of right) if (!leftMap.has(routeKey(row))) gaps.push(`${rightName} route missing from ${leftName}: ${routeKey(row)}`);
}

function parseProtoRpcs(text) {
  const services = [...text.matchAll(/^service\s+(\w+)\s*\{/gm)];
  const rows = [];
  for (let i = 0; i < services.length; i += 1) {
    const start = services[i].index + services[i][0].length;
    const block = text.slice(start, services[i + 1]?.index ?? text.length);
    for (const rpc of block.matchAll(/^\s*rpc\s+(\w+)\s*\(/gm)) rows.push(`${services[i][1]}.${rpc[1]}`);
  }
  return rows;
}

/** Inputs are overridable for deterministic drift tests. */
export function analyzeContractParity(input) {
  const gaps = [];
  const reconciledFindings = [];
  const openapi = parseOpenApiRows(input.openapi);
  const runtime = parseRuntimeRows(input.runtimeManifest);
  const httpRegistry = parseYamlHttpRows(input.httpRegistry);
  compareRoutes(openapi, runtime, "OpenAPI", "runtime route manifest", gaps);
  compareRoutes(openapi, httpRegistry, "OpenAPI", "PDP-3 HTTP registry", gaps);

  const operationIds = new Set(openapi.map((row) => row.operationId));
  const sdkOpenApiDispositions = new Map((input.sdkOpenApiDispositions ?? []).map((entry) => [entry.identity, entry]));
  const sdkOperationIdSet = new Set(input.sdkOperationIds ?? []);
  for (const id of input.sdkOperationIds ?? []) {
    if (operationIds.has(id)) continue;
    const finding = `SDK operation has no explicit OpenAPI binding: ${id}`;
    const disposition = sdkOpenApiDispositions.get(id);
    if (disposition && ["CLIENT_ONLY", "TRANSPORT_ONLY", "PROVIDER_ADMIN", "NOT_ADMITTED"].includes(disposition.disposition)) {
      reconciledFindings.push({ finding, disposition: disposition.disposition });
    } else {
      gaps.push(finding);
    }
  }
  for (const entry of sdkOpenApiDispositions.values()) {
    if (!sdkOperationIdSet.has(entry.identity)) gaps.push(`stale SDK OpenAPI disposition has no current SDK identity: ${entry.identity}`);
  }
  const sdkCalls = input.sdkCalls ?? input.sdkPaths ?? [];
  const routeDispositions = input.sdkRouteDispositions ?? [];
  const dispositionMap = new Map(routeDispositions.map((entry) => [routeDispositionKey(entry), entry]));
  const usedRouteDispositions = new Set();
  for (const entry of sdkCalls) {
    if (!entry.method || !/^(GET|POST|PUT|PATCH|DELETE)$/i.test(entry.method)) {
      gaps.push(`HTTP method unparsed/ambiguous: ${entry.source} ${entry.path}; not compared with runtime route`);
      continue;
    }
    const normalizedPath = normalizeRoutePath(entry.path);
    if (runtime.some((route) => route.method.toUpperCase() === entry.method.toUpperCase()
      && normalizeRoutePath(route.path) === normalizedPath)) continue;
    const samePath = runtime.filter((route) => normalizeRoutePath(route.path) === normalizedPath);
    const finding = samePath.length
      ? `client method divergence: ${entry.source} ${entry.method.toUpperCase()} ${entry.path} conflicts with runtime ${samePath.map(routeKey).join(", ")}`
      : `client path divergence: ${entry.source} ${entry.method.toUpperCase()} ${entry.path} is absent from runtime route manifest`;
    const dispositionKey = routeDispositionKey(entry);
    const explicitDisposition = dispositionMap.get(dispositionKey);
    if (explicitDisposition?.disposition === "NOT_ADMITTED") {
      usedRouteDispositions.add(dispositionKey);
      reconciledFindings.push({ finding, disposition: explicitDisposition.disposition });
      continue;
    }
    gaps.push(finding);
  }
  for (const [key, entry] of dispositionMap) {
    if (!usedRouteDispositions.has(key)) gaps.push(`stale SDK route disposition has no matching current divergence: ${entry.source} ${entry.method} ${entry.path}`);
  }
  if ((input.sdkRegistryOperationCount ?? 0) > (input.sdkRegistryHttpVerbCount ?? 0)) {
    const methodCoverageIsSourceParsed = sdkCalls.every((entry) => entry.method && /^(GET|POST|PUT|PATCH|DELETE)$/i.test(entry.method));
    const finding = `HTTP method unparsed/ambiguous: SDK operation registry has ${input.sdkRegistryOperationCount} entries but only ${input.sdkRegistryHttpVerbCount} explicit HTTP-verb bindings; source call-sites below are checked independently`;
    if (methodCoverageIsSourceParsed) {
      reconciledFindings.push({
        finding,
        disposition: "registry-method-fields-and-source-call-sites-are-distinct-populations; all-observed-call-sites-have-source-parsed-verbs",
      });
    } else {
      gaps.push(finding);
    }
  }

  const protoIds = (input.protoFiles ?? []).flatMap(parseProtoRpcs);
  const grpcRegistryIds = [...(input.grpcRegistry ?? "").matchAll(/^    service: (\w+)\n    method: (\w+)/gm)].map((m) => `${m[1]}.${m[2]}`);
  uniqueBy(protoIds, (v) => v, "protobuf RPC identity", gaps);
  uniqueBy(grpcRegistryIds, (v) => v, "gRPC registry identity", gaps);
  for (const id of protoIds) if (!grpcRegistryIds.includes(id)) gaps.push(`protobuf RPC missing from gRPC registry: ${id}`);
  for (const id of grpcRegistryIds) if (!protoIds.includes(id)) gaps.push(`gRPC registry entry missing from protobuf: ${id}`);

  const toolIds = [...(input.agentToolRegistry ?? "").matchAll(/^  - id: ([^\n]+)/gm)].map((m) => m[1].trim());
  const typeNames = [...(input.types ?? "").matchAll(/^export type (\w+)\s*=/gm)].map((m) => m[1]);
  const schemaNames = [...(input.types ?? "").matchAll(/^export const (\w+)Schema\s*=/gm)].map((m) => m[1]);
  if (!toolIds.length) gaps.push("Agent Tool contract inventory is missing or empty");
  if (!typeNames.length && !schemaNames.length) gaps.push("TypeScript contract inventory is missing or empty");
  else gaps.push(`TypeScript structural inventory found ${typeNames.length} exported types and ${schemaNames.length} schemas; operation-to-type bindings are not explicitly registered`);
  if (toolIds.length) gaps.push(`Agent Tool structural inventory found ${toolIds.length} tools; operation bindings and complete input/result contract parity remain pending`);
  // SDK method identities and HTTP call sites are different populations. The
  // call-site parser above reports an unparsed method individually; a registry
  // record without an `httpMethod` is not evidence that the source call site is
  // ambiguous, so do not emit the old aggregate false positive.

  const operationStatus = input.pdp1Operations.match(/^scopeStatus:\s*([^\n]+)/m)?.[1]?.trim() ?? "missing";
  const semanticUnresolved = /proposal|pending|unresolved/i.test(operationStatus)
    || !/accepted|approved/i.test(operationStatus);
  if (semanticUnresolved) gaps.push(`semantic binding unresolved: PDP-1 operations remain ${operationStatus}; structural identities are not accepted mappings`);
  if (!input.pdp1Operations.includes("bindingStatus:")) gaps.push("semantic binding unresolved: PDP-1 binding status is absent");

  return {
    structural: {
      openapiRoutes: openapi.length,
      runtimeRoutes: runtime.length,
      httpRegistryRoutes: httpRegistry.length,
      grpcRegistryRpcs: grpcRegistryIds.length,
      protobufRpcs: protoIds.length,
      typescriptTypes: typeNames.length,
      typescriptSchemas: schemaNames.length,
      agentTools: toolIds.length,
      sdkOperationIds: (input.sdkOperationIds ?? []).length,
      sdkHttpCallSites: sdkCalls.length,
    },
    semanticStatus: semanticUnresolved ? "UNRESOLVED" : "REVIEW_REQUIRED",
    observedFindingCount: gaps.length + reconciledFindings.length,
    reconciledFindings,
    gaps,
    passed: gaps.length === 0,
  };
}

function collectLiveInput() {
  const operationFiles = [
    "modules/speech/stt-service/src/main/proto/stt_service.proto",
    "modules/speech/tts-service/src/main/proto/tts_service.proto",
    "modules/vision/vision-service/src/main/proto/vision_service.proto",
    "modules/intelligence/multimodal-service/src/main/proto/multimodal_service.proto",
  ];
  const operationClient = read("libs/audio-video-client/src/operations.ts");
  const facadeClient = read("libs/audio-video-client/src/index.ts");
  const operationRegistry = read(".product-experience/pdp-3-product-experience/sdk/operation-registry.yaml");
  const operationParity = read(".product-experience/interface-parity/operation-parity.yaml");
  const sdkCalls = [
    ...parseSdkHttpCalls(operationClient, "libs/audio-video-client/src/operations.ts"),
    ...parseSdkHttpCalls(facadeClient, "libs/audio-video-client/src/index.ts"),
  ];
  const sdkRegistryOperationCount = [...operationRegistry.matchAll(/^  - id:/gm)].length;
  const sdkRegistryHttpVerbCount = [...operationRegistry.matchAll(/^\s+httpMethod:/gm)].length;
  return {
    openapi: read("contracts/openapi/media.yaml"),
    runtimeManifest: read("config/route-manifest.json"),
    httpRegistry: read(".product-experience/pdp-3-product-experience/api/api-registry.yaml"),
    grpcRegistry: read(".product-experience/pdp-3-product-experience/grpc/service-registry.yaml"),
    protoFiles: operationFiles.map(read),
    sdkOperationIds: parseSdkRegistryMethods(operationRegistry, {
      "libs/audio-video-client/src/operations.ts": operationClient,
      "libs/audio-video-client/src/index.ts": facadeClient,
    }).map(({ id }) => id),
    sdkCalls,
    sdkRouteDispositions: parseNotAdmittedSdkRoutes(operationParity),
    sdkOpenApiDispositions: parseSdkOpenApiDispositions(operationParity),
    sdkRegistryOperationCount,
    sdkRegistryHttpVerbCount,
    types: read("libs/audio-video-types/src/contracts.ts"),
    agentToolRegistry: read(".product-experience/pdp-3-product-experience/agent-tools/tool-registry.yaml"),
    pdp1Operations: read(".product-experience/pdp-1-domain-data/operations.yaml"),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const result = analyzeContractParity(collectLiveInput());
  console.log(`Media contract parity: ${result.passed ? "PASS" : "NON-GREEN"}`);
  console.log(`  structural inventory: ${JSON.stringify(result.structural)}`);
  console.log(`  semantic binding: ${result.semanticStatus}`);
  console.log(`  source findings audited: ${result.observedFindingCount} (${result.reconciledFindings.length} dispositioned; ${result.gaps.length} unresolved)`);
  if (result.reconciledFindings.length) {
    console.log(`  source-dispositioned findings: ${result.reconciledFindings.length}`);
  }
  if (result.gaps.length) {
    console.error(`  explicit gaps (${result.gaps.length}):`);
    for (const gap of result.gaps) console.error(`  - ${gap}`);
    process.exitCode = 1;
  }
}
