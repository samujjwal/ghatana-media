/** Project explicit definition records only. This is neither runtime nor proof admission. */
export function resolveExperienceDefinitionSemantics(actions, recoveryContracts) {
  const effects = [];
  const finality = [];
  const recoveries = [];
  const effectRefsByAction = new Map();
  const conditionalActions = [];
  const seen = new Set();
  const fail = (message) => { throw new Error(`Invalid experience definition: ${message}`); };
  const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
  const exactKeys = (record, keys) => record && keys.every((key) => Object.hasOwn(record, key)) && Object.keys(record).every((key) => keys.includes(key));
  const effectKeys = ['id', 'name', 'kind', 'description', 'reversible'];
  const finalityKeys = ['id', 'actionRef', 'description', 'confirmationRequired', 'undoable'];
  const recoveryKeys = ['id', 'errorKind', 'recoveryPath', 'automaticRecovery', 'userActionRequired'];
  const claimId = (id) => { if (!nonempty(id) || seen.has(id)) fail(`missing or duplicate record ${id}`); seen.add(id); };
  const projectReviewOperations = new Map([
    ['media.action.create-project', 'media.operation-slice.create-project'],
    ['media.action.open-project', 'media.operation-slice.inspect-project'],
    ['media.action.inspect-project-creation', 'media.operation-slice.inspect-project'],
  ]);
  const captionReviewOperations = new Map([
    ['media.action.save-caption-version', 'media.operation.caption-version-write'],
    ['media.action.compare-caption-versions', 'media.operation.caption-version-read'],
  ]);
  for (const action of actions) {
    const definition = action.actionDefinitionSemantics;
    if (!definition) continue;
    const captionReviewed = definition.reviewDecisionRef === '.product-experience/decision-log.md#PXD-060' && definition.sourceDecisionRef === '.product-experience/decision-log.md#PXD-058' && definition.grammarDecisionRef === '.product-experience/decision-log.md#PXD-059' && captionReviewOperations.has(action.id) && definition.operationRef === captionReviewOperations.get(action.id);
    const transcriptReviewed = definition.reviewDecisionRef === '.product-experience/decision-log.md#PXD-064' && definition.sourceDecisionRef === '.product-experience/decision-log.md#PXD-062' && definition.grammarDecisionRef === '.product-experience/decision-log.md#PXD-063' && action.id === 'media.action.review-transcript' && definition.operationRef === 'media.operation.transcript-version-read';
    const draftReviewed = definition.reviewDecisionRef === '.product-experience/decision-log.md#PXD-068' && definition.sourceDecisionRef === '.product-experience/decision-log.md#PXD-066' && definition.grammarDecisionRef === '.product-experience/decision-log.md#PXD-067' && ['media.action.correct-caption', 'media.action.align-caption-timing'].includes(action.id) && definition.operationRef === 'media.operation.caption-draft-write';
    const submissionReviewed = definition.reviewDecisionRef === '.product-experience/decision-log.md#PXD-072' && definition.sourceDecisionRef === '.product-experience/decision-log.md#PXD-070' && definition.grammarDecisionRef === '.product-experience/decision-log.md#PXD-071' && action.id === 'media.action.request-transcription' && definition.operationRef === 'media.operation.transcription-submission';
    const reviewed = submissionReviewed || draftReviewed || transcriptReviewed || captionReviewed || definition.reviewDecisionRef === '.product-experience/decision-log.md#PXD-052' || (definition.reviewDecisionRef === '.product-experience/decision-log.md#PXD-055' && definition.sourceDecisionRef === '.product-experience/decision-log.md#PXD-054' && projectReviewOperations.has(action.id) && definition.operationRef === projectReviewOperations.get(action.id));
    if (definition.actionRef !== action.id || definition.runtimeAdmission !== 'NOT_ADMITTED' || !reviewed) fail(`unbounded action review ${action.id}`);
    const kind = definition.reversibility?.kind;
    if (submissionReviewed && (definition.effectKind !== 'REQUEST_ACCEPTANCE' || kind !== 'UNKNOWN')) fail(`unbounded transcription submission ${action.id}`);
    if (draftReviewed && (definition.effectKind !== 'LOCAL_DRAFT_UPDATE' || kind !== 'CONDITIONAL')) fail(`unbounded draft edit ${action.id}`);
    if (transcriptReviewed && (definition.effectKind !== 'QUERY' || kind !== 'UNKNOWN')) fail(`unbounded transcript query ${action.id}`);
    if (!['CONDITIONAL', 'NOT_REVERSIBLE', 'REVERSIBLE', 'UNKNOWN'].includes(kind)) fail(`missing reversibility ${action.id}`);
    if (kind === 'CONDITIONAL' || kind === 'UNKNOWN') {
      if (definition.publicEffect || definition.publicFinality) fail(`conditional boolean coercion ${action.id}`);
      conditionalActions.push(action.id);
      continue;
    }
    const effect = definition.publicEffect;
    if (effect) {
      if (!exactKeys(effect, effectKeys) || !effectKeys.filter((key) => key !== 'reversible').every((key) => nonempty(effect[key])) || typeof effect.reversible !== 'boolean') fail(`effect shape ${action.id}`);
      if (!['state-change', 'navigation', 'notification', 'external-call', 'data-write', 'other'].includes(effect.kind) || effect.kind !== definition.effectKind || effect.reversible !== (kind === 'REVERSIBLE')) fail(`effect meaning ${action.id}`);
      claimId(effect.id); effects.push(effect); effectRefsByAction.set(action.id, [effect.id]);
    }
    const entry = definition.publicFinality;
    if (entry) {
      if (!exactKeys(entry, finalityKeys) || !nonempty(entry.id) || !nonempty(entry.description) || entry.actionRef !== action.id || typeof entry.confirmationRequired !== 'boolean' || entry.undoable !== (kind === 'REVERSIBLE')) fail(`finality meaning ${action.id}`);
      claimId(entry.id); finality.push(entry);
    }
  }
  for (const contract of recoveryContracts) {
    const definition = contract.definitionSemantics;
    if (!definition?.publicRecovery) continue;
    if (definition.runtimeAdmission !== 'NOT_ADMITTED' || definition.reviewDecisionRef !== '.product-experience/decision-log.md#PXD-052') fail(`unbounded recovery review ${contract.id}`);
    const entry = definition.publicRecovery;
    if (!exactKeys(entry, recoveryKeys) || entry.id !== contract.id || !['id', 'errorKind', 'recoveryPath'].every((key) => nonempty(entry[key])) || typeof entry.automaticRecovery !== 'boolean' || typeof entry.userActionRequired !== 'boolean') fail(`recovery shape ${contract.id}`);
    if (entry.automaticRecovery) fail(`automatic external recovery not admitted ${contract.id}`);
    claimId(entry.id); recoveries.push(entry);
  }
  return { effects, finality, recoveries, effectRefsByAction, conditionalActions };
}
