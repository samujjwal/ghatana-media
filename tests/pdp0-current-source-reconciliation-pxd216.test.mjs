import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {currentPdp0PhaseScopedSourceFingerprints} from '../scripts/check-media-pdp0-501-audit-dispositions.mjs';
import {buildPdp0AuditAqTraceability, validatePdp0AuditAqTraceability} from '../scripts/check-media-pdp0-audit-aq-traceability.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactPath = 'docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd216.json';
const crosswalkPath = 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json';
const traceabilityPath = 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-audit-aq-traceability.json';
const reviewPath = 'docs/implementation/verification/pdp-38/p0-capability-meaning-20-leaf-current-source-review-pxd216.json';
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');

test('PXD-216 binds current PDP-0 source rows and phase-scoped material pins', () => {
  const artifact = JSON.parse(fs.readFileSync(path.join(root, artifactPath), 'utf8'));
  const crosswalk = JSON.parse(fs.readFileSync(path.join(root, crosswalkPath), 'utf8'));
  const traceability = JSON.parse(fs.readFileSync(path.join(root, traceabilityPath), 'utf8'));
  const capabilityReview = JSON.parse(fs.readFileSync(path.join(root, reviewPath), 'utf8'));

  assert.equal(artifact.decisionRef, '.product-experience/decision-log.md#PXD-216');
  assert.equal(artifact.phaseScope, 'PDP-0');
  assert.equal(artifact.currentSourcePinsStatus, 'CURRENT_SOURCE_PINS_VERIFIED_NO_ACCEPTANCE_EFFECT');
  assert.equal(artifact.authority.ownerApproval, 'NOT_CLAIMED');
  assert.equal(artifact.authority.independentAcceptance, 'NOT_CLAIMED');
  assert.equal(artifact.authority.acceptanceEffect, 'none');
  assert.equal(artifact.authority.implementation, 'NOT_CLAIMED');
  assert.equal(artifact.authority.runtimeAdmission, 'NOT_ADMITTED');
  assert.equal(artifact.authority.qualification, 'NOT_EVALUATED');
  assert.equal(artifact.authority.closure, 'NOT_CLAIMED');
  assert.equal(artifact.authority.delivery, 'NOT_CLAIMED');
  assert.equal(Object.hasOwn(artifact.sourceFingerprints, '.product-experience/decision-log.md'), false,
    'PDP-0 binds the exact PXD section and must not depend on downstream decision-log additions');
  assert.equal(Object.hasOwn(artifact.sourceFingerprints, 'scripts/report-media-pdp-readiness.mjs'), false,
    'shared reporting code is verification tooling, not a material PDP-0 source');
  assert.equal(Object.hasOwn(crosswalk.sourceBaseline.workingTreeSourceFingerprintsSha256, 'scripts/report-media-pdp-readiness.mjs'), false,
    'shared reporting code cannot invalidate the current 501-row PDP-0 crosswalk');

  const expectedPhasePins = currentPdp0PhaseScopedSourceFingerprints('PXD-216');
  assert.deepEqual(artifact.phaseScopedSourceFingerprintsSha256, expectedPhasePins);
  assert.deepEqual(crosswalk.sourceBaseline.phaseScopedSourceFingerprintsSha256, expectedPhasePins);
  assert.deepEqual(crosswalk.coordinatorReview.sourceFingerprints, expectedPhasePins);
  assert.equal(crosswalk.coordinatorReview.decisionRef, 'PXD-216');
  assert.equal(crosswalk.coordinatorReview.priorDecisionRef, 'PXD-215');
  const predecessor = crosswalk.coordinatorReview.reviewHistory.find(row => row.decisionRef === 'PXD-215');
  assert.ok(predecessor, 'PXD-215 remains available as a source-cut predecessor');
  assert.equal(predecessor.ownerApproval, 'NOT_CLAIMED');
  assert.equal(predecessor.acceptanceEffect, 'none');

  const actualFilePins = Object.entries(artifact.sourceFingerprints)
    .filter(([file]) => !file.includes('#PDP-0-projection') && !file.includes('#PXD-216-section'));
  assert.equal(artifact.sourceCut.sourceCount, actualFilePins.length);
  for (const [file, expected] of actualFilePins) assert.equal(sha256(file), expected, `${file} source bytes`);

  assert.deepEqual(artifact.traceability, {
    sourceRows: 501,
    originalRows: 428,
    thirdPassRows: 73,
    canonicalDefinitionJoins: 497,
    coordinatorProposalDefinitionJoins: 2,
    postPdpImplementationOnlyRows: 2,
    missingDefinitionJoins: 0,
    canonicalCapabilityLeaves: 462,
    currentCapabilityDefinitions: 469,
    currentDefinitionExtensions: 7,
  });
  assert.deepEqual(traceability, buildPdp0AuditAqTraceability());
  assert.deepEqual(validatePdp0AuditAqTraceability().errors, []);
  assert.deepEqual(artifact.capabilityMeaningReview, {
    artifactRef: reviewPath,
    reviewedCapabilityCount: capabilityReview.reviewedCapabilityIds.length,
    reviewedCapabilityIds: capabilityReview.reviewedCapabilityIds,
    acceptanceEffect: 'none',
  });
});
