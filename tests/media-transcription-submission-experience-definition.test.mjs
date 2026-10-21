import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolveExperienceDefinitionSemantics } from '../scripts/lib/media-experience-definition-mapping.mjs';

const root = '.product-experience/pdp-3-product-experience';
const { parse } = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url))('yaml');
const yaml = async (path) => parse(await readFile(path, 'utf8'));
const [journey, registry, bindings, screen, operations, grammar, journeyRegistry, taxonomy] = await Promise.all([
  yaml(`${root}/journey-contracts/transcribe-and-correct-captions.yaml`),
  yaml(`${root}/action-registry.yaml`),
  yaml(`${root}/experience-source-bindings.yaml`),
  yaml(`${root}/screen-contracts/transcription-progress.yaml`),
  yaml('.product-experience/pdp-1-domain-data/operations.yaml'),
  yaml('.product-experience/pdp-2-design-interface-system/action-finality-grammar.yaml'),
  yaml(`${root}/journey-registry.yaml`),
  yaml(`${root}/public-effect-finality-taxonomy.yaml`),
]);
const selected = journey.steps.find(({ stepId }) => stepId === 'J03-2');
const action = registry.actions.find(({ id }) => id === 'media.action.request-transcription');
const operation = operations.operations.find(({ id }) => id === 'media.operation.transcription-submission');
const binding = bindings.j03TranscriptionSubmissionBindings;
const sourceDecision = '.product-experience/decision-log.md#PXD-070';
const grammarDecision = '.product-experience/decision-log.md#PXD-071';
const reviewDecision = '.product-experience/decision-log.md#PXD-159';
const actionReviewDecision = '.product-experience/decision-log.md#PXD-072';

function validateSelected(value, actionRecord = action) {
  assert.equal(value.stepId, 'J03-2');
  assert.equal(value.action, 'media.action.request-transcription');
  assert.equal(value.canonicalOperationRef, 'media.operation.transcription-submission');
  assert.deepEqual(value.requiredOperationRefs, ['media.operation.transcription-submission']);
  assert.equal(value.decisionRef, reviewDecision);
  assert.equal(value.transitionDisposition.decisionRef, reviewDecision);
  assert.equal(value.sourceDecisionRef, sourceDecision);
  assert.equal(value.grammarDecisionRef, grammarDecision);
  assert.deepEqual(value.stateRefs, []);
  assert.equal(value.transitionDisposition.status, 'NOT_APPLICABLE_WITH_REASON');
  assert.equal(value.transitionDisposition.transitionRef, null);
  assert.equal(value.definitionVerification.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(actionRecord.actionDefinitionSemantics.operationRef, 'media.operation.transcription-submission');
  assert.equal(actionRecord.actionDefinitionSemantics.reviewDecisionRef, actionReviewDecision,
    'the action-definition lineage remains under PXD-072');
  assert.equal(actionRecord.actionDefinitionSemantics.effectKind, 'REQUEST_ACCEPTANCE');
  assert.equal(actionRecord.actionDefinitionSemantics.reversibility.kind, 'UNKNOWN');
  assert.equal(actionRecord.actionDefinitionSemantics.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(actionRecord.actionDefinitionSemantics.publicEffect, undefined);
  assert.equal(actionRecord.actionDefinitionSemantics.publicFinality, undefined);
  const projection = resolveExperienceDefinitionSemantics([actionRecord], [], taxonomy);
  const effect = projection.effects.find(({ id }) => id === 'media.public-taxonomy.request-transcription.effect');
  const finality = projection.finality.find(({ id }) => id === 'media.public-taxonomy.request-transcription.finality');
  assert.equal(effect?.reversibilityDisposition, 'UNKNOWN');
  assert.equal(finality?.undoabilityDisposition, 'UNKNOWN');
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

test('request snapshot, scoped key, profile, language, receipt, and reconciliation match P1/P2/P3', () => {
  const p1 = operation.inputSemantics;
  const p2 = grammar.boundedTranscriptionSubmissionSlice;
  const p2Operation = p2.operation;
  const p3 = selected.submissionSemantics;
  const sourceBinding = binding.steps[0];
  const expectedSubmit = p1.submitRequiredFields;
  const expectedFingerprint = p1.requestFingerprint.fields;
  const expectedContextPreservation = [
    'tenantId', 'principalId', 'delegationRef', 'operationId', 'requestId', 'requestFingerprint',
    'sourceArtifactId', 'sourceArtifactVersionId', 'authoritativeSourceContentDigest', 'languageIntent',
    'profileId', 'profileVersion', 'profileConfigurationDigest', 'timestamps', 'speakerDiarization',
    'purposeRef', 'rightsEvidenceRefs', 'consentRef', 'retentionPolicyRef', 'policyDecisionRef',
    'resolvedProcessingLocation', 'submissionReceiptId', 'jobId',
  ];

  assert.deepEqual(p2Operation.submitFields, expectedSubmit);
  assert.deepEqual(p2Operation.submitAllowedFields, p1.submitAllowedFields);
  assert.deepEqual(p2Operation.reconcileFields, p1.reconcileRequiredFields);
  assert.deepEqual(p2Operation.reconcileAllowedFields, p1.reconcileAllowedFields);
  assert.deepEqual(p2Operation.requestFingerprint, p1.requestFingerprint);
  assert.deepEqual(p2Operation.scalarNullability, p1.scalarNullability);

  assert.deepEqual(p3.submitRequiredFields, expectedSubmit);
  assert.deepEqual(p3.submitAllowedFields, p1.submitAllowedFields);
  assert.ok(p1.submitAllowedFields.includes('customGlossaryRef'));
  assert.ok(p1.submitAllowedFields.includes('fillerRetakeCandidates'));
  assert.deepEqual(p3.commonRequiredFields, p1.commonRequiredFields);
  assert.deepEqual(p3.commonAllowedFields, p1.commonAllowedFields);
  assert.deepEqual(p3.reconcileRequiredFields, p1.reconcileRequiredFields);
  assert.deepEqual(p3.reconcileAllowedFields, p1.reconcileAllowedFields);
  assert.equal(p3.branchFieldRule, p1.branchFieldRule);
  assert.deepEqual(selected.contextPreservation, expectedContextPreservation);
  assert.deepEqual(selected.stepDefinitionSemantics.stepSourceFacts.contextPreservation, expectedContextPreservation);
  assert.deepEqual(p3.requestFingerprint.binds, expectedFingerprint);
  assert.equal(p3.requestFingerprint.version, p1.requestFingerprint.version);
  assert.deepEqual(p3.requestFingerprint.optionalFieldEncoding, p1.requestFingerprint.optionalFieldEncoding);
  assert.equal(p3.requestFingerprint.encoding, p1.requestFingerprint.encoding);
  assert.deepEqual(p3.requestFingerprint.languageIntentEncoding, p1.requestFingerprint.languageIntentEncoding);
  assert.deepEqual(p3.requestFingerprint.scalarEncoding, p1.requestFingerprint.scalarEncoding);
  assert.equal(p3.requestFingerprint.normalization, p1.requestFingerprint.normalization);
  assert.deepEqual(p3.scalarNullability, p1.scalarNullability);
  assert.deepEqual(p3.requestResolution, p2Operation.requestResolution);
  assert.equal(p3.fingerprintValueSource, p2Operation.fingerprintValueSource);
  assert.deepEqual(p3.policyFields, p2Operation.policyFields);
  assert.deepEqual(p3.optionalReferenceWireFields, p2Operation.optionalReferenceWireFields);
  assert.equal(p3.callerNullRule, p2Operation.callerNullRule);
  assert.equal(p3.profilePreconstructionBoundary, p2Operation.profilePreconstructionBoundary);

  assert.deepEqual(sourceBinding.submitRequiredFields, expectedSubmit);
  assert.deepEqual(sourceBinding.submitAllowedFields, p1.submitAllowedFields);
  assert.equal(sourceBinding.submitAllowedFieldsSourceRef, '.product-experience/pdp-1-domain-data/operations.yaml#operations/@id=media.operation.transcription-submission/inputSemantics/submitAllowedFields');
  assert.deepEqual(sourceBinding.commonRequiredFields, p1.commonRequiredFields);
  assert.deepEqual(sourceBinding.commonAllowedFields, p1.commonAllowedFields);
  assert.deepEqual(sourceBinding.reconcileRequiredFields, p1.reconcileRequiredFields);
  assert.deepEqual(sourceBinding.reconcileAllowedFields, p1.reconcileAllowedFields);
  assert.deepEqual(sourceBinding.requestResolution, p2Operation.requestResolution);
  assert.equal(sourceBinding.fingerprintValueSource, p2Operation.fingerprintValueSource);
  assert.deepEqual(sourceBinding.fingerprintFields, expectedFingerprint);
  assert.equal(sourceBinding.fingerprintVersion, p1.requestFingerprint.version);
  assert.equal(sourceBinding.fingerprintEncoding, p1.requestFingerprint.encoding);
  assert.equal(sourceBinding.fingerprintScalarEncoding, p1.requestFingerprint.scalarEncoding);
  assert.equal(sourceBinding.fingerprintNormalization, p1.requestFingerprint.normalization);
  assert.deepEqual(sourceBinding.scalarNullability, p1.scalarNullability);
  assert.deepEqual(sourceBinding.policyFields, p2Operation.policyFields);
  assert.deepEqual(sourceBinding.optionalReferenceWireFields, p2Operation.optionalReferenceWireFields);
  assert.equal(sourceBinding.callerNullRule, p2Operation.callerNullRule);
  assert.equal(sourceBinding.profilePreconstructionBoundary, p2Operation.profilePreconstructionBoundary);

  assert.deepEqual(p1.languageIntent.EXPLICIT.allowedFields, p3.languageIntent.variants.EXPLICIT.allowedFields);
  assert.deepEqual(p1.languageIntent.AUTO_REQUESTED.allowedFields, p3.languageIntent.variants.AUTO_REQUESTED.allowedFields);
  assert.match(p3.scalarNullability.consentRef, /canonical-null-only-when-current-authoritative-policy-says-consent-is-not-required/u);
  assert.match(p3.scalarNullability.rightsEvidenceRefs, /nonempty-exact-reference-array/u);
  assert.match(p3.callerNullRule, /caller-supplied-null-is-rejected/u);
  assert.match(p3.profilePreconstructionBoundary, /returns-UNSUPPORTED_PROFILE-before-operation-request-job-receipt-or-dispatch-construction/u);
  assert.match(p3.profilePreconstructionBoundary, /never-default-or-reinterpret-absence-as-AUTO_REQUESTED/u);
  assert.match(p3.requestFingerprint.replay, /owner-resolved optional authority values, resolved processing location/u);
  assert.match(p3.reconciliation, /separately rechecked current scoped receipt-read authority/u);
  assert.match(p3.reconciliation, /after processing authority revocation/u);
  assert.match(p3.reconciliation, /absence\/expiry\/unavailability never proves no effect/u);
  assert.match(p3.retries, /no blind replay, no new key/u);
  assert.deepEqual(p3.acknowledgedFields, operation.outputSemantics.acknowledgedFields);
  assert.deepEqual(p3.unknownFields, operation.outputSemantics.unknownFields);
  assert.equal(p2.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(binding.runtimeAdmission, 'NOT_ADMITTED');
});

test('the screen preserves the selected submission consequence and keeps every bound action not admitted', () => {
  const request = screen.actionConsequences.find(({ actionId }) => actionId === 'media.action.request-transcription');
  const status = screen.actionConsequences.find(({ actionId }) => actionId === 'media.action.view-job-status');
  const cancellation = screen.actionConsequences.find(({ actionId }) => actionId === 'media.action.request-cancellation');
  assert.equal(request.operationRef, 'media.operation.transcription-submission');
  assert.equal(request.consequence, 'submit-one-logical-transcription-request-for-the-exact-source-version');
  assert.match(request.finality, /stable-submission-receipt-and-logical-job-identity-only/u);
  assert.match(request.finality, /no-job-state-or-recognition-finality/u);
  assert.equal(request.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(request.bindingStatus, 'source-definition-exact; screen-admission-pending; runtime-NOT_ADMITTED');
  assert.equal(status.operationRef, 'media.operation.action.view-job-status');
  assert.equal(status.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(cancellation.operationRef, 'media.operation-slice.cancel-job');
  assert.equal(cancellation.runtimeAdmission, 'NOT_ADMITTED');
  assert.match(screen.exit.join(' '), /never-submit-duplicate-on-unknown/u);
  assert.match(screen.exit.join(' '), /no-job-state-or-recognition-finality/u);
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
  const wrongFingerprintVersion = structuredClone(selected.submissionSemantics);
  wrongFingerprintVersion.requestFingerprint.version = 'media.transcription-submission-fingerprint.v1';
  assert.throws(() => assert.equal(wrongFingerprintVersion.requestFingerprint.version, operation.inputSemantics.requestFingerprint.version), /Expected values/u);
  const wrongFingerprintField = structuredClone(selected.submissionSemantics);
  wrongFingerprintField.requestFingerprint.binds.push('processingLocation');
  assert.throws(() => assert.deepEqual(wrongFingerprintField.requestFingerprint.binds, operation.inputSemantics.requestFingerprint.fields), /Expected values|deepStrictEqual/u);
  const nullableLocator = structuredClone(selected.submissionSemantics);
  nullableLocator.callerNullRule = 'optional-wire-reference-fields-may-be-null';
  assert.throws(() => assert.equal(nullableLocator.callerNullRule, grammar.boundedTranscriptionSubmissionSlice.operation.callerNullRule), /Expected values/u);
  const defaultedProfile = structuredClone(selected.submissionSemantics);
  defaultedProfile.profilePreconstructionBoundary = 'absence-defaults-to-AUTO_REQUESTED';
  assert.throws(() => assert.equal(defaultedProfile.profilePreconstructionBoundary, grammar.boundedTranscriptionSubmissionSlice.operation.profilePreconstructionBoundary), /Expected values/u);
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
  assert.equal(registry.actions.length, 147);
  assert.equal(journeyRegistry.coverageObservation.stepBindings.verification.notRun, 130);
  assert.equal(journeyRegistry.coverageObservation.stepBindings.verification.evidenceRefsPresent, 0);
  assert.equal(journeyRegistry.coverageObservation.stepBindings.verification.sourceDefinitionCheckedSteps, 6);
  assert.equal(journeyRegistry.j03TranscriptionSubmissionDefinitionObservation.existingStepsWithBoundedDefinition, 1);
  assert.equal(journeyRegistry.j03TranscriptionSubmissionDefinitionObservation.transitionReferences, 0);
});
