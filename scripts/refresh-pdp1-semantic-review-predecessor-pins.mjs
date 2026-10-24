import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reviewPath = 'docs/implementation/verification/pdp-38/pdp1-development-semantic-review.json';
const sourceReviewPath = '.product-experience/interface-parity/current-source-review.json';
const statusPath = 'docs/implementation/pdp-0-phase-dev-status.json';
const matrixPath = 'docs/implementation/verification/pdp-38/pdp0-surface-phase-status-matrix.json';
const snapshotPath = 'docs/implementation/observations/media-pdp1-semantic-review-r8-predecessor-snapshot-2026-10-23.json';
const impactPath = 'docs/implementation/observations/media-pdp1-semantic-review-currentness-refresh-2026-10-23-r9.json';
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const read = (relative) => fs.readFileSync(path.join(root, relative));
const asSha = (bytes) => sha(bytes);

export function createPdp1SemanticReviewPinSuccessor({ reviewBytes, sourceReviewBytes, statusBytes, matrixBytes, reviewedOn = '2026-10-23' }) {
  const review = JSON.parse(reviewBytes.toString('utf8'));
  const sourceReview = JSON.parse(sourceReviewBytes.toString('utf8'));
  const status = JSON.parse(statusBytes.toString('utf8'));
  const matrix = JSON.parse(matrixBytes.toString('utf8'));
  const active = review.currentSourceCutDeltaReview?.currentnessRefreshSuccessor;
  if (review.schemaVersion !== 'media.pdp1-development-semantic-review.v1' || review.phase !== 'PDP-1'
      || review.status !== 'APPROVED_PDP1_DEVELOPMENT_SEMANTIC_REVIEW' || review.sourceCutStable !== true
      || review.outstandingMeaningIds?.length !== 0 || review.sourceIdentityCount !== 2040 || review.reviewedPopulationCount !== 25
      || review.reviewedIdentityIds?.length !== 2040 || new Set(review.reviewedIdentityIds).size !== 2040) {
    throw new Error('PDP-1 semantic review must remain approved, stable, complete, and full-denominator');
  }
  if (sourceReview.schemaVersion !== 'media.pdp1-interface-current-source-review.v1'
      || sourceReview.phase !== 'PDP-1' || status.schemaVersion !== 'media.phase-dev-status.v1'
      || status.phase !== 'PDP-0' || status.status !== 'DEV_COMPLETE' || status.outstandingMeaningIds?.length !== 0
      || Object.values(status.directDevelopmentCriteria ?? {}).some((criterion) => criterion.testStatus !== 'PASS')
      || matrix.schemaVersion !== 'media.pdp0-surface-phase-status-matrix.v1'
      || matrix.surfaces?.length !== 54 || matrix.statusRecordSha256 !== asSha(statusBytes)) {
    throw new Error('PDP-0 status, 54-surface matrix, and PDP-1 interface review are not current and complete');
  }
  const targets = [sourceReviewPath, statusPath, matrixPath];
  const currentBytes = [sourceReviewBytes, statusBytes, matrixBytes];
  const activePins = active?.sourceFingerprints;
  if (!active || active.status !== 'CURRENTNESS_ONLY_PDP0_PREDECESSOR_AND_PDP1_INTERFACE_REVIEW_REBOUND; FULL_DENOMINATOR_MEANING_RETAINED; FOCUSED_CHECKS_PASS'
      || targets.some((target) => activePins?.[target] !== review.sourceFingerprints[target]
        || activePins?.[target] === sha(currentBytes[targets.indexOf(target)]))) {
    throw new Error('PDP-1 R8 currentness review is not the exact predecessor for this refresh');
  }

  const previousSourceFingerprints = structuredClone(review.sourceFingerprints);
  const sourceFingerprints = structuredClone(previousSourceFingerprints);
  for (let index = 0; index < targets.length; index += 1) {
    sourceFingerprints[targets[index]] = asSha(currentBytes[index]);
  }
  const previous = structuredClone(activePins);
  const impactRows = targets.map((target, index) => ({
    path: target,
    previousSha256: previous[target],
    currentSha256: asSha(currentBytes[index]),
    disposition: target === sourceReviewPath
      ? 'PDP1_INTERFACE_REVIEW_PIN_REFRESH_NO_MEANING_CHANGE'
      : 'PDP0_PREDECESSOR_RECEIPT_REFRESH_NO_PDP1_MEANING_CHANGE',
    changedPdp1MeaningIds: [],
    impact: target === sourceReviewPath
      ? 'The interface review changed only the exact current PDP-0 status/matrix pins; its identities, source populations, mappings, dispositions, and admission boundaries remain unchanged.'
      : 'The PDP-0 predecessor is current DEV_COMPLETE with zero outstanding meaning; this exact status/projection receipt refresh does not change PDP-1 meaning.',
  }));
  const refreshed = {
    id: 'PDP1-CURRENT-SOURCE-CUT-AND-STATUS-RECONCILIATION-2026-10-23-R9',
    reviewedOn,
    phase: 'PDP-1',
    status: 'CURRENTNESS_ONLY_PDP0_PREDECESSOR_AND_PDP1_INTERFACE_REVIEW_REBOUND; FULL_DENOMINATOR_MEANING_RETAINED; FOCUSED_CHECKS_PASS',
    authority: 'Internal PDP-1 source-currentness review by agent:/root/phase_io under explicit root-delegated Media technical-owner authority; no owner approval, independent acceptance, closure, runtime admission, or release claim.',
    predecessorReviewRef: active.id,
    previousSourceFingerprints,
    sourceFingerprints,
    sourceDelta: impactRows,
    surfaceDenominator: 54,
    sourceIdentityCount: review.sourceIdentityCount,
    reviewedPopulationCount: review.reviewedPopulationCount,
    changedPdp1MeaningIds: [],
    outstandingMeaningIds: [],
    focusedVerification: {
      pdp1InterfaceCurrentSourceReview: 'PASS',
      p0Status: 'DEV_COMPLETE',
      p0DirectCriteria: Object.fromEntries(Object.entries(status.directDevelopmentCriteria).map(([id, criterion]) => [id, criterion.testStatus])),
      exactSourceChanges: 3,
      meaningChanges: 0,
    },
    ownerApproval: 'NOT_CLAIMED',
    independentAcceptance: 'NOT_CLAIMED',
    phaseClosure: 'NOT_ENTERED',
    runtimeAdmission: 'NOT_ADMITTED',
    transportAdmission: 'NOT_ADMITTED',
    delivery: 'NOT_AUTHORIZED',
  };
  const next = structuredClone(review);
  next.sourceFingerprints = sourceFingerprints;
  const delta = next.currentSourceCutDeltaReview;
  delta.currentnessRefreshHistory = [...(delta.currentnessRefreshHistory ?? []), structuredClone(active)];
  delta.currentnessRefreshSuccessor = refreshed;
  const nextBytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
  const impact = {
    schemaVersion: 'media.pdp1-source-impact.v1',
    recordId: 'MEDIA-PDP1-SEMANTIC-REVIEW-CURRENTNESS-REFRESH-2026-10-23-R9',
    phase: 'PDP-1',
    classification: 'PDP1_CURRENTNESS_ONLY_SOURCE_REVIEW_REBIND_NO_ADDITIONAL_MEANING',
    authority: 'agent:/root/phase_io; explicit root-delegated Media technical-owner source-currentness authority.',
    predecessor: {
      path: reviewPath,
      sha256: `sha256:${sha(reviewBytes)}`,
      snapshotPath,
      snapshotSha256: `sha256:${sha(reviewBytes)}`,
      currentnessReviewRef: active.id,
    },
    changedSourcePins: impactRows,
    unchangedSemanticCandidateSha256: 'd27ef7f74e8ce63b80cf90789fe63d153ca09ee35bfd74613d00c3d835c829a5',
    fullDenominator: { surfaces: 54, sourceIdentities: 2040, populations: 25 },
    semanticFindingsChanged: [],
    resultingReviewSha256: `sha256:${sha(nextBytes)}`,
    boundaries: {
      ownerAcceptance: 'NOT_CLAIMED',
      independentAcceptance: 'NOT_CLAIMED',
      phaseClosure: 'NOT_ENTERED',
      runtimeAdmission: 'NOT_ADMITTED',
      release: 'NOT_AUTHORIZED',
    },
    limitation: 'This source-currentness successor preserves the existing full-denominator semantic review and its historical approvals/signatures without extending or relabeling them. It establishes no new owner acceptance, independent acceptance, phase closure, runtime admission, or release.',
  };
  return { predecessorBytes: reviewBytes, reviewBytes: nextBytes, impactBytes: Buffer.from(`${JSON.stringify(impact, null, 2)}\n`) };
}

if (process.argv.includes('--write')) {
  const result = createPdp1SemanticReviewPinSuccessor({
    reviewBytes: read(reviewPath), sourceReviewBytes: read(sourceReviewPath), statusBytes: read(statusPath), matrixBytes: read(matrixPath),
  });
  fs.writeFileSync(path.join(root, snapshotPath), result.predecessorBytes, { flag: 'wx' });
  fs.writeFileSync(path.join(root, reviewPath), result.reviewBytes);
  fs.writeFileSync(path.join(root, impactPath), result.impactBytes, { flag: 'wx' });
  console.log(`PDP-1 semantic review source-currentness successor recorded: ${impactPath}`);
} else {
  console.log('Use --write to record the authorized PDP-1 semantic-review metadata successor.');
}
