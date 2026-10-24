import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = process.cwd();
const dir = 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const refPath = (name) => path.join(root, dir, name);
const read = (name) => fs.readFileSync(refPath(name), 'utf8');
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const checkMode = process.argv.includes('--check');
const outputName = 'media-pdp0-root-selected-source-integration-r9-r07.guarded-application-packet.v1.json';
const freezeName = 'media-pdp0-root-selected-source-integration-r9-r07.freeze.v1.json';
const bundleName = 'media-pdp0-root-selected-source-integration-r9-r07.successor-bundle.candidate.v1.json';
const hName = 'media-pdp0-root-selected-source-integration-r9-r07.independent-peer.actual-h-r07-full.json';
const freeze = JSON.parse(read(freezeName));
const bundle = JSON.parse(read(bundleName));
const hBytes = read(hName);
const h = JSON.parse(hBytes);
const current7 = freeze.current7Preimages.map((row) => ({ targetRef: row.targetRef, expectedLivePreimageSha256: row.sha256, observedLiveSha256: sha(fs.readFileSync(path.join(root, row.targetRef))), livePreimageMatches: sha(fs.readFileSync(path.join(root, row.targetRef))) === row.sha256 }));
const selectedTargets = freeze.selectedPostimages.map((row) => ({ targetRef: row.targetRef, preimageSha256: freeze.current7Preimages.find((x) => x.targetRef === row.targetRef)?.sha256 ?? null, postimageRef: row.postimageRef, postimageSha256: row.postimageSha256, postimageHashMatches: sha(read(path.basename(row.postimageRef))) === row.postimageSha256 }));
const readOnlyTargets = current7.filter((x) => !selectedTargets.some((target) => target.targetRef === x.targetRef));
const blockers = [];
if (h.reviewStatus !== 'PASS' || h.sourceBaseline?.freezeSha256 !== sha(read(freezeName)) || h.sourceBaseline?.candidateBundleSha256 !== sha(read(bundleName))) blockers.push('EXACT_R9_R07_FULL_CUT_REVIEW_PIN_NOT_PASS_OR_MISMATCHED');
if (!current7.every((x) => x.livePreimageMatches)) blockers.push('LIVE_SEVEN_SOURCE_PREIMAGE_READSET_MISMATCH');
if (!selectedTargets.every((x) => x.postimageHashMatches && x.preimageSha256)) blockers.push('SELECTED_POSTIMAGE_OR_PREIMAGE_PIN_MISMATCH');
if (freeze.sourceOwnerDecision !== 'RECORDED') blockers.push('EXACT_SOURCE_OWNER_DECISION_NOT_RECORDED');
if (freeze.rootAdoptionDecision !== 'RECORDED') blockers.push('EXACT_ROOT_ADOPTION_DECISION_NOT_RECORDED');
if (freeze.schemaRegistration !== 'REGISTERED') blockers.push('EXACT_OPERATION_PROFILE_REGISTRATION_NOT_RECORDED');
if (freeze.applyAuthorization !== 'AUTHORIZED') blockers.push('DISTINCT_EXACT_INPUT_APPLY_AUTHORIZATION_NOT_RECORDED');
const packet = {
  schemaVersion: 'media.pdp0.root-selected-source-integration-r9-r07.guarded-application-packet.v1',
  artifactId: 'MEDIA-PDP0-ROOT-SELECTED-SOURCE-INTEGRATION-R9-R07-GUARDED-APPLICATION-PACKET-2026-10-23',
  packetStatus: 'PREPARED_READ_ONLY_BLOCKED_AWAITING_AUTHORITY_INPUTS',
  candidate: { revision: 'R9-R07', freezeRef: `${dir}/${freezeName}`, freezeSha256: sha(read(freezeName)), bundleRef: `${dir}/${bundleName}`, bundleSha256: sha(read(bundleName)), actualHReviewRef: `${dir}/${hName}`, actualHReviewSha256: sha(hBytes), actualHReviewStatus: h.reviewStatus },
  phase: { macroStage: 'DISCOVERY', exactPhase: 'PDP-0 Product Truth', liveStatusRef: 'docs/implementation/pdp-0-phase-dev-status.json', liveStatusSha256: sha(fs.readFileSync(path.join(root, 'docs/implementation/pdp-0-phase-dev-status.json'))), liveStatus: JSON.parse(fs.readFileSync(path.join(root, 'docs/implementation/pdp-0-phase-dev-status.json'))).status, sourcePinCount: 188, staleLiveSourcePins: 9, missingLiveSourcePins: 21, discoveryBarrier: 'FAIL', phaseStatusEffect: 'NONE' },
  campaignDenominator: { physicalCandidates: 26, compositionsIncludingRoot: 7, logicalConsumers: 21, registeredIdentities: 54, phaseCells: 216, historicalOwnerRows: 462, pdp0AuditRows: 501 },
  sourceReadSet: { count: current7.length, allSevenLivePreimagesMatch: current7.every((x) => x.livePreimageMatches), targets: current7 },
  selectedTargets,
  readOnlyPreimages: readOnlyTargets,
  operationProfile: { ref: freeze.operationLedger.ref, sha256: freeze.operationLedger.sha256, operationCount: 122, schemaRef: freeze.operationSchema.ref, schemaSha256: freeze.operationSchema.sha256 },
  retainedProjection: bundle.retainedProjection,
  authorityInputs: { sourceOwnerDecision: freeze.sourceOwnerDecision, rootAdoptionDecision: freeze.rootAdoptionDecision, profileRegistration: freeze.schemaRegistration, applyAuthorization: freeze.applyAuthorization },
  blockers,
  requiredOrder: [
    'Authentic PDP-0 source owner reviews the exact R9-R07 candidate and records or declines owner adoption under the registered revision-specific schema.',
    'Authentic root authority records a separate exact adoption decision bound to the owner decision and R9-R07 H review.',
    'PDP-0 authority registry registers the exact operation profile against those decisions.',
    'Distinct apply authority authorizes exact ordered targets and preimages.',
    'Only then may the guarded writer revalidate all seven read-set inputs under CAS, snapshot preimages, journal renames, and verify readback.'
  ],
  effectBoundary: { canonicalApply: 'NONE', sourceOwnerApproval: 'NOT_CLAIMED', rootAdoption: 'NOT_CLAIMED', applyAuthorization: 'NOT_CLAIMED', phaseStatusEffect: 'NONE', independentAcceptance: 'NOT_CLAIMED', nativeClosure: 'NOT_CLAIMED', release: 'NOT_CLAIMED' },
};
const bytes = json(packet);
const output = refPath(outputName);
if (fs.existsSync(output)) {
  if (!checkMode || fs.readFileSync(output, 'utf8') !== bytes) throw new Error(`Refusing overwrite or replay mismatch: ${output}`);
} else {
  if (checkMode) throw new Error(`Guard packet replay target missing: ${output}`);
  fs.writeFileSync(output, bytes, { flag: 'wx' });
}
console.log(JSON.stringify({ status: packet.packetStatus, ref: `${dir}/${outputName}`, sha256: sha(bytes), blockerCount: blockers.length, allSevenLivePreimagesMatch: packet.sourceReadSet.allSevenLivePreimagesMatch, selectedTargets: selectedTargets.length, canonicalApply: 'NONE' }, null, 2));
