import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  pdp1OwnerStatusJoinObservation,
  pdp1SemanticDefinitionPinDisposition,
  validateCurrentCutOwnerDirections,
  validateCurrentCutSourceImpactRecord,
  validatePdp1AdditionalSourceImpactRecord,
  validatePdp1InterfaceReviewImpactRecord,
  validatePdp1OwnerWireImpactRecord,
  validatePdp1StatusTestImpactRecord,
  loadPdp1OwnerWireImpactInput,
  validatePdp1OperationDefinitionDelta,
  validatePdp1SupplementalPinDispositions,
  validatePdp1SourcePredecessor,
  validatePdp1ThreeSourceTransitionDisposition,
  validatePdp1ThreeReviewSourceTransition,
  validatePdp0Predecessor,
} from '../scripts/record-media-discovery-pdp1-phase-exit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
const currentPdp1 = readJson('docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r10.json');
const pdp0Path = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r10.json';
const pdp0CurrentnessPath = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r10.json';
const pdp0 = readJson(pdp0Path);
const pdp0Currentness = readJson(pdp0CurrentnessPath);
const pdp0R11Path = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r11.json';
const pdp0R11CurrentnessPath = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r11.json';
const pdp0R11 = readJson(pdp0R11Path);
const pdp0R11Currentness = readJson(pdp0R11CurrentnessPath);
const reporterImpactPath = 'docs/implementation/observations/media-discovery-predecessor-impact-pdp3-status-guard-2026-10-14-r1.json';
const adapterImpactPath = 'docs/implementation/observations/media-discovery-pdp1-adapter-test-pin-impact-2026-10-14-r1.json';
const parityTestImpactPath = 'docs/implementation/observations/media-discovery-pdp1-parity-test-pin-impact-2026-10-14-r1.json';
const requiredPdp1TestCommand = 'node --test tests/media-pdp-p1-dev-status.test.mjs tests/media-contract-parity.test.mjs tests/media-contract-parity-definition-only-cli.test.mjs tests/pdp1-owner-action-wire-contracts.test.mjs tests/pdp1-transition-guard-definition-evaluator.test.mjs tests/pdp-truth-domain-typed-observations.test.mjs';
const operationsPath = '.product-experience/pdp-1-domain-data/operations.yaml';
const operationsReviewPath = '.product-experience/pdp-1-domain-data/operations-current-source-review.json';
const ownerDirectionsPath = 'docs/implementation/observations/media-discovery-current-cut-owner-directions-2026-10-13-r2.json';
const status = readJson('docs/implementation/pdp-1-phase-dev-status.json');
const semanticReview = readJson('docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json');
const reporterImpact = readJson(reporterImpactPath);
const currentCutSourceImpactPath = 'docs/implementation/observations/media-discovery-current-cut-source-impact-2026-10-14-r1.json';
const currentCutSourceImpact = readJson(currentCutSourceImpactPath);
const additionalSourceImpactPath = 'docs/implementation/observations/media-discovery-current-cut-source-impact-2026-10-14-r2.json';
const additionalSourceImpact = readJson(additionalSourceImpactPath);
const ownerWireImpactPath = 'docs/implementation/observations/media-discovery-current-cut-source-impact-2026-10-14-r5.json';
const ownerWireImpact = readJson(ownerWireImpactPath);
const statusTestImpactPath = 'docs/implementation/observations/media-discovery-current-cut-source-impact-2026-10-14-r6.json';
const statusTestImpact = readJson(statusTestImpactPath);
const threeSourceTransitionPath = 'docs/implementation/observations/media-pdp1-three-source-transition-no-meaning-disposition-2026-10-14.json';
const threeSourceTransition = readJson(threeSourceTransitionPath);
const threeReviewTransitionPath = 'docs/implementation/observations/media-discovery-pdp1-three-review-source-transition-2026-10-14.json';
const threeReviewTransition = readJson(threeReviewTransitionPath);
const interfaceReviewImpactPath = 'docs/implementation/observations/media-discovery-current-cut-source-impact-2026-10-14-r4.json';
const interfaceReviewImpact = readJson(interfaceReviewImpactPath);
const currentCutTestRun = readJson('docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r10.json').testRun;
const adapterImpact = readJson(adapterImpactPath);
const parityTestImpact = readJson(parityTestImpactPath);

function observedPdp1Digests() {
  return {
    ...currentPdp1.sourceCurrentness.sourceContentDigests,
    '.product-experience/pdp-1-domain-data/operations.yaml': 'sha256:317878be9ebe9c978f356a4e81060620fcb69af02ea25c2ff1d47bd20180c069',
    '.product-experience/pdp-1-domain-data/operations-current-source-review.json': 'sha256:71a27400d00faccba8643393259c1322861593783015426b6eeddbcf068afaf2',
    'scripts/report-media-pdp-readiness.mjs': 'sha256:ca59f6c4e1313bd58387f91b41eb51fc1a10ac04b2db01faed30b9edcc9b2573',
    '.product-experience/interface-parity/current-source-review.json': 'sha256:62765cbb335572f28570fe650b3955aaa028f314322490e17e466d3ca9234abf',
    'tests/media-pdp-p1-dev-status.test.mjs': `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'tests/media-pdp-p1-dev-status.test.mjs'))).digest('hex')}`,
  };
}

function currentR13ObservedPdp1Digests() {
  const predecessor = readJson('docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r13.json');
  return { ...predecessor.sourceCurrentness.sourceContentDigests };
}

function liveDigestMapFrom(sourceDigests) {
  const live = {};
  for (const sourcePath of Object.keys(sourceDigests)) {
    live[sourcePath] = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, sourcePath))).digest('hex')}`;
  }
  return live;
}

function threeSourceTransitionInputs(record = structuredClone(threeSourceTransition)) {
  const r16 = readJson('docs/implementation/observations/media-discovery-pdp1-exit-current-cut-r16.json');
  const observedDigests = liveDigestMapFrom(r16.sourceCurrentness.sourceContentDigests);
  return {
    record,
    observedDigests,
    statusPins: status.sourceShaSet,
    semanticPins: semanticReview.sourceFingerprints,
    recordPath: threeSourceTransitionPath,
  };
}

function threeReviewTransitionInputs(record = structuredClone(threeReviewTransition)) {
  const r16 = readJson('docs/implementation/observations/media-discovery-pdp1-exit-current-cut-r16.json');
  return {
    record,
    observedDigests: liveDigestMapFrom(r16.sourceCurrentness.sourceContentDigests),
    statusPins: status.sourceShaSet,
    semanticPins: semanticReview.sourceFingerprints,
    recordPath: threeReviewTransitionPath,
  };
}

function statusTestImpactInputs(record = structuredClone(statusTestImpact)) {
  return {
    record,
    observedDigests: currentR13ObservedPdp1Digests(),
    historicalDigests: readJson('docs/implementation/observations/media-discovery-pdp1-exit-2026-10-13-r3.json').sourceCurrentness.sourceContentDigests,
    statusPins: status.sourceShaSet,
    semanticPins: semanticReview.sourceFingerprints,
  };
}

test('PDP-1 R6 preserves its immutable historical 3ff-to-5201 status-test disposition', () => {
  const input = statusTestImpactInputs();
  const r16 = readJson('docs/implementation/observations/media-discovery-pdp1-exit-current-cut-r16.json');
  input.observedDigests = { ...r16.sourceCurrentness.sourceContentDigests };
  const historical = validatePdp1StatusTestImpactRecord(input.record, input);
  assert.equal(input.record.sourceDelta.path, 'tests/media-pdp-p1-dev-status.test.mjs');
  assert.equal(input.record.sourceDelta.predecessorSha256, 'sha256:3ff1576a4a3987f5b1e05d15ae77e35a62745260e127ebcb28c1bb49ef7ef82e');
  assert.equal(input.record.sourceDelta.observedSha256, 'sha256:5201e4b1915f35594641f8683ee3c499bb563259ed5f3387f027ce787bf0899d');
  assert.equal(input.record.authority.authorizationEvidence.predecessorSha256, input.record.sourceDelta.predecessorSha256);
  assert.equal(input.record.authority.authorizationEvidence.observedSha256, input.record.sourceDelta.observedSha256);
  assert.equal(historical.valid, true, JSON.stringify(historical));
  assert.equal(historical.digest, `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, statusTestImpactPath))).digest('hex')}`);
});

test('PDP-1 validates the exact R16-to-current three-source no-meaning disposition', () => {
  const input = threeSourceTransitionInputs();
  const accepted = validatePdp1ThreeSourceTransitionDisposition(input.record, input);
  assert.equal(accepted.valid, true, JSON.stringify(accepted));
  assert.equal(input.record.predecessor.exitRef, 'docs/implementation/observations/media-discovery-pdp1-exit-current-cut-r16.json');
  assert.equal(input.record.predecessor.exitSha256, 'sha256:63ee158301047bd715b586c41368a4d576a0b1e224672d08e2ced08349ad00fc');
  assert.equal(accepted.transitionCount, 3);
  assert.equal(accepted.meaningDisposition, 'NO_PRODUCT_MEANING_CHANGE_FOR_THE_THREE_EXACT_TRANSITIONS');

  const postTransitionRefreshStatusPins = { ...input.statusPins };
  const postTransitionRefreshSemanticPins = { ...input.semanticPins };
  for (const transition of input.record.sourceTransitions) {
    postTransitionRefreshStatusPins[transition.path] = input.observedDigests[transition.path];
    postTransitionRefreshSemanticPins[transition.path] = input.observedDigests[transition.path];
  }
  const refreshed = validatePdp1ThreeSourceTransitionDisposition(input.record, {
    ...input,
    statusPins: postTransitionRefreshStatusPins,
    semanticPins: postTransitionRefreshSemanticPins,
  });
  assert.equal(refreshed.valid, true, JSON.stringify(refreshed));

  const assertRejected = (mutate, override = {}) => {
    const invalid = threeSourceTransitionInputs();
    mutate(invalid.record, invalid);
    assert.equal(validatePdp1ThreeSourceTransitionDisposition(invalid.record, { ...invalid, ...override }).valid, false);
  };
  assertRejected((record) => { record.sourceTransitions[0].path = operationsPath; });
  assertRejected((record) => { record.sourceTransitions[0].observedSha256 = `sha256:${'f'.repeat(64)}`; });
  assertRejected((record) => { record.sourceTransitions.reverse(); });
  assertRejected((record) => { record.sourceTransitions.pop(); });
  assertRejected((record, invalid) => { invalid.observedDigests[record.sourceTransitions[0].path] = `sha256:${'f'.repeat(64)}`; });
  assertRejected((record, invalid) => {
    const pins = { ...invalid.statusPins, [record.sourceTransitions[0].path]: `sha256:${'f'.repeat(64)}` };
    invalid.statusPins = pins;
  });
  assertRejected((record, invalid) => {
    const pins = { ...invalid.semanticPins, [record.sourceTransitions[0].path]: `sha256:${'f'.repeat(64)}` };
    invalid.semanticPins = pins;
  });
  assertRejected((record) => {
    record.sourceTransitions.push({ ...record.sourceTransitions[0], path: operationsPath });
  });
  assertRejected((record) => { record.decision.externalOwnerAcceptance = 'ACCEPTED'; });
});

function currentTestRun() {
  const testRun = structuredClone(currentCutTestRun);
  for (const sourcePath of Object.keys(testRun.sourceBinding.testInputContentDigests)) {
    testRun.sourceBinding.testInputContentDigests[sourcePath] = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, sourcePath))).digest('hex')}`;
  }
  return testRun;
}

test('PDP-1 compares immutable R13 inputs to R16 and preserves stale historical test evidence', () => {
  const r13 = readJson('docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r13.json');
  const testRun = structuredClone(r13.testRun);
  const join = pdp1OwnerStatusJoinObservation(currentR13ObservedPdp1Digests(), `sha256:${'c'.repeat(64)}`, testRun,
    { path: additionalSourceImpactPath, record: additionalSourceImpact });
  assert.equal(join.valid, false, JSON.stringify({ currentImpact: join.currentCutSourceImpactReview, operation: join.supplementalPdp1DefinitionReview, counts: {
    changed: join.predecessorPathCount - join.unchangedPathCount,
    approved: join.ownerApprovedChangedPathCount,
    unapproved: join.unapprovedChangedPathCount,
  } }));
  assert.equal(join.predecessorPathCount, 329);
  assert.equal(join.observedPathCount, 329);
  assert.equal(join.unchangedPathCount, 321);
  assert.equal(join.ownerApprovedChangedPathCount, 0);
  assert.equal(join.unapprovedChangedPathCount, 8);
  assert.ok(join.unapprovedChangedPaths.includes('.product-experience/pdp-1-domain-data/owner-action-wire-contracts.yaml'),
    'the historical R13 comparison must not silently treat the owner-wire delta as reviewed without the R5 input');
  assert.equal(join.missingPathCount, 0);
  assert.equal(join.additionalPathCount, 0);
  assert.equal(join.meaningIdsChangedCount, 8);
  assert.equal(join.allChangesRequireFreshCurrentness, false);
  assert.equal(join.supplementalImpactReviewRef, currentCutSourceImpactPath);
  assert.equal(join.predecessorReporterImpactRef, reporterImpactPath);
  assert.equal(join.testEvidence.status, 'MISSING_OR_INVALID');
  assert.equal(join.currentCutSourceImpactReview.testEvidenceValid, false);
  const staleTypedObservationInput = join.currentCutSourceImpactReview.validationDetails.testInputsMatch
    .find((entry) => entry.path === 'tests/pdp-truth-domain-typed-observations.test.mjs');
  assert.equal(staleTypedObservationInput.actual,
    r13.testRun.sourceBinding.testInputContentDigests['tests/pdp-truth-domain-typed-observations.test.mjs']);
  assert.equal(staleTypedObservationInput.matches, false);
  assert.equal(join.sourceChanges.find(change => change.path === 'scripts/report-media-pdp-readiness.mjs').classification,
    'PDP_STATUS_TEST_REPORTER_SELECTION_ONLY');
  assert.equal(join.sourceChanges.find(change => change.path === 'tests/media-pdp-p1-dev-status.test.mjs').classification,
    'STRUCTURAL_REGRESSION_TEST_CENSUS_EXPECTATION_CORRECTION');
  assert.deepEqual(join.sourceChanges.find(change => change.path === '.product-experience/interface-parity/current-source-review.json').meaningIdsChangedAtReviewedCut, []);
  assert.equal(join.supplementalPdp1DefinitionReview.valid, false);
  assert.equal(join.supplementalPdp1DefinitionReview.validationChecks.fullIdentityReview, false);
  assert.equal(join.supplementalPdp1DefinitionReview.validationChecks.identityCensus, true);
  assert.deepEqual(join.supplementalPdp1DefinitionReview.reviewedDefinitionIds, [
    'media.observation-contract.rights-decision.v1',
    'media.observation-contract.destination-delivery-acknowledgment.v1',
    'media.observation-contract.delegated-integration-result-context.v1',
    'media.observation-contract.processing-parameter-read.v1',
    'media.observation-contract.effective-processing-constraints.v1',
    'media.observation-contract.transcript-submission-lineage.v1',
    'media.observation-contract.job-status-seven-dimension.v1',
    'media.observation-contract.output-preview-version-lineage.v1',
  ]);
  assert.equal(join.sourceChanges.find(change => change.path === '.product-experience/pdp-1-domain-data/operations.yaml').classification,
    'PDP1_DEFINITION_SEMANTIC_DELTA_REVIEWED_UNDER_USER_DELEGATION');
  assert.equal(join.sourceChanges.find(change => change.path === '.product-experience/pdp-1-domain-data/operations-current-source-review.json').classification,
    'PDP1_SEMANTIC_REVIEW_ARTIFACT_REFRESH');
  const reporterChange = join.sourceChanges.find(change => change.path === 'scripts/report-media-pdp-readiness.mjs');
  assert.equal(reporterChange.authorityRef, '.product-experience/reviews/2026-10-13-discovery-current-cut-delegated-owner-review.md#Authority-and-attribution');
  assert.equal(reporterChange.independentApproval, 'NOT_CLAIMED_AND_NOT_WAIVED');
});

test('PDP-1 rejects a digest that differs from the exact supplemental observation', () => {
  const changed = observedPdp1Digests();
  changed['scripts/report-media-pdp-readiness.mjs'] = `sha256:${'f'.repeat(64)}`;
  const join = pdp1OwnerStatusJoinObservation(changed, `sha256:${'c'.repeat(64)}`, currentCutTestRun);
  assert.equal(join.valid, false);
  assert.equal(join.status, 'BLOCKED_OWNER_STATUS_JOIN_MISMATCH');
});

function currentCutImpactInputs({ impact = structuredClone(currentCutSourceImpact), testRun = currentTestRun() } = {}) {
  const observedDigests = observedPdp1Digests();
  observedDigests['.product-experience/interface-parity/current-source-review.json'] = interfaceReviewImpact.sourceDelta.observedSha256;
  observedDigests[operationsPath] = 'sha256:ec1e29eceb76333dec91b52b94d20fa882456dcb52989b1794c4f9c58fdfd111';
  const historicalDigests = readJson('docs/implementation/observations/media-discovery-pdp1-exit-2026-10-13-r3.json').sourceCurrentness.sourceContentDigests;
  const supplemental = validatePdp1AdditionalSourceImpactRecord(additionalSourceImpact, {
    impact,
    observedDigests,
    historicalDigests,
    statusPins: status.sourceShaSet,
    semanticPins: semanticReview.sourceFingerprints,
  });
  return {
    impact,
    observedDigests,
    historicalDigests,
    statusPins: status.sourceShaSet,
    semanticPins: semanticReview.sourceFingerprints,
    testRun: testRun === null ? null : structuredClone(testRun),
    supplemental,
  };
}

test('superseded R4 evidence stays historical while the exact current three-review transition validates', () => {
  const inputs = currentCutImpactInputs();
  const validation = validateCurrentCutSourceImpactRecord(
    inputs.impact, inputs.observedDigests, inputs.historicalDigests, inputs.statusPins, inputs.semanticPins, inputs.testRun, inputs.supplemental,
  );
  assert.equal(validation.valid, false, JSON.stringify(validation.validationDetails));
  const transition = threeReviewTransitionInputs();
  assert.equal(validatePdp1ThreeReviewSourceTransition(transition.record, transition).valid, true);

  const wrongPath = currentCutImpactInputs();
  wrongPath.impact.sourceDeltas[1].path = 'scripts/unreviewed-interface-review.json';
  assert.equal(validateCurrentCutSourceImpactRecord(
    wrongPath.impact, wrongPath.observedDigests, wrongPath.historicalDigests,
    wrongPath.statusPins, wrongPath.semanticPins, wrongPath.testRun, wrongPath.supplemental,
  ).valid, false);

  const wrongHash = currentCutImpactInputs();
  wrongHash.impact.sourceDeltas[2].observedSha256 = `sha256:${'f'.repeat(64)}`;
  assert.equal(validateCurrentCutSourceImpactRecord(
    wrongHash.impact, wrongHash.observedDigests, wrongHash.historicalDigests,
    wrongHash.statusPins, wrongHash.semanticPins, wrongHash.testRun, wrongHash.supplemental,
  ).valid, false);
});

test('PDP-1 interface-review R4 pins the exact R2-to-current correction without adding meaning', () => {
  const observedDigests = currentCutImpactInputs().observedDigests;
  const historicalDigests = readJson('docs/implementation/observations/media-discovery-pdp1-exit-2026-10-13-r3.json').sourceCurrentness.sourceContentDigests;
  const disposition = validatePdp1InterfaceReviewImpactRecord(interfaceReviewImpact, {
    predecessorRecord: additionalSourceImpact,
    observedDigests,
    historicalDigests,
    statusPins: status.sourceShaSet,
    semanticPins: semanticReview.sourceFingerprints,
  });
  assert.equal(disposition.valid, false, 'the immutable R4 record is superseded by the separately authorized R16-to-current transition');
  const transition = threeReviewTransitionInputs();
  assert.equal(validatePdp1ThreeReviewSourceTransition(transition.record, transition).valid, true);
  assert.equal(disposition.path, '.product-experience/interface-parity/current-source-review.json');
  assert.equal(disposition.predecessorSha256, 'sha256:9f9150548c5e4e97881cc08dd28df0c4b892d88ad51e783e5f51465e1d8715c2');
  assert.equal(disposition.observedSha256, 'sha256:0ce764d11912596ee39057db9bd0f2dfbf3c85f6269d55632bda3b3e6e4ad0dd');
  assert.equal(disposition.digest, 'sha256:5f7b6cc3ef178c0a8df2f35d0085cb27e504cc577e2168b45d1ca4e2964e95d6');

  const reclassified = structuredClone(interfaceReviewImpact);
  reclassified.sourceDelta.classification = 'PDP1_SEMANTIC_CHANGE';
  assert.equal(validatePdp1InterfaceReviewImpactRecord(reclassified, {
    predecessorRecord: additionalSourceImpact,
    observedDigests,
    historicalDigests,
    statusPins: status.sourceShaSet,
    semanticPins: semanticReview.sourceFingerprints,
  }).valid, false);
  const extraPath = structuredClone(interfaceReviewImpact);
  extraPath.sourceDelta.path = 'scripts/unreviewed.mjs';
  assert.equal(validatePdp1InterfaceReviewImpactRecord(extraPath, {
    predecessorRecord: additionalSourceImpact,
    observedDigests,
    historicalDigests,
    statusPins: status.sourceShaSet,
    semanticPins: semanticReview.sourceFingerprints,
  }).valid, false);
});

test('current-cut impact disposition requires the exact passing, stable six-file PDP-1 test evidence', () => {
  const missingEvidence = currentCutImpactInputs({ testRun: null });
  assert.equal(validateCurrentCutSourceImpactRecord(
    missingEvidence.impact, missingEvidence.observedDigests, missingEvidence.historicalDigests,
    missingEvidence.statusPins, missingEvidence.semanticPins, missingEvidence.testRun, missingEvidence.supplemental,
  ).valid, false);

  const skipped = currentCutImpactInputs();
  const outcome = skipped.testRun.outcomes.find(entry => entry.command === requiredPdp1TestCommand);
  outcome.skippedCount = 1;
  assert.equal(validateCurrentCutSourceImpactRecord(
    skipped.impact, skipped.observedDigests, skipped.historicalDigests,
    skipped.statusPins, skipped.semanticPins, skipped.testRun, skipped.supplemental,
  ).valid, false);
});

test('current-cut impact cannot erase the separately reviewed PDP-1 operation meaning IDs', () => {
  const understatedMeaning = currentCutImpactInputs();
  understatedMeaning.impact.decision.pdp1MeaningDisposition = 'NO_MEANING_CHANGE';
  assert.equal(validateCurrentCutSourceImpactRecord(
    understatedMeaning.impact, understatedMeaning.observedDigests, understatedMeaning.historicalDigests,
    understatedMeaning.statusPins, understatedMeaning.semanticPins, understatedMeaning.testRun, understatedMeaning.supplemental,
  ).valid, false);
});

test('PDP-1 owner directions require the exact approved artifact digest and four historical paths', () => {
  const ownerDirections = readJson(ownerDirectionsPath);
  const expectedDigest = 'sha256:4dc505154364b4ef98836e327cc556f1d24adf937d964913caba09c49c4176a4';
  assert.equal(validateCurrentCutOwnerDirections(ownerDirections, expectedDigest), true);
  assert.equal(validateCurrentCutOwnerDirections(ownerDirections, `sha256:${'0'.repeat(64)}`), false);

  const retargeted = structuredClone(ownerDirections);
  retargeted.predecessorImpactReviews.find(review => review.phase === 'PDP-1').sourceChanges[0].path = '.product-experience/pdp-1-domain-data/operations.yaml';
  assert.equal(validateCurrentCutOwnerDirections(retargeted, expectedDigest), false);
});

test('PDP-1 classifies the source review artifact as evidence for the exact definition delta', () => {
  const semanticDelta = {
    valid: true,
    reviewedDefinitionIds: ['media.observation-contract.destination-delivery-acknowledgment.v1'],
    sourceReviewPath: operationsReviewPath,
    requiresFreshCurrentness: true,
  };
  const sourceDisposition = pdp1SemanticDefinitionPinDisposition(operationsPath, semanticDelta);
  const reviewDisposition = pdp1SemanticDefinitionPinDisposition(operationsReviewPath, semanticDelta);
  assert.equal(sourceDisposition.classification, 'PDP1_DEFINITION_SEMANTIC_DELTA_REVIEWED_UNDER_USER_DELEGATION');
  assert.equal(sourceDisposition.meaningChange, 'PDP1_MEANING_CHANGED_AND_REVIEWED');
  assert.equal(reviewDisposition.classification, 'PDP1_SEMANTIC_REVIEW_ARTIFACT_REFRESH');
  assert.equal(reviewDisposition.meaningChange, 'REVIEW_ARTIFACT_FOR_REVIEWED_PDP1_SEMANTIC_DELTA');
  assert.equal(reviewDisposition.requiresFreshCurrentness, true);
  assert.equal(pdp1SemanticDefinitionPinDisposition('package.json', semanticDelta), null);
  assert.equal(pdp1SemanticDefinitionPinDisposition(operationsReviewPath, { ...semanticDelta, valid: false }), null);
});

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

const currentCutSourceImpactDigest = sha256(fs.readFileSync(path.join(root, currentCutSourceImpactPath)));

function operationDefinitionDeltaInputs({ sourceText, reviewText, semanticReview: reviewInput } = {}) {
  const currentSourceText = sourceText ?? fs.readFileSync(path.join(root, operationsPath), 'utf8');
  const currentReviewText = reviewText ?? fs.readFileSync(path.join(root, operationsReviewPath), 'utf8');
  const historicalDigests = readJson('docs/implementation/observations/media-discovery-pdp1-exit-2026-10-13-r3.json').sourceCurrentness.sourceContentDigests;
  return {
    fileDigests: {
      [operationsPath]: { digest: sha256(currentSourceText) },
      [operationsReviewPath]: { digest: sha256(currentReviewText) },
    },
    historicalDigests,
    semanticReview: structuredClone(reviewInput ?? semanticReview),
    sourceText: currentSourceText,
    reviewText: currentReviewText,
  };
}

test('PDP-1 semantic delta remains pending fresh verification after a stable source-cut review', () => {
  const input = operationDefinitionDeltaInputs();
  const observed = validatePdp1OperationDefinitionDelta(input.fileDigests, input.historicalDigests, input.semanticReview, input);
  assert.equal(input.semanticReview.sourceCutStable, true);
  assert.match(input.semanticReview.currentCutReview.verificationStatus,
    /^PENDING_FINAL_PDP1_STATUS_AND_PHASE_CURRENTNESS_RECUT:/u);
  assert.equal(observed.valid, true, 'semantic source review is valid; phase currentness still requires suite and exit recapture');
  assert.equal(observed.requiresFreshCurrentness, true);
  assert.equal(observed.validationChecks.identityCensus, true);
  assert.equal(observed.validationChecks.fullIdentityReview, true);
  assert.equal(observed.validationChecks.supplementarySemanticReview, true);

  const identityReview = input.semanticReview.currentCutReview.supplementalDefinitionDeltaReview;
  const identitySupplement = input.semanticReview.supplementaryReviews.find((record) => record.id === 'P1-current-owner-typed-observation-definition-delta-2026-10-14');
  const exactNewIdentities = [
    'capabilityInputPayloadSchemas:media.typed-input.source-media-with-speech-dub',
    'operations:media.operation.fallback-selection.confirm.v1',
    'uiActions:media.action.confirm-selected-fallback',
  ];
  assert.deepEqual(identityReview.newIdentityIds, exactNewIdentities);
  assert.deepEqual(identitySupplement.newIdentityIds, exactNewIdentities);
  assert.equal(input.semanticReview.reviewedIdentityIds.length, 2026);
  assert.equal(new Set(input.semanticReview.reviewedIdentityIds).size, 2026);
  assert.equal(input.semanticReview.reviewedIdentityIds.filter((identity) => exactNewIdentities.includes(identity)).length, 3);

  for (const malformedIds of [
    [exactNewIdentities[0]],
    [exactNewIdentities[0], exactNewIdentities[0]],
    [...exactNewIdentities, 'capabilityInputPayloadSchemas:media.typed-input.unreviewed-schema'],
  ]) {
    const malformedIdentityReview = operationDefinitionDeltaInputs();
    malformedIdentityReview.semanticReview.currentCutReview.supplementalDefinitionDeltaReview.newIdentityIds = malformedIds;
    malformedIdentityReview.semanticReview.supplementaryReviews
      .find((record) => record.id === 'P1-current-owner-typed-observation-definition-delta-2026-10-14').newIdentityIds = malformedIds;
    const invalid = validatePdp1OperationDefinitionDelta(malformedIdentityReview.fileDigests, malformedIdentityReview.historicalDigests,
      malformedIdentityReview.semanticReview, malformedIdentityReview);
    assert.equal(invalid.valid, false);
    assert.equal(invalid.validationChecks.supplementarySemanticReview, false);
  }

  const missingReviewedIdentity = operationDefinitionDeltaInputs();
  missingReviewedIdentity.semanticReview.reviewedIdentityIds = missingReviewedIdentity.semanticReview.reviewedIdentityIds
    .filter((identity) => identity !== exactNewIdentities[1]);
  assert.equal(validatePdp1OperationDefinitionDelta(missingReviewedIdentity.fileDigests, missingReviewedIdentity.historicalDigests,
    missingReviewedIdentity.semanticReview, missingReviewedIdentity).validationChecks.identityCensus, false);
  const duplicateReviewedIdentity = operationDefinitionDeltaInputs();
  duplicateReviewedIdentity.semanticReview.reviewedIdentityIds[0] = duplicateReviewedIdentity.semanticReview.reviewedIdentityIds[1];
  assert.equal(validatePdp1OperationDefinitionDelta(duplicateReviewedIdentity.fileDigests, duplicateReviewedIdentity.historicalDigests,
    duplicateReviewedIdentity.semanticReview, duplicateReviewedIdentity).validationChecks.identityCensus, false);
  const extraReviewedIdentity = operationDefinitionDeltaInputs();
  extraReviewedIdentity.semanticReview.reviewedIdentityIds.push('operations:media.typed-input.unreviewed-schema');
  assert.equal(validatePdp1OperationDefinitionDelta(extraReviewedIdentity.fileDigests, extraReviewedIdentity.historicalDigests,
    extraReviewedIdentity.semanticReview, extraReviewedIdentity).validationChecks.identityCensus, false);

  const reviewedEdit = operationDefinitionDeltaInputs();
  const reviewedStart = reviewedEdit.sourceText.indexOf('media.observation-contract.destination-delivery-acknowledgment.v1');
  const reviewedEnd = reviewedEdit.sourceText.indexOf('\n    - id:', reviewedStart + 1);
  const reviewedRecord = reviewedEdit.sourceText.slice(reviewedStart, reviewedEnd);
  const changedReviewedRecord = reviewedRecord.replace('deliveryRequestId', 'deliveryRequestIdentifier');
  reviewedEdit.sourceText = `${reviewedEdit.sourceText.slice(0, reviewedStart)}${changedReviewedRecord}${reviewedEdit.sourceText.slice(reviewedEnd)}`;
  reviewedEdit.fileDigests[operationsPath].digest = sha256(reviewedEdit.sourceText);
  assert.notEqual(reviewedEdit.sourceText, input.sourceText);
  assert.equal(validatePdp1OperationDefinitionDelta(reviewedEdit.fileDigests, reviewedEdit.historicalDigests,
    reviewedEdit.semanticReview, reviewedEdit).valid, false);

  const unlistedEdit = operationDefinitionDeltaInputs();
  unlistedEdit.sourceText = unlistedEdit.sourceText.replace(
    'media.observation-contract.quality-evidence.v1',
    'media.observation-contract.quality-evidence-mutated.v1',
  );
  unlistedEdit.fileDigests[operationsPath].digest = sha256(unlistedEdit.sourceText);
  assert.notEqual(unlistedEdit.sourceText, input.sourceText);
  assert.equal(validatePdp1OperationDefinitionDelta(unlistedEdit.fileDigests, unlistedEdit.historicalDigests,
    unlistedEdit.semanticReview, unlistedEdit).valid, false);
});

test('PDP-1 semantic delta rejects coordinated edits to its meaning review and echoed digest pins', () => {
  const edited = operationDefinitionDeltaInputs();
  const sourceReview = JSON.parse(edited.reviewText);
  const reviewedRecord = sourceReview.currentSourceCutDeltaReview.supplementalPdp1DefinitionDelta.reviewedRecords[1];
  reviewedRecord.meaning = `${reviewedRecord.meaning} A changed reviewer interpretation.`;
  edited.reviewText = `${JSON.stringify(sourceReview, null, 2)}\n`;
  const changedReviewDigest = sha256(edited.reviewText);
  edited.fileDigests[operationsReviewPath].digest = changedReviewDigest;
  edited.semanticReview.sourceFingerprints[operationsReviewPath] = changedReviewDigest.replace(/^sha256:/u, '');
  edited.semanticReview.currentCutReview.supplementalDefinitionDeltaReview.sourceReviewArtifactSha256 = changedReviewDigest;
  assert.equal(validatePdp1OperationDefinitionDelta(edited.fileDigests, edited.historicalDigests,
    edited.semanticReview, edited).valid, false);
});

function supplementalPinInputs(overrides = {}) {
  const fileDigests = {
    'scripts/report-media-pdp-readiness.mjs': { digest: 'sha256:f3482cf689e0be2d8dc9faf9ccc72a1b63a1dcaecd056efaa1759e6f3696a5e1' },
    'tests/pdp-experience-capability-invocation-adapters.test.mjs': { digest: 'sha256:a062b06080d9aeb0b3bd0695aaa2affca0aca8583fe020bdcadcaa2a5b98e5ed' },
    'tests/media-contract-parity.test.mjs': { digest: 'sha256:3b2ebd2a9dcbe68f1afb86438fa55953851596a5d5c359a888bc94bb95eb4cc4' },
    'tests/media-contract-parity-definition-only-cli.test.mjs': { digest: 'sha256:fb5844bcafe7e5d6dfbc6ce19dfbbd68c84476855089ce17b0a353d31ae663e4' },
  };
  const testRun = {
    startedHead: 'a50a729974bc0ee2125d7b5b3842d746beae44d6',
    completedHead: 'a50a729974bc0ee2125d7b5b3842d746beae44d6',
    sourceBinding: {
      stable: true,
      testInputContentDigests: {
        'tests/media-contract-parity.test.mjs': fileDigests['tests/media-contract-parity.test.mjs'].digest,
        'tests/media-contract-parity-definition-only-cli.test.mjs': fileDigests['tests/media-contract-parity-definition-only-cli.test.mjs'].digest,
      },
    },
    testOutcomes: [{ command: requiredPdp1TestCommand, status: 'PASS', exitCode: 0, testCount: 74, passedCount: 74, failedCount: 0, skippedCount: 0 }],
  };
  const statusPins = { ...status.sourceShaSet };
  const semanticPins = { ...semanticReview.sourceFingerprints };
  statusPins['tests/pdp-experience-capability-invocation-adapters.test.mjs'] = 'b3fed6206114180160768270461e0c0175adfd0938e3029238a265ae6ef843b5';
  semanticPins['tests/pdp-experience-capability-invocation-adapters.test.mjs'] = 'b3fed6206114180160768270461e0c0175adfd0938e3029238a265ae6ef843b5';
  for (const row of parityTestImpact.sourceDeltas) {
    statusPins[row.path] = row.predecessorSha256.replace(/^sha256:/u, '');
  }
  return {
    reporterImpact: structuredClone(overrides.reporterImpact ?? reporterImpact),
    adapterTestImpact: structuredClone(overrides.adapterTestImpact ?? adapterImpact),
    parityTestImpact: structuredClone(overrides.parityTestImpact ?? parityTestImpact),
    statusPins: { ...statusPins, 'scripts/report-media-pdp-readiness.mjs': '6655e0344b7f4b03f6ca0b7e594a5448eed72ae5aeac198cef4bb1b28252028c' },
    semanticPins: { ...semanticPins, 'scripts/report-media-pdp-readiness.mjs': '6655e0344b7f4b03f6ca0b7e594a5448eed72ae5aeac198cef4bb1b28252028c' },
    historicalDigests: readJson('docs/implementation/observations/media-discovery-pdp1-exit-2026-10-13-r3.json').sourceCurrentness.sourceContentDigests,
    fileDigests,
    testRun,
    ...overrides,
  };
}

test('PDP-1 pin continuity preserves old dispositions and reports stale test source pins', () => {
  const dispositions = validatePdp1SupplementalPinDispositions(supplementalPinInputs());
  assert.deepEqual(dispositions.map(({ path, valid }) => ({ path, valid })), [
    { path: 'scripts/report-media-pdp-readiness.mjs', valid: true },
    { path: 'tests/pdp-experience-capability-invocation-adapters.test.mjs', valid: true },
    { path: 'tests/media-contract-parity.test.mjs', valid: false },
    { path: 'tests/media-contract-parity-definition-only-cli.test.mjs', valid: false },
    { path: '.product-experience/pdp-1-domain-data/handoff-contracts.yaml', valid: false },
    { path: 'tests/media-pdp-p1-dev-status.test.mjs', valid: false },
    { path: 'tests/media-contract-parity.test.mjs', valid: false },
    { path: 'scripts/report-media-pdp-readiness.mjs', valid: false },
  ]);
  assert.equal(dispositions[0].classification, 'PDP3_STATUS_GUARD_ONLY; PDP1_NO_MEANING_CHANGE');
  assert.equal(dispositions[1].classification, 'PDP3_CONSUMER_TEST_ONLY; PDP1_DEFERRED_EVIDENCE_STATUS_PIN_REFRESH_REQUIRED; NO_PDP1_DEFINITION_MEANING_CHANGE');
  assert.equal(dispositions[1].testEvidence.skippedCount, 0);
  assert.equal(dispositions[2].classification, 'REGRESSION_COVERAGE');
  assert.equal(dispositions[2].meaningChange, 'NONE');
  assert.equal(dispositions[2].testEvidence, null, 'the superseded parity test digest is historical evidence only');
  assert.equal(dispositions[3].classification, 'REGRESSION_COVERAGE');
});

test('PDP-1 supplemental pin review rejects mismatched predecessor or observed hashes', () => {
  const priorMismatch = supplementalPinInputs();
  priorMismatch.statusPins['tests/pdp-experience-capability-invocation-adapters.test.mjs'] = '0'.repeat(64);
  assert.equal(validatePdp1SupplementalPinDispositions(priorMismatch)[1].valid, false);

  const observedMismatch = supplementalPinInputs();
  observedMismatch.fileDigests['scripts/report-media-pdp-readiness.mjs'].digest = `sha256:${'f'.repeat(64)}`;
  assert.equal(validatePdp1SupplementalPinDispositions(observedMismatch)[0].valid, false);
});

test('PDP-1 supplemental pin review rejects a revoked decision and unexpected delta path', () => {
  const revoked = supplementalPinInputs();
  revoked.adapterTestImpact.decision.status = 'REVOKED';
  assert.equal(validatePdp1SupplementalPinDispositions(revoked)[1].valid, false);

  const unexpectedPath = supplementalPinInputs();
  unexpectedPath.reporterImpact.sourceDelta.path = 'scripts/other-reporter.mjs';
  assert.equal(validatePdp1SupplementalPinDispositions(unexpectedPath)[0].valid, false);
  assert.equal(validatePdp1SupplementalPinDispositions(unexpectedPath).length, 8);
});

test('PDP-1 supplemental adapter impact rejects wrong or skipped test evidence', () => {
  const wrongCommand = supplementalPinInputs();
  wrongCommand.adapterTestImpact.testEvidence.command = 'node --test tests/other.test.mjs';
  assert.equal(validatePdp1SupplementalPinDispositions(wrongCommand)[1].valid, false);

  const skipped = supplementalPinInputs();
  skipped.adapterTestImpact.testEvidence.skippedCount = 1;
  assert.equal(validatePdp1SupplementalPinDispositions(skipped)[1].valid, false);
});

test('PDP-1 parity test pin disposition requires exact passing, unskipped, digest-bound full-suite evidence', () => {
  const wrongCommand = supplementalPinInputs();
  wrongCommand.testRun.testOutcomes[0].command = 'node --test tests/other.test.mjs';
  assert.equal(validatePdp1SupplementalPinDispositions(wrongCommand)[2].valid, false);

  const failed = supplementalPinInputs();
  failed.testRun.testOutcomes[0].status = 'FAIL';
  failed.testRun.testOutcomes[0].failedCount = 1;
  assert.equal(validatePdp1SupplementalPinDispositions(failed)[2].valid, false);

  const skipped = supplementalPinInputs();
  skipped.testRun.testOutcomes[0].skippedCount = 1;
  assert.equal(validatePdp1SupplementalPinDispositions(skipped)[2].valid, false);

  const wrongDigest = supplementalPinInputs();
  wrongDigest.testRun.sourceBinding.testInputContentDigests['tests/media-contract-parity.test.mjs'] = `sha256:${'f'.repeat(64)}`;
  assert.equal(validatePdp1SupplementalPinDispositions(wrongDigest)[2].valid, false);

  const unexpectedSource = supplementalPinInputs();
  unexpectedSource.parityTestImpact.sourceDeltas[1].path = 'tests/other.test.mjs';
  assert.equal(validatePdp1SupplementalPinDispositions(unexpectedSource)[2].valid, false);

  const missingHistoricalSource = supplementalPinInputs();
  delete missingHistoricalSource.historicalDigests['tests/media-contract-parity.test.mjs'];
  assert.equal(validatePdp1SupplementalPinDispositions(missingHistoricalSource)[2].valid, false);

  const mismatchedHistoricalSource = supplementalPinInputs();
  mismatchedHistoricalSource.historicalDigests['tests/media-contract-parity-definition-only-cli.test.mjs'] = `sha256:${'0'.repeat(64)}`;
  assert.equal(validatePdp1SupplementalPinDispositions(mismatchedHistoricalSource)[3].valid, false);
});

test('PDP-1 rejects an extra delta beyond the exact reviewed path set', () => {
  const predecessorDigests = readJson('docs/implementation/observations/media-discovery-pdp1-exit-current-cut-r16.json').sourceCurrentness.sourceContentDigests;
  const changed = { ...predecessorDigests };
  const approvedPaths = new Set([
    '.product-experience/decision-log.md',
    '.product-experience/interface-parity/current-source-review.json',
    '.product-experience/pdp-1-domain-data/decisions.yaml',
    '.product-experience/pdp-1-domain-data/handoff-contracts.yaml',
    operationsPath,
    operationsReviewPath,
  ]);
  const extraPath = Object.keys(changed).find((sourcePath) => changed[sourcePath] === `sha256:${crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(root, sourcePath))).digest('hex')}` && !approvedPaths.has(sourcePath));
  assert.ok(extraPath);
  changed[extraPath] = `sha256:${'f'.repeat(64)}`;
  const join = pdp1OwnerStatusJoinObservation(changed, `sha256:${'c'.repeat(64)}`, currentTestRun(),
    { path: additionalSourceImpactPath, record: additionalSourceImpact });
  assert.equal(join.valid, false);
  assert.equal(join.unapprovedChangedPathCount, 1, JSON.stringify({ paths: join.unapprovedChangedPaths,
    currentImpact: join.currentCutSourceImpactReview }));
  assert.deepEqual(join.unapprovedChangedPaths, [extraPath]);
});

test('PDP-1 owner-action wire impact requires the exact user-authorized R5 successor to the historical R3 delta', () => {
  const ownerWireInput = loadPdp1OwnerWireImpactInput();
  const ownerWireImpact = ownerWireInput.record;
  const r13 = readJson('docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r13.json');
  const wireTestPath = 'tests/pdp-truth-domain-typed-observations.test.mjs';
  const historicalWireTestInputDigest = r13.testRun.sourceBinding.testInputContentDigests[wireTestPath];
  const currentWireTestInputDigest = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, wireTestPath))).digest('hex')}`;
  assert.equal(historicalWireTestInputDigest, 'sha256:0e277620efad858f410bbfa241c66cc0f805abf36a61d621e2263fe39bd38084');
  assert.notEqual(historicalWireTestInputDigest, currentWireTestInputDigest, 'R13 test evidence is immutable historical evidence, not current test proof');
  const historicalDigests = readJson('docs/implementation/observations/media-discovery-pdp1-exit-2026-10-13-r3.json').sourceCurrentness.sourceContentDigests;
  const changed = currentR13ObservedPdp1Digests();
  changed['.product-experience/pdp-1-domain-data/owner-action-wire-contracts.yaml'] = ownerWireImpact.sourceDeltas[0].observedSha256;
  const accepted = validatePdp1OwnerWireImpactRecord(ownerWireImpact, {
    observedDigests: changed, historicalDigests,
  });
  assert.equal(accepted.valid, false, 'the immutable R5 wire impact is superseded by the exact C22 source transition');
  const transition = threeReviewTransitionInputs();
  assert.equal(validatePdp1ThreeReviewSourceTransition(transition.record, transition).valid, true);
  assert.equal(accepted.predecessorSha256, 'sha256:f6155c1bf0a1851b0fa45f631ce09eb459d2b8d5d8df6cd03a3dd6d634be19cf');
  assert.equal(ownerWireImpact.supersedes.recordId, 'MEDIA-DISCOVERY-PDP1-OWNER-ACTION-WIRE-IMPACT-2026-10-14-R3');
  assert.equal(ownerWireImpact.authority.userAuthorization, 'Authorize no additional PDP-1 meaning (Recommended)');
  assert.equal(ownerWireImpact.sourceDeltas[0].sourceFields.length, 7);

  const extraDelta = structuredClone(ownerWireImpact);
  extraDelta.sourceDeltas.push({ ...extraDelta.sourceDeltas[0], path: 'scripts/unreviewed.mjs' });
  assert.equal(validatePdp1OwnerWireImpactRecord(extraDelta, { observedDigests: changed, historicalDigests }).valid, false);
  const reclassified = structuredClone(ownerWireImpact);
  reclassified.sourceDeltas[0].classification = 'PDP1_SEMANTIC_CHANGE';
  assert.equal(validatePdp1OwnerWireImpactRecord(reclassified, { observedDigests: changed, historicalDigests }).valid, false);
  const unauthorized = structuredClone(ownerWireImpact);
  delete unauthorized.authority.userAuthorization;
  assert.equal(validatePdp1OwnerWireImpactRecord(unauthorized, { observedDigests: changed, historicalDigests }).valid, false);
  const placeholderTime = structuredClone(ownerWireImpact);
  placeholderTime.observedAt = '2026-10-14T00:00:00.000Z';
  assert.equal(validatePdp1OwnerWireImpactRecord(placeholderTime, { observedDigests: changed, historicalDigests }).valid, false);

  const join = pdp1OwnerStatusJoinObservation(changed, `sha256:${'c'.repeat(64)}`, structuredClone(r13.testRun),
    { path: additionalSourceImpactPath, record: additionalSourceImpact },
    ownerWireInput);
  assert.equal(join.valid, false, 'historical R13 test input binding must remain stale until a fresh capture-bound run is supplied');
  assert.equal(join.predecessorPathCount, 329);
  assert.equal(join.unchangedPathCount, 322);
  assert.equal(join.ownerApprovedChangedPathCount, 0);
  assert.equal(join.unapprovedChangedPathCount, 7);
  assert.equal(join.unapprovedChangedPaths.includes('.product-experience/pdp-1-domain-data/owner-action-wire-contracts.yaml'), false);
  assert.equal(join.ownerWireSourceImpactDisposition.valid, false, 'the immutable R5 owner-wire impact is superseded by C22 and the exact R16-to-current transition');
  assert.equal(join.ownerWireSourceImpactDisposition.ref, ownerWireImpactPath);
  assert.equal(join.ownerWireSourceImpactDisposition.recordId, ownerWireImpact.recordId);
  assert.equal(join.ownerWireSourceImpactDisposition.digest, `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, ownerWireImpactPath))).digest('hex')}`);
  assert.equal(join.currentCutSourceImpactReview.testEvidenceValid, false);
  assert.equal(join.unapprovedChangedPaths.includes('.product-experience/pdp-1-domain-data/owner-action-wire-contracts.yaml'), false);
});

function validateP0(exit, exitPath = pdp0Path, currentness = pdp0Currentness,
  currentnessPath = pdp0CurrentnessPath) {
  return validatePdp0Predecessor(
    exit,
    exitPath,
    `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, exitPath))).digest('hex')}`,
    currentness,
    currentnessPath,
    `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, currentnessPath))).digest('hex')}`,
    true,
  );
}

test('PDP-1 requires the exact matrix-selected R12 PDP-0 predecessor and keeps R11/R10 historical', () => {
  const matrix = readJson('docs/implementation/media-discovery-pdp0-3-phase-cell-execution-matrix-2026-10-13.json');
  const r12Path = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r12.json';
  const r12CurrentnessPath = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r12.json';
  const r12 = readJson(r12Path);
  const r12Currentness = readJson(r12CurrentnessPath);
  assert.equal(matrix.currentCut.phaseExit, r12Path);
  assert.equal(matrix.currentCut.currentnessObservation, r12CurrentnessPath);

  const validation = validateP0(r12, r12Path, r12Currentness, r12CurrentnessPath);
  assert.equal(validation.valid, true, JSON.stringify(validation));
  assert.equal(validation.exitRef, r12Path);
  assert.equal(validation.exitDigest, 'sha256:91aeae0aad488bc8eb29d40bf955e527ef072ada762948064bc8e50422c5a5c5');
  assert.equal(validation.currentnessRef, r12CurrentnessPath);
  assert.equal(validation.currentnessDigest, 'sha256:14882e245fa1676138cfc5bd51ef0403cb96cf2f77542caa2c57dc683ca8b159');
  assert.equal(validation.materialSourceSetFingerprint, 'sha256:1a121cf988ba4a34f6b603b1f230fd0494160a3c6142c064d8d5cc2a6aa45f94');
  assert.equal(validation.cellCount, 50);
  assert.equal(validation.uniqueCellCount, 50);
  assert.equal(validation.cellsCongruent, true);
  assert.equal(validation.limitationOnly, true);
  assert.equal(pdp0R11.ownerStatusJoin.status, 'CURRENT_SOURCE_WITH_INTERNAL_SUCCESSOR_IMPACT_DISPOSITION_NOT_OWNER_ACCEPTANCE');
  assert.equal(pdp0R11.ownerStatusJoin.predecessorPathCount, 146);
  assert.equal(pdp0R11.ownerStatusJoin.unchangedPathCount, 145);
  assert.equal(pdp0R11.ownerStatusJoin.internallyDispositionedChangedPathCount, 1);
  assert.equal(pdp0R11.ownerStatusJoin.unreviewedChangedPathCount, 0);
  assert.equal(pdp0R11.ownerStatusJoin.missingPathCount, 0);
  assert.equal(pdp0R11.ownerStatusJoin.additionalPathCount, 0);
  assert.equal(pdp0R11.delegatedOwnerAcceptance.status, 'INTERNAL_SUCCESSOR_IMPACT_DISPOSITION_ONLY_NOT_OWNER_ACCEPTANCE');
  assert.equal(pdp0R11.delegatedOwnerAcceptance.humanIndependentSignatureProvided, false);
  assert.equal(pdp0R11.delegatedOwnerAcceptance.qualifiedExternalSpecialistSignoffProvided, false);
  assert.equal(pdp0R11.ownerStatusJoin.limitation.includes('does not claim owner acceptance'), true);
  assert.equal(validateP0(pdp0R11, pdp0R11Path, pdp0R11Currentness, pdp0R11CurrentnessPath).valid, false,
    'R11 remains immutable historical evidence, not the matrix-selected current predecessor');
  const r11Currentness = pdp0R11Currentness;
  assert.equal(r11Currentness.phaseDisposition.ownerAcceptance, 'NOT_OBTAINED');
  assert.equal(r11Currentness.phaseDisposition.ownerAcceptanceClaim, 'NOT_CLAIMED');
  assert.equal(r11Currentness.phaseDisposition.discoveryBarrier, 'FAIL_PDP0_OWNER_ACCEPTANCE_PENDING_AND_PDP1_PDP3_NOT_VALIDATED');
  assert.equal(r11Currentness.phaseDisposition.build, 'NOT_ENTERED');
  assert.equal(r11Currentness.phaseDisposition.pdpClosure, 'NOT_ENTERED');
  assert.equal(r11Currentness.phaseDisposition.delivery, 'BLOCKED');
  assert.equal(pdp0.successorSourceImpactDisposition.ownerAcceptance, 'NOT_CLAIMED');
  assert.equal(validateP0(pdp0).valid, false, 'R10 stays immutable historical evidence, not the matrix-selected current predecessor');
});

test('PDP-1 rejects R6 and stale PDP-0 receipts even when passed explicitly', () => {
  for (const suffix of ['r6', 'r5']) {
    const stalePath = `docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-${suffix}.json`;
    const staleCurrentnessPath = `docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-${suffix}.json`;
    assert.equal(validateP0(readJson(stalePath), stalePath, readJson(staleCurrentnessPath), staleCurrentnessPath).valid, false);
  }
});

test('PDP-1 accepts only the exact R16 immediate PDP-1 source predecessor and rejects R13 and mutation', () => {
  const r16Path = 'docs/implementation/observations/media-discovery-pdp1-exit-current-cut-r16.json';
  const r16 = readJson(r16Path);
  const digest = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, r16Path))).digest('hex')}`;
  const accepted = validatePdp1SourcePredecessor(r16, r16Path, digest);
  assert.equal(accepted.valid, true, JSON.stringify(accepted));
  assert.equal(accepted.predecessorDigest, 'sha256:63ee158301047bd715b586c41368a4d576a0b1e224672d08e2ced08349ad00fc');
  assert.equal(accepted.cellCount, 50);

  const r13Path = 'docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r13.json';
  assert.equal(validatePdp1SourcePredecessor(readJson(r13Path), r13Path, digest).valid, false);
  assert.equal(validatePdp1SourcePredecessor(r16, `${r16Path}.stale`, digest).valid, false);
  const mutated = structuredClone(r16);
  mutated.sourceCurrentness.materialSourceSetFingerprint = `sha256:${'f'.repeat(64)}`;
  assert.equal(validatePdp1SourcePredecessor(mutated, r16Path, digest).valid, false);
  assert.equal(validatePdp1SourcePredecessor(r16, r16Path, `sha256:${'f'.repeat(64)}`).valid, false);
});

test('PDP-1 rejects a stale PDP-0 predecessor receipt after the reporter digest change', () => {
  const stalePath = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r4.json';
  const staleCurrentnessPath = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r4.json';
  assert.equal(validateP0(readJson(stalePath), stalePath, readJson(staleCurrentnessPath), staleCurrentnessPath).valid, false);
});

test('PDP-1 rejects inconsistent PDP-0 predecessor join counts', () => {
  const inconsistent = structuredClone(pdp0);
  Object.assign(inconsistent.ownerStatusJoin, {
    unchangedPathCount: 143,
  });
  assert.equal(validateP0(inconsistent).valid, false);
});
