const operationId = 'media.operation.transcript-version-read';
const objectId = 'media.domain.transcript-version';

const has = (value, pattern) => pattern.test(String(value ?? ''));

export function validateMediaTranscriptVersionDefinition({ domainObjects, operations, actionContracts }) {
  const issues = [];
  const add = (condition, message) => { if (!condition) issues.push(message); };
  const objects = new Map((domainObjects?.objects ?? []).map((record) => [record.id, record]));
  const legacy = objects.get('media.domain.transcription');
  const transcript = objects.get(objectId);
  const read = (operations?.operations ?? []).find((record) => record.id === operationId);

  add(Boolean(legacy), 'legacy media.domain.transcription boundary is missing');
  add(Boolean(transcript), `canonical ${objectId} identity is missing`);
  if (legacy) {
    add(has(legacy.canonicalBoundary, /legacy-transcription-UUID.*does-not-by-itself-establish-media\.domain\.transcript-version/u),
      'legacy transcription identifiers must not establish canonical transcript-version identity');
  }
  if (transcript) {
    add(transcript.name === 'TranscriptVersion' && transcript.kind === 'immutable-recognition-content-version',
      `${objectId} must remain a distinct immutable transcript-version concept`);
    add(has(transcript.identity, /trusted-tenantId-plus-opaque-transcriptVersionId.*identity-is-not-transcript-text-or-content-digest/u),
      `${objectId} identity must be tenant scoped, opaque, and distinct from content`);
    add(has(transcript.sourceLink, /exact-sourceArtifactId-and-sourceArtifactVersionId-in-the-same-tenant/u),
      `${objectId} must bind an exact tenant-scoped source artifact version`);
    add(has(transcript.content, /preserve-text-and-ordered-segments-only-when-supplied.*never-create-segments-from-text-or-join-segments-into-text/u),
      `${objectId} must preserve only supplied text and segments without synthesis`);
    add(has(transcript.language, /only-a-supplied-languageTag.*never-infer-language-or-confidence/u),
      `${objectId} must not infer language or confidence`);
    add(has(transcript.uncertainty, /only-supplied-confidence-alternatives-and-uncertainty-evidence.*not-calibrated-correctness-or-review-approval/u),
      `${objectId} must preserve uncertainty as unqualified source observations`);
    add(transcript.timing?.availabilityValues?.includes('NOT_SUPPLIED') &&
      transcript.timing.availabilityValues.includes('PROVIDER_TIME_UNQUALIFIED') &&
      transcript.timing.availabilityValues.includes('SOURCE_CLOCK_BOUND'),
      `${objectId} must distinguish absent, unqualified-provider, and source-clock-bound timing`);
    add(has(transcript.timing?.providerTime, /preserve-supplied-time-values-and-declared-unit-exactly.*unless-an-authoritative-source-clock-map-is-qualified/u),
      `${objectId} must preserve provider timing without inventing a source clock`);
    add(has(transcript.timing?.sourceClock, /sourceClockId-and-positive-safe-integer-ticksPerSecond.*only-when-authoritatively-bound.*sourceDurationTicks-is-preserved-only-when-supplied/u),
      `${objectId} must conditionally retain only authoritative clock metadata`);
    add(has(transcript.timing?.snapshotBoundary, /timingAvailability-describes-the-immutable-version-snapshot.*later-qualified-source-clock-map-is-separate-read-context-evidence.*does-not-retime-or-rewrite.*requires-a-new-transcriptVersionId/u),
      `${objectId} must keep later clock qualification separate from immutable provider-time observations`);
    add(has(transcript.timing?.rule, /missing-timing-does-not-block-read.*never-invent-clock-rate-duration-or-alignment/u),
      `${objectId} inspection must allow missing timing without inference`);
    add(has(transcript.captionParentUse, /registration-as-a-caption-parent-requires-same-exact-sourceArtifactId-sourceArtifactVersionId-and-authoritative-sourceClockId-positive-ticksPerSecond-and-sourceDurationTicks.*metadata-completeness-does-not-grant-current-write-authority/u),
      `${objectId} caption-parent use must require complete authoritative source metadata without granting write authority`);
    add(has(transcript.evidence, /only-supplied-provider-model-and-source-reference-metadata.*not-provider-qualification/u),
      `${objectId} must not convert provider metadata into qualification evidence`);
    add(has(transcript.materialization, /authoritative-version-producing-boundary.*not-automatically-canonical-version-identities.*no-qualified-producer-is-claimed/u),
      `${objectId} must not equate recognition output or legacy records with canonical materialization`);
    add(has(transcript.reviewBoundary, /not-caption-correction-caption-registration-review-approval-or-publication/u),
      `${objectId} inspection must not imply correction, registration, approval, or publication`);
    add(transcript.sourceRefs?.includes('libs/audio-video-types/src/contracts.ts#TranscriptionResult') &&
      transcript.sourceRefs.includes('modules/speech/stt-service/src/main/proto/stt_service.proto#TranscribeResponse-and-WordTiming') &&
      transcript.sourceRefs.includes('modules/infrastructure/persistence/src/main/java/com/ghatana/audio/video/infrastructure/persistence/entity/TranscriptionEntity.java'),
      `${objectId} must retain the exact typed, gRPC, and legacy persistence source observations`);
    add(has(transcript.scopeStatus, /runtime-NOT_ADMITTED/u), `${objectId} materialization/runtime must remain NOT_ADMITTED`);
    add(!Object.hasOwn(transcript, 'runtimeAdmission') && !Object.hasOwn(transcript, 'executionAdmission'),
      `${objectId} must not contain a native Lifecycle or execution-admission field`);
  }

  add(Boolean(read), `canonical operation ${operationId} is missing`);
  if (read) {
    add(read.family?.includes('inspect-transcript-version'), `${operationId} must retain its existing operation identity`);
    add(read.actionRefs?.includes('media.action.review-transcript'), `${operationId} must bind the existing review-transcript action`);
    add(JSON.stringify(read.inputSemantics?.requiredFields) === JSON.stringify(['transcriptVersionId']),
      `${operationId} must accept only the exact transcriptVersionId selector`);
    add(JSON.stringify(read.inputSemantics?.trustedHostFields) === JSON.stringify(['tenantId', 'principalId']),
      `${operationId} must take tenant/principal authority only from trusted host context`);
    add(has(read.inputSemantics?.selector, /exact-opaque-transcriptVersionId-only.*no-jobId-transcriptArtifactId-sourceArtifactId-latest-alias-or-global-list/u),
      `${operationId} must not add job, artifact, latest, or list aliases`);
    add(has(read.preconditions?.join(' '), /current-read-authority-for-transcript-and-linked-source/u),
      `${operationId} must check current scoped authority for the exact version`);
    add(has(read.inputSemantics?.authorization, /caller-supplied-tenant-or-principal-is-never-authority.*actor-role-labels-do-not-grant-access/u),
      `${operationId} must not accept client identity or actor labels as authority`);
    add(read.authority?.trustedIdentityAndDelegationOwner === '.product-experience/pdp-1-domain-data/authority.yaml#ownership.identityAuthenticationAndDelegation' &&
      read.authority?.currentTranscriptReadPolicyOwner === '.product-experience/pdp-0-product-truth/policy-authority-model.yaml#productPolicy',
      `${operationId} must point to the canonical identity and policy authority sources`);
    add(!has(read.preconditions?.join(' '), /timing-is-required|sourceClockId-is-required-for-read/u),
      `${operationId} must permit inspection when timing is not supplied`);
    const required = read.outputSemantics?.requiredFields ?? [];
    for (const field of ['transcriptVersionId', 'sourceArtifactId', 'sourceArtifactVersionId', 'textAvailability', 'segmentsAvailability', 'languageAvailability', 'uncertaintyAvailability', 'timingAvailability', 'sourceClockAvailability', 'evidenceAvailability', 'observedAt']) {
      add(required.includes(field), `${operationId} result is missing ${field}`);
    }
    add(read.outputSemantics?.timingAvailabilityValues?.includes('NOT_SUPPLIED') &&
      read.outputSemantics.timingAvailabilityValues.includes('PROVIDER_TIME_UNQUALIFIED') &&
      read.outputSemantics.timingAvailabilityValues.includes('SOURCE_CLOCK_BOUND'),
      `${operationId} must expose explicit timing availability`);
    add(has(read.outputSemantics?.providerTiming, /original-provider-unit-and-value.*not-source-clock-bound-without-qualified-mapping/u),
      `${operationId} must retain unqualified provider time distinctly`);
    add(has(read.outputSemantics?.sourceClockBoundRequires, /authoritative-sourceArtifactVersion-mapping.*positive-safe-integer-ticksPerSecond/u),
      `${operationId} must not assert source-clock binding without authoritative source mapping`);
    add(has(read.outputSemantics?.timingAvailabilityDescribes, /immutable-version-snapshot/u) &&
      has(read.outputSemantics?.clockMappingContext, /separate-read-context-evidence.*does-not-rewrite-or-retime-stored-provider-milliseconds/u),
      `${operationId} must distinguish immutable timing from separately resolved mapping evidence`);
    add(has(read.outputSemantics?.captionParentMetadata, /not-parent-eligibility.*sourceDurationTicks.*does-not-grant-current-caption-write-authority-rights-or-consent/u),
      `${operationId} may expose parent metadata but cannot grant caption-write authority`);
    add(has(read.outputSemantics?.incompleteFields, /explicit-availability-is-returned-per-field.*do-not-synthesize-text-segments-language-timing-confidence-speaker-or-source-clock/u),
      `${operationId} must expose partial data and prohibit inferred fields`);
    add(read.error?.includes('TRANSCRIPT_VERSION_NOT_FOUND_IN_CALLER_SCOPE') && read.error.includes('SOURCE_IDENTITY_MISMATCH') && read.error.includes('UNAVAILABLE'),
      `${operationId} must distinguish scope-safe absence, source-integrity mismatch, and unavailable reads`);
    add(has(read.failure, /scope-safe-not-found.*SOURCE_IDENTITY_MISMATCH.*UNAVAILABLE/u),
      `${operationId} failure semantics must preserve scoped absence and source-integrity distinctions`);
    add(has(read.finality, /read-only-observation.*does-not-correct-approve-register-a-caption-version-or-publish/u),
      `${operationId} must remain read-only and not imply approval/publication`);
    add(read.outputSemantics?.requiredFields?.every((field) => !/approval|qualityScore|calibrated/u.test(field)),
      `${operationId} must not present approval or calibrated quality as transcript output`);
    add(has(read.cancellation, /caller-may-stop-waiting.*no-server-side-version-effect-is-cancelled.*fresh-current-authorization/u),
      `${operationId} cancellation must mean local wait cancellation and fresh-authority reobservation only`);
    add(read.transition?.transitionRefs?.length === 0 && has(read.transition?.applicability, /no-domain-transition/u),
      `${operationId} must not define a domain transition`);
    add(read.scopeStatus?.includes('proposal-only') && read.scopeStatus.includes('runtime-NOT_ADMITTED'),
      `${operationId} must remain proposal-only and runtime NOT_ADMITTED`);
    add(!Object.hasOwn(read, 'runtimeAdmission') && !Object.hasOwn(read, 'executionAdmission'),
      `${operationId} must not contain a native Lifecycle or execution-admission field`);
  }

  const binding = actionContracts?.operationSliceBindings?.[operationId];
  add(binding?.actionIntentRefs?.includes('media.action.review-transcript'), `${operationId} action-contract binding is missing`);
  add(has(binding?.disposition, /read-one-exact-canonical-transcriptVersionId.*no-clock-inference-mutation-correction-approval-or-publication.*runtime-NOT_ADMITTED/u),
    `${operationId} action binding must retain exact-read and no-inference boundaries`);
  return issues;
}
