import test from "node:test";
import assert from "node:assert/strict";
import { analyzeContractParity, parseSdkHttpCalls } from "../scripts/check-media-contract-parity.mjs";

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
