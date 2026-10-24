import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import YAML from 'yaml';
import {fingerprintPxdDecisionSection} from './lib/pdp0-phase-scoped-source-fingerprints.mjs';

const root = process.cwd();
const dir = 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const targetDir = path.join(root, dir);
const rel = (name) => path.join(targetDir, name);
const read = (name) => fs.readFileSync(rel(name));
const readRoot = (name) => fs.readFileSync(path.join(root, name));
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const checkMode = process.argv.includes('--check');
const writeCreateOnly = (name, bytes) => {
  const target = rel(name);
  if (fs.existsSync(target)) {
    if (checkMode && fs.readFileSync(target).equals(bytes)) return;
    throw new Error(`Refusing overwrite or replay mismatch: ${target}`);
  }
  if (checkMode) throw new Error(`Replay target missing: ${target}`);
  fs.writeFileSync(target, bytes, { flag: 'wx' });
};

const refs = {
  capabilities: '.product-experience/pdp-0-product-truth/capabilities.yaml',
  requirements: '.product-experience/pdp-0-product-truth/requirements.yaml',
  crosswalk: 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json',
  leaf: '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml',
  campaign: '.product-experience/pdp-0-product-truth/campaign-extensions.yaml',
  decisionLog: '.product-experience/decision-log.md',
  quality: '.product-experience/pdp-0-product-truth/quality-policy.yaml',
};
const expectedLive = {
  [refs.capabilities]: 'fb5fa356c007dfe3617f0d8505247439dcfdea27d28016797ec927099fbc74d2',
  [refs.requirements]: '672ccce00c5ee762cbcd716d68dd474acad023199d87c9f99b6b528234912cb7',
  [refs.crosswalk]: '02c61f7b0193ccd1900ffcae84f7a4c95fb00e800d9d86a9ce1ea65cae79b5b4',
  [refs.leaf]: '3b1326a1a07a62633a731ada9ea547f032aa765286ef47ec1e930e3e73664253',
  [refs.campaign]: 'df94787015aea30fa148355cbb0a7c564c3acd007ea16b277f05c849534b64ed',
  [refs.decisionLog]: '0d4c518af9ac6023475467f01711606ab9388ef34ac51b9bb47f917615c89298',
  [refs.quality]: '39d66c0dd588bf177f29f721452d657b5f76aebe4b027ac69e3541ec29dade84',
};
const liveBytes = Object.fromEntries(Object.values(refs).map((ref) => [ref, readRoot(ref)]));
for (const [ref, expected] of Object.entries(expectedLive)) {
  if (sha(liveBytes[ref]) !== expected) throw new Error(`R9-R08 source cut changed; review and version a new baseline: ${ref}`);
}

const r07Prefix = 'media-pdp0-root-selected-source-integration-r9-r07';
const r07BundleRef = `${dir}/${r07Prefix}.successor-bundle.candidate.v1.json`;
const r07FreezeRef = `${dir}/${r07Prefix}.freeze.v1.json`;
const r07HRef = `${dir}/${r07Prefix}.independent-peer.actual-h-r07-full.json`;
const r07Bundle = JSON.parse(read(`${r07Prefix}.successor-bundle.candidate.v1.json`).toString('utf8'));
const r07Freeze = JSON.parse(read(`${r07Prefix}.freeze.v1.json`).toString('utf8'));
const r07H = JSON.parse(read(`${r07Prefix}.independent-peer.actual-h-r07-full.json`).toString('utf8'));
if (r07Bundle.candidateRevision !== 'R9-R07' || r07H.reviewStatus !== 'PASS') throw new Error('R9-R07 immutable predecessor or historical H review does not match');
const r07Postimage = (targetRef) => {
  const row = r07Bundle.selectedPostimages.find((item) => item.targetRef === targetRef);
  if (!row) throw new Error(`R9-R07 postimage missing for ${targetRef}`);
  const bytes = read(path.basename(row.postimageRef));
  if (sha(bytes) !== row.postimageSha256) throw new Error(`R9-R07 frozen postimage changed: ${targetRef}`);
  return { ref: row.postimageRef, sha256: row.postimageSha256, bytes };
};
const r07Cap = r07Postimage(refs.capabilities);
const r07Req = r07Postimage(refs.requirements);
const r07Leaf = r07Postimage(refs.leaf);
const r07Cross = JSON.parse(r07Postimage(refs.crosswalk).bytes.toString('utf8'));
const liveCross = JSON.parse(liveBytes[refs.crosswalk].toString('utf8'));
const originalLiveCross = structuredClone(liveCross);
const currentCaps = YAML.parse(liveBytes[refs.capabilities].toString('utf8'));
const currentReqs = YAML.parse(liveBytes[refs.requirements].toString('utf8'));
const candidateCaps = YAML.parse(r07Cap.bytes.toString('utf8'));
const candidateReqs = YAML.parse(r07Req.bytes.toString('utf8'));
const idInventory = (doc, group, childGroup) => new Map(doc[group].map((record) => [record.id, new Set((record[childGroup] ?? []).map((item) => item.id))]));
const currentCapIds = idInventory(currentCaps, 'capabilities', 'acceptanceCases');
const candidateCapIds = idInventory(candidateCaps, 'capabilities', 'acceptanceCases');
const currentReqIds = idInventory(currentReqs, 'requirements', 'acceptanceCases');
const candidateReqIds = idInventory(candidateReqs, 'requirements', 'acceptanceCases');
function isCandidateSelector(ref) {
  let match = /^\.product-experience\/pdp-0-product-truth\/capabilities\.yaml#capabilities\/@id=([^/]+)(?:\/acceptanceCases\/@id=([^/]+))?$/u.exec(ref);
  if (match) {
    const [capId, caseId] = [match[1], match[2]];
    return candidateCapIds.has(capId) && (!caseId || candidateCapIds.get(capId).has(caseId))
      && (!currentCapIds.has(capId) || (caseId && !currentCapIds.get(capId).has(caseId)));
  }
  match = /^\.product-experience\/pdp-0-product-truth\/requirements\.yaml#requirements\/@id=([^/]+)\/acceptanceCases\/@id=([^/]+)$/u.exec(ref);
  if (!match) return false;
  const [reqId, caseId] = [match[1], match[2]];
  return candidateReqIds.has(reqId) && candidateReqIds.get(reqId).has(caseId)
    && (!currentReqIds.has(reqId) || !currentReqIds.get(reqId).has(caseId));
}
const rowById = new Map(liveCross.rows.map((row) => [row.auditId, row]));
const oldRowById = new Map(r07Cross.rows.map((row) => [row.auditId, row]));
if (liveCross.rows.length !== 501 || r07Cross.rows.length !== 501) throw new Error('501-row audit denominator changed');
if (liveCross.rows.map((row) => row.auditId).join('|') !== r07Cross.rows.map((row) => row.auditId).join('|')) throw new Error('R9-R07 and live crosswalk audit identities/order differ');
let traceRows = 0;
let appendedCandidateRefs = 0;
for (const [auditId, oldRow] of oldRowById) {
  if (!oldRow.rootDirectedSourceCandidate || !oldRow.proposedPdp0SourceChange) continue;
  const row = rowById.get(auditId);
  if (!row) throw new Error(`Current crosswalk row missing: ${auditId}`);
  const introducedRefs = oldRow.pdp0EvidenceRefs.filter(isCandidateSelector);
  if (!introducedRefs.length) throw new Error(`R9-R07 has no exact new candidate selectors for ${auditId}`);
  for (const ref of introducedRefs) if (!row.pdp0EvidenceRefs.includes(ref)) {
    row.pdp0EvidenceRefs.push(ref);
    appendedCandidateRefs += 1;
  }
  row.rootDirectedSourceCandidate = structuredClone(oldRow.rootDirectedSourceCandidate);
  row.proposedPdp0SourceChange = structuredClone(oldRow.proposedPdp0SourceChange);
  traceRows += 1;
}
if (traceRows !== 18) throw new Error(`Expected 18 R9-R07 crosswalk trace rows, found ${traceRows}`);
const sourceOnlyFields = new Set(['pdp0EvidenceRefs', 'rootDirectedSourceCandidate', 'proposedPdp0SourceChange']);
for (const originalRow of originalLiveCross.rows) {
  const candidateRow = rowById.get(originalRow.auditId);
  const allowed = traceRows && candidateRow.rootDirectedSourceCandidate && candidateRow.proposedPdp0SourceChange;
  for (const key of new Set([...Object.keys(originalRow), ...Object.keys(candidateRow)])) {
    if (sourceOnlyFields.has(key)) continue;
    if (JSON.stringify(originalRow[key]) !== JSON.stringify(candidateRow[key])) throw new Error(`Unexpected live crosswalk row mutation ${originalRow.auditId}.${key}`);
  }
  if (!allowed && JSON.stringify(originalRow) !== JSON.stringify(candidateRow)) throw new Error(`Unexpected crosswalk row change ${originalRow.auditId}`);
}
const crosswalkBytes = Buffer.from(json(liveCross));
const crosswalkName = 'media-pdp0-root-selected-source-integration-r9-r08.split.pdp0-501-disposition-crosswalk.postimage.json';
writeCreateOnly(crosswalkName, crosswalkBytes);

const sourceBaseline = Object.entries(expectedLive).map(([targetRef, preimageSha256]) => ({ targetRef, preimageSha256 }));
const selectedPostimages = [
  { targetRef: refs.capabilities, postimageRef: r07Cap.ref, postimageSha256: r07Cap.sha256 },
  { targetRef: refs.requirements, postimageRef: r07Req.ref, postimageSha256: r07Req.sha256 },
  { targetRef: refs.leaf, postimageRef: r07Leaf.ref, postimageSha256: r07Leaf.sha256 },
  { targetRef: refs.crosswalk, postimageRef: `${dir}/${crosswalkName}`, postimageSha256: sha(crosswalkBytes) },
];
const allowedOperationsRef = r07Bundle.selectedAllowedOperations.ref;
const allowedOperationsBytes = read(path.basename(allowedOperationsRef));
const allowedOperations = JSON.parse(allowedOperationsBytes.toString('utf8'));
const retainedRef = r07Bundle.retainedProjection.ref;
const retainedProjection = JSON.parse(read(path.basename(retainedRef)).toString('utf8'));
if (sha(allowedOperationsBytes) !== r07Bundle.selectedAllowedOperations.sha256 || allowedOperations.operations?.length !== 122) throw new Error('Selected 122-operation ledger changed');
if (retainedProjection.operations?.length !== 248 || sha(read(path.basename(retainedRef))) !== r07Bundle.retainedProjection.sha256) throw new Error('Retained 248-operation projection changed');
const status = JSON.parse(readRoot('docs/implementation/pdp-0-phase-dev-status.json').toString('utf8'));
const statusMismatches = sourceBaseline.map(({ targetRef, preimageSha256 }) => {
  const statusKey = targetRef === refs.decisionLog ? '.product-experience/decision-log.md#PXD-225-section' : targetRef;
  const statusPin = status.sourceShaSet?.[statusKey];
  const currentSourceFingerprint = targetRef === refs.decisionLog
    ? fingerprintPxdDecisionSection(liveBytes[targetRef].toString('utf8'), 'PXD-225').sha256
    : preimageSha256;
  return { targetRef, statusPinRef: statusKey, statusPinSha256: statusPin ?? null, liveSourceFingerprintSha256: currentSourceFingerprint, liveWholeFileSha256: preimageSha256, current: statusPin === currentSourceFingerprint };
});

const baseName = 'media-pdp0-root-selected-source-integration-r9-r08';
const candidate = {
  schemaVersion: 'media.pdp0.root-selected-source-integration-successor-bundle.r9.v1',
  candidateRevision: 'R9-R08',
  status: 'CANDIDATE_ONLY_NOT_REGISTERED_NOT_APPLIED_PENDING_DISTINCT_H_REVIEW',
  phase: 'PDP-0', macroStage: 'DISCOVERY', selectedBranch: 'split',
  predecessor: { ref: r07BundleRef, sha256: sha(read(`${r07Prefix}.successor-bundle.candidate.v1.json`)), freezeRef: r07FreezeRef, freezeSha256: sha(read(`${r07Prefix}.freeze.v1.json`)), actualHReviewRef: r07HRef, actualHReviewSha256: sha(read(`${r07Prefix}.independent-peer.actual-h-r07-full.json`)), actualHDisposition: 'PASS_FOR_R9_R07_ONLY; NOT_TRANSFERRED_TO_R9_R08' },
  sourceBaseline: { status: 'EXACT_LIVE_SEVEN_TARGET_PREIMAGE_CAPTURED; PDP0_PHASE_STATUS_PINS_STALE', targets: sourceBaseline },
  selectedPostimages,
  selectedAllowedOperations: { ref: allowedOperationsRef, sha256: sha(allowedOperationsBytes), operationCount: 122 },
  retainedProjection: { ref: retainedRef, sha256: sha(read(path.basename(retainedRef))), operationCount: 248 },
  current7Preimages: sourceBaseline.map(({ targetRef, preimageSha256 }) => ({ targetRef, sha256: preimageSha256 })),
  currentStatusReadback: { ref: 'docs/implementation/pdp-0-phase-dev-status.json', sha256: sha(readRoot('docs/implementation/pdp-0-phase-dev-status.json')), status: status.status, sourcePinCount: Object.keys(status.sourceShaSet ?? {}).length, r08TargetMismatches: statusMismatches.filter((row) => !row.current).length, targetPins: statusMismatches },
  crosswalkRebase: { predecessorPostimageRef: `${dir}/${r07Prefix}.split.pdp0-501-disposition-crosswalk.postimage.json`, predecessorPostimageSha256: sha(read(`${r07Prefix}.split.pdp0-501-disposition-crosswalk.postimage.json`)), currentPreimageSha256: expectedLive[refs.crosswalk], candidatePostimageSha256: sha(crosswalkBytes), candidateTraceRows: traceRows, candidateSelectorsAppended: appendedCandidateRefs, preservationRule: 'Preserve current live row fields, current evidence references, PXD-226 AUD-SPEC-002 decisionRef, all 501 stable audit IDs, and current top-level PXD-225 metadata; add only source-candidate references absent from current capability/requirement sources plus the exact frozen R9-R07 root-directed candidate annotations.' },
  campaignDenominator: { registeredIdentities: 54, phaseCells: 216, historicalOwnerRows: 462, pdp0AuditRows: 501 },
  preservedSemanticReview: { r9R07FeatureDefinitions: 16, r9R07FeatureCases: 52, r9R07FeatureParentCases: 54, historicalHReviewRef: r07HRef, historicalHReviewSha256: sha(read(`${r07Prefix}.independent-peer.actual-h-r07-full.json`)), newR08IndependentHReview: 'PENDING_DISTINCT_REVIEWER' },
  authorityBoundary: { canonicalSourceApply: 'NOT_AUTHORIZED_BY_CANDIDATE', ownerAdoption: 'NOT_CLAIMED', independentAcceptance: 'NOT_CLAIMED', phaseStatusWrite: 'NONE', nativeClosure: 'NOT_CLAIMED', delivery: 'NOT_CLAIMED' },
};
const candidateBytes = Buffer.from(json(candidate));
const candidateName = `${baseName}.successor-bundle.candidate.v1.json`;
writeCreateOnly(candidateName, candidateBytes);
const candidateRef = `${dir}/${candidateName}`;
const verification = {
  schemaVersion: 'media.pdp0.root-selected-source-integration-r9-r08-rebuild-verification.v1',
  status: 'R9_R08_CANDIDATE_REPLAY_VERIFIED_PENDING_DISTINCT_H_REVIEW',
  candidateBundle: { ref: candidateRef, sha256: sha(candidateBytes) },
  sourceBaselineTargets: sourceBaseline.length, crosswalkRowsBefore: liveCross.rows.length, crosswalkRowsAfter: liveCross.rows.length,
  crosswalkTraceRows: traceRows, crosswalkCandidateSelectorsAppended: appendedCandidateRefs,
  selectedOperations: allowedOperations.operations.length, retainedProjectionOperations: retainedProjection.operations.length,
  r9R07PostimagesPreservedExactly: { capabilities: r07Cap.sha256, requirements: r07Req.sha256, capabilityLeafReview: r07Leaf.sha256 },
  currentStatus: { status: status.status, staleTargetPins: statusMismatches.filter((row) => !row.current).length, completeTargetPins: statusMismatches.filter((row) => row.current).length },
  denominators: candidate.campaignDenominator,
  historicalHReview: { ref: r07HRef, result: 'PASS_FOR_R9_R07_ONLY' },
  independentR08Review: 'NOT_PERFORMED; DISTINCT_REVIEWER_REQUIRED',
  canonicalApply: 'NONE', phaseStatusEffect: 'NONE', ownerAdoption: 'NONE',
  replayCommand: 'node scripts/prepare-media-pdp0-root-selected-source-integration-r9-r08-candidate.mjs --check',
};
const verificationBytes = Buffer.from(json(verification));
const verificationName = `${baseName}.rebuild-verification.candidate.v1.json`;
writeCreateOnly(verificationName, verificationBytes);
const freeze = {
  schemaVersion: 'media.pdp0.root-selected-source-integration-freeze.r9-r08.v1',
  artifactId: 'MEDIA-PDP0-ROOT-SELECTED-SOURCE-INTEGRATION-R9-R08-FREEZE-2026-10-23',
  freezeStatus: 'FROZEN_FOR_DISTINCT_ACTUAL_H_R08_REVIEW_ONLY',
  predecessor: { ref: r07FreezeRef, sha256: sha(read(`${r07Prefix}.freeze.v1.json`)), candidateBundleRef: r07BundleRef, candidateBundleSha256: sha(read(`${r07Prefix}.successor-bundle.candidate.v1.json`)), actualHReviewRef: r07HRef, actualHReviewSha256: sha(read(`${r07Prefix}.independent-peer.actual-h-r07-full.json`)), actualHDisposition: 'PASS_FOR_R9_R07_ONLY' },
  supersedesUnsentCandidate: { ref: r07BundleRef, sha256: sha(read(`${r07Prefix}.successor-bundle.candidate.v1.json`)), reason: `R9-R07 was bound to stale crosswalk preimage ${r07Bundle.sourceBaseline.targets.find((row) => row.targetRef === refs.crosswalk).preimageSha256}; R9-R08 captures ${expectedLive[refs.crosswalk]}.` },
  candidateBundle: { ref: candidateRef, sha256: sha(candidateBytes) },
  rebuildVerification: { ref: `${dir}/${verificationName}`, sha256: sha(verificationBytes) },
  operationLedger: { ref: allowedOperationsRef, sha256: sha(allowedOperationsBytes), operationCount: 122 },
  retainedProjection: { ref: retainedRef, sha256: sha(read(path.basename(retainedRef))), operationCount: 248 },
  current7Preimages: sourceBaseline.map(({ targetRef, preimageSha256 }) => ({ targetRef, sha256: preimageSha256 })),
  selectedPostimages,
  campaignDenominator: candidate.campaignDenominator,
  hReview: { predecessorReviewRef: r07HRef, predecessorReviewResult: 'PASS_FOR_R9_R07_ONLY', r08Review: 'PENDING_DISTINCT_REVIEWER' },
  sourceCurrentness: { phaseStatus: status.status, sourcePinCount: Object.keys(status.sourceShaSet ?? {}).length, staleR08TargetPins: statusMismatches.filter((row) => !row.current).length, disposition: 'CANDIDATE_CAPTURED; PDP0 STATUS NOT CURRENT' },
  sourceOwnerDecision: 'NOT_SET', rootAdoptionDecision: 'NOT_SET', applyAuthorization: 'NOT_SET', operationProfileRegistration: 'NOT_REGISTERED', canonicalApply: 'NONE', phaseStatusEffect: 'NONE', ownerAdjudicationMutations: 0, trustReconstructionMutations: 0, historicalOwnerRowsPreserved: 462, independentAcceptance: 'NOT_CLAIMED', nativeClosure: 'NOT_CLAIMED', delivery: 'NOT_CLAIMED',
};
const freezeBytes = Buffer.from(json(freeze));
writeCreateOnly(`${baseName}.freeze.v1.json`, freezeBytes);
console.log(JSON.stringify({ status: checkMode ? 'R9_R08_DETERMINISTIC_REPLAY_PASS' : 'R9_R08_CANDIDATE_FROZEN_FOR_DISTINCT_H_REVIEW', candidateBundle: { ref: candidateRef, sha256: sha(candidateBytes) }, freeze: { ref: `${dir}/${baseName}.freeze.v1.json`, sha256: sha(freezeBytes) }, crosswalkPostimage: { ref: `${dir}/${crosswalkName}`, sha256: sha(crosswalkBytes), traceRows, appendedCandidateRefs }, operationCount: 122, retainedProjectionOperationCount: 248, r08IndependentHReview: 'PENDING_DISTINCT_REVIEWER', currentPdp0Status: status.status, staleTargetPins: statusMismatches.filter((row) => !row.current).length, canonicalApply: 'NONE', phaseStatusEffect: 'NONE' }, null, 2));
