import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const parse = createRequire(new URL("../../ghatana-tools/package.json", import.meta.url))("yaml").parse;
const stringify = createRequire(new URL("../../ghatana-tools/package.json", import.meta.url))("yaml").stringify;
const p1 = ".product-experience/pdp-1-domain-data";
const p3 = ".product-experience/pdp-3-product-experience";
const transitionPath = `${p1}/transitions.yaml`;
const transitionsText = readFileSync(transitionPath, "utf8");
const refresh = process.argv.includes("--refresh-trailing-owner-collection");
let baseText = transitionsText;
let transitions = parse(baseText);
if (transitions.ownerDefinedTransitionTriggerSemantics) {
  if (!refresh) throw new Error("Trigger semantics are already present; pass --refresh-trailing-owner-collection to replace only this exact trailing collection");
  const marker = "\nownerDefinedTransitionTriggerSemantics:\n";
  const offset = baseText.lastIndexOf(marker);
  if (offset < 0 || offset + marker.length >= baseText.length) throw new Error("Cannot safely locate the trailing owner collection");
  const prefix = baseText.slice(0, offset).trimEnd() + "\n";
  const historical = parse(prefix);
  if (historical.ownerDefinedTransitionTriggerSemantics) throw new Error("Refusing refresh: collection marker is not the only owner collection in the preserved prefix");
  if (Object.keys(transitions).some((key) => key !== "ownerDefinedTransitionTriggerSemantics" && historical[key] === undefined)) throw new Error("Refusing refresh: trailing collection appears to contain unrelated top-level source edits");
  baseText = prefix;
  transitions = historical;
}
const guards = parse(readFileSync(`${p1}/transition-guard-contracts.yaml`, "utf8"));
const states = parse(readFileSync(`${p1}/states.yaml`, "utf8"));
const actions = parse(readFileSync(`${p3}/action-registry.yaml`, "utf8"));
const guardByTransition = new Map(guards.records.map((row) => [row.transitionId, row]));
const machineById = new Map(states.stateMachines.map((row) => [row.machineId, row]));
const exactTransitionActions = new Map();
for (const action of [...(actions.actions ?? []), ...(actions.ownerDefinedActions ?? [])]) {
  const typed = action.actionDefinitionSemantics?.typedDefinition;
  for (const operation of typed?.canonicalOperationBindings?.operations ?? []) {
    for (const transitionId of operation.transitionRefs ?? []) {
      const rows = exactTransitionActions.get(transitionId) ?? [];
      rows.push({ actionRef: action.id, operationRef: operation.operationRef, operationKind: operation.operationKind, actorRefs: action.actorRefs ?? [] });
      exactTransitionActions.set(transitionId, rows);
    }
  }
}

function sourceStateRef(machineId, dimension, stateId) {
  const machine = machineById.get(machineId);
  if (machine?.stateDefinitions?.some((row) => row.id === stateId)) return `${p1}/states.yaml#stateMachines/@machineId=${machineId}/stateDefinitions/@id=${stateId}`;
  if (dimension && machine?.stateDefinitionsByDimension?.[dimension]?.some((row) => row.id === stateId)) return `${p1}/states.yaml#stateMachines/@machineId=${machineId}/stateDefinitionsByDimension/${dimension}/@id=${stateId}`;
  throw new Error(`Missing exact state definition ${machineId}/${dimension ?? "default"}/${stateId}`);
}

function ownerReceiptSchema({ sourceRef, subjectField, subjectVersionField, sourceStateField, targetStateField, sourceStateRef, targetStateRef, requestFingerprintField, fields, required }) {
  const properties = {
    sourceRef: { const: sourceRef },
    tenantId: { type: "string", minLength: 1, maxLength: 256 },
    subjectRef: { type: "string", minLength: 1, maxLength: 512 },
    subjectVersionRef: { type: "string", minLength: 1, maxLength: 512 },
    sourceStateRef: sourceStateRef ? { const: sourceStateRef } : { type: "string", minLength: 1, maxLength: 512 },
    targetStateRef: targetStateRef ? { const: targetStateRef } : { type: "string", minLength: 1, maxLength: 512 },
    authorityRef: { type: "string", minLength: 1, maxLength: 512 },
    readVersion: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    currentness: { const: "CURRENT" },
    observedAt: { type: "string", format: "date-time" },
    evidenceRefs: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 512 } },
    disposition: { enum: ["VERIFIED", "DENIED"] },
    ...fields,
  };
  if (requestFingerprintField) properties.requestFingerprint = { type: "string", pattern: "^sha256:[0-9a-f]{64}$" };
  const commonRequired = ["sourceRef", "tenantId", "subjectRef", "subjectVersionRef", "sourceStateRef", "targetStateRef", "authorityRef", "readVersion", "currentness", "observedAt", "evidenceRefs", "disposition"];
  if (requestFingerprintField) commonRequired.push("requestFingerprint");
  return {
    type: "object",
    additionalProperties: false,
    required: [...new Set([...commonRequired, ...required])],
    properties,
    "x-media-bindings": { subjectRef: subjectField, subjectVersionRef: subjectVersionField, sourceStateRef: sourceStateField, targetStateRef: targetStateField, requestFingerprint: requestFingerprintField },
  };
}

function classifyEdge({ transition, edge, exactActions, guardRef, edgeIndex }) {
  const leaves = [];
  const guardExpression = { all: (edge.when?.all ?? []).map((entry, index) => expressionFor(entry, guardRef, `edgeRules/${edgeIndex}/when/all/${index}`, leaves)) };
  const factNames = leaves.map(({ fact }) => fact);
  if (exactActions.length) return { triggerKind: "EXACT_OPERATION_REQUEST", exactActionBinding: exactActions, leaves, guardExpression };
  if (String(transition.eventTriggers ?? "").includes("authority-source-event-required")) return { triggerKind: "UPSTREAM_AUTHORITY_EVENT", exactActionBinding: [], leaves, guardExpression };
  if (factNames.includes("providerObservationRecorded")) return { triggerKind: "PROVIDER_OBSERVATION", exactActionBinding: [], leaves, guardExpression };
  if (factNames.some((name) => /destinationEvidenceRecorded|destinationQueryOrReconciliationStarted|destinationEffectsAccounted/u.test(name))) return { triggerKind: "DESTINATION_OBSERVATION_OR_RECONCILIATION", exactActionBinding: [], leaves, guardExpression };
  if (factNames.some((name) => /reviewerAuthorized|reviewerDelegationCurrent|reviewPurposeSelected|reviewPurposeCurrent|reviewOrErasureDecisionRecorded|approvalDurable|versionValidityOrExpiryOrWithdrawalEvidence/u.test(name))) return { triggerKind: "REVIEW_OR_APPROVAL_DECISION", exactActionBinding: [], leaves, guardExpression };
  if (factNames.some((name) => /policyEventRecorded|expiryPolicyCurrent|holdReleaseOrBoundaryEvidence|erasureIntentDurable|copyInventoryComplete|deletionEvidenceRecorded|revocationOrExpiryDurable/u.test(name))) return { triggerKind: "POLICY_RETENTION_OR_ERASURE_EVENT", exactActionBinding: [], leaves, guardExpression };
  if (factNames.some((name) => /measurementOrAbstentionRecorded|metricApplicabilityDeclared|measurementProtocolVersionBound|outputOrMeasurementProtocolChanged/u.test(name))) return { triggerKind: "QUALITY_MEASUREMENT_OR_INVALIDATION", exactActionBinding: [], leaves, guardExpression };
  if (factNames.some((name) => /formatDispositionRecorded|integrityDispositionRecorded|rightsDispositionRecorded|securityDispositionRecorded/u.test(name))) return { triggerKind: "VERIFICATION_EVIDENCE_RECORDED", exactActionBinding: [], leaves, guardExpression };
  if (factNames.some((name) => /attemptOutcomeRecorded|reconciliationEvidenceDurable|safeDecisionRecorded|dispatchIntentDurable|dispatchMayHaveCrossed|idempotencyIdentityRecorded|cancellationRaceEvidenceRecorded/u.test(name))) return { triggerKind: "JOB_OR_ATTEMPT_CONTROL_PLANE_EVIDENCE", exactActionBinding: [], leaves, guardExpression };
  if (factNames.some((name) => /sessionGrantCurrent|providerBindingCurrent|consentPerEffectCurrent|leaseSequenceCurrent|degradationPolicyDeclared|recoveryBudgetAvailable|activeEffectsResolvedOrUnknown|newWorkFenced/u.test(name))) return { triggerKind: "STREAM_SESSION_CONTROL_OR_LEASE_EVIDENCE", exactActionBinding: [], leaves, guardExpression };
  if (factNames.some((name) => /projectOwnerAuthorized|projectAccessCurrent|referencedArtifactsAvailable|currentHeadRecorded|atomicCommitAvailable|expectedVersionMatches|expectedVersionConflicts|newHeadCommitted|inviteeAccepted|inviterAuthorized|identityCurrent|projectScopeMatches/u.test(name))) return { triggerKind: "PROJECT_OWNER_OR_REVISION_EVENT", exactActionBinding: [], leaves, guardExpression };
  const supportedOutcome = factNames.find((name) => name.startsWith("outcome."));
  if (supportedOutcome) return { triggerKind: "TYPED_STATE_OUTCOME_EVIDENCE", exactActionBinding: [], leaves, guardExpression };
  return { triggerKind: "GUARDED_OWNER_STATE_EVENT", exactActionBinding: [], leaves, guardExpression };
}

function expressionFor(node, sourcePrefix, path, leaves) {
  if (typeof node === "string" || node?.fact) {
    const fact = typeof node === "string" ? node : node.fact;
    const sourceRef = `${sourcePrefix}/${path}`;
    leaves.push({ fact, sourceRef });
    return { factRef: sourceRef };
  }
  if (node?.all) return { all: node.all.map((child, index) => expressionFor(child, sourcePrefix, `${path}/all/${index}`, leaves)) };
  if (node?.any) return { any: node.any.map((child, index) => expressionFor(child, sourcePrefix, `${path}/any/${index}`, leaves)) };
  throw new Error(`Unsupported guard expression at ${sourcePrefix}/${path}`);
}

function causalTriggerDefinition({ transition, edge, edgeToStateRef, edgeFromStateRef, guardRef, edgeIndex }) {
  if (transition.id === "media-job/T01" && edge.to === "RUNNING") {
    const attemptTransitionRef = `${p1}/transitions.yaml#transitionRecords/@id=media-attempt/T03`;
    const attemptRunningRef = sourceStateRef("media-attempt", null, "RUNNING");
    const receiptSchema = ownerReceiptSchema({
      sourceRef: `${p1}/operations.yaml#ownerAttemptLeaseLifecycle`, subjectField: "jobId", subjectVersionField: "jobRevisionRef",
      sourceStateField: "sourceStateRef", targetStateField: "targetStateRef", sourceStateRef: edgeFromStateRef, targetStateRef: attemptRunningRef,
      requestFingerprintField: "requestFingerprint",
      fields: { attemptRef: { type: "string", minLength: 1, maxLength: 256 }, attemptRecordRef: { type: "string", minLength: 1, maxLength: 512 }, workerId: { type: "string", minLength: 1, maxLength: 256 }, leaseRef: { type: "string", minLength: 1, maxLength: 512 }, leaseRevisionRef: { type: "string", minLength: 1, maxLength: 512 }, fencingToken: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
      required: ["attemptRef", "attemptRecordRef", "workerId", "leaseRef", "leaseRevisionRef", "fencingToken"],
    });
    return {
      id: "media.transition-trigger-definition.media-job-queued-to-running.v1",
      triggerKind: "CURRENT_FENCED_ATTEMPT_START",
      sourceStateRef: edgeFromStateRef,
      targetStateRef: edgeToStateRef,
      triggerRule: "The job may move QUEUED to RUNNING only after the exact current attempt has entered RUNNING under its current unexpired lease/fence, the job revision is still QUEUED, and the attempt belongs to that job. A queued receipt, dispatch intent, provider acceptance, or target-state label alone is insufficient.",
      sourceRefs: [
        attemptTransitionRef,
        `${p1}/operations.yaml#ownerAttemptLeaseLifecycle`,
        `${p1}/domain-objects.yaml#objects/@id=media.domain.processing-job`,
        `${p1}/domain-objects.yaml#objects/@id=media.domain.job-attempt`,
        `${p1}/domain-objects.yaml#objects/@id=media.domain.job-lease`,
        edgeFromStateRef,
        edgeToStateRef,
        attemptRunningRef,
        guardRef,
      ],
      subjectBindings: {
        jobRef: "media.domain.processing-job",
        attemptRef: "media.domain.job-attempt",
        leaseRef: "media.domain.job-lease",
        attemptBelongsToJob: "exact jobId equality in the immutable attempt record",
      },
      receiptSemantics: `${p1}/operations.yaml#ownerAttemptLeaseLifecycle`,
      requiredEvidence: ["jobId", "jobRevisionRef", "attemptId", "attemptRecordRef", "attemptStateRef", "workerId", "leaseRef", "leaseRevisionRef", "fencingToken", "leaseExpiresAt", "requestFingerprint", "observedAt"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["tenantId", "jobId", "jobRevisionRef", "attemptId", "attemptRecordRef", "attemptStateRef", "workerId", "leaseRef", "leaseRevisionRef", "fencingToken", "leaseExpiresAt", "requestFingerprint", "observedAt", "ownerReceipt"],
        properties: {
          tenantId: { type: "string", minLength: 1, maxLength: 256 },
          jobId: { type: "string", minLength: 1, maxLength: 256 },
          jobRevisionRef: { type: "string", minLength: 1, maxLength: 512 },
          attemptId: { type: "string", minLength: 1, maxLength: 256 },
          attemptRecordRef: { type: "string", minLength: 1, maxLength: 512 },
          attemptStateRef: { const: attemptRunningRef },
          workerId: { type: "string", minLength: 1, maxLength: 256 },
          leaseRef: { type: "string", minLength: 1, maxLength: 512 },
          leaseRevisionRef: { type: "string", minLength: 1, maxLength: 512 },
          fencingToken: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          leaseExpiresAt: { type: "string", format: "date-time" },
          requestFingerprint: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
          observedAt: { type: "string", format: "date-time" },
          ownerReceipt: receiptSchema,
        },
      },
      receiptSchema,
      trustedContext: ["tenantId", "principalId", "expectedJobId", "expectedJobRevisionRef", "expectedJobStateRef", "expectedAttemptId", "expectedWorkerId", "expectedLeaseRef", "expectedLeaseRevisionRef", "expectedFencingToken", "expectedRequestFingerprint", "expectedReceiptSourceRef", "expectedReadAuthorityRef", "expectedReadVersion", "now"],
      evaluation: "Every supplied identity/fence value must equal the independently current host/owner tuple; leaseExpiresAt must be later than trusted now; stale, mismatched, missing, contradictory, or unverified attempt/lease evidence yields UNKNOWN and does not advance the job.",
      effect: "Definition-level eligibility for the exact QUEUED-to-RUNNING job edge after a fenced attempt is observed RUNNING; persisted job state still requires an independent current job read.",
      runtimeAdmission: "NOT_ADMITTED",
      acceptanceEffect: "none",
    };
  }
  if (transition.id === "media-upload-and-artifact/T01" && edge.to === "VERIFYING") {
    const operationRef = "media.operation-slice.complete-upload";
    const receiptSchema = ownerReceiptSchema({
      sourceRef: `${p1}/operations.yaml#individualOperationContracts/records/@id=${operationRef}`, subjectField: "uploadSessionId", subjectVersionField: "expectedSessionRevisionRef",
      sourceStateField: "sourceStateRef", targetStateField: "targetStateRef", sourceStateRef: edgeFromStateRef, targetStateRef: edgeToStateRef,
      requestFingerprintField: "requestFingerprint",
      fields: { acceptedReceiptRef: { type: "string", minLength: 1, maxLength: 512 }, verifiedByteLength: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, requiredByteLength: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, computedSha256: { type: "string", pattern: "^[0-9a-f]{64}$" }, declaredSha256: { type: "string", pattern: "^[0-9a-f]{64}$" } },
      required: ["acceptedReceiptRef", "verifiedByteLength", "requiredByteLength", "computedSha256", "declaredSha256"],
    });
    return {
      id: "media.transition-trigger-definition.upload-receiving-to-verifying.v1",
      triggerKind: "ACCEPTED_UPLOAD_FINALIZATION_RECEIPT",
      sourceStateRef: edgeFromStateRef,
      targetStateRef: edgeToStateRef,
      triggerRule: "Only the exact complete-upload operation's accepted finalization receipt, bound to the current upload session revision and verified required bytes plus SHA-256, can trigger RECEIVING to VERIFYING. Rejection, conflict, timeout, or unknown outcome does not trigger this edge.",
      sourceRefs: [
        `${p1}/operations.yaml#individualOperationContracts/records/@id=${operationRef}`,
        `${p1}/transitions.yaml#transitionRecords/@id=${transition.id}`,
        `${p1}/domain-objects.yaml#objects/@id=media.domain.upload-session`,
        `${p1}/domain-objects.yaml#objects/@id=media.domain.artifact-version`,
        edgeFromStateRef,
        edgeToStateRef,
        guardRef,
      ],
      exactOperationRef: operationRef,
      receiptSemantics: `${p1}/operations.yaml#individualOperationContracts/records/@id=${operationRef}`,
      requiredEvidence: ["uploadSessionId", "expectedSessionRevisionRef", "requestFingerprint", "acceptedReceiptRef", "verifiedByteLength", "requiredByteLength", "computedSha256", "declaredSha256", "observedAt"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["tenantId", "uploadSessionId", "expectedSessionRevisionRef", "requestFingerprint", "acceptedReceiptRef", "verifiedByteLength", "requiredByteLength", "computedSha256", "declaredSha256", "observedAt", "ownerReceipt"],
        properties: {
          tenantId: { type: "string", minLength: 1, maxLength: 256 },
          uploadSessionId: { type: "string", minLength: 1, maxLength: 256 },
          expectedSessionRevisionRef: { type: "string", minLength: 1, maxLength: 512 },
          requestFingerprint: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
          acceptedReceiptRef: { type: "string", minLength: 1, maxLength: 512 },
          verifiedByteLength: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          requiredByteLength: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          computedSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
          declaredSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
          observedAt: { type: "string", format: "date-time" },
          ownerReceipt: receiptSchema,
        },
      },
      receiptSchema,
      trustedContext: ["tenantId", "principalId", "expectedUploadSessionId", "expectedSessionRevisionRef", "expectedRequestFingerprint", "expectedReceiptSourceRef", "expectedReadAuthorityRef", "expectedReadVersion", "currentnessClock"],
      evaluation: "Bind the receipt to the exact current upload session and host scope; require byte length and digest equality. Unknown or stale receipt is UNKNOWN; no artifact availability is implied.",
      effect: "The exact upload session enters VERIFYING; this is not verification success, artifact availability, or product acceptance.",
      runtimeAdmission: "NOT_ADMITTED",
      acceptanceEffect: "none",
    };
  }
  const artifactEdges = new Set([
    "media-upload-and-artifact/T01:REJECTED", "media-upload-and-artifact/T01:EXPIRED",
    "media-upload-and-artifact/T02:AVAILABLE", "media-upload-and-artifact/T02:QUARANTINED", "media-upload-and-artifact/T02:REJECTED",
    "media-upload-and-artifact/T03:QUARANTINED", "media-upload-and-artifact/T03:EXPIRED", "media-upload-and-artifact/T03:ERASURE_REQUESTED",
    "media-upload-and-artifact/T04:AVAILABLE", "media-upload-and-artifact/T04:REJECTED", "media-upload-and-artifact/T04:ERASURE_REQUESTED",
    "media-upload-and-artifact/T05:PHYSICAL_ERASURE_PENDING", "media-upload-and-artifact/T05:BLOCKED_BY_HOLD",
    "media-upload-and-artifact/T06:ACCESS_REVOKED", "media-upload-and-artifact/T06:BLOCKED_BY_HOLD",
    "media-upload-and-artifact/T07:PHYSICAL_ERASURE_PENDING", "media-upload-and-artifact/T07:BLOCKED_BY_HOLD", "media-upload-and-artifact/T07:EXTERNAL_ERASURE_UNCONFIRMED",
    "media-upload-and-artifact/T08:ERASURE_CONFIRMED", "media-upload-and-artifact/T08:BLOCKED_BY_HOLD", "media-upload-and-artifact/T08:EXTERNAL_ERASURE_UNCONFIRMED",
    "media-upload-and-artifact/T09:PHYSICAL_ERASURE_PENDING", "media-upload-and-artifact/T09:EXTERNAL_ERASURE_UNCONFIRMED",
  ]);
  const artifactEdgeKey = `${transition.id}:${edge.to}`;
  if (artifactEdges.has(artifactEdgeKey)) {
    const specs = {
      "T01:REJECTED": { kind: "AUTHORITATIVE_UPLOAD_REJECTION", rule: "Reject only on current, subject-bound authoritative format, integrity, security, rights, consent, or policy denial; timeout/unknown does not reject.", required: ["rejectionEvidenceRef", "rejectedCheckKind", "decisionAuthorityRef", "decisionVersionRef"], props: { rejectionEvidenceRef: { type: "string", minLength: 1, maxLength: 512 }, rejectedCheckKind: { enum: ["FORMAT", "INTEGRITY", "SECURITY", "RIGHTS", "CONSENT", "POLICY"] }, decisionAuthorityRef: { type: "string", minLength: 1, maxLength: 512 }, decisionVersionRef: { type: "string", minLength: 1, maxLength: 512 } } },
      "T01:EXPIRED": { kind: "UPLOAD_SESSION_EXPIRY", rule: "Expire only when the exact upload-session expiry is at or before trusted current time under the current expiry policy; an elapsed client timer is insufficient.", required: ["expiryPolicyRef", "expiresAt", "expiryEvidenceRef"], props: { expiryPolicyRef: { type: "string", minLength: 1, maxLength: 512 }, expiresAt: { type: "string", format: "date-time" }, expiryEvidenceRef: { type: "string", minLength: 1, maxLength: 512 } } },
      "T02:AVAILABLE": { kind: "ALL_REQUIRED_VERIFICATION_POSITIVE", rule: "Availability requires exact current integrity, format, security, rights, consent-when-applicable, and policy results for the immutable artifact version; all results share subject, purpose, and current authority scope.", required: ["artifactVersionRef", "integrityAssessmentRef", "formatAssessmentRef", "securityAssessmentRef", "rightsDecisionRef", "consentDispositionRef", "policyEvaluationRef", "verificationBundleRef"], props: { artifactVersionRef: { type: "string", minLength: 1, maxLength: 512 }, integrityAssessmentRef: { type: "string", minLength: 1, maxLength: 512 }, formatAssessmentRef: { type: "string", minLength: 1, maxLength: 512 }, securityAssessmentRef: { type: "string", minLength: 1, maxLength: 512 }, rightsDecisionRef: { type: "string", minLength: 1, maxLength: 512 }, consentDispositionRef: { type: "string", minLength: 1, maxLength: 512 }, policyEvaluationRef: { type: "string", minLength: 1, maxLength: 512 }, verificationBundleRef: { type: "string", minLength: 1, maxLength: 512 } } },
      "T02:QUARANTINED": { kind: "UNRESOLVED_VERIFICATION_QUARANTINE", rule: "Quarantine when required verification is missing, stale, ambiguous, unsupported, or unverifiable; it does not imply a definitive rejection or artifact availability.", required: ["artifactVersionRef", "verificationBundleRef", "quarantineReason", "unresolvedCheckRefs"], props: { artifactVersionRef: { type: "string", minLength: 1, maxLength: 512 }, verificationBundleRef: { type: "string", minLength: 1, maxLength: 512 }, quarantineReason: { enum: ["MISSING_EVIDENCE", "STALE_EVIDENCE", "AMBIGUOUS_EVIDENCE", "UNSUPPORTED_CHECK", "UNVERIFIABLE_EVIDENCE"] }, unresolvedCheckRefs: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 512 } } } },
      "T02:REJECTED": { kind: "AUTHORITATIVE_VERIFICATION_REJECTION", rule: "Reject only after an exact verification record contains a definitive denial; unknown or incomplete evidence must quarantine instead.", required: ["artifactVersionRef", "rejectionEvidenceRef", "rejectedCheckKind", "decisionAuthorityRef"], props: { artifactVersionRef: { type: "string", minLength: 1, maxLength: 512 }, rejectionEvidenceRef: { type: "string", minLength: 1, maxLength: 512 }, rejectedCheckKind: { enum: ["FORMAT", "INTEGRITY", "SECURITY", "RIGHTS", "CONSENT", "POLICY"] }, decisionAuthorityRef: { type: "string", minLength: 1, maxLength: 512 } } },
      "T03:QUARANTINED": { kind: "CURRENT_POLICY_OR_RETENTION_HOLD", rule: "Quarantine an available artifact only on an exact current policy/retention event bound to its artifact version; preserve access denial/unknown separately.", required: ["artifactVersionRef", "policyEventRef", "policyVersionRef", "disposition"], props: { artifactVersionRef: { type: "string", minLength: 1, maxLength: 512 }, policyEventRef: { type: "string", minLength: 1, maxLength: 512 }, policyVersionRef: { type: "string", minLength: 1, maxLength: 512 }, disposition: { enum: ["RESTRICTED", "UNKNOWN_REQUIRES_QUARANTINE"] } } },
      "T03:EXPIRED": { kind: "CURRENT_RETENTION_EXPIRY", rule: "Expire only under the exact current retention policy and artifact version; independent hold evidence can instead block erasure.", required: ["artifactVersionRef", "expiryPolicyRef", "expiresAt", "expiryEvidenceRef"], props: { artifactVersionRef: { type: "string", minLength: 1, maxLength: 512 }, expiryPolicyRef: { type: "string", minLength: 1, maxLength: 512 }, expiresAt: { type: "string", format: "date-time" }, expiryEvidenceRef: { type: "string", minLength: 1, maxLength: 512 } } },
      "T03:ERASURE_REQUESTED": { kind: "AUTHORIZED_ERASURE_INTENT", rule: "Request erasure only from a durable exact-subject intent with current authority and policy basis; this is not physical deletion.", required: ["artifactVersionRef", "erasureIntentRef", "authorityDecisionRef", "purposeRef"], props: { artifactVersionRef: { type: "string", minLength: 1, maxLength: 512 }, erasureIntentRef: { type: "string", minLength: 1, maxLength: 512 }, authorityDecisionRef: { type: "string", minLength: 1, maxLength: 512 }, purposeRef: { type: "string", minLength: 1, maxLength: 512 } } },
      "T04:AVAILABLE": { kind: "REVIEWED_REINSTATEMENT", rule: "Restore availability only after a current reviewer/authority decision clears the exact quarantine reason for the same artifact version and every applicable verification is positive.", required: ["artifactVersionRef", "reviewDecisionRef", "verificationBundleRef", "clearedQuarantineReasonRef"], props: { artifactVersionRef: { type: "string", minLength: 1, maxLength: 512 }, reviewDecisionRef: { type: "string", minLength: 1, maxLength: 512 }, verificationBundleRef: { type: "string", minLength: 1, maxLength: 512 }, clearedQuarantineReasonRef: { type: "string", minLength: 1, maxLength: 512 } } },
      "T04:REJECTED": { kind: "REVIEWED_DEFINITIVE_REJECTION", rule: "Reject only on a current authorized review/verification denial for the exact version; an unresolved review remains quarantined.", required: ["artifactVersionRef", "reviewDecisionRef", "rejectionEvidenceRef", "decisionAuthorityRef"], props: { artifactVersionRef: { type: "string", minLength: 1, maxLength: 512 }, reviewDecisionRef: { type: "string", minLength: 1, maxLength: 512 }, rejectionEvidenceRef: { type: "string", minLength: 1, maxLength: 512 }, decisionAuthorityRef: { type: "string", minLength: 1, maxLength: 512 } } },
      "T04:ERASURE_REQUESTED": { kind: "AUTHORIZED_ERASURE_INTENT", rule: "A review may request erasure only through a separate durable, authorized erasure intent bound to the exact version.", required: ["artifactVersionRef", "erasureIntentRef", "authorityDecisionRef", "purposeRef"], props: { artifactVersionRef: { type: "string", minLength: 1, maxLength: 512 }, erasureIntentRef: { type: "string", minLength: 1, maxLength: 512 }, authorityDecisionRef: { type: "string", minLength: 1, maxLength: 512 }, purposeRef: { type: "string", minLength: 1, maxLength: 512 } } },
      "T05:PHYSICAL_ERASURE_PENDING": { kind: "ERASURE_WORK_READY_WITHOUT_HOLD", rule: "Begin controlled-copy deletion work only after expiry policy is current, no active hold applies, and the exact copy inventory is bound.", required: ["artifactVersionRef", "expiryPolicyRef", "copyInventoryRef", "holdCheckRef", "holdDisposition"], props: { artifactVersionRef: { type: "string", minLength: 1, maxLength: 512 }, expiryPolicyRef: { type: "string", minLength: 1, maxLength: 512 }, copyInventoryRef: { type: "string", minLength: 1, maxLength: 512 }, holdCheckRef: { type: "string", minLength: 1, maxLength: 512 }, holdDisposition: { const: "ABSENT_CURRENT" } } },
      "T05:BLOCKED_BY_HOLD": { kind: "ACTIVE_HOLD_BLOCK", rule: "Block erasure only on an exact active hold decision for this subject/purpose; missing or stale hold evidence is UNKNOWN, not an active hold.", required: ["artifactVersionRef", "holdRef", "holdDecisionRef", "holdDisposition"], props: { artifactVersionRef: { type: "string", minLength: 1, maxLength: 512 }, holdRef: { type: "string", minLength: 1, maxLength: 512 }, holdDecisionRef: { type: "string", minLength: 1, maxLength: 512 }, holdDisposition: { const: "ACTIVE_CURRENT" } } },
      "T06:ACCESS_REVOKED": { kind: "ERASURE_ACCESS_REVOCATION", rule: "Revoke access only after the exact authorized erasure intent is durable and a current hold check is absent; this is not physical deletion.", required: ["artifactVersionRef", "erasureIntentRef", "accessRevocationReceiptRef", "holdCheckRef", "holdDisposition"], props: { artifactVersionRef: { type: "string", minLength: 1, maxLength: 512 }, erasureIntentRef: { type: "string", minLength: 1, maxLength: 512 }, accessRevocationReceiptRef: { type: "string", minLength: 1, maxLength: 512 }, holdCheckRef: { type: "string", minLength: 1, maxLength: 512 }, holdDisposition: { const: "ABSENT_CURRENT" } } },
      "T06:BLOCKED_BY_HOLD": { kind: "ACTIVE_HOLD_BLOCK", rule: "Block access-revocation-to-erasure progression only on a current exact active hold decision.", required: ["artifactVersionRef", "holdRef", "holdDecisionRef", "holdDisposition"], props: { artifactVersionRef: { type: "string", minLength: 1, maxLength: 512 }, holdRef: { type: "string", minLength: 1, maxLength: 512 }, holdDecisionRef: { type: "string", minLength: 1, maxLength: 512 }, holdDisposition: { const: "ACTIVE_CURRENT" } } },
      "T07:PHYSICAL_ERASURE_PENDING": { kind: "CONTROLLED_COPY_ERASURE_READY", rule: "Proceed only for a complete controlled-copy inventory with current no-hold evidence; external copies remain separate.", required: ["artifactVersionRef", "copyInventoryRef", "holdCheckRef", "holdDisposition", "controlledDeletionPlanRef"], props: { artifactVersionRef: { type: "string", minLength: 1, maxLength: 512 }, copyInventoryRef: { type: "string", minLength: 1, maxLength: 512 }, holdCheckRef: { type: "string", minLength: 1, maxLength: 512 }, holdDisposition: { const: "ABSENT_CURRENT" }, controlledDeletionPlanRef: { type: "string", minLength: 1, maxLength: 512 } } },
      "T07:BLOCKED_BY_HOLD": { kind: "ACTIVE_HOLD_BLOCK", rule: "A current hold blocks controlled-copy erasure; external-copy uncertainty does not itself establish a hold.", required: ["artifactVersionRef", "holdRef", "holdDecisionRef", "holdDisposition"], props: { artifactVersionRef: { type: "string", minLength: 1, maxLength: 512 }, holdRef: { type: "string", minLength: 1, maxLength: 512 }, holdDecisionRef: { type: "string", minLength: 1, maxLength: 512 }, holdDisposition: { const: "ACTIVE_CURRENT" } } },
      "T07:EXTERNAL_ERASURE_UNCONFIRMED": { kind: "EXTERNAL_COPY_BOUNDARY_UNCONFIRMED", rule: "Record the exact external-copy boundary as unconfirmed without claiming deletion or blocking independently proven controlled-copy work.", required: ["artifactVersionRef", "copyInventoryRef", "externalCopyBoundaryRef", "externalDisposition"], props: { artifactVersionRef: { type: "string", minLength: 1, maxLength: 512 }, copyInventoryRef: { type: "string", minLength: 1, maxLength: 512 }, externalCopyBoundaryRef: { type: "string", minLength: 1, maxLength: 512 }, externalDisposition: { const: "UNCONFIRMED" } } },
      "T08:ERASURE_CONFIRMED": { kind: "CONTROLLED_COPY_DELETION_CONFIRMED", rule: "Confirm only when every inventoried controlled copy has exact deletion evidence; external copies must be separately none or confirmed and cannot be silently omitted.", required: ["artifactVersionRef", "copyInventoryRef", "deletionEvidenceRefs", "externalCopyDisposition"], props: { artifactVersionRef: { type: "string", minLength: 1, maxLength: 512 }, copyInventoryRef: { type: "string", minLength: 1, maxLength: 512 }, deletionEvidenceRefs: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 512 } }, externalCopyDisposition: { enum: ["NONE_IN_SCOPE", "CONFIRMED_DELETED"] } } },
      "T08:BLOCKED_BY_HOLD": { kind: "ACTIVE_HOLD_BLOCK", rule: "A current hold blocks deletion confirmation; preserve pending evidence and do not claim erasure complete.", required: ["artifactVersionRef", "holdRef", "holdDecisionRef", "holdDisposition"], props: { artifactVersionRef: { type: "string", minLength: 1, maxLength: 512 }, holdRef: { type: "string", minLength: 1, maxLength: 512 }, holdDecisionRef: { type: "string", minLength: 1, maxLength: 512 }, holdDisposition: { const: "ACTIVE_CURRENT" } } },
      "T08:EXTERNAL_ERASURE_UNCONFIRMED": { kind: "EXTERNAL_COPY_BOUNDARY_UNCONFIRMED", rule: "Keep external erasure unconfirmed when a scoped provider boundary lacks authoritative deletion evidence.", required: ["artifactVersionRef", "copyInventoryRef", "externalCopyBoundaryRef", "externalDisposition"], props: { artifactVersionRef: { type: "string", minLength: 1, maxLength: 512 }, copyInventoryRef: { type: "string", minLength: 1, maxLength: 512 }, externalCopyBoundaryRef: { type: "string", minLength: 1, maxLength: 512 }, externalDisposition: { const: "UNCONFIRMED" } } },
      "T09:PHYSICAL_ERASURE_PENDING": { kind: "HOLD_RELEASED_ERASURE_RESUMPTION", rule: "Resume only after exact hold-release/boundary evidence, a current no-hold check, and the same copy inventory; do not reset erasure progress.", required: ["artifactVersionRef", "copyInventoryRef", "holdReleaseEvidenceRef", "holdCheckRef", "holdDisposition"], props: { artifactVersionRef: { type: "string", minLength: 1, maxLength: 512 }, copyInventoryRef: { type: "string", minLength: 1, maxLength: 512 }, holdReleaseEvidenceRef: { type: "string", minLength: 1, maxLength: 512 }, holdCheckRef: { type: "string", minLength: 1, maxLength: 512 }, holdDisposition: { const: "ABSENT_CURRENT" } } },
      "T09:EXTERNAL_ERASURE_UNCONFIRMED": { kind: "HOLD_RELEASED_EXTERNAL_BOUNDARY", rule: "A released hold does not prove external deletion; retain the exact external boundary as unconfirmed until provider evidence exists.", required: ["artifactVersionRef", "externalCopyBoundaryRef", "holdReleaseEvidenceRef", "externalDisposition"], props: { artifactVersionRef: { type: "string", minLength: 1, maxLength: 512 }, externalCopyBoundaryRef: { type: "string", minLength: 1, maxLength: 512 }, holdReleaseEvidenceRef: { type: "string", minLength: 1, maxLength: 512 }, externalDisposition: { const: "UNCONFIRMED" } } },
    };
    const spec = specs[`${transition.id.split("/").at(-1)}:${edge.to}`];
    if (!spec) throw new Error(`Missing exact artifact lifecycle causal trigger spec: ${artifactEdgeKey}`);
    const hasVersion = !transition.id.endsWith("/T01");
    const receiptSchema = ownerReceiptSchema({ sourceRef: `${guardRef}/edgeRules/${edgeIndex}`, subjectField: "uploadSessionId", subjectVersionField: "sessionRevisionRef", sourceStateField: "sourceStateRef", targetStateField: "targetStateRef", sourceStateRef: edgeFromStateRef, targetStateRef: edgeToStateRef, requestFingerprintField: null, fields: spec.props, required: spec.required });
    const baseRequired = [...new Set(["uploadSessionId", "sessionRevisionRef", "sourceStateRef", "targetStateRef", "occurredAt", "ownerReceipt", ...(hasVersion ? ["artifactVersionRef"] : []), ...spec.required])];
    const baseProperties = {
      tenantId: { type: "string", minLength: 1, maxLength: 256 },
      uploadSessionId: { type: "string", minLength: 1, maxLength: 256 },
      sessionRevisionRef: { type: "string", minLength: 1, maxLength: 512 },
      ...(hasVersion ? { artifactVersionRef: { type: "string", minLength: 1, maxLength: 512 } } : {}),
      sourceStateRef: { const: edgeFromStateRef },
      targetStateRef: { const: edgeToStateRef },
      occurredAt: { type: "string", format: "date-time" },
      ...spec.props,
    };
    if (!baseRequired.includes("tenantId")) baseRequired.unshift("tenantId");
    return {
      id: `media.transition-trigger-definition.${transition.id.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}.${edge.to.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}.v1`,
      triggerKind: spec.kind,
      triggerRule: spec.rule,
      sourceRefs: [`${p1}/transitions.yaml#transitionRecords/@id=${transition.id}`, `${p1}/states.yaml#stateMachines/@machineId=media-upload-and-artifact/stateDefinitions/@id=${edge.from}`, edgeToStateRef, `${p1}/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.artifact.lifecycle.observe.v1`, `${p1}/domain-objects.yaml#objects/@id=media.domain.upload-session`, `${p1}/domain-objects.yaml#objects/@id=media.domain.artifact-version`, guardRef],
      domainObjectRefs: ["media.domain.upload-session", ...(hasVersion ? ["media.domain.artifact-version"] : [])],
      requiredEvidence: baseRequired,
      inputSchema: { type: "object", additionalProperties: false, required: baseRequired, properties: { ...baseProperties, ownerReceipt: receiptSchema } },
      receiptSchema,
      trustedContext: ["tenantId", "principalId", "expectedUploadSessionId", "expectedSessionRevisionRef", ...(hasVersion ? ["expectedArtifactVersionRef"] : []), "expectedSourceStateRef", "expectedTargetStateRef", "expectedReceiptSourceRef", "expectedReadAuthorityRef", "expectedReadVersion", "currentnessClock"],
      receiptSemantics: `${guardRef}/edgeRules/${edgeIndex}`,
      acceptedReceiptDispositions: spec.props.disposition?.const !== undefined ? [spec.props.disposition.const] : spec.props.disposition?.enum ?? ["VERIFIED"],
      effect: `Definition-level eligibility for exact ${edge.from}-to-${edge.to}; this transition does not assert runtime execution or external erasure confirmation beyond the typed evidence disposition.`,
      runtimeAdmission: "NOT_ADMITTED",
      acceptanceEffect: "none",
    };
  }
  const jobAttemptTransitions = new Set([
    "media-job/T01", "media-job/T02", "media-job/T03", "media-job/T04", "media-job/T05",
    "media-attempt/T01", "media-attempt/T02", "media-attempt/T03", "media-attempt/T04", "media-attempt/T05",
  ]);
  if (jobAttemptTransitions.has(transition.id)) {
    const receiptByTarget = {
      DISPATCH_INTENT_RECORDED: { fields: { dispatchIntentRef: { type: "string", minLength: 1, maxLength: 512 }, stableIdempotencyRef: { type: "string", minLength: 1, maxLength: 512 } }, required: ["dispatchIntentRef", "stableIdempotencyRef"], ref: `${p1}/operations.yaml#ownerAttemptLeaseLifecycle` },
      DISPATCHED: { fields: { dispatchReceiptRef: { type: "string", minLength: 1, maxLength: 512 } }, required: ["dispatchReceiptRef"], ref: `${p1}/operations.yaml#ownerAttemptLeaseLifecycle` },
      RUNNING: { fields: { workerStartReceiptRef: { type: "string", minLength: 1, maxLength: 512 }, stageAttemptRef: { type: "string", minLength: 1, maxLength: 512 } }, required: ["workerStartReceiptRef", "stageAttemptRef"], ref: `${p1}/operations.yaml#ownerAttemptLeaseLifecycle` },
      CANCEL_REQUESTED: { fields: { cancelRequestRef: { type: "string", minLength: 1, maxLength: 512 } }, required: ["cancelRequestRef"], ref: `${p1}/operations.yaml#ownerAttemptLeaseLifecycle` },
      CANCEL_CONFIRMED: { fields: { fencedStopReceiptRef: { type: "string", minLength: 1, maxLength: 512 } }, required: ["fencedStopReceiptRef"], ref: `${p1}/operations.yaml#ownerAttemptLeaseLifecycle` },
      SUCCEEDED: { fields: { providerOutcomeReceiptRef: { type: "string", minLength: 1, maxLength: 512 }, outputVersionRefs: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 512 } } }, required: ["providerOutcomeReceiptRef", "outputVersionRefs"], ref: `${p1}/operations.yaml#ownerCompletionQualificationRule` },
      FAILED: { fields: { failureEvidenceRef: { type: "string", minLength: 1, maxLength: 512 }, effectFinality: { const: "DEFINITIVE_FAILURE" } }, required: ["failureEvidenceRef", "effectFinality"], ref: `${p1}/operations.yaml#ownerAttemptLeaseLifecycle` },
      OUTCOME_UNKNOWN: { fields: { uncertaintyEvidenceRef: { type: "string", minLength: 1, maxLength: 512 }, uncertaintyDisposition: { enum: ["MAY_HAVE_CROSSED_EFFECT_BOUNDARY", "CONTRADICTORY_OR_UNAVAILABLE_EVIDENCE"] } }, required: ["uncertaintyEvidenceRef", "uncertaintyDisposition"], ref: `${p1}/operations.yaml#ownerAttemptLeaseLifecycle` },
      SUPERSEDED: { fields: { supersedingAttemptRef: { type: "string", minLength: 1, maxLength: 512 }, supersedingFenceRef: { type: "string", minLength: 1, maxLength: 512 } }, required: ["supersedingAttemptRef", "supersedingFenceRef"], ref: `${p1}/operations.yaml#ownerAttemptLeaseLifecycle` },
      RETRY_PENDING: { fields: { retryPolicyObservationRef: { type: "string", minLength: 1, maxLength: 512 }, remainingRetryBudget: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } }, required: ["retryPolicyObservationRef", "remainingRetryBudget"], ref: `${p1}/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.retry-policy-current-read.v1` },
      RECONCILING: { fields: { reconciliationQueryRef: { type: "string", minLength: 1, maxLength: 512 }, reconciliationRequestFingerprint: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" } }, required: ["reconciliationQueryRef", "reconciliationRequestFingerprint"], ref: `${p1}/operations.yaml#ownerAttemptLeaseLifecycle` },
      COMPLETED: { fields: { completionQualificationRef: { type: "string", minLength: 1, maxLength: 512 }, outputVersionRefs: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 512 } } }, required: ["completionQualificationRef", "outputVersionRefs"], ref: `${p1}/operations.yaml#ownerCompletionQualificationRule` },
      PARTIALLY_SUCCEEDED: { fields: { partialQualificationRef: { type: "string", minLength: 1, maxLength: 512 }, outputFinalityRefs: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 512 } } }, required: ["partialQualificationRef", "outputFinalityRefs"], ref: `${p1}/operations.yaml#ownerCompletionQualificationRule` },
      CANCELLED: { fields: { cancellationFinalityRef: { type: "string", minLength: 1, maxLength: 512 }, confirmedStoppedAttemptRefs: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 512 } } }, required: ["cancellationFinalityRef", "confirmedStoppedAttemptRefs"], ref: `${p1}/operations.yaml#ownerAttemptLeaseLifecycle` },
    };
    let receipt = receiptByTarget[edge.to];
    if (!receipt) throw new Error(`No exact job/attempt causal receipt defined for ${transition.id} -> ${edge.to}`);
    const jobPreDispatch = transition.id === "media-job/T01" && ["CANCELLED", "FAILED"].includes(edge.to);
    const retryNotClaimed = transition.id === "media-job/T03" && ["CANCELLED", "FAILED", "OUTCOME_UNKNOWN"].includes(edge.to);
    const reconciliationNoCurrentLease = ["media-job/T04", "media-job/T05"].includes(transition.id);
    const requiresCurrentFence = transition.id.startsWith("media-attempt/") || transition.id === "media-job/T02" || (transition.id === "media-job/T03" && edge.to === "RUNNING") || (transition.id === "media-job/T01" && edge.to === "RUNNING");
    if (jobPreDispatch) {
      receipt = edge.to === "CANCELLED"
        ? { fields: { cancellationRequestRef: { type: "string", minLength: 1, maxLength: 512 }, noDispatchEvidenceRef: { type: "string", minLength: 1, maxLength: 512 }, activeAttemptDisposition: { const: "NO_ACTIVE_ATTEMPT" } }, required: ["cancellationRequestRef", "noDispatchEvidenceRef", "activeAttemptDisposition"], ref: `${p1}/operations.yaml#ownerAttemptLeaseLifecycle` }
        : { fields: { failureEvidenceRef: { type: "string", minLength: 1, maxLength: 512 }, effectFinality: { const: "DEFINITIVE_PRE_DISPATCH_FAILURE" }, noDispatchEvidenceRef: { type: "string", minLength: 1, maxLength: 512 } }, required: ["failureEvidenceRef", "effectFinality", "noDispatchEvidenceRef"], ref: `${p1}/operations.yaml#ownerAttemptLeaseLifecycle` };
    }
    if (retryNotClaimed) {
      receipt = edge.to === "CANCELLED"
        ? { fields: { cancellationRequestRef: { type: "string", minLength: 1, maxLength: 512 }, retryPlanRef: { type: "string", minLength: 1, maxLength: 512 }, activeAttemptDisposition: { const: "NO_NEW_ATTEMPT_CLAIMED" } }, required: ["cancellationRequestRef", "retryPlanRef", "activeAttemptDisposition"], ref: `${p1}/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.retry-policy-current-read.v1` }
        : edge.to === "FAILED"
          ? { fields: { failureEvidenceRef: { type: "string", minLength: 1, maxLength: 512 }, effectFinality: { const: "DEFINITIVE_PRE_DISPATCH_FAILURE" }, retryPlanRef: { type: "string", minLength: 1, maxLength: 512 } }, required: ["failureEvidenceRef", "effectFinality", "retryPlanRef"], ref: `${p1}/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.retry-policy-current-read.v1` }
          : { fields: { uncertaintyEvidenceRef: { type: "string", minLength: 1, maxLength: 512 }, priorAttemptRef: { type: "string", minLength: 1, maxLength: 512 }, uncertaintyDisposition: { enum: ["PRIOR_EFFECT_UNRESOLVED", "RETRY_REQUEST_OUTCOME_UNKNOWN"] } }, required: ["uncertaintyEvidenceRef", "priorAttemptRef", "uncertaintyDisposition"], ref: `${p1}/operations.yaml#ownerAttemptLeaseLifecycle` };
    }
    const attemptRunningRef = sourceStateRef("media-attempt", null, "RUNNING");
    const attemptStateRefs = (machineById.get("media-attempt")?.stateDefinitions ?? []).map((state) => sourceStateRef("media-attempt", null, state.id));
    const baseProperties = {
      tenantId: { type: "string", minLength: 1, maxLength: 256 },
      jobId: { type: "string", minLength: 1, maxLength: 256 },
      jobRevisionRef: { type: "string", minLength: 1, maxLength: 512 },
      requestFingerprint: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
      sourceStateRef: { const: edgeFromStateRef },
      targetStateRef: { const: edgeToStateRef },
      occurredAt: { type: "string", format: "date-time" },
      leaseEvidenceDisposition: { const: requiresCurrentFence ? "CURRENT_FENCED_ATTEMPT_REQUIRED" : jobPreDispatch ? "NOT_YET_ISSUED_OR_NO_ACTIVE_ATTEMPT" : retryNotClaimed ? "NO_NEW_ATTEMPT_CLAIMED" : reconciliationNoCurrentLease ? "CURRENT_WORKER_LEASE_NOT_REQUIRED_FOR_RECONCILIATION" : "NOT_APPLICABLE" },
      ...(requiresCurrentFence ? {
        attemptId: { type: "string", minLength: 1, maxLength: 256 },
        attemptRecordRef: { type: "string", minLength: 1, maxLength: 512 },
        attemptStateRef: transition.id.startsWith("media-attempt/") ? { const: edgeToStateRef } : { enum: attemptStateRefs },
        workerId: { type: "string", minLength: 1, maxLength: 256 },
        leaseRef: { type: "string", minLength: 1, maxLength: 512 },
        leaseRevisionRef: { type: "string", minLength: 1, maxLength: 512 },
        fencingToken: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        leaseExpiresAt: { type: "string", format: "date-time" },
      } : {}),
      ...receipt.fields,
    };
    const receiptFields = {
      ...receipt.fields,
      ...(requiresCurrentFence ? {
        attemptRef: { type: "string", minLength: 1, maxLength: 256 },
        leaseRef: { type: "string", minLength: 1, maxLength: 512 },
        leaseRevisionRef: { type: "string", minLength: 1, maxLength: 512 },
        fencingToken: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      } : {}),
    };
    const receiptRequired = [...receipt.required, ...(requiresCurrentFence ? ["attemptRef", "leaseRef", "leaseRevisionRef", "fencingToken"] : [])];
    const receiptSchema = ownerReceiptSchema({ sourceRef: receipt.ref, subjectField: "jobId", subjectVersionField: "jobRevisionRef", sourceStateField: "sourceStateRef", targetStateField: "targetStateRef", sourceStateRef: edgeFromStateRef, targetStateRef: edgeToStateRef, requestFingerprintField: "requestFingerprint", fields: receiptFields, required: receiptRequired });
    const required = ["tenantId", "jobId", "jobRevisionRef", "requestFingerprint", "sourceStateRef", "targetStateRef", "occurredAt", "leaseEvidenceDisposition", "ownerReceipt", ...(requiresCurrentFence ? ["attemptId", "attemptRecordRef", "attemptStateRef", "workerId", "leaseRef", "leaseRevisionRef", "fencingToken", "leaseExpiresAt"] : []), ...receipt.required];
    return {
      id: `media.transition-trigger-definition.${transition.id.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}.${edge.to.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}.v1`,
      triggerKind: `TYPED_FENCED_JOB_ATTEMPT_${edge.to}`,
      triggerRule: `The ${transition.id} edge to ${edge.to} requires the exact job/attempt/lease tuple, current unexpired fencing lease, exact source and target state refs, and the state-specific owner receipt fields. The target state is derived from these conditions and evidence; a supplied supported boolean cannot trigger the edge.`,
      sourceRefs: [receipt.ref, `${p1}/operations.yaml#ownerAttemptLeaseLifecycle`, edgeToStateRef, `${p1}/domain-objects.yaml#objects/@id=media.domain.processing-job`, `${p1}/domain-objects.yaml#objects/@id=media.domain.job-attempt`, `${p1}/domain-objects.yaml#objects/@id=media.domain.job-lease`, guardRef],
      domainObjectRefs: ["media.domain.processing-job", "media.domain.job-attempt", "media.domain.job-lease"],
      sourceStateRef: edgeFromStateRef,
      targetStateRef: edgeToStateRef,
      requiredEvidence: required,
      inputSchema: { type: "object", additionalProperties: false, required, properties: { ...baseProperties, ownerReceipt: receiptSchema } },
      receiptSchema,
      trustedContext: ["tenantId", "principalId", "expectedJobId", "expectedJobRevisionRef", "expectedRequestFingerprint", "expectedSourceStateRef", "expectedTargetStateRef", "expectedReceiptSourceRef", "expectedReadAuthorityRef", "expectedReadVersion", "now", ...(requiresCurrentFence ? ["expectedAttemptId", "expectedWorkerId", "expectedLeaseRef", "expectedLeaseRevisionRef", "expectedFencingToken"] : [])],
      trustedTupleRule: "All job, attempt, worker, lease, fence, request, and source-state values equal the host/current owner tuple; tenant/principal come from trusted context, not the body. Lease expiry must be strictly later than trusted now.",
      receiptSemantics: receipt.ref,
      effect: `Definition-level eligibility for exact ${edge.from}-to-${edge.to}; independent read is required to establish that the job or attempt state was persisted.`,
      runtimeAdmission: "NOT_ADMITTED",
      acceptanceEffect: "none",
    };
  }
  return null;
}

const allTransitions = [
  ...(transitions.transitionRecords ?? []),
  ...(transitions.ownerDefinedTransitionRecords ?? []),
];
const records = allTransitions.map((transition) => {
  const guard = guardByTransition.get(transition.id);
  if (!guard) throw new Error(`Missing guard for ${transition.id}`);
  const transitionRef = `${p1}/transitions.yaml#${transition.id.includes("rightsAssertion/") || transition.id.includes("consent/") ? "ownerDefinedTransitionRecords" : "transitionRecords"}/@id=${transition.id}`;
  const guardRef = `${p1}/transition-guard-contracts.yaml#records/@id=${guard.id}`;
  const sourceActions = exactTransitionActions.get(transition.id) ?? [];
  const operationRefs = transition.operationRefs ?? [];
  const actionBindingStatus = sourceActions.length
    ? "EXACT_ACTION_OPERATION_TRANSITION_REF"
    : String(transition.eventTriggers ?? "").includes("authority-source-event-required")
      ? "AUTHORITY_EVENT_NO_MEDIA_PUBLIC_OPERATION"
      : operationRefs.some((ref) => ref === "media.operation.job-lifecycle")
        ? "OPERATION_FAMILY_PROPOSAL_ONLY_NO_EXACT_ACTION"
        : operationRefs.length
          ? "OPERATION_REF_PRESENT_BUT_NO_ACTION_TRANSITION_REF"
          : "NO_PUBLIC_OPERATION_REF_IN_P1_TRANSITION";
  const dimension = transition.stateDimension ?? guard.stateDimension ?? null;
  const edges = guard.edgeRules.map((edge, index) => {
    const exactActions = sourceActions.filter((action) => operationRefs.includes(action.operationRef));
    const trigger = classifyEdge({ transition, edge, exactActions, guardRef, edgeIndex: index });
    const facts = trigger.leaves;
    const edgeFromStateRef = sourceStateRef(transition.sourceMachineId, dimension, edge.from);
    const edgeToStateRef = sourceStateRef(transition.sourceMachineId, dimension, edge.to);
    const machine = machineById.get(transition.sourceMachineId);
    const machineStates = (machine?.stateDefinitions ?? []).map((state) => sourceStateRef(transition.sourceMachineId, dimension, state.id));
    const stateDefinitions = machine?.stateDefinitionsByDimension?.[dimension] ?? [];
    machineStates.push(...stateDefinitions.map((state) => sourceStateRef(transition.sourceMachineId, dimension, state.id)));
    const factDefinitions = facts.map((fact) => fact.fact.startsWith("outcome.")
      ? { ...fact, valueKind: "EXACT_TARGET_STATE_OBSERVATION", targetStateRef: edgeToStateRef, validStateRefs: [...new Set(machineStates)] }
      : { ...fact, valueKind: "SOURCE_GUARD_FACT_REQUIRES_TYPED_EVIDENCE", sourceGuardFactRef: fact.sourceRef });
    const causalDefinition = causalTriggerDefinition({ transition, edge, edgeToStateRef, edgeFromStateRef, guardRef, edgeIndex: index });
    return {
      id: `media.transition-trigger-edge.${transition.id.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}.${String(index + 1).padStart(2, "0")}.v1`,
      edgeRuleRef: `${guardRef}/edgeRules/${index}`,
      fromStateRef: edgeFromStateRef,
      toStateRef: edgeToStateRef,
      triggerKind: trigger.triggerKind,
      producerRoleRef: "media.event.producer.media-domain-state-owner.v1",
      triggerGuardFacts: factDefinitions,
      guardExpression: trigger.guardExpression,
      causalTriggerDefinition: causalDefinition,
      exactActionBindings: trigger.exactActionBinding,
      trustedContextBindings: {
        tenantId: "HOST_ATTESTED_TRUSTED_CONTEXT",
        principalId: "HOST_ATTESTED_TRUSTED_CONTEXT",
        expectedAggregateRef: "HOST_SELECTED_EXACT_SUBJECT",
        expectedAggregateVersion: "HOST_OR_OWNER_READ_CURRENT_VERSION; MUST_MATCH_EVENT",
        expectedProducerRef: "MEDIA_DOMAIN_OWNER_REGISTRY",
        currentness: "TRUSTED_HOST_EXPECTED_VERSION_AND_CLOCK; BODY_CANNOT_DECLARE_CURRENT",
      },
      eventPayloadSchemaRef: `#ownerDefinedTransitionTriggerSemantics/records/@id=media.transition-trigger-semantics.${transition.id.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}.v1/triggerCases/@id=media.transition-trigger-edge.${transition.id.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}.${String(index + 1).padStart(2, "0")}.v1/eventPayloadSchema`,
      eventPayloadSchema: {
        type: "object",
        additionalProperties: false,
        required: ["eventId", "producerRef", "transitionRef", "edgeRuleRef", "aggregateRef", "aggregateVersionRef", "fromStateRef", "toStateRef", "decision", "occurredAt", "guardFactResults"],
        properties: {
          eventId: { type: "string", minLength: 1, maxLength: 255 },
          producerRef: { const: "media.event.producer.media-domain-state-owner.v1" },
          transitionRef: { const: `${transitionRef}` },
          edgeRuleRef: { const: `${guardRef}/edgeRules/${index}` },
          aggregateRef: { type: "string", minLength: 1, maxLength: 384 },
          aggregateVersionRef: { type: "string", minLength: 1, maxLength: 384 },
          fromStateRef: { const: edgeFromStateRef },
          toStateRef: { const: edgeToStateRef },
          decision: { enum: ["APPLIED", "DENIED", "UNKNOWN"] },
          occurredAt: { type: "string", format: "date-time" },
          guardFactResults: {
            type: "array",
            minItems: facts.length,
            maxItems: facts.length,
            uniqueItems: true,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["factRef", "verdict", "evidenceRefs", "subjectRef", "subjectVersionRef", "authorityRef", "readVersion", "observedAt"],
              properties: {
                factRef: { enum: facts.map(({ sourceRef }) => sourceRef) },
                verdict: { enum: ["SATISFIED", "DENIED", "UNKNOWN"] },
                observationDisposition: { enum: ["OBSERVED", "UNKNOWN"] },
                observedStateRef: { type: "string", minLength: 1, maxLength: 512 },
                observationReason: { type: "string", minLength: 1, maxLength: 384 },
                evidenceRefs: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 384 } },
                subjectRef: { type: "string", minLength: 1, maxLength: 384 },
                subjectVersionRef: { type: "string", minLength: 1, maxLength: 384 },
                authorityRef: { type: "string", minLength: 1, maxLength: 384 },
                readVersion: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
                observedAt: { type: "string", format: "date-time" },
              },
              ...(factDefinitions.some((fact) => fact.valueKind === "EXACT_TARGET_STATE_OBSERVATION") ? { allOf: factDefinitions.filter((fact) => fact.valueKind === "EXACT_TARGET_STATE_OBSERVATION").map((fact) => ({
                if: { properties: { factRef: { const: fact.sourceRef } }, required: ["factRef"] },
                then: {
                  oneOf: [
                    { properties: { observationDisposition: { const: "OBSERVED" }, observedStateRef: { enum: fact.validStateRefs } }, required: ["observationDisposition", "observedStateRef"] },
                    { properties: { observationDisposition: { const: "UNKNOWN" }, observationReason: { type: "string", minLength: 1 } }, required: ["observationDisposition", "observationReason"], not: { required: ["observedStateRef"] } },
                  ],
                },
              })) } : {}),
            },
          },
        },
      },
      effectBoundary: "The owner-defined decision is limited to this guarded state edge and exact subject/version; it does not prove a deployed producer, persisted state, or runtime delivery.",
      missingOrContradictoryEvidence: "UNKNOWN; preserve prior state and reconcile the same identity; never synthesize a successful transition.",
      runtimeAdmission: "NOT_ADMITTED",
    };
  });
  return {
    id: `media.transition-trigger-semantics.${transition.id.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}.v1`,
    transitionRef,
    guardContractRef: guardRef,
    sourceMachineId: transition.sourceMachineId,
    stateDimension: dimension,
    sourceGuard: guard.sourceGuard,
    historicalEventTriggers: transition.eventTriggers ?? null,
    historicalOperationBinding: transition.operationBinding ?? null,
    sourceOperationRefs: operationRefs,
    actionBindingStatus,
    exactSourceActionRefs: sourceActions,
    triggerCases: edges,
    sourceStatus: "PARTIAL_MEDIA_OWNER_LOGICAL_DEFINITION; non-outcome guard fact value contracts and causal producer bindings remain open; runtime admission NOT_ADMITTED",
    runtimeAdmission: "NOT_ADMITTED",
    acceptanceEffect: "none",
  };
});

const factValueModelByExactName = new Map([["activeEffectsResolvedOrUnknown",{"kind":"BOUNDED_CHECK_OBSERVATION","property":"checkDisposition","enum":["PASS","FAIL","UNKNOWN"],"positive":"PASS"}],["affectedWorkReconciled",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["approvalDurable",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["assignedReviewerOrAuthority",{"kind":"SOURCE_SPECIFIC_EVIDENCE_DISPOSITION","property":"evidenceDisposition","enum":["PRESENT","ABSENT","UNKNOWN"],"positive":"PRESENT"}],["atomicCommitAvailable",{"kind":"BOUNDED_CHECK_OBSERVATION","property":"checkDisposition","enum":["PASS","FAIL","UNKNOWN"],"positive":"PASS"}],["attemptOutcomeRecorded",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["authorityCurrent",{"kind":"AUTHORITY_DECISION","property":"authorizationDisposition","enum":["GRANTED","DENIED","UNKNOWN"],"positive":"GRANTED"}],["authorityRecordedConsentDecision",{"kind":"AUTHORITY_DECISION","property":"authorizationDisposition","enum":["GRANTED","DENIED","UNKNOWN"],"positive":"GRANTED"}],["cancellationRaceEvidenceRecorded",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["consent.activationVerified",{"kind":"SOURCE_SPECIFIC_EVIDENCE_DISPOSITION","property":"evidenceDisposition","enum":["PRESENT","ABSENT","UNKNOWN"],"positive":"PRESENT"}],["consent.expiryRecorded",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["consent.replacementRecorded",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["consent.revocationRecorded",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["consentPerEffectCurrent",{"kind":"CURRENT_SCOPED_OBSERVATION","property":"currentness","enum":["CURRENT","NOT_CURRENT","UNKNOWN"],"positive":"CURRENT"}],["consentScopeCurrent",{"kind":"CURRENT_SCOPED_OBSERVATION","property":"currentness","enum":["CURRENT","NOT_CURRENT","UNKNOWN"],"positive":"CURRENT"}],["copyInventoryComplete",{"kind":"BOUNDED_CHECK_OBSERVATION","property":"checkDisposition","enum":["PASS","FAIL","UNKNOWN"],"positive":"PASS"}],["currentHeadRecorded",{"kind":"CURRENT_SCOPED_OBSERVATION","property":"currentness","enum":["CURRENT","NOT_CURRENT","UNKNOWN"],"positive":"CURRENT"}],["degradationPolicyDeclared",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["delegationCurrent",{"kind":"AUTHORITY_DECISION","property":"authorizationDisposition","enum":["GRANTED","DENIED","UNKNOWN"],"positive":"GRANTED"}],["deletionEvidenceRecorded",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["deliveryIntentAuthorized",{"kind":"AUTHORITY_DECISION","property":"authorizationDisposition","enum":["GRANTED","DENIED","UNKNOWN"],"positive":"GRANTED"}],["destinationCurrent",{"kind":"CURRENT_SCOPED_OBSERVATION","property":"currentness","enum":["CURRENT","NOT_CURRENT","UNKNOWN"],"positive":"CURRENT"}],["destinationEffectsAccounted",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["destinationEvidenceRecorded",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["destinationPolicyPass",{"kind":"BOUNDED_CHECK_OBSERVATION","property":"checkDisposition","enum":["PASS","FAIL","UNKNOWN"],"positive":"PASS"}],["destinationQueryOrReconciliationStarted",{"kind":"SOURCE_SPECIFIC_EVIDENCE_DISPOSITION","property":"evidenceDisposition","enum":["PRESENT","ABSENT","UNKNOWN"],"positive":"PRESENT"}],["dispatchIntentDurable",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["dispatchMayHaveCrossed",{"kind":"SOURCE_SPECIFIC_EVIDENCE_DISPOSITION","property":"evidenceDisposition","enum":["PRESENT","ABSENT","UNKNOWN"],"positive":"PRESENT"}],["erasure.allControlledCopiesConfirmed",{"kind":"SOURCE_SPECIFIC_EVIDENCE_DISPOSITION","property":"evidenceDisposition","enum":["PRESENT","ABSENT","UNKNOWN"],"positive":"PRESENT"}],["erasure.externalCopyUnconfirmed",{"kind":"SOURCE_SPECIFIC_EVIDENCE_DISPOSITION","property":"evidenceDisposition","enum":["PRESENT","ABSENT","UNKNOWN"],"positive":"PRESENT"}],["erasureIntentDurable",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["exactOutputVersionCurrent",{"kind":"CURRENT_SCOPED_OBSERVATION","property":"currentness","enum":["CURRENT","NOT_CURRENT","UNKNOWN"],"positive":"CURRENT"}],["exactVersionCurrent",{"kind":"CURRENT_SCOPED_OBSERVATION","property":"currentness","enum":["CURRENT","NOT_CURRENT","UNKNOWN"],"positive":"CURRENT"}],["expectedVersionConflicts",{"kind":"SOURCE_SPECIFIC_EVIDENCE_DISPOSITION","property":"evidenceDisposition","enum":["PRESENT","ABSENT","UNKNOWN"],"positive":"PRESENT"}],["expectedVersionMatches",{"kind":"CURRENT_SCOPED_OBSERVATION","property":"currentness","enum":["CURRENT","NOT_CURRENT","UNKNOWN"],"positive":"CURRENT"}],["expiryPolicyCurrent",{"kind":"CURRENT_SCOPED_OBSERVATION","property":"currentness","enum":["CURRENT","NOT_CURRENT","UNKNOWN"],"positive":"CURRENT"}],["explicitAbandonOrExpiryRecorded",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["fenceCurrent",{"kind":"CURRENT_SCOPED_OBSERVATION","property":"currentness","enum":["CURRENT","NOT_CURRENT","UNKNOWN"],"positive":"CURRENT"}],["formatDispositionRecorded",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["hold.absent",{"kind":"SOURCE_SPECIFIC_EVIDENCE_DISPOSITION","property":"evidenceDisposition","enum":["PRESENT","ABSENT","UNKNOWN"],"positive":"PRESENT"}],["hold.active",{"kind":"SOURCE_SPECIFIC_EVIDENCE_DISPOSITION","property":"evidenceDisposition","enum":["PRESENT","ABSENT","UNKNOWN"],"positive":"PRESENT"}],["holdReleaseOrBoundaryEvidence",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["idempotencyIdentityRecorded",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["identityCurrent",{"kind":"CURRENT_SCOPED_OBSERVATION","property":"currentness","enum":["CURRENT","NOT_CURRENT","UNKNOWN"],"positive":"CURRENT"}],["immutableVersionSelected",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["integrityDispositionRecorded",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["inviteeAccepted",{"kind":"AUTHORITY_DECISION","property":"authorizationDisposition","enum":["GRANTED","DENIED","UNKNOWN"],"positive":"GRANTED"}],["inviterAuthorized",{"kind":"AUTHORITY_DECISION","property":"authorizationDisposition","enum":["GRANTED","DENIED","UNKNOWN"],"positive":"GRANTED"}],["leaseCurrent",{"kind":"CURRENT_SCOPED_OBSERVATION","property":"currentness","enum":["CURRENT","NOT_CURRENT","UNKNOWN"],"positive":"CURRENT"}],["leaseSequenceCurrent",{"kind":"CURRENT_SCOPED_OBSERVATION","property":"currentness","enum":["CURRENT","NOT_CURRENT","UNKNOWN"],"positive":"CURRENT"}],["measurementOrAbstentionRecorded",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["measurementProtocolVersionBound",{"kind":"SOURCE_SPECIFIC_EVIDENCE_DISPOSITION","property":"evidenceDisposition","enum":["PRESENT","ABSENT","UNKNOWN"],"positive":"PRESENT"}],["metricApplicabilityDeclared",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["newEvidenceOrRevocationOrExpiryRecorded",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["newHeadCommitted",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["newReviewRequestRecorded",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["newWorkFenced",{"kind":"BOUNDED_CHECK_OBSERVATION","property":"checkDisposition","enum":["PASS","FAIL","UNKNOWN"],"positive":"PASS"}],["noPartialCommit",{"kind":"SOURCE_SPECIFIC_EVIDENCE_DISPOSITION","property":"evidenceDisposition","enum":["PRESENT","ABSENT","UNKNOWN"],"positive":"PRESENT"}],["outcome.media.attempt.cancel.confirmed.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.attempt.cancel.requested.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.attempt.dispatch.intent.recorded.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.attempt.dispatched.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.attempt.failed.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.attempt.outcome.unknown.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.attempt.running.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.attempt.succeeded.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.attempt.superseded.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.delivery.acknowledged.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.delivery.failed.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.delivery.outcome.unknown.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.delivery.partially.delivered.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.delivery.preparing.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.delivery.ready.for.authorized.delivery.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.delivery.reconciling.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.delivery.revoked.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.delivery.submitted.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.job.cancelled.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.job.completed.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.job.failed.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.job.outcome.unknown.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.job.partially.succeeded.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.job.reconciling.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.job.retry.pending.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.job.running.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.project.membership.expired.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.project.membership.revoked.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.project.membership.suspended.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.quality.disposition.abstained.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.quality.disposition.assessing.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.quality.disposition.fail.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.quality.disposition.pass.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.quality.disposition.review.required.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.quality.disposition.superseded.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.review.approved.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.review.changes.requested.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.review.expired.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.review.in.review.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.review.rejected.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.review.requested.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.review.superseded.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.review.withdrawn.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.rights.and.consent.active.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.rights.and.consent.expired.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.rights.and.consent.rejected.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.rights.and.consent.restricted.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.rights.and.consent.revoked.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.rights.and.consent.superseded.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.rights.and.consent.under.review.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.rights.and.consent.verified.for.declared.scope.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.stream.session.closed.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.stream.session.connected.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.stream.session.degraded.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.stream.session.draining.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.stream.session.failed.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.upload.and.artifact.available.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.upload.and.artifact.erasure.requested.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.upload.and.artifact.expired.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.upload.and.artifact.quarantined.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.upload.and.artifact.rejected.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outcome.media.upload.and.artifact.verifying.supported",{"kind":"EXACT_STATE_OBSERVATION","property":"observedStateRef","enum":[],"positive":"EDGE_TARGET_STATE"}],["outputOrMeasurementProtocolChanged",{"kind":"SOURCE_SPECIFIC_EVIDENCE_DISPOSITION","property":"evidenceDisposition","enum":["PRESENT","ABSENT","UNKNOWN"],"positive":"PRESENT"}],["policyChangeOrRevocationOrExpiryRecorded",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["policyCurrent",{"kind":"CURRENT_SCOPED_OBSERVATION","property":"currentness","enum":["CURRENT","NOT_CURRENT","UNKNOWN"],"positive":"CURRENT"}],["policyEventRecorded",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["priorRevisionImmutable",{"kind":"BOUNDED_CHECK_OBSERVATION","property":"checkDisposition","enum":["PASS","FAIL","UNKNOWN"],"positive":"PASS"}],["projectAccessCurrent",{"kind":"CURRENT_SCOPED_OBSERVATION","property":"currentness","enum":["CURRENT","NOT_CURRENT","UNKNOWN"],"positive":"CURRENT"}],["projectOwnerAuthorized",{"kind":"AUTHORITY_DECISION","property":"authorizationDisposition","enum":["GRANTED","DENIED","UNKNOWN"],"positive":"GRANTED"}],["projectScopeMatches",{"kind":"CURRENT_SCOPED_OBSERVATION","property":"currentness","enum":["CURRENT","NOT_CURRENT","UNKNOWN"],"positive":"CURRENT"}],["providerBindingCurrent",{"kind":"CURRENT_SCOPED_OBSERVATION","property":"currentness","enum":["CURRENT","NOT_CURRENT","UNKNOWN"],"positive":"CURRENT"}],["providerObservationRecorded",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["reconciliationAuthorityAvailable",{"kind":"BOUNDED_CHECK_OBSERVATION","property":"checkDisposition","enum":["PASS","FAIL","UNKNOWN"],"positive":"PASS"}],["reconciliationEvidenceDurable",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["recoveryBudgetAvailable",{"kind":"BOUNDED_CHECK_OBSERVATION","property":"checkDisposition","enum":["PASS","FAIL","UNKNOWN"],"positive":"PASS"}],["referencedArtifactsAvailable",{"kind":"BOUNDED_CHECK_OBSERVATION","property":"checkDisposition","enum":["PASS","FAIL","UNKNOWN"],"positive":"PASS"}],["requestValid",{"kind":"SOURCE_SPECIFIC_EVIDENCE_DISPOSITION","property":"evidenceDisposition","enum":["PRESENT","ABSENT","UNKNOWN"],"positive":"PRESENT"}],["retentionPass",{"kind":"BOUNDED_CHECK_OBSERVATION","property":"checkDisposition","enum":["PASS","FAIL","UNKNOWN"],"positive":"PASS"}],["retryBudgetAvailable",{"kind":"BOUNDED_CHECK_OBSERVATION","property":"checkDisposition","enum":["PASS","FAIL","UNKNOWN"],"positive":"PASS"}],["reviewOrErasureDecisionRecorded",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["reviewPurposeCurrent",{"kind":"CURRENT_SCOPED_OBSERVATION","property":"currentness","enum":["CURRENT","NOT_CURRENT","UNKNOWN"],"positive":"CURRENT"}],["reviewPurposeSelected",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["reviewerAuthorized",{"kind":"AUTHORITY_DECISION","property":"authorizationDisposition","enum":["GRANTED","DENIED","UNKNOWN"],"positive":"GRANTED"}],["reviewerDelegationCurrent",{"kind":"AUTHORITY_DECISION","property":"authorizationDisposition","enum":["GRANTED","DENIED","UNKNOWN"],"positive":"GRANTED"}],["revisionCreatesNewVersion",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["revocationDurable",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["revocationOrExpiryDurable",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["rights.expiryRecorded",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["rights.newEvidenceRecorded",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["rights.policyChangeRecorded",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["rights.revocationRecorded",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["rightsDispositionRecorded",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["safeDecisionRecorded",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["scopeBoundEvidenceProduced",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["securityDispositionRecorded",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["sessionGrantCurrent",{"kind":"CURRENT_SCOPED_OBSERVATION","property":"currentness","enum":["CURRENT","NOT_CURRENT","UNKNOWN"],"positive":"CURRENT"}],["stableSubmissionIdentity",{"kind":"SOURCE_SPECIFIC_EVIDENCE_DISPOSITION","property":"evidenceDisposition","enum":["PRESENT","ABSENT","UNKNOWN"],"positive":"PRESENT"}],["tenant.matches",{"kind":"TENANT_IDENTITY_TUPLE","properties":{"tenantId":{"type":"string","minLength":1,"maxLength":256},"subjectTenantId":{"type":"string","minLength":1,"maxLength":256}},"positive":"TRUSTED_TENANT_EQUALS_SUBJECT_TENANT"}],["tenantProjectScopeMatches",{"kind":"CURRENT_SCOPED_OBSERVATION","property":"currentness","enum":["CURRENT","NOT_CURRENT","UNKNOWN"],"positive":"CURRENT"}],["tombstoneCheckPass",{"kind":"BOUNDED_CHECK_OBSERVATION","property":"checkDisposition","enum":["PASS","FAIL","UNKNOWN"],"positive":"PASS"}],["trustedConsentAuthority",{"kind":"AUTHORITY_DECISION","property":"authorizationDisposition","enum":["GRANTED","DENIED","UNKNOWN"],"positive":"GRANTED"}],["uploadBoundsValid",{"kind":"SOURCE_SPECIFIC_EVIDENCE_DISPOSITION","property":"evidenceDisposition","enum":["PRESENT","ABSENT","UNKNOWN"],"positive":"PRESENT"}],["userAssertionRecordedUnverified",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}],["validationPass",{"kind":"BOUNDED_CHECK_OBSERVATION","property":"checkDisposition","enum":["PASS","FAIL","UNKNOWN"],"positive":"PASS"}],["versionCurrent",{"kind":"CURRENT_SCOPED_OBSERVATION","property":"currentness","enum":["CURRENT","NOT_CURRENT","UNKNOWN"],"positive":"CURRENT"}],["versionValidityOrExpiryOrWithdrawalEvidence",{"kind":"EXACT_RECORD_OBSERVATION","property":"recordDisposition","enum":["RECORDED","NOT_RECORDED","UNKNOWN"],"positive":"RECORDED"}]]);
factValueModelByExactName.set("requestValid", {
  kind: "EXACT_ACCEPTED_REQUEST_SNAPSHOT",
  property: null,
  enum: [],
  positive: "EXACT_CURRENT_ACCEPTED_REQUEST_SNAPSHOT",
  predicateMeaning: "The selected job-submit request is valid only when the exact owner parameter/typed-input validator accepts it and a current request-snapshot read matches the host-selected job, request, operation/schema closure, and canonical request fingerprint.",
  sourceRefs: [
    ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.job.submit.v1/parameterBindingRule",
    ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.job.submit.v1/requestSemantics/typedInputValidator",
    ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.request-snapshot.inspect.v1",
  ],
  requestSchemaRef: ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.request-snapshot.inspect.v1/requestSchema",
  resultSchemaRef: ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.request-snapshot.inspect.v1/resultSchema",
  valueSchema: { type: "object", additionalProperties: false, required: ["queryRequest", "queryResult"], properties: {
    queryRequest: { type: "object" }, queryResult: { type: "object" },
  } },
  trustedInputs: ["expectedRequestSnapshotByFact"],
});
for (const authorityFact of ["authorityCurrent", "authorityRecordedConsentDecision", "delegationCurrent", "deliveryIntentAuthorized", "inviteeAccepted", "inviterAuthorized", "projectOwnerAuthorized", "reviewerAuthorized", "reviewerDelegationCurrent", "trustedConsentAuthority"]) factValueModelByExactName.set(authorityFact, {
  kind: "EXACT_SCOPED_AUTHORITY_DECISION",
  positive: "GRANTED_FOR_EXACT_TRANSITION_EFFECT",
  sourceRefs: [
    `${p1}/authority.yaml#ownerDefinedPdp10AuthorityScopes/effectAuthority`,
    `${p1}/authority.yaml#ownerDefinedPdp05TrustAndOwnership/trustContexts/@id=media.trust.current-policy-decision`,
    `${p1}/transitions.yaml#ownerDefinedTransitionTriggerSemantics/guardFactContracts/@id=media.transition-guard-fact.${authorityFact.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}.v1`,
  ],
  trustedInputs: ["expectedAuthorityDecisionByFact", "maxAgeMsByFact"],
  predicateMeaning: "A source-scoped authority decision is usable only when its issuer, tenant, principal, subject version, exact transition edge/effect, authority, policy revision, decision method, validity interval, freshness, and evidence tuple match the trusted expected context. GRANTED satisfies; DENIED denies; missing, foreign, stale, expired, or unknown remains UNKNOWN. This is a definition-level decision contract and does not establish an admitted runtime authority source.",
  valueSchema: { oneOf: [
    { type: "object", additionalProperties: false, required: ["decisionDisposition", "decisionRef", "tenantId", "principalId", "subjectRef", "subjectVersionRef", "transitionRef", "edgeRuleRef", "effectRef", "authorityRef", "policyRef", "policyRevisionRef", "decisionMethodRef", "validFrom", "validUntil", "observedAt", "evidenceRefs"], properties: {
      decisionDisposition: { enum: ["GRANTED", "DENIED"] },
      decisionRef: { type: "string", minLength: 1, maxLength: 512 },
      tenantId: { type: "string", minLength: 1, maxLength: 256 }, principalId: { type: "string", minLength: 1, maxLength: 256 },
      subjectRef: { type: "string", minLength: 1, maxLength: 512 }, subjectVersionRef: { type: "string", minLength: 1, maxLength: 512 },
      transitionRef: { type: "string", minLength: 1, maxLength: 512 }, edgeRuleRef: { type: "string", minLength: 1, maxLength: 512 }, effectRef: { type: "string", minLength: 1, maxLength: 512 },
      authorityRef: { type: "string", minLength: 1, maxLength: 512 }, policyRef: { type: "string", minLength: 1, maxLength: 512 }, policyRevisionRef: { type: "string", minLength: 1, maxLength: 512 },
      decisionMethodRef: { type: "string", minLength: 1, maxLength: 512 }, validFrom: { type: "string", format: "date-time" }, validUntil: { type: "string", format: "date-time" },
      observedAt: { type: "string", format: "date-time" }, evidenceRefs: { type: "array", minItems: 1, maxItems: 32, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 512 } },
    } },
    { type: "object", additionalProperties: false, required: ["decisionDisposition", "decisionRef", "tenantId", "principalId", "subjectRef", "subjectVersionRef", "transitionRef", "edgeRuleRef", "effectRef", "authorityRef", "policyRef", "policyRevisionRef", "decisionMethodRef", "observedAt", "unknownReason"], properties: {
      decisionDisposition: { const: "UNKNOWN" }, decisionRef: { type: "string", minLength: 1, maxLength: 512 },
      tenantId: { type: "string", minLength: 1, maxLength: 256 }, principalId: { type: "string", minLength: 1, maxLength: 256 },
      subjectRef: { type: "string", minLength: 1, maxLength: 512 }, subjectVersionRef: { type: "string", minLength: 1, maxLength: 512 },
      transitionRef: { type: "string", minLength: 1, maxLength: 512 }, edgeRuleRef: { type: "string", minLength: 1, maxLength: 512 }, effectRef: { type: "string", minLength: 1, maxLength: 512 },
      authorityRef: { type: "string", minLength: 1, maxLength: 512 }, policyRef: { type: "string", minLength: 1, maxLength: 512 }, policyRevisionRef: { type: "string", minLength: 1, maxLength: 512 },
      decisionMethodRef: { type: "string", minLength: 1, maxLength: 512 }, observedAt: { type: "string", format: "date-time" }, unknownReason: { type: "string", minLength: 1, maxLength: 512 },
    } },
  ] },
});
factValueModelByExactName.set("policyCurrent", {
  kind: "EXACT_SCOPED_POLICY_REVISION_OBSERVATION",
  positive: "CURRENT_POLICY_REVISION_MATCHES_TRUSTED_EXPECTED_REVISION_FOR_EXACT_EFFECT",
  sourceRefs: [
    `${p1}/authority.yaml#ownerDefinedPdp10AuthorityScopes/effectAuthority`,
    `${p1}/authority.yaml#ownerDefinedPdp05TrustAndOwnership/trustContexts/@id=media.trust.current-policy-decision`,
    ".product-experience/pdp-0-product-truth/policy-authority-model.yaml#productPolicy",
  ],
  trustedInputs: ["expectedPolicyRefByFact", "expectedPolicyRevisionRefByFact", "maxAgeMsByFact"],
  predicateMeaning: "Policy currentness is derived from a typed revision observation joined to the host-expected policy and revision, exact tenant/principal/subject version and transition effect, pinned authority, and fresh observation time. A matching CURRENT revision satisfies; a same-scope explicit NOT_CURRENT revision denies; unknown, contradictory, stale, or foreign observations remain UNKNOWN. This logical definition does not assert a deployed policy-read endpoint.",
  valueSchema: { oneOf: [
    { type: "object", additionalProperties: false, required: ["observationDisposition", "tenantId", "principalId", "subjectRef", "subjectVersionRef", "transitionRef", "edgeRuleRef", "effectRef", "authorityRef", "policyRef", "expectedPolicyRevisionRef", "observedPolicyRevisionRef", "observedAt", "evidenceRefs"], properties: {
      observationDisposition: { enum: ["CURRENT", "NOT_CURRENT"] },
      tenantId: { type: "string", minLength: 1, maxLength: 256 }, principalId: { type: "string", minLength: 1, maxLength: 256 },
      subjectRef: { type: "string", minLength: 1, maxLength: 512 }, subjectVersionRef: { type: "string", minLength: 1, maxLength: 512 },
      transitionRef: { type: "string", minLength: 1, maxLength: 512 }, edgeRuleRef: { type: "string", minLength: 1, maxLength: 512 }, effectRef: { type: "string", minLength: 1, maxLength: 512 },
      authorityRef: { type: "string", minLength: 1, maxLength: 512 }, policyRef: { type: "string", minLength: 1, maxLength: 512 },
      expectedPolicyRevisionRef: { type: "string", minLength: 1, maxLength: 512 }, observedPolicyRevisionRef: { type: "string", minLength: 1, maxLength: 512 },
      observedAt: { type: "string", format: "date-time" }, evidenceRefs: { type: "array", minItems: 1, maxItems: 32, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 512 } },
    } },
    { type: "object", additionalProperties: false, required: ["observationDisposition", "tenantId", "principalId", "subjectRef", "subjectVersionRef", "transitionRef", "edgeRuleRef", "effectRef", "authorityRef", "policyRef", "expectedPolicyRevisionRef", "observedPolicyRevisionRef", "observedAt", "unknownReason"], properties: {
      observationDisposition: { const: "UNKNOWN" },
      tenantId: { type: "string", minLength: 1, maxLength: 256 }, principalId: { type: "string", minLength: 1, maxLength: 256 },
      subjectRef: { type: "string", minLength: 1, maxLength: 512 }, subjectVersionRef: { type: "string", minLength: 1, maxLength: 512 },
      transitionRef: { type: "string", minLength: 1, maxLength: 512 }, edgeRuleRef: { type: "string", minLength: 1, maxLength: 512 }, effectRef: { type: "string", minLength: 1, maxLength: 512 },
      authorityRef: { type: "string", minLength: 1, maxLength: 512 }, policyRef: { type: "string", minLength: 1, maxLength: 512 },
      expectedPolicyRevisionRef: { type: "string", minLength: 1, maxLength: 512 }, observedPolicyRevisionRef: { type: "string", minLength: 1, maxLength: 512 },
      observedAt: { type: "string", format: "date-time" }, unknownReason: { type: "string", minLength: 1, maxLength: 512 },
    } },
  ] },
});

function factValueModel(fact) {
  const model = factValueModelByExactName.get(fact);
  if (!model) throw new Error(`Missing reviewed typed guard-fact value model: ${fact}`);
  return structuredClone(model);
}

// These predicates were previously represented by generic PASS/CURRENT/PRESENT
// values. That loses the actual set, revision, and effect tuple needed to prove
// them. Keep them explicitly unresolved until a fact-specific contract exists.
const requiredCopyClasses = ["SOURCE", "DERIVED", "CACHE", "BACKUP", "PROVIDER", "EXTERNAL"];
factValueModelByExactName.set("copyInventoryComplete", {
  kind: "EXHAUSTIVE_COPY_INVENTORY",
  requiredCopyClasses,
  valueSchema: { type: "object", additionalProperties: false, required: ["subjectRef", "subjectVersionRef", "inventoryManifestRef", "inventoryRevision", "inventoryDisposition", "requiredCopyClasses", "classCoverage", "unresolvedCopyRefs"], properties: {
    subjectRef: { type: "string", minLength: 1, maxLength: 512 },
    subjectVersionRef: { type: "string", minLength: 1, maxLength: 512 },
    inventoryManifestRef: { type: "string", minLength: 1, maxLength: 512 },
    inventoryRevision: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    inventoryDisposition: { enum: ["COMPLETE", "PARTIAL", "UNKNOWN"] },
    requiredCopyClasses: { const: requiredCopyClasses },
    classCoverage: { type: "array", minItems: requiredCopyClasses.length, maxItems: requiredCopyClasses.length, uniqueItems: true, items: { type: "object", additionalProperties: false, required: ["copyClass", "enumerationDisposition", "copyRefs"], properties: {
      copyClass: { enum: requiredCopyClasses },
      enumerationDisposition: { enum: ["EXHAUSTIVE", "INCOMPLETE", "UNKNOWN"] },
      copyRefs: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 512 } },
    } } },
    unresolvedCopyRefs: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 512 } },
  } },
  positive: "ALL_REQUIRED_COPY_CLASSES_ARE_EXHAUSTIVELY_ENUMERATED_FOR_THE_EXACT_IMMUTABLE_SUBJECT_VERSION_AND_NO_COPY_REMAINS_UNRESOLVED",
});
factValueModelByExactName.set("hold.absent", { kind: "EXHAUSTIVE_ACTIVE_HOLD_SET" });
factValueModelByExactName.set("consentPerEffectCurrent", { kind: "CURRENT_PER_EFFECT_CONSENT_SET" });
factValueModelByExactName.set("expectedVersionMatches", {
  kind: "EXACT_PROJECT_HEAD_REVISION_EQUALITY",
  properties: {
    projectRef: { type: "string", minLength: 1, maxLength: 512 },
    expectedHeadRevisionId: { type: "string", minLength: 1, maxLength: 512 },
    observedCurrentHeadRevisionId: { type: "string", minLength: 1, maxLength: 512 },
  },
  positive: "EXPECTED_HEAD_REVISION_EQUALS_THE_CURRENT_OWNER_OBSERVED_PROJECT_HEAD",
});
factValueModelByExactName.set("hold.absent", {
  kind: "EXHAUSTIVE_ACTIVE_HOLD_SET",
  valueSchema: { type: "object", additionalProperties: false, required: ["subjectRef", "subjectVersionRef", "purposeRef", "enumerationDisposition", "activeHoldRefs"], properties: {
    subjectRef: { type: "string", minLength: 1, maxLength: 512 },
    subjectVersionRef: { type: "string", minLength: 1, maxLength: 512 },
    purposeRef: { type: "string", minLength: 1, maxLength: 512 },
    enumerationDisposition: { enum: ["EXHAUSTIVE", "INCOMPLETE", "UNKNOWN"] },
    activeHoldRefs: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 512 } },
  } },
  positive: "EXHAUSTIVE_ACTIVE_HOLD_SET_IS_EMPTY_FOR_THE_EXACT_SUBJECT_VERSION_AND_PURPOSE",
});
factValueModelByExactName.set("consentPerEffectCurrent", {
  kind: "CURRENT_PER_EFFECT_CONSENT_SET",
  predicateMeaning: "Each expected effect is evaluated from exact current rights and consent P1 reads, bound to the same tenant/principal, immutable subject version, purpose/use/region/retention, consent identity/revision, authority/version, and validity interval. A permitted decision satisfies; explicit denial denies; missing, stale, conflicting, or foreign reads remain UNKNOWN. This definition does not assert a deployed query route.",
  trustedInputs: ["expectedEffectRefsByFact", "expectedConsentBindingsByEffect", "expectedRightsOperationRefByFact", "expectedRightsReadAuthorityRefByFact", "expectedRightsReadVersionByFact", "expectedConsentReadAuthorityRefByFact", "expectedConsentReadVersionByFact", "expectedPurposeByFact", "expectedSubjectArtifactVersionRefByFact", "expectedRegionByFact", "expectedRetentionPolicyRefByFact"],
  valueSchema: { type: "object", additionalProperties: false, required: ["effectReads"], properties: {
    effectReads: { type: "array", minItems: 1, maxItems: 32, items: { type: "object", additionalProperties: false,
      required: ["rightsRequest", "rightsResult", "consentRequest", "consentResult"], properties: {
        rightsRequest: { type: "object" }, rightsResult: { type: "object" },
        consentRequest: { type: "object" }, consentResult: { type: "object" },
      } } },
  } },
  positive: "EVERY_EXPECTED_EFFECT_HAS_A_CURRENT_PERMITTED_DECISION_FOR_THE_EXACT_SUBJECT_VERSION_AND_PURPOSE",
});

function factSourceFor(transitionId, fact) {
  const refs = [];
  if (fact === "consentPerEffectCurrent") {
    refs.push(`${p1}/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.rights-decision.v1`);
    refs.push(`${p1}/operations.yaml#ownerConsentRevisionObservationContract`);
    refs.push(`${p1}/privacy.yaml#ownerDefinedPdp10Boundary`);
  } else if (fact === "hold.absent" || fact === "copyInventoryComplete") {
    refs.push(".product-experience/pdp-0-product-truth/state-models.yaml#models/@modelId=media-upload-and-artifact");
    refs.push(".product-experience/pdp-0-product-truth/policy-authority-model.yaml#productPolicy/dataHandling/deletion");
    refs.push(`${p1}/domain-objects.yaml#objects/@id=media.domain.artifact-version`);
    refs.push(`${p1}/operations.yaml#capabilityOperationContracts/records/@id=media.operation.capability.media-provenance-erasure-effect-record`);
  } else if (transitionId.startsWith("media-stream-session/")) {
    refs.push(`${p1}/states.yaml#stateMachines/@machineId=media-stream-session`);
    refs.push(`${p1}/operations.yaml#capabilityOperationContracts/records/@id=media.operation.capability.media-stream-session-connect`);
  } else if (transitionId.startsWith("media-review/")) {
    refs.push(`${p1}/transitions.yaml#transitionRecords/@id=${transitionId}`);
    refs.push(`${p1}/authority.yaml#ownerDefinedPdp10AuthorityScopes/effectAuthority`);
  } else if (transitionId.startsWith("media-delivery/")) {
    refs.push(`${p1}/domain-objects.yaml#objects/@id=media.domain.delivery-outcome`);
    refs.push(`${p1}/authority.yaml#ownerDefinedPdp10AuthorityScopes/effectAuthority`);
  } else if (transitionId.startsWith("media-quality/")) {
    refs.push(`${p1}/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.quality-evidence.v1`);
    refs.push(`${p1}/quality-policy.yaml#assessmentContract`);
  } else if (transitionId.startsWith("media-project-version/")) {
    // The create-project query is not the CAS command. The exact append-only
    // attach operation owns the successor-revision CAS used by this edge.
    refs.push(`${p1}/transitions.yaml#transitionRecords/@id=${transitionId}`);
    refs.push(`${p1}/domain-objects.yaml#objects/@id=media.domain.project-revision`);
    refs.push(`${p1}/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation-slice.attach-source-asset`);
  } else if (transitionId.startsWith("media-project/")) {
    refs.push(`${p1}/operations.yaml#individualOperationContracts/records/@id=media.operation-slice.inspect-project`);
    refs.push(`${p1}/domain-objects.yaml#objects/@id=media.domain.project`);
  } else if (transitionId.startsWith("media-project-membership/")) {
    refs.push(`${p1}/transitions.yaml#transitionRecords/@id=${transitionId}`);
    refs.push(`${p1}/authority.yaml#ownerDefinedPdp10AuthorityScopes/identityScope`);
  } else if (transitionId.startsWith("media-rights-and-consent/")) {
    refs.push(`${p1}/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.rights-decision.v1`);
    refs.push(`${p1}/operations.yaml#ownerConsentRevisionObservationContract`);
    refs.push(`${p1}/privacy.yaml#ownerDefinedPdp10Boundary`);
  }
  refs.push(`${p1}/transition-guard-contracts.yaml#facts/${fact}`);
  return [...new Set(refs)];
}

const factOccurrences = new Map();
for (const record of records) {
  for (const edge of record.triggerCases) {
    for (const fact of edge.triggerGuardFacts) {
      const rows = factOccurrences.get(fact.fact) ?? [];
      rows.push({ record, edge, fact });
      factOccurrences.set(fact.fact, rows);
    }
  }
}
const guardFactContracts = [...factOccurrences].map(([fact, occurrences]) => {
  const slug = fact.toLowerCase().replace(/[^a-z0-9]+/gu, "-");
  const model = factValueModel(fact);
  const targets = [...new Set(occurrences.map(({ edge }) => edge.toStateRef))];
  if (model.kind === "EXACT_STATE_OBSERVATION") model.enum = [...new Set(occurrences.flatMap(({ edge }) => edge.triggerGuardFacts.find((row) => row.fact === fact)?.validStateRefs ?? [edge.toStateRef]))];
  const sourceFactRefs = [...new Set(occurrences.map(({ fact: row }) => row.sourceRef))];
  const transitionRefs = [...new Set(occurrences.map(({ record }) => record.transitionRef))];
  const sourceRefs = [...new Set([...occurrences.flatMap(({ record }) => factSourceFor(record.transitionRef.split("/@id=").at(-1), fact)), ...(model.sourceRefs ?? [])])];
  const authorityRefs = fact === "tenant.matches"
    ? [`${p1}/authority.yaml#ownerDefinedPdp10AuthorityScopes/identityScope`]
    : fact.startsWith("outcome.")
      ? [...new Set(occurrences.map(({ edge }) => edge.toStateRef.split("/stateDefinitions")[0]))]
      : [`${p1}/authority.yaml#ownerDefinedPdp10AuthorityScopes/effectAuthority`];
  const valueSchema = model.valueSchema ?? (model.kind === "EXACT_PROJECT_HEAD_REVISION_EQUALITY"
    ? { oneOf: [
      { type: "object", additionalProperties: false, required: Object.keys(model.properties), properties: model.properties },
      { type: "object", additionalProperties: false, required: ["observationDisposition", "observationReason"], properties: { observationDisposition: { const: "UNKNOWN" }, observationReason: { type: "string", minLength: 1, maxLength: 512 } } },
    ] }
    : model.kind === "UNRESOLVED_OWNER_PREDICATE"
    ? { type: "object", additionalProperties: false, required: ["observationDisposition", "observationReason"], properties: { observationDisposition: { const: "UNKNOWN" }, observationReason: { const: model.unresolvedReason } } }
    : model.kind === "EXACT_STATE_OBSERVATION"
    ? { oneOf: [
      { type: "object", additionalProperties: false, required: ["observationDisposition", "observedStateRef"], properties: { observationDisposition: { const: "OBSERVED" }, observedStateRef: { enum: model.enum } } },
      { type: "object", additionalProperties: false, required: ["observationDisposition", "observationReason"], properties: { observationDisposition: { const: "UNKNOWN" }, observationReason: { type: "string", minLength: 1, maxLength: 512 } } },
    ] }
      : model.kind === "TENANT_IDENTITY_TUPLE"
      ? { oneOf: [
        { type: "object", additionalProperties: false, required: Object.keys(model.properties), properties: model.properties },
        { type: "object", additionalProperties: false, required: ["identityDisposition", "observationReason"], properties: { identityDisposition: { const: "UNKNOWN" }, observationReason: { type: "string", minLength: 1, maxLength: 512 } } },
      ] }
      : { type: "object", additionalProperties: false, required: [model.property], properties: { [model.property]: { enum: model.enum } } });
  return {
    id: `media.transition-guard-fact.${slug}.v1`,
    fact,
    predicateMeaning: model.predicateMeaning ?? `The exact guard predicate “${fact}” is evaluated from a current, source-owned typed observation for the referenced subject/version. The guard key alone is not evidence and cannot be asserted as a boolean.`,
    predicateSourceRefs: sourceFactRefs,
    sourceRefs,
    authorityRefs,
    transitionRefs,
    occurrenceSemantics: occurrences.map(({ record, edge, fact: row }) => ({
      transitionRef: record.transitionRef,
      edgeRuleRef: edge.edgeRuleRef,
      sourceGuardMeaning: record.sourceGuard,
      exactFromStateRef: edge.fromStateRef,
      exactToStateRef: edge.toStateRef,
      predicateFactRef: row.sourceRef,
      effectBoundary: "Definition-only guard meaning; no deployed producer or transition persistence is asserted.",
    })),
    valueKind: model.kind,
    valueProperty: model.property ?? null,
    valueOptions: model.enum ?? [],
    valueSemantics: model.positive,
    valueSchema,
    ...(model.requestSchemaRef ? { requestSchemaRef: model.requestSchemaRef } : {}),
    ...(model.resultSchemaRef ? { resultSchemaRef: model.resultSchemaRef } : {}),
    ...(model.kind === "UNRESOLVED_OWNER_PREDICATE" ? { semanticResolutionStatus: "OPEN_TYPED_FACT_SEMANTICS", semanticGap: model.unresolvedReason } : {}),
    resultRules: {
      positive: model.kind === "UNRESOLVED_OWNER_PREDICATE" ? "No positive verdict is currently defined; preserve UNKNOWN until a fact-specific raw evidence contract is authored." : model.kind === "EXACT_ACCEPTED_REQUEST_SNAPSHOT" ? "the exact typed job-submit request passes its canonical parameter/input validator and current owner snapshot tuple/fingerprint/schema closure matches host-selected expected values" : model.kind === "EXHAUSTIVE_COPY_INVENTORY" ? "every required copy class has exhaustive identity enumeration and no unresolved references for the exact subject version" : model.kind === "EXACT_PROJECT_HEAD_REVISION_EQUALITY" ? "request expected head revision equals the exact current owner-observed head for the same project" : model.kind === "EXHAUSTIVE_ACTIVE_HOLD_SET" ? "an exhaustive active-hold set is empty for the exact subject, version, and purpose" : model.kind === "CURRENT_PER_EFFECT_CONSENT_SET" ? "every exact expected effect has a current permitted decision for the same subject version and purpose" : model.kind === "EXACT_STATE_OBSERVATION" ? "observedStateRef equals the edge's exact target state ref" : model.kind === "TENANT_IDENTITY_TUPLE" ? "trusted tenantId equals subjectTenantId" : model.kind === "EXACT_SCOPED_AUTHORITY_DECISION" ? "a current GRANTED decision matches the exact expected subject, edge effect, authority, policy revision, and decision method" : model.kind === "EXACT_SCOPED_POLICY_REVISION_OBSERVATION" ? "the exact fresh policy observation reports the host-expected policy revision for this subject version and transition effect" : `${model.property} equals ${model.positive}`,
      negative: model.kind === "EXACT_STATE_OBSERVATION" ? "a valid different state is DENIED for this edge" : model.kind === "TENANT_IDENTITY_TUPLE" ? "a foreign tenant tuple is DENIED" : model.kind === "EXACT_SCOPED_AUTHORITY_DECISION" ? "the exact current decision tuple denies the transition effect; a foreign or stale tuple remains UNKNOWN" : model.kind === "EXACT_SCOPED_POLICY_REVISION_OBSERVATION" ? "a same-scope observation of a different current policy revision is DENIED; a foreign or contradictory revision remains UNKNOWN" : "a source-specific negative enum value is DENIED",
      unknown: "missing, stale, foreign-scope, conflicting, or unverified owner evidence is UNKNOWN; no transition or retry is implied",
    },
    trustedInputs: [...new Set(["tenantId", "principalId", "expectedSubjectRef", "expectedSubjectVersionRef", "expectedAuthorityRef", "expectedReadVersion", "now", "maxAgeMs", ...(model.trustedInputs ?? [])])],
    runtimeAdmission: "NOT_ADMITTED",
    acceptanceEffect: "none",
  };
});

const factContractByName = new Map(guardFactContracts.map((contract) => [contract.fact, contract]));
const genericEdgeCount = records.reduce((count, record) => count + record.triggerCases.filter((edge) => !edge.causalTriggerDefinition).length, 0);
for (const record of records) {
  for (const edge of record.triggerCases) {
    if (edge.causalTriggerDefinition) continue;
    const factReceipts = edge.triggerGuardFacts.map((fact) => {
      const contract = factContractByName.get(fact.fact);
      const sourceRef = fact.sourceRef;
      const producerRef = `media.logical-producer.${record.sourceMachineId.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}.v1`;
      const properties = {
        factRef: { const: sourceRef },
        contractRef: { const: `${p1}/transitions.yaml#ownerDefinedTransitionTriggerSemantics/guardFactContracts/@id=${contract.id}` },
        producerRef: { const: producerRef },
        subjectRef: { type: "string", minLength: 1, maxLength: 512 },
        subjectVersionRef: { type: "string", minLength: 1, maxLength: 512 },
        tenantId: { type: "string", minLength: 1, maxLength: 256 },
        authorityRef: { enum: contract.authorityRefs },
        readVersion: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        observedAt: { type: "string", format: "date-time" },
        evidenceRefs: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 512 } },
        value: contract.valueSchema,
      };
      return { type: "object", additionalProperties: false, required: Object.keys(properties), properties };
    });
    const sourceRef = record.guardContractRef;
    const fromRef = edge.fromStateRef;
    const toRef = edge.toStateRef;
    const producerRef = `media.logical-producer.${record.sourceMachineId.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}.v1`;
    edge.causalTriggerDefinition = {
      id: edge.id.replace("media.transition-trigger-edge.", "media.transition-trigger-definition."),
      triggerKind: "EDGE_SPECIFIC_TYPED_GUARD_RECEIPT_SET",
      transitionRef: record.transitionRef,
      edgeRuleRef: edge.edgeRuleRef,
      triggerRule: `Each source guard predicate for ${edge.id} must resolve from its own closed typed receipt bound to this exact ${fromRef}-to-${toRef} edge, aggregate tenant, aggregate version, authority, and current read version. The full nested all/any expression is evaluated from derived receipt values; caller booleans and display state labels cannot trigger the edge.`,
      sourceRefs: [record.transitionRef, sourceRef, fromRef, toRef, ...edge.triggerGuardFacts.flatMap((fact) => factContractByName.get(fact.fact).sourceRefs)],
      factContractRefs: edge.triggerGuardFacts.map((fact) => `${p1}/transitions.yaml#ownerDefinedTransitionTriggerSemantics/guardFactContracts/@id=${factContractByName.get(fact.fact).id}`),
      producerRef,
      sourceStateRef: fromRef,
      targetStateRef: toRef,
      guardExpression: edge.guardExpression,
      triggerGuardFacts: edge.triggerGuardFacts.map(({ fact, sourceRef }) => ({ fact, sourceRef, factContractRef: `${p1}/transitions.yaml#ownerDefinedTransitionTriggerSemantics/guardFactContracts/@id=${factContractByName.get(fact).id}` })),
      receiptSemantics: "per fact: exact fact contract source, host-bound identity tuple, allowlisted authority/read version, and current observation time",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["transitionRef", "edgeRuleRef", "producerRef", "aggregateRef", "aggregateVersionRef", "sourceStateRef", "targetStateRef", "occurredAt", "decision", "factReceipts"],
        properties: {
          transitionRef: { const: record.transitionRef },
          edgeRuleRef: { const: edge.edgeRuleRef },
          producerRef: { const: producerRef },
          aggregateRef: { type: "string", minLength: 1, maxLength: 512 },
          aggregateVersionRef: { type: "string", minLength: 1, maxLength: 512 },
          sourceStateRef: { const: fromRef },
          targetStateRef: { const: toRef },
          occurredAt: { type: "string", format: "date-time" },
          decision: { enum: ["APPLIED", "DENIED", "UNKNOWN"] },
          factReceipts: { type: "array", minItems: factReceipts.length, maxItems: factReceipts.length, uniqueItems: true, items: { oneOf: factReceipts } },
        },
      },
      trustedContext: ["tenantId", "principalId", "expectedAggregateRef", "expectedAggregateVersionRef", "expectedAuthorityByFact", "expectedReadVersionByFact", "currentnessClock", "maxEventAgeMs", "maxAgeMsByFact"],
      effect: "Definition-level eligibility only; the causal producer and persisted transition remain unadmitted until independently implemented and observed.",
      runtimeAdmission: "NOT_ADMITTED",
      acceptanceEffect: "none",
    };
  }
}
const logicalProducerDefinitions = [...new Set(records.map((record) => record.sourceMachineId))].map((machineId) => ({
  id: `media.logical-producer.${machineId.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}.v1`,
  ref: `${p1}/transitions.yaml#semanticOwner`,
  ownerMachineRef: `${p1}/states.yaml#stateMachines/@machineId=${machineId}`,
  role: `Definition-level ${machineId} transition owner; accepts only typed, edge-specific guard evidence and exact tenant/object/version joins.`,
  admission: "NOT_ADMITTED",
  runtimeProducerStatus: "NOT_IMPLEMENTED",
}));

const collection = {
  schemaVersion: "media.pdp1.owner-transition-trigger-semantics.v1",
  id: "media.pdp1.owner-transition-trigger-semantics",
  decisionRef: ".product-experience/decision-log.md#PXD-119",
  sourceRefs: [
    `${p1}/transitions.yaml#transitionRecords`,
    `${p1}/transitions.yaml#ownerDefinedTransitionRecords`,
    `${p1}/transition-guard-contracts.yaml#records`,
    `${p1}/states.yaml#stateMachines`,
    `${p3}/action-registry.yaml#actions`,
    `${p3}/action-registry.yaml#ownerDefinedActions`,
  ],
  status: "Partial owner-authored trigger evaluation contracts; non-outcome guard fact value contracts, causal producer bindings, event transport, and runtime proof remain open",
  producerRoles: [{
    id: "media.event.producer.media-domain-state-owner.v1",
    ref: `${p1}/transitions.yaml#semanticOwner`,
    role: "Media domain state owner; issues a definition-level edge decision only after the exact edge guard and trusted subject/version join are evaluated",
    identitySourceRef: `${p1}/transitions.yaml#semanticOwner`,
    trustedContextRequired: ["tenantId", "principalId", "expectedAggregateRef", "expectedAggregateVersion", "expectedProducerRef", "currentnessClock"],
    callerBodyCannotAssert: ["producer identity", "tenant/principal identity", "currentness", "guard truth", "persisted effect finality"],
    eventSchemaRule: "Each edge-specific payload schema fixes the exact transition, edge, from/to state, producer ref, and complete guard fact-ref set. Guard results are individually bound to evidence, subject/version, authority, source read version, and observation time.",
    authorityRule: "Every guard evidence item must carry the exact authority ref that owns that fact; missing authority, stale read version, foreign tenant/subject/version, or expired evidence yields UNKNOWN.",
    finalityRule: "APPLIED is a definition-level state-edge decision; only an independent current read of the exact owner state can establish persisted current state. No event receipt alone establishes runtime persistence.",
    runtimeAdmission: "NOT_ADMITTED",
  }, ...logicalProducerDefinitions],
  eventDisposition: {
    APPLIED: "Every exact guard fact is satisfied for the trusted subject/version, the owner records the transition result, and the request correlation is exact when a command action is bound; this definition does not prove runtime persistence.",
    DENIED: "At least one exact guard fact is false; no state transition is asserted and no retry is implied.",
    UNKNOWN: "Any required guard fact, producer/source, authority, subject/version, or currentness is missing, stale, conflicting, or unverified; preserve the prior known state and reconcile the same identity.",
  },
  recordCount: records.length,
  edgeCount: records.reduce((count, record) => count + record.triggerCases.length, 0),
  guardFactContractCount: guardFactContracts.length,
  newlyBoundCausalEdgeCount: genericEdgeCount,
  guardFactContracts,
  records,
  runtimeAdmission: "NOT_ADMITTED",
  acceptanceEffect: "none",
};
const yaml = stringify({ ownerDefinedTransitionTriggerSemantics: collection }, { lineWidth: 120, aliasDuplicateObjects: false });
writeFileSync(transitionPath, `${baseText.trimEnd()}\n\n${yaml}`);
console.log(JSON.stringify({ transitionRecords: records.length, edgeRules: collection.edgeCount, exactActionTransitionRefs: records.filter((row) => row.exactSourceActionRefs.length).length }, null, 2));
