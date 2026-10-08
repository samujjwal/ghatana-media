#!/usr/bin/env node
/**
 * Structural contract drift audit. This intentionally does not turn proposed
 * PDP-1/PDP-3 links into accepted semantic mappings. YAML readers below are
 * narrow source extractors for the repository's authored formats, not YAML
 * parsers or semantic validators.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const read = (path) => readFileSync(join(root, path), "utf8");

export function discoverSdkSourceFiles(repositoryRoot, sourceDirectory = "libs/audio-video-client/src") {
  const rootPath = resolve(repositoryRoot);
  const directoryPath = resolve(rootPath, sourceDirectory);
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) {
        if (entry !== "__tests__") visit(path);
      } else if (stats.isFile() && entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".spec.ts") && !entry.endsWith(".d.ts")) {
        files.push(path);
      }
    }
  };
  visit(directoryPath);
  return Object.fromEntries(files.map((path) => [relative(rootPath, path).split(sep).join("/"), readFileSync(path, "utf8")]));
}

const TYPED_CONTRACT_ROLES = new Set([
  "DOMAIN_VALUE_PROJECTION", "DOMAIN_RECORD_PROJECTION", "DOMAIN_RECORD_AND_OPERATION_PROJECTION",
  "OPERATION_KIND_ENUM_PROJECTION", "DOMAIN_STATE_PROJECTION", "COMPATIBILITY_ADAPTER",
  "CAPABILITY_PROJECTION", "DOMAIN_OPERATION_INPUT_PROJECTION", "DOMAIN_OPERATION_RESULT_PROJECTION",
  "DOMAIN_OPERATION_INPUT_COMPONENT", "DOMAIN_OPERATION_ACKNOWLEDGEMENT_PROJECTION", "NOT_ADMITTED",
]);
const TYPED_CONTRACT_STATUSES = new Set(["PROPOSAL_ROLE_ONLY", "COMPATIBILITY_SOURCE_ONLY", "NOT_ADMITTED"]);
const UNQUALIFIED_SPECIALIZED_OPERATIONS = new Set(["SEPARATE_STEMS", "TRAIN_VOICE_MODEL", "CONVERT_VOICE", "EXPORT", "DELETE"]);

function yamlPdp1Ids(text, kind) {
  const prefix = kind === "domain" ? "media.domain" : "media.operation";
  return new Set([...text.matchAll(new RegExp(`^  - id: (${prefix.replaceAll(".", "\\.")}\\.[^\\s]+)$`, "gmu"))].map((match) => match[1]));
}

function operationEnumValues(source) {
  const body = source.match(/^export const MediaOperationKindSchema = z\.enum\(\[([\s\S]*?)\]\);/mu)?.[1] ?? "";
  return [...body.matchAll(/^\s*"([A-Z_]+)",?\s*$/gmu)].map((match) => match[1]);
}

/** Validate the structural role catalog only. This does not establish wire or
 * semantic equivalence, canonical ownership, or runtime support. */
export function validateTypedContractBindings(manifest, typesSource, domainObjects, operations) {
  const errors = [];
  const types = [...typesSource.matchAll(/^export type (\w+)\s*=/gmu)].map((match) => match[1]);
  const schemas = [...typesSource.matchAll(/^export const (\w+)Schema\s*=/gmu)].map((match) => `${match[1]}Schema`);
  const domainIds = yamlPdp1Ids(domainObjects, "domain");
  const operationIds = yamlPdp1Ids(operations, "operation");
  const pdp1Ids = new Set([...domainIds, ...operationIds]);
  const entries = manifest?.bindings ?? [];
  const schemaIds = entries.map((entry) => entry.schema);
  const typeIds = entries.flatMap((entry) => entry.type == null ? [] : [entry.type]);
  const duplicates = (ids) => [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];

  if (!Array.isArray(manifest?.bindings)) errors.push("typed contract binding catalog is missing bindings array");
  for (const id of duplicates(types)) errors.push(`duplicate source exported type identity: ${id}`);
  for (const id of duplicates(schemas)) errors.push(`duplicate source public schema identity: ${id}`);
  for (const id of duplicates(schemaIds)) errors.push(`duplicate schema binding: ${id}`);
  for (const id of duplicates(typeIds)) errors.push(`duplicate type binding: ${id}`);
  for (const id of schemas) if (!schemaIds.includes(id)) errors.push(`missing schema binding: ${id}`);
  for (const id of schemaIds) if (!schemas.includes(id)) errors.push(`stale schema binding: ${id}`);
  for (const id of types) if (!typeIds.includes(id)) errors.push(`missing type binding: ${id}`);
  for (const id of typeIds) if (!types.includes(id)) errors.push(`stale type binding: ${id}`);

  for (const entry of entries) {
    if (!TYPED_CONTRACT_ROLES.has(entry.role)) errors.push(`${entry.schema}: unsupported role ${entry.role}`);
    if (!TYPED_CONTRACT_STATUSES.has(entry.bindingStatus)) errors.push(`${entry.schema}: unsupported binding status ${entry.bindingStatus}`);
    const expectedType = entry.schema === "MultimodalSourceSchema" ? null : entry.schema.replace(/Schema$/u, "");
    if (entry.type !== expectedType) errors.push(`${entry.schema}: type must pair with ${expectedType ?? "no exported type"}`);
    if (!Array.isArray(entry.pdp1Refs)) errors.push(`${entry.schema}: pdp1Refs must be an array`);
    for (const ref of entry.pdp1Refs ?? []) if (!pdp1Ids.has(ref)) errors.push(`${entry.schema}: unsupported PDP-1 reference ${ref}`);
    if (entry.runtimeSupport !== false) errors.push(`${entry.schema}: runtime support must remain explicitly false`);
    if ((entry.role === "NOT_ADMITTED" || entry.bindingStatus === "NOT_ADMITTED")
      && (entry.role !== "NOT_ADMITTED" || entry.bindingStatus !== "NOT_ADMITTED" || entry.pdp1Refs?.length)) {
      errors.push(`${entry.schema}: NOT_ADMITTED disposition is inconsistent or has PDP-1 refs`);
    }
  }
  for (const schema of ["VoiceTrainingRequestSchema", "VoiceConversionRequestSchema", "MediaCanonicalErrorSchema"]) {
    const entry = entries.find((candidate) => candidate.schema === schema);
    if (entry && (entry.role !== "NOT_ADMITTED" || entry.bindingStatus !== "NOT_ADMITTED" || entry.pdp1Refs?.length)) {
      errors.push(`${schema}: source contract must remain NOT_ADMITTED`);
    }
  }

  if (manifest?.denominators?.exportedTypes !== types.length) errors.push(`exported type denominator must be ${types.length}`);
  if (manifest?.denominators?.publicSchemas !== schemas.length) errors.push(`public schema denominator must be ${schemas.length}`);
  if (manifest?.runtimeSupportImplied !== false) errors.push("catalog must not imply runtime support");
  if (manifest?.semanticOperationParity !== "UNRESOLVED") errors.push("semantic operation parity must remain independent and unresolved");
  if (manifest?.wireParity !== "UNRESOLVED") errors.push("wire parity must remain independent and unresolved");

  const enumBinding = entries.find((entry) => entry.schema === "MediaOperationKindSchema");
  if (enumBinding || operationEnumValues(typesSource).length) {
    const dispositions = enumBinding?.operationValueDispositions ?? [];
    const dispositionIds = dispositions.map((entry) => entry.value);
    const sourceValues = operationEnumValues(typesSource);
    for (const id of duplicates(dispositionIds)) errors.push(`duplicate operation value disposition: ${id}`);
    for (const value of sourceValues) if (!dispositionIds.includes(value)) errors.push(`missing operation value disposition: ${value}`);
    for (const value of dispositionIds) if (!sourceValues.includes(value)) errors.push(`stale operation value disposition: ${value}`);
    for (const entry of dispositions) {
      if (UNQUALIFIED_SPECIALIZED_OPERATIONS.has(entry.value)
        && (entry.disposition !== "NOT_ADMITTED" || entry.pdp1Ref)) {
        errors.push(`${entry.value}: specialized operation must remain NOT_ADMITTED`);
      }
      if (entry.disposition === "NOT_ADMITTED" && entry.pdp1Ref) errors.push(`${entry.value}: non-admitted operation has PDP-1 ref`);
      if (entry.disposition !== "NOT_ADMITTED"
        && (!entry.pdp1Ref || !operationIds.has(entry.pdp1Ref))) {
        errors.push(`${entry.value}: proposal operation value lacks a valid PDP-1 operation ref`);
      }
    }
  }
  return errors;
}

/** Validate the earlier type/role manifest format still consumed by existing
 * migration tests. This checks source roles, not wire or runtime acceptance. */
export function analyzeTypedContractBindings({ typeNames, schemaNames, typedContractBindings, domainObjectSource = "", stateModelSource = "", operationSource = "" }) {
  const problems = [];
  if (!typedContractBindings) {
    problems.push("TypeScript role-binding source is absent; do not treat types as canonical operation contracts");
    return problems;
  }
  let manifest;
  try { manifest = typeof typedContractBindings === "string" ? JSON.parse(typedContractBindings) : typedContractBindings; }
  catch { return ["TypeScript typed-contract binding manifest is not valid JSON"]; }
  if (manifest.schemaVersion !== "media.typed-interface-binding.v1" || manifest.source !== "libs/audio-video-types/src/contracts.ts")
    problems.push("TypeScript binding manifest identity/source mismatch");
  if (!Array.isArray(manifest.bindings) || !Array.isArray(manifest.schemaOnly))
    return [...problems, "TypeScript binding manifest has no complete binding collections"];
  const rows = manifest.bindings;
  const names = rows.map((row) => row.type);
  const declared = new Set(typeNames);
  const schemas = new Set(schemaNames.map((name) => name.endsWith("Schema") ? name : `${name}Schema`));
  const usedSchemas = new Set();
  const validRoles = new Set(manifest.roles ?? []);
  if (new Set(names).size !== names.length) problems.push("duplicate TypeScript role binding");
  for (const name of declared) if (!names.includes(name)) problems.push(`missing TypeScript role binding: ${name}`);
  for (const row of rows) {
    if (!declared.has(row.type)) problems.push(`stale TypeScript role binding: ${row.type}`);
    if (!schemas.has(row.schema)) problems.push(`TypeScript ${row.type} references missing schema ${row.schema}`);
    if (usedSchemas.has(row.schema)) problems.push(`TypeScript schema reused ambiguously: ${row.schema}`);
    usedSchemas.add(row.schema);
    if (!validRoles.has(row.role) || !row.reason || row.admission !== "SOURCE_ROLE_ONLY")
      problems.push(`invalid or prematurely admitted TypeScript role binding: ${row.type}`);
    if (["OPERATION_INPUT", "OPERATION_OUTPUT", "ACCEPTANCE_ACK"].includes(row.role)
      && (!row.semanticRef || !operationSource.includes(`- id: ${row.semanticRef}`)))
      problems.push(`TypeScript operation role lacks exact PDP-1 family: ${row.type}`);
    if (row.role === "DOMAIN_OBJECT" && (!row.semanticRef || !domainObjectSource.includes(`- id: ${row.semanticRef}`)))
      problems.push(`TypeScript object role lacks exact PDP-1 identity: ${row.type}`);
    if (row.role === "STATE_PROJECTION" && (!row.semanticRef || !stateModelSource.includes(`modelId: ${row.semanticRef}`)))
      problems.push(`TypeScript state role lacks exact machine identity: ${row.type}`);
    if (row.role === "NOT_ADMITTED_SPECIALIZED_OPERATION" && row.semanticRef)
      problems.push(`unadmitted TypeScript specialized operation cannot claim canonical binding: ${row.type}`);
  }
  for (const row of manifest.schemaOnly) {
    if (!schemas.has(row.schema) || !validRoles.has(row.role) || row.role !== "SUPPORTING_SCHEMA" || row.admission !== "SOURCE_ROLE_ONLY")
      problems.push(`unresolved TypeScript schema-only role: ${row.schema}`);
    if (usedSchemas.has(row.schema)) problems.push(`duplicate TypeScript schema role: ${row.schema}`);
    usedSchemas.add(row.schema);
  }
  for (const schema of schemas) if (!usedSchemas.has(schema)) problems.push(`missing TypeScript schema role: ${schema}`);
  return problems;
}

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
    const classes = new Map();
    for (const classMatch of code.matchAll(/^export class ([^{]+)\{([\s\S]*?)^\}/gm)) {
      const className = classMatch[1].split(/[\s<{]/u)[0];
      const names = new Set();
      for (const match of classMatch[2].matchAll(/^  (?:(public|private|protected)\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)(?:<[^\n>]+>)?\s*\(/gm)) {
        const [, visibility, name] = match;
        // Only exported class-member declarations count; private/protected
        // members, interface signatures, control flow, and nested calls do not.
        if (!nonApiTokens.has(name) && visibility !== "private" && visibility !== "protected" && name !== "constructor") names.add(name);
      }
      classes.set(className, names);
    }
    declarations.set(source, classes);
  }
  return registry.split(/(?=^  - id: )/m).flatMap((record) => {
    const id = record.match(/^  - id: ([^\n]+)/m)?.[1]?.trim();
    const method = record.match(/^    method: ([^\n]+)/m)?.[1]?.trim();
    const visibility = record.match(/^    visibility: ([^\n]+)/m)?.[1]?.trim();
    const source = record.match(/^    source: ([^\n]+)/m)?.[1]?.trim();
    const declaringClass = record.match(/^    declaringClass: ([^\n]+)/m)?.[1]?.trim();
    if (!id || !method || visibility !== "public" || !source || nonApiTokens.has(method)) return [];
    const classes = declarations.get(source);
    const matches = declaringClass
      ? classes?.get(declaringClass)?.has(method) ?? false
      : [...(classes?.values() ?? [])].some((names) => names.has(method));
    return matches ? [{ id, method, source, ...(declaringClass ? { declaringClass } : {}) }] : [];
  });
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
  if (typeNames.length || schemaNames.length) {
    let typedBindingManifest;
    try {
      typedBindingManifest = typeof input.typedContractBindings === "string"
        ? JSON.parse(input.typedContractBindings)
        : input.typedContractBindings;
    } catch (error) {
      gaps.push(`typed contract binding catalog is invalid JSON: ${error.message}`);
    }
    if (typedBindingManifest?.schemaVersion === "media.typed-interface-binding.v1") {
      gaps.push(...analyzeTypedContractBindings({
        typeNames,
        schemaNames,
        typedContractBindings: typedBindingManifest,
        domainObjectSource: input.pdp1DomainObjects,
        stateModelSource: input.pdp0StateModels,
        operationSource: input.pdp1Operations,
      }));
    } else {
      const typedBindingErrors = validateTypedContractBindings(
        typedBindingManifest,
        input.types ?? "",
        input.pdp1DomainObjects ?? "",
        input.pdp1Operations ?? "",
      );
      for (const error of typedBindingErrors) gaps.push(`typed contract binding: ${error}`);
    }
  }
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
  const sdkSourceFiles = discoverSdkSourceFiles(root);
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
    sdkOperationIds: parseSdkRegistryMethods(operationRegistry, sdkSourceFiles).map(({ id }) => id),
    sdkCalls,
    sdkRouteDispositions: parseNotAdmittedSdkRoutes(operationParity),
    sdkOpenApiDispositions: parseSdkOpenApiDispositions(operationParity),
    sdkRegistryOperationCount,
    sdkRegistryHttpVerbCount,
    types: read("libs/audio-video-types/src/contracts.ts"),
    typedContractBindings: read(".product-experience/interface-parity/typed-contract-bindings.json"),
    pdp1DomainObjects: read(".product-experience/pdp-1-domain-data/domain-objects.yaml"),
    agentToolRegistry: read(".product-experience/pdp-3-product-experience/agent-tools/tool-registry.yaml"),
    pdp1Operations: read(".product-experience/pdp-1-domain-data/operations.yaml"),
    pdp0StateModels: read(".product-experience/pdp-0-product-truth/state-models.yaml"),
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
