import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyzeContractParity, parseNotAdmittedSdkRoutes, parseSdkHttpCalls, parseSdkRegistryMethods } from "../scripts/check-media-contract-parity.mjs";

const validStructuralInput = (overrides = {}) => ({
  openapi: `  /api/v1/jobs:\n    post:\n      operationId: submitJob\n`,
  runtimeManifest: JSON.stringify({ routes: [{ method: "POST", path: "/api/v1/jobs", operationId: "submitJob" }] }),
  httpRegistry: `    method: POST\n    path: "/api/v1/jobs"\n    operationId: submitJob\n`,
  grpcRegistry: `    service: STTService\n    method: Transcribe\n`,
  protoFiles: [`service STTService {\n  rpc Transcribe (Request) returns (Response);\n}`],
  sdkOperationIds: ["submitJob"],
  sdkPaths: [],
  types: `export const MediaJobSchema = z.object({});\nexport type MediaJob = {};\n`,
  agentToolRegistry: `  - id: av.speech-to-text\n`,
  pdp1Operations: `scopeStatus: proposal-only; exact-operation-bindings-and-owner-review-pending\nbindingStatus: proposed only\n`,
  ...overrides,
});

test("preserves matching OpenAPI/runtime/PDP-3 route identity while reporting semantic proposals non-green", () => {
  const result = analyzeContractParity(validStructuralInput());
  assert.equal(result.structural.openapiRoutes, 1);
  assert.equal(result.structural.runtimeRoutes, 1);
  assert.equal(result.structural.httpRegistryRoutes, 1);
  assert.equal(result.gaps.some((gap) => gap.includes("OpenAPI/runtime route manifest")), false);
  assert.equal(result.semanticStatus, "UNRESOLVED");
  assert.equal(result.passed, false);
  assert.match(result.gaps.join("\n"), /not accepted mappings/);
});

test("detects HTTP route or operation identity drift", () => {
  const result = analyzeContractParity(validStructuralInput({
    runtimeManifest: JSON.stringify({ routes: [{ method: "POST", path: "/api/v1/jobs", operationId: "differentOperation" }] }),
  }));
  assert.ok(result.gaps.some((gap) => gap.includes("operationId drift")));
});

test("rejects SDK client path divergence from the runtime routes", () => {
  const result = analyzeContractParity(validStructuralInput({
    sdkCalls: [{ source: "sdk-client", method: "GET", path: "/api/v1/media/jobs" }],
  }));
  assert.ok(result.gaps.some((gap) => gap.includes("client path divergence") && gap.includes("/api/v1/media/jobs")));
});

test("source-dispositioned legacy paths reconcile individually without becoming OpenAPI bindings", () => {
  const disposition = `compatibilityRouteFindings:\n  disposition: NOT_ADMITTED_TO_CURRENT_RUNTIME_ROUTE_MANIFEST; exact source evidence\n  sourceFindings:\n    - {source: sdk-client, method: GET, path: '/legacy/jobs/{parameter}'}\n\ntypedUiActionDispositions:\n  denominator: 0\n`;
  const routeDispositions = parseNotAdmittedSdkRoutes(disposition);
  assert.equal(routeDispositions.length, 1);
  const result = analyzeContractParity(validStructuralInput({
    sdkCalls: [{ source: "sdk-client", method: "GET", path: "/legacy/jobs/{id}" }],
    sdkRouteDispositions: routeDispositions,
  }));
  assert.equal(result.reconciledFindings.length, 1);
  assert.match(result.reconciledFindings[0].finding, /client path divergence/u);
  assert.equal(result.gaps.some((gap) => /client path divergence/u.test(gap)), false);
  assert.equal(result.observedFindingCount, result.gaps.length + 1);
  assert.equal(result.passed, false, "other unresolved structural/semantic findings remain non-green");
});

test("reports stale route dispositions instead of silently changing the parity denominator", () => {
  const result = analyzeContractParity(validStructuralInput({
    sdkCalls: [],
    sdkRouteDispositions: [{ source: "sdk-client", method: "GET", path: "/legacy/jobs", disposition: "NOT_ADMITTED" }],
  }));
  assert.ok(result.gaps.some((gap) => gap.includes("stale SDK route disposition") && gap.includes("/legacy/jobs")));
});

test("reconciles the SDK registry-method count warning only when all source call sites parsed", () => {
  const input = validStructuralInput({
    sdkCalls: [{ source: "sdk-client", method: "POST", path: "/api/v1/jobs" }],
    sdkRegistryOperationCount: 27,
    sdkRegistryHttpVerbCount: 0,
  });
  const result = analyzeContractParity(input);
  assert.equal(result.observedFindingCount, result.gaps.length + result.reconciledFindings.length);
  assert.ok(result.reconciledFindings.some((item) => item.finding.includes("SDK operation registry has 27 entries")));
  assert.equal(result.gaps.some((gap) => gap.includes("SDK operation registry has 27 entries")), false);

  const unparsed = analyzeContractParity({
    ...input,
    sdkCalls: [{ source: "sdk-client", path: "/api/v1/jobs" }],
  });
  assert.ok(unparsed.gaps.some((gap) => gap.includes("SDK operation registry has 27 entries")));
});

test("rejects an SDK HTTP method mismatch even when the normalized path matches", () => {
  const result = analyzeContractParity(validStructuralInput({
    sdkCalls: [{ source: "sdk-client", method: "GET", path: "/api/v1/jobs" }],
  }));
  assert.ok(result.gaps.some((gap) => gap.includes("client method divergence")
    && gap.includes("GET /api/v1/jobs") && gap.includes("POST /api/v1/jobs")));
});

test("normalizes SDK path parameters before comparing method and route", () => {
  const result = analyzeContractParity(validStructuralInput({
    openapi: `  /api/v1/jobs/{jobId}:\n    get:\n      operationId: getJob\n`,
    runtimeManifest: JSON.stringify({ routes: [{ method: "GET", path: "/api/v1/jobs/{jobId}", operationId: "getJob" }] }),
    httpRegistry: `    method: GET\n    path: "/api/v1/jobs/{jobId}"\n    operationId: getJob\n`,
    sdkCalls: [{ source: "sdk-client", method: "GET", path: "/api/v1/jobs/{parameter}" }],
  }));
  assert.equal(result.gaps.some((gap) => gap.includes("client method divergence") || gap.includes("client path divergence")), false);
});

test("extracts explicit verbs from request, fetch, submit, and facade call sites", () => {
  const calls = parseSdkHttpCalls([
    'this.request("POST", "/api/v1/jobs", body);',
    'this.fetchImpl(`/api/v1/jobs/${encodeURIComponent(id)}`, { method: "PUT" });',
    'this.submit("/api/v1/jobs", body);',
    "this.callService({\n  method: 'GET',\n  path: '/health',\n});",
  ].join("\n"), "fixture-sdk");
  assert.deepEqual(calls.map(({ method, path }) => ({ method, path })), [
    { method: "POST", path: "/api/v1/jobs" },
    { method: "POST", path: "/api/v1/jobs" },
    { method: "PUT", path: "/api/v1/jobs/{parameter}" },
    { method: "GET", path: "/health" },
  ]);
});

test("SDK registry method extraction excludes control tokens and built-in calls but retains public methods", () => {
  const registry = ["getStatus", "for", "if", "clearTimeout", "cancel"].map((method) =>
    `  - id: media.sdk.${method}\n    method: ${method}\n    visibility: public\n    source: sdk.ts`).join("\n");
  const methods = parseSdkRegistryMethods(registry, {
    "sdk.ts": `export class Client {\n  public getStatus(): string { return \"ok\"; }\n  public cancel(): void { clearTimeout(timer); if (true) {} for (;;) break; }\n}`,
  });
  assert.deepEqual(methods.map(({ method }) => method), ["getStatus", "cancel"]);
});

test("typed UI action dispositions reconcile exactly to the 146 source identities", () => {
  const actionRegistry = readFileSync(".product-experience/pdp-3-product-experience/action-registry.yaml", "utf8");
  const parity = readFileSync(".product-experience/interface-parity/operation-parity.yaml", "utf8");
  const operations = readFileSync(".product-experience/pdp-1-domain-data/operations.yaml", "utf8");
  const sourceIds = [...actionRegistry.matchAll(/^- id: (media\.action\.[^\n]+)/gmu)].map((m) => m[1]);
  const ui = parity.split("\ntypedUiActionDispositions:\n")[1];
  assert.ok(ui, "typed UI action disposition section is present");
  assert.match(ui, /^  denominator: 146$/mu);
  const entriesText = ui.split("\n  entries:\n")[1];
  const entries = entriesText.trimEnd().split(/(?=^  - identity: )/mu).map((text) => {
    const [, identity, body] = text.match(/^  - identity: (media\.action\.[^\n]+)\n([\s\S]*)$/u) ?? [];
    return [text, identity, body];
  });
  const typedIds = entries.map((entry) => entry[1]);
  assert.equal(sourceIds.length, 146);
  assert.equal(typedIds.length, 146);
  assert.equal(new Set(typedIds).size, 146, "typed identities are unique");
  assert.deepEqual([...typedIds].sort(), [...sourceIds].sort());

  const allowed = new Set([
    "DOMAIN_COMMAND", "DOMAIN_QUERY", "CLIENT_ONLY", "NAVIGATION_OR_PRESENTATION",
    "TRANSPORT_ONLY", "PROVIDER_ADMIN", "EVENT_NOTIFICATION", "INTERNAL_ONLY", "NOT_ADMITTED",
  ]);
  const counts = {};
  for (const [, identity, body] of entries) {
    const type = body.match(/^    type: ([A-Z_]+)$/mu)?.[1];
    assert.ok(allowed.has(type), `${identity} has an approved typed disposition`);
    counts[type] = (counts[type] ?? 0) + 1;
    const operationRef = body.match(/^    operationRef: (media\.operation\.[^\n]+)$/mu)?.[1];
    if (type === "DOMAIN_COMMAND") assert.ok(operationRef, `${identity} command has an exact PDP-1 operation`);
    if (operationRef) {
      const operationBlock = operations.match(new RegExp(`- id: ${operationRef}\\n([\\s\\S]*?)(?=\\n  - id: media\\.operation\\.|\\nchannelFamilies:)`))?.[1];
      assert.ok(operationBlock, `${identity} references an existing PDP-1 operation`);
      assert.match(operationBlock, new RegExp(identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.match(body, /sourceRecord: \.product-experience\/pdp-3-product-experience\/action-registry\.yaml#actions\[media\.action\./u);
    for (const field of ["label", "preconditions", "effect", "reversible", "finality"]) assert.match(body, new RegExp(`    - ${field}\\n`, "u"));
  }
  assert.deepEqual(counts, {
    CLIENT_ONLY: 48, DOMAIN_COMMAND: 8, DOMAIN_QUERY: 48,
    NOT_ADMITTED: 31, NAVIGATION_OR_PRESENTATION: 11,
  });
});

test("reports an unparsed HTTP method instead of silently passing the route", () => {
  const result = analyzeContractParity(validStructuralInput({
    sdkCalls: [{ source: "sdk-client", path: "/api/v1/jobs" }],
  }));
  assert.ok(result.gaps.some((gap) => gap.includes("HTTP method unparsed/ambiguous") && gap.includes("/api/v1/jobs")));
});

test("compares protobuf RPC identities with the gRPC registry", () => {
  const result = analyzeContractParity(validStructuralInput({
    grpcRegistry: `    service: STTService\n    method: Transcribe\n`,
    protoFiles: [`service STTService {\n  rpc Transcribe (Request) returns (Response);\n  rpc StreamTranscribe (Request) returns (Response);\n}`],
  }));
  assert.ok(result.gaps.some((gap) => gap.includes("protobuf RPC missing from gRPC registry: STTService.StreamTranscribe")));
});
