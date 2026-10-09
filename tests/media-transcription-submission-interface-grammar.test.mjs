import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const require = createRequire(resolve(root, '../ghatana-tools/package.json'));
const { parse } = require('yaml');
const yaml = path => parse(readFileSync(resolve(root, path), 'utf8'));
const grammarPath = '.product-experience/pdp-2-design-interface-system/action-finality-grammar.yaml';
const operationsPath = '.product-experience/pdp-1-domain-data/operations.yaml';
const actionContractsPath = '.product-experience/pdp-1-domain-data/action-contracts.yaml';
const journeyPath = '.product-experience/pdp-3-product-experience/journey-contracts/transcribe-and-correct-captions.yaml';
const actionRegistryPath = '.product-experience/pdp-3-product-experience/action-registry.yaml';

function assertSubmissionGrammar(grammar, operation, familyBindings, journey, action) {
  assert.equal(grammar.status,
    'bounded-definition-grammar-under-PXD-071; independent-PDP-review-and-runtime-admission-open');
  assert.equal(grammar.decisionRef, '.product-experience/decision-log.md#PXD-071');
  assert.equal(grammar.sourceDecisionRef, '.product-experience/decision-log.md#PXD-070');
  assert.equal(grammar.journeyDecisionRef, '.product-experience/decision-log.md#PXD-072');
  assert.equal(grammar.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(grammar.phaseAdmission, 'pending-independent-PDP2-review');
  assert.equal(grammar.operation.operationRef, operation.id);
  assert.equal(operation.id, 'media.operation.transcription-submission');
  assert.equal(grammar.operation.actionRef, 'media.action.request-transcription');
  assert.equal(grammar.operation.journeyStepId, 'J03-2');
  assert.equal(operation.actionRefs.includes(grammar.operation.actionRef), true);
  assert.equal(familyBindings[operation.id], 'request-acknowledged-denied-conflict-unavailable-unknown-outcome');

  const input = operation.inputSemantics;
  const output = operation.outputSemantics;
  assert.equal(grammar.operation.selectorField, input.selectorField);
  assert.deepEqual(grammar.operation.requestModes, input.selectorValues);
  assert.deepEqual(grammar.operation.commonRequiredFields, input.commonRequiredFields);
  assert.deepEqual(grammar.operation.commonAllowedFields, input.commonAllowedFields);
  assert.deepEqual(grammar.operation.submitFields, input.submitRequiredFields);
  assert.deepEqual(grammar.operation.submitAllowedFields, input.submitAllowedFields);
  assert.deepEqual(grammar.operation.reconcileFields, input.reconcileRequiredFields);
  assert.deepEqual(grammar.operation.reconcileAllowedFields, input.reconcileAllowedFields);
  assert.equal(grammar.operation.branchFieldRule, input.branchFieldRule);
  assert.deepEqual(grammar.operation.trustedContextFields,
    [...operation.context.trustedIdentityFields, operation.context.optionalDelegationContext]);
  assert.deepEqual(grammar.operation.policyFields, ['purpose', 'consentRef', 'rightsEvidenceRef', 'retentionPolicyRef', 'processingLocation']);
  assert.deepEqual(grammar.operation.idempotencyScope, operation.idempotency.scope);
  assert.ok(grammar.operation.confirmation.startsWith(`${action.confirmation};`));
  assert.deepEqual(grammar.operation.languageIntent.requiredFields, input.languageIntent.requiredFields);
  assert.deepEqual(grammar.operation.languageIntent.modes, input.languageIntent.modes);
  assert.deepEqual(grammar.operation.languageIntent.EXPLICIT.requiredFields, input.languageIntent.EXPLICIT.requiredFields);
  assert.deepEqual(grammar.operation.languageIntent.EXPLICIT.allowedFields, input.languageIntent.EXPLICIT.allowedFields);
  assert.deepEqual(grammar.operation.languageIntent.AUTO_REQUESTED.requiredFields, input.languageIntent.AUTO_REQUESTED.requiredFields);
  assert.deepEqual(grammar.operation.languageIntent.AUTO_REQUESTED.allowedFields, input.languageIntent.AUTO_REQUESTED.allowedFields);
  assert.equal(grammar.operation.languageIntent.EXPLICIT.rule, input.languageIntent.EXPLICIT.rule);
  assert.equal(grammar.operation.languageIntent.AUTO_REQUESTED.rule, input.languageIntent.AUTO_REQUESTED.rule);
  assert.deepEqual(grammar.operation.languageIntent.EXPLICIT.encoding, ['EXPLICIT', 'exact-languageTag']);
  assert.deepEqual(grammar.operation.languageIntent.AUTO_REQUESTED.encoding, ['AUTO_REQUESTED']);
  assert.deepEqual(grammar.operation.requestFingerprint, input.requestFingerprint);
  assert.deepEqual(grammar.operation.scalarNullability, input.scalarNullability);
  assert.match(grammar.operation.requestFingerprint.encoding, /compact-UTF-8-JSON-array/u);
  assert.match(grammar.operation.requestFingerprint.encoding, /explicit-null-or-value-presence/u);
  assert.match(grammar.operation.requestFingerprint.scalarEncoding, /lowercase-64-hex-SHA256/u);
  assert.match(grammar.operation.requestFingerprint.digestField, /lowercase-64-hex-SHA256/u);
  assert.match(grammar.operation.requestFingerprint.normalization, /no-trimming-case-folding-default-insertion-or-map-order-dependence/u);
  assert.match(grammar.operation.snapshot, /before-first-dispatch/u);
  assert.match(grammar.operation.snapshot, /caller-retains-same-snapshot/u);

  assert.deepEqual(grammar.operation.successFields, output.acknowledgedFields);
  assert.equal(grammar.operation.acknowledgedOutcome, output.acknowledgedOutcome);
  assert.deepEqual(grammar.operation.replayDispositionValues, output.replayDispositionValues);
  assert.deepEqual(grammar.operation.unknownFields, output.unknownFields);
  assert.match(grammar.operation.receiptMeaning, /no-job-state-or-worker-dispatch-is-proven/u);
  assert.equal(output.completedRecognitionIsNotImplied, true);
  assert.equal(output.transcriptTextLanguageDetectionQualityOrCaptionApprovalIsNotImplied, true);
  assert.deepEqual(grammar.operation.problemCodes.definitivePreDispatch, operation.error.definitivePreDispatchCodes);
  assert.deepEqual(grammar.operation.problemCodes.nonterminalOrAmbiguous, operation.error.nonterminalOrAmbiguousCodes);
  assert.match(grammar.operation.definitiveRefusal, /only-for-this-attempt/u);
  assert.match(grammar.operation.definitiveRefusal, /does-not-prove-that-no-prior-request-exists/u);
  assert.match(grammar.operation.sameKeyDifferentFingerprint, /does-not-erase-or-prove-absence/u);
  assert.match(grammar.operation.sameKeySameFingerprint, /after-fresh-current-effect-authority-check/u);
  assert.match(grammar.operation.sameKeySameFingerprint, /no-new-logical-request/u);
  assert.match(grammar.operation.replayAuthority, /fresh-current-identity-delegation-rights-consent/u);
  assert.match(grammar.operation.reversibility, /no-reversal-after-dispatch-may-have-begun/u);
  assert.match(grammar.operation.reconciliationAuthority, /read-only-branch/u);
  assert.match(grammar.operation.reconciliationAuthority, /does-not-remove-read-authority-or-authorize-processing-or-replay/u);
  assert.match(grammar.operation.unknownOutcome, /absent-expired-or-unavailable-evidence-never-proves-no-effect/u);
  assert.match(grammar.operation.asynchronousBoundary, /not-provider-execution-recognition-completion/u);
  assert.match(grammar.operation.cancellation, /does-not-cancel-or-reverse-the-submission-receipt/u);
  assert.match(grammar.operation.workerRetries, /separate-existing-job-lifecycle/u);
  assert.deepEqual(grammar.operation.prohibited, [
    'equate-acknowledgement-with-job-state-or-completion', 'blind-replay',
    'new-key-to-escape-unknown-or-conflict', 'infer-language-or-profile-support',
    'trust-caller-authority-assertions', 'conflate-Transcribe-StreamTranscribe-or-SubmitCorrection',
    'claim-runtime-or-channel-admission',
  ]);

  const step = journey.steps.find(candidate => candidate.stepId === grammar.operation.journeyStepId);
  assert.ok(step, 'the grammar must bind to the existing exact J03-2 step');
  assert.equal(step.action, grammar.operation.actionRef);
  assert.equal(step.canonicalOperationRef, operation.id);
  assert.equal(step.sourceDecisionRef, grammar.sourceDecisionRef);
  assert.equal(step.grammarDecisionRef, grammar.decisionRef);
  assert.equal(step.decisionRef, grammar.journeyDecisionRef);
  assert.equal(step.definitionVerification.runtimeAdmission, 'NOT_ADMITTED');
  assert.deepEqual(step.submissionSemantics.submitRequiredFields, input.submitRequiredFields);
  assert.deepEqual(step.submissionSemantics.commonRequiredFields, input.commonRequiredFields);
  assert.deepEqual(step.submissionSemantics.commonAllowedFields, input.commonAllowedFields);
  assert.deepEqual(step.submissionSemantics.submitAllowedFields, input.submitAllowedFields);
  assert.deepEqual(step.submissionSemantics.reconcileRequiredFields, input.reconcileRequiredFields);
  assert.deepEqual(step.submissionSemantics.reconcileAllowedFields, input.reconcileAllowedFields);
  assert.equal(step.submissionSemantics.branchFieldRule, input.branchFieldRule);
  assert.deepEqual(step.submissionSemantics.scalarNullability.requiredNonemptyStrings,
    input.scalarNullability.requiredNonemptyStrings);
  assert.deepEqual(step.submissionSemantics.scalarNullability.digestFields,
    input.scalarNullability.nonnullDigestFields);
  assert.equal(step.submissionSemantics.scalarNullability.rightsEvidenceRef,
    input.scalarNullability.rightsEvidenceRef);
  assert.equal(step.submissionSemantics.scalarNullability.reconcileRequestFingerprint,
    input.scalarNullability.reconcileRequestFingerprint);
  assert.match(step.submissionSemantics.scalarNullability.optionalDelegationRef, /absent-only-means-canonical-null/u);
  assert.match(step.submissionSemantics.scalarNullability.consentRef, /explicit-null-only/u);
  assert.match(step.submissionSemantics.scalarNullability.noOtherNulls, /no-defaulting-or-ignored-payload-fields/u);
  assert.deepEqual(step.submissionSemantics.languageIntent.variants.EXPLICIT.requiredFields,
    input.languageIntent.EXPLICIT.requiredFields);
  assert.deepEqual(step.submissionSemantics.languageIntent.variants.EXPLICIT.allowedFields,
    input.languageIntent.EXPLICIT.allowedFields);
  assert.deepEqual(step.submissionSemantics.languageIntent.variants.AUTO_REQUESTED.requiredFields,
    input.languageIntent.AUTO_REQUESTED.requiredFields);
  assert.deepEqual(step.submissionSemantics.languageIntent.variants.AUTO_REQUESTED.allowedFields,
    input.languageIntent.AUTO_REQUESTED.allowedFields);
  assert.deepEqual(step.submissionSemantics.acknowledgedFields, output.acknowledgedFields);
  assert.deepEqual(step.submissionSemantics.unknownFields, output.unknownFields);
  assert.deepEqual(step.submissionSemantics.requestFingerprint.binds, input.requestFingerprint.fields);
  assert.match(step.submissionSemantics.reconciliation, /separately rechecked current scoped receipt-read authority/u);

  assert.equal(action.id, grammar.operation.actionRef);
  const actionSemantics = action.actionDefinitionSemantics;
  assert.equal(actionSemantics.operationRef, operation.id);
  assert.equal(actionSemantics.sourceDecisionRef, grammar.sourceDecisionRef);
  assert.equal(actionSemantics.grammarDecisionRef, grammar.decisionRef);
  assert.equal(actionSemantics.reviewDecisionRef, grammar.journeyDecisionRef);
  assert.equal(actionSemantics.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(actionSemantics.effectKind, 'REQUEST_ACCEPTANCE');
}

test('J03-2 submission grammar binds the existing operation and exact request, receipt, policy, and fingerprint semantics', () => {
  const operations = yaml(operationsPath);
  const operation = operations.operations.find(candidate => candidate.id === 'media.operation.transcription-submission');
  const familyBindings = yaml(actionContractsPath).operationFamilyBindings;
  const journey = yaml(journeyPath);
  const action = yaml(actionRegistryPath).actions.find(candidate => candidate.id === 'media.action.request-transcription');
  assertSubmissionGrammar(yaml(grammarPath).boundedTranscriptionSubmissionSlice, operation,
    familyBindings, journey, action);
});

test('submission grammar rejects fingerprint, authority, and unknown-outcome scope broadening', () => {
  const operations = yaml(operationsPath);
  const operation = operations.operations.find(candidate => candidate.id === 'media.operation.transcription-submission');
  const familyBindings = yaml(actionContractsPath).operationFamilyBindings;
  const journey = yaml(journeyPath);
  const action = yaml(actionRegistryPath).actions.find(candidate => candidate.id === 'media.action.request-transcription');
  const original = yaml(grammarPath).boundedTranscriptionSubmissionSlice;

  const wrongOperation = structuredClone(original);
  wrongOperation.operation.operationRef = 'media.operation.transcription';
  assert.throws(() => assertSubmissionGrammar(wrongOperation, operation, familyBindings, journey, action),
    /transcription-submission/u);

  const fingerprintOmission = structuredClone(original);
  fingerprintOmission.operation.requestFingerprint.fields = fingerprintOmission.operation.requestFingerprint.fields
    .filter(field => field !== 'profileConfigurationDigest');
  assert.throws(() => assertSubmissionGrammar(fingerprintOmission, operation, familyBindings, journey, action),
    /deep-equal/u);

  const mapOrderFingerprint = structuredClone(original);
  mapOrderFingerprint.operation.requestFingerprint.encoding = 'serialize-an-unordered-map-without-explicit-null-presence';
  assert.throws(() => assertSubmissionGrammar(mapOrderFingerprint, operation, familyBindings, journey, action),
    /deep-equal/u);

  const unknownSubmitField = structuredClone(original);
  unknownSubmitField.operation.submitAllowedFields.push('unreviewedParameter');
  assert.throws(() => assertSubmissionGrammar(unknownSubmitField, operation, familyBindings, journey, action),
    /deep-equal/u);

  const branchMixedPayload = structuredClone(original);
  branchMixedPayload.operation.submitAllowedFields.push('requestFingerprint');
  assert.throws(() => assertSubmissionGrammar(branchMixedPayload, operation, familyBindings, journey, action),
    /deep-equal/u);

  const callerSuppliedIdentity = structuredClone(original);
  callerSuppliedIdentity.operation.submitAllowedFields.push('tenantId');
  assert.throws(() => assertSubmissionGrammar(callerSuppliedIdentity, operation, familyBindings, journey, action),
    /deep-equal/u);

  const nullRequestId = structuredClone(original);
  nullRequestId.operation.scalarNullability.requiredNonemptyStrings = nullRequestId.operation.scalarNullability.requiredNonemptyStrings
    .filter(field => field !== 'requestId');
  assert.throws(() => assertSubmissionGrammar(nullRequestId, operation, familyBindings, journey, action),
    /deep-equal/u);

  const nullRightsEvidence = structuredClone(original);
  nullRightsEvidence.operation.scalarNullability.rightsEvidenceRef = 'nullable-or-caller-asserted';
  assert.throws(() => assertSubmissionGrammar(nullRightsEvidence, operation, familyBindings, journey, action),
    /deep-equal/u);

  const implicitConsentDefault = structuredClone(original);
  implicitConsentDefault.operation.scalarNullability.consentRef = 'default-to-no-consent-reference';
  assert.throws(() => assertSubmissionGrammar(implicitConsentDefault, operation, familyBindings, journey, action),
    /deep-equal/u);

  const readBypass = structuredClone(original);
  readBypass.operation.reconciliationAuthority = 'processing-authority-is-required-for-receipt-read';
  assert.throws(() => assertSubmissionGrammar(readBypass, operation, familyBindings, journey, action),
    /read-only-branch/u);

  const conflictErasesHistory = structuredClone(original);
  conflictErasesHistory.operation.sameKeyDifferentFingerprint = 'conflict-proves-no-prior-request-exists';
  assert.throws(() => assertSubmissionGrammar(conflictErasesHistory, operation, familyBindings, journey, action),
    /does-not-erase-or-prove-absence/u);

  const blindReplay = structuredClone(original);
  blindReplay.operation.unknownOutcome = 'automatically-replay-the-submit-payload-after-timeout';
  assert.throws(() => assertSubmissionGrammar(blindReplay, operation, familyBindings, journey, action),
    /absent-expired-or-unavailable-evidence-never-proves-no-effect/u);

  const completionClaim = structuredClone(original);
  completionClaim.operation.acknowledgedOutcome = 'COMPLETED';
  assert.throws(() => assertSubmissionGrammar(completionClaim, operation, familyBindings, journey, action),
    /REQUEST_ACKNOWLEDGED/u);

  const newKeyRecovery = structuredClone(original);
  newKeyRecovery.operation.unknownOutcome = 'mint-a-new-requestId-after-a-lost-response';
  assert.throws(() => assertSubmissionGrammar(newKeyRecovery, operation, familyBindings, journey, action),
    /absent-expired-or-unavailable-evidence-never-proves-no-effect/u);
});

test('submission acknowledgement, job execution, and provider RPC interfaces remain separate', () => {
  const grammar = yaml(grammarPath).boundedTranscriptionSubmissionSlice;
  assert.match(grammar.operation.receiptMeaning, /logical-request-and-job-identity-only/u);
  assert.match(grammar.operation.asynchronousBoundary, /caption-approval-or-publication/u);
  assert.match(grammar.operation.observedChannels.httpSdkAgentToolGrpcEvents, /unresolved/u);
  assert.match(grammar.operation.observedChannels.httpSdkAgentToolGrpcEvents, /Transcribe-is-an-execution-interface-observation-not-this-submission-operation/u);
  assert.match(grammar.operation.observedChannels.httpSdkAgentToolGrpcEvents, /StreamTranscribe-and-SubmitCorrection-remain-distinct/u);
  assert.equal(grammar.runtimeAdmission, 'NOT_ADMITTED');
});
