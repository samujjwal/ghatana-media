import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const Ajv = require("ajv").default;
const addFormats = require("ajv-formats");
const operations = parse(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/operations.yaml"), "utf8"));
const ids = [
  "media.operation.stt.profile.create.v1",
  "media.operation.stt.profile.get.v1",
  "media.operation.stt.profile.update.v1",
  "media.operation.stt.profile.adapt.v1",
];
const byId = new Map(operations.ownerDefinedOperationContracts.records.map((record) => [record.id, record]));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

test("STT profile operations define typed, tenant-scoped, versioned Media semantics without runtime admission", () => {
  const contracts = ids.map((id) => {
    const record = byId.get(id);
    assert.ok(record, `${id} has a stable exact owner operation identity`);
    assert.equal(record.scopeStatus.includes("NOT_ADMITTED"), true);
    assert.equal(record.trustedContext.tenantId, "host-attested; not request body");
    assert.equal(record.trustedContext.principalId, "host-attested; not request body");
    assert.ok(record.sourceRefs.some((ref) => ref.includes("stt_service.proto#")));
    assert.equal(record.requestSchema.additionalProperties, false);
    assert.equal(record.resultSchema.additionalProperties, false);
    assert.equal(ajv.compile(record.requestSchema)({}), false);
    assert.equal(typeof ajv.compile(record.resultSchema), "function");
    return record;
  });
  assert.deepEqual(contracts.map(({ operationKind }) => operationKind), ["COMMAND", "QUERY", "COMMAND", "COMMAND"]);

  const create = byId.get(ids[0]);
  const createRequest = {
    displayName: "Interview vocabulary",
    enrollmentSamples: [{
      sampleRef: "artifact-version-enrollment-1", mediaType: "audio/wav", sampleRateHz: 16000,
      channelCount: 1, durationMs: 5000, contentDigest: "a".repeat(64),
    }],
    requestedSettings: { preferredLanguage: "en-US", adaptationMode: "DISABLED", privacyLevel: "PRIVATE" },
    consentRef: "consent-profile-enrollment-1", requestId: "request-create-profile-1",
  };
  const validateCreate = ajv.compile(create.requestSchema);
  assert.equal(validateCreate(createRequest), true, JSON.stringify(validateCreate.errors));
  assert.equal(validateCreate({ ...createRequest, tenantId: "caller-tenant" }), false, "trusted tenant cannot be overposted");
  assert.equal(validateCreate({ ...createRequest, consentRef: undefined }), false, "enrollment requires explicit consent identity");
  const validateCreateResult = ajv.compile(create.resultSchema);
  const created = {
    profileId: "profile-1", profileVersionId: "profile-version-1", tenantId: "tenant-1",
    createdByPrincipalId: "principal-1", consentRef: "consent-profile-enrollment-1",
    createdAt: "2026-10-09T15:30:00Z", receiptRef: "receipt-create-profile-1",
  };
  assert.equal(validateCreateResult(created), true, JSON.stringify(validateCreateResult.errors));
  assert.equal(validateCreateResult({ ...created, providerReady: true }), false, "profile receipt cannot assert runtime readiness");

  const get = byId.get(ids[1]);
  const validateGet = ajv.compile(get.requestSchema);
  assert.equal(validateGet({ profileId: "profile-1", profileVersionId: "profile-version-2" }), true);
  assert.equal(validateGet({ profileId: "profile-1" }), false, "reads are exact-version, never implicit latest");
  const validateGetResult = ajv.compile(get.resultSchema);
  assert.equal(validateGetResult({
    profileId: "profile-1", profileVersionId: "profile-version-2", tenantId: "tenant-1",
    displayName: "Interview vocabulary",
    settings: { preferredLanguage: "en-US", adaptationMode: "DISABLED", privacyLevel: "PRIVATE" },
    customVocabulary: ["Aurelia"], createdAt: "2026-10-09T15:30:00Z", observedAt: "2026-10-09T15:31:00Z",
  }), true, JSON.stringify(validateGetResult.errors));

  const update = byId.get(ids[2]);
  const validateUpdate = ajv.compile(update.requestSchema);
  assert.equal(validateUpdate({ profileId: "profile-1", expectedProfileVersionId: "profile-version-2", preferredLanguage: "fr-FR", requestId: "request-update-1" }), true);
  assert.equal(validateUpdate({ profileId: "profile-1", preferredLanguage: "fr-FR", requestId: "request-update-1" }), false, "update requires current-head CAS identity");
  assert.match(update.effect, /every other profile field is unchanged/u);
  const validateUpdateResult = ajv.compile(update.resultSchema);
  assert.equal(validateUpdateResult({
    profileId: "profile-1", priorProfileVersionId: "profile-version-2", profileVersionId: "profile-version-3",
    tenantId: "tenant-1", preferredLanguage: "fr-FR", receiptRef: "receipt-update-1", committedAt: "2026-10-09T15:32:00Z",
  }), true, JSON.stringify(validateUpdateResult.errors));

  const adapt = byId.get(ids[3]);
  const validateAdapt = ajv.compile(adapt.requestSchema);
  const adaptation = {
    profileId: "profile-1", expectedProfileVersionId: "profile-version-2", consentRef: "consent-adapt-1", requestId: "request-adapt-1",
    correctionExamples: [{ sourceTextRef: "transcript-version-8", correctedText: "Aurelia", userConfirmed: true }],
  };
  assert.equal(validateAdapt(adaptation), true, JSON.stringify(validateAdapt.errors));
  assert.equal(validateAdapt({ ...adaptation, correctionExamples: [{ ...adaptation.correctionExamples[0], userConfirmed: false }] }), false,
    "unconfirmed corrections cannot mutate the profile");
  assert.match(adapt.effect, /distinct normalized vocabulary additions/u);
  const validateAdaptResult = ajv.compile(adapt.resultSchema);
  assert.equal(validateAdaptResult({
    profileId: "profile-1", priorProfileVersionId: "profile-version-2", profileVersionId: "profile-version-3",
    tenantId: "tenant-1", acceptedCorrectionCount: 1, addedVocabularyCount: 1,
    consentRef: "consent-adapt-1", receiptRef: "receipt-adapt-1", committedAt: "2026-10-09T15:33:00Z",
  }), true, JSON.stringify(validateAdaptResult.errors));
  for (const record of contracts.filter(({ operationKind }) => operationKind === "COMMAND")) {
    assert.ok(record.errors.includes("UNKNOWN_OUTCOME"), `${record.id} keeps ambiguous commit explicit`);
    assert.match(record.recovery, /reconcil|unknown outcome/iu);
  }
});
