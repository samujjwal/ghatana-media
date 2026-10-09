import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  canonicalJsonFingerprint,
  classifyTranscriptReadResult,
  projectLegacyArtifactMetadata,
} from "../scripts/lib/pdp2-read-consumer-adapters.mjs";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const yaml = require("yaml");
const Ajv2020 = require("ajv/dist/2020").default ?? require("ajv/dist/2020");
const addFormats = require("ajv-formats").default ?? require("ajv-formats");
const read = (path) => yaml.parse(readFileSync(resolve(process.cwd(), path), "utf8"));
function resolveYamlSelector(document, selector) {
  const marker = selector.indexOf("#");
  assert.notEqual(marker, -1, `selector has fragment: ${selector}`);
  const segments = selector.slice(marker + 1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  return segments.reduce((value, segment) => {
    if (segment.startsWith("@id=")) {
      assert.ok(Array.isArray(value), `${selector}: @id selector must address an array`);
      const id = segment.slice(4);
      return value.find((row) => row?.id === id);
    }
    return value?.[segment];
  }, document);
}
const adapters = read(".product-experience/pdp-2-design-interface-system/api/read-consumer-adapters.yaml");
const operations = read(".product-experience/pdp-1-domain-data/operations.yaml");
const domainObjects = read(".product-experience/pdp-1-domain-data/domain-objects.yaml");
const artifact = adapters.ownerDefinedReadAdapters.records.find(({ id }) => id === "media.pdp2.read-adapter.artifact-metadata.v1");
const transcript = adapters.ownerDefinedReadAdapters.records.find(({ id }) => id === "media.pdp2.read-adapter.transcript-version.v1");
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
addFormats(ajv);
ajv.addFormat("opaque-id", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
ajv.addFormat("opaque-version-id", /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u);
const validateArtifactSource = ajv.compile(artifact.observedLegacyTransport.responseSchema);
const validateArtifactObservation = ajv.compile(artifact.observedLegacyTransport.consumerObservationSchema);
const validateTranscriptCanonical = ajv.compile(transcript.canonicalResponseSchema);
const validateTranscriptLegacy = ajv.compile(transcript.legacyResponse.responseSchema);
const validateTrustedReceipt = ajv.compile(transcript.trustedReadReceiptSchema);
const validateExpectedRead = ajv.compile(transcript.expectedHostReadTupleSchema);
const validateTranscriptRequest = ajv.compile(transcript.requestSchema);
const host = { tenantId: "tenant-1", principalId: "principal-1", hostProof: "fixture-host-proof" };

const digest = canonicalJsonFingerprint;

const legacyArtifact = () => ({
  tenantId: host.tenantId,
  principalId: host.principalId,
  artifactId: "artifact-1",
  fileName: "clip.mp4",
  contentType: "video/mp4",
  sizeBytes: 15,
  sha256: "a".repeat(64),
  objectReference: "opaque-object-ref",
  classification: "INTERNAL",
  createdAt: "2026-10-09T12:00:00Z",
  expiresAt: "2026-10-10T12:00:00Z",
  metadata: { purpose: "review", arbitrary: { source: "legacy" } },
});

const canonicalTranscript = () => ({
  observationKind: "CANONICAL_TRANSCRIPT_VERSION_OBSERVATION",
  tenantId: host.tenantId,
  transcriptVersionId: "trv-7",
  sourceArtifactId: "artifact-1",
  sourceArtifactVersionId: "av-9",
  textAvailability: "NOT_SUPPLIED",
  segmentsAvailability: "NOT_SUPPLIED",
  languageAvailability: "NOT_SUPPLIED",
  uncertaintyAvailability: "NOT_SUPPLIED",
  timingAvailability: "NOT_SUPPLIED",
  sourceClockAvailability: "NOT_AVAILABLE",
  evidenceAvailability: "NOT_SUPPLIED",
  observedAt: "2026-10-09T12:00:00Z",
});
const expectedTranscriptRead = (payload = canonicalTranscript()) => ({
  queryId: "media.operation.transcript-version-read",
  method: "EXACT_TRANSCRIPT_VERSION_READ",
  tenantId: host.tenantId,
  principalId: host.principalId,
  transcriptVersionId: payload.transcriptVersionId,
  sourceArtifactId: payload.sourceArtifactId,
  sourceArtifactVersionId: payload.sourceArtifactVersionId,
  readVersion: "read-v1",
  policyRevision: "policy-revision-1",
  authorityRef: ".product-experience/pdp-1-domain-data/authority.yaml#ownership/identityAuthenticationAndDelegation",
  policyDecisionRef: ".product-experience/pdp-0-product-truth/policy-authority-model.yaml#productPolicy",
});
const transcriptReadReceipt = (payload = canonicalTranscript()) => ({
  receiptId: "read-receipt-1",
  ...expectedTranscriptRead(payload),
  requestFingerprint: digest({ operationRef: "media.operation.transcript-version-read", tenantId: host.tenantId, principalId: host.principalId, transcriptVersionId: payload.transcriptVersionId }),
  payloadFingerprint: digest(payload),
  currentness: "CURRENT",
  checkedAt: "2026-10-09T12:00:00Z",
  expiresAt: "2026-10-09T12:00:30Z",
  hostIssuedProof: "fixture-host-proof",
});
const verifyHostReadReceipt = (receipt, { trustedContext, request, payload, expectedRead }) =>
  validateTrustedReceipt(receipt)
  && receipt.tenantId === trustedContext.tenantId
  && receipt.principalId === trustedContext.principalId
  && receipt.transcriptVersionId === request.transcriptVersionId
  && receipt.sourceArtifactId === payload.sourceArtifactId
  && receipt.sourceArtifactVersionId === payload.sourceArtifactVersionId
  && Date.parse(receipt.checkedAt) <= Date.parse("2026-10-09T12:00:00Z")
  && Date.parse(receipt.expiresAt) > Date.parse("2026-10-09T12:00:00Z")
  && receipt.hostIssuedProof === trustedContext.hostProof
  && receipt.authorityRef === expectedRead.authorityRef
  && receipt.policyDecisionRef === expectedRead.policyDecisionRef
  && receipt.policyRevision === expectedRead.policyRevision
  && receipt.method === expectedRead.method
  && receipt.readVersion === expectedRead.readVersion
  && receipt.requestFingerprint === digest(request)
  && receipt.payloadFingerprint === digest(payload);

const legacyTranscript = () => ({
  artifactId: "legacy-audio-1",
  transcriptArtifactId: "legacy-transcript-1",
  text: "spoken words",
  languageTag: "en-US",
  confidence: 0.8,
  words: [{ text: "spoken", startMs: 12, endMs: 30, confidence: 0.75 }],
  alternatives: [{ text: "token", confidence: 0.2 }],
  providerId: "provider-1",
  modelId: "model-1",
  modelVersion: "v1",
  processingTimeMs: 4,
});

test("artifact source read is exact Java observation and never canonical version proof", () => {
  const javaShape = artifact.observedLegacyTransport.responseSchema;
  assert.deepEqual(javaShape.required, ["tenantId", "principalId", "artifactId", "fileName", "contentType", "sizeBytes", "sha256", "objectReference", "classification", "createdAt", "expiresAt", "metadata"]);
  assert.equal(artifact.observedLegacyTransport.method, "GET");
  assert.equal(artifact.observedLegacyTransport.path, "/api/v1/artifacts/{artifactId}");
  assert.equal(artifact.observedLegacyTransport.exactVersionRead.operationRef, "media.operation-slice.inspect-artifact-version");
  assert.equal(resolveYamlSelector(operations, artifact.observedLegacyTransport.exactVersionRead.requestSchemaRef),
    operations.ownerDefinedOperationContracts.records.find(({ id }) => id === "media.operation-slice.inspect-artifact-version").ownerWireSchema.requestSchema);
  assert.equal(resolveYamlSelector(operations, artifact.observedLegacyTransport.exactVersionRead.resultSchemaRef),
    operations.ownerDefinedOperationContracts.records.find(({ id }) => id === "media.operation-slice.inspect-artifact-version").ownerWireSchema.resultSchema);
  const exactVersionOwner = operations.ownerDefinedOperationContracts.records.find(({ id }) => id === artifact.observedLegacyTransport.exactVersionRead.operationRef);
  assert.ok(exactVersionOwner?.ownerWireSchema?.requestSchema);
  assert.ok(exactVersionOwner?.ownerWireSchema?.resultSchema);
  const validateExactVersionRequest = ajv.compile(exactVersionOwner.ownerWireSchema.requestSchema);
  assert.equal(validateExactVersionRequest({ artifactId: "artifact-1", artifactVersionId: "version-1" }), true);
  assert.equal(validateExactVersionRequest({ artifactId: "artifact-1" }), false);
  assert.equal(validateExactVersionRequest({ artifactId: "artifact-1", artifactVersionId: "latest" , tenantId: "attacker" }), false);
  assert.ok(operations.individualOperationContracts.records.some(({ id }) => id === "media.operation-slice.inspect-artifact"));

  const payload = legacyArtifact();
  assert.equal(validateArtifactSource(payload), true);
  assert.deepEqual(Object.keys(artifact.observedLegacyTransport.consumerObservationSchema.properties.artifact.properties), Object.keys(artifact.observedLegacyTransport.responseSchema.properties));
  const projected = projectLegacyArtifactMetadata({ payload, trustedContext: host, validateSourcePayload: validateArtifactSource, verifyHostContext: (context) => context === host && context.hostProof === "fixture-host-proof" });
  assert.equal(projected.status, "OBSERVED");
  assert.equal(validateArtifactObservation(projected.observation), true);
  assert.equal(projected.observation.kind, "LEGACY_ARTIFACT_METADATA_OBSERVATION");
  assert.equal(projected.observation.artifact.artifactId, "artifact-1");
  assert.equal("artifactVersionId" in projected.observation.artifact, false);

  const verifyHostContext = (context) => context === host && context.hostProof === "fixture-host-proof";
  assert.equal(projectLegacyArtifactMetadata({ payload, trustedContext: { ...host, principalId: "other" }, validateSourcePayload: validateArtifactSource, verifyHostContext }).status, "UNKNOWN");
  assert.equal(projectLegacyArtifactMetadata({ payload: { ...payload, tenantId: "other" }, trustedContext: host, validateSourcePayload: validateArtifactSource, verifyHostContext }).status, "DENIED");
  assert.equal(projectLegacyArtifactMetadata({ payload: { ...payload, expiresAt: "invalid" }, trustedContext: host, validateSourcePayload: validateArtifactSource, verifyHostContext }).status, "UNKNOWN");
  assert.equal(projectLegacyArtifactMetadata({ payload, trustedContext: host, validateSourcePayload: validateArtifactSource, verifyHostContext: () => false }).status, "UNKNOWN");
  assert.equal(projectLegacyArtifactMetadata({ payload, trustedContext: host, validateSourcePayload: () => { throw new Error("validator failed"); }, verifyHostContext }).status, "UNKNOWN");
  assert.equal(projectLegacyArtifactMetadata({ payload: { ...payload, metadata: { callback() {} } }, trustedContext: host, validateSourcePayload: validateArtifactSource, verifyHostContext }).status, "UNKNOWN",
    "open metadata cannot smuggle non-JSON functions through a direct JS caller");
  assert.equal(projectLegacyArtifactMetadata({ payload: { ...payload, metadata: { missing: undefined } }, trustedContext: host, validateSourcePayload: validateArtifactSource, verifyHostContext }).status, "UNKNOWN",
    "undefined metadata values are rejected rather than normalized away");
  const cyclic = { ...payload, metadata: {} };
  cyclic.metadata.self = cyclic.metadata;
  assert.equal(projectLegacyArtifactMetadata({ payload: cyclic, trustedContext: host, validateSourcePayload: validateArtifactSource, verifyHostContext }).status, "UNKNOWN",
    "cyclic direct-call values fail closed");
  assert.equal(validateArtifactSource({ ...payload, artifactVersionId: "guessed" }), false, "legacy payload cannot carry an invented canonical version field");
  assert.equal(validateArtifactSource({ ...payload, objectReference: "" }), false);
  assert.equal(validateArtifactSource({ ...payload, sizeBytes: 0 }), false);
  assert.equal(validateArtifactObservation({ ...projected.observation, artifact: { ...payload, rightsCurrent: true } }), false);
});

test("transcript exact-version schema preserves explicit absence and validates clock-bound branches", () => {
  assert.ok(operations.operations.some(({ id }) => id === transcript.canonicalOperationRef));
  assert.ok(domainObjects.objects.some(({ id }) => id === "media.domain.transcript-version"));
  assert.equal(resolveYamlSelector(operations, transcript.canonicalOperationSourceRef),
    operations.operations.find(({ id }) => id === "media.operation.transcript-version-read"));
  assert.equal(resolveYamlSelector(domainObjects, transcript.canonicalDomainObjectRef),
    domainObjects.objects.find(({ id }) => id === "media.domain.transcript-version"));
  assert.equal(transcript.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(validateTranscriptCanonical(canonicalTranscript()), true);
  assert.equal(ajv.compile(transcript.requestSchema)({ transcriptVersionId: "trv-7" }), true);
  assert.equal(ajv.compile(transcript.requestSchema)({ transcriptVersionId: "trv-7", tenantId: "tenant-1" }), false, "host identity cannot be supplied in caller request");

  const withText = { ...canonicalTranscript(), textAvailability: "AVAILABLE", text: "hello" };
  assert.equal(validateTranscriptCanonical(withText), true);
  assert.equal(validateTranscriptCanonical({ ...withText, text: undefined }), false);
  assert.equal(validateTranscriptCanonical({ ...canonicalTranscript(), text: "invented while unavailable" }), false);
  assert.equal(validateTranscriptCanonical({ ...canonicalTranscript(), transcriptVersionId: undefined }), false);
  assert.equal(validateTranscriptCanonical({ ...canonicalTranscript(), transcriptVersionId: "trv-other" }), true, "schema alone does not prove requested tuple; the adapter compares it below");

  const sourceClockBound = {
    ...canonicalTranscript(),
    segmentsAvailability: "AVAILABLE",
    segments: [{ segmentId: "seg-1", text: "hello", origin: "PROVIDER" }],
    timingAvailability: "SOURCE_CLOCK_BOUND",
    timingObservations: [{ segmentId: "seg-1", start: "12", end: "18", unit: "SOURCE_TICKS", timingOrigin: "AUTHORITATIVE_SOURCE_CLOCK" }],
    sourceClockAvailability: "AUTHORITATIVELY_BOUND",
    sourceClockId: "clock-1",
    ticksPerSecond: "24000",
    sourceDurationTicks: "90000",
    sourceClockMappingEvidenceRef: "evidence:clock-map-1",
  };
  assert.equal(validateTranscriptCanonical(sourceClockBound), true);
  assert.equal(validateTranscriptCanonical({ ...sourceClockBound, timingObservations: [{ segmentId: "seg-1", start: "12", end: "18", unit: "MILLISECONDS", timingOrigin: "PROVIDER_UNQUALIFIED" }] }), false);
  assert.equal(validateTranscriptCanonical({ ...sourceClockBound, ticksPerSecond: "0" }), false);
  assert.equal(validateTranscriptCanonical({ ...sourceClockBound, ticksPerSecond: "9007199254740992" }), true, "schema validates decimal syntax; semantic owner validator enforces exact safe-integer ceiling");
  assert.equal(validateTranscriptCanonical({ ...sourceClockBound, sourceClockAvailability: "NOT_AVAILABLE" }), false);

  const providerTime = {
    ...canonicalTranscript(),
    segmentsAvailability: "AVAILABLE",
    segments: [{ segmentId: "seg-1", text: "hello", origin: "PROVIDER" }],
    timingAvailability: "PROVIDER_TIME_UNQUALIFIED",
    timingObservations: [{ segmentId: "seg-1", start: "12", end: "18", unit: "MILLISECONDS", timingOrigin: "PROVIDER_UNQUALIFIED" }],
  };
  assert.equal(validateTranscriptCanonical(providerTime), true);
  assert.equal(validateTranscriptCanonical({ ...providerTime, timingObservations: [{ segmentId: "seg-1", start: "12", end: "18", unit: "SOURCE_TICKS", timingOrigin: "AUTHORITATIVE_SOURCE_CLOCK" }] }), false);
});

test("canonical and legacy transcript branches remain disjoint and identity-bound", () => {
  const canonical = canonicalTranscript();
const read = (payload, trustedRead = transcriptReadReceipt(payload), expectedRead = expectedTranscriptRead(payload), hostNow = "2026-10-09T12:00:00Z") => classifyTranscriptReadResult({
    payload,
    request: { transcriptVersionId: "trv-7" },
    trustedContext: host,
    trustedRead,
    expectedRead,
    hostNow,
    validateExpectedRead,
    validateTrustedRead: validateTrustedReceipt,
    validateRequest: validateTranscriptRequest,
    verifyExpectedRead: (tuple) => tuple.tenantId === host.tenantId && tuple.principalId === host.principalId && tuple.readVersion === "read-v1",
    verifyTrustedRead: verifyHostReadReceipt,
    validateCanonical: validateTranscriptCanonical,
    validateLegacy: validateTranscriptLegacy,
  });
  assert.equal(read(canonical).status, "OBSERVED");
  assert.equal(read({ ...canonical, transcriptVersionId: "trv-other" }).status, "UNKNOWN");
  assert.equal(read({ ...canonical, tenantId: "tenant-other" }).status, "UNKNOWN");
  assert.equal(read({ ...canonical, sourceArtifactVersionId: "" }).status, "UNKNOWN");
  assert.equal(read(canonical, { ...transcriptReadReceipt(canonical), currentness: "STALE" }).status, "UNKNOWN");
  assert.equal(read(canonical, { ...transcriptReadReceipt(canonical), principalId: "principal-other" }).status, "UNKNOWN");
  assert.equal(read(canonical, { ...transcriptReadReceipt(canonical), sourceArtifactVersionId: "av-other" }).status, "UNKNOWN");
  assert.equal(read(canonical, { ...transcriptReadReceipt(canonical), expiresAt: "2026-10-09T11:59:59Z" }).status, "UNKNOWN");
  assert.equal(read(canonical, { ...transcriptReadReceipt(canonical), payloadFingerprint: `sha256:${"0".repeat(64)}` }).status, "UNKNOWN");
  assert.equal(read(canonical, { ...transcriptReadReceipt(canonical), requestFingerprint: `sha256:${"0".repeat(64)}` }).status, "UNKNOWN");
  assert.equal(read(canonical, { ...transcriptReadReceipt(canonical), hostIssuedProof: "forged" }).status, "UNKNOWN");
  assert.equal(read(canonical, { ...transcriptReadReceipt(canonical), unexpected: "extra" }).status, "UNKNOWN", "helper itself enforces the closed receipt schema");
  assert.equal(read(canonical, transcriptReadReceipt(canonical), { ...expectedTranscriptRead(canonical), sourceArtifactVersionId: "foreign-version" }).status, "UNKNOWN");
  assert.equal(read(canonical, transcriptReadReceipt(canonical), { ...expectedTranscriptRead(canonical), unexpected: "extra" }).status, "UNKNOWN", "expected trusted tuple is closed too");
  assert.equal(read(canonical, transcriptReadReceipt(canonical), expectedTranscriptRead(canonical), "2026-02-30T12:00:00Z").status, "UNKNOWN");
  assert.equal(read(canonical, { ...transcriptReadReceipt(canonical), checkedAt: "2026-02-30T12:00:00Z" }).status, "UNKNOWN");
  assert.equal(read(canonical, { ...transcriptReadReceipt(canonical), checkedAt: "2026-10-09T05:00:00-07:00" }).status, "UNKNOWN");
  assert.equal(read(canonical, { ...transcriptReadReceipt(canonical), checkedAt: "2026-10-09T11:00:00Z", expiresAt: "2026-10-09T11:00:30Z" }).status, "UNKNOWN");
  assert.equal(read(canonical, { ...transcriptReadReceipt(canonical), checkedAt: "2026-10-09T12:00:01Z" }).status, "UNKNOWN");
  const timed = {
    ...canonical,
    segmentsAvailability: "AVAILABLE",
    segments: [{ segmentId: "seg-1", text: "hello", origin: "PROVIDER" }],
    timingAvailability: "SOURCE_CLOCK_BOUND",
    timingObservations: [{ segmentId: "seg-1", start: "9000000000000000", end: "9007199254740990", unit: "SOURCE_TICKS", timingOrigin: "AUTHORITATIVE_SOURCE_CLOCK" }],
    sourceClockAvailability: "AUTHORITATIVELY_BOUND",
    sourceClockId: "clock-1",
    ticksPerSecond: "24000",
    sourceDurationTicks: "9007199254740991",
    sourceClockMappingEvidenceRef: "evidence:clock-map-1",
  };
  assert.equal(validateTranscriptCanonical(timed), true);
  assert.equal(read(timed).status, "OBSERVED", "safe integer decimal values near MAX_SAFE_INTEGER remain available");
  assert.equal(read({ ...timed, timingObservations: [{ ...timed.timingObservations[0], end: "9007199254740992" }] }).status, "UNKNOWN",
    "syntactically valid decimal text above MAX_SAFE_INTEGER is rejected semantically");
  assert.equal(read({ ...timed, timingObservations: [{ ...timed.timingObservations[0], end: "10" }] }).status, "UNKNOWN",
    "reversed interval fails closed");
  assert.equal(read({ ...timed, timingObservations: [{ ...timed.timingObservations[0], segmentId: "missing-segment" }] }).status, "UNKNOWN",
    "unresolved segment association is UNKNOWN");
  assert.equal(read({ ...timed, timingObservations: [{ ...timed.timingObservations[0], end: "9007199254740992" }] }).status, "UNKNOWN");
  assert.equal(read({ ...timed, sourceDurationTicks: "100", timingObservations: [{ ...timed.timingObservations[0], start: "12", end: "180" }] }).status, "UNKNOWN",
    "source-clock interval cannot exceed the exact duration");
  assert.equal(read({ ...canonical, sourceDurationTicks: "9007199254740992" }).status, "UNKNOWN",
    "source duration is bounded even when no timing intervals are supplied");
  assert.equal(read({ ...canonical, sourceDurationTicks: "01" }).status, "UNKNOWN",
    "source duration must use bounded canonical decimal syntax");
  assert.equal(classifyTranscriptReadResult({ payload: canonical, request: { transcriptVersionId: "trv-7", principalId: "attacker" }, trustedContext: host, validateRequest: validateTranscriptRequest }).status, "DENIED");

  const legacy = legacyTranscript();
  assert.equal(validateTranscriptLegacy(legacy), true);
  const result = read(legacy, {}, {});
  assert.equal(result.status, "LEGACY_UNSCOPED_OBSERVATION");
  assert.equal(result.canonicalTranscriptVersion, "NOT_ESTABLISHED");
  assert.equal(result.displayAuthorization, "NOT_ESTABLISHED");
  assert.equal(Object.hasOwn(result, "payload"), false, "unscoped legacy transcript text is never exposed");
  assert.equal(read({ ...legacy, sourceClockId: "guessed" }, {}, {}).status, "UNKNOWN", "source-clock fields cannot be spliced into the closed legacy result");
  assert.equal(validateTranscriptLegacy({ ...legacy, confidence: 1.1 }), false);
  assert.equal(validateTranscriptLegacy({ ...legacy, words: [{ text: "x", startMs: -1, endMs: 4, confidence: 0.5 }] }), false);
  assert.equal(validateTranscriptLegacy({ ...legacy, canonicalTranscriptVersionId: "invented" }), false);
  assert.equal(read({ ...legacy, transcriptVersionId: "trv-7", sourceArtifactVersionId: "av-9" }, {}, {}).status, "UNKNOWN", "unrecognized hybrids must not receive either branch's authority");
});

test("canonical fingerprinting refuses values outside the JSON data model", () => {
  assert.throws(() => digest({ value: undefined }), /undefined/u);
  const sparse = [];
  sparse.length = 1;
  assert.throws(() => digest(sparse), /sparse arrays/u);
  assert.throws(() => digest({ value: Number.NaN }), /non-finite/u);
  assert.throws(() => digest({ value: 1n }), /JSON values only/u);
  assert.throws(() => digest(new Date("2026-10-09T12:00:00Z")), /plain objects only/u);
});
