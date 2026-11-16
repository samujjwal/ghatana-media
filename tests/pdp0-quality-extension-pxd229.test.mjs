import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { validateQualityApplicabilityPopulation } from '../scripts/lib/media-pdp0-quality-applicability-extension.mjs';
import { fingerprintPxdDecisionSection } from '../scripts/lib/pdp0-phase-scoped-source-fingerprints.mjs';
import { pdp0PhaseScopedSourcePins } from '../scripts/report-media-pdp-readiness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const parse = createRequire(path.resolve(root, '../ghatana-tools/package.json'))('yaml').parse;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const qualityPath = '.product-experience/pdp-0-product-truth/quality-policy.yaml';
const leafPath = '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml';
const qualityRef = qualityPath + '#ownerQualityApplicabilityCrosswalkExtensions/records/@id=media.quality-applicability-extension.media-recipe-specification-compile.v1';
const pxd229CurrentnessPredecessorPath = 'docs/implementation/verification/pdp-38/p0-quality-currentness-successor-pxd213-pxd229-live-source-2026-11-16.json';
const pxd229CurrentnessSuccessorPath = 'docs/implementation/verification/pdp-38/p0-quality-currentness-successor-pxd213-pxd229-live-source-successor-2026-11-16.json';
const expectedDimensions = {
  'QUALITY-DIM-STRUCTURAL-VALIDITY': 'NOT_APPLICABLE',
  'QUALITY-DIM-PERCEPTUAL': 'NOT_APPLICABLE',
  'QUALITY-DIM-INTENT-FIDELITY': 'NOT_APPLICABLE',
  'QUALITY-DIM-DOMAIN-SCIENTIFIC': 'NOT_APPLICABLE',
  'QUALITY-DIM-RIGHTS-SAFETY': 'APPLICABLE',
  'QUALITY-DIM-DELIVERY-COMPATIBILITY': 'NOT_APPLICABLE',
};

test('PXD-229 adopts the exact compile quality applicability row without measurement or qualification claims', () => {
  const policy = parse(read(qualityPath));
  const leafReview = parse(read(leafPath));
  const decisionLog = read('.product-experience/decision-log.md');
  const extension = policy.ownerQualityApplicabilityCrosswalkExtensions;
  const row = extension.records.find(record => record.capabilityRef === 'media.recipe.specification.compile');
  const rowDigest = digest(JSON.stringify(row));
  const ownerExtension = leafReview.currentVersionExtensionOwnerAndTrust;
  const ownerQuality = ownerExtension.qualityApplicability;
  const trust = ownerExtension.trustReconstructionDispositions.find(record =>
    record.capabilityRef === 'media.recipe.specification.compile');
  const currentnessSuccessor = JSON.parse(read(pxd229CurrentnessSuccessorPath));
  const currentnessPredecessorBytes = fs.readFileSync(path.join(root, pxd229CurrentnessPredecessorPath));
  const pxd229SectionSha256 = fingerprintPxdDecisionSection(decisionLog, 'PXD-229').sha256;

  assert.equal(fingerprintPxdDecisionSection(decisionLog, 'PXD-229').decisionId, 'PXD-229');
  assert.equal(
    pdp0PhaseScopedSourcePins()['.product-experience/decision-log.md#PXD-229-section'],
    pxd229SectionSha256,
  );
  assert.equal(currentnessSuccessor.successorKind, 'CURRENTNESS_ONLY');
  assert.equal(currentnessSuccessor.predecessorRef, pxd229CurrentnessPredecessorPath);
  assert.equal(currentnessSuccessor.predecessorSha256, digest(currentnessPredecessorBytes));
  assert.ok(currentnessPredecessorBytes.toString('utf8').includes(
    '".product-experience/decision-log.md#PXD-229-section": "2d59e4435e9b486d79b326df5cb2a7f47633504103c2bb95cc571f96f85b65d4"'));
  assert.equal(currentnessSuccessor.latestCurrentnessRefresh.sourceFingerprints[
    '.product-experience/decision-log.md#PXD-229-section'], pxd229SectionSha256);
  assert.equal(currentnessSuccessor.latestCurrentnessRefresh.ownerApproval, 'NOT_CLAIMED');
  assert.equal(currentnessSuccessor.latestCurrentnessRefresh.independentAcceptance, 'NOT_CLAIMED');
  assert.equal(currentnessSuccessor.latestCurrentnessRefresh.acceptanceEffect, 'none');
  assert.ok(decisionLog.includes("PXD-227's exact two-target apply is preserved"));
  assert.equal(extension.status, 'SOURCE_OWNER_DECIDED_DEFINITION_ONLY');
  assert.equal(extension.sourceOwnerDecisionRef, '.product-experience/decision-log.md#PXD-229');
  assert.equal(policy.ownerQualityApplicabilityCrosswalk.records.length, 462);
  assert.equal(extension.historicalBaseRows, 462);
  assert.equal(extension.currentExtensionRows, 1);
  assert.equal(extension.currentPopulationRows, 463);
  assert.equal(extension.futureExtensionRows, 6);
  assert.deepEqual(row.dimensionApplicability, expectedDimensions);
  assert.equal(Object.keys(row.metricApplicability).length, 16);
  assert.ok(Object.values(row.metricApplicability).every(metric =>
    metric.status === 'NOT_APPLICABLE'
      && metric.measurementState === 'NOT_EVALUATED'
      && metric.qualificationState === 'NOT_EVALUATED'));
  assert.equal(row.measurementState, 'NOT_EVALUATED');
  assert.equal(row.qualificationState, 'NOT_EVALUATED');
  assert.equal(row.acceptanceEffect, 'none');
  assert.deepEqual(validateQualityApplicabilityPopulation(policy).currentExtensionRows, [row]);

  assert.equal(ownerQuality.status, 'SOURCE_OWNER_DECIDED_DEFINITION_ONLY');
  assert.equal(ownerQuality.sourceOwnerDecisionRef, '.product-experience/decision-log.md#PXD-229');
  assert.equal(ownerQuality.qualityPolicyRecordRef, qualityRef);
  assert.equal(ownerQuality.qualityPolicyRecordProjectionSha256, rowDigest);
  assert.deepEqual(ownerQuality.dimensionApplicability, expectedDimensions);
  assert.equal(ownerQuality.metricCount, 16);
  assert.equal(ownerQuality.metricDisposition, 'NOT_APPLICABLE');
  assert.equal(ownerQuality.measurementState, 'NOT_EVALUATED');
  assert.equal(ownerQuality.qualificationState, 'NOT_EVALUATED');
  assert.equal(ownerQuality.acceptanceEffect, 'none');
  assert.equal(ownerQuality.existingQualityReviewCapabilityCount, 462);
  assert.equal(ownerQuality.currentExtensionIncludedInExistingQualityReview, false);

  assert.equal(trust.qualityApplicability, 'SOURCE_OWNER_DECIDED_DEFINITION_ONLY; PXD-229; exact row is linked by the currentVersionExtensionOwnerAndTrust qualityApplicability record.');
  assert.equal(ownerExtension.ownerAdjudications.length, 1);
  assert.equal(ownerExtension.trustReconstructionDispositions.length, 1);
  assert.equal(ownerExtension.ownerAcceptance, 'NOT_CLAIMED');
  assert.equal(ownerExtension.independentAcceptance, 'NOT_CLAIMED');
  assert.equal(ownerExtension.phaseStatusEffect, 'NONE');
});
