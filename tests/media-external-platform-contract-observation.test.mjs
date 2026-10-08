import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const observation = JSON.parse(readFileSync(resolve(root, "docs/migration/external-platform-contract-observation.json"), "utf8"));
const mediaEventSource = readFileSync(resolve(root, "runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaLifecycleEvent.java"), "utf8");
const source = (repository, path) => {
  const snapshot = observation.sourceSnapshots.find((item) => item.repository === repository);
  return snapshot && existsSync(resolve(snapshot.path, path))
    ? readFileSync(resolve(snapshot.path, path), "utf8")
    : null;
};

test("external contract observation retains X-04/X-05/X-06 source limits", () => {
  assert.equal(observation.schemaVersion, "media.external-platform-contract-observation.v1");
  assert.equal(observation.authority, "SOURCE_OBSERVATION_ONLY");
  assert.deepEqual(observation.gates.map(({ id }) => id), ["X-04", "X-05", "X-06"]);
  assert.match(observation.gates[0].status, /PUBLICATION_AND_QUALIFICATION_UNPROVEN/u);
  assert.match(observation.gates[1].status, /VERSIONED_TYPED_MEDIA_INPUT_CONTRACT_OBSERVED/u);
  assert.match(observation.gates[2].status, /MEDIA_OPERATION_AND_LIFECYCLE_CROSSWALK_NOT_OBSERVED/u);
  assert.ok(observation.limits.some((item) => item.includes("does not prove remote publication")));
});

test("external contract source is unchanged from the pinned Git revision, regardless of unrelated sibling dirt", (t) => {
  const repository = "samujjwal/ghatana";
  const snapshot = observation.sourceSnapshots.find((item) => item.repository === repository);
  if (!snapshot || !existsSync(resolve(snapshot.path, ".git"))) {
    t.skip("Ghatana sibling checkout is unavailable; cannot compare contract sources to pinned Git objects");
    return;
  }

  // The dirty-path list is evidence of the *dated* observation, not an assertion
  // about the current mutable sibling worktree. Fail instead if the actual
  // public contracts used for X-04/X-05/X-06 have changed since that observation.
  assert.match(snapshot.head, /^[a-f0-9]{40}$/u);
  const contractPaths = [...new Set(observation.gates.flatMap((gate) => (gate.sourceEvidence ?? [])
    .filter((item) => item.repository === repository)
    .map((item) => item.path)))].sort();
  assert.ok(contractPaths.length > 0, "no pinned Ghatana public contract source inputs");

  for (const contractPath of contractPaths) {
    assert.ok(!contractPath.startsWith("/") && !contractPath.split("/").includes(".."),
      `invalid external source path: ${contractPath}`);
    const pinned = execFileSync("git", ["-C", snapshot.path, "show", `${snapshot.head}:${contractPath}`],
      { maxBuffer: 16 * 1024 * 1024 });
    assert.ok(existsSync(resolve(snapshot.path, contractPath)),
      `reviewed external contract is missing: ${contractPath}`);
    const current = readFileSync(resolve(snapshot.path, contractPath));
    assert.deepEqual(current, pinned,
      `review the changed public contract ${contractPath} and update its source observation only after semantic reconciliation`);
  }

  const classified = Object.values(snapshot.dirtyPathClassification)
    .flatMap((entry) => entry.paths ?? [entry.path]).sort();
  const recordedPaths = snapshot.dirtyPaths
    .map((path) => path.startsWith("?? ") ? path.slice(3) : path.slice(2)).sort();
  assert.equal(new Set(classified).size, classified.length, "captured dirty classification is duplicated");
  assert.deepEqual(classified, recordedPaths, "captured historical dirty-path classification is incomplete");
  assert.equal(snapshot.dirtyPathCount, snapshot.dirtyPaths.length);

  // Preserve previously reviewed source-history categories as evidence of the
  // original capture rather than updating them as a side effect of other work.
  const historical = observation.historicalSourceSnapshots[0].dirtyPathClassification;
  const shared = historical.sharedBuildToolingAndTests;
  assert.equal(shared.pathCount, shared.paths.length);
  assert.ok(shared.paths.includes("scripts/shared-development-test-options.mjs"));
  assert.ok(shared.paths.includes("scripts/shared-tools-selection.mjs"));
  const aepDocs = historical.unrelatedAepEniPlanning;
  assert.equal(aepDocs.pathCount, 2);
  assert.equal(aepDocs.paths.length, 2);
  const evidence = historical.unrelatedAepEniNativeDescriptorQualification;
  assert.equal(evidence.pathCount, evidence.paths.length);
  assert.match(evidence.change, /not Media qualification or Lifecycle receipts/u);

  const currentHead = execFileSync("git", ["-C", snapshot.path, "rev-parse", "HEAD"],
    { encoding: "utf8" }).trim();
  if (currentHead !== snapshot.head) {
    t.diagnostic("Sibling HEAD moved; reviewed public contract bytes still match the pinned revision.");
  }
});

test("external freshness audit covers the selected X-04/X-05/X-06 public source contract identities", () => {
  const required = [
    "services/document-intelligence/clients/typescript/package.json",
    "services/document-intelligence/contracts/protocol-v1.md",
    "services/document-intelligence/contracts/shared-contract.lock.json",
    "services/ai-inference/contracts/openapi/ai-inference.yaml",
    "services/data-cloud/contracts/openapi/data-cloud-lifecycle.yaml",
    "services/action-plane/contracts/openapi/action-plane.yaml",
    "services/event-plane/contracts/openapi/event-plane.yaml",
  ];
  const paths = [...new Set(observation.gates.flatMap(({ sourceEvidence }) =>
    (sourceEvidence ?? []).filter(({ repository }) => repository === "samujjwal/ghatana")
      .map(({ path }) => path)))].sort();
  assert.deepEqual(paths, required.sort(), "review source coverage when a public contract is added, removed or renamed");
});

test("available sibling source still matches the recorded contract facts", (t) => {
  const diPackage = source("samujjwal/ghatana", "services/document-intelligence/clients/typescript/package.json");
  const aiContract = source("samujjwal/ghatana", "services/ai-inference/contracts/openapi/ai-inference.yaml");
  const dcContract = source("samujjwal/ghatana", "services/data-cloud/contracts/openapi/data-cloud-lifecycle.yaml");
  const actionContract = source("samujjwal/ghatana", "services/action-plane/contracts/openapi/action-plane.yaml");
  const eventContract = source("samujjwal/ghatana", "services/event-plane/contracts/openapi/event-plane.yaml");
  const workerLock = source("samujjwal/ghatana", "services/document-intelligence/contracts/shared-contract.lock.json");
  const workerProtocol = source("samujjwal/ghatana", "services/document-intelligence/contracts/protocol-v1.md");
  const gharbataiLock = source("samujjwal/gharbatai", "pnpm-lock.yaml");
  const workerConfig = source("samujjwal/gharbatai", "products/org/apps/api/src/modules/document-extraction/document-intelligence.config.ts");
  const extractionRecord = source("samujjwal/ghatana-products", "config/product-extraction-records/media.yaml");
  const aiRequest = source("samujjwal/ghatana-products", "products/tutorputor/config/dependency-requests/TP-GHATANA-AI-001.json");
  const mediaRequest = source("samujjwal/ghatana-products", "products/tutorputor/config/dependency-requests/TP-GHATANA-MEDIA-001.json");
  if (![diPackage, aiContract, dcContract, actionContract, eventContract, workerLock, workerProtocol, gharbataiLock, workerConfig, extractionRecord, aiRequest, mediaRequest].every(Boolean)) {
    t.skip("sibling platform or consumer checkout is not available in this environment");
    return;
  }

  const di = JSON.parse(diPackage);
  assert.equal(di.name, "@ghatana/document-intelligence-client");
  assert.equal(di.version, "0.1.0");
  assert.equal(di.private, false);
  assert.equal(di.peerDependencies["@ghatana/document-extraction"], "0.1.0-SNAPSHOT");
  assert.match(workerLock, /"version": "0\.1\.0-SNAPSHOT"/u);
  assert.match(workerProtocol, /All responses carry `protocolVersion`, `operationId`, and `providerRef`/u);
  assert.match(gharbataiLock, /@ghatana\/document-intelligence-client[\s\S]{0,180}link:/u);
  assert.match(workerConfig, /local worker boundary/u);
  assert.match(extractionRecord, /canonical: source[\s\S]*target: migration-only/u);
  assert.match(extractionRecord, /Rebind Gharbatai's document-intelligence client\s+source to a target artifact or approved public client/u);
  assert.match(extractionRecord, /without transferring\s+Media lifecycle authority/u);

  assert.match(aiContract, /version: 1\.1\.0/u);
  assert.match(aiContract, /familyId: TEXT_GENERATION[\s\S]*?operationTypes: \[LLM, COMPLETION\][\s\S]*?familyId: EMBEDDING[\s\S]*?operationTypes: \[EMBEDDING\]/u);
  const ai = parse(aiContract);
  const inference = ai.components.schemas.InferenceRequest;
  assert.deepEqual(inference.properties.type.enum, ["LLM", "EMBEDDING", "COMPLETION"]);
  assert.equal(inference.properties.input.maxLength, 262144);
  assert.equal(inference.properties.mediaInputs.minItems, 1);
  assert.equal(inference.properties.mediaInputs.maxItems, 32);
  assert.deepEqual(inference.oneOf, [
    { required: ["input"], not: { required: ["mediaInputs"] } },
    { required: ["mediaInputs"], not: { required: ["input"] } },
  ]);
  const mediaInput = inference.properties.mediaInputs.items;
  assert.deepEqual(mediaInput.required, ["modality", "reference", "mediaType", "role", "purpose", "classification", "expiresAt"]);
  assert.equal(mediaInput.additionalProperties, false);
  assert.deepEqual(mediaInput.properties.modality.enum, ["AUDIO", "VIDEO", "IMAGE"]);
  assert.match(mediaInput.description ?? inference.properties.mediaInputs.description,
    /do not authorize dereferencing|Opaque Media artifact references/u);
  assert.match(dcContract, /"version": "1\.2\.1"/u);
  assert.match(dcContract, /"x-ghatana-lifecycle-status": "active"/u);
  assert.match(actionContract, /version: 1\.2\.0/u);
  assert.match(actionContract, /api: 1\.0\.0[\s\S]*event: 1\.0\.0[\s\S]*semantic: 1\.0\.0/u);
  assert.match(eventContract, /version: 1\.3\.0/u);
  assert.match(eventContract, /api: 1\.0\.0[\s\S]*event: 1\.0\.0[\s\S]*semantic: 1\.0\.0/u);
  assert.equal(JSON.parse(aiRequest).status, "OPEN");
  assert.deepEqual(JSON.parse(aiRequest).operationIds, ["executeAiInference", "getAiInferenceProviders"]);
  const media = JSON.parse(mediaRequest);
  assert.equal(media.status, "OPEN");
  assert.equal(media.extensions.tutorputor.consumerMayWriteCanonicalLifecycle, false);
  assert.equal(media.operationIds.length, 11);
});

test("X-06 records the exact Event Plane append route and preserves Media lifecycle limits", (t) => {
  const contractText = source("samujjwal/ghatana", "services/event-plane/contracts/openapi/event-plane.yaml");
  if (!contractText) {
    t.skip("Event Plane sibling checkout is unavailable; source-level append crosswalk cannot be verified");
    return;
  }
  const contract = parse(contractText);
  const pathItem = contract.paths["/api/v1/streams/{streamId}/events"];
  const route = pathItem.post;
  assert.equal(route.operationId, "appendStreamEvent");
  assert.equal(route.responses["201"].content["application/json"].schema.$ref, "#/components/schemas/AppendEventResponse");
  assert.ok(!Object.hasOwn(route.responses, "200"), "append route does not declare 200 success");
  const headerRefs = route.parameters.map((parameter) => parameter.$ref);
  assert.ok(headerRefs.includes("#/components/parameters/IdempotencyHeader"));
  assert.ok(pathItem.parameters.some((parameter) => parameter.$ref === "#/components/parameters/TenantHeader"));
  assert.ok(pathItem.parameters.some((parameter) => parameter.$ref === "#/components/parameters/StreamId"));
  assert.equal(contract.components.parameters.TenantHeader.required, true);
  assert.equal(contract.components.parameters.IdempotencyHeader.required, true);
  assert.deepEqual(contract.components.parameters.TenantHeader.schema, { type: "string", minLength: 1, maxLength: 255 });
  assert.deepEqual(contract.components.parameters.IdempotencyHeader.schema, { type: "string", minLength: 1, maxLength: 255 });
  const appendSchema = contract.components.schemas.AppendEventRequest;
  assert.equal(appendSchema.additionalProperties, false);
  assert.deepEqual(appendSchema.required, ["eventId", "eventType"]);
  assert.deepEqual(Object.keys(appendSchema.properties), ["eventId", "eventType", "eventVersion", "timestamp", "correlationId", "causationId", "source", "userId", "contentType", "headers", "payload", "payloadBase64"]);
  assert.equal(appendSchema.properties.eventId.maxLength, 255);
  assert.equal(appendSchema.properties.eventType.maxLength, 255);
  assert.equal(appendSchema.properties.correlationId.maxLength, 255);
  assert.equal(appendSchema.properties.causationId.maxLength, 255);
  assert.equal(appendSchema.properties.userId.maxLength, 255);
  assert.equal(contract.components.parameters.TenantHeader.schema.maxLength, 255);
  assert.equal(contract.components.parameters.IdempotencyHeader.schema.maxLength, 255);
  assert.match(mediaEventSource, /private static final int EVENT_PLANE_MAX_TEXT_LENGTH = 255;/u);
  for (const field of ["eventId", "eventType", "tenantId", "principalId", "correlationId"]) {
    assert.match(mediaEventSource, new RegExp(`${field} = required\\(${field}, "${field}", EVENT_PLANE_MAX_TEXT_LENGTH\\)`));
  }
  assert.match(mediaEventSource, /causationId = optional\(causationId, "causationId", EVENT_PLANE_MAX_TEXT_LENGTH\)/u);

  const domainEvents = readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/events.yaml"), "utf8");
  assert.match(domainEvents, /acceptedHttpStatuses: \[201\]/u);
  assert.match(domainEvents, /acceptedStatus: 201/u);
  assert.match(domainEvents, /fieldLimits:\n          eventId: 255\n          eventType: 255\n          X-Tenant-Id: 255\n          userId: 255\n          correlationId: 255\n          causationId: 255/u);
  assert.match(domainEvents, /enforcementSource: runtime-contracts\/src\/main\/java\/com\/ghatana\/media\/runtime\/MediaLifecycleEvent\.java#EVENT_PLANE_MAX_TEXT_LENGTH/u);
  assert.match(domainEvents, /publisherOnlyUndeclaredHeaders: \[X-Principal-Id, X-Correlation-Id\]/u);
  assert.match(domainEvents, /stream creation\/retirement ownership unresolved/u);
  assert.match(domainEvents, /Media event taxonomy or producer ownership/u);
  const gate = observation.gates.find(({ id }) => id === "X-06");
  assert.match(gate.status, /MEDIA_OPERATION_AND_LIFECYCLE_CROSSWALK_NOT_OBSERVED/u);
  assert.ok(gate.mediaWork.includes("retain lifecycle/event semantic mapping as unresolved"));
  const eventEvidence = gate.sourceEvidence.find(({ path }) => path === "services/event-plane/contracts/openapi/event-plane.yaml");
  assert.ok(eventEvidence.facts.some((fact) => fact.includes("appendStreamEvent declares 201 success with AppendEventResponse and no 200 success")));
});
