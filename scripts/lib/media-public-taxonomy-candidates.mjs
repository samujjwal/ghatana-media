import { createHash } from 'node:crypto';

const enumValues = {
  reversibility: new Set(['REVERSIBLE', 'NOT_REVERSIBLE', 'CONDITIONAL', 'UNKNOWN']),
  confirmation: new Set(['REQUIRED', 'NOT_REQUIRED', 'UNRESOLVED']),
};

const operationIndex = (operations) => {
  const index = new Map();
  for (const operation of operations.operations ?? []) index.set(operation.id, operation);
  for (const groupName of ['capabilityOperationContracts', 'individualOperationContracts', 'ownerDefinedOperationContracts']) {
    for (const operation of operations[groupName]?.records ?? []) {
      for (const ref of operation.operationRefs ?? [operation.id]) index.set(ref, operation);
    }
  }
  return index;
};

const expectedId = (actionRef) => `media.public-taxonomy.${actionRef.replace(/^media\.action\./u, '').replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')}`;
const fail = (message) => { throw new Error(message); };

/** Validate owner-reviewed Media taxonomy candidates against their exact current source records.
 * This validates candidates only; it does not generate a public projection or imply admission.
 */
export function validateMediaPublicTaxonomyCandidates({ taxonomy, actions, operations }) {
  const allActions = [...actions.actions, ...(actions.ownerDefinedActions ?? [])];
  const actionById = new Map(allActions.map((action) => [action.id, action]));
  const originalIds = new Set(actions.actions.map((action) => action.id));
  const sharedActionIds = new Set([
    'media.action.select-identity-confirmed-workspace',
    'media.action.start-upstream-identity-handoff',
  ]);
  const expectedPxd078ActionIds = new Set([...originalIds].filter((id) => !sharedActionIds.has(id)));
  const operationById = operationIndex(operations);
  const records = taxonomy.records ?? [];
  if (records.length !== allActions.length) fail(`expected ${allActions.length} taxonomy records, got ${records.length}`);
  if (new Set(records.map((record) => record.actionRef)).size !== records.length) fail('taxonomy actionRef identities must be unique');
  if (new Set(records.map((record) => record.id)).size !== records.length) fail('taxonomy mapping IDs must be unique');

  let reviewedOriginal = 0;
  const reviewedOriginalIds = new Set();
  for (const record of records) {
    const action = actionById.get(record.actionRef);
    if (!action) fail(`unknown action identity ${record.actionRef}`);
    if (record.id !== expectedId(record.actionRef)) fail(`${record.actionRef} has a stale or forged mapping ID`);
    const typed = action.actionDefinitionSemantics?.typedDefinition;
    const sourceEnvelope = action.actionDefinitionSemantics?.sourceEnvelope;
    const actionSemantics = action.actionDefinitionSemantics ?? {};
    if (!sourceEnvelope) fail(`${record.actionRef} is missing its exact source envelope`);
    const expectedEnvelopeRef = `.product-experience/pdp-3-product-experience/action-registry.yaml#${originalIds.has(record.actionRef) ? 'actions' : 'ownerDefinedActions'}/@id=${record.actionRef}/actionDefinitionSemantics/sourceEnvelope`;
    if (record.sourceEnvelopeRef !== expectedEnvelopeRef) fail(`${record.actionRef} source envelope reference is stale or forged`);
    const envelopeHash = createHash('sha256').update(JSON.stringify(sourceEnvelope)).digest('hex');
    if (record.sourceEnvelopeSha256 !== envelopeHash) fail(`${record.actionRef} source envelope digest is stale or forged`);
    const historicalBinding = {
      sourceDecisionRef: actionSemantics.sourceDecisionRef ?? null,
      grammarDecisionRef: actionSemantics.grammarDecisionRef ?? null,
      reviewDecisionRef: actionSemantics.reviewDecisionRef ?? null,
      operationRef: actionSemantics.operationRef ?? null,
      publicEffectId: actionSemantics.publicEffect?.id ?? null,
      publicFinalityId: actionSemantics.publicFinality?.id ?? null,
    };
    if (JSON.stringify(record.sourceHistoricalPublicBinding) !== JSON.stringify(historicalBinding)) fail(`${record.actionRef} historical public binding facts are stale or forged`);
    const expectedRefs = typed?.exactOperationRefs ?? [];
    if (JSON.stringify(record.operationRefs) !== JSON.stringify(expectedRefs)) fail(`${record.actionRef} operation refs disagree with source`);
    const envelopeRefs = sourceEnvelope.exactOperationRefs ?? sourceEnvelope.canonicalBindings?.operationRefs ?? [];
    if (JSON.stringify(record.sourceEnvelopeOperationRefs) !== JSON.stringify(envelopeRefs)) fail(`${record.actionRef} source envelope operation refs disagree with source`);
    const canonicalBindings = sourceEnvelope.canonicalBindings ?? typed?.canonicalOperationBindings ?? null;
    if (JSON.stringify(record.sourceEnvelopeCanonicalBindings) !== JSON.stringify(canonicalBindings)) fail(`${record.actionRef} source envelope canonical bindings disagree with source`);
    const sourceFacts = record.sourceEnvelopeFacts;
    if (sourceFacts.domainOperationDisposition !== sourceEnvelope.domainOperationDisposition ||
        JSON.stringify(sourceFacts.operationRefs) !== JSON.stringify(envelopeRefs) ||
        sourceFacts.runtimeAdmission !== sourceEnvelope.runtimeAdmission) fail(`${record.actionRef} source envelope facts are stale or forged`);
    const bindingOperations = canonicalBindings?.operations ?? (canonicalBindings?.operationRef ? [canonicalBindings] : []);
    const expectedOperationKinds = envelopeRefs.map((operationRef) => {
      const bound = bindingOperations.find((operation) => operation.operationRef === operationRef);
      const source = operationById.get(operationRef);
      return { operationRef, operationKind: bound?.operationKind ?? source?.operationKind };
    });
    if (JSON.stringify(sourceFacts.operationKindFacts) !== JSON.stringify(expectedOperationKinds)) fail(`${record.actionRef} source envelope operation kind facts are stale or forged`);
    const sourceUnion = (key) => {
      const values = bindingOperations.flatMap((operation) => operation[key] ?? []);
      return [...new Set(values.length ? values : (sourceEnvelope[key] ?? []))];
    };
    for (const key of ['domainObjectRefs', 'stateRefs', 'authorityRefs']) {
      if (JSON.stringify(sourceFacts[key]) !== JSON.stringify(sourceUnion(key))) fail(`${record.actionRef} source envelope ${key} are stale or forged`);
    }
    if (JSON.stringify(sourceFacts.requirementRefs) !== JSON.stringify(sourceEnvelope.requirementRefs ?? [])) fail(`${record.actionRef} source envelope requirement refs are stale or forged`);
    const expectedProfileRef = sourceEnvelope.profileRef ?? (bindingOperations.length === 1 ? bindingOperations[0].profileRef ?? null : null);
    if (sourceFacts.profileRef !== expectedProfileRef) fail(`${record.actionRef} source envelope profile ref is stale or forged`);
    const expectedScope = sourceEnvelope.scopeStatus ?? sourceEnvelope.ownerDefinitionStatus ?? null;
    if (sourceFacts.scopeStatus !== expectedScope) fail(`${record.actionRef} source envelope scope status is stale or forged`);
    if (JSON.stringify(record.canonicalOperationFacts.map((fact) => fact.operationRef)) !== JSON.stringify(record.operationRefs)) fail(`${record.actionRef} operation facts do not match selected operation refs`);
    for (const fact of record.canonicalOperationFacts) {
      const source = operationById.get(fact.operationRef);
      if (!source) fail(`${record.actionRef} references unresolved operation ${fact.operationRef}`);
      if (!['COMMAND', 'QUERY'].includes(source.operationKind) || fact.operationKind !== source.operationKind) fail(`${record.actionRef} operation kind is stale or forged`);
    }
    if (record.sourceEffect !== action.effect || record.sourceFinality !== action.finality) fail(`${record.actionRef} source effect/finality text is stale`);
    if (record.reversibilityDisposition !== typed?.reversibilityDisposition) fail(`${record.actionRef} reversibility disposition disagrees with source`);
    if (record.confirmationDisposition !== typed?.confirmationDisposition) fail(`${record.actionRef} confirmation disposition disagrees with source`);
    if (!enumValues.reversibility.has(record.reversibilityDisposition) || !enumValues.confirmation.has(record.confirmationDisposition)) fail(`${record.actionRef} has an invalid enum disposition`);
    if (record.publicEffectCandidate && ('reversible' in record.publicEffectCandidate || record.publicEffectCandidate.reversibilityDisposition !== record.reversibilityDisposition)) fail(`${record.actionRef} coerces or misstates reversibility`);
    if (record.publicFinalityCandidate && ('confirmationRequired' in record.publicFinalityCandidate || 'undoable' in record.publicFinalityCandidate || record.publicFinalityCandidate.confirmationDisposition !== record.confirmationDisposition || record.publicFinalityCandidate.undoabilityDisposition !== record.reversibilityDisposition)) fail(`${record.actionRef} coerces or misstates finality`);

    if (record.actionRef === 'media.action.request-live-session-reconnect') {
      if (record.mappingReviewStatus !== 'BOUNDED_MEDIA_OWNER_MAPPING_REVIEWED' || record.mappingDecisionRef !== '.product-experience/decision-log.md#PXD-077'
        || record.publicEffectCandidate?.kind !== 'external-call' || record.publicEffectCandidate?.reversibilityDisposition !== 'UNKNOWN'
        || record.publicFinalityCandidate?.confirmationDisposition !== 'REQUIRED' || record.publicFinalityCandidate?.undoabilityDisposition !== 'UNKNOWN'
        || record.operationRefs.join('\0') !== 'media.operation.capability.media-stream-session-reconnect'
        || record.canonicalOperationFacts.length !== 1 || record.canonicalOperationFacts[0].operationKind !== 'COMMAND'
        || record.semanticRole !== 'DOMAIN_OPERATION') fail('reconnect candidate exceeds its exact PXD-077 bounded review');
      continue;
    }

    if (record.semanticRole === 'LOCAL_SELECTION_OR_SESSION_DRAFT') {
      if (record.operationRefs.length !== 0 || record.publicEffectCandidate?.kind !== 'state-change') fail(`${record.actionRef} local draft must have no operation and a local state-change candidate`);
    } else if (['DOMAIN_OPERATION', 'ORDERED_DOMAIN_WORKFLOW'].includes(record.semanticRole)) {
      if (record.operationRefs.length === 0) fail(`${record.actionRef} consequential action has no exact operation reference`);
      if (record.canonicalOperationFacts.some((fact) => fact.operationKind === 'QUERY') && record.publicEffectCandidate?.kind === 'state-change') fail(`${record.actionRef} query cannot map to state-change`);
      if (record.publicEffectCandidate && record.publicEffectCandidate.kind !== 'external-call') fail(`${record.actionRef} domain operation must map to external-call`);
    }

    if (originalIds.has(record.actionRef) && record.publicEffectCandidate && !record.semanticRole.startsWith('EXTERNAL_SHARED_IDENTITY_HANDOFF')) {
      if (record.mappingReviewStatus !== 'BOUNDED_MEDIA_OWNER_MAPPING_REVIEWED' || record.mappingDecisionRef !== '.product-experience/decision-log.md#PXD-078') fail(`${record.actionRef} lacks the exact PXD-078 bounded mapping disposition`);
      if (!expectedPxd078ActionIds.has(record.actionRef)) fail(`${record.actionRef} is outside the exact PXD-078 original action set`);
      reviewedOriginal += 1;
      reviewedOriginalIds.add(record.actionRef);
    }
    if (record.semanticRole.startsWith('EXTERNAL_SHARED_IDENTITY_HANDOFF')) {
      if (!sharedActionIds.has(record.actionRef) || record.publicEffectCandidate || record.publicFinalityCandidate || record.mappingDecisionRef !== null || record.mappingReviewStatus !== 'UNMAPPED_PENDING_EXACT_SHARED_ROLE_BINDING') fail(`${record.actionRef} Shared identity role was fabricated or coerced`);
    }
    if (record.runtimeAdmission !== 'NOT_ADMITTED' || record.publicTaxonomyDisposition === 'ACCEPTED') fail(`${record.actionRef} promotes runtime admission or public acceptance`);
  }
  if (reviewedOriginal !== 144) fail(`expected 144 PXD-078 mapped original actions, got ${reviewedOriginal}`);
  if (reviewedOriginalIds.size !== expectedPxd078ActionIds.size || [...expectedPxd078ActionIds].some((id) => !reviewedOriginalIds.has(id))) fail('PXD-078 mapped original action membership differs from all 146 originals minus the two exact Shared identity actions');
  return { actionCount: records.length, reviewedOriginalCount: reviewedOriginal, reviewedReconnectCount: 1 };
}
