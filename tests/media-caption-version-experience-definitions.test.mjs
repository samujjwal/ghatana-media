import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { resolveExperienceDefinitionSemantics } from '../scripts/lib/media-experience-definition-mapping.mjs';

const root = '.product-experience/pdp-3-product-experience';
const { parse } = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url))('yaml');
// Immutable parsed source baseline: main 42a08ca J03 steps 1 and 3; steps 2 and 4-6 have separate bounded definitions.
const originalPrefixDigest = '29e31f399968335a53cdf68a6ef778c729bbd018ca732bf79cc25dbefee3a298';
const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
const prefixDigest = (steps) => createHash('sha256').update(JSON.stringify(stable(steps))).digest('hex');
const readYaml = async (path) => parse(await readFile(path, 'utf8'));
const [journey, operationSource, actionRegistry, bindings, writeScreen, compareScreen, editScreen, journeyRegistry] = await Promise.all([
  readYaml(`${root}/journey-contracts/transcribe-and-correct-captions.yaml`),
  readYaml('.product-experience/pdp-1-domain-data/operations.yaml'),
  readYaml(`${root}/action-registry.yaml`),
  readYaml(`${root}/experience-source-bindings.yaml`),
  readYaml(`${root}/screen-contracts/correct-captions.yaml`),
  readYaml(`${root}/screen-contracts/compare-caption-versions.yaml`),
  readYaml(`${root}/screen-contracts/edit-captions.yaml`),
  readYaml(`${root}/journey-registry.yaml`),
]);
const operations = [...operationSource.operations, ...operationSource.individualOperationContracts.records];
const operation = (id) => operations.find((record) => record.id === id);
const action = (id) => actionRegistry.actions.find((record) => record.id === id);
const step7 = journey.steps.find(({ stepId }) => stepId === 'J03-7');
const step8 = journey.steps.find(({ stepId }) => stepId === 'J03-8');
const sourceDecision = '.product-experience/decision-log.md#PXD-058';
const grammarDecision = '.product-experience/decision-log.md#PXD-059';
const decision = '.product-experience/decision-log.md#PXD-060';

function assertSelectedBindings(j, ops, actions, source) {
  const records = new Map(ops.map((record) => [record.id, record]));
  const save = j.steps.find(({ stepId }) => stepId === 'J03-7');
  const compare = j.steps.find(({ stepId }) => stepId === 'J03-8');
  assert.equal(j.journeyId, 'J-03');
  assert.equal(j.steps.length, 8);
  assert.equal(prefixDigest([j.steps[0], j.steps[2]]), originalPrefixDigest,
    'J-03 steps1 and 3 retain the immutable main source baseline; step2 and steps4-6 have separate definition tests');
  assert.equal(save?.action, 'media.action.save-caption-version');
  assert.equal(save?.canonicalOperationRef, 'media.operation.caption-version-write');
  assert.deepEqual(save?.requiredOperationRefs, ['media.operation.caption-version-write']);
  assert.equal(save?.recovery.sourceRef, 'media.operation.caption-version-read');
  assert.equal(save?.recovery.selector, 'REGISTRATION_REQUEST with the same trusted tenantId, principalId, requestId, and full requestFingerprint');
  assert.equal(save?.decisionRef, decision);
  assert.equal(save?.transitionDisposition.status, 'NOT_APPLICABLE_WITH_REASON');
  assert.equal(save?.transitionDisposition.transitionRef, null);
  assert.equal(save?.definitionVerification.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(save?.definitionVerification.runtimeVerification, 'not-run');
  assert.equal(save?.verification.status, 'not-run');
  assert.deepEqual(save?.verification.actualEvidence, []);
  assert.ok(save?.objectRefs.includes('media.domain.caption-version'));
  assert.ok(save?.objectRefs.includes('media.domain.artifact-version'));
  assert.equal(compare?.action, 'media.action.compare-caption-versions');
  assert.equal(compare?.canonicalOperationRef, 'media.operation.caption-version-read');
  assert.deepEqual(compare?.requiredOperationRefs, ['media.operation.caption-version-read']);
  assert.equal(compare?.recovery.selector, 'EXACT_PAIR using the same leftCaptionVersionId and rightCaptionVersionId');
  assert.equal(compare?.decisionRef, decision);
  assert.equal(compare?.transitionDisposition.status, 'NOT_APPLICABLE_WITH_REASON');
  assert.equal(compare?.transitionDisposition.transitionRef, null);
  assert.equal(compare?.definitionVerification.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(compare?.verification.status, 'not-run');
  assert.deepEqual(compare?.verification.actualEvidence, []);
  assert.deepEqual(j.steps.slice(0, 6).map(({ action, canonicalOperationRef }) => [action, canonicalOperationRef]), [
    ['media.action.choose-source', null],
    ['media.action.request-transcription', 'media.operation.transcription-submission'],
    ['media.action.view-job-status', 'media.operation.job-lifecycle'],
    ['media.action.review-transcript', 'media.operation.transcript-version-read'],
    ['media.action.correct-caption', 'media.operation.caption-draft-write'],
    ['media.action.align-caption-timing', 'media.operation.caption-draft-write'],
  ]);
  assert.ok(records.has(save.canonicalOperationRef));
  assert.ok(records.has(save.recovery.sourceRef));
  assert.ok(records.has(compare.canonicalOperationRef));
  assert.deepEqual(records.get(save.canonicalOperationRef).inputSemantics.requiredFields, [
    'sourceArtifactId', 'sourceArtifactVersionId', 'parentVersionKind', 'parentVersionId', 'sourceClockId',
    'ticksPerSecond', 'sourceDurationTicks', 'languageDisposition', 'captionSegments', 'requestId',
  ]);
  assert.deepEqual(records.get(save.canonicalOperationRef).transition.transitionRefs, []);
  assert.deepEqual(records.get(compare.canonicalOperationRef).inputSemantics.selectorKindValues, ['EXACT_PAIR', 'REGISTRATION_REQUEST']);
  assert.deepEqual(records.get(compare.canonicalOperationRef).inputSemantics.selectorBranches.EXACT_PAIR.requiredFields,
    ['leftCaptionVersionId', 'rightCaptionVersionId']);
  assert.deepEqual(records.get(compare.canonicalOperationRef).inputSemantics.selectorBranches.REGISTRATION_REQUEST.requiredFields,
    ['requestId', 'requestFingerprint']);
  assert.deepEqual(records.get(compare.canonicalOperationRef).transition.transitionRefs, []);
  assert.match(save.recovery.proposal, /never retry automatically or use a new key/u);
  assert.match(compare.failure.proposal, /CAPTION_VERSIONS_NOT_COMPARABLE/u);
  assert.match(compare.failure.proposal, /unavailable, not equal/u);
  assert.match(compare.success.proposal, /source clock agree/u);
  assert.match(compare.success.proposal, /field-level comparison/u);
  assert.equal(source.j03CaptionVersionBindings.reviewDecisionRef, decision);
  assert.equal(source.j03CaptionVersionBindings.sourceDecisionRef, sourceDecision);
  assert.equal(source.j03CaptionVersionBindings.grammarDecisionRef, grammarDecision);
  assert.equal(source.j03CaptionVersionBindings.runtimeAdmission, 'NOT_ADMITTED');
  assert.deepEqual(source.j03CaptionVersionBindings.steps.map(({ stepId }) => stepId), ['J03-7', 'J03-8']);
  assert.deepEqual(source.j03CaptionVersionBindings.steps[0].domainObjectRefs, save.objectRefs);
  assert.deepEqual(source.j03CaptionVersionBindings.steps[1].domainObjectRefs, compare.objectRefs);
  assert.equal(source.j03CaptionVersionBindings.steps[0].recoverySelectorKind, 'REGISTRATION_REQUEST');
  assert.equal(source.j03CaptionVersionBindings.steps[1].selectorKind, 'EXACT_PAIR');
  assert.match(source.j03CaptionVersionBindings.steps[0].registrationSemantics,
    /sourceArtifactId\/sourceArtifactVersionId.*parentVersionKind\/parentVersionId/u);
  assert.match(source.j03CaptionVersionBindings.steps[0].replayAndFinality,
    /same tenant\/principal\/requestId and identical fingerprint/iu);
  assert.ok(source.j03CaptionVersionBindings.steps[1].prohibitedClaims.includes('approve-content'));

  const saveAction = actions.find(({ id }) => id === 'media.action.save-caption-version');
  const compareAction = actions.find(({ id }) => id === 'media.action.compare-caption-versions');
  assert.deepEqual(saveAction.capabilityRefs, ['media.artifact.output.register']);
  assert.ok(!saveAction.capabilityRefs.includes('media.artifact.provenance.export'));
  const saveSemantics = saveAction.actionDefinitionSemantics;
  assert.equal(saveSemantics.operationRef, 'media.operation.caption-version-write');
  assert.equal(saveSemantics.sourceDecisionRef, sourceDecision);
  assert.equal(saveSemantics.grammarDecisionRef, grammarDecision);
  assert.equal(saveSemantics.reviewDecisionRef, decision);
  assert.equal(saveSemantics.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(saveSemantics.reversibility.kind, 'NOT_REVERSIBLE');
  assert.equal(saveSemantics.publicEffect.reversible, false);
  assert.equal(saveSemantics.publicFinality.undoable, false);
  assert.match(saveSemantics.reversibility.scope, /not exported/u);
  assert.equal(compareAction.actionDefinitionSemantics.reversibility.kind, 'UNKNOWN');
  assert.equal(compareAction.actionDefinitionSemantics.publicBooleanDisposition, 'PUBLIC_BOOLEAN_NOT_REPRESENTABLE');
  assert.equal(compareAction.actionDefinitionSemantics.publicEffect, undefined);
  assert.equal(compareAction.actionDefinitionSemantics.publicFinality, undefined);
  assert.match(compareAction.actionDefinitionSemantics.reversibility.scope, /audit effects/u);
  assert.ok(!compareAction.effect.includes('select'));
  assert.ok(!compareAction.finality.includes('approve'));

  for (const [screen, exactOperation, objectRefs, actionId] of [
    [writeScreen, 'media.operation.caption-version-write', save.objectRefs, 'media.action.save-caption-version'],
    [compareScreen, 'media.operation.caption-version-read', compare.objectRefs, 'media.action.compare-caption-versions'],
  ]) {
    assert.ok(screen.operationRefs.includes(exactOperation));
    if (screen === writeScreen) assert.ok(screen.operationRefs.includes('media.operation.caption-draft-write'));
    if (screen === writeScreen) {
      assert.ok(objectRefs.every((reference) => screen.domainObjectRefs.includes(reference)));
      assert.ok(screen.domainObjectRefs.includes('media.domain.transcript-version'));
    } else {
      assert.deepEqual(screen.domainObjectRefs, objectRefs);
    }
    assert.equal(screen.journeyDefinitionBindings.decisionRef, decision);
    assert.equal(screen.journeyDefinitionBindings.runtimeAdmission, 'NOT_ADMITTED');
    const screenAction = screen.actionConsequences.find(({ actionId: id }) => id === actionId);
    assert.equal(screenAction.operationRef, exactOperation);
    assert.ok(screenAction.consequence !== 'unresolved');
  }
  assert.deepEqual(writeScreen.actionConsequences.find(({ actionId }) => actionId === 'media.action.save-caption-version').capabilityRefs,
    ['media.artifact.output.register']);
  assert.ok(!writeScreen.actionConsequences.find(({ actionId }) => actionId === 'media.action.save-caption-version').capabilityRefs
    .includes('media.artifact.provenance.export'));
  assert.deepEqual(editScreen.actionConsequences.find(({ actionId }) => actionId === 'media.action.save-caption-version').capabilityRefs,
    ['media.artifact.output.register']);
}

test('J-03 binds only existing save and exact-pair compare operations, preserving the global experience population', async () => {
  const journeyFiles = (await readdir(`${root}/journey-contracts`)).filter((file) => file.endsWith('.yaml'));
  let totalSteps = 0;
  for (const file of journeyFiles) totalSteps += (await readYaml(`${root}/journey-contracts/${file}`)).steps?.length ?? 0;
  assert.equal(journeyFiles.length, 30);
  assert.equal(totalSteps, 130);
  assert.equal(actionRegistry.actions.length, 146);
  assert.equal(journey.definitionReview.sourceDecisionRef, sourceDecision);
  assert.equal(journey.definitionReview.grammarDecisionRef, grammarDecision);
  assert.equal(journey.definitionReview.decisionRef, decision);
  assert.equal(journey.definitionReview.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(journeyRegistry.coverageObservation.stepBindings.verification.notRun, 130);
  assert.equal(journeyRegistry.coverageObservation.stepBindings.verification.evidenceRefsPresent, 0);
  assert.equal(journeyRegistry.coverageObservation.stepBindings.verification.sourceDefinitionCheckedSteps, 6);
  assert.equal(journeyRegistry.j03DefinitionReviewObservation.sourceDefinitionCheckedSteps, 2);
  assertSelectedBindings(journey, operations, actionRegistry.actions, bindings);
});

test('J-03 source bindings reject swapped lineage, unsafe request replay, promoted runtime, and provenance export', () => {
  const source = structuredClone(bindings);
  const save = source.j03CaptionVersionBindings.steps[0];
  const compare = source.j03CaptionVersionBindings.steps[1];
  assert.throws(() => {
    save.registrationSemantics = save.registrationSemantics.replace('sourceArtifactVersionId', 'parentVersionId');
    assert.match(save.registrationSemantics, /sourceArtifactId\/sourceArtifactVersionId.*parentVersionKind\/parentVersionId/u);
  }, /regular expression/u);
  assert.throws(() => {
    save.replayAndFinality = 'requestId only, omit requestFingerprint';
    assert.match(save.replayAndFinality, /same tenant\/principal\/requestId and identical fingerprint/iu);
  }, /regular expression/u);
  assert.throws(() => {
    compare.prohibitedClaims = compare.prohibitedClaims.filter((claim) => claim !== 'approve-content');
    assert.ok(compare.prohibitedClaims.includes('approve-content'));
  }, /approve-content/u);
  assert.throws(() => {
    source.j03CaptionVersionBindings.runtimeAdmission = 'ADMITTED';
    assertSelectedBindings(journey, operations, actionRegistry.actions, source);
  }, /NOT_ADMITTED/u);
  const forged = structuredClone(actionRegistry.actions);
  forged.find(({ id }) => id === 'media.action.save-caption-version').capabilityRefs.push('media.artifact.provenance.export');
  assert.throws(() => assertSelectedBindings(journey, operations, forged, bindings), /deepStrictEqual|Expected values/u);
});

test('PXD-060 projects only the exact immutable-registration effect and rejects forged action, operation, grammar, source, or admission', () => {
  const projection = resolveExperienceDefinitionSemantics(actionRegistry.actions, []);
  assert.equal(projection.effects.length, 3);
  assert.equal(projection.finality.length, 3);
  assert.deepEqual(projection.effects.find(({ id }) => id === 'media.effect.register-caption-version'),
    action('media.action.save-caption-version').actionDefinitionSemantics.publicEffect);
  assert.deepEqual(projection.finality.find(({ id }) => id === 'media.finality.register-caption-version'),
    action('media.action.save-caption-version').actionDefinitionSemantics.publicFinality);
  assert.ok(projection.conditionalActions.includes('media.action.compare-caption-versions'));

  const mutateSave = (mutate) => {
    const actions = structuredClone(actionRegistry.actions);
    const save = actions.find(({ id }) => id === 'media.action.save-caption-version');
    mutate(save);
    return actions;
  };
  for (const [label, mutate] of [
    ['wrong action', (save) => { save.actionDefinitionSemantics.actionRef = 'media.action.inspect-provenance'; }],
    ['wrong operation', (save) => { save.actionDefinitionSemantics.operationRef = 'media.operation.caption-version-read'; }],
    ['wrong grammar', (save) => { save.actionDefinitionSemantics.grammarDecisionRef = '.product-experience/decision-log.md#PXD-058'; }],
    ['wrong source', (save) => { save.actionDefinitionSemantics.sourceDecisionRef = '.product-experience/decision-log.md#PXD-059'; }],
    ['wrong review', (save) => { save.actionDefinitionSemantics.reviewDecisionRef = '.product-experience/decision-log.md#PXD-059'; }],
    ['forged admission', (save) => { save.actionDefinitionSemantics.runtimeAdmission = 'ADMITTED'; }],
  ]) {
    assert.throws(() => resolveExperienceDefinitionSemantics(mutateSave(mutate), []), /unbounded action review/u, label);
  }
  const forgedUnrelatedReview = structuredClone(actionRegistry.actions);
  const unrelated = forgedUnrelatedReview.find(({ id }) => id === 'media.action.inspect-provenance');
  unrelated.actionDefinitionSemantics = {
    ...action('media.action.save-caption-version').actionDefinitionSemantics,
    actionRef: unrelated.id,
  };
  assert.throws(() => resolveExperienceDefinitionSemantics(forgedUnrelatedReview, []), /unbounded action review/u,
    'PXD-060 cannot authorize an unrelated action');
  const falseBoolean = structuredClone(actionRegistry.actions);
  const compare = falseBoolean.find(({ id }) => id === 'media.action.compare-caption-versions');
  compare.actionDefinitionSemantics.publicEffect = {
    id: 'media.effect.false-reversible-read', name: 'Read', kind: 'other', description: 'read', reversible: true,
  };
  assert.throws(() => resolveExperienceDefinitionSemantics(falseBoolean, []), /conditional boolean coercion/u);
});
