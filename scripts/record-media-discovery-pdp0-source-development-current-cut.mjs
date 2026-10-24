#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildMediaPdp0CurrentnessObservation } from './record-media-discovery-pdp0-currentness.mjs';
import { assertMediaPdp0CurrentnessOutputAvailable } from './record-media-discovery-pdp0-currentness.mjs';
import { buildMediaPdp0SourceDevelopmentCurrentCut } from './lib/media-pdp0-source-development-current-cut.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../');
const outputPath = 'docs/implementation/observations/media-discovery-pdp0-source-development-current-cut-2026-10-23-r1.json';

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function main() {
  const reviewRef = process.argv[2];
  if (!reviewRef || process.argv[3]) {
    throw new Error('Usage: node scripts/record-media-discovery-pdp0-source-development-current-cut.mjs <technical-peer-review.json>');
  }
  const normalizedReviewRef = path.relative(root, path.resolve(root, reviewRef)).split(path.sep).join('/');
  if (path.isAbsolute(reviewRef) || normalizedReviewRef === '..' || normalizedReviewRef.startsWith('../')) {
    throw new Error('Technical peer review must be a repository-relative file');
  }
  const reviewBytes = fs.readFileSync(path.resolve(root, normalizedReviewRef));
  const review = JSON.parse(reviewBytes.toString('utf8'));
  const currentnessResult = buildMediaPdp0CurrentnessObservation({
    preserveExistingObservedAt: false,
    observationOutputPath: 'docs/implementation/observations/media-discovery-pdp0-currentness-2026-10-14-current-cut-r16.json',
  });
  if (!currentnessResult.summary.sourceCurrent) {
    throw new Error(`Current PDP-0 source cut is not current: ${JSON.stringify(currentnessResult.summary)}`);
  }
  const technicalPeerReview = {
    recordRef: normalizedReviewRef,
    recordSha256: sha256(reviewBytes),
    reviewer: review.reviewer,
    assessment: review.assessment,
    reviewedSurfaceIds: review.reviewedSurfaceIds,
    sourceFingerprints: review.sourceFingerprints,
    findings: review.findings,
    ownerAcceptance: review.ownerAcceptance,
    independentAcceptance: review.independentAcceptance,
    nativeClosure: review.nativeClosure,
  };
  const record = buildMediaPdp0SourceDevelopmentCurrentCut({
    repositoryRoot: root,
    currentness: currentnessResult.observation,
    technicalPeerReview,
  });
  const destination = assertMediaPdp0CurrentnessOutputAvailable(outputPath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({
    recordId: record.recordId,
    outputPath,
    currentSource: currentnessResult.summary.sourceCurrent,
    currentCellCount: record.currentCut.denominator.totalCells,
    currentMaterialPathCount: record.currentCut.materialPathCount,
    addedCellIds: record.currentCut.addedCellIds,
    technicalReviewRef: record.technicalPeerReview.recordRef,
    technicalReviewSha256: record.technicalPeerReview.recordSha256,
    ownerAcceptance: record.authority.ownerAcceptance,
    independentAcceptance: record.authority.independentAcceptance,
    nativeLifecycleReceipt: record.authority.nativeLifecycleReceipt,
  }, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
