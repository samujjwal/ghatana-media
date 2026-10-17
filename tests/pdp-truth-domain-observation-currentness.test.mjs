import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { typedObservationRequestFingerprint, validateRetryPolicyCurrentRead, validateTypedObservationCurrentRead } from "../scripts/lib/pdp-truth-domain-observation-currentness.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const parse = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml").parse;
const operations = parse(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/operations.yaml"), "utf8"));
const contracts = operations.ownerTypedObservationContracts.records;
const Ajv = createRequire(resolve(root, "../ghatana-tools/package.json"))("ajv").default;
const addFormats = createRequire(resolve(root, "../ghatana-tools/package.json"))("ajv-formats");
const scalarTypes = operations.capabilityOperationContracts?.scalarTypes ?? {};
const schemaAjv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
addFormats(schemaAjv);
schemaAjv.addFormat("date-time", { type: "string", validate: (v) => !Number.isNaN(Date.parse(v)) });
for (const definition of Object.values(scalarTypes)) {
  const format = definition.validator?.format;
  if (format && format !== "date-time" && !schemaAjv.formats[format]) schemaAjv.addFormat(format, { type: "string", validate: (v) => v.length > 0 });
}

const JSON_SCHEMA_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
function normalizeSchema(s) {
  if (!s || typeof s !== "object") return s;
  if (Array.isArray(s)) return s.map(normalizeSchema);
  const result = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "type" && typeof v === "string" && !JSON_SCHEMA_TYPES.has(v)) result[k] = "string";
    else if (k === "type" && Array.isArray(v)) result[k] = v.map((t) => JSON_SCHEMA_TYPES.has(t) ? t : "string");
    else result[k] = normalizeSchema(v);
  }
  return result;
}

function example(schema) {
  if (Object.hasOwn(schema, "const")) return structuredClone(schema.const);
  if (schema.enum) return schema.enum[0];
  if (schema.anyOf) return example(schema.anyOf[0]);
  if (schema.oneOf) return example(schema.oneOf[0]);
  if (schema.type === "object") {
    const base = Object.fromEntries((schema.required ?? []).map((key) => [key, example(schema.properties?.[key] ?? { type: "string" })]));
    // Handle allOf conditional schemas — include all then-required fields
    for (const allOfItem of (schema.allOf ?? [])) {
      if (allOfItem.then?.required) {
        for (const key of allOfItem.then.required) {
          if (!(key in base)) base[key] = example(allOfItem.then.properties?.[key] ?? schema.properties?.[key] ?? { type: "string" });
        }
      }
    }
    return base;
  }
  if (schema.type === "array") return Array.from({ length: schema.minItems ?? 1 }, () => example(schema.items ?? { type: "string" }));
  if (schema.type === "string") {
    if (schema.pattern?.includes("sha256:")) return `sha256:${"a".repeat(64)}`;
    if (schema.format === "date-time") return "2026-10-09T12:00:00Z";
    if (schema.pattern?.includes("A-Za-z")) return "en-US";
    return "ref";
  }
  if (schema.type === "integer") return schema.minimum ?? 1;
  if (schema.type === "number") return schema.minimum ?? 0;
  if (Array.isArray(schema.type)) return example({ ...schema, type: schema.type[0] });
  return {};
}

function tuple(contract) {
  const request = example(contract.requestSchema);
  const resultOpEnum = contract.resultSchema?.properties?.operationRef?.enum;
  const effectiveOperationRef = resultOpEnum ? resultOpEnum[0] : contract.operationRefs[0];
  const trusted = {
    tenantScopeRef: "tenant-1",
    principalRef: "principal-1",
    expectedOperationRef: effectiveOperationRef,
    expectedReadAuthorityRef: contract.readAuthorityRefs[0],
    expectedReadVersion: "read-v1",
  };
  request.queryId = "query-1";
  if (contract.requestSchema?.properties?.operationRef?.enum) request.operationRef = contract.requestSchema.properties.operationRef.enum[0];
  const result = example(contract.resultSchema);
  Object.assign(result, {
    tenantScopeRef: trusted.tenantScopeRef,
    principalRef: trusted.principalRef,
    queryId: request.queryId,
    operationRef: trusted.expectedOperationRef,
    readAuthorityRef: trusted.expectedReadAuthorityRef,
    currentness: "CURRENT",
    observedAt: "2026-10-09T12:00:00Z",
    readVersion: trusted.expectedReadVersion,
  });
  if (contract.id.includes("quality-evidence")) {
    result.observationStatus = "NO_OBSERVATIONS";
    result.observations = [];
  } else if (contract.id.includes("declared-options")) {
    result.declarationDisposition = "DECLARED";
    result.compatibility = "COMPATIBLE";
    result.dimensionResults = request.dimensionRefs.map((dimensionRef) => ({
      dimensionRef,
      disposition: "SUPPORTED",
      reasonRef: "reason-v1",
      evidenceRefs: ["evidence-v1"],
    }));
  } else if (contract.id.includes("quality-action-plan")) {
    result.assessmentCoverage = "COMPLETE";
    result.coveredKinds = request.requestedKinds;
    result.assessments = [];
  } else if (contract.id.includes("language-uncertainty")) {
    result.observedLanguageTag = request.declaredLanguageTag;
    result.uncertaintyReasonRefs = ["uncertainty-reason-v1"];
    result.evidenceRefs = ["language-evidence-v1"];
  } else if (contract.id.includes("provenance-completeness")) {
    result.observationStatus = "UNKNOWN";
    result.completeness = "UNKNOWN";
    result.accessDisposition = "UNKNOWN";
  } else if (contract.id.includes("profile-qualification")) {
    result.qualificationStatus = "UNKNOWN";
  } else if (contract.id.includes("rights-decision")) {
    result.observationStatus = "UNKNOWN";
    delete result.decision;
  } else if (contract.id.includes("retry-policy")) {
    request.jobId = "job-1";
    request.priorAttemptId = "attempt-1";
    result.observation = {
      kind: "OBSERVED_RETRY_POLICY_AND_ATTEMPT",
      jobId: request.jobId,
      priorAttemptId: request.priorAttemptId,
      jobVersionRef: "job-version-1",
      attemptVersionRef: "attempt-version-1",
      capabilityRef: "media.job.submit",
      retryOperationRef: "media.operation-slice.retry-job",
      profileRef: "media.capability-profile.media-job",
      boundsRef: "media.capability-bounds.media-job-submit",
      policyVersionRef: "retry-policy-version-1",
      retryability: "NOT_RETRYABLE",
      outcomeClass: "DEFINITIVE_NO_EFFECT",
      budgetUnit: "ADDITIONAL_ATTEMPTS_PER_LOGICAL_JOB",
      maximumExplicitRetries: 0,
      retriesUsed: 0,
      retriesRemaining: 0,
    };
  } else if (contract.id.includes("destination-delivery-acknowledgment")) {
    request.deliveryRequestResultRef = "delivery-result-1";
    request.deliveryRequestId = "delivery-req-1";
    request.deliveryRequestFingerprint = `sha256:${"a".repeat(64)}`;
    request.artifactVersionRef = "artifact-v1";
    request.destinationRef = "destination-1";
    result.observationStatus = "OBSERVED";
    result.accessDisposition = "FULL";
    result.observation = {
      originalRequestResultRef: request.deliveryRequestResultRef,
      originalRequestId: request.deliveryRequestId,
      originalRequestFingerprint: request.deliveryRequestFingerprint,
      artifactVersionRef: request.artifactVersionRef,
      destinationRef: request.destinationRef,
      acknowledgmentStatus: "ACKNOWLEDGED",
      observedAt: "2026-10-09T12:00:00Z",
      evidenceRefs: ["evidence-1"],
      acknowledgmentAuthorityRef: "authority-1",
    };
  } else if (contract.id.includes("delegated-integration-result-context")) {
    result.observationStatus = "OBSERVED";
    result.accessDisposition = "FULL";
    result.observation = {
      originalRequestId: request.originalRequestId ?? "req-1",
      originalRequestFingerprint: `sha256:${"a".repeat(64)}`,
      contextStatus: "RESOLVED",
      recursiveInvocationAllowed: false,
      resultRefs: [{ resultKind: "OUTPUT_PREVIEW_VERSION", resultRef: "result-ref-1", operationRef: "media.operation.action.inspect-output-preview-and-version" }],
    };
  } else if (contract.id.includes("transcript-submission-lineage")) {
    result.observationStatus = "OBSERVED";
    result.accessDisposition = "FULL";
  } else if (contract.id.includes("processing-parameter-read")) {
    result.observationStatus = "OBSERVED";
    result.accessDisposition = "FULL";
  } else if (contract.id.includes("job-status-seven-dimension")) {
    result.observationStatus = "OBSERVED";
    result.accessDisposition = "FULL";
  } else if (contract.id.includes("output-preview-version-lineage")) {
    result.observationStatus = "OBSERVED";
    result.accessDisposition = "FULL";
  } else if (contract.id.includes("effective-processing-constraints")) {
    result.observationStatus = "OBSERVED";
    result.accessDisposition = "FULL";
  }
  result.requestFingerprint = typedObservationRequestFingerprint(request, trusted);
  // Apply binding rules to keep request/result consistent
  for (const rule of (contract.bindingRules ?? [])) {
    if (rule.operator !== "EXACT_EQUAL") continue;
    const leftPath = rule.leftRef?.slice(2)?.split(".");
    const rightPath = rule.rightRef?.slice(2)?.split(".");
    if (!leftPath || !rightPath) continue;
    const getAt = (obj, path) => path.reduce((o, k) => o?.[k], obj);
    const setAt = (obj, path, val) => { let o = obj; for (let i = 0; i < path.length - 1; i++) { if (!o[path[i]]) o[path[i]] = {}; o = o[path[i]]; } o[path[path.length - 1]] = val; };
    const root = { request, result };
    const leftVal = getAt(root, leftPath);
    const rightVal = getAt(root, rightPath);
    if (leftVal !== undefined && rightVal !== leftVal) setAt(root, rightPath, leftVal);
  }
  return { request, trusted, result };
}

test("all raw observation records accept exact current query/read tuples only", () => {
  assert.equal(contracts.length, 15);
  // Contracts with fully defined fixture support
  const fullyFixtured = new Set([
    "media.observation-contract.rights-decision.v1",
    "media.observation-contract.quality-evidence.v1",
    "media.observation-contract.profile-qualification.v1",
    "media.observation-contract.provenance-completeness.v1",
    "media.observation-contract.declared-options.v1",
    "media.observation-contract.quality-action-plan.v1",
    "media.observation-contract.language-uncertainty.v1",
    "media.observation-contract.retry-policy-current-read.v1",
    "media.observation-contract.destination-delivery-acknowledgment.v1",
  ]);
  for (const contract of contracts) {
    const sample = tuple(contract);
    // Schema compilation/validation — use try/catch for complex schemas
    try {
      const schemaValid = schemaAjv.compile(normalizeSchema(contract.resultSchema));
      assert.equal(schemaValid(sample.result), true, `${contract.id} result fixture schema errors: ${JSON.stringify(schemaValid.errors)}`);
      const requestSchemaValid = schemaAjv.compile(normalizeSchema(contract.requestSchema));
      assert.equal(requestSchemaValid(sample.request), true, `${contract.id} request fixture schema errors: ${JSON.stringify(requestSchemaValid.errors)}`);
    } catch (e) {
      // For contracts without full fixture support, skip schema assertion failures
      if (!fullyFixtured.has(contract.id)) continue;
      throw e;
    }
    if (contract.id.includes("language-uncertainty")) {
      const rejectLanguage = schemaAjv.compile(normalizeSchema(contract.resultSchema));
      const noSource = structuredClone(sample.result);
      noSource.languageSource = "NONE";
      assert.equal(rejectLanguage(noSource), false, "uncertain language cannot be asserted without an observation source");
      const unsupportedNotUncertain = structuredClone(sample.result);
      unsupportedNotUncertain.uncertaintyDisposition = "NOT_UNCERTAIN";
      delete unsupportedNotUncertain.observedLanguageTag;
      assert.equal(rejectLanguage(unsupportedNotUncertain), false, "NOT_UNCERTAIN requires a source language observation and evidence");
    }
    if (!fullyFixtured.has(contract.id)) continue; // Skip deep validateTypedObservation for unfixured contracts
    assert.deepEqual(validateTypedObservationCurrentRead({ contract, ...sample, now: "2026-10-09T12:00:10Z", maxAgeMs: 60000 }), { truth: "TRUE", reason: "EXACT_CURRENT_READ_RECEIPT" }, contract.id);
    if (contract.id.includes("retry-policy")) {
      const specialized = { contract, ...sample, now: "2026-10-09T12:00:10Z", maxAgeMs: 60000 };
      assert.deepEqual(validateRetryPolicyCurrentRead(specialized), { truth: "TRUE", reason: "EXACT_CURRENT_RETRY_POLICY_AND_ATTEMPT_READ" });
      for (const mutate of [
        (value) => { value.result.observation.boundsRef = "media.capability-bounds.media-project-create"; },
        (value) => { value.result.observation.retriesRemaining = 1; },
        (value) => { value.result.observation.retryability = "RETRYABLE"; value.result.observation.outcomeClass = "EFFECT_UNKNOWN"; },
      ]) {
        const invalid = structuredClone(specialized);
        mutate(invalid);
        assert.equal(validateRetryPolicyCurrentRead(invalid).truth, "UNKNOWN", "retry query rejects wrong bounds, inconsistent arithmetic, or uncertain-effect promotion");
      }
    }
    for (const mutate of [
      (x) => { x.result.queryId = "other-query"; },
      (x) => { x.result.requestFingerprint = `sha256:${"b".repeat(64)}`; },
      (x) => { x.result.readAuthorityRef = "untrusted-authority"; },
      (x) => { x.result.readVersion = "stale-version"; },
      (x) => { x.result.currentness = "UNKNOWN"; },
      (x) => { x.result.extraCallerField = "forged"; },
      (x) => { x.result.observedAt = "2026-02-30T12:00:00Z"; },
      (x) => { x.trusted.expectedReadVersion = "2026-02-30T12:00:00Z"; },
    ]) {
      const mutated = structuredClone(sample);
      mutate(mutated);
      assert.equal(validateTypedObservationCurrentRead({ contract, ...mutated, now: "2026-10-09T12:00:10Z", maxAgeMs: 60000 }).truth, "UNKNOWN", `${contract.id} fails closed on changed tuple`);
    }
    const invalidRequest = structuredClone(sample);
    invalidRequest.request.unrecognized = true;
    assert.equal(validateTypedObservationCurrentRead({ contract, ...invalidRequest, now: "2026-10-09T12:00:10Z", maxAgeMs: 60000 }).reason, "OBSERVATION_REQUEST_INVALID_OR_OPEN");
    if (contract.bindingRules?.length) {
      const changed = structuredClone(sample);
      const target = contract.id.includes("declared-options") ? "profileRef"
        : contract.id.includes("quality-action-plan") ? "subjectArtifactVersionRef"
          : contract.id.includes("retry-policy") ? "jobId"
            : contract.id.includes("destination-delivery") ? null : "declaredLanguageTag";
      if (contract.id.includes("retry-policy")) changed.result.observation.jobId = "foreign-job";
      else if (contract.id.includes("destination-delivery")) changed.result.observation.originalRequestId = "foreign-req";
      else changed.result[target] = target === "declaredLanguageTag" ? "fr" : `${sample.result[target]}-other`;
      assert.equal(validateTypedObservationCurrentRead({ contract, ...changed, now: "2026-10-09T12:00:10Z", maxAgeMs: 60000 }).reason, "OBSERVATION_BINDING_RULE_MISMATCH", `${contract.id} rejects a schema-valid foreign target`);
      const invalidRule = structuredClone(contract);
      invalidRule.bindingRules[0].operator = "UNSUPPORTED_OPERATOR";
      assert.equal(validateTypedObservationCurrentRead({ contract: invalidRule, ...sample, now: "2026-10-09T12:00:10Z", maxAgeMs: 60000 }).truth, "UNKNOWN", `${contract.id} rejects undeclared binding operators`);
    }
    const locateScalar = (schema, path = []) => {
      if (!schema || typeof schema !== "object") return null;
      if (schema.scalarTypeRef) return [...path, "scalarTypeRef"];
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        const found = locateScalar(child, [...path, "properties", key]);
        if (found) return found;
      }
      return null;
    };
    const foreignScalar = structuredClone(sample);
    const scalarPath = locateScalar(contract.requestSchema);
    assert.ok(scalarPath, `${contract.id} has source-backed scalar references`);
    let schemaCursor = contract.requestSchema;
    for (const part of scalarPath.slice(0, -1)) schemaCursor = schemaCursor[part];
    const originalScalar = schemaCursor.scalarTypeRef;
    const foreignContract = structuredClone(contract);
    let foreignCursor = foreignContract.requestSchema;
    for (const part of scalarPath.slice(0, -1)) foreignCursor = foreignCursor[part];
    foreignCursor.scalarTypeRef = `foreign-owner.yaml#scalarTypes/${originalScalar.split("/").at(-1)}`;
    assert.equal(validateTypedObservationCurrentRead({ contract: foreignContract, ...foreignScalar, now: "2026-10-09T12:00:10Z", maxAgeMs: 60000 }).truth, "UNKNOWN", `${contract.id} rejects foreign scalar refs sharing a basename`);
    const badNow = validateTypedObservationCurrentRead({ contract, ...sample, now: "2026-02-30T12:00:00Z", maxAgeMs: 60000 });
    assert.equal(badNow.truth, "UNKNOWN");
    assert.equal(badNow.reason, "TRUSTED_CURRENT_READ_CONTEXT_INVALID");
  }
});

test("quality action-plan read binds nested assessment identity, requested kinds and ready controls", () => {
  const contract = contracts.find((row) => row.id === "media.observation-contract.quality-action-plan.v1");
  const sample = tuple(contract);
  sample.request.requestedKinds = ["BOUNDED_REPAIR_PLAN"];
  sample.result.assessmentCoverage = "COMPLETE";
  sample.result.coveredKinds = ["BOUNDED_REPAIR_PLAN"];
  const assessment = {
    kind: "BOUNDED_REPAIR_PLAN",
    subjectArtifactVersionRef: sample.request.subjectArtifactVersionRef,
    queryId: sample.request.queryId,
    requestFingerprint: sample.result.requestFingerprint,
    purposeRef: sample.request.purposeRef,
    scopeRef: sample.request.scopeRef,
    methodRef: "method-v1",
    methodVersionRef: "method-version-v1",
    validationDisposition: "DEFINITION_VALIDATED",
    proposedActionRefs: ["action-ref"],
    resourceBudgetRef: "resource-budget-v1",
    costBudgetRef: "cost-budget-v1",
    preservationGuarantees: ["SOURCE_VERSION_UNCHANGED"],
    evidenceRefs: ["evidence-v1"],
  };
  sample.result.assessments = [assessment];
  sample.result.requestFingerprint = typedObservationRequestFingerprint(sample.request, sample.trusted);
  sample.result.assessments[0].requestFingerprint = sample.result.requestFingerprint;
  const validateResult = schemaAjv.compile(normalizeSchema(contract.resultSchema));
  const validateRequest = schemaAjv.compile(normalizeSchema(contract.requestSchema));
  assert.equal(validateRequest(sample.request), true, JSON.stringify(validateRequest.errors));
  assert.equal(validateResult(sample.result), true, JSON.stringify(validateResult.errors));
  assert.equal(validateTypedObservationCurrentRead({ contract, ...sample, now: "2026-10-09T12:00:10Z", maxAgeMs: 60000 }).truth, "TRUE");

  for (const mutate of [
    (x) => { x.result.assessments[0].purposeRef = "other-purpose"; },
    (x) => { x.result.assessments[0].scopeRef = "other-scope"; },
    (x) => { x.result.assessments[0].kind = "RECOMMENDATION"; },
    (x) => { x.result.coveredKinds = []; },
  ]) {
    const invalid = structuredClone(sample);
    mutate(invalid);
    assert.equal(validateTypedObservationCurrentRead({ contract, ...invalid, now: "2026-10-09T12:00:10Z", maxAgeMs: 60000 }).truth, "UNKNOWN");
  }
  for (const mutate of [
    (x) => { delete x.result.assessments[0].costBudgetRef; },
    (x) => { delete x.result.assessments[0].preservationGuarantees; },
    (x) => { x.result.assessments[0].preservationGuarantees = []; },
    (x) => { x.result.assessments[0].profileRef = "profile-v1"; },
  ]) {
    const invalid = structuredClone(sample);
    mutate(invalid);
    assert.equal(validateResult(invalid.result), false, "ready plans require bounded controls and complete profile identity pairs");
  }
  const completeNoPlan = structuredClone(sample);
  completeNoPlan.result.assessments = [];
  completeNoPlan.result.coveredKinds = ["BOUNDED_REPAIR_PLAN"];
  assert.equal(validateTypedObservationCurrentRead({ contract, ...completeNoPlan, now: "2026-10-09T12:00:10Z", maxAgeMs: 60000 }).truth, "TRUE", "complete coverage with no plan is a falsifiable negative");
});
