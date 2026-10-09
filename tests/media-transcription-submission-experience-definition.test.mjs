import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolveExperienceDefinitionSemantics } from '../scripts/lib/media-experience-definition-mapping.mjs';

const root = '.product-experience/pdp-3-product-experience';
const { parse } = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url))('yaml');
const yaml = async (path) => parse(await readFile(path, 'utf8'));
const [journey, registry, bindings, screen, operations, grammar, journeyRegistry] = await Promise.all([
  yaml(`${root}/journey-contracts/transcribe-and-correct-captions.yaml`),
  yaml(`${root}/action-registry.yaml`),
  yaml(`${root}/experience-source-bindings.yaml`),
  yaml(`${root}/screen-contracts/transcription-progress.yaml`),
  yaml('.product-experience/pdp-1-domain-data/operations.yaml'),
  yaml('.product-experience/pdp-2-design-interface-system/action-finality-grammar.yaml'),
  yaml(`${root}/journey-registry.yaml`),
]);
const selected = journey.steps.find(({ stepId }) => stepId === 'J03-2');
const action = registry.actions.find(({ id }) => id === 'media.action.request-transcription');
const operation = operations.operations.find(({ id }) => id === 'media.operation.transcription-submission');
const binding = bindings.j03TranscriptionSubmissionBindings;
const sourceDecision = '.product-experience/decision-log.md#PXD-070';
const grammarDecision = '.product-experience/decision-log.md#PXD-071';
const reviewDecision = '.product-experience/decision-log.md#PXD-072';

function validateSelected(value, actionRecord = action) {
  assert.equal(value.stepId, 'J03-2');
  assert.equal(value.action, 'media.action.request-transcription');
  assert.equal(value.canonicalOperationRef, 'media.operation.transcription-submission');
  assert.deepEqual(value.requiredOperationRefs, ['media.operation.transcription-submission']);
  assert.equal(value.decisionRef, reviewDecision);
  assert.equal(value.sourceDecisionRef, sourceDecision);
  assert.equal(value.grammarDecisionRef, grammarDecision);
  assert.deepEqual(value.stateRefs, []);
  assert.equal(value.transitionDisposition.status, 'NOT_APPLICABLE_WITH_REASON');
  assert.equal(value.transitionDisposition.transitionRef, null);
  assert.equal(value.definitionVerification.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(actionRecord.actionDefinitionSemantics.operationRef, 'media.operation.transcription-submission');
  assert.equal(actionRecord.actionDefinitionSemantics.effectKind, 'REQUEST_ACCEPTANCE');
  assert.equal(actionRecord.actionDefinitionSemantics.reversibility.kind, 'UNKNOWN');
  assert.equal(actionRecord.actionDefinitionSemantics.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(actionRecord.actionDefinitionSemantics.publicEffect, undefined);
  assert.equal(actionRecord.actionDefinitionSemantics.publicFinality, undefined);
  assert.equal(resolveExperienceDefinitionSemantics([actionRecord], []).effects.length, 0);
}

test('J03-2 binds only the existing audio transcription-submission identity', async () => {
  assert.equal(journey.journeyId, 'J-03');
  assert.equal(journey.steps.length, 8);
  validateSelected(selected);
  assert.deepEqual(selected.objectRefs, ['media.domain.artifact-version', 'media.domain.processing-job']);
  assert.deepEqual(selected.handoffRef.preserves, ['sourceArtifactId', 'sourceArtifactVersionId']);
  assert.equal(selected.handoffRef.fromStepId, 'J03-1');
  assert.match(selected.handoffRef.admission, /source-selection-validity-remains-unresolved/u);
  assert.equal(binding.status, 'SOURCE_DEFINED_OWNER_ACCEPTED');
  assert.equal(binding.runtimeAdmission, 'NOT_ADMITTED');
  assert.deepEqual(binding.steps.map(({ stepId }) => stepId), ['J03-2']);
  assert.equal(binding.steps[0].operationRef, 'media.operation.transcription-submission');
  assert.deepEqual(binding.steps[0].stateRefs, []);
});

test('request snapshot, scoped key, profile, language, receipt, and reconciliation match PDP1/PDP2', () => {
  const expectedSubmit = ['requestId', 'sourceArtifactId', 'sourceArtifactVersionId', 'languageIntent', 'profileId', 'profileVersion', 'profileConfigurationDigest', 'purpose', 'consentRef', 'rightsEvidenceRef', 'retentionPolicyRef', 'processingLocation'];
  const expectedFingerprint = ['tenantId', 'principalId', 'delegationRef', 'operationId', 'requestId', 'sourceArtifactId', 'sourceArtifactVersionId', 'authoritativeSourceContentDigest', 'languageIntent', 'profileId', 'profileVersion', 'profileConfigurationDigest', 'purpose', 'consentRef', 'rightsEvidenceRef', 'retentionPolicyRef', 'processingLocation'];
  assert.deepEqual(selected.submissionSemantics.submitRequiredFields, expectedSubmit);
  assert.deepEqual(operation.inputSemantics.submitRequiredFields, expectedSubmit);
  assert.deepEqual(selected.submissionSemantics.commonRequiredFields, ['requestMode']);
  assert.deepEqual(selected.submissionSemantics.commonAllowedFields, ['requestMode']);
  assert.deepEqual(selected.submissionSemantics.submitAllowedFields, operation.inputSemantics.submitAllowedFields);
  assert.deepEqual(selected.submissionSemantics.reconcileAllowedFields, operation.inputSemantics.reconcileAllowedFields);
  assert.equal(selected.submissionSemantics.branchFieldRule, operation.inputSemantics.branchFieldRule);
  assert.deepEqual(selected.submissionSemantics.reconcileRequiredFields, ['requestId', 'requestFingerprint']);
  assert.deepEqual(selected.submissionSemantics.requestFingerprint.binds, expectedFingerprint);
  assert.deepEqual(operation.inputSemantics.requestFingerprint.fields, expectedFingerprint);
  assert.equal(selected.submissionSemantics.requestFingerprint.version, 'media.transcription-submission-fingerprint.v1');
  assert.deepEqual(operation.inputSemantics.requestFingerprint.languageIntentEncoding.EXPLICIT, ['EXPLICIT', 'exact-languageTag']);
  assert.deepEqual(operation.inputSemantics.requestFingerprint.languageIntentEncoding.AUTO_REQUESTED, ['AUTO_REQUESTED']);
  assert.deepEqual(selected.submissionSemantics.languageIntent.variants.EXPLICIT.allowedFields, operation.inputSemantics.languageIntent.EXPLICIT.allowedFields);
  assert.deepEqual(selected.submissionSemantics.languageIntent.variants.AUTO_REQUESTED.allowedFields, operation.inputSemantics.languageIntent.AUTO_REQUESTED.allowedFields);
  assert.match(selected.submissionSemantics.scalarNullability.consentRef, /explicit-null-only/u);
  assert.match(selected.submissionSemantics.scalarNullability.rightsEvidenceRef, /required-nonnull-locator-resolved-to-current-authoritative-rights-decision/u);
  assert.match(selected.submissionSemantics.scalarNullability.reconcileRequestFingerprint, /required-nonnull-lowercase-64-hex-SHA256/u);
  assert.match(selected.submissionSemantics.requestFingerprint.encoding, /fixed ordered tuples/u);
  assert.match(selected.submissionSemantics.requestFingerprint.replay, /retain the complete validated canonical submit snapshot/u);
  assert.deepEqual(selected.submissionSemantics.acknowledgedFields, operation.outputSemantics.acknowledgedFields);
  assert.deepEqual(selected.submissionSemantics.unknownFields, operation.outputSemantics.unknownFields);
  assert.match(selected.submissionSemantics.asynchronousBoundary, /no job state, provider execution, recognition completion/u);
  assert.match(selected.submissionSemantics.reconciliation, /separately rechecked current scoped receipt-read authority/u);
  assert.match(selected.submissionSemantics.reconciliation, /after processing authority revocation/u);
  assert.match(selected.submissionSemantics.reconciliation, /absence\/expiry\/unavailability never proves no effect/u);
  assert.match(selected.submissionSemantics.retries, /no blind replay, no new key/u);
  assert.deepEqual(binding.steps[0].submitRequiredFields, expectedSubmit);
  assert.deepEqual(binding.steps[0].submitAllowedFields, operation.inputSemantics.submitAllowedFields);
  assert.deepEqual(binding.steps[0].reconcileAllowedFields, operation.inputSemantics.reconcileAllowedFields);
  assert.deepEqual(binding.steps[0].fingerprintFields, expectedFingerprint);
  assert.deepEqual(grammar.boundedTranscriptionSubmissionSlice.operation.submitFields, expectedSubmit);
  assert.deepEqual(grammar.boundedTranscriptionSubmissionSlice.operation.requestFingerprint.fields, expectedFingerprint);
  assert.equal(grammar.boundedTranscriptionSubmissionSlice.runtimeAdmission, 'NOT_ADMITTED');
});

test('the screen consequence presents the receipt without promising state and leaves status/cancellation unresolved', () => {
  const request = screen.actionConsequences.find(({ actionId }) => actionId === 'media.action.request-transcription');
  const status = screen.actionConsequences.find(({ actionId }) => actionId === 'media.action.view-job-status');
  const cancellation = screen.actionConsequences.find(({ actionId }) => actionId === 'media.action.request-cancellation');
  assert.equal(request.operationRef, 'media.operation.transcription-submission');
  assert.match(request.consequence, /submission receipt only/u);
  assert.match(request.consequence, /no current job state or recognition completion/u);
  assert.equal(request.bindingStatus, 'SOURCE_DEFINED_OWNER_ACCEPTED under PXD-072; runtime-and-screen-admission-pending');
  assert.equal(status.operationRef, null);
  assert.equal(cancellation.operationRef, null);
  assert.match(screen.entry.join(' '), /reconcile the same requestId and full fingerprint/u);
  assert.match(screen.entry.join(' '), /revoked processing permission blocks replay/u);
  assert.match(screen.entry.join(' '), /no blind replay or new key/u);
  assert.match(screen.operationRefsBindingStatus, /other job actions remain unresolved/u);
});

test('negative mutations reject wrong IDs, broadened effects, status edges, and false admission', () => {
  const wrongOperation = structuredClone(selected);
  wrongOperation.canonicalOperationRef = 'media.operation.job-lifecycle';
  assert.throws(() => validateSelected(wrongOperation), /transcription-submission/u);
  const wrongAction = structuredClone(selected);
  wrongAction.action = 'media.action.view-job-status';
  assert.throws(() => validateSelected(wrongAction), /request-transcription/u);
  const admitted = structuredClone(selected);
  admitted.definitionVerification.runtimeAdmission = 'ADMITTED';
  assert.throws(() => validateSelected(admitted), /NOT_ADMITTED/u);
  const mixedBranch = structuredClone(selected.submissionSemantics);
  mixedBranch.submitAllowedFields.push('requestFingerprint');
  assert.notDeepEqual(mixedBranch.submitAllowedFields, operation.inputSemantics.submitAllowedFields);
  const callerIdentity = structuredClone(selected.submissionSemantics);
  callerIdentity.submitAllowedFields.push('principalId');
  assert.notDeepEqual(callerIdentity.submitAllowedFields, operation.inputSemantics.submitAllowedFields);
  const publicFinality = structuredClone(action);
  publicFinality.actionDefinitionSemantics.publicFinality = { undoable: false };
  assert.throws(() => validateSelected(selected, publicFinality), /Expected values|publicFinality/u);
  const fakeState = structuredClone(selected);
  fakeState.result = 'REQUEST_ACKNOWLEDGED; job state QUEUED';
  assert.match(fakeState.result, /job state QUEUED/u);
  assert.doesNotMatch(operation.outputSemantics.receiptMeaning, /QUEUED|RUNNING/u);
});

test('J03 submission definition changes no journey, step, action, or runtime-evidence population', async () => {
  const files = (await readdir(`${root}/journey-contracts`)).filter((name) => name.endsWith('.yaml'));
  let steps = 0;
  for (const file of files) steps += (await yaml(`${root}/journey-contracts/${file}`)).steps.length;
  assert.equal(files.length, 30);
  assert.equal(steps, 130);
  assert.equal(registry.actions.length, 146);
  assert.equal(journeyRegistry.coverageObservation.stepBindings.verification.notRun, 130);
  assert.equal(journeyRegistry.coverageObservation.stepBindings.verification.evidenceRefsPresent, 0);
  assert.equal(journeyRegistry.coverageObservation.stepBindings.verification.sourceDefinitionCheckedSteps, 6);
  assert.equal(journeyRegistry.j03TranscriptionSubmissionDefinitionObservation.existingStepsWithBoundedDefinition, 1);
  assert.equal(journeyRegistry.j03TranscriptionSubmissionDefinitionObservation.transitionReferences, 0);
});
