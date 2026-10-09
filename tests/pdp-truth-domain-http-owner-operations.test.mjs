import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const parse = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml").parse;
const read = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const operations = read(".product-experience/pdp-1-domain-data/operations.yaml");
const api = read("contracts/openapi/media.yaml");
const states = read(".product-experience/pdp-1-domain-data/states.yaml");
const ownerRecords = operations.ownerDefinedOperationContracts.records;
const ids = [
  "media.operation.consent-record-grant.v1",
  "media.operation.consent-record-list.v1",
  "media.operation.consent-record-inspect.v1",
  "media.operation.job-list.v1",
  "media.operation.stream-session.inspect.v1",
];
const get = (id) => {
  const records = ownerRecords.filter((record) => record.id === id);
  assert.equal(records.length, 1, `${id} has one canonical owner contract`);
  return records[0];
};

test("new consent, job-list, and stream-inspection operations are exact typed owner contracts", () => {
  assert.equal(new Set(ids).size, ids.length);
  const grant = get(ids[0]);
  assert.equal(grant.operationKind, "COMMAND");
  assert.deepEqual(grant.requestSchema.required, ["requestId", "purposes", "allowedRegions", "externalProcessingAllowed", "biometricProcessingAllowed"]);
  assert.equal(grant.requestSchema.additionalProperties, false);
  assert.equal(grant.trustedContext.tenantId, "host-attested; never request body");
  assert.equal(grant.trustedContext.principalId, "host-attested; never request body");
  for (const forbidden of ["tenantId", "principalId"]) assert.equal(Object.hasOwn(grant.requestSchema.properties, forbidden), false);
  assert.match(grant.finality, /does not prove any governed use is permitted/u);
  assert.match(grant.unknownOutcome, /reconcile the same request identity/u);

  const list = get(ids[1]);
  const inspect = get(ids[2]);
  assert.equal(list.operationKind, "QUERY");
  assert.equal(inspect.operationKind, "QUERY");
  assert.equal(list.requestSchema.properties.limit.minimum, 1);
  assert.equal(list.requestSchema.properties.limit.maximum, 1000);
  assert.equal(list.resultSchema.additionalProperties, false);
  assert.equal(inspect.resultSchema.properties.record.additionalProperties, false);
  assert.match(list.readSemantics, /do not establish current permission/u);
  assert.match(inspect.readSemantics, /not a current permitted-use decision/u);
  assert.notEqual(inspect.id, "media.operation.action.inspect-consent-and-permitted-use");

  const jobList = get(ids[3]);
  assert.equal(jobList.operationKind, "QUERY");
  assert.equal(jobList.resultSchema.properties.jobs.items.additionalProperties, false);
  assert.match(jobList.readSemantics, /ACCEPTED is not durable QUEUED/u);
  assert.match(jobList.readSemantics, /status alone is not attempt or provider finality evidence/u);

  const stream = get(ids[4]);
  assert.equal(stream.operationKind, "QUERY");
  const streamMachine = states.stateMachines.find(({ machineId }) => machineId === "media-stream-session");
  const exactStateRefs = streamMachine.stateDefinitions.map(({ id }) => `.product-experience/pdp-1-domain-data/states.yaml#stateMachines/media-stream-session/stateDefinitions/${id}`);
  assert.deepEqual(stream.resultSchema.properties.observation.oneOf[1].properties.canonicalStateRef.enum.sort(), exactStateRefs.sort());
  assert.match(stream.readSemantics, /Read does not connect, reconnect, close, or acknowledge a frame/u);
  for (const contract of [grant, list, inspect, jobList, stream]) {
    assert.equal(contract.implementationState, "UNKNOWN");
    assert.equal(contract.qualificationState, "NOT_EVALUATED");
    assert.equal(contract.executionAdmission, "NOT_ADMITTED");
    assert.match(contract.scopeStatus, /DEFINITION_ONLY/u);
  }
});

test("HTTP route candidates are kept separate from incomplete transport projections", () => {
  assert.equal(api.paths["/api/v1/consents"].post.operationId, "grantMediaConsent");
  assert.equal(api.paths["/api/v1/consents"].get.operationId, "listMediaConsents");
  assert.equal(api.paths["/api/v1/consents/{consentId}"].get.operationId, "getMediaConsent");
  assert.equal(api.paths["/api/v1/jobs"].get.operationId, "listMediaJobs");
  assert.equal(api.paths["/api/v1/streams/{sessionId}"].get.operationId, "getMediaStream");
  const byId = new Map(ids.map((id) => [id, get(id)]));
  assert.match(byId.get(ids[0]).sourceAdapterBoundary, /request body has no requestId/u);
  assert.match(byId.get(ids[1]).sourceAdapterBoundary, /has no readVersion\/currentness envelope/u);
  assert.match(byId.get(ids[2]).sourceAdapterBoundary, /does not prove read-version or observedAt/u);
  assert.match(byId.get(ids[3]).sourceAdapterBoundary, /do not establish a complete closed stored projection/u);
  assert.match(byId.get(ids[4]).sourceAdapterBoundary, /open-ended and carries no canonical state authority\/currentness tuple/u);
});
