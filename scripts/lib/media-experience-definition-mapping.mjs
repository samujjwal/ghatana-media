/** Project explicit definition records only. This is neither runtime nor proof admission. */
export function resolveExperienceDefinitionSemantics(actions, recoveryContracts, taxonomy) {
  const effects = [];
  const finality = [];
  const recoveries = [];
  const effectRefsByAction = new Map();
  const conditionalActions = [];
  const unmappedPublicActions = [];
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
  // These three records are previously reviewed, bounded public projections.
  // Typed PDP-075 overlays may extend the source, but may not rewrite their
  // historical identity, evidence chain, or accepted public records.
  const reviewedPublicRecords = new Map([
    ['media.action.attach-source-asset', { review: '.product-experience/decision-log.md#PXD-052', operation: 'media.operation-slice.attach-source-asset' }],
    ['media.action.create-project', { source: '.product-experience/decision-log.md#PXD-054', review: '.product-experience/decision-log.md#PXD-055', operation: 'media.operation-slice.create-project' }],
    ['media.action.save-caption-version', { source: '.product-experience/decision-log.md#PXD-058', grammar: '.product-experience/decision-log.md#PXD-059', review: '.product-experience/decision-log.md#PXD-060', operation: 'media.operation.caption-version-write' }],
  ]);
  // Preserve the original bounded decision/source slices even when the new
  // PDP-075 owner overlay is projected as a separate current definition.
  const historicalSourceScopes = new Map([
    ['media.action.attach-source-asset', { review: '.product-experience/decision-log.md#PXD-052', operation: 'media.operation-slice.attach-source-asset' }],
    ['media.action.create-project', { source: '.product-experience/decision-log.md#PXD-054', review: '.product-experience/decision-log.md#PXD-055', operation: 'media.operation-slice.create-project' }],
    ['media.action.save-caption-version', { source: '.product-experience/decision-log.md#PXD-058', grammar: '.product-experience/decision-log.md#PXD-059', review: '.product-experience/decision-log.md#PXD-060', operation: 'media.operation.caption-version-write' }],
    ['media.action.review-transcript', { source: '.product-experience/decision-log.md#PXD-062', grammar: '.product-experience/decision-log.md#PXD-063', review: '.product-experience/decision-log.md#PXD-064', operation: 'media.operation.transcript-version-read' }],
    ['media.action.correct-caption', { source: '.product-experience/decision-log.md#PXD-066', grammar: '.product-experience/decision-log.md#PXD-067', review: '.product-experience/decision-log.md#PXD-068', operation: 'media.operation.caption-draft-write' }],
    ['media.action.align-caption-timing', { source: '.product-experience/decision-log.md#PXD-066', grammar: '.product-experience/decision-log.md#PXD-067', review: '.product-experience/decision-log.md#PXD-068', operation: 'media.operation.caption-draft-write' }],
    ['media.action.request-transcription', { source: '.product-experience/decision-log.md#PXD-070', grammar: '.product-experience/decision-log.md#PXD-071', review: '.product-experience/decision-log.md#PXD-072', operation: 'media.operation.transcription-submission' }],
  ]);
  const taxonomyByAction = new Map((taxonomy?.records ?? []).map((record) => [record.actionRef, record]));
  const semanticRoles = new Map([
    ['EXACT_OPERATION_REFERENCE', 'DOMAIN_OPERATION'],
    ['OWNER_DEFINED_EXACT_OPERATION_REFERENCE', 'DOMAIN_OPERATION'],
    ['EXACT_ORDERED_WORKFLOW', 'ORDERED_DOMAIN_WORKFLOW'],
    ['NO_DOMAIN_OPERATION_LOCAL_SELECTION_OR_SESSION_DRAFT', 'LOCAL_SELECTION_OR_SESSION_DRAFT'],
    ['READ_ONLY_OBSERVATION; QUERY_BINDING_UNRESOLVED', 'READ_ONLY_OBSERVATION_QUERY_BINDING_UNRESOLVED'],
    ['CONSEQUENTIAL_OPERATION_UNBOUND', 'CONSEQUENTIAL_OPERATION_UNBOUND'],
    ['EXTERNAL_SHARED_IDENTITY_HANDOFF_OR_OBSERVATION; NO_MEDIA_DOMAIN_MUTATION', 'EXTERNAL_SHARED_IDENTITY_HANDOFF_OR_OBSERVATION'],
    ['EXTERNAL_SHARED_IDENTITY_HANDOFF; NO_MEDIA_DOMAIN_MUTATION', 'EXTERNAL_SHARED_IDENTITY_HANDOFF'],
    ['OWNER_OPERATION_CLASSIFICATION_REQUIRED', 'OWNER_OPERATION_CLASSIFICATION_REQUIRED'],
  ]);
  for (const action of actions) {
    const definition = action.actionDefinitionSemantics;
    if (!definition) continue;
    const typed = definition.typedDefinition;
    if (typed) {
      const envelope = definition.sourceEnvelope;
      const historicalScope = historicalSourceScopes.get(action.id);
      if (historicalScope && ((definition.sourceDecisionRef ?? null) !== (historicalScope.source ?? null)
        || (definition.grammarDecisionRef ?? null) !== (historicalScope.grammar ?? null)
        || (definition.reviewDecisionRef ?? null) !== historicalScope.review
        || (definition.operationRef ?? null) !== historicalScope.operation)) fail(`historical decision scope drift ${action.id}`);
      const role = semanticRoles.get(typed.domainOperationDisposition);
      const pendingReconnectDefinition = action.id === 'media.action.request-live-session-reconnect'
        && typed.ownerDefinitionDecisionRef === '.product-experience/decision-log.md#PXD-077';
      if ((typed.ownerDefinitionDecisionRef !== '.product-experience/decision-log.md#PXD-075' && !pendingReconnectDefinition)
        || definition.actionRef !== action.id
        || !envelope
        || role !== typed.semanticRole
        || (definition.runtimeAdmission != null && definition.runtimeAdmission !== 'NOT_ADMITTED')
        || typed.runtimeAdmission !== 'NOT_ADMITTED'
        || typed.actorRefs?.join('\0') !== action.actorRefs?.join('\0')
        || typed.applicabilityGuards?.join('\0') !== action.preconditions?.join('\0')
        || typed.effect !== action.effect
        || typed.sourceReversibleValue !== action.reversible
        || typed.finality !== action.finality
        || typed.failureRecovery !== action.failure
        || typed.domainOperationDisposition !== envelope.domainOperationDisposition
        || typed.domainOperationDisposition !== envelope.domainOperationDisposition
        || typed.exactOperationRefs?.join('\0') !== envelope.exactOperationRefs?.join('\0')
        || typed.actorRefs?.join('\0') !== envelope.actorRefs?.join('\0')
        || typed.applicabilityGuards?.join('\0') !== envelope.preconditions?.join('\0')
        || typed.effect !== envelope.effect
        || typed.finality !== envelope.finality
        || typed.failureRecovery !== envelope.failure
        || !['REVERSIBLE', 'NOT_REVERSIBLE', 'CONDITIONAL', 'UNKNOWN'].includes(typed.reversibilityDisposition)
        || !['REQUIRED', 'NOT_REQUIRED', 'UNRESOLVED'].includes(typed.confirmationDisposition)) fail(`typed action definition mismatch ${action.id}`);
      const exactRefs = envelope.exactOperationRefs ?? [];
      if (exactRefs.length && typed.semanticRole === 'DOMAIN_OPERATION'
        && ((!definition.operationRef && !typed.operationRef)
          || (definition.operationRef && typed.operationRef && typed.operationRef !== definition.operationRef)
          || !exactRefs.includes(definition.operationRef ?? typed.operationRef))) fail(`unlinked exact operation ${action.id}`);
      if (exactRefs.length && typed.semanticRole === 'ORDERED_DOMAIN_WORKFLOW'
        && (definition.orderedOperationRefs?.join('\0') !== exactRefs.join('\0')
          || typed.orderedOperationRefs?.join('\0') !== definition.orderedOperationRefs.join('\0'))) fail(`ordered workflow operation binding ${action.id}`);
      if (typed.semanticRole === 'ORDERED_DOMAIN_WORKFLOW' && exactRefs.join('\0') !== (definition.orderedOperationRefs ?? []).join('\0')) fail(`ordered workflow identity ${action.id}`);
      const kind = typed.reversibilityDisposition;
      if (definition.publicEffect || definition.publicFinality) {
        const reviewed = reviewedPublicRecords.get(action.id);
        if (!reviewed || definition.actionRef !== action.id || definition.runtimeAdmission !== 'NOT_ADMITTED'
          || definition.sourceDecisionRef !== (reviewed.source ?? definition.sourceDecisionRef)
          || definition.grammarDecisionRef !== (reviewed.grammar ?? definition.grammarDecisionRef)
          || definition.reviewDecisionRef !== reviewed.review
          || definition.operationRef !== reviewed.operation) fail(`unbounded historical public record ${action.id}`);
        if (definition.publicEffect && (!exactKeys(definition.publicEffect, effectKeys)
          || definition.publicEffect.reversible !== action.reversible
          || definition.publicEffect.id !== `${action.id === 'media.action.attach-source-asset' ? 'media.effect.attach-source-version' : action.id === 'media.action.create-project' ? 'media.effect.create-empty-project' : 'media.effect.register-caption-version'}`)) fail(`historical effect identity ${action.id}`);
        if (definition.publicFinality && (!exactKeys(definition.publicFinality, finalityKeys)
          || definition.publicFinality.actionRef !== action.id
          || definition.publicFinality.undoable !== action.reversible)) fail(`historical finality identity ${action.id}`);
        if (definition.publicEffect) { claimId(definition.publicEffect.id); effects.push(definition.publicEffect); effectRefsByAction.set(action.id, [definition.publicEffect.id]); }
        if (definition.publicFinality) { claimId(definition.publicFinality.id); finality.push(definition.publicFinality); }
        continue;
      }
      const mapping = taxonomyByAction.get(action.id);
      const expectedMappingDecisionRef = action.id === 'media.action.request-live-session-reconnect'
        ? '.product-experience/decision-log.md#PXD-077'
        : '.product-experience/decision-log.md#PXD-078';
      if (!mapping || mapping.mappingReviewStatus !== 'BOUNDED_MEDIA_OWNER_MAPPING_REVIEWED'
        || mapping.mappingDecisionRef !== expectedMappingDecisionRef
        || mapping.runtimeAdmission !== 'NOT_ADMITTED'
        || !mapping.publicEffectCandidate || !mapping.publicFinalityCandidate) {
        if (kind === 'CONDITIONAL' || kind === 'UNKNOWN') conditionalActions.push(action.id);
        unmappedPublicActions.push(action.id);
        continue;
      }
      if (kind !== mapping.reversibilityDisposition || typed.confirmationDisposition !== mapping.confirmationDisposition) fail(`taxonomy disposition mismatch ${action.id}`);
      if (mapping.publicEffectCandidate.kind === 'state-change' && typed.semanticRole !== 'LOCAL_SELECTION_OR_SESSION_DRAFT') fail(`state-change taxonomy role mismatch ${action.id}`);
      if (mapping.publicEffectCandidate.kind === 'external-call' && !['DOMAIN_OPERATION', 'ORDERED_DOMAIN_WORKFLOW'].includes(typed.semanticRole)) fail(`external-call taxonomy role mismatch ${action.id}`);
      if (['DOMAIN_OPERATION', 'ORDERED_DOMAIN_WORKFLOW'].includes(typed.semanticRole)) {
        const canonicalKinds = mapping.canonicalOperationFacts.map((fact) => fact.operationKind);
        if (canonicalKinds.length === 0 || !canonicalKinds.every((operationKind) => ['COMMAND', 'QUERY'].includes(operationKind))) fail(`missing canonical operation kind ${action.id}`);
        if (canonicalKinds.includes('QUERY') && mapping.publicEffectCandidate.kind !== 'external-call') fail(`query public kind mismatch ${action.id}`);
      }
      if (reviewedPublicRecords.has(action.id)) fail(`historical public identity was replaced ${action.id}`);
      const publicEffect = {
        id: `${mapping.id}.effect`,
        name: action.label,
        kind: mapping.publicEffectCandidate.kind,
        description: action.effect,
        reversibilityDisposition: mapping.publicEffectCandidate.reversibilityDisposition,
      };
      const publicFinality = {
        id: `${mapping.id}.finality`,
        actionRef: action.id,
        description: action.finality,
        confirmationDisposition: mapping.publicFinalityCandidate.confirmationDisposition,
        undoabilityDisposition: mapping.publicFinalityCandidate.undoabilityDisposition,
      };
      claimId(publicEffect.id); effects.push(publicEffect); effectRefsByAction.set(action.id, [publicEffect.id]);
      claimId(publicFinality.id); finality.push(publicFinality);
      continue;
    }
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
  return { effects, finality, recoveries, effectRefsByAction, conditionalActions, unmappedPublicActions };
}
