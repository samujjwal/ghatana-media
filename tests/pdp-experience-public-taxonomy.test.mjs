import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { validateMediaPublicTaxonomyCandidates } from '../scripts/lib/media-public-taxonomy-candidates.mjs';

const toolsRequire = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url));
const { parse } = toolsRequire('yaml');
const [actionsDoc, operationsDoc, taxonomy] = await Promise.all([
  readFile('.product-experience/pdp-3-product-experience/action-registry.yaml', 'utf8').then(parse),
  readFile('.product-experience/pdp-1-domain-data/operations.yaml', 'utf8').then(parse),
  readFile('.product-experience/pdp-3-product-experience/public-effect-finality-taxonomy.yaml', 'utf8').then(parse),
]);
const generatedProjection = JSON.parse(await readFile('.product-experience/pdp-3-product-experience/generated/experience-specification.candidate.json', 'utf8'));

test('PDP-3 public effect and finality candidates cover every action without coercing unresolved truth', () => {
  const actions = [...actionsDoc.actions, ...(actionsDoc.ownerDefinedActions ?? [])];
  assert.equal(actions.length, 147);
  assert.equal(taxonomy.records.length, actions.length);
  assert.equal(new Set(taxonomy.records.map((record) => record.id)).size, actions.length);
  assert.equal(new Set(taxonomy.records.map((record) => record.actionRef)).size, actions.length);
  const byId = new Map(actions.map((action) => [action.id, action]));
  const operationById = new Map();
  for (const operation of operationsDoc.operations ?? []) operationById.set(operation.id, operation);
  for (const group of ['capabilityOperationContracts', 'individualOperationContracts', 'ownerDefinedOperationContracts']) {
    for (const operation of operationsDoc[group]?.records ?? []) {
      for (const ref of operation.operationRefs ?? [operation.id]) operationById.set(ref, operation);
    }
  }

  for (const record of taxonomy.records) {
    assert.match(record.id, /^media\.public-taxonomy\.[a-z0-9-]+$/u);
    const action = byId.get(record.actionRef);
    assert.ok(action, `taxonomy row ${record.actionRef} must bind a source action`);
    const typed = action.actionDefinitionSemantics?.typedDefinition;
    assert.deepEqual(record.operationRefs, typed?.exactOperationRefs ?? []);
    assert.deepEqual(record.canonicalOperationFacts.map((fact) => fact.operationRef), record.operationRefs);
    for (const fact of record.canonicalOperationFacts) {
      const source = operationById.get(fact.operationRef);
      assert.ok(source, `${record.actionRef} operation ${fact.operationRef} must resolve to a canonical source record`);
      assert.equal(fact.operationKind, source.operationKind, `${fact.operationRef} kind must match canonical source`);
      assert.ok(['COMMAND', 'QUERY'].includes(fact.operationKind));
    }
    assert.equal(record.sourceEffect, action.effect);
    assert.equal(record.sourceFinality, action.finality);
    assert.equal(record.sourceReversibilityDeclaration, action.reversible);
    assert.equal(record.reversibilityDisposition, typed?.reversibilityDisposition ?? null);
    assert.equal(record.confirmationDisposition, typed?.confirmationDisposition ?? null);
    if (record.publicEffectCandidate) {
      assert.ok(['state-change', 'external-call'].includes(record.publicEffectCandidate.kind));
      assert.equal(record.publicEffectCandidate.reversibilityDisposition, record.reversibilityDisposition);
      assert.equal('reversible' in record.publicEffectCandidate, false, `${record.actionRef} must not coerce an enum to a legacy boolean`);
    }
    if (record.publicFinalityCandidate) {
      assert.equal(record.publicFinalityCandidate.undoabilityDisposition, record.reversibilityDisposition);
      assert.equal(record.publicFinalityCandidate.confirmationDisposition, record.confirmationDisposition);
      assert.equal('undoable' in record.publicFinalityCandidate, false, `${record.actionRef} must not coerce undoability`);
      assert.equal('confirmationRequired' in record.publicFinalityCandidate, false, `${record.actionRef} must not coerce confirmation`);
      assert.equal(record.mappingReviewStatus, 'BOUNDED_MEDIA_OWNER_MAPPING_REVIEWED');
      assert.equal(record.mappingDecisionRef, record.actionRef === 'media.action.request-live-session-reconnect'
        ? '.product-experience/decision-log.md#PXD-077'
        : '.product-experience/decision-log.md#PXD-078');
    } else {
      assert.equal(record.mappingReviewStatus, 'UNMAPPED_PENDING_EXACT_SHARED_ROLE_BINDING');
    }
  }

  assert.equal(taxonomy.projectionPolicy.status, 'OWNER_MAPPING_PENDING_REVIEW');
  assert.match(taxonomy.projectionPolicy.phaseAcceptance, /separate/u);
  assert.equal(taxonomy.records.filter((record) => !record.publicEffectCandidate).length, 2);
  assert.equal(taxonomy.records.filter((record) => record.mappingReviewStatus === 'BOUNDED_MEDIA_OWNER_MAPPING_REVIEWED').length, 145);
  assert.equal(taxonomy.records.filter((record) => record.mappingDecisionRef === '.product-experience/decision-log.md#PXD-078').length, 144);
  assert.equal(taxonomy.records.filter((record) => record.mappingDecisionRef === '.product-experience/decision-log.md#PXD-077').length, 1);
  assert.equal(taxonomy.toolsSchemaBoundary.effectDefinition.reversibilityDispositionEnum.includes('UNKNOWN'), true);
  assert.equal(taxonomy.toolsSchemaBoundary.finalityDefinition.confirmationDispositionEnum.includes('UNRESOLVED'), true);
});

test('generated experience candidate projects 145 bounded mappings and preserves the three historical public IDs', () => {
  const model = generatedProjection.candidateModel;
  assert.equal(generatedProjection.projectionKind, 'experience-specification');
  assert.equal(generatedProjection.validation.schemaValid, true);
  assert.equal(generatedProjection.validation.publicValidatorPassed, true);
  assert.equal(model.actions.length, 147);
  assert.equal(model.effects.length, 145);
  assert.equal(model.finality.length, 145);
  assert.equal(model.actions.filter((action) => action.producesEffectRefs.length).length, 145);
  assert.deepEqual(model.effects.filter((effect) => effect.id.startsWith('media.effect.')).map((effect) => effect.id).sort(), [
    'media.effect.attach-source-version', 'media.effect.create-empty-project', 'media.effect.register-caption-version',
  ]);
  for (const effect of model.effects.filter((entry) => entry.id.startsWith('media.public-taxonomy.'))) {
    assert.ok(['REVERSIBLE', 'NOT_REVERSIBLE', 'CONDITIONAL', 'UNKNOWN'].includes(effect.reversibilityDisposition));
    assert.equal('reversible' in effect, false);
  }
  for (const entry of model.finality.filter((row) => row.id.startsWith('media.public-taxonomy.'))) {
    assert.ok(['REQUIRED', 'NOT_REQUIRED', 'UNRESOLVED'].includes(entry.confirmationDisposition));
    assert.ok(['REVERSIBLE', 'NOT_REVERSIBLE', 'CONDITIONAL', 'UNKNOWN'].includes(entry.undoabilityDisposition));
    assert.equal('confirmationRequired' in entry, false);
    assert.equal('undoable' in entry, false);
  }
  assert.deepEqual(generatedProjection.candidateMappingReview.definitionSemantics.unmappedPublicActions.sort(), [
    'media.action.select-identity-confirmed-workspace', 'media.action.start-upstream-identity-handoff',
  ]);
  assert.equal(generatedProjection.acceptance, 'NOT_CLAIMED');
});

test('PXD-078 candidate validation rejects forged or stale source mapping mutations', () => {
  const source = { actions: actionsDoc, operations: operationsDoc };
  assert.deepEqual(validateMediaPublicTaxonomyCandidates({ taxonomy, ...source }), { actionCount: 147, reviewedOriginalCount: 144, reviewedReconnectCount: 1 });
  const clone = () => structuredClone(taxonomy);
  const mapped = taxonomy.records.find((record) => record.publicEffectCandidate);
  const query = taxonomy.records.find((record) => record.canonicalOperationFacts.some((fact) => fact.operationKind === 'QUERY'));
  const reconnect = taxonomy.records.find((record) => record.actionRef === 'media.action.request-live-session-reconnect');
  const shared = taxonomy.records.find((record) => record.semanticRole.startsWith('EXTERNAL_SHARED_IDENTITY_HANDOFF'));

  let altered = clone();
  altered.records.find((record) => record.id === mapped.id).operationRefs.push('media.operation.forged');
  assert.throws(() => validateMediaPublicTaxonomyCandidates({ taxonomy: altered, ...source }), /operation refs disagree with source/u);

  altered = clone();
  altered.records.find((record) => record.id === mapped.id).sourceEnvelopeSha256 = '0'.repeat(64);
  assert.throws(() => validateMediaPublicTaxonomyCandidates({ taxonomy: altered, ...source }), /source envelope digest is stale or forged/u);

  altered = clone();
  altered.records.find((record) => record.id === mapped.id).sourceEnvelopeRef = '.product-experience/pdp-3-product-experience/action-registry.yaml#forged';
  assert.throws(() => validateMediaPublicTaxonomyCandidates({ taxonomy: altered, ...source }), /source envelope reference is stale or forged/u);

  altered = clone();
  const queryCandidate = altered.records.find((record) => record.id === query.id);
  queryCandidate.publicEffectCandidate.kind = 'state-change';
  assert.throws(() => validateMediaPublicTaxonomyCandidates({ taxonomy: altered, ...source }), /query cannot map to state-change/u);

  altered = clone();
  altered.records.find((record) => record.id === mapped.id).reversibilityDisposition = mapped.reversibilityDisposition === 'REVERSIBLE' ? 'UNKNOWN' : 'REVERSIBLE';
  assert.throws(() => validateMediaPublicTaxonomyCandidates({ taxonomy: altered, ...source }), /reversibility disposition disagrees/u);

  altered = clone();
  const reconnectCandidate = altered.records.find((record) => record.id === reconnect.id);
  reconnectCandidate.publicEffectCandidate.kind = 'state-change';
  assert.throws(() => validateMediaPublicTaxonomyCandidates({ taxonomy: altered, ...source }), /reconnect candidate exceeds/u);

  altered = clone();
  const sharedCandidate = altered.records.find((record) => record.id === shared.id);
  sharedCandidate.publicEffectCandidate = { kind: 'external-call', reversibilityDisposition: sharedCandidate.reversibilityDisposition };
  assert.throws(() => validateMediaPublicTaxonomyCandidates({ taxonomy: altered, ...source }), /Shared identity role was fabricated/u);
});

test('PXD-078 membership is exactly the original 146 minus both Shared handoffs; PXD-077 is reconnect alone', () => {
  const source = { actions: actionsDoc, operations: operationsDoc };
  const originalActionIds = new Set(actionsDoc.actions.map((action) => action.id));
  const sharedIds = new Set(['media.action.select-identity-confirmed-workspace', 'media.action.start-upstream-identity-handoff']);
  const expected078 = new Set([...originalActionIds].filter((id) => !sharedIds.has(id)));
  const actual078 = new Set(taxonomy.records.filter((record) => record.mappingDecisionRef === '.product-experience/decision-log.md#PXD-078').map((record) => record.actionRef));
  assert.deepEqual(actual078, expected078);
  assert.deepEqual(taxonomy.records.filter((record) => record.mappingDecisionRef === '.product-experience/decision-log.md#PXD-077').map((record) => record.actionRef), ['media.action.request-live-session-reconnect']);

  const altered = structuredClone(taxonomy);
  const transcription = altered.records.find((record) => record.actionRef === 'media.action.request-transcription');
  const shared = altered.records.find((record) => record.actionRef === 'media.action.select-identity-confirmed-workspace');
  transcription.publicEffectCandidate = null;
  transcription.publicFinalityCandidate = null;
  transcription.mappingReviewStatus = 'UNMAPPED_PENDING_EXACT_SHARED_ROLE_BINDING';
  transcription.mappingDecisionRef = null;
  shared.publicEffectCandidate = { kind: 'external-call', reversibilityDisposition: shared.reversibilityDisposition };
  shared.publicFinalityCandidate = { confirmationDisposition: shared.confirmationDisposition, undoabilityDisposition: shared.reversibilityDisposition };
  shared.mappingReviewStatus = 'BOUNDED_MEDIA_OWNER_MAPPING_REVIEWED';
  shared.mappingDecisionRef = '.product-experience/decision-log.md#PXD-078';
  assert.equal(altered.records.filter((record) => record.mappingDecisionRef === '.product-experience/decision-log.md#PXD-078').length, 144, 'substitution preserves the mapping count');
  assert.throws(() => validateMediaPublicTaxonomyCandidates({ taxonomy: altered, ...source }), /Shared identity role was fabricated or coerced|exact PXD-078 original action set|coerces or misstates reversibility/u);
});

test('PDP-3 taxonomy candidates never claim runtime admission or operation success', () => {
  for (const record of taxonomy.records) {
    assert.equal(record.runtimeAdmission, 'NOT_ADMITTED');
    assert.match(record.reason, /not operation success or runtime admission|no effect is inferred|no public effect is inferred|no Media domain operation is dispatched|does not imply session restoration|do not claim session restoration/u);
    assert.notEqual(record.publicTaxonomyDisposition, 'ACCEPTED');
  }
});

test('J-29 reconnect action binds exact canonical input, trusted identity, authority, and receipt semantics', async () => {
  const reconnect = actionsDoc.ownerDefinedActions.find((action) => action.id === 'media.action.request-live-session-reconnect');
  assert.ok(reconnect);
  const contract = operationsDoc.capabilityOperationContracts.records.find((operation) =>
    operation.id === 'media.operation.capability.media-stream-session-reconnect');
  assert.ok(contract);
  assert.equal(reconnect.operationRef, contract.id);
  assert.equal(reconnect.operationKind, contract.operationKind);
  assert.equal(reconnect.requestSemantics.sourceContractRef,
    '.product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts.records/media.operation.capability.media-stream-session-reconnect');
  assert.deepEqual(reconnect.requestSemantics.requiredInputs.hostContext.map(({ field, source }) => [field, source]), [
    ['tenantId', 'HOST_ATTESTED_TRUSTED_CONTEXT'],
    ['principalId', 'HOST_ATTESTED_TRUSTED_CONTEXT'],
    ['delegationRefs', 'HOST_ATTESTED_TRUSTED_CONTEXT'],
  ]);
  assert.deepEqual(reconnect.requestSemantics.requiredInputs.serverDerived, [{
    field: 'requestFingerprint', source: 'SERVER_COMPUTED_FROM_TRUSTED_IDENTITY_AND_CANONICAL_REQUEST_BODY', callerMaySupply: false,
  }]);
  const request = contract.requestSchema;
  assert.ok(!Object.hasOwn(request.properties, 'tenantId'));
  assert.ok(!Object.hasOwn(request.properties, 'principalId'));
  assert.ok(!Object.hasOwn(request.properties, 'requestFingerprint'));
  assert.equal(request.trustedContextRef, 'media.capability-contract-envelope.request.v1#trustedContext');
  assert.deepEqual(contract.requestIdentitySemantics.trustedContext.fields, ['tenantId', 'principalId', 'delegationRefs']);
  assert.deepEqual(contract.requestIdentitySemantics.serverComputed.fields, ['requestFingerprint']);
  assert.ok(contract.resultSchema.properties.reconnectReceipt.required.includes('requestFingerprint'));
  assert.ok(contract.resultSchema.properties.reconnectReceipt.required.includes('streamSessionRef'));
  assert.ok(contract.resultSchema.properties.reconnectReceipt.required.includes('leaseVersion'));
  assert.ok(contract.resultSchema.properties.reconnectReceipt.required.includes('resolvedFrameOutcomeRefs'));
  assert.ok(contract.resultSchema.required.includes('outcome'));

  const require = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url));
  const { parse } = require('yaml');
  const privacy = parse(await readFile('.product-experience/pdp-1-domain-data/privacy.yaml', 'utf8'));
  const sourceEnvelope = reconnect.actionDefinitionSemantics.sourceEnvelope;
  assert.ok(privacy.ownerDefinedPdp10Boundary.consentRevocation);
  assert.ok(privacy.ownerDefinedPdp10Boundary.duplicateEffectPrevention);
  assert.ok(sourceEnvelope.authorityRefs.includes('.product-experience/pdp-1-domain-data/privacy.yaml#ownerDefinedPdp10Boundary.consentRevocation'));
  assert.ok(sourceEnvelope.authorityRefs.includes('.product-experience/pdp-1-domain-data/privacy.yaml#ownerDefinedPdp10Boundary.duplicateEffectPrevention'));
  assert.ok(!sourceEnvelope.authorityRefs.some((ref) => ref.includes('effectBoundary.consentRevocation') || ref.includes('effectBoundary.duplicateEffectPrevention')));
  const budget = reconnect.ownerGuardDefinitions.find((guard) => guard.id === 'media.guard.stream.reconnect.budget-available')?.recoveryBudgetDefinition;
  assert.equal(budget.id, 'media.policy.stream.reconnect-budget.v1');
  assert.deepEqual(budget.dispositionEnum, ['CURRENT', 'EXHAUSTED', 'EXPIRED', 'UNKNOWN']);
  assert.match(budget.remainingReconnectRequests, /positive safe integer/u);
  assert.match(budget.deadlineEpochMilliseconds, /later than the authoritative observation time/u);
  assert.equal(sourceEnvelope.recoveryBudgetPolicyRef, budget.id);
  assert.match(sourceEnvelope.recoveryBudgetFactContract.holdWhen, /missing, unknown, malformed, expired, exhausted, or identity\/policy mismatched/u);
});
