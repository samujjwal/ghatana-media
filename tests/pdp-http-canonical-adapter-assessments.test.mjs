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
    if (record.disposition === "OWNER_DEFINITION_REQUIRED" && !(record.missingSemantics?.length > 0)) return false;
    if (record.disposition === "ADAPTER_REQUIRED" && !(record.missingRequestSemantics?.length || record.missingSemantics?.length)) return false;
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
  assert.equal(contracts.records.filter(({ disposition }) => disposition === "OWNER_DEFINITION_REQUIRED").length, 3);
  assert.equal(contracts.records.filter(({ disposition }) => disposition === "ADAPTER_REQUIRED").length, 10);
});

test("adapter assessment rejects omission, wrong route, invented operation, and lost consent/finality gaps", () => {
  assert.equal(materialAssessmentIsValid(contracts.records.slice(1)), false, "omitting a source identity cannot pass the denominator");
  const wrongRoute = structuredClone(contracts.records);
  wrongRoute.find(({ identity }) => identity === "revokeMediaConsent").sourceRef = "contracts/openapi/media.yaml#/paths/~1api~1v1~1consents/post";
  assert.equal(materialAssessmentIsValid(wrongRoute), false, "wrong route identity cannot pass by preserving the command label");
  const invented = structuredClone(contracts.records);
  invented.find(({ identity }) => identity === "grantMediaConsent").canonicalOperationRef = "media.operation.consent-grant.v1";
  assert.equal(materialAssessmentIsValid(invented), false, "a nonexistent canonical leaf cannot be inferred from a route name");
  const falseFinality = structuredClone(contracts.records);
  falseFinality.find(({ identity }) => identity === "cancelMediaJob").missingResultSemantics = [];
  assert.equal(materialAssessmentIsValid(falseFinality), false, "cancel-requested versus confirmed-cancelled remains a required gap");
  const falseConsent = structuredClone(contracts.records);
  falseConsent.find(({ identity }) => identity === "revokeMediaConsent").missingRequestSemantics = [];
  assert.equal(materialAssessmentIsValid(falseConsent), false, "explicit authority/scope inputs cannot disappear from the adapter assessment");
});
