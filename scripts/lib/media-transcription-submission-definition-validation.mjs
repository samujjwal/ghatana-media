const operationId = 'media.operation.transcription-submission';
const has = (value, pattern) => pattern.test(String(value ?? ''));

export function validateMediaTranscriptionSubmissionDefinition({ operations, actionContracts }) {
  const issues = [];
  const op = (operations?.operations ?? []).find(({ id }) => id === operationId);
  const bindings = actionContracts?.operationSliceBindings ?? {};
  const add = (ok, message) => { if (!ok) issues.push(message); };

  add(Boolean(op), `${operationId} must remain the existing canonical operation`);
  if (!op) return issues;
  const input = op.inputSemantics ?? {};
  const output = op.outputSemantics ?? {};
  const fingerprint = input.requestFingerprint ?? {};

  add(JSON.stringify(op.family) === JSON.stringify(['submit-transcription-request']),
    'the existing submission family must remain the only family in this slice');
  add(JSON.stringify(op.actionRefs) === JSON.stringify(['media.action.request-transcription']),
    'submission must bind only the existing request-transcription action');
  add(JSON.stringify(input.selectorValues) === JSON.stringify(['SUBMIT_OR_REPLAY', 'RECONCILE']) &&
    input.selectorField === 'requestMode' && JSON.stringify(input.commonRequiredFields) === JSON.stringify(['requestMode']),
  'submission and same-operation reconciliation must be mutually exclusive requestMode branches');
  add(JSON.stringify(input.submitRequiredFields) === JSON.stringify([
    'requestId', 'sourceArtifactId', 'sourceArtifactVersionId', 'languageIntent', 'profileId', 'profileVersion', 'profileConfigurationDigest', 'purpose', 'consentRef', 'rightsEvidenceRef', 'retentionPolicyRef', 'processingLocation',
  ]) && JSON.stringify(input.reconcileRequiredFields) === JSON.stringify(['requestId', 'requestFingerprint']) &&
    JSON.stringify(input.commonAllowedFields) === JSON.stringify(['requestMode']) &&
    JSON.stringify(input.submitAllowedFields) === JSON.stringify(['requestMode', ...input.submitRequiredFields]) &&
    JSON.stringify(input.reconcileAllowedFields) === JSON.stringify(['requestMode', ...input.reconcileRequiredFields]) &&
    has(input.branchFieldRule, /exactly-the-allowedFields-for-selected-requestMode.*reject-unknown-branch-mixed-caller-identity-or-ignored-fields/u) &&
    has(input.submitReplayRule, /entire-submitRequiredFields-set.*never-replays-a-subset/u),
  'submit and reconcile branches must require their exact declared fields');
  add(has(input.immutableSource, /exact-immutable-audio-artifact-version.*authoritative-content-digest.*no-latest-alias/u),
    'the request must bind one exact immutable source and its authoritative content digest');
  add(JSON.stringify(input.languageIntent?.modes) === JSON.stringify(['EXPLICIT', 'AUTO_REQUESTED']) &&
    JSON.stringify(input.languageIntent?.EXPLICIT?.allowedFields) === JSON.stringify(['mode', 'languageTag']) &&
    JSON.stringify(input.languageIntent?.AUTO_REQUESTED?.allowedFields) === JSON.stringify(['mode']) &&
    has(input.languageIntent?.EXPLICIT?.rule, /exact-user-declared-language-tag.*validate-profile-support/u) &&
    has(input.languageIntent?.AUTO_REQUESTED?.rule, /explicit-user-request.*support-must-be-qualified.*not-inferred/u),
  'language intent must be explicit and profile support cannot be inferred');
  const nullability = input.scalarNullability ?? {};
  add(has(nullability.optionalDelegationRef, /absent-is-canonical-null.*nonempty-trusted-delegation-reference/u) &&
    has(nullability.consentRef, /explicit-null-only-when-current-authoritative-policy-says-consent-is-not-required/u) &&
    JSON.stringify(nullability.requiredNonemptyStrings) === JSON.stringify([
      'requestId', 'sourceArtifactId', 'sourceArtifactVersionId', 'profileId', 'profileVersion', 'purpose', 'rightsEvidenceRef', 'retentionPolicyRef', 'processingLocation',
    ]) && JSON.stringify(nullability.nonnullDigestFields) === JSON.stringify(['profileConfigurationDigest', 'authoritativeSourceContentDigest']) &&
    has(nullability.rightsEvidenceRef, /required-nonnull-locator-resolved-to-current-authoritative-rights-decision/u) &&
    has(nullability.reconcileRequestFingerprint, /required-nonnull-lowercase-64-hex-SHA256/u) &&
    has(nullability.noOtherNulls, /reject-null-for-required-fields.*no-defaulting-or-ignored-payload-fields/u),
  'scalar nullability must be explicit; required identities and resolved rights evidence cannot be absent or caller-invented');
  add(has(input.profileIdentity, /exact-profileId-profileVersion-and-profileConfigurationDigest.*current-authoritative-profile-evidence/u),
    'profile identity/configuration must be explicit and qualification evidence current');
  add(has(input.authorityReferences, /locators-or-intent-only.*authoritative-current-policy-owner/u),
    'caller references must not be treated as rights, consent, or policy grants');
  add(JSON.stringify(fingerprint.fields) === JSON.stringify([
    'tenantId', 'principalId', 'delegationRef', 'operationId', 'requestId', 'sourceArtifactId', 'sourceArtifactVersionId', 'authoritativeSourceContentDigest', 'languageIntent', 'profileId', 'profileVersion', 'profileConfigurationDigest', 'purpose', 'consentRef', 'rightsEvidenceRef', 'retentionPolicyRef', 'processingLocation',
  ]) && fingerprint.algorithm === 'SHA-256' && fingerprint.encoding === 'compact-UTF-8-JSON-array-no-whitespace-in-this-exact-field-order-with-JSON-string-escaping-and-explicit-null-or-value-presence' &&
    JSON.stringify(fingerprint.languageIntentEncoding?.EXPLICIT) === JSON.stringify(['EXPLICIT', 'exact-languageTag']) &&
    JSON.stringify(fingerprint.languageIntentEncoding?.AUTO_REQUESTED) === JSON.stringify(['AUTO_REQUESTED']) &&
    has(fingerprint.languageIntentEncoding?.rule, /fixed-ordered-tuples-never-an-unordered-object/u) &&
    has(fingerprint.scalarEncoding, /fixed-string-or-explicit-null-types-only.*lowercase-64-hex-SHA256/u) &&
    has(fingerprint.digestField, /lowercase-64-hex-SHA256/u) &&
    has(fingerprint.normalization, /preserve-exact-validated-string-values.*no-trimming-case-folding-default-insertion-or-map-order-dependence/u),
  'fingerprint must cover the exact full immutable request and trusted authority scope deterministically');
  add(has(input.submitSnapshot, /before-first-dispatch.*retains-the-complete-immutable-submit-field-snapshot-and-computed-fingerprint.*never-depend-on-a-server-returned-fingerprint/u) &&
    has(input.reconciliation, /read-only-selector-on-this-existing-operation.*current-scoped-receipt-read-authority.*missing-expired-or-unavailable.*UNKNOWN_OUTCOME/u),
  'host must retain the exact pre-dispatch request snapshot, and reconciliation must use current scoped read authority');
  add(JSON.stringify(op.context?.requestKeyScope) === JSON.stringify(['tenantId', 'principalId', 'operationId', 'requestId']) &&
    op.context?.callerCannotSupplyOrOverrideTrustedIdentity === true &&
    has(op.context?.submitAndReplayAuthority, /current-identity-delegation-rights-consent-purpose-region-retention-location-profile.*at-each-effect-boundary/u) &&
    has(op.context?.reconciliationReadAuthority, /current-authorized-read-of-the-same-tenant-principal-scoped-request-receipt.*no-provider-dispatch/u),
  'key scope, current effect authority, and distinct current receipt-read authority must be explicit');
  add(has(op.context?.receiptReadDenial, /scope-safe-UNKNOWN_OUTCOME.*without-disclosing-global-absence/u),
    'receipt lookup denial must not disclose global request existence');
  const preconditions = op.preconditions ?? {};
  add(preconditions.SUBMIT_OR_REPLAY?.some((condition) => condition.includes('current-rights-decision-verifies')) &&
    preconditions.SUBMIT_OR_REPLAY.some((condition) => condition.includes('current-consent-is-active')) &&
    preconditions.SUBMIT_OR_REPLAY.some((condition) => condition.includes('declared-purpose-retention-policy-and-processing-location')) &&
    preconditions.SUBMIT_OR_REPLAY.some((condition) => condition.includes('selected-profile-identity-version-and-configuration-digest')) &&
    preconditions.RECONCILE?.some((condition) => condition.includes('current-policy-authorizes-reading-this-exact-request-receipt')) &&
    preconditions.RECONCILE.some((condition) => condition.includes('no-provider-dispatch-or-effect-is-authorized')) &&
    !preconditions.RECONCILE.some((condition) => /processing-consent|current-consent|profile-identity|profile-qualification|profile-is-qualified|selected-profile/u.test(condition)),
  'submission effect gates and reconciliation read-only gates must be explicitly separate');
  add(has(op.authorization?.SUBMIT_OR_REPLAY, /current-trusted-tenant-principal-delegation-rights-consent-purpose.*each-effect-boundary/u) &&
    has(op.authorization?.RECONCILE, /authorized-read-of-only-the-same-scoped-receipt.*no-processing-consent-profile-or-provider-dispatch-authority/u),
  'branch authorization must not require processing authority for receipt-only reconciliation');
  add(output.acknowledgedOutcome === 'REQUEST_ACKNOWLEDGED' && JSON.stringify(output.acknowledgedFields) === JSON.stringify([
    'outcome', 'requestId', 'requestFingerprint', 'submissionReceiptId', 'jobId', 'acceptedAt', 'replayDisposition',
  ]) && JSON.stringify(output.replayDispositionValues) === JSON.stringify(['NEW_LOGICAL_REQUEST', 'SAME_REQUEST_REPLAY']),
  'acknowledgment must return a stable logical receipt/job identity and truthful replay disposition');
  add(has(output.receiptMeaning, /logical-request-only.*does-not-assert-a-job-state/u) &&
    output.completedRecognitionIsNotImplied === true && output.transcriptTextLanguageDetectionQualityOrCaptionApprovalIsNotImplied === true,
  'a submission receipt must not assert job state, recognition, quality, or approval');
  add(JSON.stringify(op.idempotency?.scope) === JSON.stringify(['tenantId', 'principalId', 'operationId', 'requestId']) &&
    has(op.idempotency?.sameKeySameFingerprint, /return-the-original-logical-jobId-and-submissionReceiptId/u) &&
    has(op.idempotency?.sameKeyDifferentFingerprint, /IDEMPOTENCY_CONFLICT.*without-overwriting-or-dispatching/u),
  'idempotent replay must return the original receipt only for the exact key and fingerprint');
  add(has(op.error?.distinctions, /definitive-pre-dispatch-rejection.*no-effect-was-accepted-for-the-current-attempt.*does-not-prove-no-prior-request/u) &&
    op.error?.nonterminalOrAmbiguousCodes?.includes('UNKNOWN_OUTCOME') &&
    has(op.error?.reconciliation, /absent-expired-or-incomplete.*never-proves-no-effect/u) &&
    has(op.error?.conflictScope, /different-fingerprint-attempt.*does-not-erase-or-prove-absence-of-an-earlier/u) &&
    has(op.error?.refusalScope, /current-attempt.*never-proves-that-no-prior-request-exists/u),
  'definitive no-effect rejection must remain distinct from ambiguous dispatch and missing reconciliation evidence');
  add(has(op.unknownOutcome, /RECONCILE-same-requestId-and-full-requestFingerprint.*missing-expired-or-nonterminal/u) &&
    has(op.retry, /no-automatic-submit-replay-after-unknown.*new-fenced-attempt/u),
  'unknown results must require same-key reconciliation and never trigger blind command replay');
  add(has(op.cancellation, /existing-job-lifecycle.*does-not-confirm-stop-or-reverse/u),
    'submission acknowledgement must not be reversed or cancelled by observation alone');
  add(has(op.reversibility, /no-effect-claim.*current-attempt.*RECONCILE-is-read-only/u),
    'reversibility and no-effect statements must be scoped to the current submit attempt');
  add(op.transition?.transitionRefs?.length === 0 && has(op.transition?.applicability, /no-job-state-or-attempt-transition-is-accepted/u),
    'submission must not imply or invent a job/attempt state transition');
  add(has(op.scopeStatus, /file-audio-submission-definition-only.*runtime-NOT_ADMITTED.*stream-and-correction-remain-outside/u),
    'definition must remain file-audio scoped, unadmitted, and separate from streaming/correction');
  add(bindings[operationId]?.actionIntentRefs?.includes('media.action.request-transcription') &&
    has(bindings[operationId]?.disposition, /exact-artifact-version.*runtime-NOT_ADMITTED/u),
  'action contract must bind the existing action without claiming runtime admission');
  add(actionContracts?.operationFamilyBindings?.[operationId] === 'request-acknowledged-denied-conflict-unavailable-unknown-outcome',
    'allowed submission outcomes must exclude processing or recognition completion');
  return issues;
}
