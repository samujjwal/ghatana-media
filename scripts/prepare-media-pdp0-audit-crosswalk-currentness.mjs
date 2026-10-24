#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {
  currentPdp0PhaseScopedSourceFingerprints,
  PDP0_AUDIT_DISPOSITION_CROSSWALK_PATH,
  validatePdp0AuditDispositions,
} from './check-media-pdp0-501-audit-dispositions.mjs';
import {fingerprintPxdDecisionSection} from './lib/pdp0-phase-scoped-source-fingerprints.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const ownerDecisionRef = 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-owner-decision.v7.json';
const decisionLogPath = '.product-experience/decision-log.md';
const pxd225Selector = '.product-experience/decision-log.md#PXD-225-section';
const pxd226Selector = '.product-experience/decision-log.md#PXD-226';
const defaultOutput = 'docs/implementation/observations/media-pdp0-currentness-refresh-2026-10-23-r3/pdp0-501-crosswalk-currentness.candidate.json';

export function buildPdp0AuditCrosswalkCurrentnessCandidate({repositoryRoot = root} = {}) {
  const crosswalkPath = path.join(repositoryRoot, PDP0_AUDIT_DISPOSITION_CROSSWALK_PATH);
  const crosswalkBytes = fs.readFileSync(crosswalkPath);
  const preimage = JSON.parse(crosswalkBytes.toString('utf8'));
  if (preimage.rows?.length !== 501 || preimage.sourceBaseline?.workingTreeSourceFingerprintsSha256 == null) {
    throw new Error('PDP-0 crosswalk preimage must preserve the exact 501-row source denominator');
  }
  const row = preimage.rows.find(item => item.auditId === 'AUD-SPEC-002');
  if (!row) throw new Error('AUD-SPEC-002 is absent from the current 501-row crosswalk');
  const decision = JSON.parse(fs.readFileSync(path.join(repositoryRoot, ownerDecisionRef), 'utf8'));
  const decisionSection = fingerprintPxdDecisionSection(
    fs.readFileSync(path.join(repositoryRoot, decisionLogPath), 'utf8'), 'PXD-226',
  );
  const decisionSectionWithoutBoundaryNewline = decisionSection.section.endsWith('\n')
    ? decisionSection.section.slice(0, -1) : decisionSection.section;
  if (decision.decisionRef !== pxd226Selector
      || decision.decisionSectionSha256 !== sha256(Buffer.from(decisionSectionWithoutBoundaryNewline))
      || decision.disposition !== 'APPROVE_EXACT_CANDIDATE_FOR_SOURCE_APPLY'
      || decision.authorityBoundary?.ownerApproval !== 'NOT_CLAIMED') {
    throw new Error('AUD-SPEC-002 PXD-226 provenance is not bound to the exact current source-owner decision');
  }

  const candidate = structuredClone(preimage);
  const directFingerprints = candidate.sourceBaseline.workingTreeSourceFingerprintsSha256;
  const directStale = [];
  for (const [file, oldHash] of Object.entries(directFingerprints)) {
    const actual = sha256(fs.readFileSync(path.join(repositoryRoot, file)));
    if (actual !== oldHash) {
      directStale.push(file);
      directFingerprints[file] = actual;
    }
  }
  const expectedStaleFiles = new Set([
    '.product-experience/pdp-0-product-truth/requirements.yaml',
    '.product-experience/pdp-0-product-truth/capabilities.yaml',
    '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml',
    '.product-experience/pdp-0-product-truth/quality-policy.yaml',
    '.product-experience/pdp-0-product-truth/campaign-extensions.yaml',
  ]);
  if ((directStale.length !== 0 && directStale.length !== expectedStaleFiles.size)
      || directStale.some(file => !expectedStaleFiles.has(file))) {
    throw new Error(`PDP-0 crosswalk stale direct source set changed: ${directStale.join(', ')}`);
  }

  const phasePins = currentPdp0PhaseScopedSourceFingerprints(candidate.coordinatorReview.decisionRef);
  for (const map of [
    candidate.sourceBaseline.phaseScopedSourceFingerprintsSha256,
    candidate.coordinatorReview.sourceFingerprints,
    candidate.coordinatorReview.phaseScopedSourceFingerprintsSha256,
  ]) {
    for (const [ref, digest] of Object.entries(phasePins)) {
      if (!Object.hasOwn(map, ref)) throw new Error(`Missing phase-scoped source pin: ${ref}`);
      map[ref] = digest;
    }
  }

  const targetRow = candidate.rows.find(item => item.auditId === 'AUD-SPEC-002');
  const expectedDecisionRef = {
    id: 'PXD-226',
    path: pxd226Selector,
    sourceOwnerDecisionRef: ownerDecisionRef,
    sourceOwnerDecisionSha256: sha256(fs.readFileSync(path.join(repositoryRoot, ownerDecisionRef))),
    sourceOwnerDisposition: decision.disposition,
    decisionSectionSha256: decisionSection.sha256,
    ownerApproval: 'NOT_CLAIMED',
    independentAcceptance: 'NOT_CLAIMED',
  };
  const evidenceHasDecision = targetRow.pdp0EvidenceRefs?.includes(pxd226Selector) ?? false;
  if (evidenceHasDecision) targetRow.pdp0EvidenceRefs = targetRow.pdp0EvidenceRefs.filter(ref => ref !== pxd226Selector);
  if (JSON.stringify(targetRow.decisionRef) !== JSON.stringify(expectedDecisionRef)) {
    if (targetRow.decisionRef) throw new Error('AUD-SPEC-002 existing decision provenance differs from the exact PXD-226 source-owner record');
    targetRow.decisionRef = expectedDecisionRef;
  }

  const validation = validatePdp0AuditDispositions({repositoryRoot, crosswalk: candidate});
  if (validation.errors.length) throw new Error(`PDP-0 crosswalk candidate still fails validation: ${validation.errors.join(' | ')}`);
  if (validation.stats?.total !== 501 || validation.stats?.original !== 428 || validation.stats?.focused !== 73) {
    throw new Error('PDP-0 crosswalk candidate changed the 428 + 73 denominator');
  }
  return {
    preimageSha256: sha256(crosswalkBytes),
    candidate,
    candidateSha256: sha256(Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`)),
    directStaleFiles: directStale.sort(),
    phaseScopedSelectorRefreshed: pxd225Selector,
    phaseScopedPxd225Sha256: phasePins[pxd225Selector],
    pxd226EvidenceToDecisionProvenanceOnly: true,
    sourceOwnerDecisionRef: ownerDecisionRef,
    validation: validation.stats,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputArg = process.argv.find(arg => arg.startsWith('--output='))?.slice('--output='.length) ?? defaultOutput;
  const outputPath = path.resolve(root, outputArg);
  const result = buildPdp0AuditCrosswalkCurrentnessCandidate();
  fs.mkdirSync(path.dirname(outputPath), {recursive: true});
  fs.writeFileSync(outputPath, `${JSON.stringify(result.candidate, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    output: path.relative(root, outputPath),
    preimageSha256: result.preimageSha256,
    candidateSha256: result.candidateSha256,
    directStaleFiles: result.directStaleFiles,
    refreshedSelector: result.phaseScopedSelectorRefreshed,
    pxd225Sha256: result.phaseScopedPxd225Sha256,
    pxd226EvidenceRefMovedToDecisionProvenance: result.pxd226EvidenceToDecisionProvenanceOnly,
    stats: result.validation,
    canonicalCrosswalkWritten: false,
  }, null, 2)}\n`);
}
