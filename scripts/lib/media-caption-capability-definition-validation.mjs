/** Validate bounded source relationships; never runtime or full-leaf admission. */
export function validateCaptionCapabilityDefinitions({ review, operations, journey, actions }) {
  const issues = [];
  const selected = [
    ['media.artifact.output.register', 'media.operation.caption-version-write', 'J03-7', 'media.action.save-caption-version'],
    ['media.artifact.inspect', 'media.operation.caption-version-read', 'J03-8', 'media.action.compare-caption-versions'],
  ];
  for (const [leafId, operationId, stepId, actionId] of selected) {
    const slice = review.leaves.find(({ id }) => id === leafId)?.captionVersionDefinitionSlice;
    const index = operations.operations.findIndex(({ id }) => id === operationId);
    const step = journey.steps.find((record) => record.stepId === stepId);
    const action = actions.actions.find(({ id }) => id === actionId);
    if (!slice || index < 0 || !step || !action) { issues.push(`missing caption source ${leafId}`); continue; }
    if (slice.decisionRef !== '.product-experience/decision-log.md#PXD-061' || slice.sourceDecisionRef !== '.product-experience/decision-log.md#PXD-058' || slice.experienceDecisionRef !== '.product-experience/decision-log.md#PXD-060') issues.push(`unreviewed caption source ${leafId}`);
    if (slice.runtimeAdmission !== 'NOT_ADMITTED' || slice.fullLeafAcceptance !== 'NOT_CLAIMED') issues.push(`forged caption admission ${leafId}`);
    if (JSON.stringify(slice.operationRefs) !== JSON.stringify([operationId]) || JSON.stringify(slice.journeyStepRefs) !== JSON.stringify([stepId]) || step.canonicalOperationRef !== operationId || step.action !== actionId) issues.push(`swapped caption meaning ${leafId}`);
    if (JSON.stringify(slice.sourceContractRefs) !== JSON.stringify([`.product-experience/pdp-1-domain-data/operations.yaml#/operations/${index}`])) issues.push(`stale caption source pointer ${leafId}`);
    if (action.actionDefinitionSemantics?.operationRef !== operationId || action.actionDefinitionSemantics.runtimeAdmission !== 'NOT_ADMITTED') issues.push(`unbound caption action ${leafId}`);
    if (slice.profileApplicability?.noDeliveryOrPublication !== true || slice.profileApplicability.noProcessingEngineOrModelAdmission !== true || slice.profileApplicability.preserveExactSourceAndParentIdentity !== true) issues.push(`unqualified caption profile ${leafId}`);
  }
  const save = actions.actions.find(({ id }) => id === 'media.action.save-caption-version');
  if (JSON.stringify(save?.capabilityRefs) !== JSON.stringify(['media.artifact.output.register'])) issues.push('internal registration provenance cannot imply provenance export');
  return issues;
}
