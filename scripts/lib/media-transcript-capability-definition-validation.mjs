/** Check one bounded definition slice; does not admit runtime or the full capability. */
export function validateTranscriptCapabilityDefinition({ review, operations, journey, actions }) {
  const issues = [];
  const slice = review.leaves.find(({ id }) => id === 'media.artifact.inspect')?.transcriptVersionDefinitionSlice;
  const operationId = 'media.operation.transcript-version-read';
  const index = operations.operations.findIndex(({ id }) => id === operationId);
  const step = journey.steps.find(({ stepId }) => stepId === 'J03-4');
  const action = actions.actions.find(({ id }) => id === 'media.action.review-transcript');
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!slice || index < 0 || !step || !action) return ['missing transcript definition source'];
  if (slice.decisionRef !== '.product-experience/decision-log.md#PXD-065' || slice.sourceDecisionRef !== '.product-experience/decision-log.md#PXD-062' || slice.experienceDecisionRef !== '.product-experience/decision-log.md#PXD-064') issues.push('unreviewed transcript definition');
  if (slice.runtimeAdmission !== 'NOT_ADMITTED' || slice.fullLeafAcceptance !== 'NOT_CLAIMED') issues.push('forged transcript admission');
  if (!eq(slice.operationRefs, [operationId]) || !eq(slice.journeyStepRefs, ['J03-4']) || !eq(slice.domainObjectRefs, ['media.domain.transcript-version']) || step.canonicalOperationRef !== operationId || step.action !== action.id) issues.push('swapped transcript meaning');
  if (!eq(slice.sourceContractRefs, [`.product-experience/pdp-1-domain-data/operations.yaml#/operations/${index}`])) issues.push('stale transcript source pointer');
  if (action.actionDefinitionSemantics?.operationRef !== operationId || action.actionDefinitionSemantics?.runtimeAdmission !== 'NOT_ADMITTED') issues.push('unbound transcript action');
  for (const field of ['noMutationOrNewProcessing', 'noDeliveryOrPublication', 'noScientificQualityAdmission', 'preserveExactSourceAndVersionIdentity', 'missingTimingDoesNotBlockInspection', 'missingRequiredClockBlocksCaptionParentQualification']) {
    if (slice.profileApplicability?.[field] !== true) issues.push(`unqualified transcript profile ${field}`);
  }
  if (!eq(action.capabilityRefs, ['media.artifact.inspect'])) issues.push('transcript inspection cannot imply registration or approval');
  return issues;
}
