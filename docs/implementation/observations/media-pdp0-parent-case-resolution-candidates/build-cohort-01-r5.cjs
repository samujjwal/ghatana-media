#!/usr/bin/env node
// Deterministically rebuilds a noncanonical cohort 01 R5 source-amendment
// proposal and its complete YAML snapshots from the frozen R3 proposal plus
// current PDP-0 source records. It never writes canonical sources.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');

const root = process.cwd();
const dir = 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const abs = (p) => path.join(root, p);
const read = (p) => fs.readFileSync(abs(p));
const json = (p) => JSON.parse(read(p));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const write = (p, b) => fs.writeFileSync(abs(p), b);
const dumpJson = (v) => Buffer.from(`${JSON.stringify(v, null, 2)}\n`);
const sourceCapsRef = '.product-experience/pdp-0-product-truth/capabilities.yaml';
const sourceReqRef = '.product-experience/pdp-0-product-truth/requirements.yaml';
const capPostRef = `${dir}/cohort-01.r3.source-amendment-capabilities.postimage.r5.yaml`;
const reqPostRef = `${dir}/cohort-01.r3.source-amendment-requirements.postimage.r5.yaml`;
const candidateRef = `${dir}/cohort-01.r3.source-amendment-candidate.r5.json`;
const postRef = `${dir}/cohort-01.r3.source-amendment-postimages.r5.json`;
const recordPostRef = `${dir}/cohort-01.r3.source-amendment-record-postimages.r5.json`;

const oldCandidatePath = `${dir}/cohort-01.r3.source-amendment-candidate.v2.json`;
const oldCandidate = json(oldCandidatePath);
const oldBytes = read(oldCandidatePath);
const sourcePeerPath = `${dir}/cohort-01.r3.source-content-peer.v1.json`;
const sourcePeer = json(sourcePeerPath);
const r3PeerSha = sha(read(sourcePeerPath));
const capBytes = read(sourceCapsRef);
const reqBytes = read(sourceReqRef);
const capDoc = YAML.parseDocument(capBytes.toString('utf8')).toJS();
const reqDoc = YAML.parseDocument(reqBytes.toString('utf8')).toJS();
const capById = new Map(capDoc.capabilities.map((x) => [x.id, x]));
const reqById = new Map(reqDoc.requirements.map((x) => [x.id, x]));
const liveFingerprintPaths = Object.keys(oldCandidate.sourceBaseline.currentSourceFingerprints);
const liveFingerprints = Object.fromEntries(liveFingerprintPaths.map((p) => [p, sha(read(p))]));

const caseIds = {
  'AUD-COLLAB-003': {
    'media.quality.compare': ['MEDIA-P0-COHORT01-AUD-COLLAB-003-COMPARE-POS', 'MEDIA-P0-COHORT01-AUD-COLLAB-003-COMPARE-NEG'],
    'media.project.review': ['MEDIA-P0-COHORT01-AUD-COLLAB-003-REVIEW-POS', 'MEDIA-P0-COHORT01-AUD-COLLAB-003-REVIEW-NEG'],
  },
  'AUD-COLOR-010': {
    'media.color.skin-tone-preserve': ['MEDIA-P0-COHORT01-AUD-COLOR-010-COLOR-POS', 'MEDIA-P0-COHORT01-AUD-COLOR-010-COLOR-NEG'],
    'media.compose.track.video-audio-caption-overlay': ['MEDIA-P0-COHORT01-AUD-COLOR-010-OVERLAY-POS', 'MEDIA-P0-COHORT01-AUD-COLOR-010-OVERLAY-NEG'],
  },
  'AUD-DELIV-013': {
    'media.speech.transcription.subtitle.generate': ['MEDIA-P0-COHORT01-AUD-DELIV-013-GENERATE-POS', 'MEDIA-P0-COHORT01-AUD-DELIV-013-GENERATE-NEG'],
    'media.compose.track.video-audio-caption-overlay': ['MEDIA-P0-COHORT01-AUD-DELIV-013-COMPOSE-POS', 'MEDIA-P0-COHORT01-AUD-DELIV-013-COMPOSE-NEG'],
    'media.deliver.subtitles': ['MEDIA-P0-COHORT01-AUD-DELIV-013-DELIVER-POS', 'MEDIA-P0-COHORT01-AUD-DELIV-013-DELIVER-NEG'],
  },
  'AUD-DELIV-015': {
    'media.sync.sample-accurate-av-map': ['MEDIA-P0-COHORT01-AUD-DELIV-015-MAP-POS', 'MEDIA-P0-COHORT01-AUD-DELIV-015-MAP-NEG'],
    'media.quality.video.video.assess-av-sync': ['MEDIA-P0-COHORT01-AUD-DELIV-015-ASSESS-POS', 'MEDIA-P0-COHORT01-AUD-DELIV-015-ASSESS-NEG'],
  },
};

const narratives = {
  'media.quality.compare': {
    given: 'One or more admitted candidate artifacts or an execution observation and a quality question with bounds are supplied.',
    when: 'The caller requests candidate quality comparison.',
    then: 'Return only a source-versioned quality observation or bounded repair plan; do not change project review state, create annotations, or assert quality signoff.',
    negative: 'A required artifact, quality question, bound, method, or authority is missing, stale, denied, or unsupported.',
    negativeThen: 'Return UNKNOWN, BLOCKED, or REJECTED as applicable; do not create a comparison result, project mutation, annotation, or quality signoff.',
  },
  'media.project.review': {
    given: 'A user review intent and an immutable versioned project are supplied with current assigned review authority for the exact scope and purpose.',
    when: 'The caller records one declared project review action.',
    then: 'Record only the actor, declared action, purpose, scope, immutable project version, assigned authority, and linked evidence; leave the reviewed project version unchanged.',
    negative: 'The intent, project version, declared action, assigned authority, or scoped evidence is missing, stale, denied, or unsupported.',
    negativeThen: 'Return UNKNOWN, BLOCKED, or REJECTED as applicable; do not change the project, create annotations, assert comparison evidence, or issue quality signoff.',
  },
  'media.color.skin-tone-preserve': {
    given: 'A source media artifact and declared source/target color contexts are supplied.',
    when: 'The caller requests the bounded skin-tone color-treatment operation.',
    then: 'Return only a color-managed derivative and transform provenance when supported; make no skin-tone fidelity, safety, or conformance claim without named criteria and evidence.',
    negative: 'The source artifact, color context, required authority, or supported treatment is missing, unknown, denied, or unsupported.',
    negativeThen: 'Return UNKNOWN, UNAVAILABLE, or REJECTED as applicable; do not infer color safety, contrast, fidelity, or successful skin-tone preservation.',
  },
  'media.compose.track.video-audio-caption-overlay': {
    given: 'A versioned project with selected source artifacts and a composition intent identifying the requested caption-overlay operation are supplied.',
    when: 'The caller requests video/audio/caption/overlay composition.',
    then: 'Return only a versioned composition and render manifest for the requested composition; do not assert color treatment, skin-tone preservation, or delivery completion.',
    negative: 'The project, selected artifacts, composition intent, required authority, or supported composition profile is missing, stale, denied, or unsupported.',
    negativeThen: 'Return UNKNOWN, UNAVAILABLE, or REJECTED as applicable; do not create a composition or imply color-quality or delivery outcomes.',
  },
  'media.speech.transcription.subtitle.generate': {
    given: 'An exact transcript or recognition-result version, source audio or video version, and requested output language and profile are supplied.',
    when: 'The caller requests subtitle generation.',
    then: 'Return a distinct subtitle draft version, segment timing/alignment disposition, and source/operation provenance; do not register the draft as approved or delivered output.',
    negative: 'A transcript, source version, language/profile, required authority, or supported generation condition is missing, stale, denied, or unsupported.',
    negativeThen: 'Return UNKNOWN, UNAVAILABLE, or REJECTED as applicable; do not generate an approved subtitle, overlay composition, or delivery package.',
  },
  'media.deliver.subtitles': {
    given: 'An accepted media artifact or composition and a requested delivery profile and destination are supplied.',
    when: 'The caller requests subtitle delivery using an explicitly supported sidecar or embedded packaging form.',
    then: 'Return only a source-derived delivery package or explicit delivery outcome; do not generate subtitle text, perform burned-in composition, or imply delivery success beyond the returned outcome.',
    negative: 'The accepted artifact/composition, requested profile/destination, required authority, or support for the requested packaging form is missing, stale, denied, or unsupported.',
    negativeThen: 'Return UNKNOWN, UNAVAILABLE, or REJECTED as applicable; do not substitute burned-in overlay composition or claim a delivered package.',
  },
  'media.sync.sample-accurate-av-map': {
    given: 'Timestamped audio/video or caption artifacts and an explicit alignment intent are supplied.',
    when: 'The caller requests an audio/video alignment map.',
    then: 'Return only an alignment map and any declared derived synchronized artifact; a mapping candidate is not measured sync verification.',
    negative: 'The source versions, timebase, alignment intent, required authority, or supported mapping conditions are missing, stale, denied, or unsupported.',
    negativeThen: 'Return UNKNOWN, UNAVAILABLE, or REJECTED as applicable; do not claim a verified sync measurement or substitute an assessment.',
  },
  'media.quality.video.video.assess-av-sync': {
    given: 'A video candidate and applicable reference/measurement context are supplied with a named method, scope, tolerance, timebase, and exact source versions.',
    when: 'The caller requests a read-only audio/video synchronization assessment.',
    then: 'Return a bounded video-quality observation or explicit abstention with method, scope, measured value or abstention, uncertainty, source/timebase, and observation time; do not create an alignment map or alter media.',
    negative: 'The candidate, applicable reference/context, method, scope, tolerance, timebase, source version, required authority, or evidence is missing, stale, denied, or unsupported.',
    negativeThen: 'Return UNKNOWN, BLOCKED, or REJECTED as applicable; a mapping candidate is never assessment evidence.',
  },
};

function clone(x) { return JSON.parse(JSON.stringify(x)); }
function capTemplate(auditId, capId) {
  const x = oldCandidate.capabilityAcceptanceCaseAdditions.find((a) => a.auditId === auditId && a.capabilityId === capId);
  if (!x) throw new Error(`missing capability template ${auditId}/${capId}`);
  return clone(x);
}
function reqTemplate(auditId, reqId) {
  const x = oldCandidate.requirementAcceptanceCaseAdditions.find((a) => a.auditId === auditId && a.requirementId === reqId);
  if (!x) throw new Error(`missing requirement template ${auditId}/${reqId}`);
  return clone(x);
}
function updateCap(auditId, capId, opLabel, index) {
  const row = capTemplate(auditId, capId);
  const story = narratives[capId];
  const live = capById.get(capId);
  const ids = caseIds[auditId][capId];
  row.case = {id: ids[index], given: story.given, when: story.when, then: story.then};
  row.semanticEvidence.sourceFeature = row.semanticEvidence.sourceFeature || auditId;
  row.semanticEvidence.operation = live.ownerDefinition?.operation?.sourceOperation || live.operation || capId;
  row.semanticEvidence.typedInputSlots = clone(live.ownerDefinition?.typedInputSlots || row.semanticEvidence.typedInputSlots);
  row.semanticEvidence.successOutputs = clone(live.ownerDefinition?.successOutputs || row.semanticEvidence.successOutputs);
  row.semanticEvidence.operationRole = opLabel;
  row.semanticEvidence.sourceRefs = [`${sourceCapsRef}#capabilities/@id=${capId}`];
  row.semanticEvidence.explicitUnsupportedCases = clone(live.ownerDefinition?.explicitUnsupportedCases || live.explicitUnsupportedCases || row.semanticEvidence.explicitUnsupportedCases);
  return row;
}
function updateReq(auditId, reqId, capId, index, suffix) {
  const row = reqTemplate(auditId, reqId);
  const story = narratives[capId];
  const ids = caseIds[auditId][capId];
  row.case = {id: ids[index], given: index === 0 ? story.given : story.negative, when: index === 0 ? story.when : 'Admission evaluates the same operation with an unsupported, denied, stale, or unknown required condition.', then: index === 0 ? story.then : story.negativeThen};
  row.featureMeaningBoundary = story.then;
  row.exactCapabilityRefs = [capId];
  return row;
}

const candidate = clone(oldCandidate);
candidate.artifactId = 'media-pdp0-parent-case-resolution-cohort-01-r3-source-amendment-r5';
candidate.status = 'R5_EXACT_CASE_REPAIR_PROPOSAL_PENDING_OWNER_ADOPTION_DISTINCT_TYPED_SOURCE_PEER_REVIEW_AND_P0_07_CRITERION_PIN_RECONCILIATION';
candidate.sourceBaseline.supersedesCandidateV2Sha256 = sha(oldBytes);
candidate.sourceBaseline.r3SourceContentPeerRef = sourcePeerPath;
candidate.sourceBaseline.r3SourceContentPeerSha256 = r3PeerSha;
candidate.sourceBaseline.currentSourceFingerprints = liveFingerprints;
candidate.sourceBaseline.authorityMapSemanticOwner = 'media-product';
candidate.sourceBaseline.ownerAdoptionDisposition = 'UNKNOWN_PENDING_AUTHENTIC_OWNER_RECORD';

const five = new Set(['AUD-COLOR-001','AUD-COLLAB-003','AUD-COLOR-010','AUD-DELIV-013','AUD-DELIV-015']);
const fixedCap = [];
fixedCap.push(updateCap('AUD-COLLAB-003','media.quality.compare','Compare quality only',0), updateCap('AUD-COLLAB-003','media.quality.compare','Compare quality only',1));
fixedCap.push(updateCap('AUD-COLLAB-003','media.project.review','Record review action only',0), updateCap('AUD-COLLAB-003','media.project.review','Record review action only',1));
fixedCap.push(updateCap('AUD-COLOR-010','media.color.skin-tone-preserve','Color treatment only; no fidelity certification',0), updateCap('AUD-COLOR-010','media.color.skin-tone-preserve','Color treatment only; no fidelity certification',1));
fixedCap.push(updateCap('AUD-COLOR-010','media.compose.track.video-audio-caption-overlay','Caption-overlay composition only',0), updateCap('AUD-COLOR-010','media.compose.track.video-audio-caption-overlay','Caption-overlay composition only',1));
fixedCap.push(updateCap('AUD-DELIV-013','media.speech.transcription.subtitle.generate','Subtitle draft generation only',0), updateCap('AUD-DELIV-013','media.speech.transcription.subtitle.generate','Subtitle draft generation only',1));
fixedCap.push(updateCap('AUD-DELIV-013','media.compose.track.video-audio-caption-overlay','Subtitle overlay composition only',0), updateCap('AUD-DELIV-013','media.compose.track.video-audio-caption-overlay','Subtitle overlay composition only',1));
fixedCap.push(updateCap('AUD-DELIV-013','media.deliver.subtitles','Subtitle packaging/delivery only',0), updateCap('AUD-DELIV-013','media.deliver.subtitles','Subtitle packaging/delivery only',1));
fixedCap.push(updateCap('AUD-DELIV-015','media.sync.sample-accurate-av-map','Alignment mapping only; no measurement',0), updateCap('AUD-DELIV-015','media.sync.sample-accurate-av-map','Alignment mapping only; no measurement',1));
fixedCap.push(updateCap('AUD-DELIV-015','media.quality.video.video.assess-av-sync','Read-only sync assessment only; no mapping',0), updateCap('AUD-DELIV-015','media.quality.video.video.assess-av-sync','Read-only sync assessment only; no mapping',1));

const fixedReq = [];
fixedReq.push(updateReq('AUD-COLLAB-003','MEDIA-REQ-CAP-QUALITY','media.quality.compare',0), updateReq('AUD-COLLAB-003','MEDIA-REQ-CAP-QUALITY','media.quality.compare',1));
fixedReq.push(updateReq('AUD-COLLAB-003','MEDIA-REQ-CAP-PROJECT','media.project.review',0), updateReq('AUD-COLLAB-003','MEDIA-REQ-CAP-PROJECT','media.project.review',1));
fixedReq.push(updateReq('AUD-COLOR-010','MEDIA-REQ-CAP-COLOR','media.color.skin-tone-preserve',0), updateReq('AUD-COLOR-010','MEDIA-REQ-CAP-COLOR','media.color.skin-tone-preserve',1));
fixedReq.push(updateReq('AUD-COLOR-010','MEDIA-REQ-CAP-COMPOSE','media.compose.track.video-audio-caption-overlay',0), updateReq('AUD-COLOR-010','MEDIA-REQ-CAP-COMPOSE','media.compose.track.video-audio-caption-overlay',1));
fixedReq.push(updateReq('AUD-DELIV-013','MEDIA-REQ-CAP-SPEECH-TRANSCRIPTION','media.speech.transcription.subtitle.generate',0), updateReq('AUD-DELIV-013','MEDIA-REQ-CAP-SPEECH-TRANSCRIPTION','media.speech.transcription.subtitle.generate',1));
fixedReq.push(updateReq('AUD-DELIV-013','MEDIA-REQ-CAP-COMPOSE','media.compose.track.video-audio-caption-overlay',0), updateReq('AUD-DELIV-013','MEDIA-REQ-CAP-COMPOSE','media.compose.track.video-audio-caption-overlay',1));
fixedReq.push(updateReq('AUD-DELIV-013','MEDIA-REQ-CAP-DELIVER','media.deliver.subtitles',0), updateReq('AUD-DELIV-013','MEDIA-REQ-CAP-DELIVER','media.deliver.subtitles',1));
fixedReq.push(updateReq('AUD-DELIV-015','MEDIA-REQ-CAP-SYNC','media.sync.sample-accurate-av-map',0), updateReq('AUD-DELIV-015','MEDIA-REQ-CAP-SYNC','media.sync.sample-accurate-av-map',1));
fixedReq.push(updateReq('AUD-DELIV-015','MEDIA-REQ-CAP-QUALITY-VIDEO','media.quality.video.video.assess-av-sync',0), updateReq('AUD-DELIV-015','MEDIA-REQ-CAP-QUALITY-VIDEO','media.quality.video.video.assess-av-sync',1));

// The unresolved saturation proposal remains explicitly unavailable. The
// source has no owner-approved finite typed range or effective-value contract.
const colorReq = candidate.requirementAcceptanceCaseAdditions.filter((x) => x.auditId === 'AUD-COLOR-001');
for (let i = 0; i < colorReq.length; i++) {
  colorReq[i].case = i === 0
    ? {id:'MEDIA-P0-COHORT01-AUD-COLOR-001-POS', given:'A versioned source and declared source/target color context are supplied; no owner-approved finite saturation range or effective-value schema is present.', when:'The caller requests saturation adjustment.', then:'Return UNKNOWN/UNAVAILABLE without applying a transform until an owner-defined typed intent, finite supported values, and effective-value semantics are supplied; do not substitute exposure, contrast, or white balance.'}
    : {id:'MEDIA-P0-COHORT01-AUD-COLOR-001-NEG', given:'A versioned source and declared source/target color context are supplied.', when:'Admission evaluates a request with missing/unknown color context, unsupported saturation intent, or absent owner-approved finite range.', then:'Return UNKNOWN/UNAVAILABLE or REJECTED as applicable; do not apply a transform or imply exposure, contrast, white-balance, profile-certification, or source-overwrite behavior.'};
  colorReq[i].exactCapabilityRefs = ['media.color.saturation'];
  colorReq[i].featureMeaningBoundary = 'Saturation is a candidate new leaf only; positive transformation remains unavailable until the source owner defines the typed finite parameter and effective-value contract.';
}

// Replace only the five R3 peer REQUEST_CHANGES rows; preserve the other 13
// technically passing source proposals and their exact case records.
candidate.capabilityAcceptanceCaseAdditions = [
  ...candidate.capabilityAcceptanceCaseAdditions.filter((x) => !five.has(x.auditId)),
  ...fixedCap,
];
candidate.requirementAcceptanceCaseAdditions = [
  ...candidate.requirementAcceptanceCaseAdditions.filter((x) => !five.has(x.auditId)),
  ...colorReq,
  ...fixedReq,
];
candidate.rootChoiceCapabilityCaseAdditions = [];
candidate.rootChoiceRequirementCaseAdditions = [];
candidate.rootChoiceDecisions = sourcePeer.boundedOwnerDecisionOptions.map((x) => ({
  auditId: x.auditId,
  decisionStatus: 'UNKNOWN_PENDING_CANONICAL_OWNER_DECISION',
  selectedBoundedChoice: null,
  decision: 'No option selected; preserve the actual source-backed alternatives and their technical recommendation for the authorized owner.',
  options: clone(x.options),
  technicalRecommendation: x.technicalRecommendation,
  canonicalOwnerDisposition: 'UNKNOWN_PENDING_OWNER_ADOPTION',
}));

const saturation = candidate.newCapabilityDefinitionCandidates.find((x) => x.auditId === 'AUD-COLOR-001');
saturation.proposalStatus = 'NEW_LEAF_CANDIDATE_WITH_POSITIVE_RESULT_UNKNOWN_PENDING_OWNER_SCHEMA';
saturation.typedInputSlots = [
  {slotId:'source',sourceType:'versioned-media-artifact',cardinality:'EXACTLY_ONE',required:true},
  {slotId:'color-context',sourceType:'declared-source-and-target-color-context',cardinality:'EXACTLY_ONE',required:true},
  {slotId:'saturation-intent',sourceType:'typed-saturation-adjustment-intent',cardinality:'EXACTLY_ONE',required:true,schemaStatus:'OWNER_SCHEMA_NOT_SUPPLIED'},
];
saturation.successOutputs = [];
saturation.nonSuccessOutputs = [
  'UNKNOWN/UNAVAILABLE until the owner defines finite supported saturation values and effective-value semantics.',
  'Unsupported or unknown color context is explicit; no transform is applied.',
];
saturation.explicitUnsupportedCases = ['No exposure, contrast, white-balance, profile certification, or source overwrite is implied.'];
saturation.channelApplicability = 'UNRESOLVED; do not inherit exposure applicability';

candidate.proposalCounts = {
  frozenPeerPassesReused: 53,
  sourceRepairs: 18,
  r3PeerRequestedChangesCorrected: 5,
  boundedRootChoicesStillUnknown: 6,
  capabilityCaseAdditions: candidate.capabilityAcceptanceCaseAdditions.length,
  requirementCaseAdditions: candidate.requirementAcceptanceCaseAdditions.length,
  rootChoiceCapabilityCases: 0,
  rootChoiceRequirementCases: 0,
  newCapabilityDefinitionCandidates: candidate.newCapabilityDefinitionCandidates.length,
};

function append(additions, arr, index, idKey) {
  const byId = new Map(arr.map((x) => [x.id, x]));
  for (const a of additions) {
    const target = byId.get(a[idKey]);
    if (!target) throw new Error(`target missing: ${a[idKey]}`);
    target.acceptanceCases ||= [];
    if (target.acceptanceCases.some((x) => x.id === a.case.id)) throw new Error(`case id collision ${a.case.id} at ${a[idKey]}`);
    target.acceptanceCases.push(clone(a.case));
  }
}
append(candidate.capabilityAcceptanceCaseAdditions, capDoc.capabilities, 0, 'capabilityId');
append(candidate.requirementAcceptanceCaseAdditions, reqDoc.requirements, 0, 'requirementId');
const capPostBytes = Buffer.from(YAML.stringify(capDoc));
const reqPostBytes = Buffer.from(YAML.stringify(reqDoc));
const capPreSha = sha(capBytes), reqPreSha = sha(reqBytes);
const capPostSha = sha(capPostBytes), reqPostSha = sha(reqPostBytes);
candidate.exactTargetPostimages = [
  {targetRef:sourceCapsRef,preimageSha256:capPreSha,postimageSha256:capPostSha,postimageRef:capPostRef,semanticMutationCount:candidate.capabilityAcceptanceCaseAdditions.length,acceptanceCaseRecordCount:candidate.capabilityAcceptanceCaseAdditions.length},
  {targetRef:sourceReqRef,preimageSha256:reqPreSha,postimageSha256:reqPostSha,postimageRef:reqPostRef,semanticMutationCount:candidate.requirementAcceptanceCaseAdditions.length,acceptanceCaseRecordCount:candidate.requirementAcceptanceCaseAdditions.length},
];

const candidateBytes = dumpJson(candidate);
const candidateSha = sha(candidateBytes);
const records = {
  schemaVersion:'ghatana.media.pdp0.source-amendment-postimages.v3',
  artifactId:'media-pdp0-parent-case-resolution-cohort-01-r3-source-amendment-r5-postimages',
  candidateRef:candidateRef,
  candidateSha256:candidateSha,
  supersedesCandidateRef:oldCandidatePath,
  supersedesCandidateSha256:sha(oldBytes),
  sourceAmendmentBoundary:'ADDITIVE_OBSERVATION_ONLY; canonicalApply NONE',
  preimageSha256:{[sourceCapsRef]:capPreSha,[sourceReqRef]:reqPreSha},
  fullDocumentPostimages:[
    {targetRef:sourceCapsRef,preimageSha256:capPreSha,postimageRef:capPostRef,postimageSha256:capPostSha,semanticMutationCount:candidate.capabilityAcceptanceCaseAdditions.length},
    {targetRef:sourceReqRef,preimageSha256:reqPreSha,postimageRef:reqPostRef,postimageSha256:reqPostSha,semanticMutationCount:candidate.requirementAcceptanceCaseAdditions.length},
  ],
  canonicalApply:'NONE',
};
const recordPost = {
  schemaVersion:'ghatana.media.pdp0.source-amendment-record-postimages.v3',
  artifactId:'media-pdp0-parent-case-resolution-cohort-01-r3-source-amendment-r5-record-postimages',
  candidateRef:candidateRef,
  candidateSha256:candidateSha,
  supersedesCandidateRef:oldCandidatePath,
  supersedesCandidateSha256:sha(oldBytes),
  proposalCounts:candidate.proposalCounts,
  capabilityAcceptanceCaseAdditions:candidate.capabilityAcceptanceCaseAdditions,
  requirementAcceptanceCaseAdditions:candidate.requirementAcceptanceCaseAdditions,
  rootChoiceDecisions:candidate.rootChoiceDecisions,
  newCapabilityDefinitionCandidates:candidate.newCapabilityDefinitionCandidates,
  exactTargetPostimages:candidate.exactTargetPostimages,
  canonicalApply:'NONE',
};

// Serialize each artifact exactly once, after all contents and cross-hashes are final.
write(capPostRef, capPostBytes);
write(reqPostRef, reqPostBytes);
write(candidateRef, candidateBytes);
write(postRef, dumpJson(records));
write(recordPostRef, dumpJson(recordPost));

// Deterministic integrity assertions over the just-written frozen outputs.
const rereadCandidateBytes = read(candidateRef);
const rereadCandidate = JSON.parse(rereadCandidateBytes);
const rereadPost = json(postRef);
const rereadRecordPost = json(recordPostRef);
if (sha(rereadCandidateBytes) !== candidateSha) throw new Error('candidate hash mismatch after write');
if (rereadPost.candidateSha256 !== candidateSha || rereadRecordPost.candidateSha256 !== candidateSha) throw new Error('candidate cross-hash mismatch');
if (rereadPost.fullDocumentPostimages.some((x) => sha(read(x.postimageRef)) !== x.postimageSha256)) throw new Error('full-document postimage hash mismatch');
if (sha(read(sourceCapsRef)) !== capPreSha || sha(read(sourceReqRef)) !== reqPreSha) throw new Error('canonical source changed during build');
if (rereadCandidate.rootChoiceDecisions.some((x) => x.selectedBoundedChoice !== null || x.decisionStatus !== 'UNKNOWN_PENDING_CANONICAL_OWNER_DECISION')) throw new Error('root choice was selected');
console.log(JSON.stringify({candidateSha256:candidateSha,postimagesSha256:sha(read(postRef)),recordPostimagesSha256:sha(read(recordPostRef)),capabilitiesPostimageSha256:capPostSha,requirementsPostimageSha256:reqPostSha,caseCounts:{capabilities:candidate.capabilityAcceptanceCaseAdditions.length,requirements:candidate.requirementAcceptanceCaseAdditions.length},sourceRepairs:18,correctedR3Requests:5,rootChoicesUnknown:6,canonicalApply:'NONE'},null,2));
