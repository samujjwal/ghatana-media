import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const { parse } = createRequire(resolve(root, '../ghatana-tools/package.json'))('yaml');
const yaml = path => parse(readFileSync(resolve(root, path), 'utf8'));

const grammarPath = '.product-experience/pdp-2-design-interface-system/action-finality-grammar.yaml';
const operationsPath = '.product-experience/pdp-1-domain-data/operations.yaml';
const journeyPath = '.product-experience/pdp-3-product-experience/journey-contracts/transcribe-and-correct-captions.yaml';

function assertCaptionGrammar(grammar, records, journey) {
  assert.equal(grammar.decisionRef, '.product-experience/decision-log.md#PXD-059');
  assert.equal(grammar.journeyRef, '.product-experience/pdp-0-product-truth/journey-catalog.yaml#J-03');
  assert.equal(grammar.journeyContractRef, `${journeyPath}#journeyId`);
  assert.equal(grammar.runtimeAdmission, 'NOT_ADMITTED');
  assert.deepEqual(grammar.domainRefs, ['media.domain.caption-version', 'media.domain.artifact-version', 'media.domain.transcription']);
  assert.equal(grammar.authorityRefs.deploymentQualification, 'NOT_ADMITTED');

  const byId = new Map(records.map(record => [record.id, record]));
  const objects = new Set(yaml('.product-experience/pdp-1-domain-data/domain-objects.yaml').objects.map(item => item.id));
  for (const objectRef of grammar.domainRefs) assert.ok(objects.has(objectRef), `missing source domain object ${objectRef}`);
  const write = grammar.operations.registerCaptionVersion;
  const read = grammar.operations.compareCaptionVersions;
  const receipt = grammar.operations.registrationReceiptReconciliation;
  const writeSource = byId.get(write.operationRef);
  const readSource = byId.get(read.operationRef);
  assert.equal(write.operationRef, 'media.operation.caption-version-write');
  assert.equal(write.actionRef, 'media.action.save-caption-version');
  assert.equal(read.operationRef, 'media.operation.caption-version-read');
  assert.equal(read.actionRef, 'media.action.compare-caption-versions');
  assert.equal(receipt.operationRef, read.operationRef, 'receipt reconciliation reuses the existing read identity');
  assert.equal(receipt.actionRef, write.actionRef, 'registration receipt reconciliation belongs to save recovery');
  for (const ref of [write.operationRef, read.operationRef]) assert.ok(byId.has(ref), `missing canonical operation ${ref}`);
  for (const record of [byId.get(write.operationRef), byId.get(read.operationRef)]) {
    assert.ok(record, 'canonical PDP-1 operation must exist');
    assert.equal(record.ownerDefinitionRef, '.product-experience/decision-log.md#PXD-058');
    assert.match(record.scopeStatus, /runtime-NOT_ADMITTED/u);
  }
  assert.deepEqual(write.requiredFields, writeSource.inputSemantics.requiredFields);
  assert.deepEqual(write.optionalFields, writeSource.inputSemantics.optionalFields);
  assert.deepEqual(write.trustedContextFields, writeSource.inputSemantics.trustedHostFields);
  assert.deepEqual(write.segmentFields, writeSource.inputSemantics.segmentFields);
  assert.deepEqual(write.optionalSegmentFields, writeSource.inputSemantics.optionalSegmentFields);
  assert.deepEqual(write.successReceiptFields, writeSource.outputSemantics.successFields);
  assert.deepEqual(write.problemCodes, writeSource.error);
  assert.deepEqual(read.requestFields, readSource.inputSemantics.selectorBranches.EXACT_PAIR.requiredFields);
  assert.deepEqual(read.trustedContextFields, readSource.inputSemantics.trustedHostFields);
  assert.deepEqual(read.resultFields, readSource.outputSemantics.EXACT_PAIR.requiredFields);
  assert.deepEqual(read.problemCodes, readSource.error);
  assert.deepEqual(receipt.requestFields, readSource.inputSemantics.selectorBranches.REGISTRATION_REQUEST.requiredFields);
  assert.deepEqual(receipt.trustedContextFields, readSource.inputSemantics.trustedHostFields);
  assert.deepEqual(receipt.requiredResultFields, readSource.outputSemantics.REGISTRATION_REQUEST.requiredFields);
  assert.deepEqual(receipt.registrationOutcomeValues, readSource.outputSemantics.REGISTRATION_REQUEST.registrationOutcomeValues);
  assert.deepEqual(receipt.registeredFields, readSource.outputSemantics.REGISTRATION_REQUEST.registeredFields);
  assert.deepEqual(receipt.definitiveNoCommitFields, readSource.outputSemantics.REGISTRATION_REQUEST.definitiveNoCommitFields);

  assert.match(write.confirmation, /explicit-user-confirmation/u);
  assert.match(write.exactPayloadBinding, /requestId.*exact-canonical-fingerprint/u);
  assert.match(write.unknownOutcome, /same-requestId-and-payload-fingerprint/u);
  assert.match(write.unknownOutcome, /never-create-a-new-key/u);
  assert.deepEqual(write.parentRefKinds, ['TRANSCRIPT_VERSION', 'CAPTION_VERSION']);
  assert.ok(write.trustedContextFields.includes('tenantId') && write.trustedContextFields.includes('principalId'));
  assert.deepEqual(write.requiredFields, [
    'sourceArtifactId', 'sourceArtifactVersionId', 'parentVersionKind', 'parentVersionId', 'sourceClockId',
    'ticksPerSecond', 'sourceDurationTicks', 'languageDisposition', 'captionSegments', 'requestId',
  ]);
  assert.deepEqual(write.optionalFields, ['languageTag', 'purpose']);
  assert.deepEqual(write.segmentFields, ['segmentId', 'text', 'startTick', 'endTick', 'origin']);
  assert.deepEqual(write.optionalSegmentFields, ['speakerLabel']);
  assert.ok(write.requiredFields.includes('sourceArtifactVersionId') && write.requiredFields.includes('requestId'));
  assert.ok(write.segmentFields.includes('startTick') && write.segmentFields.includes('endTick'));
  assert.match(write.timing, /sourceClockId-with-ticksPerSecond-and-sourceDurationTicks/u);
  assert.match(write.finality, /does-not-approve-review-deliver-publish/u);
  assert.deepEqual(write.problemCodes, [
    'INVALID_REQUEST', 'ACCESS_DENIED', 'VERSION_REGISTRATION_NOT_ALLOWED', 'SOURCE_NOT_READY', 'CAPTION_DRAFT_EMPTY',
    'CAPTION_ALIGNMENT_REQUIRED', 'CAPTION_VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'UNAVAILABLE', 'UNKNOWN_OUTCOME',
  ]);

  assert.equal(read.selectorKind, 'EXACT_PAIR');
  assert.deepEqual(read.requestFields, ['leftCaptionVersionId', 'rightCaptionVersionId']);
  assert.match(read.comparisonBounds, /same-exact-sourceArtifactId-sourceArtifactVersionId-and-sourceClock/u);
  assert.match(read.finality, /read-only-observation.*no-merge-no-winning-version-no-review-approval/u);
  assert.match(read.mismatch, /CAPTION_VERSIONS_NOT_COMPARABLE/u);
  assert.deepEqual(read.problemCodes, [
    'INVALID_REQUEST', 'ACCESS_DENIED', 'CAPTION_VERSION_NOT_FOUND_IN_CALLER_SCOPE',
    'CAPTION_VERSIONS_NOT_COMPARABLE', 'UNAVAILABLE', 'UNKNOWN_OUTCOME',
  ]);
  assert.equal(receipt.selectorKind, 'REGISTRATION_REQUEST');
  assert.deepEqual(receipt.requestFields, ['requestId', 'requestFingerprint']);
  assert.deepEqual(receipt.registeredFields, [
    'captionVersionId', 'registrationReceiptId', 'originalSourceArtifactId', 'originalSourceArtifactVersionId',
    'originalParentVersionKind', 'originalParentVersionId', 'originalSourceClockId', 'originalTicksPerSecond',
  ]);
  assert.deepEqual(receipt.definitiveNoCommitFields, ['authoritativeNoCommitEvidenceRef', 'evidenceObservedAt']);
  assert.match(receipt.scope, /same-original-trusted-tenant-and-principal/u);
  assert.match(receipt.absentOrUnknown, /UNKNOWN_OUTCOME.*never-infers-no-effect-or-authorizes-blind-replay/u);

  const saveStep = journey.steps.find(step => step.action === 'media.action.save-caption-version');
  const compareStep = journey.steps.find(step => step.action === 'media.action.compare-caption-versions');
  assert.equal(saveStep?.canonicalOperationRef, write.operationRef);
  assert.equal(compareStep?.canonicalOperationRef, read.operationRef);
  assert.equal(saveStep?.definitionVerification?.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(compareStep?.definitionVerification?.runtimeAdmission, 'NOT_ADMITTED');
  assert.ok(journey.steps.filter(step => [write.operationRef, read.operationRef].includes(step.canonicalOperationRef))
    .every(step => step.decisionRef === '.product-experience/decision-log.md#PXD-060'));

  const actions = new Map(yaml('.product-experience/pdp-3-product-experience/action-registry.yaml').actions.map(action => [action.id, action]));
  for (const [actionId, operationRef] of [[write.actionRef, write.operationRef], [read.actionRef, read.operationRef]]) {
    const semantics = actions.get(actionId)?.actionDefinitionSemantics;
    assert.equal(semantics?.sourceDecisionRef, '.product-experience/decision-log.md#PXD-058');
    assert.equal(semantics?.grammarDecisionRef, '.product-experience/decision-log.md#PXD-059');
    assert.equal(semantics?.reviewDecisionRef, '.product-experience/decision-log.md#PXD-060');
    assert.equal(semantics?.operationRef, operationRef);
    assert.equal(semantics?.runtimeAdmission, 'NOT_ADMITTED');
  }
  assert.equal(saveStep?.recovery?.sourceRef, receipt.operationRef,
    'save recovery must use the existing read identity to reconcile its registration request');
  assert.match(saveStep?.recovery?.selector ?? '', /REGISTRATION_REQUEST/u);
}

test('J-03 caption save and comparison grammar binds exact existing operations and remains definition-only', () => {
  const grammar = yaml(grammarPath).boundedCaptionVersionSlice;
  const operationSource = yaml(operationsPath);
  const operations = [...operationSource.operations, ...operationSource.individualOperationContracts.records];
  const journey = yaml(journeyPath);
  assertCaptionGrammar(grammar, operations, journey);
});

test('caption grammar rejects runtime promotion, new transport identities, and unsafe write recovery', () => {
  const grammar = structuredClone(yaml(grammarPath).boundedCaptionVersionSlice);
  const operationSource = yaml(operationsPath);
  const operations = [...operationSource.operations, ...operationSource.individualOperationContracts.records];
  const journey = yaml(journeyPath);

  const admitted = structuredClone(grammar);
  admitted.runtimeAdmission = 'ADMITTED';
  assert.throws(() => assertCaptionGrammar(admitted, operations, journey), /NOT_ADMITTED/u);

  const inventedOperation = structuredClone(grammar);
  inventedOperation.operations.registerCaptionVersion.operationRef = 'media.operation.caption-version-reconcile';
  assert.throws(() => assertCaptionGrammar(inventedOperation, operations, journey), /caption-version-write/u);

  const unsafeRetry = structuredClone(grammar);
  unsafeRetry.operations.registerCaptionVersion.unknownOutcome = 'retry-with-new-requestId';
  assert.throws(() => assertCaptionGrammar(unsafeRetry, operations, journey), /same-requestId/u);

  const winnerClaim = structuredClone(grammar);
  winnerClaim.operations.compareCaptionVersions.finality = 'read-only and selects winning version';
  assert.throws(() => assertCaptionGrammar(winnerClaim, operations, journey), /no-merge-no-winning-version/u);
});

test('caption grammar keeps fixture CLI distinct and makes no unsupported interface claims', () => {
  const grammar = yaml(grammarPath).boundedCaptionVersionSlice;
  assert.deepEqual(grammar.observedChannels.web.actions, ['media.action.save-caption-version', 'media.action.compare-caption-versions']);
  assert.match(grammar.observedChannels.web.disposition, /does-not-claim-host-or-runtime-admission/u);
  assert.deepEqual(grammar.observedChannels.syntheticFixtureCli.commands, ['media.cli.caption.save-version', 'media.cli.caption.compare-versions']);
  assert.match(grammar.observedChannels.syntheticFixtureCli.disposition, /fixture-only/u);
  assert.match(grammar.observedChannels.httpSdkGrpcAgentToolEvents.disposition, /no-existing-matching-method-or-accepted-binding/u);
});
