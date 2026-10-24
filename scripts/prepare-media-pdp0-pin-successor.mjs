#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {pdp0PhaseScopedSourcePins} from './report-media-pdp-readiness.mjs';
import {buildPdp0PinSuccessor} from './lib/media-pdp0-pin-successor.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonSha = value => sha256(Buffer.from(JSON.stringify(value)));
const ownerInputRef = 'docs/implementation/observations/media-pdp0-currentness-refresh-2026-10-23-r1/owner-decision-input.json';
const pxd225CandidateRef = 'docs/implementation/observations/media-pdp0-currentness-refresh-2026-10-23-r3/pdp0-current-source-reconciliation-pxd225.candidate.json';
const statusRef = 'docs/implementation/pdp-0-phase-dev-status.json';
const selectorRef = '.product-experience/decision-log.md#PXD-225-section';
const outputDir = 'docs/implementation/observations/media-pdp0-currentness-refresh-2026-10-23-r3';

function currentPin(sourceRef, selectors) {
  if (sourceRef.includes('#')) {
    const digest = selectors[sourceRef];
    if (!digest) throw new Error(`No phase-scoped selector producer output for ${sourceRef}`);
    return {sourceKind: 'PHASE_SCOPED_SELECTOR', observedSha256: digest};
  }
  const fullPath = path.join(root, sourceRef);
  if (!fs.statSync(fullPath).isFile()) throw new Error(`Material pin source is not a file: ${sourceRef}`);
  return {sourceKind: 'MATERIAL_FILE', observedSha256: sha256(fs.readFileSync(fullPath))};
}

function exactPxd225Proof(preimage, candidate, selectors) {
  if (candidate.decisionRef !== '.product-experience/decision-log.md#PXD-225'
      || candidate.preservedSemanticReview?.semanticReviewStatus !== 'PXD-216_SEMANTIC_REVIEW_PRESERVED; NO_NEW_SEMANTIC_REVIEW'
      || candidate.preservedSemanticReview?.reviewedCapabilityCount !== 20
      || candidate.preservedSemanticReview?.changedReviewedCapabilityIds?.length !== 0
      || candidate.preservedSemanticReview?.historicalReviewedRowsSha256 !== candidate.preservedSemanticReview?.currentReviewedRowsSha256
      || candidate.currentSource?.semanticChange !== 'REMOVED_ABSENT_ARCHIVED_CHANNEL_EVIDENCE_LOCATOR_ONLY'
      || candidate.authority?.ownerApproval !== 'NOT_CLAIMED'
      || candidate.authority?.acceptanceEffect !== 'none') {
    throw new Error('PXD-225 current-source reconciliation does not prove the exact semantics-preserving selector refresh');
  }
  const old = structuredClone(preimage);
  const refreshed = structuredClone(candidate);
  delete old.decisionSectionSha256;
  delete refreshed.decisionSectionSha256;
  if (JSON.stringify(old) !== JSON.stringify(refreshed)) {
    throw new Error('PXD-225 reconciliation candidate changes content beyond the selected decision-section fingerprint');
  }
  if (candidate.decisionSectionSha256 !== selectors[selectorRef]) {
    throw new Error('PXD-225 reconciliation decision-section fingerprint differs from the phase-scoped projection');
  }
}

export function prepareMediaPdp0PinSuccessor({repositoryRoot = root, outputDirectory = outputDir} = {}) {
  const statusPath = path.join(repositoryRoot, statusRef);
  const statusBytes = fs.readFileSync(statusPath);
  const status = JSON.parse(statusBytes.toString('utf8'));
  const ownerInput = JSON.parse(fs.readFileSync(path.join(repositoryRoot, ownerInputRef), 'utf8'));
  const ownerPolicy = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'config/closure/media-product-definition/owner-execution-authorization.v1.json'), 'utf8'));
  const pxd225Candidate = JSON.parse(fs.readFileSync(path.join(repositoryRoot, pxd225CandidateRef), 'utf8'));
  const previousPxd225 = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd225.json'), 'utf8'));
  exactPxd225Proof(previousPxd225, pxd225Candidate, pdp0PhaseScopedSourcePins());

  const selectorPins = pdp0PhaseScopedSourcePins();
  const selectorEntries = ownerInput.pinReadSet.allObservedPins
    .filter(row => row.kind === 'PHASE_SCOPED_SELECTOR');
  const observedPins = ownerInput.pinReadSet.allObservedPins.map(row => {
    const {sourceKind, observedSha256} = currentPin(row.sourceRef, selectorPins);
    return {sourceRef: row.sourceRef, sourceKind, statusPinnedSha256: row.statusPinnedSha256, observedSha256};
  });
  if (selectorEntries.length !== 21) throw new Error('Expected the complete 21-selector readset');

  const materialRefs = ownerInput.pinReadSet.materialPinDeltas.map(row => row.sourceRef).sort();
  const materialUpdates = ownerInput.pinReadSet.materialPinDeltas.map(row => {
    const current = currentPin(row.sourceRef, selectorPins);
    return {sourceRef: row.sourceRef, sourceKind: current.sourceKind, previousSha256: row.previousSha256, currentSha256: current.observedSha256};
  });
  const currentSelector = selectorPins[selectorRef];
  const selectorPreimage = status.sourceShaSet[selectorRef];
  const selectorUpdate = {
    sourceRef: selectorRef,
    sourceKind: 'PHASE_SCOPED_SELECTOR',
    previousSha256: selectorPreimage,
    currentSha256: currentSelector,
  };
  const targetUpdates = [...materialUpdates, selectorUpdate];
  const result = buildPdp0PinSuccessor({
    preimage: status,
    observedPins,
    targetUpdates,
    expectedMaterialRefs: materialRefs,
    selectorRef,
    expectedPinCount: 188,
  });
  const targetPinReadSet = observedPins.map(row => ({
    sourceRef: row.sourceRef,
    sourceKind: row.sourceKind,
    statusPinnedSha256: row.statusPinnedSha256,
    observedSha256: row.observedSha256,
    current: row.statusPinnedSha256 === row.observedSha256,
  }));
  const sourceEvidenceRefs = [
    ['PXD-226 source-owner decision', 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-owner-decision.v7.json'],
    ['PXD-226 apply authorization', 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-amendment-apply-authorization.v7.json'],
    ['PXD-226 exact-apply journal', 'docs/implementation/observations/pdp0-semantic-audit-slices/source-amendment-journals/c7f510c6cf3f17be31c8fb50e36f06ea92db7f64337dbd91ee7f8273f4014dcc.json'],
    ['PXD-227 source-owner decision', 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-quality-extension-source-owner-decision.v2.json'],
    ['PXD-227 independent peer', 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-quality-extension-independent-peer.v2.json'],
    ['PXD-227 apply authorization', 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-quality-extension-apply-authorization.v2.json'],
    ['PXD-227 exact-apply journal', 'docs/implementation/observations/pdp0-semantic-audit-slices/source-amendment-journals/f6feb44574d87a7ee15807b80ac8cf8c95c9ca86ab81ff6c9cddea3ec5799a0a.json'],
    ['PXD-225 phase-scoped reconciliation candidate', pxd225CandidateRef],
    ['PXD-225 current-source producer', 'scripts/generate-pdp0-current-source-reconciliation-pxd225.mjs'],
    ['PDP-0 audit crosswalk current-source candidate', 'docs/implementation/observations/media-pdp0-currentness-refresh-2026-10-23-r3/pdp0-501-crosswalk-currentness.candidate.json'],
    ['PDP-0 audit crosswalk current source', 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json'],
    ['PDP-0 audit crosswalk currentness producer', 'scripts/prepare-media-pdp0-audit-crosswalk-currentness.mjs'],
    ['PXD-216 semantic review', 'docs/implementation/verification/pdp-38/p0-capability-meaning-20-leaf-current-source-review-pxd216.json'],
    ['PXD-223 currentness predecessor', 'docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd223.json'],
    ['owner execution authorization', 'config/closure/media-product-definition/owner-execution-authorization.v1.json'],
  ];
  const sourceAuthorityAndVerificationInputs = sourceEvidenceRefs.map(([label, ref]) => ({
    label, ref, sha256: sha256(fs.readFileSync(path.join(repositoryRoot, ref))),
  }));
  const sourceAuthorityByLabel = Object.fromEntries(sourceAuthorityAndVerificationInputs.map(row => [row.label, row]));
  const candidateRef = path.join(outputDirectory, 'pdp-0-phase-dev-status.ten-pin.candidate.json');
  const inputRef = path.join(outputDirectory, 'root-owner-decision-input.ten-pin.json');
  const candidateSha256 = sha256(Buffer.from(`${JSON.stringify(result.candidate, null, 2)}\n`));
  const input = {
    schemaVersion: 'media.pdp0-root-status-owner-decision-input.v2',
    recordId: 'MEDIA-PDP0-ROOT-STATUS-DECISION-2026-10-23-TEN-PIN',
    packetKind: 'EXACT_SOURCE_BOUND_OWNER_DECISION_REQUEST',
    decisionRecordState: 'NOT_YET_RECORDED',
    target: {
      ref: statusRef,
      preimageSha256: sha256(statusBytes),
      candidateRef,
      candidateSha256,
      sourceShaSetPreimageSha256: result.sourceShaSetPreimageSha256,
      sourceShaSetCandidateSha256: result.sourceShaSetCandidateSha256,
    },
    campaignPreservation: {
      phase: 'PDP-0', status: 'IN_PROGRESS', sourcePinCount: 188,
      sourceIdentityDenominator: 54, capabilityLeafOwnerHistory: 462,
      outstandingMeaningIds: status.outstandingMeaningIds,
      nonPinFieldsSha256: jsonSha(Object.fromEntries(Object.entries(status).filter(([key]) => key !== 'sourceShaSet'))),
    },
    targetPinReadSet,
    exactTargetChanges: targetUpdates.map(row => ({
      sourceRef: row.sourceRef,
      sourceKind: row.sourceKind,
      previousSha256: row.previousSha256,
      currentSha256: row.currentSha256,
    })),
    pxd225SemanticBasis: {
      candidateRef: pxd225CandidateRef,
      candidateSha256: sourceAuthorityByLabel['PXD-225 phase-scoped reconciliation candidate'].sha256,
      priorArtifactRef: 'docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd225.json',
      priorArtifactSha256: sha256(fs.readFileSync(path.join(repositoryRoot, 'docs/implementation/verification/pdp-38/pdp0-current-source-reconciliation-pxd225.json'))),
      changedReconciliationFields: ['decisionSectionSha256'],
      preservedSemanticReview: pxd225Candidate.preservedSemanticReview,
      currentSource: pxd225Candidate.currentSource,
      ownerApproval: 'NOT_CLAIMED',
      independentAcceptance: 'NOT_CLAIMED',
    },
    sourceAuthorityAndVerificationInputs,
    requestedDecision: {
      requiredRole: 'AUTHENTIC_MEDIA_REPOSITORY_OWNER_AND_PDP0_ROOT_STATUS_AUTHORITY',
      accountableOwnerFromPolicy: ownerPolicy.ownerAccountability,
      authorityBasisRef: 'config/closure/media-product-definition/owner-execution-authorization.v1.json',
      choices: ['APPROVE_EXACT_TEN_PIN_POSTIMAGE', 'REJECT_AND_RETURN_FOR_REPAIR'],
      decisionRefMustBindCandidateSha256: candidateSha256,
      decisionRecord: 'NOT_PRESENT; DO_NOT_INFER_APPROVAL',
    },
    applyGuard: {
      approvedWriter: 'writePdp0DevStatus(status, repositoryRoot) from scripts/report-media-pdp-readiness.mjs',
      requiredBeforeWrite: [
        'status file SHA equals target.preimageSha256',
        'all 188 current source values equal targetPinReadSet.observedSha256',
        'target set is exactly the nine listed material files plus the phase-projected PXD-225 selector',
        'candidate differs from preimage only in exactTargetChanges',
        'PDP-0 remains IN_PROGRESS with 188 pins and all 462 owner rows',
        'PXD-225 reconciliation candidate still proves unchanged 20-leaf semantics and exact locator-only reconciliation',
      ],
      canonicalWrite: 'NOT_PERFORMED_BY_THIS_PACKET',
    },
    effectBoundary: {
      discoveryBarrier: 'REMAINS_FAIL_UNTIL_CURRENTNESS_AND_FULL_PDP0_CRITERIA_PASS',
      acceptance: 'NOT_CLAIMED', nativeClosure: 'NOT_CLAIMED', release: 'NOT_CLAIMED',
    },
  };
  fs.mkdirSync(path.join(repositoryRoot, outputDirectory), {recursive: true});
  fs.writeFileSync(path.join(repositoryRoot, candidateRef), `${JSON.stringify(result.candidate, null, 2)}\n`);
  fs.writeFileSync(path.join(repositoryRoot, inputRef), `${JSON.stringify(input, null, 2)}\n`);
  return {candidateRef, candidateSha256, inputRef, inputSha256: sha256(Buffer.from(`${JSON.stringify(input, null, 2)}\n`)), updateCount: result.changedSourceRefs.length};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = prepareMediaPdp0PinSuccessor();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
