import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeContractParity, collectLiveInput, discoverSdkSourceFiles, parseNotAdmittedSdkRoutes, parseSdkHttpCalls, parseSdkOpenApiDispositions, parseSdkRegistryMethods, validateTypedContractBindings } from "../scripts/check-media-contract-parity.mjs";

const typedBindingFixture = {
  schemaVersion: "media.interface-parity.typed-contract-bindings.v1",
  denominators: { exportedTypes: 1, publicSchemas: 1 },
  runtimeSupportImplied: false,
  semanticOperationParity: "UNRESOLVED",
  wireParity: "UNRESOLVED",
  bindings: [{ schema: "MediaJobSchema", type: "MediaJob", role: "NOT_ADMITTED", pdp1Refs: [], bindingStatus: "NOT_ADMITTED", runtimeSupport: false }],
};

const validStructuralInput = (overrides = {}) => ({
  openapi: `  /api/v1/jobs:\n    post:\n      operationId: submitJob\n`,
  runtimeManifest: JSON.stringify({ routes: [{ method: "POST", path: "/api/v1/jobs", operationId: "submitJob" }] }),
  httpRegistry: `    method: POST\n    path: "/api/v1/jobs"\n    operationId: submitJob\n`,
  grpcRegistry: `    service: STTService\n    method: Transcribe\n`,
  protoFiles: [`service STTService {\n  rpc Transcribe (Request) returns (Response);\n}`],
  sdkOperationIds: ["submitJob"],
  sdkPaths: [],
  types: `export const MediaJobSchema = z.object({});\nexport type MediaJob = {};\n`,
  typedContractBindings: typedBindingFixture,
  pdp1DomainObjects: "",
  agentToolRegistry: `  - id: av.speech-to-text\n`,
  pdp1Operations: `scopeStatus: proposal-only; exact-operation-bindings-and-owner-review-pending\nbindingStatus: proposed only\n`,
  ...overrides,
});

test("typed contract catalog validation rejects missing, duplicate, stale, and non-admitted operation bindings", () => {
  const currentManifest = JSON.parse(readFileSync(".product-experience/interface-parity/typed-contract-bindings.json", "utf8"));
  const types = readFileSync("libs/audio-video-types/src/contracts.ts", "utf8");
  const domainObjects = readFileSync(".product-experience/pdp-1-domain-data/domain-objects.yaml", "utf8");
  const operations = readFileSync(".product-experience/pdp-1-domain-data/operations.yaml", "utf8");
  const validate = (manifest, source = types) => validateTypedContractBindings(manifest, source, domainObjects, operations);

  const duplicateSchema = structuredClone(currentManifest);
  duplicateSchema.bindings.push({ ...duplicateSchema.bindings[0] });
  assert.ok(validate(duplicateSchema).some((error) => error.includes("duplicate schema binding")));

  const staleRef = structuredClone(currentManifest);
  staleRef.bindings[0].pdp1Refs.push("media.domain.not-in-pdp1");
  assert.ok(validate(staleRef).some((error) => error.includes("unsupported PDP-1 reference")));

  const futureSource = `${types}\nexport const NewlyAddedSchema = z.string();\nexport type NewlyAdded = z.infer<typeof NewlyAddedSchema>;\n`;
  assert.ok(validate(currentManifest, futureSource).some((error) => error.includes("missing schema binding: NewlyAddedSchema")));
  assert.ok(validate(currentManifest, futureSource).some((error) => error.includes("missing type binding: NewlyAdded")));

  const admittedSpecialized = structuredClone(currentManifest);
  const voiceTraining = admittedSpecialized.bindings.find((entry) => entry.schema === "VoiceTrainingRequestSchema");
  voiceTraining.role = "DOMAIN_OPERATION_INPUT_PROJECTION";
  voiceTraining.bindingStatus = "PROPOSAL_ROLE_ONLY";
  voiceTraining.pdp1Refs = ["media.operation.synthesis"];
  assert.ok(validate(admittedSpecialized).some((error) => error.includes("VoiceTrainingRequestSchema: source contract must remain NOT_ADMITTED")));

  const operationKind = currentManifest.bindings.find((entry) => entry.schema === "MediaOperationKindSchema");
  assert.equal(operationKind.role, "OPERATION_KIND_ENUM_PROJECTION");
  assert.equal(operationKind.bindingStatus, "PROPOSAL_ROLE_ONLY");
  assert.equal(operationKind.runtimeSupport, false);
  assert.equal(currentManifest.semanticOperationParity, "UNRESOLVED");

  const promotedEnum = structuredClone(currentManifest);
  promotedEnum.bindings.find((entry) => entry.schema === "MediaOperationKindSchema").role = "OPERATION_INPUT";
  assert.ok(validate(promotedEnum).some((error) => error.includes("MediaOperationKindSchema: unsupported role OPERATION_INPUT")));
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

test("keeps the two remaining parity findings open because current sources lack authoritative contracts", () => {
  const toolRegistry = readFileSync(".product-experience/pdp-3-product-experience/agent-tools/tool-registry.yaml", "utf8");
  const operations = readFileSync(".product-experience/pdp-1-domain-data/operations.yaml", "utf8");
  const conventions = readFileSync(".product-experience/pdp-2-design-interface-system/agent-tools/conventions.yaml", "utf8");
  const inputSchemaVersions = [...toolRegistry.matchAll(/schemaVersion: \{value: null, status: not-declared-by-handler\}/gu)];
  const resultSchemaVersions = [...toolRegistry.matchAll(/schemaVersion: \{value: null, status: not-declared-by-handler-or-delegate-contract\}/gu)];
  const unresolvedToolBindings = [...toolRegistry.matchAll(/operationBinding: \{value: null, status: unresolved-owner-and-operation-mapping\}/gu)];

  // Current handler observations do not define versioned canonical inputs or
  // outputs, and no PDP-1 mapping has been selected. Replacing the finding
  // with inferred contracts would invent owner-level semantics.
  assert.equal(inputSchemaVersions.length, 4);
  assert.equal(resultSchemaVersions.length, 4);
  assert.equal(unresolvedToolBindings.length, 4);
  assert.match(toolRegistry, /inputSchema: Media adapters enforce closed top-level key sets and local field validation, but these Java checks are not a published JSON Schema/u);
  assert.match(toolRegistry, /outputSchema: Successful delegate outputs receive bounded Draft 2020-12 validation/u);
  assert.match(toolRegistry, /does not bind the four YAML descriptors as canonical registered result schemas/u);
  assert.match(toolRegistry, /An empty schema remains unresolved/u);
  assert.match(conventions, /no tool is admitted, callable, or authorized by this convention/u);

  // The operation catalog explicitly remains proposal-only, with cross-
  // interface bindings and owner review pending. Those source facts make the
  // second finding a real semantic dependency, not a structural mismatch.
  assert.match(operations, /^scopeStatus: proposal-only;[\s\S]*?cross-interface-bindings-and-owner-review-pending$/mu);
  const parity = readFileSync(".product-experience/interface-parity/operation-parity.yaml", "utf8");
  assert.match(parity, /bindingStatus: names align to existing operation family names; handler schema\/authority contract and semantic-owner acceptance remain pending/u);
  assert.match(parity, /bindingStatus: 17-domain-operation-candidates-remain-proposed; eight-source-evidenced-health-or-metrics-identities-are-transport-only; ten-model-or-voice-administration-identities-are-provider-admin; eight-profile-adaptation-or-feedback-identities-remain-unresolved/u);

  const actual = analyzeContractParity(validStructuralInput({
    agentToolRegistry: toolRegistry,
    pdp1Operations: operations,
  }));
  assert.deepEqual(actual.gaps.filter((gap) => gap.startsWith("Agent Tool structural inventory") || gap.startsWith("semantic binding unresolved:")), [
    "Agent Tool structural inventory found 4 tools; operation bindings and complete input/result contract parity remain pending",
    "semantic binding unresolved: PDP-1 operations remain proposal-only;; structural identities are not accepted mappings",
  ]);
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

test("four SDK identities without OpenAPI routes have explicit NOT_ADMITTED parity dispositions", () => {
  const parity = readFileSync(".product-experience/interface-parity/operation-parity.yaml", "utf8");
  const dispositions = parseSdkOpenApiDispositions(parity);
  const unresolvedRouteMethods = [
    "media.sdk.legacy.AudioVideoClient.transcribe",
    "media.sdk.legacy.AudioVideoClient.synthesize",
    "media.sdk.retryOperation",
    "media.sdk.getOperationResult",
  ];
  const byIdentity = new Map(dispositions.map((entry) => [entry.identity, entry]));

  for (const identity of unresolvedRouteMethods) {
    assert.equal(byIdentity.get(identity)?.disposition, "NOT_ADMITTED", `${identity} must stay outside OpenAPI binding`);
  }
  assert.match(parity, /media\.sdk\.legacy\.AudioVideoClient\.transcribe[\s\S]*?semanticBinding: unresolved[\s\S]*?openApiBindingDisposition: NOT_ADMITTED/u);
  assert.match(parity, /media\.sdk\.legacy\.AudioVideoClient\.synthesize[\s\S]*?semanticBinding: unresolved[\s\S]*?openApiBindingDisposition: NOT_ADMITTED/u);
  assert.match(parity, /media\.sdk\.retryOperation[\s\S]*?semanticBinding: unresolved[\s\S]*?openApiBindingDisposition: NOT_ADMITTED/u);
  assert.match(parity, /media\.sdk\.getOperationResult[\s\S]*?semanticBinding: unresolved[\s\S]*?openApiBindingDisposition: NOT_ADMITTED/u);

  const reconciled = analyzeContractParity(validStructuralInput({
    sdkOperationIds: unresolvedRouteMethods,
    sdkOpenApiDispositions: dispositions.filter((entry) => unresolvedRouteMethods.includes(entry.identity)),
  }));
  assert.equal(reconciled.gaps.some((gap) => gap.startsWith("SDK operation has no explicit OpenAPI binding:")), false);
  assert.equal(reconciled.reconciledFindings.filter((item) => item.finding.startsWith("SDK operation has no explicit OpenAPI binding:")).length, 4);

  const missingOne = analyzeContractParity(validStructuralInput({
    sdkOperationIds: unresolvedRouteMethods,
    sdkOpenApiDispositions: dispositions.filter((entry) => entry.identity !== unresolvedRouteMethods[0]),
  }));
  assert.ok(missingOne.gaps.includes(`SDK operation has no explicit OpenAPI binding: ${unresolvedRouteMethods[0]}`));
});

test("binds the exact existing upload-session SDK read to the individually approved inspect-upload query only", () => {
  const parity = readFileSync(".product-experience/interface-parity/operation-parity.yaml", "utf8");
  const disposition = parseSdkOpenApiDispositions(parity).find((entry) => entry.identity === "media.sdk.getUploadSession");
  assert.deepEqual(disposition, {
    identity: "media.sdk.getUploadSession",
    type: "DOMAIN_QUERY",
    operationId: "getMediaUpload",
    ownerDecisionRef: ".product-experience/decision-log.md#PXD-040",
    disposition: "BOUNDED_CANONICAL_READ",
  });
  const source = [
    "export class MediaOperationClient {",
    "  public async getUploadSession(uploadId: string): Promise<CanonicalMediaUploadSessionObservation> {",
    "    return this.request(\"GET\", `/api/v1/artifacts/uploads/${encodeURIComponent(requestedUploadId)}`, undefined, parser, signal);",
    "  }",
    "}",
  ].join("\n");
  const routes = {
    openapi: "  /api/v1/artifacts/uploads/{uploadId}:\n    get:\n      operationId: getMediaUpload\n",
    runtimeManifest: JSON.stringify({ routes: [{ method: "GET", path: "/api/v1/artifacts/uploads/{uploadId}", operationId: "getMediaUpload" }] }),
    httpRegistry: '    method: GET\n    path: "/api/v1/artifacts/uploads/{uploadId}"\n    operationId: getMediaUpload\n',
  };
  const result = analyzeContractParity(validStructuralInput({
    ...routes,
    sdkOperationIds: ["media.sdk.getUploadSession"],
    sdkCalls: [{ source: "libs/audio-video-client/src/operations.ts", method: "GET", path: "/api/v1/artifacts/uploads/{parameter}" }],
    sdkSourceFiles: { "libs/audio-video-client/src/operations.ts": source },
    sdkOpenApiDispositions: [disposition],
  }));
  assert.equal(result.gaps.some((gap) => gap.startsWith("SDK operation has no explicit OpenAPI binding:")), false);
  assert.equal(result.reconciledFindings.filter((entry) => entry.disposition === "BOUNDED_CANONICAL_READ").length, 1);

  const wrongRoute = analyzeContractParity(validStructuralInput({
    ...routes,
    sdkOperationIds: ["media.sdk.getUploadSession"],
    sdkCalls: [{ source: "libs/audio-video-client/src/operations.ts", method: "GET", path: "/api/v1/artifacts/{parameter}" }],
    sdkSourceFiles: { "libs/audio-video-client/src/operations.ts": source },
    sdkOpenApiDispositions: [disposition],
  }));
  assert.ok(wrongRoute.gaps.includes("SDK operation has no explicit OpenAPI binding: media.sdk.getUploadSession"));

  const wrongAuthority = analyzeContractParity(validStructuralInput({
    ...routes,
    sdkOperationIds: ["media.sdk.getUploadSession"],
    sdkCalls: [{ source: "libs/audio-video-client/src/operations.ts", method: "GET", path: "/api/v1/artifacts/uploads/{parameter}" }],
    sdkSourceFiles: { "libs/audio-video-client/src/operations.ts": source },
    sdkOpenApiDispositions: [{ ...disposition, ownerDecisionRef: ".product-experience/decision-log.md#PXD-045" }],
  }));
  assert.ok(wrongAuthority.gaps.includes("SDK operation has no explicit OpenAPI binding: media.sdk.getUploadSession"));
});

test("maps each existing SDK upload command only to its exact method, active route, operation ID, and bounded decision", () => {
  const parity = readFileSync(".product-experience/interface-parity/operation-parity.yaml", "utf8");
  const dispositions = parseSdkOpenApiDispositions(parity);
  const cases = [
    {
      id: "media.sdk.createUploadSession", method: "POST", path: "/api/v1/artifacts/uploads", operationId: "beginMediaUpload",
      sourceMethod: "createUploadSession", source: 'public async createUploadSession() {\n    return this.request("POST", "/api/v1/artifacts/uploads", body);\n  }',
    },
    {
      id: "media.sdk.uploadPart", method: "PUT", path: "/api/v1/artifacts/uploads/{uploadId}/chunks/{chunkIndex}", operationId: "appendMediaChunk",
      sourceMethod: "uploadPart", source: 'public async uploadPart() {\n    return this.fetchImpl(`/api/v1/artifacts/uploads/${encodeURIComponent(uploadId)}/chunks/${chunkIndex}`, { method: "PUT" });\n  }',
    },
    {
      id: "media.sdk.completeUploadSession", method: "POST", path: "/api/v1/artifacts/uploads/{uploadId}/complete", operationId: "completeMediaUpload",
      sourceMethod: "completeUploadSession", source: 'public async completeUploadSession() {\n    return this.request("POST", `/api/v1/artifacts/uploads/${encodeURIComponent(uploadId)}/complete`, undefined);\n  }',
    },
  ];
  const createInput = (entry, overrides = {}) => {
    const disposition = dispositions.find(item => item.identity === entry.id);
    const source = `export class MediaOperationClient { ${entry.source} }`;
    return validStructuralInput({
      openapi: `  ${entry.path}:\n    ${entry.method.toLowerCase()}:\n      operationId: ${entry.operationId}\n`,
      runtimeManifest: JSON.stringify({ routes: [{ method: entry.method, path: entry.path, operationId: entry.operationId }] }),
      httpRegistry: `    method: ${entry.method}\n    path: "${entry.path}"\n    operationId: ${entry.operationId}\n`,
      sdkOperationIds: [entry.id],
      sdkCalls: [{ source: "libs/audio-video-client/src/operations.ts", method: entry.method, path: entry.path.replaceAll("{uploadId}", "{parameter}").replaceAll("{chunkIndex}", "{parameter}") }],
      sdkSourceFiles: { "libs/audio-video-client/src/operations.ts": source },
      sdkOpenApiDispositions: [disposition],
      ...overrides,
    });
  };
  for (const entry of cases) {
    const disposition = dispositions.find(item => item.identity === entry.id);
    assert.equal(disposition?.disposition, "BOUNDED_CANONICAL_OPERATION");
    assert.equal(disposition?.operationId, entry.operationId);
    assert.equal(disposition?.ownerDecisionRef, ".product-experience/decision-log.md#PXD-051");
    const result = analyzeContractParity(createInput(entry));
    assert.equal(result.gaps.some(gap => gap.startsWith("SDK operation has no explicit OpenAPI binding:")), false, entry.id);
    assert.equal(result.reconciledFindings.some(row => row.disposition === "BOUNDED_CANONICAL_OPERATION"), true, entry.id);

    const swapped = analyzeContractParity(createInput(entry, {
      sdkOpenApiDispositions: [{ ...disposition, operationId: cases.find(other => other !== entry).operationId }],
    }));
    assert.ok(swapped.gaps.includes(`SDK operation has no explicit OpenAPI binding: ${entry.id}`), `${entry.id} rejects another existing operation ID`);

    const wrongRoute = analyzeContractParity(createInput(entry, {
      sdkCalls: [{ source: "libs/audio-video-client/src/operations.ts", method: "GET", path: "/api/v1/artifacts/{parameter}" }],
    }));
    assert.ok(wrongRoute.gaps.includes(`SDK operation has no explicit OpenAPI binding: ${entry.id}`), `${entry.id} rejects route/method drift`);

    const wrongAuthority = analyzeContractParity(createInput(entry, {
      sdkOpenApiDispositions: [{ ...disposition, ownerDecisionRef: ".product-experience/decision-log.md#PXD-045" }],
    }));
    assert.ok(wrongAuthority.gaps.includes(`SDK operation has no explicit OpenAPI binding: ${entry.id}`), `${entry.id} rejects unrelated owner decision`);
  }
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

test("SDK source discovery includes a third recursively discovered public class source", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "ghatana-media-sdk-sources-"));
  try {
    const src = join(temporaryRoot, "libs/audio-video-client/src");
    mkdirSync(join(src, "extra"), { recursive: true });
    writeFileSync(join(src, "index.ts"), "export class MainClient {\n  public open(): void {}\n}\n");
    writeFileSync(join(src, "operations.ts"), "export class OperationClient {\n  public submit(): void {}\n}\n");
    writeFileSync(join(src, "extra", "derived.ts"), "export class DerivedClient {\n  public inspect(): void {}\n}\n");

    const discovered = discoverSdkSourceFiles(temporaryRoot);
    assert.deepEqual(Object.keys(discovered), [
      "libs/audio-video-client/src/extra/derived.ts",
      "libs/audio-video-client/src/index.ts",
      "libs/audio-video-client/src/operations.ts",
    ]);
    const registry = "  - id: media.sdk.derived.inspect\n    method: inspect\n    visibility: public\n    source: libs/audio-video-client/src/extra/derived.ts\n    declaringClass: DerivedClient\n";
    assert.deepEqual(parseSdkRegistryMethods(registry, discovered), [{
      id: "media.sdk.derived.inspect",
      method: "inspect",
      source: "libs/audio-video-client/src/extra/derived.ts",
      declaringClass: "DerivedClient",
    }]);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("typed UI action dispositions reconcile exactly to the 146 source identities", () => {
  const actionRegistry = readFileSync(".product-experience/pdp-3-product-experience/action-registry.yaml", "utf8");
  const parity = readFileSync(".product-experience/interface-parity/operation-parity.yaml", "utf8");
  const operations = readFileSync(".product-experience/pdp-1-domain-data/operations.yaml", "utf8");
  const sourceIds = [...actionRegistry.matchAll(/^- id: (media\.action\.[^\n]+)/gmu)].map((m) => m[1]);
  const ui = parity.split("\ntypedUiActionDispositions:\n")[1];
  assert.ok(ui, "typed UI action disposition section is present");
  assert.match(ui, /^  denominator: 146$/mu);
  const entriesText = ui.split("\n  entries:\n")[1].split(/\n(?=[a-zA-Z][\w-]*:)/u)[0];
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
    CLIENT_ONLY: 48, DOMAIN_COMMAND: 9, DOMAIN_QUERY: 49,
    NOT_ADMITTED: 29, NAVIGATION_OR_PRESENTATION: 11,
  });
  for (const [actionId, operationId] of [
    ["media.action.request-transcription", "media.operation.transcription-submission"],
    ["media.action.review-transcript", "media.operation.transcript-version-read"],
    ["media.action.correct-caption", "media.operation.caption-draft-write"],
    ["media.action.align-caption-timing", "media.operation.caption-draft-write"],
    ["media.action.save-caption-version", "media.operation.caption-version-write"],
    ["media.action.compare-caption-versions", "media.operation.caption-version-read"],
  ]) {
    const entry = entries.find(([, identity]) => identity === actionId)?.[2];
    assert.match(entry, new RegExp(`^    operationRef: ${operationId}$`, "mu"));
  }
});

test("the two UI action binding views reconcile exact PDP-1 refs and preserve every other action unresolved", () => {
  const actionRegistry = readFileSync(".product-experience/pdp-3-product-experience/action-registry.yaml", "utf8");
  const parity = readFileSync(".product-experience/interface-parity/operation-parity.yaml", "utf8");
  const operations = readFileSync(".product-experience/pdp-1-domain-data/operations.yaml", "utf8");
  const sourceIds = [...actionRegistry.matchAll(/^- id: (media\.action\.[^\n]+)/gmu)].map((match) => match[1]);
  const sourceSection = parity.match(/- surface: UI action registry\n([\s\S]*?)\n  - surface: HTTP/u)?.[1];
  assert.ok(sourceSection, "source-denominator UI action section is present");
  const sourceDenominatorSection = operations.match(/uiProductActions:\n([\s\S]*?)\n  httpOperations:/u)?.[1];
  assert.ok(sourceDenominatorSection, "PDP-1 source denominator and exact refs are present");
  const typedSection = parity.match(/\ntypedUiActionDispositions:\n([\s\S]*?)(?=\n[a-zA-Z][\w-]*:)/u)?.[1];
  assert.ok(typedSection, "typed UI action section ends at the next top-level artifact section");
  assert.ok(typedSection, "typed UI action section is present");

  const parseCounts = (section) => {
    const match = section.match(/operationBindingCounts:\s*\{([^}]+)\}/u)?.[1]
      ?? section.match(/operationBindingCounts:\s*\n([\s\S]*?)(?=\n\s+dispositionCounts:)/u)?.[1];
    assert.ok(match, "operation binding counts are explicit");
    return Object.fromEntries([...match.matchAll(/(mappedProposal|ambiguous|unresolved):\s*(\d+)/gu)]
      .map(([, key, value]) => [key, Number(value)]));
  };
  const sourceCounts = parseCounts(sourceSection);
  const typedCounts = parseCounts(typedSection);
  assert.deepEqual(sourceCounts, { mappedProposal: 14, ambiguous: 0, unresolved: 132 });
  assert.deepEqual(typedCounts, sourceCounts, "both views of the UI action denominator agree");
  assert.match(sourceSection, /^\s+denominator: 146$/mu);
  assert.match(typedSection, /^  denominator: 146$/mu);

  const explicitOperationIds = new Map([...sourceDenominatorSection.matchAll(/^      (media\.action\.[^\n:]+): (media\.operation\.[^\n]+)$/gmu)]
    .map((match) => [match[1], match[2]]));
  const typedEntries = typedSection.trimEnd().split(/(?=^  - identity: )/mu).flatMap((body) => {
    const identity = body.match(/^  - identity: ([^\n]+)/mu)?.[1];
    if (!identity) return [];
    const operationRef = body.match(/^    operationRef: (media\.operation\.[^\n]+)$/mu)?.[1];
    const type = body.match(/^    type: ([A-Z_]+)$/mu)?.[1];
    return [{ identity, operationRef, type, body }];
  });
  const typedRefs = new Map(typedEntries.filter((entry) => entry.operationRef).map(({ identity, operationRef }) => [identity, operationRef]));
  assert.deepEqual([...typedRefs].sort(), [...explicitOperationIds].sort(), "typed refs match only exact source-denominator mappings");
  assert.equal(typedRefs.size, 14);
  assert.equal(explicitOperationIds.size, 14);
  assert.match(sourceDenominatorSection, /^    ambiguousOperationCandidates: \[\]$/mu);
  const ownerAssociations = sourceSection.match(/ownerApprovedActionIntentAssociations:\n([\s\S]*?)(?=\n    ambiguous:)/u)?.[1] ?? "";
  const ownerAssociationIds = [...ownerAssociations.matchAll(/media\.action\.[a-z0-9.-]+/gu)].filter((match) => match[0] !== "media.action").map((match) => match[0]);
  const expectedOwnerAssociations = [
    "media.action.request-transcription", "media.action.review-transcript", "media.action.correct-caption",
    "media.action.align-caption-timing", "media.action.save-caption-version", "media.action.compare-caption-versions",
  ];
  assert.deepEqual([...new Set(ownerAssociationIds)].sort(), [...expectedOwnerAssociations].sort());
  assert.match(parity, /^  accepted: 0$/mu, "cross-interface accepted binding count remains zero");
  assert.match(ownerAssociations, /semantic-intent-association-only/u);
  for (const identity of expectedOwnerAssociations) {
    const entry = typedEntries.find((candidate) => candidate.identity === identity);
    assert.equal(entry?.operationRef, explicitOperationIds.get(identity));
    assert.match(entry?.body ?? "", /operationAssociationStatus: owner-approved-semantic-intent-only; PXD-029/u);
  }

  const sourceDispositionText = sourceSection.match(/dispositionCounts:\s*\{([^}]+)\}/u)?.[1] ?? "";
  const sourceDispositionCounts = Object.fromEntries([...sourceDispositionText.matchAll(/([A-Z_]+):\s*(\d+)/gu)]
    .map((match) => [match[1], Number(match[2])]));
  const typedDispositionCounts = typedEntries.reduce((counts, entry) => {
    counts[entry.type] = (counts[entry.type] ?? 0) + 1;
    return counts;
  }, {});
  assert.deepEqual(typedDispositionCounts, sourceDispositionCounts, "both views of action dispositions agree");

  const unresolvedText = sourceDenominatorSection.split("    unresolvedActionIds:\n")[1] ?? "";
  const unresolvedIds = [...unresolvedText.matchAll(/^      - (media\.action\.[^\n]+)$/gmu)].map(([, id]) => id);
  const expectedUnresolved = sourceIds.filter((identity) => !explicitOperationIds.has(identity));
  assert.equal(unresolvedIds.length, 132);
  assert.equal(new Set(unresolvedIds).size, 132);
  assert.deepEqual([...unresolvedIds].sort(), [...expectedUnresolved].sort(), "all identities without exact refs remain unresolved");
  assert.deepEqual(typedEntries.filter((entry) => !entry.operationRef).map((entry) => entry.identity).sort(), [...expectedUnresolved].sort());

  for (const [identity, operationRef] of typedRefs) {
    const operationBlock = operations.match(new RegExp(`^  - id: ${operationRef}\\n([\\s\\S]*?)(?=^  - id: media\\.operation\\.|^channelFamilies:)`, "mu"))?.[1];
    assert.ok(operationBlock, `${identity} points to a current PDP-1 operation`);
    assert.match(operationBlock, new RegExp(identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${identity} is present in that operation's actionRefs`);
  }
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

test("semantic candidates never contradict the HTTP and gRPC typed role dispositions", () => {
  const parity = readFileSync(".product-experience/interface-parity/operation-parity.yaml", "utf8");
  const operations = readFileSync(".product-experience/pdp-1-domain-data/operations.yaml", "utf8");
  const httpSurface = parity.match(/- surface: HTTP\n([\s\S]*?)(?=\n  - surface: gRPC)/u)?.[1];
  const grpcSurface = parity.match(/- surface: gRPC\n([\s\S]*?)(?=\n  - surface: CLI fixture commands)/u)?.[1];
  const typed = parity.match(/typedInterfaceIdentityDispositions:\n([\s\S]*?)(?=\ncompatibilityRouteFindings:)/u)?.[1];
  const typedHttp = typed?.match(/^  http:\n([\s\S]*?)(?=^  grpc:)/mu)?.[1];
  const typedGrpc = typed?.match(/^  grpc:\n([\s\S]*?)(?=^  cliFixture:)/mu)?.[1];
  assert.ok(httpSurface && grpcSurface && typedHttp && typedGrpc, "HTTP/gRPC source and typed role sections exist");

  const inlineList = (text, field) => {
    const body = text.match(new RegExp(`^    ${field}: \\[([^\\]]*)\\]$`, "mu"))?.[1] ?? "";
    return body.split(",").map((value) => value.trim()).filter(Boolean);
  };
  const candidateIds = (surface) => {
    const candidateBlock = surface.match(/proposedSemanticCandidates:\n([\s\S]*?)(?=\n    unresolved:|\n    dispositionCounts:)/u)?.[1] ?? "";
    return [...candidateBlock.matchAll(/\[([^\]]*)\]/gu)].flatMap((match) => match[1].split(",").map((id) => id.trim()));
  };
  const httpRoleOnly = inlineList(typedHttp, "transportOnly");
  const sourceTransportOnlyBlock = httpSurface.match(/sourceBackedNonOperationDispositions:\n      TRANSPORT_ONLY:\n([\s\S]*?)(?=\n    dispositionCounts:)/u)?.[1] ?? "";
  const sourceTransportOnly = [...sourceTransportOnlyBlock.matchAll(/^        - ([^\n]+)$/gmu)].map(([, id]) => id);
  const httpUnresolved = inlineList(httpSurface, "unresolved");
  assert.deepEqual(httpRoleOnly.sort(), sourceTransportOnly.sort(), "typed HTTP transport roles reconcile to exact source dispositions");
  assert.deepEqual(httpUnresolved, ["getMediaProviders"], "provider inventory remains unresolved as a potential product query");
  assert.equal(httpRoleOnly.some((identity) => candidateIds(httpSurface).includes(identity)), false,
    "transport-only HTTP identities cannot be proposed as domain operations");
  assert.match(httpSurface, /dispositionCounts: \{mappedProposal: 13, boundedDefinition: 5, transportOnly: 8, unresolved: 1\}/u);

  const grpcRoleOnly = [...inlineList(typedGrpc, "transportOnly"), ...inlineList(typedGrpc, "providerAdmin")];
  const sourceGrpcNonOperationBlock = grpcSurface.match(/sourceBackedNonOperationDispositions:\n([\s\S]*?)(?=\n    dispositionCounts:)/u)?.[1] ?? "";
  const sourceGrpcNonOperation = [...sourceGrpcNonOperationBlock.matchAll(/^        - ([^\n]+)$/gmu)].map(([, id]) => id);
  assert.deepEqual(grpcRoleOnly.sort(), sourceGrpcNonOperation.sort(), "typed gRPC transport/admin roles reconcile to exact source dispositions");
  const grpcCandidateIds = candidateIds(grpcSurface);
  const grpcUnresolvedRoleIds = [...grpcSurface.matchAll(/^      (\w+): \[([^\]]*)\]$/gmu)]
    .flatMap(([, service, methods]) => methods.split(",").filter((method) => method.trim()).map((method) => `${service}.${method.trim()}`));
  assert.equal(grpcUnresolvedRoleIds.length, 8, "profile/adaptation/feedback methods remain unresolved explicitly");
  assert.equal(grpcRoleOnly.some((identity) => grpcCandidateIds.includes(identity)), false,
    "transport-only/provider-admin gRPC identities cannot be proposed as domain operations");
  assert.match(grpcSurface, /dispositionCounts: \{mappedProposal: 17, transportOnly: 8, providerAdmin: 10, unresolved: 8\}/u);

  const grpcSource = operations.match(/^  grpcRpcs:\n([\s\S]*?)(?=^  cliSimulationCommands:)/mu)?.[1];
  assert.ok(grpcSource, "PDP-1 gRPC source observation section exists");
  const memberProposals = grpcSource.match(/^    explicitMemberOperationIds:\n([\s\S]*?)(?=^    unresolvedIdentitiesByService:)/mu)?.[1] ?? "";
  for (const identity of grpcRoleOnly) {
    assert.doesNotMatch(memberProposals, new RegExp(`^      ${identity.replace(".", "\\.")}:`, "mu"),
      `${identity} must not carry a proposed logical-operation binding`);
  }
});

// Source-level owner status cannot substitute for per-operation semantics.
test("changing global operation scope to accepted cannot bypass exact record review", () => {
  const result = analyzeContractParity(validStructuralInput({
    pdp1Operations: 'scopeStatus: accepted\nbindingStatus: accepted\noperations:\n  - id: media.operation.fake\n    scopeStatus: accepted\n',
  }));
  assert.equal(result.semanticStatus, 'UNRESOLVED');
  assert.equal(result.operationAcceptance.complete, false);
  assert.ok(result.gaps.some(gap => gap.startsWith('semantic binding unresolved:')));
});
test("retired unsafe retry remains in historical finding census only while source proves no dispatch", () => {
  const source = readFileSync('libs/audio-video-client/src/operations.ts', 'utf8');
  const input = validStructuralInput({sdkSourceFiles: {'libs/audio-video-client/src/operations.ts': source}});
  const result = analyzeContractParity(input);
  assert.equal(result.retiredFindings.length, 5);
  assert.equal(result.historicalFindingCount, result.historicalObservedFindingCount + 5);
  const unsafe = {...input, sdkSourceFiles: {'libs/audio-video-client/src/operations.ts': source.replace('throw new MediaOperationNotAdmittedError("media.operation.retry");', 'return this.request("POST", "/retry");')}};
  assert.equal(analyzeContractParity(unsafe).retiredFindings.some(row => row.path.endsWith(':retry')), false);
  assert.equal(analyzeContractParity(unsafe).retiredFindings.length, 4);
  const legacyArtifact = {...input, sdkSourceFiles: {'libs/audio-video-client/src/operations.ts': source.replace('`/api/v1/artifacts/${', '`/api/v1/media/artifacts/${')}};
  assert.equal(analyzeContractParity(legacyArtifact).retiredFindings.some(row => row.path.includes('/artifacts/')), false);
  assert.equal(analyzeContractParity(legacyArtifact).retiredFindings.length, 4);
  const legacyUpload = {...input, sdkSourceFiles: {'libs/audio-video-client/src/operations.ts': source.replaceAll('/api/v1/artifacts/uploads', '/api/v1/media/uploads')}};
  assert.equal(analyzeContractParity(legacyUpload).retiredFindings.length, 2);
});

test("live source finding census keeps unresolved owner gaps and retired routes explicit", () => {
  const result = analyzeContractParity(collectLiveInput());
  // The historical source census remains 47 findings: 45 dispositioned and
  // two open. New typed contract validation gaps stay visible in the current
  // result without changing that historical program truth.
  assert.equal(result.historicalObservedFindingCount, 47);
  assert.equal(result.observedFindingCount, 47);
  assert.equal(result.reconciledFindings.length, 45);
  assert.equal(result.gaps.length, 2);
  assert.equal(result.historicalFindingCount, 52);
  assert.equal(result.historicalDispositionedCount, 50);
  assert.equal(result.historicalUnresolvedCount, 2);
  assert.equal(result.typedContractGaps.length, 0);
  assert.equal(result.retiredFindings.length, 5);
  assert.match(result.gaps.join("\n"), /Agent Tool structural inventory found 4 tools/u);
  assert.match(result.gaps.join("\n"), /PDP-1 operations remain proposal-only/u);
});
