#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {
  currentPdp0PhaseScopedSourceFingerprints,
  PDP0_AUDIT_DISPOSITION_CROSSWALK_PATH,
  validatePdp0AuditDispositions,
} from './check-media-pdp0-501-audit-dispositions.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_OUTPUT = 'docs/implementation/observations/media-pdp0-crosswalk-currentness-2026-11-16-successor.candidate.v1.json';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function buildPdp0CrosswalkCurrentnessSuccessor({repositoryRoot = root} = {}) {
  const crosswalkPath = path.join(repositoryRoot, PDP0_AUDIT_DISPOSITION_CROSSWALK_PATH);
  const preimageBytes = fs.readFileSync(crosswalkPath);
  const preimage = JSON.parse(preimageBytes.toString('utf8'));
  if (preimage.rows?.length !== 501 || preimage.denominator?.expectedUniqueIds !== 501
      || preimage.coordinatorReview?.decisionRef !== 'PXD-225'
      || preimage.coordinatorReview?.priorDecisionRef !== 'PXD-223'
      || preimage.coordinatorReview?.ownerApproval !== 'NOT_CLAIMED'
      || preimage.coordinatorReview?.independentAcceptance !== 'NOT_CLAIMED') {
    throw new Error('Canonical crosswalk is not the expected 501-row PXD-225 successor predecessor');
  }

  const candidate = structuredClone(preimage);
  const directPins = candidate.sourceBaseline?.workingTreeSourceFingerprintsSha256;
  if (!directPins || Object.keys(directPins).length === 0) throw new Error('Crosswalk has no direct source fingerprint set');
  const sourceDelta = [];
  for (const [relative, previousSha256] of Object.entries(directPins)) {
    const absolute = path.resolve(repositoryRoot, relative);
    if (!absolute.startsWith(path.resolve(repositoryRoot) + path.sep) || !fs.existsSync(absolute)) {
      throw new Error(`Fingerprint source is missing or outside the repository: ${relative}`);
    }
    const currentSha256 = sha256(fs.readFileSync(absolute));
    if (previousSha256 !== currentSha256) {
      sourceDelta.push({sourceRef: relative, previousSha256, currentSha256, disposition: 'CURRENT_SOURCE_FINGERPRINT_REBIND'});
      directPins[relative] = currentSha256;
    }
  }

  const phasePins = currentPdp0PhaseScopedSourceFingerprints(candidate.coordinatorReview.decisionRef);
  const phasePinMaps = [
    candidate.sourceBaseline.phaseScopedSourceFingerprintsSha256,
    candidate.coordinatorReview.sourceFingerprints,
    candidate.coordinatorReview.phaseScopedSourceFingerprintsSha256,
  ];
  for (const pinMap of phasePinMaps) {
    if (!pinMap || JSON.stringify(Object.keys(pinMap).sort()) !== JSON.stringify(Object.keys(phasePins).sort())) {
      throw new Error('Crosswalk PDP-0 phase-scoped source selector set differs from the current checker');
    }
  }
  for (const [selector, currentSha256] of Object.entries(phasePins)) {
    const previousSha256 = candidate.sourceBaseline.phaseScopedSourceFingerprintsSha256[selector];
    if (previousSha256 !== currentSha256) {
      sourceDelta.push({sourceRef: selector, previousSha256, currentSha256, disposition: 'PDP0_SELECTOR_PROJECTION_CURRENTNESS_REBIND'});
    }
  }
  candidate.sourceBaseline.phaseScopedSourceFingerprintsSha256 = structuredClone(phasePins);
  candidate.coordinatorReview.sourceFingerprints = structuredClone(phasePins);
  candidate.coordinatorReview.phaseScopedSourceFingerprintsSha256 = structuredClone(phasePins);

  if (JSON.stringify(candidate.rows) !== JSON.stringify(preimage.rows)
      || JSON.stringify(candidate.coordinatorReview.reviewHistory) !== JSON.stringify(preimage.coordinatorReview.reviewHistory)
      || JSON.stringify(candidate.dispositionCounts) !== JSON.stringify(preimage.dispositionCounts)) {
    throw new Error('Source-currentness successor changed row semantics, disposition counts, or review history');
  }
  const validation = validatePdp0AuditDispositions({repositoryRoot, crosswalk: candidate});
  if (validation.errors.length || validation.stats?.total !== 501
      || validation.stats?.original !== 428 || validation.stats?.focused !== 73
      || validation.stats?.dispositionCounts?.BOUND_EXISTING !== 499
      || validation.stats?.dispositionCounts?.POST_PDP_IMPLEMENTATION_ONLY !== 2) {
    throw new Error(`PDP-0 crosswalk successor failed semantic validation: ${validation.errors.join(' | ')}`);
  }

  return {
    candidate,
    preimageSha256: sha256(preimageBytes),
    candidateSha256: sha256(Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`)),
    sourceDelta,
    validation: validation.stats,
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const output = process.argv.find(arg => arg.startsWith('--output='))?.slice('--output='.length) ?? DEFAULT_OUTPUT;
  const result = buildPdp0CrosswalkCurrentnessSuccessor();
  const outputPath = path.resolve(root, output);
  if (!outputPath.startsWith(root + path.sep)) throw new Error('Candidate output must remain inside the repository');
  fs.writeFileSync(outputPath, `${JSON.stringify(result.candidate, null, 2)}\n`, {flag: 'wx'});
  process.stdout.write(`${JSON.stringify({
    output: path.relative(root, outputPath),
    preimageSha256: result.preimageSha256,
    candidateSha256: result.candidateSha256,
    sourceDelta: result.sourceDelta,
    validation: result.validation,
    canonicalCrosswalkWritten: false,
  }, null, 2)}\n`);
}
