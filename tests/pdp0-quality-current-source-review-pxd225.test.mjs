import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {
  PDP0_PXD213_QUALITY_REVIEW_PATH,
  PDP0_PXD213_QUALITY_CURRENTNESS_SUCCESSOR_PATH,
  PDP0_PXD216_MEANING_REVIEW_PATH,
  PDP0_PXD216_RECONCILIATION_PATH,
  PDP0_PXD218_QUALITY_REVIEW_PATH,
  PDP0_PXD222_QUALITY_REVIEW_PATH,
  PDP0_PXD223_RECONCILIATION_PATH,
  PDP0_PXD225_QUALITY_REVIEW_PATH,
  PDP0_PXD225_CURRENTNESS_SUCCESSOR_PATH,
  PDP0_PXD225_RECONCILIATION_PATH,
  validatePdp0Pxd225Currentness,
} from '../scripts/lib/pdp0-feature-review-applicability.mjs';
import {buildPxd225QualityCurrentness} from '../scripts/generate-pdp0-quality-current-source-review-pxd225.mjs';
import {pdp0PhaseScopedSourcePins} from '../scripts/report-media-pdp-readiness.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const require = createRequire(resolve(root, '../ghatana-tools/package.json'));
const {parse} = require('yaml');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const readText = file => readFileSync(resolve(root, file), 'utf8');

function livePxd225Fixture() {
  const paths = [
    '.product-experience/pdp-0-product-truth/capabilities.yaml',
    '.product-experience/pdp-0-product-truth/quality-policy.yaml',
    '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml',
    '.product-experience/pdp-0-product-truth/goals-jtbd.yaml',
    '.product-experience/pdp-0-product-truth/requirements.yaml',
    '.product-experience/source-manifest.yaml',
    '.product-experience/pdp-0-product-truth/reuse-decisions.yaml',
    'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json',
    'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-audit-aq-traceability.json',
    'docs/implementation/verification/pdp-38/p0-quality-current-source-review-pxd212.json',
    'docs/implementation/verification/pdp-38/p0-quality-currentness-successor-pxd212-live-source.json',
    PDP0_PXD213_QUALITY_REVIEW_PATH,
    PDP0_PXD213_QUALITY_CURRENTNESS_SUCCESSOR_PATH,
    'docs/implementation/verification/pdp-38/p0-caption-import-current-source-review-pxd213.json',
    'docs/implementation/verification/pdp-38/p0-caption-import-current-source-review-pxd213-live-source-successor-2026-11-16.json',
    PDP0_PXD216_MEANING_REVIEW_PATH,
    PDP0_PXD216_RECONCILIATION_PATH,
    PDP0_PXD218_QUALITY_REVIEW_PATH,
    PDP0_PXD223_RECONCILIATION_PATH,
    'docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd223-live-source-successor-2026-11-16.json',
    PDP0_PXD222_QUALITY_REVIEW_PATH,
    PDP0_PXD225_RECONCILIATION_PATH,
  ];
  const sourceTexts = Object.fromEntries(paths.map(file => [file, readText(file)]));
  const sourceDocuments = Object.fromEntries(Object.entries(sourceTexts)
    .filter(([file]) => file.endsWith('.yaml') || file.endsWith('.yml'))
    .map(([file, value]) => [file, parse(value)]));
  const latestQualityReview = JSON.parse(readText(PDP0_PXD225_CURRENTNESS_SUCCESSOR_PATH));
  const qualityHistoryReview = JSON.parse(readText('docs/implementation/verification/pdp-38/p0-quality-current-source-review-current.json'));
  return {
    qualityHistoryReview,
    latestQualityReview,
    captionReview: JSON.parse(sourceTexts['docs/implementation/verification/pdp-38/p0-caption-import-current-source-review-pxd213.json']),
    sourceDocuments,
    sourceTexts,
    decisionLogText: readText('.product-experience/decision-log.md'),
  };
}

test('PXD-225 quality currentness preserves PXD-222 history and binds the live dependent inputs', () => {
  const input = livePxd225Fixture();
  const result = validatePdp0Pxd225Currentness(input);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
  assert.equal(Object.keys(result.expectedPins).length, 32);
  assert.equal(result.expectedPins[PDP0_PXD222_QUALITY_REVIEW_PATH], sha256(readText(PDP0_PXD222_QUALITY_REVIEW_PATH)));
  assert.equal(result.expectedPins[PDP0_PXD225_RECONCILIATION_PATH], sha256(readText(PDP0_PXD225_RECONCILIATION_PATH)));
  assert.equal(result.expectedPins['docs/implementation/verification/pdp-38/p0-quality-currentness-successor-pxd212-live-source.json'],
    '30635dcc57119854709311fd153c81bdef12b76a8f3ce83180fbcfec7d7cbce2');
  assert.equal(result.expectedPins[PDP0_PXD213_QUALITY_CURRENTNESS_SUCCESSOR_PATH],
    sha256(readText(PDP0_PXD213_QUALITY_CURRENTNESS_SUCCESSOR_PATH)));
  assert.equal(input.latestQualityReview.latestCurrentnessRefresh.decisionRef,
    '.product-experience/decision-log.md#PXD-225');
  assert.equal(input.latestQualityReview.latestCurrentnessRefresh.semanticReview,
    'PXD-216_SEMANTIC_REVIEW_PRESERVED; NO_NEW_SEMANTIC_REVIEW');
  assert.equal(input.latestQualityReview.latestCurrentnessRefresh.reviewedPopulation.canonicalCapabilityRows, 462);
  assert.equal(input.latestQualityReview.latestCurrentnessRefresh.reviewedPopulation.definitionExtensionsExcluded, 7);
  assert.equal(input.latestQualityReview.latestCurrentnessRefresh.ownerApproval, 'NOT_CLAIMED');
  assert.equal(input.latestQualityReview.latestCurrentnessRefresh.independentAcceptance, 'NOT_CLAIMED');
  assert.equal(input.latestQualityReview.latestCurrentnessRefresh.acceptanceEffect, 'none');

  const pxd213Successor = JSON.parse(readText('docs/implementation/verification/pdp-38/p0-caption-import-current-source-review-pxd213-live-source-successor-2026-11-16.json'));
  const pxd213Historical = JSON.parse(readText('docs/implementation/verification/pdp-38/p0-caption-import-current-source-review-pxd213.json'));
  assert.equal(pxd213Successor.successorKind, 'CURRENTNESS_ONLY');
  assert.equal(pxd213Successor.preservedReview.reviewedField.currentSha256, pxd213Historical.reviewedField.currentSha256);
  assert.equal(pxd213Successor.preservedReview.requirementBinding.caseSha256, pxd213Historical.requirementBinding.caseSha256);
  assert.deepEqual(pxd213Successor.preservedReview.changeAssessment, pxd213Historical.changeAssessment);
  assert.equal(pxd213Successor.authority.ownerApproval, 'NOT_CLAIMED');
  assert.equal(pxd213Successor.authority.independentAcceptance, 'NOT_CLAIMED');
  assert.equal(pxd213Successor.authority.acceptanceEffect, 'none');
  const pxd213QualitySuccessor = JSON.parse(readText(PDP0_PXD213_QUALITY_CURRENTNESS_SUCCESSOR_PATH));
  const pxd213QualityPreviousSuccessorPath = 'docs/implementation/verification/pdp-38/p0-quality-currentness-successor-pxd213-pxd229-live-source-2026-11-16.json';
  const pxd213QualityPreviousSuccessor = JSON.parse(readText(pxd213QualityPreviousSuccessorPath));
  assert.equal(pxd213QualitySuccessor.successorKind, 'CURRENTNESS_ONLY');
  assert.equal(pxd213QualitySuccessor.predecessorRef, pxd213QualityPreviousSuccessorPath);
  assert.equal(pxd213QualitySuccessor.predecessorSha256, sha256(readText(pxd213QualityPreviousSuccessorPath)));
  assert.deepEqual(pxd213QualitySuccessor.latestCurrentnessRefresh.reviewedPopulation,
    pxd213QualityPreviousSuccessor.latestCurrentnessRefresh.reviewedPopulation);
  assert.deepEqual(pxd213QualitySuccessor.latestCurrentnessRefresh.changedTypeJoins,
    pxd213QualityPreviousSuccessor.latestCurrentnessRefresh.changedTypeJoins);
  assert.equal(pxd213QualitySuccessor.authority.ownerApproval, 'NOT_CLAIMED');
  assert.equal(pxd213QualitySuccessor.authority.independentAcceptance, 'NOT_CLAIMED');
  assert.equal(pxd213QualitySuccessor.authority.acceptanceEffect, 'none');

  const pxd223Successor = JSON.parse(readText('docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd223-live-source-successor-2026-11-16.json'));
  assert.equal(pxd223Successor.currentSource.capabilitiesSha256, sha256(readText('.product-experience/pdp-0-product-truth/capabilities.yaml')));
  assert.equal(pxd223Successor.currentSource.populationDelta.changedRecordCount, 7);
  assert.equal(pxd223Successor.currentSource.currentPxd226Disposition.deferredExtensionCount, 6);
  assert.equal(pxd223Successor.preservedSemanticReview.changedReviewedCapabilityIds.length, 0);
  assert.equal(pxd223Successor.authority.ownerApproval, 'NOT_CLAIMED');
  assert.equal(pxd223Successor.authority.independentAcceptance, 'NOT_CLAIMED');

  const pxd222Bytes = readText(PDP0_PXD222_QUALITY_REVIEW_PATH);
  const pxd222HeadBytes = execFileSync('git', ['show', `HEAD:${PDP0_PXD222_QUALITY_REVIEW_PATH}`], {cwd: root, encoding: 'utf8'});
  assert.equal(pxd222Bytes, pxd222HeadBytes, 'the predecessor PXD-222 record remains immutable');
  assert.equal(JSON.parse(pxd222Bytes).latestCurrentnessRefresh.sourceFingerprints[
    'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json'
  ], '6b01fea74bc26c25fea97e5108073025cbc1284a4753a98e74b9994c70342a95',
  'PXD-222 retains its historical crosswalk pin');
});

test('PXD-225 quality refresh binds the current PDP-0 source-manifest projection', () => {
  const generated = buildPxd225QualityCurrentness();
  const projectionRef = '.product-experience/source-manifest.yaml#PDP-0-projection';
  assert.equal(
    generated.latestCurrentnessRefresh.sourceFingerprints[projectionRef],
    pdp0PhaseScopedSourcePins()[projectionRef],
  );
});

test('PXD-225 currentness successor preserves the historical artifact and semantic review fields', () => {
  const previous = JSON.parse(readText(PDP0_PXD225_QUALITY_REVIEW_PATH)).latestCurrentnessRefresh;
  const successor = JSON.parse(readText(PDP0_PXD225_CURRENTNESS_SUCCESSOR_PATH)).latestCurrentnessRefresh;
  const semanticFields = ['reviewedPopulation', 'semanticReview', 'changedTypeJoins', 'ownerApproval',
    'independentAcceptance', 'acceptanceEffect', 'reviewArtifactRef', 'reviewArtifactSha256',
    'preservedSemanticReviewRef', 'preservedSemanticReviewArtifactSha256'];
  for (const field of semanticFields) assert.deepEqual(successor[field], previous[field], `${field} stays unchanged`);
  assert.equal(successor.status, 'CURRENTNESS_REFRESH_ONLY');
  assert.equal(successor.predecessorCurrentnessRef.artifactRef, PDP0_PXD225_QUALITY_REVIEW_PATH);
  assert.equal(readText(PDP0_PXD225_QUALITY_REVIEW_PATH),
    execFileSync('git', ['show', `HEAD:${PDP0_PXD225_QUALITY_REVIEW_PATH}`], {cwd: root, encoding: 'utf8'}));
});

test('PXD-225 quality currentness rejects stale dependent pins and changed semantic joins', () => {
  const staleCrosswalk = livePxd225Fixture();
  staleCrosswalk.latestQualityReview.latestCurrentnessRefresh.sourceFingerprints[
    'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json'
  ] = '0'.repeat(64);
  assert.equal(validatePdp0Pxd225Currentness(staleCrosswalk).valid, false);

  const staleReconciliation = livePxd225Fixture();
  staleReconciliation.latestQualityReview.latestCurrentnessRefresh.sourceFingerprints[PDP0_PXD225_RECONCILIATION_PATH] = '0'.repeat(64);
  assert.equal(validatePdp0Pxd225Currentness(staleReconciliation).valid, false);

  const missingJoin = livePxd225Fixture();
  missingJoin.latestQualityReview.latestCurrentnessRefresh.changedTypeJoins.pop();
  assert.equal(validatePdp0Pxd225Currentness(missingJoin).valid, false);
});
