import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {fingerprintPxdDecisionSection} from './pdp0-phase-scoped-source-fingerprints.mjs';
import {validateQualityExtensionSourceDefinition} from './media-pdp0-quality-extension-source-candidate-v2.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.resolve(ROOT, '../ghatana-tools/package.json'));
const OBS = 'docs/implementation/observations/pdp0-semantic-audit-slices';
export const QUALITY_CANDIDATE_REF = `${OBS}/AUD-SPEC-002-quality-extension-source-candidate.v2.json`;
export const QUALITY_SCHEMA_REF = `${OBS}/AUD-SPEC-002-quality-extension-source-candidate.v2.schema.json`;
export const QUALITY_FREEZE_REF = `${OBS}/AUD-SPEC-002-quality-extension-source-candidate-v2-freeze-manifest.v1.json`;
export const QUALITY_PEER_REF = `${OBS}/AUD-SPEC-002-quality-extension-independent-peer.v2.json`;
export const QUALITY_OWNER_DECISION_REF = `${OBS}/AUD-SPEC-002-quality-extension-source-owner-decision.v2.json`;
export const QUALITY_APPLY_AUTHORIZATION_REF = `${OBS}/AUD-SPEC-002-quality-extension-apply-authorization.v2.json`;
export const V7_MANIFEST_REF = `${OBS}/AUD-SPEC-002-source-amendment-v7-freeze-manifest.v1.json`;
export const V7_CANDIDATE_REF = `${OBS}/AUD-SPEC-002-source-amendment-candidate.v7.json`;
export const V7_AMENDMENT_REF = `${OBS}/AUD-SPEC-002-source-amendment-postimage.v7.json`;
export const V7_PEER_REF = `${OBS}/AUD-SPEC-002-v7-quality-extension-independent-peer.v2.json`;
export const DECISION_LOG = '.product-experience/decision-log.md';
export const QUALITY_POLICY = '.product-experience/pdp-0-product-truth/quality-policy.yaml';
export const TARGETS = Object.freeze([DECISION_LOG, QUALITY_POLICY]);
const QUALITY_SOURCE_CHOICE_REF = '../ghatana-lifecycle/docs/engineering/reviews/gtool-critical-2026-10-23/media-aud-spec-002-quality-applicability-root-choice-r01.json';
const V7_SOURCE_ROOT_DECISION_REF = 'ghatana-lifecycle:docs/engineering/reviews/gtool-critical-2026-10-23/media-aud-spec-002-version-population-root-decision.json';
const V7_APPLICATIONS_CHANNELS_REF = '.product-experience/pdp-0-product-truth/applications-channels.yaml';
const V7_AUDIT_REF = 'docs/implementation/references/MEDIA-UNIFIED-PRODUCTION-ATTACHED-COMBINED-AUDIT-V3-2026-10-17.json';
const V7_TARGETS = Object.freeze([
  '.product-experience/pdp-0-product-truth/capabilities.yaml',
  '.product-experience/pdp-0-product-truth/requirements.yaml',
  `${OBS}/pdp0-501-disposition-crosswalk.json`,
  '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml',
  '.product-experience/pdp-0-product-truth/campaign-extensions.yaml',
  DECISION_LOG,
]);
const SOURCE_CUT_REFS = Object.freeze([
  QUALITY_CANDIDATE_REF, QUALITY_SCHEMA_REF, QUALITY_FREEZE_REF,
  QUALITY_PEER_REF, `${OBS}/AUD-SPEC-002-quality-extension-independent-peer.v2.schema.json`,
  QUALITY_OWNER_DECISION_REF, `${OBS}/AUD-SPEC-002-quality-extension-source-owner-decision.v2.schema.json`,
  QUALITY_APPLY_AUTHORIZATION_REF, `${OBS}/AUD-SPEC-002-quality-extension-apply-authorization.v2.schema.json`,
  `${OBS}/AUD-SPEC-002-quality-extension-source-adoption-cas-plan.v2.schema.json`,
  V7_MANIFEST_REF, V7_CANDIDATE_REF, `${OBS}/AUD-SPEC-002-source-amendment-candidate.v7.schema.json`,
  V7_AMENDMENT_REF, `${OBS}/AUD-SPEC-002-source-amendment-postimage.v7.schema.json`, V7_PEER_REF,
  QUALITY_SOURCE_CHOICE_REF, V7_SOURCE_ROOT_DECISION_REF, V7_APPLICATIONS_CHANNELS_REF, V7_AUDIT_REF,
]);
const MAX_SOURCE_FILE_BYTES = 12 * 1024 * 1024;
const MAX_SOURCE_CUT_BYTES = 64 * 1024 * 1024;
const SOURCE_OWNER = Object.freeze({identity:'agent:/root',role:'PDP0_SOURCE_OWNER'});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const read = ref => fs.readFileSync(fixedPath(ref));
const parse = bytes => JSON.parse(Buffer.from(bytes).toString('utf8'));
const ensure = (ok,message) => { if (!ok) throw new Error(message); };

function fixedPath(ref) {
  const lifecycleRef = ref.startsWith('ghatana-lifecycle:') || ref.startsWith('../ghatana-lifecycle/');
  const base = lifecycleRef ? path.resolve(ROOT,'../ghatana-lifecycle') : ROOT;
  const suffix = ref.startsWith('ghatana-lifecycle:') ? ref.slice('ghatana-lifecycle:'.length)
    : ref.startsWith('../ghatana-lifecycle/') ? ref.slice('../ghatana-lifecycle/'.length) : ref;
  ensure(typeof suffix === 'string' && suffix.length > 0 && !path.isAbsolute(suffix),`invalid fixed source ref: ${ref}`);
  const absolute = path.resolve(base,suffix);
  const relative = path.relative(base,absolute);
  ensure(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),`fixed source ref escapes its repository: ${ref}`);
  let current = fs.realpathSync(base);
  ensure(current === base,`fixed source repository root is not canonical: ${ref}`);
  const parts = relative.split(path.sep);
  for (const [index,part] of parts.entries()) {
    current = path.join(current,part);
    const stat = fs.lstatSync(current);
    ensure(!stat.isSymbolicLink(),`fixed source ref contains a symbolic link: ${ref}`);
    if (index < parts.length - 1) ensure(stat.isDirectory(),`fixed source parent is not a directory: ${ref}`);
    else ensure(stat.isFile(),`fixed source is not a regular file: ${ref}`);
  }
  return absolute;
}

function snapshotFixedSourceCut() {
  const refs = new Set(SOURCE_CUT_REFS);
  const baseCandidateBytes = fs.readFileSync(fixedPath(QUALITY_CANDIDATE_REF));
  const baseCandidate = parse(baseCandidateBytes);
  ensure(baseCandidate.schemaVersion === 'media.pdp0.quality-extension-source-candidate.v2'
    && baseCandidate.sourceChoice?.ref === QUALITY_SOURCE_CHOICE_REF
    && baseCandidate.priorQualityCandidate?.ref === `${OBS}/AUD-SPEC-002-quality-applicability-extension-candidate.v1.json`
    && baseCandidate.proposedDecisionSection?.ref === `${OBS}/AUD-SPEC-002-quality-extension-pxd227-section-candidate.v1.md`,
  'quality source candidate does not use the fixed source-choice and proposal inputs');
  ensure(Array.isArray(baseCandidate.targets) && baseCandidate.targets.length === TARGETS.length
    && baseCandidate.targets.map(row => row.targetRef).join('\n') === TARGETS.join('\n')
    && baseCandidate.targets[0].preimageRef === `${OBS}/AUD-SPEC-002-decision-log-postimage.v6.md`
    && baseCandidate.targets[1].preimageRef === QUALITY_POLICY,
  'quality source candidate target and predecessor refs differ from the fixed two-target cut');
  for (const row of baseCandidate.targets) {
    refs.add(row.targetRef);
    refs.add(row.preimageRef);
    refs.add(row.postimageRef);
  }
  refs.add(baseCandidate.priorQualityCandidate.ref);
  refs.add(baseCandidate.proposedDecisionSection.ref);
  refs.add(baseCandidate.sourceChoice.ref);

  const manifestBytes = fs.readFileSync(fixedPath(V7_MANIFEST_REF));
  const manifest = parse(manifestBytes);
  ensure(Array.isArray(manifest.targetPostimages) && manifest.targetPostimages.length === V7_TARGETS.length
    && manifest.targetPostimages.map(row => row.targetRef).join('\n') === V7_TARGETS.join('\n'),
  'V7 predecessor manifest does not contain the exact six-target order');
  ensure(Array.isArray(manifest.postimageArtifactRefs) && manifest.postimageArtifactRefs.length === V7_TARGETS.length,
    'V7 predecessor manifest does not contain all exact postimage artifacts');
  for (const target of manifest.targetPostimages) refs.add(target.targetRef);
  for (const artifact of manifest.postimageArtifactRefs) refs.add(artifact.ref);
  refs.add(manifest.reconciliationRef);

  const v7CandidateBytes = fs.readFileSync(fixedPath(V7_CANDIDATE_REF));
  const v7Candidate = parse(v7CandidateBytes);
  ensure(v7Candidate.rootDecisionRef === V7_SOURCE_ROOT_DECISION_REF
    && v7Candidate.sourceBindings?.rootDecisionSha256
    && v7Candidate.sourceBindings?.applicationsChannelsSha256
    && v7Candidate.sourceBindings?.auditSha256,
  'V7 predecessor candidate is missing its exact root decision or source bindings');
  for (const ref of [v7Candidate.rootDecisionRef,V7_APPLICATIONS_CHANNELS_REF,V7_AUDIT_REF]) refs.add(ref);
  for (const [ref,expected] of Object.entries(manifest.producerPins ?? {})) {
    ensure(typeof ref === 'string' && typeof expected === 'string', 'V7 manifest contains malformed producer pins');
    refs.add(ref);
  }
  const peer = parse(fs.readFileSync(fixedPath(V7_PEER_REF)));
  if (peer.sourceOrigin?.priorReviewRecordRef) refs.add(peer.sourceOrigin.priorReviewRecordRef);
  if (peer.sourceOrigin?.correctedSuccessorRef) refs.add(peer.sourceOrigin.correctedSuccessorRef);
  const v7Peer = parse(fs.readFileSync(fixedPath(`${OBS}/AUD-SPEC-002-source-amendment-independent-peer.v7.json`)));
  if (v7Peer.sourceOrigin?.priorReviewRecordRef) refs.add(v7Peer.sourceOrigin.priorReviewRecordRef);
  if (v7Peer.sourceOrigin?.correctedSuccessorRef) refs.add(v7Peer.sourceOrigin.correctedSuccessorRef);
  const correctedQualityPeer = parse(fs.readFileSync(fixedPath(V7_PEER_REF)));
  for (const ref of Object.values(correctedQualityPeer.reviewBinding?.exactCutRefs ?? {})) if (typeof ref === 'string') refs.add(ref);
  const qualityPeer = parse(fs.readFileSync(fixedPath(QUALITY_PEER_REF)));
  const qualityPeerPredecessor = qualityPeer.predecessor;
  ensure(qualityPeerPredecessor?.v7CandidateRef === V7_CANDIDATE_REF
    && qualityPeerPredecessor?.v7ManifestRef === V7_MANIFEST_REF
    && qualityPeerPredecessor?.v7PeerRef === V7_PEER_REF,
  'quality peer review does not point to the fixed V7 predecessor inputs');

  let totalBytes = 0;
  const snapshot = new Map();
  for (const ref of refs) {
    const bytes = fs.readFileSync(fixedPath(ref));
    ensure(bytes.length <= MAX_SOURCE_FILE_BYTES,`fixed source exceeds its byte bound: ${ref}`);
    totalBytes += bytes.length;
    ensure(totalBytes <= MAX_SOURCE_CUT_BYTES,'fixed source cut exceeds its aggregate byte bound');
    snapshot.set(ref,bytes);
  }
  for (const [ref,expectedSha256] of Object.entries(manifest.producerPins ?? {})) {
    ensure(sha(readFromSnapshot(snapshot,ref)) === expectedSha256,`V7 predecessor producer pin is stale: ${ref}`);
  }
  for (const origin of [peer.sourceOrigin,v7Peer.sourceOrigin]) {
    if (!origin) continue;
    if (origin.priorReviewRecordRef) ensure(sha(readFromSnapshot(snapshot,origin.priorReviewRecordRef)) === origin.priorReviewRecordSha256,
      `corrected peer prior-review lineage is stale: ${origin.priorReviewRecordRef}`);
    if (origin.correctedSuccessorRef) ensure(sha(readFromSnapshot(snapshot,origin.correctedSuccessorRef)) === origin.correctedSuccessorSha256,
      `corrected peer successor lineage is stale: ${origin.correctedSuccessorRef}`);
  }
  return snapshot;
}

function readFromSnapshot(snapshot,ref) {
  const bytes = snapshot.get(ref);
  ensure(Buffer.isBuffer(bytes),`fixed source cut is missing required input: ${ref}`);
  return bytes;
}

function validateFrozenCandidate({readSource}) {
  const candidateBytes = readSource(QUALITY_CANDIDATE_REF);
  const schemaBytes = readSource(QUALITY_SCHEMA_REF);
  const freezeBytes = readSource(QUALITY_FREEZE_REF);
  const candidate = parse(candidateBytes);
  const schema = parse(schemaBytes);
  const freeze = parse(freezeBytes);
  const Ajv2020 = require('ajv/dist/2020');
  ensure(new Ajv2020({strict:true}).compile(schema)(candidate), 'quality source candidate v2 is schema-invalid');
  ensure(freeze.schemaVersion === 'media.pdp0.quality-extension-source-candidate-v2-freeze-manifest.v1'
    && freeze.candidateRef === QUALITY_CANDIDATE_REF && freeze.candidateSha256 === sha(candidateBytes)
    && freeze.schemaRef === QUALITY_SCHEMA_REF && freeze.schemaSha256 === sha(schemaBytes)
    && same(freeze.targets,candidate.targets), 'quality source candidate freeze does not bind exact candidate and two target rows');
  ensure(candidate.sourceChoice?.ref === QUALITY_SOURCE_CHOICE_REF
    && sha(readSource(QUALITY_SOURCE_CHOICE_REF)) === candidate.sourceChoice.sha256,
  'quality candidate source-choice record is stale or uses an unapproved source ref');
  ensure(candidate.priorQualityCandidate?.ref === `${OBS}/AUD-SPEC-002-quality-applicability-extension-candidate.v1.json`
    && sha(readSource(candidate.priorQualityCandidate.ref)) === candidate.priorQualityCandidate.sha256,
  'quality candidate historical predecessor is stale or uses an unapproved source ref');
  ensure(candidate.proposedDecisionSection?.ref === `${OBS}/AUD-SPEC-002-quality-extension-pxd227-section-candidate.v1.md`
    && sha(readSource(candidate.proposedDecisionSection.ref)) === candidate.proposedDecisionSection.sha256,
  'PXD-227 decision-section proposal is stale or uses an unapproved source ref');
  const targetBytes = new Map();
  for (const target of candidate.targets) {
    ensure(TARGETS.includes(target.targetRef), `candidate contains unapproved source target ${target.targetRef}`);
    const bytes = readSource(target.postimageRef);
    ensure(sha(bytes) === target.postimageSha256, `candidate postimage hash mismatch: ${target.postimageRef}`);
    targetBytes.set(target.targetRef, bytes);
  }
  ensure(candidate.targets.length === 2 && candidate.targets.map(row => row.targetRef).join('\n') === TARGETS.join('\n'), 'candidate target order is not the exact reviewed two-target order');
  const targetFingerprint = sha(Buffer.from(JSON.stringify(candidate.targets.map(({targetRef,preimageSha256,postimageSha256}) => ({targetRef,preimageSha256,postimageSha256})))));
  ensure(targetFingerprint === candidate.candidatePostimageSha256,
    'candidate aggregate postimage fingerprint is invalid');
  const decisionSectionSha256 = fingerprintPxdDecisionSection(targetBytes.get(DECISION_LOG).toString('utf8'),'PXD-227').sha256;
  return {candidate,candidateBytes,schemaBytes,freeze,freezeBytes,targetBytes,decisionSectionSha256};
}

function validateV7CurrentCut({readSource,candidate,peer}) {
  const manifestBytes = readSource(V7_MANIFEST_REF);
  const manifest = parse(manifestBytes);
  const v7CandidateBytes = readSource(V7_CANDIDATE_REF);
  const v7Candidate = parse(v7CandidateBytes);
  const v7AmendmentBytes = readSource(V7_AMENDMENT_REF);
  const v7Amendment = parse(v7AmendmentBytes);
  const actualV7PeerBytes = readSource(V7_PEER_REF);
  const actualV7Peer = parse(actualV7PeerBytes);
  ensure(candidate.predecessor.v7CandidateRef === V7_CANDIDATE_REF
    && candidate.predecessor.v7CandidateSha256 === sha(v7CandidateBytes)
    && candidate.predecessor.v7ManifestSha256 === sha(manifestBytes)
    && candidate.predecessor.correctedPeerSha256 === sha(actualV7PeerBytes)
    && manifest.candidateSha256 === sha(v7CandidateBytes)
    && manifest.sourceAmendmentSha256 === sha(v7AmendmentBytes)
    && v7Candidate.schemaVersion === 'media.pdp0.aud-spec-002-source-amendment-candidate.v7'
    && v7Amendment.schemaVersion === 'media.pdp0.aud-spec-002-source-amendment-postimage.v7'
    && actualV7Peer.schemaVersion === 'media.pdp0.aud-spec-002-distinct-technical-peer-review.v2',
  'quality candidate predecessor V7 manifest or peer pin is stale');
  ensure(actualV7Peer.reviewBinding?.exactCutSha256?.v7Candidate === sha(v7CandidateBytes)
    && actualV7Peer.reviewBinding?.exactCutSha256?.v7Manifest === sha(manifestBytes)
    && actualV7Peer.reviewBinding?.exactCutSha256?.v7Amendment === sha(v7AmendmentBytes)
    && actualV7Peer.reviewBinding?.exactCutSha256?.qualityCandidate === candidate.priorQualityCandidate.sha256
    && actualV7Peer.reviewBinding?.exactCutSha256?.rootChoice === candidate.sourceChoice.sha256,
  'corrected V7 predecessor peer review does not bind the exact upstream artifacts');
  const v7TargetOrder = manifest.targetPostimages.map(row => row.targetRef);
  ensure(v7TargetOrder.join('\n') === V7_TARGETS.join('\n')
    && v7Candidate.exactFileTargets?.length === V7_TARGETS.length,
  'V7 predecessor target set is not the exact six-source order');
  const v7TargetBindings = new Map(v7Candidate.exactFileTargets.map(row => [row.targetRef,row]));
  for (const row of manifest.targetPostimages) {
    const candidateRow = v7TargetBindings.get(row.targetRef);
    ensure(candidateRow?.preimageSha256 === row.preimageSha256 && candidateRow?.postimageSha256 === row.postimageSha256,
      `V7 manifest target differs from candidate target binding: ${row.targetRef}`);
  }
  ensure(sha(readSource(V7_SOURCE_ROOT_DECISION_REF)) === v7Candidate.sourceBindings?.rootDecisionSha256
    && sha(readSource(V7_APPLICATIONS_CHANNELS_REF)) === v7Candidate.sourceBindings?.applicationsChannelsSha256
    && sha(readSource(V7_AUDIT_REF)) === v7Candidate.sourceBindings?.auditSha256,
  'V7 predecessor non-target source inputs changed after the reviewed candidate cut');
  const rows = manifest.targetPostimages.map(row => ({targetRef:row.targetRef,expectedPreimageSha256:row.preimageSha256,
    expectedPostimageSha256:row.postimageSha256,actualSha256:sha(readSource(row.targetRef))}));
  ensure(rows.length === 6, 'V7 manifest must bind exactly six predecessor targets');
  const state = rows.every(row => row.actualSha256 === row.expectedPostimageSha256) ? 'EXACT_CURRENT_READBACK'
    : rows.every(row => row.actualSha256 === row.expectedPreimageSha256) ? 'NOT_APPLIED' : 'DIVERGED';
  ensure(peer.predecessor.v7CandidateSha256 === manifest.candidateSha256
    && peer.predecessor.v7ManifestSha256 === sha(manifestBytes), 'new quality peer review does not bind the current V7 predecessor');
  return {manifest,manifestBytes,peer:actualV7Peer,peerBytes:actualV7PeerBytes,rows,state};
}

function exactKeys(object,keys,label) {
  ensure(object && typeof object === 'object' && !Array.isArray(object)
    && same(Object.keys(object).sort(),[...keys].sort()),`${label} has missing or unrecognized fields`);
}

/** Fingerprint a serialized review plan; this value is only an optimistic review identity, never authority. */
export function qualityExtensionAdoptionPlanFingerprint(plan) {
  ensure(plan && typeof plan === 'object' && !Array.isArray(plan), 'quality adoption plan fingerprint requires an object');
  return sha(Buffer.from(JSON.stringify(plan)));
}

function validateNewPeer(peer,context) {
  const Ajv2020 = require('ajv/dist/2020');
  const schema = parse(context.readSource(`${OBS}/AUD-SPEC-002-quality-extension-independent-peer.v2.schema.json`));
  ensure(new Ajv2020({strict:true}).compile(schema)(peer), 'quality two-target peer review is schema-invalid');
  ensure(peer.candidateRef === QUALITY_CANDIDATE_REF && peer.candidateSha256 === sha(context.candidateBytes)
    && peer.candidatePostimageSha256 === context.candidate.candidatePostimageSha256
    && peer.disposition === 'TECHNICAL_APPROVE_EXACT_CANDIDATE_ONLY' && peer.findings.length === 0
    && peer.reviewer.identity !== SOURCE_OWNER.identity && peer.reviewer.identity !== context.candidate.candidateAuthor.identity
    && same(peer.targetPostimages,context.candidate.targets.map(({targetRef,preimageSha256,postimageSha256}) => ({targetRef,preimageSha256,postimageSha256}))),
  'quality peer review does not approve this exact candidate or distinct source author/owner cut');
  return peer.reviewer.identity;
}

function validateOwnerDecision(decision,context) {
  const schema = parse(context.readSource(`${OBS}/AUD-SPEC-002-quality-extension-source-owner-decision.v2.schema.json`));
  const Ajv2020 = require('ajv/dist/2020');
  ensure(new Ajv2020({strict:true}).compile(schema)(decision), 'quality source-owner decision v2 is schema-invalid');
  ensure(decision.candidateSha256 === sha(context.candidateBytes)
    && decision.candidatePostimageSha256 === context.candidate.candidatePostimageSha256
    && decision.peerReviewSha256 === sha(context.peerBytes)
    && decision.v7ManifestSha256 === context.v7.manifestSha256
    && decision.decisionSectionSha256 === context.frozen.decisionSectionSha256
    && same(decision.targetRows,context.candidate.targets.map(({targetRef,preimageSha256,postimageSha256}) => ({targetRef,expectedPreimageSha256:preimageSha256,expectedPostimageSha256:postimageSha256}))),
  'quality source-owner decision does not authorize the exact reviewed candidate, PXD-227, and two postimages');
  return decision;
}

function validateApplyAuthorization(authorization,context) {
  const schema = parse(context.readSource(`${OBS}/AUD-SPEC-002-quality-extension-apply-authorization.v2.schema.json`));
  const Ajv2020 = require('ajv/dist/2020');
  ensure(new Ajv2020({strict:true}).compile(schema)(authorization), 'quality apply authorization v2 is schema-invalid');
  ensure(authorization.candidateSha256 === sha(context.candidateBytes)
    && authorization.candidatePostimageSha256 === context.candidate.candidatePostimageSha256
    && authorization.sourceOwnerDecisionSha256 === sha(context.decisionBytes)
    && authorization.peerReviewSha256 === sha(context.peerBytes)
    && authorization.decisionSectionSha256 === context.frozen.decisionSectionSha256
    && authorization.distinctTechnicalPeer.identity === context.peerIdentity
    && authorization.distinctTechnicalPeer.reviewedCandidateSha256 === sha(context.candidateBytes)
    && authorization.distinctTechnicalPeer.reviewedPostimageSha256 === context.candidate.candidatePostimageSha256
    && same(authorization.targetRows,context.decision.targetRows),
  'quality apply authorization does not bind the exact two-target source decision and peer');
}

/** Read-only currentness planning; no canonical files are changed. */
export function planQualityExtensionSourceAdoptionV2({readSource = read, peerReviewBytes, ownerDecisionBytes, applyAuthorizationBytes} = {}) {
  const frozen = validateFrozenCandidate({readSource});
  const optionalRead = ref => {
    try { return readSource(ref); }
    catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
  };
  const peerBytes = peerReviewBytes ?? optionalRead(QUALITY_PEER_REF);
  ownerDecisionBytes ??= optionalRead(QUALITY_OWNER_DECISION_REF);
  applyAuthorizationBytes ??= optionalRead(QUALITY_APPLY_AUTHORIZATION_REF);
  const peer = peerBytes ? parse(peerBytes) : null;
  const v7 = validateV7CurrentCut({readSource,candidate:frozen.candidate,peer:peer ?? frozen.candidate});
  const liveTargets = TARGETS.map(targetRef => {
    const candidate = frozen.candidate.targets.find(row => row.targetRef === targetRef);
    const actualSha256 = sha(readSource(targetRef));
    const isV7DecisionLog = targetRef === DECISION_LOG;
    const state = isV7DecisionLog && v7.state === 'NOT_APPLIED' ? 'WAITING_FOR_V7_POSTIMAGE'
      : actualSha256 === candidate.preimageSha256 ? 'EXACT_PREIMAGE'
        : actualSha256 === candidate.postimageSha256 ? 'EXACT_POSTIMAGE' : 'SOURCE_DIVERGED';
    return {targetRef,expectedPreimageSha256:candidate.preimageSha256,expectedPostimageSha256:candidate.postimageSha256,actualSha256,
      state};
  });
  const blockers = [];
  if (v7.state === 'NOT_APPLIED') blockers.push('V7_SIX_SOURCE_AMENDMENT_NOT_APPLIED');
  if (v7.state === 'DIVERGED') blockers.push('V7_SOURCE_TARGET_DIVERGED_REQUIRES_EXPLICIT_RECONCILIATION');
  if (v7.state === 'EXACT_CURRENT_READBACK' && liveTargets.some(row => row.state !== 'EXACT_PREIMAGE')) blockers.push('TWO_TARGET_SOURCE_PREIMAGE_NOT_CURRENT');
  if (!peer) blockers.push('DISTINCT_PEER_REVIEW_OF_EXACT_TWO_TARGET_CANDIDATE_REQUIRED');
  let peerIdentity;
  if (peer) peerIdentity = validateNewPeer(peer,{candidate:frozen.candidate,candidateBytes:frozen.candidateBytes,readSource});
  if (!ownerDecisionBytes) blockers.push('ROOT_SOURCE_OWNER_DECISION_REQUIRED');
  const decision = ownerDecisionBytes ? parse(ownerDecisionBytes) : null;
  const decisionContext = {candidate:frozen.candidate,candidateBytes:frozen.candidateBytes,peerBytes,v7:{manifestSha256:sha(v7.manifestBytes)},frozen,readSource};
  if (decision) validateOwnerDecision(decision,decisionContext);
  if (!applyAuthorizationBytes) blockers.push('EXACT_TWO_TARGET_APPLY_AUTHORIZATION_REQUIRED');
  const authorization = applyAuthorizationBytes ? parse(applyAuthorizationBytes) : null;
  if (authorization) validateApplyAuthorization(authorization,{...decisionContext,decisionBytes:ownerDecisionBytes,decision,peerIdentity});
  const plan = {
    schemaVersion:'media.pdp0.quality-extension-source-adoption-cas-plan.v2',
    planKind:'NON_MUTATING_EXACT_TWO_TARGET_QUALITY_EXTENSION_SOURCE_CAS_PLAN',
    planDisposition:blockers.length ? 'BLOCKED_PENDING_EXACT_PREREQUISITES' : 'READY_FOR_SHARED_OWNER_CONTROLLED_CAS',
    candidateRef:QUALITY_CANDIDATE_REF,candidateSchemaVersion:frozen.candidate.schemaVersion,candidateSha256:sha(frozen.candidateBytes),
    candidatePostimageSha256:frozen.candidate.candidatePostimageSha256,
    sourceOwnerDecisionRef:QUALITY_OWNER_DECISION_REF,sourceOwnerDecisionSha256:decision ? sha(ownerDecisionBytes) : null,
    technicalPeerReviewRef:QUALITY_PEER_REF,technicalPeerReviewSha256:peer ? sha(peerBytes) : null,
    v7Predecessor:{manifestRef:V7_MANIFEST_REF,manifestSha256:sha(v7.manifestBytes),peerRef:V7_PEER_REF,peerSha256:sha(v7.peerBytes),state:v7.state,targets:v7.rows},
    decisionRef:'.product-experience/decision-log.md#PXD-227',decisionSectionSha256:frozen.decisionSectionSha256,
    applyAuthorizationSha256:authorization ? sha(Buffer.from(`${JSON.stringify(authorization,null,2)}\n`)) : null,
    sourceOwnerIdentity:SOURCE_OWNER.identity,sourceOwnerRole:SOURCE_OWNER.role,peerIdentity:peerIdentity ?? null,
    blockers,targets:liveTargets.map(({targetRef,expectedPreimageSha256,expectedPostimageSha256}) => ({targetRef,expectedPreimageSha256,expectedPostimageSha256})),
    authorityBoundary:{sourceOwnerAdoption:decision ? 'EXACT_DECISION_RECORDED' : 'PENDING',canonicalApply:'NOT_PERFORMED',
      sourceCurrentness:'NOT_CLAIMED',phaseStatusEffect:'NONE',independentAcceptance:'NOT_CLAIMED',nativeProof:'NOT_CLAIMED',runtimeAdmission:'NOT_ADMITTED'},
  };
  return {plan,frozen,v7,liveTargets,peerBytes,peer,ownerDecisionBytes,decision,applyAuthorizationBytes,authorization};
}

/** Effect path re-resolves every fixed authority/source input at dispatch and delegates to shared CAS. */
export async function applyQualityExtensionSourceAdoptionV2({expectedPlanSha256} = {}) {
  ensure(typeof expectedPlanSha256 === 'string' && /^[a-f0-9]{64}$/u.test(expectedPlanSha256),
    'quality source apply requires the exact previously reviewed plan fingerprint');
  const snapshot = snapshotFixedSourceCut();
  const current = planQualityExtensionSourceAdoptionV2({readSource:ref => readFromSnapshot(snapshot,ref)});
  ensure(qualityExtensionAdoptionPlanFingerprint(current.plan) === expectedPlanSha256,
    'quality source adoption plan changed since review; rebuild the exact plan from the current fixed source cut');
  ensure(current.plan.planDisposition === 'READY_FOR_SHARED_OWNER_CONTROLLED_CAS' && current.plan.blockers.length === 0,
    'quality extension apply is blocked by current fixed authority or source inputs');
  const cas = await import('./media-pdp0-review-successor-cas.mjs');
  ensure(typeof cas.commitValidatedPdp0SourceAmendmentQualityTwoTarget === 'function',
    'shared CAS does not yet expose the dedicated quality two-target transaction; apply remains unavailable');
  const targets = current.frozen.candidate.targets.map(row => ({
    targetRef:row.targetRef,
    expectedPreimageSha256:row.preimageSha256,expectedPostimageSha256:row.postimageSha256,
    preimageBytes:readFromSnapshot(snapshot,row.targetRef),postimageBytes:current.frozen.targetBytes.get(row.targetRef)}));
  return cas.commitValidatedPdp0SourceAmendmentQualityTwoTarget({plan:current.plan,targets});
}

/** Exact two-file post-write readback; the decision log is a declared V7 successor. */
export function verifyQualityExtensionSourceAdoptionV2({readSource = read} = {}) {
  const frozen = validateFrozenCandidate({readSource});
  const readbacks = frozen.candidate.targets.map(row => ({targetRef:row.targetRef,expectedPostimageSha256:row.postimageSha256,actualSha256:sha(readSource(row.targetRef))}));
  ensure(readbacks.every(row => row.actualSha256 === row.expectedPostimageSha256), 'quality two-target source readback is not the exact authorized postimage');
  const qualityPolicy = require('yaml').parse(readSource(QUALITY_POLICY).toString('utf8'));
  const population = validateQualityExtensionSourceDefinition(qualityPolicy);
  const decisionText = readSource(DECISION_LOG).toString('utf8');
  ensure(fingerprintPxdDecisionSection(decisionText,'PXD-227').sha256 === frozen.decisionSectionSha256
    && (decisionText.match(/^### PXD-226\b/gmu) ?? []).length === 1,
  'PXD-227 exact section readback or PXD-226 preservation check failed');
  return {state:'EXACT_TWO_TARGET_POSTIMAGE_READBACK',targets:readbacks,decisionRef:'.product-experience/decision-log.md#PXD-227',
    decisionSectionSha256:frozen.decisionSectionSha256,population,sourceCurrentness:'NOT_CLAIMED',phaseStatusEffect:'NONE',
    independentAcceptance:'NOT_CLAIMED',nativeProof:'NOT_CLAIMED'};
}
