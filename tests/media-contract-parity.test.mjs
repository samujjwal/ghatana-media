import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyzeContractParity, parseNotAdmittedSdkRoutes, parseSdkHttpCalls, parseSdkRegistryMethods, validateTypedContractBindings } from "../scripts/check-media-contract-parity.mjs";

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
  const typedSection = parity.split("\ntypedUiActionDispositions:\n")[1];
  assert.ok(typedSection, "typed UI action section is present");

  const parseCounts = (section) => {
    const match = section.match(/operationBindingCounts:\s*\{mappedProposal:\s*(\d+),\s*ambiguous:\s*(\d+),\s*unresolved:\s*(\d+)\}/u)
      ?? section.match(/operationBindingCounts:\s*\n\s+mappedProposal:\s*(\d+)\n\s+ambiguous:\s*(\d+)\n\s+unresolved:\s*(\d+)/u);
    assert.ok(match, "operation binding counts are explicit");
    return { mappedProposal: Number(match[1]), ambiguous: Number(match[2]), unresolved: Number(match[3]) };
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
    return [{ identity, operationRef, type }];
  });
  const typedRefs = new Map(typedEntries.filter((entry) => entry.operationRef).map(({ identity, operationRef }) => [identity, operationRef]));
  assert.deepEqual([...typedRefs].sort(), [...explicitOperationIds].sort(), "typed refs match only exact source-denominator mappings");
  assert.equal(typedRefs.size, 14);
  assert.equal(explicitOperationIds.size, 14);
  assert.match(sourceDenominatorSection, /^    ambiguousOperationCandidates: \[\]$/mu);

  const sourceDispositionText = sourceSection.match(/dispositionCounts:\s*\{([^}]+)\}/u)?.[1] ?? "";
  const sourceDispositionCounts = Object.fromEntries([...sourceDispositionText.matchAll(/([A-Z_]+):\s*(\d+)/gu)]
    .map((match) => [match[1], Number(match[2])]));
  const typedDispositionCounts = typedEntries.reduce((counts, entry) => {
    counts[entry.type] = (counts[entry.type] ?? 0) + 1;
    return counts;
  }, {});
  assert.deepEqual(typedDispositionCounts, sourceDispositionCounts, "both views of action dispositions agree");

  const unresolvedText = sourceDenominatorSection.match(/^    unresolvedActionIds: \[([^\]]*)\]$/mu)?.[1] ?? "";
  const unresolvedIds = [...unresolvedText.matchAll(/media\.action\.[a-z0-9.-]+/gu)].map((match) => match[0]);
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
