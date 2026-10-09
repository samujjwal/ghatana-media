/** Check the acceptance slice without admitting recognition or an execution profile. */
export function validateTranscriptionSubmissionCapabilityDefinition({ review, operations, journey, actions }) {
  const issues = [];
  const operationId = 'media.operation.transcription-submission';
  const index = operations.operations.findIndex(({ id }) => id === operationId);
  const step = journey.steps.find(({ stepId }) => stepId === 'J03-2');
  const action = actions.actions.find(({ id }) => id === 'media.action.request-transcription');
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (index < 0 || !step || !action) return ['missing submission identity'];
  for (const leafId of ['media.job.submit', 'media.speech.transcription.file']) {
    const slice = review.leaves.find(({ id }) => id === leafId)?.transcriptionSubmissionDefinitionSlice;
    if (!slice) { issues.push(`missing bounded acceptance slice ${leafId}`); continue; }
    if (slice.status !== 'BOUNDED_REQUEST_ACCEPTANCE_ONLY' || slice.decisionRef !== '.product-experience/decision-log.md#PXD-073' || slice.sourceDecisionRef !== '.product-experience/decision-log.md#PXD-070' || slice.experienceDecisionRef !== '.product-experience/decision-log.md#PXD-072') issues.push(`unreviewed submission slice ${leafId}`);
    if (slice.runtimeAdmission !== 'NOT_ADMITTED' || slice.fullLeafAcceptance !== 'NOT_CLAIMED') issues.push(`forged submission admission ${leafId}`);
    if (!eq(slice.operationRefs, [operationId]) || !eq(slice.actionRefs, [action.id]) || !eq(slice.journeyStepRefs, ['J03-2']) || !eq(slice.sourceContractRefs, [`.product-experience/pdp-1-domain-data/operations.yaml#/operations/${index}`])) issues.push(`swapped submission meaning ${leafId}`);
    for (const field of ['exactAudioSourceOnly', 'explicitLanguageAndQualifiedProfileRequired', 'currentProcessingPolicyAtEffectBoundary', 'retainedFullSnapshotBeforeDispatch', 'scopedReceiptReadDistinctFromProcessing', 'originalKeyReceiptNeverInventedOrReplaced', 'noRecognitionOrQualityAdmission', 'noJobStateOrAttemptTransitionAdmission', 'noStreamingOrProviderCorrectionEquivalence']) {
      if (slice.profileApplicability?.[field] !== true) issues.push(`unqualified acceptance boundary ${leafId}/${field}`);
    }
  }
  if (step.action !== action.id || step.canonicalOperationRef !== operationId || action.actionDefinitionSemantics?.operationRef !== operationId || !eq(step.capabilityRefs, ['media.job.submit', 'media.speech.transcription.file']) || !eq(action.capabilityRefs, ['media.job.submit', 'media.speech.transcription.file'])) issues.push('unbound submission step');
  return issues;
}
