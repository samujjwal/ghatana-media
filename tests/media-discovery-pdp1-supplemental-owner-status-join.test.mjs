import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  pdp1OwnerStatusJoinObservation,
  validatePdp1SupplementalPinDispositions,
  validatePdp0Predecessor,
} from '../scripts/record-media-discovery-pdp1-phase-exit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
const currentPdp1 = readJson('docs/implementation/observations/media-discovery-pdp1-exit-2026-10-14-current-cut-r4.json');
const pdp0Path = 'docs/implementation/observations/media-discovery-pdp0-exit-2026-10-14-current-cut-r1.json';
const pdp0CurrentnessPath = 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r1.json';
const pdp0 = readJson(pdp0Path);
const pdp0Currentness = readJson(pdp0CurrentnessPath);
const reporterImpactPath = 'docs/implementation/observations/media-discovery-predecessor-impact-pdp3-status-guard-2026-10-14-r1.json';
const adapterImpactPath = 'docs/implementation/observations/media-discovery-pdp1-adapter-test-pin-impact-2026-10-14-r1.json';
const status = readJson('docs/implementation/pdp-1-phase-dev-status.json');
const semanticReview = readJson('docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json');
const reporterImpact = readJson(reporterImpactPath);
const adapterImpact = readJson(adapterImpactPath);

function observedPdp1Digests() {
  return {
    ...currentPdp1.sourceCurrentness.sourceContentDigests,
    'scripts/report-media-pdp-readiness.mjs': 'sha256:f3482cf689e0be2d8dc9faf9ccc72a1b63a1dcaecd056efaa1759e6f3696a5e1',
  };
}

test('PDP-1 joins the PDP-3 status-guard supplement as exactly one fifth approved delta', () => {
  const join = pdp1OwnerStatusJoinObservation(observedPdp1Digests(), `sha256:${'c'.repeat(64)}`);
  assert.equal(join.valid, true);
  assert.equal(join.predecessorPathCount, 329);
  assert.equal(join.observedPathCount, 329);
  assert.equal(join.unchangedPathCount, 324);
  assert.equal(join.ownerApprovedChangedPathCount, 5);
  assert.equal(join.unapprovedChangedPathCount, 0);
  assert.equal(join.missingPathCount, 0);
  assert.equal(join.additionalPathCount, 0);
  assert.equal(join.meaningIdsChangedCount, 0);
  assert.equal(join.allChangesRequireFreshCurrentness, true);
  assert.equal(join.supplementalImpactReviewRef, 'docs/implementation/observations/media-discovery-predecessor-impact-pdp3-status-guard-2026-10-14-r1.json');
  assert.equal(join.sourceChanges.at(-1).path, 'scripts/report-media-pdp-readiness.mjs');
  assert.equal(join.sourceChanges.at(-1).authorityRef, '.product-experience/reviews/2026-10-13-discovery-current-cut-delegated-owner-review.md#Authority-and-attribution');
  assert.equal(join.sourceChanges.at(-1).independentApproval, 'NOT_CLAIMED_AND_NOT_WAIVED');
});

test('PDP-1 rejects a digest that differs from the exact supplemental observation', () => {
  const changed = observedPdp1Digests();
  changed['scripts/report-media-pdp-readiness.mjs'] = `sha256:${'f'.repeat(64)}`;
  const join = pdp1OwnerStatusJoinObservation(changed, `sha256:${'c'.repeat(64)}`);
  assert.equal(join.valid, false);
  assert.equal(join.status, 'BLOCKED_OWNER_STATUS_JOIN_MISMATCH');
});

function supplementalPinInputs(overrides = {}) {
  return {
    reporterImpact: structuredClone(overrides.reporterImpact ?? reporterImpact),
    adapterTestImpact: structuredClone(overrides.adapterTestImpact ?? adapterImpact),
    statusPins: { ...status.sourceShaSet },
    semanticPins: { ...semanticReview.sourceFingerprints },
    fileDigests: {
      'scripts/report-media-pdp-readiness.mjs': { digest: 'sha256:f3482cf689e0be2d8dc9faf9ccc72a1b63a1dcaecd056efaa1759e6f3696a5e1' },
      'tests/pdp-experience-capability-invocation-adapters.test.mjs': { digest: 'sha256:a062b06080d9aeb0b3bd0695aaa2affca0aca8583fe020bdcadcaa2a5b98e5ed' },
    },
    ...overrides,
  };
}

test('PDP-1 pin continuity accepts only the two exact reviewed supplemental deltas', () => {
  const dispositions = validatePdp1SupplementalPinDispositions(supplementalPinInputs());
  assert.deepEqual(dispositions.map(({ path, valid }) => ({ path, valid })), [
    { path: 'scripts/report-media-pdp-readiness.mjs', valid: true },
    { path: 'tests/pdp-experience-capability-invocation-adapters.test.mjs', valid: true },
  ]);
  assert.equal(dispositions[0].classification, 'PDP3_STATUS_GUARD_ONLY; PDP1_NO_MEANING_CHANGE');
  assert.equal(dispositions[1].classification, 'PDP3_CONSUMER_TEST_ONLY; PDP1_DEFERRED_EVIDENCE_STATUS_PIN_REFRESH_REQUIRED; NO_PDP1_DEFINITION_MEANING_CHANGE');
  assert.equal(dispositions[1].testEvidence.skippedCount, 0);
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
  assert.equal(validatePdp1SupplementalPinDispositions(unexpectedPath).length, 2);
});

test('PDP-1 supplemental adapter impact rejects wrong or skipped test evidence', () => {
  const wrongCommand = supplementalPinInputs();
  wrongCommand.adapterTestImpact.testEvidence.command = 'node --test tests/other.test.mjs';
  assert.equal(validatePdp1SupplementalPinDispositions(wrongCommand)[1].valid, false);

  const skipped = supplementalPinInputs();
  skipped.adapterTestImpact.testEvidence.skippedCount = 1;
  assert.equal(validatePdp1SupplementalPinDispositions(skipped)[1].valid, false);
});

test('PDP-1 rejects an unapproved sixth delta', () => {
  const changed = observedPdp1Digests();
  const supplementalPath = 'scripts/report-media-pdp-readiness.mjs';
  const sixthPath = Object.keys(changed).find((sourcePath) => sourcePath !== supplementalPath
    && !currentPdp1.ownerStatusJoin.sourceChanges.some((entry) => entry.path === sourcePath));
  assert.ok(sixthPath);
  changed[sixthPath] = `sha256:${'f'.repeat(64)}`;
  const join = pdp1OwnerStatusJoinObservation(changed, `sha256:${'c'.repeat(64)}`);
  assert.equal(join.valid, false);
  assert.equal(join.unapprovedChangedPathCount, 1);
});

function validateP0(exit) {
  return validatePdp0Predecessor(
    exit,
    pdp0Path,
    'sha256:fixture-exit',
    pdp0Currentness,
    pdp0CurrentnessPath,
    'sha256:fixture-currentness',
    true,
  );
}

test('PDP-1 accepts a consistent 141 unchanged plus five approved PDP-0 predecessor join', () => {
  const exactSupplementedCut = structuredClone(pdp0);
  Object.assign(exactSupplementedCut.ownerStatusJoin, {
    unchangedPathCount: 141,
    ownerApprovedChangedPathCount: 5,
    supplementalImpactRef: 'docs/implementation/observations/media-discovery-predecessor-impact-pdp3-status-guard-2026-10-14-r1.json',
    supplementalDecisionId: 'MEDIA-DISCOVERY-PREDECESSOR-IMPACT-PDP3-STATUS-GUARD-2026-10-14-R1',
  });
  assert.equal(validateP0(exactSupplementedCut).valid, true);
});

test('PDP-1 rejects a historical 142/4 PDP-0 predecessor receipt after the reporter digest change', () => {
  assert.equal(validateP0(pdp0).valid, false);
});

test('PDP-1 rejects inconsistent PDP-0 predecessor join counts', () => {
  const inconsistent = structuredClone(pdp0);
  Object.assign(inconsistent.ownerStatusJoin, {
    unchangedPathCount: 140,
    ownerApprovedChangedPathCount: 5,
  });
  assert.equal(validateP0(inconsistent).valid, false);
});
