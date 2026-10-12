import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { evaluateInspectionDefinition, evaluateSearchDefinition } from "../dist/index.js";

const now = "2026-10-11T12:00:00.000Z";
const trustedSearch = { tenantId: "fixture-tenant-1", principalId: "fixture-principal-1", indexRevision: "idx-r7", observedAt: now, now, maxAgeMs: 30_000 };
const searchCases = [
  ["media.search.authorized-projects", "media.domain.project", "updated-at-descending-stable-id", ["identity", "tenant", "project", "visibility"]],
  ["media.search.authorized-artifacts", "media.domain.artifact-version", "created-at-descending-stable-id", ["identity", "tenant", "project", "rights", "consent", "retention", "quarantine", "readPolicy"]],
  ["media.search.authorized-jobs", "media.domain.processing-job", "updated-at-descending-stable-job-id", ["identity", "tenant", "job", "artifact"]],
];
const searchRow = (contractId, type, checks) => ({
  id: "fixture-resource-1", type, tenantId: "fixture-tenant-1", principalId: "fixture-principal-1", label: "Synthetic record",
  fields: contractId === "media.search.authorized-projects"
    ? { "workspace-or-tenant": "fixture-tenant-1", "project-visibility": "VISIBLE", "updated-at": now, ownership: "fixture-owner" }
    : contractId === "media.search.authorized-artifacts"
      ? { "tenant-project-scope": "fixture-project-1", "media-kind": "video", "integrity-status": "VERIFIED", owner: "fixture-owner", version: "v4", "time-range": "fixture-range" }
      : { "job-kind": "verification", status: "OUTCOME_UNKNOWN", "created-at": now, "source-version": "v4", attempt: "attempt-1", owner: "fixture-owner" },
  authorization: { tenantId: "fixture-tenant-1", principalId: "fixture-principal-1", resourceId: "fixture-resource-1", checks: Object.fromEntries(checks.map((key) => [key, "ALLOW"])), policyVersion: "policy-r4", observedAt: now },
  indexRevision: "idx-r7", observedAt: now,
});
const searchInput = ([contractId, type, sort, checks], records = [searchRow(contractId, type, checks)], overrides = {}) => ({
  contractId, request: { filters: {}, sort, ...overrides.request }, trusted: { ...trustedSearch, ...overrides.trusted }, records,
});

test("all three authorized search contracts return only exact synthetic authorized identities", () => {
  for (const testCase of searchCases) {
    const result = evaluateSearchDefinition(searchInput(testCase));
    assert.equal(result.decision, "OBSERVED", testCase[0]);
    assert.deepEqual(result.records.map(({ id }) => id), ["fixture-resource-1"]);
    assert.equal(result.isSimulation, true);
    assert.equal(result.effect, "NONE");
    assert.equal(result.runtimeAdmission, "NOT_ADMITTED");
    assert.equal("count" in result, false);
    assert.equal("suggestions" in result, false);
  }
});

test("search denies, hides foreign rows, and fails closed on unknown, stale, ambiguous, or malformed facts", () => {
  const [contractId, type, sort, checks] = searchCases[1];
  const allowed = searchRow(contractId, type, checks);
  const foreign = { ...searchRow(contractId, type, checks), id: "foreign-secret", tenantId: "fixture-other-tenant", principalId: "fixture-other-principal", authorization: { ...allowed.authorization, tenantId: "fixture-other-tenant", principalId: "fixture-other-principal", resourceId: "foreign-secret" } };
  assert.deepEqual(evaluateSearchDefinition(searchInput(searchCases[1], [allowed, foreign])).records.map(({ id }) => id), ["fixture-resource-1"]);
  const denied = { ...allowed, authorization: { ...allowed.authorization, checks: Object.fromEntries(checks.map((key) => [key, key === "rights" ? "DENY" : "ALLOW"])) } };
  const deniedResult = evaluateSearchDefinition(searchInput(searchCases[1], [denied]));
  assert.equal(deniedResult.decision, "NO_MATCH");
  assert.deepEqual(deniedResult.records, []);
  assert.equal(JSON.stringify(deniedResult).includes("fixture-resource-1"), false);
  const unknown = { ...allowed, authorization: { ...allowed.authorization, checks: Object.fromEntries(checks.map((key) => [key, key === "consent" ? "UNKNOWN" : "ALLOW"])) } };
  assert.equal(evaluateSearchDefinition(searchInput(searchCases[1], [unknown])).decision, "UNKNOWN");
  assert.equal(evaluateSearchDefinition(searchInput(searchCases[1], [allowed], { trusted: { observedAt: "2026-10-11T11:00:00.000Z" } })).decision, "STALE_OBSERVATION");
  assert.equal(evaluateSearchDefinition(searchInput(searchCases[1], [{ ...allowed, observedAt: "2026-10-11T11:00:00.000Z" }])).decision, "STALE_OBSERVATION",
    "each record's own observation must be fresh even when index and authorization observations are current");
  assert.equal(evaluateSearchDefinition(searchInput(searchCases[1], [allowed, allowed])).decision, "UNKNOWN");
  const injectedSecret = { ...allowed, fields: { ...allowed.fields, privateCredential: "fixture-secret" } };
  const injectedResult = evaluateSearchDefinition(searchInput(searchCases[1], [injectedSecret]));
  assert.equal(injectedResult.decision, "INVALID_FIXTURE");
  assert.equal(JSON.stringify(injectedResult).includes("fixture-secret"), false, "unlisted fields are rejected without echoing them");
  assert.equal(evaluateSearchDefinition(searchInput(searchCases[1], [allowed], { request: { filters: { arbitrary: true } } })).decision, "INVALID_FIXTURE");
  assert.equal(evaluateSearchDefinition({ ...searchInput(searchCases[1]), request: { filters: {}, sort, surprise: true } }).decision, "INVALID_FIXTURE");
});

const inspectionCases = [
  ["media.inspection.authority", { tenantId: "fixture-tenant-1", projectId: "fixture-project-1", resourceId: "fixture-resource-1", resourceVersion: "v4", principalId: "fixture-principal-1", policyIssuer: "fixture-policy-issuer" }, ["resource", "policy"], { resourceRef: "fixture-resource-1", redactedMetadata: { classification: "fixture-redacted" } }],
  ["media.inspection.evidence", { sourceVersion: "source-v2", outputVersion: "output-v4", assessmentProfile: "fixture-profile", evidenceIssuer: "fixture-evidence-issuer", observationTime: "2026-10-11T11:59:00.000Z" }, ["source", "output", "evidenceIssuer", "readPolicy"], { disposition: "UNKNOWN", metricDomain: "fixture-metric", sourceRef: "fixture-source-observation" }],
  ["media.inspection.trace", { logicalJobId: "fixture-job-1", attemptIds: ["attempt-1", "attempt-2"], sourceVersion: "source-v2", evidenceFingerprint: "fixture-fingerprint" }, ["job", "attempts", "source", "provenance", "readPolicy"], { origin: "fixture-attempt-owner", freshness: "UNKNOWN", attemptStatus: "OUTCOME_UNKNOWN" }],
];
const inspectionInput = ([contractId, selector, checks, facts], overrides = {}) => ({
  contractId, selector, trusted: { tenantId: "fixture-tenant-1", principalId: "fixture-principal-1", now, maxAgeMs: 30_000, ...overrides.trusted },
  records: [{ tenantId: "fixture-tenant-1", principalId: "fixture-principal-1", selector: { ...selector }, scopeChecks: Object.fromEntries(checks.map((key) => [key, "ALLOW"])), issuer: "fixture-issuer", observedAt: now, facts }],
});

test("authority, evidence, and trace inspection use exact synthetic selectors without granting or inferring facts", () => {
  for (const testCase of inspectionCases) {
    const result = evaluateInspectionDefinition(inspectionInput(testCase));
    assert.equal(result.decision, "OBSERVED", testCase[0]);
    assert.equal(result.isSimulation, true);
    assert.equal(result.runtimeAdmission, "NOT_ADMITTED");
    assert.equal(result.effect, "NONE");
  }
  const evidence = evaluateInspectionDefinition(inspectionInput(inspectionCases[1]));
  assert.equal(evidence.records[0].facts.disposition, "UNKNOWN");
  const trace = evaluateInspectionDefinition(inspectionInput(inspectionCases[2]));
  assert.equal(trace.records[0].facts.attemptStatus, "OUTCOME_UNKNOWN");
  assert.equal(trace.records[0].facts.freshness, "UNKNOWN");
  assert.equal("finality" in trace.records[0].facts, false);
});

test("inspection hides foreign and denied selectors and rejects stale, incomplete, or ambiguous observations", () => {
  const [contractId, selector, checks, facts] = inspectionCases[0];
  const original = inspectionInput(inspectionCases[0]);
  const foreign = { ...original.records[0], tenantId: "fixture-other-tenant", principalId: "fixture-other-principal" };
  assert.equal(evaluateInspectionDefinition({ ...original, records: [foreign] }).decision, "NOT_FOUND_IN_CALLER_SCOPE");
  const denied = { ...original.records[0], scopeChecks: { resource: "DENY", policy: "ALLOW" } };
  const deniedResult = evaluateInspectionDefinition({ ...original, records: [denied] });
  assert.equal(deniedResult.decision, "NOT_FOUND_IN_CALLER_SCOPE");
  assert.equal(JSON.stringify(deniedResult).includes("fixture-resource-1"), false);
  const stale = { ...original.records[0], observedAt: "2026-10-11T11:00:00.000Z" };
  assert.equal(evaluateInspectionDefinition({ ...original, records: [stale] }).decision, "STALE_OBSERVATION");
  assert.equal(evaluateInspectionDefinition({ ...original, selector: { ...selector, resourceVersion: undefined } }).decision, "INVALID_FIXTURE");
  assert.equal(evaluateInspectionDefinition({ ...original, records: [original.records[0], original.records[0]] }).decision, "UNKNOWN");
  assert.equal(evaluateInspectionDefinition({ ...original, records: [{ ...original.records[0], facts: null }] }).decision, "INVALID_FIXTURE");
});

test("oracle remains aligned to the source contract ids and explicit non-admission", async () => {
  const source = await readFile(new URL("../../../.product-experience/pdp-3-product-experience/search-inspection-contracts.yaml", import.meta.url), "utf8");
  for (const [id] of searchCases) assert.match(source, new RegExp(`id: ${id.replaceAll(".", "\\.")}`));
  for (const [id] of inspectionCases) assert.match(source, new RegExp(`id: ${id.replaceAll(".", "\\.")}`));
  assert.match(source, /runtimeBinding: NOT_ADMITTED/);
  assert.match(source, /filter-by-current-scope-before-match-count-suggestion-or-pagination/);
});
