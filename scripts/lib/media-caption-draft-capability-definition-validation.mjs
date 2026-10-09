/** Validate bounded draft crosswalks without admitting the capability or an alignment engine. */
export function validateCaptionDraftCapabilityDefinition({ review, operations, journey, actions }) {
  const issues = [];
  const slice = review.leaves.find(({ id }) => id === 'media.artifact.derive')?.captionDraftDefinitionSlice;
  const forced = review.leaves.find(({ id }) => id === 'media.speech.transcription.forced-align');
  const operationId = 'media.operation.caption-draft-write';
  const index = operations.operations.findIndex(({ id }) => id === operationId);
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!slice || !forced || index < 0) return ['missing draft capability source'];
  if (slice.decisionRef !== '.product-experience/decision-log.md#PXD-069' || slice.sourceDecisionRef !== '.product-experience/decision-log.md#PXD-066' || slice.experienceDecisionRef !== '.product-experience/decision-log.md#PXD-068') issues.push('unreviewed draft capability');
  if (slice.runtimeAdmission !== 'NOT_ADMITTED' || slice.fullLeafAcceptance !== 'NOT_CLAIMED') issues.push('forged draft admission');
  if (!eq(slice.operationRefs, [operationId]) || !eq(slice.journeyStepRefs, ['J03-5', 'J03-6'])) issues.push('swapped draft meaning');
  if (!eq(slice.sourceContractRefs, [`.product-experience/pdp-1-domain-data/operations.yaml#/operations/${index}`])) issues.push('stale draft source pointer');
  for (const [stepId, actionId] of [['J03-5', 'media.action.correct-caption'], ['J03-6', 'media.action.align-caption-timing']]) {
    const step = journey.steps.find((record) => record.stepId === stepId);
    const action = actions.actions.find(({ id }) => id === actionId);
    if (!step || !action || step.action !== actionId || step.canonicalOperationRef !== operationId || action.actionDefinitionSemantics?.operationRef !== operationId) issues.push(`unbound draft edit ${stepId}`);
    if (!eq(step?.capabilityRefs, ['media.artifact.derive']) || !eq(action?.capabilityRefs, ['media.artifact.derive'])) issues.push(`manual edit cannot admit forced alignment ${stepId}`);
  }
  if (forced.operation.actionRefs.length || forced.operation.explicitOperationBindings.length || forced.manualTimingNonEquivalence?.decisionRef !== '.product-experience/decision-log.md#PXD-069' || forced.manualTimingNonEquivalence.runtimeAdmission !== 'NOT_ADMITTED' || forced.manualTimingNonEquivalence.fullLeafAcceptance !== 'NOT_CLAIMED') issues.push('forced alignment is not satisfied by manual draft editing');
  for (const field of ['noForcedAlignmentEngineAdmission', 'noRegistrationApprovalOrPublication', 'noDurabilityOrStorageAdmission', 'preserveExactSourceAndParentIdentity', 'conditionalLocalUndoOnly', 'missingTimingPermitsTextEdit', 'unqualifiedClockBlocksTickAlignment']) {
    if (slice.profileApplicability?.[field] !== true) issues.push(`unqualified draft profile ${field}`);
  }
  return issues;
}
