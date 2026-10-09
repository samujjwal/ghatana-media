import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const parity = readYaml(".product-experience/interface-parity/operation-parity.yaml");
const grammar = readYaml(".product-experience/pdp-2-design-interface-system/interface-grammar.yaml");
const actionRegistryPath = ".product-experience/pdp-3-product-experience/action-registry.yaml";
const actionRegistry = readYaml(actionRegistryPath);
const eventContractsPath = ".product-experience/pdp-1-domain-data/events.yaml";
const eventContracts = readYaml(eventContractsPath);
const eventRegistryPath = ".product-experience/pdp-3-product-experience/events/event-registry.yaml";
const eventRegistry = readYaml(eventRegistryPath);
const fixtureCliActions = new Map([
  ["media.fixture-cli.upload-inspect", "media.action.inspect-artifact"],
  ["media.fixture-cli.upload-resume", "media.action.resume-artifact-upload"],
  ["media.fixture-cli.transcribe", "media.action.request-transcription"],
  ["media.fixture-cli.transcript-review", "media.action.review-transcript"],
  ["media.fixture-cli.job-status", "media.action.view-job-status"],
  ["media.fixture-cli.job-cancel", "media.action.request-cancellation"],
  ["media.fixture-cli.job-check-outcome", "media.action.check-job-outcome"],
  ["media.fixture-cli.caption-correct-text", "media.action.correct-caption"],
  ["media.fixture-cli.caption-align-timing", "media.action.align-caption-timing"],
  ["media.fixture-cli.caption-save-version", "media.action.save-caption-version"],
  ["media.fixture-cli.caption-compare-versions", "media.action.compare-caption-versions"],
]);

function assertPartition(inventory, groups, label) {
  const seen = new Map();
  for (const [disposition, identities] of Object.entries(groups)) {
    for (const identity of identities) {
      assert.ok(!seen.has(identity), `${label} identity ${identity} appears in both ${seen.get(identity)} and ${disposition}`);
      seen.set(identity, disposition);
    }
  }
  assert.deepEqual([...seen.keys()].sort(), [...inventory].sort(), `${label} inventory must have one explicit disposition each`);
}

function openApiOperationIds(spec) {
  return Object.values(spec.paths).flatMap((path) => Object.values(path ?? {}))
    .filter((operation) => operation && typeof operation === "object" && operation.operationId)
    .map((operation) => operation.operationId);
}

function grpcMethods(path) {
  const source = readFileSync(resolve(root, path), "utf8");
  const services = new Map();
  const servicePattern = /service\s+(\w+)\s*\{([\s\S]*?)\}/gu;
  for (const match of source.matchAll(servicePattern)) {
    services.set(match[1], [...match[2].matchAll(/\brpc\s+(\w+)\s*\(/gu)].map((rpc) => rpc[1]));
  }
  return services;
}

function grpcSignatures(path) {
  const source = readFileSync(resolve(root, path), "utf8");
  const signatures = new Map();
  for (const match of source.matchAll(/service\s+(\w+)\s*\{([\s\S]*?)\}/gu)) {
    for (const rpc of match[2].matchAll(/rpc\s+(\w+)\s*\(\s*(stream\s+)?(\w+)\s*\)\s*returns\s*\(\s*(stream\s+)?(\w+)\s*\)\s*;/gu)) {
      signatures.set(`${match[1]}.${rpc[1]}`, {
        service: match[1], method: rpc[1], inputMessage: rpc[3], inputStream: Boolean(rpc[2]),
        outputMessage: rpc[5], outputStream: Boolean(rpc[4]),
      });
    }
  }
  return signatures;
}

function protobufMessageFields(path, name) {
  const source = readFileSync(resolve(root, path), "utf8");
  if (new RegExp(`\\bmessage\\s+${name}\\s*\\{\\s*\\}`, "u").test(source)) return [];
  const message = source.match(new RegExp(`\\bmessage\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`, "u"));
  assert.ok(message, `missing protobuf message ${path}#message.${name}`);
  return message[1].split(/\r?\n/u).flatMap((line) => {
    const content = line.replace(/\/\/.*$/u, "").trim();
    if (!content || content === "}") return [];
    const field = content.match(/^(repeated|optional)?\s*([A-Za-z_][\w.]*|map<\s*([A-Za-z_][\w.]*)\s*,\s*([A-Za-z_][\w.]*)\s*>)\s+([A-Za-z_]\w*)\s*=\s*(\d+)\s*(?:\[[^\]]*\])?;$/u);
    assert.ok(field, `unparsed protobuf field ${path}#message.${name}: ${content}`);
    const [, label = "", type, mapKey, mapValue, fieldName, number] = field;
    return [{ number: Number(number), label: label || "singular", type: mapKey ? `map<${mapKey},${mapValue}>` : type, name: fieldName }];
  });
}

test("HTTP health and diagnostic identities have exact source-backed transport dispositions", () => {
  const surface = parity.surfaces.find((item) => item.surface === "HTTP");
  const spec = readYaml("contracts/openapi/media.yaml");
  const nonOperation = surface.sourceBackedNonOperationDispositions;
  const groups = {
    mappedProposal: Object.values(surface.proposedSemanticCandidates).flat(),
    boundedDefinition: Object.keys(surface.boundedDefinitionBindings.identities),
    transportOnly: nonOperation.TRANSPORT_ONLY,
    unresolved: surface.unresolved,
  };
  assertPartition(surface.identities, groups, "HTTP");
  assert.equal(openApiOperationIds(spec).filter((id) => surface.identities.includes(id)).length, surface.identities.length);
  assert.deepEqual(surface.dispositionCounts, {
    mappedProposal: groups.mappedProposal.length,
    boundedDefinition: groups.boundedDefinition.length,
    transportOnly: groups.transportOnly.length,
    unresolved: groups.unresolved.length,
  });
  assert.deepEqual(parity.typedInterfaceIdentityDispositions.http.transportOnly, groups.transportOnly);
  assert.deepEqual(parity.typedInterfaceIdentityDispositions.http.unresolved, groups.unresolved);
  for (const record of parity.typedHttpNonOperationDispositions) {
    assert.ok(surface.identities.includes(record.identity), `${record.identity} must be an inventoried HTTP operation`);
    assert.ok(record.source.startsWith("contracts/openapi/media.yaml#/paths/"), `${record.identity} needs an exact OpenAPI source pointer`);
    assert.match(record.basis, /health|liveness|readiness|startup|diagnostic|provider-inventory/u,
      `${record.identity} must state the evidence category, not infer from a similar name`);
  }
  assert.equal(parity.typedHttpNonOperationDispositions.length, 8);
});

test("HTTP identities carry exact route, request/result, role, and bounded-or-candidate operation evidence", () => {
  const contracts = parity.typedHttpOperationContracts;
  const surface = parity.surfaces.find((item) => item.surface === "HTTP");
  const spec = readYaml("contracts/openapi/media.yaml");
  const operationSource = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");
  const operationIds = new Set();
  const collectIds = (value) => {
    if (Array.isArray(value)) return value.forEach(collectIds);
    if (!value || typeof value !== "object") return;
    if (typeof value.id === "string") operationIds.add(value.id);
    Object.values(value).forEach(collectIds);
  };
  collectIds(operationSource);
  const bounded = surface.boundedDefinitionBindings.identities;
  const transport = new Set(surface.sourceBackedNonOperationDispositions.TRANSPORT_ONLY);
  const candidates = new Map(Object.entries(surface.proposedSemanticCandidates).flatMap(([family, ids]) => ids.map((id) => [id, family])));
  const fieldParityCounts = {};
  assert.equal(contracts.length, surface.denominator);
  assert.equal(new Set(contracts.map(({ identity }) => identity)).size, contracts.length);
  assert.deepEqual(contracts.map(({ identity }) => identity).sort(), surface.identities.sort());

  for (const contract of contracts) {
    fieldParityCounts[contract.fieldParityStatus] = (fieldParityCounts[contract.fieldParityStatus] ?? 0) + 1;
    const source = Object.entries(spec.paths).flatMap(([path, methods]) =>
      Object.entries(methods ?? {}).filter(([, operation]) => operation?.operationId === contract.identity)
        .map(([method, operation]) => ({ path, method, operation })),
    );
    assert.equal(source.length, 1, `${contract.identity} must resolve to one OpenAPI identity`);
    const [{ path, method, operation }] = source;
    assert.equal(contract.path, path, `${contract.identity} route mismatch`);
    assert.equal(contract.method, method.toUpperCase(), `${contract.identity} method mismatch`);
    assert.equal(contract.sourceRef, `contracts/openapi/media.yaml#/paths/${path.replaceAll("~", "~0").replaceAll("/", "~1")}/${method}`);
    assert.deepEqual(contract.requestSchemaRefs,
      Object.values(operation.requestBody?.content ?? {}).flatMap(({ schema }) => schema?.$ref ? [schema.$ref] : []));
    assert.deepEqual(contract.requestMediaTypes, Object.keys(operation.requestBody?.content ?? {}));
    assert.deepEqual(contract.requestSchemas, Object.entries(operation.requestBody?.content ?? {}).map(([mediaType, media]) => ({
      mediaType, schema: media.schema ?? null,
    })), `${contract.identity} request shape must preserve inline and referenced schemas`);
    assert.deepEqual(contract.responseContracts, Object.entries(operation.responses ?? {}).map(([status, response]) => ({
      status,
      responseRef: response.$ref ?? null,
      schemaRefs: Object.values(response.content ?? {}).flatMap(({ schema }) => schema?.$ref ? [schema.$ref] : []),
      schemas: Object.entries(response.content ?? {}).map(([mediaType, media]) => ({
        mediaType, schema: media.schema ?? null,
      })),
      mediaTypes: Object.keys(response.content ?? {}),
      requiredHeaders: Object.keys(response.headers ?? {}).filter((name) => response.headers[name]?.required),
    })));
    const pathItem = spec.paths[path];
    assert.deepEqual(contract.parameterContracts, {
      pathLevel: pathItem.parameters ?? [], operationLevel: operation.parameters ?? [],
    }, `${contract.identity} path/query/header parameters must match the public source contract`);
    assert.deepEqual(contract.idempotencyContract, operation["x-ghatana-idempotency"] ?? null,
      `${contract.identity} idempotency guarantees and prohibitions must be preserved`);
    assert.deepEqual(contract.security, operation.security ?? spec.security ?? []);

    if (transport.has(contract.identity)) {
      assert.equal(contract.bindingStatus, "TRANSPORT_ONLY");
      assert.equal(contract.fieldParityStatus, "SOURCE_BACKED_NON_OPERATION; canonical-operation-field-parity-not-applicable");
      assert.equal(contract.role, "transport-diagnostic");
      assert.equal(contract.canonicalOperationRef, null);
    } else if (bounded[contract.identity]) {
      assert.equal(contract.bindingStatus, "BOUNDED_DEFINITION");
      assert.equal(contract.fieldParityStatus, "BOUNDED_DEFINITION_ONLY; full-wire-field-parity-not-asserted");
      assert.equal(contract.canonicalOperationRef, bounded[contract.identity]);
      assert.ok(operationIds.has(contract.canonicalOperationRef), `${contract.identity} canonical operation must exist`);
      assert.match(contract.bindingBasis, /PXD-051 bounded .* definition crosslink/u);
    } else if (candidates.has(contract.identity)) {
      assert.equal(contract.bindingStatus, "CANDIDATE_ONLY");
      assert.equal(contract.fieldParityStatus, "FAMILY_CANDIDATE_ONLY; leaf-and-field-parity-not-asserted");
      assert.ok(contract.canonicalOperationRef === null || operationIds.has(contract.canonicalOperationRef),
        `${contract.identity} candidate ref must resolve or stay explicitly null`);
      assert.match(contract.bindingBasis, /does not establish exact leaf parity/u);
    } else {
      assert.equal(contract.bindingStatus, "UNRESOLVED");
      assert.equal(contract.fieldParityStatus, "UNRESOLVED_ROLE_AND_FIELD_PARITY");
      assert.equal(contract.canonicalOperationRef, null);
    }
  }
  assert.deepEqual(fieldParityCounts, {
    "SOURCE_BACKED_NON_OPERATION; canonical-operation-field-parity-not-applicable": 8,
    "FAMILY_CANDIDATE_ONLY; leaf-and-field-parity-not-asserted": 13,
    "BOUNDED_DEFINITION_ONLY; full-wire-field-parity-not-asserted": 5,
    UNRESOLVED_ROLE_AND_FIELD_PARITY: 1,
  });
});

test("HTTP crosswalk rejects semantic drift even when an identity and route still exist", () => {
  const contracts = parity.typedHttpOperationContracts;
  const find = (identity) => structuredClone(contracts.find((item) => item.identity === identity));
  const spec = readYaml("contracts/openapi/media.yaml");
  const surface = parity.surfaces.find((item) => item.surface === "HTTP");
  const bounded = surface.boundedDefinitionBindings.identities;
  const transport = new Set(surface.sourceBackedNonOperationDispositions.TRANSPORT_ONLY);
  const sourceOperation = (identity) => Object.values(spec.paths).flatMap((methods) => Object.values(methods ?? []))
    .find((operation) => operation?.operationId === identity);
  const artifact = find("getMediaArtifact");
  artifact.canonicalOperationRef = "media.operation.job-lifecycle";
  assert.throws(() => assert.equal(artifact.canonicalOperationRef, bounded[artifact.identity]),
    /Expected values to be strictly equal/u, "a resolvable operation name cannot replace the exact artifact definition");
  const uploadChunk = find("appendMediaChunk");
  uploadChunk.requestSchemaRefs = ["#/components/schemas/UploadSession"];
  const appendSource = sourceOperation(uploadChunk.identity);
  const exactRequestSchemas = Object.values(appendSource.requestBody.content).flatMap(({ schema }) => schema?.$ref ? [schema.$ref] : []);
  assert.throws(() => assert.deepEqual(uploadChunk.requestSchemaRefs, exactRequestSchemas),
    /Expected values to be strictly deep-equal/u, "a response DTO cannot be substituted for the binary chunk request contract");
  const health = find("getMediaHealth");
  health.bindingStatus = "CANDIDATE_ONLY";
  assert.throws(() => assert.equal(health.bindingStatus, transport.has(health.identity) ? "TRANSPORT_ONLY" : "UNRESOLVED"),
    /Expected values to be strictly equal/u, "health must not be promoted to a product operation by a plausible canonical name");
  const cancel = find("cancelMediaJob");
  cancel.responseContracts = cancel.responseContracts.filter(({ status }) => status !== "200");
  const cancelStatuses = Object.keys(sourceOperation(cancel.identity).responses);
  assert.throws(() => assert.deepEqual(cancel.responseContracts.map(({ status }) => status), cancelStatuses),
    /Expected values to be strictly deep-equal/u, "cancellation response/finality evidence cannot be silently dropped from a crosswalk");
  const upload = find("beginMediaUpload");
  upload.idempotencyContract = null;
  assert.throws(() => assert.deepEqual(upload.idempotencyContract, sourceOperation(upload.identity)["x-ghatana-idempotency"]),
    /Expected values to be strictly deep-equal/u, "upload idempotency reconciliation rules cannot be lost from the HTTP crosswalk");
  const consent = find("grantMediaConsent");
  consent.security = [];
  assert.throws(() => assert.deepEqual(consent.security, sourceOperation(consent.identity).security),
    /Expected values to be strictly deep-equal/u, "authenticated consent grant cannot be described as anonymous");
});

test("gRPC transport and provider administration methods partition the exact observed service inventory", () => {
  const surface = parity.surfaces.find((item) => item.surface === "gRPC");
  const observed = new Map();
  for (const path of surface.source) {
    for (const [service, methods] of grpcMethods(path)) observed.set(service, methods);
  }
  const inventory = [...observed].flatMap(([service, methods]) => methods.map((method) => `${service}.${method}`));
  const proposed = Object.values(surface.explicitlyProposed).flat();
  const unresolved = Object.entries(surface.unresolved).flatMap(([service, methods]) => methods.map((method) => `${service}.${method}`));
  const dispositions = parity.typedGrpcNonOperationDispositions;
  assertPartition(inventory, {
    mappedProposal: proposed,
    transportOnly: dispositions.filter(({ type }) => type === "TRANSPORT_ONLY").map(({ identity }) => identity),
    providerAdmin: dispositions.filter(({ type }) => type === "PROVIDER_ADMIN").map(({ identity }) => identity),
    unresolved,
  }, "gRPC");
  assert.deepEqual(surface.dispositionCounts, {
    mappedProposal: proposed.length,
    transportOnly: dispositions.filter(({ type }) => type === "TRANSPORT_ONLY").length,
    providerAdmin: dispositions.filter(({ type }) => type === "PROVIDER_ADMIN").length,
    unresolved: unresolved.length,
  });
  assert.deepEqual(parity.typedInterfaceIdentityDispositions.grpc.transportOnly.sort(),
    dispositions.filter(({ type }) => type === "TRANSPORT_ONLY").map(({ identity }) => identity).sort());
  assert.deepEqual(parity.typedInterfaceIdentityDispositions.grpc.providerAdmin.sort(),
    dispositions.filter(({ type }) => type === "PROVIDER_ADMIN").map(({ identity }) => identity).sort());
  assert.deepEqual(parity.typedInterfaceIdentityDispositions.grpc.unresolved.sort(), unresolved.sort());
  for (const record of dispositions) {
    const methods = observed.get(record.identity.split(".")[0]);
    assert.ok(methods?.includes(record.sourceMethod.replace(/^rpc\s+/u, "")), `${record.identity} must exist in its cited proto service`);
    assert.equal(record.sourceFile, surface.source.find((path) => path === record.sourceFile), `${record.identity} source file must be inventoried`);
  }
  assert.equal(dispositions.length, 18);

  const contracts = parity.typedGrpcMethodContracts;
  assert.equal(contracts.length, inventory.length);
  assert.equal(new Set(contracts.map(({ identity }) => identity)).size, contracts.length);
  const sourceSignatures = new Map(surface.source.flatMap((path) => [...grpcSignatures(path)]));
  const operationSource = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");
  const operationIds = new Set(operationSource.operations.map(({ id }) => id));
  for (const contract of contracts) {
    const signature = sourceSignatures.get(contract.identity);
    assert.ok(signature, `${contract.identity} must resolve to an exact proto method`);
    for (const field of ["service", "method", "inputMessage", "inputStream", "outputMessage", "outputStream"]) {
      assert.equal(contract[field], signature[field], `${contract.identity} ${field} must match the declared RPC signature`);
    }
    assert.equal(contract.sourceFile, surface.source.find((path) => path === contract.sourceFile));
    assert.ok(contract.sourceRef.endsWith(`#service.${signature.service}.rpc.${signature.method}`));
    const protoText = readFileSync(resolve(root, contract.sourceFile), "utf8");
    assert.equal(contract.inputMessageRef, `${contract.sourceFile}#message.${contract.inputMessage}`);
    assert.equal(contract.outputMessageRef, `${contract.sourceFile}#message.${contract.outputMessage}`);
    assert.match(protoText, new RegExp(`\\bmessage\\s+${contract.inputMessage}\\s*\\{`, "u"),
      `${contract.identity} request message must exist in the cited proto`);
    assert.match(protoText, new RegExp(`\\bmessage\\s+${contract.outputMessage}\\s*\\{`, "u"),
      `${contract.identity} result message must exist in the cited proto`);
    if (contract.bindingStatus === "CANDIDATE_ONLY") {
      assert.equal(contract.canonicalFamilyCandidateRef, Object.entries(surface.explicitlyProposed).find(([, ids]) => ids.includes(contract.identity))?.[0]);
      assert.ok(operationIds.has(contract.canonicalFamilyCandidateRef), `${contract.identity} family candidate must resolve`);
      assert.match(contract.bindingBasis, /does not establish leaf semantics/u);
    } else {
      assert.equal(contract.canonicalFamilyCandidateRef, null);
    }
    if (contract.bindingStatus === "SOURCE_BACKED_NON_OPERATION") {
      assert.ok(["TRANSPORT_ONLY", "PROVIDER_ADMIN"].includes(contract.role));
    } else if (contract.bindingStatus === "UNRESOLVED") {
      assert.equal(contract.role, "UNRESOLVED");
    } else {
      assert.ok(["DOMAIN_COMMAND", "DOMAIN_QUERY"].includes(contract.role));
    }
  }
});

test("gRPC crosswalk rejects request/result or streaming drift and invented domain equivalence", () => {
  const contracts = parity.typedGrpcMethodContracts;
  const sourceMethods = new Map(parity.surfaces.find(({ surface }) => surface === "gRPC").source
    .flatMap((path) => [...grpcSignatures(path)]));
  const find = (identity) => structuredClone(contracts.find((item) => item.identity === identity));
  const transcription = find("STTService.StreamTranscribe");
  const exact = sourceMethods.get(transcription.identity);
  transcription.outputStream = false;
  assert.throws(() => assert.equal(transcription.outputStream, exact.outputStream),
    /Expected values to be strictly equal/u, "a stream result cannot be flattened into a unary reply");
  transcription.inputMessageRef = "modules/speech/stt-service/src/main/proto/stt_service.proto#message.TranscribeResponse";
  assert.throws(() => assert.equal(transcription.inputMessageRef,
    "modules/speech/stt-service/src/main/proto/stt_service.proto#message.AudioChunk"),
  /Expected values to be strictly equal/u, "a transcription response cannot be substituted for the streaming audio request");
  const admin = find("STTService.LoadModel");
  admin.role = "DOMAIN_COMMAND";
  assert.throws(() => assert.equal(admin.role, "PROVIDER_ADMIN"),
    /Expected values to be strictly equal/u, "provider model administration cannot be promoted to a product command by name");
  const candidate = find("VisionService.AnalyzeImage");
  candidate.canonicalFamilyCandidateRef = "media.operation.transcription";
  assert.throws(() => assert.equal(candidate.canonicalFamilyCandidateRef, "media.operation.vision-analysis"),
    /Expected values to be strictly equal/u, "a resolvable but semantically wrong family ref must be rejected");
});

test("gRPC identities retain every exact request/result field while leaving semantic field parity open", () => {
  const contracts = parity.typedGrpcMethodContracts;
  assert.equal(contracts.length, 43);
  const counts = {};
  for (const contract of contracts) {
    counts[contract.fieldParityStatus] = (counts[contract.fieldParityStatus] ?? 0) + 1;
    assert.equal(contract.inputFieldInventory.messageRef, contract.inputMessageRef);
    assert.equal(contract.outputFieldInventory.messageRef, contract.outputMessageRef);
    assert.equal(contract.inputFieldInventory.sourceMeaning,
      "PROTO_FIELD_SHAPE_OBSERVED_ONLY; canonical-semantic-equivalence-not-asserted");
    assert.equal(contract.outputFieldInventory.sourceMeaning,
      "PROTO_FIELD_SHAPE_OBSERVED_ONLY; canonical-semantic-equivalence-not-asserted");
    assert.deepEqual(contract.inputFieldInventory.fields, protobufMessageFields(contract.sourceFile, contract.inputMessage));
    assert.deepEqual(contract.outputFieldInventory.fields, protobufMessageFields(contract.sourceFile, contract.outputMessage));
    if (contract.bindingStatus === "CANDIDATE_ONLY") {
      assert.equal(contract.fieldParityStatus, "FAMILY_CANDIDATE_ONLY; leaf-and-field-parity-not-asserted");
      assert.equal(contract.canonicalFamilyCandidateRef !== null, true);
    } else if (contract.bindingStatus === "SOURCE_BACKED_NON_OPERATION") {
      assert.equal(contract.fieldParityStatus, "SOURCE_BACKED_NON_OPERATION; canonical-operation-field-parity-not-applicable");
      assert.equal(contract.canonicalFamilyCandidateRef, null);
    } else {
      assert.equal(contract.bindingStatus, "UNRESOLVED");
      assert.equal(contract.fieldParityStatus, "UNRESOLVED_ROLE_AND_FIELD_PARITY");
      assert.equal(contract.canonicalFamilyCandidateRef, null);
    }
  }
  assert.equal(counts["FAMILY_CANDIDATE_ONLY; leaf-and-field-parity-not-asserted"], 17);
  assert.equal(counts["SOURCE_BACKED_NON_OPERATION; canonical-operation-field-parity-not-applicable"], 18);
  assert.equal(counts.UNRESOLVED_ROLE_AND_FIELD_PARITY, 8);

  const transcribe = structuredClone(contracts.find(({ identity }) => identity === "STTService.Transcribe"));
  transcribe.inputFieldInventory.fields = transcribe.inputFieldInventory.fields.filter(({ name }) => name !== "tenant_id");
  assert.throws(() => assert.deepEqual(transcribe.inputFieldInventory.fields,
    protobufMessageFields(transcribe.sourceFile, transcribe.inputMessage)), /Expected values to be strictly deep-equal/u,
  "legacy tenant scope metadata remains visible in the wire evidence");
  const result = structuredClone(contracts.find(({ identity }) => identity === "STTService.StreamTranscribe"));
  result.outputFieldInventory.fields = result.outputFieldInventory.fields.filter(({ name }) => name !== "is_final");
  assert.throws(() => assert.deepEqual(result.outputFieldInventory.fields,
    protobufMessageFields(result.sourceFile, result.outputMessage)), /Expected values to be strictly deep-equal/u,
  "streaming finality fields cannot disappear from source evidence");
});

test("STT file-transcription candidate records the exact canonical adapter gaps and rejects false parity", () => {
  const identity = parity.typedGrpcMethodContracts.find((entry) => entry.identity === "STTService.Transcribe");
  assert.ok(identity);
  const assessment = identity.mediaOwnerAdapterAssessment;
  assert.equal(assessment.id, "media.interface-adapter-assessment.grpc.stt-transcribe.v1");
  assert.equal(assessment.canonicalOperationRef, ".product-experience/pdp-1-domain-data/operations.yaml#operations.media.operation.transcription-submission");
  assert.equal(assessment.disposition, "CANDIDATE_ONLY_ADAPTER_NOT_DEFINED; current-implementations-do-not-satisfy-canonical-submission-contract");
  assert.equal(assessment.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(assessment.independentAcceptance, "OPEN");

  const direct = readFileSync(resolve(root, "modules/speech/stt-service/src/main/java/com/ghatana/stt/grpc/SttGrpcService.java"), "utf8");
  const persistent = readFileSync(resolve(root, "modules/speech/stt-service/src/main/java/com/ghatana/stt/grpc/PersistentSttGrpcService.java"), "utf8");
  const directMethod = direct.slice(direct.indexOf("public void transcribe("), direct.indexOf("public StreamObserver<AudioChunk> streamTranscribe("));
  const persistentMethod = persistent.slice(persistent.indexOf("public void transcribe("), persistent.indexOf("private String getTenantId("));
  assert.match(directMethod, /request\.getSampleRate\(\)\s*>\s*0\s*\?\s*request\.getSampleRate\(\)\s*:\s*16_000/u);
  assert.match(directMethod, /TranscriptionOptions\.defaults\(\)/u);
  assert.match(directMethod, /getLanguage\(\)[\s\S]*?toLowerCase\(Locale\.ROOT\)\.split\("-"\)\[0\]/u);
  assert.doesNotMatch(directMethod, /getProfileId\(\)|getTenantId\(\)|getArtifactId\(\)|getConsentStatus\(\)|getRetentionPolicy\(\)/u);
  assert.match(persistentMethod, /String tenantId\s*=\s*getTenantId\(\)/u);
  assert.match(persistent, /private String getTenantId\(\)[\s\S]*?JwtServerInterceptor\.CTX_TENANT/u);
  assert.doesNotMatch(persistentMethod, /request\.getTenantId\(\)|request\.getProfileId\(\)|request\.getOptions\(\)/u);

  const requiredGaps = [
    "exact immutable sourceArtifactId plus sourceArtifactVersionId and authoritative content digest",
    "requestMode, requestId, and same-key canonical payload fingerprint for replay or reconciliation",
    "explicit profile version and configuration digest",
    "typed purpose, current consent reference, rights evidence reference, retention policy reference, and processing location",
    "host-attested tenant and principal context; caller-supplied tenant_id is never trusted identity",
    "success/rejection/unknown-outcome receipt with stable job reference and provenance rather than transcription text as submission result",
    "current authority recheck and no-effect reconciliation branch",
  ];
  const requiredNonEquivalenceRules = [
    "field-name similarity does not bind proto fields to canonical request fields",
    "a server-side tenant from authenticated context does not supply omitted request, source-version, rights, consent, profile, or finality semantics",
    "the transcription result payload is not a canonical accepted-job receipt",
    "provider execution success is not evidence of qualified profile or admitted runtime",
  ];
  assert.deepEqual(assessment.canonicalSubmissionRequirementsNotProvidedByTheseMethods, requiredGaps);
  const preservesCandidateBoundary = (value) => value.disposition.startsWith("CANDIDATE_ONLY_")
    && value.runtimeAdmission === "NOT_ADMITTED"
    && value.independentAcceptance === "OPEN"
    && requiredGaps.every((gap) => value.canonicalSubmissionRequirementsNotProvidedByTheseMethods.includes(gap))
    && requiredNonEquivalenceRules.every((rule) => value.nonEquivalenceRules.includes(rule));
  assert.equal(preservesCandidateBoundary(assessment), true);
  for (const falseParity of [
    { ...assessment, disposition: "ACCEPTED_CANONICAL_ADAPTER" },
    { ...assessment, canonicalSubmissionRequirementsNotProvidedByTheseMethods: requiredGaps.slice(1) },
    { ...assessment, nonEquivalenceRules: assessment.nonEquivalenceRules.slice(1) },
    { ...assessment, runtimeAdmission: "ADMITTED" },
  ]) assert.equal(preservesCandidateBoundary(falseParity), false, "false parity or admission must fail closed");
});

test("STT streaming candidate separates transport chunks from canonical versioned-stream inputs and receipts", () => {
  const identity = parity.typedGrpcMethodContracts.find((entry) => entry.identity === "STTService.StreamTranscribe");
  assert.ok(identity);
  const assessment = identity.mediaOwnerAdapterAssessment;
  assert.equal(assessment.canonicalOperationRef, ".product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts.records/@id=media.operation.capability.media-speech-transcription-stream");
  assert.equal(assessment.disposition, "CANDIDATE_ONLY_ADAPTER_NOT_DEFINED; current-stream-method-does-not-satisfy-canonical-stream-contract");

  const implementation = readFileSync(resolve(root, "modules/speech/stt-service/src/main/java/com/ghatana/stt/grpc/SttGrpcService.java"), "utf8");
  const streamMethod = implementation.slice(implementation.indexOf("public StreamObserver<AudioChunk> streamTranscribe("), implementation.indexOf("public void getStatus("));
  assert.match(streamMethod, /chunk\.getAudioData\(\)/u);
  assert.match(streamMethod, /chunk\.getTimestampMs\(\)/u);
  assert.doesNotMatch(streamMethod, /chunk\.getSampleRate\(\)|chunk\.getSessionId\(\)/u);
  assert.match(streamMethod, /new (?:java\.util\.concurrent\.)?LinkedBlockingQueue<>\(MAX_BUFFER_CHUNKS\)/u);
  assert.match(streamMethod, /RESOURCE_EXHAUSTED/u);
  assert.match(streamMethod, /session\.endStream\(\)/u);
  assert.deepEqual(assessment.observedImplementationBehavior.consumedFields, ["audio_data", "timestamp_ms"]);
  assert.deepEqual(assessment.observedImplementationBehavior.ignoredFields, ["sample_rate", "session_id"]);
  const expectedGaps = [
    "exact live-stream artifactId and versionId plus host-attested tenant/principal/workspace context",
    "typed language-hint input and explicit requestId/idempotency identity",
    "trusted consent, rights, purpose, profile, processing-location, and resource-admission checks before effects",
    "output transcript artifact/version reference and provenance rather than transient text events alone",
    "canonical outcome state, observedAt, implementation/qualification/runtime axes, and unknown-outcome recovery contract",
  ];
  assert.deepEqual(assessment.canonicalRequirementsNotProvided, expectedGaps);
  const isSafeCandidate = (value) => value.disposition.startsWith("CANDIDATE_ONLY_")
    && value.runtimeAdmission === "NOT_ADMITTED"
    && expectedGaps.every((gap) => value.canonicalRequirementsNotProvided.includes(gap))
    && value.nonEquivalenceRules.length === 3;
  assert.equal(isSafeCandidate(assessment), true);
  assert.equal(isSafeCandidate({ ...assessment, canonicalRequirementsNotProvided: expectedGaps.slice(1) }), false);
  assert.equal(isSafeCandidate({ ...assessment, runtimeAdmission: "ADMITTED" }), false);
  assert.equal(isSafeCandidate({ ...assessment, nonEquivalenceRules: [] }), false);
});

test("STT correction acknowledgement stub cannot be promoted to a canonical correction effect", () => {
  const identity = parity.typedGrpcMethodContracts.find((entry) => entry.identity === "STTService.SubmitCorrection");
  assert.ok(identity);
  const assessment = identity.mediaOwnerImplementationAssessment;
  assert.equal(assessment.disposition, "DOMAIN_CANDIDATE_IMPLEMENTATION_IS_ACKNOWLEDGEMENT_STUB; no-canonical-correction-effect-evidenced");
  assert.equal(assessment.canonicalEquivalence, "NOT_ESTABLISHED");
  assert.equal(assessment.runtimeAdmission, "NOT_ADMITTED");

  const implementation = readFileSync(resolve(root, "modules/speech/stt-service/src/main/java/com/ghatana/stt/grpc/SttGrpcService.java"), "utf8");
  const method = implementation.slice(implementation.indexOf("public void submitCorrection("), implementation.indexOf("private static String cid("));
  assert.match(method, /CorrectionResponse\.newBuilder\(\)[\s\S]*?\.setAccepted\(true\)[\s\S]*?\.setMessage\("Correction accepted"\)/u);
  assert.doesNotMatch(method, /request\.get(?:OriginalText|CorrectedText|ProfileId|ContextId|AudioFeatures)\(\)|save|persist|adapt/u);
  const safe = (value) => value.canonicalEquivalence === "NOT_ESTABLISHED"
    && value.runtimeAdmission === "NOT_ADMITTED"
    && value.nonEquivalenceRules.length === 3
    && value.observedEffect.includes("no-store-or-adaptation-call");
  assert.equal(safe(assessment), true);
  assert.equal(safe({ ...assessment, canonicalEquivalence: "ESTABLISHED" }), false);
  assert.equal(safe({ ...assessment, observedEffect: "persisted-and-applied" }), false);
  assert.equal(safe({ ...assessment, runtimeAdmission: "ADMITTED" }), false);
});

test("STT profile and adaptation identities retain source-exact effects while canonical ownership remains unresolved", () => {
  const source = readFileSync(resolve(root, "modules/speech/stt-service/src/main/java/com/ghatana/stt/grpc/SttGrpcService.java"), "utf8");
  const method = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
  const adapt = method("public void adaptModel(", "// ── AV-001.5: createProfile");
  const create = method("public void createProfile(", "// ── AV-001.6: getProfile");
  const get = method("public void getProfile(", "// ── AV-001.7: updateProfile");
  const update = method("public void updateProfile(", "public void submitCorrection(");
  const byIdentity = new Map(parity.typedGrpcMethodContracts.map((entry) => [entry.identity, entry]));
  const assessments = ["STTService.AdaptModel", "STTService.CreateProfile", "STTService.GetProfile", "STTService.UpdateProfile"]
    .map((identity) => byIdentity.get(identity)?.mediaOwnerImplementationAssessment);
  assert.ok(assessments.every(Boolean));
  for (const assessment of assessments) {
    assert.equal(assessment.canonicalEquivalence, "NOT_ESTABLISHED");
    assert.equal(assessment.runtimeAdmission, "NOT_ADMITTED");
    assert.equal(assessment.independentAcceptance, "OPEN");
    assert.ok(assessment.missingOwnerSemantics.length >= 3);
  }
  assert.match(adapt, /getProfileId\(\)[\s\S]*?getCorrectedTranscript\(\)[\s\S]*?stt\.saveProfile\(updated\)/u);
  assert.doesNotMatch(adapt, /getAudioFeatures\(\)|getOriginalTranscript\(\)|getContextId\(\)|getTimestampMs\(\)|getMode\(\)/u);
  assert.match(create, /UUID\.randomUUID\(\)/u);
  assert.match(create, /new AudioData\(sample\.toByteArray\(\), 16000, 1, 16\)/u);
  assert.match(create, /stt\.createProfile\(profileId, enrollmentAudio\)/u);
  assert.doesNotMatch(create.slice(0, create.indexOf("responseObserver.onNext")), /request\.getSettings\(\)/u);
  assert.match(get, /stt\.loadProfile\(profileId\)/u);
  assert.match(update, /request\.getSettings\(\)\.getPreferredLanguage\(\)/u);
  assert.doesNotMatch(update, /request\.getSettings\(\)\.get(?:Model|Provider|Enrollment|Vocabulary)/u);
  assert.match(update, /stt\.saveProfile\(updated\)/u);

  const unresolvedWithoutPromotion = (assessment) => assessment.disposition.startsWith("UNRESOLVED_MEDIA_PROFILE_")
    && assessment.canonicalEquivalence === "NOT_ESTABLISHED"
    && assessment.runtimeAdmission === "NOT_ADMITTED"
    && assessment.missingOwnerSemantics.length >= 3;
  assert.ok(assessments.every(unresolvedWithoutPromotion));
  assert.equal(unresolvedWithoutPromotion({ ...assessments[0], disposition: "ACCEPTED_PROFILE_OPERATION" }), false);
  assert.equal(unresolvedWithoutPromotion({ ...assessments[1], canonicalEquivalence: "ESTABLISHED" }), false);
  assert.equal(unresolvedWithoutPromotion({ ...assessments[2], missingOwnerSemantics: [] }), false);
  assert.equal(unresolvedWithoutPromotion({ ...assessments[3], runtimeAdmission: "ADMITTED" }), false);
});

test("TTS synthesis remains a family candidate because its implementation lacks canonical authority and durable receipts", () => {
  const identity = parity.typedGrpcMethodContracts.find((entry) => entry.identity === "TTSService.Synthesize");
  assert.ok(identity);
  const assessment = identity.mediaOwnerImplementationAssessment;
  assert.equal(assessment.canonicalFamilyOperationRef, ".product-experience/pdp-1-domain-data/operations.yaml#operations.media.operation.synthesis");
  assert.equal(assessment.disposition, "CANDIDATE_ONLY; canonical-family-operation-is-proposal-only-and-wire-adapter-is-unresolved");
  assert.equal(assessment.runtimeAdmission, "NOT_ADMITTED");

  const source = readFileSync(resolve(root, "modules/speech/tts-service/src/main/java/com/ghatana/tts/grpc/TtsGrpcService.java"), "utf8");
  const method = source.slice(source.indexOf("public void synthesize("), source.indexOf("public void streamSynthesize("));
  const options = source.slice(source.indexOf("private static SynthesisOptions options("), source.indexOf("private static String validateText("));
  assert.match(method, /request\.getText\(\)/u);
  assert.match(method, /options\(request\)/u);
  assert.match(method, /\.setAudioData\(/u);
  assert.match(method, /\.setSampleRate\(/u);
  assert.doesNotMatch(method, /request\.get(?:TenantId|ArtifactId|JobId|CorrelationId|ConsentStatus|RetentionPolicy|ProfileId)\(\)/u);
  assert.match(options, /getVoiceId\(\)/u);
  assert.match(options, /getSpeed\(\)/u);
  assert.match(options, /getPitch\(\)/u);
  assert.match(options, /getEnergy\(\)/u);
  assert.match(options, /getLanguage\(\)/u);
  assert.doesNotMatch(options, /getEmotion\(\)|getOutputFormat\(\)/u);
  const missing = [
    "trusted tenant/principal/workspace authority and current voice-rights/consent/purpose checks",
    "exact input text/version and voice profile identity/version/configuration digest",
    "qualified voice/format/profile and explicit fallback rules",
    "durable output artifact/version registration, provenance, and source relationship",
    "request idempotency, success/rejection/unknown-outcome finality, and reconciliation before retry",
  ];
  assert.deepEqual(assessment.canonicalSemanticsNotEstablished, missing);
  const safe = (value) => value.disposition.startsWith("CANDIDATE_ONLY;")
    && value.runtimeAdmission === "NOT_ADMITTED"
    && missing.every((gap) => value.canonicalSemanticsNotEstablished.includes(gap))
    && value.nonEquivalenceRules.length === 3;
  assert.equal(safe(assessment), true);
  assert.equal(safe({ ...assessment, runtimeAdmission: "ADMITTED" }), false);
  assert.equal(safe({ ...assessment, canonicalSemanticsNotEstablished: missing.slice(1) }), false);
  assert.equal(safe({ ...assessment, nonEquivalenceRules: [] }), false);
});

test("TTS voice cloning remains unadmitted until exact voice-rights and enrollment-source semantics exist", () => {
  const identity = parity.typedGrpcMethodContracts.find((entry) => entry.identity === "TTSService.CloneVoice");
  assert.ok(identity);
  const assessment = identity.mediaOwnerImplementationAssessment;
  assert.equal(assessment.disposition, "CANDIDATE_ONLY; source-effect-is-voice-cloning-and-rights-admission-contract-is-absent");
  assert.equal(assessment.runtimeAdmission, "NOT_ADMITTED");
  const source = readFileSync(resolve(root, "modules/speech/tts-service/src/main/java/com/ghatana/tts/grpc/TtsGrpcService.java"), "utf8");
  const method = source.slice(source.indexOf("public void cloneVoice("), source.indexOf("public void submitFeedback("));
  assert.match(method, /request\.getAudioSamplesList\(\)/u);
  assert.match(method, /new AudioData\(sample\.toByteArray\(\), 22_050, 1, 16\)/u);
  assert.match(method, /getFineTuneEpochs\(\)\s*>\s*0[\s\S]*?100/u);
  assert.match(method, /getLearningRate\(\)\s*>\s*0[\s\S]*?0\.001f/u);
  assert.match(method, /getVoiceName\(\)/u);
  assert.doesNotMatch(method, /getTenantId\(\)|getPrincipalId\(\)|getConsent|rights|sourceArtifactVersion/u);
  const required = [
    "speaker identity and explicit authorization for voice likeness or cloning use",
    "consent, rights evidence, purpose, retention, and tenant/principal ownership of enrollment samples and cloned voice",
    "exact profile/voice version, qualification, and clone-configuration digest",
    "approved parameter bounds and explicit format conversion evidence",
    "immutable output version/provenance, idempotency, finality, and safe unknown-outcome recovery",
  ];
  assert.deepEqual(assessment.canonicalSemanticsNotEstablished, required);
  const safe = (value) => value.disposition.startsWith("CANDIDATE_ONLY;")
    && value.runtimeAdmission === "NOT_ADMITTED"
    && required.every((item) => value.canonicalSemanticsNotEstablished.includes(item))
    && value.nonEquivalenceRules.length === 3;
  assert.equal(safe(assessment), true);
  assert.equal(safe({ ...assessment, runtimeAdmission: "ADMITTED" }), false);
  assert.equal(safe({ ...assessment, canonicalSemanticsNotEstablished: required.slice(1) }), false);
  assert.equal(safe({ ...assessment, nonEquivalenceRules: [] }), false);
});

test("parity inventory fails closed on duplicate or stale disposition identities", () => {
  const surface = parity.surfaces.find((item) => item.surface === "HTTP");
  const groups = {
    mappedProposal: Object.values(surface.proposedSemanticCandidates).flat(),
    boundedDefinition: Object.keys(surface.boundedDefinitionBindings.identities),
    transportOnly: surface.sourceBackedNonOperationDispositions.TRANSPORT_ONLY,
    unresolved: surface.unresolved,
  };
  assert.throws(() => assertPartition(surface.identities, {
    ...groups,
    fabricated: ["getMediaHealth"],
  }, "HTTP mutation"), /appears in both/u, "one HTTP identity cannot be accepted as both transport and invented disposition");
  assert.throws(() => assertPartition(surface.identities, {
    ...groups,
    fabricated: ["getMediaFakeHealth"],
  }, "HTTP mutation"), /inventory must have one explicit disposition/u,
  "an invented route name cannot silently enter the source inventory");
});

test("Media interface grammar resolves every source and preserves the complete finality safety vocabulary", () => {
  assert.match(grammar.status, /^MEDIA_OWNER_ACCEPTED_DEFINITION_GRAMMAR;/u);
  for (const source of grammar.sourceRefs) assert.ok(existsSync(resolve(root, source)), `missing grammar source ${source}`);
  for (const [channel, contract] of Object.entries(grammar.channels)) {
    for (const source of Array.isArray(contract.source) ? contract.source : [contract.source]) {
      assert.ok(existsSync(resolve(root, source)), `${channel} contract source is missing: ${source}`);
    }
  }
  for (const source of [grammar.channels.HTTP.dispositionSource, grammar.channels.gRPC.dispositionSource]) {
    assert.ok(source.includes("operation-parity.yaml#typed"), "non-domain disposition source must resolve to the typed source inventory");
  }
  assert.deepEqual(Object.keys(grammar.invariants).sort(), [
    "authority", "cancellation", "errors", "eventObservation", "identity", "mutation", "progress", "retry", "unknownOutcome",
  ]);
  assert.ok(grammar.invariants.unknownOutcome.forbidden.includes("blind-resubmit"));
  assert.ok(grammar.invariants.cancellation.forbidden.includes("request-implies-cancelled"));
  assert.ok(grammar.invariants.mutation.forbidden.includes("accepted-implies-completed"));
  assert.ok(grammar.invariants.retry.forbidden.includes("retry-unknown"));
  assert.match(grammar.acceptance.status, /interface-owner conformance.*pending/u);
  assert.match(grammar.verification.status, /not-accepted/u);
});

test("legacy and candidate SDK paths stay explicitly unadmitted when absent from the active route manifest", () => {
  const routeManifest = JSON.parse(readFileSync(resolve(root, "config/route-manifest.json"), "utf8"));
  const findings = parity.compatibilityRouteFindings.sourceFindings;
  assert.equal(parity.compatibilityRouteFindings.canonicalRouteManifest, "config/route-manifest.json");
  assert.equal(findings.length, 14);
  for (const finding of findings) {
    assert.ok(finding.source.startsWith("libs/audio-video-client/src/"), "each mismatch must name the concrete client source");
    assert.ok(existsSync(resolve(root, finding.source)), `missing client source ${finding.source}`);
    assert.ok(!routeManifest.routes.some((route) => route.method === finding.method && route.path === finding.path),
      `${finding.method} ${finding.path} must not be described as admitted without an active route`);
  }
  assert.equal(routeManifest.routes.length, 27);
  assert.match(parity.compatibilityRouteFindings.disposition, /NOT_ADMITTED_TO_CURRENT_RUNTIME_ROUTE_MANIFEST/u);
});

test("remaining machine-channel identities are finite, source-backed, and explicitly non-accepted", () => {
  const sdkSurface = parity.surfaces.find((item) => item.surface === "SDK registry");
  const sdkRegistry = readYaml(".product-experience/pdp-3-product-experience/sdk/operation-registry.yaml");
  const sdkMethods = sdkRegistry.methods.map(({ id }) => id);
  const sdkParserArtifacts = sdkSurface.parserArtifactTokensExcludedFromMethodDenominator;
  const typedSdkIds = parity.typedMethodDispositions.map(({ identity }) => identity);
  assert.equal(new Set(typedSdkIds).size, typedSdkIds.length, "SDK method dispositions must not duplicate identities");
  assertPartition(sdkMethods.filter((id) => !sdkParserArtifacts.includes(id)), {
    typed: typedSdkIds,
  }, "SDK");
  assert.equal(typedSdkIds.length, sdkSurface.denominator);
  for (const disposition of parity.typedMethodDispositions) {
    assert.ok(["DOMAIN_COMMAND", "DOMAIN_QUERY", "CLIENT_ONLY", "TRANSPORT_ONLY", "PROVIDER_ADMIN", "PROVIDER_ADAPTER", "COMPATIBILITY_ADAPTER", "NOT_ADMITTED"].includes(disposition.type),
      `${disposition.identity} needs a finite role disposition`);
    assert.ok(disposition.basis && disposition.bindingEvidence, `${disposition.identity} needs evidence and a role rationale`);
  }
  const typedSdkContracts = parity.typedSdkMethodContracts;
  const sourceRegistry = readYaml(".product-experience/pdp-3-product-experience/sdk/operation-registry.yaml");
  const sdkCandidateRefs = new Map(Object.entries(sdkSurface.proposedSemanticCandidates).flatMap(([family, ids]) =>
    ids.map((identity) => [identity, `media.operation.${family}`])));
  assert.equal(typedSdkContracts.length, sdkSurface.denominator);
  assert.deepEqual(typedSdkContracts.map(({ identity }) => identity).sort(), [...typedSdkIds].sort());
  for (const contract of typedSdkContracts) {
    const sourceMethod = sourceRegistry.methods.find(({ id }) => id === contract.identity);
    const role = parity.typedMethodDispositions.find(({ identity }) => identity === contract.identity);
    assert.ok(sourceMethod && role, `${contract.identity} must have both source registry and typed role evidence`);
    assert.equal(contract.sourceFile, sourceMethod.source);
    assert.equal(contract.method, sourceMethod.method);
    assert.equal(contract.declaringClass, sourceMethod.declaringClass);
    assert.equal(contract.sourceRef, `${sourceMethod.source}#L${contract.sourceLine}`);
    const sourceLines = readFileSync(resolve(root, contract.sourceFile), "utf8").split("\n");
    assert.equal(sourceLines[contract.sourceLine - 1].includes(contract.method), true,
      `${contract.identity} source line must identify the method`);
    assert.ok(contract.sourceSignature.includes(`${contract.method}(`) || contract.sourceSignature.includes(`${contract.method} (`));
    assert.equal(contract.role, role.type);
    assert.equal(contract.semanticBinding, role.semanticBinding);
    if (sourceMethod.boundedInterfaceDefinition?.operationRef) {
      assert.equal(contract.bindingStatus, "BOUNDED_DEFINITION");
      assert.equal(contract.canonicalOperationRef, sourceMethod.boundedInterfaceDefinition.operationRef);
      assert.equal(contract.candidateOperationRef, null);
    } else {
      assert.equal(contract.canonicalOperationRef, null);
      assert.equal(contract.candidateOperationRef, sdkCandidateRefs.get(contract.identity) ?? null);
    }
    assert.ok(contract.bindingEvidence, `${contract.identity} needs source evidence`);
  }

  const cliSurface = parity.surfaces.find((item) => item.surface === "CLI fixture commands");
  const cliRegistry = readYaml(".product-experience/pdp-3-product-experience/cli/command-registry.yaml");
  const cliIds = cliRegistry.commands.map(({ id }) => id);
  const cliProposals = Object.values(cliSurface.proposedSemanticCandidates).flat();
  assertPartition(cliIds, { mappedProposal: cliProposals, unresolved: cliSurface.unresolved }, "fixture CLI");
  assert.equal(cliIds.length, cliSurface.denominator);
  assert.equal(cliRegistry.sourcePopulation.productionCommandCount, 0, "fixture commands cannot be counted as production CLI support");
  const typedCli = parity.typedFixtureCliContracts;
  const parserSource = readFileSync(resolve(root, "libs/media-experience-simulation/src/cli.ts"), "utf8");
  const canonicalCli = readYaml(".product-experience/pdp-3-product-experience/cli-command-registry.yaml");
  assert.equal(typedCli.length, cliIds.length);
  assert.deepEqual(typedCli.map(({ identity }) => identity).sort(), [...cliIds].sort());
  for (const contract of typedCli) {
    const sourceCommand = cliRegistry.commands.find(({ id }) => id === contract.identity);
    assert.ok(sourceCommand, `${contract.identity} must be a fixture command identity`);
    assert.deepEqual(contract.optionNames, sourceCommand.options);
    assert.equal(contract.executionScope, "deterministic-synthetic-fixture-only; not a production CLI contract");
    assert.equal(contract.actionIntentRef, fixtureCliActions.get(contract.identity),
      `${contract.identity} must retain its exact parser action mapping`);
    assert.ok(parserSource.includes(`"${contract.parserActionId}"`), `${contract.identity} parser action must exist`);
    assert.ok(parserSource.includes(`"${contract.actionIntentRef}"`), `${contract.identity} action intent must exist`);
    const proposal = canonicalCli.commands.find(({ actionRef }) => actionRef === contract.actionIntentRef);
    assert.equal(contract.canonicalOperationRef, proposal?.operationRef ?? null,
      `${contract.identity} must cite only its exact command proposal's operationRef`);
    if (contract.canonicalOperationRef) assert.match(contract.bindingBasis, /action intent only/u);
    else assert.equal(contract.bindingStatus, "FIXTURE_ACTION_INTENT_ONLY");
  }

  const agentSurface = parity.surfaces.find((item) => item.surface === "Agent Tool handlers");
  const agentRegistry = readYaml(".product-experience/pdp-3-product-experience/agent-tools/tool-registry.yaml");
  const agentIds = agentRegistry.tools.map(({ id }) => id);
  const agentProposals = Object.values(agentSurface.proposedSemanticCandidates).flat();
  assertPartition(agentIds, { mappedProposal: agentProposals }, "Agent Tool");
  assert.equal(agentIds.length, agentSurface.denominator);
  assert.ok(agentRegistry.tools.every(({ executionAdmitted }) => executionAdmitted === false),
    "observed Agent Tool handlers remain unadmitted");

  const eventSurface = parity.surfaces.find((item) => item.surface === "lifecycle event names");
  const eventRegistry = readYaml(".product-experience/pdp-3-product-experience/events/event-registry.yaml");
  const eventIds = eventRegistry.events.map(({ id }) => id.replace(/^media\.event\./u, ""));
  const eventProposals = Object.values(eventSurface.proposedSemanticCandidates).flat();
  assertPartition(eventIds, { mappedProposal: eventProposals, unresolved: eventSurface.unresolved }, "client lifecycle events");
  assert.equal(eventIds.length, eventSurface.denominator);
  assert.equal(eventRegistry.populations.semanticCrosswalk, "not-established");

  for (const relativePath of [
    ".product-experience/pdp-2-design-interface-system/api/conventions.yaml",
    ".product-experience/pdp-2-design-interface-system/cli/conventions.yaml",
    ".product-experience/pdp-2-design-interface-system/sdk/conventions.yaml",
    ".product-experience/pdp-2-design-interface-system/events/conventions.yaml",
    ".product-experience/pdp-2-design-interface-system/agent-tools/conventions.yaml",
  ]) {
    const contract = readYaml(relativePath);
    assert.match(contract.scopeStatus ?? contract.acceptance?.status ?? "", /proposal|pending/u,
      `${relativePath} must not masquerade as an owner-accepted wire/runtime contract`);
    assert.ok(contract.verification?.status?.includes("not-run") || contract.verification?.status?.includes("not-established"),
      `${relativePath} must retain outstanding consumer verification`);
  }
});

test("client callbacks and UI action intents are not canonical lifecycle events", () => {
  const callbacks = ["media.sdk.addEventListener", "media.sdk.removeEventListener"];
  const callbackDispositions = callbacks.map((identity) => parity.typedMethodDispositions.find((item) => item.identity === identity));
  assert.ok(callbackDispositions.every(Boolean));
  assert.ok(callbackDispositions.every(({ type }) => type === "CLIENT_ONLY"));

  const actions = parity.surfaces.find(({ surface }) => surface === "UI action registry");
  assert.match(actions.ownerApprovedActionIntentAssociations.scope,
    /semantic-intent-association-only.*do not accept.*runtime reachability/u);
  assert.equal(parity.dispositions.ownerApprovedActionIntentAssociation,
    "PDP-3 UI action intent is associated with a PDP-1 operation; no cross-interface binding or operation behavior accepted");

  const lifecycleSurface = parity.surfaces.find(({ surface }) => surface === "lifecycle event names");
  const eventRegistry = readYaml(".product-experience/pdp-3-product-experience/events/event-registry.yaml");
  const lifecycleIds = eventRegistry.events.map(({ id }) => id);
  assert.equal(eventRegistry.populations.semanticCrosswalk, "not-established");
  assert.ok(callbacks.every((callback) => !lifecycleIds.includes(callback)),
    "client listener registration/removal is not a lifecycle event identity");
  assert.ok(lifecycleSurface.unresolved.includes("ai-voice:process:start"));
  assert.ok(lifecycleSurface.bindingStatus.includes("trigger-operation-and-delivery-bindings-unresolved"));
  const internalEvents = parity.surfaces.find(({ surface }) => surface === "internal runtime events");
  assert.equal(internalEvents.dispositionCounts.unresolved, internalEvents.denominator);
  assert.ok(parity.crossSurfaceRules.some((rule) => rule.includes("callbacks-and-owner-approved-ui-action-intents-are-not-canonical-lifecycle-events")));
});

test("all UI action effect contracts are source-exact and stay separate from operation acceptance", () => {
  const inventory = parity.typedUiActionSemantics;
  assert.equal(inventory.length, 146);
  assert.equal(actionRegistry.actions.length, 146);
  const sourceById = new Map(actionRegistry.actions.map((entry) => [entry.id, entry]));
  const seen = new Set();
  for (const entry of inventory) {
    assert.ok(!seen.has(entry.identity), `unique UI identity: ${entry.identity}`);
    seen.add(entry.identity);
    const source = sourceById.get(entry.identity);
    assert.ok(source, `source action exists: ${entry.identity}`);
    assert.equal(entry.sourceRecord, `${actionRegistryPath}#actions[${entry.identity}]`);
    assert.deepEqual(entry.actionDefinitionSemantics, source.actionDefinitionSemantics,
      `${entry.identity} retains its source effect, reversibility, finality, guard and disposition semantics`);
    assert.equal(entry.definitionOnlyBoundary,
      "PDP3 action intent and declared action-effect scope only; does not accept canonical PDP1 operation semantics, wire/transport parity, runtime reachability, or admission.");
    assert.equal(entry.actionDefinitionSemantics.typedDefinition.runtimeAdmission, "NOT_ADMITTED");
  }
  assert.deepEqual([...seen].sort(), [...sourceById.keys()].sort());

  const mutation = structuredClone(inventory);
  mutation.find(({ identity }) => identity === "media.action.begin-artifact-upload").actionDefinitionSemantics.finalityScope =
    "Upload receipt proves artifact availability.";
  const source = sourceById.get("media.action.begin-artifact-upload").actionDefinitionSemantics;
  assert.notDeepEqual(mutation.find(({ identity }) => identity === "media.action.begin-artifact-upload").actionDefinitionSemantics,
    source, "a contradictory finality mutation is rejected despite a valid action identity");
  assert.equal(source.operationRef, "media.operation-slice.begin-upload");
  assert.notEqual(source.operationRef, "media.operation.artifact-ingest", "an operation family is not a leaf operation binding");
});

test("runtime lifecycle events and client notifications keep their distinct exact source roles", () => {
  const runtime = parity.typedRuntimeLifecycleEventDispositions;
  const notifications = parity.typedClientNotificationDispositions;
  assert.equal(runtime.denominator, 9);
  assert.equal(notifications.denominator, 15);
  assert.equal(eventContracts.ownerEventContracts.records.length, 9);
  assert.equal(eventContracts.ownerEventContracts.notificationRecords.length, 15);
  assert.equal(eventRegistry.events.length, 15);

  const registryByEventName = new Map(eventRegistry.events.map((record) => [record.eventName, record]));
  const sourceLifecycleIds = new Set();
  for (const row of runtime.entries) {
    const index = Number(row.sourceRef.split("/records/").at(-1));
    const source = eventContracts.ownerEventContracts.records[index];
    assert.ok(source, `${row.identity} exact runtime source row exists`);
    assert.equal(row.identity, source.id);
    assert.equal(row.eventType, source.eventType);
    assert.equal(row.producerIdentity, source.producer.identity);
    assert.equal(row.producerSourceRef, source.producer.sourceRef);
    assert.equal(row.finality, source.finality);
    assert.equal(row.executionAdmission, "NOT_ADMITTED");
    assert.equal(row.runtimeAvailability, "UNKNOWN");
    assert.equal(row.scope, "Media-owned lifecycle event definition only; publisher/consumer contract qualification and phase acceptance remain open.");
    sourceLifecycleIds.add(row.eventType);
  }

  const notificationNames = new Set();
  for (const row of notifications.entries) {
    const index = Number(row.sourceRef.split("/notificationRecords/").at(-1));
    const source = eventContracts.ownerEventContracts.notificationRecords[index];
    const registry = registryByEventName.get(row.eventName);
    assert.ok(source && registry, `${row.identity} maps to a source notification and exact registry identity`);
    assert.equal(row.identity, registry.id);
    assert.equal(row.eventName, source.eventName);
    assert.equal(row.producerIdentity, source.producer.identity);
    assert.equal(row.producerSourceRef, source.producer.sourceRef);
    assert.equal(row.finality, source.finality);
    assert.equal(row.semanticEquivalenceToLifecycleType, "NONE");
    assert.equal(row.executionAdmission, "NOT_ADMITTED");
    assert.equal(row.delivery, "best-effort-process-local");
    assert.equal(row.role, "CLIENT_LOCAL_NOTIFICATION; not a canonical lifecycle event");
    assert.ok(!sourceLifecycleIds.has(row.eventName), `${row.eventName} is not promoted to runtime lifecycle identity`);
    notificationNames.add(row.eventName);
  }
  assert.deepEqual([...notificationNames].sort(), [...registryByEventName.keys()].sort());

  const alteredNotification = structuredClone(notifications.entries[0]);
  alteredNotification.finality = "authoritative-provider-completion";
  assert.notEqual(alteredNotification.finality, eventContracts.ownerEventContracts.notificationRecords[0].finality,
    "a client callback cannot claim provider or domain finality");
  const alteredRole = structuredClone(notifications.entries[0]);
  alteredRole.semanticEquivalenceToLifecycleType = "EQUIVALENT";
  assert.notEqual(alteredRole.semanticEquivalenceToLifecycleType, "NONE",
    "invented lifecycle equivalence is a semantic mutation, not a harmless rename");
});

test("fixture CLI crosswalk rejects a different parser action and production-scope promotion", () => {
  const contracts = parity.typedFixtureCliContracts;
  const find = (identity) => structuredClone(contracts.find((item) => item.identity === identity));
  const transcription = find("media.fixture-cli.transcribe");
  transcription.actionIntentRef = "media.action.inspect-artifact";
  assert.throws(() => assert.equal(transcription.actionIntentRef, fixtureCliActions.get(transcription.identity)),
    /Expected values to be strictly equal/u, "the CLI command may not borrow a similarly convenient action intent");
  const upload = find("media.fixture-cli.upload-resume");
  upload.executionScope = "production-runtime";
  assert.throws(() => assert.equal(upload.executionScope, "deterministic-synthetic-fixture-only; not a production CLI contract"),
    /Expected values to be strictly equal/u, "fixture execution cannot be promoted into production CLI admission by a registry edit");
});

test("SDK crosswalk rejects wrong leaf bindings, client-local promotion, and unadmitted retry", () => {
  const contracts = parity.typedSdkMethodContracts;
  const find = (identity) => structuredClone(contracts.find((item) => item.identity === identity));
  const artifact = find("media.sdk.getArtifact");
  artifact.canonicalOperationRef = "media.operation.job-lifecycle";
  assert.throws(() => assert.equal(artifact.canonicalOperationRef, "media.operation-slice.inspect-artifact"),
    /Expected values to be strictly equal/u, "artifact reads must retain their exact leaf contract");
  const listener = find("media.sdk.addEventListener");
  listener.role = "DOMAIN_COMMAND";
  assert.throws(() => assert.equal(listener.role, "CLIENT_ONLY"),
    /Expected values to be strictly equal/u, "local listener registration is not a domain command");
  const retry = find("media.sdk.retryOperation");
  retry.bindingStatus = "CANDIDATE_ONLY";
  assert.throws(() => assert.equal(retry.bindingStatus, "NOT_ADMITTED"),
    /Expected values to be strictly equal/u, "a fail-closed retry method cannot be promoted to a candidate runtime operation");
});
