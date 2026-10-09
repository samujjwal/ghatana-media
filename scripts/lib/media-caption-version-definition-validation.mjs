const writeId = 'media.operation.caption-version-write';
const readId = 'media.operation.caption-version-read';

const has = (text, pattern) => pattern.test(String(text ?? ''));

export function validateMediaCaptionVersionDefinitions({ operations, domainObjects, actionContracts }) {
  const issues = [];
  const operationById = new Map((operations?.operations ?? []).map((record) => [record.id, record]));
  const captionVersion = domainObjects?.objects?.find(({ id }) => id === 'media.domain.caption-version');
  const write = operationById.get(writeId);
  const read = operationById.get(readId);
  const add = (condition, message) => { if (!condition) issues.push(message); };

  add(Boolean(captionVersion), 'canonical media.domain.caption-version identity is missing');
  if (captionVersion) {
    add(has(captionVersion.identity, /tenantId.*sourceArtifactId.*sourceArtifactVersionId.*captionVersionId/u),
      'caption version identity must include tenant, exact source artifact/version, and opaque version ID');
    add(has(captionVersion.lifecycle, /append-only-immutable-after-registration/u),
      'caption versions must be append-only and immutable after registration');
    add(has(captionVersion.lineage, /typed-parent-ref.*TRANSCRIPT_VERSION.*CAPTION_VERSION/u),
      'caption lineage must distinguish exact transcript and caption parent identities');
    add(has(captionVersion.canonicalParentRequirement, /authoritative-canonical-transcript-version-identity.*legacy-media\.domain\.transcription-UUID.*not-equivalent/u),
      'canonical transcript parent identity must not be inferred from the legacy transcription UUID or fixture parent');
    add(has(captionVersion.timing, /sourceClockId.*ticksPerSecond.*never-convert/u),
      'caption timing must retain the exact source clock and units without implicit conversion');
    add(has(captionVersion.registrationBoundary, /do-not-mean-reviewed-approved-delivered-or-published/u),
      'version registration must remain distinct from review, approval, delivery, and publication');
    add(has(captionVersion.scopeStatus, /runtime-NOT_ADMITTED/u), 'caption-version runtime admission must remain NOT_ADMITTED');
  }

  for (const record of [write, read].filter(Boolean)) {
    add(record.ownerDefinitionRef === '.product-experience/decision-log.md#PXD-058', `${record.id} must have the exact bounded owner decision`);
    add(record.executionAdmission === undefined || record.executionAdmission === 'NOT_ADMITTED', `${record.id} cannot forge execution admission`);
  }
  add(Boolean(write), `canonical operation ${writeId} is missing`);
  if (write) {
    add(write.family?.includes('save-caption-version'), `${writeId} must retain its existing operation identity`);
    add(write.actionRefs?.includes('media.action.save-caption-version'), `${writeId} must bind the existing save action`);
    add(write.inputSemantics?.requiredFields?.includes('sourceArtifactId') && write.inputSemantics.requiredFields.includes('sourceArtifactVersionId'),
      `${writeId} must bind both source artifact and exact source version`);
    add(write.inputSemantics?.requiredFields?.includes('parentVersionKind') && write.inputSemantics.requiredFields.includes('parentVersionId'),
      `${writeId} must bind the typed exact parent version`);
    add(write.inputSemantics?.parentVersionKindValues?.includes('TRANSCRIPT_VERSION') && write.inputSemantics.parentVersionKindValues.includes('CAPTION_VERSION'),
      `${writeId} must distinguish transcript and caption parent namespaces`);
    add(has(write.canonicalParentRequirement, /authoritative-canonical-transcript-version-identity.*legacy-media\.domain\.transcription-UUID-and-synthetic-fixture-parentVersionId-are-not-equivalent/u),
      `${writeId} must reject legacy or synthetic IDs as proof of a canonical transcript parent`);
    add(write.inputSemantics?.requiredFields?.includes('requestId'), `${writeId} must require a replay identity`);
    add(write.inputSemantics?.requiredFields?.includes('captionSegments') && write.inputSemantics.segmentFields?.includes('startTick') && write.inputSemantics.segmentFields.includes('endTick'),
      `${writeId} must snapshot ordered text and both source-tick endpoints`);
    add(has(write.inputSemantics?.ticks, /positive-safe-integer.*endTick.*sourceDurationTicks.*no-rescaling/u),
      `${writeId} must reject invalid source-time ranges without implicit unit conversion`);
    const fingerprint = write.requestFingerprintDefinition;
    const tupleFields = ['versionTag', 'tenantId', 'principalId', 'sourceArtifactId', 'sourceArtifactVersionId', 'parentVersionKind', 'parentVersionId', 'sourceClockId', 'ticksPerSecond', 'sourceDurationTicks', 'languageDisposition', 'languageTagPresence', 'languageTagValue', 'orderedCaptionSegments', 'purposePresence', 'purposeValue'];
    const segmentFields = ['segmentId', 'text', 'startTick', 'endTick', 'origin', 'speakerLabelPresence', 'speakerLabelValue'];
    add(fingerprint?.versionTag === 'media.caption-registration-request.v1' && fingerprint.algorithm === 'SHA-256' && fingerprint.digestRepresentation === 'exactly 64 lowercase hexadecimal characters, no prefix or whitespace' &&
      JSON.stringify(fingerprint.tupleFields) === JSON.stringify(tupleFields) && JSON.stringify(fingerprint.segmentTupleFields) === JSON.stringify(segmentFields) &&
      has(fingerprint.encoding, /UTF-8 bytes.*compact JSON array.*no whitespace outside strings.*safe integers.*preserve validated Unicode scalar values without normalization/u) &&
      has(fingerprint.stringEncoding, /escape quotation mark and backslash.*short escapes.*U\+0000-through-U\+001F.*do not escape slash.*reject unpaired surrogates/u) &&
      has(fingerprint.optionalEncoding, /absent optional fields encode false then null.*present fields encode true then their exact validated value.*preserve segment order/u) &&
      has(fingerprint.retainedBeforeDispatch, /caller retains the validated snapshot.*requestId and computed fingerprint before dispatch/u) &&
      has(fingerprint.comparison, /issuer recomputes the same digest.*original trusted tenant\/principal must match.*never treat a digest as authorization/u) &&
      has(fingerprint.qualification, /no runtime, security review or scientific qualification is inferred/u),
      `${writeId} fingerprint must cover exact context, typed parent, clock, ordered content and optional-field presence with a retained pre-dispatch recipe`);
    add(has(write.idempotency, /same-key-same-fingerprint.*original-captionVersionId-and-registrationReceiptId/u),
      `${writeId} must return the original receipt for exact request replay`);
    add(has(write.idempotency, /same-key-different-fingerprint-is-IDEMPOTENCY_CONFLICT/u),
      `${writeId} must conflict when the same key is rebound to different content`);
    add(has(write.unknownOutcome, /same-tenant-principal-requestId-and-caller-computed-identical-full-requestFingerprint/u),
      `${writeId} unknown receipt reconciliation must reuse the exact original request identity`);
    add(has(write.unknownOutcome, /reconcile-before-any-command-replay/u) && has(write.unknownOutcome, /scoped-absence-expiry-or-unavailability-never-proves-no-commit/u),
      `${writeId} must reconcile before replay and must not infer no-commit from scoped absence`);
    add(has(write.retry, /DEFINITIVE_NO_COMMIT.*fresh-policy-checks.*never-automatic-retry-or-new-key/u),
      `${writeId} may retry only after authoritative terminal no-effect proof and fresh policy evaluation`);
    add(has(write.finality, /does-not-imply-delivery-or-publication/u), `${writeId} must not imply delivery or publication`);
    add(write.outputSemantics?.review === 'registration-does-not-approve-or-accept-the-caption-content', `${writeId} result must not promote registration into approval`);
    add(write.outputSemantics?.successFields?.includes('registrationReceiptId') && write.outputSemantics.successFields.includes('captionVersionId'),
      `${writeId} must return an opaque version ID and registration receipt`);
    add(write.transition?.transitionRefs?.length === 0 && has(write.transition?.applicability, /not-a-domain-state-transition/u),
      `${writeId} is append-only registration, not a state transition`);
    add(write.scopeStatus?.includes('proposal-only') && write.scopeStatus.includes('runtime-NOT_ADMITTED'),
      `${writeId} must remain proposal-only and runtime NOT_ADMITTED`);
    add(write.error?.includes('CAPTION_VERSION_CONFLICT') && write.error.includes('IDEMPOTENCY_CONFLICT') && write.error.includes('UNKNOWN_OUTCOME'),
      `${writeId} must preserve stale-parent, payload-conflict, and uncertain-finality errors`);
  }

  add(Boolean(read), `canonical operation ${readId} is missing`);
  if (read) {
    add(read.family?.includes('compare-caption-versions'), `${readId} must retain its existing operation identity`);
    add(read.actionRefs?.includes('media.action.compare-caption-versions'), `${readId} must bind the existing compare action`);
    const branches = read.inputSemantics?.selectorBranches ?? {};
    add(read.context?.requiredPolicyBySelector?.EXACT_PAIR === 'currentReadAuthorityForBoth' &&
      read.context?.requiredPolicyBySelector?.REGISTRATION_REQUEST === 'currentReadAuthorityForOriginalRequestScope' &&
      read.context?.requiredPolicy === undefined, `${readId} read authority must follow the exact selector branch`);
    add(has(read.version, /EXACT_PAIR-requires-two-distinct.*REGISTRATION_REQUEST-preserves-original-requestId/u) &&
      has(read.recovery, /EXACT_PAIR-revalidates-both.*REGISTRATION_REQUEST-reobserves-only-original.*UNKNOWN_OUTCOME/u),
      `${readId} version and recovery requirements must preserve the original request branch`);

    add(read.inputSemantics?.selectorKindValues?.includes('EXACT_PAIR') && read.inputSemantics.selectorKindValues.includes('REGISTRATION_REQUEST'),
      `${readId} must retain exact-pair and registration-request selectors`);
    add(branches.EXACT_PAIR?.requiredFields?.includes('leftCaptionVersionId') && branches.EXACT_PAIR.requiredFields.includes('rightCaptionVersionId'),
      `${readId} must read an exact version pair`);
    add(branches.REGISTRATION_REQUEST?.requiredFields?.includes('requestId') && branches.REGISTRATION_REQUEST.requiredFields.includes('requestFingerprint'),
      `${readId} must reconcile an original request by bounded key and full fingerprint`);
    add(has(branches.EXACT_PAIR?.rule, /no-global-list/u),
      `${readId} must not become a global caption-version listing operation`);
    add(has(branches.REGISTRATION_REQUEST?.rule, /no-write-or-replay/u),
      `${readId} request reconciliation must be observation-only, never replay`);
    add(has(read.preconditions?.join(' '), /exact-source-artifact-version-and-clock-checked/u),
      `${readId} must check source identity and clock before reporting comparable differences`);
    add(read.outputSemantics?.EXACT_PAIR?.requiredFields?.includes('leftCaptionVersionRef') && read.outputSemantics.EXACT_PAIR.requiredFields.includes('rightCaptionVersionRef'),
      `${readId} must preserve both exact pair identities in its result`);
    const requestResult = read.outputSemantics?.REGISTRATION_REQUEST ?? {};
    add(requestResult.requiredFields?.includes('requestId') && requestResult.requiredFields.includes('requestFingerprint') &&
      requestResult.registeredFields?.includes('registrationReceiptId') && requestResult.registeredFields.includes('captionVersionId'),
      `${readId} must return exact request identity and original receipt/version only when proven registered`);
    add(has(read.outputSemantics?.registrationRequestRules, /absent-expired-or-unavailable.*UNKNOWN_OUTCOME.*never-authorizes-blind-replay/u),
      `${readId} must preserve unknown receipt state without authorizing replay`);
    add(has(read.effect, /read-only-exact-pair-comparison-or-same-scope-original-registration-receipt-observation/u) &&
      has(read.finality, /does-not-merge-or-select-a-winning-version/u),
      `${readId} must remain read-only for comparison and receipt observation without selecting a winner`);
    add(read.error?.includes('CAPTION_VERSIONS_NOT_COMPARABLE') && read.error.includes('CAPTION_VERSION_NOT_FOUND_IN_CALLER_SCOPE') && read.error.includes('UNKNOWN_OUTCOME'),
      `${readId} must distinguish source mismatch, scope-safe absence, and unproven receipt outcome`);
    add(read.transition?.transitionRefs?.length === 0 && has(read.transition?.applicability, /no-domain-transition/u),
      `${readId} must not introduce a domain transition`);
    add(read.scopeStatus?.includes('proposal-only') && read.scopeStatus.includes('runtime-NOT_ADMITTED'),
      `${readId} must remain proposal-only and runtime NOT_ADMITTED`);
    add([...(read.outputSemantics?.EXACT_PAIR?.requiredFields ?? []), ...(requestResult.requiredFields ?? []), ...(requestResult.registeredFields ?? [])].every((field) => !/approval|winner|merge/u.test(field)),
      `${readId} must not return approval, winner, or merge authority`);
  }

  const bindings = actionContracts?.operationSliceBindings ?? {};
  add(bindings[writeId]?.actionIntentRefs?.includes('media.action.save-caption-version'), `${writeId} action-contract binding is missing`);
  add(bindings[readId]?.actionIntentRefs?.includes('media.action.compare-caption-versions'), `${readId} action-contract binding is missing`);
  add(has(bindings[writeId]?.disposition, /not-review-approval-delivery-or-publication/u), `${writeId} action binding overstates registration finality`);
  add(bindings[readId]?.reconciliationActionRefs?.includes('media.action.save-caption-version'), `${readId} same-scope receipt observation must refer to the existing registration action`);
  add(has(bindings[readId]?.disposition, /read-only.*no-mutation/u), `${readId} action binding must remain read-only`);
  return issues;
}
