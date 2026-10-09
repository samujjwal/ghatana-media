import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { validateTypedConsentRevisionCurrentRead, validateTypedObservationCurrentRead } from "./pdp-truth-domain-observation-currentness.mjs";
import { validateOwnerClosedJsonSchema } from "./pdp-owner-leaf-wire-validation.mjs";
import { canonicalizeJobParameterJson, validateJobSubmitParameterContract } from "./pdp-job-submit-parameter-contract.mjs";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const yaml = require("yaml");
const p1Operations = yaml.parse(readFileSync(resolve(process.cwd(), ".product-experience/pdp-1-domain-data/operations.yaml"), "utf8"));
const rightsDecisionContract = p1Operations.ownerTypedObservationContracts.records.find(({ id }) => id === "media.observation-contract.rights-decision.v1");
const consentRevisionContract = p1Operations.ownerConsentRevisionObservationContract;
const acceptedRequestSnapshotContract = p1Operations.ownerDefinedOperationContracts.records.find(({ id }) => id === "media.operation.request-snapshot.inspect.v1");

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const canonicalUtc = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};
const jsonEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function evaluateAcceptedRequestSnapshot(value, expected, trusted, sourceRef) {
  const unknown = (reason) => ({ verdict: "UNKNOWN", reason });
  if (!isRecord(value) || !isRecord(value.queryRequest) || !isRecord(value.queryResult) || !acceptedRequestSnapshotContract) {
    return unknown("ACCEPTED_REQUEST_SNAPSHOT_READ_MISSING_OR_MALFORMED");
  }
  const expectedQuery = trusted.expectedRequestSnapshotByFact?.[sourceRef];
  const maxAgeMs = trusted.maxAgeMsByFact?.[sourceRef];
  if (!isRecord(expectedQuery) || !isRecord(expectedQuery.jobSubmitRequest) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0 ||
      !validateOwnerClosedJsonSchema(acceptedRequestSnapshotContract.requestSchema, value.queryRequest).valid ||
      !validateOwnerClosedJsonSchema(acceptedRequestSnapshotContract.resultSchema, value.queryResult).valid) {
    return unknown("ACCEPTED_REQUEST_SNAPSHOT_OWNER_SCHEMA_OR_EXPECTATION_INVALID");
  }
  const request = value.queryRequest;
  const result = value.queryResult;
  const submitted = expectedQuery.jobSubmitRequest;
  const validation = validateJobSubmitParameterContract(p1Operations, submitted);
  if (!validation.valid) return unknown("ACCEPTED_REQUEST_JOB_SUBMIT_SCHEMA_OR_TYPED_INPUT_REJECTED");
  const typedInputObject = Object.fromEntries(submitted.typedInputs.map((input, index) => [`input${index + 1}`, input]));
  const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
  const typedInputDigest = sha(canonicalizeJobParameterJson(typedInputObject));
  const parameterDigest = sha(canonicalizeJobParameterJson(submitted.parameters));
  const requestFingerprint = sha(canonicalizeJobParameterJson({ tenantId: trusted.tenantId, principalId: trusted.principalId,
    jobId: expectedQuery.jobId, requestId: submitted.requestId, purposeRef: submitted.purposeRef,
    capabilityRef: submitted.capabilityRef, targetOperationRef: submitted.targetOperationRef,
    targetOperationVersion: submitted.targetOperationVersion, targetSchemaDigest: validation.targetSchemaDigest,
    profileRef: submitted.profile.profileRef, profileVersion: submitted.profile.profileVersion,
    profileVersionRef: submitted.profile.profileVersionRef, typedInputDigest, parameterDigest }));
  const nowMs = Date.parse(trusted.now);
  const observedMs = Date.parse(result.observedAt);
  if (!canonicalUtc(trusted.now) || !canonicalUtc(result.observedAt) || !Number.isFinite(nowMs) || !Number.isFinite(observedMs) ||
      observedMs > nowMs || nowMs - observedMs > maxAgeMs ||
      request.jobId !== expectedQuery.jobId || request.requestId !== expectedQuery.requestId || submitted.requestId !== request.requestId ||
      expectedQuery.jobId !== trusted.expectedAggregateRef ||
      result.outcome !== "OBSERVED" || result.operationRef !== acceptedRequestSnapshotContract.operationRef ||
      result.jobId !== request.jobId || result.requestId !== request.requestId ||
      result.tenantId !== trusted.tenantId || result.principalId !== trusted.principalId ||
      result.readAuthorityRef !== expectedQuery.readAuthorityRef || result.readVersion !== expectedQuery.readVersion ||
      result.currentness !== "CURRENT" || result.targetOperationRef !== expectedQuery.targetOperationRef ||
      result.targetOperationVersion !== submitted.targetOperationVersion || result.targetSchemaDigest !== validation.targetSchemaDigest ||
      result.targetOperationRef !== submitted.targetOperationRef || result.requestFingerprint !== requestFingerprint ||
      result.requestFingerprint !== expectedQuery.requestFingerprint || result.capabilityRef !== submitted.capabilityRef ||
      result.profileRef !== submitted.profile.profileRef || result.profileVersion !== submitted.profile.profileVersion ||
      result.profileVersionRef !== submitted.profile.profileVersionRef || result.purposeRef !== submitted.purposeRef ||
      result.typedInputDigest !== typedInputDigest || result.parameterDigest !== parameterDigest ||
      result.acceptedRequestSnapshotRef !== expectedQuery.acceptedRequestSnapshotRef ||
      !Array.isArray(result.sourceVersionRefs) || !Array.isArray(result.dependencyVersionRefs) ||
      !Array.isArray(result.sourceInputs) || !Array.isArray(expectedQuery.sourceInputs) ||
      !Array.isArray(expectedQuery.sourceVersionRefs) || !Array.isArray(expectedQuery.dependencyVersionRefs) ||
      !jsonEqual(result.sourceInputs, expectedQuery.sourceInputs) ||
      !jsonEqual(result.sourceVersionRefs, expectedQuery.sourceVersionRefs) ||
      !jsonEqual(result.dependencyVersionRefs, expectedQuery.dependencyVersionRefs)) {
    return unknown("ACCEPTED_REQUEST_SNAPSHOT_DOES_NOT_MATCH_TRUSTED_JOB_REQUEST_OR_CURRENT_OPERATION");
  }
  return { verdict: "SATISFIED", reason: "EXACT_CURRENT_ACCEPTED_REQUEST_SNAPSHOT" };
}

function deriveCurrentPerEffectConsent({ value, expected, trusted, now }) {
  const fail = () => "UNKNOWN";
  const expectedEffects = trusted.expectedEffectRefsByFact?.[expected.sourceRef];
  if (!isRecord(value) || !Array.isArray(value.effectReads) || !Array.isArray(expectedEffects) || expectedEffects.length === 0 ||
      value.effectReads.length !== expectedEffects.length || !Array.isArray(trusted.expectedConsentBindingsByEffect) ||
      trusted.expectedConsentBindingsByEffect.length !== expectedEffects.length) return fail("missing effect tuple");
  const byEffect = new Map(trusted.expectedConsentBindingsByEffect.map((row) => [row.effectRef, row]));
  if (byEffect.size !== expectedEffects.length || expectedEffects.some((effectRef) => !byEffect.has(effectRef))) return fail("effect map mismatch");
  const seen = new Set();
  let denied = false;
  const nowMs = Date.parse(now);
  const maxAgeMs = trusted.maxAgeMsByFact?.[expected.sourceRef];
  if (!Number.isFinite(nowMs) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) return fail("clock invalid");
  for (const entry of value.effectReads) {
    if (!isRecord(entry) || !isRecord(entry.rightsRequest) || !isRecord(entry.rightsResult) ||
        !isRecord(entry.consentRequest) || !isRecord(entry.consentResult)) return fail("missing read pair");
    const request = entry.rightsRequest;
    const result = entry.rightsResult;
    const effectRef = request.useRef;
    const binding = byEffect.get(effectRef);
    if (!binding || seen.has(effectRef)) return fail("effect not expected or duplicate");
    seen.add(effectRef);
    const expectedSubject = trusted.expectedSubjectArtifactVersionRefByFact?.[expected.sourceRef];
    const expectedPurpose = trusted.expectedPurposeByFact?.[expected.sourceRef];
    const expectedRegion = trusted.expectedRegionByFact?.[expected.sourceRef];
    const expectedRetention = trusted.expectedRetentionPolicyRefByFact?.[expected.sourceRef];
    const rightsAuthority = trusted.expectedRightsReadAuthorityRefByFact?.[expected.sourceRef];
    const rightsVersion = trusted.expectedRightsReadVersionByFact?.[expected.sourceRef];
    const rightsOperation = trusted.expectedRightsOperationRefByFact?.[expected.sourceRef];
    const rightsTrusted = { tenantScopeRef: trusted.tenantId, principalRef: trusted.principalId,
      expectedOperationRef: rightsOperation, expectedReadAuthorityRef: rightsAuthority, expectedReadVersion: rightsVersion };
    const rightsValidation = validateTypedObservationCurrentRead({ contract: rightsDecisionContract, request, result, trusted: rightsTrusted, now, maxAgeMs });
    if (!expectedSubject || !expectedPurpose || !expectedRegion || !expectedRetention ||
        request.subjectArtifactVersionRef !== expectedSubject || request.decisionKind !== "CONSENT" ||
        request.purposeRef !== expectedPurpose || request.useRef !== effectRef || request.regionRef !== expectedRegion ||
        request.retentionPolicyRef !== expectedRetention || rightsValidation.truth !== "TRUE") return fail("rights current read invalid");
    const decision = result.decision;
    const exactDecisionTuple = isRecord(decision) && decision.tenantScopeRef === trusted.tenantId &&
      decision.principalRef === trusted.principalId && decision.subjectArtifactVersionRef === expectedSubject &&
      decision.decisionKind === "CONSENT" && decision.purposeRef === expectedPurpose && decision.useRef === effectRef &&
      decision.regionRef === expectedRegion && decision.retentionPolicyRef === expectedRetention;
    const statusMapping = rightsDecisionContract.decisionKindStateMapping.find((row) =>
      row.decisionKind === result.decisionKind && row.observationStatus === result.observationStatus);
    const permitted = result.observationStatus === "ALLOWED_FOR_DECLARED_SCOPE" && result.decisionKind === "CONSENT" &&
      decision?.effectDisposition === "PERMITTED";
    if (!exactDecisionTuple || result.decisionKind !== "CONSENT" ||
        (!permitted && (!statusMapping || decision?.effectDisposition !== statusMapping.effectDisposition))) return fail("rights tuple/disposition mismatch");
    if (!permitted) { denied = true; continue; }
    if (decision.authorityVersionRef !== binding.decisionAuthorityVersionRef || !Array.isArray(decision.evidenceRefs) ||
        !decision.evidenceRefs.includes(binding.consentRevisionRef) || !canonicalUtc(decision.validFrom) ||
        !canonicalUtc(decision.validUntil) || Date.parse(decision.validFrom) >= Date.parse(decision.validUntil)) return fail("rights evidence/validity mismatch");

    const consentTrusted = { tenantScopeRef: trusted.tenantId, principalRef: trusted.principalId,
      expectedOperationRef: consentRevisionContract.operationRef,
      expectedReadAuthorityRef: trusted.expectedConsentReadAuthorityRefByFact?.[expected.sourceRef],
      expectedReadVersion: trusted.expectedConsentReadVersionByFact?.[expected.sourceRef] };
    const consentValidation = validateTypedConsentRevisionCurrentRead({ contract: consentRevisionContract, request: entry.consentRequest,
      result: entry.consentResult, trusted: consentTrusted, now, maxAgeMs });
    if (consentValidation.truth !== "TRUE") return fail("consent current read invalid");
    const consent = entry.consentResult.outcome;
    if (entry.consentRequest.consentId !== binding.consentId || entry.consentRequest.purposeRef !== expectedPurpose ||
        consent.consentRevisionRef !== binding.consentRevisionRef || consent.version !== binding.consentRevisionVersion ||
        consent.consentRef !== binding.consentRef || consent.status !== "ACTIVE" ||
        !["REQUIRED", "NOT_REQUIRED"].includes(binding.externalProcessingRequirement) ||
        !["REQUIRED", "NOT_REQUIRED"].includes(binding.biometricProcessingRequirement) ||
        !consent.purposes.includes(expectedPurpose) || !consent.allowedRegions.includes(expectedRegion) ||
        !canonicalUtc(decision.validFrom) || !canonicalUtc(decision.validUntil) || !canonicalUtc(consent.grantedAt) ||
        Date.parse(consent.grantedAt) > nowMs ||
        (consent.expiresAt !== null && !canonicalUtc(consent.expiresAt)) ||
        (consent.revokedAt !== null && !canonicalUtc(consent.revokedAt))) return fail("consent revision join mismatch");
    if (binding.externalProcessingRequirement === "REQUIRED" && consent.externalProcessingAllowed !== true) denied = true;
    if (binding.biometricProcessingRequirement === "REQUIRED" && consent.biometricProcessingAllowed !== true) denied = true;
    if (Date.parse(decision.validFrom) > nowMs || Date.parse(decision.validUntil) <= nowMs ||
        (consent.expiresAt !== null && Date.parse(consent.expiresAt) <= nowMs) || consent.revokedAt !== null) denied = true;
  }
  return seen.size === byEffect.size ? (denied ? "DENIED" : "SATISFIED") : fail("missing effect read");
}

/**
 * Evaluate a definition-level owner transition event against trusted host context.
 * This is a schema and scope oracle only; it does not authenticate a deployed
 * producer or establish that a domain transition was persisted.
 */
export function evaluateMediaTransitionTriggerDefinition({ edge, event, trusted, validateEventSchema }) {
  if (!isRecord(edge) || !isRecord(event) || !isRecord(trusted) || typeof validateEventSchema !== "function") {
    return { decision: "UNKNOWN", reason: "MISSING_OR_MALFORMED_DEFINITION_INPUT", runtimeAdmission: "NOT_ADMITTED" };
  }
  if (!validateEventSchema(event)) return { decision: "UNKNOWN", reason: "EVENT_SCHEMA_INVALID", runtimeAdmission: "NOT_ADMITTED" };
  const schema = edge.eventPayloadSchema?.properties;
  if (event.producerRef !== trusted.expectedProducerRef || event.producerRef !== edge.producerRoleRef ||
      event.transitionRef !== schema?.transitionRef?.const || event.edgeRuleRef !== schema?.edgeRuleRef?.const ||
      event.fromStateRef !== trusted.expectedFromStateRef || event.fromStateRef !== schema?.fromStateRef?.const ||
      event.toStateRef !== schema?.toStateRef?.const || event.aggregateRef !== trusted.expectedAggregateRef ||
      event.aggregateVersionRef !== trusted.expectedAggregateVersionRef || !canonicalUtc(event.occurredAt) ||
      !canonicalUtc(trusted.now) || !Number.isSafeInteger(trusted.maxEventAgeMs) || trusted.maxEventAgeMs < 0 ||
      Date.parse(event.occurredAt) > Date.parse(trusted.now) || Date.parse(trusted.now) - Date.parse(event.occurredAt) > trusted.maxEventAgeMs) {
    return { decision: "UNKNOWN", reason: "FOREIGN_OR_STALE_EVENT_SCOPE", runtimeAdmission: "NOT_ADMITTED" };
  }
  const expectedFacts = edge.triggerGuardFacts;
  if (!Array.isArray(expectedFacts) || !Array.isArray(event.guardFactResults) || event.guardFactResults.length !== expectedFacts.length) {
    return { decision: "UNKNOWN", reason: "INCOMPLETE_GUARD_FACT_SET", runtimeAdmission: "NOT_ADMITTED" };
  }
  // This legacy envelope only has a typed representation for exact state reads.
  // A `verdict` field is a caller assertion, not evidence for rights, authority,
  // inventory, consent, or any other non-state predicate. Those facts must use
  // evaluateMediaGuardFactReceiptSetDefinition with their closed value schemas.
  if (expectedFacts.some((fact) => fact.valueKind !== "EXACT_TARGET_STATE_OBSERVATION")) {
    return { decision: "UNKNOWN", reason: "NON_STATE_FACT_REQUIRES_TYPED_RECEIPT_SET", runtimeAdmission: "NOT_ADMITTED" };
  }
  const byFact = new Map();
  for (const fact of event.guardFactResults) {
    if (!isRecord(fact) || byFact.has(fact.factRef)) return { decision: "UNKNOWN", reason: "DUPLICATE_OR_MALFORMED_GUARD_FACT", runtimeAdmission: "NOT_ADMITTED" };
    byFact.set(fact.factRef, fact);
  }
  for (const expected of expectedFacts) {
    const result = byFact.get(expected.sourceRef);
    if (!result) return { decision: "UNKNOWN", reason: "MISSING_GUARD_FACT", runtimeAdmission: "NOT_ADMITTED" };
    const expectedAuthority = trusted.expectedAuthorityByFact?.[expected.sourceRef];
    const expectedReadVersion = trusted.expectedReadVersionByFact?.[expected.sourceRef];
    const maxAgeMs = trusted.maxAgeMsByFact?.[expected.sourceRef];
    const observed = Date.parse(result.observedAt);
    const now = Date.parse(trusted.now);
    if (result.subjectRef !== trusted.expectedAggregateRef || result.subjectVersionRef !== trusted.expectedAggregateVersionRef ||
        typeof expectedAuthority !== "string" || result.authorityRef !== expectedAuthority ||
        !Number.isSafeInteger(expectedReadVersion) || result.readVersion !== expectedReadVersion ||
        !canonicalUtc(result.observedAt) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0 ||
        observed > now || now - observed > maxAgeMs || !Array.isArray(result.evidenceRefs) || result.evidenceRefs.length === 0) {
      return { decision: "UNKNOWN", reason: "GUARD_EVIDENCE_SCOPE_AUTHORITY_OR_CURRENTNESS_MISMATCH", runtimeAdmission: "NOT_ADMITTED" };
    }
    if (expected.valueKind === "EXACT_TARGET_STATE_OBSERVATION") {
      let derivedVerdict = "UNKNOWN";
      if (result.observationDisposition === "OBSERVED" && expected.validStateRefs.includes(result.observedStateRef)) {
        derivedVerdict = result.observedStateRef === expected.targetStateRef ? "SATISFIED" : "DENIED";
      } else if (result.observationDisposition !== "UNKNOWN" || typeof result.observationReason !== "string" || result.observedStateRef !== undefined) {
        return { decision: "UNKNOWN", reason: "MALFORMED_TARGET_STATE_OBSERVATION", runtimeAdmission: "NOT_ADMITTED" };
      }
      if (result.verdict !== derivedVerdict) return { decision: "UNKNOWN", reason: "VERDICT_CONTRADICTS_TARGET_STATE_EVIDENCE", runtimeAdmission: "NOT_ADMITTED" };
    }
  }
  const derivedVerdicts = Object.fromEntries(expectedFacts.map((fact) => {
    const result = byFact.get(fact.sourceRef);
    if (fact.valueKind !== "EXACT_TARGET_STATE_OBSERVATION") return [fact.sourceRef, result.verdict];
    if (result.observationDisposition === "UNKNOWN") return [fact.sourceRef, "UNKNOWN"];
    return [fact.sourceRef, result.observedStateRef === fact.targetStateRef ? "SATISFIED" : "DENIED"];
  }));
  const evaluate = (node) => {
    if (node?.factRef) return derivedVerdicts[node.factRef] === "SATISFIED" ? true : derivedVerdicts[node.factRef] === "DENIED" ? false : null;
    const groups = ["all", "any"].filter((key) => Array.isArray(node?.[key]));
    if (groups.length !== 1 || node[groups[0]].length === 0) return null;
    const values = node[groups[0]].map(evaluate);
    if (groups[0] === "all") return values.includes(false) ? false : values.includes(null) ? null : true;
    return values.includes(true) ? true : values.includes(null) ? null : false;
  };
  const guardValue = evaluate(edge.guardExpression);
  const expectedDecision = guardValue === true ? "APPLIED" : guardValue === false ? "DENIED" : "UNKNOWN";
  if (event.decision !== expectedDecision) return { decision: "UNKNOWN", reason: "EVENT_DECISION_CONTRADICTS_GUARD_EXPRESSION", runtimeAdmission: "NOT_ADMITTED" };
  if (expectedDecision === "APPLIED") return { decision: "APPLIED_DEFINITION_ONLY", reason: "EXACT_GUARD_EXPRESSION_SATISFIED_FOR_TRUSTED_TUPLE", runtimeAdmission: "NOT_ADMITTED" };
  if (expectedDecision === "DENIED") return { decision: "DENIED", reason: "EXACT_GUARD_EXPRESSION_FALSE", runtimeAdmission: "NOT_ADMITTED" };
  return { decision: "UNKNOWN", reason: "EXACT_GUARD_EXPRESSION_UNRESOLVED", runtimeAdmission: "NOT_ADMITTED" };
}

export function evaluateMediaCausalTriggerDefinition({ definition, input, trusted, validateInputSchema, validateOwnerReceipt }) {
  if (!isRecord(definition) || !isRecord(input) || !isRecord(trusted) || typeof validateInputSchema !== "function") {
    return { decision: "UNKNOWN", reason: "MISSING_OR_MALFORMED_CAUSAL_TRIGGER_INPUT", runtimeAdmission: "NOT_ADMITTED" };
  }
  const inputObservationTime = input.observedAt ?? input.occurredAt;
  if (!validateInputSchema(input) || !canonicalUtc(trusted.now) || !canonicalUtc(inputObservationTime)) {
    return { decision: "UNKNOWN", reason: "CAUSAL_TRIGGER_SCHEMA_OR_CLOCK_INVALID", runtimeAdmission: "NOT_ADMITTED" };
  }
  // Tenant is a first-class tuple member in both the action request and owner
  // receipt. Matching raw object IDs across tenants must never alias scope.
  if (typeof trusted.tenantId !== "string" || input.tenantId !== trusted.tenantId ||
      !isRecord(input.ownerReceipt) || input.ownerReceipt.tenantId !== trusted.tenantId) {
    return { decision: "UNKNOWN", reason: "CAUSAL_TRIGGER_TENANT_SCOPE_MISMATCH", runtimeAdmission: "NOT_ADMITTED" };
  }
  const now = Date.parse(trusted.now);
  const observedAt = Date.parse(inputObservationTime);
  if (!Number.isSafeInteger(trusted.maxAgeMs) || trusted.maxAgeMs < 0 || observedAt > now || now - observedAt > trusted.maxAgeMs) {
    return { decision: "UNKNOWN", reason: "CAUSAL_TRIGGER_OBSERVATION_STALE_OR_FUTURE", runtimeAdmission: "NOT_ADMITTED" };
  }
  if (definition.triggerKind === "CURRENT_FENCED_ATTEMPT_START") {
    const same = [
      [input.jobId, trusted.expectedJobId],
      [input.jobRevisionRef, trusted.expectedJobRevisionRef],
      [input.attemptId, trusted.expectedAttemptId],
      [input.workerId, trusted.expectedWorkerId],
      [input.leaseRef, trusted.expectedLeaseRef],
      [input.leaseRevisionRef, trusted.expectedLeaseRevisionRef],
      [input.fencingToken, trusted.expectedFencingToken],
      [input.requestFingerprint, trusted.expectedRequestFingerprint],
    ].every(([actual, expected]) => expected !== undefined && actual === expected);
    const expiry = Date.parse(input.leaseExpiresAt);
    if (!same || !canonicalUtc(input.leaseExpiresAt) || !Number.isFinite(expiry) || expiry <= now) {
      return { decision: "UNKNOWN", reason: "ATTEMPT_OR_CURRENT_LEASE_FENCE_MISMATCH", runtimeAdmission: "NOT_ADMITTED" };
    }
    const receipt = input.ownerReceipt;
    if (!isRecord(receipt) || receipt.sourceRef !== trusted.expectedReceiptSourceRef || receipt.sourceRef !== definition.receiptSemantics ||
        receipt.subjectRef !== input.jobId || receipt.subjectVersionRef !== input.jobRevisionRef || receipt.attemptRef !== input.attemptId ||
        receipt.leaseRef !== input.leaseRef || receipt.leaseRevisionRef !== input.leaseRevisionRef || receipt.fencingToken !== input.fencingToken ||
        receipt.attemptRecordRef !== input.attemptRecordRef || receipt.workerId !== input.workerId || receipt.sourceStateRef !== trusted.expectedJobStateRef ||
        receipt.requestFingerprint !== input.requestFingerprint || receipt.targetStateRef !== input.attemptStateRef ||
        receipt.authorityRef !== trusted.expectedReadAuthorityRef || receipt.readVersion !== trusted.expectedReadVersion || receipt.currentness !== "CURRENT" ||
        !canonicalUtc(receipt.observedAt) || !Array.isArray(receipt.evidenceRefs) || receipt.evidenceRefs.length === 0 || receipt.disposition !== "VERIFIED") {
      return { decision: "UNKNOWN", reason: "ATTEMPT_START_RECEIPT_UNBOUND_STALE_OR_UNRESOLVED", runtimeAdmission: "NOT_ADMITTED" };
    }
    const receiptTime = Date.parse(receipt.observedAt);
    if (receiptTime > now || now - receiptTime > trusted.maxAgeMs) return { decision: "UNKNOWN", reason: "ATTEMPT_START_RECEIPT_STALE_OR_FUTURE", runtimeAdmission: "NOT_ADMITTED" };
    return { decision: "ELIGIBLE_DEFINITION_ONLY", reason: "EXACT_ATTEMPT_RUNNING_UNDER_CURRENT_UNEXPIRED_FENCE", runtimeAdmission: "NOT_ADMITTED" };
  }
  if (definition.triggerKind === "ACCEPTED_UPLOAD_FINALIZATION_RECEIPT") {
    const same = input.uploadSessionId === trusted.expectedUploadSessionId &&
      input.expectedSessionRevisionRef === trusted.expectedSessionRevisionRef &&
      input.requestFingerprint === trusted.expectedRequestFingerprint;
    if (!same || input.verifiedByteLength !== input.requiredByteLength || input.computedSha256 !== input.declaredSha256) {
      return { decision: "UNKNOWN", reason: "UPLOAD_RECEIPT_SCOPE_BYTES_OR_DIGEST_MISMATCH", runtimeAdmission: "NOT_ADMITTED" };
    }
    const receipt = input.ownerReceipt;
    if (!isRecord(receipt) || receipt.sourceRef !== trusted.expectedReceiptSourceRef || receipt.sourceRef !== definition.receiptSemantics ||
        receipt.subjectRef !== input.uploadSessionId || receipt.subjectVersionRef !== input.expectedSessionRevisionRef ||
        receipt.sourceStateRef !== trusted.expectedSourceStateRef || receipt.targetStateRef !== trusted.expectedTargetStateRef ||
        receipt.requestFingerprint !== input.requestFingerprint || receipt.acceptedReceiptRef !== input.acceptedReceiptRef ||
        receipt.verifiedByteLength !== input.verifiedByteLength || receipt.requiredByteLength !== input.requiredByteLength ||
        receipt.computedSha256 !== input.computedSha256 || receipt.declaredSha256 !== input.declaredSha256 ||
        receipt.computedSha256 !== input.declaredSha256 || receipt.authorityRef !== trusted.expectedReadAuthorityRef ||
        receipt.readVersion !== trusted.expectedReadVersion || receipt.currentness !== "CURRENT" || receipt.disposition !== "VERIFIED" ||
        !canonicalUtc(receipt.observedAt) || !Array.isArray(receipt.evidenceRefs) || receipt.evidenceRefs.length === 0) {
      return { decision: "UNKNOWN", reason: "UPLOAD_FINALIZATION_RECEIPT_UNBOUND_STALE_OR_UNRESOLVED", runtimeAdmission: "NOT_ADMITTED" };
    }
    const receiptTime = Date.parse(receipt.observedAt);
    if (receiptTime > now || now - receiptTime > trusted.maxAgeMs) return { decision: "UNKNOWN", reason: "UPLOAD_FINALIZATION_RECEIPT_STALE_OR_FUTURE", runtimeAdmission: "NOT_ADMITTED" };
    return { decision: "ELIGIBLE_DEFINITION_ONLY", reason: "EXACT_UPLOAD_FINALIZATION_RECEIPT_WITH_VERIFIED_BYTES", runtimeAdmission: "NOT_ADMITTED" };
  }
  if (definition.triggerKind.startsWith("TYPED_FENCED_JOB_ATTEMPT_") && definition.inputSchema) {
    const hasCurrentFence = Object.hasOwn(input, "leaseRef");
    const same = [
      [input.jobId, trusted.expectedJobId],
      [input.jobRevisionRef, trusted.expectedJobRevisionRef],
      [input.requestFingerprint, trusted.expectedRequestFingerprint],
      [input.sourceStateRef, trusted.expectedSourceStateRef],
      [input.targetStateRef, trusted.expectedTargetStateRef],
    ].every(([actual, expected]) => expected !== undefined && actual === expected);
    const fenceMatches = !hasCurrentFence || (
      input.attemptId === trusted.expectedAttemptId && input.workerId === trusted.expectedWorkerId &&
      input.leaseRef === trusted.expectedLeaseRef && input.leaseRevisionRef === trusted.expectedLeaseRevisionRef &&
      input.fencingToken === trusted.expectedFencingToken && canonicalUtc(input.leaseExpiresAt) && Date.parse(input.leaseExpiresAt) > now
    );
    const noFenceMatches = hasCurrentFence || (typeof input.leaseEvidenceDisposition === "string" && input.leaseEvidenceDisposition === definition.inputSchema.properties.leaseEvidenceDisposition.const);
    if (!same || !fenceMatches || !noFenceMatches) {
      return { decision: "UNKNOWN", reason: "JOB_ATTEMPT_FENCE_OR_STATE_TUPLE_MISMATCH", runtimeAdmission: "NOT_ADMITTED" };
    }
    const receipt = input.ownerReceipt;
    if (!isRecord(receipt) || receipt.sourceRef !== definition.receiptSemantics || receipt.sourceRef !== trusted.expectedReceiptSourceRef ||
      receipt.subjectRef !== input.jobId || receipt.subjectVersionRef !== input.jobRevisionRef ||
        receipt.authorityRef !== trusted.expectedReadAuthorityRef || receipt.readVersion !== trusted.expectedReadVersion || receipt.currentness !== "CURRENT" ||
        (input.attemptId !== undefined && receipt.attemptRef !== input.attemptId) ||
        (input.leaseRef !== undefined && (receipt.leaseRef !== input.leaseRef || receipt.leaseRevisionRef !== input.leaseRevisionRef || receipt.fencingToken !== input.fencingToken)) ||
        receipt.sourceStateRef !== input.sourceStateRef ||
        receipt.requestFingerprint !== input.requestFingerprint || receipt.targetStateRef !== input.targetStateRef ||
        !canonicalUtc(receipt.observedAt) || !Array.isArray(receipt.evidenceRefs) || receipt.evidenceRefs.length === 0 ||
        receipt.disposition === "UNKNOWN" || Object.keys(definition.receiptSchema?.properties ?? {}).some((key) => {
          if (["sourceRef", "subjectRef", "subjectVersionRef", "sourceStateRef", "targetStateRef", "requestFingerprint", "authorityRef", "readVersion", "currentness", "observedAt", "evidenceRefs", "disposition"].includes(key)) return false;
          const inputKey = ({ attemptRef: "attemptId" })[key] ?? key;
          return !jsonEqual(receipt[key], input[inputKey]);
        })) {
      return { decision: "UNKNOWN", reason: "OWNER_RECEIPT_UNBOUND_STALE_OR_UNRESOLVED", runtimeAdmission: "NOT_ADMITTED" };
    }
    if (receipt.disposition === "DENIED") return { decision: "DENIED", reason: "OWNER_RECEIPT_DENIES_EXACT_TRANSITION", runtimeAdmission: "NOT_ADMITTED" };
    if (receipt.disposition !== "VERIFIED") return { decision: "UNKNOWN", reason: "OWNER_RECEIPT_DISPOSITION_UNSUPPORTED", runtimeAdmission: "NOT_ADMITTED" };
    const receiptTime = Date.parse(receipt.observedAt);
    if (receiptTime > now || now - receiptTime > trusted.maxAgeMs) return { decision: "UNKNOWN", reason: "OWNER_RECEIPT_STALE_OR_FUTURE", runtimeAdmission: "NOT_ADMITTED" };
    return { decision: "ELIGIBLE_DEFINITION_ONLY", reason: "EXACT_FENCED_JOB_ATTEMPT_RECEIPT_VALIDATED", runtimeAdmission: "NOT_ADMITTED" };
  }
  if (definition.domainObjectRefs?.includes("media.domain.upload-session") && definition.inputSchema) {
    const same = input.uploadSessionId === trusted.expectedUploadSessionId &&
      input.sessionRevisionRef === trusted.expectedSessionRevisionRef &&
      input.sourceStateRef === trusted.expectedSourceStateRef && input.targetStateRef === trusted.expectedTargetStateRef &&
      (input.artifactVersionRef === undefined || input.artifactVersionRef === trusted.expectedArtifactVersionRef);
    if (!same) return { decision: "UNKNOWN", reason: "UPLOAD_CAUSAL_TRIGGER_SUBJECT_OR_VERSION_MISMATCH", runtimeAdmission: "NOT_ADMITTED" };
    const receipt = input.ownerReceipt;
    if (!isRecord(receipt) || receipt.sourceRef !== definition.receiptSemantics ||
        receipt.subjectRef !== input.uploadSessionId || receipt.subjectVersionRef !== input.sessionRevisionRef ||
        receipt.authorityRef !== trusted.expectedReadAuthorityRef || receipt.readVersion !== trusted.expectedReadVersion || receipt.currentness !== "CURRENT" ||
        receipt.sourceStateRef !== input.sourceStateRef || receipt.targetStateRef !== input.targetStateRef ||
        (input.artifactVersionRef !== undefined && receipt.artifactVersionRef !== input.artifactVersionRef) ||
        !canonicalUtc(receipt.observedAt) || !Array.isArray(receipt.evidenceRefs) || receipt.evidenceRefs.length === 0 ||
        receipt.disposition === "UNKNOWN" || definition.receiptSchema?.required?.some((key) => !["sourceRef", "subjectRef", "subjectVersionRef", "sourceStateRef", "targetStateRef", "authorityRef", "readVersion", "currentness", "observedAt", "evidenceRefs", "disposition"].includes(key) && !jsonEqual(receipt[key], input[key]))) {
      return { decision: "UNKNOWN", reason: "UPLOAD_OWNER_RECEIPT_UNBOUND_STALE_OR_UNRESOLVED", runtimeAdmission: "NOT_ADMITTED" };
    }
    const receiptTime = Date.parse(receipt.observedAt);
    if (receiptTime > now || now - receiptTime > trusted.maxAgeMs) return { decision: "UNKNOWN", reason: "UPLOAD_OWNER_RECEIPT_STALE_OR_FUTURE", runtimeAdmission: "NOT_ADMITTED" };
    if (receipt.disposition === "DENIED") return { decision: "DENIED", reason: "UPLOAD_OWNER_RECEIPT_DENIES_EXACT_TRANSITION", runtimeAdmission: "NOT_ADMITTED" };
    if (!Array.isArray(definition.acceptedReceiptDispositions) || !definition.acceptedReceiptDispositions.includes(receipt.disposition)) return { decision: "UNKNOWN", reason: "UPLOAD_OWNER_RECEIPT_DISPOSITION_UNSUPPORTED", runtimeAdmission: "NOT_ADMITTED" };
    return { decision: "ELIGIBLE_DEFINITION_ONLY", reason: "EXACT_UPLOAD_CAUSAL_RECEIPT_VALIDATED", runtimeAdmission: "NOT_ADMITTED" };
  }
  return { decision: "UNKNOWN", reason: "CAUSAL_TRIGGER_KIND_NOT_IMPLEMENTED", runtimeAdmission: "NOT_ADMITTED" };
}

/**
 * Derive a transition-edge decision from closed, fact-specific evidence envelopes.
 * The envelopes are definition fixtures: this does not authenticate a deployed
 * issuer, prove persistence, or admit any runtime producer.
 */
export function evaluateMediaGuardFactReceiptSetDefinition({ definition, input, trusted, validateInputSchema, factContractsByRef }) {
  if (!isRecord(definition) || !isRecord(input) || !isRecord(trusted) || typeof validateInputSchema !== "function" || !(factContractsByRef instanceof Map)) {
    return { decision: "UNKNOWN", reason: "MISSING_OR_MALFORMED_GUARD_RECEIPT_INPUT", runtimeAdmission: "NOT_ADMITTED" };
  }
  if (!validateInputSchema(input) || !canonicalUtc(trusted.now) || !canonicalUtc(input.occurredAt) ||
      !Number.isSafeInteger(trusted.maxEventAgeMs) || trusted.maxEventAgeMs < 0) {
    return { decision: "UNKNOWN", reason: "GUARD_RECEIPT_SCHEMA_OR_CLOCK_INVALID", runtimeAdmission: "NOT_ADMITTED" };
  }
  const now = Date.parse(trusted.now);
  const eventTime = Date.parse(input.occurredAt);
  if (eventTime > now || now - eventTime > trusted.maxEventAgeMs ||
      input.transitionRef !== definition.transitionRef || input.edgeRuleRef !== definition.edgeRuleRef ||
      input.producerRef !== definition.producerRef || input.aggregateRef !== trusted.expectedAggregateRef ||
      input.aggregateVersionRef !== trusted.expectedAggregateVersionRef || input.sourceStateRef !== definition.sourceStateRef ||
      input.targetStateRef !== definition.targetStateRef) {
    return { decision: "UNKNOWN", reason: "GUARD_RECEIPT_EDGE_SUBJECT_OR_CURRENTNESS_MISMATCH", runtimeAdmission: "NOT_ADMITTED" };
  }
  if (!Array.isArray(input.factReceipts) || input.factReceipts.length !== definition.triggerGuardFacts.length) {
    return { decision: "UNKNOWN", reason: "GUARD_RECEIPT_SET_INCOMPLETE", runtimeAdmission: "NOT_ADMITTED" };
  }
  const byRef = new Map();
  for (const receipt of input.factReceipts) {
    if (!isRecord(receipt) || byRef.has(receipt.factRef)) return { decision: "UNKNOWN", reason: "GUARD_RECEIPT_DUPLICATE_OR_MALFORMED", runtimeAdmission: "NOT_ADMITTED" };
    byRef.set(receipt.factRef, receipt);
  }
  const verdicts = new Map();
  for (const expected of definition.triggerGuardFacts) {
    const receipt = byRef.get(expected.sourceRef);
    const contract = factContractsByRef.get(expected.factContractRef);
    if (!receipt || !contract || receipt.contractRef !== expected.factContractRef || receipt.producerRef !== definition.producerRef ||
        receipt.subjectRef !== trusted.expectedAggregateRef || receipt.subjectVersionRef !== trusted.expectedAggregateVersionRef ||
        receipt.tenantId !== trusted.tenantId || receipt.authorityRef !== trusted.expectedAuthorityByFact?.[expected.sourceRef] ||
        !contract.authorityRefs.includes(receipt.authorityRef) || receipt.readVersion !== trusted.expectedReadVersionByFact?.[expected.sourceRef] ||
        !canonicalUtc(receipt.observedAt) || !Number.isSafeInteger(trusted.maxAgeMsByFact?.[expected.sourceRef]) ||
        trusted.maxAgeMsByFact[expected.sourceRef] < 0 || Date.parse(receipt.observedAt) > now ||
        now - Date.parse(receipt.observedAt) > trusted.maxAgeMsByFact[expected.sourceRef] ||
        !Array.isArray(receipt.evidenceRefs) || receipt.evidenceRefs.length === 0) {
      return { decision: "UNKNOWN", reason: "GUARD_FACT_RECEIPT_SCOPE_AUTHORITY_VERSION_OR_FRESHNESS_MISMATCH", runtimeAdmission: "NOT_ADMITTED" };
    }
    if (!validateOwnerClosedJsonSchema(contract.valueSchema, receipt.value).valid) {
      return { decision: "UNKNOWN", reason: "GUARD_FACT_VALUE_SCHEMA_REJECTED", runtimeAdmission: "NOT_ADMITTED" };
    }
    let verdict = "UNKNOWN";
    if (contract.valueKind === "EXACT_STATE_OBSERVATION") {
      const value = receipt.value;
      if (value?.observationDisposition === "OBSERVED" && Array.isArray(contract.valueSchema.oneOf?.[0]?.properties?.observedStateRef?.enum) && contract.valueSchema.oneOf[0].properties.observedStateRef.enum.includes(value.observedStateRef)) {
        verdict = value.observedStateRef === definition.targetStateRef ? "SATISFIED" : "DENIED";
      } else if (value?.observationDisposition !== "UNKNOWN" || typeof value.observationReason !== "string") {
        return { decision: "UNKNOWN", reason: "STATE_RECEIPT_VALUE_MALFORMED", runtimeAdmission: "NOT_ADMITTED" };
      }
    } else if (contract.valueKind === "TENANT_IDENTITY_TUPLE") {
      const value = receipt.value;
      if (value?.identityDisposition === "UNKNOWN") verdict = "UNKNOWN";
      else verdict = value?.tenantId === trusted.tenantId && value?.subjectTenantId === trusted.tenantId ? "SATISFIED" : "DENIED";
    } else if (contract.valueKind === "EXACT_PROJECT_HEAD_REVISION_EQUALITY") {
      const value = receipt.value;
      if (value?.observationDisposition === "UNKNOWN" && typeof value.observationReason === "string") {
        verdict = "UNKNOWN";
        verdicts.set(expected.sourceRef, verdict);
        continue;
      }
      const expectedHead = trusted.expectedVersionByFact?.[expected.sourceRef];
      if (value?.projectRef !== trusted.expectedProjectRef || typeof expectedHead !== "string" || value?.expectedHeadRevisionId !== expectedHead) {
        return { decision: "UNKNOWN", reason: "PROJECT_REVISION_REQUEST_OR_SUBJECT_BINDING_MISMATCH", runtimeAdmission: "NOT_ADMITTED" };
      }
      verdict = value.observedCurrentHeadRevisionId === value.expectedHeadRevisionId ? "SATISFIED" : "DENIED";
    } else if (contract.valueKind === "EXHAUSTIVE_ACTIVE_HOLD_SET") {
      const value = receipt.value;
      if (value?.subjectRef !== trusted.expectedAggregateRef || value?.subjectVersionRef !== trusted.expectedAggregateVersionRef ||
          typeof trusted.expectedPurposeByFact?.[expected.sourceRef] !== "string" || value?.purposeRef !== trusted.expectedPurposeByFact[expected.sourceRef]) {
        return { decision: "UNKNOWN", reason: "HOLD_QUERY_SUBJECT_VERSION_OR_PURPOSE_MISMATCH", runtimeAdmission: "NOT_ADMITTED" };
      }
      if (value.enumerationDisposition === "UNKNOWN" || value.enumerationDisposition === "INCOMPLETE") verdict = "UNKNOWN";
      else verdict = value.activeHoldRefs.length === 0 ? "SATISFIED" : "DENIED";
    } else if (contract.valueKind === "EXHAUSTIVE_COPY_INVENTORY") {
      const value = receipt.value;
      const requiredClasses = trusted.expectedCopyClassesByFact?.[expected.sourceRef];
      const expectedManifestRef = trusted.expectedInventoryManifestRefByFact?.[expected.sourceRef];
      const expectedInventoryRevision = trusted.expectedInventoryRevisionByFact?.[expected.sourceRef];
      if (value?.subjectRef !== trusted.expectedAggregateRef || value?.subjectVersionRef !== trusted.expectedAggregateVersionRef ||
          typeof expectedManifestRef !== "string" || value.inventoryManifestRef !== expectedManifestRef ||
          !Number.isSafeInteger(expectedInventoryRevision) || value.inventoryRevision !== expectedInventoryRevision ||
          !Array.isArray(requiredClasses) || requiredClasses.length === 0 ||
          JSON.stringify([...value.requiredCopyClasses].sort()) !== JSON.stringify([...requiredClasses].sort())) {
        return { decision: "UNKNOWN", reason: "COPY_INVENTORY_SUBJECT_VERSION_MANIFEST_REVISION_OR_REQUIRED_SCOPE_MISMATCH", runtimeAdmission: "NOT_ADMITTED" };
      }
      if (value.inventoryDisposition !== "COMPLETE" || value.unresolvedCopyRefs.length > 0 ||
          value.classCoverage.some((row) => row.enumerationDisposition !== "EXHAUSTIVE")) {
        verdict = "UNKNOWN";
      } else {
        const actualClasses = value.classCoverage.map((row) => row.copyClass).sort();
        const copyRefs = value.classCoverage.flatMap((row) => row.copyRefs);
        verdict = JSON.stringify(actualClasses) === JSON.stringify([...requiredClasses].sort()) && new Set(copyRefs).size === copyRefs.length
          ? "SATISFIED" : "UNKNOWN";
      }
    } else if (contract.valueKind === "CURRENT_PER_EFFECT_CONSENT_SET") {
      verdict = deriveCurrentPerEffectConsent({ value: receipt.value, expected, trusted, now: trusted.now });
    } else if (contract.valueKind === "EXACT_SCOPED_AUTHORITY_DECISION") {
      const decision = receipt.value;
      const expectedDecision = trusted.expectedAuthorityDecisionByFact?.[expected.sourceRef];
      if (!isRecord(expectedDecision) || !canonicalUtc(trusted.now) || !canonicalUtc(decision?.observedAt) ||
          !canonicalUtc(decision?.validFrom) || !canonicalUtc(decision?.validUntil)) {
        verdict = "UNKNOWN";
      } else {
        const decisionTime = Date.parse(decision.observedAt);
        const validFrom = Date.parse(decision.validFrom);
        const validUntil = Date.parse(decision.validUntil);
        const maxAgeMs = trusted.maxAgeMsByFact?.[expected.sourceRef];
        const tupleMatches = decision.decisionRef === expectedDecision.decisionRef &&
          decision.tenantId === trusted.tenantId && decision.principalId === trusted.principalId &&
          decision.subjectRef === trusted.expectedAggregateRef && decision.subjectVersionRef === trusted.expectedAggregateVersionRef &&
          decision.transitionRef === definition.transitionRef && decision.edgeRuleRef === definition.edgeRuleRef &&
          decision.effectRef === expectedDecision.effectRef && expectedDecision.effectRef === definition.edgeRuleRef &&
          decision.authorityRef === expectedDecision.authorityRef && decision.policyRef === expectedDecision.policyRef &&
          decision.policyRevisionRef === expectedDecision.policyRevisionRef && decision.decisionMethodRef === expectedDecision.decisionMethodRef &&
          receipt.authorityRef === expectedDecision.authorityRef;
        if (!tupleMatches || !Number.isFinite(decisionTime) || !Number.isFinite(validFrom) || !Number.isFinite(validUntil) ||
            validFrom >= validUntil || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0 || decisionTime > now || now - decisionTime > maxAgeMs) {
          verdict = "UNKNOWN";
        } else if (decision.decisionDisposition === "UNKNOWN") {
          verdict = "UNKNOWN";
        } else if (now < validFrom || now >= validUntil) {
          verdict = "UNKNOWN";
        } else {
          verdict = decision.decisionDisposition === "GRANTED" ? "SATISFIED" : "DENIED";
        }
      }
    } else if (contract.valueKind === "EXACT_SCOPED_POLICY_REVISION_OBSERVATION") {
      const observation = receipt.value;
      const expectedPolicyRef = trusted.expectedPolicyRefByFact?.[expected.sourceRef];
      const expectedPolicyRevisionRef = trusted.expectedPolicyRevisionRefByFact?.[expected.sourceRef];
      const maxAgeMs = trusted.maxAgeMsByFact?.[expected.sourceRef];
      const observedAt = canonicalUtc(observation?.observedAt) ? Date.parse(observation.observedAt) : Number.NaN;
      const exactTuple = observation?.tenantId === trusted.tenantId && observation?.principalId === trusted.principalId &&
        observation?.subjectRef === trusted.expectedAggregateRef && observation?.subjectVersionRef === trusted.expectedAggregateVersionRef &&
        observation?.transitionRef === definition.transitionRef && observation?.edgeRuleRef === definition.edgeRuleRef &&
        observation?.effectRef === definition.edgeRuleRef && observation?.authorityRef === trusted.expectedAuthorityByFact?.[expected.sourceRef] &&
        observation?.policyRef === expectedPolicyRef && observation?.expectedPolicyRevisionRef === expectedPolicyRevisionRef;
      if (!exactTuple || !canonicalUtc(trusted.now) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0 ||
          !Number.isFinite(observedAt) || observedAt > now || now - observedAt > maxAgeMs) {
        verdict = "UNKNOWN";
      } else if (observation.observationDisposition === "UNKNOWN") {
        verdict = "UNKNOWN";
      } else if (observation.observationDisposition === "CURRENT" && observation.observedPolicyRevisionRef === expectedPolicyRevisionRef) {
        verdict = "SATISFIED";
      } else if (observation.observationDisposition === "NOT_CURRENT" && observation.observedPolicyRevisionRef !== expectedPolicyRevisionRef) {
        verdict = "DENIED";
      } else {
        verdict = "UNKNOWN";
      }
    } else if (contract.valueKind === "EXACT_ACCEPTED_REQUEST_SNAPSHOT") {
      const snapshot = evaluateAcceptedRequestSnapshot(receipt.value, expected, trusted, expected.sourceRef);
      verdict = snapshot.verdict;
    } else if (contract.valueKind === "UNRESOLVED_OWNER_PREDICATE") {
      verdict = "UNKNOWN";
    } else {
      const disposition = receipt.value?.[contract.valueProperty];
      if (disposition === "UNKNOWN") verdict = "UNKNOWN";
      else if (disposition === contract.valueSemantics) verdict = "SATISFIED";
      else if (typeof disposition === "string") verdict = "DENIED";
    }
    verdicts.set(expected.sourceRef, verdict);
  }
  const evaluate = (node) => {
    if (node?.factRef) return verdicts.get(node.factRef) === "SATISFIED" ? true : verdicts.get(node.factRef) === "DENIED" ? false : null;
    const groups = ["all", "any"].filter((key) => Array.isArray(node?.[key]));
    if (groups.length !== 1 || node[groups[0]].length === 0) return null;
    const children = node[groups[0]].map(evaluate);
    if (groups[0] === "all") return children.includes(false) ? false : children.includes(null) ? null : true;
    return children.includes(true) ? true : children.includes(null) ? null : false;
  };
  const value = evaluate(definition.guardExpression);
  const derived = value === true ? "APPLIED" : value === false ? "DENIED" : "UNKNOWN";
  if (input.decision !== derived) return { decision: "UNKNOWN", reason: "GUARD_DECISION_CONTRADICTS_TYPED_FACTS", runtimeAdmission: "NOT_ADMITTED" };
  return { decision: derived === "APPLIED" ? "APPLIED_DEFINITION_ONLY" : derived, reason: "EXACT_FACT_RECEIPT_SET_EVALUATED_WITHOUT_RUNTIME_CLAIM", runtimeAdmission: "NOT_ADMITTED" };
}
