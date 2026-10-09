import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { typedObservationRequestFingerprint } from "../scripts/lib/pdp-truth-domain-observation-currentness.mjs";
import { evaluatePdp3RightsGuardFact } from "../scripts/lib/pdp3-guard-fact-evaluator.mjs";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const parse = require("yaml").parse;
const operations = parse(readFileSync(".product-experience/pdp-1-domain-data/operations.yaml", "utf8"));
const contract = operations.ownerTypedObservationContracts.records.find((row) => row.id === "media.observation-contract.rights-decision.v1");
const now = "2026-10-09T12:00:00Z";
const expected = {
  tenantScopeRef: "tenant-A", principalRef: "principal-A", subjectArtifactVersionRef: "artifact-version-17",
  purposeRef: "purpose-caption", useRef: "use-transcription", regionRef: "region-US",
  retentionPolicyRef: "retention-policy-v3", now, maxAgeMs: 60_000,
};

function example(schema) {
  if (Object.hasOwn(schema, "const")) return structuredClone(schema.const);
  if (schema.enum) return schema.enum[0];
  if (schema.type === "object") return Object.fromEntries((schema.required ?? []).map((key) => [key, example(schema.properties[key])]));
  if (schema.type === "array") return Array.from({ length: schema.minItems ?? 0 }, () => example(schema.items));
  if (schema.type === "string") return schema.format === "date-time" ? now : "ref-1";
  if (schema.type === "integer" || schema.type === "number") return schema.minimum ?? 1;
  return {};
}

function evidence(decisionKind, { effectDisposition = "PERMITTED", tenantScopeRef = expected.tenantScopeRef, subjectRef = expected.subjectArtifactVersionRef, observedAt = now, readVersion = `read-${decisionKind}` } = {}) {
  const request = example(contract.requestSchema);
  Object.assign(request, {
    queryId: `query-${decisionKind}`,
    subjectArtifactVersionRef: expected.subjectArtifactVersionRef,
    decisionKind,
    purposeRef: expected.purposeRef,
    useRef: expected.useRef,
    regionRef: expected.regionRef,
    retentionPolicyRef: expected.retentionPolicyRef,
  });
  const trusted = {
    tenantScopeRef,
    principalRef: expected.principalRef,
    expectedOperationRef: contract.operationRefs[0],
    expectedReadAuthorityRef: contract.readAuthorityRefs[0],
    expectedReadVersion: readVersion,
  };
  const result = example(contract.resultSchema);
  Object.assign(result, {
    tenantScopeRef,
    principalRef: expected.principalRef,
    queryId: request.queryId,
    operationRef: contract.operationRefs[0],
    readAuthorityRef: contract.readAuthorityRefs[0],
    currentness: "CURRENT",
    observedAt,
    readVersion,
    requestFingerprint: typedObservationRequestFingerprint(request, trusted),
    decisionKind,
    observationStatus: effectDisposition === "PERMITTED" ? "ALLOWED_FOR_DECLARED_SCOPE" : effectDisposition,
    decision: {
      tenantScopeRef,
      principalRef: expected.principalRef,
      subjectArtifactVersionRef: subjectRef,
      decisionKind,
      purposeRef: expected.purposeRef,
      useRef: expected.useRef,
      regionRef: expected.regionRef,
      retentionPolicyRef: expected.retentionPolicyRef,
      authorityRef: "authority-record-4",
      authorityVersionRef: "authority-version-4",
      effectDisposition,
      validFrom: "2026-10-09T11:00:00Z",
      validUntil: "2026-10-09T13:00:00Z",
      evidenceRefs: ["rights-evidence-4"],
    },
  });
  return { request, result, trusted };
}

const paired = () => [evidence("RIGHTS"), evidence("CONSENT")];

test("rights/consent guard derives only from two exact current permitted query receipts", () => {
  const result = evaluatePdp3RightsGuardFact({ guardRef: "current-rights-and-consent", evidence: paired(), expected });
  assert.deepEqual(result, { truth: "TRUE", reason: "EXACT_CURRENT_RIGHTS_AND_CONSENT_TUPLE_MATCH", effect: "NONE", retryAuthorized: false, runtimeAdmission: "NOT_ADMITTED" });
  assert.equal(evaluatePdp3RightsGuardFact({ guardRef: "rights-and-retention-rechecked", evidence: paired(), expected }).truth, "TRUE");
  const one = evidence("CONSENT");
  assert.equal(evaluatePdp3RightsGuardFact({ guardRef: "media.guard.stream.reconnect.current-consent", evidence: [one], expected }).truth, "TRUE");
});

test("rights/consent guard holds on missing, stale, foreign, mismatched, or malformed facts", () => {
  assert.equal(evaluatePdp3RightsGuardFact({ guardRef: "current-rights-and-consent", evidence: [evidence("RIGHTS")], expected }).truth, "UNKNOWN");
  assert.equal(evaluatePdp3RightsGuardFact({ guardRef: "current-rights-and-consent", evidence: [evidence("RIGHTS", { observedAt: "2026-10-09T11:00:00Z" }), evidence("CONSENT")], expected }).truth, "UNKNOWN");
  assert.equal(evaluatePdp3RightsGuardFact({ guardRef: "current-rights-and-consent", evidence: [evidence("RIGHTS", { tenantScopeRef: "tenant-B" }), evidence("CONSENT")], expected }).truth, "UNKNOWN");
  assert.equal(evaluatePdp3RightsGuardFact({ guardRef: "current-rights-and-consent", evidence: [evidence("RIGHTS", { subjectRef: "artifact-version-foreign" }), evidence("CONSENT")], expected }).truth, "UNKNOWN");
  const invalid = evidence("CONSENT");
  invalid.result.readAuthorityRef = ".product-experience/pdp-1-domain-data/authority.yaml#ownership.privilegedEffects";
  assert.equal(evaluatePdp3RightsGuardFact({ guardRef: "current-rights-and-consent", evidence: [evidence("RIGHTS"), invalid], expected }).truth, "UNKNOWN");
  assert.equal(evaluatePdp3RightsGuardFact({ guardRef: "current-rights-and-consent", evidence: [evidence("RIGHTS"), evidence("CONSENT", { effectDisposition: "CONSENT_REQUIRED" })], expected }).truth, "FALSE");
});

test("unbound guard names and guard fact schemas cannot be substituted by arbitrary records", () => {
  assert.equal(evaluatePdp3RightsGuardFact({ guardRef: "admitted-capability-and-policy", evidence: paired(), expected }).truth, "UNKNOWN");
  assert.equal(evaluatePdp3RightsGuardFact({ guardRef: "current-rights-and-consent", evidence: "TRUE", expected }).truth, "UNKNOWN");
  assert.equal(evaluatePdp3RightsGuardFact({ guardRef: "current-rights-and-consent", evidence: paired(), expected: { ...expected, principalRef: "principal-B" } }).truth, "UNKNOWN");
});
