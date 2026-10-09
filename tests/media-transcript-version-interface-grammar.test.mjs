import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const require = createRequire(resolve(root, '../ghatana-tools/package.json'));
const { parse } = require('yaml');
const yaml = path => parse(readFileSync(resolve(root, path), 'utf8'));
const grammarPath = '.product-experience/pdp-2-design-interface-system/action-finality-grammar.yaml';
const operationsPath = '.product-experience/pdp-1-domain-data/operations.yaml';
const journeyPath = '.product-experience/pdp-3-product-experience/journey-contracts/transcribe-and-correct-captions.yaml';

function assertTranscriptReviewGrammar(grammar, operations, journey, actions) {
  assert.equal(grammar.status,
    'bounded-definition-grammar-under-PXD-063; independent-PDP-review-and-runtime-admission-open');
  assert.equal(grammar.decisionRef, '.product-experience/decision-log.md#PXD-063');
  assert.equal(grammar.sourceDecisionRef, '.product-experience/decision-log.md#PXD-062');
  assert.equal(grammar.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(grammar.phaseAdmission, 'pending-independent-PDP2-review');
  assert.deepEqual(grammar.domainRefs, ['media.domain.transcript-version', 'media.domain.artifact-version']);

  const operation = operations.find(candidate => candidate.id === grammar.operation.operationRef);
  assert.equal(grammar.operation.operationRef, 'media.operation.transcript-version-read');
  assert.equal(grammar.operation.actionRef, 'media.action.review-transcript');
  assert.equal(grammar.operation.selectorKind, 'EXACT_TRANSCRIPT_VERSION');
  assert.ok(operation, 'grammar must bind the existing PDP-1 transcript read operation');
  assert.deepEqual(grammar.operation.requestFields, operation.inputSemantics.requiredFields);
  assert.deepEqual(grammar.operation.trustedContextFields, operation.inputSemantics.trustedHostFields);
  assert.deepEqual(grammar.operation.requiredResultFields, operation.outputSemantics.requiredFields);
  assert.deepEqual(grammar.operation.conditionalResultFields, operation.outputSemantics.conditionalFields);
  assert.deepEqual(grammar.operation.timingAvailabilityValues, operation.outputSemantics.timingAvailabilityValues);
  assert.deepEqual(grammar.operation.sourceClockAvailabilityValues, operation.outputSemantics.sourceClockAvailabilityValues);
  assert.deepEqual(grammar.operation.problemCodes, operation.error);
  assert.equal(grammar.authorityRefs.identity, operation.authority.trustedIdentityAndDelegationOwner);
  assert.equal(grammar.authorityRefs.readPolicy, operation.authority.currentTranscriptReadPolicyOwner);
  assert.equal(grammar.operation.journeyStepId, 'J03-4');

  assert.match(grammar.operation.authorization, /trusted-current-tenant-and-principal/u);
  assert.match(grammar.operation.authorization, /current-read-authority/u);
  assert.match(grammar.operation.resultBinding, /exact-requested-opaque-version/u);
  assert.match(grammar.operation.resultBinding, /no-synthesis-between-representations/u);
  assert.match(grammar.operation.uncertainty, /not-calibrated-correctness/u);
  assert.match(grammar.operation.timing, /original-unit/u);
  assert.match(grammar.operation.timing, /authoritative-source-mapping/u);
  assert.match(grammar.operation.finality, /read-only-unverified-transcript-observation/u);
  assert.match(grammar.operation.finality, /no-caption-registration/u);
  assert.match(grammar.operation.accessBoundary, /indistinguishable-in-caller-scope/u);
  assert.match(grammar.operation.unknownOutcome, /no-write-effect-exists-to-replay/u);
  assert.ok(grammar.operation.prohibited.includes('jobId-or-artifactId-or-latest-or-global-list-selector'));
  assert.ok(grammar.operation.prohibited.includes('infer-review-approval'));
  assert.ok(grammar.operation.prohibited.includes('mutate-or-publish-transcript'));

  const reviewStep = journey.steps.find(step => step.action === grammar.operation.actionRef);
  assert.ok(reviewStep, 'J-03 must contain the exact review action');
  assert.equal(reviewStep.stepId, grammar.operation.journeyStepId);
  assert.equal(reviewStep.canonicalOperationRef, grammar.operation.operationRef);
  assert.equal(reviewStep.sourceDecisionRef, '.product-experience/decision-log.md#PXD-062');
  assert.equal(reviewStep.grammarDecisionRef, '.product-experience/decision-log.md#PXD-063');
  assert.equal(reviewStep.decisionRef, '.product-experience/decision-log.md#PXD-064');
  assert.equal(reviewStep.definitionVerification?.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(reviewStep.actionBindingStatus, 'SOURCE_DEFINED_OWNER_ACCEPTED; runtime-admission-pending');

  const action = actions.find(candidate => candidate.id === grammar.operation.actionRef);
  assert.ok(action, 'review action must exist in the source action registry');
  assert.equal(action.actionDefinitionSemantics?.sourceDecisionRef, '.product-experience/decision-log.md#PXD-062');
  assert.equal(action.actionDefinitionSemantics?.grammarDecisionRef, '.product-experience/decision-log.md#PXD-063');
  assert.equal(action.actionDefinitionSemantics?.reviewDecisionRef, '.product-experience/decision-log.md#PXD-064');
  assert.equal(action.actionDefinitionSemantics?.operationRef, grammar.operation.operationRef);
  assert.equal(action.actionDefinitionSemantics?.runtimeAdmission, 'NOT_ADMITTED');
}

test('J-03 transcript review grammar binds the exact existing source operation and unverified read semantics', () => {
  const grammar = yaml(grammarPath).boundedTranscriptReviewSlice;
  const source = yaml(operationsPath);
  const operations = [...source.operations, ...source.individualOperationContracts.records];
  const journey = yaml(journeyPath);
  const actions = yaml('.product-experience/pdp-3-product-experience/action-registry.yaml').actions;
  assertTranscriptReviewGrammar(grammar, operations, journey, actions);
});

test('transcript review grammar rejects aliases, approval, fabricated uncertainty, and runtime promotion', () => {
  const grammar = structuredClone(yaml(grammarPath).boundedTranscriptReviewSlice);
  const source = yaml(operationsPath);
  const operations = [...source.operations, ...source.individualOperationContracts.records];
  const journey = yaml(journeyPath);
  const actions = yaml('.product-experience/pdp-3-product-experience/action-registry.yaml').actions;

  for (const selectorKind of ['JOB_ID', 'LATEST', 'GLOBAL_LIST']) {
    const invalid = structuredClone(grammar);
    invalid.operation.selectorKind = selectorKind;
    assert.throws(() => assertTranscriptReviewGrammar(invalid, operations, journey, actions), /EXACT_TRANSCRIPT_VERSION/u);
  }

  const promoted = structuredClone(grammar);
  promoted.runtimeAdmission = 'ADMITTED';
  assert.throws(() => assertTranscriptReviewGrammar(promoted, operations, journey, actions), /NOT_ADMITTED/u);

  const approval = structuredClone(grammar);
  approval.operation.finality = 'read-only observation and review approval';
  assert.throws(() => assertTranscriptReviewGrammar(approval, operations, journey, actions), /read-only-unverified-transcript-observation/u);

  const inferredClock = structuredClone(grammar);
  inferredClock.operation.timing = 'infer SOURCE_CLOCK_BOUND from provider milliseconds';
  assert.throws(() => assertTranscriptReviewGrammar(inferredClock, operations, journey, actions), /original-unit/u);

  const wrongOperation = structuredClone(grammar);
  wrongOperation.operation.operationRef = 'media.operation.caption-version-write';
  assert.throws(() => assertTranscriptReviewGrammar(wrongOperation, operations, journey, actions), /transcript-version-read/u);
});

test('transcript review makes no unsupported transport or fixture availability claim', () => {
  const grammar = yaml(grammarPath).boundedTranscriptReviewSlice;
  assert.match(grammar.observedChannels.web.disposition, /local-ui-source-observed-only/u);
  assert.match(grammar.observedChannels.syntheticFixtureCli.disposition, /fixture-only/u);
  assert.match(grammar.observedChannels.httpSdkAgentToolGrpcEvents.disposition, /unresolved/u);
  assert.match(grammar.observedChannels.httpSdkAgentToolGrpcEvents.disposition, /no-current-method-or-equivalence-claim/u);
  assert.equal(grammar.runtimeAdmission, 'NOT_ADMITTED');
});
