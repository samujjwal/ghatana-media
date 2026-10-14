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
  validatePdp1OperationDefinitionDelta,
  validatePdp1SupplementalPinDispositions,
  validatePdp0Predecessor,
} from '../scripts/record-media-discovery-pdp1-phase-exit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
const currentPdp1 = readJson('docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r10.json');
const pdp0Path = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r5.json';
const pdp0CurrentnessPath = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r5.json';
const pdp0 = readJson(pdp0Path);
const pdp0Currentness = readJson(pdp0CurrentnessPath);
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
    'tests/media-pdp-p1-dev-status.test.mjs': 'sha256:3ff1576a4a3987f5b1e05d15ae77e35a62745260e127ebcb28c1bb49ef7ef82e',
  };
}

test('PDP-1 joins the exact semantic delta and current-cut source impact across nine reviewed paths', () => {
  const join = pdp1OwnerStatusJoinObservation(observedPdp1Digests(), `sha256:${'c'.repeat(64)}`, currentCutTestRun);
  assert.equal(join.valid, true, JSON.stringify({ currentImpact: join.currentCutSourceImpactReview, operation: join.supplementalPdp1DefinitionReview, counts: {
    changed: join.predecessorPathCount - join.unchangedPathCount,
    approved: join.ownerApprovedChangedPathCount,
    unapproved: join.unapprovedChangedPathCount,
  } }));
  assert.equal(join.predecessorPathCount, 329);
  assert.equal(join.observedPathCount, 329);
  assert.equal(join.unchangedPathCount, 320);
  assert.equal(join.ownerApprovedChangedPathCount, 9);
  assert.equal(join.unapprovedChangedPathCount, 0);
  assert.equal(join.missingPathCount, 0);
  assert.equal(join.additionalPathCount, 0);
  assert.equal(join.meaningIdsChangedCount, 5);
  assert.equal(join.allChangesRequireFreshCurrentness, true);
  assert.equal(join.supplementalImpactReviewRef, currentCutSourceImpactPath);
  assert.equal(join.predecessorReporterImpactRef, reporterImpactPath);
  assert.equal(join.testEvidence.status, 'PASS');
  assert.equal(join.testEvidence.testCount, 75);
  assert.equal(join.sourceChanges.find(change => change.path === 'scripts/report-media-pdp-readiness.mjs').classification,
    'PDP_STATUS_TEST_REPORTER_SELECTION_ONLY');
  assert.equal(join.sourceChanges.find(change => change.path === 'tests/media-pdp-p1-dev-status.test.mjs').classification,
    'REGRESSION_COVERAGE');
  assert.deepEqual(join.sourceChanges.find(change => change.path === '.product-experience/interface-parity/current-source-review.json').meaningIdsChangedAtReviewedCut, []);
  assert.equal(join.supplementalPdp1DefinitionReview.valid, true);
  assert.deepEqual(join.supplementalPdp1DefinitionReview.reviewedDefinitionIds, [
    'media.observation-contract.rights-decision.v1',
    'media.observation-contract.destination-delivery-acknowledgment.v1',
    'media.observation-contract.delegated-integration-result-context.v1',
    'media.observation-contract.processing-parameter-read.v1',
    'media.observation-contract.effective-processing-constraints.v1',
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

function currentCutImpactInputs({ impact = structuredClone(currentCutSourceImpact), testRun = currentCutTestRun } = {}) {
  return {
    impact,
    observedDigests: observedPdp1Digests(),
    historicalDigests: readJson('docs/implementation/observations/media-discovery-pdp1-exit-2026-10-13-r3.json').sourceCurrentness.sourceContentDigests,
    statusPins: status.sourceShaSet,
    semanticPins: semanticReview.sourceFingerprints,
    testRun: testRun === null ? null : structuredClone(testRun),
  };
}

test('current-cut impact disposition binds only the three exact source paths and digests', () => {
  const inputs = currentCutImpactInputs();
  const validation = validateCurrentCutSourceImpactRecord(
    inputs.impact, inputs.observedDigests, inputs.historicalDigests, inputs.statusPins, inputs.semanticPins, inputs.testRun,
  );
  assert.equal(validation.valid, true, JSON.stringify(validation.validationDetails));

  const wrongPath = currentCutImpactInputs();
  wrongPath.impact.sourceDeltas[1].path = 'scripts/unreviewed-interface-review.json';
  assert.equal(validateCurrentCutSourceImpactRecord(
    wrongPath.impact, wrongPath.observedDigests, wrongPath.historicalDigests,
    wrongPath.statusPins, wrongPath.semanticPins, wrongPath.testRun,
  ).valid, false);

  const wrongHash = currentCutImpactInputs();
  wrongHash.impact.sourceDeltas[2].observedSha256 = `sha256:${'f'.repeat(64)}`;
  assert.equal(validateCurrentCutSourceImpactRecord(
    wrongHash.impact, wrongHash.observedDigests, wrongHash.historicalDigests,
    wrongHash.statusPins, wrongHash.semanticPins, wrongHash.testRun,
  ).valid, false);
});

test('current-cut impact disposition requires the exact passing, stable six-file PDP-1 test evidence', () => {
  const missingEvidence = currentCutImpactInputs({ testRun: null });
  assert.equal(validateCurrentCutSourceImpactRecord(
    missingEvidence.impact, missingEvidence.observedDigests, missingEvidence.historicalDigests,
    missingEvidence.statusPins, missingEvidence.semanticPins, missingEvidence.testRun,
  ).valid, false);

  const skipped = currentCutImpactInputs();
  const outcome = skipped.testRun.outcomes.find(entry => entry.command === requiredPdp1TestCommand);
  outcome.skippedCount = 1;
  assert.equal(validateCurrentCutSourceImpactRecord(
    skipped.impact, skipped.observedDigests, skipped.historicalDigests,
    skipped.statusPins, skipped.semanticPins, skipped.testRun,
  ).valid, false);
});

test('current-cut impact cannot erase the separately reviewed PDP-1 operation meaning IDs', () => {
  const understatedMeaning = currentCutImpactInputs();
  understatedMeaning.impact.decision.pdp1MeaningDisposition = 'NO_MEANING_CHANGE';
  assert.equal(validateCurrentCutSourceImpactRecord(
    understatedMeaning.impact, understatedMeaning.observedDigests, understatedMeaning.historicalDigests,
    understatedMeaning.statusPins, understatedMeaning.semanticPins, understatedMeaning.testRun,
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

test('PDP-1 semantic delta is byte-pinned against edits to reviewed and unlisted contracts', () => {
  const input = operationDefinitionDeltaInputs();
  const observed = validatePdp1OperationDefinitionDelta(input.fileDigests, input.historicalDigests, input.semanticReview, input);
  assert.equal(observed.valid, true);

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

test('PDP-1 pin continuity accepts exact supplemental deltas only after bound tests pass', () => {
  const dispositions = validatePdp1SupplementalPinDispositions(supplementalPinInputs());
  assert.deepEqual(dispositions.map(({ path, valid }) => ({ path, valid })), [
    { path: 'scripts/report-media-pdp-readiness.mjs', valid: true },
    { path: 'tests/pdp-experience-capability-invocation-adapters.test.mjs', valid: true },
    { path: 'tests/media-contract-parity.test.mjs', valid: true },
    { path: 'tests/media-contract-parity-definition-only-cli.test.mjs', valid: true },
  ]);
  assert.equal(dispositions[0].classification, 'PDP3_STATUS_GUARD_ONLY; PDP1_NO_MEANING_CHANGE');
  assert.equal(dispositions[1].classification, 'PDP3_CONSUMER_TEST_ONLY; PDP1_DEFERRED_EVIDENCE_STATUS_PIN_REFRESH_REQUIRED; NO_PDP1_DEFINITION_MEANING_CHANGE');
  assert.equal(dispositions[1].testEvidence.skippedCount, 0);
  assert.equal(dispositions[2].classification, 'REGRESSION_COVERAGE');
  assert.equal(dispositions[2].meaningChange, 'NONE');
  assert.equal(dispositions[2].testEvidence.status, 'PASS');
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
  assert.equal(validatePdp1SupplementalPinDispositions(unexpectedPath).length, 4);
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

test('PDP-1 rejects an unapproved tenth delta after nine exact reviewed paths', () => {
  const changed = observedPdp1Digests();
  const historicalDigests = readJson('docs/implementation/observations/media-discovery-pdp1-exit-2026-10-13-r3.json').sourceCurrentness.sourceContentDigests;
  const approvedPaths = new Set([
    ...currentCutSourceImpact.sourceDeltas.map(delta => delta.path),
    ...readJson(ownerDirectionsPath).predecessorImpactReviews.find(review => review.phase === 'PDP-1').sourceChanges.map(change => change.path),
    operationsPath,
    operationsReviewPath,
  ]);
  const extraPath = Object.keys(changed).find((sourcePath) => changed[sourcePath] === historicalDigests[sourcePath]
    && !approvedPaths.has(sourcePath));
  assert.ok(extraPath);
  changed[extraPath] = `sha256:${'f'.repeat(64)}`;
  const join = pdp1OwnerStatusJoinObservation(changed, `sha256:${'c'.repeat(64)}`, currentCutTestRun);
  assert.equal(join.valid, false);
  assert.equal(join.unapprovedChangedPathCount, 1, JSON.stringify({ paths: join.unapprovedChangedPaths,
    currentImpact: join.currentCutSourceImpactReview }));
});

function validateP0(exit, exitPath = pdp0Path, currentness = pdp0Currentness,
  currentnessPath = pdp0CurrentnessPath) {
  return validatePdp0Predecessor(
    exit,
    exitPath,
    'sha256:fixture-exit',
    currentness,
    currentnessPath,
    'sha256:fixture-currentness',
    true,
  );
}

test('PDP-1 requires the fresh PDP-0 R5 current-cut-r2 predecessor and 145/1 exact join', () => {
  const exactSupplementedCut = structuredClone(pdp0);
  Object.assign(exactSupplementedCut.ownerStatusJoin, {
    predecessorExitRef: 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r2.json',
    predecessorMaterialSourceSetFingerprint: 'sha256:20e8a999b36e7fb61662183200f1e8c83eebb39523c5ab8835bea311af1f31e8',
    unchangedPathCount: 145,
    ownerApprovedChangedPathCount: 1,
    supplementalImpactRef: currentCutSourceImpactPath,
    supplementalDecisionId: 'MEDIA-DISCOVERY-CURRENT-CUT-SOURCE-IMPACT-2026-10-14-R1',
    supplementalImpactSha256: currentCutSourceImpactDigest,
  });
  assert.equal(validateP0(exactSupplementedCut).valid, true);
});

test('PDP-1 rejects a stale PDP-0 predecessor receipt after the reporter digest change', () => {
  const stalePath = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r4.json';
  const staleCurrentnessPath = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r4.json';
  assert.equal(validateP0(readJson(stalePath), stalePath, readJson(staleCurrentnessPath), staleCurrentnessPath).valid, false);
});

test('PDP-1 rejects inconsistent PDP-0 predecessor join counts', () => {
  const inconsistent = structuredClone(pdp0);
  Object.assign(inconsistent.ownerStatusJoin, {
    predecessorExitRef: 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r2.json',
    predecessorMaterialSourceSetFingerprint: 'sha256:20e8a999b36e7fb61662183200f1e8c83eebb39523c5ab8835bea311af1f31e8',
    unchangedPathCount: 144,
    ownerApprovedChangedPathCount: 1,
    supplementalImpactRef: currentCutSourceImpactPath,
    supplementalDecisionId: 'MEDIA-DISCOVERY-CURRENT-CUT-SOURCE-IMPACT-2026-10-14-R1',
    supplementalImpactSha256: currentCutSourceImpactDigest,
  });
  assert.equal(validateP0(inconsistent).valid, false);
});
