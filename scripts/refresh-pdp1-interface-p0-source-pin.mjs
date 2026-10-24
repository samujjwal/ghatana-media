import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reviewPath = '.product-experience/interface-parity/current-source-review.json';
const statusPath = 'docs/implementation/pdp-0-phase-dev-status.json';
const matrixPath = 'docs/implementation/verification/pdp-38/pdp0-surface-phase-status-matrix.json';
const snapshotPath = 'docs/implementation/observations/media-discovery-pdp1-interface-review-source-pin-refresh-2026-10-23-r3-predecessor-review.json';
const impactPath = 'docs/implementation/observations/media-discovery-pdp1-interface-review-source-pin-refresh-2026-10-23-r3.json';
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const read = (relative) => fs.readFileSync(path.join(root, relative));
const writeExclusive = (relative, bytes) => fs.writeFileSync(path.join(root, relative), bytes, { flag: 'wx' });

export function createPdp1InterfaceP0PinSuccessor({ reviewBytes, statusBytes, matrixBytes, observedAt = '2026-10-23T00:00:00Z' }) {
  const review = JSON.parse(reviewBytes.toString('utf8'));
  const status = JSON.parse(statusBytes.toString('utf8'));
  if (review.schemaVersion !== 'media.pdp1-interface-current-source-review.v1' || review.phase !== 'PDP-1') {
    throw new Error('PDP-1 interface source review has an unexpected schema or phase');
  }
  if (status.schemaVersion !== 'media.phase-dev-status.v1' || status.phase !== 'PDP-0' || status.status !== 'DEV_COMPLETE') {
    throw new Error('PDP-0 predecessor must be a current DEV_COMPLETE phase status');
  }
  if (!Array.isArray(status.outstandingMeaningIds) || status.outstandingMeaningIds.length !== 0
      || Object.values(status.directDevelopmentCriteria ?? {}).some((item) => item.testStatus !== 'PASS')) {
    throw new Error('PDP-0 predecessor has unresolved meaning or non-passing direct criteria');
  }
  const matrix = JSON.parse(matrixBytes.toString('utf8'));
  if (matrix.schemaVersion !== 'media.pdp0-surface-phase-status-matrix.v1'
      || matrix.campaign?.phase !== 'PDP-0' || matrix.campaign?.status !== 'DEV_COMPLETE'
      || matrix.surfaces?.length !== 54 || matrix.statusRecordSha256 !== sha(statusBytes)) {
    throw new Error('PDP-0 surface matrix must be the current 54-surface projection bound to the status receipt');
  }
  const pinPaths = [statusPath, matrixPath];
  const pins = pinPaths.map((sourcePath) => {
    const matches = review.sources.filter((item) => item.path === sourcePath);
    if (matches.length !== 1 || matches[0].sha256 === sha(sourcePath === statusPath ? statusBytes : matrixBytes)) {
      throw new Error(`PDP-1 review must contain exactly one stale PDP-0 predecessor pin for ${sourcePath}`);
    }
    return { item: matches[0], path: sourcePath, priorSha256: matches[0].sha256 };
  });
  const priorReviewSha = sha(reviewBytes);
  for (const pin of pins) pin.item.sha256 = sha(pin.path === statusPath ? statusBytes : matrixBytes);
  const nextReviewBytes = Buffer.from(`${JSON.stringify(review, null, 2)}\n`);
  const nextReviewSha = sha(nextReviewBytes);
  const snapshotSha = priorReviewSha;
  const record = {
    schemaVersion: 'media.pdp1-source-impact.v1',
    recordId: 'MEDIA-PDP1-INTERFACE-REVIEW-SOURCE-PIN-REFRESH-2026-10-23-R3',
    observedAt,
    phase: 'PDP-1',
    classification: 'INTERNAL_SOURCE_PIN_REVIEW_REFRESH_NO_ADDITIONAL_PDP1_MEANING',
    authority: {
      delegate: 'agent:/root/phase_io',
      decisionRole: 'SCOPED_INTERNAL_PDP1_SOURCE_IMPACT_REVIEW',
      authorizationEvidence: {
        source: 'ROOT_EXPLICIT_DELEGATION_OF_USER_AUTHORIZED_MEDIA_TECHNICAL_OWNER_SCOPE',
        authorizedScope: 'Rebind only the PDP-1 interface review PDP-0 status pin after unchanged PDP-0 semantics and current DEV_COMPLETE receipt were verified.',
        unchangedPdp0SemanticCandidateSha256: 'd27ef7f74e8ce63b80cf90789fe63d153ca09ee35bfd74613d00c3d835c829a5',
        noAdditionalPdp1Meaning: true,
        ownerAcceptance: false,
        independentSignoff: false,
      },
      humanIndependentSignatureProvided: false,
      externalContractOwnerAcceptanceProvided: false,
      qualifiedExternalSpecialistSignoffProvided: false,
    },
    predecessor: {
      recordRef: 'docs/implementation/observations/media-discovery-pdp1-interface-review-source-pin-refresh-2026-10-15-r2.json',
      recordId: 'MEDIA-PDP1-INTERFACE-REVIEW-SOURCE-PIN-REFRESH-2026-10-15-R2',
      sha256: `sha256:${sha(read('docs/implementation/observations/media-discovery-pdp1-interface-review-source-pin-refresh-2026-10-15-r2.json'))}`,
    },
    sourceTransition: {
      path: reviewPath,
      predecessorSha256: `sha256:${priorReviewSha}`,
      predecessorSnapshotPath: snapshotPath,
      predecessorSnapshotSha256: `sha256:${snapshotSha}`,
      observedSha256: `sha256:${nextReviewSha}`,
      classification: 'SOURCE_REVIEW_AND_PIN_REFRESH',
      meaningChange: 'NO_ADDITIONAL_PDP1_MEANING',
    },
    predecessorPins: pins.map(({ path: sourcePath, priorSha256 }) => ({ path: sourcePath, sha256: priorSha256 })),
    currentPdp0Receipt: {
      path: statusPath,
      sha256: `sha256:${sha(statusBytes)}`,
      phase: status.phase,
      status: status.status,
      outstandingMeaningCount: status.outstandingMeaningIds.length,
      directCriteriaPassCount: Object.values(status.directDevelopmentCriteria).length,
    },
    currentPdp0SurfaceProjection: {
      path: matrixPath,
      sha256: `sha256:${sha(matrixBytes)}`,
      surfaceCount: matrix.surfaces.length,
      statusReceiptSha256: matrix.statusRecordSha256,
    },
    evidence: {
      currentSourcePath: reviewPath,
      currentSourceSha256: `sha256:${nextReviewSha}`,
      currentSourceObserved: true,
      sourceMeaningReinspection: 'P1 interface populations, identities, mappings, dispositions, and admission boundaries are preserved byte-for-byte except for the exact PDP-0 status and 54-surface matrix predecessor digests.',
    },
    boundaries: {
      ownerAcceptance: 'NOT_CLAIMED',
      independentSignoff: 'NOT_CLAIMED',
      closure: 'NOT_ENTERED',
      runtimeAdmission: 'NOT_ADMITTED',
      delivery: 'NOT_AUTHORIZED',
      release: 'NOT_AUTHORIZED',
    },
    limitations: 'This R3 metadata-only successor preserves R1 and R2 and the exact prior review bytes. It establishes no owner acceptance, independent signoff, closure, runtime admission, Delivery, or release.',
  };
  return { priorReviewBytes: reviewBytes, nextReviewBytes, impactBytes: Buffer.from(`${JSON.stringify(record, null, 2)}\n`) };
}

if (process.argv.includes('--write')) {
  const result = createPdp1InterfaceP0PinSuccessor({ reviewBytes: read(reviewPath), statusBytes: read(statusPath), matrixBytes: read(matrixPath) });
  writeExclusive(snapshotPath, result.priorReviewBytes);
  fs.writeFileSync(path.join(root, reviewPath), result.nextReviewBytes);
  writeExclusive(impactPath, result.impactBytes);
  console.log(`PDP-1 interface source-review pin refreshed: ${impactPath}`);
} else {
  console.log('Use --write to record the authorized exact PDP-0 predecessor pin refresh.');
}
