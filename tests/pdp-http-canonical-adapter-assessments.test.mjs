import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const contracts = readYaml(".product-experience/interface-parity/operation-parity.yaml").typedHttpCanonicalAdapterAssessments;
const openApi = readYaml("contracts/openapi/media.yaml");
const operations = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");

function pointer(rootValue, pointerText) {
  return pointerText.replace(/^\//u, "").split("/").filter(Boolean).reduce((value, part) => {
    const key = part.replace(/~1/gu, "/").replace(/~0/gu, "~");
    return value?.[key];
  }, rootValue);
}

function schemaAt(ref) {
  if (!ref) return undefined;
  const hashAt = ref.indexOf("#");
  const file = ref.slice(0, hashAt);
  const pointerText = ref.slice(hashAt + 1);
  const source = file === "contracts/openapi/media.yaml" ? openApi : undefined;
  return source && pointer(source, pointerText);
}

function propertiesForRef(ref) {
  const schema = schemaAt(ref);
  return schema?.properties ? Object.keys(schema.properties) : [];
}

function operationRecords() {
  return [
    ...(operations.operations ?? []),
    ...(operations.individualOperationContracts?.records ?? []),
    ...(operations.ownerDefinedOperationContracts?.records ?? []),
    ...(operations.capabilityOperationContracts?.records ?? []),
  ];
}

const expectedIdentities = [
  "grantMediaConsent", "listMediaConsents", "getMediaConsent", "revokeMediaConsent",
  "submitMediaJob", "listMediaJobs", "getMediaJob", "cancelMediaJob",
  "openMediaStream", "getMediaStream", "connectMediaStream", "submitMediaStreamFrame", "closeMediaStream",
];
const expectedCanonicalOperations = new Map([
  ["grantMediaConsent", "media.operation.consent-record-grant.v1"],
  ["listMediaConsents", "media.operation.consent-record-list.v1"],
  ["getMediaConsent", "media.operation.consent-record-inspect.v1"],
  ["revokeMediaConsent", "media.operation.action.revoke-authorized-consent"],
  ["submitMediaJob", "media.operation.job.submit.v1"],
  ["listMediaJobs", "media.operation.job-list.v1"],
  ["getMediaJob", "media.operation-slice.inspect-job"],
  ["cancelMediaJob", "media.operation-slice.cancel-job"],
  ["openMediaStream", "media.operation.capability.media-stream-session-open"],
  ["getMediaStream", "media.operation.stream-session.inspect.v1"],
  ["connectMediaStream", "media.operation.capability.media-stream-session-connect"],
  ["submitMediaStreamFrame", "media.operation.capability.media-stream-frame-submit"],
  ["closeMediaStream", "media.operation.capability.media-stream-session-close"],
]);
const ownerDefinedOperationIdentities = new Set([
  "grantMediaConsent", "listMediaConsents", "getMediaConsent", "listMediaJobs", "getMediaStream",
]);
const materialWireGaps = new Map([
  ["grantMediaConsent", ["canonical-requestId-required-for-owner-idempotency-but-absent-from-http-grant-request", "authorityRef-and-observedAt-required-by-owner-result-are-absent-from-http-record"]],
  ["listMediaConsents", ["observedAt-and-readVersion-required-by-owner-query-are-absent-from-http-list-response"]],
  ["getMediaConsent", ["observedAt-and-readVersion-required-by-owner-query-are-absent-from-http-record-response"]],
  ["listMediaJobs", ["observedAt-and-readVersion-required-by-owner-query-are-absent-from-http-job-list-response"]],
  ["getMediaStream", ["observedAt-and-readVersion-and-authority-evidence-required-by-owner-query-are-absent-from-open-http-session-schema"]],
]);

function materialAssessmentIsValid(rows) {
  if (rows.length !== expectedIdentities.length) return false;
  const byId = new Map(rows.map((row) => [row.identity, row]));
  if (byId.size !== expectedIdentities.length || expectedIdentities.some((id) => !byId.has(id))) return false;
  for (const record of rows) {
    const separator = record.sourceRef.indexOf("#");
    const operation = pointer(openApi, record.sourceRef.slice(separator + 1));
    if (operation?.operationId !== record.identity || !record.disposition || !record.boundary?.trim()) return false;
    if (record.disposition === "OWNER_DEFINITION_REQUIRED" && record.canonicalOperationRef !== null) return false;
    if (record.disposition === "ADAPTER_REQUIRED" && (!record.canonicalOperationRef || !operationRecords().some(({ id }) => id === record.canonicalOperationRef))) return false;
    if (record.disposition === "ADAPTER_REQUIRED" && record.canonicalOperationRef !== expectedCanonicalOperations.get(record.identity)) return false;
    if (record.disposition === "OWNER_DEFINITION_REQUIRED" && !(record.missingSemantics?.length > 0)) return false;
    if (record.disposition === "ADAPTER_REQUIRED" && !(record.missingRequestSemantics?.length || record.missingSemantics?.length)) return false;
    if (ownerDefinedOperationIdentities.has(record.identity)) {
      const canonical = operationRecords().find(({ id }) => id === record.canonicalOperationRef);
      const gapText = (record.missingSemantics ?? []).join(" ");
      if (!canonical || materialWireGaps.get(record.identity).some((gap) => !gapText.includes(gap))) return false;
      const wireFields = new Set([...(record.requestFields ?? []), ...(record.responseFields ?? []), ...(record.pathFields ?? [])]);
      if (record.identity === "grantMediaConsent") {
        if (!canonical.requestSchema?.required?.includes("requestId") || wireFields.has("requestId")) return false;
        if (!canonical.resultSchema?.required?.includes("authorityRef") || !canonical.resultSchema?.required?.includes("observedAt")) return false;
        if (wireFields.has("authorityRef") || wireFields.has("observedAt")) return false;
      } else {
        if (!canonical.resultSchema?.required?.includes("readVersion") || !canonical.resultSchema?.required?.includes("observedAt")) return false;
        if (wireFields.has("readVersion") || wireFields.has("observedAt")) return false;
        if (record.identity === "getMediaStream" && Object.keys(schemaAt(record.responseSchemaRef)?.properties ?? {}).length !== 0) return false;
      }
    }
    if (record.requestSchemaRef) {
      const schema = schemaAt(record.requestSchemaRef);
      if (!schema || !operation.requestBody || operation.requestBody.content?.["application/json"]?.schema?.$ref !== record.requestSchemaRef.slice(record.requestSchemaRef.indexOf("#"))) return false;
      if (record.requestFields && JSON.stringify(Object.keys(schema.properties ?? {})) !== JSON.stringify(record.requestFields)) return false;
    }
    if (record.responseSchemaRef && record.responseFields) {
      const schema = schemaAt(record.responseSchemaRef);
      if (!schema || JSON.stringify(Object.keys(schema.properties ?? {})) !== JSON.stringify(record.responseFields)) return false;
    }
    if (record.pathFields) {
      const path = record.sourceRef.slice(0, separator).replace("contracts/openapi/media.yaml", "");
      const pathIdentity = pointer(openApi, `/paths/${path.replaceAll("/", "~1")}`);
      const placeholders = [...(Object.keys(openApi.paths).find((candidate) => Object.values(openApi.paths[candidate]).some((entry) => entry.operationId === record.identity)) ?? "").matchAll(/\{([^}]+)\}/gu)].map(([, name]) => name);
      if (record.pathFields.some((name) => !placeholders.includes(name))) return false;
      void pathIdentity;
    }
  }
  const cancel = byId.get("cancelMediaJob");
  if (!cancel.missingResultSemantics?.includes("cancel-requested-versus-cancelled")) return false;
  const revoke = byId.get("revokeMediaConsent");
  if (!revoke.missingRequestSemantics?.includes("explicitConfirmation")) return false;
  const frame = byId.get("submitMediaStreamFrame");
  if (!frame.missingRequestSemantics?.includes("source-frame-clock-and-timebase")) return false;
  return true;
}

test("all 13 HTTP consent, job, and stream candidates have exact adapter gaps and source identities", () => {
  assert.equal(contracts.status.includes("runtimeAdmission: NOT_ADMITTED"), true);
  assert.equal(contracts.status.includes("crossInterfaceAcceptance: OPEN"), true);
  assert.equal(materialAssessmentIsValid(contracts.records), true);
  assert.deepEqual(contracts.records.map(({ identity }) => identity), expectedIdentities);
  assert.equal(contracts.records.filter(({ disposition }) => disposition === "OWNER_DEFINITION_REQUIRED").length, 0);
  assert.equal(contracts.records.filter(({ disposition }) => disposition === "ADAPTER_REQUIRED").length, 13);
  for (const [identity, operationId] of expectedCanonicalOperations) {
    const operation = operationRecords().find(({ id }) => id === operationId);
    const row = contracts.records.find((candidate) => candidate.identity === identity);
    assert.ok(operation, `${identity} binds an exact canonical operation owner definition`);
    assert.equal(row.canonicalOperationRef, operation.id);
    if (ownerDefinedOperationIdentities.has(identity)) {
      assert.ok(operation.sourceRefs?.includes(row.sourceRef), `${identity} owner contract cites the exact OpenAPI operation`);
    }
    assert.notEqual(operation.executionAdmission, "ADMITTED", `${identity} has no execution-admission claim`);
  }
});

test("adapter assessment rejects omission, wrong route, invented operation, and lost consent/finality gaps", () => {
  assert.equal(materialAssessmentIsValid(contracts.records.slice(1)), false, "omitting a source identity cannot pass the denominator");
  const wrongRoute = structuredClone(contracts.records);
  wrongRoute.find(({ identity }) => identity === "revokeMediaConsent").sourceRef = "contracts/openapi/media.yaml#/paths/~1api~1v1~1consents/post";
  assert.equal(materialAssessmentIsValid(wrongRoute), false, "wrong route identity cannot pass by preserving the command label");
  const invented = structuredClone(contracts.records);
  invented.find(({ identity }) => identity === "grantMediaConsent").canonicalOperationRef = "media.operation.consent-grant.v1";
  assert.equal(materialAssessmentIsValid(invented), false, "a nonexistent canonical leaf cannot be inferred from a route name");
  const nameMatch = structuredClone(contracts.records);
  nameMatch.find(({ identity }) => identity === "listMediaConsents").canonicalOperationRef = "media.operation.action.inspect-consent-and-permitted-use";
  assert.equal(materialAssessmentIsValid(nameMatch), false, "a similarly named permitted-use operation cannot substitute for consent-record enumeration");
  const falseFinality = structuredClone(contracts.records);
  falseFinality.find(({ identity }) => identity === "cancelMediaJob").missingResultSemantics = [];
  assert.equal(materialAssessmentIsValid(falseFinality), false, "cancel-requested versus confirmed-cancelled remains a required gap");
  const falseConsent = structuredClone(contracts.records);
  falseConsent.find(({ identity }) => identity === "revokeMediaConsent").missingRequestSemantics = [];
  assert.equal(materialAssessmentIsValid(falseConsent), false, "explicit authority/scope inputs cannot disappear from the adapter assessment");
});
