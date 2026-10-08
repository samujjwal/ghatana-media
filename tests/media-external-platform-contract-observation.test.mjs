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
  assert.match(observation.gates[1].status, /TYPED_MEDIA_MODALITY_CONTRACT_NOT_OBSERVED/u);
  assert.match(observation.gates[2].status, /MEDIA_OPERATION_AND_LIFECYCLE_CROSSWALK_NOT_OBSERVED/u);
  assert.ok(observation.limits.some((item) => item.includes("does not prove remote publication")));
});

test("external source snapshot fails when recorded Git metadata becomes stale", (t) => {
  const snapshot = observation.sourceSnapshots.find((item) => item.repository === "samujjwal/ghatana");
  if (!snapshot || !existsSync(resolve(snapshot.path, ".git"))) {
    t.skip("Ghatana sibling checkout is unavailable; cannot validate recorded Git snapshot");
    return;
  }

  const head = execFileSync("git", ["-C", snapshot.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirtyPaths = execFileSync("git", ["-C", snapshot.path, "status", "--short", "--untracked-files=all"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((line) => line.trimStart());
  assert.equal(head, snapshot.head, "refresh external-platform-contract-observation.json after the sibling HEAD changes");
  assert.deepEqual(dirtyPaths, snapshot.dirtyPaths, "refresh the recorded external dirty-path snapshot and classifications");
  assert.equal(dirtyPaths.length, 21);
  assert.match(snapshot.dirtyPathClassification.aiInference.change, /test-parser tolerance only/u);
  assert.match(snapshot.dirtyPathClassification.aiInference.change, /API contract semantics are unchanged/u);
  const shared = snapshot.dirtyPathClassification.sharedBuildToolingAndTests;
  assert.equal(shared.pathCount, 14);
  assert.equal(shared.paths.length, 14);
  assert.ok(shared.paths.includes("scripts/shared-development-test-options.mjs"));
  assert.ok(shared.paths.includes("scripts/shared-tools-selection.mjs"));
  const aepDocs = snapshot.dirtyPathClassification.unrelatedAepEniPlanning;
  assert.equal(aepDocs.pathCount, 2);
  assert.equal(aepDocs.paths.length, 2);
  const evidence = snapshot.dirtyPathClassification.unrelatedAepEniNativeDescriptorQualification;
  assert.equal(evidence.pathCount, 4);
  assert.equal(evidence.paths.length, 4);
  assert.match(evidence.change, /not Media qualification or Lifecycle receipts/u);
  const classified = [snapshot.dirtyPathClassification.aiInference.path, ...shared.paths, ...aepDocs.paths, ...evidence.paths].sort();
  assert.deepEqual(classified, dirtyPaths.map((path) => path.startsWith("?? ") ? path.slice(3) : path.slice(2)).sort(), "each observed dirty path has exactly one classification");
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
  assert.match(aiContract, /type: \{ type: string, enum: \[LLM, EMBEDDING, COMPLETION\] \}/u);
  assert.doesNotMatch(aiContract, /modality:/u);
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
